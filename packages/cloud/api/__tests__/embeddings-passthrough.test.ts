/**
 * Tests for the /api/v1/embeddings pass-through fast path (#15512): with
 * INFERENCE_PASSTHROUGH_EMBEDDINGS on and a direct-OpenAI source, the route
 * forwards the request verbatim over a mocked global `fetch` and returns the
 * upstream bytes untouched, while billing/settle runs identically to the SDK
 * path. Auth/rate-limit/billing are mocked at the module boundary; the flag,
 * the qualification gates, the error mapping, and the hold-release paths run
 * for real.
 */

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { Context } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would strand later test
// files that import from these modules. afterAll restores them.
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as admissionActual from "@/lib/services/organization-inference-admission";
import * as usageActual from "@/lib/services/usage";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import type { AppEnv } from "@/types/cloud-worker-env";

type AppCtx = Context<AppEnv>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

const UPSTREAM_URL = "https://api.openai.com/v1/embeddings";
const UPSTREAM_KEY = "sk-upstream-test";

// --- module mocks (same boundaries as the sibling embeddings suites) --------
const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const enforceOrgRateLimit = mock();
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

// Source selection is controlled per-test; the resolver stays REAL so the
// flag/source/key qualification logic is what's under test.
let providerSource: "openai" | "gateway" | null = "openai";
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => providerSource,
}));

const reserveCredits = mock();
const markProviderDispatched = mock();
const billUsage = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
  billUsage,
}));

mock.module("@/lib/services/organization-inference-admission", () => ({
  ...admissionActual,
  admitOrganizationInference: async (params: {
    context: Record<string, unknown>;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    affiliateCode?: string | null;
  }) => {
    const reservation = await reserveCredits(
      { ...params.context, affiliateCode: params.affiliateCode ?? undefined },
      params.estimatedInputTokens,
      params.estimatedOutputTokens,
    );
    const settle = createCreditReservationSettler(reservation);
    return {
      mode: "synchronous_reservation",
      settle,
      settleUnknown: () => settle(reservation.reservedAmount),
      markProviderDispatched,
    };
  },
}));

const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: { ...usageActual.usageService, create: usageCreate },
}));

// The SDK embedder — must never be reached on the pass-through path.
const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...(require("ai") as object),
  embed,
  embedMany,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const embeddingsRoute = (await import("../v1/embeddings/route")).default;

// --- global fetch mock (the direct upstream boundary) ------------------------
const realFetch = globalThis.fetch;
let fetchImpl:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;
const fetchMock = mock(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!fetchImpl) throw new Error("fetchImpl not set");
    return fetchImpl(input, init);
  },
);

const ENV_KEYS = [
  "INFERENCE_PASSTHROUGH_EMBEDDINGS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/organization-inference-admission",
    () => admissionActual,
  );
  mock.module("@/lib/services/usage", () => usageActual);
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Collects the promises scheduled via executionCtx.waitUntil. */
function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

function post(body: unknown, ctx?: ExecutionContext) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
        "X-Eliza-Trace-Id": TRACE_ID,
      },
      body: JSON.stringify(body),
    },
    {},
    ctx,
  );
}

/** Tracks the credit hold: reconcile(0) = released, reconcile(cost) = settled. */
function armReservation() {
  const reconcileCosts: number[] = [];
  reserveCredits.mockResolvedValue({
    reservedAmount: 0.01,
    reconcile: async (actualCost: number) => {
      reconcileCosts.push(actualCost);
      return undefined;
    },
  });
  return reconcileCosts;
}

const UPSTREAM_BODY = {
  object: "list",
  data: [{ object: "embedding", embedding: [0.25, -0.5, 1], index: 0 }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 7, total_tokens: 7 },
};

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  resolveInferenceAuthContext.mockReset();
  enforceOrgRateLimit.mockReset();
  reserveCredits.mockReset();
  markProviderDispatched.mockReset();
  markProviderDispatched.mockResolvedValue(undefined);
  billUsage.mockReset();
  usageCreate.mockReset();
  embed.mockReset();
  embedMany.mockReset();
  fetchMock.mockClear();
  fetchImpl = null;
  providerSource = "openai";
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.INFERENCE_PASSTHROUGH_EMBEDDINGS = "true";
  process.env.OPENAI_API_KEY = UPSTREAM_KEY;
  delete process.env.OPENAI_BASE_URL;

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", API_KEY_ID);
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    source: "cache",
    ctx: {
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
    },
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  billUsage.mockResolvedValue({
    inputCost: 0.001,
    outputCost: 0,
    totalCost: 0.001,
    baseInputCost: 0.001,
    baseOutputCost: 0,
    baseTotalCost: 0.001,
    platformMarkup: 0,
    inputTokens: 7,
    outputTokens: 0,
    totalTokens: 7,
    markupApplied: true,
  });
  usageCreate.mockResolvedValue({ id: "usage-1" });
});

describe("embeddings pass-through (#15512)", () => {
  test.each(["passthrough", "sdk-single", "sdk-batch"] as const)(
    "%s reports admission timing without including the provider wait",
    async (path) => {
      let clock = 0;
      const timer = spyOn(performance, "now").mockImplementation(() => clock);
      const { ctx, scheduled } = makeExecutionCtx();
      try {
        process.env.INFERENCE_PASSTHROUGH_EMBEDDINGS =
          path === "passthrough" ? "true" : "false";
        resolveInferenceAuthContext.mockImplementation(
          async (
            _request: Request,
            options: inferenceAuthActual.ResolveInferenceAuthOptions,
          ) => {
            clock += 11;
            options.onTelemetry?.({
              v: 1,
              traceId: TRACE_ID,
              authSource: "bearer_api_key",
              controlledProbe: "off",
              cacheAvailability: "available",
              cacheBackend: "redis_rest",
              cacheRead: "hit",
              authoritative: "not_run",
              cacheWrite: "not_run",
              result: "authorized_cache",
              timings: {
                extractMs: 1,
                cacheAvailabilityMs: 0,
                cacheReadMs: 10,
                keyLookupMs: null,
                userOrgLookupMs: null,
                moderationMs: null,
                cacheWriteMs: null,
                totalMs: 11,
              },
            });
            return {
              kind: "authorized",
              source: "cache",
              ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
            };
          },
        );
        enforceOrgRateLimit.mockImplementation(async () => {
          clock += 13;
          return null;
        });
        reserveCredits.mockImplementation(async () => {
          clock += 17;
          return { reservedAmount: 0.01, reconcile: async () => undefined };
        });
        markProviderDispatched.mockImplementation(async () => {
          clock += 7;
        });
        fetchImpl = async () => {
          clock += 1_000;
          return new Response(JSON.stringify(UPSTREAM_BODY));
        };
        embed.mockImplementation(async () => {
          clock += 1_000;
          return { embedding: [0.25, -0.5, 1], usage: { tokens: 7 } };
        });
        embedMany.mockImplementation(async () => {
          clock += 1_000;
          return { embeddings: [[0.25, -0.5, 1]], usage: { tokens: 7 } };
        });

        const res = await post(
          {
            model: "text-embedding-3-small",
            input: path === "sdk-batch" ? ["hello"] : "hello",
          },
          ctx,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("X-Eliza-Preforward-Ms")).toBe(
          "total=48;auth=11;mid=13;reserve=17;setup=7",
        );
        expect(res.headers.get("Server-Timing")).toContain(
          "gateway_preforward;dur=48",
        );
        expect(res.headers.get("X-Eliza-Trace-Id")).toBe(TRACE_ID);
        expect(res.headers.get("X-Eliza-Auth-Trace")).toContain(
          "backend=redis_rest;read=hit;authoritative=not_run",
        );
        expect(res.headers.get("Server-Timing")).toContain(
          "auth_cache_read;dur=10",
        );
        expect(await res.json()).toMatchObject({
          data: [{ embedding: [0.25, -0.5, 1] }],
        });
        expect(markProviderDispatched).toHaveBeenCalledTimes(1);
        expect(
          fetchMock.mock.calls.length +
            embed.mock.calls.length +
            embedMany.mock.calls.length,
        ).toBe(1);
        await Promise.all(scheduled);
        expect(billUsage).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all(scheduled);
        timer.mockRestore();
      }
    },
  );

  test("flag on + openai source: upstream bytes returned verbatim, SDK never called, usage billed from upstream", async () => {
    armReservation();
    let upstreamInit: RequestInit | undefined;
    let upstreamInput: RequestInfo | URL | undefined;
    fetchImpl = async (input, init) => {
      upstreamInput = input;
      upstreamInit = init;
      return new Response(JSON.stringify(UPSTREAM_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hello world" },
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Eliza-Inference-Path")).toBe("passthrough");
    // Byte-for-byte: the client sees exactly what the provider sent.
    expect(await res.text()).toBe(JSON.stringify(UPSTREAM_BODY));

    expect(String(upstreamInput)).toBe(UPSTREAM_URL);
    const headers = new Headers(upstreamInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    const forwarded = JSON.parse(String(upstreamInit?.body));
    expect(forwarded.model).toBe("text-embedding-3-small");
    expect(forwarded.input).toBe("hello world");

    expect(embed).not.toHaveBeenCalled();
    expect(embedMany).not.toHaveBeenCalled();

    // Billing is scheduled (waitUntil), not awaited — and bills the upstream's
    // reported prompt_tokens, not the local estimate.
    await Promise.all(scheduled);
    expect(billUsage).toHaveBeenCalledTimes(1);
    const usageArg = billUsage.mock.calls[0]?.[1] as {
      inputTokens: number;
    };
    expect(usageArg.inputTokens).toBe(7);
  });

  test("flag off: SDK path runs, upstream fetch never fires", async () => {
    process.env.INFERENCE_PASSTHROUGH_EMBEDDINGS = "false";
    armReservation();
    embed.mockResolvedValue({ embedding: [1, 2, 3], usage: { tokens: 3 } });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hello" },
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Eliza-Inference-Path")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    await Promise.all(scheduled);
  });

  test("gateway source: stays on the SDK path even with the flag on", async () => {
    providerSource = "gateway";
    armReservation();
    embed.mockResolvedValue({ embedding: [1], usage: { tokens: 1 } });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    await Promise.all(scheduled);
  });

  test("upstream 429 maps to 429 and releases the credit hold", async () => {
    const reconcileCosts = armReservation();
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      });

    const { ctx } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hello" },
      ctx,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    // The hold was released (reconcile(0)), never settled at cost.
    expect(reconcileCosts).toEqual([0]);
    expect(billUsage).not.toHaveBeenCalled();
  });

  test("upstream 500 maps to 503 and retains the conservative estimate", async () => {
    const reconcileCosts = armReservation();
    fetchImpl = async () => new Response("upstream boom", { status: 500 });

    const { ctx } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hello" },
      ctx,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("provider_error");
    // A server error after dispatch does not prove the provider did zero work.
    expect(reconcileCosts).toEqual([0.01]);
  });

  test("upstream body without usage bills the local estimate instead of zero", async () => {
    armReservation();
    const noUsage = { ...UPSTREAM_BODY, usage: undefined };
    fetchImpl = async () =>
      new Response(JSON.stringify(noUsage), { status: 200 });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "four words of input" },
      ctx,
    );

    expect(res.status).toBe(200);
    await Promise.all(scheduled);
    const usageArg = billUsage.mock.calls[0]?.[1] as { inputTokens: number };
    expect(usageArg.inputTokens).toBeGreaterThan(0);
  });

  test("OPENAI_BASE_URL override routes the pass-through to the custom upstream", async () => {
    process.env.OPENAI_BASE_URL = "https://proxy.example.com/v1/";
    armReservation();
    let upstreamInput: RequestInfo | URL | undefined;
    fetchImpl = async (input) => {
      upstreamInput = input;
      return new Response(JSON.stringify(UPSTREAM_BODY), { status: 200 });
    };

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hello" },
      ctx,
    );

    expect(res.status).toBe(200);
    expect(String(upstreamInput)).toBe(
      "https://proxy.example.com/v1/embeddings",
    );
    await Promise.all(scheduled);
  });
});
