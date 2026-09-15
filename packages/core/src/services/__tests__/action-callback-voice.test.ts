/**
 * Exercises `wrapSingleTurnVisibleCallback` (services/message): action-callback
 * text is rewritten through TEXT_SMALL into natural language, while passive REPLY
 * callbacks pass through untouched, and a failed rewrite degrades to the raw
 * callback text — never fabricated meta-narration (observed live: a successful
 * settings action shipped an internal formatting apology to chat). Runs against
 * a mock runtime with a stubbed model.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { HandlerCallback, Memory } from "../../types";
import { ModelType } from "../../types";
import { wrapSingleTurnVisibleCallback } from "../message";

describe("action callback voice rewriting", () => {
	it("rewrites a read-only action diagnostic through TEXT_SMALL and delivers parsed natural language", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "agent",
			character: {
				name: "Example",
				system: "Speak with crisp, helpful confidence.",
				style: { all: ["clear", "warm"] },
			},
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			useModel: vi.fn(
				async (modelType: ModelType, params: { prompt: string }) => {
					expect(modelType).toBe(ModelType.TEXT_SMALL);
					expect(params.prompt).toContain("Original action payload");
					expect(params.prompt).toContain("stdout: found task id=abc123");
					const payload = params.prompt
						.split("\n")
						.find((line) => line.startsWith("Original action payload: "));
					expect(
						JSON.parse(payload!.replace("Original action payload: ", "")),
					).toBe("stdout: found task id=abc123");
					return JSON.stringify({
						response: "I found the task. Its ID is abc123.",
					});
				},
			),
		});
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
		} as unknown as Memory;

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "stdout: found task id=abc123" }, "INSPECT_TASK");

		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "I found the task. Its ID is abc123.",
				data: expect.objectContaining({
					rawActionText: "stdout: found task id=abc123",
					voiceRewritten: true,
				}),
			}),
			"INSPECT_TASK",
		);
	});

	it("does not rewrite passive reply callbacks", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "agent",
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(),
		});
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
		} as unknown as Memory;

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "Already model-written." }, "REPLY");

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith(
			{ text: "Already model-written." },
			"REPLY",
		);
	});

	it("does not rewrite a canonical action callback", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "agent",
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(),
		});
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
		} as unknown as Memory;
		const canonicalText =
			"“Send demo video” is scheduled for Tuesday, August 4, 2026 at 9:00 AM.";

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.(
			{ text: canonicalText, agentVoiced: true },
			"READ_CALENDAR",
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith(
			{ text: canonicalText, agentVoiced: true },
			"READ_CALENDAR",
		);
	});
});

// The exact string the removed fallback used to fabricate; it must never reach
// a delivery callback again.
const META_APOLOGY = /couldn't format the details cleanly/i;

function deliveredTexts(callback: ReturnType<typeof vi.fn>): string[] {
	return callback.mock.calls
		.map((call) => (call[0] as { text?: string } | undefined)?.text)
		.filter((text): text is string => typeof text === "string");
}

describe("action callback voice rewrite failure", () => {
	const message = {
		id: "message",
		roomId: "room",
		entityId: "user",
	} as unknown as Memory;

	it("delivers the raw callback text when the rewrite model returns unusable output", async () => {
		const callback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(async () => ""),
		});
		const raw = "Got it — I'll only reply when you @-mention me.";

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			callback as unknown as HandlerCallback,
		);
		await wrapped?.({ text: raw, actions: ["PERSONALITY"] }, "PERSONALITY");

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			{ text: raw, actions: ["PERSONALITY"] },
			"PERSONALITY",
		);
		for (const text of deliveredTexts(callback)) {
			expect(text).not.toMatch(META_APOLOGY);
		}
	});

	it("delivers the raw callback text when the rewrite model call throws", async () => {
		const callback = vi.fn(async () => []);
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(async () => {
				throw new Error("model unavailable");
			}),
			reportError,
		});
		const raw = "Reply gate lifted — back to normal.";

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			callback as unknown as HandlerCallback,
		);
		await wrapped?.({ text: raw }, "PERSONALITY");

		expect(callback).toHaveBeenCalledWith({ text: raw }, "PERSONALITY");
		expect(reportError).toHaveBeenCalledWith(
			"MessageService.rewriteActionCallback",
			expect.any(Error),
			expect.objectContaining({ actionName: "PERSONALITY" }),
		);
		for (const text of deliveredTexts(callback)) {
			expect(text).not.toMatch(META_APOLOGY);
		}
	});

	it("routes an action-owned error string through reportError, never chat", async () => {
		const callback = vi.fn(async () => []);
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(async () => ""),
			reportError,
		});
		const raw = "The gate did not change.";
		const actionError = "store write rejected";

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			callback as unknown as HandlerCallback,
		);
		await wrapped?.({ text: raw, error: actionError }, "PERSONALITY");

		expect(reportError).toHaveBeenCalledWith(
			"MessageService.rewriteActionCallback",
			expect.objectContaining({ message: actionError }),
			expect.objectContaining({ actionName: "PERSONALITY" }),
		);
		for (const text of deliveredTexts(callback)) {
			expect(text).not.toMatch(META_APOLOGY);
			expect(text).not.toContain(actionError);
		}
		expect(deliveredTexts(callback)).toEqual([raw]);
	});

	it("delivers the raw callback text when the runtime has no model", async () => {
		const callback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		});
		const raw = "Cleared verbosity for you.";

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			callback as unknown as HandlerCallback,
		);
		await wrapped?.({ text: raw }, "PERSONALITY");

		expect(callback).toHaveBeenCalledWith({ text: raw }, "PERSONALITY");
		for (const text of deliveredTexts(callback)) {
			expect(text).not.toMatch(META_APOLOGY);
		}
	});

	it("never fabricates text for whitespace-only callback text", async () => {
		const callback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(),
		});

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			callback as unknown as HandlerCallback,
		);
		await wrapped?.({ text: "   " }, "PERSONALITY");

		expect(runtime.useModel).not.toHaveBeenCalled();
		for (const text of deliveredTexts(callback)) {
			expect(text).not.toMatch(META_APOLOGY);
			expect(text.trim()).toBe("");
		}
	});
});
