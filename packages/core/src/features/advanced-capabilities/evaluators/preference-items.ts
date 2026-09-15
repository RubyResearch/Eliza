/**
 * Passive user-preference extraction evaluator (`preferences`) — the
 * conversational writer for the personality behavior loop (#14675). Runs
 * post-response beside the reflection evaluators and extracts, via one
 * strict-JSON-schema model call, preferences the user expressed in passing
 * ("ugh, that was way too long", "no emojis please", "I prefer morning
 * check-ins") — zero explicit input required.
 *
 * Writes route to the store that can already act on each kind, so no new
 * store or provider exists here. Closed-enum reply-style traits and custom
 * directives go to the PersonalityStore slot with source "agent_inferred";
 * `userPersonalityProvider` re-injects them into every prompt and verbosity is
 * hard-enforced in the reply callback. Domain / view / interaction-pattern
 * preferences land as durable `preference` facts in the facts table, consumed
 * by the FACTS provider and downstream systems (LifeOps scheduling, view
 * actions) exactly like fact-extractor rows.
 *
 * Safety invariants: inference never overwrites an explicitly-set trait —
 * gates read the per-trait provenance in `slot.trait_sources`, so explicit
 * beats inferred at any confidence and across turns (a lone inferred directive
 * write cannot relabel the slot and unlock a later overwrite). `reply_gate` is
 * never touched (silencing the agent off an inferred signal is a hazard; the
 * op is not even representable in the schema), and global scope is never
 * written. Trait gates read the slot snapshot taken before any write this run,
 * so one inferred write cannot change another op's gate in the same run.
 * On runtimes without the PersonalityStore service
 * (advanced capabilities off), the fact lane still works and slot ops are
 * dropped with a debug log — the counters in the processor result record it.
 */

import { v4 } from "uuid";
import { ElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import {
	getRoomTranscript,
	recentMessagesSection,
} from "../../../services/evaluator-transcript.ts";
import type {
	Evaluator,
	EvaluatorRunOptions,
	IAgentRuntime,
	JSONSchema,
	Memory,
	MemoryMetadata,
	RegisteredEvaluator,
	UUID,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import type { CustomMetadata, FactMetadata } from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import { stableStringify } from "../../../utils/deterministic.ts";
import {
	hasNoPersonalExtractionSources,
	isActiveMemoryEvidence,
} from "../../../utils/extraction-evidence.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import { stringToUuid } from "../../../utils.ts";
import {
	buildFactKeywordsForStorage,
	buildFactSearchText,
	factClaimsEquivalent,
	factLexicalSimilarity,
	factPolarityDiffers,
	readStoredFactKeywords,
} from "../fact-keywords.ts";
import {
	getPersonalityStore,
	type PersonalityStore,
} from "../personality/services/personality-store.ts";
import {
	FORMALITY_VALUES,
	type PersonalitySlot,
	TONE_VALUES,
	TRAIT_VALUES,
	VERBOSITY_VALUES,
} from "../personality/types.ts";
import { reconcileFactEvidence } from "./extraction-reconciliation.ts";
import {
	type AddDirectiveOp,
	type AddPreferenceFactOp,
	PREFERENCE_SCOPES,
	type PreferenceExtractorOutput,
	parsePreferenceOutputTolerant,
	type RetractTraitOp,
	type SetTraitOp,
} from "./preferenceExtractor.schema.ts";
import {
	assertPersonalExtractionOperations,
	canEvaluateMessage,
	DEDUP_SIMILARITY_THRESHOLD,
	extractionEvidenceMetadata,
	hasExtractionEvidence,
	NEW_FACT_CONFIDENCE,
	personalExtractionEvidence,
	preserveFactMetadata,
	reviewChangedExtractionSources,
	STRENGTHEN_DELTA,
	updateExtractedFact,
} from "./reflection-items.ts";

// Slot writes shape EVERY subsequent prompt for this user (and verbosity is
// hard-enforced post-generation), so only high-confidence signals may touch
// the PersonalityStore. Preference facts have no gate — they go through the
// same dedupe/strengthen discipline as fact-extractor rows and only surface
// via ranked retrieval.
const SLOT_CONFIDENCE_THRESHOLD = 0.8;

const preferenceEvidenceProperties: Record<string, JSONSchema> = {
	scope: {
		type: "string",
		enum: [...PREFERENCE_SCOPES],
		description:
			"Applicability of the original preference. Only across_conversations may change persistent user preferences. Preserve explicit conversation/task limits; uncertain scope must not become persistent.",
	},
	sourceMessageIds: { type: "array", items: { type: "string" } },
	evidence: { type: "string" },
};

const preferenceConfidenceSchema: JSONSchema = {
	type: "number",
	description: "Honest confidence from 0 to 1.",
};

const preferenceOpsSchema: JSONSchema = {
	type: "object",
	properties: {
		ops: {
			type: "array",
			items: {
				// Each operation advertises the fields its parser requires. A flat
				// optional-field object permits outputs that repeatedly fail parsing.
				anyOf: [
					{
						type: "object",
						properties: {
							...preferenceEvidenceProperties,
							op: { type: "string", enum: ["set_trait"] },
							trait: { type: "string", enum: [...TRAIT_VALUES] },
							// Trait/value pairing remains validated by the parser.
							value: {
								type: "string",
								enum: [
									...VERBOSITY_VALUES,
									...TONE_VALUES,
									...FORMALITY_VALUES,
								],
							},
							confidence: preferenceConfidenceSchema,
						},
						required: ["op", "scope", "trait", "value", "confidence"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							...preferenceEvidenceProperties,
							op: { type: "string", enum: ["add_directive"] },
							text: { type: "string" },
							confidence: preferenceConfidenceSchema,
						},
						required: ["op", "scope", "text", "confidence"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							...preferenceEvidenceProperties,
							op: { type: "string", enum: ["add_preference_fact"] },
							claim: { type: "string" },
							keywords: { type: "array", items: { type: "string" } },
							confidence: preferenceConfidenceSchema,
						},
						required: ["op", "scope", "claim"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							...preferenceEvidenceProperties,
							op: { type: "string", enum: ["retract_trait"] },
							trait: { type: "string", enum: [...TRAIT_VALUES] },
							reason: { type: "string" },
						},
						required: ["op", "scope", "trait"],
						additionalProperties: false,
					},
				],
			},
		},
	},
	required: ["ops"],
	additionalProperties: false,
};

export interface PreferencePrepared {
	recentMessages: Memory[];
	/** Null when the PersonalityStore service is not registered. */
	slot: PersonalitySlot | null;
	knownPreferenceFacts: Memory[];
}

function nowIso(): string {
	return new Date().toISOString();
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function isDurablePreferenceFact(memory: Memory): boolean {
	const meta = readFactMetadata(memory);
	return (
		isActiveMemoryEvidence(memory) &&
		meta.category === "preference" &&
		meta.kind !== "current"
	);
}

/**
 * Stage-1 stores the same turn's `extract.facts` as lapsing
 * `current/uncategorized` rows. A row extracted from THIS message is the same
 * observation the extractor is now classifying, so it is upgraded in place
 * rather than shadowed by a durable twin. Other messages' rows are never
 * merged: lexical overlap cannot tell a restatement from a changed value.
 */
function isSameMessageStageFact(memory: Memory, message: Memory): boolean {
	if (!message.id) return false;
	const meta = memory.metadata as Record<string, unknown> | undefined;
	return (
		memory.entityId === message.entityId &&
		memory.roomId === message.roomId &&
		meta?.source === "facts_and_relationships_stage" &&
		meta.kind === "current" &&
		meta.messageId === message.id &&
		// A fallback row whose subject the room could not resolve is not the
		// author's own observation and is never promoted as their preference.
		meta.subjectResolved !== false
	);
}

function pickFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return NEW_FACT_CONFIDENCE;
}

async function preparePreferences(
	runtime: IAgentRuntime,
	message: Memory,
	options: EvaluatorRunOptions,
): Promise<PreferencePrepared> {
	const [recentMessagesRaw, entityFacts] = await Promise.all([
		options.extraction?.messages ?? getRoomTranscript(runtime, message),
		runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			entityId: message.entityId,
			authorEntityIds: [message.entityId],
			unique: false,
		}),
	]);
	const recentMessages = recentMessagesRaw.filter(
		(memory) => !isSyntheticConversationArtifactMemory(memory),
	);
	const knownPreferenceFacts = entityFacts.filter(isDurablePreferenceFact);
	const store = getPersonalityStore(runtime);
	return {
		recentMessages,
		slot: store ? store.getSlot(message.entityId) : null,
		knownPreferenceFacts,
	};
}

function formatSlotForPrompt(slot: PersonalitySlot | null): string {
	if (!slot) return "(personality slot store unavailable)";
	const lines: string[] = [];
	if (slot.verbosity) lines.push(`- verbosity: ${slot.verbosity}`);
	if (slot.tone) lines.push(`- tone: ${slot.tone}`);
	if (slot.formality) lines.push(`- formality: ${slot.formality}`);
	slot.custom_directives.forEach((directive, index) => {
		lines.push(`- directive ${index + 1}: ${directive}`);
	});
	if (lines.length === 0) return "(none set)";
	lines.push(`- last set by: ${slot.source}`);
	return lines.join("\n");
}

function formatKnownPreferences(facts: Memory[]): string {
	const lines: string[] = [];
	for (const fact of facts) {
		const text = fact.content.text ?? "";
		if (text) lines.push(`- ${text}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

type SlotOpOutcome =
	| "applied"
	| "unchanged"
	| "skipped_low_confidence"
	| "skipped_explicit";

/**
 * Gates read per-trait provenance (`trait_sources[trait]`), never the
 * slot-level `source`: `source` records only the last writer, so one inferred
 * directive write would relabel the whole slot and unlock overwriting an
 * explicitly-set trait on a later turn. `gateSlot` is the pre-run snapshot so
 * one run's writes cannot change another op's gate inside the same run.
 */
async function applySetTrait(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	gateSlot: PersonalitySlot,
	op: SetTraitOp,
	evidenceId?: string,
): Promise<SlotOpOutcome> {
	if (
		evidenceId &&
		store
			.getSlot(userId, runtime.agentId)
			.extraction_evidence_ids?.includes(evidenceId)
	)
		return "unchanged";
	if (op.confidence < SLOT_CONFIDENCE_THRESHOLD)
		return "skipped_low_confidence";
	const current = gateSlot[op.trait];
	if (current === op.value) return "unchanged";
	if (
		current !== null &&
		gateSlot.trait_sources[op.trait] !== "agent_inferred"
	) {
		return "skipped_explicit";
	}
	await store.applyTrait({
		scope: "user",
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		trait: op.trait,
		value: op.value,
		source: "agent_inferred",
		extractionEvidenceId: evidenceId,
	});
	return "applied";
}

async function applyRetractTrait(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	gateSlot: PersonalitySlot,
	op: RetractTraitOp,
	evidenceId?: string,
): Promise<SlotOpOutcome> {
	if (
		evidenceId &&
		store
			.getSlot(userId, runtime.agentId)
			.extraction_evidence_ids?.includes(evidenceId)
	)
		return "unchanged";
	// Retraction only undoes inference. An explicitly-set trait (per-trait
	// source user/admin) is cleared through the PERSONALITY action, never by
	// the extractor.
	if (gateSlot[op.trait] === null) return "unchanged";
	if (gateSlot.trait_sources[op.trait] !== "agent_inferred") {
		return "skipped_explicit";
	}
	await store.applyTrait({
		scope: "user",
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		trait: op.trait,
		value: null,
		source: "agent_inferred",
		extractionEvidenceId: evidenceId,
	});
	return "applied";
}

async function applyAddDirective(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	op: AddDirectiveOp,
	evidenceId?: string,
): Promise<"added" | "deduped" | "skipped_low_confidence"> {
	if (
		evidenceId &&
		store
			.getSlot(userId, runtime.agentId)
			.extraction_evidence_ids?.includes(evidenceId)
	)
		return "deduped";
	if (op.confidence < SLOT_CONFIDENCE_THRESHOLD)
		return "skipped_low_confidence";
	// Dedupe against the LIVE slot (unlike trait gates) so two near-identical
	// directives emitted in one run collapse to one entry.
	const existing = store.getSlot(userId, runtime.agentId).custom_directives;
	const isDuplicate = existing.some((directive) =>
		factClaimsEquivalent(op.text, directive),
	);
	if (isDuplicate) return "deduped";
	await store.addDirective({
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		directive: op.text,
		source: "agent_inferred",
		extractionEvidenceId: evidenceId,
	});
	return "added";
}

interface FactCandidate {
	memory: Memory;
	searchText: string;
}

async function applyAddPreferenceFact(
	runtime: IAgentRuntime,
	message: Memory,
	candidates: FactCandidate[],
	op: AddPreferenceFactOp,
	extraction: EvaluatorRunOptions["extraction"],
): Promise<{ added: boolean; strengthened: boolean }> {
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		"preference",
	);
	const targetValues = [op.claim, "preference", keywords];
	let best: { memory: Memory; similarity: number } | null = null;
	for (const candidate of candidates) {
		const candidateText =
			typeof candidate.memory.content.text === "string"
				? candidate.memory.content.text
				: "";
		// A negated candidate is a different claim however many words it shares.
		if (factPolarityDiffers(op.claim, candidateText)) continue;
		// Promoting a Stage-1 observation rewrites its classification, so only the
		// identical claim qualifies; a durable preference is merely strengthened.
		if (!factClaimsEquivalent(op.claim, candidateText)) {
			continue;
		}
		const similarity = factLexicalSimilarity(targetValues, [
			candidate.searchText,
			readStoredFactKeywords(candidate.memory),
		]);
		if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
			if (!best || similarity > best.similarity) {
				best = { memory: candidate.memory, similarity };
			}
		}
	}
	if (best?.memory.id) {
		if (extraction) {
			const latest = await runtime.getMemoryById(best.memory.id);
			if (!latest)
				throw new ElizaError(
					"Preference fact disappeared before extraction update",
					{ code: "EXTRACTED_FACT_WRITE_FAILED" },
				);
			best.memory = latest;
		}
		if (hasExtractionEvidence(best.memory.metadata, extraction))
			return { added: false, strengthened: false };
		if (extraction?.isBackfill) {
			await updateExtractedFact(runtime, best.memory, {
				...preserveFactMetadata(best.memory),
				...extractionEvidenceMetadata(best.memory.metadata, extraction),
			});
			return { added: false, strengthened: false };
		}
		// Update-not-duplicate: a re-stated preference reinforces the existing
		// row instead of creating a near-copy the provider would rank twice; a
		// same-message Stage-1 observation is promoted to the durable preference.
		const nextMeta: CustomMetadata = isSameMessageStageFact(
			best.memory,
			message,
		)
			? {
					...preserveFactMetadata(best.memory),
					kind: "durable",
					category: "preference",
					promotedBy: "preference_extractor",
					keywords: [
						...new Set([...readStoredFactKeywords(best.memory), ...keywords]),
					],
					confidence: clamp01(op.confidence ?? NEW_FACT_CONFIDENCE),
					lastConfirmedAt: nowIso(),
				}
			: {
					...preserveFactMetadata(best.memory),
					confidence: clamp01(
						pickFactConfidence(best.memory) + STRENGTHEN_DELTA,
					),
					lastConfirmedAt: nowIso(),
				};
		Object.assign(
			nextMeta,
			extractionEvidenceMetadata(best.memory.metadata, extraction),
		);
		await updateExtractedFact(runtime, best.memory, nextMeta);
		return { added: false, strengthened: true };
	}
	const metadata: MemoryMetadata = {
		type: MemoryType.CUSTOM,
		source: "preference_extractor",
		// The model's own confidence when it gave one (the schema advertises
		// it); the shared default only backfills its absence.
		confidence: clamp01(op.confidence ?? NEW_FACT_CONFIDENCE),
		lastConfirmedAt: nowIso(),
		kind: "durable",
		category: "preference",
		structuredFields: {},
		keywords,
		verificationStatus: "self_reported",
		...extractionEvidenceMetadata(undefined, extraction),
	};
	const memory: Memory = {
		id: asUUID(v4()),
		entityId: message.entityId,
		agentId: runtime.agentId,
		roomId: message.roomId,
		content: { text: op.claim },
		metadata,
		createdAt: Date.now(),
	};
	const persistedId = await runtime.createMemory(memory, "facts", true);
	if (extraction && !persistedId)
		throw new ElizaError("Preference fact insert was not persisted", {
			code: "EXTRACTED_FACT_WRITE_FAILED",
		});
	if (persistedId) {
		candidates.push({ memory, searchText: buildFactSearchText(memory) });
	}
	return { added: persistedId != null, strengthened: false };
}

export const preferenceEvaluator: Evaluator<
	PreferenceExtractorOutput,
	PreferencePrepared
> = {
	name: "preferences",
	resolveOutputWhen: hasNoPersonalExtractionSources,
	resolveOutput: () => ({ ops: [] }),
	reconcileEvidence: reconcileFactEvidence,
	incremental: true,
	background: true,
	description:
		"Extracts user preferences about the agent, views, and interaction style from ordinary conversation.",
	priority: EvaluatorPriority.REFLECTION_PREFERENCES,
	schema: preferenceOpsSchema,
	async shouldRun({ runtime, message, options }) {
		// The agent's own messages carry no user preference signal, and
		// evaluating them would let the agent "infer" preferences from itself.
		return (
			canEvaluateMessage(message, options) &&
			message.entityId !== runtime.agentId
		);
	},
	async prepare({ runtime, message, options }) {
		return preparePreferences(runtime, message, options);
	},
	prompt({ runtime, message, prepared, shared }) {
		const agentName = runtime.character.name ?? "Agent";
		// Without the PersonalityStore, slot ops would be dropped in the
		// processor anyway — don't advertise them, so the model routes
		// everything usable through the fact lane.
		const slotOps = prepared.slot
			? `- set_trait: reply style that clearly maps to a closed trait value. verbosity: terse|normal|verbose. tone: warm|neutral|direct|cold. formality: casual|professional|formal.
- add_directive: standing reply-style rule with no trait mapping ("no emojis", "one question at a time", "don't stack messages"). Preserve the complete rule and its qualifiers.
- retract_trait: the user pushes back on an inferred trait shown below.
`
			: "";
		const complaintExample = prepared.slot
			? '"ugh, way too long" -> set_trait verbosity=terse'
			: '"ugh, way too long" -> add_preference_fact "prefers short replies"';
		return `Find preferences the user expressed about how ${agentName} should behave or how they want to interact. Passive signals count: complaints (${complaintExample}), asides, repeated corrections — not just direct requests.

Ops:
${slotOps}- add_preference_fact: preferences that are knowledge rather than reply style — views/UI (theme, background, widgets), content, timing ("morning check-ins", "quiet hours after 10pm"), interaction patterns ("prefers chat over views", "reads slowly, wants time to think"). claim + 3-8 lowercase retrieval keywords.

Rules:
- Only the speaker's own expressed preferences. Not the agent's suggestions, not hypotheticals, not third parties.
- Classify every operation's scope from its original evidence: across_conversations for a lasting preference; conversation for this chat; task for the current task, reply, example or temporary instruction; uncertain when its applicability is unresolved. Never broaden "for the rest of this conversation" into a lasting preference or treat a task-specific correction as a permanent trait retraction. Only across_conversations operations are persisted. Other instructions remain in their complete original dialogue; do not strip their scope or copy them into a lasting preference fact. General style preferences and passive style complaints may be lasting when no temporary restriction is expressed.
- In incremental extraction, EVERY operation must include sourceMessageIds citing selected new message IDs authored by this speaker. Never cite reference messages or other speakers. Omit unsupported operations.
- New evidence must come from this speaker's newly selected messages. Historical reference text and known preferences are context only; do not reinforce them just because they appear.
${prepared.slot ? "- set_trait and add_directive require numeric confidence from 0 to 1; never omit it. Slot ops below 0.8 are discarded. Confidence is unused for retract_trait.\n" : ""}- Confidence is optional for add_preference_fact; when present it must be an honest number from 0 to 1.
- No preference expressed -> {"ops":[]}.
- Never emit anything about muting, ignoring, or when ${agentName} may reply.

Current personality for this user:
Speaker entity id: ${message.entityId}
${formatSlotForPrompt(prepared.slot)}

Known preferences already stored:
${formatKnownPreferences(prepared.knownPreferenceFacts)}

${recentMessagesSection(shared, prepared.recentMessages)}`;
	},
	parse(output, context) {
		// Incremental progress covers the complete evidence batch. Reject a
		// partially valid section before staging or effects so it remains work.
		const parsed = parsePreferenceOutputTolerant(output, {
			requireComplete: Boolean(context?.options.extraction),
		});
		// JSON-object/fallback providers may ignore the wire schema. Enforce
		// scope on fresh model output too, while replaying the old stored contract.
		if (
			context?.outputSource === "model" &&
			parsed?.ops.some((op) => op.scope === undefined)
		)
			return null;
		if (parsed && context)
			assertPersonalExtractionOperations(
				context.message,
				context.options.extraction,
				parsed.ops,
			);
		return parsed;
	},
	processors: [
		{
			name: "applyPreferenceOps",
			async process({ runtime, message, prepared, output, options }) {
				assertPersonalExtractionOperations(
					message,
					options.extraction,
					output.ops,
				);
				// Scope is semantic model output, not a keyword heuristic. Keep local
				// instructions in canonical dialogue; this writer owns persistent preferences.
				// Missing scope belongs to legacy/staged outputs from the older contract.
				const persistentOps = output.ops.filter(
					(op) => op.scope === undefined || op.scope === "across_conversations",
				);
				const notPersistedForScope = output.ops.length - persistentOps.length;
				const store = getPersonalityStore(runtime);
				const userId = message.entityId;
				// Pre-run snapshot for trait gates — see applySetTrait.
				const gateSlot = store ? store.getSlot(userId) : null;
				// Re-fetch dedupe candidates at process() time: the fact evaluator
				// (priority 100) runs in the same merged post-turn call BEFORE this
				// processor and may have just inserted `preference` rows the
				// prepare-time snapshot cannot see — deduping against the snapshot
				// would double-store the same preference in one turn.
				const hasFactOps = persistentOps.some(
					(op) => op.op === "add_preference_fact",
				);
				const freshFacts = hasFactOps
					? (
							await runtime.getMemories({
								tableName: "facts",
								roomId: message.roomId,
								entityId: message.entityId,
								authorEntityIds: [message.entityId],
								unique: false,
							})
						).filter(
							(memory) =>
								isDurablePreferenceFact(memory) ||
								isSameMessageStageFact(memory, message),
						)
					: prepared.knownPreferenceFacts;
				const candidates: FactCandidate[] = freshFacts.map((memory) => ({
					memory,
					searchText: buildFactSearchText(memory),
				}));
				const sourceReviews = await reviewChangedExtractionSources(
					runtime,
					freshFacts,
					options.extraction,
				);
				let traitsSet = 0;
				let traitsRetracted = 0;
				let directivesAdded = 0;
				let factsAdded = 0;
				let factsStrengthened = 0;
				let skipped = 0;
				let droppedNoStore = 0;
				for (const op of persistentOps) {
					const evidenceId = options.extraction
						? `${options.extraction.evidenceId}:${stringToUuid(stableStringify(op))}`
						: undefined;
					if (op.op === "add_preference_fact") {
						const result = await applyAddPreferenceFact(
							runtime,
							message,
							candidates,
							op,
							personalExtractionEvidence(
								message,
								options.extraction,
								op.sourceMessageIds,
							),
						);
						if (result.added) factsAdded += 1;
						if (result.strengthened) factsStrengthened += 1;
						continue;
					}
					if (!store || !gateSlot) {
						droppedNoStore += 1;
						continue;
					}
					if (op.op === "set_trait") {
						const outcome = await applySetTrait(
							store,
							runtime,
							userId,
							gateSlot,
							op,
							evidenceId,
						);
						if (outcome === "applied") traitsSet += 1;
						else skipped += 1;
						continue;
					}
					if (op.op === "add_directive") {
						const outcome = await applyAddDirective(
							store,
							runtime,
							userId,
							op,
							evidenceId,
						);
						if (outcome === "added") directivesAdded += 1;
						else skipped += 1;
						continue;
					}
					const outcome = await applyRetractTrait(
						store,
						runtime,
						userId,
						gateSlot,
						op,
						evidenceId,
					);
					if (outcome === "applied") traitsRetracted += 1;
					else skipped += 1;
				}
				if (droppedNoStore > 0) {
					// Expected on runtimes without advanced capabilities (the store is
					// a config choice, not a broken pipeline) — debug, not warn, and
					// the counters below keep it visible in trajectories.
					logger.debug(
						{ src: "preferences", droppedNoStore },
						"PersonalityStore unavailable; dropped slot ops",
					);
				}
				const counters = {
					notPersistedForScope,
					traitsSet,
					traitsRetracted,
					directivesAdded,
					factsAdded,
					factsStrengthened,
					skipped,
					droppedNoStore,
					...(options.extraction ? { sourceReviews } : {}),
				};
				return { success: true, values: counters, data: counters };
			},
		},
	],
};

export const preferenceItems: RegisteredEvaluator[] = [preferenceEvaluator];
