/**
 * `emitModelUsageEvent`: normalizes token-usage counts from the three shapes the
 * plugin encounters (local `TokenUsage`, AI SDK usage, raw OpenAI API usage) into
 * one payload and emits `EventType.MODEL_USED` with the complete prompt.
 */
import type { IAgentRuntime, ModelEventPayload, ModelTypeName } from "@elizaos/core";
import { EventType, normalizeProviderUsage } from "@elizaos/core";
import type { TokenUsage } from "../types";
import { getUsageProvider } from "./config";

/**
 * Transient-retry totals for one model call. Accumulated by the retry loops in
 * `models/text.ts` and surfaced on MODEL_USED (and the call result's
 * `providerMetadata`) so a served response that survived provider hiccups is
 * distinguishable from a clean first-attempt response — an opaque retry loop
 * hides exactly the failure signal operators need when a provider degrades.
 */
export interface ModelRetryTelemetry {
  /** Transient attempts re-issued before this call was served; 0 = first attempt. */
  retryCount: number;
  /** Provider error message behind the most recent retry, when any occurred. */
  lastRetryReason: string | undefined;
}

type OpenAIModelUsageEventPayload = ModelEventPayload & {
  source: "openai";
  prompt: string;
  retryCount?: number;
  lastRetryReason?: string;
};

interface AISDKUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Hidden reasoning tokens the provider reports inside the output budget. */
  reasoningTokens?: number;
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}

interface OpenAIAPIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  /** Hidden reasoning tokens the provider reports inside the completion budget. */
  reasoningTokens?: number;
  promptTokensDetails?: {
    cachedTokens?: number;
  };
}

type ModelUsage = TokenUsage | AISDKUsage | OpenAIAPIUsage;

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: ModelUsage,
  modelName: string,
  retry?: ModelRetryTelemetry,
  provider = getUsageProvider(runtime)
): void {
  const normalized = normalizeProviderUsage(usage);
  const model = modelName.trim();
  if (!model) {
    throw new Error("MODEL_USED requires the concrete provider model name");
  }

  const payload: OpenAIModelUsageEventPayload = {
    runtime,
    source: "openai",
    provider,
    type,
    model,
    modelName: model,
    modelLabel: String(type),
    prompt,
    ...(retry
      ? {
          retryCount: retry.retryCount,
          ...(retry.lastRetryReason !== undefined
            ? { lastRetryReason: retry.lastRetryReason }
            : {}),
        }
      : {}),
    tokens: {
      prompt: normalized.promptTokens,
      completion: normalized.completionTokens,
      total: normalized.totalTokens,
      ...(normalized.cacheReadInputTokens !== undefined
        ? {
            cached: normalized.cacheReadInputTokens,
            cachedInputTokens: normalized.cacheReadInputTokens,
            cacheReadInputTokens: normalized.cacheReadInputTokens,
          }
        : {}),
      ...(normalized.reasoningTokens !== undefined
        ? { reasoningTokens: normalized.reasoningTokens }
        : {}),
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
