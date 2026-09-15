/**
 * Renders completed planner trajectory steps into native assistant/tool chat
 * message pairs and serializes complete tool results for the next planner
 * call, shaping everything append-only so the prompt prefix stays byte-stable
 * for provider prompt caching. Also re-exports the provider cache-plan helpers.
 */

import {
	composeToolDiagnosticRedactor,
	projectCompleteToolArgsForModel,
	projectCompleteToolValueForModel,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import type { ActionResult } from "../types/components";
import { isReadView } from "../types/content";
import type { ChatMessage, ChatMessageContentPart } from "../types/model";
import type { JsonValue } from "../types/primitives.ts";
import { getActionResultActionName } from "../utils/action-results";
import { stringifyForModel } from "./json-output";
import type { PlannerStep, PlannerToolResult } from "./planner-types";
import {
	buildProviderCachePlan,
	type CacheableSection,
	type ProviderCachePlan,
	type ProviderCachePlanArgs,
} from "./provider-cache-plan";

/**
 * Options for {@link trajectoryStepsToMessages}.
 */
export interface TrajectoryStepsToMessagesOptions {
	/**
	 * Runtime-aware diagnostic redactor for model-bound tool history. When
	 * omitted, the shared credential-shape pass still runs.
	 */
	redactText?: ToolDiagnosticTextRedactor;
	/** Receives count-only diagnostics; model-facing text is always complete. */
	onProjectionStats?: (stats: ToolResultProjectionStats) => void;
}

export interface ToolResultProjectionStats {
	resultCount: number;
	pagesIncluded: number;
	pagesOmitted: number;
	omissionReasons: Record<string, number>;
}

export interface RenderedActionResultsForModel {
	text: string;
	stats: ToolResultProjectionStats;
}

/**
 * Render legacy ActionResults through the same complete data and supplemental
 * promptData representation used by native tool messages. This is the
 * migration bridge for prompt builders that cannot yet carry structured tool
 * messages; non-model display code should keep using its display formatter.
 */
export function renderActionResultsForModel(
	results: readonly ActionResult[],
	options: {
		header?: string;
		redactText?: ToolDiagnosticTextRedactor;
	} = {},
): RenderedActionResultsForModel {
	if (results.length === 0) {
		return {
			text: "No action results available.",
			stats: {
				resultCount: 0,
				pagesIncluded: 0,
				pagesOmitted: 0,
				omissionReasons: {},
			},
		};
	}
	let pagesIncluded = 0;
	const redactText = options.redactText ?? composeToolDiagnosticRedactor();
	const rendered = results.map((result, index) => {
		const safeResult = projectCompleteToolValueForModel(
			result,
			redactText,
		) as PlannerToolResult;
		if (
			hasRecoverableContentLocator(safeResult.promptData) ||
			hasRecoverableContentLocator(safeResult.data)
		) {
			pagesIncluded++;
		}
		const body = toolMessageContent(safeResult);
		const status = result.success === false ? "failed" : "succeeded";
		return `${index + 1}. ${getActionResultActionName(result)} - ${status}\n${JSON.stringify(JSON.parse(body))}`;
	});
	return {
		text: [options.header ?? "# Current Chain Action Results", ...rendered]
			.filter(Boolean)
			.join("\n\n"),
		stats: {
			resultCount: results.length,
			pagesIncluded,
			pagesOmitted: 0,
			omissionReasons: {},
		},
	};
}

/**
 * Convert completed trajectory steps into proper assistant/tool message pairs
 * for native tool-calling. Skips steps that lack a toolCall or result (e.g.
 * terminal-only steps). The resulting array grows append-only across planner
 * iterations, which keeps the prefix byte-identical for cache hits.
 *
 * Emits AI SDK v6's `AssistantModelMessage` / `ToolModelMessage` shape — tool
 * calls live inside `content` as `ToolCallPart`, tool results inside `content`
 * as `ToolResultPart`. The legacy OpenAI v0.x shape (`assistant` with a
 * top-level `toolCalls` array + `tool` with `toolCallId`/`name` siblings) is
 * silently ignored by AI SDK v6's message conversion: `AssistantContent` only
 * understands `string | Array<TextPart | FilePart | ReasoningPart |
 * ToolCallPart | ToolResultPart | ToolApprovalRequest>` and has no top-level
 * `toolCalls` field. Emitting the legacy shape leaves the evaluator's
 * downstream model call with no view of the tool history, so the LLM keeps
 * routing CONTINUE under the belief that no tool has been executed yet — the
 * planner-loop then iterates until `TrajectoryLimitExceeded` on every
 * shell-tool turn.
 */
export function trajectoryStepsToMessages(
	steps: PlannerStep[],
	options: TrajectoryStepsToMessagesOptions = {},
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const redactText = options.redactText ?? composeToolDiagnosticRedactor();
	const resultCount = steps.filter(
		(step) => step.toolCall && step.result,
	).length;
	let pagesIncluded = 0;
	for (const step of steps) {
		if (!step.toolCall || !step.result) {
			continue;
		}
		const safeArgs =
			projectCompleteToolArgsForModel(step.toolCall.params ?? {}, redactText) ??
			{};
		const toolCallId = stableToolCallId(step, safeArgs);

		const assistantContent: ChatMessageContentPart[] = [];
		const thought = redactText(step.thought ?? "");
		if (thought) {
			assistantContent.push({ type: "text", text: thought });
		}
		assistantContent.push({
			type: "tool-call",
			toolCallId,
			toolName: step.toolCall.name,
			input: safeArgs,
		});
		messages.push({
			role: "assistant",
			content: assistantContent,
		});

		const safeResult = projectCompleteToolValueForModel(
			step.result,
			redactText,
		) as PlannerToolResult;
		if (
			hasRecoverableContentLocator(safeResult.promptData) ||
			hasRecoverableContentLocator(safeResult.data)
		) {
			pagesIncluded++;
		}
		const rawResultText = toolMessageContent(safeResult);
		messages.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId,
					toolName: step.toolCall.name,
					output: { type: "text", value: rawResultText },
				},
			],
		});
	}
	options.onProjectionStats?.({
		resultCount,
		pagesIncluded,
		pagesOmitted: 0,
		omissionReasons: {},
	});
	return messages;
}

/**
 * Stable tool-call id for an assistant turn. Prefer the model-supplied id;
 * fall back to a deterministic `tc-<iter>-<name>-<argsDigest>` so two tool
 * calls in the same iteration with different args don't collide and so
 * re-rendering the trajectory produces byte-identical assistant turns.
 */
function stableToolCallId(
	step: PlannerStep,
	projectedParams: Record<string, unknown>,
): string {
	if (step.toolCall?.id) {
		return step.toolCall.id;
	}
	const name = step.toolCall?.name ?? "unknown";
	const argsDigest = shortArgsDigest(projectedParams);
	return `tc-${step.iteration}-${name}-${argsDigest}`;
}

function shortArgsDigest(params: Record<string, unknown> | undefined): string {
	if (!params) return "0";
	const json = stringifyForModel(params);
	let hash = 0;
	for (let i = 0; i < json.length; i++) {
		hash = (hash * 31 + json.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

/** Serialize one validated complete tool result. */
export function toolMessageContent(result: PlannerToolResult): string {
	return stringifyForModel(projectToolResultForModel(result));
}

function hasRecoverableContentLocator(value: unknown): boolean {
	const pending: unknown[] = [value];
	const visited = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		if (isReadView(current)) {
			return true;
		}
		if (current === null || typeof current !== "object") {
			continue;
		}
		if (visited.has(current)) continue;
		visited.add(current);
		let children: unknown[];
		if (Array.isArray(current)) {
			children = current;
		} else {
			children = [];
			for (const [key, child] of Object.entries(
				current as Record<string, unknown>,
			)) {
				if (key === "readView") {
					if (isReadView(child)) return true;
					continue;
				}
				children.push(child);
			}
		}
		for (const child of children) {
			pending.push(child);
		}
	}
	return false;
}

/**
 * Produce the sole model-bound shape for a tool result. `promptData` is
 * supplemental by default. Only an explicit producer-declared replace-data
 * contract substitutes it for runtime data. Never infer a projection from size
 * or field names; text, receipts, failures and the original result stay intact.
 */
export function projectToolResultForModel(
	result: PlannerToolResult,
): PlannerToolResult {
	if (result.promptDataMode === "replace-data" && result.promptData) {
		const { data: _data, promptData, promptDataMode: _mode, ...rest } = result;
		return { ...rest, data: promptData };
	}
	return { ...result };
}

export function cacheProviderOptions(
	args: ProviderCachePlanArgs,
): Record<string, JsonValue | object | undefined> {
	return buildProviderCachePlan(args).providerOptions;
}

export type { CacheableSection, ProviderCachePlan };
