/**
 * Defines immutable managed-agent usage receipts and durable billing-run envelopes.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentComputeFunding } from "./agent-compute-funding";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export const agentBillingRecords = pgTable(
  "agent_billing_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sandbox_id: uuid("sandbox_id").notNull(),
    sandbox_status: text("sandbox_status").notNull(),
    billing_period_start: timestamp("billing_period_start", { withTimezone: true }).notNull(),
    billing_period_end: timestamp("billing_period_end", { withTimezone: true }).notNull(),
    hourly_rate: numeric("hourly_rate", { precision: 16, scale: 6 }).notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    /** Portion of the total due to the activation minimum, separate from metered rate segments. */
    minimum_charge_amount: numeric("minimum_charge_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    rate_segments: jsonb("rate_segments")
      .$type<
        Array<{
          state: string;
          ratePerHour: string;
          startedAt: string;
          endedAt: string;
          amount: string;
        }>
      >()
      .default([])
      .notNull(),
    credit_transaction_id: uuid("credit_transaction_id"),
    compute_funding_id: uuid("compute_funding_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    minimum_charge_check: check(
      "agent_billing_records_minimum_charge_check",
      sql`${table.minimum_charge_amount} >= 0 AND ${table.minimum_charge_amount} <= ${table.amount}
        AND ${table.minimum_charge_amount} <> 'NaN'::numeric`,
    ),
    compute_funding_tenant_fk: foreignKey({
      columns: [table.compute_funding_id, table.sandbox_id, table.organization_id],
      foreignColumns: [
        agentComputeFunding.id,
        agentComputeFunding.agent_id,
        agentComputeFunding.organization_id,
      ],
      name: "agent_billing_records_compute_funding_tenant_fk",
    }).onDelete("restrict"),
    compute_funding_unique: uniqueIndex("agent_billing_records_compute_funding_idx")
      .on(table.compute_funding_id)
      .where(sql`${table.compute_funding_id} IS NOT NULL`),
    funding_source_check: check(
      "agent_billing_records_funding_source_check",
      sql`num_nonnulls(${table.credit_transaction_id}, ${table.compute_funding_id}) = 1`,
    ),
    credit_transaction_tenant_fk: foreignKey({
      columns: [table.credit_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "agent_billing_records_credit_transaction_tenant_fk",
    }).onDelete("restrict"),
    tenant_period_unique: uniqueIndex("agent_billing_records_tenant_period_unique").on(
      table.organization_id,
      table.sandbox_id,
      table.billing_period_start,
    ),
    sandbox_period_end_idx: index("agent_billing_records_sandbox_period_end_idx").on(
      table.sandbox_id,
      table.billing_period_end,
    ),
    positive_period_check: check(
      "agent_billing_records_positive_period_check",
      sql`${table.billing_period_end} > ${table.billing_period_start}`,
    ),
    nonnegative_amount_check: check(
      "agent_billing_records_nonnegative_amount_check",
      sql`${table.amount} >= 0 AND ${table.hourly_rate} >= 0`,
    ),
  }),
);

export type AgentBillingRecord = InferSelectModel<typeof agentBillingRecords>;
export type NewAgentBillingRecord = InferInsertModel<typeof agentBillingRecords>;

export type AgentBillingRunTrigger = "scheduled" | "manual";
export type AgentBillingRunStatus =
  | "started"
  | "empty"
  | "succeeded"
  | "partial_failure"
  | "failed";
export type AgentBillingRunItemAction =
  | "billed"
  | "warning_sent"
  | "shutdown"
  | "skipped"
  | "error";

export interface AgentBillingRunErrorSample {
  /** Stable, low-cardinality classifier; never a provider payload or stack. */
  code: string;
  /** Bounded sanitized summary suitable for operational triage. */
  message: string;
  sandboxId?: string;
}

/**
 * Durable envelope for one logical invocation of the hourly agent biller.
 * Per-sandbox debit authority remains in `agent_billing_records`; this table
 * records whether the sweep itself ran, was empty, or only partially finished.
 */
export const agentBillingRuns = pgTable(
  "agent_billing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invocation_key: text("invocation_key").notNull(),
    trigger_kind: text("trigger_kind").$type<AgentBillingRunTrigger>().notNull(),
    schedule: text("schedule"),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status").$type<AgentBillingRunStatus>().notNull().default("started"),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    billing_cutoff_at: timestamp("billing_cutoff_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempt_count: integer("attempt_count").notNull().default(1),
    lease_token: uuid("lease_token").notNull(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    sandboxes_processed: integer("sandboxes_processed").notNull().default(0),
    sandboxes_billed: integer("sandboxes_billed").notNull().default(0),
    warnings_sent: integer("warnings_sent").notNull().default(0),
    sandboxes_shutdown: integer("sandboxes_shutdown").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    total_revenue: numeric("total_revenue", { precision: 16, scale: 6 }).notNull().default("0"),
    duration_ms: bigint("duration_ms", { mode: "number" }),
    error_samples: jsonb("error_samples")
      .$type<AgentBillingRunErrorSample[]>()
      .notNull()
      .default([]),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    invocation_unique: uniqueIndex("agent_billing_runs_invocation_key_idx").on(
      table.invocation_key,
    ),
    scheduled_at_idx: index("agent_billing_runs_scheduled_at_idx").on(table.scheduled_at),
    trigger_check: check(
      "agent_billing_runs_trigger_check",
      sql`${table.trigger_kind} IN ('scheduled', 'manual')`,
    ),
    status_check: check(
      "agent_billing_runs_status_check",
      sql`${table.status} IN ('started', 'empty', 'succeeded', 'partial_failure', 'failed')`,
    ),
    scheduled_identity_check: check(
      "agent_billing_runs_scheduled_identity_check",
      sql`(${table.trigger_kind} = 'scheduled' AND ${table.schedule} IS NOT NULL AND ${table.scheduled_at} IS NOT NULL)
        OR (${table.trigger_kind} = 'manual' AND ${table.schedule} IS NULL AND ${table.scheduled_at} IS NULL)`,
    ),
    identity_length_check: check(
      "agent_billing_runs_identity_length_check",
      sql`char_length(${table.invocation_key}) BETWEEN 1 AND 512
        AND (${table.schedule} IS NULL OR char_length(${table.schedule}) BETWEEN 1 AND 64)`,
    ),
    terminal_timestamp_check: check(
      "agent_billing_runs_terminal_timestamp_check",
      sql`(${table.status} = 'started' AND ${table.completed_at} IS NULL
          AND ${table.duration_ms} IS NULL AND ${table.lease_expires_at} IS NOT NULL
          AND ${table.lease_expires_at} > ${table.updated_at})
        OR (${table.status} <> 'started' AND ${table.completed_at} IS NOT NULL
          AND ${table.completed_at} >= ${table.started_at} AND ${table.duration_ms} IS NOT NULL
          AND ${table.duration_ms} = floor(extract(epoch from
            (${table.completed_at} - ${table.started_at})) * 1000)::bigint
          AND ${table.lease_expires_at} IS NULL)`,
    ),
    nonnegative_counters_check: check(
      "agent_billing_runs_nonnegative_counters_check",
      sql`${table.sandboxes_processed} >= 0
        AND ${table.attempt_count} >= 1
        AND ${table.sandboxes_billed} >= 0
        AND ${table.warnings_sent} >= 0
        AND ${table.sandboxes_shutdown} >= 0
        AND ${table.errors} >= 0
        AND ${table.total_revenue} >= 0
        AND (${table.duration_ms} IS NULL OR ${table.duration_ms} >= 0)`,
    ),
    outcome_counters_check: check(
      "agent_billing_runs_outcome_counters_check",
      sql`${table.sandboxes_billed} + ${table.warnings_sent} + ${table.sandboxes_shutdown}
          <= ${table.sandboxes_processed}
        AND (${table.status} <> 'empty' OR (
          ${table.sandboxes_processed} = 0 AND ${table.sandboxes_billed} = 0
          AND ${table.warnings_sent} = 0 AND ${table.sandboxes_shutdown} = 0
          AND ${table.errors} = 0 AND ${table.total_revenue} = 0
        ))
        AND (${table.status} <> 'succeeded' OR (
          ${table.sandboxes_processed} > 0 AND ${table.errors} = 0
        ))
        AND (${table.status} <> 'partial_failure' OR (
          ${table.errors} > 0 AND ${table.sandboxes_processed} > ${table.errors}
          AND ${table.sandboxes_billed} + ${table.warnings_sent}
            + ${table.sandboxes_shutdown} + ${table.errors}
            <= ${table.sandboxes_processed}
        ))
        AND (${table.status} <> 'failed' OR ${table.errors} > 0)`,
    ),
    error_samples_check: check(
      "agent_billing_runs_error_samples_check",
      sql`jsonb_typeof(${table.error_samples}) = 'array'
        AND jsonb_array_length(${table.error_samples}) <= 20`,
    ),
  }),
);

export type AgentBillingRun = InferSelectModel<typeof agentBillingRuns>;
export type NewAgentBillingRun = InferInsertModel<typeof agentBillingRuns>;

/**
 * One immutable terminal outcome per sandbox within a run. Financial outcomes
 * are inserted in the same transaction as their debit, making this table the
 * recovery source of truth after a worker crashes before aggregate completion.
 */
export const agentBillingRunItems = pgTable(
  "agent_billing_run_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    run_id: uuid("run_id")
      .notNull()
      .references(() => agentBillingRuns.id, { onDelete: "cascade" }),
    sandbox_id: uuid("sandbox_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_name: text("agent_name").notNull(),
    action: text("action").$type<AgentBillingRunItemAction>().notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull().default("0"),
    new_balance: numeric("new_balance", { precision: 16, scale: 6 }),
    transaction_id: text("transaction_id"),
    detail_code: text("detail_code"),
    detail_message: text("detail_message"),
    completed_at: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    run_sandbox_unique: uniqueIndex("agent_billing_run_items_run_sandbox_idx").on(
      table.run_id,
      table.sandbox_id,
    ),
    run_idx: index("agent_billing_run_items_run_idx").on(table.run_id),
    action_check: check(
      "agent_billing_run_items_action_check",
      sql`${table.action} IN ('billed', 'warning_sent', 'shutdown', 'skipped', 'error')`,
    ),
    financial_evidence_check: check(
      "agent_billing_run_items_financial_evidence_check",
      sql`(${table.action} = 'billed' AND ${table.transaction_id} IS NOT NULL
          AND ${table.new_balance} IS NOT NULL AND ${table.amount} >= 0)
        OR (${table.action} <> 'billed' AND ${table.transaction_id} IS NULL
          AND ${table.new_balance} IS NULL AND ${table.amount} = 0)`,
    ),
    detail_bounds_check: check(
      "agent_billing_run_items_detail_bounds_check",
      sql`(${table.detail_code} IS NULL OR char_length(${table.detail_code}) BETWEEN 1 AND 64)
        AND (${table.detail_message} IS NULL OR char_length(${table.detail_message}) BETWEEN 1 AND 240)
        AND (${table.action} <> 'error'
          OR (${table.detail_code} IS NOT NULL AND ${table.detail_message} IS NOT NULL))`,
    ),
  }),
);

export type AgentBillingRunItem = InferSelectModel<typeof agentBillingRunItems>;
export type NewAgentBillingRunItem = InferInsertModel<typeof agentBillingRunItems>;
