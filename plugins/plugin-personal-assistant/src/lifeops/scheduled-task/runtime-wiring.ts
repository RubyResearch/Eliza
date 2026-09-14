/**
 * Runtime wiring for the ScheduledTask spine.
 *
 * Bridges the runner's typed dependencies to the live `IAgentRuntime`: the
 * scheduling-owned SQL task/log stores, production dispatcher, owner facts,
 * global pause, the LifeOps subject store, and the runtime event → task-fire
 * bridge. The activity-bus view keeps a warn-once diagnostic stand-in until
 * `registerActivitySignalBus` runs in plugin init.
 */

import crypto from "node:crypto";
import {
  createLocalAgentBackup,
  getAgentEventService,
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  resolveOwnerContactWithFallback,
  resolveOwnerEntityId,
} from "@elizaos/agent";
import { getHostExecutionCapabilities } from "@elizaos/app-core/services/task-host-capabilities";
import {
  ElizaError,
  type IAgentRuntime,
  inspectSendHandlerResult,
  logger,
  ServiceType,
} from "@elizaos/core";
import type {
  ActivitySignalBusView,
  CompletionCheckContribution,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTaskDispatcher,
  ScheduledTaskDispatchRecord,
  ScheduledTaskLogStore,
  ScheduledTaskStore,
  SubjectStoreView,
  TaskExecutionProfile,
  TaskGateContribution,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  getAnchorRegistry,
  getScheduledTaskRunner,
  hasScheduledDispatchModel,
  installScheduledTaskEventBridge,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerFallbackAnchors,
  registerScheduledTaskRunnerDeps,
  renderFailureDispatchResult,
  renderScheduledDispatchMessage,
  renderScheduledDispatchTitle,
  type ScheduledTaskRunnerDepsBundle,
  type ScheduledTaskRunnerHandle,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { assembleMorningBrief } from "../../default-packs/morning-brief.js";
import { getChannelRegistry } from "../channels/index.js";
import type { DispatchResult } from "../connectors/contract.js";
import { decideDispatchPolicy } from "../connectors/dispatch-policy.js";
import { getConnectorRegistry } from "../connectors/registry.js";
import { resolveDefaultTimeZone } from "../defaults.js";
import { FAMILY_BACKUP_CLEANUP_OPERATION } from "../family-workflows/backup-cleanup-schedule.js";
import {
  FAMILY_MONTHLY_SYSTEM_OPERATION,
  getFamilyWorkflowRuntimeService,
} from "../family-workflows/index.js";
import { withFamilyScheduledExecution } from "../family-workflows/scheduled-execution.js";
import { createFamilySchedulingStores } from "../family-workflows/scheduled-store.js";
import { purgeFamilyBackupCleanup } from "../family-workflows/workspace-deletion.js";
import { resolveGlobalPauseStore } from "../global-pause/store.js";
import { registerHouseholdGrantExpiryWarningGate } from "../household/grant-expiry-warning.js";
import { HouseholdCoordinationRepository } from "../household/repository.js";
import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { getEventKindRegistry } from "../registries/event-kind-registry.js";
import { LifeOpsRepository } from "../repository.js";
import { preferEffectiveMergedState } from "../schedule-state.js";
import { getSendPolicyRegistry } from "../send-policy/index.js";
import { getActivitySignalBus } from "../signals/bus.js";
import {
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getZonedDateParts,
} from "../time.js";
import {
  behaviouralBaselineFromProfile,
  readActivityProfile,
  registerActivityProfileGates,
} from "./activity-gates.js";
import {
  readScheduledTaskChatDeliveryBinding,
  revalidateScheduledTaskChatDeliveryBinding,
} from "./delivery-binding.js";
import { resolveScheduledTaskDispatchContext } from "./dispatch-context.js";
import { registerModelMomentCheckGate } from "./moment-judge.js";
import { createLifeOpsSubjectStoreView } from "./subject-store.js";

interface RepositoryBackedStores {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
}

const subjectStoresByRuntime = new WeakMap<IAgentRuntime, SubjectStoreView>();

const QUOTA_OCCURRENCE_METADATA_KEY = "quotaOccurrenceId";
const QUOTA_DEFINITION_REVISION_METADATA_KEY = "quotaDefinitionRevision";

function quotaOccurrenceId(
  metadata: ScheduledTaskDispatchRecord["metadata"],
): string | null {
  return metadataString(metadata, QUOTA_OCCURRENCE_METADATA_KEY);
}

/**
 * Contribute the quota check-in gate and completion check to the single
 * ScheduledTask spine. `quota_incomplete` is the structural stop-when-complete
 * / active-window / active-day gate for `count_per_day` check-in fires;
 * `quota_complete` retires the scheduled item once the derived remaining count
 * reaches zero. Both read server-derived progress from the LifeOps repository
 * and branch only on typed fields — never on prompt prose.
 */
export function registerQuotaProgressContributions(args: {
  runtime: IAgentRuntime;
  agentId: string;
  gates: ReturnType<typeof createTaskGateRegistry>;
  completionChecks: ReturnType<typeof createCompletionCheckRegistry>;
}): void {
  const repository = new LifeOpsRepository(args.runtime);
  const quotaIncompleteGate: TaskGateContribution = {
    kind: "quota_incomplete",
    async evaluate(task, context) {
      const occurrenceId = quotaOccurrenceId(task.metadata);
      if (!occurrenceId) {
        return {
          kind: "deny",
          reason: "quota_incomplete: quotaOccurrenceId missing",
        };
      }
      const view = await repository.getOccurrenceView(
        args.agentId,
        occurrenceId,
      );
      if (!view?.progress) {
        return {
          kind: "deny",
          reason: "quota_incomplete: quota occurrence unavailable",
        };
      }
      if (view.state === "completed" || view.progress.remainingCount === 0) {
        return { kind: "deny", reason: "quota_incomplete: quota complete" };
      }
      const definition = await repository.getDefinition(
        args.agentId,
        view.definitionId,
      );
      const expectedRevision = metadataString(
        task.metadata,
        QUOTA_DEFINITION_REVISION_METADATA_KEY,
      );
      if (
        definition?.status !== "active" ||
        definition.cadence.kind !== "count_per_day" ||
        !definition.checkInPolicy ||
        expectedRevision !== definition.updatedAt
      ) {
        return {
          kind: "deny",
          reason: "quota_incomplete: check-in policy is no longer current",
        };
      }
      if (["skipped", "expired", "muted"].includes(view.state)) {
        return {
          kind: "deny",
          reason: `quota_incomplete: occurrence ${view.state}`,
        };
      }
      if (
        view.state === "snoozed" &&
        view.snoozedUntil &&
        Date.parse(view.snoozedUntil) > Date.parse(context.nowIso)
      ) {
        return {
          kind: "defer",
          until: { atIso: view.snoozedUntil },
          reason: "quota_incomplete: occurrence snoozed",
        };
      }
      const localDateKey = view.metadata.localDateKey;
      if (
        typeof localDateKey !== "string" ||
        getLocalDateKey(
          getZonedDateParts(new Date(context.nowIso), view.timezone),
        ) !== localDateKey
      ) {
        return {
          kind: "deny",
          reason: "quota_incomplete: active day has ended",
        };
      }
      const localNow = getZonedDateParts(
        new Date(context.nowIso),
        definition.timezone,
      );
      const nowMinute = localNow.hour * 60 + localNow.minute;
      let nextWindowStart: number | null = null;
      for (const name of definition.checkInPolicy.windows) {
        const window = definition.windowPolicy.windows.find(
          (candidate) => candidate.name === name,
        );
        if (!window) continue;
        const endMinute =
          window.endMinute <= window.startMinute
            ? window.endMinute + 24 * 60
            : window.endMinute;
        const comparableNow =
          nowMinute < window.startMinute && endMinute >= 24 * 60
            ? nowMinute + 24 * 60
            : nowMinute;
        if (comparableNow >= window.startMinute && comparableNow < endMinute) {
          return { kind: "allow" };
        }
        if (
          window.startMinute > nowMinute &&
          (nextWindowStart === null || window.startMinute < nextWindowStart)
        ) {
          nextWindowStart = window.startMinute;
        }
      }
      if (nextWindowStart !== null) {
        const nextStart = buildUtcDateFromLocalParts(definition.timezone, {
          year: localNow.year,
          month: localNow.month,
          day: localNow.day,
          hour: Math.floor(nextWindowStart / 60),
          minute: nextWindowStart % 60,
          second: 0,
        });
        if (nextStart.getTime() <= Date.parse(view.relevanceEndAt)) {
          return {
            kind: "defer",
            until: { atIso: nextStart.toISOString() },
            reason: "quota_incomplete: waiting for an active check-in window",
          };
        }
      }
      return {
        kind: "deny",
        reason: "quota_incomplete: check-in windows closed for the active day",
      };
    },
  };
  const quotaCompleteCheck: CompletionCheckContribution = {
    kind: "quota_complete",
    async shouldComplete(task) {
      const occurrenceId = quotaOccurrenceId(task.metadata);
      if (!occurrenceId) return false;
      const view = await repository.getOccurrenceView(
        args.agentId,
        occurrenceId,
      );
      return (
        view?.state === "completed" || view?.progress?.remainingCount === 0
      );
    },
  };
  args.gates.register(quotaIncompleteGate);
  args.completionChecks.register(quotaCompleteCheck);
}

export function registerLifeOpsScheduledTaskSubjectStore(
  runtime: IAgentRuntime,
  subjectStore: SubjectStoreView,
): void {
  subjectStoresByRuntime.set(runtime, subjectStore);
}

function getLifeOpsScheduledTaskSubjectStore(
  runtime: IAgentRuntime,
): SubjectStoreView | null {
  return subjectStoresByRuntime.get(runtime) ?? null;
}

/**
 * Default `SubjectStoreView` for runner deps: prefer a store registered via
 * `registerLifeOpsScheduledTaskSubjectStore` — resolved on every call, since
 * registration may happen after the deps are built — and otherwise fall back
 * to the production LifeOps-backed view (entities / relationships / work
 * threads).
 */
function makeRuntimeSubjectStoreView(
  runtime: IAgentRuntime,
  agentId: string,
): SubjectStoreView {
  const lifeOpsView = createLifeOpsSubjectStoreView(runtime, agentId);
  return {
    wasUpdatedSince(args) {
      const registered = getLifeOpsScheduledTaskSubjectStore(runtime);
      return (registered ?? lifeOpsView).wasUpdatedSince(args);
    },
  };
}

/**
 * Bind PA's runner deps to the scheduling-owned SQL store. PA still injects
 * owner/channel/subject dependencies, but row ownership now belongs to
 * `@elizaos/plugin-scheduling`.
 */
function makeRepositoryBackedStores(
  runtime: IAgentRuntime,
  agentId: string,
): RepositoryBackedStores {
  return createFamilySchedulingStores(runtime, agentId);
}

function defaultOwnerFactsProvider(
  runtime: IAgentRuntime,
): () => Promise<OwnerFactsView> {
  return async () => {
    const store = resolveOwnerFactStore(runtime);
    // `new Date()` drives the derived `travelActive` — the view reflects
    // whether the owner is inside a booked/declared travel window at this
    // instant, which is exactly what the `during_travel` gate needs each tick.
    const view = ownerFactsToView(await store.read(), new Date());
    const timezone = view.timezone ?? resolveDefaultTimeZone();
    try {
      const repo = new LifeOpsRepository(runtime);
      const [local, cloud] = await Promise.all([
        repo.getScheduleMergedState(runtime.agentId, "local", timezone),
        repo.getScheduleMergedState(runtime.agentId, "cloud", timezone),
      ]);
      const effective = preferEffectiveMergedState({
        now: new Date(),
        local,
        cloud,
      });
      const healthSampleCount = effective?.baseline?.sampleCount;
      // Behavioural baseline from the observed rhythm (plan D.2.3). Feeds the
      // same personalBaseline surface so `personal_baseline_sufficient` fires
      // once EITHER a health baseline OR enough observed behaviour exists —
      // avoids starving persona packs that have no health baseline on day one.
      const behavioural = behaviouralBaselineFromProfile(
        await readActivityProfile(runtime),
      );
      const sampleCount = Math.max(
        typeof healthSampleCount === "number" &&
          Number.isFinite(healthSampleCount)
          ? healthSampleCount
          : 0,
        behavioural?.sampleCount ?? 0,
      );
      if (sampleCount > 0) {
        view.personalBaseline = {
          sampleCount,
          windowDays:
            effective?.baseline?.windowDays ?? behavioural?.windowDays,
        };
      }
    } catch (error) {
      logger.warn(
        {
          src: "lifeops:scheduled-task:runtime-wiring",
          agentId: runtime.agentId,
          error,
        },
        "Failed to project schedule baseline sample count into owner facts; baseline-dependent gates will deny until it is available.",
      );
    }
    return view;
  };
}

/**
 * Diagnostic stand-in for `ActivitySignalBusView` when no bus was registered
 * for this runtime. Logs once per runner construction so the missing wiring
 * is visible at boot; completion-checks depending on signals will return
 * `false` (their honest "no signal observed" state) but the operator sees
 * the warning and can wire `registerActivitySignalBus` in plugin init.
 */
function makeMissingActivityBusView(
  runtime: IAgentRuntime,
): ActivitySignalBusView {
  let warned = false;
  return {
    hasSignalSince() {
      if (!warned) {
        warned = true;
        logger.warn(
          {
            src: "lifeops:scheduled-task:runtime-wiring",
            agentId: runtime.agentId,
          },
          "ActivitySignalBus not registered; completion-checks depending on activity signals will report no-signal. Call registerActivitySignalBus during plugin init.",
        );
      }
      return false;
    },
  };
}

function normalizeChannelTarget(
  channelKey: string,
  target: string | undefined,
): string | undefined {
  if (!target) return undefined;
  const prefix = `${channelKey}:`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

interface NotificationEmitter {
  notify: (input: {
    title: string;
    body?: string;
    category?: string;
    priority?: string;
    source?: string;
    deepLink?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
}

function getNotifier(runtime: IAgentRuntime): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

function metadataString(
  metadata: ScheduledTaskDispatchRecord["metadata"],
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Compose the owner-facing message for one dispatch. `promptInstructions` is a
 * model prompt, never user-facing copy, so there are exactly two composition
 * paths and neither delivers it verbatim:
 *
 * - Tasks whose structural `metadata.delegatesAssemblyTo` names the morning
 *   check-in assembler get the assembled brief's `summaryText` (#14802) —
 *   real data (meetings, todos, wins) the render prompt alone cannot supply;
 *   CheckinService already composes that text through the model.
 * - Everything else renders through `renderScheduledDispatchMessage` (the
 *   CheckinService model seam): the instruction is the PROMPT, the model's
 *   output is what the owner sees. A model-free runtime receives a neutral
 *   deterministic fallback; a present-but-failed model call is a typed,
 *   retryable dispatch failure.
 */
export async function composeOwnerFacingScheduledTaskText(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string> {
  const quotaId = quotaOccurrenceId(record.metadata);
  if (quotaId) {
    const view = await new LifeOpsRepository(runtime).getOccurrenceView(
      runtime.agentId,
      quotaId,
    );
    if (!view?.progress) {
      throw new Error(
        `Quota check-in occurrence ${quotaId} has no progress projection`,
      );
    }
    const { completedCount, targetCount, remainingCount, unit } = view.progress;
    if (remainingCount === 0) {
      return `${targetCount}/${targetCount} ${unit}${targetCount === 1 ? "" : "s"} complete for “${view.title}” today.`;
    }
    return `${completedCount}/${targetCount} ${unit}${targetCount === 1 ? "" : "s"} logged for “${view.title}” today — ${remainingCount} remaining. How is it going?`;
  }
  const delegatesAssemblyTo = metadataString(
    record.metadata,
    "delegatesAssemblyTo",
  );

  if (delegatesAssemblyTo === "lifeops:checkin:morning") {
    try {
      const assembled = await assembleMorningBrief(runtime, {
        timezone: resolveDefaultTimeZone(),
        now: new Date(record.firedAtIso),
      });
      const summaryText = assembled.report.summaryText.trim();
      if (record.metadata) {
        record.metadata.checkinReportId = assembled.report.reportId;
        record.metadata.checkinKind = assembled.report.kind;
      }
      if (summaryText.length > 0) return summaryText;
      throw new Error("Morning check-in assembler returned empty summaryText");
    } catch (error) {
      // error-policy:J4 designed degrade — the scheduled check-in still
      // reaches the owner with an honest "couldn't assemble" message instead
      // of silently dropping the fire; the assembly failure is surfaced via
      // reportError for RECENT_ERRORS/escalation.
      runtime.reportError("lifeops:scheduled-task:owner-facing-copy", error, {
        agentId: runtime.agentId,
        taskId: record.taskId,
        firedAtIso: record.firedAtIso,
        delegatesAssemblyTo,
      });
      return "Your morning check-in is ready, but I couldn't assemble the full brief right now.";
    }
  }

  const resolvedContext = hasScheduledDispatchModel(runtime)
    ? await resolveScheduledTaskDispatchContext(runtime, record)
    : undefined;
  return renderScheduledDispatchMessage(runtime, {
    ...record,
    ...(resolvedContext ? { resolvedContext } : {}),
  });
}

const LOCAL_AGENT_BACKUP_OPERATION = "agent.localBackup";
const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  boundary: "lifeops.owner_contacts",
  operation: "load_owner_contacts",
  message:
    "[lifeops] Failed to load owner contacts; using empty owner contacts config.",
} as const;

function isLocalAgentBackupDispatch(
  record: ScheduledTaskDispatchRecord,
): boolean {
  return record.metadata?.systemOperation === LOCAL_AGENT_BACKUP_OPERATION;
}

function isFamilyMonthlyDispatch(record: ScheduledTaskDispatchRecord): boolean {
  return record.metadata?.systemOperation === FAMILY_MONTHLY_SYSTEM_OPERATION;
}

function targetNeedsOwnerResolution(
  channelKey: string,
  target: string | undefined,
): boolean {
  const normalized = normalizeChannelTarget(channelKey, target);
  return !normalized || normalized === channelKey;
}

async function resolveOwnerChannelTarget(
  runtime: IAgentRuntime,
  channelKey: string,
): Promise<string | null> {
  const ownerContacts = loadOwnerContactsConfig(
    LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT,
  );
  const hints = await loadOwnerContactRoutingHints(runtime, ownerContacts);
  const hint = hints[channelKey] ?? null;
  let contactResolution =
    resolveOwnerContactWithFallback({
      ownerContacts,
      source: hint?.source ?? channelKey,
      ownerEntityId: null,
    }) ??
    resolveOwnerContactWithFallback({
      ownerContacts,
      source: channelKey,
      ownerEntityId: null,
    });
  if (!contactResolution) {
    const ownerEntityId = await resolveOwnerEntityId(runtime);
    contactResolution =
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: hint?.source ?? channelKey,
        ownerEntityId,
      }) ??
      resolveOwnerContactWithFallback({
        ownerContacts,
        source: channelKey,
        ownerEntityId,
      });
  }
  const contact =
    contactResolution?.contact ??
    (hint?.source ? ownerContacts[hint.source] : undefined) ??
    ownerContacts[channelKey];
  return (
    hint?.channelId ??
    contact?.channelId ??
    hint?.roomId ??
    contact?.roomId ??
    hint?.entityId ??
    contact?.entityId ??
    null
  );
}

async function resolveScheduledTaskChannelTarget(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string | null> {
  if (!targetNeedsOwnerResolution(record.channelKey, record.output?.target)) {
    return (
      normalizeChannelTarget(record.channelKey, record.output?.target) ?? null
    );
  }
  return resolveOwnerChannelTarget(runtime, record.channelKey);
}

function deniedDecisionToDispatchResult(
  decision: Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof getSendPolicyRegistry>>["evaluate"]
    >
  >,
): DispatchResult | null {
  if (decision.kind === "allow") return null;
  if (decision.kind === "deny") {
    return (
      decision.asDispatchResult ?? {
        ok: false,
        reason: "auth_expired",
        userActionable: decision.userActionable,
        message: decision.reason,
      }
    );
  }
  return {
    ok: false,
    reason: "auth_expired",
    userActionable: true,
    message: decision.reason ?? "Send requires approval.",
  };
}

/**
 * Apply the runner's dispatch fallback policy to a raw `DispatchResult` before
 * handing it back to the ScheduledTask runner. This is where
 * {@link decideDispatchPolicy} is actually exercised in production (it was
 * previously unit-tested but never wired to a live dispatch): for a
 * retry-class failure such as `rate_limited` that a connector reported WITHOUT
 * an explicit `retryAfterMinutes`, the policy supplies the default backoff so
 * the runner reschedules the same escalation step instead of treating it as a
 * hard failure. Non-retry decisions leave the result untouched — the runner
 * reads the spine-owned `ok` / `retryAfterMinutes` fields and routes the rest.
 */
function applyDispatchPolicy(result: DispatchResult): DispatchResult {
  if (result.ok) return result;
  const decision = decideDispatchPolicy(result, {
    // A dispatcher issues a single send attempt; ladder advancement and the
    // step-dependent advance / surface_degraded / fail decisions belong to the
    // runner, which owns the escalation cursor. Here we only consume the
    // step-independent retry decision to fill a missing backoff, so a
    // single-step context is the correct view.
    currentStepIndex: 0,
    totalSteps: 1,
  });
  if (decision.kind === "retry" && result.retryAfterMinutes === undefined) {
    return { ...result, retryAfterMinutes: decision.retryAfterMinutes };
  }
  return result;
}

export function createProductionScheduledTaskDispatcher(opts: {
  runtime: IAgentRuntime;
  /** Test seam; production persists through LifeOpsRepository. */
  persistDispatchAttempt?: (
    record: ScheduledTaskDispatchRecord,
    message: string,
    idempotencyKey: string,
  ) => Promise<void>;
}): ScheduledTaskDispatcher {
  return {
    async dispatch(
      record: ScheduledTaskDispatchRecord,
    ): Promise<DispatchResult> {
      // Connector reminders created from chat carry a durable binding minted
      // from canonical room state. Re-read that state before any composition or
      // send so restart cannot turn stale owner-only data into a shared-room
      // disclosure.
      const deliveryBindingDecision =
        await revalidateScheduledTaskChatDeliveryBinding(opts.runtime, record);
      if (deliveryBindingDecision && !deliveryBindingDecision.ok) {
        return applyDispatchPolicy({
          ok: false,
          reason: "auth_expired",
          userActionable: true,
          message: deliveryBindingDecision.reason,
        });
      }

      if (
        record.metadata?.systemOperation === FAMILY_BACKUP_CLEANUP_OPERATION
      ) {
        const jobId = record.metadata.deletionJobId;
        const sha256 = record.metadata.backupReviewSha256;
        if (typeof jobId !== "string" || typeof sha256 !== "string")
          throw new ElizaError(
            "[FamilyDeletion] Scheduled cleanup identity is missing",
            {
              code: "FAMILY_DELETION_BACKUP_REVIEW_REQUIRED",
            },
          );
        const job = await purgeFamilyBackupCleanup(
          opts.runtime,
          SELF_ENTITY_ID,
          {
            jobId,
            sha256,
          },
        );
        return {
          ok: true,
          messageId: `family-backup-cleanup:${job.id}:${sha256}`,
        };
      }

      if (isLocalAgentBackupDispatch(record)) {
        const backup = await createLocalAgentBackup(
          opts.runtime,
          {} as Parameters<typeof createLocalAgentBackup>[1],
        );
        logger.info(
          {
            src: "lifeops:scheduled-task",
            agentId: opts.runtime.agentId,
            taskId: record.taskId,
            fileName: backup.fileName,
            stateSha256: backup.stateSha256,
            sizeBytes: backup.sizeBytes,
          },
          "[lifeops-scheduled-task] Local agent backup completed",
        );
        return {
          ok: true,
          messageId: `agent-backup:${backup.fileName}`,
        };
      }

      if (isFamilyMonthlyDispatch(record)) {
        const service = getFamilyWorkflowRuntimeService(opts.runtime);
        if (!service) {
          return {
            ok: false,
            reason: "disconnected",
            userActionable: false,
            message: "Family workflow runtime service is unavailable.",
          };
        }
        const result = await service.runMonthly("scheduled");
        return {
          ok: true,
          messageId: `family-monthly:${result.periodKey}:${result.runId}`,
        };
      }

      const registry = getChannelRegistry(opts.runtime);
      const channel = registry?.get(record.channelKey) ?? null;
      const hasInAppSurfaceFallback =
        record.channelKey === "in_app" ||
        record.channelKey === "push" ||
        record.output?.destination === "in_app_card";
      if (!channel?.send && !hasInAppSurfaceFallback) {
        return applyDispatchPolicy({
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" is not connected for send.`,
        });
      }

      // `promptInstructions` is a model prompt, never user-facing copy: every
      // user-visible surface below (assistant stream, notification body,
      // connector channel send) delivers the composed owner-facing message —
      // delegated assembly or the model's rendering. A composition failure is
      // a typed, retryable dispatch failure — there is deliberately no
      // raw-instruction fallback, because delivering instruction-voice text
      // verbatim to the owner was the bug this step exists to fix.
      let message: string;
      const preparedMessage = record.metadata?.dispatchPreparedMessage;
      try {
        message =
          deliveryBindingDecision?.ok &&
          typeof preparedMessage === "string" &&
          preparedMessage.trim().length > 0
            ? preparedMessage
            : await composeOwnerFacingScheduledTaskText(opts.runtime, record);
      } catch (error) {
        // error-policy:J1 boundary translation — dispatch outcomes are the
        // runner's typed contract; the failure also reaches RECENT_ERRORS and
        // owner escalation via reportError.
        opts.runtime.reportError(
          "lifeops:scheduled-task:dispatch-render",
          error,
          { taskId: record.taskId, channelKey: record.channelKey },
        );
        return renderFailureDispatchResult(error);
      }

      if (deliveryBindingDecision?.ok && preparedMessage !== message) {
        // Persist the exact rendered payload BEFORE provider egress. Recovery
        // must replay byte-for-byte content because connector-level durable
        // dedupe includes message text; rerendering after a crash could produce
        // different prose and defeat exactly-once delivery.
        const existingDispatchKey = record.metadata?.dispatchIdempotencyKey;
        const dispatchIdempotencyKey =
          typeof existingDispatchKey === "string" &&
          existingDispatchKey.trim().length > 0
            ? existingDispatchKey.trim()
            : `${record.taskId}:${record.firedAtIso}`;
        if (opts.persistDispatchAttempt) {
          await opts.persistDispatchAttempt(
            record,
            message,
            dispatchIdempotencyKey,
          );
        } else {
          const repository = new LifeOpsRepository(opts.runtime);
          const current = await repository.getScheduledTask(
            opts.runtime.agentId,
            record.taskId,
          );
          if (!current) {
            return applyDispatchPolicy({
              ok: false,
              reason: "transport_error",
              acceptance: "not_accepted",
              userActionable: false,
              message:
                "Scheduled task disappeared before dispatch preparation.",
            });
          }
          const attemptMetadata = {
            dispatchPreparedMessage: message,
            dispatchIdempotencyKey,
            dispatchAttempt: {
              status: "prepared",
              preparedAtIso: new Date().toISOString(),
              firedAtIso: record.firedAtIso,
            },
          };
          current.metadata = {
            ...(current.metadata ?? {}),
            ...attemptMetadata,
          };
          await repository.upsertScheduledTask(opts.runtime.agentId, current);
          if (record.metadata) Object.assign(record.metadata, attemptMetadata);
        }
      }

      if (!channel?.send) {
        // Honest delivery accounting: an in_app dispatch "succeeded" only
        // if at least one real surface accepted the payload — the live
        // assistant event bus (transient stream) or the notification
        // service (durable inbox). Previously this branch returned
        // ok:true unconditionally, fabricating delivery on hosts where
        // both surfaces were absent, so nothing ever retried/escalated.
        let surfacesAccepted = 0;
        const eventService = getAgentEventService(opts.runtime) as {
          emit?: (event: {
            runId: string;
            stream: string;
            data: Record<string, unknown>;
            agentId?: string;
          }) => void;
        } | null;
        if (typeof eventService?.emit === "function") {
          eventService.emit({
            runId: crypto.randomUUID(),
            stream: "assistant",
            agentId: opts.runtime.agentId,
            data: {
              text: message,
              source: "lifeops-scheduled-task",
              taskId: record.taskId,
              firedAtIso: record.firedAtIso,
              channelKey: record.channelKey,
              target: normalizeChannelTarget(
                record.channelKey,
                record.output?.target,
              ),
              ...(record.intensity ? { intensity: record.intensity } : {}),
              ...(record.contextRequest
                ? { contextRequest: record.contextRequest }
                : {}),
            },
          });
          surfacesAccepted += 1;
        }
        const notifier = getNotifier(opts.runtime);
        if (notifier) {
          try {
            const title = await renderScheduledDispatchTitle(
              opts.runtime,
              record,
              message,
            );
            const isUrgent = record.intensity === "urgent";
            await notifier.notify({
              title,
              body: message,
              category: isUrgent ? "approval" : "reminder",
              priority: isUrgent ? "urgent" : "normal",
              source: "lifeops",
              groupKey: `lifeops:${record.taskId}`,
              deepLink: "/chat",
              data: {
                taskId: record.taskId,
                firedAtIso: record.firedAtIso,
                channelKey: record.channelKey,
              },
            });
            surfacesAccepted += 1;
          } catch (error) {
            // error-policy:J4 explicit user-facing degrade — the assistant
            // stream may still have accepted the same owner-facing message.
            opts.runtime.reportError(
              "lifeops:scheduled-task:notification-render",
              error,
              { taskId: record.taskId, channelKey: record.channelKey },
            );
            logger.warn(
              { src: "lifeops:scheduled-task", error },
              "Notification emit failed",
            );
          }
        }
        if (surfacesAccepted === 0) {
          return {
            ok: false,
            reason: "disconnected",
            userActionable: false,
            message:
              "No in-app surface (assistant event bus or notification service) accepted the payload.",
          };
        }
        return {
          ok: true,
          messageId: `in_app:${record.taskId}:${record.firedAtIso}`,
          channelKey: record.channelKey,
          target:
            normalizeChannelTarget(record.channelKey, record.output?.target) ??
            "in_app",
        };
      }

      const target = await resolveScheduledTaskChannelTarget(
        opts.runtime,
        record,
      );
      if (!target) {
        return applyDispatchPolicy({
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${record.channelKey}" has no resolvable owner target for scheduled task delivery.`,
        });
      }

      const chatDeliveryBinding = readScheduledTaskChatDeliveryBinding(
        record.metadata,
      );
      const payload = {
        target,
        message,
        metadata: {
          taskId: record.taskId,
          firedAtIso: record.firedAtIso,
          ...(chatDeliveryBinding
            ? {
                accountId: chatDeliveryBinding.accountId,
                roomId: chatDeliveryBinding.roomId,
                audience: {
                  kind: chatDeliveryBinding.audience.kind,
                  provenance: chatDeliveryBinding.audience.provenance,
                  membershipVersion:
                    chatDeliveryBinding.audience.membershipVersion,
                  ownerOnly: true,
                },
              }
            : {}),
          ...(record.intensity ? { intensity: record.intensity } : {}),
          ...(record.contextRequest
            ? { contextRequest: record.contextRequest }
            : {}),
          ...(record.consolidationBatchId
            ? { consolidationBatchId: record.consolidationBatchId }
            : {}),
        },
      };

      const sendPolicies = getSendPolicyRegistry(opts.runtime);
      const policyDecision = await sendPolicies?.evaluate({
        source: { kind: "channel", key: record.channelKey },
        capability: "send",
        payload,
        taskId: record.taskId,
      });
      if (policyDecision) {
        const denied = deniedDecisionToDispatchResult(policyDecision);
        if (denied) return applyDispatchPolicy(denied);
      }

      // Composition and send-policy evaluation may perform async work after the
      // first audience check. Close that TOCTOU window by reading canonical room
      // membership again at the last possible point before connector egress.
      if (chatDeliveryBinding) {
        const finalBindingDecision =
          await revalidateScheduledTaskChatDeliveryBinding(
            opts.runtime,
            record,
          );
        if (!finalBindingDecision?.ok) {
          return applyDispatchPolicy({
            ok: false,
            reason: "auth_expired",
            userActionable: true,
            message: finalBindingDecision?.reason ?? "delivery_binding_missing",
          });
        }
      }

      let result: DispatchResult;
      const persistedDispatchKey = record.metadata?.dispatchIdempotencyKey;
      const dispatchIdempotencyKey =
        typeof persistedDispatchKey === "string" &&
        persistedDispatchKey.trim().length > 0
          ? persistedDispatchKey.trim()
          : `${record.taskId}:${record.firedAtIso}`;
      if (chatDeliveryBinding) {
        // Bound chat delivery must use the runtime's account-aware connector
        // transport, not the legacy LifeOps mixin (which selects an implicit
        // owner/default account). The connector transport also returns the
        // provider receipt used by its durable duplicate-suppression path.
        try {
          const disposition = inspectSendHandlerResult(
            await opts.runtime.sendMessageToTarget(
              {
                source: chatDeliveryBinding.source,
                accountId: chatDeliveryBinding.accountId,
                channelId: chatDeliveryBinding.channelId,
                roomId: chatDeliveryBinding.roomId as never,
              },
              {
                text: message,
                agentVoiced: true,
                metadata: {
                  taskId: record.taskId,
                  firedAtIso: record.firedAtIso,
                  accountId: chatDeliveryBinding.accountId,
                  scheduledDispatchKey: dispatchIdempotencyKey,
                },
              },
            ),
          );
          if (disposition.kind === "delivered") {
            const providerMessageId = disposition.providerMessageId;
            result = {
              ok: true,
              ...(providerMessageId ? { messageId: providerMessageId } : {}),
              ...(providerMessageId
                ? {
                    receipt: {
                      provider: chatDeliveryBinding.source,
                      providerMessageId,
                      idempotencyKey: dispatchIdempotencyKey,
                      acceptedAt: new Date(
                        disposition.receipt?.acceptedAt ?? Date.now(),
                      ).toISOString(),
                      metadata: {
                        replayed: disposition.replayed,
                        accountId: chatDeliveryBinding.accountId,
                        persistence:
                          disposition.receipt?.persistence.status ?? "legacy",
                      },
                    },
                  }
                : {}),
            };
            if (
              disposition.receipt?.persistence.status === "partial" ||
              disposition.receipt?.persistence.status === "failed"
            ) {
              // Provider acceptance is authoritative: never retry and duplicate
              // the visible message merely because local evidence degraded.
              opts.runtime.reportError(
                "lifeops:scheduled-task:delivery-evidence",
                new Error(
                  `Provider accepted scheduled dispatch but local persistence is ${disposition.receipt.persistence.status}`,
                ),
                { taskId: record.taskId, providerMessageId },
              );
            }
          } else {
            result = {
              ok: false,
              reason:
                disposition.kind === "not_delivered"
                  ? "disconnected"
                  : "transport_error",
              acceptance:
                disposition.kind === "not_delivered"
                  ? "not_accepted"
                  : "unknown",
              userActionable: disposition.kind === "not_delivered",
              message: disposition.message,
            };
          }
        } catch (error) {
          opts.runtime.reportError(
            "lifeops:scheduled-task:bound-chat-send",
            error,
            {
              taskId: record.taskId,
              source: chatDeliveryBinding.source,
              accountId: chatDeliveryBinding.accountId,
            },
          );
          result = {
            ok: false,
            reason: "transport_error",
            acceptance: "unknown",
            userActionable: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } else {
        result = await channel.send(payload);
      }
      if (result.ok) {
        return applyDispatchPolicy({
          ...result,
          channelKey: record.channelKey,
          target,
        });
      }
      return applyDispatchPolicy(result);
    },
  };
}

function resolveRuntimeAnchorRegistry(runtime: IAgentRuntime) {
  const existing = getAnchorRegistry(runtime);
  if (existing) {
    registerFallbackAnchors(existing);
    return existing;
  }
  const registry = createAnchorRegistry();
  registerAppLifeOpsAnchors(registry);
  registerFallbackAnchors(registry);
  registerAnchorRegistry(runtime, registry);
  return registry;
}

export interface CreateRuntimeRunnerOptions {
  runtime: IAgentRuntime;
  agentId: string;
  /** Override the default runtime providers as agents wire up. */
  ownerFacts?: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause?: GlobalPauseView;
  activity?: ActivitySignalBusView;
  subjectStore?: SubjectStoreView;
  /**
   * Override the host-capability probe. The default reads
   * `getHostExecutionCapabilities(runtime)` from `@elizaos/app-core`,
   * which detects iOS BackgroundRunner / Android FGS / Node desktop. Tests
   * inject a fixed set to exercise substitution behavior.
   */
  hostCapabilities?: () => ReadonlySet<TaskExecutionProfile>;
  now?: () => Date;
}

/**
 * Build the production deps bundle PA injects into `@elizaos/plugin-scheduling`'s
 * runner host. This is the LifeOps-specific wiring — DB-backed store/log,
 * production dispatcher, owner-facts / channel-keys / host-capability probes,
 * and PA's anchor registry. The generic registries (gates, completion-checks,
 * ladders, consolidation) are built here too so the spine's runner host uses the
 * built-in set rather than rebuilding them.
 */
function buildLifeOpsRunnerDeps(
  opts: CreateRuntimeRunnerOptions,
): ScheduledTaskRunnerDepsBundle {
  const stores = makeRepositoryBackedStores(opts.runtime, opts.agentId);

  const gates = createTaskGateRegistry();
  // Register the real ActivityProfile-backed readers for circadian_state_in /
  // no_recent_user_message_in and the model moment judge for
  // model_moment_check BEFORE the built-ins. registerBuiltInGates is
  // first-wins, so these production readers take precedence over the generic
  // fallbacks (which stay resolvable when PA is absent, e.g. plugin-health
  // standalone tests).
  registerActivityProfileGates(opts.runtime, gates);
  registerModelMomentCheckGate(opts.runtime, gates);
  registerHouseholdGrantExpiryWarningGate(
    new HouseholdCoordinationRepository(opts.runtime, opts.agentId),
    gates,
  );
  registerBuiltInGates(gates);

  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  registerQuotaProgressContributions({
    runtime: opts.runtime,
    agentId: opts.agentId,
    gates,
    completionChecks,
  });

  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const anchors = resolveRuntimeAnchorRegistry(opts.runtime);

  const consolidation = createConsolidationRegistry();

  // Default the production providers from the runtime. Tests / harnesses can
  // still inject overrides via the options bag. The diagnostic shims warn-once
  // on missing wiring so silent always-allow / always-false defaults are gone.
  const globalPause: GlobalPauseView =
    opts.globalPause ?? resolveGlobalPauseStore(opts.runtime);
  const activity: ActivitySignalBusView =
    opts.activity ??
    getActivitySignalBus(opts.runtime) ??
    makeMissingActivityBusView(opts.runtime);
  // Production default: the real LifeOps-backed subject store (entities /
  // relationships / work threads). Kinds without a durable per-id store yet
  // (document / calendar_event / self) warn once inside the view. The
  // runtime-registered store is consulted per call, not snapshotted here:
  // runner deps are built during plugin init, before callers get a chance to
  // register (e.g. registerLifeOpsScheduledTaskSubjectStore in tests).
  const subjectStore: SubjectStoreView =
    opts.subjectStore ??
    makeRuntimeSubjectStoreView(opts.runtime, opts.agentId);

  return {
    store: stores.store,
    executionBoundary: (task, execute) =>
      withFamilyScheduledExecution(opts.runtime, task, execute, opts.agentId),
    logStore: stores.logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: opts.ownerFacts ?? defaultOwnerFactsProvider(opts.runtime),
    globalPause,
    activity,
    subjectStore,
    channelKeys: () => {
      const registry = getChannelRegistry(opts.runtime);
      if (!registry) return new Set();
      return new Set(registry.list().map((c) => c.kind));
    },
    channelAvailable: async (channelKey: string) => {
      const channelRegistry = getChannelRegistry(opts.runtime);
      const channel = channelRegistry?.get(channelKey) ?? null;
      if (!channel) return false;
      if (!channel.connectorKind) return true;
      const connector = getConnectorRegistry(opts.runtime)?.get(
        channel.connectorKind,
      );
      if (!connector?.send) return false;
      try {
        const status = await connector.status();
        return status.state !== "disconnected";
      } catch {
        return false;
      }
    },
    hostCapabilities:
      opts.hostCapabilities ??
      (() => getHostExecutionCapabilities(opts.runtime)),
    dispatcher: createProductionScheduledTaskDispatcher({
      runtime: opts.runtime,
    }),
  };
}

export function createRuntimeScheduledTaskRunner(
  opts: CreateRuntimeRunnerOptions,
): ScheduledTaskRunnerHandle {
  const deps = buildLifeOpsRunnerDeps(opts);
  return createScheduledTaskRunner({
    agentId: opts.agentId,
    store: deps.store,
    logStore: deps.logStore,
    gates: deps.gates ?? createTaskGateRegistry(),
    completionChecks: deps.completionChecks ?? createCompletionCheckRegistry(),
    ladders: deps.ladders ?? createEscalationLadderRegistry(),
    anchors: deps.anchors ?? resolveRuntimeAnchorRegistry(opts.runtime),
    consolidation: deps.consolidation ?? createConsolidationRegistry(),
    ownerFacts: deps.ownerFacts,
    globalPause: deps.globalPause,
    activity: deps.activity,
    subjectStore: deps.subjectStore,
    ...(opts.now ? { now: opts.now } : {}),
    ...(deps.channelKeys ? { channelKeys: deps.channelKeys } : {}),
    ...(deps.hostCapabilities
      ? { hostCapabilities: deps.hostCapabilities }
      : {}),
    dispatcher: deps.dispatcher,
    ...(deps.executionBoundary
      ? { executionBoundary: deps.executionBoundary }
      : {}),
  });
}

/**
 * Register PA's production deps as the runner host's injected deps provider on
 * `@elizaos/plugin-scheduling`. Called during PA `init`. First-wins: the spine
 * keeps this provider once set, so PA dispatch/owner deps wrap the
 * scheduling-owned SQL store while the runner service itself lives in
 * `@elizaos/plugin-scheduling`.
 */
export function registerLifeOpsScheduledTaskRunnerDeps(
  runtime: IAgentRuntime,
): void {
  registerScheduledTaskRunnerDeps(runtime, (rt, agentId) =>
    buildLifeOpsRunnerDeps({ runtime: rt, agentId }),
  );
}

/**
 * Subscribe every event kind in PA's `EventKindRegistry` to the spine's
 * event → task-fire bridge, so `runtime.emitEvent(eventKind, payload)` fires
 * the `{ kind: "event", eventKind }` scheduled tasks whose optional `filter`
 * subset-matches the payload. Without this install the `event` trigger kind
 * is schema-accepted but never fired by anything (`isScheduledTaskDue`
 * deliberately reports event tasks not-due — they are push-fired here).
 *
 * Called from PA `init` immediately after `registerEventKindRegistry`; the
 * registry missing is a wiring bug, not a fallback case. The runner resolves
 * lazily per emitted event through the cached `ScheduledTaskRunnerService`
 * host, never a stale handle. Returns the uninstall function.
 */
export function installLifeOpsScheduledTaskEventBridge(
  runtime: IAgentRuntime,
): () => void {
  const registry = getEventKindRegistry(runtime);
  if (!registry) {
    throw new Error(
      "[lifeops:scheduled-task:runtime-wiring] EventKindRegistry is not registered; call registerEventKindRegistry before installLifeOpsScheduledTaskEventBridge.",
    );
  }
  return installScheduledTaskEventBridge({
    runtime,
    eventKinds: registry.list().map((c) => c.eventKind),
    getRunner: () =>
      getScheduledTaskRunner(runtime, { agentId: String(runtime.agentId) }),
  });
}
