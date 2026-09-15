/**
 * Settles action handlers before any callback can reach a user-facing transport.
 * The boundary normalizes the returned ActionResult, validates effect receipts,
 * binds exact canonical text to those receipts, and keeps delivery failures
 * separate from handler failures so committed mutations are never retried. It
 * also detaches ambient model tokens across both handler execution and deferred
 * callback delivery; actions expose content through their typed callback only.
 */

import { ElizaError } from "../errors";
import { runWithSuppressedModelStream } from "../streaming-context";
import type {
	Action,
	ActionResult,
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "../types";
import {
	type ActionFailureProvenance,
	normalizeActionFailureProvenance,
	readActionFailureProvenance,
} from "../types/action-failure";
import {
	applyGroundedActionReply,
	normalizeActionReplyFailure,
} from "../types/action-reply";
import {
	normalizeEffectReceipts,
	normalizeUserFacingEffectReceiptIds,
	resolveAppliedUserFacingEffectReceipts,
	resolveUserFacingEffectReceipts,
	tagsMayProduceEffects,
	tagsRequireEffectReceipts,
} from "../types/effects";
import {
	isProviderContextOverflowFailure,
	PROVIDER_CONTEXT_OVERFLOW,
} from "../utils/model-errors";
import { bindEffectDelivery } from "./effect-delivery";

type BufferedActionCallback = {
	response: Content;
	actionName?: string;
};

type SettlementPhase = "pending" | "settled" | "failed";

/** Inputs for one isolated handler attempt and its user-facing callback. */
export interface SettleActionHandlerOptions {
	runtime: IAgentRuntime;
	action: Action;
	callback?: HandlerCallback;
	invoke: (callback?: HandlerCallback) => unknown | Promise<unknown>;
	/**
	 * Retry-owning callers need the original exception. Top-level executors use
	 * a normalized failure result so planner loops can reason about the failure.
	 */
	handlerError?: "return-failure" | "rethrow";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidActionResult(message: string): never {
	throw new ElizaError(message, {
		code: "INVALID_ACTION_RESULT",
		severity: "fatal",
	});
}

/** Preserve an action's canonical do-not-paraphrase reply at every later
 * delivery gate, but only when the callback text matches it byte-for-byte
 * after the transport's ordinary edge trimming. */
function markCanonicalCallback(
	response: Content,
	result: ActionResult,
): Content {
	const canonical = result.userFacingText?.trim();
	const callbackText = response.text?.trim();
	if (
		result.verifiedUserFacing !== true ||
		!canonical ||
		callbackText !== canonical
	) {
		return response;
	}
	return { ...response, agentVoiced: true };
}

/** Convert legacy handler returns into the canonical ActionResult shape. */
export function normalizeActionResult(
	actionName: string,
	result: unknown,
): ActionResult {
	if (result === undefined || result === null || typeof result === "boolean") {
		return {
			success: result !== false,
			data: { actionName },
		};
	}
	if (!isObjectRecord(result)) {
		if (result instanceof Error || typeof result === "object") {
			return invalidActionResult(
				"Action handlers must return a plain ActionResult object, boolean, primitive text, null, or undefined.",
			);
		}
		return {
			success: true,
			text: String(result),
			data: { actionName },
		};
	}

	const rawResult = result as unknown as ActionResult;
	if ("success" in rawResult && typeof rawResult.success !== "boolean") {
		return invalidActionResult(
			"ActionResult.success must be a boolean when present.",
		);
	}
	const resultData = isObjectRecord(rawResult.data) ? rawResult.data : {};
	const effectReceipts =
		rawResult.effectReceipts === undefined
			? undefined
			: normalizeEffectReceipts(rawResult.effectReceipts);
	const userFacingEffectReceiptIds =
		rawResult.userFacingEffectReceiptIds === undefined
			? undefined
			: normalizeUserFacingEffectReceiptIds(
					rawResult.userFacingEffectReceiptIds,
				);
	const failureProvenance =
		rawResult.failureProvenance === undefined
			? undefined
			: normalizeActionFailureProvenance(rawResult.failureProvenance);
	if (rawResult.success !== false && failureProvenance !== undefined) {
		return invalidActionResult(
			"Successful ActionResult values cannot carry failureProvenance.",
		);
	}

	const normalized: ActionResult = {
		...rawResult,
		success: "success" in rawResult ? rawResult.success : true,
		...(effectReceipts !== undefined ? { effectReceipts } : {}),
		...(userFacingEffectReceiptIds !== undefined
			? { userFacingEffectReceiptIds }
			: {}),
		...(failureProvenance !== undefined ? { failureProvenance } : {}),
		data: {
			...resultData,
			// The executor, not an action-owned payload, is authoritative about
			// which registered action produced this result.
			actionName,
		},
	};
	return rawResult.replyFailure === undefined
		? normalized
		: applyGroundedActionReply(normalized, {
				kind: "unavailable",
				failure: normalizeActionReplyFailure(rawResult.replyFailure),
			});
}

/** Build a planner-visible failure while retaining the trusted action identity. */
export function actionFailureResult(
	actionName: string,
	message: string,
	extraData: Record<string, unknown> = {},
	failureProvenance?: ActionFailureProvenance,
): ActionResult {
	return {
		success: false,
		text: message,
		error: message,
		...(failureProvenance ? { failureProvenance } : {}),
		data: {
			...extraData,
			actionName,
		},
	};
}

/** Preserve Error messages while making non-Error throws planner-visible. */
export function stringifyActionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function deliverSettledCallback(args: {
	runtime: IAgentRuntime;
	action: Action;
	result: ActionResult;
	callback: HandlerCallback;
	buffered: BufferedActionCallback;
	deliveredKeys: Set<string>;
	effectContractDeclared: boolean;
}): Promise<Memory[]> {
	const mutationContractActive =
		args.effectContractDeclared ||
		(args.result.success !== false &&
			tagsRequireEffectReceipts(args.action.tags));
	if (!mutationContractActive) {
		const { effectReceiptIds: _untrustedReceiptIds, ...response } =
			args.buffered.response;
		return args.callback(
			markCanonicalCallback(response, args.result),
			args.buffered.actionName ?? args.action.name,
		);
	}

	const boundReceipts = resolveUserFacingEffectReceipts(args.result);
	const appliedReceipts = resolveAppliedUserFacingEffectReceipts(args.result);
	const expectedText = args.result.userFacingText?.trim();
	const callbackText = args.buffered.response.text?.trim();
	if (!boundReceipts || !expectedText || callbackText !== expectedText) {
		args.runtime.logger.warn(
			{
				src: "action-handler-settlement",
				action: args.action.name,
				callbackText,
				hasBoundReceipts: boundReceipts !== null,
			},
			"Suppressed an action callback that was not bound to canonical effect receipts",
		);
		return [];
	}

	const receiptIds = boundReceipts.map((receipt) => receipt.receiptId);
	const deliveryKey = JSON.stringify([
		args.buffered.actionName ?? args.action.name,
		expectedText,
		receiptIds,
	]);
	if (args.deliveredKeys.has(deliveryKey)) return [];
	args.deliveredKeys.add(deliveryKey);
	return args.callback(
		bindEffectDelivery(
			markCanonicalCallback(
				{
					...args.buffered.response,
					effectReceiptIds: receiptIds,
				},
				args.result,
			),
			expectedText,
			receiptIds,
			appliedReceipts !== null,
		),
		args.buffered.actionName ?? args.action.name,
	);
}

function reportCallbackDeliveryFailure(
	runtime: IAgentRuntime,
	action: Action,
	result: ActionResult,
	error: unknown,
): void {
	const message = stringifyActionError(error);
	if (typeof runtime.reportError === "function") {
		try {
			runtime.reportError("ActionCallbackDelivery", error, {
				actionName: action.name,
				effectReceiptIds:
					result.effectReceipts?.map((receipt) => receipt.receiptId) ?? [],
			});
			return;
		} catch (reportingError) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — unusual test
			// doubles may violate reportError's no-throw contract.
			runtime.logger.error(
				{
					src: "action-handler-settlement",
					action: action.name,
					error: message,
					reportingError: stringifyActionError(reportingError),
				},
				"Action callback delivery and error reporting both failed",
			);
			return;
		}
	}
	runtime.logger.error(
		{
			src: "action-handler-settlement",
			action: action.name,
			error: message,
		},
		"Action callback delivery failed after the handler settled",
	);
}

/**
 * Run one handler with a per-attempt callback buffer. Each invocation owns its
 * buffer, so a failed retry attempt can never leak callbacks into a later one.
 */
export async function settleActionHandler(
	options: SettleActionHandlerOptions,
): Promise<ActionResult> {
	const bufferedCallbacks: BufferedActionCallback[] = [];
	const deliveredCallbackKeys = new Set<string>();
	const callbackDeliveryFailures: string[] = [];
	let phase: SettlementPhase = "pending";
	let settledResult: ActionResult | undefined;
	let effectContractDeclared = false;

	const deliverSafely = async (
		buffered: BufferedActionCallback,
	): Promise<Memory[]> => {
		if (
			!options.callback ||
			!settledResult ||
			phase !== "settled" ||
			settledResult.replyFailure
		)
			return [];
		try {
			return await deliverSettledCallback({
				runtime: options.runtime,
				action: options.action,
				result: settledResult,
				callback: options.callback,
				buffered,
				deliveredKeys: deliveredCallbackKeys,
				effectContractDeclared,
			});
		} catch (error) {
			// error-policy:J1 callback delivery is a transport boundary. The
			// committed handler result remains authoritative and observable.
			callbackDeliveryFailures.push(stringifyActionError(error));
			reportCallbackDeliveryFailure(
				options.runtime,
				options.action,
				settledResult,
				error,
			);
			return [];
		}
	};
	const deliverWithoutModelStream = (buffered: BufferedActionCallback) =>
		runWithSuppressedModelStream(() => deliverSafely(buffered));

	const actionCallback: HandlerCallback | undefined = options.callback
		? async (response, actionName) => {
				const buffered = { response, actionName };
				if (phase === "pending") {
					bufferedCallbacks.push(buffered);
					// Waiting here would deadlock handlers that await their callback:
					// delivery is intentionally deferred until the handler returns.
					return [];
				}
				if (phase === "failed") {
					options.runtime.logger.warn(
						{
							src: "action-handler-settlement",
							action: options.action.name,
						},
						"Suppressed an action callback because the handler boundary failed",
					);
					return [];
				}
				return deliverWithoutModelStream(buffered);
			}
		: undefined;

	let rawResult: unknown;
	try {
		rawResult = await runWithSuppressedModelStream(() =>
			options.invoke(actionCallback),
		);
	} catch (error) {
		// error-policy:J1 this boundary either translates the failure for a planner
		// or suppresses callbacks before returning it to a retry-owning caller.
		phase = "failed";
		bufferedCallbacks.length = 0;
		if (options.handlerError === "rethrow") {
			throw error;
		}
		const contextOverflow = isProviderContextOverflowFailure(error);
		const failureProvenance = contextOverflow
			? ({
					kind: "handler_error",
					boundary: "handler",
					code: PROVIDER_CONTEXT_OVERFLOW,
					retryable: false,
				} satisfies ActionFailureProvenance)
			: (readActionFailureProvenance(error) ??
				({
					kind: "handler_error",
					boundary: "handler",
					code: "ACTION_HANDLER_FAILED",
					retryable: true,
				} satisfies ActionFailureProvenance));
		return actionFailureResult(
			options.action.name,
			stringifyActionError(error),
			{ error, ...(contextOverflow ? { retryable: false } : {}) },
			failureProvenance,
		);
	}
	if (isObjectRecord(rawResult)) {
		effectContractDeclared =
			"effectReceipts" in rawResult ||
			"userFacingEffectReceiptIds" in rawResult;
	}
	try {
		settledResult = normalizeActionResult(options.action.name, rawResult);
		if (
			settledResult.success !== false &&
			tagsMayProduceEffects(options.action.tags) &&
			!effectContractDeclared &&
			!tagsRequireEffectReceipts(options.action.tags)
		) {
			options.runtime.logger.warn(
				{
					src: "action-handler-settlement",
					action: options.action.name,
				},
				"Mutation-capable action has not migrated to the effect receipt contract",
			);
		}
		phase = "settled";
	} catch (cause) {
		// error-policy:J1 The handler already returned, so a provider mutation may
		// have committed. Result-contract failures are terminal reconciliation
		// states and must never enter a handler retry loop.
		phase = "failed";
		bufferedCallbacks.length = 0;
		const error = new ElizaError(
			"Action completed with an invalid result. Its external outcome is unknown and must be reconciled before retrying.",
			{
				code: "ACTION_RESULT_INVALID_AFTER_HANDLER",
				cause,
				context: {
					actionName: options.action.name,
					effectContractDeclared,
					retryable: false,
				},
				severity: "fatal",
			},
		);
		if (options.handlerError === "rethrow") {
			throw error;
		}
		return actionFailureResult(
			options.action.name,
			error.message,
			{
				error,
				outcomeUnknown: true,
				retryable: false,
				reconciliationRequired: true,
			},
			{
				kind: "handler_error",
				boundary: "handler",
				code: "ACTION_RESULT_INVALID_AFTER_HANDLER",
				retryable: false,
			},
		);
	}

	// No action-owned prose is an acceptable substitute for unavailable model
	// presentation. Keep the settled effect and let the turn emit system status.
	if (settledResult.replyFailure) bufferedCallbacks.length = 0;
	for (const buffered of bufferedCallbacks) {
		await deliverWithoutModelStream(buffered);
	}
	if (callbackDeliveryFailures.length > 0) {
		settledResult = {
			...settledResult,
			data: {
				...(settledResult.data ?? {}),
				callbackDeliveryFailures,
				actionName: options.action.name,
			},
		};
	}
	return settledResult;
}
