/** Records complete message-handler and post-turn facts stages with provider attribution and usage metadata. */

import type { FactsAndRelationshipsRunResult } from "../../runtime/facts-and-relationships";
import {
	buildProviderAttributionsFromState,
	flattenTrajectoryMessages,
} from "../../runtime/trajectory-provider-attribution";
import type { TrajectoryRecorder } from "../../runtime/trajectory-recorder";
import type { MessageHandlerResult } from "../../types/components";
import type {
	ChatMessage,
	GenerateTextResult,
	ToolDefinition,
} from "../../types/model";
import { ModelType } from "../../types/model";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { getStage1FinishReason } from "./stage1-completion.js";
import { parseToolArguments } from "./tool-arguments.js";

export async function recordMessageHandlerStage(args: {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	messages?: ChatMessage[];
	tools?: ToolDefinition[];
	toolChoice?: unknown;
	providerOptions?: Record<string, unknown>;
	raw: string | GenerateTextResult;
	parsed?: MessageHandlerResult;
	startedAt: number;
	endedAt: number;
	segmentHashes?: string[];
	prefixHash?: string;
	/**
	 * The provider that actually served the Stage-1 call (resolved from the
	 * runtime after the call completed). Threaded so the recorded stage names
	 * the real provider instead of the fabricated `"default"` literal (#13623).
	 */
	provider?: string;
	state?: State;
	runtime: IAgentRuntime;
}): Promise<void> {
	try {
		const responseText = getMessageHandlerResponseText(args.raw, args.parsed);
		const usage =
			typeof args.raw === "string"
				? undefined
				: extractMessageHandlerUsage(args.raw);
		const modelName = extractMessageHandlerModelName(args.raw);
		// Flatten `messages` only to locate provider spans; the flattened form is
		// not persisted — `messages` is the canonical record and spans index into
		// `flattenTrajectoryMessages(messages)` reconstructed at read time.
		const providerAttribution = buildProviderAttributionsFromState({
			state: args.state,
			prompt: flattenTrajectoryMessages(args.messages),
		});
		await args.recorder.recordStage(args.trajectoryId, {
			stageId: `stage-msghandler-${args.startedAt}`,
			kind: "messageHandler",
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: String(ModelType.RESPONSE_HANDLER),
				modelName,
				provider: resolveRecordedStageProvider(args.raw, args.provider),
				messages: args.messages,
				tools: args.tools,
				toolChoice: args.toolChoice,
				providerOptions: args.providerOptions,
				response: responseText,
				toolCalls: extractMessageHandlerToolCalls(args.raw),
				usage,
				finishReason: getStage1FinishReason(args.raw) || undefined,
				providerOrder: providerAttribution.providerOrder,
				providerAttributions: providerAttribution.providerAttributions,
			},
			cache: args.prefixHash
				? {
						segmentHashes: args.segmentHashes ?? [],
						prefixHash: args.prefixHash,
					}
				: undefined,
		});
	} catch (err) {
		// error-policy:J7 Trajectory persistence is diagnostic and must surface
		// without changing the user-visible turn.
		args.runtime.logger.warn(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record messageHandler stage",
		);
		args.runtime.reportError("MessageService.recordMessageHandlerStage", err, {
			trajectoryId: args.trajectoryId,
		});
	}
}

export async function recordFactsAndRelationshipsStage(args: {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	outcome: {
		startedAt: number;
		endedAt: number;
		result: FactsAndRelationshipsRunResult | null;
		error?: unknown;
	};
	runtime: IAgentRuntime;
}): Promise<void> {
	try {
		const { startedAt, endedAt, result, error } = args.outcome;
		// The provider is carried WITH the facts call result (captured
		// synchronously at call time) so a parallel/subsequent TEXT_LARGE call
		// can't have overwritten it before this stage is recorded (#13623).
		const factsProvider = result?.provider;
		const candidates = extractCandidatesForRecording(result);
		const kept = result?.parsed
			? {
					// The trajectory contract records facts as strings; the speaker
					// attribution is rendered inline so replays can audit it.
					facts: result.parsed.facts.map((fact) =>
						fact.subject && fact.subject !== "user"
							? `[${fact.subject}] ${fact.fact}`
							: fact.fact,
					),
					relationships: result.parsed.relationships,
				}
			: { facts: [], relationships: [] };
		const written = result?.written ?? { facts: 0, relationships: 0 };
		const thought = error
			? `error: ${error instanceof Error ? error.message : String(error)}`
			: (result?.parsed.thought ?? "");
		await args.recorder.recordStage(args.trajectoryId, {
			stageId: `stage-facts-${startedAt}`,
			kind: "factsAndRelationships",
			startedAt,
			endedAt,
			latencyMs: endedAt - startedAt,
			model: result?.rawResponse
				? {
						modelType: String(ModelType.TEXT_LARGE),
						provider: resolveRecordedStageProvider(
							result.rawResponse,
							factsProvider,
						),
						messages: result.messages,
						tools: result.tools,
						toolChoice: "required",
						response:
							typeof result.rawResponse === "string"
								? result.rawResponse
								: JSON.stringify(result.rawResponse),
					}
				: undefined,
			factsAndRelationships: {
				candidates,
				kept,
				written,
				thought,
				...(result?.skipReason
					? { llmCallSkipped: true, reason: result.skipReason }
					: {}),
			},
		});
	} catch (err) {
		// error-policy:J7 Trajectory persistence is diagnostic and must surface
		// without changing the user-visible turn.
		args.runtime.logger.warn(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record factsAndRelationships stage",
		);
		args.runtime.reportError(
			"MessageService.recordFactsAndRelationshipsStage",
			err,
			{ trajectoryId: args.trajectoryId },
		);
	}
}

export function extractCandidatesForRecording(
	result: FactsAndRelationshipsRunResult | null,
): {
	facts: string[];
	relationships: Array<{ subject: string; predicate: string; object: string }>;
} {
	const userMessage = result?.messages?.find(
		(message) => message.role === "user",
	);
	const userContent =
		typeof userMessage?.content === "string" ? userMessage.content : "";
	const facts: string[] = [];
	const relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}> = [];
	if (!userContent) {
		return { facts, relationships };
	}
	const candidatesBlock = userContent.split("candidates:")[1] ?? "";
	for (const line of candidatesBlock.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("-")) continue;
		const body = trimmed.replace(/^-\s*/, "");
		if (body.startsWith("fact:")) {
			facts.push(body.slice("fact:".length).trim());
		} else if (body.startsWith("relationship:")) {
			const triple = body.slice("relationship:".length).trim().split(/\s+/);
			if (triple.length >= 3) {
				relationships.push({
					subject: triple[0],
					predicate: triple[1],
					object: triple.slice(2).join(" "),
				});
			}
		}
	}
	return { facts, relationships };
}

/**
 * Read the provider name a model result attributes itself to, if the provider
 * adapter surfaced one in `providerMetadata` (e.g. `{ provider }` or
 * `{ providerName }`). Returns undefined when the result is a bare string or
 * carries no self-reported provider — never a fabricated value.
 */
export function extractStageResultProvider(
	raw: string | GenerateTextResult | unknown,
): string | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const meta = (raw as { providerMetadata?: unknown }).providerMetadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		return undefined;
	const record = meta as Record<string, unknown>;
	for (const key of ["provider", "providerName"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Resolve the provider name to record on a trajectory model stage. Prefers a
 * provider the result self-reports, then the runtime-resolved provider that
 * actually served the call, and only falls back to the `"default"` sentinel
 * when neither is known. Before #13623 these stages hardcoded `"default"`,
 * making the trajectory useless as a live-vs-proxy provenance signal.
 */
export function resolveRecordedStageProvider(
	raw: string | GenerateTextResult | unknown,
	runtimeResolvedProvider?: string,
): string {
	const selfReported = extractStageResultProvider(raw);
	if (selfReported) return selfReported;
	if (
		typeof runtimeResolvedProvider === "string" &&
		runtimeResolvedProvider.trim().length > 0
	) {
		return runtimeResolvedProvider.trim();
	}
	return "default";
}

export function extractMessageHandlerModelName(
	raw: string | GenerateTextResult,
): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) {
		const direct = (meta as Record<string, unknown>).modelName;
		if (typeof direct === "string") return direct;
		const model = (meta as Record<string, unknown>).model;
		if (typeof model === "string") return model;
	}
	return undefined;
}

export function getMessageHandlerResponseText(
	raw: string | GenerateTextResult,
	parsed?: MessageHandlerResult,
): string {
	if (typeof raw === "string") {
		return raw;
	}
	if (typeof raw.text === "string" && raw.text.trim().length > 0) {
		return raw.text;
	}
	const responseText = raw.response;
	if (typeof responseText === "string" && responseText.trim().length > 0) {
		return responseText;
	}
	return parsed ? JSON.stringify(parsed) : "";
}

export function extractMessageHandlerToolCalls(
	raw: string | GenerateTextResult,
): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
	if (typeof raw === "string" || !Array.isArray(raw.toolCalls)) {
		return [];
	}
	const toolCalls: Array<{
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	}> = [];
	for (const entry of raw.toolCalls) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		const args = parseToolArguments(
			entry.arguments ?? entry.args ?? entry.input ?? entry.params,
		);
		toolCalls.push({
			id:
				typeof entry.id === "string"
					? entry.id
					: typeof entry.toolCallId === "string"
						? entry.toolCallId
						: undefined,
			name: name || undefined,
			args: args ?? undefined,
		});
	}
	return toolCalls;
}

export function extractMessageHandlerUsage(raw: GenerateTextResult):
	| {
			promptTokens: number;
			completionTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			reasoningTokens?: number;
			totalTokens: number;
	  }
	| undefined {
	const usage = raw.usage;
	if (!usage) return undefined;
	const promptTokens = usage.promptTokens;
	const completionTokens = usage.completionTokens;
	const totalTokens = usage.totalTokens;
	const out: {
		promptTokens: number;
		completionTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
		totalTokens: number;
	} = { promptTokens, completionTokens, totalTokens };
	if (typeof usage.cacheReadInputTokens === "number") {
		out.cacheReadInputTokens = usage.cacheReadInputTokens;
	} else {
		const cachedPromptTokens =
			"cachedPromptTokens" in usage ? usage.cachedPromptTokens : undefined;
		if (typeof cachedPromptTokens === "number") {
			out.cacheReadInputTokens = cachedPromptTokens;
		}
	}
	if (typeof usage.cacheCreationInputTokens === "number") {
		out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
	}
	if (typeof usage.reasoningTokens === "number") {
		out.reasoningTokens = usage.reasoningTokens;
	}
	return out;
}

/**
 * True when a plugin registered at least one core text delegate (chat / planning).
 * Embeddings-only (local-ai) and TTS do not count — without a matching delegate,
 * `dynamicPromptExecFromState` can fail with "No handler found for delegate type".
 */
export function hasTextGenerationHandler(runtime: IAgentRuntime): boolean {
	const keys: Array<keyof typeof ModelType | string> = [
		ModelType.TEXT_LARGE,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_NANO,
		ModelType.TEXT_MEGA,
		ModelType.ACTION_PLANNER,
		ModelType.RESPONSE_HANDLER,
	];
	for (const k of keys) {
		if (runtime.getModel(String(k))) return true;
	}
	return false;
}
