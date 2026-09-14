/** Retains tenant billing identity after the operational agent has been deleted. */
import { pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const agentComputeSubjects = pgTable(
  "agent_compute_subjects",
  {
    agent_id: uuid("agent_id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retired_at: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => ({
    tenant_unique: unique("agent_compute_subjects_tenant_unique").on(
      table.agent_id,
      table.organization_id,
    ),
  }),
);
