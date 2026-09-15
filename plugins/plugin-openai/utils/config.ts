/**
 * Central settings and endpoint resolution for the plugin: `getSetting` reads
 * runtime config first then `process.env`, and the typed getters here resolve
 * every model slot, base URL, auth header, embedding dimension, and timeout with
 * their documented fallback chains. Also home to provider-mode detection
 * (Cerebras / EvoLink / proxy) and the browser-vs-node branch that decides
 * whether an `Authorization` header is sent.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CEREBRAS_TEXT_MODEL, logger } from "@elizaos/core";

function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  const value = process.env[key];
  return value === undefined ? undefined : String(value);
}

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return getEnvValue(key) ?? defaultValue;
}
export function getRequiredSetting(
  runtime: IAgentRuntime,
  key: string,
  errorMessage?: string
): string {
  const value = getSetting(runtime, key);
  if (value === undefined || value.trim() === "") {
    throw new Error(errorMessage ?? `Required setting '${key}' is not configured`);
  }
  return value;
}

export function getNumericSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number
): number {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Setting '${key}' must be a positive integer within JavaScript's safe range, got: ${value}`
    );
  }
  return parsed;
}

export function getBooleanSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: boolean
): boolean {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "OPENAI_BROWSER_BASE_URL");
}

/**
 * True when the resolved base URL or `ELIZA_PROVIDER` setting marks the
 * runtime as using Cerebras's OpenAI-compatible endpoint. Used to scope
 * the `CEREBRAS_API_KEY` alias so OpenAI users are not affected.
 */
export function isCerebrasMode(runtime: IAgentRuntime): boolean {
  const explicitProvider = getSetting(runtime, "ELIZA_PROVIDER");
  if (explicitProvider && explicitProvider.toLowerCase() === "cerebras") {
    return true;
  }
  const baseURL = getSetting(runtime, "OPENAI_BASE_URL");
  if (baseURL && /(^|\.)cerebras\.ai(\/|$)/i.test(baseURL)) {
    return true;
  }
  const cerebrasKey = getSetting(runtime, "CEREBRAS_API_KEY");
  if (
    cerebrasKey &&
    !getSetting(runtime, "OPENAI_API_KEY") &&
    !getSetting(runtime, "OPENAI_BASE_URL")
  ) {
    return true;
  }
  return false;
}

/**
 * True when the resolved base URL or `ELIZA_PROVIDER` setting marks the
 * runtime as using EvoLink's OpenAI-compatible endpoint. Used to scope the
 * `EVOLINK_API_KEY` alias so OpenAI users are not affected.
 */
export function isEvoLinkMode(runtime: IAgentRuntime): boolean {
  const explicitProvider = getSetting(runtime, "ELIZA_PROVIDER");
  if (explicitProvider && explicitProvider.toLowerCase() === "evolink") {
    return true;
  }
  const baseURL = getSetting(runtime, "OPENAI_BASE_URL");
  if (baseURL && /(^|\.)evolink\.ai(\/|$)/i.test(baseURL)) {
    return true;
  }
  const evolinkKey = getSetting(runtime, "EVOLINK_API_KEY");
  if (
    evolinkKey &&
    !getSetting(runtime, "OPENAI_API_KEY") &&
    !getSetting(runtime, "OPENAI_BASE_URL")
  ) {
    return true;
  }
  return false;
}

/**
 * Identifies the backend selected by this OpenAI-compatible plugin. Telemetry
 * must distinguish the transport implementation from the service that
 * actually handled and billed the request.
 */
export function getUsageProvider(
  runtime: IAgentRuntime
): "cerebras" | "evolink" | "openai" | "openrouter" {
  if (isCerebrasMode(runtime)) {
    return "cerebras";
  }
  if (isEvoLinkMode(runtime)) {
    return "evolink";
  }
  return "openai";
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  // Cerebras serves an OpenAI-compatible API. When the runtime is pointed at
  // Cerebras (either via `ELIZA_PROVIDER=cerebras` or an `OPENAI_BASE_URL`
  // matching `*.cerebras.ai`), accept `CEREBRAS_API_KEY` as a synonym for
  // `OPENAI_API_KEY`. Cerebras key is checked first so an explicit Cerebras
  // key wins over a stale OpenAI key in the same env.
  if (isCerebrasMode(runtime)) {
    const cerebrasKey = getSetting(runtime, "CEREBRAS_API_KEY");
    if (cerebrasKey) {
      return cerebrasKey;
    }
  }
  if (isEvoLinkMode(runtime)) {
    const evolinkKey = getSetting(runtime, "EVOLINK_API_KEY");
    if (evolinkKey) {
      return evolinkKey;
    }
  }
  return getSetting(runtime, "OPENAI_API_KEY");
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "OPENAI_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[OpenAI] Using specific embedding API key");
    return embeddingApiKey;
  }
  logger.debug("[OpenAI] Falling back to general API key for embeddings");
  return getApiKey(runtime);
}

export function getAuthHeader(
  runtime: IAgentRuntime,
  forEmbedding = false
): Record<string, string> {
  // By default this plugin does NOT send auth headers in the browser. This is safer because
  // frontend builds would otherwise expose secrets. For local demos, you can explicitly
  // opt-in to sending the Authorization header by setting OPENAI_ALLOW_BROWSER_API_KEY=true.
  if (isBrowser() && !getBooleanSetting(runtime, "OPENAI_ALLOW_BROWSER_API_KEY", false)) {
    return {};
  }
  const key = forEmbedding ? getEmbeddingApiKey(runtime) : getApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function authHeaderForKey(runtime: IAgentRuntime, key: string | undefined): Record<string, string> {
  if (isBrowser() && !getBooleanSetting(runtime, "OPENAI_ALLOW_BROWSER_API_KEY", false)) {
    return {};
  }
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Provides setting values to the pure endpoint resolver. */
export type EndpointSettingReader = (key: string) => string | undefined;

function normalizeEndpointSetting(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Resolve the text API endpoint from an injected setting reader. Keeping this
 * pure lets diagnostics use the exact provider policy without constructing a
 * runtime or depending on the ambient process environment. The scenario
 * runner's `ELIZA_MOCK_OPENAI_BASE` remains authoritative when present.
 */
export function resolveOpenAIBaseURL(
  readSetting: EndpointSettingReader,
  options: { browser?: boolean; mockBaseURL?: string } = {}
): string {
  const read = (key: string): string | undefined => normalizeEndpointSetting(readSetting(key));
  const explicitProvider = read("ELIZA_PROVIDER")?.toLowerCase();
  const openAIBaseURL = read("OPENAI_BASE_URL");
  const cerebrasMode =
    explicitProvider === "cerebras" ||
    (openAIBaseURL !== undefined && /(^|\.)cerebras\.ai(\/|$)/i.test(openAIBaseURL)) ||
    (read("CEREBRAS_API_KEY") !== undefined &&
      read("OPENAI_API_KEY") === undefined &&
      openAIBaseURL === undefined);
  const evolinkMode =
    explicitProvider === "evolink" ||
    (openAIBaseURL !== undefined && /(^|\.)evolink\.ai(\/|$)/i.test(openAIBaseURL)) ||
    (read("EVOLINK_API_KEY") !== undefined &&
      read("OPENAI_API_KEY") === undefined &&
      openAIBaseURL === undefined);

  if (options.browser) {
    const browserURL = read("OPENAI_BROWSER_BASE_URL");
    if (browserURL) return browserURL;
  }
  return (
    normalizeEndpointSetting(options.mockBaseURL) ??
    openAIBaseURL ??
    (cerebrasMode ? (read("CEREBRAS_BASE_URL") ?? "https://api.cerebras.ai/v1") : undefined) ??
    (evolinkMode ? (read("EVOLINK_BASE_URL") ?? "https://direct.evolink.ai/v1") : undefined) ??
    "https://api.openai.com/v1"
  );
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const baseURL = resolveOpenAIBaseURL(
    (key) => {
      const runtimeValue = runtime.getSetting(key);
      const normalizedRuntime = normalizeEndpointSetting(
        runtimeValue === undefined || runtimeValue === null ? undefined : String(runtimeValue)
      );
      return normalizedRuntime ?? getEnvValue(key);
    },
    {
      browser: isBrowser(),
      mockBaseURL: getEnvValue("ELIZA_MOCK_OPENAI_BASE"),
    }
  );
  return baseURL;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? (getSetting(runtime, "OPENAI_BROWSER_EMBEDDING_URL") ??
      getSetting(runtime, "OPENAI_BROWSER_BASE_URL"))
    : getSetting(runtime, "OPENAI_EMBEDDING_URL");

  if (embeddingURL) {
    return embeddingURL;
  }

  logger.debug("[OpenAI] Falling back to general base URL for embeddings");
  return getBaseURL(runtime);
}

export function getImageDescriptionApiKey(runtime: IAgentRuntime): string | undefined {
  const imageDescriptionApiKey = getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_API_KEY");
  if (imageDescriptionApiKey) {
    return imageDescriptionApiKey;
  }
  const imageDescriptionURL = getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_BASE_URL");
  if (imageDescriptionURL && /(^|\.)openai\.com(\/|$)/i.test(imageDescriptionURL)) {
    return getSetting(runtime, "OPENAI_API_KEY");
  }
  return getApiKey(runtime);
}

export function getImageDescriptionAuthHeader(runtime: IAgentRuntime): Record<string, string> {
  return authHeaderForKey(runtime, getImageDescriptionApiKey(runtime));
}

export function getImageDescriptionBaseURL(runtime: IAgentRuntime): string {
  const imageDescriptionURL = getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_BASE_URL");
  if (imageDescriptionURL) {
    return imageDescriptionURL;
  }
  return getBaseURL(runtime);
}

function getCerebrasSmallModel(runtime: IAgentRuntime): string | undefined {
  return isCerebrasMode(runtime)
    ? (getSetting(runtime, "CEREBRAS_SMALL_MODEL") ??
        getSetting(runtime, "CEREBRAS_MODEL", DEFAULT_CEREBRAS_TEXT_MODEL))
    : undefined;
}

function getCerebrasLargeModel(runtime: IAgentRuntime): string | undefined {
  return isCerebrasMode(runtime)
    ? (getSetting(runtime, "CEREBRAS_LARGE_MODEL") ??
        getSetting(runtime, "CEREBRAS_MODEL", DEFAULT_CEREBRAS_TEXT_MODEL))
    : undefined;
}

function getEvoLinkModel(runtime: IAgentRuntime): string | undefined {
  return isEvoLinkMode(runtime) ? (getSetting(runtime, "EVOLINK_MODEL") ?? "gpt-5.2") : undefined;
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_SMALL_MODEL") ??
    getCerebrasSmallModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "SMALL_MODEL") ??
    "gpt-5.6-luna"
  );
}

export function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_NANO_MODEL") ??
    getCerebrasSmallModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_MEDIUM_MODEL") ??
    getCerebrasSmallModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_LARGE_MODEL") ??
    getCerebrasLargeModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "LARGE_MODEL") ??
    "gpt-5.6-sol"
  );
}

export function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "OPENAI_SHOULD_RESPOND_MODEL") ??
    getCerebrasSmallModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "OPENAI_PLANNER_MODEL") ??
    getCerebrasSmallModel(runtime) ??
    getEvoLinkModel(runtime) ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getMediumModel(runtime)
  );
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_MODEL") ?? "gpt-5-mini";
}

export function getTranscriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TRANSCRIPTION_MODEL") ?? "gpt-5-mini-transcribe";
}

export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_MODEL") ?? "gpt-5-mini-tts";
}

export function getTTSVoice(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_VOICE") ?? "nova";
}

export function getTTSInstructions(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_INSTRUCTIONS") ?? "";
}

export function getImageModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_MODEL") ?? "dall-e-3";
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  return getBooleanSetting(runtime, "OPENAI_EXPERIMENTAL_TELEMETRY", false);
}

export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS", 1536);
}

export function getResearchModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_RESEARCH_MODEL") ?? "o3-deep-research";
}

export function getResearchTimeout(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_RESEARCH_TIMEOUT", 3600000);
}
