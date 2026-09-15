/** Resolves direct-reply and delegation intent after Stage 1 without suppressing explicit actionable requests. */

import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";
import {
	PROGRESS_ONLY_ANSWER_REJECT,
	PROGRESS_ONLY_REPLY_OPENERS_PATTERN,
} from "../../runtime/planner-loop";
import { looksLikeRawFieldTranscript } from "../../runtime/response-field-transcript";
import type { ResponseHandlerResult } from "../../runtime/response-handler-field-evaluator";
import type { Action, MessageHandlerResult } from "../../types/components";
import { canonicalPlannerControlActionName } from "./action-identifiers.js";
import {
	looksLikeCodingWorkRequest,
	looksLikeExplicitDelegationRequest,
	looksLikeInlineCodeSnippetRequest,
} from "./coding-request.js";
import {
	type DirectCurrentRequestCandidateInference,
	findCodingDelegationActionName,
	findShellDirectActionName,
	findWebLookupActionNames,
	inferDirectCurrentRequestCandidateActions as inferDirectCurrentRequestCandidateActionsFromHeuristics,
	inferDirectCurrentRequestCandidateInference as inferDirectCurrentRequestCandidateInferenceFromHeuristics,
	isShellDirectActionName,
	LEGACY_CODING_DELEGATION_ACTION_NAMES,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
	normalizeActionIdentifier,
} from "./direct-action-heuristics";
import { stripReasoningBlocks } from "./fallback-reply";

export const PLANNING_ACK_REPLIES = new Set([
	"looking into it.",
	"on it.",
	"running shell commands to gather disk usage...",
	"spawning the sub-agent now.",
	"working on it.",
]);

// Built from the vocabulary single-sourced in planner-loop.ts (which cannot
// import from this module) so the two progress-reply classifiers — this one
// and the exhaustion-path PROGRESS_ONLY_ANSWER_REJECT — cannot drift apart
// when a new progress verb is added. Case-insensitivity comes from the caller
// lowercasing, not a flag, preserving the original matching exactly.
export const PROGRESS_ONLY_REPLY_REGEX = new RegExp(
	`^(?:${PROGRESS_ONLY_REPLY_OPENERS_PATTERN})\\b`,
);

export function looksLikeProgressOnlyReply(replyText: string): boolean {
	const normalized = replyText.trim().toLowerCase();
	if (!normalized) return false;
	if (PLANNING_ACK_REPLIES.has(normalized)) return true;
	return PROGRESS_ONLY_REPLY_REGEX.test(normalized);
}

export function looksLikeCompleteDirectReply(replyText: string): boolean {
	const normalized = replyText.trim();
	if (normalized.length < 24) return false;
	if (looksLikeProgressOnlyReply(normalized)) return false;
	return (
		/[.!?。！？]$/u.test(normalized) || normalized.split(/\s+/u).length >= 8
	);
}

export function _isSimpleMessageHandlerShortcut(
	messageHandler: MessageHandlerResult,
): boolean {
	if (messageHandler.processMessage !== "RESPOND") return false;
	if (messageHandler.plan.requiresTool === true) return false;
	const contexts = messageHandler.plan.contexts ?? [];
	const nonSimpleContexts = contexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	return (
		nonSimpleContexts.length === 0 &&
		(messageHandler.plan.candidateActions?.length ?? 0) === 0
	);
}

// Prefer a complete, substantive direct reply over force-planned action when
// the model already answered the turn. Purely STRUCTURAL — it never scans the
// user's text to classify intent:
//   1. the reply reads as a finished answer, not an ack/progress/refusal/empty
//      fragment (looksLikeCompleteDirectReply), and
//   2. the only signals pushing toward planning are weak/injectable ones — a
//      simple/general context plus search/shell/spawn-class candidate actions,
//      the exact shapes the Stage-1 inference backstop force-injects
//      (hasOnlyWeakDirectReplyPlanningSignals).
// When the model defers to a tool it acks ("On it.") or returns an empty/refusal
// reply, which fails (1) — so genuine web/shell/build turns still plan, while a
// finished answer (e.g. a one-sentence policy explanation) wins directly even if
// a coding-keyword heuristic would have force-injected a spawn over it.
export function shouldPreferCompleteDirectReply(args: {
	replyText: string;
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	if (!looksLikeCompleteDirectReply(args.replyText)) return false;
	return hasOnlyWeakDirectReplyPlanningSignals(args);
}

// True when the MODEL itself named a runnable coding-delegation / spawn-class
// action in its own candidate list. Resolves by registry tags
// (CODING_DELEGATION_ACTION_TAGS) first, then the legacy name set — the same
// resolution findCodingDelegationActionName uses — so a registered
// TASKS_SPAWN_AGENT (or simile) counts and a bogus/unexposed name does not. Used
// to detect that the model committed to delegation on purpose, so a verbose ack
// is not mistaken for a finished direct reply.
/** Normalized names that hand a turn to a coding sub-agent: the registered
 *  delegation action plus the legacy aliases. Bare "TASKS" is the one alias
 *  that is ambiguous (task-list management as readily as delegation); callers
 *  that need an unambiguous commitment drop it. */
export function delegationCandidateNames(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	opts?: { requireUnambiguous?: boolean },
): Set<string> {
	const delegationActionName = findCodingDelegationActionName(actions);
	if (!delegationActionName) return new Set();
	const legacyNames = opts?.requireUnambiguous
		? LEGACY_CODING_DELEGATION_ACTION_NAMES.filter((name) => name !== "TASKS")
		: LEGACY_CODING_DELEGATION_ACTION_NAMES;
	return new Set<string>([
		normalizeActionIdentifier(delegationActionName),
		...legacyNames.map(normalizeActionIdentifier),
	]);
}

export function modelProvidedRunnableDelegationCandidate(
	candidateActions: readonly string[],
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	opts?: { requireUnambiguous?: boolean },
): boolean {
	if (candidateActions.length === 0) return false;
	const wanted = delegationCandidateNames(actions, opts);
	if (wanted.size === 0) return false;
	return candidateActions.some((name) =>
		wanted.has(normalizeActionIdentifier(name)),
	);
}

export function shouldPreferInlineCodeSnippetDirectReply(args: {
	currentMessageText: string;
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	if (looksLikeExplicitDelegationRequest(args.currentMessageText)) return false;
	if (!looksLikeInlineCodeSnippetRequest(args.currentMessageText)) return false;
	return hasOnlyWeakDirectReplyPlanningSignals(args);
}

export const WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS = new Set(
	[
		"BROWSER",
		"EXEC",
		"EXECUTE_COMMAND",
		"INTERNET_SEARCH",
		"LOOKUP_WEB",
		"REPLY",
		"RUN_COMMAND",
		"RUN_IN_TERMINAL",
		"RUN_SHELL",
		"SEARCH",
		"SEARCH_INTERNET",
		"SEARCH_WEB",
		"SHELL",
		"SPAWN_AGENT",
		"SPAWN_CODING_AGENT",
		"START_CODING_TASK",
		"TASKS",
		"TASKS_SPAWN_AGENT",
		"TERMINAL",
		"TERMINAL_SHELL",
		"WEB_FETCH",
		"WEB_SEARCH",
	].map(normalizeActionIdentifier),
);

export function shouldPreferDirectCurrentCandidateActions(args: {
	candidateActions: readonly string[];
	currentMessageText: string;
	directCandidateActions: readonly string[];
	// Optional live action registry. When supplied, shell-direct membership is
	// resolved through the declared SHELL_DIRECT_ACTION_TAGS contract (with the
	// legacy name set as a covered fallback) instead of a hardcoded literal set;
	// when omitted (e.g. pure unit call sites), the legacy name membership still
	// applies so behavior is unchanged for owner actions that predate the tags.
	actions?: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
}): boolean {
	if (args.candidateActions.length === 0) return false;
	if (!looksLikeLocalShellRequest(args.currentMessageText)) return false;
	if (looksLikeCodingWorkRequest(args.currentMessageText)) return false;
	if (
		!args.directCandidateActions.some((name) =>
			isShellDirectActionName(name, args.actions),
		)
	) {
		return false;
	}
	return args.candidateActions.every((name) => {
		const normalized = normalizeActionIdentifier(name);
		return (
			WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS.has(normalized) ||
			canonicalPlannerControlActionName(normalized) !== null ||
			// A shell-direct action resolved through the declared tag contract counts
			// as a weak/overridable signal too — same class as the shell names
			// enumerated in WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS — so an owner that
			// renamed its shell action but kept SHELL_DIRECT_ACTION_TAGS still
			// promotes the direct shell turn instead of falling through to planning.
			isShellDirectActionName(normalized, args.actions)
		);
	});
}

export function hasOnlyWeakDirectReplyPlanningSignals(args: {
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	for (const context of args.contexts) {
		const normalized = context.trim().toLowerCase();
		if (
			normalized &&
			normalized !== SIMPLE_CONTEXT_ID &&
			normalized !== "general"
		) {
			return false;
		}
	}
	for (const actionName of args.candidateActions) {
		const normalized = normalizeActionIdentifier(actionName);
		if (!normalized) continue;
		if (!WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS.has(normalized)) return false;
	}
	return true;
}

export function hasAckOnlyActionableIntent(
	result: ResponseHandlerResult,
	replyText: string,
	fallbackText = "",
): boolean {
	if (!looksLikeProgressOnlyReply(replyText)) {
		return false;
	}
	const intentText = Array.isArray(result.intents)
		? result.intents
				.map((intent) => (typeof intent === "string" ? intent : ""))
				.join("\n")
		: "";
	const actionText = [intentText, fallbackText].filter(Boolean).join("\n");
	return (
		looksLikeLocalShellRequest(actionText) ||
		looksLikeWebSearchRequest(actionText) ||
		looksLikeCodingWorkRequest(actionText)
	);
}

export function inferAckIntentCandidateActions(
	result: ResponseHandlerResult,
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	fallbackText = "",
): string[] {
	const intentText = Array.isArray(result.intents)
		? result.intents
				.map((intent) => (typeof intent === "string" ? intent : ""))
				.join("\n")
		: "";
	const actionText = [intentText, fallbackText].filter(Boolean).join("\n");
	if (!actionText.trim()) return [];
	if (looksLikeLocalShellRequest(actionText)) {
		const shellAction = findShellDirectActionName(actions);
		if (shellAction) return [shellAction];
	}
	// Coding-work precedes web-search: "build an app that shows the bitcoin price"
	// trips looksLikeWebSearchRequest (market term) yet is a coding task — route it
	// to coding delegation, not a web lookup. Mirrors the coding-first guard in
	// shouldPreferDirectCurrentCandidateActions.
	if (looksLikeCodingWorkRequest(actionText)) {
		const codingAction = findCodingDelegationActionName(actions);
		if (codingAction) return [codingAction];
	}
	if (looksLikeWebSearchRequest(actionText)) {
		const lookupActions = findWebLookupActionNames(actions);
		if (lookupActions.length > 0) return lookupActions;
	}
	return [];
}

export function inferDirectCurrentRequestCandidateActions(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): string[] {
	return inferDirectCurrentRequestCandidateActionsFromHeuristics(
		actions,
		messageText,
		{
			// Coding-work precedes web-search: a coding request mentioning a live/market
			// term ("build a crypto price tracker") must route to coding delegation,
			// not a web lookup.
			looksLikeCodingWorkRequest,
			findCodingDelegationActionName,
		},
	);
}

export function inferDirectCurrentRequestCandidateInference(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): DirectCurrentRequestCandidateInference {
	return inferDirectCurrentRequestCandidateInferenceFromHeuristics(
		actions,
		messageText,
		{
			looksLikeCodingWorkRequest,
			findCodingDelegationActionName,
		},
	);
}

/**
 * Keep terminal non-applied replies out of metadata-inferred planning. Other
 * answered simple turns may suppress inferred view or owner matches with the
 * model's explicit no-effect classification and no declared intent; legacy
 * incomplete envelopes remain conservative. Model-selected actions and
 * pending/applied effects keep their normal planning and verification paths.
 */
export function shouldSuppressInferredCandidateEscalation(args: {
	inference: DirectCurrentRequestCandidateInference;
	stageOneContexts: readonly string[];
	stageOneReplyText: string;
	stageOneCandidateActions: readonly string[];
	stageOneReplyEffectStatus: MessageHandlerResult["plan"]["replyEffectStatus"];
	stageOneIntents: readonly string[];
}): boolean {
	if (
		args.stageOneReplyEffectStatus !== "non_applied" &&
		args.inference.kind !== "view-capability" &&
		!(
			(args.inference.kind === "view-surface" ||
				args.inference.kind === "owner-goals" ||
				args.inference.kind === "owner-scheduled-admin") &&
			args.stageOneReplyEffectStatus === "none" &&
			args.stageOneIntents.length === 0
		)
	) {
		return false;
	}
	if (args.stageOneCandidateActions.length > 0) return false;
	if (args.stageOneReplyText.trim().length === 0) return false;
	// An ack-shaped reply ("On it.", "Let me pull that up.") is a delegation
	// commitment, not an answer — suppressing the candidate here would ship the
	// ack as the whole turn with nothing behind it (the ack-rescue paths only
	// cover shell/web/coding, never views). Only a genuinely answer-shaped
	// replyText qualifies the turn as "already answered".
	if (looksLikeProgressOnlyReply(args.stageOneReplyText)) return false;
	return !args.stageOneContexts.some(
		(context) => context.trim().toLowerCase() !== SIMPLE_CONTEXT_ID,
	);
}

/**
 * Per-turn required-tool miss-budget cap for the view-SURFACE flavor of the
 * waste `shouldSuppressInferredCandidateEscalation` suppresses outright for
 * view-capability overlaps. A view-surface inference on an already-answered
 * simple turn (live: "whats the best way to close a window in vim" — WINDOW
 * is a surface noun) must still escalate — a genuine "open the settings
 * window" ask needs the tool — but when the planner then keeps ANSWERING
 * instead of calling the view tool, every rejected answer burns a full
 * planner round and the exhaustion rescue ships the stage-1 answer anyway
 * (observed live: 18.5s, four rejected answers, right answer). Capping the
 * budget to 0 fires that rescue after ONE rejected answer.
 *
 * Two-sided gate keeps genuine view work on the full corrective budget: this
 * side requires the answer shape by the exhaustion path's own
 * PROGRESS_ONLY_ANSWER_REJECT superset (an ack such as "Opening the settings
 * panel." never qualifies), and the planner loop independently ignores the
 * cap unless the stage-1 text passes its answer-shape gate (see
 * PlannerLoopParams.requiredToolMissBudgetOverride). Shell / web / coding
 * inferences and bare-noun view navigation (#9950) never reach here — the
 * kind check excludes them.
 */
export function viewOverlapRequiredToolMissBudget(args: {
	inference: DirectCurrentRequestCandidateInference;
	stageOneContexts: readonly string[];
	stageOneReplyText: string;
	stageOneCandidateActions: readonly string[];
}): number | undefined {
	if (args.inference.kind !== "view-surface") return undefined;
	if (args.stageOneCandidateActions.length > 0) return undefined;
	const replyText = args.stageOneReplyText.trim();
	if (replyText.length === 0) return undefined;
	if (PROGRESS_ONLY_ANSWER_REJECT.test(replyText)) return undefined;
	if (
		args.stageOneContexts.some(
			(context) => context.trim().toLowerCase() !== SIMPLE_CONTEXT_ID,
		)
	) {
		return undefined;
	}
	return 0;
}

export function uniqueActionNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		const normalized = normalizeActionIdentifier(name);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(name);
	}
	return result;
}

/**
 * Probe for an embedded JSON object inside otherwise plain text. Used by the
 * tolerant simple-reply synthesizer to fall through to the structured-
 * failure path when a weak planner leaked tool-arg-shaped content into prose
 * (e.g. `{"path":"...","contents":"..."}`) instead of into the canonical
 * tool-call envelope. Shipping such a fragment verbatim would surface raw
 * JSON to the user; routing to the failure path produces a clean apology.
 */
export function containsEmbeddedJsonObject(text: unknown): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < withoutThink.length; i++) {
		const ch = withoutThink[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				const candidate = withoutThink.slice(start, i + 1);
				try {
					const parsed = JSON.parse(candidate);
					if (parsed && typeof parsed === "object") return true;
				} catch {
					// error-policy:J3 Each candidate is untrusted model text;
					// malformed candidates are invalid while scanning continues.
				}
				start = -1;
			}
			if (depth < 0) {
				depth = 0;
				start = -1;
			}
		}
	}
	return false;
}

/**
 * Tolerant fallback for planners that return plain text instead of the
 * structured Stage 1 envelope. Without this, the runtime throws
 * `v5 messageHandler returned invalid MessageHandlerResult` whenever the
 * model — small instruct-tuned weights routinely served via OpenAI-
 * compatible providers — skips the HANDLE_RESPONSE scaffold and just emits
 * prose. Treating the prose as a simple reply keeps the turn alive.
 *
 * Returns null only when:
 *  - the text is empty (genuine failure, propagate)
 *  - the text looks like incomplete structured output (a stray `{` or `[`
 *    that didn't JSON.parse — model intended tool output and failed
 *    mid-stream; shipping that fragment surfaces broken JSON to the user)
 *  - the text contains an embedded JSON object inside prose (the model
 *    leaked tool-arg shapes into the reply; route to failure path so the
 *    leak doesn't reach the user channel)
 */
export function synthesizeSimpleReplyFromPlainText(
	raw: string | undefined | null,
): MessageHandlerResult | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const replyText = stripReasoningBlocks(trimmed);
	if (!replyText) return null;
	const looksLikeIncompleteStructuredOutput =
		(replyText.startsWith("{") || replyText.startsWith("[")) &&
		(() => {
			try {
				JSON.parse(replyText);
				return false;
			} catch {
				// error-policy:J3 untrusted-input parse probe — a parse failure IS the
				// signal (text looks like incomplete structured output, not valid JSON).
				return true;
			}
		})();
	if (looksLikeIncompleteStructuredOutput) return null;
	if (containsEmbeddedJsonObject(replyText)) return null;
	// Never treat a raw HANDLE_RESPONSE field transcript as a plain-text reply
	// (#11712). If the structured-transcript parser upstream didn't claim it,
	// route to the failure path rather than shipping the `shouldRespond:/
	// replyText:/...` skeleton to the user channel.
	if (looksLikeRawFieldTranscript(replyText)) return null;
	return {
		processMessage: "RESPOND",
		thought:
			"Tolerant fallback: model returned plain text instead of the structured plan; treating as simple reply.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: replyText,
			simple: true,
		},
	};
}
