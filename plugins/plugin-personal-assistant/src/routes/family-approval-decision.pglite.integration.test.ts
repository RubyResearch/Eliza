/** Exercises registered family decision routes, real runtime authorization and PGlite approval persistence with model inference unavailable; no mail provider is called. */
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";

it("rejects unauthorized, changed and cross-owner decisions while allowing model-free rejection of a stale email", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  const service = getFamilyWorkflowRuntimeService(runtime);
  if (!service) throw new Error("Family runtime failed to initialize");
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
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No TCP listener");
    const base = `http://127.0.0.1:${address.port}/api/lifeops/family-workflows`;
    const period = {
      key: "2026-10",
      startsOn: "2026-10-01",
      endsOnExclusive: "2026-11-01",
      timeZone: "America/New_York",
    };
    const packet = await service.packets.buildInternal(period, []);
    const draft = await service.packets.createExternalDraft(packet, {
      recipient: "synthetic@example.test",
      recipientEntityId: "synthetic-guest",
      calendarPrivacyMode: "busy_only",
      email: {
        subject: "Synthetic decision test",
        senderGrantId: "fixture-send-grant",
      },
    });
    const path = `/packets/${encodeURIComponent(packet.packetId)}/drafts/${draft.draftVersion}`;
    const post = (suffix: string, body: object, authorized = true) =>
      fetch(`${base}${path}${suffix}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { authorization: "Bearer owner-test" } : {}),
        },
        body: JSON.stringify(body),
      });
    const enqueue = await post("/approval", {});
    expect(enqueue.status).toBe(201);
    const approval = await enqueue.json();
    const decision = {
      approvalId: approval.id,
      bodySha256: draft.bodySha256,
      decision: "approve",
    };
    expect((await post("/decision", decision, false)).status).toBe(401);
    expect(
      (await post("/decision", { ...decision, bodySha256: "0".repeat(64) }))
        .status,
    ).toBe(400);
    await service.packets.buildInternal({ ...period, timeZone: "UTC" }, []);
    const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
      throw new Error("Model unavailable");
    });
    try {
      const stale = await post("/decision", decision);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: "FAMILY_PACKET_INTERNAL_STALE" },
      });
      const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
      expect(
        (await queue.byId(approval.id, approval.subjectUserId))?.state,
      ).toBe("pending");
      const rejected = await post("/decision", {
        ...decision,
        decision: "reject",
      });
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({
        result: { success: true },
        approval: { state: "rejected", providerAccepted: null },
      });
      expect(
        (await queue.byId(approval.id, approval.subjectUserId))?.execution,
      ).toBeNull();
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
    }
    const currentPacket = await service.packets.read(packet.packetId);
    if (!currentPacket) throw new Error("Current packet was not persisted");
    const foreignDraft = await service.packets.createExternalDraft(
      currentPacket,
      {
        recipient: "synthetic@example.test",
        recipientEntityId: "synthetic-guest",
        calendarPrivacyMode: "busy_only",
        email: {
          subject: "Foreign-owner decision test",
          senderGrantId: "fixture-send-grant",
        },
      },
    );
    const foreign = await service.requestDraftApproval({
      packetId: packet.packetId,
      draftVersion: foreignDraft.draftVersion,
      requestedBy: "other-owner",
      subjectUserId: "other-owner",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const denied = await fetch(
      `${base}/packets/${encodeURIComponent(packet.packetId)}/drafts/${foreignDraft.draftVersion}/decision`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer owner-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approvalId: foreign.id,
          bodySha256: foreignDraft.bodySha256,
          decision: "approve",
          ownerUserId: "other-owner",
        }),
      },
    );
    expect(denied.status).toBe(400);
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    expect(await queue.byId(foreign.id, "other-owner")).toMatchObject({
      state: "pending",
      execution: null,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
