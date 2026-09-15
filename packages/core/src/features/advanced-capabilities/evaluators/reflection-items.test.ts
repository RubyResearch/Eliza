/**
 * Deterministic unit tests for the reflection evaluators (reflection-items.ts):
 * fact keyword dedupe / strengthen without embeddings, the strict-structured-output
 * schema invariant across every reflection schema, and the tolerant per-op
 * factExtractor parse. Runtime/model collaborators are stubbed; pending correction
 * tests exercise the real parser, processor and SQL helper against in-memory PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { logger } from "../../../logger.ts";
import { parseAndValidate } from "../../../runtime/validated-model-call.ts";
import type {
	Entity,
	EvaluatorProcessorContext,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { parseExtractorOutputTolerant } from "./factExtractor.schema.ts";
import {
	factMemoryEvaluator,
	identityEvaluator,
	relationshipEvaluator,
} from "./reflection-items.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function message(text = "Berlin has been treating me well"): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000dd" as UUID,
		entityId,
		agentId,
		roomId,
		content: { text },
		createdAt: Date.now(),
	};
}

function makeRuntime() {
	let createdMemory: Memory | null = null;
	const createdId = "00000000-0000-0000-0000-0000000000ee" as UUID;
	const runtime = {
		agentId,
		createMemory: vi.fn(async (memoryArg: Memory) => {
			createdMemory = { ...memoryArg, id: createdId };
			return createdId;
		}),
		getMemoryById: vi.fn(async () => createdMemory),
		updateMemory: vi.fn(async () => undefined),
		deleteMemory: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			throw new Error("fact evaluator must not request embeddings");
		}),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
	};
	return runtime as unknown as IAgentRuntime & {
		createMemory: ReturnType<typeof vi.fn>;
		getMemoryById: ReturnType<typeof vi.fn>;
		updateMemory: ReturnType<typeof vi.fn>;
		useModel: ReturnType<typeof vi.fn>;
		queueEmbeddingGeneration: ReturnType<typeof vi.fn>;
	};
}

function processFactOps(
	runtime: ReturnType<typeof makeRuntime>,
	knownFacts: Memory[],
	output: unknown,
	currentMessage = message(),
) {
	const processor = factMemoryEvaluator.processors?.[0];
	if (!processor) throw new Error("missing fact processor");
	return processor.process({
		runtime,
		message: currentMessage,
		state: { values: {}, data: {}, text: "" },
		options: {},
		evaluatorName: "factMemory",
		prepared: {
			recentMessages: [],
			existingRelationships: [],
			entities: [],
			knownFacts,
		},
		output,
	} as EvaluatorProcessorContext);
}

describe("factMemoryEvaluator pending corrections", () => {
	let client: PGlite;
	const originalFact: Memory = {
		id: "00000000-0000-0000-0000-0000000000ff" as UUID,
		entityId,
		agentId,
		roomId,
		content: {
			text: "The packing list is a green notebook and a charger, with no water.",
		},
		metadata: { kind: "current", category: "working_on", confidence: 0.6 },
	};
	const replacement =
		"The packing list is an orange notebook and a charger, with no water.";
	const correction = message(
		"Change the notebook to orange; keep the charger and no water.",
	);
	const reason = "The user corrected the notebook color from green to orange.";

	beforeAll(async () => {
		client = new PGlite();
		await client.exec(`CREATE TABLE fact_candidates (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id uuid NOT NULL, entity_id uuid NOT NULL, kind text NOT NULL,
			existing_fact_id uuid, proposed_text text NOT NULL,
			confidence real NOT NULL, evidence jsonb, status text NOT NULL
		)`);
	});
	afterEach(async () => {
		await client.exec("DELETE FROM fact_candidates");
	});
	afterAll(async () => {
		await client.close();
	});

	function parseCorrection(proposedText: string | undefined) {
		return factMemoryEvaluator.parse?.(
			JSON.stringify({
				ops: [
					{
						op: "contradict",
						factId: originalFact.id,
						proposedText,
						reason,
					},
				],
			}),
		);
	}

	it("persists the model's complete orange proposal and leaves the green fact unchanged", async () => {
		const runtime = makeRuntime();
		Object.assign(runtime, { adapter: { db: drizzle(client) } });
		const knownFacts = [
			originalFact,
			{
				...originalFact,
				id: "00000000-0000-0000-0000-000000000011" as UUID,
				content: { text: "The user's bike is red." },
			},
		];
		const before = structuredClone(knownFacts);
		const parsed = parseCorrection(replacement);
		expect(parsed?.ops).toHaveLength(1);

		const result = await processFactOps(
			runtime,
			knownFacts,
			parsed,
			correction,
		);

		const stored = await client.query("SELECT * FROM fact_candidates");
		expect(stored.rows).toHaveLength(1);
		expect(stored.rows[0]).toMatchObject({
			agent_id: agentId,
			entity_id: entityId,
			kind: "contradict",
			existing_fact_id: originalFact.id,
			proposed_text: replacement,
			status: "pending",
			evidence: { reason, evidenceMessageId: correction.id },
		});
		expect(result?.data).toMatchObject({ contradicted: 1 });
		expect(knownFacts).toEqual(before);
		expect(runtime.updateMemory).not.toHaveBeenCalled();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it.each([originalFact.content.text, ` \t${originalFact.content.text}\n `])(
		"skips an unchanged proposal without dropping another valid correction (%j)",
		async (proposedText) => {
			const runtime = makeRuntime();
			Object.assign(runtime, { adapter: { db: drizzle(client) } });
			const parsed = factMemoryEvaluator.parse?.({
				ops: [
					{ op: "contradict", factId: originalFact.id, proposedText, reason },
					{
						op: "contradict",
						factId: originalFact.id,
						proposedText: replacement,
						reason,
					},
				],
			});

			const result = await processFactOps(
				runtime,
				[originalFact],
				parsed,
				correction,
			);

			expect(result?.data).toMatchObject({ contradicted: 1 });
			expect(
				(await client.query("SELECT proposed_text FROM fact_candidates")).rows,
			).toEqual([{ proposed_text: replacement }]);
			expect(runtime.updateMemory).not.toHaveBeenCalled();
			expect(runtime.deleteMemory).not.toHaveBeenCalled();
			expect(runtime.createMemory).not.toHaveBeenCalled();
		},
	);

	it("does not save or count a proposal that repeats the existing claim", async () => {
		const runtime = makeRuntime();
		Object.assign(runtime, { adapter: { db: drizzle(client) } });
		const parsed = parseCorrection(originalFact.content.text);

		const result = await processFactOps(
			runtime,
			[originalFact],
			parsed,
			correction,
		);

		expect(result?.data).toMatchObject({ contradicted: 0 });
		expect((await client.query("SELECT * FROM fact_candidates")).rows).toEqual(
			[],
		);
		expect(runtime.updateMemory).not.toHaveBeenCalled();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it.each([undefined, "", " \t\n "])(
		"does not persist an omitted/blank correction (%j)",
		async (proposedText) => {
			const runtime = makeRuntime();
			Object.assign(runtime, { adapter: { db: drizzle(client) } });
			const parsed = parseCorrection(proposedText);
			expect(parsed?.ops).toEqual([]);

			const result = await processFactOps(
				runtime,
				[originalFact],
				parsed,
				correction,
			);

			expect(result?.data).toMatchObject({ contradicted: 0 });
			expect(
				(await client.query("SELECT * FROM fact_candidates")).rows,
			).toEqual([]);
			expect(runtime.updateMemory).not.toHaveBeenCalled();
			expect(runtime.deleteMemory).not.toHaveBeenCalled();
			expect(runtime.createMemory).not.toHaveBeenCalled();
		},
	);

	it("does not count a saved proposal when the executor is unavailable", async () => {
		const runtime = makeRuntime();
		Object.assign(runtime, { adapter: { db: undefined } });
		await expect(
			processFactOps(
				runtime,
				[originalFact],
				parseCorrection(replacement),
				correction,
			),
		).rejects.toMatchObject({ code: "FACT_CANDIDATE_STORAGE_UNAVAILABLE" });
		expect((await client.query("SELECT * FROM fact_candidates")).rows).toEqual(
			[],
		);
		expect(runtime.updateMemory).not.toHaveBeenCalled();
	});

	it("propagates storage failure instead of returning a committed count", async () => {
		const runtime = makeRuntime();
		const failure = new Error("candidate storage failed");
		Object.assign(runtime, {
			adapter: {
				db: {
					execute: async () => {
						throw failure;
					},
				},
			},
		});
		await expect(
			processFactOps(
				runtime,
				[originalFact],
				parseCorrection(replacement),
				correction,
			),
		).rejects.toBe(failure);
		expect((await client.query("SELECT * FROM fact_candidates")).rows).toEqual(
			[],
		);
		expect(runtime.updateMemory).not.toHaveBeenCalled();
	});
});

describe("factMemoryEvaluator keyword dedupe", () => {
	it.each([
		{
			storedFields: { city: "Berlin" },
			incomingFields: { city: "Paris" },
			storedDate: "2026-09-01",
			incomingDate: "2026-09-01",
			added: 1,
		},
		{
			storedFields: { city: "Berlin" },
			incomingFields: { city: "Berlin" },
			storedDate: "2026-09-01",
			incomingDate: "2026-09-02",
			added: 1,
		},
		{
			storedFields: { city: "Berlin" },
			incomingFields: { city: "Berlin" },
			storedDate: "2026-09-01",
			incomingDate: "2026-09-01",
			added: 0,
		},
	])(
		"respects structured meaning and effective dates: $incomingFields / $incomingDate",
		async (scenario) => {
			const runtime = makeRuntime();
			const existing: Memory = {
				id: "00000000-0000-0000-0000-0000000000ff" as UUID,
				entityId,
				agentId,
				roomId,
				content: { text: "working remotely" },
				metadata: {
					kind: "current",
					category: "uncategorized",
					structuredFields: scenario.storedFields,
					validAt: scenario.storedDate,
				},
				createdAt: Date.now(),
			};
			const result = await processFactOps(runtime, [existing], {
				ops: [
					{
						op: "add_current",
						claim: "working remotely",
						category: "uncategorized",
						structured_fields: scenario.incomingFields,
						valid_at: scenario.incomingDate,
						keywords: ["remote"],
					},
				],
			});
			expect(result?.data).toMatchObject({
				added: scenario.added,
				strengthened: 1 - scenario.added,
			});
			if (scenario.added) {
				expect(runtime.createMemory).toHaveBeenCalledWith(
					expect.objectContaining({
						metadata: expect.objectContaining({
							structuredFields: scenario.incomingFields,
							validAt: scenario.incomingDate,
						}),
					}),
					"facts",
					true,
				);
				expect(runtime.updateMemory).not.toHaveBeenCalled();
			} else {
				expect(runtime.createMemory).not.toHaveBeenCalled();
				expect(runtime.updateMemory).toHaveBeenCalledWith(
					expect.objectContaining({ id: existing.id }),
				);
			}
		},
	);
	it("stores extracted keywords and does not queue fact embeddings", async () => {
		const runtime = makeRuntime();

		await processFactOps(runtime, [], {
			ops: [
				{
					op: "add_durable",
					claim: "lives in Berlin",
					category: "identity",
					structured_fields: { city: "Berlin" },
					keywords: ["berlin", "home"],
				},
			],
		});

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.queueEmbeddingGeneration).not.toHaveBeenCalled();
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					keywords: expect.arrayContaining(["berlin", "home"]),
				}),
			}),
			"facts",
			true,
		);
	});

	it.each([
		["lives in Berlin", "Berlin has been treating me well"],
		["prefers tea over coffee", "prefers coffee over tea"],
		["likes oat milk", "does not like oat milk"],
	])(
		"preserves distinct facts despite lexical overlap: %s / %s",
		async (storedClaim, newClaim) => {
			const runtime = makeRuntime();
			const existingFact: Memory = {
				id: "00000000-0000-0000-0000-0000000000ff" as UUID,
				entityId,
				agentId,
				roomId,
				content: { text: storedClaim },
				metadata: {
					kind: "durable",
					category: "identity",
					confidence: 0.7,
					keywords: ["berlin", "lives"],
				},
				createdAt: Date.now(),
			};

			const result = await processFactOps(runtime, [existingFact], {
				ops: [
					{
						op: "add_durable",
						claim: newClaim,
						category: "identity",
						structured_fields: { city: "Berlin" },
						keywords: ["berlin"],
					},
				],
			});

			expect(runtime.useModel).not.toHaveBeenCalled();
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({ content: { text: newClaim } }),
				"facts",
				true,
			);
			expect(runtime.updateMemory).not.toHaveBeenCalled();
			expect(result?.data).toMatchObject({ added: 1, strengthened: 0 });
		},
	);
});

describe("factMemoryEvaluator dedupe against explicit MEMORY facts", () => {
	const explicitFact: Memory = {
		id: "00000000-0000-0000-0000-0000000000f1" as UUID,
		entityId,
		agentId,
		roomId,
		content: { text: "The user's favorite tea is genmaicha", source: "MEMORY" },
		metadata: {
			type: "custom",
			source: "MEMORY",
			kind: "durable",
			category: "preference",
			confidence: 0.95,
			keywords: ["tea", "favorite", "genmaicha"],
			verificationStatus: "self_reported",
		},
		createdAt: Date.now(),
	} as Memory;

	it("strengthens the user's explicit memory instead of adding a re-categorised copy", async () => {
		// Live 2026-09-06: the MEMORY action stored durable/preference, the
		// extractor added current/uncategorized in the same turn, and the next
		// "forget my favorite tea" was ambiguous between the two.
		const runtime = makeRuntime();
		const result = await processFactOps(runtime, [explicitFact], {
			ops: [
				{
					op: "add_current",
					claim: "user's favorite tea is genmaicha",
					category: "uncategorized",
					structured_fields: {},
					keywords: ["tea", "genmaicha"],
				},
			],
		});
		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.updateMemory).toHaveBeenCalledWith(
			expect.objectContaining({ id: explicitFact.id }),
		);
		expect(result?.data).toMatchObject({ added: 0, strengthened: 1 });
	});

	it.each([
		"The user's favorite tea is hojicha",
		"The user's favorite tea is not genmaicha",
		"The user's sister's favorite tea is genmaicha",
	])(
		"does not discard a distinct claim resembling explicit memory: %s",
		async (claim) => {
			const runtime = makeRuntime();
			const result = await processFactOps(runtime, [explicitFact], {
				ops: [
					{
						op: "add_current",
						claim,
						category: "uncategorized",
						structured_fields: {},
						keywords: ["tea", "favorite"],
					},
				],
			});
			expect(runtime.updateMemory).not.toHaveBeenCalled();
			expect(runtime.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({ text: claim }),
				}),
				"facts",
				true,
			);
			expect(result?.data).toMatchObject({ added: 1, strengthened: 0 });
		},
	);

	it("keeps the kind/category gate for extractor-authored facts", async () => {
		const runtime = makeRuntime();
		const extractorFact: Memory = {
			...explicitFact,
			id: "00000000-0000-0000-0000-0000000000f2" as UUID,
			content: { text: "The user's favorite tea is genmaicha" },
			metadata: {
				kind: "durable",
				category: "preference",
				confidence: 0.7,
				keywords: ["tea", "favorite", "genmaicha"],
			},
		} as Memory;
		const result = await processFactOps(runtime, [extractorFact], {
			ops: [
				{
					op: "add_current",
					claim: "user's favorite tea is genmaicha",
					category: "uncategorized",
					structured_fields: {},
					keywords: ["tea", "genmaicha"],
				},
			],
		});
		expect(runtime.updateMemory).not.toHaveBeenCalled();
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		expect(result?.data).toMatchObject({ added: 1, strengthened: 0 });
	});
});

describe("reflection evaluator schemas are strict-structured-output safe", () => {
	// Strict-mode validators (Cerebras, Groq, OpenAI strict) reject any object
	// node that lacks an explicit `properties` map or allows additional
	// properties — the WHOLE extraction request 400s ("Bad Request"), so the
	// agent silently never writes fact/relationship memories. Walk every
	// evaluator's response schema and assert the invariant on each object node.
	function assertStrictObjectNodes(node: unknown, path: string): void {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((item, i) => {
				assertStrictObjectNodes(item, `${path}[${i}]`);
			});
			return;
		}
		const record = node as Record<string, unknown>;
		// Strict mode also rejects value-constraint keywords (maxItems,
		// minItems, maxLength, pattern, minimum, ...) — enforce caps in code,
		// never on the wire.
		for (const banned of [
			"maxItems",
			"minItems",
			"uniqueItems",
			"maxLength",
			"minLength",
			"pattern",
			"format",
			"minimum",
			"maximum",
			"multipleOf",
			"minProperties",
			"maxProperties",
		]) {
			expect(
				record[banned],
				`${path} must not use strict-unsupported keyword "${banned}"`,
			).toBeUndefined();
		}
		if (record.type === "object") {
			expect(record.properties, `${path} must declare properties`).toBeTypeOf(
				"object",
			);
			expect(
				record.additionalProperties,
				`${path} must set additionalProperties: false`,
			).toBe(false);
		}
		for (const [key, value] of Object.entries(record)) {
			assertStrictObjectNodes(value, `${path}.${key}`);
		}
	}

	it("every object node in every reflection schema has explicit properties + additionalProperties:false", async () => {
		const { reflectionItems } = await import("./reflection-items.ts");
		// preferenceItems ships in the same merged post-turn call, so its wire
		// schema must satisfy the identical strict-mode invariant.
		const { preferenceItems } = await import("./preference-items.ts");
		for (const evaluator of [...reflectionItems, ...preferenceItems]) {
			const schema = (evaluator as { schema?: unknown }).schema;
			if (!schema) continue;
			assertStrictObjectNodes(schema, evaluator.name ?? "evaluator");
		}
	});

	it("fact extraction preserves structured fields consumed by LifeOps projections", () => {
		const structuredFields = {
			preferredName: "Camille",
			person: "Sam",
			relationshipType: "friend",
			platform: "discord",
			handle: "camille",
			travelBookingPreferences: "Window seat",
			timezone: "Europe/Paris",
		};
		const output = {
			ops: [
				{
					op: "add_durable",
					claim: "The user's preferred name is Camille.",
					category: "identity",
					structured_fields: structuredFields,
				},
			],
		};
		const validation = parseAndValidate(
			JSON.stringify(output),
			factMemoryEvaluator.schema,
		);
		expect(validation.valid).toBe(true);
		expect(factMemoryEvaluator.parse?.(validation.parsed)).toEqual(output);
	});

	it("fact extraction prompt names structured fields on the production evaluator path", () => {
		const prompt = factMemoryEvaluator.prompt?.({
			runtime: makeRuntime(),
			message: message(
				"Je m'appelle Camille et mon fuseau horaire est Europe/Paris",
			),
			state: { values: {}, data: {}, text: "" },
			options: {},
			evaluatorName: "factMemory",
			prepared: {
				recentMessages: [message("Je m'appelle Camille")],
				existingRelationships: [],
				entities: [],
				knownFacts: [],
			},
		});
		expect(prompt).toContain("structured_fields");
		expect(prompt).toContain("Use English key names");
		expect(prompt).toContain("preferredName");
		expect(prompt).toContain("relationshipType");
		expect(prompt).toContain("travelBookingPreferences");
	});
});

describe("factExtractor tolerant parsing (#11235)", () => {
	it("accepts an add op that omits structured_fields (wire-optional)", () => {
		const parsed = parseExtractorOutputTolerant({
			ops: [
				{ op: "add_durable", claim: "lives in Berlin", category: "identity" },
			],
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.ops).toHaveLength(1);
		// The default keeps structured_fields a concrete record for downstream use.
		expect(parsed?.ops[0]).toMatchObject({
			op: "add_durable",
			structured_fields: {},
		});
	});

	it("accepts fenced JSON text that uses type as the op discriminator", () => {
		const parsed = parseExtractorOutputTolerant(`\`\`\`json
{
  "ops": [
    {
      "type": "add_durable",
      "claim": "User's preferred name is Camille and timezone is Europe/Paris.",
      "category": "identity",
      "keywords": ["name", "camille", "timezone", "europe/paris"],
      "structured_fields": {
        "preferredName": "Camille",
        "timezone": "Europe/Paris"
      }
    }
  ]
}
\`\`\``);

		expect(parsed?.ops).toEqual([
			expect.objectContaining({
				op: "add_durable",
				category: "identity",
				structured_fields: {
					preferredName: "Camille",
					timezone: "Europe/Paris",
				},
			}),
		]);
	});

	it("keeps valid ops when one op is malformed, and warns about the drop", () => {
		// The evaluator parse contract (`parse?(output): TOutput | null`) has no
		// runtime/logger, so the drop MUST be logged where it is computed —
		// otherwise per-op loss is silent in prod (the regression #11241 killed).
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parsed = parseExtractorOutputTolerant({
				ops: [
					{ op: "add_durable", claim: "likes tea", category: "preference" },
					{ op: "contradict" }, // invalid: missing required factId + reason
					{ op: "strengthen", factId: "fact-123" },
				],
			});
			expect(parsed).not.toBeNull();
			expect(parsed?.ops.map((o) => o.op)).toEqual([
				"add_durable",
				"strengthen",
			]);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "factMemory",
					count: 1,
					issues: [expect.stringContaining("factId")],
				}),
				"dropped malformed extractor op(s)",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn when every op parses", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			parseExtractorOutputTolerant({
				ops: [{ op: "strengthen", factId: "fact-123" }],
			});
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("returns null only when the envelope itself is not { ops: array }", () => {
		expect(parseExtractorOutputTolerant({ nope: true })).toBeNull();
		expect(parseExtractorOutputTolerant(null)).toBeNull();
		// An empty ops array is a VALID (zero-op) turn, not a parse failure.
		expect(parseExtractorOutputTolerant({ ops: [] })).toEqual({ ops: [] });
	});
});

describe("reflection context preserves the complete room entity set", () => {
	const authorId = "00000000-0000-0000-0000-0000000000cf" as UUID;

	function subAgentEntityId(index: number): UUID {
		return `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID;
	}

	// Names are chosen so the human participants sort AFTER every sub-agent
	// entity — getEntityDetails returns the room alphabetically, so a naive
	// slice would drop exactly the entities the extractors need.
	function roomEntities(subAgentCount: number): Entity[] {
		const entities: Entity[] = [
			{ id: agentId, agentId, names: ["zed-agent"], metadata: {} },
			{ id: entityId, agentId, names: ["zoe-sender"], metadata: {} },
			{ id: authorId, agentId, names: ["yuki-author"], metadata: {} },
		];
		for (let index = 0; index < subAgentCount; index += 1) {
			entities.push({
				id: subAgentEntityId(index),
				agentId,
				names: [
					`sub-agent: Build and deploy web app number ${index} — ${"with detailed task requirements ".repeat(16)}`,
				],
				metadata: {},
			});
		}
		return entities;
	}

	function contextRuntime(entities: Entity[]): IAgentRuntime {
		return {
			agentId,
			getMemories: vi.fn(async () => [
				{
					id: "00000000-0000-0000-0000-0000000000d1" as UUID,
					entityId,
					agentId,
					roomId,
					content: { text: "can you check the weather for me?" },
					createdAt: 1,
				},
				{
					id: "00000000-0000-0000-0000-0000000000d2" as UUID,
					entityId: authorId,
					agentId,
					roomId,
					content: { text: "ping me when it's done" },
					createdAt: 2,
				},
			]),
			getRelationships: vi.fn(async () => []),
			getRoom: vi.fn(async () => null),
			getEntitiesForRoom: vi.fn(async () => entities),
		} as unknown as IAgentRuntime;
	}

	async function prepareContext(runtime: IAgentRuntime) {
		const prepared = await relationshipEvaluator.prepare?.({
			runtime,
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
		});
		if (!prepared) throw new Error("relationship prepare returned nothing");
		return prepared;
	}

	it("keeps every entity in an entity-flooded room", async () => {
		const runtime = contextRuntime(roomEntities(400));
		const prepared = await prepareContext(runtime);

		expect(prepared.entities).toHaveLength(403);
		const keptIds = new Set(prepared.entities.map((entity) => entity.id));
		expect(keptIds.has(agentId)).toBe(true);
		expect(keptIds.has(entityId)).toBe(true);
		expect(keptIds.has(authorId)).toBe(true);
		expect(keptIds.has(subAgentEntityId(0))).toBe(true);
		expect(keptIds.has(subAgentEntityId(399))).toBe(true);
	});

	it("renders the complete Entities-in-Room block into the relationships prompt", async () => {
		const runtime = contextRuntime(roomEntities(400));
		const prepared = await prepareContext(runtime);

		const prompt = relationshipEvaluator.prompt({
			runtime,
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
			evaluatorName: "relationships",
			prepared,
		});
		expect(prompt).toContain(subAgentEntityId(0));
		expect(prompt).toContain(subAgentEntityId(399));
		expect(prompt).toContain(entityId);
	});

	it("preserves a long Unicode entity name completely", async () => {
		const longNameEntityId = subAgentEntityId(999);
		const entities = roomEntities(0);
		entities.push({
			id: longNameEntityId,
			agentId,
			names: [`${"x".repeat(227)}🤖${"y".repeat(20)}`],
			metadata: {},
		});
		const runtime = contextRuntime(entities);
		const prepared = await prepareContext(runtime);

		const prompt = relationshipEvaluator.prompt({
			runtime,
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
			evaluatorName: "relationships",
			prepared,
		});
		const line = prompt
			.split("\n")
			.find(
				(candidate) =>
					candidate.startsWith("- ") &&
					candidate.includes(`(ID: ${longNameEntityId})`),
			);
		if (!line) throw new Error("long-name entity was not rendered");
		const renderedName = line.slice(2, line.indexOf(" (ID:"));
		expect(renderedName).toBe(`${"x".repeat(227)}🤖${"y".repeat(20)}`);
		expect(renderedName.isWellFormed()).toBe(true);
	});

	it("passes rooms under the cap through untouched", async () => {
		const entities = roomEntities(3);
		const runtime = contextRuntime(entities);
		const prepared = await prepareContext(runtime);
		expect(prepared.entities).toHaveLength(entities.length);
	});

	it("shares reflection reads across evaluators for the same turn", async () => {
		const runtime = contextRuntime(roomEntities(3));
		const turn = message();
		const context = {
			runtime,
			message: turn,
			state: { values: {}, data: {}, text: "" },
			options: {},
		};

		await Promise.all([
			relationshipEvaluator.prepare?.(context),
			identityEvaluator.prepare?.(context),
			factMemoryEvaluator.prepare?.(context),
		]);

		expect(runtime.getRelationships).toHaveBeenCalledTimes(1);
		expect(runtime.getEntitiesForRoom).toHaveBeenCalledTimes(1);
		// One shared conversation read plus factMemory's room/entity fact reads.
		expect(runtime.getMemories).toHaveBeenCalledTimes(3);
	});
});

describe("relationship and identity prompt context stays compact", () => {
	// Live 2026-09-14: both sections embedded the room entity list (922 chars
	// each) and the relationship section listed 18 pretty-printed JSON edges
	// (3,472 chars), 17 of them addressed-only bookkeeping.
	const colleagueId = "00000000-0000-0000-0000-0000000000c1" as UUID;
	const entities: Entity[] = [
		{ id: entityId, agentId, names: ["zoe-sender"], metadata: {} },
		{ id: colleagueId, agentId, names: ["cal-colleague"], metadata: {} },
	];
	const entityList = `- zoe-sender (ID: ${entityId})\n- cal-colleague (ID: ${colleagueId})`;
	type Existing = Awaited<ReturnType<IAgentRuntime["getRelationships"]>>;
	const shared = { roomTranscriptRendered: true };

	function targetId(index: number): UUID {
		return `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` as UUID;
	}

	function edge(
		index: number,
		tags: string[],
		relationshipType?: string,
	): Existing[number] {
		return {
			id: `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID,
			sourceEntityId: entityId,
			targetEntityId: targetId(index),
			agentId,
			tags,
			...(relationshipType ? { metadata: { relationshipType } } : {}),
		};
	}

	function context(existingRelationships: Existing = []) {
		return {
			runtime: makeRuntime(),
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
			prepared: { recentMessages: [], entities, existingRelationships },
		};
	}

	it("declares the room entity list as a shared block and references the shared copy", () => {
		const base = context();
		const blocks = relationshipEvaluator.sharedBlocks?.(base);
		expect(blocks).toEqual({ "Entities in Room": entityList });
		expect(identityEvaluator.sharedBlocks?.(base)).toEqual(blocks);
		for (const evaluator of [relationshipEvaluator, identityEvaluator]) {
			const referenced = evaluator.prompt({
				...base,
				shared: { ...shared, blocks },
			});
			expect(referenced).toContain(
				'Entities in Room: see "Entities in Room" in the Shared Turn Context above.',
			);
			expect(referenced).not.toContain("- zoe-sender (ID:");
			const own = evaluator.prompt({ ...base, shared });
			expect(own).toContain(`Entities in Room:\n${entityList}`);
			expect(own).not.toContain('Entities in Room: see "Entities in Room"');
		}
	});

	it("lists only semantic edges, one compact line each, capped at 20", () => {
		const existing: Existing = [
			...Array.from({ length: 17 }, (_, index) =>
				edge(index, ["addressed", "addressed:auto"]),
			),
			edge(100, ["addressed"], "colleague"),
			...Array.from({ length: 24 }, (_, index) =>
				edge(200 + index, ["supports_agent_business"]),
			),
		];
		const prompt = relationshipEvaluator.prompt({
			...context(existing),
			shared,
		});
		const section = prompt.slice(prompt.indexOf("Existing relationships:"));
		expect(section).not.toContain('"sourceEntityId"');
		expect(section).not.toContain("addressed");
		expect(section).toContain(
			`- ${entityId} -> ${targetId(100)} (colleague)\n`,
		);
		expect(section).toContain(
			`- ${entityId} -> ${targetId(200)} [supports_agent_business]\n`,
		);
		expect(section.match(/^- /gm)).toHaveLength(20);
		expect(section).toContain("(5 more not shown)");
		expect(section.length).toBeLessThan(2_400);
	});

	it("shows (none) when only addressed bookkeeping edges exist", () => {
		const prompt = relationshipEvaluator.prompt({
			...context([edge(1, ["addressed", "addressed:auto"])]),
			shared,
		});
		expect(prompt).toContain("Existing relationships:\n(none)");
	});
});
