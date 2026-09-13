/**
 * Post-dispatch persistence races between the fire path and user verbs.
 *
 * Harness is deterministic: the in-memory store backs a real runner and a
 * controllable dispatcher gates the mid-flight window, so each test proves
 * the CAS-guarded persist keeps a concurrently applied verb authoritative
 * instead of letting the stale post-dispatch snapshot revert it. The
 * SQL-store guard behavior runs against real PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { describe, expect, it, vi } from "vitest";

import type { DispatchResult } from "../dispatch-types.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import { migrateSchedulingTables } from "./migration.js";

function carveOutDatabase(pg: PGlite): CarveOutDatabase {
  const execute = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  return {
    execute,
    transaction: (operation) =>
      pg.transaction((transaction) =>
        operation(
          async (statement) =>
            (await transaction.query<Record<string, unknown>>(statement)).rows,
        ),
      ),
  };
}

import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerHandle,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import { createSchedulingSqlScheduledTaskStore } from "./store.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
} from "./types.js";

type RawSqlQuery = { queryChunks: Array<{ value?: unknown }> };

function rawQueryText(query: RawSqlQuery): string {
  return String(query.queryChunks.map((chunk) => chunk.value ?? "").join(""));
}

interface RaceHarness {
  runner: ScheduledTaskRunnerHandle;
  store: ReturnType<typeof createInMemoryScheduledTaskStore>;
  logStore: ReturnType<typeof createInMemoryScheduledTaskLogStore>;
  releaseDispatch(): void;
  settleDispatch(result: DispatchResult): void;
  failDispatch(error: Error): void;
}

function makeRaceHarness(
  executionBoundary?: ScheduledTaskRunnerDeps["executionBoundary"],
): RaceHarness {
  const ownerFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "07:00", end: "10:00" },
  };
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();

  let gate: { resolve(result: DispatchResult | Error): void } | null = null;

  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    ...(executionBoundary ? { executionBoundary } : {}),
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ownerFacts,
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false } as ActivitySignalBusView,
    subjectStore: { wasUpdatedSince: () => false } as SubjectStoreView,
    dispatcher: {
      dispatch: async () =>
        new Promise<DispatchResult>((resolve, reject) => {
          gate = {
            resolve: (result) =>
              result instanceof Error ? reject(result) : resolve(result),
          };
        }),
    },
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date("2026-05-09T12:00:00.000Z"),
  });

  return {
    runner,
    store,
    logStore,
    settleDispatch: (result) => gate?.resolve(result),
    failDispatch: (error) => gate?.resolve(error),
    releaseDispatch: () => gate?.resolve({ ok: true, channelKey: "in_app" }),
  };
}

const baseInput = {
  kind: "reminder" as const,
  promptInstructions: "remind me",
  trigger: { kind: "manual" as const },
  priority: "medium" as const,
  respectsGlobalPause: true,
  source: "user_chat" as const,
  createdBy: "tester",
  ownerVisible: true,
};

describe("host execution admission", () => {
  it("rejects before claiming a task when its host denies admission", async () => {
    const denied = new Error("workspace fenced");
    const h = makeRaceHarness(async () => {
      throw denied;
    });
    const task = await h.runner.schedule(baseInput);
    await expect(h.runner.fireWithResult(task.taskId)).rejects.toBe(denied);
    expect((await h.store.get(task.taskId))?.state.status).toBe("scheduled");
  });

  it("retries admission when task metadata changes before the fire claim", async () => {
    let h!: RaceHarness;
    h = makeRaceHarness(async (task, execute) => {
      await h.store.upsert({
        ...task,
        metadata: { systemOperation: "family.monthlyCoordination" },
      });
      return execute();
    });
    const task = await h.runner.schedule(baseInput);
    const firing = h.runner.fireWithResult(task.taskId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseDispatch();
    expect((await firing).kind).toBe("raced");
    expect((await h.store.get(task.taskId))?.state.status).toBe("scheduled");
  });

  it("keeps host admission until the dispatch result is persisted", async () => {
    let admitted = false;
    const h = makeRaceHarness(async (_task, execute) => {
      admitted = true;
      try {
        return await execute();
      } finally {
        admitted = false;
      }
    });
    const task = await h.runner.schedule(baseInput);
    const original = h.store.upsertIfStatus.bind(h.store);
    let entered!: () => void;
    let release!: () => void;
    const enteredPersist = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumePersist = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.store.upsertIfStatus = async (next, options) => {
      if (next.metadata?.lastDispatchResult) {
        entered();
        await resumePersist;
      }
      return original(next, options);
    };
    const firing = h.runner.fireWithResult(task.taskId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseDispatch();
    try {
      await Promise.race([
        enteredPersist,
        firing.then(() => {
          throw new Error("Execution bypassed final persistence");
        }),
      ]);
      expect(admitted).toBe(true);
      expect(
        (await h.store.get(task.taskId))?.metadata?.lastDispatchResult,
      ).toBeUndefined();
    } finally {
      release();
    }
    expect((await firing).kind).toBe("fired");
    expect(
      (await h.store.get(task.taskId))?.metadata?.lastDispatchResult,
    ).toMatchObject({ ok: true });
    expect(admitted).toBe(false);
  });
});

describe("post-dispatch persist vs concurrent user verbs (in-memory)", () => {
  it("keeps a complete that lands while the dispatch is in flight", async () => {
    const h = makeRaceHarness();
    const task = await h.runner.schedule(baseInput);

    const firePromise = h.runner.fireWithResult(task.taskId);
    await new Promise((r) => setTimeout(r, 0));

    const completed = await h.runner.apply(task.taskId, "complete");
    expect(completed.state.status).toBe("completed");

    h.releaseDispatch();
    const fireResult = await firePromise;

    const finalRow = await h.store.get(task.taskId);
    expect(finalRow?.state.status).toBe("completed");
    expect(
      fireResult.kind === "fired" ? fireResult.task.state.status : null,
    ).toBe("completed");
  });

  it("does not overwrite a mid-flight complete when the dispatcher throws", async () => {
    const h = makeRaceHarness();
    const task = await h.runner.schedule(baseInput);

    const firePromise = h.runner.fireWithResult(task.taskId);
    await new Promise((r) => setTimeout(r, 0));

    await h.runner.apply(task.taskId, "complete");

    h.failDispatch(new Error("channel exploded"));
    const fireResult = await firePromise;

    expect(fireResult.kind).toBe("raced");
    const finalRow = await h.store.get(task.taskId);
    expect(finalRow?.state.status).toBe("completed");

    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(log.map((entry) => entry.transition)).not.toContain("failed");
  });

  it("does not park a mid-flight-completed task back into scheduled on retryable failure", async () => {
    const h = makeRaceHarness();
    const task = await h.runner.schedule(baseInput);

    const firePromise = h.runner.fireWithResult(task.taskId);
    await new Promise((r) => setTimeout(r, 0));

    await h.runner.apply(task.taskId, "complete");

    h.settleDispatch({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    });
    const fireResult = await firePromise;

    expect(fireResult.kind).toBe("raced");
    const finalRow = await h.store.get(task.taskId);
    expect(finalRow?.state.status).toBe("completed");

    const log = await h.logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(log.map((entry) => entry.transition)).not.toContain(
      "dispatch_retried",
    );
  });

  it("still persists dispatch metadata on the uncontended happy path", async () => {
    const h = makeRaceHarness();
    const task = await h.runner.schedule(baseInput);

    const firePromise = h.runner.fireWithResult(task.taskId);
    await new Promise((r) => setTimeout(r, 0));
    h.settleDispatch({ ok: true, channelKey: "in_app", messageId: "m1" });
    const fireResult = await firePromise;

    expect(fireResult.kind).toBe("fired");
    const finalRow = await h.store.get(task.taskId);
    expect(finalRow?.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: "m1",
    });
  });
});

describe("upsertIfStatus guard (SQL store, PGlite)", () => {
  it("applies only while the stored status still matches", async () => {
    const pg = new PGlite();
    try {
      await migrateSchedulingTables(carveOutDatabase(pg));
      const runtime = {
        agentId: "agent-guard",
        adapter: {
          db: {
            execute: (query: RawSqlQuery) => pg.query(rawQueryText(query)),
          },
        },
        reportError: vi.fn(),
      } as unknown as IAgentRuntime;
      const store = createSchedulingSqlScheduledTaskStore({
        runtime,
        agentId: runtime.agentId,
      });
      const scheduled = {
        taskId: "guard-task-1",
        ...baseInput,
        trigger: { kind: "once" as const, atIso: "2026-05-09T13:00:00.000Z" },
        state: { status: "scheduled" as const, followupCount: 0 },
      };
      await store.upsert(scheduled, { nextFireAtIso: null });

      // Claim-shaped write: the guard matches the stored `scheduled` status
      // and the row flips to `fired`.
      const firedSnapshot = {
        ...scheduled,
        state: {
          status: "fired" as const,
          followupCount: 0,
          firedAt: "2026-05-09T12:00:00.000Z",
        },
      } as unknown as ScheduledTask;
      expect(
        await store.upsertIfStatus(firedSnapshot, {
          nextFireAtIso: null,
          expectedStatus: "scheduled",
        }),
      ).toBe(true);

      // A concurrent user verb settles the row...
      const claimedRow = await store.get("guard-task-1");
      if (!claimedRow) throw new Error("claim write vanished");
      expect(claimedRow.state.status).toBe("fired");
      const completedRow = {
        ...claimedRow,
        state: { ...claimedRow.state, status: "completed" as const },
      } as ScheduledTask;
      await store.upsert(completedRow, { nextFireAtIso: null });

      // ...and the stale post-dispatch snapshot must lose the CAS.
      expect(
        await store.upsertIfStatus(firedSnapshot, {
          nextFireAtIso: null,
          expectedStatus: "fired",
        }),
      ).toBe(false);
      const after = await store.get("guard-task-1");
      expect(after?.state.status).toBe("completed");
    } finally {
      await pg.close();
    }
  }, 15_000);

  it("claims only the task metadata that the host actually admitted", async () => {
    const pg = new PGlite();
    try {
      await migrateSchedulingTables(carveOutDatabase(pg));
      const store = createSchedulingSqlScheduledTaskStore({
        agentId: "agent-admission",
        executeSql: async (statement) =>
          (await pg.query<Record<string, unknown>>(statement)).rows,
      });
      const task: ScheduledTask = {
        ...baseInput,
        taskId: "admission-race",
        state: { status: "scheduled", followupCount: 0 },
      };
      await store.upsert(task);
      const observed = await store.get(task.taskId);
      if (!observed) throw new Error("Scheduled task disappeared");
      const metadata = { systemOperation: "family.monthlyCoordination" };
      await store.upsert({ ...task, metadata });
      expect(
        await store.claimForFire({
          taskId: task.taskId,
          firedAtIso: "2026-05-09T12:00:00.000Z",
          expectedMetadata: observed.metadata ?? {},
        }),
      ).toEqual({ kind: "raced" });
      expect((await store.get(task.taskId))?.state.status).toBe("scheduled");
      expect(
        (
          await store.claimForFire({
            taskId: task.taskId,
            firedAtIso: "2026-05-09T12:00:00.000Z",
            expectedMetadata: (await store.get(task.taskId))?.metadata ?? {},
          })
        ).kind,
      ).toBe("fired");
      expect((await store.get(task.taskId))?.metadata).toMatchObject(metadata);
    } finally {
      await pg.close();
    }
  });

  // A guarded write must not resurrect a row a concurrent writer deleted.
  // Reusing the upsert here took the INSERT branch on a missing row and
  // reported a won CAS — the opposite of the in-memory store, on exactly the
  // race this guard exists to close. Deletion is a live path
  // (deleteCodingAgentSchedule).
  it("reports a loss instead of resurrecting a deleted task", async () => {
    const pg = new PGlite();
    try {
      await migrateSchedulingTables(carveOutDatabase(pg));
      const runtime = {
        agentId: "agent-guard",
        adapter: {
          db: {
            execute: (query: RawSqlQuery) => pg.query(rawQueryText(query)),
          },
        },
        reportError: vi.fn(),
      } as unknown as IAgentRuntime;
      const store = createSchedulingSqlScheduledTaskStore({
        runtime,
        agentId: runtime.agentId,
      });
      const scheduled = {
        taskId: "guard-task-deleted",
        ...baseInput,
        trigger: { kind: "once" as const, atIso: "2026-05-09T13:00:00.000Z" },
        state: { status: "fired" as const, followupCount: 0 },
      } as ScheduledTask;
      await store.upsert(scheduled, { nextFireAtIso: null });

      // A concurrent writer removes the task mid-dispatch.
      await store.delete("guard-task-deleted");

      expect(
        await store.upsertIfStatus(scheduled, {
          nextFireAtIso: null,
          expectedStatus: "fired",
        }),
      ).toBe(false);
      // And it must stay gone, not be re-created by the guarded write.
      expect(await store.get("guard-task-deleted")).toBeNull();
    } finally {
      await pg.close();
    }
  }, 15_000);
});
