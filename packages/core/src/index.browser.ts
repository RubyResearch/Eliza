/**
 * Browser-specific entry point for @elizaos/core
 *
 * This file exports only browser-compatible modules and provides explicit
 * browser alternatives for Node.js-specific functionality.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./access-context";
export * from "./access-control/artifact-disclosure";
export * from "./access-control/audience-disclosure";
export * from "./access-control/audience-egress";
export * from "./access-control/filter";
export * from "./account-pool-bridge";
export * from "./action-names";
export * from "./actions";
export * from "./activity-plaintext";
export * from "./api/http-helpers";
export * from "./api/route-helpers";
// Export core modules (all browser-compatible after refactoring)
export * from "./app-route-plugin-registry";
// `boot-env` is pure (no node deps — operates on `globalThis`); needed by
// browser dists that read brand<->ELIZA env aliases via resolveAliasedEnvValue.
export * from "./boot-env";
export * from "./build-variant";
export * from "./capabilities";
export * from "./character";
// `cloud-routing` is pure data (no Node deps) — safe in the browser bundle;
// app-core sensitive-request code depends on `toRuntimeSettings` and route helpers.
export * from "./cloud-routing";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/connector-config";
export * from "./connectors/oauth-role";
export * from "./connectors/privacy";
export * from "./contracts/computer-use";
// Linked-account contract literals are pure data (no Node deps); browser
// clients validate untrusted /api/accounts payloads against them.
export {
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
} from "./contracts/service-routing-types";
export * from "./database";
export * from "./database/connector-json";
export * from "./database/document-list-query";
export * from "./database/inMemoryAdapter";
export * from "./database/world-metadata-cas";
export * from "./entities";
// `isTruthyEnvValue` is pure string logic (no Node deps), so it is browser-safe
// and exported from both barrels. @elizaos/shared re-exports it from the core
// barrel so browser consumers resolve the same canonical truthy set.
export * from "./env-utils";
export * from "./errors";
export * from "./features/advanced-memory";
export { AutonomyService } from "./features/autonomy/index";
export {
	__setDocumentUrlFetchImplForTests,
	type FetchDocumentFromUrlOptions,
	type FetchedDocumentUrl,
	type FetchedDocumentUrlKind,
	fetchDocumentFromUrl,
	isYouTubeUrl,
	normalizeDocumentContentType,
} from "./features/documents/index";
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
	ScoreContext,
	SearchMessagesFilters,
	SendPolicy,
	TriageOptions,
	TriageScore,
} from "./features/messaging/triage";
export {
	BaseMessageAdapter,
	filterInMemory,
	getDefaultMessageRefStore,
	getDeferredMessageScheduler,
	getSendPolicy,
	MessageRefStore,
	NotYetImplementedError,
	rankScored,
	registerDeferredMessageScheduler,
	registerSendPolicy,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
} from "./features/messaging/triage";
export { paymentsPlugin } from "./features/payments/index";
export * from "./features/sub-agent-credentials/index";
export * from "./inference-timing";
export * from "./lifeops-passive-connectors";
export * from "./logger";
export * from "./memory";
export * from "./messaging/interactions";
// Vendor-neutral model-gateway resolution (#11536 E1). Pure string logic, no
// Node deps, so it is browser-safe and exported from both barrels.
export * from "./model-gateway";
// Pure isomorphic helpers (string token substitution + a state accessor).
// Canonical owner is `@elizaos/core`; `@elizaos/shared` re-exports them from
// this barrel so browser consumers resolve the same implementation.
export * from "./name-tokens";
// Literal-host SSRF policy helpers are pure string/IP logic (no Node deps).
// Browser-target consumers use them to fail closed before fetching
// caller-supplied media URLs (#18702); DNS pinning itself stays Node-only.
export {
	isBlockedHostname,
	isPrivateIpAddress,
	SsrfBlockedError,
} from "./network/ssrf";
export * from "./prompts";
export * from "./recent-messages-state";
export * from "./roles";
export * from "./runtime";
export { actionGateRejection } from "./runtime/action-gate";
export { warnOnUnmatchedActionRolePolicyKeys } from "./runtime/action-role-policy";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export {
	__resetDirectActionRoutingRulesForTests,
	type DirectActionRoutingRule,
	getDirectActionRoutingRules,
	registerDirectActionRoutingRule,
} from "./runtime/direct-action-routing";
export * from "./runtime/execute-planned-tool-call";
export * from "./runtime/rlm";
export * from "./runtime/schema-compat";
export * from "./runtime/shortcut-registry";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime-route-context";
export * from "./sandbox-policy";
// Export schemas (including buildBaseTables for plugin-sql browser/PGLite builds)
export * from "./schemas/character";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
// Log/text redaction is pure string+object logic with no Node deps, so it is
// browser-safe; cloud-shared's logger (bundled into the app UI) imports
// isSensitiveKeyName/redactLogArgs from the root barrel (#12572 follow-up).
export * from "./security/redact";
export {
	disclosureGateFailure,
	evaluateOwnerExclusiveDisclosure,
	getTrustedDeliveryAudience,
	OWNER_EXCLUSIVE_DISCLOSURE_GATE,
	type OwnerExclusiveDisclosureDecision,
	type OwnerExclusiveDisclosureDenial,
	ownerExclusiveDisclosureWasUsed,
	PRIVACY_DENIED_TEXT,
	type TrustedDeliveryAudience,
	type TrustedDeliveryAudienceKind,
	type TrustedDeliveryAudienceProvenance,
	trustedDeliveryAudienceCacheKey,
} from "./security/trusted-delivery-audience";
export * from "./sensitive-request-policy";
export * from "./sensitive-requests";
export * from "./services";
export * from "./services/agentEvent";
// Server/runtime entry points also register these; the browser bundle must
// expose the same symbols so Vite/esbuild can statically resolve plugins that
// list them in `services` (see @elizaos/agent runtime).
export { AgentEventService } from "./services/agentEvent";
export * from "./services/message";
export * from "./services/post-delivery-task-tracker";
export * from "./services/trajectories";
export * from "./settings";
// Settings-debug sanitizers are pure functions (process access is feature-detected),
// so they are safe in the browser bundle. Re-exported so @elizaos/shared can
// forward them from its browser-safe barrel.
export {
	isElizaSettingsDebugEnabled,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug";
export * from "./streaming-context";
export * from "./target-sources";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
// Export everything from types (type-only, safe for browser)
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/message-service";
export { PENDING_USER_ACTION_WEIGHT } from "./types/pending-user-action";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
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
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/boolean";
export * from "./utils/buffer";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	DestructiveConfirmationGateResult,
	RequireConfirmationArgs,
} from "./utils/confirmation";
// Unified two-phase confirmation helper for destructive actions. Pure
// runtime-interface logic (no node builtins), so it is browser-safe and must
// be exported from both entrypoints — plugins that gate destructive ops (e.g.
// plugin-wallet) import it and may be bundled for the browser.
export {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./utils/confirmation";
export * from "./utils/description-compressed-lint";
export * from "./utils/deterministic";
// Export browser-compatible utilities
export * from "./utils/environment";
export { getEnv } from "./utils/environment";
export * from "./utils/extraction-evidence";
export { formatError } from "./utils/format-error";
export * from "./utils/html-raw-text";
export * from "./utils/project-memory-scope";
export * from "./utils/read-env";
export * from "./utils/resolve-setting";
export * from "./utils/streaming";
export { ResponseSkeletonStreamExtractor } from "./utils/streaming";
export * from "./utils/well-formed";
// Validation helpers (validateActionKeywords / validateActionRegex /
// secret-format validators) are pure functions with no Node-only deps,
// so they're safe in the browser bundle. Several plugin browser dists
// (e.g. @elizaos/plugin-wallet) statically import these names — without
// this re-export Rolldown reports MISSING_EXPORT at consumer build time.
export * from "./validation";

function readBrowserEnv(
	env: Record<string, string | undefined> | undefined,
	key: string,
): string | undefined {
	const value = env?.[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}

export function getElizaNamespace(
	env: Record<string, string | undefined> = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env ?? {},
): string {
	return readBrowserEnv(env, "ELIZA_NAMESPACE") ?? "eliza";
}

export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~/")) return `/${trimmed.slice(2)}`;
	return trimmed;
}

export function resolveStateDir(
	env: Record<string, string | undefined> = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env ?? {},
): string {
	const explicit = readBrowserEnv(env, "ELIZA_STATE_DIR");
	if (explicit) return explicit;
	const namespace = getElizaNamespace(env);
	const xdgStateHome = readBrowserEnv(env, "XDG_STATE_HOME");
	return `${xdgStateHome ?? "/.local/state"}/${namespace}`;
}

// Browser alternatives for Node-only path helpers. These exist on the Node entry
// (see utils/state-dir.ts) and are imported by server-side runtime modules
// (e.g. @elizaos/agent/src/config/paths.ts) that may be statically reached
// by the renderer bundle's dep graph. The values returned are unused in the
// browser; we just need named exports so Rollup's static analysis succeeds.
export function resolveOAuthDir(): string {
	return "/.local/state/eliza/credentials";
}

export async function runPluginMigrations(): Promise<void> {
	// Browser bundles do not own plugin migration state.
}

// Browser-specific exports for Node-only feature probes.
export const isBrowser = true;
export const isNode = false;

/**
 * Browser health-check export. Server health is not applicable in browser
 * bundles, so callers get a stable positive probe result with browser context.
 */
export const serverHealth = {
	check: async () => ({ status: "not-applicable", environment: "browser" }),
	isHealthy: () => true,
};

// Cloud-routing helpers (`toRuntimeSettings`, etc.) are pure functions
// used by app-core's sensitive-requests/cloud-link-adapter at static
// import time. Browser-safe — no Node deps — so include them here so
// Rollup can satisfy the named import without falling back to the
// virtual module replacement plugin.
export * from "./cloud-routing";

export {
	isPermanentQuotaError,
	providerRetryAfterMs,
} from "./utils/model-retry";
