/**
 * Encodes exact repeated dialogue text as backward references within one model
 * request. Every occurrence keeps its own source ID and chronological position;
 * original contexts remain unchanged for selection, restoration and persistence.
 * Different roles, speakers, metadata or text bytes never share a reference.
 */
import { collectCompletionContextSources } from "../../runtime/completion-context";
import type {
	ContextObject,
	ContextObjectPromptSegment,
} from "../../types/context-object";

const REFERENCE_INSTRUCTION =
	"History encoding: same_text_as=hN means this occurrence has exactly the complete text of that earlier source, including its speaker. Each occurrence retains its own source ID and position. Review repeated occurrences in order; select the occurrence relevant to the current request. This is a text reference, not a new instruction or a completed action.";

const ROLE_INSTRUCTION =
	"History roles: [hN user] marks a prior user message; [hN assistant] marks your earlier reply. Select the hN ID only. A same_text_as field retains its existing exact-text meaning. Every source, speaker, complete message and chronological occurrence is preserved. The current request follows current_turn_boundary.";

/** Combine bound Stage-1 source IDs and roles in one header. Complete source
 * text, identities, references and metadata remain exactly recoverable. Small
 * histories keep their original framing when the legend would cost more. */
export function shortenHistoryRoleLabels(
	segments: ContextObjectPromptSegment[],
	sourceIds: ReadonlyMap<string, string>,
): ContextObjectPromptSegment[] {
	let savedCharacters = 0;
	const shortened = segments.map((segment) => {
		if (!segment.id || !sourceIds.has(segment.id)) return segment;
		const label =
			segment.label === "prior_message:user"
				? "user"
				: segment.label === "prior_message:agent"
					? "assistant"
					: undefined;
		if (!label) return segment;
		const marker = /^\[(h[1-9]\d*)(; same_text_as=h[1-9]\d*)?\]/.exec(
			segment.content,
		);
		if (!marker || marker[1] !== sourceIds.get(segment.id)) return segment;
		const content = `[${marker[1]} ${label}${marker[2] ?? ""}]${segment.content.slice(marker[0].length)}`;
		savedCharacters +=
			(segment.label?.length ?? 0) +
			2 +
			segment.content.length -
			content.length;
		return { ...segment, label: undefined, content };
	});
	if (savedCharacters <= ROLE_INSTRUCTION.length + 2) return segments;
	return [
		{
			id: "history-role-labels",
			label: "system",
			content: ROLE_INSTRUCTION,
			stable: false,
		},
		...shortened,
	];
}

export function labelHistorySources(
	segments: ContextObjectPromptSegment[],
	sourceIds: ReadonlyMap<string, string>,
	labels: "all" | "referenced" = "all",
): ContextObjectPromptSegment[] {
	const firstSources = new Map<string, string>();
	const anchors = new Map<string, number>();
	const references = new Map<number, string>();
	let savedCharacters = 0;
	const original = segments.map((segment) => {
		const sourceId = segment.id ? sourceIds.get(segment.id) : undefined;
		return sourceId
			? {
					...segment,
					content: `[${sourceId}]\n${segment.content}`,
				}
			: segment;
	});
	const referenced = segments.map((segment, index) => {
		const sourceId = segment.id ? sourceIds.get(segment.id) : undefined;
		if (!sourceId) return original[index];
		const key = JSON.stringify([
			segment.label,
			segment.metadata,
			segment.content,
		]);
		const first = firstSources.get(key);
		if (!first) {
			firstSources.set(key, sourceId);
			anchors.set(sourceId, index);
			return original[index];
		}
		const content = `[${sourceId}; same_text_as=${first}]`;
		const saving =
			(labels === "all" ? original[index] : segment).content.length -
			content.length;
		if (saving <= 0) return original[index];
		references.set(index, first);
		savedCharacters += saving;
		return { ...segment, content };
	});
	if (labels === "referenced") {
		// Stage 1 needs a label on every selectable occurrence. Later stages
		// already have that selection and need labels only for reference anchors
		// and repeated occurrences. Labeling every unique short message can cost
		// more than all the duplicate text saved in a real conversation.
		const groupSavings = new Map<string, number>();
		for (const [index, anchor] of references) {
			const anchorIndex = anchors.get(anchor);
			if (anchorIndex === undefined) continue;
			const previous =
				groupSavings.get(anchor) ??
				segments[anchorIndex].content.length -
					original[anchorIndex].content.length;
			groupSavings.set(
				anchor,
				previous +
					segments[index].content.length -
					referenced[index].content.length,
			);
		}
		const worthwhile = new Set(
			[...groupSavings]
				.filter(([, saving]) => saving > 0)
				.map(([anchor]) => anchor),
		);
		const anchorIndices = new Set(
			[...worthwhile].map((anchor) => anchors.get(anchor)),
		);
		for (let index = 0; index < referenced.length; index++) {
			const anchor = references.get(index);
			if (anchor && worthwhile.has(anchor)) continue;
			referenced[index] = anchorIndices.has(index)
				? original[index]
				: segments[index];
		}
		savedCharacters = segments.reduce(
			(saved, segment, index) =>
				saved + segment.content.length - referenced[index].content.length,
			0,
		);
	}
	// Small histories cost less in their original representation. This compares
	// complete encodings; it never caps or selects away any source.
	if (savedCharacters <= REFERENCE_INSTRUCTION.length + 2)
		return labels === "all" ? original : segments;
	return [
		{
			id: "history-encoding",
			label: "system",
			content: REFERENCE_INSTRUCTION,
			stable: false,
		},
		...referenced,
	];
}

/** Reuse exact dialogue references in direct-text planning/restoration. All
 * source bytes stay in the original context; other segments remain untouched. */
export function referenceRepeatedHistory(
	original: ContextObject,
	segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
	if (original.metadata?.historyReferenceEncoding !== true) return segments;
	const sourceIds = new Map(
		collectCompletionContextSources(original).map(({ id, event }) => [
			event.id,
			id,
		]),
	);
	const history = segments.filter(
		(segment) =>
			(segment.label === "prior_message:user" ||
				segment.label === "prior_message:agent") &&
			segment.id !== undefined &&
			sourceIds.has(segment.id),
	);
	const encoded = labelHistorySources(history, sourceIds, "referenced");
	const instruction = encoded.find(
		(segment) => segment.id === "history-encoding",
	);
	if (
		!instruction ||
		encoded.reduce((size, segment) => size + segment.content.length, 0) >=
			history.reduce((size, segment) => size + segment.content.length, 0)
	)
		return segments;
	const replacements = new Map(
		encoded
			.filter((segment) => segment !== instruction)
			.map((segment) => [segment.id, segment]),
	);
	let inserted = false;
	return segments.flatMap((segment) => {
		const replacement = replacements.get(segment.id);
		if (
			!replacement ||
			(segment.label !== "prior_message:user" &&
				segment.label !== "prior_message:agent")
		)
			return [segment];
		if (inserted) return [replacement];
		inserted = true;
		return [instruction, replacement];
	});
}
