/** Shared read-side rule for retired inference evidence. Explicit/manual facts
 * remain authoritative independently of a conversational extractor's receipts. */
import type { EvaluatorRunContext } from "../types/evaluator.ts";
import { isObjectRecord } from "./type-guards.ts";

export function isProtectedMemoryEvidence(memory: {
	source?: unknown;
	metadata?: unknown;
	content?: unknown;
}): boolean {
	const metadata = isObjectRecord(memory.metadata) ? memory.metadata : {};
	const content = isObjectRecord(memory.content) ? memory.content : {};
	return (
		memory.source === "MEMORY" ||
		metadata.source === "MEMORY" ||
		content.source === "MEMORY" ||
		metadata.verificationStatus === "confirmed"
	);
}

export function isActiveMemoryEvidence(memory: {
	source?: unknown;
	metadata?: unknown;
	content?: unknown;
}): boolean {
	if (isProtectedMemoryEvidence(memory)) return true;
	const metadata = isObjectRecord(memory.metadata) ? memory.metadata : {};
	return (
		metadata.extractionStatus !== "source_invalidated" &&
		metadata.extractionReviewRequired !== true
	);
}

/** Personal reducers cannot emit a valid citation when the current evidence page
 * contains no message authored by their target speaker. A no-op acknowledges
 * that complete page without asking a model to extract from future context. */
export function hasNoPersonalExtractionSources({
	message,
	options,
}: Pick<EvaluatorRunContext, "message" | "options">): boolean {
	return (
		options.extraction !== undefined &&
		!options.extraction.messages.some(
			(source) => source.entityId === message.entityId,
		)
	);
}
