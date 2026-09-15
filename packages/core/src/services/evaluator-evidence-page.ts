/** Lossless caller-requested historical evidence pages, scoped by the caller's
 * authoritative room read. A page never splits a source or silently clips it. */
import { ElizaError } from "../errors.ts";
import type { Memory } from "../types/index.ts";

export const DEFAULT_MEMORY_EVIDENCE_BATCH_BYTES = 65_536;

/** Model evidence excludes recovery transport; stored records stay untouched. */
export function evaluatorEvidenceRecord(memory: Memory): Memory {
	return {
		...memory,
		content: { ...memory.content, chatIdempotency: undefined },
	};
}

/** Charge the same evidence representation used for reference restoration. */
export function evaluatorEvidenceByteLength(memory: Memory): number {
	return new TextEncoder().encode(
		JSON.stringify(evaluatorEvidenceRecord(memory)),
	).byteLength;
}

export function previousEvidencePage(
	messages: readonly Memory[],
	beforeMessageId: string,
	maxBytes: number,
): { messages: Memory[]; hasEarlier: boolean } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new ElizaError("Evidence page requires a positive byte budget", {
			code: "EVALUATOR_BATCH_LIMIT_INVALID",
		});
	const ordered = [...messages].sort(
		(left, right) =>
			(left.createdAt ?? 0) - (right.createdAt ?? 0) ||
			String(left.id).localeCompare(String(right.id)),
	);
	const end = ordered.findIndex((message) => message.id === beforeMessageId);
	if (end < 0)
		throw new ElizaError("Evidence cursor is outside this room snapshot", {
			code: "EVALUATOR_REFERENCE_CURSOR_INVALID",
		});
	let start = end;
	let bytes = 0;
	while (start > 0) {
		const size = evaluatorEvidenceByteLength(ordered[start - 1]);
		if (size > maxBytes && start === end)
			throw new ElizaError(
				"One complete reference record exceeds the evidence page budget",
				{ code: "EVALUATOR_SOURCE_TOO_LARGE" },
			);
		if (bytes + size > maxBytes) break;
		bytes += size;
		start--;
	}
	return {
		messages: structuredClone(ordered.slice(start, end)),
		hasEarlier: start > 0,
	};
}

/** Admit complete evaluator pages against one shared evidence budget. Matching
 * records are charged once; pages that do not fit remain unacknowledged work. */
export function selectSharedEvidencePages<T>(
	entries: readonly T[],
	sources: (entry: T) => readonly Memory[],
	maxBytes: number,
): { selected: T[]; deferred: T[] } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new ElizaError("Evidence page requires a positive byte budget", {
			code: "EVALUATOR_BATCH_LIMIT_INVALID",
		});
	const selected: T[] = [];
	const deferred: T[] = [];
	const included = new Set<Memory["id"]>();
	let total = 0;
	for (const entry of entries) {
		const page = new Map(sources(entry).map((source) => [source.id, source]));
		let pageBytes = 0;
		let added = 0;
		for (const [id, source] of page) {
			const bytes = evaluatorEvidenceByteLength(source);
			pageBytes += bytes;
			if (!included.has(id)) added += bytes;
		}
		if (pageBytes > maxBytes)
			throw new ElizaError(
				"One complete evaluator page exceeds the shared evidence budget",
				{ code: "EVALUATOR_SOURCE_TOO_LARGE" },
			);
		if (total + added > maxBytes) {
			deferred.push(entry);
			continue;
		}
		selected.push(entry);
		total += added;
		for (const id of page.keys()) included.add(id);
	}
	return { selected, deferred };
}
