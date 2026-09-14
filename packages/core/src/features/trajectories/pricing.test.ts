/**
 * Unit coverage for the trajectories cost/pricing table: asserts the static
 * per-provider rate card and context-window entries, the longest-family-key
 * substring fallback for versioned model ids, the local-provider zero-cost rule,
 * cache read/write accounting, and the MODEL_PRICES_JSON / MODEL_CONTEXT_WINDOWS_JSON
 * env overrides. Fully deterministic — no live model; env is stubbed via
 * vi.stubEnv.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
	DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "../../contracts/service-routing";
import {
	computeCallCostUsd,
	isLocalProvider,
	lookupModelContextWindow,
	lookupModelPrice,
	MODEL_PRICES_USD_PER_M_TOKENS,
	PRICE_TABLE_ID,
} from "./pricing";

describe("PRICE_TABLE_ID", () => {
	it("is a non-empty versioned identifier", () => {
		expect(typeof PRICE_TABLE_ID).toBe("string");
		expect(PRICE_TABLE_ID.length).toBeGreaterThan(0);
		expect(PRICE_TABLE_ID).toMatch(/eliza-v\d+-\d{4}-\d{2}-\d{2}/);
	});
});

describe("MODEL_PRICES_USD_PER_M_TOKENS", () => {
	it("covers all required hosted providers", () => {
		// Anthropic — the current public families plus the prior Opus
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-8"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-7"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-sonnet-5"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-sonnet-4-6"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"]?.provider).toBe(
			"anthropic",
		);

		// OpenAI — the ship targets per CLAUDE.md
		expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5"]?.provider).toBe("openai");
		expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5-mini"]?.provider).toBe(
			"openai",
		);

		// Google / Groq / Cerebras / Eliza Cloud — every required hosted tier
		// in the W1-X1 spec ships at least one entry.
		const providers = new Set(
			Object.values(MODEL_PRICES_USD_PER_M_TOKENS).map((p) => p.provider),
		);
		expect(providers.has("google")).toBe(true);
		expect(providers.has("groq")).toBe(true);
		expect(providers.has("cerebras")).toBe(true);
		expect(providers.has("eliza-cloud")).toBe(true);
	});

	it("local providers carry a real zero rate (not a missing entry)", () => {
		expect(MODEL_PRICES_USD_PER_M_TOKENS.ollama).toEqual({
			provider: "ollama",
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(MODEL_PRICES_USD_PER_M_TOKENS["lm-studio"]?.input).toBe(0);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["llama.cpp"]?.input).toBe(0);
	});

	it("preserves the documented Anthropic rate card", () => {
		// Opus-tier is $5/$25 per MTok (platform.claude.com pricing,
		// captured 2026-07-02); cacheRead = 0.1x input, cacheWrite = 1.25x.
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-8"]).toEqual({
			provider: "anthropic",
			input: 5.0,
			output: 25.0,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-7"]).toEqual(
			MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-8"],
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-sonnet-5"]).toEqual({
			provider: "anthropic",
			input: 3.0,
			output: 15.0,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"]).toEqual({
			provider: "anthropic",
			input: 1.0,
			output: 5.0,
			cacheRead: 0.1,
			cacheWrite: 1.25,
		});
	});

	it("prices the pinned Cerebras default from the authoritative snapshot", () => {
		expect(DEFAULT_ELIZA_CLOUD_TEXT_MODEL).toBe("qwen-3.8-27b");
		expect(DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL).toBe(
			DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
		);
		expect(
			MODEL_PRICES_USD_PER_M_TOKENS[DEFAULT_ELIZA_CLOUD_TEXT_MODEL],
		).toEqual({
			provider: "cerebras",
			input: 0.99,
			output: 1.49,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("keeps Cerebras gpt-oss aligned with the cloud billing ledger", () => {
		expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-oss-120b"]).toEqual({
			provider: "cerebras",
			input: 0.35,
			output: 0.75,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});

describe("lookupModelPrice", () => {
	it("returns null for undefined or unknown models", () => {
		expect(lookupModelPrice(undefined)).toBeNull();
		expect(lookupModelPrice("totally-unknown-model")).toBeNull();
	});

	it("returns an exact match with the canonical key", () => {
		const result = lookupModelPrice("gemma-4-31b");
		expect(result?.matchedKey).toBe("gemma-4-31b");
		expect(result?.price.provider).toBe("cerebras");
	});

	it("falls back to the longest family key for versioned ids", () => {
		// Anthropic emits versioned ids like `claude-haiku-4-5-20251001`.
		const result = lookupModelPrice("claude-haiku-4-5-20251001");
		expect(result?.matchedKey).toBe("claude-haiku-4-5");
		expect(result?.price.provider).toBe("anthropic");
	});

	it("prefers the longest matching family key when prefixes overlap", () => {
		const result = lookupModelPrice("gpt-5.5-mini-experimental");
		expect(result?.matchedKey).toBe("gpt-5.5-mini");
	});
});

describe("lookupModelContextWindow", () => {
	it("resolves the current Anthropic families to their documented windows", () => {
		expect(
			lookupModelContextWindow("claude-opus-4-8")?.contextWindowTokens,
		).toBe(1_000_000);
		expect(
			lookupModelContextWindow("claude-sonnet-5")?.contextWindowTokens,
		).toBe(1_000_000);
		expect(
			lookupModelContextWindow("claude-haiku-4-5")?.contextWindowTokens,
		).toBe(200_000);
	});

	it("resolves versioned Anthropic ids through the substring fallback", () => {
		const result = lookupModelContextWindow("claude-sonnet-5-20260203");
		expect(result?.matchedKey).toBe("claude-sonnet-5");
		expect(result?.contextWindowTokens).toBe(1_000_000);
	});

	it("returns null for a truly unknown id (default-window fallback stays with the caller)", () => {
		expect(lookupModelContextWindow("claude-unknown-test-9")).toBeNull();
	});

	it("returns the live-verified Cerebras Gemma 4 31B context window", () => {
		// 131072 is the hard paid-tier ceiling (live probe 2026-07-02:
		// >131072 -> context_length_exceeded; context_length param rejected).
		const result = lookupModelContextWindow("gemma-4-31b");
		expect(result).toEqual({
			matchedKey: "gemma-4-31b",
			contextWindowTokens: 131_072,
		});
	});
});

describe("computeCallCostUsd", () => {
	it("returns undefined when usage is unavailable", () => {
		expect(computeCallCostUsd("claude-opus-4-7", undefined)).toBeUndefined();
	});

	it("returns undefined and warns when the model is unknown on a hosted provider", () => {
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"never-heard-of-this-model",
			{
				promptTokens: 1000,
				completionTokens: 500,
				totalTokens: 1500,
			},
			{ provider: "openai", logger: { warn } },
		);
		expect(cost).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		const [context, message] = warn.mock.calls[0] ?? [];
		expect(message).toContain("[pricing]");
		expect((context as Record<string, unknown>).priceTableId).toBe(
			PRICE_TABLE_ID,
		);
		expect((context as Record<string, unknown>).modelName).toBe(
			"never-heard-of-this-model",
		);
	});

	it("returns 0 with no warning when the provider is a local tier (Ollama)", () => {
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"qwen-2.5-14b-some-local-tag",
			{ promptTokens: 100000, completionTokens: 5000, totalTokens: 105000 },
			{ provider: "ollama", logger: { warn } },
		);
		expect(cost).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns 0 with no warning when the provider is LM Studio", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"local-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "lm-studio", logger: { warn } },
			),
		).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns 0 with no warning when the provider is llama.cpp", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"phi-4-q4",
				{ promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
				{ provider: "llama.cpp", logger: { warn } },
			),
		).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("suppresses the missing-price warning when local capability is declared, even for a cloud-looking provider name", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"my-unpriced-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "acme-edge", local: true, logger: { warn } },
			),
		).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("still warns for a local-looking name when local capability is explicitly false and price is missing", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"unknown-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "ollama", local: false, logger: { warn } },
			),
		).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does not warn when logger is omitted (no noise in hot paths)", () => {
		// Should not throw even when logger is undefined.
		expect(() =>
			computeCallCostUsd(
				"unknown-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "openai" },
			),
		).not.toThrow();
	});

	it("computes input+output for an Anthropic Opus call", () => {
		// 1k input + 1k output on claude-opus-4-8.
		// input  = 1000   * $5.00/M  = $0.005
		// output = 1000   * $25.00/M = $0.025
		// total  = $0.03
		const cost = computeCallCostUsd("claude-opus-4-8", {
			promptTokens: 1000,
			completionTokens: 1000,
			totalTokens: 2000,
		});
		expect(cost).toBeCloseTo(0.03, 6);
	});

	it("computes input+output for an Anthropic Sonnet 5 call", () => {
		// 1M input * $3/M + 1M output * $15/M = $18
		const cost = computeCallCostUsd("claude-sonnet-5", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(18.0, 6);
	});

	it("bills cache-read and cache-write portions at their own full rates", () => {
		// claude-haiku-4-5: input $1.00, output $5.00, cacheRead $0.10,
		//                   cacheWrite $1.25 (per 1M).
		// 1000 prompt = 200 fresh + 700 cacheRead + 100 cacheWrite
		//   fresh:      200  * $1.00 / 1M  = $0.0002
		//   cacheRead:  700  * $0.10 / 1M  = $0.00007
		//   cacheWrite: 100  * $1.25 / 1M  = $0.000125
		//   completion:  50  * $5.00 / 1M  = $0.00025
		// total = $0.000645
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 1000,
			completionTokens: 50,
			cacheReadInputTokens: 700,
			cacheCreationInputTokens: 100,
			totalTokens: 1050,
		});
		expect(cost).toBeCloseTo(0.000645, 9);
	});

	it("bills a cache-creation token once, not at input plus cacheWrite", () => {
		// cacheWrite is a full rate (1.25x input for Anthropic), not an extra
		// charge added to the input rate. Isolate the cache-write term: all
		// prompt tokens are cache-creation, so every other term is 0.
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 1_000_000,
			completionTokens: 0,
			cacheCreationInputTokens: 1_000_000,
			totalTokens: 1_000_000,
		});
		// 1M * $1.25/M = $1.25. Billing input as well would give $2.25.
		expect(cost).toBeCloseTo(1.25, 9);
	});

	it("falls back to the input rate when cacheRead is 0 (Cerebras gpt-oss)", () => {
		// gpt-oss-120b: cacheRead == 0 → bill at input rate.
		// 1M cacheRead * $0.35/M = $0.35
		const cost = computeCallCostUsd("gpt-oss-120b", {
			promptTokens: 1_000_000,
			completionTokens: 0,
			cacheReadInputTokens: 1_000_000,
			totalTokens: 1_000_000,
		});
		expect(cost).toBeCloseTo(0.35, 6);
	});

	it("computes a real cost for Cerebras Gemma 4 31B", () => {
		// gemma-4-31b: input $0.99, output $1.49.
		// 1M input = $0.99, 1M output = $1.49, total = $2.48.
		const cost = computeCallCostUsd("gemma-4-31b", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(2.48, 6);
	});

	it("computes a real cost for Google Gemini", () => {
		// gemini-2.5-flash: input $0.30, output $2.50.
		// 1M input * $0.30 = $0.30
		// 1M output * $2.50 = $2.50
		// total = $2.80
		const cost = computeCallCostUsd("gemini-2.5-flash", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(2.8, 4);
	});

	it("computes a real cost for Groq", () => {
		// llama-3.1-8b-instant: input $0.05, output $0.08.
		// 1M input = $0.05, 1M output = $0.08, total = $0.13.
		const cost = computeCallCostUsd("llama-3.1-8b-instant", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(0.13, 6);
	});

	it("computes a real cost for Eliza Cloud", () => {
		// eliza-cloud-sonnet: input $3.60, output $18.00.
		// 1M input = $3.60, 1M output = $18.00, total = $21.60.
		const cost = computeCallCostUsd("eliza-cloud-sonnet", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(21.6, 4);
	});

	it("clamps negative non-cached input to 0 (defensive math)", () => {
		// If cacheRead + cacheWrite > promptTokens, the non-cached portion
		// must not go negative.
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 100,
			completionTokens: 0,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 0,
			totalTokens: 200,
		});
		// non-cached = 0, cacheRead = 200 * $0.10/M = $0.00002, completion = 0.
		expect(cost).toBeCloseTo(0.00002, 9);
		expect(cost).toBeGreaterThanOrEqual(0);
	});
});

describe("env overrides (MODEL_PRICES_JSON / MODEL_CONTEXT_WINDOWS_JSON)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prices an id absent from the static table via MODEL_PRICES_JSON", () => {
		vi.stubEnv(
			"MODEL_PRICES_JSON",
			JSON.stringify({
				"acme-frontier-9000": { input: 4.0, output: 20.0 },
			}),
		);
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"acme-frontier-9000",
			{
				promptTokens: 1_000_000,
				completionTokens: 1_000_000,
				totalTokens: 2_000_000,
			},
			{ provider: "unknown", logger: { warn } },
		);
		expect(cost).toBeCloseTo(24.0, 6);
		expect(warn).not.toHaveBeenCalled();
	});

	it("env price entry wins over a static entry with the same key", () => {
		vi.stubEnv(
			"MODEL_PRICES_JSON",
			JSON.stringify({
				"claude-haiku-4-5": { input: 2.0, output: 8.0 },
			}),
		);
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(10.0, 6);
	});

	it("env price keys participate in the substring fallback (versioned ids)", () => {
		vi.stubEnv(
			"MODEL_PRICES_JSON",
			JSON.stringify({ "acme-frontier-9000": { input: 1.0, output: 2.0 } }),
		);
		const result = lookupModelPrice("acme-frontier-9000-20260101");
		expect(result?.matchedKey).toBe("acme-frontier-9000");
	});

	it("resolves an arbitrary id's context window via MODEL_CONTEXT_WINDOWS_JSON", () => {
		vi.stubEnv(
			"MODEL_CONTEXT_WINDOWS_JSON",
			JSON.stringify({ "acme-frontier-9000": 500_000 }),
		);
		expect(lookupModelContextWindow("acme-frontier-9000")).toEqual({
			matchedKey: "acme-frontier-9000",
			contextWindowTokens: 500_000,
		});
	});

	it("env context window wins over a static entry with the same key", () => {
		vi.stubEnv(
			"MODEL_CONTEXT_WINDOWS_JSON",
			JSON.stringify({ "claude-haiku-4-5": 400_000 }),
		);
		expect(
			lookupModelContextWindow("claude-haiku-4-5")?.contextWindowTokens,
		).toBe(400_000);
	});

	it("malformed override JSON fails fast", () => {
		vi.stubEnv("MODEL_PRICES_JSON", "{not json");
		vi.stubEnv("MODEL_CONTEXT_WINDOWS_JSON", "[1,2,3]");
		expect(() => lookupModelPrice("claude-opus-4-8")).toThrow(
			"MODEL_PRICES_JSON is not valid JSON",
		);
	});

	it("an invalid entry rejects the whole override", () => {
		vi.stubEnv(
			"MODEL_PRICES_JSON",
			JSON.stringify({
				"bad-entry": { input: "five" },
				"good-entry": { input: 1.0, output: 2.0 },
			}),
		);
		expect(() => lookupModelPrice("good-entry")).toThrow(
			"MODEL_PRICES_JSON entry needs numeric input and output rates",
		);
	});

	it("a truly unknown id has unknown cost, warns, and has no window", () => {
		vi.stubEnv(
			"MODEL_PRICES_JSON",
			JSON.stringify({ "some-other-model": { input: 1.0, output: 2.0 } }),
		);
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"claude-unknown-test-9",
			{ promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
			{ provider: "anthropic", logger: { warn } },
		);
		expect(cost).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(lookupModelContextWindow("claude-unknown-test-9")).toBeNull();
	});
});

describe("isLocalProvider", () => {
	it("identifies known local tiers", () => {
		expect(isLocalProvider("ollama")).toBe(true);
		expect(isLocalProvider("lm-studio")).toBe(true);
		expect(isLocalProvider("llama.cpp")).toBe(true);
		expect(isLocalProvider("local")).toBe(true);
	});

	it("rejects hosted providers", () => {
		expect(isLocalProvider("anthropic")).toBe(false);
		expect(isLocalProvider("openai")).toBe(false);
		expect(isLocalProvider("cerebras")).toBe(false);
		expect(isLocalProvider("groq")).toBe(false);
	});

	it("returns false for undefined or empty", () => {
		expect(isLocalProvider(undefined)).toBe(false);
		expect(isLocalProvider("")).toBe(false);
	});

	it("normalizes case and whitespace", () => {
		expect(isLocalProvider("  Ollama  ")).toBe(true);
		expect(isLocalProvider("LM-Studio")).toBe(true);
	});

	it("honors an explicit local capability flag over the provider name", () => {
		// Cloud-looking name declared local → local.
		expect(isLocalProvider("openai", true)).toBe(true);
		// Local-looking name declared non-local → not local.
		expect(isLocalProvider("ollama", false)).toBe(false);
	});

	it("delegates to the shared name heuristic (no drifting local list)", () => {
		// Providers that the routing heuristic recognizes but were NOT in the old
		// pricing-local list must now also be treated as local here — proving the
		// two lists no longer drift.
		expect(isLocalProvider("mlx-lm")).toBe(true);
		expect(isLocalProvider("capacitor-llama")).toBe(true);
	});
});
