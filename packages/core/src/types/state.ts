/**
 * Per-turn `State`: the composed working context passed through the message loop —
 * provider values, working memory, action plans, and the structured-output schema
 * rows. Built fresh each turn from providers and consumed by prompt assembly and
 * action handlers.
 */
import type { ActionResult, ProviderValue } from "./components";
import type { Entity, Room, World } from "./environment";

/**
 * Allowed value types for state values (JSON-serializable)
 */
export type StateValue =
	| string
	| number
	| boolean
	| null
	| ProviderValue
	| object
	| StateValue[]
	| { [key: string]: StateValue };

export interface StructuredOutputFailure {
	source: "dynamicPromptExecFromState";
	kind: "model_error" | "parse_error" | "parse_problem" | "validation_error";
	model: string;
	format: "JSON" | "TOON";
	schemaFields: string[];
	attempts: number;
	maxRetries: number;
	timestamp: number;
	key?: string;
	parseError?: string;
	issues?: string[];
	responsePreview?: string;
}

/** Single step in an action plan */
export interface ActionPlanStep {
	action: string;
	status: "pending" | "completed" | "failed";
	error?: string;
	result?: ActionResult;
}

/** Multi-step action plan */
export interface ActionPlan {
	thought: string;
	totalSteps: number;
	currentStep: number;
	steps: ActionPlanStep[];
	metadata?: Record<string, StateValue>;
}

/**
 * Provider result cache entry
 */
export interface ProviderCacheEntry {
	text?: string;
	discoveryText?: string;
	overflowText?: string;
	values?: Record<string, StateValue>;
	data?: Record<string, StateValue>;
}

/**
 * Working memory entry for action execution
 */
export interface WorkingMemoryEntry {
	actionName: string;
	result: ActionResult;
	timestamp: number;
}

/**
 * Working memory record for temporary state during action execution
 */
export type WorkingMemory = Record<string, WorkingMemoryEntry>;

/**
 * Structured data cached in state by providers and actions.
 * Common properties are typed for better DX while allowing dynamic extension.
 */
export interface StateData {
	/** Cached room data from providers */
	room?: Room;
	/** Cached world data from providers */
	world?: World;
	/** Cached entity data from providers */
	entity?: Entity;
	/** Provider results cache keyed by provider name */
	providers?: Record<string, ProviderCacheEntry>;
	/** Current action plan for queued action execution */
	actionPlan?: ActionPlan;
	/** Results from previous action executions */
	actionResults?: ActionResult[];
	/** Working memory for temporary state during action execution */
	workingMemory?: WorkingMemory;
	/** Latest structured-output failure captured during this run */
	structuredOutputFailure?: StructuredOutputFailure;
	/** Allow dynamic properties for plugin extensions */
	[key: string]: StateValue | undefined;
}

/**
 * State values populated by providers
 */
export interface StateValues {
	/** Agent name */
	agentName?: string;
	/** Action names available to the agent */
	actionNames?: string;
	/** Provider names used */
	providers?: string;
	/** Human-readable summary of the latest structured-output failure */
	structuredOutputFailureSummary?: string;
	/** Other dynamic values */
	[key: string]: StateValue | undefined;
}

/**
 * Represents the current state or context of a conversation or agent interaction.
 */
export interface State {
	values: StateValues;
	data: StateData;
	text: string;
	[key: string]: StateValue | StateValues | StateData | undefined;
}

// ============================================================================
// Dynamic Prompt Execution Types
// ============================================================================

/**
 * Schema row for dynamic prompt execution.
 *
 * WHY: dynamicPromptExecFromState generates structured prompts that ask the LLM
 * to output specific fields. Each SchemaRow defines one field the LLM must produce.
 * The schema also controls validation behavior for streaming scenarios.
 *
 * Schema rows are intentionally backwards-compatible with the original flat shape,
 * but now also support nested objects and arrays so callers can describe structured
 * payloads without embedding pseudo-schemas in prose strings.
 *
 * @example
 * ```ts
 * const schema: SchemaRow[] = [
 *   { field: 'thought', description: 'Your internal reasoning' },
 *   { field: 'text', description: 'Response to user', required: true },
 *   {
 *     field: 'facts',
 *     description: 'Facts extracted from the conversation',
 *     type: 'array',
 *     items: {
 *       description: 'One fact entry',
 *       type: 'object',
 *       properties: [
 *         { field: 'claim', description: 'Fact claim', required: true },
 *         { field: 'type', description: 'fact|opinion|preference', required: true },
 *       ],
 *     },
 *   },
 * ];
 * ```
 */
export type SchemaValueType =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "array";

export type SchemaValueSpec = {
	/** Description shown to LLM - explains what to put in this value */
	description: string;
	/**
	 * Expected value type.
	 *
	 * WHY: Flat string descriptions work for simple fields, but nested arrays/objects
	 * need explicit structure so prompt examples and validation can stay machine-readable.
	 */
	type?: SchemaValueType;
	/** If true, validation fails when value is empty/missing */
	required?: boolean;
	/**
	 * Object properties for `type: "object"`.
	 *
	 * WHY: Lets callers describe nested output directly instead of teaching the model
	 * an ad-hoc JSON shape through freeform prose.
	 */
	properties?: SchemaRow[];
	/**
	 * Item shape for `type: "array"`.
	 *
	 * WHY: Arrays often contain structured entries. This keeps the shape attached to
	 * the schema so examples, parsing, and validation can agree.
	 */
	items?: SchemaValueSpec;
};

export type SchemaRow = SchemaValueSpec & {
	/** Field name in structured JSON output */
	field: string;
	/**
	 * Control per-field validation codes for streaming (levels 0-1 only).
	 *
	 * WHY: Validation codes are UUID snippets that surround each field. If the LLM
	 * outputs the same code before and after a field, we know the context window
	 * wasn't truncated mid-field. This trades off token usage for reliability.
	 *
	 * Behavior by level:
	 * - Level 0 (Trusted): default false. Set to true to opt-in to per-field codes.
	 * - Level 1 (Progressive): default true. Set to false to opt-out of codes.
	 * - Levels 2-3: ignored for per-field wrapping. Those levels can use optional
	 *   checkpoint codes instead.
	 *
	 * Note: Only top-level schema rows use this today. Nested `properties` are still
	 * validated structurally, but they do not get their own streaming/validation wires.
	 */
	validateField?: boolean;
	/**
	 * Control whether this field's content is streamed to the consumer.
	 *
	 * WHY: Not all fields should be shown to users in real-time:
	 * - 'thought': Internal reasoning - might be verbose or confusing to show
	 * - 'actions': System field for action routing - not user-visible
	 * - 'text': The actual response - should definitely stream
	 *
	 * Default: true for 'text' field, false for others.
	 *
	 * Note: Only top-level schema rows are considered for streaming. Nested object/array
	 * members still flow through parsing/validation, but are not streamed independently.
	 */
	streamField?: boolean;
};

/**
 * Configuration for retry backoff timing.
 *
 * WHY: When retries happen, immediate retries can:
 * - Overwhelm rate-limited APIs
 * - Hit transient failures repeatedly
 * - Waste resources on brief outages
 *
 * Backoff gives the system time to recover between attempts.
 */
export interface RetryBackoffConfig {
	/**
	 * Initial delay in milliseconds before first retry.
	 * Default: 1000ms (1 second)
	 */
	initialMs: number;
	/**
	 * Multiplier for exponential backoff.
	 * delay = initialMs * multiplier^(retryCount - 1)
	 * Default: 2 (doubles each time)
	 */
	multiplier: number;
	/**
	 * Maximum delay in milliseconds.
	 * Caps exponential growth to prevent absurd wait times.
	 * Default: 30000ms (30 seconds)
	 */
	maxMs: number;
}

/**
 * Stream event types for validation-aware streaming.
 * Rich consumers receive these typed events for custom UX handling.
 */
export type StreamEventType =
	| "chunk" // Regular content chunk being streamed
	| "field_validated" // A field passed validation (level 1)
	| "retry_start" // Starting a retry attempt
	| "error" // Unrecoverable error occurred
	| "complete"; // Successfully finished all validation

/**
 * Rich stream event for sophisticated consumers.
 *
 * WHY: Simple consumers just want text chunks. Advanced UIs want to know
 * about validation progress, retries, and errors to show appropriate UI
 * (spinners, clear partial content, error messages).
 */
export interface StreamEvent {
	/** Event type (named eventType for cross-language consistency with Rust/Python) */
	eventType: StreamEventType;
	/** Field name (for chunk and field_validated events) */
	field?: string;
	/** Content chunk (for chunk events) */
	chunk?: string;
	/** Retry attempt number (for retry_start events) */
	retryCount?: number;
	/** Error message (for error events) */
	error?: string;
	/** Timestamp of the event */
	timestamp: number;
}
