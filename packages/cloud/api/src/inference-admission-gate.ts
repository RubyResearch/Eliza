/**
 * Serialized admission controls for inference requests.
 *
 * Billing leases retain one object identity per organization. Fixed-window
 * limits use distinct rate-only identities after a globally coordinated window
 * boundary, so their storage input gates cannot inherit ledger stalls without
 * resetting an active quota window. The object never queries Postgres or Redis.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { isAffiliateBillingAttribution } from "@/lib/services/affiliate-billing-attribution";
import type { InferenceBalanceFence } from "@/lib/services/credits";
import type {
  InferenceAdmissionRecoveryContext,
  InferenceAdmissionRecoveryResult,
} from "@/lib/services/inference-admission-recovery";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface ActiveLeaseTiming {
  estimatedCostUsd: number;
  createdAt: number;
  expiresAt: number;
  phase: "leased" | "dispatched" | "recovering";
  recoveryStartedAt?: number;
}

interface ActiveLease extends ActiveLeaseTiming {
  /**
   * A live Worker retains this capability only until it receives dispatch
   * acknowledgement. It can therefore cancel an acknowledgement-ambiguous
   * dispatch without making crash recovery optimistic.
   */
  preProviderCancellationToken?: string;
  recovery: InferenceAdmissionRecoveryContext;
}

interface GateLedger {
  balanceRevision: string;
  balanceCeilingUsd: number;
  availableUsd: number;
  uncollectedDebtUsd: number;
  activeLeaseCount: number;
  activeEstimateUsd: number;
  nextAlarmAt: number | null;
  settledRequestIds: string[];
}

interface LeaseExpiryIndex {
  requestId: string;
  createdAt: number;
  dueAt: number;
}

interface LeaseRequest {
  organizationId: string;
  requestId: string;
  balanceUsd: number;
  balanceRevision: string;
  estimatedCostUsd: number;
  recovery: InferenceAdmissionRecoveryContext;
}

interface AuthorizedLeaseRequest extends LeaseRequest {
  credential: CredentialCheckRequest;
}

interface LeaseDispatchRequest extends LeaseRequest {
  preProviderCancellationToken: string;
}

interface AuthorizedLeaseDispatchRequest extends AuthorizedLeaseRequest {
  preProviderCancellationToken: string;
}

interface HydrateRequest {
  balanceUsd: number;
  balanceRevision: string;
}

interface SettleRequest {
  requestId: string;
  balanceBackedUsd: number;
  gateConsumedUsd: number;
  balanceUsd: number;
  balanceRevision: string;
}

interface LeaseIdentityRequest {
  requestId: string;
  preProviderCancellationToken?: string;
}

interface SettlementFenceRequest {
  requestId: string;
  estimatedCostUsd: number;
}

interface RateLimitRequest {
  /** Stable across an internal transport retry so one arrival consumes once. */
  operationId?: string;
  /** Rejects an acknowledgement-ambiguous retry after its caller stopped waiting. */
  operationDeadlineAt?: number;
  endpointType: string;
  windowMs: number;
  maxRequests: number;
  /** Fixed-window identity captured before this request enters a Durable Object queue. */
  windowStartedAt?: number;
}

type CredentialCheckRequest =
  | {
      organizationId: string;
      kind: "api_key";
      credentialId: string;
      userId: string;
    }
  | {
      organizationId: string;
      kind: "steward_session";
      userId: string;
      stewardUserId: string;
      issuedAt: number;
    };

interface CredentialRevokeRequest {
  organizationId: string;
  kind: "api_key";
  credentialId: string;
}

interface SubjectStateRequest {
  organizationId: string;
  userId: string;
  active: boolean;
  reason: SubjectDisableReason;
}

type SubjectDisableReason = "account" | "moderation" | "membership";

interface SessionRevokeRequest {
  organizationId: string;
  userId: string;
  issuedAt: number;
}

interface SessionBindingStateRequest {
  organizationId: string;
  userId: string;
  stewardUserId: string;
  active: boolean;
}

interface OrganizationStateRequest {
  organizationId: string;
  active: boolean;
}

interface RateLimitCutoverRequest {
  windowMs: number;
}

interface RateLimitWindow {
  windowStartedAt: number;
  windowMs: number;
  maxRequests: number;
  count: number;
  receipts?: RateLimitReceipt[];
}

interface RateLimitReceipt {
  operationId: string;
  operationDeadlineAt: number;
  expiresAt: number;
  windowStartedAt: number;
  windowMs: number;
  maxRequests: number;
  decision: {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    retryAfter?: number;
  };
}

type RateLimitWindows = Record<string, RateLimitWindow>;

const LEDGER_KEY = "ledger";
const LEASE_KEY_PREFIX = "lease:";
const LEASE_ACTIVE_KEY_PREFIX = "lease-active:";
const LEASE_EXPIRY_KEY_PREFIX = "lease-expiry:";
const RATE_LIMITS_KEY = "rate-limits";
const ORGANIZATION_DISABLED_KEY = "revocation:organization-disabled";
const REVOKED_API_KEY_PREFIX = "revocation:api-key:";
const DISABLED_SUBJECT_PREFIX = "revocation:subject-disabled:";
const SESSION_CUTOFF_PREFIX = "revocation:session-cutoff:";
const RATE_LIMIT_CUTOVERS_KEY = "rate-limit-v2-cutovers";
const REVOKED_SESSION_BINDING_PREFIX = "revocation:session-binding:";
const MAX_LEASE_AGE_MS = 20 * 60_000;
const RECOVERY_RETRY_MS = 60_000;
const MAX_ACTIVE_LEASES = 2_048;
const MAX_SETTLED_REQUEST_IDS = 2_048;
const RATE_LIMIT_OPERATION_VALIDITY_MS = 3_000;
// Both internal attempts finish within three seconds. Retaining every receipt
// for ten seconds covers all retryable in-flight operations without imposing a
// concurrency-sensitive FIFO cap; the next request prunes expired receipts.
const RATE_LIMIT_RECEIPT_TTL_MS = 10_000;
const MAX_ALARM_LEASE_MUTATIONS = 32;
const MAX_RECOVERY_CONTEXT_BYTES = 32_768;
// 512 KiB fits only because this class is SQLite-backed (wrangler migration
// `new_sqlite_classes`, 2 MB per-value limit). The legacy KV backend caps
// values at 128 KiB, which a full 2,048-lease ledger can exceed — revisit
// this bound if the DO migration type ever changes.
const MAX_LEDGER_VALUE_BYTES = 512 * 1_024;
const MAX_LEASE_VALUE_BYTES = 64 * 1_024;
const RATE_LIMIT_ENDPOINTS = new Set([
  "completions",
  "embeddings",
  "standard",
  "strict",
]);
const APP_REVIEW_STATUSES = new Set([
  "draft",
  "submitted",
  "under_review",
  "approved",
  "rejected",
]);
const SUBJECT_DISABLE_REASONS: readonly SubjectDisableReason[] = [
  "account",
  "moderation",
  "membership",
];

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validTrimmedId(value: unknown): value is string {
  return validId(value) && value.trim() === value;
}

function revocationStorageKey(prefix: string, id: string): string {
  return `${prefix}${encodeURIComponent(id)}`;
}

function subjectRevocationStorageKey(
  userId: string,
  reason: SubjectDisableReason,
): string {
  return `${revocationStorageKey(DISABLED_SUBJECT_PREFIX, userId)}:${reason}`;
}

function sessionBindingStorageKey(
  userId: string,
  stewardUserId: string,
): string {
  return `${revocationStorageKey(REVOKED_SESSION_BINDING_PREFIX, userId)}:${encodeURIComponent(stewardUserId)}`;
}

function validRecoveryContext(
  value: unknown,
  requestId: string,
  organizationId: string,
): value is InferenceAdmissionRecoveryContext {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.kind !== "organization" && record.kind !== "app") ||
    record.requestId !== requestId ||
    record.organizationId !== organizationId ||
    !validId(record.userId) ||
    !validId(record.model) ||
    !validId(record.provider) ||
    !validId(record.billingSource) ||
    !validId(record.description)
  ) {
    return false;
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_RECOVERY_CONTEXT_BYTES
    ) {
      return false;
    }
  } catch {
    return false;
  }
  if (record.kind === "organization") {
    const accounting = record.accounting;
    if (!accounting || typeof accounting !== "object") return false;
    const lane = accounting as Record<string, unknown>;
    if (lane.kind === "direct_debit") {
      return Object.keys(lane).length === 1;
    }
    return (
      lane.kind === "affiliate_debit" &&
      isAffiliateBillingAttribution(lane.attribution) &&
      lane.attribution.affiliateUserId !== record.userId &&
      validTrimmedId(lane.payoutSourceId)
    );
  }
  const appPolicy = record.appPolicy;
  return (
    validId(record.appId) &&
    nonNegativeFinite(record.estimatedBaseCostUsd) &&
    appPolicy !== null &&
    typeof appPolicy === "object" &&
    validAppPolicy(appPolicy as Record<string, unknown>)
  );
}

function validOptionalPolicyNumber(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function validAppPolicy(policy: Record<string, unknown>): boolean {
  return (
    validId(policy.name) &&
    validId(policy.creatorUserId) &&
    typeof policy.monetizationEnabled === "boolean" &&
    typeof policy.reviewStatus === "string" &&
    APP_REVIEW_STATUSES.has(policy.reviewStatus) &&
    validOptionalPolicyNumber(policy.platformOffsetAmount) &&
    validOptionalPolicyNumber(policy.purchaseSharePercentage) &&
    validOptionalPolicyNumber(policy.inferenceMarkupPercentage)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      // Code-unit order, not localeCompare: ICU collation is locale-dependent, so
      // the admission recovery contract must not serialize differently per host.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Inference admission recovery must contain JSON values");
  }
  return serialized;
}

function balanceRevision(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function jsonError(message: string, status: 400 | 409 | 503): Response {
  return Response.json({ success: false, error: message }, { status });
}

function cloneLedger(ledger: GateLedger): GateLedger {
  return {
    balanceRevision: ledger.balanceRevision,
    balanceCeilingUsd: ledger.balanceCeilingUsd,
    availableUsd: ledger.availableUsd,
    uncollectedDebtUsd: ledger.uncollectedDebtUsd,
    activeLeaseCount: ledger.activeLeaseCount,
    activeEstimateUsd: ledger.activeEstimateUsd,
    nextAlarmAt: ledger.nextAlarmAt,
    settledRequestIds: [...ledger.settledRequestIds],
  };
}

function cloneRateLimitWindows(windows: RateLimitWindows): RateLimitWindows {
  return Object.fromEntries(
    Object.entries(windows).map(([endpointType, window]) => [
      endpointType,
      {
        ...window,
        ...(window.receipts && {
          receipts: window.receipts.map((receipt) => ({
            ...receipt,
            decision: { ...receipt.decision },
          })),
        }),
      },
    ]),
  );
}

function rememberSettledRequest(ledger: GateLedger, requestId: string): void {
  ledger.settledRequestIds.push(requestId);
  if (ledger.settledRequestIds.length > MAX_SETTLED_REQUEST_IDS) {
    ledger.settledRequestIds.splice(
      0,
      ledger.settledRequestIds.length - MAX_SETTLED_REQUEST_IDS,
    );
  }
}

function recomputeAvailable(ledger: GateLedger): void {
  ledger.availableUsd = Math.max(
    0,
    ledger.balanceCeilingUsd -
      ledger.activeEstimateUsd -
      ledger.uncollectedDebtUsd,
  );
}

function removeActiveLease(ledger: GateLedger, lease: ActiveLeaseTiming): void {
  if (
    ledger.activeLeaseCount <= 0 ||
    ledger.activeEstimateUsd + 0.0000001 < lease.estimatedCostUsd
  ) {
    throw new Error("Inference admission lease summary is inconsistent");
  }
  ledger.activeLeaseCount--;
  ledger.activeEstimateUsd = Math.max(
    0,
    ledger.activeEstimateUsd - lease.estimatedCostUsd,
  );
  if (ledger.activeLeaseCount === 0) {
    ledger.nextAlarmAt = null;
  }
}

function applyBalanceSnapshot(
  ledger: GateLedger,
  balanceUsd: number,
  revision: string,
): void {
  const incomingRevision = balanceRevision(revision);
  const currentRevision = balanceRevision(ledger.balanceRevision);
  if (incomingRevision === null || currentRevision === null) {
    throw new Error("Inference admission balance revision is invalid");
  }
  if (incomingRevision > currentRevision) {
    ledger.balanceRevision = revision;
    ledger.balanceCeilingUsd = balanceUsd;
    recomputeAvailable(ledger);
    return;
  }
  if (incomingRevision === currentRevision) {
    ledger.balanceCeilingUsd = Math.min(ledger.balanceCeilingUsd, balanceUsd);
    ledger.availableUsd = Math.min(
      ledger.availableUsd,
      Math.max(
        0,
        ledger.balanceCeilingUsd -
          ledger.activeEstimateUsd -
          ledger.uncollectedDebtUsd,
      ),
    );
  }
}

function utf8JsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function leaseStorageKey(requestId: string): string {
  return `${LEASE_KEY_PREFIX}${encodeURIComponent(requestId)}`;
}

function leaseActiveStorageKey(requestId: string): string {
  return `${LEASE_ACTIVE_KEY_PREFIX}${encodeURIComponent(requestId)}`;
}

function leaseDueAt(lease: ActiveLeaseTiming): number {
  return lease.phase === "recovering"
    ? (lease.recoveryStartedAt ?? lease.expiresAt) + RECOVERY_RETRY_MS
    : lease.expiresAt;
}

function leaseExpiryStorageKey(
  requestId: string,
  lease: ActiveLeaseTiming,
): string {
  return leaseExpiryStorageKeyAt(requestId, leaseDueAt(lease));
}

function leaseExpiryStorageKeyAt(
  requestId: string,
  scheduledAt: number,
): string {
  const dueAt = Math.trunc(scheduledAt);
  return `${LEASE_EXPIRY_KEY_PREFIX}${String(dueAt).padStart(16, "0")}:${encodeURIComponent(requestId)}`;
}

function leaseExpiryIndex(
  requestId: string,
  lease: ActiveLeaseTiming,
): LeaseExpiryIndex {
  return {
    requestId,
    createdAt: lease.createdAt,
    dueAt: leaseDueAt(lease),
  };
}

interface LeaseStorageMutation {
  put?: Array<{ requestId: string; lease: ActiveLease }>;
  delete?: Array<{ requestId: string; lease: ActiveLeaseTiming }>;
}

export class InferenceAdmissionGate {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private ledger: GateLedger | undefined;
  private rateLimitWindows: RateLimitWindows | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  // Credential decisions and lifecycle fences must remain ordered with each
  // other, but may not wait behind slower billing lease or settlement work.
  private revocationOperationQueue: Promise<void> = Promise.resolve();
  // This queue orders calls within a rate-only identity. Cross-lane isolation
  // comes from the distinct Durable Object identity selected by the caller.
  private rateLimitOperationQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: AppEnv["Bindings"]) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<GateLedger | undefined> {
    this.ledger ??= await this.state.storage.get<GateLedger>(LEDGER_KEY);
    if (
      this.ledger &&
      (!nonNegativeFinite(this.ledger.balanceCeilingUsd) ||
        !nonNegativeFinite(this.ledger.availableUsd) ||
        !nonNegativeFinite(this.ledger.uncollectedDebtUsd) ||
        balanceRevision(this.ledger.balanceRevision) === null ||
        !Number.isSafeInteger(this.ledger.activeLeaseCount) ||
        this.ledger.activeLeaseCount < 0 ||
        this.ledger.activeLeaseCount > MAX_ACTIVE_LEASES ||
        !nonNegativeFinite(this.ledger.activeEstimateUsd) ||
        (this.ledger.nextAlarmAt !== null &&
          (!Number.isSafeInteger(this.ledger.nextAlarmAt) ||
            this.ledger.nextAlarmAt <= 0)) ||
        !Array.isArray(this.ledger.settledRequestIds) ||
        this.ledger.settledRequestIds.length > MAX_SETTLED_REQUEST_IDS ||
        this.ledger.settledRequestIds.some(
          (requestId) => !validRequestId(requestId),
        ))
    ) {
      throw new Error("Inference admission ledger is corrupt");
    }
    return this.ledger;
  }

  private async loadLease(requestId: string): Promise<ActiveLease | undefined> {
    const [lease, activeIndex] = await Promise.all([
      this.state.storage.get<ActiveLease>(leaseStorageKey(requestId)),
      this.state.storage.get<LeaseExpiryIndex>(
        leaseActiveStorageKey(requestId),
      ),
    ]);
    if (!lease && !activeIndex) return undefined;
    if (!lease || !activeIndex) {
      throw new Error(
        `Inference admission lease presence index is corrupt for ${requestId}`,
      );
    }
    const recoveryOrganizationId =
      lease.recovery &&
      typeof lease.recovery === "object" &&
      "organizationId" in lease.recovery
        ? lease.recovery.organizationId
        : undefined;
    if (
      !nonNegativeFinite(lease.estimatedCostUsd) ||
      lease.estimatedCostUsd === 0 ||
      !Number.isSafeInteger(lease.createdAt) ||
      lease.createdAt <= 0 ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= 0 ||
      !["leased", "dispatched", "recovering"].includes(lease.phase) ||
      (lease.preProviderCancellationToken !== undefined &&
        !validTrimmedId(lease.preProviderCancellationToken)) ||
      (lease.phase === "recovering" &&
        (!Number.isSafeInteger(lease.recoveryStartedAt) ||
          (lease.recoveryStartedAt ?? 0) <= 0)) ||
      !validId(recoveryOrganizationId) ||
      !validRecoveryContext(
        lease.recovery,
        requestId,
        recoveryOrganizationId,
      ) ||
      activeIndex.requestId !== requestId ||
      activeIndex.createdAt !== lease.createdAt ||
      activeIndex.dueAt !== leaseDueAt(lease) ||
      utf8JsonSize(lease) > MAX_LEASE_VALUE_BYTES
    ) {
      throw new Error(
        `Inference admission lease storage is corrupt for ${requestId}`,
      );
    }
    return lease;
  }

  private async save(
    ledger: GateLedger,
    mutation: LeaseStorageMutation = {},
  ): Promise<void> {
    const snapshot = cloneLedger(ledger);
    if (snapshot.activeLeaseCount === 0) {
      snapshot.activeEstimateUsd = 0;
      snapshot.nextAlarmAt = null;
    } else if (snapshot.nextAlarmAt === null) {
      throw new Error(
        "Inference admission ledger has active leases without an alarm",
      );
    }
    if (utf8JsonSize(snapshot) > MAX_LEDGER_VALUE_BYTES) {
      throw new Error("Inference admission ledger exceeds its storage budget");
    }
    for (const entry of mutation.put ?? []) {
      if (utf8JsonSize(entry.lease) > MAX_LEASE_VALUE_BYTES) {
        throw new Error(
          `Inference admission lease exceeds its storage budget for ${entry.requestId}`,
        );
      }
    }
    const scheduledAlarm =
      snapshot.nextAlarmAt === null
        ? null
        : Math.max(Date.now() + 1_000, snapshot.nextAlarmAt);
    // A dispatched lease without an alarm could escape recovery after an
    // acknowledgement loss. Durable Object transactions make the ledger and
    // its alarm one commit, including injected storage/commit failures.
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(LEDGER_KEY, snapshot);
      for (const entry of mutation.delete ?? []) {
        await transaction.delete(leaseStorageKey(entry.requestId));
        await transaction.delete(leaseActiveStorageKey(entry.requestId));
        await transaction.delete(
          leaseExpiryStorageKey(entry.requestId, entry.lease),
        );
      }
      for (const entry of mutation.put ?? []) {
        await transaction.put(
          leaseStorageKey(entry.requestId),
          structuredClone(entry.lease),
        );
        await transaction.put(
          leaseActiveStorageKey(entry.requestId),
          leaseExpiryIndex(entry.requestId, entry.lease),
        );
        await transaction.put(
          leaseExpiryStorageKey(entry.requestId, entry.lease),
          leaseExpiryIndex(entry.requestId, entry.lease),
        );
      }
      if (scheduledAlarm === null) {
        await transaction.deleteAlarm();
      } else {
        await transaction.setAlarm(scheduledAlarm);
      }
    });
    this.ledger = snapshot;
  }

  private loadRateLimitWindows(): RateLimitWindows {
    // This namespace is SQLite-backed in every deployed environment. Its
    // synchronous KV facade reads the same hidden __cf_kv table as the legacy
    // async API, but does not yield the object input gate for a local counter
    // read. The async read/write pair previously made this tiny rate-only
    // object vulnerable to storage-tail latency and caller aborts even though
    // it performs no network or database I/O.
    this.rateLimitWindows ??=
      this.state.storage.kv.get<RateLimitWindows>(RATE_LIMITS_KEY) ?? {};
    return this.rateLimitWindows;
  }

  private saveRateLimitWindows(windows: RateLimitWindows): void {
    const snapshot = cloneRateLimitWindows(windows);
    // Synchronous SQLite storage remains strongly consistent and durable. It
    // also preserves the exact legacy key, so an immediate Worker rollback
    // observes the current counter instead of opening a duplicate quota lane.
    this.state.storage.kv.put(RATE_LIMITS_KEY, snapshot);
    this.rateLimitWindows = snapshot;
  }

  private async rateLimitCutover(
    request: RateLimitCutoverRequest,
  ): Promise<Response> {
    if (!Number.isSafeInteger(request.windowMs) || request.windowMs <= 0) {
      return jsonError("Invalid inference rate-limit cutover window", 400);
    }
    const key = String(request.windowMs);
    const cutovers =
      (await this.state.storage.get<Record<string, number>>(
        RATE_LIMIT_CUTOVERS_KEY,
      )) ?? {};
    const existing = cutovers[key];
    if (existing !== undefined) {
      if (
        !Number.isSafeInteger(existing) ||
        existing <= 0 ||
        existing % request.windowMs !== 0
      ) {
        throw new Error("Inference rate-limit cutover is corrupt");
      }
      return Response.json({ cutoverAt: existing });
    }
    const now = Date.now();
    const cutoverAt =
      (Math.floor(now / request.windowMs) + 1) * request.windowMs;
    if (!Number.isSafeInteger(cutoverAt)) {
      return jsonError("Invalid inference rate-limit cutover window", 400);
    }
    await this.state.storage.put(RATE_LIMIT_CUTOVERS_KEY, {
      ...cutovers,
      [key]: cutoverAt,
    });
    return Response.json({ cutoverAt });
  }

  protected async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  protected async serializeRevocation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.revocationOperationQueue;
    let release: () => void = () => undefined;
    this.revocationOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async serializeRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.rateLimitOperationQueue;
    let release: () => void = () => undefined;
    this.rateLimitOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async lease(
    request: LeaseRequest,
    preProviderCancellationToken?: string,
  ): Promise<Response> {
    if (
      !validRequestId(request.requestId) ||
      !validId(request.organizationId) ||
      !nonNegativeFinite(request.balanceUsd) ||
      balanceRevision(request.balanceRevision) === null ||
      !nonNegativeFinite(request.estimatedCostUsd) ||
      request.estimatedCostUsd === 0 ||
      (preProviderCancellationToken !== undefined &&
        !validTrimmedId(preProviderCancellationToken)) ||
      !validRecoveryContext(
        request.recovery,
        request.requestId,
        request.organizationId,
      )
    ) {
      return jsonError("Invalid inference admission lease", 400);
    }

    const existing = await this.load();
    if (!existing) {
      return Response.json(
        {
          success: false,
          code: "inference_admission_gate_uninitialized",
          error: "Inference admission gate is warming",
        },
        { status: 503 },
      );
    }
    const ledger = cloneLedger(existing);
    applyBalanceSnapshot(ledger, request.balanceUsd, request.balanceRevision);

    const prior = await this.loadLease(request.requestId);
    if (prior) {
      if (
        ledger.activeLeaseCount === 0 ||
        ledger.settledRequestIds.includes(request.requestId)
      ) {
        throw new Error(
          `Inference admission lease summary is corrupt for ${request.requestId}`,
        );
      }
      if (
        prior.estimatedCostUsd !== request.estimatedCostUsd ||
        canonicalJson(prior.recovery) !== canonicalJson(request.recovery)
      ) {
        await this.save(ledger);
        return jsonError(
          "Request ID already holds a different inference admission lease",
          409,
        );
      }
      if (preProviderCancellationToken !== undefined) {
        if (prior.phase === "recovering") {
          return jsonError(
            "Inference admission lease recovery is in progress",
            409,
          );
        }
        if (
          prior.phase === "dispatched" &&
          prior.preProviderCancellationToken !== preProviderCancellationToken
        ) {
          return jsonError(
            "Inference admission dispatch capability does not match",
            409,
          );
        }
        const dispatched: ActiveLease = {
          ...prior,
          phase: "dispatched",
          preProviderCancellationToken,
          expiresAt: Date.now() + MAX_LEASE_AGE_MS,
        };
        await this.save(ledger, {
          delete: [{ requestId: request.requestId, lease: prior }],
          put: [{ requestId: request.requestId, lease: dispatched }],
        });
        return Response.json({
          admitted: true,
          dispatched: true,
          duplicate: prior.phase === "dispatched",
          availableUsd: ledger.availableUsd,
          requiredUsd: request.estimatedCostUsd,
        });
      }
      await this.save(ledger);
      return Response.json({
        admitted: true,
        availableUsd: ledger.availableUsd,
        requiredUsd: request.estimatedCostUsd,
      });
    }
    if (ledger.settledRequestIds.includes(request.requestId)) {
      await this.save(ledger);
      return jsonError("Request ID was already settled", 409);
    }
    if (ledger.activeLeaseCount >= MAX_ACTIVE_LEASES) {
      await this.save(ledger);
      return jsonError("Inference admission gate capacity is exhausted", 503);
    }

    if (ledger.availableUsd < request.estimatedCostUsd) {
      await this.save(ledger);
      return Response.json(
        {
          admitted: false,
          availableUsd: ledger.availableUsd,
          requiredUsd: request.estimatedCostUsd,
        },
        { status: 402 },
      );
    }

    ledger.availableUsd -= request.estimatedCostUsd;
    const now = Date.now();
    const activeLease: ActiveLease = {
      estimatedCostUsd: request.estimatedCostUsd,
      createdAt: now,
      expiresAt: now + MAX_LEASE_AGE_MS,
      phase:
        preProviderCancellationToken === undefined ? "leased" : "dispatched",
      ...(preProviderCancellationToken !== undefined && {
        preProviderCancellationToken,
      }),
      recovery: structuredClone(request.recovery),
    };
    ledger.activeLeaseCount++;
    ledger.activeEstimateUsd += request.estimatedCostUsd;
    ledger.nextAlarmAt =
      ledger.nextAlarmAt === null
        ? leaseDueAt(activeLease)
        : Math.min(ledger.nextAlarmAt, leaseDueAt(activeLease));
    await this.save(ledger, {
      put: [{ requestId: request.requestId, lease: activeLease }],
    });
    return Response.json({
      admitted: true,
      ...(preProviderCancellationToken !== undefined && { dispatched: true }),
      availableUsd: ledger.availableUsd,
      requiredUsd: request.estimatedCostUsd,
    });
  }

  private async authorizedLease(
    request: AuthorizedLeaseRequest,
    preProviderCancellationToken?: string,
  ): Promise<Response> {
    if (
      !request.credential ||
      request.credential.organizationId !== request.organizationId
    ) {
      return jsonError("Invalid authorized inference admission lease", 400);
    }
    const denial = await this.credentialDenial(request.credential);
    if (denial) return denial;
    return await this.lease(request, preProviderCancellationToken);
  }

  private async hydrate(request: HydrateRequest): Promise<Response> {
    if (
      !nonNegativeFinite(request.balanceUsd) ||
      balanceRevision(request.balanceRevision) === null
    ) {
      return jsonError("Invalid inference admission hydration", 400);
    }
    const existing = await this.load();
    if (!existing) {
      await this.save({
        balanceRevision: request.balanceRevision,
        balanceCeilingUsd: request.balanceUsd,
        availableUsd: request.balanceUsd,
        uncollectedDebtUsd: 0,
        activeLeaseCount: 0,
        activeEstimateUsd: 0,
        nextAlarmAt: null,
        settledRequestIds: [],
      });
      return Response.json({ hydrated: true, initialized: true });
    }
    const ledger = cloneLedger(existing);
    applyBalanceSnapshot(ledger, request.balanceUsd, request.balanceRevision);
    await this.save(ledger);
    return Response.json({ hydrated: true, initialized: false });
  }

  private async settle(request: SettleRequest): Promise<Response> {
    if (
      !validRequestId(request.requestId) ||
      !nonNegativeFinite(request.balanceBackedUsd) ||
      !nonNegativeFinite(request.gateConsumedUsd) ||
      request.gateConsumedUsd < request.balanceBackedUsd ||
      !nonNegativeFinite(request.balanceUsd) ||
      balanceRevision(request.balanceRevision) === null
    ) {
      return jsonError("Invalid inference admission settlement", 400);
    }
    const existing = await this.load();
    if (!existing) {
      return jsonError("Inference admission ledger is unavailable", 503);
    }
    if (existing.settledRequestIds.includes(request.requestId)) {
      return Response.json({ settled: true, duplicate: true });
    }
    const ledger = cloneLedger(existing);
    const lease = await this.loadLease(request.requestId);
    if (!lease) {
      return jsonError("Inference admission lease was not found", 409);
    }
    if (lease.phase !== "dispatched") {
      return jsonError(
        lease.phase === "recovering"
          ? "Inference admission lease recovery is in progress"
          : "Inference admission lease was not dispatched to a provider",
        409,
      );
    }

    removeActiveLease(ledger, lease);
    ledger.uncollectedDebtUsd +=
      request.gateConsumedUsd - request.balanceBackedUsd;
    applyBalanceSnapshot(ledger, request.balanceUsd, request.balanceRevision);
    recomputeAvailable(ledger);
    rememberSettledRequest(ledger, request.requestId);
    await this.save(ledger, {
      delete: [{ requestId: request.requestId, lease }],
    });
    return Response.json({ settled: true, duplicate: false });
  }

  private async dispatch(request: LeaseIdentityRequest): Promise<Response> {
    if (
      !validRequestId(request.requestId) ||
      (request.preProviderCancellationToken !== undefined &&
        !validTrimmedId(request.preProviderCancellationToken))
    ) {
      return jsonError("Invalid inference admission dispatch", 400);
    }
    const existing = await this.load();
    if (!existing) {
      return jsonError("Inference admission ledger is unavailable", 503);
    }
    if (existing.settledRequestIds.includes(request.requestId)) {
      return jsonError("Request ID was already settled", 409);
    }
    const ledger = cloneLedger(existing);
    const lease = await this.loadLease(request.requestId);
    if (!lease) {
      return jsonError("Inference admission lease was not found", 409);
    }
    if (lease.phase === "recovering") {
      return jsonError(
        "Inference admission lease recovery is in progress",
        409,
      );
    }
    if (lease.phase === "dispatched") {
      if (
        lease.preProviderCancellationToken !==
        request.preProviderCancellationToken
      ) {
        return jsonError(
          "Inference admission dispatch capability does not match",
          409,
        );
      }
      // Duplicate dispatch is the acknowledgement-loss healing path. Refresh
      // both the recovery deadline and its alarm in the same durable commit.
      const refreshed: ActiveLease = {
        ...lease,
        expiresAt: Date.now() + MAX_LEASE_AGE_MS,
      };
      await this.save(ledger, {
        delete: [{ requestId: request.requestId, lease }],
        put: [{ requestId: request.requestId, lease: refreshed }],
      });
      return Response.json({ dispatched: true, duplicate: true });
    }
    const dispatched: ActiveLease = {
      ...lease,
      phase: "dispatched",
      preProviderCancellationToken: request.preProviderCancellationToken,
      expiresAt: Date.now() + MAX_LEASE_AGE_MS,
    };
    await this.save(ledger, {
      delete: [{ requestId: request.requestId, lease }],
      put: [{ requestId: request.requestId, lease: dispatched }],
    });
    return Response.json({ dispatched: true, duplicate: false });
  }

  /**
   * Widen a dispatched lease to the known post-provider cost before any money
   * mutation starts. This transition never shrinks and never rejects for lack
   * of available balance: the provider work already happened, so its job is to
   * make every subsequent admission account for the full known exposure.
   */
  private async settlementFence(
    request: SettlementFenceRequest,
  ): Promise<Response> {
    if (
      !validRequestId(request.requestId) ||
      !nonNegativeFinite(request.estimatedCostUsd) ||
      request.estimatedCostUsd === 0
    ) {
      return jsonError("Invalid inference admission settlement fence", 400);
    }
    const existing = await this.load();
    if (!existing) {
      return jsonError("Inference admission ledger is unavailable", 503);
    }
    if (existing.settledRequestIds.includes(request.requestId)) {
      return jsonError("Request ID was already settled", 409);
    }
    const ledger = cloneLedger(existing);
    const lease = await this.loadLease(request.requestId);
    if (!lease) {
      return jsonError("Inference admission lease was not found", 409);
    }
    if (lease.phase !== "dispatched") {
      return jsonError(
        lease.phase === "recovering"
          ? "Inference admission lease recovery is in progress"
          : "Inference admission lease was not dispatched to a provider",
        409,
      );
    }
    if (
      ledger.activeLeaseCount <= 0 ||
      ledger.activeEstimateUsd + 0.0000001 < lease.estimatedCostUsd
    ) {
      throw new Error("Inference admission lease summary is inconsistent");
    }

    const fencedEstimateUsd = Math.max(
      lease.estimatedCostUsd,
      request.estimatedCostUsd,
    );
    if (fencedEstimateUsd === lease.estimatedCostUsd) {
      return Response.json({
        settlementFenced: true,
        estimatedCostUsd: lease.estimatedCostUsd,
        duplicate: true,
      });
    }
    const activeEstimateUsd =
      ledger.activeEstimateUsd + (fencedEstimateUsd - lease.estimatedCostUsd);
    if (!nonNegativeFinite(activeEstimateUsd)) {
      throw new Error(
        "Inference admission settlement fence exceeds the ledger budget",
      );
    }
    ledger.activeEstimateUsd = activeEstimateUsd;
    recomputeAvailable(ledger);
    const fencedLease: ActiveLease = {
      ...lease,
      estimatedCostUsd: fencedEstimateUsd,
    };
    await this.save(ledger, {
      delete: [{ requestId: request.requestId, lease }],
      put: [{ requestId: request.requestId, lease: fencedLease }],
    });
    return Response.json({
      settlementFenced: true,
      estimatedCostUsd: fencedEstimateUsd,
      duplicate: false,
    });
  }

  private async release(request: LeaseIdentityRequest): Promise<Response> {
    if (
      !validRequestId(request.requestId) ||
      (request.preProviderCancellationToken !== undefined &&
        !validTrimmedId(request.preProviderCancellationToken))
    ) {
      return jsonError("Invalid inference admission release", 400);
    }
    const existing = await this.load();
    if (!existing) {
      return jsonError("Inference admission ledger is unavailable", 503);
    }
    if (existing.settledRequestIds.includes(request.requestId)) {
      return Response.json({ released: true, duplicate: true });
    }
    const ledger = cloneLedger(existing);
    const lease = await this.loadLease(request.requestId);
    if (!lease) {
      return Response.json(
        {
          success: false,
          code: "inference_admission_lease_not_found",
          error: "Inference admission lease was not found",
        },
        { status: 409 },
      );
    }
    if (lease.phase === "recovering") {
      return jsonError(
        "Inference admission lease recovery is in progress",
        409,
      );
    }
    if (
      lease.phase === "dispatched" &&
      (!request.preProviderCancellationToken ||
        lease.preProviderCancellationToken !==
          request.preProviderCancellationToken)
    ) {
      return jsonError(
        "Dispatched inference work requires authoritative settlement",
        409,
      );
    }
    removeActiveLease(ledger, lease);
    recomputeAvailable(ledger);
    rememberSettledRequest(ledger, request.requestId);
    await this.save(ledger, {
      delete: [{ requestId: request.requestId, lease }],
    });
    return Response.json({ released: true, duplicate: false });
  }

  private async rateLimit(request: RateLimitRequest): Promise<Response> {
    if (
      (request.operationId === undefined) !==
        (request.operationDeadlineAt === undefined) ||
      (request.operationId !== undefined &&
        (!validTrimmedId(request.operationId) ||
          request.operationId.length > 128)) ||
      (request.operationDeadlineAt !== undefined &&
        (!Number.isSafeInteger(request.operationDeadlineAt) ||
          request.operationDeadlineAt <= 0)) ||
      !RATE_LIMIT_ENDPOINTS.has(request.endpointType) ||
      !Number.isSafeInteger(request.windowMs) ||
      request.windowMs <= 0 ||
      !Number.isSafeInteger(request.maxRequests) ||
      request.maxRequests <= 0
    ) {
      return jsonError("Invalid inference rate-limit request", 400);
    }
    const now = Date.now();
    const currentWindowStartedAt =
      Math.floor(now / request.windowMs) * request.windowMs;
    if (
      request.windowStartedAt !== undefined &&
      (!Number.isSafeInteger(request.windowStartedAt) ||
        request.windowStartedAt < 0 ||
        request.windowStartedAt % request.windowMs !== 0 ||
        request.windowStartedAt > currentWindowStartedAt)
    ) {
      return jsonError("Invalid inference rate-limit request", 400);
    }

    const windowStartedAt = request.windowStartedAt ?? currentWindowStartedAt;
    const windows = cloneRateLimitWindows(this.loadRateLimitWindows());
    const existing = windows[request.endpointType];
    const activeReceipts =
      existing?.receipts?.filter((candidate) => candidate.expiresAt > now) ??
      [];
    const receipt = request.operationId
      ? activeReceipts.find(
          (candidate) => candidate.operationId === request.operationId,
        )
      : undefined;
    if (receipt) {
      if (
        receipt.operationDeadlineAt !== request.operationDeadlineAt ||
        receipt.windowStartedAt !== windowStartedAt ||
        receipt.windowMs !== request.windowMs ||
        receipt.maxRequests !== request.maxRequests
      ) {
        return jsonError(
          "Inference rate-limit operation was reused with a different policy",
          409,
        );
      }
      return Response.json(receipt.decision, {
        status: receipt.decision.allowed ? 200 : 429,
      });
    }
    if (
      request.operationDeadlineAt !== undefined &&
      (request.operationDeadlineAt <= now ||
        request.operationDeadlineAt > now + RATE_LIMIT_OPERATION_VALIDITY_MS)
    ) {
      return Response.json(
        {
          success: false,
          code: "inference_rate_limit_operation_expired",
          error:
            "Inference rate-limit operation is outside its validity window",
        },
        { status: 409 },
      );
    }
    if (existing && existing.windowStartedAt > windowStartedAt) {
      const resetAt = existing.windowStartedAt + existing.windowMs;
      return Response.json(
        {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
        },
        { status: 429 },
      );
    }
    const current =
      existing &&
      existing.windowStartedAt === windowStartedAt &&
      existing.windowMs === request.windowMs
        ? {
            windowStartedAt: existing.windowStartedAt,
            windowMs: existing.windowMs,
            maxRequests: request.maxRequests,
            count: existing.count,
            ...(activeReceipts.length > 0 && { receipts: activeReceipts }),
          }
        : {
            windowStartedAt,
            windowMs: request.windowMs,
            maxRequests: request.maxRequests,
            count: 0,
            ...(activeReceipts.length > 0 && { receipts: activeReceipts }),
          };
    current.count = Math.min(current.count + 1, Number.MAX_SAFE_INTEGER);
    const allowed = current.count <= request.maxRequests;
    const resetAt = windowStartedAt + request.windowMs;
    const decision = {
      allowed,
      remaining: Math.max(0, request.maxRequests - current.count),
      resetAt,
      retryAfter: allowed
        ? undefined
        : Math.max(1, Math.ceil((resetAt - now) / 1_000)),
    };
    if (request.operationId && request.operationDeadlineAt !== undefined) {
      current.receipts ??= [];
      current.receipts.push({
        operationId: request.operationId,
        operationDeadlineAt: request.operationDeadlineAt,
        expiresAt: now + RATE_LIMIT_RECEIPT_TTL_MS,
        windowStartedAt,
        windowMs: request.windowMs,
        maxRequests: request.maxRequests,
        decision,
      });
    }
    windows[request.endpointType] = current;
    this.saveRateLimitWindows(windows);

    return Response.json(decision, { status: allowed ? 200 : 429 });
  }

  private async credentialDenial(
    request: CredentialCheckRequest,
  ): Promise<Response | null> {
    if (
      !validTrimmedId(request.organizationId) ||
      !validTrimmedId(request.userId) ||
      (request.kind === "api_key" && !validTrimmedId(request.credentialId)) ||
      (request.kind === "steward_session" &&
        (!validTrimmedId(request.stewardUserId) ||
          !Number.isSafeInteger(request.issuedAt) ||
          request.issuedAt <= 0))
    ) {
      return jsonError("Invalid inference credential check", 400);
    }

    const subjectKeys = SUBJECT_DISABLE_REASONS.map((reason) =>
      subjectRevocationStorageKey(request.userId, reason),
    );
    const credentialKeys =
      request.kind === "api_key"
        ? [revocationStorageKey(REVOKED_API_KEY_PREFIX, request.credentialId)]
        : [
            sessionBindingStorageKey(request.userId, request.stewardUserId),
            revocationStorageKey(SESSION_CUTOFF_PREFIX, request.userId),
          ];
    const revocations = await this.state.storage.get<boolean | number>([
      ORGANIZATION_DISABLED_KEY,
      ...subjectKeys,
      ...credentialKeys,
    ]);

    if (revocations.get(ORGANIZATION_DISABLED_KEY) === true) {
      return Response.json(
        { allowed: false, reason: "organization_disabled" },
        { status: 403 },
      );
    }
    for (const [index, reason] of SUBJECT_DISABLE_REASONS.entries()) {
      const key = subjectKeys[index];
      if (key && revocations.get(key) === true) {
        return Response.json(
          { allowed: false, reason: `subject_${reason}_disabled` },
          { status: 403 },
        );
      }
    }

    if (request.kind === "api_key") {
      const revoked = revocations.get(credentialKeys[0] ?? "") === true;
      return revoked
        ? Response.json(
            { allowed: false, reason: "credential_revoked" },
            { status: 403 },
          )
        : null;
    }

    if (revocations.get(credentialKeys[0] ?? "") === true) {
      return Response.json(
        { allowed: false, reason: "session_binding_revoked" },
        { status: 403 },
      );
    }

    const cutoffValue = revocations.get(credentialKeys[1] ?? "");
    const cutoff = typeof cutoffValue === "number" ? cutoffValue : undefined;
    return cutoff !== undefined && request.issuedAt <= cutoff
      ? Response.json(
          { allowed: false, reason: "session_revoked" },
          { status: 403 },
        )
      : null;
  }

  private async credentialCheck(
    request: CredentialCheckRequest,
  ): Promise<Response> {
    return (
      (await this.credentialDenial(request)) ?? Response.json({ allowed: true })
    );
  }

  private async revokeCredential(
    request: CredentialRevokeRequest,
  ): Promise<Response> {
    if (
      !validTrimmedId(request.organizationId) ||
      request.kind !== "api_key" ||
      !validTrimmedId(request.credentialId)
    ) {
      return jsonError("Invalid inference credential revocation", 400);
    }
    await this.state.storage.put(
      revocationStorageKey(REVOKED_API_KEY_PREFIX, request.credentialId),
      true,
    );
    return Response.json({ committed: true });
  }

  private async setSubjectActive(
    request: SubjectStateRequest,
  ): Promise<Response> {
    if (
      !validTrimmedId(request.organizationId) ||
      !validTrimmedId(request.userId) ||
      typeof request.active !== "boolean" ||
      !SUBJECT_DISABLE_REASONS.includes(request.reason)
    ) {
      return jsonError("Invalid inference subject state", 400);
    }
    const key = subjectRevocationStorageKey(request.userId, request.reason);
    if (request.active) await this.state.storage.delete(key);
    else await this.state.storage.put(key, true);
    return Response.json({ committed: true });
  }

  private async revokeSessionsThrough(
    request: SessionRevokeRequest,
  ): Promise<Response> {
    if (
      !validTrimmedId(request.organizationId) ||
      !validTrimmedId(request.userId) ||
      !Number.isSafeInteger(request.issuedAt) ||
      request.issuedAt <= 0
    ) {
      return jsonError("Invalid inference session revocation", 400);
    }
    const key = revocationStorageKey(SESSION_CUTOFF_PREFIX, request.userId);
    const previous = (await this.state.storage.get<number>(key)) ?? 0;
    await this.state.storage.put(key, Math.max(previous, request.issuedAt));
    return Response.json({ committed: true });
  }

  private async setSessionBindingActive(
    request: SessionBindingStateRequest,
  ): Promise<Response> {
    if (
      !validTrimmedId(request.organizationId) ||
      !validTrimmedId(request.userId) ||
      !validTrimmedId(request.stewardUserId) ||
      typeof request.active !== "boolean"
    ) {
      return jsonError("Invalid inference session binding revocation", 400);
    }
    const key = sessionBindingStorageKey(request.userId, request.stewardUserId);
    if (request.active) await this.state.storage.delete(key);
    else await this.state.storage.put(key, true);
    return Response.json({ committed: true });
  }

  private async setOrganizationActive(
    request: OrganizationStateRequest,
  ): Promise<Response> {
    if (
      !validTrimmedId(request.organizationId) ||
      typeof request.active !== "boolean"
    ) {
      return jsonError("Invalid inference organization state", 400);
    }
    if (request.active)
      await this.state.storage.delete(ORGANIZATION_DISABLED_KEY);
    else await this.state.storage.put(ORGANIZATION_DISABLED_KEY, true);
    return Response.json({ committed: true });
  }

  private async warmRateLimit(): Promise<Response> {
    this.loadRateLimitWindows();
    return Response.json({ warmed: true });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body:
      | LeaseRequest
      | AuthorizedLeaseRequest
      | LeaseDispatchRequest
      | AuthorizedLeaseDispatchRequest
      | HydrateRequest
      | SettleRequest
      | LeaseIdentityRequest
      | SettlementFenceRequest
      | RateLimitRequest
      | CredentialCheckRequest
      | CredentialRevokeRequest
      | SubjectStateRequest
      | SessionRevokeRequest
      | SessionBindingStateRequest
      | OrganizationStateRequest
      | RateLimitCutoverRequest;
    try {
      body = (await request.json()) as
        | LeaseRequest
        | AuthorizedLeaseRequest
        | LeaseDispatchRequest
        | AuthorizedLeaseDispatchRequest
        | HydrateRequest
        | SettleRequest
        | LeaseIdentityRequest
        | SettlementFenceRequest
        | RateLimitRequest
        | CredentialCheckRequest
        | CredentialRevokeRequest
        | SubjectStateRequest
        | SessionRevokeRequest
        | SessionBindingStateRequest
        | OrganizationStateRequest
        | RateLimitCutoverRequest;
    } catch {
      // error-policy:J3 malformed request bodies are rejected explicitly.
      return jsonError("Invalid JSON body", 400);
    }
    if (!body) return jsonError("Invalid JSON body", 400);
    const path = new URL(request.url).pathname;
    if (path === "/lease") {
      return await this.serialize(() => this.lease(body as LeaseRequest));
    }
    if (path === "/lease-authorized") {
      return await this.serializeRevocation(() =>
        this.serialize(() =>
          this.authorizedLease(body as AuthorizedLeaseRequest),
        ),
      );
    }
    if (path === "/lease-dispatched") {
      const dispatch = body as LeaseDispatchRequest;
      if (!validTrimmedId(dispatch.preProviderCancellationToken)) {
        return jsonError(
          "Invalid inference admission dispatch capability",
          400,
        );
      }
      return await this.serialize(() =>
        this.lease(dispatch, dispatch.preProviderCancellationToken),
      );
    }
    if (path === "/lease-dispatched-authorized") {
      const dispatch = body as AuthorizedLeaseDispatchRequest;
      if (!validTrimmedId(dispatch.preProviderCancellationToken)) {
        return jsonError(
          "Invalid inference admission dispatch capability",
          400,
        );
      }
      return await this.serializeRevocation(() =>
        this.serialize(() =>
          this.authorizedLease(dispatch, dispatch.preProviderCancellationToken),
        ),
      );
    }
    if (path === "/hydrate") {
      return await this.serialize(() => this.hydrate(body as HydrateRequest));
    }
    if (path === "/settle") {
      return await this.serialize(() => this.settle(body as SettleRequest));
    }
    if (path === "/dispatch") {
      return await this.serialize(() =>
        this.dispatch(body as LeaseIdentityRequest),
      );
    }
    if (path === "/settlement-fence") {
      return await this.serialize(() =>
        this.settlementFence(body as SettlementFenceRequest),
      );
    }
    if (path === "/release") {
      return await this.serialize(() =>
        this.release(body as LeaseIdentityRequest),
      );
    }
    if (path === "/rate-limit") {
      return await this.serializeRateLimit(() =>
        this.rateLimit(body as RateLimitRequest),
      );
    }
    if (path === "/rate-limit-warm") {
      return await this.serializeRateLimit(() => this.warmRateLimit());
    }
    if (path === "/rate-limit-v2-cutover") {
      return await this.serializeRateLimit(() =>
        this.rateLimitCutover(body as RateLimitCutoverRequest),
      );
    }
    if (path === "/credential/check") {
      return await this.serializeRevocation(() =>
        this.credentialCheck(body as CredentialCheckRequest),
      );
    }
    if (path === "/credential/revoke") {
      return await this.serializeRevocation(() =>
        this.revokeCredential(body as CredentialRevokeRequest),
      );
    }
    if (path === "/subject/set-active") {
      return await this.serializeRevocation(() =>
        this.setSubjectActive(body as SubjectStateRequest),
      );
    }
    if (path === "/session/revoke-through") {
      return await this.serializeRevocation(() =>
        this.revokeSessionsThrough(body as SessionRevokeRequest),
      );
    }
    if (path === "/session/set-binding-active") {
      return await this.serializeRevocation(() =>
        this.setSessionBindingActive(body as SessionBindingStateRequest),
      );
    }
    if (path === "/organization/set-active") {
      return await this.serializeRevocation(() =>
        this.setOrganizationActive(body as OrganizationStateRequest),
      );
    }
    return new Response("Not found", { status: 404 });
  }

  private async claimExpiredLeases(): Promise<
    Array<{ requestId: string; lease: ActiveLease }>
  > {
    const existing = await this.load();
    if (!existing) return [];
    const ledger = cloneLedger(existing);
    if (ledger.activeLeaseCount === 0) {
      if (ledger.nextAlarmAt !== null) {
        ledger.nextAlarmAt = null;
        await this.save(ledger);
      }
      return [];
    }

    const expiryEntries = [
      ...(await this.state.storage.list<LeaseExpiryIndex>({
        prefix: LEASE_EXPIRY_KEY_PREFIX,
        limit: MAX_ALARM_LEASE_MUTATIONS + 1,
      })),
    ];
    if (expiryEntries.length === 0) {
      throw new Error(
        "Inference admission ledger has active leases without an expiry index",
      );
    }
    const now = Date.now();
    for (const [key, index] of expiryEntries) {
      if (
        !validRequestId(index.requestId) ||
        !Number.isSafeInteger(index.createdAt) ||
        index.createdAt <= 0 ||
        !Number.isSafeInteger(index.dueAt) ||
        index.dueAt <= 0 ||
        key !== leaseExpiryStorageKeyAt(index.requestId, index.dueAt)
      ) {
        throw new Error("Inference admission lease expiry index is corrupt");
      }
    }
    const dueEntries = expiryEntries
      .filter(([, index]) => index.dueAt <= now)
      .slice(0, MAX_ALARM_LEASE_MUTATIONS);
    if (dueEntries.length === 0) {
      ledger.nextAlarmAt = expiryEntries[0]![1].dueAt;
      await this.save(ledger);
      return [];
    }

    const claimed: Array<{ requestId: string; lease: ActiveLease }> = [];
    const storageMutation: Required<LeaseStorageMutation> = {
      put: [],
      delete: [],
    };
    const replacementDueTimes: number[] = [];
    for (const [, index] of dueEntries) {
      const lease = await this.loadLease(index.requestId);
      if (!lease) {
        throw new Error(
          `Inference admission expiry index has no lease for ${index.requestId}`,
        );
      }
      if (
        lease.createdAt !== index.createdAt ||
        leaseDueAt(lease) !== index.dueAt
      ) {
        throw new Error(
          `Inference admission expiry index does not match lease ${index.requestId}`,
        );
      }
      storageMutation.delete.push({
        requestId: index.requestId,
        lease,
      });
      if (lease.phase === "leased") {
        removeActiveLease(ledger, lease);
        rememberSettledRequest(ledger, index.requestId);
        continue;
      }
      const recovering: ActiveLease = {
        ...lease,
        phase: "recovering",
        recoveryStartedAt: now,
      };
      claimed.push({
        requestId: index.requestId,
        lease: structuredClone(recovering),
      });
      storageMutation.put.push({
        requestId: index.requestId,
        lease: recovering,
      });
      replacementDueTimes.push(leaseDueAt(recovering));
    }

    recomputeAvailable(ledger);
    const firstUnprocessed = expiryEntries[dueEntries.length]?.[1].dueAt;
    const nextDueCandidates = [
      ...replacementDueTimes,
      ...(firstUnprocessed === undefined ? [] : [firstUnprocessed]),
    ];
    if (ledger.activeLeaseCount > 0 && nextDueCandidates.length === 0) {
      throw new Error(
        "Inference admission ledger count exceeds its expiry indexes",
      );
    }
    ledger.nextAlarmAt =
      ledger.activeLeaseCount === 0 ? null : Math.min(...nextDueCandidates);
    await this.save(ledger, storageMutation);
    return claimed;
  }

  private async applyRecoveredLease(
    requestId: string,
    expected: ActiveLease,
    recovery: InferenceAdmissionRecoveryResult,
  ): Promise<void> {
    const existing = await this.load();
    if (!existing) {
      throw new Error("Inference admission ledger disappeared during recovery");
    }
    const currentLease = await this.loadLease(requestId);
    if (!currentLease && existing.settledRequestIds.includes(requestId)) {
      return;
    }
    if (!currentLease) {
      throw new Error(
        `Inference admission recovery lease disappeared for ${requestId}`,
      );
    }
    if (
      currentLease.createdAt !== expected.createdAt ||
      currentLease.estimatedCostUsd !== expected.estimatedCostUsd ||
      currentLease.phase !== "recovering" ||
      currentLease.recoveryStartedAt !== expected.recoveryStartedAt
    ) {
      return;
    }
    if (
      !nonNegativeFinite(recovery.balanceUsd) ||
      balanceRevision(recovery.balanceRevision) === null ||
      !nonNegativeFinite(recovery.collectedUsd) ||
      !nonNegativeFinite(recovery.gateConsumedUsd) ||
      recovery.gateConsumedUsd < recovery.collectedUsd
    ) {
      throw new Error("Inference admission recovery result is invalid");
    }
    const ledger = cloneLedger(existing);
    removeActiveLease(ledger, currentLease);
    ledger.uncollectedDebtUsd +=
      recovery.gateConsumedUsd - recovery.collectedUsd;
    applyBalanceSnapshot(ledger, recovery.balanceUsd, recovery.balanceRevision);
    recomputeAvailable(ledger);
    rememberSettledRequest(ledger, requestId);
    await this.save(ledger, {
      delete: [{ requestId, lease: currentLease }],
    });
  }

  /**
   * Move the serialized balance authority before an alarm recovery publishes
   * the same snapshot to eventually-consistent KV. The recovering lease stays
   * active throughout this handoff.
   */
  private async fenceRecoveringLeaseBalance(
    requestId: string,
    expected: ActiveLease,
    balanceUsd: number,
    balanceRevision: string,
  ): Promise<void> {
    if (!nonNegativeFinite(balanceUsd)) {
      throw new Error("Inference admission recovery balance fence is invalid");
    }
    const existing = await this.load();
    if (!existing) {
      throw new Error(
        "Inference admission ledger disappeared during balance fencing",
      );
    }
    const currentLease = await this.loadLease(requestId);
    if (!currentLease && existing.settledRequestIds.includes(requestId)) {
      return;
    }
    if (
      !currentLease ||
      currentLease.createdAt !== expected.createdAt ||
      currentLease.estimatedCostUsd !== expected.estimatedCostUsd ||
      currentLease.phase !== "recovering" ||
      currentLease.recoveryStartedAt !== expected.recoveryStartedAt
    ) {
      throw new Error(
        `Inference admission recovery fence lost lease ${requestId}`,
      );
    }
    const ledger = cloneLedger(existing);
    applyBalanceSnapshot(ledger, balanceUsd, balanceRevision);
    await this.save(ledger);
  }

  async alarm(): Promise<void> {
    const expired = await this.serialize(() => this.claimExpiredLeases());
    if (expired.length === 0) return;
    const results = await Promise.allSettled(
      expired.map(async ({ requestId, lease }) => {
        // Recovery is alarm-only. Keep its database, pricing, and provider
        // dependencies out of Worker startup and ordinary admission requests.
        const [
          { runWithDbCacheAsync },
          { recoverExpiredInferenceAdmissionLease },
        ] = await Promise.all([
          import("@/db/client"),
          import("@/lib/services/inference-admission-recovery"),
        ]);
        const inferenceBalanceFence: InferenceBalanceFence = {
          // Alarm recovery charges the exact active estimate, so the existing
          // lease already fences this amount. The authoritative revision below
          // is the first DO update needed; KV still receives its lower-only
          // handoff before republication.
          lowerCommittedBalance: async () => undefined,
          publishAuthoritativeBalance: async (balanceUsd, balanceRevision) =>
            this.serialize(() =>
              this.fenceRecoveringLeaseBalance(
                requestId,
                lease,
                balanceUsd,
                balanceRevision,
              ),
            ),
        };
        const recovered = await runWithCloudBindingsAsync(
          this.env as Record<string, unknown>,
          () =>
            runWithDbCacheAsync(() =>
              recoverExpiredInferenceAdmissionLease(
                lease.recovery,
                lease.estimatedCostUsd,
                { inferenceBalanceFence },
              ),
            ),
        );
        await this.serialize(() =>
          this.applyRecoveredLease(requestId, lease, recovered),
        );
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      logger.error("[InferenceAdmissionGate] expired lease recovery failed", {
        failures: failures.length,
        errors: failures.map((failure) =>
          failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason),
        ),
      });
      // error-policy:J1 the Durable Object alarm is the platform retry
      // boundary. Throwing preserves Cloudflare's alarm retry signal; the
      // recovering leases and next alarm were persisted before recovery began.
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Inference admission lease recovery failed",
      );
    }
  }
}
