/**
 * Neutral in-memory representation of a prompt-assembly context: messages, tools,
 * provider segments, and metadata collected before rendering into a model call.
 * Event-typed and role-tagged so producers (providers, actions) and the renderer
 * agree on a single intermediate shape independent of any model's wire format.
 */
import type { Action } from "./components";
import type { AgentContext, ContextDefinition } from "./contexts";
import type { Memory } from "./memory";
import type { PromptSegment, ToolDefinition } from "./model";
import type { Content, JsonValue } from "./primitives";

export type ContextObjectEventType =
	| "message"
	| "memory"
	| "provider"
	| "tool"
	| "instruction"
	| "segment"
	| "metadata"
	| (string & {});

export type ContextObjectRole =
	| "system"
	| "user"
	| "assistant"
	| "tool"
	| (string & {});

export interface ContextObjectMessage {
	id?: string;
	role: ContextObjectRole;
	content: string | Content | JsonValue;
	name?: string;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface ContextObjectTool {
	id?: string;
	name: string;
	description?: string;
	parameters?: unknown;
	action?: Action;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface ContextObjectPromptSegment extends PromptSegment {
	id?: string;
	label?: string;
	tokenCount?: number;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface ContextEventBase {
	id: string;
	type: ContextObjectEventType;
	createdAt?: number;
	source?: string;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface ContextMessageEvent extends ContextEventBase {
	type: "message";
	message: ContextObjectMessage;
}

export interface ContextMemoryEvent extends ContextEventBase {
	type: "memory";
	memory: Memory;
}

export interface ContextProviderEvent extends ContextEventBase {
	type: "provider";
	name: string;
	text?: string;
	/** Provider-owned index; the complete text stays in the original context. */
	discoveryText?: string;
	values?: Record<string, JsonValue | undefined>;
	data?: Record<string, unknown>;
	/**
	 * Mirrors the originating `Provider.cacheStable`. Read by
	 * `context-renderer.ts`'s `renderEvent` to mark the rendered prompt segment
	 * `stable`, so `buildStageChatMessages` (planner/evaluator stages) routes a
	 * genuinely-stable provider's content into the cached system message rather
	 * than the uncached user message.
	 */
	cacheStable?: boolean;
}

export interface ContextToolEvent extends ContextEventBase {
	type: "tool";
	tool: ContextObjectTool;
}

export interface ContextInstructionEvent extends ContextEventBase {
	type: "instruction";
	content: string;
	role?: ContextObjectRole;
	stable?: boolean;
}

export interface ContextSegmentEvent extends ContextEventBase {
	type: "segment";
	segment: ContextObjectPromptSegment;
}

export interface ContextMetadataEvent extends ContextEventBase {
	type: "metadata";
	key: string;
	value: JsonValue;
}

export type ContextEvent =
	| ContextMessageEvent
	| ContextMemoryEvent
	| ContextProviderEvent
	| ContextToolEvent
	| ContextInstructionEvent
	| ContextSegmentEvent
	| ContextMetadataEvent
	| (ContextEventBase & Record<string, unknown>);

export interface ContextObject {
	id: string;
	version?: "v5" | (string & {});
	createdAt?: number;
	metadata?: Record<string, JsonValue | undefined>;
	staticPrefix?: {
		systemPrompt?: ContextObjectPromptSegment;
		characterPrompt?: ContextObjectPromptSegment;
		staticProviders?: ContextObjectPromptSegment[];
		alwaysTools?: ToolDefinition[];
		contextRegistryDigest?: string;
	};
	trajectoryPrefix?: {
		messageHandlerThought?: string;
		selectedContexts?: AgentContext[];
		contextDefinitions?: ContextDefinition[];
		contextProviders?: ContextObjectPromptSegment[];
		expandedTools?: ToolDefinition[];
		createdAtStageId?: string;
	};
	plannedQueue?: Array<{
		id?: string;
		name: string;
		args?: JsonValue;
		status: "queued" | "running" | "completed" | "skipped" | "failed";
		sourceStageId?: string;
		contextScope?: AgentContext;
		parentToolCallId?: string;
	}>;
	metrics?: Record<string, JsonValue | undefined>;
	limits?: Record<string, JsonValue | undefined>;
	/**
	 * Append-only construction log. Consumers should render by walking this array
	 * in order; updates are represented as new events rather than mutations.
	 */
	events: readonly ContextEvent[];
}
