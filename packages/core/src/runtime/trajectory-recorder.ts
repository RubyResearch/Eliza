/**
 * Trajectory recorder — JSON-file backend for the v5 native-tool-calling
 * trajectory observability subsystem.
 *
 * Spec: PLAN.md §18.1 (`RecordedStage` / `RecordedTrajectory` schemas) and
 * §18.2 (`TrajectoryRecorder` interface).
 *
 * Output shape is read by `packages/scripts/trajectory.ts`.
 *
 * Persistence model:
 * - One JSON file per trajectory at
 *   `${ELIZA_TRAJECTORY_DIR ?? `${resolveStateDir()}/trajectories`}/<agentId>/<trajectoryId>.json`.
 * - Atomic writes: write to `<id>.json.tmp`, rename to `<id>.json`.
 * - Append-only stages: `recordStage` rewrites the whole file (small files,
 *   sub-100 KB typical).
 * - Failures must NOT crash the runtime — every I/O operation is wrapped in
 *   try/catch and routed through `runtime.logger.warn`.
 *
 * On/off is decided by the shared gate resolver (trajectory-gate.ts), so this
 * recorder and the DB logger agree: prod is opt-in (SOC2 O-5), test is off.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAliasedEnvValue } from "../boot-env";
import { ElizaError } from "../errors";
import {
	computeCallCostUsd,
	PRICE_TABLE_ID,
} from "../features/trajectories/pricing";
import {
	composeToolDiagnosticRedactor,
	projectCompleteToolArgsForModel,
	projectCompleteToolValueForModel,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import type { EvaluationResult } from "../types/components";
import type { ChatMessage, ToolChoice } from "../types/model";
import { readEnv } from "../utils/read-env";
import { resolveStateDir } from "../utils/state-dir";
import { toWellFormedUnicode } from "../utils/well-formed";
import { stringifyForDiagnostics } from "./json-output";
import {
	resolveTraceCorrelationFromEnv,
	type TraceCorrelation,
} from "./trace-correlation";
import { resolveTrajectoryGate } from "./trajectory-gate";
import type { TrajectoryProviderAttribution } from "./trajectory-provider-attribution";
import {
	canonicalPromptForModelCall,
	omitUnvalidatedProviderSpans,
} from "./trajectory-provider-attribution";
import type { RecordedStageKind } from "./trajectory-stage-kind";

export {
	RECORDED_STAGE_KINDS,
	type RecordedStageKind,
} from "./trajectory-stage-kind";

// ---------------------------------------------------------------------------
// Schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

export interface RecordedUsage {
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
}

export interface RecordedToolCall {
	id?: string;
	name?: string;
	args?: Record<string, unknown>;
}

export interface RecordedModelCall {
	modelType: string;
	modelName?: string;
	provider?: string;
	prompt?: string;
	messages?: ChatMessage[] | unknown[];
	tools?: unknown;
	toolChoice?: ToolChoice | unknown;
	providerOptions?: unknown;
	response: string;
	toolCalls?: RecordedToolCall[];
	usage?: RecordedUsage;
	finishReason?: string;
	/**
	 * USD cost of this LLM call computed from the price table identified by
	 * `priceTableId`. Local-inference providers (Ollama / LM Studio /
	 * llama.cpp) record a real `0` — not "missing". The recorder emits a
	 * warning log when a hosted-provider model has no price entry and omits the
	 * field so unknown spend cannot be mistaken for free inference.
	 */
	costUsd?: number;
	/**
	 * Snapshot identifier of the price table used to compute `costUsd`.
	 * Closes M40 / W1-X1. Bumped whenever any rate in the canonical
	 * pricing table at `features/trajectories/pricing.ts` changes.
	 */
	priceTableId?: string;
	/** Provider order selected for the composeState call that fed this model input. */
	providerOrder?: string[];
	/**
	 * Hash-first provider contributions. No provider text is duplicated: when
	 * `spanStart`/`spanEnd` are present they index into the flattened form of the
	 * persisted `messages` (`flattenTrajectoryMessages(messages)`), derived once
	 * at read time — consumers slice that to verify exact provenance rather than a
	 * second stored copy of the prompt.
	 */
	providerAttributions?: TrajectoryProviderAttribution[];
}

/** Legacy marker retained so historical trajectory rows remain readable. */
export interface RecordedTruncationMarker {
	field: "input" | "output" | "error" | "args" | "result";
	originalBytes: number;
	capBytes: number;
}

export interface RecordedToolStage {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
	/**
	 * The model-facing tool description the planner was shown for this action —
	 * i.e. the exposed `ToolDefinition.description`, which is the action's
	 * `routingHint` (its "use when / do NOT use when" guidance) prepended to the
	 * compressed description. Captured so a trajectory reviewer or training
	 * pipeline can see WHAT the action was for — and judge whether the planner
	 * had enough to disambiguate it — directly from the execution record, without
	 * cross-referencing the preceding planner stage's `model.tools`.
	 */
	description?: string;
	error?: string;
	/** Complete action-handler input, encoded as JSON when possible. */
	input?: string;
	/**
	 * Captured action-handler output (the full result the action returned,
	 * not just the planner-shaped summary).
	 */
	output?: string;
	/**
	 * Captured action-handler error text.
	 * Mirrors `error` for free-text reads; structured `error` above is kept
	 * for backwards compatibility with existing readers.
	 */
	errorText?: string;
	/**
	 * Legacy loss markers read from historical rows; new captures omit them.
	 */
	truncated?: RecordedTruncationMarker[];
}

/**
 * Per-stage retrieval entry captured when measurement mode is on. One
 * entry per (action, stage) pair, recorded BEFORE reciprocal-rank-fusion
 * so the funnel analyzer can see what each individual stage produced.
 */
export interface RecordedRetrievalStageEntry {
	actionName: string;
	score: number;
	rank: number;
}

/**
 * Per-stage retrieval scores captured under `ELIZA_RETRIEVAL_MEASUREMENT=1`.
 * Default `undefined` — no perf cost in production unless the env var is
 * explicitly enabled.
 */
export interface RecordedRetrievalPerStageScores {
	exact: RecordedRetrievalStageEntry[];
	regex: RecordedRetrievalStageEntry[];
	keyword: RecordedRetrievalStageEntry[];
	bm25: RecordedRetrievalStageEntry[];
	embedding: RecordedRetrievalStageEntry[];
	contextMatch: RecordedRetrievalStageEntry[];
}

/**
 * Snapshot of the tool-search / action-retrieval phase. Logged once per
 * planner turn before the LLM call so reviewers can see which actions
 * were considered, the retrieval scores, and which tier each landed in.
 */
export interface RecordedToolSearchStage {
	query: {
		text: string;
		tokens?: string[];
		candidateActions?: string[];
		parentActionHints?: string[];
	};
	results: Array<{
		name: string;
		score: number;
		rank: number;
		rrfScore?: number;
		matchedBy?: string[];
		stageScores?: Record<string, number>;
	}>;
	tier: { tierA: string[]; tierB: string[]; omitted: number };
	durationMs: number;
	fallback?: string;
	/**
	 * Per-stage retrieval funnel. Populated only when the retrieval call
	 * ran with measurement mode on (`ELIZA_RETRIEVAL_MEASUREMENT=1`).
	 */
	perStageScores?: RecordedRetrievalPerStageScores;
	/**
	 * Top-K fused (RRF) results. Mirrors `results` but exposes the raw
	 * `rrfScore` field directly so downstream analyzers don't need to
	 * unify the two shapes. Populated only under measurement mode.
	 */
	fusedTopK?: Array<{ actionName: string; rrfScore: number; rank: number }>;
	/**
	 * Actions the planner ultimately invoked this turn. Recorded by the
	 * caller after the planner loop resolves — the retrieval call itself
	 * does not know which results were selected.
	 */
	selectedActions?: string[];
	/**
	 * Ground-truth actions for this scenario, when available. Sourced from
	 * the scenario manifest by the benchmark harness; never inferred from
	 * the trajectory.
	 */
	correctActions?: string[];
}

export interface RecordedEvaluationStage extends EvaluationResult {
	protocolFailure?: true;
	[key: string]: unknown;
}

/**
 * Snapshot of the facts/relationships extraction stage. Logged whenever
 * Stage 1 emits a non-empty `extract` and the dedup/persist pass runs in
 * parallel with the planner. Lets reviewers see (a) what the model thought
 * was worth keeping vs. dropping, and (b) what actually persisted.
 */
export interface RecordedFactsAndRelationshipsStage {
	candidates: {
		facts: string[];
		relationships: Array<{
			subject: string;
			predicate: string;
			object: string;
		}>;
	};
	kept: {
		facts: string[];
		relationships: Array<{
			subject: string;
			predicate: string;
			object: string;
		}>;
	};
	written: { facts: number; relationships: number };
	thought: string;
	/** Mirrors the gated evaluation stage: a deterministic gate answered without a model call. */
	llmCallSkipped?: boolean;
	reason?: string;
}

export interface RecordedCacheStage {
	segmentHashes: string[];
	prefixHash: string;
	diffFromPriorStage?: {
		added: number;
		unchanged: number;
		removed: number;
	};
}

export interface RecordedStage {
	stageId: string;
	kind: RecordedStageKind;
	iteration?: number;
	retryIdx?: number;
	parentStageId?: string;
	startedAt: number;
	endedAt: number;
	latencyMs: number;
	model?: RecordedModelCall;
	tool?: RecordedToolStage;
	toolSearch?: RecordedToolSearchStage;
	evaluation?: RecordedEvaluationStage;
	cache?: RecordedCacheStage;
	factsAndRelationships?: RecordedFactsAndRelationshipsStage;
}

export interface RecordedTrajectoryMetrics {
	totalLatencyMs: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalReasoningTokens?: number;
	totalCostUsd: number;
	plannerIterations: number;
	toolCallsExecuted: number;
	toolCallFailures: number;
	toolSearchCount: number;
	evaluatorFailures: number;
	finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

export interface RecordedTrajectory {
	trajectoryId: string;
	agentId: string;
	roomId?: string;
	runId?: string;
	scenarioId?: string;
	// Correlation header (#13775) joining this file trajectory to the DB row and
	// any orchestrator task. `traceId` is minted at the root turn or inherited
	// from a spawning parent; the rest are set when the recorder runs inside a
	// sub-agent. Optional because pre-rollout trajectories carry none.
	traceId?: string;
	taskId?: string;
	sessionId?: string;
	parentStepId?: string;
	codingActionProfile?: {
		kind: "pi";
		includeWorktree: boolean;
	};
	rootMessage: { id: string; text: string; sender?: string };
	startedAt: number;
	endedAt?: number;
	status: "running" | "finished" | "errored";
	stages: RecordedStage[];
	metrics: RecordedTrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// TrajectoryRecorder interface (PLAN.md §18.2)
// ---------------------------------------------------------------------------

export interface StartTrajectoryInput {
	agentId: string;
	roomId?: string;
	rootMessage: { id: string; text: string; sender?: string };
	// Optional run / scenario correlation for the lifeops aggregator. When set
	// (typically by the scenario CLI via env vars before each scenario), the
	// recorder includes them on the persisted trajectory so the aggregator can
	// group trajectories per scenario without inferring from filesystem layout.
	runId?: string;
	scenarioId?: string;
	// Correlation header (#13775). `traceId` is passed from the root turn
	// (message.ts); when absent the recorder falls back to env, then mints one.
	// The rest are inherited from a spawning parent's env when this recorder
	// runs inside a sub-agent.
	traceId?: string;
	taskId?: string;
	sessionId?: string;
	parentStepId?: string;
	/** Normalized trusted coding policy selected for this recorded turn. */
	codingActionProfile?: {
		kind: "pi";
		includeWorktree: boolean;
	};
}

export interface ListTrajectoriesOptions {
	agentId?: string;
	since?: number;
	limit?: number;
}

export interface TrajectoryRecorder {
	startTrajectory(input: StartTrajectoryInput): string;
	recordStage(trajectoryId: string, stage: RecordedStage): Promise<void>;
	endTrajectory(
		trajectoryId: string,
		status: "finished" | "errored",
	): Promise<void>;
	load(trajectoryId: string): Promise<RecordedTrajectory | null>;
	list(opts?: ListTrajectoriesOptions): Promise<RecordedTrajectory[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecorderLogger {
	warn?: (context: unknown, message?: string) => void;
	debug?: (context: unknown, message?: string) => void;
	error?: (context: unknown, message?: string) => void;
}

function envFlagEnabled(key: string, defaultValue = false): boolean {
	const raw = process.env[key];
	if (raw === undefined) return defaultValue;
	const normalized = raw.trim().toLowerCase();
	if (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return false;
	}
	return normalized.length > 0;
}

/**
 * Resolve the on-disk trajectory directory. Precedence per PLAN.md §18.1:
 *   ELIZA_TRAJECTORY_DIR
 *   ELIZA_STATE_DIR/trajectories
 *   XDG state-dir/trajectories
 */
/** Days to keep on-disk trajectory files; 0 disables the sweep. */
export function resolveTrajectoryRetentionDays(): number {
	const raw = process.env.ELIZA_TRAJECTORY_RETENTION_DAYS?.trim();
	if (raw === undefined || raw === "") return 14;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

/**
 * Remove trajectory files older than the retention window and orphaned
 * `.tmp` writes older than a day. Files grew ~50–65 MB/day with no retention
 * (3.5 GB, 23K files on the live VPS at 93% disk, audit 2026-09-13). Only
 * `tj-*.json` and `*.tmp` under `<dir>/<agentId>/` are touched.
 */
export async function sweepTrajectoryFiles(
	dir: string,
	options: { maxAgeMs: number; tmpMaxAgeMs?: number; now?: number },
): Promise<{ removed: number; tmpRemoved: number; scanned: number }> {
	const now = options.now ?? Date.now();
	const tmpMaxAgeMs = options.tmpMaxAgeMs ?? 24 * 60 * 60 * 1000;
	const result = { removed: 0, tmpRemoved: 0, scanned: 0 };
	let agentDirs: string[];
	try {
		agentDirs = await fs.readdir(dir);
	} catch {
		return result;
	}
	for (const agentDir of agentDirs) {
		const agentPath = path.join(dir, agentDir);
		let entries: string[];
		try {
			const stat = await fs.stat(agentPath);
			if (!stat.isDirectory()) continue;
			entries = await fs.readdir(agentPath);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const isTrajectory = entry.startsWith("tj-") && entry.endsWith(".json");
			const isTmp = entry.endsWith(".tmp");
			if (!isTrajectory && !isTmp) continue;
			result.scanned++;
			const filePath = path.join(agentPath, entry);
			try {
				const stat = await fs.stat(filePath);
				const ageMs = now - stat.mtimeMs;
				if (isTmp ? ageMs > tmpMaxAgeMs : ageMs > options.maxAgeMs) {
					await fs.unlink(filePath);
					if (isTmp) result.tmpRemoved++;
					else result.removed++;
				}
			} catch {
				// A file that vanished or cannot be read is not this sweep's problem.
			}
		}
	}
	return result;
}

export function resolveTrajectoryDir(): string {
	const explicit = process.env.ELIZA_TRAJECTORY_DIR?.trim();
	if (explicit) return explicit;

	const elizaState = resolveAliasedEnvValue("ELIZA_STATE_DIR")?.trim();
	if (elizaState) return path.join(elizaState, "trajectories");

	return path.join(resolveStateDir(), "trajectories");
}

/**
 * Whether the file recorder is enabled. Delegates to the single gate resolver
 * (trajectory-gate.ts) so the file recorder and the DB logger can no longer
 * disagree (#13775). Prod is now opt-in and test is off — the prior
 * always-on-unless-`=0` default is retired in favor of the SOC2 O-5 policy.
 */
export function isTrajectoryRecordingEnabled(): boolean {
	return resolveTrajectoryGate().enabled;
}

/**
 * Review mode writes a human-readable markdown sibling for every JSON
 * trajectory. It is opt-in so default runtime writes stay unchanged.
 */
export function isTrajectoryMarkdownReviewEnabled(): boolean {
	return (
		envFlagEnabled("ELIZA_TRAJECTORY_REVIEW_MODE") ||
		envFlagEnabled("ELIZA_TRAJECTORY_MARKDOWN") ||
		Boolean(process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim())
	);
}

function resolveTrajectoryMarkdownDir(rootDir: string): string {
	return process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim() || rootDir;
}

function safeRandomId(prefix: string): string {
	// Avoid pulling in node:crypto for hot-path id generation; the recorder
	// id space is small per agent.
	const rand = Math.random().toString(16).slice(2, 10);
	const ts = Date.now().toString(16).slice(-6);
	return `${prefix}-${ts}${rand}`;
}

function trajectoryFileName(id: string): string {
	return `${id}.json`;
}

function atomicTempPath(filePath: string): string {
	const rand = Math.random().toString(16).slice(2);
	return `${filePath}.${process.pid}.${Date.now().toString(36)}.${rand}.tmp`;
}

async function atomicWriteFile(
	filePath: string,
	value: string,
	logger?: RecorderLogger,
): Promise<void> {
	const dir = path.dirname(filePath);
	const tmp = atomicTempPath(filePath);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(tmp, value, "utf8");
		await fs.rename(tmp, filePath);
	} catch (error) {
		logger?.warn?.(
			{ err: (error as Error).message, filePath },
			"[TrajectoryRecorder] atomic write failed",
		);
		try {
			await fs.unlink(tmp);
		} catch (cleanupError) {
			// error-policy:J6 best-effort teardown retains the original write failure
			if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
				logger?.warn?.(
					{ err: (cleanupError as Error).message, tmp },
					"[TrajectoryRecorder] temporary file cleanup failed",
				);
			}
		}
		throw new ElizaError("Failed to persist trajectory artifact", {
			code: "TRAJECTORY_ATOMIC_WRITE_FAILED",
			cause: error,
			context: { filePath },
		});
	}
}

async function atomicWriteJson(
	filePath: string,
	value: unknown,
	logger?: RecorderLogger,
): Promise<void> {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new ElizaError("Trajectory artifact is not JSON-serializable", {
			code: "TRAJECTORY_ARTIFACT_INVALID",
			context: { filePath },
		});
	}
	await atomicWriteFile(filePath, serialized, logger);
}

function formatTimestamp(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "-";
	return new Date(ms).toISOString();
}

function formatDuration(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function safeStringifyForMarkdown(value: unknown): string {
	return stringifyForDiagnostics(value);
}

function redactMarkdownSecrets(text: string): string {
	if (!envFlagEnabled("ELIZA_TRAJECTORY_MARKDOWN_REDACT", true)) {
		return text;
	}
	const explicitSecrets = [
		process.env.CEREBRAS_API_KEY,
		process.env.OPENAI_API_KEY,
		process.env.ANTHROPIC_API_KEY,
		process.env.GROQ_API_KEY,
	].filter((value): value is string => Boolean(value?.trim()));
	let out = text;
	for (const secret of explicitSecrets) {
		out = out.split(secret).join("[REDACTED_SECRET]");
	}
	return out
		.replace(/\bcsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_CEREBRAS_KEY]")
		.replace(/\bsk-(?!test-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
		.replace(
			/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
			"Bearer [REDACTED_TOKEN]",
		);
}

function markdownFence(value: string, language = ""): string[] {
	const fence = value.includes("```") ? "````" : "```";
	return [language ? `${fence}${language}` : fence, value, fence];
}

function summarizeEmbeddingResponse(response: string): string | null {
	const trimmed = response.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (
			!Array.isArray(parsed) ||
			!parsed.every((value) => typeof value === "number")
		) {
			return null;
		}
		const preview = parsed
			.slice(0, 8)
			.map((value) => Number(value).toFixed(4))
			.join(", ");
		return `Embedding vector (${parsed.length} dimensions). Preview: [${preview}${parsed.length > 8 ? ", ..." : ""}]`;
	} catch {
		// error-policy:J7 malformed embedding previews must not break trajectory rendering
		return null;
	}
}

function modelResponseForMarkdown(model: RecordedModelCall): string {
	if (model.modelType === "TEXT_EMBEDDING") {
		const summary = summarizeEmbeddingResponse(model.response);
		if (summary) return summary;
	}
	return model.response;
}

function renderTrajectoryMarkdown(trajectory: RecordedTrajectory): string {
	const lines: string[] = [];
	const metrics = trajectory.metrics;
	lines.push(`# Trajectory ${trajectory.trajectoryId}`);
	lines.push("");
	lines.push(`- agent: \`${trajectory.agentId}\``);
	lines.push(`- room: \`${trajectory.roomId ?? "-"}\``);
	lines.push(`- status: ${trajectory.status}`);
	lines.push(`- started: ${formatTimestamp(trajectory.startedAt)}`);
	lines.push(`- ended: ${formatTimestamp(trajectory.endedAt)}`);
	lines.push(
		`- total: ${formatDuration(metrics.totalLatencyMs)} · $${metrics.totalCostUsd.toFixed(6)}`,
	);
	lines.push(
		`- tokens: ${metrics.totalPromptTokens} input · ${metrics.totalCompletionTokens} output · ${metrics.totalCacheReadTokens} cache-read · ${metrics.totalCacheCreationTokens} cache-created · ${metrics.totalReasoningTokens} reasoning`,
	);
	lines.push(`- root message id: \`${trajectory.rootMessage.id}\``);
	if (trajectory.rootMessage.text) {
		lines.push("");
		lines.push("## Root Message");
		lines.push("");
		lines.push(...markdownFence(trajectory.rootMessage.text));
	}
	lines.push("");

	for (const [index, stage] of trajectory.stages.entries()) {
		lines.push(
			`## Stage ${index + 1}: ${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""} (${stage.stageId})`,
		);
		lines.push("");
		lines.push(`- latency: ${formatDuration(stage.latencyMs)}`);
		lines.push(`- started: ${formatTimestamp(stage.startedAt)}`);
		lines.push(`- ended: ${formatTimestamp(stage.endedAt)}`);
		if (stage.parentStageId) {
			lines.push(`- parent: \`${stage.parentStageId}\``);
		}
		if (stage.model) {
			const providerLabel = stage.model.provider
				? ` (${stage.model.provider})`
				: "";
			lines.push(
				`- model: \`${stage.model.modelName ?? stage.model.modelType}\`${providerLabel}`,
			);
			if (stage.model.usage) {
				lines.push(
					`- usage: ${stage.model.usage.promptTokens ?? "n/a"} input · ${stage.model.usage.completionTokens ?? "n/a"} output · ${stage.model.usage.cacheReadInputTokens ?? "n/a"} cache-read · ${stage.model.usage.cacheCreationInputTokens ?? "n/a"} cache-created · ${stage.model.usage.reasoningTokens ?? "n/a"} reasoning`,
				);
			}
			if (typeof stage.model.costUsd === "number") {
				lines.push(`- cost: $${stage.model.costUsd.toFixed(6)}`);
			}
			if (typeof stage.model.prompt === "string") {
				const prompt = stage.model.prompt;
				lines.push("");
				lines.push("### Prompt");
				lines.push("");
				lines.push(...markdownFence(prompt));
			}
			lines.push("");
			lines.push("### Response");
			lines.push("");
			lines.push(...markdownFence(modelResponseForMarkdown(stage.model)));
			if (stage.model.messages !== undefined) {
				lines.push("");
				lines.push("### Messages");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.messages),
						"json",
					),
				);
			}
			if (stage.model.tools !== undefined) {
				lines.push("");
				lines.push("### Tools");
				lines.push("");
				lines.push(
					...markdownFence(safeStringifyForMarkdown(stage.model.tools), "json"),
				);
			}
			if (stage.model.toolCalls !== undefined) {
				lines.push("");
				lines.push("### Tool Calls");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.toolCalls),
						"json",
					),
				);
			}
			if (stage.model.providerOptions !== undefined) {
				lines.push("");
				lines.push("### Provider Options");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.providerOptions),
						"json",
					),
				);
			}
		}
		if (stage.tool) {
			lines.push("");
			lines.push("### Tool Result");
			lines.push("");
			lines.push(
				`- tool: \`${stage.tool.name}\` ${stage.tool.success ? "ok" : "failed"}`,
			);
			if (stage.tool.description) {
				lines.push(`- description: ${stage.tool.description}`);
			}
			lines.push(`- duration: ${formatDuration(stage.tool.durationMs)}`);
			lines.push(
				...markdownFence(
					safeStringifyForMarkdown({
						args: stage.tool.args,
						result: stage.tool.result,
					}),
					"json",
				),
			);
		}
		if (stage.evaluation) {
			lines.push("");
			lines.push("### Evaluation");
			lines.push("");
			lines.push(
				...markdownFence(safeStringifyForMarkdown(stage.evaluation), "json"),
			);
		}
		if (stage.cache) {
			lines.push("");
			lines.push("### Cache");
			lines.push("");
			lines.push(
				...markdownFence(safeStringifyForMarkdown(stage.cache), "json"),
			);
		}
		lines.push("");
	}

	return `${redactMarkdownSecrets(lines.join("\n")).trimEnd()}\n`;
}

function applyMetricsForStage(
	metrics: RecordedTrajectoryMetrics,
	stage: RecordedStage,
): void {
	metrics.totalLatencyMs += Number.isFinite(stage.latencyMs)
		? stage.latencyMs
		: 0;

	if (stage.model?.usage) {
		if (stage.model.usage.promptTokens !== undefined) {
			metrics.totalPromptTokens += stage.model.usage.promptTokens;
		}
		if (stage.model.usage.completionTokens !== undefined) {
			metrics.totalCompletionTokens += stage.model.usage.completionTokens;
		}
		metrics.totalCacheReadTokens += stage.model.usage.cacheReadInputTokens ?? 0;
		metrics.totalCacheCreationTokens +=
			stage.model.usage.cacheCreationInputTokens ?? 0;
		metrics.totalReasoningTokens =
			(metrics.totalReasoningTokens ?? 0) +
			(stage.model.usage.reasoningTokens ?? 0);
	}
	if (typeof stage.model?.costUsd === "number") {
		metrics.totalCostUsd += stage.model.costUsd;
	}

	if (stage.kind === "planner") metrics.plannerIterations += 1;
	if (stage.kind === "tool") {
		metrics.toolCallsExecuted += 1;
		if (stage.tool && !stage.tool.success) metrics.toolCallFailures += 1;
	}
	if (stage.kind === "toolSearch") metrics.toolSearchCount += 1;
	if (
		stage.kind === "evaluation" &&
		((typeof stage.evaluation?.parseError === "string" &&
			stage.evaluation.parseError.trim().length > 0) ||
			stage.evaluation?.protocolFailure === true)
	) {
		metrics.evaluatorFailures += 1;
	}

	const decision = stage.evaluation?.decision;
	if (decision === "FINISH") {
		metrics.finalDecision = "FINISH";
	} else if (decision) {
		// Track that we're still going. `endTrajectory` will overwrite on error.
		metrics.finalDecision = "CONTINUE";
	}
}

const RECORD_SANITIZE_MAX_DEPTH = 40;

function normalizeRecordString(value: string): string {
	return toWellFormedUnicode(value);
}

function sanitizeForRecord(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
): unknown {
	if (depth > RECORD_SANITIZE_MAX_DEPTH) {
		return "[MaxDepth]";
	}
	if (value === null) return null;
	if (typeof value === "string") return normalizeRecordString(value);
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "function") {
		const fnName = (value as { name?: string }).name;
		return `[Function ${typeof fnName === "string" && fnName.length > 0 ? fnName : "anonymous"}]`;
	}
	if (typeof value === "symbol") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (value instanceof RegExp) {
		return value.toString();
	}
	if (value instanceof ArrayBuffer) {
		return { type: "ArrayBuffer", byteLength: value.byteLength };
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: value.constructor.name || "ArrayBufferView",
			byteLength: value.byteLength,
		};
	}
	if (value instanceof Map) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: Record<string, unknown> = {};
		for (const [key, entry] of value.entries()) {
			const sanitized = sanitizeForRecord(entry, seen, depth + 1);
			if (sanitized !== undefined) {
				output[String(key)] = sanitized;
			}
		}
		seen.delete(value);
		return output;
	}
	if (value instanceof Set) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: unknown[] = [];
		for (const entry of value.values()) {
			output.push(sanitizeForRecord(entry, seen, depth + 1) ?? null);
		}
		seen.delete(value);
		return output;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: unknown[] = [];
		const length = value.length;
		for (let i = 0; i < length; i++) {
			output.push(sanitizeForRecord(value[i], seen, depth + 1) ?? null);
		}
		seen.delete(value);
		return output;
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			seen.delete(value);
			const prototype = Object.getPrototypeOf(value);
			if (prototype === Object.prototype || prototype === null) {
				// Plain empty objects must round-trip as {}, not "[object Object]".
				// Keep URL-like/custom empty-entry objects on the string fallback
				// path so useful toString() values are not erased.
				return {};
			}
			return String(value);
		}
		const output: Record<string, unknown> = {};
		for (const [key, entry] of entries) {
			const sanitized = sanitizeForRecord(entry, seen, depth + 1);
			if (sanitized !== undefined) {
				output[key] = sanitized;
			}
		}
		seen.delete(value);
		return output;
	}
	return String(value);
}

function cloneForRecord<T>(value: T): T {
	return sanitizeForRecord(value) as T;
}

function cloneRootMessageForRecord(
	rootMessage: StartTrajectoryInput["rootMessage"],
): RecordedTrajectory["rootMessage"] {
	return {
		id: String(rootMessage.id),
		text: normalizeRecordString(String(rootMessage.text)),
		sender:
			rootMessage.sender === undefined
				? undefined
				: normalizeRecordString(String(rootMessage.sender)),
	};
}

/**
 * Encode an arbitrary value to a JSON string for trajectory persistence.
 * Strings pass through unchanged; everything else is sanitized (handles
 * Error, Date, bigint, circular refs) and serialized.
 */
export function encodeTrajectoryFieldValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	const serialized = JSON.stringify(sanitizeForRecord(value));
	if (serialized === undefined) {
		throw new ElizaError("Trajectory field is not JSON-serializable", {
			code: "TRAJECTORY_FIELD_INVALID",
		});
	}
	return serialized;
}

export interface ToolStageIOInput {
	input?: unknown;
	output?: unknown;
	error?: unknown;
}

export interface ToolStageIOCapture {
	input?: string;
	output?: string;
	errorText?: string;
}

/**
 * Encode complete action input/output/error for a tool stage. The result is
 * suitable for assignment into a `RecordedToolStage`. Fields that are
 * `undefined` after encoding are omitted so the on-disk schema stays
 * minimal for steps that have nothing to capture.
 */
export function captureToolStageIO(args: ToolStageIOInput): ToolStageIOCapture {
	const out: ToolStageIOCapture = {};

	if (args.input !== undefined) {
		out.input = toWellFormedUnicode(encodeTrajectoryFieldValue(args.input));
	}
	if (args.output !== undefined) {
		out.output = toWellFormedUnicode(encodeTrajectoryFieldValue(args.output));
	}
	if (args.error !== undefined) {
		out.errorText = toWellFormedUnicode(encodeTrajectoryFieldValue(args.error));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Skill invocation I/O capture (W1-T5 / M13)
//
// Mirrors `captureToolStageIO` at the skill (USE_SKILL) seam.
// ---------------------------------------------------------------------------

export interface SkillInvocationIOInput {
	args?: unknown;
	result?: unknown;
}

export interface SkillInvocationIOCapture {
	args?: string;
	result?: string;
}

/**
 * Encode complete skill invocation args/result for a per-skill trajectory
 * record. Fields that are `undefined` after encoding are omitted so the
 * persisted shape stays minimal.
 */
export function captureSkillInvocationIO(
	input: SkillInvocationIOInput,
): SkillInvocationIOCapture {
	const out: SkillInvocationIOCapture = {};

	if (input.args !== undefined) {
		out.args = toWellFormedUnicode(encodeTrajectoryFieldValue(input.args));
	}
	if (input.result !== undefined) {
		out.result = toWellFormedUnicode(encodeTrajectoryFieldValue(input.result));
	}
	return out;
}

/**
 * Annotate a stage with `costUsd` and `priceTableId` if the model has
 * known pricing and the stage didn't already set it. The `model.modelName`
 * is the lookup key; `model.provider` is used to suppress the
 * missing-model warning for local-tier inference (Ollama, LM Studio,
 * llama.cpp).
 *
 * Recorder hooks call `computeCallCostUsd` themselves when they have the
 * data; this function is the fallback for callers that hand off raw
 * stages. Passing a logger lets the canonical pricing module emit a
 * structured warning when a hosted-provider model has no price entry.
 */
export function annotateStageCost(
	stage: RecordedStage,
	logger?: RecorderLogger,
): void {
	if (!stage.model) return;
	if (typeof stage.model.costUsd === "number") {
		// Caller already attached a cost — only tag the table id so consumers
		// know which snapshot it was computed against.
		if (!stage.model.priceTableId) {
			stage.model.priceTableId = PRICE_TABLE_ID;
		}
		return;
	}
	const cost = computeCallCostUsd(stage.model.modelName, stage.model.usage, {
		provider: stage.model.provider,
		logger,
	});
	if (cost !== undefined) {
		stage.model.costUsd = cost;
		stage.model.priceTableId = PRICE_TABLE_ID;
	}
}

/**
 * Final-persistence projection of tool-call diagnostics for one recorded
 * stage. Every recordStage caller (planner, sub-planner, evaluator, message
 * handler, and any future generic caller) is protected here rather than at
 * its own call site: tool arguments, tool result/error, captured tool I/O,
 * and model-stage tool-call arguments are projected through the composed
 * redaction before the stage reaches disk. Mutates the (already cloned) stage
 * in place. Model prompt/message text is projected as well; when message bytes
 * change, provider-attribution offsets are dropped through the canonical
 * fallback so they never index text different from the persisted messages.
 */
export function projectRecordedStageToolDiagnostics(
	stage: RecordedStage,
	redactText: ToolDiagnosticTextRedactor,
): void {
	if (stage.tool) {
		stage.tool.args =
			projectCompleteToolArgsForModel(stage.tool.args, redactText) ?? {};
		stage.tool.result = projectCompleteToolValueForModel(
			stage.tool.result,
			redactText,
		);
		if (typeof stage.tool.error === "string") {
			stage.tool.error = redactText(stage.tool.error);
		}
		if (stage.tool.input !== undefined) {
			stage.tool.input = redactText(stage.tool.input);
		}
		if (stage.tool.output !== undefined) {
			stage.tool.output = redactText(stage.tool.output);
		}
		if (stage.tool.errorText !== undefined) {
			stage.tool.errorText = redactText(stage.tool.errorText);
		}
	}
	if (stage.model) {
		const attributionInputBefore = canonicalPromptForModelCall({
			messages: stage.model.messages,
			prompt: stage.model.prompt,
		});
		if (stage.model.toolCalls?.length) {
			stage.model.toolCalls = stage.model.toolCalls.map((toolCall) => ({
				...toolCall,
				...(toolCall.args !== undefined
					? { args: projectCompleteToolArgsForModel(toolCall.args, redactText) }
					: {}),
			}));
		}
		// Prompt/messages/response carry rendered tool-call arguments and tool
		// output (assistant tool-call turns, tool-result turns, evaluator
		// trajectory renderings), so the persisted copies are projected too.
		// When the messages text changes, provider-attribution span offsets are
		// no longer provable against the persisted prompt — drop the offsets via
		// the canonical fallback and keep contribution identity.
		if (typeof stage.model.prompt === "string") {
			const projectedPrompt = redactText(stage.model.prompt);
			if (projectedPrompt !== stage.model.prompt) {
				stage.model.prompt = projectedPrompt;
			}
		}
		stage.model.response = redactText(stage.model.response);
		if (Array.isArray(stage.model.messages)) {
			const projectedMessages = projectCompleteToolValueForModel(
				stage.model.messages,
				redactText,
			) as RecordedModelCall["messages"];
			if (projectedMessages !== stage.model.messages) {
				stage.model.messages = projectedMessages;
			}
		}
		const attributionInputAfter = canonicalPromptForModelCall({
			messages: stage.model.messages,
			prompt: stage.model.prompt,
		});
		if (
			attributionInputAfter !== attributionInputBefore &&
			stage.model.providerAttributions?.length
		) {
			stage.model.providerAttributions = omitUnvalidatedProviderSpans(
				stage.model.providerAttributions,
			);
		}
	}
	if (stage.evaluation) {
		stage.evaluation = projectCompleteToolValueForModel(
			stage.evaluation,
			redactText,
		) as RecordedEvaluationStage;
	}
}

// ---------------------------------------------------------------------------
// JsonFileTrajectoryRecorder
// ---------------------------------------------------------------------------

export interface CreateJsonFileRecorderOptions {
	rootDir?: string;
	logger?: RecorderLogger;
	enabled?: boolean;
	reportError?: (
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	) => void;
	/**
	 * Runtime-known-secret redaction (e.g. `runtime.redactSecrets`) composed
	 * into the recorder's final-persistence diagnostic projection (see
	 * {@link projectRecordedStageToolDiagnostics}). The shared tool-shape
	 * pattern pass always runs regardless — the option only ADDS
	 * character-configured secret masking, so a recorder constructed without a
	 * runtime still never persists raw credential-shaped argument values.
	 */
	redactSecrets?: (text: string) => string;
}

interface MutableTrajectory extends RecordedTrajectory {}

class JsonFileTrajectoryRecorder implements TrajectoryRecorder {
	private readonly rootDir: string;
	private readonly markdownDir: string;
	private readonly logger?: RecorderLogger;
	private readonly reportError?: CreateJsonFileRecorderOptions["reportError"];
	private readonly enabled: boolean;
	private readonly markdownEnabled: boolean;
	private readonly redactText: ToolDiagnosticTextRedactor;
	private readonly active = new Map<string, MutableTrajectory>();
	private readonly flushQueues = new Map<string, Promise<void>>();

	constructor(opts: CreateJsonFileRecorderOptions = {}) {
		this.rootDir = opts.rootDir ?? resolveTrajectoryDir();
		this.markdownDir = resolveTrajectoryMarkdownDir(this.rootDir);
		this.logger = opts.logger;
		this.reportError = opts.reportError;
		this.redactText = composeToolDiagnosticRedactor({
			redactSecrets: opts.redactSecrets,
		});
		this.enabled =
			opts.enabled !== undefined
				? opts.enabled
				: isTrajectoryRecordingEnabled();
		this.markdownEnabled = this.enabled && isTrajectoryMarkdownReviewEnabled();
	}

	startTrajectory(input: StartTrajectoryInput): string {
		const id = safeRandomId("tj");
		if (!this.enabled) {
			return id;
		}

		// Correlation resolution mirrors the existing runId/scenarioId env
		// fallback: explicit input wins, else the env the spawner set, else — for
		// traceId specifically — mint one so every trajectory is joinable even
		// when no parent stamped a trace.
		const inheritedCorrelation = resolveTraceCorrelationFromEnv();
		const correlation: TraceCorrelation = {
			traceId:
				input.traceId ?? inheritedCorrelation.traceId ?? crypto.randomUUID(),
			taskId: input.taskId ?? inheritedCorrelation.taskId,
			sessionId: input.sessionId ?? inheritedCorrelation.sessionId,
			parentStepId: input.parentStepId ?? inheritedCorrelation.parentStepId,
		};

		const trajectory: MutableTrajectory = {
			trajectoryId: id,
			agentId: input.agentId,
			roomId: input.roomId,
			// The scenario CLI stamps these before each run/scenario (cli.ts); an
			// explicit call-site value wins. readEnv treats blank/whitespace as
			// unset so a cleared env var never writes an empty correlation key.
			runId: input.runId ?? readEnv("ELIZA_LIFEOPS_RUN_ID"),
			scenarioId: input.scenarioId ?? readEnv("ELIZA_LIFEOPS_SCENARIO_ID"),
			traceId: correlation.traceId,
			taskId: correlation.taskId,
			sessionId: correlation.sessionId,
			parentStepId: correlation.parentStepId,
			codingActionProfile: input.codingActionProfile,
			rootMessage: cloneRootMessageForRecord(input.rootMessage),
			startedAt: Date.now(),
			status: "running",
			stages: [],
			metrics: {
				totalLatencyMs: 0,
				totalPromptTokens: 0,
				totalCompletionTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalReasoningTokens: 0,
				totalCostUsd: 0,
				plannerIterations: 0,
				toolCallsExecuted: 0,
				toolCallFailures: 0,
				toolSearchCount: 0,
				evaluatorFailures: 0,
			},
		};
		this.active.set(id, trajectory);

		// The initial flush is diagnostic and detached from message delivery.
		void this.queueFlushTrajectory(trajectory).catch((err) => {
			// error-policy:J7 Report a missing initial trajectory artifact without
			// aborting the message path that started it.
			this.reportError?.("TrajectoryRecorder.initialFlush", err, {
				trajectoryId: id,
			});
			this.logger?.warn?.(
				{ err: (err as Error).message, trajectoryId: id },
				"[TrajectoryRecorder] initial flush failed",
			);
		});
		return id;
	}

	async recordStage(trajectoryId: string, stage: RecordedStage): Promise<void> {
		if (!this.enabled) return;
		const trajectory = this.active.get(trajectoryId);
		if (!trajectory) {
			this.logger?.warn?.(
				{ trajectoryId },
				"[TrajectoryRecorder] recordStage: trajectory not found (was startTrajectory called?)",
			);
			return;
		}

		const recordedStage = cloneForRecord(stage);
		projectRecordedStageToolDiagnostics(recordedStage, this.redactText);
		annotateStageCost(recordedStage, this.logger);
		trajectory.stages.push(recordedStage);
		applyMetricsForStage(trajectory.metrics, recordedStage);

		await this.queueFlushTrajectory(trajectory);
	}

	async endTrajectory(
		trajectoryId: string,
		status: "finished" | "errored",
	): Promise<void> {
		if (!this.enabled) return;
		const trajectory = this.active.get(trajectoryId);
		if (!trajectory) {
			this.logger?.warn?.(
				{ trajectoryId },
				"[TrajectoryRecorder] endTrajectory: trajectory not found",
			);
			return;
		}

		trajectory.status = status;
		trajectory.endedAt = Date.now();
		if (status === "errored" && !trajectory.metrics.finalDecision) {
			trajectory.metrics.finalDecision = "error";
		}
		// Non-evaluated terminal paths (Stage-1 direct reply, deterministic
		// fallback, structured failure reply) finish a turn without any
		// evaluation stage, so nothing above ever set finalDecision. Stamp the
		// clean terminal here — an absent finalDecision on a finished
		// trajectory reads as "died mid-turn" and made delivered turns look
		// like drops. The value must be a member of the canonical validator's
		// closed vocabulary (packages/scripts/lib/trajectory-validate.ts) —
		// every recorded trajectory round-trips through it, and an invented
		// sentinel is rejected as an invalid finalDecision. "FINISH" is the
		// accepted shape for a cleanly finished run; whether an evaluator
		// produced it remains distinguishable from the trajectory itself (an
		// evaluator-decided FINISH always has an evaluation stage).
		if (status === "finished" && !trajectory.metrics.finalDecision) {
			trajectory.metrics.finalDecision = "FINISH";
		}

		try {
			await this.queueFlushTrajectory(trajectory);
		} finally {
			// Always retire the trajectory, even when the terminal flush fails —
			// otherwise a failed write leaves the entry in `active` forever and
			// late recordStage calls keep resurrecting a half-dead record.
			this.active.delete(trajectoryId);
			this.flushQueues.delete(trajectoryId);
		}
	}

	async load(trajectoryId: string): Promise<RecordedTrajectory | null> {
		const inMem = this.active.get(trajectoryId);
		if (inMem) return inMem;

		const files = await this.collectAllFiles();
		const match = files.find((f) => f.id === trajectoryId);
		if (!match) return null;
		try {
			const raw = await fs.readFile(match.filePath, "utf8");
			return JSON.parse(raw) as RecordedTrajectory;
		} catch (error) {
			// error-policy:J2 preserve the storage failure while identifying the trajectory
			throw new ElizaError("Failed to load recorded trajectory", {
				code: "TRAJECTORY_LOAD_FAILED",
				cause: error,
				context: { trajectoryId, filePath: match.filePath },
			});
		}
	}

	async list(
		opts: ListTrajectoriesOptions = {},
	): Promise<RecordedTrajectory[]> {
		const files = await this.collectAllFiles();
		const out: RecordedTrajectory[] = [];
		for (const file of files) {
			try {
				const raw = await fs.readFile(file.filePath, "utf8");
				const trajectory = JSON.parse(raw) as RecordedTrajectory;
				if (opts.agentId && trajectory.agentId !== opts.agentId) continue;
				if (opts.since && trajectory.startedAt < opts.since) continue;
				out.push(trajectory);
			} catch (error) {
				// error-policy:J2 identify the corrupt artifact instead of hiding it from list results
				throw new ElizaError("Failed to read recorded trajectory", {
					code: "TRAJECTORY_LIST_ENTRY_FAILED",
					cause: error,
					context: { trajectoryId: file.id, filePath: file.filePath },
				});
			}
		}
		out.sort((a, b) => b.startedAt - a.startedAt);
		if (opts.limit != null && out.length > opts.limit) {
			return out.slice(0, opts.limit);
		}
		return out;
	}

	private queueFlushTrajectory(trajectory: MutableTrajectory): Promise<void> {
		const trajectoryId = trajectory.trajectoryId;
		const snapshot = cloneForRecord(trajectory);
		const previous = this.flushQueues.get(trajectoryId) ?? Promise.resolve();
		// error-policy:J5 rejection-suppression — a prior flush's failure (already
		// surfaced inside flushSnapshot) must not chain-block this snapshot's flush.
		const next = previous
			.catch(() => undefined)
			.then(() => this.flushSnapshot(snapshot));
		this.flushQueues.set(trajectoryId, next);
		// error-policy:J5 rejection-suppression — the returned `next` is observed by
		// the caller; this branch only cleans up the queue map without re-surfacing.
		void next
			.finally(() => {
				if (this.flushQueues.get(trajectoryId) === next) {
					this.flushQueues.delete(trajectoryId);
				}
			})
			.catch(() => undefined);
		return next;
	}

	private async flushSnapshot(snapshot: RecordedTrajectory): Promise<void> {
		const filePath = path.join(
			this.rootDir,
			snapshot.agentId,
			trajectoryFileName(snapshot.trajectoryId),
		);
		await atomicWriteJson(filePath, snapshot, this.logger);
		if (!this.markdownEnabled) return;
		const markdownPath = path.join(
			this.markdownDir,
			snapshot.agentId,
			`${snapshot.trajectoryId}.md`,
		);
		await atomicWriteFile(
			markdownPath,
			renderTrajectoryMarkdown(snapshot),
			this.logger,
		);
	}

	private async collectAllFiles(): Promise<
		Array<{ id: string; filePath: string }>
	> {
		const out: Array<{ id: string; filePath: string }> = [];
		const stack: string[] = [this.rootDir];
		try {
			await fs.access(this.rootDir);
		} catch (error) {
			// error-policy:J4 a recorder with no storage directory has no trajectories yet
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
			throw error;
		}

		while (stack.length > 0) {
			const dir = stack.pop();
			if (!dir) continue;
			let entries: import("node:fs").Dirent[];
			try {
				entries = (await fs.readdir(dir, {
					withFileTypes: true,
				})) as import("node:fs").Dirent[];
			} catch (error) {
				// error-policy:J2 preserve directory traversal failures with their path
				throw new ElizaError("Failed to scan trajectory storage", {
					code: "TRAJECTORY_DIRECTORY_READ_FAILED",
					cause: error,
					context: { directory: dir },
				});
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
					continue;
				}
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				out.push({
					id: entry.name.replace(/\.json$/, ""),
					filePath: full,
				});
			}
		}

		return out;
	}
}

/**
 * Construct a JSON-file backed `TrajectoryRecorder`. The default rootDir is
 * resolved from `ELIZA_TRAJECTORY_DIR` → `ELIZA_STATE_DIR/trajectories` →
 * `resolveStateDir()/trajectories`.
 *
 * Pass `enabled: false` to short-circuit every method (test fixtures, opt-out
 * at construction time).
 */
export function createJsonFileTrajectoryRecorder(
	opts: CreateJsonFileRecorderOptions = {},
): TrajectoryRecorder {
	return new JsonFileTrajectoryRecorder(opts);
}

// ---------------------------------------------------------------------------
// Trajectory finalization guard
// ---------------------------------------------------------------------------

export interface FinalizeTrajectoryRecordingOptions {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	status: "finished" | "errored";
	logger?: RecorderLogger;
	reportError?: (
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	) => void;
}

/**
 * Lifecycle guard: every started trajectory must reach a terminal status.
 *
 * Writes the terminal status without depending on optional background work.
 * Callers record already-settled stages before entering this boundary; a
 * diagnostic task may never keep a completed turn visibly `running`.
 */
export async function finalizeTrajectoryRecording(
	opts: FinalizeTrajectoryRecordingOptions,
): Promise<void> {
	try {
		await opts.recorder.endTrajectory(opts.trajectoryId, opts.status);
	} catch (err) {
		// error-policy:J7 Finalization is diagnostic and cannot replace the turn;
		// it must still surface the trajectory left unterminated.
		opts.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: opts.trajectoryId },
			"[TrajectoryRecorder] endTrajectory failed",
		);
		opts.reportError?.("TrajectoryRecorder.finalize", err, {
			trajectoryId: opts.trajectoryId,
			status: opts.status,
		});
	}
}

// ---------------------------------------------------------------------------
// Disabled recorder (used when recording is disabled or no recorder was passed
// into a sub-runtime call). This lets every hook be unconditional.
// ---------------------------------------------------------------------------

const NOOP_RECORDER: TrajectoryRecorder = {
	startTrajectory: () => safeRandomId("tj-noop"),
	recordStage: async () => undefined,
	endTrajectory: async () => undefined,
	load: async () => null,
	list: async () => [],
};

/**
 * Get a disabled recorder. Useful when wiring a runtime path that may or may
 * not have a recorder attached.
 */
export function getNoopTrajectoryRecorder(): TrajectoryRecorder {
	return NOOP_RECORDER;
}
