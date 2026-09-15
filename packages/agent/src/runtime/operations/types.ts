/**
 * RuntimeOperation contracts — the single model for any state-changing
 * lifecycle action against the live runtime (provider switch, plugin
 * enable/disable, config reload, full restart).
 *
 * Design invariants:
 *
 *   1. Single queue. One operation runs at a time. New requests while an op
 *      is running return 409 with the active op's id.
 *   2. Tiered execution. The use case classifies an intent into a reload
 *      tier (hot / warm / cold).
 *   3. Health-gated promotion. A new/re-initialised runtime only "wins"
 *      after health checks pass.
 *   4. Append-only phase log. Each phase mutation is a new entry — never
 *      patched in place (except `updateLastPhase`, for running→succeeded).
 *   5. Idempotency keys de-dupe retries within the retention window.
 */

import type { AgentRuntime } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Discriminated intent payloads
// ---------------------------------------------------------------------------

export interface ProviderSwitchIntent {
  kind: "provider-switch";
  provider: string;
  /**
   * Vault key that resolves to the provider's API key (e.g.
   * `"providers.openai.api-key"`). The actual secret never travels through
   * the intent — only this stable identifier — so persisted operation
   * records cannot leak credentials. Resolved at apply-env time via
   * `SecretsManager.get(apiKeyRef)`.
   */
  apiKeyRef?: string;
  primaryModel?: string;
}

export interface ConfigReloadIntent {
  kind: "config-reload";
  /**
   * Optional list of dotted config paths that changed. When present, the
   * classifier can choose hot/warm based on which keys moved.
   */
  changedPaths?: readonly string[];
}

export interface PluginEnableIntent {
  kind: "plugin-enable";
  pluginId: string;
}

export interface PluginDisableIntent {
  kind: "plugin-disable";
  pluginId: string;
}

export interface RestartIntent {
  kind: "restart";
  reason: string;
}

export type OperationIntent =
  | ProviderSwitchIntent
  | ConfigReloadIntent
  | PluginEnableIntent
  | PluginDisableIntent
  | RestartIntent;

export type OperationKind = OperationIntent["kind"];

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

/**
 * Reload tiers, ordered by cost ascending.
 *
 *   hot  — env-var or in-memory swap; plugins notified via callback.
 *          Bounded ~100ms. No service lifecycle touched.
 *   warm — re-init of one or more plugins' services. Bounded 1–3s.
 *          Other plugins keep their state.
 *   cold — full runtime swap (current handleRestart). 15–60s.
 *
 * The classifier MUST upgrade conservatively when uncertain: hot → warm,
 * warm → cold. Downgrading a cold change to warm risks corrupt state.
 */
export type ReloadTier = "hot" | "warm" | "cold";

// ---------------------------------------------------------------------------
// Operation state machine
// ---------------------------------------------------------------------------

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back";

export type PhaseStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type PhaseName =
  | "validate"
  | "cold-restart"
  | "apply-env"
  | "notify-plugins"
  | "health-check";

export type OperationErrorCode =
  | "abandoned"
  | "no-strategy-for-tier"
  | "no-runtime"
  | "strategy-failed"
  | "vault-resolve-failed"
  | "health-check-failed";

export interface OperationError {
  message: string;
  code?: OperationErrorCode;
  cause?: string;
}

export interface OperationPhase {
  name: PhaseName;
  status: PhaseStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: OperationError;
  /** Optional structured detail surfaced to the UI / logs. */
  detail?: Record<string, unknown>;
}

export interface RuntimeOperation {
  id: string;
  /** Local executor identity; absent on records written before ownership tracking. */
  processOwner?: { hostname: string; pid: number };
  kind: OperationKind;
  intent: OperationIntent;
  tier: ReloadTier;
  idempotencyKey?: string;
  status: OperationStatus;
  phases: OperationPhase[];
  fromConfigVersion?: number;
  toConfigVersion?: number;
  startedAt: number;
  finishedAt?: number;
  error?: OperationError;
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

export interface RuntimeOperationListOptions {
  limit?: number;
  status?: OperationStatus;
  /** When true, include rolled-back / failed ops in the result. */
  includeTerminal?: boolean;
}

export interface RuntimeOperationRepository {
  create(op: RuntimeOperation): Promise<void>;
  /**
   * Patch top-level fields. Phases are append-only — use appendPhase /
   * updatePhase for those.
   */
  update(
    id: string,
    patch: Partial<Omit<RuntimeOperation, "id" | "phases" | "intent" | "kind">>,
  ): Promise<void>;
  appendPhase(id: string, phase: OperationPhase): Promise<void>;
  /**
   * Update the LAST phase only (for transitioning pending → running →
   * succeeded). Earlier phases are immutable once finished.
   */
  updateLastPhase(id: string, patch: Partial<OperationPhase>): Promise<void>;
  get(id: string): Promise<RuntimeOperation | null>;
  list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]>;
  findByIdempotencyKey(key: string): Promise<RuntimeOperation | null>;
  /** Returns the active (running) operation, if any. */
  findActive(): Promise<RuntimeOperation | null>;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export type HealthCheckResult =
  | { ok: true }
  | { ok: false; reason: string; cause?: unknown };

export interface HealthCheck {
  name: string;
  /**
   * Required checks block promotion. Optional checks are reported in the
   * operation phase detail but do not fail the operation.
   */
  required: boolean;
  /** Soft timeout in ms. The runner enforces it. */
  timeoutMs: number;
  run(runtime: AgentRuntime): Promise<HealthCheckResult>;
}

export interface HealthCheckReport {
  passed: readonly { name: string; durationMs: number }[];
  failed: readonly {
    name: string;
    required: boolean;
    reason: string;
    durationMs: number;
  }[];
  /** True only when every REQUIRED check passed. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Reload strategies (one per tier)
// ---------------------------------------------------------------------------

export interface ReloadContext {
  runtime: AgentRuntime;
  intent: OperationIntent;
  /** Phase reporter — call for every meaningful step inside a strategy. */
  reportPhase: (phase: OperationPhase) => Promise<void>;
}

export interface ReloadStrategy {
  tier: ReloadTier;
  /**
   * Apply the change. Return the (possibly new) runtime to install as
   * primary. For hot/warm, this is typically the same runtime; for cold,
   * it's a freshly bootstrapped one.
   */
  apply(ctx: ReloadContext): Promise<AgentRuntime>;
}

// ---------------------------------------------------------------------------
// Manager / use case
// ---------------------------------------------------------------------------

export interface StartOperationRequest {
  intent: OperationIntent;
  idempotencyKey?: string;
  /**
   * Runs after the idempotency and active-operation gates pass, but before
   * the operation is persisted and scheduled. Use for accepted-only side
   * effects that must complete before the strategy can run.
   */
  prepare?: () => Promise<OperationIntent | undefined>;
}

export type StartOperationOutcome =
  /** Newly accepted; will run async. Caller polls /events for status. */
  | { kind: "accepted"; operation: RuntimeOperation }
  /** Idempotent hit — same key, same intent already in flight or done. */
  | { kind: "deduped"; operation: RuntimeOperation }
  /** Another operation is currently active. Caller should retry later. */
  | { kind: "rejected-busy"; activeOperationId: string };

export interface RuntimeOperationManager {
  start(req: StartOperationRequest): Promise<StartOperationOutcome>;
  get(id: string): Promise<RuntimeOperation | null>;
  list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]>;
  findActive(): Promise<RuntimeOperation | null>;
}
