/** Exercise the real AI SDK serialization. Only the HTTP response is a fixture;
 * no request may leave the test. Live cache/latency acceptance is separate. */
import { AgentRuntime, type GenerateTextParams, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildProviderCachePlan } from "../../../packages/core/src/runtime/provider-cache-plan";
import { handleTextSmall } from "../models/text";

afterEach(() => vi.restoreAllMocks());

async function captureRequest(
  cerebras: boolean,
  providerOptions: NonNullable<GenerateTextParams["providerOptions"]>
) {
  const hostname = cerebras ? "api.cerebras.ai" : "openai-cache-fixture.invalid";
  const base = `https://${hostname}/v1`;
  const runtime = new AgentRuntime({
    character: { name: "Cache routing fixture", bio: "test", settings: {} },
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
    settings: {
      ELIZA_PROVIDER: cerebras ? "cerebras" : "openai",
      OPENAI_BASE_URL: base,
      CEREBRAS_BASE_URL: base,
      OPENAI_API_KEY: "cache-routing-test-key",
      CEREBRAS_API_KEY: "",
      OPENAI_SMALL_MODEL: "qwen-3.8-27b",
      OPENAI_REASONING_EFFORT: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_FALLBACK_MODEL: "",
    },
  });
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    );
    expect(url.hostname).toBe(hostname);
    expect(url.pathname).toBe("/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return Response.json({
      id: "cache-routing-fixture",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    });
  });
  try {
    await handleTextSmall(runtime, {
      prompt: "Preserve this entire request: café 🧭 END.",
      system: "Reply briefly. Do not perform actions.",
      providerOptions,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages).toEqual([
      { role: "system", content: "Reply briefly. Do not perform actions." },
      { role: "user", content: "Preserve this entire request: café 🧭 END." },
    ]);
    return bodies[0];
  } finally {
    fetch.mockRestore();
  }
}

it("sends stable conversation-scoped Cerebras keys through the OpenAI SDK", async () => {
  const requests = [];
  for (const conversationId of ["room-one", "room-one", "room-two"]) {
    const plan = buildProviderCachePlan({ prefixHash: "shared-prefix", conversationId });
    const body = await captureRequest(true, plan.providerOptions);
    expect(body.prompt_cache_key).toBe(
      (plan.providerOptions.cerebras as { promptCacheKey: string }).promptCacheKey
    );
    expect(body).not.toHaveProperty("prompt_cache_retention");
    requests.push(body);
  }
  expect(requests[0].prompt_cache_key).toBe(requests[1].prompt_cache_key);
  expect(requests[0].prompt_cache_key).not.toBe(requests[2].prompt_cache_key);
  const withoutKey = ({ prompt_cache_key: _key, ...body }: Record<string, unknown>) => body;
  expect(withoutKey(requests[0])).toEqual(withoutKey(requests[2]));
});

it.each([
  { cerebras: true, options: { promptCacheKey: "cerebras-camel" }, expected: "cerebras-camel" },
  { cerebras: true, options: { prompt_cache_key: "cerebras-snake" }, expected: "cerebras-snake" },
  { cerebras: true, options: {}, expected: undefined },
  { cerebras: false, options: { promptCacheKey: "cerebras-only" }, expected: "openai-legacy" },
])(
  "preserves provider-specific cache precedence ($expected)",
  async ({ cerebras, options, expected }) => {
    const body = await captureRequest(cerebras, {
      openai: { promptCacheKey: "openai-legacy", promptCacheRetention: "24h" },
      cerebras: options,
    });
    expect(body.prompt_cache_key).toBe(expected);
    if (cerebras) expect(body).not.toHaveProperty("prompt_cache_retention");
    else expect(body.prompt_cache_retention).toBe("24h");
  }
);

it("does not invent a routing hint when the caller supplies no key", async () => {
  expect(await captureRequest(true, {})).not.toHaveProperty("prompt_cache_key");
});
