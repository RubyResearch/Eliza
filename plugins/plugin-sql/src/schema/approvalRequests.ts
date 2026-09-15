/**
 * Persistent backing store for the LifeOps human-in-the-loop approval queue.
 *
 * Owned by `plugins/plugin-personal-assistant` (see `src/lifeops/approval-queue.types.ts`),
 * but lives in plugin-sql so the runtime migrator picks it up automatically
 * for both PostgreSQL and PGlite deployments.
 *
 * Migration safety: this table evolves additively. Fresh databases receive
 * the full shape, while existing databases gain execution metadata through
 * forward-only migrations.
 *
 * State, action, channel, resolved_by, resolution_reason, and resolved_at are
 * intentionally text/timestamp without a CHECK constraint — the application
 * layer is the single source of truth for the state machine and the closed
 * action/channel enums (Commandment 7).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const approvalRequestTable = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lifecycle state. See `ApprovalRequestState` in app-lifeops. */
    state: text("state").notNull(),
    /** Agent or service that enqueued the request. */
    requestedBy: text("requested_by").notNull(),
    /** Owner whose approval is required. */
    subjectUserId: text("subject_user_id").notNull(),
    /** Control revision at insertion; null identifies approvals predating the fence. */
    admissionRevision: integer("admission_revision"),
    /** Closed enum from `ApprovalAction`. */
    action: text("action").notNull(),
    /** Discriminated union from `ApprovalPayload`. */
    payload: jsonb("payload").notNull(),
    /** Closed enum from `ApprovalChannel`. */
    channel: text("channel").notNull(),
    /** Required justification for the request. */
    reason: text("reason").notNull(),
    /**
     * Stable logical-operation key. Callers reuse the existing row when a
     * retried enqueue presents the same key, so concurrent draft creation
     * cannot produce two independently approvable copies of one side effect.
     */
    idempotencyKey: text("idempotency_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null until the request leaves `pending`. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Null until resolved; resolver identity. */
    resolvedBy: text("resolved_by"),
    /** Null until resolved; human-readable resolution note. */
    resolutionReason: text("resolution_reason"),
    /** Durable execution attempt for at-most-once external dispatch. */
    executionAttemptId: uuid("execution_attempt_id"),
    executionProvider: text("execution_provider"),
    providerIdempotencyKey: text("provider_idempotency_key"),
    executionClaimedAt: timestamp("execution_claimed_at", {
      withTimezone: true,
    }),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    providerReceipt: jsonb("provider_receipt"),
    executionError: text("execution_error"),
    reconciliationResolvedAt: timestamp("reconciliation_resolved_at", {
      withTimezone: true,
    }),
    reconciliationResolvedBy: text("reconciliation_resolved_by"),
    reconciliationReason: text("reconciliation_reason"),
    /** Owning agent (cascade-deletes when the agent is removed). */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index("approval_requests_subject_state_idx").on(table.subjectUserId, table.state),
    index("approval_requests_agent_state_idx").on(table.agentId, table.state),
    index("approval_requests_subject_id_idx").on(table.agentId, table.subjectUserId, table.id),
    index("approval_requests_state_expires_idx").on(table.state, table.expiresAt),
    uniqueIndex("approval_requests_agent_idempotency_uidx")
      .on(table.agentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);
