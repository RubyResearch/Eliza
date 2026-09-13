/**
 * Long-lived ScheduledTask runner host service + the runtime-injected
 * dependency port that builds its runner.
 *
 * This is the storage-agnostic home of the scheduled-task spine's runtime
 * surface. `@elizaos/plugin-scheduling` ships a DEFAULT deps provider
 * (scheduling-owned SQL store when a runtime DB exists, otherwise in-memory
 * fallback; built-in registries; an `in_app`/NOTIFICATION dispatcher;
 * warn-once stand-in ports; and an `ELIZA_PLATFORM`-driven host-capability
 * predicate) so the runner + its REST surface + the seed mechanism work on ANY
 * platform — including mobile — from this plugin alone.
 *
 * A consumer (e.g. `@elizaos/plugin-personal-assistant`) injects its production
 * deps via {@link registerScheduledTaskRunnerDeps} at init: the durable store
 * plus production dispatcher, real owner-facts / channel-keys /
 * host-capability probes. When PA is loaded its deps win; when absent, the
 * default deps run. This keeps `@elizaos/plugin-scheduling` free of any
 * `@elizaos/app-core` / `@elizaos/agent` / `@elizaos/plugin-personal-assistant`
 * import.
 *
 * One runner/store invariant: there is exactly one service
 * (serviceType `"lifeops_scheduled_task_runner"`, runtime first-wins dedup) and
 * exactly one set of injected deps per runtime.
 */

import {
  ElizaError,
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
} from "@elizaos/core";
import { createDrizzleCarveOutDatabase } from "@elizaos/plugin-sql";
import { resolvePlatform } from "@elizaos/shared/runtime-env";
import {
  createCodingAgentScheduleDispatcher,
  PR_SHEPHERD_DISPATCH_CHANNEL,
} from "../coding-agent-schedules.js";
import type { DispatchResult } from "../dispatch-types.js";
import {
  getScheduledTaskChannelDispatcher,
  listScheduledTaskChannelDispatcherKeys,
} from "./channel-dispatcher-registry.js";
import {
  type CompletionCheckRegistry,
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  dispatchViaMessageConnector,
  isConnectorDispatchIntent,
  resolveConnectorDispatchTarget,
  runtimeHasMessageConnector,
} from "./connector-dispatch.js";
import {
  type AnchorRegistry,
  type ConsolidationRegistry,
  createAnchorRegistry,
  createConsolidationRegistry,
  registerFallbackAnchors,
} from "./consolidation-policy.js";
import {
  renderFailureDispatchResult,
  renderScheduledDispatchMessage,
  renderScheduledDispatchTitle,
} from "./dispatch-render.js";
import {
  createEscalationLadderRegistry,
  type EscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
  type TaskGateRegistry,
} from "./gate-registry.js";
import { migrateSchedulingTables } from "./migration.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskDispatcher,
  type ScheduledTaskRunnerDeps,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "./runner.js";
import { getRuntimeDb } from "./sql.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import {
  createSchedulingSqlScheduledTaskLogStore,
  createSchedulingSqlScheduledTaskStore,
} from "./store.js";
import {
  type ActivitySignalBusView,
  type GlobalPauseView,
  type OwnerFactsView,
  type SubjectStoreView,
  TASK_EXECUTION_PROFILES,
  type TaskExecutionProfile,
} from "./types.js";

const SERVICE_TYPE = "lifeops_scheduled_task_runner" as const;

/**
 * Everything the runner needs that is host-specific. A consumer injects a
 * provider via {@link registerScheduledTaskRunnerDeps}; the default provider
 * below supplies a scheduling-owned SQL store when a runtime DB is available
 * and an in-memory fallback for isolated hosts/tests.
 *
 * Registries are optional: when omitted, the host service builds the built-in
 * gate / completion-check / ladder / anchor / consolidation registries.
 */
export interface ScheduledTaskRunnerDepsBundle {
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
  dispatcher: ScheduledTaskDispatcher;
  executionBoundary?: ScheduledTaskRunnerDeps["executionBoundary"];
  ownerFacts: () => OwnerFactsView | Promise<OwnerFactsView>;
  globalPause: GlobalPauseView;
  activity: ActivitySignalBusView;
  subjectStore: SubjectStoreView;
  channelKeys?: () => ReadonlySet<string>;
  channelAvailable?: (channelKey: string) => boolean | Promise<boolean>;
  hostCapabilities?: () => ReadonlySet<TaskExecutionProfile>;
  gates?: TaskGateRegistry;
  completionChecks?: CompletionCheckRegistry;
  ladders?: EscalationLadderRegistry;
  anchors?: AnchorRegistry;
  consolidation?: ConsolidationRegistry;
}

/**
 * A consumer registers a provider that builds the deps bundle for a given
 * `(runtime, agentId)`. The provider is resolved lazily — once per runner
 * construction — so the consumer can read live runtime registries.
 */
export type ScheduledTaskRunnerDepsProvider = (
  runtime: IAgentRuntime,
  agentId: string,
) => ScheduledTaskRunnerDepsBundle;

const depsProvidersByRuntime = new WeakMap<
  IAgentRuntime,
  ScheduledTaskRunnerDepsProvider
>();

/**
 * Register the production deps provider on the runtime. First-wins: a later
 * call does NOT override an earlier registration, so the consumer (PA) that
 * registers during init keeps ownership. The runtime cache is not used here
 * because the provider is a function (not serializable); it is stored on the
 * runtime object directly, mirroring the runtime-registry pattern used by the
 * anchor registry.
 */
export function registerScheduledTaskRunnerDeps(
  runtime: IAgentRuntime,
  provider: ScheduledTaskRunnerDepsProvider,
): void {
  if (depsProvidersByRuntime.has(runtime)) {
    logger.debug(
      { src: SERVICE_TYPE, agentId: runtime.agentId },
      "ScheduledTask runner deps provider already registered; keeping first-wins registration.",
    );
    return;
  }
  depsProvidersByRuntime.set(runtime, provider);
}

export function getScheduledTaskRunnerDeps(
  runtime: IAgentRuntime,
): ScheduledTaskRunnerDepsProvider | null {
  return depsProvidersByRuntime.get(runtime) ?? null;
}

// --- Runner boot hooks ------------------------------------------------------

/**
 * A hook invoked with the freshly constructed runner service the moment
 * `ScheduledTaskRunnerService.start` produces it. This is the structural
 * ordering primitive for boot-time seeding (#16309): the hook receives the
 * live instance, so seed work cannot observe a runtime where the runner does
 * not exist yet — no timing yield against the service registry is involved.
 */
export type ScheduledTaskRunnerBootHook = (
  service: ScheduledTaskRunnerService,
) => Promise<void> | void;

const bootHooksByRuntime = new WeakMap<
  IAgentRuntime,
  ScheduledTaskRunnerBootHook[]
>();
const startedServiceByRuntime = new WeakMap<
  IAgentRuntime,
  ScheduledTaskRunnerService
>();

function runBootHook(
  runtime: IAgentRuntime,
  service: ScheduledTaskRunnerService,
  hook: ScheduledTaskRunnerBootHook,
): Promise<void> {
  return Promise.resolve()
    .then(() => hook(service))
    .catch((error) => {
      // error-policy:J7 boot-hook failure (seed/tick bootstrap) is diagnostic:
      // the runner service itself started, tasks can still be scheduled at
      // runtime, and reportError makes the failed boot work observable.
      runtime.reportError("scheduling.runnerBootHook", error, {
        agentId: runtime.agentId,
      });
    });
}

/**
 * Register a hook to run when this runtime's runner service starts. If the
 * service has already started, the hook runs immediately against the live
 * instance. Hook failures are reported through `runtime.reportError` and
 * never fail service startup.
 */
export function registerScheduledTaskRunnerBootHook(
  runtime: IAgentRuntime,
  hook: ScheduledTaskRunnerBootHook,
): void {
  const started = startedServiceByRuntime.get(runtime);
  if (started) {
    void runBootHook(runtime, started, hook);
    return;
  }
  const hooks = bootHooksByRuntime.get(runtime) ?? [];
  hooks.push(hook);
  bootHooksByRuntime.set(runtime, hooks);
}

// --- Default deps provider (no-PA path) ------------------------------------

const ALL_PROFILES: ReadonlySet<TaskExecutionProfile> = new Set(
  TASK_EXECUTION_PROFILES,
);

const MOBILE_PROFILES: ReadonlySet<TaskExecutionProfile> =
  new Set<TaskExecutionProfile>(["foreground", "bg-light-30s", "notify-only"]);

/**
 * Lightweight host-capability predicate that reads `ELIZA_PLATFORM` instead of
 * importing `@elizaos/app-core` (which would pull app-core into the mobile
 * bundle). Mobile hosts (android/ios) advertise the restricted profile set;
 * everything else (Node desktop, tests) advertises all profiles. A consumer
 * that needs the precise BackgroundRunner / FGS probe injects its own
 * `hostCapabilities` via the deps provider.
 */
function platformHostCapabilities(): ReadonlySet<TaskExecutionProfile> {
  const platform = resolvePlatform() ?? "";
  if (platform === "android" || platform === "ios") return MOBILE_PROFILES;
  return ALL_PROFILES;
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

/**
 * Default dispatcher with no channel registry: channel-destination dispatches
 * whose channel key matches a live message connector go out through the
 * runtime's connector transport (`sendMessageToTarget`); everything else
 * routes through a local NOTIFICATION emit (when a notification service is
 * present) and reports delivered. The notification path remains the honest
 * "no connector wired" behavior — the in_app notification reaches the device
 * even on a stock mobile boot.
 */
function createDefaultScheduledTaskDispatcher(
  runtime: IAgentRuntime,
  store: ScheduledTaskStore,
): ScheduledTaskDispatcher {
  return {
    async dispatch(record): Promise<DispatchResult> {
      // `promptInstructions` is a model prompt, never user-facing copy: the
      // notification body must be the model's rendering of it. A model-free
      // runtime receives a neutral deterministic fallback; a present-but-failed
      // model call is a typed, retryable dispatch failure.
      const connectorTarget = resolveConnectorDispatchTarget(record);
      if (isConnectorDispatchIntent(record) && !connectorTarget) {
        return {
          ok: false,
          reason: "unknown_recipient",
          acceptance: "not_accepted",
          userActionable: true,
          message: `Channel "${record.channelKey}" has no valid connector target.`,
        };
      }
      if (
        connectorTarget &&
        !runtimeHasMessageConnector(runtime, connectorTarget.source)
      ) {
        return {
          ok: false,
          reason: "disconnected",
          acceptance: "not_accepted",
          userActionable: true,
          message: `Channel "${connectorTarget.source}" has no registered message connector.`,
        };
      }

      let body: string;
      try {
        const preparedMessage = connectorTarget
          ? (await store.get(record.taskId))?.metadata?.dispatchPreparedMessage
          : undefined;
        body =
          typeof preparedMessage === "string" &&
          preparedMessage.trim().length > 0
            ? preparedMessage
            : await renderScheduledDispatchMessage(runtime, record);
      } catch (error) {
        // error-policy:J1 boundary translation — dispatch outcomes are the
        // runner's typed contract; the failure also reaches RECENT_ERRORS and
        // owner escalation via reportError.
        runtime.reportError(
          "scheduling:scheduled-task:dispatch-render",
          error,
          {
            taskId: record.taskId,
            channelKey: record.channelKey,
          },
        );
        return renderFailureDispatchResult(error);
      }
      if (connectorTarget) {
        const current = await store.get(record.taskId);
        if (!current) {
          return {
            ok: false,
            reason: "transport_error",
            acceptance: "not_accepted",
            userActionable: false,
            message: "Scheduled task disappeared before connector dispatch.",
          };
        }
        const existingKey = current.metadata?.dispatchIdempotencyKey;
        const dispatchIdempotencyKey =
          typeof existingKey === "string" && existingKey.trim().length > 0
            ? existingKey.trim()
            : `${record.taskId}:${record.firedAtIso}`;
        current.metadata = {
          ...(current.metadata ?? {}),
          dispatchPreparedMessage: body,
          dispatchIdempotencyKey,
          dispatchAttempt: {
            status: "prepared",
            preparedAtIso: new Date().toISOString(),
            firedAtIso: record.firedAtIso,
          },
        };
        await store.upsert(current);
        if (record.metadata) {
          Object.assign(record.metadata, current.metadata);
        } else {
          record.metadata = current.metadata;
        }
      }
      // Channel-destination dispatch through a live message connector (e.g.
      // `output: { destination: "channel", target: "discord:user:<id>" }` on
      // a standalone runtime with plugin-discord). Falls through to the
      // notification surface when the path does not apply.
      const connectorResult = await dispatchViaMessageConnector(
        runtime,
        record,
        body,
      );
      if (connectorResult) return connectorResult;
      let title: string;
      try {
        title = await renderScheduledDispatchTitle(runtime, record, body);
      } catch (error) {
        runtime.reportError(
          "scheduling:scheduled-task:dispatch-render",
          error,
          { taskId: record.taskId, channelKey: record.channelKey },
        );
        return renderFailureDispatchResult(error);
      }
      const isUrgent = record.intensity === "urgent";
      const notifier = getNotifier(runtime);
      if (!notifier) {
        return {
          ok: false,
          reason: "disconnected",
          acceptance: "not_accepted",
          userActionable: true,
          message: "No notification service is registered for in-app delivery.",
        };
      }
      try {
        await notifier.notify({
          title,
          body,
          category: isUrgent ? "approval" : "reminder",
          priority: isUrgent ? "urgent" : "normal",
          source: "scheduling",
          groupKey: `scheduling:${record.taskId}`,
          deepLink: "/chat",
          data: {
            taskId: record.taskId,
            firedAtIso: record.firedAtIso,
            channelKey: record.channelKey,
          },
        });
      } catch (error) {
        // error-policy:J1 the notification transport boundary returns an
        // honest typed failure instead of recording a fabricated delivery.
        runtime.reportError(
          "scheduling:scheduled-task:notification-dispatch",
          error,
          { taskId: record.taskId, channelKey: record.channelKey },
        );
        return {
          ok: false,
          reason: "transport_error",
          acceptance: "unknown",
          userActionable: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        ok: true,
        messageId: `in_app:${record.taskId}:${record.firedAtIso}`,
      };
    },
  };
}

function makeMissingActivityBusView(
  runtime: IAgentRuntime,
): ActivitySignalBusView {
  let warned = false;
  return {
    hasSignalSince() {
      if (!warned) {
        warned = true;
        logger.warn(
          { src: SERVICE_TYPE, agentId: runtime.agentId },
          "ActivitySignalBus not registered; activity-dependent completion-checks report no-signal. A consumer can inject one via registerScheduledTaskRunnerDeps.",
        );
      }
      return false;
    },
  };
}

function makeMissingSubjectStoreView(runtime: IAgentRuntime): SubjectStoreView {
  let warned = false;
  return {
    wasUpdatedSince() {
      if (!warned) {
        warned = true;
        logger.warn(
          { src: SERVICE_TYPE, agentId: runtime.agentId },
          "SubjectStore not registered; subject_updated completion-checks report no-update. A consumer can inject one via registerScheduledTaskRunnerDeps.",
        );
      }
      return false;
    },
  };
}

const ALWAYS_ALLOW_GLOBAL_PAUSE: GlobalPauseView = {
  async current() {
    return { active: false };
  },
};

/**
 * The default (no-PA) deps provider. Uses scheduling-owned SQL persistence
 * when the runtime DB is present, then falls back to in-memory for isolated
 * tests/hosts without `@elizaos/plugin-sql`; the rest of the bundle is built-in
 * registries, warn-once activity/subject ports, permissive global-pause, empty
 * owner-facts, notification-only dispatch, and platform capability probing.
 */
function defaultRunnerDeps(
  runtime: IAgentRuntime,
  agentId: string,
): ScheduledTaskRunnerDepsBundle {
  const hasRuntimeDb = getRuntimeDb(runtime) !== null;
  const store = hasRuntimeDb
    ? createSchedulingSqlScheduledTaskStore({ runtime, agentId })
    : createInMemoryScheduledTaskStore();
  return {
    store,
    logStore: hasRuntimeDb
      ? createSchedulingSqlScheduledTaskLogStore({ runtime, agentId })
      : createInMemoryScheduledTaskLogStore(),
    dispatcher: createDefaultScheduledTaskDispatcher(runtime, store),
    ownerFacts: () => ({}) as OwnerFactsView,
    globalPause: ALWAYS_ALLOW_GLOBAL_PAUSE,
    activity: makeMissingActivityBusView(runtime),
    subjectStore: makeMissingSubjectStoreView(runtime),
    hostCapabilities: platformHostCapabilities,
  };
}

// --- Runner construction ----------------------------------------------------

export interface GetScheduledTaskRunnerOptions {
  agentId: string;
  now?: () => Date;
}

function buildRunner(
  runtime: IAgentRuntime,
  opts: GetScheduledTaskRunnerOptions,
): ScheduledTaskRunnerHandle {
  const provider = getScheduledTaskRunnerDeps(runtime);
  const deps = (provider ?? defaultRunnerDeps)(runtime, opts.agentId);

  const gates = deps.gates ?? createTaskGateRegistry();
  if (!deps.gates) registerBuiltInGates(gates);

  const completionChecks =
    deps.completionChecks ?? createCompletionCheckRegistry();
  if (!deps.completionChecks) {
    registerBuiltInCompletionChecks(completionChecks);
  }

  const ladders = deps.ladders ?? createEscalationLadderRegistry();
  if (!deps.ladders) registerDefaultEscalationLadders(ladders);

  let anchors = deps.anchors;
  if (!anchors) {
    anchors = createAnchorRegistry();
    registerFallbackAnchors(anchors);
  }

  const consolidation = deps.consolidation ?? createConsolidationRegistry();

  const codingAgentDispatcher = createCodingAgentScheduleDispatcher(runtime, {
    delegate: deps.dispatcher,
  });
  // Contributed-channel routing sits OUTSIDE the coding-agent wrap: a dispatch
  // whose channelKey was registered via the channel-dispatcher registry is the
  // contributor's deterministic recipe; everything else falls through to the
  // built-in coding-agent channel and then the host connector dispatcher.
  // Lookup is per-dispatch so registrations that land after this (cached)
  // runner was built are still honored.
  const dispatcher: ScheduledTaskDispatcher = {
    dispatch(record) {
      const contributed = getScheduledTaskChannelDispatcher(
        runtime,
        record.channelKey,
      );
      if (contributed) return contributed.dispatch(record);
      return codingAgentDispatcher.dispatch(record);
    },
  };
  const hostChannelKeys = deps.channelKeys;
  const channelKeys = hostChannelKeys
    ? () =>
        new Set([
          ...hostChannelKeys(),
          PR_SHEPHERD_DISPATCH_CHANNEL,
          ...listScheduledTaskChannelDispatcherKeys(runtime),
        ])
    : undefined;
  const hostChannelAvailable = deps.channelAvailable;
  const channelAvailable = hostChannelAvailable
    ? (channelKey: string) =>
        channelKey === PR_SHEPHERD_DISPATCH_CHANNEL ||
        getScheduledTaskChannelDispatcher(runtime, channelKey) !== null
          ? true
          : hostChannelAvailable(channelKey)
    : undefined;

  return createScheduledTaskRunner({
    agentId: opts.agentId,
    store: deps.store,
    logStore: deps.logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: deps.ownerFacts,
    globalPause: deps.globalPause,
    activity: deps.activity,
    subjectStore: deps.subjectStore,
    dispatcher,
    ...(deps.executionBoundary
      ? { executionBoundary: deps.executionBoundary }
      : {}),
    ...(channelKeys ? { channelKeys } : {}),
    ...(channelAvailable ? { channelAvailable } : {}),
    ...(deps.hostCapabilities
      ? { hostCapabilities: deps.hostCapabilities }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

const SYSTEM_CLOCK = (): Date => new Date();

interface RunnerCacheEntry {
  runner: ScheduledTaskRunnerHandle;
  /** Mutable clock the cached runner reads through on every `now()` call. */
  clock: { now: () => Date };
}

/**
 * Long-lived runner host. Builds the runner ONCE per `agentId` from the
 * injected deps provider and caches it. The runner construction work
 * (registry wiring, dispatcher binding) is stable across ticks, so the tick
 * reads the cached runner instead of rebuilding it every minute.
 *
 * Clock semantics: the cached runner never captures a caller's `now` closure
 * directly — it reads through a mutable clock ref that EVERY
 * {@link getRunner} call rebinds (to `opts.now` when provided, back to the
 * system clock otherwise). The previous design cached the FIRST override
 * closure forever, freezing the runner's clock at the boot tick's instant:
 * every later fire stamped `firedAt` with boot time, completion timeouts
 * became instantly due once uptime exceeded `followupAfterMinutes`, and
 * quiet-hours/weekend gates evaluated the boot instant forever.
 *
 * Single-threaded tick assumption: the clock is one shared ref per agent, so
 * the value in effect is whatever the MOST RECENT `getRunner` call bound.
 * The scheduler tick (the only production override caller) fetches the runner
 * at tick entry and PA ticks run sequentially per agent; a concurrent
 * no-override caller (REST routes, actions) rebinds to the system clock,
 * which in production is within seconds of any in-flight tick's `now`.
 * Callers must re-fetch the runner per operation rather than holding a
 * long-lived handle with a stale clock expectation.
 */
export class ScheduledTaskRunnerService extends Service {
  static override serviceType = SERVICE_TYPE;

  override capabilityDescription =
    "Long-lived ScheduledTask runner host. Builds the runner from the runtime-injected deps provider (or the built-in default deps) once per agent and caches it with a rebindable clock; the scheduler tick reads the cached runner instead of reconstructing it every minute.";

  private readonly runners = new Map<string, RunnerCacheEntry>();

  override async stop(): Promise<void> {
    this.runners.clear();
    const runtime = this.runtime;
    if (runtime && startedServiceByRuntime.get(runtime) === this) {
      startedServiceByRuntime.delete(runtime);
    }
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScheduledTaskRunnerService> {
    // This service is the boot barrier used by routes and seed packs. Copy
    // legacy rows before either can insert an idempotency-key collision.
    const runtimeDb = getRuntimeDb(runtime);
    if (runtimeDb) {
      await migrateSchedulingTables(
        await createDrizzleCarveOutDatabase(runtimeDb),
      );
    }
    logger.debug(
      { src: SERVICE_TYPE, agentId: runtime.agentId },
      "ScheduledTaskRunnerService started",
    );
    const service = new ScheduledTaskRunnerService(runtime);
    // Release boot hooks (default-pack seeding, fallback tick bootstrap) with
    // the live instance: this is what guarantees seed work runs strictly after
    // the runner exists, independent of service-registry timing (#16309).
    startedServiceByRuntime.set(runtime, service);
    const hooks = bootHooksByRuntime.get(runtime) ?? [];
    bootHooksByRuntime.delete(runtime);
    for (const hook of hooks) {
      void runBootHook(runtime, service, hook);
    }
    return service;
  }

  getRunner(opts: GetScheduledTaskRunnerOptions): ScheduledTaskRunnerHandle {
    let entry = this.runners.get(opts.agentId);
    if (!entry) {
      const runtime = this.runtime;
      if (!runtime) {
        throw new Error(
          "ScheduledTaskRunnerService: runtime is not bound; was the service started?",
        );
      }
      const clock = { now: SYSTEM_CLOCK };
      // The runner captures the REF, not the caller's closure — rebinding
      // `clock.now` below retargets the cached runner's clock per call.
      const runner = buildRunner(runtime, {
        agentId: opts.agentId,
        now: () => clock.now(),
      });
      entry = { runner, clock };
      this.runners.set(opts.agentId, entry);
    }
    entry.clock.now = opts.now ?? SYSTEM_CLOCK;
    return entry.runner;
  }
}

/**
 * Module-level accessor. Resolves the service via the runtime's service
 * registry and returns its cached runner. Throws when the service is not
 * registered — that is a plugin-wiring bug, not a runtime fallback case.
 */
export function getScheduledTaskRunner(
  runtime: IAgentRuntime,
  opts: GetScheduledTaskRunnerOptions,
): ScheduledTaskRunnerHandle {
  const service = runtime.getService(SERVICE_TYPE) as
    | ScheduledTaskRunnerService
    | null
    | undefined;
  if (!service) {
    throw new ElizaError(
      `[${SERVICE_TYPE}] ScheduledTaskRunnerService is not registered on this runtime. Add @elizaos/plugin-scheduling to the agent's plugin list.`,
      {
        code: "SCHEDULED_TASK_RUNNER_UNAVAILABLE",
        context: { serviceType: SERVICE_TYPE, agentId: opts.agentId },
      },
    );
  }
  return service.getRunner(opts);
}
