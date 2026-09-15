/**
 * Eliza Cloud image generation and description handlers. Requests preserve
 * caller output-budget intent and reject malformed operator limits before any
 * provider dispatch. Descriptions preserve the entire response and require a
 * complete finish reason before downstream extraction can use it.
 */

import type { IAgentRuntime, ImageDescriptionParams, ImageGenerationParams } from "@elizaos/core";
import { ElizaError, logger, ModelType } from "@elizaos/core";
import { resolveCloudBillingUrl } from "../cloud/base-url";
import {
  getBaseURL,
  getImageDescriptionModel,
  getImageGenerationModel,
  getSetting,
  resolveCloudTimeoutMs,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { parseImageDescriptionResponse } from "../utils/helpers";
import { createElizaCloudClient } from "../utils/sdk-client";

export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: ImageGenerationParams
): Promise<{ url: string }[]> {
  const numImages = params.count || 1;
  const size = params.size || "1024x1024";
  const prompt = params.prompt;
  const modelName = getImageGenerationModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE model: ${modelName}`);

  const aspectRatioMap: Record<string, string> = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
  };
  const aspectRatio = aspectRatioMap[size] || "1:1";

  try {
    const requestBody = {
      prompt: prompt,
      numImages: numImages,
      aspectRatio: aspectRatio,
      model: modelName,
    };

    const client = createElizaCloudClient(runtime);
    let typedData: Awaited<ReturnType<typeof client.generateImage>> | undefined;
    let warmingRetries = 0;
    for (;;) {
      try {
        typedData = await client.generateImage(requestBody);
        break;
      } catch (err) {
        // Cold-cache warming: this box runs text on Cerebras, so the cloud's
        // generative admission cache goes cold between rare image-gen calls
        // and the first hit throws "Generative admission cache is warming;
        // retry shortly", clearing within ~1s (verified live: success on the
        // first retry). Ride through it — the same transient the description
        // path handles in-place. A non-warming error still fails fast.
        const msg = err instanceof Error ? err.message : String(err);
        if (/warming|admission cache/i.test(msg) && warmingRetries < 2) {
          warmingRetries++;
          logger.warn(
            `[ELIZAOS_CLOUD] Image generation cold-cache warming, retry ${warmingRetries}/2...`
          );
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw err;
      }
    }

    // Fail closed, matching the sibling handlers in this package: video/audio
    // throw "...returned no video/audio URL" and image-description throws on an
    // empty completion. A request that asked for >=1 image but got back no
    // entries, or an entry that carries neither a `url` nor a base64 `image`
    // (partial/failed/moderated generation), is a failure — never fabricate a
    // healthy-looking `{ url: "" }` for the IMAGE slot (elizaOS/eliza#21985).
    const images = typedData.images;
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error("Eliza Cloud image generation returned no images");
    }
    const result = images.map((img: { url?: string; image?: string }) => {
      const url = [img.url, img.image].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim() !== "",
      );
      if (!url) {
        throw new Error("Eliza Cloud image generation returned no image URL");
      }
      return { url };
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ELIZAOS_CLOUD] Image generation error: ${message}`);
    throw error;
  }
}

export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<{ title: string; description: string }> {
  // Honour `DISABLE_IMAGE_DESCRIPTION` (set by the runtime when
  // `features.vision === false`). The runtime exposes it via getSetting; some
  // hosts only set it in process.env. Check both before burning a quota slot.
  // The docs (`docs/runtime/core.md`) already promise this behaviour, but
  // historically only `plugin-discord` honoured it at the call site, leaving
  // every other caller (agent-orchestrator's task validator, vision, lifeops,
  // farcaster, telegram) free to spend the rate-limit budget.
  const disableSetting = getSetting(runtime, "DISABLE_IMAGE_DESCRIPTION", "");
  const disabled = [disableSetting, process.env.DISABLE_IMAGE_DESCRIPTION].some((value) => {
    const normalized = value?.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  });
  if (disabled) {
    logger.debug("[ELIZAOS_CLOUD] IMAGE_DESCRIPTION skipped — DISABLE_IMAGE_DESCRIPTION is set");
    return {
      title: "Image description disabled",
      description: "Image description is disabled by configuration.",
    };
  }

  let imageUrl: string;
  let promptText: string | undefined;
  const modelName = getImageDescriptionModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using IMAGE_DESCRIPTION model: ${modelName}`);
  const configuredMaxTokens = (
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS", "") ?? ""
  ).trim();
  const maxTokens = configuredMaxTokens === "" ? undefined : Number(configuredMaxTokens);
  if (
    maxTokens !== undefined &&
    (!/^[1-9]\d*$/.test(configuredMaxTokens) ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens <= 0)
  ) {
    throw new ElizaError(
      "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS must be a positive safe integer",
      {
        code: "ELIZAOS_CLOUD_IMAGE_OUTPUT_BUDGET_INVALID",
        context: { received: configuredMaxTokens },
      }
    );
  }

  if (typeof params === "string") {
    imageUrl = params;
    promptText = "Please analyze this image and provide a title and detailed description.";
  } else {
    imageUrl = params.imageUrl;
    promptText =
      params.prompt || "Please analyze this image and provide a title and detailed description.";
  }

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const client = createElizaCloudClient(runtime);

  try {
    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: messages,
    };
    if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;

    // On 429, honour the upstream's `retryAfter` instead of retrying on a
    // hardcoded backoff. Hardcoded retries inside the rate-limit window add
    // wasted requests to the same bucket and make the problem worse — see
    // #7374's billing render-loop fix and S33's dashboard 429-aware UX.
    // Strategy: only retry once, only if the upstream signals a short wait
    // (≤5s, i.e. transient burst). Anything longer, bail immediately and let
    // the caller fail fast.
    let response: Response | null = null;
    let attemptedRetry = false;
    let warmingRetries = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const attemptResponse = await client.routes.postApiV1ChatCompletionsRaw({
        json: requestBody,
        timeoutMs: resolveCloudTimeoutMs("ELIZAOS_CLOUD_IMAGE_TIMEOUT_MS", 120_000),
      });
      if (!attemptResponse) {
        continue;
      }
      response = attemptResponse;
      if (attemptResponse.ok) break;

      // Transient cold-cache warming: this box runs text on Cerebras, so the
      // cloud's per-model billing/auth admission cache for the vision model
      // goes cold between rare image calls. The first image then hits a 503
      // whose body carries `billing_cache_warming`/`auth_cache_warming`
      // (type `service_unavailable`, retryable) that clears within ~1s — the
      // client-side companion to the server escape in #18249. Riding through
      // it here restores vision without waiting on the prod-cloud promote
      // (verified live: 200 on the first retry). The 429 branch below stays a
      // single retry; warming gets a few because a cold cache can need two.
      if (attemptResponse.status === 503 && warmingRetries < 2) {
        let warming = false;
        let warmingWait = 1;
        try {
          const peek = (await attemptResponse.clone().json()) as {
            error?: { code?: unknown; type?: unknown; retryAfter?: unknown };
            code?: unknown;
            type?: unknown;
            retryAfter?: unknown;
          };
          const code = String(peek?.error?.code ?? peek?.code ?? "");
          const type = String(peek?.error?.type ?? peek?.type ?? "");
          warming =
            code === "billing_cache_warming" ||
            code === "auth_cache_warming" ||
            type === "service_unavailable";
          const ra = peek?.error?.retryAfter ?? peek?.retryAfter;
          if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) {
            warmingWait = Math.min(ra, 3);
          }
        } catch {
          // Body wasn't JSON — treat a bare 503 as non-warming, fail fast.
        }
        if (warming) {
          warmingRetries++;
          logger.warn(
            `[ELIZAOS_CLOUD] Image analysis cold-cache warming (503), retry ${warmingRetries}/2 after ${warmingWait}s...`
          );
          await new Promise((r) => setTimeout(r, warmingWait * 1000));
          continue;
        }
      }

      if (attemptResponse.status !== 429 || attemptedRetry) break;

      // `Number(null) === 0`, so guard against a missing header before
      // calling `Number(...)` — otherwise the header path always wins with a
      // bogus `0` and the body fallback becomes unreachable.
      const headerValue = attemptResponse.headers.get("retry-after");
      const headerRetryAfter =
        headerValue !== null && Number.isFinite(Number(headerValue))
          ? Number(headerValue)
          : undefined;
      let bodyRetryAfter: number | undefined;
      try {
        const peek = (await attemptResponse.clone().json()) as {
          retryAfter?: unknown;
        };
        bodyRetryAfter =
          typeof peek?.retryAfter === "number" && Number.isFinite(peek.retryAfter)
            ? peek.retryAfter
            : undefined;
      } catch {
        // Body wasn't JSON — fall through to header value.
      }
      const retryAfter = headerRetryAfter ?? bodyRetryAfter ?? 0;

      if (retryAfter > 0 && retryAfter <= 5) {
        logger.warn(
          `[ELIZAOS_CLOUD] Image analysis rate-limited (429), retrying once after ${retryAfter}s...`
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        attemptedRetry = true;
        continue;
      }
      // Long rate-limit window: don't burn another bucket slot retrying inside it.
      logger.warn(
        `[ELIZAOS_CLOUD] Image analysis rate-limited (429); upstream retryAfter=${retryAfter || "unknown"}s — failing fast`
      );
      break;
    }

    if (!response) {
      throw new Error("ElizaOS Cloud API did not return a response");
    }

    const finalResponse = response;

    if (!finalResponse.ok) {
      const status = finalResponse.status;
      if (status === 402) {
        throw new Error(
          `Eliza Cloud credits exhausted — top up at ${resolveCloudBillingUrl(getBaseURL(runtime))}`,
        );
      }
      if (status === 429) {
        throw new Error(
          "Eliza Cloud rate limit exceeded for image description — try again in a minute"
        );
      }
      throw new Error(`ElizaOS Cloud API error: ${status}`);
    }

    type OpenAIResponseType = {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const typedResult = (await finalResponse.json()) as OpenAIResponseType;
    const content = typedResult.choices?.[0]?.message?.content;

    if (typedResult.usage) {
      emitModelUsageEvent(
        runtime,
        ModelType.IMAGE_DESCRIPTION,
        typeof params === "string" ? params : params.prompt || "",
        {
          inputTokens: typedResult.usage.prompt_tokens,
          outputTokens: typedResult.usage.completion_tokens,
          totalTokens: typedResult.usage.total_tokens,
        }
      );
    }

    const finishReason = typedResult.choices?.[0]?.finish_reason;
    if (finishReason !== "stop") {
      throw new ElizaError(
        "Eliza Cloud did not complete the image description; retry with a model capable of returning the complete page",
        {
          code: "MODEL_INCOMPLETE_OUTPUT",
          context: { provider: "elizacloud", finishReason },
        }
      );
    }

    if (!content) {
      throw new Error(
        "ElizaOS Cloud image description returned an empty completion"
      );
    }

    return parseImageDescriptionResponse(content);
  } catch (error) {
    // error-policy:J2 Preserve typed provider failures for the caller's boundary.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Error analyzing image (failing closed): ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}
