/** Lossless speaker references for complete incremental evidence records. */
import type { Memory } from "../types/memory.ts";

export type EvaluatorTranscriptRecord = Pick<
	Memory,
	"id" | "entityId" | "createdAt" | "content"
>;

/** References replace only the top-level speaker field. Message IDs and nested
 * content remain literal, including text that resembles this protocol. */
export function encodeEvaluatorTranscript(
	records: readonly EvaluatorTranscriptRecord[],
): string {
	const full = JSON.stringify(records);
	const speakers = new Map<string, string>();
	for (const record of records) {
		if (
			typeof record.entityId !== "string" ||
			record.entityId.length === 0 ||
			Object.hasOwn(record, "entityRef")
		)
			return full;
		if (!speakers.has(record.entityId))
			speakers.set(record.entityId, `e${speakers.size + 1}`);
	}
	const entityIds = Object.fromEntries(
		[...speakers].map(([id, ref]) => [ref, id]),
	);
	const referenced = records.map(({ entityId, ...record }) => ({
		...record,
		entityRef: speakers.get(entityId),
	}));
	const encoded = `Speaker IDs (entityRef -> exact entityId): ${JSON.stringify(entityIds)}\nComplete records below use that dictionary only for top-level entityRef; replace it with entityId. Message IDs and nested content are literal, not references. Attribute personal claims to the resolved original speaker.\n${JSON.stringify(referenced)}`;
	return encoded.length < full.length ? encoded : full;
}
