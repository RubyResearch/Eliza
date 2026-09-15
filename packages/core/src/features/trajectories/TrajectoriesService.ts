/**
 * Persists runtime trajectories, step indexes, model calls, and reward metadata
 * for replay, UI inspection, export, and training-data collection.
 */

import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../../errors";
import { logger } from "../../logger";
import { serializeTrajectoryExport } from "../../services/trajectory-export";
import {
	createTrajectoryJsonBudget,
	sanitizeTrajectoryJsonValue,
	sanitizeTrajectoryJsonValueInBudget,
} from "../../services/trajectory-json";
import type {
	TrajectoryExportOptions as CanonicalTrajectoryExportOptions,
	TrajectoryDetailRecord,
	TrajectoryExportResult,
} from "../../services/trajectory-types";

/** Public alias for {@link CanonicalTrajectoryExportOptions} (canonical type lives in services). */
export type TrajectoryExportOptions = CanonicalTrajectoryExportOptions;

import {
	canonicalPromptForModelCall,
	omitUnvalidatedProviderSpans,
} from "../../runtime/trajectory-provider-attribution";
import type { RecordedStage } from "../../runtime/trajectory-recorder";
import {
	resolveTrajectoryDir,
	resolveTrajectoryRetentionDays,
	sweepTrajectoryFiles,
} from "../../runtime/trajectory-recorder";
import {
	composeToolDiagnosticRedactor,
	projectProtectedModelCallValue,
	projectToolDiagnosticValue,
} from "../../security/tool-diagnostics";
import {
	parseTrajectorySemanticStages,
	recordedStageToSemanticStage,
	type TrajectorySemanticStageRecord,
} from "../../services/trajectory-semantic-stage";
import type { TrajectoryRuntimeLlmCallParams } from "../../trajectory-utils";
import type { IAgentRuntime } from "../../types";
import { Service } from "../../types/service";

import type {
	ActionAttempt,
	EnvironmentState,
	JsonObject,
	JsonValue,
	LLMCall,
	ProviderAccess,
	RewardComponents,
	Trajectory,
	TrajectoryStep,
} from "./types";

// ============================================================================
// Database Row Types
// ============================================================================

type SqlPrimitive = string | number | boolean | null;
interface SqlCellArray extends Array<SqlCell> {}
type SqlCell = SqlPrimitive | Date | SqlRow | SqlCellArray;
interface SqlRow {
	[key: string]: SqlCell;
}

interface SqlExecuteResult {
	rows: SqlRow[];
	fields?: Array<{ name: string }>;
}

type TrajectorySqlResult = { rows: SqlRow[]; columns: string[] };
type TrajectorySqlExecutor = (sqlText: string) => Promise<TrajectorySqlResult>;

// ============================================================================
// List/Filter Options
// ============================================================================

export interface TrajectoryListOptions {
	roomId?: string;
	limit?: number;
	offset?: number;
	status?: "active" | "completed" | "error" | "timeout" | "terminated";
	source?: string;
	runId?: string;
	startDate?: string;
	endDate?: string;
	search?: string;
	scenarioId?: string;
	/** Correlation join key (#13775): all trajectories in one root turn's trace. */
	traceId?: string;
	batchId?: string;
	isTrainingData?: boolean;
}

export interface TrajectoryListResult {
	trajectories: TrajectoryListItem[];
	total: number;
	offset: number;
	limit: number;
}

export interface TrajectoryListItem {
	id: string;
	agentId: string;
	source: string;
	roomId: string | null;
	entityId: string | null;
	metadata: Record<string, JsonValue | undefined>;
	status: "active" | "completed" | "error" | "timeout" | "terminated";
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	stepCount: number;
	llmCallCount: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadInputTokens?: number;
	totalCacheCreationInputTokens?: number;
	totalReward: number;
	scenarioId: string | null;
	batchId: string | null;
	createdAt: string;
	updatedAt?: string;
}

export interface TrajectoryStats {
	totalTrajectories: number;
	totalSteps: number;
	totalLlmCalls: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadInputTokens: number;
	totalCacheCreationInputTokens: number;
	averageDurationMs: number;
	averageReward: number;
	bySource: Record<string, number>;
	byStatus: Record<string, number>;
	byScenario: Record<string, number>;
}

export interface TrajectoryZipExportOptions {
	includePrompts?: boolean;
	trajectoryIds?: string[];
	source?: string;
	status?: "active" | "completed" | "error" | "timeout" | "terminated";
	runId?: string;
	search?: string;
	startDate?: string;
	endDate?: string;
	scenarioId?: string;
	/** Correlation join key (#13775): all trajectories in one root turn's trace. */
	traceId?: string;
	batchId?: string;
}

export interface TrajectoryZipEntry {
	name: string;
	data: string;
}

export interface TrajectoryZipExportResult {
	filename: string;
	entries: TrajectoryZipEntry[];
}

// ============================================================================
// SQL Helpers
// ============================================================================

function asNumber(value: SqlCell | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function asString(value: SqlCell | undefined): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value instanceof Date) return value.toISOString();
	return null;
}

function asIsoString(value: SqlCell | undefined): string | null {
	if (value instanceof Date) return value.toISOString();
	const asText = asString(value);
	if (!asText) return null;
	const parsed = new Date(asText);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

function requiredTrajectoryCell<T>(
	value: T | null,
	field: string,
	rowId?: string | null,
): T {
	if (value !== null) return value;
	throw new ElizaError(`Trajectory database row has an invalid ${field}`, {
		code: "TRAJECTORY_ROW_INVALID",
		context: { field, ...(rowId ? { rowId } : {}) },
	});
}

function asEpochMs(value: SqlCell | undefined): number | null {
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}
	const directNumber = asNumber(value);
	if (directNumber !== null) return directNumber;
	const asText = asString(value);
	if (!asText) return null;
	const parsed = Date.parse(asText);
	return Number.isFinite(parsed) ? parsed : null;
}

function pickCell(row: SqlRow, ...keys: string[]): SqlCell | undefined {
	for (const key of keys) {
		if (Object.hasOwn(row, key)) {
			return row[key];
		}
	}
	return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (isPlainRecord(value)) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function isJsonObject(value: unknown): value is JsonObject {
	return isPlainRecord(value) && isJsonValue(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function stringArrayValue(value: unknown): string[] | undefined {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

function sanitizeTrajectoryJsonArray(value: unknown): unknown[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = sanitizeTrajectoryJsonValue(value);
	return Array.isArray(sanitized) ? sanitized : undefined;
}

function sanitizeTrajectoryJsonOptional(value: unknown): unknown | undefined {
	return sanitizeTrajectoryJsonValue(value);
}

function sanitizeTrajectoryText(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = sanitizeTrajectoryJsonValue(value);
	return typeof sanitized === "string" ? sanitized : undefined;
}

function stringifyTrajectoryJsonForSql(value: unknown): string {
	const sanitized = sanitizeTrajectoryJsonValue(value);
	return JSON.stringify(sanitized === undefined ? null : sanitized);
}

function isEmbeddingLlmCall(params: TrajectoryRuntimeLlmCallParams): boolean {
	return (
		params.modelType === "TEXT_EMBEDDING" || params.purpose === "embedding"
	);
}

function parseJsonCell(cell: SqlCell | undefined): JsonValue | undefined {
	if (typeof cell === "string") {
		const parsed: unknown = JSON.parse(cell);
		if (!isJsonValue(parsed)) {
			throw new ElizaError("Trajectory database cell is not valid JSON data", {
				code: "TRAJECTORY_JSON_CELL_INVALID",
				context: { valueType: typeof parsed },
			});
		}
		return parsed;
	}
	return isJsonValue(cell) ? cell : undefined;
}

function parseJsonObjectCell(
	cell: SqlCell | undefined,
): JsonObject | undefined {
	const value = parseJsonCell(cell);
	return isJsonObject(value) ? value : undefined;
}

function normalizeEnvironmentState(value: unknown): EnvironmentState | null {
	if (!isPlainRecord(value)) return null;
	const timestamp = numberValue(value.timestamp);
	const agentBalance = numberValue(value.agentBalance);
	const agentPoints = numberValue(value.agentPoints);
	const agentPnL = numberValue(value.agentPnL);
	const openPositions = numberValue(value.openPositions);
	if (timestamp === null) return null;
	const state: EnvironmentState = { timestamp };
	if (agentBalance !== null) state.agentBalance = agentBalance;
	if (agentPoints !== null) state.agentPoints = agentPoints;
	if (agentPnL !== null) state.agentPnL = agentPnL;
	if (openPositions !== null) state.openPositions = openPositions;
	for (const key of [
		"activeMarkets",
		"portfolioValue",
		"unreadMessages",
		"recentEngagement",
	] as const) {
		const numericValue = numberValue(value[key]);
		if (numericValue !== null) {
			state[key] = numericValue;
		}
	}
	if (isJsonObject(value.custom)) {
		state.custom = value.custom;
	}
	return state;
}

function normalizeLlmCall(value: unknown): LLMCall | null {
	if (!isPlainRecord(value)) return null;
	const callId = stringValue(value.callId);
	const timestamp = numberValue(value.timestamp);
	const model = stringValue(value.model);
	const systemPrompt = stringValue(value.systemPrompt);
	const userPrompt = stringValue(value.userPrompt);
	const response = stringValue(value.response);
	const temperature = numberValue(value.temperature);
	const maxTokens = numberValue(value.maxTokens);
	const purpose = stringValue(value.purpose);
	if (
		!callId ||
		timestamp === null ||
		!model ||
		systemPrompt === null ||
		userPrompt === null ||
		response === null ||
		!purpose
	) {
		return null;
	}
	const call: LLMCall = {
		callId,
		timestamp,
		model,
		systemPrompt,
		userPrompt,
		response,
		...(temperature !== null ? { temperature } : {}),
		...(maxTokens !== null ? { maxTokens } : {}),
		maxTokensOmitted: value.maxTokensOmitted === true ? true : undefined,
		purpose,
	};
	for (const key of [
		"modelVersion",
		"modelType",
		"provider",
		"prompt",
		"finishReason",
		"reasoning",
		"actionType",
		"stepType",
		"modelSlot",
		"runId",
		"roomId",
		"messageId",
		"executionTraceId",
	] as const) {
		const textValue = stringValue(value[key]);
		if (textValue !== null) {
			call[key] = textValue;
		}
	}
	for (const key of [
		"topP",
		"promptTokens",
		"completionTokens",
		"latencyMs",
		"cacheReadInputTokens",
		"cacheCreationInputTokens",
		"reasoningTokens",
	] as const) {
		const numericValue = numberValue(value[key]);
		if (numericValue !== null) {
			call[key] = numericValue;
		}
	}
	const tags = stringArrayValue(value.tags);
	if (tags) call.tags = tags;
	const providerOrder = stringArrayValue(value.providerOrder);
	if (providerOrder) call.providerOrder = providerOrder;
	if (Array.isArray(value.providerAttributions)) {
		call.providerAttributions =
			value.providerAttributions as LLMCall["providerAttributions"];
	}
	if (Array.isArray(value.messages)) call.messages = value.messages;
	if (Array.isArray(value.toolCalls)) call.toolCalls = value.toolCalls;
	if ("tools" in value) call.tools = value.tools;
	if ("toolChoice" in value) call.toolChoice = value.toolChoice;
	if ("responseSchema" in value) call.responseSchema = value.responseSchema;
	if ("providerOptions" in value) call.providerOptions = value.providerOptions;
	if ("providerMetadata" in value)
		call.providerMetadata = value.providerMetadata;
	return call;
}

function normalizeProviderAccess(value: unknown): ProviderAccess | null {
	if (!isPlainRecord(value)) return null;
	const providerId = stringValue(value.providerId);
	const providerName = stringValue(value.providerName);
	const timestamp = numberValue(value.timestamp);
	const data = isJsonObject(value.data) ? value.data : null;
	const purpose = stringValue(value.purpose);
	if (!providerId || !providerName || timestamp === null || !data || !purpose) {
		return null;
	}
	const access: ProviderAccess = {
		providerId,
		providerName,
		timestamp,
		startedAt: numberValue(value.startedAt),
		endedAt: numberValue(value.endedAt),
		durationMs: numberValue(value.durationMs),
		overlapsWith: Array.isArray(value.overlapsWith)
			? value.overlapsWith.flatMap((entry) => {
					if (!isPlainRecord(entry)) return [];
					const overlapProviderName = stringValue(entry.providerName);
					const overlapMs = numberValue(entry.overlapMs);
					return overlapProviderName && overlapMs !== null
						? [{ providerName: overlapProviderName, overlapMs }]
						: [];
				})
			: [],
		data,
		purpose,
	};
	if (isJsonObject(value.query)) access.query = value.query;
	const sha256 = stringValue(value.sha256);
	if (sha256 !== null) access.sha256 = sha256;
	for (const key of [
		"tokenCount",
		"position",
		"spanStart",
		"spanEnd",
	] as const) {
		const numericValue = numberValue(value[key]);
		if (numericValue !== null) {
			access[key] = numericValue;
		}
	}
	for (const key of [
		"runId",
		"roomId",
		"messageId",
		"executionTraceId",
	] as const) {
		const textValue = stringValue(value[key]);
		if (textValue !== null) {
			access[key] = textValue;
		}
	}
	return access;
}

function normalizeActionAttempt(value: unknown): ActionAttempt | null {
	if (!isPlainRecord(value)) return null;
	const attemptId = stringValue(value.attemptId);
	const timestamp = numberValue(value.timestamp);
	const actionType = stringValue(value.actionType);
	const actionName = stringValue(value.actionName);
	const parameters = isJsonObject(value.parameters) ? value.parameters : null;
	const success = booleanValue(value.success);
	if (
		!attemptId ||
		timestamp === null ||
		!actionType ||
		!actionName ||
		!parameters ||
		success === null
	) {
		return null;
	}
	const action: ActionAttempt = {
		attemptId,
		timestamp,
		actionType,
		actionName,
		parameters,
		success,
	};
	const reasoning = stringValue(value.reasoning);
	if (reasoning !== null) action.reasoning = reasoning;
	const llmCallId = stringValue(value.llmCallId);
	if (llmCallId !== null) action.llmCallId = llmCallId;
	if (isJsonObject(value.result)) action.result = value.result;
	const error = stringValue(value.error);
	if (error !== null) action.error = error;
	const immediateReward = numberValue(value.immediateReward);
	if (immediateReward !== null) action.immediateReward = immediateReward;
	return action;
}

function normalizeTrajectoryStep(value: unknown): TrajectoryStep | null {
	if (!isPlainRecord(value)) return null;
	const stepId = stringValue(value.stepId);
	const stepNumber = numberValue(value.stepNumber);
	const timestamp = numberValue(value.timestamp);
	// Rows written before envelope-first persistence could lose trailing step
	// keys to sanitizer budget exhaustion (an oversized llmCall broke out of
	// the object walk mid-step). ABSENT fields therefore decode to their
	// startStep defaults so those rows stay readable and terminalizable;
	// fields that are present but mistyped still reject the step.
	const environmentState = Object.hasOwn(value, "environmentState")
		? normalizeEnvironmentState(value.environmentState)
		: timestamp !== null
			? { timestamp }
			: null;
	const observation = Object.hasOwn(value, "observation")
		? isJsonObject(value.observation)
			? value.observation
			: null
		: {};
	const llmCallsRaw = Object.hasOwn(value, "llmCalls") ? value.llmCalls : [];
	const providerAccessesRaw = Object.hasOwn(value, "providerAccesses")
		? value.providerAccesses
		: [];
	const hasAction = Object.hasOwn(value, "action");
	const action = hasAction ? normalizeActionAttempt(value.action) : null;
	const reward = Object.hasOwn(value, "reward") ? numberValue(value.reward) : 0;
	const done = Object.hasOwn(value, "done") ? booleanValue(value.done) : false;
	if (
		!stepId ||
		stepNumber === null ||
		timestamp === null ||
		!environmentState ||
		!observation ||
		!Array.isArray(llmCallsRaw) ||
		!Array.isArray(providerAccessesRaw) ||
		(hasAction && !action) ||
		reward === null ||
		done === null
	) {
		return null;
	}
	const llmCalls: LLMCall[] = [];
	for (const callValue of llmCallsRaw) {
		const call = normalizeLlmCall(callValue);
		if (!call) return null;
		llmCalls.push(call);
	}
	const providerAccesses: ProviderAccess[] = [];
	for (const accessValue of providerAccessesRaw) {
		const access = normalizeProviderAccess(accessValue);
		if (!access) return null;
		providerAccesses.push(access);
	}
	let semanticStages: TrajectorySemanticStageRecord[] | undefined;
	if (Object.hasOwn(value, "semanticStages")) {
		try {
			semanticStages = parseTrajectorySemanticStages(value.semanticStages);
		} catch {
			// error-policy:J3 a present-but-invalid stage envelope rejects the
			// step (returning null) instead of decoding to a fake-valid default.
			return null;
		}
	}
	const step: TrajectoryStep = {
		stepId,
		stepNumber,
		timestamp,
		environmentState,
		observation,
		llmCalls,
		providerAccesses,
		...(action ? { action } : {}),
		...(semanticStages !== undefined ? { semanticStages } : {}),
		reward,
		done,
	};
	const reasoning = stringValue(value.reasoning);
	if (reasoning !== null) step.reasoning = reasoning;
	if (isJsonObject(value.metadata)) step.metadata = value.metadata;
	return step;
}

function parseTrajectorySteps(cell: SqlCell | undefined): TrajectoryStep[] {
	const value = parseJsonCell(cell);
	if (!Array.isArray(value)) {
		throw new ElizaError("Trajectory steps must be a JSON array", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "steps_json" },
		});
	}
	const steps: TrajectoryStep[] = [];
	for (const stepValue of value) {
		const step = normalizeTrajectoryStep(stepValue);
		if (!step) {
			throw new ElizaError("Trajectory row contains an invalid step", {
				code: "TRAJECTORY_ROW_INVALID",
				context: { field: "steps_json", stepIndex: steps.length },
			});
		}
		steps.push(step);
	}
	return steps;
}

function parseRewardComponents(cell: SqlCell | undefined): RewardComponents {
	const value = parseJsonObjectCell(cell);
	if (!value || typeof value.environmentReward !== "number") {
		throw new ElizaError("Trajectory reward components are invalid", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "reward_components_json" },
		});
	}
	const reward: RewardComponents = {
		environmentReward: value.environmentReward,
	};
	if (typeof value.aiJudgeReward === "number") {
		reward.aiJudgeReward = value.aiJudgeReward;
	}
	if (isJsonObject(value.components)) {
		const components: NonNullable<RewardComponents["components"]> = {};
		for (const [key, componentValue] of Object.entries(value.components)) {
			if (typeof componentValue === "number") {
				components[key] = componentValue;
			}
		}
		reward.components = components;
	}
	const judgeModel = stringValue(value.judgeModel);
	if (judgeModel !== null) reward.judgeModel = judgeModel;
	const judgeReasoning = stringValue(value.judgeReasoning);
	if (judgeReasoning !== null) reward.judgeReasoning = judgeReasoning;
	if (typeof value.judgeTimestamp === "number") {
		reward.judgeTimestamp = value.judgeTimestamp;
	}
	return reward;
}

function parseTrajectoryMetrics(
	cell: SqlCell | undefined,
): Trajectory["metrics"] {
	const value = parseJsonObjectCell(cell);
	if (!value || typeof value.episodeLength !== "number") {
		throw new ElizaError("Trajectory metrics are invalid", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "metrics_json" },
		});
	}
	const finalStatus = value?.finalStatus;
	if (
		finalStatus !== "active" &&
		finalStatus !== "completed" &&
		finalStatus !== "terminated" &&
		finalStatus !== "error" &&
		finalStatus !== "timeout"
	) {
		throw new ElizaError("Trajectory metrics have an invalid final status", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "metrics_json.finalStatus" },
		});
	}
	const metrics: Trajectory["metrics"] = {
		episodeLength: value.episodeLength,
		finalStatus,
	};
	for (const [key, metricValue] of Object.entries(value)) {
		metrics[key] = metricValue;
	}
	return metrics;
}

function parseTrajectoryMetadata(
	cell: SqlCell | undefined,
): Trajectory["metadata"] {
	const value = parseJsonObjectCell(cell);
	if (!value) {
		throw new ElizaError("Trajectory metadata must be a JSON object", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "metadata_json" },
		});
	}
	return value;
}

function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "object")
		return `'${stringifyTrajectoryJsonForSql(v).replace(/'/g, "''")}'`;
	return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Persist steps envelope-first so a persisted row can ALWAYS be re-read by
 * `parseTrajectorySteps`. The fields the strict reader requires (stepId,
 * stepNumber, timestamp, environmentState, observation, reward, done) are
 * written from their typed in-memory values; only the bulky payload —
 * llmCalls, providerAccesses, action, reasoning, metadata — competes for the
 * shared sanitization budget. Whole-graph sanitization used to let budget
 * exhaustion inside one oversized llmCall (a planner call carrying large tool
 * schemas crosses the node cap by itself) break out of the step object and
 * drop its trailing required keys, poisoning the row for every subsequent
 * read: later captures were lost and terminalization failed permanently.
 *
 * A payload entry that no longer satisfies its read contract after bounding
 * is dropped and counted on `step.metadata.truncatedLlmCalls` /
 * `.truncatedProviderAccesses` instead of being persisted as garbage.
 */
function boundStepsForPersistence(steps: TrajectoryStep[]): JsonValue[] {
	const budget = createTrajectoryJsonBudget();
	return steps.map((step) => {
		const envCandidate = sanitizeTrajectoryJsonValueInBudget(
			step.environmentState,
			budget,
		);
		const environmentState: JsonValue = normalizeEnvironmentState(envCandidate)
			? (envCandidate as JsonValue)
			: { timestamp: step.timestamp };
		const observationCandidate = sanitizeTrajectoryJsonValueInBudget(
			step.observation,
			budget,
		);
		const observation: JsonValue = isJsonObject(observationCandidate)
			? observationCandidate
			: {};

		let truncatedLlmCalls = 0;
		const llmCalls: JsonValue[] = [];
		for (const call of step.llmCalls) {
			const bounded = sanitizeTrajectoryJsonValueInBudget(call, budget);
			if (bounded !== undefined && normalizeLlmCall(bounded)) {
				llmCalls.push(bounded);
			} else {
				truncatedLlmCalls += 1;
			}
		}
		let truncatedProviderAccesses = 0;
		const providerAccesses: JsonValue[] = [];
		for (const access of step.providerAccesses) {
			const bounded = sanitizeTrajectoryJsonValueInBudget(access, budget);
			if (bounded !== undefined && normalizeProviderAccess(bounded)) {
				providerAccesses.push(bounded);
			} else {
				truncatedProviderAccesses += 1;
			}
		}

		const actionCandidate =
			step.action === undefined
				? undefined
				: sanitizeTrajectoryJsonValueInBudget(step.action, budget);
		const action = normalizeActionAttempt(actionCandidate)
			? actionCandidate
			: undefined;
		const reasoningCandidate =
			typeof step.reasoning === "string"
				? sanitizeTrajectoryJsonValueInBudget(step.reasoning, budget)
				: undefined;
		const metadataCandidate =
			step.metadata === undefined
				? undefined
				: sanitizeTrajectoryJsonValueInBudget(step.metadata, budget);
		const metadataBase = isJsonObject(metadataCandidate)
			? metadataCandidate
			: undefined;
		const metadata =
			truncatedLlmCalls > 0 || truncatedProviderAccesses > 0
				? {
						...(metadataBase ?? {}),
						...(truncatedLlmCalls > 0 ? { truncatedLlmCalls } : {}),
						...(truncatedProviderAccesses > 0
							? { truncatedProviderAccesses }
							: {}),
					}
				: metadataBase;

		return {
			stepId: step.stepId,
			stepNumber: step.stepNumber,
			timestamp: step.timestamp,
			environmentState,
			observation,
			llmCalls,
			providerAccesses,
			...(action !== undefined ? { action } : {}),
			// Pre-bounded by the shared semantic-stage validator on write; they
			// bypass the sanitizer budget so an oversized llmCall cannot evict a
			// decision envelope (and vice versa).
			...(step.semanticStages !== undefined
				? { semanticStages: step.semanticStages as unknown as JsonValue }
				: {}),
			reward: step.reward,
			done: step.done,
			...(typeof reasoningCandidate === "string"
				? { reasoning: reasoningCandidate }
				: {}),
			...(metadata !== undefined ? { metadata } : {}),
		};
	});
}

function stepsSqlLiteral(steps: TrajectoryStep[]): string {
	return `'${JSON.stringify(boundStepsForPersistence(steps)).replace(/'/g, "''")}'`;
}

function trajectoryRunIdWhereClause(runId: string): string {
	const escaped = runId.toLowerCase().replace(/[\\'%_]/g, (ch) => {
		if (ch === "'") return "''";
		if (ch === "\\") return "\\\\";
		return `\\${ch}`;
	});
	return `(
		LOWER(COALESCE(CAST(metadata_json AS TEXT), '')) LIKE '%${escaped}%' OR
		LOWER(COALESCE(CAST(steps_json AS TEXT), '')) LIKE '%${escaped}%'
	)`;
}

type TrajectoryStatus =
	| "active"
	| "completed"
	| "error"
	| "timeout"
	| "terminated";

function isFinalTrajectoryStatus(status: unknown): boolean {
	return (
		status === "completed" ||
		status === "error" ||
		status === "timeout" ||
		status === "terminated"
	);
}

function parseTrajectoryStatus(
	value: SqlCell | undefined,
	rowId?: string,
): TrajectoryStatus {
	const status = typeof value === "string" ? value : null;
	if (
		status === "active" ||
		status === "completed" ||
		status === "error" ||
		status === "timeout" ||
		status === "terminated"
	) {
		return status;
	}
	throw new ElizaError("Trajectory database row has an invalid status", {
		code: "TRAJECTORY_ROW_INVALID",
		context: { field: "status", ...(rowId ? { rowId } : {}) },
	});
}

function parseNullableNumberCell(
	value: SqlCell | undefined,
	field: string,
	rowId?: string,
): number | null {
	if (value === null) return null;
	const numeric = asNumber(value);
	if (numeric !== null) return numeric;
	throw new ElizaError(`Trajectory database row has an invalid ${field}`, {
		code: "TRAJECTORY_ROW_INVALID",
		context: { field, ...(rowId ? { rowId } : {}) },
	});
}

function normalizeReadTrajectoryTiming(input: {
	status: TrajectoryStatus;
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	rowId?: string;
}): { endTime: number | null; durationMs: number | null } {
	if (input.status === "active") {
		if (input.endTime !== null || input.durationMs !== null) {
			throw new ElizaError("Active trajectory timing is invalid", {
				code: "TRAJECTORY_ROW_INVALID",
				context: {
					field: "end_time",
					...(input.rowId ? { rowId: input.rowId } : {}),
				},
			});
		}
		return { endTime: null, durationMs: null };
	}
	if (
		input.endTime === null ||
		input.endTime < input.startTime ||
		input.durationMs === null ||
		input.durationMs < 0 ||
		input.durationMs !== input.endTime - input.startTime
	) {
		throw new ElizaError("Terminal trajectory timing is invalid", {
			code: "TRAJECTORY_ROW_INVALID",
			context: {
				field: "duration_ms",
				...(input.rowId ? { rowId: input.rowId } : {}),
			},
		});
	}
	return { endTime: input.endTime, durationMs: input.durationMs };
}

function normalizeReadTrajectoryUpdatedAt(input: {
	startTime: number;
	endTime: number | null;
	createdAtMs?: number | null;
	updatedAtMs?: number | null;
}): string {
	const floorTime = input.endTime ?? input.startTime;
	if (
		typeof input.createdAtMs !== "number" ||
		!Number.isFinite(input.createdAtMs) ||
		typeof input.updatedAtMs !== "number" ||
		!Number.isFinite(input.updatedAtMs) ||
		input.updatedAtMs < floorTime
	) {
		throw new ElizaError("Trajectory update timestamp is invalid", {
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "updated_at" },
		});
	}
	return new Date(input.updatedAtMs).toISOString();
}

type StartTrajectoryOptions = {
	agentId?: string;
	roomId?: string;
	entityId?: string;
	source?: string;
	scenarioId?: string;
	/** Correlation join key (#13775), read from the trajectory context. */
	traceId?: string;
	episodeId?: string;
	batchId?: string;
	groupIndex?: number;
	metadata?: Record<string, JsonValue>;
};

type CompleteStepRewardInfo = {
	reward?: number;
	components?: Partial<RewardComponents>;
};

interface StepIndexRow {
	trajectoryId: string;
	stepNumber: number;
	isActive: boolean;
}

// ============================================================================
// Trajectories Service
// ============================================================================

export class TrajectoriesService extends Service {
	static serviceType = "trajectories" as const;
	static override readonly allowsMultiple = true;
	get serviceType() {
		return TrajectoriesService.serviceType;
	}

	capabilityDescription =
		"Captures and persists LLM calls, provider accesses, and full trajectories for debugging, analysis, and RL training";

	/**
	 * Resolve the *real* SQL-backed TrajectoriesService from the runtime.
	 *
	 * The Eliza core can register a lightweight fallback under the same
	 * "trajectories" serviceType. getService() returns whichever
	 * instance was started first. This helper scans all registered services
	 * of that type and returns the one that
	 * actually exposes the full trajectory lifecycle API (startTrajectory).
	 */
	/**
	 * Synchronous lookup — returns null if the real service hasn't started yet.
	 */
	static resolveFromRuntime(
		runtime: IAgentRuntime,
	): TrajectoriesService | null {
		// Fast path — if getService already returns the real one, use it.
		const first = runtime.getService(
			TrajectoriesService.serviceType,
		) as Service | null;
		if (first instanceof TrajectoriesService) {
			return first;
		}

		// Slow path: the core fallback won, scan all services for the real one.
		const all =
			typeof runtime.getServicesByType === "function"
				? runtime.getServicesByType(TrajectoriesService.serviceType)
				: [];
		for (const svc of all) {
			if (svc instanceof TrajectoriesService) {
				return svc;
			}
		}
		return null;
	}

	/**
	 * Async version that waits for the real SQL-backed service to finish
	 * starting. The core fallback starts synchronously; the real plugin starts
	 * asynchronously (DB init). This method polls briefly so callers don't have
	 * to guess at timing.
	 */
	static async waitForService(
		runtime: IAgentRuntime,
		timeoutMs = 10_000,
	): Promise<TrajectoriesService | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const svc = TrajectoriesService.resolveFromRuntime(runtime);
			if (svc) return svc;
			await new Promise((r) => setTimeout(r, 50));
		}
		return null;
	}

	private enabled = true;
	private initialized = false;
	private stopping = false;
	private retentionTimer: ReturnType<typeof setInterval> | null = null;
	private retentionKickoff: ReturnType<typeof setTimeout> | null = null;
	private stopPromise: Promise<void> | null = null;
	// Routing can include another service's same-agent trajectory. Only a
	// successful start grants this service shutdown ownership, even before a step.
	private ownedTrajectoryIds = new Set<string>();

	// Only keep lightweight ID caches for sync compatibility.
	// Trajectory payloads are always read from / written to the database.
	private activeStepIds: Map<string, string> = new Map();
	private stepToTrajectory: Map<string, string> = new Map();
	private writeQueues: Map<string, Promise<void>> = new Map();
	private inflightOperations: Set<Promise<unknown>> = new Set();
	private closedStepIds: Map<string, number> = new Map();

	private acceptsNewCapture(): boolean {
		return this.enabled && !this.stopping;
	}

	private rememberClosedStep(stepId: string): void {
		this.closedStepIds.delete(stepId);
		this.closedStepIds.set(stepId, Date.now());
		while (this.closedStepIds.size > 10_000) {
			const oldest = this.closedStepIds.keys().next().value;
			if (typeof oldest !== "string") break;
			this.closedStepIds.delete(oldest);
		}
	}

	/** Accept a capture that arrived shortly after terminalization instead of
	 *  dropping it. The async step-resolution branch of logLlmCall/logProviderCall
	 *  takes the write lock only after resolving its trajectory id, so a turn
	 *  ending right after its last planner leg raced that write and the stored
	 *  trajectory lost exactly the tool-call legs it exists to show (live all
	 *  week). Appending within a bounded grace window records the leg without
	 *  touching finalStatus/endTime; genuinely stale writes (crash leftovers,
	 *  replays) still reject past the window. */
	// Must cover the post-delivery side-effect window (reflection/memory
	// evaluators run up to ELIZA_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS after
	// delivery — 90s on the reference deployment) or their model calls reject
	// as late captures; 30s demonstrably did not (3 rejects in one boot).
	private static readonly LATE_CAPTURE_GRACE_MS = 120_000;

	/** Entry-gate twin of {@link withinLateCaptureGrace}: a step closed at
	 *  terminalization still admits captures for the same grace window. */
	private stepClosedBeyondGrace(stepId: string): boolean {
		const closedAt = this.closedStepIds.get(stepId);
		return (
			closedAt !== undefined &&
			Date.now() - closedAt > TrajectoriesService.LATE_CAPTURE_GRACE_MS
		);
	}

	private withinLateCaptureGrace(trajectory: { endTime?: number }): boolean {
		return (
			typeof trajectory.endTime === "number" &&
			Date.now() - trajectory.endTime <=
				TrajectoriesService.LATE_CAPTURE_GRACE_MS
		);
	}

	private reportLateCapture(
		stepId: string,
		captureType: "llm" | "provider" | "semanticStage",
		ageMs?: number,
	): void {
		// Context inline in the message: the pretty transport drops structured
		// warn payloads, and diagnosing this race blind cost two wrong fixes
		// (30s grace, then 120s). The age names the class directly.
		const age =
			typeof ageMs === "number" ? `${Math.round(ageMs / 1000)}s` : "unknown";
		const error = new ElizaError(
			`Trajectory capture arrived after terminalization (step=${stepId.slice(0, 12)} type=${captureType} age=${age})`,
			{
				code: "TRAJECTORY_OWNER_CLOSED",
				context: { stepId, captureType, ageMs },
			},
		);
		logger.warn(
			{ err: error, stepId, captureType, ageMs },
			`[trajectory-logger] Rejected late trajectory capture (step=${stepId.slice(0, 12)} type=${captureType} age=${age})`,
		);
		this.runtime.reportError("TrajectoriesService.lateCapture", error, {
			stepId,
			captureType,
			diagnosticOnly: true,
		});
	}

	private releaseTrajectoryRouting(trajectoryId: string): void {
		this.activeStepIds.delete(trajectoryId);
		this.rememberClosedStep(trajectoryId);
		for (const [
			stepId,
			mappedTrajectoryId,
		] of this.stepToTrajectory.entries()) {
			if (mappedTrajectoryId === trajectoryId) {
				this.rememberClosedStep(stepId);
				this.stepToTrajectory.delete(stepId);
			}
		}
	}

	// Cache-miss capture has no owner queue until its database lookup resolves;
	// shutdown therefore drains the full lookup-through-write operation here.
	private trackInflightOperation<T>(operation: Promise<T>): Promise<T> {
		this.inflightOperations.add(operation);
		void operation.then(
			() => this.inflightOperations.delete(operation),
			() => this.inflightOperations.delete(operation),
		);
		return operation;
	}

	private async drainInflightOperations(): Promise<void> {
		while (this.inflightOperations.size > 0 || this.writeQueues.size > 0) {
			await Promise.allSettled([
				...this.inflightOperations,
				...this.writeQueues.values(),
			]);
		}
	}

	private exposeBoundMethods(): void {
		const service = this as this & {
			startTrajectory: TrajectoriesService["startTrajectory"];
			endTrajectory: TrajectoriesService["endTrajectory"];
			startStep: TrajectoriesService["startStep"];
			getCurrentStepId: TrajectoriesService["getCurrentStepId"];
			completeStep: TrajectoriesService["completeStep"];
			logLLMCall: TrajectoriesService["logLLMCall"];
			logSemanticStage: TrajectoriesService["logSemanticStage"];
			logProviderAccess: TrajectoriesService["logProviderAccess"];
			logProviderAccessByTrajectoryId: TrajectoriesService["logProviderAccessByTrajectoryId"];
			isEnabled: TrajectoriesService["isEnabled"];
			listTrajectories: TrajectoriesService["listTrajectories"];
			getTrajectoryDetail: TrajectoriesService["getTrajectoryDetail"];
			flushWriteQueue: TrajectoriesService["flushWriteQueue"];
		};

		service.startTrajectory = this.startTrajectory.bind(this);
		service.endTrajectory = this.endTrajectory.bind(this);
		service.startStep = this.startStep.bind(this);
		service.getCurrentStepId = this.getCurrentStepId.bind(this);
		service.completeStep = this.completeStep.bind(this);
		service.logLLMCall = this.logLLMCall.bind(this);
		service.logSemanticStage = this.logSemanticStage.bind(this);
		service.logProviderAccess = this.logProviderAccess.bind(this);
		service.logProviderAccessByTrajectoryId =
			this.logProviderAccessByTrajectoryId.bind(this);
		service.isEnabled = this.isEnabled.bind(this);
		service.listTrajectories = this.listTrajectories.bind(this);
		service.getTrajectoryDetail = this.getTrajectoryDetail.bind(this);
		service.flushWriteQueue = this.flushWriteQueue.bind(this);
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TrajectoriesService(runtime);
		await service.initialize();
		service.startRetentionSweep();
		return service;
	}

	/** Prune on-disk trajectory files a minute after boot and every six hours. */
	private startRetentionSweep(): void {
		const days = resolveTrajectoryRetentionDays();
		if (days <= 0) return;
		const maxAgeMs = days * 24 * 60 * 60 * 1000;
		const sweep = async () => {
			try {
				const outcome = await sweepTrajectoryFiles(resolveTrajectoryDir(), {
					maxAgeMs,
				});
				if (outcome.removed > 0 || outcome.tmpRemoved > 0) {
					logger.info(
						{ ...outcome, retentionDays: days },
						"[trajectory-logger] pruned trajectory files",
					);
				}
			} catch (error) {
				this.runtime.reportError("TrajectoriesService.retentionSweep", error, {
					diagnosticOnly: true,
				});
			}
		};
		this.retentionKickoff = setTimeout(() => void sweep(), 60_000);
		this.retentionKickoff.unref?.();
		this.retentionTimer = setInterval(() => void sweep(), 6 * 60 * 60 * 1000);
		this.retentionTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.retentionKickoff) clearTimeout(this.retentionKickoff);
		if (this.retentionTimer) clearInterval(this.retentionTimer);
		this.retentionKickoff = null;
		this.retentionTimer = null;
		this.stopping = true;
		this.stopPromise = this.finishStop();
		try {
			await this.stopPromise;
		} finally {
			// Failed terminal writes retain their ownership for an explicit retry.
			this.stopPromise = null;
		}
	}

	private async finishStop(): Promise<void> {
		await this.drainInflightOperations();
		const results = await Promise.allSettled(
			[...this.ownedTrajectoryIds].map((trajectoryId) =>
				this.terminateOwnedTrajectory(trajectoryId),
			),
		);
		this.enabled = false;
		for (const trajectoryId of new Set(this.stepToTrajectory.values())) {
			this.releaseTrajectoryRouting(trajectoryId);
		}
		for (const trajectoryId of this.activeStepIds.keys()) {
			this.releaseTrajectoryRouting(trajectoryId);
		}
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				"Failed to terminate owned trajectories during shutdown",
			);
		}
	}

	private async terminateOwnedTrajectory(trajectoryId: string): Promise<void> {
		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			await this.executeRawSqlTransaction(async (execute) => {
				const trajectory = await this.getTrajectoryById(
					trajectoryId,
					execute,
					true,
				);
				if (
					!trajectory ||
					!this.runtime.runtimeInstanceId ||
					trajectory.metadata.runtimeInstanceId !==
						this.runtime.runtimeInstanceId ||
					trajectory.metrics.finalStatus !== "active"
				)
					return;

				const now = Date.now();
				await this.markAllStepsInactive(trajectoryId, execute);
				// Preserve captured payloads and usage exactly; shutdown only settles
				// lifecycle fields after all accepted captures have drained.
				await execute(`UPDATE trajectories SET
					status = 'terminated',
					end_time = ${now},
					duration_ms = ${now - trajectory.startTime},
					metrics_json = ${sqlLiteral({
						...trajectory.metrics,
						finalStatus: "terminated",
						episodeLength: trajectory.steps.length,
					})},
					updated_at = ${sqlLiteral(new Date(now).toISOString())}
					WHERE id = ${sqlLiteral(trajectoryId)}
					AND agent_id = ${sqlLiteral(this.runtime.agentId)}`);
			});
		});
		this.ownedTrajectoryIds.delete(trajectoryId);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			for (const trajectoryId of new Set(this.stepToTrajectory.values())) {
				this.releaseTrajectoryRouting(trajectoryId);
			}
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Initialization
	// ─────────────────────────────────────────────────────────────────────────

	private getSqlHelper(): typeof sql {
		return sql;
	}

	private async executeRawSql(sqlText: string): Promise<TrajectorySqlResult> {
		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime.adapter) {
			throw new Error("Database adapter not available");
		}

		const sqlHelper = this.getSqlHelper();
		const dbCandidate = runtime.adapter.db as { execute?: unknown } | undefined;
		// Adapters without SQL support (e.g. InMemoryDatabaseAdapter used in tests)
		// expose `db = {}` rather than a Drizzle handle. Treat schema/CRUD calls as
		// no-ops so trajectory logging can degrade gracefully instead of spamming
		// "db.execute is not a function" for every step.
		if (!dbCandidate || typeof dbCandidate.execute !== "function") {
			return { rows: [], columns: [] };
		}
		const db = dbCandidate as {
			execute(query: ReturnType<typeof sql.raw>): Promise<SqlExecuteResult>;
		};
		const query = sqlHelper.raw(sqlText);
		const result = await db.execute(query);
		if (!result || !Array.isArray(result.rows)) {
			throw new ElizaError("Trajectory SQL result is invalid", {
				code: "TRAJECTORY_ROW_INVALID",
				context: { operation: "execute" },
			});
		}
		const rows = result.rows;
		const columns =
			result.fields && Array.isArray(result.fields)
				? result.fields.map((field) => field.name)
				: rows.length > 0
					? Object.keys(rows[0])
					: [];
		return { rows, columns };
	}

	private async executeRawSqlTransaction<T>(
		work: (execute: TrajectorySqlExecutor) => Promise<T>,
	): Promise<T> {
		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		const db = runtime.adapter?.db as
			| {
					transaction?: <TResult>(
						callback: (tx: {
							execute(
								query: ReturnType<typeof sql.raw>,
							): Promise<SqlExecuteResult>;
						}) => Promise<TResult>,
					) => Promise<TResult>;
			  }
			| undefined;
		if (!db || typeof db.transaction !== "function") {
			throw new ElizaError("Trajectory storage transactions are unavailable", {
				code: "TRAJECTORY_TRANSACTION_UNAVAILABLE",
			});
		}
		return db.transaction((tx) =>
			work(async (sqlText) => {
				const result = await tx.execute(this.getSqlHelper().raw(sqlText));
				if (!result || !Array.isArray(result.rows)) {
					throw new ElizaError("Trajectory SQL result is invalid", {
						code: "TRAJECTORY_ROW_INVALID",
						context: { operation: "transaction" },
					});
				}
				const rows = result.rows;
				const columns =
					result.fields && Array.isArray(result.fields)
						? result.fields.map((field) => field.name)
						: rows.length > 0
							? Object.keys(rows[0])
							: [];
				return { rows, columns };
			}),
		);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.exposeBoundMethods();

		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime.adapter) {
			logger.warn(
				"[trajectory-logger] No runtime adapter available, skipping initialization",
			);
			this.enabled = false;
			return;
		}

		const db = runtime.adapter.db as { execute?: unknown } | undefined;
		if (!db || typeof db.execute !== "function") {
			logger.warn(
				"[trajectory-logger] Runtime adapter does not support db.execute (likely InMemory adapter); skipping table setup",
			);
			this.enabled = false;
			return;
		}

		await this.ensureTablesExist();

		// NOTE: trajectory logging for useModel calls is handled natively in
		// the core runtime (runtime.ts useModel), which checks
		// getTrajectoryContext() and calls trajLogger.logLlmCall() when a
		// trajectory step is active.  No monkey-patching needed here.

		this.initialized = true;
		logger.info("[trajectories] Trajectories service initialized");
	}

	private async ensureStorageReady(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
			return;
		}

		await this.ensureTablesExist();
	}

	private async getTableColumnNames(tableName: string): Promise<Set<string>> {
		const names = new Set<string>();
		let postgresError: unknown;

		// PostgreSQL path.
		try {
			const result = await this.executeRawSql(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = ${sqlLiteral(tableName)}
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
      `);
			for (const row of result.rows) {
				const name = asString(pickCell(row, "column_name"));
				if (name) names.add(name);
			}
			if (names.size > 0) return names;
		} catch (error) {
			// error-policy:J4 Database dialect discovery falls through from
			// PostgreSQL metadata to SQLite PRAGMA.
			postgresError = error;
		}

		// SQLite / generic fallback.
		const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
		if (!safeTableName) return names;
		try {
			const pragma = await this.executeRawSql(
				`PRAGMA table_info(${safeTableName})`,
			);
			for (const row of pragma.rows) {
				const name = asString(pickCell(row, "name"));
				if (name) names.add(name);
			}
		} catch (sqliteError) {
			// error-policy:J2 Neither dialect could inspect the required schema;
			// preserve both causes instead of pretending the table has no columns.
			throw new ElizaError(
				`Unable to inspect columns for trajectory table ${tableName}`,
				{
					code: "TRAJECTORY_SCHEMA_INSPECTION_FAILED",
					context: { tableName },
					cause:
						postgresError === undefined
							? sqliteError
							: new AggregateError([postgresError, sqliteError]),
				},
			);
		}

		return names;
	}

	private async ensureTrajectoryColumnsExist(): Promise<void> {
		let columns = await this.getTableColumnNames("trajectories");
		const requiredColumns: Array<[name: string, definition: string]> = [
			["scenario_id", "TEXT"],
			// Correlation join key (#13775): stitches a DB trajectory to its file
			// trajectory and orchestrator task. Nullable — pre-rollout rows have none.
			["trace_id", "TEXT"],
			["episode_id", "TEXT"],
			["batch_id", "TEXT"],
			["group_index", "INTEGER"],
			["steps_json", "JSONB NOT NULL DEFAULT '[]'"],
			["reward_components_json", "JSONB NOT NULL DEFAULT '{}'"],
			["metrics_json", "JSONB NOT NULL DEFAULT '{}'"],
			["metadata_json", "JSONB NOT NULL DEFAULT '{}'"],
			["total_cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
			["total_cache_creation_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
			["is_training_data", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["is_evaluation", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["used_in_training", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["judged_at", "TIMESTAMPTZ"],
		];

		for (const [columnName, definition] of requiredColumns) {
			if (columns.has(columnName)) continue;
			await this.executeRawSql(
				`ALTER TABLE trajectories ADD COLUMN ${columnName} ${definition}`,
			);
			columns = await this.getTableColumnNames("trajectories");
			if (columns.has(columnName)) {
				logger.info(
					`[trajectory-logger] Added missing trajectories.${columnName} column`,
				);
				continue;
			}
			throw new Error(
				`[trajectory-logger] Missing required trajectories.${columnName} column (${definition}). Automatic migration did not apply cleanly.`,
			);
		}

		// Legacy Eliza schema used 32-bit INTEGER for ms timestamps. Upgrade to
		// BIGINT so runtime timestamps (Date.now()) can be stored safely.
		// This migration is Postgres-specific. Ignore on adapters that don't support it.
		for (const statement of [
			`ALTER TABLE trajectories
       ALTER COLUMN start_time TYPE BIGINT USING start_time::BIGINT`,
			`ALTER TABLE trajectories
       ALTER COLUMN end_time TYPE BIGINT USING end_time::BIGINT`,
			`ALTER TABLE trajectories
       ALTER COLUMN duration_ms TYPE BIGINT USING duration_ms::BIGINT`,
		]) {
			try {
				await this.executeRawSql(statement);
			} catch (error) {
				// error-policy:J4 BIGINT widening is PostgreSQL-specific; adapters
				// that reject it remain usable but the skipped migration is reported.
				this.runtime.reportError(
					"TrajectoriesService.timestampColumnMigration",
					error,
					{ statement },
				);
			}
		}
	}

	private async ensureTablesExist(): Promise<void> {
		// Main trajectories table
		await this.executeRawSql(`
      CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        status TEXT NOT NULL DEFAULT 'active',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        scenario_id TEXT,
        trace_id TEXT,
        episode_id TEXT,
        batch_id TEXT,
        group_index INTEGER,
        steps_json JSONB NOT NULL DEFAULT '[]',
        reward_components_json JSONB NOT NULL DEFAULT '{}',
        metrics_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        is_training_data BOOLEAN NOT NULL DEFAULT FALSE,
        is_evaluation BOOLEAN NOT NULL DEFAULT FALSE,
        used_in_training BOOLEAN NOT NULL DEFAULT FALSE,
        ai_judge_reward REAL,
        ai_judge_reasoning TEXT,
        judged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
		await this.ensureTrajectoryColumnsExist();

		// Indexes for common queries
		try {
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_agent_id ON trajectories(agent_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_source ON trajectories(source)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_status ON trajectories(status)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_created_at ON trajectories(created_at)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_scenario_id ON trajectories(scenario_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_trace_id ON trajectories(trace_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_batch_id ON trajectories(batch_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_is_training ON trajectories(is_training_data)`,
			);
		} catch (e) {
			// error-policy:J4 Indexes are performance-only; table persistence
			// remains available while the failed optimization is reported.
			logger.warn(
				`[trajectory-logger] Failed to create indexes (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
			);
			this.runtime.reportError("TrajectoriesService.createIndexes", e);
		}

		// Step index keeps step -> trajectory mapping in DB so logs remain routable
		// across process restarts.
		await this.executeRawSql(`
      CREATE TABLE IF NOT EXISTS trajectory_step_index (
        step_id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
		await this.executeRawSql(
			`CREATE INDEX IF NOT EXISTS idx_trajectory_step_index_trajectory_id ON trajectory_step_index(trajectory_id)`,
		);
		await this.executeRawSql(
			`CREATE INDEX IF NOT EXISTS idx_trajectory_step_index_is_active ON trajectory_step_index(is_active)`,
		);
		await this.executeRawSql(`
      CREATE TABLE IF NOT EXISTS trajectory_steps (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        parent_step_id TEXT,
        step_type TEXT NOT NULL,
        name TEXT,
        started_at BIGINT,
        ended_at BIGINT,
        payload JSONB NOT NULL DEFAULT '{}',
        script TEXT,
        UNIQUE (trajectory_id, id),
        FOREIGN KEY (trajectory_id, parent_step_id)
          REFERENCES trajectory_steps(trajectory_id, id)
          ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      )
    `);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Runtime Interface (called by @elizaos/core runtime)
	// ─────────────────────────────────────────────────────────────────────────

	private normalizePurpose(value: string): LLMCall["purpose"] {
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error(
				`[TrajectoriesService] trajectory purpose must be a non-empty string; got ${JSON.stringify(value)}`,
			);
		}
		return value.trim();
	}

	private defaultEnvironmentState(timestamp = Date.now()): EnvironmentState {
		return { timestamp };
	}

	private createStep(
		stepId: string,
		stepNumber: number,
		envState: EnvironmentState,
	): TrajectoryStep {
		const timestamp = envState.timestamp || Date.now();
		return {
			stepId: stepId as `${string}-${string}-${string}-${string}-${string}`,
			stepNumber,
			timestamp,
			environmentState: envState,
			observation: {},
			llmCalls: [],
			providerAccesses: [],
			reward: 0,
			done: false,
		};
	}

	private computeTotals(steps: TrajectoryStep[]): {
		stepCount: number;
		llmCallCount: number;
		providerAccessCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		totalCacheReadInputTokens: number;
		totalCacheCreationInputTokens: number;
	} {
		let llmCallCount = 0;
		let providerAccessCount = 0;
		let totalPromptTokens = 0;
		let totalCompletionTokens = 0;
		let totalCacheReadInputTokens = 0;
		let totalCacheCreationInputTokens = 0;
		for (const step of steps) {
			const llmCalls = Array.isArray(step.llmCalls) ? step.llmCalls : [];
			const providerAccesses = Array.isArray(step.providerAccesses)
				? step.providerAccesses
				: [];
			llmCallCount += llmCalls.length;
			providerAccessCount += providerAccesses.length;
			for (const call of llmCalls) {
				totalPromptTokens += call.promptTokens ?? 0;
				totalCompletionTokens += call.completionTokens ?? 0;
				totalCacheReadInputTokens += call.cacheReadInputTokens ?? 0;
				totalCacheCreationInputTokens += call.cacheCreationInputTokens ?? 0;
			}
		}
		return {
			stepCount: steps.length,
			llmCallCount,
			providerAccessCount,
			totalPromptTokens,
			totalCompletionTokens,
			totalCacheReadInputTokens,
			totalCacheCreationInputTokens,
		};
	}

	/**
	 * Flush any pending writes for a trajectory.
	 * Call before endTrajectory to ensure fire-and-forget writes
	 * (logLLMCall, completeStep) have persisted.
	 */
	async flushWriteQueue(trajectoryId: string): Promise<void> {
		const pending = this.writeQueues.get(trajectoryId);
		if (pending) {
			await pending.catch((err) => {
				// error-policy:J2 Flush is an awaited persistence barrier; add trajectory
				// context and preserve the rejected write for the caller.
				logger.error(
					{ err, trajectoryId },
					"[trajectory-logger] flushWriteQueue: pending trajectory write failed",
				);
				throw err;
			});
		}
	}

	private async withTrajectoryWriteLock(
		trajectoryId: string,
		task: () => Promise<void>,
	): Promise<void> {
		const previous = this.writeQueues.get(trajectoryId) ?? Promise.resolve();
		const next = previous
			.catch(() => {
				// error-policy:J5 The prior write's caller observes its rejection; this
				// sequencing tail only keeps later independent writes from chain-blocking.
			})
			.then(task);
		this.writeQueues.set(trajectoryId, next);
		try {
			await next;
		} finally {
			if (this.writeQueues.get(trajectoryId) === next) {
				this.writeQueues.delete(trajectoryId);
			}
		}
	}

	private reportDetachedWriteFailure(
		message: string,
		metadata: Record<string, unknown>,
		err: unknown,
	): void {
		logger.error({ err, ...metadata }, message);
		this.runtime.reportError("TrajectoriesService.detachedWrite", err, {
			...metadata,
			diagnosticOnly: true,
		});
	}

	private async getTrajectoryById(
		trajectoryId: string,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
		forUpdate = false,
	): Promise<Trajectory | null> {
		const result = await execute(
			`SELECT * FROM trajectories
			 WHERE id = ${sqlLiteral(trajectoryId)}
			   AND agent_id = ${sqlLiteral(this.runtime.agentId)} LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
		);
		if (result.rows.length === 0) return null;
		return this.rowToTrajectory(result.rows[0]);
	}

	private async getStepIndex(
		stepId: string,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
	): Promise<StepIndexRow | null> {
		const result = await execute(
			`SELECT i.trajectory_id, i.step_number, i.is_active
			 FROM trajectory_step_index i
			 JOIN trajectories t ON t.id = i.trajectory_id
			 WHERE i.step_id = ${sqlLiteral(stepId)}
			   AND t.agent_id = ${sqlLiteral(this.runtime.agentId)} LIMIT 1`,
		);
		const row = result.rows[0];
		if (!row) return null;
		const trajectoryId = asString(pickCell(row, "trajectory_id"));
		if (!trajectoryId) return null;
		const stepNumberValue = asNumber(pickCell(row, "step_number"));
		const stepNumber = stepNumberValue === null ? 0 : stepNumberValue;
		const isActiveText = asString(pickCell(row, "is_active"));
		const isActive =
			isActiveText === "true" ||
			isActiveText === "t" ||
			pickCell(row, "is_active") === true;
		return { trajectoryId, stepNumber, isActive };
	}

	private async setStepIndex(
		stepId: string,
		trajectoryId: string,
		stepNumber: number,
		isActive: boolean,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
	): Promise<void> {
		const existing = await execute(`
	      SELECT t.agent_id, i.trajectory_id
      FROM trajectory_step_index i
      JOIN trajectories t ON t.id = i.trajectory_id
      WHERE i.step_id = ${sqlLiteral(stepId)}
      LIMIT 1
    `);
		const existingAgentId = existing.rows[0]
			? asString(pickCell(existing.rows[0], "agent_id"))
			: null;
		const existingTrajectoryId = existing.rows[0]
			? asString(pickCell(existing.rows[0], "trajectory_id"))
			: null;
		if (existingAgentId && existingAgentId !== this.runtime.agentId) {
			throw new ElizaError("Trajectory step belongs to another agent", {
				code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
				context: { stepId, trajectoryId, existingAgentId },
			});
		}
		if (existingTrajectoryId && existingTrajectoryId !== trajectoryId) {
			throw new ElizaError("Trajectory step belongs to another trajectory", {
				code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT",
				context: { stepId, trajectoryId, existingTrajectoryId },
			});
		}
		await execute(`
      INSERT INTO trajectory_step_index (
        step_id, trajectory_id, step_number, is_active, updated_at
      ) VALUES (
        ${sqlLiteral(stepId)},
        ${sqlLiteral(trajectoryId)},
        ${stepNumber},
        ${isActive ? "TRUE" : "FALSE"},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (step_id) DO UPDATE SET
        trajectory_id = EXCLUDED.trajectory_id,
        step_number = EXCLUDED.step_number,
        is_active = EXCLUDED.is_active,
        updated_at = CURRENT_TIMESTAMP
    `);
	}

	private async markAllStepsInactive(
		trajectoryId: string,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
	): Promise<void> {
		await execute(`
      UPDATE trajectory_step_index
      SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE trajectory_id = ${sqlLiteral(trajectoryId)}
    `);
	}

	private async resolveTrajectoryId(
		stepIdOrTrajectoryId: string,
	): Promise<string | null> {
		const cached = this.stepToTrajectory.get(stepIdOrTrajectoryId);
		if (cached) return cached;

		const byStep = await this.getStepIndex(stepIdOrTrajectoryId);
		if (byStep?.trajectoryId) {
			this.stepToTrajectory.set(stepIdOrTrajectoryId, byStep.trajectoryId);
			return byStep.trajectoryId;
		}

		const byId = await this.executeRawSql(
			`SELECT id FROM trajectories
			 WHERE id = ${sqlLiteral(stepIdOrTrajectoryId)}
			   AND agent_id = ${sqlLiteral(this.runtime.agentId)} LIMIT 1`,
		);
		const row = byId.rows[0];
		const id = row ? asString(pickCell(row, "id")) : null;
		return id;
	}

	private async getCurrentStepIdFromDb(
		trajectoryId: string,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
	): Promise<string | null> {
		const result = await execute(`
      SELECT step_id
      FROM trajectory_step_index
      WHERE trajectory_id = ${sqlLiteral(trajectoryId)} AND is_active = TRUE
      ORDER BY step_number DESC, updated_at DESC
      LIMIT 1
    `);
		const row = result.rows[0];
		return row ? asString(pickCell(row, "step_id")) : null;
	}

	private async persistTrajectory(
		trajectoryId: string,
		trajectory: Trajectory,
		status: TrajectoryStatus = "active",
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
		allowCompatibilityFallback = true,
	): Promise<void> {
		const totals = this.computeTotals(trajectory.steps);
		const isFinalStatus = status !== "active";
		const persistedEndTime = isFinalStatus ? trajectory.endTime : null;
		const persistedDuration = isFinalStatus ? trajectory.durationMs : null;
		const updatedAtIso = new Date().toISOString();
		try {
			await execute(`
        UPDATE trajectories SET
          status = ${sqlLiteral(status)},
          end_time = ${sqlLiteral(persistedEndTime)},
          duration_ms = ${sqlLiteral(persistedDuration)},
          step_count = ${totals.stepCount},
          llm_call_count = ${totals.llmCallCount},
          provider_access_count = ${totals.providerAccessCount},
          total_prompt_tokens = ${totals.totalPromptTokens},
          total_completion_tokens = ${totals.totalCompletionTokens},
          total_cache_read_input_tokens = ${totals.totalCacheReadInputTokens},
          total_cache_creation_input_tokens = ${totals.totalCacheCreationInputTokens},
          total_reward = ${trajectory.totalReward},
          steps_json = ${stepsSqlLiteral(trajectory.steps)},
          reward_components_json = ${sqlLiteral(trajectory.rewardComponents)},
          metrics_json = ${sqlLiteral(trajectory.metrics)},
          metadata_json = ${sqlLiteral(trajectory.metadata)},
          updated_at = ${sqlLiteral(updatedAtIso)}
        WHERE id = ${sqlLiteral(trajectoryId)}
      `);
		} catch (modernErr) {
			if (!allowCompatibilityFallback) throw modernErr;
			// error-policy:J4 A legacy schema receives its compatible update
			// shape; failure of both forms is raised below.
			// Compatibility fallback for legacy Eliza schema.
			try {
				await execute(`
        UPDATE trajectories SET
          status = ${sqlLiteral(status)},
          end_time = ${sqlLiteral(persistedEndTime)},
          duration_ms = ${sqlLiteral(persistedDuration)},
          step_count = ${totals.stepCount},
          llm_call_count = ${totals.llmCallCount},
          provider_access_count = ${totals.providerAccessCount},
          total_prompt_tokens = ${totals.totalPromptTokens},
          total_completion_tokens = ${totals.totalCompletionTokens},
          total_cache_read_input_tokens = ${totals.totalCacheReadInputTokens},
          total_cache_creation_input_tokens = ${totals.totalCacheCreationInputTokens},
          total_reward = ${trajectory.totalReward},
          steps_json = ${stepsSqlLiteral(trajectory.steps)},
          metadata = ${sqlLiteral(trajectory.metadata)},
          updated_at = ${sqlLiteral(updatedAtIso)}
        WHERE id = ${sqlLiteral(trajectoryId)}
      `);
			} catch (legacyErr) {
				// error-policy:J2 Preserve both schema-update failures.
				logger.warn(
					{ err: legacyErr, trajectoryId },
					`[trajectory-logger] Failed to persist trajectory update after compatibility fallback: ${modernErr instanceof Error ? modernErr.message : String(modernErr)}`,
				);
				throw new ElizaError(
					`Failed to persist trajectory update for ${trajectoryId}`,
					{
						code: "TRAJECTORY_UPDATE_FAILED",
						context: { trajectoryId },
						cause: new AggregateError([modernErr, legacyErr]),
					},
				);
			}
		}
	}

	private async ensureStepExists(
		trajectory: Trajectory,
		stepId: string,
		execute: TrajectorySqlExecutor = (sqlText) => this.executeRawSql(sqlText),
	): Promise<TrajectoryStep> {
		let step = trajectory.steps.find((entry) => entry.stepId === stepId);
		if (step) {
			if (!Array.isArray(step.llmCalls)) step.llmCalls = [];
			if (!Array.isArray(step.providerAccesses)) step.providerAccesses = [];
			return step;
		}

		const index = await this.getStepIndex(stepId, execute);
		const stepNumber = index?.stepNumber ?? trajectory.steps.length;
		step = this.createStep(stepId, stepNumber, this.defaultEnvironmentState());
		trajectory.steps.push(step);
		trajectory.steps.sort((a, b) => a.stepNumber - b.stepNumber);
		return step;
	}

	/**
	 * Called by the runtime when an LLM call is made.
	 * This is the interface the runtime expects.
	 */
	logLlmCall(params: TrajectoryRuntimeLlmCallParams): void {
		if (!this.acceptsNewCapture()) return;
		if (isEmbeddingLlmCall(params)) return;
		if (this.stepClosedBeyondGrace(params.stepId)) {
			this.reportLateCapture(
				params.stepId,
				"llm",
				Date.now() - (this.closedStepIds.get(params.stepId) ?? Date.now()),
			);
			return;
		}

		// Resolve trajectory synchronously from in-memory map (set by startStep).
		// Enter the write lock IMMEDIATELY so flushWriteQueue() in endAutonomousTick
		// can await it. The old fire-and-forget pattern caused a race: endTrajectory
		// could read the trajectory before logLlmCall's write completed.
		const trajectoryId = this.stepToTrajectory.get(params.stepId);
		if (!trajectoryId) {
			// Async resolution for legacy paths that populate the step map later.
			const operation = this.trackInflightOperation(
				(async () => {
					const resolved = await this.resolveTrajectoryId(params.stepId);
					if (!resolved) return;
					await this._persistLlmCall(resolved, params);
				})(),
			);
			void operation.catch((err) => {
				// error-policy:J7 Detached legacy step resolution reports persistence
				// failure without producing an unhandled rejection.
				this.reportDetachedWriteFailure(
					"[trajectory-logger] Failed to persist LLM call (async step resolution)",
					{ stepId: params.stepId },
					err,
				);
			});
			return;
		}

		// Enter the write lock synchronously so flushWriteQueue sees this pending write
		const operation = this.trackInflightOperation(
			this._persistLlmCall(trajectoryId, params),
		);
		void operation.catch((err) => {
			// error-policy:J7 The public logging hook is synchronous; its detached
			// persistence failure is reported through the service diagnostic boundary.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist LLM call",
				{ stepId: params.stepId },
				err,
			);
		});
	}

	private async _persistLlmCall(
		trajectoryId: string,
		rawParams: TrajectoryRuntimeLlmCallParams,
	): Promise<void> {
		const redactDiagnosticText = composeToolDiagnosticRedactor(this.runtime);
		const projectedParams = projectProtectedModelCallValue(
			rawParams as TrajectoryRuntimeLlmCallParams & Record<string, unknown>,
			redactDiagnosticText,
		) as TrajectoryRuntimeLlmCallParams;
		const attributionInputChanged =
			canonicalPromptForModelCall({
				messages: projectedParams.messages,
				prompt: projectedParams.prompt ?? projectedParams.userPrompt,
			}) !==
			canonicalPromptForModelCall({
				messages: rawParams.messages,
				prompt: rawParams.prompt ?? rawParams.userPrompt,
			});
		const params: TrajectoryRuntimeLlmCallParams = {
			...projectedParams,
			// The routing identity is operational rather than diagnostic and must
			// stay byte-exact even when a configured secret happens to overlap it.
			stepId: rawParams.stepId,
			runId: rawParams.runId,
			roomId: rawParams.roomId,
			messageId: rawParams.messageId,
			executionTraceId: rawParams.executionTraceId,
			...(attributionInputChanged
				? {
						providerAttributions: omitUnvalidatedProviderSpans(
							projectedParams.providerAttributions,
						),
					}
				: {}),
		};
		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) return;
			if (
				trajectory.metrics.finalStatus !== "active" &&
				!this.withinLateCaptureGrace(trajectory)
			) {
				this.rememberClosedStep(params.stepId);
				this.releaseTrajectoryRouting(trajectoryId);
				this.reportLateCapture(
					params.stepId,
					"llm",
					typeof trajectory.endTime === "number"
						? Date.now() - trajectory.endTime
						: undefined,
				);
				return;
			}

			const step = await this.ensureStepExists(trajectory, params.stepId);
			const systemPrompt = sanitizeTrajectoryText(params.systemPrompt) ?? "";
			const userPrompt = sanitizeTrajectoryText(params.userPrompt) ?? "";
			const prompt =
				sanitizeTrajectoryText(params.prompt ?? params.userPrompt) ??
				userPrompt;
			const messages = sanitizeTrajectoryJsonArray(params.messages);
			const tools = sanitizeTrajectoryJsonOptional(params.tools);
			const toolChoice = sanitizeTrajectoryJsonOptional(params.toolChoice);
			const responseSchema = sanitizeTrajectoryJsonOptional(
				params.responseSchema,
			);
			const providerOptions = sanitizeTrajectoryJsonOptional(
				params.providerOptions,
			);
			const toolCalls = sanitizeTrajectoryJsonArray(params.toolCalls);
			const providerMetadata = sanitizeTrajectoryJsonOptional(
				params.providerMetadata,
			);
			const reasoning = sanitizeTrajectoryText(params.reasoning);
			const llmCall: LLMCall = {
				callId: uuidv4(),
				timestamp: Date.now(),
				model: params.model,
				modelVersion: params.modelVersion,
				modelType: params.modelType,
				provider: params.provider,
				systemPrompt,
				userPrompt,
				prompt,
				messages,
				tools,
				toolChoice,
				responseSchema,
				providerOptions,
				response: sanitizeTrajectoryText(params.response) ?? "",
				toolCalls,
				finishReason: params.finishReason,
				providerMetadata,
				reasoning,
				temperature: params.temperature,
				maxTokens: params.maxTokens,
				maxTokensOmitted: params.maxTokensOmitted,
				purpose: this.normalizePurpose(params.purpose),
				actionType: params.actionType,
				promptTokens: params.promptTokens,
				completionTokens: params.completionTokens,
				cacheReadInputTokens: params.cacheReadInputTokens,
				cacheCreationInputTokens: params.cacheCreationInputTokens,
				latencyMs: params.latencyMs,
				modelSlot: params.modelSlot,
				runId: params.runId,
				roomId: params.roomId,
				messageId: params.messageId,
				executionTraceId: params.executionTraceId,
				providerOrder: params.providerOrder,
				providerAttributions: params.providerAttributions,
			};
			step.llmCalls.push(llmCall);

			// Targeted UPDATE: only write steps data and summary columns.
			// Do NOT touch status — a late logLlmCall arriving after endTrajectory
			// must not reset a "completed" trajectory back to "active".
			const totals = this.computeTotals(trajectory.steps);
			const updatedAtIso = new Date().toISOString();
			await this.executeRawSql(`
				UPDATE trajectories SET
					steps_json = ${stepsSqlLiteral(trajectory.steps)},
					step_count = ${totals.stepCount},
					llm_call_count = ${totals.llmCallCount},
					provider_access_count = ${totals.providerAccessCount},
					total_prompt_tokens = ${totals.totalPromptTokens},
					total_completion_tokens = ${totals.totalCompletionTokens},
					total_cache_read_input_tokens = ${totals.totalCacheReadInputTokens},
					total_cache_creation_input_tokens = ${totals.totalCacheCreationInputTokens},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
			`);
		});
	}

	/**
	 * Mirror one runtime recorder decision stage (Stage-1 message handling,
	 * planner iteration, tool call/result, toolSearch, evaluation, ...) into the
	 * step's `semanticStages` envelope so app-chat database trajectories carry
	 * the same diagnostic semantics as the per-turn file recorder (#17030).
	 * Fire-and-forget like {@link logLlmCall}; failures are J7 diagnostics.
	 */
	logSemanticStage(params: { stepId: string; stage: RecordedStage }): void {
		if (!this.acceptsNewCapture()) return;
		if (this.closedStepIds.has(params.stepId)) {
			this.reportLateCapture(params.stepId, "semanticStage");
			return;
		}
		let semantic: TrajectorySemanticStageRecord;
		try {
			semantic = recordedStageToSemanticStage(params.stage);
		} catch (err) {
			// error-policy:J7 an unconvertible stage payload is a diagnostics
			// defect, not a turn failure; report it instead of persisting garbage.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Rejected invalid semantic stage",
				{ stepId: params.stepId, stageKind: params.stage?.kind },
				err,
			);
			return;
		}

		const trajectoryId = this.stepToTrajectory.get(params.stepId);
		if (!trajectoryId) {
			const operation = this.trackInflightOperation(
				(async () => {
					const resolved = await this.resolveTrajectoryId(params.stepId);
					if (!resolved) return;
					await this._persistSemanticStage(resolved, params.stepId, semantic);
				})(),
			);
			void operation.catch((err) => {
				// error-policy:J7 Detached legacy step resolution reports persistence
				// failure without producing an unhandled rejection.
				this.reportDetachedWriteFailure(
					"[trajectory-logger] Failed to persist semantic stage (async step resolution)",
					{ stepId: params.stepId, stageId: semantic.stageId },
					err,
				);
			});
			return;
		}

		const operation = this.trackInflightOperation(
			this._persistSemanticStage(trajectoryId, params.stepId, semantic),
		);
		void operation.catch((err) => {
			// error-policy:J7 The public logging hook is synchronous; its detached
			// persistence failure is reported through the service diagnostic boundary.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist semantic stage",
				{ stepId: params.stepId, stageId: semantic.stageId },
				err,
			);
		});
	}

	private async _persistSemanticStage(
		trajectoryId: string,
		stepId: string,
		semantic: TrajectorySemanticStageRecord,
	): Promise<void> {
		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) return;
			if (trajectory.metrics.finalStatus !== "active") {
				this.rememberClosedStep(stepId);
				this.releaseTrajectoryRouting(trajectoryId);
				this.reportLateCapture(stepId, "semanticStage");
				return;
			}

			const step = await this.ensureStepExists(trajectory, stepId);
			const stages = step.semanticStages ?? [];
			// Idempotent across retries: the stageId is minted once per emit, so a
			// retry re-presents the identical envelope and is dropped. stageIds are
			// timestamp-derived (`stage-tool-${name}-${startedAt}`), though, so two
			// genuinely distinct stages starting in the same millisecond — routine
			// under parallel tool execution — collide here. The file recorder
			// appends unconditionally and keeps both, so a silent drop would break
			// file/DB parity exactly in the concurrent case #17030 exists to
			// diagnose. Warn when the payload differs so the loss is visible.
			const existing = stages.find(
				(entry) => entry.stageId === semantic.stageId,
			);
			if (existing) {
				if (JSON.stringify(existing) !== JSON.stringify(semantic)) {
					logger.warn(
						{
							trajectoryId,
							stepId,
							stageId: semantic.stageId,
							kind: semantic.kind,
						},
						"[trajectory-logger] Dropped a distinct semantic stage that collided on stageId; file/DB stage parity is broken for this step",
					);
				}
				return;
			}
			const nextStages = [...stages, semantic];
			// Write subset read: validate the combined stage array before persistence.
			try {
				parseTrajectorySemanticStages(nextStages);
			} catch (cause) {
				// error-policy:J7 invalid diagnostic data must not poison the row or flush.
				this.reportDetachedWriteFailure(
					"[trajectory-logger] Dropped an invalid semantic stage",
					{
						trajectoryId,
						stepId,
						stageId: semantic.stageId,
						stageCount: nextStages.length,
					},
					new ElizaError("Trajectory step semantic stages are invalid", {
						code: "TRAJECTORY_SEMANTIC_STAGE_INVALID",
						context: {
							trajectoryId,
							stepId,
							stageId: semantic.stageId,
							stageCount: nextStages.length,
						},
						cause,
					}),
				);
				return;
			}
			step.semanticStages = nextStages;

			const updatedAtIso = new Date().toISOString();
			await this.executeRawSql(`
				UPDATE trajectories SET
					steps_json = ${stepsSqlLiteral(trajectory.steps)},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
			`);
		});
	}

	// Legacy compatibility helper (old camel-casing + split args).
	logLLMCall(
		stepId: string,
		details: {
			model: string;
			modelVersion?: string;
			systemPrompt: string;
			userPrompt: string;
			response: string;
			reasoning?: string;
			temperature?: number;
			maxTokens?: number;
			purpose: string;
			actionType?: string;
			latencyMs?: number;
			promptTokens?: number;
			completionTokens?: number;
		},
	): void {
		this.logLlmCall({
			stepId,
			model: details.model,
			modelVersion: details.modelVersion,
			systemPrompt: details.systemPrompt,
			userPrompt: details.userPrompt,
			response: details.response,
			reasoning: details.reasoning,
			temperature: details.temperature,
			maxTokens: details.maxTokens,
			purpose: details.purpose,
			actionType: details.actionType,
			latencyMs: details.latencyMs,
			promptTokens: details.promptTokens,
			completionTokens: details.completionTokens,
		});
	}

	/**
	 * Called by the runtime when a provider is accessed.
	 * Supports both runtime shape and legacy split args.
	 */
	logProviderAccess(params: {
		stepId: string;
		providerName: string;
		startedAt: number;
		endedAt: number;
		durationMs: number;
		overlapsWith: Array<{ providerName: string; overlapMs: number }>;
		data: Record<string, unknown>;
		sha256?: string;
		tokenCount?: number;
		position?: number;
		spanStart?: number;
		spanEnd?: number;
		purpose: string;
		query?: Record<string, unknown>;
		runId?: string;
		roomId?: string;
		messageId?: string;
		executionTraceId?: string;
	}): void;
	logProviderAccess(
		stepId: string,
		params: {
			providerName: string;
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
			data: Record<string, unknown>;
			sha256?: string;
			tokenCount?: number;
			position?: number;
			spanStart?: number;
			spanEnd?: number;
			purpose: string;
			query?: Record<string, unknown>;
			runId?: string;
			roomId?: string;
			messageId?: string;
			executionTraceId?: string;
		},
	): void;
	logProviderAccess(
		arg1:
			| string
			| {
					stepId: string;
					providerName: string;
					startedAt?: number;
					endedAt?: number;
					durationMs?: number;
					overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
					data: Record<string, unknown>;
					sha256?: string;
					tokenCount?: number;
					position?: number;
					spanStart?: number;
					spanEnd?: number;
					purpose: string;
					query?: Record<string, unknown>;
					runId?: string;
					roomId?: string;
					messageId?: string;
					executionTraceId?: string;
			  },
		arg2?: {
			providerName: string;
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
			data: Record<string, unknown>;
			sha256?: string;
			tokenCount?: number;
			position?: number;
			spanStart?: number;
			spanEnd?: number;
			purpose: string;
			query?: Record<string, unknown>;
		},
	): void {
		if (!this.acceptsNewCapture()) return;
		const params =
			typeof arg1 === "string"
				? {
						stepId: arg1,
						providerName: arg2?.providerName ?? "unknown",
						startedAt: arg2?.startedAt,
						endedAt: arg2?.endedAt,
						durationMs: arg2?.durationMs,
						overlapsWith: arg2?.overlapsWith,
						data: arg2?.data ?? {},
						sha256: arg2?.sha256,
						tokenCount: arg2?.tokenCount,
						position: arg2?.position,
						spanStart: arg2?.spanStart,
						spanEnd: arg2?.spanEnd,
						purpose: arg2?.purpose ?? "other",
						query: arg2?.query,
					}
				: arg1;
		if (this.stepClosedBeyondGrace(params.stepId)) {
			this.reportLateCapture(
				params.stepId,
				"provider",
				Date.now() - (this.closedStepIds.get(params.stepId) ?? Date.now()),
			);
			return;
		}

		const trajectoryId = this.stepToTrajectory.get(params.stepId);
		if (!trajectoryId) {
			const operation = this.trackInflightOperation(
				(async () => {
					const resolved = await this.resolveTrajectoryId(params.stepId);
					if (!resolved) {
						logger.debug(
							{ stepId: params.stepId },
							"[trajectory-logger] No trajectory mapping for provider access",
						);
						return;
					}
					await this._persistProviderAccess(resolved, params);
				})(),
			);
			void operation.catch((err) => {
				// error-policy:J7 Detached legacy step resolution reports provider
				// telemetry failure without producing an unhandled rejection.
				this.reportDetachedWriteFailure(
					"[trajectory-logger] Failed to persist provider access (async step resolution)",
					{ stepId: params.stepId },
					err,
				);
			});
			return;
		}

		const operation = this.trackInflightOperation(
			this._persistProviderAccess(trajectoryId, params),
		);
		void operation.catch((err) => {
			// error-policy:J7 Provider telemetry persistence is detached and reported
			// without interrupting the provider that already completed.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist provider access",
				{ stepId: params.stepId },
				err,
			);
		});
	}

	private async _persistProviderAccess(
		trajectoryId: string,
		params: {
			stepId: string;
			providerName: string;
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
			data: Record<string, unknown>;
			sha256?: string;
			tokenCount?: number;
			position?: number;
			spanStart?: number;
			spanEnd?: number;
			purpose: string;
			query?: Record<string, unknown>;
			runId?: string;
			roomId?: string;
			messageId?: string;
			executionTraceId?: string;
		},
	): Promise<void> {
		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) return;
			if (
				trajectory.metrics.finalStatus !== "active" &&
				!this.withinLateCaptureGrace(trajectory)
			) {
				this.rememberClosedStep(params.stepId);
				this.releaseTrajectoryRouting(trajectoryId);
				this.reportLateCapture(
					params.stepId,
					"provider",
					typeof trajectory.endTime === "number"
						? Date.now() - trajectory.endTime
						: undefined,
				);
				return;
			}

			const step = await this.ensureStepExists(trajectory, params.stepId);
			const access: ProviderAccess = {
				providerId: uuidv4(),
				providerName: params.providerName,
				timestamp: Date.now(),
				startedAt: params.startedAt ?? null,
				endedAt: params.endedAt ?? null,
				durationMs: params.durationMs ?? null,
				overlapsWith: Array.isArray(params.overlapsWith)
					? params.overlapsWith
					: [],
				data: params.data as Record<string, JsonValue>,
				sha256: params.sha256,
				tokenCount: params.tokenCount,
				position: params.position,
				spanStart: params.spanStart,
				spanEnd: params.spanEnd,
				query: params.query as Record<string, JsonValue> | undefined,
				purpose: params.purpose,
				runId: params.runId,
				roomId: params.roomId,
				messageId: params.messageId,
				executionTraceId: params.executionTraceId,
			};
			step.providerAccesses.push(access);

			// Targeted UPDATE: only write steps data and summary columns.
			// Do NOT touch status — same rationale as _persistLlmCall.
			const totals = this.computeTotals(trajectory.steps);
			const updatedAtIso = new Date().toISOString();
			await this.executeRawSql(`
				UPDATE trajectories SET
					steps_json = ${stepsSqlLiteral(trajectory.steps)},
					step_count = ${totals.stepCount},
					llm_call_count = ${totals.llmCallCount},
					provider_access_count = ${totals.providerAccessCount},
					total_prompt_tokens = ${totals.totalPromptTokens},
					total_completion_tokens = ${totals.totalCompletionTokens},
					total_cache_read_input_tokens = ${totals.totalCacheReadInputTokens},
					total_cache_creation_input_tokens = ${totals.totalCacheCreationInputTokens},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
			`);
		});
	}

	logProviderAccessByTrajectoryId(
		trajectoryId: string,
		access: {
			providerName: string;
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
			data: Record<string, unknown>;
			sha256?: string;
			tokenCount?: number;
			position?: number;
			spanStart?: number;
			spanEnd?: number;
			purpose: string;
			query?: Record<string, unknown>;
		},
	): void {
		const stepId = this.getCurrentStepId(trajectoryId);
		if (!stepId) {
			logger.debug(
				{ trajectoryId },
				"[trajectory-logger] No active step for provider access by trajectory",
			);
			return;
		}
		this.logProviderAccess(stepId, access);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Trajectory Lifecycle (for RL training / message handling)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Start a new trajectory. Supports both call styles:
	 *   1) startTrajectory(stepId, { agentId, ...legacyOptions })
	 *   2) startTrajectory(agentId, { ...optionsWithoutAgentId })
	 */
	async startTrajectory(
		stepIdOrAgentId: string,
		options: StartTrajectoryOptions = {},
	): Promise<string> {
		if (!this.acceptsNewCapture()) return uuidv4();
		return this.trackInflightOperation(
			this.startAcceptedTrajectory(stepIdOrAgentId, options),
		);
	}

	private async startAcceptedTrajectory(
		stepIdOrAgentId: string,
		options: StartTrajectoryOptions,
	): Promise<string> {
		const isLegacySignature = options.agentId !== undefined;
		const legacyStepId = isLegacySignature ? stepIdOrAgentId : null;
		const requestedAgentId = isLegacySignature
			? options.agentId
			: stepIdOrAgentId;
		if (requestedAgentId !== this.runtime.agentId) {
			throw new ElizaError(
				"Trajectory owner does not match the runtime agent",
				{
					code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
					context: {
						runtimeAgentId: this.runtime.agentId,
						requestedAgentId,
					},
				},
			);
		}
		const agentId = this.runtime.agentId;

		const trajectoryId = uuidv4();
		const now = Date.now();
		const timestampIso = new Date(now).toISOString();
		const metadata: Record<string, JsonValue> = {
			...(options.metadata ?? {}),
			runtimeInstanceId: this.runtime.runtimeInstanceId,
		};
		if (options.roomId) metadata.roomId = options.roomId;
		if (options.entityId) metadata.entityId = options.entityId;
		// Full correlation envelope (#13775) alongside the indexed trace_id column,
		// so downstream joins can read the whole header without a schema change.
		if (options.traceId) {
			metadata.correlation = {
				traceId: options.traceId,
				...(options.roomId ? { roomId: options.roomId } : {}),
				...(options.scenarioId ? { runId: options.scenarioId } : {}),
			};
		}

		const trajectory: Trajectory = {
			trajectoryId:
				trajectoryId as `${string}-${string}-${string}-${string}-${string}`,
			agentId: agentId as `${string}-${string}-${string}-${string}-${string}`,
			startTime: now,
			scenarioId: options.scenarioId,
			episodeId: options.episodeId,
			batchId: options.batchId,
			groupIndex: options.groupIndex,
			steps: [],
			totalReward: 0,
			rewardComponents: { environmentReward: 0 },
			metrics: {
				episodeLength: 0,
				finalStatus: "active",
			},
			metadata: {
				source: options.source ?? "chat",
				...metadata,
			},
		};

		const insertSql = `
			INSERT INTO trajectories (
				id, agent_id, source, status, start_time, scenario_id, trace_id, episode_id,
				batch_id, group_index, metadata_json, steps_json, reward_components_json, metrics_json,
				created_at, updated_at
			) VALUES (
				${sqlLiteral(trajectoryId)},
				${sqlLiteral(agentId)},
				${sqlLiteral(options.source ?? "chat")},
				'active',
				${now},
				${sqlLiteral(options.scenarioId ?? null)},
				${sqlLiteral(options.traceId ?? null)},
				${sqlLiteral(options.episodeId ?? null)},
				${sqlLiteral(options.batchId ?? null)},
				${options.groupIndex ?? "NULL"},
				${sqlLiteral(trajectory.metadata)},
				${sqlLiteral([])},
				${sqlLiteral(trajectory.rewardComponents)},
				${sqlLiteral(trajectory.metrics)},
				${sqlLiteral(timestampIso)},
				${sqlLiteral(timestampIso)}
			)
		`;
		// Register before the insert resolves: a concurrent clear can delete a
		// committed row while its caller is still awaiting the SQL response.
		this.ownedTrajectoryIds.add(trajectoryId);
		try {
			if (legacyStepId) {
				await this.executeRawSqlTransaction(async (execute) => {
					await execute(insertSql);
					await this.setStepIndex(
						legacyStepId,
						trajectoryId,
						-1,
						false,
						execute,
					);
				});
			} else {
				await this.executeRawSql(insertSql);
			}
		} catch (error) {
			this.ownedTrajectoryIds.delete(trajectoryId);
			// error-policy:J2 Preserve the database cause with trajectory identity.
			throw new ElizaError(
				`[trajectory-logger] Failed to persist trajectory start for ${trajectoryId}`,
				{
					code: "TRAJECTORY_START_PERSIST_FAILED",
					context: { trajectoryId },
					cause: error,
				},
			);
		}

		if (legacyStepId) {
			this.stepToTrajectory.set(legacyStepId, trajectoryId);
		}

		return trajectoryId;
	}

	/**
	 * Start a new step within a trajectory.
	 */
	startStep(trajectoryId: string, envState: EnvironmentState): string {
		if (!this.acceptsNewCapture()) return uuidv4();

		const stepId = uuidv4();
		this.closedStepIds.delete(trajectoryId);
		this.closedStepIds.delete(stepId);
		this.activeStepIds.set(trajectoryId, stepId);
		this.stepToTrajectory.set(stepId, trajectoryId);

		void this.withTrajectoryWriteLock(trajectoryId, async () => {
			let committed = false;
			try {
				await this.executeRawSqlTransaction(async (execute) => {
					const trajectory = await this.getTrajectoryById(
						trajectoryId,
						execute,
					);
					if (!trajectory) {
						throw new ElizaError("Trajectory not found for startStep", {
							code: "TRAJECTORY_PARENT_NOT_FOUND",
							context: { trajectoryId, stepId },
						});
					}

					const step = this.createStep(
						stepId,
						trajectory.steps.length,
						envState,
					);
					trajectory.steps.push(step);
					await this.markAllStepsInactive(trajectoryId, execute);
					await this.setStepIndex(
						stepId,
						trajectoryId,
						step.stepNumber,
						true,
						execute,
					);
					await this.persistTrajectory(
						trajectoryId,
						trajectory,
						"active",
						execute,
						false,
					);
				});
				committed = true;
			} finally {
				if (!committed) {
					if (this.activeStepIds.get(trajectoryId) === stepId) {
						this.activeStepIds.delete(trajectoryId);
					}
					if (this.stepToTrajectory.get(stepId) === trajectoryId) {
						this.stepToTrajectory.delete(stepId);
					}
					this.rememberClosedStep(stepId);
				}
			}
		}).catch((err) => {
			// error-policy:J7 startStep has a synchronous id contract; detached
			// persistence failures are surfaced through runtime diagnostics.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist startStep",
				{ trajectoryId, stepId },
				err,
			);
		});

		return stepId;
	}

	/**
	 * Complete a step with action results.
	 * Supports:
	 *   completeStep(trajectoryId, action, rewardInfo?)
	 *   completeStep(trajectoryId, stepId, action, rewardInfo?)
	 */
	completeStep(
		trajectoryId: string,
		action: Omit<ActionAttempt, "attemptId" | "timestamp">,
		rewardInfo?: CompleteStepRewardInfo,
	): void;
	completeStep(
		trajectoryId: string,
		stepId: string,
		action: Omit<ActionAttempt, "attemptId" | "timestamp">,
		rewardInfo?: CompleteStepRewardInfo,
	): void;
	completeStep(
		trajectoryId: string,
		actionOrStepId: string | Omit<ActionAttempt, "attemptId" | "timestamp">,
		actionOrReward?:
			| Omit<ActionAttempt, "attemptId" | "timestamp">
			| CompleteStepRewardInfo,
		maybeReward?: CompleteStepRewardInfo,
	): void {
		if (!this.acceptsNewCapture()) return;

		const explicitStepId =
			typeof actionOrStepId === "string" ? actionOrStepId : null;
		const action = (
			typeof actionOrStepId === "string" ? actionOrReward : actionOrStepId
		) as Omit<ActionAttempt, "attemptId" | "timestamp"> | undefined;
		const rewardInfo = (
			typeof actionOrStepId === "string" ? maybeReward : actionOrReward
		) as CompleteStepRewardInfo | undefined;

		if (!action) return;

		void this.withTrajectoryWriteLock(trajectoryId, async () => {
			let completedStepId: string | null = null;
			await this.executeRawSqlTransaction(async (execute) => {
				const trajectory = await this.getTrajectoryById(trajectoryId, execute);
				if (!trajectory) return;

				const stepId =
					explicitStepId ??
					this.activeStepIds.get(trajectoryId) ??
					(await this.getCurrentStepIdFromDb(trajectoryId, execute));
				if (!stepId) return;

				const step = await this.ensureStepExists(trajectory, stepId, execute);
				// Final persistence boundary for every completeStep caller (planner
				// executor, action/provider interceptors, generic wrappers): the full
				// settlement, including reasoning and future text fields, is projected
				// before it reaches steps_json. Raw values never persist, regardless
				// of which call site produced them.
				const redactDiagnosticText = composeToolDiagnosticRedactor(
					this.runtime,
				);
				const diagnosticAction = projectToolDiagnosticValue(
					action,
					redactDiagnosticText,
				) as typeof action;
				step.action = {
					attemptId: uuidv4(),
					timestamp: Date.now(),
					...diagnosticAction,
					actionType: action.actionType,
					actionName: action.actionName,
					...(typeof action.llmCallId === "string"
						? { llmCallId: action.llmCallId }
						: {}),
				};
				step.done = true;

				if (rewardInfo?.reward !== undefined) {
					step.reward = rewardInfo.reward;
					trajectory.totalReward += rewardInfo.reward;
				}
				if (rewardInfo?.components) {
					trajectory.rewardComponents = {
						...trajectory.rewardComponents,
						...rewardInfo.components,
					};
				}

				await this.setStepIndex(
					stepId,
					trajectoryId,
					step.stepNumber,
					false,
					execute,
				);

				const totals = this.computeTotals(trajectory.steps);
				const updatedAtIso = new Date().toISOString();
				await execute(`
				UPDATE trajectories SET
					steps_json = ${stepsSqlLiteral(trajectory.steps)},
					step_count = ${totals.stepCount},
					llm_call_count = ${totals.llmCallCount},
					provider_access_count = ${totals.providerAccessCount},
					total_prompt_tokens = ${totals.totalPromptTokens},
					total_completion_tokens = ${totals.totalCompletionTokens},
					total_cache_read_input_tokens = ${totals.totalCacheReadInputTokens},
					total_cache_creation_input_tokens = ${totals.totalCacheCreationInputTokens},
					total_reward = ${trajectory.totalReward},
					reward_components_json = ${sqlLiteral(trajectory.rewardComponents)},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
				`);
				completedStepId = stepId;
			});
			if (completedStepId !== null) {
				this.activeStepIds.delete(trajectoryId);
			}
		}).catch((err) => {
			// error-policy:J7 completeStep is a synchronous telemetry hook; detached
			// persistence failures are surfaced through runtime diagnostics.
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to complete step",
				{ trajectoryId },
				err,
			);
		});
	}

	/**
	 * Add delayed outcome reward without reopening or rewriting a completed
	 * trajectory step. The persisted idempotency key makes repeated domain-event
	 * delivery safe across processes.
	 */
	async applyReward(params: {
		trajectoryId: string;
		idempotencyKey: string;
		reward: number;
		component: string;
	}): Promise<boolean> {
		if (!Number.isFinite(params.reward)) {
			throw new ElizaError("Trajectory reward is invalid", {
				code: "TRAJECTORY_REWARD_INVALID",
				context: { trajectoryId: params.trajectoryId },
			});
		}
		let rewardApplied = false;
		await this.withTrajectoryWriteLock(params.trajectoryId, async () =>
			this.executeRawSqlTransaction(async (execute) => {
				const trajectory = await this.getTrajectoryById(
					params.trajectoryId,
					execute,
					true,
				);
				if (!trajectory) return;
				const applied = Array.isArray(trajectory.metadata.appliedRewardKeys)
					? trajectory.metadata.appliedRewardKeys.filter(
							(value): value is string => typeof value === "string",
						)
					: [];
				if (applied.includes(params.idempotencyKey)) {
					rewardApplied = true;
					return;
				}
				trajectory.metadata.appliedRewardKeys = [
					...applied,
					params.idempotencyKey,
				];
				trajectory.totalReward += params.reward;
				trajectory.rewardComponents = {
					...trajectory.rewardComponents,
					components: {
						...(trajectory.rewardComponents.components ?? {}),
						[params.component]:
							(trajectory.rewardComponents.components?.[params.component] ??
								0) + params.reward,
					},
				};
				await execute(`UPDATE trajectories SET
				  total_reward = ${trajectory.totalReward},
				  reward_components_json = ${sqlLiteral(trajectory.rewardComponents)},
				  metadata_json = ${sqlLiteral(trajectory.metadata)},
				  updated_at = ${sqlLiteral(new Date().toISOString())}
				WHERE id = ${sqlLiteral(params.trajectoryId)}`);
				rewardApplied = true;
			}),
		);
		return rewardApplied;
	}

	/**
	 * End a trajectory and persist final state.
	 */
	async endTrajectory(
		stepIdOrTrajectoryId: string,
		status: "completed" | "error" | "timeout" | "terminated" = "completed",
		finalMetrics?: Record<string, JsonValue>,
	): Promise<void> {
		if (!this.acceptsNewCapture()) return;
		return this.trackInflightOperation(
			this.endTrajectoryAfterResolution(
				stepIdOrTrajectoryId,
				status,
				finalMetrics,
			),
		);
	}

	private async endTrajectoryAfterResolution(
		stepIdOrTrajectoryId: string,
		status: "completed" | "error" | "timeout" | "terminated",
		finalMetrics?: Record<string, JsonValue>,
	): Promise<void> {
		const trajectoryId = await this.resolveTrajectoryId(stepIdOrTrajectoryId);
		if (!trajectoryId) {
			logger.debug(
				{ stepIdOrTrajectoryId },
				"[trajectory-logger] No trajectory to end",
			);
			return;
		}

		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			await this.executeRawSqlTransaction(async (execute) => {
				const trajectory = await this.getTrajectoryById(trajectoryId, execute);
				if (!trajectory) {
					throw new ElizaError("Trajectory not found while ending", {
						code: "TRAJECTORY_PARENT_NOT_FOUND",
						context: { trajectoryId },
					});
				}

				const now = Date.now();
				trajectory.endTime = now;
				trajectory.durationMs = now - trajectory.startTime;
				trajectory.metrics = {
					...trajectory.metrics,
					...(finalMetrics ?? {}),
					finalStatus: status,
					episodeLength: trajectory.steps.length,
				};

				await this.markAllStepsInactive(trajectoryId, execute);
				await this.persistTrajectory(
					trajectoryId,
					trajectory,
					status,
					execute,
					false,
				);
			});
		});

		this.releaseTrajectoryRouting(trajectoryId);
		this.ownedTrajectoryIds.delete(trajectoryId);
	}

	/**
	 * Release in-memory routing after an outer event boundary has reported an
	 * unrecoverable terminal write. This never changes persisted trajectory data.
	 */
	releaseTrajectoryOwnership(stepIdOrTrajectoryId: string): void {
		const trajectoryId =
			this.stepToTrajectory.get(stepIdOrTrajectoryId) ?? stepIdOrTrajectoryId;
		this.releaseTrajectoryRouting(trajectoryId);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Query Interface (for UI and export)
	// ─────────────────────────────────────────────────────────────────────────

	async listTrajectories(
		options: TrajectoryListOptions = {},
	): Promise<TrajectoryListResult> {
		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime.adapter) throw this.storageUnavailableError();
		const db = runtime.adapter.db as { execute?: unknown } | undefined;
		if (!db || typeof db.execute !== "function")
			throw this.storageUnavailableError();
		await this.ensureStorageReady();

		const offset = Math.max(0, options.offset ?? 0);
		const limit = Math.min(500, Math.max(1, options.limit ?? 50));

		const whereClauses: string[] = [
			`agent_id = ${sqlLiteral(this.runtime.agentId)}`,
		];
		if (options.roomId) {
			whereClauses.push(
				`metadata_json->>'roomId' = ${sqlLiteral(options.roomId)}`,
			);
		}
		if (options.status) {
			whereClauses.push(`status = ${sqlLiteral(options.status)}`);
		}
		if (options.source) {
			whereClauses.push(`source = ${sqlLiteral(options.source)}`);
		}
		if (options.runId) {
			whereClauses.push(trajectoryRunIdWhereClause(options.runId));
		}
		if (options.scenarioId) {
			whereClauses.push(`scenario_id = ${sqlLiteral(options.scenarioId)}`);
		}
		if (options.traceId) {
			whereClauses.push(`trace_id = ${sqlLiteral(options.traceId)}`);
		}
		if (options.batchId) {
			whereClauses.push(`batch_id = ${sqlLiteral(options.batchId)}`);
		}
		if (options.isTrainingData !== undefined) {
			whereClauses.push(`is_training_data = ${options.isTrainingData}`);
		}
		if (options.startDate) {
			whereClauses.push(
				`created_at >= ${sqlLiteral(options.startDate)}::timestamptz`,
			);
		}
		if (options.endDate) {
			whereClauses.push(
				`created_at <= ${sqlLiteral(options.endDate)}::timestamptz`,
			);
		}
		if (options.search) {
			// Single-pass escape so LIKE-wildcard escapes do not introduce
			// unescaped backslashes.
			const escaped = options.search.replace(/[\\'%_]/g, (ch) => {
				if (ch === "'") return "''";
				if (ch === "\\") return "\\\\";
				return `\\${ch}`;
			});
			whereClauses.push(`(
        id ILIKE '%${escaped}%' OR
        agent_id ILIKE '%${escaped}%' OR
        source ILIKE '%${escaped}%' OR
        scenario_id ILIKE '%${escaped}%'
      )`);
		}

		const whereClause =
			whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const countResult = await this.executeRawSql(
			`SELECT count(*)::int AS total FROM trajectories ${whereClause}`,
		);
		const total = requiredTrajectoryCell(
			asNumber(pickCell(countResult.rows[0] ?? {}, "total")),
			"total",
		);

		const rowsResult = await this.executeRawSql(`
      SELECT
        id, agent_id, source, status, start_time, end_time, duration_ms,
        step_count, llm_call_count, total_prompt_tokens, total_completion_tokens,
        total_cache_read_input_tokens, total_cache_creation_input_tokens,
        total_reward, scenario_id, episode_id, batch_id, group_index,
        metadata_json, steps_json, reward_components_json, metrics_json,
        created_at, updated_at
      FROM trajectories
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

		const trajectories: TrajectoryListItem[] = rowsResult.rows.map((row) => {
			const id = requiredTrajectoryCell(asString(pickCell(row, "id")), "id");
			const decoded = this.rowToTrajectory(row);
			const status = parseTrajectoryStatus(pickCell(row, "status"), id);
			const startTime = decoded.startTime;
			const requiredNumber = (field: string): number =>
				requiredTrajectoryCell(asNumber(pickCell(row, field)), field, id);
			const metadata = decoded.metadata;
			const asNullableString = (value: JsonValue | undefined): string | null =>
				typeof value === "string" ? value : null;

			return {
				id,
				agentId: requiredTrajectoryCell(
					asString(pickCell(row, "agent_id")),
					"agent_id",
					id,
				),
				source: requiredTrajectoryCell(
					asString(pickCell(row, "source")),
					"source",
					id,
				),
				roomId: asNullableString(metadata.roomId),
				entityId: asNullableString(metadata.entityId),
				metadata,
				status,
				startTime,
				endTime: decoded.endTime ?? null,
				durationMs: decoded.durationMs ?? null,
				stepCount: requiredNumber("step_count"),
				llmCallCount: requiredNumber("llm_call_count"),
				totalPromptTokens: requiredNumber("total_prompt_tokens"),
				totalCompletionTokens: requiredNumber("total_completion_tokens"),
				totalCacheReadInputTokens: requiredNumber(
					"total_cache_read_input_tokens",
				),
				totalCacheCreationInputTokens: requiredNumber(
					"total_cache_creation_input_tokens",
				),
				totalReward: requiredNumber("total_reward"),
				scenarioId: asString(pickCell(row, "scenario_id")),
				batchId: asString(pickCell(row, "batch_id")),
				createdAt: requiredTrajectoryCell(
					asIsoString(pickCell(row, "created_at")),
					"created_at",
					id,
				),
				updatedAt: normalizeReadTrajectoryUpdatedAt({
					startTime,
					endTime: decoded.endTime ?? null,
					createdAtMs: asEpochMs(pickCell(row, "created_at")),
					updatedAtMs: asEpochMs(pickCell(row, "updated_at")),
				}),
			};
		});

		return { trajectories, total, offset, limit };
	}

	async getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime.adapter) throw this.storageUnavailableError();
		await this.ensureStorageReady();

		const safeId = trajectoryId.replace(/'/g, "''");
		const result = await this.executeRawSql(
			`SELECT * FROM trajectories WHERE id = '${safeId}'
			 AND agent_id = ${sqlLiteral(this.runtime.agentId)} LIMIT 1`,
		);

		if (result.rows.length === 0) return null;

		const row = result.rows[0];
		const trajectory = this.rowToTrajectory(row);
		return trajectory;
	}

	async getStats(): Promise<TrajectoryStats> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime.adapter) throw this.storageUnavailableError();
		await this.ensureStorageReady();

		const statsResult = await this.executeRawSql(`
      SELECT
        count(*)::int AS total_trajectories,
        COALESCE(sum(step_count), 0)::bigint AS total_steps,
        COALESCE(sum(llm_call_count), 0)::bigint AS total_llm_calls,
        COALESCE(sum(total_prompt_tokens), 0)::bigint AS total_prompt_tokens,
        COALESCE(sum(total_completion_tokens), 0)::bigint AS total_completion_tokens,
        COALESCE(sum(total_cache_read_input_tokens), 0)::bigint AS total_cache_read_input_tokens,
        COALESCE(sum(total_cache_creation_input_tokens), 0)::bigint AS total_cache_creation_input_tokens,
        COALESCE(avg(duration_ms), 0)::int AS avg_duration_ms,
        COALESCE(avg(total_reward), 0)::real AS avg_reward
      FROM trajectories
      WHERE agent_id = ${sqlLiteral(this.runtime.agentId)}
    `);

		const sourceResult = await this.executeRawSql(`
      SELECT source, count(*)::int AS cnt
      FROM trajectories
      WHERE agent_id = ${sqlLiteral(this.runtime.agentId)}
      GROUP BY source
    `);

		const statusResult = await this.executeRawSql(`
      SELECT status, count(*)::int AS cnt
      FROM trajectories
      WHERE agent_id = ${sqlLiteral(this.runtime.agentId)}
      GROUP BY status
    `);

		const scenarioResult = await this.executeRawSql(`
      SELECT scenario_id, count(*)::int AS cnt
      FROM trajectories
      WHERE scenario_id IS NOT NULL
        AND agent_id = ${sqlLiteral(this.runtime.agentId)}
      GROUP BY scenario_id
    `);

		const stats = requiredTrajectoryCell(statsResult.rows[0] ?? null, "stats");
		const requiredStat = (field: string): number =>
			requiredTrajectoryCell(asNumber(pickCell(stats, field)), field);
		const bySource: Record<string, number> = {};
		const byStatus: Record<string, number> = {};
		const byScenario: Record<string, number> = {};

		for (const row of sourceResult.rows) {
			const source = asString(pickCell(row, "source"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (source && cnt !== null) bySource[source] = cnt;
		}

		for (const row of statusResult.rows) {
			const status = asString(pickCell(row, "status"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (status && cnt !== null) byStatus[status] = cnt;
		}

		for (const row of scenarioResult.rows) {
			const scenario = asString(pickCell(row, "scenario_id"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (scenario && cnt !== null) byScenario[scenario] = cnt;
		}

		return {
			totalTrajectories: requiredStat("total_trajectories"),
			totalSteps: requiredStat("total_steps"),
			totalLlmCalls: requiredStat("total_llm_calls"),
			totalPromptTokens: requiredStat("total_prompt_tokens"),
			totalCompletionTokens: requiredStat("total_completion_tokens"),
			totalCacheReadInputTokens: requiredStat("total_cache_read_input_tokens"),
			totalCacheCreationInputTokens: requiredStat(
				"total_cache_creation_input_tokens",
			),
			averageDurationMs: requiredStat("avg_duration_ms"),
			averageReward: requiredStat("avg_reward"),
			bySource,
			byStatus,
			byScenario,
		};
	}

	async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime.adapter) throw this.storageUnavailableError();
		if (trajectoryIds.length === 0) return 0;
		await this.ensureStorageReady();

		const ids = trajectoryIds.map(sqlLiteral).join(", ");
		const deletedRows = await this.executeRawSqlTransaction(async (execute) => {
			await execute(`DELETE FROM trajectory_steps WHERE trajectory_id IN (
				SELECT id FROM trajectories WHERE id IN (${ids})
				AND agent_id = ${sqlLiteral(this.runtime.agentId)}
			)`);
			const result = await execute(
				`DELETE FROM trajectories WHERE id IN (${ids})
				 AND agent_id = ${sqlLiteral(this.runtime.agentId)} RETURNING id`,
			);
			return result.rows;
		});
		return this.releaseDeletedTrajectories(deletedRows);
	}

	async clearAllTrajectories(): Promise<number> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime.adapter) throw this.storageUnavailableError();
		await this.ensureStorageReady();

		const deletedRows = await this.executeRawSqlTransaction(async (execute) => {
			await execute(`DELETE FROM trajectory_steps WHERE trajectory_id IN (
				SELECT id FROM trajectories WHERE agent_id = ${sqlLiteral(this.runtime.agentId)}
			)`);
			const result = await execute(
				`DELETE FROM trajectories WHERE agent_id = ${sqlLiteral(this.runtime.agentId)} RETURNING id`,
			);
			return result.rows;
		});
		return this.releaseDeletedTrajectories(deletedRows);
	}

	private releaseDeletedTrajectories(rows: SqlRow[]): number {
		for (const row of rows) {
			const trajectoryId = requiredTrajectoryCell(
				asString(pickCell(row, "id")),
				"id",
			);
			this.ownedTrajectoryIds.delete(trajectoryId);
			this.releaseTrajectoryRouting(trajectoryId);
		}
		return rows.length;
	}

	private storageUnavailableError(): ElizaError {
		return new ElizaError(
			"Trajectory storage requires a SQL database adapter",
			{
				code: "TRAJECTORY_STORAGE_UNAVAILABLE",
			},
		);
	}

	private sanitizeZipFolderName(value: string): string {
		const trimmed = value.trim();
		const safe = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
		const sanitized = safe
			.replace(/[^a-zA-Z0-9._-]+/g, "_")
			.replace(/^_+|_+$/g, "");
		return sanitized || "trajectory";
	}

	private redactTrajectoryPrompts(trajectory: Trajectory): Trajectory {
		return {
			...trajectory,
			steps: trajectory.steps.map((step) => ({
				...step,
				llmCalls: step.llmCalls.map((call) => ({
					...call,
					systemPrompt: "[redacted]",
					userPrompt: "[redacted]",
					response: "[redacted]",
				})),
			})),
		};
	}

	private buildZipSummary(trajectory: Trajectory): {
		id: string;
		agentId: string;
		roomId: string | null;
		entityId: string | null;
		conversationId: string | null;
		source: string;
		status: "active" | "completed" | "error";
		startTime: number;
		endTime: number | null;
		durationMs: number | null;
		llmCallCount: number;
		providerAccessCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		totalCacheReadInputTokens: number;
		totalCacheCreationInputTokens: number;
		metadata: Record<string, JsonValue | undefined>;
		createdAt: string;
		updatedAt: string;
	} {
		const finalStatus = trajectory.metrics.finalStatus;
		const rawEndTime =
			typeof trajectory.endTime === "number" ? trajectory.endTime : null;
		const timingStatus = isFinalTrajectoryStatus(finalStatus)
			? finalStatus
			: rawEndTime
				? "completed"
				: "active";
		const timing = normalizeReadTrajectoryTiming({
			status: timingStatus,
			startTime: trajectory.startTime,
			endTime: rawEndTime,
			durationMs:
				typeof trajectory.durationMs === "number"
					? trajectory.durationMs
					: null,
		});
		const normalizedEndTime = timing.endTime;
		const status: "active" | "completed" | "error" =
			finalStatus === "timeout" ||
			finalStatus === "terminated" ||
			finalStatus === "error"
				? "error"
				: finalStatus === "completed"
					? "completed"
					: normalizedEndTime
						? "completed"
						: "active";

		let llmCallCount = 0;
		let providerAccessCount = 0;
		let totalPromptTokens = 0;
		let totalCompletionTokens = 0;
		let totalCacheReadInputTokens = 0;
		let totalCacheCreationInputTokens = 0;

		for (const step of trajectory.steps) {
			providerAccessCount += step.providerAccesses.length;
			llmCallCount += step.llmCalls.length;
			for (const call of step.llmCalls) {
				totalPromptTokens += call.promptTokens ?? 0;
				totalCompletionTokens += call.completionTokens ?? 0;
				totalCacheReadInputTokens += call.cacheReadInputTokens ?? 0;
				totalCacheCreationInputTokens += call.cacheCreationInputTokens ?? 0;
			}
		}

		const metadata = trajectory.metadata;
		const asNullableString = (value: JsonValue | undefined): string | null =>
			typeof value === "string" ? value : null;
		const source =
			typeof metadata.source === "string" ? metadata.source : "chat";
		const normalizedDurationMs = status === "active" ? null : timing.durationMs;
		const updatedAtMs =
			normalizedEndTime ?? (trajectory.startTime || Date.now());

		return {
			id: trajectory.trajectoryId,
			agentId: trajectory.agentId,
			roomId: asNullableString(metadata.roomId),
			entityId: asNullableString(metadata.entityId),
			conversationId: asNullableString(metadata.conversationId),
			source,
			status,
			startTime: trajectory.startTime,
			endTime: normalizedEndTime,
			durationMs: normalizedDurationMs,
			llmCallCount,
			providerAccessCount,
			totalPromptTokens,
			totalCompletionTokens,
			totalCacheReadInputTokens,
			totalCacheCreationInputTokens,
			metadata,
			createdAt: new Date(trajectory.startTime).toISOString(),
			updatedAt: new Date(updatedAtMs).toISOString(),
		};
	}

	async exportTrajectoriesZip(
		options: TrajectoryZipExportOptions = {},
	): Promise<TrajectoryZipExportResult> {
		let targetIds = Array.isArray(options.trajectoryIds)
			? options.trajectoryIds.filter(
					(id): id is string => typeof id === "string" && id.trim().length > 0,
				)
			: [];

		if (targetIds.length === 0) {
			const list = await this.listTrajectories({
				limit: 500,
				source: options.source,
				status: options.status,
				search: options.search,
				runId: options.runId,
				startDate: options.startDate,
				endDate: options.endDate,
				scenarioId: options.scenarioId,
				traceId: options.traceId,
				batchId: options.batchId,
			});
			targetIds = list.trajectories.map((trajectory) => trajectory.id);
		}

		const entries: TrajectoryZipEntry[] = [];
		const manifestRows: Array<{
			trajectoryId: string;
			folder: string;
			createdAt: string;
		}> = [];

		for (const trajectoryId of targetIds) {
			const detail = await this.getTrajectoryDetail(trajectoryId);
			if (!detail) continue;

			const exportTrajectory =
				options.includePrompts === false
					? this.redactTrajectoryPrompts(detail)
					: detail;
			const summary = this.buildZipSummary(exportTrajectory);
			const folderName = this.sanitizeZipFolderName(trajectoryId);

			entries.push({
				name: `${folderName}/trajectory.json`,
				data: JSON.stringify(exportTrajectory, null, 2),
			});
			entries.push({
				name: `${folderName}/summary.json`,
				data: JSON.stringify(summary, null, 2),
			});

			manifestRows.push({
				trajectoryId,
				folder: folderName,
				createdAt: summary.createdAt,
			});
		}

		entries.unshift({
			name: "manifest.json",
			data: JSON.stringify(
				{
					exportedAt: new Date().toISOString(),
					trajectories: manifestRows,
				},
				null,
				2,
			),
		});

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return {
			filename: `trajectories-${timestamp}.zip`,
			entries,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Export (for RL training)
	// ─────────────────────────────────────────────────────────────────────────

	async exportTrajectories(
		options: CanonicalTrajectoryExportOptions,
	): Promise<TrajectoryExportResult> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime.adapter) {
			throw new Error("Database not available");
		}
		await this.ensureStorageReady();

		const whereClauses: string[] = [
			`agent_id = ${sqlLiteral(this.runtime.agentId)}`,
		];
		if (options.trajectoryIds && options.trajectoryIds.length > 0) {
			const ids = options.trajectoryIds.map(sqlLiteral).join(", ");
			whereClauses.push(`id IN (${ids})`);
		}
		if (options.status) {
			whereClauses.push(`status = ${sqlLiteral(options.status)}`);
		}
		if (options.source) {
			whereClauses.push(`source = ${sqlLiteral(options.source)}`);
		}
		if (options.runId) {
			whereClauses.push(trajectoryRunIdWhereClause(options.runId));
		}
		if (options.startDate) {
			whereClauses.push(
				`created_at >= ${sqlLiteral(options.startDate)}::timestamptz`,
			);
		}
		if (options.endDate) {
			whereClauses.push(
				`created_at <= ${sqlLiteral(options.endDate)}::timestamptz`,
			);
		}
		if (options.scenarioId) {
			whereClauses.push(`scenario_id = ${sqlLiteral(options.scenarioId)}`);
		}
		if (options.traceId) {
			whereClauses.push(`trace_id = ${sqlLiteral(options.traceId)}`);
		}
		if (options.batchId) {
			whereClauses.push(`batch_id = ${sqlLiteral(options.batchId)}`);
		}
		if (options.search) {
			const escaped = options.search.replace(/[\\'%_]/g, (ch) => {
				if (ch === "'") return "''";
				if (ch === "\\") return "\\\\";
				return `\\${ch}`;
			});
			whereClauses.push(`(
				id ILIKE '%${escaped}%' OR
				agent_id ILIKE '%${escaped}%' OR
				source ILIKE '%${escaped}%' OR
				scenario_id ILIKE '%${escaped}%'
			)`);
		}

		const whereClause =
			whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const result = await this.executeRawSql(
			`SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC`,
		);

		const trajectories: TrajectoryDetailRecord[] = result.rows.map((row) => {
			const trajectory = this.rowToTrajectory(row);
			return {
				...trajectory,
				source:
					typeof trajectory.metadata.source === "string"
						? trajectory.metadata.source
						: undefined,
			};
		});

		return serializeTrajectoryExport(trajectories, options);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Helpers
	// ─────────────────────────────────────────────────────────────────────────

	private rowToTrajectory(row: SqlRow): Trajectory {
		const id = requiredTrajectoryCell(asString(pickCell(row, "id")), "id");
		const startTime = requiredTrajectoryCell(
			asNumber(pickCell(row, "start_time")),
			"start_time",
			id,
		);
		const metrics = parseTrajectoryMetrics(
			pickCell(row, "metrics_json", "metrics"),
		);
		const status = parseTrajectoryStatus(pickCell(row, "status"), id);
		if (metrics.finalStatus !== status) {
			throw new ElizaError(
				"Trajectory status does not match its canonical metrics",
				{
					code: "TRAJECTORY_ROW_INVALID",
					context: { rowId: id, field: "metrics_json.finalStatus" },
				},
			);
		}
		const timing = normalizeReadTrajectoryTiming({
			status,
			startTime,
			endTime: parseNullableNumberCell(
				pickCell(row, "end_time"),
				"end_time",
				id,
			),
			durationMs: parseNullableNumberCell(
				pickCell(row, "duration_ms"),
				"duration_ms",
				id,
			),
			rowId: id,
		});

		return {
			trajectoryId: id as `${string}-${string}-${string}-${string}-${string}`,
			agentId: requiredTrajectoryCell(
				asString(pickCell(row, "agent_id")),
				"agent_id",
				id,
			) as `${string}-${string}-${string}-${string}-${string}`,
			startTime,
			...(timing.endTime === null ? {} : { endTime: timing.endTime }),
			...(timing.durationMs === null ? {} : { durationMs: timing.durationMs }),
			scenarioId: asString(pickCell(row, "scenario_id")) ?? undefined,
			episodeId: asString(pickCell(row, "episode_id")) ?? undefined,
			batchId: asString(pickCell(row, "batch_id")) ?? undefined,
			groupIndex: asNumber(pickCell(row, "group_index")) ?? undefined,
			steps: parseTrajectorySteps(pickCell(row, "steps_json", "steps")),
			totalReward: requiredTrajectoryCell(
				asNumber(pickCell(row, "total_reward")),
				"total_reward",
				id,
			),
			rewardComponents: parseRewardComponents(
				pickCell(row, "reward_components_json", "reward_components"),
			),
			metrics,
			metadata: parseTrajectoryMetadata(
				pickCell(row, "metadata_json", "metadata"),
			),
		};
	}

	/**
	 * Get active trajectory for a step (for compatibility with existing code)
	 */
	getActiveTrajectory(trajectoryId: string): Trajectory | null {
		void trajectoryId;
		return null;
	}

	/**
	 * Get current step ID for a trajectory
	 */
	getCurrentStepId(trajectoryId: string): string | null {
		return this.acceptsNewCapture()
			? this.activeStepIds.get(trajectoryId) || null
			: null;
	}

	/**
	 * Legacy compatibility: get in-memory provider access logs
	 */
	getProviderAccessLogs(): readonly ProviderAccess[] {
		return [];
	}

	/**
	 * Legacy compatibility: get in-memory LLM call logs
	 */
	getLlmCallLogs(): readonly LLMCall[] {
		return [];
	}
}
