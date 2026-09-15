/**
 * Built-in `ResponseHandlerFieldEvaluator`s — the canonical core fields the
 * Stage-1 response handler extracts from every turn.
 *
 * The model-facing schema is a flat list of typed fields. Each field is an
 * independent registered evaluator with:
 *
 *   - description: verbatim in the system prompt
 *   - schema:      JSON schema slice (parameter descriptions also visible
 *                  to the LLM in strict mode)
 *   - parse:       validate / normalize the LLM's value
 *   - handle:      optional pipeline step (most core fields don't have one
 *                  — the parsed value flows through to downstream consumers)
 *
 * Per the contract:
 *   - Flat: no `plan.*` wrapper
 *   - All required: empty array / empty string for N/A
 *   - `simple` is a context name, not a flag (contexts: ["simple"])
 *   - `STOP` remains a first-class terminal response for explicit stop requests
 *   - No `thought` / `requiresTool` / `contextSlices` / `parentActionHints`
 *     (derivable, redundant, or prompt theater)
 *   - New `intents` field for short verb phrases (routing-friendly)
 *
 * Register via `runtime.registerResponseHandlerFieldEvaluator(...)`. The
 * canonical set is exported as `BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS`
 * for runtime init to consume.
 */

import { SHOULD_RESPOND_SCHEMA_DESCRIPTION } from "../actions/to-tool";
import type {
	CompletionContextSelection,
	ReplyEffectStatus,
} from "../types/components";
import type { JSONSchema } from "../types/model";
import {
	COMPLETION_CONTEXT_SCHEMA,
	parseCompletionContextSelection,
} from "./completion-context";
import { stripJsonStructuralJunkReply } from "./json-output";
import type { ResponseHandlerFieldEvaluator } from "./response-handler-field-evaluator";

/**
 * Stage-1 envelope `emotion` enum value set — kept in lock-step with
 * `EXPRESSIVE_EMOTION_ENUM` exported from
 * `/plugin-local-inference/services/voice/expressive-tags.ts`.
 *
 * It is **redeclared here** instead of imported because `@elizaos/core` may not
 * depend on `@elizaos/plugin-local-inference` (dependency direction is inward
 * per AGENTS.md "10 Clean Architecture Commandments" §1). A vitest in the
 * plugin verifies the two arrays stay byte-equal; if you change one, update
 * the other.
 */
const EXPRESSIVE_EMOTION_ENUM_VALUES = [
	"none",
	"happy",
	"sad",
	"angry",
	"nervous",
	"calm",
	"excited",
	"whisper",
] as const;
type ExpressiveEmotionEnumValue =
	(typeof EXPRESSIVE_EMOTION_ENUM_VALUES)[number];

function isExpressiveEmotionEnumValue(
	value: string,
): value is ExpressiveEmotionEnumValue {
	return (EXPRESSIVE_EMOTION_ENUM_VALUES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// shouldRespond — priority 5 (always first)
// ---------------------------------------------------------------------------

export const shouldRespondFieldEvaluator: ResponseHandlerFieldEvaluator<
	"RESPOND" | "IGNORE" | "STOP"
> = {
	name: "shouldRespond",
	description:
		"RESPOND when the current message addresses you, assigns you work, clearly continues a question you asked, or needs a concrete correction or action specifically from you. A question broadcast to a group is not by itself a reason to interrupt; apply the ambient-turn policy when present. IGNORE acknowledgements, reactions, side chatter, feeds, and messages directed to other people. STOP only explicit stop/terminate/no more work. DM usually RESPOND unless explicit stop.",
	descriptionCompressed:
		"RESPOND when the current message addresses you, assigns work, continues your question, or specifically needs your correction/action; otherwise apply ambient policy and IGNORE reactions, feeds, or others' conversation; STOP only explicit stop.",
	priority: 5,
	schema: {
		type: "string",
		enum: ["RESPOND", "IGNORE", "STOP"],
		description: SHOULD_RESPOND_SCHEMA_DESCRIPTION,
	},
	parse(value) {
		const normalized =
			typeof value === "string" ? value.trim().toUpperCase() : "";
		if (
			normalized === "RESPOND" ||
			normalized === "IGNORE" ||
			normalized === "STOP"
		) {
			return normalized;
		}
		// Defensive default: when malformed, prefer staying engaged (IGNORE bias
		// is dangerous — a missed reply is worse than an unnecessary one).
		return "RESPOND";
	},
};

// ---------------------------------------------------------------------------
// contexts — priority 10. Includes "simple" for direct-reply mode.
// ---------------------------------------------------------------------------

export const contextsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "contexts",
	description:
		'Routing tags from available_contexts; RESPOND requires at least one. Use ["simple"] for a complete reply from supplied context with no pending runtime work. Opening a known view requires navigation only. Inspecting visible controls, displayed contents or current app values requires their read/inspection action: a route/section label alone is not those contents. Owner goal/habit/routine/todo/reminder record work routes to tasks/OWNER_* actions; discussion or supplied-history recall does not request a live record operation.',
	descriptionCompressed:
		'Ids from available_contexts. ["simple"]=complete supplied-context reply, no pending work; opening a view needs navigation only, inspecting contents/current values needs a read; owner record operations route to tasks/OWNER_* actions, discussion and supplied-history recall do not.',
	priority: 10,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Context ids from available_contexts. 'simple'=direct reply, no planner.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// intents — priority 15. NEW field.
// ---------------------------------------------------------------------------

/** Validate ordered model hints without rewriting their text or dropping outcomes. */
export function readCompleteStringHints(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
		return null;
	}
	return [...raw];
}

export const intentsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "intents",
	description:
		'Short verb phrases covering every explicit outcome requiring runtime actions or external state in this turn. Keep navigation and data changes separate: "open notes and update a note" requires both. Opening one view still has one navigation intent, even when replyText drafts its confirmation; no action has executed yet. Use [] only for text-only conversation or answers complete from supplied context. Describe the requested work; the runtime chooses direct execution or planning.',
	descriptionCompressed:
		"One verb phrase per requested runtime action, navigation separately from edits. A held confirmation does not complete navigation: retain its intent. Empty only for text-only answers. Runtime chooses execution or planning.",
	priority: 15,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Pending runtime outcomes, including navigation even when replyText drafts its confirmation. One intent per requested operation; keep navigation separate from data changes. [] only for answers complete without execution.",
	},
	parse: readCompleteStringHints,
};

export const contextRequestsFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "contextRequests",
	description:
		'Read only deferred references whose advertised contents are needed to decide or write this response. Use exact context_discovery names, contexts=["simple"], replyText="", and no action candidates; the runtime loads complete authorized bodies and asks for a new decision. Request needed bodies together. Return [] when supplied context suffices. This field reads reference text; it does not discover or execute app actions. Follow each reference notice for its purpose and when a read is needed.',
	descriptionCompressed:
		'Request needed context_discovery names before answering; replyText="". [] if supplied evidence suffices. Context reads need no action planning.',
	priority: 14,
	schema: { type: "array", items: { type: "string" } },
	parse: (value) =>
		Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [],
};

export const completionContextFieldEvaluator: ResponseHandlerFieldEvaluator<
	CompletionContextSelection | undefined
> = {
	name: "completionContext",
	description:
		"Exact prior-dialogue selection for planning, execution and completion. Follow history_source_selection for selection modes and resolving missing dialogue. Pending live-record reads do not make dialogue selection incomplete. This is not a summary or completed-tool claim.",
	descriptionCompressed:
		"Follow history_source_selection for the FINAL CURRENT REQUEST, including missing or unresolved dialogue. With sourceSetId, retain every applicable fact, standing constraint/correction, referent and referenced pending intent; reviewed empty lists are valid. List each source once across categories; all categories are retained together. No summaries/caps. Current request/providers remain; future receipts arrive later.",
	priority: 16,
	schema: COMPLETION_CONTEXT_SCHEMA,
	parse: parseCompletionContextSelection,
};

// ---------------------------------------------------------------------------
// candidateActionNames — priority 50.
// One flat model-facing hint list; downstream retrieval can fan it back out.
// ---------------------------------------------------------------------------

export const candidateActionNamesFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "candidateActionNames",
	description:
		"UPPER_SNAKE_CASE retrieval hints for every intent executable before this reply. Prohibited, cancelled and hypothetical actions are not requested work. Cancelling an unexecuted intention needs no mutation; cancelling a stored record/job does. Keep lookups needed to resolve uncertainty. " +
		"Prefer exact available children: NOTES_CREATE creates sticky notes; NOTES_LIST reads/searches/lists them; NOTES_UPDATE edits and NOTES_DELETE deletes. Stored messages and saved facts use MEMORY_SEARCH; memory writes use MEMORY_CREATE, MEMORY_UPDATE or MEMORY_DELETE. Calendar reads use CALENDAR_NEXT_EVENT, CALENDAR_FEED or CALENDAR_SEARCH_EVENTS; writes use CALENDAR_CREATE_EVENT, CALENDAR_UPDATE_EVENT or CALENDAR_DELETE_EVENT. One known app view -> VIEWS_SHOW; other view/layout/native-device work -> VIEWS. Navigation needs no data action unless data work is also requested. Life management -> matching available OWNER_* or TRIGGER operation. Use umbrellas only for unresolved operations or unknown suitable children; further tools remain discoverable. " +
		"DISCOVER_TOOLS alone is valid only for a request solely to inspect schemas; preparatory discovery also needs the requested domain candidates. Clarification with no useful lookup or independent work uses [] and simple context; omit actions awaiting the answer. Return [] when none needed. Examples and confident unlisted hints never prove availability, execution or permission.",
	descriptionCompressed:
		"Likely UPPER_SNAKE_CASE actions needed before this reply. Notes data -> NOTES; single view -> VIEWS_SHOW when registered; other navigation/native device -> VIEWS; calendar data -> CALENDAR. Open-and-edit requires both. A clarification that needs no lookup uses [] and simple context; do not name future tools awaiting the answer. Keep independently executable current work.",
	priority: 50,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"UPPER_SNAKE_CASE retrieval hints covering all intents. Include navigation as well as data actions for open-and-edit requests.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toUpperCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// replyText — priority 20.
// Always required. Simple turns carry the whole answer; planning turns carry
// an acknowledgement or a held navigation confirmation, never an early effect claim.
// ---------------------------------------------------------------------------

const NAVIGATION_REPLY_RULE =
	"For UI navigation, name the destination. When visualContinuation.navigationOnly=true, draft a concise destination confirmation to deliver IF navigation succeeds, without progress or waiting language; the runtime holds it for the confirming receipt. Do not claim any record was read or changed. ";

const EXACT_REPLY_TEXT_RULE =
	" When quoting or previewing text requested verbatim or exactly, copy every character, including punctuation, repeated spaces and line breaks. Put explanations outside that text.";

export const replyTextFieldEvaluator: ResponseHandlerFieldEvaluator<string> = {
	name: "replyText",
	description:
		NAVIGATION_REPLY_RULE +
		'RESPOND requires a user-facing reply: simple context carries the complete answer; other tool/planner work gets a brief acknowledgment followed by the planner\'s grounded result. IGNORE uses "". No internal reasoning or capability refusal on the planning path. Let available tools attempt the work; only when none can attempt it, use RESPOND with simple context and explain the limitation.' +
		EXACT_REPLY_TEXT_RULE,
	descriptionCompressed:
		"User-facing reply. simple=whole answer; navigationOnly=destination confirmation held for successful navigation; other planning=brief ack, never a refusal; IGNORE=empty string.",
	priority: 20,
	schema: {
		type: "string",
		description:
			"User-facing reply. Simple=whole answer. navigationOnly=concise destination confirmation held until navigation succeeds, without progress language or record-read/change claims. Other planning=brief ack. Never refuse on planning path. Plain text unless channel supports markdown." +
			EXACT_REPLY_TEXT_RULE,
	},
	parse(value) {
		if (typeof value !== "string") return "";
		return stripJsonStructuralJunkReply(value);
	},
};

// ---------------------------------------------------------------------------
// replyEffectStatus — priority 25.
// Semantic safety signal for indirect, vague, or non-English completion text.
// ---------------------------------------------------------------------------

/** Normalize the same effect contract in field-registry and fallback parsing. */
export function normalizeReplyEffectStatus(value: unknown): ReplyEffectStatus {
	const normalized =
		typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "applied" ||
		normalized === "non_applied" ||
		normalized === "pending"
		? normalized
		: "none";
}

export const replyEffectStatusFieldEvaluator: ResponseHandlerFieldEvaluator<ReplyEffectStatus> =
	{
		name: "replyEffectStatus",
		description:
			'Classify replyText\'s current-request work claims in any language, including indirect wording ("on the books", "quedó listo"). pending=work still to perform this turn, including live lookup/navigation even alongside an answered recall question. applied=claimed newly completed external change (save/send/schedule/payment/booking/device action/delegation), never execution proof. non_applied=terminal failure, unavailable, cancelled, declined, or an action preview/clarification/conditional offer awaiting a later user answer. A proposed save awaiting separate confirmation is non_applied, not none or pending; if other work remains to perform this turn, use pending. none=answer/explanation/general question with no current action decision; recalling advice, quoting past actions or reporting existing facts alone is none. A new saved reminder is applied; recall plus promised navigation is pending.',
		descriptionCompressed:
			"Current-request work status in replyText: pending work (including lookup/navigation), claimed new applied change, terminal non_applied outcome, or none. Recall of earlier advice/actions alone is none; wording and language do not determine routing.",
		priority: 25,
		schema: {
			type: "string",
			enum: ["none", "applied", "non_applied", "pending"],
			description:
				"Classify current-request work: pending=unfinished work to perform this turn, including lookup/navigation beside an answer; applied=claimed newly completed external change, not execution proof; non_applied=terminal failed/unavailable/cancelled/declined outcome or an action preview/clarification/conditional offer awaiting a later user answer. A save awaiting separate confirmation is non_applied; other work still to perform this turn is pending. none=answer, explanation or general question without a current action decision. Recalling earlier advice, past actions or existing facts alone is none.",
		},
		parse: normalizeReplyEffectStatus,
	};

// ---------------------------------------------------------------------------
// facts — priority 80. Memory pipeline.
// ---------------------------------------------------------------------------

export const factsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "facts",
	description:
		'Extract only durable assertions newly stated by the user in the FINAL CURRENT MESSAGE. Never copy facts from history, providers or your answer to a recall question. "What color was Rowan\'s mug?" states no fact; "Rowan\'s mug is blue now; what was it before?" states the new blue correction. Keep fictional facts explicitly fictional. Skip transient state/mood and facts owned by explicit memory mutations, including deletions. Return [] when no independent new assertion remains.',
	descriptionCompressed:
		"Only durable assertions newly stated in the final current user message; no recalled answers, transient state or facts owned by explicit memory mutations. Keep fictional framing. Otherwise [].",
	priority: 80,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"New durable assertions in the final user message only, not answers recalled from context. One plain-English fact per item; [] for recall-only questions.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized || normalized.length < 4) continue;
			if (result.includes(normalized)) continue;
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// relationships — priority 85. Memory pipeline.
// ---------------------------------------------------------------------------

interface RelationshipTriple {
	subject: string;
	predicate: string;
	object: string;
}

const relationshipsSchema: JSONSchema = {
	type: "array",
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			subject: {
				type: "string",
				description:
					"Relationship subject: user name, entity name, 'user', or 'agent'.",
			},
			predicate: {
				type: "string",
				description:
					"Relation type. Lowercase verb phrase: works_with, is_friend_of, owns, lives_in.",
			},
			object: {
				type: "string",
				description: "The related entity or value.",
			},
		},
		required: ["subject", "predicate", "object"],
	},
	description:
		"Semantic relationships between entities. Empty array if none stated.",
};

export const relationshipsFieldEvaluator: ResponseHandlerFieldEvaluator<
	RelationshipTriple[]
> = {
	name: "relationships",
	description:
		'Subject-predicate-object triples user stated. Example {"subject":"alice","predicate":"works_with","object":"bob"}. Drives relationship graph. Empty if none.',
	descriptionCompressed:
		"Stated subject-predicate-object triples; empty if none.",
	priority: 85,
	schema: relationshipsSchema,
	parse(value) {
		if (!Array.isArray(value)) return [];
		const result: RelationshipTriple[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") continue;
			const r = item as Record<string, unknown>;
			const subject = typeof r.subject === "string" ? r.subject.trim() : "";
			const predicate =
				typeof r.predicate === "string" ? r.predicate.trim() : "";
			const object = typeof r.object === "string" ? r.object.trim() : "";
			if (!subject || !predicate || !object) continue;
			result.push({ subject, predicate, object });
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// topics — priority 88. Per-channel topic LRU (extract pipeline).
//
// Emits 1-5 SHORT topic labels for THIS message. Normalized: lowercase,
// trimmed, deduped, empties/overlong dropped, capped at 5. Recorded into
// `ChannelTopicsService` per-room after Stage-1 parse and surfaced back into
// routing via the `CHANNEL_TOPICS` provider so shouldRespond/the planner can
// weigh topic relevance.
// ---------------------------------------------------------------------------

/**
 * Normalize a raw list of topic candidates into lowercase, deduplicated labels.
 * Shared by the field evaluator and the message-handler parse path so both
 * apply identical rules without silently dropping model-produced context.
 */
export function normalizeTopics(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		const normalized = String(item ?? "")
			.trim()
			.toLowerCase()
			.replace(/\s+/g, " ");
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

export const topicsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "topics",
	description:
		'1-5 SHORT topic labels for this message (lowercase nouns/noun-phrases): ["billing", "auth bug", "vacation plans"]. NOT verbs/sentences. Tracks what this channel is about over time. Empty when no salient topic.',
	descriptionCompressed:
		"1-5 short lowercase topic labels; empty when no salient topic.",
	priority: 88,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Short topic labels. Lowercase. Nouns/noun-phrases, not verbs.",
	},
	parse(value) {
		return normalizeTopics(value);
	},
};

// ---------------------------------------------------------------------------
// addressedTo — priority 90. Memory pipeline.
// ---------------------------------------------------------------------------

export const addressedToFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "addressedTo",
	description:
		"Entity UUIDs or participant names addressed by this message. Drives addressed-to graph. Empty when broadcast/unsure.",
	descriptionCompressed:
		"Entity UUIDs/names this message addresses; empty when broadcast/unsure.",
	priority: 90,
	schema: {
		type: "array",
		items: { type: "string" },
		description: "Addressee entity UUIDs preferred; display names ok.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// emotion — priority 95. Text-side emotion enum (Stage-1).
//
// Per R3-emotion §2 (Option A): reuse the eliza-1 LM with the existing
// structured-decode singleton-fill path to emit a single emotion label for
// the user's text. Zero additional binary, zero additional download —
// shares the inline-tag vocabulary with the assistant-side
// `expressiveTagPromptClause()`. The value rides on `Content.emotion`
// (`Content` already permits dynamic fields) and the voice-side acoustic
// emotion rides on `MessageMetadata.voice.emotion`. Downstream fusion
// happens in `attributeVoiceEmotion()` so consumers don't reinvent it.
// ---------------------------------------------------------------------------

export const emotionFieldEvaluator: ResponseHandlerFieldEvaluator<ExpressiveEmotionEnumValue> =
	{
		name: "emotion",
		description:
			"User expressed emotion this turn. Single tag: none/happy/sad/angry/nervous/calm/excited/whisper. Default none; use none when ambiguous/no strong cue. Read text + transcript metadata only; do NOT use prior turns. User-side read; assistant emotion uses inline [happy]/[sad]/[excited] tags in replyText when TTS supports.",
		descriptionCompressed:
			"User emotion tag this turn; none when ambiguous/no strong cue.",
		priority: 95,
		schema: {
			type: "string",
			enum: [...EXPRESSIVE_EMOTION_ENUM_VALUES],
			description:
				'User emotion. "none"=no strong cue/default. Other values map to omnivoice expressive tags.',
		},
		parse(value) {
			const normalized =
				typeof value === "string" ? value.trim().toLowerCase() : "";
			if (normalized && isExpressiveEmotionEnumValue(normalized)) {
				return normalized;
			}
			// Defensive default: emit "none" on malformed input — same as the
			// "no strong cue" path. Never throw; the field is advisory.
			return "none";
		},
	};

// ---------------------------------------------------------------------------
// Canonical set — registered at runtime init
// ---------------------------------------------------------------------------

/**
 * Canonical core field evaluators. Registered automatically by the runtime
 * during init (before any plugin registration), so plugin-contributed
 * evaluators see them as siblings.
 */
export const BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS: ReadonlyArray<ResponseHandlerFieldEvaluator> =
	[
		shouldRespondFieldEvaluator,
		contextsFieldEvaluator,
		contextRequestsFieldEvaluator,
		intentsFieldEvaluator,
		completionContextFieldEvaluator,
		replyTextFieldEvaluator,
		replyEffectStatusFieldEvaluator,
		candidateActionNamesFieldEvaluator,
		factsFieldEvaluator,
		relationshipsFieldEvaluator,
		topicsFieldEvaluator,
		addressedToFieldEvaluator,
		emotionFieldEvaluator,
	];
