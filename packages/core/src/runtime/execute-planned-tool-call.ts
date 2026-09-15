/**
 * Executes one planner-selected tool call against its Action: resolves the
 * action, applies role and connector-account gates, normalizes and validates
 * the args, restores real secrets/PII at the egress boundary, runs the handler
 * inside the trajectory / action-routing context, and emits ACTION_STARTED /
 * ACTION_COMPLETED around a normalized ActionResult.
 */
import { validateToolArgs } from "../actions/validate-tool-args";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { ElizaError } from "../errors";
import { checkSenderRole } from "../roles";
import { isSensitiveKeyName } from "../security/redact";
import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticArgs,
	TOOL_DIAGNOSTIC_MASK,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import {
	authorizeOwnerExclusiveDisclosure,
	PRIVACY_DENIED_TEXT,
	revalidateOwnerExclusiveDisclosure,
} from "../security/trusted-delivery-audience";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";
import { withActionStep } from "../trajectory-utils";
import type {
	Action,
	ActionParameters,
	ActionResult,
	ContentValue,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	StreamChunkCallback,
} from "../types";
import type { AgentContext, RoleGateRole } from "../types/contexts";
import { EventType } from "../types/events";
import type { ToolCall } from "../types/model";
import type { UUID } from "../types/primitives";
import type { State } from "../types/state";
import { withActiveRoutingContexts } from "../utils/context-routing";
import { resolveActionEventWorldId } from "./action-event-world";
import { actionGateFailure } from "./action-gate";
import {
	actionFailureResult as failureResult,
	settleActionHandler,
	stringifyActionError as stringifyError,
} from "./action-handler-settlement";
import { _resetActionRolePolicyCacheForTests as _resetCacheForTests } from "./action-role-policy";
import { runWithActionRoutingContext } from "./action-routing-context";
import { parseJsonObject } from "./json-output";
import type { PlannerToolCall } from "./planner-loop";
import {
	buildTurnEntityAliases,
	type EntityAliasCapabilityMap,
	resolveEntityAliasRefs,
} from "./tool-arg-aliases";

export interface PlannedToolCall {
	id?: string;
	name: string;
	params?: Record<string, unknown>;
	args?: unknown;
	arguments?: unknown;
}

export interface ExecutePlannedToolCallContext {
	message: Memory;
	/** The parent turn will synthesize from complete action results. */
	replyOwner?: "planner";
	state?: State;
	activeContexts?: readonly AgentContext[];
	userRoles?: readonly RoleGateRole[];
	previousResults?: readonly ActionResult[];
	callback?: Parameters<Action["handler"]>[4];
	responses?: Memory[];
	/**
	 * Explicit per-turn alias grants for redaction placeholders in tool args
	 * (#20091). When absent, the executor mints the map itself via
	 * `buildTurnEntityAliases` from the composed state, resolved roles, and
	 * canonical owner context; supplying it lets a planner boundary pass a
	 * pre-authorized capability map. Never sourced from ambient settings.
	 */
	entityAliases?: EntityAliasCapabilityMap;
}

export type ExecutePlannedToolCallOptions = HandlerOptions & {
	actions?: readonly Action[];
	onStreamChunk?: StreamChunkCallback;
	abortSignal?: AbortSignal;
	/**
	 * Observes the normalized handler result immediately after settlement and
	 * before post-execution bookkeeping can fail. Sensitive and owner-exclusive
	 * payloads are projected before observation. The observer is isolated from
	 * action execution and is never forwarded into HandlerOptions.
	 */
	onSettledResult?: (result: ActionResult) => void;
};

function isContentRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_ACTION_RESULT_DIAGNOSTIC_DEPTH = 8;
const MAX_ACTION_RESULT_DIAGNOSTIC_NODES = 1_024;

interface ActionResultDiagnosticBudget {
	nodes: number;
}

function redactDiagnosticString(
	value: string,
	redactDiagnosticText: ToolDiagnosticTextRedactor,
): ContentValue {
	try {
		return redactDiagnosticText(value);
	} catch {
		// error-policy:J4 A broken redactor becomes an explicit diagnostic mask.
		return TOOL_DIAGNOSTIC_MASK;
	}
}

function defineDiagnosticProperty(
	record: Record<string, ContentValue>,
	key: string,
	value: ContentValue,
): void {
	Object.defineProperty(record, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function projectActionResultDiagnosticValue(
	value: unknown,
	redactDiagnosticText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
	budget: ActionResultDiagnosticBudget,
	suppressKeys?: ReadonlySet<string>,
): ContentValue {
	budget.nodes += 1;
	if (budget.nodes > MAX_ACTION_RESULT_DIAGNOSTIC_NODES) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	if (value === undefined || value === null || typeof value === "boolean") {
		return value as ContentValue;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : TOOL_DIAGNOSTIC_MASK;
	}
	if (typeof value === "string") {
		return redactDiagnosticString(value, redactDiagnosticText);
	}
	if (typeof value !== "object" || value === null) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	if (depth >= MAX_ACTION_RESULT_DIAGNOSTIC_DEPTH || seen.has(value)) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		let isArray: boolean;
		try {
			isArray = Array.isArray(value);
		} catch {
			// error-policy:J4 Revoked proxies degrade to an explicit diagnostic mask.
			return TOOL_DIAGNOSTIC_MASK;
		}
		if (isArray) {
			let lengthDescriptor: PropertyDescriptor | undefined;
			try {
				lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
			} catch {
				// error-policy:J4 Hostile proxy traps degrade to a diagnostic mask.
				return TOOL_DIAGNOSTIC_MASK;
			}
			const length = lengthDescriptor?.value;
			if (
				typeof length !== "number" ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_ACTION_RESULT_DIAGNOSTIC_NODES - budget.nodes
			) {
				return TOOL_DIAGNOSTIC_MASK;
			}
			const projected: ContentValue[] = new Array(length);
			for (let index = 0; index < length; index += 1) {
				let descriptor: PropertyDescriptor | undefined;
				try {
					descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				} catch {
					// error-policy:J4 Hostile proxy traps degrade to a diagnostic mask.
					return TOOL_DIAGNOSTIC_MASK;
				}
				budget.nodes += 1;
				if (budget.nodes > MAX_ACTION_RESULT_DIAGNOSTIC_NODES) {
					return TOOL_DIAGNOSTIC_MASK;
				}
				if (!descriptor) continue;
				projected[index] =
					"value" in descriptor
						? projectActionResultDiagnosticValue(
								descriptor.value,
								redactDiagnosticText,
								seen,
								depth + 1,
								budget,
							)
						: TOOL_DIAGNOSTIC_MASK;
			}
			return projected;
		}

		let keys: PropertyKey[];
		try {
			keys = Reflect.ownKeys(value);
		} catch {
			// error-policy:J4 Revoked or hostile proxies degrade to a diagnostic mask.
			return TOOL_DIAGNOSTIC_MASK;
		}
		if (keys.length > MAX_ACTION_RESULT_DIAGNOSTIC_NODES - budget.nodes) {
			return TOOL_DIAGNOSTIC_MASK;
		}
		const record: Record<string, ContentValue> = {};
		for (const key of keys) {
			if (typeof key !== "string") continue;
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(value, key);
			} catch {
				// error-policy:J4 Hostile proxy traps degrade to a diagnostic mask.
				return TOOL_DIAGNOSTIC_MASK;
			}
			if (!descriptor?.enumerable) continue;
			budget.nodes += 1;
			if (budget.nodes > MAX_ACTION_RESULT_DIAGNOSTIC_NODES) {
				return TOOL_DIAGNOSTIC_MASK;
			}
			let projected: ContentValue;
			if (suppressKeys?.has(key)) {
				projected = sensitiveActionResultMarker(
					"value" in descriptor ? descriptor.value : undefined,
					redactDiagnosticText,
					budget,
				);
			} else if (isSensitiveKeyName(key) || !("value" in descriptor)) {
				projected = TOOL_DIAGNOSTIC_MASK;
			} else {
				projected = projectActionResultDiagnosticValue(
					descriptor.value,
					redactDiagnosticText,
					seen,
					depth + 1,
					budget,
				);
			}
			defineDiagnosticProperty(record, key, projected);
		}
		return record;
	} finally {
		seen.delete(value);
	}
}

function actionResultToContentRecord(
	result: ActionResult,
	redactDiagnosticText: ToolDiagnosticTextRedactor,
	options: { suppressData?: boolean } = {},
): Record<string, ContentValue> {
	const projectedResult = projectActionResultDiagnosticValue(
		result,
		redactDiagnosticText,
		new WeakSet<object>(),
		0,
		{ nodes: 0 },
		options.suppressData ? new Set(["data", "values"]) : undefined,
	);
	return isContentRecord(projectedResult) ? projectedResult : {};
}

function sensitiveActionResultMarker(
	value: unknown,
	redactDiagnosticText?: ToolDiagnosticTextRedactor,
	budget?: ActionResultDiagnosticBudget,
): Record<string, ContentValue> {
	let actionName: string | undefined;
	if (value !== null && typeof value === "object") {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(value, "actionName");
			if (
				descriptor &&
				"value" in descriptor &&
				typeof descriptor.value === "string"
			) {
				actionName =
					redactDiagnosticText && budget
						? (redactDiagnosticString(
								descriptor.value,
								redactDiagnosticText,
							) as string)
						: descriptor.value;
			}
		} catch {
			// error-policy:J4 A hostile result degrades to the privacy marker without
			// allowing diagnostics to fail the settled action.
		}
	}
	return {
		...(actionName ? { actionName } : {}),
		suppressed: true,
		reason: "sensitive_action_result",
	};
}

/**
 * A result may opt out per invocation because multi-mode actions only return
 * sensitive data for some operations. Static action metadata remains the
 * stronger default for actions whose every result is sensitive.
 */
export function shouldSuppressActionResultClipboard(
	action: Pick<Action, "suppressActionResultClipboard"> | undefined,
	result: { data?: Readonly<Record<string, unknown>> },
): boolean {
	return (
		action?.suppressActionResultClipboard === true ||
		result.data?.suppressActionResultClipboard === true
	);
}

/**
 * Keep the outcome and intentional user-facing projections while removing the
 * structured payload that must not enter planner prompts or client clipboards.
 */
export function projectActionResultForClipboard(
	action: Pick<Action, "name" | "suppressActionResultClipboard"> | undefined,
	result: ActionResult,
	actionName = action?.name,
): ActionResult {
	if (!shouldSuppressActionResultClipboard(action, result)) {
		return result;
	}

	const resultActionName =
		typeof result.data?.actionName === "string"
			? result.data.actionName
			: undefined;
	const safeActionName = actionName ?? resultActionName;
	const safeControlData = {
		...(safeActionName ? { actionName: safeActionName } : {}),
		...(result.data?.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
		...(result.data?.retryable === false ? { retryable: false } : {}),
		...(result.data?.reconciliationRequired === true
			? { reconciliationRequired: true }
			: {}),
		// Turn-delivery contract, not payload: tells the reply gate this turn's
		// answer already went out (out-of-band ack). Projecting it away
		// re-enabled the evaluator's mimicked ack (live 2026-08-19).
		...(result.data?.suppressPlannerReply === true
			? { suppressPlannerReply: true }
			: {}),
	};
	return {
		success: result.success,
		...(result.text !== undefined ? { text: result.text } : {}),
		...(result.transcriptVisibility !== undefined
			? { transcriptVisibility: result.transcriptVisibility }
			: {}),
		...(result.userFacingText !== undefined
			? { userFacingText: result.userFacingText }
			: {}),
		...(result.verifiedUserFacing !== undefined
			? { verifiedUserFacing: result.verifiedUserFacing }
			: {}),
		...(result.effectReceipts !== undefined
			? { effectReceipts: result.effectReceipts }
			: {}),
		...(result.userFacingEffectReceiptIds !== undefined
			? {
					userFacingEffectReceiptIds: result.userFacingEffectReceiptIds,
				}
			: {}),
		...(result.failureProvenance !== undefined
			? { failureProvenance: result.failureProvenance }
			: {}),
		...(result.replyFailure !== undefined
			? { replyFailure: result.replyFailure }
			: {}),
		...(Object.keys(safeControlData).length > 0
			? { data: safeControlData }
			: {}),
		...(result.turnComplete !== undefined
			? { turnComplete: result.turnComplete }
			: {}),
		...(result.modelReplyRequired !== undefined
			? { modelReplyRequired: result.modelReplyRequired }
			: {}),
		...(result.modelReplyFallback !== undefined
			? { modelReplyFallback: result.modelReplyFallback }
			: {}),
		...(result.continueChain !== undefined
			? { continueChain: result.continueChain }
			: {}),
	};
}

function projectSettledResultForObserver(
	action: Action,
	result: ActionResult,
): ActionResult {
	const projected = projectActionResultForClipboard(
		action,
		result,
		action.name,
	);
	if (action.disclosureGate?.require !== "owner_exclusive") return projected;
	const controlData = {
		actionName: action.name,
		...(result.data?.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
		...(result.data?.retryable === false ? { retryable: false } : {}),
		...(result.data?.reconciliationRequired === true
			? { reconciliationRequired: true }
			: {}),
		// Turn-delivery contract, not payload: tells the reply gate this turn's
		// answer already went out (out-of-band ack). Projecting it away
		// re-enabled the evaluator's mimicked ack (live 2026-08-19).
		...(result.data?.suppressPlannerReply === true
			? { suppressPlannerReply: true }
			: {}),
	};

	return {
		success: projected.success,
		...(projected.effectReceipts !== undefined
			? { effectReceipts: projected.effectReceipts }
			: {}),
		...(projected.failureProvenance !== undefined
			? { failureProvenance: projected.failureProvenance }
			: {}),
		...(projected.replyFailure !== undefined
			? { replyFailure: projected.replyFailure }
			: {}),
		data: controlData,
		...(projected.turnComplete !== undefined
			? { turnComplete: projected.turnComplete }
			: {}),
		...(projected.modelReplyRequired !== undefined
			? { modelReplyRequired: projected.modelReplyRequired }
			: {}),
		...(projected.modelReplyFallback !== undefined
			? { modelReplyFallback: projected.modelReplyFallback }
			: {}),
		...(projected.continueChain !== undefined
			? { continueChain: projected.continueChain }
			: {}),
	};
}

function publishSettledResult(
	runtime: IAgentRuntime,
	action: Action,
	result: ActionResult,
	observer: ((result: ActionResult) => void) | undefined,
): void {
	if (!observer) return;
	try {
		observer(projectSettledResultForObserver(action, result));
	} catch (error) {
		// error-policy:J7 completion observers provide durability bookkeeping;
		// they must remain observable without changing the settled action result.
		try {
			runtime.reportError("ActionSettlementObserver", error, {
				actionName: action.name,
			});
		} catch (reportingError) {
			// error-policy:J7 diagnostics failure is logged locally because the
			// already-settled action result must remain authoritative to callers.
			runtime.logger.error(
				{
					src: "execute-planned-tool-call",
					action: action.name,
					error: stringifyError(error),
					reportingError: stringifyError(reportingError),
				},
				"Action settlement observer and error reporting both failed",
			);
		}
	}
}

function readMetadataString(message: Memory, key: string): string | undefined {
	const metadata = isContentRecord(message.metadata) ? message.metadata : null;
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function runWithMessageTrajectoryContext<T>(
	runtime: IAgentRuntime,
	message: Memory,
	fn: () => Promise<T> | T,
): Promise<T> | T {
	const activeContext = getTrajectoryContext();
	const trajectoryId = readMetadataString(message, "trajectoryId");
	const runId =
		typeof runtime.getCurrentRunId === "function"
			? runtime.getCurrentRunId()
			: undefined;
	if (
		typeof activeContext?.trajectoryStepId === "string" &&
		activeContext.trajectoryStepId.trim().length > 0
	) {
		if (
			trajectoryId &&
			!(
				typeof activeContext.trajectoryId === "string" &&
				activeContext.trajectoryId.trim().length > 0
			)
		) {
			return runWithTrajectoryContext(
				{
					...activeContext,
					trajectoryId,
					...(runId ? { runId } : {}),
					...(message.roomId ? { roomId: message.roomId } : {}),
					...(message.id ? { messageId: message.id } : {}),
				},
				fn,
			);
		}
		return fn();
	}

	const trajectoryStepId = readMetadataString(message, "trajectoryStepId");
	if (!trajectoryStepId) {
		return fn();
	}

	return runWithTrajectoryContext(
		{
			...activeContext,
			...(trajectoryId ? { trajectoryId } : {}),
			trajectoryStepId,
			...(runId ? { runId } : {}),
			...(message.roomId ? { roomId: message.roomId } : {}),
			...(message.id ? { messageId: message.id } : {}),
		},
		fn,
	);
}

export async function executePlannedToolCall(
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
	toolCall: PlannerToolCall | PlannedToolCall,
	options: ExecutePlannedToolCallOptions = {},
): Promise<ActionResult> {
	options.abortSignal?.throwIfAborted();
	// Perf probe (#latency): per-segment wall clock for one executed tool call,
	// logged as a single summary line. Diagnostic only; never alters behavior.
	const perfT0 = Date.now();
	const perfMarks: [string, number][] = [];
	let perfPrev = perfT0;
	const perfMark = (label: string) => {
		const now = Date.now();
		perfMarks.push([label, now - perfPrev]);
		perfPrev = now;
	};
	// Diagnostic projection for every copy of the arguments that leaves the
	// execution path (streaming observers, lifecycle events, trajectories).
	// The handler itself receives the exact validated values.
	const redactDiagnosticText = composeToolDiagnosticRedactor(runtime);
	const action = (options.actions ?? runtime.actions).find(
		(candidate) => candidate.name === toolCall.name,
	);
	if (!action) {
		return emitToolResult(
			toolCall,
			redactDiagnosticText,
			failureResult(
				toolCall.name,
				`Action not found: ${toolCall.name}`,
				{},
				{
					kind: "missing_capability",
					boundary: "capability",
					code: "ACTION_NOT_FOUND",
					retryable: false,
				},
			),
		);
	}

	const resolvedCtx = await withResolvedUserRoles(runtime, ctx);
	// The gate below admits the action under `activeContexts` (the planner
	// executor merges the action's own contexts in); validate() and the
	// handler read the routing state instead, so give them the same view.
	// Identity when nothing is added — deterministic evaluator calls and the
	// ordinary path keep their state object.
	const executorCtx = resolvedCtx.state
		? {
				...resolvedCtx,
				state: withActiveRoutingContexts(
					resolvedCtx.state,
					resolvedCtx.message,
					resolvedCtx.activeContexts,
				),
			}
		: resolvedCtx;
	perfMark("roles");
	const gateFailure = actionGateFailure(action, executorCtx);
	if (gateFailure) {
		return emitToolResult(
			toolCall,
			redactDiagnosticText,
			failureResult(action.name, gateFailure),
		);
	}
	if (action.disclosureGate?.require === "owner_exclusive") {
		const disclosure = await authorizeOwnerExclusiveDisclosure(
			runtime,
			executorCtx.message,
		);
		if (!disclosure.allowed) {
			return emitToolResult(
				toolCall,
				redactDiagnosticText,
				failureResult(
					action.name,
					`Owner-private disclosure denied: ${disclosure.reason}`,
				),
			);
		}
	}

	const normalizedArgs = expandEnumShortForm(
		action,
		flattenUndeclaredParametersEnvelope(action, normalizeToolArgs(toolCall)),
	);
	const argsForValidation = normalizeParamAliases(
		action,
		dropEmptyOptionalArgs(
			action,
			dropUndeclaredPlannerWrapperArgs(action, normalizedArgs),
		),
	);
	// Prompt-side redaction placeholders (matrix F16) resolve ONLY through the
	// per-turn alias capability map (#20091): aliases the composed state proves
	// redaction emitted, on an owner-authorized turn, with values derived from
	// canonical owner resolution — never an ambient getSetting keyed by
	// model-authored text. Recorded tool calls keep the placeholder; this
	// transforms only the executed-args copy.
	const entityAliases =
		executorCtx.entityAliases ??
		(await buildTurnEntityAliases(
			runtime,
			executorCtx.message,
			executorCtx.state,
			executorCtx.userRoles,
		));
	perfMark("aliases");
	const validation = validateToolArgs(
		action,
		resolveEntityAliasRefs(entityAliases, argsForValidation),
	);
	if (!validation.valid) {
		// The planner correlates a corrected retry with this failed operation by
		// removing only arguments the schema rejected. Keeping this structural
		// metadata at the validation boundary avoids parsing error prose and keeps
		// unrelated calls to the same action distinct.
		const invalidParameterNames = validation.invalidParameterNames ?? [];
		return emitToolResult(
			toolCall,
			redactDiagnosticText,
			failureResult(
				action.name,
				validation.errors.join("; ") ||
					`Invalid arguments for action ${action.name}`,
				{
					parameterErrors: validation.errors,
					...(invalidParameterNames.length > 0
						? { invalidParameterNames }
						: {}),
				},
			),
		);
	}
	const previousResults = [...(executorCtx.previousResults ?? [])];
	const parameters =
		action.parameters && action.parameters.length > 0
			? (validation.args as ActionParameters | undefined)
			: undefined;
	const {
		actions: _scopedActions,
		onSettledResult,
		...handlerOptionOverrides
	} = options;
	const handlerOptions: HandlerOptions = {
		...handlerOptionOverrides,
		parameters,
		parameterErrors: undefined,
		actionContext: options.actionContext ?? {
			previousResults,
			getPreviousResult: (actionName: string) =>
				previousResults.find(
					(result) => result.data?.actionName === actionName,
				),
		},
	};

	if (action.validate) {
		let valid = false;
		try {
			valid = await action.validate(
				runtime,
				executorCtx.message,
				executorCtx.state,
				handlerOptions,
			);
		} catch (error) {
			// error-policy:J1 Tool validation failures are translated into the
			// planner-visible failed tool result with the original error attached.
			return emitToolResult(
				toolCall,
				redactDiagnosticText,
				failureResult(
					action.name,
					stringifyError(error),
					{ error },
					{
						kind: "handler_error",
						boundary: "handler",
						code: "ACTION_VALIDATION_FAILED",
						retryable: true,
					},
				),
			);
		}
		if (!valid) {
			return emitToolResult(
				toolCall,
				redactDiagnosticText,
				failureResult(
					action.name,
					`Action ${action.name} is not available for the current state`,
					{},
					{
						kind: "missing_capability",
						boundary: "capability",
						code: "ACTION_UNAVAILABLE",
						retryable: false,
					},
				),
			);
		}
	}

	perfMark("validate");
	const accountPolicy = await evaluateConnectorAccountPolicies(
		runtime,
		action,
		{
			message: executorCtx.message,
			parameters: validation.args as Record<string, unknown>,
		},
	);
	if (!accountPolicy.allowed) {
		return emitToolResult(
			toolCall,
			redactDiagnosticText,
			failureResult(
				action.name,
				accountPolicy.reason ??
					`Action ${action.name} is not allowed for the selected connector account`,
			),
		);
	}
	perfMark("accountPolicy");
	options.abortSignal?.throwIfAborted();

	const messageId = executorCtx.message.id as UUID | undefined;
	const roomId = executorCtx.message.roomId as UUID;
	let actionEventWorldId: Promise<UUID> | undefined;
	const getActionEventWorldId = () => {
		actionEventWorldId ??= resolveActionEventWorldId(
			runtime,
			executorCtx.message,
			"ExecutePlannedToolCall.resolveActionEventWorldId",
		);
		return actionEventWorldId;
	};
	const actionStartContent = {
		text: `Executing action: ${action.name}`,
		actions: [action.name],
		actionStatus: "executing" as const,
		source: executorCtx.message.content.source,
	};
	// ACTION_STARTED is a lifecycle notification. Its dispatch runs alongside
	// the handler instead of in front of it (live: 30-145 ms of subscriber
	// work per tool call before the handler could begin); ACTION_COMPLETED
	// below awaits this dispatch first, so subscribers still observe the two
	// events settle in order.
	let actionStartedDispatch: Promise<void> = Promise.resolve();
	if (typeof runtime.emitEvent === "function") {
		const worldId = await getActionEventWorldId();
		actionStartedDispatch = runtime
			.emitEvent(EventType.ACTION_STARTED, {
				runtime,
				...(messageId ? { messageId } : {}),
				roomId,
				world: worldId,
				content: actionStartContent,
			})
			.catch((err) => {
				// error-policy:J7 Lifecycle events are diagnostics; a broken observer
				// cannot block tool execution but remains visible to the runtime.
				runtime.reportError("ExecutePlannedToolCall.emitEvent", err, {
					action: action.name,
					eventType: EventType.ACTION_STARTED,
				});
				runtime.logger.warn(
					{
						src: "execute-planned-tool-call",
						action: action.name,
						eventType: EventType.ACTION_STARTED,
						err: err instanceof Error ? err.message : String(err),
					},
					"emitEvent failed",
				);
			});
	}

	const ownerExclusive = action.disclosureGate?.require === "owner_exclusive";
	const protectedCallback =
		ownerExclusive && executorCtx.callback
			? async (
					...callbackArgs: Parameters<NonNullable<typeof executorCtx.callback>>
				) => {
					const disclosure = await revalidateOwnerExclusiveDisclosure(
						runtime,
						executorCtx.message,
					);
					if (disclosure.allowed) {
						return executorCtx.callback?.(...callbackArgs) ?? [];
					}
					return (
						executorCtx.callback?.(
							{
								text: PRIVACY_DENIED_TEXT,
								actions: ["PRIVACY_DENIED"],
								data: {
									privacyDenied: true,
									privacyReason: disclosure.reason,
								},
							},
							"PRIVACY_DENIED",
						) ?? []
					);
				}
			: executorCtx.callback;
	perfMark("startedEvent");
	let resultForEvent = await runWithMessageTrajectoryContext(
		runtime,
		executorCtx.message,
		() =>
			withActionStep(
				runtime,
				action.name,
				() =>
					settleActionHandler({
						runtime,
						action,
						callback: protectedCallback,
						invoke: async (actionCallback) => {
							options.abortSignal?.throwIfAborted();
							// Egress (#10469): this is the true execution boundary. Restore real
							// secrets into the handler args ONLY here — the model, transcripts, logs,
							// and trajectory upstream kept the placeholders. Fail loud if the model
							// emitted a this-turn placeholder we cannot resolve, so a placeholder is
							// never sent to a real command/connector/endpoint. No-op (and zero cost)
							// when secret-swap is disabled: there is no turn session on the context.
							const secretSwapSession =
								getTrajectoryContext()?.secretSwapSession;
							if (
								secretSwapSession &&
								handlerOptions.parameters !== undefined
							) {
								handlerOptions.parameters = secretSwapSession.restoreInValue(
									handlerOptions.parameters,
									{ failOnUnresolved: true },
								);
							}
							// Egress (#10469 / #7007): restore real named-entity PII here too —
							// including the REPLY action's own text, so the tool call runs against the
							// real recipient and the user sees their real contacts, while the model,
							// trajectory, and logs kept the surrogates. Best-effort (no failOnUnresolved):
							// a surrogate the model rewrote, or a genuinely new name it introduced, is
							// simply left as-is.
							const piiSwapSession = getTrajectoryContext()?.piiSwapSession;
							if (piiSwapSession && handlerOptions.parameters !== undefined) {
								handlerOptions.parameters = piiSwapSession.restoreInValue(
									handlerOptions.parameters,
								);
							}
							const routingContext = {
								actionName: action.name,
								modelClass: action.modelClass,
								replyOwner: action.suppressActionResultClipboard
									? undefined
									: executorCtx.replyOwner,
								messageId: executorCtx.message.id,
							};
							try {
								return await runWithActionRoutingContext(routingContext, () =>
									action.handler(
										runtime,
										executorCtx.message,
										executorCtx.state,
										handlerOptions,
										actionCallback,
										executorCtx.responses,
									),
								);
							} finally {
								// Detached work cannot hand a reply to an already-settled action.
								routingContext.replyOwner = undefined;
							}
						},
					}),
				{
					// Raw here by design: completeActionTrajectoryStep owns the
					// diagnostic projection for every settlement, so the handler-adjacent
					// copy stays exact and the egress copy is projected once.
					parameters: isContentRecord(validation.args) ? validation.args : {},
					projectResult: (result) =>
						projectSettledResultForObserver(action, result),
				},
			),
	);
	// The handler result is the completion barrier. Publish it before event
	// emission or disclosure revalidation can strand a committed side effect.
	perfMark("handler");
	publishSettledResult(runtime, action, resultForEvent, onSettledResult);
	if (ownerExclusive) {
		const disclosure = await revalidateOwnerExclusiveDisclosure(
			runtime,
			executorCtx.message,
		);
		if (!disclosure.allowed) {
			resultForEvent = failureResult(action.name, PRIVACY_DENIED_TEXT, {
				privacyDenied: true,
				privacyReason: disclosure.reason,
			});
		}
	}
	const suppressActionResult = shouldSuppressActionResultClipboard(
		action,
		resultForEvent,
	);

	if (typeof runtime.emitEvent === "function") {
		const worldId = await getActionEventWorldId();
		await actionStartedDispatch;
		await runtime
			.emitEvent(EventType.ACTION_COMPLETED, {
				runtime,
				...(messageId ? { messageId } : {}),
				roomId,
				world: worldId,
				content: {
					text: redactDiagnosticText(
						resultForEvent.text ?? `Action ${action.name} completed`,
					),
					actions: [action.name],
					actionStatus: resultForEvent.success ? "completed" : "failed",
					actionResult: actionResultToContentRecord(
						resultForEvent,
						redactDiagnosticText,
						{
							suppressData: suppressActionResult,
						},
					),
					source: executorCtx.message.content.source,
					error:
						typeof resultForEvent.error === "string"
							? redactDiagnosticText(resultForEvent.error)
							: undefined,
				},
			})
			.catch((err) => {
				// error-policy:J7 The settled action result is authoritative; report a
				// failed completion event without rewriting the tool outcome.
				runtime.reportError("ExecutePlannedToolCall.emitEvent", err, {
					action: action.name,
					eventType: EventType.ACTION_COMPLETED,
				});
				runtime.logger.warn(
					{
						src: "execute-planned-tool-call",
						action: action.name,
						eventType: EventType.ACTION_COMPLETED,
						err: err instanceof Error ? err.message : String(err),
					},
					"emitEvent failed",
				);
			});
	}
	if (ownerExclusive) {
		const disclosure = await revalidateOwnerExclusiveDisclosure(
			runtime,
			executorCtx.message,
		);
		if (!disclosure.allowed) {
			resultForEvent = failureResult(action.name, PRIVACY_DENIED_TEXT, {
				privacyDenied: true,
				privacyReason: disclosure.reason,
			});
		}
	}
	perfMark("post");
	{
		const perfTotal = Date.now() - perfT0;
		if (perfTotal > 400) {
			runtime.logger.info(
				{ src: "execute-planned-tool-call" },
				`[perf-probe] tool=${action.name} total=${perfTotal}ms ${perfMarks
					.filter(([, ms]) => ms >= 5)
					.map(([label, ms]) => `${label}=${ms}ms`)
					.join(" ")}`,
			);
		}
	}
	return emitToolResult(toolCall, redactDiagnosticText, resultForEvent, {
		suppressData: suppressActionResult,
	});
}

async function emitToolResult(
	toolCall: PlannerToolCall | PlannedToolCall,
	redactDiagnosticText: ToolDiagnosticTextRedactor,
	result: ActionResult,
	options: { suppressData?: boolean } = {},
): Promise<ActionResult> {
	const streamingContext = getStreamingContext();
	const status = result.success ? "completed" : "failed";
	const streamingToolCall = plannedToolCallToStreamingToolCall(
		toolCall,
		status,
		redactDiagnosticText,
	);
	streamingToolCall.result = actionResultToStreamingResult(
		result,
		redactDiagnosticText,
		options,
	);
	await emitStreamingHook(streamingContext, "onToolResult", {
		toolCall: streamingToolCall,
		toolCallId: streamingToolCall.id,
		result: streamingToolCall.result,
		status,
		...(streamingContext?.messageId
			? { messageId: streamingContext.messageId }
			: {}),
	});
	return result;
}

async function withResolvedUserRoles(
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
): Promise<ExecutePlannedToolCallContext> {
	if (ctx.userRoles?.length) {
		return ctx;
	}
	return {
		...ctx,
		userRoles: await resolveToolCallUserRoles(runtime, ctx.message),
	};
}

async function resolveToolCallUserRoles(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleGateRole[]> {
	if (
		typeof message.entityId === "string" &&
		message.entityId === runtime.agentId
	) {
		return ["OWNER"];
	}

	try {
		const result = await checkSenderRole(runtime, message);
		if (result?.role) {
			return [result.role as RoleGateRole];
		}
	} catch (error) {
		// error-policy:J2 A role-store failure cannot be converted into a role
		// because doing so would authorize actions without canonical evidence.
		throw new ElizaError("Failed to resolve the tool caller's role", {
			code: "ACTION_CALLER_ROLE_LOOKUP_FAILED",
			cause: error,
			context: {
				messageId: message.id,
				roomId: message.roomId,
				entityId: message.entityId,
			},
		});
	}

	// A missing canonical room/world is not evidence of an authenticated user.
	// GUEST is the non-authorizing floor for actions that require USER or above.
	return ["GUEST"];
}

function plannedToolCallToStreamingToolCall(
	toolCall: PlannerToolCall | PlannedToolCall,
	status: "completed" | "failed",
	redactDiagnosticText: ToolDiagnosticTextRedactor,
): ToolCall {
	// The raw call id/name survive for correlation with the pending-phase
	// stream event; argument values are projected because stream observers are
	// a diagnostic surface, not the execution path.
	return {
		id: toolCall.id ?? toolCall.name,
		name: toolCall.name,
		arguments: (projectToolDiagnosticArgs(
			normalizeToolArgs(toolCall),
			redactDiagnosticText,
		) ?? {}) as ToolCall["arguments"],
		status,
	};
}

function actionResultToStreamingResult(
	result: ActionResult,
	redactDiagnosticText: ToolDiagnosticTextRedactor,
	options: { suppressData?: boolean } = {},
): ToolCall["result"] {
	const streamingResult: ActionResult = {
		success: result.success,
		text: result.text,
		userFacingText: result.userFacingText,
		verifiedUserFacing: result.verifiedUserFacing,
		effectReceipts: result.effectReceipts,
		replyFailure: result.replyFailure,
		userFacingEffectReceiptIds: result.userFacingEffectReceiptIds,
		error: result.error ? stringifyError(result.error) : undefined,
		data: options.suppressData
			? sensitiveActionResultMarker(result.data)
			: result.data,
		values:
			options.suppressData && result.values !== undefined
				? sensitiveActionResultMarker(result.values)
				: result.values,
		turnComplete: result.turnComplete,
		modelReplyRequired: result.modelReplyRequired,
		modelReplyFallback: result.modelReplyFallback,
		continueChain: result.continueChain,
	};
	return actionResultToContentRecord(streamingResult, redactDiagnosticText);
}

export const _resetActionRolePolicyCacheForTests = _resetCacheForTests;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Recover the hybrid native-call shape weak models produce after copying the
 * plain-JSON planner envelope into a tool's argument object. The unwrap is
 * intentionally schema-bounded: a real `parameters` field, an unknown nested
 * key, or a conflicting duplicate stays untouched so strict validation still
 * surfaces the malformed call instead of guessing at intent.
 */
function flattenUndeclaredParametersEnvelope(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const declaredParameters = action.parameters ?? [];
	if (declaredParameters.some((parameter) => parameter.name === "parameters")) {
		return args;
	}

	const nested = args.parameters;
	if (!isPlainRecord(nested)) return args;

	const declaredNames = new Set(
		declaredParameters.map((parameter) => parameter.name),
	);
	const nestedEntries = Object.entries(nested);
	if (nestedEntries.some(([key]) => !declaredNames.has(key))) return args;
	if (
		nestedEntries.some(
			([key, value]) =>
				Object.hasOwn(args, key) && !Object.is(args[key], value),
		)
	) {
		return args;
	}

	const { parameters: _parameters, ...outerArgs } = args;
	return { ...nested, ...outerArgs };
}

/**
 * Short-form enum completion. When the action has a single closed-enum
 * parameter, accept three input shapes from the planner:
 *
 *   1. canonical:        `{ <paramName>: "<enum_value>" }`
 *   2. bare-string:      `"<enum_value>"`  (the entire args is the string)
 *   3. dispatch-shape:   `{ action: <name>, parameters: "<enum_value>" }`
 *
 * Shapes 2 and 3 are expanded into shape 1 here so `validateToolArgs` sees
 * the full JSON-schema shape and strict validation is unchanged. Anything
 * else flows through untouched — including planner emissions that don't
 * match an enum value, which are then caught by `validateToolArgs` and
 * surfaced as a normal failure.
 *
 * No-op when the action doesn't fit the single-enum-parameter pattern or when
 * the input doesn't look like a short-form emission.
 */
export function expandEnumShortForm(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const parameters = action.parameters ?? [];
	if (parameters.length !== 1) return args;
	const param = parameters[0];
	if (!param) return args;
	const schema = param.schema as {
		enumValues?: unknown[];
		enum?: unknown[];
	};
	const enumValues = schema.enumValues ?? schema.enum;
	if (!Array.isArray(enumValues) || enumValues.length === 0) return args;
	const validValues = new Set(
		enumValues
			.filter(
				(value): value is string | number | boolean =>
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean",
			)
			.map((value) => String(value)),
	);
	if (validValues.size === 0) return args;

	// Shape 1: already the canonical shape — nothing to do.
	if (
		typeof args[param.name] === "string" ||
		typeof args[param.name] === "number" ||
		typeof args[param.name] === "boolean"
	) {
		return args;
	}

	// Shape 3: `{ parameters: "<enum_value>" }` — the planner used the
	// PLAN_ACTIONS dispatch envelope with a bare string in `parameters`.
	// Drop the original `parameters` key after expansion so strict
	// validation (which forbids unknown fields when `additionalProperties`
	// is false) doesn't reject the now-canonical args.
	if (
		"parameters" in args &&
		(typeof args.parameters === "string" ||
			typeof args.parameters === "number" ||
			typeof args.parameters === "boolean") &&
		validValues.has(String(args.parameters))
	) {
		const { parameters: shortFormValue, ...rest } = args;
		return { ...rest, [param.name]: shortFormValue };
	}

	return args;
}

/**
 * Treat an empty-string value as omitted only when an OPTIONAL parameter
 * explicitly declares that model omission sentinel.
 *
 * Some strict provider schemas force the model to emit every key. Actions that
 * observed `""` as the provider's unset representation opt in through
 * `modelOmissionSentinels`; other actions may use an empty string as legitimate
 * data and must receive it byte-for-byte. Required parameters are always left
 * untouched so an empty required value still fails loudly.
 */
export function dropEmptyOptionalArgs(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	// Strict provider schemas can force placeholder values for every property.
	// Non-strict polymorphic tools preserve optional empty strings because the
	// resolved child contract may define "" as an intentional mutation.
	if (action.toolSchemaStrict === false) return args;

	let filtered: Record<string, unknown> | undefined;
	for (const parameter of action.parameters ?? []) {
		if (parameter.required === true) continue;
		if (
			args[parameter.name] === "" &&
			parameter.modelOmissionSentinels?.includes("")
		) {
			filtered ??= { ...args };
			delete filtered[parameter.name];
		}
	}
	return filtered ?? args;
}

const PLANNER_WRAPPER_ONLY_ARG_KEYS = new Set(["subaction", "thought"]);
const PLANNER_DISCRIMINATOR_ALIASES = ["action", "op", "operation"] as const;

function dropUndeclaredPlannerWrapperArgs(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	let filtered: Record<string, unknown> | undefined;
	const declaredParameters = action.parameters ?? [];

	for (const key of Object.keys(args)) {
		if (
			PLANNER_WRAPPER_ONLY_ARG_KEYS.has(key) &&
			!declaredParameters.some((parameter) => parameter.name === key)
		) {
			filtered ??= { ...args };
			if (key === "subaction" && typeof args.subaction === "string") {
				const target = declaredParameters.find((parameter) => {
					if (
						!PLANNER_DISCRIMINATOR_ALIASES.includes(
							parameter.name as (typeof PLANNER_DISCRIMINATOR_ALIASES)[number],
						)
					) {
						return false;
					}
					const schema = parameter.schema as {
						enumValues?: unknown[];
						enum?: unknown[];
					};
					const enumValues = schema.enumValues ?? schema.enum;
					return (
						!Array.isArray(enumValues) || enumValues.includes(args.subaction)
					);
				});
				if (target && filtered[target.name] === undefined) {
					filtered[target.name] = args.subaction;
					delete filtered[key];
					continue;
				}
				if (
					target &&
					filtered[target.name] !== undefined &&
					filtered[target.name] !== args.subaction
				) {
					continue;
				}
			}
			delete filtered[key];
		}
	}

	return filtered ?? args;
}

/**
 * Rename an incoming arg key to the declared parameter that claims it via its
 * `aliases` list, so the planner isn't punished for a natural name variant
 * (`to`/`recipient` for `target`, `description`/`prompt` for `instructions`,
 * `scheduledFor` for `scheduledAtIso`). This is the same curated,
 * structurally-gated remap the sibling `dropUndeclaredPlannerWrapperArgs`
 * already performs for the `subaction`→discriminator shape.
 *
 * SAFETY: only renames a key to a declared param that explicitly claims it, and
 * only when (a) that param is absent from args, (b) the key is not itself a
 * declared param, and (c) exactly one declared param claims the key. Any arg no
 * param's `aliases` claims flows through untouched and still hits
 * `Unexpected argument` in `validateToolArgs` — the runaway-arg bound and its
 * tests are unaffected. Never clobbers an explicitly-provided canonical value.
 */
export function normalizeParamAliases(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const parameters = action.parameters ?? [];
	const hasAliases = parameters.some((p) => p.aliases && p.aliases.length > 0);
	if (!hasAliases) return args;

	const declaredNames = new Set(parameters.map((p) => p.name));
	let renamed: Record<string, unknown> | undefined;

	for (const key of Object.keys(args)) {
		if (declaredNames.has(key)) continue; // key is itself a real param
		const claimants = parameters.filter((p) => p.aliases?.includes(key));
		if (claimants.length !== 1) continue; // unknown, or ambiguous → let it reject
		const target = claimants[0].name;
		// Don't overwrite a canonical value the planner already provided.
		const current = (renamed ?? args)[target];
		if (current !== undefined && current !== null) continue;
		renamed ??= { ...args };
		renamed[target] = renamed[key];
		delete renamed[key];
	}

	return renamed ?? args;
}

function normalizeToolArgs(
	toolCall: PlannerToolCall | PlannedToolCall,
): Record<string, unknown> {
	const raw =
		"params" in toolCall && toolCall.params !== undefined
			? toolCall.params
			: "args" in toolCall && toolCall.args !== undefined
				? toolCall.args
				: "arguments" in toolCall
					? toolCall.arguments
					: undefined;

	if (typeof raw === "string") {
		return parseJsonObject<Record<string, unknown>>(raw) ?? {};
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return {};
}
