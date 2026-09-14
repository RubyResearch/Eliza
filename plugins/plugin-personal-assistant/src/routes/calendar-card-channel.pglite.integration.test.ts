/**
 * Exercises channel selection through the real HTTP dispatcher, private file
 * store, and PGlite approval queue. Retargeted reviews stop before execution;
 * no connector is substituted or contacted by this boundary test.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { Plugin } from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { LocalFileStorageService } from "../../../../packages/agent/src/services/file-storage.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { executeApprovedRequest } from "../actions/resolve-request.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { verifyCalendarCardApproval } from "../lifeops/calendar-card.js";

const storage: Plugin = {
  name: "calendar-channel-private-storage",
  description: "Production private storage for HTTP acceptance.",
  services: [LocalFileStorageService],
};

it("queues the selected channel and rejects transport or recipient changes before dispatch", async () => {
  const host = await createLifeOpsTestRuntime({ plugins: [storage] });
  const runtime = host.runtime;
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
      res.end();
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    for (const channel of ["imessage", "telegram", "discord"] as const) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/lifeops/calendar/cards`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel,
            date: "2026-09-15",
            timeZone: "America/New_York",
            privacyMode: "times_only",
            recipient: `self-${channel}`,
            events: [],
            ttlMs: 60_000,
          }),
        },
      );
      expect(response.status).toBe(202);
      const result = (await response.json()) as { approvalId: string };
      const requests = await queue.list({
        subjectUserId: null,
        state: null,
        action: null,
      });
      const request = requests.find((entry) => entry.id === result.approvalId);
      if (request?.payload.action !== "send_message")
        throw new Error("Missing queued card");
      expect(request.channel).toBe(channel);
      expect(verifyCalendarCardApproval(request.payload)?.matches).toBe(true);
      const retargeted = await executeApprovedRequest({
        runtime,
        queue,
        request: {
          ...request,
          channel: channel === "telegram" ? "discord" : "telegram",
        },
      });
      expect(retargeted.success).toBe(false);
      expect(retargeted.data?.error).toBe("CALENDAR_CARD_IDENTITY_MISMATCH");
      const changedRecipient = await executeApprovedRequest({
        runtime,
        queue,
        request: {
          ...request,
          payload: { ...request.payload, recipient: "different-person" },
        },
      });
      expect(changedRecipient.success).toBe(false);
      expect(changedRecipient.data?.error).toBe(
        "CALENDAR_CARD_APPROVAL_TAMPERED",
      );
      const retained = await queue.byId(request.id, request.subjectUserId);
      expect(retained?.state).toBe("pending");
      expect(retained?.execution).toBeNull();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180_000);
