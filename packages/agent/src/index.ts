/**
 * Public barrel for `@elizaos/agent` — the surface that sibling
 * `@elizaos/plugin-*` packages and the app shell import. Re-exports the HTTP API,
 * runtime boot and plugin resolution, long-lived services (including the TEE
 * stack), config and character schemas, auth, security, triggers, providers, and
 * diagnostics. Cloud route handlers are lazy wrappers that dynamically import
 * `@elizaos/plugin-elizacloud`. Many re-exports are deliberately named rather
 * than `export *` to dodge duplicate-symbol (TS2308) collisions and to keep
 * heavy plugins lazy-loaded — read the inline notes before widening any of them.
 */
import type {
  AgentCloudBillingRouteHandler,
  AgentCloudCompatRouteHandler,
  AgentCloudRouteHandler,
} from "./api/cloud-route-contracts.ts";

export {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "@elizaos/core";

export interface CloudConfigLike {
  apiKey?: string | null;
  baseUrl?: string | null;
  [key: string]: unknown;
}

type CloudUrlValidator = (value: string) => Promise<string | null>;
type ElizaCloudRoutesModule = {
  handleCloudBillingRoute: AgentCloudBillingRouteHandler;
  handleCloudCompatRoute: AgentCloudCompatRouteHandler;
  handleCloudRoute: AgentCloudRouteHandler;
  validateCloudBaseUrl: CloudUrlValidator;
};

async function loadElizaCloudRoutes(): Promise<ElizaCloudRoutesModule> {
  return import(
    "@elizaos/plugin-elizacloud"
  ) as Promise<ElizaCloudRoutesModule>;
}

export const handleCloudBillingRoute: AgentCloudBillingRouteHandler = async (
  ...args
) => {
  const { handleCloudBillingRoute } = await loadElizaCloudRoutes();
  return handleCloudBillingRoute(...args);
};

export const handleCloudCompatRoute: AgentCloudCompatRouteHandler = async (
  ...args
) => {
  const { handleCloudCompatRoute } = await loadElizaCloudRoutes();
  return handleCloudCompatRoute(...args);
};

export const handleCloudRoute: AgentCloudRouteHandler = async (...args) => {
  const { handleCloudRoute } = await loadElizaCloudRoutes();
  return handleCloudRoute(...args);
};

export async function validateCloudBaseUrl(
  value: string,
): Promise<string | null> {
  const { validateCloudBaseUrl } = await loadElizaCloudRoutes();
  return validateCloudBaseUrl(value);
}
export * from "@elizaos/auth";
export type { ElizaConfig, ReleaseChannel, RolesConfig } from "@elizaos/shared";
export {
  CONNECTOR_PLUGINS,
  normalizeCloudSiteUrl,
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
  RESTART_EXIT_CODE,
  type RestartHandler,
  requestRestart,
  resolveCloudApiBaseUrl,
  setRestartHandler,
} from "@elizaos/shared";
export {
  type ExtractActionParamsArgs,
  extractActionParamsViaLlm,
  type ParamSchemaDescriptor,
} from "./actions/extract-params.ts";
export * from "./actions/index.ts";
export * from "./api/config-env.ts";
export { handleConnectorAccountRoutes } from "./api/connector-account-routes.ts";
export * from "./api/conversation-metadata.ts";
export * from "./api/index.ts";
export { setOwnerContact } from "./api/owner-contact-helpers.ts";
export {
  findPrimaryEnvKey,
  isBlockedEnvKey,
  readBundledPluginPackageMetadata,
} from "./api/plugin-discovery-helpers.ts";
export * from "./api/plugin-runtime-apply.ts";
export type { PluginParamInfo } from "./api/plugin-validation.ts";
export {
  applyCanonicalFirstRunConfig,
  applyFirstRunCredentialPersistence,
  clearPersistedFirstRunConfig,
} from "./api/provider-switch-config.ts";
export { RegistryService } from "./api/registry-service.ts";
// Runtime-mode contract (mode resolution, route-visibility gate, remote-mode
// forwarder). `api/server.ts` enforces it in its own dispatch; the app-core
// compat pipeline calls the same pre-dispatch hook so every host shares one
// gate.
export {
  handleRuntimeModePreDispatch,
  handleRuntimeModeRemoteForward,
} from "./api/runtime-mode/pre-dispatch.ts";
export {
  forwardRemoteCloudMutation,
  shouldForwardToRemoteTarget,
} from "./api/runtime-mode/remote-forwarder.ts";
export {
  applyRouteModeGuard,
  evaluateRouteModeGate,
  findRegisteredRouteModeRule,
  type ModeGateOutcome,
  type RouteModeRuntimeLike,
  type RuntimeRouteModeRule,
} from "./api/runtime-mode/route-mode-guard.ts";
export * from "./api/runtime-mode/runtime-mode.ts";
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  type captureEarlyLogs,
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  ensureApiTokenForBindHost,
  extractAuthToken,
  fetchWithTimeoutGuard,
  injectApiBaseIntoHtml,
  isAllowedHost,
  isAuthorized,
  isSafeResetStateDir,
  normalizeWsClientId,
  type PluginConfigMutationRejection,
  persistConversationRoomTitle,
  resolveCorsOrigin,
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
  resolvePluginConfigMutationRejections,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWalletExportRejection,
  resolveWebSocketUpgradeRejection,
  routeAutonomyTextToUser,
  startApiServer,
  streamResponseBodyWithByteLimit,
} from "./api/server.ts";
// `server-helpers.ts` exposes auth/conversation/wallet helpers that the
// canonical `server.ts` already re-exports for backwards compat. Re-exporting
// the entire file would clash with those re-exports, so only surface helpers
// that aren't visible through `server.ts`.
export {
  type DeletedConversationsStateFile,
  getAgentEventSvc,
  initializeOGCodeInState,
  persistDeletedConversationIdsToState,
  readDeletedConversationIdsFromState,
  readOGCodeFromState,
  requireCoreManager,
  requirePluginManager,
} from "./api/server-helpers.ts";
// Loopback-trust + token helpers. These come from the canonical
// `./api/server-helpers-auth.js` (the same module the live server uses), not a
// divergent copy. `isLoopbackBindHost`/`tokenMatches` live in `@elizaos/shared`
// and are not re-surfaced here; the `PluginConfigMutationRejection` type is
// exported through `./api/server.js`.
export {
  getConfiguredApiToken,
  isCredentialedCorsOrigin,
  isTrustedLocalRequest,
} from "./api/server-helpers-auth.ts";
// `server-types.ts` is the canonical source for conversation/server type
// shapes. `server.ts` already re-exports the bulk of these (see line ~520
// over there); the additional exports below cover names that aren't already
// re-exported through `./api/server.js`.
export type {
  AgentAutomationMode,
  ChatAttachmentWithData,
  ConnectorRouteHandler,
  ConversationAutomationType,
  ConversationMetadata,
  ConversationScope,
  PluginEntry,
  PluginParamDef,
  StreamEventType,
  TradePermissionMode,
} from "./api/server-types.ts";
export {
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  TxService,
} from "./api/tx-service.ts";
export { getWalletAddresses, initStewardWalletCache } from "./api/wallet.ts";
export * from "./api/wallet-capability.ts";
export * from "./api/workbench-helpers.ts";
export * from "./awareness/index.ts";
export { runBenchmark } from "./cli/benchmark.ts";
export { CharacterSchema } from "./config/character-schema.ts";
export { loadElizaConfig, saveElizaConfig } from "./config/config.ts";
export * from "./config/index.ts";
export { resolveUserPath } from "./config/paths.ts";
// Surface plugin-widgets / plugin-validation / plugin-manager
// types through the barrel so `@elizaos/plugin-registry` consumes them
// without reaching into subpaths. The implementations remain agent-private.
// plugin-routes / plugins-compat-routes moved to @elizaos/plugin-registry.
// Re-export the internal helpers they consume so the plugin can stay free of
// `agent/src/...` deep imports.
export {
  getPluginWidgets,
  type PluginWidgetDeclarationServer,
} from "./config/plugin-widgets.ts";
// `contracts/awareness.js` preserves the agent-owned import surface by
// re-exporting the canonical awareness contracts from `@elizaos/shared`.
// Config media/custom-action contract types are exported from `./config/index.js`
// (via `@elizaos/shared`); do not re-export `./contracts/config.js` here or
// `tsc` reports duplicate symbol errors (TS2308).
export * from "./contracts/awareness.ts";
export * from "./diagnostics/integration-observability.ts";
export * from "./hooks/index.ts";
export * from "./providers/workspace.ts";
export * from "./runtime/advanced-capabilities-config.ts";
export * from "./runtime/agent-event-service.ts";
export * from "./runtime/core-plugins.ts";
export {
  type DevTrajectoryRecoveryPreparation,
  type DevTrajectoryRecoveryRegistration,
  type DevTrajectoryRecoveryTransport,
  prepareDevTrajectoryRecovery,
} from "./runtime/dev-trajectory-recovery.ts";
export * from "./runtime/dev-trajectory-recovery-protocol.ts";
export * from "./runtime/eliza.ts";
export * from "./runtime/eliza-plugin.ts";
export * from "./runtime/first-run-names.ts";
export { extractPlugin } from "./runtime/load-plugin-from-vfs.ts";
export {
  isCloudExecutionMode,
  type LocalExecutionMode,
  type RuntimeExecutionMode,
  type RuntimeExecutionModeSource,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  shouldUseSandboxExecution,
} from "./runtime/local-execution-mode.ts";
export {
  LOGS_RETENTION_PREFIX,
  LOGS_RETENTION_SERVICE,
  type LogsRetentionAdapter,
  LogsRetentionService,
  type LogsSweepResult,
  resolveLogsRetentionService,
} from "./runtime/logs-retention-service.ts";
export {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  type RetentionPlan,
  type RetentionPolicy,
  resolveRetentionConfig,
  resolveRetentionConfigWithPrefix,
} from "./runtime/memory-retention.ts";
export {
  MEMORY_RETENTION_SERVICE,
  MemoryRetentionService,
  RETENTION_PARTITIONS,
  type RetentionAdapter,
  resolveMemoryRetentionService,
  type SweepResult,
} from "./runtime/memory-retention-service.ts";
export * from "./runtime/operations/vault-bridge.ts";
export * from "./runtime/owner-entity.ts";
export * from "./runtime/plugin-collector.ts";
export * from "./runtime/plugin-lifecycle.ts";
export {
  type FailedPluginDetail,
  getLastFailedPluginDetails,
  getLastFailedPluginNames,
  resolvePlugins,
} from "./runtime/plugin-resolver.ts";
export * from "./runtime/plugin-types.ts";
export * from "./runtime/release-plugin-policy.ts";
export * from "./runtime/trajectory-internals.ts";
export * from "./runtime/trajectory-persistence.ts";
export * from "./runtime/trajectory-query.ts";
export * from "./runtime/version.ts";
export * from "./security/index.ts";
export * from "./services/agent-backup.ts";
export * from "./services/agent-export.ts";
// Runtime owner-approval queue promoted from LifeOps (Slice 4). Named
// re-export — same rationale as the knowledge graph / pending-prompts below:
// keep it out of the broad services barrel to avoid TS2308.
export {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  APPROVAL_SERVICE,
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalDispatchControl,
  type ApprovalDispatchControlMutation,
  ApprovalDispatchControlStore,
  type ApprovalEnqueueInput,
  type ApprovalEnqueueResult,
  type ApprovalExecution,
  type ApprovalExecutionClaim,
  type ApprovalExecutionCompletion,
  type ApprovalExecutionFailure,
  type ApprovalExecutionMutation,
  type ApprovalExecutionReconciliation,
  ApprovalIdempotencyConflictError,
  type ApprovalListFilter,
  ApprovalNotFoundError,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalQueueOptions,
  type ApprovalRequest,
  type ApprovalRequestState,
  type ApprovalResolution,
  ApprovalService,
  ApprovalStateTransitionError,
  type ApprovalTravelCalendarSync,
  type ApprovalTravelPassenger,
  approvalDispatchAdmissionCte,
  createApprovalQueue,
  PgApprovalQueue,
  resolveApprovalService,
} from "./services/approval/index.ts";
export {
  createGlobalPauseStore,
  GLOBAL_PAUSE_CACHE_KEY,
  GLOBAL_PAUSE_SERVICE,
  GlobalPauseService,
  type GlobalPauseStatus,
  type GlobalPauseStore,
  type GlobalPauseWindow,
  resolveGlobalPauseService,
} from "./services/global-pause/index.ts";
export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  HANDOFF_SERVICE,
  type HandoffEnterOpts,
  HandoffService,
  type HandoffStatus,
  type HandoffStore,
  type ResumeCondition,
  type ResumeEvaluation,
  type ResumeEvaluationInput,
  resolveHandoffService,
} from "./services/handoff/index.ts";
export * from "./services/index.ts";
export {
  type JsRuntimeBridge,
  type JsRuntimeEvaluateOptions,
  type JsRuntimeFactory,
  type JsRuntimeImportOptions,
  type JsRuntimeKind,
  type JsValue,
  registerJsRuntimeFactory,
  resolveJsRuntimeBridge,
} from "./services/js-runtime-bridge.ts";
// Runtime knowledge graph (entity/relationship stores + service). Named
// re-export to mirror the relationships-graph surface and avoid colliding
// with the broad services barrel.
export {
  archiveCoreRelationshipsInventory,
  type CoreRelationshipsInventoryDatabase,
  type CoreRelationshipsInventoryReport,
  type CoreRelationshipsInventorySession,
  type CoreRelationshipsSourceKind,
  EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  knowledgeGraphSchema,
  RelationshipStore,
  resolveKnowledgeGraphService,
} from "./services/knowledge-graph/index.ts";
// Cache-backed runtime stores promoted from LifeOps (pending-prompts /
// global-pause / handoff). Named re-exports — same rationale as the knowledge
// graph above: keep them out of the broad services barrel to avoid TS2308.
export {
  createPendingPromptsStore,
  type ExpectedReplyKind,
  PENDING_PROMPTS_SERVICE,
  type PendingPrompt,
  type PendingPromptRecordInput,
  PendingPromptsService,
  type PendingPromptsStore,
  type RecordedPendingPrompt,
  resolvePendingPromptsService,
} from "./services/pending-prompts/index.ts";
export * from "./services/plugin-installer";
export type {
  CoreManagerLike,
  CoreStatusLike,
  EjectResult,
  InstallProgressLike,
  PluginInstallOptionsLike,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  RegistryPluginAppMeta,
  RegistryPluginAppSessionFeature,
  RegistryPluginAppSessionInfo,
  RegistryPluginAppSessionMode,
  RegistryPluginInfo,
  RegistryPluginNpmInfo,
  RegistryPluginViewerInfo,
  RegistrySearchResult,
  RegistryVersionSupport,
  ReinjectResult,
  SyncResult,
} from "./services/plugin-manager-types.ts";
export {
  isCoreManagerLike,
  isPluginManagerLike,
} from "./services/plugin-manager-types.ts";
export {
  type ClusterMemoriesQuery,
  type ClusterSearchQuery,
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
  type RelationshipsGraphEdge,
  type RelationshipsGraphQuery,
  type RelationshipsGraphService,
  type RelationshipsGraphSnapshot,
  type RelationshipsGraphStats,
  type RelationshipsPersonDetail,
  type RelationshipsPersonFact,
  type RelationshipsPersonSummary,
  resolveRelationshipsGraphService,
  searchMemoriesForCluster,
} from "./services/relationships-graph.ts";
// Re-export the shell-execution router by name to keep a stable surface for
// callers that consume the chokepoint directly without unpacking the wider
// services barrel.
export {
  runShell,
  type ShellExecutionMode,
  type ShellRequest,
  type ShellResult,
  type ShellRouterContext,
  type ShellSandboxBackend,
} from "./services/shell-execution-router.ts";
export * from "./services/tee-boot-gate.ts";
export * from "./services/tee-boot-gate-state.ts";
export * from "./services/tee-confidential-inference.ts";
export * from "./services/tee-evidence.ts";
export * from "./services/tee-evidence-provider.ts";
export * from "./services/tee-key-release.ts";
export * from "./services/tee-model-key-boot.ts";
export * from "./services/tee-policy.ts";
export * from "./services/tee-production-profile.ts";
export * from "./services/tee-release-policy.ts";
export * from "./services/tee-revocation.ts";
export * from "./services/tee-runtime-config.ts";
export * from "./services/tee-sealed-volume.ts";
export * from "./services/tee-signer-backend.ts";
export { resolveDefaultAgentWorkspaceDir } from "./shared/workspace-resolution.ts";
export * from "./triggers/humanize.ts";
export * from "./triggers/runtime.ts";
export * from "./triggers/scheduling.ts";
export * from "./triggers/types.ts";
// `types/index.js` aggregates `agent-skills`, `config-like`, and `trajectory`.
export * from "./types/index.ts";
export * from "./version-resolver.ts";
