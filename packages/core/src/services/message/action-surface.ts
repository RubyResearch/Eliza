/** Builds the complete authorized planner action surface and caches rendered catalogs by runtime registration state. */

import { evaluateConnectorAccountPolicies } from "../../connectors/account-manager";
import { getInferenceTimer, recordInferenceSpan } from "../../inference-timing";
import {
	buildActionCatalog,
	type LocalizedActionExampleResolver,
	normalizeActionName,
} from "../../runtime/action-catalog";
import { actionGateRejection } from "../../runtime/action-gate";
import {
	parentAliasesForCandidateAction,
	retrieveActions,
} from "../../runtime/action-retrieval";
import { tierActionResults } from "../../runtime/action-tiering";
import type { TrajectoryRecorder } from "../../runtime/trajectory-recorder";
import type { CodingActionProfile } from "../../types/coding";
import type {
	Action,
	AgentContext,
	MessageHandlerResult,
} from "../../types/components";
import type { RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { getUserMessageText } from "../../utils/message-text";
import {
	buildRuntimeActionLookup,
	resolveRuntimeAction,
} from "./action-identifiers.js";
import {
	getRecentConversationSearchText,
	isTaskCompleteRelayTurn,
} from "./dialogue-context.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	hasUiViewPlannerScope,
	uiViewActionNames,
	uiViewActionPriority,
} from "./provider-state.js";

export type V5PlannerActionSurfaceSummary = {
	mode: "full" | "tiered" | "relay-delivery";
	candidateActionCount: number;
	catalogParentCount: number;
	exposedActionCount: number;
	tierAParents: string[];
	/** Every registered child exposed as a first-class planner tool per parent. */
	tierAChildrenByParent?: Record<string, string[]>;
	tierBParents: string[];
	omittedParentCount: number;
	omittedParentNamesPreview: string[];
	actionSurfaceHash?: string;
	warnings: number;
	queryTokens: string[];
	candidateActions: string[];
	parentActionHints: string[];
	codingActionProfile?: {
		kind: "pi";
		includeWorktree: boolean;
	};
	fallback?: string;
};

export type V5PlannerActionSurface = {
	exposedActionNames: Set<string>;
	summary: V5PlannerActionSurfaceSummary;
};

export async function collectV5PlannerCandidateActions(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	selectedContexts?: readonly AgentContext[];
	candidateActions?: readonly string[];
	/** Discover routable actions before Stage 1 has selected their contexts. */
	discoverActions?: boolean;
	userRoles?: readonly RoleGateRole[];
	/** Out-param: normalized names and reasons for EXPLICIT stage-1 candidates
	 * rejected by the owner-exclusive disclosure gate.
	 * Lets the planner entry distinguish "capability exists but is gated on
	 * this surface" from ordinary no-match, and answer honestly instead of
	 * planning against an unrelated retrieval surface. */
	diagnostics?: {
		disclosureRejectedExplicitCandidates: string[];
		/** The disclosure reason per rejected explicit candidate, so the
		 * privacy short-circuit can answer accurately: a non-owner
		 * (`owner_mismatch`) needs a permission-truthful decline, while an owner
		 * on a group surface (`participant_mismatch`) needs the "ask me in a DM"
		 * routing hint. Same index order as
		 * `disclosureRejectedExplicitCandidates`. */
		disclosureRejectedReasons: string[];
		/** Normalized names of EXPLICIT stage-1 candidates rejected by a
		 * NON-disclosure gate: role/context/private-action (#20679), plus
		 * connector-account-policy denials, unavailable explicit capabilities,
		 * `validate() === false`, and failed policy/validation checks (#20869). A
		 * privacy denial only proves a disclosure boundary; when the same turn also
		 * has a non-disclosure rejection the request is compound, so the privacy
		 * short-circuit must stand down and let the planner/recovery path answer the
		 * non-disclosure limitation honestly. */
		nonDisclosureRejectedExplicitCandidates: string[];
	};
}): Promise<Action[]> {
	// The candidate surface starts from every runtime action and applies only the
	// same execution gates the planner executor will enforce — it deliberately does
	// NOT pre-filter by `action.contexts` against the messageHandler-picked
	// `selectedContexts`. Context pre-filtering excludes owner actions, CALENDAR,
	// SCHEDULED_TASKS, etc. whenever the messageHandler routes to "general", even
	// when the user clearly asked for a habit/event/etc. Starting from every action
	// keeps role-policy overrides working for deployments that intentionally expose
	// an action outside its declared context, while avoiding dead tools the planner
	// could select but execution would immediately reject.
	const allRuntimeActions = args.runtime.actions;
	const actionLookup = buildRuntimeActionLookup(args.runtime);
	const actionsByName = new Map(
		allRuntimeActions.map((action) => [action.name, action]),
	);
	const actionsByNormalizedName = new Map(
		allRuntimeActions.map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	const selectedActions: Action[] = [];
	const seen = new Set<string>();
	const checks = getInferenceTimer()
		? ([] as Array<{
				action: string;
				gate: "connector-policy" | "validate";
				durationMs: number;
				outcome: "returned" | "threw";
			}>)
		: undefined;
	const discoveryStartedAt = checks ? performance.now() : 0;
	// One summary preserves every check without consuming the per-turn span
	// budget before the actual model and delivery spans can be recorded.
	const observeCheck = async <T>(
		gate: "connector-policy" | "validate",
		action: Action,
		run: () => Promise<T>,
	): Promise<T> => {
		if (!checks) return run();
		const startedAt = performance.now();
		let returned = false;
		try {
			const result = await run();
			returned = true;
			return result;
		} finally {
			checks.push({
				action: action.name,
				gate,
				durationMs: performance.now() - startedAt,
				outcome: returned ? "returned" : "threw",
			});
		}
	};

	const appendIfAllowed = async (
		action: Action,
		parentActionName?: string,
		activeContexts: readonly AgentContext[] | undefined = args.selectedContexts,
		explicitCandidateName?: string,
	): Promise<boolean> => {
		const normalizedName = normalizeActionIdentifier(action.name);
		if (!normalizedName || seen.has(normalizedName)) {
			return false;
		}
		// One gate for exposure and execution (#12087 Item 9): private-action gate
		// (private actions never reach the planner on a user turn) + ACTION_ROLE_POLICY
		// + contextGate + roleGate, all via the shared chokepoint.
		// Explicit Stage-1 hints need a diagnostic when their resolved action is
		// rejected. The all-action pass stays quiet because ordinary gate misses
		// are expected while building a narrowed surface.
		const gateRejection = actionGateRejection(action, {
			message: args.message,
			activeContexts,
			userRoles: args.userRoles,
		});
		if (gateRejection !== undefined) {
			if (explicitCandidateName) {
				if (gateRejection.kind === "disclosure") {
					args.diagnostics?.disclosureRejectedExplicitCandidates.push(
						action.name,
					);
					args.diagnostics?.disclosureRejectedReasons.push(
						gateRejection.reason,
					);
				} else {
					args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
						action.name,
					);
				}
				args.runtime.logger.warn(
					{
						src: "service:message",
						action: action.name,
						candidate: explicitCandidateName,
						gate: "action-gate",
						reason: gateRejection.reason,
					},
					"Explicit stage-1 candidate rejected at the action gate",
				);
			}
			return false;
		}
		try {
			const accountPolicy = await observeCheck("connector-policy", action, () =>
				evaluateConnectorAccountPolicies(args.runtime, action, {
					message: args.message,
				}),
			);
			if (!accountPolicy.allowed) {
				if (explicitCandidateName) {
					// An account-policy denial is a non-disclosure rejection: record it
					// so a mixed {disclosure + policy} set is visible to the privacy
					// short-circuit's onlyDisclosureRejections conjunct (#20869).
					args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
						action.name,
					);
					args.runtime.logger.warn(
						{
							src: "service:message",
							action: action.name,
							candidate: explicitCandidateName,
							gate: "connector-account-policy",
							reason: accountPolicy.reason,
						},
						"Explicit stage-1 candidate rejected by connector account policy",
					);
				}
				return false;
			}
			if (action.validate) {
				const validate = action.validate;
				const valid = await observeCheck("validate", action, () =>
					validate.call(action, args.runtime, args.message, args.state),
				);
				if (!valid) {
					if (explicitCandidateName) {
						// validate()===false is likewise a non-disclosure rejection
						// (#20869); without this record the mixed set short-circuits to
						// the privacy template — the #20679 mislabel class.
						args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
							action.name,
						);
						args.runtime.logger.warn(
							{
								src: "service:message",
								action: action.name,
								candidate: explicitCandidateName,
								gate: "validate-returned-false",
								reason: `Action ${action.name} is not available for the current state`,
							},
							"Explicit stage-1 candidate rejected by action validate()",
						);
					}
					return false;
				}
			}
			seen.add(normalizedName);
			selectedActions.push(action);
			return true;
		} catch (error) {
			if (explicitCandidateName) {
				// Provider-policy and validate exceptions are fail-closed capability
				// rejections, not disclosure decisions. Preserve that distinction so
				// a sibling disclosure denial cannot mislabel the compound turn as
				// purely private.
				args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
					action.name,
				);
			}
			// error-policy:J1 planner exposure fails closed for the affected action
			// while reporting the validation failure to the agent.
			args.runtime.reportError(
				"MessageService.plannerActionValidation",
				error,
				{
					action: action.name,
					parentAction: parentActionName,
				},
			);
			return false;
		}
	};

	// View metadata changes ordering only. The complete runtime catalog still
	// passes through the ordinary role/context/policy gates, so an ambiguous or
	// cross-view request never loses an otherwise authorized action merely
	// because Stage 1 did not guess its exact name.
	const focusedViewActionNames = uiViewActionNames(args.message);
	const baseRuntimeActions = hasUiViewPlannerScope(args.message)
		? allRuntimeActions
				.map((action, index) => ({ action, index }))
				.sort((left, right) => {
					const priorityDelta =
						uiViewActionPriority(
							left.action,
							args.selectedContexts,
							focusedViewActionNames,
						) -
						uiViewActionPriority(
							right.action,
							args.selectedContexts,
							focusedViewActionNames,
						);
					return priorityDelta || left.index - right.index;
				})
				.map(({ action }) => action)
		: allRuntimeActions;
	for (const action of baseRuntimeActions) {
		// Discovery uses the same declared contexts as an explicit candidate hint.
		// Role, disclosure, private-action, connector, and validation gates still run.
		await appendIfAllowed(
			action,
			undefined,
			args.discoverActions
				? mergeAgentContexts(args.selectedContexts, action.contexts)
				: args.selectedContexts,
		);
	}

	const explicitCandidateActions = Array.isArray(args.candidateActions)
		? args.candidateActions
		: [];
	for (const candidateName of explicitCandidateActions) {
		// Resolve the synthetic candidate name Stage-1 invents to real actions:
		// first by exact name/simile, then by the shared parent-alias map that
		// retrieval already uses. The alias fallback lets an explicit permission
		// ask surface its writer (SETTINGS) even when Stage-1 mis-scoped the turn's
		// context (e.g. classified "revoke network access for the weather app" as
		// terminal/general): the candidate is an intent hint, so the resolved
		// parent is admitted under ITS OWN contexts — still gated on
		// role/private/context via appendIfAllowed (#14622).
		const direct = resolveRuntimeAction(actionLookup, candidateName);
		let resolved = direct
			? [direct]
			: parentAliasesForCandidateAction(candidateName)
					.map((alias) => resolveRuntimeAction(actionLookup, alias))
					.filter((action): action is Action => action !== undefined);
		if (resolved.length === 0) {
			// Stage-1 models emit reversed compound names (live 2026-08-19:
			// `CANCEL_TASKS` for `TASKS_CANCEL`). Same tokens, any order — admit
			// only an unambiguous single match; ambiguity keeps the warn below.
			const candidateTokenKey = actionNameTokenKey(candidateName);
			const tokenMatches = allRuntimeActions.filter(
				(action) => actionNameTokenKey(action.name) === candidateTokenKey,
			);
			if (tokenMatches.length === 1) {
				resolved = tokenMatches;
			}
		}
		if (resolved.length === 0) {
			const normalizedCandidate = normalizeActionIdentifier(candidateName);
			if (normalizedCandidate) {
				// A missing capability is another non-disclosure limitation. Recording
				// it keeps a simultaneous disclosure rejection from short-circuiting
				// the planner with an unrelated privacy-only response.
				args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
					normalizedCandidate,
				);
			}
			args.runtime.logger.warn(
				{
					src: "service:message",
					candidate: candidateName,
					gate: "resolved-to-no-runtime-action",
				},
				"Explicit stage-1 candidate resolved to no runtime action",
			);
			continue;
		}
		for (const action of resolved) {
			await appendIfAllowed(
				action,
				undefined,
				mergeAgentContexts(args.selectedContexts, action.contexts),
				candidateName,
			);
		}
	}

	for (let index = 0; index < selectedActions.length; index += 1) {
		const parentAction = selectedActions[index];
		const childActiveContexts = mergeAgentContexts(
			args.selectedContexts,
			parentAction.contexts,
		);
		for (const subAction of parentAction.subActions ?? []) {
			const childAction =
				typeof subAction === "string"
					? (actionsByName.get(subAction) ??
						actionsByNormalizedName.get(normalizeActionIdentifier(subAction)))
					: subAction;
			if (!childAction) {
				args.runtime.logger.warn(
					{
						src: "service:message",
						parentAction: parentAction.name,
						subAction,
					},
					"Skipping unresolved sub-action while building planner action surface",
				);
				continue;
			}
			await appendIfAllowed(
				childAction,
				parentAction.name,
				mergeAgentContexts(childActiveContexts, childAction.contexts),
			);
		}
	}

	if (checks)
		recordInferenceSpan(
			"actions:discovery",
			performance.now() - discoveryStartedAt,
			{
				phase: args.discoverActions ? "discovery" : "planner",
				checks: JSON.stringify(checks),
			},
		);
	return selectedActions;
}

export function stringArrayProperty(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
}

export function mergeAgentContexts(
	...lists: Array<readonly AgentContext[] | undefined>
): AgentContext[] {
	const seen = new Set<string>();
	const merged: AgentContext[] = [];
	for (const list of lists) {
		for (const context of list ?? []) {
			const id = String(context);
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			merged.push(context);
		}
	}
	return merged;
}

/**
 * The agent contexts a focused per-turn coding loop is considered to be
 * operating in.
 * Used to admit the coding tools (FILE/SHELL/WORKTREE gate on these) while the
 * messaging/social chat actions stay gated off.
 */
export const CODING_SUB_AGENT_CONTEXTS: readonly AgentContext[] = [
	"code",
	"files",
	"terminal",
	"automation",
];

export function actionNameTokenKey(name: string): string {
	return normalizeActionName(name).split("_").filter(Boolean).sort().join("_");
}

export function getMessageHandlerCandidateActions(
	messageHandler: MessageHandlerResult,
): string[] {
	return stringArrayProperty(
		(messageHandler.plan as { candidateActions?: unknown }).candidateActions,
	);
}

// The two stage-1 plan fields the escalation predicates read as plain values.
// `candidateActions` stays per call site because the backstop path cleans it
// through `getMessageHandlerCandidateActions` while the evaluator path forwards
// the raw list. A stage-1 plan legitimately may carry no contexts and no reply,
// so an absent optional field normalizes to the empty shape those pure
// predicates already treat as "nothing there" — normalized here once instead of
// at every call site.
/**
 * Choose the honest decline for a gated owner-private ask, driven by the actual
 * gate-failure reason instead of a single hardcoded line. The old fixed reply
 * ("ask me in a DM") is correct ONLY when the asker is the owner on a shared
 * surface — for a genuine non-owner it is misleading advice, since a DM would
 * be denied too. Reasons come from `actionGateFailure` and end in the disclosure
 * decision reason (`participant_mismatch`, `owner_mismatch`, …).
 *
 *  - owner on a group/shared surface (`participant_mismatch` /
 *    `destination_not_private`) → the DM routing hint is accurate.
 *  - not the owner (`owner_mismatch`) → a permission-truthful decline with NO
 *    DM hint, because access, not surface, is missing.
 */
export function privacyDenialReplyForReasons(
	reasons: readonly string[],
): string {
	const joined = reasons.join(" | ").toLowerCase();
	const ownerOnWrongSurface =
		/participant_mismatch|destination_not_private/.test(joined);
	const notTheOwner = /owner_mismatch/.test(joined);
	// Owner-on-a-group takes precedence when multiple disclosure-gated candidates
	// fail for different audience reasons.
	if (ownerOnWrongSurface && !notTheOwner) {
		return "that's private, so i can't pull it up in a shared channel — ask me in a DM and i'll handle it there.";
	}
	if (notTheOwner) {
		return "that's the owner's private info, so i can't share it — it's only available to them.";
	}
	return "i can't share that private information in this conversation.";
}

export function messageHandlerStageOneReplyContexts(
	messageHandler: MessageHandlerResult,
): {
	stageOneContexts: readonly string[];
	stageOneReplyText: string;
	stageOneReplyEffectStatus: MessageHandlerResult["plan"]["replyEffectStatus"];
	stageOneIntents: readonly string[];
} {
	return {
		stageOneContexts: messageHandler.plan.contexts ?? [],
		stageOneReplyText: String(messageHandler.plan.reply ?? ""),
		stageOneReplyEffectStatus: messageHandler.plan.replyEffectStatus,
		stageOneIntents: messageHandler.plan.intents ?? [],
	};
}

export function getMessageHandlerParentActionHints(
	messageHandler: MessageHandlerResult,
): string[] {
	return stringArrayProperty(
		(messageHandler.plan as { parentActionHints?: unknown }).parentActionHints,
	);
}

export function buildFullV5PlannerActionSurface(params: {
	actions: readonly Action[];
	candidateActions?: readonly string[];
	parentActionHints?: readonly string[];
	codingActionProfile?: CodingActionProfile;
}): V5PlannerActionSurface {
	const exposedActionNames = new Set(
		params.actions.map((action) => normalizeActionIdentifier(action.name)),
	);
	return {
		exposedActionNames,
		summary: {
			mode: "full",
			candidateActionCount: params.actions.length,
			catalogParentCount: params.actions.length,
			exposedActionCount: exposedActionNames.size,
			tierAParents: params.actions.map((action) => action.name).sort(),
			tierBParents: [],
			omittedParentCount: 0,
			omittedParentNamesPreview: [],
			warnings: 0,
			queryTokens: [],
			candidateActions: [...(params.candidateActions ?? [])],
			parentActionHints: [...(params.parentActionHints ?? [])],
			...(params.codingActionProfile
				? {
						codingActionProfile: {
							kind: params.codingActionProfile.kind,
							includeWorktree:
								params.codingActionProfile.includeWorktree === true,
						},
					}
				: {}),
		},
	};
}

export function buildV5PlannerActionSurface(params: {
	actions: readonly Action[];
	forceFullSurface?: boolean;
	codingActionProfile?: CodingActionProfile;
	message: Memory;
	state?: State;
	messageHandler: MessageHandlerResult;
	/** @deprecated Candidate hints rank tools but never remove authorized tools. */
	restrictToCandidateActions?: boolean;
	// The messageHandler-selected contexts for this turn. Passed through to
	// `retrieveActions` as a *weight* (boost on-context candidates) — never
	// as a filter. See `services/collectV5PlannerCandidateActions` for why
	// we stopped filtering by context.
	selectedContexts?: readonly AgentContext[];
	// Optional recorder hook. When provided the function emits a `toolSearch`
	// stage to the trajectory before returning. Fire-and-forget — the caller
	// does not need to await.
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	logger?: IAgentRuntime["logger"];
	reportError?: IAgentRuntime["reportError"];
	// Optional locale-aware example swapper. Resolved by the caller (which
	// has async access to `OwnerFactStore.locale`) and passed through to
	// `buildActionCatalog` so the planner sees localized `ActionExample`
	// pairs at catalog-build time.
	localizedExamples?: LocalizedActionExampleResolver;
}): V5PlannerActionSurface {
	const candidateActions = getMessageHandlerCandidateActions(
		params.messageHandler,
	);
	const parentActionHints = getMessageHandlerParentActionHints(
		params.messageHandler,
	);

	// An explicitly forced surface retains the historical summary mode, but both
	// paths preserve every authorized action. Retrieval and tier metadata only
	// order and describe the complete catalog.
	// A task_complete relay's only job is delivering the finished result. Any
	// catalog tool on this synthetic turn invites task-management
	// improvisation over the completed work (live 2026-08-19: the planner
	// ARCHIVED the just-completed task and told the user "Archived" instead
	// of relaying the result). Protocol tools (REPLY/IGNORE/STOP) remain.
	// Blocked/question/coordination relays keep the full surface — those turns
	// may legitimately act (answer a child, coordinate a sibling).
	if (isTaskCompleteRelayTurn(params.message)) {
		return {
			exposedActionNames: new Set<string>(),
			summary: {
				mode: "relay-delivery",
				candidateActionCount: params.actions.length,
				catalogParentCount: 0,
				exposedActionCount: 0,
				tierAParents: [],
				tierAChildrenByParent: {},
				tierBParents: [],
				omittedParentCount: 0,
				omittedParentNamesPreview: [],
				actionSurfaceHash: "relay-delivery",
				warnings: 0,
				queryTokens: [],
				candidateActions: [],
				parentActionHints: [],
				...(params.codingActionProfile
					? {
							codingActionProfile: {
								kind: params.codingActionProfile.kind,
								includeWorktree:
									params.codingActionProfile.includeWorktree === true,
							},
						}
					: {}),
			},
		};
	}
	const forceFullSurface =
		params.forceFullSurface === true || params.actions.length === 0;
	if (forceFullSurface) {
		return buildFullV5PlannerActionSurface({
			actions: params.actions,
			candidateActions,
			parentActionHints,
			codingActionProfile: params.codingActionProfile,
		});
	}

	const toolSearchStartedAt = Date.now();
	const authorizedActionIdentities = new Set(
		params.actions.map((action) => action.name.trim()),
	);
	const authorizedActionNames = new Set(
		params.actions.map((action) => normalizeActionIdentifier(action.name)),
	);
	// A parent may retain inline metadata for every registered child even when
	// this turn's action gate rejected one of those children. Build retrieval and
	// tier metadata from the authorized view so a denied child's name,
	// description, schema, or examples cannot influence or enter model context.
	const authorizedCatalogActions = params.actions.map((action) => ({
		...action,
		subActions: action.subActions?.filter((child) => {
			const childName = typeof child === "string" ? child : child.name;
			// Authorization uses the exact native tool identity. The retrieval
			// normalizer intentionally collapses separators, so using it here would
			// let an allowed FOO_BAR disclose a denied FOOBAR child (or vice versa).
			return authorizedActionIdentities.has(childName.trim());
		}),
	}));
	const catalogStartedAt = performance.now();
	const catalog = buildActionCatalog(authorizedCatalogActions, {
		localizedExamples: params.localizedExamples,
	});
	recordInferenceSpan("actions:catalog", performance.now() - catalogStartedAt, {
		actions: authorizedCatalogActions.length,
		parents: catalog.parents.length,
	});
	const measurementMode = process.env.ELIZA_RETRIEVAL_MEASUREMENT === "1";
	const messageText = getUserMessageText(params.message);
	if (typeof messageText !== "string") {
		params.logger?.warn(
			{
				src: "service:message",
				messageId: params.message.id,
			},
			"Planner action retrieval received message without text",
		);
	}
	const retrievalMessageText =
		typeof messageText === "string" ? messageText : "";
	const retrievalStartedAt = performance.now();
	const retrieval = retrieveActions({
		catalog,
		messageText: retrievalMessageText,
		recentConversationText: getRecentConversationSearchText(
			params.state,
			params.message,
		),
		selectedContexts: params.selectedContexts,
		candidateActions,
		parentActionHints,
		measurementMode,
	});
	recordInferenceSpan(
		"actions:retrieval",
		performance.now() - retrievalStartedAt,
	);
	const tieringStartedAt = performance.now();
	const tieredSurface = tierActionResults({
		catalog,
		results: retrieval.results,
		narrowToCandidateActions: candidateActions,
		// Kept for source compatibility; child availability is complete.
		queryTokens: retrieval.query.tokens,
	});
	recordInferenceSpan("actions:tiering", performance.now() - tieringStartedAt);
	const toolSearchEndedAt = Date.now();
	const exposedActionNames = authorizedActionNames;
	const tierAChildrenByParent = Object.fromEntries(
		tieredSurface.tierAParents.map((parent) => [
			parent.name,
			parent.childNames.filter((childName) =>
				authorizedActionIdentities.has(childName.trim()),
			),
		]),
	);
	const exposedActionCount = params.actions.filter((action) =>
		exposedActionNames.has(normalizeActionIdentifier(action.name)),
	).length;

	if (params.recorder && params.trajectoryId) {
		const stageId = `stage-toolsearch-${toolSearchStartedAt}`;
		const trajectoryId = params.trajectoryId;
		void params.recorder
			.recordStage(trajectoryId, {
				stageId,
				kind: "toolSearch",
				startedAt: toolSearchStartedAt,
				endedAt: toolSearchEndedAt,
				latencyMs: toolSearchEndedAt - toolSearchStartedAt,
				toolSearch: {
					query: {
						text: retrievalMessageText,
						tokens: retrieval.query.tokens,
						candidateActions: [...candidateActions],
						parentActionHints: [...parentActionHints],
					},
					results: retrieval.results.map((r, idx) => ({
						name: r.name,
						score: r.score,
						rank: idx,
						rrfScore: r.rrfScore,
						matchedBy: r.matchedBy,
						// stageScores is Partial<Record<RetrievalStageName, number>>;
						// the telemetry field is the structurally-identical
						// Record<string, number>, so a plain cast is enough.
						stageScores: r.stageScores as Record<string, number>,
					})),
					tier: {
						tierA: tieredSurface.sortedTierAParentNames,
						tierB: tieredSurface.sortedTierBParentNames,
						omitted: tieredSurface.omittedParentNames.length,
					},
					durationMs: toolSearchEndedAt - toolSearchStartedAt,
					...(retrieval.measurement
						? {
								perStageScores: retrieval.measurement.perStageScores,
								fusedTopK: retrieval.measurement.fusedTopK,
							}
						: {}),
				},
			})
			.catch((err) => {
				// error-policy:J7 Tool-search recording is diagnostic; report the
				// missing stage without changing the selected action surface.
				params.reportError?.("MessageService.toolSearchStage", err, {
					trajectoryId,
				});
				params.logger?.warn?.(
					{ err: (err as Error).message, trajectoryId },
					"[TrajectoryRecorder] failed to record toolSearch stage",
				);
			});
	}

	return {
		exposedActionNames,
		summary: {
			mode: "tiered",
			candidateActionCount: params.actions.length,
			catalogParentCount: catalog.parents.length,
			exposedActionCount,
			tierAParents: tieredSurface.sortedTierAParentNames,
			tierAChildrenByParent,
			tierBParents: tieredSurface.sortedTierBParentNames,
			omittedParentCount: tieredSurface.omittedParentNames.length,
			omittedParentNamesPreview: tieredSurface.omittedParentNames,
			actionSurfaceHash: tieredSurface.actionSurfaceHash,
			warnings: catalog.warnings.length,
			queryTokens: retrieval.query.tokens,
			candidateActions,
			parentActionHints,
			...(params.codingActionProfile
				? {
						codingActionProfile: {
							kind: params.codingActionProfile.kind,
							includeWorktree:
								params.codingActionProfile.includeWorktree === true,
						},
					}
				: {}),
		},
	};
}
