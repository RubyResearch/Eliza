import { isActiveMemoryEvidence } from "../utils/extraction-evidence.ts";
/**
 * Structural write-time dedupe for the `facts` table: before a fact insert,
 * find an existing row with the same normalized text in the same
 * room + entity scope so `runtime.createMemory` can skip the write and return
 * the existing row's id — after folding any stronger metadata the new
 * occurrence carries (higher confidence, an explicit kind, a fresher validity
 * timestamp) into the kept row, so a dedupe hit never drops new information.
 *
 * This guard exists because nothing else structurally prevents duplicate fact
 * rows. The adapter-level similarity check requires an embedding (facts
 * writers have none inline — embeddings are backfilled asynchronously) and is
 * bypassed entirely when callers pass an explicit `unique` flag, and the
 * per-turn LLM dedupe pool is advisory (the model can and does miss). The
 * live failure this closes: one extraction turn persisted the same claim
 * twice, milliseconds apart — a fact row plus a relationship-echo row — and
 * the FACTS reader surfaced both.
 *
 * Equivalence is text + scope equality after canonicalization, not semantic
 * similarity: paraphrase-level dedupe stays with the LLM pool and the
 * reflection pass. The candidate pool is bounded to the same recent window
 * the FACTS provider reads, so the check degrades to a plain insert (never an
 * error) on rooms with very deep fact history.
 */

import type {
	CustomMetadata,
	FactMetadata,
	Memory,
	MemoryMetadata,
} from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

const DEDUPE_CANDIDATE_POOL = 120;

/**
 * Canonical form for fact-text equality: case-, punctuation-, and
 * whitespace-insensitive, unicode-aware. An empty key never matches (so
 * punctuation-only or empty texts are never deduped against each other).
 */
export function normalizeFactTextKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Returns the existing `facts` row equivalent to `memory` (same normalized
 * text, same room, same entity), or null when the write should proceed. Rows
 * sharing `memory.id` are ignored — same-id idempotence is the adapter's
 * contract, not a duplicate.
 */
export async function findEquivalentFact(
	runtime: Pick<IAgentRuntime, "getMemories">,
	memory: Memory,
): Promise<Memory | null> {
	const text =
		typeof memory.content?.text === "string" ? memory.content.text : "";
	const key = normalizeFactTextKey(text);
	if (!key || !memory.roomId) return null;

	const existing = await runtime.getMemories({
		tableName: "facts",
		roomId: memory.roomId,
		count: DEDUPE_CANDIDATE_POOL,
		unique: false,
	});
	for (const candidate of existing) {
		if (!isActiveMemoryEvidence(candidate)) continue;
		if (!candidate.id || candidate.id === memory.id) continue;
		if ((candidate.entityId ?? null) !== (memory.entityId ?? null)) continue;
		const candidateText =
			typeof candidate.content?.text === "string" ? candidate.content.text : "";
		if (normalizeFactTextKey(candidateText) === key) return candidate;
	}
	return null;
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

/**
 * Field-wise "stronger metadata" merge for a dedupe hit: returns the kept
 * row's full metadata with the incoming occurrence's stronger fields applied,
 * or null when the incoming occurrence adds nothing (plain skip). Stronger
 * means, per field:
 *
 * - `confidence` — strictly higher (or present where the kept row has none).
 * - `kind` — present where the kept row has none. The FACTS reader defaults a
 *   missing kind to `durable`, so an explicit stamp is always more precise;
 *   an already-set kind is never flipped here (durable/current transitions
 *   belong to the reflection pass).
 * - `validAt` / `lastConfirmedAt` — strictly more recent (or newly present):
 *   a re-asserted `current` fact should not keep decaying from its first
 *   observation's timestamp.
 */
export function mergeStrongerFactMetadata(
	existing: Memory,
	incoming: Memory,
): MemoryMetadata | null {
	const kept = readFactMetadata(existing);
	const next = readFactMetadata(incoming);
	const upgrades: FactMetadata & CustomMetadata = {};
	const incomingEvidence = (incoming.metadata as CustomMetadata | undefined)
		?.extractionEvidenceIds;
	if (Array.isArray(incomingEvidence)) {
		const keptMetadata = existing.metadata as CustomMetadata | undefined;
		const keptEvidence = Array.isArray(keptMetadata?.extractionEvidenceIds)
			? keptMetadata.extractionEvidenceIds
			: [];
		const evidenceIds = [
			...new Set(
				[...keptEvidence, ...incomingEvidence].filter(
					(id): id is string => typeof id === "string",
				),
			),
		];
		if (evidenceIds.length !== keptEvidence.length)
			upgrades.extractionEvidenceIds = evidenceIds;
		const incomingRevisions = (incoming.metadata as CustomMetadata)
			.extractionSourceRevisions;
		const keptRevisions = keptMetadata?.extractionSourceRevisions;
		if (
			incomingRevisions &&
			typeof incomingRevisions === "object" &&
			!Array.isArray(incomingRevisions)
		) {
			upgrades.extractionSourceRevisions = {
				...(keptRevisions &&
				typeof keptRevisions === "object" &&
				!Array.isArray(keptRevisions)
					? keptRevisions
					: {}),
				...incomingRevisions,
			};
		}
	}

	// Historical backfill can rediscover rows processed before revision receipts
	// existed. Attach provenance, but do not treat old evidence as reconfirmation.
	if (
		(incoming.metadata as CustomMetadata | undefined)?.extractionBackfill ===
		true
	) {
		return Object.keys(upgrades).length === 0
			? null
			: ({ ...existing.metadata, ...upgrades } as MemoryMetadata);
	}

	if (
		typeof next.confidence === "number" &&
		Number.isFinite(next.confidence) &&
		(typeof kept.confidence !== "number" || next.confidence > kept.confidence)
	) {
		upgrades.confidence = next.confidence;
	}
	if (next.kind && !kept.kind) {
		upgrades.kind = next.kind;
	}
	for (const field of ["validAt", "lastConfirmedAt"] as const) {
		const incomingAt = Date.parse(next[field] ?? "");
		if (Number.isNaN(incomingAt)) continue;
		const keptAt = Date.parse(kept[field] ?? "");
		if (Number.isNaN(keptAt) || incomingAt > keptAt) {
			upgrades[field] = next[field];
		}
	}

	if (Object.keys(upgrades).length === 0) return null;
	return { ...existing.metadata, ...upgrades } as MemoryMetadata;
}
