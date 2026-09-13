/**
 * Applies family workspace admission around the scheduling-owned SQL stores.
 * Mutations inspect both persisted and proposed task metadata under the same
 * locks as the write, so removing a family marker cannot escape deletion.
 * Canonical stores retain ownership of task rows, receipts, and history.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
  type ScheduledTask,
  type ScheduledTaskLogStore,
  type ScheduledTaskStore,
  type SchedulingSqlExecutor,
} from "@elizaos/plugin-scheduling";
import { executeRawSql, executeRawSqlTx } from "../sql.js";
import {
  type FamilySchedulingReferences,
  isFamilyScheduledTask,
  withFamilySchedulingReferences,
} from "./scheduled-identity.js";
import { assertFamilyWorkspaceActive } from "./workspace-operation-store.js";

interface FamilySchedulingStores {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
}

export function createFamilySchedulingStores(
  runtime: IAgentRuntime,
  agentId: string,
): FamilySchedulingStores {
  const bind = (executeSql: SchedulingSqlExecutor): FamilySchedulingStores => ({
    store: createSchedulingSqlScheduledTaskStore({ agentId, executeSql }),
    logStore: createSchedulingSqlScheduledTaskLogStore({ agentId, executeSql }),
  });
  const base = bind((statement) => executeRawSql(runtime, statement));

  async function transaction<T>(
    operation: (
      stores: FamilySchedulingStores,
      state: "active" | "revoking" | "deleted",
      references: FamilySchedulingReferences,
    ) => Promise<T>,
  ): Promise<T> {
    return withFamilySchedulingReferences(
      runtime,
      agentId,
      [],
      async (tx, state, references) =>
        operation(
          bind((statement) => executeRawSqlTx(tx, statement)),
          state,
          references,
        ),
    );
  }

  function mutate<T>(
    taskId: string,
    proposed: ScheduledTask | null,
    operation: (stores: FamilySchedulingStores) => Promise<T>,
    requireExisting = false,
  ): Promise<T> {
    return transaction(async (stores, state, references) => {
      const current = await stores.store.get(taskId);
      if (requireExisting && !current)
        throw new ElizaError(
          "[FamilyScheduling] The task no longer exists; history cannot be appended",
          { code: "FAMILY_SCHEDULING_TARGET_UNAVAILABLE", context: { taskId } },
        );
      if (
        isFamilyScheduledTask(current, references) ||
        isFamilyScheduledTask(proposed, references)
      )
        assertFamilyWorkspaceActive(state);
      return operation(stores);
    });
  }

  return {
    store: {
      ...base.store,
      upsert(task, options) {
        return mutate(task.taskId, task, (stores) =>
          stores.store.upsert(task, options),
        );
      },
      upsertIfStatus(task, options) {
        return mutate(task.taskId, task, (stores) =>
          stores.store.upsertIfStatus(task, options),
        );
      },
      claimForFire(args) {
        return mutate(args.taskId, null, (stores) =>
          stores.store.claimForFire(args),
        );
      },
      commitApply(args) {
        return mutate(args.task.taskId, args.task, (stores) =>
          stores.store.commitApply(args),
        );
      },
      reserveApplyIntent(args) {
        return mutate(args.task.taskId, args.task, (stores) =>
          stores.store.reserveApplyIntent(args),
        );
      },
      delete(taskId) {
        return mutate(taskId, null, (stores) => stores.store.delete(taskId));
      },
    },
    logStore: {
      ...base.logStore,
      append(entry) {
        if (entry.agentId !== agentId)
          throw new ElizaError(
            "[FamilyScheduling] History belongs to a different agent",
            { code: "FAMILY_SCHEDULING_AGENT_MISMATCH" },
          );
        return mutate(
          entry.taskId,
          null,
          (stores) => stores.logStore.append(entry),
          true,
        );
      },
      rollupOlderThan(args) {
        return transaction(async (stores, state, references) => {
          if (state === "active") return stores.logStore.rollupOlderThan(args);
          const eligible = (await stores.store.list())
            .filter(
              (task) =>
                !isFamilyScheduledTask(task, references) &&
                (args.taskIds === undefined ||
                  args.taskIds.includes(task.taskId)),
            )
            .map((task) => task.taskId);
          return stores.logStore.rollupOlderThan({
            ...args,
            taskIds: eligible,
          });
        });
      },
    },
  };
}
