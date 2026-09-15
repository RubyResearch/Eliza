/**
 * Nested planner descent for a parent action's declared sub-actions: resolves and
 * gates the child actions (context + role policy, cycle detection), exposes each
 * admissible child as its own native tool alongside the REPLY/IGNORE/STOP
 * terminals, and runs a `runPlannerLoop` pass over them — recording a `subPlanner`
 * trajectory stage so consumers can render the call tree.
 */

import { actionToJsonSchema } from "../actions/action-schema";
import {
	buildPlannerToolsFromActions,
	CORE_PLANNER_TERMINALS,
} from "../actions/to-tool";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { Action, ActionResult, IAgentRuntime } from "../types";
import type { ContextEvent, ContextObject } from "../types/context-object";
import type { JSONSchema, ToolDefinition } from "../types/model";
import { canActionRun } from "./action-gate";
import { hashString, stableJsonStringify } from "./context-hash";
import {
	type ExecutePlannedToolCallContext,
	type ExecutePlannedToolCallOptions,
	executePlannedToolCall,
	projectActionResultForClipboard,
} from "./execute-planned-tool-call";
import {
	actionResultToPlannerToolResult,
	type PlannerLoopParams,
	type PlannerLoopResult,
	type PlannerRuntime,
	type PlannerToolCall,
	runPlannerLoop,
	summarizeActionResultForPlanner,
} from "./planner-loop";
import type { RecordedStage, TrajectoryRecorder } from "./trajectory-recorder";

function normalizeSubPlannerActionIdentifier(actionName: string): string {
	return actionName
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function buildSubPlannerActionLookup(
	actions: readonly Action[],
): Map<string, Action> {
	const lookup = new Map<string, Action>();
	for (const action of actions) {
		const names = [action.name, ...(action.similes ?? [])];
		for (const name of names) {
			if (typeof name !== "string" || name.trim().length === 0) {
				continue;
			}
			lookup.set(normalizeSubPlannerActionIdentifier(name), action);
		}
	}
	return lookup;
}

export function actionHasSubActions(action: Action): boolean {
	return Array.isArray(action.subActions) && action.subActions.length > 0;
}

export function resolveSubActions(
	runtime: Pick<IAgentRuntime, "actions">,
	action: Action,
): Action[] {
	const subActions = action.subActions ?? [];
	const resolved: Action[] = [];
	const seen = new Set<string>();

	for (const entry of subActions) {
		const child =
			typeof entry === "string"
				? runtime.actions.find((candidate) => candidate.name === entry)
				: entry;
		if (!child) {
			throw new Error(`Sub-action not found: ${entry}`);
		}
		if (!seen.has(child.name)) {
			seen.add(child.name);
			resolved.push(child);
		}
	}

	return resolved;
}

export function detectSubActionCycles(actions: readonly Action[]): string[][] {
	const actionsByName = new Map(actions.map((action) => [action.name, action]));
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const stack: string[] = [];
	const cycleKeys = new Set<string>();

	function visit(action: Action): void {
		if (visiting.has(action.name)) {
			const start = stack.indexOf(action.name);
			if (start >= 0) {
				const cycle = [...stack.slice(start), action.name];
				const key = cycle.join(">");
				if (!cycleKeys.has(key)) {
					cycleKeys.add(key);
					cycles.push(cycle);
				}
			}
			return;
		}
		if (visited.has(action.name)) {
			return;
		}

		visiting.add(action.name);
		stack.push(action.name);

		for (const child of action.subActions ?? []) {
			const childAction =
				typeof child === "string" ? actionsByName.get(child) : child;
			if (childAction) {
				visit(childAction);
			}
		}

		stack.pop();
		visiting.delete(action.name);
		visited.add(action.name);
	}

	for (const action of actions) {
		visit(action);
	}

	return cycles;
}

export type SubPlannerExecute = (
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
	toolCall: PlannerToolCall,
	options: ExecutePlannedToolCallOptions,
) => Promise<ActionResult> | ActionResult;

export function subPlannerCallDigest(toolCall: PlannerToolCall): string {
	const canonical = stableJsonStringify(toolCall.params ?? {});
	return `${normalizeSubPlannerActionIdentifier(toolCall.name)}|${hashString(canonical)}`;
}

function priorNonRetryableSubstep(
	previousResults: readonly ActionResult[] | undefined,
	toolCall: PlannerToolCall,
): boolean {
	const digest = subPlannerCallDigest(toolCall);
	for (const result of [...(previousResults ?? [])].reverse()) {
		const subSteps = result.data?.subSteps;
		if (!Array.isArray(subSteps)) continue;
		for (const candidate of [...subSteps].reverse()) {
			if (!candidate || typeof candidate !== "object") continue;
			const record = candidate as Record<string, unknown>;
			if (
				record.callDigest === digest &&
				record.success === false &&
				record.retryable === false
			) {
				return true;
			}
		}
	}
	return false;
}

export interface RunSubPlannerParams {
	runtime: IAgentRuntime & PlannerRuntime;
	action: Action;
	context: ContextObject;
	ctx: ExecutePlannedToolCallContext;
	options?: ExecutePlannedToolCallOptions;
	config?: PlannerLoopParams["config"];
	evaluate?: PlannerLoopParams["evaluate"];
	onToolCallEnqueued?: PlannerLoopParams["onToolCallEnqueued"];
	modelType?: PlannerLoopParams["modelType"];
	evaluatorEffects?: PlannerLoopParams["evaluatorEffects"];
	provider?: string;
	execute?: SubPlannerExecute;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
}

export async function runSubPlanner(
	params: RunSubPlannerParams,
): Promise<PlannerLoopResult> {
	const declaredChildActions = resolveSubActions(params.runtime, params.action);
	if (declaredChildActions.length === 0) {
		throw new Error(`Action ${params.action.name} has no sub-actions`);
	}
	const authorizedActiveContexts = unionContexts(
		params.ctx.activeContexts,
		params.action.contexts,
		...declaredChildActions.map((child) => child.contexts),
	);
	// One gate for every path (#12087 Item 9): canActionRun applies the same
	// policy-or-gate precedence the executor uses. An ACTION_ROLE_POLICY entry
	// REPLACES a child's declared contextGate rather than being an OR alternative to
	// it, so a child the caller fails on policy is filtered even when its contextGate
	// would admit it. skipPrivateGate: child execution still runs through the
	// executor, which enforces the private-action gate.
	const childActions = declaredChildActions.filter((child) =>
		canActionRun(child, {
			message: params.ctx.message,
			activeContexts: authorizedActiveContexts,
			userRoles: params.ctx.userRoles,
			skipPrivateGate: true,
		}),
	);
	if (childActions.length === 0) {
		throw new Error(
			`Action ${params.action.name} has no sub-actions available in the current context`,
		);
	}

	const cycles = detectSubActionCycles([params.action, ...childActions]);
	if (cycles.length > 0) {
		throw new Error(
			`Sub-action cycle detected: ${cycles.map((cycle) => cycle.join(" -> ")).join("; ")}`,
		);
	}

	const childActionNames = new Set(childActions.map((action) => action.name));
	const childActionLookup = buildSubPlannerActionLookup(childActions);
	// Sub-planner exposes each child action directly as its own native tool
	// (same surface as the top-level planner). Aliases remain accepted by the
	// lookup below, but must not duplicate full native schemas on the wire.
	// The universal terminal-sentinel
	// tools (REPLY / IGNORE / STOP) are always exposed so the model has a
	// stable way to end the sub-planner pass.
	const tools: ToolDefinition[] = [
		...buildPlannerToolsFromActions(childActions),
		...CORE_PLANNER_TERMINALS,
	];
	const execute = params.execute ?? executePlannedToolCall;
	const context = buildSubPlannerContext(
		params.context,
		params.action,
		childActions,
	);
	await emitAppendedContextEvents(
		context.events.slice(params.context.events.length),
	);

	const subPlannerCtx: ExecutePlannedToolCallContext = {
		...params.ctx,
		activeContexts: authorizedActiveContexts,
	};

	// Mark a sub-planner descent so trajectory consumers can render the tree.
	const subPlannerStageId = await recordSubPlannerStage({
		runtime: params.runtime,
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		actionName: params.action.name,
		childActionNames: [...childActionNames],
	});

	return runPlannerLoop({
		runtime: params.runtime,
		context,
		config: params.config,
		evaluate: params.evaluate,
		onToolCallEnqueued: params.onToolCallEnqueued,
		modelType: params.modelType,
		evaluatorEffects: params.evaluatorEffects,
		provider: params.provider,
		tools,
		// Force a native tool call. Sub-planners expose the same shape as the
		// parent planner (per-action tools + REPLY/IGNORE/STOP terminals), so
		// every viable outcome corresponds to a tool. No text-mode fall-through.
		toolChoice: "required",
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: subPlannerStageId ?? params.parentStageId,
		executeToolCall: async (toolCall) => {
			if (!toolCall.name) {
				return {
					success: false,
					error: `Sub-planner ${params.action.name} requires a non-empty action name`,
				};
			}
			const resolvedChildAction =
				childActions.find((action) => action.name === toolCall.name) ??
				childActionLookup.get(
					normalizeSubPlannerActionIdentifier(toolCall.name),
				) ??
				null;
			if (!resolvedChildAction) {
				return {
					success: false,
					error: `Action ${toolCall.name} is not available to sub-planner ${params.action.name}`,
				};
			}
			// The loop records this same object after execution. Canonicalize it in
			// place so the persisted sub-step identity is stable when the model uses
			// a simile on one pass and the canonical name (or another simile) later.
			// Keeping the alias in the trajectory made the replay guard compare two
			// different digests for the same child operation.
			toolCall.name = resolvedChildAction.name;
			const canonicalCall = toolCall;
			if (
				priorNonRetryableSubstep(subPlannerCtx.previousResults, canonicalCall)
			) {
				return {
					success: false,
					error:
						"An identical nested operation already reached a non-retryable outcome this turn.",
					data: {
						retryable: false,
						replaySuppressed: true,
						code: "PRIOR_NON_RETRYABLE_SUBSTEP",
					},
				};
			}

			const rawResult = await execute(
				params.runtime,
				subPlannerCtx,
				canonicalCall,
				{
					...(params.options ?? {}),
					actions: childActions,
				},
			);
			const result = projectActionResultForClipboard(
				resolvedChildAction,
				rawResult,
				resolvedChildAction.name,
			);
			return actionResultToPlannerToolResult(result, {
				summary: summarizeActionResultForPlanner(
					resolvedChildAction,
					result,
					toolCall.params,
					params.runtime,
				),
			});
		},
	});
}

function unionContexts(
	...lists: Array<readonly string[] | undefined>
): string[] {
	const seen = new Set<string>();
	for (const list of lists) {
		if (!list) continue;
		for (const ctx of list) {
			if (typeof ctx === "string" && ctx.length > 0) {
				seen.add(ctx);
			}
		}
	}
	return [...seen];
}

async function recordSubPlannerStage(args: {
	runtime: PlannerRuntime;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	actionName: string;
	childActionNames: string[];
}): Promise<string | undefined> {
	if (!args.recorder || !args.trajectoryId) return undefined;
	try {
		const startedAt = Date.now();
		const stageId = `stage-subplanner-${args.actionName}-${startedAt}`;
		const stage: RecordedStage = {
			stageId,
			kind: "subPlanner",
			parentStageId: args.parentStageId,
			startedAt,
			endedAt: startedAt,
			latencyMs: 0,
			model: undefined,
			tool: undefined,
		};
		// Track child surface area in the stage payload so the CLI can reason
		// about the sub-planner scope. We piggyback on the model field's
		// providerMetadata convention by placing it on the tool.args slot —
		// but to keep the schema clean we use a synthetic `tool` block.
		stage.tool = {
			name: `sub-planner:${args.actionName}`,
			args: { childActions: args.childActionNames },
			result: null,
			success: true,
			durationMs: 0,
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
		return stageId;
	} catch (error) {
		// error-policy:J7 Trajectory recording is diagnostic and must not break the
		// planner, but the failure remains visible to the runtime.
		args.runtime.reportError?.("SubPlanner.recordStage", error, {
			actionName: args.actionName,
		});
		return undefined;
	}
}

async function emitAppendedContextEvents(
	events: readonly ContextEvent[],
): Promise<void> {
	const streamingContext = getStreamingContext();
	for (const event of events) {
		await emitStreamingHook(streamingContext, "onContextEvent", event);
	}
}

function buildSubPlannerContext(
	context: ContextObject,
	parentAction: Action,
	childActions: readonly Action[],
): ContextObject {
	return {
		...context,
		metadata: {
			...(context.metadata ?? {}),
			subPlannerParentAction: parentAction.name,
		},
		events: [
			...context.events,
			...childActions.map((action) => ({
				id: `sub-planner:${parentAction.name}:tool:${action.name}`,
				type: "tool" as const,
				source: "sub-planner",
				tool: {
					name: action.name,
					description: action.description,
					parameters: actionToJsonSchema(action) as JSONSchema,
					action,
					metadata: {
						parentAction: parentAction.name,
					},
				},
			})),
		],
	};
}
