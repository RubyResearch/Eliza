/**
 * Proves the owner calendar-card route validates its body at the HTTP
 * boundary. Requests travel a real HTTP server → the agent's plugin route
 * dispatcher → the normally registered personal-assistant routes → the
 * composer, card access store, and approval queue on a PGlite runtime with
 * the production file store. A malformed date, time zone, event, or lifetime
 * is a 400 with a field-specific message, never a dispatcher-translated 500,
 * and a well-formed body still issues the card and queues its approval (202).
 */

import { once } from "node:events";
import { createServer } from "node:http";
import type { Plugin } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { LocalFileStorageService } from "../../../../packages/agent/src/services/file-storage.js";
import { installCalendarCardConnectorStatusFixtures } from "../../test/helpers/calendar-card-connector-status.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";

const fileStoragePlugin: Plugin = {
  name: "calendar-card-request-test-file-storage",
  description: "Production content-addressed file storage for card tests.",
  services: [LocalFileStorageService],
};

const event = {
  id: "evt-1",
  title: "Standup",
  startAt: "2026-03-02T09:00:00.000Z",
  endAt: "2026-03-02T09:30:00.000Z",
  location: "Room 4",
};

const valid = {
  date: "2026-03-02",
  timeZone: "UTC",
  privacyMode: "full",
  recipient: "Sam",
  events: [event],
};

afterEach(() => vi.restoreAllMocks());

it("answers malformed card bodies with a 400 and issues a well-formed card", async () => {
  const host = await createLifeOpsTestRuntime({ plugins: [fileStoragePlugin] });
  const runtime = host.runtime;
  installCalendarCardConnectorStatusFixtures();
  runtime.setSetting("ELIZA_EXTERNAL_BASE_URL", "https://calendar.example.org");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => true,
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
      throw new Error("HTTP server omitted bound TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: unknown) =>
      fetch(`${base}/api/lifeops/calendar/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const rejected: Array<[unknown, string]> = [
      [
        { ...valid, date: "tomorrow" },
        "date must be a valid YYYY-MM-DD calendar date",
      ],
      [
        { ...valid, date: "2026-02-30" },
        "date must be a valid YYYY-MM-DD calendar date",
      ],
      [
        { ...valid, timeZone: "Mars/Olympus" },
        "timeZone must be a valid IANA time zone",
      ],
      [
        { ...valid, events: [{ ...event, startAt: "soon" }] },
        "events[0].startAt must be a parseable timestamp",
      ],
      [{ ...valid, events: [null] }, "events[0] must be an object"],
      [
        { ...valid, ttlMs: -5 },
        "ttlMs must be a positive integer number of milliseconds",
      ],
      [
        { ...valid, ttlMs: 1e20 },
        "ttlMs must be a positive integer number of milliseconds",
      ],
      [
        { ...valid, ttlMs: Number.MAX_SAFE_INTEGER },
        "ttlMs must produce a representable expiry date",
      ],
    ];
    for (const [body, error] of rejected) {
      const response = await post(body);
      expect([JSON.stringify(body), response.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
      expect(await response.json()).toEqual({ error });
    }

    const issued = await post({ ...valid, ttlMs: 60_000 });
    expect(issued.status).toBe(202);
    const payload = (await issued.json()) as {
      approvalId: string;
      cardId: string;
      state: string;
    };
    expect(payload.approvalId).toEqual(expect.any(String));
    expect(payload.cardId).toEqual(expect.any(String));
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
