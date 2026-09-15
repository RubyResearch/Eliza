/**
 * Exercises experience search through its action and planner boundaries using
 * a controlled experience service and model. Search results remain internal
 * evidence, complete queries survive in model-facing results, and an empty
 * search cannot terminate unrelated queued work.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../../../../runtime/planner-loop.ts";
import { hardenIncomingUserMessage } from "../../../../security/incoming-message-security.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { searchExperiencesAction } from "./search-experiences.ts";

function makeRuntime() {
	const queries: Array<{ query?: string }> = [];
	const service = {
		queryExperiences: async (q: { query?: string }) => {
			queries.push(q);
			return [];
		},
		getExperienceGraph: async () => ({ nodes: [], links: [] }),
	};
	const runtime = {
		agentId: "agent-id",
		getService: (name: string) => (name === "EXPERIENCE" ? service : null),
	} as unknown as IAgentRuntime;
	return { runtime, queries };
}

/**
 * A message as a hardened connector delivers it: content.text is the security
 * envelope with the user's sentence as payload, `externalContentWrapped` set.
 */
function hardenedMessage(text: string): Memory {
	const memory = {
		entityId: "user-id",
		roomId: "room-id",
		content: { text, source: "discord" },
	} as unknown as Memory;
	hardenIncomingUserMessage(memory);
	return memory;
}

describe("SEARCH_EXPERIENCES hardened-message fallback (envelope echo regression)", () => {
	it("continues queued work after an empty search and lets the evaluator compose the answer", async () => {
		const { runtime, queries } = makeRuntime();
		const message = hardenedMessage(
			"Search for QA ferry trip, then record the QA-only correction.",
		);
		const stored: string[] = [];
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "search",
					name: "SEARCH_EXPERIENCES",
					arguments: { query: "QA ferry trip" },
				},
				{
					id: "memory",
					name: "MEMORY",
					arguments: { action: "create", text: "QA-only ferry trip" },
				},
			],
		});
		const reply = "The search was empty; I recorded the QA-only correction.";
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			executeToolCall: async (call) => {
				if (call.name === "SEARCH_EXPERIENCES") {
					return searchExperiencesAction.handler(runtime, message, undefined, {
						parameters: call.params,
					});
				}
				if (call.name !== "MEMORY") throw new Error("Unexpected action");
				stored.push(String(call.params?.text));
				return { success: true, text: "QA correction stored." };
			},
			evaluate: async ({ trajectory }) =>
				trajectory.plannedQueue.length > 0
					? {
							success: false,
							decision: "NEXT_RECOMMENDED",
							thought: "The search is empty; the requested correction remains.",
							recommendedToolCallId: trajectory.plannedQueue[0]?.id,
						}
					: {
							success: true,
							decision: "FINISH",
							thought: "Both requested steps completed.",
							messageToUser: reply,
						},
		});

		expect(queries).toEqual([
			expect.objectContaining({ query: "QA ferry trip" }),
		]);
		expect(stored).toEqual(["QA-only ferry trip"]);
		expect(result.finalMessage).toBe(reply);
		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("derives the query from the user's words and never echoes the envelope", async () => {
		const { runtime, queries } = makeRuntime();
		const message = hardenedMessage(
			"search my experience for solana wallet bugs",
		);
		expect(message.content.text).toContain("SECURITY NOTICE");
		expect(message.content.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
		expect(
			(message.content.metadata as { externalContentWrapped?: boolean })
				.externalContentWrapped,
		).toBe(true);

		const delivered: string[] = [];
		const result = await searchExperiencesAction.handler(
			runtime,
			message,
			undefined,
			undefined,
			async (content) => {
				if (typeof content.text === "string") delivered.push(content.text);
				return [];
			},
		);

		// The search itself ran on the unwrapped sentence, not the envelope.
		expect(queries[0]?.query).toBe("solana wallet bugs");
		expect(delivered).toEqual([]);
		const visible = result.text ?? "";
		expect(visible).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(visible).not.toContain("SECURITY NOTICE");
		expect(visible).toContain('"solana wallet bugs"');
		expect((result.data as { query: string }).query).toBe("solana wallet bugs");
	});

	it("preserves a complete multiline query without streaming internal search text", async () => {
		const { runtime } = makeRuntime();
		// Payload that matches no strip pattern: the raw-text fallback becomes
		// the query, so both echo layers must hold on their own.
		const blobPayload = `first line of a pasted document\n${"lorem ipsum ".repeat(30)}終端`;
		const message = hardenedMessage(blobPayload);

		const delivered: string[] = [];
		const result = await searchExperiencesAction.handler(
			runtime,
			message,
			undefined,
			undefined,
			async (content) => {
				if (typeof content.text === "string") delivered.push(content.text);
				return [];
			},
		);

		expect(delivered).toEqual([]);
		const visible = result.text ?? "";
		expect(visible).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(visible).not.toContain("SECURITY NOTICE");
		expect(visible).toContain("No experiences found for that request.");
		expect(visible).toContain(JSON.stringify(blobPayload));
		const data = result.data as { query: string };
		expect(data.query).toBe(blobPayload);
		expect(result.values?.experienceSearchQuery).toBe(blobPayload);
		expect(result.transcriptVisibility).toBe("internal");
	});
});
