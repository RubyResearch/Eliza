/**
 * Trajectory storage — write operations.
 *
 * Handles saving, updating, deleting trajectories, installing the database
 * logger, and the DatabaseTrajectoryLogger service class.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  canonicalPromptForModelCall,
  composeToolDiagnosticRedactor,
  logger as coreLogger,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  omitUnvalidatedProviderSpans,
  parseTrajectorySemanticStages,
  projectProtectedModelCallValue,
  projectToolDiagnosticValue,
  type RecordedStage,
  recordedStageToSemanticStage,
  Service,
  sanitizeTrajectoryJsonObject,
  type TrajectorySemanticStageRecord,
  timeInferenceSpan,
} from "@elizaos/core";
import type {
  Trajectory,
  TrajectoryActionAttempt,
  TrajectoryExportResult,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectorySkillInvocation,
  TrajectoryStatus,
  TrajectoryStepKind,
} from "../types/trajectory.ts";
import { getDevTrajectoryExecutionOwnerId } from "./dev-trajectory-recovery.ts";
import {
  exportPersistedTrajectories,
  persistedTrajectoryToDetailRecord,
  type RuntimeTrajectoryExportOptions,
  trajectoryRowToListItem,
} from "./trajectory-export.ts";
import {
  appendCompleteTrajectoryTextRecords,
  asRecord,
  type CompleteStepOptions,
  capScriptForPersistence,
  computeBySource,
  createBaseTrajectory,
  enqueueStepWrite,
  enrichTrajectoryLlmCall,
  ensureStep,
  ensureTrajectoriesTable,
  executeRawSql,
  executeRawSqlTransaction,
  extractInsightsFromResponse,
  extractRequiredRows,
  hasRuntimeDb,
  lastWritePromises,
  loadTrajectoryById,
  loadTrajectoryByStepId,
  mergeMetadata,
  normalizeLlmCallPayload,
  normalizeProviderAccessPayload,
  normalizeStatus,
  normalizeStepId,
  normalizeTrajectoryMetadata,
  type PersistedLlmCall,
  type PersistedProviderAccess,
  type PersistedTrajectory,
  parsePersistedTrajectoryRow,
  patchedLoggers,
  pushChatExchange,
  readOrchestratorTrajectoryContext,
  resolveTrajectoryArchiveDirectory,
  resolveTrajectoryLogger,
  type StartStepOptions,
  saveTrajectory,
  shouldEnableTrajectoryLoggingByDefault,
  shouldRunObservationExtraction,
  shouldSuppressNoInputEmbeddingCall,
  sqlQuote,
  stepWriteQueues,
  toArchiveSafeTimestamp,
  toOptionalNumber,
  toText,
  warnRuntime,
  writeCompressedJsonlRows,
} from "./trajectory-internals.ts";

// Re-export types needed by consumers
export type {
  CompleteStepOptions,
  StartStepOptions,
} from "./trajectory-internals.ts";

function requireTrajectoryDatabase(runtime: IAgentRuntime): void {
  if (hasRuntimeDb(runtime)) return;
  throw new ElizaError("Trajectory storage is unavailable", {
    code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    context: { agentId: String(runtime.agentId) },
  });
}

function trajectoryOperationError(
  operation: string,
  error: unknown,
): ElizaError {
  return new ElizaError(`Trajectory ${operation} failed`, {
    code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
    cause: error,
    context: { operation },
  });
}

type BridgeStepState = {
  timestamp?: number;
  kind?: TrajectoryStepKind;
  parentStepId?: string;
  evaluatorName?: string;
};

type TrajectoryBridgeState = {
  trajectoryIdByStepId: Map<string, string>;
  activeStepIdByTrajectoryId: Map<string, string>;
};

const trajectoryBridgeStates = new WeakMap<object, TrajectoryBridgeState>();
// closedAt anchors the age of any capture that arrives after terminalization;
// rejects dedupes the reporting so a retrying caller logs once, not per attempt.
type ClosedTrajectoryStep = { closedAt: number; rejects: number };
const closedTrajectoryStepIds = new WeakMap<
  object,
  Map<string, ClosedTrajectoryStep>
>();
const stoppingTrajectoryBridges = new WeakSet<object>();
// runtimeInstanceId can be a stable installation identity. Only this private
// registry plus a fresh, insert-only row token establishes shutdown ownership.
const ownedTrajectoryStarts = new WeakMap<object, Map<string, string>>();
const trajectoryBridgeStopPromises = new WeakMap<object, Promise<void>>();
const MAX_CLOSED_TRAJECTORY_STEP_IDS = 10_000;

function releaseOwnedTrajectoryStart(
  runtime: IAgentRuntime,
  trajectoryId: string,
  token: unknown,
): void {
  const owned = ownedTrajectoryStarts.get(runtime as object);
  if (typeof token === "string" && owned?.get(trajectoryId) === token) {
    owned.delete(trajectoryId);
  }
}

async function saveNewOwnedTrajectory(
  runtime: IAgentRuntime,
  trajectory: PersistedTrajectory,
  options: { changedStepIds: string[]; updateLegacySnapshot?: boolean },
): Promise<void> {
  const executionOwnerId = await getDevTrajectoryExecutionOwnerId(runtime);
  const token = randomUUID();
  delete trajectory.metadata.runtimeExecutionOwnerId;
  trajectory.metadata = {
    ...trajectory.metadata,
    runtimeInstanceId: runtime.runtimeInstanceId,
    runtimeTrajectoryOwnerId: token,
    ...(executionOwnerId ? { runtimeExecutionOwnerId: executionOwnerId } : {}),
  };
  let owned = ownedTrajectoryStarts.get(runtime as object);
  if (!owned) {
    owned = new Map();
    ownedTrajectoryStarts.set(runtime as object, owned);
  }
  // Register before the accepted insert: deletion may commit before its promise
  // resumes. A failed older insert must not release a newer same-ID creator.
  owned.set(trajectory.id, token);
  try {
    await saveTrajectory(runtime, trajectory, { ...options, createOnly: true });
    if (trajectory.status !== "active") {
      releaseOwnedTrajectoryStart(runtime, trajectory.id, token);
    }
  } catch (error) {
    releaseOwnedTrajectoryStart(runtime, trajectory.id, token);
    throw error;
  }
}

async function settleOwnedTrajectoryStart(
  runtime: IAgentRuntime,
  trajectoryId: string,
  token: string,
): Promise<void> {
  await settleTrajectoryStart(runtime, trajectoryId, token);
  // A rolled-back transaction retains its token for an explicit stop retry.
  releaseOwnedTrajectoryStart(runtime, trajectoryId, token);
}

/** @internal Only the dev recovery coordinator supplies confirmed-exit owners. */
export async function settleExitedTrajectoryForDevRecovery(
  runtime: IAgentRuntime,
  trajectoryId: string,
  token: string,
  executionOwnerId: string,
): Promise<void> {
  await settleTrajectoryStart(runtime, trajectoryId, token, executionOwnerId);
}

async function settleTrajectoryStart(
  runtime: IAgentRuntime,
  trajectoryId: string,
  token: string,
  executionOwnerId?: string,
): Promise<void> {
  await executeRawSqlTransaction(runtime, async (execute) => {
    const result = await execute(
      `SELECT * FROM trajectories WHERE id = ${sqlQuote(trajectoryId)}
       AND agent_id = ${sqlQuote(runtime.agentId)} FOR UPDATE`,
    );
    const row = asRecord(
      extractRequiredRows(result, {
        operation: "settle owned trajectory",
        trajectoryId,
      })[0],
    );
    if (!row) return;
    const trajectory = parsePersistedTrajectoryRow(row, trajectoryId);
    if (
      trajectory.status !== "active" ||
      trajectory.metadata.runtimeInstanceId !== runtime.runtimeInstanceId ||
      (executionOwnerId !== undefined &&
        trajectory.metadata.runtimeExecutionOwnerId !== executionOwnerId)
    )
      return;

    if (trajectory.metadata.runtimeTrajectoryOwnerId !== token) {
      if (executionOwnerId !== undefined) {
        throw new ElizaError(
          "Exited execution trajectory changed its row ownership token",
          {
            code: "DEV_TRAJECTORY_RECOVERY_REJECTED",
            context: { trajectoryId },
          },
        );
      }
      return;
    }

    const now = Date.now();
    const endTime = Math.max(now, trajectory.startTime);
    // Dedicated step rows are recorded payloads, not live ownership indexes.
    // Keep every payload and counter intact; only settle parent lifecycle fields.
    await execute(
      `UPDATE trajectories SET status = 'terminated', end_time = ${endTime},
       duration_ms = ${endTime - trajectory.startTime},
       metrics_json = ${sqlQuote(JSON.stringify({ ...trajectory.metrics, finalStatus: "terminated" }))},
       updated_at = ${sqlQuote(nextTrajectoryUpdatedAt(trajectory.updatedAt, now))}
       WHERE id = ${sqlQuote(trajectoryId)} AND agent_id = ${sqlQuote(runtime.agentId)}
       AND status = 'active'`,
    );
  });
}

function stopTrajectoryBridge(runtime: IAgentRuntime): Promise<void> {
  const key = runtime as object;
  stoppingTrajectoryBridges.add(key);
  const existing = trajectoryBridgeStopPromises.get(key);
  if (existing) return existing;
  const stopping = (async () => {
    const failures: unknown[] = [];
    const observed = new Set<Promise<void>>();
    // Drain every accepted queue even when one write fails. Cache removal is
    // identity-checked so an already reported rejection cannot poison retries.
    while (true) {
      const last = lastWritePromises.get(key);
      const pending = [
        ...(stepWriteQueues.get(key)?.values() ?? []),
        ...(last ? [last] : []),
      ];
      const snapshot = [...new Set(pending)].filter(
        (promise) => !observed.has(promise),
      );
      if (snapshot.length === 0) break;
      for (const promise of snapshot) observed.add(promise);
      const results = await Promise.allSettled(snapshot);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (last && lastWritePromises.get(key) === last)
        lastWritePromises.delete(key);
    }
    for (const [trajectoryId, token] of ownedTrajectoryStarts.get(key) ?? []) {
      try {
        await settleOwnedTrajectoryStart(runtime, trajectoryId, token);
      } catch (error) {
        // error-policy:J2 Cleanup must retain failed ownership and report every
        // failure after draining and settling the other independently owned runs.
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Trajectory shutdown persistence failed",
      );
  })();
  trajectoryBridgeStopPromises.set(key, stopping);
  void stopping
    .finally(() => {
      if (trajectoryBridgeStopPromises.get(key) === stopping)
        trajectoryBridgeStopPromises.delete(key);
    })
    .catch(() => {
      /* The caller receives the original shutdown rejection. */
    });
  return stopping;
}

function rememberClosedTrajectoryStep(
  runtime: IAgentRuntime,
  stepId: string,
): ClosedTrajectoryStep {
  const runtimeKey = runtime as object;
  let closed = closedTrajectoryStepIds.get(runtimeKey);
  if (!closed) {
    closed = new Map<string, ClosedTrajectoryStep>();
    closedTrajectoryStepIds.set(runtimeKey, closed);
  }
  // Refresh LRU position but keep the original close time — age must measure
  // from terminalization, not from the most recent rejected retry.
  const entry = closed.get(stepId) ?? { closedAt: Date.now(), rejects: 0 };
  closed.delete(stepId);
  closed.set(stepId, entry);
  while (closed.size > MAX_CLOSED_TRAJECTORY_STEP_IDS) {
    const oldest = closed.keys().next().value;
    if (typeof oldest !== "string") break;
    closed.delete(oldest);
  }
  return entry;
}

function isClosedTrajectoryStep(
  runtime: IAgentRuntime,
  stepId: string,
): boolean {
  return closedTrajectoryStepIds.get(runtime as object)?.has(stepId) === true;
}

function acceptsNewTrajectoryCapture(
  runtime: IAgentRuntime,
  enabled: boolean,
): boolean {
  return enabled && !stoppingTrajectoryBridges.has(runtime as object);
}

function reportLateTrajectoryCapture(
  runtime: IAgentRuntime,
  stepId: string,
  captureType: "llm" | "provider" | "semanticStage",
  purpose?: string,
): void {
  const entry = rememberClosedTrajectoryStep(runtime, stepId);
  entry.rejects += 1;
  const ageMs = Date.now() - entry.closedAt;
  const age = `${Math.round(ageMs / 1000)}s`;
  const detail = `step=${stepId.slice(0, 12)} type=${captureType} purpose=${purpose ?? "unknown"} age=${age}`;
  // The voice-gate rephrase races its own turn's terminalization by design
  // (delivery does not wait for the diagnostic copy); a same-instant reject
  // is expected once per racy turn and had the overnight watch paging on
  // every boot. Anything older still reports in full.
  if (ageMs < 2_000 || (purpose === "voice-gate-rephrase" && ageMs < 5_000)) {
    // Sub-2s rejects are the designed delivery/terminalization race (the turn
    // does not wait for diagnostic copies) — same-instant `purpose=action`
    // pairs joined the rephrase class on every build turn. Older captures
    // still report in full; they are the real leak signal.
    runtime.logger.debug?.(
      { stepId, captureType, purpose, ageMs },
      `[trajectory-db] Expected capture-terminalization race (${detail})`,
    );
    return;
  }
  if (entry.rejects > 1) {
    // A retrying caller re-submits the same rejected capture; one full report
    // per step is signal, the repeats are noise.
    runtime.logger.debug?.(
      { stepId, captureType, purpose, rejects: entry.rejects },
      `[trajectory-db] Repeated late capture (${detail} rejects=${entry.rejects})`,
    );
    return;
  }
  // Context inline in the message: the pretty log transport drops structured
  // payloads, and diagnosing this race blind has already cost wrong fixes.
  const error = new ElizaError(
    `Trajectory capture arrived after terminalization (${detail})`,
    {
      code: "TRAJECTORY_OWNER_CLOSED",
      context: { stepId, captureType, purpose, closedAt: entry.closedAt },
    },
  );
  warnRuntime(runtime, `Rejected late trajectory capture (${detail})`, error);
  runtime.reportError("TrajectoryStorage.lateCapture", error, {
    stepId,
    captureType,
    diagnosticOnly: true,
  });
}

function acceptsTrajectoryStepCapture(
  runtime: IAgentRuntime,
  enabled: boolean,
  stepId: string,
  captureType: "llm" | "provider" | "semanticStage",
  purpose?: string,
): boolean {
  if (!acceptsNewTrajectoryCapture(runtime, enabled)) return false;
  if (!isClosedTrajectoryStep(runtime, stepId)) return true;
  reportLateTrajectoryCapture(runtime, stepId, captureType, purpose);
  return false;
}

function reportInvalidTrajectoryCapture(
  runtime: IAgentRuntime,
  captureType: "llm" | "provider" | "semanticStage",
  error: unknown,
): void {
  warnRuntime(runtime, "Rejected invalid trajectory capture", error);
  runtime.reportError("TrajectoryStorage.captureValidation", error, {
    captureType,
    diagnosticOnly: true,
  });
}

function readRequiredCount(
  result: unknown,
  field: string,
  context: Record<string, unknown> = {},
): number {
  const row = asRecord(extractRequiredRows(result, context)[0]);
  const value = toOptionalNumber(row?.[field]);
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new ElizaError("Trajectory count row is invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context: { ...context, field },
    });
  }
  return value;
}

function readRequiredNonNegativeNumber(
  row: Record<string, unknown> | null,
  field: string,
  context: Record<string, unknown> = {},
): number {
  const value = toOptionalNumber(row?.[field]);
  if (value === undefined || value < 0) {
    throw new ElizaError("Trajectory numeric row is invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context: { ...context, field },
    });
  }
  return value;
}

// startStep must return before its database write can run, so child ownership
// stays in runtime memory until terminalization has drained that owner's queue.
function getTrajectoryBridgeState(
  runtime: IAgentRuntime,
): TrajectoryBridgeState {
  const runtimeKey = runtime as object;
  let state = trajectoryBridgeStates.get(runtimeKey);
  if (!state) {
    state = {
      trajectoryIdByStepId: new Map<string, string>(),
      activeStepIdByTrajectoryId: new Map<string, string>(),
    };
    trajectoryBridgeStates.set(runtimeKey, state);
  }
  return state;
}

function rememberTrajectoryStep(
  runtime: IAgentRuntime,
  trajectoryId: string,
  stepId: string,
): void {
  const state = getTrajectoryBridgeState(runtime);
  closedTrajectoryStepIds.get(runtime as object)?.delete(trajectoryId);
  closedTrajectoryStepIds.get(runtime as object)?.delete(stepId);
  state.trajectoryIdByStepId.set(trajectoryId, trajectoryId);
  state.trajectoryIdByStepId.set(stepId, trajectoryId);
  state.activeStepIdByTrajectoryId.set(trajectoryId, stepId);
}

function resolveBridgeTrajectoryId(
  runtime: IAgentRuntime,
  stepIdOrTrajectoryId: string,
): string {
  return (
    trajectoryBridgeStates
      .get(runtime as object)
      ?.trajectoryIdByStepId.get(stepIdOrTrajectoryId) ?? stepIdOrTrajectoryId
  );
}

function releaseAllTrajectoryBridgeState(runtime: IAgentRuntime): void {
  const state = trajectoryBridgeStates.get(runtime as object);
  if (state) {
    for (const stepId of state.trajectoryIdByStepId.keys()) {
      rememberClosedTrajectoryStep(runtime, stepId);
    }
  }
  trajectoryBridgeStates.delete(runtime as object);
}

function releaseTrajectoryBridgeState(
  runtime: IAgentRuntime,
  trajectoryId: string,
): void {
  const runtimeKey = runtime as object;
  rememberClosedTrajectoryStep(runtime, trajectoryId);
  const state = trajectoryBridgeStates.get(runtimeKey);
  if (!state) return;

  state.activeStepIdByTrajectoryId.delete(trajectoryId);
  for (const [stepId, ownerId] of state.trajectoryIdByStepId) {
    if (ownerId === trajectoryId) {
      rememberClosedTrajectoryStep(runtime, stepId);
      state.trajectoryIdByStepId.delete(stepId);
    }
  }
  if (
    state.trajectoryIdByStepId.size === 0 &&
    state.activeStepIdByTrajectoryId.size === 0
  ) {
    trajectoryBridgeStates.delete(runtimeKey);
  }
}

/** Reports bridge ownership cardinality without exposing mutable state. */
export function __getTrajectoryBridgeStateCountsForTests(
  runtime: IAgentRuntime,
): { stepMappings: number; activeOwners: number } {
  const state = trajectoryBridgeStates.get(runtime as object);
  return {
    stepMappings: state?.trajectoryIdByStepId.size ?? 0,
    activeOwners: state?.activeStepIdByTrajectoryId.size ?? 0,
  };
}

function normalizeJsonRecord(
  value: unknown,
  field:
    | "parameters"
    | "result"
    | "rewardComponents"
    | "finalMetrics"
    | "providerData"
    | "providerQuery",
): Record<string, JsonValue> {
  const record = sanitizeTrajectoryJsonObject(value);
  if (!record) {
    throw new ElizaError(`Trajectory ${field} must be an object`, {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field },
    });
  }
  return record as Record<string, JsonValue>;
}

function normalizeSettledAction(
  value: unknown,
  rewardInfo?: unknown,
): TrajectoryActionAttempt {
  const action = asRecord(value);
  const actionType =
    typeof action?.actionType === "string" ? action.actionType.trim() : "";
  const actionName =
    typeof action?.actionName === "string" ? action.actionName.trim() : "";
  if (
    !action ||
    !actionType ||
    !actionName ||
    typeof action.success !== "boolean"
  ) {
    throw new ElizaError("Trajectory action settlement is incomplete", {
      code: "TRAJECTORY_ACTION_SETTLEMENT_INVALID",
      context: { actionName, actionType },
    });
  }

  const rewardRecord =
    rewardInfo === undefined ? undefined : asRecord(rewardInfo);
  if (rewardInfo !== undefined && !rewardRecord) {
    throw new ElizaError("Trajectory reward settlement is invalid", {
      code: "TRAJECTORY_ACTION_SETTLEMENT_INVALID",
      context: { actionName, actionType, field: "rewardInfo" },
    });
  }
  const rewardValue = rewardRecord?.reward;
  if (
    rewardValue !== undefined &&
    (typeof rewardValue !== "number" || !Number.isFinite(rewardValue))
  ) {
    throw new ElizaError("Trajectory reward settlement is invalid", {
      code: "TRAJECTORY_ACTION_SETTLEMENT_INVALID",
      context: { actionName, actionType, field: "reward" },
    });
  }
  for (const field of ["error", "reasoning", "llmCallId"] as const) {
    if (action[field] !== undefined && typeof action[field] !== "string") {
      throw new ElizaError("Trajectory action settlement is invalid", {
        code: "TRAJECTORY_ACTION_SETTLEMENT_INVALID",
        context: { actionName, actionType, field },
      });
    }
  }
  return {
    attemptId: randomUUID(),
    timestamp: Date.now(),
    actionType,
    actionName,
    parameters: normalizeJsonRecord(action.parameters, "parameters"),
    success: action.success,
    ...(action.result !== undefined
      ? { result: normalizeJsonRecord(action.result, "result") }
      : {}),
    ...(typeof action.error === "string" ? { error: action.error } : {}),
    ...(typeof action.reasoning === "string"
      ? { reasoning: action.reasoning }
      : {}),
    ...(typeof action.llmCallId === "string"
      ? { llmCallId: action.llmCallId }
      : {}),
    ...(typeof rewardValue === "number"
      ? { immediateReward: rewardValue }
      : {}),
  };
}

const pendingChildStepBatches = new WeakMap<
  object,
  Map<
    string,
    {
      owner: object;
      starts: Array<BridgeStepState & { stepId: string; timestamp: number }>;
      write: Promise<void>;
    }
  >
>();

function startChildTrajectoryStep(
  runtime: IAgentRuntime,
  owner: object,
  trajectoryId: string,
  state: BridgeStepState = {},
  shouldWrite: () => boolean = () => true,
): string {
  const stateRecord = asRecord(state);
  if (!stateRecord) {
    throw new ElizaError("Trajectory child step state is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "state" },
    });
  }
  const timestamp =
    stateRecord.timestamp === undefined
      ? Date.now()
      : typeof stateRecord.timestamp === "number" &&
          Number.isFinite(stateRecord.timestamp) &&
          stateRecord.timestamp >= 0
        ? stateRecord.timestamp
        : null;
  const kind = stateRecord.kind;
  const parentStepId =
    stateRecord.parentStepId === undefined
      ? undefined
      : normalizeStepId(stateRecord.parentStepId);
  const evaluatorName =
    stateRecord.evaluatorName === undefined
      ? undefined
      : typeof stateRecord.evaluatorName === "string" &&
          stateRecord.evaluatorName.trim().length > 0
        ? stateRecord.evaluatorName.trim()
        : null;
  if (
    timestamp === null ||
    (kind !== undefined &&
      kind !== "llm" &&
      kind !== "action" &&
      kind !== "evaluator") ||
    (stateRecord.parentStepId !== undefined && !parentStepId) ||
    evaluatorName === null
  ) {
    throw new ElizaError("Trajectory child step state is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "state" },
    });
  }
  const normalizedParentStepId =
    typeof parentStepId === "string" ? parentStepId : undefined;
  const normalizedEvaluatorName =
    typeof evaluatorName === "string" ? evaluatorName : undefined;
  const normalizedTrajectoryId = normalizeStepId(
    resolveBridgeTrajectoryId(runtime, trajectoryId),
  );
  if (!normalizedTrajectoryId) {
    throw new ElizaError("Trajectory child step requires a parent trajectory", {
      code: "TRAJECTORY_PARENT_REQUIRED",
    });
  }

  const stepId = randomUUID();
  rememberTrajectoryStep(runtime, normalizedTrajectoryId, stepId);
  const start: BridgeStepState & { stepId: string; timestamp: number } = {
    stepId,
    timestamp,
    kind,
    parentStepId: normalizedParentStepId,
    evaluatorName: normalizedEvaluatorName,
  };
  let batches = pendingChildStepBatches.get(runtime);
  if (!batches) {
    batches = new Map();
    pendingChildStepBatches.set(runtime, batches);
  }
  const pending = batches.get(normalizedTrajectoryId);
  // A capture, settlement, different logger, or started write is an ordering
  // barrier. Only adjacent child starts still waiting on the same owner merge.
  if (
    pending?.owner === owner &&
    stepWriteQueues.get(runtime)?.get(normalizedTrajectoryId) === pending.write
  ) {
    pending.starts.push(start);
    lastWritePromises.set(runtime, pending.write);
    return stepId;
  }
  const starts = [start];
  const writePromise = enqueueStepWrite(
    runtime,
    normalizedTrajectoryId,
    async () => {
      // Freeze batch membership before the first await; arrivals during I/O
      // belong to a later queue entry rather than mutating this transaction.
      if (batches.get(normalizedTrajectoryId)?.write === writePromise) {
        batches.delete(normalizedTrajectoryId);
        if (batches.size === 0) pendingChildStepBatches.delete(runtime);
      }
      if (!shouldWrite()) return;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;
      for (
        let attempt = 0;
        attempt < MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS;
        attempt += 1
      ) {
        const trajectory = await timeInferenceSpan(
          "trajectory:child-start-batch-load",
          () => loadTrajectoryById(runtime, normalizedTrajectoryId),
          { count: starts.length },
        );
        if (!trajectory) {
          throw new ElizaError(
            "Parent trajectory is unavailable for child step",
            {
              code: "TRAJECTORY_PARENT_NOT_FOUND",
              context: { trajectoryId: normalizedTrajectoryId, stepId },
            },
          );
        }
        const expectedUpdatedAt = trajectory.updatedAt;
        const changedStepIds = new Set<string>();
        for (const child of starts) {
          const step = ensureStep(trajectory, child.stepId, child.timestamp);
          changedStepIds.add(child.stepId);
          if (child.kind !== undefined) step.kind = child.kind;
          if (child.evaluatorName !== undefined) {
            step.evaluatorName = child.evaluatorName;
          }
          if (child.parentStepId !== undefined) {
            step.parentStepId = child.parentStepId;
            const parentStep = ensureStep(
              trajectory,
              child.parentStepId,
              child.timestamp,
            );
            changedStepIds.add(child.parentStepId);
            if (!parentStep.childSteps?.includes(child.stepId)) {
              parentStep.childSteps = [
                ...(parentStep.childSteps ?? []),
                child.stepId,
              ];
            }
          }
          trajectory.startTime = Math.min(
            trajectory.startTime,
            child.timestamp,
          );
          trajectory.updatedAt = nextTrajectoryUpdatedAt(
            expectedUpdatedAt,
            child.timestamp,
          );
        }
        try {
          // The loaded parent must still be active and at this revision. Updating
          // it also avoids sending an unused full legacy snapshot in an upsert.
          await timeInferenceSpan(
            "trajectory:child-start-batch-persist",
            () =>
              saveTrajectory(runtime, trajectory, {
                changedStepIds: [...changedStepIds],
                requireActiveExisting: true,
                expectedUpdatedAt,
              }),
            { count: starts.length },
          );
          return;
        } catch (error) {
          // error-policy:J7 Reload active conflicts so concurrent children and
          // captures survive; other failures reject the atomic batch unchanged.
          if (
            asRecord(error)?.code === "TRAJECTORY_WRITE_CONFLICT" &&
            attempt + 1 < MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS
          ) {
            await yieldTrajectoryWriteRetry();
            continue;
          }
          throw error;
        }
      }
    },
  );
  batches.set(normalizedTrajectoryId, { owner, starts, write: writePromise });
  lastWritePromises.set(runtime as object, writePromise);
  return stepId;
}

/**
 * Final persistence boundary for the agent DB bridge: every patched
 * `completeStep` caller funnels through here, so the complete settlement,
 * including interceptor reasoning and future text fields, is projected through
 * composed runtime-known + tool-shape redaction before the row is written.
 * Identity, numeric, and boolean fields survive untouched for correlation.
 */
export function projectSettledActionDiagnostics(
  runtime: IAgentRuntime,
  action: TrajectoryActionAttempt,
): TrajectoryActionAttempt {
  const redactDiagnosticText = composeToolDiagnosticRedactor(runtime);
  const projected = projectToolDiagnosticValue(
    action,
    redactDiagnosticText,
  ) as TrajectoryActionAttempt;
  return {
    ...projected,
    attemptId: action.attemptId,
    timestamp: action.timestamp,
    actionType: action.actionType,
    actionName: action.actionName,
    ...(typeof action.llmCallId === "string"
      ? { llmCallId: action.llmCallId }
      : {}),
  };
}

/**
 * Final-persistence projection for an agent-bridge LLM capture. Correlation
 * identity remains exact; diagnostic payloads are scrubbed structurally, and
 * message-indexed provider spans are dropped whenever message text changes.
 */
export function projectLlmCallDiagnostics(
  runtime: IAgentRuntime,
  rawParams: Record<string, unknown>,
): Record<string, unknown> {
  const redactDiagnosticText = composeToolDiagnosticRedactor(runtime);
  const projectedParams = projectProtectedModelCallValue(
    rawParams,
    redactDiagnosticText,
  );
  const projectedPrompt =
    typeof (
      projectedParams.prompt ??
      projectedParams.userPrompt ??
      projectedParams.input
    ) === "string"
      ? ((projectedParams.prompt ??
          projectedParams.userPrompt ??
          projectedParams.input) as string)
      : undefined;
  const rawPrompt =
    typeof (rawParams.prompt ?? rawParams.userPrompt ?? rawParams.input) ===
    "string"
      ? ((rawParams.prompt ??
          rawParams.userPrompt ??
          rawParams.input) as string)
      : undefined;
  const attributionInputChanged =
    canonicalPromptForModelCall({
      messages: Array.isArray(projectedParams.messages)
        ? projectedParams.messages
        : undefined,
      prompt: projectedPrompt,
    }) !==
    canonicalPromptForModelCall({
      messages: Array.isArray(rawParams.messages)
        ? rawParams.messages
        : undefined,
      prompt: rawPrompt,
    });
  return {
    ...projectedParams,
    ...(typeof rawParams.callId === "string"
      ? { callId: rawParams.callId }
      : {}),
    ...(typeof rawParams.runId === "string" ? { runId: rawParams.runId } : {}),
    ...(typeof rawParams.roomId === "string"
      ? { roomId: rawParams.roomId }
      : {}),
    ...(typeof rawParams.messageId === "string"
      ? { messageId: rawParams.messageId }
      : {}),
    ...(typeof rawParams.executionTraceId === "string"
      ? { executionTraceId: rawParams.executionTraceId }
      : {}),
    ...(attributionInputChanged
      ? {
          providerAttributions: omitUnvalidatedProviderSpans(
            projectedParams.providerAttributions as Parameters<
              typeof omitUnvalidatedProviderSpans
            >[0],
          ),
        }
      : {}),
  };
}

function completeTrajectoryAction(
  runtime: IAgentRuntime,
  trajectoryId: string,
  stepId: string,
  actionValue: unknown,
  rewardInfo?: unknown,
  shouldWrite: () => boolean = () => true,
): void {
  const normalizedTrajectoryId = normalizeStepId(
    resolveBridgeTrajectoryId(runtime, trajectoryId),
  );
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedTrajectoryId || !normalizedStepId) {
    throw new ElizaError(
      "Trajectory action settlement requires its real step",
      {
        code: "TRAJECTORY_ACTION_STEP_REQUIRED",
      },
    );
  }
  rememberTrajectoryStep(runtime, normalizedTrajectoryId, normalizedStepId);
  const action = projectSettledActionDiagnostics(
    runtime,
    normalizeSettledAction(actionValue, rewardInfo),
  );
  const rewardComponentsValue = asRecord(rewardInfo)?.components;
  const rewardComponents =
    rewardComponentsValue === undefined
      ? undefined
      : normalizeJsonRecord(rewardComponentsValue, "rewardComponents");
  const writePromise = enqueueStepWrite(
    runtime,
    normalizedTrajectoryId,
    async () => {
      if (!shouldWrite()) return;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;
      const trajectory = await loadTrajectoryById(
        runtime,
        normalizedTrajectoryId,
      );
      if (!trajectory) {
        throw new ElizaError(
          "Parent trajectory is unavailable at action settlement",
          {
            code: "TRAJECTORY_PARENT_NOT_FOUND",
            context: {
              trajectoryId: normalizedTrajectoryId,
              stepId: normalizedStepId,
            },
          },
        );
      }
      const step = ensureStep(trajectory, normalizedStepId, action.timestamp);
      step.kind = "action";
      step.action = action;
      if (action.immediateReward !== undefined) {
        trajectory.totalReward += action.immediateReward;
      }
      if (rewardComponents !== undefined) {
        trajectory.rewardComponents = {
          ...trajectory.rewardComponents,
          ...rewardComponents,
        };
      }
      trajectory.updatedAt = new Date(action.timestamp).toISOString();
      await saveTrajectory(runtime, trajectory, {
        changedStepIds: [normalizedStepId],
      });
    },
  );
  lastWritePromises.set(runtime as object, writePromise);
}

async function terminalizeBridgeTrajectory(
  runtime: IAgentRuntime,
  trajectoryId: string,
  status: TrajectoryStatus,
  finalMetrics?: Record<string, unknown>,
  shouldWrite: () => boolean = () => true,
): Promise<void> {
  let ownedToken: string | undefined;
  const writePromise = enqueueStepWrite(runtime, trajectoryId, async () => {
    if (!shouldWrite()) return;
    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) return;

    ownedToken = ownedTrajectoryStarts
      .get(runtime as object)
      ?.get(trajectoryId);
    await writeCompletedTrajectoryStep({
      runtime,
      stepId: trajectoryId,
      status,
      createStepIfMissing: false,
      finalMetrics,
    });
  });

  lastWritePromises.set(runtime as object, writePromise);
  await writePromise;
  // A capture can chain behind terminalization while its database work is in
  // flight; drain the newest tail before child routing is released. Failed
  // durability retains ownership so an explicit retry can address the same
  // parent rather than fabricating a new route.
  await flushTrajectoryWrites(runtime, trajectoryId);
  releaseOwnedTrajectoryStart(runtime, trajectoryId, ownedToken);
  releaseTrajectoryBridgeState(runtime, trajectoryId);
}

// ---------------------------------------------------------------------------
// appendLlmCall / appendProviderAccesses
// ---------------------------------------------------------------------------

function nextTrajectoryUpdatedAt(
  persistedUpdatedAt: string,
  candidateTimestamp: number,
): string {
  const persistedTimestamp = Date.parse(persistedUpdatedAt);
  return new Date(
    Math.max(
      candidateTimestamp,
      Number.isFinite(persistedTimestamp)
        ? persistedTimestamp + 1
        : candidateTimestamp,
    ),
  ).toISOString();
}

async function yieldTrajectoryWriteRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS = 3;

type ActiveCaptureRetryState = {
  attempt: number;
  recordId: string;
  timestamp: number;
};

async function saveActiveTrajectoryCapture(
  runtime: IAgentRuntime,
  trajectory: PersistedTrajectory,
  stepId: string,
  captureType: "llm" | "provider" | "semanticStage",
  expectedUpdatedAt: string,
): Promise<"saved" | "closed" | "conflict"> {
  try {
    await saveTrajectory(runtime, trajectory, {
      changedStepIds: [stepId],
      requireActiveExisting: true,
      expectedUpdatedAt,
    });
    return "saved";
  } catch (error) {
    // error-policy:J7 A terminal owner rejects late telemetry without failing
    // the agent loop; active version conflicts are retried by the capture owner.
    const errorCode = asRecord(error)?.code;
    if (errorCode === "TRAJECTORY_OWNER_CLOSED") {
      releaseTrajectoryBridgeState(runtime, trajectory.id);
      reportLateTrajectoryCapture(runtime, stepId, captureType);
      return "closed";
    }
    if (errorCode === "TRAJECTORY_WRITE_CONFLICT") {
      const latest = await loadTrajectoryByStepId(runtime, stepId);
      if (latest && latest.status !== "active") {
        releaseTrajectoryBridgeState(runtime, latest.id);
        reportLateTrajectoryCapture(runtime, stepId, captureType);
        return "closed";
      }
      if (latest) return "conflict";
    }
    throw error;
  }
}

async function appendLlmCall(
  runtime: IAgentRuntime,
  trajectoryId: string,
  stepId: string,
  rawParams: Record<string, unknown>,
  retryState?: ActiveCaptureRetryState,
): Promise<void> {
  if (shouldSuppressNoInputEmbeddingCall(rawParams)) return;

  const params = projectLlmCallDiagnostics(runtime, rawParams);

  const now =
    retryState?.timestamp ??
    (typeof params.timestamp === "number" ? params.timestamp : Date.now());
  const callId =
    retryState?.recordId ??
    (typeof params.callId === "string" ? params.callId : randomUUID());
  const attempt = retryState?.attempt ?? 0;
  const persisted = await loadTrajectoryByStepId(runtime, trajectoryId);
  if (!persisted && trajectoryId !== stepId) {
    throw new ElizaError("Parent trajectory is unavailable for LLM capture", {
      code: "TRAJECTORY_PARENT_NOT_FOUND",
      context: { trajectoryId, stepId },
    });
  }
  if (persisted && persisted.status !== "active") {
    releaseTrajectoryBridgeState(runtime, persisted.id);
    reportLateTrajectoryCapture(runtime, stepId, "llm");
    return;
  }
  const trajectory =
    persisted ?? createBaseTrajectory(trajectoryId, now, runtime.agentId);
  const expectedUpdatedAt = trajectory.updatedAt;

  // A retry may observe its own prior durable write after a transport-level
  // ambiguity. Record identity makes the operation idempotent across reloads.
  if (
    trajectory.steps.some((candidate) =>
      candidate.llmCalls.some(
        (candidateCall) => candidateCall.callId === callId,
      ),
    )
  ) {
    return;
  }

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  const orchestratorCtx = readOrchestratorTrajectoryContext(runtime);

  const fullResponse = params.response as string;
  const purpose = orchestratorCtx?.decisionType ?? (params.purpose as string);
  const insights = extractInsightsFromResponse(fullResponse, purpose);

  const step = ensureStep(trajectory, stepId, now);
  const call: PersistedLlmCall = enrichTrajectoryLlmCall({
    callId,
    timestamp: now,
    model: params.model as string,
    response: fullResponse,
    purpose,
    actionType: orchestratorCtx
      ? "orchestrator.useModel"
      : (params.actionType as string),
    ...(typeof params.stepType === "string"
      ? { stepType: params.stepType }
      : {}),
    ...(Array.isArray(params.tags) ? { tags: params.tags as string[] } : {}),
    ...(typeof params.provider === "string"
      ? { provider: params.provider }
      : {}),
    ...(typeof params.modelType === "string"
      ? { modelType: params.modelType }
      : {}),
    ...(typeof params.systemPrompt === "string"
      ? { systemPrompt: params.systemPrompt }
      : {}),
    ...(typeof (params.userPrompt ?? params.input) === "string"
      ? { userPrompt: (params.userPrompt ?? params.input) as string }
      : {}),
    ...(typeof (params.prompt ?? params.userPrompt ?? params.input) === "string"
      ? {
          prompt: (params.prompt ??
            params.userPrompt ??
            params.input) as string,
        }
      : {}),
    ...(Array.isArray(params.messages) ? { messages: params.messages } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    ...(params.toolChoice !== undefined
      ? { toolChoice: params.toolChoice }
      : {}),
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.responseSchema !== undefined
      ? { responseSchema: params.responseSchema }
      : {}),
    ...(params.providerOptions !== undefined
      ? { providerOptions: params.providerOptions }
      : {}),
    ...(Array.isArray(params.toolCalls) ? { toolCalls: params.toolCalls } : {}),
    ...(typeof params.finishReason === "string"
      ? { finishReason: params.finishReason }
      : {}),
    ...(params.providerMetadata !== undefined
      ? { providerMetadata: params.providerMetadata }
      : {}),
    ...(typeof params.temperature === "number"
      ? { temperature: params.temperature }
      : {}),
    ...(typeof params.maxTokens === "number"
      ? { maxTokens: params.maxTokens }
      : {}),
    ...(typeof params.latencyMs === "number"
      ? { latencyMs: params.latencyMs }
      : {}),
  });

  const promptTokens = toOptionalNumber(params.promptTokens);
  const completionTokens = toOptionalNumber(params.completionTokens);
  const cacheReadInputTokens = toOptionalNumber(params.cacheReadInputTokens);
  const cacheCreationInputTokens = toOptionalNumber(
    params.cacheCreationInputTokens,
  );
  if (promptTokens !== undefined) call.promptTokens = promptTokens;
  if (completionTokens !== undefined) call.completionTokens = completionTokens;
  if (cacheReadInputTokens !== undefined) {
    call.cacheReadInputTokens = cacheReadInputTokens;
  }
  if (cacheCreationInputTokens !== undefined) {
    call.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (typeof params.modelVersion === "string") {
    call.modelVersion = params.modelVersion;
  }
  if (typeof params.reasoning === "string") {
    call.reasoning = params.reasoning;
  }
  const topP = toOptionalNumber(params.topP);
  if (topP !== undefined) {
    call.topP = topP;
  }
  if (typeof params.modelSlot === "string") {
    call.modelSlot = params.modelSlot;
  }
  if (typeof params.runId === "string") {
    call.runId = params.runId;
  }
  if (typeof params.roomId === "string") {
    call.roomId = params.roomId;
  }
  if (typeof params.messageId === "string") {
    call.messageId = params.messageId;
  }
  if (typeof params.executionTraceId === "string") {
    call.executionTraceId = params.executionTraceId;
  }
  if (typeof params.createdAt === "string") {
    call.createdAt = params.createdAt;
  }
  if (typeof params.tokenUsageEstimated === "boolean") {
    call.tokenUsageEstimated = params.tokenUsageEstimated;
  }
  if (typeof params.maxTokensOmitted === "boolean") {
    call.maxTokensOmitted = params.maxTokensOmitted;
  }
  const reasoningTokens = toOptionalNumber(params.reasoningTokens);
  if (reasoningTokens !== undefined) {
    call.reasoningTokens = reasoningTokens;
  }
  if (Array.isArray(params.providerOrder)) {
    call.providerOrder = params.providerOrder as string[];
  }
  if (Array.isArray(params.providerAttributions)) {
    call.providerAttributions = params.providerAttributions as NonNullable<
      PersistedLlmCall["providerAttributions"]
    >;
  }

  step.llmCalls.push(call);
  // Direct legacy capture can lack child-start metadata, so evaluation purpose
  // remains a strict fallback for evaluator ownership.
  if (purpose === "evaluation") {
    step.kind = "evaluator";
    const evaluatorNameRaw = toText(params.evaluatorName, "");
    if (evaluatorNameRaw.length > 0) {
      step.evaluatorName = evaluatorNameRaw;
    }
  }
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = nextTrajectoryUpdatedAt(expectedUpdatedAt, now);

  if (insights.length > 0) {
    const meta = trajectory.metadata as Record<string, unknown>;
    meta.insights = appendCompleteTrajectoryTextRecords(
      meta.insights,
      insights,
      "insights",
    );
    trajectory.metadata = meta;
  }

  if (orchestratorCtx) {
    trajectory.source = "orchestrator";
    const meta = trajectory.metadata as Record<string, unknown>;
    meta.orchestrator = {
      decisionType: orchestratorCtx.decisionType,
      ...(orchestratorCtx.sessionId && {
        sessionId: orchestratorCtx.sessionId,
      }),
      ...(orchestratorCtx.taskLabel && {
        taskLabel: orchestratorCtx.taskLabel,
      }),
      ...(orchestratorCtx.repo && {
        repo: orchestratorCtx.repo,
      }),
      ...(orchestratorCtx.workdir && {
        workdir: orchestratorCtx.workdir,
      }),
      ...(orchestratorCtx.originalTask && {
        originalTask: orchestratorCtx.originalTask,
      }),
    };
    trajectory.metadata = meta;
  }

  const saveResult = await saveActiveTrajectoryCapture(
    runtime,
    trajectory,
    stepId,
    "llm",
    expectedUpdatedAt,
  );
  if (saveResult === "closed") return;
  if (saveResult === "conflict") {
    if (attempt + 1 >= MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS) {
      throw new ElizaError("Trajectory changed during LLM capture", {
        code: "TRAJECTORY_WRITE_CONFLICT",
        context: {
          trajectoryId: trajectory.id,
          stepId,
          attempts: MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS,
        },
      });
    }
    await yieldTrajectoryWriteRetry();
    await appendLlmCall(runtime, trajectoryId, stepId, params, {
      attempt: attempt + 1,
      recordId: callId,
      timestamp: now,
    });
    return;
  }
  if (
    !orchestratorCtx &&
    trajectory.source === "chat" &&
    shouldRunObservationExtraction(runtime)
  ) {
    pushChatExchange(runtime, {
      userPrompt: toText(params.userPrompt ?? params.input, ""),
      response: fullResponse,
      trajectoryId: trajectory.id,
      timestamp: now,
    });
  }
}

type PendingProviderCapture = {
  params: Record<string, unknown>;
  recordId: string;
  timestamp: number;
};

const pendingProviderBatches = new WeakMap<
  object,
  Map<
    string,
    {
      owner: object;
      stepId: string;
      captures: PendingProviderCapture[];
      write: Promise<void>;
    }
  >
>();

/** Coalesce only adjacent, not-yet-started writes on the existing owner queue. */
function enqueueProviderAccess(
  runtime: IAgentRuntime,
  owner: object,
  trajectoryId: string,
  stepId: string,
  params: Record<string, unknown>,
  isEnabled: () => boolean,
): Promise<void> {
  let batches = pendingProviderBatches.get(runtime);
  if (!batches) {
    batches = new Map();
    pendingProviderBatches.set(runtime, batches);
  }
  const capture = {
    params,
    recordId:
      typeof params.providerId === "string" ? params.providerId : randomUUID(),
    timestamp:
      typeof params.timestamp === "number" ? params.timestamp : Date.now(),
  };
  const pending = batches.get(trajectoryId);
  if (
    pending?.owner === owner &&
    pending.stepId === stepId &&
    stepWriteQueues.get(runtime)?.get(trajectoryId) === pending.write
  ) {
    pending.captures.push(capture);
    return pending.write;
  }

  const captures = [capture];
  const write = enqueueStepWrite(runtime, trajectoryId, async () => {
    // Once execution starts, new captures need their own queued batch. Do not
    // remove a newer batch that followed an intervening LLM/lifecycle write.
    if (batches.get(trajectoryId)?.write === write) {
      batches.delete(trajectoryId);
      if (batches.size === 0) pendingProviderBatches.delete(runtime);
    }
    if (!isEnabled()) return;
    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) return;
    await appendProviderAccesses(runtime, trajectoryId, stepId, captures);
  });
  batches.set(trajectoryId, { owner, stepId, captures, write });
  return write;
}

async function appendProviderAccesses(
  runtime: IAgentRuntime,
  trajectoryId: string,
  stepId: string,
  captures: readonly PendingProviderCapture[],
  attempt = 0,
): Promise<void> {
  if (captures.length === 0) return;
  const persisted = await loadTrajectoryByStepId(runtime, trajectoryId);
  if (!persisted && trajectoryId !== stepId) {
    throw new ElizaError(
      "Parent trajectory is unavailable for provider capture",
      {
        code: "TRAJECTORY_PARENT_NOT_FOUND",
        context: { trajectoryId, stepId },
      },
    );
  }
  if (persisted && persisted.status !== "active") {
    releaseTrajectoryBridgeState(runtime, persisted.id);
    for (let index = 0; index < captures.length; index++) {
      reportLateTrajectoryCapture(runtime, stepId, "provider");
    }
    return;
  }
  const trajectory =
    persisted ??
    createBaseTrajectory(trajectoryId, captures[0].timestamp, runtime.agentId);
  const expectedUpdatedAt = trajectory.updatedAt;

  const seenIds = new Set(
    trajectory.steps.flatMap((step) =>
      step.providerAccesses.map((access) => access.providerId),
    ),
  );
  let changed = false;

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  for (const { params, recordId: providerId, timestamp: now } of captures) {
    if (seenIds.has(providerId)) continue;
    const step = ensureStep(trajectory, stepId, now);
    const access: PersistedProviderAccess = {
      providerId,
      providerName: params.providerName as string,
      timestamp: now,
      ...(typeof params.startedAt === "number"
        ? { startedAt: params.startedAt }
        : {}),
      ...(typeof params.endedAt === "number"
        ? { endedAt: params.endedAt }
        : {}),
      ...(typeof params.durationMs === "number"
        ? { durationMs: params.durationMs }
        : {}),
      ...(Array.isArray(params.overlapsWith)
        ? {
            overlapsWith: params.overlapsWith.map((entry) => {
              const record = asRecord(entry) as {
                providerName: string;
                overlapMs: number;
              };
              return {
                providerName: record.providerName,
                overlapMs: record.overlapMs,
              };
            }),
          }
        : {}),
      data: normalizeJsonRecord(params.data, "providerData"),
      query: (() => {
        if (params.query === undefined) return undefined;
        return normalizeJsonRecord(params.query, "providerQuery");
      })(),
      purpose: params.purpose as string,
    };
    if (typeof params.runId === "string") {
      access.runId = params.runId;
    }
    if (typeof params.roomId === "string") {
      access.roomId = params.roomId;
    }
    if (typeof params.messageId === "string") {
      access.messageId = params.messageId;
    }
    if (typeof params.executionTraceId === "string") {
      access.executionTraceId = params.executionTraceId;
    }
    if (typeof params.createdAt === "string") {
      access.createdAt = params.createdAt;
    }
    if (typeof params.sha256 === "string") {
      access.sha256 = params.sha256;
    }
    for (const field of [
      "tokenCount",
      "position",
      "spanStart",
      "spanEnd",
    ] as const) {
      if (typeof params[field] === "number") access[field] = params[field];
    }

    step.providerAccesses.push(access);
    seenIds.add(providerId);
    changed = true;
    trajectory.startTime = Math.min(trajectory.startTime, now);
    trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
    trajectory.updatedAt = nextTrajectoryUpdatedAt(trajectory.updatedAt, now);
  }
  if (!changed) return;

  const saveResult = await saveActiveTrajectoryCapture(
    runtime,
    trajectory,
    stepId,
    "provider",
    expectedUpdatedAt,
  );
  if (saveResult === "closed") {
    // The save boundary reported the first rejected record; retain the
    // per-record diagnostic count for the rest of this batch as well.
    for (let index = 1; index < captures.length; index++) {
      reportLateTrajectoryCapture(runtime, stepId, "provider");
    }
  }
  if (saveResult !== "conflict") return;
  if (attempt + 1 >= MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS) {
    throw new ElizaError("Trajectory changed during provider capture", {
      code: "TRAJECTORY_WRITE_CONFLICT",
      context: {
        trajectoryId: trajectory.id,
        stepId,
        attempts: MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS,
      },
    });
  }
  await yieldTrajectoryWriteRetry();
  await appendProviderAccesses(
    runtime,
    trajectoryId,
    stepId,
    captures,
    attempt + 1,
  );
}

/**
 * Persist one pre-validated semantic decision stage (Stage-1/planner/tool/
 * evaluation envelope, #17030) onto the bridge-owned step row. Idempotent per
 * `stageId` so retries after transport ambiguity never double-record.
 */
async function appendSemanticStage(
  runtime: IAgentRuntime,
  trajectoryId: string,
  stepId: string,
  semantic: TrajectorySemanticStageRecord,
  retryState?: ActiveCaptureRetryState,
): Promise<void> {
  const now = retryState?.timestamp ?? Date.now();
  const attempt = retryState?.attempt ?? 0;
  const persisted = await loadTrajectoryByStepId(runtime, trajectoryId);
  if (!persisted && trajectoryId !== stepId) {
    throw new ElizaError(
      "Parent trajectory is unavailable for semantic-stage capture",
      {
        code: "TRAJECTORY_PARENT_NOT_FOUND",
        context: { trajectoryId, stepId },
      },
    );
  }
  if (persisted && persisted.status !== "active") {
    releaseTrajectoryBridgeState(runtime, persisted.id);
    reportLateTrajectoryCapture(runtime, stepId, "semanticStage");
    return;
  }
  const trajectory =
    persisted ?? createBaseTrajectory(trajectoryId, now, runtime.agentId);
  const expectedUpdatedAt = trajectory.updatedAt;

  if (
    trajectory.steps.some((candidate) =>
      (candidate.semanticStages ?? []).some(
        (candidateStage) => candidateStage.stageId === semantic.stageId,
      ),
    )
  ) {
    return;
  }

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  const step = ensureStep(trajectory, stepId, now);
  const stages = step.semanticStages ?? [];
  const nextStages = [...stages, semantic];
  // Write subset read: validate the combined stage array before persistence.
  try {
    parseTrajectorySemanticStages(nextStages);
  } catch (cause) {
    throw new ElizaError("Trajectory step semantic stages are invalid", {
      code: "TRAJECTORY_SEMANTIC_STAGE_INVALID",
      context: {
        trajectoryId: trajectory.id,
        stepId,
        stageId: semantic.stageId,
        stageCount: nextStages.length,
      },
      cause,
    });
  }
  step.semanticStages = nextStages;
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = nextTrajectoryUpdatedAt(expectedUpdatedAt, now);

  const saveResult = await saveActiveTrajectoryCapture(
    runtime,
    trajectory,
    stepId,
    "semanticStage",
    expectedUpdatedAt,
  );
  if (saveResult !== "conflict") return;
  if (attempt + 1 >= MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS) {
    throw new ElizaError("Trajectory changed during semantic-stage capture", {
      code: "TRAJECTORY_WRITE_CONFLICT",
      context: {
        trajectoryId: trajectory.id,
        stepId,
        attempts: MAX_ACTIVE_CAPTURE_WRITE_ATTEMPTS,
      },
    });
  }
  await yieldTrajectoryWriteRetry();
  await appendSemanticStage(runtime, trajectoryId, stepId, semantic, {
    attempt: attempt + 1,
    recordId: semantic.stageId,
    timestamp: now,
  });
}

/**
 * Validate one `logSemanticStage` payload into its persisted envelope. Returns
 * null for a structurally absent payload; throws when a present payload is
 * malformed so the caller can report it as an invalid capture.
 */
function normalizeSemanticStagePayload(
  args: unknown[],
): { stepId: string; semantic: TrajectorySemanticStageRecord } | null {
  const record = asRecord(args[0]);
  if (!record) return null;
  const stepId = normalizeStepId(record.stepId);
  if (!stepId) return null;
  return {
    stepId,
    semantic: recordedStageToSemanticStage(record.stage as RecordedStage),
  };
}

// ---------------------------------------------------------------------------
// writeStartedTrajectoryStep / writeCompletedTrajectoryStep
// ---------------------------------------------------------------------------

async function writeStartedTrajectoryStep({
  runtime,
  stepId,
  source,
  metadata,
  traceId,
  episodeId,
  groupIndex,
  createInitialStep = true,
}: StartStepOptions & {
  traceId?: string;
  episodeId?: string;
  groupIndex?: number;
  createInitialStep?: boolean;
}): Promise<void> {
  const now = Date.now();
  const existing = await loadTrajectoryById(runtime, stepId);
  const expectedUpdatedAt = existing?.updatedAt;
  const trajectory =
    existing ??
    createBaseTrajectory(stepId, now, runtime.agentId, source, metadata);
  // Reusing a caller-selected ID cannot reopen an already terminal run.
  if (existing && existing.status !== "active") return;
  if (!existing && !createInitialStep) trajectory.steps = [];

  trajectory.source = source?.trim() || trajectory.source || "runtime";
  trajectory.status = "active";
  trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
  if (traceId !== undefined) trajectory.traceId = traceId;
  if (episodeId !== undefined) trajectory.episodeId = episodeId;
  if (groupIndex !== undefined) trajectory.groupIndex = groupIndex;
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = null;
  if (createInitialStep) ensureStep(trajectory, stepId, now);
  trajectory.updatedAt = new Date(now).toISOString();

  const changedStepIds = createInitialStep ? [stepId] : [];
  if (existing) {
    await saveTrajectory(runtime, trajectory, {
      changedStepIds,
      requireActiveExisting: true,
      expectedUpdatedAt,
    });
  } else {
    await saveNewOwnedTrajectory(runtime, trajectory, { changedStepIds });
  }
}

async function writeCompletedTrajectoryStep({
  runtime,
  stepId,
  status = "completed",
  source,
  metadata,
  createStepIfMissing = true,
  finalMetrics,
}: CompleteStepOptions & {
  createStepIfMissing?: boolean;
  finalMetrics?: Record<string, unknown>;
}): Promise<void> {
  const maximumWriteAttempts = 3;
  for (let attempt = 0; attempt < maximumWriteAttempts; attempt += 1) {
    const now = Date.now();
    const persisted = await loadTrajectoryById(runtime, stepId);
    if (!persisted && !createStepIfMissing) {
      throw new ElizaError(
        "Parent trajectory is unavailable at terminalization",
        {
          code: "TRAJECTORY_PARENT_NOT_FOUND",
          context: { trajectoryId: stepId, status },
        },
      );
    }
    const trajectory =
      persisted ??
      createBaseTrajectory(stepId, now, runtime.agentId, source, metadata);
    const expectedUpdatedAt = persisted?.updatedAt;

    trajectory.source = source?.trim() || trajectory.source || "runtime";
    trajectory.status = normalizeStatus(status, "completed");
    trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
    const previousStartTime =
      typeof trajectory.startTime === "number" &&
      Number.isFinite(trajectory.startTime)
        ? trajectory.startTime
        : now;
    trajectory.startTime = Math.min(previousStartTime, now);
    const previousEndTime =
      typeof trajectory.endTime === "number" &&
      Number.isFinite(trajectory.endTime) &&
      trajectory.endTime >= trajectory.startTime
        ? trajectory.endTime
        : now;
    trajectory.endTime = Math.max(previousEndTime, now, trajectory.startTime);
    if (createStepIfMissing && trajectory.steps.length === 0) {
      ensureStep(trajectory, stepId, now);
    }
    if (finalMetrics !== undefined) {
      const normalizedMetrics = normalizeJsonRecord(
        finalMetrics,
        "finalMetrics",
      );
      trajectory.metrics = { ...trajectory.metrics, ...normalizedMetrics };
    }
    trajectory.updatedAt = expectedUpdatedAt
      ? nextTrajectoryUpdatedAt(expectedUpdatedAt, now)
      : new Date(now).toISOString();

    try {
      const options = {
        changedStepIds:
          createStepIfMissing && trajectory.steps.length === 1 ? [stepId] : [],
      };
      if (persisted) {
        await saveTrajectory(runtime, trajectory, {
          ...options,
          requireActiveExisting: true,
          expectedUpdatedAt,
        });
      } else {
        await saveNewOwnedTrajectory(runtime, trajectory, options);
      }
      return;
    } catch (error) {
      // error-policy:J7 Terminal telemetry retries an active version conflict;
      // exhausted or non-conflict durability failures still reject to caller.
      if (
        asRecord(error)?.code === "TRAJECTORY_WRITE_CONFLICT" &&
        attempt + 1 < maximumWriteAttempts
      ) {
        await yieldTrajectoryWriteRetry();
        continue;
      }
      throw error;
    }
  }
}

function buildTrajectoryWhereClauses(
  options: TrajectoryListOptions,
  agentId: string,
): string[] {
  const whereClauses: string[] = [`agent_id = ${sqlQuote(agentId)}`];
  if (options.roomId) {
    whereClauses.push(
      `COALESCE(metadata_json::jsonb, metadata::jsonb)->>'roomId' = ${sqlQuote(options.roomId)}`,
    );
  }
  if (options.source) {
    whereClauses.push(`source = ${sqlQuote(options.source)}`);
  }
  if (options.status) {
    whereClauses.push(`status = ${sqlQuote(options.status)}`);
  }
  if (options.runId) {
    const escaped = options.runId
      .toLowerCase()
      .replace(/\\/g, "\\\\")
      .replace(/[%_]/g, "\\$&");
    const quotedPattern = sqlQuote(`%${escaped}%`);
    whereClauses.push(
      `(
        LOWER(COALESCE(CAST(metadata_json AS TEXT), CAST(metadata AS TEXT), '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(CAST(steps_json AS TEXT), '')) LIKE ${quotedPattern}
      )`,
    );
  }
  if (options.scenarioId) {
    whereClauses.push(`scenario_id = ${sqlQuote(options.scenarioId)}`);
  }
  if (options.traceId) {
    whereClauses.push(`trace_id = ${sqlQuote(options.traceId)}`);
  }
  if (options.batchId) {
    whereClauses.push(`batch_id = ${sqlQuote(options.batchId)}`);
  }
  if (options.startDate) {
    const startTime = new Date(options.startDate).getTime();
    if (Number.isFinite(startTime)) {
      whereClauses.push(`start_time >= ${startTime}`);
    }
  }
  if (options.endDate) {
    const endTime = new Date(options.endDate).getTime();
    if (Number.isFinite(endTime)) {
      whereClauses.push(`start_time <= ${endTime}`);
    }
  }
  if (options.search) {
    const searchPattern = `%${options.search
      .toLowerCase()
      .replace(/\\/g, "\\\\")
      .replace(/[%_]/g, "\\$&")}%`;
    const quotedPattern = sqlQuote(searchPattern);
    whereClauses.push(
      `(
        LOWER(COALESCE(id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(scenario_id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(batch_id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(CAST(metadata_json AS TEXT), CAST(metadata AS TEXT), '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(CAST(steps_json AS TEXT), '')) LIKE ${quotedPattern}
      )`,
    );
  }
  return whereClauses;
}

function buildTrajectoryWhereClause(
  options: TrajectoryListOptions,
  agentId: string,
): string {
  const whereClauses = buildTrajectoryWhereClauses(options, agentId);
  return whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
}

async function loadPersistedTrajectoriesForExport(
  runtime: IAgentRuntime,
  options: RuntimeTrajectoryExportOptions,
): Promise<PersistedTrajectory[]> {
  requireTrajectoryDatabase(runtime);

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    throw new ElizaError("Trajectory schema is unavailable", {
      code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
    });
  }

  const whereClauses = buildTrajectoryWhereClauses(
    {
      source: options.source,
      status: options.status,
      runId: options.runId,
      startDate: options.startDate,
      endDate: options.endDate,
      search: options.search,
      scenarioId: options.scenarioId,
      traceId: options.traceId,
      batchId: options.batchId,
    },
    runtime.agentId,
  );
  if (options.trajectoryIds && options.trajectoryIds.length > 0) {
    const ids = options.trajectoryIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length > 0) {
      whereClauses.push(`id IN (${ids.map((id) => sqlQuote(id)).join(", ")})`);
    }
  }
  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT 10000`,
    );
    const rows = extractRequiredRows(result, {
      operation: "load trajectories for export",
      agentId: runtime.agentId,
    });
    const trajectories: PersistedTrajectory[] = [];
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) {
        throw new ElizaError("Trajectory export row is invalid", {
          code: "TRAJECTORY_ROW_INVALID",
        });
      }
      const trajectoryId = toText(record.id ?? record.trajectory_id, "").trim();
      if (!trajectoryId) {
        throw new ElizaError("Trajectory export row has no id", {
          code: "TRAJECTORY_ROW_INVALID",
          context: { field: "id" },
        });
      }
      const trajectory = await loadTrajectoryById(runtime, trajectoryId);
      if (!trajectory) {
        throw new ElizaError("Trajectory disappeared during export", {
          code: "TRAJECTORY_ROW_INVALID",
          context: { trajectoryId },
        });
      }
      trajectories.push(trajectory);
    }
    return trajectories;
  } catch (error) {
    // error-policy:J2 a failed export query is not an empty export.
    throw trajectoryOperationError("raw export", error);
  }
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

export async function installDatabaseTrajectoryLogger(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!hasRuntimeDb(runtime)) {
    coreLogger.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no database adapter found on runtime",
    );
    return;
  }

  const logger = await resolveTrajectoryLogger(runtime);
  if (!logger) {
    coreLogger.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no logger found to patch",
    );
    return;
  }

  const loggerObject = logger as object;
  if (patchedLoggers.has(loggerObject)) return;

  const shouldEnableByDefault = shouldEnableTrajectoryLoggingByDefault();
  const isEnabled =
    typeof logger.isEnabled === "function"
      ? logger.isEnabled()
      : shouldEnableByDefault;
  if (
    typeof logger.setEnabled === "function" &&
    isEnabled !== shouldEnableByDefault
  ) {
    try {
      logger.setEnabled(shouldEnableByDefault);
    } catch (error) {
      // error-policy:J7 logger instrumentation must not kill the runtime loop,
      // but the diagnostic failure remains observable.
      warnRuntime(runtime, "Trajectory logger enablement failed", error);
    }
  }

  let fallbackEnabled =
    typeof logger.isEnabled === "function"
      ? logger.isEnabled()
      : shouldEnableByDefault;
  const originalSetEnabled =
    typeof logger.setEnabled === "function"
      ? logger.setEnabled.bind(logger)
      : undefined;
  if (originalSetEnabled) {
    logger.setEnabled = (enabled: boolean): void => {
      originalSetEnabled(enabled);
      fallbackEnabled = enabled;
      if (!enabled) releaseAllTrajectoryBridgeState(runtime);
    };
  }
  const bridgeIsEnabled = (): boolean =>
    typeof logger.isEnabled === "function"
      ? logger.isEnabled()
      : fallbackEnabled;
  const bridgeAcceptsCapture = (): boolean =>
    acceptsNewTrajectoryCapture(runtime, bridgeIsEnabled());

  if (Array.isArray(logger.llmCalls)) {
    logger.llmCalls.splice(0, logger.llmCalls.length);
  }
  if (Array.isArray(logger.providerAccess)) {
    logger.providerAccess.splice(0, logger.providerAccess.length);
  }

  // The bridge replaces lifecycle and read methods below, so capture must use
  // the same owner. Forwarding into the original core writer would make one
  // event mutate two incompatible step/reward shapes in the shared table.
  logger.logLlmCall = (...args: unknown[]) => {
    if (!bridgeAcceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeLlmCallPayload>;
    try {
      normalized = normalizeLlmCallPayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(runtime, "llm", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        runtime,
        bridgeIsEnabled(),
        normalized.stepId,
        "llm",
        typeof normalized.params.purpose === "string"
          ? normalized.params.purpose
          : undefined,
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(runtime, normalized.stepId);

    const writePromise = enqueueStepWrite(runtime, trajectoryId, async () => {
      if (!bridgeIsEnabled()) return;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;
      await appendLlmCall(
        runtime,
        trajectoryId,
        normalized.stepId,
        normalized.params,
      );
    });
    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  logger.logProviderAccess = (...args: unknown[]) => {
    if (!bridgeAcceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeProviderAccessPayload>;
    try {
      normalized = normalizeProviderAccessPayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(runtime, "provider", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        runtime,
        bridgeIsEnabled(),
        normalized.stepId,
        "provider",
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(runtime, normalized.stepId);

    const writePromise = enqueueProviderAccess(
      runtime,
      logger,
      trajectoryId,
      normalized.stepId,
      normalized.params,
      bridgeIsEnabled,
    );
    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  (
    logger as typeof logger & {
      logSemanticStage?: (...args: unknown[]) => void;
    }
  ).logSemanticStage = (...args: unknown[]) => {
    if (!bridgeAcceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeSemanticStagePayload>;
    try {
      normalized = normalizeSemanticStagePayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(runtime, "semanticStage", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        runtime,
        bridgeIsEnabled(),
        normalized.stepId,
        "semanticStage",
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(runtime, normalized.stepId);

    const writePromise = enqueueStepWrite(runtime, trajectoryId, async () => {
      if (!bridgeIsEnabled()) return;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;
      await appendSemanticStage(
        runtime,
        trajectoryId,
        normalized.stepId,
        normalized.semantic,
      );
    });
    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  logger.getLlmCallLogs = () => [];
  logger.getProviderAccessLogs = () => [];

  const loggerAny = logger as typeof logger & {
    startTrajectory?: (
      stepIdOrAgentId: string,
      options?: {
        agentId?: string;
        roomId?: string;
        entityId?: string;
        source?: string;
        metadata?: Record<string, unknown>;
        scenarioId?: string;
        traceId?: string;
        episodeId?: string;
        batchId?: string;
        groupIndex?: number;
      },
    ) => Promise<string>;
    startStep?: (trajectoryId: string, state?: BridgeStepState) => string;
    getCurrentStepId?: (trajectoryId: string) => string | null;
    completeStep?: (
      trajectoryId: string,
      actionOrStepId: string | Record<string, unknown>,
      actionOrReward?: Record<string, unknown>,
      rewardInfo?: Record<string, unknown>,
    ) => void;
    flushWriteQueue?: (trajectoryId?: string) => Promise<void>;
    endTrajectory?: (
      stepIdOrTrajectoryId: string,
      status?: string,
      finalMetrics?: Record<string, unknown>,
    ) => Promise<void>;
    releaseTrajectoryOwnership?: (stepIdOrTrajectoryId: string) => void;
    listTrajectories?: (
      options?: TrajectoryListOptions,
    ) => Promise<TrajectoryListResult>;
    getTrajectoryDetail?: (trajectoryId: string) => Promise<Trajectory | null>;
    getStats?: () => Promise<unknown>;
    stop?: () => Promise<void>;
  };

  const originalStop =
    typeof loggerAny.stop === "function"
      ? loggerAny.stop.bind(loggerAny)
      : undefined;
  loggerAny.stop = async (): Promise<void> => {
    try {
      await stopTrajectoryBridge(runtime);
      await originalStop?.();
    } finally {
      releaseAllTrajectoryBridgeState(runtime);
    }
  };

  loggerAny.startTrajectory = async (
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
      scenarioId?: string;
      traceId?: string;
      episodeId?: string;
      batchId?: string;
      groupIndex?: number;
    },
  ): Promise<string> => {
    if (!bridgeAcceptsCapture()) return randomUUID();
    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startMetadata = normalizeTrajectoryMetadata(
      {
        ...(options?.metadata ?? {}),
        ...(options?.roomId !== undefined ? { roomId: options.roomId } : {}),
        ...(options?.entityId !== undefined
          ? { entityId: options.entityId }
          : {}),
        ...(options?.traceId !== undefined
          ? {
              correlation: {
                traceId: options.traceId,
                ...(options.roomId !== undefined
                  ? { roomId: options.roomId }
                  : {}),
                ...(options.scenarioId !== undefined
                  ? { runId: options.scenarioId }
                  : {}),
              },
            }
          : {}),
      },
      {
        scenarioId: options?.scenarioId,
        batchId: options?.batchId,
      },
    ).metadata;

    const writePromise = enqueueStepWrite(runtime, stepId, async () => {
      if (!bridgeIsEnabled()) return;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;

      await writeStartedTrajectoryStep({
        runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: startMetadata,
        traceId: options?.traceId,
        episodeId: options?.episodeId,
        groupIndex: options?.groupIndex,
        createInitialStep: false,
      });
    });

    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
    rememberTrajectoryStep(runtime, stepId, stepId);

    return stepId;
  };

  loggerAny.startStep = (
    trajectoryId: string,
    state: BridgeStepState = {},
  ): string => {
    if (!bridgeAcceptsCapture()) return randomUUID();
    return startChildTrajectoryStep(
      runtime,
      logger,
      trajectoryId,
      state,
      bridgeIsEnabled,
    );
  };

  loggerAny.getCurrentStepId = (trajectoryId: string): string | null => {
    if (!bridgeAcceptsCapture()) return null;
    const ownerId = resolveBridgeTrajectoryId(runtime, trajectoryId);
    return (
      trajectoryBridgeStates
        .get(runtime as object)
        ?.activeStepIdByTrajectoryId.get(ownerId) ?? null
    );
  };

  loggerAny.completeStep = (
    trajectoryId: string,
    actionOrStepId: string | Record<string, unknown>,
    actionOrReward?: Record<string, unknown>,
    rewardInfo?: Record<string, unknown>,
  ): void => {
    if (!bridgeAcceptsCapture()) return;
    const explicitStepId =
      typeof actionOrStepId === "string" ? actionOrStepId : undefined;
    const action = explicitStepId ? actionOrReward : actionOrStepId;
    const reward = explicitStepId ? rewardInfo : actionOrReward;
    const ownerId = resolveBridgeTrajectoryId(runtime, trajectoryId);
    const stepId =
      explicitStepId ??
      getTrajectoryBridgeState(runtime).activeStepIdByTrajectoryId.get(ownerId);
    if (!stepId || !action) {
      const error = new ElizaError("Trajectory action step is missing", {
        code: "TRAJECTORY_ACTION_STEP_REQUIRED",
        context: { trajectoryId: ownerId },
      });
      warnRuntime(
        runtime,
        "Trajectory action settlement did not identify an active child step",
        error,
      );
      runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        ...(stepId ? { stepId } : {}),
        diagnosticOnly: true,
      });
      return;
    }
    try {
      completeTrajectoryAction(
        runtime,
        ownerId,
        stepId,
        action,
        reward,
        bridgeIsEnabled,
      );
    } catch (error) {
      // error-policy:J7 Action telemetry cannot rewrite an already-settled tool
      // result, but malformed or unroutable settlement remains observable.
      warnRuntime(runtime, "Trajectory action settlement failed", error);
      runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        stepId,
        diagnosticOnly: true,
      });
    }
  };

  loggerAny.flushWriteQueue = async (trajectoryId?: string): Promise<void> => {
    await flushTrajectoryWrites(runtime, trajectoryId);
  };

  loggerAny.endTrajectory = async (
    stepIdOrTrajectoryId: string,
    status = "completed",
    finalMetrics?: Record<string, unknown>,
  ): Promise<void> => {
    if (!bridgeAcceptsCapture()) {
      releaseTrajectoryBridgeState(
        runtime,
        resolveBridgeTrajectoryId(runtime, stepIdOrTrajectoryId),
      );
      return;
    }
    const trajectoryId = resolveBridgeTrajectoryId(
      runtime,
      stepIdOrTrajectoryId,
    );
    await terminalizeBridgeTrajectory(
      runtime,
      trajectoryId,
      status as TrajectoryStatus,
      finalMetrics,
      bridgeIsEnabled,
    );
  };

  loggerAny.releaseTrajectoryOwnership = (
    stepIdOrTrajectoryId: string,
  ): void => {
    releaseTrajectoryBridgeState(
      runtime,
      resolveBridgeTrajectoryId(runtime, stepIdOrTrajectoryId),
    );
  };

  // Add query methods for API endpoints
  loggerAny.listTrajectories = async (
    options: TrajectoryListOptions = {},
  ): Promise<TrajectoryListResult> => {
    requireTrajectoryDatabase(runtime);

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) {
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    const whereClause = buildTrajectoryWhereClause(options, runtime.agentId);

    try {
      const countResult = await executeRawSql(
        runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const total = readRequiredCount(countResult, "total");

      const result = await executeRawSql(
        runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRequiredRows(result, {
        operation: "list trajectories",
        agentId: runtime.agentId,
      });
      const trajectories = rows.map((row) =>
        trajectoryRowToListItem(row, runtime.agentId),
      );

      return { trajectories, total, offset, limit };
    } catch (error) {
      // error-policy:J2 an unavailable query is not an empty trajectory list.
      throw trajectoryOperationError("list", error);
    }
  };

  loggerAny.getTrajectoryDetail = async (
    trajectoryId: string,
  ): Promise<Trajectory | null> => {
    requireTrajectoryDatabase(runtime);

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) {
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    }

    const persisted = await loadTrajectoryById(runtime, trajectoryId);
    if (!persisted) return null;

    return persistedTrajectoryToDetailRecord(persisted, runtime.agentId);
  };

  loggerAny.getStats = async (): Promise<unknown> => {
    requireTrajectoryDatabase(runtime);

    await ensureTrajectoriesTable(runtime);

    try {
      const aggResult = await executeRawSql(
        runtime,
        `SELECT
          count(*) AS total,
          COALESCE(sum(llm_call_count), 0) AS total_llm_calls,
          COALESCE(sum(provider_access_count), 0) AS total_provider_accesses,
          COALESCE(sum(total_prompt_tokens), 0) AS total_prompt_tokens,
          COALESCE(sum(total_completion_tokens), 0) AS total_completion_tokens,
          COALESCE(sum(total_cache_read_input_tokens), 0) AS total_cache_read_input_tokens,
          COALESCE(sum(total_cache_creation_input_tokens), 0) AS total_cache_creation_input_tokens,
          COALESCE(avg(duration_ms), 0) AS avg_duration_ms
        FROM trajectories
        WHERE agent_id = ${sqlQuote(runtime.agentId)}`,
      );
      const row = asRecord(
        extractRequiredRows(aggResult, {
          operation: "trajectory statistics",
          agentId: runtime.agentId,
        })[0],
      );

      const bySource = await computeBySource(runtime);
      const statsContext = {
        operation: "trajectory statistics",
        agentId: runtime.agentId,
      };

      return {
        totalTrajectories: readRequiredNonNegativeNumber(
          row,
          "total",
          statsContext,
        ),
        totalLlmCalls: readRequiredNonNegativeNumber(
          row,
          "total_llm_calls",
          statsContext,
        ),
        totalProviderAccesses: readRequiredNonNegativeNumber(
          row,
          "total_provider_accesses",
          statsContext,
        ),
        totalPromptTokens: readRequiredNonNegativeNumber(
          row,
          "total_prompt_tokens",
          statsContext,
        ),
        totalCompletionTokens: readRequiredNonNegativeNumber(
          row,
          "total_completion_tokens",
          statsContext,
        ),
        totalCacheReadInputTokens: readRequiredNonNegativeNumber(
          row,
          "total_cache_read_input_tokens",
          statsContext,
        ),
        totalCacheCreationInputTokens: readRequiredNonNegativeNumber(
          row,
          "total_cache_creation_input_tokens",
          statsContext,
        ),
        averageDurationMs: readRequiredNonNegativeNumber(
          row,
          "avg_duration_ms",
          statsContext,
        ),
        bySource,
        byModel: {},
      };
    } catch (error) {
      // error-policy:J2 failed aggregation is not a legitimate all-zero run.
      throw trajectoryOperationError("statistics query", error);
    }
  };

  // Add methods required by the trajectory-routes duck-type check
  const loggerForRoutes = logger as typeof logger & {
    isEnabled?: () => boolean;
    setEnabled?: (enabled: boolean) => void;
    deleteTrajectories?: (trajectoryIds: string[]) => Promise<number>;
    clearAllTrajectories?: () => Promise<number>;
    exportTrajectories?: (
      options: RuntimeTrajectoryExportOptions,
    ) => Promise<TrajectoryExportResult>;
  };

  let _enabled = shouldEnableByDefault;

  if (typeof loggerForRoutes.isEnabled !== "function") {
    loggerForRoutes.isEnabled = () => _enabled;
  }
  if (typeof loggerForRoutes.setEnabled !== "function") {
    loggerForRoutes.setEnabled = (enabled: boolean) => {
      _enabled = enabled;
    };
  }

  loggerForRoutes.deleteTrajectories = async (
    trajectoryIds: string[],
  ): Promise<number> => deletePersistedTrajectoryRows(runtime, trajectoryIds);

  loggerForRoutes.clearAllTrajectories = async (): Promise<number> =>
    clearPersistedTrajectoryRows(runtime);

  loggerForRoutes.exportTrajectories = async (
    options: RuntimeTrajectoryExportOptions,
  ): Promise<TrajectoryExportResult> => {
    const persistedTrajectories = await loadPersistedTrajectoriesForExport(
      runtime,
      options,
    );
    return exportPersistedTrajectories({
      agentId: runtime.agentId,
      persistedTrajectories,
      options,
    });
  };

  patchedLoggers.add(loggerObject);

  void ensureTrajectoriesTable(runtime).catch((err) => {
    const cause =
      err instanceof Error && "cause" in err ? err.cause : undefined;
    coreLogger.warn(
      {
        err,
        cause: cause instanceof Error ? cause.message : String(cause),
        src: "eliza",
        subsystem: "trajectory-db",
      },
      "[trajectory] Trajectories table init failed",
    );
  });
}

export async function startTrajectoryStepInDatabase({
  runtime,
  stepId,
  source,
  metadata,
}: StartStepOptions): Promise<boolean> {
  if (
    !hasRuntimeDb(runtime) ||
    stoppingTrajectoryBridges.has(runtime as object)
  )
    return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady)
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    await writeStartedTrajectoryStep({
      runtime,
      stepId: normalizedStepId,
      source,
      metadata,
    });
  });

  return true;
}

/**
 * Annotate an existing trajectory step with structural metadata (kind
 * discriminator, script, child step IDs, used skills). Safe to call for any
 * of the new trajectory step fields; passing `undefined` for a field leaves
 * the existing value alone, while passing an explicit value overwrites.
 */
export async function annotateTrajectoryStep({
  runtime,
  stepId,
  kind,
  script,
  childSteps,
  appendChildSteps,
  usedSkills,
  appendSkillInvocations,
  evaluatorName,
}: {
  runtime: IAgentRuntime;
  stepId: string;
  kind?: TrajectoryStepKind;
  script?: string;
  /** Replace child steps wholesale. */
  childSteps?: string[];
  /** Append the given child step IDs (deduped, order preserved). */
  appendChildSteps?: string[];
  usedSkills?: string[];
  /**
   * Append per-skill invocation records (W1-T5 / M13). Multiple invocations
   * inside the same step accumulate; callers do not need to know prior
   * state.
   */
  appendSkillInvocations?: TrajectorySkillInvocation[];
  /**
   * Name of the evaluator that owns this step. Set when `kind === "evaluator"`
   * so reviewers can identify the responsible evaluator. Closes M14.
   */
  evaluatorName?: string;
}): Promise<boolean> {
  if (
    !hasRuntimeDb(runtime) ||
    stoppingTrajectoryBridges.has(runtime as object)
  )
    return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;
  const trajectoryId = resolveBridgeTrajectoryId(runtime, normalizedStepId);

  await enqueueStepWrite(runtime, trajectoryId, async () => {
    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady)
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    const now = Date.now();
    const persisted = await loadTrajectoryById(runtime, trajectoryId);
    if (!persisted && trajectoryId !== normalizedStepId) {
      throw new ElizaError(
        "Parent trajectory is unavailable for child annotation",
        {
          code: "TRAJECTORY_PARENT_NOT_FOUND",
          context: { trajectoryId, stepId: normalizedStepId },
        },
      );
    }
    const trajectory =
      persisted ?? createBaseTrajectory(trajectoryId, now, runtime.agentId);
    const step = ensureStep(trajectory, normalizedStepId, now);

    if (kind !== undefined) {
      step.kind = kind;
    }
    if (evaluatorName !== undefined) {
      step.evaluatorName = evaluatorName;
    }
    if (script !== undefined) {
      const capped = capScriptForPersistence(script);
      step.script = script;
      if (capped.scriptHash !== undefined) {
        step.scriptHash = capped.scriptHash;
      } else {
        step.scriptHash = undefined;
      }
    }
    if (childSteps !== undefined) {
      step.childSteps = [...childSteps];
    }
    if (appendChildSteps && appendChildSteps.length > 0) {
      const seen = new Set<string>(step.childSteps ?? []);
      const merged = step.childSteps ? [...step.childSteps] : [];
      for (const child of appendChildSteps) {
        const trimmed = typeof child === "string" ? child.trim() : "";
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        merged.push(trimmed);
      }
      step.childSteps = merged;
    }
    if (usedSkills !== undefined) {
      step.usedSkills = [...usedSkills];
    }
    if (appendSkillInvocations && appendSkillInvocations.length > 0) {
      const merged = step.skillInvocations ? [...step.skillInvocations] : [];
      for (const invocation of appendSkillInvocations) {
        merged.push(invocation);
      }
      step.skillInvocations = merged;
    }

    trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
    trajectory.updatedAt = new Date(now).toISOString();
    const options = {
      changedStepIds: [normalizedStepId],
      updateLegacySnapshot: script !== undefined,
    };
    if (persisted) await saveTrajectory(runtime, trajectory, options);
    else await saveNewOwnedTrajectory(runtime, trajectory, options);
  });

  return true;
}

export async function completeTrajectoryStepInDatabase({
  runtime,
  stepId,
  status = "completed",
  source,
  metadata,
}: CompleteStepOptions): Promise<boolean> {
  if (
    !hasRuntimeDb(runtime) ||
    stoppingTrajectoryBridges.has(runtime as object)
  )
    return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;
  const trajectoryId = resolveBridgeTrajectoryId(runtime, normalizedStepId);

  await enqueueStepWrite(runtime, trajectoryId, async () => {
    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady)
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    const token = ownedTrajectoryStarts
      .get(runtime as object)
      ?.get(trajectoryId);
    await writeCompletedTrajectoryStep({
      runtime,
      stepId: trajectoryId,
      status,
      source,
      metadata,
      createStepIfMissing: trajectoryId === normalizedStepId,
    });
    releaseOwnedTrajectoryStart(runtime, trajectoryId, token);
  });

  return true;
}

export async function deletePersistedTrajectoryRows(
  runtime: IAgentRuntime,
  trajectoryIds: string[],
): Promise<number> {
  requireTrajectoryDatabase(runtime);
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    throw new ElizaError("Trajectory schema is unavailable", {
      code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
    });
  }

  const normalized = trajectoryIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;

  const values = normalized.map((id) => sqlQuote(id)).join(", ");

  try {
    const removed = await executeRawSqlTransaction(runtime, async (execute) => {
      const owner = sqlQuote(runtime.agentId);
      readRequiredCount(
        await execute(
          `SELECT count(*) AS total FROM trajectories WHERE agent_id = ${owner} AND id IN (${values})`,
        ),
        "total",
        { operation: "delete" },
      );
      await execute(
        `DELETE FROM trajectory_steps WHERE trajectory_id IN (
           SELECT id FROM trajectories WHERE agent_id = ${owner} AND id IN (${values})
         )`,
      );
      const result = await execute(
        `DELETE FROM trajectories WHERE agent_id = ${owner} AND id IN (${values}) RETURNING id, metadata_json`,
      );
      return readDeletedTrajectoryRows(result);
    });
    releaseDeletedTrajectoryStarts(runtime, removed);
    return removed.length;
  } catch (error) {
    // error-policy:J2 both parent and step deletion are one required operation.
    throw trajectoryOperationError("delete persisted rows", error);
  }
}

export async function clearPersistedTrajectoryRows(
  runtime: IAgentRuntime,
): Promise<number> {
  requireTrajectoryDatabase(runtime);
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    throw new ElizaError("Trajectory schema is unavailable", {
      code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
    });
  }

  try {
    const removed = await executeRawSqlTransaction(runtime, async (execute) => {
      const owner = sqlQuote(runtime.agentId);
      readRequiredCount(
        await execute(
          `SELECT count(*) AS total FROM trajectories WHERE agent_id = ${owner}`,
        ),
        "total",
        { operation: "clear" },
      );
      await execute(
        `DELETE FROM trajectory_steps WHERE trajectory_id IN (
           SELECT id FROM trajectories WHERE agent_id = ${owner}
         )`,
      );
      const result = await execute(
        `DELETE FROM trajectories WHERE agent_id = ${owner} RETURNING id, metadata_json`,
      );
      return readDeletedTrajectoryRows(result);
    });
    releaseDeletedTrajectoryStarts(runtime, removed);
    return removed.length;
  } catch (error) {
    // error-policy:J2 clear failures cannot be represented as an absent result.
    throw trajectoryOperationError("clear persisted rows", error);
  }
}

function readDeletedTrajectoryRows(result: unknown): Record<string, unknown>[] {
  return extractRequiredRows(result, {
    operation: "delete trajectory ownership",
  }).map((value) => {
    const row = asRecord(value);
    if (typeof row?.id !== "string" || row.id.trim().length === 0) {
      throw new ElizaError("Deleted trajectory identity is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
      });
    }
    return row;
  });
}

function releaseDeletedTrajectoryStarts(
  runtime: IAgentRuntime,
  removed: unknown[],
): void {
  for (const value of removed) {
    const row = asRecord(value);
    if (typeof row?.id !== "string") continue;
    if (!ownedTrajectoryStarts.get(runtime as object)?.has(row.id)) continue;
    let metadata: Record<string, unknown> | null;
    try {
      metadata =
        typeof row.metadata_json === "string"
          ? asRecord(JSON.parse(row.metadata_json))
          : asRecord(row.metadata_json);
    } catch (error) {
      // error-policy:J7 Deletion already committed. Corrupt metadata cannot
      // authorize ownership release; stop will observe the missing row instead.
      warnRuntime(
        runtime,
        "Deleted trajectory has invalid ownership metadata",
        error,
      );
      continue;
    }
    releaseOwnedTrajectoryStart(
      runtime,
      row.id,
      metadata?.runtimeTrajectoryOwnerId,
    );
  }
}

/**
 * Wait for all pending trajectory writes to complete.
 * Useful for tests to ensure writes are flushed before assertions.
 */
export async function flushTrajectoryWrites(
  runtime: IAgentRuntime,
  stepIdOrTrajectoryId?: string,
): Promise<void> {
  const runtimeKey = runtime as object;
  if (stepIdOrTrajectoryId) {
    const trajectoryId = resolveBridgeTrajectoryId(
      runtime,
      stepIdOrTrajectoryId,
    );
    let pending = stepWriteQueues.get(runtimeKey)?.get(trajectoryId);
    while (pending) {
      await pending;
      pending = stepWriteQueues.get(runtimeKey)?.get(trajectoryId);
    }
    return;
  }
  let observedLastWrite: Promise<void> | undefined;
  while (true) {
    const pending = Array.from(stepWriteQueues.get(runtimeKey)?.values() ?? []);
    const lastWrite = lastWritePromises.get(runtimeKey);
    const snapshot = Array.from(
      new Set([
        ...pending,
        ...(lastWrite && lastWrite !== observedLastWrite ? [lastWrite] : []),
      ]),
    );
    if (snapshot.length === 0) return;
    await Promise.all(snapshot);
    const nextPending = Array.from(
      stepWriteQueues.get(runtimeKey)?.values() ?? [],
    );
    const nextLastWrite = lastWritePromises.get(runtimeKey);
    if (nextPending.length === 0 && nextLastWrite === lastWrite) return;
    observedLastWrite = lastWrite;
  }
}

// ============================================================================
// DatabaseTrajectoryLogger - Full implementation for trajectory-routes.ts
// ============================================================================

/**
 * Database-backed trajectory logger service that implements the full API
 * expected by trajectory-routes.ts.
 */
export class DatabaseTrajectoryLogger extends Service {
  static serviceType = "trajectories";
  static override readonly allowsMultiple = true;
  capabilityDescription =
    "Database-backed trajectory logging service for LLM call persistence";

  private enabled = shouldEnableTrajectoryLoggingByDefault();

  private acceptsCapture(): boolean {
    return acceptsNewTrajectoryCapture(this.runtime, this.enabled);
  }

  /**
   * Static start method required by @elizaos/core runtime.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DatabaseTrajectoryLogger(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (hasRuntimeDb(this.runtime)) {
      await ensureTrajectoriesTable(this.runtime);
      // Fire-and-forget TTL pruning on startup
      pruneOldTrajectories(this.runtime, 30)
        .then((count) => {
          if (count && count > 0) {
            coreLogger.warn(
              `[trajectory-persistence] Pruned ${count} trajectories older than 30 days`,
            );
          }
        })
        .catch(() => {
          /* non-critical */
        });
    }
  }

  async stop(): Promise<void> {
    try {
      await stopTrajectoryBridge(this.runtime);
    } finally {
      this.enabled = false;
      releaseAllTrajectoryBridgeState(this.runtime);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) releaseAllTrajectoryBridgeState(this.runtime);
  }

  async startTrajectory(
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
      scenarioId?: string;
      traceId?: string;
      episodeId?: string;
      batchId?: string;
      groupIndex?: number;
    },
  ): Promise<string> {
    if (!this.acceptsCapture()) return randomUUID();

    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startMetadata = normalizeTrajectoryMetadata(
      {
        ...(options?.metadata ?? {}),
        ...(options?.roomId !== undefined ? { roomId: options.roomId } : {}),
        ...(options?.entityId !== undefined
          ? { entityId: options.entityId }
          : {}),
        ...(options?.traceId !== undefined
          ? {
              correlation: {
                traceId: options.traceId,
                ...(options.roomId !== undefined
                  ? { roomId: options.roomId }
                  : {}),
                ...(options.scenarioId !== undefined
                  ? { runId: options.scenarioId }
                  : {}),
              },
            }
          : {}),
      },
      {
        scenarioId: options?.scenarioId,
        batchId: options?.batchId,
      },
    ).metadata;

    const writePromise = enqueueStepWrite(this.runtime, stepId, async () => {
      if (!this.enabled) return;
      const tableReady = await ensureTrajectoriesTable(this.runtime);
      if (!tableReady) return;

      await writeStartedTrajectoryStep({
        runtime: this.runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: startMetadata,
        traceId: options?.traceId,
        episodeId: options?.episodeId,
        groupIndex: options?.groupIndex,
        createInitialStep: false,
      });
    });

    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
    rememberTrajectoryStep(this.runtime, stepId, stepId);

    return stepId;
  }

  startStep(trajectoryId: string, state: BridgeStepState = {}): string {
    if (!this.acceptsCapture()) return randomUUID();
    return startChildTrajectoryStep(
      this.runtime,
      this,
      trajectoryId,
      state,
      () => this.enabled,
    );
  }

  getCurrentStepId(trajectoryId: string): string | null {
    if (!this.acceptsCapture()) return null;
    const ownerId = resolveBridgeTrajectoryId(this.runtime, trajectoryId);
    return (
      trajectoryBridgeStates
        .get(this.runtime as object)
        ?.activeStepIdByTrajectoryId.get(ownerId) ?? null
    );
  }

  completeStep(
    trajectoryId: string,
    actionOrStepId: string | Record<string, unknown>,
    actionOrReward?: Record<string, unknown>,
    rewardInfo?: Record<string, unknown>,
  ): void {
    if (!this.acceptsCapture()) return;
    const explicitStepId =
      typeof actionOrStepId === "string" ? actionOrStepId : undefined;
    const action = explicitStepId ? actionOrReward : actionOrStepId;
    const reward = explicitStepId ? rewardInfo : actionOrReward;
    const ownerId = resolveBridgeTrajectoryId(this.runtime, trajectoryId);
    const stepId =
      explicitStepId ??
      getTrajectoryBridgeState(this.runtime).activeStepIdByTrajectoryId.get(
        ownerId,
      );
    if (!stepId || !action) {
      const error = new ElizaError("Trajectory action step is missing", {
        code: "TRAJECTORY_ACTION_STEP_REQUIRED",
        context: { trajectoryId: ownerId },
      });
      warnRuntime(
        this.runtime,
        "Trajectory action settlement did not identify an active child step",
        error,
      );
      this.runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        ...(stepId ? { stepId } : {}),
        diagnosticOnly: true,
      });
      return;
    }
    try {
      completeTrajectoryAction(
        this.runtime,
        ownerId,
        stepId,
        action,
        reward,
        () => this.enabled,
      );
    } catch (error) {
      // error-policy:J7 Action telemetry cannot rewrite an already-settled tool
      // result, but malformed or unroutable settlement remains observable.
      warnRuntime(this.runtime, "Trajectory action settlement failed", error);
      this.runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        stepId,
        diagnosticOnly: true,
      });
    }
  }

  /** Add an idempotent delayed reward without mutating a settled step. */
  async applyReward(params: {
    trajectoryId: string;
    idempotencyKey: string;
    reward: number;
    component: string;
  }): Promise<boolean> {
    if (!Number.isFinite(params.reward)) {
      throw new ElizaError("Trajectory reward is invalid", {
        code: "TRAJECTORY_REWARD_INVALID",
        context: { trajectoryId: params.trajectoryId },
      });
    }
    let applied = false;
    await enqueueStepWrite(this.runtime, params.trajectoryId, async () => {
      if (!this.enabled) return;
      await executeRawSqlTransaction(this.runtime, async (execute) => {
        const result = await execute(
          `SELECT * FROM trajectories
            WHERE id = ${sqlQuote(params.trajectoryId)}
              AND agent_id = ${sqlQuote(this.runtime.agentId)}
            LIMIT 1 FOR UPDATE`,
        );
        const rows = extractRequiredRows(result, {
          operation: "apply delayed trajectory reward",
          trajectoryId: params.trajectoryId,
        });
        const row = rows[0] ? asRecord(rows[0]) : null;
        if (!row) return;
        const trajectory = parsePersistedTrajectoryRow(
          row,
          params.trajectoryId,
        );
        const keys = Array.isArray(trajectory.metadata.appliedRewardKeys)
          ? trajectory.metadata.appliedRewardKeys.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (keys.includes(params.idempotencyKey)) {
          applied = true;
          return;
        }
        trajectory.metadata.appliedRewardKeys = [
          ...keys,
          params.idempotencyKey,
        ];
        trajectory.totalReward += params.reward;
        const componentValues = trajectory.rewardComponents.components;
        const components =
          componentValues === undefined
            ? {}
            : normalizeJsonRecord(componentValues, "rewardComponents");
        const current = components[params.component];
        trajectory.rewardComponents = {
          ...trajectory.rewardComponents,
          components: {
            ...components,
            [params.component]:
              (typeof current === "number" && Number.isFinite(current)
                ? current
                : 0) + params.reward,
          },
        };
        await execute(`UPDATE trajectories SET
          total_reward = ${trajectory.totalReward},
          reward_components_json = ${sqlQuote(JSON.stringify(trajectory.rewardComponents))},
          metadata_json = ${sqlQuote(JSON.stringify(trajectory.metadata))},
          updated_at = ${sqlQuote(new Date().toISOString())}
          WHERE id = ${sqlQuote(params.trajectoryId)}
            AND agent_id = ${sqlQuote(this.runtime.agentId)}`);
        applied = true;
      });
    });
    return applied;
  }

  async flushWriteQueue(trajectoryId?: string): Promise<void> {
    await flushTrajectoryWrites(this.runtime, trajectoryId);
  }

  async annotateStep(params: {
    stepId: string;
    kind?: TrajectoryStepKind;
    script?: string;
    childSteps?: string[];
    appendChildSteps?: string[];
    usedSkills?: string[];
    appendSkillInvocations?: TrajectorySkillInvocation[];
  }): Promise<void> {
    if (!this.acceptsCapture()) return;
    await annotateTrajectoryStep({
      runtime: this.runtime,
      ...params,
    });
  }

  async endTrajectory(
    stepIdOrTrajectoryId: string,
    status: TrajectoryStatus = "completed",
    finalMetrics?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.acceptsCapture()) {
      releaseTrajectoryBridgeState(
        this.runtime,
        resolveBridgeTrajectoryId(this.runtime, stepIdOrTrajectoryId),
      );
      return;
    }
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      stepIdOrTrajectoryId,
    );
    await terminalizeBridgeTrajectory(
      this.runtime,
      trajectoryId,
      status,
      finalMetrics,
      () => this.enabled,
    );
  }

  releaseTrajectoryOwnership(stepIdOrTrajectoryId: string): void {
    releaseTrajectoryBridgeState(
      this.runtime,
      resolveBridgeTrajectoryId(this.runtime, stepIdOrTrajectoryId),
    );
  }

  logLlmCall(params: Record<string, unknown>): void {
    if (!this.acceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeLlmCallPayload>;
    try {
      normalized = normalizeLlmCallPayload([params]);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "llm", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.enabled,
        normalized.stepId,
        "llm",
        typeof normalized.params.purpose === "string"
          ? normalized.params.purpose
          : undefined,
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      normalized.stepId,
    );

    const writePromise = enqueueStepWrite(
      this.runtime,
      trajectoryId,
      async () => {
        if (!this.enabled) return;
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendLlmCall(
          this.runtime,
          trajectoryId,
          normalized.stepId,
          normalized.params,
        );
      },
    );
    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logProviderAccess(params: Record<string, unknown>): void {
    if (!this.acceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeProviderAccessPayload>;
    try {
      normalized = normalizeProviderAccessPayload([params]);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "provider", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.enabled,
        normalized.stepId,
        "provider",
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      normalized.stepId,
    );

    const writePromise = enqueueProviderAccess(
      this.runtime,
      this,
      trajectoryId,
      normalized.stepId,
      normalized.params,
      () => this.enabled,
    );
    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logSemanticStage(params: Record<string, unknown>): void {
    if (!this.acceptsCapture()) return;
    let normalized: ReturnType<typeof normalizeSemanticStagePayload>;
    try {
      normalized = normalizeSemanticStagePayload([params]);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "semanticStage", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.enabled,
        normalized.stepId,
        "semanticStage",
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      normalized.stepId,
    );

    const writePromise = enqueueStepWrite(
      this.runtime,
      trajectoryId,
      async () => {
        if (!this.enabled) return;
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendSemanticStage(
          this.runtime,
          trajectoryId,
          normalized.stepId,
          normalized.semantic,
        );
      },
    );
    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  getLlmCallLogs(): readonly unknown[] {
    return [];
  }

  getProviderAccessLogs(): readonly unknown[] {
    return [];
  }

  async listTrajectories(
    options: TrajectoryListOptions,
  ): Promise<TrajectoryListResult> {
    requireTrajectoryDatabase(this.runtime);

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    const whereClause = buildTrajectoryWhereClause(
      options,
      this.runtime.agentId,
    );

    try {
      const countResult = await executeRawSql(
        this.runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const total = readRequiredCount(countResult, "total");

      const result = await executeRawSql(
        this.runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRequiredRows(result, {
        operation: "list trajectories",
        agentId: this.runtime.agentId,
      });
      const trajectories = rows.map((row) =>
        trajectoryRowToListItem(row, this.runtime.agentId),
      );

      return { trajectories, total, offset, limit };
    } catch (error) {
      // error-policy:J2 transport consumers must receive a failed query rather
      // than a healthy empty list.
      throw trajectoryOperationError("list", error);
    }
  }

  async getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null> {
    requireTrajectoryDatabase(this.runtime);

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    }

    const persisted = await loadTrajectoryById(this.runtime, trajectoryId);
    if (!persisted) return null;

    return persistedTrajectoryToDetailRecord(persisted, this.runtime.agentId);
  }

  async getStats(): Promise<unknown> {
    requireTrajectoryDatabase(this.runtime);

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      throw new ElizaError("Trajectory schema is unavailable", {
        code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
      });
    }

    try {
      const countResult = await executeRawSql(
        this.runtime,
        `SELECT count(*) AS total FROM trajectories WHERE agent_id = ${sqlQuote(this.runtime.agentId)}`,
      );
      const total = readRequiredCount(countResult, "total");

      const bySource = await computeBySource(this.runtime);

      return {
        total,
        enabled: this.enabled,
        byStatus: {},
        bySource,
      };
    } catch (error) {
      // error-policy:J2 a failed statistics query is not an all-zero dataset.
      throw trajectoryOperationError("statistics query", error);
    }
  }

  async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
    return deletePersistedTrajectoryRows(this.runtime, trajectoryIds);
  }

  async clearAllTrajectories(): Promise<number> {
    return clearPersistedTrajectoryRows(this.runtime);
  }

  async exportTrajectories(
    options: RuntimeTrajectoryExportOptions,
  ): Promise<TrajectoryExportResult> {
    const persistedTrajectories = await loadPersistedTrajectoriesForExport(
      this.runtime,
      options,
    );
    return exportPersistedTrajectories({
      agentId: this.runtime.agentId,
      persistedTrajectories,
      options,
    });
  }
}

/**
 * Create and register a database-backed trajectory logger service on the runtime.
 */
export function createDatabaseTrajectoryLogger(
  runtime: IAgentRuntime,
): DatabaseTrajectoryLogger {
  const logger = new DatabaseTrajectoryLogger(runtime);
  return logger;
}

// ---------------------------------------------------------------------------
// Archive / prune
// ---------------------------------------------------------------------------

async function exportRawTrajectoriesToCompressedArchive(
  runtime: IAgentRuntime,
  cutoff: string,
  archivedAt: string,
): Promise<{ archivePath: string; rowCount: number }> {
  const rawRowsResult = await executeRawSql(
    runtime,
    `SELECT
      id, id AS trajectory_id, agent_id, source, status, start_time, end_time,
      duration_ms, step_count, llm_call_count, provider_access_count,
      total_prompt_tokens, total_completion_tokens,
      total_cache_read_input_tokens, total_cache_creation_input_tokens,
      total_reward, scenario_id, batch_id, steps_json,
      metadata_json AS metadata, created_at, updated_at, episode_length, ai_judge_reward,
      ai_judge_reasoning, archetype
    FROM trajectories
    WHERE created_at < ${sqlQuote(cutoff)}
      AND agent_id = ${sqlQuote(runtime.agentId)}`,
  );
  const rawRows = extractRequiredRows(rawRowsResult, {
    operation: "archive trajectories",
    agentId: runtime.agentId,
  }).map((row, index) => {
    const record = asRecord(row);
    if (!record) {
      throw new ElizaError("Trajectory archive row is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
        context: { index },
      });
    }
    return record;
  });

  if (rawRows.length === 0) {
    return { archivePath: "", rowCount: 0 };
  }

  const archiveDir = await resolveTrajectoryArchiveDirectory();
  const archiveName = `trajectories-before-${toArchiveSafeTimestamp(cutoff)}-archived-${toArchiveSafeTimestamp(archivedAt)}.jsonl.gz`;
  const archivePath = path.join(archiveDir, archiveName);
  await writeCompressedJsonlRows(archivePath, rawRows);

  return { archivePath, rowCount: rawRows.length };
}

/**
 * Archive and then delete trajectories older than `maxAgeDays`.
 */
export async function pruneOldTrajectories(
  runtime: IAgentRuntime,
  maxAgeDays = 30,
): Promise<number> {
  requireTrajectoryDatabase(runtime);
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    throw new ElizaError("Trajectory schema is unavailable", {
      code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
    });
  }

  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const archivedAt = new Date().toISOString();

  try {
    // Step 1: Persist full training rows to compressed local archive.
    const archived = await exportRawTrajectoriesToCompressedArchive(
      runtime,
      cutoff,
      archivedAt,
    );
    const archivePath = archived.archivePath;
    if (archived.rowCount > 0 && !archivePath) {
      throw new ElizaError("Trajectory archive path is missing", {
        code: "TRAJECTORY_ARCHIVE_PATH_MISSING",
        context: { rowCount: archived.rowCount },
      });
    }

    // Step 2: Copy summary rows to archive table (idempotent).
    try {
      await executeRawSql(
        runtime,
        `INSERT OR IGNORE INTO trajectory_archive (
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens,
          total_cache_read_input_tokens, total_cache_creation_input_tokens,
          total_reward,
          scenario_id, batch_id, metadata, observations, archive_blob_path,
          created_at, updated_at, archived_at
        )
        SELECT
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens,
          total_cache_read_input_tokens, total_cache_creation_input_tokens,
          total_reward,
          scenario_id, batch_id, metadata_json,
          COALESCE(json_extract(metadata_json, '$.observations'), '[]'),
          ${sqlQuote(archivePath)},
          created_at, updated_at,
          ${sqlQuote(archivedAt)}
        FROM trajectories
        WHERE created_at < ${sqlQuote(cutoff)}
          AND agent_id = ${sqlQuote(runtime.agentId)}`,
      );
    } catch (sqliteError) {
      // error-policy:J2 the first dialect failure is retained if PostgreSQL's
      // equivalent statement also fails.
      try {
        await executeRawSql(
          runtime,
          `INSERT INTO trajectory_archive (
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens,
            total_cache_read_input_tokens, total_cache_creation_input_tokens,
            total_reward,
            scenario_id, batch_id, metadata, observations, archive_blob_path,
            created_at, updated_at, archived_at
          )
          SELECT
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens,
            total_cache_read_input_tokens, total_cache_creation_input_tokens,
            total_reward,
            scenario_id, batch_id, metadata_json,
            COALESCE(metadata_json::json->>'observations', '[]'),
            ${sqlQuote(archivePath)},
            created_at, updated_at,
            ${sqlQuote(archivedAt)}
          FROM trajectories
          WHERE created_at < ${sqlQuote(cutoff)}
            AND agent_id = ${sqlQuote(runtime.agentId)}
          ON CONFLICT (id) DO NOTHING`,
        );
      } catch (postgresError) {
        throw new ElizaError("Could not archive trajectory summaries", {
          code: "TRAJECTORY_SUMMARY_ARCHIVE_FAILED",
          cause: new AggregateError([sqliteError, postgresError]),
        });
      }
    }

    // Step 3: Delete the archived rows from the main table.
    return await executeRawSqlTransaction(runtime, async (execute) => {
      const owner = sqlQuote(runtime.agentId);
      const countResult = await execute(
        `SELECT count(*) AS total FROM trajectories
         WHERE created_at < ${sqlQuote(cutoff)} AND agent_id = ${owner}`,
      );
      const count = readRequiredCount(countResult, "total", {
        operation: "prune",
      });
      if (count > 0) {
        await execute(`DELETE FROM trajectory_steps WHERE trajectory_id IN (
          SELECT id FROM trajectories
          WHERE created_at < ${sqlQuote(cutoff)} AND agent_id = ${owner}
        )`);
        await execute(
          `DELETE FROM trajectories
           WHERE created_at < ${sqlQuote(cutoff)} AND agent_id = ${owner}`,
        );
      }
      return count;
    });
  } catch (error) {
    // error-policy:J2 pruning is a write path; failed archive/delete work must
    // surface rather than look like a disabled pruning result.
    throw trajectoryOperationError("prune", error);
  }
}
