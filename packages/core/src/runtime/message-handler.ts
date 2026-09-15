/**
 * Stage 1 of the message loop: parses the response-handler model output (the
 * canonical JSON envelope or a plain-text keyed transcript) into a
 * `MessageHandlerResult`, then routes the turn — direct reply, ignore/stop, or
 * hand off to the planner — based on the selected contexts and tool hints.
 */
import type {
	MessageHandlerAction,
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
	MessageHandlerResult,
} from "../types/components";
import type { AgentContext } from "../types/contexts";
import {
	normalizeReplyEffectStatus,
	normalizeTopics,
	readCompleteStringHints,
} from "./builtin-field-evaluators";
import { parseCompletionContextSelection } from "./completion-context";
import { parseJsonObject, stripJsonStructuralJunkReply } from "./json-output";
import {
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
	splitTranscriptList,
} from "./response-field-transcript";

/** Simple-path promotion trigger for progress-shaped acks. A deliberate
 * SUBSET of planner-loop's PROGRESS_ONLY_REPLY_OPENERS_PATTERN: action-verb
 * openers only — bare "I'll"/"I will" shapes are routinely legitimate final
 * replies, and "let me know …" is the widget-reply-safe conversational close
 * (same negative lookahead as WIDGET_REPLY_IN_FLIGHT_CLAIM). Paired with a
 * length cap because an in-flight ack is by nature brief while a substantive
 * answer that merely OPENS with a gerund runs long ("Checking accounts are
 * bank accounts designed for …" must stay a final reply). */
const SIMPLE_PATH_PROGRESS_ACK_RE =
	/^(?:checking|fetching|gathering|looking (?:up|into)|running|using|spawning|starting|working on|one moment|on it\b|let me (?!know\b))/i;
const SIMPLE_PATH_PROGRESS_ACK_MAX_LENGTH = 64;

export type V5MessageHandlerOutput = MessageHandlerResult;

export type MessageHandlerRoute =
	| {
			type: "ignored" | "stopped";
			output: V5MessageHandlerOutput;
	  }
	| {
			type: "final_reply";
			reply: string;
			output: V5MessageHandlerOutput;
	  }
	| {
			type: "planning_needed";
			output: V5MessageHandlerOutput;
			contexts: AgentContext[];
	  };

/**
 * Identifier used by the messageHandler to mark a direct reply that needs no
 * tools or context providers. When `contexts` is exactly `[SIMPLE_CONTEXT_ID]`
 * (or empty) the runtime takes the shortcut and emits `replyText` without
 * invoking the planner.
 */
export const SIMPLE_CONTEXT_ID = "simple";

/**
 * Parse a HANDLE_RESPONSE payload into the internal {@link MessageHandlerResult}.
 *
 * Expects the canonical response-handler field-registry envelope:
 * `{ shouldRespond, contexts, intents, replyText, candidateActionNames, facts,
 * relationships, addressedTo, emotion }`. The internal result carries the
 * `plan` sub-object to match the downstream runtime contract.
 */
export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		// Some providers (cli-inference / claude-sdk warm sessions in text mode)
		// echo the field set back as a plain-text keyed transcript instead of
		// JSON: `shouldRespond: RESPOND\n\nreplyText: ...`. Recover the fields
		// with the transcript grammar (multi-line values with embedded blank
		// lines terminate only at the next `^<knownField>:` line). Without this
		// the whole raw transcript falls through the tolerant plain-text path and
		// is shipped verbatim to the user channel (#11712).
		return parseMessageHandlerFieldTranscript(raw);
	}

	const processMessage = normalizeMessageHandlerAction(parsed.shouldRespond);
	const contexts = Array.isArray(parsed.contexts)
		? parsed.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const replyRaw =
		typeof parsed.replyText === "string"
			? stripJsonStructuralJunkReply(parsed.replyText)
			: undefined;
	const candidateActions = readCompleteStringHints(parsed.candidateActionNames);
	const intents = readCompleteStringHints(parsed.intents);
	if (candidateActions === null || intents === null) return null;

	const extract = parseExtract(parsed);
	const replyEffectStatus = normalizeReplyEffectStatus(
		parsed.replyEffectStatus,
	);

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply: replyRaw,
		completionContext: parseCompletionContextSelection(
			parsed.completionContext,
		),
		...(typeof parsed.replyEffectStatus === "string" &&
		parsed.replyEffectStatus.trim().toLowerCase() === replyEffectStatus
			? { replyEffectStatus }
			: {}),
	};
	if (candidateActions.length > 0) {
		normalizedPlan.candidateActions = candidateActions;
	}
	if (intents.length > 0) {
		normalizedPlan.intents = intents;
	}

	return {
		processMessage,
		plan: normalizedPlan,
		thought: "",
		...(extract ? { extract } : {}),
	};
}

/**
 * Parse the plain-text keyed field transcript into a MessageHandlerResult.
 * Mirrors the JSON path in {@link parseMessageHandlerOutput} but sources the
 * fields from {@link parseFieldTranscript}. Returns null when the text is not a
 * recognizable transcript (no known field lines) so the caller can fall through
 * to the tolerant plain-text handler.
 */
function parseMessageHandlerFieldTranscript(
	raw: string,
): V5MessageHandlerOutput | null {
	// Only claim text whose own skeleton IS the envelope: it must lead with a
	// known field line (outside any code fence) and carry a hallmark field
	// (`shouldRespond:` / `replyText:`) at the top level. Prose that merely
	// QUOTES field lines — e.g. the model diagnosing a leaked transcript the
	// user pasted — must fall through to the tolerant plain-text handler
	// INTACT; claiming it here would drop every line before the quoted
	// `replyText:` and ship only the quote's tail as the answer.
	if (!looksLikeRawFieldTranscript(raw)) return null;
	const transcript = parseFieldTranscript(raw);
	if (!transcript) return null;
	const { fields } = transcript;

	// Require at least one hallmark field before treating the text as a
	// structured transcript: the routing field (`shouldRespond:` may
	// legitimately stand alone, e.g. an IGNORE echo with no reply) or the
	// reply-bearing field (`replyText:`). A lone stray `topics:` line in
	// otherwise-prose output should NOT be reinterpreted as an envelope.
	const hasShouldRespond = typeof fields.shouldRespond === "string";
	const hasReplyText = typeof fields.replyText === "string";
	if (!hasShouldRespond && !hasReplyText) return null;

	const processMessage = normalizeMessageHandlerAction(fields.shouldRespond);
	const contexts = splitTranscriptList(fields.contexts);
	const replyRaw =
		typeof fields.replyText === "string"
			? stripJsonStructuralJunkReply(fields.replyText)
			: undefined;
	const candidateActions = splitTranscriptList(fields.candidateActionNames);
	const intents = splitTranscriptList(fields.intents);

	const extract = parseExtract({
		facts: splitTranscriptList(fields.facts),
		addressedTo: splitTranscriptList(fields.addressedTo),
		topics: splitTranscriptList(fields.topics),
	});
	const replyEffectStatus = normalizeReplyEffectStatus(
		fields.replyEffectStatus,
	);

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply: replyRaw,
		...(typeof fields.replyEffectStatus === "string" &&
		fields.replyEffectStatus.trim().toLowerCase() === replyEffectStatus
			? { replyEffectStatus }
			: {}),
	};
	if (candidateActions.length > 0) {
		normalizedPlan.candidateActions = candidateActions;
	}
	if (intents.length > 0) {
		normalizedPlan.intents = intents;
	}

	return {
		processMessage,
		plan: normalizedPlan,
		thought: "",
		...(extract ? { extract } : {}),
	};
}

function parseExtract(raw: unknown): MessageHandlerExtract | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const facts = Array.isArray(source.facts)
		? source.facts
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry): entry is string => entry.length > 0)
		: [];
	const relationships = Array.isArray(source.relationships)
		? source.relationships
				.map((entry): MessageHandlerExtractedRelationship | null => {
					if (!entry || typeof entry !== "object") return null;
					const rel = entry as Record<string, unknown>;
					const subject =
						typeof rel.subject === "string" ? rel.subject.trim() : "";
					const predicate =
						typeof rel.predicate === "string" ? rel.predicate.trim() : "";
					const object =
						typeof rel.object === "string" ? rel.object.trim() : "";
					if (!subject || !predicate || !object) return null;
					return { subject, predicate, object };
				})
				.filter(
					(entry): entry is MessageHandlerExtractedRelationship =>
						entry !== null,
				)
		: [];
	const addressedTo = Array.isArray(source.addressedTo)
		? source.addressedTo
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry): entry is string => entry.length > 0)
		: [];
	const topics = normalizeTopics(source.topics);
	if (
		facts.length === 0 &&
		relationships.length === 0 &&
		addressedTo.length === 0 &&
		topics.length === 0
	) {
		return undefined;
	}
	const result: MessageHandlerExtract = {};
	if (facts.length > 0) result.facts = facts;
	if (relationships.length > 0) result.relationships = relationships;
	if (addressedTo.length > 0) result.addressedTo = addressedTo;
	if (topics.length > 0) result.topics = topics;
	return result;
}

/** Explicit media-generation request shape: a generation verb paired with a
 * media-artifact noun within one clause. Self-contained mirror of
 * GENERATE_MEDIA's own explicit-request detector — validate() and routing
 * deliberately own their layers separately (#20174), but they must agree on
 * what an explicit ask looks like. */
const EXPLICIT_MEDIA_GENERATION_REQUEST_RE =
	/\b(?:generate|make|draw|create|render|paint|produce|design)\b[^.!?]{0,64}\b(?:image|picture|photo|art(?:work)?|illustration|logo|sticker|wallpaper|drawing|painting|meme|gif|video|animation|clip|music|song|audio|sound(?:\s?effect)?|sfx|voice(?:over)?|speech)s?\b/i;

/** Capability-denial reply shape ("can't do that here — no video tools in
 * this setup", "I don't have an image generator", "that's a private
 * surface / private info / limited to the owner"). The privacy arm exists
 * because the denial text this runtime itself ships in group channels becomes
 * room history that stage-1 then parrots VERBATIM for asks an ungated sibling
 * could serve (observed live: "remind me in 3 minutes" denied in one stage
 * with empty contexts). Kept in sync with `privacyDenialReplyForReasons`
 * (services/message.ts) — every owner-private decline it can ship must match
 * one arm here. */
const CAPABILITY_DENIAL_REPLY_RE =
	/\b(?:can'?t|cannot|unable to|no|don'?t have|lack)\b[^.!?]{0,80}\b(?:tool|generat|capabilit|action|model|service|setup|environment)|private surface|owner'?s private info|(?:limited|only available) to (?:the owner|them)|don'?t have access to that/i;

/** Reminder wording supports scheduling votes and denial recovery, not intent on its own. */
const EXPLICIT_REMINDER_REQUEST_RE =
	/\bremind me\b|\bset (?:a |an )?(?:reminder|alarm)\b/i;

/** Explicit delegated-task status ask ("is the build task done?", "status of
 * the website task", "did the build finish?") — answerable only from the
 * durable task store, never from chat impressions. */
const EXPLICIT_TASK_STATUS_REQUEST_RE =
	/\b(?:status|progress)\s+(?:of|on)\b[^.!?]{0,60}\b(?:task|build|job|agent)\b|\b(?:task|build|job)\b[^.!?]{0,40}\b(?:done|finished|complete[d]?|status|still (?:running|going))\b|\b(?:is|did)\b[^.!?]{0,40}\b(?:task|build)\b[^.!?]{0,30}\b(?:finish(?:ed)?|done|complete[d]?)\b/i;

/** Task-state claim/denial reply shape ("no task exists", "got stopped before
 * shipping", "nothing running now"). Stage-1 asserting store state it never
 * read is the history-poisoning shape again: the runtime's own denials become
 * room history the next turn parrots verbatim (observed live ×3 on one room —
 * "no task exists for …" repeated while the store held the task `validating`). */
const TASK_STATE_CLAIM_REPLY_RE =
	/\bno (?:such )?task\b|\btask (?:doesn'?t|does not) exist\b|\b(?:got|was|been) (?:stopped|aborted|cancelled)\b|\bnothing (?:is )?running\b|\bstill (?:running|working)\b|\bnot (?:finished|done|complete)\b/i;

const STOP_LEXICON =
	/\b(?:stop|quiet|shut up|enough|nvm|never ?mind|cancel that|forget it|don'?t (?:do|reply|answer|respond)|leave me|go away|pause|be quiet|hold off|stand down|mute)\b/i;

/** Whether the user's own text asks the agent to disengage (the only STOP). */
export function isStopRequestText(text: string | undefined): boolean {
	const trimmed = text?.trim() ?? "";
	return trimmed.length > 0 && STOP_LEXICON.test(trimmed);
}

export function routeMessageHandlerOutput(
	output: V5MessageHandlerOutput,
	options?: {
		addressedToOtherParticipant?: boolean;
		/** A runtime evaluator replaced the candidate set from richer evidence.
		 * Text-only fallback must not undo it; semantic sibling routing remains. */
		candidateActionsClearedByEvaluators?: boolean;
		/** The user's own message text; enables request-shape promotions the
		 * stage-1 output alone cannot justify. Optional for compatibility —
		 * absent, the request-shape promotions simply do not run. */
		messageText?: string;
	},
): MessageHandlerRoute {
	const processMessage = output.processMessage;
	if (processMessage === "IGNORE") {
		return { type: "ignored", output };
	}
	if (processMessage === "STOP") {
		// STOP means the user asked the agent to disengage. The model also
		// answered STOP to "what time is it" (empty reply) and to a calendar add
		// with a hallucinated "On pause" refusal (live 2026-09-11/12). A direct
		// request with no stop language routes on as RESPOND with its plan intact.
		const text = options?.messageText?.trim() ?? "";
		if (!text || isStopRequestText(text)) {
			return { type: "stopped", output };
		}
	}

	// Full engagement addressing gate (extends #9874 item 1): the caller has
	// positively resolved this turn as explicitly addressed to ANOTHER room
	// participant — the agent is overhearing, not being spoken to. An overheard
	// turn must not ship a reply, enter the planner, or execute tools, so every
	// RESPOND branch below terminal-routes to ignored. This supersedes the old
	// suppressToolPromotion option, which only blocked the simple→tool
	// promotion while still shipping the Stage-1 reply. Uniform, NOT
	// bot-specific: it fires identically for human and bot addressees. The
	// caller owns the bypasses (turn addresses the agent, personality
	// reply_gate "always", addressee-resolution failure fails open) — by the
	// time the flag reaches this router it is authoritative.
	if (options?.addressedToOtherParticipant) {
		return { type: "ignored", output };
	}

	const allContexts = [...output.plan.contexts];
	const requiresTool = output.plan.requiresTool === true;
	// An explicit "generate a <media>" ask is answerable ONLY by the media
	// action, yet two live failure shapes bypass it: (a) stage-1 parrots a
	// stale capability denial from room history and ships it on the simple
	// path ("no video generation tools in this setup" — false, the model is
	// registered), and (b) planning routes to an adjacent surface (a workflow
	// builder) because no candidate anchored the media action. Seeding
	// GENERATE_MEDIA as a candidate fixes both: the candidate-append pass
	// forces it onto the planner surface, and stage-1-named-tool enforcement
	// makes the planner actually CALL it instead of acking. If the action is
	// genuinely gated for this surface, the gate-rejection short-circuit
	// still answers honestly — the layers compose.
	const messageTextForRouting = options?.messageText ?? "";
	const allowTextOnlyFallback =
		options?.candidateActionsClearedByEvaluators !== true;
	const isExplicitMediaAsk =
		allowTextOnlyFallback &&
		EXPLICIT_MEDIA_GENERATION_REQUEST_RE.test(messageTextForRouting);
	// Seeding is applied ONLY on routes that enter the planner: a simple-path
	// clarify ("a picture of what exactly?") must stay a final reply, so the
	// seed never by itself converts a simple turn into planning.
	// "Remind me" also introduces ordinary recall. Do not turn an unrelated
	// navigation/read plan into scheduling solely because that phrase occurs.
	// Keep the existing owner/group sibling fallback for a scheduling vote or
	// a capability denial that needs to be checked against the real surface.
	const hasReminderPlanningVote =
		allContexts.some((context) =>
			["tasks", "todos", "automation"].includes(context),
		) ||
		(output.plan.candidateActions ?? []).some((name) =>
			/^(?:OWNER_REMINDERS|TRIGGER)(?:_|$)/u.test(
				String(name).trim().toUpperCase(),
			),
		);
	const isExplicitReminderAsk =
		EXPLICIT_REMINDER_REQUEST_RE.test(messageTextForRouting) &&
		(hasReminderPlanningVote ||
			(allowTextOnlyFallback &&
				CAPABILITY_DENIAL_REPLY_RE.test(getMessageHandlerReply(output))));
	const isExplicitTaskStatusAsk =
		allowTextOnlyFallback &&
		EXPLICIT_TASK_STATUS_REQUEST_RE.test(messageTextForRouting);
	const seedCandidate = (name: string): void => {
		if (
			(output.plan.candidateActions ?? []).some(
				(existing) => String(existing).trim().toUpperCase() === name,
			)
		) {
			return;
		}
		output.plan.candidateActions = [
			...(output.plan.candidateActions ?? []),
			name,
		];
	};
	const seedMediaCandidate = (): void => {
		if (isExplicitMediaAsk) seedCandidate("GENERATE_MEDIA");
		// Both reminder siblings ride together: the owner surface serves
		// DM/api rooms, the ungated TRIGGER serves group channels — the
		// gate-rejection stand-down downstream picks whichever this surface
		// allows.
		if (isExplicitReminderAsk) {
			seedCandidate("OWNER_REMINDERS");
			seedCandidate("TRIGGER");
		}
		// Task-status asks anchor the durable-store read so the planner answers
		// from TASKS_HISTORY rows, not from room history.
		if (isExplicitTaskStatusAsk) seedCandidate("TASKS");
	};
	const candidateActions = output.plan.candidateActions ?? [];
	const hasCandidateActions = candidateActions.length > 0;

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner — unless
	// the route explicitly says this turn needs a tool, in which case we fall
	// through to planning against `general`.
	const nonSimpleContexts = allContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);

	// Resolve the self-contradiction shape `simple=true + requiresTool=false +
	// candidateActions=[BASH/SHELL/TASKS/...]` by promoting to planning. The
	// model is signaling both "no tool needed" (simple-path) AND "this tool
	// would fulfill the request" (candidateActions hint) — those cannot both
	// be true. The candidateActions hint is the more reliable signal because
	// it names a specific exposed tool; honor it and run the planner.
	//
	// Live regression on 2026-05-25 (trajectories tj-c227b5bbff288a,
	// tj-d5e298b2542aa0): probes "find files in /etc that contain the word
	// hostname" and "what files are in /tmp right now" produced
	// `{simple=true, requiresTool=false, candidateActions=["BASH"],
	// replyText:"On it."}` — the user saw the bare-ack and nothing else
	// because the planner was never invoked. The Stage-1 prompt rule that
	// bans bare-ack on simple-path is a soft contract the model occasionally
	// violates; this structural promotion catches the violation at the
	// routing layer.
	const candidateActionsRequestPlanning =
		hasCandidateActions && output.plan.requiresTool !== false;
	// #9874's separate promotion suppression collapsed into the addressing gate
	// above: a turn addressed to another participant never reaches this branch,
	// so promotion can no longer fabricate a phantom tool task from overheard
	// talk (the false-ack seed).
	const promotionRequested =
		(requiresTool || candidateActionsRequestPlanning) &&
		nonSimpleContexts.length === 0;
	if (promotionRequested) {
		seedMediaCandidate();
		return {
			type: "planning_needed",
			output,
			contexts: isExplicitMediaAsk
				? ["media"]
				: isExplicitReminderAsk
					? ["tasks"]
					: ["general"],
		};
	}

	if (nonSimpleContexts.length === 0) {
		const reply = getMessageHandlerReply(output);
		// A capability denial on the simple path for an explicit media ask is
		// the history-poisoning shape: stage-1 repeats a stale "no video/image
		// tools" precedent from room history without consulting the runtime
		// (observed live: the same room that generated two images denied that
		// GENERATE_MEDIA exists). Route to planning against the media context —
		// if the capability is real the planner exercises it; if it is
		// genuinely absent the planner surface proves it and the honest denial
		// ships from ground truth instead of from memory.
		if (
			(isExplicitMediaAsk || isExplicitReminderAsk) &&
			CAPABILITY_DENIAL_REPLY_RE.test(reply)
		) {
			seedMediaCandidate();
			return {
				type: "planning_needed",
				output,
				contexts: isExplicitMediaAsk ? ["media"] : ["tasks"],
			};
		}
		// A task-state claim on the simple path for an explicit task-status ask
		// is the same poisoning shape with the task store as the ground truth:
		// stage-1 asserts "no task exists"/"got stopped" from its own prior
		// denials in room history without ever reading the store. Promote so
		// the planner consults TASKS — a real absence then ships from the
		// store's answer instead of from memory.
		if (isExplicitTaskStatusAsk && TASK_STATE_CLAIM_REPLY_RE.test(reply)) {
			seedMediaCandidate();
			return {
				type: "planning_needed",
				output,
				contexts: ["tasks"],
			};
		}
		// A progress-shaped reply on the pure-simple path is a self-contradiction:
		// "checking paris weather now" promises tool work, and the simple path
		// runs no tools — shipping it as the WHOLE turn is the bare-ack class
		// (nothing else ever happens). Stage 1 sometimes emits this shape with
		// NEITHER requiresTool NOR candidateActions set (live: a two-tool
		// "check the weather in paris and save a note" turn classified
		// contexts=["simple"], reply="checking paris weather now", no promotion
		// trigger fired, user got the ack and nothing else). The reply text
		// itself is the reliable signal — promote to planning exactly like the
		// candidateActions contradiction above. Narrow opener set only:
		// "got it"/"okay" style acknowledgements are legitimate final replies
		// (memory-store turns) and must not promote.
		if (
			reply.length <= SIMPLE_PATH_PROGRESS_ACK_MAX_LENGTH &&
			SIMPLE_PATH_PROGRESS_ACK_RE.test(reply)
		) {
			return {
				type: "planning_needed",
				output,
				contexts: ["general"],
			};
		}
		return {
			type: "final_reply",
			reply,
			output,
		};
	}

	// Mixed selection: drop the `simple` marker and plan against the rest.
	seedMediaCandidate();
	return {
		type: "planning_needed",
		output,
		contexts: nonSimpleContexts,
	};
}

export function getMessageHandlerReply(output: V5MessageHandlerOutput): string {
	return String(output.plan.reply ?? "").trim();
}

function normalizeMessageHandlerAction(value: unknown): MessageHandlerAction {
	const normalized = String(value ?? "")
		.trim()
		.toUpperCase();
	if (
		normalized === "RESPOND" ||
		normalized === "IGNORE" ||
		normalized === "STOP"
	) {
		return normalized;
	}
	return "RESPOND";
}
