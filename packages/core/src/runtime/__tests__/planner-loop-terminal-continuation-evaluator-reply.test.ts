/**
 * When the planner keeps answering with terminal-only text and the evaluator
 * keeps answering CONTINUE, the continuation budget ends the turn. If that
 * last verdict carried a usable, user-safe `messageToUser`, the turn finishes
 * with it instead of erroring into the generic planner-exhaustion apology.
 * Deterministic — vitest-mocked `useModel`, `executeToolCall`, and
 * `evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

const UNSAFE_TERMINAL_TEXT = "I need to call TRACKING again before answering.";
const RAW_TOOL_TEXT =
	'tracking lookup ok {"status":"in_transit","eta":"2026-09-17"}';
const ANSWER =
	"Your package left the depot this morning and should arrive by Thursday.";

function plannerEmitsToolThenUnsafeTerminalText() {
	return {
		useModel: vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-1", name: "TRACKING", arguments: { parcel: "1Z999" } },
				],
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			})
			.mockResolvedValueOnce({
				text: UNSAFE_TERMINAL_TEXT,
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			}),
		logger: { warn: vi.fn() },
	};
}

function evaluatorContinuesWith(messageToUser?: string, success = true) {
	return vi.fn(async () => ({
		success,
		decision: "CONTINUE" as const,
		thought: "The terminal text narrates work instead of answering.",
		...(messageToUser !== undefined ? { messageToUser } : {}),
	}));
}

describe("planner-loop - terminal continuation evaluator reply", () => {
	it("finishes with the evaluator's user-facing reply when the continuation budget is exhausted", async () => {
		const runtime = plannerEmitsToolThenUnsafeTerminalText();
		// Diagnostic-only result: no userFacingText, so no tool relay exists.
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: RAW_TOOL_TEXT,
		}));
		const evaluate = evaluatorContinuesWith(ANSWER);

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(ANSWER);
		expect(result.evaluator).toMatchObject({
			success: true,
			decision: "FINISH",
		});
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ terminalOnlyContinuations: 1 }),
			expect.stringContaining("evaluator's own reply"),
		);
	});

	it("relays the evaluator's failure diagnosis after a failed tool", async () => {
		const diagnosis =
			"I couldn't reach the tracking service, so I don't have an update for that parcel yet.";
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "upstream timeout",
		}));

		const result = await runPlannerLoop({
			runtime: plannerEmitsToolThenUnsafeTerminalText(),
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate: evaluatorContinuesWith(diagnosis, false),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(diagnosis);
		expect(result.evaluator).toMatchObject({
			success: false,
			decision: "FINISH",
		});
	});

	it("keeps the continuation-limit error when the verdict carries no message", async () => {
		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolThenUnsafeTerminalText(),
				context: { id: "ctx" },
				config: { maxTerminalOnlyContinuations: 0 },
				executeToolCall: vi.fn(async () => ({
					success: true,
					text: RAW_TOOL_TEXT,
				})),
				evaluate: evaluatorContinuesWith(),
			}),
		).rejects.toMatchObject({
			kind: "terminal_only_continuations",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});

	it("keeps the continuation-limit error when the verdict's message is an in-flight promise", async () => {
		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolThenUnsafeTerminalText(),
				context: { id: "ctx" },
				config: { maxTerminalOnlyContinuations: 0 },
				executeToolCall: vi.fn(async () => ({
					success: true,
					text: RAW_TOOL_TEXT,
				})),
				evaluate: evaluatorContinuesWith(
					"Let me check the carrier once more and get right back to you.",
				),
			}),
		).rejects.toMatchObject({
			kind: "terminal_only_continuations",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});

	it("keeps the continuation-limit error when the verdict's message echoes planner-facing tool text", async () => {
		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolThenUnsafeTerminalText(),
				context: { id: "ctx" },
				config: { maxTerminalOnlyContinuations: 0 },
				executeToolCall: vi.fn(async () => ({
					success: true,
					text: RAW_TOOL_TEXT,
				})),
				evaluate: evaluatorContinuesWith(RAW_TOOL_TEXT),
			}),
		).rejects.toMatchObject({
			kind: "terminal_only_continuations",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});
});
