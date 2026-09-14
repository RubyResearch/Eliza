/**
 * Deterministic unit coverage for generative-route-auth. The module under
 * test is imported for real; collaborator services are stubbed so execution
 * context detection, cache-error mapping, flat admission, and caller
 * resolution can run without Worker KV or database.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class AiPricingCacheWarmingError extends Error {
  constructor() {
    super("AI pricing cache is warming; retry the request");
    this.name = "AiPricingCacheWarmingError";
  }
}

class AiPricingCacheUnavailableError extends Error {
  constructor() {
    super("AI pricing cache is unavailable; retry the request");
    this.name = "AiPricingCacheUnavailableError";
  }
}

class InferenceCredentialRevokedError extends Error {
  constructor(readonly reason: string) {
    super(`Inference credential rejected: ${reason}`);
    this.name = "InferenceCredentialRevokedError";
  }
}

function inferenceCredentialRevocationReason(reason: string) {
  return reason === "credential_revoked" ||
    reason === "session_revoked" ||
    reason === "session_binding_revoked"
    ? "credential_inactive"
    : reason;
}

const resolveInferenceAuthContext = vi.fn();
const requireAuthOrApiKeyWithOrg = vi.fn();
const requireUserOrApiKeyWithOrg = vi.fn();
const reserveFlatUsageCredits = vi.fn();
const admitOrganizationInference = vi.fn();
const enforceOrgRateLimit = vi.fn();
const inferenceRateLimitConfig = vi.fn();
const assertInferenceCredentialActive = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock("@/lib/api/cloud-worker-errors", () => ({ ApiError }));
vi.mock("@/lib/services/ai-pricing/cache", () => ({
  AiPricingCacheWarmingError,
  AiPricingCacheUnavailableError,
}));
vi.mock("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));
vi.mock("@/lib/services/inference-credential-revocation", () => ({
  assertInferenceCredentialActive,
  InferenceCredentialRevokedError,
  inferenceCredentialRevocationReason,
}));
vi.mock(
  "../../../shared/src/lib/services/inference-credential-revocation",
  () => ({
    assertInferenceCredentialActive,
    InferenceCredentialRevokedError,
    inferenceCredentialRevocationReason,
  }),
);
vi.mock("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
vi.mock("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
vi.mock("@/lib/services/ai-billing", () => ({ reserveFlatUsageCredits }));
vi.mock("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference,
}));
vi.mock("@/lib/middleware/rate-limit", () => ({ enforceOrgRateLimit }));
vi.mock("@/lib/services/inference-admission-snapshot", () => ({
  inferenceRateLimitConfig,
}));
vi.mock("@/lib/utils/logger", () => ({
  logger: { error: loggerError, warn: loggerWarn },
}));

if (typeof Bun !== "undefined") {
  const bunTest = await import("bun:test");
  bunTest.mock.module("@/lib/api/cloud-worker-errors", () => ({ ApiError }));
  bunTest.mock.module("@/lib/services/ai-pricing/cache", () => ({
    AiPricingCacheWarmingError,
    AiPricingCacheUnavailableError,
  }));
  bunTest.mock.module("@/lib/services/inference-auth-context", () => ({
    resolveInferenceAuthContext,
  }));
  bunTest.mock.module("@/lib/services/inference-credential-revocation", () => ({
    assertInferenceCredentialActive,
    InferenceCredentialRevokedError,
    inferenceCredentialRevocationReason,
  }));
  bunTest.mock.module(
    "../../../shared/src/lib/services/inference-credential-revocation",
    () => ({
      assertInferenceCredentialActive,
      InferenceCredentialRevokedError,
      inferenceCredentialRevocationReason,
    }),
  );
  bunTest.mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
  bunTest.mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg,
  }));
  bunTest.mock.module("@/lib/services/ai-billing", () => ({
    reserveFlatUsageCredits,
  }));
  bunTest.mock.module(
    "@/lib/services/organization-inference-admission",
    () => ({
      admitOrganizationInference,
    }),
  );
  bunTest.mock.module("@/lib/middleware/rate-limit", () => ({
    enforceOrgRateLimit,
  }));
  bunTest.mock.module("@/lib/services/inference-admission-snapshot", () => ({
    inferenceRateLimitConfig,
  }));
  bunTest.mock.module("@/lib/utils/logger", () => ({
    logger: { error: loggerError, warn: loggerWarn },
  }));
}

const {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  getGenerativeOperationContext,
  getGenerativePricingCacheOptions,
  requireGenerativeRouteCaller,
  resolveInferenceCredentialAdmissionDenial,
  resolveInferenceAuthStandingDenial,
} = await import("./generative-route-auth");
const { deferredCredentialAdmissionGuard } = await import(
  "../../../shared/src/lib/services/deferred-credential-admission-guard"
);

describe("deferredCredentialAdmissionGuard", () => {
  beforeEach(() => {
    assertInferenceCredentialActive.mockReset();
    assertInferenceCredentialActive.mockResolvedValue(undefined);
    loggerError.mockReset();
  });

  test("performs one standalone check when a route exits before admission", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    const guard = deferredCredentialAdmissionGuard({
      organizationId: () => "org-1",
      credential: () => credential,
    });

    await guard[Symbol.asyncDispose]();

    expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
    expect(assertInferenceCredentialActive).toHaveBeenCalledWith(
      "org-1",
      credential,
    );
  });

  test("leaves the exact credential for atomic admission without a standalone check", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    const guard = deferredCredentialAdmissionGuard({
      organizationId: () => "org-1",
      credential: () => credential,
    });

    expect(guard.credentialForAdmission()).toBe(credential);
    await guard[Symbol.asyncDispose]();

    expect(assertInferenceCredentialActive).not.toHaveBeenCalled();
  });

  test("maps an early-return disposal rejection to its safe standing denial", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    assertInferenceCredentialActive.mockRejectedValueOnce(
      new InferenceCredentialRevokedError("credential_revoked"),
    );

    let caught: unknown;
    try {
      await (async () => {
        await using _guard = deferredCredentialAdmissionGuard({
          organizationId: () => "org-1",
          credential: () => credential,
        });
        return "terminal-response-before-resource-or-provider-work";
      })();
    } catch (error) {
      // error-policy:J1 the test captures the route-boundary translation input.
      caught = error;
    }

    const mapped = asGenerativeCacheApiError(caught, {
      route: "terminal-test",
      traceId: "trace-terminal",
    });
    expect(mapped?.status).toBe(401);
    expect(mapped?.details).toEqual({ reason: "credential_inactive" });
    expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
  });

  test("unwraps a revocation the disposal failure displaced into `suppressed`", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };

    let caught: unknown;
    try {
      // The route body fails with the revocation first; disposal then throws
      // its own error because no organization was resolved. `SuppressedError`
      // keeps the NEWER disposal failure in `.error`, so the revocation is the
      // one that got displaced.
      await using _guard = deferredCredentialAdmissionGuard({
        organizationId: () => undefined,
        credential: () => credential,
      });
      throw new InferenceCredentialRevokedError("session_revoked");
    } catch (error) {
      // error-policy:J1 the test captures the route-boundary translation input.
      caught = error;
    }

    const suppressedError = caught as Error & {
      error?: unknown;
      suppressed?: unknown;
    };
    expect(suppressedError.name).toBe("SuppressedError");
    expect(suppressedError.error).not.toBeInstanceOf(
      InferenceCredentialRevokedError,
    );
    expect(suppressedError.suppressed).toBeInstanceOf(
      InferenceCredentialRevokedError,
    );

    // Without reading `.suppressed` this is null, and the route answers 500
    // instead of the credential contract.
    const denial = resolveInferenceCredentialAdmissionDenial(caught, {
      route: "displaced-revocation-test",
      traceId: "trace-displaced",
    });
    expect(denial?.status).toBe(401);
    expect(denial?.reason).toBe("credential_inactive");

    const mapped = asGenerativeCacheApiError(caught, {
      route: "displaced-revocation-test",
      traceId: "trace-displaced",
    });
    expect(mapped?.status).toBe(401);
    expect(mapped?.details).toEqual({ reason: "credential_inactive" });
    expect(loggerError).toHaveBeenCalledWith(
      "[InferenceAuth] deferred revocation suppressed an earlier route failure",
      {
        route: "displaced-revocation-test",
        traceId: "trace-displaced",
        credentialReason: "session_revoked",
        suppressedError: { name: "Error" },
      },
    );
  });

  test("unwraps disposal revocation when it suppresses a body failure without logging secrets", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    assertInferenceCredentialActive.mockRejectedValueOnce(
      new InferenceCredentialRevokedError("session_revoked"),
    );

    let caught: unknown;
    try {
      await using _guard = deferredCredentialAdmissionGuard({
        organizationId: () => "org-1",
        credential: () => credential,
      });
      throw new Error("secret-request-body bearer-private-value");
    } catch (error) {
      // error-policy:J1 the test captures the route-boundary translation input.
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("SuppressedError");
    const mapped = asGenerativeCacheApiError(caught, {
      route: "body-throw-test",
      traceId: "trace-suppressed",
    });
    expect(mapped?.status).toBe(401);
    expect(mapped?.details).toEqual({ reason: "credential_inactive" });
    expect(loggerError).toHaveBeenCalledWith(
      "[InferenceAuth] deferred revocation suppressed an earlier route failure",
      {
        route: "body-throw-test",
        traceId: "trace-suppressed",
        credentialReason: "session_revoked",
        suppressedError: { name: "Error" },
      },
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "secret-request-body",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "bearer-private-value",
    );
  });
});

const FLAT_COST = {
  totalCost: 1.25,
  baseTotalCost: 1,
  platformMarkup: 0.25,
};

function workerContext(storeSeed?: Record<string, unknown>) {
  const waited: Promise<unknown>[] = [];
  const store = new Map<string, unknown>(Object.entries(storeSeed ?? {}));
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      waited.push(promise);
    },
  };
  return {
    waited,
    store,
    executionCtx,
    c: {
      executionCtx,
      req: { raw: new Request("https://api.eliza.app/api/v1/generate-image") },
      get(key: string) {
        return store.get(key);
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
  };
}

function localContext(storeSeed?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(storeSeed ?? {}));
  return {
    store,
    c: {
      req: { raw: new Request("https://api.eliza.app/api/v1/generate-image") },
      get(key: string) {
        return store.get(key);
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
  };
}

function billingContext() {
  return {
    organizationId: "org-1",
    userId: "user-1",
    model: "gpt-4o",
    provider: "openai",
    billingSource: "openai" as const,
    requestId: "req-1",
  };
}

function namedError(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function admissionSnapshot() {
  return {
    authority: {
      generation: "0",
      source: "legacy" as const,
      sourceSubscriptionId: null,
      sourceRevision: null,
      projectionRevision: null,
      catalogVersion: null,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
    },
    subscriptionFunded: false,
    balance: {
      balanceUsd: 12,
      balanceAt: 1,
      balanceRevision: "1",
    },
    rateLimits: {
      completionsRpm: 10,
      embeddingsRpm: 10,
      standardRpm: 10,
      strictRpm: 10,
    },
  };
}

const sessionAuthorized = {
  kind: "authorized" as const,
  source: "cache" as const,
  ctx: {
    userId: "user-1",
    orgId: "org-1",
    apiKeyId: null,
    admission: admissionSnapshot(),
  },
};

const apiKeyAuthorized = {
  kind: "authorized" as const,
  source: "cache" as const,
  ctx: {
    userId: "user-1",
    orgId: "org-1",
    apiKeyId: "key-1",
    appScopeId: "app-1",
    admission: admissionSnapshot(),
  },
};

describe("getGenerativeExecutionContext", () => {
  test("returns the Worker context when waitUntil is a function", () => {
    const { c, executionCtx } = workerContext();
    expect(getGenerativeExecutionContext(c as never)).toBe(executionCtx);
  });

  test("returns undefined when executionCtx is missing", () => {
    expect(getGenerativeExecutionContext(localContext().c as never)).toBe(
      undefined,
    );
  });

  test("returns undefined when waitUntil is not a function", () => {
    expect(
      getGenerativeExecutionContext({
        executionCtx: { waitUntil: "later" },
      } as never),
    ).toBe(undefined);
  });

  test("returns undefined when executionCtx is null", () => {
    expect(getGenerativeExecutionContext({ executionCtx: null } as never)).toBe(
      undefined,
    );
  });

  test("returns undefined when reading executionCtx throws", () => {
    const c = {
      get executionCtx(): never {
        throw new Error("ExecutionContext is not available");
      },
    };
    expect(getGenerativeExecutionContext(c as never)).toBe(undefined);
  });
});

describe("getGenerativePricingCacheOptions", () => {
  test("sets cacheOnly when a Worker waitUntil context is present", () => {
    const { c, executionCtx } = workerContext();
    expect(getGenerativePricingCacheOptions(c as never)).toEqual({
      cacheOnly: true,
      executionCtx,
    });
  });

  test("sets cacheOnly false and omits executionCtx on the local path", () => {
    expect(getGenerativePricingCacheOptions(localContext().c as never)).toEqual(
      {
        cacheOnly: false,
        executionCtx: undefined,
      },
    );
  });

  test("does not treat a waitUntil-less object as cache-only", () => {
    expect(
      getGenerativePricingCacheOptions({
        executionCtx: { waitUntil: undefined },
      } as never),
    ).toEqual({
      cacheOnly: false,
      executionCtx: undefined,
    });
  });
});

describe("asGenerativeCacheApiError", () => {
  test("maps a fused credential refusal without losing the standing reason", () => {
    const error = new InferenceCredentialRevokedError("credential_revoked");
    const denial = resolveInferenceCredentialAdmissionDenial(error, {
      route: "generate-image",
      traceId: "trace-1",
    });
    const mapped = asGenerativeCacheApiError(error);

    expect(denial).toEqual({
      status: 401,
      type: "authentication_error",
      code: "authentication_required",
      message: "API key is inactive",
      reason: "credential_inactive",
    });
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.status).toBe(401);
    expect(mapped?.details).toEqual({ reason: "credential_inactive" });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[InferenceAuth] blocked provider dispatch at route boundary",
      expect.objectContaining({
        route: "generate-image",
        traceId: "trace-1",
        reason: "credential_inactive",
      }),
    );
  });

  test.each(["session_revoked", "session_binding_revoked"])(
    "maps Steward %s to the same 401 standing contract",
    (reason) => {
      const mapped = asGenerativeCacheApiError(
        new InferenceCredentialRevokedError(reason),
      );
      expect(mapped?.status).toBe(401);
      expect(mapped?.code).toBe("authentication_required");
      expect(mapped?.details).toEqual({ reason: "credential_inactive" });
    },
  );

  test("maps AiPricingCacheWarmingError to a retryable 503", () => {
    const mapped = asGenerativeCacheApiError(new AiPricingCacheWarmingError());
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
    expect(mapped?.message).toBe(
      "Generative admission cache is warming; retry shortly",
    );
    expect(mapped?.details).toEqual({
      retryable: true,
      retryAfterSeconds: 1,
    });
  });

  test("maps AiPricingCacheUnavailableError to the same retryable 503", () => {
    const mapped = asGenerativeCacheApiError(
      new AiPricingCacheUnavailableError(),
    );
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
  });

  test("maps Inference* Warming errors by name", () => {
    const mapped = asGenerativeCacheApiError(
      namedError("InferenceAuthCacheWarmingError"),
    );
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
  });

  test("maps Inference* Unavailable errors by name", () => {
    const mapped = asGenerativeCacheApiError(
      namedError("InferenceBalanceCacheUnavailableError"),
    );
    expect(mapped?.status).toBe(503);
  });

  test("returns null for Inference errors without Warming or Unavailable", () => {
    expect(
      asGenerativeCacheApiError(namedError("InferenceAuthCacheHitError")),
    ).toBe(null);
  });

  test("returns null when Warming is in the name but Inference is not the prefix", () => {
    expect(
      asGenerativeCacheApiError(namedError("AiPricingCacheWarmingErrorX")),
    ).toBe(null);
  });

  test("returns null for generic errors, strings, and non-errors", () => {
    expect(asGenerativeCacheApiError(new Error("nope"))).toBe(null);
    expect(asGenerativeCacheApiError("warming")).toBe(null);
    expect(asGenerativeCacheApiError(null)).toBe(null);
    expect(asGenerativeCacheApiError({ name: "InferenceWarmingError" })).toBe(
      null,
    );
  });
});

describe("admitFlatGenerativeOperation", () => {
  let reconcile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reconcile = vi.fn(async (actualCostUsd: number) => ({ actualCostUsd }));
    reserveFlatUsageCredits.mockReset();
    admitOrganizationInference.mockReset();
    reserveFlatUsageCredits.mockImplementation(async () => ({
      affiliateAttribution: { code: "aff-1" },
      reconcile,
    }));
  });

  afterEach(() => {
    reserveFlatUsageCredits.mockReset();
    admitOrganizationInference.mockReset();
  });

  test("rejects when provider is missing", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: {
          organizationId: "org-1",
          userId: "user-1",
          model: "gpt-4o",
          billingSource: "openai",
          requestId: "req-1",
        },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
    expect(reserveFlatUsageCredits).not.toHaveBeenCalled();
  });

  test("rejects when billingSource is an empty string", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: { ...billingContext(), billingSource: "" as never },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
  });

  test("rejects when requestId is missing", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: {
          organizationId: "org-1",
          userId: "user-1",
          model: "gpt-4o",
          provider: "openai",
          billingSource: "openai",
        },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
  });

  test("reserves synchronously when no Worker execution context is present", async () => {
    const context = billingContext();
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context,
      apiKeyId: "key-1",
      cost: FLAT_COST,
      idempotencyKey: "idem-1",
    });

    expect(reserveFlatUsageCredits).toHaveBeenCalledTimes(1);
    expect(reserveFlatUsageCredits).toHaveBeenCalledWith(context, FLAT_COST, {
      idempotencyKey: "idem-1",
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(admission.mode).toBe("synchronous_reservation");
    expect(admission.affiliateAttribution).toEqual({ code: "aff-1" });

    await expect(admission.settle(0.8)).resolves.toEqual({
      actualCostUsd: 0.8,
    });
    await expect(admission.settle(0.9)).resolves.toBe(null);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("passes undefined options when idempotencyKey is absent", async () => {
    await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    expect(reserveFlatUsageCredits.mock.calls[0]?.[2]).toBe(undefined);
  });

  test("treats an empty idempotencyKey as absent", async () => {
    await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
      idempotencyKey: "",
    });
    expect(reserveFlatUsageCredits.mock.calls[0]?.[2]).toBe(undefined);
  });

  test("settleUnknown conservatively uses the estimated totalCost", async () => {
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    await expect(admission.settleUnknown()).resolves.toEqual({
      actualCostUsd: FLAT_COST.totalCost,
    });
    expect(reconcile).toHaveBeenCalledWith(FLAT_COST.totalCost);
  });

  test("maps missing reservation affiliateAttribution to null", async () => {
    reserveFlatUsageCredits.mockImplementation(async () => ({
      reconcile,
    }));
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    expect(admission.affiliateAttribution).toBe(null);
  });

  test("maps an undefined reconcile result to null", async () => {
    reconcile.mockResolvedValueOnce(undefined);
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    await expect(admission.settle(1)).resolves.toBe(null);
  });

  test("admits through the Worker path when waitUntil is present", async () => {
    const { c, executionCtx } = workerContext();
    const snapshot = admissionSnapshot();
    const workerAdmission = {
      mode: "durable_object_debit" as const,
      settle: async () => null,
      settleUnknown: async () => null,
    };
    admitOrganizationInference.mockResolvedValueOnce(workerAdmission);

    const context = { ...billingContext(), affiliateCode: "ref-9" };
    const result = await admitFlatGenerativeOperation({
      c: c as never,
      context,
      apiKeyId: "key-1",
      cost: FLAT_COST,
      admissionSnapshot: snapshot,
      atomicProviderBoundary: true,
    });

    expect(result).toBe(workerAdmission);
    expect(reserveFlatUsageCredits).not.toHaveBeenCalled();
    expect(admitOrganizationInference).toHaveBeenCalledWith({
      context,
      apiKeyId: "key-1",
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      affiliateCode: "ref-9",
      executionCtx,
      flatCost: FLAT_COST,
      admissionSnapshot: snapshot,
      atomicProviderBoundary: true,
    });
  });

  test("keeps legacy Worker admission when the caller has no explicit provider boundary", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockResolvedValueOnce({
      mode: "durable_object_debit",
      settle: async () => null,
      settleUnknown: async () => null,
    });

    await admitFlatGenerativeOperation({
      c: c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
      admissionSnapshot: admissionSnapshot(),
    });

    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({ atomicProviderBoundary: false }),
    );
  });

  test("threads the exact deferred credential into Worker flat admission", async () => {
    const { c, executionCtx } = workerContext();
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    admitOrganizationInference.mockResolvedValueOnce({
      mode: "durable_object_debit",
      settle: async () => null,
      settleUnknown: async () => null,
    });

    await admitFlatGenerativeOperation({
      c: c as never,
      context: billingContext(),
      apiKeyId: "key-1",
      cost: FLAT_COST,
      admissionSnapshot: admissionSnapshot(),
      credential,
    });

    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({ executionCtx, credential }),
    );
  });

  test("wraps Inference Warming failures from Worker admission as 503", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce(
      namedError("InferenceAffiliateCacheWarmingError"),
    );
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Billing cache is warming; retry shortly",
    });
  });

  test("wraps Inference Unavailable failures from Worker admission as 503", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce(
      namedError("InferenceBalanceCacheUnavailableError"),
    );
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });

  test("rethrows AiPricingCacheWarmingError from Worker admission unchanged", async () => {
    const { c } = workerContext();
    const original = new AiPricingCacheWarmingError();
    admitOrganizationInference.mockRejectedValueOnce(original);
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toBe(original);
  });

  test("rethrows non-Error Worker admission failures unchanged", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce("boom");
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toBe("boom");
  });
});

describe("resolveInferenceAuthStandingDenial", () => {
  beforeEach(() => {
    loggerWarn.mockReset();
  });

  test("preserves a retryable resolver 503 and logs only bounded fields", () => {
    const denial = resolveInferenceAuthStandingDenial(
      { kind: "rejected", status: 503 },
      { route: "embeddings", traceId: "trace-1" },
    );

    expect(denial).toEqual({
      status: 503,
      type: "service_unavailable",
      code: "service_unavailable",
      message: "Authorization service is unavailable. Retry shortly.",
      reason: "authorization_unavailable",
      retryAfterSeconds: 1,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[InferenceAuth] blocked provider dispatch at route boundary",
      {
        route: "embeddings",
        traceId: "trace-1",
        decision: "rejected",
        status: 503,
        reason: "authorization_unavailable",
        retryable: true,
      },
    );
  });

  test("maps every typed standing reason without replacing resolver status", () => {
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "rejected",
        status: 403,
        reason: "organization_inactive",
      }),
    ).toMatchObject({
      status: 403,
      message: "Organization is inactive",
      reason: "organization_inactive",
    });
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "rejected",
        status: 401,
        reason: "credential_invalid",
      }),
    ).toMatchObject({
      status: 401,
      message: "Authentication required",
      reason: "credential_invalid",
    });
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "suspended",
        reason: "moderation_blocked",
      }),
    ).toMatchObject({
      status: 403,
      message: "Account access is blocked by policy moderation",
      reason: "moderation_blocked",
    });
  });
});

describe("requireGenerativeRouteCaller", () => {
  beforeEach(() => {
    resolveInferenceAuthContext.mockReset();
    requireAuthOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockReset();
    enforceOrgRateLimit.mockReset();
    inferenceRateLimitConfig.mockReset();
    assertInferenceCredentialActive.mockReset();
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-raw" },
    });
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    enforceOrgRateLimit.mockResolvedValue(null);
    inferenceRateLimitConfig.mockReturnValue({
      windowMs: 1000,
      maxRequests: 10,
    });
    assertInferenceCredentialActive.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resolveInferenceAuthContext.mockReset();
    requireAuthOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockReset();
    enforceOrgRateLimit.mockReset();
    inferenceRateLimitConfig.mockReset();
    assertInferenceCredentialActive.mockReset();
  });

  test("uses raw compatibility auth when no Worker context is present", async () => {
    const { c } = localContext();
    const caller = await requireGenerativeRouteCaller(c as never, {
      compatibility: "raw",
    });
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
    expect(caller).toEqual({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "key-raw",
      authSource: "compatibility",
      appScopeId: null,
    });
  });

  test("maps a missing raw api key to a null apiKeyId", async () => {
    requireAuthOrApiKeyWithOrg.mockResolvedValueOnce({
      user: { id: "user-1", organization_id: "org-1" },
    });
    const caller = await requireGenerativeRouteCaller(
      localContext().c as never,
      { compatibility: "raw" },
    );
    expect(caller.apiKeyId).toBe(null);
  });

  test("uses Hono compatibility auth by default without a Worker context", async () => {
    const { c } = localContext({ apiKeyId: "from-store" });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(caller.authSource).toBe("compatibility");
    expect(caller.apiKeyId).toBe("from-store");
    expect(caller.appScopeId).toBe(null);
  });

  test("maps a missing Hono apiKeyId store value to null", async () => {
    const caller = await requireGenerativeRouteCaller(
      localContext().c as never,
      { compatibility: "hono" },
    );
    expect(caller.apiKeyId).toBe(null);
  });

  test("returns combined_cache for an authorized session snapshot", async () => {
    const { c, store } = workerContext({
      traceId: "trace-1",
      requestId: "req-fallback",
    });
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);

    const caller = await requireGenerativeRouteCaller(c as never);

    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(c.req.raw, {
      traceId: "trace-1",
      cacheOnly: true,
      executionCtx: c.executionCtx,
    });
    expect(caller).toMatchObject({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: null,
      authSource: "combined_cache",
      appScopeId: null,
    });
    expect(caller.admissionSnapshot).toEqual(sessionAuthorized.ctx.admission);
    expect(store.get("user")).toEqual({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(store.get("authMethod")).toBe("session");
    expect(store.has("apiKeyId")).toBe(false);
  });

  test("falls back to requestId when traceId is unset", async () => {
    const { c } = workerContext({ requestId: "req-only" });
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);
    await requireGenerativeRouteCaller(c as never);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      traceId: "req-only",
    });
  });

  test("sets api_key auth and appScopeId from an authorized API-key snapshot", async () => {
    const { c, store } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(store.get("authMethod")).toBe("api_key");
    expect(store.get("apiKeyId")).toBe("key-1");
    expect(caller.apiKeyId).toBe("key-1");
    expect(caller.appScopeId).toBe("app-1");
  });

  test("defers only for a declared admission consumer and preserves the exact credential", async () => {
    const { c } = workerContext({ requestId: "req-fused" });
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    resolveInferenceAuthContext.mockResolvedValueOnce({
      ...apiKeyAuthorized,
      credential,
    });

    const caller = await requireGenerativeRouteCaller(c as never, {
      deferStrongCredentialCheck: true,
    });
    const operationContext = getGenerativeOperationContext(c as never, caller);

    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      deferStrongCredentialCheck: true,
    });
    expect(caller.credential).toBe(credential);
    expect(operationContext.credential).toBe(credential);
    expect(assertInferenceCredentialActive).not.toHaveBeenCalled();
  });

  test("keeps standalone validation when no admission consumer is declared", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);

    await requireGenerativeRouteCaller(c as never);

    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).not.toHaveProperty(
      "deferStrongCredentialCheck",
    );
  });

  test("returns null appScopeId when the field is absent from ctx", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "origin",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: "key-1",
      },
    });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(caller.appScopeId).toBe(null);
  });

  test("enforces the org rate limit and continues when the limiter returns null", async () => {
    const { c, executionCtx } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "strict",
    });
    expect(caller.authSource).toBe("combined_cache");
    expect(inferenceRateLimitConfig).toHaveBeenCalledWith(
      apiKeyAuthorized.ctx.admission,
      "strict",
    );
    expect(enforceOrgRateLimit).toHaveBeenCalledWith("org-1", "strict", {
      cacheOnly: true,
      executionCtx,
      config: { windowMs: 1000, maxRequests: 10 },
    });
  });

  test("uses the compatibility limiter path when admission is absent", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "cache",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
      },
    });
    await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "standard",
    });
    expect(enforceOrgRateLimit.mock.calls[0]?.[2]).toMatchObject({
      cacheOnly: false,
    });
  });

  test("throws rate_limit_exceeded when the limiter returns 429", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    enforceOrgRateLimit.mockResolvedValueOnce(
      new Response("slow down", { status: 429 }),
    );
    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      message: "Rate limit exceeded",
    });
  });

  test("consumes a deferred credential before returning a rate-limit failure", async () => {
    const { c } = workerContext();
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    resolveInferenceAuthContext.mockResolvedValueOnce({
      ...apiKeyAuthorized,
      credential,
    });
    enforceOrgRateLimit.mockResolvedValueOnce(
      new Response("slow down", { status: 429 }),
    );

    await expect(
      requireGenerativeRouteCaller(c as never, {
        rateLimitEndpoint: "strict",
        deferStrongCredentialCheck: true,
      }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
    expect(assertInferenceCredentialActive).toHaveBeenCalledWith(
      "org-1",
      credential,
    );
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("throws service_unavailable when the limiter returns a non-429 failure", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    enforceOrgRateLimit.mockResolvedValueOnce(
      new Response("limiter down", { status: 503 }),
    );
    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Rate limiter is unavailable",
    });
  });

  test("fails closed when warming has no one-shot continuation", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration: Promise.resolve(sessionAuthorized),
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Authorization cache is warming; retry shortly",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("does not await hydration when awaitWarmingMs is zero", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration: Promise.resolve(sessionAuthorized),
    });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: 0,
    });
  });

  test("fails fast when warming has no hydration promise even with a budget", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "warming" });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 1500 }),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("uses the inline origin result returned by the shared resolver", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "strict",
    });
    expect(caller.authSource).toBe("combined_cache");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).toHaveBeenCalledTimes(1);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: undefined,
    });
  });

  test("surfaces a definitive continuation denial before rate limit admission", async () => {
    const { c } = workerContext();
    const denial = {
      kind: "rejected" as const,
      status: 403 as const,
      reason: "organization_inactive" as const,
    };
    resolveInferenceAuthContext.mockResolvedValueOnce(denial);

    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
  });

  test("still 503s when the warming budget expires", async () => {
    const { c } = workerContext();
    let release: (() => void) | undefined;
    const hydration = new Promise((resolve) => {
      release = () => resolve(sessionAuthorized);
    });
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration,
      continuation: hydration,
    });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 20 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: 20,
    });
    release?.();
  });

  test("maps a suspended resolution to 403 access_denied", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "suspended" });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Account suspended",
    });
  });

  test("maps a 403 rejection to Forbidden", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Forbidden",
    });
  });

  test("maps a non-403 rejection to Authentication required", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 401,
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
      message: "Authentication required",
    });
  });

  test("returns the cached account-standing reason without another lookup", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
      reason: "organization_inactive",
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("explains an inactive cached API key without another lookup", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
      reason: "credential_inactive",
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "API key is inactive",
      details: { reason: "credential_inactive" },
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("falls through slow_path to raw compatibility auth", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "slow_path",
      reason: "non_api_key",
    });
    const caller = await requireGenerativeRouteCaller(c as never, {
      compatibility: "raw",
    });
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(caller.authSource).toBe("compatibility");
    expect(caller.apiKeyId).toBe("key-raw");
    expect(caller.appScopeId).toBe(null);
  });

  test("falls through slow_path to Hono compatibility auth by default", async () => {
    const { c } = workerContext({ apiKeyId: "compat-key" });
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "slow_path",
      reason: "mobile_api_key",
    });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(caller).toEqual({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "compat-key",
      authSource: "compatibility",
      appScopeId: null,
    });
  });
});
