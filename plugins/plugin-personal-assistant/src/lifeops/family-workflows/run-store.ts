/** Initializes monthly workflow history without running a workflow or contacting a provider. */
import type { IAgentRuntime } from "@elizaos/core";
import { executeRawSql } from "../sql.js";

const RUN_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_workflow_runs (
    agent_id TEXT NOT NULL, period_key TEXT NOT NULL, run_id TEXT NOT NULL,
    state TEXT NOT NULL, trigger_kind TEXT NOT NULL, lease_token TEXT,
    lease_expires_at TEXT, result_json TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, period_key)
  )`,
] as const;

export async function ensureFamilyWorkflowRunStore(
  runtime: IAgentRuntime,
): Promise<void> {
  for (const statement of RUN_SCHEMA) await executeRawSql(runtime, statement);
}
