/**
 * FACTS provider: injects the durable and current facts the agent knows about
 * the speaker and the room into the prompt context. Pulls complete readable
 * candidate pools from the `facts` memory table (one room-scoped, one per
 * related entity in the speaker's identity cluster), partitions them into
 * durable (identity-level, never decays) and current (time-decayed) kinds,
 * then ranks each kind locally with BM25 keyword scoring weighted by a
 * per-kind confidence × recency prior. Rendering attributes facts by
 * provenance — only sender-cluster facts appear under the "about the speaker"
 * header; room-pool facts about other participants render under a neutral
 * room header, so relay/webhook turns keep room recall without the room's
 * facts being misattributed to the bridge sender.
 * Ranking only changes order; every readable active fact is retained, with no
 * embedding call or top-k cutoff. The optional Stage-1 discovery view keeps
 * complete sender preferences, identity and categorized corrections inline;
 * other facts remain available as a complete freshly authorized context read.
 * Other consumers and raw provider recordings retain the complete text.
 */
import { ElizaError } from "../../../errors.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { getRelatedEntityIds } from "../../../identity-clusters.ts";
import type {
	FactKind,
	FactMetadata,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { isActiveMemoryEvidence } from "../../../utils/extraction-evidence.ts";
import {
	buildFactQueryText,
	scoreFactKeywordRelevance,
} from "../fact-keywords.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FACTS");

/**
 * Decay constant for `current` facts in the read-path ranking.
 *
 * Score = `confidence × exp(-ageDays / 14)` so a fact is at full weight on
 * day zero, ~50% at 14 days, and ~14% at 30 days. There is no hard cutoff —
 * very old current facts can still surface when relevance is high enough.
 * Durable facts skip decay entirely (`timeWeight = 1`).
 */
const CURRENT_DECAY_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Older room observations receive a separate heading so the model does not
 * mistake them for current events. Their complete text stays available;
 * age changes the label, not the amount of context sent to the model.
 */
const ROOM_CURRENT_LAPSE_MS = CURRENT_DECAY_DAYS * MS_PER_DAY;

const DEFAULT_FACT_CONFIDENCE = 0.6;

/** Cap on in-turn evidence text folded into the retrieval query. */
const PRIVATE_FACT_PRIVACY_CLASSES = new Set([
	"private",
	"sensitive",
	"restricted",
	"owner_only",
	"owner-only",
]);
const PRIVATE_FACT_TEXT_PATTERN =
	/\b(?:confidential|sensitive|private|do not share|don't share|wants? (?:this|these|it|them) kept private|keep (?:this|these|it|them) private|kept private)\b/i;
const AVAILABILITY_REQUEST_PATTERN =
	/\b(?:availability|available|free|busy|calendar|schedule|meeting|call|book)\b/i;
const THIRD_PARTY_SCHEDULE_REFERENCE_PATTERN =
	/\b(?:your boss|boss'?s?|their schedule|his schedule|her schedule|around (?:their|his|her) schedule|someone else's calendar)\b/i;
const THIRD_PARTY_SELF_IDENTIFICATION_PATTERN =
	/\b(?:this is|it is|it's)\s+[^.!?\n]{1,80}\bfrom\b/i;
const THIRD_PARTY_NAMED_AVAILABILITY_PATTERN =
	/\b(?:(?:when\s+(?:is|can|could|would|will|does)|is|can|could|would|will|does)\s+(?!i\b|me\b|my\b|we\b|us\b|you\b|your\b|the\b|a\b|an\b)[a-z][a-z0-9'_-]{1,30}(?:\s+[a-z][a-z0-9'_-]{1,30}){0,2}\s+(?:free|available|busy|meet|join|take|do|have|book)|(?:availability|schedule|calendar)\s+for\s+(?!me\b|my\b|you\b|your\b)[a-z][a-z0-9'_-]{1,30}(?:\s+[a-z][a-z0-9'_-]{1,30}){0,2})\b/i;

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function readFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_FACT_CONFIDENCE;
	}
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Resolve a fact's kind. Legacy facts written before the two-store model
 * carry no `kind` metadata; treat them as durable so existing identity-level
 * memories remain recallable.
 */
function readFactKind(memory: Memory): FactKind {
	const kind = readFactMetadata(memory).kind;
	if (kind === "current") return "current";
	return "durable";
}

/**
 * Resolve the timestamp used for time-weighting and the `since` label on
 * current facts. Prefers `metadata.validAt` (when state began) and falls
 * back to `createdAt` so legacy facts and current facts that omit
 * `valid_at` still rank consistently.
 */
function isRenderableTimestamp(value: number): boolean {
	// Match packages/core/src/utils/time-format.ts: construct the Date first and
	// require a finite getTime(). `Number.isFinite` alone admits values outside
	// the ±8.64e15 Date range — a microsecond-precision timestamp from a
	// connector, say — which then throws `RangeError: Invalid time value` from
	// `toISOString()` and takes the whole provider down with it.
	return Number.isFinite(new Date(value).getTime());
}

function readEffectiveTimestampMs(memory: Memory): number | null {
	const validAt = readFactMetadata(memory).validAt;
	if (typeof validAt === "string") {
		const parsed = Date.parse(validAt);
		if (isRenderableTimestamp(parsed)) return parsed;
	}
	if (
		typeof memory.createdAt === "number" &&
		isRenderableTimestamp(memory.createdAt)
	) {
		return memory.createdAt;
	}
	return null;
}

/**
 * Per-kind time weight applied during ranking.
 *   - durable → 1 always (identity-level claims do not decay)
 *   - current → exp(-ageDays / 14) (curved decay, never zero)
 */
function timeWeight(kind: FactKind, ageMs: number): number {
	if (kind === "durable") return 1;
	const safeAgeMs = ageMs < 0 ? 0 : ageMs;
	const ageDays = safeAgeMs / MS_PER_DAY;
	return Math.exp(-ageDays / CURRENT_DECAY_DAYS);
}

function scoreFactPrior(memory: Memory, kind: FactKind, nowMs: number): number {
	const ts = readEffectiveTimestampMs(memory);
	const ageMs = ts === null ? 0 : Math.max(0, nowMs - ts);
	return readFactConfidence(memory) * timeWeight(kind, ageMs);
}

function rankByKeywordScore(
	memories: Memory[],
	kind: FactKind,
	queryText: string,
	nowMs: number,
): Memory[] {
	return scoreFactKeywordRelevance(queryText, memories)
		.map((entry) => ({
			memory: entry.memory,
			score: entry.relevance * scoreFactPrior(entry.memory, kind, nowMs),
			prior: scoreFactPrior(entry.memory, kind, nowMs),
		}))
		.sort((left, right) => right.score - left.score || right.prior - left.prior)
		.map((entry) => entry.memory);
}

function dedupeById(memories: Memory[]): Memory[] {
	const seen = new Set<string>();
	const out: Memory[] = [];
	for (const memory of memories) {
		const id = memory.id ?? "";
		if (!id) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(memory);
	}
	return out;
}

/**
 * Partition a candidate pool into durable vs current. Legacy facts (no
 * `kind` field) are treated as durable.
 */
function partitionByKind(memories: Memory[]): {
	durable: Memory[];
	current: Memory[];
} {
	const durable: Memory[] = [];
	const current: Memory[] = [];
	for (const memory of memories) {
		if (readFactKind(memory) === "current") current.push(memory);
		else durable.push(memory);
	}
	return { durable, current };
}

/**
 * Render the date for a current fact's `since` label. Uses the effective
 * timestamp (validAt → createdAt) and emits an ISO date string
 * (`YYYY-MM-DD`); falls back to `unknown` if neither is available.
 */
function formatSince(memory: Memory): string {
	const ts = readEffectiveTimestampMs(memory);
	if (ts === null) return "unknown";
	return new Date(ts).toISOString().slice(0, 10);
}

function readCategory(memory: Memory): string {
	const category = readFactMetadata(memory).category;
	if (typeof category === "string" && category.length > 0) return category;
	return "uncategorized";
}

function readStringMetadata(memory: Memory, key: string): string | null {
	const metadata = readFactMetadata(memory) as Record<string, unknown>;
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isMarkedPrivateFact(memory: Memory): boolean {
	const privacyClass =
		readStringMetadata(memory, "privacyClass") ??
		readStringMetadata(memory, "privacy_class") ??
		readStringMetadata(memory, "visibility") ??
		readStringMetadata(memory, "scope");
	if (
		privacyClass &&
		PRIVATE_FACT_PRIVACY_CLASSES.has(privacyClass.trim().toLowerCase())
	) {
		return true;
	}
	const text = memory.content.text ?? "";
	return PRIVATE_FACT_TEXT_PATTERN.test(text);
}

function shouldMinimizePrivateFactsForTurn(message: Memory): boolean {
	const text = message.content.text ?? "";
	return (
		AVAILABILITY_REQUEST_PATTERN.test(text) &&
		(THIRD_PARTY_SCHEDULE_REFERENCE_PATTERN.test(text) ||
			THIRD_PARTY_SELF_IDENTIFICATION_PATTERN.test(text) ||
			THIRD_PARTY_NAMED_AVAILABILITY_PATTERN.test(text))
	);
}

function isPreferenceFact(memory: Memory): boolean {
	return readCategory(memory) === "preference";
}

function byPrior(memories: Memory[], kind: FactKind, nowMs: number): Memory[] {
	return [...memories].sort(
		(left, right) =>
			scoreFactPrior(right, kind, nowMs) - scoreFactPrior(left, kind, nowMs),
	);
}

function mergeAlwaysIncludedFacts(
	alwaysIncluded: Memory[],
	ranked: Memory[],
): Memory[] {
	return dedupeById([...alwaysIncluded, ...ranked]);
}

/**
 * Textual evidence the agent already possesses THIS turn, beyond the message
 * text itself: attachment/link-preview text and descriptions on the current
 * message, and the textual results of actions that already ran (present on
 * the composed state's actionResults when the provider re-runs after a
 * planner tool — e.g. an ATTACHMENT page read). Folded into the retrieval
 * query so in-turn-acquired content contributes query tokens within the same
 * turn. The complete evidence string participates in retrieval.
 */
function collectTurnEvidenceText(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): string {
	const parts: string[] = [];
	for (const attachment of message.content.attachments ?? []) {
		if (typeof attachment.title === "string") parts.push(attachment.title);
		if (typeof attachment.description === "string") {
			parts.push(attachment.description);
		}
		if (typeof attachment.text === "string") parts.push(attachment.text);
	}
	const pushResultText = (result: unknown): void => {
		if (!result || typeof result !== "object") return;
		const record = result as Record<string, unknown>;
		if (typeof record.text === "string") parts.push(record.text);
		if (typeof record.userFacingText === "string") {
			parts.push(record.userFacingText);
		}
		const data = record.data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const content = (data as Record<string, unknown>).content;
			if (typeof content === "string") parts.push(content);
		}
	};
	const actionResults = state?.data?.actionResults;
	if (Array.isArray(actionResults)) {
		for (const result of actionResults) pushResultText(result);
	}
	// The composed state a provider receives is the runtime's cached turn
	// state, which does not always carry actionResults (callers enrich a COPY
	// via withActionResultsForPrompt). The per-turn scratch entry is the
	// durable in-memory record of what already ran this turn — an in-process
	// Map read, never a DB call.
	if (
		typeof runtime.getActionResults === "function" &&
		typeof message.id === "string" &&
		message.id
	) {
		try {
			for (const result of runtime.getActionResults(message.id)) {
				pushResultText(result);
			}
		} catch (error) {
			// error-policy:J7 the scratch-state read is a diagnostics-grade
			// enrichment; losing it degrades recall for one turn but must not
			// fail the provider. Reported rather than swallowed so a
			// consistently broken accessor surfaces instead of looking like a
			// turn that simply had no prior action results.
			runtime.reportError?.("FactsProvider.turnEvidence", error, {
				messageId: message.id,
			});
		}
	}
	const joined = parts.filter((part) => part.trim().length > 0).join("\n");
	return joined;
}

function formatDurableLine(memory: Memory): string {
	const text = memory.content.text ?? "";
	if (!text) return "";
	const confidence = readFactConfidence(memory).toFixed(2);
	const category = readCategory(memory);
	return `[durable.${category} conf=${confidence}] ${text}`;
}

function formatCurrentLine(memory: Memory): string {
	const text = memory.content.text ?? "";
	if (!text) return "";
	const confidence = readFactConfidence(memory).toFixed(2);
	const category = readCategory(memory);
	const since = formatSince(memory);
	return `[current.${category} since ${since} conf=${confidence}] ${text}`;
}

function formatLines(memories: Memory[], kind: FactKind): string {
	const lines: string[] = [];
	for (const memory of memories) {
		const line =
			kind === "durable"
				? formatDurableLine(memory)
				: formatCurrentLine(memory);
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

/**
 * Function to get key facts that the agent knows about the speaker.
 * Splits retrieval into room/entity candidate pools, performs local BM25
 * keyword scoring over fact text + extracted keywords, and ranks each kind
 * with its own time-weighting curve.
 */
const factsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		try {
			const recentMessagesPromise = runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
			});
			const relatedEntityIdsPromise = getRelatedEntityIds(
				runtime,
				message.entityId,
			);
			const [recentMessages, relatedEntityIds] = await Promise.all([
				recentMessagesPromise,
				relatedEntityIdsPromise,
			]);

			// Build the lexical query from the current message and complete retained
			// conversation context. Ranking affects order only; every readable fact is
			// still rendered below.
			const conversationText = recentMessages
				.map((recentMessage) => recentMessage.content.text ?? "")
				.join("\n");
			// In-turn evidence: attachment/link-preview text on the current message
			// and textual results of actions that already ran this turn. Folding it
			// into the query means content the agent just read (an ATTACHMENT page
			// read whose text says "ZCash infra") contributes retrieval tokens
			// WITHIN the same turn instead of being invisible to fact recall.
			const evidenceText = collectTurnEvidenceText(runtime, message, state);
			const queryText = buildFactQueryText(
				message.content.text ?? "",
				conversationText,
				evidenceText,
			);

			// Two parallel candidate fetches, one room-scoped and one entity-scoped,
			// both over the `facts` table. We intentionally use `getMemories`
			// instead of vector search: relevance is computed locally from extracted
			// fact keywords and the fact's own words.
			//
			// The room pool is fetched for every sender, automated or human: relay
			// webhooks and bridge bots carry real human conversation, so dropping
			// the room pool for them would zero out fact recall on exactly those
			// turns. Misattribution is prevented at render time instead — facts
			// are attributed by provenance, so room facts about other participants
			// never render under the sender's header.
			const [roomFacts, ...entityFactPools] = await Promise.all([
				runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					worldId: message.worldId,
					unique: false,
				}),
				// `entityId` is only the RLS principal; the author filter is what
				// scopes the pool to this identity's own facts. Live 2026-09-05 on a
				// database without RLS policies, the principal-only query returned
				// the entire facts table (127 rows from every Discord channel) for
				// each cluster member, and all of it rendered on every turn.
				...relatedEntityIds.map((entityId) =>
					runtime.getMemories({
						tableName: "facts",
						entityId,
						authorEntityIds: [entityId],
						// The owner entity is shared across this owner's agents; the
						// pool must be this agent's own facts.
						agentId: runtime.agentId,
						unique: false,
					}),
				),
			]);
			const entityFacts = entityFactPools.flat();

			const minimizePrivateFacts = shouldMinimizePrivateFactsForTurn(message);
			const dedupedPool = dedupeById([...roomFacts, ...entityFacts]).filter(
				(memory) =>
					isActiveMemoryEvidence(memory) &&
					(!minimizePrivateFacts || !isMarkedPrivateFact(memory)),
			);
			const { durable: durableCandidates, current: currentCandidates } =
				partitionByKind(dedupedPool);

			const nowMs = Date.now();
			const senderEntityIds = new Set<string>(relatedEntityIds);
			const isAboutSender = (memory: Memory): boolean =>
				typeof memory.entityId === "string" &&
				senderEntityIds.has(memory.entityId);
			let durableFacts = rankByKeywordScore(
				durableCandidates,
				"durable",
				queryText,
				nowMs,
			);
			const preferenceLane = byPrior(
				durableCandidates.filter(
					(memory) => isAboutSender(memory) && isPreferenceFact(memory),
				),
				"durable",
				nowMs,
			);
			durableFacts = mergeAlwaysIncludedFacts(preferenceLane, durableFacts);
			const currentFacts = rankByKeywordScore(
				currentCandidates,
				"current",
				queryText,
				nowMs,
			);
			const allFacts = [...durableFacts, ...currentFacts];

			if (allFacts.length === 0) {
				return {
					values: { facts: "" },
					data: {
						facts: allFacts,
						durableFacts,
						currentFacts,
					},
					text: "No facts available.",
				};
			}

			const agentName = runtime.character.name ?? "Agent";
			const senderName =
				(typeof message.content.senderName === "string" &&
					message.content.senderName) ||
				(typeof message.content.name === "string" && message.content.name) ||
				"the speaker";

			// Attribute by provenance: only facts stored against the sender's
			// identity cluster are "about the speaker". The room pool also carries
			// facts about OTHER participants — rendering those under the speaker
			// header told the model that facts about other people described
			// whoever happened to send the current message (worst on relay/webhook
			// turns, where every room fact got attributed to the bridge bot).
			const preferenceLaneIds = new Set(
				preferenceLane.map((memory) => memory.id),
			);
			const senderPreferences = durableFacts.filter((memory) =>
				preferenceLaneIds.has(memory.id),
			);
			const senderDurable = durableFacts.filter(
				(memory) => isAboutSender(memory) && !preferenceLaneIds.has(memory.id),
			);
			const roomDurable = durableFacts.filter((m) => !isAboutSender(m));
			const senderCurrent = currentFacts.filter(isAboutSender);
			const roomCurrentAll = currentFacts.filter((m) => !isAboutSender(m));
			const isLapsedRoomCurrent = (memory: Memory): boolean => {
				const ts = readEffectiveTimestampMs(memory);
				return ts !== null && nowMs - ts > ROOM_CURRENT_LAPSE_MS;
			};
			const roomCurrent = roomCurrentAll.filter((m) => !isLapsedRoomCurrent(m));
			const roomCurrentLapsed = roomCurrentAll.filter(isLapsedRoomCurrent);

			const sections: string[] = [];
			if (senderPreferences.length > 0) {
				sections.push(
					`Standing preferences ${senderName} has expressed (apply any that are relevant to this reply):\n${formatLines(senderPreferences, "durable")}`,
				);
			}
			if (senderDurable.length > 0) {
				const durableHeader = `Things ${agentName} knows about ${senderName}:`;
				sections.push(
					`${durableHeader}\n${formatLines(senderDurable, "durable")}`,
				);
			}
			if (senderCurrent.length > 0) {
				const currentHeader = `What's currently happening for ${senderName}:`;
				sections.push(
					`${currentHeader}\n${formatLines(senderCurrent, "current")}`,
				);
			}
			if (roomDurable.length > 0) {
				sections.push(
					`Known facts in this room (about other participants):\n${formatLines(roomDurable, "durable")}`,
				);
			}
			if (roomCurrent.length > 0) {
				sections.push(
					`What's currently happening in this room:\n${formatLines(roomCurrent, "current")}`,
				);
			}
			if (roomCurrentLapsed.length > 0) {
				sections.push(
					`Older observations about other participants (do not assume these are still current):\n${formatLines(roomCurrentLapsed, "current")}`,
				);
			}

			const text = sections.join("\n\n");
			// Keep standing preferences, identity and explicit corrections inline.
			// Other complete facts are read on demand by the existing response
			// handler, before a personal claim; no stored record is removed.
			const standingFacts = allFacts.filter(
				(memory) =>
					isAboutSender(memory) &&
					["preference", "identity", "qa-correction", "correction"].includes(
						readCategory(memory),
					),
			);
			const categories = [...new Set(allFacts.map(readCategory))].sort();
			const discoveryText = [
				`context_discovery: FACTS\n${allFacts.length} saved facts are available in full (${categories.join(", ")}). For remembered details absent from supplied dialogue, return contextRequests=["FACTS"] with an empty reply before choosing a broader memory search. The runtime supplies the complete facts and asks you again. Search history afterward only if facts cannot answer or exact source records are required. Stored observations are not proof of current app state. Supplied dialogue/corrections may already answer; ordinary conversation needs no fact read.`,
				standingFacts.length
					? `Standing preferences, identity and corrections (complete):\n${standingFacts.map((fact) => formatLines([fact], readFactKind(fact))).join("\n")}`
					: "",
			]
				.filter(Boolean)
				.join("\n\n");
			const formattedFacts = [
				formatLines(durableFacts, "durable"),
				formatLines(currentFacts, "current"),
			]
				.filter((part) => part.length > 0)
				.join("\n");

			return {
				values: { facts: formattedFacts },
				data: {
					facts: allFacts,
					durableFacts,
					currentFacts,
				},
				text,
				discoveryText,
			};
		} catch (cause) {
			// error-policy:J2 Add provider scope before the message boundary reports the failed turn.
			throw new ElizaError("Facts provider read failed", {
				code: "FACTS_PROVIDER_READ_FAILED",
				cause,
				context: {
					agentId: runtime.agentId,
					entityId: message.entityId,
					roomId: message.roomId,
				},
				severity: "ephemeral",
			});
		}
	},
};

export { factsProvider };
