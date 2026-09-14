/**
 * Plugin definition for `@elizaos/plugin-personal-assistant`: assembles the
 * assistant's actions, providers, evaluators, services, and routes and wires the
 * init/dispose lifecycle. On init it registers the owner-facing surfaces,
 * promotes subactions to actions, and injects the LifeOps scheduled-task runner
 * dependencies into the always-loaded scheduling plugin.
 *
 * This is the composition root that turns the LifeOps domains, mixins, and
 * default packs into a runnable Eliza plugin; it owns no domain logic itself.
 */
import {
  type EventPayload,
  EventType,
  getDefaultTriageService,
  type IAgentRuntime,
  logger,
  type MessagePayload,
  messagingTriageActions,
  type Plugin,
  promoteSubactionsToActions,
  registerCandidateActionBackstopRule,
  registerDirectActionRoutingRule,
  registerLocalizedExamplesProvider,
  registerSendPolicy,
} from "@elizaos/core";
import {
  getSelfControlPermissionState,
  openSelfControlPermissionLocation,
  requestSelfControlPermission,
} from "@elizaos/plugin-blocker/services/website-blocker/index";
import { BrowserBridgeAdapter } from "@elizaos/plugin-browser";
import {
  calendarPlugin,
  handleMeetingJoinDispatch,
  MEETING_JOIN_CHANNEL_KEY,
} from "@elizaos/plugin-calendar";
import { financesPlugin } from "@elizaos/plugin-finances/plugin";
import { goalsPlugin } from "@elizaos/plugin-goals/plugin";
import { GoogleGmailAdapter } from "@elizaos/plugin-google-workspace";
import {
  createDefaultCircadianInsightContract,
  healthPlugin,
  registerCircadianInsightContract,
  registerHealthAnchors,
  registerHealthBusFamilies,
  registerHealthConnectors,
  registerHealthDefaultPacks,
} from "@elizaos/plugin-health";
import { inboxPlugin } from "@elizaos/plugin-inbox/plugin";
import { pdfPlugin } from "@elizaos/plugin-pdf";
import { remindersPlugin } from "@elizaos/plugin-reminders";
import {
  registerScheduledTaskRunnerBootHook,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { XDmAdapter } from "@elizaos/plugin-x/lifeops-message-adapter";
import type {
  IPermissionsRegistry,
  MeetingTranscriptFinalizedPayload,
  PermissionState,
  Platform,
  Prober,
} from "@elizaos/shared";
import { MEETING_TRANSCRIPT_FINALIZED_EVENT } from "@elizaos/shared";
import { ownerAgreementKnowledgeAction } from "./actions/agreement-knowledge.js";
import { blockAction } from "./actions/block.js";
import { briefAction } from "./actions/brief.js";
import { calendarAction } from "./actions/calendar.js";
import { registerPersonalAssistantCalendarSourcesHost } from "./actions/calendar-sources.js";
import {
  conflictDetectAction,
  registerPersonalAssistantConflictDetectHost,
} from "./actions/conflict-detect.js";
import { connectorAction } from "./actions/connector.js";
import { creativeDraftAction } from "./actions/creative-draft.js";
import { credentialsAction } from "./actions/credentials.js";
import { ownerDocumentsAction } from "./actions/document.js";
import { entityAction } from "./actions/entity.js";
import { familyWorkflowsAction } from "./actions/family-workflows.js";
import { householdCoordinationAction } from "./actions/household-coordination.js";
import { deferredOwnerTodoRoutingEvaluator } from "./actions/lib/lifeops-deferred-draft.js";
import {
  ownerAlarmsAction,
  ownerFinancesAction,
  ownerGoalsAction,
  ownerHealthAction,
  ownerRemindersAction,
  ownerRoutinesAction,
  ownerScreenTimeAction,
  ownerTodosAction,
  personalAssistantAction,
} from "./actions/owner-surfaces.js";
import { prioritizeAction } from "./actions/prioritize.js";
import { resolveReferentAction } from "./actions/resolve-referent.js";
import { resolveRequestAction } from "./actions/resolve-request.js";
import { scheduledTaskAction } from "./actions/scheduled-task.js";
import { voiceCallAction } from "./actions/voice-call.js";
import { workThreadAction } from "./actions/work-thread.js";
import { ActivityTrackerService } from "./activity-profile/activity-tracker-service.js";
import { PresenceSignalBridgeService } from "./activity-profile/presence-signal-bridge-service.js";
import {
  ensureProactiveAgentTask,
  isAppFirstRunComplete,
  PROACTIVE_TASK_NAME,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";
import { registerDefaultPackCatalog } from "./default-packs/spine-registration.js";
import {
  ensureFollowupTrackerTask,
  FOLLOWUP_TRACKER_TASK_NAME,
  registerFollowupTrackerWorker,
} from "./followup/index.js";
import {
  hasLifeOpsAccess,
  ownerPrivateAction,
  ownerPrivateProvider,
} from "./lifeops/access.js";
import {
  activateLifeOpsActivitySignals,
  deactivateLifeOpsActivitySignals,
} from "./lifeops/activity-signal-lifecycle.js";
import { anticipationFeedbackEvaluator } from "./lifeops/anticipation/evaluator.js";
import { createApprovalQueue } from "./lifeops/approval-queue.js";
import { createTrackedWorkRecapDirectRoutingRule } from "./lifeops/briefing/direct-routing.js";
import { handleBriefMessageMutation } from "./lifeops/briefing/message-engagement-handler.js";
import { CalendarCardAccessStore } from "./lifeops/calendar-card.js";
import { registerLifeOpsCalendarGate } from "./lifeops/calendar-gate.js";
import { OwnerCalendarMutationGatewayService } from "./lifeops/calendar-mutations/index.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
  registerDefaultChannelPack,
} from "./lifeops/channels/index.js";
import { commitmentExtractionEvaluator } from "./lifeops/commitments/extraction-evaluator.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
  registerDefaultConnectorPack,
} from "./lifeops/connectors/index.js";
import { applyMockoonEnvOverrides } from "./lifeops/connectors/mockoon-redirect.js";
import { createDelegationInboundMessageHandler } from "./lifeops/delegation-contracts/inbound-event.js";
import { processDelegationInboundTurn } from "./lifeops/delegation-contracts/index.js";
import { handleVoiceTurnObserved } from "./lifeops/entities/voice-observer-bridge.js";
import {
  AuthenticatedRuntimeSpeakerVerifierService,
  createFamilyCommunicationsAction,
  FamilyCommunicationsRuntimeService,
  issueAuthenticatedMessageSpeakerAttestation,
  resolveAuthenticatedFamilyPrincipal,
  resolveTrustedChildWeekItems,
} from "./lifeops/family-communications/index.js";
import { FamilyWorkflowRuntimeService } from "./lifeops/family-workflows/index.js";
import { installFirstRunChannelInspector } from "./lifeops/first-run/channel-inspector.js";
import { setRuntimeChannelInspector } from "./lifeops/first-run/questions.js";
import { FirstRunService } from "./lifeops/first-run/service.js";
import {
  createFoodDomainAction,
  FoodDomainRuntimeService,
} from "./lifeops/food/index.js";
import { ftuGoalDiscoveryEvaluator } from "./lifeops/ftu-goal/evaluator.js";
import { AgreementKnowledgeRuntimeService } from "./lifeops/household/agreement-knowledge.js";
import { createHouseholdInboundApprovalMessageHandler } from "./lifeops/household/inbound-approval.js";
import { HouseholdCoordinationRuntimeService } from "./lifeops/household/service.js";
import {
  createHouseholdOperationsAction,
  HouseholdOperationsRuntimeService,
} from "./lifeops/household-operations/index.js";
import { createOwnerLocaleExamplesProvider } from "./lifeops/i18n/localized-examples-provider.js";
import {
  createMultilingualPromptRegistry,
  registerDefaultPromptPack,
  registerMultilingualPromptRegistry,
} from "./lifeops/i18n/prompt-registry.js";
import { handleMeetingTranscriptFinalized } from "./lifeops/meeting-ghost/event-handler.js";
import {
  createOwnerSendPolicy,
  registerOwnerSendApprovalWorker,
} from "./lifeops/messaging/owner-send-policy.js";
import {
  createDefaultOraclePack,
  createLocalConditionsAction,
  registerExternalOracleRegistry,
  registerLocalActivityAdapterRegistry,
} from "./lifeops/oracles/index.js";
import { registerCoreFactMemoryBridge } from "./lifeops/owner/core-fact-memory-bridge.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
} from "./lifeops/owner/fact-store.js";
import { ownerProfileExtractionEvaluator } from "./lifeops/owner/profile-extraction-evaluator.js";
import {
  createParentingGuidanceAction,
  ParentingGuidanceRuntimeService,
} from "./lifeops/parenting/index.js";
import {
  createAnchorRegistry,
  createEventKindRegistry,
  createFamilyRegistry,
  createWorkflowStepRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
  registerAppLifeOpsBusFamilies,
  registerAppLifeOpsEventKinds,
  registerBuiltinTelemetryFamilies,
  registerDefaultBlockerPack,
  registerDefaultFeatureFlagPack,
  registerDefaultWorkflowStepPack,
  registerEventKindRegistry,
  registerFamilyRegistry,
  registerWorkflowStepRegistry,
} from "./lifeops/registries/index.js";
import { createOwnerReminderDirectRoutingRule } from "./lifeops/reminders/direct-routing.js";
import { LifeOpsRepository } from "./lifeops/repository.js";
import {
  createResourceCapacityAction,
  ResourceCapacityRuntimeService,
} from "./lifeops/resource-capacity/index.js";
// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";
import { createScheduledTaskCandidateBackstopRule } from "./lifeops/scheduled-task/candidate-backstop.js";
import { detachInboundScan } from "./lifeops/scheduled-task/deferred-inbound-scans.js";
import { completeFiredTasksOnOwnerReply } from "./lifeops/scheduled-task/inbound-reply-completion.js";
import {
  reconcileInterruptedMessageDraftDispatches,
  registerMessageDraftScheduledTaskBridge,
  unregisterMessageDraftScheduledTaskBridge,
} from "./lifeops/scheduled-task/message-draft-dispatch.js";
import {
  installLifeOpsScheduledTaskEventBridge,
  registerLifeOpsScheduledTaskRunnerDeps,
} from "./lifeops/scheduled-task/runtime-wiring.js";
import { handleScheduledTaskInboundMessage } from "./lifeops/scheduled-task/scheduler.js";
import { getScheduledTaskRunner as getProductionScheduledTaskRunner } from "./lifeops/scheduled-task/service.js";
import {
  handleAgentMessageSentForQuestionFollowup,
  handleOwnerMessageForQuestionFollowup,
} from "./lifeops/scheduled-task/unanswered-question-followup.js";
import { lifeOpsSchema } from "./lifeops/schema.js";
import {
  createSchoolSourceFactAction,
  SchoolSourceFactRuntimeService,
} from "./lifeops/school/index.js";
import {
  createSendPolicyRegistry,
  registerSendPolicyRegistry,
} from "./lifeops/send-policy/index.js";
import {
  createActivitySignalBus,
  registerActivitySignalBus,
} from "./lifeops/signals/bus.js";
import { createUndatedOwnerTodoDirectRoutingRule } from "./lifeops/todos/direct-routing.js";
import { threadOpsFieldEvaluator } from "./lifeops/work-threads/field-evaluator-thread-ops.js";
import { isDarwin } from "./platform/host.js";
import { browserBridgeProvider } from "./provider.js";
// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import { agreementPinsProvider } from "./providers/agreement-pins.js";
import { crossChannelContextProvider } from "./providers/cross-channel-context.js";
import { delegationContractsProvider } from "./providers/delegation-contracts.js";
// LifeOps core providers
import { firstRunProvider } from "./providers/first-run.js";
import { ftuGoalProvider } from "./providers/ftu-goal.js";
import { healthProvider } from "./providers/health.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { pendingApprovalsProvider } from "./providers/pending-approvals.js";
import { pendingPromptsProvider } from "./providers/pending-prompts.js";
import { recentTaskStatesProvider } from "./providers/recent-task-states.js";
import { roomPolicyProvider } from "./providers/room-policy.js";
import { workThreadsProvider } from "./providers/work-threads.js";
import { personalAssistantRoutesPlugin } from "./routes/plugin.js";
import { BrowserBridgePluginService } from "./service.js";
import {
  BLOCK_RULE_RECONCILE_TASK_NAME,
  ensureBlockRuleReconcileTask,
  registerBlockRuleReconcilerWorker,
} from "./website-blocker/chat-integration/index.js";

const handleDelegationInboundMessage = createDelegationInboundMessageHandler({
  createRepository: (runtime) => new LifeOpsRepository(runtime),
  createApprovalQueue: (runtime) =>
    createApprovalQueue(runtime, { agentId: runtime.agentId }),
  processTurn: processDelegationInboundTurn,
});
const handleHouseholdInboundApproval =
  createHouseholdInboundApprovalMessageHandler();
const schoolSourceFactAction = createSchoolSourceFactAction({
  authorize: hasLifeOpsAccess,
});
const householdOperationsAction = createHouseholdOperationsAction({
  authorize: hasLifeOpsAccess,
});
const resourceCapacityAction = createResourceCapacityAction({
  authorize: hasLifeOpsAccess,
});
const familyCommunicationsAction = createFamilyCommunicationsAction({
  resolveAuthenticatedPrincipal: resolveAuthenticatedFamilyPrincipal,
  issueSpeakerAttestation: issueAuthenticatedMessageSpeakerAttestation,
  resolveWeekItems: resolveTrustedChildWeekItems,
});
const parentingGuidanceAction = createParentingGuidanceAction({
  resolveAuthenticatedPrincipal: resolveAuthenticatedFamilyPrincipal,
});
const foodDomainAction = createFoodDomainAction({
  authorize: hasLifeOpsAccess,
});
const localConditionsAction = createLocalConditionsAction({
  authorize: hasLifeOpsAccess,
});

const GOOGLE_CONNECTOR_PLUGIN_PACKAGE = "@elizaos/plugin-google-workspace";
const GOOGLE_CONNECTOR_PLUGIN_NAME = "google";
const PERMISSIONS_REGISTRY_SERVICE = "eliza_permissions_registry";

function isPermissionsRegistry(value: unknown): value is IPermissionsRegistry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { check?: unknown }).check === "function" &&
    typeof (value as { request?: unknown }).request === "function" &&
    typeof (value as { openSettings?: unknown }).openSettings === "function" &&
    typeof (value as { registerProber?: unknown }).registerProber === "function"
  );
}

// plugin-blocker's SelfControl state lacks the shared contract's required
// `platform` field; adapt at this boundary so the registry sees the full shape.
const WEBSITE_BLOCKING_PLATFORM: Platform =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  process.platform === "linux"
    ? process.platform
    : "web";

function toSharedPermissionState(state: {
  status: PermissionState["status"];
  lastChecked: number;
  canRequest: boolean;
  reason?: string;
}): PermissionState {
  const shared: PermissionState = {
    id: "website-blocking",
    status: state.status,
    lastChecked: state.lastChecked,
    canRequest: state.canRequest,
    platform: WEBSITE_BLOCKING_PLATFORM,
  };
  if (state.reason !== undefined) {
    shared.reason = state.reason;
  }
  return shared;
}

const websiteBlockingPermissionProber: Prober = {
  id: "website-blocking",
  check: async () =>
    toSharedPermissionState(await getSelfControlPermissionState()),
  request: async () =>
    toSharedPermissionState(await requestSelfControlPermission()),
  openSettings: openSelfControlPermissionLocation,
};

export function registerLifeOpsWebsiteBlockingPermissionProber(
  runtime: IAgentRuntime,
): boolean {
  const service = runtime.getService(PERMISSIONS_REGISTRY_SERVICE);
  if (!isPermissionsRegistry(service)) {
    return false;
  }
  service.registerProber(websiteBlockingPermissionProber);
  return true;
}

async function ensureTaskWithRetries(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): Promise<void> {
  const isRuntimeStopped = () =>
    (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true;
  const delays = args.delays ?? [2_000, 5_000, 10_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (isRuntimeStopped()) {
      return;
    }
    try {
      await args.ensure();
      return;
    } catch (error) {
      if (isRuntimeStopped()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < delays.length) {
        args.runtime.logger.warn(
          `${args.prefix} ${args.label} init failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      args.runtime.logger.error(
        `${args.prefix} ${args.label} init failed after ${delays.length + 1} attempts: ${message}`,
      );
      throw error instanceof Error
        ? error
        : new Error(`${args.label} init failed: ${message}`);
    }
  }
}

function isDisabledByEnv(disableKey: string): boolean {
  const disableValue = (process.env[disableKey] ?? "").trim().toLowerCase();
  if (
    disableValue === "1" ||
    disableValue === "true" ||
    disableValue === "yes"
  ) {
    return true;
  }

  return false;
}

function isGoogleConnectorPlugin(plugin: Plugin): boolean {
  return (
    plugin.name === GOOGLE_CONNECTOR_PLUGIN_NAME ||
    plugin.name === GOOGLE_CONNECTOR_PLUGIN_PACKAGE
  );
}

function resolvePluginExport(module: Record<string, unknown>): Plugin | null {
  for (const key of ["googlePlugin", "default"]) {
    const value = module[key];
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Plugin).name === "string"
    ) {
      return value as Plugin;
    }
  }
  return null;
}

async function importGoogleConnectorPluginModule(): Promise<
  Record<string, unknown>
> {
  try {
    return (await import(GOOGLE_CONNECTOR_PLUGIN_PACKAGE)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const stagedDependencyUrl = new URL(
      "../node_modules/@elizaos/plugin-google-workspace/dist/index.js",
      import.meta.url,
    );
    try {
      return (await import(stagedDependencyUrl.href)) as Record<
        string,
        unknown
      >;
    } catch {
      throw error;
    }
  }
}

export async function ensureLifeOpsGooglePluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some(isGoogleConnectorPlugin)) {
    return;
  }

  const module = await importGoogleConnectorPluginModule();
  const plugin = resolvePluginExport(module);
  if (!plugin) {
    throw new Error(
      `${GOOGLE_CONNECTOR_PLUGIN_PACKAGE} did not export a valid plugin`,
    );
  }
  if (runtime.plugins.some(isGoogleConnectorPlugin)) {
    return;
  }
  await runtime.registerPlugin(plugin);
}

/**
 * Register `@elizaos/plugin-calendar` if it is not already in the runtime so
 * the calendar `CalendarService` (which LifeOps delegates every calendar call
 * to) is available. The calendar plugin is a hard LifeOps dependency, so a
 * static import is sufficient.
 *
 * PA composes its own CALENDAR and CONFLICT_DETECT actions with LifeOps deps
 * (travel buffers, approval gateway, host adapter), so only those two names
 * are withheld from the standalone plugin. Every other calendar action — the
 * typed CALENDAR_SOURCES source-administration surface in particular — must
 * stay reachable: this init runs before PA's own actions register, so passing
 * a colliding action here would silently win first-wins and shadow the
 * LifeOps-composed version.
 */
export async function ensureLifeOpsCalendarPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  // CALENDAR_SOURCES stays registered by the calendar plugin rather than being
  // composed here, so PA's hasLifeOpsAccess gate reaches it through the
  // runtime-keyed host adapter — bound before the already-registered early
  // return so the substitution holds either way.
  registerPersonalAssistantCalendarSourcesHost(runtime);
  if (runtime.plugins.some((plugin) => plugin.name === calendarPlugin.name)) {
    return;
  }
  const composedByPersonalAssistant = new Set([
    calendarAction.name,
    conflictDetectAction.name,
  ]);
  await runtime.registerPlugin({
    ...calendarPlugin,
    actions: (calendarPlugin.actions ?? []).filter(
      (action) => !composedByPersonalAssistant.has(action.name),
    ),
  });
}

/**
 * Register `@elizaos/plugin-pdf` when LifeOps is loaded directly. Parenting
 * agreement ingestion and the school-calendar workflow both require the
 * canonical `ServiceType.PDF` service, so exposing those routes without this
 * service leaves an otherwise healthy LifeOps installation unable to execute
 * either document path.
 */
export async function ensureLifeOpsPdfPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some((plugin) => plugin.name === pdfPlugin.name)) {
    return;
  }
  await runtime.registerPlugin(pdfPlugin);
}

/**
 * Register `@elizaos/plugin-finances` if it is not already in the runtime. The
 * finance tables (life_payment_*, life_subscription_*) moved out of LifeOps
 * into the finances plugin's `app_finances` schema; PA's finance repository
 * methods read/write those tables via raw SQL, so the finances plugin (which
 * owns the schema + the non-destructive data copy) MUST be loaded whenever PA
 * is. Hard dependency, so a static import is sufficient.
 */
export async function ensureLifeOpsFinancesPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some((plugin) => plugin.name === financesPlugin.name)) {
    return;
  }
  await runtime.registerPlugin(financesPlugin);
}

/**
 * Register `@elizaos/plugin-reminders` if it is not already in the runtime. The
 * reminder tables (life_reminder_plans / life_reminder_attempts /
 * life_escalation_states) moved out of LifeOps into the reminders plugin's
 * `app_reminders` schema; PA's reminder repository methods read/write those
 * tables via raw SQL, so the reminders plugin (which owns the schema + the
 * non-destructive data copy) MUST be loaded whenever PA is. Hard dependency,
 * static import.
 */
export async function ensureLifeOpsRemindersPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some((plugin) => plugin.name === remindersPlugin.name)) {
    return;
  }
  await runtime.registerPlugin(remindersPlugin);
}

/**
 * Register `@elizaos/plugin-inbox` if it is not already in the runtime. The
 * inbox triage domain (the INBOX action, the inboxTriage provider, and the
 * InboxService/InboxRepository back-end over the `app_lifeops` triage tables)
 * moved out of PA into the inbox plugin; PA still owns the cross-channel inbox
 * read route (`GET /api/lifeops/inbox`) via its `getInbox` service method, but
 * the action + provider + triage repository are registered there, so the inbox
 * plugin MUST be loaded whenever PA is. Hard dependency, static import.
 */
export async function ensureLifeOpsInboxPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some((plugin) => plugin.name === inboxPlugin.name)) {
    return;
  }
  await runtime.registerPlugin(inboxPlugin);
}

/**
 * Register `@elizaos/plugin-goals` if it is not already in the runtime. The
 * goal TABLES (life_goal_definitions / life_goal_links) were carved into
 * plugin-goals' own `app_goals` schema; PA's reminder/scheduling subsystem
 * still reads + writes goal links (service-mixin-reminders.ts: getGoal /
 * upsertGoalLink / deleteGoalLinksForLinked), but it does so through the
 * repository, whose SQL now targets `app_goals` — so a single owner of the
 * tables (plugin-goals) backs every reader. plugin-goals MUST be loaded
 * whenever PA is, both to create the `app_goals` schema and to run the
 * non-destructive app_lifeops -> app_goals migration. Hard dependency, static
 * import.
 */
export async function ensureLifeOpsGoalsPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.plugins.some((plugin) => plugin.name === goalsPlugin.name)) {
    return;
  }
  await runtime.registerPlugin({
    ...goalsPlugin,
    actions: [],
  });
}

export async function ensureLifeOpsHealthPluginRegistered(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!runtime.plugins.some((plugin) => plugin.name === healthPlugin.name)) {
    await runtime.registerPlugin(healthPlugin);
  }

  // Health is often loaded as a support package before PA creates the
  // registries it contributes to. Re-run the idempotent contribution hooks
  // after PA has attached those registries so boot order cannot drop health
  // connectors, anchors, bus families, default packs, or the circadian seam.
  registerHealthConnectors(runtime);
  registerHealthAnchors(runtime);
  registerHealthBusFamilies(runtime);
  registerHealthDefaultPacks(runtime);
  registerCircadianInsightContract(
    runtime,
    createDefaultCircadianInsightContract(),
  );
}

const LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY =
  "eliza:lifeops:plugin:init-failures";

async function recordTaskInitFailure(
  runtime: IAgentRuntime,
  label: string,
  message: string,
): Promise<void> {
  try {
    const existing =
      (await runtime.getCache<Record<string, string>>(
        LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY,
      )) ?? {};
    existing[label] = message;
    await runtime.setCache(LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY, existing);
  } catch {
    // Cache not available; the logger.error is the primary signal.
  }
}

/**
 * Kick off task registration AFTER `runtime.initPromise` resolves — this step
 * cannot be awaited inside `init()` because `init()` runs before the runtime
 * itself has finished initializing. That means failures here are NOT fatal
 * to plugin load; the plugin reports as "loaded" and the specific task
 * subsystem reports as "unavailable". The failure is surfaced via the
 * runtime cache at LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY for observability and
 * via logger.error so ops tooling can alert on it.
 */
// Darwin-only action surface: the native activity tracker, the only
// SCREEN_TIME data source the planner can reason about end-to-end, is
// macOS-only — hide the owner-screentime umbrella on other hosts so the
// planner never picks it.
const platformGatedActionUmbrellas = isDarwin() ? [ownerScreenTimeAction] : [];

function scheduleTaskEnsureAfterRuntimeInit(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): void {
  void args.runtime.initPromise
    .then(async () => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      await ensureTaskWithRetries(args);
    })
    .catch((error) => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      args.runtime.logger.error(
        `${args.prefix} ${args.label} init failed after runtime initialization (plugin stays loaded, this subsystem is degraded): ${message}`,
      );
      void recordTaskInitFailure(args.runtime, args.label, message);
    });
}

const rawPersonalAssistantPlugin: Plugin = {
  name: "@elizaos/plugin-personal-assistant",
  description:
    "Personal assistant workspace: executive workflows, owner approvals, scheduled tasks, calendar, inbox, documents, reminders, money admin, and focused owner-operation views.",
  // @elizaos/plugin-scheduling hosts the ScheduledTaskRunnerService + the
  // generic scheduled-task route; PA injects its production deps into it. It is
  // always-loaded (CORE + MOBILE), but declaring the dependency guarantees the
  // runner host is registered before PA's init injects deps + seeds. Agreement
  // ingestion also resolves the canonical complete-document PDF service and
  // must not boot with that required collaborator absent.
  dependencies: [
    GOOGLE_CONNECTOR_PLUGIN_PACKAGE,
    "@elizaos/plugin-scheduling",
    "@elizaos/plugin-pdf",
  ],
  // LifeOps owns the reply pipeline: connectors ingest but do not auto-reply
  // unless the operator explicitly disables passive mode.
  passiveConnectorsByDefault: true,
  schema: lifeOpsSchema,
  routes: personalAssistantRoutesPlugin.routes,
  actions: [
    // Canonical owner-operation umbrellas. Each umbrella registers itself + its
    // per-action virtuals via
    // `promoteSubactionsToActions` so the planner sees a discoverable
    // top-level entry for every flat child action (e.g. `BLOCK_BLOCK`,
    // `BLOCK_LIST_ACTIVE`, `OWNER_FINANCES_DASHBOARD`, `CREDENTIALS_FILL`, ...).
    ...promoteSubactionsToActions(blockAction),
    ...promoteSubactionsToActions(ownerFinancesAction),
    ...promoteSubactionsToActions(credentialsAction),
    ...promoteSubactionsToActions(calendarAction),
    ...promoteSubactionsToActions(householdCoordinationAction),
    ...promoteSubactionsToActions(householdOperationsAction),
    ...promoteSubactionsToActions(resourceCapacityAction),
    ...promoteSubactionsToActions(familyCommunicationsAction),
    parentingGuidanceAction,
    ...promoteSubactionsToActions(foodDomainAction),
    ...promoteSubactionsToActions(localConditionsAction),
    ...promoteSubactionsToActions(schoolSourceFactAction),
    familyWorkflowsAction,
    ...promoteSubactionsToActions(resolveRequestAction),
    ...promoteSubactionsToActions(ownerRemindersAction),
    ...promoteSubactionsToActions(ownerAlarmsAction),
    ...promoteSubactionsToActions(ownerGoalsAction),
    ...promoteSubactionsToActions(ownerTodosAction),
    ...promoteSubactionsToActions(ownerRoutinesAction),
    ...promoteSubactionsToActions(ownerHealthAction),
    ...platformGatedActionUmbrellas.flatMap((action) =>
      promoteSubactionsToActions(action),
    ),
    ...promoteSubactionsToActions(personalAssistantAction),
    resolveReferentAction,
    entityAction,
    ...promoteSubactionsToActions(ownerDocumentsAction),
    ownerAgreementKnowledgeAction,
    ...promoteSubactionsToActions(creativeDraftAction),
    ...promoteSubactionsToActions(briefAction),
    ...promoteSubactionsToActions(prioritizeAction),
    ...promoteSubactionsToActions(conflictDetectAction),
    // INBOX (+ its INBOX_* virtuals) registers via @elizaos/plugin-inbox,
    // which init() guarantees is loaded before PA's action array is
    // processed; plugin-inbox promotes the subactions itself.
    ...promoteSubactionsToActions(voiceCallAction),
    workThreadAction,
    // The create virtual carries an explicit de-claim: on live small models a
    // habit-shaped ask ("brush my teeth at 8 am and 9 pm every day") otherwise
    // routes to this raw scheduler surface instead of the OWNER_ROUTINES /
    // OWNER_REMINDERS definition pipeline (#10722 brush-teeth-basic).
    ...promoteSubactionsToActions(scheduledTaskAction, {
      overrides: {
        create: {
          description:
            "subaction = create — schedule a raw ScheduledTask (explicit structural trigger required). NOT for a new habit/routine/recurring personal reminder the owner asks for in chat — use OWNER_ROUTINES_CREATE / OWNER_REMINDERS_CREATE (definition + reminder plan).",
          descriptionCompressed:
            "raw ScheduledTask create (explicit trigger required); NEW habit/routine/daily reminder -> OWNER_ROUTINES_CREATE/OWNER_REMINDERS_CREATE",
        },
      },
    }),
    ...promoteSubactionsToActions(connectorAction),
    ...messagingTriageActions,
  ].map(ownerPrivateAction),
  providers: [
    browserBridgeProvider,
    firstRunProvider,
    ftuGoalProvider,
    roomPolicyProvider,
    agreementPinsProvider,
    lifeOpsProvider,
    pendingApprovalsProvider,
    delegationContractsProvider,
    pendingPromptsProvider,
    workThreadsProvider,
    recentTaskStatesProvider,
    healthProvider,
    // `inboxTriage` registers via @elizaos/plugin-inbox, which init()
    // guarantees is loaded (ensureLifeOpsInboxPluginRegistered) before PA's
    // own provider array is processed. Re-listing it here was a dead
    // duplicate the runtime silently skipped.
    crossChannelContextProvider,
    activityProfileProvider,
  ].map(ownerPrivateProvider),
  services: [
    BrowserBridgePluginService,
    ActivityTrackerService,
    PresenceSignalBridgeService,
    HouseholdCoordinationRuntimeService,
    AgreementKnowledgeRuntimeService,
    AuthenticatedRuntimeSpeakerVerifierService,
    FamilyCommunicationsRuntimeService,
    ParentingGuidanceRuntimeService,
    HouseholdOperationsRuntimeService,
    OwnerCalendarMutationGatewayService,
    ResourceCapacityRuntimeService,
    SchoolSourceFactRuntimeService,
    FoodDomainRuntimeService,
    FamilyWorkflowRuntimeService,
    // The ScheduledTaskRunnerService is now registered by the always-loaded
    // @elizaos/plugin-scheduling. PA injects its production deps via
    // registerLifeOpsScheduledTaskRunnerDeps(runtime) in init() instead, so
    // there is exactly one runner service per runtime.
  ],
  responseHandlerEvaluators: [
    deferredOwnerTodoRoutingEvaluator,
    ownerProfileExtractionEvaluator,
  ],
  responseHandlerFieldEvaluators: [threadOpsFieldEvaluator],
  // Post-turn evaluators join the runtime's single merged SMALL-model
  // evaluation call (EvaluatorService) — no extra model round-trip per turn.
  evaluators: [
    ftuGoalDiscoveryEvaluator,
    anticipationFeedbackEvaluator,
    commitmentExtractionEvaluator,
  ],
  // Domain data remains in the per-domain plugins. This one focused view owns
  // only cross-domain connector onboarding and management; it is not a second
  // inbox, calendar, or LifeOps overview.
  views: [
    {
      id: "lifeops-connections",
      label: "Mail & Calendars",
      description:
        "Connect, seed, inspect, and recover Gmail, Google Calendar, and Apple Calendar.",
      icon: "Cable",
      path: "/lifeops/connections",
      responseContext: {
        primaryContext: "connectors",
        secondaryContexts: ["email", "calendar"],
      },
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      surface: { header: "fullscreen", capabilities: ["agent-surface"] },
      componentExport: "LifeOpsConnectionsView",
      tags: ["gmail", "email", "calendar", "lifeops", "connections"],
      relatedActions: ["CONNECTOR", "INBOX", "CALENDAR"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "family-operations",
      label: "Family Operations",
      roleGate: { minRole: "OWNER" },
      description:
        "Private parenting agreements, linked calendars, school dates, and monthly coordination packets.",
      icon: "UsersRound",
      path: "/lifeops/family",
      responseContext: {
        primaryContext: "family",
        secondaryContexts: ["calendar", "docs", "contacts"],
      },
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      surface: { header: "fullscreen", capabilities: ["agent-surface"] },
      componentExport: "FamilyOperationsView",
      tags: ["family", "coparenting", "agreement", "calendar", "school"],
      relatedActions: ["OWNER_AGREEMENT_KNOWLEDGE", "CALENDAR"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  events: {
    [EventType.MESSAGE_MUTATED]: [handleBriefMessageMutation],
    // Deterministic completion for fired scheduled tasks awaiting an owner
    // reply — no LLM verb required. Two passes with distinct coverage:
    // `handleScheduledTaskInboundMessage` walks the pending-prompts store for
    // the room (user_replied_within + stale-prompt teardown);
    // `completeFiredTasksOnOwnerReply` matches fired tasks by their own
    // pending-prompt room and re-evaluates every check kind (incl.
    // subject_updated). Both are owner-gated and idempotent.
    //
    // These scans are side effects that do not feed the reply's first token,
    // so each is detached from the awaited MESSAGE_RECEIVED edge (#15255):
    // `emitEvent` awaits `Promise.all` over every handler, and both TTFT
    // entry edges await that emit before Stage-1 work, so a slow store scan
    // here would land one-for-one on TTFT. `detachInboundScan` runs the scan
    // in the background and surfaces any failure via `runtime.reportError`.
    [EventType.MESSAGE_RECEIVED]: [
      detachInboundScan(
        "scheduled-task-inbound",
        handleScheduledTaskInboundMessage,
      ),
      detachInboundScan(
        "inbound-reply-completion",
        async (payload: MessagePayload): Promise<void> => {
          await completeFiredTasksOnOwnerReply(
            payload.runtime,
            payload.message,
          );
        },
      ),
      // Owner re-engaged: any still-scheduled unanswered-question follow-up
      // for the room is stale — dismiss it (#14676).
      detachInboundScan(
        "question-followup-cancel",
        handleOwnerMessageForQuestionFollowup,
      ),
      detachInboundScan(
        "delegation-contract-inbound",
        handleDelegationInboundMessage,
      ),
      detachInboundScan(
        "household-approval-inbound",
        handleHouseholdInboundApproval,
      ),
    ],
    // Agent reply ends with a question the owner never answers → seed a
    // once-fired follow-up whose fire-time admission is the model moment
    // judge (#14676, riding the #14677 model_moment_check seam).
    [EventType.MESSAGE_SENT]: [handleAgentMessageSentForQuestionFollowup],
    // Fold recognized voice turns into the entity/relationship graph via
    // the merge engine, then round-trip the binding to the voice-profile
    // owner. See lifeops/entities/voice-observer-bridge.ts.
    [EventType.VOICE_TURN_OBSERVED]: [handleVoiceTurnObserved],
  },
  init: async (
    _pluginConfig: Record<string, unknown>,
    runtime: IAgentRuntime,
  ) => {
    registerPersonalAssistantConflictDetectHost(runtime);
    runtime.registerEvent(MEETING_TRANSCRIPT_FINALIZED_EVENT, async (payload) =>
      handleMeetingTranscriptFinalized(
        payload as EventPayload & MeetingTranscriptFinalizedPayload,
      ),
    );

    // These registries participate in the first inbound turn. Establish them
    // before plugin discovery yields so a newly ready runtime cannot briefly
    // answer an actionable request as plain chat.
    registerCandidateActionBackstopRule(
      runtime,
      createScheduledTaskCandidateBackstopRule(),
    );
    registerDirectActionRoutingRule(
      runtime,
      createTrackedWorkRecapDirectRoutingRule(),
    );
    registerDirectActionRoutingRule(
      runtime,
      createOwnerReminderDirectRoutingRule(),
    );
    registerDirectActionRoutingRule(
      runtime,
      createUndatedOwnerTodoDirectRoutingRule(),
    );

    // When LIFEOPS_USE_MOCKOON=1, redirect every external connector base URL
    // to the matching Mockoon environment on localhost. No-op otherwise.
    const mockoonApplied = applyMockoonEnvOverrides();
    if (mockoonApplied.length > 0) {
      logger.info(
        { mockoonConnectors: mockoonApplied },
        `[lifeops] LIFEOPS_USE_MOCKOON=1 — redirecting ${mockoonApplied.length} connector base URL(s) to mock servers`,
      );
    }

    registerLifeOpsWebsiteBlockingPermissionProber(runtime);

    await ensureLifeOpsGooglePluginRegistered(runtime);
    await ensureLifeOpsCalendarPluginRegistered(runtime);
    await ensureLifeOpsPdfPluginRegistered(runtime);

    await ensureLifeOpsFinancesPluginRegistered(runtime);
    await ensureLifeOpsRemindersPluginRegistered(runtime);
    await ensureLifeOpsGoalsPluginRegistered(runtime);
    await ensureLifeOpsInboxPluginRegistered(runtime);

    // Inject the LifeOps-backed calendar gate once the runtime has finished
    // initializing both plugins, so calendar events keep firing reminders and
    // writing audit rows through the LifeOps repository. Non-fatal on failure:
    // the calendar service falls back to its default gate (Google-only, no
    // reminder/audit side effects).
    void runtime.initPromise
      .then(() => {
        if (
          (runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
        ) {
          return;
        }
        registerLifeOpsCalendarGate(runtime);
      })
      .catch((error) => {
        logger.error(
          `[lifeops] failed to register calendar host gate (calendar degraded to default gate): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    // Expired, revoked, and already-consumed private card files are a separate
    // lifecycle concern from calendar-gate registration. Keep their failures
    // independently observable so cleanup trouble cannot masquerade as a
    // disabled calendar host gate.
    void runtime.initPromise
      .then(async () => {
        if (
          (runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
        ) {
          return;
        }
        await new CalendarCardAccessStore(runtime).cleanup();
      })
      .catch((error) => {
        // error-policy:J7 startup cleanup is diagnostic maintenance; report it
        // without preventing the rest of the assistant from initializing.
        logger.error(
          `[lifeops] failed to clean private calendar cards: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        runtime.reportError("LifeOps.calendarCardCleanup", error, {
          recovery: "next_monthly_workflow_or_restart",
        });
      });

    const connectorRegistry = createConnectorRegistry();
    registerDefaultConnectorPack(connectorRegistry, runtime);
    registerConnectorRegistry(runtime, connectorRegistry);
    (
      runtime as IAgentRuntime & {
        connectorRegistry?: typeof connectorRegistry;
      }
    ).connectorRegistry = connectorRegistry;

    const oraclePack = createDefaultOraclePack(runtime);
    registerExternalOracleRegistry(runtime, oraclePack.external);
    registerLocalActivityAdapterRegistry(runtime, oraclePack.localActivities);

    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    // Meeting auto-join dispatch channel: plugin-calendar's scheduled join
    // tasks fire through the standard runner with
    // `escalation.steps[0].channelKey = "meeting_join"`; the send verb loads
    // the calendar event, re-validates its conference link, and asks the
    // meetings service to join (dependency direction stays PA -> calendar).
    channelRegistry.register({
      kind: MEETING_JOIN_CHANNEL_KEY,
      describe: { label: "Meeting join (send the agent into a video meeting)" },
      capabilities: {
        send: true,
        read: false,
        reminders: false,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      send: (payload) => handleMeetingJoinDispatch(runtime, payload),
    });
    registerChannelRegistry(runtime, channelRegistry);
    installFirstRunChannelInspector(runtime, channelRegistry);
    (
      runtime as IAgentRuntime & { channelRegistry?: typeof channelRegistry }
    ).channelRegistry = channelRegistry;

    // Inject PA's production scheduled-task deps into the always-loaded
    // @elizaos/plugin-scheduling runner host. The runner service itself lives
    // in plugin-scheduling now; this binds it to LifeOps's DB-backed store,
    // production dispatcher, owner-facts / channel-keys / host-capability
    // probes, and anchor registry. First-wins, so this stays authoritative for
    // the lifetime of the runtime once registered.
    registerLifeOpsScheduledTaskRunnerDeps(runtime);
    registerScheduledTaskRunnerBootHook(runtime, async (service) => {
      const { ensureFamilyBackupCleanupSchedule } = await import(
        "./lifeops/family-workflows/backup-cleanup-schedule.js"
      );
      await ensureFamilyBackupCleanupSchedule(
        runtime,
        service.getRunner({ agentId: runtime.agentId }),
      );
    });

    const sendPolicyRegistry = createSendPolicyRegistry();
    registerSendPolicyRegistry(runtime, sendPolicyRegistry);

    registerDefaultBlockerPack(runtime);

    const anchorRegistry = createAnchorRegistry();
    registerAppLifeOpsAnchors(anchorRegistry);
    registerAnchorRegistry(runtime, anchorRegistry);
    (
      runtime as IAgentRuntime & { anchorRegistry?: typeof anchorRegistry }
    ).anchorRegistry = anchorRegistry;

    const eventKindRegistry = createEventKindRegistry();
    registerAppLifeOpsEventKinds(eventKindRegistry);
    registerEventKindRegistry(runtime, eventKindRegistry);
    (
      runtime as IAgentRuntime & {
        eventKindRegistry?: typeof eventKindRegistry;
      }
    ).eventKindRegistry = eventKindRegistry;
    // Bridge runtime.emitEvent onto {kind:"event"} scheduled-task fires for
    // every registered event kind. Must run after registerEventKindRegistry;
    // the runner resolves lazily per event through the cached service host.
    installLifeOpsScheduledTaskEventBridge(runtime);

    const familyRegistry = createFamilyRegistry();
    registerBuiltinTelemetryFamilies(familyRegistry);
    registerAppLifeOpsBusFamilies(familyRegistry);
    registerFamilyRegistry(runtime, familyRegistry);
    (
      runtime as IAgentRuntime & { busFamilyRegistry?: typeof familyRegistry }
    ).busFamilyRegistry = familyRegistry;

    activateLifeOpsActivitySignals(runtime);

    const workflowStepRegistry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(workflowStepRegistry);
    registerWorkflowStepRegistry(runtime, workflowStepRegistry);
    (
      runtime as IAgentRuntime & {
        workflowStepRegistry?: typeof workflowStepRegistry;
      }
    ).workflowStepRegistry = workflowStepRegistry;

    // FeatureFlagRegistry — open-key registry covering the 10 closed
    // `LifeOpsFeatureKey` built-ins plus any 3rd-party plugin contributions.
    // Audit C top-1 finding (`docs/audit/rigidity-hunt-audit.md`).
    registerDefaultFeatureFlagPack(runtime);

    const activitySignalBus = createActivitySignalBus({ familyRegistry });
    registerActivitySignalBus(runtime, activitySignalBus);
    // Structural runtime property (same pattern as anchorRegistry /
    // busFamilyRegistry above): plugin-health's observed-anchor resolvers
    // read wake/sleep transition envelopes back through
    // `runtime.activitySignalBus` (its `ActivitySignalReader` contract)
    // without importing this plugin.
    (
      runtime as IAgentRuntime & {
        activitySignalBus?: typeof activitySignalBus;
      }
    ).activitySignalBus = activitySignalBus;

    await ensureLifeOpsHealthPluginRegistered(runtime);

    const ownerFactStore = createOwnerFactStore(runtime);
    registerOwnerFactStore(runtime, ownerFactStore);
    registerCoreFactMemoryBridge(runtime);

    const promptRegistry = createMultilingualPromptRegistry();
    registerDefaultPromptPack(promptRegistry);
    registerMultilingualPromptRegistry(runtime, promptRegistry);

    // End-to-end locale wiring: the planner (in core) reads this provider
    // each turn, awaits the resolved owner-locale, and passes the
    // resulting `LocalizedActionExampleResolver` into `buildActionCatalog`.
    registerLocalizedExamplesProvider(
      runtime,
      createOwnerLocaleExamplesProvider(runtime),
    );

    // Owner outbound-message approval policy: gmail drafts require explicit
    // owner approval; everything else passes straight through. The stable
    // OWNER_SEND_APPROVAL task worker executes the held send once the owner
    // confirms via CHOOSE_OPTION (issue #10723).
    registerOwnerSendApprovalWorker(runtime);
    registerSendPolicy(runtime, createOwnerSendPolicy());
    // First-party adapters backed by LifeOps services. Gmail and X replace the
    // core default adapters so MESSAGE triage operations operate on real
    // connected data.
    const triage = getDefaultTriageService();
    triage.register(new GoogleGmailAdapter());
    triage.register(new XDmAdapter());
    triage.register(new BrowserBridgeAdapter());

    // Register the activity-profile maintenance worker. One scheduler
    // (#10721 H1): this tick only maintains the owner activity profile and
    // learned schedule facts, without planning actions or creating approvals.
    // Owner-facing proactive dispatch (GM/GN, nudges, check-ins) is owned by the
    // scheduled-task runner via the first-run defaults pack + default-pack
    // catalog below. ELIZA_DISABLE_PROACTIVE_AGENT keeps its historical
    // semantics: it gates this worker (never the spine-seeded records).
    const proactiveAgentDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_PROACTIVE_AGENT",
    );
    if (!proactiveAgentDisabled) {
      registerProactiveTaskWorker(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[proactive]",
        label: "task",
        ensure: async () => {
          if (!isAppFirstRunComplete()) return;
          await ensureProactiveAgentTask(runtime);
        },
      });
    } else {
      runtime.logger.info(
        "[proactive] Proactive agent task skipped — ELIZA_DISABLE_PROACTIVE_AGENT=1",
      );
    }

    // Register the follow-up tracker worker.
    registerFollowupTrackerWorker(runtime);
    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[followup-tracker]",
      label: "task",
      ensure: async () => {
        await ensureFollowupTrackerTask(runtime);
      },
    });

    registerBlockRuleReconcilerWorker(runtime);
    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[block-rule-reconciler]",
      label: "task",
      ensure: async () => {
        await ensureBlockRuleReconcileTask(runtime);
      },
    });

    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[lifeops]",
      label: "inbox cache schema",
      ensure: async () => {
        await LifeOpsRepository.ensureInboxCacheIndexes(runtime);
      },
    });

    const lifeOpsSchedulerDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_LIFEOPS_SCHEDULER",
    );
    let workflowClaimSchemaReady = false;
    // Register the identity even when execution is disabled. Owner-profile
    // updates persist on the LIFEOPS_SCHEDULER row and can create it lazily;
    // the disabled worker keeps that row valid while shouldRun=false preserves
    // the process-level kill switch.
    registerLifeOpsTaskWorker(runtime, {
      disabled: lifeOpsSchedulerDisabled,
      isWorkflowClaimSchemaReady: () => workflowClaimSchemaReady,
    });
    if (!lifeOpsSchedulerDisabled) {
      registerMessageDraftScheduledTaskBridge(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[lifeops]",
        label: "deferred message reconciliation",
        ensure: async () => {
          await waitForScheduledTaskRunnerService(runtime);
          await reconcileInterruptedMessageDraftDispatches(runtime);
        },
      });
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[lifeops]",
        label: "scheduler task",
        ensure: async () => {
          // The workflow-run claim is only an election once the partial
          // unique index exists (installed by the bootstrapSchema compat
          // repair, not by the ordinary drizzle migration). Install/verify it
          // before the scheduler task is ensured so a cold worker cannot
          // execute workflows against an unconstrained table. On failure the
          // scheduler task stays un-ensured and the failure is logged +
          // recorded by scheduleTaskEnsureAfterRuntimeInit ("subsystem is
          // degraded"); claimWorkflowRun's explicit conflict target fails
          // closed as the backstop for any path that races this install.
          await LifeOpsRepository.bootstrapSchema(runtime);
          workflowClaimSchemaReady = true;
          await ensureLifeOpsSchedulerTask(runtime);
        },
      });
      // Register the default-pack catalog (quiet-user watcher, cadence
      // follow-ups, …) as PA's consumer pack on the spine seed registry.
      // The spine's boot seeder materializes it once per idempotency key
      // after runtime init. Records whose logical slot the first-run pack
      // below already owns (gm/gn/check-in/morning-brief) are reconciled
      // out — see src/default-packs/spine-registration.ts for the upgrade
      // story.
      registerDefaultPackCatalog(runtime);
      // Seed the first-run defaults pack idempotently on EVERY boot — not
      // gated behind first-run completion — so devices that predate the pack
      // still receive the paused weekly-review starter + default routines.
      // The per-key seeded marker makes this seed-once: a default the user
      // deletes is never recreated, and fresh first-run installs are covered
      // by the same marker so there is no double-seed. Uses the production
      // DB-backed runner so seeded rows reach the scheduler tick. (The
      // first-run pack keeps its own marker store + keys; the catalog pack
      // above seeds disjoint keys through the spine registry.)
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[lifeops]",
        label: "default-pack boot seed",
        ensure: async () => {
          await waitForScheduledTaskRunnerService(runtime);
          const runner = getProductionScheduledTaskRunner(runtime, {
            agentId: runtime.agentId,
          });
          const firstRun = new FirstRunService(runtime, { runner });
          await firstRun.seedDefaultPackOnBoot();
        },
      });
    } else {
      runtime.logger.info(
        "[lifeops] Scheduler task skipped — ELIZA_DISABLE_LIFEOPS_SCHEDULER=1",
      );
    }
  },
  /**
   * Tear down everything `init` registered so `runtime.unloadPlugin(...)`
   * produces an actually-stopped LifeOps:
   *   - Unregister task workers (proactive, follow-up, scheduler)
   *   - Delete the persisted task rows that reference those workers
   *
   * Routes, services, actions, providers, and event listeners are cleaned
   * up automatically by the runtime's plugin-lifecycle teardown — no need
   * to touch those here.
   */
  dispose: async (runtime: IAgentRuntime) => {
    deactivateLifeOpsActivitySignals(runtime);
    setRuntimeChannelInspector(runtime, null);
    unregisterMessageDraftScheduledTaskBridge(runtime);

    const taskNames: readonly string[] = [
      PROACTIVE_TASK_NAME,
      LIFEOPS_TASK_NAME,
      FOLLOWUP_TRACKER_TASK_NAME,
      BLOCK_RULE_RECONCILE_TASK_NAME,
    ];

    // Delete persisted Task rows so the scheduler doesn't try to run them
    // on restart (the worker function will be gone).
    for (const name of taskNames) {
      try {
        const tasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
        });
        for (const task of tasks) {
          if (task.name === name && task.id) {
            try {
              await runtime.deleteTask(task.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              runtime.logger.warn(
                `[lifeops:dispose] Failed to delete task ${name} (${task.id}): ${msg}`,
              );
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger.warn(
          `[lifeops:dispose] Failed to list tasks for "${name}": ${msg}`,
        );
      }
    }

    // Unregister the in-memory worker functions.
    for (const name of taskNames) {
      try {
        runtime.unregisterTaskWorker(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger.warn(
          `[lifeops:dispose] Failed to unregister task worker "${name}": ${msg}`,
        );
      }
    }
  },
};

export const personalAssistantPlugin: Plugin = rawPersonalAssistantPlugin;

export { appBlockerProvider } from "@elizaos/plugin-blocker/providers/app-blocker";
export {
  getAppBlockerPermissionState,
  getAppBlockerStatus,
  getCachedAppBlockerStatus,
  getInstalledApps,
  requestAppBlockerPermission,
  selectAppsForBlocking,
  startAppBlock,
  stopAppBlock,
} from "@elizaos/plugin-blocker/services/app-blocker/index";
export { ownerAgreementKnowledgeAction } from "./actions/agreement-knowledge.js";
export { workThreadAction } from "./actions/work-thread.js";
export type { OverdueDigest, OverdueFollowup } from "./followup/index.js";
export {
  computeOverdueFollowups,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  FOLLOWUP_MEMORY_TABLE,
  FOLLOWUP_TRACKER_INTERVAL_MS,
  FOLLOWUP_TRACKER_TASK_NAME,
  FOLLOWUP_TRACKER_TASK_TAGS,
  getFollowupTrackerRoomId,
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  reconcileFollowupsOnce,
  registerFollowupTrackerWorker,
  setFollowupThresholdAction,
  writeOverdueDigestMemory,
} from "./followup/index.js";
export {
  type AnticipationFeedbackOutput,
  anticipationFeedbackEvaluator,
  parseAnticipationFeedbackOutput,
} from "./lifeops/anticipation/evaluator.js";
export {
  type AnticipationOutcome,
  type AnticipationStats,
  listUnprocessedDispatches,
  type ProactiveDispatchMarker,
  readAnticipationStats,
  recordAnticipationFeedback,
  recordProactiveDispatch,
} from "./lifeops/anticipation/store.js";
export { CheckinService } from "./lifeops/checkin/checkin-service.js";
export type { CheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export { resolveCheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export type {
  CheckinKind,
  CheckinReport,
  EscalationLevel,
  MeetingEntry,
  OverdueTodo,
  RecentWin,
  RecordAcknowledgementRequest,
  RunCheckinRequest,
} from "./lifeops/checkin/types.js";
export {
  FirstRunService,
  type ScheduledTaskRunnerLike,
  setScheduledTaskRunner,
} from "./lifeops/first-run/service.js";
export {
  createFirstRunStateStore,
  createOwnerFactStore,
  createSeededDefaultsStore,
  type FirstRunRecord,
  type FirstRunStateStore,
  type OwnerFactStore,
  type OwnerFacts,
  type OwnerFactsPatch,
  type SeededDefaultsMarker,
  type SeededDefaultsStore,
} from "./lifeops/first-run/state.js";
export {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  type FtuGoalDiscoveryOutput,
  ftuGoalDiscoveryEvaluator,
  parseFtuGoalOutput,
} from "./lifeops/ftu-goal/evaluator.js";
export {
  createFtuGoalStateStore,
  type DiscoveredFtuGoal,
  type FtuGoalRecord,
  type FtuGoalStateStore,
  type FtuGoalStatus,
} from "./lifeops/ftu-goal/state.js";
export {
  createGlobalPauseStore,
  type GlobalPauseStatus,
  type GlobalPauseStore,
  type GlobalPauseWindow,
  resolveGlobalPauseStore,
} from "./lifeops/global-pause/store.js";
export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  type HandoffEnterOpts,
  type HandoffStatus,
  type HandoffStore,
  type ResumeCondition,
  type ResumeEvaluation,
  type ResumeEvaluationInput,
  resolveHandoffStore,
} from "./lifeops/handoff/store.js";
export {
  type AgreementGuestGrantPreview,
  AgreementKnowledgeError,
  AgreementKnowledgeRuntimeService,
  AgreementKnowledgeService,
  type AgreementObligationStatus,
  type HouseholdKnowledgeGrant,
  type HouseholdKnowledgePin,
  type KnowledgePinTargetType,
  type ParentingAgreementArtifact,
  type ParentingAgreementObligation,
  type ParentingAgreementView,
} from "./lifeops/household/agreement-knowledge.js";
export {
  createMultilingualPromptRegistry,
  getDefaultPromptExamplePair,
  getDefaultPromptRegistry,
  getMultilingualPromptRegistry,
  type MultilingualPromptRegistry,
  PROMPT_REGISTRY_DEFAULT_LOCALE,
  type PromptExampleEntry,
  type PromptLocale,
  type PromptRegistryFilter,
  registerDefaultPromptPack,
  registerMultilingualPromptRegistry,
  resolveActionExamplePairs,
} from "./lifeops/i18n/prompt-registry.js";
export {
  type EscalationRule,
  getOwnerFactStore,
  type OwnerChronotype,
  type OwnerFactEntry,
  type OwnerFactProvenance,
  type OwnerFactProvenanceSource,
  type OwnerFactWindow,
  type OwnerQuietHours,
  type OwnerScheduleStyle,
  ownerFactsToView,
  type PolicyPatchEscalationRule,
  type PolicyPatchReminderIntensity,
  type ReminderIntensity,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "./lifeops/owner/fact-store.js";
export {
  createPendingPromptsStore,
  type PendingPromptRecordInput,
  type PendingPromptsStore,
  resolvePendingPromptsStore,
} from "./lifeops/pending-prompts/store.js";
// LifeOps runtime exports
export {
  ensureLifeOpsSchedulerTask,
  executeLifeOpsSchedulerTask,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./lifeops/runtime.js";
export { resetLifeOpsScenarioState } from "./lifeops/scenario-reset.js";
export type {
  AnchorConsolidationPolicy,
  AnchorContribution,
  AnchorRegistry,
  CompletionCheckContribution,
  CompletionCheckRegistry,
  EscalationLadder,
  EscalationLadderRegistry,
  EscalationStep,
  GateDecision,
  ProcessDueScheduledTasksRequest,
  ProcessDueScheduledTasksResult,
  ProcessScheduledTaskInboundMessageRequest,
  ProcessScheduledTaskInboundMessageResult,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskCompletionResult,
  ScheduledTaskContextRequest,
  ScheduledTaskDueContext,
  ScheduledTaskDueDecision,
  ScheduledTaskEscalation,
  ScheduledTaskFilter,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskOutput,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskRunner,
  ScheduledTaskRunnerHandle,
  ScheduledTaskShouldFire,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskTrigger,
  ScheduledTaskVerb,
  TaskGateContribution,
  TaskGateRegistry,
  TerminalState,
} from "./lifeops/scheduled-task/index.js";
export {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  DEFAULT_ESCALATION_LADDERS,
  PRIORITY_DEFAULT_LADDER_KEYS,
  processDueScheduledTasks,
  processScheduledTaskInboundMessage,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerFallbackAnchors,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./lifeops/scheduled-task/index.js";
export type { CreateRuntimeRunnerOptions } from "./lifeops/scheduled-task/runtime-wiring.js";
export {
  createRuntimeScheduledTaskRunner,
  registerLifeOpsScheduledTaskSubjectStore,
} from "./lifeops/scheduled-task/runtime-wiring.js";
export type { GetScheduledTaskRunnerOptions } from "./lifeops/scheduled-task/service.js";
export {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "./lifeops/scheduled-task/service.js";
export { threadOpsFieldEvaluator } from "./lifeops/work-threads/field-evaluator-thread-ops.js";
export {
  type CreateWorkThreadInput,
  createWorkThreadStore,
  type ThreadSourceRef,
  type UpdateWorkThreadInput,
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadEventType,
  type WorkThreadListFilter,
  type WorkThreadStatus,
  type WorkThreadStore,
} from "./lifeops/work-threads/index.js";
export { agreementPinsProvider } from "./providers/agreement-pins.js";
export { delegationContractsProvider } from "./providers/delegation-contracts.js";
export type { FirstRunAffordance } from "./providers/first-run.js";
export { firstRunProvider } from "./providers/first-run.js";
export type { FtuGoalAffordance } from "./providers/ftu-goal.js";
export { ftuGoalProvider } from "./providers/ftu-goal.js";
export { healthProvider } from "./providers/health.js";
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";
export {
  pendingApprovalsProvider,
  renderPendingApprovalsText,
} from "./providers/pending-approvals.js";
export type {
  PendingPrompt,
  PendingPromptsProvider,
} from "./providers/pending-prompts.js";
export {
  createPendingPromptsProvider,
  pendingPromptsProvider,
} from "./providers/pending-prompts.js";
export type {
  RecentTaskStatesProvider,
  RecentTaskStatesSummary,
} from "./providers/recent-task-states.js";
export {
  createRecentTaskStatesProvider,
  recentTaskStatesProvider,
} from "./providers/recent-task-states.js";
export { roomPolicyProvider } from "./providers/room-policy.js";
export { workThreadsProvider } from "./providers/work-threads.js";
export { handleAgreementKnowledgeRoutes } from "./routes/agreement-knowledge-routes.js";
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export { BrowserBridgePluginService, browserBridgeProvider };
