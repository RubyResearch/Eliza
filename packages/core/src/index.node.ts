/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./access-context";
export * from "./access-control/artifact-disclosure";
export * from "./access-control/audience-disclosure";
export * from "./access-control/audience-egress";
export * from "./access-control/filter";
export * from "./access-control/provenance-envelope";
// Export all core modules
export * from "./account-pool-bridge";
export * from "./action-names";
export * from "./actions";
// The Stage-1 native-tool contract: model-provider plugins that serve
// RESPONSE_HANDLER structurally (native tool capture) key their detection on
// this name instead of duplicating the literal.
export { HANDLE_RESPONSE_TOOL_NAME } from "./actions/to-tool";
export * from "./activity-plaintext";
export * from "./api/http-helpers";
export * from "./api/route-helpers";
export * from "./app-registry";
export * from "./app-route-plugin-registry";
export * from "./boot-env";
export * from "./build-variant";
export * from "./capabilities";
export * from "./capability-selection";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
// Export character utilities
export * from "./character-utils";
export * from "./cloud-auth-service";
export * from "./cloud-routing";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors/account-manager";
export * from "./connectors/attachments";
export * from "./connectors/connector-config";
export * from "./connectors/oauth-role";
export * from "./connectors/privacy";
export * from "./connectors.ts";
// Export additional constants not re-exported by character-utils
export {
	CANONICAL_SECRET_KEYS,
	type CanonicalSecretKey,
	CHANNEL_OPTIONAL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	LOCAL_MODEL_PROVIDERS,
	SECRET_KEY_ALIASES,
} from "./constants";
export { isElizaCloudServiceSelectedInConfig } from "./contracts/cloud-topology";
export * from "./contracts/computer-use";
export {
	type CharacterFailureTemplates,
	getDirectAccountProviderForFirstRunProvider,
	getFirstRunProviderOption,
	getStoredFirstRunProviderId,
	getStoredSubscriptionProviderForRequest,
	isCloudInferenceSelectedInConfig,
	migrateLegacyRuntimeConfig,
	normalizeFirstRunProviderId,
	type StylePreset,
} from "./contracts/first-run-options";
export {
	DEFAULT_CEREBRAS_TEXT_MODEL,
	DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
	DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
	DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
	type DeploymentTargetConfig,
	type DeploymentTargetRuntime,
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	type LinkedAccountAccountSource,
	type LinkedAccountConfig,
	type LinkedAccountFlagConfig,
	type LinkedAccountFlagsConfig,
	type LinkedAccountHealth,
	type LinkedAccountHealthDetail,
	type LinkedAccountProviderId,
	type LinkedAccountSource,
	type LinkedAccountStatus,
	type LinkedAccountsConfig,
	type LinkedAccountUsage,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
	type ServiceCapability,
	type ServiceRouteAccountStrategy,
	type ServiceRouteConfig,
	type ServiceRoutingConfig,
	type ServiceTransport,
} from "./contracts/service-routing";
export * from "./contracts/wallet";
export * from "./database";
export * from "./database/connector-json";
export * from "./database/document-list-query";
export * from "./database/inMemoryAdapter";
export * from "./database/world-metadata-cas";
export * from "./entities";
export * from "./env-utils";
export * from "./errors";
export {
	ElizaError,
	type ElizaErrorOptions,
	type ElizaErrorSeverity,
	isElizaError,
	type ReportedError,
	toElizaError,
} from "./errors";
export {
	roleAction,
	updateRoleAction,
} from "./features/advanced-capabilities/actions/role";
export {
	buildFactKeywordsForStorage,
	buildFactSearchText,
	factClaimsEquivalent,
	factLexicalSimilarity,
	factPolarityDiffers,
	readStoredFactKeywords,
} from "./features/advanced-capabilities/fact-keywords";
export * from "./features/advanced-memory";
export {
	AUTONOMY_SERVICE_TYPE,
	AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS,
	AutonomyService,
} from "./features/autonomy";
// Export capabilities and plugin creation
export * from "./features/basic-capabilities/index";
export * from "./features/credential-proxy/index.ts";
export * from "./features/documents/index";
export type {
	DeferredMessageScheduleCommit,
	DeferredMessageScheduleRequest,
	DeferredMessageScheduleResult,
	DeferredMessageScheduler,
	DraftRecord,
	DraftRequest,
	ListOptions,
	ManageOperation,
	ManageResult,
	MessageAdapter,
	MessageAdapterCapabilities,
	MessageRef,
	MessageSource,
	ReadMessageControl,
	ReadMessageRequest,
	ReadMessageResult,
	ScoreContext,
	SearchMessagesFilters,
	SendPolicy,
	TriageOptions,
	TriageScore,
} from "./features/messaging/triage";
// Cross-platform messaging triage (MESSAGE, MESSAGE, MESSAGE,
// MESSAGE, MESSAGE, adapters, SendPolicy, TriageService).
// Selective re-export — `MessageParticipant` collides with an unrelated type in
// `types/service-interfaces.ts`; consumers that need the triage-side participant type
// should import it from the package barrel.
export {
	__resetDefaultMessageRefStoreForTests,
	__resetDefaultTriageServiceForTests,
	BaseMessageAdapter,
	draftFollowupAction,
	draftReplyAction,
	getDefaultMessageRefStore,
	getDefaultTriageService,
	getDeferredMessageScheduler,
	getSendPolicy,
	listInboxAction,
	MessageRefStore,
	manageMessageAction,
	messagingTriageActions,
	NotYetImplementedError,
	rankScored,
	registerDeferredMessageScheduler,
	registerSendPolicy,
	resetMissingServiceWarning,
	resolveContactWeight,
	respondToMessageAction,
	scheduleDraftSendAction,
	scoreMessage,
	scoreMessages,
	searchMessagesAction,
	sendDraftAction,
	triageMessagesAction,
} from "./features/messaging/triage";
// OAuth provider contract (the canonical provider identifiers the atomic OAuth
// actions accept). Exported so cloud-shared can enforce core ⊆ cloud-registry.
export {
	CONNECTOR_NATIVE_OAUTH_PROVIDERS,
	OAUTH_PROVIDERS,
	type OAuthProvider,
} from "./features/oauth/types.ts";
export { paymentsPlugin } from "./features/payments/index.ts";
export { PluginManagerService } from "./features/plugin-manager/services/pluginManagerService.ts";
export {
	isSerializedSecretHandle,
	SECRETS_SERVICE_TYPE,
	type SecretsManagerPluginConfig,
	secretsManagerPlugin,
} from "./features/secrets/index.ts";
export * from "./features/sub-agent-credentials/index";
export * from "./features/subscription-auth/index.ts";
// Export generated action/provider/evaluator specs from centralized prompts
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./identity-clusters";
export * from "./inference-timing";
// Export the managed-provider adapter SDK (connection, transport, health)
export * from "./integrations/managed-provider";
export * from "./lifeops-passive-connectors";
export * from "./logger";
// Export markdown utilities
export * from "./markdown";
// Export media utilities
export * from "./media";
export * from "./memory";
export * from "./messaging/interactions";
export * from "./messaging/manage-server-authorization";
export * from "./mobile-device-bridge-service";
export * from "./model-gateway";
export * from "./name-tokens";
// Export network utilities (SSRF protection, secure fetch)
export * from "./network";
export * from "./plugin";
export * from "./plugins";
export * from "./prompts";
// Export recent-errors provider (#12263)
export * from "./providers/recent-errors";
// Export setup providers
export * from "./providers/setup-progress";
// Export skill eligibility provider
export * from "./providers/skill-eligibility";
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./recent-messages-state";
export * from "./roles";
export * from "./runtime";
export {
	type ActionCatalog,
	type ActionCatalogChild,
	type ActionCatalogEntry,
	type ActionCatalogParent,
	type ActionCatalogWarning,
	type ActionCatalogWarningCode,
	type BuildActionCatalogOptions,
	buildActionCatalog,
	type LocalizedActionExamplePair,
	type LocalizedActionExampleResolver,
	normalizeActionName,
	type RuntimeActionLike,
} from "./runtime/action-catalog";
export { actionGateRejection } from "./runtime/action-gate";
export { warnOnUnmatchedActionRolePolicyKeys } from "./runtime/action-role-policy";
export * from "./runtime/builtin-field-evaluators";
export {
	__resetCandidateActionBackstopRulesForTests,
	type CandidateActionBackstopRule,
	getCandidateActionBackstopRules,
	registerCandidateActionBackstopRule,
} from "./runtime/candidate-action-backstop";
export * from "./runtime/cleanup-scope";
export * from "./runtime/content-access-manifest";
export * from "./runtime/content-projection-policy";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export {
	__resetDirectActionRoutingRulesForTests,
	type DirectActionRoutingRule,
	getDirectActionRoutingRules,
	registerDirectActionRoutingRule,
} from "./runtime/direct-action-routing";
export * from "./runtime/execute-planned-tool-call";
export {
	detectLocaleFromText,
	type ResolveOwnerLocaleOptions,
	resolveOwnerLocale,
	type SupportedLocale,
} from "./runtime/locale-detection";
export {
	__resetLocalizedExamplesProviderForTests,
	getLocalizedExamplesProvider,
	type LocalizedExamplesProvider,
	type LocalizedExamplesProviderInput,
	registerLocalizedExamplesProvider,
} from "./runtime/localized-examples-provider";
export {
	getMessageHandlerReply,
	type MessageHandlerRoute,
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
	type V5MessageHandlerOutput,
} from "./runtime/message-handler";
// The planner's generic failed-tool apology is exported so relay/delivery
// layers (message service, orchestrator completion relays) can recognize it
// by identity and drop it as redundant next to an authoritative outcome.
export { FAILED_TOOL_FALLBACK_MESSAGE } from "./runtime/planner-loop";
export { renderActionResultsForModel } from "./runtime/planner-rendering";
export * from "./runtime/response-grammar";
export * from "./runtime/response-handler-evaluators";
export * from "./runtime/response-handler-field-evaluator";
export * from "./runtime/response-handler-field-registry";
export * from "./runtime/rlm";
export * from "./runtime/room-handler-queue";
export * from "./runtime/schema-compat";
export * from "./runtime/shortcut-registry";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime/trace-correlation";
export * from "./runtime/trajectory-gate";
export * from "./runtime/trajectory-provider-attribution";
export * from "./runtime/trajectory-recorder";
export * from "./runtime/trajectory-usage-rollup";
export * from "./runtime/turn-controller";
export {
	type CallModelWithValidationOptions,
	type CallModelWithValidationResult,
	callModelWithValidation,
	DEFAULT_REMOTE_REROLL_BUDGET,
	getProviderForModelType,
	type ParseAndValidateResult,
	parseAndValidate,
	rerollBudgetCeilingFromSetting,
	SchemaValidationFailedError,
} from "./runtime/validated-model-call";
// Runtime composition (loadCharacters, createRuntimes, getBasicCapabilitiesSettings, mergeSettingsInto) - node only
export * from "./runtime-composition";
export * from "./runtime-env";
export * from "./runtime-route-context";
export {
	_setAppBundleRootForTests,
	assertDlopenPathAllowed,
	isPathInsideAppBundle,
} from "./sandbox/dlopen-gate";
export * from "./sandbox-policy";
// Export character schemas
export * from "./schemas/character";
// Export base table schemas (abstract SchemaTable definitions + buildBaseTables factory)
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./search/keyless-web-search";
// Export security utilities
export * from "./security";
export * from "./security/basic-email";
// Envelope unwrap for orchestration surfaces that forward a user message
// onward (deterministic follow-up sends must never embed the security banner
// in a child task — live 2026-08-21).
export { extractWrappedExternalContent } from "./security/external-content";
export {
	isSensitiveKeyName,
	redactLogArgs,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
} from "./security/redact";
export * from "./security/secret-swap";
export * from "./sensitive-request-policy";
export * from "./sensitive-requests";
export * from "./services";
export * from "./services/agent-event-bridge";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/channel-topics";
export * from "./services/evaluator";
export * from "./services/evaluator-priorities";
export * from "./services/hook";
export * from "./services/message";
export {
	CODING_DELEGATION_ACTION_TAGS,
	findCodingDelegationActionName,
	hasActionTags,
	LEGACY_CODING_DELEGATION_ACTION_NAMES,
	looksLikeBareLinkShare,
	normalizeActionIdentifier,
} from "./services/message/direct-action-heuristics";
export { sanitizeOutboundText } from "./services/message/outbound-sanitize";
export * from "./services/notification";
export * from "./services/optimized-prompt";
export {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "./services/optimized-prompt-resolver";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/post-delivery-task-tracker";
export * from "./services/relationships-graph-builder";
export * from "./services/runtime-capability-service";
export * from "./services/setup-cli";
export * from "./services/setup-rpc";
// Export setup services
export * from "./services/setup-state";
// TaskService is exported so hosts and tests can `instanceof`-check the
// runtime-registered instance; a relative src import would create a second
// class identity against the built package and always fail that check.
export {
	TaskService,
	type TaskServiceClock,
	type TaskServiceTimerHandle,
} from "./services/task";
export {
	getTaskSchedulerAdapter,
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	startTaskScheduler,
	stopTaskScheduler,
	unregisterTaskSchedulerRuntime,
} from "./services/task-scheduler";
export * from "./services/tool-policy";
export * from "./services/trajectories";
export * from "./services/triggerScheduling";
// Export sessions utilities
export * from "./sessions";
export * from "./settings";
export {
	isElizaSettingsDebugEnabled,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug";
export { sanitizeSpeechText } from "./spoken-text";
export * from "./streaming-context";
export * from "./target-sources";
export {
	availableProviderNames,
	isLiveTestEnabled,
	type LiveProviderConfig,
	type LiveProviderName,
	requireLiveProvider,
	selectLiveProvider,
} from "./testing/live-provider";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export * from "./tunnel-service";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
// Export everything from types
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/notification";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
// Export setup types and utilities
export * from "./types/setup";
export type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
} from "./types/view-kind";
export {
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./types/view-kind";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml,
	parseToonKeyValue,
} from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/boolean";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	DestructiveConfirmationGateResult,
	RequireConfirmationArgs,
} from "./utils/confirmation";
// Unified two-phase confirmation helper for destructive actions.
export {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./utils/confirmation";
// Prompt description compression (parity with Python `compress_prompt_description`)
export * from "./utils/description-compressed-lint";
export * from "./utils/deterministic";
// Export browser-compatible utilities
export * from "./utils/environment";
export { getEnv } from "./utils/environment";
export * from "./utils/extraction-evidence";
export { formatError } from "./utils/format-error";
export * from "./utils/html-raw-text";
/** Single-lane local inference scheduling: interactive-over-background gate + device-class background budgets (#11914). */
export * from "./utils/inference-priority-gate";
export * from "./utils/inflection-term-keys";
export {
	assertModelOutputComplete,
	isModelOutputLimitFinishReason,
	isModelProviderError,
	modelProviderErrorDetail,
} from "./utils/model-errors";
// Export Node-specific utilities
export * from "./utils/project-memory-scope";
export * from "./utils/project-registry";
export * from "./utils/prompt-compression";
// Canonical env-var reader with legacy-alias back-compat
export * from "./utils/read-env";
// Blob-safe rendering of user/planner-supplied references in output
export * from "./utils/reference-echo";
// Canonical runtime-setting → env resolver (per-agent setting first, then env)
export * from "./utils/resolve-setting";
export * from "./utils/server-health";
// Eliza state-dir resolution (ELIZA_STATE_DIR → XDG state home)
export * from "./utils/state-dir";
// Export streaming utilities
export * from "./utils/streaming";
export { ResponseSkeletonStreamExtractor } from "./utils/streaming";
export * from "./utils/well-formed";
// User-chosen workspace folder persisted in <stateDir>/workspace-folder.json,
// shared between the Electrobun renderer (writes via desktop RPC) and the
// agent runtime (reads at boot to seed ELIZA_WORKSPACE_DIR for store builds).
export * from "./utils/workspace-folder-config";
// Export validation utilities
export * from "./validation";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;

export {
	isPermanentQuotaError,
	providerRetryAfterMs,
} from "./utils/model-retry";
