/**
 * Covers the Stage-1 facts/relationships extraction: parseFactsAndRelationshipsOutput
 * across the text and tool-call (arguments/input/args/params) response shapes, and
 * runFactsAndRelationshipsStage's candidate filtering, secret-like redaction,
 * persistence, and voice/text extraction parity. Deterministic — a mock runtime
 * whose useModel/getMemories/createMemory are vi.fn, no live model or DB.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import { ChannelType, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	parseFactsAndRelationshipsOutput,
	runFactsAndRelationshipsStage,
} from "../facts-and-relationships";

type FactsRuntime = IAgentRuntime & {
	useModel: ReturnType<typeof vi.fn>;
};

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text: "my birthday is March 5", source: "test" },
		createdAt: 1,
	};
}

// The facts stage no longer scrapes room entities off the Stage-1 provider
// state (that path was dead — it read data.entities but the ENTITIES provider
// publishes data.entitiesData, and #13195 defers the provider off Stage-1
// entirely). Room entities are now fetched directly via getEntityDetails, which
// the mock runtime backs with getRoom + getEntitiesForRoom below. State is
// therefore just an empty carrier here.
function makeState(): State {
	return {
		values: {},
		data: { providers: {} },
		text: "",
	};
}

function makeRuntime(
	modelResponse: unknown,
	settings: Record<string, string> = {},
): FactsRuntime {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		character: { name: "Eliza", system: "You are concise.", bio: "" },
		actions: [],
		providers: [],
		getSetting: vi.fn((key: string) => settings[key]),
		redactSecrets: vi.fn((text: string) =>
			text.replace(/\b(?:sk|csk)-[A-Za-z0-9_-]+/g, "[REDACTED]"),
		),
		useModel: vi.fn(async (_modelType: string) => {
			return modelResponse;
		}),
		getMemories: vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbbb" as UUID,
				entityId: "00000000-0000-0000-0000-000000000001" as UUID,
				agentId: "00000000-0000-0000-0000-000000000002" as UUID,
				roomId: "00000000-0000-0000-0000-000000000003" as UUID,
				content: { text: "the user's birthday is 1990-03-05", type: "fact" },
				createdAt: 0,
			} as Memory,
		]),
		getRelationships: vi.fn(async () => []),
		// Backs getEntityDetails({ runtime, roomId }) — the facts stage now sources
		// room entities here instead of scraping Stage-1 provider state (#13196).
		getRoom: vi.fn(async () => ({
			id: "00000000-0000-0000-0000-000000000003" as UUID,
			source: "test",
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				names: ["Alice"],
				components: [],
				metadata: {},
			},
			{
				id: "00000000-0000-0000-0000-0000000000b2" as UUID,
				names: ["Bob"],
				components: [],
				metadata: {},
			},
		]),
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
	return runtime as FactsRuntime;
}

describe("parseFactsAndRelationshipsOutput", () => {
	it("rejects empty input instead of fabricating an empty extraction", () => {
		expect(() => parseFactsAndRelationshipsOutput("")).toThrow(
			expect.objectContaining({ code: "FACTS_MODEL_OUTPUT_MISSING" }),
		);
	});

	it("parses text-shape JSON output", () => {
		const result = parseFactsAndRelationshipsOutput(
			JSON.stringify({
				facts: ["the user's birthday is 1990-03-05"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "kept one fact and one rel",
			}),
		);
		expect(result.facts).toEqual([
			{ subject: "user", fact: "the user's birthday is 1990-03-05" },
		]);
		expect(result.relationships).toEqual([
			{ subject: "user", predicate: "works_with", object: "Alice" },
		]);
		expect(result.thought).toBe("kept one fact and one rel");
	});

	it("parses tool-call shape (toolCalls[0].arguments)", () => {
		const result = parseFactsAndRelationshipsOutput({
			toolCalls: [
				{
					arguments: {
						facts: ["a"],
						relationships: [],
						thought: "ok",
					},
				},
			],
		});
		expect(result.facts).toEqual([{ subject: "user", fact: "a" }]);
	});

	it("parses AI SDK v5 / Cerebras tool-call shape (toolCalls[0].input)", () => {
		// Live regression on 2026-05-28 (tj-80ba4e3920d7bd): the user said
		// "my dogs name is Jeff", Stage 1 extracted the fact, and the validate
		// model returned a correct tool call — but the args were under `input`
		// (AI SDK v5 / Cerebras gpt-oss-120b shape), not `arguments`. The old
		// extractText only read `arguments`, so the parse came back empty and
		// the fact was silently dropped (written.facts=0). Nothing persisted,
		// so cross-turn recall only worked while the source message stayed in
		// the recent-message window. Pin all tool-arg field names.
		const result = parseFactsAndRelationshipsOutput({
			text: "",
			toolCalls: [
				{
					type: "tool-call",
					toolName: "FACTS_AND_RELATIONSHIPS_VALIDATE",
					input: {
						facts: ["my dog's name is Jeff"],
						relationships: [
							{ subject: "user", predicate: "has_dog_named", object: "Jeff" },
						],
						thought: "new, not duplicated",
					},
				},
			],
		});
		expect(result.facts).toEqual([
			{ subject: "user", fact: "my dog's name is Jeff" },
		]);
		expect(result.relationships).toEqual([
			{ subject: "user", predicate: "has_dog_named", object: "Jeff" },
		]);
	});

	it("prefers structured tool-call args over conversational preamble text", () => {
		// Providers running with toolChoice "required" can still emit a
		// conversational preamble in `text` ("Here are the extracted facts:")
		// alongside the real structured payload in toolCalls. Reading the
		// preamble first fails the JSON parse and crashes the stage with
		// FACTS_MODEL_OUTPUT_INVALID, so the tool-call args must win.
		const result = parseFactsAndRelationshipsOutput({
			text: "Here are the extracted facts:",
			toolCalls: [
				{
					arguments:
						'{"facts":["Alice lives in Paris"],"relationships":[],"thought":"dedup"}',
				},
			],
		});
		expect(result.facts).toEqual([
			{ subject: "user", fact: "Alice lives in Paris" },
		]);
	});

	it("falls back to text when the tool call carries no usable args", () => {
		const result = parseFactsAndRelationshipsOutput({
			text: '{"facts":["b"],"relationships":[],"thought":"t"}',
			toolCalls: [{ type: "tool-call" }],
		});
		expect(result.facts).toEqual([{ subject: "user", fact: "b" }]);
	});

	it("parses tool-call args under `args` and `params` keys too", () => {
		const viaArgs = parseFactsAndRelationshipsOutput({
			toolCalls: [{ args: { facts: ["x"], relationships: [], thought: "" } }],
		});
		expect(viaArgs.facts).toEqual([{ subject: "user", fact: "x" }]);
		const viaParams = parseFactsAndRelationshipsOutput({
			toolCalls: [{ params: { facts: ["y"], relationships: [], thought: "" } }],
		});
		expect(viaParams.facts).toEqual([{ subject: "user", fact: "y" }]);
	});

	it("rejects malformed relationship entries instead of silently dropping them", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				JSON.stringify({
					facts: [],
					relationships: [
						{ subject: "user", predicate: "", object: "Alice" },
						{ subject: "user", predicate: "manages", object: "Bob" },
					],
					thought: "",
				}),
			),
		).toThrow(expect.objectContaining({ code: "FACTS_RELATIONSHIP_INVALID" }));
	});
});

describe("runFactsAndRelationshipsStage", () => {
	it("short-circuits when extract has no candidates", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {},
		});
		expect(result.parsed.facts).toEqual([]);
		expect(result.parsed.relationships).toEqual([]);
		expect(result.written).toEqual({ facts: 0, relationships: 0 });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("composes a system+user prompt with candidates and existing context", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user's birthday is March 5"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				facts: ["the user's birthday is March 5"],
			},
		});

		// Existing facts are fetched and keyword-ranked without embeddings.
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "facts",
				roomId: expect.any(String),
			}),
		);
		expect(runtime.useModel).not.toHaveBeenCalledWith(
			ModelType.TEXT_EMBEDDING,
			expect.anything(),
		);

		// Existing relationships fetched
		expect(runtime.getRelationships).toHaveBeenCalledWith(
			expect.objectContaining({
				entityIds: expect.any(Array),
			}),
		);

		// Validation model call uses messages, not prompt
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		expect(validationCall).toBeDefined();
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
			prompt?: string;
		};
		expect(params.prompt).toBeUndefined();
		expect(params.messages?.[0]?.role).toBe("system");
		expect(params.messages?.[1]?.role).toBe("user");
		expect(params.messages?.[1]?.content).toContain("candidates:");
		expect(params.messages?.[1]?.content).toContain("- fact: the user's");
		expect(params.messages?.[1]?.content).toContain("existing_similar_facts:");
		expect(params.messages?.[1]?.content).toContain("room_entities:");
		expect(params.messages?.[1]?.content).toContain(
			"Alice (id: 00000000-0000-0000-0000-0000000000a1)",
		);

		// Result parsed and persisted
		expect(result.parsed.facts).toEqual([
			{ subject: "user", fact: "the user's birthday is March 5" },
		]);
		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					text: "the user's birthday is March 5",
					type: "fact",
				}),
				metadata: expect.objectContaining({
					source: "facts_and_relationships_stage",
					tags: expect.arrayContaining(["fact", "extracted", "stage1"]),
					keywords: expect.arrayContaining(["birthday", "march"]),
					// Stage-1 facts are unverified single-message extractions: they
					// must be classified as time-decaying `current` (not the reader's
					// `durable` default) with explicit confidence/category/validAt so
					// they never persist as permanent durable identity claims.
					kind: "current",
					category: "uncategorized",
					confidence: 0.6,
					verificationStatus: "self_reported",
					validAt: expect.any(String),
				}),
			}),
			"facts",
			true,
		);
	});

	it("skips a Stage-1 fact an explicit MEMORY create already stored durably for the same message", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["prefers oat milk in coffee"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb1" as UUID,
				entityId: message.entityId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: {
					text: "User prefers oat milk in coffee.",
					source: "MEMORY",
				},
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					category: "preference",
					messageId: message.id,
					keywords: ["preference"],
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["prefers oat milk in coffee"] },
		});

		expect(result.parsed.facts).toEqual([
			{ subject: "user", fact: "prefers oat milk in coffee" },
		]);
		expect(result.written.facts).toBe(0);
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("skips a Stage-1 fact when the same-message MEMORY row names the subject possessively", async () => {
		// Live 2026-09-06 17:57Z: "remember that my favorite tea is hojicha" →
		// MEMORY stored "The user's favorite tea is hojicha"; Stage-1 kept
		// "favorite tea is hojicha"; both persisted and the later forget hit
		// MEMORY_AMBIGUOUS_QUERY.
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["favorite tea is hojicha"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb2" as UUID,
				entityId: message.entityId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: {
					text: "The user's favorite tea is hojicha",
					source: "MEMORY",
				},
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					category: "preference",
					messageId: message.id,
					keywords: ["tea", "favorite", "hojicha"],
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["favorite tea is hojicha"] },
		});

		expect(result.written.facts).toBe(0);
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("credits a fact to the author when the model names the author's connector display name shared by another participant", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [{ subject: "nubs-e2e", fact: "favorite tea is assam" }],
				relationships: [],
				thought: "the author stated a preference",
			}),
		);
		runtime.getEntitiesForRoom = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				names: ["nubs-e2e", "eliza-e2e"],
				components: [],
				metadata: {},
			},
		]);
		const message = {
			...makeMessage(),
			content: {
				text: "remember that my favorite tea is assam",
				source: "discord",
				name: "nubs-e2e",
			},
			metadata: { type: "message", entityName: "nubs-e2e" },
		} as Memory;

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["favorite tea is assam"] },
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: message.entityId,
				metadata: expect.objectContaining({
					subject: "nubs-e2e",
					subjectResolved: true,
				}),
			}),
			"facts",
			true,
		);
	});

	it("leaves a subject unresolved when several bystanders share the alias instead of crediting the first", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [{ subject: "Sam", fact: "moved to Lisbon" }],
				relationships: [],
				thought: "a third party",
			}),
		);
		runtime.getEntitiesForRoom = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				names: ["Sam"],
				components: [],
				metadata: {},
			},
			{
				id: "00000000-0000-0000-0000-0000000000b2" as UUID,
				names: ["Sam", "Samantha"],
				components: [],
				metadata: {},
			},
		]);
		const message = makeMessage();

		await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["Sam moved to Lisbon"] },
		});

		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: message.entityId,
				metadata: expect.objectContaining({
					subject: "Sam",
					subjectResolved: false,
				}),
			}),
			"facts",
			true,
		);
	});

	it("suppresses only the author's own fact: a third-person fact in the same message persists under that participant", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [
					{ subject: "user", fact: "prefers oat milk" },
					{ subject: "Bob", fact: "prefers oat milk too" },
				],
				relationships: [],
				thought: "two subjects",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb5" as UUID,
				entityId: message.entityId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: { text: "User prefers oat milk.", source: "MEMORY" },
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					category: "preference",
					messageId: message.id,
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: {
				facts: ["prefers oat milk", "Bob prefers oat milk too"],
			},
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-0000000000b2",
				content: expect.objectContaining({ text: "prefers oat milk too" }),
				metadata: expect.objectContaining({
					subject: "Bob",
					subjectResolved: true,
				}),
			}),
			"facts",
			true,
		);
	});

	it("never suppresses a fact whose subject the room could not resolve, even when the author's durable row matches", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [{ subject: "Carol", fact: "prefers oat milk" }],
				relationships: [],
				thought: "unresolved subject",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb6" as UUID,
				entityId: message.entityId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: { text: "User prefers oat milk.", source: "MEMORY" },
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					messageId: message.id,
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["Carol prefers oat milk"] },
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: message.entityId,
				metadata: expect.objectContaining({
					subject: "Carol",
					subjectResolved: false,
					kind: "current",
				}),
			}),
			"facts",
			true,
		);
	});

	it("still persists a Stage-1 fact when the same-message durable row has the opposite polarity", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["likes oat milk"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb3" as UUID,
				entityId: message.entityId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: { text: "User does not like oat milk." },
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					messageId: message.id,
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["likes oat milk"] },
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
	});

	it("ignores a same-message durable row authored by another participant", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["prefers oat milk in coffee"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const message = makeMessage();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb4" as UUID,
				entityId: "00000000-0000-0000-0000-0000000000b2" as UUID,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: { text: "User prefers oat milk in their coffee." },
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					messageId: message.id,
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: { facts: ["prefers oat milk in coffee"] },
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
	});

	it("still persists a Stage-1 fact when the durable row belongs to another message", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["prefers oat milk in coffee"],
				relationships: [],
				thought: "new fact",
			}),
		);
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbb2" as UUID,
				entityId: "00000000-0000-0000-0000-000000000001" as UUID,
				agentId: runtime.agentId,
				roomId: "00000000-0000-0000-0000-000000000003" as UUID,
				content: { text: "User prefers oat milk in their coffee." },
				metadata: {
					type: "custom",
					source: "MEMORY",
					kind: "durable",
					messageId: "00000000-0000-0000-0000-00000000a0a0",
				},
				createdAt: 2,
			} as Memory,
		]);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["prefers oat milk in coffee"] },
		});

		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
	});

	it("carries the provider that served THIS TEXT_LARGE call on the result (#13623)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({ facts: ["a fact"], relationships: [], thought: "t" }),
		);
		// The facts stage must capture the provider synchronously at call time; the
		// mock resolves TEXT_LARGE via "cerebras".
		(
			runtime as unknown as {
				getLastResolvedModelProvider: (m: string) => string | undefined;
			}
		).getLastResolvedModelProvider = vi.fn((modelType: string) =>
			modelType === ModelType.TEXT_LARGE ? "cerebras" : undefined,
		);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["a fact"] },
		});

		expect(result.provider).toBe("cerebras");
	});

	it("leaves provider undefined (never fabricated) when the runtime can't report it (#13623)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({ facts: ["a fact"], relationships: [], thought: "t" }),
		);
		// No getLastResolvedModelProvider on this runtime — the optional call must
		// leave provider undefined, not fabricate a value.
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["a fact"] },
		});

		expect(result.provider).toBeUndefined();
	});

	// #13196: room-entity grounding must come from getEntityDetails, NOT from
	// scraping the Stage-1 provider state. Two prior defects made the old path
	// dead: (1) it read state...providers.ENTITIES.data.entities but the ENTITIES
	// provider publishes data.entitiesData, and (2) #13195 deferred the ENTITIES
	// provider off the Stage-1 execution path entirely, so the state has no
	// ENTITIES entry to scrape. Prove the grounding survives an EMPTY Stage-1
	// state as long as the room has participants.
	it("grounds room_entities from getEntityDetails even when Stage-1 state carries no ENTITIES entry (#13196)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user works with Alice"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "new",
			}),
		);
		// Empty state: no providers.ENTITIES at all (matches post-#13195 Stage-1).
		const emptyState: State = {
			values: {},
			data: { providers: {} },
			text: "",
		};
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: emptyState,
			extract: {
				facts: ["the user works with Alice"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
			},
		});

		// Room entities came from getEntityDetails, not state.
		expect(runtime.getEntitiesForRoom).toHaveBeenCalledWith(
			makeMessage().roomId,
			true,
		);
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		// The room_entities: grounding block is present with the resolved UUID
		// (the whole point of the audit's "prefer that UUID" rule).
		expect(params.messages?.[1]?.content).toContain("room_entities:");
		expect(params.messages?.[1]?.content).toContain(
			"Alice (id: 00000000-0000-0000-0000-0000000000a1)",
		);
		// And persist-time name->UUID resolution used the room entity: the
		// relationship edge's target resolves to Alice's UUID (not undefined).
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					sourceEntityId: makeMessage().entityId,
					targetEntityId: "00000000-0000-0000-0000-0000000000a1",
				}),
			}),
			"facts",
			true,
		);
		expect(result.written.relationships).toBe(1);
	});

	// #13196 P2 (codex): getEntityDetails returns EVERY room participant (no
	// display cap), so a busy room must not flood the room_entities: prompt
	// block. The grounding set is bounded to 12, prioritizing entities whose
	// names match a candidate relationship subject/object.
	it("preserves every room entity in relationship validation context", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Zoey" },
				],
				thought: "new",
			}),
		);
		// 40 participants; "Zoey" (candidate object) is intentionally last so a
		// prefix cap would drop it.
		const many = Array.from({ length: 39 }, (_, i) => ({
			id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, "0")}` as UUID,
			names: [`Person${i}`],
			components: [],
			metadata: {},
		}));
		const zoe = {
			id: "00000000-0000-0000-0000-0000000000a9" as UUID,
			names: ["Zoey"],
			components: [],
			metadata: {},
		};
		(
			runtime.getEntitiesForRoom as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce([...many, zoe]);
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: { values: {}, data: { providers: {} }, text: "" },
			extract: {
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Zoey" },
				],
			},
		});
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		const content = params.messages?.[1]?.content ?? "";
		// Isolate just the room_entities: block (blocks are separated by a blank
		// line), so the candidate lines (also `- ` prefixed) aren't miscounted.
		const roomBlock =
			content
				.split("\n\n")
				.find((block) => block.startsWith("room_entities:")) ?? "";
		const entityLines = roomBlock
			.split("\n")
			.filter((line) => line.startsWith("- "));
		expect(entityLines.length).toBe(40);
		// The candidate-named entity remains present without prioritization loss.
		expect(content).toContain("Zoey (id:");
	});

	// Fail-closed: a broken getEntityDetails must surface via reportError and
	// degrade to no grounding, never crash the stage (error-policy:J7).
	it("reports and degrades (no crash) when room-entity fetch fails (#13196)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user's birthday is March 5"],
				relationships: [],
				thought: "ok",
			}),
		);
		(
			runtime.getEntitiesForRoom as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("boom"));
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: { values: {}, data: { providers: {} }, text: "" },
			extract: { facts: ["the user's birthday is March 5"] },
		});
		// Stage still completed and persisted the fact.
		expect(result.written.facts).toBe(1);
		// Failure surfaced, not swallowed.
		expect(runtime.reportError).toHaveBeenCalledWith(
			"FactsAndRelationships.fetchRoomEntities",
			expect.any(Error),
			expect.objectContaining({ roomId: makeMessage().roomId }),
		);
		// No room_entities: block when grounding is unavailable.
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		expect(params.messages?.[1]?.content).not.toContain("room_entities:");
	});

	it("renders uuid relationship ends as names: the speaker's own id becomes User, a room entity its name", async () => {
		const speaker = makeMessage().entityId as string;
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: speaker, predicate: "has_dog", object: "Biscuit" },
					{
						subject: "user",
						predicate: "works_with",
						object: "00000000-0000-0000-0000-0000000000a1",
					},
					{
						subject: "user",
						predicate: "knows",
						object: "99999999-0000-0000-0000-000000000000",
					},
				],
				thought: "three rels",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{ subject: speaker, predicate: "has_dog", object: "Biscuit" },
					{
						subject: "user",
						predicate: "works_with",
						object: "00000000-0000-0000-0000-0000000000a1",
					},
					{
						subject: "user",
						predicate: "knows",
						object: "99999999-0000-0000-0000-000000000000",
					},
				],
			},
		});
		expect(result.written.relationships).toBe(2);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({ text: "User has_dog Biscuit" }),
			}),
			"facts",
			true,
		);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({ text: "user works_with Alice" }),
			}),
			"facts",
			true,
		);
	});

	it("renders the agent and another owner's raw UUIDs without assigning either to the speaker", async () => {
		const ownerId = "00000000-0000-0000-0000-000000000009" as UUID;
		const agentId = makeMessage().agentId;
		const relationships = [
			{ subject: agentId, predicate: "works_with", object: "Alice" },
			{ subject: ownerId, predicate: "works_with", object: "Alice" },
		];
		const runtime = makeRuntime(
			JSON.stringify({ facts: [], relationships, thought: "named identities" }),
			{ ELIZA_ADMIN_ENTITY_ID: ownerId },
		);
		vi.mocked(runtime.getEntitiesForRoom).mockResolvedValueOnce([
			{ id: ownerId, names: ["Morgan"], agentId },
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				names: ["Alice"],
				agentId,
			},
		]);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { relationships },
		});
		expect(result.written.relationships).toBe(2);
		for (const [subject, sourceEntityId] of [
			["Eliza", agentId],
			["Morgan", ownerId],
		]) {
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({
						text: `${subject} works_with Alice`,
					}),
					metadata: expect.objectContaining({ sourceEntityId }),
				}),
				"facts",
				true,
			);
		}
	});

	it.each(["User", "Eliza", "Bob"])(
		"preserves raw UUID identity when a room participant is named %s",
		async (name) => {
			const subjectId = "00000000-0000-0000-0000-0000000000b2" as UUID;
			const objectId = "00000000-0000-0000-0000-0000000000a1" as UUID;
			const relationships = [
				{ subject: subjectId, predicate: "works_with", object: objectId },
			];
			const runtime = makeRuntime(
				JSON.stringify({
					facts: [],
					relationships,
					thought: "validated relationship",
				}),
			);
			vi.mocked(runtime.getEntitiesForRoom).mockResolvedValueOnce([
				{ id: subjectId, names: ["Bob"], agentId: runtime.agentId },
				{ id: objectId, names: [name], agentId: runtime.agentId },
			]);
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { relationships },
			});
			expect(result.written.relationships).toBe(1);
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({ text: `Bob works_with ${name}` }),
					metadata: expect.objectContaining({
						sourceEntityId: subjectId,
						targetEntityId: objectId,
					}),
				}),
				"facts",
				true,
			);
			expect(runtime.createRelationship).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceEntityId: subjectId,
					targetEntityId: objectId,
				}),
			);
		},
	);

	it.each(["[REDACTED:ELIZA_ADMIN_ENTITY_ID]", "[REDACTED:OTHER_ENTITY_ID]"])(
		"rejects the placeholder object %s without assigning it to the speaker",
		async (object) => {
			const message = makeMessage();
			const relationships = [{ subject: "Alice", predicate: "knows", object }];
			const runtime = makeRuntime(
				JSON.stringify({
					facts: [],
					relationships,
					thought: "validated relationship",
				}),
				{
					ELIZA_ADMIN_ENTITY_ID: message.entityId,
				},
			);
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message,
				state: makeState(),
				extract: { relationships },
			});
			expect(result.written.relationships).toBe(0);
			expect(runtime.createMemory).not.toHaveBeenCalled();
			expect(runtime.createRelationship).not.toHaveBeenCalled();
		},
	);

	it.each([
		"[REDACTED:OTHER_ENTITY_ID]",
		"99999999-0000-0000-0000-000000000000",
		"api key: private value",
	])(
		"does not reintroduce an unsafe relationship label from a room name: %s",
		async (name) => {
			const objectId = "00000000-0000-0000-0000-0000000000a1" as UUID;
			const relationships = [
				{ subject: "user", predicate: "knows", object: objectId },
			];
			const runtime = makeRuntime(
				JSON.stringify({
					facts: [],
					relationships,
					thought: "validated relationship",
				}),
			);
			vi.mocked(runtime.getEntitiesForRoom).mockResolvedValueOnce([
				{ id: objectId, names: [name], agentId: runtime.agentId },
			]);
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { relationships },
			});
			expect(result.written.relationships).toBe(0);
			expect(runtime.createMemory).not.toHaveBeenCalled();
			expect(runtime.createRelationship).not.toHaveBeenCalled();
		},
	);

	it("drops actual identity self-loops after humanizing a raw UUID", async () => {
		const relationships = [
			{ subject: "user", predicate: "knows", object: makeMessage().entityId },
		];
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships,
				thought: "validated relationship",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { relationships },
		});
		expect(result.written.relationships).toBe(0);
		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.createRelationship).not.toHaveBeenCalled();
	});

	it("resolves the redacted canonical owner only when that owner is speaking and drops a placeholder object", async () => {
		const message = makeMessage();
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{
						subject: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
						predicate: "has_dog",
						object: "Biscuit",
					},
					{
						subject: "user",
						predicate: "works_with",
						object: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
					},
				],
				thought: "two rels",
			}),
			{ ELIZA_ADMIN_ENTITY_ID: message.entityId },
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message,
			state: makeState(),
			extract: {
				relationships: [
					{
						subject: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
						predicate: "has_dog",
						object: "Biscuit",
					},
					{
						subject: "user",
						predicate: "works_with",
						object: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
					},
				],
			},
		});
		expect(result.written.relationships).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "relationship",
					text: "User has_dog Biscuit",
					subject: "User",
				}),
				metadata: expect.objectContaining({
					sourceEntityId: message.entityId,
				}),
			}),
			"facts",
			true,
		);
	});

	it.each([
		{
			name: "another speaker quoting the canonical owner",
			subject: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
			ownerId: "00000000-0000-0000-0000-000000000009",
		},
		{
			name: "an unknown redacted identity even in the owner's turn",
			subject: "[REDACTED:OTHER_ENTITY_ID]",
			ownerId: "00000000-0000-0000-0000-000000000001",
		},
		{
			name: "a redacted owner without configured identity",
			subject: "[REDACTED:ELIZA_ADMIN_ENTITY_ID]",
			ownerId: "",
		},
	])(
		"never assigns $name to the current speaker",
		async ({ subject, ownerId }) => {
			const relationships = [
				{ subject, predicate: "works_with", object: "Alice" },
			];
			const runtime = makeRuntime(
				JSON.stringify({
					facts: [],
					relationships,
					thought: "one relationship",
				}),
				{ ELIZA_ADMIN_ENTITY_ID: ownerId },
			);
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { relationships },
			});
			expect(result.written.relationships).toBe(0);
			expect(runtime.createMemory).not.toHaveBeenCalled();
			expect(runtime.createRelationship).not.toHaveBeenCalled();
		},
	);

	it("persists relationships under the facts table and upserts resolved entity edges when kept", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "new rel",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
			},
		});
		expect(result.written.relationships).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "relationship",
					subject: "user",
					predicate: "works_with",
					object: "Alice",
				}),
				metadata: expect.objectContaining({
					source: "facts_and_relationships_stage",
					sourceEntityId: makeMessage().entityId,
					targetEntityId: "00000000-0000-0000-0000-0000000000a1",
				}),
			}),
			"facts",
			true,
		);
		expect(runtime.createRelationship).toHaveBeenCalledWith({
			sourceEntityId: makeMessage().entityId,
			targetEntityId: "00000000-0000-0000-0000-0000000000a1",
			tags: ["works_with"],
			metadata: expect.objectContaining({
				source: "facts_and_relationships_stage",
				messageId: makeMessage().id,
			}),
		});
	});

	it("propagates fact persistence failures instead of reporting a successful write", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user's birthday is March 5"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const failure = new Error("facts store unavailable");
		runtime.createMemory.mockRejectedValueOnce(failure);

		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { facts: ["the user's birthday is March 5"] },
			}),
		).rejects.toBe(failure);
	});

	it("propagates relationship edge failures instead of counting a partial write", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "new relationship",
			}),
		);
		const failure = new Error("relationship store unavailable");
		runtime.createRelationship.mockRejectedValueOnce(failure);

		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: {
					relationships: [
						{ subject: "user", predicate: "works_with", object: "Alice" },
					],
				},
			}),
		).rejects.toBe(failure);
	});

	it("filters low-signal and secret-like candidates before calling the model", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				facts: [
					"by the way thanks",
					"my api key is csk-redaction-test-token-000000000000",
				],
				relationships: [],
			},
		});

		expect(result.parsed.facts).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("filters secret-like relationship endpoints before calling the model", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{
						subject: "user",
						predicate: "owns_api_key",
						object: "csk-redaction-test-token-000000000000",
					},
				],
			},
		});

		expect(result.parsed.relationships).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("skips synthetic compaction messages before candidate filtering", async () => {
		const runtime = makeRuntime("");
		const synthetic = {
			...makeMessage(),
			content: { text: "[conversation summary] user likes squash" },
			metadata: { source: "conversation-compaction", tags: ["compaction"] },
		} as Memory;

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: synthetic,
			state: makeState(),
			extract: { facts: ["the user likes squash"] },
		});

		expect(result.parsed.thought).toBe("synthetic message skipped");
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("returns gracefully when the model omits candidates from the response", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [],
				thought: "all duplicates",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["something already known"] },
		});
		expect(result.parsed.facts).toEqual([]);
		expect(result.written).toEqual({ facts: 0, relationships: 0 });
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});
});

// ── Voice extraction parity (#8786) ──────────────────────────────────────────
//
// Regression-proves criterion 5: a voice message (VOICE_DM / VOICE_GROUP) runs
// the IDENTICAL facts/relationships extraction as the same text message. The
// stage must never branch on channel type — if a future change added an
// `if (isVoiceChannelMessage) skip` it would drop name/relationship inference
// from speech ("John is my brother"), exactly the bug #8786 set out to prevent.
describe("runFactsAndRelationshipsStage — voice/text parity (#8786)", () => {
	function messageOn(channelType?: ChannelType): Memory {
		return {
			id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
			entityId: "00000000-0000-0000-0000-000000000001" as UUID,
			agentId: "00000000-0000-0000-0000-000000000002" as UUID,
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
			content: {
				text: "John is my brother",
				source: "test",
				...(channelType ? { channelType } : {}),
			},
			createdAt: 1,
		};
	}

	const MODEL_RESPONSE = JSON.stringify({
		facts: ["the user has a brother named John"],
		relationships: [
			{ subject: "user", predicate: "has_brother", object: "John" },
		],
		thought: "new family relationship",
	});

	const EXTRACT = {
		facts: ["the user has a brother named John"],
		relationships: [
			{ subject: "user", predicate: "has_brother", object: "John" },
		],
	};

	async function runOn(channelType?: ChannelType) {
		const runtime = makeRuntime(MODEL_RESPONSE);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: messageOn(channelType),
			state: makeState(),
			extract: EXTRACT,
		});
		return { runtime, result };
	}

	it("VOICE_DM extracts the same facts + relationships as a text message", async () => {
		const text = await runOn();
		const voice = await runOn(ChannelType.VOICE_DM);

		// Identical parsed extraction.
		expect(voice.result.parsed.facts).toEqual(text.result.parsed.facts);
		expect(voice.result.parsed.relationships).toEqual(
			text.result.parsed.relationships,
		);
		// Identical persistence (the name/relationship is written either way).
		expect(voice.result.written).toEqual(text.result.written);
		expect(voice.result.written.facts).toBe(1);
		expect(voice.result.written.relationships).toBe(1);
		// The extraction model was invoked for the voice turn just like text.
		expect(voice.runtime.useModel).toHaveBeenCalled();
		expect(voice.runtime.createRelationship).toHaveBeenCalledTimes(
			text.runtime.createRelationship.mock.calls.length,
		);
	});

	it("VOICE_GROUP also runs the identical extraction (no channel gate)", async () => {
		const text = await runOn();
		const group = await runOn(ChannelType.VOICE_GROUP);
		expect(group.result.parsed.facts).toEqual(text.result.parsed.facts);
		expect(group.result.parsed.relationships).toEqual(
			text.result.parsed.relationships,
		);
		expect(group.result.written).toEqual(text.result.written);
	});
});

describe("fact speaker attribution", () => {
	const runWithFacts = async (
		facts: unknown[],
		priorDialogue: Memory[] = [],
	) => {
		const runtime = makeRuntime(
			JSON.stringify({ facts, relationships: [], thought: "attributed" }),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["seed candidate"], relationships: [] },
			priorDialogue,
		});
		return { runtime, result };
	};

	it("persists a fact under the room entity the model attributed it to", async () => {
		const { runtime } = await runWithFacts([
			{ subject: "Alice", fact: "Alice's favorite color is crimson" },
		]);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-0000000000a1",
				content: expect.objectContaining({
					text: "Alice's favorite color is crimson",
				}),
			}),
			"facts",
			true,
		);
	});

	it("persists subject 'user' under the current message author", async () => {
		const { runtime } = await runWithFacts([
			{ subject: "user", fact: "the user's birthday is March 5" },
		]);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-000000000001",
			}),
			"facts",
			true,
		);
	});

	it("falls back to the current author when the subject resolves to nobody", async () => {
		const { runtime } = await runWithFacts([
			{ subject: "Zoe", fact: "Zoe's timezone is UTC" },
		]);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-000000000001",
			}),
			"facts",
			true,
		);
	});

	it("labels prior dialogue lines with the actual speaker, not a collapsed 'user'", async () => {
		const bobLine: Memory = {
			id: "00000000-0000-0000-0000-00000000dddd" as UUID,
			entityId: "00000000-0000-0000-0000-0000000000b2" as UUID,
			agentId: "00000000-0000-0000-0000-000000000002" as UUID,
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
			content: { text: "my favorite color is teal", source: "test" },
			createdAt: 0,
		};
		const { runtime } = await runWithFacts(
			[{ subject: "Bob", fact: "Bob's favorite color is teal" }],
			[bobLine],
		);
		const call = runtime.useModel.mock.calls.find(
			(entry) => entry[0] === ModelType.TEXT_LARGE || entry[0] === "TEXT_LARGE",
		);
		const params = call?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		expect(params.messages?.[1]?.content).toContain(
			"Bob: my favorite color is teal",
		);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-0000000000b2",
			}),
			"facts",
			true,
		);
	});
});

// ── Parse failure codes beyond empty input ───────────────────────────────────
//
// The original suite pinned FACTS_MODEL_OUTPUT_MISSING and the malformed
// relationship path. These pin the remaining parse branches: unparseable
// prose, schema-shape violations per field, and the malformed-fact index
// carried in the error context.

describe("parseFactsAndRelationshipsOutput — invalid payload codes", () => {
	it("rejects prose containing no JSON object as FACTS_MODEL_OUTPUT_INVALID", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				"I could not find any facts worth keeping.",
			),
		).toThrow(expect.objectContaining({ code: "FACTS_MODEL_OUTPUT_INVALID" }));
	});

	it("rejects a non-array facts field as schema-invalid", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				JSON.stringify({
					facts: "the user likes tea",
					relationships: [],
					thought: "ok",
				}),
			),
		).toThrow(
			expect.objectContaining({ code: "FACTS_MODEL_OUTPUT_SCHEMA_INVALID" }),
		);
	});

	it("rejects non-array relationships as schema-invalid", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				JSON.stringify({
					facts: [],
					relationships: { subject: "user", predicate: "x", object: "y" },
					thought: "ok",
				}),
			),
		).toThrow(
			expect.objectContaining({ code: "FACTS_MODEL_OUTPUT_SCHEMA_INVALID" }),
		);
	});

	it("rejects a non-string thought as schema-invalid", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				JSON.stringify({ facts: [], relationships: [], thought: 7 }),
			),
		).toThrow(
			expect.objectContaining({ code: "FACTS_MODEL_OUTPUT_SCHEMA_INVALID" }),
		);
	});

	it("reports the index of a malformed fact entry in the error context", () => {
		expect(() =>
			parseFactsAndRelationshipsOutput(
				JSON.stringify({
					facts: [{ subject: "Alice", fact: "likes oolong tea" }, 42],
					relationships: [],
					thought: "ok",
				}),
			),
		).toThrow(
			expect.objectContaining({
				code: "FACTS_MODEL_OUTPUT_SCHEMA_INVALID",
				context: { factIndex: 1 },
			}),
		);
	});

	it("drops blank fact entries after trimming and defaults a missing subject to 'user'", () => {
		const result = parseFactsAndRelationshipsOutput(
			JSON.stringify({
				facts: [
					{ subject: "Alice", fact: "   " },
					{ fact: "likes oolong tea" },
					{ subject: "  Bob  ", fact: "  commutes by ferry  " },
				],
				relationships: [],
				thought: "one blank dropped",
			}),
		);
		expect(result.facts).toEqual([
			{ subject: "user", fact: "likes oolong tea" },
			{ subject: "Bob", fact: "commutes by ferry" },
		]);
	});

	it("trims whitespace from relationship fields instead of persisting padded values", () => {
		const result = parseFactsAndRelationshipsOutput(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: " Alice ", predicate: " works_with ", object: " Bob " },
				],
				thought: "",
			}),
		);
		expect(result.relationships).toEqual([
			{ subject: "Alice", predicate: "works_with", object: "Bob" },
		]);
	});
});

// ── Exported tool contract ──────────────────────────────────────────────────

describe("facts stage exported tool contract", () => {
	it("exposes a strict function tool bound to the shared schema and name", async () => {
		const mod = await import("../facts-and-relationships");
		const tool = mod.createFactsAndRelationshipsTool();
		expect(tool.name).toBe(mod.FACTS_AND_RELATIONSHIPS_TOOL_NAME);
		expect(tool.type).toBe("function");
		expect(tool.strict).toBe(true);
		expect(tool.parameters).toBe(mod.factsAndRelationshipsSchema);
		expect(mod.factsAndRelationshipsSchema.required).toEqual([
			"facts",
			"relationships",
			"thought",
		]);
	});
});

// ── Candidate deduplication and normalization before the model call ──────────

describe("runFactsAndRelationshipsStage — candidate deduplication and normalization", () => {
	it("collapses case and punctuation duplicates of the same fact into one candidate", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["Alice lives in Paris"],
				relationships: [],
				thought: "dedup",
			}),
		);
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				facts: ["Alice lives in Paris", "alice   lives in PARIS!!"],
			},
		});
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		const candidateLines =
			params.messages?.[1]?.content.match(/^- fact: .+$/gm) ?? [];
		// Both spellings normalize to the same comparison key, so the model sees
		// exactly one candidate — the first-seen surface form.
		expect(candidateLines).toEqual(["- fact: Alice lives in Paris"]);
	});

	it("normalizes relationship predicates to snake_case and drops cross-case duplicate pairs", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "User", predicate: "works_with", object: "Alice" },
				],
				thought: "normalized",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{
						subject: "User",
						predicate: "Works With!",
						object: "Alice",
					},
					{
						subject: "USER",
						predicate: "works_with",
						object: "ALICE",
					},
				],
			},
		});
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		const content = params.messages?.[1]?.content ?? "";
		expect(content.match(/^- relationship: .+$/gm)).toEqual([
			"- relationship: User works_with Alice",
		]);
		expect(result.written.relationships).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "relationship",
					subject: "User",
					predicate: "works_with",
					object: "Alice",
				}),
			}),
			"facts",
			true,
		);
		expect(runtime.createRelationship).toHaveBeenCalledWith(
			expect.objectContaining({ tags: ["works_with"] }),
		);
	});

	it("writes the echo memory but skips the entity edge for self-relationships", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "mentors", object: "user" },
				],
				thought: "self reference",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{ subject: "user", predicate: "mentors", object: "user" },
				],
			},
		});
		// The echo is still recorded under the facts table…
		expect(result.written.relationships).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "relationship",
					text: "user mentors user",
				}),
			}),
			"facts",
			true,
		);
		// …but a source===target edge is never created.
		expect(runtime.createRelationship).not.toHaveBeenCalled();
	});
});

// ── Required deduplication reads fail before persistence ─────────────────────

describe("runFactsAndRelationshipsStage — deduplication read failures", () => {
	it("rejects a facts-store read failure before model dispatch or persistence", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["a fresh fact"],
				relationships: [],
				thought: "kept",
			}),
		);
		(runtime.getMemories as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("facts store unavailable"),
		);
		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { facts: ["a fresh fact"] },
			}),
		).rejects.toMatchObject({
			code: "FACTS_DEDUP_READ_FAILED",
			cause: expect.objectContaining({ message: "facts store unavailable" }),
		});
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("rejects a relationships-store read failure before model dispatch or persistence", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "must not be written",
			}),
		);
		(
			runtime.getRelationships as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("relationship store unavailable"));
		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: {
					relationships: [
						{
							subject: "user",
							predicate: "works_with",
							object: "Alice",
						},
					],
				},
			}),
		).rejects.toMatchObject({
			code: "RELATIONSHIP_DEDUP_READ_FAILED",
			cause: expect.objectContaining({
				message: "relationship store unavailable",
			}),
		});
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.createRelationship).not.toHaveBeenCalled();
	});

	it("rejects a non-array facts-store response before model dispatch or persistence", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["a fresh fact"],
				relationships: [],
				thought: "must not be written",
			}),
		);
		(runtime.getMemories as ReturnType<typeof vi.fn>).mockResolvedValueOnce(42);
		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { facts: ["a fresh fact"] },
			}),
		).rejects.toMatchObject({ code: "FACTS_DEDUP_RESPONSE_INVALID" });
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("rejects a non-array relationships-store response before model dispatch or persistence", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "must not be written",
			}),
		);
		(
			runtime.getRelationships as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({ invalid: true });
		await expect(
			runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: {
					relationships: [
						{
							subject: "user",
							predicate: "works_with",
							object: "Alice",
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "RELATIONSHIP_DEDUP_RESPONSE_INVALID" });
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.createRelationship).not.toHaveBeenCalled();
	});
});

// ── Persistence-time subject resolution and redaction ────────────────────────

describe("runFactsAndRelationshipsStage — persistence-time subject resolution", () => {
	const runWithFact = async (modelFact: unknown, candidate?: string) => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [modelFact],
				relationships: [],
				thought: "kept",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: [candidate ?? "seed candidate"] },
		});
		return { runtime, result };
	};

	it("credits a fact to the agent when the model names the character", async () => {
		const { runtime } = await runWithFact({
			subject: "Eliza",
			fact: "Eliza prefers terse replies",
		});
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-000000000002",
			}),
			"facts",
			true,
		);
	});

	it("accepts a bare UUID subject as an explicit entity reference", async () => {
		const { runtime } = await runWithFact({
			subject: "00000000-0000-0000-0000-0000000000a1",
			fact: "Alice commutes by ferry",
		});
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "00000000-0000-0000-0000-0000000000a1",
			}),
			"facts",
			true,
		);
	});

	it("redacts secret-shaped tokens at candidate and persistence time without dropping the fact", async () => {
		const { runtime, result } = await runWithFact(
			{ subject: "user", fact: "the staging token is [REDACTED]" },
			"the staging token is sk-test-shortkey",
		);
		// The token is short enough to survive the drop-list, so the fact is
		// kept — but redacted before the model ever sees it.
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		const content = params.messages?.[1]?.content ?? "";
		expect(content).toContain("- fact: the staging token is [REDACTED]");
		expect(content).not.toContain("sk-test-shortkey");
		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					text: "the staging token is [REDACTED]",
				}),
			}),
			"facts",
			true,
		);
	});
});

// ── Mobile platform gate ─────────────────────────────────────────────────────

describe("runFactsAndRelationshipsStage — platform gate", () => {
	it("skips the whole stage on mobile platforms without calling the model", async () => {
		const previous = process.env.ELIZA_PLATFORM;
		process.env.ELIZA_PLATFORM = "ios";
		try {
			const runtime = makeRuntime("");
			const result = await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(),
				state: makeState(),
				extract: { facts: ["the user likes squash"] },
			});
			expect(result.parsed.thought).toBe("skipped on mobile");
			expect(result.parsed.facts).toEqual([]);
			expect(result.parsed.relationships).toEqual([]);
			expect(result.messages).toEqual([]);
			expect(result.tools).toEqual([]);
			expect(result.written).toEqual({ facts: 0, relationships: 0 });
			expect(runtime.useModel).not.toHaveBeenCalled();
			expect(runtime.createMemory).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) {
				delete process.env.ELIZA_PLATFORM;
			} else {
				process.env.ELIZA_PLATFORM = previous;
			}
		}
	});
});
