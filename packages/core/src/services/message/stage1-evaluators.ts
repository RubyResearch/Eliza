/** Evaluates Stage 1 response decisions against voice arbitration, authorized contexts, and explicit direct-action routes. */

import { evaluateConnectorAccountPolicies } from "../../connectors/account-manager";
import { canActionRun } from "../../runtime/action-gate";
import { getCandidateActionBackstopRules } from "../../runtime/candidate-action-backstop";
import {
	type DirectActionRoutingRule,
	getDirectActionRoutingRules,
} from "../../runtime/direct-action-routing";
import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";
import type { ResponseHandlerEvaluator } from "../../runtime/response-handler-evaluators";
import type { Action, AgentContext } from "../../types/components";
import type { ContextDefinition, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { getUserMessageText } from "../../utils/message-text";
import {
	mergeAgentContexts,
	messageHandlerStageOneReplyContexts,
} from "./action-surface.js";
import {
	getActionInferenceMessageText,
	isSubAgentCompletionArtifact,
	resolveContinuationInferenceMessageText,
} from "./dialogue-context.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
	replyClaimsInProgressWork,
} from "./side-effect-claims.ts";
import {
	inferDirectCurrentRequestCandidateInference,
	shouldSuppressInferredCandidateEscalation,
	uniqueActionNames,
} from "./stage1-reply-policy.js";
import {
	getVoiceTurnSignalMetadata,
	isVoiceChannelMessage,
	isVoiceGroupChannelMessage,
	transcriptionModeActive,
	voiceGroupAddressSuppressesAgent,
	voiceTurnSignalConfirmsAgent,
	voiceTurnSignalSuppressesAgent,
} from "./voice-signals.js";

export function filterSelectedContextsForRole(
	contexts: readonly AgentContext[],
	availableContexts: readonly ContextDefinition[],
): AgentContext[] {
	if (contexts.length === 0) {
		return [];
	}
	if (availableContexts.length === 0) {
		return [...new Set(contexts)];
	}
	const allowed = new Set(
		availableContexts.map((definition) => String(definition.id)),
	);
	const selected: AgentContext[] = [];
	const seen = new Set<string>();
	for (const context of contexts) {
		const id = String(context);
		if (!allowed.has(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		selected.push(context);
	}
	return selected;
}

export interface EligibleDirectActionRoute {
	rule: DirectActionRoutingRule;
	action: Action;
}

export function routeReplacesStage1Candidate(
	rule: DirectActionRoutingRule,
	candidateActions: readonly string[] | undefined,
): boolean {
	const replacements = rule.replacesActionNames ?? [];
	if (replacements.length === 0 || !candidateActions?.length) return false;
	const candidates = new Set(candidateActions.map(normalizeActionIdentifier));
	return replacements.some((name) =>
		candidates.has(normalizeActionIdentifier(name)),
	);
}

/**
 * Resolve plugin-owned direct routes against the real execution surface for
 * this actor and turn. Context adjacency is deliberately insufficient:
 * CHOOSE_OPTION declares `tasks`, for example, but it neither owns tracked
 * work nor carries a read capability. Name + required tags + the shared action
 * gate + connector policy + validate() must all agree before core forces a
 * simple response into planning.
 */
export async function resolveEligibleDirectActionRoutes(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	userRoles?: readonly RoleGateRole[];
}): Promise<EligibleDirectActionRoute[]> {
	const messageText = getActionInferenceMessageText(args.message);
	if (!messageText) return [];
	const actionsByName = new Map(
		(args.runtime.actions ?? []).map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	const found: EligibleDirectActionRoute[] = [];
	const seen = new Set<string>();
	for (const rule of getDirectActionRoutingRules(args.runtime)) {
		if (!rule.matches(messageText)) continue;
		const requiredTags = new Set(
			rule.requiredActionTags.map((tag) => tag.trim().toLowerCase()),
		);
		for (const actionName of rule.actionNames) {
			const action = actionsByName.get(normalizeActionIdentifier(actionName));
			if (!action) continue;
			const actionTags = new Set(
				(action.tags ?? []).map((tag) => tag.trim().toLowerCase()),
			);
			if (![...requiredTags].every((tag) => actionTags.has(tag))) continue;
			const key = normalizeActionIdentifier(action.name);
			if (
				seen.has(key) ||
				!canActionRun(action, {
					message: args.message,
					activeContexts: mergeAgentContexts(rule.contexts, action.contexts),
					userRoles: args.userRoles,
				})
			) {
				continue;
			}
			try {
				const accountPolicy = await evaluateConnectorAccountPolicies(
					args.runtime,
					action,
					{ message: args.message },
				);
				if (
					!accountPolicy.allowed ||
					!(await action.validate(args.runtime, args.message, args.state))
				) {
					continue;
				}
			} catch (error) {
				// error-policy:J4 explicit user-facing degrade — a route whose
				// availability check fails stays unavailable for this turn; the
				// unchanged Stage-1 answer remains the visible fallback.
				args.runtime.logger.warn(
					{
						src: "service:message",
						route: rule.id,
						action: action.name,
						error,
					},
					"Skipping direct action route whose availability check failed",
				);
				continue;
			}
			seen.add(key);
			found.push({ rule, action });
		}
	}
	return found;
}

export const BUILTIN_RESPONSE_HANDLER_EVALUATORS: readonly ResponseHandlerEvaluator[] =
	[
		{
			name: "core.voice_turn_signal",
			description:
				"Deterministically suppresses voice replies when semantic turn-taking says the next speaker is not the agent.",
			priority: 0,
			shouldRun: ({ message }) =>
				isVoiceChannelMessage(message) &&
				voiceTurnSignalSuppressesAgent(getVoiceTurnSignalMetadata(message)),
			evaluate: ({ message }) => {
				const signal = getVoiceTurnSignalMetadata(message);
				return {
					processMessage: "IGNORE",
					requiresTool: false,
					clearReply: true,
					debug: [
						`voice turn signal suppressed reply (${signal?.source ?? "unknown"}; p=${typeof signal?.endOfTurnProbability === "number" ? signal.endOfTurnProbability.toFixed(3) : "n/a"}; next=${signal?.nextSpeaker ?? "unknown"})`,
					],
				};
			},
		},
		{
			name: "core.voice_turn_signal_confirm",
			description:
				"Server-side positive decision for voice: promotes an IGNORE to RESPOND when the turn signal explicitly confirms the agent should speak (wake-word / direct-address). Never overrides an explicit STOP or an already-RESPOND decision.",
			priority: 0,
			shouldRun: ({ message, messageHandler }) =>
				isVoiceChannelMessage(message) &&
				messageHandler.processMessage === "IGNORE" &&
				voiceTurnSignalConfirmsAgent(getVoiceTurnSignalMetadata(message)),
			evaluate: () => ({
				processMessage: "RESPOND",
				debug: ["voice turn signal confirmed reply (agentShouldSpeak)"],
			}),
		},
		{
			// Runs AFTER the suppress/confirm signal gates: an explicit address to
			// ANOTHER participant is the final word — it overrides even a generic
			// agentShouldSpeak confirm, so a misfiring signal can't make an
			// un-addressed agent talk over the addressed one.
			name: "core.voice_group_address",
			description:
				"Multi-agent/multi-speaker voice-room turn-taking: an agent defers (IGNORE) when a VOICE_GROUP turn is explicitly addressed to another named participant and not to this agent, so only the addressed agent replies. Undirected turns are left to normal shouldRespond.",
			priority: 0,
			shouldRun: ({ message, runtime, messageHandler }) =>
				isVoiceGroupChannelMessage(message) &&
				voiceGroupAddressSuppressesAgent(
					messageHandler.extract?.addressedTo,
					[runtime.character?.name, runtime.agentId].filter(
						(v): v is string => typeof v === "string" && v.length > 0,
					),
				),
			evaluate: ({ runtime, messageHandler }) => ({
				processMessage: "IGNORE",
				requiresTool: false,
				clearReply: true,
				debug: [
					`voice group: turn addressed to [${(messageHandler.extract?.addressedTo ?? []).join(", ")}], not ${runtime.character?.name ?? runtime.agentId} → defer`,
				],
			}),
		},
		{
			name: "core.transcription_mode",
			description:
				"Suppresses the agent's reply while transcription mode is active (the user turn is still persisted), so long-form recording lands in the conversation silently until an exit phrase turns the mode off.",
			priority: 0,
			shouldRun: ({ message }) => transcriptionModeActive(message),
			evaluate: () => ({
				processMessage: "IGNORE",
				requiresTool: false,
				clearReply: true,
				debug: ["transcription mode active — reply suppressed, turn recorded"],
			}),
		},
		{
			name: "core.direct_registered_capability_request",
			description:
				"Promotes or reconciles a plugin-declared current-turn intent only when a matching, capability-tagged action is executable for this actor.",
			priority: 15,
			shouldRun: ({ message, messageHandler, runtime }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (isSubAgentCompletionArtifact(message)) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				const text = getActionInferenceMessageText(message);
				if (text.length === 0) return false;
				const matchingRules = getDirectActionRoutingRules(runtime).filter(
					(rule) => rule.matches(text),
				);
				if (matchingRules.length === 0) return false;
				// A plugin may reconcile an already-tool-bearing/non-simple plan only
				// for the explicit fallback candidates it owns. All other plans keep
				// their Stage-1 route, even when their text happens to match.
				if (
					messageHandler.plan.requiresTool === true ||
					nonSimpleContexts.length > 0
				) {
					return matchingRules.some(
						(rule) =>
							rule.unavailable !== undefined ||
							routeReplacesStage1Candidate(
								rule,
								messageHandler.plan.candidateActions,
							),
					);
				}
				return true;
			},
			evaluate: async ({
				message,
				messageHandler,
				state,
				runtime,
				userRoles,
			}) => {
				const text = getActionInferenceMessageText(message);
				const matchingRules = getDirectActionRoutingRules(runtime).filter(
					(rule) => rule.matches(text),
				);
				const declaredReplacementRules = new Set(
					matchingRules.filter((rule) =>
						routeReplacesStage1Candidate(
							rule,
							messageHandler.plan.candidateActions,
						),
					),
				);
				const authoritativeRules = new Set(
					matchingRules.filter((rule) => rule.unavailable !== undefined),
				);
				const unavailablePatch = (rule: DirectActionRoutingRule) => {
					const unavailable = rule.unavailable;
					if (!unavailable) return undefined;
					return {
						requiresTool: false,
						setContexts: [SIMPLE_CONTEXT_ID],
						clearCandidateActions: true,
						clearReply: true,
						reply: unavailable.reply,
						debug: [
							`direct route unavailable: ${rule.id} (${unavailable.code})`,
						],
					};
				};
				const routes = await resolveEligibleDirectActionRoutes({
					runtime,
					message,
					state,
					userRoles,
				});
				if (routes.length === 0) {
					const unavailableRule =
						[...authoritativeRules].find((rule) => rule.unavailable) ??
						[...declaredReplacementRules].find((rule) => rule.unavailable) ??
						matchingRules.find((rule) => rule.unavailable);
					return unavailableRule
						? unavailablePatch(unavailableRule)
						: undefined;
				}
				// A declared owner keeps exclusive reconciliation authority even when
				// its action is unavailable. Falling through to a second text-matching
				// direct route could execute adjacent work now instead of preserving the
				// original Stage-1 fallback.
				const replacingRoutes =
					declaredReplacementRules.size > 0
						? routes.filter(({ rule }) => declaredReplacementRules.has(rule))
						: [];
				const authoritativeRoutes =
					authoritativeRules.size > 0
						? routes.filter(({ rule }) => authoritativeRules.has(rule))
						: [];
				if (authoritativeRules.size > 0 && authoritativeRoutes.length === 0) {
					const unavailableRule = [...authoritativeRules].find(
						(rule) => rule.unavailable,
					);
					return unavailableRule
						? unavailablePatch(unavailableRule)
						: undefined;
				}
				if (declaredReplacementRules.size > 0 && replacingRoutes.length === 0) {
					const unavailableRule = [...declaredReplacementRules].find(
						(rule) => rule.unavailable,
					);
					return unavailableRule
						? unavailablePatch(unavailableRule)
						: undefined;
				}
				const selectedRoutes =
					authoritativeRoutes.length > 0
						? authoritativeRoutes
						: replacingRoutes.length > 0
							? replacingRoutes
							: routes;
				const replacedActionNames = new Set(
					replacingRoutes.flatMap(({ rule }) =>
						(rule.replacesActionNames ?? []).map(normalizeActionIdentifier),
					),
				);
				const retainedStage1Candidates =
					authoritativeRoutes.length > 0
						? []
						: (messageHandler.plan.candidateActions ?? []).filter(
								(candidate) =>
									!replacedActionNames.has(
										normalizeActionIdentifier(candidate),
									),
							);
				const candidateActions = uniqueActionNames([
					...retainedStage1Candidates,
					...selectedRoutes.map(({ action }) => action.name),
				]);
				const contexts = mergeAgentContexts(
					...selectedRoutes.map(({ rule }) => rule.contexts),
				);
				return {
					requiresTool: true,
					addContexts: contexts,
					addCandidateActions: candidateActions,
					...(replacingRoutes.length > 0 || authoritativeRoutes.length > 0
						? { clearCandidateActions: true }
						: {}),
					// A deterministic read route must not emit Stage-1's speculative
					// answer or a progress bubble before the real action responds.
					clearReply: true,
					debug: [
						`current request matched executable direct route(s): ${selectedRoutes.map(({ rule }) => rule.id).join(", ")} -> ${candidateActions.join(", ")}`,
					],
				};
			},
		},
		{
			name: "core.simple_registered_action_request",
			description:
				"Promotes simple-path replies to planning when the current user request matches a registered action's metadata.",
			priority: 20,
			shouldRun: ({ message, messageHandler, runtime, state }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				// A sub-agent completion relay is owned by the sub-agent-completion
				// evaluator — its only job is to deliver the finished result. Its text
				// echoes the original task ("[sub-agent: Build and deploy a dice
				// roller…]"), which the action-inference below reads as fresh coding
				// work and promotes to requiresTool — forcing a TASKS tool the relay
				// can't satisfy → required_tool_misses exhaustion → a SUCCESSFUL build
				// reports a false "hit a snag". Never promote a relay turn to tooling.
				if (isSubAgentCompletionArtifact(message)) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const text = getActionInferenceMessageText(message);
				if (!text?.trim()) return false;
				// A continuation turn ("finish it", "that is good") has no
				// inferable intent of its own — rerun inference on the resolved
				// nearest prior user request instead.
				const inferenceText =
					resolveContinuationInferenceMessageText(runtime, message, state) ??
					text;
				const inference = inferDirectCurrentRequestCandidateInference(
					runtime.actions ?? [],
					inferenceText,
				);
				if (inference.names.length === 0) return false;
				// Same escalation valve as messageHandlerFromFieldResult: this
				// evaluator re-runs the text inference on the SIMPLE path, so
				// without the valve it re-promotes the exact answered turn the
				// structured path just declined to force-plan (and clears the
				// finished replyText for a planner turn that may never deliver it).
				return !shouldSuppressInferredCandidateEscalation({
					inference,
					...messageHandlerStageOneReplyContexts(messageHandler),
					stageOneCandidateActions: messageHandler.plan.candidateActions ?? [],
				});
			},
			evaluate: ({ message, messageHandler, runtime, state }) => {
				const text = getActionInferenceMessageText(message);
				const inferenceText =
					resolveContinuationInferenceMessageText(runtime, message, state) ??
					text;
				const inference = inferDirectCurrentRequestCandidateInference(
					runtime.actions ?? [],
					inferenceText,
				);
				const candidateActions = shouldSuppressInferredCandidateEscalation({
					inference,
					...messageHandlerStageOneReplyContexts(messageHandler),
					stageOneCandidateActions: messageHandler.plan.candidateActions ?? [],
				})
					? []
					: inference.names;
				if (candidateActions.length === 0) return undefined;
				return {
					requiresTool: true,
					addContexts: ["general"],
					addCandidateActions: candidateActions,
					// Escalation is a routing decision, not a delivery: never
					// synthesize user-visible ack text here. The early-reply path and
					// the final-path fallbacks own what (if anything) the user sees.
					clearReply: true,
					debug: [
						`current request matched registered action metadata: ${candidateActions.join(", ")}`,
					],
				};
			},
		},
		{
			// A simple-path turn runs NO tools, so a reply asserting a completed
			// scheduling/save side effect is fabricated by construction. Reroute the
			// turn to the planner so a real action performs the work and the
			// confirmation the user reads is grounded in a tool result. Candidate
			// hints come from the plugin-registered backstop rules (matched against
			// the fabricated claim's own vocabulary), so core stays free of
			// plugin-specific action names.
			name: "core.simple_completed_side_effect_claim",
			description:
				"Blocks simple-path replies that claim an already-completed scheduling/save side effect no tool performed; reroutes the turn to the planner.",
			priority: 30,
			shouldRun: ({ messageHandler }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				// A terminal no-effect decision cannot gain mutation authority from
				// its wording. Egress still validates the draft and, if necessary,
				// repairs it through the existing reply-only path without actions.
				if (
					messageHandler.plan.replyEffectStatus === "non_applied" ||
					messageHandler.plan.replyEffectStatus === "none"
				)
					return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				return (
					messageHandler.plan.replyEffectStatus === "applied" ||
					replyClaimsCompletedSideEffect(reply)
				);
			},
			evaluate: ({ messageHandler, runtime }) => {
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				const candidateActions = [
					...new Set(
						getCandidateActionBackstopRules(runtime)
							.filter((rule) => rule.matches(reply))
							.flatMap((rule) => [...rule.actionNames]),
					),
				];
				return {
					requiresTool: true,
					addContexts: ["general"],
					...(candidateActions.length > 0
						? { addCandidateActions: candidateActions }
						: {}),
					// Escalation is a routing decision, not a delivery: drop the
					// fabricated claim instead of synthesizing an ack in its place.
					clearReply: true,
					debug: [
						`simple reply claimed a completed side effect with no tool run; rerouting to the planner (candidates: ${candidateActions.join(", ") || "none"})`,
					],
				};
			},
		},
		{
			name: "core.simple_progress_promise",
			description:
				"Blocks simple-path replies that promise in-progress work no tool performed and no handoff will deliver; reroutes the turn to the planner.",
			priority: 30,
			shouldRun: ({ message, messageHandler }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				if (messageHandler.plan.replyEffectStatus === "pending") {
					return !isSubAgentCompletionArtifact(message);
				}
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				return replyClaimsInProgressWork(reply);
			},
			evaluate: ({ messageHandler, runtime }) => {
				if (messageHandler.plan.replyEffectStatus === "pending") {
					return {
						requiresTool: true,
						addContexts: ["general"],
						clearReply: true,
					};
				}
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				const candidateActions = [
					...new Set(
						getCandidateActionBackstopRules(runtime)
							.filter((rule) => rule.matches(reply))
							.flatMap((rule) => [...rule.actionNames]),
					),
				];
				return {
					requiresTool: true,
					addContexts: ["general"],
					...(candidateActions.length > 0
						? { addCandidateActions: candidateActions }
						: {}),
					// A bare promise carries no content worth delivering: drop it and
					// let the planner do the promised work (observed live: "On it." /
					// "Checking your list now." as terminal replies with zero tools).
					clearReply: true,
					debug: [
						`simple reply promised in-progress work with no tool run; rerouting to the planner (candidates: ${candidateActions.join(", ") || "none"})`,
					],
				};
			},
		},
		{
			name: "core.simple_empty_tracked_state_claim",
			description:
				"Replaces an empty tracked-work claim with an honest unavailable state when a declared recap route has no executable reader.",
			priority: 30,
			shouldRun: ({ message, messageHandler, runtime }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				if (!replyClaimsEmptyTrackedWorkState(reply)) return false;
				const text = getUserMessageText(message)?.trim();
				return (
					Boolean(text) &&
					getDirectActionRoutingRules(runtime).some((rule) =>
						rule.matches(text ?? ""),
					)
				);
			},
			evaluate: () => {
				return {
					requiresTool: false,
					reply:
						"I wasn't able to check your tracked tasks and notes just now, so I can't give you an accurate picture of the day. Want me to try again?",
					debug: [
						"blocked an empty tracked-work assertion because the declared read route was unavailable",
					],
				};
			},
		},
	];
