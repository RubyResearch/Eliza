/**
 * Per-call size of the merged post-turn evaluator prompt. A schema-constrained
 * request carries the merged schema structurally and renders only a compact
 * outline in the prompt; the JSON-object / plain fallbacks spell the schema
 * out. Blocks two sections declare render once in the shared context, and each
 * shared action result keeps its head up to POST_TURN_EVALUATOR_RESULT_MAX_CHARS
 * (live 2026-09-14: 19,449 prompt tokens per call, 40% of them the schema
 * text, one 7.6K-char MEMORY result, the room entity list rendered twice).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import {
	identityEvaluator,
	relationshipEvaluator,
	successEvaluator,
} from "../features/advanced-capabilities/evaluators/reflection-items";
import { AgentRuntime } from "../runtime";
import { stringifyForModel } from "../runtime/json-output";
import { renderActionResultsForModel } from "../runtime/planner-rendering";
import type {
	ActionResult,
	Character,
	Entity,
	Evaluator,
	Memory,
	UUID,
} from "../types";
import { EvaluatorService } from "./evaluator";

const ENTITY_ID = "00000000-0000-0000-0000-000000000002";
const SCHEMA_TEXT_HEADING = "## Output JSON Schema\n";

type CapturedCall = { prompt: string; params: Record<string, unknown> };

function makeRuntime(settings: Character["settings"] = {}): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorPromptAgent",
			bio: "test",
			settings,
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
		entityId: ENTITY_ID as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

const alphaSchema = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		mood: { type: "string", enum: ["happy", "sad"] },
	},
	required: ["ok"],
	additionalProperties: false,
};

const betaSchema = {
	type: "object",
	properties: { items: { type: "array", items: { type: "string" } } },
	required: ["items"],
	additionalProperties: false,
};

function section(name: string, overrides: Partial<Evaluator> = {}): Evaluator {
	return {
		name,
		description: `${name} section`,
		schema: alphaSchema,
		shouldRun: async () => true,
		prompt: () => `Extract ${name}.`,
		parse: (output) => output as never,
		...overrides,
	};
}

function captureModel(
	runtime: AgentRuntime,
	respond: (call: number) => unknown,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	runtime.useModel = vi.fn(async (_modelType, params) => {
		calls.push({
			prompt: String(params.messages?.[0]?.content ?? ""),
			params: params as unknown as Record<string, unknown>,
		});
		return respond(calls.length);
	}) as AgentRuntime["useModel"];
	return calls;
}

describe("post-turn evaluator prompt size", () => {
	it("sends the merged schema structurally and keeps the complete compact contract in the prompt", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator(section("alpha"));
		runtime.registerEvaluator(section("beta", { schema: betaSchema }));
		const calls = captureModel(runtime, () => ({
			alpha: { ok: true },
			beta: { items: [] },
		}));

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(result.errors).toEqual([]);
		expect(result.processedEvaluators).toEqual(["alpha", "beta"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		const mergedSchema = {
			type: "object",
			properties: { alpha: alphaSchema, beta: betaSchema },
			required: ["alpha", "beta"],
			additionalProperties: false,
		};
		expect(call?.params.responseSchema).toEqual(mergedSchema);
		expect(call?.params.responseFormat).toEqual({ type: "json_object" });
		const prompt = call?.prompt ?? "";
		// Compact JSON, never the indented form: the same contract without the
		// indentation that consumed thousands of input tokens per call.
		expect(prompt).toContain(
			`${SCHEMA_TEXT_HEADING}${JSON.stringify(mergedSchema)}\n\n`,
		);
		expect(prompt).not.toContain(stringifyForModel(mergedSchema));
		expect(prompt.indexOf(SCHEMA_TEXT_HEADING)).toBeLessThan(
			prompt.indexOf("Latest message:"),
		);
		expect(prompt.indexOf("### beta")).toBeLessThan(
			prompt.indexOf(SCHEMA_TEXT_HEADING),
		);
	});

	it("keeps the identical complete contract on the JSON-object and plain fallbacks", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator(section("alpha"));
		const calls = captureModel(runtime, (call) => {
			if (call === 1) throw new Error("response schema unsupported here");
			if (call === 2) throw new Error("Bad Request");
			return { alpha: { ok: true } };
		});

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(result.errors).toEqual([]);
		expect(result.processedEvaluators).toEqual(["alpha"]);
		expect(calls).toHaveLength(3);
		const [structural, jsonObject, plain] = calls;
		expect(structural?.params).toHaveProperty("responseSchema");
		expect(jsonObject?.params).not.toHaveProperty("responseSchema");
		expect(jsonObject?.params.responseFormat).toEqual({
			type: "json_object",
		});
		expect(plain?.params).not.toHaveProperty("responseSchema");
		expect(plain?.params).not.toHaveProperty("responseFormat");
		const schemaText = `${SCHEMA_TEXT_HEADING}${JSON.stringify(structural?.params.responseSchema)}\n\n`;
		expect(structural?.prompt).toContain(schemaText);
		// Same prompt on every rung; only the wire contract differs.
		expect(jsonObject?.prompt).toBe(structural?.prompt);
		expect(plain?.prompt).toBe(structural?.prompt);
		expect(structural?.prompt.indexOf(SCHEMA_TEXT_HEADING)).toBeLessThan(
			structural?.prompt.indexOf("Latest message:") ?? -1,
		);
		// A schema-specific rejection arms the memo: the next turn skips straight
		// to the JSON-object request and its prompt carries the schema text.
		await new EvaluatorService(runtime).run(makeMessage());
		expect(calls).toHaveLength(4);
		expect(calls[3]?.params).not.toHaveProperty("responseSchema");
		expect(calls[3]?.prompt).toContain(schemaText);
	});

	it("renders a block two sections declare once in the shared context", async () => {
		const runtime = makeRuntime();
		const block = `- Nubs (ID: ${ENTITY_ID})\n- Eliza (ID: 00000000-0000-0000-0000-000000000099)`;
		const withBlock = (name: string): Evaluator =>
			section(name, {
				sharedBlocks: () => ({ "Entities in Room": block }),
				prompt: ({ shared }) =>
					shared?.blocks?.["Entities in Room"] === block
						? `${name}: see shared entities`
						: `${name}: OWN COPY\nEntities in Room:\n${block}`,
			});
		runtime.registerEvaluator(withBlock("relationships"));
		runtime.registerEvaluator(withBlock("identities"));
		const calls = captureModel(runtime, () => ({
			relationships: { ok: true },
			identities: { ok: true },
		}));

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(result.errors).toEqual([]);
		const prompt = calls[0]?.prompt ?? "";
		expect(prompt.split(block)).toHaveLength(2);
		expect(prompt).toContain(`\nEntities in Room:\n${block}\n`);
		expect(prompt.indexOf("Entities in Room:")).toBeGreaterThan(
			prompt.indexOf("Provider context:"),
		);
		expect(prompt.indexOf("Entities in Room:")).toBeLessThan(
			prompt.indexOf("## Active Evaluators"),
		);
		expect(prompt).toContain("relationships: see shared entities");
		expect(prompt).toContain("identities: see shared entities");
		expect(prompt).not.toContain("OWN COPY");
	});

	it("renders the room entity list once for the relationship and identity evaluators", async () => {
		const runtime = makeRuntime();
		const entities: Entity[] = [
			{
				id: ENTITY_ID as Entity["id"],
				agentId: runtime.agentId,
				names: ["Nubs"],
				metadata: {},
			},
			{
				id: runtime.agentId,
				agentId: runtime.agentId,
				names: ["EvaluatorPromptAgent"],
				metadata: {},
			},
		];
		runtime.getRoom = vi.fn(async (roomId: UUID) => ({
			id: roomId,
			source: "test",
		})) as unknown as AgentRuntime["getRoom"];
		runtime.getEntitiesForRoom = vi.fn(
			async () => entities,
		) as AgentRuntime["getEntitiesForRoom"];
		runtime.registerEvaluator({ ...relationshipEvaluator, processors: [] });
		runtime.registerEvaluator({ ...identityEvaluator, processors: [] });
		const calls = captureModel(runtime, () => ({
			relationships: { relationships: [] },
			identities: { identities: [] },
		}));

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(result.errors).toEqual([]);
		expect(result.processedEvaluators).toEqual(["relationships", "identities"]);
		const prompt = calls[0]?.prompt ?? "";
		expect(prompt.split(`- Nubs (ID: ${ENTITY_ID})`)).toHaveLength(2);
		// One real list in the shared context (participant order is the loader's).
		expect(prompt.split("\nEntities in Room:\n")).toHaveLength(2);
		expect(prompt).toMatch(
			new RegExp(
				`\\nEntities in Room:\\n(?:- .*\\n)*- Nubs \\(ID: ${ENTITY_ID}\\)\\n`,
			),
		);
		expect(
			prompt.split(
				'Entities in Room: see "Entities in Room" in the Shared Turn Context above.',
			),
		).toHaveLength(3);
	});

	it("caps each shared action result at POST_TURN_EVALUATOR_RESULT_MAX_CHARS and keeps the success section on the shared copy", async () => {
		const runtime = makeRuntime({
			POST_TURN_EVALUATOR_RESULT_MAX_CHARS: "400",
		});
		runtime.registerEvaluator({ ...successEvaluator, processors: [] });
		const actionResults: ActionResult[] = [
			{
				success: true,
				text: "Forgot 1 memory record(s) matching favorite tea",
				data: {
					actionName: "MEMORY",
					op: "delete",
					effectReceipts: Array.from({ length: 40 }, (_, index) => ({
						receiptId: `memory-mutation-receipt-v1:${"a".repeat(64)}`,
						index,
					})),
					tail: "TAIL-MARKER",
				},
			},
		];
		const calls = captureModel(runtime, () => ({
			success: { completed: true, reason: "The record is gone." },
		}));

		const result = await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: { actionResults },
			text: "",
		});

		expect(result.errors).toEqual([]);
		const prompt = calls[0]?.prompt ?? "";
		const complete = renderActionResultsForModel(actionResults).text;
		const capped = renderActionResultsForModel(actionResults, {
			maxCharsPerResult: 400,
		}).text;
		expect(complete.length).toBeGreaterThan(4_000);
		expect(capped.length).toBeLessThan(600);
		expect(prompt).toContain(capped);
		expect(prompt).not.toContain("TAIL-MARKER");
		expect(prompt).toMatch(/\[truncated: \d+ of \d+ chars omitted\]/);
		expect(prompt.split("1. MEMORY - succeeded")).toHaveLength(2);
		expect(prompt).toContain(
			'Action results: see "Action results" in the Shared Turn Context above.',
		);
	});

	it("keeps short action results complete under the default cap", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator(section("alpha"));
		const actionResults: ActionResult[] = [
			{
				success: false,
				error: "Calendar write failed after the note update.",
				data: { actionName: "CALENDAR_UPDATE_EVENT", eventId: "event-19" },
			},
		];
		const calls = captureModel(runtime, () => ({ alpha: { ok: true } }));

		await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: { actionResults },
			text: "",
		});

		const prompt = calls[0]?.prompt ?? "";
		expect(prompt).toContain(renderActionResultsForModel(actionResults).text);
		expect(prompt).not.toContain("[truncated:");
	});
});
