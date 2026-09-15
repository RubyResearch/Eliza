/**
 * `createOpenAIClient`: builds the `@ai-sdk/openai` provider bound to the
 * runtime's resolved base URL and key. In proxy mode with no key it uses a
 * placeholder key (auth is injected upstream); otherwise a missing key throws.
 * The text handler creates one client per model call. Its closure correlates
 * SDK retries without recording payloads or changing transport ownership.
 */
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import {
  composeToolDiagnosticRedactor,
  getInferenceTimer,
  getTrajectoryContext,
  type IAgentRuntime,
  type InferenceTimingMeta,
  logger,
} from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

const PROXY_API_KEY = "sk-proxy";
const SAFE_RESPONSE_HEADERS = [
  "x-request-id",
  "request-id",
  "retry-after",
  "retry-after-ms",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-limit-requests-minute",
  "x-ratelimit-remaining-requests-minute",
  "x-ratelimit-reset-requests-minute",
  "x-ratelimit-limit-tokens-minute",
  "x-ratelimit-remaining-tokens-minute",
  "x-ratelimit-reset-tokens-minute",
  "x-ratelimit-limit-requests-day",
  "x-ratelimit-remaining-requests-day",
  "x-ratelimit-reset-requests-day",
  "x-ratelimit-limit-tokens-day",
  "x-ratelimit-remaining-tokens-day",
  "x-ratelimit-reset-tokens-day",
] as const;

function observeHttpDiagnostic<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    // error-policy:J7 optional diagnostics cannot replace transport results or
    // errors. Do not recurse into a failing log sink or expose diagnostic inputs.
    return undefined;
  }
}

export function createOpenAIClient(
  runtime: IAgentRuntime,
  endpoint?: { baseURL: string; apiKey: string; provider: "openrouter" }
): OpenAIProvider {
  const baseURL = endpoint?.baseURL ?? getBaseURL(runtime);
  const apiKey =
    endpoint?.apiKey ?? (getApiKey(runtime) || (isProxyMode(runtime) ? PROXY_API_KEY : undefined));

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Set it in your environment variables or runtime settings."
    );
  }

  let httpAttempt = 0;
  const diagnostic = observeHttpDiagnostic(() => {
    const callId = globalThis.crypto.randomUUID();
    const trajectory = getTrajectoryContext();
    const timer = getInferenceTimer();
    const redact = composeToolDiagnosticRedactor(runtime);
    const diagnosticText = (value: string): string => {
      // Bound diagnostic fields only; never retain a prefix of an untrusted value.
      if (value.length > 256) return "[OMITTED]";
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return "[OMITTED]";
      }
      return redact(value);
    };
    const correlation: InferenceTimingMeta = {};
    for (const [key, value] of Object.entries({
      trajectoryId: trajectory?.trajectoryId,
      trajectoryStepId: trajectory?.trajectoryStepId,
      traceId: trajectory?.traceId,
      runId: trajectory?.runId,
      purpose: trajectory?.purpose,
      evaluatorName: trajectory?.evaluatorName,
      turnId: timer?.turnId,
      inferenceTraceId: timer?.traceId,
    })) {
      if (value !== undefined) correlation[key] = diagnosticText(value);
    }
    return { callId, timer, diagnosticText, correlation };
  });

  return createOpenAI({
    apiKey,
    baseURL,
    // Observe each actual HTTP attempt, including retries inside the AI SDK.
    // Model-call latency alone cannot distinguish retry waits from inference.
    // Never log request bodies, credentials, query strings, or response text.
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        // OpenRouter routes only to backends honoring the full tool/schema
        // contract. Its unified reasoning field differs from Cerebras's.
        if (endpoint?.provider === "openrouter" && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          const reasoning = body.reasoning_effort;
          delete body.reasoning_effort;
          delete body.prompt_cache_retention;
          body.provider = { require_parameters: true, data_collection: "deny", sort: "latency" };
          if (typeof reasoning === "string") {
            body.reasoning = reasoning === "none" ? { enabled: false } : { effort: reasoning };
          }
          init = { ...init, body: JSON.stringify(body) };
        }
        const attempt = ++httpAttempt;
        const startedAt = Date.now();
        const startedMonotonic = performance.now();
        const observer = observeHttpDiagnostic(() => {
          if (!diagnostic) return undefined;
          const host = diagnostic.diagnosticText(new URL(baseURL).hostname);
          const fields = {
            ...diagnostic.correlation,
            callId: diagnostic.callId,
            attempt,
            attemptId: `${diagnostic.callId}:${attempt}`,
            host,
            startedAt,
          };
          const span: InferenceTimingMeta = { ...fields, phase: "started" };
          const closeSpan = observeHttpDiagnostic(() =>
            diagnostic.timer?.openSpan("openai.http", span)
          );
          observeHttpDiagnostic(() =>
            logger.debug(
              { ...fields, phase: "started" },
              `[OpenAI] HTTP attempt=${attempt} host=${host} started`
            )
          );
          return { fields, host, span, closeSpan };
        });
        let response: Response;
        try {
          response = await globalThis.fetch(input, init);
        } catch (error) {
          // error-policy:J2 transport owns the original rejection; observers are isolated.
          const endedAt = Date.now();
          const failedAfterMs = Math.round(performance.now() - startedMonotonic);
          observeHttpDiagnostic(() => {
            if (!observer) return;
            observer.span.phase = "error";
            observer.closeSpan?.();
          });
          observeHttpDiagnostic(() => {
            if (!observer) return;
            logger.warn(
              { ...observer.fields, phase: "error", endedAt, failedAfterMs },
              `[OpenAI] HTTP attempt=${attempt} host=${observer.host} failedAfterMs=${failedAfterMs}`
            );
          });
          throw error;
        }
        const endedAt = Date.now();
        const headersMs = Math.round(performance.now() - startedMonotonic);
        observeHttpDiagnostic(() => {
          if (!observer) return;
          observer.span.phase = "response";
          observer.span.status = response.status;
          observer.closeSpan?.();
        });
        observeHttpDiagnostic(() => {
          if (!observer || !diagnostic) return;
          const responseHeaders: Record<string, string> = {};
          for (const name of SAFE_RESPONSE_HEADERS) {
            const value = response.headers.get(name);
            if (value !== null) responseHeaders[name] = diagnostic.diagnosticText(value);
          }
          const retryAfterSeconds = Number(responseHeaders["retry-after"]);
          const retryAfter =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? ` retryAfterSeconds=${retryAfterSeconds}`
              : "";
          const message = `[OpenAI] HTTP attempt=${attempt} host=${observer.host} status=${response.status} headersMs=${headersMs}${retryAfter}`;
          const completed = {
            ...observer.fields,
            phase: "response",
            endedAt,
            status: response.status,
            headersMs,
            responseHeaders,
          };
          if (response.ok) logger.debug(completed, message);
          else logger.warn(completed, message);
        });
        return response;
      },
      { preconnect: globalThis.fetch.preconnect }
    ),
  });
}
