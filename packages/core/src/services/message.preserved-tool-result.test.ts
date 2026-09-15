/**
 * Preserved-tool-result rescue when the planner loop dies mid-turn: drives the
 * real `DefaultMessageService.handleMessage` pipeline (real AgentRuntime,
 * in-memory adapter, real planner loop and action execution) with only model
 * transport stubbed. Reproduces the live 2026-08-07/08 incident class — a tool
 * completes, then the post-tool evaluator model call fails — and asserts the
 * completed tool's `userFacingText` reaches the user instead of the canned
 * transient-failure reply, while a turn with genuinely nothing user-facing
 * still gets the canned line. Also unit-covers `preservedSettledToolResult`
 * candidate selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import type { PlannerToolResult } from "../runtime/planner-loop";
import type {
	Action,
	ActionResult,
	Content,
	HandlerCallback,
	Memory,
	UUID,
} from "../types";
import { ModelType } from "../types";
import { ChannelType } from "../types/primitives";
import { PROVIDER_CONTEXT_OVERFLOW } from "../utils/model-errors";
import {
	answerlessToolTurnReport,
	DefaultMessageService,
	preservedSettledToolResult,
	subAgentCompletionRelayBody,
} from "./message";

const AGENT_ID = "00000000-0000-0000-0000-000000000081" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000082" as UUID;

const USER_FACING = "calendar event saved: eliza-test, tomorrow 3pm.";
const DIAGNOSTIC = "calendar.create op=create id=ev-1 ok exit=0";

// The live evaluator failure shape: a provider/wrapper error with NO HTTP
// status, so the planner-loop's in-loop provider-error relay does not fire and
// the failure propagates to the message service's rescue seam.
const EVALUATOR_FAILURE = new Error(
	"[cli-inference:sdk] subscription rate limit reached: session limit hit",
);

function stageOneToolTurn(replyEffectStatus: "none" | "non_applied" = "none") {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Look up the entry.",
					contexts: ["general"],
					intents: ["look up entry"],
					candidateActionNames: ["LOOKUP"],
					replyText: "",
					replyEffectStatus,
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function plannerCalendarCall() {
	return {
		thought: "Look up the requested entry.",
		toolCalls: [
			{
				id: "calendar-create-1",
				name: "LOOKUP",
				args: { action: "create" },
			},
		],
	};
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
	return {
		entityId: USER_ID,
		agentId: runtime.agentId,
		roomId: runtime.agentId,
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

interface Harness {
	runtime: AgentRuntime;
	callback: HandlerCallback;
	callbacks: Content[];
	sent: Content[];
	reportedScopes: string[];
}

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(options: {
	actionResult: Record<string, unknown>;
	actionGate?: (roomId: UUID) => Promise<void>;
}): Promise<Harness> {
	const runtime = new AgentRuntime({
		character: createCharacter({
			id: AGENT_ID,
			name: "Preserved Result Integration",
			bio: "Exercises the planner-loop failure rescue seam.",
			settings: {},
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize({ skipMigrations: true });
	activeRuntimes.push(runtime);

	runtime.actions.length = 0;
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: { availableContexts: "general" },
		data: {},
		text: "Deterministic preserved-tool-result state.",
	})) as AgentRuntime["composeState"];

	const calendarAction: Action = {
		name: "LOOKUP",
		description: "Looks up a stored entry.",
		parameters: [
			{
				name: "action",
				description: "Lookup operation",
				required: true,
				schema: { type: "string", enum: ["create", "verify"] },
			},
		],
		validate: async () => true,
		handler: async (_runtime, message) => {
			await options.actionGate?.(message.roomId);
			return options.actionResult as never;
		},
	};
	runtime.registerAction(calendarAction);

	// Stage 1 succeeds and promotes to planning; every LATER response-handler
	// call (the post-tool evaluator) dies like the live incident. The failure
	// reply generator's TEXT_* calls die the same way, forcing the canned
	// template path when nothing user-facing is preserved.
	let stageOneServed = false;
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		async () => {
			if (!stageOneServed) {
				stageOneServed = true;
				return stageOneToolTurn();
			}
			throw EVALUATOR_FAILURE;
		},
		"preserved-tool-result-test",
		100,
	);
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		async () => plannerCalendarCall(),
		"preserved-tool-result-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => {
			throw EVALUATOR_FAILURE;
		},
		"preserved-tool-result-test",
		100,
	);

	const reportedScopes: string[] = [];
	const originalReportError = runtime.reportError.bind(runtime);
	runtime.reportError = ((scope, error, context) => {
		reportedScopes.push(String(scope));
		return originalReportError(scope, error, context);
	}) as AgentRuntime["reportError"];

	const callbacks: Content[] = [];
	const sent: Content[] = [];
	runtime.registerSendHandler(
		"client_chat",
		async (_runtime, _target, content) => {
			sent.push(content);
			return undefined;
		},
	);
	const callback: HandlerCallback = async (content: Content) => {
		callbacks.push(content);
		await runtime.sendMessageToTarget(
			{ source: "client_chat", roomId: runtime.agentId },
			content,
		);
		return [];
	};

	return { runtime, callback, callbacks, sent, reportedScopes };
}

function visibleTexts(contents: Content[]): string[] {
	return contents
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
}

describe("planner-loop death after a completed tool", () => {
	it.each([true, false])(
		"propagates an unexpected post-effect error without apology inference (result success=%s)",
		async (success) => {
			let actionCalls = 0;
			const h = await createHarness({
				actionResult: {
					success,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					data: { noteId: "note-1" },
					effectReceipts: [
						{
							receiptId: "saved-note-1",
							operation: "notes.note.create",
							outcome: "applied",
							resource: { kind: "note", id: "note-1" },
							artifacts: [],
							idempotency: { key: null, replayed: false },
							observedAt: "2026-09-14T00:00:00.000Z",
							commit: {
								kind: "durable",
								id: "note-1",
								committedAt: "2026-09-14T00:00:00.000Z",
							},
						},
					],
				},
				actionGate: async () => {
					actionCalls++;
				},
			});
			const failure = new TypeError(
				"unexpected evaluator failure after commit",
			);
			let handlerCalls = 0;
			h.runtime.registerModel(
				ModelType.RESPONSE_HANDLER,
				async () => {
					if (handlerCalls++ === 0) return stageOneToolTurn();
					throw failure;
				},
				"post-effect-error-test",
				300,
			);
			const apologyModel = vi.fn(async () => {
				throw failure;
			});
			h.runtime.registerModel(
				ModelType.TEXT_SMALL,
				apologyModel,
				"post-effect-error-test",
				300,
			);
			const onSettledActionResult = vi.fn();
			await expect(
				new DefaultMessageService().handleMessage(
					h.runtime,
					makeMessage(h.runtime, "Save the note."),
					h.callback,
					{ onSettledActionResult },
				),
			).rejects.toBe(failure);
			expect(actionCalls).toBe(1);
			expect(onSettledActionResult).toHaveBeenCalledTimes(1);
			expect(onSettledActionResult).toHaveBeenCalledWith(
				expect.objectContaining({
					effectReceipts: [
						expect.objectContaining({
							receiptId: "saved-note-1",
							outcome: "applied",
						}),
					],
				}),
			);
			expect(apologyModel).not.toHaveBeenCalled();
			expect(visibleTexts(h.callbacks)).toEqual([]);
		},
	);

	it("retains prior dialogue when immediate reply grounding needs a rewrite without replaying the tool", async () => {
		let actionCalls = 0;
		const h = await createHarness({
			actionResult: {
				success: true,
				text: "The live page heading is Example Domain.",
			},
			actionGate: async () => {
				actionCalls++;
			},
		});
		const history =
			"In this fictional story, Ada packs a cobalt notebook and a copper flask.";
		h.runtime.composeState = vi.fn(async () => ({
			values: { availableContexts: "general" },
			data: {
				providers: {
					RECENT_MESSAGES: {
						data: {
							recentMessages: [
								{
									...makeMessage(h.runtime, history),
									id: "00000000-0000-4000-8000-000000000099",
									createdAt: 1,
								},
							],
						},
					},
				},
			},
			text: "",
		})) as AgentRuntime["composeState"];
		let handlerCalls = 0;
		h.runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				if (handlerCalls++ === 0) return stageOneToolTurn();
				return JSON.stringify({
					thought: "The read succeeded; answer the compound request.",
					success: true,
					decision: "FINISH",
					messageToUser:
						"Cancelled the note edit. The page heading is Example Domain.",
				});
			},
			"inline-recovery-context-test",
			300,
		);
		let rewriteCalls = 0;
		const answer =
			"I will not perform the edit. The page heading is Example Domain. Ada packs a cobalt notebook and a copper flask.";
		h.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_runtime, params) => {
				rewriteCalls++;
				expect(params.prompt).toContain(history);
				expect(params.prompt).toContain(
					"The live page heading is Example Domain.",
				);
				return JSON.stringify({ response: answer, effectReceiptIds: [] });
			},
			"inline-recovery-context-test",
			300,
		);
		const result = await new DefaultMessageService().handleMessage(
			h.runtime,
			makeMessage(
				h.runtime,
				"Withdraw the unstarted note edit, look up the live page heading, and recall Ada's fictional packing list. Do not change any records.",
			),
			h.callback,
		);
		expect(actionCalls).toBe(1);
		expect(rewriteCalls).toBe(1);
		expect(result.responseContent?.text).toBe(answer);
	});

	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(
			activeRuntimes.splice(0).map(async (runtime) => {
				await runtime.stop();
				await runtime.close();
			}),
		);
	});

	it("propagates out-of-band Stop instead of rescuing settled tool text", async () => {
		let announce!: (roomId: UUID) => void;
		const entered = new Promise<UUID>((resolve) => {
			announce = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			actionResult: {
				success: true,
				userFacingText: USER_FACING,
				modelReplyRequired: true,
			},
			actionGate: async (roomId) => {
				announce(roomId);
				await gate;
			},
		});
		const pending = new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the eliza-test entry"),
			harness.callback,
			{ onStreamChunk: async () => undefined },
		);
		const rejection = expect(pending).rejects.toMatchObject({
			code: "TURN_ABORTED",
		});
		const roomId = await entered;
		expect(
			harness.runtime.turnControllers.abortTurn(roomId, "ui-chat-stop"),
		).toBe(true);
		release();
		await rejection;
		expect(visibleTexts(harness.callbacks)).toEqual([]);
		expect(harness.reportedScopes).not.toContain("MessageService.plannerLoop");
	});

	it("never delivers the preliminary navigation promise after Stop during planning", async () => {
		let announce!: () => void;
		const entered = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let actionCalls = 0;
		const harness = await createHarness({
			actionResult: { success: true },
			actionGate: async () => {
				actionCalls++;
			},
		});
		const stageOne = stageOneToolTurn();
		stageOne.toolCalls[0].arguments.replyText =
			"Switching you to the calendar view now.";
		harness.runtime.responseHandlerEvaluators.push({
			name: "navigation-planning-admission",
			priority: 100,
			shouldRun: () => true,
			evaluate: () => ({ reply: "On it.", requiresTool: true }),
		});
		harness.runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => stageOne,
			"stop-test",
			200,
		);
		harness.runtime.registerModel(
			ModelType.ACTION_PLANNER,
			async () => {
				announce();
				await gate;
				throw new Error("provider stopped after cancellation");
			},
			"stop-test",
			200,
		);
		const pending = new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the requested entry"),
			harness.callback,
		);
		const rejection = expect(pending).rejects.toMatchObject({
			code: "TURN_ABORTED",
		});
		await entered;
		const [roomId] = harness.runtime.turnControllers.activeRoomIds();
		expect(roomId).toBeDefined();
		expect(
			harness.runtime.turnControllers.abortTurn(roomId, "ui-chat-stop"),
		).toBe(true);
		release();
		await rejection;
		expect(actionCalls).toBe(0);
		expect(visibleTexts(harness.callbacks)).toEqual([]);
		expect(harness.reportedScopes).not.toContain("MessageService.plannerLoop");
	});

	it("does not rescue a partial result when the default tool-call budget stops a batch", async () => {
		const savedItems: number[] = [];
		const harness = await createHarness({
			actionResult: {
				success: true,
				text: "Item saved.",
				data: { userFacingText: "Item saved." },
			},
		});
		harness.runtime.actions[0].handler = async (
			_runtime,
			_message,
			_state,
			options,
		) => {
			const item = options?.parameters?.item;
			if (typeof item !== "number") throw new Error("Missing requested item");
			savedItems.push(item);
			return {
				success: true,
				text: "Item saved.",
				data: { userFacingText: "Item saved.", item },
			};
		};
		harness.runtime.actions[0].parameters?.push({
			name: "item",
			description: "Distinct requested item",
			required: true,
			schema: { type: "number" },
		});
		let stageOne = true;
		harness.runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				if (stageOne) {
					stageOne = false;
					return stageOneToolTurn();
				}
				return JSON.stringify({
					success: true,
					decision: "NEXT_RECOMMENDED",
					thought: "The remaining distinct entries still need saving.",
					recommendedToolCallId: `save-${savedItems.length}`,
				});
			},
			"limit-test",
			200,
		);
		const reportedErrors: unknown[] = [];
		const reportError = harness.runtime.reportError.bind(harness.runtime);
		harness.runtime.reportError = (scope, error, context) => {
			reportedErrors.push(error);
			return reportError(scope, error, context);
		};
		harness.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				return "The tool-call budget was reached before all requested entries could be saved.";
			},
			"limit-test",
			200,
		);
		harness.runtime.registerModel(
			ModelType.ACTION_PLANNER,
			async () => ({
				toolCalls: Array.from({ length: 17 }, (_, i) => ({
					id: `save-${i}`,
					name: "LOOKUP",
					args: { action: "create", item: i },
				})),
			}),
			"limit-test",
			200,
		);
		await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(
				harness.runtime,
				"Save all seventeen distinct requested entries in order.",
			),
			harness.callback,
		);
		expect(savedItems).toEqual(Array.from({ length: 16 }, (_, i) => i));
		expect(reportedErrors).toContainEqual(
			expect.objectContaining({
				name: "TrajectoryLimitExceeded",
				kind: "tool_calls",
				max: 16,
				observed: 17,
			}),
		);
		expect(harness.callbacks).toContainEqual(
			expect.objectContaining({ failureKind: "planner_exhaustion" }),
		);
		expect(visibleTexts(harness.callbacks)).not.toContain("Item saved.");
		expect(harness.sent).toContainEqual(
			expect.objectContaining({ failureKind: "planner_exhaustion" }),
		);
	});

	it.each([false, true])(
		"preserves the provider context boundary with a settled tool: %s",
		async (settled) => {
			let actionCalls = 0;
			const harness = await createHarness({
				actionResult: {
					success: true,
					text: USER_FACING,
					data: { userFacingText: USER_FACING },
				},
				actionGate: async () => {
					actionCalls++;
				},
			});
			const stageOne = stageOneToolTurn("non_applied");
			const preliminary =
				"Setting it up: 25 pushups, 3 a day, no fixed times, counted whenever you get them in.";
			stageOne.toolCalls[0].arguments.replyText = settled ? "" : preliminary;
			const overflow = new ElizaError(
				"Complete planner request exceeds provider capacity",
				{
					code: PROVIDER_CONTEXT_OVERFLOW,
					context: { requestedTokens: 177751, limit: 131072 },
				},
			);
			harness.runtime.registerModel(
				ModelType.TEXT_SMALL,
				async () => {
					throw overflow;
				},
				"overflow-test",
				200,
			);
			let stageCalls = 0;
			harness.runtime.registerModel(
				ModelType.RESPONSE_HANDLER,
				async (_runtime, params) => {
					if (stageCalls++ === 0) return stageOne;
					expect(JSON.stringify(params)).toContain(completeRequest);
					throw overflow;
				},
				"overflow-test",
				200,
			);
			const completeRequest =
				"look up the requested entry " +
				"complete background context ".repeat(600) +
				"END-OF-COMPLETE-REQUEST";
			let plannerCalls = 0;
			harness.runtime.registerModel(
				ModelType.ACTION_PLANNER,
				async (_runtime, params) => {
					plannerCalls++;
					expect(JSON.stringify(params)).toContain(completeRequest);
					if (settled) return plannerCalendarCall();
					throw overflow;
				},
				"overflow-test",
				200,
			);
			await new DefaultMessageService().handleMessage(
				harness.runtime,
				makeMessage(harness.runtime, completeRequest),
				harness.callback,
			);
			// A safe Stage-1 draft reaches pre-execution evaluation first. Its
			// overflow must stop the turn before planning or action dispatch.
			expect(plannerCalls).toBe(settled ? 1 : 0);
			expect(stageCalls).toBeGreaterThan(1);
			expect(actionCalls).toBe(settled ? 1 : 0);
			expect(harness.callbacks).toContainEqual(
				expect.objectContaining({
					failureKind: "context_overflow",
					transient: false,
				}),
			);
			expect(visibleTexts(harness.callbacks)).not.toContain(preliminary);
			expect(visibleTexts(harness.callbacks)).not.toContain(USER_FACING);
		},
	);

	it("delivers the completed tool's user-facing result instead of the canned failure", async () => {
		const harness = await createHarness({
			actionResult: {
				success: true,
				text: DIAGNOSTIC,
				userFacingText: USER_FACING,
				verifiedUserFacing: true,
			},
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the eliza-test entry"),
			harness.callback,
		);

		expect(result.responseContent?.text).toBe(USER_FACING);
		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toContain(USER_FACING);
		// The canned transient/rate-limit apology must not replace a result the
		// turn already produced.
		for (const text of delivered) {
			expect(text.toLowerCase()).not.toContain("rate-limit");
			expect(text.toLowerCase()).not.toContain("something went wrong");
			expect(text).not.toContain(DIAGNOSTIC);
		}
		// The loop failure is still reported — the rescue is a degrade, not a
		// success mask.
		expect(harness.reportedScopes).toContain("MessageService.plannerLoop");
	});

	it("does not rescue an older success after failed verification and a provider outage", async () => {
		const harness = await createHarness({ actionResult: { success: true } });
		const action = harness.runtime.actions.find(
			(entry) => entry.name === "LOOKUP",
		);
		if (!action) throw new Error("Lookup action missing from harness");

		const executed: string[] = [];
		action.handler = async (_runtime, _message, _state, options) => {
			const operation = options?.parameters?.action;
			if (typeof operation !== "string") throw new Error("Missing operation");
			executed.push(operation);
			return operation === "create"
				? {
						success: true,
						userFacingText: USER_FACING,
						verifiedUserFacing: true,
					}
				: {
						success: false,
						text: "Verification lookup did not find the completed record.",
						userFacingText:
							"Verification lookup did not find the completed record.",
						verifiedUserFacing: true,
						turnComplete: true,
						data: { readOnlyOperation: true },
					};
		};
		let responseCalls = 0;
		harness.runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				if (++responseCalls === 1) return stageOneToolTurn();
				return JSON.stringify({
					decision: "CONTINUE",
					success: executed.length < 2,
					thought: "Continue with the remaining requested read.",
				});
			},
			"failed-verification-test",
			200,
		);
		let plannerCalls = 0;
		harness.runtime.registerModel(
			ModelType.ACTION_PLANNER,
			async () => {
				++plannerCalls;
				if (executed.length >= 2)
					throw Object.assign(
						new Error(
							"Too Many Requests: Tokens per minute limit exceeded - too many tokens processed.",
						),
						{ status: 429 },
					);
				return {
					completed: false,
					toolCalls: [
						{
							id: `entry-${plannerCalls}`,
							name: "LOOKUP",
							args: { action: executed.length === 0 ? "create" : "verify" },
						},
					],
				};
			},
			"failed-verification-test",
			200,
		);
		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(
				harness.runtime,
				"Create the entry, verify it, then read the final calendar.",
			),
			harness.callback,
		);
		expect(executed).toEqual(["create", "verify"]);
		expect(visibleTexts(harness.callbacks)).not.toContain(USER_FACING);
		expect(result.responseContent?.text).not.toBe(USER_FACING);
		expect(result.responseContent?.text).toBe(
			"Verification lookup did not find the completed record.",
		);
	});

	it("keeps the canned failure line when no tool produced user-facing text", async () => {
		const harness = await createHarness({
			actionResult: {
				success: true,
				text: DIAGNOSTIC,
			},
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the eliza-test entry"),
			harness.callback,
		);

		const delivered = visibleTexts(harness.callbacks);
		expect(delivered.length).toBeGreaterThan(0);
		// Diagnostic tool text must never render as assistant prose, so the
		// canned failure template (rate-limited here, since every model call in
		// this turn is rate-limited) is the correct degrade.
		expect(delivered.join("\n").toLowerCase()).toContain("rate-limit");
		expect(delivered.join("\n")).not.toContain(DIAGNOSTIC);
		expect(result.responseContent?.text ?? "").not.toContain(DIAGNOSTIC);
	});
});

describe("subAgentCompletionRelayBody parsing (#18208)", () => {
	const RELAY_HEADER =
		"[sub-agent: review pr 18175 (elizaos) — task_complete — this delegated task is DONE; the result is below, relay it to the user as the answer and do NOT start another sub-agent for it.]";
	const RESULT_BODY =
		"The PR fixes the pairing dead-end: hosts now redeem the in-progress pairing instead of dropping it. Two files changed, tests included.";

	it("extracts the result body from a task_complete relay", () => {
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${RESULT_BODY}`)).toBe(
			RESULT_BODY,
		);
	});

	it("parses task_complete from a canonical header beyond character 400", () => {
		const longHeader = `[sub-agent: ${"review context ".repeat(35)} (elizaos) — task_complete — this delegated task is DONE; relay the result.]`;
		expect(longHeader.indexOf("task_complete")).toBeGreaterThan(400);
		expect(subAgentCompletionRelayBody(`${longHeader}\n${RESULT_BODY}`)).toBe(
			RESULT_BODY,
		);
	});

	it("parses the closing header after bracket characters in a task label", () => {
		expect(
			subAgentCompletionRelayBody(
				`[sub-agent: review parser ] edge cases (elizaos) — task_complete — this delegated task is DONE; relay it.]\n${RESULT_BODY}`,
			),
		).toBe(RESULT_BODY);
	});

	it("returns undefined for non-relay text, non-complete events, and empty bodies", () => {
		expect(subAgentCompletionRelayBody("what's the weather")).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: devops (elizaos) — error]\nsub-agent reported an error",
			),
		).toBeUndefined();
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n   `)).toBeUndefined();
		expect(subAgentCompletionRelayBody(undefined)).toBeUndefined();
	});

	it("does not infer completion from task labels or result bodies", () => {
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: explain task_complete handling (elizaos) — blocked]\nNeed approval.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: status check (elizaos) — error]\nThe body says task_complete but the task failed.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: explain task_complete handling]\nNo structured status.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: quote — task_complete — this delegated task is DONE; in docs (elizaos) — blocked]\nNeed approval.",
			),
		).toBeUndefined();
		for (const event of ["QUESTION_FOR_TASK_CREATOR", "AGENT_COORDINATION"]) {
			expect(
				subAgentCompletionRelayBody(
					`[sub-agent: explain task_complete (${event}) — ${event}]\nNeed input.`,
				),
			).toBeUndefined();
		}
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: quote (fake) — task_complete — this delegated task is DONE; (elizaos) — round-trip cap exceeded]\nNeed approval.",
			),
		).toBeUndefined();
	});

	it("preserves a long completed result body", () => {
		const huge = "x".repeat(5000);
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${huge}`)).toBe(huge);
	});

	it("a failed relay turn delivers the completed result instead of the canned line", async () => {
		// Same failing-turn harness as above (tool result carries nothing
		// user-facing, every later model call dies) — but the TRIGGERING message
		// is a task_complete relay, so the finished result it carries must win
		// over any canned failure text.
		const harness = await createHarness({
			actionResult: { success: false, text: DIAGNOSTIC },
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, `${RELAY_HEADER}\n${RESULT_BODY}`),
			harness.callback,
		);

		const delivered = visibleTexts(harness.callbacks);
		const everything = [
			...delivered,
			String(result.responseContent?.text ?? ""),
		].join("\n");
		// The completed result reaches the user…
		expect(everything).toContain("pairing dead-end");
		// …and no canned failure/apology text replaces it.
		expect(everything.toLowerCase()).not.toContain("runtime step failed");
		expect(everything).not.toContain(DIAGNOSTIC);
	});
});

describe("preservedSettledToolResult candidate selection", () => {
	const settle = (
		name: string,
		result: Partial<PlannerToolResult>,
	): { name: string; result: PlannerToolResult } => ({
		name,
		result: { success: true, ...result } as PlannerToolResult,
	});

	it("picks the most recent successful non-terminal result with user-facing text", () => {
		const picked = preservedSettledToolResult(
			[
				settle("MEMORY_SEARCH", { userFacingText: "older answer" }),
				settle("LOOKUP", { userFacingText: USER_FACING }),
			],
			new Set(),
		);
		expect(picked?.userFacingText).toBe(USER_FACING);
	});

	it("does not select an older successful operation past a failed verification", () => {
		expect(
			preservedSettledToolResult(
				[
					settle("LOOKUP", { userFacingText: USER_FACING }),
					settle("VERIFY", {
						success: false,
						userFacingText: "Verification failed.",
					}),
				],
				new Set(),
			),
		).toBeUndefined();
	});

	it("retains a successful recovery after an earlier failed verification", () => {
		const recovered = preservedSettledToolResult(
			[
				settle("LOOKUP", {
					success: false,
					userFacingText: "Verification failed.",
				}),
				settle("LOOKUP", {
					success: true,
					userFacingText: "The saved entry is verified.",
				}),
			],
			new Set(),
		);
		expect(recovered?.userFacingText).toBe("The saved entry is verified.");
	});

	it("skips failed results, terminals, and results without user-facing text", () => {
		expect(
			preservedSettledToolResult(
				[
					settle("LOOKUP", { success: false, userFacingText: "failed op" }),
					settle("REPLY", { userFacingText: "terminal reply text" }),
					settle("MEMORY_CREATE", { text: "Stored memory ev-1." }),
					settle("MEMORY_CREATE", { userFacingText: "   " }),
				],
				new Set(),
			),
		).toBeUndefined();
	});

	it("skips a result the user already saw and falls back to an earlier one", () => {
		const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		const picked = preservedSettledToolResult(
			[
				settle("MEMORY_SEARCH", { userFacingText: "undelivered answer" }),
				settle("LOOKUP", { userFacingText: USER_FACING }),
			],
			new Set([deliveredNormalized]),
		);
		expect(picked?.userFacingText).toBe("undelivered answer");
	});

	it("returns undefined when everything eligible was already delivered", () => {
		const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		expect(
			preservedSettledToolResult(
				[settle("LOOKUP", { userFacingText: USER_FACING })],
				new Set([deliveredNormalized]),
			),
		).toBeUndefined();
	});
});

describe("answerlessToolTurnReport", () => {
	const asyncAction: Action = {
		name: "TASKS",
		similes: ["TASKS_SPAWN_AGENT"],
		description: "Spawn a task.",
		asyncHandoff: true,
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
	const settled = (
		result: Partial<PlannerToolResult>,
	): Array<{ name: string; result: PlannerToolResult }> => [
		{
			name: "TASKS_SPAWN_AGENT",
			result: { success: true, ...result } as PlannerToolResult,
		},
	];
	const report = (
		result: Partial<PlannerToolResult>,
		actionResult: ActionResult,
	): string =>
		answerlessToolTurnReport({
			settledToolResults: settled(result),
			deliveredVisibleTexts: new Set(),
			actionResults: [actionResult],
			actions: [asyncAction],
			stageOneAck: "On it.",
		});

	it("never retains an ack for a failed async handoff", () => {
		expect(
			report(
				{ success: false, text: "spawn failed" },
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe("");
	});

	it("retains an ack only after applied acceptance proof", () => {
		expect(
			report(
				{ success: true },
				{
					success: true,
					data: { actionName: "TASKS_SPAWN_AGENT" },
					effectReceipts: [
						{
							receiptId: "spawn-1",
							operation: "tasks.spawn_agent",
							outcome: "applied",
							resource: { kind: "acp.session", id: "session-1" },
							artifacts: [],
							idempotency: { key: null, replayed: false },
							observedAt: "2026-08-15T00:00:00.000Z",
							commit: {
								kind: "provider_accepted",
								id: "session-1",
								committedAt: "2026-08-15T00:00:00.000Z",
							},
						},
					],
				},
			),
		).toBe("On it.");
	});

	it("preserves a verified failed outcome instead of a generic line", () => {
		const failure = "The coding task could not authenticate.";
		expect(
			report(
				{
					success: false,
					userFacingText: failure,
					verifiedUserFacing: true,
				},
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe(failure);
	});

	it("does not trust an unverified failure projection", () => {
		expect(
			report(
				{ success: false, userFacingText: "raw provider failure" },
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe("");
	});
});

describe("answerlessToolTurnReport — structured effect receipts", () => {
	const viewsAction: Action = {
		name: "VIEWS",
		similes: [],
		description: "Switch the visible view.",
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
	const report = (result: Partial<PlannerToolResult>): string =>
		answerlessToolTurnReport({
			settledToolResults: [
				{
					name: "VIEWS",
					result: { success: true, ...result } as PlannerToolResult,
				},
			],
			deliveredVisibleTexts: new Set(),
			actionResults: [{ success: true, data: { actionName: "VIEWS" } }],
			actions: [viewsAction],
			stageOneAck: "",
		});

	it("leaves accepted effects without prose to model-backed recovery", () => {
		expect(
			report({
				text: JSON.stringify({
					effect: "view_navigation",
					status: "accepted",
					viewId: "chat",
					label: "Home",
					path: "/",
				}),
				transcriptVisibility: "internal",
			}),
		).toBe("");
	});

	it("does not manufacture a reply for an empty success", () => {
		expect(report({})).toBe("");
	});

	it("preserves existing user-facing text", () => {
		expect(
			report({
				text: JSON.stringify({
					effect: "view_navigation",
					status: "accepted",
					label: "Home",
				}),
				userFacingText: "you're back on the home view.",
			}),
		).toBe("you're back on the home view.");
	});
});
