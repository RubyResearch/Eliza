/** Persists owner-scoped dispatch admission across account handoffs and process restarts. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const approvalDispatchControlTable = pgTable(
  "approval_dispatch_controls",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id").notNull(),
    revision: integer("revision").notNull().default(0),
    paused: boolean("paused").notNull().default(false),
    operationId: text("operation_id"),
    googleBindingRequired: boolean("google_binding_required").notNull().default(false),
    retiredGoogleGrants: jsonb("retired_google_grants").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.subjectUserId] })]
);
