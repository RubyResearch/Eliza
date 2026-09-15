/** Reply generation can fail independently of an action's committed effects. */
import { getActionRoutingContext } from "../runtime/action-routing-context";
import type { ActionResult } from "./components";

export interface ActionReplyFailure {
	kind: "provider_issue" | "rate_limited" | "no_provider";
	code: string;
	/** System status, never action-owned conversational fallback prose. */
	message: string;
	/** Replaying the user turn could repeat an already committed mutation. */
	transient: false;
}

export type GroundedActionReply =
	| { kind: "model"; text: string }
	/** Complete action-specific model input, not user-facing prose. */
	| { kind: "deferred"; grounding: string }
	| { kind: "unavailable"; failure: ActionReplyFailure };

/** Explicit execution ownership. Direct/background callers keep local rendering. */
export function getActionReplyOwner(
	messageId: string | undefined,
): "planner" | undefined {
	const context = getActionRoutingContext();
	return messageId && context?.messageId === messageId
		? context.replyOwner
		: undefined;
}

export function createUnavailableGroundedActionReply(
	args: Pick<ActionReplyFailure, "kind" | "code">,
): Extract<GroundedActionReply, { kind: "unavailable" }> {
	return {
		kind: "unavailable",
		failure: {
			...args,
			message:
				"Reply unavailable. Response generation failed; recorded action outcomes are preserved. Do not repeat the request to recover the reply.",
			transient: false,
		},
	};
}

export function normalizeActionReplyFailure(
	value: unknown,
): ActionReplyFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("ActionResult.replyFailure must be an object.");
	}
	const record = value as Record<string, unknown>;
	if (
		(record.kind !== "provider_issue" &&
			record.kind !== "rate_limited" &&
			record.kind !== "no_provider") ||
		typeof record.code !== "string" ||
		!record.code.trim() ||
		typeof record.message !== "string" ||
		!record.message.trim() ||
		record.transient !== false
	) {
		throw new TypeError(
			"ActionResult.replyFailure must declare a non-replayable reply failure.",
		);
	}
	return {
		kind: record.kind,
		code: record.code,
		message: record.message,
		transient: false,
	};
}

/** Untrusted transport/content metadata may not opt a normal reply into this status. */
export function readActionReplyFailure(
	value: unknown,
): ActionReplyFailure | undefined {
	if (value === undefined) return undefined;
	try {
		return normalizeActionReplyFailure(value);
	} catch {
		return undefined;
	}
}

/** Keep the action outcome authoritative when presentation cannot be generated. */
export function applyGroundedActionReply(
	result: ActionResult,
	reply: GroundedActionReply,
): ActionResult {
	const settled = { ...result };
	if (reply.kind === "deferred") {
		settled.data = { ...settled.data, replyGrounding: reply.grounding };
		if (settled.promptDataMode === "replace-data") {
			settled.promptData = {
				...settled.promptData,
				replyGrounding: reply.grounding,
			};
		}
		settled.transcriptVisibility = "internal";
		settled.turnComplete = false;
		delete settled.userFacingText;
		delete settled.verifiedUserFacing;
		delete settled.userFacingEffectReceiptIds;
		delete settled.replyFailure;
		delete settled.modelReplyRequired;
		delete settled.modelReplyFallback;
		delete settled.continueChain;
		return settled;
	}
	if (reply.kind === "model") {
		settled.text = reply.text;
		if (settled.userFacingText !== undefined)
			settled.userFacingText = reply.text;
		delete settled.replyFailure;
		return settled;
	}
	settled.replyFailure = normalizeActionReplyFailure(reply.failure);
	settled.transcriptVisibility = "internal";
	settled.turnComplete = false;
	delete settled.userFacingText;
	delete settled.verifiedUserFacing;
	delete settled.userFacingEffectReceiptIds;
	delete settled.modelReplyRequired;
	delete settled.modelReplyFallback;
	delete settled.continueChain;
	return settled;
}
