/**
 * ScheduledTaskRunner.
 *
 * Cross-agent invariants enforced here:
 *  - The runner does NOT pattern-match on `promptInstructions`.
 *  - `acknowledged` is non-terminal; `pipeline.onComplete` only fires on
 *    `completed`.
 *  - Snooze RESETS the ladder.
 *  - Global pause skips tasks with `respectsGlobalPause: true`.
 *  - `shouldFire` is always an array; empty / missing arrays are treated as
 *    "no gates → allow".
 *  - `idempotencyKey` deduplicates schedules.
 *  - `pipeline.onSkip` wins over `completionCheck.followupAfterMinutes` when
 *    both are set.
 *  - `trigger.kind = "after_task"` children auto-fire when the parent reaches
 *    the recorded terminal outcome through a runner transition (verbs,
 *    gate-deny skip, dispatch failure, `pipeline()`), EXCEPT the global-pause
 *    skip: pause suppresses proactive behavior, and chaining is proactive.
 */

import { ElizaError, stableStringify } from "@elizaos/core/edge";
import { decideDispatchPolicy } from "../dispatch-policy.js";
import type { DispatchResult } from "../dispatch-types.js";
import type { CompletionCheckRegistry } from "./completion-check-registry.js";
import type {
  AnchorRegistry,
  ConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  isScheduledTaskDue,
  pendingPromptRoomIdForTask,
  type ScheduledTaskDueDecision,
} from "./due.js";
import {
  type EscalationLadderRegistry,
  resetLadderForSnooze,
  resolveEffectiveLadder,
} from "./escalation.js";
import { normalizeScheduledEventPayload } from "./event-payload.js";
import type { TaskGateRegistry } from "./gate-registry.js";
import { computeNextFireAt } from "./next-fire-at.js";
import { createStateLogger, type ScheduledTaskLogStore } from "./state-log.js";
import { projectMinuteOffsetMs } from "./time-range.js";
import {
  type ActivitySignalBusView,
  APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
  type CompletionCheckContext,
  DEFAULT_TASK_EXECUTION_PROFILE,
  type GateDecision,
  type GateEvaluationContext,
  type GlobalPauseView,
  type OwnerFactsView,
  SCHEDULED_TASK_EDIT_READONLY_KEYS,
  type ScheduledTask,
  type ScheduledTaskApplyIntentResult,
  type ScheduledTaskApplyResult,
  type ScheduledTaskFilter,
  type ScheduledTaskLogEntry,
  type ScheduledTaskReceiptVerb,
  type ScheduledTaskRef,
  type ScheduledTaskRunner,
  type ScheduledTaskScheduleResult,
  type ScheduledTaskState,
  type ScheduledTaskVerb,
  type SubjectStoreView,
  TASK_EXECUTION_PROFILES,
  type TaskExecutionProfile,
  type TerminalState,
} from "./types.js";
import {
  ScheduledTaskValidationError,
  validateScheduledTaskInput,
} from "./validation.js";

/**
 * Typed error thrown by `runner.schedule()` when an `escalation.steps[].channelKey`
 * does not match a registered channel in the host runtime's `ChannelRegistry`.
 * The runner stays decoupled from the channel registry implementation; the
 * caller injects a `channelKeys()` lookup via {@link ScheduledTaskRunnerDeps}.
 */
export class ChannelKeyError extends Error {
  readonly code = "channel_key_unknown";
  constructor(
    readonly channelKey: string,
    readonly available: readonly string[],
  ) {
    super(
      `escalation.steps[].channelKey "${channelKey}" is not registered (registered: ${available.join(", ") || "<none>"})`,
    );
    this.name = "ChannelKeyError";
  }
}

// ---------------------------------------------------------------------------
// Store interface — DB-backed in production; in-memory in unit tests.
// ---------------------------------------------------------------------------

/**
 * Options the runner passes to `store.upsert` to keep the indexed
 * `next_fire_at` column in sync with the task's current trigger and state.
 *
 * The store does not compute this itself — the runner computes the value
 * using the active anchor / owner-facts / now references and forwards it
 * here. The repository writes a Postgres `timestamp with time zone`
 * (NULL for triggers without a wall-clock fire time).
 */
export interface ScheduledTaskUpsertOptions {
  nextFireAtIso: string | null;
}

/**
 * Outcome of the atomic fire-claim. Exactly one parallel call resolves to
 * `"fired"` for a given `(taskId, status="scheduled")` row; concurrent
 * callers see `"raced"` because the UPDATE … WHERE status='scheduled' clause
 * matches zero rows after the first wins.
 *
 * `task` on the `"fired"` branch carries the post-claim state (status =
 * "fired", `firedAt` set to the claim instant, `nextFireAt` cleared so the
 * scheduler tick will not re-pick it up before the next mutation).
 */
export type ScheduledTaskClaimResult =
  | { kind: "fired"; task: ScheduledTask }
  | { kind: "raced" };

/**
 * Compare-and-swap guard for a recurrence-refire claim. The runner passes the
 * `(status, firedAt)` pair it OBSERVED on the row; the store only claims when
 * the row still matches. Because a successful claim always rewrites
 * `state.firedAt` to the (new) claim instant, two concurrent ticks refiring
 * the same occurrence cannot both match: the winner's UPDATE changes
 * `firedAt`, so the loser's expected pair no longer holds and it races out —
 * even when both ticks observed the same status (e.g. `fired` → `fired`).
 */
export interface ScheduledTaskClaimExpectation {
  status: ScheduledTask["state"]["status"];
  firedAtIso: string | null;
}

export type ScheduledTaskApplyCommitResult =
  | {
      kind: "applied";
      task: ScheduledTask;
      commit: ScheduledTaskLogEntry;
    }
  | {
      kind: "replayed";
      task: ScheduledTask;
      commit: ScheduledTaskLogEntry;
    };

export type ScheduledTaskApplyIntentCommitResult =
  | { kind: "reserved"; task: ScheduledTask }
  | { kind: "replayed"; task: ScheduledTask };

export interface ScheduledTaskStore {
  upsert(
    task: ScheduledTask,
    options?: ScheduledTaskUpsertOptions,
  ): Promise<void>;
  /**
   * Persist the full task row only while the stored row still shows
   * `expectedStatus`. Returns `false` when zero rows matched — a concurrent
   * writer (a user verb such as `complete` / `dismiss` / `snooze`) moved the
   * row's lifecycle state while this snapshot was stale, and overwriting it
   * would silently revert the user's action. The fire path passes the status
   * observed at claim time (`"fired"`) so post-dispatch persistence can never
   * clobber a verb that landed while the dispatcher was in flight.
   */
  upsertIfStatus(
    task: ScheduledTask,
    options: ScheduledTaskUpsertOptions & {
      expectedStatus: ScheduledTask["state"]["status"];
    },
  ): Promise<boolean>;
  /**
   * Atomically transition a row to `"fired"`, returning the resulting row.
   * Returns `{ kind: "raced" }` when zero rows matched — either because the
   * row's state moved (another tick claimed it) or the id no longer exists.
   *
   * Without `expected`, the claim matches `state.status === "scheduled"`
   * only (the fresh-fire path — flipping `scheduled` → `fired` makes the
   * WHERE clause self-invalidating for concurrent claimers). With
   * `expected`, the claim is a CAS on the observed `(status, firedAt)` pair
   * — the recurrence-refire path, where the pre-claim status may already be
   * `fired` / `acknowledged` / a terminal state.
   *
   * The store is the only place where the read-mutate-write becomes
   * atomic; the runner's previous read-then-upsert pattern was racy
   * across parallel ticks.
   */
  claimForFire(args: {
    taskId: string;
    firedAtIso: string;
    expected?: ScheduledTaskClaimExpectation;
    /** Metadata observed by host admission; a changed row must be admitted again. */
    expectedMetadata?: NonNullable<ScheduledTask["metadata"]>;
  }): Promise<ScheduledTaskClaimResult>;
  /**
   * Persist one receipt-anchored mutation only when this task does not already
   * carry the same receipt key. The store atomically persists both the task
   * mutation and its state-log receipt so a user acknowledgement can never be
   * built from task state alone.
   */
  commitApply(args: {
    task: ScheduledTask;
    receiptKey: string;
    commit: ScheduledTaskLogEntry;
    nextFireAtIso: string | null;
  }): Promise<ScheduledTaskApplyCommitResult>;
  /** Atomically reserve one non-mutating, idempotency-keyed apply intent. */
  reserveApplyIntent(args: {
    task: ScheduledTask;
    intentKey: string;
  }): Promise<ScheduledTaskApplyIntentCommitResult>;
  get(taskId: string): Promise<ScheduledTask | null>;
  findByIdempotencyKey(key: string): Promise<ScheduledTask | null>;
  list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]>;
  delete(taskId: string): Promise<void>;
}

export function createInMemoryScheduledTaskStore(): ScheduledTaskStore {
  const map = new Map<string, ScheduledTask>();
  const applyCommits = new Map<string, ScheduledTaskLogEntry>();
  return {
    async upsert(task) {
      map.set(task.taskId, structuredClone(task));
    },
    async upsertIfStatus(task, options) {
      const existing = map.get(task.taskId);
      if (!existing || existing.state.status !== options.expectedStatus) {
        return false;
      }
      map.set(task.taskId, structuredClone(task));
      return true;
    },
    async claimForFire({ taskId, firedAtIso, expected, expectedMetadata }) {
      const existing = map.get(taskId);
      if (!existing) return { kind: "raced" };
      if (
        expectedMetadata !== undefined &&
        JSON.stringify(existing.metadata ?? {}) !==
          JSON.stringify(expectedMetadata)
      )
        return { kind: "raced" };
      const cutoverStatus = (
        existing.metadata?.sharedCutoverImport as
          | { status?: unknown }
          | undefined
      )?.status;
      if (cutoverStatus === "reserved") return { kind: "raced" };
      if (expected) {
        if (
          existing.state.status !== expected.status ||
          (existing.state.firedAt ?? null) !== expected.firedAtIso
        ) {
          return { kind: "raced" };
        }
      } else if (existing.state.status !== "scheduled") {
        return { kind: "raced" };
      }
      const next: ScheduledTask = structuredClone(existing);
      next.state.status = "fired";
      next.state.firedAt = firedAtIso;
      map.set(taskId, next);
      return { kind: "fired", task: structuredClone(next) };
    },
    async commitApply({ task, receiptKey, commit }) {
      const existing = map.get(task.taskId);
      if (!existing) {
        throw new Error(`commitApply: task ${task.taskId} not found`);
      }
      const storedReceipts = existing.metadata?.schedulingApplyReceipts;
      const receiptMarkers =
        storedReceipts !== null &&
        typeof storedReceipts === "object" &&
        !Array.isArray(storedReceipts)
          ? (storedReceipts as Record<string, unknown>)
          : {};
      if (Object.hasOwn(receiptMarkers, receiptKey)) {
        const replayedCommit = applyCommits.get(commit.logId);
        if (!replayedCommit) {
          throw new Error(
            `commitApply: task ${task.taskId} has receipt ${receiptKey} without commit ${commit.logId}`,
          );
        }
        return {
          kind: "replayed",
          task: structuredClone(existing),
          commit: structuredClone(replayedCommit),
        };
      }
      // The caller proposal may predate another distinct-key commit. Its task
      // mutation remains authoritative, but receipt identity is monotonic and
      // must merge from the current stored row just like the SQL adapter does.
      const committedTask = structuredClone(task);
      const proposedReceipts = committedTask.metadata?.schedulingApplyReceipts;
      const proposedReceiptValue =
        proposedReceipts !== null &&
        typeof proposedReceipts === "object" &&
        !Array.isArray(proposedReceipts)
          ? ((proposedReceipts as Record<string, unknown>)[receiptKey] ?? true)
          : true;
      committedTask.metadata = {
        ...(committedTask.metadata ?? {}),
        schedulingApplyReceipts: {
          ...receiptMarkers,
          [receiptKey]: proposedReceiptValue,
        },
      };
      map.set(task.taskId, committedTask);
      applyCommits.set(commit.logId, structuredClone(commit));
      return {
        kind: "applied",
        task: structuredClone(committedTask),
        commit: structuredClone(commit),
      };
    },
    async reserveApplyIntent({ task, intentKey }) {
      const existing = map.get(task.taskId);
      if (!existing) {
        throw new Error(`reserveApplyIntent: task ${task.taskId} not found`);
      }
      const storedIntents = existing.metadata?.schedulingApplyIntents;
      const intentMarkers =
        storedIntents !== null &&
        typeof storedIntents === "object" &&
        !Array.isArray(storedIntents)
          ? (storedIntents as Record<string, unknown>)
          : {};
      if (Object.hasOwn(intentMarkers, intentKey)) {
        return { kind: "replayed", task: structuredClone(existing) };
      }
      const proposedIntents = task.metadata?.schedulingApplyIntents;
      const proposedValue =
        proposedIntents !== null &&
        typeof proposedIntents === "object" &&
        !Array.isArray(proposedIntents)
          ? ((proposedIntents as Record<string, unknown>)[intentKey] ?? true)
          : true;
      const committedTask = structuredClone(existing);
      committedTask.metadata = {
        ...(committedTask.metadata ?? {}),
        schedulingApplyIntents: {
          ...intentMarkers,
          [intentKey]: structuredClone(proposedValue),
        },
      };
      map.set(task.taskId, committedTask);
      return { kind: "reserved", task: structuredClone(committedTask) };
    },
    async get(taskId) {
      const found = map.get(taskId);
      return found ? structuredClone(found) : null;
    },
    async findByIdempotencyKey(key) {
      for (const t of map.values()) {
        if (t.idempotencyKey === key) {
          return structuredClone(t);
        }
      }
      return null;
    },
    async list(filter) {
      let view = Array.from(map.values()).map((t) => structuredClone(t));
      if (!filter) return view;
      if (filter.kind) view = view.filter((t) => t.kind === filter.kind);
      if (filter.status) {
        const allowed = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        view = view.filter((t) => allowed.has(t.state.status));
      }
      if (filter.subject) {
        view = view.filter(
          (t) =>
            t.subject?.kind === filter.subject?.kind &&
            t.subject?.id === filter.subject?.id,
        );
      }
      if (filter.source) view = view.filter((t) => t.source === filter.source);
      if (filter.firedSince) {
        view = view.filter(
          (t) =>
            typeof t.state.firedAt === "string" &&
            t.state.firedAt >= (filter.firedSince ?? ""),
        );
      }
      if (filter.ownerVisibleOnly) view = view.filter((t) => t.ownerVisible);
      return view;
    },
    async delete(taskId) {
      map.delete(taskId);
    },
  };
}

export interface ScheduledTaskDispatchRecord {
  taskId: string;
  /** Added additively; legacy host dispatchers may omit it. */
  kind?: ScheduledTask["kind"];
  firedAtIso: string;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
  promptInstructions: string;
  contextRequest: ScheduledTask["contextRequest"];
  subject?: ScheduledTask["subject"];
  /** Added additively; omitted legacy records never receive owner context. */
  ownerVisible?: boolean;
  eventPayload?: unknown;
  resolvedContext?: import("./types.js").ScheduledTaskResolvedContext;
  consolidationBatchId?: string;
  output?: ScheduledTask["output"];
  metadata?: ScheduledTask["metadata"];
}

export interface ScheduledTaskDispatcher {
  dispatch(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined>;
}

/**
 * Test-only no-op dispatcher. Production code MUST inject
 * `createProductionScheduledTaskDispatcher` via runtime-wiring; the runner
 * factory requires a dispatcher and there is no silent fallback. Exported only
 * so tests can construct a runner without touching the channel layer.
 *
 * @internal
 */
export const TestNoopScheduledTaskDispatcher: ScheduledTaskDispatcher = {
  async dispatch() {
    /* intentional no-op for tests */
  },
};

// ---------------------------------------------------------------------------
// Runner deps (factory)
// ---------------------------------------------------------------------------

export interface ScheduledTaskRunnerDeps {
  agentId: string;
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
  gates: TaskGateRegistry;
  completionChecks: CompletionCheckRegistry;
  ladders: EscalationLadderRegistry;
  anchors: AnchorRegistry;
  consolidation: ConsolidationRegistry;
  ownerFacts: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause: GlobalPauseView;
  activity: ActivitySignalBusView;
  subjectStore: SubjectStoreView;
  dispatcher: ScheduledTaskDispatcher;
  /** Host admission spans claim, dispatch, receipt persistence, and follow-up work. */
  executionBoundary?: (
    task: ScheduledTask,
    execute: () => Promise<ScheduledTaskFireResult>,
  ) => Promise<ScheduledTaskFireResult>;
  /**
   * Lookup of registered `ChannelRegistry` keys. When supplied, `schedule()`
   * validates each `escalation.steps[].channelKey` against this set and
   * throws {@link ChannelKeyError} on miss. Decoupled from the channels
   * module to keep the spine free of channel-layer dependencies.
   */
  channelKeys?: () => ReadonlySet<string>;
  /**
   * Optional live availability probe used while advancing a ladder after a
   * typed dispatch failure. Hosts that know connector status can skip
   * disconnected connector-backed channels before parking the next attempt,
   * so escalation cannot target an unavailable transport by construction.
   */
  channelAvailable?: (channelKey: string) => boolean | Promise<boolean>;
  /**
   * Returns the set of `TaskExecutionProfile` values the current host can
   * actually run. The runner consults this AFTER the atomic fire-claim but
   * BEFORE dispatch: if `task.executionProfile` is not in the set, dispatch
   * is rewritten to `notify-only` and a `"substituted"` state-log row is
   * recorded. Default (when not provided): all four profiles available —
   * appropriate for tests and Node desktop. Mobile / Capacitor callers
   * inject a real probe from
   * `@elizaos/app-core/services/local-inference/host-capabilities`.
   */
  hostCapabilities?: () => ReadonlySet<TaskExecutionProfile>;
  /** Override for tests. */
  newTaskId?: () => string;
  /** Override for tests. */
  now?: () => Date;
}

/**
 * Default capability probe — assumes a full host (test/Node). Mobile callers
 * inject a real probe so heavy tasks substitute to notify-only on incapable
 * hosts instead of silently failing under a 30s wake budget.
 */
const ALL_PROFILES_AVAILABLE: ReadonlySet<TaskExecutionProfile> = new Set(
  TASK_EXECUTION_PROFILES,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultTaskIdGenerator(): string {
  // Stable enough across runtimes; the DB is authoritative for uniqueness.
  return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const CREATION_RECEIPT_METADATA_KEY = "schedulingCreationReceipt";
const APPLY_RECEIPTS_METADATA_KEY = "schedulingApplyReceipts";
const APPLY_INTENTS_METADATA_KEY = "schedulingApplyIntents";
const APPLY_IDEMPOTENCY_KEY_MAX_LENGTH = 512;

interface SchedulingCreationReceiptAnchor {
  logId: string;
  occurredAtIso: string;
}

function readCreationReceiptAnchor(
  task: ScheduledTask,
): SchedulingCreationReceiptAnchor | null {
  const value = task.metadata?.[CREATION_RECEIPT_METADATA_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.logId === "string" &&
    candidate.logId.length > 0 &&
    typeof candidate.occurredAtIso === "string" &&
    !Number.isNaN(Date.parse(candidate.occurredAtIso))
    ? { logId: candidate.logId, occurredAtIso: candidate.occurredAtIso }
    : null;
}

async function creationReceiptLogId(
  agentId: string,
  taskId: string,
): Promise<string> {
  return `stl_create_${await sha256Hex(`${agentId}\0${taskId}`)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeApplyIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length === 0 || key.length > APPLY_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new Error(
      `applyWithResult: idempotencyKey must contain 1-${APPLY_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  return key;
}

async function applyReceiptKey(
  verb: ScheduledTaskReceiptVerb,
  idempotencyKey: string,
): Promise<string> {
  return sha256Hex(`${verb}\0${idempotencyKey}`);
}

async function applyIntentKey(idempotencyKey: string): Promise<string> {
  return sha256Hex(`intent\0${idempotencyKey}`);
}

/** Read exact request context persisted before a multi-task lifecycle effect. */
export async function scheduledTaskApplyIntentContext(
  task: ScheduledTask,
  idempotencyKey: string,
): Promise<Record<string, unknown> | undefined> {
  const normalizedKey = normalizeApplyIdempotencyKey(idempotencyKey);
  const intentKey = await applyIntentKey(normalizedKey);
  const intents = task.metadata?.[APPLY_INTENTS_METADATA_KEY];
  if (
    intents === null ||
    typeof intents !== "object" ||
    Array.isArray(intents)
  ) {
    return undefined;
  }
  const context = (intents as Record<string, unknown>)[intentKey];
  return context !== null &&
    typeof context === "object" &&
    !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : undefined;
}

function writeApplyIntentMarker(
  task: ScheduledTask,
  intentKey: string,
  context: Record<string, unknown>,
): void {
  const existing = task.metadata?.[APPLY_INTENTS_METADATA_KEY];
  const intents =
    existing !== null &&
    typeof existing === "object" &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  task.metadata = {
    ...(task.metadata ?? {}),
    [APPLY_INTENTS_METADATA_KEY]: {
      ...intents,
      [intentKey]: structuredClone(context),
    },
  };
}

/**
 * Returns whether this exact lifecycle request already committed on a task.
 * Consumers use it only to recover a receipt after a response/claim crash;
 * terminal rows without the exact marker remain invisible to fresh mutations.
 */
export async function hasScheduledTaskApplyReceipt(
  task: ScheduledTask,
  verb: ScheduledTaskReceiptVerb,
  idempotencyKey: string,
): Promise<boolean> {
  const normalizedKey = normalizeApplyIdempotencyKey(idempotencyKey);
  const receiptKey = await applyReceiptKey(verb, normalizedKey);
  const receipts = task.metadata?.[APPLY_RECEIPTS_METADATA_KEY];
  return (
    receipts !== null &&
    typeof receipts === "object" &&
    !Array.isArray(receipts) &&
    Object.hasOwn(receipts, receiptKey)
  );
}

/** Read context committed atomically with one exact lifecycle receipt. */
export async function scheduledTaskApplyReceiptContext(
  task: ScheduledTask,
  verb: ScheduledTaskReceiptVerb,
  idempotencyKey: string,
): Promise<Record<string, unknown> | undefined> {
  const normalizedKey = normalizeApplyIdempotencyKey(idempotencyKey);
  const receiptKey = await applyReceiptKey(verb, normalizedKey);
  const receipts = task.metadata?.[APPLY_RECEIPTS_METADATA_KEY];
  if (
    receipts === null ||
    typeof receipts !== "object" ||
    Array.isArray(receipts)
  ) {
    return undefined;
  }
  const context = (receipts as Record<string, unknown>)[receiptKey];
  return context !== null &&
    typeof context === "object" &&
    !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : undefined;
}

async function applyReceiptLogId(args: {
  agentId: string;
  taskId: string;
  verb: ScheduledTaskReceiptVerb;
  idempotencyKey: string;
}): Promise<string> {
  return `stl_apply_${await sha256Hex(
    `${args.agentId}\0${args.taskId}\0${args.verb}\0${args.idempotencyKey}`,
  )}`;
}

function writeApplyReceiptMarker(
  task: ScheduledTask,
  receiptKey: string,
  context?: Record<string, unknown>,
): void {
  const existing = task.metadata?.[APPLY_RECEIPTS_METADATA_KEY];
  const receipts =
    existing !== null &&
    typeof existing === "object" &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  task.metadata = {
    ...(task.metadata ?? {}),
    [APPLY_RECEIPTS_METADATA_KEY]: {
      ...receipts,
      [receiptKey]: context ? structuredClone(context) : true,
    },
  };
}

function isTerminal(status: ScheduledTask["state"]["status"]): boolean {
  return (
    status === "completed" ||
    status === "skipped" ||
    status === "expired" ||
    status === "failed" ||
    status === "dismissed"
  );
}

function isRecurringTrigger(trigger: ScheduledTask["trigger"]): boolean {
  return (
    trigger.kind === "cron" ||
    trigger.kind === "interval" ||
    trigger.kind === "relative_to_anchor" ||
    trigger.kind === "during_window"
  );
}

/** Public consumer classifier for rows that retain a future scheduler occurrence. */
export function isScheduledTaskRecurring(
  task: Pick<ScheduledTask, "trigger">,
): boolean {
  return isRecurringTrigger(task.trigger);
}

function setEscalationCursor(
  task: ScheduledTask,
  cursor: { stepIndex: number; lastDispatchedAt: string },
): void {
  task.metadata = {
    ...(task.metadata ?? {}),
    escalationCursor: { ...cursor },
  };
}

/**
 * Retry attempts allowed on one dispatch step before the policy's `retry`
 * decision is escalated to `advance` (or `fail` on the last step). Guards
 * against a connector that reports `rate_limited` forever pinning the task
 * in an infinite retry loop.
 */
const MAX_DISPATCH_RETRIES_PER_STEP = 3;

/**
 * Continuation marker for a dispatch that failed with a typed
 * `DispatchResult { ok: false }`. `stepIndex` is the escalation-ladder step
 * the NEXT fire attempt must dispatch through (`-1` = the initial/default
 * channel), `attempt` counts retries already burned on that step.
 * Persisted in `metadata.pendingDispatch`; cleared on successful dispatch
 * and on snooze (ladder reset).
 */
interface PendingDispatch {
  stepIndex: number;
  attempt: number;
  eventPayload?: unknown;
}

function readPendingDispatch(task: ScheduledTask): PendingDispatch | null {
  const raw = task.metadata?.pendingDispatch;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const stepIndex = (raw as Record<string, unknown>).stepIndex;
  const attempt = (raw as Record<string, unknown>).attempt;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) {
    return null;
  }
  return {
    stepIndex,
    attempt:
      typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 0
        ? attempt
        : 0,
    ...(Object.hasOwn(raw, "eventPayload")
      ? { eventPayload: (raw as Record<string, unknown>).eventPayload }
      : {}),
  };
}

function setPendingDispatch(task: ScheduledTask, pending: PendingDispatch) {
  task.metadata = {
    ...(task.metadata ?? {}),
    pendingDispatch: { ...pending },
  };
}

function clearPendingDispatch(task: ScheduledTask): void {
  if (task.metadata && "pendingDispatch" in task.metadata) {
    const next = { ...task.metadata };
    delete (next as Record<string, unknown>).pendingDispatch;
    task.metadata = next;
  }
}

function clearEscalationCursor(task: ScheduledTask): void {
  if (task.metadata && "escalationCursor" in task.metadata) {
    const next = { ...task.metadata };
    delete (next as Record<string, unknown>).escalationCursor;
    task.metadata = next;
  }
}

function stripServerManaged(
  task: ScheduledTask,
): Omit<ScheduledTask, "taskId" | "state"> {
  const { taskId: _id, state: _state, ...rest } = task;
  return rest;
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Public read view of `metadata.escalationCursor`.
 *
 * The cursor is the runner's persistence channel for the snooze-resets-ladder
 * rule. Consumers that need to surface "currently on step N of escalation"
 * read it through {@link ScheduledTaskRunnerExtras.getEscalationCursor} so
 * they don't reach into the metadata namespace directly.
 *
 * - `stepIndex` follows the {@link EscalationCursor} convention: `-1` means
 *   the task was fired but no escalation step has been dispatched yet;
 *   `0..n` is the index into the resolved ladder's `steps`.
 * - `lastFiredAt` is the ISO of the most recent dispatch (or the initial
 *   task fire when `stepIndex === -1`).
 * - `channelKey` is resolved from the effective ladder. For `stepIndex === -1`
 *   we surface the first step's channel when the ladder has steps, falling
 *   back to `"in_app"` when the ladder is empty.
 */
export interface EscalationCursorView {
  stepIndex: number;
  lastFiredAt: string;
  channelKey: string;
}

/**
 * Strict result of a single `fire()` attempt. Callers should exhaustively
 * switch on `kind`.
 *
 * - `fired` — the task transitioned to `"fired"` (or was deferred via
 *   `gate.defer`, reopened for a recurrence, etc.) and the dispatcher ran.
 *   `task` is the post-mutation state.
 * - `raced` — another writer moved the row out from under this attempt: a
 *   parallel tick claimed it first, or a user verb (`complete` / `dismiss` /
 *   `snooze`) settled it while this attempt's dispatch was in flight. Caller
 *   drops the attempt silently; the winning writer is authoritative.
 * - `skipped` — the task was skipped without dispatch: global-pause active,
 *   a gate denied, or the task was already terminal and not eligible for
 *   recurrence refire.
 * - `dispatch_deferred` — the dispatcher returned a typed
 *   `DispatchResult { ok: false }` and {@link decideDispatchPolicy} chose to
 *   retry the SAME step after a backoff (transient failures, bounded
 *   attempts) or advance to the next escalation-ladder step (permanent
 *   failures with rungs remaining). The task is back in `"scheduled"` with
 *   `state.firedAt` set to the next attempt time (the scheduled-override the
 *   tick honors). Nothing reached the user yet.
 * - `dispatch_failed` — the atomic claim succeeded but the dispatch did not
 *   reach the user and no retry/escalation step remains: the dispatcher
 *   threw, or it returned a non-retriable `{ ok: false }` with the ladder
 *   exhausted. The runner persists the row as `"failed"`, writes a failed
 *   state-log entry, and runs `pipeline.onFail` so history does not strand
 *   the task as successfully fired.
 */
export type ScheduledTaskFireResult =
  | { kind: "fired"; task: ScheduledTask }
  | { kind: "raced"; taskId: string }
  | { kind: "skipped"; task: ScheduledTask; reason: string }
  | {
      kind: "dispatch_deferred";
      task: ScheduledTask;
      reason: string;
      nextAttemptAtIso: string;
    }
  | { kind: "dispatch_failed"; task: ScheduledTask; error: Error };

export interface ScheduledTaskRunnerExtras {
  /**
   * Land one server-authorized task with its existing identity and state.
   * Exact retries carrying the same transfer receipt are idempotent; a task id
   * already owned by another import is a hard conflict.
   */
  importTask(
    task: ScheduledTask,
    receipt: {
      sourceAgentId: string;
      cutoverToken: string;
    },
  ): Promise<{ task: ScheduledTask; imported: boolean }>;
  /** Activate an exact imported task only after its server-owned cutover commits. */
  activateImportedTask(
    taskId: string,
    receipt: {
      sourceAgentId: string;
      cutoverToken: string;
    },
  ): Promise<{ task: ScheduledTask; activated: boolean }>;
  /**
   * Convenience wrapper around {@link ScheduledTaskRunnerExtras.fireWithResult}
   * that flattens the discriminated union into a `ScheduledTask`. Returns
   * the post-fire task on `fired` / `skipped` / `dispatch_failed`, and the
   * still-`scheduled` task on `raced` (so legacy callers that re-read see
   * the unmodified row). The strict-fire callsite — `processDueScheduledTasks`
   * — uses `fireWithResult` directly.
   *
   * Exposed for tests so we can assert behavior deterministically without
   * waiting on a real timer, and for legacy actions that only want the
   * task back.
   */
  fire(
    taskId: string,
    args?: {
      eventPayload?: unknown;
      allowTerminalRefire?: boolean;
      recoverFiredAtIso?: string;
    },
  ): Promise<ScheduledTask>;
  /**
   * Strict fire-attempt. Returns the {@link ScheduledTaskFireResult}
   * discriminated union; callers must exhaustively switch on `kind`. This
   * is the path the scheduler tick uses so the `raced` outcome (another
   * tick claimed the same row first) is observable instead of silently
   * collapsed into a "fired" return.
   */
  fireWithResult(
    taskId: string,
    args?: {
      eventPayload?: unknown;
      allowTerminalRefire?: boolean;
      recoverFiredAtIso?: string;
    },
  ): Promise<ScheduledTaskFireResult>;
  /**
   * Re-evaluate completion for a fired task (e.g. user_replied_within
   * scenarios, late inbounds). The runner consults its registered
   * completion-check and may transition the task to `completed`.
   */
  evaluateCompletion(
    taskId: string,
    signal: {
      acknowledged?: boolean;
      repliedAtIso?: string;
    },
  ): Promise<ScheduledTask>;
  /**
   * Run the nightly rollup pass on non-creation state-log rows. Default
   * retention is 90 days; stable `scheduled` creation receipts remain raw.
   */
  rolloverStateLog(opts?: { retentionDays?: number }): Promise<{
    rolledUp: number;
    deletedRaw: number;
  }>;
  /**
   * Return all gates registered (for the dev-registries endpoint).
   */
  inspectRegistries(): {
    gates: string[];
    completionChecks: string[];
    ladders: string[];
    anchors: string[];
    consolidationPolicies: string[];
  };
  /**
   * Read the public view of `metadata.escalationCursor` for a task. Returns
   * `null` when the task is not found or has no cursor recorded yet.
   */
  getEscalationCursor(taskId: string): Promise<EscalationCursorView | null>;
  /**
   * Project the next wall-clock fire instant for a task, honoring the same
   * scheduled-override and recurrence rules the runner uses to index
   * `next_fire_at`. Returns `null` for triggers with no wall-clock time
   * (`event`/`manual`/`after_task`) or settled non-recurring rows.
   *
   * Exposed so consumers that need a due-window view (e.g. the
   * `SCHEDULED_TASKS` action's "overdue"/"today" list filter) share the one
   * next-fire computation instead of re-deriving it and drifting from the
   * indexed value the tick relies on.
   */
  resolveNextFireAt(task: ScheduledTask): Promise<string | null>;
  /**
   * Evaluate whether a task is due at the runner's current clock, using the
   * same owner-facts and anchor dependencies as the scheduler tick. Consumers
   * that present due-window views need this before a future next-fire
   * projection, otherwise a missed recurring occurrence can be hidden by the
   * next natural occurrence.
   */
  resolveDueDecision(task: ScheduledTask): Promise<ScheduledTaskDueDecision>;
  /**
   * Return the owner facts the runner uses for trigger/gate evaluation. This is
   * exposed for read-only views that must apply the same owner-local timezone
   * boundary as the scheduler without reaching behind the runner deps port.
   */
  resolveOwnerFacts(): Promise<OwnerFactsView>;
}

export interface ScheduledTaskRunnerHandle
  extends ScheduledTaskRunner,
    ScheduledTaskRunnerExtras {
  reserveApplyIntent: NonNullable<ScheduledTaskRunner["reserveApplyIntent"]>;
}

export function createScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): ScheduledTaskRunnerHandle {
  const newTaskId = deps.newTaskId ?? defaultTaskIdGenerator;
  const now = deps.now ?? (() => new Date());
  const dispatcher = deps.dispatcher;
  const logger = createStateLogger({
    store: deps.logStore,
    agentId: deps.agentId,
    now,
  });

  async function evaluateGates(
    task: ScheduledTask,
  ): Promise<{ decision: GateDecision; gateKind?: string }> {
    const compose = task.shouldFire?.compose ?? "first_deny";
    const gates = task.shouldFire?.gates ?? [];
    if (gates.length === 0) {
      return { decision: { kind: "allow" } };
    }

    const ownerFacts = await deps.ownerFacts();
    const ctx: GateEvaluationContext = {
      task,
      nowIso: now().toISOString(),
      ownerFacts,
      activity: deps.activity,
      subjectStore: deps.subjectStore,
    };

    const decisions: Array<{ gateKind: string; decision: GateDecision }> = [];
    for (const gateRef of gates) {
      const contrib = deps.gates.get(gateRef.kind);
      if (!contrib) {
        return {
          gateKind: gateRef.kind,
          decision: {
            kind: "deny",
            reason: `unknown gate kind: ${gateRef.kind}`,
          },
        };
      }
      const decision = await contrib.evaluate(task, ctx);
      decisions.push({ gateKind: gateRef.kind, decision });

      if (compose === "first_deny" && decision.kind !== "allow") {
        return { gateKind: gateRef.kind, decision };
      }
      if (compose === "any" && decision.kind === "allow") {
        return { gateKind: gateRef.kind, decision: { kind: "allow" } };
      }
    }

    if (compose === "all") {
      const denied = decisions.find((d) => d.decision.kind !== "allow");
      if (denied) return denied;
      return { decision: { kind: "allow" } };
    }
    if (compose === "any") {
      // No allow seen.
      const lastDeny = decisions
        .reverse()
        .find((d) => d.decision.kind === "deny");
      if (lastDeny) return lastDeny;
      const lastDefer = decisions.find((d) => d.decision.kind === "defer");
      if (lastDefer) return lastDefer;
      return {
        decision: { kind: "deny", reason: "any: no gate allowed" },
      };
    }
    // first_deny: no deny encountered → allow
    return { decision: { kind: "allow" } };
  }

  async function shouldDeferForGlobalPause(
    task: ScheduledTask,
  ): Promise<{ paused: boolean; reason?: string }> {
    if (task.respectsGlobalPause === false) return { paused: false };
    const pause = await deps.globalPause.current(now());
    if (!pause.active) return { paused: false };
    return {
      paused: true,
      reason: pause.reason ? `global_pause: ${pause.reason}` : "global_pause",
    };
  }

  /**
   * Persist a task snapshot. Pass `expectedStatus` on post-claim writes: the
   * store then only applies the row while it still shows that status, and
   * this returns `null` when a concurrent user verb won instead — callers
   * must treat `null` as "the row moved; reload before acting on it" and
   * never write derived state-log rows for a persistence that did not happen.
   */
  async function persist(
    task: ScheduledTask,
    opts?: { expectedStatus?: ScheduledTask["state"]["status"] },
  ): Promise<ScheduledTask | null> {
    const nextFireAtIso = await resolveNextFireAt(task);
    if (opts?.expectedStatus) {
      const applied = await deps.store.upsertIfStatus(task, {
        nextFireAtIso,
        expectedStatus: opts.expectedStatus,
      });
      return applied ? structuredClone(task) : null;
    }
    await deps.store.upsert(task, { nextFireAtIso });
    return structuredClone(task);
  }

  async function resolveNextFireAt(
    task: ScheduledTask,
  ): Promise<string | null> {
    // Dismissed rows never refire. Settled NON-recurring rows are done —
    // storing a stale `next_fire_at` would leave them in the partial-index
    // slice forever; clearing it keeps the index slim.
    //
    // RECURRING rows in every other status (`acknowledged` and the remaining
    // terminal states) keep a trigger-derived `next_fire_at`: that is what
    // lets the scheduler tick's indexed slice resurface a completed / skipped
    // / acknowledged daily task at its NEXT occurrence (recurrence refire,
    // claimed via the CAS in `fireWithResult`). `computeNextFireAt` projects
    // forward from `now`, so the stored value is always the next FUTURE
    // occurrence — a gate-denied occurrence does not re-enter the slice
    // every tick.
    if (task.state.status === "dismissed") return null;
    if (isTerminal(task.state.status) && !isRecurringTrigger(task.trigger)) {
      return null;
    }
    if (
      task.state.status === "acknowledged" &&
      !isRecurringTrigger(task.trigger)
    ) {
      // A non-recurring acknowledged row has no future occurrence; keeping
      // its trigger-derived time would park it in the tick slice where every
      // pass would race out on the `scheduled`-only claim.
      return null;
    }
    const ownerFacts = await deps.ownerFacts();
    return computeNextFireAt(task, {
      now: now(),
      ownerFacts,
      anchors: deps.anchors,
    });
  }

  async function resolveDueDecision(
    task: ScheduledTask,
  ): Promise<ScheduledTaskDueDecision> {
    const ownerFacts = await deps.ownerFacts();
    return isScheduledTaskDue(task, {
      now: now(),
      ownerFacts,
      anchors: deps.anchors,
    });
  }

  async function resolveOwnerFacts(): Promise<OwnerFactsView> {
    return deps.ownerFacts();
  }

  async function schedule(
    input: Omit<ScheduledTask, "taskId" | "state">,
  ): Promise<ScheduledTask> {
    return (await scheduleWithResult(input)).task;
  }

  async function creationCommit(
    task: ScheduledTask,
  ): Promise<ScheduledTaskLogEntry> {
    const anchor = readCreationReceiptAnchor(task);
    const entries = await deps.logStore.list({
      agentId: deps.agentId,
      taskId: task.taskId,
      excludeRollups: true,
    });
    const existing = anchor
      ? entries.find(
          (entry) =>
            entry.logId === anchor.logId && entry.transition === "scheduled",
        )
      : entries.find((entry) => entry.transition === "scheduled");
    if (existing) return existing;
    if (!anchor) {
      throw new Error(
        `Scheduled task ${task.taskId} has no durable creation receipt`,
      );
    }

    const commit: ScheduledTaskLogEntry = {
      logId: anchor.logId,
      taskId: task.taskId,
      agentId: deps.agentId,
      occurredAtIso: anchor.occurredAtIso,
      transition: "scheduled",
      rolledUp: false,
      detail: {
        kind: task.kind,
        priority: task.priority,
        triggerKind: task.trigger.kind,
      },
    };
    try {
      await deps.logStore.append(commit);
      return commit;
    } catch (error) {
      // error-policy:J1 The durable-store boundary resolves a concurrent
      // append by reading the stable receipt identity back before surfacing it.
      const raced = (
        await deps.logStore.list({
          agentId: deps.agentId,
          taskId: task.taskId,
          excludeRollups: true,
        })
      ).find(
        (entry) =>
          entry.logId === anchor.logId && entry.transition === "scheduled",
      );
      if (raced) return raced;
      throw error;
    }
  }

  async function replaySchedule(
    task: ScheduledTask,
  ): Promise<ScheduledTaskScheduleResult> {
    return { task, commit: await creationCommit(task), replayed: true };
  }

  async function scheduleWithResult(
    input: Omit<ScheduledTask, "taskId" | "state">,
  ): Promise<ScheduledTaskScheduleResult> {
    if (input.idempotencyKey) {
      const existing = await deps.store.findByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) return replaySchedule(existing);
    }

    const validationIssues = validateScheduledTaskInput(input, deps);
    if (validationIssues.length > 0) {
      throw new ScheduledTaskValidationError(validationIssues);
    }

    // A11: channel-key validation against the runtime ChannelRegistry.
    if (deps.channelKeys && input.escalation?.steps) {
      const registered = deps.channelKeys();
      for (const step of input.escalation.steps) {
        if (!registered.has(step.channelKey)) {
          throw new ChannelKeyError(
            step.channelKey,
            Array.from(registered).sort(),
          );
        }
      }
    }

    // A7: default `completionCheck.followupAfterMinutes` for approval-kind
    // tasks when the curator did not set one explicitly and pipeline.onSkip
    // is empty (which would otherwise win per §7.4 resolution rule).
    const withApprovalDefaults = applyApprovalCompletionDefault(input);

    const initialState: ScheduledTaskState = {
      status: "scheduled",
      followupCount: 0,
    };
    const taskId = newTaskId();
    const creationReceipt: SchedulingCreationReceiptAnchor = {
      logId: await creationReceiptLogId(deps.agentId, taskId),
      occurredAtIso: now().toISOString(),
    };
    const inputMetadata = { ...(withApprovalDefaults.metadata ?? {}) };
    delete inputMetadata[APPLY_RECEIPTS_METADATA_KEY];
    const task: ScheduledTask = {
      taskId,
      ...withApprovalDefaults,
      metadata: {
        ...inputMetadata,
        [CREATION_RECEIPT_METADATA_KEY]: creationReceipt,
      },
      state: initialState,
    };
    try {
      await persist(task);
    } catch (error) {
      // error-policy:J1 A same-key insert race is translated to the already
      // committed task; unrelated persistence failures still fail closed.
      const existing = input.idempotencyKey
        ? await deps.store.findByIdempotencyKey(input.idempotencyKey)
        : null;
      if (existing) return replaySchedule(existing);
      throw error;
    }
    const commit = await creationCommit(task);
    if (
      task.completionCheck?.followupAfterMinutes &&
      task.pipeline?.onSkip &&
      task.pipeline.onSkip.length > 0
    ) {
      await logger.log(task.taskId, "edited", {
        reason:
          "validation: pipeline.onSkip overrides completionCheck.followupAfterMinutes",
      });
    }
    return { task, commit, replayed: false };
  }

  async function importTask(
    task: ScheduledTask,
    receipt: { sourceAgentId: string; cutoverToken: string },
  ): Promise<{ task: ScheduledTask; imported: boolean }> {
    const existing = await deps.store.get(task.taskId);
    const existingReceipt = existing?.metadata?.sharedCutoverImport;
    const taskDigest = stableStringify(task);
    if (existing) {
      if (
        existingReceipt !== null &&
        typeof existingReceipt === "object" &&
        "sourceAgentId" in existingReceipt &&
        existingReceipt.sourceAgentId === receipt.sourceAgentId &&
        "cutoverToken" in existingReceipt &&
        existingReceipt.cutoverToken === receipt.cutoverToken &&
        "taskDigest" in existingReceipt &&
        existingReceipt.taskDigest === taskDigest
      ) {
        return { task: existing, imported: false };
      }
      throw new Error(
        `Scheduled task ${task.taskId} already exists with another owner`,
      );
    }

    const { taskId: _taskId, state: _state, ...input } = task;
    const validationIssues = validateScheduledTaskInput(input, deps);
    if (validationIssues.length > 0) {
      throw new ScheduledTaskValidationError(validationIssues, "importedTask");
    }
    const imported = structuredClone(task);
    imported.metadata = {
      ...(imported.metadata ?? {}),
      sharedCutoverImport: {
        sourceAgentId: receipt.sourceAgentId,
        cutoverToken: receipt.cutoverToken,
        taskDigest,
        status: "reserved",
      },
    };
    await persist(imported);
    return { task: imported, imported: true };
  }

  async function activateImportedTask(
    taskId: string,
    receipt: { sourceAgentId: string; cutoverToken: string },
  ): Promise<{ task: ScheduledTask; activated: boolean }> {
    const existing = await deps.store.get(taskId);
    const importedReceipt = existing?.metadata?.sharedCutoverImport;
    if (
      !existing ||
      importedReceipt === null ||
      typeof importedReceipt !== "object" ||
      !("sourceAgentId" in importedReceipt) ||
      importedReceipt.sourceAgentId !== receipt.sourceAgentId ||
      !("cutoverToken" in importedReceipt) ||
      importedReceipt.cutoverToken !== receipt.cutoverToken ||
      !("status" in importedReceipt) ||
      (importedReceipt.status !== "reserved" &&
        importedReceipt.status !== "active")
    ) {
      throw new Error(
        `Scheduled task ${taskId} does not carry the expected cutover receipt`,
      );
    }
    if (importedReceipt.status === "active") {
      return { task: existing, activated: false };
    }
    const activated = structuredClone(existing);
    activated.metadata = {
      ...(activated.metadata ?? {}),
      sharedCutoverImport: {
        ...importedReceipt,
        status: "active",
      },
    };
    await persist(activated);
    return { task: activated, activated: true };
  }

  function applyApprovalCompletionDefault(
    input: Omit<ScheduledTask, "taskId" | "state">,
  ): Omit<ScheduledTask, "taskId" | "state"> {
    if (input.kind !== "approval") return input;
    const onSkipEmpty =
      !input.pipeline?.onSkip || input.pipeline.onSkip.length === 0;
    if (!onSkipEmpty) return input;
    if (input.completionCheck?.followupAfterMinutes !== undefined) return input;
    const baseCheck = input.completionCheck ?? { kind: "user_acknowledged" };
    return {
      ...input,
      completionCheck: {
        ...baseCheck,
        followupAfterMinutes: APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
      },
    };
  }

  async function list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]> {
    return deps.store.list(filter);
  }

  async function remove(taskId: string): Promise<boolean> {
    const existing = await deps.store.get(taskId);
    if (!existing) return false;
    await deps.store.delete(taskId);
    return (await deps.store.get(taskId)) === null;
  }

  // -------------------------------------------------------------------------
  // Verb dispatch
  // -------------------------------------------------------------------------

  interface LifecycleMutation {
    task: ScheduledTask;
    transition: "snoozed" | "completed" | "dismissed";
    reason?: string;
    detail?: Record<string, unknown>;
  }

  function mutateSnooze(
    task: ScheduledTask,
    payload: { minutes?: number; untilIso?: string } | undefined,
  ): LifecycleMutation {
    const minutes = payload?.minutes;
    const untilIso = payload?.untilIso;
    let newFireAtIso: string;
    if (typeof untilIso === "string") {
      newFireAtIso = new Date(untilIso).toISOString();
    } else if (typeof minutes === "number") {
      if (minutes <= 0) {
        throw new Error("snooze: provide minutes or untilIso");
      }
      const newFireMs = projectMinuteOffsetMs(now().getTime(), minutes);
      if (newFireMs === null) {
        throw new ElizaError(
          "snooze: minutes must be finite and project to a representable Date",
          {
            code: "SCHEDULED_TASK_SNOOZE_PROJECTION_INVALID",
            context: { minutes },
          },
        );
      }
      newFireAtIso = new Date(newFireMs).toISOString();
    } else {
      throw new Error("snooze: provide minutes or untilIso");
    }
    task.state.status = "scheduled";
    task.state.firedAt = newFireAtIso;
    task.state.lastDecisionLog = `snoozed until ${newFireAtIso} (ladder reset)`;
    setEscalationCursor(task, resetLadderForSnooze(newFireAtIso));
    // Snooze starts a new occurrence, so no retry from the prior occurrence
    // may survive into the new ladder.
    clearPendingDispatch(task);
    return {
      task,
      transition: "snoozed",
      reason: `until ${newFireAtIso}`,
      detail: { newFireAtIso },
    };
  }

  function mutateComplete(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): LifecycleMutation {
    task.state.status = "completed";
    task.state.completedAt = now().toISOString();
    task.state.lastDecisionLog = payload?.reason ?? "completed";
    return {
      task,
      transition: "completed",
      reason: payload?.reason,
    };
  }

  function mutateDismiss(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): LifecycleMutation {
    task.state.status = "dismissed";
    task.state.lastDecisionLog = payload?.reason ?? "dismissed";
    return {
      task,
      transition: "dismissed",
      reason: payload?.reason,
    };
  }

  async function applySnooze(
    task: ScheduledTask,
    payload: { minutes?: number; untilIso?: string } | undefined,
  ): Promise<ScheduledTask> {
    const mutation = mutateSnooze(task, payload);
    await persist(mutation.task);
    await logger.log(mutation.task.taskId, mutation.transition, {
      reason: mutation.reason,
      detail: mutation.detail,
    });
    return mutation.task;
  }

  async function applySkip(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    task.state.status = "skipped";
    task.state.lastDecisionLog = payload?.reason ?? "user skipped";
    await persist(task);
    await logger.log(task.taskId, "skipped", {
      reason: payload?.reason ?? "user skipped",
    });
    await settleTerminal(task, "skipped");
    return task;
  }

  async function applyComplete(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    const mutation = mutateComplete(task, payload);
    await persist(mutation.task);
    await logger.log(mutation.task.taskId, mutation.transition, {
      reason: mutation.reason,
    });
    await settleTerminal(mutation.task, "completed");
    return mutation.task;
  }

  async function applyDismiss(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    const mutation = mutateDismiss(task, payload);
    await persist(mutation.task);
    await logger.log(mutation.task.taskId, mutation.transition, {
      reason: mutation.reason,
    });
    await settleTerminal(mutation.task, "dismissed");
    return mutation.task;
  }

  async function applyEscalate(
    task: ScheduledTask,
    payload: { force?: boolean } | undefined,
  ): Promise<ScheduledTask> {
    // `escalate` is a manual nudge to the next ladder step. The dispatcher
    // transition is handled inside fire(); we simply mark the task as fired
    // with intensity escalation and write a log row. The actual channel
    // egress happens via the dispatcher when fire() runs.
    task.state.followupCount += 1;
    task.state.lastFollowupAt = now().toISOString();
    task.state.lastDecisionLog = "escalated";
    await persist(task);
    await logger.log(task.taskId, "escalated", {
      reason: payload?.force ? "force=true" : undefined,
    });
    return task;
  }

  async function applyAcknowledge(task: ScheduledTask): Promise<ScheduledTask> {
    // §7.6: acknowledged is non-terminal. Pipeline.onComplete does NOT fire.
    task.state.status = "acknowledged";
    task.state.acknowledgedAt = now().toISOString();
    task.state.lastDecisionLog = "acknowledged";
    await persist(task);
    await logger.log(task.taskId, "acknowledged");
    return task;
  }

  async function applyEdit(
    task: ScheduledTask,
    payload: Partial<Omit<ScheduledTask, "taskId" | "state">> | undefined,
  ): Promise<ScheduledTask> {
    if (!payload) return task;
    // Cannot edit through state — that's what verbs are for — and cannot edit
    // through `__proto__`, which `Object.assign` would route to
    // `Object.prototype`'s setter (see SCHEDULED_TASK_EDIT_READONLY_KEYS).
    // `Object.hasOwn`, not `in`: `"__proto__" in payload` is true for every
    // ordinary object.
    for (const key of SCHEDULED_TASK_EDIT_READONLY_KEYS) {
      if (Object.hasOwn(payload as Record<string, unknown>, key)) {
        throw new Error(`edit: ${key} is read-only`);
      }
    }
    Object.assign(task, payload);
    await persist(task);
    await logger.log(task.taskId, "edited", {
      detail: { keys: Object.keys(payload) },
    });
    return task;
  }

  async function applyReopen(
    task: ScheduledTask,
    payload: { reason?: string } | undefined,
  ): Promise<ScheduledTask> {
    if (!isTerminal(task.state.status)) {
      throw new Error(
        `reopen: task ${task.taskId} is not in a terminal state (status=${task.state.status})`,
      );
    }
    // §8.12: late-inbound reopen window default 24h after lastFollowupAt;
    // configurable via metadata.reopenWindowHours.
    const windowHours = (() => {
      const raw = task.metadata?.reopenWindowHours;
      return typeof raw === "number" && raw > 0 ? raw : 24;
    })();
    const referenceIso =
      task.state.lastFollowupAt ??
      task.state.firedAt ??
      task.state.completedAt ??
      now().toISOString();
    const expiresMs =
      new Date(referenceIso).getTime() + windowHours * 60 * 60 * 1000;
    if (now().getTime() > expiresMs) {
      throw new Error(
        `reopen: window expired (>${windowHours}h since ${referenceIso})`,
      );
    }
    task.state.status = "scheduled";
    task.state.lastDecisionLog = payload?.reason ?? "reopened";
    clearEscalationCursor(task);
    await persist(task);
    await logger.log(task.taskId, "reopened", { reason: payload?.reason });
    return task;
  }

  function lifecycleMutation(
    task: ScheduledTask,
    verb: ScheduledTaskReceiptVerb,
    payload: unknown,
  ): LifecycleMutation {
    switch (verb) {
      case "snooze":
        return mutateSnooze(
          task,
          payload as { minutes?: number; untilIso?: string },
        );
      case "complete":
        return mutateComplete(task, payload as { reason?: string });
      case "dismiss":
        return mutateDismiss(task, payload as { reason?: string });
    }
  }

  function isApplyReceiptMarkerPresent(
    task: ScheduledTask,
    receiptKey: string,
  ): boolean {
    const receipts = task.metadata?.[APPLY_RECEIPTS_METADATA_KEY];
    return (
      receipts !== null &&
      typeof receipts === "object" &&
      !Array.isArray(receipts) &&
      Object.hasOwn(receipts, receiptKey)
    );
  }

  function transitionForReceiptVerb(
    verb: ScheduledTaskReceiptVerb,
  ): LifecycleMutation["transition"] {
    switch (verb) {
      case "snooze":
        return "snoozed";
      case "complete":
        return "completed";
      case "dismiss":
        return "dismissed";
    }
  }

  function sameApplyCommit(
    left: ScheduledTaskLogEntry,
    right: ScheduledTaskLogEntry,
  ): boolean {
    return (
      left.logId === right.logId &&
      left.agentId === right.agentId &&
      left.taskId === right.taskId &&
      left.transition === right.transition &&
      left.occurredAtIso === right.occurredAtIso &&
      left.detail?.receiptKey === right.detail?.receiptKey &&
      left.detail?.verb === right.detail?.verb
    );
  }

  async function reconcileApplyCommit(
    commit: ScheduledTaskLogEntry,
  ): Promise<ScheduledTaskLogEntry> {
    const entries = await deps.logStore.list({
      agentId: deps.agentId,
      taskId: commit.taskId,
      excludeRollups: true,
    });
    const existing = entries.find((entry) => entry.logId === commit.logId);
    if (existing) {
      if (!sameApplyCommit(existing, commit)) {
        throw new Error(
          `Scheduled task apply receipt ${commit.logId} does not match its committed row`,
        );
      }
      return existing;
    }

    try {
      await deps.logStore.append(commit);
      return commit;
    } catch (error) {
      // error-policy:J1 The durable-store boundary resolves a concurrent
      // append by reading the receipt row back before surfacing it.
      const raced = (
        await deps.logStore.list({
          agentId: deps.agentId,
          taskId: commit.taskId,
          excludeRollups: true,
        })
      ).find((entry) => entry.logId === commit.logId);
      if (raced && sameApplyCommit(raced, commit)) return raced;
      throw error;
    }
  }

  async function applyWithResult(
    taskId: string,
    verb: ScheduledTaskReceiptVerb,
    payload: unknown,
    options: {
      idempotencyKey: string;
      receiptContext?: Record<string, unknown>;
    },
  ): Promise<ScheduledTaskApplyResult> {
    const idempotencyKey = normalizeApplyIdempotencyKey(options.idempotencyKey);
    const receiptKey = await applyReceiptKey(verb, idempotencyKey);
    const existingTask = await deps.store.get(taskId);
    if (!existingTask) {
      throw new Error(`applyWithResult: task ${taskId} not found`);
    }

    const replayCandidate = isApplyReceiptMarkerPresent(
      existingTask,
      receiptKey,
    );
    const mutation: LifecycleMutation = replayCandidate
      ? {
          task: structuredClone(existingTask),
          transition: transitionForReceiptVerb(verb),
        }
      : lifecycleMutation(structuredClone(existingTask), verb, payload);
    if (!replayCandidate) {
      writeApplyReceiptMarker(
        mutation.task,
        receiptKey,
        options.receiptContext,
      );
    }
    const proposedCommit: ScheduledTaskLogEntry = {
      logId: await applyReceiptLogId({
        agentId: deps.agentId,
        taskId,
        verb,
        idempotencyKey,
      }),
      taskId,
      agentId: deps.agentId,
      occurredAtIso: now().toISOString(),
      transition: mutation.transition,
      reason: mutation.reason,
      rolledUp: false,
      detail: {
        ...(mutation.detail ?? {}),
        receiptKey,
        verb,
      },
    };
    const committed = await deps.store.commitApply({
      task: mutation.task,
      receiptKey,
      commit: proposedCommit,
      nextFireAtIso: await resolveNextFireAt(mutation.task),
    });
    if (
      committed.commit.logId !== proposedCommit.logId ||
      committed.commit.agentId !== deps.agentId ||
      committed.commit.taskId !== taskId ||
      committed.commit.transition !== transitionForReceiptVerb(verb) ||
      committed.commit.detail?.receiptKey !== receiptKey ||
      committed.commit.detail?.verb !== verb
    ) {
      throw new Error(
        `applyWithResult: store returned an invalid receipt for ${verb} ${taskId}`,
      );
    }
    const commit = await reconcileApplyCommit(committed.commit);
    if (commit.transition === "completed") {
      await settleTerminal(committed.task, "completed", commit.logId);
    } else if (commit.transition === "dismissed") {
      await settleTerminal(committed.task, "dismissed", commit.logId);
    } else if (commit.transition !== "snoozed") {
      throw new Error(
        `applyWithResult: receipt ${commit.logId} has unsupported transition ${commit.transition}`,
      );
    }
    return {
      task: committed.task,
      commit,
      idempotencyKey,
      replayed: committed.kind === "replayed",
    };
  }

  async function reserveApplyIntent(
    taskId: string,
    options: {
      idempotencyKey: string;
      context: Record<string, unknown>;
    },
  ): Promise<ScheduledTaskApplyIntentResult> {
    const idempotencyKey = normalizeApplyIdempotencyKey(options.idempotencyKey);
    const intentKey = await applyIntentKey(idempotencyKey);
    const existingTask = await deps.store.get(taskId);
    if (!existingTask) {
      throw new Error(`reserveApplyIntent: task ${taskId} not found`);
    }
    const proposal = structuredClone(existingTask);
    writeApplyIntentMarker(proposal, intentKey, options.context);
    const committed = await deps.store.reserveApplyIntent({
      task: proposal,
      intentKey,
    });
    const committedContext = await scheduledTaskApplyIntentContext(
      committed.task,
      idempotencyKey,
    );
    if (
      !committedContext ||
      stableStringify(committedContext) !== stableStringify(options.context)
    ) {
      throw new Error(
        `reserveApplyIntent: conflicting context for task ${taskId} and idempotency key`,
      );
    }
    return {
      task: committed.task,
      idempotencyKey,
      replayed: committed.kind === "replayed",
    };
  }

  async function apply(
    taskId: string,
    verb: ScheduledTaskVerb,
    payload?: unknown,
  ): Promise<ScheduledTask> {
    const task = await deps.store.get(taskId);
    if (!task) {
      throw new Error(`apply: task ${taskId} not found`);
    }
    switch (verb) {
      case "snooze":
        return applySnooze(
          task,
          payload as { minutes?: number; untilIso?: string },
        );
      case "skip":
        return applySkip(task, payload as { reason?: string });
      case "complete":
        return applyComplete(task, payload as { reason?: string });
      case "dismiss":
        return applyDismiss(task, payload as { reason?: string });
      case "escalate":
        return applyEscalate(task, payload as { force?: boolean });
      case "acknowledge":
        return applyAcknowledge(task);
      case "edit":
        return applyEdit(
          task,
          payload as Partial<Omit<ScheduledTask, "taskId" | "state">>,
        );
      case "reopen":
        return applyReopen(task, payload as { reason?: string });
      default: {
        const exhaustive: never = verb;
        throw new Error(`apply: unknown verb ${String(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline propagation + after_task chaining
  // -------------------------------------------------------------------------

  /**
   * Fire every `scheduled` task whose trigger is
   * `{ kind: "after_task", taskId: parent, outcome }`. This is the push side
   * of the `after_task` contract (`isScheduledTaskDue` reports these tasks
   * not-due, so the tick never wall-clock fires them). Firing goes through
   * `fireWithResult`, whose atomic claim makes concurrent terminal
   * transitions race-safe — one dispatch per child, losers observe `raced`.
   *
   * Unlike `pipeline.on*` (declared on the parent), `after_task` is declared
   * on the CHILD, so chains can be attached without editing the parent, and
   * they cover ALL five terminal outcomes (`pipeline` only propagates
   * completed / skipped / failed).
   */
  async function fireAfterTaskChildren(
    parent: ScheduledTask,
    outcome: TerminalState,
  ): Promise<void> {
    const scheduled = await deps.store.list({ status: "scheduled" });
    for (const child of scheduled) {
      if (child.trigger.kind !== "after_task") continue;
      if (child.trigger.taskId !== parent.taskId) continue;
      if (child.trigger.outcome !== outcome) continue;
      await fireWithResult(child.taskId, {
        eventPayload: { afterTask: { taskId: parent.taskId, outcome } },
      });
    }
  }

  /**
   * The single terminal-transition seam: propagate `pipeline.on*` refs, then
   * fire matching `after_task` children. Every runner path that records a
   * terminal outcome routes through here (the global-pause skip deliberately
   * does not — pause suppresses chaining).
   */
  async function settleTerminal(
    parent: ScheduledTask,
    outcome: TerminalState,
    settlementKey?: string,
  ): Promise<ScheduledTask[]> {
    const created = await runPipeline(parent, outcome, settlementKey);
    await fireAfterTaskChildren(parent, outcome);
    return created;
  }

  async function runPipeline(
    parent: ScheduledTask,
    outcome: TerminalState,
    settlementKey?: string,
  ): Promise<ScheduledTask[]> {
    const refs: ScheduledTaskRef[] | undefined = (() => {
      switch (outcome) {
        case "completed":
          return parent.pipeline?.onComplete;
        case "skipped":
          return parent.pipeline?.onSkip;
        case "failed":
          return parent.pipeline?.onFail;
        // expired / dismissed do not propagate; pipeline.onSkip captures
        // the user-skip case explicitly.
        default:
          return undefined;
      }
    })();
    if (!refs || refs.length === 0) return [];
    const created: ScheduledTask[] = [];
    for (const [index, ref] of refs.entries()) {
      if (typeof ref === "string") {
        const child = await deps.store.get(ref);
        if (child && child.state.pipelineParentId !== parent.taskId) {
          // Mark the parent linkage on the child for observability.
          child.state.pipelineParentId = parent.taskId;
          await persist(child);
          await logger.log(child.taskId, "edited", {
            reason: `pipeline.${outcomeToFieldName(outcome)} parent=${parent.taskId}`,
          });
          created.push(child);
        }
        continue;
      }
      const cloned = structuredClone(ref);
      // Strip server-managed fields if the caller passed a fully-shaped
      // `ScheduledTask`. `schedule()` regenerates them.
      const childInput = stripServerManaged(cloned);
      if (settlementKey && !childInput.idempotencyKey) {
        childInput.idempotencyKey = [
          "scheduled-pipeline",
          parent.taskId,
          outcome,
          settlementKey,
          index,
        ].join(":");
      }
      const fresh = await schedule(childInput);
      fresh.state.pipelineParentId = parent.taskId;
      await persist(fresh);
      created.push(fresh);
    }
    return created;
  }

  function outcomeToFieldName(outcome: TerminalState): string {
    switch (outcome) {
      case "completed":
        return "onComplete";
      case "skipped":
        return "onSkip";
      case "failed":
        return "onFail";
      default:
        return outcome;
    }
  }

  async function pipeline(
    taskId: string,
    outcome: TerminalState,
  ): Promise<ScheduledTask[]> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`pipeline: task ${taskId} not found`);
    // D12: when callers invoke pipeline("failed") (or any terminal state the
    // runner has not recorded), bring the parent's terminal state into
    // alignment with the dispatched outcome before propagating to children.
    // `apply("complete" | "skip")` already writes the matching status, so we
    // only flip when the parent is still live and the outcome differs.
    if (!isTerminal(task.state.status) && task.state.status !== outcome) {
      task.state.status = outcome;
      task.state.lastDecisionLog = `pipeline: ${outcome}`;
      if (outcome === "completed" && !task.state.completedAt) {
        task.state.completedAt = now().toISOString();
      }
      await persist(task);
      await logger.log(task.taskId, outcome, {
        reason: `pipeline: ${outcome}`,
      });
    }
    return settleTerminal(task, outcome);
  }

  // -------------------------------------------------------------------------
  // Fire / evaluate completion
  // -------------------------------------------------------------------------

  async function fire(
    taskId: string,
    args?: {
      eventPayload?: unknown;
      allowTerminalRefire?: boolean;
      recoverFiredAtIso?: string;
    },
  ): Promise<ScheduledTask> {
    const result = await fireWithResult(taskId, args);
    switch (result.kind) {
      case "fired":
      case "skipped":
      case "dispatch_deferred":
      case "dispatch_failed":
        return result.task;
      case "raced": {
        // The caller did not opt in to seeing race outcomes; re-read the
        // row the winning tick committed so observers still see a coherent
        // post-claim ScheduledTask instead of stale pre-claim state.
        const winner = await deps.store.get(result.taskId);
        if (winner) return winner;
        throw new Error(`fire: task ${result.taskId} not found after race`);
      }
      default: {
        const _exhaustive: never = result;
        throw new Error("fire: unreachable");
      }
    }
  }

  /**
   * Record a claimed task as `failed` and return the `dispatch_failed`
   * outcome. Shared by two callers: (1) the dispatcher THREW, and (2) the
   * dispatcher RETURNED a non-retriable `DispatchResult { ok: false }`. Both
   * mean the user-visible send did not happen, so history must not strand the
   * row as successfully `fired`. The failure runs `pipeline.onFail` exactly
   * like the throw path always has.
   *
   * `dispatchResult` is attached to `metadata.lastDispatchResult` on the
   * returned-failure path so the connector-degradation surface can read the
   * typed reason; on the throw path there is no result to attach.
   */
  async function recordDispatchFailure(
    claimed: ScheduledTask,
    failure: { error: Error; dispatchResult?: DispatchResult },
  ): Promise<ScheduledTaskFireResult> {
    const reason = `dispatch_failed: ${failure.error.message}`;
    claimed.state.status = "failed";
    claimed.state.lastDecisionLog = reason;
    clearPendingDispatch(claimed);
    claimed.metadata = {
      ...(claimed.metadata ?? {}),
      lastDispatchError: {
        name: failure.error.name,
        message: failure.error.message,
      },
      ...(failure.dispatchResult
        ? { lastDispatchResult: failure.dispatchResult }
        : {}),
    };
    // A verb that landed while the dispatcher was in flight owns the row's
    // lifecycle now: skip the failed write, its state-log row, and the
    // onFail pipeline so history records only the user's settlement.
    const persisted = await persist(claimed, { expectedStatus: "fired" });
    if (!persisted) {
      return { kind: "raced", taskId: claimed.taskId };
    }
    await logger.log(claimed.taskId, "failed", {
      reason,
      detail: {
        errorName: failure.error.name,
        message: failure.error.message,
      },
    });
    await settleTerminal(claimed, "failed");
    return { kind: "dispatch_failed", task: claimed, error: failure.error };
  }

  async function fireWithResult(
    taskId: string,
    args?: {
      eventPayload?: unknown;
      allowTerminalRefire?: boolean;
      recoverFiredAtIso?: string;
    },
  ): Promise<ScheduledTaskFireResult> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`fire: task ${taskId} not found`);
    const expectedMetadata = deps.executionBoundary
      ? structuredClone(task.metadata ?? {})
      : undefined;
    return deps.executionBoundary
      ? deps.executionBoundary(task, () =>
          fireLoadedTaskWithResult(task, args, expectedMetadata),
        )
      : fireLoadedTaskWithResult(task, args, expectedMetadata);
  }

  async function fireLoadedTaskWithResult(
    task: ScheduledTask,
    args?: {
      eventPayload?: unknown;
      allowTerminalRefire?: boolean;
      recoverFiredAtIso?: string;
    },
    expectedMetadata?: NonNullable<ScheduledTask["metadata"]>,
  ): Promise<ScheduledTaskFireResult> {
    const taskId = task.taskId;
    const hasEventPayload =
      Object.hasOwn(args ?? {}, "eventPayload") &&
      args?.eventPayload !== undefined;
    const eventPayload = hasEventPayload
      ? normalizeScheduledEventPayload(args?.eventPayload, taskId)
      : undefined;
    // Recurrence refire: `allowTerminalRefire` authorizes claiming the DUE
    // next occurrence of a RECURRING task whose row is parked in a
    // non-`scheduled` status — `fired` (zombie: nothing ever completed the
    // previous occurrence), `acknowledged` (non-terminal by design), or a
    // terminal state (`completed` / `skipped` / `expired` / `failed`).
    // `dismissed` never refires; non-recurring triggers never refire.
    //
    // Race safety: there is deliberately NO reopen-then-claim two-step here.
    // A pre-claim `persist(status = "scheduled")` is last-write-wins, so two
    // concurrent ticks could each reopen and one could claim the other's
    // reopen — double-fire. Instead the single atomic claim below CASes on
    // the `(status, firedAt)` pair this read observed
    // (see {@link ScheduledTaskClaimExpectation}); the winner rewrites
    // `firedAt`, which invalidates the loser's expectation even when both
    // observed the same status.
    const recoveryClaim = args?.recoverFiredAtIso !== undefined;
    if (
      recoveryClaim &&
      (task.state.status !== "fired" ||
        task.state.firedAt !== args.recoverFiredAtIso)
    ) {
      return { kind: "raced", taskId: task.taskId };
    }
    const refireClaim =
      args?.allowTerminalRefire === true &&
      task.state.status !== "scheduled" &&
      task.state.status !== "dismissed" &&
      isRecurringTrigger(task.trigger);
    if (isTerminal(task.state.status) && !refireClaim) {
      // Idempotent — already settled; report skipped so callers do not
      // double-count this as a fresh fire.
      return {
        kind: "skipped",
        task,
        reason: `terminal:${task.state.status}`,
      };
    }
    if (refireClaim) {
      // Re-verify dueness on the FRESH row before claiming. The scheduler
      // tick evaluated dueness against a candidate row read at tick entry;
      // if a parallel tick already claimed this occurrence and fully
      // persisted before our read above, the CAS below would match the NEW
      // `(fired, firedAt)` pair and double-fire the same occurrence. A
      // just-refired row's trigger-derived next occurrence is in the future,
      // so the loser bails here as `raced` (no dispatch, no log noise).
      const ownerFacts = await deps.ownerFacts();
      const freshDecision = await isScheduledTaskDue(task, {
        now: now(),
        ownerFacts,
        anchors: deps.anchors,
      });
      if (!freshDecision.due) {
        return { kind: "raced", taskId: task.taskId };
      }
    }

    await logger.log(task.taskId, "fire_attempt", {
      detail: {
        eventPayload: Object.hasOwn(args ?? {}, "eventPayload")
          ? "present"
          : "absent",
      },
    });

    // Global-pause check.
    const pause = await shouldDeferForGlobalPause(task);
    if (pause.paused) {
      task.state.status = "skipped";
      task.state.lastDecisionLog = pause.reason ?? "global_pause";
      await persist(task);
      await logger.log(task.taskId, "skipped", {
        reason: pause.reason ?? "global_pause",
      });
      return {
        kind: "skipped",
        task,
        reason: pause.reason ?? "global_pause",
      };
    }

    // Gate check.
    const gateOutcome = await evaluateGates(task);
    if (gateOutcome.decision.kind === "deny") {
      task.state.status = "skipped";
      task.state.lastDecisionLog = `${gateOutcome.gateKind ?? "gate"}: ${gateOutcome.decision.reason}`;
      await persist(task);
      await logger.log(task.taskId, "skipped", {
        reason: task.state.lastDecisionLog,
      });
      await settleTerminal(task, "skipped");
      return {
        kind: "skipped",
        task,
        reason: task.state.lastDecisionLog,
      };
    }
    if (gateOutcome.decision.kind === "defer") {
      const nowMs = now().getTime();
      const offset =
        "offsetMinutes" in gateOutcome.decision.until
          ? gateOutcome.decision.until.offsetMinutes
          : Math.max(
              1,
              Math.round(
                (new Date(gateOutcome.decision.until.atIso).getTime() - nowMs) /
                  60_000,
              ),
            );
      const newFireMs = projectMinuteOffsetMs(nowMs, offset);
      if (newFireMs === null) {
        throw new ElizaError(
          "gate defer: offset must be non-negative and project to a representable Date",
          {
            code: "SCHEDULED_TASK_GATE_DEFER_PROJECTION_INVALID",
            context: {
              gateKind: gateOutcome.gateKind ?? "gate",
              offsetMinutes: offset,
            },
          },
        );
      }
      task.state.lastDecisionLog = `${gateOutcome.gateKind ?? "gate"}: deferred ${offset}m (${gateOutcome.decision.reason})`;
      if (refireClaim) {
        // Park the deferred occurrence as a plain scheduled-override so it
        // fires AT the defer time (`scheduledOverrideDue`), not at the
        // trigger's next natural occurrence. This reopens the row from its
        // parked status; the write is last-write-wins across concurrent
        // ticks, which is safe here because both write the same target state
        // and no dispatch happens without the atomic claim below.
        task.state.status = "scheduled";
        delete task.state.acknowledgedAt;
        delete task.state.completedAt;
        clearEscalationCursor(task);
        clearPendingDispatch(task);
      }
      task.state.firedAt = new Date(newFireMs).toISOString();
      await persist(task);
      await logger.log(task.taskId, "snoozed", {
        reason: `gate-defer: ${gateOutcome.decision.reason}`,
        detail: { offsetMinutes: offset },
      });
      return {
        kind: "skipped",
        task,
        reason: `gate-defer:${gateOutcome.decision.reason}`,
      };
    }

    // Allow → atomic claim. For a fresh fire the store does UPDATE … WHERE
    // status='scheduled' RETURNING * so exactly one parallel caller can
    // transition `scheduled` → `fired`. For a recurrence refire the claim
    // CASes on the observed `(status, firedAt)` pair instead. Concurrent
    // ticks see `kind: "raced"` and bail.
    const fireAtIso = now().toISOString();
    const claim = await deps.store.claimForFire({
      taskId: task.taskId,
      firedAtIso: fireAtIso,
      ...(expectedMetadata !== undefined ? { expectedMetadata } : {}),
      ...(refireClaim || recoveryClaim
        ? {
            expected: {
              status: task.state.status,
              firedAtIso: task.state.firedAt ?? null,
            },
          }
        : {}),
    });
    if (claim.kind === "raced") {
      return { kind: "raced", taskId: task.taskId };
    }
    const claimed = claim.task;
    if (recoveryClaim && args?.recoverFiredAtIso) {
      const persistedDispatchKey = claimed.metadata?.dispatchIdempotencyKey;
      const dispatchIdempotencyKey =
        typeof persistedDispatchKey === "string" &&
        persistedDispatchKey.trim().length > 0
          ? persistedDispatchKey.trim()
          : `${claimed.taskId}:${args.recoverFiredAtIso}`;
      claimed.metadata = {
        ...(claimed.metadata ?? {}),
        dispatchIdempotencyKey,
        recoveredDispatchAtIso: fireAtIso,
      };
      await logger.log(claimed.taskId, "reopened", {
        reason: "stale bound dispatch recovery",
      });
    }
    if (refireClaim) {
      // Fresh occurrence: drop the previous occurrence's response state and
      // any dispatch continuation — the new occurrence starts at the initial
      // channel with a clean ladder. Persisted below with the post-claim
      // metadata.
      delete claimed.state.acknowledgedAt;
      delete claimed.state.completedAt;
      clearEscalationCursor(claimed);
      clearPendingDispatch(claimed);
      await logger.log(claimed.taskId, "reopened", {
        reason: "recurrence refire",
      });
    }
    claimed.state.lastDecisionLog = "fired";
    // A pending continuation (retry / ladder advance from a previous typed
    // dispatch failure) routes this attempt through its recorded ladder
    // step; a fresh fire starts at the initial channel (cursor -1).
    const pending = readPendingDispatch(claimed);
    if (!pending && !recoveryClaim) {
      // A fresh occurrence owns a new durable dispatch identity. Persist it
      // before rendering/provider egress so retries and crash recovery reuse
      // the same connector dedupe key and exact prepared payload. Never trust
      // caller-supplied values in these internal metadata fields.
      claimed.metadata = {
        ...(claimed.metadata ?? {}),
        dispatchIdempotencyKey: `${claimed.taskId}:${fireAtIso}`,
      };
      delete claimed.metadata.dispatchPreparedMessage;
      delete claimed.metadata.dispatchAttempt;
      delete claimed.metadata.recoveredDispatchAtIso;
    }
    const ladder = resolveEffectiveLadder(claimed, deps.ladders);
    const pendingStep =
      pending && pending.stepIndex >= 0
        ? (ladder.steps[pending.stepIndex] ?? null)
        : null;
    setEscalationCursor(claimed, {
      stepIndex: pending?.stepIndex ?? -1,
      lastDispatchedAt: fireAtIso,
    });
    // Persist the post-claim metadata (escalationCursor, lastDecisionLog).
    // `persist` recomputes `next_fire_at` from the now-`fired` row. The
    // status guard keeps a verb that landed between the claim and this write
    // authoritative: if the row moved off `fired`, the user already settled
    // the task and this fire must not dispatch (or log) at all.
    const claimedPersisted = await persist(claimed, {
      expectedStatus: "fired",
    });
    if (!claimedPersisted) {
      return { kind: "raced", taskId: claimed.taskId };
    }
    await logger.log(claimed.taskId, "fired");

    // Host-capability gate. If the host can't satisfy the task's profile,
    // rewrite the dispatch channel to `in_app` (notify-only) and record a
    // "substituted" log row. The substitution does not change the task's
    // status — it merely shifts the wire-out mechanism so a `bg-heavy-fgs`
    // task on iOS becomes a banner the user can tap.
    const hostCaps = deps.hostCapabilities?.() ?? ALL_PROFILES_AVAILABLE;
    const taskProfile =
      claimed.executionProfile ?? DEFAULT_TASK_EXECUTION_PROFILE;
    const substituted = !hostCaps.has(taskProfile);
    const dispatchChannelKey = substituted
      ? "in_app"
      : (pendingStep?.channelKey ?? pickChannelKey(claimed));
    if (substituted) {
      await logger.log(claimed.taskId, "substituted", {
        reason: "host_incapable",
        detail: {
          originalProfile: taskProfile,
          substituteProfile: "notify-only" satisfies TaskExecutionProfile,
          availableProfiles: Array.from(hostCaps),
        },
      });
    }

    const hasDispatchEventPayload =
      hasEventPayload ||
      Boolean(pending && Object.hasOwn(pending, "eventPayload"));
    const dispatchEventPayload = hasEventPayload
      ? eventPayload
      : pending?.eventPayload;
    let dispatchResult: DispatchResult | undefined;
    try {
      dispatchResult = await dispatcher.dispatch({
        taskId: claimed.taskId,
        kind: claimed.kind,
        firedAtIso: fireAtIso,
        channelKey: dispatchChannelKey,
        intensity: pendingStep?.intensity ?? pickIntensity(claimed),
        promptInstructions: claimed.promptInstructions,
        contextRequest: claimed.contextRequest,
        ...(claimed.subject ? { subject: claimed.subject } : {}),
        ownerVisible: claimed.ownerVisible,
        ...(hasDispatchEventPayload
          ? { eventPayload: dispatchEventPayload }
          : {}),
        output: claimed.output,
        metadata: claimed.metadata,
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      return recordDispatchFailure(claimed, { error: wrapped });
    }

    if (dispatchResult) {
      claimed.metadata = {
        ...(claimed.metadata ?? {}),
        lastDispatchResult: dispatchResult,
      };
      if (dispatchResult.ok === false) {
        return applyDispatchPolicy({
          task: claimed,
          failure: dispatchResult,
          pending,
          ladder,
          fireAtIso,
          ...(hasDispatchEventPayload
            ? { eventPayload: dispatchEventPayload }
            : {}),
        });
      }
      const pendingPromptRoomId = claimed.completionCheck
        ? pendingPromptRoomIdForTask(claimed, {
            agentId: deps.agentId,
            channelKey: dispatchResult.channelKey ?? dispatchChannelKey,
            target: dispatchResult.target,
          })
        : null;
      if (pendingPromptRoomId) {
        claimed.metadata.pendingPromptRoomId = pendingPromptRoomId;
      }
      clearPendingDispatch(claimed);
      // The dispatch already reached the user, so the fire itself stands;
      // the guard only stops this stale snapshot from reverting a verb that
      // landed mid-flight. Surface the authoritative row either way.
      const persisted = await persist(claimed, { expectedStatus: "fired" });
      if (!persisted) {
        const current = await deps.store.get(claimed.taskId);
        return { kind: "fired", task: current ?? claimed };
      }
    } else {
      // Void dispatchers (e.g. notify-only event emitters) report no typed
      // result; a completed call is success, so drop the continuation.
      const pendingPromptRoomId = claimed.completionCheck
        ? pendingPromptRoomIdForTask(claimed, {
            agentId: deps.agentId,
            channelKey: dispatchChannelKey,
          })
        : null;
      if (pendingPromptRoomId) {
        claimed.metadata = {
          ...(claimed.metadata ?? {}),
          pendingPromptRoomId,
        };
      }
      if (pending) clearPendingDispatch(claimed);
      if (pending || pendingPromptRoomId) {
        const persisted = await persist(claimed, { expectedStatus: "fired" });
        if (!persisted) {
          const current = await deps.store.get(claimed.taskId);
          return { kind: "fired", task: current ?? claimed };
        }
      }
    }
    return { kind: "fired", task: claimed };
  }

  /**
   * Enforce {@link decideDispatchPolicy} on a typed dispatch failure.
   *
   * Before this, an `{ ok: false }` DispatchResult was stashed in metadata
   * and the fire still reported `"fired"` — the user silently never received
   * the message and the documented retry/backoff/escalation policy was dead
   * code (#10721 H2).
   *
   * - `retry` → same step, bounded by {@link MAX_DISPATCH_RETRIES_PER_STEP};
   *   over budget it degrades to `advance` (or `fail` on the last step).
   * - `advance` / `surface_degraded` → next ladder step at its `delayMinutes`
   *   offset; `surface_degraded` additionally records
   *   `metadata.connectorDegradation` for the degradation provider.
   * - `fail` → terminal `"failed"`, `pipeline.onFail` fires.
   *
   * Retry/advance park the task back in `"scheduled"` with `state.firedAt` =
   * next attempt time — the scheduled-override the tick's due evaluation and
   * the `next_fire_at` index both honor.
   */
  async function applyDispatchPolicy(args: {
    task: ScheduledTask;
    failure: Extract<DispatchResult, { ok: false }>;
    pending: PendingDispatch | null;
    ladder: ReturnType<typeof resolveEffectiveLadder>;
    fireAtIso: string;
    eventPayload?: unknown;
  }): Promise<ScheduledTaskFireResult> {
    const { task, failure, pending, ladder, fireAtIso } = args;
    const hasEventPayload = Object.hasOwn(args, "eventPayload");
    // Policy step space: index 0 = the initial/default-channel attempt,
    // 1..n = ladder steps. `pending.stepIndex` is in ladder space (-1 =
    // initial attempt), hence the +1 shift.
    const ladderIndex = pending?.stepIndex ?? -1;
    const attempt = pending?.attempt ?? 0;
    const totalSteps = ladder.steps.length + 1;
    let decision = decideDispatchPolicy(failure, {
      currentStepIndex: ladderIndex + 1,
      totalSteps,
    });
    if (decision.kind === "retry" && attempt >= MAX_DISPATCH_RETRIES_PER_STEP) {
      // Retry budget for this step is exhausted — force the ladder forward.
      const isLastStep = ladderIndex + 1 >= totalSteps - 1;
      decision = isLastStep
        ? { kind: "fail", reason: failure.reason, message: failure.message }
        : { kind: "advance", reason: failure.reason, message: failure.message };
    }

    switch (decision.kind) {
      case "complete":
        // decideDispatchPolicy only returns `complete` for ok:true input.
        clearPendingDispatch(task);
        {
          const persisted = await persist(task, { expectedStatus: "fired" });
          if (!persisted) {
            const current = await deps.store.get(task.taskId);
            return { kind: "fired", task: current ?? task };
          }
        }
        return { kind: "fired", task };
      case "retry": {
        // `retryAfterMinutes` is connector-supplied and schema-unbounded; a
        // huge value would push the park-back instant past the JS Date range
        // and make `toISOString()` throw AFTER the row was atomically claimed
        // to `"fired"`, stranding it. Settle terminally instead of stranding.
        const nextAttemptMs = projectMinuteOffsetMs(
          Date.parse(fireAtIso),
          decision.retryAfterMinutes,
        );
        if (nextAttemptMs === null) {
          return failTerminal(task, decision.reason, failure.message);
        }
        const nextAttemptAtIso = new Date(nextAttemptMs).toISOString();
        task.state.status = "scheduled";
        task.state.firedAt = nextAttemptAtIso;
        task.state.lastDecisionLog = `dispatch retry ${attempt + 1}/${MAX_DISPATCH_RETRIES_PER_STEP} in ${decision.retryAfterMinutes}m (${decision.reason})`;
        setPendingDispatch(task, {
          stepIndex: ladderIndex,
          attempt: attempt + 1,
          ...(hasEventPayload ? { eventPayload: args.eventPayload } : {}),
        });
        // A verb that landed mid-flight owns the row: do not park it back
        // into `scheduled` (that would resurrect a settled task) and do not
        // write the retry log row for a persistence that never happened.
        const persisted = await persist(task, { expectedStatus: "fired" });
        if (!persisted) {
          return { kind: "raced", taskId: task.taskId };
        }
        await logger.log(task.taskId, "dispatch_retried", {
          reason: decision.reason,
          detail: {
            attempt: attempt + 1,
            maxAttempts: MAX_DISPATCH_RETRIES_PER_STEP,
            retryAfterMinutes: decision.retryAfterMinutes,
            nextAttemptAtIso,
          },
        });
        return {
          kind: "dispatch_deferred",
          task,
          reason: `retry:${decision.reason}`,
          nextAttemptAtIso,
        };
      }
      case "advance":
      case "surface_degraded": {
        const next = await findNextAvailableLadderStep(ladder, ladderIndex + 1);
        if (!next) {
          if (decision.kind === "surface_degraded") {
            recordConnectorDegradation(task, decision, fireAtIso);
          }
          return failTerminal(task, decision.reason, decision.message);
        }
        const { nextLadderIndex, nextStep } = next;
        // `delayMinutes` is schema-valid but unbounded (schema.ts had no
        // upper limit); guard the park-back instant against the Date range so
        // a claimed row settles terminally instead of throwing while stranded
        // in `"fired"`.
        const nextAttemptMs = projectMinuteOffsetMs(
          Date.parse(fireAtIso),
          nextStep.delayMinutes,
        );
        if (nextAttemptMs === null) {
          if (decision.kind === "surface_degraded") {
            recordConnectorDegradation(task, decision, fireAtIso);
          }
          return failTerminal(task, decision.reason, decision.message);
        }
        const nextAttemptAtIso = new Date(nextAttemptMs).toISOString();
        task.state.status = "scheduled";
        task.state.firedAt = nextAttemptAtIso;
        task.state.lastDecisionLog = `dispatch advanced to ladder step ${nextLadderIndex} (${nextStep.channelKey}) after ${decision.reason}`;
        setPendingDispatch(task, {
          stepIndex: nextLadderIndex,
          attempt: 0,
          ...(hasEventPayload ? { eventPayload: args.eventPayload } : {}),
        });
        if (decision.kind === "surface_degraded") {
          recordConnectorDegradation(task, decision, fireAtIso);
        }
        // Same mid-flight guard as the retry path: a settled row must not be
        // parked back into `scheduled` for a ladder step it will never take.
        const persisted = await persist(task, { expectedStatus: "fired" });
        if (!persisted) {
          return { kind: "raced", taskId: task.taskId };
        }
        await logger.log(task.taskId, "escalated", {
          reason: `dispatch_failed:${decision.reason}`,
          detail: {
            nextStepIndex: nextLadderIndex,
            nextChannelKey: nextStep.channelKey,
            nextAttemptAtIso,
            degraded: decision.kind === "surface_degraded",
          },
        });
        return {
          kind: "dispatch_deferred",
          task,
          reason: `${decision.kind}:${decision.reason}`,
          nextAttemptAtIso,
        };
      }
      case "fail":
        return failTerminal(task, decision.reason, decision.message);
      default: {
        const _exhaustive: never = decision;
        throw new Error("applyDispatchPolicy: unreachable");
      }
    }
  }

  async function findNextAvailableLadderStep(
    ladder: ReturnType<typeof resolveEffectiveLadder>,
    startIndex: number,
  ): Promise<{
    nextLadderIndex: number;
    nextStep: (typeof ladder.steps)[number];
  } | null> {
    for (let i = startIndex; i < ladder.steps.length; i++) {
      const step = ladder.steps[i];
      if (!step) continue;
      if (
        !deps.channelAvailable ||
        (await deps.channelAvailable(step.channelKey))
      ) {
        return { nextLadderIndex: i, nextStep: step };
      }
    }
    return null;
  }

  function recordConnectorDegradation(
    task: ScheduledTask,
    decision: { kind: "surface_degraded"; reason: string; message?: string },
    fireAtIso: string,
  ): void {
    task.metadata = {
      ...(task.metadata ?? {}),
      connectorDegradation: {
        reason: decision.reason,
        message: decision.message,
        atIso: fireAtIso,
      },
    };
  }

  async function failTerminal(
    task: ScheduledTask,
    reason: string,
    message?: string,
  ): Promise<ScheduledTaskFireResult> {
    const detailMessage = message ? `${reason}: ${message}` : reason;
    task.state.status = "failed";
    task.state.lastDecisionLog = `dispatch_failed: ${detailMessage}`;
    clearPendingDispatch(task);
    task.metadata = {
      ...(task.metadata ?? {}),
      lastDispatchError: {
        name: "DispatchResultError",
        message: detailMessage,
      },
    };
    // Same post-claim guard as the success path: a verb that landed while
    // the failed dispatch was in flight owns the row, so neither the failed
    // write, its state-log row, nor the onFail pipeline may run.
    const persisted = await persist(task, { expectedStatus: "fired" });
    if (!persisted) {
      return { kind: "raced", taskId: task.taskId };
    }
    await logger.log(task.taskId, "failed", {
      reason: `dispatch_failed:${reason}`,
      detail: { message: detailMessage },
    });
    await settleTerminal(task, "failed");
    return {
      kind: "dispatch_failed",
      task,
      error: new Error(detailMessage),
    };
  }

  function pickChannelKey(task: ScheduledTask): string {
    if (
      task.output?.destination === "channel" &&
      typeof task.output.target === "string"
    ) {
      const [channelKey] = task.output.target.split(":", 1);
      if (channelKey) return channelKey;
    }
    if (task.escalation?.steps && task.escalation.steps.length > 0) {
      return task.escalation.steps[0]?.channelKey ?? "in_app";
    }
    // Priority does not currently influence default channel — the production
    // dispatcher always routes "in_app" through the event service. If
    // priority-based routing is added later, branch here.
    return "in_app";
  }

  function pickIntensity(task: ScheduledTask): "soft" | "normal" | "urgent" {
    if (task.priority === "high") return "urgent";
    if (task.priority === "medium") return "normal";
    return "soft";
  }

  async function evaluateCompletion(
    taskId: string,
    signal: { acknowledged?: boolean; repliedAtIso?: string },
  ): Promise<ScheduledTask> {
    const task = await deps.store.get(taskId);
    if (!task) throw new Error(`evaluateCompletion: task ${taskId} not found`);
    if (!task.completionCheck) return task;
    const contrib = deps.completionChecks.get(task.completionCheck.kind);
    if (!contrib) return task;
    const ownerFacts = await deps.ownerFacts();
    const ctx: CompletionCheckContext = {
      task,
      nowIso: now().toISOString(),
      ownerFacts,
      activity: deps.activity,
      subjectStore: deps.subjectStore,
      acknowledged: signal.acknowledged === true,
      repliedSinceFiredAt: signal.repliedAtIso
        ? { atIso: signal.repliedAtIso }
        : undefined,
    };
    const completed = await contrib.shouldComplete(task, ctx);
    if (!completed) return task;
    return applyComplete(task, { reason: `completion-check:${contrib.kind}` });
  }

  async function rolloverStateLog(opts?: { retentionDays?: number }) {
    const days = opts?.retentionDays ?? 90;
    const olderThanIso = new Date(
      now().getTime() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    return deps.logStore.rollupOlderThan({
      agentId: deps.agentId,
      olderThanIso,
    });
  }

  function inspectRegistries() {
    return {
      gates: deps.gates.list().map((g) => g.kind),
      completionChecks: deps.completionChecks.list().map((c) => c.kind),
      ladders: deps.ladders.list().map((l) => l.ladderKey),
      anchors: deps.anchors.list().map((a) => a.anchorKey),
      consolidationPolicies: deps.consolidation.list().map((p) => p.anchorKey),
    };
  }

  async function getEscalationCursor(
    taskId: string,
  ): Promise<EscalationCursorView | null> {
    const task = await deps.store.get(taskId);
    if (!task) return null;
    const raw = task.metadata?.escalationCursor;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const cursor = raw as { stepIndex?: unknown; lastDispatchedAt?: unknown };
    if (
      typeof cursor.stepIndex !== "number" ||
      typeof cursor.lastDispatchedAt !== "string"
    ) {
      return null;
    }
    const ladder = resolveEffectiveLadder(task, deps.ladders);
    const stepIndex = cursor.stepIndex;
    const channelKey =
      stepIndex >= 0 && stepIndex < ladder.steps.length
        ? (ladder.steps[stepIndex]?.channelKey ?? "in_app")
        : (ladder.steps[0]?.channelKey ?? "in_app");
    return {
      stepIndex,
      lastFiredAt: cursor.lastDispatchedAt,
      channelKey,
    };
  }

  return {
    scheduleWithResult,
    schedule,
    importTask,
    activateImportedTask,
    list,
    remove,
    apply,
    applyWithResult,
    reserveApplyIntent,
    pipeline,
    fire,
    fireWithResult,
    evaluateCompletion,
    rolloverStateLog,
    inspectRegistries,
    getEscalationCursor,
    resolveNextFireAt,
    resolveDueDecision,
    resolveOwnerFacts,
  };
}
