/**
 * Regression for lossless rendering of a large evaluator section.
 *
 * Evaluator sections keep their extraction rules (head) and the newest context
 * (tail), so the assembled prompt carries two independent cut points. Both are
 * driven here through the real `EvaluatorService.run` and asserted on the
 * string handed to `useModel`, since that is the value a provider serializes.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Character, Memory } from "../types";
import { EvaluatorService } from "./evaluator";

const FOX = "\u{1F98A}";
const LARGE_SECTION_CHARS = 130_000;

function isWellFormed(value: string): boolean {
	const native = value as unknown as { isWellFormed?: () => boolean };
	if (typeof native.isWellFormed === "function") return native.isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorMiddleAgent",
			bio: "test",
			settings: { POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS: "1000000" },
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: {},
		data: {},
		text: "",
	}));
	runtime.emitEvent = vi.fn(async () => {});
	return runtime;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		entityId: "00000000-0000-0000-0000-000000000002" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

/**
 * Runs one turn whose single evaluator section is `body`. `descriptionPad`
 * shifts both section cut points by one character per added byte, which is what
 * moves them across a surrogate boundary.
 */
async function sectionPromptFor(
	body: string,
	descriptionPad = 0,
): Promise<string> {
	const runtime = makeRuntime();
	runtime.registerEvaluator({
		name: "alpha",
		description: `alpha section${".".repeat(descriptionPad)}`,
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prompt: () => body,
		parse: (output) => output as never,
		processors: [
			{ name: "storeAlpha", process: async () => ({ success: true }) },
		],
	});
	let captured: string | undefined;
	runtime.useModel = vi.fn(async (_modelType, params) => {
		captured = String(params.messages?.[0]?.content ?? "");
		return { alpha: { ok: true } };
	}) as AgentRuntime["useModel"];
	const result = await new EvaluatorService(runtime).run(makeMessage(), {
		values: {},
		data: {},
		text: "",
	});
	expect(result.errors).toEqual([]);
	expect(captured).toBeDefined();
	return captured as string;
}

describe("large evaluator sections are lossless and surrogate-safe", () => {
	it("never emits a lone surrogate at either cut across parities", async () => {
		const body = FOX.repeat(LARGE_SECTION_CHARS);
		const illFormed: number[] = [];
		for (let pad = 0; pad < 8; pad++) {
			const prompt = await sectionPromptFor(body, pad);
			expect(prompt).toContain(body);
			if (!isWellFormed(prompt)) illFormed.push(pad);
		}
		expect(illFormed).toEqual([]);
	}, 60_000);

	it("keeps the rules head and the newest tail of an oversized section", async () => {
		const body = `HEAD_RULES_SENTINEL${FOX.repeat(
			LARGE_SECTION_CHARS,
		)}TAIL_CONTEXT_SENTINEL`;
		const prompt = await sectionPromptFor(body);
		expect(isWellFormed(prompt)).toBe(true);
		expect(prompt).toContain("HEAD_RULES_SENTINEL");
		expect(prompt).toContain("TAIL_CONTEXT_SENTINEL");
		expect(prompt).toContain(body);
	}, 60_000);

	it("serializes to a provider body with no lone-surrogate escape", async () => {
		const prompt = await sectionPromptFor(FOX.repeat(LARGE_SECTION_CHARS), 1);
		const serialized = JSON.stringify({ messages: [{ content: prompt }] });
		expect(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(serialized)).toBe(false);
		expect(JSON.parse(serialized).messages[0].content).toBe(prompt);
	}, 60_000);

	it("passes a short section through untouched", async () => {
		const body = `Short evaluator section with ${FOX} emoji`;
		const prompt = await sectionPromptFor(body);
		expect(prompt).toContain(body);
		expect(prompt).toContain(body);
		expect(isWellFormed(prompt)).toBe(true);
	}, 60_000);
});
