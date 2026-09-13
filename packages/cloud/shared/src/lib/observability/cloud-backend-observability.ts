// Defines cloud shared cloud backend observability behavior for backend service
// consumers: per-request and per-DB-call ring-buffer telemetry plus inference
// stream milestone events (#16079), all read back through the admin
// cloud-observability endpoint.
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../utils/logger";

const MAX_EVENTS = 1_000;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_SLOW_DB_MS = 250;
const DEFAULT_DB_BURST_COUNT = 20;

export interface CloudRequestTelemetry {
  id: string;
  traceId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  organizationId?: string | null;
  authMethod?: string | null;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  duplicateReadKeys: Array<{ key: string; count: number }>;
  slowDbCalls: CloudDbTelemetry[];
  createdAt: string;
}

export interface CloudDbTelemetry {
  requestId?: string;
  operation: "read" | "write" | "transaction";
  label: string;
  durationMs: number;
  duplicateReadCount?: number;
  createdAt: string;
}

/**
 * One inference stream's milestone boundaries (#16079), correlated by the
 * shared trace id. All `*Ms` values are elapsed from the provider fetch
 * start; `null` means that boundary was never observed. Deliberately
 * privacy-bounded: model, path kind, provider request id echo, and timings
 * only — no prompts, outputs, token counts, or client identifiers.
 */
export interface CloudStreamMilestoneTelemetry {
  traceId: string;
  requestId?: string;
  /** Gateway routing path that produced the stream (`passthrough` today). */
  path: string;
  model: string;
  /** Bounded echo of the provider's own request id header, when present. */
  providerRequestId?: string;
  /** Upstream fetch start → upstream response headers, from the Worker. */
  upstreamHeadersMs?: number;
  firstEventMs: number | null;
  firstReasoningMs: number | null;
  firstContentMs: number | null;
  completionMs: number | null;
  /**
   * Stream ended via client abort, read failure, or an in-stream provider
   * error frame — observed during the stream or its teardown. NOT mutually
   * exclusive with `completionMs`: a provider that emitted `[DONE]` before a
   * client disconnect completed, and both facts are recorded (#16079).
   */
  aborted: boolean;
  createdAt: string;
}

export interface CloudTelemetrySnapshot {
  generatedAt: string;
  thresholds: {
    slowRequestMs: number;
    slowDbMs: number;
    dbBurstCount: number;
  };
  requests: CloudRequestTelemetry[];
  slowRequests: CloudRequestTelemetry[];
  db: CloudDbTelemetry[];
  slowDb: CloudDbTelemetry[];
  burstyRequests: CloudRequestTelemetry[];
  duplicateReadRequests: CloudRequestTelemetry[];
  /** Inference stream milestones (#16079), newest first. */
  streamMilestones: CloudStreamMilestoneTelemetry[];
}

interface RequestContext {
  id: string;
  traceId?: string;
  method: string;
  path: string;
  startedAt: number;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  readKeys: Map<string, number>;
  slowDbCalls: CloudDbTelemetry[];
}

const requestAls = new AsyncLocalStorage<RequestContext>();
const requests: CloudRequestTelemetry[] = [];
const dbEvents: CloudDbTelemetry[] = [];
const streamMilestones: CloudStreamMilestoneTelemetry[] = [];

function numberEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  // `Number.parseInt` stops at the first non-digit, so "500junk" parsed to a
  // positive 500 and was accepted as a deliberate threshold. The snapshot
  // publishes the threshold it used, so a typo made the report describe — and
  // classify against — a boundary nobody configured.
  const trimmed = raw?.trim();
  // The optional leading plus is kept deliberately: `Number.parseInt` accepted
  // "+500", so rejecting it here would be a compatibility regression rather
  // than a fix.
  const parsed = trimmed && /^\+?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function thresholds() {
  return {
    slowRequestMs: numberEnv("CLOUD_SLOW_REQUEST_MS", DEFAULT_SLOW_REQUEST_MS),
    slowDbMs: numberEnv("CLOUD_SLOW_DB_MS", DEFAULT_SLOW_DB_MS),
    dbBurstCount: numberEnv("CLOUD_DB_BURST_COUNT", DEFAULT_DB_BURST_COUNT),
  };
}

function pushBounded<T>(list: T[], value: T): void {
  list.unshift(value);
  if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function readKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, 500) || "unlabeled-read";
}

/** Log slow inference dependencies in the same invocation as its auth trace. */
export async function observeInferenceDependency<T>(
  dependency: "policy_lock" | "policy_read" | "transaction" | "durable_object",
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const context = requestAls.getStore();
  if (
    !context?.traceId ||
    !["/api/v1/embeddings", "/api/v1/chat/completions"].includes(context.path)
  ) {
    return fn();
  }
  const startedAt = performance.now();
  let outcome: "returned" | "threw" = "threw";
  try {
    const result = await fn();
    outcome = "returned";
    return result;
  } finally {
    const durationMs = elapsedMs(startedAt);
    if (durationMs >= DEFAULT_SLOW_DB_MS) {
      // Operations are static caller labels, never SQL, credentials, prompts,
      // responses, or error messages. Nested spans overlap; do not add them.
      try {
        logger.audit("[InferenceAdmission] dependency timing", {
          traceId: context.traceId,
          dependency,
          operation,
          durationMs,
          outcome,
        });
      } catch {
        // error-policy:J6 diagnostic sink failure must not replace the exact
        // admission result or error, nor cause a successful charge to retry.
      }
    }
  }
}

export async function observeCloudRequest<T>(
  input: { id: string; traceId?: string; method: string; path: string },
  fn: () => Promise<{
    result: T;
    status: number;
    userId?: string | null;
    organizationId?: string | null;
    authMethod?: string | null;
  }>,
): Promise<T> {
  const context: RequestContext = {
    ...input,
    startedAt: performance.now(),
    dbCalls: 0,
    dbReadCalls: 0,
    dbWriteCalls: 0,
    duplicateDbReadCalls: 0,
    readKeys: new Map(),
    slowDbCalls: [],
  };

  return requestAls.run(context, async () => {
    let response:
      | {
          result: T;
          status: number;
          userId?: string | null;
          organizationId?: string | null;
          authMethod?: string | null;
        }
      | undefined;

    try {
      response = await fn();
      return response.result;
    } finally {
      const duplicateReadKeys = [...context.readKeys]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      pushBounded(requests, {
        id: input.id,
        traceId: input.traceId,
        method: input.method,
        path: input.path,
        status: response?.status ?? 500,
        durationMs: elapsedMs(context.startedAt),
        userId: response?.userId,
        organizationId: response?.organizationId,
        authMethod: response?.authMethod,
        dbCalls: context.dbCalls,
        dbReadCalls: context.dbReadCalls,
        dbWriteCalls: context.dbWriteCalls,
        duplicateDbReadCalls: context.duplicateDbReadCalls,
        duplicateReadKeys,
        slowDbCalls: context.slowDbCalls.slice(0, 20),
        createdAt: nowIso(),
      });
    }
  });
}

export async function observeDbOperation<T>(
  operation: CloudDbTelemetry["operation"],
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const context = requestAls.getStore();
  let duplicateReadCount: number | undefined;

  if (context) {
    context.dbCalls += 1;
    if (operation === "read") {
      context.dbReadCalls += 1;
      const key = readKey(label);
      const count = (context.readKeys.get(key) ?? 0) + 1;
      context.readKeys.set(key, count);
      if (count > 1) {
        duplicateReadCount = count;
        context.duplicateDbReadCalls += 1;
      }
    } else {
      context.dbWriteCalls += 1;
    }
  }

  try {
    return await fn();
  } finally {
    const event: CloudDbTelemetry = {
      requestId: context?.id,
      operation,
      label: readKey(label),
      durationMs: elapsedMs(startedAt),
      duplicateReadCount,
      createdAt: nowIso(),
    };
    pushBounded(dbEvents, event);
    if (event.durationMs >= thresholds().slowDbMs && context) {
      context.slowDbCalls.push(event);
    }
  }
}

export function getCloudTelemetrySnapshot(limit = 200): CloudTelemetrySnapshot {
  const t = thresholds();
  const req = requests.slice(0, limit);
  const db = dbEvents.slice(0, limit);
  return {
    generatedAt: nowIso(),
    thresholds: t,
    requests: req,
    slowRequests: req.filter((r) => r.durationMs >= t.slowRequestMs),
    db,
    slowDb: db.filter((r) => r.durationMs >= t.slowDbMs),
    burstyRequests: req.filter((r) => r.dbCalls >= t.dbBurstCount),
    duplicateReadRequests: req.filter((r) => r.duplicateDbReadCalls > 0),
    streamMilestones: streamMilestones.slice(0, limit),
  };
}

/**
 * Record one inference stream's milestone boundaries (#16079). Called from the
 * gateway's off-response-path meter, so it must stay synchronous and cheap:
 * the event is bounded, pre-shaped by the caller, and pushed to the same
 * isolate ring buffer as request/db telemetry, where the admin
 * cloud-observability endpoint reads it back.
 */
export function recordCloudStreamMilestones(event: CloudStreamMilestoneTelemetry): void {
  pushBounded(streamMilestones, event);
}

export function clearCloudTelemetry(): void {
  requests.length = 0;
  dbEvents.length = 0;
  streamMilestones.length = 0;
}
