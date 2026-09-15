/** Tests final reply grounding and recovery against real evaluator parsing and receipt validation. */
import { describe, expect, it, vi } from "vitest";
import { renderContextObject, segmentBlock } from "../runtime/context-renderer";
import { parseEvaluatorOutput } from "../runtime/evaluator";
import type { PlannerTrajectory } from "../runtime/planner-types";
import { createMockRuntime } from "../testing/mock-runtime";
import { type ActionResult, type Memory, ModelType } from "../types";
import { applyGroundedActionReply } from "../types/action-reply";
import { resolvePlannedReplyEgress } from "./message";
import { capturePlannerReplyRecovery } from "./message/egress-policy";

const message: Memory = {
	id: "00000000-0000-4000-8000-000000000001",
	roomId: "00000000-0000-4000-8000-000000000002",
	entityId: "00000000-0000-4000-8000-000000000003",
	content: { text: "Make a note about the picnic." },
};

const savedNote: ActionResult = {
	success: true,
	data: {
		actionName: "NOTES",
		note: { title: "Picnic", body: "bring a charger" },
	},
	effectReceipts: [
		{
			receiptId: "note-proof",
			operation: "notes.create",
			outcome: "applied",
			resource: { kind: "note", id: "picnic" },
			artifacts: [],
			idempotency: { key: "picnic-request", replayed: false },
			observedAt: "2026-09-04T12:00:00.000Z",
			commit: {
				kind: "durable",
				id: "note-write",
				committedAt: "2026-09-04T12:00:00.000Z",
			},
		},
	],
};

const withdrawnEditMessage: Memory = {
	...message,
	content: {
		text: "Cancel the unstarted copper-tag edit. Read QA note B, then update note-qa-missing. If it is missing, do not create or substitute anything; leave the existing notes unchanged.",
	},
};
const readThenRejectedUpdate: ActionResult[] = [
	{
		success: true,
		data: {
			actionName: "NOTES_LIST",
			readOnlyOperation: true,
			notes: [{ id: "qa-b", title: "QA note B", body: "silver thermos" }],
		},
	},
	{
		success: false,
		error: 'No sticky note matches "note-qa-missing".',
		data: { actionName: "NOTES_UPDATE" },
	},
];
const withdrawnEditReply =
	"I will not perform that edit. QA note B says silver thermos. The requested update failed because the target note was not found; neither existing note changed.";

describe("model-backed final reply recovery", () => {
	it("repairs an unsaved draft without serializing the provider store and retains complete grounding evidence", async () => {
		const response = "I will not create or change any notes.";
		let repairPrompt = "";
		const runtime = createMockRuntime({
			useModel: vi.fn(async (_type, params) => {
				repairPrompt = String(params.prompt);
				return JSON.stringify({ response, effectReceiptIds: [] });
			}),
		});
		const historyStore = "internal-provider-history-copy ".repeat(10000);
		const walletEvidence = {
			data: {
				token: "SOL",
				balance: "2.000000001",
				warning: "Exact observation: 紫色; not settlement.",
			},
			text: "Observed balance is 2.000000001 SOL; observation-tail.",
		};
		const recovery = {
			context:
				'Complete saved context: wait for APPROVE VIOLET.\nCorrection: 紫色. Keep "two  spaces", C:\\notes\\draft and literal \\n. context-tail',
			pendingToolCalls: [],
			evaluatorOutputs: [],
		};
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message: {
					...message,
					content: {
						text: "Cancel that unsaved draft. Do not create or change any notes.",
					},
				},
				reply:
					"Cancelled. The audit note was only a preview and was never saved, so there's nothing to undo. No notes created or changed.",
				actionResults: [],
				providers: {
					RECENT_MESSAGES: {
						text: historyStore,
						data: { originalMessages: historyStore },
					},
					"get-balance": walletEvidence,
				},
				recovery,
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: [] });
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(repairPrompt).not.toContain("internal-provider-history-copy");
		const payloadLine = repairPrompt
			.split("\n")
			.find((line) => line.startsWith("Original action payload: "));
		expect(payloadLine).toBeDefined();
		const payload = JSON.parse(
			payloadLine!.replace("Original action payload: ", ""),
		);
		expect(payload.providers).toEqual({ "get-balance": walletEvidence });
		expect(payload.replyOnlyRecovery.context).toBe(recovery.context);
		expect(payload.request.text).toBe(
			"Cancel that unsaved draft. Do not create or change any notes.",
		);
	});

	it("reuses lossless history references in durable recovery without dropping corrections or replaying effects", async () => {
		const repeated =
			"Standing rule: show the full title and wait for separate approval.\n".repeat(
				40,
			);
		const history = [
			repeated,
			"Correction: the charger is burgundy, previously teal.",
			repeated,
		];
		const trajectory: PlannerTrajectory = {
			context: {
				id: "recovery-context",
				metadata: { historyReferenceEncoding: true },
				events: [
					{ id: "policy", type: "provider", name: "PRIVACY", text: repeated },
					...history.map((content, index) => ({
						id: `history-${index}`,
						type: "segment" as const,
						source: "prior-dialogue",
						segment: {
							id: `history-${index}`,
							label: "prior_message:user",
							content,
							stable: false,
						},
					})),
					{
						id: "current",
						type: "message",
						message: { role: "user", content: message.content },
					},
					{
						id: "effect",
						type: "tool_result",
						metadata: { result: savedNote },
					},
				],
			},
			steps: [],
			archivedSteps: [],
			plannedQueue: [{ name: "CALENDAR_READ" }],
			evaluatorOutputs: [],
		};
		const before = structuredClone(trajectory);
		const reply =
			"The Picnic note was saved. The calendar read is still pending.";
		const useModel = vi.fn(async () =>
			JSON.stringify({ response: reply, effectReceiptIds: ["note-proof"] }),
		);
		const processActions = vi.fn();
		const runtime = createMockRuntime({ useModel, processActions });
		const recovery = capturePlannerReplyRecovery(runtime, message, trajectory);
		const original = renderContextObject(trajectory.context)
			.promptSegments.map(segmentBlock)
			.join("\n\n");
		expect(recovery.context.length).toBeLessThan(original.length);
		// Independently expand the recorded backward reference and its anchor.
		const expanded = recovery.context
			.replace(/^History encoding:.*\n\n/m, "")
			.replace("prior_message:user:\n[h1]\n", "prior_message:user:\n")
			.replace(
				"prior_message:user:\n[h3; same_text_as=h1]",
				`prior_message:user:\n${history[0]}`,
			);
		expect(expanded).toBe(original);
		expect(trajectory).toEqual(before);
		expect(recovery.pendingToolCalls).toEqual(trajectory.plannedQueue);
		// Persist/reload the capture before using the real reply-only boundary.
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "",
				actionResults: [savedNote],
				recovery: JSON.parse(JSON.stringify(recovery)),
			}),
		).resolves.toEqual({ text: reply, effectReceiptIds: ["note-proof"] });
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("same_text_as=h1"),
			}),
		);
		expect(processActions).not.toHaveBeenCalled();
		// Voice/group/legacy contexts without the explicit encoding contract stay unchanged.
		trajectory.context.metadata = {};
		expect(
			capturePlannerReplyRecovery(runtime, message, trajectory).context,
		).toBe(original);
	});
	it("accepts withdrawn intent and a pre-write rejection without mutation proof or another call", async () => {
		const runtime = createMockRuntime({ useModel: vi.fn() });
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message: withdrawnEditMessage,
				reply: withdrawnEditReply,
				actionResults: readThenRejectedUpdate,
			}),
		).resolves.toEqual({ text: withdrawnEditReply, effectReceiptIds: [] });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("rewrites ambiguous cancellation as withdrawn intent with complete read and failure evidence", async () => {
		const useModel = vi.fn(async () =>
			JSON.stringify({ response: withdrawnEditReply, effectReceiptIds: [] }),
		);
		const processActions = vi.fn();
		const runtime = createMockRuntime({ useModel, processActions });
		const originalResults = structuredClone(readThenRejectedUpdate);
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message: withdrawnEditMessage,
				reply: "Cancelled the copper-tag edit without modifying either note.",
				actionResults: readThenRejectedUpdate,
			}),
		).resolves.toEqual({ text: withdrawnEditReply, effectReceiptIds: [] });
		expect(useModel).toHaveBeenCalledTimes(1);
		for (const evidence of [
			withdrawnEditMessage.content.text,
			"silver thermos",
			"note-qa-missing",
			"NOTES_LIST",
			"NOTES_UPDATE",
		]) {
			expect(useModel).toHaveBeenCalledWith(
				ModelType.TEXT_SMALL,
				expect.objectContaining({ prompt: expect.stringContaining(evidence) }),
			);
		}
		expect(processActions).not.toHaveBeenCalled();
		expect(readThenRejectedUpdate).toEqual(originalResults);
	});

	it.each([
		"I will not perform that edit. I deleted the note.",
		"I will not perform that edit, and I deleted the note.",
		"I will not perform that edit. I cancelled the calendar event.",
		"I will not perform that edit, and I cancelled the calendar event.",
		"Cancelled the copper-tag edit without modifying either note.",
	])(
		"still rejects unproven completed changes in a withdrawal rewrite: %s",
		async (response) => {
			const useModel = vi.fn(async () =>
				JSON.stringify({ response, effectReceiptIds: [] }),
			);
			const runtime = createMockRuntime({ useModel });
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message: withdrawnEditMessage,
					reply: "Cancelled the copper-tag edit without modifying either note.",
					actionResults: readThenRejectedUpdate,
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
			expect(useModel).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves an earlier committed write when a later edit is rejected before writing", async () => {
		const response =
			"I will not perform the copper-tag edit. I created the Picnic note. QA note B says silver thermos; the later update failed because the target note was not found.";
		const useModel = vi.fn(async () =>
			JSON.stringify({ response, effectReceiptIds: ["note-proof"] }),
		);
		const runtime = createMockRuntime({ useModel });
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message: withdrawnEditMessage,
				reply: "Cancelled the copper-tag edit without modifying either note.",
				actionResults: [savedNote, ...readThenRejectedUpdate],
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: ["note-proof"] });
		expect(useModel).toHaveBeenCalledTimes(1);
		for (const evidence of [
			"bring a charger",
			"silver thermos",
			"note-qa-missing",
		]) {
			expect(useModel).toHaveBeenCalledWith(
				ModelType.TEXT_SMALL,
				expect.objectContaining({ prompt: expect.stringContaining(evidence) }),
			);
		}
	});

	it("retains original constraints and unfinished intents during reply-only recovery", async () => {
		const response =
			"I saved Picnic. The calendar change was not completed, and I have not retried it.";
		const useModel = vi.fn(async () =>
			JSON.stringify({ response, effectReceiptIds: ["note-proof"] }),
		);
		const processActions = vi.fn();
		const runtime = createMockRuntime({ useModel, processActions });
		const context = `${"prior constraint ".repeat(2000)}Keep the existing calendar event unchanged.`;
		const grounding = `${"complete action fact 🦊 ".repeat(2000)}Preserve both original and corrected descriptions.`;
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "",
				actionResults: [
					applyGroundedActionReply(savedNote, { kind: "deferred", grounding }),
				],
				recovery: {
					context,
					pendingToolCalls: [
						{ name: "CALENDAR", arguments: { operation: "create" } },
					],
					evaluatorOutputs: [
						{ decision: "CONTINUE", reason: "Calendar is still pending" },
					],
					ownerExclusiveDisclosureUsed: true,
				},
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: ["note-proof"] });
		expect(useModel).toHaveBeenCalledTimes(1);
		const parameters = useModel.mock.calls[0]?.[1] as { prompt: string };
		expect(parameters.prompt).toContain(context);
		expect(parameters.prompt).toContain(grounding);
		expect(parameters.prompt).toContain("Calendar is still pending");
		expect(parameters.prompt).toContain(
			"does not prove the whole request completed",
		);
		expect(parameters.prompt).toContain(
			"not a fresh observation of current state",
		);
		expect(processActions).not.toHaveBeenCalled();
	});

	it("delivers the evaluator's receipt-bound reply without another model call", async () => {
		const reply = "I've created Picnic with your reminder to bring a charger.";
		const evaluator = parseEvaluatorOutput(
			JSON.stringify({
				thought: "The recorded note write completed the request.",
				success: true,
				decision: "FINISH",
				messageToUser: reply,
				effectReceiptIds: ["note-proof"],
			}),
		);
		const runtime = createMockRuntime({ useModel: vi.fn() });
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply,
				actionResults: [savedNote],
				evaluator,
			}),
		).resolves.toEqual({ text: reply, effectReceiptIds: ["note-proof"] });
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(savedNote.userFacingText).toBeUndefined();
	});

	it.each([
		"missing receipt",
		"invented receipt",
		"nonterminal verdict",
		"changed final reply",
		"changed evaluator reply",
		"other turn",
		"preview",
		"rollback",
	])("does not reuse evaluator proof after %s", async (condition) => {
		const reply = "I've created the picnic note.";
		const evaluator = parseEvaluatorOutput(
			JSON.stringify({
				thought: "Check the note write.",
				success: true,
				decision: condition === "nonterminal verdict" ? "CONTINUE" : "FINISH",
				messageToUser: reply,
				effectReceiptIds:
					condition === "missing receipt"
						? []
						: condition === "invented receipt"
							? ["unrelated-proof"]
							: ["note-proof"],
			}),
		);
		if (condition === "changed evaluator reply")
			evaluator.messageToUser = "I've created a different note.";
		const receipt = savedNote.effectReceipts?.[0];
		if (!receipt) throw new Error("Missing receipt fixture");
		const actionResults: ActionResult[] =
			condition === "other turn"
				? []
				: [
						{
							...savedNote,
							effectReceipts:
								condition === "preview"
									? [{ ...receipt, outcome: "preview" }]
									: condition === "rollback"
										? [
												receipt,
												{
													...receipt,
													receiptId: "rollback",
													outcome: "rolled_back",
													rollback: {
														receiptId: "undo-write",
														revertedReceiptIds: ["note-proof"],
														rolledBackAt: "2026-09-04T12:01:00.000Z",
													},
												},
											]
										: [receipt],
						},
					];
		const recovery = "The saved result could not be confirmed.";
		const runtime = createMockRuntime({
			useModel: vi.fn(async () =>
				JSON.stringify({ response: recovery, effectReceiptIds: [] }),
			),
		});
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: condition.startsWith("changed")
					? "I've created a different note."
					: reply,
				actionResults,
				evaluator,
			}),
		).resolves.toEqual({ text: recovery, effectReceiptIds: [] });
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("preserves a valid model reply without another inference call", async () => {
		const runtime = createMockRuntime({ useModel: vi.fn() });
		const reply = "What would you like the note to say?";
		await expect(
			resolvePlannedReplyEgress({ runtime, message, reply, actionResults: [] }),
		).resolves.toEqual({ text: reply, effectReceiptIds: [] });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("repairs an unproven claim using the request and complete results without replaying actions", async () => {
		const handler = vi.fn();
		const response = "The note service did not confirm a saved note.";
		const useModel = vi.fn(async () => JSON.stringify({ response }));
		const runtime = createMockRuntime({
			useModel,
			actions: [
				{
					name: "NOTES",
					description: "Notes",
					validate: async () => true,
					handler,
				},
			],
		});
		const actionResults: ActionResult[] = [
			{
				success: false,
				error: "write not confirmed",
				data: {
					actionName: "NOTES",
					details: `${"context ".repeat(1500)}tail-proof`,
				},
			},
		];
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "I've created the note.",
				actionResults,
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: [] });
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("Make a note about the picnic."),
			}),
		);
		expect(useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("tail-proof"),
			}),
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("renders a missing reply from completed results while retaining exact receipt grounding", async () => {
		const response = "I've created the picnic note.";
		const runtime = createMockRuntime({
			useModel: vi.fn(async () => JSON.stringify({ response })),
		});
		const actionResults: ActionResult[] = [
			{
				...savedNote,
				userFacingText: response,
				verifiedUserFacing: true,
				userFacingEffectReceiptIds: ["note-proof"],
			},
		];
		await expect(
			resolvePlannedReplyEgress({ runtime, message, reply: "", actionResults }),
		).resolves.toEqual({ text: response, effectReceiptIds: ["note-proof"] });
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("binds model-authored prose to the selected current-turn receipt without canned action text", async () => {
		const response =
			"I've created Picnic with your reminder to bring a charger.";
		const runtime = createMockRuntime({
			useModel: vi.fn(async () =>
				JSON.stringify({ response, effectReceiptIds: ["note-proof"] }),
			),
		});
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "I've created the note.",
				actionResults: [savedNote],
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: ["note-proof"] });
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(savedNote.userFacingText).toBeUndefined();
	});

	it.each(
		[
			[],
			["invented-proof"],
			["note-proof", "invented-proof"],
			[42],
			"note-proof",
		].map((effectReceiptIds) => ({ effectReceiptIds })),
	)(
		"rejects unsupported or malformed model-selected receipt IDs: %j",
		async ({ effectReceiptIds }) => {
			const runtime = createMockRuntime({
				useModel: vi.fn(async () =>
					JSON.stringify({
						response: "I've created the note.",
						effectReceiptIds,
					}),
				),
			});
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: "",
					actionResults: [savedNote],
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
		},
	);

	it("does not turn a preview or a rolled-back write into a completed-change confirmation", async () => {
		const runtime = createMockRuntime({
			useModel: vi.fn(async () =>
				JSON.stringify({
					response: "I've created the note.",
					effectReceiptIds: ["note-proof"],
				}),
			),
		});
		const applied = savedNote.effectReceipts?.[0];
		if (!applied) throw new Error("Missing receipt fixture");
		for (const effectReceipts of [
			[{ ...applied, outcome: "preview" as const }],
			[
				applied,
				{
					...applied,
					receiptId: "rollback",
					outcome: "rolled_back" as const,
					rollback: {
						receiptId: "undo-write",
						revertedReceiptIds: ["note-proof"],
						rolledBackAt: "2026-09-04T12:01:00.000Z",
					},
				},
			],
		]) {
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: "",
					actionResults: [{ ...savedNote, effectReceipts }],
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
		}
	});

	it.each([
		[
			"another ungrounded claim",
			JSON.stringify({ response: "I've created the note." }),
		],
		["empty response", JSON.stringify({ response: "" })],
		["invalid response", "not JSON"],
	])(
		"fails explicitly instead of emitting canned dialogue after %s",
		async (_label, output) => {
			const runtime = createMockRuntime({
				useModel: vi.fn(async () => output),
			});
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: "",
					actionResults: [],
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
		},
	);

	it("reports a model outage and never substitutes a preset assistant reply", async () => {
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			reportError,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(async () => {
				throw new Error("provider unavailable");
			}),
		});
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "",
				actionResults: [],
			}),
		).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
		expect(reportError).toHaveBeenCalled();
	});
});
