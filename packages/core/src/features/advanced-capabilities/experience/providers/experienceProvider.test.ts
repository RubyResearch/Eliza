/**
 * Deterministic unit coverage for the experience context provider. The suite
 * drives the real provider with an in-memory EXPERIENCE service boundary and
 * verifies its retrieval contract, result deduplication, rendering, and fail-soft
 * behavior without invoking a model or database.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../../../types/memory.ts";
import type { UUID } from "../../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";
import { experienceProvider } from "./experienceProvider.ts";

const EMPTY_RESULT = { text: "", data: {}, values: {} };

function makeExperience(id: string, learning = `learning-${id}`): Experience {
	return {
		id: id as UUID,
		agentId: "agent-id" as UUID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.POSITIVE,
		context: `context-${id}`,
		action: `action-${id}`,
		result: `result-${id}`,
		learning,
		tags: [`tag-${id}`],
		domain: "testing",
		keywords: [`keyword-${id}`],
		associatedEntityIds: [],
		confidence: 0.8,
		importance: 0.9,
		createdAt: 1,
		updatedAt: 1,
		accessCount: 0,
	};
}

function makeMessage(text?: string): Memory {
	return {
		roomId: "room-id" as UUID,
		content: text === undefined ? {} : { text },
	} as Memory;
}

function makeRuntime(options?: {
	semantic?: Experience[];
	top?: Experience[];
	queryError?: unknown;
	listError?: unknown;
}) {
	const queryCalls: unknown[] = [];
	const listCalls: unknown[] = [];
	const reportedErrors: Array<{
		scope: string;
		error: unknown;
		context: unknown;
	}> = [];
	const service = {
		queryExperiences: async (query: unknown) => {
			queryCalls.push(query);
			if (options?.queryError !== undefined) throw options.queryError;
			return options?.semantic ?? [];
		},
		listExperiences: async (query: unknown) => {
			listCalls.push(query);
			if (options?.listError !== undefined) throw options.listError;
			return options?.top ?? [];
		},
	} as unknown as ExperienceService;
	const runtime = {
		getService: (name: string) => (name === "EXPERIENCE" ? service : null),
		reportError: (scope: string, error: unknown, context: unknown) => {
			reportedErrors.push({ scope, error, context });
		},
	} as unknown as IAgentRuntime;

	return { runtime, queryCalls, listCalls, reportedErrors };
}

describe("experienceProvider", () => {
	it("exposes the provider scheduling and authorization contract", () => {
		expect(experienceProvider).toMatchObject({
			name: "experienceProvider",
			dynamic: true,
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	it("returns empty output when the EXPERIENCE service is unavailable", async () => {
		const runtime = {
			getService: () => null,
			reportError: () => {
				throw new Error("reportError should not be called");
			},
		} as unknown as IAgentRuntime;

		await expect(
			experienceProvider.get(runtime, makeMessage("a long enough message")),
		).resolves.toEqual(EMPTY_RESULT);
	});

	it.each([undefined, "", "123456789"])(
		"skips retrieval for absent or short message text (%s)",
		async (text) => {
			const { runtime, queryCalls, listCalls } = makeRuntime();

			await expect(
				experienceProvider.get(runtime, makeMessage(text)),
			).resolves.toEqual(EMPTY_RESULT);
			expect(queryCalls).toEqual([]);
			expect(listCalls).toEqual([]);
		},
	);

	it("queries only the authored request, excluding host language instructions", async () => {
		const { runtime, queryCalls } = makeRuntime();
		await experienceProvider.get(
			runtime,
			makeMessage(
				"retrieve prior learnings\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]",
			),
		);
		expect(queryCalls[0]).toMatchObject({ query: "retrieve prior learnings" });
	});

	it("references identical reason text without losing distinct reasons or provenance", async () => {
		const repeated = makeExperience("same", "Exact\n  full learning!?");
		repeated.result = repeated.learning;
		const distinct = makeExperience("different", "A different learning");
		const { runtime } = makeRuntime({ semantic: [repeated, distinct] });
		const result = await experienceProvider.get(
			runtime,
			makeMessage("retrieve prior learnings"),
		);
		expect(result.text?.split(repeated.learning)).toHaveLength(2);
		expect(result.text).toContain("WHY: Same text as DO above.");
		expect(result.text).toContain("WHY: result-different");
		expect(result.text).toContain("WHEN: context-same");
		expect(result.data?.experiences).toEqual([repeated, distinct]);
	});

	it("returns empty output when no experiences match the query", async () => {
		const { runtime, queryCalls, listCalls } = makeRuntime();

		await expect(
			experienceProvider.get(runtime, makeMessage("find prior learnings")),
		).resolves.toEqual(EMPTY_RESULT);
		expect(queryCalls).toEqual([
			{
				query: "find prior learnings",
				minConfidence: 0.6,
				minImportance: 0.5,
				includeRelated: true,
			},
		]);
		expect(listCalls).toEqual([]);
	});

	it("renders every relevant experience beyond the former default limits", async () => {
		const semantic = Array.from({ length: 12 }, (_, index) =>
			makeExperience(`semantic-${index}`),
		);
		const top = Array.from({ length: 8 }, (_, index) =>
			makeExperience(`top-${index}`),
		);
		const { runtime, listCalls } = makeRuntime({ semantic, top });

		const result = await experienceProvider.get(
			runtime,
			makeMessage("retrieve every relevant experience"),
		);

		expect(result.data).toMatchObject({
			count: 12,
			experiences: semantic,
		});
		expect(result.text).toContain("12. DO: learning-semantic-11");
		expect(result.text).not.toContain("learning-top-");
		expect(result.discoveryText).toContain("semantic-11");
		expect(result.discoveryText).toContain("context-semantic-11");
		expect(result.discoveryText).not.toContain("learning-semantic-");
		expect(listCalls).toEqual([]);
	});

	it("keeps every query match without adding high-quality unrelated experiences", async () => {
		const semanticFirst = makeExperience("shared", "semantic version wins");
		const semanticSecond = makeExperience("semantic-second");
		const topDuplicate = makeExperience("shared", "top version loses");
		const topOnly = makeExperience("top-only");
		const { runtime } = makeRuntime({
			semantic: [semanticFirst, semanticSecond],
			top: [topDuplicate, topOnly],
		});

		const result = await experienceProvider.get(
			runtime,
			makeMessage("use what worked previously"),
		);

		expect(result.data).toEqual({
			experiences: [semanticFirst, semanticSecond],
			count: 2,
		});
		expect(result.values).toEqual({ experienceCount: "2" });
		expect(result.text).toContain("[RELEVANT EXPERIENCES]");
		expect(result.text).toContain("1. DO: semantic version wins");
		expect(result.text).toContain("2. DO: learning-semantic-second");
		expect(result.text).not.toContain("learning-top-only");
		expect(result.text).not.toContain("top version loses");
		expect(result.text).toMatch(/\[\/RELEVANT EXPERIENCES\]$/);
	});

	it.each([
		[
			"semantic query",
			{ queryError: new Error("query unavailable") },
			"query unavailable",
		],
	] as const)(
		"reports a %s failure and returns an explicit unavailable result",
		async (_source, options, expectedError) => {
			const { runtime, reportedErrors } = makeRuntime(options);
			const result = await experienceProvider.get(
				runtime,
				makeMessage("retrieve relevant experience"),
			);

			expect(result).toEqual({
				text: "Relevant experiences are unavailable.",
				data: { available: false, error: expectedError },
				values: { experienceContextAvailable: false },
			});
			expect(reportedErrors).toHaveLength(1);
			expect(reportedErrors[0]).toMatchObject({
				scope: "ExperienceProvider.get",
				context: { roomId: "room-id" },
			});
		},
	);
});
