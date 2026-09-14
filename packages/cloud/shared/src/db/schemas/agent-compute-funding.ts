/** Binds Dedicated compute intervals to reserved funds and exact provider instances. */

import { type InferSelectModel, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentComputeSubjects } from "./agent-compute-subjects";
import { billingFundingReservations } from "./billing-funding-reservations";

export const agentComputeFunding = pgTable(
  "agent_compute_funding",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    funding_reservation_id: uuid("funding_reservation_id").notNull(),
    previous_funding_id: uuid("previous_funding_id"),
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    period_end: timestamp("period_end", { withTimezone: true }).notNull(),
    hourly_rate: numeric("hourly_rate", { precision: 16, scale: 6 }).notNull(),
    /** Unsettled activation minimum carried through renewals; legacy windows retain zero. */
    minimum_charge_remaining: numeric("minimum_charge_remaining", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    provider_node_id: text("provider_node_id"),
    provider_container_id: text("provider_container_id"),
    provider_bound_at: timestamp("provider_bound_at", { withTimezone: true }),
    host_lease_confirmed_at: timestamp("host_lease_confirmed_at", { withTimezone: true }),
    /** Completed application provisioning for this exact container; inherited only on retained resume/renewal. */
    runtime_ready_at: timestamp("runtime_ready_at", { withTimezone: true }),
    provider_stopped_at: timestamp("provider_stopped_at", { withTimezone: true }),
    provider_stop_receipt: jsonb("provider_stop_receipt").$type<{
      containerId: string;
      fundingId: string;
      bootId: string;
      stoppedAtMs: number;
    }>(),
    /** Fresh capture committed with this exact stop; required before retained compute can be removed. */
    retirement_backup_id: uuid("retirement_backup_id"),
    settled_through: timestamp("settled_through", { withTimezone: true }),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    minimum_charge_check: check(
      "agent_compute_funding_minimum_charge_check",
      sql`${table.minimum_charge_remaining} >= 0 AND ${table.minimum_charge_remaining} <> 'NaN'::numeric`,
    ),
    retirement_backup_check: check(
      "agent_compute_funding_retirement_backup_check",
      sql`${table.retirement_backup_id} IS NULL OR (${table.settled_at} IS NOT NULL AND ${table.provider_stopped_at} IS NOT NULL)`,
    ),
    stop_receipt_check: check(
      "agent_compute_funding_stop_receipt_check",
      sql`num_nonnulls(${table.provider_stopped_at}, ${table.provider_stop_receipt}) IN (0, 2)
        AND (${table.provider_stopped_at} IS NULL OR (${table.settled_at} IS NOT NULL
          AND jsonb_typeof(${table.provider_stop_receipt}) = 'object'
          AND ((${table.provider_stop_receipt}->>'fundingId' = ${table.id}::text
            AND ${table.provider_stop_receipt}->>'containerId' = ${table.provider_container_id}
            AND jsonb_typeof(${table.provider_stop_receipt}->'stoppedAtMs') = 'number'
            AND jsonb_typeof(${table.provider_stop_receipt}->'bootId') = 'string') IS TRUE)))`,
    ),
    identity_unique: unique("agent_compute_funding_identity_unique").on(
      table.id,
      table.agent_id,
      table.organization_id,
    ),
    predecessor_fk: foreignKey({
      columns: [table.previous_funding_id, table.agent_id, table.organization_id],
      foreignColumns: [table.id, table.agent_id, table.organization_id],
      name: "agent_compute_funding_predecessor_fk",
    }).onDelete("restrict"),
    predecessor_unique: uniqueIndex("agent_compute_funding_predecessor_idx").on(
      table.previous_funding_id,
    ),
    agent_tenant_fk: foreignKey({
      columns: [table.agent_id, table.organization_id],
      foreignColumns: [agentComputeSubjects.agent_id, agentComputeSubjects.organization_id],
      name: "agent_compute_funding_agent_tenant_fk",
    }).onDelete("restrict"),
    reservation_tenant_fk: foreignKey({
      columns: [table.funding_reservation_id, table.organization_id],
      foreignColumns: [billingFundingReservations.id, billingFundingReservations.organization_id],
      name: "agent_compute_funding_reservation_tenant_fk",
    }).onDelete("restrict"),
    reservation_unique: uniqueIndex("agent_compute_funding_reservation_idx").on(
      table.funding_reservation_id,
    ),
    open_agent_unique: uniqueIndex("agent_compute_funding_open_agent_idx")
      .on(table.agent_id)
      .where(sql`${table.settled_at} IS NULL`),
    expiry_idx: index("agent_compute_funding_expiry_idx")
      .on(table.period_end)
      .where(sql`${table.settled_at} IS NULL`),
    period_check: check(
      "agent_compute_funding_period_check",
      sql`${table.period_end} > ${table.period_start} AND ${table.hourly_rate} > 0
        AND ${table.hourly_rate} <> 'NaN'::numeric`,
    ),
    provider_check: check(
      "agent_compute_funding_provider_check",
      sql`num_nonnulls(${table.provider_node_id}, ${table.provider_container_id}, ${table.provider_bound_at}) IN (0, 3)
        AND (${table.provider_container_id} IS NULL OR ${table.provider_container_id} ~ '^[0-9a-f]{64}$')
        AND (${table.provider_node_id} IS NULL OR length(${table.provider_node_id}) > 0)`,
    ),
    host_confirmation_check: check(
      "agent_compute_funding_host_confirmation_check",
      sql`${table.host_lease_confirmed_at} IS NULL OR
        (${table.provider_bound_at} IS NOT NULL
          AND ${table.host_lease_confirmed_at} >= ${table.provider_bound_at}
          AND ${table.host_lease_confirmed_at} < ${table.period_end})`,
    ),
    settlement_check: check(
      "agent_compute_funding_settlement_check",
      sql`(${table.settled_at} IS NULL AND ${table.settled_through} IS NULL)
        OR (${table.settled_at} IS NOT NULL AND ${table.settled_through} IS NOT NULL
          AND ${table.settled_through} BETWEEN ${table.period_start} AND ${table.period_end})`,
    ),
  }),
);

export type AgentComputeFunding = InferSelectModel<typeof agentComputeFunding>;
