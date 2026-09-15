/** Determines whether a completed response warrants post-turn semantic work or represents a stop decision. */

import type { MessageHandlerExtract } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { Content } from "../../types/primitives";
import type { State } from "../../types/state";
import { isReplyActionIdentifier } from "./action-identifiers.js";

export function isSimpleReplyResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		isReplyActionIdentifier(responseContent.actions[0])
	);
}

export const POST_TURN_SEMANTIC_SIGNAL =
	/(?:https?:\/\/|\b(?:i am|i'm|i have|i've|i feel|i like|i love|i hate|i prefer|i need|i want|my|we|our|remember|friend|partner|wife|husband|relationship|work at|live in|located in|goal|plan)\b)/i;

export function hasPostTurnSemanticSignal(
	message: Pick<Memory, "content">,
	state: Pick<State, "data"> | undefined,
	responseContent: Pick<Content, "actions"> | null | undefined,
	extract?: Pick<MessageHandlerExtract, "facts" | "relationships">,
): boolean {
	// Stage 1 already detected semantic evidence. A lexical shortcut must not
	// suppress its durable review; the background worker still validates sources.
	if (extract?.facts?.length || extract?.relationships?.length) return true;
	if (!isSimpleReplyResponse(responseContent)) return true;
	const actionResults = state?.data?.actionResults;
	if (Array.isArray(actionResults) && actionResults.length > 0) return true;
	const text = message.content.text?.trim() ?? "";
	return POST_TURN_SEMANTIC_SIGNAL.test(text);
}

export function isStopResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		responseContent.actions[0].toUpperCase() === "STOP"
	);
}
