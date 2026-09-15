/** Resolves Cloud model and endpoint settings from runtime and environment state. */
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger, resolveSetting } from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  type DevCloudEnvAuthority,
} from "@elizaos/shared";

export const DEFAULT_ELIZA_CLOUD_LARGE_MODEL =
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL;

/**
 * Runtime config first, then `process.env`, then the supplied default.
 *
 * Thin wrapper over core `resolveSetting` so the precedence lives in one
 * canonical place. The env fallback uses dotenv semantics (trimmed; empty
 * strings treated as unset).
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  return defaultValue === undefined
    ? resolveSetting(runtime, key)
    : resolveSetting(runtime, key, { defaultValue });
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
}

export type EndpointSettingReader = (key: string) => string | undefined;

/** Atomic Cloud endpoint and credential choice used by outbound SDK clients. */
export interface CloudSdkAuthorityTuple {
  readonly authority: DevCloudEnvAuthority | null;
  readonly apiBaseUrl: string;
  readonly apiKey: string | undefined;
  readonly outboundAllowed: boolean;
}

/** Pure endpoint policy shared by inference and diagnostic surfaces. */
export function resolveElizaCloudBaseURL(
  readSetting: EndpointSettingReader,
  options: { browser?: boolean } = {}
): string {
  const read = (key: string): string | undefined => {
    const value = readSetting(key)?.trim();
    return value ? value : undefined;
  };
  return (
    (options.browser ? read("ELIZAOS_CLOUD_BROWSER_BASE_URL") : undefined) ??
    read("ELIZAOS_CLOUD_BASE_URL") ??
    "https://api.eliza.app/api/v1"
  );
}

function resolveUnmanagedBaseURL(runtime: IAgentRuntime): string {
  return resolveElizaCloudBaseURL(
    (key) => {
      const runtimeValue = runtime.getSetting(key);
      const normalizedRuntime =
        runtimeValue === undefined || runtimeValue === null
          ? undefined
          : String(runtimeValue).trim() || undefined;
      return normalizedRuntime ?? resolveSetting(null, key);
    },
    { browser: isBrowser() }
  );
}

function resolveUnmanagedEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL") ||
      getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL")
    : getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_URL");
  if (embeddingURL) {
    logger.debug(`[ELIZAOS_CLOUD] Using specific embedding base URL: ${embeddingURL}`);
    return embeddingURL;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general base URL for embeddings.");
  return resolveUnmanagedBaseURL(runtime);
}

function resolveUnmanagedApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
}

function resolveUnmanagedEmbeddingApiKey(
  runtime: IAgentRuntime,
): string | undefined {
  const embeddingApiKey = getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[ELIZAOS_CLOUD] Using specific embedding API key (present)");
    return embeddingApiKey;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general API key for embeddings.");
  return resolveUnmanagedApiKey(runtime);
}

function frozenValue(
  values: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = values[key]?.trim();
  return value || undefined;
}

/**
 * Resolve one immutable endpoint/credential tuple for a Cloud SDK operation.
 *
 * A development launcher authority owns the complete tuple. Runtime settings
 * and later `process.env` mutations must not replace either half. The two
 * deliberately unauthenticated targets also block SDK traffic entirely.
 */
export function resolveCloudSdkAuthorityTuple(
  runtime: IAgentRuntime,
  embedding = false,
): CloudSdkAuthorityTuple {
  const snapshot =
    !isBrowser() && typeof process !== "undefined"
      ? captureDevCloudEnvAuthoritySnapshot(process.env)
      : null;

  if (!snapshot) {
    const apiBaseUrl = embedding
      ? resolveUnmanagedEmbeddingBaseURL(runtime)
      : resolveUnmanagedBaseURL(runtime);
    const apiKey = isBrowser()
      ? undefined
      : embedding
        ? resolveUnmanagedEmbeddingApiKey(runtime)
        : resolveUnmanagedApiKey(runtime);
    return Object.freeze({
      authority: null,
      apiBaseUrl,
      apiKey,
      outboundAllowed: true,
    });
  }

  const blocked =
    snapshot.authority === "staging-default" || snapshot.authority === "offline";
  const embeddingBaseUrl = embedding
    ? frozenValue(snapshot.values, "ELIZAOS_CLOUD_EMBEDDING_URL")
    : undefined;
  const apiBaseUrl =
    embeddingBaseUrl ??
    frozenValue(snapshot.values, "ELIZAOS_CLOUD_BASE_URL") ??
    "";
  const embeddingApiKey = embedding
    ? frozenValue(snapshot.values, "ELIZAOS_CLOUD_EMBEDDING_API_KEY")
    : undefined;
  const apiKey = blocked
    ? undefined
    : embeddingApiKey ?? frozenValue(snapshot.values, "ELIZAOS_CLOUD_API_KEY");

  if (embeddingBaseUrl) {
    logger.debug(
      `[ELIZAOS_CLOUD] Using launcher-authorized embedding base URL: ${embeddingBaseUrl}`,
    );
  }

  return Object.freeze({
    authority: snapshot.authority,
    apiBaseUrl,
    apiKey,
    outboundAllowed: !blocked && Boolean(apiBaseUrl),
  });
}

export function getBaseURL(runtime: IAgentRuntime): string {
  return resolveCloudSdkAuthorityTuple(runtime).apiBaseUrl;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  return resolveCloudSdkAuthorityTuple(runtime, true).apiBaseUrl;
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return resolveCloudSdkAuthorityTuple(runtime).apiKey;
}

/**
 * The Eliza Cloud app this agent's inference should be attributed to (#10423).
 *
 * The managed deploy path injects the platform-authoritative `ELIZA_APP_ID`
 * (the app's UUID) into a deployed app container, so its inference bills the
 * app's credits + the creator's earnings rather than the caller's own org. When
 * set, {@link createCloudApiClient} attaches it as the `X-App-Id` header on
 * every request. The cloud verifies the caller is authorized for the app and
 * falls back to normal (caller-org) billing when it is not — so a non-app agent
 * that happens to carry an unrelated `ELIZA_APP_ID` (e.g. the desktop bundle id)
 * is simply billed normally, never rejected.
 */
export function getAppId(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZA_APP_ID");
}

/**
 * Truthiness for host-written cloud flags: "true" or "1" (trimmed,
 * case-insensitive), mirroring how core `isCloudConnected` reads
 * `ELIZAOS_CLOUD_ENABLED`. Runtime boolean `true` arrives here as the
 * string "true" (getSetting/resolveSetting coerce to string), so callers
 * must read the flag through {@link getSetting} rather than the raw
 * `runtime.getSetting`, which returns the coerced boolean.
 */
export function isTruthyCloudFlag(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "true" || lower === "1";
}

/**
 * Whether Cloud TTS may serve: a Cloud API key is present AND the operator
 * turned cloud audio on — either through the full cloud connection
 * (`ELIZAOS_CLOUD_ENABLED`) or through the per-service routing flag
 * (`ELIZAOS_CLOUD_USE_TTS`) that `applyCloudConfigToEnv` writes in
 * capability-only mode (elizaOS/eliza#10819), where an external provider
 * owns the text brain so `ELIZAOS_CLOUD_ENABLED` deliberately stays unset.
 *
 * This is deliberately NOT a change to core `isCloudConnected`: its other
 * consumers (wallet RPC proxy routing, streaming, tailscale) read ENABLED as
 * "Eliza Cloud is the inference brain" and must keep that coupling. TTS is a
 * capability with an explicit per-service opt-in that has to work without
 * the inference coupling — gating it on ENABLED alone made the registered
 * TEXT_TO_SPEECH handler throw `CloudTtsUnavailableError` on every call in
 * capability-only mode, even when the operator cloud-routed TTS.
 */
export function isCloudTtsAvailable(runtime: IAgentRuntime): boolean {
  const apiKey = getApiKey(runtime);
  if (!apiKey?.trim()) return false;
  return (
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_ENABLED")) ||
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_USE_TTS"))
  );
}

/**
 * Whether Cloud STT (TRANSCRIPTION) may serve. Exact mirror of
 * {@link isCloudTtsAvailable}: a Cloud API key is present AND cloud audio is
 * on — either through the full cloud connection (`ELIZAOS_CLOUD_ENABLED`) or
 * through the per-service flag (`ELIZAOS_CLOUD_USE_STT`, the STT counterpart
 * of `ELIZAOS_CLOUD_USE_TTS`) for capability-only mode where an external
 * provider owns the text brain and `ELIZAOS_CLOUD_ENABLED` stays unset.
 *
 * When this returns false the TRANSCRIPTION handler throws
 * `CloudSttUnavailableError` so the local-inference router's per-pick retry
 * loop falls through to the next eligible provider instead of firing an
 * unauthenticated cloud request.
 */
export function isCloudSttAvailable(runtime: IAgentRuntime): boolean {
  const apiKey = getApiKey(runtime);
  if (!apiKey?.trim()) return false;
  return (
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_ENABLED")) ||
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_USE_STT"))
  );
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  return resolveCloudSdkAuthorityTuple(runtime, true).apiKey;
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ??
    (getSetting(runtime, "SMALL_MODEL", DEFAULT_ELIZA_CLOUD_TEXT_MODEL) as string)
  );
}

export function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_NANO_MODEL") ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEDIUM_MODEL") ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ??
    (getSetting(runtime, "LARGE_MODEL", DEFAULT_ELIZA_CLOUD_LARGE_MODEL) as string)
  );
}

export function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL") ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_PLANNER_MODEL") ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_MODEL") ??
    getSetting(runtime, "RESPONSE_MODEL") ??
    getLargeModel(runtime)
  );
}

/**
 * @deprecated Eliza Cloud research was retired. This compatibility export
 * fails explicitly instead of selecting a text model that cannot do research.
 */
export function getResearchModel(_runtime: IAgentRuntime): never {
  throw new ElizaError(
    "Eliza Cloud no longer provides a RESEARCH model; install a research-capable provider",
    {
      code: "ELIZA_CLOUD_RESEARCH_UNAVAILABLE",
      severity: "fatal",
    },
  );
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL", "gpt-5.4-mini") as string;
}

export function getImageGenerationModel(runtime: IAgentRuntime): string {
  // Must be a cloud SUPPORTED_IMAGE_MODELS id with an image:generation price;
  // the retired BitRouter default (google/gemini-2.5-flash-image) 500'd (#11005).
  return (
    getSetting(
      runtime,
      "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
      "google/nano-banana-2/text-to-image",
    ) ?? "google/nano-banana-2/text-to-image"
  );
}


export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "gpt-5-mini-tts") as string;
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getSetting(runtime, "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY", "false");
  return String(setting).toLowerCase() === "true";
}

/**
 * Resolve a client-side timeout (ms) for a cloud model round-trip from `envKey`,
 * falling back to `defaultMs`. `0`/negative/non-numeric → undefined (opt out).
 *
 * cloud-sdk applies NO default timeout (a fetch with no signal hangs until the
 * platform default), so turn-blocking calls (TTS/STT in a voice turn, deep
 * research) need an explicit ceiling or a stalled gateway hangs the turn.
 */
export function resolveCloudTimeoutMs(
  envKey: string,
  defaultMs: number
): number | undefined {
  const raw = typeof process !== "undefined" ? process.env[envKey] : undefined;
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultMs;
  return parsed <= 0 ? undefined : parsed;
}
