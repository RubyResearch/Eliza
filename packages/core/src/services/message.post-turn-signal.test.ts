/**
 * Pins the cheap semantic gate that prevents a second model call after trivial
 * replies while preserving reflection for user memory and executed actions.
 */
import { describe, expect, it } from "vitest";
import type { Content, Memory, State } from "../types/index.ts";
import { hasPostTurnSemanticSignal } from "./message.ts";

const reply = { actions: ["REPLY"] } satisfies Pick<Content, "actions">;

function message(text: string): Pick<Memory, "content"> {
	return { content: { text } };
}

function state(actionResults: unknown[] = []): Pick<State, "data"> {
	return { data: { actionResults } };
}

describe("post-turn semantic signal", () => {
	it("skips exact-output and ordinary stateless questions", () => {
		expect(
			hasPostTurnSemanticSignal(
				message("Reply with exactly SPEED-S-0 and no other text."),
				state(),
				reply,
			),
		).toBe(false);
		expect(
			hasPostTurnSemanticSignal(
				message("What time is it in Tokyo?"),
				state(),
				reply,
			),
		).toBe(false);
	});

	it("preserves Stage-1 evidence even when the lexical shortcut misses it", () => {
		for (const text of [
			"I generally prefer replies without emojis.",
			"Prefiero respuestas sin emojis.",
		]) {
			expect(hasPostTurnSemanticSignal(message(text), state(), reply)).toBe(
				false,
			);
			expect(
				hasPostTurnSemanticSignal(message(text), state(), reply, {
					facts: ["User prefers replies without emojis."],
				}),
			).toBe(true);
		}
		expect(
			hasPostTurnSemanticSignal(message("hi"), state(), reply, {
				facts: [],
				relationships: [],
			}),
		).toBe(false);
	});

	it("keeps reflection for durable user information", () => {
		expect(
			hasPostTurnSemanticSignal(
				message("I live in Berlin and my partner is Sam."),
				state(),
				reply,
			),
		).toBe(true);
	});

	it("keeps reflection after actions or non-reply terminal behavior", () => {
		expect(
			hasPostTurnSemanticSignal(
				message("Check it."),
				state([{ actionName: "WEB_SEARCH", success: true }]),
				reply,
			),
		).toBe(true);
		expect(
			hasPostTurnSemanticSignal(message("Stop."), state(), {
				actions: ["STOP"],
			}),
		).toBe(true);
	});
});
