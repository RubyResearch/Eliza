/**
 * Holds family deletion admission through the canonical scheduler's complete
 * execution attempt, including final receipt writes. Uncertain completion keeps
 * the durable claim for reconciliation rather than assuming a dispatcher stopped.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  createSchedulingSqlScheduledTaskStore,
  type ScheduledTask,
  type ScheduledTaskFireResult,
} from "@elizaos/plugin-scheduling";
import { executeRawSqlTx } from "../sql.js";
import {
  isFamilyScheduledTask,
  withFamilySchedulingReferences,
} from "./scheduled-identity.js";
import {
  beginFamilyWorkspaceOperationTx,
  settleFamilyWorkspaceOperation,
} from "./workspace-operation-store.js";

export async function withFamilyScheduledExecution(
  runtime: IAgentRuntime,
  task: ScheduledTask,
  execute: () => Promise<ScheduledTaskFireResult>,
  agentId = runtime.agentId,
): Promise<ScheduledTaskFireResult> {
  const operationId = await withFamilySchedulingReferences(
    runtime,
    agentId,
    ["app_lifeops.life_family_workspace_operations"],
    async (tx, _state, references) => {
      const store = createSchedulingSqlScheduledTaskStore({
        agentId,
        executeSql: (statement) => executeRawSqlTx(tx, statement),
      });
      const current = await store.get(task.taskId);
      if (
        !isFamilyScheduledTask(task, references) &&
        !isFamilyScheduledTask(current, references)
      )
        return null;
      return beginFamilyWorkspaceOperationTx(tx, agentId, {
        kind: "family-scheduled-execution",
        taskId: task.taskId,
      });
    },
  );
  if (operationId === null) return execute();
  try {
    const result = await execute();
    await settleFamilyWorkspaceOperation(runtime, operationId, agentId);
    return result;
  } catch (cause) {
    // error-policy:J2 Dispatch or persistence may have committed before acknowledgement failed.
    const error = new ElizaError(
      "[FamilyWorkspace] Reconcile the scheduled execution before deletion",
      {
        code: "FAMILY_OPERATION_RECONCILIATION_REQUIRED",
        context: { operationId, taskId: task.taskId },
        cause,
      },
    );
    runtime.reportError("FamilyWorkspace.scheduledExecution", error);
    // Keep typed domain failures actionable while the diagnostic retains the unsettled operation.
    if (cause instanceof ElizaError) throw cause;
    throw error;
  }
}
