/**
 * Approval queue integration test (WS6).
 *
 * Drives the real `PgApprovalQueue` against a PGlite-backed runtime.
 * Exercises:
 *   - enqueue → approve → claim → dispatch-start → receipt completion
 *   - enqueue → reject
 *   - enqueue (expired in past) → purgeExpired → markExpired noop rejected
 *   - invalid transitions throw ApprovalStateTransitionError
 *
 * Run: bunx vitest run eliza/plugins/plugin-personal-assistant/test/approval-queue.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalDispatchControlStore,
  KnowledgeGraphService,
  knowledgeGraphSchema,
} from "@elizaos/agent";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  AgentEventService,
  getConnectorAccountManager,
  parseInteractionBlocks,
} from "@elizaos/core";
import {
  type DispatchResult,
  schedulingPlugin,
} from "@elizaos/plugin-scheduling";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRealTestRuntime } from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { runSchedulingNegotiationHandler } from "../src/actions/lib/scheduling-handler.js";
import { executeApprovedRequest } from "../src/actions/resolve-request.js";
import {
  createApprovalQueue,
  PgApprovalQueue,
} from "../src/lifeops/approval-queue.js";
import {
  type ApprovalEnqueueInput,
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  type ApprovalQueue,
  type ApprovalRequest,
  ApprovalStateTransitionError,
  type SchedulingApprovalTransportChannel,
} from "../src/lifeops/approval-queue.types.js";
import { getChannelRegistry } from "../src/lifeops/channels/index.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import {
  attachSchedulingApprovalCorrelation,
  readSchedulingApprovalCorrelation,
  schedulingApprovalExpiresAt,
  schedulingApprovalPayloadForDraft,
  verifySchedulingApprovalContent,
} from "../src/lifeops/scheduling-approval.js";
import {
  prepareSchedulingDelivery,
  SchedulingDeliveryStore,
  schedulingDeliveryIdempotencyKey,
} from "../src/lifeops/scheduling-delivery.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { executeRawSql, withTransaction } from "../src/lifeops/sql.js";
import { personalAssistantPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let isolatedStateDir: string;
let isolatedConfigPath: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

const knowledgeGraphPlugin: Plugin = {
  name: "approval-queue-knowledge-graph",
  description: "Contact graph required by scheduling draft resolution.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
};

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "approval-queue-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function messageInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-123",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "agent wants to confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function schedulingTarget(
  channel: SchedulingApprovalTransportChannel,
  suffix: string,
): string {
  if (channel === "email") return `taylor-${suffix}@example.com`;
  if (channel === "sms" || channel === "imessage" || channel === "whatsapp") {
    return `+1555${suffix.replace(/\D/gu, "").padStart(7, "0").slice(-7)}`;
  }
  return `${channel}:taylor-${suffix}`;
}

async function createOpeningApproval(args: {
  suffix: string;
  channel?: SchedulingApprovalTransportChannel;
}): Promise<{
  request: ApprovalRequest;
  negotiationId: string;
}> {
  const channel = args.channel ?? "email";
  const service = new LifeOpsService(runtime);
  const target = schedulingTarget(channel, args.suffix);
  const counterparty = await service.upsertRelationship({
    name: `Taylor ${args.suffix}`,
    primaryChannel: channel,
    primaryHandle: target,
    email: channel === "email" ? target : null,
    phone:
      channel === "sms" || channel === "imessage" || channel === "whatsapp"
        ? target
        : null,
    notes: "scheduling delivery integration test",
    tags: ["family"],
    relationshipType: "co_parent_of",
    lastContactedAt: null,
    metadata: {},
  });
  // The handler scopes the approval it enqueues to the triggering message's
  // entity, so every read of that row has to name the same subject.
  const subjectUserId = String(runtime.agentId);
  const message = {
    id: runtime.agentId,
    entityId: subjectUserId,
    roomId: runtime.agentId,
    content: { text: `Coordinate school logistics ${args.suffix}` },
  } as never;
  const result = await runSchedulingNegotiationHandler(
    runtime,
    message,
    undefined,
    {
      parameters: {
        subaction: "start",
        subject: `School logistics ${args.suffix}`,
        relationshipId: counterparty.id,
        durationMinutes: 30,
        timezone: "America/Los_Angeles",
      },
    } as never,
    async () => [],
  );
  const data = result.data as {
    negotiation: { id: string };
    approvalRequestId: string;
  };
  const request = await queue.byId(data.approvalRequestId, subjectUserId);
  if (!request) {
    throw new Error("scheduling handler did not persist its approval request");
  }
  if (request.payload.action === "send_email") {
    expect(request.payload.grantId).toMatch(/^connector-account:/);
    expect(request.reason).toContain("From: sender@example.test");
  }
  return { request, negotiationId: data.negotiation.id };
}

function receiptResult(
  payload: unknown,
  providerMessageId: string,
): DispatchResult {
  const idempotencyKey =
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).idempotencyKey === "string"
      ? String((payload as Record<string, unknown>).idempotencyKey)
      : "";
  return {
    ok: true,
    messageId: providerMessageId,
    receipt: {
      provider: "integration-provider",
      providerMessageId,
      idempotencyKey,
      acceptedAt: new Date().toISOString(),
    },
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createRealTestRuntime({
    plugins: [knowledgeGraphPlugin, schedulingPlugin, personalAssistantPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  // The enqueue chat-post (#14733) resolves the agent-event service off the
  // runtime; register the real one when the test runtime lacks it. Service
  // registration is lazy, so force the start (the agent server does the same
  // at boot when the WS bridge subscribes).
  if (!runtime.getService(AgentEventService.serviceType)) {
    await runtime.registerService(AgentEventService);
    await runtime.getServiceLoadPromise(AgentEventService.serviceType);
  }
  const accounts = getConnectorAccountManager(runtime);
  if (!accounts.getProvider("google"))
    accounts.registerProvider({ provider: "google" });
  await accounts.upsertAccount("google", {
    id: "scheduling-owner",
    provider: "google",
    role: "OWNER",
    purpose: ["reading", "messaging"],
    accessGate: "owner_binding",
    status: "connected",
    displayHandle: "sender@example.test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    },
  });
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("ApprovalQueue integration (real PGlite)", () => {
  it("persists an owner pause, rejects stale resumes, and admits claims only after release", async () => {
    const subjectUserId = "handoff-owner-pause";
    const control = new ApprovalDispatchControlStore(runtime);
    const request = await queue.enqueue(messageInput({ subjectUserId }));
    await queue.approve(request.id, subjectUserId, {
      resolvedBy: subjectUserId,
      resolutionReason: "reviewed before handoff",
    });
    const claim = {
      requestId: request.id,
      subjectUserId,
      provider: "synthetic-account",
      providerIdempotencyKey: request.id,
    };
    const mutation = {
      subjectUserId,
      operationId: "handoff-pause-1",
      expectedRevision: 0,
    };
    const paused = await control.pause(mutation);
    expect(await control.pause(mutation)).toEqual(paused);
    const reopened = new ApprovalDispatchControlStore(runtime);
    expect(await reopened.read(subjectUserId)).toEqual(paused);
    await expect(queue.claimExecution(claim)).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_PAUSED",
    });
    expect((await queue.byId(request.id, subjectUserId))?.state).toBe(
      "approved",
    );
    await expect(
      reopened.resume({
        ...mutation,
        expectedRevision: paused.revision,
        operationId: "another-handoff",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DISPATCH_CONTROL_CONFLICT" });
    await expect(reopened.resume(mutation)).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_CONTROL_CONFLICT",
    });
    const release = { ...mutation, expectedRevision: paused.revision };
    const resumed = await reopened.resume(release);
    expect(await reopened.resume(release)).toEqual(resumed);
    await expect(reopened.pause(mutation)).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_CONTROL_CONFLICT",
    });
    const pausedAgain = await reopened.pause({
      ...mutation,
      operationId: "handoff-pause-2",
      expectedRevision: resumed.revision,
    });
    await expect(queue.claimExecution(claim)).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_PAUSED",
    });
    await reopened.resume({
      subjectUserId,
      operationId: "handoff-pause-2",
      expectedRevision: pausedAgain.revision,
    });
    expect((await queue.claimExecution(claim)).state).toBe("executing");
  }, 60_000);

  it("blocks handoff resume until in-flight and uncertain delivery is reconciled", async () => {
    const subjectUserId = "handoff-owner-uncertain";
    const control = new ApprovalDispatchControlStore(runtime);
    const request = await queue.enqueue(messageInput({ subjectUserId }));
    await queue.approve(request.id, subjectUserId, {
      resolvedBy: subjectUserId,
      resolutionReason: "reviewed before handoff",
    });
    const executing = await queue.claimExecution({
      requestId: request.id,
      subjectUserId,
      provider: "synthetic-account",
      providerIdempotencyKey: request.id,
    });
    if (!executing.execution) throw new Error("Execution was not persisted");
    const attempt = {
      requestId: request.id,
      subjectUserId,
      attemptId: executing.execution.attemptId,
    };
    const paused = await control.pause({
      subjectUserId,
      operationId: "handoff-in-flight",
      expectedRevision: 0,
    });
    const release = {
      subjectUserId,
      operationId: "handoff-in-flight",
      expectedRevision: paused.revision,
    };
    await expect(control.resume(release)).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_DRAIN_REQUIRED",
    });
    await queue.markDispatchStarted(attempt);
    await queue.markReconciliationRequired({
      ...attempt,
      error: "Provider response lost",
    });
    await expect(
      new ApprovalDispatchControlStore(runtime).resume(release),
    ).rejects.toMatchObject({
      code: "APPROVAL_DISPATCH_DRAIN_REQUIRED",
      context: {
        requests: [{ id: request.id, state: "reconciliation_required" }],
      },
    });
    await queue.reconcileExecution({
      ...attempt,
      outcome: "not_delivered",
      reconciledBy: subjectUserId,
      reconciliationReason: "Provider confirmed no delivery",
    });
    await queue.markExpired(request.id, subjectUserId);
    expect((await control.resume(release)).paused).toBe(false);
  }, 60_000);

  it("serializes a racing pause and claim without pausing another owner", async () => {
    const control = new ApprovalDispatchControlStore(runtime);
    const subjectUserId = "handoff-owner-race";
    const request = await queue.enqueue(messageInput({ subjectUserId }));
    await queue.approve(request.id, subjectUserId, {
      resolvedBy: subjectUserId,
      resolutionReason: "reviewed before handoff",
    });
    const claim = {
      requestId: request.id,
      subjectUserId,
      provider: "synthetic-account",
      providerIdempotencyKey: request.id,
    };
    const [pause, execution] = await Promise.allSettled([
      control.pause({
        subjectUserId,
        operationId: "handoff-race",
        expectedRevision: 0,
      }),
      queue.claimExecution(claim),
    ]);
    expect(pause.status).toBe("fulfilled");
    expect((await control.read(subjectUserId)).paused).toBe(true);
    if (execution.status === "fulfilled") {
      await expect(
        control.resume({
          subjectUserId,
          operationId: "handoff-race",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_DISPATCH_DRAIN_REQUIRED" });
    } else {
      expect(execution.reason).toMatchObject({
        code: "APPROVAL_DISPATCH_PAUSED",
      });
      expect((await queue.byId(request.id, subjectUserId))?.state).toBe(
        "approved",
      );
    }
    const other = await queue.enqueue(
      messageInput({ subjectUserId: "handoff-unrelated-owner" }),
    );
    await queue.approve(other.id, other.subjectUserId, {
      resolvedBy: other.subjectUserId,
      resolutionReason: "unrelated account",
    });
    expect(
      (
        await queue.claimExecution({
          ...claim,
          requestId: other.id,
          subjectUserId: other.subjectUserId,
        })
      ).state,
    ).toBe("executing");
  }, 60_000);

  it("retires a known-undelivered approval without permitting another send", async () => {
    const request = await queue.enqueue(messageInput());
    const claim = {
      requestId: request.id,
      subjectUserId: request.subjectUserId,
      provider: "retired-test-account",
      providerIdempotencyKey: `retirement:${request.id}`,
    };
    await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: request.subjectUserId,
      resolutionReason: "Synthetic account handoff test",
    });
    const executing = await queue.claimExecution(claim);
    if (!executing.execution) throw new Error("Execution was not persisted");
    const mutation = { ...claim, attemptId: executing.execution.attemptId };
    await queue.markDispatchStarted(mutation);
    const failed = await queue.markRetryableFailure({
      ...mutation,
      error: "Provider confirmed non-delivery before account retirement",
      providerReceipt: { delivered: false },
    });
    await expect(
      queue.markExpired(request.id, "another-owner"),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    const retired = await queue.markExpired(request.id, request.subjectUserId);
    expect(retired.execution).toEqual(failed.execution);
    const reopened = createApprovalQueue(runtime, { agentId: runtime.agentId });
    await expect(reopened.claimExecution(claim)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
    expect(
      (await reopened.byId(request.id, request.subjectUserId))?.state,
    ).toBe("expired");
  }, 60_000);

  it("keeps an uncertain delivery unresolved until reconciliation permits retirement", async () => {
    const request = await queue.enqueue(messageInput());
    await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: request.subjectUserId,
      resolutionReason: "Synthetic account handoff test",
    });
    const executing = await queue.claimExecution({
      requestId: request.id,
      subjectUserId: request.subjectUserId,
      provider: "retired-test-account",
      providerIdempotencyKey: `retirement:${request.id}`,
    });
    if (!executing.execution) throw new Error("Execution was not persisted");
    const mutation = {
      requestId: request.id,
      subjectUserId: request.subjectUserId,
      attemptId: executing.execution.attemptId,
    };
    await queue.markDispatchStarted(mutation);
    await expect(
      queue.markExpired(request.id, request.subjectUserId),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);
    const uncertain = await queue.markReconciliationRequired({
      ...mutation,
      error: "Connection lost after dispatch",
    });
    await expect(
      queue.markExpired(request.id, request.subjectUserId),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);
    expect(await queue.byId(request.id, request.subjectUserId)).toEqual(
      uncertain,
    );
    await queue.reconcileExecution({
      ...mutation,
      outcome: "not_delivered",
      reconciledBy: request.subjectUserId,
      reconciliationReason: "Provider lookup confirmed no delivery",
    });
    await queue.markExpired(request.id, request.subjectUserId);
    await expect(
      queue.claimExecution({
        requestId: request.id,
        subjectUserId: request.subjectUserId,
        provider: "replacement-account",
        providerIdempotencyKey: `replacement:${request.id}`,
      }),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);
  }, 60_000);

  it("enqueue → approve → durable execution → receipt happy path", async () => {
    const enqueued = await queue.enqueue(messageInput());
    expect(enqueued.state).toBe("pending");
    expect(enqueued.resolvedAt).toBeNull();
    expect(enqueued.resolvedBy).toBeNull();

    const fetched = await queue.byId(enqueued.id, "owner-123");
    expect(fetched).not.toBeNull();
    expect(fetched?.action).toBe("send_message");

    const approved = await queue.approve(enqueued.id, "owner-123", {
      resolvedBy: "owner-123",
      resolutionReason: "looks good",
    });
    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe("owner-123");
    expect(approved.resolvedAt).toBeInstanceOf(Date);

    const executing = await queue.claimExecution({
      requestId: enqueued.id,
      subjectUserId: "owner-123",
      provider: "test",
      providerIdempotencyKey: `approval:${enqueued.id}:test`,
    });
    expect(executing.state).toBe("executing");

    const attemptId = executing.execution?.attemptId ?? "";
    await queue.markDispatchStarted({
      requestId: enqueued.id,
      subjectUserId: "owner-123",
      attemptId,
    });
    const done = await queue.markDone({
      requestId: enqueued.id,
      subjectUserId: "owner-123",
      attemptId,
      providerReceipt: { provider: "test", id: "receipt-1" },
    });
    expect(done.state).toBe("done");
    expect(done.execution?.providerReceipt).toEqual({
      provider: "test",
      id: "receipt-1",
    });

    const pendingList = await queue.list({
      subjectUserId: "owner-123",
      state: "pending",
      action: null,
      limit: 10,
    });
    expect(pendingList.every((r) => r.id !== enqueued.id)).toBe(true);
  }, 60_000);

  it("migrates and round-trips durable approval idempotency plus the scheduling attempt ledger", async () => {
    const approvalColumns = await executeRawSql(
      runtime,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'approval_requests'
          AND column_name = 'idempotency_key'`,
    );
    expect(approvalColumns).toHaveLength(1);
    const attemptTables = await executeRawSql(
      runtime,
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'app_lifeops'
          AND table_name = 'life_scheduling_delivery_attempts'`,
    );
    expect(attemptTables).toHaveLength(1);

    const input = messageInput({
      subjectUserId: "owner-idempotency",
      idempotencyKey: "approval-integration:same-message",
    });
    const outcomes = await Promise.all([
      queue.enqueueWithResult(input),
      queue.enqueueWithResult(input),
    ]);
    expect(outcomes.map((outcome) => outcome.reused).sort()).toEqual([
      false,
      true,
    ]);
    const first = outcomes.find((outcome) => !outcome.reused)?.request;
    const concurrentRetry = outcomes.find((outcome) => outcome.reused)?.request;
    if (!first || !concurrentRetry) {
      throw new Error(
        "expected one inserted and one atomically reused request",
      );
    }
    expect(concurrentRetry.id).toBe(first.id);
    expect(first.idempotencyKey).toBe(input.idempotencyKey);
    const sequentialReplay = await queue.enqueueWithResult(input);
    expect(sequentialReplay).toMatchObject({
      reused: true,
      request: { id: first.id, idempotencyKey: input.idempotencyKey },
    });
    const rows = await queue.list({
      subjectUserId: "owner-idempotency",
      state: null,
      action: null,
      limit: 10,
    });
    expect(
      rows.filter((row) => row.idempotencyKey === input.idempotencyKey),
    ).toHaveLength(1);

    await expect(
      queue.enqueue(
        messageInput({
          subjectUserId: "owner-idempotency",
          idempotencyKey: input.idempotencyKey,
          payload: {
            action: "send_message",
            recipient: "+15555551212",
            body: "Different immutable content",
            replyToMessageId: null,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ApprovalIdempotencyConflictError);
    await expect(
      queue.enqueue({
        ...input,
        reason: "a different immutable approval explanation",
      }),
    ).rejects.toBeInstanceOf(ApprovalIdempotencyConflictError);
    await expect(
      queue.enqueue({
        ...input,
        expiresAt: new Date(input.expiresAt.getTime() + 1_000),
      }),
    ).rejects.toBeInstanceOf(ApprovalIdempotencyConflictError);
  }, 60_000);

  it("rolls back negotiation, approval, and delivery evidence as one PGlite transaction", async () => {
    const service = new LifeOpsService(runtime);
    const counterparty = await service.upsertRelationship({
      name: "Atomic Taylor",
      primaryChannel: "email",
      primaryHandle: "atomic-taylor@example.com",
      email: "atomic-taylor@example.com",
      phone: null,
      notes: "atomic scheduling test",
      tags: ["family"],
      relationshipType: "co_parent_of",
      lastContactedAt: null,
      metadata: {},
    });
    const target = await service.resolveCounterpartyTargetForRelationship(
      counterparty.id,
    );
    const transactionalQueue = new PgApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    let negotiationId = "";
    let approvalRequestId = "";

    await expect(
      withTransaction(runtime, async (tx) => {
        const negotiation = await service.startNegotiation({
          subject: "Atomic school meeting",
          relationshipId: counterparty.id,
          durationMinutes: 30,
          timezone: "America/Los_Angeles",
          tx,
        });
        negotiationId = negotiation.id;
        const draft = await service.draftOpeningMessage(negotiation, target);
        if (!draft) throw new Error("expected an opening draft");
        const payload = schedulingApprovalPayloadForDraft(draft);
        const correlation = readSchedulingApprovalCorrelation(payload);
        if (!correlation) throw new Error("expected scheduling correlation");
        const enqueued = await transactionalQueue.enqueueTransactional(
          {
            requestedBy: "PERSONAL_ASSISTANT",
            subjectUserId: String(runtime.agentId),
            action: payload.action,
            payload,
            channel: draft.transportChannel,
            reason: "atomic rollback probe",
            idempotencyKey: schedulingDeliveryIdempotencyKey(
              correlation.contentSha256,
            ),
            expiresAt: new Date(Date.now() + 60_000),
          },
          tx,
        );
        approvalRequestId = enqueued.request.id;
        await prepareSchedulingDelivery(tx, {
          agentId: runtime.agentId,
          request: enqueued.request,
          correlation,
        });
        throw new Error("force rollback after all three records exist");
      }),
    ).rejects.toThrow("force rollback");

    expect(await service.getNegotiation(negotiationId)).toBeNull();
    expect(
      await queue.byId(approvalRequestId, String(runtime.agentId)),
    ).toBeNull();
    expect(
      await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
        approvalRequestId,
      ),
    ).toBeNull();
  }, 60_000);

  it("round-trips an exact scheduling draft and typed content hash through the real queue", async () => {
    const payload = attachSchedulingApprovalCorrelation(
      {
        action: "send_email",
        to: ["co-parent@example.com"],
        cc: [],
        bcc: [],
        subject: "Scheduling: school conference",
        body: "Would Tuesday at 4:00 PM work for the school conference?",
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
    const enqueued = await queue.enqueue({
      requestedBy: "PERSONAL_ASSISTANT",
      subjectUserId: "owner-scheduling-integrity",
      action: "send_email",
      payload,
      channel: "email",
      reason: "Review exact scheduling proposal",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const fetched = await queue.byId(enqueued.id, "owner-scheduling-integrity");
    if (!fetched) throw new Error("approval row disappeared after enqueue");
    expect(fetched.payload).toEqual(payload);
    expect(readSchedulingApprovalCorrelation(fetched.payload)).toMatchObject({
      negotiationId: "negotiation-17",
      proposalId: "proposal-41",
      messageKind: "proposal",
      transportChannel: "email",
    });
    expect(verifySchedulingApprovalContent(fetched.payload)).toMatchObject({
      matches: true,
      actualSha256: payload.scheduling.contentSha256,
    });
  }, 60_000);

  it("reuses concurrent identical scheduling enqueues with source-anchored expiry", async () => {
    const { request } = await createOpeningApproval({
      suffix: "deterministic-expiry-1000",
    });
    const correlation = readSchedulingApprovalCorrelation(request.payload);
    if (!correlation) throw new Error("expected scheduling correlation");
    const expiresAt = schedulingApprovalExpiresAt(correlation.sourceUpdatedAt);
    expect(expiresAt.getTime()).toBe(request.expiresAt.getTime());
    const input: ApprovalEnqueueInput = {
      requestedBy: request.requestedBy,
      subjectUserId: request.subjectUserId,
      action: request.action,
      payload: request.payload,
      channel: request.channel,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      expiresAt,
    };

    const [first, second] = await Promise.all([
      queue.enqueue(input),
      queue.enqueue({
        ...input,
        expiresAt: schedulingApprovalExpiresAt(correlation.sourceUpdatedAt),
      }),
    ]);

    expect(first.id).toBe(request.id);
    expect(second.id).toBe(request.id);
  }, 60_000);

  it("fails fast when a persisted delivery attempt count is invalid", async () => {
    const { request } = await createOpeningApproval({
      suffix: "invalid-attempt-count-1000",
    });
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_scheduling_delivery_attempts
          SET attempt_count = -1
        WHERE agent_id = '${runtime.agentId}'
          AND approval_request_id = '${request.id}'`,
    );

    await expect(
      new SchedulingDeliveryStore(runtime).byApprovalRequestId(request.id),
    ).rejects.toMatchObject({
      code: "SCHEDULING_DELIVERY_PERSISTED_ROW_INVALID",
    });
  }, 60_000);

  it("scheduling start/propose/finalize/cancel queue exact drafts without connector delivery", async () => {
    const service = new LifeOpsService(runtime);
    const counterparty = await service.upsertRelationship({
      name: "Taylor",
      primaryChannel: "email",
      primaryHandle: "co-parent@example.com",
      email: "co-parent@example.com",
      phone: null,
      notes: "co-parent",
      tags: ["family"],
      relationshipType: "co_parent_of",
      lastContactedAt: null,
      metadata: {},
    });
    const sendEmail = vi.spyOn(LifeOpsService.prototype, "sendGmailMessage");
    const subjectUserId = String(runtime.agentId);
    const message = {
      id: runtime.agentId,
      entityId: subjectUserId,
      roomId: runtime.agentId,
      content: { text: "Coordinate the school conference with Taylor" },
    } as never;

    const result = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "start",
          subject: "School conference",
          relationshipId: counterparty.id,
          durationMinutes: 30,
          timezone: "America/Los_Angeles",
        },
      } as never,
      async () => [],
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const data = result.data as {
      negotiation: { id: string };
      approvalRequestId: string;
    };
    const approval = await queue.byId(data.approvalRequestId, subjectUserId);
    if (!approval) throw new Error("scheduling handler queued no approval");
    expect(approval.state).toBe("pending");
    expect(approval.action).toBe("send_email");
    expect(approval.payload).toMatchObject({
      action: "send_email",
      to: ["co-parent@example.com"],
      subject: "Scheduling: School conference",
    });
    expect(approval.reason).toContain("To: Taylor (co-parent@example.com)");
    expect(approval.reason).toContain("Subject: Scheduling: School conference");
    expect(approval.reason).toContain("Message:\nHi,");
    expect(approval.reason).toContain("Content SHA-256:");
    expect(readSchedulingApprovalCorrelation(approval.payload)).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: null,
      messageKind: "opening",
      transportChannel: "email",
    });
    expect(verifySchedulingApprovalContent(approval.payload)?.matches).toBe(
      true,
    );
    const openingAttempt = await new SchedulingDeliveryStore(
      runtime,
    ).byApprovalRequestId(approval.id);
    expect(openingAttempt).toMatchObject({
      approvalRequestId: approval.id,
      negotiationId: data.negotiation.id,
      state: "awaiting_approval",
      attemptCount: 0,
      idempotencyKey: approval.idempotencyKey,
    });

    const proposed = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "propose",
          negotiationId: data.negotiation.id,
          startAt: "2026-08-10T23:00:00.000Z",
          endAt: "2026-08-10T23:30:00.000Z",
          proposedBy: "owner",
        },
      } as never,
      async () => [],
    );
    expect(proposed).toMatchObject({
      success: true,
      data: {
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const proposedData = proposed.data as {
      proposal: { id: string };
      approvalRequestId: string;
    };
    const proposalApproval = await queue.byId(
      proposedData.approvalRequestId,
      subjectUserId,
    );
    if (!proposalApproval) {
      throw new Error("proposal handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(proposalApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "proposal",
    });
    expect(
      verifySchedulingApprovalContent(proposalApproval.payload)?.matches,
    ).toBe(true);

    const responded = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "respond",
          proposalId: proposedData.proposal.id,
          response: "accepted",
        },
      } as never,
      async () => [],
    );
    expect(responded).toMatchObject({
      success: true,
      data: { proposal: { status: "accepted" } },
    });

    const finalized = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "finalize",
          negotiationId: data.negotiation.id,
          proposalId: proposedData.proposal.id,
        },
      } as never,
      async () => [],
    );
    expect(finalized).toMatchObject({
      success: true,
      data: {
        negotiation: {
          state: "confirmed",
          acceptedProposalId: proposedData.proposal.id,
        },
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventCreated: false,
      },
    });
    const finalizedData = finalized.data as { approvalRequestId: string };
    const confirmationApproval = await queue.byId(
      finalizedData.approvalRequestId,
      subjectUserId,
    );
    if (!confirmationApproval) {
      throw new Error("finalize handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(confirmationApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "confirmation",
    });
    expect(
      verifySchedulingApprovalContent(confirmationApproval.payload)?.matches,
    ).toBe(true);

    const cancelled = await runSchedulingNegotiationHandler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "cancel",
          negotiationId: data.negotiation.id,
          reason: "Conference moved to a school-managed booking portal",
        },
      } as never,
      async () => [],
    );
    expect(cancelled).toMatchObject({
      success: true,
      data: {
        negotiation: { state: "cancelled" },
        approvalState: "pending",
        deliveryStatus: "awaiting_approval",
        sent: false,
        calendarEventChanged: false,
      },
    });
    const cancelledData = cancelled.data as { approvalRequestId: string };
    const cancellationApproval = await queue.byId(
      cancelledData.approvalRequestId,
      subjectUserId,
    );
    if (!cancellationApproval) {
      throw new Error("cancel handler queued no approval");
    }
    expect(
      readSchedulingApprovalCorrelation(cancellationApproval.payload),
    ).toMatchObject({
      negotiationId: data.negotiation.id,
      proposalId: proposedData.proposal.id,
      messageKind: "cancellation",
    });
    expect(
      verifySchedulingApprovalContent(cancellationApproval.payload)?.matches,
    ).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps scheduling delivery unclaimed during a handoff pause and sends once after resume", async () => {
    const { request } = await createOpeningApproval({
      suffix: "handoff-pause",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "Synthetic owner approval",
    });
    const controls = new ApprovalDispatchControlStore(runtime);
    const before = await controls.read(request.subjectUserId);
    const paused = await controls.pause({
      subjectUserId: request.subjectUserId,
      operationId: "scheduling-handoff-pause",
      expectedRevision: before.revision,
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email) throw new Error("Email fixture missing");
    const original = email.send;
    const send = vi.fn(async (payload: Parameters<typeof original>[0]) =>
      receiptResult(payload, "scheduling-after-resume"),
    );
    email.send = send;
    try {
      const result = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(result).toMatchObject({
        success: false,
        data: {
          error: "APPROVAL_DISPATCH_PAUSED",
          sent: false,
          state: "approved",
        },
      });
      expect(send).not.toHaveBeenCalled();
      expect((await queue.byId(request.id, request.subjectUserId))?.state).toBe(
        "approved",
      );
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({ state: "awaiting_approval", attemptCount: 0 });
      await controls.resume({
        subjectUserId: request.subjectUserId,
        operationId: "scheduling-handoff-pause",
        expectedRevision: paused.revision,
      });
      expect(
        await executeApprovedRequest({ runtime, queue, request: approved }),
      ).toMatchObject({ success: true });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      email.send = original;
      const current = await controls.read(request.subjectUserId);
      if (current.paused)
        await controls.resume({
          subjectUserId: request.subjectUserId,
          operationId: "scheduling-handoff-pause",
          expectedRevision: current.revision,
        });
    }
  }, 60_000);

  it("suppresses a concurrent duplicate send and completes only with one durable provider receipt", async () => {
    const { request } = await createOpeningApproval({
      suffix: "concurrent-1001",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact concurrent draft",
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const send = vi.fn(async (payload: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return receiptResult(payload, "gmail-concurrent-1");
    });
    email.send = send;
    try {
      const [first, duplicate] = await Promise.all([
        executeApprovedRequest({ runtime, queue, request: approved }),
        executeApprovedRequest({ runtime, queue, request: approved }),
      ]);
      expect([first.success, duplicate.success].filter(Boolean)).toHaveLength(
        1,
      );
      expect(
        [first, duplicate].find((result) => !result.success),
      ).toMatchObject({
        data: { error: "SCHEDULING_DELIVERY_IN_FLIGHT", sent: false },
      });
      expect(send).toHaveBeenCalledTimes(1);
      if (approved.payload.action !== "send_email")
        throw new Error("Expected email fixture");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            grantId: approved.payload.grantId,
          }),
        }),
      );
      // A fresh queue/store instance models a worker restart with no in-memory
      // execution state. The persisted receipt remains the dedupe authority.
      const restartedQueue = new PgApprovalQueue(runtime, {
        agentId: runtime.agentId,
      });
      const completedAfterRestart = await restartedQueue.byId(
        request.id,
        request.subjectUserId,
      );
      if (!completedAfterRestart) {
        throw new Error("completed approval disappeared across restart seam");
      }
      const replay = await executeApprovedRequest({
        runtime,
        queue: restartedQueue,
        request: completedAfterRestart,
      });
      expect(replay).toMatchObject({
        success: true,
        data: { duplicateSuppressed: true, sent: true },
      });
      expect(send).toHaveBeenCalledTimes(1);

      const persisted = await new SchedulingDeliveryStore(
        runtime,
      ).byApprovalRequestId(request.id);
      expect(persisted).toMatchObject({
        state: "succeeded",
        attemptCount: 1,
        provider: "integration-provider",
        providerMessageId: "gmail-concurrent-1",
      });
      expect(persisted?.receipt?.idempotencyKey).toBe(request.idempotencyKey);
      expect((await queue.byId(request.id, request.subjectUserId))?.state).toBe(
        "done",
      );
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it("retries only a provider-declared non-acceptance, preserving the same idempotency key", async () => {
    const { request } = await createOpeningApproval({
      suffix: "retry-1002",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact retry draft",
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const observedKeys: string[] = [];
    const send = vi
      .fn<(payload: unknown) => Promise<DispatchResult>>()
      .mockImplementationOnce(async (payload) => {
        observedKeys.push(
          String((payload as Record<string, unknown>).idempotencyKey),
        );
        return {
          ok: false,
          reason: "rate_limited",
          userActionable: false,
          acceptance: "not_accepted",
          retryAfterMinutes: 1,
        };
      })
      .mockImplementationOnce(async (payload) => {
        observedKeys.push(
          String((payload as Record<string, unknown>).idempotencyKey),
        );
        return receiptResult(payload, "gmail-retry-2");
      });
    email.send = send;
    try {
      const rejected = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(rejected).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_DELIVERY_NOT_ACCEPTED",
          state: "approved",
          safeToRetry: true,
        },
      });
      expect((await queue.byId(request.id, request.subjectUserId))?.state).toBe(
        "approved",
      );

      const restartedQueue = new PgApprovalQueue(runtime, {
        agentId: runtime.agentId,
      });
      const retryableAfterRestart = await restartedQueue.byId(
        request.id,
        request.subjectUserId,
      );
      if (!retryableAfterRestart) {
        throw new Error("retryable approval disappeared across restart seam");
      }
      const retried = await executeApprovedRequest({
        runtime,
        queue: restartedQueue,
        request: retryableAfterRestart,
      });
      expect(retried).toMatchObject({
        success: true,
        verifiedUserFacing: true,
        data: { state: "done", sent: true },
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(new Set(observedKeys)).toEqual(
        new Set([String(request.idempotencyKey)]),
      );
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({
        state: "succeeded",
        attemptCount: 2,
        providerMessageId: "gmail-retry-2",
      });
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it("keeps an ambiguous provider result quarantined across worker restart", async () => {
    const { request } = await createOpeningApproval({
      suffix: "ambiguous-1003",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact ambiguous draft",
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const send = vi.fn(
      async (): Promise<DispatchResult> => ({
        ok: true,
        messageId: "provider-accepted-without-receipt",
      }),
    );
    email.send = send;
    try {
      const ambiguous = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(ambiguous).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS",
          state: "executing",
          sent: false,
          safeToRetry: false,
        },
      });
      const restartedQueue = new PgApprovalQueue(runtime, {
        agentId: runtime.agentId,
      });
      const ambiguousAfterRestart = await restartedQueue.byId(
        request.id,
        request.subjectUserId,
      );
      if (!ambiguousAfterRestart) {
        throw new Error("ambiguous approval disappeared across restart seam");
      }
      const suppressed = await executeApprovedRequest({
        runtime,
        queue: restartedQueue,
        request: ambiguousAfterRestart,
      });
      expect(suppressed).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS",
          sent: false,
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect((await queue.byId(request.id, request.subjectUserId))?.state).toBe(
        "executing",
      );
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({
        state: "ambiguous",
        attemptCount: 1,
        providerMessageId: null,
        receipt: null,
      });
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it("quarantines a hostile thrown connector value without coercion failure", async () => {
    const { request } = await createOpeningApproval({
      suffix: "hostile-throw-1003",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact hostile throw draft",
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const hostile = {
      toString() {
        throw new Error("poisoned toString");
      },
      [Symbol.toPrimitive]() {
        throw new Error("poisoned Symbol.toPrimitive");
      },
    };
    email.send = vi.fn(async () => {
      throw hostile;
    });
    try {
      const result = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(result).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS",
          sent: false,
          safeToRetry: false,
        },
      });
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({
        state: "ambiguous",
        lastFailure: {
          code: "CONNECTOR_THROWN_OUTCOME_UNKNOWN",
          message: "[object Object]",
        },
      });
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it("never treats a connector boolean as a provider receipt", async () => {
    const { request } = await createOpeningApproval({
      suffix: "boolean-1004",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact boolean draft",
    });
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const send = vi.fn(async () => true as never);
    email.send = send;
    try {
      const result = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(result).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS",
          sent: false,
        },
      });
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({ state: "ambiguous", receipt: null });
      expect(
        (await queue.byId(request.id, request.subjectUserId))?.state,
      ).not.toBe("done");
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it.each(["email", "telegram", "whatsapp", "imessage", "sms"] as const)(
    "persists a provider receipt before completing a %s scheduling approval",
    async (channel) => {
      const { request } = await createOpeningApproval({
        suffix: `transport-${channel}-1005`,
        channel,
      });
      const approved = await queue.approve(request.id, request.subjectUserId, {
        resolvedBy: String(runtime.agentId),
        resolutionReason: `reviewed exact ${channel} draft`,
      });
      const contribution = getChannelRegistry(runtime)?.get(channel);
      if (!contribution?.send) {
        throw new Error(`${channel} channel is unavailable`);
      }
      expect(contribution.receiptContract).toBe("provider_receipt_id");
      const originalSend = contribution.send;
      const send = vi.fn(async (payload: unknown) =>
        receiptResult(payload, `${channel}-receipt-1`),
      );
      contribution.send = send;
      try {
        const result = await executeApprovedRequest({
          runtime,
          queue,
          request: approved,
        });
        expect(result).toMatchObject({
          success: true,
          verifiedUserFacing: true,
          data: {
            state: "done",
            sent: true,
            channel,
            receipt: {
              providerMessageId: `${channel}-receipt-1`,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        contribution.send = originalSend;
      }
    },
    60_000,
  );

  it("rejects a Discord scheduling draft before committing its negotiation or approval", async () => {
    const service = new LifeOpsService(runtime);
    const suffix = "unsupported-discord-1006";
    const counterparty = await service.upsertRelationship({
      name: "Discord Taylor",
      primaryChannel: "discord",
      primaryHandle: schedulingTarget("discord", suffix),
      email: null,
      phone: null,
      notes: "unsupported receipt transport",
      tags: ["family"],
      relationshipType: "co_parent_of",
      lastContactedAt: null,
      metadata: {},
    });
    const message = {
      id: runtime.agentId,
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: { text: "Coordinate over unsupported Discord" },
    } as never;

    await expect(
      runSchedulingNegotiationHandler(
        runtime,
        message,
        undefined,
        {
          parameters: {
            subaction: "start",
            subject: `School logistics ${suffix}`,
            relationshipId: counterparty.id,
            durationMinutes: 30,
            timezone: "America/Los_Angeles",
          },
        } as never,
        async () => [],
      ),
    ).rejects.toMatchObject({
      code: "SCHEDULING_PROVIDER_RECEIPT_UNSUPPORTED",
    });

    expect(
      (await service.listActiveNegotiations({ limit: 100 })).some(
        (negotiation) => negotiation.subject === `School logistics ${suffix}`,
      ),
    ).toBe(false);
    expect(
      (
        await queue.list({
          subjectUserId: String(runtime.agentId),
          state: null,
          action: null,
          limit: 100,
        })
      ).some((request) => request.reason.includes(suffix)),
    ).toBe(false);
  }, 60_000);

  it("rejects tampered content and stale scheduling state before claiming delivery", async () => {
    const tamperedSetup = await createOpeningApproval({
      suffix: "tampered-1007",
    });
    const tamperedApproved = await queue.approve(
      tamperedSetup.request.id,
      tamperedSetup.request.subjectUserId,
      {
        resolvedBy: String(runtime.agentId),
        resolutionReason: "reviewed exact pre-tamper draft",
      },
    );
    if (tamperedApproved.payload.action !== "send_email") {
      throw new Error("expected an email scheduling payload");
    }
    const tampered: ApprovalRequest = {
      ...tamperedApproved,
      payload: {
        ...tamperedApproved.payload,
        body: `${tamperedApproved.payload.body}\nSend a gift card too.`,
      },
    };
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const send = vi.fn(async (payload: unknown) =>
      receiptResult(payload, "must-not-send"),
    );
    email.send = send;
    try {
      const tamperResult = await executeApprovedRequest({
        runtime,
        queue,
        request: tampered,
      });
      expect(tamperResult).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_APPROVAL_CONTENT_MISMATCH",
          sent: false,
        },
      });

      const staleSetup = await createOpeningApproval({
        suffix: "stale-1008",
      });
      const staleApproved = await queue.approve(
        staleSetup.request.id,
        staleSetup.request.subjectUserId,
        {
          resolvedBy: String(runtime.agentId),
          resolutionReason: "reviewed exact pre-stale draft",
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
      await new LifeOpsService(runtime).cancelNegotiation(
        staleSetup.negotiationId,
        "the school changed the process",
      );
      const staleResult = await executeApprovedRequest({
        runtime,
        queue,
        request: staleApproved,
      });
      expect(staleResult).toMatchObject({
        success: false,
        data: {
          error: expect.stringMatching(
            /^SCHEDULING_APPROVAL_(STALE|MATERIAL_CHANGE)$/u,
          ),
          sent: false,
        },
      });
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await queue.byId(
            tamperedSetup.request.id,
            tamperedSetup.request.subjectUserId,
          )
        )?.state,
      ).toBe("approved");
      expect(
        (
          await queue.byId(
            staleSetup.request.id,
            staleSetup.request.subjectUserId,
          )
        )?.state,
      ).toBe("expired");
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          staleSetup.request.id,
        ),
      ).toMatchObject({
        state: "invalidated",
        lastFailure: {
          error: expect.stringMatching(
            /^SCHEDULING_APPROVAL_(STALE|MATERIAL_CHANGE)$/u,
          ),
        },
      });
    } finally {
      email.send = originalSend;
    }
  }, 60_000);

  it("invalidates a contact mutation that lands after preflight but before the transactional claim", async () => {
    const { request } = await createOpeningApproval({
      suffix: "contact-race-1009",
    });
    const approved = await queue.approve(request.id, request.subjectUserId, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "reviewed exact pre-contact-change draft",
    });
    const correlation = readSchedulingApprovalCorrelation(approved.payload);
    if (!correlation) throw new Error("expected scheduling correlation");
    const service = new LifeOpsService(runtime);
    const current = await service.getRelationship(
      correlation.counterpartyEntityId,
    );
    if (!current) throw new Error("counterparty disappeared before test");
    const email = getChannelRegistry(runtime)?.get("email");
    if (!email?.send) throw new Error("email channel is unavailable");
    const originalSend = email.send;
    const send = vi.fn(async (payload: unknown) =>
      receiptResult(payload, "must-not-send-contact-race"),
    );
    email.send = send;
    const originalBegin = SchedulingDeliveryStore.prototype.begin;
    const begin = vi
      .spyOn(SchedulingDeliveryStore.prototype, "begin")
      .mockImplementationOnce(async function (
        this: SchedulingDeliveryStore,
        approvalRequest,
        schedulingCorrelation,
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await service.upsertRelationship({
          id: current.id,
          name: current.name,
          primaryChannel: current.primaryChannel,
          primaryHandle: "changed-after-preflight@example.com",
          email: "changed-after-preflight@example.com",
          phone: current.phone,
          notes: current.notes,
          tags: current.tags,
          relationshipType: current.relationshipType,
          lastContactedAt: current.lastContactedAt,
          metadata: current.metadata,
        });
        return originalBegin.call(this, approvalRequest, schedulingCorrelation);
      });
    try {
      const result = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      expect(result).toMatchObject({
        success: false,
        data: {
          error: "SCHEDULING_APPROVAL_STALE",
          state: "expired",
          sent: false,
        },
      });
      expect(send).not.toHaveBeenCalled();
      expect((await queue.byId(request.id, request.subjectUserId))?.state).toBe(
        "expired",
      );
      expect(
        await new SchedulingDeliveryStore(runtime).byApprovalRequestId(
          request.id,
        ),
      ).toMatchObject({
        state: "invalidated",
        attemptCount: 0,
      });
    } finally {
      begin.mockRestore();
      email.send = originalSend;
    }
  }, 60_000);

  it("enqueue posts the question into chat as an assistant event with approve/reject chips (#14733)", async () => {
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const eventService = runtime.getService(
      AgentEventService.serviceType,
    ) as AgentEventService;
    const unsubscribe = eventService.subscribe((event) => {
      events.push({ stream: event.stream, data: event.data });
    });
    try {
      const enqueued = await queue.enqueue(
        messageInput({ subjectUserId: "owner-chips" }),
      );

      const assistant = events.filter(
        (event) =>
          event.stream === "assistant" &&
          event.data.source === "lifeops-approval",
      );
      expect(assistant).toHaveLength(1);
      const data = assistant[0]?.data ?? {};
      expect(data.requestId).toBe(enqueued.id);
      expect(data.action).toBe("send_message");
      const text = String(data.text ?? "");
      expect(text).toContain("agent wants to confirm before sending");
      const { blocks } = parseInteractionBlocks(text);
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      if (block?.kind !== "choice") throw new Error("expected choice block");
      expect(block.scope).toBe(`approval-${enqueued.id}`);
      expect(block.id).toBe(enqueued.id);
      // The tapped value is the owner's next message; it must carry the id
      // RESOLVE_REQUEST resolves verbatim.
      expect(block.options.map((o) => o.value)).toEqual([
        `approve ${enqueued.id}`,
        `reject ${enqueued.id}`,
      ]);

      // Round-trip: drive the queue with the tapped approve value's id.
      const tapped = block.options[0]?.value ?? "";
      const requestId = tapped.replace(/^approve /, "");
      const approved = await queue.approve(requestId, "owner-chips", {
        resolvedBy: "owner-chips",
        resolutionReason: "tapped Approve",
      });
      expect(approved.id).toBe(enqueued.id);
      expect(approved.state).toBe("approved");
    } finally {
      unsubscribe();
    }
  }, 60_000);

  it("enqueue creates an owner-visible approval ScheduledTask for connector escalation (#14722)", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-scheduled-task" }),
    );

    const repo = new LifeOpsRepository(runtime);
    const task = await repo.getScheduledTaskByIdempotencyKey(
      runtime.agentId,
      `approval:${enqueued.id}`,
    );

    expect(task).not.toBeNull();
    expect(task?.kind).toBe("approval");
    expect(task?.priority).toBe("high");
    expect(task?.ownerVisible).toBe(true);
    expect(task?.respectsGlobalPause).toBe(false);
    expect(task?.subject).toEqual({
      kind: "self",
      id: "owner-scheduled-task",
    });
    expect(task?.metadata?.approvalRequestId).toBe(enqueued.id);
    expect(task?.metadata?.approvalAction).toBe("send_message");
    expect(task?.metadata?.pendingPromptRoomId).toBe(`approval:${enqueued.id}`);
    expect(task?.completionCheck?.kind).toBe("user_acknowledged");
    expect(task?.completionCheck?.params).toEqual({ requestId: enqueued.id });
    expect(task?.escalation?.steps?.map((step) => step.channelKey)).toEqual(
      expect.arrayContaining(["sms", "telegram", "discord", "imessage"]),
    );
    expect(task?.escalation?.steps?.at(-1)?.channelKey).toBe("in_app");
    expect(task?.promptInstructions).toContain(`approve ${enqueued.id}`);
    expect(task?.promptInstructions).toContain(`reject ${enqueued.id}`);
  }, 60_000);

  it("rolls back the approval row when the ScheduledTask cannot be created", async () => {
    const failedStateDir = mkdtempSync(
      join(tmpdir(), "approval-queue-schedule-fail-"),
    );
    const failedConfigPath = join(failedStateDir, "eliza.json");
    writeFileSync(
      failedConfigPath,
      JSON.stringify({ logging: { level: "error" } }),
      "utf8",
    );
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    const previousConfigPath = process.env.ELIZA_CONFIG_PATH;
    const previousPersistConfigPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
    process.env.ELIZA_STATE_DIR = failedStateDir;
    process.env.ELIZA_CONFIG_PATH = failedConfigPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = failedConfigPath;
    let failedCleanup: (() => Promise<void>) | null = null;
    try {
      const result = await createRealTestRuntime({
        plugins: [personalAssistantPlugin],
      });
      failedCleanup = result.cleanup;
      const failedQueue = createApprovalQueue(result.runtime, {
        agentId: result.runtime.agentId,
      });

      await expect(
        failedQueue.enqueue(
          messageInput({ subjectUserId: "owner-schedule-fail" }),
        ),
      ).rejects.toThrow("failed to schedule approval task");

      await expect(
        failedQueue.list({
          subjectUserId: "owner-schedule-fail",
          state: null,
          action: null,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await failedCleanup?.();
      if (previousStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.ELIZA_CONFIG_PATH;
      } else {
        process.env.ELIZA_CONFIG_PATH = previousConfigPath;
      }
      if (previousPersistConfigPath === undefined) {
        delete process.env.ELIZA_PERSIST_CONFIG_PATH;
      } else {
        process.env.ELIZA_PERSIST_CONFIG_PATH = previousPersistConfigPath;
      }
      rmSync(failedStateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("enqueue → reject records resolver", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-reject" }),
    );
    const rejected = await queue.reject(enqueued.id, "owner-reject", {
      resolvedBy: "owner-reject",
      resolutionReason: "not now",
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.resolutionReason).toBe("not now");
  }, 60_000);

  it("keeps a rejected idempotency key terminal until explicit fresh revision intent", async () => {
    const base = messageInput({
      subjectUserId: "owner-rejected-revision",
      idempotencyKey: "approval-rejected-revision:v1",
    });
    const first = await queue.enqueue(base);
    await queue.reject(first.id, "owner-rejected-revision", {
      resolvedBy: "owner-rejected-revision",
      resolutionReason: "not this version",
    });

    const replay = await queue.enqueue(base);
    expect(replay).toMatchObject({ id: first.id, state: "rejected" });

    const fresh = await queue.enqueue({
      ...base,
      idempotencyKey: "approval-rejected-revision:v2",
    });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.state).toBe("pending");
  }, 60_000);

  it("purgeExpired moves past-due pending rows to expired", async () => {
    const pastExpiry = new Date(Date.now() - 5 * 60 * 1000);
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-expire",
        expiresAt: pastExpiry,
      }),
    );
    const purgedIds = await queue.purgeExpired(new Date());
    expect(purgedIds).toContain(enqueued.id);
    const after = await queue.byId(enqueued.id, "owner-expire");
    expect(after?.state).toBe("expired");
  }, 60_000);

  it("rejects invalid state transitions hard", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-invalid" }),
    );
    await expect(
      queue.claimExecution({
        requestId: enqueued.id,
        subjectUserId: "owner-invalid",
        provider: "test",
        providerIdempotencyKey: "approval:invalid:test",
      }),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);
  }, 60_000);

  it("throws ApprovalNotFoundError on unknown id", async () => {
    await expect(
      queue.approve("00000000-0000-0000-0000-000000000000", "owner-123", {
        resolvedBy: "owner-123",
        resolutionReason: "x",
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  }, 60_000);
});
