/**
 * Deterministic unit tests for the passive preference evaluator
 * (preference-items.ts): tolerant op parsing (trait/value pairing, reply_gate
 * unrepresentability, directive cap), the processor's write policy against a
 * REAL PersonalityStore (never-overwrite-explicit, same-run escalation guard,
 * confidence gating, directive dedupe, retract-only-inferred), durable
 * preference-fact row shape and update-not-duplicate, and the gates/prompt
 * degrade when the store is absent. Model output is stubbed at the parse
 * boundary — no live model; the store and fact-write path are real
 * (in-memory FakeRuntime).
 */
import { describe, expect, it, vi } from "vitest";
import { validateSchema } from "../../../actions/validate-tool-args.ts";
import { logger } from "../../../logger.ts";
import type {
	EvaluatorProcessorContext,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { FakeRuntime } from "../personality/__tests__/test-helpers.ts";
import { makeFakeRuntime } from "../personality/__tests__/test-helpers.ts";
import {
	type PreferencePrepared,
	preferenceEvaluator,
} from "./preference-items.ts";
import {
	type PreferenceExtractorOutput,
	parsePreferenceOutputTolerant,
} from "./preferenceExtractor.schema.ts";

const AGENT = "00000000-0000-4000-8000-0000000000aa" as UUID;
const USER = "00000000-0000-4000-8000-0000000000ab" as UUID;
const ROOM = "00000000-0000-4000-8000-0000000000ac" as UUID;

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function makeMessage(text = "honestly that reply was way too long"): Memory {
	return {
		id: "00000000-0000-4000-8000-0000000000ad" as UUID,
		entityId: USER,
		agentId: AGENT,
		roomId: ROOM,
		content: { text },
		createdAt: Date.now(),
	};
}

function mustParse(raw: unknown): PreferenceExtractorOutput {
	const parsed = parsePreferenceOutputTolerant(raw);
	if (!parsed) throw new Error("expected a parseable preference envelope");
	return parsed;
}

function preferenceFact(id: string, text: string, keywords: string[]): Memory {
	return {
		id: id as UUID,
		entityId: USER,
		agentId: AGENT,
		roomId: ROOM,
		content: { text },
		metadata: {
			kind: "durable",
			category: "preference",
			confidence: 0.7,
			keywords,
		},
		createdAt: Date.now(),
	};
}

function processOps(
	fake: FakeRuntime,
	output: PreferenceExtractorOutput,
	prepared: Partial<PreferencePrepared> = {},
) {
	const processor = preferenceEvaluator.processors?.[0];
	if (!processor) throw new Error("missing preference processor");
	const context: EvaluatorProcessorContext<
		PreferenceExtractorOutput,
		PreferencePrepared
	> = {
		runtime: fake.runtime,
		message: makeMessage(),
		state: EMPTY_STATE,
		options: {},
		evaluatorName: "preferences",
		prepared: {
			recentMessages: [],
			slot: null,
			knownPreferenceFacts: [],
			...prepared,
		},
		output,
	};
	return processor.process(context);
}

describe("preference extractor tolerant parsing", () => {
	it("keeps one valid op of each kind", () => {
		const parsed = parsePreferenceOutputTolerant({
			ops: [
				{
					op: "set_trait",
					trait: "verbosity",
					value: "terse",
					confidence: 0.9,
				},
				{ op: "add_directive", text: "no emojis", confidence: 0.85 },
				{
					op: "add_preference_fact",
					claim: "prefers the dark background",
					keywords: ["dark", "background", "theme"],
				},
				{ op: "retract_trait", trait: "tone" },
			],
		});
		expect(parsed?.ops.map((o) => o.op)).toEqual([
			"set_trait",
			"add_directive",
			"add_preference_fact",
			"retract_trait",
		]);
	});

	it("drops a trait/value mismatch without discarding the rest, and warns", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parsed = parsePreferenceOutputTolerant({
				ops: [
					// "warm" is a tone value, not a verbosity value.
					{
						op: "set_trait",
						trait: "verbosity",
						value: "warm",
						confidence: 0.9,
					},
					{ op: "set_trait", trait: "tone", value: "warm", confidence: 0.9 },
				],
			});
			expect(parsed?.ops).toHaveLength(1);
			expect(parsed?.ops[0]).toMatchObject({ trait: "tone", value: "warm" });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "preferences",
					count: 1,
					issues: [expect.stringContaining("verbosity")],
				}),
				"dropped malformed preference op(s)",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("cannot represent a reply_gate write — the trait enum rejects it", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parsed = parsePreferenceOutputTolerant({
				ops: [
					{
						op: "set_trait",
						trait: "reply_gate",
						value: "never_until_lift",
						confidence: 1,
					},
				],
			});
			expect(parsed?.ops).toHaveLength(0);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("preserves complete directive text", () => {
		const parsed = mustParse({
			ops: [{ op: "add_directive", text: "x".repeat(500), confidence: 0.9 }],
		});
		const op = parsed.ops[0];
		expect(op.op).toBe("add_directive");
		if (op.op === "add_directive") expect(op.text).toBe("x".repeat(500));
	});

	it("returns null only when the envelope itself is not { ops: array }", () => {
		expect(parsePreferenceOutputTolerant({ nope: true })).toBeNull();
		expect(parsePreferenceOutputTolerant(null)).toBeNull();
		// Zero ops is a valid no-preference turn, not a parse failure.
		expect(parsePreferenceOutputTolerant({ ops: [] })).toEqual({ ops: [] });
	});
});

describe("applyPreferenceOps trait policy", () => {
	it("applies a high-confidence trait with agent_inferred provenance and an audit entry", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "set_trait",
						trait: "verbosity",
						value: "terse",
						confidence: 0.9,
					},
				],
			}),
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.verbosity).toBe("terse");
		expect(slot.source).toBe("agent_inferred");
		expect(fake.store.getRecentAudit()[0]?.action).toBe(
			"set_trait:verbosity=terse",
		);
		expect(result?.data).toMatchObject({ traitsSet: 1 });
	});

	it("discards a trait below the 0.8 confidence gate", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "set_trait",
						trait: "verbosity",
						value: "terse",
						confidence: 0.79,
					},
				],
			}),
		);
		expect(fake.store.getSlot(USER, AGENT).verbosity).toBeNull();
		expect(result?.data).toMatchObject({ traitsSet: 0, skipped: 1 });
	});

	it("never overwrites an explicitly-set trait, even at confidence 1", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			trait: "tone",
			value: "warm",
		});
		const result = await processOps(
			fake,
			mustParse({
				ops: [{ op: "set_trait", trait: "tone", value: "cold", confidence: 1 }],
			}),
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.tone).toBe("warm");
		expect(slot.source).toBe("user");
		expect(result?.data).toMatchObject({ traitsSet: 0, skipped: 1 });
	});

	it("may overwrite a previously inferred trait", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: AGENT,
			trait: "verbosity",
			value: "normal",
			source: "agent_inferred",
		});
		await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "set_trait",
						trait: "verbosity",
						value: "verbose",
						confidence: 0.9,
					},
				],
			}),
		);
		expect(fake.store.getSlot(USER, AGENT).verbosity).toBe("verbose");
	});

	it("gates every trait op against the pre-run slot: one inferred write cannot unlock overwriting an explicit trait in the same run", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			trait: "tone",
			value: "warm",
		});
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					// This null-trait fill marks only verbosity as inferred...
					{
						op: "set_trait",
						trait: "verbosity",
						value: "terse",
						confidence: 0.9,
					},
					// ...and must NOT let this op overwrite the explicit tone.
					{ op: "set_trait", trait: "tone", value: "cold", confidence: 0.95 },
				],
			}),
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.verbosity).toBe("terse");
		expect(slot.tone).toBe("warm");
		expect(result?.data).toMatchObject({ traitsSet: 1, skipped: 1 });
	});

	it("retracts an inferred trait but never an explicit one", async () => {
		const inferred = makeFakeRuntime({ agentId: AGENT });
		await inferred.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: AGENT,
			trait: "verbosity",
			value: "terse",
			source: "agent_inferred",
		});
		await processOps(
			inferred,
			mustParse({ ops: [{ op: "retract_trait", trait: "verbosity" }] }),
		);
		expect(inferred.store.getSlot(USER, AGENT).verbosity).toBeNull();

		const explicit = makeFakeRuntime({ agentId: AGENT });
		await explicit.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			trait: "verbosity",
			value: "terse",
		});
		const result = await processOps(
			explicit,
			mustParse({ ops: [{ op: "retract_trait", trait: "verbosity" }] }),
		);
		expect(explicit.store.getSlot(USER, AGENT).verbosity).toBe("terse");
		expect(result?.data).toMatchObject({ traitsRetracted: 0, skipped: 1 });
	});
});

describe("applyPreferenceOps cross-turn provenance", () => {
	it("a prior inferred directive write cannot unlock overwriting an explicit trait on a later turn (#14857 wave-2)", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		// Turn 0: the user explicitly sets tone.
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			trait: "tone",
			value: "warm",
		});
		// Turn 1: inference adds only a directive. The slot's last-writer
		// source flips to agent_inferred, but tone's provenance must not.
		await processOps(
			fake,
			mustParse({
				ops: [{ op: "add_directive", text: "no emojis", confidence: 0.9 }],
			}),
		);
		expect(fake.store.getSlot(USER, AGENT).source).toBe("agent_inferred");

		// Turn 2: a high-confidence inferred set_trait against the explicit
		// tone — the per-trait gate must refuse it.
		const result = await processOps(
			fake,
			mustParse({
				ops: [{ op: "set_trait", trait: "tone", value: "cold", confidence: 1 }],
			}),
			{ slot: fake.store.getSlot(USER, AGENT) },
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.tone).toBe("warm");
		expect(slot.trait_sources.tone).toBe("user");
		expect(result?.data).toMatchObject({ traitsSet: 0, skipped: 1 });
	});

	it("retracts an inferred trait even when another trait on the slot is explicit", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			trait: "tone",
			value: "warm",
		});
		await fake.store.applyTrait({
			scope: "user",
			userId: USER,
			agentId: AGENT,
			actorId: AGENT,
			trait: "verbosity",
			value: "terse",
			source: "agent_inferred",
		});
		const result = await processOps(
			fake,
			mustParse({ ops: [{ op: "retract_trait", trait: "verbosity" }] }),
			{ slot: fake.store.getSlot(USER, AGENT) },
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.verbosity).toBeNull();
		expect(slot.tone).toBe("warm");
		expect(slot.trait_sources.tone).toBe("user");
		expect(result?.data).toMatchObject({ traitsRetracted: 1 });
	});
});

describe("applyPreferenceOps directives", () => {
	it("adds a directive with agent_inferred provenance", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_directive",
						text: "one question at a time",
						confidence: 0.9,
					},
				],
			}),
		);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.custom_directives).toEqual(["one question at a time"]);
		expect(slot.source).toBe("agent_inferred");
	});

	it("preserves a distinct directive despite overlapping reply vocabulary", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await fake.store.addDirective({
			userId: USER,
			agentId: AGENT,
			actorId: USER,
			directive: "use formal replies",
		});
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_directive",
						text: "avoid formal replies",
						confidence: 0.9,
					},
				],
			}),
		);
		expect(fake.store.getSlot(USER, AGENT).custom_directives).toEqual([
			"use formal replies",
			"avoid formal replies",
		]);
		expect(result?.data).toMatchObject({ directivesAdded: 1 });
	});
});

describe("applyPreferenceOps preference facts", () => {
	it.each([
		["prefers tea over coffee", "prefers coffee over tea"],
		["likes oat milk", "does not like oat milk"],
	])("stores a distinct preference: %s / %s", async (storedClaim, newClaim) => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const existing = preferenceFact(
			"00000000-0000-4000-8000-0000000000af",
			storedClaim,
			[],
		);
		fake.memories.set("facts", [existing]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [{ op: "add_preference_fact", claim: newClaim, keywords: [] }],
			}),
			{ knownPreferenceFacts: [existing] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows.map((row) => row.content.text)).toEqual([
			storedClaim,
			newClaim,
		]);
		expect(result?.data).toMatchObject({ factsAdded: 1, factsStrengthened: 0 });
	});
	it("writes a durable preference fact row with extractor provenance", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers the dark background in the app",
						keywords: ["dark", "background", "theme"],
					},
				],
			}),
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0].content.text).toBe("prefers the dark background in the app");
		expect(rows[0].entityId).toBe(USER);
		expect(rows[0].metadata).toMatchObject({
			kind: "durable",
			category: "preference",
			source: "preference_extractor",
			verificationStatus: "self_reported",
		});
		expect((rows[0].metadata as { keywords?: string[] }).keywords).toEqual(
			expect.arrayContaining(["dark", "background"]),
		);
		expect(result?.data).toMatchObject({ factsAdded: 1 });
	});

	it("strengthens an existing similar preference instead of duplicating it", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const existing = preferenceFact(
			"00000000-0000-4000-8000-0000000000af",
			"the user prefers morning check-ins",
			["morning", "check", "ins"],
		);
		fake.memories.set("facts", [existing]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
			{ knownPreferenceFacts: [existing] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(1);
		expect(
			(rows[0].metadata as { confidence?: number }).confidence,
		).toBeCloseTo(0.8);
		expect(result?.data).toMatchObject({ factsAdded: 0, factsStrengthened: 1 });
	});

	it("promotes the same-message Stage-1 observation to the durable preference instead of adding a twin", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const stageFact: Memory = {
			id: "00000000-0000-4000-8000-0000000000c1" as UUID,
			entityId: USER,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "prefers morning check-ins", type: "fact" },
			metadata: {
				type: "custom",
				source: "facts_and_relationships_stage",
				messageId: makeMessage().id,
				kind: "current",
				category: "uncategorized",
				confidence: 0.6,
				keywords: ["prefers", "morning", "check", "ins"],
			},
			createdAt: Date.now() - 1_000,
		};
		fake.memories.set("facts", [stageFact]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "the user prefers morning check-ins",
						keywords: ["morning", "check-ins"],
						confidence: 0.85,
					},
				],
			}),
			{ knownPreferenceFacts: [] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(stageFact.id);
		expect(rows[0].content.text).toBe("prefers morning check-ins");
		expect(rows[0].metadata).toMatchObject({
			kind: "durable",
			category: "preference",
			promotedBy: "preference_extractor",
			confidence: 0.85,
		});
		expect((rows[0].metadata as { keywords?: string[] }).keywords).toEqual(
			expect.arrayContaining(["morning", "check", "ins"]),
		);
		expect(result?.data).toMatchObject({ factsAdded: 0, factsStrengthened: 1 });
	});

	it("never promotes a same-message row whose subject the room could not resolve", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const unresolved: Memory = {
			id: "00000000-0000-4000-8000-0000000000c4" as UUID,
			entityId: USER,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "prefers morning check-ins", type: "fact" },
			metadata: {
				type: "custom",
				source: "facts_and_relationships_stage",
				messageId: makeMessage().id,
				subject: "Carol",
				subjectResolved: false,
				kind: "current",
				category: "uncategorized",
				keywords: ["prefers", "morning", "check", "ins"],
			},
			createdAt: Date.now() - 1_000,
		};
		fake.memories.set("facts", [unresolved]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
			{ knownPreferenceFacts: [] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0].metadata).toMatchObject({
			kind: "current",
			subject: "Carol",
			subjectResolved: false,
		});
		expect(result?.data).toMatchObject({ factsAdded: 1, factsStrengthened: 0 });
	});

	it("never promotes or strengthens a row with the opposite polarity", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const negated: Memory = {
			id: "00000000-0000-4000-8000-0000000000c3" as UUID,
			entityId: USER,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "dislikes morning check-ins", type: "fact" },
			metadata: {
				type: "custom",
				source: "facts_and_relationships_stage",
				messageId: makeMessage().id,
				kind: "current",
				category: "uncategorized",
				keywords: ["dislikes", "morning", "check", "ins"],
			},
			createdAt: Date.now() - 1_000,
		};
		fake.memories.set("facts", [negated]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
			{ knownPreferenceFacts: [] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0].content.text).toBe("dislikes morning check-ins");
		expect(rows[0].metadata).toMatchObject({ kind: "current" });
		expect(result?.data).toMatchObject({ factsAdded: 1, factsStrengthened: 0 });
	});

	it("leaves a Stage-1 observation from another message alone and stores the preference separately", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const olderStageFact: Memory = {
			id: "00000000-0000-4000-8000-0000000000c2" as UUID,
			entityId: USER,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "prefers morning check-ins", type: "fact" },
			metadata: {
				type: "custom",
				source: "facts_and_relationships_stage",
				messageId: "00000000-0000-4000-8000-0000000000ff",
				kind: "current",
				category: "uncategorized",
				keywords: ["prefers", "morning", "check", "ins"],
			},
			createdAt: Date.now() - 1_000,
		};
		fake.memories.set("facts", [olderStageFact]);
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
			{ knownPreferenceFacts: [] },
		);
		const rows = fake.memories.get("facts") ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0].metadata).toMatchObject({ kind: "current" });
		expect(result?.data).toMatchObject({ factsAdded: 1, factsStrengthened: 0 });
	});

	it("dedupes against a preference row the fact evaluator inserted in the same turn (post-prepare)", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const insertedAfterPrepare = preferenceFact(
			"00000000-0000-4000-8000-0000000000b0",
			"the user prefers morning check-ins",
			["morning", "check", "ins"],
		);
		fake.memories.set("facts", [insertedAfterPrepare]);
		// prepared snapshot predates the row — the processor must re-fetch.
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
			{ knownPreferenceFacts: [] },
		);
		expect(fake.memories.get("facts") ?? []).toHaveLength(1);
		expect(result?.data).toMatchObject({ factsAdded: 0, factsStrengthened: 1 });
	});

	it("dedupes against a fact inserted earlier in the same run", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_preference_fact",
						claim: "prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
					{
						op: "add_preference_fact",
						claim: "the user prefers morning check-ins",
						keywords: ["morning", "check-ins"],
					},
				],
			}),
		);
		expect(fake.memories.get("facts") ?? []).toHaveLength(1);
		expect(result?.data).toMatchObject({ factsAdded: 1, factsStrengthened: 1 });
	});
});

describe("applyPreferenceOps boundaries", () => {
	it("no preference means no write anywhere", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const result = await processOps(fake, mustParse({ ops: [] }));
		expect(fake.memories.get("facts") ?? []).toHaveLength(0);
		const slot = fake.store.getSlot(USER, AGENT);
		expect(slot.verbosity).toBeNull();
		expect(slot.custom_directives).toEqual([]);
		expect(fake.store.getRecentAudit()).toHaveLength(0);
		expect(result?.data).toMatchObject({ traitsSet: 0, factsAdded: 0 });
	});

	it("without the PersonalityStore, the fact lane still lands and slot ops are dropped", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		(fake.runtime as unknown as { getService: () => null }).getService = () =>
			null;
		const result = await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "set_trait",
						trait: "verbosity",
						value: "terse",
						confidence: 0.9,
					},
					{
						op: "add_preference_fact",
						claim: "prefers the dark background",
						keywords: ["dark", "background"],
					},
				],
			}),
		);
		expect(fake.memories.get("facts") ?? []).toHaveLength(1);
		expect(result?.data).toMatchObject({ factsAdded: 1, droppedNoStore: 1 });
	});
});

describe("preferenceEvaluator gates and prompt", () => {
	it("shouldRun accepts a user message and rejects the agent's own or empty messages", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const base = { runtime: fake.runtime, options: {} };
		await expect(
			preferenceEvaluator.shouldRun({ ...base, message: makeMessage() }),
		).resolves.toBe(true);
		await expect(
			preferenceEvaluator.shouldRun({
				...base,
				message: { ...makeMessage(), entityId: AGENT },
			}),
		).resolves.toBe(false);
		await expect(
			preferenceEvaluator.shouldRun({
				...base,
				message: { ...makeMessage(), content: { text: "   " } },
			}),
		).resolves.toBe(false);
	});

	it("prompt shows current slot state and stored preferences", () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const prompt = preferenceEvaluator.prompt({
			runtime: fake.runtime,
			message: makeMessage(),
			state: EMPTY_STATE,
			options: {},
			prepared: {
				recentMessages: [makeMessage("please keep it short")],
				slot: {
					...fake.store.getSlot(USER, AGENT),
					verbosity: "terse",
					custom_directives: ["no emojis"],
					source: "agent_inferred",
				},
				knownPreferenceFacts: [
					preferenceFact(
						"00000000-0000-4000-8000-0000000000af",
						"prefers morning check-ins",
						["morning"],
					),
				],
			},
		});
		expect(prompt).toContain("set_trait");
		expect(prompt).toContain("verbosity: terse");
		expect(prompt).toContain("no emojis");
		expect(prompt).toContain("last set by: agent_inferred");
		expect(prompt).toContain("prefers morning check-ins");
		expect(prompt).toContain("please keep it short");
	});

	it("prompt stops advertising slot ops when the store is unavailable", () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		const prompt = preferenceEvaluator.prompt({
			runtime: fake.runtime,
			message: makeMessage(),
			state: EMPTY_STATE,
			options: {},
			prepared: { recentMessages: [], slot: null, knownPreferenceFacts: [] },
		});
		expect(prompt).not.toContain("set_trait");
		expect(prompt).not.toContain("add_directive");
		expect(prompt).toContain("add_preference_fact");
	});
});

describe("preference wire operation requirements", () => {
	it.each(["conversation", "task", "uncertain"])(
		"keeps %s instructions out of persistent traits, directives, and facts",
		async (scope) => {
			const fake = makeFakeRuntime({ agentId: AGENT });
			await fake.store.applyTrait({
				scope: "user",
				userId: USER,
				agentId: AGENT,
				actorId: AGENT,
				trait: "verbosity",
				value: "verbose",
				source: "agent_inferred",
			});
			const before = fake.store.getSlot(USER, AGENT);
			const output = mustParse({
				ops: [
					{
						op: "set_trait",
						scope,
						trait: "tone",
						value: "cold",
						confidence: 1,
					},
					{ op: "retract_trait", scope, trait: "verbosity" },
					{
						op: "add_directive",
						scope,
						text: "Wait for APPROVE VIOLET in this conversation.",
						confidence: 1,
					},
					{
						op: "add_preference_fact",
						scope,
						claim: "Use Calendar for this task only.",
					},
				],
			});
			const result = await processOps(fake, output);
			expect(fake.store.getSlot(USER, AGENT)).toEqual(before);
			expect(fake.memories.get("facts") ?? []).toEqual([]);
			expect(result?.data).toMatchObject({ notPersistedForScope: 4 });
		},
	);
	it("persists an explicitly classified cross-conversation preference", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT });
		await processOps(
			fake,
			mustParse({
				ops: [
					{
						op: "add_directive",
						scope: "across_conversations",
						text: "No emojis",
						confidence: 0.9,
					},
				],
			}),
		);
		expect(fake.store.getSlot(USER, AGENT).custom_directives).toEqual([
			"No emojis",
		]);
	});

	const cases = [
		{
			op: {
				op: "set_trait",
				trait: "verbosity",
				value: "terse",
				confidence: 0.9,
			},
			required: ["trait", "value", "confidence"],
		},
		{
			op: { op: "add_directive", text: "No emojis", confidence: 0.9 },
			required: ["text", "confidence"],
		},
		{
			op: { op: "add_preference_fact", claim: "Prefers morning check-ins" },
			required: ["claim"],
		},
		{ op: { op: "retract_trait", trait: "verbosity" }, required: ["trait"] },
	];
	for (const entry of cases) {
		it(`requires a valid scope on new ${entry.op.op} output while preserving staged legacy output`, () => {
			const schema = preferenceEvaluator.schema;
			if (!schema) throw new Error("Missing preference schema");
			const legacy = { ops: [entry.op] };
			const missing: string[] = [];
			validateSchema(schema, legacy, "", missing);
			expect(missing.length).toBeGreaterThan(0);
			expect(
				parsePreferenceOutputTolerant(legacy, { requireComplete: true }),
			).not.toBeNull();
			const invalid = { ops: [{ ...entry.op, scope: "invented_scope" }] };
			const errors: string[] = [];
			validateSchema(schema, invalid, "", errors);
			expect(errors.length).toBeGreaterThan(0);
			expect(
				parsePreferenceOutputTolerant(invalid, { requireComplete: true }),
			).toBeNull();
		});
		it(`requires parser fields for ${entry.op.op} before dispatch`, () => {
			const schema = preferenceEvaluator.schema;
			if (!schema) throw new Error("Missing preference schema");
			const scopedOp = { ...entry.op, scope: "across_conversations" };
			const output = { ops: [scopedOp] };
			const errors: string[] = [];
			validateSchema(schema, output, "", errors);
			expect(errors).toEqual([]);
			expect(
				parsePreferenceOutputTolerant(output, { requireComplete: true }),
			).not.toBeNull();
			for (const field of entry.required) {
				const incomplete: Record<string, unknown> = { ...scopedOp };
				delete incomplete[field];
				const invalid = { ops: [incomplete] };
				const missing: string[] = [];
				validateSchema(schema, invalid, "", missing);
				expect(missing.length).toBeGreaterThan(0);
				expect(
					parsePreferenceOutputTolerant(invalid, { requireComplete: true }),
				).toBeNull();
			}
		});
	}
});
