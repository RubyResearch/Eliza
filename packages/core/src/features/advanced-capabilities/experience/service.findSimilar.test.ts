/**
 * Unit tests for `ExperienceService.findSimilarExperiences` and its shared
 * recall-embedder wiring: a mocked `embedRecallQuery` verifies that a null embed
 * (timeout/error) fails open to the recency/quality fallback set, and that ranking
 * always routes through the shared embedder rather than a direct useModel call.
 * Uses the in-memory mock runtime — no live model, no real DB.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type { Memory } from "../../../types/memory.ts";
import type { UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { type Experience, ExperienceType, OutcomeType } from "./types.ts";

// Force the shared recall-query embedder to fail open (error → null) so we can
// assert findSimilarExperiences falls back to the recency/quality sort instead
// of throwing or hanging.
const embedRecallQuery =
	vi.fn<(runtime: IAgentRuntime, text: string) => Promise<number[] | null>>();
vi.mock("../../documents/recall-embed.ts", () => ({
	embedRecallQuery: (runtime: IAgentRuntime, text: string) =>
		embedRecallQuery(runtime, text),
}));

// Imported after the mock is registered.
const { ExperienceService } = await import("./service.ts");

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const EXP_OLD = "00000000-0000-0000-0000-00000000e001" as UUID;
const EXP_NEW = "00000000-0000-0000-0000-00000000e002" as UUID;

function experienceMemory(
	id: UUID,
	createdAt: number,
	overrides: Partial<Experience> = {},
): Memory {
	return {
		id,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		createdAt,
		content: {
			text: "",
			type: "experience",
			data: {
				id,
				agentId: AGENT_ID,
				type: ExperienceType.LEARNING,
				outcome: OutcomeType.NEUTRAL,
				context: "ctx",
				action: "act",
				result: "res",
				learning: `learning ${id}`,
				domain: "general",
				tags: ["t"],
				keywords: ["k"],
				confidence: 0.8,
				importance: 0.7,
				createdAt,
				updatedAt: createdAt,
				accessCount: 0,
				embedding: [0.1, 0.2, 0.3],
				...overrides,
			},
		},
	} as unknown as Memory;
}

function makeRuntime(): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
} {
	const useModel = vi.fn(async () => [0.1, 0.2, 0.3]);
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getCurrentRunId: () => "33333333-3333-3333-3333-333333333333",
		getMemories: vi.fn(async () => [
			experienceMemory(EXP_OLD, 1_000),
			experienceMemory(EXP_NEW, 2_000),
		]),
		upsertMemory: vi.fn(async () => true),
		useModel,
	});
	return { runtime, useModel };
}

describe("ExperienceService.findSimilarExperiences — shared recall embed fail-open", () => {
	afterEach(() => {
		embedRecallQuery.mockReset();
	});

	test("stronger similarity precedes quality while all candidates remain retrievable", async () => {
		embedRecallQuery.mockResolvedValue([1, 0, 0]);
		const memories = [
			experienceMemory(EXP_OLD, 1_000, {
				embedding: [0.5, Math.sqrt(0.75), 0],
				confidence: 0.4,
				importance: 0.4,
			}),
			experienceMemory(EXP_NEW, Date.now(), {
				embedding: [0.4, Math.sqrt(0.84), 0],
				confidence: 0.99,
				importance: 0.99,
			}),
		];
		const { runtime, useModel } = makeRuntime();
		vi.mocked(runtime.getMemories).mockResolvedValue(memories);
		const service = await ExperienceService.start(runtime);
		expect(
			(await service.findSimilarExperiences("matching situation")).map(
				(e) => e.id,
			),
		).toEqual([EXP_OLD, EXP_NEW]);
		expect(
			(await service.findSimilarExperiences("matching situation", 1)).map(
				(e) => e.id,
			),
		).toEqual([EXP_OLD]);
		expect(useModel).not.toHaveBeenCalled();
		await service.stop();
	});

	test("a null recall embed (timeout/error) falls open to the recency/quality sort, never calling useModel directly", async () => {
		embedRecallQuery.mockResolvedValue(null);
		const { runtime, useModel } = makeRuntime();

		const service = await ExperienceService.start(runtime);

		const results = await service.findSimilarExperiences("any query", 5);

		// Fail-open returns the fallback set (both loaded experiences), not [].
		expect(results.map((e) => e.id).sort()).toEqual([EXP_OLD, EXP_NEW].sort());
		// The provider must route through the shared embedder, not embed directly.
		expect(embedRecallQuery).toHaveBeenCalledWith(runtime, "any query");
		expect(useModel).not.toHaveBeenCalled();

		await service.stop();
	});

	test("a resolved recall embed is used for vector ranking (shared embedder, not a direct useModel call)", async () => {
		embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
		const { runtime, useModel } = makeRuntime();

		const service = await ExperienceService.start(runtime);

		const results = await service.findSimilarExperiences("any query", 5);

		expect(embedRecallQuery).toHaveBeenCalledWith(runtime, "any query");
		expect(useModel).not.toHaveBeenCalled();
		expect(results.length).toBeGreaterThan(0);

		await service.stop();
	});
});
