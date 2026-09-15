/**
 * RESOLVE_REQUEST durability against the production agent-side PGlite queue.
 * The suite crosses the real SQL boundary for authorization, CAS races,
 * process restart recovery, provider ambiguity, reconciliation, and receipts.
 */

import { PGlite } from "@electric-sql/pglite";
import type {
  IAgentRuntime,
  Memory,
  SendHandlerOutcome,
  UUID,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApprovalQueue as createAgentApprovalQueue } from "../../../packages/agent/src/services/approval/store.ts";
import {
  ApprovalAmbiguousDeliveryError,
  runApprovalDispatch,
} from "../src/actions/lib/approval-execution.js";
import {
  resolveExplicitOwnerApproval,
  resolveRequestAction,
} from "../src/actions/resolve-request.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
} from "../src/lifeops/approval-queue.types.js";

import { LifeOpsService } from "../src/lifeops/service.js";

const dispatchState = vi.hoisted(() => ({
  sends: 0,
  mode: "delivered" as "delivered" | "ambiguous" | "known_failure",
}));

vi.mock("../src/actions/lib/messaging-helpers.js", () => {
  class ApprovalConnectorPreflightError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApprovalConnectorPreflightError";
    }
  }
  class ApprovalKnownNonDeliveryError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly providerStatus: number | null = null,
    ) {
      super(message);
      this.name = "ApprovalKnownNonDeliveryError";
    }
  }
  return {
    ApprovalConnectorPreflightError,
    ApprovalKnownNonDeliveryError,
    prepareCrossChannelSend: vi.fn(async () => ({
      provider: "telegram" as const,
      supportsProviderIdempotency: false,
      dispatch: async () => {
        dispatchState.sends += 1;
        if (dispatchState.mode === "ambiguous") {
          throw new Error(
            "provider accepted request, acknowledgement timed out",
          );
        }
        if (dispatchState.mode === "known_failure") {
          throw new ApprovalKnownNonDeliveryError(
            "TELEGRAM_REJECTED",
            "Telegram rejected the target before delivery",
            400,
          );
        }
        return { provider: "telegram", messageId: "tg-message-42" };
      },
    })),
  };
});

vi.mock("@elizaos/agent", async () => {
  const stub = await import("./stubs/agent.ts");
  return {
    ...stub,
    hasOwnerAccess: vi.fn(async () => true),
    resolveApprovalService: (runtime: IAgentRuntime) =>
      runtime.getService("eliza_approval"),
  };
});

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_A = "00000000-0000-0000-0000-0000000000b1" as UUID;
const OWNER_B = "00000000-0000-0000-0000-0000000000b2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

const CREATE_APPROVAL_REQUESTS_TABLE = `CREATE TABLE approval_requests (
  id uuid PRIMARY KEY NOT NULL,
  state text NOT NULL,
  requested_by text NOT NULL,
  subject_user_id text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  channel text NOT NULL,
  reason text NOT NULL,
  idempotency_key text,
  expires_at timestamp with time zone NOT NULL,
  resolved_at timestamp with time zone,
  resolved_by text,
  resolution_reason text,
  execution_attempt_id uuid,
  execution_provider text,
  provider_idempotency_key text,
  execution_claimed_at timestamp with time zone,
  dispatch_started_at timestamp with time zone,
  provider_receipt jsonb,
  execution_error text,
  reconciliation_resolved_at timestamp with time zone,
  reconciliation_resolved_by text,
  reconciliation_reason text,
  agent_id uuid NOT NULL,
  admission_revision integer,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
)`;

const CREATE_DISPATCH_CONTROL_TABLE = `CREATE TABLE approval_dispatch_controls (
  agent_id uuid NOT NULL,
  subject_user_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false,
  operation_id text,
  google_binding_required boolean NOT NULL DEFAULT false,
  retired_google_grants jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, subject_user_id)
)`;

const CREATE_APPROVAL_IDEMPOTENCY_INDEX = `CREATE UNIQUE INDEX approval_requests_agent_idempotency_uidx
  ON approval_requests (agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL`;

let pg: PGlite;
let runtime: IAgentRuntime;
let realQueue: ApprovalQueue;
let activeQueue: ApprovalQueue;

function sendMessageInput(
  subjectUserId: string = OWNER_A,
): ApprovalEnqueueInput {
  return {
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "telegram-channel-1",
      body: "On my way.",
      replyToMessageId: null,
    },
    channel: "telegram",
    reason: "Confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function message(
  action:
    | "approve"
    | "reject"
    | "reconcile_delivered"
    | "reconcile_not_delivered",
  requestId: string,
  ownerId: UUID = OWNER_A,
): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000aa01" as UUID,
    entityId: ownerId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: `${action} ${requestId}` },
    createdAt: Date.now(),
  } as Memory;
}

async function resolve(
  action:
    | "approve"
    | "reject"
    | "reconcile_delivered"
    | "reconcile_not_delivered",
  requestId: string,
  ownerId: UUID = OWNER_A,
  providerReceiptId?: string,
): Promise<{
  success?: boolean;
  text?: string;
  data?: Record<string, unknown>;
}> {
  const result = await resolveRequestAction.handler(
    runtime,
    message(action, requestId, ownerId),
    undefined,
    {
      parameters: { action, requestId, providerReceiptId },
    } as unknown as Parameters<typeof resolveRequestAction.handler>[3],
    undefined,
  );
  return (result ?? {}) as {
    success?: boolean;
    text?: string;
    data?: Record<string, unknown>;
  };
}

async function stored(id: string): Promise<{
  state: string;
  subject_user_id: string;
  execution_attempt_id: string | null;
  dispatch_started_at: Date | null;
  provider_receipt: Record<string, unknown> | null;
}> {
  const result = await pg.query<{
    state: string;
    subject_user_id: string;
    execution_attempt_id: string | null;
    dispatch_started_at: Date | null;
    provider_receipt: Record<string, unknown> | null;
  }>(
    `SELECT state, subject_user_id, execution_attempt_id,
            dispatch_started_at, provider_receipt
       FROM approval_requests WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`missing approval ${id}`);
  return row;
}

function delegateQueue(
  base: ApprovalQueue,
  overrides: Partial<ApprovalQueue> = {},
): ApprovalQueue {
  return {
    capability: base.capability,
    protocolVersion: base.protocolVersion,
    enqueue: (input) => base.enqueue(input),
    list: (filter) => base.list(filter),
    byId: (id, subjectUserId) => base.byId(id, subjectUserId),
    approve: (id, subjectUserId, resolution) =>
      base.approve(id, subjectUserId, resolution),
    reject: (id, subjectUserId, resolution) =>
      base.reject(id, subjectUserId, resolution),
    claimExecution: (claim) => base.claimExecution(claim),
    markDispatchStarted: (mutation) => base.markDispatchStarted(mutation),
    markDone: (completion) => base.markDone(completion),
    markRetryableFailure: (failure) => base.markRetryableFailure(failure),
    markReconciliationRequired: (failure) =>
      base.markReconciliationRequired(failure),
    recoverUnstartedExecution: (mutation) =>
      base.recoverUnstartedExecution(mutation),
    reconcileExecution: (reconciliation) =>
      base.reconcileExecution(reconciliation),
    markExpired: (id, subjectUserId) => base.markExpired(id, subjectUserId),
    removePending: (id, subjectUserId) => base.removePending(id, subjectUserId),
    purgeExpired: (now) => base.purgeExpired(now),
    ...overrides,
  };
}

function withDecisionBarrier(base: ApprovalQueue): ApprovalQueue {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  return delegateQueue(base, {
    approve: async (id, subjectUserId, resolution) => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothArrived;
      return base.approve(id, subjectUserId, resolution);
    },
  });
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw(CREATE_APPROVAL_REQUESTS_TABLE));
  await db.execute(sql.raw(CREATE_DISPATCH_CONTROL_TABLE));
  await db.execute(sql.raw(CREATE_APPROVAL_IDEMPOTENCY_INDEX));

  const approvalService = {
    getExecutionCapability: () => activeQueue,
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: (type: string) =>
      type === "eliza_approval" ? approvalService : null,
    getSetting: () => undefined,
    reportError: vi.fn(),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
  realQueue = createAgentApprovalQueue(runtime, {
    agentId: AGENT_ID,
  }) as unknown as ApprovalQueue;
  activeQueue = realQueue;
});

beforeEach(async () => {
  await pg.query("DELETE FROM approval_requests");
  activeQueue = realQueue;
  dispatchState.sends = 0;
  dispatchState.mode = "delivered";
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

describe("RESOLVE_REQUEST durable approval execution", () => {
  it("settles explicit owner decisions and replays the receipt with model inference unavailable", async () => {
    const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
      throw new Error("Model unavailable");
    });
    try {
      const request = await realQueue.enqueue(sendMessageInput());
      const decide = () =>
        resolveExplicitOwnerApproval(runtime, {
          subjectUserId: OWNER_A,
          requestId: request.id,
          decision: "approve",
          reason: "Reviewed exact content",
        });
      expect((await decide()).success).toBe(true);
      const first = await stored(request.id);
      expect(first.state).toBe("done");
      expect(first.provider_receipt).toMatchObject({
        messageId: "tg-message-42",
      });
      expect((await decide()).success).toBe(true);
      expect(await stored(request.id)).toEqual(first);
      expect(dispatchState.sends).toBe(1);
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
    }
  });

  it("keeps explicit owner decisions subject-scoped and rejects without dispatch", async () => {
    const request = await realQueue.enqueue(sendMessageInput(OWNER_A));
    const deniedResult = await resolveExplicitOwnerApproval(runtime, {
      subjectUserId: OWNER_B,
      requestId: request.id,
      decision: "approve",
      reason: "Wrong owner",
    });
    expect(deniedResult.success).toBe(false);
    expect((await stored(request.id)).state).toBe("pending");
    const rejected = await resolveExplicitOwnerApproval(runtime, {
      subjectUserId: OWNER_A,
      requestId: request.id,
      decision: "reject",
      reason: "Declined",
    });
    expect(rejected.success).toBe(true);
    expect((await stored(request.id)).state).toBe("rejected");
    expect(dispatchState.sends).toBe(0);
  });

  it("returns indistinguishable not-found for a cross-subject explicit id", async () => {
    const request = await realQueue.enqueue(sendMessageInput(OWNER_A));

    const result = await resolve("approve", request.id, OWNER_B);

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("REQUEST_NOT_FOUND");
    expect(await realQueue.byId(request.id, OWNER_B)).toBeNull();
    await expect(
      realQueue.approve(request.id, OWNER_B, {
        resolvedBy: OWNER_B,
        resolutionReason: "cross-owner attempt",
      }),
    ).rejects.toMatchObject({ name: "ApprovalNotFoundError" });
    expect((await stored(request.id)).state).toBe("pending");
    expect(dispatchState.sends).toBe(0);
  });

  it("recovers a crash immediately after claim without duplicating delivery", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    await realQueue.approve(request.id, OWNER_A, {
      resolvedBy: OWNER_A,
      resolutionReason: "approved",
    });
    const claimed = await realQueue.claimExecution({
      requestId: request.id,
      subjectUserId: OWNER_A,
      provider: "telegram",
      providerIdempotencyKey: `approval:${request.id}:telegram`,
    });
    expect(claimed.execution?.dispatchStartedAt).toBeNull();

    activeQueue = createAgentApprovalQueue(runtime, {
      agentId: AGENT_ID,
    }) as unknown as ApprovalQueue;
    const recovered = await resolve("approve", request.id);

    expect(recovered.success).toBe(true);
    expect(recovered.data?.state).toBe("done");
    expect(dispatchState.sends).toBe(1);
  });

  it("turns a post-dispatch-start restart into explicit reconciliation", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    await realQueue.approve(request.id, OWNER_A, {
      resolvedBy: OWNER_A,
      resolutionReason: "approved",
    });
    const claimed = await realQueue.claimExecution({
      requestId: request.id,
      subjectUserId: OWNER_A,
      provider: "telegram",
      providerIdempotencyKey: `approval:${request.id}:telegram`,
    });
    await realQueue.markDispatchStarted({
      requestId: request.id,
      subjectUserId: OWNER_A,
      attemptId: claimed.execution?.attemptId ?? "",
    });

    activeQueue = createAgentApprovalQueue(runtime, {
      agentId: AGENT_ID,
    }) as unknown as ApprovalQueue;
    const recovered = await resolve("approve", request.id);

    expect(recovered.success).toBe(false);
    expect(recovered.data?.error).toBe("APPROVAL_EXECUTION_OUTCOME_UNKNOWN");
    expect((await stored(request.id)).state).toBe("reconciliation_required");
    expect(dispatchState.sends).toBe(0);
  });

  it("never falls back or retries Telegram after accepted-then-timeout", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    dispatchState.mode = "ambiguous";

    const first = await resolve("approve", request.id);
    const replay = await resolve("approve", request.id);

    expect(first.data?.error).toBe("APPROVAL_RECONCILIATION_REQUIRED");
    expect(replay.data?.error).toBe("APPROVAL_EXECUTION_OUTCOME_UNKNOWN");
    expect(dispatchState.sends).toBe(1);
    expect((await stored(request.id)).state).toBe("reconciliation_required");
  });

  it("supports explicit owner reconciliation for delivered and non-delivered outcomes", async () => {
    const delivered = await realQueue.enqueue(sendMessageInput());
    dispatchState.mode = "ambiguous";
    await resolve("approve", delivered.id);
    const reconciledDelivered = await resolve(
      "reconcile_delivered",
      delivered.id,
      OWNER_A,
      "telegram-provider-receipt-7",
    );
    expect(reconciledDelivered.success).toBe(true);
    expect(await stored(delivered.id)).toMatchObject({
      state: "done",
      provider_receipt: {
        provider: "telegram",
        receiptId: "telegram-provider-receipt-7",
      },
    });

    const notDelivered = await realQueue.enqueue(sendMessageInput());
    await resolve("approve", notDelivered.id);
    const reconciledNotDelivered = await resolve(
      "reconcile_not_delivered",
      notDelivered.id,
    );
    expect(reconciledNotDelivered.success).toBe(true);
    expect((await stored(notDelivered.id)).state).toBe("retryable");
  });

  it("moves known non-delivery to retryable and permits one deliberate retry", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    dispatchState.mode = "known_failure";

    const failed = await resolve("approve", request.id);
    expect(failed.data?.error).toBe("APPROVAL_DELIVERY_FAILED_RETRYABLE");
    expect((await stored(request.id)).state).toBe("retryable");

    dispatchState.mode = "delivered";
    const retried = await resolve("approve", request.id);
    expect(retried.success).toBe(true);
    expect(dispatchState.sends).toBe(2);
    expect((await stored(request.id)).state).toBe("done");
  });

  it("persists provider receipts across a new queue instance", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    await resolve("approve", request.id);

    const restartedQueue = createAgentApprovalQueue(runtime, {
      agentId: AGENT_ID,
    }) as unknown as ApprovalQueue;
    const reloaded = await restartedQueue.byId(request.id, OWNER_A);

    expect(reloaded?.state).toBe("done");
    expect(reloaded?.execution?.providerReceipt).toEqual({
      provider: "telegram",
      messageId: "tg-message-42",
    });
  });

  it("persists a partial provider receipt for an ambiguous composite dispatch", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    const approved = await realQueue.approve(request.id, OWNER_A, {
      resolvedBy: OWNER_A,
      resolutionReason: "approved",
    });

    const outcome = await runApprovalDispatch({
      queue: realQueue,
      request: approved,
      subjectUserId: OWNER_A,
      prepared: {
        provider: "duffel",
        dispatch: async () => {
          throw new ApprovalAmbiguousDeliveryError(
            "booking succeeded before calendar projection failed",
            {
              provider: "duffel",
              orderId: "ord-42",
              paymentId: "pay-42",
              projectionComplete: false,
            },
          );
        },
      },
    });

    expect(outcome.kind).toBe("reconciliation_required");
    expect(await stored(request.id)).toMatchObject({
      state: "reconciliation_required",
      provider_receipt: {
        provider: "duffel",
        orderId: "ord-42",
        paymentId: "pay-42",
        projectionComplete: false,
      },
    });
  });

  it.each([
    "unknown",
    "sending",
    "failed",
    "sent-without-receipt",
    "wrong-destination",
  ])(
    "keeps Discord %s delivery in durable reconciliation and refuses replay",
    async (status) => {
      const actual = await vi.importActual<
        typeof import("../src/actions/lib/messaging-helpers.js")
      >("../src/actions/lib/messaging-helpers.js");
      const delivery = {
        provider: "discord",
        side: "owner",
        ok: true,
        channelId:
          status === "wrong-destination"
            ? "another-channel"
            : "discord-test-channel",
        deliveryStatus:
          status === "sent-without-receipt" || status === "wrong-destination"
            ? "sent"
            : status,
        providerMessageId:
          status === "wrong-destination" ? "discord-observed-1" : null,
        receipt: null,
      };
      const send = vi.fn(async () => delivery);
      const prepared = await actual.prepareCrossChannelSend({
        runtime,
        service: {
          getDiscordConnectorStatus: async () => ({
            connected: true,
            grantedCapabilities: ["discord.send"],
          }),
          sendDiscordMessage: send,
        } as unknown as Parameters<
          typeof actual.prepareCrossChannelSend
        >[0]["service"],
        channel: "discord",
        target: "discord-test-channel",
        body: "Synthetic calendar review",
      });
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: "discord",
        payload: {
          action: "send_message",
          recipient: "discord-test-channel",
          body: "Synthetic calendar review",
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "approved synthetic test",
      });
      const attempt = () =>
        runApprovalDispatch({
          queue: realQueue,
          request: approved,
          subjectUserId: OWNER_A,
          prepared: {
            provider: "discord",
            dispatch: async (key) => ({
              value: null,
              receipt: await prepared.dispatch(key),
            }),
          },
        });
      expect((await attempt()).kind).toBe("reconciliation_required");
      const restartedQueue = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      expect(await restartedQueue.byId(request.id, OWNER_A)).toMatchObject({
        state: "reconciliation_required",
        execution: {
          providerReceipt: {
            provider: "discord",
            channelId: delivery.channelId,
            deliveryStatus: delivery.deliveryStatus,
            messageId: delivery.providerMessageId,
            receipt: null,
          },
        },
      });
      await expect(attempt()).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["delivered", "partial", "persistence", "unknown"] as const)(
    "persists actual Telegram service outcomes (%s) without replay",
    async (mode) => {
      const { MessageManager } = await import(
        "../../plugin-telegram/src/messageManager.js"
      );
      const { TelegramService } = await import(
        "../../plugin-telegram/src/service.js"
      );
      let calls = 0;
      const send = vi.fn(async (chatId: string, text: string) => {
        calls++;
        if ((mode === "partial" && calls === 2) || mode === "unknown")
          throw new Error("Synthetic lost acknowledgement");
        return {
          message_id: calls,
          date: 1700000000 + calls,
          text,
          chat: { id: Number(chatId), type: "private" },
        };
      });
      const bot = {
        botInfo: { id: 12345, username: "synthetic_bot" },
        telegram: {
          sendMessage: send,
          sendChatAction: vi.fn(async () => undefined),
        },
      };
      let connector: InstanceType<typeof TelegramService>;
      const harness = {
        ...runtime,
        character: { name: "Synthetic test" },
        setSetting: vi.fn(),
        getSetting: () => undefined,
        getRoom: async () => null,
        emitEvent: vi.fn(),
        createMemory: async (memory: Memory) => {
          if (mode === "persistence")
            throw new Error("Synthetic memory failure");
          return memory.id;
        },
        getService: (name: string) =>
          name === "telegram" ? connector : runtime.getService(name),
      } as unknown as IAgentRuntime;
      connector = Object.assign(
        Object.create(TelegramService.prototype) as InstanceType<
          typeof TelegramService
        >,
        { bot, messageManager: new MessageManager(bot as never, harness) },
      );
      const service = new LifeOpsService(harness);
      const body = "x".repeat(5000);
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: "telegram",
        payload: {
          action: "send_message",
          recipient: "123",
          body,
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "Approved synthetic test",
      });
      const attempt = () =>
        runApprovalDispatch({
          queue: realQueue,
          request: approved,
          subjectUserId: OWNER_A,
          prepared: {
            provider: "telegram",
            dispatch: async () => {
              const sent = await service.sendTelegramMessage({
                side: "agent",
                target: "123",
                message: body,
              });
              return {
                value: null,
                receipt: {
                  provider: "telegram",
                  messageId: sent.messageId,
                  receipt: sent.receipt,
                },
              };
            },
          },
        });
      expect((await attempt()).kind).toBe(
        mode === "delivered" ? "delivered" : "reconciliation_required",
      );
      const reopened = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      const saved = await reopened.byId(request.id, OWNER_A);
      if (mode === "delivered")
        expect(saved).toMatchObject({
          execution: {
            providerReceipt: {
              receipt: {
                providerMessageIds: ["1", "2"],
                persistence: { status: "persisted" },
              },
            },
          },
        });
      else if (mode === "unknown")
        expect(saved).toMatchObject({
          state: "reconciliation_required",
          execution: { providerReceipt: { deliveryStatus: "unknown" } },
        });
      else
        expect(saved).toMatchObject({
          state: "reconciliation_required",
          execution: {
            providerReceipt: {
              disposition: {
                kind: mode === "partial" ? "partially_delivered" : "delivered",
                receipt: {
                  providerMessageIds: mode === "partial" ? ["1"] : ["1", "2"],
                  persistence: {
                    status: mode === "partial" ? "not_attempted" : "failed",
                  },
                },
              },
            },
          },
        });
      const originalCalls = calls;
      await expect(attempt()).rejects.toThrow();
      expect(calls).toBe(originalCalls);
    },
  );

  it.each([true, false])(
    "retains iMessage chunk receipts through the real domain and queue (success=%s)",
    async (success) => {
      const actual = await vi.importActual<
        typeof import("../src/actions/lib/messaging-helpers.js")
      >("../src/actions/lib/messaging-helpers.js");
      const messageIds = success
        ? ["accepted-part-1", "accepted-part-2"]
        : ["accepted-part-1"];
      const send = vi.fn(async () => ({
        success,
        messageIds,
        ...(success
          ? { messageId: "accepted-part-2" }
          : { error: "Later chunk failed" }),
      }));
      const connector = { isConnected: () => true, sendMessage: send };
      const service = new LifeOpsService({
        ...runtime,
        character: { name: "Synthetic test" },
        setSetting: vi.fn(),
        getService: (name: string) =>
          name === "imessage" ? connector : runtime.getService(name),
      } as unknown as IAgentRuntime);
      const prepared = await actual.prepareCrossChannelSend({
        runtime,
        service,
        channel: "imessage",
        target: "+15551234567",
        body: "Synthetic calendar review",
      });
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: "imessage",
        payload: {
          action: "send_message",
          recipient: "+15551234567",
          body: "Synthetic calendar review",
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "Approved synthetic test",
      });
      const attempt = () =>
        runApprovalDispatch({
          queue: realQueue,
          request: approved,
          subjectUserId: OWNER_A,
          prepared: {
            provider: "imessage",
            dispatch: async (key) => ({
              value: null,
              receipt: await prepared.dispatch(key),
            }),
          },
        });
      const outcome = await attempt();
      expect(outcome.kind).toBe(
        success ? "delivered" : "reconciliation_required",
      );
      const reopened = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      expect(await reopened.byId(request.id, OWNER_A)).toMatchObject({
        execution: { providerReceipt: { provider: "imessage", messageIds } },
      });
      await expect(attempt()).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "", "   "])(
    "keeps iMessage without a usable receipt (%s) in durable reconciliation",
    async (messageId) => {
      const actual = await vi.importActual<
        typeof import("../src/actions/lib/messaging-helpers.js")
      >("../src/actions/lib/messaging-helpers.js");
      const send = vi.fn(async () => ({ ok: true, messageId }));
      const prepared = await actual.prepareCrossChannelSend({
        runtime,
        service: {
          getIMessageConnectorStatus: async () => ({ connected: true }),
          sendIMessage: send,
        } as unknown as LifeOpsService,
        channel: "imessage",
        target: "+15551234567",
        body: "Synthetic calendar review",
      });
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: "imessage",
        payload: {
          action: "send_message",
          recipient: "+15551234567",
          body: "Synthetic calendar review",
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "Approved synthetic test",
      });
      const attempt = () =>
        runApprovalDispatch({
          queue: realQueue,
          request: approved,
          subjectUserId: OWNER_A,
          prepared: {
            provider: "imessage",
            dispatch: async (key) => ({
              value: null,
              receipt: await prepared.dispatch(key),
            }),
          },
        });
      expect((await attempt()).kind).toBe("reconciliation_required");
      const reopened = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      expect(await reopened.byId(request.id, OWNER_A)).toMatchObject({
        state: "reconciliation_required",
        execution: {
          providerReceipt: {
            provider: "imessage",
            messageId: messageId ?? null,
          },
        },
      });
      await expect(attempt()).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("retains missing Telegram delivery evidence across queue reopen and refuses replay", async () => {
    const actual = await vi.importActual<
      typeof import("../src/actions/lib/messaging-helpers.js")
    >("../src/actions/lib/messaging-helpers.js");
    const observed = {
      providerMessageIds: [],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted", memoryIds: [] },
    };
    const send = vi.fn(async () => ({
      ok: true,
      messageId: null,
      receipt: observed,
    }));
    const prepared = await actual.prepareCrossChannelSend({
      runtime,
      service: {
        getTelegramConnectorStatus: async () => ({
          connected: true,
          grantedCapabilities: ["telegram.send"],
        }),
        sendTelegramMessage: send,
      } as unknown as Parameters<
        typeof actual.prepareCrossChannelSend
      >[0]["service"],
      channel: "telegram",
      target: "telegram-test-chat",
      body: "Synthetic calendar review",
    });
    const request = await realQueue.enqueue({
      ...sendMessageInput(),
      channel: "telegram",
      payload: {
        action: "send_message",
        recipient: "telegram-test-chat",
        body: "Synthetic calendar review",
        replyToMessageId: null,
      },
    });
    const approved = await realQueue.approve(request.id, OWNER_A, {
      resolvedBy: OWNER_A,
      resolutionReason: "approved synthetic test",
    });
    const attempt = () =>
      runApprovalDispatch({
        queue: realQueue,
        request: approved,
        subjectUserId: OWNER_A,
        prepared: {
          provider: "telegram",
          dispatch: async (key) => ({
            value: null,
            receipt: await prepared.dispatch(key),
          }),
        },
      });
    expect((await attempt()).kind).toBe("reconciliation_required");
    const reopened = createAgentApprovalQueue(runtime, {
      agentId: AGENT_ID,
    }) as unknown as ApprovalQueue;
    expect(await reopened.byId(request.id, OWNER_A)).toMatchObject({
      state: "reconciliation_required",
      execution: {
        providerReceipt: {
          provider: "telegram",
          messageId: null,
          receipt: observed,
        },
      },
    });
    await expect(attempt()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["telegram", "partial"],
    ["discord", "partial"],
    ["telegram", "persistence-failed"],
    ["discord", "persistence-failed"],
    ["telegram", "ack-lost"],
    ["discord", "ack-lost"],
  ] as const)(
    "retains %s %s evidence through the real domain and durable queue",
    async (provider, mode) => {
      const receipt = {
        providerMessageIds: ["accepted-first-part"] as const,
        acceptedAt: 1_780_000_000_000,
        persistence:
          mode === "persistence-failed"
            ? {
                status: "failed" as const,
                failures: [
                  {
                    providerMessageId: "accepted-first-part",
                    stage: "memory" as const,
                    code: "DATABASE_UNAVAILABLE",
                    message: "database unavailable",
                  },
                ],
              }
            : { status: "persisted" as const, memoryIds: [] },
      };
      const send = vi.fn(async (): Promise<SendHandlerOutcome> => {
        if (mode === "ack-lost")
          throw new Error("Provider acknowledgement timed out");
        if (mode === "partial")
          return {
            kind: "partially_delivered",
            receipt,
            memories: [],
            code: "SECOND_PART_FAILED",
            message: "Second part was not acknowledged",
          };
        return { kind: "delivered", receipt, memories: [] };
      });
      const fallback = vi.fn();
      const connector = {
        handleSendMessage: send,
        messageManager: {},
        isReady: () => true,
        bot: { botInfo: { id: 100, username: "synthetic_bot" } },
        client: { user: { id: "100", username: "synthetic_bot" } },
      };
      const service = new LifeOpsService({
        ...runtime,
        character: { name: "Synthetic test" },
        setSetting: vi.fn(),
        sendMessageToTarget: fallback,
        getService: (name: string) =>
          name === provider ? connector : runtime.getService(name),
      } as unknown as IAgentRuntime);
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: provider,
        payload: {
          action: "send_message",
          recipient: "synthetic-channel",
          body: "Synthetic review",
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "approved synthetic test",
      });
      const attempt = () =>
        runApprovalDispatch({
          queue: realQueue,
          request: approved,
          subjectUserId: OWNER_A,
          prepared: {
            provider,
            dispatch: async () => {
              const value =
                provider === "telegram"
                  ? await service.sendTelegramMessage({
                      side: "agent",
                      target: "synthetic-channel",
                      message: "Synthetic review",
                    })
                  : await service.sendDiscordMessage({
                      side: "agent",
                      channelId: "synthetic-channel",
                      text: "Synthetic review",
                    });
              return { value, receipt: { provider } };
            },
          },
        });
      expect((await attempt()).kind).toBe("reconciliation_required");
      const reopened = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      const stored = await reopened.byId(request.id, OWNER_A);
      expect(stored).toMatchObject({
        state: "reconciliation_required",
        execution: {
          providerReceipt: {
            provider,
            accountId: "default",
            channelId: "synthetic-channel",
            ...(mode === "ack-lost"
              ? { deliveryStatus: "unknown" }
              : { disposition: { receipt } }),
          },
        },
      });
      await expect(attempt()).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it.each(["telegram", "discord"] as const)(
    "records a changed %s sender as known nondelivery without a provider call",
    async (provider) => {
      const send = vi.fn();
      const connector = {
        handleSendMessage: send,
        messageManager: {},
        isReady: () => true,
        bot: { botInfo: { id: "replacement-bot", username: "Replacement" } },
        client: { user: { id: "replacement-bot", username: "Replacement" } },
      };
      const service = new LifeOpsService({
        ...runtime,
        character: { name: "Synthetic test" },
        setSetting: vi.fn(),
        getService: (name: string) =>
          name === provider ? connector : runtime.getService(name),
      } as unknown as IAgentRuntime);
      const request = await realQueue.enqueue({
        ...sendMessageInput(),
        channel: provider,
        payload: {
          action: "send_message",
          recipient: "synthetic-channel",
          body: "Synthetic review",
          replyToMessageId: null,
        },
      });
      const approved = await realQueue.approve(request.id, OWNER_A, {
        resolvedBy: OWNER_A,
        resolutionReason: "Reviewed original-bot",
      });
      const result = await runApprovalDispatch({
        queue: realQueue,
        request: approved,
        subjectUserId: OWNER_A,
        prepared: {
          provider,
          dispatch: async () => {
            const value =
              provider === "telegram"
                ? await service.sendTelegramMessage({
                    side: "agent",
                    expectedIdentityId: "original-bot",
                    target: "synthetic-channel",
                    message: "Synthetic review",
                  })
                : await service.sendDiscordMessage({
                    side: "agent",
                    expectedIdentityId: "original-bot",
                    channelId: "synthetic-channel",
                    text: "Synthetic review",
                  });
            return { value, receipt: { provider } };
          },
        },
      });
      expect(result.kind).toBe("known_failure");
      const reopened = createAgentApprovalQueue(runtime, {
        agentId: AGENT_ID,
      }) as unknown as ApprovalQueue;
      expect(await reopened.byId(request.id, OWNER_A)).toMatchObject({
        state: "retryable",
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("serializes a forced double-approve race to one dispatch", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    activeQueue = withDecisionBarrier(realQueue);

    const [first, second] = await Promise.all([
      resolve("approve", request.id),
      resolve("approve", request.id),
    ]);

    expect(dispatchState.sends).toBe(1);
    expect((await stored(request.id)).state).toBe("done");
    expect(
      [first, second].filter((result) => result.data?.alreadyResolved !== true),
    ).toHaveLength(1);
  });

  it("rejects a queue with the wrong execution protocol before lookup", async () => {
    activeQueue = {
      ...delegateQueue(realQueue),
      protocolVersion: 1,
    } as unknown as ApprovalQueue;

    const result = await resolve(
      "approve",
      "00000000-0000-0000-0000-0000000000ff",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("APPROVAL_QUEUE_INCOMPATIBLE");
    expect(result.data?.expectedVersion).toBe(2);
  });
});
