/**
 * Exercises Cloud embedding initialization, strict dimension validation, and response integrity through a mocked API boundary.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the Cloud API client the embeddings handlers use. requestRaw is the
// single network seam, so we drive every success/failure path through it.
const requestRaw = vi.fn();
vi.mock("../../src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({ requestRaw }),
}));

// Embeddings must never emit usage on a failed batch; spy to assert that.
const emitModelUsageEvent = vi.fn();
vi.mock("../../src/utils/events", () => ({ emitModelUsageEvent }));

const { handleTextEmbedding, handleBatchTextEmbedding, embeddingBackoffMs, EMBED_BACKOFF_CAP_MS } =
  await import("../../src/models/embeddings");

const DIM = 1536;

function makeRuntime(dimension: number | string = DIM): IAgentRuntime {
  return {
    getSetting: (key: string) => {
      if (key === "ELIZAOS_CLOUD_EMBEDDING_MODEL") return "text-embedding-3-small";
      if (key === "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS") return String(dimension);
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

function embeddingResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function vec(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === 0 ? seed : 0));
}

beforeEach(() => {
  requestRaw.mockReset();
  emitModelUsageEvent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTextEmbedding init + validation", () => {
  it("returns a correctly-sized init probe vector for null (legitimate init)", async () => {
    const result = await handleTextEmbedding(makeRuntime(), null);
    expect(result).toHaveLength(DIM);
    expect(result[0]).toBe(0.1);
    // Init must never touch the network.
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("rejects a prefix-parsed dimension instead of accepting its leading digits", async () => {
    // `Number.parseInt("1536junk")` is 1536, which then PASSES the allowlist
    // below — so the existing guard reported the truncated number and let a
    // malformed setting through as if it were valid.
    await expect(handleTextEmbedding(makeRuntime("1536junk"), null)).rejects.toThrow(
      /Invalid ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS/
    );
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("rejects a fractional dimension", async () => {
    await expect(handleTextEmbedding(makeRuntime("1536.9"), null)).rejects.toThrow(
      /Invalid ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS/
    );
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws a classified error with the operator's exact value", async () => {
    let thrown: unknown;
    try {
      await handleTextEmbedding(makeRuntime("1536junk"), null);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code: "ELIZA_CLOUD_EMBEDDING_DIMENSION_INVALID",
      context: {
        setting: "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS",
        value: "1536junk",
        allowedDimensions: [384, 512, 768, 1024, 1536, 3072],
      },
      severity: "fatal",
    });
    expect((thrown as Error).message).toContain("1536junk");
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("still accepts every allowlisted dimension", async () => {
    for (const dim of [384, 512, 768, 1024, 1536, 3072]) {
      const result = await handleTextEmbedding(makeRuntime(dim), null);
      expect(result).toHaveLength(dim);
    }
  });

  it("throws on malformed params instead of returning a marker vector", async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      handleTextEmbedding(makeRuntime(), { notText: "x" } as any)
    ).rejects.toThrow(/Invalid input format/);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws on empty text instead of returning a marker vector", async () => {
    await expect(handleTextEmbedding(makeRuntime(), "   ")).rejects.toThrow(/empty text/);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("returns the real embedding for valid text", async () => {
    const controller = new AbortController();
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.7)]));
    const result = await handleTextEmbedding(makeRuntime(), {
      text: "hello world",
      signal: controller.signal,
    });
    expect(result).toEqual(vec(0.7));
    expect(requestRaw).toHaveBeenCalledWith(
      "POST",
      "/embeddings",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("handleBatchTextEmbedding no-marker-on-failure", () => {
  it("returns [] for an empty input array (not a marker)", async () => {
    const result = await handleBatchTextEmbedding(makeRuntime(), []);
    expect(result).toEqual([]);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("throws (no marker vectors) when a text is empty", async () => {
    await expect(handleBatchTextEmbedding(makeRuntime(), ["ok", ""])).rejects.toThrow(
      /empty text at index 1/
    );
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("returns real vectors for a successful batch and emits usage", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.1), vec(0.2)]));
    const result = await handleBatchTextEmbedding(makeRuntime(), ["a", "b"]);
    expect(result).toEqual([vec(0.1), vec(0.2)]);
    expect(emitModelUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("throws on a 401 auth failure (no marker vectors, no usage)", async () => {
    requestRaw.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /Authentication failed/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on a generic non-auth API error instead of writing markers", async () => {
    requestRaw.mockResolvedValueOnce(
      new Response("boom", { status: 500, statusText: "Server Error" })
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/API error: 500/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on an invalid response structure instead of writing markers", async () => {
    requestRaw.mockResolvedValueOnce(
      new Response(JSON.stringify({ not: "data" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /invalid response structure/
    );
  });

  it("throws on a transport error instead of writing markers", async () => {
    requestRaw.mockRejectedValueOnce(new Error("network down"));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(/network down/);
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  // Backoff is driven through vitest fake timers so the ~1s exponential sleep
  // (with Math.random jitter) never burns real wall-clock and can't flake.
  it("retries once after a 429 and returns real vectors on retry success", async () => {
    vi.useFakeTimers();
    try {
      requestRaw
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        )
        .mockResolvedValueOnce(embeddingResponse([vec(0.9)]));
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual([vec(0.9)]);
      expect(requestRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws (no markers) when the post-429 retry also fails", async () => {
    vi.useFakeTimers();
    try {
      requestRaw
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        )
        .mockResolvedValueOnce(
          new Response("still bad", { status: 503, statusText: "Unavailable" })
        );
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      // Attach the rejection assertion before flushing timers so the rejection
      // is observed (no unhandled-rejection warning) once the retry resolves.
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(emitModelUsageEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleBatchTextEmbedding cold-gateway warming retry (#18103)", () => {
  // The structural warming 503 body the gateway emits while auth/billing
  // caches hydrate (#17875's shape) — the class that dropped one-shot seeds.
  function warmingResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          message: "Authorization cache is warming. Retry shortly.",
          type: "service_unavailable",
          code: "auth_cache_warming",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  it("retries through the warming window and returns real vectors (seed survives a cold cache)", async () => {
    vi.useFakeTimers();
    try {
      // Three warming 503s exceed the ordinary 2-attempt transient budget —
      // proving the warming schedule is its own budget — then success.
      requestRaw
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(warmingResponse())
        .mockResolvedValueOnce(embeddingResponse([vec(0.7)]));
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual([vec(0.7)]);
      expect(requestRaw).toHaveBeenCalledTimes(4);
      expect(emitModelUsageEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails closed when the gateway keeps warming past the bounded budget", async () => {
    vi.useFakeTimers();
    try {
      // Warming budget (4 retries) + transient budget (1 retry) all warming →
      // terminal 503 throw, never a marker vector.
      requestRaw.mockImplementation(async () => warmingResponse());
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      // 1 initial + 4 warming retries + 1 transient retry = 6 total attempts.
      expect(requestRaw).toHaveBeenCalledTimes(6);
      expect(emitModelUsageEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a NON-warming 503 on the small transient budget (dead gateway fails promptly)", async () => {
    vi.useFakeTimers();
    try {
      const dead = () =>
        new Response(JSON.stringify({ error: { code: "upstream_error" } }), {
          status: 503,
          statusText: "Unavailable",
          headers: { "Content-Type": "application/json" },
        });
      requestRaw.mockImplementation(async () => dead());
      const promise = handleBatchTextEmbedding(makeRuntime(), ["a"]);
      const assertion = expect(promise).rejects.toThrow(/API error: 503/);
      await vi.runAllTimersAsync();
      await assertion;
      // No warming budget consumed: 1 initial + 1 transient retry only.
      expect(requestRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("embeddingBackoffMs cap + escalation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clamps even a large server retry-after to the cap (no jitter)", () => {
    // Math.random()→0 removes the ±25% jitter so the value is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    // retry-after 600s would be 600_000ms uncapped — the cap is what stops a
    // hostile/large hint from parking the embedding queue.
    expect(embeddingBackoffMs(0, 600)).toBe(EMBED_BACKOFF_CAP_MS);
    expect(embeddingBackoffMs(0, 600)).toBeLessThan(600_000);
  });

  it("escalates exponentially from the base, capped at EMBED_BACKOFF_CAP_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(embeddingBackoffMs(0)).toBe(1_000);
    expect(embeddingBackoffMs(2)).toBe(4_000);
    // 1000·2^5 = 32_000 → clamped to the 8_000 cap.
    expect(embeddingBackoffMs(5)).toBe(EMBED_BACKOFF_CAP_MS);
  });

  it("adds bounded (≤25%) jitter on top of the base", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // base 1000 · (1 + 1·0.25) = 1250
    expect(embeddingBackoffMs(0)).toBe(1_250);
  });
});

describe("handleBatchTextEmbedding dimension + count integrity (#8769)", () => {
  it("sends the configured `dimensions` in the POST body so the gateway pins width", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.4)]));
    // 384-configured agent; the response width won't match so the call rejects —
    // we only care that the request carried `dimensions: 384`.
    await handleBatchTextEmbedding(makeRuntime(384), ["a"]).catch(() => undefined);
    const [method, path, opts] = requestRaw.mock.calls[0] as [
      string,
      string,
      { json?: { dimensions?: number; model?: string; input?: string[] } },
    ];
    expect(method).toBe("POST");
    expect(path).toBe("/embeddings");
    expect(opts.json?.dimensions).toBe(384);
  });

  it("throws on a width mismatch (server returns 1536 for a 384-configured agent) and bills nothing", async () => {
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.5)])); // vec() is DIM(1536)-wide
    await expect(handleBatchTextEmbedding(makeRuntime(384), ["a"])).rejects.toThrow(
      /dimension mismatch: model returned 1536d but agent is configured for 384d/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on a count mismatch (fewer vectors than inputs) instead of returning undefined holes", async () => {
    // 2 inputs, server returns only 1 vector — the missing slot would be an
    // undefined hole that escapes to the runtime.
    requestRaw.mockResolvedValueOnce(embeddingResponse([vec(0.1)]));
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a", "b"])).rejects.toThrow(
      /expected 2 embeddings, got 1/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws on an out-of-range response index instead of crashing on undefined.originalIndex", async () => {
    // A malformed/cross-batch absolute index (5) for a single-item batch.
    requestRaw.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: vec(0.2), index: 5 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(handleBatchTextEmbedding(makeRuntime(), ["a"])).rejects.toThrow(
      /response index out of range/
    );
    expect(emitModelUsageEvent).not.toHaveBeenCalled();
  });
});
