/**
 * Resolves family scheduler ownership from typed task metadata and canonical
 * approval or grant records. Snapshot review and mutation admission share these
 * predicates, including approvals whose domain-link acknowledgement was lost.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  ScheduledTask,
  SchedulingSqlExecutor,
} from "@elizaos/plugin-scheduling";
import { HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID } from "../household/types.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
} from "../sql.js";
import {
  type FamilyWorkspaceState,
  withFamilyWorkspaceStateTransaction,
} from "./workspace-operation-store.js";

export const FAMILY_SCHEDULED_TASK_TABLE =
  "app_scheduling.life_scheduled_tasks";
export const FAMILY_SCHEDULED_LOG_TABLE =
  "app_scheduling.life_scheduled_task_log";
const warningTable = "app_lifeops.life_household_grant_expiry_warning_claims";
const packetApprovalTable = "app_lifeops.life_family_packet_approvals";
const householdApprovalTable = "app_lifeops.life_household_proposal_approvals";
const approvalTable = "approval_requests";
export const FAMILY_SCHEDULING_REFERENCE_TABLES = [
  warningTable,
  packetApprovalTable,
  householdApprovalTable,
  approvalTable,
] as const;

/** SQL expressions here are internal call-site expressions, never request input. */
export function familyApprovalIdsSql(
  agentSql: string,
  available: ReadonlySet<string> = new Set(FAMILY_SCHEDULING_REFERENCE_TABLES),
): string {
  const selections: string[] = [];
  if (available.has(approvalTable))
    selections.push(
      `SELECT id::text AS approval_id FROM ${approvalTable} WHERE agent_id::text=${agentSql} AND (payload ? 'familyPacketId' OR payload->>'workflowId'=${sqlQuote(HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID)})`,
    );
  if (available.has(packetApprovalTable))
    selections.push(
      `SELECT approval_id FROM ${packetApprovalTable} WHERE agent_id=${agentSql}`,
    );
  if (available.has(householdApprovalTable))
    selections.push(
      `SELECT approval_request_id AS approval_id FROM ${householdApprovalTable} WHERE agent_id=${agentSql}`,
    );
  return selections.length
    ? selections.join(" UNION ")
    : "SELECT NULL::text AS approval_id WHERE FALSE";
}

export function familyScheduledTaskPredicate(agentSql: string): string {
  return `(metadata_json::jsonb->>'systemOperation'='family.monthlyCoordination' OR metadata_json::jsonb ? 'householdGrantExpiryWarning' OR id IN (SELECT scheduled_task_id FROM ${warningTable} WHERE agent_id=${agentSql}) OR metadata_json::jsonb->>'approvalRequestId' IN (${familyApprovalIdsSql(agentSql)}))`;
}

export interface FamilySchedulingReferences {
  warningTaskIds: ReadonlySet<string>;
  approvalIds: ReadonlySet<string>;
}

export function isFamilyScheduledTask(
  task: ScheduledTask | null | undefined,
  references: FamilySchedulingReferences,
): boolean {
  if (!task) return false;
  const approvalId = task.metadata?.approvalRequestId;
  return (
    task.metadata?.systemOperation === "family.monthlyCoordination" ||
    task.metadata?.householdGrantExpiryWarning !== undefined ||
    references.warningTaskIds.has(task.taskId) ||
    (typeof approvalId === "string" && references.approvalIds.has(approvalId))
  );
}

async function availableReferenceTables(
  execute: SchedulingSqlExecutor,
): Promise<ReadonlySet<string>> {
  const rows = await execute(
    `SELECT name, to_regclass(name) IS NOT NULL AS available FROM unnest(ARRAY[${FAMILY_SCHEDULING_REFERENCE_TABLES.map(sqlQuote).join(",")}]) AS name`,
  );
  const seen = new Set<string>();
  const available = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.name !== "string" ||
      !FAMILY_SCHEDULING_REFERENCE_TABLES.some((table) => table === row.name) ||
      seen.has(row.name) ||
      typeof row.available !== "boolean"
    )
      throw new ElizaError(
        "[FamilyScheduling] Reference-store availability is unknown",
        { code: "FAMILY_SCHEDULING_STORE_UNAVAILABLE" },
      );
    seen.add(row.name);
    if (row.available) available.add(row.name);
  }
  if (seen.size !== FAMILY_SCHEDULING_REFERENCE_TABLES.length)
    throw new ElizaError(
      "[FamilyScheduling] Reference-store availability is incomplete",
      { code: "FAMILY_SCHEDULING_STORE_UNAVAILABLE" },
    );
  return available;
}

async function readReferences(
  execute: SchedulingSqlExecutor,
  agentId: string,
  available: ReadonlySet<string>,
): Promise<FamilySchedulingReferences> {
  const agent = sqlQuote(agentId);
  const warningRows = available.has(warningTable)
    ? await execute(
        `SELECT scheduled_task_id AS id FROM ${warningTable} WHERE agent_id=${agent} AND scheduled_task_id IS NOT NULL`,
      )
    : [];
  const approvals = await execute(familyApprovalIdsSql(agent, available));
  const identities = (rows: Record<string, unknown>[], field: string) =>
    new Set(
      rows.map((row) => {
        const value = row[field];
        if (typeof value !== "string" || !value)
          throw new ElizaError(
            "[FamilyScheduling] Invalid persisted domain identity",
            { code: "FAMILY_SCHEDULING_INVALID_IDENTITY" },
          );
        return value;
      }),
    );
  return {
    warningTaskIds: identities(warningRows, "id"),
    approvalIds: identities(approvals, "approval_id"),
  };
}

/** Hold reference and task rows stable until the supplied mutation commits. */
export async function withFamilySchedulingReferences<T>(
  runtime: IAgentRuntime,
  agentId: string,
  extraTables: readonly string[],
  operation: (
    tx: TransactionalDb,
    state: FamilyWorkspaceState,
    references: FamilySchedulingReferences,
  ) => Promise<T>,
): Promise<T> {
  const available = await availableReferenceTables((statement) =>
    executeRawSql(runtime, statement),
  );
  return withFamilyWorkspaceStateTransaction(
    runtime,
    [
      FAMILY_SCHEDULED_TASK_TABLE,
      FAMILY_SCHEDULED_LOG_TABLE,
      ...available,
      ...extraTables,
    ],
    async (tx, state) => {
      const references = await readReferences(
        (statement) => executeRawSqlTx(tx, statement),
        agentId,
        available,
      );
      return operation(tx, state, references);
    },
    { agentId, lockMode: "SHARE ROW EXCLUSIVE" },
  );
}
