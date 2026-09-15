/**
 * Exercises channel selection through the real HTTP dispatcher, private file
 * store, and PGlite approval queue. Retargeted reviews stop before execution;
 * no connector is substituted or contacted by this boundary test.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import type { Plugin } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { LocalFileStorageService } from "../../../../packages/agent/src/services/file-storage.js";
import { installCalendarCardConnectorStatusFixtures } from "../../test/helpers/calendar-card-connector-status.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { executeApprovedRequest } from "../actions/resolve-request.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { verifyCalendarCardApproval } from "../lifeops/calendar-card.js";
import { LifeOpsService } from "../lifeops/service.js";
import { bindMachineAuthIdentityToEntity } from "./authenticated-entity-principal.js";

afterEach(() => vi.restoreAllMocks());

const storage: Plugin = {
  name: "calendar-channel-private-storage",
  description: "Production private storage for HTTP acceptance.",
  services: [LocalFileStorageService],
};

it("queues the selected channel and rejects transport or recipient changes before dispatch", async () => {
  const host = await createLifeOpsTestRuntime({ plugins: [storage] });
  const runtime = host.runtime;
  installCalendarCardConnectorStatusFixtures();
  const publicOrigin = "https://calendar.example.org:8443";
  runtime.setSetting("ELIZA_EXTERNAL_BASE_URL", publicOrigin);
  const server = createServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "127.0.0.1"}`,
    );
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
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("Knowledge graph did not initialize");
    const guest = await graph.getEntityStore(runtime.agentId).upsert({
      type: "person",
      preferredName: "Synthetic calendar recipient",
      identities: [],
      tags: [],
      state: {},
      visibility: "owner_only",
    });
    const db = (
      runtime as typeof runtime & {
        adapter: { db: ConstructorParameters<typeof AuthStore>[0] };
      }
    ).adapter.db;
    const identityId = crypto.randomUUID();
    await new AuthStore(db).createIdentity({
      id: identityId,
      kind: "machine",
      displayName: "Synthetic calendar guest",
      createdAt: Date.now(),
      passwordHash: null,
      cloudUserId: null,
    });
    await bindMachineAuthIdentityToEntity({
      runtime,
      entityId: guest.entityId,
      authIdentityId: identityId,
    });

    for (const channel of ["imessage", "telegram", "discord"] as const) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/lifeops/calendar/cards`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "internal-proxy.invalid:2148",
          },
          body: JSON.stringify({
            channel,
            date: "2026-09-15",
            timeZone: "America/New_York",
            privacyMode: "times_only",
            recipient: `guest-${channel}`,
            recipientEntityId: guest.entityId,
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
      expect(request.subjectUserId).not.toBe(guest.entityId);
      expect(request.payload.calendarCard).toMatchObject({
        version: 4,
        ownerEntityId: request.subjectUserId,
        recipientEntityId: guest.entityId,
      });
      await expect(
        queue.approve(request.id, guest.entityId, {
          resolvedBy: guest.entityId,
          resolutionReason: "guest cannot approve owner sends",
        }),
      ).rejects.toThrow();
      const wrongOwner = await executeApprovedRequest({
        runtime,
        queue,
        request: { ...request, subjectUserId: guest.entityId },
      });
      expect(wrongOwner.success).toBe(false);
      expect(wrongOwner.data?.error).toBe("CALENDAR_CARD_IDENTITY_MISMATCH");
      const link = request.payload.body.match(/https?:\/\/\S+/)?.[0];
      if (!link) throw new Error("Missing private card link");
      expect(new URL(link).origin).toBe(publicOrigin);
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
      const approved = await queue.approve(request.id, request.subjectUserId, {
        resolvedBy: request.subjectUserId,
        resolutionReason: "Owner reviewed synthetic guest card",
      });
      expect(approved.state).toBe("approved");
    }
    const before = await queue.list({
      subjectUserId: null,
      state: null,
      action: null,
    });
    const senderStatus = await new LifeOpsService(
      runtime,
    ).getTelegramConnectorStatus("agent");
    vi.mocked(
      LifeOpsService.prototype.getTelegramConnectorStatus,
    ).mockResolvedValueOnce({ ...senderStatus, identity: null });
    const unidentified = await fetch(
      `http://127.0.0.1:${address.port}/api/lifeops/calendar/cards`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "telegram",
          date: "2026-09-15",
          timeZone: "UTC",
          privacyMode: "full",
          recipient: "self",
          events: [],
        }),
      },
    );
    expect(unidentified.status).toBe(503);
    expect(await unidentified.json()).toMatchObject({
      code: "CALENDAR_CARD_SENDER_UNAVAILABLE",
    });
    expect(
      await queue.list({ subjectUserId: null, state: null, action: null }),
    ).toEqual(before);
    for (const configured of [
      "",
      "http://calendar.example.org",
      "https://127.0.0.1:8443",
      "https://calendar.example.org/private",
    ]) {
      runtime.setSetting("ELIZA_EXTERNAL_BASE_URL", configured);
      const denied = await fetch(
        `http://127.0.0.1:${address.port}/api/lifeops/calendar/cards`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "telegram",
            date: "2026-09-15",
            timeZone: "UTC",
            privacyMode: "full",
            recipient: "self",
            events: [],
          }),
        },
      );
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({
        code: "CALENDAR_CARD_PUBLIC_ORIGIN_UNAVAILABLE",
      });
    }
    expect(
      await queue.list({ subjectUserId: null, state: null, action: null }),
    ).toEqual(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180_000);
