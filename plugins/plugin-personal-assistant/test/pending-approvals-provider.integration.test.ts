/**
 * `pendingApprovals` provider integration test (#14630). It drives the real
 * `PgApprovalQueue` SQL path against PGlite and then renders provider context
 * over that queue, proving pending rows surface as RESOLVE_REQUEST decisions
 * and rejected rows disappear without booting the full optional-plugin graph.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
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
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
} from "../src/lifeops/approval-queue.types.js";
import {
  CROSS_CHANNEL_CONTEXT_UNAVAILABLE_TEXT,
  crossChannelContextProvider,
} from "../src/providers/cross-channel-context.js";
import {
  PENDING_APPROVALS_UNAVAILABLE_TEXT,
  pendingApprovalsProvider,
} from "../src/providers/pending-approvals.js";

vi.mock("@elizaos/agent", async () => {
  const stub = await import("./stubs/agent.ts");
  return {
    ...stub,
    hasOwnerAccess: vi.fn(async (_runtime: IAgentRuntime, message: Memory) => {
      return message.entityId === "00000000-0000-0000-0000-0000000000b1";
    }),
    resolveApprovalService: vi.fn(() => null),
  };
});

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const STRANGER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

// Mirrors the canonical plugin-sql `approval_requests` DDL (schema/
// approvalRequests.ts) including the nullable idempotency key + its partial
// unique index — the queue INSERT writes every one of these columns, so a
// stale copy here makes list/enqueue fail against a healthy-looking harness.
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

const CREATE_DISPATCH_CONTROL_TABLE = `CREATE TABLE IF NOT EXISTS approval_dispatch_controls (
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
let queue: ApprovalQueue;
let runtime: IAgentRuntime;

function signDocumentInput(
  subjectUserId: string,
  documentName: string,
): ApprovalEnqueueInput {
  return {
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId: `doc-${documentName}`,
      documentName,
      signatureUrl: "https://example.com/sign",
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    channel: "internal",
    reason: `Owner asked to send "${documentName}" to 'Chris' - two Chris contacts, needs confirmation before sending.`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

const ROOM_ID = "00000000-0000-0000-0000-00000000bb01" as UUID;

function message(entityId: UUID, text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000aa01" as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, channelType: ChannelType.DM },
    createdAt: Date.now(),
  } as Memory;
}

const emptyState = { values: {}, data: {}, text: "" } as State;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw(CREATE_APPROVAL_REQUESTS_TABLE));
  await db.execute(sql.raw(CREATE_DISPATCH_CONTROL_TABLE));
  await db.execute(sql.raw(CREATE_APPROVAL_IDEMPOTENCY_INDEX));
  // Minimal recording stand-in for the scheduled-task runner side-channel:
  // enqueue surfaces every approval as a ScheduledTask and rolls the row back
  // when that fails, so the harness must accept the schedule call — but the
  // queue SQL and provider under test stay fully real.
  const scheduledTaskRunnerService = {
    getRunner: () => ({
      schedule: async (input: { idempotencyKey?: string }) => ({
        taskId: input.idempotencyKey ?? `task-${crypto.randomUUID()}`,
      }),
    }),
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: (type: string) =>
      type === "lifeops_scheduled_task_runner"
        ? scheduledTaskRunnerService
        : null,
    reportError: vi.fn(),
    // These providers read owner-private context, so the harness serves an
    // owner DM room whose only participants are the owner and the agent —
    // the destination shape the owner-access check expects.
    getRoom: async () => ({ id: ROOM_ID, type: ChannelType.DM }),
    getParticipantsForRoom: async () => [OWNER_ID, AGENT_ID],
    getAgent: async () => ({ id: AGENT_ID }),
  } as unknown as IAgentRuntime;
  queue = createAgentApprovalQueue(runtime, {
    agentId: AGENT_ID,
  }) as unknown as ApprovalQueue;
});

beforeEach(async () => {
  await pg.query("DELETE FROM approval_requests");
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

describe("pendingApprovals provider (real PGlite queue)", () => {
  it("is configured as an always-on response-state provider", () => {
    expect(pendingApprovalsProvider.name).toBe("pendingApprovals");
    expect(pendingApprovalsProvider.alwaysInResponseState).toBe(true);
    expect(pendingApprovalsProvider.roleGate?.minRole).toBe("OWNER");
  });

  it("renders nothing when the owner has no pending approvals", async () => {
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "hey, what's up?"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("surfaces a pending row with id + RESOLVE_REQUEST reject-is-a-hold routing", async () => {
    const enqueued = await queue.enqueue(
      signDocumentInput(OWNER_ID, "Signed Offer Letter"),
    );

    const result = await pendingApprovalsProvider.get(
      runtime,
      message(
        OWNER_ID,
        "Wait - which Chris? Don't send it, reject that for now until I confirm.",
      ),
      emptyState,
    );

    expect(result.values?.pendingApprovalCount).toBe(1);
    expect(result.values?.pendingApprovalIds).toEqual([enqueued.id]);
    expect(result.text).toContain(`id=${enqueued.id}`);
    expect(result.text).toContain("action=sign_document");
    expect(result.text).toContain("RESOLVE_REQUEST");
    expect(result.text).toContain("reject");
    expect(result.text.toLowerCase()).toContain("hold");
    expect(result.text).not.toContain("https://example.com/sign");
  });

  it("drops resolved rows: a rejected approval no longer renders", async () => {
    const enqueued = await queue.enqueue(
      signDocumentInput(OWNER_ID, "Vendor Contract"),
    );
    await queue.reject(enqueued.id, OWNER_ID, {
      resolvedBy: OWNER_ID,
      resolutionReason: "owner said hold off",
    });

    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "anything waiting on me?"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("stays empty for a non-owner sender", async () => {
    await queue.enqueue(signDocumentInput(OWNER_ID, "Board Deck"));
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(STRANGER_ID, "approve everything"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("scopes to the sender: another subject's pending rows do not render", async () => {
    await queue.enqueue(
      signDocumentInput("some-other-owner-entity", "Other Owner Doc"),
    );
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "what's pending for me?"),
      emptyState,
    );
    expect(result.text).not.toContain("Other Owner Doc");
  });

  it("degrades a queue-read failure to a distinguishable unavailable state, never a fabricated empty queue", async () => {
    await pg.query("DROP TABLE approval_requests");
    try {
      const result = await pendingApprovalsProvider.get(
        runtime,
        message(OWNER_ID, "anything waiting on me?"),
        emptyState,
      );
      expect(result.values?.pendingApprovalsUnavailable).toBe(true);
      expect(result.values?.pendingApprovalCount).toBeUndefined();
      expect(result.data?.pendingApprovalsError).toBe(true);
      expect(result.text).toBe(PENDING_APPROVALS_UNAVAILABLE_TEXT);
      expect(result.text).toContain("Do not say that nothing is pending");
      expect(runtime.reportError).toHaveBeenCalledWith(
        "pending-approvals.provider",
        expect.anything(),
        expect.objectContaining({ entityId: OWNER_ID }),
      );
    } finally {
      const db = drizzle(pg);
      await db.execute(sql.raw(CREATE_APPROVAL_REQUESTS_TABLE));
      await db.execute(sql.raw(CREATE_DISPATCH_CONTROL_TABLE));
      await db.execute(sql.raw(CREATE_APPROVAL_IDEMPOTENCY_INDEX));
    }
  });

  it("puts a signaled cross-channel search failure in planner-visible text", async () => {
    const originalGetService = runtime.getService.bind(runtime);
    runtime.getService = (() => {
      throw new Error("relationship search unavailable");
    }) as IAgentRuntime["getService"];
    try {
      const result = await crossChannelContextProvider.get(
        runtime,
        message(OWNER_ID, "what did Alex say?"),
        {
          values: {},
          data: {},
          text: "",
          crossChannelContextRequest: {
            query: "travel pickup",
            person: "Alex",
          },
        } as State,
      );

      expect(result.values?.crossChannelUnavailable).toBe(true);
      expect(result.text).toBe(CROSS_CHANNEL_CONTEXT_UNAVAILABLE_TEXT);
      expect(result.text).toContain("Do not infer that no prior message");
    } finally {
      runtime.getService = originalGetService;
    }
  });
});
