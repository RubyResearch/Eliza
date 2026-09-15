/**
 * Deterministic pre-gate for the facts/relationships stage: when this turn's
 * MEMORY create/update already stored a text covering the whole user message,
 * the TEXT_LARGE validation call is skipped and the skip is reported on the
 * result. A message carrying more than the stored fact, a polarity flip, a
 * relationship candidate, a failed action, or no memory action at all still
 * run the model. Mock runtime like facts-and-relationships.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	type FactsStageExecutedTool,
	planNamesMemoryMutation,
	runFactsAndRelationshipsStage,
} from "../facts-and-relationships";

type FactsRuntime = IAgentRuntime & {
	useModel: ReturnType<typeof vi.fn>;
	getMemories: ReturnType<typeof vi.fn>;
	logger: IAgentRuntime["logger"] & { info: ReturnType<typeof vi.fn> };
};

const MODEL_RESPONSE = JSON.stringify({
	facts: [],
	relationships: [],
	thought: "already covered",
});

function makeRuntime(): FactsRuntime {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		character: { name: "Eliza", system: "You are concise.", bio: "" },
		actions: [],
		providers: [],
		getSetting: vi.fn(() => undefined),
		redactSecrets: vi.fn((text: string) => text),
		useModel: vi.fn(async () => MODEL_RESPONSE),
		getMemories: vi.fn(async () => []),
		getRelationships: vi.fn(async () => []),
		getRoom: vi.fn(async () => ({
			id: "00000000-0000-0000-0000-000000000003" as UUID,
			source: "test",
		})),
		getEntitiesForRoom: vi.fn(async () => []),
		reportError: vi.fn(),
		createMemory: vi.fn(async () => "00000000-0000-0000-0000-00000000cccc"),
		createRelationship: vi.fn(async () => true),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	};
	return runtime as unknown as FactsRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text, source: "discord" },
		createdAt: 1,
	};
}

const state: State = { values: {}, data: { providers: {} }, text: "" };

function memoryCreate(text: string, success = true): FactsStageExecutedTool {
	return {
		name: "MEMORY_CREATE",
		result: {
			success,
			data: {
				actionName: "MEMORY_CREATE",
				op: "create",
				memoryId: "5d2a3bcc-767c-477b-b198-5610cc5435ca",
				text,
			},
		},
	};
}

describe("facts stage skip when the MEMORY action stored the whole message", () => {
	it("skips the model call when MEMORY_CREATE stored a text covering the message", async () => {
		// Live 2026-09-13 19:34Z: MEMORY_CREATE stored "The user's current favorite
		// tea is Darjeeling." while the parallel TEXT_LARGE call returned nothing.
		const runtime = makeRuntime();
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(
				"Eliza (@1490833425802854491) remember that my favorite tea is darjeeling",
			),
			state,
			extract: { facts: ["User's favorite tea is darjeeling"] },
			executedTools: [
				memoryCreate("The user's current favorite tea is Darjeeling."),
			],
		});
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.getMemories).not.toHaveBeenCalled();
		expect(result.skipReason).toBe("memory_action_stored_message");
		expect(result.rawResponse).toBeUndefined();
		expect(result.written).toEqual({ facts: 0, relationships: 0 });
		expect(runtime.logger.info).toHaveBeenCalledTimes(1);
	});

	it("honours a MEMORY_UPDATE whose rewritten row covers the message", async () => {
		const runtime = makeRuntime();
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage("remember that my favorite tea is assam now"),
			state,
			extract: { facts: ["User's favorite tea is assam"] },
			executedTools: [
				{
					name: "MEMORY",
					result: {
						success: true,
						data: {
							actionName: "MEMORY",
							op: "update",
							memory: {
								content: { text: "The user's favorite tea is now Assam." },
							},
						},
					},
				},
			],
		});
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(result.skipReason).toBe("memory_action_stored_message");
	});

	it("runs the model when the message carries a fact beyond the stored one", async () => {
		const runtime = makeRuntime();
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(
				"Eliza remember that my favorite tea is darjeeling and I live in Austin",
			),
			state,
			extract: {
				facts: ["User's favorite tea is darjeeling", "User lives in Austin"],
			},
			executedTools: [
				memoryCreate("The user's current favorite tea is Darjeeling."),
			],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.skipReason).toBeUndefined();
	});

	it("runs the model when the stored text flips the claim's polarity", async () => {
		const runtime = makeRuntime();
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage("remember that I do not drink coffee"),
			state,
			extract: { facts: ["User does not drink coffee"] },
			executedTools: [memoryCreate("The user will drink coffee.")],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("runs the model when Stage 1 also extracted a relationship", async () => {
		const runtime = makeRuntime();
		await runFactsAndRelationshipsStage({
			runtime,
			// "Bob" is under the stage's four-character low-signal floor and would
			// be filtered before the skip guard ever saw a relationship.
			message: makeMessage("remember that Robert is my manager"),
			state,
			extract: {
				facts: ["Robert is the user's manager"],
				relationships: [
					{ subject: "user", predicate: "reports_to", object: "Robert" },
				],
			},
			executedTools: [memoryCreate("Robert is the user's manager.")],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("runs the model when the memory action failed", async () => {
		const runtime = makeRuntime();
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage("remember that my favorite tea is darjeeling"),
			state,
			extract: { facts: ["User's favorite tea is darjeeling"] },
			executedTools: [
				memoryCreate("The user's favorite tea is Darjeeling.", false),
			],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("runs the model when no memory action executed", async () => {
		for (const executedTools of [undefined, []]) {
			const runtime = makeRuntime();
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage("my favorite tea is darjeeling"),
				state,
				extract: { facts: ["User's favorite tea is darjeeling"] },
				executedTools,
			});
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
			expect(result.skipReason).toBeUndefined();
		}
	});
});

describe("planNamesMemoryMutation", () => {
	it("recognises MEMORY create/update candidates and deterministic calls only", () => {
		expect(
			planNamesMemoryMutation({ candidateActions: ["MEMORY_CREATE"] }),
		).toBe(true);
		expect(
			planNamesMemoryMutation({
				candidateActions: ["CALENDAR", "memory_update"],
			}),
		).toBe(true);
		expect(
			planNamesMemoryMutation({ deterministicToolCall: { name: "MEMORY" } }),
		).toBe(true);
		expect(
			planNamesMemoryMutation({
				candidateActions: ["MEMORY_DELETE", "CALENDAR"],
			}),
		).toBe(false);
		expect(planNamesMemoryMutation({})).toBe(false);
	});
});
