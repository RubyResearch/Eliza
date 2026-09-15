/** Adapts planner tool calls to the existing action executor and settles stream events and evidence-sensitive provider caches. */

import { normalizeActionJsonSchema } from "../../actions/action-schema";
import {
	pinnedDiscriminatorDescription,
	pinnedDiscriminatorForPromotedChild,
	promotedSubactionParent,
} from "../../actions/promote-subactions";
import {
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
} from "../../actions/to-tool";
import { actionGateFailure } from "../../runtime/action-gate";
import { parentAliasesForCandidateAction } from "../../runtime/action-retrieval";
import type {
	EvaluatorEffects,
	EvaluatorOutput,
} from "../../runtime/evaluator";
import {
	type ExecutePlannedToolCallContext,
	type ExecutePlannedToolCallOptions,
	executePlannedToolCall,
	projectActionResultForClipboard,
	shouldSuppressActionResultClipboard,
} from "../../runtime/execute-planned-tool-call";
import {
	actionResultToPlannerToolResult,
	type PlannerLoopParams,
	type PlannerRuntime,
	type PlannerToolCall,
	type PlannerToolResult,
	type PlannerTrajectory,
	summarizeActionResultForPlanner,
} from "../../runtime/planner-loop";
import type { InferredSubactionDispatch } from "../../runtime/planner-types";
import {
	actionHasSubActions,
	runSubPlanner,
	subPlannerCallDigest,
} from "../../runtime/sub-planner";
import type { TrajectoryRecorder } from "../../runtime/trajectory-recorder";
import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticArgs,
} from "../../security/tool-diagnostics";
import {
	emitStreamingHook,
	getStreamingContext,
} from "../../streaming-context";
import type {
	Action,
	ActionResult,
	AgentContext,
	HandlerCallback,
	ProviderValue,
} from "../../types/components";
import type { ContextObject } from "../../types/context-object";
import type { RoleGateRole } from "../../types/contexts";
import {
	mergeEffectReceipts,
	resolveUserFacingEffectReceipts,
} from "../../types/effects";
import type { Memory } from "../../types/memory";
import type { JSONSchema, ToolDefinition } from "../../types/model";
import type { JsonValue } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { toWellFormedUnicode } from "../../utils/well-formed";
import {
	buildRuntimeActionLookup,
	resolvePlannerActionName,
	resolveRuntimeAction,
} from "./action-identifiers.js";
import { actionNameTokenKey, mergeAgentContexts } from "./action-surface.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import { uiViewActionPriority } from "./provider-state.js";

export interface ExecuteV5PlannedToolCallParams {
	runtime: IAgentRuntime;
	toolCall: PlannerToolCall;
	plannerContext: ContextObject;
	executorCtx: ExecutePlannedToolCallContext;
	executorOptions?: ExecutePlannedToolCallOptions;
	plannerRuntime: PlannerRuntime;
	evaluatorEffects?: EvaluatorEffects;
	evaluate?: (params: {
		runtime: PlannerRuntime;
		context: ContextObject;
		trajectory: PlannerTrajectory;
	}) => Promise<EvaluatorOutput> | EvaluatorOutput;
	provider?: string;
	tools?: ToolDefinition[];
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	plannerLoopConfig?: PlannerLoopParams["config"];
	/**
	 * Normal planner selection may activate the selected action's routing
	 * contexts after that action was surfaced through the context-filtered tool
	 * set. Deterministic evaluator calls have no such planner-surface proof and
	 * must retain the turn's original contexts for the canonical gate.
	 */
	activateActionContexts?: boolean;
	/**
	 * Deterministic response-handler calls announce only after this dispatcher
	 * has selected direct execution. Parent actions handled by a sub-planner or
	 * rejected by the dispatcher must not create an orphan pending stream row.
	 */
	announceDirectExecution?: boolean;
}

export interface BuildV5ExecutorContextParams {
	message: Memory;
	replyOwner?: "planner";
	state: State;
	selectedContexts: AgentContext[];
	senderRole: RoleGateRole;
	previousResults: readonly ActionResult[];
	callback?: HandlerCallback;
}

export function buildV5ExecutorContext(
	args: BuildV5ExecutorContextParams,
): ExecutePlannedToolCallContext {
	return {
		message: args.message,
		...(args.replyOwner ? { replyOwner: args.replyOwner } : {}),
		state: args.state,
		activeContexts: args.selectedContexts,
		userRoles: [args.senderRole],
		previousResults: args.previousResults,
		...(args.callback ? { callback: args.callback } : {}),
	};
}

export function __buildV5ExecutorContextForTests(
	args: BuildV5ExecutorContextParams,
): ExecutePlannedToolCallContext {
	return buildV5ExecutorContext(args);
}

/**
 * Providers whose output is a retrieval over the turn's query text, so their
 * turn-cached result goes stale the moment an action introduces new textual
 * evidence mid-turn (an ATTACHMENT page read, a WEB_FETCH body). Names, not
 * references: the agent-side relevant-conversations provider registers by
 * name and core never imports it.
 */
export const EVIDENCE_SENSITIVE_PROVIDER_NAMES = [
	"FACTS",
	"relevant-conversations",
] as const;

/**
 * Minimum characters of new action-result text that count as "new textual
 * evidence". Filters out terse control results (REPLY echoes, IGNORE, status
 * one-liners) so ordinary tool turns do not pay the re-retrieval cost.
 */
export const EVIDENCE_INVALIDATION_MIN_CHARS = 200;

export function actionResultEvidenceTextLength(result: ActionResult): number {
	let length = 0;
	if (typeof result.text === "string") length += result.text.length;
	if (typeof result.userFacingText === "string") {
		length += result.userFacingText.length;
	}
	const content = (result.data as Record<string, unknown> | undefined)?.content;
	if (typeof content === "string") length += content.length;
	return length;
}

/**
 * Within-turn freshness for retrieval providers (the c-node/Zcash gap): when
 * an action settles carrying substantive new text, evict the FACTS and
 * relevant-conversations entries from the turn's cached provider state so the
 * NEXT composeState — planner recompose with maximum reuse, the REPLY
 * action's compose, a continuation compose — re-runs retrieval with the new
 * evidence tokens in scope instead of reusing the pre-action output
 * (`provider-cache:FACTS cacheHit:true` was exactly how "ZCash" on a
 * just-read page never reached fact recall in the same turn). Eviction only;
 * nothing recomputes until a caller actually composes again, and the re-runs
 * are ~tens of ms against multi-second model calls.
 */
export function invalidateEvidenceSensitiveProviderCache(
	runtime: IAgentRuntime,
	message: Memory,
	result: ActionResult,
): void {
	if (!message.id) return;
	if (
		actionResultEvidenceTextLength(result) < EVIDENCE_INVALIDATION_MIN_CHARS
	) {
		return;
	}
	const cached = runtime.stateCache?.get?.(message.id);
	const providers = cached?.data?.providers as
		| Record<string, unknown>
		| undefined;
	if (!providers || typeof providers !== "object") return;
	for (const name of EVIDENCE_SENSITIVE_PROVIDER_NAMES) {
		if (name in providers) delete providers[name];
	}
}

export function __invalidateEvidenceSensitiveProviderCacheForTests(
	runtime: IAgentRuntime,
	message: Memory,
	result: ActionResult,
): void {
	invalidateEvidenceSensitiveProviderCache(runtime, message, result);
}

export async function executeV5PlannedToolCall(
	args: ExecuteV5PlannedToolCallParams,
): Promise<PlannerToolResult> {
	if (!args.toolCall.name) {
		return {
			success: false,
			error: "Planner tool call requires a non-empty action name",
		};
	}

	const actions = args.executorOptions?.actions ?? args.runtime.actions;
	const actionLookup = buildRuntimeActionLookup({ actions });
	// Different reference means the caller narrowed the surface; resolve
	// strictly so LLM aliases can't escape through the global fallback.
	const strictResolve = actions !== args.runtime.actions;
	const resolvedNames = resolvePlannerActionName(
		args.runtime,
		actionLookup,
		args.toolCall.name,
		{ strict: strictResolve },
	);
	const resolvedName = resolvedNames[0] ?? args.toolCall.name;
	const toolCall: PlannerToolCall = { ...args.toolCall, name: resolvedName };

	// Per-turn `actions` is the authorized action surface — the executable subset
	// the model was given as tools. It does NOT include the CORE_PLANNER_TERMINALS
	// (REPLY / IGNORE / STOP) which are surfaced as tools but live in the global
	// runtime registry. When the model calls a terminal (or, under
	// strictResolve, an action outside that authorization), pull it from the global
	// registry by exact name. With `toolChoice: "required"` + tools-array
	// enforcement the model can only call names that are in our exposed set, so
	// this can't be an off-surface escape — it's the terminal/registry bridge.
	const executionActions = actions.some(
		(candidate) => candidate.name === toolCall.name,
	)
		? actions
		: [
				...actions,
				...args.runtime.actions.filter(
					(candidate) => candidate.name === toolCall.name,
				),
			];
	const action = executionActions.find(
		(candidate) => candidate.name === toolCall.name,
	);
	const executorCtx =
		action && args.activateActionContexts !== false
			? {
					...args.executorCtx,
					activeContexts: mergeAgentContexts(
						args.executorCtx.activeContexts,
						action.contexts,
					),
				}
			: args.executorCtx;
	if (
		action &&
		actionHasSubActions(action) &&
		args.activateActionContexts === false
	) {
		const gateFailure = actionGateFailure(action, executorCtx);
		if (gateFailure) {
			return { success: false, error: gateFailure, text: gateFailure };
		}
	}

	const hasDispatcherActionParameter =
		plannerToolCallHasActionParameter(toolCall);
	// An umbrella called without its discriminator is delegated to the
	// sub-planner: a second planner model call over the child tools before any
	// handler runs (live 2026-09-14, tj-22eb87cbbbfac0: `MEMORY {text, kind,
	// tags}` with no `action` spent 1.3 s there ahead of a 95 ms create; the
	// qwen-3.8-27b planner drops the discriminator now that a Stage-1-named
	// alias is represented through its umbrella). When the umbrella's own
	// `inferSubaction` proves the arguments can only mean one promoted child,
	// pin that child's discriminator and run the umbrella directly — the call
	// the planner would have made by passing it.
	const inferred =
		action && actionHasSubActions(action) && !hasDispatcherActionParameter
			? inferPromotedSubactionDispatch(
					action,
					toolCall,
					(name) =>
						executionActions.find((candidate) => candidate.name === name) ??
						args.runtime.actions.find((candidate) => candidate.name === name),
				)
			: undefined;
	if (
		action &&
		actionHasSubActions(action) &&
		!hasDispatcherActionParameter &&
		!inferred
	) {
		const subResult = await runSubPlanner({
			runtime: args.runtime as IAgentRuntime & PlannerRuntime,
			action,
			context: args.plannerContext,
			ctx: executorCtx,
			options: args.executorOptions,
			evaluate: args.evaluate,
			evaluatorEffects: args.evaluatorEffects,
			provider: args.provider,
			config: args.plannerLoopConfig,
			recorder: args.recorder,
			trajectoryId: args.trajectoryId,
		});
		return subPlannerResultToPlannerToolResult(subResult);
	}

	const dispatchCall = inferred?.toolCall ?? toolCall;
	if (args.announceDirectExecution) {
		await announceDirectToolCallToStream(args.runtime, dispatchCall);
	}
	let rawActionResult: ActionResult;
	try {
		rawActionResult = await executePlannedToolCall(
			args.runtime,
			executorCtx,
			dispatchCall,
			{ ...(args.executorOptions ?? {}), actions: executionActions },
		);
	} catch (error) {
		if (args.announceDirectExecution) {
			await settleFailedDirectToolCallOnStream(
				args.runtime,
				dispatchCall,
				error,
			);
		}
		throw error;
	}
	invalidateEvidenceSensitiveProviderCache(
		args.runtime,
		args.executorCtx.message,
		rawActionResult,
	);
	const actionResult = projectActionResultForClipboard(
		action,
		rawActionResult,
		dispatchCall.name,
	);
	const plannerResult = actionResultToPlannerToolResult(actionResult, {
		summary: summarizeActionResultForPlanner(
			action,
			actionResult,
			dispatchCall.params,
			args.runtime,
		),
	});
	return inferred
		? { ...plannerResult, inferredSubaction: inferred.record }
		: plannerResult;
}

/**
 * Resolves an umbrella call that omitted its discriminator into the direct
 * call the planner would have made by passing it, when the umbrella's own
 * `inferSubaction` names exactly one promoted child for these arguments. The
 * name must be declared in the umbrella's `subActions` and resolve to a
 * virtual carrying the pinned discriminator promotion gave it; no hook, an
 * `undefined` verdict, or a name that is not such a child keep sub-planner
 * routing. The planner's own call object is never mutated: the loop keys
 * operation identity, hedge dropping and the trajectory's tool stage on it,
 * so the inference is reported on the result instead.
 */
export function inferPromotedSubactionDispatch(
	action: Action,
	toolCall: PlannerToolCall,
	lookup: (name: string) => Action | undefined,
):
	| { toolCall: PlannerToolCall; record: InferredSubactionDispatch }
	| undefined {
	if (typeof action.inferSubaction !== "function") return undefined;
	const params = toolCall.params ?? {};
	const child = action.inferSubaction(params);
	if (typeof child !== "string" || child.trim().length === 0) return undefined;
	const pinned = pinnedDiscriminatorForPromotedChild(action, child, lookup);
	if (!pinned) return undefined;
	return {
		toolCall: {
			...toolCall,
			params: { ...params, [pinned.discriminator]: pinned.value },
		},
		record: pinned,
	};
}

export function plannerToolCallHasActionParameter(
	toolCall: PlannerToolCall,
): boolean {
	const candidates = [
		toolCall.params,
		(toolCall as { args?: unknown }).args,
		(toolCall as { arguments?: unknown }).arguments,
	];
	for (const candidate of candidates) {
		if (
			candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate) &&
			"action" in candidate
		) {
			return true;
		}
	}
	return false;
}

/**
 * One entry per executed sub-planner step, projected for the parent loop. This
 * is the structured record the outer planner's next turn reasons over so it can
 * see which multi-step operations already succeeded and advance to the next one
 * instead of re-dispatching the umbrella action from scratch (issue
 * elizaOS/eliza#8007).
 */
export interface SubPlannerSubStep {
	action: string;
	success: boolean;
	callDigest: string;
	retryable: boolean;
	summary?: string;
	internalTranscriptText?: string;
	error?: string;
}

export function normalizeSubStepText(text: string): string {
	return toWellFormedUnicode(text.trim());
}

export function collectSubPlannerSubSteps(
	subResult: Awaited<ReturnType<typeof runSubPlanner>>,
): SubPlannerSubStep[] {
	const subSteps: SubPlannerSubStep[] = [];
	for (const step of subResult.trajectory.steps) {
		if (!step.toolCall?.name || !step.result) continue;
		const result = step.result;
		const errorText =
			typeof result.error === "string"
				? result.error
				: result.error instanceof Error
					? result.error.message
					: undefined;
		const summarySource =
			typeof result.text === "string" && result.text.trim().length > 0
				? result.text
				: typeof result.userFacingText === "string"
					? result.userFacingText
					: undefined;
		subSteps.push({
			action: step.toolCall.name,
			success: result.success,
			callDigest: subPlannerCallDigest(step.toolCall),
			retryable: result.data?.retryable !== false,
			...(summarySource
				? { summary: normalizeSubStepText(summarySource) }
				: {}),
			...(result.transcriptVisibility === "internal" &&
			typeof result.text === "string"
				? { internalTranscriptText: result.text }
				: {}),
			...(errorText ? { error: normalizeSubStepText(errorText) } : {}),
		});
	}
	return subSteps;
}

/**
 * Diagnostic, log-shaped projection of the full sub-planner trajectory. Renders
 * every executed sub-step as `OK/FAIL <action>: <summary/error>` so the parent
 * planner's tool-result message carries the progression (e.g.
 * `OK provision_workspace, OK spawn_agent, FAIL submit_workspace`) instead of
 * only the terminal step. Without this the outer LLM cannot tell that step 1
 * already succeeded and re-dispatches the umbrella action on every CONTINUE
 * turn.
 */
export function renderSubStepDiagnosticText(
	subSteps: SubPlannerSubStep[],
): string {
	return subSteps
		.map((step) => {
			const marker = step.success ? "OK" : "FAIL";
			const detail = step.error ?? step.summary;
			return detail
				? `${marker} ${step.action}: ${detail}`
				: `${marker} ${step.action}`;
		})
		.join("\n");
}

export function subPlannerResultToPlannerToolResult(
	subResult: Awaited<ReturnType<typeof runSubPlanner>>,
): PlannerToolResult {
	const evaluator = subResult.evaluator;
	const allSteps = [
		...(subResult.trajectory.archivedSteps ?? []),
		...subResult.trajectory.steps,
	];
	const lastStep = allSteps[allSteps.length - 1];
	const success = evaluator?.success ?? lastStep?.result?.success ?? true;
	const userFacingText = subResult.finalMessage ?? evaluator?.messageToUser;
	const internalTerminalPayload =
		lastStep?.result?.transcriptVisibility === "internal" &&
		typeof lastStep.result.text === "string" &&
		typeof userFacingText === "string" &&
		lastStep.result.text.trim() === userFacingText.trim();

	// Aggregate every executed sub-step, not just the terminal one, so the
	// parent planner's next turn can see which operations already succeeded and
	// advance to the next op instead of re-running the umbrella action from the
	// first step (issue elizaOS/eliza#8007). The per-step progression flows to
	// the outer LLM through `text` (the diagnostic tool-result projection) and
	// to downstream action context through `data.subSteps` /
	// `data.completedSubActions`.
	const subSteps = collectSubPlannerSubSteps(subResult);
	const diagnosticText = renderSubStepDiagnosticText(subSteps);
	const completedSubActions = subSteps
		.filter((step) => step.success)
		.map((step) => step.action);
	const terminalResult = lastStep?.result;
	const terminalData = terminalResult?.data;
	const effectReceipts = mergeEffectReceipts(
		...allSteps.map((step) => step.result?.effectReceipts),
	);
	const terminalUserFacingEffectReceiptIds =
		typeof terminalResult?.userFacingText === "string" &&
		typeof userFacingText === "string" &&
		terminalResult.userFacingText.trim() === userFacingText.trim()
			? terminalResult.userFacingEffectReceiptIds
			: undefined;
	const terminalVerifiedUserFacing =
		!internalTerminalPayload &&
		terminalResult?.verifiedUserFacing === true &&
		Array.isArray(terminalUserFacingEffectReceiptIds) &&
		terminalUserFacingEffectReceiptIds.length > 0 &&
		resolveUserFacingEffectReceipts(terminalResult, effectReceipts) !== null;
	const data =
		terminalData || subSteps.length > 0
			? {
					...(terminalData ?? {}),
					...(subSteps.length > 0
						? {
								subSteps,
								completedSubActions,
							}
						: {}),
				}
			: undefined;

	return {
		success,
		// Diagnostic channel: the whole progression, so CONTINUE re-planning
		// sees the completed steps. Falls back to the user-facing text when the
		// sub-planner executed no discrete steps.
		text: diagnosticText.length > 0 ? diagnosticText : userFacingText,
		transcriptVisibility: lastStep?.result?.transcriptVisibility,
		...(internalTerminalPayload ? {} : { userFacingText }),
		...(effectReceipts.length > 0 ? { effectReceipts } : {}),
		...(terminalResult?.replyFailure
			? { replyFailure: terminalResult.replyFailure }
			: {}),
		...(terminalUserFacingEffectReceiptIds
			? {
					userFacingEffectReceiptIds: terminalUserFacingEffectReceiptIds,
				}
			: {}),
		...(terminalVerifiedUserFacing ? { verifiedUserFacing: true } : {}),
		...(evaluator?.decision === "FINISH" && evaluator.protocolFailure !== true
			? {
					subPlannerEvaluation: {
						decision: "FINISH" as const,
						success: evaluator.success === true,
						...(typeof evaluator.messageToUser === "string" &&
						evaluator.messageToUser.trim()
							? { messageToUser: evaluator.messageToUser }
							: {}),
					},
				}
			: {}),
		data,
		error: lastStep?.result?.error,
		// Propagate the terminal sub-action's chain signal to the parent
		// loop. A sub-action that returns `continueChain: false` (e.g.
		// TASKS_SPAWN_AGENT, fire-and-forget) terminates the sub-planner,
		// but without this the parent planner loop never sees the flag,
		// evaluates CONTINUE, and re-runs the umbrella action, producing
		// duplicate spawns on a single user turn.
		continueChain: lastStep?.result?.continueChain,
	};
}

/**
 * Planner-loop tool surface. Each authorized Action is exposed as its own native
 * tool whose name is the action name and whose `parameters` is the action's
 * JSONSchema. We also always include the universal terminal-sentinel tools
 * (REPLY / IGNORE / STOP) so the planner has a stable way to end the turn.
 *
 * When no actions are gated for the current turn we fall back to an empty
 * tool array so the planner can short-circuit (the pipeline's stage-1
 * shortcut still emits HANDLE_RESPONSE through its own dedicated call).
 */
export function collectPlannerTools(
	context: ContextObject,
	narrowedActions?: ReadonlyArray<Action>,
	options: {
		expandSubActions?: boolean;
		canonicalFamilies?: boolean;
	} = {},
): ToolDefinition[] {
	const hasAnyAction = context.events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	if (!hasAnyAction) return [];
	const actions = narrowedActions ?? collectActionsFromContext(context);
	const tierAParents = readTierAParentsFromContext(context);
	const wireActions = options.canonicalFamilies
		? collectCanonicalPlannerActions(actions)
		: actions;
	const actionTools = buildPlannerToolsFromTieredActions(wireActions, {
		tierAParents,
		expandSubActions: options.canonicalFamilies
			? false
			: options.expandSubActions,
		actionLookup: new Map(
			actions.map((action) => [action.name, action] as const),
		),
	});
	if (options.canonicalFamilies) {
		const wireNames = new Set(wireActions.map((action) => action.name));
		for (const parentTool of actionTools) {
			const parent = actions.find((action) => action.name === parentTool.name);
			if (!parent) continue;
			const aliases = actions.filter(
				(action) =>
					!wireNames.has(action.name) &&
					promotedSubactionParent(action) === parent.name,
			);
			if (aliases.length === 0) continue;
			const parentSchema = normalizeActionJsonSchema(parent);
			const parentPropertyNames = Object.keys(parentSchema.properties ?? {});
			const parentStrict = parent.toolSchemaStrict ?? true;
			// Aliases promoted from an earlier umbrella description keep it as
			// their common lead after the umbrella's own description changed
			// (MESSAGE, live 2026-09-14: 27 aliases each restated the same
			// 760-character base description — 17.7K of a 25K-character contract
			// block on every planner round that exposed the family). Such a lead
			// is stated once; each alias carries only its remainder as
			// `descriptionTail`, or nothing when the remainder is the default
			// blurb.
			const sharedAliasPreamble = sharedDescriptionPreamble(
				aliases
					.filter((alias) => !alias.description.startsWith(parent.description))
					.map((alias) => alias.description),
			);
			const aliasContracts = aliases.map((alias) => {
				const {
					properties = {},
					type: schemaType,
					required = [],
					additionalProperties,
					...schema
				} = normalizeActionJsonSchema(alias);
				const propertyNames = Object.keys(properties);
				// A generated alias composes `${parent.description} — ${blurb}`
				// (promoteSubactionsToActions), so a complete alias description
				// rendered the umbrella's own description once more per alias (live
				// 2026-09-13, consolidated TASKS: 16,882 of the 30,722-char contract
				// block was the 1,977-char umbrella description repeated 14 times;
				// CALENDAR 3,702 of 8,270). The suffix appends verbatim to this
				// tool's description.
				const extendsParentDescription = alias.description.startsWith(
					parent.description,
				);
				const extendsSharedPreamble =
					!extendsParentDescription &&
					sharedAliasPreamble !== undefined &&
					alias.description.startsWith(sharedAliasPreamble);
				// An alias accepting every umbrella property in order (no
				// `subactions` applicability lists: TASKS, CONTACT, DATABASE)
				// repeated the complete name list per alias (TASKS: 56 names × 14
				// aliases, 9,198 chars). Omission means every property of this tool.
				const usesEveryParentProperty =
					propertyNames.length === parentPropertyNames.length &&
					propertyNames.every(
						(name, index) => parentPropertyNames[index] === name,
					);
				// A promoted alias differs from its umbrella only in the pinned
				// discriminator (pinDiscriminatorForVirtual): the umbrella's own
				// property with the auto-set description, a one-value enum and a
				// matching default. Spelling that override out, plus the
				// umbrella-equal strict/type/required/additionalProperties and the
				// default " — subaction = x" suffix, repeated ~360 chars per alias
				// (live 2026-09-14: 11 CALENDAR aliases, 5,014 of the 16,829-char
				// tool). Each pin is carried as `pins[name] = value`; every other
				// field is emitted only when it differs from the default the
				// preamble states.
				const pins: Record<string, string> = {};
				const propertyOverrides: Record<string, JSONSchema> = {};
				for (const [name, property] of Object.entries(properties)) {
					const parentProperty = parentSchema.properties?.[name];
					if (JSON.stringify(property) === JSON.stringify(parentProperty)) {
						continue;
					}
					const pinned = pinnedDiscriminatorValue(property, parentProperty);
					if (pinned === undefined) propertyOverrides[name] = property;
					else pins[name] = pinned;
				}
				const pinValues = Object.values(pins);
				const defaultSuffix =
					pinValues.length === 1 ? ` — subaction = ${pinValues[0]}` : undefined;
				const suffix = extendsParentDescription
					? alias.description.slice(parent.description.length)
					: undefined;
				const tail =
					extendsSharedPreamble && sharedAliasPreamble !== undefined
						? alias.description.slice(sharedAliasPreamble.length)
						: undefined;
				const parameters = {
					...schema,
					...(schemaType === "object" ? {} : { type: schemaType }),
					...(required.length > 0 ? { required } : {}),
					...(additionalProperties === parentSchema.additionalProperties
						? {}
						: { additionalProperties }),
					...(usesEveryParentProperty
						? {}
						: { parentParameterNames: propertyNames }),
					...(Object.keys(propertyOverrides).length > 0
						? { propertyOverrides }
						: {}),
				};
				return {
					name: alias.name,
					...(suffix !== undefined
						? suffix === defaultSuffix
							? {}
							: { descriptionSuffix: suffix }
						: tail !== undefined
							? tail === defaultSuffix
								? {}
								: { descriptionTail: tail }
							: { description: alias.description }),
					routingHint: alias.routingHint,
					...((alias.toolSchemaStrict ?? true) === parentStrict
						? {}
						: { strict: alias.toolSchemaStrict ?? true }),
					...(pinValues.length > 0 ? { pins } : {}),
					...(Object.keys(parameters).length > 0 ? { parameters } : {}),
				};
			});
			const preambleNote =
				sharedAliasPreamble !== undefined
					? ` Aliases carrying descriptionTail (or neither description field) are described by this shared preamble followed by the tail (or by the default " — subaction = value"): ${JSON.stringify(sharedAliasPreamble)}.`
					: "";
			parentTool.description += `\nGenerated aliases represented by this umbrella: call this tool using the alias's pinned discriminator. Defaults for every alias unless its contract says otherwise: pins[name]=value pins that property of this tool to value (enum [value], default value, description 'Subaction discriminator (auto-set to "value" for this virtual; do not change).'); the alias description is this tool's description + " — subaction = value" (descriptionSuffix appends verbatim instead; description replaces it); the alias takes every property of this tool in order, including descriptions and defaults (parentParameterNames lists the exact subset; propertyOverrides replaces only differing properties); type object, nothing required, and this tool's strict and additionalProperties.${preambleNote} Complete alias contracts:\n${JSON.stringify(aliasContracts)}`;
		}
	}
	const terminalNames = new Set(
		CORE_PLANNER_TERMINALS.map((tool) => normalizeActionIdentifier(tool.name)),
	);
	// REPLY/IGNORE may also be registered runtime actions. The planner-loop owns
	// these protocol terminals, so keep its canonical definitions exactly once;
	// duplicate native tool names waste schema tokens and are ambiguous to model
	// providers that preserve both entries.
	return [
		...actionTools.filter(
			(tool) => !terminalNames.has(normalizeActionIdentifier(tool.name)),
		),
		...CORE_PLANNER_TERMINALS,
	];
}

/** Word-boundary common lead of two or more texts when it is long enough to be worth stating once. */
export function sharedDescriptionPreamble(
	texts: readonly string[],
): string | undefined {
	if (texts.length < 2) return undefined;
	const [first, ...rest] = texts;
	if (first === undefined) return undefined;
	let end = first.length;
	for (const text of rest) {
		let index = 0;
		while (index < end && index < text.length && first[index] === text[index]) {
			index++;
		}
		end = index;
	}
	const boundary = first.slice(0, end).search(/[^\s]*$/);
	// The default " — subaction = value" blurb shares its lead across aliases;
	// keep it out of the preamble so each alias's tail stays the whole blurb.
	const preamble = first
		.slice(0, boundary)
		.replace(/\s*—(?:\s*subaction(?:\s*=)?)?\s*$/, "")
		.trimEnd();
	return preamble.length >= 80 ? preamble : undefined;
}

/**
 * The value an alias pins its discriminator to when `property` is exactly the
 * umbrella's `parentProperty` carrying the pinned description, one-value enum
 * and matching default that `pinDiscriminatorForVirtual` writes; undefined
 * for any other override, which the contract then spells out in full.
 */
function pinnedDiscriminatorValue(
	property: JSONSchema,
	parentProperty: JSONSchema | undefined,
): string | undefined {
	if (!parentProperty) return undefined;
	const enumValues = property.enum;
	if (!Array.isArray(enumValues) || enumValues.length !== 1) return undefined;
	const value = enumValues[0];
	if (typeof value !== "string" || property.default !== value) return undefined;
	const expected: JSONSchema = {
		...parentProperty,
		description: pinnedDiscriminatorDescription(value),
		enum: [value],
		default: value,
	};
	return canonicalJson(property) === canonicalJson(expected)
		? value
		: undefined;
}

/** JSON with object keys sorted at every level, for order-insensitive equality. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested: unknown) => {
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			return Object.fromEntries(
				Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				),
			);
		}
		return nested;
	});
}

/**
 * Represents generated aliases once through their complete authorized umbrella.
 * Independent child actions remain direct, as does an alias whose umbrella is
 * absent, incomplete, or lossy for it. A Stage-1 candidate alias gets no
 * exemption: its umbrella is always loaded beside it
 * (collectBudgetedStageOneCandidateActions), so a direct alias tool repeated
 * the umbrella's complete parameter schema on every planner round (live
 * 2026-09-13, one calendar move: CALENDAR 23,471 chars plus
 * CALENDAR_SEARCH_EVENTS 12,786 and CALENDAR_UPDATE_EVENT 13,232, the same
 * `details` schema three times). The umbrella's alias contract (~750 chars)
 * still names the candidate with its pinned discriminator, and the caller
 * retains every original context action for execution and trajectories.
 */
export function collectCanonicalPlannerActions(
	actions: readonly Action[],
): Action[] {
	const authorized = new Map(actions.map((action) => [action.name, action]));
	return actions.filter((action) => {
		const parentName = promotedSubactionParent(action);
		if (!parentName) return true;
		const parent = authorized.get(parentName);
		// An umbrella requiring a field absent from this alias cannot represent
		// that alias's valid calls without manufacturing an extra argument.
		if (
			parent?.parameters?.some(
				(parameter) =>
					parameter.required &&
					!action.parameters?.some((entry) => entry.name === parameter.name),
			)
		)
			return true;
		if (
			parent?.subActions?.some(
				(child) =>
					!authorized.has(typeof child === "string" ? child : child.name),
			)
		)
			return true;
		return !parent?.subActions?.some(
			(child) =>
				(typeof child === "string" ? child : child.name) === action.name,
		);
	});
}

export type UmbrellaPlannerBudgetDecision =
	| "under-dispatch-budget"
	| "smaller-than-complete-surface"
	| "not-smaller";

/**
 * Decide whether the umbrella-parent request replaces the current planner
 * request. The dispatch threshold compares a utf8-upper-bound ESTIMATE (one
 * token per byte) against the model window, and the provider's real count runs
 * far below it (190,732 tokens for a surface this estimator put at 506,107), so
 * an umbrella that misses the estimate routinely fits the real window. Both
 * requests are measured with the same upper bound, so a smaller umbrella
 * estimate is a strictly smaller request: keeping the larger complete surface
 * instead fails whenever the umbrella would fail and also whenever it would not
 * (the provider rejects the larger request and the turn ends in the typed
 * overflow apology). The umbrella keeps every authorized parent, and the
 * provider boundary in planner-loop.ts remains the ground-truth backstop.
 */
export function decideUmbrellaPlannerBudget(args: {
	umbrella: { estimatedInputTokens: number; dispatchThresholdTokens: number };
	current: { estimatedInputTokens: number };
}): UmbrellaPlannerBudgetDecision {
	if (
		args.umbrella.estimatedInputTokens <= args.umbrella.dispatchThresholdTokens
	) {
		return "under-dispatch-budget";
	}
	if (args.umbrella.estimatedInputTokens < args.current.estimatedInputTokens) {
		return "smaller-than-complete-surface";
	}
	return "not-smaller";
}

/**
 * Recover an oversized planner request from Stage 1's model-authored action
 * candidates. This is a dispatch-budget fallback, not a command router: Stage 1
 * has already interpreted the user's request with the response-handler model,
 * and the action planner still has to select and call one of the resulting
 * tools. Unknown or ambiguous candidates fail open to the complete authorized
 * surface so this helper cannot invent authority or silently pick an action.
 */
export function collectBudgetedStageOneCandidateActions(args: {
	actions: readonly Action[];
	candidateActions: readonly string[];
	contexts: readonly AgentContext[];
	/** The progressive lane offers unselected operations through discovery. */
	deferUnselectedContexts?: boolean;
	/** Initial hints may name both a family and a specific operation. Keep the
	 * operation inline and the family discoverable; explicit discovery never
	 * uses this projection. */
	deferParentHints?: boolean;
}): Action[] {
	if (args.candidateActions.length === 0) return [];

	const actionLookup = buildRuntimeActionLookup({ actions: args.actions });
	const selectedNames = new Set<string>();
	for (const candidateName of args.candidateActions) {
		const direct = resolveRuntimeAction(actionLookup, candidateName);
		// Progressive planning can discover the actual registered operation. A
		// guessed parent for an unregistered hint can expose unrelated schemas
		// (NOTES_GET -> VIEWS) even beside the correctly selected child.
		if (!direct && args.deferUnselectedContexts) {
			// Preserve admission's unambiguous reversed-name resolution without
			// guessing a different operation or family from overlapping words.
			const tokenKey = actionNameTokenKey(candidateName);
			const matches = args.actions.filter(
				(action) => actionNameTokenKey(action.name) === tokenKey,
			);
			if (matches.length === 1) {
				selectedNames.add(normalizeActionIdentifier(matches[0].name));
			}
			continue;
		}
		const resolved = direct
			? [direct]
			: parentAliasesForCandidateAction(candidateName)
					.map((alias) => resolveRuntimeAction(actionLookup, alias))
					.filter((action): action is Action => action !== undefined);
		// Hints are not an execution contract. One invented name must not throw
		// away the known families and inflate the entire surface; the pipeline
		// exposes DISCOVER_TOOLS for the remaining authorized catalog.
		if (resolved.length === 0) continue;
		for (const action of resolved) {
			selectedNames.add(normalizeActionIdentifier(action.name));
		}
	}
	if (selectedNames.size === 0) return [];
	if (args.deferUnselectedContexts && args.deferParentHints) {
		const hintedNames = new Set(selectedNames);
		for (const parent of args.actions) {
			if (
				parent.subActions?.some((child) =>
					hintedNames.has(
						normalizeActionIdentifier(
							typeof child === "string" ? child : child.name,
						),
					),
				)
			) {
				selectedNames.delete(normalizeActionIdentifier(parent.name));
			}
		}
	}
	// Legacy budget fallback has no discovery guarantee and keeps the whole
	// family. Progressive planning keeps exact child hints; unselected siblings
	// and their parent stay in DISCOVER_TOOLS, including for compound follow-ups.
	// A parent still selected after the initial hint projection expands its
	// complete authorized family. Explicit discovery retains every named parent.
	for (const parent of args.deferUnselectedContexts ? [] : args.actions) {
		if (
			parent.subActions?.some((child) =>
				selectedNames.has(
					normalizeActionIdentifier(
						typeof child === "string" ? child : child.name,
					),
				),
			)
		) {
			selectedNames.add(normalizeActionIdentifier(parent.name));
		}
	}
	// Fill only domains missing from the resolved candidates. A synthetic
	// candidate may resolve to VIEWS without the Notes data action. Once an
	// explicit candidate covers a domain, do not add every related action:
	// Calendar shares its context with many life-management tools, whose full
	// schemas can overflow the model despite a precise CALENDAR selection.
	const coveredContexts = new Set(
		args.actions
			.filter((action) =>
				selectedNames.has(normalizeActionIdentifier(action.name)),
			)
			.flatMap((action) => action.contexts ?? [])
			.map((context) => String(context).trim().toLowerCase()),
	);
	const uncoveredContexts = (
		args.deferUnselectedContexts ? [] : args.contexts
	).filter(
		(context) => !coveredContexts.has(String(context).trim().toLowerCase()),
	);
	const noFocusedViewActions = new Set<string>();
	for (const action of args.actions) {
		if (
			uiViewActionPriority(action, uncoveredContexts, noFocusedViewActions) ===
			1
		) {
			selectedNames.add(normalizeActionIdentifier(action.name));
		}
	}
	// A loaded parent exposes its complete authorized family. Loading only the
	// initially named child can strand a follow-up operation in a compound ask.
	let addedChild = true;
	while (addedChild) {
		addedChild = false;
		for (const action of args.actions) {
			if (!selectedNames.has(normalizeActionIdentifier(action.name))) continue;
			for (const child of action.subActions ?? []) {
				const childName = normalizeActionIdentifier(
					typeof child === "string" ? child : child.name,
				);
				if (!selectedNames.has(childName)) {
					selectedNames.add(childName);
					addedChild = true;
				}
			}
		}
	}

	return args.actions.filter((action) =>
		selectedNames.has(normalizeActionIdentifier(action.name)),
	);
}

/**
 * Read the historical tier-A metadata for telemetry compatibility. Tool
 * construction ignores it and expands every authorized parent and child.
 */
export function readTierAParentsFromContext(
	context: ContextObject,
): Set<string> {
	const surface = (context.metadata as { actionSurface?: unknown } | undefined)
		?.actionSurface;
	if (!surface || typeof surface !== "object") {
		return new Set<string>();
	}
	const tierAParents = (surface as { tierAParents?: unknown }).tierAParents;
	if (!Array.isArray(tierAParents)) {
		return new Set<string>();
	}
	const set = new Set<string>();
	for (const value of tierAParents) {
		if (typeof value === "string" && value.trim().length > 0) {
			set.add(value);
		}
	}
	return set;
}

/**
 * Pull each action surfaced as a `tool` event in the context. Mirrors the
 * filtering used by the planner-loop's tools rendering — sub-planner scoping
 * and dedup by normalised name happen there, while here we just keep the
 * action references in the order they appear so per-turn tool ordering is
 * deterministic.
 */
export function collectActionsFromContext(context: ContextObject): Action[] {
	const seen = new Set<string>();
	const actions: Action[] = [];
	for (const event of context.events ?? []) {
		if (event.type !== "tool" || !("tool" in event)) continue;
		const tool = event.tool as { action?: Action; name?: string } | undefined;
		const action = tool?.action;
		if (!action || typeof action.name !== "string") continue;
		const normalized = action.name.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		actions.push(action);
	}
	return actions;
}

export function collectPreviousActionResults(
	trajectory: PlannerTrajectory,
	actions: readonly Action[] = [],
): ActionResult[] {
	const actionsByName = new Map<string, Action>();
	for (const action of [
		...collectActionsFromContext(trajectory.context),
		...actions,
	]) {
		actionsByName.set(normalizeActionIdentifier(action.name), action);
	}
	const results: ActionResult[] = [];
	for (const step of [...trajectory.archivedSteps, ...trajectory.steps]) {
		if (!step.result || !step.toolCall) {
			continue;
		}
		const actionName = step.toolCall.name;
		const action = actionsByName.get(normalizeActionIdentifier(actionName));
		if (shouldSuppressActionResultClipboard(action, step.result)) {
			results.push({
				success: step.result.success,
				...(step.result.text !== undefined ? { text: step.result.text } : {}),
				...(step.result.transcriptVisibility !== undefined
					? { transcriptVisibility: step.result.transcriptVisibility }
					: {}),
				...(step.result.userFacingText !== undefined
					? { userFacingText: step.result.userFacingText }
					: {}),
				...(step.result.verifiedUserFacing !== undefined
					? { verifiedUserFacing: step.result.verifiedUserFacing }
					: {}),
				...(step.result.effectReceipts !== undefined
					? { effectReceipts: step.result.effectReceipts }
					: {}),
				...(step.result.replyFailure !== undefined
					? { replyFailure: step.result.replyFailure }
					: {}),
				...(step.result.userFacingEffectReceiptIds !== undefined
					? {
							userFacingEffectReceiptIds:
								step.result.userFacingEffectReceiptIds,
						}
					: {}),
				// Clipboard suppression drops the planner-facing data payload, but
				// suppressPlannerReply is a turn-delivery contract, not clipboard
				// content — dropping it here re-enabled the evaluator's mimicked
				// ack on out-of-band-acked TASKS_CREATE turns (live 2026-08-19,
				// trajectory data reduced to {actionName} with the flag gone).
				data: {
					actionName,
					...(step.result.data?.suppressPlannerReply === true
						? { suppressPlannerReply: true }
						: {}),
				},
				...(step.result.turnComplete !== undefined
					? { turnComplete: step.result.turnComplete }
					: {}),
				...(step.result.continueChain !== undefined
					? { continueChain: step.result.continueChain }
					: {}),
			});
			continue;
		}
		const plannerData = step.result.data;
		const nestedValues = plannerData?.values;
		const nestedValueEntries =
			nestedValues !== null &&
			typeof nestedValues === "object" &&
			!Array.isArray(nestedValues)
				? Object.entries(nestedValues)
				: [];
		const values =
			nestedValueEntries.length > 0 &&
			nestedValueEntries.every(
				(entry): entry is [string, ProviderValue] =>
					typeof entry[1] !== "function" && typeof entry[1] !== "symbol",
			)
				? Object.fromEntries(nestedValueEntries)
				: undefined;
		const actionData =
			values && plannerData
				? Object.fromEntries(
						Object.entries(plannerData).filter(([key]) => key !== "values"),
					)
				: plannerData;
		const error =
			typeof step.result.error === "string"
				? step.result.error
				: step.result.error instanceof Error
					? step.result.error.message
					: undefined;
		results.push({
			success: step.result.success,
			...(step.result.text !== undefined ? { text: step.result.text } : {}),
			...(step.result.transcriptVisibility !== undefined
				? { transcriptVisibility: step.result.transcriptVisibility }
				: {}),
			...(step.result.userFacingText !== undefined
				? { userFacingText: step.result.userFacingText }
				: {}),
			...(step.result.verifiedUserFacing !== undefined
				? { verifiedUserFacing: step.result.verifiedUserFacing }
				: {}),
			...(step.result.effectReceipts !== undefined
				? { effectReceipts: step.result.effectReceipts }
				: {}),
			...(step.result.replyFailure !== undefined
				? { replyFailure: step.result.replyFailure }
				: {}),
			...(step.result.userFacingEffectReceiptIds !== undefined
				? {
						userFacingEffectReceiptIds: step.result.userFacingEffectReceiptIds,
					}
				: {}),
			data: {
				...actionData,
				actionName,
			},
			// Keep the producer's explicit model contract through background-task
			// persistence. Losing it here re-inflates completed navigation receipts.
			...(step.result.promptDataMode === "replace-data" &&
			step.result.promptData
				? {
						promptData: { ...step.result.promptData, actionName },
						promptDataMode: step.result.promptDataMode,
					}
				: {}),
			...(values ? { values } : {}),
			...(error !== undefined ? { error } : {}),
			...(step.result.turnComplete !== undefined
				? { turnComplete: step.result.turnComplete }
				: {}),
			...(step.result.continueChain !== undefined
				? { continueChain: step.result.continueChain }
				: {}),
		});
	}
	return results;
}

/**
 * Streaming status parity for tool executions that bypass the planner loop —
 * the pre-LLM shortcut gate and response-handler deterministic tool calls.
 * The planner loop announces every tool through the streaming `onToolCall`
 * hook, which the chat SSE surface projects onto its existing
 * `{type:"status",kind:"running_tool"}` frame and inline tool row; without
 * this, exactly the fastest turns render no activity between "thinking" and
 * the final reply. Same wire payload as planner-loop's executeQueuedToolCall;
 * the executor's own emitToolResult settles the row.
 */
export async function announceDirectToolCallToStream(
	runtime: IAgentRuntime,
	toolCall: PlannerToolCall,
): Promise<void> {
	const streamingContext = getStreamingContext();
	if (!streamingContext?.onToolCall) return;
	const redactDiagnosticText = composeToolDiagnosticRedactor(runtime);
	await emitStreamingHook(streamingContext, "onToolCall", {
		toolCall: {
			id: toolCall.id ?? toolCall.name,
			name: toolCall.name,
			arguments: (projectToolDiagnosticArgs(
				toolCall.params ?? {},
				redactDiagnosticText,
			) ?? {}) as Record<string, JsonValue>,
			status: "pending",
		},
		...(streamingContext.messageId
			? { messageId: streamingContext.messageId }
			: {}),
		metadata: { deterministic: true },
	});
}

/** Settles a direct-call announcement when the canonical executor throws. */
export async function settleFailedDirectToolCallOnStream(
	runtime: IAgentRuntime,
	toolCall: PlannerToolCall,
	error: unknown,
): Promise<void> {
	const streamingContext = getStreamingContext();
	if (!streamingContext?.onToolResult) return;
	const redactDiagnosticText = composeToolDiagnosticRedactor(runtime);
	const id = toolCall.id ?? toolCall.name;
	const message = redactDiagnosticText(
		error instanceof Error ? error.message : String(error),
	);
	await emitStreamingHook(streamingContext, "onToolResult", {
		toolCall: {
			id,
			name: toolCall.name,
			arguments: (projectToolDiagnosticArgs(
				toolCall.params ?? {},
				redactDiagnosticText,
			) ?? {}) as Record<string, JsonValue>,
			status: "failed",
			result: { success: false, text: message, error: message },
		},
		toolCallId: id,
		result: { success: false, text: message, error: message },
		status: "failed",
		...(streamingContext.messageId
			? { messageId: streamingContext.messageId }
			: {}),
		metadata: { deterministic: true },
	});
}
