/** Defines the message turn, response-strategy, and Stage 1 observation contracts shared by pipeline stages. */

import type { InferenceTurnSummary } from "../../inference-timing";
import type { RoomHandlerLease } from "../../runtime/room-handler-queue";
import type { CodingActionProfile } from "../../types/coding";
import type {
	ActionResult,
	MessageHandlerResult,
	StreamChunkCallback,
} from "../../types/components";
import type { Memory } from "../../types/memory";
import type {
	MessageReplyRecoveryContext,
	MessageTerminalFailure,
	ShouldRespondModelType,
} from "../../types/message-service";
import type { Content } from "../../types/primitives";
import type { State } from "../../types/state";
import type { MessageRunTerminalOwner } from "./turn-session.js";

/**
 * Resolved message options with defaults applied.
 * Required numeric options + optional streaming callback.
 */
export type ResolvedMessageOptions = {
	maxRetries: number;
	codingMode: boolean;
	codingActionProfile?: CodingActionProfile;
	continueAfterActions: boolean;
	keepExistingResponses: boolean;
	onStreamChunk?: StreamChunkCallback;
	shouldRespondModel: ShouldRespondModelType;
	/**
	 * Per-turn abort signal threaded into the streaming context so
	 * `runtime.useModel` and model handlers downstream can cancel
	 * in-flight inference. Sourced from `MessageProcessingOptions.abortSignal`.
	 */
	abortSignal?: AbortSignal;
	roomHandlerLease?: RoomHandlerLease;
	onSettledActionResult?: (result: ActionResult) => void;
	onTrajectoryTerminalOwner?: (owner: "run") => void;
	onInferenceTimingSummary?: (summary: InferenceTurnSummary) => void;
	runTerminalOwner?: MessageRunTerminalOwner;
};

/**
 * Strategy mode for response generation
 */
export type StrategyMode = "simple" | "actions" | "none";

/**
 * Strategy result from core processing
 */
export interface StrategyResult {
	responseContent: Content | null;
	responseMessages: Memory[];
	actionResults?: ActionResult[];
	replyRecovery?: MessageReplyRecoveryContext;
	terminalFailure?: MessageTerminalFailure;
	state: State;
	mode: StrategyMode;
}

/**
 * Outcome of attempting the fallback model loop in
 * `buildStructuredFailureReply`. `noProvider` means a model call surfaced
 * `NoModelProviderConfiguredError`; the caller must short-circuit to
 * `buildNoModelProviderReply` instead of continuing the loop.
 */
export type FailureReplyAttempt =
	| { kind: "text"; value: string }
	| { kind: "noProvider" }
	| { kind: "creditsExhausted" }
	| { kind: "rateLimited" }
	| { kind: "authFailed" };

export type V5MessageRuntimeStage1Result =
	| {
			kind: "decision";
			action: "RESPOND" | "IGNORE" | "STOP";
			messageHandler: MessageHandlerResult;
			state: State;
	  }
	| {
			kind: "terminal";
			action: "IGNORE" | "STOP";
			messageHandler: MessageHandlerResult;
			state: State;
	  }
	| {
			kind: "direct_reply" | "planned_reply";
			messageHandler: MessageHandlerResult;
			result: StrategyResult;
	  };

/** Observable evidence emitted after Stage 1 parses a decision and before routing. */
export interface Stage1DecisionObservation {
	trajectoryId?: string;
	provider?: string;
	prefixHash: string;
	decision: MessageHandlerResult["processMessage"];
	parsed: MessageHandlerResult;
}

export type ResponseHandlerEarlyReplyEvent = {
	text: string;
	messageHandler: MessageHandlerResult;
};
