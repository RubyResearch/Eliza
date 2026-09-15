/**
 * Message-processing contracts for the incoming-message loop: options controlling
 * a turn (retries, multi-step, streaming, continue-after-actions) and the result
 * shapes the message service returns. Consumed by the runtime message handler.
 */

import type { InferenceTurnSummary } from "../inference-timing";
import type { RoomHandlerLease } from "../runtime/room-handler-queue";
import type { CodingActionProfile } from "./coding";
import type {
	ActionResult,
	AgentContext,
	HandlerCallback,
	StreamChunkCallback,
} from "./components";
import type { Room } from "./environment";
import type { Memory } from "./memory";
import type { ModelType } from "./model";
import type {
	Content,
	JsonValue,
	Media,
	MentionContext,
	UUID,
} from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

/**
 * Configuration options for message processing
 */
export interface MessageProcessingOptions {
	maxRetries?: number;
	useMultiStep?: boolean;
	maxMultiStepIterations?: number;
	/**
	 * Run this trusted host turn as a focused coding-agent loop. Coding turns
	 * enter the planner directly instead of spending a separate model call on
	 * conversational Stage 1 routing. This is a per-turn execution choice, not
	 * an authorization signal; normal role and action gates still apply.
	 */
	codingMode?: boolean;
	/**
	 * Optional trusted host policy for the model-facing action set of this coding
	 * turn. Omission preserves the complete authorized coding surface.
	 */
	codingActionProfile?: CodingActionProfile;
	shouldRespondModel?: ShouldRespondModelType;
	onStreamChunk?: StreamChunkCallback;
	/**
	 * When true, run a follow-up reasoning pass after actions complete so the
	 * agent can decide whether to share results, run another action, or stop.
	 * Defaults to enabled unless runtime.getSetting("CONTINUE_AFTER_ACTIONS")
	 * explicitly disables it.
	 */
	continueAfterActions?: boolean;
	/** Signal to abort message processing */
	abortSignal?: AbortSignal;
	/**
	 * Exact room ownership held by a host whose persistence boundary outlives
	 * this service invocation. Required when async-local context is unavailable.
	 */
	roomHandlerLease?: RoomHandlerLease;
	/**
	 * Receives each action result as soon as its handler boundary settles. Hosts
	 * use this to retain committed-effect knowledge if later turn work aborts.
	 */
	onSettledActionResult?: (result: ActionResult) => void;
	/**
	 * Receives the run-terminal capability as soon as the message service owns it.
	 * Hosts retain this across a later thrown turn so recovery delivery cannot be
	 * mistaken for a delivery-only trajectory terminal.
	 */
	onTrajectoryTerminalOwner?: (owner: "run") => void;
	/**
	 * Receives the exact closed turn timing summary synchronously after response
	 * delivery. Hosting boundaries can export edge telemetry before disposing an
	 * ephemeral runtime; callback failures are diagnostic-only.
	 */
	onInferenceTimingSummary?: (summary: InferenceTurnSummary) => void;
	/**
	 * When true, do not discard responses when a newer message is being processed (same as BASIC_CAPABILITIES_KEEP_RESP).
	 * @default resolved from runtime.getSetting("BASIC_CAPABILITIES_KEEP_RESP") if not set
	 */
	keepExistingResponses?: boolean;
}

/**
 * Result of message processing
 */
export interface MessageTerminalFailure {
	/** Stable machine-readable category for adapters and orchestration hosts. */
	kind: string;
	/** Action boundary code when the failing tool supplied typed provenance. */
	code?: string;
	/** Whether retrying the same turn without user intervention may succeed. */
	transient: boolean;
	/** Complete user-facing explanation of why the turn did not complete. */
	message: string;
}

/** Server-only evidence for regenerating prose without executing a turn again. */
export interface MessageReplyRecoveryContext {
	context: string;
	pendingToolCalls: JsonValue[];
	evaluatorOutputs: JsonValue[];
	ownerExclusiveDisclosureUsed: boolean;
}

export interface MessageProcessingResult {
	didRespond: boolean;
	responseContent?: Content | null;
	responseMessages: Memory[];
	/**
	 * Terminal failure independent of response delivery. Callback-delivered or
	 * deduplicated text may leave `responseContent` null, but callers still need
	 * an authoritative non-success result.
	 */
	terminalFailure?: MessageTerminalFailure;
	/**
	 * The returned delivery belongs to a live message-service run whose detached
	 * task barrier will emit `RUN_ENDED`. Hosts must preserve this capability on
	 * synthetic `MESSAGE_SENT` events instead of treating delivery as terminal.
	 */
	trajectoryTerminalOwner?: "run";
	/**
	 * IDs from `responseMessages` that this service durably committed before
	 * returning. Transport layers use this instead of guessing persistence from
	 * the strategy mode; transient replies may deliberately skip storage.
	 */
	persistedResponseMessageIds?: UUID[];
	/** Results executed during this turn, preserved across planner/cache cleanup. */
	actionResults?: ActionResult[];
	/** Complete original context; never expose this on public chat DTOs. */
	replyRecovery?: MessageReplyRecoveryContext;
	state?: State;
	mode?: MessageProcessingMode;
	skipEvaluation?: boolean;
	reason?: string;
}

/**
 * Response decision from the shouldRespond logic
 */
export interface ResponseDecision {
	shouldRespond: boolean;
	skipEvaluation: boolean;
	reason: string;
}

/**
 * Extended response decision that includes context routing.
 * Used by deterministic shouldRespond bypasses and v5 message routing metadata.
 */
export interface ContextRoutedResponseDecision extends ResponseDecision {
	/** The single best-matching domain context for this turn */
	primaryContext?: AgentContext;
	/** Additional relevant contexts (may enable extra providers/actions) */
	secondaryContexts?: AgentContext[];
}

export type ShouldRespondModelType =
	| "nano"
	| "small"
	| "large"
	| "mega"
	| "response-handler"
	| typeof ModelType.TEXT_NANO
	| typeof ModelType.TEXT_SMALL
	| typeof ModelType.TEXT_LARGE
	| typeof ModelType.TEXT_MEGA
	| typeof ModelType.RESPONSE_HANDLER;
export type MessageProcessingMode = "simple" | "actions" | "none" | "blocked";

/**
 * Core interface for message handling service.
 * This service is responsible for processing incoming messages and generating responses.
 *
 * Implementations of this interface control the entire message processing pipeline,
 * including:
 * - Message validation and memory creation
 * - Response decision logic (shouldRespond)
 * - Native planner processing
 * - Action execution and evaluation
 *
 * @example
 * ```typescript
 * // Custom implementation
 * class CustomMessageService implements IMessageService {
 *   async handleMessage(runtime, message, callback) {
 *     // Your custom message handling logic
 *     return {
 *       didRespond: true,
 *       responseContent: { text: "Custom response" },
 *       responseMessages: [],
 *       state: {},
 *       mode: 'simple'
 *     };
 *   }
 *
 *   shouldRespond(runtime, message, room, mentionContext) {
 *     // Your custom response decision logic
 *     return { shouldRespond: true, skipEvaluation: true, reason: "custom" };
 *   }
 * }
 *
 * // Register in runtime
 * await runtime.registerService(CustomMessageService);
 * ```
 */
export interface IMessageService {
	/**
	 * Main entry point for message processing.
	 * This method orchestrates the entire message handling flow.
	 *
	 * @param runtime - The agent runtime instance
	 * @param message - The incoming message to process
	 * @param callback - Callback function to send responses
	 * @param options - Optional processing options
	 * @returns Promise resolving to the processing result
	 */
	handleMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback?: HandlerCallback,
		options?: MessageProcessingOptions,
	): Promise<MessageProcessingResult>;

	/**
	 * Determines whether the agent should respond to a message.
	 * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
	 *
	 * @param runtime - The agent runtime instance
	 * @param message - The message to evaluate
	 * @param room - The room context (optional)
	 * @param mentionContext - Platform mention/reply context (optional)
	 * @returns Response decision with reasoning
	 */
	shouldRespond(
		runtime: IAgentRuntime,
		message: Memory,
		room?: Room,
		mentionContext?: MentionContext,
	): ResponseDecision;

	/**
	 * Processes attachments in a message (images, documents, etc.)
	 * Generates descriptions for images and extracts text from documents.
	 *
	 * @param runtime - The agent runtime instance
	 * @param attachments - Array of media attachments to process
	 * @returns Promise resolving to processed attachments with descriptions
	 */
	processAttachments?(
		runtime: IAgentRuntime,
		attachments: Media[],
	): Promise<Media[]>;

	/**
	 * Deletes a message from the agent's memory.
	 * This method handles the actual deletion logic that was previously in event handlers.
	 *
	 * @param runtime - The agent runtime instance
	 * @param message - The message memory to delete
	 * @returns Promise resolving when deletion is complete
	 */
	deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void>;

	/**
	 * Clears all messages from a channel/room.
	 * This method handles bulk deletion of all message memories in a room.
	 *
	 * @param runtime - The agent runtime instance
	 * @param roomId - The room ID to clear messages from
	 * @param channelId - The original channel ID (for logging)
	 * @returns Promise resolving when channel is cleared
	 */
	clearChannel(
		runtime: IAgentRuntime,
		roomId: UUID,
		channelId: string,
	): Promise<void>;
}
