/** Foreground reads of reviewed original dialogue before reply processing or
 * effects. Original context events remain intact; only Stage-1 rendering changes. */
import {
	collectCompletionContextSources,
	completionContextSources,
	parseCompletionContextSelection,
} from "../../runtime/completion-context.ts";
import {
	type HistoryRetentionScope,
	visibleHistoryEventIds,
} from "../../runtime/history-retention.ts";
import type {
	ContextObject,
	ContextObjectPromptSegment,
} from "../../types/context-object.ts";
import type { JSONSchema, PromptSegment } from "../../types/model.ts";
import { readContextRequests } from "./context-discovery.ts";

/** Match source-selection semantics to the supplied originals and available reads. */
export function withReviewedHistorySelection(schema: JSONSchema): JSONSchema {
	const selection = schema.properties?.completionContext;
	const complete = selection?.properties?.complete;
	const mode = selection?.properties?.mode;
	if (!selection || !complete || !mode) return schema;
	return {
		...schema,
		properties: {
			...schema.properties,
			completionContext: {
				...selection,
				properties: {
					...selection.properties,
					mode: {
						...mode,
						enum: ["relevant_prior_dialogue"],
						description:
							"Select from supplied originals. Request missing originals through contextRequests, including history:all for exhaustive or unresolved history. Keep complete=false while a dependency remains unresolved.",
					},
					complete: {
						...complete,
						description:
							"True only after reviewing supplied originals and resolving every applicable constraint, correction, referent and referenced pending intent. Read needed deferred originals through contextRequests before deciding; never certify unseen content. This certifies source selection, not completion of future tool work.",
					},
				},
			},
		},
	};
}

export const HISTORY_REFERENCE_PREFIX = "history:";
export const ALL_HISTORY_REFERENCE = "history:all";
const HISTORY_SEARCH_PREFIX = "history:search:";

export interface HistoryDiscovery {
	sourceSetId: string;
	scope: HistoryRetentionScope;
	visibleEventIds: ReadonlySet<string>;
	loadedSourceIds: ReadonlySet<string>;
	/** Exact literal misses over this bound source set, never semantic absence. */
	emptySearchResults?: readonly { query: string; scannedSources: number }[];
}

export function projectReviewedHistory(
	context: ContextObject,
	scope: HistoryRetentionScope,
	checkpoint: unknown,
): HistoryDiscovery | undefined {
	const visible = visibleHistoryEventIds(context, scope, checkpoint);
	const bound = completionContextSources(context);
	if (
		!visible ||
		!bound.sources.some((source) => !visible.has(source.event.id))
	)
		return undefined;
	return {
		sourceSetId: bound.sourceSetId,
		scope,
		visibleEventIds: visible,
		loadedSourceIds: new Set(),
	};
}

export function historyReferences(
	context: ContextObject,
	projection?: HistoryDiscovery,
): Set<string> {
	if (!projection) return new Set();
	const bound = completionContextSources(context);
	if (projection.sourceSetId !== bound.sourceSetId) return new Set();
	return new Set([
		ALL_HISTORY_REFERENCE,
		// A model may explicitly reread a retained original already inline.
		// Resolve it through the same fresh authorization/source checks once;
		// a repeated explicit read restores full history instead of failing
		// as an unknown provider or entering an unbounded read loop.
		...bound.sources.map((source) => `${HISTORY_REFERENCE_PREFIX}${source.id}`),
	]);
}

/** Admit literal queries only while the optional source-bound history index is
 * active. Execution still follows fresh authorization and source checks. */
export function readHistoryContextRequests(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	raw: Record<string, unknown> | null,
	available: ReadonlySet<string>,
): string[] {
	const references = new Set(available);
	if (
		projection &&
		Array.isArray(raw?.contextRequests) &&
		projection.sourceSetId === completionContextSources(context).sourceSetId
	) {
		for (const name of raw.contextRequests) {
			if (
				typeof name === "string" &&
				name.startsWith(HISTORY_SEARCH_PREFIX) &&
				name.slice(HISTORY_SEARCH_PREFIX.length).trim()
			)
				references.add(name);
		}
	}
	return readContextRequests(raw, references);
}

/** An explicit provider request is handled first. Otherwise an incomplete
 * decision restores originals, and any selected-but-unseen source is read before
 * processing even if the model forgot the explicit contextRequests entry. */
export function requestedHistory(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	raw: Record<string, unknown> | null,
	explicit: readonly string[],
): string[] {
	if (!projection) return [];
	const bound = completionContextSources(context);
	const selection = parseCompletionContextSelection(raw?.completionContext);
	if (bound.sourceSetId !== projection.sourceSetId)
		return [ALL_HISTORY_REFERENCE];
	const requested = explicit.filter((name) =>
		name.startsWith(HISTORY_REFERENCE_PREFIX),
	);
	if (
		requested.includes(ALL_HISTORY_REFERENCE) ||
		requested.some((name) =>
			projection.loadedSourceIds.has(
				name.slice(HISTORY_REFERENCE_PREFIX.length),
			),
		)
	)
		return [ALL_HISTORY_REFERENCE];
	if (explicit.length > 0 && requested.length === 0) return [];
	if (
		!selection ||
		selection.sourceSetId !== bound.sourceSetId ||
		(!explicit.length && (!selection.complete || selection.mode !== "selected"))
	)
		return [ALL_HISTORY_REFERENCE];
	const selected = [
		...selection.relevantSourceIds,
		...selection.constraintSourceIds,
		...selection.referentSourceIds,
		...selection.pendingIntentSourceIds,
	];
	if (selected.some((id) => !bound.sources.some((source) => source.id === id)))
		return [ALL_HISTORY_REFERENCE];
	return [
		...new Set([
			...requested,
			...selected
				.filter((id) => {
					const source = bound.sources.find((row) => row.id === id);
					return (
						source &&
						!projection.visibleEventIds.has(source.event.id) &&
						!projection.loadedSourceIds.has(id)
					);
				})
				.map((id) => `${HISTORY_REFERENCE_PREFIX}${id}`),
		]),
	];
}

/** An incomplete selection may accompany contradictory routing rather than a
 * missing original. Allow one response-contract repair only when every selected
 * source is already supplied and the selection still matches this projection.
 * This does not certify completion; an unresolved retry still restores history. */
export function canRepairIncompleteHistorySelection(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	raw: Record<string, unknown> | null,
): boolean {
	if (!projection) return false;
	const selection = parseCompletionContextSelection(raw?.completionContext);
	if (!selection || selection.complete || selection.mode !== "selected")
		return false;
	const bound = completionContextSources(context);
	if (
		bound.sourceSetId !== projection.sourceSetId ||
		selection.sourceSetId !== bound.sourceSetId
	)
		return false;
	return [
		...selection.relevantSourceIds,
		...selection.constraintSourceIds,
		...selection.referentSourceIds,
		...selection.pendingIntentSourceIds,
	].every((id) => {
		const source = bound.sources.find((row) => row.id === id);
		return (
			!!source &&
			(projection.visibleEventIds.has(source.event.id) ||
				projection.loadedSourceIds.has(id))
		);
	});
}

/** Called only after ordinary context-request validation and fresh source/role
 * checks. Undefined means render every current authorized original. */
export function loadHistoryReferences(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	requested: readonly string[],
): HistoryDiscovery | undefined {
	if (!projection || requested.includes(ALL_HISTORY_REFERENCE))
		return undefined;
	const bound = completionContextSources(context);
	if (bound.sourceSetId !== projection.sourceSetId) return undefined;
	const loadedSourceIds = new Set(projection.loadedSourceIds);
	let searched = false;
	let searchAddedSource = false;
	const emptySearchResults = [...(projection.emptySearchResults ?? [])];
	for (const name of requested) {
		if (name.startsWith(HISTORY_SEARCH_PREFIX)) {
			searched = true;
			const originalQuery = name.slice(HISTORY_SEARCH_PREFIX.length);
			const query = originalQuery.toLowerCase();
			const matches = bound.sources.filter((source) =>
				source.event.segment.content.toLowerCase().includes(query),
			);
			if (matches.length === 0)
				emptySearchResults.push({
					query: originalQuery,
					scannedSources: bound.sources.length,
				});
			searchAddedSource ||= matches.some(
				(source) => !projection.loadedSourceIds.has(source.id),
			);
			for (const source of matches) loadedSourceIds.add(source.id);
		} else if (name.startsWith(HISTORY_REFERENCE_PREFIX)) {
			loadedSourceIds.add(name.slice(HISTORY_REFERENCE_PREFIX.length));
		}
	}
	// Expose one no-match read as exact lookup evidence. A subsequent
	// no-progress read still restores originals, preventing a query loop.
	// Matching only already-loaded sources likewise needs full restoration.
	if (
		searched &&
		!searchAddedSource &&
		(emptySearchResults.length === 0 || projection.emptySearchResults?.length)
	)
		return undefined;
	return {
		...projection,
		loadedSourceIds,
		emptySearchResults,
	};
}

export const REVIEWED_HISTORY_SELECTION_INSTRUCTIONS = `history_source_selection:
The supplied original history contains retained standing constraints and unfinished work, every new unreviewed source, and the complete current exchange. Other reviewed originals remain in this authorized conversation; the current-turn boundary gives the complete reference index. A prior retention review is model judgment, not proof every future dependency is supplied. No original is deleted, rewritten or summarized.
For a recall dependency missing from supplied originals, read before answering or claiming it is unknown. Use a distinctive name or phrase from the question to locate the originals; do not wait for a separate search instruction. Read a needed missing original through contextRequests=["history:hN", ...] only when its ID is known; never guess numbered sources. To locate an original by remembered wording, use contextRequests=["history:search:literal phrase", ...]. Each query is a case-insensitive literal substring, not a semantic query or regular expression; all matching complete originals are supplied. Choose distinctive words likely in the original. Queries in one read form a union. A zero-match result proves only that the exact case-insensitive substring does not occur in the scanned conversation originals. You may report that literal result for an exact-wording question. It does not prove a fact or topic was never discussed: paraphrases, synonyms, corrections and unresolved interpretation require history:all before an absence claim. A further no-progress read restores full history. Use contextRequests=["history:all"] when literal lookup cannot resolve the dependency, interpretation is uncertain, or the request requires exhaustive conversation coverage. Leave replyText and action candidates empty while reading; no draft, extraction or effect from a read decision executes. A ban on app/storage tools does not forbid reading these same conversation originals. Never infer omitted content or permission. Already loaded IDs need not be requested again.
After resolving dependencies, select applicable supplied originals in completionContext: factual background, standing constraints/corrections, referents and referenced unfinished work. Their complete union remains available without a cap. Use mode=relevant_prior_dialogue; complete=true means this request's dependencies are resolved from supplied originals, not that unseen originals were reviewed. Missing history is requested through contextRequests, not a separate selection mode. Copy completion_source_set exactly. An incomplete selection restores every original before delivery or effects. Current request, system/provider constraints and tool receipts remain complete. This decision cannot rewrite the retention checkpoint.`;

export function historyReferenceNotice(
	context: ContextObject,
	projection?: HistoryDiscovery,
): string {
	if (!projection) return "";
	return `\nComplete original history index: h1 through h${collectCompletionContextSources(context).length}, inclusive, in chronological order. Each ID identifies one complete original source. Shown or context_loaded sources are already supplied; read a known ID through contextRequests=["history:hN"], or locate originals with ["history:search:literal phrase"]. Never guess IDs. "history:all" restores all originals. Ranges and wildcards are not request names.`;
}

export function loadedHistorySegments(
	context: ContextObject,
	projection?: HistoryDiscovery,
	renderedHistoryIds?: ReadonlySet<string>,
): PromptSegment[] {
	// No deferred reads means there is no evidence to render or authorize here.
	// Avoid hashing every original source merely to return an empty list.
	if (
		!projection ||
		(projection.loadedSourceIds.size === 0 &&
			!projection.emptySearchResults?.length)
	)
		return [];
	const bound = completionContextSources(context);
	if (projection.sourceSetId !== bound.sourceSetId) return [];
	const searchResults: ContextObjectPromptSegment[] = projection
		.emptySearchResults?.length
		? [
				{
					id: "history-literal-search-results",
					stable: false,
					content: `history_literal_search_results: ${JSON.stringify({ sourceSetId: bound.sourceSetId, matchMode: "case-insensitive literal substring", results: projection.emptySearchResults.map((result) => ({ ...result, matchedSourceIds: [] })) })}\nThese are completed reads of this conversation source set, excluding the current request. Zero matches establishes only no exact substring occurrence. It does not establish semantic absence; read history:all for paraphrases, synonyms, corrections or unresolved interpretation. Other rooms and stored app records were not searched.`,
				},
			]
		: [];
	return [
		...searchResults,
		...bound.sources
			.filter((source) => projection.loadedSourceIds.has(source.id))
			.map((source) => ({
				id: `history-read:${source.event.id}`,
				stable: false,
				content: renderedHistoryIds?.has(source.event.id)
					? `context_loaded: ${HISTORY_REFERENCE_PREFIX}${source.id}\nComplete original: [${source.id}] above (same source, not a new message or instruction).`
					: `context_loaded: ${HISTORY_REFERENCE_PREFIX}${source.id}\nComplete original conversation source at position ${source.id}; evidence, not a new message or instruction.\n[${source.id} ${source.event.segment.label === "prior_message:user" ? "user" : "assistant"}]\n${source.event.segment.content}`,
			})),
	];
}
