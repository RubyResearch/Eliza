/**
 * Unit coverage for the trajectory capture bridge in the DEFAULT lane (no real
 * DB). The full round-trip (real PGLite) lives in
 * trajectory-capture.integration.test.ts, while this test guards the ownership
 * boundary that broke production: once installed,
 * the agent bridge owns lifecycle, capture, and reads as one SQL contract. It
 * must not also forward capture into the core writer, whose canonical step and
 * reward shapes cannot be fabricated from agent-only LLM steps. A mock adapter
 * records db.execute calls.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueStepWrite,
  ensureTrajectoriesTable,
  normalizeLlmCallPayload,
  normalizeProviderAccessPayload,
} from "./trajectory-internals.ts";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { loadPersistedTrajectoryRows } from "./trajectory-query.ts";
import {
  __getTrajectoryBridgeStateCountsForTests,
  clearPersistedTrajectoryRows,
  DatabaseTrajectoryLogger,
  deletePersistedTrajectoryRows,
  flushTrajectoryWrites,
} from "./trajectory-storage.ts";

interface MockLogger {
  logLlmCall: (...args: unknown[]) => void;
  logProviderAccess: (...args: unknown[]) => void;
  logLLMCall?: (stepId: string, details: Record<string, unknown>) => void;
  logProviderAccessByTrajectoryId?: (
    trajectoryId: string,
    access: Record<string, unknown>,
  ) => void;
  startTrajectory?: (
    stepId: string,
    options: {
      agentId: string;
      source?: string;
      scenarioId?: string;
      traceId?: string;
      episodeId?: string;
      batchId?: string;
      groupIndex?: number;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<string>;
  startStep?: (trajectoryId: string) => string;
  getCurrentStepId?: (trajectoryId: string) => string | null;
  completeStep?: (
    trajectoryId: string,
    stepId: string,
    action: Record<string, unknown>,
    rewardInfo?: Record<string, unknown>,
  ) => void;
  flushWriteQueue?: (trajectoryId?: string) => Promise<void>;
  endTrajectory?: (
    stepId: string,
    status?: string,
    finalMetrics?: Record<string, unknown>,
  ) => Promise<void>;
  listTrajectories?: (options?: {
    limit?: number;
    offset?: number;
    traceId?: string;
  }) => Promise<unknown>;
  exportTrajectories?: (options: {
    format: "json";
    traceId?: string;
  }) => Promise<unknown>;
  stop?: () => Promise<void>;
  isEnabled: () => boolean;
  setEnabled: (v: boolean) => void;
  llmCalls: unknown[];
  providerAccess: unknown[];
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

function hasTraceFilter(execute: ReturnType<typeof vi.fn>, traceId: string) {
  return execute.mock.calls.some(([query]) =>
    sqlText(query).includes(`trace_id = '${traceId}'`),
  );
}

function trajectoryParentWriteSql(execute: ReturnType<typeof vi.fn>): string[] {
  return execute.mock.calls
    .map(([query]) => sqlText(query))
    .filter((query) =>
      /(?:INSERT INTO trajectories\s*\(|UPDATE trajectories SET)/i.test(query),
    );
}

function trajectoryPersistenceSql(execute: ReturnType<typeof vi.fn>): string[] {
  return execute.mock.calls
    .map(([query]) => sqlText(query))
    .filter((query) =>
      /(?:INSERT INTO trajectories\s*\(|UPDATE trajectories SET|INSERT INTO trajectory_steps\s*\()/i.test(
        query,
      ),
    );
}

function makeRuntime(options: { statefulEnablement?: boolean } = {}) {
  let enabled = true;
  const originalLogLlmCall = vi.fn();
  const originalLogProviderAccess = vi.fn();
  const originalExportTrajectories = vi.fn();
  const logger: MockLogger = {
    logLlmCall: originalLogLlmCall,
    logProviderAccess: originalLogProviderAccess,
    exportTrajectories: originalExportTrajectories,
    isEnabled: () => enabled,
    setEnabled: (value) => {
      if (options.statefulEnablement) enabled = value;
    },
    llmCalls: [],
    providerAccess: [],
  };
  logger.logLLMCall = (stepId, details) => {
    logger.logLlmCall({ stepId, ...details });
  };
  logger.logProviderAccessByTrajectoryId = (trajectoryId, access) => {
    const stepId = logger.getCurrentStepId?.(trajectoryId);
    if (stepId) logger.logProviderAccess({ stepId, ...access });
  };
  const execute = vi.fn().mockResolvedValue([]);
  const persistedTrajectoryIds = new Set<string>();
  type MockDb = {
    execute: (query: unknown) => Promise<unknown>;
    transaction: <T>(work: (tx: MockDb) => Promise<T>) => Promise<T>;
  };
  const transactionDb: MockDb = {
    execute: async (query: unknown): Promise<unknown> => {
      const result = await execute(query);
      const sql = sqlText(query);
      const insertedId = sql.match(
        /INSERT INTO trajectories\s*\([\s\S]*?VALUES\s*\(\s*'([^']+)'/i,
      )?.[1];
      const alreadyInserted =
        insertedId !== undefined && persistedTrajectoryIds.has(insertedId);
      if (insertedId) persistedTrajectoryIds.add(insertedId);
      // Insert-only starts return their new row ID; a competing creator gets
      // no row. The real PGlite suite covers transaction rollback and races.
      if (
        Array.isArray(result) &&
        result.length === 0 &&
        insertedId &&
        /ON CONFLICT \(id\) DO NOTHING RETURNING id/i.test(sql)
      ) {
        return alreadyInserted ? [] : [{ id: insertedId }];
      }
      // Conditional parent writes use RETURNING as their CAS result. This
      // recorder otherwise represents every successful mutation as [].
      const updatedId = sql.match(
        /UPDATE trajectories SET[\s\S]*?WHERE trajectories\.id = '([^']+)'/i,
      )?.[1];
      if (
        Array.isArray(result) &&
        result.length === 0 &&
        updatedId !== undefined &&
        persistedTrajectoryIds.has(updatedId) &&
        /RETURNING id/i.test(sql)
      ) {
        return [{ id: updatedId }];
      }
      return result;
    },
    transaction: async <T>(work: (tx: MockDb) => Promise<T>): Promise<T> =>
      work(transactionDb),
  };
  const setPersistedTrajectory = (
    trajectoryId: string,
    persisted: boolean,
  ): void => {
    if (persisted) persistedTrajectoryIds.add(trajectoryId);
    else persistedTrajectoryIds.delete(trajectoryId);
  };
  const db: MockDb = {
    execute,
    transaction: async <T>(work: (tx: MockDb) => Promise<T>): Promise<T> =>
      work(transactionDb),
  };
  const warn = vi.fn();
  const reportError = vi.fn();
  const runtime = {
    agentId: "agent-bridge-test",
    runtimeInstanceId: crypto.randomUUID(),
    adapter: { db },
    getService: (t: string) => (t === "trajectories" ? logger : null),
    getServicesByType: (t: string) => (t === "trajectories" ? [logger] : []),
    reportError,
    logger: {
      warn,
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as AgentRuntime;
  return {
    runtime,
    logger,
    originalLogLlmCall,
    originalLogProviderAccess,
    originalExportTrajectories,
    execute,
    warn,
    reportError,
    setPersistedTrajectory,
  };
}

describe("installDatabaseTrajectoryLogger (capture bridge)", () => {
  it("patches the resolved trajectories logger's logLlmCall", async () => {
    const { runtime, logger, originalLogLlmCall } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    expect(logger.logLlmCall).not.toBe(originalLogLlmCall);
    expect(typeof logger.logLlmCall).toBe("function");
  });

  it("persists semantic decision stages through the patched logSemanticStage", async () => {
    const { runtime, logger, execute, reportError } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await ensureTrajectoriesTable(runtime);
    const patched = logger as MockLogger & {
      logSemanticStage?: (params: Record<string, unknown>) => void;
    };
    expect(typeof patched.logSemanticStage).toBe("function");
    await logger.startTrajectory?.("step-semantic-1", {
      agentId: runtime.agentId,
      source: "test",
    });
    await flushTrajectoryWrites(runtime);
    execute.mockClear();

    patched.logSemanticStage?.({
      stepId: "step-semantic-1",
      stage: {
        stageId: "stage-tool-search-1",
        kind: "toolSearch",
        iteration: 1,
        startedAt: 100,
        endedAt: 112,
        latencyMs: 12,
        toolSearch: {
          query: { candidateActions: ["OWNER_ROUTINES", "VIEWS"] },
          results: [
            { name: "OWNER_ROUTINES", score: 0.91, rank: 1 },
            { name: "VIEWS", score: 0.22, rank: 2 },
          ],
          selectedActions: ["OWNER_ROUTINES"],
        },
      },
    });
    await flushTrajectoryWrites(runtime);

    const persistenceSql = trajectoryPersistenceSql(execute);
    expect(persistenceSql.length).toBeGreaterThan(0);
    const stageWrite = persistenceSql.find((query) =>
      query.includes("semanticStages"),
    );
    expect(stageWrite).toBeDefined();
    expect(stageWrite).toContain("stage-tool-search-1");
    expect(stageWrite).toContain("OWNER_ROUTINES");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("rejects a malformed semantic stage as an invalid capture without a write", async () => {
    const { runtime, logger, execute, reportError } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await ensureTrajectoriesTable(runtime);
    const patched = logger as MockLogger & {
      logSemanticStage?: (params: Record<string, unknown>) => void;
    };
    execute.mockClear();

    patched.logSemanticStage?.({
      stepId: "step-semantic-2",
      stage: {
        stageId: "bad-stage",
        kind: "toolSearch",
        startedAt: 10,
        endedAt: 5,
        latencyMs: -5,
      },
    });
    await flushTrajectoryWrites(runtime);

    expect(trajectoryPersistenceSql(execute)).toHaveLength(0);
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.captureValidation",
      expect.anything(),
      expect.objectContaining({ captureType: "semanticStage" }),
    );
  });

  it("honors live enablement across patched lifecycle and legacy helpers", async () => {
    const { runtime, logger, execute, setPersistedTrajectory } = makeRuntime({
      statefulEnablement: true,
    });
    await installDatabaseTrajectoryLogger(runtime);
    await ensureTrajectoriesTable(runtime);
    logger.setEnabled(false);
    execute.mockClear();

    const disabledTrajectory = await logger.startTrajectory?.("disabled", {
      agentId: runtime.agentId,
      source: "chat",
    });
    const disabledStep = logger.startStep?.(disabledTrajectory ?? "disabled");
    logger.logLLMCall?.(disabledStep ?? "disabled-step", {
      model: "disabled-model",
      systemPrompt: "disabled",
      userPrompt: "disabled",
      response: "disabled",
      purpose: "action",
    });
    logger.logProviderAccessByTrajectoryId?.(disabledTrajectory ?? "disabled", {
      providerName: "disabled-provider",
      purpose: "context",
      data: {},
    });
    logger.completeStep?.(
      disabledTrajectory ?? "disabled",
      disabledStep ?? "disabled-step",
      {
        actionType: "DISABLED",
        actionName: "DISABLED",
        parameters: {},
        success: true,
        result: {},
      },
    );
    await logger.endTrajectory?.(disabledTrajectory ?? "disabled");
    await logger.flushWriteQueue?.(disabledTrajectory);

    expect(execute).not.toHaveBeenCalled();
    expect(logger.getCurrentStepId?.(disabledTrajectory ?? "disabled")).toBe(
      null,
    );
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    logger.setEnabled(true);
    const persistedAt = Date.now();
    setPersistedTrajectory("enabled-parent", true);
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        sql.includes("SELECT * FROM trajectories") &&
        sql.includes("enabled-parent")
      ) {
        return [
          {
            id: "enabled-parent",
            agent_id: runtime.agentId,
            source: "test",
            status: "active",
            start_time: persistedAt,
            end_time: null,
            duration_ms: null,
            steps_json: "[]",
            metadata_json: "{}",
            metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
            reward_components_json: '{"environmentReward":0}',
            total_reward: 0,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt).toISOString(),
          },
        ];
      }
      return [];
    });
    const enabledTrajectory = await logger.startTrajectory?.("enabled-parent", {
      agentId: runtime.agentId,
      source: "test",
    });
    const enabledStep = logger.startStep?.(
      enabledTrajectory ?? "enabled-parent",
    );
    await logger.flushWriteQueue?.(enabledTrajectory);
    expect(
      logger.getCurrentStepId?.(enabledTrajectory ?? "enabled-parent"),
    ).toBe(enabledStep);

    logger.logLLMCall?.(enabledStep ?? "enabled-step", {
      model: "enabled-model",
      systemPrompt: "system",
      userPrompt: "prompt",
      response: "response",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 1,
    });
    logger.logProviderAccessByTrajectoryId?.(
      enabledTrajectory ?? "enabled-parent",
      {
        providerName: "enabled-provider",
        purpose: "context",
        data: { enabled: true },
      },
    );
    await logger.flushWriteQueue?.(enabledTrajectory);
    const enabledWrites = trajectoryPersistenceSql(execute);
    expect(
      enabledWrites.some((query) => query.includes('"model":"enabled-model"')),
      enabledWrites.join("\n---WRITE---\n"),
    ).toBe(true);
    expect(
      enabledWrites.some((query) =>
        query.includes('"providerName":"enabled-provider"'),
      ),
    ).toBe(true);

    logger.setEnabled(false);
    expect(
      logger.getCurrentStepId?.(enabledTrajectory ?? "enabled-parent"),
    ).toBe(null);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    execute.mockClear();

    logger.logLLMCall?.(enabledStep ?? "enabled-step", {
      model: "late-disabled-model",
      systemPrompt: "disabled",
      userPrompt: "disabled",
      response: "disabled",
      purpose: "action",
    });
    logger.logProviderAccessByTrajectoryId?.(
      enabledTrajectory ?? "enabled-parent",
      {
        providerName: "late-disabled-provider",
        purpose: "context",
        data: {},
      },
    );
    await logger.endTrajectory?.(enabledTrajectory ?? "enabled-parent");
    await logger.flushWriteQueue?.(enabledTrajectory);
    expect(execute).not.toHaveBeenCalled();

    execute.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await logger.listTrajectories?.({ limit: 1 });
    expect(execute).toHaveBeenCalled();
  });

  it("drains started writes while disabled and cancels queued capture", async () => {
    const { runtime, logger, execute } = makeRuntime({
      statefulEnablement: true,
    });
    await installDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(true);
    const trajectoryId = await logger.startTrajectory?.("held-parent", {
      agentId: runtime.agentId,
      source: "test",
    });
    await logger.flushWriteQueue?.(trajectoryId);

    const persistedAt = Date.now();
    const parentRow = {
      id: "held-parent",
      agent_id: runtime.agentId,
      source: "test",
      status: "active",
      start_time: persistedAt,
      end_time: null,
      duration_ms: null,
      steps_json: "[]",
      metadata_json: "{}",
      metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
      reward_components_json: '{"environmentReward":0}',
      total_reward: 0,
      created_at: new Date(persistedAt).toISOString(),
      updated_at: new Date(persistedAt).toISOString(),
    };
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      return sql.includes("SELECT * FROM trajectories") &&
        sql.includes("held-parent")
        ? [parentRow]
        : [];
    });
    const stepId = logger.startStep?.(trajectoryId ?? "held-parent");
    await logger.flushWriteQueue?.(trajectoryId);

    let releaseHeldWrite!: () => void;
    let markHeldWriteStarted!: () => void;
    const heldWrite = new Promise<void>((resolve) => {
      releaseHeldWrite = resolve;
    });
    const heldWriteStarted = new Promise<void>((resolve) => {
      markHeldWriteStarted = resolve;
    });
    let shouldHold = true;
    execute.mockClear();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        shouldHold &&
        sql.includes("SELECT * FROM trajectories") &&
        sql.includes("held-parent")
      ) {
        shouldHold = false;
        markHeldWriteStarted();
        await heldWrite;
        return [parentRow];
      }
      return sql.includes("SELECT * FROM trajectories") &&
        sql.includes("held-parent")
        ? [parentRow]
        : [];
    });

    logger.logLLMCall?.(stepId ?? "held-step", {
      model: "started-before-disable",
      systemPrompt: "system",
      userPrompt: "prompt",
      response: "response",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await heldWriteStarted;
    logger.logProviderAccessByTrajectoryId?.(trajectoryId ?? "held-parent", {
      providerName: "queued-before-disable",
      purpose: "context",
      data: {},
    });
    logger.setEnabled(false);
    const drain = logger.flushWriteQueue?.(trajectoryId);
    releaseHeldWrite();
    await drain;

    const writes = trajectoryPersistenceSql(execute);
    expect(
      writes.some((query) =>
        query.includes('"model":"started-before-disable"'),
      ),
    ).toBe(true);
    expect(
      writes.some((query) => query.includes("queued-before-disable")),
    ).toBe(false);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("re-snapshots global drains and blocks shutdown until every owner settles", async () => {
    const { runtime, logger, execute } = makeRuntime({
      statefulEnablement: true,
    });
    await installDatabaseTrajectoryLogger(runtime);

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    void enqueueStepWrite(runtime, "owner-first", async () => {
      markFirstStarted();
      await firstBarrier;
    });
    await firstStarted;

    let globalDrainSettled = false;
    const globalDrain = flushTrajectoryWrites(runtime).then(() => {
      globalDrainSettled = true;
    });
    await enqueueStepWrite(runtime, "owner-fast", async () => {});

    let releaseLate!: () => void;
    let markLateStarted!: () => void;
    const lateBarrier = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const lateStarted = new Promise<void>((resolve) => {
      markLateStarted = resolve;
    });
    void enqueueStepWrite(runtime, "owner-late", async () => {
      markLateStarted();
      await lateBarrier;
    });
    await lateStarted;
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(globalDrainSettled).toBe(false);
    releaseLate();
    await globalDrain;
    expect(globalDrainSettled).toBe(true);

    const trajectoryId = await logger.startTrajectory?.("stop-parent", {
      agentId: runtime.agentId,
      source: "test",
    });
    await logger.flushWriteQueue?.(trajectoryId);

    let releaseStopWrite!: () => void;
    let markStopWriteStarted!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStopWrite = resolve;
    });
    const stopWriteStarted = new Promise<void>((resolve) => {
      markStopWriteStarted = resolve;
    });
    void enqueueStepWrite(runtime, "owner-stop", async () => {
      markStopWriteStarted();
      await stopBarrier;
    });
    await stopWriteStarted;
    let stopSettled = false;
    const stop = logger.stop?.().then(() => {
      stopSettled = true;
    });
    logger.logLlmCall({
      stepId: trajectoryId ?? "stop-parent",
      model: "capture-during-stop",
      response: "must be inert",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    releaseStopWrite();
    await stop;
    expect(stopSettled).toBe(true);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    execute.mockClear();
    logger.logLlmCall({
      stepId: trajectoryId ?? "stop-parent",
      model: "capture-after-stop",
      response: "must remain inert",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    const stoppedTrajectory = await logger.startTrajectory?.("after-stop", {
      agentId: runtime.agentId,
      source: "test",
    });
    logger.startStep?.(stoppedTrajectory ?? "after-stop");
    await logger.flushWriteQueue?.();
    expect(trajectoryParentWriteSql(execute)).toEqual([]);
    expect(
      execute.mock.calls.some(([query]) =>
        sqlText(query).includes("capture-after-stop"),
      ),
    ).toBe(false);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("runs a later same-owner write after the prior observer sees rejection", async () => {
    const { runtime, reportError } = makeRuntime();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = enqueueStepWrite(runtime, "recovering-owner", async () => {
      markFirstStarted();
      await firstBarrier;
      throw new Error("first write failed");
    });
    await firstStarted;
    const secondWork = vi.fn(async () => {});
    const second = enqueueStepWrite(runtime, "recovering-owner", secondWork);

    releaseFirst();
    await expect(first).rejects.toThrow("first write failed");
    await expect(second).resolves.toBeUndefined();
    expect(secondWork).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("routes capture exclusively through the agent SQL contract", async () => {
    const {
      runtime,
      logger,
      originalLogLlmCall,
      originalLogProviderAccess,
      execute,
    } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await logger.startTrajectory?.("step-1", {
      agentId: runtime.agentId,
      source: "test",
    });
    await flushTrajectoryWrites(runtime);
    execute.mockClear();

    logger.logProviderAccess({
      stepId: "step-1",
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });
    logger.logLlmCall({
      stepId: "step-1",
      model: "eliza-1-2b",
      modelType: "TEXT_LARGE",
      provider: "local-inference",
      response: "hello",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 5,
    });
    await flushTrajectoryWrites(runtime);

    expect(originalLogLlmCall).not.toHaveBeenCalled();
    expect(originalLogProviderAccess).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  it("throws unavailable storage and malformed count results at public boundaries", async () => {
    const noDatabase = {
      agentId: "agent-without-trajectory-db",
      reportError: vi.fn(),
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as AgentRuntime;
    const standalone = new DatabaseTrajectoryLogger(noDatabase);
    await expect(loadPersistedTrajectoryRows(noDatabase)).rejects.toMatchObject(
      {
        code: "TRAJECTORY_DATABASE_UNAVAILABLE",
      },
    );
    await expect(
      standalone.exportTrajectories({ format: "json" }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
    await expect(
      clearPersistedTrajectoryRows(noDatabase),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });

    const { runtime, logger } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await expect(logger.listTrajectories?.({ limit: 1 })).rejects.toMatchObject(
      {
        code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
      },
    );
    await expect(clearPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
    });
    await expect(
      deletePersistedTrajectoryRows(runtime, ["missing-count-row"]),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STORAGE_OPERATION_FAILED" });

    const malformedQuery = makeRuntime();
    await ensureTrajectoriesTable(malformedQuery.runtime);
    malformedQuery.execute.mockResolvedValueOnce({});
    await expect(
      loadPersistedTrajectoryRows(malformedQuery.runtime),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });

    const malformedExport = makeRuntime();
    await installDatabaseTrajectoryLogger(malformedExport.runtime);
    await ensureTrajectoriesTable(malformedExport.runtime);
    malformedExport.execute.mockResolvedValueOnce({});
    await expect(
      malformedExport.logger.exportTrajectories?.({ format: "json" }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STORAGE_OPERATION_FAILED" });
  });

  it("reports synchronous action settlement validation failures", async () => {
    const { runtime, logger, reportError } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    logger.completeStep?.("parent-invalid", "step-invalid", {
      actionType: "INVALID",
      actionName: "INVALID",
      parameters: [] as unknown as Record<string, unknown>,
      success: true,
    });

    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.completeStep",
      expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }),
      {
        trajectoryId: "parent-invalid",
        stepId: "step-invalid",
        diagnosticOnly: true,
      },
    );
  });

  it("reports missing active action children for installed and standalone loggers", async () => {
    const { runtime, logger, reportError } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    const action = {
      actionType: "MISSING_CHILD",
      actionName: "MISSING_CHILD",
      parameters: {},
      success: true,
    };

    const patchedCompleteStep = logger.completeStep as unknown as (
      trajectoryId: string,
      action: Record<string, unknown>,
    ) => void;
    patchedCompleteStep("patched-missing-child", action);
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.completeStep",
      expect.objectContaining({ code: "TRAJECTORY_ACTION_STEP_REQUIRED" }),
      {
        trajectoryId: "patched-missing-child",
        diagnosticOnly: true,
      },
    );

    reportError.mockClear();
    const standalone = new DatabaseTrajectoryLogger(runtime);
    standalone.setEnabled(true);
    standalone.completeStep("standalone-missing-child", action);
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.completeStep",
      expect.objectContaining({ code: "TRAJECTORY_ACTION_STEP_REQUIRED" }),
      {
        trajectoryId: "standalone-missing-child",
        diagnosticOnly: true,
      },
    );
  });

  it("keeps standalone late child capture closed and shutdown permanently inert", async () => {
    const { runtime, execute, reportError, setPersistedTrajectory } =
      makeRuntime();
    const persistedAt = Date.now();
    setPersistedTrajectory("standalone-parent", true);
    const parentRow = {
      id: "standalone-parent",
      agent_id: runtime.agentId,
      source: "test",
      status: "active",
      start_time: persistedAt,
      end_time: null,
      duration_ms: null,
      steps_json: "[]",
      metadata_json: "{}",
      metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
      reward_components_json: '{"environmentReward":0}',
      total_reward: 0,
      created_at: new Date(persistedAt).toISOString(),
      updated_at: new Date(persistedAt).toISOString(),
    };
    execute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      return text.includes("SELECT * FROM trajectories") &&
        text.includes("standalone-parent")
        ? [parentRow]
        : [];
    });
    const standalone = new DatabaseTrajectoryLogger(runtime);
    standalone.setEnabled(true);
    const trajectoryId = await standalone.startTrajectory("standalone-parent", {
      agentId: runtime.agentId,
      source: "test",
    });
    const childStepId = standalone.startStep(trajectoryId);
    await standalone.flushWriteQueue(trajectoryId);
    await standalone.endTrajectory(trajectoryId, "completed");
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    execute.mockClear();
    // Sub-2s rejects are the designed delivery/terminalization race and are
    // quieted to debug logging; only an aged capture is the real leak signal
    // this assertion is about, so the two rejects land 10s after close.
    const realNow = Date.now.bind(Date);
    const agedNow = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + 10_000);
    try {
      standalone.logLlmCall({
        stepId: childStepId,
        model: "late-standalone",
        response: "must be rejected",
        purpose: "action",
        actionType: "runtime.useModel",
      });
      standalone.logProviderAccess({
        stepId: childStepId,
        providerName: "late-standalone-provider",
        purpose: "context",
        data: {},
      });
    } finally {
      agedNow.mockRestore();
    }
    await standalone.flushWriteQueue();
    expect(execute).not.toHaveBeenCalled();
    // Both captures are rejected, but only the first reports: repeats for the
    // same closed step dedupe to debug logging.
    const lateReports = reportError.mock.calls.filter(
      ([scope, , context]) =>
        scope === "TrajectoryStorage.lateCapture" &&
        (context as { diagnosticOnly?: boolean }).diagnosticOnly === true,
    );
    expect(lateReports).toHaveLength(1);
    expect(String((lateReports[0][1] as Error).message)).toMatch(
      /step=\S+ type=llm purpose=action age=\d+s/,
    );

    await standalone.stop();
    execute.mockClear();
    const stoppedTrajectoryId = await standalone.startTrajectory(
      "standalone-after-stop",
      { agentId: runtime.agentId, source: "test" },
    );
    standalone.startStep(stoppedTrajectoryId);
    standalone.logLlmCall({
      stepId: childStepId,
      model: "post-stop",
      response: "must remain inert",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await standalone.flushWriteQueue();
    expect(standalone.isEnabled()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("stores delayed rewards in the canonical nested component map", async () => {
    const { runtime, execute } = makeRuntime();
    const persistedAt = Date.now();
    execute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (
        text.includes("SELECT * FROM trajectories") &&
        text.includes("agent-reward-parent")
      ) {
        return [
          {
            id: "agent-reward-parent",
            agent_id: runtime.agentId,
            source: "morning-brief",
            status: "completed",
            start_time: persistedAt,
            end_time: persistedAt + 1,
            duration_ms: 1,
            steps_json: "[]",
            metadata_json: "{}",
            metrics_json: '{"episodeLength":0,"finalStatus":"completed"}',
            reward_components_json:
              '{"environmentReward":0,"components":{"existing":0.25}}',
            total_reward: 0,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt + 1).toISOString(),
          },
        ];
      }
      return [];
    });
    const standalone = new DatabaseTrajectoryLogger(runtime);
    standalone.setEnabled(true);
    expect(
      await standalone.applyReward({
        trajectoryId: "agent-reward-parent",
        idempotencyKey: "brief-engagement:event-1",
        reward: 0.75,
        component: "briefEngagementReward",
      }),
    ).toBe(true);
    const writes = trajectoryParentWriteSql(execute);
    expect(
      writes.some(
        (query) =>
          query.includes(
            '"components":{"existing":0.25,"briefEngagementReward":0.75}',
          ) && !query.includes('"briefEngagementReward":0.75,"components"'),
      ),
    ).toBe(true);
  });

  it("rejects malformed persisted delayed-reward components", async () => {
    const { runtime, execute } = makeRuntime();
    const persistedAt = Date.now();
    execute.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (
        text.includes("SELECT * FROM trajectories") &&
        text.includes("agent-reward-corrupt")
      ) {
        return [
          {
            id: "agent-reward-corrupt",
            agent_id: runtime.agentId,
            source: "morning-brief",
            status: "completed",
            start_time: persistedAt,
            end_time: persistedAt + 1,
            duration_ms: 1,
            steps_json: "[]",
            metadata_json: "{}",
            metrics_json: '{"episodeLength":0,"finalStatus":"completed"}',
            reward_components_json:
              '{"environmentReward":0,"components":"corrupt"}',
            total_reward: 0,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt + 1).toISOString(),
          },
        ];
      }
      return [];
    });
    const standalone = new DatabaseTrajectoryLogger(runtime);
    standalone.setEnabled(true);

    await expect(
      standalone.applyReward({
        trajectoryId: "agent-reward-corrupt",
        idempotencyKey: "brief-engagement:event-corrupt",
        reward: 0.75,
        component: "briefEngagementReward",
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_CAPTURE_INVALID" });
    expect(trajectoryParentWriteSql(execute)).toEqual([]);
  });

  it("keeps canonical metrics valid across provider/LLM appends and completion", async () => {
    const { runtime, logger, execute } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    const stepId = await logger.startTrajectory?.("step-current", {
      agentId: runtime.agentId,
      source: "chat",
    });
    expect(stepId).toBe("step-current");
    await flushTrajectoryWrites(runtime);

    logger.logProviderAccess({
      stepId: "step-current",
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });
    await flushTrajectoryWrites(runtime);

    logger.logLlmCall({
      stepId: "step-current",
      model: "eliza-1-2b",
      modelType: "TEXT_LARGE",
      provider: "local-inference",
      response: "hello",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 5,
    });
    await flushTrajectoryWrites(runtime);

    const persistedAt = Date.now();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        sql.includes("SELECT * FROM trajectories") &&
        sql.includes("step-current")
      ) {
        return [
          {
            id: "step-current",
            agent_id: runtime.agentId,
            source: "chat",
            status: "active",
            start_time: persistedAt,
            end_time: null,
            duration_ms: null,
            steps_json: JSON.stringify([
              {
                stepId: "step-current-child",
                stepNumber: 0,
                timestamp: persistedAt,
                llmCalls: [],
                providerAccesses: [],
              },
            ]),
            metadata_json: "{}",
            total_reward: 0,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt).toISOString(),
          },
        ];
      }
      return [];
    });

    await logger.endTrajectory?.("step-current", "completed");
    await flushTrajectoryWrites(runtime);

    const writes = trajectoryParentWriteSql(execute);
    expect(writes).toHaveLength(4);
    expect(writes[0]).toContain('"episodeLength":0');
    expect(
      writes
        .slice(1)
        .every(
          (query) =>
            query.includes("metrics_json") &&
            query.includes("reward_components_json") &&
            query.includes('"episodeLength":1'),
        ),
    ).toBe(true);
    expect(
      writes
        .slice(0, 3)
        .every((query) => query.includes('"finalStatus":"active"')),
    ).toBe(true);
    expect(writes[3]).toContain('"finalStatus":"completed"');

    const stepWrites = execute.mock.calls
      .map(([query]) => sqlText(query))
      .filter((query) => /INSERT INTO trajectory_steps\s*\(/i.test(query));
    expect(
      stepWrites.some((query) => query.includes('"providerName":"facts"')),
    ).toBe(true);
    expect(
      stepWrites.some((query) => query.includes('"model":"eliza-1-2b"')),
    ).toBe(true);
  });

  it("rejects a missing terminal parent and retains ownership for retry", async () => {
    const {
      runtime,
      logger,
      execute,
      warn,
      reportError,
      setPersistedTrajectory,
    } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);

    const trajectoryId = await logger.startTrajectory?.("missing-parent", {
      agentId: runtime.agentId,
      source: "chat",
    });
    expect(trajectoryId).toBe("missing-parent");
    await flushTrajectoryWrites(runtime);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 1,
      activeOwners: 1,
    });

    execute.mockClear();
    setPersistedTrajectory("missing-parent", false);
    await expect(
      logger.endTrajectory?.("missing-parent", "completed"),
    ).rejects.toMatchObject({ code: "TRAJECTORY_PARENT_NOT_FOUND" });

    expect(trajectoryParentWriteSql(execute)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code: "TRAJECTORY_PARENT_NOT_FOUND" }),
      }),
      "Failed to write trajectory update to database",
    );
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.write",
      expect.objectContaining({ code: "TRAJECTORY_PARENT_NOT_FOUND" }),
      { stepId: "missing-parent", diagnosticOnly: true },
    );
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 1,
      activeOwners: 1,
    });

    const persistedAt = Date.now();
    setPersistedTrajectory("missing-parent", true);
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        sql.includes("SELECT * FROM trajectories") &&
        sql.includes("missing-parent")
      ) {
        return [
          {
            id: "missing-parent",
            agent_id: runtime.agentId,
            source: "chat",
            status: "active",
            start_time: persistedAt,
            end_time: null,
            duration_ms: null,
            steps_json: "[]",
            metadata_json: "{}",
            metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
            reward_components_json: "{}",
            total_reward: 1.25,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt).toISOString(),
          },
        ];
      }
      return [];
    });
    await logger.endTrajectory?.("missing-parent", "completed");
    expect(
      trajectoryParentWriteSql(execute).some((query) =>
        query.includes('"environmentReward":1.25'),
      ),
    ).toBe(true);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("preserves supplied lifecycle correlation, rewards, and final metrics", async () => {
    const { runtime, logger, execute, setPersistedTrajectory } = makeRuntime();
    setPersistedTrajectory("compat-parent", true);
    const persistedAt = Date.now();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        sql.includes("SELECT * FROM trajectories") &&
        sql.includes("compat-parent")
      ) {
        return [
          {
            id: "compat-parent",
            agent_id: runtime.agentId,
            source: "scenario",
            status: "active",
            start_time: persistedAt,
            end_time: null,
            duration_ms: null,
            steps_json: "[]",
            metadata_json: "{}",
            metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
            reward_components_json: '{"environmentReward":0}',
            total_reward: 0,
            created_at: new Date(persistedAt).toISOString(),
            updated_at: new Date(persistedAt).toISOString(),
          },
        ];
      }
      return [];
    });
    await installDatabaseTrajectoryLogger(runtime);

    const trajectoryId = await logger.startTrajectory?.("compat-parent", {
      agentId: runtime.agentId,
      source: "scenario",
      scenarioId: "scenario-1",
      traceId: "trace-1",
      episodeId: "episode-1",
      batchId: "batch-1",
      groupIndex: 7,
    });
    const stepId = logger.startStep?.(trajectoryId ?? "compat-parent");
    await logger.flushWriteQueue?.(trajectoryId);
    logger.completeStep?.(
      trajectoryId ?? "compat-parent",
      stepId ?? "compat-step",
      {
        actionType: "COMPAT",
        actionName: "COMPAT",
        parameters: {},
        success: true,
        result: { persisted: true },
      },
      {
        reward: 0.75,
        components: {
          environmentReward: 0.5,
          aiJudgeReward: 0.25,
          components: { predictionAccuracy: 0.9 },
        },
      },
    );
    await logger.flushWriteQueue?.(trajectoryId);
    await logger.endTrajectory?.(trajectoryId ?? "compat-parent", "completed", {
      evaluatorScore: 0.88,
      episodeLength: 999,
      finalStatus: "active",
    });

    const writes = trajectoryParentWriteSql(execute);
    const persistenceWrites = trajectoryPersistenceSql(execute);
    expect(
      writes.some(
        (query) =>
          query.includes("trace_id") &&
          query.includes("'trace-1'") &&
          query.includes("'episode-1'") &&
          query.includes("'batch-1'") &&
          query.includes("group_index = 7") &&
          query.includes('"traceId":"trace-1"'),
      ),
    ).toBe(true);
    expect(
      persistenceWrites.some(
        (query) =>
          query.includes('"environmentReward":0.5') &&
          query.includes('"aiJudgeReward":0.25') &&
          query.includes('"predictionAccuracy":0.9') &&
          query.includes("\n      0.75,"),
      ),
    ).toBe(true);
    expect(
      writes.some((query) => query.includes('"evaluatorScore":0.88')),
    ).toBe(true);
    const terminalWrite = writes.at(-1) ?? "";
    expect(terminalWrite).toContain('"episodeLength":0');
    expect(terminalWrite).toContain('"finalStatus":"completed"');
    expect(terminalWrite).not.toContain('"episodeLength":999');
  });

  // This large serialization fixture can contend with parallel Vitest batches
  // on shared runners, so retain the explicit timeout.
  it("preserves large bridge-owned captures while normalizing cycles", {
    timeout: 300_000,
  }, async () => {
    const { runtime, logger, execute, setPersistedTrajectory } = makeRuntime();
    const persistedAt = Date.now();
    setPersistedTrajectory("bounded-parent", true);
    const parentRow = {
      id: "bounded-parent",
      agent_id: runtime.agentId,
      source: "test",
      status: "active",
      start_time: persistedAt,
      end_time: null,
      duration_ms: null,
      steps_json: "[]",
      metadata_json: "{}",
      metrics_json: '{"episodeLength":0,"finalStatus":"active"}',
      reward_components_json: '{"environmentReward":0}',
      total_reward: 0,
      created_at: new Date(persistedAt).toISOString(),
      updated_at: new Date(persistedAt).toISOString(),
    };
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      return sql.includes("SELECT * FROM trajectories") &&
        sql.includes("bounded-parent")
        ? [parentRow]
        : [];
    });
    await installDatabaseTrajectoryLogger(runtime);
    const trajectoryId = await logger.startTrajectory?.("bounded-parent", {
      agentId: runtime.agentId,
      source: "test",
    });
    const stepId = logger.startStep?.(trajectoryId ?? "bounded-parent");
    await logger.flushWriteQueue?.(trajectoryId);

    const oversized = "x".repeat(70_000);
    const circular: Record<string, unknown> = { label: "cycle" };
    circular.self = circular;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 25; index += 1) {
      const nested: Record<string, unknown> = {};
      cursor.next = nested;
      cursor = nested;
    }
    const oversizedArray = Array.from(
      { length: 300 },
      (_value, index) => index,
    );

    logger.logLlmCall({
      stepId,
      callId: oversized,
      provider: oversized,
      model: oversized,
      modelType: oversized,
      systemPrompt: oversized,
      userPrompt: oversized,
      prompt: oversized,
      response: oversized,
      reasoning: oversized,
      finishReason: oversized,
      purpose: oversized,
      actionType: oversized,
      messages: [circular, deep, ...oversizedArray],
      tools: { circular, deep, oversizedArray },
      toolChoice: { circular },
      output: { deep },
      responseSchema: { deep },
      providerOptions: { circular },
      providerMetadata: { oversizedArray },
      toolCalls: [circular, deep, ...oversizedArray],
    });
    logger.logProviderAccess({
      stepId,
      providerId: oversized,
      providerName: oversized,
      purpose: oversized,
      overlapsWith: [{ providerName: oversized, overlapMs: 1 }],
      data: { circular, deep, oversizedArray, text: oversized },
      query: { circular, deep, oversizedArray, text: oversized },
    });
    logger.completeStep?.(
      trajectoryId ?? "bounded-parent",
      stepId ?? "bounded-step",
      {
        actionType: oversized,
        actionName: oversized,
        parameters: { circular, deep, oversizedArray, text: oversized },
        success: false,
        result: { circular, deep, oversizedArray, text: oversized },
        error: oversized,
        reasoning: oversized,
        llmCallId: oversized,
      },
    );
    await logger.flushWriteQueue?.(trajectoryId);

    const joinedWrites =
      trajectoryPersistenceSql(execute).join("\n---WRITE---\n");
    expect(joinedWrites).toMatch(/x{70000}/);
    expect(joinedWrites).toContain(JSON.stringify(oversizedArray));
    expect(joinedWrites).toContain("[Circular]");
    expect(joinedWrites).not.toContain("[MaxDepth]");
    expect(joinedWrites).not.toContain("...[truncated]");
    expect(joinedWrites).not.toContain('"__truncatedItems"');
  });

  it.each(["metadata_json", "metrics_json", "reward_components_json"] as const)(
    "falls back to the legacy schema when %s is unavailable",
    async (missingColumn) => {
      const { runtime, logger, execute } = makeRuntime();
      await installDatabaseTrajectoryLogger(runtime);
      await logger.startTrajectory?.("step-legacy", {
        agentId: runtime.agentId,
        source: "test",
      });
      await flushTrajectoryWrites(runtime);
      execute.mockClear();
      execute.mockImplementation(async (query: unknown) => {
        const sql = sqlText(query);
        if (
          /(?:INSERT INTO trajectories\s*\(|UPDATE trajectories SET)/i.test(
            sql,
          ) &&
          sql.includes(missingColumn)
        ) {
          throw new Error(`column ${missingColumn} does not exist`);
        }
        return [];
      });

      logger.logLlmCall({
        stepId: "step-legacy",
        model: "eliza-1-2b",
        response: "hello",
        purpose: "action",
        actionType: "runtime.useModel",
      });
      await flushTrajectoryWrites(runtime);

      const writes = trajectoryParentWriteSql(execute);
      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain(missingColumn);
      expect(writes[1]).not.toContain(missingColumn);
      expect(writes[1]).toContain("episode_length");
    },
  );

  it("does not mask a canonical write failure with a legacy write", async () => {
    const { runtime, logger, execute, reportError } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await logger.startTrajectory?.("step-failed", {
      agentId: runtime.agentId,
      source: "test",
    });
    await flushTrajectoryWrites(runtime);
    execute.mockClear();
    execute.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (
        /(?:INSERT INTO trajectories\s*\(|UPDATE trajectories SET)/i.test(sql)
      ) {
        throw new Error("connection reset");
      }
      return [];
    });

    logger.logLlmCall({
      stepId: "step-failed",
      model: "eliza-1-2b",
      response: "hello",
      purpose: "action",
      actionType: "runtime.useModel",
    });
    await expect(flushTrajectoryWrites(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_SAVE_FAILED",
    });

    const writes = trajectoryParentWriteSql(execute);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("metrics_json");
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.write",
      expect.objectContaining({ code: "TRAJECTORY_SAVE_FAILED" }),
      { stepId: "step-failed", diagnosticOnly: true },
    );
  });

  it("is idempotent — re-installing does not double-wrap", async () => {
    const { runtime, logger } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    const patched = logger.logLlmCall;
    await installDatabaseTrajectoryLogger(runtime);
    expect(logger.logLlmCall).toBe(patched);
  });

  it("applies traceId filters to the SQL-backed list reader", async () => {
    const { runtime, logger, execute } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    execute.mockClear();
    execute.mockImplementation(async (query: unknown) =>
      /SELECT count\(\*\) AS total FROM trajectories/i.test(sqlText(query))
        ? [{ total: 0 }]
        : [],
    );
    await logger.listTrajectories?.({ traceId: "trace-1", limit: 10 });

    expect(hasTraceFilter(execute, "trace-1")).toBe(true);
  });

  it("applies traceId filters to the compatibility export reader", async () => {
    const { runtime, logger, originalExportTrajectories, execute } =
      makeRuntime();

    await installDatabaseTrajectoryLogger(runtime);
    execute.mockClear();

    await logger.exportTrajectories?.({ format: "json", traceId: "trace-1" });

    expect(originalExportTrajectories).not.toHaveBeenCalled();
    expect(hasTraceFilter(execute, "trace-1")).toBe(true);
  });
});

describe("complete LLM capture", () => {
  it("retains every field beyond the former global row budget", () => {
    const optionalFields = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `optional-${index}`,
        "x".repeat(70_000),
      ]),
    );
    const payload = {
      stepId: "step-budget-exhausted",
      ...optionalFields,
      model: "zai-glm-4.7",
      response: "r".repeat(400_000),
      purpose: "response",
      actionType: "llm",
    };
    const normalized = normalizeLlmCallPayload([payload]);

    expect(normalized?.params).toEqual(payload);
  });

  it("leaves a small response byte-identical", () => {
    const normalized = normalizeLlmCallPayload([
      {
        stepId: "step-small",
        model: "zai-glm-4.7",
        purpose: "response",
        actionType: "llm",
        response: "ok",
      },
    ]);

    expect(normalized?.params.response).toBe("ok");
  });
});

describe("complete provider capture", () => {
  const oversizedProviderData = () =>
    Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `chunk-${index}`,
        "x".repeat(70_000),
      ]),
    );

  it("retains every field beyond the former global row budget", () => {
    const payload = {
      stepId: "step-provider-budget",
      providerName: "KNOWLEDGE",
      data: oversizedProviderData(),
      purpose: "Provider KNOWLEDGE accessed for context",
    };
    const normalized = normalizeProviderAccessPayload([payload]);

    expect(normalized?.params).toEqual(payload);
  });

  it("retains required fields through the (stepId, details) overload", () => {
    const payload = {
      providerName: "KNOWLEDGE",
      data: oversizedProviderData(),
      purpose: "Provider KNOWLEDGE accessed for context",
    };
    const normalized = normalizeProviderAccessPayload([
      "step-provider-budget-positional",
      payload,
    ]);

    expect(normalized?.stepId).toBe("step-provider-budget-positional");
    expect(normalized?.params).toEqual({
      ...payload,
      stepId: "step-provider-budget-positional",
    });
  });

  it("leaves a small provider payload byte-identical", () => {
    const normalized = normalizeProviderAccessPayload([
      {
        stepId: "step-provider-small",
        providerName: "KNOWLEDGE",
        data: { text: "ok", success: true },
        purpose: "action",
      },
    ]);

    expect(normalized?.params.data).toEqual({ text: "ok", success: true });
    expect(normalized?.params.purpose).toBe("action");
  });

  it("retains complete provider fields through logger flush and SQL serialization", async () => {
    const { runtime, logger, execute } = makeRuntime();
    await installDatabaseTrajectoryLogger(runtime);
    await logger.startTrajectory?.("provider-budget-persistence", {
      agentId: runtime.agentId,
      source: "test",
    });
    await flushTrajectoryWrites(runtime);
    execute.mockClear();

    logger.logProviderAccess({
      stepId: "provider-budget-persistence",
      providerName: "KNOWLEDGE",
      data: oversizedProviderData(),
      purpose: "Provider KNOWLEDGE accessed for context",
    });
    await logger.flushWriteQueue?.("provider-budget-persistence");

    const serialized = trajectoryPersistenceSql(execute).join("\n");
    expect(serialized).toContain('"providerName":"KNOWLEDGE"');
    expect(serialized).toContain(
      '"purpose":"Provider KNOWLEDGE accessed for context"',
    );
    const lastChunk = serialized.match(/"chunk-19":"(x+)"/);
    expect(lastChunk?.[1]).toHaveLength(70_000);
  });
});
