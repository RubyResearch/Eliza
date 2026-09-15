/**
 * Shared type contracts for the planner subsystem: the planner/evaluator runtime
 * shapes, a single tool call and its result, a trajectory step, and the loop's
 * parameter and result envelopes. Consumed by planner-loop, the evaluator, and
 * the message handler that drives them.
 */
import type {
	ActionFailureKind,
	ActionFailureProvenance,
} from "../types/action-failure";
import type { ActionReplyFailure } from "../types/action-reply";
import type { EvaluationResult } from "../types/components";
import type { ContextObject } from "../types/context-object";
import type { EffectReceipt } from "../types/effects";
import type {
	ChatMessage,
	GenerateTextResult,
	ModelAttemptContext,
	ModelRegistrationInfo,
	PromptSegment,
	TextGenerationModelType,
	ToolChoice,
	ToolDefinition,
} from "../types/model";
import type { State } from "../types/state";
import type { ChainingLoopConfig } from "./limits";
import type { TrajectoryRecorder } from "./trajectory-recorder";

export type { ContextObject } from "../types/context-object";

export interface PlannerToolCall {
	id?: string;
	name: string;
	params?: Record<string, unknown>;
}

export type EvaluatorRoute = EvaluationResult["decision"];

export type EvaluatorModelResult =
	| string
	| (Partial<GenerateTextResult> & { object?: unknown });

export interface EvaluatorRuntime {
	/** Same fresh provider read used by the planner restoration protocol. */
	restoreProviderContext?(context: ContextObject): Promise<ContextObject>;
	/** True when useModel invokes prepareModelAttempt before every provider handler. */
	supportsModelAttemptPreparation?: boolean;
	/** Optional model registry access used to resolve evaluator context ceilings. */
	getModelRegistrations?(): ModelRegistrationInfo[];
	/** Optional setting access used by model registration metadata resolvers. */
	getSetting?(key: string): string | boolean | number | null;
	reportError?(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void;
	/** Runtime-known-secret redaction composed into model-bound tool history. */
	redactSecrets?(text: string): string;
	useModel(
		modelType: TextGenerationModelType,
		params: {
			messages: ChatMessage[];
			maxTokens?: number;
			responseSchema?: unknown;
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
			prepareModelAttempt?: (
				attempt: ModelAttemptContext,
				params: {
					messages: ChatMessage[];
					promptSegments?: PromptSegment[];
					providerOptions?: Record<string, unknown>;
				},
			) => Promise<void> | void;
		},
		provider?: string,
	): Promise<EvaluatorModelResult>;
	logger?: {
		warn?: (context: unknown, message?: string) => void;
		debug?: (context: unknown, message?: string) => void;
	};
}

export interface EvaluatorEffects {
	copyToClipboard?: (
		clipboard: NonNullable<EvaluationResult["copyToClipboard"]>,
	) => Promise<void> | void;
	messageToUser?: (message: string) => Promise<void> | void;
}

export type EvaluatorOutput = EvaluationResult & {
	/** Model-selected proof for messageToUser; egress resolves these against this turn's results. */
	effectReceiptIds?: readonly string[];
	/** Captured final REPLY text and its own model-selected proof during missing-reply recovery. */
	plannerReply?: { text: string; effectReceiptIds: readonly string[] };
	nextTool?: PlannerToolCall;
	/** The model response violated the evaluator protocol. */
	protocolFailure?: true;
	parseError?: string;
	raw?: Record<string, unknown>;
};

export interface PlannerRuntime {
	getService?(service: string): unknown;
	/** Reauthorize deferred provider reads before restoring model context. */
	restoreProviderContext?(context: ContextObject): Promise<ContextObject>;
	/** Optional per-agent setting lookup used by guarded runtime features. */
	getSetting?(key: string): string | boolean | number | null;
	reportError?(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void;
	/**
	 * Runtime-known-secret redaction (character-configured values). Composed
	 * with the shared tool-shape patterns for every diagnostic projection of
	 * tool-call arguments; when absent the shape pass still applies.
	 */
	redactSecrets?(text: string): string;
	useModel(
		modelType: TextGenerationModelType,
		params: {
			messages: ChatMessage[];
			maxTokens?: number;
			tools?: ToolDefinition[];
			toolChoice?: ToolChoice;
			responseSchema?: unknown;
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
		},
		provider?: string,
	): Promise<string | GenerateTextResult>;
	logger?: {
		debug?: (context: unknown, message?: string) => void;
		warn?: (context: unknown, message?: string) => void;
		error?: (context: unknown, message?: string) => void;
	};
}

/**
 * Evidence that the executor ran an umbrella call which omitted its
 * discriminator as the promoted child the umbrella's `inferSubaction` named,
 * pinning `discriminator: value` into the executed arguments instead of
 * delegating to the sub-planner. The planner's recorded call keeps its
 * original arguments; the trajectory's tool stage carries this on the result.
 */
export interface InferredSubactionDispatch {
	/** Promoted child the arguments resolved to, e.g. `MEMORY_CREATE`. */
	child: string;
	/** Umbrella discriminator parameter that was pinned, e.g. `action`. */
	discriminator: string;
	/** Pinned discriminator value, e.g. `create`. */
	value: string;
}

export interface PlannerToolResult {
	success: boolean;
	/**
	 * Verdict the sub-planner's own evaluator reached over this umbrella
	 * action's recorded child results (same planner context, same declared
	 * intents). A FINISH here is a completed intent evaluation; the outer loop
	 * may adopt it instead of judging the same results a second time.
	 */
	subPlannerEvaluation?: {
		decision: "FINISH";
		success: boolean;
		messageToUser?: string;
	};
	/** Set when an umbrella call was dispatched through `inferSubaction`. */
	inferredSubaction?: InferredSubactionDispatch;
	/**
	 * Diagnostic / log-shaped projection of the tool's output. Goes into
	 * the trajectory and the planner's tool-result message. Used by the
	 * model to reason about success/failure and to decide the next step.
	 *
	 * **Never** rendered directly to the user — this often contains
	 * wrapper formatting (shell prompts, exit codes, cwd, byte counts,
	 * stderr-vs-stdout separators). Tools that want their output to be
	 * shown to the user verbatim must set `userFacingText` separately.
	 */
	text?: string;
	/** Machine-only raw output that must not render as assistant prose. */
	transcriptVisibility?: "internal";
	/**
	 * Optional user-facing projection of the tool's output. When set,
	 * the planner-loop's terminal-FINISH fallback may use this as the
	 * `finalMessage` shown to the user — instead of leaking the tool's
	 * diagnostic `text` wrapper.
	 *
	 * Tools that produce a true user-facing answer (Q&A tools, REPLY
	 * actions, content generators) should set this. Tools that emit
	 * logs (BASH, SHELL, fetchers, file readers) should leave it
	 * undefined; in that case the framework falls through to the
	 * evaluator's synthesized reply rather than dumping shell-wrapper
	 * text into the user channel.
	 *
	 * By default an explicit evaluator `messageToUser` outranks this —
	 * the evaluator has seen the full trajectory and chose what the
	 * user should read. To mark `userFacingText` as canonical
	 * (do-not-paraphrase) and have it outrank the evaluator's reply
	 * when there is exactly one completed tool result, set
	 * `verifiedUserFacing: true`.
	 */
	userFacingText?: string;
	/**
	 * Marks `userFacingText` as the canonical answer for this turn —
	 * the evaluator's `messageToUser` MUST NOT paraphrase it. When set
	 * AND there is exactly one completed tool result with
	 * `userFacingText`, the planner-loop prefers the tool's text over
	 * the evaluator's reply for the terminal-FINISH `finalMessage`.
	 *
	 * Use when the tool's output is structured data or a confirmation
	 * preview the evaluator can easily hallucinate (paths, ids, counts,
	 * numeric metrics, saved-vs-preview state) and any paraphrase risk is
	 * worse than echoing the tool verbatim. Leave unset for
	 * natural-language answers where the evaluator may legitimately
	 * rephrase or add framing.
	 */
	verifiedUserFacing?: boolean;
	/** Canonical mutation outcomes propagated from the action result. */
	effectReceipts?: readonly EffectReceipt[];
	/** Receipt IDs described by the exact canonical user-facing text. */
	userFacingEffectReceiptIds?: readonly string[];
	/**
	 * Owner-declared short summary of a successful action result. Used only for
	 * synthesized planner fallback replies when the model/evaluator emitted no
	 * clean final message.
	 */
	summary?: string;
	data?: Record<string, unknown>;
	/** Model-bound projection of `data`; complete data remains on the result. */
	promptData?: Record<string, unknown>;
	/** Producer-declared complete model projection; absent preserves both fields. */
	promptDataMode?: "replace-data";
	error?: unknown;
	/** Typed boundary provenance retained through planner retry exhaustion. */
	failureProvenance?: ActionFailureProvenance;
	/** Reply unavailable is independent of the completed tool outcome. */
	replyFailure?: ActionReplyFailure;
	/**
	 * Action-owned completion signal that is honored only for a single executed
	 * tool after the plan queue drains and the successful result carries verified
	 * canonical user-facing text. It never discards already-queued calls or
	 * replaces evaluation of a multi-tool turn. `false` explicitly requires
	 * evaluation, while omission delegates completion to the planner/evaluator.
	 */
	turnComplete?: boolean;
	/**
	 * Requests one safe model-authored terminal reply after a successful sole
	 * action whose planner call explicitly declared final scope.
	 */
	modelReplyRequired?: boolean;
	/** Vetted action-owned fallback for a failed required model synthesis. */
	modelReplyFallback?: string;
	/**
	 * Explicit chain-control override. `false` unconditionally aborts the
	 * remaining planner queue, including for legacy failure and fire-and-forget
	 * results. It is distinct from the conservative `turnComplete` fast path.
	 */
	continueChain?: boolean;
}

export interface PlannerStep {
	iteration: number;
	thought?: string;
	toolCall?: PlannerToolCall;
	result?: PlannerToolResult;
	terminalMessage?: string;
	terminalOnly?: boolean;
}

export interface PlannerTrajectory {
	context: ContextObject;
	/** Immutable turn context used as the byte-stable model prefix. */
	modelBaseContext?: ContextObject;
	/**
	 * Immutable evaluator prefix: the same turn context composed without the
	 * providers the evaluator never reads (EVALUATOR_STAGE_PROVIDER_EXCLUSIONS).
	 * Absent, the evaluator renders modelBaseContext exactly as before.
	 */
	evaluatorBaseContext?: ContextObject;
	/** Complete append-only assistant/tool/feedback suffix sent to the model. */
	modelHistory?: ChatMessage[];
	/** Internal execution-mode provenance for mode-specific terminal handling. */
	codingMode?: boolean;
	steps: PlannerStep[];
	archivedSteps: PlannerStep[];
	plannedQueue: PlannerToolCall[];
	evaluatorOutputs: EvaluatorOutput[];
}

export interface PlannerTerminalFailure {
	kind:
		| "coding_mutation_unverified"
		| "coding_verification_failed"
		| "coding_tool_failure"
		| ActionReplyFailure["kind"]
		| ActionFailureKind;
	transient: boolean;
	message: string;
	/** Action boundary code when the failing tool supplied typed provenance. */
	code?: string;
}

export interface PlannerLoopResult {
	status: "finished" | "continued";
	trajectory: PlannerTrajectory;
	evaluator?: EvaluatorOutput;
	finalMessage?: string;
	/**
	 * Machine-readable terminal failure that survives independent text delivery.
	 * The message service propagates this outside `responseContent`, so a host
	 * cannot mistake a callback-delivered failure for a successful turn.
	 */
	terminalFailure?: PlannerTerminalFailure;
	/**
	 * Marks a turn whose empty `finalMessage` is a designed outcome — the
	 * planner ended on STOP/IGNORE or a `suppressPlannerReply` terminal action —
	 * so the tool-turn reply guarantee (`runPlannerLoop`'s post-pass) never
	 * "fixes" deliberate silence into a synthesized reply.
	 */
	endedWithDeliberateSilence?: boolean;
	/**
	 * Which silent terminal ended the turn when `endedWithDeliberateSilence`
	 * is set from a STOP/IGNORE/NONE-only terminal (NONE folds into IGNORE).
	 * Lets the message handler record the turn under the action the model
	 * actually chose instead of hardcoding IGNORE. Absent on the
	 * `suppressPlannerReply` action path, where the silence belongs to a
	 * real action whose result is already recorded.
	 */
	silentTerminalAction?: "IGNORE" | "STOP";
	/** Aggregate provider-reported usage across the complete planner turn. */
	modelUsage?: {
		promptTokens: number;
		completionTokens: number;
		modelCalls: number;
	};
}

export interface PlannerLoopParams {
	runtime: PlannerRuntime;
	context: ContextObject;
	/** Evaluator-scoped composition of `context`; see PlannerTrajectory.evaluatorBaseContext. */
	evaluatorContext?: ContextObject;
	/**
	 * A sole tool result that already completed outside the planner loop and
	 * explicitly requested a model-authored final reply. The loop starts from
	 * this settled step and performs only the guarded no-tools synthesis round.
	 */
	postToolReplySeed?: {
		toolCall: PlannerToolCall;
		result: PlannerToolResult;
	};
	/** Trusted per-turn coding-loop mode; never used as an authorization signal. */
	codingMode?: boolean;
	config?: Partial<ChainingLoopConfig>;
	executeToolCall: (
		toolCall: PlannerToolCall,
		context: {
			trajectory: PlannerTrajectory;
			iteration: number;
			/**
			 * The planner's explicit completion declaration for the batch that
			 * produced this call. `false` means any handler callback is an
			 * intermediate implementation detail rather than the turn's reply.
			 */
			plannerCompleted?: boolean;
		},
	) => Promise<PlannerToolResult> | PlannerToolResult;
	evaluate?: (params: {
		runtime: PlannerRuntime;
		context: ContextObject;
		trajectory: PlannerTrajectory;
	}) => Promise<EvaluatorOutput> | EvaluatorOutput;
	onToolCallEnqueued?: (
		toolCall: PlannerToolCall,
		context: { iteration: number },
	) => Promise<void> | void;
	modelType?: TextGenerationModelType;
	evaluatorEffects?: EvaluatorEffects;
	provider?: string;
	/** @internal Shared turn-level observer, including terminal rescue calls. */
	onModelUsage?: (usage: {
		promptTokens: number;
		completionTokens: number;
	}) => void;
	/** Native tool definitions exposed to the planner model. */
	tools?: ToolDefinition[];
	/** Native tool selection policy. Defaults to "auto" when tools is non-empty. */
	toolChoice?: ToolChoice;
	/**
	 * When true, terminal planner output is only valid after at least one
	 * non-terminal tool has executed for the current turn.
	 */
	requireNonTerminalToolCall?: boolean;
	/**
	 * The Stage-1 router's own replyText for this turn, when it produced one.
	 * When the required-tool gate exhausts its miss budget without a captured
	 * refusal, the loop finishes with this text (shape-guarded) instead of
	 * throwing `TrajectoryLimitExceeded` — the router's real answer is
	 * strictly better than the generic transient-failure apology the caller
	 * would otherwise substitute for it (observed live: "whats 17 times 23?"
	 * answered "391" by Stage 1, then discarded for the apology when an
	 * injected VIEWS candidate deadlocked the required-tool gate).
	 */
	stageOneReplyText?: string;
	/**
	 * Per-turn override that SHRINKS the required-tool miss budget (never
	 * grows it — the effective budget is `min(config.maxRequiredToolMisses,
	 * override)`). Threaded by the message service on turns Stage 1 already
	 * answered where the only tool "evidence" is a text-inferred view-surface
	 * token overlap (e.g. "close a window in vim" matching the views action's
	 * WINDOW noun): the stage-1 answer is the almost-certain outcome, so the
	 * rescue should fire after ONE rejected planner answer instead of burning
	 * the full budget (~13s of wasted re-prompts observed live). Honored only
	 * when `stageOneReplyText` passes the answer-shape gate — without a
	 * finishable answer the full budget applies so corrective retries keep
	 * their chance to convert the planner.
	 */
	requiredToolMissBudgetOverride?: number;
	/**
	 * Evidence class for required-tool enforcement: "inferred" when the
	 * candidates behind `requireNonTerminalToolCall` came only from a relaxable
	 * deterministic heuristic (see MessageHandlerPlan.requiredToolEvidence).
	 * Strong coding-work inference and model-authored candidates omit this
	 * marker and keep the full corrective budget. Inferred evidence is weaker —
	 * when the planner re-commits to the
	 * IDENTICAL terminal answer on consecutive misses, the loop accepts it
	 * (mirroring the widget-identity early-finish, #15230) instead of
	 * burning the full miss budget on the heuristic's guess. Omitted (the
	 * model named the tool itself) keeps the full corrective budget.
	 */
	requiredToolEvidence?: "inferred";
	/**
	 * Trajectory recorder for v5 observability. When supplied, the planner
	 * loop records one stage per planner call, tool execution, and evaluator
	 * call. When omitted the loop is unaffected.
	 */
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	/** Stable room/session identity used only for provider prompt-cache affinity. */
	cacheConversationId?: string;
	parentStageId?: string;
	providerAttributionState?: State;
}

export interface RunEvaluatorParams {
	runtime: EvaluatorRuntime;
	context: ContextObject;
	trajectory: PlannerTrajectory;
	modelType?: TextGenerationModelType;
	effects?: EvaluatorEffects;
	provider?: string;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	/** Stable room/session identity used only for provider prompt-cache affinity. */
	cacheConversationId?: string;
	parentStageId?: string;
	iteration?: number;
	onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}
