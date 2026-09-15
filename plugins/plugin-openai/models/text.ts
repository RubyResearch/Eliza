/**
 * Text generation model handlers
 *
 * Provides text generation using OpenAI's language models.
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ModelTypeName,
  RecordLlmCallDetails,
} from "@elizaos/core";
import {
  assertActiveTrajectoryForLlmCall,
  assertModelOutputComplete,
  assertSchemaAnnotationsSerializable,
  attestLlmInputSubstring,
  buildCanonicalSystemPrompt,
  cloneSchemaForBoundedTransport,
  deepToWellFormedUnicode,
  dropDuplicateLeadingSystemMessage,
  ElizaError,
  getInferenceTimer,
  getTrajectoryContext,
  isPermanentQuotaError,
  JSON_SCHEMA_ARRAY_KEYWORDS,
  JSON_SCHEMA_MAP_KEYWORDS,
  JSON_SCHEMA_MIXED_MAP_KEYWORDS,
  JSON_SCHEMA_SINGLE_KEYWORDS,
  logActiveTrajectoryLlmCall,
  logger,
  MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
  MAX_WELL_FORMED_DEPTH,
  ModelType,
  normalizeSchemaForCerebras,
  providerRetryAfterMs,
  recordLlmCall,
  resolveEffectiveSystemPrompt,
  sanitizeFunctionNameForCerebras,
  toWellFormedUnicode,
  truncateWellFormed,
  wellFormedUnicodeSchemaStructure,
} from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  RetryError,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";
import { createOpenAIClient } from "../providers";
import type { TextStreamResult, TokenUsage } from "../types";
import {
  getActionPlannerModel,
  getApiKey,
  getBaseURL,
  getExperimentalTelemetry,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSetting,
  getSmallModel,
  getUsageProvider,
  isBrowser,
  isCerebrasMode,
  isProxyMode,
} from "../utils/config";
import { emitModelUsageEvent, type ModelRetryTelemetry } from "../utils/events";

// ============================================================================
// Types
// ============================================================================

/**
 * Function to get model name from runtime
 */
type ModelNameGetter = (runtime: IAgentRuntime) => string;

type PromptCacheRetention = "in_memory" | "24h";
type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

interface OpenAIPromptCacheOptions {
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
}

interface GenerateTextParamsWithOpenAIOptions
  extends Omit<
    GenerateTextParams,
    "messages" | "tools" | "toolChoice" | "responseSchema" | "providerOptions"
  > {
  model?: string;
  attachments?: ChatAttachment[];
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
  providerOptions?: Record<string, object | JsonValue> & {
    agentName?: string;
    openai?: OpenAIPromptCacheOptions;
    cerebras?: { promptCacheKey?: string; prompt_cache_key?: string };
  };
}

type NativeTextOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativeOutput =
  | NativeTextOutput
  | ReturnType<typeof Output.json>
  | ReturnType<typeof Output.object>;
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet, NativeOutput>>[0];
type NativeStreamTextParams = Parameters<typeof streamText<ToolSet, NativeOutput>>[0];
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeTextParams = Omit<NativeGenerateTextParams, "messages" | "prompt"> &
  Omit<NativeStreamTextParams, "messages" | "prompt"> &
  NativePrompt & {
    // Re-declared explicitly: TypeScript's `Parameters<typeof generateText>`
    // inference produces an overload-union that drops this field, but the
    // ai SDK's runtime signature accepts it (see ai@6 `CallSettings & Prompt`).
    allowSystemInMessages?: boolean;
  };
type NativeProviderOptions = NativeTextParams["providerOptions"];
type NativeTelemetrySettings = NativeTextParams["experimental_telemetry"];

type LanguageModelUsageWithCache = Omit<LanguageModelUsage, "inputTokenDetails"> & {
  inputTokenDetails?: LanguageModelUsage["inputTokenDetails"] & {
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheCreationTokens?: number;
  };
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteInputTokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

interface NativeGenerateTextResult {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: TokenUsage;
  providerMetadata?: unknown;
}

type NativeTextModelResult = string & NativeGenerateTextResult;
type RecordArgValueMode = "json-string" | "schema";

interface RecordArgTransform {
  path: string;
  entriesKey: string;
  valueMode: RecordArgValueMode;
}

interface ResponseSchemaTransform {
  restoreText(text: string): string;
}

interface PreparedStructuredOutput {
  output: NativeOutput;
  transform?: ResponseSchemaTransform;
}

interface NormalizedNativeToolsResult {
  tools?: ToolSet;
  recordArgTransformsByTool: Record<string, RecordArgTransform[]>;
  /** Original array-tool name to the exact key registered with the AI SDK. */
  toolNameMap?: ReadonlyMap<string, string>;
}

const TEXT_NANO_MODEL_TYPE = ModelType.TEXT_NANO as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = ModelType.TEXT_MEDIUM as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = ModelType.TEXT_MEGA as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = ModelType.RESPONSE_HANDLER as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = ModelType.ACTION_PLANNER as ModelTypeName;

function resolveRequestedModelName(
  params: GenerateTextParamsWithOpenAIOptions,
  runtime: IAgentRuntime,
  getModelFn: ModelNameGetter
): string {
  return typeof params.model === "string" && params.model.trim().length > 0
    ? params.model.trim()
    : getModelFn(runtime);
}

function buildUserContent(params: GenerateTextParamsWithOpenAIOptions): UserContent {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        data: string | Uint8Array | URL;
        mediaType: string;
        filename?: string;
      }
  > = [{ type: "text", text: params.prompt ?? "" }];

  for (const attachment of params.attachments ?? []) {
    content.push({
      type: "file",
      data: attachment.data,
      mediaType: attachment.mediaType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }

  return content;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts AI SDK usage to our token usage format.
 *
 * Emits both the legacy `cachedPromptTokens` (kept for back-compat with
 * existing OpenAI consumers) and the canonical v5 `cacheReadInputTokens`
 * (consumed by the trajectory recorder + cost table). They always carry the
 * same value when the AI SDK reports cached input.
 */
function convertUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  // The AI SDK uses inputTokens/outputTokens
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const usageWithCache: LanguageModelUsageWithCache = usage;
  const cachedInput =
    firstNumber(
      usageWithCache.cacheReadInputTokens,
      usageWithCache.cachedInputTokens,
      usageWithCache.inputTokenDetails?.cacheReadTokens,
      usageWithCache.inputTokenDetails?.cachedInputTokens,
      usageWithCache.input_tokens_details?.cache_read_input_tokens,
      usageWithCache.input_tokens_details?.cached_tokens,
      usageWithCache.prompt_tokens_details?.cached_tokens
    ) ?? undefined;
  const cacheCreationInput = firstNumber(
    usageWithCache.cacheCreationInputTokens,
    usageWithCache.cacheWriteInputTokens,
    usageWithCache.inputTokenDetails?.cacheCreationInputTokens,
    usageWithCache.inputTokenDetails?.cacheCreationTokens,
    usageWithCache.inputTokenDetails?.cacheWriteTokens,
    usageWithCache.input_tokens_details?.cache_creation_input_tokens
  );
  const reasoningTokens = firstNumber(
    usage.outputTokenDetails?.reasoningTokens,
    usage.reasoningTokens
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: cachedInput,
    cacheReadInputTokens: cachedInput,
    cacheCreationInputTokens: cacheCreationInput,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function resolvePromptCacheOptions(
  params: GenerateTextParams,
  runtime: IAgentRuntime
): OpenAIPromptCacheOptions {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  const cerebras = withOpenAIOptions.providerOptions?.cerebras;
  if (isCerebrasMode(runtime) && cerebras && typeof cerebras === "object") {
    const camel = "promptCacheKey" in cerebras ? cerebras.promptCacheKey : undefined;
    const snake = "prompt_cache_key" in cerebras ? cerebras.prompt_cache_key : undefined;
    return {
      promptCacheKey:
        typeof camel === "string" ? camel : typeof snake === "string" ? snake : undefined,
    };
  }
  return {
    promptCacheKey: withOpenAIOptions.providerOptions?.openai?.promptCacheKey,
    promptCacheRetention: withOpenAIOptions.providerOptions?.openai?.promptCacheRetention,
  };
}

/**
 * Forward `OPENAI_REASONING_EFFORT` (runtime setting / process.env) as
 * `reasoning_effort` on the outbound chat completions request. This is
 * the OpenAI-spec knob for reasoning-capable models (`o1-*`, `o3-*`,
 * `gpt-oss-*`, `deepseek-r1`, and similar families) — including
 * Cerebras and OpenRouter, which honor the same field. `"low"` keeps
 * reasoning short enough that visible content always fits inside
 * `max_tokens`, which is the failure mode on Cerebras gpt-oss-120b when
 * left unset.
 *
 * In Cerebras mode the field defaults to `"low"` when unset only for the exact
 * models whose current provider contract exposes reasoning controls:
 * `gpt-oss-120b` and `zai-glm-4.7`. Qwen 3.8 defaults to `"none"` for
 * interactive latency; explicit reasoning settings remain authoritative.
 * Family-name lookalikes and models without the knob must not receive the
 * field because compatible endpoints reject unsupported request properties.
 * An explicit valid `OPENAI_REASONING_EFFORT` always wins.
 *
 * Valid values follow the OpenAI spec exactly: `minimal`, `low`,
 * `medium`, `high`. Anything else is logged and ignored.
 */
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

/**
 * Strips the provider prefixes accepted by the cloud gateway while retaining
 * an exact model id. Cerebras documents reasoning controls per model, so family
 * substrings must not opt an unknown or newly added model into a wire field it
 * may reject.
 */
function normalizeCerebrasModelId(modelName: string): string {
  return modelName
    .trim()
    .toLowerCase()
    .replace(/^cerebras[:/]/, "")
    .replace(/^openai\//, "")
    .replace(/:(?!free$).+$/, "");
}

function isOpenCodeGoEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "opencode.ai" &&
      (url.pathname === "/zen/go/v1" || url.pathname.startsWith("/zen/go/v1/"))
    );
  } catch {
    // error-policy:J3 Malformed configuration is not a matching provider URL.
    return false;
  }
}

/**
 * Detects the endpoint contract that translates `reasoning_effort: "none"`.
 *
 * Browser requests terminate at an opaque proxy, so the direct base URL is not
 * proof of the proxy's upstream. Proxy deployments must declare their actual
 * upstream explicitly before this provider-specific wire value is emitted.
 */
function isOpenCodeGoMode(runtime: IAgentRuntime): boolean {
  if (isOpenCodeGoEndpoint(getBaseURL(runtime))) return true;
  return (
    isProxyMode(runtime) &&
    isOpenCodeGoEndpoint(getSetting(runtime, "OPENAI_BROWSER_UPSTREAM_BASE_URL"))
  );
}

/** Maps thinking suppression only for exact model ids on proven endpoints. */
function resolveThinkingOffReasoningEffort(
  runtime: IAgentRuntime,
  modelName: string | undefined
): "low" | "none" | undefined {
  if (!modelName) return undefined;
  const cerebrasId = normalizeCerebrasModelId(modelName);
  if (isCerebrasMode(runtime)) {
    if (cerebrasId === "gpt-oss-120b") return "low";
    if (cerebrasId === "zai-glm-4.7") return "none";
    if (cerebrasId === "gemma-4-31b") return "none";
    if (cerebrasId === "qwen-3.8-27b") return "none";
  }

  const exactModelId = modelName.trim().toLowerCase();
  if (exactModelId === "deepseek-v4-flash" && isOpenCodeGoMode(runtime)) return "none";
  return undefined;
}

/**
 * Per-model Cerebras reasoning default, restricted to models whose provider
 * documentation declares the field. `gemma-4-31b` has no documented reasoning
 * contract, so no default is emitted at all — an undocumented
 * `reasoning_effort` value reaches the wire and can be rejected by the
 * endpoint; callers that deliberately configure a different effort remain
 * authoritative.
 */
function resolveCerebrasDefaultReasoningEffort(
  modelName: string | undefined
): ReasoningEffort | "none" | undefined {
  if (!modelName) return undefined;
  const id = normalizeCerebrasModelId(modelName);
  if (id === "gpt-oss-120b" || id === "zai-glm-4.7") return "low";
  // Cerebras defaults Qwen to high reasoning. Keep ordinary interactive
  // calls non-reasoning unless the caller explicitly requests otherwise.
  if (id === "qwen-3.8-27b") return "none";
  return undefined;
}

function resolveReasoningEffort(
  runtime: IAgentRuntime,
  modelName?: string
): ReasoningEffort | "none" | undefined {
  const raw = runtime.getSetting("OPENAI_REASONING_EFFORT");
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "none") {
    if (
      isCerebrasMode(runtime) &&
      modelName &&
      normalizeCerebrasModelId(modelName) === "qwen-3.8-27b"
    )
      return "none";
    // "none" is a deliberate operator setting that only the documented
    // endpoint above accepts on the wire. For every other model it resolves to
    // that model's documented default below, silently: warning on every call
    // for a recognized value is noise (live 2026-09-06: three warnings per
    // Discord turn on gemma-4-31b, whose default already sends no field).
  } else if (normalized) {
    if ((VALID_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
      return normalized as ReasoningEffort;
    }
    logger.warn(
      `[OpenAI] OPENAI_REASONING_EFFORT=${raw} is not a valid reasoning effort; ignoring. Expected one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
    );
  }
  // The exact provider contract gates this default: family lookalikes may
  // reject the field, while each documented model has its own safe default.
  // An explicit valid value above always wins over this default.
  if (isCerebrasMode(runtime)) {
    return resolveCerebrasDefaultReasoningEffort(modelName);
  }
  return undefined;
}

function resolveProviderOptions(
  params: GenerateTextParams,
  runtime: IAgentRuntime,
  modelName?: string
): Record<string, unknown> | undefined {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  const rawProviderOptions = withOpenAIOptions.providerOptions;
  const promptCacheOptions = resolvePromptCacheOptions(params, runtime);
  const reasoningEffort = resolveReasoningEffort(runtime, modelName);
  // Thinking-off suppression outranks the env pin and provider default so
  // forced-tool planner calls do not enter an incompatible reasoning mode.
  // Keep this endpoint/model allowlist exact: OpenAI-direct and many compatible
  // endpoints reject `"none"`. An explicit caller value still wins below.
  const elizaThinking = (rawProviderOptions?.eliza as { thinking?: unknown } | undefined)?.thinking;
  const thinkingOffEffort =
    elizaThinking === "off" ? resolveThinkingOffReasoningEffort(runtime, modelName) : undefined;
  const effectiveReasoningEffort = thinkingOffEffort ?? reasoningEffort;

  if (
    !rawProviderOptions &&
    !promptCacheOptions.promptCacheKey &&
    !promptCacheOptions.promptCacheRetention &&
    !effectiveReasoningEffort
  ) {
    return undefined;
  }

  // Cerebras accepts affinity keys, but not OpenAI's retention directive.
  // Resolve its namespace before the SDK's OpenAI-compatible serialization.
  const skipCacheRetention = isCerebrasMode(runtime);

  const { agentName: _agentName, openai: rawOpenAIOptions, ...rest } = rawProviderOptions ?? {};
  // When on Cerebras, scrub OpenAI-direct-only fields (e.g. `promptCacheRetention`)
  // from `rawOpenAIOptions` before they're spread; otherwise they reach the wire
  // and the Cerebras endpoint rejects with HTTP 400 `wrong_api_format`.
  const sanitizedRawOpenAIOptions = (() => {
    if (!rawOpenAIOptions || typeof rawOpenAIOptions !== "object") return rawOpenAIOptions;
    if (!skipCacheRetention) return rawOpenAIOptions;
    const {
      promptCacheRetention: _drop,
      promptCacheKey: _key,
      ...rest2
    } = rawOpenAIOptions as Record<string, unknown>;
    return rest2;
  })();
  const openaiOptions = {
    ...(sanitizedRawOpenAIOptions ?? {}),
    ...(promptCacheOptions.promptCacheKey
      ? { promptCacheKey: promptCacheOptions.promptCacheKey }
      : {}),
    ...(!skipCacheRetention && promptCacheOptions.promptCacheRetention
      ? { promptCacheRetention: promptCacheOptions.promptCacheRetention }
      : {}),
    // The caller's explicit `reasoningEffort` wins over the resolved default
    // (env var, thinking-off suppression, or Cerebras "low") — same precedence
    // pattern as promptCacheKey.
    ...((sanitizedRawOpenAIOptions as { reasoningEffort?: unknown } | undefined)
      ?.reasoningEffort === undefined && effectiveReasoningEffort
      ? { reasoningEffort: effectiveReasoningEffort }
      : {}),
  };

  const providerOptions = {
    ...rest,
    ...(Object.keys(openaiOptions).length > 0 ? { openai: openaiOptions } : {}),
  };

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function buildStructuredOutput(
  responseSchema: unknown,
  modelType: ModelTypeName,
  cerebrasMode = false
): PreparedStructuredOutput {
  if (
    responseSchema &&
    typeof responseSchema === "object" &&
    "responseFormat" in responseSchema &&
    "parseCompleteOutput" in responseSchema
  ) {
    return { output: responseSchema as NativeOutput };
  }

  const schemaOptions =
    responseSchema && typeof responseSchema === "object" && "schema" in responseSchema
      ? (responseSchema as { schema: unknown; name?: string; description?: string })
      : { schema: responseSchema };
  const preparedSchema = prepareResponseFormatSchema(schemaOptions.schema, modelType);

  return {
    output: Output.object({
      schema: jsonSchema(
        cerebrasMode
          ? (preparedSchema.schema as JSONSchema7)
          : sanitizeJsonSchema(preparedSchema.schema, true)
      ),
      ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
      ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
    }) as NativeOutput,
    ...(preparedSchema.transform ? { transform: preparedSchema.transform } : {}),
  };
}

const STRICT_SAFE_PLANNER_ARGS_ENTRIES_KEY = "__eliza_planner_arg_entries";

function prepareResponseFormatSchema(
  schema: unknown,
  modelType: ModelTypeName
): {
  schema: unknown;
  transform?: ResponseSchemaTransform;
} {
  if (modelType !== ACTION_PLANNER_MODEL_TYPE || !isPlannerResponseSchema(schema)) {
    return { schema };
  }

  const root = schema as Record<string, unknown>;
  const rootProperties = asRecord(root.properties);
  const toolCalls = asRecord(rootProperties.toolCalls);
  const toolCallItems = asRecord(toolCalls.items);
  const toolCallProperties = asRecord(toolCallItems.properties);

  return {
    schema: {
      ...root,
      properties: {
        ...rootProperties,
        toolCalls: {
          ...toolCalls,
          items: {
            ...toolCallItems,
            properties: {
              ...toolCallProperties,
              args: strictSafePlannerArgsSchema(),
            },
          },
        },
      },
    },
    transform: { restoreText: restorePlannerArgsResponseText },
  };
}

function isPlannerResponseSchema(schema: unknown): boolean {
  const root = asOptionalRecord(schema);
  const rootProperties = asOptionalRecord(root?.properties);
  const toolCalls = asOptionalRecord(rootProperties?.toolCalls);
  const toolCallItems = asOptionalRecord(toolCalls?.items);
  const toolCallProperties = asOptionalRecord(toolCallItems?.properties);
  const args = asOptionalRecord(toolCallProperties?.args);

  return (
    root?.type === "object" &&
    toolCalls?.type === "array" &&
    toolCallItems?.type === "object" &&
    args?.type === "object" &&
    args.additionalProperties !== false &&
    Array.isArray(root?.required) &&
    root.required.includes("toolCalls")
  );
}

function strictSafePlannerArgsSchema(): JSONSchema7 {
  return {
    type: "object",
    description:
      "Arbitrary planner tool arguments. Put every original args property in __eliza_planner_arg_entries as {key,valueJson}; valueJson must be JSON.stringify(value), so strings include JSON quotes and objects, arrays, numbers, booleans, and null round-trip exactly.",
    properties: {
      [STRICT_SAFE_PLANNER_ARGS_ENTRIES_KEY]: {
        type: "array",
        description:
          "Key/value entries restored to the original planner args object before runtime tool validation.",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            valueJson: {
              type: "string",
              description: "JSON.stringify(value) for this argument key.",
            },
          },
          required: ["key", "valueJson"],
          additionalProperties: false,
        },
      },
    },
    required: [STRICT_SAFE_PLANNER_ARGS_ENTRIES_KEY],
    additionalProperties: false,
  };
}

function restorePlannerArgsResponseText(text: string): string {
  const parsed = JSON.parse(text) as unknown;
  return JSON.stringify(restorePlannerArgsEnvelope(parsed));
}

function restorePlannerArgsEnvelope(value: unknown): unknown {
  const envelope = asOptionalRecord(value);
  if (!envelope || !Array.isArray(envelope.toolCalls)) {
    return value;
  }

  return {
    ...envelope,
    toolCalls: envelope.toolCalls.map((toolCall) => {
      const call = asOptionalRecord(toolCall);
      if (!call || !("args" in call)) {
        return toolCall;
      }
      return {
        ...call,
        args: restoreStrictSafePlannerArgs(call.args),
      };
    }),
  };
}

function restoreStrictSafePlannerArgs(value: unknown): unknown {
  const record = asOptionalRecord(value);
  if (!record) return value;
  if (!Object.hasOwn(record, STRICT_SAFE_PLANNER_ARGS_ENTRIES_KEY)) return value;
  const entries = record[STRICT_SAFE_PLANNER_ARGS_ENTRIES_KEY];
  if (!Array.isArray(entries)) {
    throw new Error("Malformed strict-safe planner args: entries must be an array.");
  }

  const restored: Record<string, unknown> = Object.create(null);
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    const row = asOptionalRecord(entry);
    if (!row) {
      throw new Error("Malformed strict-safe planner args: entry must be an object.");
    }
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== 2 || !rowKeys.includes("key") || !rowKeys.includes("valueJson")) {
      throw new Error(
        "Malformed strict-safe planner args: entry must contain only key and valueJson."
      );
    }
    const key = typeof row.key === "string" ? row.key : undefined;
    if (key === undefined || typeof row.valueJson !== "string") {
      throw new Error(
        "Malformed strict-safe planner args: entry requires string key and valueJson."
      );
    }
    if (seenKeys.has(key)) {
      throw new Error(`Malformed strict-safe planner args: duplicate key ${JSON.stringify(key)}.`);
    }
    seenKeys.add(key);
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(row.valueJson) as unknown;
    } catch (error) {
      throw new Error(
        `Malformed strict-safe planner args: invalid JSON for key ${JSON.stringify(key)}.`,
        {
          cause: error,
        }
      );
    }
    Object.defineProperty(restored, key, {
      value: parsedValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return restored;
}

function sanitizeToolDescriptionPreservingDescriptors<T extends object>(tool: T): T {
  const descriptor = Object.getOwnPropertyDescriptor(tool, "description");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
    return tool;
  }
  const description = toWellFormedUnicode(descriptor.value);
  if (description === descriptor.value) return tool;
  const sanitized = Object.create(Object.getPrototypeOf(tool)) as T;
  Object.defineProperties(sanitized, Object.getOwnPropertyDescriptors(tool));
  Object.defineProperty(sanitized, "description", { ...descriptor, value: description });
  return sanitized;
}

/** Resolve optional-property opt-in before choosing request-wide provider strictness. */
function nativeToolStrictness(
  tool: Record<string, unknown>,
  functionTool: Record<string, unknown>,
  cerebrasMode: boolean | undefined
): boolean | undefined {
  const declared =
    typeof tool.strict === "boolean"
      ? tool.strict
      : typeof functionTool.strict === "boolean"
        ? functionTool.strict
        : undefined;
  const optionalCompatible =
    typeof tool.strictWithOptionalProperties === "boolean"
      ? tool.strictWithOptionalProperties
      : functionTool.strictWithOptionalProperties === true;
  return declared === false && cerebrasMode && optionalCompatible ? true : declared;
}

/**
 * Native tool normalization plus the strict-safe record/map transform selected
 * for #13111. Tool schemas still close every object with additionalProperties:
 * false for strict-grammar providers (#11123/#11156), but a DECLARED open map
 * gets a model-facing `__eliza_record_entries` key/value array. Returned tool
 * calls are reverse-mapped before the runtime validates against the original
 * schema, so tool authors still receive the object shape they declared.
 */
function normalizeNativeToolsForCall(
  tools: unknown,
  options: { cerebrasMode?: boolean; sanitizeUnicode?: boolean } = {}
): NormalizedNativeToolsResult {
  const recordArgTransformsByTool: Record<string, RecordArgTransform[]> = {};
  const toolNameMap = new Map<string, string>();

  if (!tools) {
    return { recordArgTransformsByTool, toolNameMap };
  }

  // Existing AI SDK callers already pass a ToolSet keyed by tool name. Keep it
  // descriptor-compatible so custom tool instances, execute hooks, lazy schema
  // wrappers, and dynamic metadata are preserved. Raw object-style definitions
  // are still sanitized before the SDK observes them.
  if (!Array.isArray(tools)) {
    const toolSet = tools as ToolSet;
    const descriptors = Object.getOwnPropertyDescriptors(toolSet);
    let changed = false;
    const sanitized = Object.create(Object.getPrototypeOf(toolSet)) as ToolSet;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (!descriptor) continue;
      const sanitizedKey: string = typeof key === "string" ? toWellFormedUnicode(key) : String(key);
      if (Object.hasOwn(sanitized, sanitizedKey)) {
        throw new ElizaError("[OpenAI] Native tool names collide after Unicode normalization.", {
          code: "OPENAI_TOOL_NAME_COLLISION",
          severity: "ephemeral",
        });
      }
      let nextDescriptor = descriptor;
      if ("value" in descriptor) {
        const tool = descriptor.value;
        if (tool && typeof tool === "object") {
          const inputSchemaDescriptor = Object.getOwnPropertyDescriptor(tool, "inputSchema");
          const parametersDescriptor = Object.getOwnPropertyDescriptor(tool, "parameters");
          const sanitizedTool = inputSchemaDescriptor
            ? sanitizeToolDescriptionPreservingDescriptors(tool)
            : parametersDescriptor
              ? deepToWellFormedUnicode(tool)
              : sanitizeToolDescriptionPreservingDescriptors(tool);
          if (sanitizedTool !== tool) {
            nextDescriptor = { ...descriptor, value: sanitizedTool };
            changed = true;
          }
        }
      }
      if (sanitizedKey !== key && typeof key === "string") {
        const originalKey = key as string;
        toolNameMap.set(originalKey, sanitizedKey);
        changed = true;
      }
      Object.defineProperty(sanitized, sanitizedKey, nextDescriptor);
    }
    return {
      tools: changed ? sanitized : toolSet,
      recordArgTransformsByTool,
      toolNameMap,
    };
  }

  const toolSet: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const originalNameByRegisteredName = new Map<string, string>();

  // Cerebras's grammar compiler treats strictness as request-wide, not
  // per-tool: one non-strict (or unflagged) tool downgrades every tool in the
  // call, so the wire flag must be emitted uniformly — and always explicitly,
  // since an omitted flag is not the same as false to the compiler. Schema
  // Optional-property-compatible actions can retain strict enforcement here;
  // unopted non-strict tools still keep the whole request non-strict.
  const cerebrasRequestStrict =
    options.cerebrasMode === true &&
    tools.every((rawTool) => {
      const tool = asRecord(rawTool);
      const functionTool = asRecord(tool.function);
      return nativeToolStrictness(tool, functionTool, options.cerebrasMode) === true;
    });

  for (const rawTool of tools) {
    const tool = asRecord(rawTool);
    const functionTool = asRecord(tool.function);
    const name = firstString(tool.name, functionTool.name);

    if (!name) {
      throw new Error("[OpenAI] Native tool definition is missing a name.");
    }

    const description = firstString(tool.description, functionTool.description);
    // A missing schema means the tool takes no arguments. Provider-specific
    // normalization below turns this bare object into the explicit closed
    // shape required by strict grammar compilers.
    const declaredSchema =
      tool.parameters ?? functionTool.parameters ?? ({ type: "object" } satisfies JSONSchema7);
    const strict = nativeToolStrictness(tool, functionTool, options.cerebrasMode);
    const recordArgTransforms: RecordArgTransform[] = [];
    // The production strict Cerebras path used to call sanitizeJsonSchema
    // (raw Array.isArray / object spread / Object.entries / .map / unbounded
    // recursion) BEFORE any descriptor-safe walker, so an 8k-deep, cyclic,
    // revoked, or accessor-bearing schema RangeError'd or leaked a trap
    // there. The pre-pass is a bounded, descriptor-only STRUCTURAL CLONE, not
    // Cerebras normalization: running the normalizer here would close every
    // declared open map with `additionalProperties: false` before
    // sanitizeJsonSchema could read that declaration and build the
    // `__eliza_record_entries` reverse transform (#11249). Provider semantics
    // are applied by the normalizeSchemaForCerebras call after sanitization.
    let rawSchema: unknown = declaredSchema;
    if (options.cerebrasMode) {
      // The bounded transport clone is the SCHEMA depth authority: after it
      // passes, the Unicode pass must not re-fail the same graph on a smaller,
      // container-counting budget. The structure walker uses one depth unit per
      // schema node (same accounting as normalizeSchemaForCerebras) and carries
      // annotation subtrees by reference so hostile annotation getters are
      // never observed here — admissibility is enforced at the wire boundary.
      rawSchema = cloneSchemaForBoundedTransport(rawSchema);
    }
    if (options.sanitizeUnicode) {
      rawSchema = options.cerebrasMode
        ? wellFormedUnicodeSchemaStructure(rawSchema, {
            maxDepth: MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
          })
        : deepToWellFormedUnicode(rawSchema);
    }
    let inputSchema: JSONSchema7;
    if (strict === false) {
      if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
        throw new ElizaError("[OpenAI] Non-strict native tool schema must be a JSON object.", {
          code: "OPENAI_INVALID_NON_STRICT_TOOL_SCHEMA",
          context: { toolName: name },
          severity: "ephemeral",
        });
      }
      inputSchema = rawSchema as JSONSchema7;
    } else {
      inputSchema = sanitizeJsonSchema(rawSchema, true, "$", recordArgTransforms, {
        preserveOptional: options.cerebrasMode,
      });
    }
    if (options.cerebrasMode) {
      // User-supplied schemas may still contain empty-properties subobjects
      // even after sanitizeJsonSchema. Apply Cerebras-specific normalization
      // recursively so deep schemas are accepted by the grammar compiler.
      // Pass isRoot: true so the top-level invariant is enforced (must be
      // type:"object" with no root oneOf/anyOf/enum/not).
      inputSchema = normalizeSchemaForCerebras(inputSchema, true, {
        strict: strict !== false,
      }) as JSONSchema7;
    }

    // Cerebras's grammar compiler rejects function names containing characters
    // outside `[a-zA-Z0-9_-]` (e.g. `math.factorial`). The AI SDK looks up
    // tools by the registered key, so we register under the sanitized name AND
    // surface it to the model under that name. Tool calls come back with the
    // sanitized name, which the runtime resolves through its action registry —
    // any caller relying on dotted action names should pre-sanitize.
    const wellFormedName = deepToWellFormedUnicode(name);
    const registeredName = options.cerebrasMode
      ? sanitizeFunctionNameForCerebras(wellFormedName)
      : wellFormedName;
    const collidingOriginalName = originalNameByRegisteredName.get(registeredName);
    if (collidingOriginalName !== undefined && collidingOriginalName !== name) {
      throw new ElizaError("[OpenAI] Native tool names collide after provider normalization.", {
        code: "OPENAI_TOOL_NAME_COLLISION",
        context: {
          registeredName,
          toolNames: [collidingOriginalName, name],
        },
        severity: "ephemeral",
      });
    }
    originalNameByRegisteredName.set(registeredName, name);
    toolNameMap.set(name, registeredName);
    if (recordArgTransforms.length > 0) {
      recordArgTransformsByTool[registeredName] = recordArgTransforms;
    }

    toolSet[registeredName] = {
      // Caller-controlled strings are sanitized HERE, before the AI SDK
      // jsonSchema() wrapper: the wrapper exposes `jsonSchema` as a lazy
      // enumerable accessor which the strict deep sanitizer rejects fatally,
      // so the assembled ToolSet must never be deep-walked afterwards (every
      // child RESPONSE_HANDLER call died on it, live 2026-08-21).
      ...(description ? { description: deepToWellFormedUnicode(description) } : {}),
      inputSchema: jsonSchema(
        (options.cerebrasMode
          ? wellFormedUnicodeSchemaStructure(inputSchema, {
              maxDepth: MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
            })
          : deepToWellFormedUnicode(inputSchema)) as JSONSchema7
      ),
      ...(options.cerebrasMode
        ? { strict: cerebrasRequestStrict }
        : strict === undefined
          ? {}
          : { strict }),
    };
  }

  return {
    tools: Object.keys(toolSet).length > 0 ? (toolSet as ToolSet) : undefined,
    recordArgTransformsByTool,
    toolNameMap,
  };
}

function normalizeNativeTools(
  tools: unknown,
  options: { cerebrasMode?: boolean; sanitizeUnicode?: boolean } = {}
): ToolSet | undefined {
  return normalizeNativeToolsForCall(tools, options).tools;
}

function normalizeNativeMessages(messages: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return repairToolMessagePairing(messages.map((message) => normalizeNativeMessage(message)));
}

/**
 * OpenAI-strict providers (Cerebras, and the OpenAI API itself) reject any
 * `role: "tool"` message that is not an IMMEDIATE response to an assistant
 * message carrying the matching `tool-call` id — HTTP 400 `Messages with role
 * 'tool' must be a response to a preceeding message with 'tool_calls'` (sic).
 * The trajectory assembler emits well-formed pairs, but history compaction and
 * multi-step summarization upstream can drop the assistant half or interleave
 * other messages between the pair. Two repairs at this single choke point keep
 * the wire contract total:
 *
 * 1. A tool message with no single announcing assistant (orphaned ids, ids
 *    split across assistants, or no ids at all) is demoted to a plain user
 *    message so its content survives on the wire.
 * 2. A paired tool message is re-seated immediately after its announcing
 *    assistant's tool-response block, so strict adjacency holds even when
 *    other messages were interleaved. Everything else keeps its order.
 *
 * A valid message array passes through untouched. Because EVERY outgoing
 * request is normalized here, a provider 400 that still complains about tool
 * pairing is provably spurious — `isTransientProviderError` relies on this
 * invariant to retry that class (observed live 2026-08-07/08: Cerebras
 * intermittently rejected well-formed evaluator requests).
 */
function repairToolMessagePairing(messages: ModelMessage[]): ModelMessage[] {
  interface AssistantNode {
    kind: "assistant";
    message: ModelMessage;
    responses: ModelMessage[];
  }
  interface PlainNode {
    kind: "plain";
    message: ModelMessage;
  }
  const nodes: Array<AssistantNode | PlainNode> = [];
  const announcerById = new Map<string, AssistantNode>();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const node: AssistantNode = { kind: "assistant", message, responses: [] };
      nodes.push(node);
      for (const part of message.content) {
        const id = (part as { type?: unknown; toolCallId?: unknown })?.toolCallId;
        if ((part as { type?: unknown })?.type === "tool-call" && typeof id === "string") {
          announcerById.set(id, node);
        }
      }
      continue;
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      const announcers = new Set(
        message.content.map((part) => {
          const id = (part as { toolCallId?: unknown })?.toolCallId;
          return typeof id === "string" ? announcerById.get(id) : undefined;
        })
      );
      const announcer = announcers.size === 1 ? announcers.values().next().value : undefined;
      if (announcer !== undefined) {
        announcer.responses.push(message);
        continue;
      }
      const salvaged = message.content
        .map((part) => {
          const value = (part as { output?: { value?: unknown } })?.output?.value;
          return typeof value === "string" ? value : JSON.stringify(value);
        })
        .join("\n");
      nodes.push({
        kind: "plain",
        message: {
          role: "user",
          content: `[tool result]\n${salvaged}`,
        } as ModelMessage,
      });
      continue;
    }
    nodes.push({ kind: "plain", message });
  }

  return nodes.flatMap((node) =>
    node.kind === "plain" ? [node.message] : [node.message, ...node.responses]
  );
}

function normalizeNativeMessage(message: unknown): ModelMessage {
  const raw = asRecord(message);
  const providerOptions = asOptionalRecord(raw.providerOptions);

  if (raw.role === "system") {
    return {
      role: "system",
      content: stringifyMessageContent(raw.content),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "assistant") {
    return {
      role: "assistant",
      content: normalizeAssistantContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "tool") {
    return {
      role: "tool",
      content: normalizeToolContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  return {
    role: "user",
    content: normalizeUserContent(raw.content),
    ...(providerOptions ? { providerOptions } : {}),
  } as ModelMessage;
}

/**
 * Strip reasoning-only parts from outbound assistant content.
 *
 * OpenAI-spec reasoning models (Cerebras gpt-oss-120b, OpenAI o1/o3,
 * DeepSeek R1, and similar families) return reasoning in the assistant
 * response — either as a separate `reasoning` / `reasoning_content`
 * field, or as content parts with `type: "reasoning"`. Echoing those
 * back to the next turn is wrong on both ends:
 *   - Cerebras returns HTTP 400 (`messages.X.assistant.reasoning_content:
 *     property is unsupported`).
 *   - OpenAI silently drops them, which wastes prompt tokens.
 *
 * The AI SDK upstream of this normalizer surfaces those reasoning blocks
 * as `{ type: "reasoning", ... }` content parts. We drop them here so
 * the wire stays spec-clean for the next turn. The reasoning itself
 * remains usable as a single-turn signal (still on the response object);
 * we only refuse to round-trip it.
 */
function stripReasoningParts(content: unknown[]): unknown[] {
  return content.filter((part) => {
    if (!part || typeof part !== "object") return true;
    const type = (part as { type?: unknown }).type;
    return type !== "reasoning" && type !== "thinking";
  });
}

function normalizeAssistantContent(message: Record<string, unknown>): unknown {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

  if (toolCalls.length === 0) {
    if (Array.isArray(message.content)) {
      return stripReasoningParts(message.content);
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    return "";
  }

  const parts: unknown[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    parts.push(...stripReasoningParts(message.content));
  }

  for (const toolCall of toolCalls) {
    const rawCall = asRecord(toolCall);
    const rawFunction = asRecord(rawCall.function);
    const toolCallId = firstString(rawCall.toolCallId, rawCall.id);
    const toolName = firstString(rawCall.toolName, rawCall.name, rawFunction.name);

    if (!toolCallId || !toolName) {
      continue;
    }

    parts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      input: parseToolCallInput(rawCall, rawFunction),
    });
  }

  return parts;
}

function normalizeToolContent(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) {
    return message.content;
  }

  const toolCallId = firstString(message.toolCallId, message.id) ?? "tool-call";
  const toolName = firstString(message.toolName, message.name) ?? "tool";
  const parsed = parseJsonIfPossible(message.content);

  return [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output:
        typeof parsed === "string"
          ? { type: "text", value: parsed }
          : { type: "json", value: parsed },
    },
  ];
}

function normalizeUserContent(content: unknown): UserContent {
  if (Array.isArray(content)) {
    return content as UserContent;
  }
  return stringifyMessageContent(content);
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function parseToolCallInput(
  rawCall: Record<string, unknown>,
  rawFunction: Record<string, unknown>
): unknown {
  if ("input" in rawCall) {
    return rawCall.input;
  }
  return parseJsonIfPossible(rawCall.arguments ?? rawFunction.arguments ?? {});
}

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? "";
  }
  try {
    return JSON.parse(value);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — tool-call `arguments` may be a
    // plain (non-JSON) string; returning the raw value is the correct parse of a
    // non-JSON argument, not a swallowed failure.
    return value;
  }
}

function parseRecordArgPath(path: string): string[] {
  if (path === "$") return [];
  if (!path.startsWith("$.")) return [];
  return path.slice(2).split(".");
}

function restoreStrictSafeRecordValue(value: unknown, transform: RecordArgTransform): unknown {
  const record = asOptionalRecord(value);
  if (!record) return value;
  const entries = record[transform.entriesKey];
  if (!Array.isArray(entries)) return value;

  const restored: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key !== transform.entriesKey) {
      restored[key] = nested;
    }
  }

  for (const entry of entries) {
    const row = asOptionalRecord(entry);
    if (!row) continue;
    const key = typeof row.key === "string" ? row.key : undefined;
    if (!key) continue;
    const rawValue = row.value;
    restored[key] =
      transform.valueMode === "json-string" && typeof rawValue === "string"
        ? parseJsonIfPossible(rawValue)
        : rawValue;
  }

  return restored;
}

function restoreRecordArgAtPath(
  value: unknown,
  tokens: string[],
  transform: RecordArgTransform
): unknown {
  if (tokens.length === 0) {
    return restoreStrictSafeRecordValue(value, transform);
  }

  const [token, ...rest] = tokens;
  if (token === "items" && Array.isArray(value)) {
    return value.map((item) => restoreRecordArgAtPath(item, rest, transform));
  }
  if (/^items\[\d+\]$/.test(token)) {
    if (!Array.isArray(value)) return value;
    const index = Number.parseInt(token.slice(6, -1), 10);
    if (index >= value.length) return value;
    const restored = [...value];
    restored[index] = restoreRecordArgAtPath(value[index], rest, transform);
    return restored;
  }
  if (token === "*") {
    const record = asOptionalRecord(value);
    if (!record) return value;
    const restored: Record<string, unknown> = Object.create(null);
    for (const [key, nested] of Object.entries(record)) {
      Object.defineProperty(restored, key, {
        configurable: true,
        enumerable: true,
        value: restoreRecordArgAtPath(nested, rest, transform),
        writable: true,
      });
    }
    return restored;
  }

  const record = asOptionalRecord(value);
  if (!record || !(token in record)) {
    return value;
  }
  return {
    ...record,
    [token]: restoreRecordArgAtPath(record[token], rest, transform),
  };
}

function restoreRecordArgInput(input: unknown, transforms: RecordArgTransform[]): unknown {
  return [...transforms]
    .sort((a, b) => parseRecordArgPath(a.path).length - parseRecordArgPath(b.path).length)
    .reduce(
      (current, transform) =>
        restoreRecordArgAtPath(current, parseRecordArgPath(transform.path), transform),
      input
    );
}

function restoreRecordArgToolCalls(
  toolCalls: unknown,
  transformsByTool: Record<string, RecordArgTransform[]>
): unknown[] | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((toolCall) => {
    const call = asOptionalRecord(toolCall);
    if (!call) return toolCall;
    const rawFunction = asRecord(call.function);
    const toolName = firstString(call.toolName, call.name, rawFunction.name);
    const transforms = toolName ? transformsByTool[toolName] : undefined;
    if (!transforms?.length) return toolCall;

    if ("input" in call) {
      return {
        ...call,
        input: restoreRecordArgInput(call.input, transforms),
      };
    }

    if (typeof call.arguments === "string") {
      const parsed = parseJsonIfPossible(call.arguments);
      return {
        ...call,
        arguments: JSON.stringify(restoreRecordArgInput(parsed, transforms)),
      };
    }

    if (typeof rawFunction.arguments === "string") {
      const parsed = parseJsonIfPossible(rawFunction.arguments);
      return {
        ...call,
        function: {
          ...rawFunction,
          arguments: JSON.stringify(restoreRecordArgInput(parsed, transforms)),
        },
      };
    }

    return toolCall;
  });
}

/**
 * Resolves a forced-tool `toolChoice` to the AI SDK's `{ type: "tool",
 * toolName }` shape. In Cerebras mode the forced name is passed through the
 * exact registered key returned by array-tool normalization. Object `ToolSet`
 * callers already own their keys and therefore pass through verbatim. This
 * keeps a dotted/colon source name aligned with its Cerebras wire key without
 * applying provider rewriting to the distinct object-tool contract.
 */
function normalizeToolChoice(
  toolChoice: unknown,
  options: { toolNameMap?: ReadonlyMap<string, string> } = {}
): ToolChoice<ToolSet> | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (
    typeof toolChoice === "string" &&
    (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
  ) {
    return toolChoice;
  }

  const forcedToolName = (name: string): ToolChoice<ToolSet> => ({
    type: "tool",
    toolName: options.toolNameMap?.get(name) ?? name,
  });

  const choice = asRecord(toolChoice);
  if (choice.type === "tool") {
    // A well-formed object-tool choice passes through by reference. Array-tool
    // callers reconstruct it only when normalization changed its registered key.
    if (typeof choice.toolName === "string" && choice.toolName.length > 0) {
      const registeredName = options.toolNameMap?.get(choice.toolName);
      return registeredName !== undefined && registeredName !== choice.toolName
        ? forcedToolName(choice.toolName)
        : (toolChoice as ToolChoice<ToolSet>);
    }
    const toolName = firstString(choice.toolName, choice.name);
    if (toolName) {
      return forcedToolName(toolName);
    }
  }

  if (choice.type === "function") {
    const fn = asRecord(choice.function);
    const toolName = firstString(fn.name);
    if (toolName) {
      return forcedToolName(toolName);
    }
  }

  const namedTool = firstString(choice.name);
  if (namedTool) {
    return forcedToolName(namedTool);
  }

  return toolChoice as ToolChoice<ToolSet>;
}

function hasIllegalStrictRoot(node: Record<string, unknown>): boolean {
  // Strict-mode JSON schema validators on OpenAI-compatible providers (Groq,
  // Cerebras, OpenAI strict tools) reject tool-parameters whose top level is
  // not `type: "object"` or carries `oneOf`/`anyOf`/`enum`/`not` at the root.
  // The error wording varies by provider but the constraint is uniform.
  if (node.type !== "object") return true;
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) return true;
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return true;
  if (Array.isArray(node.enum)) return true;
  if (node.not !== undefined) return true;
  return false;
}

// Constraint keywords that strict-grammar providers reject with a hard 400
// that fails the ENTIRE request. The exact set was bisected live against
// api.eliza.app / gpt-oss-120b (Cerebras): maxItems/minItems/maxLength/
// minLength/pattern/format/min-maxProperties are rejected; numeric bounds
// (minimum/maximum/multipleOf) and uniqueItems are accepted, so they are NOT
// stripped. Each maps to a human phrase folded into `description` so the model
// still sees the intent after the machine-readable keyword is removed.
const STRICT_UNSUPPORTED_CONSTRAINTS: Record<string, (value: unknown) => string> = {
  maxItems: (v) => `at most ${v} items`,
  minItems: (v) => `at least ${v} items`,
  maxLength: (v) => `at most ${v} characters`,
  minLength: (v) => `at least ${v} characters`,
  pattern: (v) => `matching the pattern ${v}`,
  format: (v) => `in ${v} format`,
  minProperties: (v) => `at least ${v} properties`,
  maxProperties: (v) => `at most ${v} properties`,
};

/**
 * Removes constraint keywords that strict-grammar providers reject, folding
 * each into the node's `description` so the model keeps the guidance. Mutates
 * the passed (already-shallow-copied) node in place.
 *
 * Removing them from the wire is lossless for correctness: `parseAndValidate`
 * (runtime/validated-model-call.ts) re-checks the caller's ORIGINAL schema
 * app-side, so any real bound is still enforced on the returned value.
 */
function stripStrictUnsupportedConstraints(node: Record<string, unknown>): void {
  const hints: string[] = [];
  for (const [keyword, phrase] of Object.entries(STRICT_UNSUPPORTED_CONSTRAINTS)) {
    if (keyword in node) {
      hints.push(phrase(node[keyword]));
      delete node[keyword];
    }
  }
  if (hints.length === 0) return;
  const existing = typeof node.description === "string" ? node.description.trim() : "";
  const suffix = `(${hints.join(", ")})`;
  node.description = existing ? `${existing} ${suffix}` : suffix;
}

/**
 * Human phrase describing a DECLARED free-form/open map so the intent survives
 * when we close the object on the wire. Returns `null` for an undeclared
 * (`undefined`) additionalProperties — that is a plain object, not a data-loss
 * case. `true` → open map of any value; a schema value → open map of that type.
 */
function additionalPropertiesHint(additionalProperties: unknown): string | null {
  if (additionalProperties === true) {
    return "also accepts arbitrary additional properties as key/value pairs";
  }
  if (
    additionalProperties &&
    typeof additionalProperties === "object" &&
    !Array.isArray(additionalProperties)
  ) {
    const valueType = (additionalProperties as Record<string, unknown>).type;
    const typeStr = typeof valueType === "string" ? `${valueType} ` : "";
    return `also accepts arbitrary additional ${typeStr}values as key/value pairs`;
  }
  return null;
}

const STRICT_SAFE_RECORD_ENTRIES_KEY = "__eliza_record_entries";

function chooseRecordEntriesKey(properties: Record<string, unknown>): string {
  if (!(STRICT_SAFE_RECORD_ENTRIES_KEY in properties)) {
    return STRICT_SAFE_RECORD_ENTRIES_KEY;
  }
  let index = 2;
  while (`${STRICT_SAFE_RECORD_ENTRIES_KEY}_${index}` in properties) {
    index++;
  }
  return `${STRICT_SAFE_RECORD_ENTRIES_KEY}_${index}`;
}

function strictSafeRecordValueSchema(
  additionalProperties: unknown,
  transforms?: RecordArgTransform[],
  path = "$",
  options?: Parameters<typeof sanitizeJsonSchema>[4]
): {
  schema: JSONSchema7;
  mode: RecordArgValueMode;
} {
  if (additionalProperties === true) {
    return {
      mode: "json-string",
      schema: {
        type: "string",
        description:
          "JSON-encoded value for this arbitrary key. Use plain text for string values and JSON text for objects, arrays, numbers, booleans, or null.",
      },
    };
  }
  return {
    mode: "schema",
    schema: sanitizeJsonSchema(additionalProperties, false, `${path}.*`, transforms, options),
  };
}

function strictSafeRecordEntriesSchema(valueSchema: JSONSchema7): JSONSchema7 {
  return {
    type: "array",
    description:
      "Additional arbitrary key/value entries for this record/map. Each entry becomes a property on the original tool argument object before validation.",
    items: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Property key to add to the original record/map argument.",
        },
        value: valueSchema,
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  };
}

/**
 * @param path - dotted location threaded through recursion for reverse-mapping
 *   returned tool-call args.
 */
function sanitizeJsonSchema(
  schema: unknown,
  isRoot = false,
  path = "$",
  transforms?: RecordArgTransform[],
  options: {
    preserveOptional?: boolean;
    responseCompatibility?: { preservesShape: boolean };
  } = {}
): JSONSchema7 {
  const { responseCompatibility } = options;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    if (responseCompatibility) responseCompatibility.preservesShape = false;
    // Bare-object fallback. In Cerebras mode `normalizeSchemaForCerebras`
    // closes this afterwards (explicit empty `properties` +
    // `additionalProperties: false`) — Cerebras's grammar compiler rejects a
    // bare `{type: "object"}` with a request-fatal 400. See
    // `normalizeSchemaForCerebras` in @elizaos/core for the live-bisected
    // provider rules.
    return { type: "object" };
  }

  const record = schema as Record<string, unknown>;
  let sanitized: Record<string, unknown> = { ...record };
  if (
    responseCompatibility &&
    (Array.isArray(record.type) ||
      "$ref" in record ||
      "nullable" in record ||
      "dependentRequired" in record ||
      (record.type === "array" &&
        (!record.items || typeof record.items !== "object" || Array.isArray(record.items))))
  ) {
    responseCompatibility.preservesShape = false;
  }

  // Non-Cerebras response schemas and strict/unspecified tool schemas share
  // this compatibility rewrite. Direct Cerebras response schemas bypass it to
  // preserve optional fields; explicit non-strict tools also bypass it.
  // Proxy endpoints can still require strict grammar even when detected as
  // OpenAI, so compatibility normalization remains enabled for those callers.
  stripStrictUnsupportedConstraints(sanitized);

  if (typeof sanitized.type !== "string") {
    const inferredType = inferJsonSchemaType(sanitized, isRoot);
    if (inferredType) {
      if (responseCompatibility) responseCompatibility.preservesShape = false;
      sanitized.type = inferredType;
    }
  }

  if (isRoot && hasIllegalStrictRoot(sanitized)) {
    if (responseCompatibility) responseCompatibility.preservesShape = false;
    // Wrap the original schema under properties.value. Strict-tool callers
    // that unwrap arguments will see `{ value: <original> }`. The recursion
    // below normalises the wrapped child like any other property.
    sanitized = {
      type: "object",
      properties: { value: { ...record } },
      required: ["value"],
      additionalProperties: false,
    };
  }

  if (
    sanitized.properties &&
    typeof sanitized.properties === "object" &&
    !Array.isArray(sanitized.properties)
  ) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized.properties as Record<string, unknown>)) {
      properties[key] = sanitizeJsonSchema(value, false, `${path}.${key}`, transforms, options);
    }
    sanitized.properties = properties;

    const propertyKeys = Object.keys(properties);
    const existingRequired = Array.isArray(sanitized.required)
      ? sanitized.required.filter((key): key is string => typeof key === "string")
      : [];
    // Cerebras supports optional fields in strict tools as well as responses.
    // Requiring unused arguments invents values that fail runtime validation.
    // Retain the all-properties-required rule for other strict providers.
    if (!options.preserveOptional) {
      sanitized.required = [...new Set([...existingRequired, ...propertyKeys])];
    }
  }

  if (sanitized.type === "object" && sanitized.additionalProperties !== false) {
    // An omitted additionalProperties also permits extra keys. Preserve the
    // existing response contract unless the caller explicitly closed it.
    if (responseCompatibility) responseCompatibility.preservesShape = false;
    // Strict-grammar providers reject open maps (schema-valued or `true`
    // additionalProperties) with a hard 400, and provider strictness is
    // proxy-blind (an agent on api.eliza.app with OPENAI_API_KEY may still
    // route to strict Cerebras — #11123/#11156), so we must always close the
    // object on the wire. But a DECLARED free-form map (e.g. contact
    // customFields = `additionalProperties: { type: "string" }`) was collapsed
    // SILENTLY: the model saw a closed object, could emit no keys, and the arg
    // always arrived empty (#11249). Fold the intent into `description`
    // (mirroring stripStrictUnsupportedConstraints) so it is preserved —
    // non-strict providers can still emit the pairs (app-side parseAndValidate
    // re-checks the caller's ORIGINAL schema and accepts them), and strict
    // providers surface the intent instead of losing it without a trace.
    const hint = additionalPropertiesHint(sanitized.additionalProperties);
    if (hint && transforms) {
      const properties =
        sanitized.properties &&
        typeof sanitized.properties === "object" &&
        !Array.isArray(sanitized.properties)
          ? ({ ...(sanitized.properties as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      const entriesKey = chooseRecordEntriesKey(properties);
      const { schema: valueSchema, mode } = strictSafeRecordValueSchema(
        sanitized.additionalProperties,
        transforms,
        path,
        options
      );
      properties[entriesKey] = strictSafeRecordEntriesSchema(valueSchema);
      sanitized.properties = properties;
      sanitized.required = [
        ...new Set([
          ...(Array.isArray(sanitized.required)
            ? sanitized.required.filter((key): key is string => typeof key === "string")
            : []),
          ...(options.preserveOptional ? [entriesKey] : Object.keys(properties)),
        ]),
      ];
      transforms.push({ path, entriesKey, valueMode: mode });
      const existing =
        typeof sanitized.description === "string" ? sanitized.description.trim() : "";
      const suffix = `${hint}; provide arbitrary entries in ${entriesKey} as key/value pairs`;
      sanitized.description = existing ? `${existing} (${suffix})` : `(${suffix})`;
    } else if (hint) {
      // response_format schemas have no returned tool args to reverse-map, so
      // they keep the old strict-safe close-and-describe behavior.
    }
    sanitized.additionalProperties = false;
    if (hint && !transforms) {
      const existing =
        typeof sanitized.description === "string" ? sanitized.description.trim() : "";
      sanitized.description = existing ? `${existing} (${hint})` : `(${hint})`;
    }
  }

  if (sanitized.items) {
    sanitized.items = Array.isArray(sanitized.items)
      ? sanitized.items.map((item, i) =>
          sanitizeJsonSchema(item, false, `${path}.items[${i}]`, transforms, options)
        )
      : sanitizeJsonSchema(sanitized.items, false, `${path}.items`, transforms, options);
  }

  for (const arrayKey of JSON_SCHEMA_ARRAY_KEYWORDS) {
    const value = sanitized[arrayKey];
    if (Array.isArray(value)) {
      if (responseCompatibility && arrayKey !== "anyOf") {
        responseCompatibility.preservesShape = false;
      }
      sanitized[arrayKey] = value.map((item, index) =>
        sanitizeJsonSchema(
          item,
          false,
          arrayKey === "prefixItems" ? `${path}.items[${index}]` : path,
          transforms,
          options
        )
      );
    }
  }

  // Walk the same standard schema-bearing keyword table as the bounded core
  // clone. `additionalProperties` is handled above because it also creates the
  // strict-safe record transform. Conditional schemas keep the current
  // instance path; tuple/item schemas use the array wildcard/index path that
  // reverse argument restoration understands.
  for (const singleKey of JSON_SCHEMA_SINGLE_KEYWORDS) {
    if (singleKey === "additionalProperties") continue;
    if (responseCompatibility && singleKey in sanitized) {
      responseCompatibility.preservesShape = false;
    }
    const value = sanitized[singleKey];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const childPath =
        singleKey === "contains" ||
        singleKey === "unevaluatedItems" ||
        singleKey === "additionalItems"
          ? `${path}.items`
          : singleKey === "unevaluatedProperties"
            ? `${path}.*`
            : path;
      sanitized[singleKey] = sanitizeJsonSchema(value, false, childPath, transforms, options);
    }
  }
  for (const mapKey of JSON_SCHEMA_MAP_KEYWORDS) {
    if (mapKey === "properties") continue;
    const value = sanitized[mapKey];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (responseCompatibility) responseCompatibility.preservesShape = false;
      const walked: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
        const childPath =
          mapKey === "dependentSchemas"
            ? path
            : mapKey === "patternProperties"
              ? `${path}.*`
              : `${path}.${mapKey}.${key}`;
        walked[key] = sanitizeJsonSchema(sub, false, childPath, transforms, options);
      }
      sanitized[mapKey] = walked;
    }
  }
  for (const mixedMapKey of JSON_SCHEMA_MIXED_MAP_KEYWORDS) {
    const value = sanitized[mixedMapKey];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (responseCompatibility) responseCompatibility.preservesShape = false;
    const walked: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      walked[key] =
        !sub || typeof sub !== "object" || Array.isArray(sub)
          ? sub
          : sanitizeJsonSchema(sub, false, path, transforms, options);
    }
    sanitized[mixedMapKey] = walked;
  }

  return sanitized as JSONSchema7;
}

function inferJsonSchemaType(schema: Record<string, unknown>, isRoot: boolean): string | undefined {
  if (
    "properties" in schema ||
    "required" in schema ||
    "additionalProperties" in schema ||
    isRoot
  ) {
    return "object";
  }
  if ("items" in schema) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = new Set(schema.enum.map((value) => typeof value));
    if (types.size === 1) {
      const [type] = [...types];
      if (type === "string" || type === "number" || type === "boolean") {
        return type;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function usesNativeTextResult(params: GenerateTextParamsWithOpenAIOptions): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

function buildNativeTextResult(
  result: {
    text: string;
    toolCalls?: unknown[];
    finishReason?: string;
    usage?: LanguageModelUsage;
    providerMetadata?: unknown;
  },
  modelName: string,
  provider: ReturnType<typeof getUsageProvider>,
  retry?: ModelRetryTelemetry
): NativeGenerateTextResult {
  const identity = mergeProviderIdentity(result.providerMetadata, modelName, provider) as Record<
    string,
    unknown
  >;
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage: convertUsage(result.usage),
    providerMetadata: retry
      ? {
          ...identity,
          retryCount: retry.retryCount,
          ...(retry.lastRetryReason !== undefined
            ? { lastRetryReason: retry.lastRetryReason }
            : {}),
        }
      : identity,
  };
}

function handledPromise<T>(value: T | PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(value);
  promise.catch(() => {
    // error-policy:J5 unhandled-rejection suppression — the streaming path
    // primarily consumes `textStream`. AI SDK companion promises such as `text`
    // can reject later on empty streams even when no caller requested them; the
    // real error is still observed by whoever awaits `textStream`.
  });
  return promise;
}

function handledMappedPromise<T, U>(
  value: T | PromiseLike<T>,
  mapper: (resolved: T) => U | PromiseLike<U>
): Promise<U> {
  return handledPromise(handledPromise(value).then(mapper));
}

function mergeProviderIdentity(
  providerMetadata: unknown,
  modelName: string,
  provider: ReturnType<typeof getUsageProvider>
): unknown {
  if (
    providerMetadata &&
    typeof providerMetadata === "object" &&
    !Array.isArray(providerMetadata)
  ) {
    return {
      ...(providerMetadata as Record<string, unknown>),
      modelName,
      provider,
    };
  }
  return { modelName, provider };
}

function createLlmCallDetails(
  modelName: string,
  params: GenerateTextParams,
  systemPrompt: string | undefined,
  actionType: string,
  modelType?: ModelTypeName,
  providerOptions?: Record<string, unknown>,
  generateParams?: NativeTextParams
): RecordLlmCallDetails {
  const originalParams = params as GenerateTextParamsWithOpenAIOptions;
  const nativeParams = generateParams as
    | (NativeTextParams & {
        output?: unknown;
        maxOutputTokens?: unknown;
      })
    | undefined;
  const nativePrompt = nativeParams && "prompt" in nativeParams ? nativeParams.prompt : undefined;
  const nativeMessages =
    nativeParams && "messages" in nativeParams && Array.isArray(nativeParams.messages)
      ? nativeParams.messages
      : undefined;
  const nativeSystem =
    typeof nativeParams?.system === "string" ? nativeParams.system : systemPrompt;
  return {
    model: modelName,
    modelType,
    provider: "vercel-ai-sdk",
    systemPrompt: nativeSystem ?? "",
    userPrompt:
      typeof nativePrompt === "string"
        ? nativePrompt
        : typeof params.prompt === "string"
          ? params.prompt
          : "",
    prompt: typeof nativePrompt === "string" ? nativePrompt : undefined,
    messages: nativeMessages,
    tools: nativeParams?.tools ?? originalParams.tools,
    toolChoice: nativeParams?.toolChoice ?? originalParams.toolChoice,
    output:
      nativeParams?.output !== undefined
        ? buildTrajectoryOutputDescriptor(originalParams.responseSchema, nativeParams.output)
        : undefined,
    responseSchema: originalParams.responseSchema,
    providerOptions:
      providerOptions ?? nativeParams?.providerOptions ?? originalParams.providerOptions,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    maxTokens:
      typeof nativeParams?.maxOutputTokens === "number"
        ? nativeParams.maxOutputTokens
        : params.omitMaxTokens || params.maxTokens === undefined
          ? 0
          : params.maxTokens,
    maxTokensOmitted:
      (params.omitMaxTokens || params.maxTokens === undefined) &&
      typeof nativeParams?.maxOutputTokens !== "number"
        ? true
        : undefined,
    purpose: "external_llm",
    actionType,
  };
}

function buildTrajectoryOutputDescriptor(responseSchema: unknown, output: unknown): unknown {
  if (responseSchema !== undefined) {
    return {
      type: "object",
      schema: responseSchema,
    };
  }
  return toTrajectoryJsonSafe(output);
}

function toTrajectoryJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "function") return undefined;
        if (typeof nested === "bigint") return nested.toString();
        return nested;
      })
    ) as unknown;
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — trajectory JSON
    // serialization is a telemetry artifact; on a non-serializable value fall
    // back to a string repr rather than failing the model call being logged.
    return String(value);
  }
}

function applyUsageToDetails(
  details: RecordLlmCallDetails,
  usage: LanguageModelUsage | undefined
): void {
  const normalized = convertUsage(usage);
  if (!normalized) return;
  details.promptTokens = normalized.promptTokens;
  details.completionTokens = normalized.completionTokens;
  details.cacheReadInputTokens = normalized.cacheReadInputTokens;
  details.cacheCreationInputTokens = normalized.cacheCreationInputTokens;
}

// ============================================================================
// Core Generation Function
// ============================================================================

/**
 * Recover the provider's own error message from a failed call's response body.
 *
 * The AI SDK's openai error handler only understands the OpenAI error
 * envelope (`{"error": {"message": ...}}`). Cerebras's OpenAI-compatible
 * endpoint returns a FLAT shape — `{"message", "type", "param", "code"}` — so
 * `APICallError.message` degrades to the bare HTTP statusText ("Bad Request")
 * while the actionable cause (e.g. `Invalid JSON: lone leading surrogate...`,
 * `please try again`) survives only on `error.responseBody`. Walks the error
 * and a bounded `.cause` chain for the first parseable body message; falls
 * back to a bounded raw-body excerpt so even a non-JSON body is not lost.
 */
function providerErrorBodyMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < 5 && node && typeof node === "object" && !seen.has(node); depth++) {
    seen.add(node);
    const record = node as { responseBody?: unknown; cause?: unknown };
    const body = typeof record.responseBody === "string" ? record.responseBody : undefined;
    if (body && body.trim().length > 0) {
      try {
        const parsed = JSON.parse(body) as {
          message?: unknown;
          error?: { message?: unknown } | string;
        };
        const candidates = [
          parsed?.message,
          typeof parsed?.error === "object" && parsed.error !== null
            ? parsed.error.message
            : parsed?.error,
        ];
        for (const candidate of candidates) {
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
          }
        }
      } catch {
        // error-policy:J3 untrusted-input sanitizing — a non-JSON error body is
        // still diagnostic; return a bounded excerpt instead of dropping it.
      }
      return truncateWellFormed(toWellFormedUnicode(body.replace(/\s+/g, " ").trim()), 300);
    }
    node = record.cause;
  }
  return undefined;
}

/**
 * Append the provider's real error message (recovered from the response body)
 * to a masked provider error IN PLACE, preserving the error's identity, stack,
 * and AI SDK marker fields. Idempotent: a message that already carries the
 * body text is left untouched. Every plugin-openai throw boundary funnels
 * through this so "Bad Request" is never the only diagnostic that escapes.
 */
function enrichProviderCallError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const record = error as { message?: unknown };
  if (typeof record.message !== "string") return error;
  const bodyMessage = providerErrorBodyMessage(error);
  if (!bodyMessage || record.message.includes(bodyMessage)) return error;
  try {
    (error as { message: string }).message = `${record.message}: ${bodyMessage}`;
  } catch {
    // error-policy:J6 best-effort enrichment — a frozen error object keeps its
    // original message; the body remains readable via responseBody.
  }
  return error;
}

/**
 * Whether a thrown model-call error is a transient provider hiccup that is
 * worth retrying. This layer owns retries for transient 408/409/429/5xx
 * responses. Cerebras under load also returns its transient
 * "Encountered a server error, please try again" as an HTTP **400**, which the
 * SDK classifies as non-retryable and surfaces immediately — failing a coding
 * build that the very same request would complete on a second attempt (observed
 * live: large multi-tool requests 400 intermittently under fleet load, succeed
 * on retry). We treat such a 400 as transient ONLY when its body/message looks
 * like an overload, never when it looks like a genuine validation error, so we
 * don't mask real malformed-request bugs.
 */
/**
 * Every text fragment a provider failure can carry its real cause in, joined
 * and lowercased for signature matching: the (possibly masked) `message`, the
 * structured `data` payload, the error `type`, and the raw response body the
 * AI SDK keeps but does not surface for flat (non-envelope) error shapes.
 */
function providerErrorSearchText(error: unknown): string {
  const e = error as { message?: string; data?: unknown; type?: string } | undefined;
  return `${e?.message ?? ""} ${JSON.stringify(e?.data ?? "")} ${e?.type ?? ""} ${
    providerErrorBodyMessage(error) ?? ""
  }`.toLowerCase();
}

/**
 * Cerebras's tool-pairing rejection, tolerant of its "preceeding" spelling and
 * OpenAI's correct one. `repairToolMessagePairing` guarantees the pairing
 * invariant on every outgoing request, so a provider 400 carrying this
 * complaint is provably a false rejection of a well-formed request — observed
 * live 2026-08-07/08 as an intermittent Cerebras failure mode (9 rejected vs
 * 34 accepted structurally identical evaluator requests) that killed tool
 * turns after the tool had already succeeded.
 */
const SPURIOUS_TOOL_PAIRING_400_RE =
  /role '?"?tool"?'? must be a response to a prece+ding message with '?"?tool_calls"?'?/;

// OpenRouter can intermittently fail provider routing with this exact 400 even
// when the serialized request contains a valid model. The identical request
// succeeds on retry, so keep the exception signature-specific rather than
// broadening retry behavior for missing/invalid model validation errors.
const TRANSIENT_OPENROUTER_NO_MODELS_400_RE = /\bno models provided\b/;

function isSpuriousToolPairingRejection(error: unknown): boolean {
  return SPURIOUS_TOOL_PAIRING_400_RE.test(providerErrorSearchText(error));
}

/**
 * Per-model rate-limit cooldown shared by a runtime's text handlers. A
 * provider that answers with a per-minute-bucket 429 (`Retry-After` beyond the
 * transient lane's cap) will reject the same concrete model until the window
 * resets; re-sending a 20-45K-token prompt to it — directly or through a
 * runtime fallback alias that resolves to the same model — only burns the
 * bucket further and delays failover. A runtime never inherits another
 * runtime's cooldown. Endpoint, credential and model each retain independent
 * buckets, so interleaved credentials never erase another account's hold.
 * Entries expire at the provider's Retry-After and never block another model.
 */
const rateLimitCooldowns = new WeakMap<
  IAgentRuntime,
  Map<string, Map<string | undefined, Map<string, number>>>
>();

class ProviderRateLimitCooldownError extends Error {
  readonly statusCode = 429;
  readonly retryAfterMs: number;
  constructor(modelName: string, retryAfterMs: number) {
    super(
      `${modelName} is rate limited (Too Many Requests; provider window resets in ${Math.ceil(retryAfterMs / 1000)}s); not re-sent`
    );
    this.name = "ProviderRateLimitCooldownError";
    this.retryAfterMs = retryAfterMs;
  }
}

function runtimeRateLimitCooldowns(
  runtime: IAgentRuntime,
  endpoint = getBaseURL(runtime),
  credential = getApiKey(runtime)
): Map<string, number> {
  let endpoints = rateLimitCooldowns.get(runtime);
  if (!endpoints) {
    endpoints = new Map();
    rateLimitCooldowns.set(runtime, endpoints);
  }
  let credentials = endpoints.get(endpoint);
  if (!credentials) {
    credentials = new Map();
    endpoints.set(endpoint, credentials);
  }
  let models = credentials.get(credential);
  if (!models) {
    models = new Map();
    credentials.set(credential, models);
  }
  for (const [model, until] of models) {
    if (until <= Date.now()) models.delete(model);
  }
  return models;
}

function assertModelNotCoolingDown(models: Map<string, number>, modelName: string): void {
  const until = models.get(modelName);
  if (until === undefined) return;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    models.delete(modelName);
    return;
  }
  throw new ProviderRateLimitCooldownError(modelName, remaining);
}

function isModelCoolingDown(models: Map<string, number>, modelName: string): boolean {
  const until = models.get(modelName);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    models.delete(modelName);
    return false;
  }
  return true;
}

/**
 * Operator-configured fallback model (`OPENAI_FALLBACK_MODEL`, alias
 * `CEREBRAS_FALLBACK_MODEL`) used only while the requested model is held by a
 * provider rate-limit cooldown. Undefined when unset or equal to the primary.
 */
function resolveFallbackModelName(
  runtime: IAgentRuntime,
  primaryModelName: string
): string | undefined {
  const raw =
    getSetting(runtime, "OPENAI_FALLBACK_MODEL") ?? getSetting(runtime, "CEREBRAS_FALLBACK_MODEL");
  const fallback = typeof raw === "string" ? raw.trim() : "";
  if (!fallback || fallback === primaryModelName) return undefined;
  return fallback;
}

/**
 * The concrete model a request should use: the primary unless it is cooling
 * down after a 429 and a distinct fallback is configured and not itself
 * cooling down. Every slot keeps its primary model; fallback applies only
 * for the duration of the provider's Retry-After.
 */
function selectRequestModelName(
  models: Map<string, number>,
  primaryModelName: string,
  fallbackModelName: string | undefined
): string {
  if (!fallbackModelName) return primaryModelName;
  if (!isModelCoolingDown(models, primaryModelName)) return primaryModelName;
  if (isModelCoolingDown(models, fallbackModelName)) return primaryModelName;
  return fallbackModelName;
}

function noteRateLimitCooldown(
  models: Map<string, number>,
  modelName: string,
  error: unknown
): void {
  const status =
    (error as { statusCode?: number; status?: number } | undefined)?.statusCode ??
    (error as { status?: number } | undefined)?.status;
  if (status !== 429 || isPermanentQuotaError(error)) return;
  const retryAfterMs = providerRetryAfterMs(error);
  if (retryAfterMs === undefined || retryAfterMs <= TRANSIENT_LANE_MAX_BACKOFF_MS) return;
  // The cooldown is a timestamp, not an awaited retry. Preserve the provider's
  // whole delay so a later alias cannot resend before the stated reset.
  const untilMs = Date.now() + retryAfterMs;
  const existing = models.get(modelName) ?? 0;
  if (untilMs > existing) models.set(modelName, untilMs);
  logger.warn(
    { src: "plugin:openai", model: modelName, retryAfterSeconds: retryAfterMs / 1000 },
    "[OpenAI] provider rate limit reached; holding this model until the window resets"
  );
}

/** Longest wait the transient lanes will spend on one retry (see waitForTransientRetry). */
const TRANSIENT_LANE_MAX_BACKOFF_MS = 3000;

function providerRetryOutlastsTransientLane(error: unknown): boolean {
  const retryAfterMs = providerRetryAfterMs(error);
  return retryAfterMs !== undefined && retryAfterMs > TRANSIENT_LANE_MAX_BACKOFF_MS;
}

function isTransientProviderError(error: unknown): boolean {
  // The plugin owns retries with SDK retries disabled. Defensively reject an
  // already-exhausted SDK retry envelope rather than multiply another owner's
  // attempts if a wrapped provider surfaces one.
  if (RetryError.isInstance(error)) return false;
  // A valid provider delay beyond this lane's wait budget must reach runtime
  // fallback immediately. Never shorten the delay and resend early.
  if (providerRetryOutlastsTransientLane(error)) return false;
  const e = error as
    | { statusCode?: number; status?: number; message?: string; data?: unknown }
    | undefined;
  if (!e) return false;
  const status = e.statusCode ?? e.status;
  if (status === 429 && isPermanentQuotaError(error)) return false;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // Include the raw response body: the AI SDK derives `message` from the
  // OpenAI `{"error":{...}}` envelope only, so a provider that reports its
  // transient overload in a FLAT body (Cerebras) otherwise reads as a bare
  // "Bad Request" here and the transient-400 lane below can never match.
  const msg = providerErrorSearchText(error);
  // No HTTP status: either a network-level failure OR a provider that returns
  // its transient error as a bare object (Cerebras passes
  // `{message:"Encountered a server error, please try again", type:"server_error"}`
  // straight to the AI SDK's onError with no statusCode). Retry both — but never
  // a genuine validation error that merely lacks a status.
  if (status === undefined) {
    if (/invalid|unsupported|must be|required field|malformed|not allowed|json schema/.test(msg)) {
      return false;
    }
    return /timeout|timed out|econnreset|econnrefused|socket|network|fetch failed|terminated|server error|server_error|try again|overload|capacity|temporarily|unavailable|busy|rate ?limit|please retry/.test(
      msg
    );
  }
  // Transient 400: overload/server-error wording. Do NOT retry genuine
  // validation failures (invalid/unsupported/schema/required/malformed) — with
  // one proven exception: the tool-pairing complaint, which our request-side
  // normalization makes structurally impossible, so it can only be a spurious
  // provider-side rejection worth retrying.
  if (status === 400) {
    if (SPURIOUS_TOOL_PAIRING_400_RE.test(msg) || TRANSIENT_OPENROUTER_NO_MODELS_400_RE.test(msg)) {
      return true;
    }
    if (/invalid|unsupported|must be|required|malformed|not allowed|schema/.test(msg)) {
      return false;
    }
    return /server error|try again|overload|capacity|temporarily|busy|rate/.test(msg);
  }
  return false;
}

/**
 * Structured debug diagnostics for a provider tool-pairing rejection: the
 * outgoing role sequence and each message's tool-call / tool-result ids —
 * never message content, so no secrets or PII — making the next occurrence
 * diagnosable from logs alone. No-op unless the error carries the pairing
 * complaint, which the request-side pairing invariant makes provably spurious.
 */
function logToolPairingRejectionShape(
  error: unknown,
  generateParams: { messages?: unknown }
): void {
  if (!isSpuriousToolPairingRejection(error)) return;
  const messages = generateParams.messages;
  if (!Array.isArray(messages)) return;
  const roleSequence = messages.map((message) => {
    const record = message as { role?: unknown; content?: unknown };
    const role = typeof record.role === "string" ? record.role : "unknown";
    if (!Array.isArray(record.content)) return { role };
    const toolCallIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const part of record.content) {
      const type = (part as { type?: unknown })?.type;
      const id = (part as { toolCallId?: unknown })?.toolCallId;
      if (typeof id !== "string") continue;
      if (type === "tool-call") toolCallIds.push(id);
      if (type === "tool-result") toolResultIds.push(id);
    }
    return {
      role,
      ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
      ...(toolResultIds.length > 0 ? { toolResultIds } : {}),
    };
  });
  logger.debug(
    {
      src: "plugin-openai",
      status:
        (error as { statusCode?: number; status?: number })?.statusCode ??
        (error as { status?: number })?.status,
      roleSequence,
    },
    "[OpenAI] provider rejected tool pairing on a request whose pairing invariant holds"
  );
}

/** The AbortSignal wired into a call's transport, when the caller passed one. */
function retryAbortSignal(generateParams: NativeGenerateTextParams): AbortSignal | undefined {
  return (generateParams as { abortSignal?: AbortSignal }).abortSignal;
}

/** The caller's abort reason, or the standard AbortError when none was given. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function describeRetryReason(error: unknown): string {
  return (error as { message?: string })?.message ?? String(error);
}

/**
 * The single backoff seam every transient-retry lane goes through. Two jobs:
 *
 * 1. Observability — increments the per-call {@link ModelRetryTelemetry} that
 *    MODEL_USED and the result's `providerMetadata` surface, and emits one
 *    structured warn (lane/attempt/reason/model/backoff) per retry so a
 *    degraded provider is visible without wire captures.
 * 2. Abort-awareness — the provider-directed or exponential delay is where
 *    a cancelled request would otherwise sit for seconds; an abort rejects the
 *    wait immediately with the caller's reason, so no attempt can start after
 *    cancellation.
 */
async function waitForTransientRetry(opts: {
  lane: "generate" | "buffered-stream" | "stream-start";
  maxRetries: number;
  error: unknown;
  model: string;
  signal: AbortSignal | undefined;
  state: ModelRetryTelemetry;
}): Promise<void> {
  const { lane, maxRetries, error, model, signal, state } = opts;
  state.retryCount += 1;
  state.lastRetryReason = describeRetryReason(error);
  // Timers truncate fractional milliseconds; round up to honor the complete hint.
  const backoffMs = Math.ceil(
    providerRetryAfterMs(error) ??
      Math.min(
        TRANSIENT_LANE_MAX_BACKOFF_MS,
        300 * 2 ** (state.retryCount - 1) + Math.floor(Math.random() * 200)
      )
  );
  logger.warn(
    {
      src: "plugin-openai",
      lane,
      attempt: state.retryCount,
      maxRetries,
      backoffMs,
      model,
      reason: state.lastRetryReason,
    },
    `[OpenAI] transient ${lane} error, retrying`
  );
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      // signal is non-null here: the listener only exists when one was given.
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, backoffMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Call `generateText` with bounded retry + exponential backoff on transient
 * provider errors (see {@link isTransientProviderError}). Mirrors opencode's
 * resilience posture (it sets `retries: 2` on its coding LLM call) but also
 * covers Cerebras's non-standard transient-400 that the AI SDK won't retry.
 * Non-transient errors propagate immediately on the first attempt, an aborted
 * caller signal forbids any further attempt, and retry totals accumulate on
 * `retryState` for MODEL_USED / result-metadata observability.
 */
async function generateTextWithTransientRetry(
  generateParams: NativeGenerateTextParams,
  opts: {
    model: string;
    retryState: ModelRetryTelemetry;
    maxRetries?: number;
    beforeAttempt?: () => void;
    yieldRateLimit?: (error: unknown) => boolean;
  }
): Promise<Awaited<ReturnType<typeof generateText<ToolSet>>>> {
  const maxRetries = opts.maxRetries ?? 3;
  const signal = retryAbortSignal(generateParams);
  let attempt = 0;
  for (;;) {
    try {
      opts.beforeAttempt?.();
      return (await generateText(
        generateParams as Parameters<typeof generateText>[0]
        // biome-ignore lint/suspicious/noExplicitAny: see above.
      )) as any;
    } catch (rawError) {
      // error-policy:J2 context-adding rethrow — terminal, retry-exhausted, or
      // cancelled errors rethrow enriched with the provider's real body
      // message; only bounded transient provider errors on a still-live
      // request retry.
      const error = enrichProviderCallError(rawError);
      logToolPairingRejectionShape(error, generateParams);
      if (
        attempt >= maxRetries ||
        signal?.aborted ||
        opts.yieldRateLimit?.(error) ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }
      attempt++;
      await waitForTransientRetry({
        lane: "generate",
        maxRetries,
        error,
        model: opts.model,
        signal,
        state: opts.retryState,
      });
    }
  }
}

interface BufferedStreamResult {
  text: string;
  toolCalls: Awaited<ReturnType<typeof streamText<ToolSet>>["toolCalls"]> | undefined;
  usage: LanguageModelUsage | undefined;
  finishReason: string | undefined;
  observeDelivery?: () => void;
}

type StreamAttemptTiming = {
  onChunk: (event: {
    chunk: {
      type: string;
      text?: string;
      delta?: string;
      inputTextDelta?: string;
      rawValue?: unknown;
    };
  }) => void;
  delivery: () => void;
};

function observeStreamTiming(runtime: IAgentRuntime, observe: () => void): void {
  try {
    observe();
  } catch {
    // error-policy:J7 diagnostics cannot alter stream delivery. Report only a
    // fixed error: an observer exception can itself contain private payloads.
    try {
      runtime.reportError?.(
        "OpenAI.streamTiming",
        new ElizaError("Stream timing observation failed", {
          code: "STREAM_TIMING_OBSERVER_FAILED",
        })
      );
    } catch {
      // error-policy:J7 a failed diagnostic sink must not recurse or replace
      // the stream's own outcome.
      return;
    }
  }
}

function createStreamTiming(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  mode: "live-text" | "live-structured" | "buffered-transform" | "buffered-full-surface"
) {
  let beginAttempt: ((attempt: number) => StreamAttemptTiming) | undefined;
  observeStreamTiming(runtime, () => {
    // Capture the owner before returning an async iterable; consumers may
    // pull it from another ALS scope. No new timer or exporter is created.
    const timer = getInferenceTimer();
    if (!timer) return;
    const streamCallId = globalThis.crypto.randomUUID();
    const slot = Object.values(ModelType).find((known) => known === modelType) ?? "other";
    const rawPurpose = getTrajectoryContext()?.purpose;
    const purpose =
      rawPurpose === "message_handler" ||
      rawPurpose === "planner" ||
      rawPurpose === "evaluation" ||
      rawPurpose === "external_llm"
        ? rawPurpose
        : "other";
    beginAttempt = (streamAttempt) => {
      const meta = { streamCallId, streamAttempt, modelType: slot, mode, purpose };
      const record = (name: string) =>
        observeStreamTiming(runtime, () => timer.recordSpan(name, 0, meta));
      record("openai.stream.mode");
      let providerObserved = false;
      let providerTimingObserved = false;
      let sdkObserved = false;
      let delivered = false;
      return {
        onChunk: ({ chunk }) =>
          observeStreamTiming(runtime, () => {
            if (chunk.type === "raw") {
              // This is the first parsed SSE frame, not the first network byte.
              // Inspect only numeric timing fields; never retain the raw payload.
              if (!providerObserved) {
                providerObserved = true;
                record("openai.stream.first-provider-event");
              }
              const raw = chunk.rawValue;
              if (
                providerTimingObserved ||
                !raw ||
                typeof raw !== "object" ||
                !("time_info" in raw)
              )
                return;
              const info = raw.time_info;
              if (!info || typeof info !== "object" || Array.isArray(info)) return;
              const durations: Record<string, number> = {};
              for (const [field, name] of [
                ["queue_time", "queueMs"],
                ["prompt_time", "promptMs"],
                ["completion_time", "completionMs"],
                ["total_time", "totalMs"],
              ]) {
                const seconds = (info as Record<string, unknown>)[field];
                if (typeof seconds === "number" && seconds >= 0 && Number.isFinite(seconds * 1000))
                  durations[name] = seconds * 1000;
              }
              if (Object.keys(durations).length > 0) {
                providerTimingObserved = true;
                timer.recordSpan("openai.stream.provider-timing", 0, { ...meta, ...durations });
              }
              return;
            }
            if (sdkObserved || (chunk.type !== "text-delta" && chunk.type !== "tool-input-delta"))
              return;
            const delta =
              chunk.type === "text-delta"
                ? (chunk.text ?? chunk.delta)
                : (chunk.inputTextDelta ?? chunk.delta);
            if (!delta) return;
            sdkObserved = true;
            // SDK onChunk runs after output parsing, not at raw HTTP arrival.
            record("openai.stream.first-sdk-delta");
          }),
        delivery: () => {
          if (delivered) return;
          delivered = true;
          record("openai.stream.first-adapter-delivery");
        },
      };
    };
  });
  return beginAttempt;
}

/**
 * Consume a `streamText` call to completion with bounded transient-error retry.
 *
 * Coding/structured planner calls stream, but Cerebras under fleet load returns
 * intermittent transient 400s on large multi-tool requests — and for a stream
 * that error surfaces only while the stream is *consumed*, so the AI SDK's
 * `maxRetries` (which also won't retry a 400) never helps and the build fails on
 * an error the very same request would survive on a second attempt. We buffer
 * the stream and re-issue the whole call on a transient failure. Token streaming
 * is not user-visible for coding (the sub-agent relays a final summary), so
 * buffering loses nothing there. Used only in coding mode; chat keeps live
 * streaming.
 */
async function consumeStreamWithTransientRetry(
  generateParams: NativeGenerateTextParams,
  onChunk: ((chunk: string) => void) | undefined,
  opts: {
    model: string;
    retryState: ModelRetryTelemetry;
    maxRetries?: number;
    beforeAttempt?: () => void;
    yieldRateLimit?: (error: unknown) => boolean;
    streamTiming?: ReturnType<typeof createStreamTiming>;
  }
): Promise<BufferedStreamResult> {
  const maxRetries = opts.maxRetries ?? 5;
  const signal = retryAbortSignal(generateParams);
  let attempt = 0;
  for (;;) {
    try {
      // The AI SDK does NOT throw on a request failure during streaming — it
      // routes the error to `onError` and ends the stream empty (an empty
      // result then reads as "model called no tool" upstream). Capture it here
      // and rethrow after consumption so the retry below can act on it. (This
      // is the same reason opencode attaches an onError to its streamText.)
      let capturedError: unknown;
      const attemptTiming = opts.streamTiming?.(attempt + 1);
      opts.beforeAttempt?.();
      const result = streamText({
        ...(generateParams as Parameters<typeof streamText>[0]),
        onError: ({ error }: { error: unknown }) => {
          capturedError = error;
        },
        ...(attemptTiming ? { onChunk: attemptTiming.onChunk, includeRawChunks: true } : {}),
      });
      let text = "";
      for await (const chunk of result.textStream) {
        if (chunk && onChunk) attemptTiming?.delivery();
        onChunk?.(chunk);
        text += chunk;
      }
      // Observe every companion before propagating the provider error. Failed
      // requests can reject toolCalls with a generic NoOutputGeneratedError,
      // which must not hide the captured failure from the retry classifier.
      const [toolsOutcome, usageOutcome, finishOutcome, textOutcome] = await Promise.allSettled([
        result.toolCalls,
        result.usage,
        result.finishReason,
        result.text,
      ]);
      if (capturedError) throw capturedError;
      if (toolsOutcome.status === "rejected") throw toolsOutcome.reason;
      if (usageOutcome.status === "rejected") throw usageOutcome.reason;
      if (finishOutcome.status === "rejected") throw finishOutcome.reason;
      if (textOutcome.status === "rejected") throw textOutcome.reason;
      const toolCalls = toolsOutcome.value;
      const usage = usageOutcome.value;
      const finishReason = finishOutcome.value as string | undefined;
      return {
        text,
        toolCalls,
        usage,
        finishReason,
        ...(attemptTiming ? { observeDelivery: attemptTiming.delivery } : {}),
      };
    } catch (rawError) {
      // error-policy:J2 context-adding rethrow — terminal, retry-exhausted, or
      // cancelled errors rethrow enriched with the provider's real body
      // message; only bounded transient provider errors on a still-live
      // request retry.
      const error = enrichProviderCallError(rawError);
      logToolPairingRejectionShape(error, generateParams);
      if (
        attempt >= maxRetries ||
        signal?.aborted ||
        opts.yieldRateLimit?.(error) ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }
      attempt++;
      await waitForTransientRetry({
        lane: "buffered-stream",
        maxRetries,
        error,
        model: opts.model,
        signal,
        state: opts.retryState,
      });
    }
  }
}

/**
 * Generates text using the specified model type.
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @param modelType - The type of model (TEXT_SMALL or TEXT_LARGE)
 * @param getModelFn - Function to get the model name
 * @returns Generated text or stream result
 */
async function generateTextByModelType(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<string | TextStreamResult> {
  // Cross-provider recovery belongs to one model call, never to the action
  // executor. Only an explicit alternative credential/model enables it.
  const modelName = getSetting(runtime, "OPENROUTER_FALLBACK_MODEL")?.trim();
  const apiKey = getSetting(runtime, "OPENROUTER_API_KEY")?.trim();
  const canFallback = isCerebrasMode(runtime) && !isBrowser() && !!modelName && !!apiKey;
  let delivered = false;
  const observedParams =
    canFallback && params.onStreamChunk
      ? {
          ...params,
          onStreamChunk: (chunk: string) => {
            if (chunk) delivered = true;
            params.onStreamChunk?.(chunk);
          },
        }
      : params;
  try {
    return await generateTextAtEndpoint(
      runtime,
      observedParams,
      modelType,
      getModelFn,
      undefined,
      (error) => {
        if (!canFallback || delivered || params.signal?.aborted) return false;
        const failure = RetryError.isInstance(error) ? error.lastError : error;
        const status =
          (failure as { statusCode?: number; status?: number } | undefined)?.statusCode ??
          (failure as { status?: number } | undefined)?.status;
        return status === 429;
      }
    );
  } catch (error) {
    // error-policy:J4 operator-approved alternate inference preserves the
    // complete request after rate limiting, only before any output delivery.
    if (!canFallback || !modelName || !apiKey || delivered || params.signal?.aborted) throw error;
    const failure = RetryError.isInstance(error) ? error.lastError : error;
    const status =
      (failure as { statusCode?: number; status?: number } | undefined)?.statusCode ??
      (failure as { status?: number } | undefined)?.status;
    if (status !== 429) throw error;
    logger.info(
      { src: "plugin:openai", modelType, model: modelName, provider: "openrouter" },
      "[OpenAI] Cerebras rate limited; retrying this model call through the configured OpenRouter fallback"
    );
    return generateTextAtEndpoint(runtime, params, modelType, getModelFn, {
      baseURL: getSetting(runtime, "OPENROUTER_BASE_URL")?.trim() || "https://openrouter.ai/api/v1",
      apiKey,
      modelName,
      provider: "openrouter",
    });
  }
}

async function generateTextAtEndpoint(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter,
  endpoint?: { baseURL: string; apiKey: string; modelName: string; provider: "openrouter" },
  yieldRateLimit?: (error: unknown) => boolean
): Promise<string | TextStreamResult> {
  const paramsWithAttachments = params as GenerateTextParamsWithOpenAIOptions;
  const openai = createOpenAIClient(runtime, endpoint);
  // Keep retries and their failures bound to this call's endpoint/credential,
  // even if runtime settings change while the HTTP request is in flight.
  const modelCooldowns = runtimeRateLimitCooldowns(runtime, endpoint?.baseURL, endpoint?.apiKey);
  const primaryModelName =
    endpoint?.modelName ?? resolveRequestedModelName(paramsWithAttachments, runtime, getModelFn);
  const fallbackModelName = endpoint
    ? undefined
    : resolveFallbackModelName(runtime, primaryModelName);
  const modelName = selectRequestModelName(modelCooldowns, primaryModelName, fallbackModelName);
  const usageProvider = endpoint?.provider ?? getUsageProvider(runtime);

  if (modelName !== primaryModelName) {
    logger.info(
      { src: "plugin:openai", modelType, primaryModel: primaryModelName, fallbackModel: modelName },
      "[OpenAI] primary model is rate limited; serving this request with the configured fallback model"
    );
  }
  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);
  const providerOptions = resolveProviderOptions(
    params,
    runtime,
    endpoint ? resolveRequestedModelName(paramsWithAttachments, runtime, getModelFn) : modelName
  );
  const hasAttachments = (paramsWithAttachments.attachments?.length ?? 0) > 0;
  const userContent = hasAttachments ? buildUserContent(paramsWithAttachments) : undefined;
  const shouldReturnNativeResult = usesNativeTextResult(paramsWithAttachments);

  const systemPrompt = resolveEffectiveSystemPrompt({
    params: paramsWithAttachments,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const agentName = paramsWithAttachments.providerOptions?.agentName;
  const telemetryConfig: NativeTelemetrySettings = {
    isEnabled: getExperimentalTelemetry(runtime),
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  // Chat Completions is the default: broadest compatibility, and it works
  // against every OpenAI-compatible endpoint (Cerebras, local servers, proxies).
  // gpt-5 / gpt-5-mini reasoning models ignore temperature/penalty/stop params.
  //
  const model = openai.chat(modelName);
  // The explicitly configured equivalent model accepts the same strict schema
  // semantics. OpenRouter require_parameters prevents silent capability loss.
  const cerebrasMode = isCerebrasMode(runtime);
  const normalizedToolResult = normalizeNativeToolsForCall(paramsWithAttachments.tools, {
    cerebrasMode,
    // Plain array definitions are sanitized only after the provider-specific
    // bounded structural pre-pass and before jsonSchema() introduces its lazy
    // accessor. Existing ToolSets use the descriptor-only branch above.
    sanitizeUnicode: true,
  });
  // Wire boundary for annotation data: the pre-passes carry annotations by
  // reference (getters never observed), so admissibility is checked HERE,
  // descriptor-only, before any provider dispatch. Accessors are detected via
  // Object.getOwnPropertyDescriptor and rejected without invocation; cycles
  // and over-depth fail closed with the typed WELL_FORMED_* contract.
  if (normalizedToolResult.tools) {
    // Uniform per-edge charging with no name-based exemptions: a schema at
    // the walkers' full authority costs up to twice its node depth here, so
    // the cap is sized 2x + slack while hostile wrapper structure stays
    // bounded far below stack limits.
    assertSchemaAnnotationsSerializable(paramsWithAttachments.tools, {
      maxDepth: 2 * MAX_WELL_FORMED_DEPTH + 8,
    });
  }
  const normalizedTools = normalizedToolResult.tools;
  const normalizedToolChoice = normalizeToolChoice(paramsWithAttachments.toolChoice, {
    toolNameMap: normalizedToolResult.toolNameMap,
  });
  const normalizedMessages = normalizeNativeMessages(paramsWithAttachments.messages);
  const wireMessages = dropDuplicateLeadingSystemMessage(normalizedMessages, systemPrompt);
  const effectiveMessages =
    wireMessages && wireMessages.length > 0 ? wireMessages : normalizedMessages;
  const promptText =
    typeof params.prompt === "string" && params.prompt.length > 0 ? params.prompt : "";
  const promptOrMessages: NativePrompt =
    effectiveMessages && effectiveMessages.length > 0
      ? { messages: effectiveMessages }
      : userContent
        ? { messages: [{ role: "user" as const, content: userContent }] }
        : { prompt: promptText };
  // AI SDK v6 derives the provider-level response format from its `output`
  // contract; a similarly named top-level setting is ignored by generateText.
  // A caller's response schema takes precedence over legacy JSON-object mode.
  // Cerebras accepts strict schemas, including optional properties; applying
  // OpenAI's all-properties-required rewrite would change evaluator semantics.
  // Unsupported Cerebras schemas remain visible provider errors.
  const callerResponseFormat = (paramsWithAttachments as { responseFormat?: unknown })
    .responseFormat;
  const responseFormatType =
    typeof callerResponseFormat === "string"
      ? callerResponseFormat
      : callerResponseFormat &&
          typeof callerResponseFormat === "object" &&
          "type" in callerResponseFormat
        ? (callerResponseFormat as { type: string }).type
        : undefined;
  // Sanitize the plain response schema BEFORE it is wrapped in jsonSchema /
  // Output.object. Once wrapped, responseFormat is a Promise that defeats the
  // deepToWellFormedUnicode walk, so schema keys/values carrying lone
  // surrogates would reach the provider wire untouched (#18081 review).
  const sanitizedResponseSchema = paramsWithAttachments.responseSchema
    ? deepToWellFormedUnicode(paramsWithAttachments.responseSchema)
    : undefined;
  const preparedOutput = sanitizedResponseSchema
    ? buildStructuredOutput(sanitizedResponseSchema, modelType, cerebrasMode)
    : undefined;
  const requestedOutput: NativeOutput | undefined =
    preparedOutput?.output ??
    (responseFormatType === "json_object" || (cerebrasMode && sanitizedResponseSchema)
      ? Output.json()
      : undefined);
  const restoreResponseText = (text: string): string =>
    preparedOutput?.transform?.restoreText(text) ?? text;

  // Shared across whichever retry lane serves this call; exactly one lane runs
  // per call, so the totals are per-request, never cross-request.
  const retryState: ModelRetryTelemetry = { retryCount: 0, lastRetryReason: undefined };
  const retryMetadata = () => ({
    retryCount: retryState.retryCount,
    ...(retryState.lastRetryReason !== undefined
      ? { lastRetryReason: retryState.lastRetryReason }
      : {}),
  });

  // Wire-boundary guarantee: no upstream text bug may produce an invalid
  // request body. A lone UTF-16 surrogate (e.g. from a mid-emoji slice)
  // serializes as a \uD8xx escape that Cerebras's strict JSON parser 400s
  // on ("lone leading surrogate in hex escape", wrong_api_format — #18025),
  // so EVERY outgoing string — including tool descriptions/schemas, output
  // schemas, and provider options — is forced to well-formed Unicode here.
  // Already sanitized pre-wrap inside normalizeNativeToolsForCall — the
  // jsonSchema() wrapper's lazy accessor makes the assembled set unwalkable.
  const sanitizedTools = normalizedTools;
  const sanitizedToolChoice = normalizedToolChoice
    ? deepToWellFormedUnicode(normalizedToolChoice)
    : undefined;
  // NOT deep-sanitized: the AI SDK's Output wrapper exposes `jsonSchema` as a
  // lazy accessor, which the strict walk rejects fatally — and every child
  // RESPONSE_HANDLER call with responseFormat json_object died on it (live
  // 2026-08-21). Caller-controlled strings were already sanitized BEFORE
  // wrapping (sanitizedResponseSchema above); bare Output.json() carries no
  // caller data at all, so skipping the walk loses nothing.
  const sanitizedOutput = requestedOutput;
  const sanitizedProviderOptions = providerOptions
    ? (deepToWellFormedUnicode(providerOptions) as NativeProviderOptions)
    : undefined;

  const generateParams: NativeTextParams = {
    model,
    ...deepToWellFormedUnicode(promptOrMessages),
    system: systemPrompt === undefined ? undefined : deepToWellFormedUnicode(systemPrompt),
    allowSystemInMessages: true,
    // The SDK's built-in retry honors a provider `Retry-After`, and Cerebras
    // answers a per-minute token-bucket 429 with `Retry-After: 60`, so one
    // model call blocked a user-visible turn for a full minute before the
    // runtime could fail over (live 2026-09-05: 61.9s Stage-1, 63s post-turn
    // tails). Retries are owned by the transient lanes below (bounded 3s
    // backoff) and by the runtime's provider failover, never by the SDK.
    maxRetries: 0,
    ...(params.signal ? { abortSignal: params.signal } : {}),
    // An omitted caller cap delegates the output boundary to the provider/model.
    ...(params.omitMaxTokens || params.maxTokens === undefined
      ? {}
      : { maxOutputTokens: params.maxTokens }),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.topP !== undefined ? { topP: params.topP } : {}),
    experimental_telemetry: telemetryConfig,
    ...(sanitizedTools ? { tools: sanitizedTools } : {}),
    ...(sanitizedToolChoice ? { toolChoice: sanitizedToolChoice } : {}),
    ...(sanitizedOutput ? { output: sanitizedOutput } : {}),
    ...(sanitizedProviderOptions ? { providerOptions: sanitizedProviderOptions } : {}),
  };

  // Handle streaming mode
  if (params.stream) {
    // Coding/structured planner calls prioritise reliability over live token
    // streaming: buffer the stream to completion with transient-error retry so a
    // Cerebras-under-load 400 doesn't fail an otherwise-good build (see
    // consumeStreamWithTransientRetry). Token streaming isn't user-visible for
    // coding. Regular chat falls through to the live-streaming path below.
    const fullActionSurface = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE?.trim().toLowerCase();
    const shouldBufferStream =
      preparedOutput?.transform !== undefined ||
      fullActionSurface === "1" ||
      fullActionSurface === "true" ||
      fullActionSurface === "yes" ||
      fullActionSurface === "on";
    const streamTiming = createStreamTiming(
      runtime,
      modelType,
      preparedOutput?.transform
        ? "buffered-transform"
        : shouldBufferStream
          ? "buffered-full-surface"
          : params.streamStructured === true
            ? "live-structured"
            : "live-text"
    );
    if (shouldBufferStream) {
      const details = createLlmCallDetails(
        modelName,
        params,
        systemPrompt,
        "ai.streamText",
        modelType,
        providerOptions,
        generateParams
      );
      details.response = "";
      details.provider = usageProvider;
      const hasResponseTransform = preparedOutput?.transform !== undefined;
      const buffered = await recordLlmCall(runtime, details, async () => {
        assertModelNotCoolingDown(modelCooldowns, modelName);
        const result = await consumeStreamWithTransientRetry(
          generateParams,
          hasResponseTransform ? undefined : params.onStreamChunk,
          {
            model: modelName,
            retryState,
            yieldRateLimit,
            maxRetries: 5,
            beforeAttempt: () => attestLlmInputSubstring(details),
            streamTiming,
          }
        ).catch((error: unknown) => {
          noteRateLimitCooldown(modelCooldowns, modelName, error);
          throw error;
        });
        const text = restoreResponseText(result.text);
        const toolCalls = restoreRecordArgToolCalls(
          result.toolCalls,
          normalizedToolResult.recordArgTransformsByTool
        );
        details.response = text;
        details.toolCalls = toolCalls;
        details.finishReason = result.finishReason;
        if (result.usage) applyUsageToDetails(details, result.usage);
        return { ...result, text, toolCalls };
      });
      assertModelOutputComplete({
        finishReason: buffered.finishReason,
        provider: usageProvider,
        model: modelName,
      });
      if (buffered.usage) {
        emitModelUsageEvent(
          runtime,
          modelType,
          params.prompt ?? "",
          buffered.usage,
          modelName,
          retryState,
          usageProvider
        );
      }
      return {
        textStream: (async function* replayBufferedStream() {
          if (buffered.text) {
            buffered.observeDelivery?.();
            if (hasResponseTransform) {
              params.onStreamChunk?.(buffered.text);
            }
            yield buffered.text;
          }
        })(),
        text: Promise.resolve(buffered.text),
        ...(shouldReturnNativeResult ? { toolCalls: Promise.resolve(buffered.toolCalls) } : {}),
        usage: Promise.resolve(convertUsage(buffered.usage)),
        finishReason: Promise.resolve(buffered.finishReason),
        providerMetadata: { modelName, provider: usageProvider, ...retryMetadata() },
      };
    }
    const details = createLlmCallDetails(
      modelName,
      params,
      systemPrompt,
      "ai.streamText",
      modelType,
      providerOptions,
      generateParams
    );
    details.response = "";
    details.provider = usageProvider;
    assertActiveTrajectoryForLlmCall({
      actionType: details.actionType,
      model: details.model,
      modelType: details.modelType,
      purpose: details.purpose,
    });
    const startedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const responseChunks: string[] = [];
    let capturedStreamError: unknown;
    let companionStreamError: unknown;
    let telemetryFinalized = false;
    // Live streaming retries ONLY when the attempt dies before its first
    // token: Cerebras's transient 500s surface through `onError` with an
    // empty stream (or as a throw on the first pull), and at that point
    // nothing has reached the user, so a fresh attempt is invisible. Once a
    // token has been delivered a failure stays fatal — replaying a partial
    // stream would double-deliver text. The prefix through the first forwarded
    // delta is pre-pulled and replayed below; abandoned attempts get their companion
    // promises defused so an errored, unconsumed result cannot surface as an
    // unhandled rejection.
    let result!: Awaited<ReturnType<typeof streamText>>;
    const observeStreamCompanions = (streamResult: Awaited<ReturnType<typeof streamText>>) => ({
      text: handledPromise(streamResult.text),
      usage: handledPromise(streamResult.usage),
      finishReason: handledPromise(streamResult.finishReason),
      toolCalls: handledPromise(streamResult.toolCalls),
    });
    let streamCompanions!: ReturnType<typeof observeStreamCompanions>;
    let streamIterator!: AsyncIterator<unknown>;
    let firstItem: IteratorResult<unknown> | undefined;
    let attemptTiming: StreamAttemptTiming | undefined;
    let attemptPrefix: unknown[] = [];
    for (let attempt = 0; ; attempt++) {
      assertModelNotCoolingDown(modelCooldowns, modelName);
      capturedStreamError = undefined;
      attemptPrefix = [];
      attestLlmInputSubstring(details);
      attemptTiming = streamTiming?.(attempt + 1);
      try {
        result = await streamText({
          ...generateParams,
          onError: ({ error }: { error: unknown }) => {
            capturedStreamError = error;
            noteRateLimitCooldown(modelCooldowns, modelName, error);
          },
          ...(attemptTiming ? { onChunk: attemptTiming.onChunk, includeRawChunks: true } : {}),
        });
      } catch (error) {
        // error-policy:J2 retain the provider failure and its cooldown even
        // when dispatch rejects before exposing an iterable or onError event.
        noteRateLimitCooldown(modelCooldowns, modelName, error);
        throw error;
      }
      // Companion promises can reject at the same instant as the first stream
      // pull. Observe them before that pull so an owner abort never becomes an
      // unhandled rejection while textStream remains the authoritative error.
      streamCompanions = observeStreamCompanions(result);
      const source = params.streamStructured === true ? result.fullStream : result.textStream;
      streamIterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      try {
        for (;;) {
          firstItem = await streamIterator.next();
          if (firstItem.done) break;
          attemptPrefix.push(firstItem.value);
          if (params.streamStructured !== true) break;
          // fullStream emits lifecycle frames before the HTTP request settles.
          // Retain the prefix until an argument delta can reach the caller;
          // otherwise a start frame would commit a still-retryable attempt.
          const part = firstItem.value as {
            type: string;
            inputTextDelta?: string;
            delta?: string;
          };
          if (part.type === "tool-input-delta" && (part.inputTextDelta ?? part.delta)) break;
        }
      } catch (error) {
        // error-policy:J2 the captured provider failure is classified below and
        // rethrown by the stream boundary when recovery is not permitted.
        firstItem = undefined;
        if (capturedStreamError === undefined) {
          noteRateLimitCooldown(modelCooldowns, modelName, error);
        }
        capturedStreamError ??= error;
      }
      const failedBeforeFirstToken =
        capturedStreamError !== undefined && (firstItem === undefined || firstItem.done === true);
      // 5 retries (~7.5s total backoff), matching the buffered coding lane:
      // live Cerebras 500 bursts routinely outlast the previous 3-attempt
      // (~2.3s) window and killed recoverable turns (12 clusters on
      // 2026-08-02); nothing has reached the user yet, so the extra waits
      // only delay an honest failure reply, never double-deliver. A cancelled
      // request never retries, however retryable the error looks — the abort
      // check here plus the abort-aware backoff below guarantee no attempt
      // starts after cancellation.
      const abortSignal = retryAbortSignal(generateParams);
      // Enrich BEFORE classifying: a Cerebras transient 400 arrives with the
      // masked "Bad Request" message, and only the response body carries the
      // wording the transient classifier matches on.
      capturedStreamError = enrichProviderCallError(capturedStreamError);
      logToolPairingRejectionShape(capturedStreamError, generateParams);
      if (
        !failedBeforeFirstToken ||
        attempt >= 5 ||
        abortSignal?.aborted ||
        yieldRateLimit?.(capturedStreamError) ||
        !isTransientProviderError(capturedStreamError)
      ) {
        break;
      }
      await waitForTransientRetry({
        lane: "stream-start",
        maxRetries: 5,
        error: capturedStreamError,
        model: modelName,
        signal: abortSignal,
        state: retryState,
      });
    }
    // Replay every retained frame of the selected attempt in its original order.
    const iterateStream = async function* (): AsyncGenerator<unknown> {
      yield* attemptPrefix;
      if (firstItem?.done) return;
      for (;;) {
        const next = await streamIterator.next();
        if (next.done) return;
        yield next.value;
      }
    };
    // Before any text/tool delta is exposed, a provider 429 is a failed
    // dispatch, not a partial response. Surface it to the same-call fallback.
    if (
      capturedStreamError &&
      (firstItem === undefined || firstItem.done) &&
      !endpoint &&
      getSetting(runtime, "OPENROUTER_FALLBACK_MODEL") &&
      getSetting(runtime, "OPENROUTER_API_KEY")
    ) {
      const failure = RetryError.isInstance(capturedStreamError)
        ? capturedStreamError.lastError
        : capturedStreamError;
      const status =
        (failure as { statusCode?: number; status?: number }).statusCode ??
        (failure as { status?: number }).status;
      if (status === 429) {
        logActiveTrajectoryLlmCall(runtime, {
          ...details,
          response: "",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        throw capturedStreamError;
      }
    }
    let structuredTextSettled = false;
    let resolveStructuredText: (text: string) => void = () => {};
    let rejectStructuredText: (error: unknown) => void = () => {};
    const structuredTextPromise = new Promise<string>((resolve, reject) => {
      resolveStructuredText = resolve;
      rejectStructuredText = reject;
    });
    const handledStructuredTextPromise = handledPromise(structuredTextPromise);
    const settleStructuredText = (error?: unknown): void => {
      if (params.streamStructured !== true || structuredTextSettled) return;
      structuredTextSettled = true;
      if (error) {
        rejectStructuredText(error);
        return;
      }
      resolveStructuredText(restoreResponseText(responseChunks.join("")));
    };
    const sdkTextPromise = streamCompanions.text;
    const rawTextPromise =
      params.streamStructured === true
        ? handledStructuredTextPromise
        : handledMappedPromise(sdkTextPromise, restoreResponseText);
    const rawUsagePromise = streamCompanions.usage;
    const rawFinishReasonPromise = streamCompanions.finishReason;
    const rawToolCallsPromise = streamCompanions.toolCalls;
    const restoredToolCallsPromise = handledMappedPromise(rawToolCallsPromise, (toolCalls) =>
      restoreRecordArgToolCalls(toolCalls, normalizedToolResult.recordArgTransformsByTool)
    );
    const usagePromise = handledMappedPromise(rawUsagePromise, convertUsage);
    const finishReasonPromise = handledMappedPromise(rawFinishReasonPromise, (r) => {
      const finishReason = r as string | undefined;
      assertModelOutputComplete({
        finishReason,
        provider: usageProvider,
        model: modelName,
      });
      return finishReason;
    });
    const textPromise = handledMappedPromise(
      Promise.all([rawTextPromise, finishReasonPromise]),
      ([text]) => text
    );
    const finalizeStreamingTelemetry = async () => {
      if (telemetryFinalized) {
        return;
      }
      telemetryFinalized = true;
      const [usageResult, finishReasonResult, toolCallsResult] = await Promise.allSettled([
        rawUsagePromise,
        rawFinishReasonPromise,
        restoredToolCallsPromise,
      ]);

      details.response = restoreResponseText(responseChunks.join(""));
      if (usageResult.status === "fulfilled" && usageResult.value) {
        applyUsageToDetails(details, usageResult.value);
        emitModelUsageEvent(
          runtime,
          modelType,
          params.prompt ?? "",
          usageResult.value,
          modelName,
          retryState,
          usageProvider
        );
      } else if (usageResult.status === "rejected") {
        companionStreamError ??= usageResult.reason;
      }
      if (finishReasonResult.status === "fulfilled") {
        details.finishReason = finishReasonResult.value as string | undefined;
        try {
          assertModelOutputComplete({
            finishReason: finishReasonResult.value,
            provider: usageProvider,
            model: modelName,
          });
        } catch (error) {
          companionStreamError ??= error;
        }
      } else {
        companionStreamError ??= finishReasonResult.reason;
      }
      if (toolCallsResult.status === "fulfilled") {
        details.toolCalls = toolCallsResult.value;
      } else {
        companionStreamError ??= toolCallsResult.reason;
      }

      const elapsed =
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - startedAt;
      logActiveTrajectoryLlmCall(runtime, {
        ...details,
        response: details.response,
        latencyMs: Math.max(0, Math.round(elapsed)),
      });
    };

    return {
      textStream: (async function* textStreamWithCallback() {
        let streamIterationError: unknown;
        try {
          if (params.streamStructured === true) {
            // Structured Stage-1 calls force the envelope out as a native tool
            // call, and the AI SDK's textStream carries only text-delta parts —
            // tool-input (argument) deltas are silently dropped, so nothing
            // streams while the model writes the envelope. Consume fullStream
            // instead and forward only tool-input deltas. Some compatible
            // providers narrate before the required tool call; if that prose is
            // mixed into the structured stream, the runtime extractor correctly
            // switches to plaintext passthrough and the raw envelope becomes
            // visible. The authoritative parse still comes from toolCalls.
            // Gated on streamStructured so planner/coding tool-call JSON never
            // leaks into a visible stream.
            for await (const part of iterateStream()) {
              // The AI SDK renamed these delta fields across v6 minors
              // (`tool-input-delta`: delta→inputTextDelta), and the workspace's
              // declared (^6.0.30) and hoisted (6.0.174) copies disagree — read
              // both spellings so the forwarding survives either resolution. A
              // part carrying neither is a non-delta frame and is skipped.
              const record = part as {
                type: string;
                delta?: string;
                inputTextDelta?: string;
              };
              const chunk =
                record.type === "tool-input-delta"
                  ? (record.inputTextDelta ?? record.delta ?? null)
                  : null;
              if (!chunk) continue;
              responseChunks.push(chunk);
              attemptTiming?.delivery();
              params.onStreamChunk?.(chunk);
              yield chunk;
            }
          } else {
            for await (const chunk of iterateStream()) {
              responseChunks.push(chunk as string);
              if (chunk) attemptTiming?.delivery();
              params.onStreamChunk?.(chunk as string);
              yield chunk as string;
            }
          }
        } catch (error) {
          // error-policy:J2 context-adding rethrow — capture the stream-iteration
          // error so `finally` can finalize telemetry, then rethrow it below.
          streamIterationError = error;
          if (error !== capturedStreamError) {
            noteRateLimitCooldown(modelCooldowns, modelName, error);
          }
        } finally {
          await finalizeStreamingTelemetry();
        }
        const streamError = enrichProviderCallError(
          streamIterationError ?? capturedStreamError ?? companionStreamError
        );
        if (streamError && !streamIterationError && !capturedStreamError) {
          noteRateLimitCooldown(modelCooldowns, modelName, streamError);
        }
        settleStructuredText(streamError);
        if (streamError) throw streamError;
      })(),
      text: textPromise,
      ...(shouldReturnNativeResult ? { toolCalls: restoredToolCallsPromise } : {}),
      usage: usagePromise,
      finishReason: finishReasonPromise,
      providerMetadata: { modelName, provider: usageProvider, ...retryMetadata() },
    };
  }

  // Non-streaming mode
  const details = createLlmCallDetails(
    modelName,
    params,
    systemPrompt,
    "ai.generateText",
    modelType,
    providerOptions,
    generateParams
  );
  details.provider = usageProvider;
  const result = await recordLlmCall(runtime, details, async () => {
    assertModelNotCoolingDown(modelCooldowns, modelName);
    const result = await generateTextWithTransientRetry(generateParams, {
      model: modelName,
      retryState,
      yieldRateLimit,
      maxRetries: 3,
      beforeAttempt: () => attestLlmInputSubstring(details),
    }).catch((error: unknown) => {
      noteRateLimitCooldown(modelCooldowns, modelName, error);
      throw error;
    });
    const restoredText = restoreResponseText(result.text);
    const restoredToolCalls = restoreRecordArgToolCalls(
      result.toolCalls,
      normalizedToolResult.recordArgTransformsByTool
    );
    details.response = restoredText;
    details.toolCalls = restoredToolCalls;
    details.finishReason = result.finishReason as string | undefined;
    details.providerMetadata = result.providerMetadata;
    applyUsageToDetails(details, result.usage);
    return {
      text: restoredText,
      toolCalls: restoredToolCalls as typeof result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
    };
  });

  assertModelOutputComplete({
    finishReason: result.finishReason,
    provider: usageProvider,
    model: modelName,
  });

  if (result.usage) {
    emitModelUsageEvent(
      runtime,
      modelType,
      params.prompt ?? "",
      result.usage,
      modelName,
      retryState,
      usageProvider
    );
  }

  if (shouldReturnNativeResult) {
    return buildNativeTextResult(
      result,
      modelName,
      usageProvider,
      retryState
    ) as NativeTextModelResult;
  }

  return result.text;
}

// ============================================================================
// Public Handlers
// ============================================================================

/**
 * Handles TEXT_SMALL model requests.
 *
 * Uses the configured small model (default: gpt-5-mini).
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns Generated text or stream result
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_SMALL, getSmallModel);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_NANO_MODEL_TYPE, getNanoModel);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_MEDIUM_MODEL_TYPE, getMediumModel);
}

/**
 * Handles TEXT_LARGE model requests.
 *
 * Uses the configured large model (default: gpt-5).
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns Generated text or stream result
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_LARGE, getLargeModel);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_MEGA_MODEL_TYPE, getMegaModel);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(
    runtime,
    params,
    RESPONSE_HANDLER_MODEL_TYPE,
    getResponseHandlerModel
  );
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ACTION_PLANNER_MODEL_TYPE, getActionPlannerModel);
}

// ─── Test-only exports ──────────────────────────────────────────────────────
// These are exported for the shape tests in `__tests__/reasoning-effort.shape.test.ts`.
// Not part of the public API; do not import outside tests.

/** @internal — exported for unit tests only. */
export const __INTERNAL_resolveProviderOptions = resolveProviderOptions;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeMessages = normalizeNativeMessages;
/** @internal — exported for unit tests only. */
export const __INTERNAL_stripReasoningParts = stripReasoningParts;
/** @internal — exported for unit tests only. */
export const __INTERNAL_sanitizeJsonSchema = sanitizeJsonSchema;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeTools = normalizeNativeTools;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeToolsForCall = normalizeNativeToolsForCall;
/** @internal — exported for unit tests only. */
export const __INTERNAL_restoreRecordArgToolCalls = restoreRecordArgToolCalls;
/** @internal — exported for schema-keyword parity tests only. */
export const __INTERNAL_sanitizeSchemaKeywords = {
  arrays: JSON_SCHEMA_ARRAY_KEYWORDS,
  maps: JSON_SCHEMA_MAP_KEYWORDS,
  mixedMaps: JSON_SCHEMA_MIXED_MAP_KEYWORDS,
  singles: JSON_SCHEMA_SINGLE_KEYWORDS,
};
/** @internal — exported for unit tests only. */
export const __INTERNAL_providerErrorBodyMessage = providerErrorBodyMessage;
/** @internal — exported for unit tests only. */
export const __INTERNAL_enrichProviderCallError = enrichProviderCallError;
/** @internal */
export const __INTERNAL_selectRequestModelName = selectRequestModelName;
/** @internal */
export const __INTERNAL_resolveFallbackModelName = resolveFallbackModelName;
/** @internal — exported for unit tests only. */
export const __INTERNAL_isTransientProviderError = isTransientProviderError;
/** @internal — exported for unit tests only. */
export const __INTERNAL_isSpuriousToolPairingRejection = isSpuriousToolPairingRejection;
/** @internal — exported for unit tests only. */
export const __INTERNAL_logToolPairingRejectionShape = logToolPairingRejectionShape;
