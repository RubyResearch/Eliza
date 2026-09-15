/**
 * Exercises approved-request dispatch across workflow, communication, document,
 * and unavailable-rail boundaries.
 *
 * Approved `execute_workflow` / `schedule_event` / `make_call` / `sign_document`
 * requests must drive their real rails (`LifeOpsService.runWorkflow`,
 * `LifeOpsService.createCalendarEvent`, Twilio voice dispatch, the
 * DocumentRequest lifecycle); a rail failure must surface as a typed failure
 * rather than fake success, and an action with no rail at all (`spend_money`)
 * must return an explicit NO_EXECUTOR failure. Dispatch can never bypass its
 * durable ledger. Calendar mutation success and recovery are covered against a
 * real database and HTTP provider in the calendar-mutation integration suite.
 *
 * Run: bunx vitest run test/resolve-request-executor.test.ts
 */

import { randomUUID } from "node:crypto";
import type {
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { parseInteractionBlocks } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID } from "../src/lifeops/resource-capacity/types.js";
import { googleHandoffFixture } from "./helpers/handoff-google.js";

const twilioMocks = vi.hoisted(() => ({
  readTwilioCredentialsFromEnv: vi.fn<
    () => {
      accountSid: string;
      authToken: string;
      fromPhoneNumber: string;
    } | null
  >(() => null),
  sendTwilioVoiceCall: vi.fn(
    async (): Promise<{
      ok: boolean;
      status: number | null;
      sid?: string;
      error?: string;
    }> => ({ ok: true, status: 201, sid: "CA-approved-1" }),
  ),
}));

vi.mock("@elizaos/plugin-phone/twilio", () => twilioMocks);

// The sign_document tests seed a real DocumentRequest through the real
// OWNER_DOCUMENTS action; only its collaborators (owner gate, approval-queue
// persistence, scheduled-task runner) are mocked, mirroring
// test/document-action.test.ts.
const docMocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  enqueue: vi.fn(async (input: { payload?: unknown }) => ({
    id: `approval-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    state: "pending" as const,
    requestedBy: "OWNER_DOCUMENTS",
    subjectUserId: "owner-1",
    action: "sign_document",
    payload: input.payload ?? {},
    channel: "internal",
    reason: "",
    idempotencyKey: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    execution: null,
  })),
  list: vi.fn(async (): Promise<unknown[]> => []),
  byId: vi.fn(async (_id: string): Promise<unknown | null> => null),
  approve: vi.fn(),
  reject: vi.fn(),
  claimExecution: vi.fn(),
  markDispatchStarted: vi.fn(),
  markDone: vi.fn(),
  markExpired: vi.fn(),
  schedule: vi.fn(async (task: { kind: string; trigger: unknown }) => ({
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    kind: task.kind,
    trigger: task.trigger,
    state: { status: "scheduled", followupCount: 0 },
  })),
}));

vi.mock("@elizaos/agent", async () => {
  const approvalTypes = await import(
    "../../../packages/agent/src/services/approval/types.ts"
  );
  return {
    hasOwnerAccess: docMocks.hasOwnerAccess,
    ApprovalNotFoundError: approvalTypes.ApprovalNotFoundError,
    ApprovalStateTransitionError: approvalTypes.ApprovalStateTransitionError,
  };
});

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    capability: "eliza.approval-execution",
    protocolVersion: 2,
    enqueue: docMocks.enqueue,
    list: docMocks.list,
    byId: docMocks.byId,
    approve: docMocks.approve,
    reject: docMocks.reject,
    claimExecution: docMocks.claimExecution,
    markDispatchStarted: docMocks.markDispatchStarted,
    markDone: docMocks.markDone,
    markExpired: docMocks.markExpired,
  }),
}));

vi.mock("../src/lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => ({
    schedule: docMocks.schedule,
    apply: vi.fn(),
    list: vi.fn(async () => []),
    pipeline: vi.fn(),
    evaluateCompletion: vi.fn(),
    fire: vi.fn(),
    fireWithResult: vi.fn(),
  }),
}));

import {
  __resetDocumentStoreForTests,
  ownerDocumentsAction,
} from "../src/actions/document.js";
import {
  buildResolveRequestChoice,
  executeApprovedRequest,
  resolveRequestAction,
} from "../src/actions/resolve-request.js";
import type {
  ApprovalEnqueueInput,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalRequestState,
  ApprovalResolution,
} from "../src/lifeops/approval-queue.types.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { attachSchedulingApprovalCorrelation } from "../src/lifeops/scheduling-approval.js";
import { LifeOpsService } from "../src/lifeops/service.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: randomUUID() as UUID,
    getService: () => null,
  } as unknown as IAgentRuntime;
}

/** In-memory ApprovalQueue that records the transitions executors drive. */
class RecordingQueue implements ApprovalQueue {
  readonly capability = "eliza.approval-execution";
  readonly protocolVersion = 2;
  public readonly transitions: ApprovalRequestState[] = [];
  constructor(private request: ApprovalRequest) {}

  private setState(state: ApprovalRequestState): ApprovalRequest {
    this.request = { ...this.request, state };
    this.transitions.push(state);
    return this.request;
  }

  async enqueue(_input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    throw new Error("not under test");
  }
  async enqueueWithResult(_input: ApprovalEnqueueInput): Promise<never> {
    throw new Error("not under test");
  }
  async list(
    _filter: ApprovalListFilter,
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    return [this.request];
  }
  async byId(
    id: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    return this.request.id === id &&
      this.request.subjectUserId === subjectUserId
      ? this.request
      : null;
  }
  async approve(
    _id: string,
    _subjectUserId: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.setState("approved");
  }
  async reject(
    _id: string,
    _subjectUserId: string,
    _resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.setState("rejected");
  }
  async claimExecution(): Promise<ApprovalRequest> {
    const executing = this.setState("executing");
    this.request = {
      ...executing,
      execution: {
        attemptId: randomUUID(),
        provider: "test",
        providerIdempotencyKey: `approval:${this.request.id}:test`,
        claimedAt: new Date(),
        dispatchStartedAt: null,
        providerReceipt: null,
        error: null,
        reconciledAt: null,
        reconciledBy: null,
        reconciliationReason: null,
      },
    };
    return this.request;
  }
  async markDispatchStarted(): Promise<ApprovalRequest> {
    if (!this.request.execution) throw new Error("execution missing");
    this.request = {
      ...this.request,
      execution: {
        ...this.request.execution,
        dispatchStartedAt: new Date(),
      },
    };
    return this.request;
  }
  async markDone(
    completion: Parameters<ApprovalQueue["markDone"]>[0],
  ): Promise<ApprovalRequest> {
    if (!this.request.execution) throw new Error("execution missing");
    this.request = {
      ...this.request,
      execution: {
        ...this.request.execution,
        providerReceipt: completion.providerReceipt,
      },
    };
    return this.setState("done");
  }
  async markRetryableFailure(): Promise<ApprovalRequest> {
    return this.setState("retryable");
  }
  async markReconciliationRequired(): Promise<ApprovalRequest> {
    return this.setState("reconciliation_required");
  }
  async recoverUnstartedExecution(): Promise<ApprovalRequest> {
    return this.setState("retryable");
  }
  async reconcileExecution(
    reconciliation: Parameters<ApprovalQueue["reconcileExecution"]>[0],
  ): Promise<ApprovalRequest> {
    return this.setState(
      reconciliation.outcome === "delivered" ? "done" : "retryable",
    );
  }
  async markExpired(
    _id: string,
    _subjectUserId: string,
  ): Promise<ApprovalRequest> {
    return this.setState("expired");
  }
  async removePending(): Promise<void> {}
  async purgeExpired(_now: Date): Promise<ReadonlyArray<string>> {
    return [];
  }
}

function approvedRequest(
  overrides: Pick<ApprovalRequest, "action" | "payload"> &
    Partial<ApprovalRequest>,
): ApprovalRequest {
  const now = new Date();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: "approved",
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-1",
    channel: "browser",
    reason: "needs owner approval",
    idempotencyKey: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    resolvedAt: now,
    resolvedBy: "owner-1",
    resolutionReason: "user approved",
    execution: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetDocumentStoreForTests();
  twilioMocks.readTwilioCredentialsFromEnv.mockReset();
  twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue(null);
  twilioMocks.sendTwilioVoiceCall.mockReset();
  twilioMocks.sendTwilioVoiceCall.mockResolvedValue({
    ok: true,
    status: 201,
    sid: "CA-approved-1",
  });
  docMocks.enqueue.mockClear();
  docMocks.schedule.mockClear();
  docMocks.list.mockReset();
  docMocks.list.mockResolvedValue([]);
  docMocks.byId.mockReset();
  docMocks.byId.mockImplementation(async (id: string) => {
    const requests = await docMocks.list();
    return (
      requests.find(
        (request) =>
          request !== null &&
          typeof request === "object" &&
          (request as { id?: unknown }).id === id,
      ) ?? null
    );
  });
  docMocks.approve.mockReset();
  docMocks.reject.mockReset();
  docMocks.claimExecution.mockReset();
  docMocks.markDispatchStarted.mockReset();
  docMocks.markDone.mockReset();
  docMocks.markExpired.mockReset();
});

function collectTexts(): { texts: string[]; callback: HandlerCallback } {
  const texts: string[] = [];
  const callback: HandlerCallback = async (content) => {
    if (typeof content.text === "string") texts.push(content.text);
    return [];
  };
  return { texts, callback };
}

describe("executeApprovedRequest", () => {
  it("blocks family email when its authorization service is unavailable", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "send_email",
      payload: {
        action: "send_email",
        familyPacketId: "packet-1",
        grantId: "sender-1",
        to: ["test@example.com"],
        cc: [],
        bcc: [],
        subject: "Monthly plan",
        body: "Synthetic plan",
        threadId: null,
      },
    });
    const queue = new RecordingQueue(request);
    const send = vi.spyOn(LifeOpsService.prototype, "sendGmailMessage");
    const result = await executeApprovedRequest({ runtime, queue, request });
    expect(result).toMatchObject({
      success: false,
      data: { error: "FAMILY_PACKET_SERVICE_UNAVAILABLE", executed: false },
    });
    expect(send).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
  });
  it("execute_workflow approval actually runs the workflow", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: "doc.upload_asset",
        input: { documentId: "doc-1" },
      },
    });
    const queue = new RecordingQueue(request);
    vi.spyOn(LifeOpsService.prototype, "getWorkflow").mockResolvedValue(
      {} as never,
    );
    const runSpy = vi
      .spyOn(LifeOpsService.prototype, "runWorkflow")
      .mockResolvedValue({
        id: "run-77",
        agentId: String(runtime.agentId),
        workflowId: "doc.upload_asset",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "success",
        result: {},
        auditRef: null,
      });
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("doc.upload_asset", {
      confirmBrowserActions: true,
    });
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      workflowId: "doc.upload_asset",
      workflowRunId: "run-77",
      workflowRunStatus: "success",
      state: "done",
    });
    expect(texts.join(" ")).toContain("run-77");
  });

  it("never executes a resource-capacity review-only workflow", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID,
        input: {
          proposalId: "resource-capacity-proposal-1",
          proposalVersion: 1,
          partyEntityId: SELF_ENTITY_ID,
          contentSha256: "a".repeat(64),
          noExternalEffect: true,
        },
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const { callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(runSpy).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      data: {
        error: "RESOURCE_CAPACITY_REVIEW_REQUIRES_TYPED_RESOLVER",
        executed: false,
      },
    });
  });

  it("food workflow approval delegates to the receipt-owning service without double transitions", async () => {
    const materializeApprovedShoppingHandoff = vi.fn().mockResolvedValue({
      handoffId: "food-handoff-17",
      state: "link_created",
      provider: "instacart",
      providerResultKind: "shopping_list_link",
      providerLinkUrl:
        "https://www.instacart.com/store/shopping-list/food-handoff-17",
    });
    const runtime = {
      ...makeRuntime(),
      getService: vi.fn(() => ({
        food: { materializeApprovedShoppingHandoff },
      })),
    } as unknown as IAgentRuntime;
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: "food.instacart.create_products_link",
        input: {
          handoffId: "food-handoff-17",
          householdId: "household-1",
          contentSha256: "a".repeat(64),
        },
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(materializeApprovedShoppingHandoff).toHaveBeenCalledWith({
      principalEntityId: SELF_ENTITY_ID,
      handoffId: "food-handoff-17",
    });
    expect(runSpy).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: {
        operation: "materialize_food_shopping_handoff",
        handoffId: "food-handoff-17",
        providerResultKind: "shopping_list_link",
        state: "done",
      },
    });
    expect(texts.join(" ")).toContain(
      "https://www.instacart.com/store/shopping-list/food-handoff-17",
    );
  });

  it("a failing workflow surfaces the error and never reaches done", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: "wf-broken",
        input: {},
      },
    });
    const queue = new RecordingQueue(request);
    vi.spyOn(LifeOpsService.prototype, "getWorkflow").mockResolvedValue(
      {} as never,
    );
    vi.spyOn(LifeOpsService.prototype, "runWorkflow").mockRejectedValue(
      new Error("workflow step exploded"),
    );

    const result = await executeApprovedRequest({ runtime, queue, request });
    expect(result).toMatchObject({
      success: false,
      data: {
        error: "APPROVAL_RECONCILIATION_REQUIRED",
        detail: "workflow step exploded",
      },
    });
    expect(queue.transitions).toEqual(["executing", "reconciliation_required"]);
  });

  it("calendar mutation dispatch cannot bypass the durable ledger", async () => {
    const runtime = {
      ...makeRuntime(),
      adapter: { db: {} },
    } as unknown as IAgentRuntime;
    const request = approvedRequest({
      action: "schedule_event",
      payload: {
        action: "schedule_event",
        calendarId: "primary",
        title: "Board sync",
        startsAtMs: Date.parse("2026-07-02T17:00:00.000Z"),
        endsAtMs: Date.parse("2026-07-02T18:00:00.000Z"),
        attendees: ["ada@example.com", "grace@example.com"],
        location: "Zoom",
        description: "Q3 planning",
      },
    });
    const queue = new RecordingQueue(request);
    const createSpy = vi.spyOn(LifeOpsService.prototype, "createCalendarEvent");

    await expect(
      executeApprovedRequest({ runtime, queue, request }),
    ).rejects.toThrow("runtime database adapter unavailable");
    expect(createSpy).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
  });

  it.each([undefined, "reviewed-account"])(
    "send_email pins the resolved sender and projects commitments (requested grant: %s)",
    async (requestedGrantId) => {
      const runtime = {
        ...makeRuntime(),
        adapter: { db: {} },
        reportError: vi.fn(),
      } as unknown as IAgentRuntime;
      const request = approvedRequest({
        action: "send_email",
        payload: {
          action: "send_email",
          to: ["mira@example.com"],
          cc: [],
          bcc: [],
          subject: "Launch deck",
          grantId: requestedGrantId,
          body: "I'll send the deck by 2026-07-10 and include the pricing appendix.",
          threadId: null,
          replyToMessageId: null,
        },
      });
      const queue = new RecordingQueue(request);
      vi.spyOn(
        LifeOpsService.prototype,
        "requireGoogleGmailSendGrant",
      ).mockResolvedValue({
        ...googleHandoffFixture().grant,
        id: "reviewed-account",
      });
      const sendSpy = vi
        .spyOn(LifeOpsService.prototype, "sendGmailMessage")
        .mockResolvedValue({
          ok: true,
          messageId: "gmail-message-1",
          threadId: "gmail-thread-1",
        });
      const upsertSpy = vi
        .spyOn(LifeOpsRepository.prototype, "upsertCommitmentLedgerRecord")
        .mockResolvedValue();
      const { texts, callback } = collectTexts();

      const result = await executeApprovedRequest({
        runtime,
        queue,
        request,
        callback,
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ grantId: "reviewed-account" }),
      );
      expect(queue.transitions).toEqual(["executing", "done"]);
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy.mock.calls[0]?.[0]).toMatchObject({
        agentId: runtime.agentId,
        source: "sent_mail",
        sourceKey: `approval:${request.id}`,
        kind: "commitment",
        counterparty: "mira@example.com",
        dueAt: "2026-07-10T17:00:00.000Z",
        status: "open",
        scheduledTaskId: null,
        metadata: {
          approvalRequestId: request.id,
          subject: "Launch deck",
          to: ["mira@example.com"],
        },
      });
      expect(upsertSpy.mock.calls[0]?.[0].summary).toContain("send the deck");
      expect(runtime.reportError).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(texts.join(" ")).toContain("mira@example.com");
    },
  );

  it("refuses altered scheduling content before any connector or queue transition", async () => {
    const runtime = makeRuntime();
    const payload = attachSchedulingApprovalCorrelation(
      {
        action: "send_message",
        recipient: "+15555550123",
        body: "Would Tuesday at 4:00 PM work?",
        replyToMessageId: null,
      },
      {
        kind: "scheduling_message",
        negotiationId: "negotiation-17",
        proposalId: "proposal-41",
        messageKind: "proposal",
        transportChannel: "sms",
        sourceUpdatedAt: "2026-07-26T18:30:00.000Z",
        counterpartyEntityId: "co-parent-17",
        counterpartyEntityUpdatedAt: "2026-07-26T18:20:00.000Z",
        draftVersion: 1,
      },
    );
    payload.body = "The time is now Wednesday at 9:00 AM.";
    const request = approvedRequest({ action: "send_message", payload });
    const queue = new RecordingQueue(request);
    const sendSpy = vi.spyOn(LifeOpsService.prototype, "sendIMessage");
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "SCHEDULING_APPROVAL_CONTENT_MISMATCH",
        requestId: request.id,
        state: "approved",
        sent: false,
      },
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("Nothing was sent");
  });

  it("make_call approval without Twilio credentials fails honestly and stays retriable", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "TWILIO_NOT_CONFIGURED",
      action: "make_call",
      requestId: request.id,
    });
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    // The request never left `approved`: the owner can retry after
    // configuring Twilio.
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("not placed");
  });

  it("a failed Twilio dispatch surfaces a typed failure and never reaches done", async () => {
    const runtime = makeRuntime();
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue({
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    });
    twilioMocks.sendTwilioVoiceCall.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Authenticate",
    });
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "APPROVAL_DELIVERY_FAILED_RETRYABLE",
      detail: "Authenticate",
    });
    expect(queue.transitions).toEqual(["executing", "retryable"]);
    expect(texts.join(" ")).toContain("safe to retry");
  });

  it("make_call approval places the call through the Twilio rail", async () => {
    const runtime = makeRuntime();
    const credentials = {
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    };
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue(credentials);
    const request = approvedRequest({
      action: "make_call",
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(twilioMocks.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
    expect(twilioMocks.sendTwilioVoiceCall).toHaveBeenCalledWith({
      credentials,
      to: "+15550100",
      message: "Confirming tomorrow's appointment.",
      idempotencyKey: `approval:${request.id}:twilio-voice`,
    });
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      callSid: "CA-approved-1",
      state: "done",
    });
    expect(texts.join(" ")).toContain("+15550100");
  });

  it("sign_document approval dispatches the real DocumentRequest seeded through OWNER_DOCUMENTS", async () => {
    const runtime = makeRuntime();
    const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const seeded = await ownerDocumentsAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "get the NDA signed" },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "request_signature",
          requesteeEntityId: "entity-alice-001",
          documentTitle: "Partnership NDA",
          deadline,
          signatureUrl: "https://sign.example.com/nda",
        },
      } as unknown as HandlerOptions,
      async () => [],
    );
    expect(seeded).toMatchObject({ success: true });
    // The payload the document action actually enqueued for owner approval.
    const enqueued = docMocks.enqueue.mock.calls[0]?.[0];
    if (!enqueued) throw new Error("request_signature enqueued no approval");
    const payload = enqueued.payload as ApprovalRequest["payload"];
    expect(payload).toMatchObject({
      action: "sign_document",
      documentName: "Partnership NDA",
    });

    const request = approvedRequest({ action: "sign_document", payload });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(true);
    expect(queue.transitions).toEqual(["executing", "done"]);
    expect(result.data).toMatchObject({
      documentStatus: "in_progress",
      state: "done",
    });
    expect(texts.join(" ")).toContain("Partnership NDA");
  });

  it("sign_document approval for a vanished DocumentRequest fails honestly and dispatches nothing", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "sign_document",
      payload: {
        action: "sign_document",
        documentId: "doc-gone",
        documentName: "NDA.pdf",
        signatureUrl: "https://sign.example.com/doc-gone",
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const queue = new RecordingQueue(request);
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "DOCUMENT_REQUEST_NOT_FOUND",
      action: "sign_document",
      documentId: "doc-gone",
    });
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("re-issue");
  });

  it("spend_money fails closed while its execution rail is unavailable", async () => {
    const runtime = makeRuntime();
    const request = approvedRequest({
      action: "spend_money",
      payload: {
        action: "spend_money",
        vendor: "AWS",
        amountCents: 12_000,
        currency: "USD",
        memo: "renew reserved instances",
      },
    });
    const queue = new RecordingQueue(request);
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const calendarSpy = vi.spyOn(
      LifeOpsService.prototype,
      "createCalendarEvent",
    );
    const { texts, callback } = collectTexts();

    const result = await executeApprovedRequest({
      runtime,
      queue,
      request,
      callback,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "SPEND_RAIL_UNAVAILABLE",
      action: "spend_money",
      requestId: request.id,
    });
    // Nothing executed and nothing marked done: the queue rows stay honest.
    expect(runSpy).not.toHaveBeenCalled();
    expect(calendarSpy).not.toHaveBeenCalled();
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    expect(queue.transitions).toEqual([]);
    expect(texts.join(" ")).toContain("nothing was charged or ordered");
  });
});

describe("RESOLVE_REQUEST reject path", () => {
  it("rejecting a make_call request executes no rail and flips the row to rejected", async () => {
    const runtime = makeRuntime();
    const pending = approvedRequest({
      action: "make_call",
      state: "pending",
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload: {
        action: "make_call",
        to: "+15550100",
        script: "Confirming tomorrow's appointment.",
        maxDurationSeconds: 120,
      },
    });
    twilioMocks.readTwilioCredentialsFromEnv.mockReturnValue({
      accountSid: "AC-test",
      authToken: "token",
      fromPhoneNumber: "+15550999",
    });
    docMocks.list.mockResolvedValue([pending]);
    docMocks.byId.mockResolvedValue(pending);
    docMocks.reject.mockResolvedValue({ ...pending, state: "rejected" });
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "no, don't place that call" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "reject",
          requestId: pending.id,
          reason: "not now",
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(docMocks.reject).toHaveBeenCalledTimes(1);
    expect(docMocks.reject).toHaveBeenCalledWith(pending.id, "owner-1", {
      resolvedBy: "owner-1",
      resolutionReason: "not now",
    });
    // Rejection touches no rail and no executing/done transition.
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
    expect(docMocks.claimExecution).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
    expect(texts.join(" ")).toContain("Rejected");
  });
});

describe("RESOLVE_REQUEST subject authorization", () => {
  it("refuses an explicit approval id owned by another subject", async () => {
    const runtime = makeRuntime();
    const otherSubjectRequest = approvedRequest({
      action: "send_email",
      state: "pending",
      subjectUserId: "owner-2",
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload: {
        action: "send_email",
        to: ["co-parent@example.com"],
        cc: [],
        bcc: [],
        subject: "Private scheduling draft",
        body: "This belongs to another household member.",
        threadId: null,
        replyToMessageId: null,
      },
    });
    docMocks.byId.mockResolvedValue(otherSubjectRequest);
    const { callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: `approve ${otherSubjectRequest.id}` },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: otherSubjectRequest.id,
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      data: { error: "CROSS_SUBJECT_APPROVAL_FORBIDDEN" },
    });
    expect(docMocks.approve).not.toHaveBeenCalled();
    expect(docMocks.claimExecution).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
  });
});

describe("RESOLVE_REQUEST household approval contract", () => {
  it("terminally invalidates a malformed reserved owner-self workflow without dispatching it", async () => {
    const runtime = makeRuntime();
    const malformed = approvedRequest({
      action: "execute_workflow",
      state: "pending",
      subjectUserId: "self",
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload: {
        action: "execute_workflow",
        workflowId: "household.schedule.proposal.approval",
        input: {
          proposalId: "proposal-1",
          proposalVersion: 1,
          coordinationId: "coordination-1",
          partyEntityId: "self",
          contentSha256: "not-a-sha256",
        },
      },
    });
    docMocks.byId.mockResolvedValue(malformed);
    docMocks.list.mockImplementation(async (filter: ApprovalListFilter) =>
      filter.subjectUserId === "self" ? [malformed] : [],
    );
    docMocks.markExpired.mockResolvedValue({
      ...malformed,
      state: "expired",
    });
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: `approve ${malformed.id}` },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: malformed.id,
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "HOUSEHOLD_APPROVAL_INVALID_CONTRACT",
        requestId: malformed.id,
        state: "expired",
        executed: false,
      },
    });
    expect(docMocks.markExpired).toHaveBeenCalledWith(
      malformed.id,
      SELF_ENTITY_ID,
    );
    expect(docMocks.approve).not.toHaveBeenCalled();
    expect(docMocks.claimExecution).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(texts.join(" ")).toContain("terminally invalidated");
  });
});

describe("RESOLVE_REQUEST resource-capacity review contract", () => {
  it("routes an exact owner-self review to the typed service without execution or queue bypass", async () => {
    const pending = approvedRequest({
      action: "execute_workflow",
      state: "pending",
      subjectUserId: SELF_ENTITY_ID,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload: {
        action: "execute_workflow",
        workflowId: RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID,
        input: {
          proposalId: "resource-capacity-proposal-typed-review",
          proposalVersion: 1,
          partyEntityId: SELF_ENTITY_ID,
          contentSha256: "c".repeat(64),
          noExternalEffect: true,
        },
      },
    });
    const updated = {
      ...pending,
      state: "approved" as const,
      resolvedAt: new Date(),
      resolvedBy: SELF_ENTITY_ID,
      resolutionReason: "Reviewed exact capacity proposal.",
    };
    const respondToProposal = vi.fn().mockResolvedValue(updated);
    const runtime = {
      ...makeRuntime(),
      getService: vi.fn(() => ({
        capacity: { respondToProposal },
      })),
    } as unknown as IAgentRuntime;
    docMocks.byId.mockResolvedValue(pending);
    docMocks.list.mockImplementation(async (filter: ApprovalListFilter) =>
      filter.subjectUserId === SELF_ENTITY_ID ? [pending] : [],
    );
    const runSpy = vi.spyOn(LifeOpsService.prototype, "runWorkflow");
    const { callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: `approve ${pending.id}` },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: pending.id,
          reason: "Reviewed exact capacity proposal.",
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(respondToProposal).toHaveBeenCalledWith({
      principalEntityId: SELF_ENTITY_ID,
      proposalId: "resource-capacity-proposal-typed-review",
      proposalVersion: 1,
      partyEntityId: SELF_ENTITY_ID,
      approvalRequestId: pending.id,
      contentSha256: "c".repeat(64),
      decision: "approve",
      reason: "Reviewed exact capacity proposal.",
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        operation: "review_resource_capacity_proposal",
        proposalId: "resource-capacity-proposal-typed-review",
        executed: false,
        reserved: false,
        calendarMutated: false,
        messageSent: false,
      },
    });
    expect(docMocks.approve).not.toHaveBeenCalled();
    expect(docMocks.claimExecution).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("RESOLVE_REQUEST scheduling approval path", () => {
  it("records owner approval but refuses a scheduling payload altered after hashing", async () => {
    const runtime = makeRuntime();
    const correlated = attachSchedulingApprovalCorrelation(
      {
        action: "send_email",
        to: ["co-parent@example.com"],
        cc: [],
        bcc: [],
        subject: "Scheduling: school conference",
        body: "Would Tuesday at 4:00 PM work?",
        threadId: null,
        replyToMessageId: null,
      },
      {
        kind: "scheduling_message",
        negotiationId: "negotiation-17",
        proposalId: "proposal-41",
        messageKind: "proposal",
        transportChannel: "email",
        sourceUpdatedAt: "2026-07-26T18:30:00.000Z",
        counterpartyEntityId: "co-parent-17",
        counterpartyEntityUpdatedAt: "2026-07-26T18:20:00.000Z",
        draftVersion: 1,
      },
    );
    const payload = {
      ...correlated,
      body: `${correlated.body}\nTampered after approval hashing.`,
    };
    const pending = approvedRequest({
      action: "send_email",
      state: "pending",
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      payload,
    });
    const approved = {
      ...pending,
      state: "approved" as const,
      resolvedAt: new Date(),
      resolvedBy: "owner-1",
      resolutionReason: "reviewed exact draft",
    };
    docMocks.list.mockResolvedValue([pending]);
    docMocks.approve.mockResolvedValue(approved);
    const sendSpy = vi.spyOn(LifeOpsService.prototype, "sendGmailMessage");
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: `approve ${pending.id}` },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: pending.id,
          reason: "reviewed exact draft",
        },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(docMocks.approve).toHaveBeenCalledWith(pending.id, "owner-1", {
      resolvedBy: "owner-1",
      resolutionReason: "reviewed exact draft",
    });
    expect(result).toMatchObject({
      success: false,
      data: {
        error: "SCHEDULING_APPROVAL_CONTENT_MISMATCH",
        requestId: pending.id,
        sent: false,
      },
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(docMocks.claimExecution).not.toHaveBeenCalled();
    expect(docMocks.markDone).not.toHaveBeenCalled();
    expect(texts.join(" ")).toContain("Nothing was sent");
  });
});

describe("RESOLVE_REQUEST ambiguous-target chips (#14733)", () => {
  function pendingPair(): [ApprovalRequest, ApprovalRequest] {
    const base = {
      state: "pending" as const,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    };
    return [
      approvedRequest({
        ...base,
        action: "send_email",
        reason: "Send the quarterly report to Dana",
        payload: {
          action: "send_email",
          to: ["dana@example.com"],
          cc: [],
          bcc: [],
          subject: "Q2 report",
          body: "Attached.",
          threadId: null,
          replyToMessageId: null,
        },
      }),
      approvedRequest({
        ...base,
        action: "send_message",
        reason: "Text JJ that the demo moved to 3pm",
        payload: {
          action: "send_message",
          recipient: "+15550100",
          body: "Demo moved to 3pm",
          replyToMessageId: null,
        },
      }),
    ];
  }

  it("asks 'Which request?' with one chip per pending row, values carrying `<intent> <requestId>`", async () => {
    const runtime = makeRuntime();
    const [first, second] = pendingPair();
    docMocks.list.mockResolvedValue([first, second]);
    const { texts, callback } = collectTexts();

    // No requestId and no useModel on the runtime: extraction cannot pick a
    // row, which is exactly the ambiguous branch under test.
    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: "approve it" },
      } as Memory,
      undefined,
      {
        parameters: { action: "approve" },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({ success: false });
    expect(texts).toHaveLength(1);
    const reply = texts[0] ?? "";
    expect(reply).toContain("Which request?");
    const { blocks } = parseInteractionBlocks(reply);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "choice") throw new Error("expected choice block");
    expect(block.scope).toBe("approval-resolve");
    expect(block.options.map((o) => o.value)).toEqual([
      `approve ${first.id}`,
      `approve ${second.id}`,
    ]);
    // Labels are the human-authored reasons, so the chips read as decisions.
    expect(block.options[0]?.label).toContain("quarterly report");
    expect(block.options[1]?.label).toContain("demo moved to 3pm");
  });

  it("a tapped chip value round-trips: `reject <id>` resolves exactly that row", async () => {
    const runtime = makeRuntime();
    const [first, second] = pendingPair();
    docMocks.list.mockResolvedValue([first, second]);
    docMocks.byId.mockResolvedValue(second);
    docMocks.reject.mockResolvedValue({ ...second, state: "rejected" });

    // Build the chips for a reject intent and simulate the tap: the value is
    // the user's next message and the extraction reads the id verbatim.
    const chips = buildResolveRequestChoice("reject", [first, second]);
    const tapped = chips.options[1]?.value ?? "";
    expect(tapped).toBe(`reject ${second.id}`);
    const { texts, callback } = collectTexts();

    const result = await resolveRequestAction.handler(
      runtime,
      {
        id: randomUUID() as UUID,
        entityId: "owner-1" as UUID,
        roomId: randomUUID() as UUID,
        content: { text: tapped },
      } as Memory,
      undefined,
      {
        parameters: { action: "reject", requestId: second.id },
      } as unknown as HandlerOptions,
      callback,
    );

    expect(result).toMatchObject({ success: true });
    expect(docMocks.reject).toHaveBeenCalledTimes(1);
    expect(docMocks.reject.mock.calls[0]?.[0]).toBe(second.id);
    expect(texts.join(" ")).toContain("Rejected");
  });

  it("offers every ambiguous pending request instead of hiding choices after five", () => {
    const [template] = pendingPair();
    const pending = Array.from({ length: 8 }, (_, index) => ({
      ...template,
      id: `approval-${index + 1}`,
      reason: `Decision ${index + 1}`,
    }));

    const choice = buildResolveRequestChoice("approve", pending);

    expect(choice.options).toHaveLength(8);
    expect(choice.options.map((option) => option.value)).toEqual(
      pending.map((request) => `approve ${request.id}`),
    );
  });
});
