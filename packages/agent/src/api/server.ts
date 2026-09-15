/**
 * REST API server for the Eliza Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Default port: 2138. In dev mode, the Vite UI
 * dev server proxies /api and /ws here (see eliza/packages/app-core/scripts/dev-ui.mjs).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { registerInProcessApi } from "./in-process-api.ts";

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

function isBrowserCompanionOwnerMutation(
  method: string,
  pathname: string,
): boolean {
  return (
    method === "POST" &&
    (pathname === "/api/browser-bridge/companions/pair" ||
      /^\/api\/browser-bridge\/companions\/[^/]+\/(?:revoke|reset-revocation)$/.test(
        pathname,
      ))
  );
}

function hasBrowserCompanionOwnerSessionCookie(
  req: http.IncomingMessage,
): boolean {
  const cookie =
    typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  return /(?:^|;\s*)eliza_session=[^;]+/.test(cookie);
}

function hasBrowserCompanionCsrfHeader(req: http.IncomingMessage): boolean {
  const csrf = req.headers["x-eliza-csrf"];
  return typeof csrf === "string" && csrf.trim().length > 0;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/**
 * Restore's request-body cap IS the v1 restorable ceiling: anything retained
 * above it can never be restored here (#17172). Shared with the retain side so
 * the two cannot drift.
 */
const MAX_BACKUP_BODY_BYTES = MAX_RESTORABLE_AGENT_BACKUP_BYTES;
const BACKUP_BODY_TOO_LARGE = "Agent backup request body is too large";

import path from "node:path";
import {
  type AgentRuntime,
  ElizaError,
  EventType,
  type IAgentRuntime,
  logger,
  NotificationService,
  readJsonBody as parseJsonBody,
  type ReadJsonBodyOptions,
  type Route,
  readRequestBody,
  resolveOwnerEntityIdOrDefault,
  ServiceType,
  sendJson,
  sendJsonError,
  tryHandleTrajectoryReadRoutes,
  writeJsonError,
  writeJsonResponse,
} from "@elizaos/core";
import type {
  AppManagerLike,
  AppsRouteActorRole,
  FavoriteAppsStore,
} from "@elizaos/plugin-app-manager";
import { formatError, readAliasedEnv } from "@elizaos/shared";
import { MAX_RESTORABLE_AGENT_BACKUP_BYTES } from "@elizaos/shared/agent-backup-limits";
import {
  getStylePresets,
  normalizeCharacterLanguage,
} from "@elizaos/shared/character-presets";
import {
  isMobilePlatform,
  resolveApiBindHost,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
} from "@elizaos/shared/runtime-env";
import { parseClampedInteger } from "@elizaos/shared/utils/number-parsing";
import { type WebSocket, WebSocketServer } from "ws";
import { installPlugin as installPluginDirect } from "../services/plugin-installer.ts";
import {
  AgentBackupClientDisconnectedError,
  writeAgentBackupJsonResponse,
} from "./backup-json-response.ts";
import { handleAgentBackupV2SnapshotRequest } from "./backup-v2-stream-response.ts";
import { handleStandaloneCloudPairRoute } from "./cloud-pair-route.ts";
import { resolveConnectorHealthIntervalMs } from "./connector-health.ts";
import { handlePluginDirectoryRoutes } from "./plugin-directory-routes.ts";

// `@elizaos/plugin-browser` and `@elizaos/plugin-x402` load lazily: X402 only
// when runtime routes need validation, browser on the first browser route hit,
// so neither gates the API bind. A module-scope top-level await here would load
// both plugins (and their transitive native deps) whenever anything imported
// `@elizaos/agent`, which blocks container boot in cloud sandboxes.
type BrowserPluginModule = typeof import("@elizaos/plugin-browser");

let browserPluginModule: BrowserPluginModule | null = null;
let x402PluginModule: X402PluginModule | null = null;
let browserPluginModulePromise: Promise<BrowserPluginModule> | null = null;
let x402PluginModulePromise: Promise<X402PluginModule | null> | null = null;

// Vite 7's import-analysis eagerly resolves string-literal dynamic imports even
// when a `@vite-ignore` comment is present, throwing "Failed to resolve entry"
// for the optional plugins below whose dist isn't built in the unit Plugin
// Tests lane (any spec that transitively transforms this file then fails to
// collect). Funnel optional plugin loads through a variable specifier so the
// analyzer leaves them as pure runtime imports — the host resolves them from
// node_modules on demand. Mirrors the variable-specifier bundle loader further
// down this file.
function importOptionalPlugin<T = unknown>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

async function getBrowserPlugin(): Promise<BrowserPluginModule> {
  if (browserPluginModule) return browserPluginModule;
  browserPluginModulePromise ??= importOptionalPlugin<BrowserPluginModule>(
    "@elizaos/plugin-browser",
  ).then((browser) => {
    browserPluginModule = browser;
    return browser;
  });
  return browserPluginModulePromise;
}

/** Bind the live runtime service, not a separately imported plugin module copy. */
const nativeReaderWiredRuntimes = new WeakSet<AgentRuntime>();
function wireNativeBrowserPageReader(runtime: AgentRuntime | null): void {
  if (!runtime || nativeReaderWiredRuntimes.has(runtime)) return;
  nativeReaderWiredRuntimes.add(runtime);
  // Context activation can register the plugin long after API startup. Bind
  // each actual service instance when it starts, without eagerly loading it.
  const bindReader = () => {
    const browser = runtime.getService("browser") as InstanceType<
      BrowserPluginModule["BrowserService"]
    > | null;
    if (!browser || typeof browser.setNativeClientTransport !== "function")
      return;
    browser.setNativeClientTransport({
      navigate: async (clientId, url) => {
        const [
          { getViewsBroadcastWsToClientId },
          { createShellNavigateViewWsFrame },
        ] = await Promise.all([
          import("./views-routes.ts"),
          import("@elizaos/shared"),
        ]);
        const send = getViewsBroadcastWsToClientId();
        if (
          !send ||
          send(
            clientId,
            createShellNavigateViewWsFrame({
              viewId: "browser",
              viewType: "gui",
              viewLabel: "Browser",
              source: "agent",
              viewPath: url
                ? `/browser?browse=${encodeURIComponent(url)}`
                : "/browser",
            }),
          ) <= 0
        )
          throw new Error(
            "The requesting native Browser client is not connected.",
          );
      },
      readPage: async (clientId, selector) => {
        const [
          { dispatchViewInteract, getViewsBroadcastWsToClientId },
          { getView },
        ] = await Promise.all([
          import("./views-routes.ts"),
          import("./views-registry.ts"),
        ]);
        const entry = getView("browser", { viewType: "gui" });
        const sendToClient = getViewsBroadcastWsToClientId();
        if (!entry || !sendToClient)
          throw new Error(
            "Native Browser interaction transport is unavailable.",
          );
        const reply = await dispatchViewInteract(
          entry,
          "browser",
          "get-text",
          {
            nativeOnly: true,
            ...(selector === undefined ? {} : { selector }),
          },
          {
            clientId,
            broadcastWsToClientId: sendToClient,
            runtime,
          },
        );
        if (!reply.success)
          throw new Error(reply.error ?? "Native Browser page read failed.");
        return reply.result;
      },
    });
  };
  runtime.registerEvent(EventType.SERVICE_STARTED, async ({ serviceType }) => {
    if (serviceType === "browser") bindReader();
  });
  bindReader();
}

// On mobile the agent bundle aliases `@elizaos/plugin-browser` to a null-stub
// (scripts/mobile-stubs/null-plugin.cjs): the module imports fine but its
// workspace functions are absent, so calling one throws an uncaught TypeError
// that surfaces as a 500 (and a raw "X is not a function" in the /browser view).
// The browser workspace is desktop-only, so resolve the plugin only when it
// really implements the requested method and let callers serve an empty payload
// otherwise.
async function resolveDesktopBrowserPlugin(
  method: keyof BrowserPluginModule,
): Promise<BrowserPluginModule | null> {
  if (isMobilePlatform()) return null;
  const browserPlugin = await getBrowserPlugin();
  if ((browserPlugin as { __mobileStub?: boolean }).__mobileStub) return null;
  return typeof browserPlugin[method] === "function" ? browserPlugin : null;
}

function getBrowserWorkspacePlugin(): Promise<BrowserPluginModule | null> {
  return resolveDesktopBrowserPlugin("getBrowserWorkspaceSnapshot");
}

function getBrowserBridgePlugin(): Promise<BrowserPluginModule | null> {
  return resolveDesktopBrowserPlugin("getBrowserBridgeCompanionPackageStatus");
}

const EMPTY_BROWSER_BRIDGE_PACKAGE_STATUS = {
  extensionPath: null,
  chromeBuildPath: null,
  chromePackagePath: null,
  firefoxBuildPath: null,
  firefoxPackagePath: null,
  safariWebExtensionPath: null,
  safariAppPath: null,
  safariPackagePath: null,
  releaseManifest: null,
} satisfies ReturnType<
  BrowserPluginModule["getBrowserBridgeCompanionPackageStatus"]
>;

async function getX402Plugin(): Promise<X402PluginModule | null> {
  if (x402PluginModule) return x402PluginModule;
  // x402 is desktop/cloud-only; on mobile it is not in the agent bundle, so the
  // "optional" dynamic import REJECTS (no node_modules). Treat a missing module
  // as "no x402" instead of letting the rejection crash API-server startup —
  // `importOptionalPlugin` is named optional but does not itself swallow.
  x402PluginModulePromise ??= importOptionalPlugin<X402PluginModule>(
    "@elizaos/plugin-x402",
  )
    .then((x402) => {
      x402PluginModule = x402;
      return x402;
    })
    .catch(() => null);
  return x402PluginModulePromise;
}

// Package specifier per optional-plugin key. Kept alongside the import table so
// the unavailable-plugin fallback can key its "is this the plugin package itself
// that's absent (benign) vs a broken transitive import (drift)" decision on the
// real specifier rather than the short key. See optional-plugin-fallback.ts.
const optionalPluginSpecifiers = {
  capacitor: "@elizaos/plugin-capacitor-bridge",
  computerUse: "@elizaos/plugin-computeruse",
  cloud: "@elizaos/plugin-elizacloud",
  imessage: "@elizaos/plugin-imessage",
  mcp: "@elizaos/plugin-mcp",
  whatsapp: "@elizaos/plugin-whatsapp",
  workflow: "@elizaos/plugin-workflow",
} as const;

const optionalPluginImports = {
  capacitor: () => importOptionalPlugin(optionalPluginSpecifiers.capacitor),
  computerUse: () => importOptionalPlugin(optionalPluginSpecifiers.computerUse),
  cloud: () => importOptionalPlugin(optionalPluginSpecifiers.cloud),
  imessage: () => importOptionalPlugin(optionalPluginSpecifiers.imessage),
  mcp: () => importOptionalPlugin(optionalPluginSpecifiers.mcp),
  whatsapp: () => importOptionalPlugin(optionalPluginSpecifiers.whatsapp),
  workflow: () => importOptionalPlugin(optionalPluginSpecifiers.workflow),
};

type LocalInferenceServerApi = LocalInferenceRouteApi &
  LocalInferenceVoiceRouteApi;

/**
 * Combine the route + voice surfaces from the single subpath-owning loader
 * (`./local-inference-server-api.ts`). The loaders there own the stub/subpath
 * knowledge and each clear their memo on reject, so a cold-boot import failure
 * surfaces here and retries on the next request — the same semantics as before,
 * without this file knowing the plugin's stub layout.
 */
async function getLocalInferenceServerApi(): Promise<LocalInferenceServerApi> {
  const [routeApi, voiceApi] = await Promise.all([
    loadLocalInferenceRouteApi(),
    loadLocalInferenceVoiceRouteApi(),
  ]);
  return { ...routeApi, ...voiceApi };
}

async function getOptionalPluginApi<T>(
  key: keyof typeof optionalPluginImports,
): Promise<T> {
  try {
    return (await optionalPluginImports[key]()) as T;
  } catch (err) {
    // The plugin is optional and (on mobile) many desktop/cloud plugins — cloud,
    // whatsapp, wallet-adjacent, mcp, streaming, … — are excluded, so their
    // dynamic import REJECTS with a module-resolution error. Without this catch
    // that rejection propagates to the top-level request handler as a 500 on
    // EVERY renderer poll of the plugin's routes. We fall back to a no-op API so
    // route-dispatch blocks (`if (await handleX(...)) return;`) fall through to
    // the normal 404 instead of erroring.
    //
    // resolveOptionalPluginImportFailure distinguishes the EXPECTED
    // module-absent case (quiet debug + fallthrough) from a present-but-broken
    // plugin (a package that resolved but threw at init, or whose accessed
    // export was renamed/removed). The latter is a drift regression the old
    // silent Proxy hid — it now warns so a broken/renamed handler is observable
    // instead of silently 404ing forever. See optional-plugin-fallback.ts.
    return resolveOptionalPluginImportFailure<T>(
      String(key),
      err,
      optionalPluginSpecifiers[key],
    );
  }
}
type BrowserBridgeKind = BrowserPluginModule["BROWSER_BRIDGE_KINDS"][number];
type BrowserBridgePackagePathTarget =
  BrowserPluginModule["BROWSER_BRIDGE_PACKAGE_PATH_TARGETS"][number];
type BrowserWorkspaceCommand = Parameters<
  BrowserPluginModule["executeBrowserWorkspaceCommand"]
>[0];
type BrowserWorkspaceTabKind = NonNullable<
  Parameters<BrowserPluginModule["openBrowserWorkspaceTab"]>[0]["kind"]
>;

let agentSkillsApiPromise:
  | Promise<typeof import("@elizaos/plugin-agent-skills")>
  | undefined;
function getAgentSkillsApi(): Promise<
  typeof import("@elizaos/plugin-agent-skills")
> {
  agentSkillsApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-agent-skills"
  );
  return agentSkillsApiPromise;
}

let appManagerApiPromise:
  | Promise<typeof import("@elizaos/plugin-app-manager")>
  | undefined;
function getAppManagerApi(): Promise<
  typeof import("@elizaos/plugin-app-manager")
> {
  appManagerApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-app-manager"
  );
  return appManagerApiPromise;
}

let walletApiPromise:
  | Promise<typeof import("@elizaos/plugin-wallet")>
  | undefined;
function getWalletApi(): Promise<typeof import("@elizaos/plugin-wallet")> {
  walletApiPromise ??= importOptionalPlugin<
    typeof import("@elizaos/plugin-wallet")
  >("@elizaos/plugin-wallet").catch((err) => {
    // plugin-wallet is desktop/cloud-only; on mobile it is not in the bundle so
    // this import REJECTS. Cache a no-op fallback so /api/wallet/* falls through
    // to 404 instead of 500ing on every renderer poll. Desktop imports succeed,
    // so this branch never runs there. resolveOptionalPluginImportFailure keeps
    // the benign module-absent case quiet while surfacing a present-but-broken
    // plugin-wallet load (drift) as an observable warning.
    return resolveOptionalPluginImportFailure<
      typeof import("@elizaos/plugin-wallet")
    >("@elizaos/plugin-wallet", err, "@elizaos/plugin-wallet");
  });
  return walletApiPromise;
}

let coreWalletApiPromise: Promise<typeof import("./wallet.ts")> | undefined;
function getCoreWalletApi(): Promise<typeof import("./wallet.ts")> {
  coreWalletApiPromise ??= import("./wallet.ts");
  return coreWalletApiPromise;
}

let pluginRegistryApiPromise:
  | Promise<typeof import("@elizaos/plugin-registry/api/plugin-routes")>
  | undefined;

function getPluginRegistryApi(): Promise<
  typeof import("@elizaos/plugin-registry/api/plugin-routes")
> {
  pluginRegistryApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-registry/api/plugin-routes"
  );
  return pluginRegistryApiPromise;
}

import { walletDiagnosticDescriptor } from "@elizaos/plugin-wallet/diagnostic";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.ts";
import {
  createDevCloudConfigAuthorityView,
  materializeDevCloudConfigAuthorityView,
  mergeDevCloudConfigAuthorityMutation,
} from "../config/dev-cloud-env-authority.ts";
import { isCloudWalletEnabled } from "../config/feature-flags.ts";
import { resolveModelsCacheDir, resolveStateDir } from "../config/paths.ts";
import { CharacterSchema } from "../config/zod-schema.ts";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import {
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service.ts";
import {
  type AgentHttpRequestAuthorization,
  getAgentHostBridge,
} from "../runtime/host-bridge.ts";
import {
  resolvePreferredProviderId,
  resolvePrimaryModel,
} from "../runtime/model-resolution.ts";
import {
  type ClassifyContext,
  createColdStrategy,
  createHotStrategy,
  DefaultRuntimeOperationManager,
  defaultClassifier,
  getDefaultHealthChecker,
  getDefaultRepository,
  type RuntimeOperationManager,
} from "../runtime/operations/index.ts";
import { classifyRegistryPluginRelease } from "../runtime/release-plugin-policy.ts";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "../security/audit-log.ts";
import {
  type AgentBackupStateData,
  createAgentSnapshot,
  createLocalAgentBackup,
  listLocalAgentBackups,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
} from "../services/agent-backup.ts";
import {
  AgentExportError,
  estimateExportSize,
  exportAgent,
  importAgent,
} from "../services/agent-export.ts";
import { registerClientChatSendHandler } from "../services/client-chat-sender.ts";
import { createConfigPluginManager } from "../services/config-plugin-manager.ts";
import type { ConnectorSetupServiceInstance } from "../services/connector-setup-service.ts";
import {
  type CoreManagerLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.ts";
import {
  PROACTIVE_INTERACTION_SOURCE,
  type ProactiveOffer,
  registerProactiveInteractionDecider,
} from "../services/proactive-interaction-decider.ts";
import { ProactiveInteractionGate } from "../services/proactive-interaction-gate.ts";
import {
  executeTriggerTask,
  getTriggerHealthSnapshot,
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "../triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../triggers/scheduling.ts";
import { resolveAbsentPluginRouteStub } from "./absent-plugin-route-stubs.ts";
import { detectRuntimeModel, resolveProviderFromModel } from "./agent-model.ts";
import { persistConfigEnv } from "./config-env.ts";
import { restoreConversationsFromDb as restoreConversationsFromDbImpl } from "./conversation-restore.ts";
import { wireCoordinatorBridgesWhenReady } from "./coordinator-wiring.ts";
import { computeCanRespond } from "./health-routes.ts";
import {
  type LocalInferenceRouteApi,
  type LocalInferenceVoiceRouteApi,
  loadLocalInferenceRouteApi,
  loadLocalInferenceVoiceRouteApi,
} from "./local-inference-server-api.ts";
import { resolveOptionalPluginImportFailure } from "./optional-plugin-fallback.ts";
import {
  buildPluginDiagnosticEntry,
  resolveWalletDiagnosticStatus,
} from "./plugin-diagnostic.ts";
import { maybeCapRequestStorm } from "./request-storm-cap.ts";
import { handleRuntimeManagementRoutes } from "./runtime-management-routes.ts";
import {
  handleRuntimeModePreDispatch,
  handleRuntimeModeRemoteForward,
} from "./runtime-mode/pre-dispatch.ts";
import { handleRuntimeSwitchRoutes } from "./runtime-switch-routes.ts";
import {
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  hasBlockedObjectKeyDeep,
  hasPersistedFirstRunState,
  isUuidLike,
  patchTouchesProviderSelection,
} from "./server-helpers.ts";
import { routeAutonomyTextToUser as routeProactiveText } from "./server-helpers-swarm.ts";
import {
  createConnectorHealthMonitor,
  handleAccountsRoutes,
  handleAgentAdminRoutes,
  handleAgentLifecycleRoutes,
  handleAgentStatusRoutes,
  handleAgentTransferRoutes,
  handleAppPackageRoutes,
  handleAuthRoutes,
  handleAvatarRoutes,
  handleBackgroundTasksRoute,
  handleBugReportRoutes,
  handleCharacterRoutes,
  handleCloudAndCoreRouteGroup,
  handleCommandsRoutes,
  handleConfigRoutes,
  handleConnectorRoutes,
  handleConversationRouteGroup,
  handleDatabaseRouteGroup,
  handleDiagnosticsRoutes,
  handleFirstRunRoutes,
  handleHealthRoutes,
  handleInboxAndCloudRelayRouteGroup,
  handleInteractionsRoutes,
  handleLifeOpsRuntimePluginRoute,
  handleMemoryRoutes,
  handleMiscRoutes,
  handleMobileOptionalRoutes,
  handleModelConfigRoutes,
  handleModelsRoutes,
  handlePermissionRoutes,
  handlePermissionsExtraRoutes,
  handleProjectRoutes,
  handleProviderSwitchRoutes,
  handleRegistryRoutes,
  handleRelationshipsRoutes,
  handleRemoteCapabilityRoutes,
  handleSandboxRouteGroup,
  handleSubscriptionRoutes,
  handleUpdateRoutes,
  handleViewsRoutes,
  handleWorkbenchRoutes,
  isPublicRuntimePluginRoute,
  registerBuiltinViews,
  tryHandleHonoRuntimeRoute,
  tryHandleLifeOpsInboxFallbackLazy,
  tryHandleRuntimePluginRoute,
} from "./server-lazy-routes.ts";
import {
  EVM_PLUGIN_PACKAGE,
  resolveWalletAutomationMode as resolveAgentAutomationModeFromConfig,
  resolveWalletCapabilityStatus,
} from "./wallet-capability.ts";
import {
  applyWalletRpcConfigUpdate,
  getStoredWalletRpcSelections,
  resolveWalletNetworkMode,
  resolveWalletRpcReadiness,
} from "./wallet-rpc.ts";
import {
  DEFAULT_REPLAY_LIMIT,
  parseEventCursor,
  selectReplayEvents,
} from "./ws-event-replay.ts";
import { runtimeRoutesNeedX402Validation } from "./x402-route-validation.ts";

export {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
  stripAssistantStageDirections,
} from "./chat-text-helpers.ts";

export {
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  findOwnPackageRoot,
  getErrorMessage,
  isUuidLike,
  persistConversationRoomTitle,
} from "./server-helpers.ts";

import {
  getInventoryProviderOptions,
  getModelOptions,
  getOrFetchAllProviders,
  getOrFetchProvider,
  paramKeyToCategory,
  providerCachePath,
  readProviderCache,
} from "./model-provider-helpers.ts";
import {
  AGENT_EVENT_ALLOWED_STREAMS,
  aggregateSecrets,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  getReleaseBundledPluginIds,
  isBlockedEnvKey,
  maskValue,
  type PluginEntry,
} from "./plugin-discovery-helpers.ts";

const _nodeRequire = createRequire(import.meta.url);

// Re-export for downstream consumers (e.g. @elizaos/app-core)
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./plugin-discovery-helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function getAgentEventSvc(
  runtime: AgentRuntime | null,
): AgentEventServiceLike | null {
  return getAgentEventService(runtime);
}

function requirePluginManager(runtime: AgentRuntime | null): PluginManagerLike {
  const service = runtime?.getService("plugin_manager");
  if (!isPluginManagerLike(service)) {
    throw new Error("Plugin manager service not found");
  }
  return wrapPluginManagerWithLocalFallback(service);
}

/**
 * The runtime plugin manager's registry client only fetches from GitHub and
 * scans a `plugins/` dir for `elizaos.plugin.json`. Workspace-vendored plugins
 * (under `packages/plugin-*`) are invisible to it. Wrap `installPlugin` so that
 * when it returns "not found in the registry" we retry using our own
 * registry-client (which discovers workspace packages and node_modules symlinks).
 */
function wrapPluginManagerWithLocalFallback(
  pm: PluginManagerLike,
): PluginManagerLike {
  const originalInstall = pm.installPlugin.bind(pm);
  const wrapped: PluginManagerLike = Object.create(pm);

  wrapped.installPlugin = async (pluginName, onProgress) => {
    const result = await originalInstall(pluginName, onProgress);
    if (
      result.success ||
      !result.error?.includes("not found in the registry")
    ) {
      return result;
    }

    // Upstream registry missed it — check Eliza's own local discovery.
    const { getPluginInfo } = await import("../services/registry-client.ts");
    const localInfo = await getPluginInfo(pluginName);
    if (!localInfo?.localPath) {
      return result;
    }

    // The plugin is a workspace package — just return success pointing at it.
    // The runtime already resolves it via NODE_PATH / bun workspace links so
    // there is nothing to download; the caller only needs to enable it in
    // config and restart.
    return {
      success: true,
      pluginName: localInfo.name,
      version:
        localInfo.npm.v2Version ?? localInfo.npm.v1Version ?? "workspace",
      installPath: localInfo.localPath,
      requiresRestart: true,
    };
  };

  return wrapped;
}

function getPluginManagerForState(state: ServerState): PluginManagerLike {
  const service = state.runtime?.getService("plugin_manager");
  if (isPluginManagerLike(service)) {
    return service;
  }
  return createConfigPluginManager(() => state.config);
}

function requireCoreManager(runtime: AgentRuntime | null): CoreManagerLike {
  const service = runtime?.getService("core_manager");
  if (!isCoreManagerLike(service)) {
    throw new Error("Core manager service not found");
  }
  return service;
}

const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

function readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

function _persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const filePath = path.join(dir, DELETED_CONVERSATIONS_FILENAME);
  const tmpFilePath = `${filePath}.${process.pid}.tmp`;
  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmpFilePath, filePath);
}

export type {
  AgentStartupDiagnostics,
  ConversationMeta,
  LogEntry,
  ServerState,
  ShareIngestItem,
  SkillEntry,
  StreamEventEnvelope,
  StreamEventType,
} from "./server-types.ts";

import type { AwarenessRegistryLike } from "./agent-status-routes.ts";
import { createApiEventHub } from "./event-hub.ts";
import { listenHttpServer } from "./http-listener.ts";
import { createRouteKernel } from "./route-kernel.ts";
import { quiesceRuntimeBeforeReplacement } from "./runtime-replacement-ownership.ts";
import { createServerResources } from "./server-resources.ts";
import { createServerState } from "./server-state.ts";
import type {
  AgentStartupDiagnostics,
  LogEntry,
  ServerState,
} from "./server-types.ts";
import type { X402PluginModule } from "./x402-contract.ts";

export {
  fetchWithTimeoutGuard,
  streamResponseBodyWithByteLimit,
} from "./server-helpers-fetch.ts";

/**
 * Read and parse a JSON request body with size limits and error handling.
 * Returns null (and sends a 4xx response) if reading or parsing fails.
 */
async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ReadJsonBodyOptions = {},
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: MAX_BODY_BYTES,
    ...options,
  });
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  readRequestBody(req, { maxBytes: MAX_BODY_BYTES }).then(
    (value) => value ?? "",
  );

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentBackupStateData(value: unknown): value is AgentBackupStateData {
  if (!isJsonRecord(value)) return false;
  return (
    Array.isArray(value.memories) &&
    isJsonRecord(value.config) &&
    isJsonRecord(value.workspaceFiles) &&
    isJsonRecord(value.manifest)
  );
}

async function readBackupJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown | null> {
  try {
    const raw = await readRequestBody(req, {
      maxBytes: MAX_BACKUP_BODY_BYTES,
      tooLargeMessage: BACKUP_BODY_TOO_LARGE,
    });
    if (!raw) {
      error(res, "Request body is required", 400);
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    const tooLarge = formatError(err) === BACKUP_BODY_TOO_LARGE;
    error(
      res,
      tooLarge ? BACKUP_BODY_TOO_LARGE : "Invalid backup request body",
      tooLarge ? 413 : 400,
    );
    return null;
  }
}

let activeTerminalRunCount = 0;
const terminalRunIdReservations = new Map<string, number>();
const TERMINAL_RUN_ID_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RUN_ID_RESERVATIONS = 65_536;
const TERMINAL_RUN_ID_SWEEP_INTERVAL_MS = 60_000;
let lastTerminalRunIdSweepAt = 0;

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  sendJsonError(res, message, status);
}

function parseBrowserBridgeKind(
  browserPlugin: BrowserPluginModule,
  value: string | undefined,
): BrowserBridgeKind | null {
  if (!value) return null;
  return (browserPlugin.BROWSER_BRIDGE_KINDS as readonly string[]).includes(
    value,
  )
    ? (value as BrowserBridgeKind)
    : null;
}

function parseBrowserBridgePackageTarget(
  browserPlugin: BrowserPluginModule,
  value: unknown,
): BrowserBridgePackagePathTarget | null {
  return typeof value === "string" &&
    (
      browserPlugin.BROWSER_BRIDGE_PACKAGE_PATH_TARGETS as readonly string[]
    ).includes(value)
    ? (value as BrowserBridgePackagePathTarget)
    : null;
}

async function handleBuiltinOptionalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  runtimeAgentId?: string | null,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/wallet/steward-status") {
    const { getWalletAddresses } = await getCoreWalletApi();
    const addresses = getWalletAddresses(runtimeAgentId);
    json(res, {
      configured: false,
      available: false,
      connected: false,
      error: "Steward wallet service is not loaded.",
      walletAddresses: {
        evm: addresses.evmAddress ?? null,
        solana: addresses.solanaAddress ?? null,
      },
      evmAddress: addresses.evmAddress ?? undefined,
      vaultHealth: "degraded",
    });
    return true;
  }

  // Pure-fabrication "capability unavailable" stubs are declared once in the
  // absent-plugin route stub registry (see absent-plugin-route-stubs.ts /
  // arch-audit #12089 item 12). Anything that reads live runtime state, such as
  // wallet addresses, is handled above and is intentionally NOT in the registry,
  // because those responses are not fabrications.
  const absentPluginStub = resolveAbsentPluginRouteStub(method, pathname);
  if (absentPluginStub) {
    // POST stubs still drain the request body so the socket is not left with a
    // pending payload (matches the pre-registry behavior for activity-signals).
    if (method === "POST") {
      await readBody(req).catch(() => undefined);
    }
    json(
      res,
      absentPluginStub.buildBody(req),
      absentPluginStub.statusCode ?? 200,
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/browser-bridge/packages") {
    const browserPlugin = await getBrowserBridgePlugin();
    json(res, {
      status: browserPlugin
        ? browserPlugin.getBrowserBridgeCompanionPackageStatus()
        : EMPTY_BROWSER_BRIDGE_PACKAGE_STATUS,
    });
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/browser-bridge/packages/open-path"
  ) {
    const body =
      (await readJsonBody<{ target?: unknown; revealOnly?: unknown }>(
        req,
        res,
      )) ?? null;
    if (!body) return true;
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const target = parseBrowserBridgePackageTarget(browserPlugin, body.target);
    if (!target) {
      error(res, "Invalid browser bridge package target", 400);
      return true;
    }
    json(
      res,
      await browserPlugin.openBrowserBridgeCompanionPackagePath(target, {
        revealOnly: body.revealOnly === true,
      }),
    );
    return true;
  }

  const packageBuildMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/build$/,
  );
  if (method === "POST" && packageBuildMatch) {
    const decodedBrowser = decodePathComponent(
      packageBuildMatch[1],
      res,
      "browser bridge package browser",
    );
    if (decodedBrowser === null) return true;
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const browser = parseBrowserBridgeKind(browserPlugin, decodedBrowser);
    if (!browser) {
      error(res, "Invalid browser bridge package browser", 400);
      return true;
    }
    json(res, {
      status: await browserPlugin.buildBrowserBridgeCompanionPackage(browser),
    });
    return true;
  }

  const packageManagerMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/open-manager$/,
  );
  if (method === "POST" && packageManagerMatch) {
    const decodedBrowser = decodePathComponent(
      packageManagerMatch[1],
      res,
      "browser bridge package browser",
    );
    if (decodedBrowser === null) return true;
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const browser = parseBrowserBridgeKind(browserPlugin, decodedBrowser);
    if (!browser) {
      error(res, "Invalid browser bridge package browser", 400);
      return true;
    }
    json(res, await browserPlugin.openBrowserBridgeCompanionManager(browser));
    return true;
  }

  if (pathname === "/api/browser-workspace" && method === "GET") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      json(res, { mode: "web", tabs: [] });
      return true;
    }
    json(res, await browserPlugin.getBrowserWorkspaceSnapshot());
    return true;
  }

  if (pathname === "/api/browser-workspace/command" && method === "POST") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    const body =
      (await readJsonBody<BrowserWorkspaceCommand>(req, res)) ?? null;
    if (!body?.subaction) {
      error(res, "subaction is required", 400);
      return true;
    }
    if (!browserPlugin) {
      error(res, "Browser workspace is not available on this platform", 503);
      return true;
    }
    json(res, await browserPlugin.executeBrowserWorkspaceCommand(body));
    return true;
  }

  if (pathname === "/api/browser-workspace/tabs" && method === "GET") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      json(res, { tabs: [] });
      return true;
    }
    json(res, { tabs: await browserPlugin.listBrowserWorkspaceTabs() });
    return true;
  }

  if (pathname === "/api/browser-workspace/tabs" && method === "POST") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      error(res, "Browser workspace is not available on this platform", 503);
      return true;
    }
    const body =
      (await readJsonBody<{
        url?: string;
        title?: string;
        show?: boolean;
        partition?: string;
        kind?: BrowserWorkspaceTabKind;
      }>(req, res)) ?? {};
    json(res, { tab: await browserPlugin.openBrowserWorkspaceTab(body) });
    return true;
  }

  const tabMatch = pathname.match(
    /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
  );
  if (!tabMatch) {
    return false;
  }

  const decodedTabId = decodePathComponent(
    tabMatch[1],
    res,
    "browser workspace tab id",
  );
  if (decodedTabId === null) return true;
  const tabId = decodedTabId.trim();
  if (!tabId) {
    error(res, "Browser workspace tab id is required", 400);
    return true;
  }
  const action = tabMatch[2] ?? null;

  const browserPlugin = await getBrowserWorkspacePlugin();
  if (!browserPlugin) {
    error(res, "Browser workspace is not available on this platform", 503);
    return true;
  }

  if (!action && method === "DELETE") {
    const closed = await browserPlugin.closeBrowserWorkspaceTab(tabId);
    json(res, { closed }, closed ? 200 : 404);
    return true;
  }

  if (action === "show" && method === "POST") {
    json(res, { tab: await browserPlugin.showBrowserWorkspaceTab(tabId) });
    return true;
  }

  if (action === "hide" && method === "POST") {
    json(res, { tab: await browserPlugin.hideBrowserWorkspaceTab(tabId) });
    return true;
  }

  if (action === "snapshot" && method === "GET") {
    json(res, await browserPlugin.snapshotBrowserWorkspaceTab(tabId));
    return true;
  }

  if (action === "navigate" && method === "POST") {
    const body =
      (await readJsonBody<{ url?: string; partition?: string }>(req, res)) ??
      null;
    if (!body?.url) {
      error(res, "url is required", 400);
      return true;
    }
    json(res, {
      tab: await browserPlugin.navigateBrowserWorkspaceTab({
        id: tabId,
        url: body.url,
      }),
    });
    return true;
  }

  if (action === "eval" && method === "POST") {
    const body =
      (await readJsonBody<{ script?: string; partition?: string }>(req, res)) ??
      null;
    if (!body?.script) {
      error(res, "script is required", 400);
      return true;
    }
    json(res, {
      value: await browserPlugin.evaluateBrowserWorkspaceTab({
        id: tabId,
        script: body.script,
      }),
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
import { serveMediaFile } from "./media-store.ts";
import {
  injectApiBaseIntoHtml,
  isAuthProtectedRoute,
  serveStaticUi,
} from "./static-file-server.ts";

export type { ChatAttachmentWithData } from "./server-types.ts";
export { injectApiBaseIntoHtml };

function parseBoundedLimit(rawLimit: string | null, fallback = 15): number {
  return parseClampedInteger(rawLimit, {
    min: 1,
    max: 50,
    fallback,
  });
}

function sanitizeFavoriteAppList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const apps: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    apps.push(trimmed);
  }
  return apps;
}

function readFavoriteAppsFromConfig(config: ElizaConfig): string[] {
  const ui = (config.ui ?? {}) as Record<string, unknown>;
  return sanitizeFavoriteAppList(ui.favoriteApps);
}

function writeFavoriteAppsToConfig(
  config: ElizaConfig,
  apps: string[],
): string[] {
  const sanitized = sanitizeFavoriteAppList(apps);
  const ui = (config.ui ?? {}) as Record<string, unknown>;
  ui.favoriteApps = sanitized;
  config.ui = ui as ElizaConfig["ui"];
  saveElizaConfig(config);
  return sanitized;
}

const isBlockedObjectKey = isBlockedObjectKeyFromConfig;

import {
  resolveMcpServersRejection as _resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection as _resolveMcpTerminalAuthorizationRejection,
} from "./server-helpers-mcp.ts";

export {
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
} from "./server-helpers-mcp.ts";

const resolveMcpServersRejection = _resolveMcpServersRejection;

import { pickRandomNames } from "../runtime/first-run-names.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import {
  applyFirstRunVoicePreset,
  ensureWalletKeysInEnvAndConfig,
  getCloudProviderOptions,
  getProviderOptions,
  isBlockedObjectKey as isBlockedObjectKeyFromConfig,
  readUiLanguageHeader,
  redactConfigSecrets,
  redactDeep,
  resolveConfiguredCharacterLanguage,
  resolveDefaultAgentName,
  stripRedactedPlaceholderValuesDeep,
} from "./server-helpers-config.ts";

export { isSafeResetStateDir } from "./server-helpers-config.ts";

// ---------------------------------------------------------------------------
// Trade permission helpers (exported for use by awareness contributors)
// ---------------------------------------------------------------------------

/**
 * Resolve the active trade permission mode from config.
 * Falls back to "user-sign-only" when not configured.
 */
export function resolveTradePermissionMode(
  config: ElizaConfig,
): TradePermissionMode {
  const raw = (config.features as Record<string, unknown> | undefined)
    ?.tradePermissionMode;
  if (
    raw === "user-sign-only" ||
    raw === "manual-local-key" ||
    raw === "agent-auto"
  ) {
    return raw;
  }
  return "user-sign-only";
}

/**
 * Maximum number of autonomous agent trades allowed per calendar day.
 * Acts as a safety rail when `agent-auto` mode is enabled.
 */
// Trade safety utilities (defined in trade-safety.ts for testability)
import {
  canUseLocalTradeExecution,
  type TradePermissionMode,
} from "./trade-safety.ts";

export {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
  type TradePermissionMode,
} from "./trade-safety.ts";

// ---------------------------------------------------------------------------
// Automation & agent permission helpers
// ---------------------------------------------------------------------------

import type { AgentAutomationMode } from "./server-types.ts";

const AGENT_AUTOMATION_HEADER = "x-eliza-agent-action";
const AGENT_AUTOMATION_MODES = new Set<AgentAutomationMode>([
  "connectors-only",
  "full",
]);
function parseAgentAutomationMode(value: unknown): AgentAutomationMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!AGENT_AUTOMATION_MODES.has(normalized as AgentAutomationMode)) {
    return null;
  }
  return normalized as AgentAutomationMode;
}

function _isAgentAutomationRequest(req: http.IncomingMessage): boolean {
  const raw = req.headers[AGENT_AUTOMATION_HEADER];
  if (typeof raw !== "string") return false;
  return /^(1|true|yes|agent)$/i.test(raw.trim());
}

function persistAgentAutomationMode(
  state: Pick<ServerState, "config" | "agentAutomationMode">,
  mode: AgentAutomationMode,
): void {
  state.agentAutomationMode = mode;
  if (!state.config.features) {
    state.config.features = {};
  }

  const features = state.config.features as Record<
    string,
    boolean | { enabled?: boolean; [k: string]: unknown }
  >;
  const current = features.agentAutomation;
  const currentObject =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};

  features.agentAutomation = {
    ...currentObject,
    enabled: true,
    mode,
  };
}

/**
 * Build the EVM wallet diagnostic card from the plugin-owned static descriptor
 * (identity, config keys, tags, prerequisite labels) merged with the
 * host-resolved runtime status. No plugin-specific literals live in the host.
 */
function buildPluginEvmDiagnosticEntry(
  state: Pick<ServerState, "config" | "runtime">,
): PluginEntry {
  return buildPluginDiagnosticEntry(
    walletDiagnosticDescriptor,
    resolveWalletDiagnosticStatus(walletDiagnosticDescriptor, state),
  );
}

import { resolveWalletExportRejection as _resolveWalletExportRejection } from "./server-helpers-wallet.ts";

export {
  resolveWalletExportRejection,
  type WalletExportRejection,
} from "./server-helpers-wallet.ts";

const resolveWalletExportRejection = _resolveWalletExportRejection;

import { resolvePluginConfigMutationRejections as _resolvePluginConfigMutationRejections } from "./server-helpers-plugin.ts";

export {
  type PluginConfigMutationRejection,
  resolvePluginConfigMutationRejections,
  resolvePluginConfigReply,
} from "./server-helpers-plugin.ts";

const resolvePluginConfigMutationRejections =
  _resolvePluginConfigMutationRejections;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export interface RuntimeRestartOptions {
  /**
   * The active adapter has already been closed to replace its on-disk data.
   * The host must fully dispose that runtime before opening the replacement.
   */
  disposeCurrentBeforeBuild?: boolean;
}

interface RequestContext {
  onRestart:
    | ((options?: RuntimeRestartOptions) => Promise<AgentRuntime | null>)
    | null;
  onRuntimeSwapped?: () => void;
  onRuntimeActivated?: (
    previousRuntime: AgentRuntime | null,
    activeRuntime: AgentRuntime,
  ) => void | Promise<void>;
  getAppManager?: () => Promise<AppManagerLike>;
}

const resolveMcpTerminalAuthorizationRejection =
  _resolveMcpTerminalAuthorizationRejection;

import {
  applyCors as _applyCors,
  clearPairing as _clearPairing,
  ensureApiTokenForBindHost as _ensureApiTokenForBindHost,
  ensurePairingCode as _ensurePairingCode,
  extractWebSocketHandshakeToken as _extractWebSocketHandshakeToken,
  getConfiguredApiToken as _getConfiguredApiToken,
  getPairingExpiresAt as _getPairingExpiresAt,
  isAllowedHost as _isAllowedHost,
  isAuthorized as _isAuthorized,
  isBoundaryRoleAuthorized as _isBoundaryRoleAuthorized,
  isCredentialedCorsOrigin as _isCredentialedCorsOrigin,
  isServerTokenAuthorized as _isServerTokenAuthorized,
  isSharedTerminalClientId as _isSharedTerminalClientId,
  isTrustedLocalRequest as _isTrustedLocalRequest,
  isWebSocketAuthorized as _isWebSocketAuthorized,
  isWebSocketSessionTokenAuthorized as _isWebSocketSessionTokenAuthorized,
  isWebSocketUpgradeSessionAuthorized as _isWebSocketUpgradeSessionAuthorized,
  markWebSocketUpgradeSessionAuthorized as _markWebSocketUpgradeSessionAuthorized,
  normalizePairingCode as _normalizePairingCode,
  normalizeWsClientId as _normalizeWsClientId,
  pairingEnabled as _pairingEnabled,
  rateLimitPairing as _rateLimitPairing,
  rejectWebSocketUpgrade as _rejectWebSocketUpgrade,
  releasePendingWebSocket as _releasePendingWebSocket,
  resolveBoundaryRole as _resolveBoundaryRole,
  resolveTerminalRunClientId as _resolveTerminalRunClientId,
  resolveTerminalRunRejection as _resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection as _resolveWebSocketUpgradeRejection,
  tryAcquirePendingWebSocket as _tryAcquirePendingWebSocket,
  WS_AUTH_GRACE_TIMEOUT_MS,
} from "./server-helpers-auth.ts";

// Importing the artifact share-viewer scheme self-registers its resolver with
// the trunk boundary-role registry (#14781) — same pattern as WaifuChat above.
export { issueArtifactShareViewerToken } from "./artifact-share-role-resolver.ts";
export {
  ensureApiTokenForBindHost,
  extractAuthToken,
  isAllowedHost,
  isAuthorized,
  normalizeWsClientId,
  resolveCorsOrigin,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
  type TerminalRunRejection,
  type WebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";
// Back-compat re-export: the WaifuChat scheme now lives in its own resolver
// module. Importing it here also self-registers the resolver with the trunk
// boundary-role registry (#12087 item 12).
export { isWaifuChatAuthorized } from "./waifu-chat-role-resolver.ts";

import { resolveHostSessionAccessContext } from "./host-session-access-context.ts";
import { resolveHttpAccessContext } from "./http-access-context.ts";
import { resolveInboxRequestAuthorization } from "./inbox-request-authorization.ts";
import { isTrajectoryOwnerRequest } from "./trajectory-request-authorization.ts";

const isAllowedHost = _isAllowedHost;
const applyCors = _applyCors;
const isAuthorized = _isAuthorized;
const resolveBoundaryRole = _resolveBoundaryRole;
const isTrustedLocalRequest = _isTrustedLocalRequest;
const isBoundaryRoleAuthorized = _isBoundaryRoleAuthorized;
const isCredentialedCorsOrigin = _isCredentialedCorsOrigin;
const isServerTokenAuthorized = _isServerTokenAuthorized;
const ensureApiTokenForBindHost = _ensureApiTokenForBindHost;
const normalizeWsClientId = _normalizeWsClientId;
const resolveTerminalRunClientId = _resolveTerminalRunClientId;
const isSharedTerminalClientId = _isSharedTerminalClientId;
const resolveTerminalRunRejection = _resolveTerminalRunRejection;
const resolveWebSocketUpgradeRejection = _resolveWebSocketUpgradeRejection;
const rejectWebSocketUpgrade = _rejectWebSocketUpgrade;
const isWebSocketAuthorized = _isWebSocketAuthorized;
const extractWebSocketHandshakeToken = _extractWebSocketHandshakeToken;
const isWebSocketSessionTokenAuthorized = _isWebSocketSessionTokenAuthorized;
const isWebSocketUpgradeSessionAuthorized =
  _isWebSocketUpgradeSessionAuthorized;
const markWebSocketUpgradeSessionAuthorized =
  _markWebSocketUpgradeSessionAuthorized;
const tryAcquirePendingWebSocket = _tryAcquirePendingWebSocket;
const releasePendingWebSocket = _releasePendingWebSocket;
const getConfiguredApiToken = _getConfiguredApiToken;
const pairingEnabled = _pairingEnabled;

const ensurePairingCode = _ensurePairingCode;
const normalizePairingCode = _normalizePairingCode;
const rateLimitPairing = _rateLimitPairing;
const getPairingExpiresAt = _getPairingExpiresAt;
const clearPairing = _clearPairing;

/**
 * Lazy per-process runtime operation manager. Constructed on first
 * request because it needs the per-server `state` reference + the
 * `onRestart` closure. Cached so subsequent requests see the same
 * active-op slot and execution chain.
 */
let cachedRuntimeOperationManager: RuntimeOperationManager | null = null;

function getOrCreateRuntimeOperationManager(
  state: ServerState,
  restartRuntime: (reason: string) => Promise<boolean>,
): RuntimeOperationManager {
  if (cachedRuntimeOperationManager) {
    return cachedRuntimeOperationManager;
  }
  const repository = getDefaultRepository();
  const healthChecker = getDefaultHealthChecker();
  const coldStrategy = createColdStrategy({
    restartRuntime: async (reason) => {
      const ok = await restartRuntime(reason);
      if (!ok) return null;
      return state.runtime;
    },
  });
  const hotStrategy = createHotStrategy({});
  const classifyContext = (): ClassifyContext => ({
    currentProvider: resolvePreferredProviderId(state.config),
    currentPrimaryModel: resolvePrimaryModel(state.config),
  });
  cachedRuntimeOperationManager = new DefaultRuntimeOperationManager({
    repository,
    runtime: () => state.runtime,
    classifyContext,
    classifier: defaultClassifier,
    healthChecker,
    strategies: { cold: coldStrategy, hot: hotStrategy },
  });
  return cachedRuntimeOperationManager;
}

import {
  attachPtySessionWsBridge,
  cancelPendingPtySessionStop,
  MAX_PTY_INPUT_MESSAGE_LENGTH,
  resolvePtyDisconnectGraceMs,
  schedulePtySessionStopAfterGrace,
} from "./pty-ws-bridge.ts";
import {
  isLifeOpsCloudPluginRoute,
  maybeRouteAutonomyEventToConversation,
} from "./server-autonomy-helpers.ts";
import {
  getPtyConsoleBridge,
  getPtyService,
  wireCodingAgentChatBridge,
  wireCodingAgentSwarmSynthesis,
  wireCodingAgentWsBridge,
  wireCoordinatorEventRouting,
} from "./server-helpers-swarm.ts";

import {
  asObject,
  normalizeTags,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTodo,
} from "./workbench-helpers.ts";

export {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.ts";

// One process-wide governance gate shared across runtime (re)registrations, so a
// restart doesn't reset the proactive-comment cooldowns/caps (#8792).
const proactiveInteractionGate = new ProactiveInteractionGate();

function proactiveNotificationGroupKey(offer: ProactiveOffer): string {
  if (offer.groupKey) return offer.groupKey;
  const basis = (offer.deepLink || offer.title || offer.text)
    .toLowerCase()
    .replace(/[^a-z0-9:/._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `proactive-interaction:${basis || "general"}`;
}

async function notifyProactiveInteraction(
  rt: IAgentRuntime,
  offer: ProactiveOffer,
): Promise<void> {
  const service = rt.getService(ServiceType.NOTIFICATION);
  if (!(service instanceof NotificationService)) {
    logger.debug(
      "[proactive-interaction] notification service unavailable; suppressing notify-lane offer",
    );
    return;
  }

  const title = offer.title?.trim() || offer.text;
  await service.notify({
    title,
    body: title === offer.text ? undefined : offer.text,
    category: "agent",
    priority: "low",
    source: PROACTIVE_INTERACTION_SOURCE,
    deepLink: offer.deepLink,
    groupKey: proactiveNotificationGroupKey(offer),
    data: { kind: "proactive-interaction" },
  });
}

/**
 * Wire the proactive-interaction decider (#8792): subscribe to VIEW_SWITCHED and
 * route an admitted, model-judged offer into chat suggestions or low-priority
 * notifications. No-ops when disabled by config/kill-switch.
 */
function wireProactiveInteractionDecider(
  rt: IAgentRuntime,
  state: ServerState,
): void {
  registerProactiveInteractionDecider(rt, {
    gate: proactiveInteractionGate,
    route: (text) =>
      routeProactiveText(state, text, PROACTIVE_INTERACTION_SOURCE),
    notify: (offer) => notifyProactiveInteraction(rt, offer),
    shouldSuppress: () => state.activeChatTurnCount > 0,
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
  ctx?: RequestContext,
): Promise<void> {
  const method = req.method ?? "GET";
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    error(res, "Invalid request URL", 400);
    return;
  }
  const pathname = url.pathname;
  const isAuthEndpoint = pathname.startsWith("/api/auth/");
  const isHealthEndpoint = method === "GET" && pathname === "/api/health";
  let isCloudProvisionedContainer = (): boolean => false;
  let handleCloudStatusRoutes = async (_args: unknown): Promise<boolean> =>
    false;
  if (
    // plugin-elizacloud is desktop/cloud-only; on mobile its dynamic import
    // does not resolve and the resulting await stalls the whole request (the
    // /api/cloud, /api/coding-agents, and cloud-first-run paths then hang).
    // Skip the import on mobile — the default no-op cloud helpers above keep
    // isCloudProvisioned=false (correct for a local mobile agent) and let the
    // request fall through to its normal handler/404.
    !isMobilePlatform() &&
    (pathname === "/api/first-run/status" ||
      pathname.startsWith("/api/cloud") ||
      pathname.startsWith("/api/coding-agents"))
  ) {
    const cloudApi = await getOptionalPluginApi<{
      isCloudProvisionedContainer: () => boolean;
      handleCloudStatusRoutes: (args: unknown) => Promise<boolean>;
    }>("cloud");
    isCloudProvisionedContainer = cloudApi.isCloudProvisionedContainer;
    handleCloudStatusRoutes = cloudApi.handleCloudStatusRoutes;
  }
  const isCloudProvisioned = isCloudProvisionedContainer();
  const isCloudFirstRunStatusEndpoint =
    method === "GET" &&
    pathname === "/api/first-run/status" &&
    isCloudProvisioned;
  // app-core authenticates the session-tier dashboard reads
  // (/api/cloud/status, /api/cloud/credits) before forwarding into the agent
  // server. They need no dedicated exemption here: app-core's forwarded
  // requests arrive over trusted loopback and already pass `isAuthorized`,
  // while exempting the paths let ANY unauthenticated caller who could reach
  // the port (LAN/wildcard bind) read the owner's cloud userId, organizationId,
  // and live credit balance (W1-010).
  const isAuthProtectedPath = isAuthProtectedRoute(pathname);
  const requestOrigin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  // A same-origin navigation commonly omits Origin. When an Origin is present,
  // ambient cookie authority is available only to the narrower credentialed
  // CORS trust set; arbitrary reflected origins remain bearer-only.
  const allowHostCookieAuth =
    requestOrigin === undefined || isCredentialedCorsOrigin(requestOrigin);
  const requireBrowserCompanionOwnerSession = isBrowserCompanionOwnerMutation(
    method,
    pathname,
  );
  let hostSessionAuthorization: AgentHttpRequestAuthorization = {
    ok: false,
    role: "NONE",
  };
  let hostSessionAuthorizationAttempted = false;
  const resolveHostSessionAuthorization =
    async (): Promise<AgentHttpRequestAuthorization> => {
      if (hostSessionAuthorizationAttempted) return hostSessionAuthorization;
      hostSessionAuthorizationAttempted = true;
      const bridge = getAgentHostBridge();
      const resolveAuthorization = bridge.resolveHttpRequestAuthorization;
      if (typeof resolveAuthorization === "function") {
        hostSessionAuthorization = await resolveAuthorization(
          req,
          state.runtime,
          {
            allowCookieAuth: allowHostCookieAuth,
            allowTrustedLocalBypass: !requireBrowserCompanionOwnerSession,
            allowBearerAuth: !requireBrowserCompanionOwnerSession,
          },
        );
        return hostSessionAuthorization;
      }
      const authorize = bridge.isHttpRequestAuthorized;
      // A legacy boolean-only bridge cannot separate cookie from bearer
      // authority. Do not consult it for an explicitly untrusted origin;
      // standalone bearer schemes are evaluated by the normal server gates.
      const authorized =
        allowHostCookieAuth && typeof authorize === "function"
          ? await authorize(req, state.runtime)
          : false;
      // Legacy boolean-only hosts can still pass the coarse request gate, but
      // cannot claim OWNER authority for a sensitive account-selection action.
      hostSessionAuthorization = {
        ok: authorized,
        role: authorized ? "USER" : "NONE",
      };
      return hostSessionAuthorization;
    };
  const isHostSessionAuthorized = async (): Promise<boolean> =>
    (await resolveHostSessionAuthorization()).ok;

  const canonicalizeRestartReason = (reason: string): string => {
    if (
      reason === "primary-changed" ||
      reason === "cloud-refreshed" ||
      reason === "Wallet configuration updated"
    ) {
      return "Wallet configuration updated";
    }
    return reason;
  };

  const scheduleRuntimeRestart = (reason: string): void => {
    const canonicalReason = canonicalizeRestartReason(reason);
    if (state.pendingRestartReasons.length >= 50) {
      // Prevent unbounded growth — keep only first entry + latest
      state.pendingRestartReasons.splice(
        1,
        state.pendingRestartReasons.length - 1,
      );
    }
    if (!state.pendingRestartReasons.includes(canonicalReason)) {
      state.pendingRestartReasons.push(canonicalReason);
    }
    logger.info(
      `[eliza-api] Restart required: ${canonicalReason} (${state.pendingRestartReasons.length} pending)`,
    );
    state.broadcastWs?.({
      type: "restart-required",
      reasons: [...state.pendingRestartReasons],
    });
  };

  const restartRuntime = async (
    reason: string,
    options?: RuntimeRestartOptions,
  ): Promise<boolean> => {
    if (!ctx?.onRestart) {
      return false;
    }
    if (state.agentState === "restarting") {
      return false;
    }

    const previousState = state.agentState;
    logger.info(`[eliza-api] Applying runtime reload: ${reason}`);
    state.agentState = "restarting";
    state.startup = { ...state.startup, phase: "restarting" };
    state.broadcastStatus?.();

    try {
      const previousRuntime = state.runtime;
      const newRuntime = await ctx.onRestart(options);
      if (!newRuntime) {
        state.agentState = options?.disposeCurrentBeforeBuild
          ? "error"
          : previousState;
        if (options?.disposeCurrentBeforeBuild) {
          state.startup = {
            ...state.startup,
            phase: "error",
            lastError:
              "Runtime replacement failed after the current runtime was disposed",
            lastErrorAt: Date.now(),
          };
        }
        state.broadcastStatus?.();
        return false;
      }

      await quiesceRuntimeBeforeReplacement(previousRuntime, newRuntime);
      state.runtime = newRuntime;
      state.chatConnectionReady = null;
      state.chatConnectionPromise = null;
      state.agentState = "running";
      state.agentName =
        newRuntime.character.name ?? resolveDefaultAgentName(state.config);
      state.model = detectRuntimeModel(newRuntime, state.config);
      state.startedAt = Date.now();
      state.pendingRestartReasons = [];
      ctx.onRuntimeSwapped?.();
      try {
        await ctx.onRuntimeActivated?.(previousRuntime, newRuntime);
      } catch (err) {
        // error-policy:J6 the replacement is already active; host cleanup must
        // be observable without reverting a healthy runtime.
        newRuntime.reportError("api.restart.activateRuntime", err);
        logger.warn(
          `[eliza-api] Post-swap runtime cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      state.broadcastStatus?.();
      return true;
    } catch (err) {
      logger.warn(
        `[eliza-api] Runtime reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      state.agentState = options?.disposeCurrentBeforeBuild
        ? "error"
        : previousState;
      if (options?.disposeCurrentBeforeBuild) {
        state.startup = {
          ...state.startup,
          phase: "error",
          lastError:
            "Runtime replacement failed after the current runtime was disposed",
          lastErrorAt: Date.now(),
        };
      }
      state.broadcastStatus?.();
      return false;
    }
  };

  // ── DNS rebinding protection ──────────────────────────────────────────
  // Reject requests whose Host header doesn't match a known loopback
  // hostname.  Without this check an attacker can rebind their domain's
  // DNS to 127.0.0.1 and read the unauthenticated localhost API from a
  // malicious page.
  if (!isAllowedHost(req)) {
    const incomingHost = req.headers.host ?? "your-hostname";
    json(
      res,
      {
        error: "Forbidden — invalid Host header",
        hint: `To allow this host, set ELIZA_ALLOWED_HOSTS=${incomingHost} in your environment, or access via http://localhost`,
        docs: "https://docs.eliza.ai/configuration#allowed-hosts",
      },
      403,
    );
    return;
  }

  if (!applyCors(req, res, pathname)) {
    json(res, { error: "Origin not allowed" }, 403);
    return;
  }

  // Cloud SSO popup handoff: GET /pair?token=X must short-circuit BEFORE the
  // static-UI catch-all, otherwise the SPA index.html is served and the user
  // ends up on the password screen.
  //
  // The cloud-SSO handoff route is owned by the app-core host and injected
  // downward through the agent host bridge (see ../runtime/host-bridge.ts) so
  // agent never imports `@elizaos/app-core`. A local on-device agent never
  // legitimately serves it, so the bridge omits the handler and the request
  // falls through to the normal pipeline.
  const handleCloudPairRoute = getAgentHostBridge().handleCloudPairRoute;
  if (
    (typeof handleCloudPairRoute === "function" &&
      (await handleCloudPairRoute(req, res))) ||
    (await handleStandaloneCloudPairRoute(req, res))
  ) {
    return;
  }

  // The packaged desktop runs the agent listener directly, but app-core owns
  // its browser-session store. The host consumes the one-shot local socket
  // proof here; its handler enforces loopback peer+Host, originlessness,
  // socket ownership, and socket mode before minting anything.
  const handleDesktopAuthBootstrapRoute =
    getAgentHostBridge().handleDesktopAuthBootstrapRoute;
  if (
    typeof handleDesktopAuthBootstrapRoute === "function" &&
    (await handleDesktopAuthBootstrapRoute(req, res, state.runtime))
  ) {
    return;
  }

  // Serve dashboard static assets before the auth gates. serveStaticUi already
  // refuses /api/, /v1/, and /ws paths, so API endpoints remain protected
  // while steward-managed containers can still reach the built-in dashboard.
  if (method === "GET" || method === "HEAD") {
    if (serveStaticUi(req, res, pathname)) return;
    // Chat media (uploaded + generated). Content-addressed sha256 filenames act
    // as unguessable capabilities, so media loads from <img>/<audio> without an
    // auth header — same rationale as static assets above.
    if (serveMediaFile(req, res, pathname)) return;
  }

  // ── Runtime-mode visibility gate ────────────────────────────────────────
  // Enforced here, in the server every host shares, so the bare agent
  // (`bun run start`) honors the same mode contract as the app-core wrapper:
  // routes outside the active runtime mode return 404 before auth runs
  // (hidden, not probeable). OPTIONS is exempt so CORS preflight keeps its
  // unconditional 204 below.
  if (
    method !== "OPTIONS" &&
    (await handleRuntimeModePreDispatch(req, res, state.runtime))
  ) {
    return;
  }

  // ── Per-session request-storm cap ───────────────────────────────────────
  // Before auth resolution and route handlers: a bearer session sustaining
  // more than its polling budget gets 429 + Retry-After (see
  // request-storm-cap.ts for the live incident this guards against).
  if (maybeCapRequestStorm(req, res, pathname)) {
    return;
  }

  if (requireBrowserCompanionOwnerSession) {
    if (!hasBrowserCompanionOwnerSessionCookie(req)) {
      json(res, { error: "Owner session required" }, 401);
      return;
    }
    if (!hasBrowserCompanionCsrfHeader(req)) {
      json(res, { error: "CSRF token required" }, 403);
      return;
    }
    const ownerAuthorization = await resolveHostSessionAuthorization();
    if (!ownerAuthorization.ok) {
      json(res, { error: "Invalid owner session or CSRF token" }, 401);
      return;
    }
    if (ownerAuthorization.role !== "OWNER") {
      json(res, { error: "Owner role required" }, 403);
      return;
    }
  }

  if (
    method !== "OPTIONS" &&
    isAuthProtectedPath &&
    !isAuthEndpoint &&
    !isHealthEndpoint &&
    !isCloudFirstRunStatusEndpoint &&
    !isPublicRuntimePluginRoute({
      runtime: state.runtime,
      method,
      pathname,
    }) &&
    !(await isHostSessionAuthorized()) &&
    !isAuthorized(req) &&
    !isBoundaryRoleAuthorized(req, method, pathname)
  ) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }

  // Complete trajectory inputs and outputs belong to the owner's developer
  // surface. Enforce this before forwarding or any plugin route can dispatch.
  if (
    method !== "OPTIONS" &&
    (pathname === "/api/trajectories" ||
      pathname.startsWith("/api/trajectories/")) &&
    !isTrajectoryOwnerRequest(
      req,
      method,
      pathname,
      await resolveHostSessionAuthorization(),
    )
  ) {
    json(res, { error: "Owner role required" }, 403);
    return;
  }

  // Remote-mode cloud mutations are forwarded only after the request passes
  // the normal API auth gate; the forwarder attaches the controller's target
  // token, so pre-auth forwarding would let an unauthenticated caller mutate
  // the controlled target.
  if (
    method !== "OPTIONS" &&
    (await handleRuntimeModeRemoteForward(req, res))
  ) {
    return;
  }

  // CORS preflight
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/api/backups") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const backups = await listLocalAgentBackups(state.runtime.agentId);
      json(res, { backups });
    } catch (err) {
      // error-policy:J1 backup listing can surface filesystem paths in
      // exceptions; keep the original diagnostic in the structured log.
      logger.error({ err }, "[agent-backup] Local backup list failed");
      error(res, "Backup list failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/backups") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const backup = await createLocalAgentBackup(state.runtime, state.config);
      json(res, { backup });
    } catch (err) {
      // error-policy:J1 backup adapters can include filesystem and database
      // diagnostics in exceptions; keep the original in the redacting logger.
      logger.error({ err }, "[agent-backup] Local backup failed");
      error(res, "Backup failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/backups/restore") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    const body = await readBackupJsonBody(req, res);
    if (!body) return;
    const bodyRecord = isJsonRecord(body) ? body : null;
    const fileName =
      typeof bodyRecord?.fileName === "string" ? bodyRecord.fileName : null;
    if (!fileName) {
      error(res, "fileName is required", 400);
      return;
    }
    try {
      const result = await restoreLocalAgentBackup(state.runtime, fileName);
      json(res, result);
    } catch (err) {
      // error-policy:J1 decryption, filesystem, and database diagnostics stay
      // internal rather than becoming a public backup oracle.
      logger.error({ err }, "[agent-backup] Local backup restore failed");
      error(res, "Backup restore failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/snapshot") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const snapshot = await createAgentSnapshot(state.runtime, state.config);
      await writeAgentBackupJsonResponse(res, snapshot);
    } catch (err) {
      const message = formatError(err);
      if (
        err instanceof AgentBackupClientDisconnectedError ||
        message === "Agent backup response stream failed"
      ) {
        // The download transport died mid-stream (client abort or socket
        // error). The response is already committed and the socket is gone;
        // treat it like the v2 capture boundary's 499/ephemeral path rather
        // than logging a server fault.
        logger.warn(
          { err: message },
          "[agent-backup] Snapshot download aborted",
        );
        return;
      }
      if (message === PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT) {
        // Transient teardown race (PGlite closing) — 503 so the caller retries
        // or defers instead of tripping the fail-closed restart gate on a 500
        // (2026-08-11 fleet incident: 500 here wedged healthy agent restarts).
        logger.warn(
          { err: message },
          "[agent-backup] Snapshot temporarily unavailable",
        );
        json(
          res,
          {
            error: PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
            code: PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE,
          },
          503,
        );
        return;
      }
      logger.error({ err: message }, "[agent-backup] Snapshot failed");
      if (res.headersSent) {
        // error-policy:J1 Streaming may fail after the response is committed;
        // terminate that transport instead of appending a false JSON error.
        res.destroy(new Error("Snapshot stream failed", { cause: err }));
        return;
      }
      // error-policy:J1 the snapshot boundary preserves diagnostics in the
      // server log while exposing only a stable failure to the API caller.
      error(res, "Snapshot failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/snapshot/v2") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    await handleAgentBackupV2SnapshotRequest(req, res, {
      runtime: state.runtime,
      config: state.config,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/restore") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    const body = await readBackupJsonBody(req, res);
    if (!body) return;
    if (!isAgentBackupStateData(body)) {
      error(res, "Invalid backup snapshot payload", 400);
      return;
    }
    try {
      const result = await restoreAgentSnapshot(state.runtime, body);
      const restarted = await restartRuntime("agent backup restored", {
        disposeCurrentBeforeBuild: true,
      });
      if (!restarted) {
        throw new Error(
          "Backup restored, but the runtime could not restart on the restored database",
        );
      }
      json(res, { ...result, requiresRestart: false });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Restore failed",
      );
      error(res, err instanceof Error ? err.message : "Restore failed", 500);
    }
    return;
  }

  if (
    (pathname.startsWith("/api/local-inference") ||
      pathname.startsWith("/api/tts/local-inference") ||
      pathname.startsWith("/api/asr/local-inference") ||
      pathname.startsWith("/api/voice/audio-frames") ||
      pathname === "/api/voice/playback-frames" ||
      pathname === "/api/voice/aec-capture") &&
    (await (async () => {
      const localInferenceServerApi = await getLocalInferenceServerApi();
      if (
        typeof localInferenceServerApi.handleLocalInferenceRoutes ===
          "function" &&
        (await localInferenceServerApi.handleLocalInferenceRoutes(req, res))
      ) {
        return true;
      }
      // WebView → agent PCM transport for live on-device speaker diarization.
      if (
        localInferenceServerApi.handleLiveDiarizationRoute &&
        (await localInferenceServerApi.handleLiveDiarizationRoute(req, res, {
          current: state.runtime,
        }))
      ) {
        return true;
      }
      if (
        localInferenceServerApi.handleLocalInferenceAsrRoute &&
        (await localInferenceServerApi.handleLocalInferenceAsrRoute(req, res, {
          current: state.runtime,
        }))
      ) {
        return true;
      }
      return Boolean(
        localInferenceServerApi.handleLocalInferenceTtsRoute &&
          (await localInferenceServerApi.handleLocalInferenceTtsRoute(
            req,
            res,
            {
              current: state.runtime,
            },
          )),
      );
    })())
  ) {
    return;
  }

  if (
    await handleBackgroundTasksRoute({
      req,
      res,
      method,
      pathname,
      state,
      json,
    })
  ) {
    return;
  }
  // Computer-use is a desktop/cloud-only plugin; on mobile it is not in the
  // agent bundle, so importing it here would REJECT (`Cannot find module
  // '@elizaos/plugin-computeruse'`) and surface as a 500 on every renderer poll
  // of /api/computer-use/approvals. Skip the import path on mobile and let the
  // request fall through to handleMobileOptionalRoutes, which serves the inert
  // {mode:"off",…} approval snapshot.
  if (!isMobilePlatform() && pathname.startsWith("/api/computer-use/")) {
    const { handleComputerUseRoutes } = await getOptionalPluginApi<{
      handleComputerUseRoutes: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        pathname: string,
        method: string,
      ) => Promise<boolean>;
    }>("computerUse");
    if (await handleComputerUseRoutes(req, res, pathname, method)) return;
  }

  // ── Provider inference helpers ────────────────────────────────────────
  const _disableCloudInference = (): void => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  };

  const _enableCloudInference = (
    cloudApiKey: string,
    baseUrl: string,
  ): void => {
    // Configure coding agent CLIs to proxy through ElizaCloud /api/v1
    process.env.ANTHROPIC_BASE_URL = `${baseUrl}/api/v1`;
    process.env.ANTHROPIC_API_KEY = cloudApiKey;
    process.env.OPENAI_BASE_URL = `${baseUrl}/api/v1`;
    process.env.OPENAI_API_KEY = cloudApiKey;
    // Gemini CLI and Aider — no proxy support via ElizaCloud inference
  };

  if (method === "POST" && pathname === "/api/provider/switch") {
    if (
      await handleProviderSwitchRoutes({
        req,
        res,
        method,
        pathname,
        state,
        json,
        error,
        readJsonBody,
        saveElizaConfig,
        scheduleRuntimeRestart,
        runtimeOperationManager: getOrCreateRuntimeOperationManager(
          state,
          restartRuntime,
        ),
      })
    ) {
      return;
    }
  }

  if (
    await handleAuthRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      pairingEnabled,
      ensurePairingCode,
      normalizePairingCode,
      rateLimitPairing,
      getPairingExpiresAt,
      clearPairing,
    })
  ) {
    return;
  }

  if (
    await handleSubscriptionRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      saveConfig: saveElizaConfig,
      loadSubscriptionAuth: async () =>
        (await import("@elizaos/auth")) as never,
    } as never)
  ) {
    return;
  }

  if (
    await handleAccountsRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      state: { config: state.config, runtime: state.runtime },
      saveConfig: saveElizaConfig,
    })
  ) {
    return;
  }

  if (
    await handleHealthRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
    })
  ) {
    return;
  }

  const firstRunGetWalletAddresses =
    pathname === "/api/wallet/keys"
      ? (await getCoreWalletApi()).getWalletAddresses
      : null;

  if (
    await handleFirstRunRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      isCloudProvisionedContainer,
      hasPersistedFirstRunState,
      ensureWalletKeysInEnvAndConfig,
      getWalletAddresses: firstRunGetWalletAddresses
        ? () => firstRunGetWalletAddresses(state.runtime?.agentId)
        : () => ({
            evmAddress: null,
            solanaAddress: null,
          }),
      pickRandomNames,
      getStylePresets,
      getProviderOptions,
      getCloudProviderOptions,
      getModelOptions,
      getInventoryProviderOptions,
      resolveConfiguredCharacterLanguage,
      normalizeCharacterLanguage,
      readUiLanguageHeader,
      applyFirstRunVoicePreset,
      saveElizaConfig,
    })
  ) {
    return;
  }

  // POST /api/first-run is now handled by first-run-routes.ts above.

  if (
    await handleAgentLifecycleRoutes({
      req,
      res,
      method,
      pathname,
      state,
      error,
      json,
      readJsonBody,
      // Lets POST /api/agent/start boot a runtime from the runtime-less state
      // (fresh-install deferred boot / stopped host) instead of fake-flipping
      // the reported state to "running" with nothing behind it.
      onRestart: ctx?.onRestart ?? undefined,
      onRuntimeSwapped: ctx?.onRuntimeSwapped,
      onRuntimeActivated: ctx?.onRuntimeActivated,
    })
  ) {
    return;
  }

  if (pathname.startsWith("/api/triggers")) {
    const { handleTriggerRoutes } = await getOptionalPluginApi<{
      handleTriggerRoutes: (args: unknown) => Promise<boolean>;
    }>("workflow");
    const triggerHandled = await handleTriggerRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime,
      readJsonBody,
      json,
      error,
      executeTriggerTask,
      getTriggerHealthSnapshot,
      getTriggerLimit,
      listTriggerTasks,
      readTriggerConfig,
      readTriggerRuns,
      taskToTriggerSummary,
      triggersFeatureEnabled,
      buildTriggerConfig,
      buildTriggerMetadata,
      normalizeTriggerDraft,
      DISABLED_TRIGGER_INTERVAL_MS,
      TRIGGER_TASK_NAME,
      TRIGGER_TASK_TAGS: [...TRIGGER_TASK_TAGS],
    });
    if (triggerHandled) {
      return;
    }
  }

  // Knowledge routes (/api/knowledge/*) are now provided by the
  // @elizaos/app-knowledge plugin via the runtime route registry.

  if (
    pathname.startsWith("/api/memory") ||
    pathname.startsWith("/api/memories") ||
    pathname === "/api/context/quick"
  ) {
    const memoryHandled = await handleMemoryRoutes({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      agentName: state.agentName,
      readJsonBody,
      json,
      error,
    });
    if (memoryHandled) return;
  }

  if (
    await handleAgentAdminRoutes({
      req,
      res,
      method,
      pathname,
      state,
      onRestart: ctx?.onRestart ?? undefined,
      onRuntimeSwapped: ctx?.onRuntimeSwapped,
      onRuntimeActivated: ctx?.onRuntimeActivated,
      json,
      error,
      resolveStateDir,
      stateDirExists: fs.existsSync,
      removeStateDir: (resolvedState) => {
        fs.rmSync(resolvedState, { recursive: true, force: true });
      },
      logWarn: (message) => logger.warn(message),
    })
  ) {
    return;
  }

  if (
    await handleAgentTransferRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      exportAgent,
      estimateExportSize,
      importAgent,
      isAgentExportError: (err: unknown) => err instanceof AgentExportError,
    })
  ) {
    return;
  }

  if (
    await handleCharacterRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      pickRandomNames,
      saveConfig: saveElizaConfig as never,
      validateCharacter: (body) => CharacterSchema.safeParse(body) as never,
    })
  ) {
    return;
  }

  // Compatibility route used by legacy health probes and desktop name lookup.
  if (method === "GET" && pathname === "/api/agents") {
    const runtimeAgentId =
      typeof state.runtime?.agentId === "string" &&
      state.runtime.agentId.trim().length > 0
        ? state.runtime.agentId.trim()
        : null;
    const configuredAgentId =
      typeof state.config.agents?.list?.[0]?.id === "string" &&
      state.config.agents.list[0].id.trim().length > 0
        ? state.config.agents.list[0].id.trim()
        : null;
    const agentName =
      state.runtime?.character.name?.trim() ||
      state.agentName.trim() ||
      "Eliza";

    json(res, {
      agents: [
        {
          id:
            runtimeAgentId ??
            configuredAgentId ??
            "00000000-0000-0000-0000-000000000000",
          name: agentName,
          status: state.agentState,
        },
      ],
    });
    return;
  }

  if (
    await handleModelsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      providerCachePath,
      getOrFetchProvider,
      getOrFetchAllProviders,
      resolveModelsCacheDir,
      pathExists: fs.existsSync,
      readDir: fs.readdirSync,
      unlinkFile: fs.unlinkSync,
      joinPath: path.join,
    })
  ) {
    return;
  }

  // Gate on the exact path before building the context so the runtime
  // operation manager is not instantiated on unrelated requests.
  if (pathname === "/api/models/config") {
    if (
      await handleModelConfigRoutes({
        req,
        res,
        method,
        pathname,
        json,
        readJsonBody,
        state: { config: state.config, runtime: state.runtime },
        saveElizaConfig,
        runtimeOperationManager: getOrCreateRuntimeOperationManager(
          state,
          restartRuntime,
        ),
      })
    ) {
      return;
    }
  }

  if (
    await handleRegistryRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      getPluginManager: () => getPluginManagerForState(state) as never,
      getLoadedPluginNames: () =>
        state.runtime?.plugins.map((plugin) => plugin.name) ?? [],
      getBundledPluginIds: () => getReleaseBundledPluginIds(),
      classifyRegistryPluginRelease,
    })
  ) {
    return;
  }

  if (
    await handleRemoteCapabilityRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime,
      config: state.config,
      readJsonBody,
      saveConfig: (config) => saveElizaConfig(config as ElizaConfig),
      persistConfigEnv,
      json,
      error,
    })
  ) {
    return;
  }

  // Live-load a plugin from an on-disk directory into the running runtime. This
  // is what makes a freshly scaffolded/edited local plugin (VIEWS/APP create)
  // actually appear without an agent restart — its views register via
  // runtime.registerPlugin. Must run BEFORE the generic /api/plugins/* handler.
  if (
    await handlePluginDirectoryRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // Unload a plugin previously live-loaded from a directory (the symmetric
  // counterpart to load-from-directory). Directly-registered plugins are not
  // known to the plugin-manager, so /api/plugins/uninstall can't remove them —
  // this delegates to runtime.unloadPlugin, which also deregisters its views.
  if (method === "POST" && pathname === "/api/plugins/unload-from-directory") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const body = await readJsonBody<{ pluginName?: unknown }>(req, res);
    if (body === null) return;
    const pluginName =
      typeof body.pluginName === "string" ? body.pluginName.trim() : "";
    if (!pluginName) {
      error(res, "'pluginName' is required", 400);
      return;
    }
    try {
      const { unloadPluginFromDirectory } = await import(
        "../runtime/load-plugin-from-directory.ts"
      );
      const result = await unloadPluginFromDirectory({
        runtime: state.runtime as Parameters<
          typeof unloadPluginFromDirectory
        >[0]["runtime"],
        pluginName,
      });
      json(res, { ok: result.unloaded, ...result });
    } catch (err) {
      // error-policy:J1 plugin-loader diagnostics stay in structured logs;
      // callers receive a stable boundary error rather than exception text.
      logger.error({ err }, "[eliza-api] Plugin unload failed");
      json(res, { ok: false, error: "Plugin could not be unloaded" }, 422);
    }
    return;
  }

  if (
    pathname === "/api/plugins" ||
    pathname.startsWith("/api/plugins/") ||
    pathname === "/api/secrets" ||
    pathname === "/api/core/status"
  ) {
    const { handlePluginRoutes } = await getPluginRegistryApi();
    if (
      await handlePluginRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        scheduleRuntimeRestart,
        restartRuntime,
        isBlockedEnvKey,
        discoverInstalledPlugins,
        maskValue,
        aggregateSecrets,
        readProviderCache,
        paramKeyToCategory,
        buildPluginEvmDiagnosticEntry,
        EVM_PLUGIN_PACKAGE,
        applyWhatsAppQrOverride: (
          await getOptionalPluginApi<{
            applyWhatsAppQrOverride: (...args: unknown[]) => void;
          }>("whatsapp")
        ).applyWhatsAppQrOverride,
        resolvePluginConfigMutationRejections,
        requirePluginManager,
        requireCoreManager,
      })
    ) {
      return;
    }
  }

  // Curated-skills routes must be dispatched before generic skills routes
  // (which reject "/" in skill IDs).
  if (pathname.startsWith("/api/skills/curated")) {
    const { handleCuratedSkillsRoutes } = await getAgentSkillsApi();
    if (
      await handleCuratedSkillsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        json,
        error,
        readJsonBody,
      })
    ) {
      return;
    }
  }
  if (pathname.startsWith("/api/skills")) {
    const { discoverSkills, handleSkillsRoutes } = await getAgentSkillsApi();
    if (
      await handleSkillsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        readBody,
        discoverSkills,
      })
    ) {
      return;
    }
  }

  if (
    await handleDiagnosticsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      logBuffer: state.logBuffer,
      clearLogBuffer: () => {
        const previous = state.logBuffer.length;
        state.logBuffer.length = 0;
        return previous;
      },
      readJsonBody,
      error,
      eventBuffer: state.eventBuffer,
      json,
      auditEventTypes: AUDIT_EVENT_TYPES,
      auditSeverities: AUDIT_SEVERITIES,
      getAuditFeedSize,
      queryAuditFeed: (query) =>
        queryAuditFeed({
          type: (AUDIT_EVENT_TYPES as readonly string[]).includes(
            query.type ?? "",
          )
            ? (query.type as (typeof AUDIT_EVENT_TYPES)[number])
            : undefined,
          severity: (AUDIT_SEVERITIES as readonly string[]).includes(
            query.severity ?? "",
          )
            ? (query.severity as (typeof AUDIT_SEVERITIES)[number])
            : undefined,
          sinceMs: query.sinceMs,
          limit: query.limit,
        }).map((entry) => ({
          timestamp: entry.timestamp,
          type: entry.type,
          summary: entry.summary,
          severity: entry.severity,
          metadata: entry.metadata,
        })),
      subscribeAuditFeed,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Bug report routes
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleBugReportRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Project registry routes (#13776 item 5): list + switch the active project
  // that backs the UI project switcher.
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleProjectRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Wallet core routes (addresses, balances, generate, config, export)
  // Prefer the local wallet implementation during desktop startup. The
  // wallet route owner must not pull browser/UI-only dependencies into the
  // agent process or block local assistant boot.
  // ═══════════════════════════════════════════════════════════════════════
  // plugin-wallet is desktop/cloud-only; on mobile its import does not resolve
  // and the await stalls /api/wallet/* requests. Skip on mobile → fall through
  // to 404 (the mobile agent has no EVM/Solana wallet surface anyway).
  if (!isMobilePlatform() && pathname.startsWith("/api/wallet/")) {
    const { handleWalletRoutes } = await getWalletApi();
    const {
      deriveSolanaAddress,
      fetchEvmBalances,
      fetchSolanaBalances,
      fetchSolanaNativeBalanceViaRpc,
      generateWalletForChain,
      getWalletAddresses: getCoreWalletAddresses,
      importWallet,
      setSolanaWalletEnv,
      validatePrivateKey,
    } = await getCoreWalletApi();
    const durableWalletConfig = loadElizaConfig();
    const walletUsesCloudNetwork =
      method === "GET" || pathname === "/api/wallet/refresh-cloud";
    const walletAuthorityView = walletUsesCloudNetwork
      ? createDevCloudConfigAuthorityView(durableWalletConfig)
      : durableWalletConfig;
    const walletConfig =
      materializeDevCloudConfigAuthorityView(walletAuthorityView);
    const saveWalletConfig = (nextConfig: ElizaConfig): void => {
      const persistable = mergeDevCloudConfigAuthorityMutation(
        durableWalletConfig,
        walletAuthorityView,
        nextConfig,
      );
      saveElizaConfig(persistable);
    };
    if (
      await handleWalletRoutes({
        req,
        res,
        method,
        pathname,
        config: walletConfig,
        saveConfig: saveWalletConfig,
        ensureWalletKeysInEnvAndConfig,
        resolveWalletExportRejection,
        restartRuntime,
        scheduleRuntimeRestart,
        readJsonBody,
        json,
        error,
        deps: {
          fetchEvmBalances,
          fetchSolanaBalances,
          fetchSolanaNativeBalanceViaRpc,
          getWalletAddresses: () =>
            getCoreWalletAddresses(state.runtime?.agentId),
          validatePrivateKey,
          importWallet,
          generateWalletForChain,
          deriveSolanaAddress,
          setSolanaWalletEnv,
          resolveWalletRpcReadiness,
          resolveWalletNetworkMode,
          getStoredWalletRpcSelections,
          applyWalletRpcConfigUpdate,
          resolveWalletCapabilityStatus: (args) => ({
            ...resolveWalletCapabilityStatus({
              config: args.config,
              runtime: args.runtime,
              getWalletAddresses: () =>
                getCoreWalletAddresses(args.runtime?.agentId),
            }),
          }),
          isCloudWalletEnabled,
          persistConfigEnv,
          createIntegrationTelemetrySpan: (args) =>
            createIntegrationTelemetrySpan({
              boundary: "wallet",
              operation: args.operation,
            }),
        },
        runtime: state.runtime ?? null,
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry, Agent self-status, Privy — delegated to agent-status-routes.ts
  // ═══════════════════════════════════════════════════════════════════════
  if (
    (pathname === "/api/agent/self-status" ||
      pathname.startsWith("/api/registry")) &&
    (await (async () => {
      const { RegistryService } = await import("./registry-service.ts");
      const getCoreWalletAddresses =
        pathname === "/api/agent/self-status"
          ? (await getCoreWalletApi()).getWalletAddresses
          : null;
      return handleAgentStatusRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state:
          pathname === "/api/agent/self-status"
            ? {
                ...state,
                config: createDevCloudConfigAuthorityView(state.config),
              }
            : state,
        json,
        error,
        readJsonBody,
        deps: {
          getWalletAddresses: getCoreWalletAddresses
            ? () => getCoreWalletAddresses(state.runtime?.agentId)
            : () => ({ evmAddress: null, solanaAddress: null }),
          resolveWalletCapabilityStatus,
          resolveWalletRpcReadiness,
          resolveTradePermissionMode,
          canUseLocalTradeExecution,
          detectRuntimeModel,
          resolveProviderFromModel,
          getAwarenessRegistry: (): AwarenessRegistryLike | null => {
            const service = state.runtime?.getService("AWARENESS_REGISTRY");
            if (!service || typeof service !== "object") return null;
            const composeSummary = (service as { composeSummary?: unknown })
              .composeSummary;
            if (typeof composeSummary !== "function") return null;
            return {
              composeSummary: (activeRuntime) =>
                Promise.resolve(composeSummary.call(service, activeRuntime)),
            };
          },
          RegistryService,
        },
      });
    })())
  ) {
    return;
  }

  if (
    await handleUpdateRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
    })
  ) {
    return;
  }

  if (
    await handleConnectorRoutes({
      req,
      res,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
      redactConfigSecrets,
      isBlockedObjectKey,
      hasBlockedObjectKeyDeep,
      cloneWithoutBlockedObjectKeys,
    })
  ) {
    return;
  }

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Moved to @elizaos/plugin-whatsapp setup-routes.ts (registered via Plugin.routes).

  // ── Notification + inbox routes (/api/notifications/*, /api/inbox/*) ──
  // Notifications: the unified notification center backed by the runtime
  // NotificationService (see api/notification-routes.ts). Inbox: a
  // cross-channel read-only feed that merges connector messages (imessage,
  // telegram, discord, whatsapp, etc.) into a single time-ordered view.
  let inboxCallerAuthorization: AgentHttpRequestAuthorization | undefined;
  if (pathname.startsWith("/api/inbox")) {
    const hostAuthorization = await resolveHostSessionAuthorization();
    inboxCallerAuthorization = resolveInboxRequestAuthorization(
      req,
      method,
      pathname,
      hostAuthorization,
    );
  }
  if (
    await handleInboxAndCloudRelayRouteGroup({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      inboxCallerAuthorization,
    })
  ) {
    return;
  }

  if (
    await handleAvatarRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
    })
  ) {
    return;
  }

  if (
    pathname === "/api/config" ||
    pathname === "/api/config/schema" ||
    pathname === "/api/config/reload"
  ) {
    if (
      await handleConfigRoutes({
        req,
        res,
        method,
        pathname,
        url,
        config: state.config,
        runtime: state.runtime,
        json,
        error,
        readJsonBody,
        redactConfigSecrets,
        isBlockedObjectKey,
        stripRedactedPlaceholderValuesDeep,
        patchTouchesProviderSelection,
        isBlockedEnvKey,
        CONFIG_WRITE_ALLOWED_TOP_KEYS,
        resolveMcpServersRejection,
        resolveMcpTerminalAuthorizationRejection,
      })
    ) {
      return;
    }
  }

  if (
    await handlePermissionsExtraRoutes({
      req,
      res,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
      resolveTradePermissionMode,
      canUseLocalTradeExecution,
      parseAgentAutomationMode,
      persistAgentAutomationMode,
    })
  ) {
    return;
  }

  if (
    await handlePermissionRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      saveConfig: (config) => {
        saveElizaConfig(config as ElizaConfig);
      },
      scheduleRuntimeRestart,
    })
  ) {
    return;
  }

  if (
    await handleRelationshipsRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime ?? undefined,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // Browser workspace routes (/api/browser-workspace/*) are served by the
  // @elizaos/app-browser plugin via Plugin.routes.

  // Agent self-status, Privy, and ERC-8004 registry routes are now handled
  // by handleAgentStatusRoutes above.

  // ═══════════════════════════════════════════════════════════════════════
  // BSC trade routes and wallet trade execute are handled by registered wallet
  // plugin routes when the relevant backend is installed.
  // ═══════════════════════════════════════════════════════════════════════

  if (
    isLifeOpsCloudPluginRoute(pathname) &&
    (await handleLifeOpsRuntimePluginRoute({
      req,
      res,
      method,
      pathname,
      url,
      state,
      isAuthorizedRequest: isAuthorized,
    }))
  ) {
    return;
  }

  if (
    await handleCloudAndCoreRouteGroup({
      req,
      res,
      method,
      pathname,
      state,
      restartRuntime,
      saveConfig: saveElizaConfig,
    })
  ) {
    return;
  }

  if (await handleSandboxRouteGroup({ req, res, method, pathname, state })) {
    return;
  }

  if (
    await handleConversationRouteGroup({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      callerAuthorization: isServerTokenAuthorized(req)
        ? {
            ok: true,
            role: "USER",
            principal: "shared-server-gateway",
          }
        : await resolveHostSessionAuthorization(),
    })
  ) {
    return;
  }

  if (await handleDatabaseRouteGroup({ req, res, pathname, state })) {
    return;
  }

  // Coding Agent API routes (/api/coding-agents/*, /api/workspace/*,
  // /api/issues/*) are now provided by the @elizaos/plugin-agent-orchestrator
  // plugin via the runtime route registry. Most of those paths genuinely need
  // the runtime, so a pre-runtime 503 is correct. The GET capability probes
  // below are the exception: they have graceful builtin probe handlers
  // (handleBuiltinOptionalRoutes → { available: false } / "unavailable"). The
  // dashboard polls /preflight the instant agentStatus flips to "running", which
  // can race ahead of state.runtime being assigned during a restart; serve those
  // from the builtin probe handler instead of a 503 the browser logs as a red console error.
  const isCodingAgentBuiltinProbe =
    pathname === "/api/coding-agents/preflight" ||
    pathname === "/api/coding-agents/coordinator/status";
  if (
    !state.runtime &&
    method === "GET" &&
    pathname.startsWith("/api/coding-agents") &&
    !isCodingAgentBuiltinProbe
  ) {
    error(res, "Coding agent runtime unavailable", 503);
    return;
  }

  if (
    await handleCloudStatusRoutes({
      req,
      res,
      method,
      pathname,
      config: createDevCloudConfigAuthorityView(state.config),
      runtime: state.runtime,
      json,
    })
  ) {
    return;
  }

  // ── App routes (/api/apps/*) ──────────────────────────────────────────
  if (pathname.startsWith("/api/apps")) {
    const { handleAppsRoutes } = await getAppManagerApi();
    const appManager = ctx?.getAppManager
      ? await ctx.getAppManager()
      : (state.appManager as AppManagerLike);
    const installPluginForApp = async (
      ...args: Parameters<typeof installPluginDirect>
    ) => {
      const result = await installPluginDirect(...args);
      if (result.success) {
        // The direct installer persists plugins.installs to eliza.json. Keep
        // this server's in-memory config aligned so the immediately-following
        // GET /api/apps/installed reflects a clean first install without
        // waiting for a process restart.
        state.config = loadElizaConfig();
      }
      return result;
    };
    // #12087 Item 13: single boundary-role collapse (no inline OWNER/GUEST ternary).
    const appActorRole: AppsRouteActorRole = resolveBoundaryRole(req);
    if (
      await handleAppsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        appManager: {
          listAvailable: (pluginManager) =>
            appManager.listAvailable(pluginManager),
          search: (pluginManager, query, limit) =>
            appManager.search(pluginManager, query, limit),
          listInstalled: (pluginManager) =>
            appManager.listInstalled(pluginManager),
          listRuns: (runtime) =>
            appManager.listRuns(
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          getRun: (runId, runtime) =>
            appManager.getRun(
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          attachRun: (runId, runtime) =>
            appManager.attachRun(
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          detachRun: (runId) => appManager.detachRun(runId),
          launch: (pluginManager, name, onProgress, runtime) =>
            appManager.launch(
              pluginManager,
              name,
              onProgress,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
              installPluginForApp,
            ),
          stop: (pluginManager, name, runId, runtime) =>
            appManager.stop(
              pluginManager,
              name,
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          recordHeartbeat: (runId) => appManager.recordHeartbeat(runId),
          startStaleRunSweeper: (getRuntime) =>
            appManager.startStaleRunSweeper(getRuntime),
          getInfo: (pluginManager, name) =>
            appManager.getInfo(pluginManager, name),
        } satisfies AppManagerLike,
        getPluginManager: () => getPluginManagerForState(state),
        parseBoundedLimit,
        readJsonBody,
        json,
        error,
        runtime: state.runtime,
        actorRole: appActorRole,
        favoriteApps: {
          read: () => readFavoriteAppsFromConfig(state.config),
          write: (apps) => writeFavoriteAppsToConfig(state.config, apps),
        } satisfies FavoriteAppsStore,
        installPluginDirect: installPluginForApp,
      })
    ) {
      return;
    }

    if (
      await handleAppPackageRoutes({
        req,
        res,
        method,
        pathname,
        url,
        readJsonBody,
        json,
        error,
        runtime: state.runtime,
      })
    ) {
      return;
    }
  }

  // ── Slash-command catalog (/api/commands) ─────────────────────────────────
  if (
    await handleCommandsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── Interaction reporting (/api/interactions/shortcut) ────────────────────
  if (
    await handleInteractionsRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── View routes (/api/views/*) ────────────────────────────────────────────
  const viewsCallerAuthorization = resolveInboxRequestAuthorization(
    req,
    method,
    pathname,
    await resolveHostSessionAuthorization(),
  );
  if (
    await handleViewsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      broadcastWs: state.broadcastWs ?? undefined,
      broadcastWsToClientId: state.broadcastWsToClientId ?? undefined,
      runtime: state.runtime,
      callerAuthorization: viewsCallerAuthorization,
    })
  ) {
    return;
  }

  // ── Runtime switch routes (/api/runtime/model-switch, /agent-switch) ──────
  const runtimeManagementCallerAuthorization = resolveInboxRequestAuthorization(
    req,
    method,
    pathname,
    await resolveHostSessionAuthorization(),
  );
  if (
    await handleRuntimeManagementRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
      broadcastWs: state.broadcastWs ?? undefined,
      broadcastWsToClientId: state.broadcastWsToClientId ?? undefined,
      callerAuthorization: runtimeManagementCallerAuthorization,
    })
  ) {
    return;
  }

  if (
    await handleRuntimeSwitchRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
      broadcastWs: state.broadcastWs ?? undefined,
    })
  ) {
    return;
  }

  if (pathname.startsWith("/api/workbench")) {
    if (
      await handleWorkbenchRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        toWorkbenchTodo,
        normalizeTags,
        readTaskMetadata,
        readTaskCompleted,
        parseNullableNumber,
        asObject,
        decodePathComponent,
        taskToTriggerSummary,
        listTriggerTasks,
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Life-ops routes: now served via lifeopsPlugin.routes (rawPath) on the
  // runtime plugin route system. See app-lifeops/src/routes/plugin.ts.
  // ═══════════════════════════════════════════════════════════════════════

  if (pathname.startsWith("/api/mcp")) {
    const { handleMcpRoutes } = await getOptionalPluginApi<{
      handleMcpRoutes: (args: unknown) => Promise<boolean>;
    }>("mcp");
    if (
      await handleMcpRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        // The MCP marketplace route tracks client disconnects until the
        // response write has actually been initiated. Keep these helpers
        // awaitable without changing the fire-and-forget behavior of the
        // other agent routes.
        json: (response: http.ServerResponse, data: unknown, status?: number) =>
          writeJsonResponse(response, data, status).catch((err) => {
            logger.warn(`[api] MCP JSON response write failed: ${err}`);
          }),
        error: (
          response: http.ServerResponse,
          message: string,
          status?: number,
        ) =>
          writeJsonError(response, message, status).catch((err) => {
            logger.warn(`[api] MCP JSON error response write failed: ${err}`);
          }),
        readJsonBody,
        saveElizaConfig,
        redactDeep,
        isBlockedObjectKey,
        cloneWithoutBlockedObjectKeys,
        resolveMcpServersRejection,
        resolveMcpTerminalAuthorizationRejection,
        decodePathComponent,
      })
    ) {
      return;
    }
  }

  if (
    await handleMiscRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      AGENT_EVENT_ALLOWED_STREAMS,
      resolveTerminalRunRejection,
      resolveTerminalRunClientId,
      isSharedTerminalClientId,
      activeTerminalRunCount,
      setActiveTerminalRunCount: (delta: number) => {
        activeTerminalRunCount = Math.max(0, activeTerminalRunCount + delta);
      },
      tryAcquireTerminalRunSlot: (
        scopeId: string,
        runId: string,
        maxConcurrent: number,
      ) => {
        const now = Date.now();
        if (
          now - lastTerminalRunIdSweepAt >= TERMINAL_RUN_ID_SWEEP_INTERVAL_MS ||
          terminalRunIdReservations.size >= MAX_TERMINAL_RUN_ID_RESERVATIONS
        ) {
          for (const [reservedRunId, expiresAt] of terminalRunIdReservations) {
            if (expiresAt <= now) {
              terminalRunIdReservations.delete(reservedRunId);
            }
          }
          lastTerminalRunIdSweepAt = now;
        }
        const reservationKey = `${scopeId}\0${runId}`;
        if (terminalRunIdReservations.has(reservationKey)) {
          return { rejection: "duplicate" as const };
        }
        if (activeTerminalRunCount >= maxConcurrent) {
          return { rejection: "capacity" as const };
        }
        if (
          terminalRunIdReservations.size >= MAX_TERMINAL_RUN_ID_RESERVATIONS
        ) {
          return { rejection: "registry-capacity" as const };
        }
        terminalRunIdReservations.set(
          reservationKey,
          now + TERMINAL_RUN_ID_RESERVATION_TTL_MS,
        );
        activeTerminalRunCount += 1;
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            activeTerminalRunCount = Math.max(0, activeTerminalRunCount - 1);
          },
        };
      },
    })
  ) {
    return;
  }

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Extracted to @elizaos/plugin-whatsapp setup-routes.ts (Plugin.routes).

  // ── elizaOS plugin HTTP routes (runtime.routes, e.g. /music-player/*) ───
  const runtimeRouteConfig = pathname.startsWith("/api/cloud/")
    ? materializeDevCloudConfigAuthorityView(
        createDevCloudConfigAuthorityView(state.config),
      )
    : state.config;
  if (
    await tryHandleRuntimePluginRoute({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      isAuthorized: () => hostSessionAuthorization.ok || isAuthorized(req),
      hostContext: {
        config: runtimeRouteConfig as Record<string, unknown>,
        saveConfig: (nextConfig) => {
          const persistable = nextConfig as ElizaConfig;
          saveElizaConfig(persistable);
          state.config = persistable;
        },
        restartRuntime,
      },
    })
  ) {
    return;
  }

  if (
    await handleBuiltinOptionalRoutes(
      req,
      res,
      pathname,
      method,
      state.runtime?.agentId,
    )
  ) {
    return;
  }

  // ── Connector plugin routes (dynamically registered) ────────────────────
  for (const handler of state.connectorRouteHandlers) {
    const handled = await handler(req, res, pathname, method);
    if (handled) return;
  }

  if (await handleMobileOptionalRoutes(req, res, pathname, method)) {
    return;
  }

  // ── LifeOps inbox compatibility fallback ────────────────────────────────
  // The inbox view is bundled independently from the PA-owned inbox cache
  // route. When PA is absent, serve an empty wire payload instead of a 404 loop.
  if (
    await tryHandleLifeOpsInboxFallbackLazy({
      pathname,
      method,
      url,
      res,
    })
  ) {
    return;
  }

  // ── Trajectory read routes (owned by core TrajectoriesService) ──────────
  // Serves GET /api/trajectories[/:id|/stats] from the core TrajectoriesService
  // so the realtime trajectory viewer works from the core service on every
  // platform.
  if (
    await tryHandleTrajectoryReadRoutes({
      pathname,
      method,
      url,
      runtime: state.runtime,
      res,
    })
  ) {
    return;
  }

  // ── Hono adapter for runtime.routes with `routeHandler` (new shape) ─────
  // Covers any plugin route registered via the new return-shape RouteHandler
  // contract. Legacy Express-shaped `handler` routes are still served by
  // `tryHandleRuntimePluginRoute` above.
  if (
    await tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime: state.runtime,
      // Mirror the outer 401 gate: a registered boundary-role viewer (e.g. an
      // artifact share-viewer token, #14781) is authorized for its in-scope
      // routes, so the dispatch-level re-check must accept it too — otherwise
      // resolver-authorized requests pass the outer gate and 401 in dispatch.
      isAuthorized: () =>
        hostSessionAuthorization.ok ||
        isAuthorized(req) ||
        isBoundaryRoleAuthorized(req, method, pathname),
      isTrustedLocal: () => isTrustedLocalRequest(req),
      // Session admission and disclosure share the verified host principal.
      // Only trusted local requests retain the plugin's local-owner fallback.
      accessContext: () => {
        if (hostSessionAuthorization.ok && state.runtime) {
          return resolveHostSessionAccessContext(
            hostSessionAuthorization,
            state.runtime,
          );
        }
        if (isTrustedLocalRequest(req)) return undefined;
        const boundaryAccess = resolveHttpAccessContext(req);
        if (boundaryAccess) return boundaryAccess;
        // Direct owner API credentials retain their principal at plugin routes.
        // Gateway admission alone never grants owner document access.
        if (
          state.runtime &&
          isAuthorized(req) &&
          !isServerTokenAuthorized(req)
        ) {
          return {
            requesterEntityId: resolveOwnerEntityIdOrDefault(state.runtime),
            role: "OWNER",
            isOwner: true,
            source: "owner-api-token",
          };
        }
        return undefined;
      },
    })
  ) {
    return;
  }

  // ── Fallback ────────────────────────────────────────────────────────────
  error(res, "Not found", 404);
}

// ---------------------------------------------------------------------------
// Early log capture — re-exported from the standalone module so existing
// callers that `import { captureEarlyLogs } from "../../../../src/api/server"` keep
// working.  The implementation lives in `./early-logs.ts` to avoid pulling
// the entire server dependency graph into lightweight consumers (e.g. the
// headless `startEliza()` path).
// ---------------------------------------------------------------------------
import {
  type captureEarlyLogs,
  flushEarlyLogs,
  listenForUiLogs,
} from "./early-logs.ts";

export type { captureEarlyLogs };

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

export type ApiRequestMiddleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => Promise<void>,
) => Promise<void>;

export type ApiServerConfigurator = (
  server: http.Server,
) => void | Promise<void>;

export type WebSocketAuthorizer = (
  request: http.IncomingMessage,
  url: URL,
) => boolean | Promise<boolean>;

function strictPortBindingEnabled(): boolean {
  const value = process.env.ELIZA_API_STRICT_PORT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export async function startApiServer(opts?: {
  port?: number;
  runtime?: AgentRuntime;
  skipDeferredStartupWork?: boolean;
  /**
   * Skip binding a TCP listener. The HTTP `server` object, all routes, and the
   * in-process `dispatchRoute` kernel are still fully wired up — only
   * `server.listen(...)` is not called, so the process opens no port. Used by
   * local-agent IPC transports (stdio bridge / Capacitor / Electrobun RPC) that
   * reach the route kernel without an HTTP socket. Unset/false → identical to
   * the current listening behavior.
   */
  skipListen?: boolean;
  /** Initial state when starting without a runtime (e.g. embedded startup flow). */
  initialAgentState?: "not_started" | "starting" | "stopped" | "error";
  /**
   * Called when the UI requests a restart via `POST /api/agent/restart`.
   * Should stop the current runtime, create a new one, and return it.
   * If omitted the endpoint returns 501 (not supported in this mode).
   */
  onRestart?: (options?: RuntimeRestartOptions) => Promise<AgentRuntime | null>;
  /** Runs after the server atomically publishes the replacement runtime. */
  onRuntimeActivated?: (
    previousRuntime: AgentRuntime | null,
    activeRuntime: AgentRuntime,
  ) => void | Promise<void>;
  /**
   * Runs at the HTTP boundary before the built-in route dispatcher. Hosts use
   * this to add product-specific routes without mutating Node's global HTTP
   * factory or duplicating the agent server.
   */
  requestMiddleware?: ApiRequestMiddleware;
  /**
   * Configures the concrete HTTP server before it starts listening. This is
   * intended for protocol extensions such as WebSocket upgrade handlers.
   */
  configureServer?: ApiServerConfigurator;
  /**
   * Lets a host recognize credentials it owns before the dashboard WebSocket
   * is admitted. The agent server still owns origin/path checks, pending-socket
   * limits, and its static-token fallback; this hook only adds an authenticated
   * principal such as app-core's revocable machine session.
   */
  authorizeWebSocket?: WebSocketAuthorizer;
}): Promise<{
  port: number;
  close: () => Promise<void>;
  updateRuntime: (rt: AgentRuntime) => void;
  updateStartup: (
    update: Partial<AgentStartupDiagnostics> & {
      phase?: string;
      attempt?: number;
      state?: ServerState["agentState"];
    },
  ) => void;
}> {
  const apiStartTime = Date.now();
  // Gated boot profiler (off unless ELIZA_BOOT_PROFILE=1) to time the API-bind
  // critical path. Stderr, since the structured logger level may suppress it.
  const apiLap = (label: string): void => {
    if (process.env.ELIZA_BOOT_PROFILE === "1") {
      process.stderr.write(
        `[boot-profile] api:${label} +${Date.now() - apiStartTime}ms\n`,
      );
    }
  };
  logger.debug(`[eliza-api] startApiServer called`);

  // Honor ELIZA_API_PORT first (set by the desktop launcher → 31337) so
  // the renderer's hardcoded API base reaches this server. CLI-mode
  // (no ELIZA_API_PORT) keeps the legacy `resolveServerOnlyPort` default
  // of 2138, so this change is transparent for non-desktop users.
  const port =
    opts?.port ??
    (readAliasedEnv("ELIZA_API_PORT")
      ? resolveDesktopApiPort(process.env)
      : resolveServerOnlyPort(process.env));
  const host = resolveApiBindHost(process.env);
  ensureApiTokenForBindHost(host);
  // Resolve owner configuration before any HTTP server is created or bound.
  // The monitor itself starts later, but its deferred catch must never turn a
  // malformed interval into a healthy-looking default.
  const connectorHealthIntervalMs = resolveConnectorHealthIntervalMs(
    process.env.CONNECTOR_HEALTH_INTERVAL_MS,
  );
  logger.debug(`[eliza-api] Token check done (${Date.now() - apiStartTime}ms)`);

  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // error-policy:J2 only a genuinely absent config is first-run state;
      // malformed or unreadable configuration must fail API startup.
      throw new ElizaError("Failed to load agent API configuration", {
        code: "AGENT_CONFIG_LOAD_FAILED",
        cause: err,
        severity: "fatal",
      });
    }
    logger.info("[eliza-api] No config found; starting in first-run mode");
    config = {} as ElizaConfig;
  }
  logger.debug(`[eliza-api] Config loaded (${Date.now() - apiStartTime}ms)`);

  // Wallet/inventory routes read from process.env at request-time.
  // Hydrate persisted config.env values so addresses remain visible after restarts.
  const persistedEnv = config.env as Record<string, string> | undefined;
  const envKeysToHydrate = [
    "ELIZA_WALLET_OS_STORE",
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "ALCHEMY_API_KEY",
    "INFURA_API_KEY",
    "ANKR_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
    "SOLANA_RPC_URL",
  ] as const;
  for (const key of envKeysToHydrate) {
    const value = persistedEnv?.[key];
    if (typeof value === "string" && value.trim() && !process.env[key]) {
      process.env[key] = value.trim();
    }
  }

  // Optional auto-provision mode for legacy environments. Disabled by default
  // so startup does not silently create new wallets when keys are missing.
  const walletAutoProvisionRaw =
    process.env.ELIZA_WALLET_AUTO_PROVISION?.trim().toLowerCase();
  const walletAutoProvisionEnabled =
    walletAutoProvisionRaw === "1" ||
    walletAutoProvisionRaw === "true" ||
    walletAutoProvisionRaw === "on" ||
    walletAutoProvisionRaw === "yes";
  if (walletAutoProvisionEnabled && ensureWalletKeysInEnvAndConfig(config)) {
    try {
      saveElizaConfig(config);
    } catch (err) {
      logger.warn(
        `[eliza-api] Failed to persist generated wallet keys: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const blockOnStewardWalletCache =
    process.env.ELIZA_STEWARD_WALLET_CACHE_BLOCKING?.trim() === "1";
  if (blockOnStewardWalletCache) {
    // Cloud/provisioned environments can opt into strict startup semantics
    // when wallet addresses must be available before the first request.
    const { initStewardWalletCache } = await getCoreWalletApi();
    await initStewardWalletCache();
  }

  // Warn when wallet private keys live in plaintext config and the OS secure
  // store is not enabled.  This nudges operators toward ELIZA_WALLET_OS_STORE=1.
  {
    const hasPlaintextKeys =
      (typeof persistedEnv?.EVM_PRIVATE_KEY === "string" &&
        persistedEnv.EVM_PRIVATE_KEY.trim()) ||
      (typeof persistedEnv?.SOLANA_PRIVATE_KEY === "string" &&
        persistedEnv.SOLANA_PRIVATE_KEY.trim());
    const osStoreRaw = process.env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
    const osStoreEnabled =
      osStoreRaw === "1" ||
      osStoreRaw === "true" ||
      osStoreRaw === "on" ||
      osStoreRaw === "yes";
    if (hasPlaintextKeys && !osStoreEnabled) {
      logger.warn(
        "[wallet] Private keys are stored in plaintext config. " +
          "Set ELIZA_WALLET_OS_STORE=1 to use the OS secure store instead.",
      );
    }
  }

  const plugins = discoverPluginsFromManifest();
  logger.debug(
    `[eliza-api] Plugins discovered (${Date.now() - apiStartTime}ms)`,
  );
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();

  const state = createServerState({
    config,
    runtime: opts?.runtime,
    initialAgentState: opts?.initialAgentState,
    plugins,
    deletedConversationIds: readDeletedConversationIdsFromState(),
    resolveAgentName: resolveDefaultAgentName,
    detectRuntimeModel,
    resolveAgentAutomationMode: resolveAgentAutomationModeFromConfig,
    resolveTradePermissionMode,
  });
  const ensureAppManager = async (): Promise<AppManagerLike> => {
    if (state.appManager) {
      return state.appManager as AppManagerLike;
    }
    const { AppManager } = await getAppManagerApi();
    const appManager = new AppManager();
    state.appManager = appManager;
    return appManager as AppManagerLike;
  };
  const configuredAdminEntityId = config.agents?.defaults?.adminEntityId;
  if (configuredAdminEntityId && isUuidLike(configuredAdminEntityId)) {
    state.adminEntityId = configuredAdminEntityId;
    state.chatUserId = state.adminEntityId;
  } else if (configuredAdminEntityId) {
    logger.warn(
      `[eliza-api] Ignoring invalid agents.defaults.adminEntityId "${configuredAdminEntityId}"`,
    );
  }

  const addLog = (
    level: string,
    message: string,
    source = "system",
    tags: string[] = [],
  ) => {
    let resolvedSource = source;
    if (source === "auto" || source === "system") {
      const bracketMatch = /^\[([^\]]+)\]\s*/.exec(message);
      if (bracketMatch) resolvedSource = bracketMatch[1];
    }
    // Auto-tag based on source when no explicit tags provided
    const resolvedTags =
      tags.length > 0
        ? tags
        : resolvedSource === "runtime" || resolvedSource === "autonomy"
          ? ["agent"]
          : resolvedSource === "api" || resolvedSource === "websocket"
            ? ["server"]
            : resolvedSource === "cloud"
              ? ["server", "cloud"]
              : ["system"];
    state.logBuffer.push({
      timestamp: Date.now(),
      level,
      message,
      source: resolvedSource,
      tags: resolvedTags,
    });
  };

  addLog(
    "info",
    `Discovered ${plugins.length} plugins, loading skills in background`,
    "system",
    ["system", "plugins"],
  );

  let providerCacheWarmupPromise: Promise<void> | null = null;

  let detachApiLogListener: (() => void) | null = null;
  const captureStructuredLog = (entry: LogEntry): void => {
    addLog(entry.level, entry.message, entry.source, entry.tags);
  };

  // Store the restart callback on the state so the route handler can access it.
  const onRestart = opts?.onRestart ?? null;
  const onRuntimeActivated = opts?.onRuntimeActivated;

  logger.debug(
    `[eliza-api] Creating http server (${Date.now() - apiStartTime}ms)`,
  );
  apiLap("pre-createServer (route imports + middleware setup done)");
  const routeKernel = createRouteKernel({
    dispatch: async (req, res) => {
      const dispatch = () =>
        handleRequest(req, res, state, {
          onRestart,
          onRuntimeActivated,
          onRuntimeSwapped: () => {
            bindInProcessApi();
            bindRuntimeStreams(state.runtime);
            wireModelRegistrationBroadcast(state.runtime);
            wireNativeBrowserPageReader(state.runtime);
            void wireCoordinatorBridgesWhenReady(state, {
              wireChatBridge: wireCodingAgentChatBridge,
              wireWsBridge: wireCodingAgentWsBridge,
              wireEventRouting: wireCoordinatorEventRouting,
              wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
              context: "restart",
              logger,
            });
          },
          getAppManager: ensureAppManager,
        });
      if (opts?.requestMiddleware) {
        await opts.requestMiddleware(req, res, dispatch);
      } else {
        await dispatch();
      }
    },
    translateFailure: (err, _req, res) => {
      const msg = err instanceof Error ? err.message : "internal error";
      logger.error({ err }, `[eliza-api] Request handler failed: ${msg}`);
      addLog("error", msg, "api", ["server", "api"]);
      error(res, msg, 500);
    },
  });
  let unregisterInProcessApi: (() => void) | undefined;
  const bindInProcessApi = () => {
    unregisterInProcessApi?.();
    unregisterInProcessApi =
      opts?.skipListen && state.runtime
        ? registerInProcessApi(state.runtime, routeKernel)
        : undefined;
  };
  bindInProcessApi();
  const server = http.createServer((req, res) => routeKernel.handle(req, res));
  await opts?.configureServer?.(server);
  // W9-AGENT-01: the WS upgrade handler delegates the device-bridge path to
  // the capacitor bridge's own upgrade listener, so that delegation is only
  // safe once such a listener has REALLY attached here. A settled attach
  // promise is not proof of that: an optional-plugin import rejection resolves
  // through the no-op fallback API, and the bridge attach itself returns early
  // when the bridge is disabled for the platform — in both cases nothing is
  // listening. Use the bridge's explicit attachment result; listener counts
  // are process-global observations and can be changed by unrelated features.
  let deviceBridgeUpgradeHandlerAttached = false;
  let deviceBridgeAttachAllowed = !opts?.skipListen;
  server.once("close", () => {
    // The optional plugin import is deliberately deferred beyond bind. If the
    // server closes before it resolves, do not attach the process-global bridge
    // to a dead server and prevent a replacement API server from acquiring it.
    deviceBridgeAttachAllowed = false;
    deviceBridgeUpgradeHandlerAttached = false;
  });
  if (
    deviceBridgeAttachAllowed &&
    (isMobilePlatform() ||
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1")
  ) {
    // Defer to a macrotask: resolving @elizaos/plugin-capacitor-bridge (and its
    // device-bridge attach) measured ~15s of blocking on the mobile bundle and
    // — because it sat on the synchronous pre-`server.listen` path — held the
    // whole API bind (and the boot screen) hostage for that entire time (#11903).
    // The bridge only needs to attach a WS upgrade handler to the server object,
    // which works fine once the server is already listening.
    setImmediate(() => {
      void getOptionalPluginApi<{
        attachMobileDeviceBridgeToServer: (
          server: http.Server,
        ) => Promise<boolean>;
      }>("capacitor")
        .then(({ attachMobileDeviceBridgeToServer }) => {
          if (!deviceBridgeAttachAllowed) return false;
          return attachMobileDeviceBridgeToServer(server);
        })
        .then((attached) => {
          if (deviceBridgeAttachAllowed) {
            deviceBridgeUpgradeHandlerAttached = attached === true;
          }
        })
        .catch((err: unknown) => {
          logger.warn(
            "[eliza-api] Failed to attach mobile device bridge:",
            err instanceof Error ? err.message : String(err),
          );
        });
    });
  }
  logger.debug(`[eliza-api] Server created (${Date.now() - apiStartTime}ms)`);

  // requestTimeout bounds receipt of the request body; Node does not apply it
  // to time spent generating the response. Keep that slow-upload protection
  // while leaving the idle socket deadline disabled for long model turns.
  // Generation itself is cancelled by the request owner's AbortSignal.
  server.requestTimeout = 300_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 60_000;
  server.timeout = 0;
  logger.debug(
    "[eliza-api] Server lifecycle: requestTimeout=300000ms, idleTimeout=disabled, headersTimeout=60000ms, keepAliveTimeout=60000ms",
  );

  const wsClients = new Set<WebSocket>();
  const wsClientIds = new WeakMap<WebSocket, string>();
  const wsActiveConversations = new WeakMap<WebSocket, string>();
  const eventHub = createApiEventHub({
    state,
    clients: wsClients,
    clientIds: wsClientIds,
    activeConversations: wsActiveConversations,
    reportSendError: (err) => {
      logger.error(
        `[eliza-api] WebSocket send error: ${err instanceof Error ? err.message : err}`,
      );
    },
  });
  const broadcastWs = eventHub.broadcast;
  const pushEvent = eventHub.publish;

  let detachRuntimeStreams: (() => void) | null = null;
  const bindRuntimeStreams = (runtime: AgentRuntime | null) => {
    if (detachRuntimeStreams) {
      detachRuntimeStreams();
      detachRuntimeStreams = null;
    }
    let active = true;
    const unsubscribe: Array<() => void> = [];
    detachRuntimeStreams = () => {
      active = false;
      for (const detach of unsubscribe) detach();
    };

    // Registration is lazy: a synchronous lookup can miss the service at
    // startup. Bind each runtime once it loads, and detach on swap or close.
    if (runtime?.hasService("connector-setup")) {
      void runtime
        .getServiceLoadPromise("connector-setup")
        .then((service) => {
          if (!active) return;
          const setup = service as ConnectorSetupServiceInstance;
          setup.setBroadcastWs(broadcastWs);
          unsubscribe.push(() => setup.setBroadcastWs(null));
        })
        .catch((error) => runtime.reportError("api.connectorBroadcast", error));
    }
    const svc = getAgentEventSvc(runtime);
    if (!svc) {
      if (runtime) {
        logger.warn(
          "[eliza-api] AGENT_EVENT service not found on runtime — event streaming will be unavailable",
        );
      }
      return;
    }

    const unsubAgentEvents = svc.subscribe((event) => {
      pushEvent({
        type: "agent_event",
        ts: event.ts,
        runId: event.runId,
        seq: event.seq,
        stream: event.stream,
        sessionKey: event.sessionKey,
        agentId: event.agentId,
        roomId: event.roomId,
        payload: event.data,
      });

      void maybeRouteAutonomyEventToConversation(state, event).catch((err) => {
        logger.warn(
          `[autonomy-route] Failed to route proactive event: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    const unsubHeartbeat = svc.subscribeHeartbeat((event) => {
      pushEvent({
        type: "heartbeat_event",
        ts: event.ts,
        payload: event,
      });
    });

    unsubscribe.push(unsubAgentEvents, unsubHeartbeat);
  };

  // ── Deferred startup work (non-blocking) ────────────────────────────────
  // Keep API startup fast: listen first, then warm optional subsystems.
  const startDeferredStartupWork = async (): Promise<void> => {
    providerCacheWarmupPromise ??= getOrFetchAllProviders()
      .then(() => undefined)
      .catch((err) => {
        // error-policy:J7 Background catalog discovery must not stop the API host.
        logger.warn("[api] Provider cache warm-up failed:", err);
        if (opts?.runtime)
          opts.runtime.reportError("api.providerCacheWarmup", err);
      });

    void registerBuiltinViews(state.runtime).catch((err) => {
      logger.warn(
        `[eliza-api] Built-in view registration failed after listen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    void ensureAppManager()
      .then((appManager) => {
        // Stop app runs whose UI heartbeat has gone silent.
        appManager.startStaleRunSweeper(() => state.runtime);
      })
      .catch((err) => {
        logger.warn(
          `[eliza-api] App manager startup work failed after listen: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    if (!blockOnStewardWalletCache) {
      void getCoreWalletApi()
        .then(({ initStewardWalletCache }) => initStewardWalletCache())
        .catch((err) => {
          logger.debug(
            `[eliza-api] Steward wallet cache init failed after listen: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    void (async () => {
      try {
        const { discoverSkills } = await getAgentSkillsApi();
        const discoveredSkills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );
        state.skills = discoveredSkills;
        addLog(
          "info",
          `Discovered ${discoveredSkills.length} skills`,
          "system",
          ["system", "plugins"],
        );
      } catch (err) {
        logger.warn(
          `[eliza-api] Skill discovery failed during startup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    // ── Connector health monitoring ──────────────────────────────────────────
    if (state.runtime && state.config.connectors) {
      try {
        state.connectorHealthMonitor = await createConnectorHealthMonitor({
          runtime: state.runtime,
          config: state.config,
          broadcastWs,
          intervalMs: connectorHealthIntervalMs,
        });
        state.connectorHealthMonitor.start();
      } catch (err) {
        logger.warn(
          `[eliza-api] Connector health monitor failed after listen: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  // ── WebSocket Server ─────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // A server-level 'error' with no listener crashes the process. Abrupt client
  // disconnects (RST during/after the upgrade handshake) surface here.
  wss.on("error", (err: unknown) => {
    logger.warn(
      `[eliza-api] WebSocketServer error: ${err instanceof Error ? err.message : err}`,
    );
  });
  /**
   * Per-connection active conversation. Each browser window/client owns its own
   * active conversation, so two windows no longer fight over a single global.
   * `state.activeConversationId` is kept as the "most recent active conversation"
   * default for code paths that legitimately need *any* active conversation
   * (autonomy routing, swarm synthesis) and don't target a specific client.
   */
  /** Per-WS-client PTY output subscriptions: sessionId → unsubscribe */
  const wsClientPtySubscriptions = new WeakMap<
    WebSocket,
    Map<string, () => void>
  >();
  /**
   * Grace-window reap timers for disconnected PTY owners, keyed by clientId.
   * A WS close/error no longer kills the client's PTY sessions instantly —
   * phone lock, app switch, or a network blip would otherwise nuke a live
   * interactive terminal. The stop is delayed by the grace window and
   * canceled when the same clientId re-authenticates (ownership survives
   * reconnects because sessions are owned by clientId, not by socket).
   */
  const wsPtyPendingStops = new Map<string, ReturnType<typeof setTimeout>>();
  const wsPtyDisconnectGraceMs = resolvePtyDisconnectGraceMs(
    process.env.ELIZA_PTY_WS_DISCONNECT_GRACE_MS,
  );
  /**
   * Short-window idempotency cache for client-tagged WS messages, keyed by
   * `${clientId}:${msgId}`. A message resent after a reconnect (same id) is
   * dropped if seen within the TTL. Entries expire so the map stays bounded.
   */
  const wsSeenMessageIds = new Map<string, number>();
  const WS_DEDUPE_TTL_MS = 30_000;
  let wsSeenLastSweepAt = 0;
  const isDuplicateWsMessage = (
    clientId: string | undefined,
    msgId: unknown,
  ): boolean => {
    if (typeof msgId !== "string" || msgId.length === 0) return false;
    const key = `${clientId ?? "anon"}:${msgId}`;
    const now = Date.now();
    // O(1) TTL-aware dedupe: a still-fresh entry means this id was already seen
    // within the window. Correctness no longer depends on first scanning the
    // whole map — the previous full-scan-on-every-message was O(n) per message
    // (O(n^2) under a burst).
    const seenAt = wsSeenMessageIds.get(key);
    if (seenAt !== undefined && now - seenAt <= WS_DEDUPE_TTL_MS) return true;
    wsSeenMessageIds.set(key, now);
    // Amortized eviction: sweep expired entries at most once per TTL window
    // instead of on every message; keeps the map bounded without the per-
    // message scan.
    if (now - wsSeenLastSweepAt > WS_DEDUPE_TTL_MS) {
      wsSeenLastSweepAt = now;
      for (const [seenKey, ts] of wsSeenMessageIds) {
        if (now - ts > WS_DEDUPE_TTL_MS) wsSeenMessageIds.delete(seenKey);
      }
    }
    return false;
  };
  bindRuntimeStreams(opts?.runtime ?? null);

  // Wire coding-agent bridges at initial boot (event-driven via getServiceLoadPromise)
  if (opts?.runtime) {
    void wireCoordinatorBridgesWhenReady(state, {
      wireChatBridge: wireCodingAgentChatBridge,
      wireWsBridge: wireCodingAgentWsBridge,
      wireEventRouting: wireCoordinatorEventRouting,
      wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
      context: "boot",
      logger,
    });
  }

  // The device-bridge WebSocket endpoint delegates authentication to the
  // capacitor bridge's own upgrade handler (a pairing-token check that closes
  // unauthorized sockets with 4001). That delegation is only valid when the
  // bridge can actually be attached: the plugin refuses to attach without a
  // pairing token, so with none configured nothing is listening on the path —
  // fall through to the standard upgrade rejection instead of skipping auth
  // and leaving the socket unanswered (W1-011). The same fail-closed rule
  // applies when delegation is EXPECTED but the deferred attach never landed
  // a listener — an import rejection resolves through the no-op fallback API
  // and a failed attach only logs, so an unconditional early return would
  // leave the raw pre-auth socket unanswered indefinitely, outside the
  // W5-015 pending-socket cap and auth grace period (W9-AGENT-01).
  const isDeviceBridgeDelegationExpected = (): boolean => {
    if (
      !isMobilePlatform() &&
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() !== "1"
    ) {
      return false;
    }
    // Mirrors the pairing-token env contract enforced by
    // @elizaos/plugin-capacitor-bridge's attachMobileDeviceBridgeToServer.
    return Boolean(
      process.env.ELIZA_DEVICE_PAIRING_TOKEN?.trim() ||
        process.env.ELIZA_DEVICE_BRIDGE_TOKEN?.trim(),
    );
  };

  // Requests authenticated by the host hook must remain authenticated when
  // `ws` emits its later connection event. IncomingMessage identity is stable
  // across handleUpgrade, and WeakSet avoids retaining completed requests.
  const hostAuthorizedWebSocketRequests = new WeakSet<http.IncomingMessage>();

  // Handle upgrade requests for WebSocket
  // Async: the handshake-bearer session lookup below awaits the host's
  // session store. Every throw lands inside the try/catch, so the listener's
  // returned promise never rejects unobserved.
  server.on("upgrade", async (request, socket, head) => {
    // The raw upgrade socket can emit 'error' (client RST mid-handshake) before
    // a WebSocket — and its error handler — exists. Unhandled, it crashes the
    // process. Attach a no-op-ish guard for the whole upgrade window.
    socket.on("error", (err: unknown) => {
      logger.warn(
        `[eliza-api] WS upgrade socket error: ${err instanceof Error ? err.message : err}`,
      );
      try {
        socket.destroy();
      } catch {
        // error-policy:J6 best-effort teardown — the socket may already be
        // destroyed after the failed upgrade; nothing more to do.
      }
    });
    try {
      const wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (
        wsUrl.pathname === "/api/local-inference/device-bridge" &&
        isDeviceBridgeDelegationExpected() &&
        deviceBridgeUpgradeHandlerAttached
      ) {
        return;
      }
      let rejection = resolveWebSocketUpgradeRejection(request, wsUrl);
      if (rejection?.status === 401) {
        // Device pairing mints a revocable machine-session id as the client's
        // bearer — never the static connection key (#13985) — so the static
        // check above cannot recognize a paired device. Before letting the
        // 401 stand, resolve the presented handshake bearer through the same
        // host-bridge session seam REST uses. Fail-closed: an absent token or
        // an unknown/expired/revoked session keeps the rejection.
        const handshakeToken = extractWebSocketHandshakeToken(request, wsUrl);
        if (handshakeToken) {
          // The session lookup is asynchronous store work, so it must sit
          // behind the same per-peer pre-auth admission cap as post-open
          // authentication — otherwise repeated invalid bearers from one
          // remote could fan out unbounded concurrent store lookups. The
          // slot is held only for the lookup itself; the pre-auth socket
          // flow below re-acquires its own longer-lived slot.
          const lookupPeer = request.socket.remoteAddress ?? null;
          if (!tryAcquirePendingWebSocket(lookupPeer)) {
            rejectWebSocketUpgrade(
              socket,
              401,
              "Too many unauthenticated WebSocket connections",
            );
            return;
          }
          try {
            if (
              await isWebSocketSessionTokenAuthorized(
                handshakeToken,
                state.runtime,
              )
            ) {
              markWebSocketUpgradeSessionAuthorized(request);
              rejection = null;
            }
          } finally {
            releasePendingWebSocket(lookupPeer);
          }
        }
      }
      if (rejection) {
        rejectWebSocketUpgrade(socket, rejection.status, rejection.reason);
        return;
      }
      // The session lookup above yields to the event loop; the client may
      // have gone away in the meantime. Bail before reserving a pre-auth
      // slot that no connection handler would ever release.
      if (socket.destroyed) {
        return;
      }
      // W5-015: an upgrade without handshake credentials is allowed so the
      // client can authenticate post-open, but concurrent pre-auth sockets
      // are capped per peer — an unbounded accept was a remote FD-exhaustion
      // DoS. The slot releases when the socket authenticates or closes (see
      // the connection handler), or in the catch below if the upgrade fails.
      let pendingWsPeer: string | null | undefined;
      const staticallyAuthorized = isWebSocketAuthorized(request, wsUrl);
      const sessionAuthorized = isWebSocketUpgradeSessionAuthorized(request);
      let hostAuthorized = false;
      if (
        !staticallyAuthorized &&
        !sessionAuthorized &&
        opts?.authorizeWebSocket
      ) {
        try {
          hostAuthorized = await opts.authorizeWebSocket(request, wsUrl);
        } catch (error) {
          // error-policy:J1 host authentication is an outer protocol boundary:
          // fail closed for that credential and retain the bounded post-open
          // static-token flow instead of crashing the server.
          logger.error(
            `[eliza-api] host WebSocket authorization failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (hostAuthorized) {
        hostAuthorizedWebSocketRequests.add(request);
      }
      if (!staticallyAuthorized && !sessionAuthorized && !hostAuthorized) {
        const peer = request.socket.remoteAddress ?? null;
        if (!tryAcquirePendingWebSocket(peer)) {
          rejectWebSocketUpgrade(
            socket,
            401,
            "Too many unauthenticated WebSocket connections",
          );
          return;
        }
        pendingWsPeer = peer;
      }
      try {
        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          // Attach an 'error' listener IMMEDIATELY — before emit('connection')
          // runs the (long) connection handler that only attaches its own error
          // listener near the end. A client that RSTs in that window otherwise
          // emits an unhandled 'error' on the ws and crashes the process.
          ws.on("error", (err: unknown) => {
            logger.warn(
              `[eliza-api] WebSocket error: ${err instanceof Error ? err.message : err}`,
            );
          });
          wss.emit("connection", ws, request);
        });
      } catch (upgradeErr) {
        hostAuthorizedWebSocketRequests.delete(request);
        // error-policy:J2 release the reserved pre-auth slot, then rethrow
        // unchanged into the outer boundary handler.
        if (pendingWsPeer !== undefined) {
          releasePendingWebSocket(pendingWsPeer);
        }
        throw upgradeErr;
      }
    } catch (err) {
      hostAuthorizedWebSocketRequests.delete(request);
      logger.error(
        `[eliza-api] WebSocket upgrade error: ${err instanceof Error ? err.message : err}`,
      );
      rejectWebSocketUpgrade(socket, 404, "Not found");
    }
  });

  // Handle WebSocket connections
  wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
    let wsClientId: string | null = null;
    let wsUrl: URL;
    try {
      wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const clientId = normalizeWsClientId(wsUrl.searchParams.get("clientId"));
      if (clientId) {
        wsClientId = clientId;
        wsClientIds.set(ws, clientId);
      }
    } catch {
      // Ignore malformed WS URL metadata; auth/path were already validated.
      wsUrl = new URL("ws://localhost/ws");
    }

    const hostAuthorized = hostAuthorizedWebSocketRequests.delete(request);
    let isAuthenticated =
      hostAuthorized ||
      isWebSocketAuthorized(request, wsUrl) ||
      isWebSocketUpgradeSessionAuthorized(request);
    // Serializes in-band machine-session lookups for this socket (see the
    // auth branch of the message handler).
    let inBandSessionLookupInFlight = false;

    // W5-015: the upgrade handler reserved a pre-auth slot for this socket's
    // peer. It releases on post-open authentication or on close — whichever
    // comes first — and a socket that never authenticates is closed when the
    // grace period expires, so a silent peer can no longer pin a file
    // descriptor indefinitely. The peer is captured now so the release keys
    // on the same bucket even if the socket is already torn down.
    const pendingWsPeer = request.socket?.remoteAddress ?? null;
    let pendingSlotHeld = !isAuthenticated;
    const releasePendingSlot = () => {
      if (!pendingSlotHeld) return;
      pendingSlotHeld = false;
      releasePendingWebSocket(pendingWsPeer);
    };
    let authGraceTimer: NodeJS.Timeout | null = null;
    const clearAuthGraceTimer = () => {
      if (authGraceTimer) {
        clearTimeout(authGraceTimer);
        authGraceTimer = null;
      }
    };
    if (!isAuthenticated) {
      authGraceTimer = setTimeout(() => {
        authGraceTimer = null;
        logger.warn(
          "[eliza-api] closing WebSocket that did not authenticate within the grace period",
        );
        ws.close(1008, "Unauthorized");
      }, WS_AUTH_GRACE_TIMEOUT_MS);
      // A stuck pre-auth socket must not hold the process open on shutdown.
      authGraceTimer.unref?.();
    }

    // Optional reconnect cursor: a client that tracks the highest buffered
    // event sequence it has applied can pass it back as `?lastEventId=` so the
    // server replays only the envelopes it is missing instead of re-flooding
    // the full tail on every (re)connect (loadperf research 05, Finding 4).
    // Absent/invalid => null => the historical slice(-DEFAULT_REPLAY_LIMIT)
    // behavior, so existing clients are unaffected.
    const replayCursor = parseEventCursor(
      wsUrl.searchParams.get("lastEventId") ?? wsUrl.searchParams.get("since"),
    );

    const activateAuthenticatedConnection = () => {
      wsClients.add(ws);
      if (
        wsClientId &&
        cancelPendingPtySessionStop(wsClientId, wsPtyPendingStops)
      ) {
        logger.info(
          `[eliza-api] client ${wsClientId} reconnected within the PTY grace window; keeping its PTY sessions alive`,
        );
      }
      addLog("info", "WebSocket client connected", "websocket", [
        "server",
        "websocket",
      ]);

      try {
        ws.send(
          JSON.stringify({
            type: "status",
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            // Same server-authoritative readiness signal as broadcastStatus and
            // /api/status. Without it on the initial-connect status, every WS
            // (re)connect delivers canRespond: undefined and re-gates the chat
            // composer back to "waking up" until the next 5s broadcast.
            canRespond: computeCanRespond(state.runtime, state.agentState),
            startedAt: state.startedAt,
            startup: state.startup,
            pendingRestart: state.pendingRestartReasons.length > 0,
            pendingRestartReasons: state.pendingRestartReasons,
          }),
        );
        const replay = selectReplayEvents(
          state.eventBuffer,
          replayCursor,
          DEFAULT_REPLAY_LIMIT,
        );
        for (const event of replay) {
          ws.send(JSON.stringify(event));
        }
      } catch (err) {
        logger.error(
          `[eliza-api] WebSocket send error: ${err instanceof Error ? err.message : err}`,
        );
      }
    };

    if (isAuthenticated) {
      activateAuthenticatedConnection();
    }

    const currentClientOwnsPtySession = (sessionId: string): boolean => {
      const service = getPtyService(state);
      const session = service
        ?.listSessions?.()
        .find((candidate) => candidate.sessionId === sessionId);
      if (!session?.ownerClientId) return true;
      return Boolean(wsClientId && session.ownerClientId === wsClientId);
    };

    const stopOwnedPtySessions = (reason: string): void => {
      if (!wsClientId) return;
      const service = getPtyService(state);
      if (!service?.listSessions || !service.stopSession) return;
      const owned = service
        .listSessions()
        .filter((session) => session.ownerClientId === wsClientId);
      for (const session of owned) {
        void service.stopSession(session.sessionId).catch((err) => {
          logger.warn(
            `[eliza-api] failed to stop PTY session ${session.sessionId} on ${reason}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    };

    /**
     * Reap this client's PTY sessions only after the disconnect grace window,
     * and only if no other live authenticated socket carries the same
     * clientId (multi-tab) and the client hasn't reconnected in the interim.
     */
    const scheduleStopOwnedPtySessions = (reason: string): void => {
      if (!wsClientId) return;
      const clientId = wsClientId;
      const clientHasLiveConnection = (): boolean => {
        for (const other of wsClients) {
          if (
            other !== ws &&
            other.readyState === 1 &&
            wsClientIds.get(other) === clientId
          ) {
            return true;
          }
        }
        return false;
      };
      schedulePtySessionStopAfterGrace({
        clientId,
        graceMs: wsPtyDisconnectGraceMs,
        pendingStops: wsPtyPendingStops,
        clientHasLiveConnection,
        stopOwnedSessions: () => stopOwnedPtySessions(reason),
      });
    };

    ws.on("message", async (data: unknown) => {
      try {
        const msg = JSON.parse(String(data));
        if (!isAuthenticated) {
          const expected = getConfiguredApiToken();
          const providedToken =
            msg.type === "auth" && typeof msg.token === "string"
              ? msg.token.trim()
              : "";
          let authorized = Boolean(
            expected && providedToken && tokenMatches(expected, providedToken),
          );
          if (!authorized && providedToken) {
            // A paired remote client's bearer is a revocable machine-session
            // id, never the static connection key (#13985). Resolve it through
            // the same host-bridge session seam REST uses; unknown, expired,
            // and revoked sessions fall through to the fail-closed 1008.
            // At most one store lookup may be in flight per socket: the
            // lookup is asynchronous, so an attacker spamming auth frames on
            // one pre-auth socket must not fan out concurrent store work.
            // Extra frames are dropped; the in-flight lookup's verdict
            // decides this socket either way.
            if (inBandSessionLookupInFlight) {
              return;
            }
            inBandSessionLookupInFlight = true;
            try {
              authorized = await isWebSocketSessionTokenAuthorized(
                providedToken,
                state.runtime,
              );
            } finally {
              inBandSessionLookupInFlight = false;
            }
            if (isAuthenticated) {
              // Another frame authenticated this socket while the session
              // lookup was in flight; this pre-auth frame is spent either way.
              return;
            }
          }
          if (authorized) {
            isAuthenticated = true;
            clearAuthGraceTimer();
            releasePendingSlot();
            ws.send(JSON.stringify({ type: "auth-ok" }));
            activateAuthenticatedConnection();
          } else {
            logger.warn("[eliza-api] WebSocket message rejected before auth");
            ws.close(1008, "Unauthorized");
          }
          return;
        }
        if (isDuplicateWsMessage(wsClientIds.get(ws), msg.msgId)) {
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "active-conversation") {
          // Per-connection: only this client's active conversation changes.
          const conversationId =
            typeof msg.conversationId === "string" ? msg.conversationId : null;
          if (conversationId) {
            wsActiveConversations.set(ws, conversationId);
          } else {
            wsActiveConversations.delete(ws);
          }
          // Keep the global as a sensible "any/most-recent active conversation"
          // default for non-client-targeted routing (autonomy, swarm synthesis).
          state.activeConversationId = conversationId;
        } else if (
          msg.type === "pty-subscribe" &&
          typeof msg.sessionId === "string"
        ) {
          const bridge = getPtyConsoleBridge(state);
          if (bridge) {
            if (!currentClientOwnsPtySession(msg.sessionId)) {
              logger.warn(
                `[eliza-api] pty-subscribe rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
              );
              return;
            }
            let subs = wsClientPtySubscriptions.get(ws);
            if (!subs) {
              subs = new Map();
              wsClientPtySubscriptions.set(ws, subs);
            }
            // Don't double-subscribe
            if (!subs.has(msg.sessionId)) {
              const targetId = msg.sessionId;
              // Bridges BOTH `session_output` (→ pty-output) and
              // `session_exit` (→ pty-exit) so the client can surface a dead
              // session instead of showing a "ready" pane forever.
              const detach = attachPtySessionWsBridge({
                bridge,
                sessionId: targetId,
                send: (frame) => {
                  if (ws.readyState === 1) {
                    ws.send(JSON.stringify(frame));
                  }
                },
              });
              subs.set(targetId, detach);
            }
          }
        } else if (
          msg.type === "pty-unsubscribe" &&
          typeof msg.sessionId === "string"
        ) {
          const subs = wsClientPtySubscriptions.get(ws);
          const unsub = subs?.get(msg.sessionId);
          if (unsub) {
            unsub();
            subs?.delete(msg.sessionId);
          }
        } else if (
          msg.type === "pty-input" &&
          typeof msg.sessionId === "string" &&
          typeof msg.data === "string"
        ) {
          // Only allow input to sessions this client has subscribed to
          const subs = wsClientPtySubscriptions.get(ws);
          if (!subs?.has(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-input rejected: client not subscribed to session ${msg.sessionId}`,
            );
          } else if (!currentClientOwnsPtySession(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-input rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
            );
          } else if (msg.data.length > MAX_PTY_INPUT_MESSAGE_LENGTH) {
            // Per-message DoS cap only — the client chunks large pastes into
            // <=cap messages (sendPtyInput), so hitting this means a
            // misbehaving client. Echo a pty-error so the drop isn't silent.
            logger.warn(
              `[eliza-api] pty-input rejected: payload too large (${msg.data.length} chars) for session ${msg.sessionId}`,
            );
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: "pty-error",
                  sessionId: msg.sessionId,
                  code: "input-too-large",
                  message: `pty-input exceeds ${MAX_PTY_INPUT_MESSAGE_LENGTH} chars; send large input in chunks`,
                }),
              );
            }
          } else {
            const bridge = getPtyConsoleBridge(state);
            if (bridge) {
              logger.debug(
                `[eliza-api] pty-input: session=${msg.sessionId} len=${msg.data.length}`,
              );
              bridge.writeRaw(msg.sessionId, msg.data);
            }
          }
        } else if (
          msg.type === "pty-resize" &&
          typeof msg.sessionId === "string"
        ) {
          // Only allow resize for sessions this client has subscribed to
          const subs = wsClientPtySubscriptions.get(ws);
          if (!subs?.has(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-resize rejected: client not subscribed to session ${msg.sessionId}`,
            );
          } else if (!currentClientOwnsPtySession(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-resize rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
            );
          } else {
            const bridge = getPtyConsoleBridge(state);
            if (
              bridge &&
              typeof msg.cols === "number" &&
              typeof msg.rows === "number" &&
              Number.isFinite(msg.cols) &&
              Number.isFinite(msg.rows) &&
              Number.isInteger(msg.cols) &&
              Number.isInteger(msg.rows) &&
              msg.cols >= 1 &&
              msg.cols <= 500 &&
              msg.rows >= 1 &&
              msg.rows <= 500
            ) {
              bridge.resize(msg.sessionId, msg.cols, msg.rows);
            } else {
              logger.warn(
                `[eliza-api] pty-resize rejected: invalid dimensions cols=${msg.cols} rows=${msg.rows}`,
              );
            }
          }
        } else if (
          msg.type === "view:interact:result" &&
          typeof msg.requestId === "string"
        ) {
          void import("./views-routes.ts")
            .then(({ resolveViewInteractResult }) => {
              resolveViewInteractResult({
                requestId: msg.requestId,
                success: msg.success === true,
                result: msg.result,
                error: typeof msg.error === "string" ? msg.error : undefined,
              });
            })
            .catch((err) => {
              logger.error(
                `[eliza-api] view interaction result error: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `[eliza-api] WebSocket message error: ${err instanceof Error ? err.message : err}`,
        );
      }
    });

    ws.on("close", () => {
      clearAuthGraceTimer();
      releasePendingSlot();
      wsClients.delete(ws);
      wsActiveConversations.delete(ws);
      // Clean up any PTY output subscriptions for this client
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
      scheduleStopOwnedPtySessions("websocket close");
      addLog("info", "WebSocket client disconnected", "websocket", [
        "server",
        "websocket",
      ]);
    });

    ws.on("error", (err: unknown) => {
      logger.error(
        `[eliza-api] WebSocket error: ${err instanceof Error ? err.message : err}`,
      );
      clearAuthGraceTimer();
      releasePendingSlot();
      wsClients.delete(ws);
      wsActiveConversations.delete(ws);
      // Clean up PTY subscriptions on error too
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
      scheduleStopOwnedPtySessions("websocket error");
    });
  });

  // Broadcast status to all connected WebSocket clients (flattened — PR #36 fix)
  const broadcastStatus = () => {
    // Skip the payload build + computeCanRespond() when no dashboard is
    // connected. This fires every 5s (statusInterval) plus on every state
    // change for the whole process lifetime; a headless / background agent
    // commonly has zero WS clients, so this was pure idle-CPU waste. A newly
    // connected client gets its authoritative status on connect (see
    // activateAuthenticatedConnection), so nothing depends on this running
    // while the client set is empty.
    if (wsClients.size === 0) {
      return;
    }
    broadcastWs({
      type: "status",
      state: state.agentState,
      agentName: state.agentName,
      model: state.model,
      // Carry the same server-authoritative readiness signal `/api/status`
      // returns. Without it, every 5s WS status broadcast resets the client's
      // `agentStatus.canRespond` to undefined, re-gating the chat composer back
      // to "waking up" even though the agent is fully ready and replying.
      canRespond: computeCanRespond(state.runtime, state.agentState),
      startedAt: state.startedAt,
      startup: state.startup,
      pendingRestart: state.pendingRestartReasons.length > 0,
      pendingRestartReasons: state.pendingRestartReasons,
    });
  };

  // Make broadcastStatus accessible to route handlers via state
  state.broadcastStatus = broadcastStatus;

  // Flip the WS status lane the moment a model handler registers instead of
  // waiting for the next 5s statusInterval tick: `canRespond` turns true when a
  // late-registering provider (deferred wave, first-run configure, runtime
  // plugin install) adds its TEXT_GENERATION handler, and the launcher clears
  // its "Waking…" banner on that signal. A provider registers one handler per
  // model type, so coalesce the burst into a single broadcast per tick.
  const modelBroadcastWiredRuntimes = new WeakSet<AgentRuntime>();
  let modelBroadcastScheduled = false;
  const wireModelRegistrationBroadcast = (rt: AgentRuntime | null): void => {
    if (!rt || modelBroadcastWiredRuntimes.has(rt)) return;
    modelBroadcastWiredRuntimes.add(rt);
    rt.registerEvent(EventType.MODEL_REGISTERED, async () => {
      if (modelBroadcastScheduled) return;
      modelBroadcastScheduled = true;
      setTimeout(() => {
        modelBroadcastScheduled = false;
        broadcastStatus();
      }, 0);
    });
  };
  wireModelRegistrationBroadcast(state.runtime);
  wireNativeBrowserPageReader(state.runtime);

  state.broadcastWs = (data: object) => eventHub.broadcast(data);
  state.broadcastWsToClientId = (clientId: string, data: object) =>
    eventHub.sendToClient(clientId, data);

  // View interactions originate outside HTTP requests and share the same event
  // hub as route and runtime events.
  void import("./views-routes.ts")
    .then(({ setViewsBroadcastWs }) => {
      setViewsBroadcastWs(
        state.broadcastWs ?? null,
        state.broadcastWsToClientId ?? null,
      );
    })
    .catch((err) => {
      logger.error(
        `[eliza-api] failed to wire views broadcaster: ${err instanceof Error ? err.message : err}`,
      );
    });

  state.broadcastWsToConversation = (conversationId: string, data: object) =>
    eventHub.sendToConversation(conversationId, data);

  // Broadcast status every 5 seconds
  const statusInterval = setInterval(broadcastStatus, 5000);

  /**
   * Restore the in-memory conversation list from the database. The scan/rebuild
   * logic lives in `./conversation-restore.ts` so the relaunch round-trip can be
   * driven against a real DB in tests (#13689); here we just bind it to this
   * server's live `state` + structured log sink.
   */
  const restoreConversationsFromDb = async (
    rt: AgentRuntime,
  ): Promise<void> => {
    await restoreConversationsFromDbImpl(rt, {
      conversations: state.conversations,
      deletedConversationIds: state.deletedConversationIds,
      log: (message) => addLog("info", message, "system", ["system"]),
    });
  };

  const beginConversationRestore = (rt: AgentRuntime): Promise<void> => {
    const restorePromise = restoreConversationsFromDb(rt).finally(() => {
      if (state.conversationRestorePromise === restorePromise) {
        state.conversationRestorePromise = null;
      }
    });
    state.conversationRestorePromise = restorePromise;
    return restorePromise;
  };

  /**
   * Load the agent's DB-persisted character data and overlay onto the
   * in-memory runtime.character.  This ensures Character Editor edits
   * survive server restarts without depending on eliza.json persistence.
   */
  const overlayDbCharacter = async (
    rt: AgentRuntime,
    st: typeof state,
  ): Promise<void> => {
    try {
      const dbAgent = await rt.getAgent(rt.agentId);
      const agentRecord =
        dbAgent && typeof dbAgent === "object" && !Array.isArray(dbAgent)
          ? Object.fromEntries(Object.entries(dbAgent))
          : null;
      const saved = agentRecord?.character as
        | Record<string, unknown>
        | undefined;
      if (!saved || typeof saved !== "object") return;

      const c = rt.character;
      // Only overlay fields that were explicitly saved (non-empty)
      if (typeof saved.name === "string" && saved.name) c.name = saved.name;
      if (Array.isArray(saved.bio) && saved.bio.length > 0) {
        c.bio = saved.bio as string[];
      }
      if (typeof saved.system === "string" && saved.system) {
        c.system = saved.system;
      }
      if (Array.isArray(saved.adjectives)) {
        c.adjectives = saved.adjectives as string[];
      }
      if (Array.isArray(saved.topics)) {
        (c as { topics?: string[] }).topics = saved.topics as string[];
      }
      if (saved.style && typeof saved.style === "object") {
        c.style = saved.style as NonNullable<typeof c.style>;
      }
      if (Array.isArray(saved.messageExamples)) {
        c.messageExamples = saved.messageExamples as NonNullable<
          typeof c.messageExamples
        >;
      }
      if (Array.isArray(saved.postExamples) && saved.postExamples.length > 0) {
        c.postExamples = saved.postExamples as string[];
      }
      // Update agent name on state
      st.agentName = c.name ?? st.agentName;
      logger.info(
        `[character-db] Overlaid DB-persisted character "${c.name}" onto runtime`,
      );
    } catch (err) {
      logger.warn(
        `[character-db] Failed to load character from DB: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  // Restore conversations from DB at initial boot (if runtime was passed in)
  if (opts?.runtime) {
    void beginConversationRestore(opts.runtime).catch((err) => {
      logger.warn("[api] Conversation restore failed:", err);
    });
    void overlayDbCharacter(opts.runtime, state).catch((err) => {
      logger.warn("[api] Character overlay restore failed:", err);
    });
    registerClientChatSendHandler(opts.runtime, state);
    wireProactiveInteractionDecider(opts.runtime, state);
  }

  const assertX402RoutesValid = async (
    rt: AgentRuntime | null | undefined,
  ): Promise<void> => {
    if (!rt || !runtimeRoutesNeedX402Validation(rt.routes)) return;
    const agentId =
      rt.agentId != null && String(rt.agentId).length > 0
        ? String(rt.agentId)
        : undefined;
    const x402 = await getX402Plugin();
    if (!x402) return; // x402 module unavailable (e.g. mobile bundle) — nothing to validate
    const { validateX402Startup } = x402;
    if (!validateX402Startup) return;
    const result = validateX402Startup(rt.routes as Route[], rt.character, {
      agentId,
    });
    if (!result || typeof result !== "object") {
      logger.warn(
        "[x402] startup validator returned no result; skipping x402 route validation",
      );
      return;
    }
    if (!result.valid) {
      throw new Error(
        `x402 configuration invalid:\n${result.errors.map((e) => `  • ${e}`).join("\n")}`,
      );
    }
    for (const w of result.warnings) {
      logger.warn(`[x402] ${w}`);
    }
  };

  /** Hot-swap the runtime reference (used after an in-process restart). */
  const updateRuntime = (rt: AgentRuntime): void => {
    void assertX402RoutesValid(rt).catch((err) => {
      logger.error(
        `[x402] runtime route validation failed after update: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    state.runtime = rt;
    bindInProcessApi();
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;
    bindRuntimeStreams(rt);
    wireModelRegistrationBroadcast(rt);
    wireNativeBrowserPageReader(rt);
    // AppManager doesn't need a runtime reference
    state.agentState = "running";
    state.agentName =
      rt.character.name ?? resolveDefaultAgentName(state.config);
    state.model = detectRuntimeModel(rt, state.config);
    state.startedAt = Date.now();
    state.startup = {
      phase: "running",
      attempt: 0,
    };
    addLog("info", `Runtime restarted — agent: ${state.agentName}`, "system", [
      "system",
      "agent",
    ]);

    // Restore conversations from DB so they survive restarts
    void beginConversationRestore(rt).catch((err) => {
      logger.warn("[api] Conversation restore failed on restart:", err);
    });

    // Overlay DB-persisted character data (from Character Editor saves)
    void overlayDbCharacter(rt, state).catch((err) => {
      logger.warn("[api] Character overlay restore failed on restart:", err);
    });

    // Broadcast status update immediately after restart
    broadcastStatus();

    // Re-register client_chat send handler on the new runtime
    registerClientChatSendHandler(rt, state);
    wireProactiveInteractionDecider(rt, state);

    // Wire coding-agent bridges (event-driven via getServiceLoadPromise)
    void wireCoordinatorBridgesWhenReady(state, {
      wireChatBridge: wireCodingAgentChatBridge,
      wireWsBridge: wireCodingAgentWsBridge,
      wireEventRouting: wireCoordinatorEventRouting,
      wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
      context: "restart",
      logger,
    });
  };

  const updateStartup = (
    update: Partial<AgentStartupDiagnostics> & {
      phase?: string;
      attempt?: number;
      state?: ServerState["agentState"];
    },
  ): void => {
    const { state: nextState, ...startupUpdate } = update;
    state.startup = {
      ...state.startup,
      ...startupUpdate,
    };
    if (nextState) {
      state.agentState = nextState;
      if (nextState === "error") {
        state.startedAt = undefined;
      } else if (
        (nextState === "starting" || nextState === "running") &&
        !state.startedAt
      ) {
        state.startedAt = Date.now();
      }
    }
    broadcastStatus();
  };

  logger.debug(
    `[eliza-api] Calling server.listen (${Date.now() - apiStartTime}ms)`,
  );
  let earlyEntries: LogEntry[] = [];
  try {
    await assertX402RoutesValid(state.runtime);
    // The logger package owns all global and child logger methods. Register the
    // server listener before releasing early capture so startup has no gap.
    detachApiLogListener = listenForUiLogs(captureStructuredLog);
  } finally {
    earlyEntries = flushEarlyLogs();
  }

  if (earlyEntries.length > 0) {
    for (const entry of earlyEntries) {
      state.logBuffer.push(entry);
    }
    addLog(
      "info",
      `Flushed ${earlyEntries.length} early startup log entries`,
      "system",
      ["system"],
    );
  }
  addLog(
    "info",
    "Structured logger connected — agent logs will stream to the UI",
    "system",
    ["system", "agent"],
  );

  const serverResources = createServerResources((resource, error) => {
    // error-policy:J6 every teardown is attempted and awaited; one failure is
    // reported without abandoning the remaining resources.
    logger.warn({ error, resource }, `[eliza-api] Failed to close ${resource}`);
  });
  for (const resource of [
    {
      name: "status interval",
      dispose: () => clearInterval(statusInterval),
    },
    {
      name: "API log listener",
      dispose: () => {
        detachApiLogListener?.();
        detachApiLogListener = null;
      },
    },
    {
      name: "connector health monitor",
      dispose: () => {
        state.connectorHealthMonitor?.stop();
        state.connectorHealthMonitor = null;
      },
    },
    {
      name: "provider model cache warm-up",
      dispose: async () => {
        await providerCacheWarmupPromise;
      },
    },
    {
      name: "runtime event streams",
      dispose: () => {
        detachRuntimeStreams?.();
        detachRuntimeStreams = null;
      },
    },
    {
      name: "WebSocket clients",
      dispose: () => {
        for (const ws of wsClients) {
          if (ws.readyState !== 1 && ws.readyState !== 0) continue;
          if ("terminate" in ws && typeof ws.terminate === "function") {
            ws.terminate();
          } else {
            ws.close();
          }
        }
        wsClients.clear();
      },
    },
    {
      name: "WhatsApp pairing sessions",
      dispose: async () => {
        const sessions = [...(state.whatsappPairingSessions?.values() ?? [])];
        state.whatsappPairingSessions?.clear();
        await Promise.all(sessions.map((session) => session.stop()));
      },
    },
    {
      name: "Telegram account session",
      dispose: async () => {
        const session = state.telegramAccountAuthSession;
        state.telegramAccountAuthSession = null;
        await session?.stop();
      },
    },
    {
      name: "WebSocket server",
      dispose: () =>
        new Promise<void>((resolve) => {
          try {
            wss.close(() => resolve());
          } catch {
            // A no-server WebSocketServer that never accepted a connection
            // has no asynchronous close work.
            resolve();
          }
        }),
    },
  ]) {
    serverResources.add(resource);
  }
  const stopServerSideResources = (): Promise<void> => {
    unregisterInProcessApi?.();
    return serverResources.close();
  };
  // Local-agent IPC mode: skip binding a TCP listener entirely. Routes and the
  // in-process dispatchRoute kernel are already wired (server built above), so
  // an IPC transport (stdio bridge / Capacitor / Electrobun RPC) can drive them
  // without opening a port.
  if (opts?.skipListen) {
    apiLap("skipListen (no TCP bind)");
    addLog(
      "info",
      "API server initialized without a TCP listener (skipListen)",
      "system",
      ["server", "system"],
    );
    logger.info(
      "[eliza-api] Started without binding a TCP listener (skipListen; local-agent IPC mode)",
    );
    if (!opts?.skipDeferredStartupWork) {
      void startDeferredStartupWork();
    }
    return {
      port,
      close: stopServerSideResources,
      updateRuntime,
      updateStartup,
    };
  }

  const listener = await listenHttpServer({
    server,
    host,
    port,
    strictPortBinding: strictPortBindingEnabled(),
    closeResources: stopServerSideResources,
    onBeforeListen: () => apiLap("before server.listen"),
    onPortInUse: (occupiedPort, willFallback) => {
      logger.warn(
        `[eliza-api] Port ${occupiedPort} is already in use. Checking fallback...`,
      );
      if (willFallback) {
        logger.warn("[eliza-api] Retrying with dynamic port (0)...");
      } else {
        logger.error(
          `[eliza-api] Strict port binding is enabled; refusing dynamic fallback from ${occupiedPort}.`,
        );
      }
    },
    onServerError: (err) => {
      if (err.code !== "EADDRINUSE") {
        logger.error(
          `[eliza-api] Server error: ${err.message} (code: ${err.code})`,
        );
      }
    },
    onListening: (displayHost, actualPort) => {
      apiLap("LISTENING (API bound)");
      logger.debug(
        `[eliza-api] server.listen callback fired (${Date.now() - apiStartTime}ms)`,
      );
      addLog(
        "info",
        `API server listening on http://${displayHost}:${actualPort}`,
        "system",
        ["server", "system"],
      );
      // Log to both stdout (for agent.ts port detection) and the in-memory
      // logger. agent.ts watches stdout for "Listening on http://host:PORT"
      // to detect dynamic port reassignment when the default port is in use.
      console.log(
        `[eliza-api] Listening on http://${displayHost}:${actualPort}`,
      );
      logger.info(
        `[eliza-api] Listening on http://${displayHost}:${actualPort}`,
      );
      if (!opts?.skipDeferredStartupWork) {
        void startDeferredStartupWork();
      }
    },
    onCloseHelperError: (helper, error) => {
      logger.debug({ error, helper }, `[eliza-api] ${helper} failed`);
    },
  });
  return {
    port: listener.port,
    close: listener.close,
    updateRuntime,
    updateStartup,
  };
}
