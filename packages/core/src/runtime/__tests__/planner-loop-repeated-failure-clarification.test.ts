/**
 * A tool that keeps failing with its own user-safe clarifying question must
 * end the turn with that question when the repeated-failure limit fires,
 * instead of erroring into the generic planner-exhaustion apology (live
 * 2026-09-13 22:44Z, tj-f1579f952d5d21: MEMORY_DELETE answered
 * MEMORY_AMBIGUOUS_QUERY for the same re-sent query until the limit threw and
 * the user got "i had a hiccup with the last request"). Deterministic —
 * vitest-mocked `useModel`, `executeToolCall`, and `evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

const OWN_ID = "21411612-9169-4d35-8c08-b303aae8ab5b";
const ECHO_ID = "4cde318d-fa36-4e45-b0b6-01918379248e";
const PLANNER_FACING_TEXT = [
	'Query "forget my favorite color" matches 2 distinct memories. Delete by memoryId instead:',
	`- [facts] ${OWN_ID}: user favorite_color teal`,
	`- [facts] ${ECHO_ID}: The user's favorite color is teal.`,
].join("\n");
const QUESTION =
	'That matches 2 saved memories: "user favorite_color teal"; "your favorite color is teal.". Which one should I forget?';

function plannerRepeatsTheSameDelete() {
	return {
		useModel: vi.fn(async () => ({
			text: "",
			toolCalls: [
				{
					id: "delete-1",
					name: "MEMORY_DELETE",
					arguments: {
						query: "forget my favorite color",
						confirm: true,
						eliza_turn_scope: "final",
					},
				},
			],
		})),
		logger: { warn: vi.fn() },
	};
}

function evaluatorKeepsReplanning() {
	return vi.fn(async () => ({
		success: false,
		decision: "CONTINUE" as const,
		thought: "The delete was ambiguous; replan by memoryId.",
	}));
}

function ambiguousDelete(
	userFacingText?: string,
	data: Record<string, unknown> = {},
) {
	return vi.fn(async () => ({
		success: false,
		text: PLANNER_FACING_TEXT,
		...(userFacingText !== undefined ? { userFacingText } : {}),
		data: {
			error: "MEMORY_AMBIGUOUS_QUERY",
			candidates: [
				{ id: OWN_ID, type: "facts", text: "user favorite_color teal" },
				{
					id: ECHO_ID,
					type: "facts",
					text: "The user's favorite color is teal.",
				},
			],
			...data,
		},
	}));
}

describe("planner-loop - repeated-failure clarification relay", () => {
	it("finishes with the failed tool's own clarifying question when the limit fires", async () => {
		const runtime = plannerRepeatsTheSameDelete();
		const executeToolCall = ambiguousDelete(QUESTION, {
			readOnlyOperation: true,
		});
		const evaluate = evaluatorKeepsReplanning();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxRepeatedFailures: 1 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(QUESTION);
		expect(result.finalMessage).not.toContain(OWN_ID);
		expect(result.finalMessage).not.toContain(ECHO_ID);
		expect(result.evaluator).toMatchObject({
			success: false,
			decision: "FINISH",
		});
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		// The failure that tripped the limit stays on the trajectory.
		expect(
			result.trajectory.steps.filter((step) => step.toolCall),
		).toHaveLength(2);
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "MEMORY_DELETE" }),
			expect.stringContaining("repeated-failure limit reached"),
		);
	});

	it("keeps the tool's question when the failed step also owns the terminal message", async () => {
		// Without the read-only marker the failed step is the unresolved failure
		// and its userFacingText is the grounded failure text — same reply.
		const result = await runPlannerLoop({
			runtime: plannerRepeatsTheSameDelete(),
			context: { id: "ctx" },
			config: { maxRepeatedFailures: 1 },
			executeToolCall: ambiguousDelete(QUESTION),
			evaluate: evaluatorKeepsReplanning(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(QUESTION);
	});

	it("keeps the generic fallback when the tool's clarification carries record ids", async () => {
		const executeToolCall = ambiguousDelete(
			`Which one should I forget: ${OWN_ID} or ${ECHO_ID}?`,
			{ readOnlyOperation: true },
		);

		await expect(
			runPlannerLoop({
				runtime: plannerRepeatsTheSameDelete(),
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall,
				evaluate: evaluatorKeepsReplanning(),
			}),
		).rejects.toMatchObject({
			kind: "repeated_failures",
		} satisfies Partial<TrajectoryLimitExceeded>);
		expect(executeToolCall).toHaveBeenCalledTimes(2);
	});

	it("keeps the generic fallback when the failed tool owns no user-facing text", async () => {
		await expect(
			runPlannerLoop({
				runtime: plannerRepeatsTheSameDelete(),
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall: ambiguousDelete(),
				evaluate: evaluatorKeepsReplanning(),
			}),
		).rejects.toMatchObject({
			kind: "repeated_failures",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});

	it("does not relay a tool-owned refusal that asks nothing of the user", async () => {
		await expect(
			runPlannerLoop({
				runtime: plannerRepeatsTheSameDelete(),
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall: ambiguousDelete(
					"The storage operation failed; I cannot claim it completed.",
				),
				evaluate: evaluatorKeepsReplanning(),
			}),
		).rejects.toMatchObject({
			kind: "repeated_failures",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});
});
