/**
 * A settled CALENDAR mutation that verified itself against the user's words
 * (turnComplete + verifiedUserFacing + userFacingText + an applied receipt, the
 * shape plugin-calendar's respond() stamps) ends the turn through the
 * verified-intent gate with the receipt sentence verbatim and no evaluator
 * model call — the MEMORY behavior, now for calendar. The unverified shape
 * (no flags, same receipt) still evaluates. Deterministic: vitest-mocked
 * `useModel` and `evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { evaluatePlannedReplyEgress } from "../../services/message/egress-policy";
import type { Action, ActionResult } from "../../types/components";
import { runPlannerLoop } from "../planner-loop";

const receipt = {
	receiptId: "calendar-event-mutation-receipt-v1:update",
	operation: "calendar.event.update",
	resource: {
		kind: "calendar.event",
		id: "agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:evt-1",
		version: '"eliza-2"',
	},
	artifacts: [],
	idempotency: { key: "calendar-local-operation-v1:update", replayed: false },
	observedAt: "2026-09-14T17:50:00.000Z",
	outcome: "applied" as const,
	commit: {
		kind: "durable" as const,
		id: "agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:evt-1",
		committedAt: "2026-09-14T17:50:00.000Z",
	},
};

const VERIFIED_REPLY =
	"Moved “Notary Appointment” to Friday, Sep 18 at 4pm EDT.";

function intentContext(intents: string[]) {
	return {
		id: "ctx",
		events: [
			{
				id: "message-handler:1",
				type: "message_handler",
				source: "message-service",
				createdAt: 1,
				metadata: { plan: { intents } },
			},
		],
	} as never;
}

function harness(verified: boolean) {
	const runtime = {
		// Native-mode planner return: one CALENDAR_UPDATE_EVENT call, no prose.
		useModel: vi.fn(async () => ({
			text: "",
			toolCalls: [
				{
					id: "calendar-1",
					name: "CALENDAR_UPDATE_EVENT",
					arguments: {
						query: "notary appointment",
						details: { start: "2026-09-18T16:00:00" },
						eliza_turn_scope: "final",
					},
				},
			],
		})),
	};
	const executeToolCall = vi.fn(async () => ({
		success: true,
		transcriptVisibility: "internal" as const,
		...(verified
			? {
					turnComplete: true,
					verifiedUserFacing: true,
					userFacingText: VERIFIED_REPLY,
					userFacingEffectReceiptIds: [receipt.receiptId],
				}
			: {}),
		effectReceipts: [receipt],
		data: {
			actionName: "CALENDAR",
			subaction: "update_event",
			approvalRequired: false,
			replyContext: {
				domain: "calendar",
				intent: "move notary appointment to friday 4pm",
				scenario: "update_event_completed",
				facts: verified
					? VERIFIED_REPLY
					: "Updated “Notary Appointment” for Sep 18, 4:00 PM EDT.",
				context: {},
			},
		},
	}));
	const evaluate = vi.fn(async () => ({
		success: true,
		decision: "FINISH" as const,
		thought: "evaluator ran",
		messageToUser: "moved it, you're set for friday.",
	}));
	return { runtime, executeToolCall, evaluate };
}

describe("verified intent gate — CALENDAR settled receipt", () => {
	it("ends the turn on the self-verified calendar receipt without the evaluator call", async () => {
		const { runtime, executeToolCall, evaluate } = harness(true);
		const result = await runPlannerLoop({
			runtime,
			// The live Stage-1 intent for the captured turn (2026-09-14).
			context: intentContext(["move notary appointment to friday 4pm"]),
			executeToolCall,
			evaluate,
		});
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).not.toHaveBeenCalled();
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(VERIFIED_REPLY);
		expect(result.evaluator).toMatchObject({
			success: true,
			decision: "FINISH",
			messageToUser: VERIFIED_REPLY,
		});
		expect(result.evaluator?.thought).toContain("single declared intent");
	});

	it("still evaluates the unverified calendar receipt shape", async () => {
		const { runtime, executeToolCall, evaluate } = harness(false);
		const result = await runPlannerLoop({
			runtime,
			context: intentContext(["move notary appointment to friday 4pm"]),
			executeToolCall,
			evaluate,
		});
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("moved it, you're set for friday.");
	});

	it("still evaluates when the verified sentence does not name the declared intent", async () => {
		const { runtime, executeToolCall, evaluate } = harness(true);
		await runPlannerLoop({
			runtime,
			context: intentContext(["cancel the dentist on monday"]),
			executeToolCall,
			evaluate,
		});
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it.each([
		["create", "Created “Dentist appointment” for Friday, Sep 18 at 3pm EDT."],
		["update", VERIFIED_REPLY],
		[
			"delete",
			"Deleted “Haircut” (Friday, Sep 18 at 11am EDT) from your calendar.",
		],
	])(
		"passes reply egress for the verified %s sentence bound to its applied receipt",
		async (_operation, sentence) => {
			// A bounce here would send the gated reply through the grounded-reply
			// re-render (a model call) and defeat the gate; the calendar result
			// binds its receipt through userFacingEffectReceiptIds so the claim
			// is grounded by the action's own proof.
			const { executeToolCall } = harness(true);
			const settled = {
				...((await executeToolCall()) as unknown as ActionResult),
				userFacingText: sentence,
			};
			const calendar = {
				name: "CALENDAR",
				tags: ["domain:calendar", "effect:receipt-required"],
			} as unknown as Action;
			expect(
				evaluatePlannedReplyEgress({
					reply: sentence,
					request: "move my notary appointment to friday at 4pm",
					actionResults: [settled],
					actions: [calendar],
				}),
			).toEqual({ verdict: "allow" });
		},
	);
});
