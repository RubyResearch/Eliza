/**
 * Regression coverage for the runtime-facing delegated-inbound processor.
 * The repository and approval queue are small fakes so root-level coverage
 * jobs can load this test without the package-local Vitest aliases, while the
 * assertions still cover the processor contract that connector hooks call.
 */
import { describe, expect, it } from "vitest";
import type {
  ApprovalEnqueueInput,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalResolution,
} from "../src/lifeops/approval-queue.types.js";
import {
  createLifeOpsDelegationContractRecord,
  type DelegationContractRepository,
  type LifeOpsDelegationContractRecord,
  processDelegationInboundTurn,
} from "../src/lifeops/delegation-contracts/index.js";

class TestDelegationRepository implements DelegationContractRepository {
  private readonly records = new Map<string, LifeOpsDelegationContractRecord>();

  constructor(seed: readonly LifeOpsDelegationContractRecord[]) {
    for (const record of seed) {
      this.records.set(record.contractId, record);
    }
  }

  async listDelegationContracts(
    _agentId: string,
    _filter: {
      statuses?: LifeOpsDelegationContractRecord["status"][];
      activeAtIso?: string;
    },
  ): Promise<LifeOpsDelegationContractRecord[]> {
    return Array.from(this.records.values());
  }

  async upsertDelegationContract(
    record: LifeOpsDelegationContractRecord,
  ): Promise<void> {
    this.records.set(record.contractId, record);
  }

  get(contractId: string): LifeOpsDelegationContractRecord | undefined {
    return this.records.get(contractId);
  }
}

class TestApprovalQueue implements ApprovalQueue {
  readonly capability = "eliza.approval-execution";
  readonly protocolVersion = 2;
  private readonly requests: ApprovalRequest[] = [];

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    const now = new Date("2026-07-06T18:05:00.000Z");
    const request: ApprovalRequest = {
      id: `approval-${this.requests.length + 1}`,
      createdAt: now,
      updatedAt: now,
      state: "pending",
      requestedBy: input.requestedBy,
      subjectUserId: input.subjectUserId,
      action: input.action,
      payload: input.payload,
      channel: input.channel,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey ?? null,
      expiresAt: input.expiresAt,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      execution: null,
    };
    this.requests.push(request);
    return request;
  }

  async enqueueWithResult(input: ApprovalEnqueueInput) {
    return { request: await this.enqueue(input), reused: false };
  }

  async list(
    filter: ApprovalListFilter,
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    return this.requests.filter(
      (request) =>
        (filter.subjectUserId === null ||
          request.subjectUserId === filter.subjectUserId) &&
        (filter.state === null || request.state === filter.state) &&
        (filter.action === null || request.action === filter.action),
    );
  }

  async byId(
    id: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    return (
      this.requests.find(
        (request) =>
          request.id === id && request.subjectUserId === subjectUserId,
      ) ?? null
    );
  }

  async approve(
    _id: string,
    _subjectUserId: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.approve is not used by this test.");
  }

  async reject(
    _id: string,
    _subjectUserId: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.reject is not used by this test.");
  }

  async claimExecution(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.claimExecution is not used.");
  }
  async markDispatchStarted(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.markDispatchStarted is not used.");
  }
  async markDone(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.markDone is not used.");
  }
  async markRetryableFailure(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.markRetryableFailure is not used.");
  }
  async markReconciliationRequired(): Promise<ApprovalRequest> {
    throw new Error(
      "TestApprovalQueue.markReconciliationRequired is not used.",
    );
  }
  async recoverUnstartedExecution(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.recoverUnstartedExecution is not used.");
  }
  async reconcileExecution(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.reconcileExecution is not used.");
  }
  async markExpired(): Promise<ApprovalRequest> {
    throw new Error("TestApprovalQueue.markExpired is not used.");
  }
  async removePending(): Promise<void> {}

  async purgeExpired(_now: Date): Promise<ReadonlyArray<string>> {
    return [];
  }
}

describe("processDelegationInboundTurn", () => {
  it("turns a delegated sender-class SLA into one pending approval", async () => {
    const agentId = "00000000-0000-0000-0000-000000001856";
    const repository = new TestDelegationRepository([
      createLifeOpsDelegationContractRecord({
        contractId: "delegation:board-sla",
        objective: "Board member holding reply",
        scope: {
          kind: "sender_class",
          channel: "email",
          senderClass: "board_member",
        },
        autonomyLevel: "approval_gated",
        tripwires: [],
        sla: {
          holdingReplyAfterMinutes: 60,
          subjectPrefix: "Re:",
          holdingReplyBody:
            "Thanks, I have this and will come back with a proper answer shortly.",
        },
        createdAt: "2026-07-06T16:00:00.000Z",
        expiresAt: "2026-07-13T16:00:00.000Z",
        ownerUserId: "owner-1",
        requestedBy: "delegation-contracts",
        agentId,
        metadata: { policy: "board-member-one-hour-hold" },
      }),
    ]);
    const approvalQueue = new TestApprovalQueue();

    const processed = await processDelegationInboundTurn({
      resolveEmailSender: async () => ({
        grantId: "reviewed-delegation-sender",
        email: "owner@example.test",
      }),
      agentId,
      repository,
      approvalQueue,
      nowIso: "2026-07-06T18:05:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-board-1",
        sender: "Dana Board",
        senderClass: "board_member",
        senderEmail: "dana@board.example",
        subject: "Quarterly update",
        text: "Can you send the latest numbers?",
        receivedAt: "2026-07-06T17:00:00.000Z",
      },
    });

    expect(processed.evaluations.map((entry) => entry.outcome)).toEqual([
      "holding_reply_due",
    ]);
    expect(processed.enqueuedApprovals).toHaveLength(1);
    expect(processed.enqueuedApprovals[0]).toMatchObject({
      state: "pending",
      requestedBy: "delegation-contracts",
      subjectUserId: "owner-1",
      action: "send_email",
      channel: "email",
      reason:
        "SLA holding reply for delegated Board member holding reply\nFrom: owner@example.test",
      payload: {
        action: "send_email",
        to: ["dana@board.example"],
        subject: "Re: Quarterly update",
        body: "Thanks, I have this and will come back with a proper answer shortly.",
        threadId: "thread-board-1",
      },
    });
    expect(
      repository.get("delegation:board-sla")?.state?.holdingReplyQueuedAt,
    ).toBe("2026-07-06T18:05:00.000Z");

    const replayed = await processDelegationInboundTurn({
      resolveEmailSender: async () => ({
        grantId: "reviewed-delegation-sender",
        email: "owner@example.test",
      }),
      agentId,
      repository,
      approvalQueue,
      nowIso: "2026-07-06T18:10:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-board-1",
        sender: "Dana Board",
        senderClass: "board_member",
        senderEmail: "dana@board.example",
        subject: "Quarterly update",
        text: "Can you send the latest numbers?",
        receivedAt: "2026-07-06T17:00:00.000Z",
      },
    });

    expect(replayed.evaluations).toHaveLength(1);
    expect(replayed.evaluations[0]?.outcome).toBe("in_bounds");
    expect(replayed.enqueuedApprovals).toHaveLength(0);
    await expect(
      approvalQueue.list({
        subjectUserId: "owner-1",
        state: "pending",
        action: "send_email",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });
});
