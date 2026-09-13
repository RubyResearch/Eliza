/**
 * POST /api/v1/embeddings
 *
 * OpenAI-compatible embeddings endpoint. Routes through the AI SDK + AI
 * Gateway with credit reservation/bill-and-record on the SDK's reported
 * usage. When INFERENCE_PASSTHROUGH_EMBEDDINGS is on and OpenAI serves the
 * model directly, the upstream JSON is returned verbatim (#15512) — the same
 * admission/settle chain runs either way, only the middle hop changes.
 */

import { APICallError, embed, embedMany, RetryError } from "ai";
import { Hono } from "hono";
import {
  resolveInferenceAuthStandingDenial,
  resolveInferenceCredentialAdmissionDenial,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import {
  bindGatewayHandoffTelemetry,
  type GatewayHandoffTelemetry,
  type GatewayPreforwardTiming,
  resolveElizaTraceId,
  snapshotGatewayPreforwardTiming,
  withGatewayPreforwardTelemetry,
  withInferenceAuthTelemetry,
} from "@/lib/observability/http-telemetry";
import {
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import {
  getAiProviderConfigurationError,
  getTextEmbeddingModel,
  hasTextEmbeddingProviderConfigured,
  resolveEmbeddingProviderSource,
  resolvePassthroughEmbeddingsUpstream,
} from "@/lib/providers/language-model";
import { billUsage, InsufficientCreditsError } from "@/lib/services/ai-billing";
import type { CreditReservation } from "@/lib/services/credits";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { inferenceRateLimitConfig } from "@/lib/services/inference-admission-snapshot";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import {
  type InferenceAuthTelemetry,
  resolveInferenceAuthContext,
} from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import type { InferenceCredentialCheck } from "@/lib/services/inference-credential-revocation";
import { isPassthroughEmbeddingsEnabled } from "@/lib/services/inference-passthrough";
import { isKnownUnacceptedProviderError } from "@/lib/services/inference-provider-outcome";
import {
  admitOrganizationInference,
  InferenceAdmissionUnavailableError,
  InferenceAffiliateCacheUnavailableError,
  InferencePricingCacheUnavailableError,
  type OrganizationInferenceAdmission,
} from "@/lib/services/organization-inference-admission";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const telemetryStartedAt = performance.now();
  const traceId = resolveElizaTraceId(c.req.raw.headers);
  let authTelemetry: InferenceAuthTelemetry | undefined;
  let preforwardTiming: GatewayPreforwardTiming | undefined;
  const attachTelemetry = (response: Response): Response => {
    const withAuth = authTelemetry
      ? withInferenceAuthTelemetry(response, traceId, authTelemetry)
      : response;
    return preforwardTiming
      ? withGatewayPreforwardTelemetry(withAuth, traceId, preforwardTiming)
      : withAuth;
  };
  let settleReservation: OrganizationInferenceAdmission["settle"] | undefined;
  let settleUnknown:
    | OrganizationInferenceAdmission["settleUnknown"]
    | undefined;
  let markProviderDispatched:
    | OrganizationInferenceAdmission["markProviderDispatched"]
    | undefined;
  let billingReservation: CreditReservation | undefined;
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  let admissionSnapshot: InferenceAdmissionSnapshot | undefined;
  let admissionCredential: InferenceCredentialCheck | undefined;
  let providerRequestId: string | undefined;
  let providerModel: string | undefined;
  try {
    const candidate = c.executionCtx;
    executionCtx =
      typeof candidate?.waitUntil === "function" ? candidate : undefined;
  } catch {
    // error-policy:J4 Hono intentionally throws outside Workers; local tools
    // retain compatibility, while enabled Worker admission fails closed below.
    executionCtx = undefined;
  }
  if (!executionCtx && c.env?.INFERENCE_DEFERRED_ADMISSION === "true") {
    logger.error(
      "[Embeddings] Worker execution context is unavailable for cache-only inference",
    );
    return c.json(
      {
        error: {
          message: "Inference authorization is warming. Retry shortly.",
          type: "service_unavailable",
          code: "inference_context_unavailable",
        },
      },
      503,
    );
  }
  // True once settleBilling() has taken ownership of settling/releasing the
  // reservation, so the outer catch never double-applies a release.
  let billed = false;
  let providerDispatched = false;
  try {
    let guardOrganizationId: string | undefined;
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => guardOrganizationId,
      credential: () => admissionCredential,
    });
    const request = (await c.req
      .json()
      .catch(() => null)) as EmbeddingsRequest | null;
    const requestIsValid = Boolean(request?.model && request.input);
    const invalidRequestResponse = !requestIsValid
      ? c.json(
          {
            error: {
              message: "Missing required fields: model and input",
              type: "invalid_request_error",
              param: !request?.model ? "model" : "input",
              code: "missing_required_parameter",
            },
          },
          400,
        )
      : undefined;

    // Resolve auth (+ org + moderation) in a SINGLE cache read for API-key
    // inference requests (#9899) — the same fast-path as /v1/chat/completions.
    // This route is on the agent reply hot path: the always-on
    // `relevant-conversations` recall provider embeds the incoming message on
    // EVERY memory-backed turn (blocking Stage-1), so the old per-request
    // auth+org+moderation DB chain added ~1.5s+ to every reply. Workers fail
    // closed on cold cache state while hydration runs under waitUntil; the
    // authoritative compatibility path is available only outside Workers.
    let user: { id: string; organization_id: string };
    let apiKeyId: string | null;
    const resolution = await resolveInferenceAuthContext(c.req.raw, {
      traceId,
      executionCtx,
      cacheOnly: Boolean(executionCtx),
      deferStrongCredentialCheck: Boolean(executionCtx) && requestIsValid,
      onTelemetry: (telemetry) => {
        authTelemetry = telemetry;
      },
    });
    if (resolution.kind === "warming") {
      return c.json(
        {
          error: {
            message: "Authorization cache is warming. Retry shortly.",
            type: "service_unavailable",
            code: "auth_cache_warming",
          },
        },
        503,
      );
    }
    if (resolution.kind === "suspended") {
      const denial = resolveInferenceAuthStandingDenial(resolution, {
        route: "embeddings",
        traceId: c.get("traceId") ?? c.get("requestId"),
      });
      return c.json(
        {
          error: {
            message: denial.message,
            type: denial.type,
            code: denial.code,
            details: { reason: denial.reason },
          },
        },
        denial.status,
      );
    }
    if (resolution.kind === "rejected") {
      const denial = resolveInferenceAuthStandingDenial(resolution, {
        route: "embeddings",
        traceId: c.get("traceId") ?? c.get("requestId"),
      });
      return c.json(
        {
          error: {
            message: denial.message,
            type: denial.type,
            code: denial.code,
            details: { reason: denial.reason },
          },
        },
        denial.status,
        denial.retryAfterSeconds
          ? { "Retry-After": String(denial.retryAfterSeconds) }
          : undefined,
      );
    }
    if (resolution.kind === "authorized") {
      user = {
        id: resolution.ctx.userId,
        organization_id: resolution.ctx.orgId,
      };
      guardOrganizationId = user.organization_id;
      apiKeyId = resolution.ctx.apiKeyId;
      admissionSnapshot = resolution.ctx.admission;
      admissionCredential = resolution.credential;
    } else {
      if (executionCtx) {
        return c.json(
          {
            error: {
              message: "Authentication required.",
              type: "authentication_error",
              code: "authentication_required",
            },
          },
          401,
        );
      }
      user = await requireUserOrApiKeyWithOrg(c);
      // `requireUserOrApiKeyWithOrg` already validated the API key (when present)
      // and exposed its id on the request context — reuse it instead of doing a
      // second DB lookup per request.
      apiKeyId = c.get("apiKeyId") ?? null;
    }

    const tAuth = performance.now();
    const orgRateLimitPromise = user.organization_id
      ? enforceOrgRateLimit(user.organization_id, "embeddings", {
          cacheOnly: Boolean(executionCtx),
          executionCtx,
          config: inferenceRateLimitConfig(admissionSnapshot, "embeddings"),
        })
      : Promise.resolve(null);

    // Guard a malformed/empty body to a 400 instead of a 500 (mirrors the agents
    // routes). An unguarded parse throws a SyntaxError that failureResponse maps
    // to 500 on this always-on agent-recall hot path.
    if (!request?.model || !request.input) return invalidRequestResponse!;

    let orgRateLimited: Response | null;
    try {
      orgRateLimited = await orgRateLimitPromise;
    } catch (error) {
      // error-policy:J1 the route boundary translates a cold policy cache into
      // a retryable response; all other errors continue to the outer boundary.
      if (error instanceof OrgRateLimitCacheNotReadyError) {
        return c.json(
          {
            error: {
              message:
                error.state === "warming"
                  ? "Organization rate-limit policy is warming. Retry shortly."
                  : "Organization rate-limit policy cache is unavailable. Retry shortly.",
              type: "service_unavailable",
              code:
                error.state === "warming"
                  ? "rate_limit_cache_warming"
                  : "rate_limit_cache_unavailable",
            },
          },
          503,
        );
      }
      throw error;
    }
    if (orgRateLimited) return orgRateLimited;

    if (Array.isArray(request.input) && request.input.length === 0) {
      return c.json(
        {
          error: {
            message: "input array cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    if (
      typeof request.input === "string" &&
      request.input.trim().length === 0
    ) {
      return c.json(
        {
          error: {
            message: "input string cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    const model = request.model;
    providerModel = model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveEmbeddingProviderSource();

    if (!hasTextEmbeddingProviderConfigured() || !billingSource) {
      return c.json(
        {
          error: {
            message: getAiProviderConfigurationError(),
            type: "service_unavailable",
            code: "ai_not_configured",
          },
        },
        503,
      );
    }

    const inputText = Array.isArray(request.input)
      ? request.input.join(" ")
      : request.input;
    const estimatedInputTokens = estimateTokens(inputText);

    const requestId = crypto.randomUUID();
    providerRequestId = requestId;
    const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;
    const tBeforeReserve = performance.now();
    try {
      const admission = await admitOrganizationInference({
        context: {
          organizationId: user.organization_id,
          userId: user.id,
          apiKeyId,
          model,
          provider,
          billingSource,
          requestId,
        },
        apiKeyId,
        estimatedInputTokens,
        estimatedOutputTokens: 0,
        affiliateCode,
        executionCtx,
        admissionSnapshot,
        credential: credentialGuard.credentialForAdmission(),
        atomicProviderBoundary: Boolean(executionCtx),
      });
      settleReservation = admission.settle;
      settleUnknown = admission.settleUnknown;
      markProviderDispatched = admission.markProviderDispatched;
      billingReservation = admission.reservation;
    } catch (error) {
      // error-policy:J1 the route boundary exposes cached credit decisions and
      // cache readiness without falling through to authoritative storage.
      const denial = resolveInferenceCredentialAdmissionDenial(error, {
        route: "embeddings",
        traceId: c.get("traceId") ?? c.get("requestId"),
      });
      if (denial) {
        return c.json(
          {
            error: {
              message: denial.message,
              type: denial.type,
              code: denial.code,
              details: { reason: denial.reason },
            },
          },
          denial.status,
        );
      }
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          {
            error: {
              message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
              type: "insufficient_quota",
              code: "insufficient_balance",
            },
          },
          402,
        );
      }
      if (error instanceof InferenceAdmissionUnavailableError) {
        logger.error(
          "[Embeddings] inference admission transport failed closed",
          {
            traceId: c.get("traceId") ?? c.get("requestId"),
            error: error.message,
            cause:
              error.cause instanceof Error
                ? `${error.cause.name}: ${error.cause.message}`
                : undefined,
          },
        );
        return c.json(
          {
            error: {
              message:
                "Inference admission is temporarily unavailable. Retry shortly.",
              type: "service_unavailable",
              code: "inference_admission_unavailable",
            },
          },
          503,
          { "Retry-After": "1" },
        );
      }
      if (error instanceof InferenceBalanceCacheWarmingError) {
        const unavailable =
          error instanceof InferencePricingCacheUnavailableError ||
          error instanceof InferenceAffiliateCacheUnavailableError;
        return c.json(
          {
            error: {
              message: unavailable
                ? "Inference admission cache is unavailable. Retry shortly."
                : "Inference admission cache is warming. Retry shortly.",
              type: "service_unavailable",
              code: unavailable
                ? "inference_admission_cache_unavailable"
                : "inference_admission_cache_warming",
            },
          },
          503,
        );
      }
      throw error;
    }

    const tAfterReserve = performance.now();
    // Match chat timing: stop before the direct fetch / SDK invocation, after
    // argument construction and the existing provider-dispatch admission gate.
    const handoffTelemetry: GatewayHandoffTelemetry = {
      capture: () => {
        const handoffAt = performance.now();
        preforwardTiming = snapshotGatewayPreforwardTiming({
          authMs: tAuth - telemetryStartedAt,
          middleMs: tBeforeReserve - tAuth,
          reserveMs: tAfterReserve - tBeforeReserve,
          setupMs: handoffAt - tAfterReserve,
          totalMs: handoffAt - telemetryStartedAt,
        });
      },
      emit: () => {
        logger.info("[Embeddings][preforward]", {
          traceId,
          model,
          ...preforwardTiming,
        });
      },
    };

    // billUsage receives the admission settler so affiliate earnings remain
    // clamped to what the authoritative asynchronous reservation collected.
    const settleOwner = settleReservation;
    const settlerBackedReservation: CreditReservation = billingReservation ?? {
      reservedAmount: 0,
      reservationTransactionId: null,
      reconcile: async (actualCost: number) =>
        (await settleOwner(actualCost)) ?? undefined,
    };

    logger.info("[Embeddings] Request", {
      model,
      inputCount: Array.isArray(request.input) ? request.input.length : 1,
      estimatedTokens: estimatedInputTokens,
    });

    let embeddings: number[][] = [];
    let actualTokens = 0;

    // #15512 pass-through fast path: when OpenAI serves the model directly,
    // forward the validated request verbatim and return the upstream bytes
    // untouched — no AI-SDK decode/validate/re-encode of the float arrays.
    // Usage is parsed once from the same buffer so the settle chain below
    // bills exactly what the provider reported, identical to the SDK path.
    let passthroughBody: ArrayBuffer | null = null;
    const passthroughUpstream =
      isPassthroughEmbeddingsEnabled() &&
      resolveEmbeddingProviderSource() === "openai"
        ? resolvePassthroughEmbeddingsUpstream(model)
        : null;

    if (passthroughUpstream) {
      await markProviderDispatched?.();
      providerDispatched = true;
      const upstreamResponse = await bindGatewayHandoffTelemetry(
        handoffTelemetry,
        (init: RequestInit) => fetch(passthroughUpstream.url, init),
      )({
        method: "POST",
        headers: {
          Authorization: `Bearer ${passthroughUpstream.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...request,
          model: passthroughUpstream.modelId,
        }),
      });
      if (!upstreamResponse.ok) {
        // Throw the same error shape the SDK path produces so the route catch
        // maps it (429/402/503) and releases the credit hold — one failure path.
        throw new APICallError({
          message: `Upstream embeddings request failed with status ${upstreamResponse.status}`,
          url: passthroughUpstream.url,
          requestBodyValues: { model: passthroughUpstream.modelId },
          statusCode: upstreamResponse.status,
          responseHeaders: {},
          responseBody: await upstreamResponse.text(),
        });
      }
      passthroughBody = await upstreamResponse.arrayBuffer();
      const parsed = JSON.parse(new TextDecoder().decode(passthroughBody)) as {
        usage?: { prompt_tokens?: number };
      };
      actualTokens = parsed.usage?.prompt_tokens || estimatedInputTokens;
    } else if (Array.isArray(request.input)) {
      const embeddingModel = getTextEmbeddingModel(model);
      await markProviderDispatched?.();
      providerDispatched = true;
      const result = await bindGatewayHandoffTelemetry(
        handoffTelemetry,
        embedMany,
      )({
        model: embeddingModel,
        values: request.input,
      });
      embeddings = result.embeddings;
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    } else {
      const embeddingModel = getTextEmbeddingModel(model);
      await markProviderDispatched?.();
      providerDispatched = true;
      const result = await bindGatewayHandoffTelemetry(
        handoffTelemetry,
        embed,
      )({
        model: embeddingModel,
        value: request.input,
      });
      embeddings = [result.embedding];
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    }
    // Reconciliation and usage recording run after the vector response. The
    // pre-dispatch cache gate rejects known insufficient balances, while the
    // durable admission promise and this settlement are both owned by
    // waitUntil. The settler prevents double-settlement inside the task.
    const settleBilling = async () => {
      try {
        // #10557: `settleReservation` is the SINGLE idempotent reconcile owner
        // (mirrors /v1/messages and /v1/chat/completions). billUsage is handed
        // the settler-backed reservation VIEW (never the raw reservation), so
        // its internal reconcile also flows through the first-call-wins settler
        // — no double-settlement is possible with the explicit settle below or
        // with the catch's conservative terminal. Routing the reconcile through
        // billUsage (before its affiliate-earnings write) is what arms the
        // #11976 collected-earnings clamp on this path (#12017 leg 2).
        const billing = await billUsage(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId,
            model,
            provider,
            billingSource,
            // #11588: the server-generated requestId keys the affiliate
            // earnings dedupe sourceId (`ai_billing:usage:<requestId>`);
            // without it billUsage falls back to a compatibility-random sourceId and
            // the dedupe can never fire.
            requestId,
            // Affiliate revenue-share: when the calling app sets X-Affiliate-Code,
            // activate the existing billUsage affiliate branch (same as /v1/messages).
            affiliateCode,
          },
          { inputTokens: actualTokens, outputTokens: 0 },
          settlerBackedReservation,
        );

        // Safety-net settle: billUsage already reconciled the actual cost
        // through the settler, so this is an idempotent no-op that only fires
        // if billUsage ever returns without reconciling.
        await settleReservation?.(billing.totalCost);

        logger.info("[Embeddings] Complete", {
          model,
          actualTokens,
          totalCost: billing.totalCost,
        });

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKeyId,
          type: "embeddings",
          model: normalizedModel,
          provider,
          input_tokens: actualTokens,
          output_tokens: 0,
          input_cost: String(billing.inputCost),
          output_cost: String(0),
          is_successful: true,
        });
      } catch (err) {
        // error-policy:J7 settlement is a background job; its conservative
        // terminal remains
        // observable and the rejection is handled by billedPromise below.
        // billUsage / calculateCost / affiliate lookup threw before the hold was
        // reconciled after provider usage occurred, so zero is not an honest
        // fallback. Idempotent: a no-op if the actual cost already settled.
        // Rethrow so the waitUntil .catch logs it.
        await settleUnknown?.();
        throw err;
      }
    };

    // Past this point the deferred settleBilling owns the hold (it settles the
    // actual cost on success and releases it on its own failure), so the outer
    // catch must NOT also release it.
    billed = true;
    const billedPromise = settleBilling().catch((err) => {
      // error-policy:J7 deferred settlement runs after the response is returned; its rejection is observed here and drained by waitUntil below. The hold is released inside settleBilling's own failure path.
      logger.error("[Embeddings] Failed to settle billing", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (executionCtx) {
      executionCtx.waitUntil(billedPromise);
    }

    // Verbatim upstream bytes for the pass-through path — billing above ran
    // identically, only the response encoding hop is skipped. The header lets
    // probes distinguish the paths without log access (same convention as
    // /v1/chat/completions).
    if (passthroughBody) {
      return attachTelemetry(
        new Response(passthroughBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Inference-Path": "passthrough",
          },
        }),
      );
    }

    return attachTelemetry(
      c.json({
        object: "list",
        data: embeddings.map((embedding, index) => ({
          object: "embedding",
          embedding,
          index,
        })),
        model,
        usage: {
          prompt_tokens: actualTokens,
          total_tokens: actualTokens,
        },
      }),
    );
  } catch (error) {
    // error-policy:J1 route boundary — this catch cancels admitted credit on a
    // provider failure and translates the failure into a structured response.
    // The same idempotent settler owns deferred ledgers and reservations, so a
    // failure cannot double-refund or supersede a successful settlement.
    if (!billed && settleReservation) {
      const conservative =
        providerDispatched &&
        !isKnownUnacceptedProviderError(error) &&
        Boolean(settleUnknown);
      const releaseReservation =
        conservative && settleUnknown ? settleUnknown() : settleReservation(0);
      const observedRelease = releaseReservation
        .then(() => {
          logger.info("[Embeddings] Admission settled after provider error", {
            conservative,
          });
        })
        .catch((reconcileError) => {
          // error-policy:J7 deferred settlement failures are observed here and
          // drained by the Worker execution context.
          logger.error(
            "[Embeddings] Failed to release reservation after error",
            {
              error:
                reconcileError instanceof Error
                  ? reconcileError.message
                  : String(reconcileError),
            },
          );
        });
      if (executionCtx) {
        executionCtx.waitUntil(observedRelease);
      } else {
        await observedRelease;
      }
    }

    const credentialDenial = resolveInferenceCredentialAdmissionDenial(error, {
      route: "embeddings",
      traceId: c.get("traceId") ?? c.get("requestId"),
    });
    if (credentialDenial) {
      return c.json(
        {
          error: {
            message: credentialDenial.message,
            type: credentialDenial.type,
            code: credentialDenial.code,
            details: { reason: credentialDenial.reason },
          },
        },
        credentialDenial.status,
      );
    }

    if (error instanceof InsufficientCreditsError) {
      return c.json(
        {
          error: {
            message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
            type: "insufficient_quota",
            code: "insufficient_balance",
          },
        },
        402,
      );
    }
    if (error instanceof InferenceAdmissionUnavailableError) {
      logger.error("[Embeddings] provider-boundary admission failed closed", {
        traceId: c.get("traceId") ?? c.get("requestId"),
        requestId: providerRequestId,
        model: providerModel,
        phase: "provider_dispatch",
        error: error.message,
        cause:
          error.cause instanceof Error
            ? `${error.cause.name}: ${error.cause.message}`
            : undefined,
      });
      return c.json(
        {
          error: {
            message:
              "Inference admission is temporarily unavailable. Retry shortly.",
            type: "service_unavailable",
            code: "inference_admission_unavailable",
          },
        },
        503,
        { "Retry-After": "1" },
      );
    }

    logger.error("[Embeddings] Error", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Upstream provider failures (invalid provider key, provider 5xx) must not
    // surface as 401/403 to the caller — the user authenticated to us fine.
    const providerError = RetryError.isInstance(error)
      ? error.lastError
      : error;
    if (APICallError.isInstance(providerError)) {
      const status =
        providerError.statusCode === 429
          ? 429
          : providerError.statusCode === 402
            ? 402
            : 503;
      return c.json(
        {
          error: {
            message: providerError.message || "Upstream provider error",
            type: status === 429 ? "rate_limit_error" : "service_unavailable",
            code: status === 429 ? "rate_limit_exceeded" : "provider_error",
          },
        },
        status,
      );
    }

    return failureResponse(c, error);
  }
});

export default app;
