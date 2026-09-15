/**
 * Cloudflare Workers entry point for the Eliza runtime and plugin contracts.
 *
 * Workers run this surface with `nodejs_compat`, which supplies the supported
 * Node APIs used by core while preserving Web Platform request and storage
 * boundaries. Host-only provisioning and plugin discovery stay outside this
 * entry; durable product state must still live in an injected database adapter,
 * Durable Object, or external service rather than the request-local filesystem.
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
export * from "./capabilities";
export * from "./character";
export * from "./character-utils";
export * from "./connection";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/oauth-role";
export * from "./connectors/privacy";
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
} from "./constants";
export * from "./contracts/computer-use";
export * from "./database";
export * from "./database/connector-json";
export * from "./database/document-list-query";
export * from "./database/inMemoryAdapter";
export * from "./database/world-metadata-cas";
export * from "./entities";
export * from "./errors";
export { generateMediaAction } from "./features/advanced-capabilities/actions/generateMedia";
export * from "./features/basic-capabilities/index.edge";
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export type { InferenceTurnSummary } from "./inference-timing";
export * from "./logger";
export * from "./markdown";
export * from "./memory";
export * from "./messaging/interactions";
export * from "./name-tokens";
// Literal-host SSRF policy helpers are pure and safe in Workers; DNS pinning
// remains outside the edge barrel.
export { isBlockedHostname, isPrivateIpAddress } from "./network/ssrf";
export * from "./plugin";
export * from "./prompts";
export * from "./providers/recent-errors";
export * from "./providers/setup-progress";
export * from "./providers/skill-eligibility";
export * from "./roles";
export * from "./runtime";
export { actionGateRejection } from "./runtime/action-gate";
export * from "./runtime/rlm";
export * from "./runtime/system-prompt";
export * from "./schemas/character";
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./search/keyless-web-search";
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/message";
export { NotificationService } from "./services/notification";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/post-delivery-task-tracker";
export * from "./services/runtime-capability-service";
export * from "./services/setup-cli";
export * from "./services/setup-rpc";
export * from "./services/setup-state";
export * from "./services/tool-policy";
export * from "./services/trajectories";
export * from "./services/triggerScheduling";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
export * from "./types/setup";
export * from "./utils";
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml,
	parseToonKeyValue,
} from "./utils";
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
export * from "./utils/channel-utils";
export * from "./utils/description-compressed-lint";
export { stableStringify } from "./utils/deterministic";
export * from "./utils/environment";
export * from "./utils/extraction-evidence";
export * from "./utils/html-raw-text";
export * from "./utils/model-errors";
export * from "./utils/prompt-compression";
export * from "./utils/read-env";
export * from "./utils/resolve-setting";
export * from "./utils/streaming";
export * from "./utils/well-formed";
export * from "./validation";

export const isBrowser = false;
export const isNode = false;
export const isEdge = true;

export {
	isPermanentQuotaError,
	providerRetryAfterMs,
} from "./utils/model-retry";
