/**
 * Inference hot-path auth resolver (#9899).
 *
 * `resolveInferenceAuthContext(req)` collapses the pre-forward auth + org +
 * moderation chain into one cache decision for API-key and Steward-session
 * inference. A cold Worker request consumes its coalesced authoritative
 * continuation under a bounded deadline while retaining it under `waitUntil`;
 * timeout or dependency failure stays an explicit retryable warming result.
 *
 * API keys are keyed by their full hash and Steward sessions by a hash of the
 * verified subject. The cache-backed mode is independently default-off:
 * lifecycle invalidation of an eventually consistent cache is not a strong
 * revocation boundary. Wallet signatures remain on the general non-Worker path
 * because their timestamped proof cannot be replayed as asynchronous cache
 * hydration. Mobile lifecycle credentials always take the authoritative path
 * because their revocation invariants are stricter than this cache's fixed TTL.
 *
 * Safety invariants:
 *   - A positive IAC entry is written ONLY for a fully-authorized credential.
 *   - Auth failures (invalid/inactive/no-org) throw from the authoritative chain
 *     and propagate unchanged -> the route maps them to the exact 401/403.
 *   - A Worker cache failure returns an explicit unavailable/warming result.
 *     Only an actual combined-cache miss may join the already-retained origin
 *     continuation, and it never performs a second cache read.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { getErrorStatusCode } from "../api/errors";
import { type CacheBackendKind, cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { apiKeysService, isMobileApiKeySecret } from "./api-keys";
import { loadInferenceAdmissionSnapshot } from "./inference-admission-snapshot";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";
import { loadInferenceAppKeyScope } from "./inference-app-key-scope";
import type { InferenceAuthRejectionReason } from "./inference-auth-cache";
import {
  hashApiKey,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAuthContext,
  type ResolvedInferenceAuthContext,
  readInferenceAuthContextWithOutcome,
  writeInferenceApiKeyAuthRejection,
  writeInferenceAuthContext,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
  InferenceCredentialRevocationUnavailableError,
  InferenceCredentialRevokedError,
  inferenceCredentialRevocationReason,
  isInferenceStrongRevocationEnabled,
} from "./inference-credential-revocation";
import { isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";
import { resolveInferenceSessionAuthContext } from "./inference-session-auth-context";

export type {
  InferenceAuthContext,
  InferenceSessionAuthContext,
  ResolvedInferenceAuthContext,
} from "./inference-auth-cache";

export const INFERENCE_AUTH_PROBE_HEADER = "X-Eliza-Auth-Probe";

export type InferenceAuthCredentialSource =
  | "x_api_key"
  | "bearer_api_key"
  | "steward_session"
  | "other";
export type InferenceAuthCacheRead =
  | "not_run"
  | "hit"
  | "rejected"
  | "miss"
  | "invalid"
  | "unavailable"
  | "error";
export type InferenceAuthAuthoritativeResult =
  | "not_run"
  | "authorized"
  | "suspended"
  | "rejected"
  | "error";
export type InferenceAuthCacheWrite =
  | "not_run"
  | "deferred"
  | "written"
  | "invalid"
  | "unavailable"
  | "error";
export type InferenceAuthResult =
  | "authorized_cache"
  | "authorized_origin"
  | "warming"
  | "suspended"
  | "slow_path"
  | "rejected"
  | "error";

export interface InferenceAuthTimings {
  readonly extractMs: number;
  readonly cacheAvailabilityMs: number | null;
  readonly cacheReadMs: number | null;
  readonly keyLookupMs: number | null;
  readonly userOrgLookupMs: number | null;
  readonly moderationMs: number | null;
  readonly cacheWriteMs: number | null;
  readonly totalMs: number;
}

/** A privacy-bounded snapshot shared by structured logs and response telemetry. */
export interface InferenceAuthTelemetry {
  readonly v: 1;
  readonly traceId: string;
  readonly authSource: InferenceAuthCredentialSource;
  readonly controlledProbe: "on" | "off";
  readonly cacheAvailability: "not_checked" | "available" | "unavailable";
  readonly cacheBackend: CacheBackendKind;
  readonly cacheRead: InferenceAuthCacheRead;
  readonly authoritative: InferenceAuthAuthoritativeResult;
  readonly cacheWrite: InferenceAuthCacheWrite;
  readonly result: InferenceAuthResult;
  readonly timings: InferenceAuthTimings;
}

/** Completion record for a positive cache population deferred off the request path. */
export interface InferenceAuthCacheWriteTelemetry {
  readonly v: 1;
  readonly kind: "cache_write";
  readonly traceId: string;
  readonly cacheBackend: CacheBackendKind;
  readonly cacheWrite: Exclude<InferenceAuthCacheWrite, "not_run" | "deferred">;
  readonly durationMs: number;
}

export interface ResolveInferenceAuthOptions {
  traceId?: string;
  onTelemetry?(telemetry: InferenceAuthTelemetry): void;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  onCacheWriteTelemetry?(telemetry: InferenceAuthCacheWriteTelemetry): void;
  /** Use the combined cache and its bounded one-shot miss continuation. */
  cacheOnly?: boolean;
  /** Internal background refresh: bypass the combined decision and revalidate. */
  forceAuthoritative?: boolean;
  /** Internal hook preserving a bounded authoritative standing reason. */
  onAuthoritativeRejection?(reason: InferenceAuthRejectionReason): void;
  /** The caller will fuse this strong check into its atomic admission lease. */
  deferStrongCredentialCheck?: boolean;
  /** Override the Worker miss deadline; zero retains an immediate warming result. */
  inlineContinuationDeadlineMs?: number;
}

interface MutableInferenceAuthTrace {
  authSource: InferenceAuthCredentialSource;
  controlledProbe: "on" | "off";
  cacheAvailability: "not_checked" | "available" | "unavailable";
  cacheBackend: CacheBackendKind;
  cacheRead: InferenceAuthCacheRead;
  authoritative: InferenceAuthAuthoritativeResult;
  cacheWrite: InferenceAuthCacheWrite;
  result: InferenceAuthResult;
  timings: {
    extractMs: number;
    cacheAvailabilityMs: number | null;
    cacheReadMs: number | null;
    keyLookupMs: number | null;
    userOrgLookupMs: number | null;
    moderationMs: number | null;
    cacheWriteMs: number | null;
  };
}

type InferenceStandingDecisionSource = "authoritative" | "cache" | "session_resolution";

interface ApiKeyHydration {
  readonly decision: Promise<InferenceAuthResolution | undefined>;
  readonly projection: Promise<void>;
  authoritativeTelemetry(): InferenceAuthTelemetry;
  projectionTelemetry(): InferenceAuthCacheWriteTelemetry | undefined;
}

const apiKeyHydrations = new Map<string, ApiKeyHydration>();
const SKIP_CACHE_PROJECTION_WRITE = Symbol("skip-cache-projection-write");
// A cold request owns the canonical denial log after consuming its nested
// authoritative continuation; hydration diagnostics have a distinct log scope.
const SUPPRESS_STANDING_DENIAL_LOG = Symbol("suppress-standing-denial-log");
const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;
const DEFAULT_HYDRATION_DEADLINE_MS = 10_000;
const DEFAULT_INLINE_CONTINUATION_DEADLINE_MS = 2_500;
const MAX_HYDRATION_DEADLINE_MS = 2_147_483_647;

const OPAQUE_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function boundedTraceId(traceId: string | undefined): string {
  const value = traceId?.trim();
  return value && OPAQUE_TRACE_ID.test(value) ? value.toLowerCase() : "unavailable";
}

function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function controlledProbeDiscriminator(req: Request): string | null {
  const expected = getCloudAwareEnv().INFERENCE_AUTH_PROBE_TOKEN;
  const supplied = req.headers.get(INFERENCE_AUTH_PROBE_HEADER);
  if (!expected || !supplied) return null;
  if (supplied.length > 512) return null;
  const separator = supplied.lastIndexOf(":");
  if (separator <= 0) return null;
  const token = supplied.slice(0, separator);
  const nonce = supplied.slice(separator + 1);
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(token).digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) return null;
  return createHash("sha256").update(nonce).digest("hex");
}

function freezeTrace(
  traceId: string | undefined,
  trace: MutableInferenceAuthTrace,
  totalStartedAt: number,
): InferenceAuthTelemetry {
  return Object.freeze({
    v: 1 as const,
    traceId: boundedTraceId(traceId),
    authSource: trace.authSource,
    controlledProbe: trace.controlledProbe,
    cacheAvailability: trace.cacheAvailability,
    cacheBackend: trace.cacheBackend,
    cacheRead: trace.cacheRead,
    authoritative: trace.authoritative,
    cacheWrite: trace.cacheWrite,
    result: trace.result,
    timings: Object.freeze({
      ...trace.timings,
      totalMs: durationSince(totalStartedAt),
    }),
  });
}

function freezeCacheWriteTrace(
  traceId: string | undefined,
  write: Awaited<ReturnType<typeof writeInferenceAuthContext>>,
  startedAt: number,
): InferenceAuthCacheWriteTelemetry {
  return Object.freeze({
    v: 1 as const,
    kind: "cache_write" as const,
    traceId: boundedTraceId(traceId),
    cacheBackend: write.backend,
    cacheWrite: write.kind,
    durationMs: durationSince(startedAt),
  });
}

/**
 * Discriminated resolution outcome.
 *   - `authorized`: proceed; the route uses ctx and SKIPS auth + moderation.
 *   - `suspended`: the route returns the 403 account-suspended response.
 *   - `slow_path`: the route runs the general auth chain for non-API-key credentials.
 */
export type InferenceAuthResolution =
  | {
      kind: "authorized";
      ctx: ResolvedInferenceAuthContext;
      source: "cache" | "origin";
      credential?: InferenceCredentialCheck;
    }
  | { kind: "suspended"; userId?: string; reason?: InferenceAuthRejectionReason }
  | { kind: "rejected"; status: 401 | 403; reason?: InferenceAuthRejectionReason }
  | {
      kind: "warming";
      hydration?: Promise<unknown>;
      /** One-shot cold-auth result for bounded request use without a second cache read. */
      continuation?: Promise<InferenceAuthResolution | undefined>;
    }
  | { kind: "slow_path"; reason: "mobile_api_key" | "non_api_key" };

/**
 * Extract a cacheable API-key credential from the request, mirroring the
 * precedence of `requireAuthOrApiKey`. Returns null when the request is not
 * eligible for the fast path (wallet headers present, or no API key).
 */
function extractApiKeyCredentialWithSource(
  req: Request,
): { rawKey: string; source: Exclude<InferenceAuthCredentialSource, "other"> } | null {
  // Wallet auth is fail-closed and replay-protected - never cache it.
  if (
    req.headers.get("X-Wallet-Address") &&
    req.headers.get("X-Wallet-Signature") &&
    req.headers.get("X-Timestamp")
  ) {
    return null;
  }

  const xApiKey = req.headers.get("X-API-Key");
  if (xApiKey && xApiKey.trim().length > 0) {
    return { rawKey: xApiKey.trim(), source: "x_api_key" };
  }

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    // Only `eliza_*` bearer tokens are API keys (matches requireAuthOrApiKey).
    if (token.startsWith("eliza_")) return { rawKey: token, source: "bearer_api_key" };
  }

  return null;
}

export function extractApiKeyCredential(req: Request): string | null {
  return extractApiKeyCredentialWithSource(req)?.rawKey ?? null;
}

/**
 * Wall-clock bound on one background hydration attempt. A hung authoritative
 * resolve (stalled Postgres, dead moderation dependency) must not pin the
 * single-flight slot for the Worker isolate's lifetime — that turned a cold
 * cache into a permanent 503 loop (live incident 2026-08-10: "warming"
 * returned unchanged for minutes because the coalesced hydration never
 * settled). On deadline the slot clears so the next request starts a fresh
 * attempt, and the miss counts toward the authoritative-escape threshold.
 */
export function resolveInferenceAuthHydrationDeadlineMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HYDRATION_DEADLINE_MS;
  }
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw invalidHydrationDeadline(raw);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HYDRATION_DEADLINE_MS) {
    throw invalidHydrationDeadline(raw);
  }
  return parsed;
}

function invalidHydrationDeadline(configured: string): ElizaError {
  return new ElizaError(
    `INFERENCE_AUTH_HYDRATION_DEADLINE_MS must be an integer from 1 through ${MAX_HYDRATION_DEADLINE_MS} milliseconds`,
    {
      code: "INVALID_INFERENCE_AUTH_HYDRATION_DEADLINE",
      context: { envKey: "INFERENCE_AUTH_HYDRATION_DEADLINE_MS", configured },
      severity: "fatal",
    },
  );
}

const HYDRATION_DEADLINE_MS = resolveInferenceAuthHydrationDeadlineMs(
  process.env.INFERENCE_AUTH_HYDRATION_DEADLINE_MS,
);

/**
 * After this many consecutive failed or timed-out hydrations for one key,
 * the cacheOnly warming shortcut is bypassed and the request resolves
 * authoritatively inline: slower, but definitive — and the successful inline
 * resolve writes the cache, self-healing the loop. "Retry shortly" must never
 * be a lie the caller can't escape.
 */
const HYDRATION_FAILURE_ESCAPE_THRESHOLD = 3;

const apiKeyHydrationFailures = new Map<string, number>();

function noteHydrationFailure(keyHash: string): void {
  apiKeyHydrationFailures.set(keyHash, (apiKeyHydrationFailures.get(keyHash) ?? 0) + 1);
}

function hydrationEscapeActive(keyHash: string): boolean {
  return (apiKeyHydrationFailures.get(keyHash) ?? 0) >= HYDRATION_FAILURE_ESCAPE_THRESHOLD;
}

function getOrCreateApiKeyHydration(
  req: Request,
  keyHash: string,
  options: ResolveInferenceAuthOptions & {
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
): ApiKeyHydration {
  const existing = apiKeyHydrations.get(keyHash);
  if (existing) {
    options.executionCtx.waitUntil(existing.projection);
    return existing;
  }

  let authoritativeRejectionReason: InferenceAuthRejectionReason | undefined;
  let authoritativeTelemetry: InferenceAuthTelemetry | undefined;
  let projectionTelemetry: InferenceAuthCacheWriteTelemetry | undefined;

  // The authoritative decision and its cache projection are separate promises.
  // A request may consume the decision immediately and carry its credential to
  // the atomic admission lease, while refresh-only callers retain the
  // projection barrier, including its standalone strong credential check.
  const hydrationOptions: ResolveInferenceAuthOptions & {
    [SKIP_CACHE_PROJECTION_WRITE]: true;
    [SUPPRESS_STANDING_DENIAL_LOG]: true;
  } = {
    traceId: options.traceId,
    cacheOnly: false,
    forceAuthoritative: true,
    deferStrongCredentialCheck: true,
    [SKIP_CACHE_PROJECTION_WRITE]: true,
    [SUPPRESS_STANDING_DENIAL_LOG]: true,
    onTelemetry: (telemetry) => {
      authoritativeTelemetry = telemetry;
    },
    onAuthoritativeRejection: (reason) => {
      authoritativeRejectionReason = reason;
    },
  };
  const attempt = resolveInferenceAuthContext(req, hydrationOptions)
    .then((result): InferenceAuthResolution => {
      apiKeyHydrationFailures.delete(keyHash);
      return result;
    })
    .catch((error): InferenceAuthResolution | undefined => {
      const status = getErrorStatusCode(error);
      if (status === 401 || status === 403) {
        const reason = authoritativeRejectionReason ?? "credential_invalid";
        // A definitive rejection is a successful decision. The projection
        // barrier below owns its negative cache write.
        apiKeyHydrationFailures.delete(keyHash);
        return { kind: "rejected", status, reason };
      } else {
        noteHydrationFailure(keyHash);
      }
      // error-policy:J7 the current request already returned an explicit
      // warming state; preserve the failure in logs and allow a later retry.
      logger.warn("[InferenceAuth] background hydration failed", {
        traceId: boundedTraceId(options.traceId),
        failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return undefined;
    });
  // Deadline: a never-settling attempt must not hold the single-flight slot.
  // The timed-out promise resolves (never rejects), counts as a failure, and
  // frees the slot for a fresh attempt on the next request.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const decision = Promise.race([
    attempt,
    new Promise<undefined>((resolve) => {
      deadline = setTimeout(() => {
        noteHydrationFailure(keyHash);
        logger.warn("[InferenceAuth] background hydration exceeded deadline", {
          traceId: boundedTraceId(options.traceId),
          deadlineMs: HYDRATION_DEADLINE_MS,
          failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
        });
        resolve(undefined);
      }, HYDRATION_DEADLINE_MS);
      if (typeof deadline.unref === "function") deadline.unref();
    }),
  ]);

  const projection = decision
    .then(async (result) => {
      if (!result) return;
      if (result.kind === "authorized" && "keyHash" in result.ctx) {
        const credential: InferenceCredentialCheck = {
          kind: "api_key",
          credentialId: result.ctx.apiKeyId,
          userId: result.ctx.userId,
        };
        try {
          await assertInferenceCredentialActive(result.ctx.orgId, credential);
        } catch (error) {
          if (!(error instanceof InferenceCredentialRevocationUnavailableError)) throw error;
          // error-policy:J2 background projection may retry one unavailable
          // read with a fresh stub. A cold object can outlive the short check
          // deadline; abandoning the projection leaves every later request
          // paying origin auth again. Neither attempt authorizes inference,
          // extends cache freshness, nor retries an explicit revocation.
          logger.info("[InferenceAuth] retrying background credential projection", {
            traceId: boundedTraceId(options.traceId),
          });
          await assertInferenceCredentialActive(result.ctx.orgId, credential);
        }
        const startedAt = performance.now();
        const write = await writeInferenceAuthContext(result.ctx);
        const telemetry = freezeCacheWriteTrace(options.traceId, write, startedAt);
        projectionTelemetry = telemetry;
        logger.info("[InferenceAuth] hydration cache write", telemetry);
        if (write.kind !== "written") {
          logger.warn("[InferenceAuth] positive decision cache write failed", {
            traceId: boundedTraceId(options.traceId),
            cacheWrite: write.kind,
          });
        }
        return;
      }
      if (result.kind !== "suspended" && result.kind !== "rejected") return;
      const status = result.kind === "suspended" ? 403 : result.status;
      const decision = result.kind === "suspended" ? "suspended" : "rejected";
      const reason =
        result.reason ??
        (result.kind === "suspended" ? "moderation_blocked" : "credential_invalid");
      const write = await writeInferenceApiKeyAuthRejection(keyHash, decision, status, reason);
      if (write.kind !== "written") {
        logger.warn("[InferenceAuth] negative decision cache write failed", {
          traceId: boundedTraceId(options.traceId),
          status,
          cacheWrite: write.kind,
        });
      }
    })
    .catch((error) => {
      // error-policy:J7 the authoritative decision is independently observed;
      // a failed projection remains fail-closed and must not reject waitUntil.
      logger.warn("[InferenceAuth] deferred cache projection failed", {
        traceId: boundedTraceId(options.traceId),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });

  const hydration: ApiKeyHydration = {
    decision,
    projection,
    authoritativeTelemetry: () => {
      if (!authoritativeTelemetry) {
        throw new ElizaError("Authoritative hydration completed without telemetry", {
          code: "INFERENCE_AUTH_HYDRATION_TELEMETRY_MISSING",
          context: { traceId: boundedTraceId(options.traceId) },
        });
      }
      return authoritativeTelemetry;
    },
    projectionTelemetry: () => projectionTelemetry,
  };
  apiKeyHydrations.set(keyHash, hydration);
  options.executionCtx.waitUntil(projection);
  const clearDeadline = () => {
    if (deadline !== undefined) clearTimeout(deadline);
  };
  decision.then(clearDeadline, clearDeadline);
  const clearProjection = () => {
    if (apiKeyHydrations.get(keyHash) === hydration) {
      apiKeyHydrations.delete(keyHash);
    }
  };
  projection.then(clearProjection, clearProjection);
  return hydration;
}

/** Correlate one shared projection to each request that consumed its decision. */
function observeHydrationProjection(
  hydration: ApiKeyHydration,
  options: ResolveInferenceAuthOptions & {
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
  canonical: boolean,
): void {
  const observed = hydration.projection
    .then(() => {
      const completed = hydration.projectionTelemetry();
      // Projection failures are already reported by the hydration boundary.
      if (!completed) return;
      const telemetry = Object.freeze({ ...completed, traceId: boundedTraceId(options.traceId) });
      if (canonical) logger.audit("[InferenceAuth] trace", telemetry);
      options.onCacheWriteTelemetry?.(telemetry);
    })
    .catch((error) => {
      // error-policy:J7 diagnostic callbacks must not reject the observed projection.
      logger.warn("[InferenceAuth] deferred projection telemetry failed", {
        traceId: boundedTraceId(options.traceId),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  options.executionCtx.waitUntil(observed);
}

async function consumeInlineAuthContinuation(
  continuation: Promise<InferenceAuthResolution | undefined>,
  options: Pick<
    ResolveInferenceAuthOptions,
    "executionCtx" | "inlineContinuationDeadlineMs" | "traceId"
  >,
  authSource: InferenceAuthCredentialSource,
): Promise<InferenceAuthResolution | undefined> {
  const deadlineMs =
    options.inlineContinuationDeadlineMs ?? DEFAULT_INLINE_CONTINUATION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !options.executionCtx) {
    return undefined;
  }

  const startedAt = performance.now();
  const failed = Symbol("inference-auth-inline-continuation-failed");
  const timedOut = Symbol("inference-auth-inline-continuation-timeout");
  const operation = continuation;
  const observed = operation.then(
    () => undefined,
    () => undefined,
  );
  options.executionCtx.waitUntil(observed);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      operation.then(
        (resolution) => ({ resolution }),
        (error) => ({ error, failed }),
      ),
      new Promise<{ timedOut: typeof timedOut }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ timedOut }), Math.floor(deadlineMs));
        if (typeof timeoutId.unref === "function") timeoutId.unref();
      }),
    ]);

    if ("timedOut" in outcome) {
      logger.warn("[InferenceAuth] inline continuation exceeded deadline", {
        traceId: boundedTraceId(options.traceId),
        authSource,
        deadlineMs: Math.floor(deadlineMs),
        durationMs: durationSince(startedAt),
      });
      return undefined;
    }
    if ("failed" in outcome) {
      logger.warn("[InferenceAuth] inline continuation failed", {
        traceId: boundedTraceId(options.traceId),
        authSource,
        deadlineMs: Math.floor(deadlineMs),
        durationMs: durationSince(startedAt),
        errorName: outcome.error instanceof Error ? outcome.error.name : "UnknownError",
      });
      return undefined;
    }
    if (!outcome.resolution) {
      logger.warn("[InferenceAuth] inline continuation was unavailable", {
        traceId: boundedTraceId(options.traceId),
        authSource,
        deadlineMs: Math.floor(deadlineMs),
        durationMs: durationSince(startedAt),
      });
      return undefined;
    }
    logger.info("[InferenceAuth] inline continuation completed", {
      traceId: boundedTraceId(options.traceId),
      authSource,
      result: outcome.resolution.kind,
      deadlineMs: Math.floor(deadlineMs),
      durationMs: durationSince(startedAt),
    });
    return outcome.resolution;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Test hook: reset the hydration-failure escape counters. */
export function __clearInferenceApiKeyHydrationFailures(): void {
  apiKeyHydrationFailures.clear();
}

/** Test hook for isolating coalesced API-key hydration state. */
export function __clearInferenceApiKeyHydrations(): void {
  apiKeyHydrations.clear();
}

/** Retain accepted API-key usage telemetry when a cold-auth continuation is consumed. */
export function observeInferenceApiKeyUsage(
  resolution: InferenceAuthResolution,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
): void {
  if (resolution.kind !== "authorized" || resolution.ctx.apiKeyId === null) return;
  const usageUpdate = apiKeysService
    .incrementUsageDebounced(resolution.ctx.apiKeyId)
    .catch((error) => {
      // error-policy:J7 usage telemetry must not add latency or reject an
      // otherwise authorized inference continuation.
      logger.warn("[InferenceAuth] API-key usage update failed", {
        apiKeyId: resolution.ctx.apiKeyId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  if (executionCtx) {
    executionCtx.waitUntil(usageUpdate);
  } else {
    void usageUpdate;
  }
}

export async function resolveInferenceAuthContext(
  req: Request,
  options: ResolveInferenceAuthOptions = {},
): Promise<InferenceAuthResolution> {
  const totalStartedAt = performance.now();
  const trace: MutableInferenceAuthTrace = {
    authSource: "other",
    controlledProbe: "off",
    cacheAvailability: "not_checked",
    cacheBackend: "none",
    cacheRead: "not_run",
    authoritative: "not_run",
    cacheWrite: "not_run",
    result: "slow_path",
    timings: {
      extractMs: 0,
      cacheAvailabilityMs: null,
      cacheReadMs: null,
      keyLookupMs: null,
      userOrgLookupMs: null,
      moderationMs: null,
      cacheWriteMs: null,
    },
  };
  let standingDenialLogged = false;
  let authoritativeStandingReason: InferenceAuthRejectionReason | undefined;
  const logStandingDenial = (params: {
    status: 401 | 403;
    reason: unknown;
    source: InferenceStandingDecisionSource;
  }): void => {
    standingDenialLogged = true;
    if (
      (
        options as ResolveInferenceAuthOptions & {
          [SUPPRESS_STANDING_DENIAL_LOG]?: true;
        }
      )[SUPPRESS_STANDING_DENIAL_LOG]
    ) {
      return;
    }
    const reason =
      typeof params.reason === "string" && /^[a-z0-9_:-]{1,64}$/.test(params.reason)
        ? params.reason
        : "unavailable";
    logger.error("[InferenceAuth] account standing denied inference", {
      traceId: boundedTraceId(options.traceId),
      status: params.status,
      reason,
      authSource: trace.authSource,
      cacheBackend: trace.cacheBackend,
      cacheRead: trace.cacheRead,
      source: params.source,
    });
  };

  try {
    const authCacheEnabled = isInferenceAuthCacheEnabled();
    const deferStrongCredentialCheck =
      authCacheEnabled &&
      options.deferStrongCredentialCheck === true &&
      isInferenceStrongRevocationEnabled();
    const extractStartedAt = performance.now();
    const credential = extractApiKeyCredentialWithSource(req);
    trace.timings.extractMs = durationSince(extractStartedAt);
    if (!credential) {
      const session = await resolveInferenceSessionAuthContext(req, {
        cacheOnly: authCacheEnabled && options.cacheOnly,
        useAuthCache: authCacheEnabled,
        executionCtx: options.executionCtx,
        deferStrongCredentialCheck,
      });
      if (session.kind === "not_session") {
        return { kind: "slow_path", reason: "non_api_key" };
      }

      trace.authSource = "steward_session";
      trace.cacheAvailability = cache.isAvailable() ? "available" : "unavailable";
      trace.cacheBackend = cache.getBackendKind();
      if (session.kind === "authorized") {
        trace.cacheRead = session.source === "cache" ? "hit" : "miss";
        trace.authoritative = session.source === "origin" ? "authorized" : "not_run";
        trace.result = session.source === "cache" ? "authorized_cache" : "authorized_origin";
        return session;
      }
      if (session.kind === "warming") {
        trace.cacheRead = cache.isAvailable() ? "miss" : "unavailable";
        trace.result = "warming";
        if (session.continuation) {
          const continued = await consumeInlineAuthContinuation(
            session.continuation,
            options,
            trace.authSource,
          );
          if (continued?.kind === "authorized") {
            trace.authoritative = "authorized";
            trace.result = "authorized_origin";
            return continued;
          }
          if (continued?.kind === "suspended") {
            trace.authoritative = "suspended";
            trace.result = "suspended";
            logStandingDenial({
              status: 403,
              reason: continued.reason,
              source: "session_resolution",
            });
            return continued;
          }
          if (continued?.kind === "rejected") {
            trace.authoritative = "rejected";
            trace.result = "rejected";
            logStandingDenial({
              status: continued.status,
              reason: continued.reason,
              source: "session_resolution",
            });
            return continued;
          }
        }
        return session;
      }
      if (session.kind === "suspended") {
        trace.cacheRead = "hit";
        trace.result = "suspended";
        logStandingDenial({
          status: 403,
          reason: session.reason,
          source: "session_resolution",
        });
        return session;
      }
      trace.cacheRead = "hit";
      trace.result = "rejected";
      logStandingDenial({
        status: session.status,
        reason: session.reason,
        source: "session_resolution",
      });
      return session;
    }
    trace.authSource = credential.source;
    if (isMobileApiKeySecret(credential.rawKey)) {
      return { kind: "slow_path", reason: "mobile_api_key" };
    }
    trace.result = "error";
    const probeDiscriminator = controlledProbeDiscriminator(req);
    trace.controlledProbe = probeDiscriminator ? "on" : "off";

    const availabilityStartedAt = performance.now();
    const cacheAvailable = cache.isAvailable();
    trace.timings.cacheAvailabilityMs = durationSince(availabilityStartedAt);
    trace.cacheAvailability = cacheAvailable ? "available" : "unavailable";
    trace.cacheBackend = cache.getBackendKind();

    const keyHash = hashApiKey(credential.rawKey);
    if (authCacheEnabled && cacheAvailable && !options.forceAuthoritative) {
      const cacheReadStartedAt = performance.now();
      const cached = await readInferenceAuthContextWithOutcome(
        keyHash,
        probeDiscriminator ?? undefined,
        options.executionCtx,
      );
      trace.timings.cacheReadMs = durationSince(cacheReadStartedAt);
      trace.cacheRead = cached.kind;
      trace.cacheBackend = cached.backend;
      if (cached.kind === "hit") {
        const credential: InferenceCredentialCheck = {
          kind: "api_key",
          credentialId: cached.ctx.apiKeyId,
          userId: cached.ctx.userId,
        };
        if (deferStrongCredentialCheck) {
          observeInferenceApiKeyUsage(
            { kind: "authorized", ctx: cached.ctx, source: "cache" },
            options.executionCtx,
          );
          trace.result = "authorized_cache";
          return {
            kind: "authorized",
            ctx: cached.ctx,
            source: "cache",
            credential,
          };
        }
        try {
          await assertInferenceCredentialActive(cached.ctx.orgId, credential);
        } catch (error) {
          if (error instanceof InferenceCredentialRevokedError) {
            trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
            const reason = inferenceCredentialRevocationReason(error.reason);
            logStandingDenial({
              status: error.reason === "credential_revoked" ? 401 : 403,
              reason,
              source: "authoritative",
            });
            return error.reason === "credential_revoked"
              ? { kind: "rejected", status: 401, reason }
              : { kind: "suspended", userId: cached.ctx.userId, reason };
          }
          throw error;
        }
        observeInferenceApiKeyUsage(
          { kind: "authorized", ctx: cached.ctx, source: "cache" },
          options.executionCtx,
        );
        if (options.executionCtx) {
          if (Date.now() - cached.ctx.cachedAt >= AUTH_CONTEXT_REFRESH_AFTER_MS) {
            const hydrationOptions = {
              ...options,
              executionCtx: options.executionCtx,
            };
            const hydration = getOrCreateApiKeyHydration(req, keyHash, hydrationOptions);
            observeHydrationProjection(hydration, hydrationOptions, false);
          }
        }
        trace.result = "authorized_cache";
        return { kind: "authorized", ctx: cached.ctx, source: "cache" };
      }
      if (cached.kind === "rejected") {
        trace.result = cached.decision === "suspended" ? "suspended" : "rejected";
        logStandingDenial({
          status: cached.status,
          reason: cached.reason,
          source: "cache",
        });
        return cached.decision === "suspended"
          ? { kind: "suspended", reason: cached.reason }
          : { kind: "rejected", status: cached.status, reason: cached.reason };
      }
    } else if (!cacheAvailable) {
      trace.cacheRead = "unavailable";
    }

    if (authCacheEnabled && options.cacheOnly && !hydrationEscapeActive(keyHash)) {
      trace.authoritative = "not_run";
      trace.result = "warming";
      if (cacheAvailable && options.executionCtx) {
        const hydration = getOrCreateApiKeyHydration(req, keyHash, {
          ...options,
          executionCtx: options.executionCtx,
        });
        const continued = await consumeInlineAuthContinuation(
          hydration.decision,
          options,
          trace.authSource,
        );
        if (continued) {
          const authoritative = hydration.authoritativeTelemetry();
          trace.timings.keyLookupMs = authoritative.timings.keyLookupMs;
          trace.timings.userOrgLookupMs = authoritative.timings.userOrgLookupMs;
          trace.timings.moderationMs = authoritative.timings.moderationMs;
        }
        if (continued?.kind === "authorized") {
          if (!deferStrongCredentialCheck && "keyHash" in continued.ctx) {
            try {
              await assertInferenceCredentialActive(continued.ctx.orgId, {
                kind: "api_key",
                credentialId: continued.ctx.apiKeyId,
                userId: continued.ctx.userId,
              });
            } catch (error) {
              if (error instanceof InferenceCredentialRevokedError) {
                trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
                const reason = inferenceCredentialRevocationReason(error.reason);
                logStandingDenial({
                  status: error.reason === "credential_revoked" ? 401 : 403,
                  reason,
                  source: "authoritative",
                });
                return error.reason === "credential_revoked"
                  ? { kind: "rejected", status: 401, reason }
                  : { kind: "suspended", userId: continued.ctx.userId, reason };
              }
              throw error;
            }
          }
          trace.authoritative = "authorized";
          trace.result = "authorized_origin";
          trace.cacheWrite = "deferred";
          observeHydrationProjection(
            hydration,
            { ...options, executionCtx: options.executionCtx },
            true,
          );
          observeInferenceApiKeyUsage(continued, options.executionCtx);
          return deferStrongCredentialCheck
            ? continued
            : { kind: "authorized", ctx: continued.ctx, source: continued.source };
        }
        if (continued?.kind === "suspended") {
          trace.authoritative = "suspended";
          trace.result = "suspended";
          logStandingDenial({
            status: 403,
            reason: continued.reason,
            source: "authoritative",
          });
          return continued;
        }
        if (continued?.kind === "rejected") {
          trace.authoritative = "rejected";
          trace.result = "rejected";
          logStandingDenial({
            status: continued.status,
            reason: continued.reason,
            source: "authoritative",
          });
          return continued;
        }
        return {
          kind: "warming",
          hydration: hydration.projection,
          continuation: hydration.decision,
        };
      }
      return { kind: "warming" };
    }
    if (authCacheEnabled && options.cacheOnly) {
      // Escape hatch: repeated hydration failures/timeouts mean "retry
      // shortly" has become a lie — resolve authoritatively inline instead.
      // The successful resolve below writes the cache, healing the loop.
      logger.warn("[InferenceAuth] hydration escape — resolving inline", {
        traceId: boundedTraceId(options.traceId),
        failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
      });
      apiKeyHydrationFailures.delete(keyHash);
    }

    trace.authoritative = "error";
    trace.result = "error";
    const { user, apiKey } = await requireInferenceApiKeyWithOrg(credential.rawKey, {
      timing: {
        keyLookup: (durationMs) => {
          trace.timings.keyLookupMs = Math.round(durationMs * 100) / 100;
        },
        userOrgLookup: (durationMs) => {
          trace.timings.userOrgLookupMs = Math.round(durationMs * 100) / 100;
        },
      },
      rejected: (reason) => {
        authoritativeStandingReason = reason;
        options.onAuthoritativeRejection?.(reason);
        trace.authoritative = "rejected";
        trace.result = "rejected";
      },
    });

    const moderationStartedAt = performance.now();
    // Every IAC miss is an authorization refresh, so it must read moderation
    // from the primary rather than re-projecting an isolate-local memo or a
    // lagging replica after an unban invalidated the shared denial.
    const suspended = await adminService.shouldBlockUserConsistent(user.id);
    trace.timings.moderationMs = durationSince(moderationStartedAt);
    if (suspended) {
      trace.authoritative = "suspended";
      trace.result = "suspended";
      logStandingDenial({
        status: 403,
        reason: "moderation_blocked",
        source: "authoritative",
      });
      return { kind: "suspended", userId: user.id, reason: "moderation_blocked" };
    }

    const [admission, appScopeId] = authCacheEnabled
      ? await Promise.all([
          loadInferenceAdmissionSnapshot(user.organization_id),
          loadInferenceAppKeyScope(apiKey.id),
        ])
      : [undefined, null];
    const ctx: InferenceAuthContext = {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: user.id,
      orgId: user.organization_id,
      apiKeyId: apiKey.id,
      keyHash,
      appScopeId,
      ...(admission ? { admission } : {}),
    };
    try {
      if (!deferStrongCredentialCheck) {
        await assertInferenceCredentialActive(ctx.orgId, {
          kind: "api_key",
          credentialId: ctx.apiKeyId,
          userId: ctx.userId,
        });
      }
    } catch (error) {
      if (error instanceof InferenceCredentialRevokedError) {
        trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
        const reason = inferenceCredentialRevocationReason(error.reason);
        logStandingDenial({
          status: error.reason === "credential_revoked" ? 401 : 403,
          reason,
          source: "authoritative",
        });
        return error.reason === "credential_revoked"
          ? { kind: "rejected", status: 401, reason }
          : { kind: "suspended", userId: ctx.userId, reason };
      }
      throw error;
    }
    trace.authoritative = "authorized";
    trace.result = "authorized_origin";
    const hydrationOnly =
      (
        options as ResolveInferenceAuthOptions & {
          [SKIP_CACHE_PROJECTION_WRITE]?: true;
        }
      )[SKIP_CACHE_PROJECTION_WRITE] === true;
    // Internal hydration is not a consumed authorization. Its caller records
    // usage only if it consumes the result; direct requests own their update here.
    if (!hydrationOnly) {
      observeInferenceApiKeyUsage(
        { kind: "authorized", ctx, source: "origin" },
        options.executionCtx,
      );
    }
    const cacheWriteStartedAt = performance.now();
    if (!authCacheEnabled) {
      return {
        kind: "authorized",
        ctx,
        source: "origin",
        ...(deferStrongCredentialCheck
          ? {
              credential: {
                kind: "api_key" as const,
                credentialId: ctx.apiKeyId,
                userId: ctx.userId,
              },
            }
          : {}),
      };
    }
    if (hydrationOnly) {
      trace.cacheWrite = "deferred";
      return {
        kind: "authorized",
        ctx,
        source: "origin",
        ...(deferStrongCredentialCheck
          ? {
              credential: {
                kind: "api_key" as const,
                credentialId: ctx.apiKeyId,
                userId: ctx.userId,
              },
            }
          : {}),
      };
    }
    const cacheWrite = writeInferenceAuthContext(ctx);
    if (cacheAvailable && typeof options.executionCtx?.waitUntil === "function") {
      trace.cacheWrite = "deferred";
      const observedWrite = cacheWrite.then(
        (write) => {
          const telemetry = freezeCacheWriteTrace(options.traceId, write, cacheWriteStartedAt);
          logger.audit("[InferenceAuth] trace", telemetry);
          options.onCacheWriteTelemetry?.(telemetry);
        },
        (error) => {
          // error-policy:J7 authorization is complete; projection failure is
          // structured and observed without rejecting the Worker lifetime.
          logger.warn("[InferenceAuth] deferred cache write rejected", {
            traceId: boundedTraceId(options.traceId),
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        },
      );
      // Authorization is already authoritative; waitUntil preserves cache
      // population and its observed outcome without holding the response path.
      options.executionCtx.waitUntil(observedWrite);
    } else {
      const write = await cacheWrite;
      trace.timings.cacheWriteMs = durationSince(cacheWriteStartedAt);
      trace.cacheWrite = write.kind;
      trace.cacheBackend = write.backend;
    }
    return {
      kind: "authorized",
      ctx,
      source: "origin",
      ...(deferStrongCredentialCheck
        ? {
            credential: {
              kind: "api_key" as const,
              credentialId: ctx.apiKeyId,
              userId: ctx.userId,
            },
          }
        : {}),
    };
  } catch (error) {
    if (authoritativeStandingReason && !standingDenialLogged) {
      const status = getErrorStatusCode(error);
      logStandingDenial({
        status: status === 401 ? 401 : 403,
        reason: authoritativeStandingReason,
        source: "authoritative",
      });
    }
    if (!standingDenialLogged) {
      logger.error("[InferenceAuth] authorization flow failed", {
        traceId: boundedTraceId(options.traceId),
        authSource: trace.authSource,
        cacheBackend: trace.cacheBackend,
        cacheRead: trace.cacheRead,
        authoritative: trace.authoritative,
        result: trace.result,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    const telemetry = freezeTrace(options.traceId, trace, totalStartedAt);
    const nested = (
      options as ResolveInferenceAuthOptions & { [SUPPRESS_STANDING_DENIAL_LOG]?: true }
    )[SUPPRESS_STANDING_DENIAL_LOG];
    if (nested) logger.info("[InferenceAuth] hydration trace", telemetry);
    else logger.audit("[InferenceAuth] trace", telemetry);
    options.onTelemetry?.(telemetry);
  }
}
