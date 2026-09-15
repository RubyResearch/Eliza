/**
 * Exercises calendar control through registered HTTP routes and the real PGlite
 * runtime, preventing a working handler from shipping behind an unreachable URL.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";

it("serves paused calendar control and durable owner review through registered routes", async () => {
  const host = await createLifeOpsTestRuntime();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime: host.runtime,
      isAuthorized: () =>
        req.headers.authorization === "Bearer synthetic-owner",
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP listener did not bind TCP");
    const endpoint = `http://127.0.0.1:${address.port}/api/lifeops/calendar/sync-control`;
    const headers = {
      authorization: "Bearer synthetic-owner",
      "content-type": "application/json",
    };
    const initial = await fetch(endpoint, { headers });
    expect(initial.status).toBe(200);
    const control = await initial.json();
    expect(control).toMatchObject({
      paused: true,
      destination: null,
      pendingDispatch: null,
    });
    const request = {
      operation: "select",
      destination: null,
      expectedRevision: control.revision,
      idempotencyKey: "registered-builtin-review",
    };
    const review = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(review.status).toBe(200);
    const saved = await review.json();
    expect(saved.paused).toBe(true);
    expect(saved.revision).toBeGreaterThan(control.revision);
    const replay = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      revision: saved.revision,
      receipt: { id: saved.receipt.id, replayed: true },
    });
    const stale = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, idempotencyKey: "stale-review" }),
    });
    expect(stale.status).toBe(409);
    const persisted = await fetch(endpoint, { headers });
    expect(await persisted.json()).toMatchObject({
      revision: saved.revision,
      paused: true,
      destination: null,
    });
    expect((await fetch(endpoint)).status).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
