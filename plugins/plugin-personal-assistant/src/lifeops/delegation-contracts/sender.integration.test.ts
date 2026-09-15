/** Real connector-account storage, delegation records and approval queue verify receiving-account binding; no provider send occurs. */
import {
  getConnectorAccountManager,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import { LifeOpsRepository } from "../repository.js";
import {
  delegationInboundTurnFromMessage,
  resolveDelegationEmailSender,
} from "./inbound-event.js";
import {
  createLifeOpsDelegationContractRecord,
  processDelegationInboundTurn,
} from "./index.js";

it("queues a reply from its receiving account and refuses missing or disconnected provenance despite another connected sender", async () => {
  const host = await createLifeOpsTestRuntime();
  try {
    const runtime = host.runtime;
    const owner = stringToUuid("delegation-receiving-owner");
    const manager = getConnectorAccountManager(runtime);
    if (!manager.getProvider("google"))
      manager.registerProvider({ provider: "google" });
    const connected = [];
    for (const id of ["receiving-mail", "other-mail"]) {
      connected.push(
        await manager.upsertAccount("google", {
          provider: "google",
          id,
          role: "OWNER",
          purpose: ["messaging"],
          accessGate: "owner_binding",
          status: "connected",
          displayHandle: `${id}@example.test`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {
            grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
          },
        }),
      );
    }
    const receiving = connected[0];
    if (!receiving) throw new Error("Fixture receiving account missing");
    const repository = new LifeOpsRepository(runtime);
    await repository.upsertDelegationContract(
      createLifeOpsDelegationContractRecord({
        contractId: "school-holding-reply",
        objective: "School coordination",
        scope: {
          kind: "sender_class",
          channel: "email",
          senderClass: "school",
        },
        autonomyLevel: "approval_gated",
        tripwires: [],
        sla: {
          holdingReplyAfterMinutes: 60,
          subjectPrefix: "Re:",
          holdingReplyBody: "I received this and will follow up.",
        },
        createdAt: "2026-09-11T12:00:00.000Z",
        expiresAt: "2026-10-11T12:00:00.000Z",
        ownerUserId: owner,
        requestedBy: "delegation-contracts",
        agentId: runtime.agentId,
      }),
    );
    const approvalQueue = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    const message: Memory = {
      entityId: stringToUuid("school-sender"),
      roomId: stringToUuid("school-thread"),
      createdAt: Date.parse("2026-09-11T13:00:00.000Z"),
      content: {
        text: "Please confirm the school schedule.",
        source: "gmail",
        metadata: {
          senderEmail: "school@example.test",
          senderClass: "school",
          subject: "School schedule",
          threadId: "gmail-school-thread",
          accountId: receiving.id,
        },
      },
      metadata: { type: "message", accountId: receiving.id },
    };
    const process = async (incoming: Memory) => {
      const turn = delegationInboundTurnFromMessage(incoming);
      if (!turn) throw new Error("Fixture turn missing");
      return processDelegationInboundTurn({
        agentId: runtime.agentId,
        turn,
        nowIso: "2026-09-11T14:05:00.000Z",
        repository,
        approvalQueue,
        resolveEmailSender: (ownerUserId) =>
          resolveDelegationEmailSender(runtime, turn, ownerUserId),
      });
    };
    // Body metadata is not an account-routing authority.
    await expect(
      process({ ...message, metadata: { type: "message" } }),
    ).rejects.toMatchObject({ code: "DELEGATION_REPLY_ACCOUNT_INVALID" });
    expect(
      await approvalQueue.list({
        subjectUserId: owner,
        state: null,
        action: null,
      }),
    ).toEqual([]);
    expect(
      (
        await repository.getDelegationContract(
          runtime.agentId,
          "school-holding-reply",
        )
      )?.state?.holdingReplyQueuedAt,
    ).toBeUndefined();
    await expect(
      process({
        ...message,
        metadata: {
          type: "message",
          accountId: receiving.id,
          origin: { accountId: "conflicting-account" },
        },
      }),
    ).rejects.toMatchObject({ code: "DELEGATION_REPLY_ACCOUNT_INVALID" });
    const result = await process(message);
    expect(result.enqueuedApprovals).toHaveLength(1);
    expect(result.enqueuedApprovals[0]).toMatchObject({
      payload: {
        grantId: `connector-account:${receiving.id}`,
        threadId: "gmail-school-thread",
        to: ["school@example.test"],
      },
      reason:
        "SLA holding reply for delegated School coordination\nFrom: receiving-mail@example.test",
    });
    expect((await process(message)).enqueuedApprovals).toEqual([]);
    await manager.upsertAccount("google", {
      ...receiving,
      status: "disconnected",
    });
    const turn = delegationInboundTurnFromMessage(message);
    if (!turn) throw new Error("Fixture turn missing");
    await expect(
      resolveDelegationEmailSender(runtime, turn, owner),
    ).rejects.toThrow();
    expect(
      await approvalQueue.list({
        subjectUserId: owner,
        state: null,
        action: null,
      }),
    ).toHaveLength(1);
  } finally {
    await host.cleanup();
  }
});
