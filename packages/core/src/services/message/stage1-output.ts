/** Normalizes native and structured message-handler output and validates candidate action decisions. */

import {
	DISCOVER_TOOLS_NAME,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import {
	normalizeReplyEffectStatus,
	normalizeTopics,
	readCompleteStringHints,
} from "../../runtime/builtin-field-evaluators";
import type { CandidateActionBackstopRule } from "../../runtime/candidate-action-backstop";
import { parseCompletionContextSelection } from "../../runtime/completion-context";
import {
	parseJsonObject,
	stripJsonStructuralJunkReply,
} from "../../runtime/json-output";
import {
	parseMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
} from "../../runtime/message-handler";
import type {
	ResponseHandlerFieldRunResult,
	ResponseHandlerResult,
} from "../../runtime/response-handler-field-evaluator";
import type { UserVisibleModelOutput } from "../../runtime/user-visible-model-output";
import type { Action, MessageHandlerResult } from "../../types/components";
import type { GenerateTextResult } from "../../types/model";
import type { IAgentRuntime } from "../../types/runtime";
import { canonicalPlannerControlActionName } from "./action-identifiers.js";
import {
	getMessageHandlerCandidateActions,
	messageHandlerStageOneReplyContexts,
} from "./action-surface.js";
import {
	looksLikeCodingWorkRequest,
	looksLikeDelegationExcludedAsk,
	looksLikeExplicitDelegationRequest,
	looksLikeInlineCodeSnippetRequest,
} from "./coding-request.js";
import {
	type DirectCurrentRequestCandidateInference,
	findCodingDelegationActionName,
	looksLikeWebSearchRequest,
	normalizeActionIdentifier,
} from "./direct-action-heuristics";
import { getV5ModelText } from "./generate-text-result";
import {
	delegationCandidateNames,
	hasAckOnlyActionableIntent,
	inferAckIntentCandidateActions,
	inferDirectCurrentRequestCandidateInference,
	modelProvidedRunnableDelegationCandidate,
	shouldPreferCompleteDirectReply,
	shouldPreferDirectCurrentCandidateActions,
	shouldPreferInlineCodeSnippetDirectReply,
	shouldSuppressInferredCandidateEscalation,
	uniqueActionNames,
	viewOverlapRequiredToolMissBudget,
} from "./stage1-reply-policy.js";
import { parseToolArguments } from "./tool-arguments.js";

export function parseMessageHandlerNativeToolCall(
	raw: GenerateTextResult,
): MessageHandlerResult | null {
	const args = extractHandleResponseToolArguments(raw);
	return args ? parseMessageHandlerOutput(JSON.stringify(args)) : null;
}

export function extractHandleResponseToolArguments(
	raw: GenerateTextResult,
): Record<string, unknown> | null {
	const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
	for (const entry of toolCalls) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		if (name !== HANDLE_RESPONSE_TOOL_NAME) {
			continue;
		}
		const args = parseToolArguments(
			entry.arguments ?? entry.args ?? entry.input ?? entry.params,
		);
		if (!args || !looksLikeMessageHandlerToolArguments(args)) {
			continue;
		}
		return args;
	}
	return null;
}

export function hasHandleResponseToolCall(raw: GenerateTextResult): boolean {
	const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
	return toolCalls.some((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return false;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		return name === HANDLE_RESPONSE_TOOL_NAME;
	});
}

export function looksLikeMessageHandlerToolArguments(
	args: Record<string, unknown>,
): boolean {
	if (Object.keys(args).length === 0) {
		return false;
	}
	return (
		args.shouldRespond !== undefined ||
		args.contexts !== undefined ||
		args.replyText !== undefined ||
		args.intents !== undefined ||
		args.candidateActionNames !== undefined ||
		args.facts !== undefined ||
		args.relationships !== undefined ||
		args.addressedTo !== undefined ||
		args.emotion !== undefined ||
		args.processMessage !== undefined ||
		args.plan !== undefined ||
		args.extract !== undefined
	);
}

export function extractMessageHandlerRawParsed(
	raw: string | GenerateTextResult,
): Record<string, unknown> | null {
	const parsed =
		typeof raw === "string"
			? parseJsonObject<Record<string, unknown>>(raw)
			: (extractHandleResponseToolArguments(raw) ??
				parseJsonObject<Record<string, unknown>>(getV5ModelText(raw)));
	return parsed && looksLikeMessageHandlerToolArguments(parsed) ? parsed : null;
}

export function normalizeRawParsedForFieldRegistry(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const normalized = { ...raw };
	const plan =
		raw.plan && typeof raw.plan === "object" && !Array.isArray(raw.plan)
			? (raw.plan as Record<string, unknown>)
			: undefined;
	const extract =
		raw.extract &&
		typeof raw.extract === "object" &&
		!Array.isArray(raw.extract)
			? (raw.extract as Record<string, unknown>)
			: undefined;
	if (normalized.shouldRespond === undefined) {
		normalized.shouldRespond =
			raw.processMessage === "IGNORE" || raw.processMessage === "STOP"
				? raw.processMessage
				: "RESPOND";
	}
	if (normalized.replyText === undefined) {
		normalized.replyText = typeof plan?.reply === "string" ? plan.reply : "";
	}
	if (
		normalized.replyEffectStatus === undefined &&
		plan?.replyEffectStatus !== undefined
	) {
		normalized.replyEffectStatus = plan.replyEffectStatus;
	}
	if (normalized.contexts === undefined) {
		normalized.contexts = Array.isArray(plan?.contexts) ? plan.contexts : [];
	}
	if (normalized.intents === undefined) {
		normalized.intents = Array.isArray(plan?.intents) ? plan.intents : [];
	}
	if (
		normalized.completionContext === undefined &&
		plan?.completionContext !== undefined
	) {
		normalized.completionContext = plan.completionContext;
	}
	if (normalized.requiresTool === undefined && plan?.requiresTool === true) {
		normalized.requiresTool = true;
	}
	if (normalized.candidateActionNames === undefined) {
		normalized.candidateActionNames = Array.isArray(plan?.candidateActions)
			? plan.candidateActions
			: [];
	}
	if (normalized.facts === undefined) {
		normalized.facts = Array.isArray(extract?.facts) ? extract.facts : [];
	}
	if (normalized.relationships === undefined) {
		normalized.relationships = Array.isArray(extract?.relationships)
			? extract.relationships
			: [];
	}
	if (normalized.addressedTo === undefined) {
		normalized.addressedTo = Array.isArray(extract?.addressedTo)
			? extract.addressedTo
			: [];
	}
	if (normalized.topics === undefined) {
		normalized.topics = Array.isArray(extract?.topics) ? extract.topics : [];
	}
	// Reject malformed scope before any plugin field can perform work.
	normalized.intents = requireCompleteIntents(normalized.intents);
	return normalized;
}

function requireCompleteIntents(value: unknown): string[] {
	const intents = readCompleteStringHints(value);
	if (intents === null) {
		throw new ElizaError(
			"HANDLE_RESPONSE intents must be an array of strings",
			{
				code: "INVALID_MESSAGE_HANDLER_INTENTS",
				context: { field: "intents" },
			},
		);
	}
	return intents;
}

/**
 * A model-named candidate action is "valid" if it matches an exposed action's
 * name OR one of its similes. Matching similes is essential: the planner often
 * names a sub-action alias (e.g. SPAWN_AGENT) of an exposed action (TASKS), and
 * a name-only check rejects it — dropping the action and shipping a bare "On
 * it." ack with no work done (live regression: "now add a footer to the tea
 * site" -> candidateActionNames:["SPAWN_AGENT"], contexts:[], reply:"On it.",
 * no spawn).
 */
export function exposedActionMatches(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	normalizedCandidate: string,
): boolean {
	return actions.some((action) => {
		if (normalizeActionIdentifier(action.name) === normalizedCandidate) {
			return true;
		}
		const similes = Array.isArray(action.similes) ? action.similes : [];
		return similes.some(
			(simile) =>
				normalizeActionIdentifier(String(simile)) === normalizedCandidate,
		);
	});
}

export function userVisibleOutputClassification(
	output: Exclude<UserVisibleModelOutput, { kind: "empty" }>,
): string {
	if (output.kind === "control") {
		return `${output.malformed ? "malformed-" : ""}${output.envelope}`;
	}
	if (output.kind === "invalid") {
		return output.reason;
	}
	return output.format === "json" ? "unexpected-json" : "unexpected-text";
}

export function reportRejectedUserVisibleModelOutput(args: {
	runtime: IAgentRuntime;
	scope: string;
	code: string;
	message: string;
	stage: string;
	output: Exclude<UserVisibleModelOutput, { kind: "empty" }>;
	context?: Record<string, unknown>;
}): void {
	args.runtime.reportError(
		args.scope,
		new ElizaError(args.message, {
			code: args.code,
			context: {
				stage: args.stage,
				classification: userVisibleOutputClassification(args.output),
				fieldPath: args.output.fieldPath,
				...args.context,
			},
			severity: "ephemeral",
		}),
	);
}

export function messageHandlerFromFieldResult(
	result: ResponseHandlerResult,
	fieldRun?: ResponseHandlerFieldRunResult,
	runtimeContext?: {
		actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
		messageText?: string;
		candidateBackstopRules?: readonly CandidateActionBackstopRule[];
		subAgentCompletionRelay?: boolean;
	},
): MessageHandlerResult {
	const rawContexts = Array.isArray(result.contexts)
		? result.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const rawCandidateActions = Array.isArray(result.candidateActionNames)
		? result.candidateActionNames
				.map((action) => String(action).trim())
				.filter(Boolean)
		: [];
	const currentMessageText = runtimeContext?.messageText ?? "";
	// A sub-agent completion relay's envelope echoes the original task text
	// ("[sub-agent: Build and deploy…]"), so every text-intent inference over
	// the CURRENT message reads a FINISHED task as fresh task intent. Disable
	// the text-derived candidate injections (coding backstop, ack-intent
	// inference, direct-current inference) on relay turns — the relay's only
	// job is to deliver the result, and forcing a tool over it rejects REPLY up
	// to the required-tool miss cap or re-spawns completed work. Structural:
	// the flag comes from the relay's own markers (metadata.subAgent / router
	// source / envelope prefix), not from classifying LLM text. The model's OWN
	// explicit routing (contexts + candidateActionNames it emitted) is
	// untouched, so genuine user task-intent turns keep the full backstop.
	const subAgentCompletionRelay =
		runtimeContext?.subAgentCompletionRelay === true;
	const candidateBackstop = subAgentCompletionRelay
		? { candidateActions: [...rawCandidateActions], forceCodeContext: false }
		: applyCodingCandidateBackstop({
				candidateActions: rawCandidateActions,
				actions: runtimeContext?.actions ?? [],
				messageText: currentMessageText,
				backstopRules: runtimeContext?.candidateBackstopRules ?? [],
			});
	const candidateActions = candidateBackstop.candidateActions;
	const contexts =
		candidateBackstop.forceCodeContext &&
		!rawContexts.some((context) => context.toLowerCase() === "code")
			? ["code", ...rawContexts]
			: rawContexts;
	const replyTextRaw = stripJsonStructuralJunkReply(
		typeof result.replyText === "string" ? result.replyText : "",
	);
	const replyEffectStatus = normalizeReplyEffectStatus(
		result.replyEffectStatus,
	);
	const declaredIntents = requireCompleteIntents(result.intents);
	const actionableIntents = declaredIntents.filter(
		(intent) => intent.trim().length > 0,
	);
	const modelRequiresTool = result.requiresTool === true;
	const hasRunnableCandidateAction = candidateActionsContainRunnableAction(
		candidateActions,
		runtimeContext,
	);
	// Discovery is registered for the planner after Stage 1. Its absence from
	// runtime.actions here is not a missing/invalid model hint and must not
	// trigger text inference that invents domain work or negated navigation.
	const hasDiscoveryCandidate = candidateActions.some(
		(name) =>
			normalizeActionIdentifier(name) ===
			normalizeActionIdentifier(DISCOVER_TOOLS_NAME),
	);
	const inferredAckCandidateActions =
		!subAgentCompletionRelay &&
		!hasDiscoveryCandidate &&
		!hasRunnableCandidateAction &&
		hasAckOnlyActionableIntent(result, replyTextRaw, currentMessageText)
			? inferAckIntentCandidateActions(
					result,
					runtimeContext?.actions ?? [],
					currentMessageText,
				)
			: [];
	const hasValidProvidedCandidate =
		runtimeContext && candidateActions.length > 0
			? candidateActions.some((name) => {
					const normalized = normalizeActionIdentifier(name);
					if (
						normalized === normalizeActionIdentifier(DISCOVER_TOOLS_NAME) ||
						canonicalPlannerControlActionName(normalized) !== null
					) {
						return true;
					}
					return exposedActionMatches(runtimeContext.actions, normalized);
				})
			: candidateActions.length > 0;
	const directCurrentInference =
		!subAgentCompletionRelay && currentMessageText.trim().length > 0
			? inferDirectCurrentRequestCandidateInference(
					runtimeContext?.actions ?? [],
					currentMessageText,
				)
			: ({ names: [], kind: null } as DirectCurrentRequestCandidateInference);
	// Text-derived hints cannot override a completed model answer
	// unless the model also declared work or an effect requiring verification.
	const directCurrentCandidateActions =
		!modelRequiresTool &&
		shouldSuppressInferredCandidateEscalation({
			inference: directCurrentInference,
			stageOneContexts: rawContexts,
			stageOneReplyText: replyTextRaw,
			stageOneCandidateActions: rawCandidateActions,
			stageOneReplyEffectStatus:
				result.replyEffectStatus === undefined ? undefined : replyEffectStatus,
			stageOneIntents: actionableIntents,
		})
			? []
			: directCurrentInference.names;
	const preferDirectCurrentCandidateActions =
		!hasDiscoveryCandidate &&
		shouldPreferDirectCurrentCandidateActions({
			candidateActions,
			currentMessageText,
			directCandidateActions: directCurrentCandidateActions,
			actions: runtimeContext?.actions,
		});
	const inferredDirectCandidateActions =
		!preferDirectCurrentCandidateActions &&
		!hasValidProvidedCandidate &&
		inferredAckCandidateActions.length === 0 &&
		directCurrentCandidateActions.length > 0
			? directCurrentCandidateActions
			: [];
	const candidateActionsBeforeSnippetGate = preferDirectCurrentCandidateActions
		? directCurrentCandidateActions
		: uniqueActionNames([
				...candidateActions,
				...inferredAckCandidateActions,
				...inferredDirectCandidateActions,
			]);
	// The planner answers a one-line snippet ask itself (inline code, or a
	// quick local FILE/SHELL); a delegation-class candidate would hand it to a
	// coding sub-agent instead. Stripped structurally, never by regex on the
	// reply (see inlineSnippetAsk below for the routing side).
	const effectiveCandidateActions =
		looksLikeInlineCodeSnippetRequest(currentMessageText) &&
		!looksLikeExplicitDelegationRequest(currentMessageText)
			? candidateActionsBeforeSnippetGate.filter(
					(name) =>
						!delegationCandidateNames(runtimeContext?.actions ?? []).has(
							normalizeActionIdentifier(name),
						),
				)
			: candidateActionsBeforeSnippetGate;
	const runnableCandidateActions = filterRunnableCandidateActions(
		effectiveCandidateActions,
		runtimeContext,
	);
	// Only runnable candidates drive planning. Preserve unresolved model hints
	// in the plan so authorized action discovery can resolve their aliases or
	// recover the complete surface; an inferred match cannot replace them.
	const validCandidateCount = runnableCandidateActions.length;
	const facts = Array.isArray(result.facts)
		? result.facts.map((fact) => String(fact).trim()).filter(Boolean)
		: [];
	const relationships = Array.isArray(result.relationships)
		? result.relationships
				.map((entry) => {
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
						return null;
					}
					const rel = entry as Record<string, unknown>;
					const subject =
						typeof rel.subject === "string" ? rel.subject.trim() : "";
					const predicate =
						typeof rel.predicate === "string" ? rel.predicate.trim() : "";
					const object =
						typeof rel.object === "string" ? rel.object.trim() : "";
					return subject && predicate && object
						? { subject, predicate, object }
						: null;
				})
				.filter(
					(
						entry,
					): entry is { subject: string; predicate: string; object: string } =>
						entry !== null,
				)
		: [];
	const addressedTo = Array.isArray(result.addressedTo)
		? result.addressedTo
				.map((addressed) => String(addressed).trim())
				.filter(Boolean)
		: [];
	const topics = normalizeTopics(result.topics);
	const preempt = fieldRun?.preempt;
	const processMessage =
		preempt?.mode === "ignore"
			? "IGNORE"
			: result.shouldRespond === "STOP"
				? "STOP"
				: result.shouldRespond === "IGNORE"
					? "IGNORE"
					: "RESPOND";
	const preemptDirect =
		preempt?.mode === "ack-and-stop" || preempt?.mode === "direct-reply";
	const routedContexts = preemptDirect
		? Array.from(new Set([...contexts, SIMPLE_CONTEXT_ID]))
		: contexts;
	const initialPlanningContexts = routedContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	const pendingDeclaredWork =
		processMessage === "RESPOND" &&
		!preemptDirect &&
		!subAgentCompletionRelay &&
		(replyEffectStatus === "pending" || modelRequiresTool);
	// A model-declared actionable outcome must not disappear just because the
	// same payload says "simple" and omits an action name. The real planner owns
	// action selection; do not infer an intent or fabricate a tool call here.
	const unservedDeclaredIntent =
		!preemptDirect &&
		!subAgentCompletionRelay &&
		actionableIntents.length > 0 &&
		initialPlanningContexts.length === 0 &&
		validCandidateCount === 0 &&
		replyEffectStatus !== "non_applied";
	const requestedPlanning =
		pendingDeclaredWork ||
		initialPlanningContexts.length > 0 ||
		validCandidateCount > 0 ||
		unservedDeclaredIntent;
	// The model can explicitly commit to delegation: for a genuine coding-work
	// request it routes to a non-simple context of its OWN choosing AND names a
	// runnable coding-delegation / spawn-class action in its OWN candidate list
	// (not the runtime backstop's inferred one). When it does, a verbose
	// sentence-shaped ack ("On it — spawning a coding agent to build the page.")
	// is still an ACK, not a finished answer — so the complete-direct-reply
	// override must NOT pull it back to the simple path. Without this guard,
	// planner-models that write fuller acks (e.g. the OAuth Claude bridge) trip
	// looksLikeCompleteDirectReply and the sub-agent never spawns, while terse-ack
	// models ("On it.") plan correctly. Keyed on the parsed plan shape, the action
	// registry, and the same structural coding-work classifier used by the
	// candidate backstop (which excludes creative-writing / explanation asks), so
	// it is model-agnostic and regresses neither the direct-answer nor the
	// poem-about-an-app path.
	// An explicit, runnable spawn/delegation candidate in the model's OWN
	// candidate list — for a message that structurally looks like coding work — is
	// a firm "delegate this" commitment, and must win EVEN when the model ALSO
	// (contradictorily) routed contexts=[simple] with a chatty complete-looking
	// replyText. Previously this also required a non-simple planning context
	// (`initialPlanningContexts.length > 0`); dropping that requirement closes the
	// live bug where "build the app" came back with contexts=[simple] +
	// candidateActionNames=[TASKS_SPAWN_AGENT], so shouldPreferCompleteDirectReply
	// treated the spawn as "weak", suppressed it, and the bot said "I'm building
	// it" while never spawning. Still safe: the text gate below excludes
	// creative-writing / explanation asks, and the candidate must be a REGISTERED
	// delegation action — so this never fires on a poem or a how-do-I question.
	const modelRoutedPlanningContext = rawContexts.some(
		(context) => context.toLowerCase() !== SIMPLE_CONTEXT_ID,
	);
	// Text gate for the delegation commitment. When the model routed a planning
	// context of its OWN (dual model-authored signal: context + candidate), the
	// commitment stands unless the ask is a class delegation can never serve
	// (creative writing, explanation, explicit no-spawn) — requiring positive
	// coding keywords in the CURRENT message was the live ack-then-nothing hole
	// (2026-07-01, trajectory tj-df82b48e763b7b): a follow-up critique of prior
	// build work ("this isn't your best work") carries no coding keywords — the
	// work context lives in conversation history — so the complete-direct-reply
	// override dropped the model's TASKS_SPAWN_AGENT plan and shipped its ack
	// ("Let me take another pass…") as the whole turn. In the contradictory
	// contexts=[simple] shape the candidate is the only signal, so the message
	// itself must still look like coding work.
	// A one-line snippet ask is a class delegation never serves: a 25s
	// sub-agent build for `print("nubs")` whose code the user never even saw
	// (live 2026-08-22). Without an explicit "spawn/delegate" ask the model's
	// routing does not commit the turn to delegation.
	const inlineSnippetAsk =
		looksLikeInlineCodeSnippetRequest(currentMessageText) &&
		!looksLikeExplicitDelegationRequest(currentMessageText);
	const delegationTextGate = modelRoutedPlanningContext
		? !looksLikeDelegationExcludedAsk(currentMessageText) && !inlineSnippetAsk
		: looksLikeCodingWorkRequest(currentMessageText);
	const modelCommittedToDelegation =
		!preemptDirect &&
		delegationTextGate &&
		modelProvidedRunnableDelegationCandidate(
			rawCandidateActions,
			runtimeContext?.actions ?? [],
			// With a planning context the model's own routing already signals
			// work, so any delegation-class candidate (including the ambiguous
			// legacy alias "TASKS") confirms the commitment. In the contradictory
			// contexts=[simple] shape the candidate is the ONLY delegation
			// signal, so it must be unambiguous — bare "TASKS" (task-list
			// management as much as delegation) on a loosely coding-shaped
			// message ("update me on the project") must not override a complete
			// direct answer into forced planning.
			{ requireUnambiguous: initialPlanningContexts.length === 0 },
		);
	// The model can also route a planning context AND name candidates that
	// resolve to NOTHING in the registry (e.g. SEND_ATTACHMENT / UPLOAD_FILE for
	// "attach that here"). That is still a committed plan — the model believes
	// tool work is needed and wrote its replyText as an ACK per the Stage-1
	// field contract — but the candidates expose a capability gap, so the
	// complete-direct-reply override must not reinterpret the full-sentence ack
	// ("On it — attaching now.") as a finished answer and ship the promise as
	// the WHOLE turn (live ack-then-nothing regression, 2026-07-01: trajectory
	// tj-823d6382b54c66). The planner turn is where an unresolvable plan gets an
	// honest "I can't do that here" instead of a silent broken promise. Keyed on
	// the model-authored plan shape (contexts + candidates it emitted vs the
	// action registry), never on the reply text. Registered candidates are not
	// commitment by themselves: weak-class ones stay overridable (a complete
	// answer beats a stray SHELL hint), non-weak ones already block the override
	// via hasOnlyWeakDirectReplyPlanningSignals, and delegation-class ones are
	// the guard above.
	const modelCommittedToPlanning =
		!preemptDirect &&
		modelRoutedPlanningContext &&
		runtimeContext !== undefined &&
		rawCandidateActions.some((name) => {
			const normalized = normalizeActionIdentifier(name);
			return (
				canonicalPlannerControlActionName(normalized) === null &&
				!exposedActionMatches(runtimeContext.actions, normalized)
			);
		});
	const preferCompleteDirectReply =
		!preemptDirect &&
		!pendingDeclaredWork &&
		requestedPlanning &&
		!unservedDeclaredIntent &&
		!modelCommittedToDelegation &&
		!modelCommittedToPlanning &&
		!looksLikeWebSearchRequest(currentMessageText) &&
		shouldPreferCompleteDirectReply({
			replyText: replyTextRaw,
			candidateActions: runnableCandidateActions,
			contexts: routedContexts,
		});
	const preferInlineCodeSnippetDirectReply =
		!preemptDirect &&
		!pendingDeclaredWork &&
		requestedPlanning &&
		!unservedDeclaredIntent &&
		shouldPreferInlineCodeSnippetDirectReply({
			currentMessageText,
			candidateActions: runnableCandidateActions,
			contexts: routedContexts,
		});
	// The field contract defines non_applied as a terminal outcome with no
	// remaining work, including a preview awaiting confirmation. Candidate
	// names describe possible capabilities; they must not reopen that outcome.
	// Explicit requiresTool and missing prose still need normal planning.
	const terminalNonAppliedReply =
		replyEffectStatus === "non_applied" &&
		!modelRequiresTool &&
		replyTextRaw.trim().length > 0;
	const shouldPlan =
		!preemptDirect &&
		requestedPlanning &&
		!terminalNonAppliedReply &&
		!preferCompleteDirectReply &&
		!preferInlineCodeSnippetDirectReply;
	const finalContexts =
		terminalNonAppliedReply ||
		preferCompleteDirectReply ||
		preferInlineCodeSnippetDirectReply
			? [SIMPLE_CONTEXT_ID]
			: shouldPlan && initialPlanningContexts.length === 0
				? Array.from(
						new Set([
							...routedContexts.filter(
								(context) => context !== SIMPLE_CONTEXT_ID,
							),
							"general",
						]),
					)
				: routedContexts;
	const replyText =
		unservedDeclaredIntent ||
		(pendingDeclaredWork && replyEffectStatus === "pending")
			? ""
			: replyTextRaw;
	const plan: MessageHandlerResult["plan"] = {
		contexts: finalContexts,
		completionContext: parseCompletionContextSelection(
			result.completionContext,
		),
		intents: declaredIntents,
		reply: replyText,
		// Preserve missing status through routing; a parser default is not an
		// explicit model decision that this reply claims no outstanding work.
		...(result.replyEffectStatus !== undefined ? { replyEffectStatus } : {}),
		simple: preemptDirect ? true : !shouldPlan,
		requiresTool: shouldPlan,
	};
	if (
		!terminalNonAppliedReply &&
		!preferCompleteDirectReply &&
		!preferInlineCodeSnippetDirectReply &&
		effectiveCandidateActions.length > 0
	) {
		plan.candidateActions = effectiveCandidateActions;
	}
	// The model emitted NO candidate of its own (rawCandidateActions is what
	// Stage 1 actually named — an unregistered model candidate is still model
	// evidence, deliberately force-planned so the planner delivers the honest
	// capability decline), so the plan's candidates — and with them the
	// required-tool enforcement — stand on deterministic text inference alone
	// (coding backstop, ack inference, or direct inference). Record that so
	// the planner loop can accept a firmly repeated terminal answer early
	// instead of burning the full miss budget on a heuristic's guess. Coding
	// work is deliberately excluded: that inference is structurally anchored
	// to an operation plus a code artifact, and relaxing it lets a planner ship
	// a repeated progress/fallback answer without ever executing delegation.
	if (
		shouldPlan &&
		!modelRequiresTool &&
		effectiveCandidateActions.length > 0 &&
		rawCandidateActions.length === 0 &&
		directCurrentInference.kind !== "coding"
	) {
		plan.requiredToolEvidence = "inferred";
	}
	// The escalation came ONLY from the text-derived view-surface inference on
	// a turn Stage 1 already answered — cap the planner's miss budget so the
	// answer-rescue fires after one rejected reply instead of four (see
	// viewOverlapRequiredToolMissBudget).
	if (shouldPlan && inferredDirectCandidateActions.length > 0) {
		const inferredViewOverlapMissBudget = viewOverlapRequiredToolMissBudget({
			inference: directCurrentInference,
			stageOneContexts: rawContexts,
			stageOneReplyText: replyTextRaw,
			stageOneCandidateActions: rawCandidateActions,
		});
		if (inferredViewOverlapMissBudget !== undefined) {
			plan.requiredToolMissBudget = inferredViewOverlapMissBudget;
		}
	}
	const extract =
		facts.length > 0 ||
		relationships.length > 0 ||
		addressedTo.length > 0 ||
		topics.length > 0
			? { facts, relationships, addressedTo, topics }
			: undefined;
	return {
		processMessage,
		thought: fieldRun?.preempt?.reason ?? "",
		plan,
		...(extract ? { extract } : {}),
	};
}

export function applyCodingCandidateBackstop(args: {
	candidateActions: readonly string[];
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
	messageText: string;
	backstopRules: readonly CandidateActionBackstopRule[];
}): { candidateActions: string[]; forceCodeContext: boolean } {
	if (args.candidateActions.length === 0) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	if (!looksLikeCodingWorkRequest(args.messageText)) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	const normalizedCandidates = args.candidateActions.map(
		normalizeActionIdentifier,
	);
	// A registered backstop rule protects its candidates when it both owns one
	// of the candidate actions AND recognizes this message as addressed to it.
	const protectedByRule = args.backstopRules.some((rule) => {
		const owned = new Set(rule.actionNames.map(normalizeActionIdentifier));
		return (
			normalizedCandidates.some((name) => owned.has(name)) &&
			rule.matches(args.messageText)
		);
	});
	if (protectedByRule) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	const codingAction = findCodingDelegationActionName(args.actions);
	if (!codingAction) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}

	const backstopActionNames = new Set(
		args.backstopRules.flatMap((rule) =>
			rule.actionNames.map(normalizeActionIdentifier),
		),
	);
	const filtered = args.candidateActions.filter(
		(name) => !backstopActionNames.has(normalizeActionIdentifier(name)),
	);
	if (filtered.length === args.candidateActions.length) {
		return { candidateActions: filtered, forceCodeContext: false };
	}

	return {
		candidateActions: uniqueActionNames([codingAction, ...filtered]),
		forceCodeContext: true,
	};
}

export function candidateActionsContainRunnableAction(
	candidateActions: readonly string[],
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
		  }
		| undefined,
): boolean {
	if (candidateActions.length === 0) return false;
	if (!runtimeContext) return true;
	return candidateActions.some((name) => {
		const normalized = normalizeActionIdentifier(name);
		if (canonicalPlannerControlActionName(normalized) !== null) return true;
		return exposedActionMatches(runtimeContext.actions, normalized);
	});
}

export function filterRunnableCandidateActions(
	candidateActions: readonly string[],
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
		  }
		| undefined,
): string[] {
	if (!runtimeContext) return [...candidateActions];
	return candidateActions.filter((name) => {
		const normalized = normalizeActionIdentifier(name);
		if (canonicalPlannerControlActionName(normalized) !== null) return true;
		return exposedActionMatches(runtimeContext.actions, normalized);
	});
}

export function applyDirectCurrentCandidateBackstopToMessageHandler(
	messageHandler: MessageHandlerResult,
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
				messageText?: string;
				subAgentCompletionRelay?: boolean;
		  }
		| undefined,
): MessageHandlerResult {
	const currentMessageText = runtimeContext?.messageText ?? "";
	// A sub-agent completion relay is not a user request — its envelope ECHOES
	// the original task text ("[sub-agent: Build and deploy…]"), so the intent
	// inference below reads a FINISHED task as fresh task intent, promotes the
	// turn to requiresTool, and the planner rejects REPLY up to the
	// required-tool miss cap (or re-runs the injected delegation candidate,
	// re-spawning completed work). The flag is derived from the relay's
	// structural markers (metadata.subAgent / router source / envelope
	// prefix), never from classifying LLM text, so genuine user task-intent
	// turns keep the backstop.
	if (
		messageHandler.processMessage !== "RESPOND" ||
		!runtimeContext ||
		runtimeContext.subAgentCompletionRelay === true ||
		getMessageHandlerCandidateActions(messageHandler).some(
			(name) =>
				normalizeActionIdentifier(name) ===
				normalizeActionIdentifier(DISCOVER_TOOLS_NAME),
		) ||
		currentMessageText.trim().length === 0
	) {
		return messageHandler;
	}

	const directCurrentInference = inferDirectCurrentRequestCandidateInference(
		runtimeContext.actions,
		currentMessageText,
	);
	const directCurrentCandidateActions = directCurrentInference.names;
	if (directCurrentCandidateActions.length === 0) return messageHandler;
	// Same escalation valve as messageHandlerFromFieldResult: a plain-text
	// Stage-1 answer routed through this backstop must not be force-planned
	// over a weak view-capability token overlap either.
	if (
		shouldSuppressInferredCandidateEscalation({
			inference: directCurrentInference,
			...messageHandlerStageOneReplyContexts(messageHandler),
			stageOneCandidateActions:
				getMessageHandlerCandidateActions(messageHandler),
		})
	) {
		return messageHandler;
	}

	const stageOneCandidateActions =
		getMessageHandlerCandidateActions(messageHandler);
	const composedCandidateActions =
		directCurrentInference.kind === "owner-reads"
			? directCurrentCandidateActions
			: uniqueActionNames([
					...stageOneCandidateActions,
					...directCurrentCandidateActions,
				]);
	const runnableCandidateActions = filterRunnableCandidateActions(
		composedCandidateActions,
		runtimeContext,
	);
	if (runnableCandidateActions.length === 0) return messageHandler;

	// The structured-envelope path (messageHandlerFromFieldResult) already refuses
	// to force-plan over a finished answer whose only planning signals are weak,
	// injectable ones (a simple/general context + search/shell-class candidates)
	// via shouldPreferCompleteDirectReply. The plain-text fallback lands here
	// too and must apply the same valve: without it, a COMPLETE plain-text answer
	// ("Your lucky number is 4291." / a solved logic puzzle) that this backstop
	// happened to tag with an inferred WEB_SEARCH candidate would be promoted to
	// requiresTool=true — forcing a pointless web search + a slow extra planner
	// round, even though the identical answer in JSON form (contexts=[simple])
	// goes direct. Apply the same structural valve here so the two Stage-1 shapes
	// route identically. Live-info stays correct: its Stage-1 reply is an ack
	// ("Checking the price now."), not a complete answer, so it fails
	// looksLikeCompleteDirectReply and still forces the fetch. Coding/spawn stays
	// correct too: a strong (non-weak) candidate fails hasOnlyWeakDirectReplyPlanningSignals.
	// The extra !looksLikeCodingWorkRequest guard mirrors the structured path's
	// !modelCommittedToDelegation gate: spawn-class actions (TASKS_SPAWN_AGENT, …)
	// are ALSO in the weak-override set, so without this a plain-text "build the
	// app" reply that read as a complete sentence could be kept direct and never
	// spawn. Restricting the valve to non-coding-work turns keeps the build-spawn
	// path intact while still short-circuiting finished plain-text answers.
	// The !looksLikeWebSearchRequest guard closes the freshness hole the valve
	// would otherwise open (adversarial review): on an explicitly fresh ask
	// ("what's the current BTC price?") a model that confidently HALLUCINATES a
	// complete-looking plain-text answer must not be kept direct — a stale price
	// delivered confidently is worse than the extra fetch. The valve's wins
	// (lucky-number echoes, solved riddles, static knowledge) carry no
	// current-info signal and keep taking the direct path.
	if (
		!looksLikeCodingWorkRequest(currentMessageText) &&
		!looksLikeWebSearchRequest(currentMessageText) &&
		shouldPreferCompleteDirectReply({
			replyText: String(messageHandler.plan.reply ?? ""),
			candidateActions: runnableCandidateActions,
			contexts: messageHandler.plan.contexts ?? [],
		})
	) {
		return messageHandler;
	}

	const planningContexts = (messageHandler.plan.contexts ?? []).filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	// Same view-overlap miss-budget cap as the structured path's plan
	// construction: this backstop is the plain-text Stage-1 shape landing on
	// the identical escalation, so the answered-turn waste is identical too.
	const viewOverlapMissBudget = viewOverlapRequiredToolMissBudget({
		inference: directCurrentInference,
		...messageHandlerStageOneReplyContexts(messageHandler),
		stageOneCandidateActions: getMessageHandlerCandidateActions(messageHandler),
	});
	return {
		...messageHandler,
		plan: {
			...messageHandler.plan,
			contexts:
				planningContexts.length > 0
					? Array.from(new Set(planningContexts))
					: ["general"],
			simple: false,
			requiresTool: true,
			candidateActions: runnableCandidateActions,
			...(viewOverlapMissBudget !== undefined
				? { requiredToolMissBudget: viewOverlapMissBudget }
				: {}),
			// Same relaxable-inference stamp as the structured path. Strong coding
			// work orders keep the full corrective budget so a repeated terminal
			// fallback cannot impersonate completed delegation.
			...(getMessageHandlerCandidateActions(messageHandler).length === 0
				? directCurrentInference.kind !== "coding"
					? { requiredToolEvidence: "inferred" as const }
					: {}
				: {}),
		},
	};
}
