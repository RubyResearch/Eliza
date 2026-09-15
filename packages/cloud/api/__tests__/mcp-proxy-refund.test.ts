/**
 * Exercises MCP proxy standing, flat admission, dispatch ordering, and retained
 * settlement through the real Hono route with deterministic boundary mocks.
 *
 * Failures before upstream dispatch release admission; uncertain failures after
 * dispatch settle conservatively instead of fabricating a zero-cost call.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import * as creditsActual from "@/lib/services/credits";
import { __mcpProxyHopTestHooks } from "../mcp/proxy/[mcpId]/proxy-body-budget";

const requireGenerativeRouteCaller = mock();
const admitFlatGenerativeOperation = mock();
let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
let generativeCacheError: ApiError | null;
mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError: () => generativeCacheError,
  getGenerativeExecutionContext: () => executionCtx,
  requireGenerativeRouteCaller,
}));

const assertSafeOutboundUrl = mock();
mock.module("@/lib/security/outbound-url", () => ({ assertSafeOutboundUrl }));

const safeFetch = mock();
mock.module("@/lib/security/safe-fetch", () => ({ safeFetch }));

const getReferrer = mock();
mock.module("@/lib/services/affiliates", () => ({
  affiliatesService: { getReferrer },
}));

const containersGetById = mock();
mock.module("@/lib/services/containers", () => ({
  containersService: { getById: containersGetById },
}));

class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super("Insufficient credits");
  }
}
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  InsufficientCreditsError,
}));

const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const markProviderDispatched = mock(async () => undefined);

const getById = mock();
const recordUsageWithoutDeduction = mock(async () => {});
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    getById,
    recordUsageWithoutDeduction,
  },
}));

const loggerError = mock();
const loggerWarn = mock();
mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError, info: mock(), warn: loggerWarn, debug: mock() },
}));

const mcpRoute = (await import("../mcp/proxy/[mcpId]/route")).default;
const app = new Hono();
app.route("/:mcpId", mcpRoute);

function post(
  body = JSON.stringify({ method: "tools/call", params: { name: "t" } }),
) {
  return app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const EXTERNAL_MCP = {
  id: "test-mcp",
  name: "Test MCP",
  status: "live",
  credits_per_request: "5",
  endpoint_type: "external",
  external_endpoint: "https://mcp.example.test/rpc",
  organization_id: "org1",
};

beforeEach(() => {
  executionCtx = undefined;
  generativeCacheError = null;
  requireGenerativeRouteCaller.mockReset();
  requireGenerativeRouteCaller.mockResolvedValue({
    user: { id: "u1", organization_id: "org1" },
    apiKeyId: "key1",
    authSource: "combined_cache",
    admissionSnapshot: { standing: "active" },
    appScopeId: null,
  });
  settle.mockReset();
  settle.mockResolvedValue(null);
  settleUnknown.mockReset();
  settleUnknown.mockResolvedValue(null);
  markProviderDispatched.mockReset();
  markProviderDispatched.mockResolvedValue(undefined);
  admitFlatGenerativeOperation.mockReset();
  admitFlatGenerativeOperation.mockResolvedValue({
    settle,
    settleUnknown,
    markProviderDispatched,
    reservation: { reservationTransactionId: "reservation-1" },
  });
  getById.mockResolvedValue({ ...EXTERNAL_MCP });
  getReferrer.mockReset();
  getReferrer.mockResolvedValue(null);
  recordUsageWithoutDeduction.mockClear();
  assertSafeOutboundUrl.mockResolvedValue(
    new URL("https://mcp.example.test/rpc"),
  );
  safeFetch.mockReset();
  containersGetById.mockReset();
  loggerError.mockClear();
  loggerWarn.mockClear();
});

afterEach(() => {
  __mcpProxyHopTestHooks.resetHopTimeoutMs();
});

test("cached standing denial preserves its reason and skips admission", async () => {
  requireGenerativeRouteCaller.mockRejectedValue(
    new ApiError(403, "access_denied", "Organization is inactive", {
      reason: "organization_inactive",
    }),
  );

  const res = await post();
  const body = (await res.json()) as {
    details?: { reason?: string };
  };

  expect(res.status).toBe(403);
  expect(body.details?.reason).toBe("organization_inactive");
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(loggerWarn).toHaveBeenCalledWith(
    "[MCP Proxy] Caller admission denied",
    expect.objectContaining({
      mcpId: "test-mcp",
      reason: "organization_inactive",
      errorName: "ApiError",
    }),
  );
});

test("admits before marking dispatch and marks immediately before fetch", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );

  const res = await post();

  expect(res.status).toBe(200);
  expect(requireGenerativeRouteCaller.mock.invocationCallOrder[0]).toBeLessThan(
    assertSafeOutboundUrl.mock.invocationCallOrder[0],
  );
  expect(assertSafeOutboundUrl.mock.invocationCallOrder[0]).toBeLessThan(
    admitFlatGenerativeOperation.mock.invocationCallOrder[0],
  );
  expect(admitFlatGenerativeOperation.mock.invocationCallOrder[0]).toBeLessThan(
    markProviderDispatched.mock.invocationCallOrder[0],
  );
  expect(
    admitFlatGenerativeOperation.mock.calls[0]?.[0].atomicProviderBoundary,
  ).toBe(true);
  expect(markProviderDispatched.mock.invocationCallOrder[0]).toBeLessThan(
    safeFetch.mock.invocationCallOrder[0],
  );
});

test("a late balance denial refunds without reaching or blaming the MCP", async () => {
  markProviderDispatched.mockRejectedValueOnce(
    new InsufficientCreditsError(0.05, 0.01),
  );

  const res = await post();

  expect(res.status).toBe(402);
  expect(settle).toHaveBeenCalledWith(0);
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(loggerError).toHaveBeenCalledWith(
    "[MCP Proxy] Provider dispatch admission denied",
    expect.objectContaining({ phase: "provider_dispatch" }),
  );
});

test("a late cache denial remains a retryable admission failure", async () => {
  generativeCacheError = new ApiError(
    503,
    "service_unavailable",
    "Generative admission cache is warming; retry shortly",
    { retryable: true, retryAfterSeconds: 1 },
  );
  markProviderDispatched.mockRejectedValueOnce(
    new Error("dispatch admission unavailable"),
  );

  const res = await post();

  expect(res.status).toBe(503);
  expect(settle).toHaveBeenCalledWith(0);
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(loggerError).toHaveBeenCalledWith(
    "[MCP Proxy] Provider dispatch admission failed",
    expect.objectContaining({ phase: "provider_dispatch" }),
  );
});

test("retains successful settlement and usage under waitUntil", async () => {
  const retained: Promise<unknown>[] = [];
  const waitUntil = mock((promise: Promise<unknown>) => {
    retained.push(promise);
  });
  executionCtx = { waitUntil };
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );

  const res = await post();

  expect(res.status).toBe(200);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  await Promise.all(retained);
  expect(settle).toHaveBeenCalledWith(0.05);
  expect(recordUsageWithoutDeduction).toHaveBeenCalledTimes(1);
});

test("unreachable upstream settles unknown after dispatch", async () => {
  safeFetch.mockRejectedValue(new Error("ECONNREFUSED"));
  const res = await post();
  expect(res.status).toBe(502);
  expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
  expect(markProviderDispatched).toHaveBeenCalledTimes(1);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
});

test("non-owner org CANNOT invoke another org's PRIVATE MCP — 404, no billing (#11838)", async () => {
  // user is org1 (beforeEach); the MCP is private and owned by org2.
  getById.mockResolvedValue({
    ...EXTERNAL_MCP,
    is_public: false,
    organization_id: "org2",
  });
  const res = await post();
  expect(res.status).toBe(404);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
});

test("non-owner org CAN invoke a PUBLIC MCP — monetization model preserved (#11838)", async () => {
  getById.mockResolvedValue({
    ...EXTERNAL_MCP,
    is_public: true,
    organization_id: "org2",
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
});

test("unsafe/blocked external endpoint is rejected before admission", async () => {
  assertSafeOutboundUrl.mockRejectedValue(new Error("SSRF blocked"));
  const res = await post();
  expect(res.status).toBe(400);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(markProviderDispatched).not.toHaveBeenCalled();
});

test("container-unavailable is rejected before admission", async () => {
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockResolvedValue(null); // no load_balancer_url
  const res = await post();
  expect(res.status).toBe(503);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("container lookup failure is rejected before admission", async () => {
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockRejectedValue(new Error("container DB down"));
  const res = await post();
  expect(res.status).toBe(502);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("invalid JSON body is rejected before admission", async () => {
  const res = await post("{not json");
  expect(res.status).toBe(400);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("oversized request body returns 413 before admission and skips upstream", async () => {
  const res = await post(`{"payload":"${"x".repeat(1_000_001)}"}`);
  expect(res.status).toBe(413);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("non-ok upstream status settles unknown after dispatch", async () => {
  safeFetch.mockResolvedValue(new Response("upstream error", { status: 500 }));
  const res = await post();
  expect(res.status).toBe(500);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
});

test("upstream response body read failure refunds before usage is recorded", async () => {
  safeFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => {
      throw new Error("body stream failed");
    },
  } as unknown as Response);
  const res = await post();
  expect(res.status).toBe(502);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("declared oversized upstream body returns 502 and refunds exact receipt", async () => {
  safeFetch.mockResolvedValue(
    new Response("not read", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "5000001",
      },
    }),
  );
  const res = await post();
  expect(res.status).toBe(502);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("headers-resolve body-never-resolves returns 504, refunds exact receipt, and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  safeFetch.mockImplementation((_url: string, init?: RequestInit) => {
    void init;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const res = await post();
  expect(res.status).toBe(504);
  const timedOut = (await res.json()) as { error: string };
  expect(timedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("streamed oversized upstream body returns 502 and refunds exact receipt", async () => {
  const first = new Uint8Array(5_000_000);
  const overflow = new Uint8Array(2);
  first.fill(97);
  overflow.fill(98);
  safeFetch.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(overflow);
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  const res = await post();
  expect(res.status).toBe(502);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("container hop headers-resolve body-never-resolves returns 504 and refunds", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockResolvedValue({
    load_balancer_url: "http://container.internal",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const res = await post();
    expect(res.status).toBe(504);
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("headers-never-resolve fetch abort refunds exact receipt and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  safeFetch.mockImplementation((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  });
  const res = await post();
  expect(res.status).toBe(504);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("successful call settles exact cost and records usage", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(settle).toHaveBeenCalledWith(0.05);
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).toHaveBeenCalledTimes(1);
});

test("stalled endpoint prevalidation returns 504 before admission", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(20);
  assertSafeOutboundUrl.mockReturnValue(
    new Promise(() => {
      /* never settles — attacker-controlled DNS during prevalidation */
    }),
  );
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("prevalidation ignored hop deadline")),
      80,
    );
  });
  const res = await Promise.race([post(), hung]);
  expect(res.status).toBe(504);
  const prevalidationTimedOut = (await res.json()) as { error: string };
  expect(prevalidationTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("stalled pre-socket DNS in safeFetch returns 504, refunds exact receipt, and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(20);
  safeFetch.mockImplementation(() => {
    return new Promise(() => {
      /* never settles and ignores hop.signal — DNS lookup that never returns */
    });
  });
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("pre-socket DNS ignored hop deadline")),
      80,
    );
  });
  const res = await Promise.race([post(), hung]);
  expect(res.status).toBe(504);
  const dnsTimedOut = (await res.json()) as { error: string };
  expect(dnsTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("caller-aborted inbound JSON read returns 504 before admission", async () => {
  const caller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      /* never enqueue — inbound parse waits on the caller body */
    },
  });
  const pending = app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: caller.signal,
  });
  queueMicrotask(() => {
    caller.abort(new Error("caller canceled"));
  });
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("inbound JSON read ignored caller abort")),
      80,
    );
  });
  const res = await Promise.race([pending, hung]);
  expect(res.status).toBe(504);
  const inboundTimedOut = (await res.json()) as { error: string };
  expect(inboundTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("affiliate surcharge uses one exact debit, persisted receipt, and refund authority", async () => {
  getReferrer.mockResolvedValue({
    user_id: "affiliate-user",
    id: "affiliate-code",
    markup_percent: "10",
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const success = await post();
  expect(success.status).toBe(200);
  expect(admitFlatGenerativeOperation.mock.calls[0]?.[0].cost).toEqual({
    baseTotalCost: 0.05,
    platformMarkup: 0.015,
    totalCost: 0.065,
  });
  expect(recordUsageWithoutDeduction).toHaveBeenCalledWith(
    expect.objectContaining({
      creditsCharged: 5,
      affiliateFeeCredits: 0.5,
      platformFeeCredits: 1,
      chargeReceipt: {
        creditUnit: "USD",
        baseAmountUsd: 0.05,
        affiliateFeeUsd: 0.005,
        platformFeeUsd: 0.01,
        totalAmountUsd: 0.065,
        feeComponentsKnown: true,
      },
    }),
  );

  safeFetch.mockRejectedValue(new Error("offline"));
  const failure = await post();
  expect(failure.status).toBe(502);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
});

test("malformed UTF-8 request body returns 400 before admission (#24768)", async () => {
  const malformed = new Uint8Array([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  const res = await app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: malformed as unknown as string,
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toEqual({
    error: "MCP request body is not valid UTF-8",
  });
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("malformed UTF-8 upstream response returns 502, refunds exact receipt, and skips usage (#24768)", async () => {
  const malformed = new Uint8Array([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(malformed);
      controller.close();
    },
  });
  safeFetch.mockResolvedValue(
    new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const res = await post();
  expect(res.status).toBe(502);
  expect((await res.json()) as { error: string }).toEqual({
    error: "MCP response is not valid UTF-8",
  });
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});
