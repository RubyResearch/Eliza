/** Exercises recipient confirmation through registered owner HTTP routes and real PGlite graph persistence, without a mail provider. */
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";

it("confirms a reviewed address once, preserves contact identities, and rejects ambiguous or unauthorized requests", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) throw new Error("Graph failed to initialize");
  const store = graph.getEntityStore(runtime.agentId);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => req.headers.authorization === "Bearer owner-test",
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("No TCP listener");
    const base = `http://127.0.0.1:${bound.port}/api/lifeops/family-workflows`;
    const headers = {
      authorization: "Bearer owner-test",
      "content-type": "application/json",
    };
    const payload = {
      entityId: null,
      name: "Synthetic recipient",
      address: "RECIPIENT@example.test",
      confirmed: true,
    };
    const confirm = (body: object, authorized = true) =>
      fetch(`${base}/email-recipients/confirm`, {
        method: "POST",
        headers: authorized ? headers : { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await confirm(payload, false)).status).toBe(401);
    expect((await confirm({ ...payload, confirmed: false })).status).toBe(400);
    expect(
      (
        await confirm({
          ...payload,
          address: "bad\r\nBcc:someone@example.test",
        })
      ).status,
    ).toBe(400);
    expect((await confirm({ ...payload, entityId: " " })).status).toBe(400);
    expect((await confirm({ ...payload, entityId: "" })).status).toBe(400);
    const responses = await Promise.all([confirm(payload), confirm(payload)]);
    for (const response of responses) expect(response.status).toBe(200);
    const first = (await responses[0].json()).recipient;
    expect((await responses[1].json()).recipient).toEqual(first);
    const saved = await store.get(first.entityId);
    expect(saved).toMatchObject({
      preferredName: payload.name,
      visibility: "owner_only",
      identities: [
        { platform: "email", handle: "recipient@example.test", verified: true },
      ],
    });
    expect(
      (await store.list({ type: "person" })).filter(
        (person) => person.preferredName === payload.name,
      ),
    ).toHaveLength(1);
    expect(
      await graph.getEntityStore("other-agent").get(first.entityId),
    ).toBeNull();
    if (!saved) throw new Error("Recipient was not persisted");
    const phone = {
      platform: "phone",
      handle: "+15555550123",
      verified: false,
      confidence: 0.5,
      addedAt: new Date().toISOString(),
      addedVia: "import" as const,
      evidence: ["synthetic-contact-import"],
    };
    await store.upsert({ ...saved, identities: [...saved.identities, phone] });
    expect(
      (
        await confirm({
          ...payload,
          entityId: first.entityId,
          address: "second@example.test",
        })
      ).status,
    ).toBe(200);
    expect((await store.get(first.entityId))?.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining(phone),
        expect.objectContaining({
          handle: "recipient@example.test",
          verified: true,
        }),
        expect.objectContaining({
          handle: "second@example.test",
          verified: true,
        }),
      ]),
    );
    expect(
      (
        await confirm({
          ...payload,
          entityId: first.entityId,
          name: "Different reviewed person",
        })
      ).status,
    ).toBe(400);
    const other = await store.upsert({
      type: "person",
      preferredName: "Other person",
      identities: [],
      tags: [],
      state: {},
      visibility: "owner_only",
    });
    expect(
      (
        await confirm({
          ...payload,
          entityId: other.entityId,
          name: other.preferredName,
        })
      ).status,
    ).toBe(400);
    const options = await fetch(`${base}/email-options`, { headers });
    expect(options.status).toBe(200);
    expect((await options.json()).options.recipients).toContainEqual(first);
    expect((await store.get(other.entityId))?.identities).toEqual([]);
    const observed = {
      ...phone,
      platform: "email",
      handle: "observed@example.test",
    };
    await store.upsert({ ...other, identities: [observed] });
    expect(
      (
        await confirm({
          entityId: other.entityId,
          name: other.preferredName,
          address: observed.handle,
          confirmed: true,
        })
      ).status,
    ).toBe(200);
    const upgraded = (await store.get(other.entityId))?.identities[0];
    expect(upgraded).toMatchObject({ verified: true, handle: observed.handle });
    expect(upgraded?.evidence).toEqual(
      expect.arrayContaining(observed.evidence),
    );
    expect(
      upgraded?.evidence.some((entry) =>
        entry.startsWith("owner-confirmation:"),
      ),
    ).toBe(true);
    const duplicate = await store.upsert({
      type: "person",
      preferredName: "Ambiguous contact",
      identities: [saved.identities[0]],
      tags: [],
      state: {},
      visibility: "owner_only",
    });
    const beforeAmbiguity = await store.get(first.entityId);
    expect(
      (await confirm({ ...payload, entityId: first.entityId })).status,
    ).toBe(400);
    expect(await store.get(first.entityId)).toEqual(beforeAmbiguity);
    expect((await store.get(duplicate.entityId))?.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "recipient@example.test" }),
      ]),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
