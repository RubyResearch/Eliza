/**
 * Real planner loop, evaluator, action settlement, and result mapping. Only
 * model responses and the committed in-memory mutation are fixtures. A failed
 * presentation after an internal applied effect must not replay the request.
 */
import { describe, expect, it, vi } from "vitest";
import { NoModelProviderConfiguredError } from "../../runtime";
import { subPlannerResultToPlannerToolResult } from "../../services/message";
import type { Action, IAgentRuntime } from "../../types";
import { ModelType } from "../../types/model";
import { settleActionHandler } from "../action-handler-settlement";
import { runEvaluator } from "../evaluator";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../planner-loop";
import type { PlannerRuntime, PlannerToolCall } from "../planner-types";

const receipt = {
	receiptId: "receipt-calendar-delete-1",
	operation: "calendar.event.delete",
	resource: { kind: "calendar.event", id: "event-1" },
	artifacts: [],
	idempotency: { key: "request-1", replayed: false },
	observedAt: "2026-09-05T10:00:00.000Z",
	outcome: "applied" as const,
	commit: {
		kind: "durable" as const,
		id: "delete-1",
		committedAt: "2026-09-05T10:00:00.000Z",
	},
};

describe("internal applied effect followed by evaluator reply failure", () => {
	it.each([
		"final",
		"pending",
		"unscoped",
		"evaluation-required",
		"no-reply-delegation",
		"invalid-reply",
		"existing-reply",
		"no-reply-proof",
	])(
		"recovers omitted presentation only after valid final scope (%s)",
		async (variant) => {
			const reply =
				"The selected event was deleted. The other event is unchanged.";
			const events = new Set(["event-1", "untouched-event"]);
			const finish = JSON.stringify({
				thought: "The deletion is verified.",
				success: true,
				decision: "FINISH",
				messageToUser: reply,
				effectReceiptIds: [receipt.receiptId],
			});
			const useModel = vi
				.fn<PlannerRuntime["useModel"]>()
				.mockRejectedValue(new Error("Reply recovery fixture exhausted"))
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "delete-1",
							name: "DELETE",
							arguments: { eliza_turn_scope: "more_work_pending" },
						},
					],
				})
				.mockResolvedValueOnce(
					JSON.stringify({
						thought:
							"The durable receipt confirms the entire requested deletion.",
						success: true,
						decision: "FINISH",
						effectReceiptIds: [receipt.receiptId],
						...(variant === "existing-reply"
							? { messageToUser: "The event is deleted." }
							: {}),
					}),
				)
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-1",
							name: "REPLY",
							arguments: {
								...(variant === "unscoped"
									? {}
									: {
											eliza_turn_scope:
												variant === "pending" ? "more_work_pending" : "final",
										}),
								text: variant === "invalid-reply" ? "Working on it." : reply,
								...(variant === "no-reply-proof"
									? {}
									: { effectReceiptIds: [receipt.receiptId] }),
							},
						},
					],
				})
				.mockResolvedValueOnce(
					variant === "unscoped"
						? {
								text: "",
								toolCalls: [
									{
										id: "corrected-reply",
										name: "REPLY",
										arguments: {
											eliza_turn_scope: "final",
											text: reply,
											effectReceiptIds: [receipt.receiptId],
										},
									},
								],
							}
						: finish,
				)
				.mockResolvedValueOnce(
					variant === "unscoped"
						? finish
						: {
								text: "",
								toolCalls: [
									{
										id: "release-1",
										name: "REPLY",
										arguments: { eliza_turn_scope: "final" },
									},
								],
							},
				);
			const executeToolCall = vi.fn(async () => {
				expect(events.delete("event-1")).toBe(true);
				return actionResultToPlannerToolResult({
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: variant !== "no-reply-delegation",
					...(variant === "evaluation-required" ? { turnComplete: false } : {}),
					effectReceipts: [receipt],
					data: { deleted: true, remaining: [...events] },
				});
			});
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: {
					id: "pending-omitted-reply",
					events: [
						{
							id: "handler",
							type: "message_handler",
							metadata: { plan: { intents: ["delete the selected event"] } },
						},
					],
				},
				tools: [
					{ name: "DELETE", description: "Delete selected event" },
					{
						name: "REPLY",
						description: "Reply to the user",
						parameters: {
							type: "object",
							properties: { text: { type: "string" } },
							required: [],
						},
					},
				],
				executeToolCall,
			});
			const replyTools = [0, 2].map((index) =>
				useModel.mock.calls[index][1].tools?.find(
					(tool) => tool.name === "REPLY",
				),
			);
			expect(replyTools[0]?.parameters?.required).not.toContain("text");
			if (
				![
					"existing-reply",
					"evaluation-required",
					"no-reply-delegation",
				].includes(variant)
			)
				expect(replyTools[1]?.parameters?.required).toContain("text");
			else expect(replyTools[1]?.parameters?.required).not.toContain("text");
			expect(result.finalMessage).toBe(reply);
			expect(executeToolCall).toHaveBeenCalledOnce();
			expect([...events]).toEqual(["untouched-event"]);
			expect(useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				...(variant === "unscoped" ? [ModelType.ACTION_PLANNER] : []),
				...(variant === "final" ? [] : [ModelType.RESPONSE_HANDLER]),
				...(variant === "pending" ? [ModelType.ACTION_PLANNER] : []),
			]);
			expect(result.evaluator?.effectReceiptIds).toEqual([receipt.receiptId]);
			if (variant === "final")
				expect(result.trajectory.steps.at(-1)).toMatchObject({
					terminalOnly: true,
					terminalMessage: reply,
				});
		},
	);
	it.each([true, undefined])(
		"retains missing-reply continuation outside the non-coding planner (codingMode=%s)",
		async (codingMode) => {
			const result = await runEvaluator({
				runtime: {
					useModel: async () =>
						JSON.stringify({
							thought: "The deletion receipt confirms completion.",
							success: true,
							decision: "FINISH",
						}),
				},
				context: { id: "legacy-or-coding-evaluator", events: [] },
				trajectory: {
					context: { id: "legacy-or-coding-evaluator", events: [] },
					codingMode,
					steps: [
						{
							toolCall: { id: "delete-1", name: "DELETE", params: {} },
							result: actionResultToPlannerToolResult({
								success: true,
								transcriptVisibility: "internal",
								modelReplyRequired: true,
								effectReceipts: [receipt],
								data: { deleted: true },
							}),
						},
					],
					archivedSteps: [],
					plannedQueue: [],
					evaluatorOutputs: [],
				},
			});
			expect(result.decision).toBe("CONTINUE");
			expect(result.success).toBe(false);
			expect(result.messageToUser).toBeUndefined();
		},
	);
	it.each(["damaged", "omitted"])(
		"recovers an evaluator reply that is %s without replanning or repeating the committed effect",
		async (variant) => {
			const events = new Set(["event-1", "untouched-event"]);
			const damaged = "The event\u001c\u001d is deleted.";
			const clean =
				"The selected event was deleted. The other event is unchanged.";
			const useModel = vi
				.fn<PlannerRuntime["useModel"]>()
				.mockRejectedValue(new Error("Reply recovery fixture exhausted"))
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "delete-1",
							name: "DELETE",
							arguments: { eliza_turn_scope: "final" },
						},
					],
				})
				.mockResolvedValueOnce(
					JSON.stringify({
						thought: "The deletion receipt confirms completion.",
						success: true,
						decision: "FINISH",
						...(variant === "damaged" ? { messageToUser: damaged } : {}),
					}),
				)
				.mockResolvedValueOnce(JSON.stringify({ messageToUser: clean }));
			const executeToolCall = vi.fn(async () => {
				expect(events.delete("event-1")).toBe(true);
				return actionResultToPlannerToolResult({
					success: true,
					transcriptVisibility: "internal",
					...(variant === "omitted" ? { modelReplyRequired: true } : {}),
					effectReceipts: [receipt],
					data: { deleted: true, remaining: [...events] },
				});
			});
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: {
					id: "damaged-evaluator-reply",
					events:
						variant === "omitted"
							? [
									{
										id: "handler",
										type: "message_handler",
										metadata: {
											plan: { intents: ["delete the selected event"] },
										},
									},
								]
							: [],
				},
				tools: [{ name: "DELETE", description: "Delete the selected event" }],
				executeToolCall,
			});
			expect(result.finalMessage).toBe(clean);
			expect(executeToolCall).toHaveBeenCalledOnce();
			expect(useModel).toHaveBeenCalledTimes(3);
			expect(useModel.mock.calls[2][1]).not.toHaveProperty("tools");
			expect(result.trajectory.steps[0].result?.effectReceipts).toEqual([
				receipt,
			]);
			expect([...events]).toEqual(["untouched-event"]);
		},
	);
	it("preserves an earlier mutation when a later read precedes reply failure", async () => {
		const events = new Set(["event-1", "untouched-event"]);
		const useModel = vi
			.fn<PlannerRuntime["useModel"]>()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "delete-1", name: "DELETE", arguments: {} },
					{ id: "read-1", name: "READ", arguments: {} },
				],
			})
			.mockResolvedValueOnce(
				JSON.stringify({
					thought: "Read the remaining events next.",
					success: false,
					decision: "NEXT_RECOMMENDED",
					recommendedToolCallId: "read-1",
				}),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("Unavailable"), { statusCode: 503 }),
			);
		const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
			if (call.name === "DELETE") {
				expect(events.delete("event-1")).toBe(true);
				return actionResultToPlannerToolResult({
					success: true,
					transcriptVisibility: "internal",
					turnComplete: false,
					effectReceipts: [receipt],
					data: { deleted: true },
				});
			}
			expect(call.name).toBe("READ");
			return actionResultToPlannerToolResult({
				success: true,
				data: { events: [...events] },
			});
		});
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "delete-then-read" },
			tools: [
				{ name: "DELETE", description: "Delete event." },
				{ name: "READ", description: "Read events." },
			],
			executeToolCall,
		});
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(useModel).toHaveBeenCalledTimes(3);
		expect([...events]).toEqual(["untouched-event"]);
		expect(result.terminalFailure).toMatchObject({
			kind: "provider_issue",
			transient: false,
		});
		expect(result.trajectory.steps[0]?.result).toMatchObject({
			success: true,
			effectReceipts: [receipt],
			replyFailure: result.terminalFailure,
		});
		expect(result.trajectory.steps[1]?.result).toMatchObject({
			success: true,
			data: { events: ["untouched-event"] },
		});
	});

	it.each([
		{
			label: "HTTP 429",
			kind: "rate_limited",
			error: () => Object.assign(new Error("Rate limit"), { statusCode: 429 }),
		},
		{
			label: "HTTP 503",
			kind: "provider_issue",
			error: () => Object.assign(new Error("Unavailable"), { statusCode: 503 }),
		},
		{
			label: "no provider",
			kind: "no_provider",
			error: () => new NoModelProviderConfiguredError(),
		},
	])(
		"preserves receipt and stops replay after $label",
		async ({ kind, error }) => {
			const events = new Set(["event-1", "untouched-event"]);
			const callback = vi.fn(async () => []);
			const useModel = vi
				.fn<PlannerRuntime["useModel"]>()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "delete-1",
							name: "CALENDAR",
							arguments: { action: "delete_event", eventId: "event-1" },
						},
						{ id: "later-1", name: "LATER", arguments: {} },
					],
				})
				.mockRejectedValueOnce(error());
			const runtime = {
				useModel,
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				},
				reportError: vi.fn(),
			} as unknown as IAgentRuntime;
			const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
				expect(call.name).toBe("CALENDAR");
				return actionResultToPlannerToolResult(
					await settleActionHandler({
						runtime,
						action: { name: "CALENDAR", tags: ["write"] } as Action,
						callback,
						invoke: async () => {
							expect(events.delete(String(call.params?.eventId))).toBe(true);
							return {
								success: true,
								transcriptVisibility: "internal",
								turnComplete: false,
								effectReceipts: [receipt],
								data: {
									deleted: true,
									replyContext: {
										scenario: "delete_event_completed",
										facts: "The selected event was deleted.",
									},
								},
							};
						},
					}),
				);
			});

			const result = await runPlannerLoop({
				runtime,
				context: { id: "internal-calendar-effect" },
				tools: [
					{ name: "CALENDAR", description: "Delete the selected event." },
					{ name: "LATER", description: "A later operation." },
				],
				executeToolCall,
			});

			expect([...events]).toEqual(["untouched-event"]);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(JSON.stringify(useModel.mock.calls[1]?.[1])).toContain(
				receipt.receiptId,
			);
			expect(callback).not.toHaveBeenCalled();
			expect(result.status).toBe("finished");
			expect(result.finalMessage).toBeUndefined();
			expect(result.terminalFailure).toMatchObject({ kind, transient: false });
			expect(result.terminalFailure?.message).toBeTruthy();
			expect(result.trajectory.steps).toHaveLength(1);
			expect(result.trajectory.steps[0]?.result).toMatchObject({
				success: true,
				transcriptVisibility: "internal",
				turnComplete: false,
				effectReceipts: [receipt],
				data: { deleted: true },
				replyFailure: result.terminalFailure,
			});
			expect(subPlannerResultToPlannerToolResult(result)).toMatchObject({
				success: true,
				effectReceipts: [receipt],
				replyFailure: result.terminalFailure,
			});
			expect(result.trajectory.steps[0]?.result?.error).toBeUndefined();
			expect(result.trajectory.plannedQueue).toMatchObject([
				{ id: "later-1", name: "LATER" },
			]);
		},
	);
});
