/**
 * Evaluator contracts: the post-response processing step run after the agent
 * replies. Defines the `Evaluator` interface plus its run/prompt/processor
 * context shapes and the pluggable `EvaluatorProcessor` chain.
 */
import type { ActionResult, HandlerCallback } from "./components";
import type { Memory } from "./memory";
import type { JSONSchema, ModelTypeName, PromptSegment } from "./model";
import type { JsonValue } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

/** Source-change plan captured under room ownership before retiring derived effects. */
export interface EvaluatorEvidenceReconciliation {
	id: string;
	changedMessageIds: string[];
	removedMessageIds: string[];
	currentSourceRevisions: Record<string, string>;
	/** All effects from an interrupted batch must be retired before regenerating it. */
	pendingEvidenceId?: string;
}

export interface EvaluatorRunOptions {
	didRespond?: boolean;
	responses?: Memory[];
	callback?: HandlerCallback;
	phase?: string;
	/**
	 * Whether the turn contains durable user/action information worth semantic
	 * reflection. Evaluators that extract memory may skip false; explicit
	 * plugin evaluators such as link extraction retain their own gates.
	 */
	semanticSignal?: boolean;
	/**
	 * Runtime-owned, durable evidence batch for an incremental evaluator. All
	 * changed records are complete; historical chat remains in message storage.
	 * Processors must make replay of evidenceId idempotent before opting in.
	 */
	extraction?: {
		/** Evaluator-owned state from the last successful progress commit. Never
		 * model evidence by itself; consumers must validate its source binding. */
		progressState?: JsonValue;
		isBackfill: boolean;
		remainingSourceCount?: number;
		referenceRevisions?: Record<string, string>;
		messages: Memory[];
		sourceRevisions: Record<string, string>;
		changedMessageIds: string[];
		removedMessageIds: string[];
		evidenceId: string;
	};
}

export interface EvaluatorRunContext {
	runtime: IAgentRuntime;
	message: Memory;
	state?: State;
	options: EvaluatorRunOptions;
}

/**
 * Facts the merged post-turn prompt already renders once in its shared
 * context. A section that would otherwise embed its own copy refers to the
 * shared rendering instead, so the merged call carries each fact one time.
 */
export interface EvaluatorSharedPromptContext {
	/** The complete room transcript is rendered in the shared context. */
	roomTranscriptRendered: boolean;
	/** Exact action-result rendering already present in the shared context. */
	actionResultsText?: string;
}

export interface EvaluatorPromptContext<TPrepared = unknown>
	extends EvaluatorRunContext {
	state: State;
	prepared: TPrepared;
	shared?: EvaluatorSharedPromptContext;
}

export interface EvaluatorProcessorContext<
	TOutput = JsonValue,
	TPrepared = unknown,
> extends EvaluatorPromptContext<TPrepared> {
	output: TOutput;
	evaluatorName: string;
}

export interface EvaluatorProcessor<TOutput = JsonValue, TPrepared = unknown> {
	name?: string;
	priority?: number;
	process(
		context: EvaluatorProcessorContext<TOutput, TPrepared>,
	): Promise<ActionResult | undefined>;
}

export interface Evaluator<TOutput = JsonValue, TPrepared = unknown> {
	name: string;
	description: string;
	similes?: string[];
	priority?: number;
	/**
	 * Explicit override policy for name collisions during registration.
	 * See {@link Action.override}: set `override: true` on the later registrant
	 * to intentionally supersede an already-registered evaluator of the same
	 * name. Undeclared collisions keep the incumbent (first-wins) + emit a WARN.
	 */
	override?: boolean;
	providers?: string[];
	schema: JSONSchema;
	modelType?: ModelTypeName;
	/** Opt in only when prepare consumes extraction and every processor is replay-safe. */
	incremental?: boolean | ((runtime: IAgentRuntime) => boolean);
	/** Opt in when prepare is repeatable and prompt fully describes reducer candidates.
	 * Background inference releases room ownership; prepare/prompt are revalidated
	 * under a new room lease before any staged output or effects are applied. */
	background?: boolean;
	/** Must preserve originals/manual records, durably retire invalid derived effects,
	 * and return other retained supporting sources requiring re-evaluation. */
	reconcileEvidence?(
		context: EvaluatorRunContext & {
			reconciliation: EvaluatorEvidenceReconciliation;
		},
	): Promise<{ reprocessSourceIds: string[] }>;

	/** Explicit input contract for reducers that extract only from the current
	 * message. The service isolates their batch from room history and turn receipts;
	 * declared providers still recompose normally. Existing evaluators default to
	 * the complete turn context. Incremental evaluators use their evidence contract. */
	inputScope?: "current_message";
	shouldRun(context: EvaluatorRunContext): Promise<boolean>;
	prepare?(context: EvaluatorRunContext & { state: State }): Promise<TPrepared>;
	/**
	 * Runtime-computed output after prepare, for evaluators whose result requires
	 * no model judgment. Excludes this section from model prompts; normal parsing,
	 * processors and durable progress still apply. Must return a defined output
	 * or throw. Stored pending output takes precedence during replay.
	 */
	resolveOutput?(context: EvaluatorPromptContext<TPrepared>): TOutput;
	/** A conditional resolver may opt out and retain ordinary model judgment.
	 * When omitted, a declared resolver must always return defined output. */
	resolveOutputWhen?(context: EvaluatorPromptContext<TPrepared>): boolean;
	prompt(context: EvaluatorPromptContext<TPrepared>): string;
	/** Optional lossless annotation of prompt(); concatenation must equal its full text.
	 * Only state-independent instructions may be stable, as a contiguous prefix
	 * before dynamic data. The service relocates that whole instruction prefix
	 * before shared turn context, retaining dynamic content in evaluator order.
	 * Boundaries must not split a Unicode code point.
	 */
	promptSegments?(context: EvaluatorPromptContext<TPrepared>): PromptSegment[];
	parse?(
		output: unknown,
		context?: EvaluatorPromptContext<TPrepared> & {
			/** Runtime provenance lets evolved parsers enforce new model contracts
			 * without changing already-staged replay or direct legacy callers. */
			outputSource?: "model" | "staged" | "resolved";
		},
	): TOutput | null;
	processors?: Array<EvaluatorProcessor<TOutput, TPrepared>>;
	/** Derive a source-bound checkpoint after all processors succeed. The service
	 * commits it with the evidence watermark, not as a separate reducer write.
	 * Must be pure and replay-safe. Only incremental evaluators receive this hook. */
	progressState?(
		context: EvaluatorProcessorContext<TOutput, TPrepared>,
	): JsonValue;
}

/**
 * Heterogeneous evaluators on the runtime or from plugins. Output/prepared
 * generics are erased to `unknown` so concrete `Evaluator<YourOutput, ...>`
 * instances are assignable without `any`.
 */
export type RegisteredEvaluator = Evaluator<unknown, unknown>;

export interface EvaluatorRunResult {
	/** At least one processed lane has another full evidence page to consume. */
	hasMoreEvidence?: boolean;
	skipped: boolean;
	activeEvaluators: string[];
	processedEvaluators: string[];
	results: ActionResult[];
	errors: Array<{
		evaluatorName: string;
		processorName?: string;
		/** Provider retry deadline, retained without transporting raw errors/secrets. */
		retryAt?: number;
		error: string;
	}>;
}
