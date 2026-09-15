/**
 * Exercises the real planner loop and evaluator with deterministic model
 * responses. Explicit pending work must survive an erroneous successful
 * FINISH without replaying settled actions or discarding the queued batch.
 */
import { describe, expect, it, vi } from "vitest";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../../streaming-context";
import { createUnavailableGroundedActionReply } from "../../types/action-reply";
import type { EffectReceipt } from "../../types/effects";
import { ModelType } from "../../types/model";
import {
	isUnsafeUserVisibleText,
	malformedCallSupersededBy,
	runPlannerLoop,
} from "../planner-loop";
import type {
	PlannerLoopParams,
	PlannerRuntime,
	PlannerToolResult,
	PlannerTrajectory,
} from "../planner-types";
import type { RecordedStage, TrajectoryRecorder } from "../trajectory-recorder";

function call(name: string, scope?: string, text?: string) {
	return {
		id: name.toLowerCase(),
		name,
		arguments: {
			...(scope ? { eliza_turn_scope: scope } : {}),
			...(text !== undefined ? { text } : {}),
		},
	};
}

/** An evaluator verdict that the recorded results do not yet satisfy the request. */
function continueWork(thought: string) {
	return JSON.stringify({ thought, success: false, decision: "CONTINUE" });
}

function finish(
	messageToUser: string,
	success = true,
	effectReceiptIds?: string[],
) {
	return JSON.stringify({
		thought: "Judge the complete recorded results.",
		success,
		decision: "FINISH",
		messageToUser,
		...(effectReceiptIds ? { effectReceiptIds } : {}),
	});
}

function harness(args: {
	plans: Array<string | { text: string; toolCalls: ReturnType<typeof call>[] }>;
	evaluations: Array<
		| string
		| {
				text: string;
				usage: { promptTokens: number; completionTokens: number };
		  }
	>;
	results?: PlannerToolResult[];
	intents?: string[];
	userMessage?: string;
	undeliveredDraft?: string;
	stageOnePlan?: {
		reply: string;
		replyEffectStatus: "none" | "non_applied" | "pending" | "applied";
		candidateActions?: string[];
	};
}) {
	let plannerIndex = 0;
	let evaluatorIndex = 0;
	let resultIndex = 0;
	const executed: string[] = [];
	const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
		const response =
			type === ModelType.ACTION_PLANNER
				? args.plans[plannerIndex++]
				: type === ModelType.RESPONSE_HANDLER
					? args.evaluations[evaluatorIndex++]
					: undefined;
		if (response === undefined) {
			throw new Error(
				`Unexpected model call ${String(type)} after ${useModel.mock.calls
					.map(([calledType]) => String(calledType))
					.join(",")}`,
			);
		}
		return response;
	});
	const executeToolCall = vi.fn(async (tool: { name: string }) => {
		executed.push(tool.name);
		return (
			args.results?.[resultIndex++] ?? {
				success: true,
				transcriptVisibility: "internal" as const,
				text: JSON.stringify({ operation: tool.name, completed: true }),
			}
		);
	});
	const run = (overrides: Partial<PlannerLoopParams> = {}) =>
		runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "compound-turn",
				events: [
					{
						id: "current-message",
						type: "message",
						source: "user",
						createdAt: 1,
						message: {
							role: "user",
							content:
								args.userMessage ?? "add gym session tuesday at 7am please",
						},
					},
					{
						id: "handler",
						type: "message_handler",
						...(args.stageOnePlan ? { source: "message-service" } : {}),
						metadata: {
							...(args.undeliveredDraft
								? { undeliveredDraft: { replyText: args.undeliveredDraft } }
								: {}),
							plan: {
								intents: args.intents ?? ["read record", "open destination"],
								...args.stageOnePlan,
							},
						},
					},
				],
			},
			config: { maxIterations: 6 },
			executeToolCall,
			...overrides,
		});
	return { run, useModel, executed };
}

describe("planner-declared pending work", () => {
	it.each(["STOP", "IGNORE", "NONE"])(
		"preserves explicit silent control %s after pending work",
		async (name) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{ text: "", toolCalls: [call(name)] },
				],
				evaluations: [continueWork("More work was pending.")],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ"]);
			expect(result.endedWithDeliberateSilence).toBe(true);
			expect(result.silentTerminalAction).toBe(
				name === "STOP" ? "STOP" : "IGNORE",
			);
		},
	);
	it("does not exempt executable calls mixed with silent controls", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("STOP"), call("UPDATE")] },
				{ text: "", toolCalls: [call("STOP")] },
			],
			evaluations: [continueWork("More work was pending.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ"]);
		expect(result.silentTerminalAction).toBe("STOP");
		expect(JSON.stringify(h.useModel.mock.calls[3])).toContain(
			"PLANNER_SCOPE_DECLARATION_REQUIRED",
		);
	});
	it("resets the consecutive protocol budget after a corrected independent batch", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("UPDATE")] },
				{ text: "", toolCalls: [call("UPDATE", "more_work_pending")] },
				{ text: "", toolCalls: [call("NOTIFY")] },
				{ text: "", toolCalls: [call("NOTIFY", "final")] },
			],
			evaluations: [
				continueWork("Update."),
				continueWork("Notify."),
				finish("Both operations finished."),
			],
		});
		const result = await h.run({ config: { maxRepeatedFailures: 2 } });
		expect(h.executed).toEqual(["READ", "UPDATE", "NOTIFY"]);
		expect(result.finalMessage).toBe("Both operations finished.");
		expect(result.terminalFailure).toBeUndefined();
	});
	it("repairs a missing native scope before executing the pending mutation", async () => {
		const completeArgument =
			"Copper record " +
			"complete argument boundary ".repeat(6000) +
			"ARGUMENT-END";
		const missing = {
			...call("UPDATE"),
			arguments: { value: completeArgument },
		};
		const repaired = {
			...missing,
			arguments: { ...missing.arguments, eliza_turn_scope: "final" as const },
		};
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [missing] },
				{ text: "", toolCalls: [repaired] },
			],
			evaluations: [
				continueWork("Update the returned record."),
				finish("The record is updated."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "UPDATE"]);
		expect(result.finalMessage).toBe("The record is updated.");
		const calls = h.useModel.mock.calls;
		expect(calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(JSON.stringify(calls[3]?.[1])).toContain(
			"PLANNER_SCOPE_DECLARATION_REQUIRED",
		);
		expect(JSON.stringify(calls[3]?.[1])).toContain(completeArgument);
	});

	it.each([undefined, "not-a-scope"])(
		"rejects an entire mixed batch with invalid scope %s before any call executes",
		async (invalidScope) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{
						text: "",
						toolCalls: [call("UPDATE", "final"), call("NOTIFY", invalidScope)],
					},
					{
						text: "",
						toolCalls: [call("UPDATE", "final"), call("NOTIFY", "final")],
					},
				],
				evaluations: [
					continueWork("Use the returned record."),
					JSON.stringify({
						success: false,
						decision: "NEXT_RECOMMENDED",
						thought: "The notification remains queued after the update.",
						recommendedToolCallId: "notify",
					}),
					finish("Updated and notified."),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ", "UPDATE", "NOTIFY"]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.finalMessage).toBe("Updated and notified.");
		},
	);
	it("fails with a typed scope error when invalid native declarations repeat", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("UPDATE")] },
				{ text: "", toolCalls: [call("UPDATE")] },
			],
			evaluations: [continueWork("Use the returned record.")],
		});
		const result = await h.run({ config: { maxRepeatedFailures: 2 } });
		expect(result.terminalFailure).toMatchObject({
			code: "PLANNER_SCOPE_DECLARATION_REQUIRED",
			transient: false,
		});
		expect(result.trajectory.steps.filter((step) => step.result)).toHaveLength(
			1,
		);
		expect(h.executed).toEqual(["READ"]);
	});
	it("preserves the JSON planner completion contract after native pending work", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				JSON.stringify({
					completed: true,
					toolCalls: [
						{ id: "update", name: "UPDATE", params: { id: "record-1" } },
					],
				}),
			],
			evaluations: [
				continueWork("Update the result."),
				finish("Updated the result."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "UPDATE"]);
		expect(result.finalMessage).toBe("Updated the result.");
	});
	it.each([
		undefined,
		"Review this unsaved draft:\nTitle: History header QA 20260912\nBody: Bring a green folder and a charger.",
	])(
		"preserves the proposed preview when completion omits a replacement (%s)",
		async (messageToUser) => {
			// Recorded live: step-1789215630238-928oz1. The evaluator approved
			// native REPLY without replacing it, but its thought reached the UI.
			// The existing Stage-1 draft now reaches that evaluation without planning.
			const preview =
				"Here's the draft, not saved:\n\nTitle: History header QA 20260912\nBody: Bring a green folder and a charger.\n\nTell me when to save it; the app stays where it is.";
			const thought =
				"The user only asked for a draft preview plus a confirmation gate, with no save and no view change. The terminal output shows the exact requested title and body, states it is unsaved, and keeps the app unchanged. There is no omitted referent or constraint, so the response completes the turn.";
			const h = harness({
				userMessage:
					"Show the draft and wait for my separate confirmation before saving anything. Keep the app where it is.",
				intents: [
					"Preview the requested note; save it only after a separate user confirmation",
				],
				stageOnePlan: {
					reply: preview,
					replyEffectStatus: "none",
					candidateActions: [],
				},
				plans: [],
				evaluations: [
					JSON.stringify({
						thought,
						success: true,
						decision: "FINISH",
						...(messageToUser !== undefined ? { messageToUser } : {}),
					}),
				],
			});
			const result = await h.run({
				tools: [{ name: "NOTES_CREATE" }, { name: "REPLY" }],
				requireNonTerminalToolCall: true,
				stageOneReplyText: preview,
			});
			expect(result.finalMessage).toBe(messageToUser ?? preview);
			expect(result.finalMessage).not.toContain(thought);
			expect(result.evaluator?.thought).toBe(thought);
			expect(result.evaluator?.messageToUser).toBe(messageToUser);
			expect(result.evaluator?.decision).toBe("FINISH");
			expect(h.executed).toEqual([]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.RESPONSE_HANDLER,
			]);
		},
	);

	it.each(
		(["none", "non_applied"] as const).flatMap((replyEffectStatus) =>
			[true, false].map((declaresIntent) => ({
				replyEffectStatus,
				declaresIntent,
			})),
		),
	)(
		"evaluates a proposed preview before forcing an action ($replyEffectStatus, declaresIntent=$declaresIntent)",
		async ({ replyEffectStatus, declaresIntent }) => {
			const preview =
				"Title: Preview QA\nBody: Wait for confirmation before saving.";
			const h = harness({
				userMessage:
					"Preview this note; wait for my separate confirmation before saving.",
				intents: declaresIntent ? ["preview note for approval"] : [],
				stageOnePlan: {
					reply: preview,
					replyEffectStatus,
					candidateActions: ["NOTES_CREATE"],
				},
				plans: [],
				evaluations: [finish(preview)],
			});
			const result = await h.run({
				tools: [{ name: "NOTES_CREATE" }, { name: "REPLY" }],
				requireNonTerminalToolCall: true,
				stageOneReplyText: preview,
			});
			expect(result.status).toBe("finished");
			expect(result.finalMessage).toBe(preview);
			expect(h.executed).toEqual([]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.trajectory.evaluatorOutputs).toHaveLength(1);
		},
	);

	it("still performs required work when an empty-intent draft fails completion", async () => {
		const h = harness({
			userMessage: "Read the current note before answering; do not change it.",
			intents: [],
			stageOnePlan: {
				reply: "I can answer about the note.",
				replyEffectStatus: "none",
				candidateActions: ["READ"],
			},
			plans: [{ text: "", toolCalls: [call("READ", "final")] }],
			evaluations: [
				continueWork("The request requires a current read, which has not run."),
				finish("The current note says to bring the purple folder."),
			],
		});
		const result = await h.run({
			tools: [{ name: "READ" }, { name: "REPLY" }],
			requireNonTerminalToolCall: true,
		});
		expect(h.executed).toEqual(["READ"]);
		expect(h.useModel.mock.calls[0][0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(result.trajectory.evaluatorOutputs[0].decision).toBe("CONTINUE");
		expect(result.finalMessage).toBe(
			"The current note says to bring the purple folder.",
		);
	});

	it.each([true, false])(
		"evaluates a planner confirmation pause even when Stage 1 incorrectly marked it pending (reply text: %s)",
		async (hasReplyText) => {
			const preview =
				"Title: Approval QA\nBody: Keep this unsaved until confirmation.";
			const h = harness({
				userMessage: "Prepare the note under my separate-confirmation rule.",
				intents: ["Create the note after a separate user confirmation"],
				undeliveredDraft: preview,
				stageOnePlan: {
					reply: "",
					replyEffectStatus: "pending",
					candidateActions: ["NOTES_CREATE"],
				},
				plans: [
					{
						text: "",
						toolCalls: [
							call("REPLY", "final", hasReplyText ? preview : undefined),
						],
					},
				],
				evaluations: [finish(preview)],
			});
			const result = await h.run({
				tools: [{ name: "NOTES_CREATE" }, { name: "REPLY" }],
				requireNonTerminalToolCall: true,
			});
			expect(h.executed).toEqual([]);
			expect(result.finalMessage).toBe(preview);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
		},
	);

	it.each(["none", "pending"] as const)(
		"continues required work when evaluation rejects a pre-tool answer (%s)",
		async (replyEffectStatus) => {
			const h = harness({
				userMessage:
					"Read the current note before answering; do not change it.",
				intents: ["read current note"],
				stageOnePlan: {
					reply: "I can answer about the note.",
					replyEffectStatus,
					candidateActions: ["READ"],
				},
				plans: [
					...(replyEffectStatus === "pending"
						? [
								{
									text: "",
									toolCalls: [
										call("REPLY", "final", "I can answer about the note."),
									],
								},
							]
						: []),
					{ text: "", toolCalls: [call("READ", "final")] },
				],
				evaluations: [
					continueWork("The user needs a current read; no read has run yet."),
					finish("The current note says to bring the purple folder."),
				],
			});
			const result = await h.run({
				tools: [{ name: "READ" }, { name: "REPLY" }],
				requireNonTerminalToolCall: true,
			});
			expect(result.status).toBe("finished");
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				...(replyEffectStatus === "pending" ? [ModelType.ACTION_PLANNER] : []),
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.trajectory.evaluatorOutputs.map((e) => e.decision)).toEqual(
				["CONTINUE", "FINISH"],
			);
		},
	);

	it.each(["pending", "applied", "none"] as const)(
		"keeps the required-tool gate for work claims or absent answers (%s)",
		async (replyEffectStatus) => {
			const h = harness({
				stageOnePlan: {
					reply: replyEffectStatus === "none" ? "" : "Requested work.",
					replyEffectStatus,
					candidateActions: ["READ"],
				},
				plans: [
					{ text: "", toolCalls: [call("REPLY", "final")] },
					{ text: "", toolCalls: [call("READ", "final")] },
				],
				evaluations: [finish("Read completed.")],
			});
			await h.run({
				tools: [{ name: "READ" }, { name: "REPLY" }],
				requireNonTerminalToolCall: true,
			});
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
		},
	);

	it.each([
		["read failure", { success: false, error: "Read denied" }],
		["requested evaluation", { turnComplete: false }],
		["visible result", { transcriptVisibility: undefined }],
		["unclassified result", { data: {} }],
		[
			"awaiting input",
			{ data: { readOnlyOperation: true, awaitingUserInput: true } },
		],
		[
			"confirmation",
			{ data: { readOnlyOperation: true, requiresConfirmation: true } },
		],
		[
			"nested input",
			{
				data: { readOnlyOperation: true, values: { awaitingUserInput: true } },
			},
		],
	] as const)("keeps intermediate evaluation for %s", async (_name, patch) => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
			evaluations: [],
			results: [
				{
					success: true,
					transcriptVisibility: "internal",
					data: { readOnlyOperation: true },
					...patch,
				},
			],
		});
		await expect(h.run()).rejects.toThrow(
			"Unexpected model call RESPONSE_HANDLER after ACTION_PLANNER,RESPONSE_HANDLER",
		);
		expect(h.executed).toEqual(["READ"]);
	});

	it.each(["final", undefined] as const)(
		"evaluates a settled read with %s scope",
		async (scope) => {
			const h = harness({
				plans: [{ text: "", toolCalls: [call("READ", scope)] }],
				evaluations: [finish("The note says green.")],
				results: [
					{
						success: true,
						transcriptVisibility: "internal",
						data: { readOnlyOperation: true },
					},
				],
			});
			expect((await h.run()).finalMessage).toBe("The note says green.");
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
		},
	);

	it("does not execute a queued action automatically after a pending read", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [
						call("READ", "more_work_pending"),
						call("WRITE", "more_work_pending"),
					],
				},
			],
			evaluations: [],
			results: [
				{
					success: true,
					transcriptVisibility: "internal",
					data: { readOnlyOperation: true },
				},
			],
		});
		await expect(h.run()).rejects.toThrow(
			"Unexpected model call RESPONSE_HANDLER after ACTION_PLANNER,RESPONSE_HANDLER",
		);
		expect(h.executed).toEqual(["READ"]);
	});

	it("does not replan a purported read carrying an effect receipt", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
			evaluations: [],
			results: [
				{
					success: true,
					transcriptVisibility: "internal",
					data: { readOnlyOperation: true },
					effectReceipts: [
						{
							receiptId: "read-effect",
							operation: "notes.read",
							resource: { kind: "note", id: "n" },
							artifacts: [],
							idempotency: { key: null, replayed: false },
							observedAt: "2026-09-12T07:00:00.000Z",
							outcome: "noop",
							reason: "Read snapshot",
						},
					],
				},
			],
		});
		await expect(h.run()).rejects.toThrow(
			"Unexpected model call RESPONSE_HANDLER after ACTION_PLANNER,RESPONSE_HANDLER",
		);
		expect(h.executed).toEqual(["READ"]);
	});

	it("replans a settled preparatory read without intermediate model evaluation", async () => {
		const body = "Bring a green folder and a charger.";
		const h = harness({
			userMessage:
				"Read the note. Open Calendar only if it contains green. Do not edit records.",
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [finish(`${body} Calendar is open.`)],
			results: [
				{
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					data: { readOnlyOperation: true, notes: [{ body }] },
				},
				{
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					data: { destination: "calendar" },
				},
			],
		});
		const stages: RecordedStage[] = [];
		const result = await h.run({
			recorder: {
				startTrajectory: () => "pending-read",
				recordStage: async (_id, stage) => {
					stages.push(stage);
				},
				endTrajectory: async () => undefined,
				load: async () => null,
				list: async () => [],
			},
			trajectoryId: "pending-read",
		});
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe(`${body} Calendar is open.`);
		const nextPlanner = h.useModel.mock.calls.filter(
			([type]) => type === ModelType.ACTION_PLANNER,
		)[1];
		expect(JSON.stringify(nextPlanner)).toContain(body);
		expect(JSON.stringify(nextPlanner)).toContain("Do not edit records.");
		expect(
			stages.some(
				(stage) =>
					stage.evaluation?.gated === true &&
					stage.evaluation.reason === "pending_read_replan" &&
					stage.evaluation.decision === "CONTINUE",
			),
		).toBe(true);
	});

	it.each(["final", "more_work_pending"] as const)(
		"preserves %s scope across discovery and an already queued domain read",
		async (scope) => {
			const h = harness({
				userMessage:
					"Load the Notes family and read today's Calendar, without changing the view.",
				plans: [
					{
						text: "",
						toolCalls: [call("DISCOVER_TOOLS", scope), call("READ", scope)],
					},
					...(scope === "more_work_pending"
						? [{ text: "", toolCalls: [call("REPLY", "final")] }]
						: []),
				],
				evaluations: [
					finish("The tools are loaded and today's calendar has no events."),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["DISCOVER_TOOLS", "READ"]);
			expect(
				h.useModel.mock.calls.filter(
					([type]) => type === ModelType.ACTION_PLANNER,
				),
			).toHaveLength(scope === "final" ? 1 : 2);
			expect(result.finalMessage).toBe(
				"The tools are loaded and today's calendar has no events.",
			);
			expect(result.trajectory.plannedQueue).toEqual([]);
		},
	);

	it.each(["final", undefined] as const)(
		"continues after final discovery and accepts the evaluator after a domain call with scope %s",
		async (domainScope) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("DISCOVER_TOOLS", "final")] },
					{ text: "", toolCalls: [call("READ", domainScope)] },
				],
				evaluations: [finish("The requested record was read.")],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["DISCOVER_TOOLS", "READ"]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.finalMessage).toBe("The requested record was read.");
		},
	);

	it("rejects an unscoped domain call after discovery before executing its scoped retry", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("DISCOVER_TOOLS", "more_work_pending")] },
				{ text: "", toolCalls: [call("READ")] },
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("REPLY", "final")] },
			],
			evaluations: [finish("The requested record was read.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["DISCOVER_TOOLS", "READ"]);
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.ACTION_PLANNER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
		]);
		expect(result.finalMessage).toBe("The requested record was read.");
	});

	it("finishes a consistently final multi-call batch without another planner round", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "final"), call("NAVIGATE", "final")],
				},
			],
			evaluations: [
				JSON.stringify({
					thought:
						"The requested read succeeded; the queued navigation remains.",
					success: false,
					decision: "NEXT_RECOMMENDED",
					recommendedToolCallId: "navigate",
				}),
				finish("The record was read and the destination is open."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(result.finalMessage).toBe(
			"The record was read and the destination is open.",
		);
		expect(result.trajectory.plannedQueue).toEqual([]);
	});

	it("keeps a conflicting batch pending until a later explicit final declaration", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [
						call("READ", "more_work_pending"),
						call("CHECK", "final"),
					],
				},
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only checked."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "CHECK", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
		expect(h.useModel).toHaveBeenCalledTimes(5);
		expect(result.trajectory.evaluatorOutputs.slice(0, 2)).toEqual([
			expect.objectContaining({ decision: "CONTINUE", success: false }),
			expect.objectContaining({ decision: "CONTINUE", success: false }),
		]);
	});

	it("replans after a successful FINISH that abandons the declared next operation", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("The record was read, but navigation was not performed."),
				finish("The record was read and the destination is open."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe(
			"The record was read and the destination is open.",
		);
		expect(h.useModel).toHaveBeenCalledTimes(4);
		const firstEvaluation = h.useModel.mock.calls.find(
			([type]) => type === ModelType.RESPONSE_HANDLER,
		)?.[1];
		expect(JSON.stringify(firstEvaluation?.messages)).toContain(
			"more_work_pending",
		);
		expect(
			result.trajectory.steps.filter((step) => step.toolCall),
		).toHaveLength(2);
		expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
			decision: "CONTINUE",
			success: false,
			raw: { decision: "FINISH", success: true },
		});
		expect(
			result.trajectory.evaluatorOutputs[0]?.messageToUser,
		).toBeUndefined();
	});

	it("delivers the rejected FINISH when the planner explicitly releases pending scope without replay", async () => {
		// Live 2026-09-05 (tj-9a419beee929da): a single calendar delete was
		// declared more_work_pending, the evaluator's correct FINISH was rejected,
		// and the replanned planner re-issued the same delete (a noop) before a
		// third planner call finally replied.
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("DELETE", "more_work_pending")] },
				{ text: "", toolCalls: [call("DELETE", "final")] },
			],
			evaluations: [finish("Deleted the 7am gym session on Tuesday.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["DELETE"]);
		expect(result.finalMessage).toBe("Deleted the 7am gym session on Tuesday.");
		expect(h.useModel).toHaveBeenCalledTimes(3);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
		});
	});

	it.each(["receipt", "read-only marker"] as const)(
		"re-observes a %s read after a rejected FINISH instead of reusing stale state",
		async (proof) => {
			const observation =
				proof === "receipt"
					? {
							effectReceipts: [
								{
									receiptId: "observed-list",
									operation: "items.list",
									resource: { kind: "items", id: "owner-items" },
									artifacts: [],
									idempotency: { key: null, replayed: false },
									observedAt: "2026-09-06T00:00:00.000Z",
									outcome: "noop" as const,
									reason: "Read the current collection.",
								},
							],
						}
					: { data: { readOnlyOperation: true } };
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{ text: "", toolCalls: [call("READ", "final")] },
				],
				evaluations: [
					finish("The collection is empty."),
					finish("The new item is present."),
				],
				intents: ["inspect the current collection twice"],
				userMessage:
					"Inspect the collection again after the other writer finishes.",
			});
			let reads = 0;
			const result = await h.run({
				executeToolCall: async () => ({
					success: true,
					text: ++reads === 1 ? "[]" : '["new-item"]',
					...observation,
				}),
			});
			expect(reads).toBe(2);
			expect(result.finalMessage).toBe("The new item is present.");
			expect(
				result.trajectory.steps.filter((step) => step.toolCall),
			).toHaveLength(2);
		},
	);

	it.each(["more_work_pending", undefined] as const)(
		"does not finish an incomplete compound request when a repeated action has scope %s",
		async (scope) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("DELETE", "more_work_pending")] },
					{ text: "", toolCalls: [call("DELETE", scope)] },
					{ text: "", toolCalls: [call("NAVIGATE", "final")] },
				],
				evaluations: [
					finish("Only deleted."),
					finish("Deleted and opened the destination."),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["DELETE", "NAVIGATE"]);
			expect(result.finalMessage).toBe("Deleted and opened the destination.");
			expect(h.useModel).toHaveBeenCalledTimes(5);
		},
	);

	it("adopts the sub-planner evaluator's FINISH for an umbrella result instead of evaluating again", async () => {
		// Live 2026-09-05 (tj-b2756267002022): umbrella CALENDAR → sub-planner →
		// child evaluator FINISH → umbrella step settled → a second evaluation ran
		// over the same results (11.1 s vs 3.3 s for the direct child call).
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: {
						decision: "FINISH" as const,
						success: true,
						messageToUser: "Deleted the gym session on Tuesday at 7am.",
					},
				},
			],
			intents: ["delete the gym session on tuesday"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(result.finalMessage).toBe(
			"Deleted the gym session on Tuesday at 7am.",
		);
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(0);
	});

	it("does not let a child FINISH close a parent that declared more_work_pending", async () => {
		// The umbrella step succeeded and its child evaluator said FINISH, but
		// the planner marked the batch more_work_pending: the dependent NOTES
		// step still has to run. The child verdict is not adopted; the model
		// evaluator's FINISH goes through the pending-scope correction once and
		// the loop replans.
		const childFinish = {
			success: true,
			text: "OK CALENDAR_DELETE_EVENT",
			transcriptVisibility: "internal" as const,
			subPlannerEvaluation: {
				decision: "FINISH" as const,
				success: true,
				messageToUser: "Deleted the gym session on Tuesday at 7am.",
			},
		};
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
				{ text: "", toolCalls: [call("NOTES", "final")] },
			],
			evaluations: [
				finish("Deleted the gym session on Tuesday at 7am."),
				finish("Deleted the gym session and noted it."),
			],
			results: [
				childFinish,
				{
					success: true,
					text: "OK NOTES",
					transcriptVisibility: "internal" as const,
				},
			],
			intents: ["delete the gym session and note it"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "NOTES"]);
		expect(result.finalMessage).toBe("Deleted the gym session and noted it.");
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(2);
	});

	it("still runs the intent evaluation when Stage-1 declared more than one intent", async () => {
		// The child verdict covers the delegated calendar operation only; the
		// second declared intent is reconciled by the model evaluator.
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish(
					"Deleted the gym session; I could not open the destination.",
					false,
				),
			],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: {
						decision: "FINISH" as const,
						success: true,
						messageToUser: "Deleted the gym session on Tuesday at 7am.",
					},
				},
			],
		});
		const result = await h.run();
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(1);
		expect(result.finalMessage).toBe(
			"Deleted the gym session; I could not open the destination.",
		);
	});

	it("still evaluates when the sub-planner verdict was not a successful FINISH", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish("Nothing was deleted; the event was not found.", false),
			],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: { decision: "FINISH" as const, success: false },
				},
			],
		});
		await h.run();
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(1);
	});

	it("preserves the queued batch after rejecting a premature successful FINISH", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "more_work_pending"), call("CHECK")],
				},
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only checked."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "CHECK", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.ACTION_PLANNER,
			),
		).toHaveLength(2);
	});

	it("does not erase pending scope when a later unscoped text reply omits it", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				JSON.stringify({
					messageToUser: "Only the read is complete.",
					toolCalls: [],
				}),
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only read."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
	});

	it("allows an explicit completed:true model reply to release pending authority", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				JSON.stringify({
					completed: true,
					messageToUser: "No further operation is needed.",
					toolCalls: [],
				}),
			],
			evaluations: [
				finish("Only read."),
				finish("No further operation is needed."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ"]);
		expect(h.useModel).toHaveBeenCalledTimes(4);
		expect(result.finalMessage).toBe("No further operation is needed.");
	});

	it("does not let an unscoped native REPLY erase previously pending work", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "Only read.", toolCalls: [call("REPLY")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [finish("Only read."), finish("All done.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
	});

	it.each(["REPLY", "STOP", "IGNORE"])(
		"preserves an explicit final %s",
		async (name) => {
			const terminal = call(name, "final");
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{
						text: "The remaining operation is unavailable.",
						toolCalls: [terminal],
					},
				],
				evaluations: [
					finish("Only read."),
					...(name === "REPLY"
						? [finish("The remaining operation is unavailable.", false)]
						: []),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(name === "REPLY" ? 4 : 3);
			expect(result.status).toBe("finished");
			if (name === "REPLY")
				expect(result.finalMessage).toBe(
					"The remaining operation is unavailable.",
				);
			else expect(result.finalMessage).toBeUndefined();
		},
	);

	it.each([
		{
			label: "owner confirmation",
			result: { success: true, data: { requiresConfirmation: true } },
		},
		{
			label: "missing user input",
			result: { success: true, data: { values: { awaitingUserInput: true } } },
		},
		{
			label: "failed operation",
			result: { success: false, error: "Unavailable" },
		},
	])(
		"preserves $label as a stopped outcome",
		async ({ result: toolResult }) => {
			const h = harness({
				plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
				evaluations: [
					finish("A prerequisite prevents the remaining operation.", false),
				],
				results: [toolResult],
			});
			const result = await h.run();
			expect(result.status).toBe("finished");
			expect(result.evaluator?.success).toBe(false);
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it("allows a model-declared unavailable outcome without retrying a successful read", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
			evaluations: [
				finish("The requested destination is not available.", false),
			],
		});
		const result = await h.run();
		expect(result.evaluator?.success).toBe(false);
		expect(result.finalMessage).toBe(
			"The requested destination is not available.",
		);
		expect(h.useModel).toHaveBeenCalledTimes(2);
	});

	it.each([
		{
			label: "owner confirmation",
			success: true,
			data: { requiresConfirmation: true },
		},
		{
			label: "missing input",
			success: true,
			data: { values: { awaitingUserInput: true } },
		},
		{ label: "failed operation", success: false, data: {} },
	])(
		"corrects erroneous successful FINISH over $label without retrying",
		async ({ success, data }) => {
			const blockerText =
				"The operation requires owner input before it can proceed.";
			const h = harness({
				plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
				evaluations: [finish("Everything is complete.")],
				results: [
					{
						success,
						data,
						userFacingText: blockerText,
						verifiedUserFacing: true,
						turnComplete: true,
					},
				],
			});
			const result = await h.run();
			expect(result.evaluator).toMatchObject({
				decision: "FINISH",
				success: false,
				raw: { decision: "FINISH", success: true },
			});
			expect(result.finalMessage).toBe(blockerText);
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		{
			continueChain: false,
			userFacingText: "The action stopped.",
			verifiedUserFacing: true,
		},
		{
			replyFailure: createUnavailableGroundedActionReply({
				kind: "provider_issue",
				code: "REPLY_UNAVAILABLE",
			}).failure,
		},
	])("preserves action-owned terminal boundaries", async (boundary) => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "more_work_pending"), call("LATER")],
				},
			],
			evaluations: [],
			results: [{ success: true, ...boundary }],
		});
		const result = await h.run();
		expect(result.status).toBe("finished");
		expect(h.executed).toEqual(["READ"]);
		expect(h.useModel).toHaveBeenCalledTimes(1);
		expect(result.trajectory.plannedQueue.map((tool) => tool.name)).toEqual([
			"LATER",
		]);
	});
});

describe("canonical evaluation of grounded internal receipts", () => {
	const appliedReceipt: EffectReceipt = {
		receiptId: "calendar-receipt-1",
		operation: "calendar.event.create",
		resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:00.000Z",
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "evt-1",
			committedAt: "2026-09-05T18:00:00.000Z",
		},
	};
	const readNoopReceipt: EffectReceipt = {
		receiptId: "calendar-read-receipt-1",
		operation: "calendar.event.search",
		resource: { kind: "calendar.feed", id: "feed-1", version: "v1" },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:00.000Z",
		outcome: "noop",
		reason:
			"The operation read an authoritative calendar snapshot without changing it.",
	};
	const mutationNoopReceipt: EffectReceipt = {
		...readNoopReceipt,
		receiptId: "calendar-noop-receipt-1",
		operation: "calendar.event.delete",
		reason: "No matching event.",
	};
	const rolledBackReceipt: EffectReceipt = {
		receiptId: "calendar-rollback-1",
		operation: "calendar.event.create",
		resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:01.000Z",
		outcome: "rolled_back",
		rollback: {
			receiptId: "calendar-rollback-1",
			revertedReceiptIds: ["calendar-receipt-1"],
			rolledBackAt: "2026-09-05T18:00:01.000Z",
		},
	};
	const internalCalendarResult = (
		receipts: EffectReceipt[] = [appliedReceipt],
		overrides: Partial<PlannerToolResult> = {},
	): PlannerToolResult => ({
		success: true,
		transcriptVisibility: "internal",
		effectReceipts: receipts,
		data: {
			replyContext: {
				domain: "calendar",
				intent: "add gym session tuesday at 7am to my calendar",
				scenario: "create_event_completed",
				facts: "Created “Gym session” for Sep 8, 7:00 AM PDT.",
			},
		},
		...overrides,
	});
	const modelCalls = (h: ReturnType<typeof harness>, type: string) =>
		h.useModel.mock.calls.filter(([calledType]) => calledType === type).length;
	const evaluationPromptOf = (h: ReturnType<typeof harness>) => {
		const request = h.useModel.mock.calls.find(
			([t]) => t === ModelType.RESPONSE_HANDLER,
		)?.[1];
		return JSON.stringify(request?.messages);
	};

	it.each([
		{ mixedBatch: false, replyCount: 1 },
		{ mixedBatch: true, replyCount: 1 },
		{ mixedBatch: false, replyCount: 2 },
		{ mixedBatch: true, replyCount: 2 },
	])(
		"reuses the verified evaluator reply for scope-only REPLY %j",
		async ({ mixedBatch, replyCount }) => {
			const reply = "Tu sesión de gimnasio está en el calendario.";
			const response = finish(reply, true, [appliedReceipt.receiptId]);
			const usage = { promptTokens: 1400, completionTokens: 84 };
			const h = harness({
				plans: [
					{
						text: "",
						toolCalls: [
							call("CALENDAR", "more_work_pending"),
							...(mixedBatch ? [call("NAVIGATE", "final")] : []),
						],
					},
					{
						text: "",
						toolCalls: Array.from({ length: replyCount }, (_, index) => ({
							...call("REPLY", "final"),
							id: `reply-${index}`,
						})),
					},
				],
				evaluations: [
					...(mixedBatch
						? [
								JSON.stringify({
									thought: "The queued navigation remains.",
									success: false,
									decision: "NEXT_RECOMMENDED",
									recommendedToolCallId: "navigate",
								}),
							]
						: []),
					{ text: response, usage },
				],
				results: [internalCalendarResult()],
				intents: ["add gym session to calendar"],
			});
			const onModelUsage = vi.fn();
			const onEvaluation = vi.fn();
			const messageToUser = vi.fn();
			const result = await runWithStreamingContext({ onEvaluation }, () =>
				h.run({ onModelUsage, evaluatorEffects: { messageToUser } }),
			);
			expect(h.executed).toEqual([
				"CALENDAR",
				...(mixedBatch ? ["NAVIGATE"] : []),
			]);
			expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
				...(mixedBatch ? [ModelType.RESPONSE_HANDLER] : []),
				ModelType.ACTION_PLANNER,
			]);
			expect(result.finalMessage).toBe(reply);
			// The final-scope planner must see the actual verified answer before
			// deciding to reuse it; a CONTINUE event drops messageToUser.
			const releaseCall = h.useModel.mock.calls.at(-1)?.[1];
			expect(JSON.stringify(releaseCall?.messages)).toContain(reply);
			expect(result.evaluator).toMatchObject({
				decision: "FINISH",
				success: true,
				effectReceiptIds: [appliedReceipt.receiptId],
				raw: { messageToUser: reply },
			});
			expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(usage);
			expect(onEvaluation).toHaveBeenCalledTimes(mixedBatch ? 2 : 1);
			expect(messageToUser).toHaveBeenCalledExactlyOnceWith(reply);
		},
	);

	it("does not treat native prose around an empty scope-release REPLY as a new answer", async () => {
		const reply = "The calendar event is saved.";
		const nativeProse =
			"The evaluator reply already covers everything; no operation remains. Returning REPLY with final scope and no text.";
		const release = {
			...call("REPLY", "final"),
			arguments: { eliza_turn_scope: "final", text: "" },
		};
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
				{ text: nativeProse, toolCalls: [release] },
			],
			evaluations: [finish(reply, true, [appliedReceipt.receiptId])],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run({
			requireNonTerminalToolCall: true,
			tools: [{ name: "CALENDAR" }, { name: "REPLY" }],
		});
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(2);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		const plannerRequests = h.useModel.mock.calls
			.filter(([type]) => type === ModelType.ACTION_PLANNER)
			.map(([, params]) => params);
		expect(plannerRequests.map((params) => params.toolChoice)).toEqual([
			"required",
			"required",
		]);
		expect(plannerRequests[1].tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "REPLY" })]),
		);
		expect(result.finalMessage).toBe(reply);
		expect(result.finalMessage).not.toContain(nativeProse);
		expect(result.evaluator?.effectReceiptIds).toEqual([
			appliedReceipt.receiptId,
		]);
	});

	it.each([
		"reply-argument",
		"json-message",
		"json-text",
		"native-control",
	] as const)(
		"evaluates a new structured answer instead of treating %s as empty scope release",
		async (format) => {
			const candidate = "The event is saved for Tuesday.";
			const verified = "The calendar event is saved for Tuesday at 7am.";
			const replyCall = {
				...call("REPLY", "final"),
				arguments: {
					eliza_turn_scope: "final",
					text: format === "reply-argument" ? candidate : "",
				},
			};
			const envelope = {
				completed: true,
				[format === "json-text" ? "text" : "messageToUser"]: candidate,
				toolCalls: [replyCall],
			};
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
					format === "json-message" || format === "json-text"
						? JSON.stringify(envelope)
						: {
								text:
									format === "native-control" ? JSON.stringify(envelope) : "",
								toolCalls: [replyCall],
							},
				],
				evaluations: [
					finish("The calendar event is saved.", true, [
						appliedReceipt.receiptId,
					]),
					finish(verified, true, [appliedReceipt.receiptId]),
				],
				results: [internalCalendarResult()],
				intents: ["add gym session to calendar"],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["CALENDAR"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
			expect(result.finalMessage).toBe(verified);
		},
	);

	it("retries an unscoped empty REPLY without reevaluating unchanged evidence", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("REPLY")] },
				{ text: "", toolCalls: [call("REPLY", "final")] },
			],
			evaluations: [finish("The recorded read is complete.")],
			intents: ["read record"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ"]);
		expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(3);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(result.finalMessage).toBe("The recorded read is complete.");
	});

	it.each([false, true])(
		"does not reuse a rejected FINISH after context changes (rejected scope retry: %s)",
		async (rejectFirst) => {
			let activeTrajectory: PlannerTrajectory | undefined;
			let contextChanged = false;
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
					...(rejectFirst ? [{ text: "", toolCalls: [call("REPLY")] }] : []),
					{ text: "", toolCalls: [call("REPLY", "final")] },
				],
				evaluations: [
					finish("Your gym session is in the calendar.", true, [
						appliedReceipt.receiptId,
					]),
					finish("The event is saved; I need to check the new request.", false),
				],
				intents: ["add gym session to calendar"],
			});
			const model = h.useModel.getMockImplementation();
			if (!model) throw new Error("Missing deterministic model adapter");
			h.useModel.mockImplementation(async (...args) => {
				if (
					args[0] === ModelType.ACTION_PLANNER &&
					activeTrajectory &&
					!contextChanged
				) {
					contextChanged = true;
					activeTrajectory.context = {
						...activeTrajectory.context,
						events: [
							...activeTrajectory.context.events,
							{
								id: "new-input",
								type: "message",
								message: { role: "user", content: "Wait, one more thing." },
							},
						],
					};
				}
				return model(...args);
			});
			const result = await h.run({
				executeToolCall: (_call, { trajectory }) => {
					activeTrajectory = trajectory;
					return internalCalendarResult();
				},
			});
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
			expect(result.finalMessage).toBe(
				"The event is saved; I need to check the new request.",
			);
		},
	);

	it.each(["more_work_pending", undefined] as const)(
		"does not reuse a rejected FINISH for REPLY with scope %s",
		async (scope) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{ text: "", toolCalls: [call("REPLY", scope)] },
					{ text: "", toolCalls: [call("NAVIGATE", "final")] },
				],
				evaluations: [
					finish("The record was read."),
					finish("The record was read and the destination is open."),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ", "NAVIGATE"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
			expect(result.finalMessage).toBe(
				"The record was read and the destination is open.",
			);
		},
	);

	it.each([true, false])(
		"does not reuse an old FINISH after queued work executes with success=%s",
		async (success) => {
			const finalReply = success
				? "The record was read and updated."
				: "The record was read, but the update failed.";
			const h = harness({
				plans: [
					{
						text: "",
						toolCalls: [
							call("READ", "more_work_pending"),
							call("UPDATE", "more_work_pending"),
						],
					},
					{ text: "", toolCalls: [call("REPLY", "final")] },
				],
				evaluations: [
					finish("Only the record was read."),
					continueWork("The changed result needs a final response."),
					finish(finalReply, success),
				],
				results: [
					{ success: true, text: "Read the record." },
					{
						success,
						text: success ? "Updated the record." : "Update failed.",
						...(success ? {} : { error: "WRITE_FAILED" }),
					},
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ", "UPDATE"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(3);
			expect(result.evaluator?.success).toBe(success);
			expect(result.finalMessage).toBe(finalReply);
		},
	);

	it("does not reuse a rejected FINISH when the next planner requests new work", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only the record was read."),
				finish("The record was read and the destination is open."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
		expect(result.finalMessage).toBe(
			"The record was read and the destination is open.",
		);
	});

	it("preserves prior-turn preferences and character in one canonical receipt evaluation", async () => {
		const preference =
			"Use Spanish for the next calendar confirmation only; do not save that preference.";
		const character = "You are Eliza, a warm conversational teammate.";
		const system = "Respect the current conversation and authorized evidence.";
		const retainedContext = `${"Authorized calendar detail. ".repeat(200)}Complete context end.`;
		const reply = "Añadí tu sesión de gimnasio para el martes a las siete.";
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish(reply)],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run({
			context: {
				id: "continuous-calendar-conversation",
				staticPrefix: {
					systemPrompt: { content: system, stable: true },
					characterPrompt: { content: character, stable: true },
				},
				events: [
					{
						id: "conversation",
						type: "provider",
						name: "RECENT_MESSAGES",
						text: `User: ${preference}\nAssistant: Entendido.`,
					},
					{
						id: "authorized-calendar-context",
						type: "provider",
						name: "CALENDAR",
						text: retainedContext,
					},
					{
						id: "current-message",
						type: "message",
						message: {
							role: "user",
							content: "add gym session tuesday at 7am please",
						},
					},
					{
						id: "handler",
						type: "message_handler",
						metadata: { plan: { intents: ["add gym session to calendar"] } },
					},
				],
			},
		});
		const finalCalls = h.useModel.mock.calls.filter(
			([type]) => type !== ModelType.ACTION_PLANNER,
		);
		expect(finalCalls).toHaveLength(1);
		const request = finalCalls[0][1] as {
			messages: Array<{ role: string; content: unknown }>;
			maxTokens?: number;
		};
		const prompt = JSON.stringify(request.messages);
		expect(prompt).toContain(preference);
		expect(prompt).toContain(character);
		expect(prompt).toContain(system);
		expect(prompt).toContain(retainedContext);
		expect(prompt).toContain(appliedReceipt.receiptId);
		expect(prompt).toContain("Created “Gym session” for Sep 8, 7:00 AM PDT.");
		expect(request.messages.map(({ role }) => role)).toContain("tool");
		expect(request.maxTokens).toBeUndefined();
		expect(finalCalls[0][0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(result.finalMessage).toBe(reply);
	});

	it("honors the custom evaluator after a committed internal action", async () => {
		const messageToUser = "Tu sesión de gimnasio está en el calendario.";
		const evaluate = vi.fn<NonNullable<PlannerLoopParams["evaluate"]>>(
			async () => ({
				success: true,
				decision: "FINISH",
				thought: "The captured create settled the requested change.",
				messageToUser,
				effectReceiptIds: [appliedReceipt.receiptId],
				raw: { messageToUser },
			}),
		);
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run({ evaluate });
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate.mock.calls[0][0].trajectory.steps[0].result).toMatchObject({
			effectReceipts: [appliedReceipt],
		});
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
		]);
		expect(result.finalMessage).toBe(messageToUser);
		expect(result.evaluator?.raw?.messageToUser).toBe(messageToUser);
	});

	it("reports receipt evaluation usage and structured stream output without leaking raw model chunks", async () => {
		const reply = "Added your gym session for Tuesday at 7am.";
		const usage = { promptTokens: 1400, completionTokens: 84 };
		const response = finish(reply, true, [appliedReceipt.receiptId]);
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [{ text: response, usage }],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const model = h.useModel.getMockImplementation();
		if (!model) throw new Error("Missing deterministic model adapter");
		h.useModel.mockImplementation(async (...args) => {
			if (args[0] !== ModelType.ACTION_PLANNER) {
				await getStreamingContext()?.onStreamChunk?.(response);
			}
			return model(...args);
		});
		const onEvaluation = vi.fn();
		const onStreamChunk = vi.fn();
		const onModelUsage = vi.fn();
		const messageToUser = vi.fn();
		const stages: RecordedStage[] = [];
		const recorder: TrajectoryRecorder = {
			startTrajectory: () => "receipt-conversation",
			recordStage: async (_id, stage) => {
				stages.push(stage);
			},
			endTrajectory: async () => undefined,
			load: async () => null,
			list: async () => [],
		};
		const result = await runWithStreamingContext(
			{ onEvaluation, onStreamChunk },
			() =>
				h.run({
					onModelUsage,
					evaluatorEffects: { messageToUser },
					recorder,
					trajectoryId: "receipt-conversation",
				}),
		);
		expect(onStreamChunk).not.toHaveBeenCalled();
		expect(onEvaluation).toHaveBeenCalledTimes(1);
		expect(onEvaluation.mock.calls[0][0].evaluation).toMatchObject({
			messageToUser: reply,
			effectReceiptIds: [appliedReceipt.receiptId],
		});
		expect(messageToUser).toHaveBeenCalledExactlyOnceWith(reply);
		expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(usage);
		expect(result.modelUsage).toEqual({ ...usage, modelCalls: 1 });
		const evaluationStages = stages.filter(({ kind }) => kind === "evaluation");
		expect(evaluationStages).toHaveLength(1);
		expect(evaluationStages[0].model).toMatchObject({
			modelType: ModelType.RESPONSE_HANDLER,
			response,
			usage,
		});
		expect(result.finalMessage).toBe(reply);
	});

	it("carries the evaluator's committed receipt selection and exact original prose", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish("Added your gym session for Tuesday at 7:00 AM.", true, [
					appliedReceipt.receiptId,
				]),
			],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(result.finalMessage).toBe(
			"Added your gym session for Tuesday at 7:00 AM.",
		);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
			effectReceiptIds: ["calendar-receipt-1"],
			raw: {
				messageToUser: "Added your gym session for Tuesday at 7:00 AM.",
			},
		});
		const prompt = evaluationPromptOf(h);
		expect(prompt).toContain("Created “Gym session” for Sep 8, 7:00 AM PDT.");
		expect(prompt).toContain("add gym session tuesday at 7am please");
		expect(prompt).toContain("add gym session to calendar");
	});

	it("evaluates a read whose receipt is a plain no-op without claiming a side effect", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("You have a gym session on Tuesday at 7:00 AM.")],
			results: [
				internalCalendarResult([readNoopReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "whats on my calendar tuesday?",
							scenario: "search_events",
							facts:
								"Your matching calendar event is Gym session (Sep 8, 7:00 AM).",
						},
					},
				}),
			],
			intents: ["list calendar events for tuesday"],
		});
		const result = await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(result.evaluator?.effectReceiptIds).toBeUndefined();
	});

	it("keeps the full evaluator when the action set turnComplete:false", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("Added your gym session for Tuesday at 7am.")],
			results: [
				internalCalendarResult([appliedReceipt], { turnComplete: false }),
			],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a mutation only produced a non-replayed no-op", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("I couldn't find that event.", false)],
			results: [internalCalendarResult([mutationNoopReceipt])],
			intents: ["delete the gym session"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a receipt was rolled back", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("The event was rolled back.", false)],
			results: [internalCalendarResult([appliedReceipt, rolledBackReceipt])],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when Stage-1 declared more than one intent", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish("Added the gym session; the note is still pending.", false),
			],
			results: [internalCalendarResult()],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a receipt failed", async () => {
		const failed: EffectReceipt = {
			receiptId: "calendar-failed-1",
			operation: "calendar.event.create",
			resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
			artifacts: [],
			idempotency: { key: null, replayed: false },
			observedAt: "2026-09-05T18:00:00.000Z",
			outcome: "failed",
			failure: {
				code: "CALENDAR_SERVICE_400",
				retryable: false,
				acceptance: "unknown",
			},
		};
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("The calendar rejected the event.", false)],
			results: [internalCalendarResult([failed])],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator while the planner declared more_work_pending", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
				{ text: "", toolCalls: [call("NOTES", "final")] },
			],
			evaluations: [finish("Added it."), finish("Added it and noted it.")],
			results: [
				internalCalendarResult(),
				{
					success: true,
					text: "OK NOTES",
					transcriptVisibility: "internal" as const,
				},
			],
			intents: ["add gym session and note it"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "NOTES"]);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(result.finalMessage).toBe("Added it and noted it.");
	});

	const deliveredNavigation = {
		effect: "view_navigation",
		status: "delivered",
		viewId: "notes",
		label: "Notes",
		path: "/notes",
		stepId: "notes-step",
		handoffId: "navigation-handoff",
	};
	const navigationResult: PlannerToolResult = {
		success: true,
		transcriptVisibility: "internal",
		modelReplyRequired: true,
		turnComplete: false,
		data: { navigation: deliveredNavigation },
	};
	const navigationCall = {
		...call("VIEWS_SHOW", "final"),
		arguments: {
			eliza_turn_scope: "final",
			view: "notes",
			navigationStepId: "notes-step",
		},
	};

	it.each([true, false])(
		"advances a delivered navigation to its queued read and still evaluates the whole outcome (read success=%s)",
		async (readSuccess) => {
			const h = harness({
				userMessage:
					"Open Notes and read Seeker QA1914 without changing any records.",
				plans: [
					{
						text: "",
						toolCalls: [navigationCall, call("NOTES_LIST", "final")],
					},
				],
				results: [
					navigationResult,
					{
						success: readSuccess,
						transcriptVisibility: "internal",
						modelReplyRequired: true,
						data: {
							note: readSuccess ? "Bring a green folder and a charger." : null,
						},
						...(readSuccess ? {} : { error: "Note store unavailable" }),
					},
				],
				evaluations: [
					finish(
						readSuccess
							? "Notes is open. Bring a green folder and a charger."
							: "Notes opened, but the note read failed.",
						readSuccess,
					),
				],
				intents: ["open Notes", "read Seeker QA1914"],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["VIEWS_SHOW", "NOTES_LIST"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
			expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
				decision: "NEXT_RECOMMENDED",
			});
			const prompt = evaluationPromptOf(h);
			expect(prompt).toContain("navigation-handoff");
			expect(prompt).toContain("read Seeker QA1914");
			expect(prompt).toContain(
				readSuccess
					? "Bring a green folder and a charger."
					: "Note store unavailable",
			);
			expect(result.evaluator?.success).toBe(readSuccess);
		},
	);

	it.each([
		[
			"accepted only",
			{
				...navigationResult,
				data: { navigation: { ...deliveredNavigation, status: "accepted" } },
			},
		],
		[
			"wrong destination",
			{
				...navigationResult,
				data: {
					navigation: {
						...deliveredNavigation,
						viewId: "calendar",
						label: "Calendar",
					},
				},
			},
		],
		[
			"wrong step",
			{
				...navigationResult,
				data: { navigation: { ...deliveredNavigation, stepId: "other-step" } },
			},
		],
		[
			"missing handoff",
			{
				...navigationResult,
				data: { navigation: { ...deliveredNavigation, handoffId: "" } },
			},
		],
		[
			"missing path",
			{
				...navigationResult,
				data: { navigation: { ...deliveredNavigation, path: "" } },
			},
		],
		["failed navigation", { ...navigationResult, success: false }],
		[
			"awaiting input",
			{
				...navigationResult,
				data: { navigation: deliveredNavigation, awaitingUserInput: true },
			},
		],
		[
			"awaiting confirmation",
			{
				...navigationResult,
				data: { navigation: deliveredNavigation, requiresConfirmation: true },
			},
		],
	] as const)(
		"evaluates %s before executing another queued action",
		async (_name, firstResult) => {
			const h = harness({
				plans: [
					{
						text: "",
						toolCalls: [navigationCall, call("NOTES_LIST", "final")],
					},
				],
				results: [firstResult],
				evaluations: [
					finish(
						"The navigation needs attention; no note read was performed.",
						false,
					),
				],
			});
			await h.run();
			expect(h.executed).toEqual(["VIEWS_SHOW"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		},
	);

	it("does not use navigation queue advancement to release explicitly pending work", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...navigationCall,
							arguments: {
								...navigationCall.arguments,
								eliza_turn_scope: "more_work_pending",
							},
						},
						call("NOTES_LIST", "more_work_pending"),
					],
				},
				{ text: "", toolCalls: [call("REPLY", "final")] },
			],
			results: [
				navigationResult,
				{
					success: true,
					transcriptVisibility: "internal",
					data: { note: "Read the requested note." },
				},
			],
			evaluations: [finish("Notes opened and the note was read.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["VIEWS_SHOW", "NOTES_LIST"]);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(2);
		expect(result.trajectory.evaluatorOutputs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ decision: "CONTINUE", success: false }),
			]),
		);
		expect(result.finalMessage).toBe("Notes opened and the note was read.");
	});

	it("advances a planned batch after a committed receipt without an intermediate evaluator call", async () => {
		// Live 2026-09-05 23:53: two planned creates paid a full evaluator call
		// between the steps (809 ms) only to pick the call already queued.
		const dentistReceipt: EffectReceipt = {
			...appliedReceipt,
			receiptId: "calendar-receipt-2",
			resource: { ...appliedReceipt.resource, id: "evt-2" },
			commit: { ...appliedReceipt.commit, id: "evt-2" },
		};
		const h = harness({
			userMessage:
				"add gym tuesday at 7am and a dentist visit wednesday at 3pm",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-gym",
							arguments: { eliza_turn_scope: "final", title: "Gym" },
						},
						{
							...call("CALENDAR", "final"),
							id: "calendar-dentist",
							arguments: { eliza_turn_scope: "final", title: "Dentist visit" },
						},
					],
				},
			],
			evaluations: [
				finish("Added the gym session and the dentist visit.", true, [
					appliedReceipt.receiptId,
					dentistReceipt.receiptId,
				]),
			],
			results: [
				internalCalendarResult(),
				internalCalendarResult([dentistReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "add dentist visit wednesday at 3pm",
							scenario: "create_event_completed",
							facts: "Created “Dentist visit” for Sep 9, 3:00 PM PDT.",
						},
					},
				}),
			],
			intents: ["add the gym session", "add the dentist visit"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
		// No intermediate evaluator; the fully settled batch ends in one evaluation.
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
			decision: "NEXT_RECOMMENDED",
			recommendedToolCallId: "calendar-dentist",
			thought: expect.stringContaining("without an intermediate evaluation"),
		});
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			effectReceiptIds: ["calendar-receipt-1", "calendar-receipt-2"],
			raw: { messageToUser: "Added the gym session and the dentist visit." },
		});
		const prompt = evaluationPromptOf(h);
		expect(prompt).toContain("calendar-gym");
		expect(prompt).toContain("calendar-dentist");
		expect(prompt).toContain("Created “Gym session” for Sep 8, 7:00 AM PDT.");
		expect(prompt).toContain("Created “Dentist visit” for Sep 9, 3:00 PM PDT.");
		expect(prompt).toContain("add the gym session");
		expect(prompt).toContain("add the dentist visit");
		expect(result.finalMessage).toBe(
			"Added the gym session and the dentist visit.",
		);
	});

	it.each([
		[
			"the step only read (no committed mutation)",
			internalCalendarResult([readNoopReceipt], {
				data: {
					replyContext: {
						domain: "calendar",
						intent: "find the gym session",
						scenario: "search_results",
						facts: "Found “Gym session” on Sep 8, 7:00 AM PDT.",
					},
				},
			}),
		],
		[
			"the step asked for evaluation",
			internalCalendarResult([appliedReceipt], { turnComplete: false }),
		],
		[
			"the step's receipt was a mutation no-op",
			internalCalendarResult([mutationNoopReceipt]),
		],
	])(
		"keeps the per-step evaluator inside a batch when %s",
		async (_label, firstResult) => {
			const h = harness({
				plans: [
					{
						text: "",
						toolCalls: [
							{
								...call("CALENDAR", "final"),
								id: "calendar-first",
								arguments: { eliza_turn_scope: "final", title: "First" },
							},
							{
								...call("CALENDAR", "final"),
								id: "calendar-second",
								arguments: { eliza_turn_scope: "final", title: "Second" },
							},
						],
					},
				],
				evaluations: [
					JSON.stringify({
						thought: "Take the queued call.",
						success: true,
						decision: "NEXT_RECOMMENDED",
						recommendedToolCallId: "calendar-second",
					}),
					finish("Both done."),
				],
				results: [firstResult, internalCalendarResult()],
				intents: ["add the requested calendar events"],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
			expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
			expect(result.finalMessage).toBe("Both done.");
		},
	);

	it("a malformed call re-issued correctly does not keep failure authority: the evaluator's message ships with no synthesis pass", async () => {
		// Live 2026-09-06 00:45: MEMORY create without `text` failed, the retry
		// applied, the evaluator finished with "Got it", and the user received
		// {"plannerCompleted":true,"turnScope":"final"} from a forced synthesis.
		const h = harness({
			userMessage: "remember that I take my tea without sugar",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-1",
							arguments: {
								eliza_turn_scope: "final",
								action: "create",
								kind: "preference",
							},
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-2",
							arguments: {
								eliza_turn_scope: "final",
								action: "create",
								text: "User takes their tea without sugar.",
							},
						},
					],
				},
			],
			evaluations: [
				continueWork("The create had no text; retry with the text."),
				finish("Got it. No sugar in the tea."),
			],
			results: [
				{
					success: false,
					text: "text is required.",
					data: { error: "MEMORY_MISSING_TEXT" },
				},
				{
					success: true,
					text: "Stored memory 1.",
					data: { actionName: "MEMORY", op: "create", memoryId: "1" },
				},
			],
			intents: ["remember the tea preference"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["MEMORY", "MEMORY"]);
		expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(2);
		expect(result.finalMessage).toBe("Got it. No sugar in the tea.");
	});

	it.each(["query", "details.eventId"])(
		"does not clear an unresolved-target failure when an added %s selects a different event",
		async (selector) => {
			const firstArguments = {
				details: { start: "2026-09-10T18:00:00" },
				intent: "move piano lesson to thursday at 6pm",
				title: "piano lesson",
			};
			const targetEvent = {
				id: "calendar-event-qa",
				externalId: "calendar-external-qa",
				title: "piano lesson",
			};
			const wrongEvent = {
				id: "dentist-event-qa",
				externalId: "dentist-external-qa",
				title: "dentist",
			};
			const honestReply =
				"The piano lesson was not moved; a different event was changed.";
			const observedAt = "2026-09-06T15:00:00.000Z";
			const h = harness({
				userMessage: "move piano lesson to thursday at 6pm",
				plans: [
					{
						text: "",
						toolCalls: [
							{
								...call("CALENDAR_UPDATE_EVENT"),
								id: "update-missing-target",
								arguments: firstArguments,
							},
						],
					},
					{
						text: "",
						toolCalls: [
							{
								...call("CALENDAR"),
								id: "resolve-target",
								arguments: { action: "search_events", query: "piano lesson" },
							},
						],
					},
					{
						text: "",
						toolCalls: [
							{
								...call("CALENDAR_UPDATE_EVENT"),
								id: "update-resolved-target",
								arguments: {
									...firstArguments,
									...(selector === "query"
										? { query: wrongEvent.title }
										: {
												details: {
													...firstArguments.details,
													eventId: wrongEvent.externalId,
												},
											}),
								},
							},
						],
					},
					honestReply,
				],
				evaluations: [
					continueWork("Look up the event before retrying the update."),
					continueWork("The unique event is resolved; retry with its ID."),
					finish("Moved piano lesson to Thursday at 6 PM."),
				],
				results: [
					{
						success: false,
						transcriptVisibility: "internal",
						turnComplete: false,
						effectReceipts: [
							{
								receiptId: "calendar-missing-target",
								operation: "calendar.event.update",
								resource: {
									kind: "calendar.request",
									id: "calendar-request-qa",
								},
								artifacts: [],
								idempotency: { key: null, replayed: false },
								observedAt,
								outcome: "noop",
								reason:
									"The update request did not identify a target, so no approval or calendar event was changed.",
							},
						],
						data: {
							error: "CALENDAR_TARGET_UNRESOLVED",
							retryable: false,
							replyContext: {
								domain: "calendar",
								scenario: "clarify_update_event_target",
								context: { missing: ["target event"] },
							},
						},
					},
					{
						success: true,
						transcriptVisibility: "internal",
						data: { events: [targetEvent] },
					},
					{
						success: true,
						transcriptVisibility: "internal",
						effectReceipts: [
							{
								receiptId: "calendar-update-applied",
								operation: "calendar.event.update",
								resource: { kind: "calendar.event", id: wrongEvent.id },
								artifacts: [],
								idempotency: { key: "calendar-update-qa", replayed: false },
								observedAt,
								outcome: "applied",
								commit: {
									kind: "durable",
									id: wrongEvent.id,
									committedAt: observedAt,
								},
							},
						],
						data: {
							targetEvent: wrongEvent,
							event: { ...wrongEvent, startAt: "2026-09-10T18:00:00-04:00" },
						},
					},
				],
				intents: ["move piano lesson to Thursday at 6 PM"],
			});
			const result = await h.run();
			expect(h.executed).toEqual([
				"CALENDAR_UPDATE_EVENT",
				"CALENDAR",
				"CALENDAR_UPDATE_EVENT",
			]);
			expect(result.finalMessage).toBe(honestReply);
			expect(result.finalMessage).not.toBe(
				"Moved piano lesson to Thursday at 6 PM.",
			);
			expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(4);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(3);
			expect(
				result.trajectory.steps.filter(
					(step) => step.result?.success === false,
				),
			).toHaveLength(1);
		},
	);

	it("a malformed update is superseded by a correlated create of the same content: no synthesis pass, the evaluator's message ships", async () => {
		// Live 2026-09-06 01:29: MEMORY update {query, confirm} failed "text is
		// required", the retry created the same content with a receipt, the
		// evaluator finished "Got it, oat milk it is." — and the user received a
		// hallucinated apology from a rescue pass because the different
		// subaction kept the malformed failure's authority.
		const h = harness({
			userMessage: "remember that I like my coffee with oat milk",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-1",
							arguments: {
								eliza_turn_scope: "final",
								action: "update",
								query: "I like my coffee with oat milk",
								confirm: true,
							},
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-2",
							arguments: {
								eliza_turn_scope: "final",
								action: "create",
								text: "The user likes their coffee with oat milk.",
								kind: "preference",
								tags: ["coffee", "oat-milk", "preference"],
							},
						},
					],
				},
			],
			evaluations: [
				continueWork("The update had no text; create the memory instead."),
				finish("Got it, oat milk it is."),
			],
			results: [
				{
					success: false,
					text: "text is required.",
					data: { error: "MEMORY_MISSING_TEXT" },
				},
				{
					success: true,
					transcriptVisibility: "internal",
					text: "Stored memory 85034506.",
					data: { actionName: "MEMORY", op: "create", memoryId: "85034506" },
				},
			],
			intents: ["remember coffee preference"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["MEMORY", "MEMORY"]);
		expect(modelCalls(h, ModelType.ACTION_PLANNER)).toBe(2);
		expect(result.finalMessage).toBe("Got it, oat milk it is.");
	});

	it("a refused delete of one query keeps failure authority when a different query is deleted afterwards", async () => {
		// Review 2026-09-06 (Discussion 30659): the malformed failure's target
		// was never acted on, so an unrelated success of the same tool must not
		// launder it — the evaluator's "Both forgotten." may not ship.
		const h = harness({
			userMessage: "forget my favorite color and my coffee preference",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-1",
							arguments: {
								eliza_turn_scope: "final",
								action: "delete",
								query: "favorite color",
							},
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "memory-2",
							arguments: {
								eliza_turn_scope: "final",
								action: "delete",
								query: "coffee with oat milk",
								confirm: true,
							},
						},
					],
				},
				"I removed the coffee memory, but the favorite-color one needed confirmation and was not removed.",
			],
			evaluations: [
				continueWork("The delete needs confirm; retry."),
				finish("Both forgotten."),
				"I removed the coffee memory, but the favorite-color one needed confirmation and was not removed.",
			],
			results: [
				{
					success: false,
					text: "confirm is required to delete.",
					data: { error: "CONFIRMATION_REQUIRED" },
				},
				{
					success: true,
					transcriptVisibility: "internal",
					text: "Deleted 1 memory.",
					data: { actionName: "MEMORY", op: "delete", deletedCount: 1 },
				},
			],
			intents: ["forget favorite color", "forget coffee preference"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["MEMORY", "MEMORY"]);
		expect(result.finalMessage).not.toBe("Both forgotten.");
		expect(result.finalMessage).toContain("favorite-color");
	});

	it.each([
		{
			name: "a replacement body merely quotes the missed target",
			failedParams: { action: "update", query: "favorite color" },
			successfulParams: {
				action: "update",
				memoryId: "00000000-0000-0000-0000-0000000000b1",
				text: "This unrelated note quotes the words favorite color.",
			},
			successfulResult: {
				success: true,
				text: "Updated the unrelated note.",
				data: { op: "update" },
			},
		},
		{
			name: "the same description identifies a resource in another container",
			failedParams: {
				action: "update",
				query: "favorite color",
				memoryId: "00000000-0000-0000-0000-0000000000a2",
				roomId: "00000000-0000-0000-0000-0000000000a1",
			},
			successfulParams: {
				action: "update",
				memoryId: "00000000-0000-0000-0000-0000000000b1",
				roomId: "00000000-0000-0000-0000-0000000000b2",
				text: "Updated favorite color.",
			},
			successfulResult: {
				success: true,
				text: "Updated favorite color in the other room.",
				data: { op: "update" },
			},
		},
		{
			name: "a partial success still lists the missed target as failed",
			failedParams: { action: "delete", query: "favorite color" },
			successfulParams: { action: "delete", query: "coffee preference" },
			successfulResult: {
				success: true,
				text: "Deleted the coffee preference; favorite color was not found.",
				data: {
					op: "delete",
					deletedCount: 1,
					failed: [{ query: "favorite color", error: "MEMORY_NOT_FOUND" }],
				},
			},
		},
	])("keeps target-miss failure authority when $name", async (scenario) => {
		const honestReply =
			"The other change succeeded, but I couldn't find the requested favorite color record.";
		const h = harness({
			userMessage: "Change my favorite color record and the other record.",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "missed-target",
							arguments: {
								...scenario.failedParams,
								confirm: true,
								eliza_turn_scope: "final",
							},
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("MEMORY", "final"),
							id: "other-target",
							arguments: {
								...scenario.successfulParams,
								confirm: true,
								eliza_turn_scope: "final",
							},
						},
					],
				},
				honestReply,
			],
			evaluations: [
				continueWork(
					"The requested target was not found; another change remains.",
				),
				finish("Both requested records were changed."),
				honestReply,
			],
			results: [
				{
					success: false,
					text: 'No stored memory matches "favorite color".',
					data: { error: "MEMORY_NOT_FOUND", actionName: "MEMORY" },
				},
				{
					...scenario.successfulResult,
					transcriptVisibility: "internal",
				},
			],
			intents: ["change favorite color", "change the other record"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["MEMORY", "MEMORY"]);
		expect(result.trajectory.steps[0].result).toMatchObject({
			success: false,
			data: { error: "MEMORY_NOT_FOUND" },
		});
		expect(result.finalMessage).toBe(honestReply);
	});

	it.each(["list", "current", "read", "get", "search", "inspect"])(
		"does not clear failed navigation with a successful %s of the same view",
		(action) => {
			const params = { view: "calendar", navigationIntent: "planner-step" };
			expect(
				malformedCallSupersededBy(
					{ name: "VIEWS", params: { ...params, action: "show" } },
					{
						success: false,
						data: { parameterErrors: [{ name: "navigationStepId" }] },
					},
					{
						name: "VIEWS",
						params: { ...params, action, navigationStepId: "step-1" },
					},
				),
			).toBe(false);
		},
	);

	it("malformed-call supersession keeps every supplied target of the failed call", () => {
		const failedUpdateA = {
			name: "VIEWS",
			params: { action: "update", id: "note-a" },
		};
		const titleRequired = {
			success: false,
			text: "title is required.",
			data: { error: "VIEWS_MISSING_TITLE" },
		};
		// Same target, corrected: superseded.
		expect(
			malformedCallSupersededBy(failedUpdateA, titleRequired, {
				name: "VIEWS",
				params: { action: "update", id: "note-a", title: "Groceries" },
			}),
		).toBe(true);
		// Different note: the failed update of note A is still unresolved.
		expect(
			malformedCallSupersededBy(failedUpdateA, titleRequired, {
				name: "VIEWS",
				params: { action: "update", id: "note-b", title: "Groceries" },
			}),
		).toBe(false);
		// Prose targets that differ only by an uppercase identifier letter.
		expect(
			malformedCallSupersededBy(
				{ name: "VIEWS", params: { action: "update", title: "Note A" } },
				{ success: false, text: "confirm is required." },
				{
					name: "VIEWS",
					params: { action: "update", title: "Note B", confirm: true },
				},
			),
		).toBe(false);
		// Different delete query: not superseded.
		expect(
			malformedCallSupersededBy(
				{
					name: "MEMORY",
					params: { action: "delete", query: "favorite color" },
				},
				{ success: false, text: "confirm is required to delete." },
				{
					name: "MEMORY",
					params: {
						action: "delete",
						query: "coffee with oat milk",
						confirm: true,
					},
				},
			),
		).toBe(false);
		// Same delete query with confirm added: superseded.
		expect(
			malformedCallSupersededBy(
				{
					name: "MEMORY",
					params: { action: "delete", query: "favorite color" },
				},
				{ success: false, text: "confirm is required to delete." },
				{
					name: "MEMORY",
					params: { action: "delete", query: "favorite color", confirm: true },
				},
			),
		).toBe(true);
		// A refused delete is never laundered by a create of the same content.
		expect(
			malformedCallSupersededBy(
				{
					name: "MEMORY",
					params: { action: "delete", query: "favorite color is green" },
				},
				{ success: false, text: "confirm is required to delete." },
				{
					name: "MEMORY",
					params: { action: "create", text: "User's favorite color is green." },
				},
			),
		).toBe(false);
		// Content misfiled in query, re-issued as text in the third person.
		expect(
			malformedCallSupersededBy(
				{
					name: "MEMORY",
					params: {
						action: "update",
						query: "I like my coffee with oat milk",
						confirm: true,
					},
				},
				{ success: false, text: "text is required." },
				{
					name: "MEMORY",
					params: {
						action: "create",
						text: "The user likes their coffee with oat milk.",
						kind: "preference",
					},
				},
			),
		).toBe(true);
		// Dropped descriptor (kind) does not block; a dropped target does.
		expect(
			malformedCallSupersededBy(
				{ name: "MEMORY", params: { action: "create", kind: "preference" } },
				{ success: false, text: "text is required." },
				{
					name: "MEMORY",
					params: { action: "create", text: "User takes tea without sugar." },
				},
			),
		).toBe(true);
		expect(
			malformedCallSupersededBy(
				{
					name: "CALENDAR",
					params: { action: "delete_event", eventId: "evt-1" },
				},
				{ success: false, text: "confirm is required." },
				{
					name: "CALENDAR",
					params: { action: "delete_event", title: "Dentist", confirm: true },
				},
			),
		).toBe(false);
		// The field the failure named as unexpected is excluded from correlation.
		expect(
			malformedCallSupersededBy(
				{
					name: "CALENDAR",
					params: { action: "delete_event", title: "Piano lesson" },
				},
				{ success: false, text: "Unexpected argument 'title'." },
				{
					name: "CALENDAR",
					params: {
						action: "delete_event",
						details: { title: "Piano lesson" },
					},
				},
			),
		).toBe(true);
		expect(
			malformedCallSupersededBy(
				{
					name: "CALENDAR",
					params: { action: "delete_event", title: "Piano lesson" },
				},
				{ success: false, text: "Unexpected argument 'title'." },
				{
					name: "CALENDAR",
					params: {
						action: "delete_event",
						details: { title: "Dentist" },
						confirm: true,
					},
				},
			),
		).toBe(false);
		// Identifiers match as whole tokens only: evt-1 is not carried by evt-12.
		expect(
			malformedCallSupersededBy(
				{
					name: "CALENDAR",
					params: { action: "delete_event", eventId: "evt-1" },
				},
				{ success: false, text: "confirm is required." },
				{
					name: "CALENDAR",
					params: { action: "delete_event", query: "evt-12", confirm: true },
				},
			),
		).toBe(false);
		expect(
			malformedCallSupersededBy(
				{
					name: "CALENDAR",
					params: { action: "delete_event", eventId: "evt-1" },
				},
				{ success: false, text: "confirm is required." },
				{
					name: "CALENDAR",
					params: { action: "delete_event", query: "evt-1", confirm: true },
				},
			),
		).toBe(true);
	});

	it("a refused delete of one event keeps failure authority when a different event id is deleted afterwards", async () => {
		// Review 2026-09-06: evt-1 refused (confirm required), evt-12 deleted
		// with confirm — the evaluator's "Deleted." may not ship for evt-1.
		const h = harness({
			userMessage: "delete events evt-1 and evt-12",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "cal-1",
							arguments: {
								eliza_turn_scope: "final",
								action: "delete_event",
								eventId: "evt-1",
							},
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "cal-2",
							arguments: {
								eliza_turn_scope: "final",
								action: "delete_event",
								query: "evt-12",
								confirm: true,
							},
						},
					],
				},
				"I deleted evt-12, but evt-1 needed confirmation and was not removed.",
			],
			evaluations: [
				continueWork("Confirm and retry."),
				finish("Deleted both events."),
				"I deleted evt-12, but evt-1 needed confirmation and was not removed.",
			],
			results: [
				{
					success: false,
					text: "confirm is required to delete an event.",
					data: { error: "CONFIRMATION_REQUIRED" },
				},
				{
					success: true,
					transcriptVisibility: "internal",
					text: "Deleted event evt-12.",
					data: { actionName: "CALENDAR", op: "delete_event" },
				},
			],
			intents: ["delete evt-1", "delete evt-12"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
		expect(result.finalMessage).not.toBe("Deleted both events.");
		expect(result.finalMessage).toContain("evt-1 needed confirmation");
	});

	it.each([
		'{"estimate":42,"error":0.2}',
		'{"error":null,"value":42}',
		'{"error":"measurement uncertainty","value":42}',
		'{"error":0.2}',
		'{"error":null}',
		'{"error":false}',
		'{"error":""}',
		'{"error":"   "}',
		'[{"estimate":42,"error":0.2},{"error":null,"value":42}]',
		'Example response: {"error":"Not found"}',
		'```json\n{"error":"Not found"}\n```',
	])("preserves ordinary JSON error data and explicit examples: %s", (text) => {
		expect(isUnsafeUserVisibleText(text)).toBe(false);
	});

	it.each([
		'{"estimate":42,"error":0.2}',
		'{"error":null,"value":42}',
		'Example response: {"error":"Not found"}',
		'```json\n{"error":"Not found"}\n```',
	])(
		"delivers requested error data unchanged through the planner loop: %s",
		async (text) => {
			const h = harness({
				userMessage: "Return the measurement data as JSON.",
				plans: [
					JSON.stringify({
						completed: true,
						toolCalls: [],
						messageToUser: text,
					}),
				],
				evaluations: [finish(text)],
				intents: ["return measurement data"],
			});
			const result = await h.run();
			expect(result.finalMessage).toBe(text);
			expect(h.executed).toEqual([]);
		},
	);

	it.each([
		"I'll use VIEWS to open that.",
		'Here is "some quoted text". use VIEWS next.',
		'Quoted invocation: "functions.VIEWS"',
		'Quoted control: "<think>use VIEWS</think>"',
		'"description": "use VIEWS", "eliza_turn_scope": "final"',
	])(
		"keeps invocation and control checks outside the quotation exception: %s",
		(text) => {
			expect(isUnsafeUserVisibleText(text)).toBe(true);
		},
	);

	it("never delivers protocol-shaped JSON or a turn-scope marker as user text, but keeps JSON the user asked for", () => {
		expect(
			isUnsafeUserVisibleText('{"plannerCompleted":true,"turnScope":"final"}'),
		).toBe(true);
		expect(isUnsafeUserVisibleText('{"complete":true,"message":"Done."}')).toBe(
			true,
		);
		expect(
			isUnsafeUserVisibleText(
				'{"name":"MEMORY","arguments":{"action":"create","text":"x"}}',
			),
		).toBe(true);
		expect(isUnsafeUserVisibleText('{"type":"object"}')).toBe(true);
		expect(
			isUnsafeUserVisibleText(
				'{"error":"API key not found. Please set the QURATOR_API_KEY environment variable."}',
			),
		).toBe(true);
		expect(
			isUnsafeUserVisibleText(
				'{"messages":[{"role":"assistant","content":"Got it, forgotten."}]}',
			),
		).toBe(true);
		expect(
			isUnsafeUserVisibleText('{"role":"assistant","content":"Got it."}'),
		).toBe(true);
		expect(isUnsafeUserVisibleText("{}")).toBe(true);
		expect(isUnsafeUserVisibleText('[{"a":1}]')).toBe(false);
		expect(isUnsafeUserVisibleText('{"temperature":21,"unit":"C"}')).toBe(
			false,
		);
		expect(isUnsafeUserVisibleText("[1, 2, 3]")).toBe(false);
		expect(isUnsafeUserVisibleText('done: "eliza_turn_scope": "final"')).toBe(
			true,
		);
		expect(isUnsafeUserVisibleText("Got it. No sugar in the tea.")).toBe(false);
		expect(isUnsafeUserVisibleText("Use {braces} freely in prose}")).toBe(
			false,
		);
	});

	it("continues a partially completed request directly without a second verdict or replaying the first create", async () => {
		const dentistReceipt: EffectReceipt = {
			...appliedReceipt,
			receiptId: "calendar-receipt-2",
			resource: { ...appliedReceipt.resource, id: "evt-2" },
			commit: { ...appliedReceipt.commit, id: "evt-2" },
		};
		const h = harness({
			userMessage:
				"add gym tuesday at 7am and a dentist visit wednesday at 3pm",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-gym",
							arguments: { eliza_turn_scope: "final", title: "Gym" },
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-dentist",
							arguments: { eliza_turn_scope: "final", title: "Dentist visit" },
						},
					],
				},
			],
			evaluations: [
				continueWork(
					"Only the gym session exists; the dentist visit is still missing.",
				),
				finish(
					"Added the gym session for Tuesday at 7am and the dentist visit for Wednesday at 3pm.",
					true,
					[appliedReceipt.receiptId, dentistReceipt.receiptId],
				),
			],
			results: [
				internalCalendarResult(),
				internalCalendarResult([dentistReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "add dentist visit wednesday at 3pm",
							scenario: "create_event_completed",
							facts: "Created “Dentist visit” for Sep 9, 3:00 PM PDT.",
						},
					},
				}),
			],
			intents: ["add the requested calendar events"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
			effectReceiptIds: ["calendar-receipt-1", "calendar-receipt-2"],
		});
		expect(result.finalMessage).toBe(
			"Added the gym session for Tuesday at 7am and the dentist visit for Wednesday at 3pm.",
		);
		const prompt = evaluationPromptOf(h);
		expect(prompt).toContain(
			"add gym tuesday at 7am and a dentist visit wednesday at 3pm",
		);
	});

	it("preserves a requested detailed reply without imposing a generation cap", async () => {
		const message = Array.from(
			{ length: 120 },
			(_, index) =>
				`Calendar detail ${index + 1}: the gym session is Tuesday at 7am.`,
		).join("\n");
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish(message, true, [appliedReceipt.receiptId])],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
			userMessage:
				"Add the gym session and return the full detailed confirmation.",
		});
		const result = await h.run();
		expect(result.finalMessage).toBe(message);
		expect(result.evaluator?.raw?.messageToUser).toBe(message);
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		const request = h.useModel.mock.calls.find(
			([type]) => type === ModelType.RESPONSE_HANDLER,
		)?.[1];
		expect(request?.maxTokens).toBeUndefined();
	});
});
