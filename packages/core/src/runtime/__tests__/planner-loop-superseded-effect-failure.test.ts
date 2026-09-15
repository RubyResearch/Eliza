/**
 * A failed effect receipt loses failure authority over the turn's final
 * message once the same tool applies the same effect operation later in the
 * turn, however differently the retry addressed its target. Live 2026-09-14
 * (tj-af1f161f95eec3): a calendar move failed on a planner-invented event id,
 * was applied on the fourth call by title, and the user was told it could not
 * be moved.
 */
import { describe, expect, it, vi } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import { effectOperationKey, runPlannerLoop } from "../planner-loop";

const RECEIPT_BASE = {
	resource: { kind: "calendar.event", id: "evt-1" },
	artifacts: [],
	idempotency: { key: null, replayed: false },
	observedAt: "2026-09-14T06:51:00.000Z",
} as const;

function failedReceipt(operation: string): EffectReceipt {
	return {
		...RECEIPT_BASE,
		receiptId: `failed:${operation}`,
		operation,
		outcome: "failed",
		failure: {
			code: "CALENDAR_SERVICE_409",
			retryable: false,
			acceptance: "unknown",
		},
	};
}

function appliedReceipt(operation: string): EffectReceipt {
	return {
		...RECEIPT_BASE,
		receiptId: `applied:${operation}`,
		operation,
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "evt-1",
			committedAt: "2026-09-14T06:51:10.000Z",
		},
	};
}

async function runMoveTurn(failedOperation: string): Promise<string> {
	const useModel = vi
		.fn()
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "CALENDAR",
					arguments: {
						action: "update_event",
						details: { eventId: "primary-00024", start: "2026-09-18T16:00:00" },
					},
				},
			],
		})
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-2",
					name: "CALENDAR",
					arguments: {
						action: "update_event",
						query: "barber appointment",
						details: { start: "2026-09-18T16:00:00" },
					},
				},
			],
		})
		.mockResolvedValue({ text: "synthesized failure report" });
	const executeToolCall = vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			text: "Google Calendar is not connected.",
			effectReceipts: [failedReceipt(failedOperation)],
			data: { error: "CALENDAR_SERVICE_409" },
		})
		.mockResolvedValueOnce({
			success: true,
			text: "Updated the event.",
			effectReceipts: [appliedReceipt("calendar.event.update")],
		});
	const evaluate = vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			decision: "CONTINUE" as const,
			thought: "The event id was rejected; retry by title.",
		})
		.mockResolvedValueOnce({
			success: true,
			decision: "FINISH" as const,
			thought: "The move applied.",
			messageToUser: "Moved your barber appointment to Friday at 4pm.",
		});

	const result = await runPlannerLoop({
		runtime: { useModel },
		context: { id: "ctx" },
		tools: [{ name: "CALENDAR", description: "Calendar operations." }],
		executeToolCall,
		evaluate,
	});
	expect(executeToolCall).toHaveBeenCalledTimes(2);
	return result.finalMessage ?? "";
}

describe("failure authority superseded by a later applied effect", () => {
	it("lets the applied retry's reply ship when the failed receipt names the same operation", async () => {
		await expect(runMoveTurn("calendar.event.update")).resolves.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("matches the wrapper's subaction spelling of the same operation (live: calendar.update_event vs calendar.event.update)", async () => {
		await expect(runMoveTurn("calendar.update_event")).resolves.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("keeps failure authority when the applied receipt is a different operation", async () => {
		await expect(runMoveTurn("calendar.event.delete")).resolves.not.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("keys operations by their words, not their joiners", () => {
		expect(effectOperationKey("calendar.update_event")).toBe(
			effectOperationKey("calendar.event.update"),
		);
		expect(effectOperationKey("calendar.delete_event")).not.toBe(
			effectOperationKey("calendar.event.update"),
		);
		expect(effectOperationKey("trigger.create")).toBe("create trigger");
	});

	it("lets a later applied mutation's reply ship over an earlier read-only lookup miss (live: TRIGGER update with a malformed taskId, then delete + create)", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "TRIGGER",
						arguments: { action: "update", taskId: "not-a-uuid" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "TRIGGER",
						arguments: {
							action: "create",
							displayName: "Email the landlord",
							scheduledAtIso: "2026-09-15T09:00:00-04:00",
						},
					},
				],
			});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				text: "taskId is required.",
				error: "MISSING_TASK_ID",
				data: { actionName: "TRIGGER", op: "update", readOnlyOperation: true },
			})
			.mockResolvedValueOnce({
				success: true,
				text: 'Reminder set: "Email the landlord" — tomorrow at 9am.',
				modelReplyRequired: true,
				effectReceipts: [appliedReceipt("trigger.create")],
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "The update call was malformed; create it instead.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				thought: "The reminder is set.",
				messageToUser:
					"Reminder set for tomorrow at 9am to email the landlord.",
			});
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "TRIGGER", description: "Trigger operations." }],
			executeToolCall,
			evaluate,
		});
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(
			"Reminder set for tomorrow at 9am to email the landlord.",
		);
	});
});
