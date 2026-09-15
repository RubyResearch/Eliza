/**
 * Shared internal helpers for the trajectory persistence subsystem.
 *
 * This module contains types, utility functions, SQL helpers, schema management,
 * and observation extraction logic used across trajectory-storage, trajectory-query,
 * and trajectory-export modules. Not intended for direct external consumption.
 */

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import {
  composePrompt,
  logger as coreLogger,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  observationExtractionTemplate,
  parseTrajectorySemanticStages,
  redactBasicEmails,
  resolveStateDir,
  resolveTrajectoryGate,
  sanitizeTrajectoryJsonObject,
  timeInferenceSpan,
  toWellFormedUnicode,
} from "@elizaos/core";
import { asRecord } from "@elizaos/shared";

export { asRecord };

import type {
  TrajectoryActionAttempt,
  TrajectoryLlmCall,
  TrajectoryProviderAccess,
  TrajectorySkillInvocation,
  TrajectoryStatus,
  TrajectoryStep,
  TrajectoryStepKind,
} from "../types/trajectory.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type RuntimeDb = {
  execute: (query: { queryChunks: object[] }) => Promise<unknown>;
  transaction?: <T>(work: (tx: RuntimeDb) => Promise<T>) => Promise<T>;
};

export type RawSqlExecutor = (sqlText: string) => Promise<unknown>;

export type TrajectoryLoggerLike = {
  listTrajectories?: unknown;
  getTrajectoryDetail?: unknown;
  isEnabled?: () => boolean;
  setEnabled?: (enabled: boolean) => void;
  logLlmCall?: (params: Record<string, unknown>) => void;
  logProviderAccess?: (params: Record<string, unknown>) => void;
  getLlmCallLogs?: () => readonly unknown[];
  getProviderAccessLogs?: () => readonly unknown[];
  llmCalls?: unknown[];
  providerAccess?: unknown[];
};

type OrchestratorTrajectoryContext = {
  source: "orchestrator";
  decisionType: string;
  sessionId?: string;
  taskLabel?: string;
  repo?: string;
  workdir?: string;
  originalTask?: string;
};

type RuntimeWithOrchestratorTrajectoryContext = {
  __orchestratorTrajectoryCtx?: OrchestratorTrajectoryContext;
};

/**
 * Appends derived trajectory text records without a recency window, dedupe, or
 * normalization. Invalid persisted metadata is rejected so a corrupt legacy
 * value cannot make later context look complete.
 */
export function appendCompleteTrajectoryTextRecords(
  existing: unknown,
  additions: readonly string[],
  field: string,
): string[] {
  const prior = existing === undefined ? [] : existing;
  if (
    !Array.isArray(prior) ||
    prior.some((record) => typeof record !== "string") ||
    additions.some((record) => typeof record !== "string")
  ) {
    throw new ElizaError("Trajectory text metadata is malformed", {
      code: "TRAJECTORY_TEXT_METADATA_INVALID",
      context: { field },
    });
  }
  for (const [index, record] of [...prior, ...additions].entries()) {
    assertWellFormedTrajectoryText(record, `${field}[${index}]`);
  }
  return [...prior, ...additions];
}

function assertWellFormedTrajectoryText(value: string, field: string): string {
  if (toWellFormedUnicode(value) !== value) {
    throw new ElizaError("Trajectory text contains malformed Unicode", {
      code: "TRAJECTORY_TEXT_MALFORMED_UNICODE",
      context: { field },
    });
  }
  return value;
}

export type PersistedLlmCall = TrajectoryLlmCall & {
  callId: string;
  timestamp: number;
  model: string;
  response: string;
  maxTokensOmitted?: boolean;
  purpose: string;
  actionType: string;
};

export type PersistedProviderAccess = TrajectoryProviderAccess & {
  providerId: string;
  providerName: string;
  timestamp: number;
  data: Record<string, unknown>;
  purpose: string;
};

export type PersistedStep = TrajectoryStep & {
  stepId: string;
  stepNumber: number;
  timestamp: number;
  llmCalls: PersistedLlmCall[];
  providerAccesses: PersistedProviderAccess[];
  /**
   * Optional discriminator. Legacy rows without this field are treated as
   * `"llm"` by readers.
   */
  kind?: TrajectoryStepKind;
  /** Step IDs of nested trajectory steps. */
  childSteps?: string[];
  /** Full inline script source for script-backed dedicated rows. */
  script?: string;
  /** Legacy digest retained when reading rows written before full script preservation. */
  scriptHash?: string;
  /** Skill names the step relied on (populated by Track C). */
  usedSkills?: string[];
};

export type PersistedTrajectory = {
  id: string;
  agentId: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  scenarioId?: string;
  traceId?: string;
  episodeId?: string;
  batchId?: string;
  groupIndex?: number;
  steps: PersistedStep[];
  metadata: Record<string, unknown>;
  metrics: Record<string, JsonValue>;
  rewardComponents: Record<string, JsonValue>;
  totalReward: number;
  createdAt: string;
  updatedAt: string;
};

export type StartStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type CompleteStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  status?: TrajectoryStatus;
  source?: string;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

export const initializedRuntimes = new WeakSet<object>();
export const patchedLoggers = new WeakSet<object>();

export const stepWriteQueues = new WeakMap<
  object,
  Map<string, Promise<void>>
>();
export const lastWritePromises = new WeakMap<object, Promise<void>>();

let cachedSqlRaw: ((query: string) => { queryChunks: object[] }) | null = null;

// Module version - changes on each hot reload, ensuring schema checks run
const SCHEMA_VERSION = Date.now();
const schemaVersions = new WeakMap<object, number>();

export function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function toOptionalText(value: unknown): string | undefined {
  const normalized = toText(value, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized))
    return false;
  return undefined;
}

export function normalizeTrajectoryTag(value: unknown): string {
  const raw = toText(value, "").trim();
  if (!raw) return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeTrajectoryTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeTrajectoryTag(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

const ORCHESTRATOR_STEP_TYPES = new Set([
  "coordination",
  "observation_extraction",
  "orchestrator",
  "turn_complete",
]);

export function inferTrajectoryLlmStepType(params: {
  stepType?: unknown;
  purpose?: unknown;
  actionType?: unknown;
  model?: unknown;
}): string {
  const existing = normalizeTrajectoryTag(params.stepType);
  if (existing) return existing;

  const purpose = normalizeTrajectoryTag(params.purpose);
  const actionType = normalizeTrajectoryTag(params.actionType);

  if (purpose === "should_respond") return "should_respond";
  if (
    purpose === "compose_state" ||
    purpose === "evaluation" ||
    purpose === "reasoning" ||
    purpose === "response" ||
    purpose === "observation_extraction" ||
    purpose === "turn_complete" ||
    purpose === "coordination"
  ) {
    return purpose;
  }
  if (actionType.startsWith("orchestrator_")) {
    return "orchestrator";
  }
  if (purpose === "action") return "action";
  if (purpose && purpose !== "other") return purpose;
  if (actionType) return actionType;
  return purpose;
}

export function inferTrajectoryLlmTags(params: {
  stepType?: unknown;
  purpose?: unknown;
  actionType?: unknown;
  model?: unknown;
  tags?: unknown;
}): string[] {
  const stepType = inferTrajectoryLlmStepType(params);
  const purpose = normalizeTrajectoryTag(params.purpose);
  const actionType = normalizeTrajectoryTag(params.actionType);
  const tags = normalizeTrajectoryTagList(params.tags);
  const seen = new Set<string>(tags);
  const push = (value: string): void => {
    const normalized = normalizeTrajectoryTag(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    tags.push(normalized);
  };

  push("llm");
  if (stepType) push(`step:${stepType}`);
  if (purpose) push(`purpose:${purpose}`);
  if (actionType) push(`action:${actionType}`);
  if (stepType === "should_respond") push("routing");
  if (stepType === "compose_state") push("context");
  if (
    ORCHESTRATOR_STEP_TYPES.has(stepType) ||
    actionType.startsWith("orchestrator_")
  ) {
    push("orchestrator");
  }

  return tags;
}

export function enrichTrajectoryLlmCall<T extends Record<string, unknown>>(
  call: T,
): T & { stepType?: string; tags?: string[] } {
  const stepType = inferTrajectoryLlmStepType({
    stepType: call.stepType,
    purpose: call.purpose,
    actionType: call.actionType,
    model: call.model,
  });
  const tags = inferTrajectoryLlmTags({
    stepType,
    purpose: call.purpose,
    actionType: call.actionType,
    model: call.model,
    tags: call.tags,
  });

  return {
    ...call,
    ...(stepType ? { stepType } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function hasActionNamed(runtime: IAgentRuntime, name: string): boolean {
  const actions = runtime.actions;
  if (!Array.isArray(actions)) return false;
  const target = name.trim().toUpperCase();
  return actions.some((action) => {
    const actionName = action.name.trim().toUpperCase();
    return actionName === target;
  });
}

export function readRecordValue(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const TRAJECTORY_SCENARIO_METADATA_KEYS = ["scenarioId", "scenario_id"];
const TRAJECTORY_BATCH_METADATA_KEYS = ["batchId", "batch_id"];

function readGroupingValue(
  metadata: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return toOptionalText(readRecordValue(metadata, keys));
}

export function resolveTrajectoryGrouping(
  metadata: Record<string, unknown> | undefined,
  fallback?: {
    scenarioId?: unknown;
    batchId?: unknown;
  },
): {
  scenarioId?: string;
  batchId?: string;
} {
  const record = metadata ?? {};
  const scenarioId =
    readGroupingValue(record, TRAJECTORY_SCENARIO_METADATA_KEYS) ??
    toOptionalText(fallback?.scenarioId);
  const batchId =
    readGroupingValue(record, TRAJECTORY_BATCH_METADATA_KEYS) ??
    toOptionalText(fallback?.batchId);
  return { scenarioId, batchId };
}

export function normalizeTrajectoryMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback?: {
    scenarioId?: unknown;
    batchId?: unknown;
  },
): {
  metadata: Record<string, unknown>;
  scenarioId?: string;
  batchId?: string;
} {
  const normalizedMetadata = {
    ...(metadata ?? {}),
  };
  const { scenarioId, batchId } = resolveTrajectoryGrouping(
    normalizedMetadata,
    fallback,
  );

  if (scenarioId) {
    normalizedMetadata.scenarioId = scenarioId;
  } else {
    delete normalizedMetadata.scenarioId;
  }

  if (batchId) {
    normalizedMetadata.batchId = batchId;
  } else {
    delete normalizedMetadata.batchId;
  }

  return {
    metadata: normalizedMetadata,
    scenarioId,
    batchId,
  };
}

// ---------------------------------------------------------------------------
// Script capture helpers
// ---------------------------------------------------------------------------

/**
 * Preserve complete script source for trajectory persistence.
 */
export function capScriptForPersistence(script: string): {
  script: string;
  scriptHash?: string;
} {
  return { script: assertWellFormedTrajectoryText(script, "script") };
}

// ---------------------------------------------------------------------------
// Insight extraction
// ---------------------------------------------------------------------------

export function extractInsightsFromResponse(
  response: string,
  purpose: string,
): string[] {
  const insights: string[] = [];
  const safeResponse = assertWellFormedTrajectoryText(response, "response");
  const decisionPattern = /DECISION:[ \t]*([^\n]+)/gi;
  let match: RegExpExecArray | null;
  match = decisionPattern.exec(safeResponse);
  while (match !== null) {
    const decision = match[1];
    if (decision) {
      insights.push(decision);
    }
    match = decisionPattern.exec(safeResponse);
  }
  const keyDecisionPattern = /"keyDecision"\s*:\s*"([^"]+)"/g;
  match = keyDecisionPattern.exec(safeResponse);
  while (match !== null) {
    const keyDecision = match[1];
    if (keyDecision) {
      insights.push(keyDecision);
    }
    match = keyDecisionPattern.exec(safeResponse);
  }
  if (
    (purpose === "turn-complete" || purpose === "coordination") &&
    insights.length === 0
  ) {
    const reasoningMatch = safeResponse.match(/"reasoning"\s*:\s*"([^"]+)"/);
    const reasoning = reasoningMatch?.[1];
    if (reasoning && reasoning.length >= 20) insights.push(reasoning);
  }
  return insights;
}

// ---------------------------------------------------------------------------
// Observation extraction
// ---------------------------------------------------------------------------

export function shouldRunObservationExtraction(
  runtime: IAgentRuntime,
): boolean {
  const explicitSetting = runtime.getSetting(
    "TRAJECTORY_OBSERVATION_EXTRACTION",
  );
  const explicitValue = toOptionalBoolean(explicitSetting);
  if (explicitValue !== undefined) return explicitValue;

  if (hasActionNamed(runtime, "REFLECTION")) {
    return false;
  }
  return true;
}

export interface BufferedExchange {
  userPrompt: string;
  response: string;
  trajectoryId: string;
  timestamp: number;
}

const OBSERVATION_BUFFER_THRESHOLD = 5;
const OBSERVATION_FLUSH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const observationBuffers = new WeakMap<object, BufferedExchange[]>();
const observationFlushTimers = new WeakMap<
  object,
  ReturnType<typeof setTimeout>
>();
const observationFlushInProgress = new WeakMap<object, boolean>();

export const TRAJECTORY_ARCHIVE_DIRNAME = "trajectory-archive";

function getObservationBuffer(runtime: IAgentRuntime): BufferedExchange[] {
  const key = runtime as object;
  let buffer = observationBuffers.get(key);
  if (!buffer) {
    buffer = [];
    observationBuffers.set(key, buffer);
  }
  return buffer;
}

export function pushChatExchange(
  runtime: IAgentRuntime,
  exchange: BufferedExchange,
): void {
  const buffer = getObservationBuffer(runtime);
  buffer.push(exchange);

  const key = runtime as object;

  // Flush on threshold
  if (buffer.length >= OBSERVATION_BUFFER_THRESHOLD) {
    flushObservationBuffer(runtime).catch((err) => {
      coreLogger.warn(`[trajectory] Observation buffer flush failed: ${err}`);
    });
    return;
  }

  // Set/reset flush timer
  const existing = observationFlushTimers.get(key);
  if (existing) clearTimeout(existing);
  observationFlushTimers.set(
    key,
    setTimeout(() => {
      flushObservationBuffer(runtime).catch((err) => {
        coreLogger.warn(`[trajectory] Observation buffer flush failed: ${err}`);
      });
    }, OBSERVATION_FLUSH_INTERVAL_MS),
  );
}

export async function flushObservationBuffer(
  runtime: IAgentRuntime,
): Promise<string[]> {
  const key = runtime as object;

  // Prevent concurrent flushes
  if (observationFlushInProgress.get(key)) return [];
  observationFlushInProgress.set(key, true);

  const buffer = getObservationBuffer(runtime);
  if (buffer.length === 0) {
    observationFlushInProgress.set(key, false);
    return [];
  }

  // Take the current buffer and reset
  const exchanges = buffer.splice(0, buffer.length);
  const timer = observationFlushTimers.get(key);
  if (timer) clearTimeout(timer);

  // Build the extraction prompt
  const exchangeText = exchanges
    .map(
      (e, i) =>
        `Exchange ${i + 1}:\nUser: ${toWellFormedUnicode(e.userPrompt)}\nAssistant: ${toWellFormedUnicode(e.response)}`,
    )
    .join("\n\n");

  const prompt = composePrompt({
    state: { exchanges: exchangeText },
    template: observationExtractionTemplate,
  });

  const runtimeRecord = runtime as IAgentRuntime &
    RuntimeWithOrchestratorTrajectoryContext;
  try {
    // Tag the call to prevent recursion
    runtimeRecord.__orchestratorTrajectoryCtx = {
      source: "orchestrator",
      decisionType: "observation-extraction",
    };

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0,
    });

    // Parse the JSON response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const observations = parsed
      .filter((s: unknown) => typeof s === "string" && s.length > 0)
      .map((s: string) => toWellFormedUnicode(s)) as string[];

    if (observations.length === 0) return [];

    // Write observations to the most recent trajectory in the batch
    const lastExchange = exchanges[exchanges.length - 1];
    if (!lastExchange) {
      return observations;
    }
    const trajectory = await loadTrajectoryById(
      runtime,
      lastExchange.trajectoryId,
    );
    if (trajectory) {
      const meta = trajectory.metadata as Record<string, unknown>;
      meta.observations = appendCompleteTrajectoryTextRecords(
        meta.observations,
        observations,
        "observations",
      );
      trajectory.metadata = meta;
      await saveTrajectory(runtime, trajectory, { changedStepIds: [] });
    }

    return observations;
  } catch (err) {
    // error-policy:J7 observation extraction is diagnostic enrichment, but its
    // failures must remain visible to the runtime error stream without killing
    // the surrounding message loop.
    runtime.reportError("TrajectoryPersistence.flushObservationBuffer", err, {
      agentId: runtime.agentId,
    });
    warnRuntime(
      runtime,
      "[trajectory-persistence] observation flush failed",
      err,
    );
    return [];
  } finally {
    delete runtimeRecord.__orchestratorTrajectoryCtx;
    observationFlushInProgress.set(key, false);
  }
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

export function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  const record = asRecord(parsed);
  return record ?? {};
}

export function parsePersistedMetadata(
  value: unknown,
  trajectoryId: string,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const parsed = parseJsonValue(value);
  const record = asRecord(parsed);
  if (!record || !isJsonValue(record)) {
    throw new ElizaError("Persisted trajectory metadata is invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context: { trajectoryId, field: "metadata_json" },
    });
  }
  return record;
}

function parseCanonicalJsonObject(
  value: unknown,
  field: "metrics" | "rewardComponents",
  trajectoryId: string,
): Record<string, JsonValue> {
  if (value === undefined || value === null) return {};
  const parsed = parseJsonValue(value);
  const record = asRecord(parsed);
  if (!record || !isJsonValue(record)) {
    throw new ElizaError(`Persisted trajectory ${field} are invalid`, {
      code:
        field === "metrics"
          ? "TRAJECTORY_METRICS_INVALID"
          : "TRAJECTORY_REWARD_COMPONENTS_INVALID",
      context: { trajectoryId },
    });
  }
  return record as Record<string, JsonValue>;
}

export function parseSteps(
  value: unknown,
  trajectoryId = "unknown",
): PersistedStep[] {
  if (value === undefined || value === null) return [];
  const parsed = parseJsonValue(value);
  const records = Array.isArray(parsed)
    ? parsed
    : (() => {
        const record = asRecord(parsed);
        const nested = record
          ? parseJsonValue(readRecordValue(record, ["steps"]))
          : undefined;
        return Array.isArray(nested) ? nested : null;
      })();
  if (!records) {
    throw new ElizaError("Persisted trajectory steps are invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context: { trajectoryId, field: "steps_json" },
    });
  }
  return records.map((step, index) =>
    parsePersistedStepObject(step, trajectoryId, index),
  );
}

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NULL";
  return String(value);
}

export async function getSqlRaw(): Promise<
  (query: string) => { queryChunks: object[] }
> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => { queryChunks: object[] } };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb | null {
  const adapterDb = runtime.adapter?.db as RuntimeDb | undefined;
  // Legacy runtimes may expose `databaseAdapter` instead of `adapter`
  const fallbackDb = (
    runtime as IAgentRuntime & {
      databaseAdapter?: { db?: RuntimeDb };
    }
  ).databaseAdapter?.db;
  const db = adapterDb || fallbackDb;
  if (!db || typeof db.execute !== "function") return null;
  return db;
}

export function hasRuntimeDb(runtime: IAgentRuntime): boolean {
  return Boolean(getRuntimeDb(runtime));
}

export async function executeRawSql(
  runtime: IAgentRuntime,
  sqlText: string,
): Promise<unknown> {
  const db = getRuntimeDb(runtime);
  if (!db) {
    throw new Error("runtime database adapter unavailable");
  }
  const raw = await getSqlRaw();
  return db.execute(raw(sqlText));
}

export async function executeRawSqlTransaction<T>(
  runtime: IAgentRuntime,
  work: (execute: RawSqlExecutor) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime);
  if (!db || typeof db.transaction !== "function") {
    throw new ElizaError("Trajectory database transactions are unavailable", {
      code: "TRAJECTORY_TRANSACTION_UNAVAILABLE",
      context: { agentId: String(runtime.agentId) },
    });
  }
  const raw = await getSqlRaw();
  const transaction = db.transaction.bind(db);
  return timeInferenceSpan("trajectory:db-transaction", () =>
    transaction((tx) => work((sqlText) => tx.execute(raw(sqlText)))),
  );
}

export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  return Array.isArray(record.rows) ? record.rows : [];
}

export function extractRequiredRows(
  result: unknown,
  context: Record<string, unknown> = {},
): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record || !Array.isArray(record.rows)) {
    throw new ElizaError("Trajectory query result is invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context,
    });
  }
  return record.rows;
}

export async function computeBySource(
  runtime: IAgentRuntime,
): Promise<Record<string, number>> {
  const result = await executeRawSql(
    runtime,
    `SELECT source, count(*) AS cnt FROM trajectories
     WHERE agent_id = ${sqlQuote(runtime.agentId)} GROUP BY source`,
  );
  const rows = extractRequiredRows(result, {
    operation: "aggregate trajectories by source",
    agentId: runtime.agentId,
  });
  const bySource: Record<string, number> = {};
  for (const [index, row] of rows.entries()) {
    const record = asRecord(row);
    const source =
      typeof record?.source === "string" ? record.source.trim() : "";
    const count = toOptionalNumber(record?.cnt);
    if (
      !source ||
      count === undefined ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      throw new ElizaError("Trajectory source aggregation row is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
        context: { agentId: runtime.agentId, index },
      });
    }
    bySource[source] = count;
  }
  return bySource;
}

export function warnRuntime(
  runtime: IAgentRuntime,
  message: string,
  err?: unknown,
): void {
  if (runtime.logger.warn) {
    runtime.logger.warn(
      { err, src: "eliza", subsystem: "trajectory-db" },
      message,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema management
// ---------------------------------------------------------------------------

function databaseErrorMatches(error: unknown, patterns: RegExp[]): boolean {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return patterns.some((pattern) =>
    messages.some((message) => pattern.test(message)),
  );
}

function isMissingTableError(error: unknown): boolean {
  return databaseErrorMatches(error, [
    /no such table/i,
    /relation .* does not exist/i,
    /table .* does not exist/i,
  ]);
}

function isDuplicateColumnError(error: unknown): boolean {
  return databaseErrorMatches(error, [
    /duplicate column/i,
    /column .* already exists/i,
  ]);
}

function isMissingCurrentTrajectoryColumnError(error: unknown): boolean {
  return databaseErrorMatches(error, [
    /column ["'`]?(?:metadata_json|metrics_json|reward_components_json)["'`]?.*does not exist/i,
    /no column named ["'`]?(?:metadata_json|metrics_json|reward_components_json)["'`]?/i,
    /has no column named ["'`]?(?:metadata_json|metrics_json|reward_components_json)["'`]?/i,
    /unknown column ["'`]?(?:metadata_json|metrics_json|reward_components_json)["'`]?/i,
  ]);
}

async function addColumnIfMissing(
  runtime: IAgentRuntime,
  table: string,
  name: string,
  definition: string,
): Promise<void> {
  try {
    await executeRawSql(
      runtime,
      `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
    );
  } catch (error) {
    // error-policy:J3 only the database's explicit duplicate-column response
    // means the idempotent migration is already complete.
    if (!isDuplicateColumnError(error)) throw error;
  }
}

const trajectorySchemaInitializationPromises = new WeakMap<
  object,
  Promise<boolean>
>();

export async function ensureTrajectoriesTable(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const key = runtime as object;
  if (schemaVersions.get(key) === SCHEMA_VERSION) {
    await forwardMigrateStepsJsonToRows(runtime);
    return true;
  }
  const existing = trajectorySchemaInitializationPromises.get(key);
  if (existing) return existing;

  const initialization = initializeTrajectoriesTable(runtime);
  trajectorySchemaInitializationPromises.set(key, initialization);
  try {
    return await initialization;
  } finally {
    if (trajectorySchemaInitializationPromises.get(key) === initialization) {
      trajectorySchemaInitializationPromises.delete(key);
    }
  }
}

async function initializeTrajectoriesTable(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const key = runtime as object;

  // Only skip if verified with current module version
  if (schemaVersions.get(key) === SCHEMA_VERSION) return true;

  try {
    // First, check if the table exists and has the correct schema
    // by attempting to select all required columns
    let needsRecreate = false;
    try {
      await executeRawSql(runtime, `SELECT id FROM trajectories LIMIT 1`);
      // Table exists — try to add any missing columns via ALTER TABLE
      // instead of dropping and losing all data.
      const optionalColumns = [
        { name: "trajectory_id", def: "TEXT" },
        { name: "metadata", def: "TEXT NOT NULL DEFAULT '{}'" },
        // Canonical Core columns (#17730): prefer these for primary writes.
        { name: "metadata_json", def: "TEXT NOT NULL DEFAULT '{}'" },
        { name: "metrics_json", def: "TEXT NOT NULL DEFAULT '{}'" },
        {
          name: "reward_components_json",
          def: "TEXT NOT NULL DEFAULT '{}'",
        },
        { name: "steps_json", def: "TEXT NOT NULL DEFAULT '[]'" },
        { name: "scenario_id", def: "TEXT" },
        { name: "trace_id", def: "TEXT" },
        { name: "episode_id", def: "TEXT" },
        { name: "batch_id", def: "TEXT" },
        { name: "group_index", def: "INTEGER" },
        { name: "archetype", def: "TEXT" },
        { name: "episode_length", def: "INTEGER" },
        {
          name: "total_cache_read_input_tokens",
          def: "INTEGER NOT NULL DEFAULT 0",
        },
        {
          name: "total_cache_creation_input_tokens",
          def: "INTEGER NOT NULL DEFAULT 0",
        },
        { name: "ai_judge_reward", def: "REAL" },
        { name: "ai_judge_reasoning", def: "TEXT" },
      ];
      for (const col of optionalColumns) {
        await addColumnIfMissing(runtime, "trajectories", col.name, col.def);
      }
    } catch (error) {
      // error-policy:J3 only a database-native missing-table result selects the
      // create path; permissions, connection, and syntax failures propagate.
      if (!isMissingTableError(error)) throw error;
      needsRecreate = true;
      coreLogger.warn(
        "[trajectory-persistence] Trajectories table does not exist, creating...",
      );
    }

    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'runtime',
        status TEXT NOT NULL DEFAULT 'completed',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        scenario_id TEXT,
        trace_id TEXT,
        episode_id TEXT,
        batch_id TEXT,
        group_index INTEGER,
        steps_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        reward_components_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        episode_length INTEGER,
        ai_judge_reward REAL,
        ai_judge_reasoning TEXT,
        archetype TEXT
      )`,
    );

    // Archive table
    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS trajectory_archive (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'runtime',
        status TEXT NOT NULL DEFAULT 'completed',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        scenario_id TEXT,
        batch_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        observations TEXT NOT NULL DEFAULT '[]',
        archive_blob_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      )`,
    );

    // Best-effort forward migration for existing archive tables.
    await addColumnIfMissing(
      runtime,
      "trajectory_archive",
      "archive_blob_path",
      "TEXT",
    );
    await addColumnIfMissing(
      runtime,
      "trajectory_archive",
      "total_cache_read_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    await addColumnIfMissing(
      runtime,
      "trajectory_archive",
      "total_cache_creation_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );

    // Best-effort forward migration for grouping columns.
    await addColumnIfMissing(runtime, "trajectories", "scenario_id", "TEXT");
    await executeRawSql(
      runtime,
      `CREATE INDEX IF NOT EXISTS idx_trajectories_scenario_id ON trajectories(scenario_id)`,
    );
    await addColumnIfMissing(runtime, "trajectories", "batch_id", "TEXT");
    await executeRawSql(
      runtime,
      `CREATE INDEX IF NOT EXISTS idx_trajectories_batch_id ON trajectories(batch_id)`,
    );
    await addColumnIfMissing(
      runtime,
      "trajectory_archive",
      "scenario_id",
      "TEXT",
    );
    await addColumnIfMissing(runtime, "trajectory_archive", "batch_id", "TEXT");

    let trajectoryStepsExisted = true;
    try {
      await executeRawSql(runtime, `SELECT id FROM trajectory_steps LIMIT 1`);
    } catch (error) {
      // error-policy:J4 A typed missing-table result selects the explicit
      // first-install schema path; every other storage failure still propagates.
      if (!isMissingTableError(error)) throw error;
      trajectoryStepsExisted = false;
    }

    // Per-step rows; script column is unbounded TEXT (no legacy 4096-char cap).
    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS trajectory_steps (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        parent_step_id TEXT,
        step_type TEXT NOT NULL DEFAULT 'llm',
        name TEXT,
        started_at BIGINT,
        ended_at BIGINT,
        payload TEXT NOT NULL DEFAULT '{}',
        script TEXT,
        UNIQUE (trajectory_id, id),
        FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
        FOREIGN KEY (trajectory_id, parent_step_id)
          REFERENCES trajectory_steps(trajectory_id, id)
          ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      )`,
    );
    await ensureTrajectoryStepsConstraintSchema(
      runtime,
      trajectoryStepsExisted,
    );
    await executeRawSql(
      runtime,
      `CREATE INDEX IF NOT EXISTS idx_trajectory_steps_trajectory_id ON trajectory_steps(trajectory_id)`,
    );
    await executeRawSql(
      runtime,
      `CREATE INDEX IF NOT EXISTS idx_trajectory_steps_ordinal ON trajectory_steps(trajectory_id, ordinal)`,
    );

    // A trajectory becomes row-authoritative only after its complete legacy
    // snapshot commits in one transaction; failed trajectories remain
    // readable from steps_json and are eligible for the next retry.
    await forwardMigrateStepsJsonToRows(runtime);

    if (needsRecreate) {
      coreLogger.warn(
        "[trajectory-persistence] Recreated trajectories table with updated schema",
      );
    }

    schemaVersions.set(key, SCHEMA_VERSION);
    initializedRuntimes.add(key);
    return true;
  } catch (error) {
    // error-policy:J2 schema readiness is required for every trajectory data
    // path, so retain the database failure instead of reporting a false empty.
    throw new ElizaError("Could not initialize trajectory storage schema", {
      code: "TRAJECTORY_SCHEMA_INIT_FAILED",
      cause: error,
      context: { agentId: String(runtime.agentId) },
    });
  }
}

const TRAJECTORY_STEPS_CONSTRAINT_MIGRATION = "trajectory_steps_constraints_v1";

async function ensureTrajectoryStepsConstraintSchema(
  runtime: IAgentRuntime,
  trajectoryStepsExisted: boolean,
): Promise<void> {
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS trajectory_schema_migrations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )`,
  );

  await executeRawSqlTransaction(runtime, async (execute) => {
    const claimed = extractRequiredRows(
      await execute(
        `INSERT INTO trajectory_schema_migrations (id, created_at)
         VALUES (
           ${sqlQuote(TRAJECTORY_STEPS_CONSTRAINT_MIGRATION)},
           ${sqlQuote(new Date().toISOString())}
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      ),
      { operation: "claim trajectory step schema migration" },
    );
    if (claimed.length === 0 || !trajectoryStepsExisted) return;

    const migrationTable = "trajectory_steps_constraint_migration";
    await execute(`DROP TABLE IF EXISTS ${migrationTable}`);
    await execute(
      `CREATE TABLE ${migrationTable} (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        parent_step_id TEXT,
        step_type TEXT NOT NULL DEFAULT 'llm',
        name TEXT,
        started_at BIGINT,
        ended_at BIGINT,
        payload TEXT NOT NULL DEFAULT '{}',
        script TEXT,
        UNIQUE (trajectory_id, id),
        FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
        FOREIGN KEY (trajectory_id, parent_step_id)
          REFERENCES ${migrationTable}(trajectory_id, id)
          ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      )`,
    );
    await execute(
      `INSERT INTO ${migrationTable} (
        id, trajectory_id, ordinal, parent_step_id, step_type, name,
        started_at, ended_at, payload, script
      )
      SELECT id, trajectory_id, ordinal, parent_step_id, step_type, name,
             started_at, ended_at, payload, script
      FROM trajectory_steps`,
    );
    await execute(`DROP TABLE trajectory_steps`);
    await execute(`ALTER TABLE ${migrationTable} RENAME TO trajectory_steps`);
  });
}

// Dedicated rows become canonical per trajectory. The parent snapshot remains
// a bounded compatibility projection for readers that predate the row store.

const stepsForwardMigrationRan = new WeakSet<object>();
const stepsForwardMigrationPromises = new WeakMap<object, Promise<boolean>>();

async function forwardMigrateStepsJsonToRows(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const key = runtime as object;
  if (stepsForwardMigrationRan.has(key)) return true;
  const existing = stepsForwardMigrationPromises.get(key);
  if (existing) return existing;
  const migration = runForwardStepsMigration(runtime);
  stepsForwardMigrationPromises.set(key, migration);
  try {
    const succeeded = await migration;
    if (succeeded) stepsForwardMigrationRan.add(key);
    return succeeded;
  } finally {
    if (stepsForwardMigrationPromises.get(key) === migration) {
      stepsForwardMigrationPromises.delete(key);
    }
  }
}

async function runForwardStepsMigration(
  runtime: IAgentRuntime,
): Promise<boolean> {
  try {
    // Find trajectories that have steps_json content but no rows yet.
    const result = await executeRawSql(
      runtime,
      `SELECT t.id AS id, CAST(t.steps_json AS TEXT) AS steps_json
       FROM trajectories t
       LEFT JOIN trajectory_steps s ON s.trajectory_id = t.id
       WHERE s.id IS NULL
         AND t.steps_json IS NOT NULL
         AND CAST(t.steps_json AS TEXT) <> ''
         AND CAST(t.steps_json AS TEXT) <> '[]'`,
    );
    const rows = extractRequiredRows(result, {
      operation: "discover legacy trajectory steps",
    });
    if (rows.length === 0) return true;

    let migrated = 0;
    let failed = false;
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) {
        failed = true;
        continue;
      }
      const trajectoryId = toText(record.id, "");
      if (!trajectoryId) {
        failed = true;
        continue;
      }
      const stepsRaw = record.steps_json;
      const parsed = parseJsonValue(stepsRaw);
      if (!Array.isArray(parsed)) {
        failed = true;
        continue;
      }

      try {
        const steps = parsed.map((stepValue, index) =>
          normalizeMigratedStep(stepValue, trajectoryId, index),
        );
        await executeRawSqlTransaction(runtime, async (execute) => {
          await replaceStepsForTrajectoryInternal(
            trajectoryId,
            steps,
            execute,
            true,
          );
        });
        migrated += steps.length;
      } catch (error) {
        // error-policy:J7 The complete legacy snapshot remains authoritative
        // after rollback, while diagnostics keep this trajectory retryable.
        failed = true;
        warnRuntime(
          runtime,
          `forwardMigrateStepsJsonToRows: failed trajectory ${trajectoryId}`,
          error,
        );
        runtime.reportError("TrajectoryStorage.migrateSteps", error, {
          trajectoryId,
          diagnosticOnly: true,
        });
      }
    }

    if (migrated > 0) {
      coreLogger.info(
        `[trajectory-persistence] Forward-migrated ${migrated} step rows from steps_json into trajectory_steps`,
      );
    }
    return !failed;
  } catch (err) {
    // error-policy:J7 legacy JSON remains authoritative until a complete retry
    // commits, so migration diagnostics cannot block ordinary reads.
    warnRuntime(
      runtime,
      "forwardMigrateStepsJsonToRows: migration query failed; legacy steps_json still readable",
      err,
    );
    runtime.reportError("TrajectoryStorage.migrateSteps", err, {
      diagnosticOnly: true,
    });
    return false;
  }
}

function normalizeMigratedStep(
  value: unknown,
  trajectoryId: string,
  index: number,
): PersistedStep {
  return parsePersistedStepObject(value, trajectoryId, index);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeStatus(
  value: unknown,
  fallback: TrajectoryStatus,
): TrajectoryStatus {
  const status = toText(value, "").toLowerCase();
  if (
    status === "active" ||
    status === "completed" ||
    status === "error" ||
    status === "timeout" ||
    status === "terminated"
  ) {
    return status;
  }
  return fallback;
}

export function parsePersistedTrajectoryStatus(
  value: unknown,
  trajectoryId: string,
): TrajectoryStatus {
  const status = toText(value, "").toLowerCase();
  if (
    status === "active" ||
    status === "completed" ||
    status === "error" ||
    status === "timeout" ||
    status === "terminated"
  ) {
    return status;
  }
  throw new ElizaError("Persisted trajectory status is invalid", {
    code: "TRAJECTORY_ROW_INVALID",
    context: { trajectoryId, field: "status", status: value },
  });
}

export function toOptionalEpochMs(value: unknown): number | undefined {
  const directNumber = toOptionalNumber(value);
  if (directNumber !== undefined) return directNumber;
  const text = toOptionalText(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizePersistedTrajectoryTiming(input: {
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null | undefined;
  durationMs?: number | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}): { endTime: number | null; durationMs: number | null } {
  if (input.status === "active") {
    return { endTime: null, durationMs: null };
  }

  const startTime = Number.isFinite(input.startTime) ? input.startTime : 0;
  const existingEndTime =
    typeof input.endTime === "number" &&
    Number.isFinite(input.endTime) &&
    input.endTime > 0 &&
    input.endTime >= startTime
      ? input.endTime
      : null;
  const fallbackEndTime = startTime > 0 ? startTime : Date.now();
  const endTime =
    existingEndTime ??
    [
      toOptionalEpochMs(input.updatedAt),
      toOptionalEpochMs(input.createdAt),
      fallbackEndTime,
    ].find(
      (candidate): candidate is number =>
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate > 0 &&
        candidate >= startTime,
    ) ??
    startTime;
  const durationMs =
    existingEndTime !== null &&
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
      ? input.durationMs
      : Math.max(0, endTime - startTime);

  return { endTime, durationMs };
}

export function normalizePersistedUpdatedAt(input: {
  startTime: number;
  endTime: number | null | undefined;
  createdAt?: unknown;
  updatedAt?: unknown;
}): string {
  const startTime = Number.isFinite(input.startTime) ? input.startTime : 0;
  const floorTime =
    typeof input.endTime === "number" && Number.isFinite(input.endTime)
      ? input.endTime
      : startTime;
  const updatedAtMs = toOptionalEpochMs(input.updatedAt);
  const createdAtMs = toOptionalEpochMs(input.createdAt);
  const timestamp =
    (typeof updatedAtMs === "number" &&
    updatedAtMs > 0 &&
    updatedAtMs >= floorTime
      ? updatedAtMs
      : null) ??
    (typeof input.endTime === "number" &&
    Number.isFinite(input.endTime) &&
    input.endTime > 0
      ? input.endTime
      : null) ??
    (typeof createdAtMs === "number" && createdAtMs > 0 ? createdAtMs : null) ??
    (startTime > 0 ? startTime : Date.now());

  return new Date(timestamp).toISOString();
}

export function normalizeStepId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stepId = value.trim();
  return stepId.length > 0 ? stepId : null;
}

/** Fields in an LLM call payload that may carry PII / secrets. */
const TRAJECTORY_REDACTABLE_FIELDS: readonly string[] = [
  "systemPrompt",
  "userPrompt",
  "prompt",
  "input",
  "response",
  "reasoning",
];

function redactTrajectoryParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  let cloned: Record<string, unknown> | null = null;
  for (const field of TRAJECTORY_REDACTABLE_FIELDS) {
    const value = params[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const redacted = redactTrajectoryText(value);
    if (redacted !== value) {
      cloned ??= { ...params };
      cloned[field] = redacted;
    }
  }
  return cloned ?? params;
}

function snapshotCaptureParams(
  params: Record<string, unknown>,
  stepId: string,
): Record<string, unknown> {
  const snapshot = sanitizeTrajectoryJsonObject(params);
  if (!snapshot) {
    throw new ElizaError("Trajectory capture payload is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "payload" },
    });
  }
  return snapshot;
}

/**
 * Snapshot a complete LLM capture after JSON-safe normalization. Field order
 * keeps the required completeness contract visible without imposing a byte
 * budget or dropping optional prompt and metadata fields.
 */
function snapshotLlmCaptureParams(
  params: Record<string, unknown>,
  stepId: string,
): Record<string, unknown> {
  return snapshotCaptureParams(
    {
      model: params.model,
      response: params.response,
      purpose: params.purpose,
      actionType: params.actionType,
      ...params,
    },
    stepId,
  );
}

/**
 * A tool-call-only completion (`finishReason=tool-calls` — a planner turn that
 * emits only a tool call, or a Stage-1 truncated at its completion-token cap)
 * produces no assistant text, so producers hand this recorder
 * `response: undefined` despite the declared string type. `validateLlmCapture`
 * accepts an EMPTY response (allowEmpty) but rejects a missing one, which
 * silently dropped the llm sub-capture for exactly the tool-heavy turns
 * trajectories exist to explain. Coerce only absence — a present-but-non-string
 * response is still a producer bug and must keep failing validation.
 */
function coerceAbsentLlmResponse(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (params.response != null) return params;
  return { ...params, response: "" };
}

export function normalizeLlmCallPayload(
  args: unknown[],
): { stepId: string; params: Record<string, unknown> } | null {
  if (args.length === 0) {
    throw new ElizaError("Trajectory LLM capture is missing", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "payload" },
    });
  }
  if (typeof args[0] === "string") {
    const stepId = normalizeStepId(args[0]);
    const details = asRecord(args[1]);
    if (!stepId || !details) {
      throw new ElizaError("Trajectory LLM capture is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { field: !stepId ? "stepId" : "payload" },
      });
    }
    const params = redactTrajectoryParams(
      coerceAbsentLlmResponse({
        ...details,
        stepId,
      }),
    );
    validateLlmCapture(params, stepId);
    const snapshot = snapshotLlmCaptureParams(params, stepId);
    validateLlmCapture(snapshot, stepId);
    return {
      stepId,
      params: snapshot,
    };
  }

  const params = asRecord(args[0]);
  if (!params) {
    throw new ElizaError("Trajectory LLM capture is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "payload" },
    });
  }
  const stepId = normalizeStepId(params.stepId);
  if (!stepId) {
    throw new ElizaError("Trajectory LLM capture is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "stepId" },
    });
  }
  const normalizedParams =
    params.stepId === stepId ? params : { ...params, stepId };
  const redactedParams = redactTrajectoryParams(
    coerceAbsentLlmResponse(normalizedParams),
  );
  validateLlmCapture(redactedParams, stepId);
  const snapshot = snapshotLlmCaptureParams(redactedParams, stepId);
  validateLlmCapture(snapshot, stepId);
  return {
    stepId,
    params: snapshot,
  };
}

function requireCaptureString(
  params: Record<string, unknown>,
  field: string,
  stepId: string,
  allowEmpty = false,
): void {
  const value = params[field];
  if (typeof value === "string" && (allowEmpty || value.trim().length > 0)) {
    return;
  }
  throw new ElizaError("Trajectory capture field is invalid", {
    code: "TRAJECTORY_CAPTURE_INVALID",
    context: { stepId, field },
  });
}

function validateLlmCapture(
  params: Record<string, unknown>,
  stepId: string,
): void {
  requireCaptureString(params, "model", stepId);
  requireCaptureString(params, "response", stepId, true);
  requireCaptureString(params, "purpose", stepId);
  requireCaptureString(params, "actionType", stepId);
  for (const field of [
    "callId",
    "provider",
    "modelType",
    "systemPrompt",
    "userPrompt",
    "input",
    "prompt",
    "finishReason",
    "modelVersion",
    "reasoning",
    "stepType",
    "modelSlot",
    "runId",
    "roomId",
    "messageId",
    "executionTraceId",
    "createdAt",
    "evaluatorName",
  ] as const) {
    if (params[field] !== undefined && typeof params[field] !== "string") {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  if (typeof params.callId === "string" && params.callId.trim().length === 0) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "callId" },
    });
  }
  for (const field of [
    "timestamp",
    "temperature",
    "maxTokens",
    "topP",
    "latencyMs",
    "promptTokens",
    "completionTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningTokens",
  ] as const) {
    if (
      params[field] !== undefined &&
      (typeof params[field] !== "number" ||
        !Number.isFinite(params[field]) ||
        params[field] < 0)
    ) {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  for (const field of ["messages", "toolCalls"] as const) {
    if (params[field] !== undefined && !Array.isArray(params[field])) {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  if (
    params.tools !== undefined &&
    !Array.isArray(params.tools) &&
    !asRecord(params.tools)
  ) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "tools" },
    });
  }
  for (const field of ["tags", "providerOrder"] as const) {
    if (
      params[field] !== undefined &&
      (!Array.isArray(params[field]) ||
        params[field].some((entry) => typeof entry !== "string"))
    ) {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  if (
    params.providerAttributions !== undefined &&
    (!Array.isArray(params.providerAttributions) ||
      params.providerAttributions.some((entry) => {
        const record = asRecord(entry);
        return (
          !record ||
          typeof record.providerName !== "string" ||
          record.providerName.trim().length === 0 ||
          typeof record.sha256 !== "string" ||
          record.sha256.trim().length === 0 ||
          typeof record.tokenCount !== "number" ||
          !Number.isFinite(record.tokenCount) ||
          record.tokenCount < 0 ||
          typeof record.position !== "number" ||
          !Number.isFinite(record.position) ||
          record.position < 0 ||
          (record.tokenCountEstimated !== undefined &&
            typeof record.tokenCountEstimated !== "boolean") ||
          (record.spanStart !== undefined &&
            (typeof record.spanStart !== "number" ||
              !Number.isFinite(record.spanStart) ||
              record.spanStart < 0)) ||
          (record.spanEnd !== undefined &&
            (typeof record.spanEnd !== "number" ||
              !Number.isFinite(record.spanEnd) ||
              record.spanEnd < 0))
        );
      }))
  ) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "providerAttributions" },
    });
  }
  for (const field of ["maxTokensOmitted", "tokenUsageEstimated"] as const) {
    if (params[field] !== undefined && typeof params[field] !== "boolean") {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
}

/**
 * Snapshot a complete provider capture after JSON-safe normalization, mirroring
 * {@link snapshotLlmCaptureParams}. Required fields are ordered first for
 * readability; provider data remains intact regardless of its serialized size.
 */
function snapshotProviderCaptureParams(
  params: Record<string, unknown>,
  stepId: string,
): Record<string, unknown> {
  return snapshotCaptureParams(
    {
      providerName: params.providerName,
      purpose: params.purpose,
      data: params.data,
      ...params,
    },
    stepId,
  );
}

export function normalizeProviderAccessPayload(
  args: unknown[],
): { stepId: string; params: Record<string, unknown> } | null {
  if (args.length === 0) {
    throw new ElizaError("Trajectory provider capture is missing", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "payload" },
    });
  }
  if (typeof args[0] === "string") {
    const stepId = normalizeStepId(args[0]);
    const details = asRecord(args[1]);
    if (!stepId || !details) {
      throw new ElizaError("Trajectory provider capture is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { field: !stepId ? "stepId" : "payload" },
      });
    }
    const params = {
      ...details,
      stepId,
    };
    validateProviderCapture(params, stepId);
    const snapshot = snapshotProviderCaptureParams(params, stepId);
    validateProviderCapture(snapshot, stepId);
    return {
      stepId,
      params: snapshot,
    };
  }

  const params = asRecord(args[0]);
  if (!params) {
    throw new ElizaError("Trajectory provider capture is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "payload" },
    });
  }
  const stepId = normalizeStepId(params.stepId);
  if (!stepId) {
    throw new ElizaError("Trajectory provider capture is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { field: "stepId" },
    });
  }
  const normalizedParams =
    params.stepId === stepId ? params : { ...params, stepId };
  validateProviderCapture(normalizedParams, stepId);
  const snapshot = snapshotProviderCaptureParams(normalizedParams, stepId);
  validateProviderCapture(snapshot, stepId);
  return {
    stepId,
    params: snapshot,
  };
}

function validateProviderCapture(
  params: Record<string, unknown>,
  stepId: string,
): void {
  requireCaptureString(params, "providerName", stepId);
  requireCaptureString(params, "purpose", stepId);
  if (!asRecord(params.data)) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "data" },
    });
  }
  for (const field of [
    "providerId",
    "sha256",
    "runId",
    "roomId",
    "messageId",
    "executionTraceId",
    "createdAt",
  ] as const) {
    if (params[field] !== undefined && typeof params[field] !== "string") {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  if (
    typeof params.providerId === "string" &&
    params.providerId.trim().length === 0
  ) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "providerId" },
    });
  }
  for (const field of [
    "timestamp",
    "startedAt",
    "endedAt",
    "durationMs",
    "tokenCount",
    "position",
    "spanStart",
    "spanEnd",
  ] as const) {
    if (
      params[field] !== undefined &&
      params[field] !== null &&
      (typeof params[field] !== "number" ||
        !Number.isFinite(params[field]) ||
        params[field] < 0)
    ) {
      throw new ElizaError("Trajectory capture field is invalid", {
        code: "TRAJECTORY_CAPTURE_INVALID",
        context: { stepId, field },
      });
    }
  }
  if (params.query !== undefined && !asRecord(params.query)) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "query" },
    });
  }
  if (
    params.overlapsWith !== undefined &&
    (!Array.isArray(params.overlapsWith) ||
      params.overlapsWith.some((entry) => {
        const record = asRecord(entry);
        return (
          !record ||
          typeof record.providerName !== "string" ||
          record.providerName.trim().length === 0 ||
          typeof record.overlapMs !== "number" ||
          !Number.isFinite(record.overlapMs) ||
          record.overlapMs < 0
        );
      }))
  ) {
    throw new ElizaError("Trajectory capture field is invalid", {
      code: "TRAJECTORY_CAPTURE_INVALID",
      context: { stepId, field: "overlapsWith" },
    });
  }
}

export function isNumericVectorString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "[array]") return true;
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return false;
  const parts = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 8) return false;
  const sampleSize = Math.min(parts.length, 16);
  for (let i = 0; i < sampleSize; i += 1) {
    const numeric = Number(parts[i]);
    if (!Number.isFinite(numeric)) return false;
  }
  return true;
}

export function shouldSuppressNoInputEmbeddingCall(
  params: Record<string, unknown>,
): boolean {
  const model = toText(params.model, "").toLowerCase();
  const actionType = toText(params.actionType, "").toLowerCase();
  const purpose = toText(params.purpose, "").toLowerCase();
  const isEmbedding =
    model.includes("embed") ||
    actionType.includes("embed") ||
    purpose.includes("embed");
  if (!isEmbedding) return false;
  const userPrompt = toText(params.userPrompt ?? params.input, "").trim();
  if (userPrompt.length > 0) return false;
  const response = toText(params.response, "");
  if (!response.trim()) return true;
  return isNumericVectorString(response);
}

export function isLegacyTrajectoryLogger(
  logger: TrajectoryLoggerLike,
): boolean {
  return (
    typeof logger.listTrajectories === "function" &&
    typeof logger.getTrajectoryDetail === "function"
  );
}

export async function resolveTrajectoryLogger(
  runtime: IAgentRuntime,
): Promise<TrajectoryLoggerLike | null> {
  const candidates: TrajectoryLoggerLike[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    candidates.push(candidate as TrajectoryLoggerLike);
  };

  const byType = runtime.getServicesByType("trajectories");
  if (Array.isArray(byType)) {
    for (const item of byType) push(item);
  } else {
    push(byType);
  }
  push(runtime.getService("trajectories"));

  if (candidates.length === 0) return null;

  let best: TrajectoryLoggerLike | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (isLegacyTrajectoryLogger(candidate)) score += 100;
    if (typeof candidate.logLlmCall === "function") score += 10;
    if (typeof candidate.logProviderAccess === "function") score += 10;
    if (typeof candidate.getLlmCallLogs === "function") score += 2;
    if (typeof candidate.getProviderAccessLogs === "function") score += 2;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Trajectory data helpers
// ---------------------------------------------------------------------------

export function enqueueStepWrite(
  runtime: IAgentRuntime,
  stepId: string,
  work: () => Promise<void>,
): Promise<void> {
  const runtimeKey = runtime as object;
  let perStep = stepWriteQueues.get(runtimeKey);
  if (!perStep) {
    perStep = new Map<string, Promise<void>>();
    stepWriteQueues.set(runtimeKey, perStep);
  }

  const previous = perStep.get(stepId) ?? Promise.resolve();
  const current = previous
    .catch(() => {
      // error-policy:J5 The rejected write remains observable through its own
      // returned promise; this sequencing tail keeps later independent work on
      // the same owner from being chain-blocked by that prior failure.
    })
    .then(async () => {
      try {
        await work();
      } catch (error) {
        // error-policy:J7 trajectory diagnostics must not hide persistence
        // failure from lifecycle callers. diagnosticOnly keeps the durable
        // signal out of ordinary assistant prose while preserving logs/events.
        warnRuntime(
          runtime,
          "Failed to write trajectory update to database",
          error,
        );
        try {
          runtime.reportError("TrajectoryStorage.write", error, {
            stepId,
            diagnosticOnly: true,
          });
        } catch (reportError) {
          // error-policy:J7 reporting a diagnostic must not replace the
          // original database error that the queue returns to its observer.
          warnRuntime(
            runtime,
            "Failed to report trajectory database write error",
            reportError,
          );
        }
        throw error;
      }
    })
    .finally(() => {
      const latest = perStep.get(stepId);
      if (latest === current) {
        perStep.delete(stepId);
      }
    });

  perStep.set(stepId, current);
  void current.catch((error) => {
    // error-policy:J5 lifecycle and flush observe this same rejecting promise;
    // this detached branch only prevents fire-and-forget capture from becoming
    // an unhandled process rejection before that boundary drains the queue.
    void error;
  });
  return current;
}

export function createBaseTrajectory(
  stepId: string,
  now: number,
  agentId: string,
  source?: string,
  metadata?: Record<string, unknown>,
): PersistedTrajectory {
  const normalizedSource = source?.trim() || "runtime";
  const createdAt = new Date(now).toISOString();
  const normalizedMetadata = normalizeTrajectoryMetadata(metadata);
  return {
    id: stepId,
    agentId,
    source: normalizedSource,
    status: "active",
    startTime: now,
    endTime: null,
    scenarioId: normalizedMetadata.scenarioId,
    batchId: normalizedMetadata.batchId,
    steps: [
      {
        stepId,
        stepNumber: 0,
        timestamp: now,
        llmCalls: [],
        providerAccesses: [],
      },
    ],
    metadata: normalizedMetadata.metadata,
    metrics: {},
    rewardComponents: { environmentReward: 0 },
    totalReward: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export function ensureStep(
  trajectory: PersistedTrajectory,
  stepId: string,
  now: number,
): PersistedStep {
  let step = trajectory.steps.find((item) => item.stepId === stepId);
  if (!step) {
    step = {
      stepId,
      stepNumber: trajectory.steps.length,
      timestamp: now,
      llmCalls: [],
      providerAccesses: [],
    };
    trajectory.steps.push(step);
  }
  return step;
}

export function mergeMetadata(
  existing: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> {
  if (!incoming) return existing;
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    // Ownership comes from the writer that created the row, never metadata
    // supplied by a later start/annotation using an existing trajectory ID.
    if (
      key === "runtimeInstanceId" ||
      key === "runtimeTrajectoryOwnerId" ||
      key === "runtimeExecutionOwnerId"
    )
      continue;
    if (value !== undefined) merged[key] = value;
  }
  return normalizeTrajectoryMetadata(merged).metadata;
}

export function collectTrajectoryTimestamps(
  trajectory: PersistedTrajectory,
): number[] {
  const timestamps: number[] = [trajectory.startTime];
  for (const step of trajectory.steps) {
    timestamps.push(step.timestamp);
    for (const call of step.llmCalls) {
      timestamps.push(call.timestamp);
    }
    for (const access of step.providerAccesses) {
      timestamps.push(access.timestamp);
    }
  }
  return timestamps.filter((value) => Number.isFinite(value));
}

export function summarizeTrajectory(trajectory: PersistedTrajectory): {
  startTime: number;
  endTime: number;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
} {
  const timestamps = collectTrajectoryTimestamps(trajectory);
  const startTime =
    timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const endTime = timestamps.length > 0 ? Math.max(...timestamps) : startTime;

  let llmCallCount = 0;
  let providerAccessCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;

  for (const step of trajectory.steps) {
    llmCallCount += step.llmCalls.length;
    providerAccessCount += step.providerAccesses.length;
    for (const call of step.llmCalls) {
      totalPromptTokens += call.promptTokens ?? 0;
      totalCompletionTokens += call.completionTokens ?? 0;
      totalCacheReadInputTokens += call.cacheReadInputTokens ?? 0;
      totalCacheCreationInputTokens += call.cacheCreationInputTokens ?? 0;
    }
  }

  return {
    startTime,
    endTime,
    llmCallCount,
    providerAccessCount,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheReadInputTokens,
    totalCacheCreationInputTokens,
  };
}

export function parsePersistedTrajectoryRow(
  row: Record<string, unknown>,
  fallbackId: string,
): PersistedTrajectory {
  const id = requiredPersistedString(
    readRecordValue(row, ["id", "trajectory_id", "trajectoryId"]),
    fallbackId,
    "id",
  );
  const agentId = requiredPersistedString(
    readRecordValue(row, ["agent_id", "agentId"]),
    id,
    "agent_id",
  );
  const source = requiredPersistedString(
    readRecordValue(row, ["source"]),
    id,
    "source",
  );
  const startTime = requiredPersistedNumber(
    readRecordValue(row, ["start_time", "startTime"]),
    id,
    "start_time",
  );
  const status = parsePersistedTrajectoryStatus(
    readRecordValue(row, ["status"]),
    fallbackId,
  );
  const rawCreatedAt = readRecordValue(row, ["created_at", "createdAt"]);
  const rawUpdatedAt = readRecordValue(row, ["updated_at", "updatedAt"]);
  const createdAt = requiredPersistedString(rawCreatedAt, id, "created_at");
  const updatedAt = requiredPersistedString(rawUpdatedAt, id, "updated_at");
  if (
    !Number.isFinite(Date.parse(createdAt)) ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw persistedRowError(id, "created_at/updated_at");
  }
  const rawEndTime = readRecordValue(row, ["end_time", "endTime"]);
  const rawDurationMs = readRecordValue(row, ["duration_ms", "durationMs"]);
  const endTime =
    rawEndTime === undefined || rawEndTime === null
      ? null
      : requiredPersistedNumber(rawEndTime, id, "end_time");
  const durationMs =
    rawDurationMs === undefined || rawDurationMs === null
      ? null
      : requiredPersistedNumber(rawDurationMs, id, "duration_ms");
  if (
    (status === "active" && (endTime !== null || durationMs !== null)) ||
    (status !== "active" &&
      (endTime === null ||
        endTime < startTime ||
        durationMs === null ||
        durationMs < 0 ||
        durationMs !== endTime - startTime))
  ) {
    throw persistedRowError(id, "end_time/duration_ms");
  }
  const timing = normalizePersistedTrajectoryTiming({
    status,
    startTime,
    endTime,
    durationMs,
    createdAt,
    updatedAt,
  });
  const steps = parseSteps(
    readRecordValue(row, ["steps_json", "stepsJson", "steps"]),
    id,
  );
  const optionalRowString = (
    keys: string[],
    field: string,
  ): string | undefined => {
    const value = readRecordValue(row, keys);
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw persistedRowError(id, field);
    }
    return value;
  };
  const scenarioId = optionalRowString(
    ["scenario_id", "scenarioId"],
    "scenario_id",
  );
  const traceId = optionalRowString(["trace_id", "traceId"], "trace_id");
  const episodeId = optionalRowString(
    ["episode_id", "episodeId"],
    "episode_id",
  );
  const batchId = optionalRowString(["batch_id", "batchId"], "batch_id");
  const rawGroupIndex = readRecordValue(row, ["group_index", "groupIndex"]);
  const groupIndex =
    rawGroupIndex === undefined || rawGroupIndex === null
      ? undefined
      : requiredPersistedNumber(rawGroupIndex, id, "group_index");
  if (
    groupIndex !== undefined &&
    (!Number.isInteger(groupIndex) || groupIndex < 0)
  ) {
    throw persistedRowError(id, "group_index");
  }
  const normalizedMetadata = normalizeTrajectoryMetadata(
    parsePersistedMetadata(
      readRecordValue(row, [
        "metadata_json",
        "metadataJson",
        "metadata",
        "meta",
      ]),
      id,
    ),
    {
      scenarioId,
      batchId,
    },
  );
  const totalReward = requiredPersistedNumber(
    readRecordValue(row, ["total_reward", "totalReward"]),
    id,
    "total_reward",
  );
  const parsedMetrics = parseCanonicalJsonObject(
    readRecordValue(row, ["metrics_json", "metricsJson", "metrics"]),
    "metrics",
    fallbackId,
  );
  const parsedRewardComponents = parseCanonicalJsonObject(
    readRecordValue(row, [
      "reward_components_json",
      "rewardComponentsJson",
      "rewardComponents",
    ]),
    "rewardComponents",
    fallbackId,
  );
  const rewardComponents = {
    ...parsedRewardComponents,
  } as Record<string, JsonValue>;
  if (rewardComponents.environmentReward === undefined) {
    rewardComponents.environmentReward = totalReward;
  } else if (
    typeof rewardComponents.environmentReward !== "number" ||
    !Number.isFinite(rewardComponents.environmentReward)
  ) {
    throw new ElizaError("Persisted trajectory environment reward is invalid", {
      code: "TRAJECTORY_REWARD_COMPONENTS_INVALID",
      context: { trajectoryId: fallbackId },
    });
  }

  return {
    id,
    agentId,
    source,
    status,
    startTime,
    endTime: timing.endTime,
    scenarioId: normalizedMetadata.scenarioId,
    traceId,
    episodeId,
    batchId: normalizedMetadata.batchId,
    groupIndex,
    steps,
    metadata: normalizedMetadata.metadata,
    metrics: parsedMetrics,
    rewardComponents,
    totalReward,
    createdAt,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Core load/save (used by both storage and query modules)
// ---------------------------------------------------------------------------

export async function loadTrajectoryById(
  runtime: IAgentRuntime,
  stepId: string,
): Promise<PersistedTrajectory | null> {
  const safeId = sqlQuote(stepId);
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories
       WHERE id = ${safeId} AND agent_id = ${sqlQuote(runtime.agentId)}
       LIMIT 1`,
    );
    const rows = extractRequiredRows(result, {
      operation: "load trajectory",
      stepId,
      agentId: runtime.agentId,
    });
    if (rows.length === 0) return null;
    const row = asRecord(rows[0]);
    if (!row) {
      throw new ElizaError("Stored trajectory row is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
        context: { stepId, agentId: runtime.agentId },
      });
    }
    const trajectory = parsePersistedTrajectoryRow(row, stepId);
    // Prefer steps from the dedicated trajectory_steps table when present.
    // Falls back to the legacy steps_json blob (already populated from
    // parsePersistedTrajectoryRow) when the dedicated table has no rows.
    const stepsFromTable = await loadAllStepsFromDedicatedTable(
      runtime,
      stepId,
    );
    if (stepsFromTable !== null) {
      trajectory.steps = stepsFromTable;
    }
    return trajectory;
  } catch (error) {
    // error-policy:J2 a database read failure is distinct from a successful
    // lookup with no row.
    throw new ElizaError("Could not load trajectory", {
      code: "TRAJECTORY_LOAD_FAILED",
      cause: error,
      context: { stepId },
    });
  }
}

/**
 * Loads the canonical step rows, using `null` solely to signal that a
 * trajectory has not yet been promoted from its compatibility snapshot.
 */
async function loadAllStepsFromDedicatedTable(
  runtime: IAgentRuntime,
  trajectoryId: string,
): Promise<PersistedStep[] | null> {
  const safeId = sqlQuote(trajectoryId);
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectory_steps
       WHERE trajectory_id = ${safeId}
       ORDER BY ordinal ASC`,
    );
    const rows = extractRequiredRows(result, {
      operation: "load dedicated steps",
      trajectoryId,
    });
    if (rows.length === 0) return null;
    return rows.map((row, index) => {
      const record = asRecord(row);
      if (!record) {
        throw new ElizaError("Stored trajectory step row is invalid", {
          code: "TRAJECTORY_STEP_ROW_INVALID",
          context: { trajectoryId, index },
        });
      }
      return stepRowToPersistedStep(record);
    });
  } catch (error) {
    if (
      error instanceof ElizaError &&
      (error.code === "TRAJECTORY_ROW_INVALID" ||
        error.code === "TRAJECTORY_STEP_ROW_INVALID")
    ) {
      throw error;
    }
    // error-policy:J2 absence is represented by a successful zero-row query;
    // storage failures retain their cause.
    throw new ElizaError("Could not load trajectory steps", {
      code: "TRAJECTORY_STEPS_LOAD_FAILED",
      cause: error,
      context: { trajectoryId },
    });
  }
}

export function stepRowToPersistedStep(
  row: Record<string, unknown>,
): PersistedStep {
  const payload = parseJsonValue(readRecordValue(row, ["payload"]));
  const payloadRecord = asRecord(payload);
  const trajectoryId = toText(
    readRecordValue(row, ["trajectory_id", "trajectoryId"]),
    "",
  ).trim();
  const stepId = toText(readRecordValue(row, ["id"]), "").trim();
  const stepNumber = toOptionalNumber(readRecordValue(row, ["ordinal"]));
  const startedAt = toOptionalNumber(readRecordValue(row, ["started_at"]));
  const endedAt = toOptionalNumber(readRecordValue(row, ["ended_at"]));
  if (
    !payloadRecord ||
    !trajectoryId ||
    !stepId ||
    stepNumber === undefined ||
    (startedAt === undefined && endedAt === undefined) ||
    !Array.isArray(payloadRecord.llmCalls) ||
    !Array.isArray(payloadRecord.providerAccesses)
  ) {
    throw new ElizaError("Stored trajectory step row is invalid", {
      code: "TRAJECTORY_STEP_ROW_INVALID",
      context: { stepId },
    });
  }
  const parentStepValue = readRecordValue(row, [
    "parent_step_id",
    "parentStepId",
  ]);
  const parentStepId =
    parentStepValue === undefined || parentStepValue === null
      ? undefined
      : typeof parentStepValue === "string" && parentStepValue.trim().length > 0
        ? parentStepValue.trim()
        : null;
  const kindRaw = readRecordValue(row, ["step_type"]);
  const kind =
    kindRaw === "llm" || kindRaw === "action" || kindRaw === "evaluator"
      ? kindRaw
      : null;
  const scriptValue = readRecordValue(row, ["script"]);
  const script =
    scriptValue === undefined || scriptValue === null
      ? undefined
      : typeof scriptValue === "string"
        ? scriptValue
        : null;
  if (parentStepId === null || kind === null || script === null) {
    throw new ElizaError("Stored trajectory step row is invalid", {
      code: "TRAJECTORY_STEP_ROW_INVALID",
      context: {
        trajectoryId,
        stepId,
        field:
          parentStepId === null
            ? "parent_step_id"
            : kind === null
              ? "step_type"
              : "script",
      },
    });
  }
  const scriptHash =
    typeof payloadRecord.scriptHash === "string"
      ? payloadRecord.scriptHash
      : undefined;

  return parsePersistedStepObject(
    {
      ...payloadRecord,
      stepId,
      stepNumber,
      timestamp: startedAt ?? (endedAt as number),
      parentStepId,
      kind,
      script,
      ...(scriptHash !== undefined ? { scriptHash } : {}),
      ...(kind === "evaluator" && payloadRecord.evaluatorName === undefined
        ? { evaluatorName: readRecordValue(row, ["name"]) }
        : {}),
    },
    trajectoryId,
    stepNumber,
  );
}

export function buildTrajectoryStepUpsertSql(
  trajectoryId: string,
  step: PersistedStep,
  parentStepIdOverride?: string | null,
  conflictAction = "DO UPDATE SET",
): string {
  const stepType =
    step.kind === "llm" || step.kind === "action" || step.kind === "evaluator"
      ? step.kind
      : "llm";
  const script =
    typeof step.script === "string" && step.script.length > 0
      ? step.script
      : null;
  const { script: _script, ...payloadObject } = step;
  const startedAt = Number.isFinite(step.timestamp) ? step.timestamp : null;
  const name =
    step.kind === "evaluator" && step.evaluatorName
      ? step.evaluatorName
      : (step.llmCalls[0]?.purpose ??
        step.providerAccesses[0]?.providerName ??
        null);
  const parentStepId =
    parentStepIdOverride !== undefined
      ? parentStepIdOverride
      : typeof step.parentStepId === "string" && step.parentStepId.length > 0
        ? step.parentStepId
        : null;
  const updateClause =
    conflictAction === "DO NOTHING"
      ? "DO NOTHING"
      : `DO UPDATE SET
        trajectory_id = EXCLUDED.trajectory_id,
        ordinal = EXCLUDED.ordinal,
        parent_step_id = EXCLUDED.parent_step_id,
        step_type = EXCLUDED.step_type,
        name = EXCLUDED.name,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        payload = EXCLUDED.payload,
        script = EXCLUDED.script
        WHERE trajectory_steps.trajectory_id = EXCLUDED.trajectory_id`;

  return `INSERT INTO trajectory_steps (
      id, trajectory_id, ordinal, parent_step_id, step_type,
      name, started_at, ended_at, payload, script
    ) VALUES (
      ${sqlQuote(step.stepId)},
      ${sqlQuote(trajectoryId)},
      ${sqlNumber(step.stepNumber)},
      ${parentStepId !== null ? sqlQuote(parentStepId) : "NULL"},
      ${sqlQuote(stepType)},
      ${name ? sqlQuote(name) : "NULL"},
      ${sqlNumber(startedAt)},
      ${sqlNumber(startedAt)},
      ${sqlQuote(JSON.stringify(payloadObject))},
      ${script !== null ? sqlQuote(script) : "NULL"}
    )
    ON CONFLICT (id) ${updateClause}`;
}

export async function assertTrajectoryStepOwnership(
  execute: RawSqlExecutor,
  trajectoryId: string,
  stepId: string,
): Promise<void> {
  const result = await execute(
    `SELECT trajectory_id FROM trajectory_steps WHERE id = ${sqlQuote(stepId)} LIMIT 1`,
  );
  const existing = asRecord(
    extractRequiredRows(result, {
      operation: "check trajectory step ownership",
      trajectoryId,
      stepId,
    })[0],
  );
  const existingTrajectoryId = toOptionalText(existing?.trajectory_id);
  if (existingTrajectoryId && existingTrajectoryId !== trajectoryId) {
    throw new ElizaError("Trajectory step belongs to another trajectory", {
      code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
      context: { stepId, trajectoryId, existingTrajectoryId },
    });
  }
}

export async function assertTrajectoryAgentOwnership(
  execute: RawSqlExecutor,
  trajectoryId: string,
  agentId: string,
  allowMissing = false,
): Promise<void> {
  const result = await execute(
    `SELECT agent_id FROM trajectories WHERE id = ${sqlQuote(trajectoryId)} LIMIT 1`,
  );
  const owner = toOptionalText(
    asRecord(
      extractRequiredRows(result, {
        operation: "check trajectory ownership",
        trajectoryId,
        agentId,
      })[0],
    )?.agent_id,
  );
  if (!owner && allowMissing) return;
  if (!owner) {
    throw new ElizaError("Trajectory parent is unavailable", {
      code: "TRAJECTORY_PARENT_NOT_FOUND",
      context: { trajectoryId, agentId },
    });
  }
  if (owner !== agentId) {
    throw new ElizaError("Trajectory belongs to another agent", {
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
      context: {
        trajectoryId,
        existingAgentId: owner,
        runtimeAgentId: agentId,
      },
    });
  }
}

export async function assertTrajectoryStepParentOwnership(
  execute: RawSqlExecutor,
  trajectoryId: string,
  step: PersistedStep,
): Promise<void> {
  const parentStepId = step.parentStepId?.trim();
  if (!parentStepId) return;
  if (parentStepId === step.stepId) {
    throw new ElizaError("Trajectory step cannot parent itself", {
      code: "TRAJECTORY_STEP_PARENT_INVALID",
      context: { trajectoryId, stepId: step.stepId, parentStepId },
    });
  }
  const result = await execute(
    `SELECT trajectory_id FROM trajectory_steps
     WHERE id = ${sqlQuote(parentStepId)} LIMIT 1`,
  );
  const parentOwner = toOptionalText(
    asRecord(
      extractRequiredRows(result, {
        operation: "check trajectory step parent",
        trajectoryId,
        stepId: step.stepId,
        parentStepId,
      })[0],
    )?.trajectory_id,
  );
  if (parentOwner !== trajectoryId) {
    throw new ElizaError("Trajectory step parent is unavailable", {
      code: "TRAJECTORY_STEP_PARENT_INVALID",
      context: {
        trajectoryId,
        stepId: step.stepId,
        parentStepId,
        ...(parentOwner ? { parentOwner } : {}),
      },
    });
  }
}

export function parsePersistedEvaluatorName(
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ElizaError("Stored trajectory evaluator name is invalid", {
      code: "TRAJECTORY_EVALUATOR_NAME_INVALID",
    });
  }
  return value;
}

export function parsePersistedSkillInvocations(
  value: unknown,
): TrajectorySkillInvocation[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ElizaError("Stored trajectory skill invocations are invalid", {
      code: "TRAJECTORY_SKILL_INVOCATIONS_INVALID",
    });
  }

  return value.map((entry, index) => {
    const record = asRecord(entry);
    const skillSlug = toText(record?.skillSlug, "").trim();
    const durationMs = toOptionalNumber(record?.durationMs);
    const parentStepId = toText(record?.parentStepId, "").trim();
    const startedAt = toOptionalNumber(record?.startedAt);
    if (
      !record ||
      !skillSlug ||
      durationMs === undefined ||
      durationMs < 0 ||
      !parentStepId ||
      typeof record.success !== "boolean" ||
      startedAt === undefined
    ) {
      throw new ElizaError("Stored trajectory skill invocation is invalid", {
        code: "TRAJECTORY_SKILL_INVOCATION_INVALID",
        context: { index, skillSlug },
      });
    }

    const optionalStrings = ["args", "result", "script"] as const;
    for (const field of optionalStrings) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new ElizaError(
          `Stored trajectory skill invocation ${field} is invalid`,
          {
            code: "TRAJECTORY_SKILL_INVOCATION_INVALID",
            context: { index, skillSlug, field },
          },
        );
      }
    }
    if (
      record.mode !== undefined &&
      record.mode !== "script" &&
      record.mode !== "guidance"
    ) {
      throw new ElizaError(
        "Stored trajectory skill invocation mode is invalid",
        {
          code: "TRAJECTORY_SKILL_INVOCATION_INVALID",
          context: { index, skillSlug, field: "mode" },
        },
      );
    }

    let truncated: TrajectorySkillInvocation["truncated"];
    if (record.truncated !== undefined) {
      if (!Array.isArray(record.truncated)) {
        throw new ElizaError(
          "Stored trajectory skill invocation truncation is invalid",
          {
            code: "TRAJECTORY_SKILL_INVOCATION_INVALID",
            context: { index, skillSlug, field: "truncated" },
          },
        );
      }
      truncated = record.truncated.map((marker, markerIndex) => {
        const markerRecord = asRecord(marker);
        const field = markerRecord?.field;
        const originalBytes = toOptionalNumber(markerRecord?.originalBytes);
        const capBytes = toOptionalNumber(markerRecord?.capBytes);
        if (
          !markerRecord ||
          (field !== "args" && field !== "result") ||
          originalBytes === undefined ||
          originalBytes < 0 ||
          capBytes === undefined ||
          capBytes < 0
        ) {
          throw new ElizaError(
            "Stored trajectory skill invocation truncation marker is invalid",
            {
              code: "TRAJECTORY_SKILL_INVOCATION_INVALID",
              context: { index, markerIndex, skillSlug },
            },
          );
        }
        return { field, originalBytes, capBytes };
      });
    }

    return {
      skillSlug,
      durationMs,
      parentStepId,
      success: record.success,
      startedAt,
      ...(record.args !== undefined ? { args: record.args as string } : {}),
      ...(record.result !== undefined
        ? { result: record.result as string }
        : {}),
      ...(record.script !== undefined
        ? { script: record.script as string }
        : {}),
      ...(record.mode !== undefined ? { mode: record.mode } : {}),
      ...(truncated !== undefined ? { truncated } : {}),
    };
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return record ? Object.values(record).every(isJsonValue) : false;
}

function parsePersistedActionAttempt(
  value: unknown,
): TrajectoryActionAttempt | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const attemptId = toText(record?.attemptId, "").trim();
  const timestamp =
    typeof record?.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : undefined;
  const actionType = toText(record?.actionType, "").trim();
  const actionName = toText(record?.actionName, "").trim();
  const parameters = asRecord(record?.parameters);
  const success = record?.success;
  if (
    !record ||
    !attemptId ||
    timestamp === undefined ||
    !actionType ||
    !actionName ||
    !parameters ||
    !isJsonValue(parameters) ||
    typeof success !== "boolean"
  ) {
    throw new ElizaError("Stored trajectory action is invalid", {
      code: "TRAJECTORY_ACTION_INVALID",
      context: { actionName, actionType },
    });
  }

  const result = asRecord(record.result);
  if (record.result !== undefined && (!result || !isJsonValue(result))) {
    throw new ElizaError("Stored trajectory action result is invalid", {
      code: "TRAJECTORY_ACTION_RESULT_INVALID",
      context: { actionName, actionType },
    });
  }
  for (const field of ["error", "reasoning", "llmCallId"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new ElizaError("Stored trajectory action field is invalid", {
        code: "TRAJECTORY_ACTION_INVALID",
        context: { actionName, actionType, field },
      });
    }
  }
  if (
    record.immediateReward !== undefined &&
    (typeof record.immediateReward !== "number" ||
      !Number.isFinite(record.immediateReward))
  ) {
    throw new ElizaError("Stored trajectory action reward is invalid", {
      code: "TRAJECTORY_ACTION_INVALID",
      context: { actionName, actionType, field: "immediateReward" },
    });
  }

  return {
    attemptId,
    timestamp,
    actionType,
    actionName,
    parameters,
    success,
    ...(result ? { result: result as Record<string, JsonValue> } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.reasoning === "string"
      ? { reasoning: record.reasoning }
      : {}),
    ...(typeof record.llmCallId === "string"
      ? { llmCallId: record.llmCallId }
      : {}),
    ...(typeof record.immediateReward === "number"
      ? { immediateReward: record.immediateReward }
      : {}),
  };
}

function persistedRowError(
  trajectoryId: string,
  field: string,
  stepId?: string,
  index?: number,
): ElizaError {
  return new ElizaError("Stored trajectory row is invalid", {
    code: "TRAJECTORY_ROW_INVALID",
    context: {
      trajectoryId,
      field,
      ...(stepId ? { stepId } : {}),
      ...(index !== undefined ? { index } : {}),
    },
  });
}

function requiredPersistedString(
  value: unknown,
  trajectoryId: string,
  field: string,
  stepId?: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw persistedRowError(trajectoryId, field, stepId);
  }
  return value;
}

function requiredPersistedNumber(
  value: unknown,
  trajectoryId: string,
  field: string,
  stepId?: string,
): number {
  const parsed = toOptionalNumber(value);
  if (parsed === undefined) {
    throw persistedRowError(trajectoryId, field, stepId);
  }
  return parsed;
}

function requiredPersistedJsonNumber(
  value: unknown,
  trajectoryId: string,
  field: string,
  stepId?: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw persistedRowError(trajectoryId, field, stepId);
  }
  return value;
}

function parseOptionalPersistedString(
  record: Record<string, unknown>,
  field: string,
  trajectoryId: string,
  stepId: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw persistedRowError(trajectoryId, field, stepId);
  }
  return value;
}

function parseOptionalPersistedNumber(
  record: Record<string, unknown>,
  field: string,
  trajectoryId: string,
  stepId: string,
): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw persistedRowError(trajectoryId, field, stepId);
  }
  return value;
}

export function parsePersistedLlmCall(
  value: unknown,
  trajectoryId: string,
  stepId: string,
  index: number,
): PersistedLlmCall {
  const record = asRecord(value);
  if (!record) {
    throw persistedRowError(trajectoryId, "llmCalls", stepId, index);
  }
  const callId = requiredPersistedString(
    record.callId,
    trajectoryId,
    `llmCalls[${index}].callId`,
    stepId,
  );
  const timestamp = requiredPersistedJsonNumber(
    record.timestamp,
    trajectoryId,
    `llmCalls[${index}].timestamp`,
    stepId,
  );
  const model = requiredPersistedString(
    record.model,
    trajectoryId,
    `llmCalls[${index}].model`,
    stepId,
  );
  const response = requiredPersistedString(
    record.response,
    trajectoryId,
    `llmCalls[${index}].response`,
    stepId,
    true,
  );
  const purpose = requiredPersistedString(
    record.purpose,
    trajectoryId,
    `llmCalls[${index}].purpose`,
    stepId,
  );
  const actionType = requiredPersistedString(
    record.actionType,
    trajectoryId,
    `llmCalls[${index}].actionType`,
    stepId,
  );
  const stringFields = [
    "provider",
    "modelVersion",
    "modelType",
    "systemPrompt",
    "userPrompt",
    "prompt",
    "finishReason",
    "reasoning",
    "stepType",
    "modelSlot",
    "runId",
    "roomId",
    "messageId",
    "executionTraceId",
    "createdAt",
  ] as const;
  const numericFields = [
    "temperature",
    "maxTokens",
    "topP",
    "latencyMs",
    "promptTokens",
    "completionTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningTokens",
  ] as const;
  const optional: Record<string, unknown> = {};
  for (const field of stringFields) {
    const parsed = parseOptionalPersistedString(
      record,
      field,
      trajectoryId,
      stepId,
    );
    if (parsed !== undefined) optional[field] = parsed;
  }
  for (const field of numericFields) {
    const parsed = parseOptionalPersistedNumber(
      record,
      field,
      trajectoryId,
      stepId,
    );
    if (parsed !== undefined) optional[field] = parsed;
  }
  for (const field of [
    "messages",
    "toolCalls",
    "tags",
    "providerOrder",
  ] as const) {
    if (record[field] !== undefined && !Array.isArray(record[field])) {
      throw persistedRowError(
        trajectoryId,
        `llmCalls[${index}].${field}`,
        stepId,
      );
    }
  }
  for (const field of ["maxTokensOmitted", "tokenUsageEstimated"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      throw persistedRowError(
        trajectoryId,
        `llmCalls[${index}].${field}`,
        stepId,
      );
    }
  }
  return {
    ...record,
    ...optional,
    callId,
    timestamp,
    model,
    response,
    purpose,
    actionType,
  } as PersistedLlmCall;
}

export function parsePersistedProviderAccess(
  value: unknown,
  trajectoryId: string,
  stepId: string,
  index: number,
): PersistedProviderAccess {
  const record = asRecord(value);
  if (!record) {
    throw persistedRowError(trajectoryId, "providerAccesses", stepId, index);
  }
  const providerId = requiredPersistedString(
    record.providerId,
    trajectoryId,
    `providerAccesses[${index}].providerId`,
    stepId,
  );
  const providerName = requiredPersistedString(
    record.providerName,
    trajectoryId,
    `providerAccesses[${index}].providerName`,
    stepId,
  );
  const timestamp = requiredPersistedJsonNumber(
    record.timestamp,
    trajectoryId,
    `providerAccesses[${index}].timestamp`,
    stepId,
  );
  const purpose = requiredPersistedString(
    record.purpose,
    trajectoryId,
    `providerAccesses[${index}].purpose`,
    stepId,
  );
  const data = asRecord(record.data);
  if (!data || !isJsonValue(data)) {
    throw persistedRowError(
      trajectoryId,
      `providerAccesses[${index}].data`,
      stepId,
    );
  }
  const optional: Record<string, unknown> = {};
  for (const field of [
    "startedAt",
    "endedAt",
    "durationMs",
    "tokenCount",
    "position",
    "spanStart",
    "spanEnd",
  ] as const) {
    if (
      (field === "startedAt" ||
        field === "endedAt" ||
        field === "durationMs") &&
      record[field] === null
    ) {
      optional[field] = null;
      continue;
    }
    const parsed = parseOptionalPersistedNumber(
      record,
      field,
      trajectoryId,
      stepId,
    );
    if (parsed !== undefined) optional[field] = parsed;
  }
  for (const field of [
    "runId",
    "roomId",
    "messageId",
    "executionTraceId",
    "createdAt",
  ] as const) {
    const parsed = parseOptionalPersistedString(
      record,
      field,
      trajectoryId,
      stepId,
    );
    if (parsed !== undefined) optional[field] = parsed;
  }
  if (
    record.query !== undefined &&
    (!asRecord(record.query) || !isJsonValue(record.query))
  ) {
    throw persistedRowError(
      trajectoryId,
      `providerAccesses[${index}].query`,
      stepId,
    );
  }
  if (
    record.overlapsWith !== undefined &&
    (!Array.isArray(record.overlapsWith) ||
      record.overlapsWith.some((overlap) => {
        const overlapRecord = asRecord(overlap);
        return (
          !overlapRecord ||
          typeof overlapRecord.providerName !== "string" ||
          overlapRecord.providerName.trim().length === 0 ||
          typeof overlapRecord.overlapMs !== "number" ||
          !Number.isFinite(overlapRecord.overlapMs) ||
          overlapRecord.overlapMs < 0
        );
      }))
  ) {
    throw persistedRowError(
      trajectoryId,
      `providerAccesses[${index}].overlapsWith`,
      stepId,
    );
  }
  return {
    ...record,
    ...optional,
    providerId,
    providerName,
    timestamp,
    purpose,
    data,
  } as PersistedProviderAccess;
}

export function parsePersistedStepObject(
  value: unknown,
  trajectoryId: string,
  index: number,
): PersistedStep {
  const record = asRecord(value);
  if (!record) throw persistedRowError(trajectoryId, "steps", undefined, index);
  const stepId = requiredPersistedString(
    record.stepId,
    trajectoryId,
    `steps[${index}].stepId`,
  );
  const stepNumber = requiredPersistedJsonNumber(
    record.stepNumber,
    trajectoryId,
    `steps[${index}].stepNumber`,
    stepId,
  );
  if (!Number.isInteger(stepNumber) || stepNumber < 0) {
    throw persistedRowError(trajectoryId, `steps[${index}].stepNumber`, stepId);
  }
  const timestamp = requiredPersistedJsonNumber(
    record.timestamp,
    trajectoryId,
    `steps[${index}].timestamp`,
    stepId,
  );
  if (
    !Array.isArray(record.llmCalls) ||
    !Array.isArray(record.providerAccesses)
  ) {
    throw persistedRowError(trajectoryId, `steps[${index}].captures`, stepId);
  }
  const childSteps = record.childSteps;
  const usedSkills = record.usedSkills;
  if (
    childSteps !== undefined &&
    (!Array.isArray(childSteps) ||
      childSteps.some((entry) => typeof entry !== "string"))
  ) {
    throw persistedRowError(trajectoryId, `steps[${index}].childSteps`, stepId);
  }
  if (
    usedSkills !== undefined &&
    (!Array.isArray(usedSkills) ||
      usedSkills.some((entry) => typeof entry !== "string"))
  ) {
    throw persistedRowError(trajectoryId, `steps[${index}].usedSkills`, stepId);
  }
  const parentStepId = parseOptionalPersistedString(
    record,
    "parentStepId",
    trajectoryId,
    stepId,
  );
  const kind = record.kind;
  if (
    kind !== undefined &&
    kind !== "llm" &&
    kind !== "action" &&
    kind !== "evaluator"
  ) {
    throw persistedRowError(trajectoryId, `steps[${index}].kind`, stepId);
  }
  const script = parseOptionalPersistedString(
    record,
    "script",
    trajectoryId,
    stepId,
  );
  const scriptHash = parseOptionalPersistedString(
    record,
    "scriptHash",
    trajectoryId,
    stepId,
  );
  const evaluatorName = parsePersistedEvaluatorName(record.evaluatorName);
  const skillInvocations = parsePersistedSkillInvocations(
    record.skillInvocations,
  );
  const semanticStages = parseTrajectorySemanticStages(record.semanticStages);
  const action = parsePersistedActionAttempt(record.action);
  return {
    stepId,
    stepNumber,
    timestamp,
    llmCalls: record.llmCalls.map((call, callIndex) =>
      parsePersistedLlmCall(call, trajectoryId, stepId, callIndex),
    ),
    providerAccesses: record.providerAccesses.map((access, accessIndex) =>
      parsePersistedProviderAccess(access, trajectoryId, stepId, accessIndex),
    ),
    ...(parentStepId !== undefined ? { parentStepId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(childSteps !== undefined ? { childSteps: [...childSteps] } : {}),
    ...(usedSkills !== undefined ? { usedSkills: [...usedSkills] } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(scriptHash !== undefined ? { scriptHash } : {}),
    ...(evaluatorName !== undefined ? { evaluatorName } : {}),
    ...(skillInvocations !== undefined ? { skillInvocations } : {}),
    ...(semanticStages !== undefined ? { semanticStages } : {}),
  };
}

export async function loadTrajectoryByStepId(
  runtime: IAgentRuntime,
  stepId: string,
): Promise<PersistedTrajectory | null> {
  const direct = await loadTrajectoryById(runtime, stepId);
  if (direct) {
    return direct;
  }

  const normalizedStepId = stepId.trim();
  if (!normalizedStepId) {
    return null;
  }

  const dedicatedResult = await executeRawSql(
    runtime,
    `SELECT s.trajectory_id
     FROM trajectory_steps s
     JOIN trajectories t ON t.id = s.trajectory_id
     WHERE s.id = ${sqlQuote(normalizedStepId)}
       AND t.agent_id = ${sqlQuote(runtime.agentId)}
     LIMIT 1`,
  );
  const dedicatedTrajectoryId = toOptionalText(
    asRecord(
      extractRequiredRows(dedicatedResult, {
        operation: "resolve trajectory step owner",
        stepId: normalizedStepId,
        agentId: runtime.agentId,
      })[0],
    )?.trajectory_id,
  );
  if (dedicatedTrajectoryId) {
    return loadTrajectoryById(runtime, dedicatedTrajectoryId);
  }

  const stepPattern = sqlQuote(`%"stepId":"${normalizedStepId}"%`);
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories
       WHERE agent_id = ${sqlQuote(runtime.agentId)}
         AND COALESCE(steps_json::text, '') LIKE ${stepPattern}
         AND NOT EXISTS (
           SELECT 1 FROM trajectory_steps s WHERE s.trajectory_id = trajectories.id
         )
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    );
    const rows = extractRequiredRows(result, {
      operation: "search legacy trajectory steps",
      stepId: normalizedStepId,
      agentId: runtime.agentId,
    });
    if (rows.length === 0) return null;
    const row = asRecord(rows[0]);
    if (!row) {
      throw persistedRowError(normalizedStepId, "row");
    }
    return parsePersistedTrajectoryRow(row, normalizedStepId);
  } catch (error) {
    // error-policy:J2 a failed search cannot be represented as no matching
    // trajectory because callers use null as the valid not-found result.
    throw new ElizaError("Could not search trajectories by step", {
      code: "TRAJECTORY_STEP_SEARCH_FAILED",
      cause: error,
      context: { stepId: normalizedStepId },
    });
  }
}

function normalizeStepForPersistence(
  trajectoryId: string,
  step: PersistedStep,
): PersistedStep {
  const {
    llmCalls,
    providerAccesses,
    childSteps,
    usedSkills,
    skillInvocations,
    semanticStages,
    script,
    ...scalarFields
  } = step;
  const boundedScalars = sanitizeTrajectoryJsonObject(scalarFields);
  if (!boundedScalars) {
    throw new ElizaError("Trajectory step could not be normalized", {
      code: "TRAJECTORY_STEP_INVALID",
      context: { trajectoryId, stepId: step.stepId },
    });
  }
  const normalizeRecord = (
    value: unknown,
    field: "llmCalls" | "providerAccesses",
    index: number,
  ): Record<string, unknown> => {
    const bounded = sanitizeTrajectoryJsonObject(value);
    if (!bounded) {
      throw new ElizaError("Trajectory step record could not be normalized", {
        code: "TRAJECTORY_STEP_INVALID",
        context: { trajectoryId, stepId: step.stepId, field, index },
      });
    }
    return bounded;
  };
  const normalizeProviderRecord = (
    access: PersistedProviderAccess,
    index: number,
  ): PersistedProviderAccess => {
    const { providerId, providerName, timestamp, purpose, data, ...extras } =
      access;
    const bounded = snapshotCaptureParams(
      {
        providerId,
        providerName,
        timestamp,
        purpose,
        data,
        ...extras,
      },
      step.stepId,
    );
    return parsePersistedProviderAccess(
      bounded,
      trajectoryId,
      step.stepId,
      index,
    );
  };

  return {
    ...(boundedScalars as unknown as PersistedStep),
    stepId: step.stepId,
    stepNumber: step.stepNumber,
    timestamp: step.timestamp,
    llmCalls: llmCalls.map(
      (call, index) =>
        normalizeRecord(call, "llmCalls", index) as unknown as PersistedLlmCall,
    ),
    providerAccesses: providerAccesses.map(normalizeProviderRecord),
    ...(childSteps !== undefined ? { childSteps: [...childSteps] } : {}),
    ...(usedSkills !== undefined ? { usedSkills: [...usedSkills] } : {}),
    ...(skillInvocations !== undefined
      ? {
          skillInvocations:
            parsePersistedSkillInvocations(skillInvocations) ?? [],
        }
      : {}),
    ...(semanticStages !== undefined
      ? { semanticStages: parseTrajectorySemanticStages(semanticStages) }
      : {}),
    ...(script !== undefined ? { script } : {}),
  };
}

export async function saveTrajectory(
  runtime: IAgentRuntime,
  trajectory: PersistedTrajectory,
  options: {
    changedStepIds?: readonly string[];
    updateLegacySnapshot?: boolean;
    requireActiveExisting?: boolean;
    expectedUpdatedAt?: string;
    createOnly?: boolean;
  } = {},
): Promise<boolean> {
  if (
    options.createOnly &&
    (options.requireActiveExisting || options.expectedUpdatedAt !== undefined)
  ) {
    throw new ElizaError(
      "Insert-only trajectory writes cannot update an existing row",
      {
        code: "TRAJECTORY_WRITE_PRECONDITION_INVALID",
        context: { trajectoryId: trajectory.id },
      },
    );
  }
  if (trajectory.agentId !== runtime.agentId) {
    throw new ElizaError("Trajectory belongs to another agent", {
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
      context: {
        trajectoryId: trajectory.id,
        trajectoryAgentId: trajectory.agentId,
        runtimeAgentId: runtime.agentId,
      },
    });
  }
  const normalizedMetadata = normalizeTrajectoryMetadata(trajectory.metadata, {
    scenarioId: trajectory.scenarioId,
    batchId: trajectory.batchId,
  });
  trajectory.metadata = normalizedMetadata.metadata;
  trajectory.scenarioId = normalizedMetadata.scenarioId;
  trajectory.batchId = normalizedMetadata.batchId;

  const summary = summarizeTrajectory(trajectory);
  const isActive = trajectory.status === "active";
  const persistedEndTime =
    typeof trajectory.endTime === "number" &&
    Number.isFinite(trajectory.endTime) &&
    trajectory.endTime >= summary.startTime
      ? trajectory.endTime
      : undefined;
  const summaryEndTime =
    Number.isFinite(summary.endTime) && summary.endTime >= summary.startTime
      ? summary.endTime
      : summary.startTime;
  const endTime = isActive ? null : (persistedEndTime ?? summaryEndTime);
  const durationMs =
    typeof endTime === "number"
      ? Math.max(0, endTime - summary.startTime)
      : null;
  const createdAt =
    trajectory.createdAt || new Date(summary.startTime).toISOString();
  const updatedAt =
    trajectory.updatedAt || new Date(endTime ?? summary.endTime).toISOString();
  const boundedSteps = trajectory.steps.map((step) =>
    normalizeStepForPersistence(trajectory.id, step),
  );
  // Conditional captures update dedicated step rows. Keep their validation
  // above, but build the complete compatibility snapshot only if it is written.
  // Otherwise every small child update serializes all prior model payloads.
  let serializedLegacySteps: string | undefined;
  const serializeLegacySteps = (): string => {
    if (serializedLegacySteps !== undefined) return serializedLegacySteps;
    const legacySteps = boundedSteps.map((step) => {
      if (typeof step.script !== "string") return step;
      const capped = capScriptForPersistence(step.script);
      return {
        ...step,
        script: capped.script,
        ...(capped.scriptHash !== undefined
          ? { scriptHash: capped.scriptHash }
          : {}),
      };
    });
    serializedLegacySteps = sqlQuote(JSON.stringify(legacySteps));
    return serializedLegacySteps;
  };
  const boundedMetadata = sanitizeTrajectoryJsonObject(trajectory.metadata);
  if (!boundedMetadata) {
    throw new ElizaError("Trajectory metadata could not be normalized", {
      code: "TRAJECTORY_METADATA_INVALID",
      context: { trajectoryId: trajectory.id },
    });
  }
  const serializedMetadata = sqlQuote(JSON.stringify(boundedMetadata));
  // Canonical metrics_json shape required by Core validators and the viewer
  // duck contract. Primary write targets the current schema; legacy
  // metadata/episode_length is only a fallback when those columns are absent
  // (#17730).
  const boundedMetrics = sanitizeTrajectoryJsonObject({
    ...trajectory.metrics,
    episodeLength: trajectory.steps.length,
    finalStatus: trajectory.status,
    llmCallCount: summary.llmCallCount,
    providerAccessCount: summary.providerAccessCount,
    totalPromptTokens: summary.totalPromptTokens,
    totalCompletionTokens: summary.totalCompletionTokens,
    totalCacheReadInputTokens: summary.totalCacheReadInputTokens,
    totalCacheCreationInputTokens: summary.totalCacheCreationInputTokens,
  });
  const boundedRewardComponents = sanitizeTrajectoryJsonObject(
    trajectory.rewardComponents,
  );
  if (!boundedMetrics || !boundedRewardComponents) {
    throw new ElizaError("Trajectory metrics could not be normalized", {
      code: "TRAJECTORY_METRICS_INVALID",
      context: { trajectoryId: trajectory.id },
    });
  }
  const serializedMetrics = sqlQuote(JSON.stringify(boundedMetrics));
  const serializedRewardComponents = sqlQuote(
    JSON.stringify(boundedRewardComponents),
  );
  const replaceAllSteps = options.changedStepIds === undefined;
  const changedStepIds = new Set(options.changedStepIds ?? []);
  const stepsToPersist = replaceAllSteps
    ? boundedSteps
    : boundedSteps.filter((step) => changedStepIds.has(step.stepId));
  const updateLegacyStepsSql =
    replaceAllSteps || options.updateLegacySnapshot
      ? "steps_json = EXCLUDED.steps_json,"
      : "";
  const updateLegacyStepsValueSql =
    replaceAllSteps || options.updateLegacySnapshot
      ? `steps_json = ${serializeLegacySteps()},`
      : "";

  // Current schema (Core TrajectoriesService): metrics_json / metadata_json /
  // reward_components_json. Prefer this so active/completed metrics are always
  // valid for strict Core readers that share the table.
  const currentSchemaInsertSql = () => `INSERT INTO trajectories (
      id,
      agent_id,
      source,
      status,
      start_time,
      end_time,
      duration_ms,
      step_count,
      llm_call_count,
      provider_access_count,
      total_prompt_tokens,
      total_completion_tokens,
      total_cache_read_input_tokens,
      total_cache_creation_input_tokens,
      total_reward,
      scenario_id,
      trace_id,
      episode_id,
      batch_id,
      group_index,
      steps_json,
      metadata_json,
      metrics_json,
      reward_components_json,
      created_at,
      updated_at
    ) VALUES (
      ${sqlQuote(trajectory.id)},
      ${sqlQuote(runtime.agentId)},
      ${sqlQuote(trajectory.source)},
      ${sqlQuote(trajectory.status)},
      ${sqlNumber(summary.startTime)},
      ${sqlNumber(endTime)},
      ${sqlNumber(durationMs)},
      ${sqlNumber(trajectory.steps.length)},
      ${sqlNumber(summary.llmCallCount)},
      ${sqlNumber(summary.providerAccessCount)},
      ${sqlNumber(summary.totalPromptTokens)},
      ${sqlNumber(summary.totalCompletionTokens)},
      ${sqlNumber(summary.totalCacheReadInputTokens)},
      ${sqlNumber(summary.totalCacheCreationInputTokens)},
      ${sqlNumber(trajectory.totalReward)},
      ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      ${trajectory.traceId ? sqlQuote(trajectory.traceId) : "NULL"},
      ${trajectory.episodeId ? sqlQuote(trajectory.episodeId) : "NULL"},
      ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      ${sqlNumber(trajectory.groupIndex)},
      ${serializeLegacySteps()},
      ${serializedMetadata},
      ${serializedMetrics},
      ${serializedRewardComponents},
      ${sqlQuote(createdAt)},
      ${sqlQuote(updatedAt)}
    )`;
  const currentSchemaSql = () =>
    options.createOnly
      ? `${currentSchemaInsertSql()} ON CONFLICT (id) DO NOTHING RETURNING id`
      : `${currentSchemaInsertSql()}
    ON CONFLICT (id) DO UPDATE SET
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      duration_ms = EXCLUDED.duration_ms,
      step_count = EXCLUDED.step_count,
      llm_call_count = EXCLUDED.llm_call_count,
      provider_access_count = EXCLUDED.provider_access_count,
      total_prompt_tokens = EXCLUDED.total_prompt_tokens,
      total_completion_tokens = EXCLUDED.total_completion_tokens,
      total_cache_read_input_tokens = EXCLUDED.total_cache_read_input_tokens,
      total_cache_creation_input_tokens = EXCLUDED.total_cache_creation_input_tokens,
      total_reward = EXCLUDED.total_reward,
      scenario_id = EXCLUDED.scenario_id,
      trace_id = EXCLUDED.trace_id,
      episode_id = EXCLUDED.episode_id,
      batch_id = EXCLUDED.batch_id,
      group_index = EXCLUDED.group_index,
      ${updateLegacyStepsSql}
      metadata_json = EXCLUDED.metadata_json,
      metrics_json = EXCLUDED.metrics_json,
      reward_components_json = EXCLUDED.reward_components_json,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at`;

  const currentSchemaUpdateSql = `UPDATE trajectories SET
      source = ${sqlQuote(trajectory.source)},
      status = ${sqlQuote(trajectory.status)},
      start_time = ${sqlNumber(summary.startTime)},
      end_time = ${sqlNumber(endTime)},
      duration_ms = ${sqlNumber(durationMs)},
      step_count = ${sqlNumber(trajectory.steps.length)},
      llm_call_count = ${sqlNumber(summary.llmCallCount)},
      provider_access_count = ${sqlNumber(summary.providerAccessCount)},
      total_prompt_tokens = ${sqlNumber(summary.totalPromptTokens)},
      total_completion_tokens = ${sqlNumber(summary.totalCompletionTokens)},
      total_cache_read_input_tokens = ${sqlNumber(summary.totalCacheReadInputTokens)},
      total_cache_creation_input_tokens = ${sqlNumber(summary.totalCacheCreationInputTokens)},
      total_reward = ${sqlNumber(trajectory.totalReward)},
      scenario_id = ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      trace_id = ${trajectory.traceId ? sqlQuote(trajectory.traceId) : "NULL"},
      episode_id = ${trajectory.episodeId ? sqlQuote(trajectory.episodeId) : "NULL"},
      batch_id = ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      group_index = ${sqlNumber(trajectory.groupIndex)},
      ${updateLegacyStepsValueSql}
      metadata_json = ${serializedMetadata},
      metrics_json = ${serializedMetrics},
      reward_components_json = ${serializedRewardComponents},
      created_at = ${sqlQuote(createdAt)},
      updated_at = ${sqlQuote(updatedAt)}`;

  // Legacy Eliza schema (metadata TEXT + episode_length) when canonical
  // JSONB columns are missing on the adapter.
  const legacySchemaInsertSql = () => `INSERT INTO trajectories (
      id,
      agent_id,
      source,
      status,
      start_time,
      end_time,
      duration_ms,
      step_count,
      llm_call_count,
      provider_access_count,
      total_prompt_tokens,
      total_completion_tokens,
      total_cache_read_input_tokens,
      total_cache_creation_input_tokens,
      total_reward,
      scenario_id,
      batch_id,
      steps_json,
      metadata,
      created_at,
      updated_at,
      episode_length
    ) VALUES (
      ${sqlQuote(trajectory.id)},
      ${sqlQuote(runtime.agentId)},
      ${sqlQuote(trajectory.source)},
      ${sqlQuote(trajectory.status)},
      ${sqlNumber(summary.startTime)},
      ${sqlNumber(endTime)},
      ${sqlNumber(durationMs)},
      ${sqlNumber(trajectory.steps.length)},
      ${sqlNumber(summary.llmCallCount)},
      ${sqlNumber(summary.providerAccessCount)},
      ${sqlNumber(summary.totalPromptTokens)},
      ${sqlNumber(summary.totalCompletionTokens)},
      ${sqlNumber(summary.totalCacheReadInputTokens)},
      ${sqlNumber(summary.totalCacheCreationInputTokens)},
      ${sqlNumber(trajectory.totalReward)},
      ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      ${serializeLegacySteps()},
      ${serializedMetadata},
      ${sqlQuote(createdAt)},
      ${sqlQuote(updatedAt)},
      ${sqlNumber(trajectory.steps.length)}
    )`;
  const legacySchemaSql = () =>
    options.createOnly
      ? `${legacySchemaInsertSql()} ON CONFLICT (id) DO NOTHING RETURNING id`
      : `${legacySchemaInsertSql()}
    ON CONFLICT (id) DO UPDATE SET
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      duration_ms = EXCLUDED.duration_ms,
      step_count = EXCLUDED.step_count,
      llm_call_count = EXCLUDED.llm_call_count,
      provider_access_count = EXCLUDED.provider_access_count,
      total_prompt_tokens = EXCLUDED.total_prompt_tokens,
      total_completion_tokens = EXCLUDED.total_completion_tokens,
      total_cache_read_input_tokens = EXCLUDED.total_cache_read_input_tokens,
      total_cache_creation_input_tokens = EXCLUDED.total_cache_creation_input_tokens,
      total_reward = EXCLUDED.total_reward,
      scenario_id = EXCLUDED.scenario_id,
      batch_id = EXCLUDED.batch_id,
      ${updateLegacyStepsSql}
      metadata = EXCLUDED.metadata,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      episode_length = EXCLUDED.episode_length`;

  const legacySchemaUpdateSql = `UPDATE trajectories SET
      source = ${sqlQuote(trajectory.source)},
      status = ${sqlQuote(trajectory.status)},
      start_time = ${sqlNumber(summary.startTime)},
      end_time = ${sqlNumber(endTime)},
      duration_ms = ${sqlNumber(durationMs)},
      step_count = ${sqlNumber(trajectory.steps.length)},
      llm_call_count = ${sqlNumber(summary.llmCallCount)},
      provider_access_count = ${sqlNumber(summary.providerAccessCount)},
      total_prompt_tokens = ${sqlNumber(summary.totalPromptTokens)},
      total_completion_tokens = ${sqlNumber(summary.totalCompletionTokens)},
      total_cache_read_input_tokens = ${sqlNumber(summary.totalCacheReadInputTokens)},
      total_cache_creation_input_tokens = ${sqlNumber(summary.totalCacheCreationInputTokens)},
      total_reward = ${sqlNumber(trajectory.totalReward)},
      scenario_id = ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      batch_id = ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      ${updateLegacyStepsValueSql}
      metadata = ${serializedMetadata},
      created_at = ${sqlQuote(createdAt)},
      updated_at = ${sqlQuote(updatedAt)},
      episode_length = ${sqlNumber(trajectory.steps.length)}`;

  try {
    await persistTrajectoryAndSteps(
      runtime,
      currentSchemaSql,
      currentSchemaUpdateSql,
      trajectory.id,
      stepsToPersist,
      replaceAllSteps,
      {
        requireActiveExisting: options.requireActiveExisting === true,
        expectedUpdatedAt: options.expectedUpdatedAt,
        createOnly: options.createOnly === true,
      },
    );
  } catch (currentSchemaError) {
    if (
      currentSchemaError instanceof ElizaError &&
      [
        "TRAJECTORY_STEPS_SAVE_FAILED",
        "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
        "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
        "TRAJECTORY_STEP_PARENT_INVALID",
        "TRAJECTORY_OWNER_CLOSED",
        "TRAJECTORY_WRITE_CONFLICT",
        "TRAJECTORY_PARENT_NOT_FOUND",
        "TRAJECTORY_START_CONFLICT",
      ].includes(currentSchemaError.code)
    ) {
      throw currentSchemaError;
    }
    // error-policy:J3 Only an explicit missing canonical column selects the
    // legacy shape; connectivity, constraints, and malformed data fail closed.
    if (!isMissingCurrentTrajectoryColumnError(currentSchemaError)) {
      // error-policy:J2 Preserve the canonical write failure for its caller.
      throw new ElizaError("Could not save trajectory", {
        code: "TRAJECTORY_SAVE_FAILED",
        cause: currentSchemaError,
        context: { trajectoryId: trajectory.id },
      });
    }
    // Agent-only deployments may still own the legacy table shape; use it only
    // when the canonical service schema explicitly lacks its columns.
    try {
      await persistTrajectoryAndSteps(
        runtime,
        legacySchemaSql,
        legacySchemaUpdateSql,
        trajectory.id,
        stepsToPersist,
        replaceAllSteps,
        {
          requireActiveExisting: options.requireActiveExisting === true,
          expectedUpdatedAt: options.expectedUpdatedAt,
          createOnly: options.createOnly === true,
        },
      );
    } catch (legacySchemaError) {
      if (
        legacySchemaError instanceof ElizaError &&
        [
          "TRAJECTORY_STEPS_SAVE_FAILED",
          "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
          "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
          "TRAJECTORY_STEP_PARENT_INVALID",
          "TRAJECTORY_OWNER_CLOSED",
          "TRAJECTORY_WRITE_CONFLICT",
          "TRAJECTORY_PARENT_NOT_FOUND",
          "TRAJECTORY_START_CONFLICT",
        ].includes(legacySchemaError.code)
      ) {
        throw legacySchemaError;
      }
      // error-policy:J2 both supported SQL shapes failed; surface both causes
      // rather than returning a false value that downstream code may ignore.
      throw new ElizaError("Could not save trajectory", {
        code: "TRAJECTORY_SAVE_FAILED",
        cause: new AggregateError([currentSchemaError, legacySchemaError]),
        context: { trajectoryId: trajectory.id },
      });
    }
  }

  return true;
}

async function persistTrajectoryAndSteps(
  runtime: IAgentRuntime,
  parentUpsertSql: () => string,
  parentUpdateSql: string,
  trajectoryId: string,
  steps: PersistedStep[],
  replaceAllSteps: boolean,
  precondition: {
    requireActiveExisting: boolean;
    expectedUpdatedAt?: string;
    createOnly: boolean;
  },
): Promise<void> {
  const requiresConditionalWrite =
    precondition.requireActiveExisting ||
    precondition.expectedUpdatedAt !== undefined;
  // Materialize the chosen statement before yielding so caller mutations while
  // awaiting the database cannot alter the validated parent snapshot.
  const parentWriteSql = requiresConditionalWrite
    ? parentUpdateSql
    : parentUpsertSql();
  await executeRawSqlTransaction(runtime, async (execute) => {
    if (!requiresConditionalWrite) {
      await assertTrajectoryAgentOwnership(
        execute,
        trajectoryId,
        runtime.agentId,
        true,
      );
      const result = await execute(parentWriteSql);
      if (
        precondition.createOnly &&
        extractRequiredRows(result, {
          operation: "create trajectory owner",
          trajectoryId,
        }).length !== 1
      ) {
        throw new ElizaError("Trajectory already has a creator", {
          code: "TRAJECTORY_START_CONFLICT",
          context: { trajectoryId },
        });
      }
    } else {
      const conflictPredicates = [
        `trajectories.id = ${sqlQuote(trajectoryId)}`,
        `trajectories.agent_id = ${sqlQuote(runtime.agentId)}`,
        ...(precondition.requireActiveExisting
          ? ["trajectories.status = 'active'"]
          : []),
        ...(precondition.expectedUpdatedAt !== undefined
          ? [
              `CAST(trajectories.updated_at AS TIMESTAMPTZ) = CAST(${sqlQuote(precondition.expectedUpdatedAt)} AS TIMESTAMPTZ)`,
            ]
          : []),
      ];
      const parentWriteResult = await execute(
        `${parentWriteSql}
         WHERE ${conflictPredicates.join(" AND ")}
         RETURNING id`,
      );
      const parentWriteRows = extractRequiredRows(parentWriteResult, {
        operation: "write trajectory parent",
        trajectoryId,
        agentId: runtime.agentId,
      });
      if (parentWriteRows.length === 0) {
        const parentResult = await execute(
          `SELECT agent_id, status, updated_at FROM trajectories
           WHERE id = ${sqlQuote(trajectoryId)}`,
        );
        const parentRows = extractRequiredRows(parentResult, {
          operation: "diagnose trajectory write conflict",
          trajectoryId,
          agentId: runtime.agentId,
        });
        const parent = asRecord(parentRows[0]);
        if (!parent) {
          throw new ElizaError("Trajectory parent is unavailable", {
            code: "TRAJECTORY_PARENT_NOT_FOUND",
            context: { trajectoryId, agentId: runtime.agentId },
          });
        }
        const owner = toOptionalText(parent.agent_id);
        if (owner !== runtime.agentId) {
          throw new ElizaError("Trajectory belongs to another agent", {
            code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
            context: {
              trajectoryId,
              existingAgentId: owner,
              runtimeAgentId: runtime.agentId,
            },
          });
        }
        if (toOptionalText(parent.status) !== "active") {
          throw new ElizaError("Trajectory owner is already terminal", {
            code: "TRAJECTORY_OWNER_CLOSED",
            context: { trajectoryId, status: toOptionalText(parent.status) },
          });
        }
        throw new ElizaError("Trajectory changed before persistence", {
          code: "TRAJECTORY_WRITE_CONFLICT",
          context: {
            trajectoryId,
            storedUpdatedAt: toOptionalText(parent.updated_at),
            expectedUpdatedAt: precondition.expectedUpdatedAt,
          },
        });
      }
    }
    try {
      // Dedicated rows are authoritative whenever any exist, so the parent
      // snapshot and the complete replacement set must become visible together.
      await replaceStepsForTrajectoryInternal(
        trajectoryId,
        steps,
        execute,
        replaceAllSteps,
      );
    } catch (error) {
      if (
        error instanceof ElizaError &&
        [
          "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
          "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
          "TRAJECTORY_STEP_PARENT_INVALID",
        ].includes(error.code)
      ) {
        throw error;
      }
      // error-policy:J2 rejecting the transaction preserves the prior parent
      // and full step set; callers receive the failing dedicated write cause.
      throw new ElizaError("Could not save trajectory steps", {
        code: "TRAJECTORY_STEPS_SAVE_FAILED",
        cause: error,
        context: { trajectoryId },
      });
    }
  });
}

async function replaceStepsForTrajectoryInternal(
  trajectoryId: string,
  steps: PersistedStep[],
  execute: RawSqlExecutor,
  replaceAllSteps: boolean,
): Promise<void> {
  if (replaceAllSteps) {
    const safeId = sqlQuote(trajectoryId);
    await execute(
      `DELETE FROM trajectory_steps WHERE trajectory_id = ${safeId}`,
    );
  }
  const orderedSteps = [...steps].sort(
    (left, right) => left.stepNumber - right.stepNumber,
  );
  for (const step of orderedSteps) {
    await assertTrajectoryStepOwnership(execute, trajectoryId, step.stepId);
    await assertTrajectoryStepParentOwnership(execute, trajectoryId, step);
    await execute(buildTrajectoryStepUpsertSql(trajectoryId, step));
  }
}

/**
 * Read orchestrator trajectory context from the runtime, if set.
 */
export function readOrchestratorTrajectoryContext(
  runtime: unknown,
): OrchestratorTrajectoryContext | undefined {
  if (!runtime || typeof runtime !== "object") return undefined;
  const ctx = (runtime as RuntimeWithOrchestratorTrajectoryContext)
    .__orchestratorTrajectoryCtx;
  if (!ctx || typeof ctx !== "object") return undefined;
  const candidate = ctx as Record<string, unknown>;
  if (
    candidate.source !== "orchestrator" ||
    typeof candidate.decisionType !== "string"
  )
    return undefined;
  return candidate as OrchestratorTrajectoryContext;
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

export function resolvePreferredTrajectoryArchiveRoot(): string {
  const explicitWorkspace = process.env.ELIZA_WORKSPACE_DIR?.trim();
  if (explicitWorkspace) return explicitWorkspace;

  const workspaceRoot = process.env.ELIZA_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) return workspaceRoot;

  return path.join(resolveStateDir(), "workspace");
}

export async function ensureArchiveDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function resolveTrajectoryArchiveDirectory(): Promise<string> {
  const preferred = path.join(
    resolvePreferredTrajectoryArchiveRoot(),
    TRAJECTORY_ARCHIVE_DIRNAME,
  );
  try {
    await ensureArchiveDirectory(preferred);
    return preferred;
  } catch {
    const fallback = path.join(
      process.env.TMPDIR || os.tmpdir(),
      "eliza",
      TRAJECTORY_ARCHIVE_DIRNAME,
    );
    await ensureArchiveDirectory(fallback);
    return fallback;
  }
}

export function toArchiveSafeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export function stringifyArchiveRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export async function writeCompressedJsonlRows(
  archivePath: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const gzipStream = createGzip({ level: 9 });
  const outStream = createWriteStream(archivePath);
  gzipStream.pipe(outStream);

  for (const row of rows) {
    if (!gzipStream.write(`${stringifyArchiveRow(row)}\n`, "utf8")) {
      await once(gzipStream, "drain");
    }
  }

  gzipStream.end();
  await once(outStream, "finish");
}

/**
 * Resolves whether DB trajectory persistence is on by default. Delegates to the
 * single core gate resolver (trajectory-gate.ts) so this DB logger and the file
 * recorder can no longer disagree (#13775): the same SOC2 O-5 precedence — hard
 * opt-out → explicit `ELIZA_TRAJECTORY_LOGGING` → legacy
 * `ELIZA_TRAJECTORY_RECORDING` alias → test off → prod opt-in → dev on — governs
 * both. The env param is retained so callers can probe a synthetic env.
 */
export function shouldEnableTrajectoryLoggingByDefault(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveTrajectoryGate(env).enabled;
}

/**
 * Coarse PII redaction applied to LLM prompts/responses before persistence
 * (SOC2 O-5). Strips email addresses, common API/OAuth tokens, ETH/BTC
 * addresses, and credit-card-shaped digit runs. Conservative — combine
 * with workspace isolation rather than treating as a sole defence.
 */
const TRAJECTORY_REDACT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9_-]{20,}/g, label: "<API_KEY>" },
  { re: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, label: "<GH_TOKEN>" },
  { re: /xox[bpars]-[A-Za-z0-9-]{10,}/g, label: "<SLACK_TOKEN>" },
  { re: /0x[a-fA-F0-9]{40}/g, label: "<ETH_ADDR>" },
  { re: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, label: "<BTC_ADDR>" },
  // Decimal geometry is source evidence; neither side of its decimal point is a PAN.
  { re: /(?<!\d\.)\b\d{13,19}\b(?!\.\d)/g, label: "<CARD>" },
];

export function redactTrajectoryText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length === 0) return value;
  let out = redactBasicEmails(value, "<EMAIL>");
  for (const { re, label } of TRAJECTORY_REDACT_PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}
