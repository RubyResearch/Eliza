/**
 * Unit coverage for prompt-cache planning — `buildProviderCachePlan` and
 * `buildPromptCacheKey` — verifying the per-provider `providerOptions` (OpenAI
 * retention, Anthropic breakpoints, Cerebras/OpenRouter, Gemini, Gateway, and
 * the eliza sidecar) and the 1024-char cache-key cap. Deterministic; no live
 * provider call.
 */
import { describe, expect, it } from "vitest";
import {
	buildPromptCacheKey,
	buildProviderCachePlan,
} from "../provider-cache-plan";

describe("ProviderCachePlan", () => {
	it("builds deterministic providerOptions for OpenAI, Cerebras, OpenRouter, and Gateway", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s1", "s2"],
		});

		expect(plan.promptCacheKey).toBe("v5:abc123");
		expect(plan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
		});
		expect(plan.providerOptions.cerebras).toEqual({});
		expect(plan.providerOptions.openrouter).toEqual({
			promptCacheKey: "v5:abc123",
			prompt_cache_key: "v5:abc123",
		});
		expect(plan.providerOptions.gateway).toEqual({ caching: "auto" });
	});

	it("keeps Cerebras workflow affinity through prompt evolution and separates resumed workflows", () => {
		const identity = `agent-a:room:${"x".repeat(2000)}`;
		const plan = (conversationId: string, prefixHash: string) =>
			buildProviderCachePlan({ conversationId, prefixHash }).providerOptions;
		const first = plan(identity, "before");
		const resumed = plan(identity, "after");
		const other = plan(`${identity}:other`, "before");
		expect(first.cerebras).toEqual(resumed.cerebras);
		expect(first.cerebras).not.toEqual(other.cerebras);
		expect(first.openai).not.toEqual(resumed.openai);
		expect(first.eliza).toMatchObject({ conversationId: identity });
		expect(JSON.stringify(first.cerebras)).not.toContain(identity);
	});

	it("only emits OpenAI 24h retention for documented extended-retention models", () => {
		const miniPlan = buildProviderCachePlan({
			prefixHash: "abc123",
			model: "gpt-5.4-mini",
		});
		const extendedPlan = buildProviderCachePlan({
			prefixHash: "abc123",
			model: "gpt-5.4",
		});

		expect(miniPlan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
		});
		expect(extendedPlan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
			promptCacheRetention: "24h",
		});
	});

	it("limits Anthropic user-content breakpoints to three plus system", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3", "s4"],
			promptSegments: [
				{ stable: true },
				{ stable: false },
				{ stable: true },
				{ stable: false },
				{ stable: true },
			],
		});

		const anthropic = plan.providerOptions.anthropic as Record<string, unknown>;
		expect(anthropic.maxBreakpoints).toBe(4);
		expect(anthropic.cacheSystem).toBe(true);
		expect(plan.anthropic.breakpoints).toHaveLength(3);
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.segmentIndex),
		).toEqual([0, 2, 4]);
		expect(1 + plan.anthropic.breakpoints.length).toBeLessThanOrEqual(4);
	});

	it("routes per-segment TTL hints into Anthropic breakpoints (#15742)", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3"],
			promptSegments: [
				// Stable run ending at index 1: run-end segment carries ttl "long".
				{ stable: true },
				{ stable: true, ttl: "long" },
				{ stable: false },
				// Stable run of one segment with no ttl → default "short".
				{ stable: true },
			],
		});

		expect(plan.anthropic.breakpoints).toEqual([
			{
				segmentIndex: 1,
				segmentHash: "s1",
				ttl: "long",
				cacheControl: { type: "ephemeral", ttl: "1h" },
			},
			{
				segmentIndex: 3,
				segmentHash: "s3",
				ttl: "short",
				cacheControl: { type: "ephemeral" },
			},
		]);
	});

	it("ignores a ttl hint on a segment that is not a stable run end (#15742)", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2"],
			promptSegments: [
				// ttl on a mid-run segment is inert; the run END segment governs.
				{ stable: true, ttl: "long" },
				{ stable: true },
				{ stable: false },
			],
		});

		expect(plan.anthropic.breakpoints).toEqual([
			{
				segmentIndex: 1,
				segmentHash: "s1",
				ttl: "short",
				cacheControl: { type: "ephemeral" },
			},
		]);
	});

	it("uses section priority while preserving selected marker order", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3"],
			sections: [
				{ id: "low", segmentIndex: 0, priority: 1, ttl: "short" },
				{ id: "history", segmentIndex: 3, priority: 10, ttl: "short" },
				{ id: "character", segmentIndex: 1, priority: 20, ttl: "long" },
				{ id: "tier-a", segmentIndex: 2, priority: 15, ttl: "short" },
			],
		});

		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.id),
		).toEqual(["character", "tier-a", "history"]);
		expect(plan.anthropic.breakpoints[0]?.cacheControl).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("does not emit explicit Gemini cache markers when tools are present", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			provider: "google",
			model: "gemini-3-pro",
			hasTools: true,
			promptSegments: [{ stable: true }],
		});

		expect(plan.providerOptions).not.toHaveProperty("anthropic");
		expect(plan.providerOptions).not.toHaveProperty("google");
		expect(plan.warnings[0]).toContain("Gemini explicit caching is disabled");
	});

	it("caps prompt cache keys at 1024 characters", () => {
		expect(buildPromptCacheKey("x".repeat(2000))).toHaveLength(1024);
	});

	it("emits conversationId on providerOptions.eliza when provided", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			conversationId: "room-1",
		});
		expect(plan.providerOptions.eliza).toMatchObject({
			conversationId: "room-1",
			promptCacheKey: "v5:abc123",
		});
	});

	it("omits conversationId when blank or unset", () => {
		const noneProvided = buildProviderCachePlan({ prefixHash: "abc" });
		expect(noneProvided.providerOptions.eliza).not.toHaveProperty(
			"conversationId",
		);
		const empty = buildProviderCachePlan({
			prefixHash: "abc",
			conversationId: "",
		});
		expect(empty.providerOptions.eliza).not.toHaveProperty("conversationId");
	});

	it("scopes Cerebras routing by conversation across prefix changes without changing other providers", () => {
		const first = buildProviderCachePlan({
			prefixHash: "shared-instructions",
			conversationId: "private-room-1",
		});
		const same = buildProviderCachePlan({
			prefixHash: "shared-instructions",
			conversationId: "private-room-1",
			segmentHashes: ["new-turn"],
		});
		const otherRoom = buildProviderCachePlan({
			prefixHash: "shared-instructions",
			conversationId: "private-room-2",
		});
		const otherPrefix = buildProviderCachePlan({
			prefixHash: "different-instructions",
			conversationId: "private-room-1",
		});
		const key = (first.providerOptions.cerebras as { promptCacheKey: string })
			.promptCacheKey;
		expect(key).toMatch(/^eliza-workflow-v1:[0-9a-f]{64}$/);
		expect(key).not.toContain("private-room-1");
		expect(same.providerOptions.cerebras).toEqual(
			first.providerOptions.cerebras,
		);
		expect(otherRoom.providerOptions.cerebras).not.toEqual(
			first.providerOptions.cerebras,
		);
		expect(otherPrefix.providerOptions.cerebras).toEqual(
			first.providerOptions.cerebras,
		);
		expect(first.providerOptions.cerebras).toEqual({
			promptCacheKey: key,
			prompt_cache_key: key,
		});
		const unscoped = buildProviderCachePlan({
			prefixHash: "shared-instructions",
		});
		for (const name of ["openai", "openrouter", "anthropic", "gateway"])
			expect(first.providerOptions[name]).toEqual(
				unscoped.providerOptions[name],
			);
	});

	it("forwards stable promptSegments on providerOptions.eliza for local backends", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			promptSegments: [
				{ content: "system: stable", stable: true } as unknown as {
					stable?: boolean;
				},
				{ content: "now: timestamp", stable: false } as unknown as {
					stable?: boolean;
				},
			],
		});
		const eliza = plan.providerOptions.eliza as Record<string, unknown>;
		expect(eliza.promptSegments).toEqual([
			{ content: "system: stable", stable: true },
			{ content: "now: timestamp", stable: false },
		]);
	});
});
