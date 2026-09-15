/**
 * Canonical type definitions for the trajectory subsystem: recorded LLM-call,
 * provider-access, skill-invocation, and step records; per-trajectory summary,
 * usage-totals, and cache-stats shapes; and the eliza-native export row and
 * format tag that the export helpers and training pipelines consume.
 */

import type { TrajectoryProviderAttribution } from "../runtime/trajectory-provider-attribution";
import type { JsonValue } from "../types/primitives.ts";
import type { TrajectorySemanticStageRecord } from "./trajectory-semantic-stage";

// Re-export the canonical retrieval-funnel shapes from `trajectory-recorder`
// so external consumers depend on the services-layer surface instead of
// reaching into runtime/.
export type {
	RecordedRetrievalPerStageScores,
	RecordedRetrievalStageEntry,
	RecordedToolSearchStage,
} from "../runtime/trajectory-recorder.ts";

export const ELIZA_NATIVE_TRAJECTORY_FORMAT = "eliza_native_v1" as const;

export type ElizaNativeTrajectoryFormat = typeof ELIZA_NATIVE_TRAJECTORY_FORMAT;

export const ELIZA_NATIVE_MODEL_BOUNDARIES = [
	"vercel_ai_sdk.generateText",
	"vercel_ai_sdk.streamText",
] as const;

export type ElizaNativeModelBoundary =
	(typeof ELIZA_NATIVE_MODEL_BOUNDARIES)[number];

export type TrajectoryStatus =
	| "active"
	| "completed"
	| "error"
	| "timeout"
	| "terminated";

export interface TrajectoryListOptions {
	/** Exact recorded room ownership, independent of free-text search. */
	roomId?: string;
	limit?: number;
	offset?: number;
	source?: string;
	status?: TrajectoryStatus;
	runId?: string;
	traceId?: string;
	startDate?: string;
	endDate?: string;
	search?: string;
	scenarioId?: string;
	batchId?: string;
	isTrainingData?: boolean;
}

export interface TrajectorySummaryRecord {
	id: string;
	agentId: string;
	source: string;
	status: TrajectoryStatus;
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	llmCallCount: number;
	providerAccessCount: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadInputTokens?: number;
	totalCacheCreationInputTokens?: number;
	scenarioId?: string | null;
	batchId?: string | null;
	createdAt: string;
	stepCount?: number;
	totalReward?: number;
	roomId?: string | null;
	entityId?: string | null;
	conversationId?: string | null;
	updatedAt?: string;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface TrajectoryListResult<
	TTrajectory extends TrajectorySummaryRecord = TrajectorySummaryRecord,
> {
	trajectories: TTrajectory[];
	total: number;
	offset: number;
	limit: number;
}

export type TrajectoryScalar = string | number | boolean | null;
export type TrajectoryData = Record<string, TrajectoryScalar>;

export interface TrajectoryLlmCallRecord {
	callId?: string;
	stepId?: string;
	trajectoryId?: string;
	timestamp?: number;
	provider?: string;
	model?: string;
	modelVersion?: string;
	modelType?: string;
	systemPrompt?: string;
	userPrompt?: string;
	prompt?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	response?: string;
	toolCalls?: unknown[];
	finishReason?: string;
	providerMetadata?: unknown;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	maxTokensOmitted?: boolean;
	topP?: number;
	purpose?: string;
	actionType?: string;
	stepType?: string;
	tags?: string[];
	latencyMs?: number;
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	modelSlot?: string;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
	createdAt?: string;
	tokenUsageEstimated?: boolean;
	providerOrder?: string[];
	providerAttributions?: TrajectoryProviderAttribution[];
}

export interface TrajectoryProviderAccessRecord {
	providerId?: string;
	stepId?: string;
	trajectoryId?: string;
	providerName?: string;
	purpose?: string;
	data?: Record<string, unknown>;
	sha256?: string;
	tokenCount?: number;
	position?: number;
	spanStart?: number;
	spanEnd?: number;
	query?: Record<string, unknown>;
	timestamp?: number;
	startedAt?: number | null;
	endedAt?: number | null;
	durationMs?: number | null;
	overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
	createdAt?: string;
}

export type TrajectoryStepKind = "llm" | "action" | "evaluator";

export type TrajectoryStepId = string;

/** One normalized action settlement persisted on its owning trajectory step. */
export interface TrajectoryActionAttemptRecord {
	attemptId: string;
	timestamp: number;
	actionType: string;
	actionName: string;
	parameters: Record<string, JsonValue>;
	success: boolean;
	result?: Record<string, JsonValue>;
	error?: string;
	reasoning?: string;
	llmCallId?: string;
	immediateReward?: number;
}

/**
 * Legacy loss marker persisted in historical per-skill invocation records.
 */
export interface TrajectorySkillInvocationTruncationMarker {
	field: "args" | "result";
	originalBytes: number;
	capBytes: number;
}

/**
 * One captured skill invocation. Every USE_SKILL execution emits one of
 * these against the active trajectory step so the trajectory viewer and
 * training pipelines can replay the skill seam in full detail.
 *
 * Shape mirrors the tool-stage capture: complete encoded JSON strings for
 * structured fields. `args` and `result` are stored pre-encoded so reads do not
 * need to re-parse; consumers can `JSON.parse` when they need the
 * structured form.
 */
export interface TrajectorySkillInvocationRecord {
	/** Canonical skill identifier (the slug enabled by the agent). */
	skillSlug: string;
	/** Encoded handler input (JSON string when structured, plain when not). */
	args?: string;
	/** Encoded handler output (JSON string when structured, plain when not). */
	result?: string;
	/** Wall-clock duration of the skill execution. */
	durationMs: number;
	/**
	 * Trajectory step under which the invocation ran. Mirrors the parent
	 * relationship the database trajectory logger uses for child steps.
	 */
	parentStepId: TrajectoryStepId;
	/**
	 * Identifier of the script that was run, when invocation went through
	 * the bundled-script path (`mode='script'`). Absent for guidance-mode.
	 */
	script?: string;
	/** `"script"` or `"guidance"`. */
	mode?: "script" | "guidance";
	/** Whether the skill reported a successful run. */
	success: boolean;
	/** ms-epoch when the invocation started. */
	startedAt: number;
	/** Legacy loss markers read from historical rows; new captures omit them. */
	truncated?: TrajectorySkillInvocationTruncationMarker[];
}

export interface TrajectoryStepRecord {
	stepId?: TrajectoryStepId;
	parentStepId?: TrajectoryStepId;
	timestamp: number;
	llmCalls?: TrajectoryLlmCallRecord[];
	providerAccesses?: TrajectoryProviderAccessRecord[];
	action?: TrajectoryActionAttemptRecord;
	kind?: TrajectoryStepKind;
	childSteps?: TrajectoryStepId[];
	script?: string;
	scriptHash?: string;
	usedSkills?: string[];
	/**
	 * Per-skill invocation records. Each record carries
	 * `(skillSlug, args, result, durationMs, parentStepId)` plus mode/script
	 * metadata so the trajectory viewer can render the skill seam without
	 * re-running the action.
	 */
	skillInvocations?: TrajectorySkillInvocationRecord[];
	/**
	 * Name of the evaluator that produced this step. Only set when
	 * `kind === "evaluator"`. Every evaluator turn emits an EVALUATOR step
	 * wrapping its model call as a child so reviewers and training pipelines
	 * can isolate the evaluator seam.
	 */
	evaluatorName?: string;
	/** Ordered semantic stages captured during this step's runtime work. */
	semanticStages?: TrajectorySemanticStageRecord[];
}

export interface TrajectoryUsageTotalsRecord {
	stepCount: number;
	llmCallCount: number;
	providerAccessCount: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

export interface TrajectoryCacheStatsRecord {
	totalInputTokens: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cachedCallCount: number;
	cacheReadCallCount: number;
	cacheWriteCallCount: number;
	tokenUsageEstimatedCallCount: number;
}

export interface TrajectoryDetailRecord {
	trajectoryId: string;
	agentId: string;
	source?: string;
	status?: TrajectoryStatus;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	scenarioId?: string;
	batchId?: string;
	steps?: TrajectoryStepRecord[];
	metrics?: Record<string, JsonValue | undefined> & {
		finalStatus?: string;
		/** Step count at last persist; required by Core validators (#17730). */
		episodeLength?: number;
	};
	/** Plain JSON-like bag; values are not validated as {@link JsonValue} at the boundary. */
	metadata?: Record<string, unknown>;
	stepsJson?: string;
	totals?: TrajectoryUsageTotalsRecord;
}

export interface TrajectoryFlattenedLlmCallRecord
	extends TrajectoryLlmCallRecord {
	trajectoryId: string;
	agentId: string;
	source?: string;
	status: TrajectoryStatus;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	scenarioId?: string;
	batchId?: string;
	callId: string;
	stepId: string;
	stepIndex: number;
	stepTimestamp: number;
	stepKind?: TrajectoryStepKind;
	callIndex: number;
	timestamp: number;
	tags: string[];
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	tokenUsageEstimated: boolean;
	trajectoryMetrics?: Record<string, JsonValue | undefined>;
	stepData?: Omit<
		TrajectoryStepRecord,
		"stepId" | "timestamp" | "llmCalls" | "providerAccesses"
	>;
}

export interface ElizaNativeModelRequestRecord {
	prompt?: string;
	system?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	settings?: {
		temperature?: number;
		maxOutputTokens?: number;
		topP?: number;
	};
}

export interface ElizaNativeModelResponseRecord {
	text: string;
	toolCalls?: unknown[];
	finishReason?: string;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
	};
	providerMetadata?: unknown;
}

export interface ElizaNativeTrajectoryRow
	extends Pick<
		TrajectoryFlattenedLlmCallRecord,
		| "trajectoryId"
		| "agentId"
		| "source"
		| "status"
		| "scenarioId"
		| "batchId"
		| "stepId"
		| "callId"
		| "stepIndex"
		| "callIndex"
		| "timestamp"
		| "purpose"
		| "actionType"
		| "stepType"
		| "tags"
		| "model"
		| "modelVersion"
		| "modelType"
		| "provider"
	> {
	format: ElizaNativeTrajectoryFormat;
	schemaVersion: 1;
	boundary: ElizaNativeModelBoundary;
	request: ElizaNativeModelRequestRecord;
	response: ElizaNativeModelResponseRecord;
	metadata: Record<string, unknown>;
	trajectoryTotals: TrajectoryUsageTotalsRecord;
	cacheStats: TrajectoryCacheStatsRecord;
}

export type TrajectoryJsonShape = ElizaNativeTrajectoryFormat;

export type TrajectoryExportFormat = "json" | "jsonl" | "csv" | "art" | "zip";

export interface TrajectoryExportOptions {
	format: TrajectoryExportFormat;
	jsonShape?: TrajectoryJsonShape;
	includePrompts?: boolean;
	trajectoryIds?: string[];
	source?: string;
	status?: TrajectoryStatus;
	runId?: string;
	search?: string;
	startDate?: string;
	endDate?: string;
	scenarioId?: string;
	traceId?: string;
	batchId?: string;
}

export interface TrajectoryExportResult {
	filename: string;
	data: string | Uint8Array;
	mimeType: string;
}
