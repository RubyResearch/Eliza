/**
 * Covers the planner's user-facing-text isolation: only a tool's explicit
 * `userFacingText` (never its log-shaped `text`) reaches the reply,
 * confirmation previews can claim the canonical reply without pretending to be
 * persisted saves, and the spawn-arg-leak detector suppresses leaked TASKS
 * envelopes. Deterministic — vitest-mocked `useModel` plus pure helper
 * assertions; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
	codingActionSummary,
	latestToolResultText,
	looksLikeActionEnvelopeJson,
	looksLikeSpawnEnvelopeJson,
	runPlannerLoop,
	singleVerifiedUserFacingToolResultText,
} from "../planner-loop";
import type { PlannerTrajectory } from "../planner-types";
import type { TrajectoryRecorder } from "../trajectory-recorder";

/**
 * Guards the `userFacingText` contract that keeps tool-diagnostic `text`
 * (shell prompts, `[exit 0]`, `--- stdout ---` wrappers, cwd markers, byte
 * counts) out of user replies.
 *
 * `PlannerToolResult` carries an explicit `userFacingText` field, and the
 * terminal-FINISH fallback (used when the evaluator supplies no
 * `messageToUser`) displays only that — never the tool's log-shaped `text`.
 * A log-only tool like BASH emits a wrapper such as:
 *
 *   $ find /home/eliza/.eliza/trajectories -type f
 *   [exit 0] (cwd=/home/eliza/iqlabs/eliza/eliza, took=37ms)
 *   --- stdout ---
 *   443
 *
 * and leaves `userFacingText` undefined, so the loop synthesizes a response
 * instead of leaking the wrapper. This is a structural contract, not
 * regex-based wrapper detection.
 */

describe("planner-loop — user-facing tool text isolation", () => {
	it("does not leak tool-diagnostic text into the user reply when userFacingText is unset", async () => {
		// Mimic the BASH wrapper that was leaking. A tool that emits a
		// shell log and *no* userFacingText must NOT have its log become
		// the user-facing reply.
		const bashWrapper =
			"$ find /tmp -type f\n[exit 0] (cwd=/home/eliza, took=12ms)\n--- stdout ---\n443";
		const runtime = {
			useModel: vi
				.fn()
				// First call: planner — emits one tool call, no messageToUser.
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "BASH", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				// Second call: evaluator — decides FINISH, no messageToUser.
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool finished cleanly.",
						// No messageToUser — this is the failure mode that used to
						// trigger the leak.
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			// Tool's diagnostic log goes into `text` — must NEVER reach user.
			text: bashWrapper,
			// `userFacingText` deliberately omitted — BASH is a log-only tool.
		}));
		const recorder: TrajectoryRecorder = {
			startTrajectory: vi.fn(() => "trj-1"),
			recordStage: vi.fn(async () => undefined),
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
			recorder,
			trajectoryId: "trj-1",
		});

		expect(result.status).toBe("finished");
		// The final message must not contain any portion of the shell
		// wrapper. Specifically: no `$ `, no `[exit `, no `--- stdout ---`,
		// no `cwd=`. (These are properties of the wrapper, not regex used
		// to fix it — the fix itself is the userFacingText opt-in. These
		// assertions just prove the leak is gone.)
		const finalMessage = result.finalMessage ?? "";
		expect(finalMessage).not.toContain("$ find");
		expect(finalMessage).not.toContain("[exit");
		expect(finalMessage).not.toContain("--- stdout ---");
		expect(finalMessage).not.toContain("cwd=");
	});

	it("uses userFacingText as the reply when a tool sets it", async () => {
		const userFriendly =
			"Here are your 3 most recent PRs: #7593, #7592, #7588.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "Q_AND_A", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				// Evaluator: FINISH with no messageToUser → framework falls
				// through to latestToolResultText, which now returns
				// userFacingText.
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool answered.",
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: `Q_AND_A result\n[exit 0]\n--- stdout ---\n${userFriendly}`,
			userFacingText: userFriendly,
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(userFriendly);
		// Diagnostic wrapper still must not leak.
		expect(result.finalMessage ?? "").not.toContain("[exit 0]");
	});

	it.each([
		"All three counters reset to zero.",
		"Got it. I’ll keep replies brief and natural unless you ask for detail.",
		"Okay, your note now says bring a charger and water.",
	])(
		"keeps the post-tool evaluator reply without another model call: %s",
		async (evaluatorMessage) => {
			// When evaluator provides a clean messageToUser, the tool's
			// userFacingText is not even consulted — the evaluator wins.
			const runtime = {
				useModel: vi.fn().mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "ANY", arguments: {} }],
					usage: {
						promptTokens: 100,
						completionTokens: 10,
						totalTokens: 110,
					},
				}),
			};
			const executeToolCall = vi.fn(async () => ({
				success: true,
				text: "internal log",
				userFacingText: "tool would also have something to say",
			}));
			const evaluate = vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				messageToUser: evaluatorMessage,
				thought: "Done.",
			}));

			const result = await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall,
				evaluate,
			});

			expect(result.finalMessage).toBe(evaluatorMessage);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(evaluate).toHaveBeenCalledTimes(1);
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
		},
	);
});

describe("singleVerifiedUserFacingToolResultText — canonical tool filter", () => {
	// A failed step that is neither a user-complete preview nor a successful
	// action should not make a later verified tool ambiguous.
	const trajectoryWith = (
		steps: PlannerTrajectory["steps"],
		archivedSteps: PlannerTrajectory["steps"] = [],
	): PlannerTrajectory => ({
		context: { id: "ctx" },
		steps,
		archivedSteps,
		plannedQueue: [],
		evaluatorOutputs: [],
	});

	const failedStep = {
		iteration: 0,
		toolCall: { id: "call-1", name: "FLAKY", arguments: {} },
		result: {
			success: false as const,
			text: "transient network error",
			error: "ECONNRESET",
		},
	};
	const verifiedStep = {
		iteration: 1,
		toolCall: { id: "call-2", name: "CHECK_CACHE", arguments: {} },
		result: {
			success: true as const,
			text: "raw diag",
			userFacingText: "Wrote 14 files to /home/example/.bun/install/cache.",
			verifiedUserFacing: true,
		},
	};

	it("returns the verified tool's text when a prior step failed", () => {
		const trajectory = trajectoryWith([failedStep, verifiedStep]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBe(
			"Wrote 14 files to /home/example/.bun/install/cache.",
		);
	});

	it("includes archived successes in verified text and ambiguity checks", () => {
		const archivedOnly = trajectoryWith([], [verifiedStep]);
		expect(singleVerifiedUserFacingToolResultText(archivedOnly)).toBe(
			"Wrote 14 files to /home/example/.bun/install/cache.",
		);

		const acrossBoundary = trajectoryWith(
			[
				{
					...verifiedStep,
					iteration: 2,
					toolCall: { id: "call-3", name: "OTHER", arguments: {} },
				},
			],
			[verifiedStep],
		);
		expect(
			singleVerifiedUserFacingToolResultText(acrossBoundary),
		).toBeUndefined();
	});

	it("returns undefined when two successful tools both have results", () => {
		// Genuine ambiguity — caller falls through to evaluator/fallback.
		const secondVerified = {
			...verifiedStep,
			iteration: 2,
			toolCall: { id: "call-3", name: "OTHER", arguments: {} },
		};
		const trajectory = trajectoryWith([
			{ ...verifiedStep, iteration: 1 },
			secondVerified,
		]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});

	it("returns undefined when the single successful tool did not opt in", () => {
		const trajectory = trajectoryWith([
			failedStep,
			{
				...verifiedStep,
				result: { ...verifiedStep.result, verifiedUserFacing: false },
			},
		]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});

	it("returns undefined when there are no successful tools", () => {
		const trajectory = trajectoryWith([failedStep]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});

	it("returns a verified confirmation preview even though the action is not a persisted success", () => {
		const preview =
			"I can save this as a goal. Success looks like holding a 10-minute Spanish conversation by December 1. Confirm and I'll save it.";
		const trajectory = trajectoryWith([
			{
				iteration: 0,
				toolCall: { id: "call-1", name: "OWNER_GOALS", arguments: {} },
				result: {
					success: false as const,
					text: preview,
					userFacingText: preview,
					verifiedUserFacing: true,
					data: {
						requiresConfirmation: true,
						lifeDraft: {
							operation: "create_goal",
							request: { title: "Conversational Spanish" },
						},
					},
				},
			},
		]);

		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBe(preview);
	});

	it("returns the latest verified confirmation preview when a turn drafted more than once", () => {
		const firstPreview =
			"I can save this as a goal. Success looks like learning Spanish. Confirm and I'll save it.";
		const refinedPreview =
			"I can save this as a goal. Success looks like holding a 10-minute Spanish conversation by December 1. Confirm and I'll save it.";
		const draftStep = (text: string, iteration: number) => ({
			iteration,
			toolCall: { id: `call-${iteration}`, name: "OWNER_GOALS", arguments: {} },
			result: {
				success: false as const,
				text,
				userFacingText: text,
				verifiedUserFacing: true,
				data: {
					requiresConfirmation: true,
					lifeDraft: {
						operation: "create_goal",
						request: { title: "Conversational Spanish" },
					},
				},
			},
		});
		const trajectory = trajectoryWith([
			draftStep(firstPreview, 0),
			draftStep(refinedPreview, 1),
		]);

		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBe(
			refinedPreview,
		);
	});

	it("lets a verified confirmation preview outrank a later motivational terminal reply", async () => {
		const preview =
			"I can save this as a goal. Success looks like holding a 10-minute Spanish conversation by December 1. Confirm and I'll save it.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "OWNER_GOALS",
							arguments: { action: "create", kind: "goal" },
						},
					],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: "What is motivating you to focus on cafe-style conversations?",
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false as const,
			text: preview,
			userFacingText: preview,
			verifiedUserFacing: true,
			data: {
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_goal",
					request: { title: "Conversational Spanish" },
				},
			},
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "Preview needs a terminal user reply.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				messageToUser:
					"I can save that; what is motivating you to focus on cafe-style conversations?",
				thought: "Done.",
			});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(preview);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it("relays confirmation-required action text even when the adapter omitted userFacingText", async () => {
		const preview =
			"I can save this as a goal. Success looks like four weekly 20-minute practice sessions leading to a 10-minute Spanish conversation by December 1. Confirm and I'll save it.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "OWNER_GOALS",
							arguments: { action: "create", kind: "goal" },
						},
					],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: "I drafted the goal based on your description. Want me to save it?",
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false as const,
			text: preview,
			data: {
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_goal",
					request: { title: "Conversational Spanish" },
				},
			},
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "Preview needs a terminal user reply.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				messageToUser:
					"I drafted the goal based on your description. Want me to save it?",
				thought: "Done.",
			});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(preview);
	});

	it("lets a confirmation-required preview outrank a later terminal REPLY tool call", async () => {
		const preview =
			"I can save this as a goal. Success looks like four weekly 20-minute practice sessions leading to a 10-minute Spanish conversation by December 1. Confirm and I'll save it.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "OWNER_GOALS",
							arguments: { action: "create", kind: "goal" },
						},
					],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-1",
							name: "REPLY",
							arguments: {
								text: "Sounds great. Should I create it with the details you mentioned?",
							},
						},
					],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false as const,
			text: preview,
			userFacingText: preview,
			verifiedUserFacing: true,
			data: {
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_goal",
					request: { title: "Conversational Spanish" },
				},
			},
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Preview needs a terminal user reply.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(preview);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});
});

describe("codingActionSummary — archived steps", () => {
	it("preserves execution order and deduplicates summaries across compaction", () => {
		const trajectory: PlannerTrajectory = {
			context: { id: "ctx" },
			archivedSteps: [
				{
					iteration: 0,
					result: { success: true, summary: "created the app" },
				},
			],
			steps: [
				{
					iteration: 1,
					result: { success: true, summary: "created the app" },
				},
				{
					iteration: 2,
					result: { success: true, summary: "ran the checks" },
				},
				{
					iteration: 3,
					result: { success: false, summary: "ignore this failure" },
				},
			],
			plannedQueue: [],
			evaluatorOutputs: [],
		};

		expect(codingActionSummary(trajectory)).toBe(
			"Done — Created the app; ran the checks.",
		);
	});
});

// A weak planner (gpt-oss-class) sometimes hallucinates its own TASKS spawn-arg
// object into messageToUser, leaking {"task":…,"agentType":"opencode",…} to the
// user instead of spawning + narrating the sub-agent's real result (battery #3).
// userSafeFinalMessage suppresses it via this structural shape detector.
describe("looksLikeSpawnEnvelopeJson — spawn-arg leak detector", () => {
	it("flags a leaked TASKS spawn-arg JSON object", () => {
		expect(
			looksLikeSpawnEnvelopeJson(
				'{"task":"Fetch the current Bitcoin price","agentType":"opencode","approvalPreset":"standard","brief":"webfetch coingecko"}',
			),
		).toBe(true);
	});

	it("flags the same envelope wrapped in a ```json fence", () => {
		expect(
			looksLikeSpawnEnvelopeJson(
				'```json\n{"task":"x","agentType":"codex","brief":"y"}\n```',
			),
		).toBe(true);
	});

	it("does NOT flag a real prose answer", () => {
		expect(
			looksLikeSpawnEnvelopeJson("The current price of bitcoin is $68,000."),
		).toBe(false);
	});

	it("does NOT flag a genuine JSON answer with non-spawn keys", () => {
		expect(
			looksLikeSpawnEnvelopeJson('{"favoriteColor":"teal","mood":"calm"}'),
		).toBe(false);
	});

	it("does NOT flag an object with only one spawn discriminator", () => {
		expect(looksLikeSpawnEnvelopeJson('{"task":"do a thing"}')).toBe(false);
	});

	it("does NOT flag non-object / unparseable text", () => {
		expect(looksLikeSpawnEnvelopeJson("[1,2,3]")).toBe(false);
		expect(looksLikeSpawnEnvelopeJson('{"task": broken')).toBe(false);
		expect(looksLikeSpawnEnvelopeJson("")).toBe(false);
	});
});

describe("looksLikeActionEnvelopeJson — planner fallback-envelope leak detector", () => {
	it("flags the documented plain-JSON planner fallback envelope", () => {
		expect(
			looksLikeActionEnvelopeJson(
				'{"action":"BROWSER","parameters":{"url":"https://example.com","subaction":"open"},"thought":"open the browser"}',
			),
		).toBe(true);
	});

	it("flags the envelope without a thought", () => {
		expect(
			looksLikeActionEnvelopeJson(
				'{"action":"VIEWS","parameters":{"view":"settings"}}',
			),
		).toBe(true);
	});

	it("flags the envelope wrapped in a ```json fence", () => {
		expect(
			looksLikeActionEnvelopeJson(
				'```json\n{"action":"WEB_SEARCH","parameters":{"query":"x"}}\n```',
			),
		).toBe(true);
	});

	it("does NOT flag a genuine JSON answer with foreign keys", () => {
		expect(
			looksLikeActionEnvelopeJson(
				'{"action":"proceed","parameters":{"a":1},"status":"done","summary":"…"}',
			),
		).toBe(false);
	});

	it("does NOT flag an action string without a parameters object", () => {
		expect(looksLikeActionEnvelopeJson('{"action":"approve"}')).toBe(false);
		expect(
			looksLikeActionEnvelopeJson('{"action":"approve","parameters":"yes"}'),
		).toBe(false);
	});

	it("does NOT flag prose or unparseable text", () => {
		expect(looksLikeActionEnvelopeJson("The action succeeded.")).toBe(false);
		expect(looksLikeActionEnvelopeJson('{"action": broken')).toBe(false);
		expect(looksLikeActionEnvelopeJson("")).toBe(false);
	});
});

/**
 * Verified tool output + grounded evaluator prose are complementary — both must
 * reach the user. Texts mirror the live regression: `df -h` through the
 * terminal action marked its clean stdout `verifiedUserFacing`, and the old
 * precedence returned only the mount table, silently discarding the
 * evaluator's actual answer.
 */
describe("planner-loop — verified tool text + evaluator prose combine", () => {
	const dfStdout =
		"Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       387G  366G   22G  95% /\ntmpfs            16G     0   16G   0% /dev/shm";
	const dfProse =
		"third check, still `/` at 95% — 366G used, 22G free. hasn't budged. say the word and i'll hunt the big offenders.";

	const makeHarness = (opts: {
		toolResult: Record<string, unknown>;
		messageToUser?: string;
	}) => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "TERMINAL_SHELL", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool ran; answering.",
						...(opts.messageToUser
							? { messageToUser: opts.messageToUser }
							: {}),
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => opts.toolResult);
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Tool ran; answering.",
			...(opts.messageToUser ? { messageToUser: opts.messageToUser } : {}),
		}));
		return { runtime, executeToolCall, evaluate };
	};

	it("delivers verified tool output AND the evaluator's grounded prose", async () => {
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: true,
				text: "Shell command completed: `df -h`\nExit code: 0",
				userFacingText: dfStdout,
				verifiedUserFacing: true,
			},
			messageToUser: dfProse,
		});
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.status).toBe("finished");
		const finalMessage = result.finalMessage ?? "";
		// The verbatim output survives (#7960) …
		expect(finalMessage).toContain(dfStdout);
		// … fenced as multiline command output …
		expect(finalMessage).toContain("```");
		// … and the evaluator's answer is no longer discarded.
		expect(finalMessage).toContain("hasn't budged");
	});

	it("does not append a success:false FINISH restatement to a verified turn-completing result (live: attachment double reply)", async () => {
		const toolText =
			"I couldn't generate a readable description for that image.";
		const restatement =
			"I couldn't read that image, so I have no description to give. If it still shows in the channel, try re-sending it or drop a screenshot as a file.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "ATTACHMENT", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: false,
						decision: "FINISH",
						thought: "The read failed.",
						messageToUser: restatement,
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "",
			userFacingText: toolText,
			verifiedUserFacing: true,
			turnComplete: true,
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "The read failed.",
			messageToUser: restatement,
		}));
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(toolText);
	});

	it("preserves an already-fenced multiline result without nesting fences", async () => {
		const alreadyFenced = `\`\`\`text\n${dfStdout}\n\`\`\``;
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: true,
				text: "Shell command completed: `df -h`\nExit code: 0",
				userFacingText: alreadyFenced,
				verifiedUserFacing: true,
			},
			messageToUser: dfProse,
		});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(`${alreadyFenced}\n\n${dfProse}`);
	});

	it("returns prose alone when it already embeds the verified text verbatim", async () => {
		const verified = "/home/example/.bun";
		const prose = `biggest offender is /home/example/.bun — 19G. want me to clear it?`;
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: true,
				text: "diag",
				userFacingText: verified,
				verifiedUserFacing: true,
			},
			messageToUser: prose,
		});
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.finalMessage).toBe(prose);
	});

	it("keeps the verified text alone when the prose adds nothing over it", async () => {
		const verified =
			"Root disk: 65% used, 138G available. Biggest cleanup candidate: /home/example/.bun (19G).";
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: true,
				text: "diag",
				userFacingText: verified,
				verifiedUserFacing: true,
			},
			// A pure fragment/restatement of the verified text.
			messageToUser: "Root disk: 65% used, 138G available.",
		});
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.finalMessage).toBe(verified);
	});

	it("keeps the verified text alone when the evaluator omits messageToUser", async () => {
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: true,
				text: "diag",
				userFacingText: dfStdout,
				verifiedUserFacing: true,
			},
		});
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.finalMessage).toBe(dfStdout);
	});

	it("never decorates a verified confirmation preview with evaluator prose", async () => {
		const preview =
			"About to delete 3 reminders. Reply yes to confirm or no to cancel.";
		const { runtime, executeToolCall, evaluate } = makeHarness({
			toolResult: {
				success: false,
				text: "diag",
				userFacingText: preview,
				verifiedUserFacing: true,
				data: { requiresConfirmation: true },
			},
			messageToUser: "i queued the delete — confirm when ready.",
		});
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});
		expect(result.finalMessage).toBe(preview);
	});
});

describe("latestToolResultText — failed-step diagnostics stay planner-facing", () => {
	const trajectoryWith = (
		steps: PlannerTrajectory["steps"],
	): PlannerTrajectory => ({
		context: { id: "ctx" },
		steps,
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	});

	// The live defect (tj-1a1dd4704d0293): a failed VIEWS interact carried its
	// catalog diagnostic as userFacingText and the FINISH fallback delivered it
	// verbatim when the evaluator supplied no messageToUser.
	it("skips a failed step's text unless it claimed failure authority", () => {
		const trajectory = trajectoryWith([
			{
				iteration: 0,
				toolCall: { id: "call-1", name: "VIEWS", arguments: {} },
				result: {
					success: false as const,
					text: 'Cannot invoke capability "get-todos" on view "automations".',
					userFacingText:
						'Cannot invoke capability "get-todos" on view "automations".',
				},
			},
		]);
		expect(latestToolResultText(trajectory)).toBeUndefined();
	});

	it("keeps a failed step's text when the tool claimed failure authority", () => {
		const owned =
			"That reminder no longer exists, so there is nothing to delete.";
		const trajectory = trajectoryWith([
			{
				iteration: 0,
				toolCall: { id: "call-1", name: "OWNER_REMINDERS", arguments: {} },
				result: {
					success: false as const,
					text: owned,
					userFacingText: owned,
					verifiedUserFacing: true,
				},
			},
		]);
		expect(latestToolResultText(trajectory)).toBe(owned);
	});

	it("falls back past a failed step to an earlier successful step's text", () => {
		const trajectory = trajectoryWith([
			{
				iteration: 0,
				toolCall: { id: "call-1", name: "CHECK", arguments: {} },
				result: {
					success: true as const,
					text: "raw",
					userFacingText: "Saved the goal.",
				},
			},
			{
				iteration: 1,
				toolCall: { id: "call-2", name: "VIEWS", arguments: {} },
				result: {
					success: false as const,
					text: "diag",
					userFacingText: "diag",
				},
			},
		]);
		expect(latestToolResultText(trajectory)).toBe("Saved the goal.");
	});
});
