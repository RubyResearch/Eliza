/**
 * Assembles `openaiPlugin` — the elizaOS `Plugin` object that registers every
 * OpenAI-backed model handler on the `AgentRuntime`: text tiers (small→mega,
 * response-handler, action-planner), embeddings, tokenizer, image
 * generation/description, transcription, TTS, and deep research.
 *
 * Text/embedding/tokenizer/research handlers register statically via `models`.
 * The media handlers (IMAGE, IMAGE_DESCRIPTION, TRANSCRIPTION, TEXT_TO_SPEECH)
 * register in `init()` through `registerMediaModels`, which skips them in
 * Cerebras mode unless a per-capability endpoint override points at a server
 * that serves them. `tests` carries the live connectivity/round-trip suite the
 * plugin loader runs against a real endpoint.
 */
import type {
  TextToSpeechParams as CoreTextToSpeechParams,
  TranscriptionParams as CoreTranscriptionParams,
  DetokenizeTextParams,
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
  Plugin,
  ProcessEnvLike,
  ResearchParams,
  ResearchResult,
  TextEmbeddingParams,
  TokenizeTextParams,
} from "@elizaos/core";
import { EventType, logger, ModelType, registerProviderModels } from "@elizaos/core";
import {
  handleActionPlanner,
  handleImageDescription,
  handleImageGeneration,
  handleResearch,
  handleResponseHandler,
  handleTextEmbedding,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
  handleTextToSpeech,
  handleTokenizerDecode,
  handleTokenizerEncode,
  handleTranscription,
} from "./models";
import type { ImageGenerationResult, TextStreamResult } from "./types";
import {
  getApiKey,
  getAuthHeader,
  getBaseURL,
  getSetting,
  isBrowser,
  isCerebrasMode,
} from "./utils/config";

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;
const TEXT_NANO_MODEL_TYPE = ModelType.TEXT_NANO as string;
const TEXT_MEDIUM_MODEL_TYPE = ModelType.TEXT_MEDIUM as string;
const TEXT_MEGA_MODEL_TYPE = ModelType.TEXT_MEGA as string;
const RESPONSE_HANDLER_MODEL_TYPE = ModelType.RESPONSE_HANDLER as string;
const ACTION_PLANNER_MODEL_TYPE = ModelType.ACTION_PLANNER as string;

function hasExplicitCapabilityOverride(
  runtime: IAgentRuntime,
  overrideKeys: readonly string[]
): boolean {
  return overrideKeys.some((key) => {
    const value = getSetting(runtime, key);
    return typeof value === "string" && value.trim().length > 0;
  });
}

// Per-capability endpoint overrides: when set, the capability does not POST to
// getBaseURL, so it stays registered even in Cerebras mode. Only the base URL
// counts: OPENAI_IMAGE_DESCRIPTION_API_KEY alone still posts to getBaseURL
// (getImageDescriptionBaseURL falls back to it), i.e. straight at Cerebras.
// TRANSCRIPTION, TEXT_TO_SPEECH, and IMAGE have no such override today.
const mediaModelOverrideKeys: Record<string, readonly string[]> = {
  [ModelType.IMAGE_DESCRIPTION]: ["OPENAI_IMAGE_DESCRIPTION_BASE_URL"],
};

const mediaModels: NonNullable<Plugin["models"]> = {
  [ModelType.IMAGE]: async (
    runtime: IAgentRuntime,
    params: ImageGenerationParams
  ): Promise<ImageGenerationResult[]> => {
    return handleImageGeneration(runtime, params);
  },

  [ModelType.IMAGE_DESCRIPTION]: async (
    runtime: IAgentRuntime,
    params: ImageDescriptionParams | string
  ): Promise<{ title: string; description: string }> => {
    return handleImageDescription(runtime, params);
  },

  [ModelType.TRANSCRIPTION]: async (
    runtime: IAgentRuntime,
    input: CoreTranscriptionParams | Buffer | string
  ): Promise<string> => {
    return handleTranscription(runtime, input);
  },

  [ModelType.TEXT_TO_SPEECH]: async (
    runtime: IAgentRuntime,
    input: CoreTextToSpeechParams | string
  ): Promise<ArrayBuffer> => {
    return handleTextToSpeech(runtime, input);
  },
};

// Cerebras serves text models only: vision chat completions, /audio/transcriptions,
// /audio/speech, and /images/generations all fail against its endpoint. Mirror the
// embedding shouldUseLocalEmbeddingFallback gate (models/embedding.ts): in Cerebras
// mode these capabilities stay unregistered unless an explicit per-capability
// override points them at an endpoint that serves them, so consumers (e.g.
// plugin-discord's isImageDescriptionEnabled) skip gracefully instead of failing
// on every attachment.
export function registerMediaModels(runtime: IAgentRuntime): void {
  const cerebras = isCerebrasMode(runtime);
  const registrations: Array<Parameters<typeof registerProviderModels>[2][number]> = [];
  for (const [modelType, handler] of Object.entries(mediaModels)) {
    if (
      cerebras &&
      !hasExplicitCapabilityOverride(runtime, mediaModelOverrideKeys[modelType] ?? [])
    ) {
      logger.info(`[OpenAI] Not registering ${modelType}: the Cerebras endpoint does not serve it`);
      continue;
    }
    registrations.push({
      modelType,
      handler: handler as Parameters<IAgentRuntime["registerModel"]>[1],
      priority: openaiPlugin.priority,
    });
  }
  registerProviderModels(runtime, openaiPlugin.name, registrations);
}

function warnWhenApiKeyIsMissing(runtime: IAgentRuntime): void {
  if (isBrowser() || getApiKey(runtime)) return;
  logger.warn(
    "[OpenAI] No API key is configured for the selected OpenAI-compatible endpoint; model calls will fail until credentials are provided"
  );
}

/** Warm the configured endpoint during message preparation without dispatching HTTP. */
const providerPreconnects = new WeakMap<IAgentRuntime, { baseURL: string; attemptedAt: number }>();

function preconnectProvider(runtime: IAgentRuntime): void {
  const preconnect = (
    globalThis.fetch as typeof fetch & {
      preconnect?: (url: string) => void;
    }
  ).preconnect;
  if (typeof preconnect !== "function") return;
  try {
    const baseURL = getBaseURL(runtime);
    const now = Date.now();
    const previous = providerPreconnects.get(runtime);
    if (
      previous?.baseURL === baseURL &&
      now >= previous.attemptedAt &&
      now - previous.attemptedAt < 15_000
    )
      return;
    providerPreconnects.set(runtime, { baseURL, attemptedAt: now });
    preconnect(baseURL);
  } catch {
    // Connection warming is optional. Reporting an agent error here triggers
    // proactive user notifications even when the actual model request succeeds.
    // The model request owns provider failures; retain a quiet debug diagnostic.
    logger.debug("[OpenAI] Connection warm-up unavailable; continuing with normal model requests.");
  }
}

export const openaiPlugin: Plugin = {
  events: {
    [EventType.MESSAGE_RECEIVED]: [async ({ runtime }) => preconnectProvider(runtime)],
    [EventType.VOICE_MESSAGE_RECEIVED]: [async ({ runtime }) => preconnectProvider(runtime)],
  },
  name: "openai",
  description: "OpenAI API integration for text, image, audio, and embedding models",
  autoEnable: {
    envKeys: ["OPENAI_API_KEY", "CEREBRAS_API_KEY", "EVOLINK_API_KEY"],
  },

  config: {
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? null,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? null,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? null,
    OPENROUTER_FALLBACK_MODEL: env.OPENROUTER_FALLBACK_MODEL ?? null,
    OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL ?? null,
    EVOLINK_API_KEY: env.EVOLINK_API_KEY ?? null,
    EVOLINK_BASE_URL: env.EVOLINK_BASE_URL ?? null,
    EVOLINK_MODEL: env.EVOLINK_MODEL ?? null,
    OPENAI_NANO_MODEL: env.OPENAI_NANO_MODEL ?? null,
    OPENAI_MEDIUM_MODEL: env.OPENAI_MEDIUM_MODEL ?? null,
    OPENAI_SMALL_MODEL: env.OPENAI_SMALL_MODEL ?? null,
    OPENAI_LARGE_MODEL: env.OPENAI_LARGE_MODEL ?? null,
    OPENAI_MEGA_MODEL: env.OPENAI_MEGA_MODEL ?? null,
    OPENAI_RESPONSE_HANDLER_MODEL: env.OPENAI_RESPONSE_HANDLER_MODEL ?? null,
    OPENAI_SHOULD_RESPOND_MODEL: env.OPENAI_SHOULD_RESPOND_MODEL ?? null,
    OPENAI_ACTION_PLANNER_MODEL: env.OPENAI_ACTION_PLANNER_MODEL ?? null,
    OPENAI_PLANNER_MODEL: env.OPENAI_PLANNER_MODEL ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    OPENAI_EMBEDDING_MODEL: env.OPENAI_EMBEDDING_MODEL ?? null,
    OPENAI_EMBEDDING_API_KEY: env.OPENAI_EMBEDDING_API_KEY ?? null,
    OPENAI_EMBEDDING_URL: env.OPENAI_EMBEDDING_URL ?? null,
    OPENAI_EMBEDDING_DIMENSIONS: env.OPENAI_EMBEDDING_DIMENSIONS ?? null,
    OPENAI_IMAGE_DESCRIPTION_API_KEY: env.OPENAI_IMAGE_DESCRIPTION_API_KEY ?? null,
    OPENAI_IMAGE_DESCRIPTION_BASE_URL: env.OPENAI_IMAGE_DESCRIPTION_BASE_URL ?? null,
    OPENAI_IMAGE_DESCRIPTION_MODEL: env.OPENAI_IMAGE_DESCRIPTION_MODEL ?? null,
    OPENAI_EXPERIMENTAL_TELEMETRY: env.OPENAI_EXPERIMENTAL_TELEMETRY ?? null,
    OPENAI_RESEARCH_MODEL: env.OPENAI_RESEARCH_MODEL ?? null,
    OPENAI_RESEARCH_TIMEOUT: env.OPENAI_RESEARCH_TIMEOUT ?? null,
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    warnWhenApiKeyIsMissing(runtime);
    registerMediaModels(runtime);
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      runtime: IAgentRuntime,
      params: TokenizeTextParams
    ): Promise<number[]> => {
      return handleTokenizerEncode(runtime, params);
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      runtime: IAgentRuntime,
      params: DetokenizeTextParams
    ): Promise<string> => {
      return handleTokenizerDecode(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_NANO_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextNano(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMedium(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleActionPlanner(runtime, params);
    },

    // IMAGE / IMAGE_DESCRIPTION / TRANSCRIPTION / TEXT_TO_SPEECH are registered
    // in init() via registerMediaModels so registration can be gated on the
    // resolved endpoint actually serving them (see Cerebras gate above).

    [ModelType.RESEARCH]: async (
      runtime: IAgentRuntime,
      params: ResearchParams
    ): Promise<ResearchResult> => {
      return handleResearch(runtime, params);
    },
  },

  tests: [
    {
      name: "openai_plugin_tests",
      tests: [
        {
          name: "openai_test_api_connectivity",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: getAuthHeader(runtime),
            });

            if (!response.ok) {
              throw new Error(
                `API connectivity test failed: ${response.status} ${response.statusText}`
              );
            }

            const data = (await response.json()) as { data?: unknown[] };
            logger.info(`[OpenAI Test] API connected. ${data.data?.length ?? 0} models available.`);
          },
        },
        {
          name: "openai_test_text_embedding",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "Hello, world!",
            });

            if (!Array.isArray(embedding) || embedding.length === 0) {
              throw new Error("Embedding should return a non-empty array");
            }

            logger.info(`[OpenAI Test] Generated embedding with ${embedding.length} dimensions`);
          },
        },
        {
          name: "openai_test_text_small",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 5 words.",
            });

            if (typeof text !== "string" || text.length === 0) {
              throw new Error("TEXT_SMALL should return non-empty string");
            }

            logger.info(`[OpenAI Test] TEXT_SMALL generated: "${text.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_text_large",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Explain quantum computing in 2 sentences.",
            });

            if (typeof text !== "string" || text.length === 0) {
              throw new Error("TEXT_LARGE should return non-empty string");
            }

            logger.info(`[OpenAI Test] TEXT_LARGE generated: "${text.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_tokenizer_roundtrip",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const originalText = "Hello, tokenizer test!";

            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
              prompt: originalText,
              modelType: ModelType.TEXT_SMALL,
            });

            if (!Array.isArray(tokens) || tokens.length === 0) {
              throw new Error("Tokenization should return non-empty token array");
            }

            const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
              tokens,
              modelType: ModelType.TEXT_SMALL,
            });

            if (decodedText !== originalText) {
              throw new Error(
                `Tokenizer roundtrip failed: expected "${originalText}", got "${decodedText}"`
              );
            }

            logger.info(`[OpenAI Test] Tokenizer roundtrip successful (${tokens.length} tokens)`);
          },
        },
        {
          name: "openai_test_streaming",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const chunks: string[] = [];

            const result = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Count from 1 to 5, one number per line.",
              stream: true,
              onStreamChunk: (chunk: string) => {
                chunks.push(chunk);
              },
            });

            if (typeof result !== "string" || result.length === 0) {
              throw new Error("Streaming should return non-empty result");
            }

            if (chunks.length === 0) {
              throw new Error("No streaming chunks received");
            }

            logger.info(`[OpenAI Test] Streaming test: ${chunks.length} chunks received`);
          },
        },
        {
          name: "openai_test_image_description",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const testImageUrl =
              "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/440px-Camponotus_flavomarginatus_ant.jpg";

            const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, testImageUrl);

            if (
              !result ||
              typeof result !== "object" ||
              !("title" in result) ||
              !("description" in result)
            ) {
              throw new Error("Image description should return { title, description }");
            }

            logger.info(`[OpenAI Test] Image described: "${result.title}"`);
          },
        },
        {
          name: "openai_test_transcription",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            // Fetch a short audio sample
            const audioUrl =
              "https://upload.wikimedia.org/wikipedia/commons/2/25/En-Open_Source.ogg";

            const response = await fetch(audioUrl);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = Buffer.from(new Uint8Array(arrayBuffer));

            const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

            if (typeof transcription !== "string") {
              throw new Error("Transcription should return a string");
            }

            logger.info(`[OpenAI Test] Transcription: "${transcription.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_text_to_speech",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const audioData = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
              text: "Hello, this is a text-to-speech test.",
            });

            if (!(audioData instanceof ArrayBuffer) || audioData.byteLength === 0) {
              throw new Error("TTS should return non-empty ArrayBuffer");
            }

            logger.info(`[OpenAI Test] TTS generated ${audioData.byteLength} bytes of audio`);
          },
        },
        {
          name: "openai_test_structured_output_via_text_large",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const result = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt:
                "Return a JSON object with exactly these fields: name (string), age (number), active (boolean)",
              responseSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  age: { type: "number" },
                  active: { type: "boolean" },
                },
                required: ["name", "age", "active"],
              },
            } as GenerateTextParams);

            if (!result || (typeof result !== "object" && typeof result !== "string")) {
              throw new Error("Structured output should return an object or text");
            }

            logger.info(
              `[OpenAI Test] Structured output: ${JSON.stringify(result).substring(0, 100)}`
            );
          },
        },
        {
          name: "openai_test_research",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            // Note: Deep research can take a long time (minutes to hours)
            // This test uses a simple query with maxToolCalls to limit execution time
            const result = await runtime.useModel(ModelType.RESEARCH, {
              input: "What is the current date and time?",
              tools: [{ type: "web_search_preview" }],
              maxToolCalls: 3, // Limit tool calls for faster test execution
            });

            if (!result || typeof result !== "object" || !("text" in result)) {
              throw new Error("Research should return an object with text property");
            }

            if (typeof result.text !== "string" || result.text.length === 0) {
              throw new Error("Research result text should be a non-empty string");
            }

            logger.info(
              `[OpenAI Test] Research completed. Text length: ${result.text.length}, Annotations: ${result.annotations.length}`
            );
          },
        },
      ],
    },
  ],
};

export default openaiPlugin;
