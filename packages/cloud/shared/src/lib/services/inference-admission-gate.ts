/**
 * Serialized organization admission controls for Worker inference.
 *
 * Cloudflare KV is eventually consistent and cannot safely decrement a cached
 * counter or balance under concurrency. Billing leases retain one Durable
 * Object per organization, while endpoint limits use independent rate-only
 * identities. This preserves quota without letting slow ledger storage block
 * the rate-limit input gate.
 */

import { sql } from "drizzle-orm";
import { sqlRows } from "../../db/execute-helpers";
import { writeTransaction } from "../../db/helpers";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../types/cloud-worker-env";
import { observeInferenceDependency } from "../observability/cloud-backend-observability";
import { getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import {
  type CreditReconciliationResult,
  creditsService,
  type InferenceBalanceFence,
} from "./credits";
import type { InferenceAdmissionRecoveryContext } from "./inference-admission-recovery";
import {
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
} from "./inference-credential-revocation";
import type { EndpointType } from "./org-rate-limits";

const GATE_BINDING = "INFERENCE_ADMISSION_GATES";
const GATE_ORIGIN = "https://inference-admission.internal";
const RATE_LIMIT_GATE_PREFIX = "rate-limit:v2:";
const HYDRATION_GATE_TIMEOUT_MS = 5_000;
const GATE_OPERATION_TIMEOUT_MS = 1_500;
const RATE_LIMIT_GATE_MAX_ATTEMPTS = 2;
const LEASE_GATE_MAX_ATTEMPTS = 2;
const DISPATCH_GATE_TIMEOUT_MS = 1_500;
const DISPATCH_GATE_MAX_ATTEMPTS = 3;
const SETTLEMENT_FENCE_GATE_TIMEOUT_MS = 1_500;
const SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WARM_TTL_MS = 5 * 60_000;
const RATE_LIMIT_WARM_MAX_ENTRIES = 4_096;

interface LeaseResponse {
  admitted: boolean;
  availableUsd: number;
  requiredUsd: number;
}

interface SettleResponse {
  settled: boolean;
}

interface DispatchResponse {
  dispatched: boolean;
}

interface LeaseDispatchResponse extends LeaseResponse, DispatchResponse {}

interface ReleaseResponse {
  released: boolean;
}

interface SettlementFenceResponse {
  settlementFenced: boolean;
  estimatedCostUsd: number;
}

interface HydrateResponse {
  hydrated: boolean;
}

interface RateLimitWarmResponse {
  warmed: boolean;
}

export interface InferenceRateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface InferenceAdmissionLease {
  organizationId: string;
  requestId: string;
  estimatedCostUsd: number;
  gate: RuntimeDurableObjectStub;
  providerDispatched: boolean;
  /**
   * Proves that a live Worker abandoned dispatch before invoking the provider.
   * It is destroyed as soon as dispatch acknowledgement is received.
   */
  preProviderCancellationToken?: string;
  /**
   * Immutable lease body retained locally until the provider-boundary commit.
   * Only explicitly audited callers use this mode; legacy callers still
   * acquire a durable `leased` record before this object is returned.
   */
  preparedDispatch?: {
    path: "/lease-dispatched" | "/lease-dispatched-authorized";
    body: Record<string, unknown>;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    state: "prepared" | "ambiguous" | "rejected";
  };
}

export class InferenceAdmissionGateUnavailableError extends Error {
  constructor(message = "Inference admission gate is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InferenceAdmissionGateUnavailableError";
  }
}

/**
 * The dispatch marker failed before this Worker invoked the provider.
 *
 * The Durable Object may still have committed the dispatch intent, so callers
 * must use zero settlement rather than assuming the lease stayed untouched.
 */
export class InferenceAdmissionDispatchMarkError extends InferenceAdmissionGateUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InferenceAdmissionDispatchMarkError";
  }
}

/** Recognize a dispatch-mark failure through context-adding error wrappers. */
export function isInferenceAdmissionDispatchMarkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current instanceof InferenceAdmissionDispatchMarkError) return true;
    current = current instanceof Error && "cause" in current ? current.cause : undefined;
  }
  return false;
}

export class InferenceAdmissionLeaseRejectedError extends Error {
  constructor(
    readonly requiredUsd: number,
    readonly availableUsd: number,
  ) {
    super(
      `Inference admission lease rejected. Required: $${requiredUsd.toFixed(4)}, Available: $${availableUsd.toFixed(4)}`,
    );
    this.name = "InferenceAdmissionLeaseRejectedError";
  }
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InferenceAdmissionGateUnavailableError(
      `Invalid ${field} supplied to inference admission gate`,
    );
  }
  return value;
}

function gateStub(organizationId: string): RuntimeDurableObjectStub {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(GATE_BINDING);
  if (!namespace) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission Durable Object binding is missing",
    );
  }
  return namespace.getByName(organizationId);
}

function rateLimitGateStub(organizationId: string): RuntimeDurableObjectStub {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(GATE_BINDING);
  if (!namespace) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission Durable Object binding is missing",
    );
  }
  return namespace.getByName(`${RATE_LIMIT_GATE_PREFIX}${organizationId}`);
}

async function gateFetch(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
  stub = gateStub(organizationId),
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await observeInferenceDependency("durable_object", path, () =>
      stub.fetch(
        new Request(`${GATE_ORIGIN}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof InferenceAdmissionGateUnavailableError) throw error;
    // error-policy:J2 preserve the failed binding/transport operation as cause.
    throw new InferenceAdmissionGateUnavailableError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

async function parseLeaseResponse(response: Response): Promise<LeaseResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).admitted !== "boolean" ||
      !Number.isFinite((value as Record<string, unknown>).availableUsd) ||
      !Number.isFinite((value as Record<string, unknown>).requiredUsd)
    ) {
      throw new TypeError("response does not match the lease schema");
    }
    return value as LeaseResponse;
  } catch (error) {
    // error-policy:J3 a malformed Durable Object response is an explicit
    // unavailable decision, never an admission fallback.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function parseLeaseDispatchResponse(response: Response): Promise<LeaseDispatchResponse> {
  const lease = await parseLeaseResponse(response);
  if ((lease as Partial<LeaseDispatchResponse>).dispatched !== true) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission gate returned an invalid combined dispatch response",
    );
  }
  return lease as LeaseDispatchResponse;
}

async function parseSettleResponse(response: Response): Promise<SettleResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).settled !== true
    ) {
      throw new TypeError("response does not match the settlement schema");
    }
    return value as SettleResponse;
  } catch (error) {
    // error-policy:J3 malformed responses never become successful settlement.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid settlement JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseLeaseTransitionResponse<Field extends "dispatched" | "released">(
  response: Response,
  field: Field,
): Promise<Field extends "dispatched" ? DispatchResponse : ReleaseResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>)[field] !== true
    ) {
      throw new TypeError(`response does not confirm ${field}`);
    }
    return value as Field extends "dispatched" ? DispatchResponse : ReleaseResponse;
  } catch (error) {
    // error-policy:J3 malformed transition responses never advance a lease.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid ${field} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseSettlementFenceResponse(response: Response): Promise<SettlementFenceResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).settlementFenced !== true ||
      !Number.isFinite((value as Record<string, unknown>).estimatedCostUsd) ||
      ((value as Record<string, unknown>).estimatedCostUsd as number) <= 0
    ) {
      throw new TypeError("response does not confirm the settlement fence");
    }
    return value as SettlementFenceResponse;
  } catch (error) {
    // error-policy:J2 preserve malformed acknowledgement details in the typed transport failure.
    // A committed transition can lose its response. Treat malformed 2xx as
    // acknowledgement ambiguity so the caller replays the monotonic request.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid settlement-fence JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseHydrateResponse(response: Response): Promise<HydrateResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).hydrated !== true
    ) {
      throw new TypeError("response does not match the hydration schema");
    }
    return value as HydrateResponse;
  } catch (error) {
    // error-policy:J3 malformed responses never become successful hydration.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid hydration JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseRateLimitWarmResponse(response: Response): Promise<RateLimitWarmResponse> {
  try {
    const value = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).warmed !== true
    ) {
      throw new TypeError("response does not match the rate-limit warm schema");
    }
    return value as RateLimitWarmResponse;
  } catch (error) {
    // error-policy:J3 malformed responses never become successful prewarm.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid rate-limit warm JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function parseRateLimitResponse(response: Response): Promise<InferenceRateLimitDecision> {
  try {
    const value = await response.json();
    if (typeof value !== "object" || value === null) {
      throw new TypeError("response does not match the rate-limit schema");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.allowed !== "boolean" ||
      !Number.isSafeInteger(record.remaining) ||
      (record.remaining as number) < 0 ||
      !Number.isSafeInteger(record.resetAt) ||
      (record.resetAt as number) <= 0 ||
      (record.retryAfter !== undefined &&
        (!Number.isSafeInteger(record.retryAfter) || (record.retryAfter as number) <= 0))
    ) {
      throw new TypeError("response does not match the rate-limit schema");
    }
    return value as InferenceRateLimitDecision;
  } catch (error) {
    // error-policy:J3 malformed responses never become an allowed request.
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate returned invalid rate-limit JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readGateErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value = await response.json();
    if (typeof value !== "object" || value === null) return undefined;
    const code = (value as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    // error-policy:J3 a malformed error payload remains an unavailable
    // decision; callers never treat it as admission.
    return undefined;
  }
}

const gateHydrations = new Map<string, Promise<void>>();

function hydrateInferenceAdmissionGate(
  organizationId: string,
  stub: RuntimeDurableObjectStub,
): Promise<void> {
  const existing = gateHydrations.get(organizationId);
  if (existing) return existing;
  const hydration = writeTransaction(async (tx) => {
    const rows = await sqlRows<{
      credit_balance: string | number | null;
      balance_revision: string | number | null;
    }>(
      tx,
      sql`
        SELECT credit_balance, balance_revision
        FROM organizations
        WHERE id = ${organizationId}
        FOR UPDATE
      `,
    );
    const row = rows[0];
    const balanceUsd = row ? Number(row.credit_balance) : 0;
    const balanceRevision = row ? String(row.balance_revision) : "0";
    if (!Number.isFinite(balanceUsd) || balanceUsd < 0 || !/^(0|[1-9]\d*)$/.test(balanceRevision)) {
      throw new InferenceAdmissionGateUnavailableError(
        "Authoritative inference balance snapshot is invalid",
      );
    }
    const response = await gateFetch(
      organizationId,
      "/hydrate",
      { balanceUsd, balanceRevision },
      stub,
      AbortSignal.timeout(HYDRATION_GATE_TIMEOUT_MS),
    );
    if (!response.ok) {
      throw new InferenceAdmissionGateUnavailableError(
        `Inference admission gate hydration failed with status ${response.status}`,
      );
    }
    await parseHydrateResponse(response);
  }).finally(() => {
    gateHydrations.delete(organizationId);
  });
  gateHydrations.set(organizationId, hydration);
  return hydration;
}

/** Hydrate an organization's durable admission gate before an interactive turn. */
export async function warmInferenceAdmissionGate(organizationId: string): Promise<void> {
  await hydrateInferenceAdmissionGate(organizationId, gateStub(organizationId));
}

const rateLimitWarms = new Map<string, { expiresAt: number; promise: Promise<void> }>();

function activeRateLimitGate(
  organizationId: string,
  windowMs: number,
): {
  stub: RuntimeDurableObjectStub;
  windowStartedAt: number;
} {
  // Capture the fixed-window identity before the request can wait behind the
  // Durable Object input gate. This keeps delayed arrivals charged to the
  // window in which the Worker admitted them.
  const now = Date.now();
  return {
    stub: rateLimitGateStub(organizationId),
    windowStartedAt: Math.floor(now / windowMs) * windowMs,
  };
}

/** Warm only the strongly ordered rate-limit window, without reading the balance database. */
export async function warmInferenceRateLimitGate(
  organizationId: string,
  windowMs = 60_000,
): Promise<void> {
  const key = `${windowMs}:${organizationId}`;
  const now = Date.now();
  const existing = rateLimitWarms.get(key);
  if (existing && existing.expiresAt > now) {
    await existing.promise;
    return;
  }
  if (rateLimitWarms.size >= RATE_LIMIT_WARM_MAX_ENTRIES) {
    const oldest = rateLimitWarms.keys().next().value;
    if (oldest !== undefined) rateLimitWarms.delete(oldest);
  }
  const warm = (async () => {
    const response = await gateFetch(
      organizationId,
      "/rate-limit-warm",
      {},
      rateLimitGateStub(organizationId),
      AbortSignal.timeout(HYDRATION_GATE_TIMEOUT_MS),
    );
    if (!response.ok) {
      throw new InferenceAdmissionGateUnavailableError(
        `Inference admission gate rate-limit warm failed with status ${response.status}`,
      );
    }
    await parseRateLimitWarmResponse(response);
  })().catch((error) => {
    rateLimitWarms.delete(key);
    throw error;
  });
  rateLimitWarms.set(key, {
    expiresAt: now + RATE_LIMIT_WARM_TTL_MS,
    promise: warm,
  });
  await warm;
}

function scheduleGateHydration(
  organizationId: string,
  stub: RuntimeDurableObjectStub,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): void {
  const observed = hydrateInferenceAdmissionGate(organizationId, stub).catch((error) => {
    // error-policy:J7 cold-gate hydration is retried by the next 503 request;
    // log the failure without turning the already-returned response into 500.
    logger.warn("[InferenceAdmissionGate] hydration failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  executionCtx.waitUntil(observed);
}

/**
 * Atomically consume one request from an organization's endpoint window.
 * The Durable Object response is the only authoritative Worker-side decision.
 */
export async function consumeInferenceRateLimit(params: {
  organizationId: string;
  endpointType: EndpointType;
  windowMs: number;
  maxRequests: number;
}): Promise<InferenceRateLimitDecision> {
  if (
    !params.organizationId ||
    params.organizationId.length > 256 ||
    !Number.isSafeInteger(params.windowMs) ||
    params.windowMs <= 0 ||
    !Number.isSafeInteger(params.maxRequests) ||
    params.maxRequests <= 0
  ) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference rate-limit identity and positive policy are required",
    );
  }

  const activeGate = activeRateLimitGate(params.organizationId, params.windowMs);
  const operationStartedAt = Date.now();
  const body = {
    operationId: crypto.randomUUID(),
    operationDeadlineAt:
      operationStartedAt + RATE_LIMIT_GATE_MAX_ATTEMPTS * GATE_OPERATION_TIMEOUT_MS,
    endpointType: params.endpointType,
    windowMs: params.windowMs,
    maxRequests: params.maxRequests,
    windowStartedAt: activeGate.windowStartedAt,
  };
  let response: Response | undefined;
  for (let attempt = 1; attempt <= RATE_LIMIT_GATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await gateFetch(
        params.organizationId,
        "/rate-limit",
        body,
        activeGate.stub,
        AbortSignal.timeout(GATE_OPERATION_TIMEOUT_MS),
      );
    } catch (error) {
      // error-policy:J2 gateFetch already wraps the transport failure with
      // typed context. Retry once with the same idempotency identity, then
      // preserve that wrapper as the exhausted operation's cause.
      if (attempt < RATE_LIMIT_GATE_MAX_ATTEMPTS) continue;
      throw error;
    }
    if (response.status >= 500 && attempt < RATE_LIMIT_GATE_MAX_ATTEMPTS) continue;
    break;
  }
  if (!response) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission gate rate limit produced no response",
    );
  }
  if (response.status !== 200 && response.status !== 429) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate rate limit failed with status ${response.status}`,
    );
  }
  const decision = await parseRateLimitResponse(response);
  if (
    (response.status === 200 && !decision.allowed) ||
    (response.status === 429 && decision.allowed)
  ) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission gate returned an inconsistent rate-limit decision",
    );
  }
  return decision;
}

/**
 * Atomically lease an estimated charge from the cached organization balance.
 * Duplicate request IDs are idempotent only when the amount is identical.
 */
export async function acquireInferenceAdmissionLease(params: {
  organizationId: string;
  requestId: string;
  balanceUsd: number;
  balanceRevision: string;
  estimatedCostUsd: number;
  recovery: InferenceAdmissionRecoveryContext;
  /** Strong standing proof fused into the lease transaction when supplied. */
  credential?: InferenceCredentialCheck;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** Commit the balance lease atomically with dispatch at an audited provider boundary. */
  deferCommitUntilDispatch?: boolean;
}): Promise<InferenceAdmissionLease> {
  const balanceUsd = finiteNonNegative(params.balanceUsd, "balanceUsd");
  const estimatedCostUsd = finiteNonNegative(params.estimatedCostUsd, "estimatedCostUsd");
  if (
    !params.organizationId ||
    !params.requestId ||
    !/^(0|[1-9]\d*)$/.test(params.balanceRevision) ||
    estimatedCostUsd === 0
  ) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission lease identity and positive cost are required",
    );
  }

  const stub = gateStub(params.organizationId);
  const path = params.credential ? "/lease-authorized" : "/lease";
  const body = {
    organizationId: params.organizationId,
    requestId: params.requestId,
    balanceUsd,
    balanceRevision: params.balanceRevision,
    estimatedCostUsd,
    recovery: params.recovery,
    ...(params.credential
      ? {
          credential: {
            organizationId: params.organizationId,
            ...params.credential,
          },
        }
      : {}),
  };
  const preProviderCancellationToken = crypto.randomUUID();
  if (params.deferCommitUntilDispatch) {
    return {
      organizationId: params.organizationId,
      requestId: params.requestId,
      estimatedCostUsd,
      gate: stub,
      providerDispatched: false,
      preProviderCancellationToken,
      preparedDispatch: {
        path: params.credential ? "/lease-dispatched-authorized" : "/lease-dispatched",
        body,
        executionCtx: params.executionCtx,
        state: "prepared",
      },
    };
  }
  let response: Response | undefined;
  for (let attempt = 1; attempt <= LEASE_GATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await gateFetch(
        params.organizationId,
        path,
        body,
        stub,
        AbortSignal.timeout(GATE_OPERATION_TIMEOUT_MS),
      );
    } catch (error) {
      if (attempt < LEASE_GATE_MAX_ATTEMPTS) continue;
      throw error;
    }
    if (response.status >= 500 && attempt < LEASE_GATE_MAX_ATTEMPTS) continue;
    break;
  }
  if (!response) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission gate lease produced no response",
    );
  }
  if (response.status === 403 && params.credential) {
    let reason = "revoked";
    try {
      const payload = (await response.json()) as { reason?: unknown };
      if (typeof payload.reason === "string") reason = payload.reason;
    } catch {
      // error-policy:J3 malformed denial output remains a fail-closed generic revocation.
    }
    throw new InferenceCredentialRevokedError(reason);
  }
  if (response.status === 503) {
    const code = await readGateErrorCode(response);
    if (code === "inference_admission_gate_uninitialized" && params.executionCtx) {
      scheduleGateHydration(params.organizationId, stub, params.executionCtx);
    }
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate lease failed with status ${response.status}`,
    );
  }
  const payload = await parseLeaseResponse(response);
  if (response.status === 402) {
    throw new InferenceAdmissionLeaseRejectedError(payload.requiredUsd, payload.availableUsd);
  }
  if (!response.ok || !payload?.admitted) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate lease failed with status ${response.status}`,
    );
  }
  return {
    organizationId: params.organizationId,
    requestId: params.requestId,
    estimatedCostUsd,
    gate: stub,
    providerDispatched: false,
    preProviderCancellationToken,
  };
}

/**
 * Keep the serialized admission authority ahead of the eventually-consistent
 * KV projection during post-provider billing. Same-revision updates can only
 * lower the ceiling; authoritative newer revisions advance it normally.
 */
async function publishInferenceAdmissionBalance(
  lease: InferenceAdmissionLease,
  balanceUsd: number,
  balanceRevision: string,
): Promise<void> {
  const safeBalance = finiteNonNegative(balanceUsd, "balanceUsd");
  if (!/^(0|[1-9]\d*)$/.test(balanceRevision)) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission balance fence revision is invalid",
    );
  }
  const response = await gateFetch(
    lease.organizationId,
    "/hydrate",
    { balanceUsd: safeBalance, balanceRevision },
    lease.gate,
    AbortSignal.timeout(GATE_OPERATION_TIMEOUT_MS),
  );
  if (!response.ok) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission balance fence failed with status ${response.status}`,
    );
  }
  await parseHydrateResponse(response);
}

/** Build the two-stage live-settlement fence bound to one active lease. */
export function createInferenceAdmissionBalanceFence(
  lease: InferenceAdmissionLease,
): InferenceBalanceFence {
  return {
    lowerCommittedBalance: async (balanceUsd, balanceRevision) =>
      publishInferenceAdmissionBalance(lease, balanceUsd, balanceRevision),
    publishAuthoritativeBalance: async (balanceUsd, balanceRevision) =>
      publishInferenceAdmissionBalance(lease, balanceUsd, balanceRevision),
  };
}

/** Convert reconciliation into the amount that was actually collected. */
export function collectedInferenceCost(
  lease: InferenceAdmissionLease,
  actualCostUsd: number,
  reconciliation: CreditReconciliationResult | null,
): number {
  const actual = finiteNonNegative(actualCostUsd, "actualCostUsd");
  if (!reconciliation) {
    return Math.max(actual, lease.estimatedCostUsd);
  }
  if (reconciliation.adjustmentType === "uncollected_overage") {
    return Math.max(actual, lease.estimatedCostUsd);
  }
  if (reconciliation.collectedAmount !== undefined) {
    return finiteNonNegative(reconciliation.collectedAmount, "reconciliation.collectedAmount");
  }
  return actual;
}

/** Split database-backed collection from conservative gate-only consumption. */
export function inferenceSettlementAmounts(
  lease: InferenceAdmissionLease,
  actualCostUsd: number,
  reconciliation: CreditReconciliationResult | null,
): { balanceBackedUsd: number; gateConsumedUsd: number } {
  const actual = finiteNonNegative(actualCostUsd, "actualCostUsd");
  const gateConsumedUsd = collectedInferenceCost(lease, actual, reconciliation);
  const balanceBackedUsd =
    reconciliation?.collectedAmount !== undefined
      ? finiteNonNegative(reconciliation.collectedAmount, "reconciliation.collectedAmount")
      : reconciliation?.adjustmentType === "uncollected_overage"
        ? Math.min(
            gateConsumedUsd,
            finiteNonNegative(reconciliation.reservedAmount, "reconciliation.reservedAmount"),
          )
        : actual;
  return { balanceBackedUsd, gateConsumedUsd };
}

/** Commit a prepared lease or persist legacy dispatch intent immediately before provider work. */
export async function markInferenceAdmissionLeaseDispatched(
  lease: InferenceAdmissionLease,
): Promise<void> {
  if (lease.providerDispatched) return;
  const cancellationToken = lease.preProviderCancellationToken;
  if (!cancellationToken) {
    throw new InferenceAdmissionDispatchMarkError(
      "Inference admission lease has no pre-provider cancellation capability",
    );
  }

  let lastAmbiguousError: unknown;
  const prepared = lease.preparedDispatch;
  let mayHaveCommitted = prepared?.state === "ambiguous";
  const path = prepared?.path ?? "/dispatch";
  const body = prepared
    ? { ...prepared.body, preProviderCancellationToken: cancellationToken }
    : {
        requestId: lease.requestId,
        preProviderCancellationToken: cancellationToken,
      };
  if (prepared) prepared.state = "ambiguous";
  for (let attempt = 1; attempt <= DISPATCH_GATE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await gateFetch(
        lease.organizationId,
        path,
        body,
        lease.gate,
        AbortSignal.timeout(DISPATCH_GATE_TIMEOUT_MS),
      );
    } catch (error) {
      mayHaveCommitted = true;
      lastAmbiguousError = error;
      if (attempt < DISPATCH_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    if (prepared && response.status === 403) {
      // A later denial cannot erase a prior acknowledgement-ambiguous commit.
      if (!mayHaveCommitted) prepared.state = "rejected";
      let reason = "revoked";
      try {
        const payload = (await response.json()) as { reason?: unknown };
        if (typeof payload.reason === "string") reason = payload.reason;
      } catch {
        // error-policy:J3 malformed denial output remains a fail-closed generic revocation.
      }
      throw new InferenceCredentialRevokedError(reason);
    }
    if (prepared && response.status === 402) {
      if (!mayHaveCommitted) prepared.state = "rejected";
      const payload = await parseLeaseResponse(response);
      throw new InferenceAdmissionLeaseRejectedError(payload.requiredUsd, payload.availableUsd);
    }
    if (prepared && response.status === 503) {
      const code = await readGateErrorCode(response);
      if (
        attempt === DISPATCH_GATE_MAX_ATTEMPTS &&
        code === "inference_admission_gate_uninitialized" &&
        prepared.executionCtx
      ) {
        scheduleGateHydration(lease.organizationId, lease.gate, prepared.executionCtx);
      }
      const error = new InferenceAdmissionDispatchMarkError(
        `Inference admission gate combined dispatch failed with status ${response.status}`,
      );
      mayHaveCommitted = true;
      lastAmbiguousError = error;
      if (attempt < DISPATCH_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    if (!response.ok) {
      if (prepared && response.status < 500 && !mayHaveCommitted) {
        prepared.state = "rejected";
      }
      const error = new InferenceAdmissionDispatchMarkError(
        `Inference admission gate dispatch failed with status ${response.status}`,
      );
      if (response.status < 500) throw error;
      mayHaveCommitted = true;
      lastAmbiguousError = error;
      if (attempt < DISPATCH_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    try {
      if (prepared) await parseLeaseDispatchResponse(response);
      else await parseLeaseTransitionResponse(response, "dispatched");
    } catch (error) {
      // A valid 2xx transport with an unreadable body can still follow a
      // committed dispatch. Replaying the same capability resolves ambiguity.
      mayHaveCommitted = true;
      lastAmbiguousError = error;
      if (attempt < DISPATCH_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    lease.providerDispatched = true;
    lease.preProviderCancellationToken = undefined;
    lease.preparedDispatch = undefined;
    return;
  }
  // error-policy:J2 all attempts remain ambiguous. The capability stays on
  // the lease so a live error settlement can prove no provider was invoked.
  throw new InferenceAdmissionDispatchMarkError(
    `Inference admission gate dispatch acknowledgement remained ambiguous after ${DISPATCH_GATE_MAX_ATTEMPTS} attempts`,
    { cause: lastAmbiguousError },
  );
}

/**
 * Before post-provider billing mutates money, widen the durable lease to the
 * known actual cost. The DO transition is monotonic and idempotent, so an
 * acknowledgement-ambiguous call is replayed and billing never starts until a
 * valid acknowledgement confirms the durable exposure.
 */
export async function fenceInferenceAdmissionLeaseForSettlement(
  lease: InferenceAdmissionLease,
  knownActualCostUsd: number,
): Promise<void> {
  if (!lease.providerDispatched) {
    throw new InferenceAdmissionGateUnavailableError(
      "Inference admission settlement fence requires a dispatched lease",
    );
  }
  const targetEstimateUsd = Math.max(
    lease.estimatedCostUsd,
    finiteNonNegative(knownActualCostUsd, "knownActualCostUsd"),
  );
  let lastAmbiguousError: unknown;
  for (let attempt = 1; attempt <= SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await gateFetch(
        lease.organizationId,
        "/settlement-fence",
        {
          requestId: lease.requestId,
          estimatedCostUsd: targetEstimateUsd,
        },
        lease.gate,
        AbortSignal.timeout(SETTLEMENT_FENCE_GATE_TIMEOUT_MS),
      );
    } catch (error) {
      // error-policy:J2 retry the idempotent fence, then rethrow with the last acknowledgement failure.
      lastAmbiguousError = error;
      if (attempt < SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    if (!response.ok) {
      const error = new InferenceAdmissionGateUnavailableError(
        `Inference admission settlement fence failed with status ${response.status}`,
      );
      if (response.status < 500) throw error;
      lastAmbiguousError = error;
      if (attempt < SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS) continue;
      break;
    }
    try {
      const payload = await parseSettlementFenceResponse(response);
      if (payload.estimatedCostUsd + 0.0000001 < targetEstimateUsd) {
        throw new InferenceAdmissionGateUnavailableError(
          "Inference admission settlement fence acknowledged a lower estimate",
        );
      }
      lease.estimatedCostUsd = Math.max(lease.estimatedCostUsd, payload.estimatedCostUsd);
      return;
    } catch (error) {
      // error-policy:J2 retry the idempotent fence, then rethrow with the last acknowledgement failure.
      lastAmbiguousError = error;
      if (attempt < SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS) continue;
      break;
    }
  }
  throw new InferenceAdmissionGateUnavailableError(
    `Inference admission settlement-fence acknowledgement remained ambiguous after ${SETTLEMENT_FENCE_GATE_MAX_ATTEMPTS} attempts`,
    { cause: lastAmbiguousError },
  );
}

/** Release a lease only when no provider dispatch was attempted. */
export async function releaseInferenceAdmissionLease(
  lease: InferenceAdmissionLease,
): Promise<void> {
  if (lease.providerDispatched) {
    throw new InferenceAdmissionGateUnavailableError(
      "Dispatched inference work cannot be released without accounting",
    );
  }
  if (
    lease.preparedDispatch?.state === "prepared" ||
    lease.preparedDispatch?.state === "rejected"
  ) {
    lease.preProviderCancellationToken = undefined;
    lease.preparedDispatch = undefined;
    return;
  }
  const response = await gateFetch(
    lease.organizationId,
    "/release",
    {
      requestId: lease.requestId,
      ...(lease.preProviderCancellationToken && {
        preProviderCancellationToken: lease.preProviderCancellationToken,
      }),
    },
    lease.gate,
    AbortSignal.timeout(GATE_OPERATION_TIMEOUT_MS),
  );
  if (!response.ok) {
    if (
      lease.preparedDispatch?.state === "ambiguous" &&
      response.status === 409 &&
      (await readGateErrorCode(response)) === "inference_admission_lease_not_found"
    ) {
      // The combined request may have failed before reaching the Durable
      // Object. No lease and no provider invocation is already the requested
      // zero-cost terminal state, so cleanup is idempotently complete.
      lease.preProviderCancellationToken = undefined;
      lease.preparedDispatch = undefined;
      return;
    }
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate release failed with status ${response.status}`,
    );
  }
  await parseLeaseTransitionResponse(response, "released");
  lease.preProviderCancellationToken = undefined;
}

/**
 * Finalize a provider-dispatched lease from an authoritative post-accounting
 * balance snapshot. This read is deliberately post-provider and off-response;
 * it prevents delayed cache snapshots from resurrecting an intervening debit.
 */
export async function settleInferenceAdmissionLease(
  lease: InferenceAdmissionLease,
  balanceBackedCostUsd: number,
  gateConsumedCostUsd = balanceBackedCostUsd,
): Promise<void> {
  const balanceBackedUsd = finiteNonNegative(balanceBackedCostUsd, "balanceBackedCostUsd");
  const gateConsumedUsd = finiteNonNegative(gateConsumedCostUsd, "gateConsumedCostUsd");
  if (gateConsumedUsd < balanceBackedUsd) {
    throw new InferenceAdmissionGateUnavailableError(
      "Gate consumption cannot be lower than balance-backed collection",
    );
  }
  if (!lease.providerDispatched) {
    if (balanceBackedUsd === 0 && gateConsumedUsd === 0) {
      await releaseInferenceAdmissionLease(lease);
      return;
    }
    await markInferenceAdmissionLeaseDispatched(lease);
  }
  const snapshot = await creditsService.getOrganizationBalanceSnapshot(lease.organizationId);
  const response = await gateFetch(
    lease.organizationId,
    "/settle",
    {
      requestId: lease.requestId,
      balanceBackedUsd,
      gateConsumedUsd,
      balanceUsd: snapshot.balanceUsd,
      balanceRevision: snapshot.revision,
    },
    lease.gate,
    AbortSignal.timeout(GATE_OPERATION_TIMEOUT_MS),
  );
  if (!response.ok) {
    throw new InferenceAdmissionGateUnavailableError(
      `Inference admission gate settlement failed with status ${response.status}`,
    );
  }
  await parseSettleResponse(response);
}
