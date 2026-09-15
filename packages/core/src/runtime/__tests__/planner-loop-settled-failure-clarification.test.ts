/**
 * A settled, non-retryable tool failure followed by the planner's clarifying
 * question must end the turn with that question, even when the evaluator
 * keeps answering CONTINUE (live 2026-09-12, tj-00000f20dab904).
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const QUESTION =
	"I couldn't find the optometrist appointment. What's the exact title or any other detail (date, location) so I can move it?";

describe("settled failure clarification relay", () => {
	it("finishes with the planner's question instead of looping to the continuation limit", async () => {
		let plannerCalls = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				plannerCalls++;
				if (plannerCalls === 1) {
					return {
						text: "",
						toolCalls: [
							{
								id: "calendar-1",
								name: "CALENDAR",
								arguments: {
									action: "update_event",
									query: "optometrist appointment",
									eliza_turn_scope: "final",
								},
							},
						],
					};
				}
				return { text: QUESTION, toolCalls: [] };
			}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			transcriptVisibility: "internal" as const,
			turnComplete: false,
			effectReceipts: [
				{
					receiptId: "calendar-noop-1",
					operation: "calendar.event.update",
					resource: { kind: "calendar.event", id: "unknown" },
					artifacts: [],
					idempotency: { key: null, replayed: false },
					observedAt: "2026-09-12T02:52:00.000Z",
					outcome: "noop",
				},
			],
			data: {
				actionName: "CALENDAR",
				subaction: "update_event",
				retryable: false,
				replyContext: {
					scenario: "update_event_not_found",
					facts: "No event matched.",
				},
			},
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "still need the event",
			messageToUser: QUESTION,
		}));
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx", events: [] } as never,
			executeToolCall,
			evaluate,
		});
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain(
			"couldn't find the optometrist appointment",
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate.mock.calls.length).toBeLessThanOrEqual(2);
	});
});
