/**
 * `EvaluatorService`: the runtime singleton that runs every registered post-turn
 * evaluator in a single merged, schema-constrained SMALL-model call, then routes
 * each evaluator's slice of the output through its processors. Exposes the
 * `runPostTurnEvaluators` helper the message loop invokes after a turn (skipped on
 * mobile, where reflection would serialize on the on-device engine). Remembers,
 * per runtime, when a provider rejects schema-constrained output and falls back to
 * a json_object request so a doomed schema round-trip is not repaid every turn.
 */

import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../errors.ts";
import {
	computePrefixHashes,
	hashStableJson,
} from "../runtime/context-hash.ts";
import {
	stringifyForDiagnostics,
	stringifyForModel,
} from "../runtime/json-output.ts";
import { estimateModelInputTokens } from "../runtime/model-input-budget.ts";
import { renderActionResultsForModel } from "../runtime/planner-rendering.ts";
import { buildProviderCachePlan } from "../runtime/provider-cache-plan.ts";
import { isMobilePlatform } from "../runtime-env.ts";
import { renderStoredEnvelopesForPrompt } from "../security/external-content";
import {
	composeToolDiagnosticRedactor,
	projectCompleteToolValueForModel,
} from "../security/tool-diagnostics";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
	setTrajectoryPurpose,
} from "../trajectory-context.ts";
import {
	resolveTrajectoryLogger,
	withStandaloneTrajectory,
} from "../trajectory-utils.ts";
import type {
	ActionResult,
	EvaluatorRunContext,
	EvaluatorRunOptions,
	EvaluatorRunResult,
	IAgentRuntime,
	JSONSchema,
	JsonValue,
	Memory,
	PromptSegment,
	RegisteredEvaluator,
	Service,
	State,
	Task,
	UUID,
} from "../types/index.ts";
import { EventType, ModelType } from "../types/index.ts";
import { ChannelType } from "../types/primitives.ts";
import { Service as BaseService } from "../types/service.ts";
import { getUserMessageText } from "../utils/message-text.ts";
import { providerRateLimitRetryAt } from "../utils/model-retry";
import { isObjectRecord as isRecord } from "../utils/type-guards.ts";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";
import { CONVERSATION_MESSAGES_HEADER_PREFIX, stringToUuid } from "../utils.ts";
import {
	DEFAULT_MEMORY_EVIDENCE_BATCH_BYTES,
	evaluatorEvidenceRecord,
	previousEvidencePage,
	selectSharedEvidencePages,
} from "./evaluator-evidence-page.ts";
import {
	bindEvaluatorReferenceEvidence,
	commitEvaluatorProgress,
	type EvaluatorProgressSnapshot,
	evaluatorSourceRevision,
	hasEvaluatorSourceProgress,
	prepareEvaluatorProgress,
	prepareEvaluatorProgressForTranscript,
	stageEvaluatorOutput,
} from "./evaluator-progress.ts";
import { requireIncrementalSourceCitations } from "./evaluator-schema.ts";
import {
	canonicalEvaluatorMessages,
	formatRecentMessages,
	getRoomTranscript,
	ROOM_TRANSCRIPT_HEADING,
} from "./evaluator-transcript.ts";
import { encodeEvaluatorTranscript } from "./evaluator-transcript-encoding.ts";

type PreparedEntry = {
	evaluator: RegisteredEvaluator;
	prepared: unknown;
	resolvedOutput?: unknown;
	options: EvaluatorRunOptions;
	message: Memory;
	progress?: EvaluatorProgressSnapshot;
	inputBinding?: string;
};

function extractionOptions(
	snapshot: EvaluatorProgressSnapshot,
	runtime: IAgentRuntime,
): NonNullable<EvaluatorRunOptions["extraction"]> {
	return {
		progressState: snapshot.progressState,
		isBackfill: snapshot.isBackfill,
		remainingSourceCount: snapshot.remainingSourceCount,
		referenceRevisions: snapshot.referenceRevisions,
		messages: canonicalEvaluatorMessages(snapshot.messages, runtime.agentId),
		sourceRevisions: snapshot.sourceRevisions,
		changedMessageIds: snapshot.changedMessageIds,
		removedMessageIds: snapshot.removedMessageIds,
		evidenceId: snapshot.evidenceId,
	};
}

const EMPTY_STATE: State = {
	values: {},
	data: {},
	text: "",
};

function stringifyForPrompt(value: unknown): string {
	if (typeof value === "string") return value;
	return stringifyForModel(value);
}

function coerceObjectOutput(raw: unknown): Record<string, unknown> | null {
	if (
		isRecord(raw) &&
		typeof raw.text === "string" &&
		Array.isArray(raw.toolCalls) &&
		("finishReason" in raw || "usage" in raw || "providerMetadata" in raw)
	) {
		// Native text handlers return a transport envelope, not evaluator fields.
		// A partial/tool-call completion must never commit extraction side effects.
		// Google GenAI's native result retains its documented uppercase STOP.
		const completed =
			raw.finishReason === "stop" || raw.finishReason === "STOP";
		if (!completed || raw.toolCalls.length > 0) {
			throw new ElizaError(
				"Evaluator model did not complete normally; no effects were applied",
				{
					code: "EVALUATOR_INCOMPLETE_OUTPUT",
					context: {
						finishReason: raw.finishReason,
						toolCallCount: raw.toolCalls.length,
					},
				},
			);
		}
		raw = raw.text;
	}
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch {
		// error-policy:J3 evaluator model output is untrusted input; malformed
		// JSON is an explicit invalid result.
		return null;
	}
}

/**
 * Whether the composed state carries the RECENT_MESSAGES conversation block:
 * detected on that provider's own text, never on arbitrary state text, so a
 * message quoting the heading cannot suppress the transcript.
 */
function hasProviderConversationBlock(state: State): boolean {
	const providers = isRecord(state.data) ? state.data.providers : undefined;
	const recent = isRecord(providers) ? providers.RECENT_MESSAGES : undefined;
	return (
		isRecord(recent) &&
		typeof recent.text === "string" &&
		recent.text.includes(CONVERSATION_MESSAGES_HEADER_PREFIX)
	);
}

const POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS_SETTING =
	"POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS";
/** Under the 131,072-token window the live post-turn model rejected at 137K and 151K prompt tokens (2026-09-13). */
const POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS_DEFAULT = 60_000;
const POST_TURN_EVALUATOR_TRIM_PASSES = 3;
/** Inverse of estimateTokensFromChars with headroom so one pass normally lands under budget. */
const POST_TURN_EVALUATOR_CHARS_PER_TOKEN = 3.5 * 1.1;
const POST_TURN_EVALUATOR_SKIP_REASON = "input_budget_exceeded";
const POST_TURN_EVALUATOR_SKIP_ERROR =
	"Post-turn evaluator skipped: estimated prompt exceeds POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS";
/**
 * Opt-in per-result cap for the post-turn prompt. Unset keeps the complete
 * result projections (the lossless contract); a deployment on a small
 * context window sets it (live 2026-09-14: one WEB_FETCH result rendered
 * 45K chars into a 29.6K-token post-turn call).
 */
const POST_TURN_EVALUATOR_RESULT_MAX_CHARS_SETTING =
	"POST_TURN_EVALUATOR_RESULT_MAX_CHARS";
/** One rendered RECENT_MESSAGES row starts `HH:MM (relative time) [entityId] `. */
const CONVERSATION_ROW_START = /^\d{2}:\d{2} \([^()\n]*\) \[[^\]\n]+\] /gm;
/** Sections the RECENT_MESSAGES provider appends after its conversation block. */
const CONVERSATION_BLOCK_END =
	/\n\n# (?:Received Message|Focus your response|Recent conversations across verified accounts)\n/;

function optionalPositiveIntegerSetting(
	runtime: IAgentRuntime,
	key: string,
): number | undefined {
	const value = runtime.getSetting(key);
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 1
		? Math.floor(parsed)
		: undefined;
}

function positiveIntegerSetting(
	runtime: IAgentRuntime,
	key: string,
	fallback: number,
): number {
	const value = runtime.getSetting(key);
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function estimatePromptTokens(
	rendered: RenderedEvaluatorPrompt,
	schema: JSONSchema,
): number {
	return estimateModelInputTokens({
		messages: [{ role: "user", content: rendered.prompt }],
		responseSchema: schema,
	});
}

type ConversationBlockTrim = {
	text: string;
	omittedRows: number;
};

/**
 * Drops the oldest rows of the RECENT_MESSAGES conversation block in `text`
 * (formatMessages renders newest first, so the oldest rows close the block)
 * until at least `dropChars` are gone; the newest row always stays. Null when
 * there is no block or nothing to drop.
 */
function trimConversationBlock(
	text: string,
	dropChars: number,
): ConversationBlockTrim | null {
	const headerAt = text.indexOf(CONVERSATION_MESSAGES_HEADER_PREFIX);
	const headerEnd = headerAt >= 0 ? text.indexOf("\n", headerAt) : -1;
	if (headerEnd < 0) return null;
	const bodyStart = headerEnd + 1;
	const endMatch = CONVERSATION_BLOCK_END.exec(text.slice(bodyStart));
	const bodyEnd = endMatch ? bodyStart + endMatch.index : text.length;
	const body = text.slice(bodyStart, bodyEnd);
	const rowStarts = Array.from(
		body.matchAll(CONVERSATION_ROW_START),
		(match) => match.index ?? 0,
	);
	if (rowStarts.length < 2) return null;
	const droppedChars = (kept: number): number =>
		kept < rowStarts.length ? body.length - (rowStarts[kept] ?? 0) : 0;
	let kept = rowStarts.length;
	while (kept > 1 && droppedChars(kept) < dropChars) kept--;
	if (kept === rowStarts.length) return null;
	const omittedRows = rowStarts.length - kept;
	const note = `[${omittedRows} older message(s) omitted for the post-turn evaluator input budget]\n`;
	return {
		omittedRows,
		text: `${text.slice(0, bodyStart)}${body.slice(0, rowStarts[kept] ?? 0)}${note}${text.slice(bodyEnd)}`,
	};
}

function trimProviderConversation(
	state: State,
	dropChars: number,
): { state: State; omittedRows: number } | null {
	const providers = state.data.providers;
	const recent = providers?.RECENT_MESSAGES;
	if (typeof recent?.text !== "string") return null;
	const provider = trimConversationBlock(recent.text, dropChars);
	const shared = trimConversationBlock(state.text, dropChars);
	if (!provider || !shared) return null;
	return {
		omittedRows: shared.omittedRows,
		state: {
			...state,
			text: shared.text,
			data: {
				...state.data,
				providers: {
					...providers,
					RECENT_MESSAGES: { ...recent, text: provider.text },
				},
			},
		},
	};
}

function trimTranscript(
	roomTranscript: Memory[] | null,
	dropChars: number,
): { roomTranscript: Memory[]; omittedRows: number } | null {
	if (!roomTranscript || roomTranscript.length < 2) return null;
	// Oldest rows go first; the newest row (the current turn) always stays.
	const rows = [...roomTranscript];
	let remaining = dropChars;
	let omittedRows = 0;
	while (remaining > 0 && rows.length > 1) {
		const dropped = rows.shift() as Memory;
		remaining -= getUserMessageText(dropped).length;
		omittedRows += 1;
	}
	return omittedRows > 0 ? { roomTranscript: rows, omittedRows } : null;
}

function mergeStates(base: State | undefined, providerState: State): State {
	if (!base) return providerState;
	const providerData = providerState.data.providers;
	const baseProviderData = base.data.providers;
	const mergedProviders =
		isRecord(baseProviderData) || isRecord(providerData)
			? {
					...(isRecord(baseProviderData) ? baseProviderData : {}),
					...(isRecord(providerData) ? providerData : {}),
				}
			: undefined;

	return {
		values: {
			...base.values,
			...providerState.values,
		},
		data: {
			...base.data,
			...providerState.data,
			...(mergedProviders ? { providers: mergedProviders } : {}),
		},
		text: [base.text, providerState.text].filter(Boolean).join("\n"),
	};
}

function buildMergedSchema(active: PreparedEntry[]): JSONSchema {
	return {
		type: "object",
		properties: Object.fromEntries(
			active.map(({ evaluator, options }) => [
				evaluator.name,
				options.extraction
					? requireIncrementalSourceCitations(evaluator.schema)
					: evaluator.schema,
			]),
		),
		required: active.map(({ evaluator }) => evaluator.name),
		additionalProperties: false,
	};
}

type RenderedEvaluatorPrompt = {
	prompt: string;
	promptSegments: PromptSegment[];
	providerOptions: ReturnType<typeof buildProviderCachePlan>["providerOptions"];
};

function renderSharedContext(params: {
	runtime: IAgentRuntime;
	message: Memory;
	agentName: string;
	options: EvaluatorRunOptions;
	parts: Record<string, string>;
	/** Blocks hoisted from the active sections, rendered once after the provider context. */
	blocks: Record<string, string>;
}): string {
	const { runtime, message, agentName, options, parts, blocks } = params;
	const part = (name: string, fallback = "(none)") => {
		const text = toWellFormedUnicode(parts[name] ?? "");
		return text || fallback;
	};
	const blockText = Object.entries(blocks)
		.map(
			([heading, text]) =>
				`\n${heading}:\n${toWellFormedUnicode(text) || "(none)"}\n`,
		)
		.join("");

	return `Evaluate just-finished turn for ${agentName}.

## Shared Turn Context

Agent ID: ${runtime.agentId}
Agent name: ${agentName}
Message ID: ${message.id ?? "(none)"}
Room ID: ${message.roomId}
Sender entity ID: ${message.entityId}
Did respond: ${options.didRespond === true ? "true" : "false"}

Latest message:
${part("latestMessage")}

Agent response messages:
${part("responseTexts")}

Action results:
${part("actionResults", "[]")}

${ROOM_TRANSCRIPT_HEADING} (${parts.evidenceMode ?? "complete, oldest first"}):
${part("roomTranscript")}
${parts.referenceContext ?? ""}

Provider context:
${part("providerContext")}
${blockText}`;
}

function buildPrompt(params: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	/** Complete room transcript, or null when the read failed this turn. */
	roomTranscript: Memory[] | null;
	active: PreparedEntry[];
	options: EvaluatorRunOptions;
	schema: JSONSchema;
	/** Oldest conversation rows dropped by the input budget, if any. */
	transcriptOmittedRows?: number;
	/** Background history review: restored reference records and pagination state. */
	referenceContext?: string;
}): RenderedEvaluatorPrompt {
	const { runtime, message, state, active, options } = params;
	const incremental = active.every((entry) => entry.progress !== undefined);
	const agentName = runtime.character.name ?? "Agent";

	const selectedSourceIds = new Set(
		params.roomTranscript?.map((record) => record.id),
	);
	const triggerDeferred =
		incremental &&
		params.roomTranscript !== null &&
		!selectedSourceIds.has(message.id);
	const latestMessage = triggerDeferred
		? "(Job trigger is in a later evidence page. Its complete text and turn receipts remain deferred; extract only the selected source records below.)"
		: (message.content.text ?? "");
	const responseTexts = (triggerDeferred ? [] : (options.responses ?? []))
		.map((response) => response.content.text)
		.filter(
			(text): text is string => typeof text === "string" && text.length > 0,
		)
		.join("\n");
	const actionResults =
		!triggerDeferred && isRecord(state.data)
			? state.data.actionResults
			: undefined;
	const providerContext = state.text.trim() || "(none)";
	// The RECENT_MESSAGES provider renders the canonical complete room
	// conversation (same retained rows, same hygiene and dedupe as
	// getRoomTranscript, plus names, timestamps, attachments and actions). When
	// that block is in provider context the room conversation is already in
	// this prompt once; the transcript slot points at it instead of embedding a
	// second, plainer copy (live 2026-09-06: three copies per call, 107K tokens,
	// the provider limit reachable as the room grows).
	const providerConversationRendered = hasProviderConversationBlock(state);
	const omittedNote = params.transcriptOmittedRows
		? `${params.transcriptOmittedRows} older message(s) omitted for the post-turn evaluator input budget`
		: "";
	// Each shared result keeps its head up to POST_TURN_EVALUATOR_RESULT_MAX_CHARS
	// (the outcome the evaluators read) while the complete ActionResults remain
	// available on state for evaluator code; the in-loop evaluator keeps its
	// complete projections.
	const actionResultsMaxChars = optionalPositiveIntegerSetting(
		runtime,
		POST_TURN_EVALUATOR_RESULT_MAX_CHARS_SETTING,
	);
	const sharedParts = {
		referenceContext: params.referenceContext ?? "",
		evidenceMode: incremental
			? "complete pending evidence records; processed history remains in storage"
			: "complete, oldest first",
		latestMessage,
		responseTexts,
		actionResults: Array.isArray(actionResults)
			? renderActionResultsForModel(actionResults as ActionResult[], {
					maxCharsPerResult: actionResultsMaxChars,
				}).text
			: stringifyForPrompt(actionResults ?? []),
		providerContext,
		// Rendered once here; sections refer to it instead of embedding their
		// own copy (live 2026-09-05: five copies of the room history per call).
		// A failed transcript read leaves sections on their own copies so the
		// failure isolates per evaluator exactly as before.
		roomTranscript: providerConversationRendered
			? `rendered once below in Provider context under "${CONVERSATION_MESSAGES_HEADER_PREFIX}N retained)" (${omittedNote || "complete, deduped, oldest first"})`
			: params.roomTranscript === null
				? "(unavailable this turn)"
				: incremental
					? // Compact JSON preserves every selected field without paying for
						// per-record indentation across a historical backfill.
						encodeEvaluatorTranscript(
							params.roomTranscript.map((record) => ({
								id: record.id,
								entityId: record.entityId,
								createdAt: record.createdAt,
								content: {
									...record.content,
									// Transport acknowledgements are not conversation evidence.
									// Keep delivered callback text, attachments and domain fields.
									chatIdempotency: undefined,
									evalCallbacks: undefined,
									providers: undefined,
									responseId: undefined,
									responseMessageId: undefined,
									text:
										typeof record.content.text === "string"
											? renderStoredEnvelopesForPrompt(record.content.text)
											: record.content.text,
								},
							})),
						)
					: `${omittedNote ? `(${omittedNote})\n` : ""}${formatRecentMessages(params.roomTranscript)}`,
	};
	// Blocks several sections would each embed (live 2026-09-14: the room
	// entity list appeared once per participant section) render once in the
	// shared context; the first declaring section's text wins.
	const sharedBlocks: Record<string, string> = {};
	for (const entry of active) {
		const declared = entry.evaluator.sharedBlocks?.({
			runtime,
			message: entry.message,
			state,
			options: entry.options,
			prepared: entry.prepared,
		});
		for (const [heading, text] of Object.entries(declared ?? {})) {
			if (text && !(heading in sharedBlocks)) sharedBlocks[heading] = text;
		}
	}
	const shared = {
		roomTranscriptRendered:
			providerConversationRendered || params.roomTranscript !== null,
		actionResultsText: sharedParts.actionResults,
		actionResultsMaxChars,
		blocks: sharedBlocks,
	};

	const stable: PromptSegment[] = [
		{
			content:
				"# Task: Post-turn evaluation\n\nReturn exactly one JSON object. No prose, markdown fences, XML, hidden reasoning.\nOne top-level property per active evaluator. Use only provided context. Nothing to record => empty shape.\n\n## Active Evaluator Instructions\n\n",
			stable: true,
		},
	];
	if (active.some((entry) => entry.progress !== undefined)) {
		// This rule is shared by every incremental extractor. Keep revision IDs
		// and selected source sets per extractor below; repeat neither the rule
		// nor its speaker/provenance protections for each section.
		stable.push({
			content:
				"Incremental evidence rules: each incremental section identifies its exact source set and edited/removed IDs. Existing facts and other evaluator records are reference context, not additional evidence. Attribute personal facts only to their actual speaker; another speaker's statement is not a fact about the triggering sender. Agent thoughts are not independent factual evidence. If a reference cannot be resolved from the evidence and existing records, do not invent a memory.\n\n",
			stable: true,
		});
	}
	const dynamic: PromptSegment[] = [];
	const evidenceSets = new Map<
		string,
		{ id: string; sourceIds: Array<Memory["id"]> }
	>();
	const sharedIds = params.roomTranscript?.map((record) => record.id);
	for (const entry of active) {
		const { evaluator, prepared } = entry;
		const context = {
			runtime,
			message: entry.message,
			state,
			options: entry.options,
			prepared,
			shared,
		};
		const full = evaluator.prompt(context);
		const segments = evaluator.promptSegments?.(context) ?? [
			{ content: full, stable: false },
		];
		if (segments.map((segment) => segment.content).join("") !== full) {
			throw new ElizaError(
				"Evaluator prompt segments must preserve the complete prompt",
				{
					code: "EVALUATOR_PROMPT_SEGMENTS_MISMATCH",
					context: { evaluator: evaluator.name },
				},
			);
		}
		let dynamicStarted = false;
		for (const segment of segments) {
			if (!segment.stable) dynamicStarted = true;
			else if (dynamicStarted) {
				throw new ElizaError(
					"Evaluator stable instructions must precede dynamic context",
					{
						code: "EVALUATOR_PROMPT_SEGMENT_ORDER_INVALID",
						context: { evaluator: evaluator.name },
					},
				);
			}
		}
		let previousContent = "";
		for (const [index, current] of segments.entries()) {
			if (current.content.length === 0) continue;
			if (
				/[\uD800-\uDBFF]$/.test(previousContent) &&
				/^[\uDC00-\uDFFF]/.test(current.content)
			) {
				throw new ElizaError(
					"Evaluator prompt segments must not split a Unicode code point",
					{
						code: "EVALUATOR_PROMPT_SEGMENT_BOUNDARY_INVALID",
						context: { evaluator: evaluator.name, segmentIndex: index },
					},
				);
			}
			previousContent = current.content;
		}
		stable.push({
			content: `### ${evaluator.name}\n${evaluator.description}\n\n${segments
				.filter((segment) => segment.stable)
				.map((segment) => segment.content)
				.join("")}\nPut result under "${evaluator.name}".\n\n`,
			stable: true,
		});
		const evidenceIds = entry.options.extraction?.messages.map(
			(record) => record.id,
		);
		let evidenceSelection = "";
		if (evidenceIds !== undefined) {
			if (stringifyForModel(evidenceIds) === stringifyForModel(sharedIds))
				evidenceSelection = "all evidence records above";
			else {
				const key = stringifyForModel(evidenceIds);
				let set = evidenceSets.get(key);
				if (!set) {
					set = {
						id: `evidence-set-${evidenceSets.size + 1}`,
						sourceIds: evidenceIds,
					};
					evidenceSets.set(key, set);
				}
				evidenceSelection = `only the exact source IDs in ${set.id} defined above`;
			}
		}
		dynamic.push({
			content: `### ${evaluator.name}\n${entry.progress ? `Incremental evidence contract: process ${evidenceSelection}. Removed source IDs: ${stringifyForModel(entry.progress.removedMessageIds)}. Edited source IDs: ${stringifyForModel(entry.progress.changedMessageIds)}.\n` : ""}${segments
				.filter((segment) => !segment.stable)
				.map((segment) => segment.content)
				.join("")}\n\n`,
			stable: false,
		});
	}
	// JSON-object and plain-output providers do not carry an enforceable schema
	// on the wire. Keep the complete contract visible to every model path.
	const schemaSegment: PromptSegment = {
		content: `## Output JSON Schema\n${JSON.stringify(params.schema)}\n\n`,
		stable: true,
	};
	const sharedContext = renderSharedContext({
		runtime,
		message,
		agentName,
		options,
		parts: sharedParts,
		blocks: sharedBlocks,
	});
	const promptSegments = [
		...stable,
		schemaSegment,
		{
			content: `${sharedContext}${evidenceSets.size ? `\n\nExact selected source sets (each listed once; membership is evaluator-specific):\n${[...evidenceSets.values()].map((set) => `${set.id}: ${stringifyForModel(set.sourceIds)}`).join("\n")}` : ""}\n\n## Active Evaluators\n\n`,
			stable: false,
		},
		...dynamic,
	].map((segment) => ({
		...segment,
		content: toWellFormedUnicode(segment.content),
	}));
	const prefixHashes = computePrefixHashes(
		promptSegments.filter((segment) => segment.stable),
	);
	const prefixHash = hashStableJson({
		prefix: prefixHashes.at(-1)?.hash,
		schema: params.schema,
	});
	// This identifies content/schema, not the selected provider or model. Model
	// affinity remains the backend's responsibility; the benchmark scopes its
	// optional verified routing hint separately to the actual selected model.
	const plan = buildProviderCachePlan({
		prefixHash,
		segmentHashes: computePrefixHashes(promptSegments).map(
			(entry) => entry.segmentHash,
		),
		promptSegments,
		conversationId: `${runtime.agentId}:${message.roomId}:post_turn`,
	});
	return {
		prompt: promptSegments.map((segment) => segment.content).join(""),
		promptSegments,
		// Automatic cloud prefix reuse needs ordered text, not an account-gated
		// routing hint. Keep canonical local metadata without enabling new hints.
		providerOptions: { eliza: plan.providerOptions.eliza },
	};
}

type BudgetedEvaluatorPrompt = {
	rendered: RenderedEvaluatorPrompt;
	/** The (possibly trimmed) input the dispatched prompt was rendered from. */
	promptInput: Parameters<typeof buildPrompt>[0];
	estimatedPromptTokens: number;
	budgetTokens: number;
	omittedRows: number;
	skip: boolean;
};

/**
 * Estimates the merged prompt before dispatch. Over budget, the oldest shared
 * conversation rows are dropped (newest first kept, current turn untouched)
 * and the prompt re-rendered; still over budget means the call is skipped.
 */
function applyPostTurnInputBudget(
	params: Parameters<typeof buildPrompt>[0] & {
		rendered: RenderedEvaluatorPrompt;
		/** Incremental evidence is the extraction contract; only complete-history batches trim. */
		trimmable: boolean;
	},
): BudgetedEvaluatorPrompt {
	const { rendered: initial, trimmable, ...promptInput } = params;
	const budgetTokens = positiveIntegerSetting(
		promptInput.runtime,
		POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS_SETTING,
		POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS_DEFAULT,
	);
	let rendered = initial;
	let estimatedPromptTokens =
		promptInput.active.length > 0
			? estimatePromptTokens(rendered, promptInput.schema)
			: 0;
	let state = promptInput.state;
	let roomTranscript = promptInput.roomTranscript;
	let omittedRows = 0;
	for (
		let pass = 0;
		trimmable &&
		pass < POST_TURN_EVALUATOR_TRIM_PASSES &&
		estimatedPromptTokens > budgetTokens;
		pass++
	) {
		const dropChars = Math.ceil(
			(estimatedPromptTokens - budgetTokens) *
				POST_TURN_EVALUATOR_CHARS_PER_TOKEN,
		);
		const trimmed = hasProviderConversationBlock(state)
			? trimProviderConversation(state, dropChars)
			: trimTranscript(roomTranscript, dropChars);
		if (!trimmed) break;
		if ("state" in trimmed) state = trimmed.state;
		else roomTranscript = trimmed.roomTranscript;
		omittedRows += trimmed.omittedRows;
		rendered = buildPrompt({
			...promptInput,
			state,
			roomTranscript,
			transcriptOmittedRows: omittedRows,
		});
		estimatedPromptTokens = estimatePromptTokens(rendered, promptInput.schema);
	}
	return {
		rendered,
		promptInput: {
			...promptInput,
			state,
			roomTranscript,
			transcriptOmittedRows: omittedRows,
		},
		estimatedPromptTokens,
		budgetTokens,
		omittedRows,
		skip: estimatedPromptTokens > budgetTokens,
	};
}

// Schema-SPECIFIC rejection tokens: a HIGH-CONFIDENCE signal that the provider
// STRUCTURALLY rejects schema-constrained output (vs a generic/transient HTTP
// 400 that merely says "bad request" — rate-limit, malformed prompt, context
// length, gateway blip). Single source of truth so the immediate-arm set can
// never silently drift from the broader fallback set below.
const SCHEMA_SPECIFIC_REJECTION_TOKENS = [
	"response schema",
	"responseschema",
	"json_schema",
	"structured output",
] as const;

function errorMessageText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error ?? ""))
		.toLowerCase()
		.trim();
}

// Only a schema-specific rejection should arm the lifetime memo on its own; a
// bare "bad request" still falls back for the turn but is re-attempted next turn
// (gated by a streak below) so a one-off blip cannot permanently downgrade a
// schema-capable provider.
function schemaRejectionLooksPersistent(error: unknown): boolean {
	const message = errorMessageText(error);
	return SCHEMA_SPECIFIC_REJECTION_TOKENS.some((token) =>
		message.includes(token),
	);
}

// Generic "bad request" is intentionally broad here (it drives the per-turn
// json_object fallback). Deriving this from schemaRejectionLooksPersistent
// guarantees the immediate-arm token set stays a strict subset of the fallback
// set — add a schema token in one place and both predicates pick it up.
function schemaRequestLooksUnsupported(error: unknown): boolean {
	const message = errorMessageText(error);
	if (!message) return false;
	return (
		message.includes("bad request") || schemaRejectionLooksPersistent(error)
	);
}

// Once a runtime's SMALL model rejects a structured `responseSchema` request,
// every subsequent request will be rejected the same way — the provider simply
// does not support schema-constrained output (e.g. the cerebras gpt-oss path on
// Eliza Cloud). Re-sending the schema each turn burns a full, DOOMED model
// round-trip before the json_object retry succeeds — measured at ~4.5s of pure
// waste on every turn. Remember the rejection per runtime and, from then on,
// skip straight to the json_object request. Keyed by the live runtime instance
// (a WeakSet, so it never leaks across agents).
//
// The memo is armed conservatively (see below): a schema-specific rejection
// arms it immediately, but a bare/generic "bad request" must recur
// `SCHEMA_UNSUPPORTED_STREAK_THRESHOLD` times in a row — any schema SUCCESS in
// between resets the streak — so a transient 400 self-heals instead of
// permanently downgrading a genuinely schema-capable provider.
const schemaUnsupportedRuntimes = new WeakSet<object>();
const schemaRejectionStreak = new WeakMap<object, number>();
const SCHEMA_UNSUPPORTED_STREAK_THRESHOLD = 2;

function modelInputFor(rendered: RenderedEvaluatorPrompt) {
	return {
		messages: [{ role: "user" as const, content: rendered.prompt }],
		promptSegments: rendered.promptSegments,
		providerOptions: rendered.providerOptions,
	};
}

async function generateEvaluationOutput(params: {
	runtime: IAgentRuntime;
	rendered: RenderedEvaluatorPrompt;
	schema: JSONSchema;
}): Promise<unknown> {
	const { runtime, rendered, schema } = params;
	const modelInput = modelInputFor(rendered);
	// Post-turn evaluation runs on the SMALL model: it is a cheap, frequent,
	// structured extraction/classification pass (all active evaluators share one
	// merged call), not generation — the large model is wasted cost here,
	// especially for local-first tiers.
	const requestJsonObject = (): Promise<unknown> =>
		runtime.useModel(ModelType.TEXT_SMALL, {
			...modelInput,
			responseFormat: { type: "json_object" },
			temperature: 0,
		});
	const requestPlain = (): Promise<unknown> =>
		runtime.useModel(ModelType.TEXT_SMALL, {
			...modelInput,
			temperature: 0,
		});
	const afterJsonObjectRejected = async (
		fallbackError: unknown,
	): Promise<unknown> => {
		if (!schemaRequestLooksUnsupported(fallbackError)) throw fallbackError;
		runtime.logger.debug(
			{ src: "service:evaluator" },
			"Post-turn evaluator JSON-object fallback rejected; retrying plain JSON prompt",
		);
		return requestPlain();
	};

	// This runtime already proved its SMALL model rejects schema-constrained
	// output — don't pay for the doomed schema round-trip again.
	if (schemaUnsupportedRuntimes.has(runtime)) {
		try {
			return await requestJsonObject();
		} catch (fallbackError) {
			// error-policy:J1 Both evaluator protocol variants failed; return the
			// explicit invalid evaluator result from the boundary helper.
			return afterJsonObjectRejected(fallbackError);
		}
	}

	try {
		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			...modelInput,
			responseSchema: schema,
			responseFormat: { type: "json_object" },
			temperature: 0,
		});
		// Schema worked this turn — clear any prior rejection streak so a stray
		// earlier 400 never accumulates toward a permanent downgrade.
		schemaRejectionStreak.delete(runtime);
		return result;
	} catch (error) {
		if (!schemaRequestLooksUnsupported(error)) throw error;
		// error-policy:J4 Provider schema incompatibility degrades to the
		// JSON-object protocol and is memoized only after stable evidence.
		// Decide whether this rejection is structural enough to PERMANENTLY skip
		// the schema attempt from now on. A schema-specific message arms the memo
		// immediately; a generic "bad request" must recur THRESHOLD times in a row
		// (a single transient blip self-heals on the next schema success).
		const streak = (schemaRejectionStreak.get(runtime) ?? 0) + 1;
		schemaRejectionStreak.set(runtime, streak);
		if (
			!schemaUnsupportedRuntimes.has(runtime) &&
			(schemaRejectionLooksPersistent(error) ||
				streak >= SCHEMA_UNSUPPORTED_STREAK_THRESHOLD)
		) {
			schemaUnsupportedRuntimes.add(runtime);
			// WARN (not debug) so an erroneous permanent downgrade is observable.
			runtime.logger.warn(
				{ src: "service:evaluator", streak },
				"Post-turn evaluator: provider rejected schema-constrained output; disabling schema requests for this runtime (json_object fallback)",
			);
		}
		runtime.logger.debug(
			{ src: "service:evaluator" },
			"Post-turn evaluator schema request rejected; retrying JSON-object fallback",
		);
		try {
			return await requestJsonObject();
		} catch (fallbackError) {
			// error-policy:J1 Both evaluator protocol variants failed; return the
			// explicit invalid evaluator result from the boundary helper.
			return afterJsonObjectRejected(fallbackError);
		}
	}
}

export class EvaluatorService extends BaseService {
	static serviceType = "evaluator" as const;
	capabilityDescription =
		"Runs registered post-turn evaluators in one structured model call";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new EvaluatorService(runtime);
		runtime.registerTaskWorker({
			name: "POST_TURN_MEMORY",
			shouldRun: async () =>
				!service.backgroundRunning &&
				runtime.roomHandlerQueue.pendingTotal() === 0,
			execute: async (_runtime, _options, task) =>
				service.executeBackgroundTask(task),
		});
		return service;
	}

	private backgroundRunning = false;

	private isBackground(evaluator: RegisteredEvaluator): boolean {
		return (
			evaluator.background === true &&
			(typeof evaluator.incremental === "function"
				? evaluator.incremental(this.runtime)
				: evaluator.incremental === true)
		);
	}

	/** Persist before the delivery barrier releases. No model inference runs here. */
	async enqueue(
		message: Memory,
		state: State | undefined,
		options: EvaluatorRunOptions,
	): Promise<EvaluatorRunResult> {
		if (options.phase !== "post_turn") return this.run(message, state, options);
		await this.enqueueBackground(message, state, options);
		return this.runSelected(
			this.runtime.evaluators.filter((entry) => !this.isBackground(entry)),
			message,
			state,
			options,
		);
	}

	/** Both built-in reducers must own the replacement. Legacy/custom runtimes and
	 * voice/mobile keep their existing validation path. */
	ownsDeferredFacts(message: Memory): boolean {
		return (
			!isMobilePlatform() &&
			message.content.channelType !== ChannelType.VOICE_DM &&
			message.content.channelType !== ChannelType.VOICE_GROUP &&
			["factMemory", "relationships"].every((name) =>
				this.runtime.evaluators.some(
					(entry) => entry.name === name && this.isBackground(entry),
				),
			)
		);
	}

	/** Persist the post-delivery source job without invoking legacy evaluators or a model. */
	private async enqueueBackground(
		message: Memory,
		state: State | undefined,
		options: EvaluatorRunOptions,
	): Promise<void> {
		const background = this.runtime.evaluators.filter((entry) =>
			this.isBackground(entry),
		);
		if (background.length) {
			if (!message.id)
				throw new ElizaError(
					"Background extraction requires a persisted message",
					{ code: "EVALUATOR_JOB_INVALID_SOURCE" },
				);
			const id = stringToUuid(
				`post-turn-memory:${this.runtime.agentId}:${message.roomId}:${message.entityId}:${message.id}`,
			);
			{
				const existing = await this.runtime.getTask(id);
				const task: Task = {
					id,
					name: "POST_TURN_MEMORY",
					agentId: this.runtime.agentId,
					roomId: message.roomId,
					entityId: message.entityId,
					tags: ["queue", "repeat"],
					metadata: {
						messageId: message.id,
						responseIds: (options.responses ?? [])
							.map((response) => response.id)
							.filter(Boolean),
						didRespond: options.didRespond === true,
						semanticSignal: options.semanticSignal !== false,
						// Server-owned durable receipts only; provider/private prompt state is recomposed.
						actionResults: projectCompleteToolValueForModel(
							state?.data.actionResults ?? [],
							composeToolDiagnosticRedactor(this.runtime),
						) as ActionResult[],
					},
				};
				if (existing)
					await this.runtime.updateTask(id, {
						metadata: { ...existing.metadata, ...task.metadata },
					});
				else
					await this.runtime.createTask({
						...task,
						// Scheduling defaults belong to creation only. Delivery replay
						// must preserve the scheduler's retry delay and operator policy.
						metadata: {
							updateInterval: 1000,
							baseInterval: 1000,
							maxFailures: 5,
							...task.metadata,
						},
					});
			}
		}
	}

	/** Persist a repair intent before changing canonical evidence. Only real message
	 * edits enter this path; embedding/bookkeeping updates do not wake extraction. */
	async mutateSourceEvidence<T>(
		ids: UUID[],
		updates: Array<Partial<Memory> & { id: UUID }> | undefined,
		write: () => Promise<T>,
	): Promise<T> {
		// Vector persistence cannot change authored evidence. Do not acquire a
		// conversation lease for it: in-flight embeddings may finish after turn
		// admissions close during shutdown. Mixed patches still reconcile below.
		if (
			updates?.length &&
			updates.every(
				(update) =>
					Object.hasOwn(update, "embedding") &&
					Object.keys(update).every(
						(key) => key === "id" || key === "embedding",
					),
			)
		)
			return write();
		const initial = (
			await this.runtime.getMemoriesByIds(ids, "messages")
		).filter((row) => row.agentId === this.runtime.agentId);
		if (!initial.length) return write();
		return this.runtime.roomHandlerQueue.withLeases(
			initial.map((row) => row.roomId),
			async (leases) => {
				const current = (
					await this.runtime.getMemoriesByIds(ids, "messages")
				).filter((row) => row.agentId === this.runtime.agentId);
				if (current.some((row) => !leases.has(row.roomId)))
					throw new ElizaError("Source moved outside the mutation lease", {
						code: "EVALUATOR_SOURCE_SCOPE_CHANGED",
					});
				const patches = new Map(updates?.map((row) => [row.id, row]));
				const changed = current.filter(
					(row) =>
						!updates ||
						evaluatorSourceRevision(row) !==
							evaluatorSourceRevision({
								...row,
								...patches.get(row.id as UUID),
							}),
				);
				if (!changed.length) return write();
				const intents: Task[] = [];
				for (const roomId of new Set(changed.map((row) => row.roomId))) {
					const transcript = await this.runtime.getMemories({
						tableName: "messages",
						roomId,
						agentId: this.runtime.agentId,
						unique: false,
						includeEmbedding: false,
					});
					const owners = [
						...new Set(
							transcript
								.map((row) => row.entityId)
								.filter((id) => id !== this.runtime.agentId),
						),
					];
					for (const entityId of owners) {
						const trigger = transcript.find((row) => row.entityId === entityId);
						if (!trigger?.id) continue;
						if (
							!(await hasEvaluatorSourceProgress(
								this.runtime,
								trigger,
								this.runtime.evaluators
									.filter((entry) => this.isBackground(entry))
									.map((entry) => entry.name),
								changed
									.filter((row) => row.roomId === roomId)
									.map((row) => row.id as UUID),
							))
						)
							continue;
						const id = stringToUuid(
							`post-turn-memory:${this.runtime.agentId}:${roomId}:${entityId}:${trigger.id}`,
						);
						const task: Task = {
							id,
							name: "POST_TURN_MEMORY",
							agentId: this.runtime.agentId,
							roomId,
							entityId,
							tags: ["queue", "repeat"],
							metadata: {
								reconciliation: true,
								reconciliationRevision: uuidv4(),
								messageId: trigger.id,
								semanticSignal: true,
							},
						};
						const existing = await this.runtime.getTask(id);
						if (existing)
							await this.runtime.updateTask(id, {
								metadata: { ...existing.metadata, ...task.metadata },
							});
						else
							await this.runtime.createTask({
								...task,
								// Source reconciliation updates evidence without resetting
								// backoff on an already pending extraction job.
								metadata: {
									updateInterval: 1000,
									baseInterval: 1000,
									maxFailures: 5,
									...task.metadata,
								},
							});
						intents.push(task);
					}
				}
				const result = await write();
				// Retirement has no model dependency and finishes inside the edit's lease.
				// Re-extraction remains durable scheduler work even if this process exits.
				for (const task of intents) await this.reconcileTaskSources(task);
				return result;
			},
		);
	}

	private async reconcileTaskSources(task: Task): Promise<void> {
		const message: Memory = {
			id: task.metadata?.messageId as UUID,
			agentId: this.runtime.agentId,
			roomId: task.roomId as UUID,
			entityId: task.entityId as UUID,
			content: {},
		};
		// This identity-only context is never sent to a model or persisted as a message.
		const transcript = await this.runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			agentId: this.runtime.agentId,
			unique: false,
			includeEmbedding: false,
		});
		for (const evaluator of this.runtime.evaluators) {
			const reconcile = evaluator.reconcileEvidence;
			if (!this.isBackground(evaluator) || !reconcile) continue;
			await prepareEvaluatorProgress(
				this.runtime,
				message,
				[evaluator.name],
				transcript,
				{
					reconcileOnly: true,
					reconcile: (reconciliation) =>
						reconcile({
							runtime: this.runtime,
							message,
							state: undefined,
							options: { phase: "post_turn" },
							reconciliation,
						}),
				},
			);
		}
	}

	private async executeBackgroundTask(
		task: Task,
	): Promise<{ preserveTask: boolean } | undefined> {
		if (
			this.backgroundRunning ||
			this.runtime.roomHandlerQueue.pendingTotal() > 0
		)
			return { preserveTask: true };
		if (
			!task.id ||
			task.agentId !== this.runtime.agentId ||
			!task.roomId ||
			!task.entityId ||
			typeof task.metadata?.messageId !== "string"
		)
			throw new ElizaError("Background memory job has invalid ownership", {
				code: "EVALUATOR_JOB_INVALID_SCOPE",
			});
		const messageId = task.metadata.messageId as Memory["entityId"];
		this.backgroundRunning = true;
		try {
			return await runWithTrajectoryContext({}, () =>
				withStandaloneTrajectory(
					this.runtime,
					{
						source: "background_memory",
						metadata: {
							taskId: task.id,
							roomId: task.roomId,
							messageId: task.metadata?.messageId,
						},
					},
					async () => {
						let message = await this.runtime.getMemoryById(messageId);
						if (task.metadata?.reconciliation === true) {
							await this.runtime.roomHandlerQueue.withLease(
								task.roomId as UUID,
								() => this.reconcileTaskSources(task),
							);
							if (!message) {
								const retained = await this.runtime.getMemories({
									tableName: "messages",
									roomId: task.roomId,
									agentId: this.runtime.agentId,
									entityId: task.entityId,
									authorEntityIds: [task.entityId as UUID],
									unique: false,
									includeEmbedding: false,
								});
								message =
									retained.find((row) => row.entityId === task.entityId) ??
									null;
								if (!message) {
									return this.finishBackgroundTask(task);
								}
							}
						}
						if (
							!message ||
							message.agentId !== task.agentId ||
							message.roomId !== task.roomId ||
							message.entityId !== task.entityId
						)
							throw new ElizaError(
								"Background memory trigger is absent or changed owner",
								{ code: "EVALUATOR_JOB_INVALID_SOURCE" },
							);
						const responseIds = task.metadata?.responseIds;
						const responses: Memory[] = [];
						if (Array.isArray(responseIds))
							for (const id of responseIds) {
								if (typeof id !== "string") continue;
								const response = await this.runtime.getMemoryById(
									id as Memory["entityId"],
								);
								if (
									response &&
									response.agentId === task.agentId &&
									response.roomId === task.roomId &&
									response.entityId === this.runtime.agentId
								)
									responses.push(response);
							}
						const result = await this.runSelected(
							this.runtime.evaluators.filter((entry) =>
								this.isBackground(entry),
							),
							message,
							{
								...EMPTY_STATE,
								data: {
									actionResults: Array.isArray(task.metadata?.actionResults)
										? (task.metadata.actionResults as ActionResult[])
										: [],
								},
							},
							{
								phase: "post_turn",
								didRespond: task.metadata?.didRespond === true,
								semanticSignal: task.metadata?.semanticSignal !== false,
								responses,
							},
							true,
						);
						if (result.errors.length)
							throw new ElizaError("Background memory remains pending", {
								code: "EVALUATOR_JOB_PENDING",
								context: { errors: result.errors },
								retryAt: Math.max(
									0,
									...result.errors.map((entry) => entry.retryAt ?? 0),
								),
							});
						if (result.hasMoreEvidence) return undefined;
						return this.finishBackgroundTask(task);
					},
				),
			);
		} finally {
			// A backlog of cached/staged jobs can resolve entirely in microtasks.
			// Admit socket/timer events before the scheduler starts another job so
			// incoming chat can reach the foreground queue checked above. Keep this
			// worker owned during the yield, including failed-output replay.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			this.backgroundRunning = false;
		}
	}

	/** Coalesced jobs may be revised while inference releases the room. Delete only
	 * the exact revision consumed; otherwise the existing task remains the wakeup. */
	private async finishBackgroundTask(
		task: Task,
	): Promise<{ preserveTask: boolean }> {
		return this.runtime.roomHandlerQueue.withLease(
			task.roomId as UUID,
			async () => {
				const current = await this.runtime.getTask(task.id as UUID);
				if (
					current &&
					current.metadata?.reconciliationRevision ===
						task.metadata?.reconciliationRevision
				)
					await this.runtime.deleteTask(task.id as UUID);
				return { preserveTask: true };
			},
		);
	}

	private evidenceBatchBytes(): number {
		const configured = this.runtime.getSetting("MEMORY_EVIDENCE_BATCH_BYTES");
		const limit =
			configured === undefined || configured === null || configured === ""
				? DEFAULT_MEMORY_EVIDENCE_BATCH_BYTES
				: Number(configured);
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new ElizaError(
				"Memory evidence budget must be a positive byte count",
				{ code: "EVALUATOR_BATCH_LIMIT_INVALID" },
			);
		return limit;
	}

	private inRoom<T>(
		message: Memory,
		background: boolean,
		fn: () => Promise<T>,
	): Promise<T> {
		return background
			? this.runtime.roomHandlerQueue.withLease(message.roomId, fn)
			: fn();
	}

	async stop(): Promise<void> {
		// Stateless service.
	}

	list(): RegisteredEvaluator[] {
		return [...this.runtime.evaluators];
	}

	register(evaluator: RegisteredEvaluator): void {
		this.runtime.registerEvaluator(evaluator);
	}

	unregister(name: string): boolean {
		return this.runtime.unregisterEvaluator(name);
	}

	private sortEvaluators(
		evaluators: RegisteredEvaluator[],
	): RegisteredEvaluator[] {
		return evaluators.sort(
			(a, b) =>
				(a.priority ?? 100) - (b.priority ?? 100) ||
				a.name.localeCompare(b.name),
		);
	}

	private async collectActiveEvaluators(
		candidates: RegisteredEvaluator[],
		context: EvaluatorRunContext,
		errors: EvaluatorRunResult["errors"],
		progress?: Map<string, EvaluatorProgressSnapshot>,
	): Promise<RegisteredEvaluator[]> {
		const active: RegisteredEvaluator[] = [];
		await Promise.all(
			candidates.map(async (evaluator) => {
				try {
					const snapshot = progress?.get(evaluator.name);
					if (
						snapshot?.pendingOutput !== undefined ||
						(await evaluator.shouldRun({
							...context,
							message: snapshot?.triggerMessage ?? context.message,
							options: snapshot
								? {
										...context.options,
										extraction: extractionOptions(snapshot, this.runtime),
									}
								: context.options,
						}))
					)
						active.push(evaluator);
				} catch (error) {
					// error-policy:J1 shouldRun failures join the evaluator
					// pipeline's explicit error collection.
					const messageText =
						error instanceof Error ? error.message : String(error);
					errors.push({ evaluatorName: evaluator.name, error: messageText });
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: messageText,
						},
						"Evaluator shouldRun failed",
					);
					this.runtime.reportError("EvaluatorService.shouldRun", error, {
						evaluator: evaluator.name,
					});
				}
			}),
		);
		return this.sortEvaluators(active);
	}

	private async composeEvaluatorState(
		message: Memory,
		state: State | undefined,
		active: RegisteredEvaluator[],
	): Promise<State> {
		const providerNames = Array.from(
			new Set(active.flatMap((evaluator) => evaluator.providers ?? [])),
		);
		const providerState =
			providerNames.length > 0
				? await this.runtime.composeState(message, providerNames, true, true)
				: EMPTY_STATE;
		return mergeStates(state, providerState);
	}

	private async collectPreparedEntries(
		active: RegisteredEvaluator[],
		message: Memory,
		state: State,
		options: EvaluatorRunOptions,
		errors: EvaluatorRunResult["errors"],
		progress?: Map<string, EvaluatorProgressSnapshot>,
	): Promise<PreparedEntry[]> {
		const preparedEntries: PreparedEntry[] = [];
		await Promise.all(
			active.map(async (evaluator) => {
				try {
					const snapshot = progress?.get(evaluator.name);
					const entryMessage = snapshot?.triggerMessage ?? message;
					const entryOptions = snapshot
						? {
								...options,
								extraction: extractionOptions(snapshot, this.runtime),
							}
						: options;
					const prepared = evaluator.prepare
						? await evaluator.prepare({
								runtime: this.runtime,
								message: entryMessage,
								state,
								options: entryOptions,
							})
						: undefined;
					const resolveOutputEnabled =
						snapshot?.pendingOutput === undefined &&
						evaluator.resolveOutput !== undefined &&
						(!evaluator.resolveOutputWhen ||
							evaluator.resolveOutputWhen({
								runtime: this.runtime,
								message: entryMessage,
								state,
								options: entryOptions,
								prepared,
							}));
					const resolvedOutput =
						resolveOutputEnabled && evaluator.resolveOutput
							? evaluator.resolveOutput({
									runtime: this.runtime,
									message: entryMessage,
									state,
									options: entryOptions,
									prepared,
								})
							: undefined;
					if (resolveOutputEnabled && resolvedOutput === undefined)
						throw new ElizaError("Runtime evaluator output is undefined", {
							code: "EVALUATOR_RESOLVED_OUTPUT_MISSING",
						});
					preparedEntries.push({
						evaluator,
						prepared,
						resolvedOutput,
						message: entryMessage,
						options: entryOptions,
						progress: snapshot,
					});
				} catch (error) {
					// error-policy:J1 Preparation failures join the evaluator
					// pipeline's explicit error collection.
					const messageText =
						error instanceof Error ? error.message : String(error);
					errors.push({ evaluatorName: evaluator.name, error: messageText });
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: messageText,
						},
						"Evaluator prepare failed",
					);
					this.runtime.reportError("EvaluatorService.prepare", error, {
						evaluator: evaluator.name,
					});
				}
			}),
		);
		return preparedEntries.sort(
			(a, b) =>
				(a.evaluator.priority ?? 100) - (b.evaluator.priority ?? 100) ||
				a.evaluator.name.localeCompare(b.evaluator.name),
		);
	}

	private async emitEvaluatorCompleted(
		evaluatorId: string,
		completed: boolean,
		error?: Error,
	): Promise<void> {
		await this.runtime
			.emitEvent(EventType.EVALUATOR_COMPLETED, {
				runtime: this.runtime,
				evaluatorId,
				evaluatorName: "post_turn",
				completed,
				...(error ? { error } : {}),
			})
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken event bus
			// must not abort evaluation, but a swallowed emit is invisible; surface it.
			.catch((err) =>
				this.runtime.reportError("EvaluatorService.emitEvent", err, {
					event: EventType.EVALUATOR_COMPLETED,
					evaluatorId,
				}),
			);
	}

	private async readEvaluatorOutput(params: {
		evaluatorId: string;
		rendered: RenderedEvaluatorPrompt;
		schema: JSONSchema;
	}): Promise<{
		output: Record<string, unknown> | null;
		error?: string;
		retryAt?: number;
	}> {
		const { evaluatorId, rendered, schema } = params;
		try {
			const raw = await generateEvaluationOutput({
				runtime: this.runtime,
				rendered,
				schema,
			});
			const output = coerceObjectOutput(raw);
			if (!output) {
				throw new ElizaError("Evaluator model returned non-object output", {
					code: "EVALUATOR_INVALID_OUTPUT",
					context: { evaluatorId },
				});
			}
			return { output };
		} catch (error) {
			// error-policy:J1 Evaluator execution returns an explicit failed
			// result and emits its completion failure.
			const retryAt = providerRateLimitRetryAt(error);
			const messageText =
				error instanceof Error ? error.message : String(error);
			await this.emitEvaluatorCompleted(
				evaluatorId,
				false,
				error instanceof Error ? error : new Error(messageText),
			);
			this.runtime.reportError("EvaluatorService.evaluate", error, {
				evaluatorId,
				// Optional reflection failure is recorded above; it must not create
				// owner recovery work after the chat/action already completed.
				diagnosticOnly: true,
			});
			return { output: null, error: messageText, retryAt };
		}
	}

	private async processPreparedEntries(params: {
		preparedEntries: PreparedEntry[];
		output: Record<string, unknown>;
		message: Memory;
		state: State;
		options: EvaluatorRunOptions;
		errors: EvaluatorRunResult["errors"];
	}): Promise<{
		processedEvaluators: string[];
		results: ActionResult[];
	}> {
		const { preparedEntries, output, state, errors } = params;
		const results: ActionResult[] = [];
		const processedEvaluators: string[] = [];
		for (const entry of preparedEntries) {
			const { evaluator, prepared } = entry;
			const rawSection =
				entry.progress?.pendingOutput !== undefined
					? entry.progress.pendingOutput
					: entry.resolvedOutput !== undefined
						? entry.resolvedOutput
						: output[evaluator.name];
			if (rawSection === undefined) {
				errors.push({
					evaluatorName: evaluator.name,
					error: "Evaluator output section is missing",
				});
				continue;
			}
			let parsed: unknown;
			try {
				parsed = evaluator.parse
					? evaluator.parse(rawSection, {
							outputSource:
								entry.progress?.pendingOutput !== undefined
									? "staged"
									: entry.resolvedOutput !== undefined
										? "resolved"
										: "model",
							runtime: this.runtime,
							message: entry.message,
							options: entry.options,
							state,
							prepared,
						})
					: rawSection;
			} catch (error) {
				// error-policy:J1 reject ungrounded model sections before durable staging or effects.
				this.runtime.reportError("EvaluatorService.parse", error, {
					evaluator: evaluator.name,
				});
				errors.push({
					evaluatorName: evaluator.name,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (parsed === null || parsed === undefined) {
				// The returned `errors` array is not read by every caller, so this
				// structured warn is the field-visible trace of a parse failure
				// (#11239/#11253). stringifyForPrompt (safe try/catch) — a raw
				// JSON.stringify throws on a circular/bigint section and would turn
				// one evaluator's parse failure into an abort of the whole run.
				this.runtime.logger.warn(
					{
						src: "service:evaluator",
						agentId: this.runtime.agentId,
						evaluator: evaluator.name,
						rawSectionPreview: truncateWellFormed(
							toWellFormedUnicode(stringifyForDiagnostics(rawSection)),
							500,
						),
					},
					"Evaluator output section did not validate",
				);
				errors.push({
					evaluatorName: evaluator.name,
					error: "Evaluator output section did not validate",
				});
				continue;
			}
			const errorsBefore = errors.length;
			try {
				if (entry.progress) {
					await stageEvaluatorOutput(
						this.runtime,
						entry.progress,
						rawSection as JsonValue,
						entry.inputBinding,
					);
				}
				await this.runEntryProcessors({
					evaluator,
					prepared,
					parsed: parsed as JsonValue,
					message: entry.message,
					state,
					options: entry.options,
					results,
					errors,
				});
				if (errors.length === errorsBefore) {
					if (entry.progress) {
						const progressState = evaluator.progressState?.({
							runtime: this.runtime,
							message: entry.message,
							state,
							options: entry.options,
							prepared,
							output: parsed,
							evaluatorName: evaluator.name,
						});
						await commitEvaluatorProgress(
							this.runtime,
							entry.progress,
							progressState,
						);
					}
					processedEvaluators.push(evaluator.name);
				}
			} catch (error) {
				// error-policy:J1 durable progress failure stays pending and is reported, never acknowledged.
				this.runtime.reportError("EvaluatorService.progress", error, {
					evaluator: evaluator.name,
				});
				errors.push({
					evaluatorName: evaluator.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { processedEvaluators, results };
	}

	private async runEntryProcessors(params: {
		evaluator: RegisteredEvaluator;
		prepared: unknown;
		parsed: JsonValue;
		message: Memory;
		state: State;
		options: EvaluatorRunOptions;
		results: ActionResult[];
		errors: EvaluatorRunResult["errors"];
	}): Promise<void> {
		const {
			evaluator,
			prepared,
			parsed,
			message,
			state,
			options,
			results,
			errors,
		} = params;
		const processors = (evaluator.processors ?? [])
			.slice()
			.sort(
				(a, b) =>
					(a.priority ?? 100) - (b.priority ?? 100) ||
					(a.name ?? "").localeCompare(b.name ?? ""),
			);
		for (const processor of processors) {
			try {
				const result = await processor.process({
					runtime: this.runtime,
					message,
					state,
					options,
					prepared,
					output: parsed,
					evaluatorName: evaluator.name,
				});
				if (result) {
					results.push(result);
					if (!result.success)
						throw new ElizaError(
							"Evaluator processor reported a failed effect",
							{
								code: "EVALUATOR_PROCESSOR_FAILED",
								context: {
									evaluator: evaluator.name,
									processor: processor.name,
								},
							},
						);
				}
			} catch (error) {
				// error-policy:J1 Processor failures join the evaluator
				// pipeline's explicit error collection.
				const messageText =
					error instanceof Error ? error.message : String(error);
				errors.push({
					evaluatorName: evaluator.name,
					processorName: processor.name,
					error: messageText,
				});
				this.runtime.logger.warn(
					{
						src: "service:evaluator",
						agentId: this.runtime.agentId,
						evaluator: evaluator.name,
						processor: processor.name,
						err: messageText,
					},
					"Evaluator processor failed",
				);
				this.runtime.reportError("EvaluatorService.processor", error, {
					evaluator: evaluator.name,
					processor: processor.name,
				});
			}
		}
	}

	/** Logs the skipped model call and settles the post_turn trajectory step as gated. */
	private recordInputBudgetSkip(budgeted: BudgetedEvaluatorPrompt): void {
		const details = {
			reason: POST_TURN_EVALUATOR_SKIP_REASON,
			estimatedPromptTokens: budgeted.estimatedPromptTokens,
			budgetTokens: budgeted.budgetTokens,
			omittedRows: budgeted.omittedRows,
		};
		this.runtime.logger.warn(
			{ src: "service:evaluator", agentId: this.runtime.agentId, ...details },
			POST_TURN_EVALUATOR_SKIP_ERROR,
		);
		const context = getTrajectoryContext();
		const trajectoryId = context?.trajectoryId?.trim();
		const stepId = context?.trajectoryStepId?.trim();
		if (!trajectoryId || !stepId) return;
		try {
			resolveTrajectoryLogger(this.runtime)?.completeStep?.(
				trajectoryId,
				stepId,
				{
					actionType: "evaluator",
					actionName: "post_turn",
					parameters: details,
					success: true,
					result: {
						success: true,
						data: { ...details, gated: true, llmCallSkipped: true },
					},
				},
			);
		} catch (error) {
			// error-policy:J7 trajectory settlement is diagnostic; the skip stands.
			this.runtime.reportError(
				"EvaluatorService.recordInputBudgetSkip",
				error,
				{
					trajectoryId,
					stepId,
					diagnosticOnly: true,
				},
			);
		}
	}

	private skippedResult(params?: {
		activeEvaluators?: string[];
		processedEvaluators?: string[];
		errors?: EvaluatorRunResult["errors"];
	}): EvaluatorRunResult {
		return {
			skipped: true,
			activeEvaluators: params?.activeEvaluators ?? [],
			processedEvaluators: params?.processedEvaluators ?? [],
			results: [],
			errors: params?.errors ?? [],
		};
	}

	private failedResult(params: {
		preparedEntries: PreparedEntry[];
		errors: EvaluatorRunResult["errors"];
		error: string;
		retryAt?: number;
	}): EvaluatorRunResult {
		return {
			skipped: false,
			activeEvaluators: params.preparedEntries.map(
				({ evaluator }) => evaluator.name,
			),
			processedEvaluators: [],
			results: [],
			errors: [
				...params.errors,
				{
					evaluatorName: "post_turn",
					error: params.error,
					retryAt: params.retryAt,
				},
			],
		};
	}

	async run(
		message: Memory,
		state?: State,
		options: EvaluatorRunOptions = {},
	): Promise<EvaluatorRunResult> {
		return this.runSelected(
			this.runtime.evaluators.slice(),
			message,
			state,
			options,
		);
	}

	private async runSelected(
		selected: RegisteredEvaluator[],
		message: Memory,
		state: State | undefined,
		options: EvaluatorRunOptions,
		background = false,
	): Promise<EvaluatorRunResult> {
		const candidates = this.sortEvaluators(selected);
		const incremental =
			options.phase === "post_turn"
				? candidates.filter((entry) =>
						typeof entry.incremental === "function"
							? entry.incremental(this.runtime)
							: entry.incremental === true,
					)
				: [];
		// A durable evidence contract takes precedence over a legacy input scope.
		const messageScoped = candidates.filter(
			(entry) =>
				entry.inputScope === "current_message" && !incremental.includes(entry),
		);
		if (messageScoped.length > 0) {
			const regular = candidates.filter(
				(entry) => !messageScoped.includes(entry),
			);
			const scopedResult = await this.runBatch(
				messageScoped,
				message,
				undefined,
				{ ...options, responses: [] },
				undefined,
				background,
				true,
			);
			if (regular.length === 0) return scopedResult;
			const regularResult = await this.runSelected(
				regular,
				message,
				state,
				options,
				background,
			);
			return {
				skipped: scopedResult.skipped && regularResult.skipped,
				hasMoreEvidence: regularResult.hasMoreEvidence,
				activeEvaluators: [
					...scopedResult.activeEvaluators,
					...regularResult.activeEvaluators,
				],
				processedEvaluators: [
					...scopedResult.processedEvaluators,
					...regularResult.processedEvaluators,
				],
				results: [...scopedResult.results, ...regularResult.results],
				errors: [...scopedResult.errors, ...regularResult.errors],
			};
		}
		if (incremental.length === 0)
			return this.runBatch(
				candidates,
				message,
				state,
				options,
				undefined,
				background,
			);

		const { progress, progressErrors } = await this.inRoom(
			message,
			background,
			async () => {
				const transcript = await this.runtime.getMemories({
					tableName: "messages",
					roomId: message.roomId,
					agentId: this.runtime.agentId,
					unique: false,
					orderDirection: "asc",
					includeEmbedding: false,
				});
				transcript.sort(
					(left, right) =>
						(left.createdAt ?? 0) - (right.createdAt ?? 0) ||
						String(left.id).localeCompare(String(right.id)),
				);
				const preparedSources = Promise.resolve().then(() =>
					prepareEvaluatorProgressForTranscript(
						this.runtime,
						message,
						transcript,
					),
				);
				const progress = new Map<string, EvaluatorProgressSnapshot>();
				const progressErrors: EvaluatorRunResult["errors"] = [];
				await Promise.all(
					incremental.map(async (evaluator) => {
						const reconcileEvidence = evaluator.reconcileEvidence;
						try {
							const prepareProgress = await preparedSources;
							const snapshots = await prepareProgress([evaluator.name], {
								...(background
									? { maxEvidenceBytes: this.evidenceBatchBytes() }
									: {}),
								...(reconcileEvidence
									? {
											reconcile: (reconciliation) =>
												reconcileEvidence({
													runtime: this.runtime,
													message,
													state,
													options,
													reconciliation,
												}),
										}
									: {}),
							});
							for (const [name, snapshot] of snapshots)
								progress.set(name, snapshot);
						} catch (error) {
							// error-policy:J1 one stale journal must not block independent extraction lanes.
							this.runtime.reportError(
								"EvaluatorService.prepareProgress",
								error,
								{
									evaluator: evaluator.name,
								},
							);
							progressErrors.push({
								evaluatorName: evaluator.name,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}),
				);
				return { progress, progressErrors };
			},
		);
		const pending = incremental.filter((entry) => {
			const snapshot = progress.get(entry.name);
			return (
				snapshot &&
				(snapshot.messages.length > 0 ||
					snapshot.removedMessageIds.length > 0 ||
					snapshot.pendingOutput !== undefined)
			);
		});
		const results = [
			await this.runBatch(
				pending,
				message,
				state,
				options,
				progress,
				background,
			),
		];
		const incrementalNames = new Set(incremental.map((entry) => entry.name));
		const legacy = candidates.filter(
			(entry) => !incrementalNames.has(entry.name),
		);
		if (legacy.length > 0)
			results.push(await this.runBatch(legacy, message, state, options));
		return {
			skipped: results.every((result) => result.skipped),
			hasMoreEvidence: results.some(
				(result) =>
					result.hasMoreEvidence ||
					result.processedEvaluators.some(
						(name) => (progress.get(name)?.remainingSourceCount ?? 0) > 0,
					),
			),
			activeEvaluators: results.flatMap((result) => result.activeEvaluators),
			processedEvaluators: results.flatMap(
				(result) => result.processedEvaluators,
			),
			results: results.flatMap((result) => result.results),
			errors: [
				...progressErrors,
				...results.flatMap((result) => result.errors),
			],
		};
	}

	private async runBatch(
		candidates: RegisteredEvaluator[],
		message: Memory,
		state: State | undefined,
		options: EvaluatorRunOptions,
		progress?: Map<string, EvaluatorProgressSnapshot>,
		background = false,
		currentMessageOnly = false,
	): Promise<EvaluatorRunResult> {
		setTrajectoryPurpose("evaluation");

		const preparation = await this.inRoom(message, background, async () => {
			const context: EvaluatorRunContext = {
				runtime: this.runtime,
				message,
				state,
				options,
			};

			if (candidates.length === 0) {
				return this.skippedResult();
			}

			const errors: EvaluatorRunResult["errors"] = [];
			const active = await this.collectActiveEvaluators(
				candidates,
				context,
				errors,
				progress,
			);
			if (active.length === 0) {
				return this.skippedResult({ errors });
			}

			const [composedState, legacyRoomTranscript] = await Promise.all([
				this.composeEvaluatorState(
					message,
					progress ? undefined : state,
					active,
				).then((composed) =>
					progress
						? {
								...composed,
								values: { ...state?.values, ...composed.values },
								data: {
									...state?.data,
									...composed.data,
									providers: composed.data.providers ?? {},
								},
							}
						: composed,
				),
				currentMessageOnly ||
				progress ||
				active.every((entry) => entry.resolveOutput !== undefined)
					? Promise.resolve(currentMessageOnly ? [] : null)
					: getRoomTranscript(this.runtime, message).catch((error: unknown) => {
							// error-policy:J7 the shared transcript is a dedupe of what each
							// evaluator reads for itself; its failure is reported and the
							// sections fall back to their own reads, which isolate per evaluator.
							this.runtime.reportError(
								"EvaluatorService.roomTranscript",
								error,
								{
									roomId: message.roomId,
								},
							);
							return null;
						}),
			]);
			let preparedEntries = await this.collectPreparedEntries(
				active,
				message,
				composedState,
				options,
				errors,
				progress,
			);
			let hasDeferredEvidence = false;
			if (background && progress) {
				const admission = selectSharedEvidencePages(
					preparedEntries,
					(entry) =>
						entry.progress?.pendingOutput !== undefined ||
						entry.resolvedOutput !== undefined
							? []
							: (entry.options.extraction?.messages ?? []),
					this.evidenceBatchBytes(),
				);
				preparedEntries = admission.selected;
				hasDeferredEvidence = admission.deferred.length > 0;
			}

			if (preparedEntries.length === 0) {
				return this.skippedResult({
					activeEvaluators: active.map((evaluator) => evaluator.name),
					errors,
				});
			}

			for (const entry of preparedEntries) {
				if (!entry.progress) continue;
				const binding = hashStableJson(
					entry.evaluator.prompt({
						runtime: this.runtime,
						message: entry.message,
						state: composedState,
						options: entry.options,
						prepared: entry.prepared,
					}),
				);
				if (entry.progress?.pendingOutput !== undefined) {
					entry.inputBinding = entry.progress.pendingInputBinding;
					// Staged reducers are replay-safe by stable identity. Their own partial
					// writes may have changed candidates; do not mistake that for fresh inference.
				} else entry.inputBinding = binding;
			}
			return {
				preparedEntries,
				composedState,
				errors,
				legacyRoomTranscript,
				hasDeferredEvidence,
			};
		});
		if (!("preparedEntries" in preparation)) return preparation;
		const {
			preparedEntries,
			composedState,
			errors,
			legacyRoomTranscript,
			hasDeferredEvidence,
		} = preparation;
		const freshEntries = preparedEntries.filter(
			(entry) =>
				entry.progress?.pendingOutput === undefined &&
				entry.resolvedOutput === undefined,
		);
		// Only sections requesting new model output contribute shared evidence.
		// Replay-only and failed preparations retain their own complete snapshots,
		// but must not resend that history to an unrelated fresh extractor.
		const roomTranscript = progress
			? Array.from(
					new Map(
						freshEntries.flatMap((entry) =>
							(entry.options.extraction?.messages ?? []).map(
								(record) => [record.id, record] as const,
							),
						),
					).values(),
				).sort(
					(left, right) =>
						(left.createdAt ?? 0) - (right.createdAt ?? 0) ||
						String(left.id).localeCompare(String(right.id)),
				)
			: legacyRoomTranscript;
		const schema = buildMergedSchema(freshEntries);
		if (background && freshEntries.length)
			schema.properties = {
				...schema.properties,
				restoreContextBefore: {
					type: "string",
					description:
						"Request the immediately preceding complete historical evidence page using a visible source ID. Omit when current evidence suffices. All evaluator effects are deferred while requesting context.",
				},
			};
		const references: Memory[] = [];
		const requestedCursors = new Set<string>();
		const restoredRanges: Array<{
			before: string;
			firstId: string | undefined;
			hasEarlier: boolean;
		}> = [];
		const hasEarlier = freshEntries.some(
			(entry) => entry.progress?.hasEarlierEvidence,
		);
		const referenceContext = () =>
			background
				? `Historical context is available through explicit ordered pagination. Selected evidence is one complete pending page per evaluator; later pages remain durable work: ${JSON.stringify(Object.fromEntries(freshEntries.map((entry) => [entry.evaluator.name, entry.progress?.remainingSourceCount ?? 0])))}. Earlier history available: ${hasEarlier}. If a pronoun, correction, or claim needs earlier evidence, request restoreContextBefore using a visible message ID immediately after the missing historical range; all output sections will be ignored until those complete records are restored. Never guess missing context or treat reference records as new personal statements. Restored ranges: ${JSON.stringify(restoredRanges)}.
Historical reference records (context only; do not cite as newly selected evidence):
${JSON.stringify(references.map(evaluatorEvidenceRecord))}`
				: "";
		const promptInput = {
			runtime: this.runtime,
			message,
			state: composedState,
			roomTranscript,
			referenceContext: referenceContext(),
			active: freshEntries,
			options,
			schema,
		};
		// The merged prompt is estimated before dispatch: a complete-history batch
		// over budget drops its oldest shared conversation rows, incremental
		// evidence never trims, and a prompt still over budget skips the call.
		const budgeted =
			freshEntries.length > 0
				? applyPostTurnInputBudget({
						...promptInput,
						rendered: buildPrompt(promptInput),
						trimmable: progress === undefined,
					})
				: null;
		if (budgeted?.skip) {
			this.recordInputBudgetSkip(budgeted);
			if (
				preparedEntries.every(
					(entry) =>
						entry.progress?.pendingOutput === undefined &&
						entry.resolvedOutput === undefined,
				)
			) {
				return this.skippedResult({
					activeEvaluators: preparedEntries.map(
						({ evaluator }) => evaluator.name,
					),
					errors,
				});
			}
		}
		// The (possibly trimmed) input the dispatched prompt renders from; the
		// JSON-object and plain fallbacks re-render it with the schema spelled out.
		let dispatchInput = budgeted?.promptInput ?? promptInput;
		let rendered = budgeted && !budgeted.skip ? budgeted.rendered : null;

		const evaluatorId =
			uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
		await this.runtime
			.emitEvent(EventType.EVALUATOR_STARTED, {
				runtime: this.runtime,
				evaluatorId,
				evaluatorName: "post_turn",
				startTime: Date.now(),
			})
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken event bus
			// must not abort evaluation, but a swallowed emit is invisible; surface it.
			.catch((err) =>
				this.runtime.reportError("EvaluatorService.emitEvent", err, {
					event: EventType.EVALUATOR_STARTED,
					evaluatorId,
				}),
			);

		const readOutput = (prompt: RenderedEvaluatorPrompt) =>
			this.readEvaluatorOutput({ evaluatorId, rendered: prompt, schema });
		let { output, error, retryAt } = budgeted?.skip
			? {
					output: null,
					error: POST_TURN_EVALUATOR_SKIP_ERROR,
					retryAt: undefined,
				}
			: rendered
				? await readOutput(rendered)
				: { output: {}, error: undefined, retryAt: undefined };

		while (
			background &&
			output &&
			Object.hasOwn(output, "restoreContextBefore")
		) {
			const cursor = output.restoreContextBefore;
			if (cursor === "" || cursor === null) {
				delete output.restoreContextBefore;
				break;
			}
			const visible = [...references, ...(roomTranscript ?? [])];
			if (
				typeof cursor !== "string" ||
				!visible.some((row) => row.id === cursor) ||
				requestedCursors.has(cursor)
			)
				throw new ElizaError(
					"Evaluator requested an invalid or exhausted reference cursor",
					{ code: "EVALUATOR_REFERENCE_CURSOR_INVALID" },
				);
			const page = await this.inRoom(message, background, async () => {
				const complete = canonicalEvaluatorMessages(
					await this.runtime.getMemories({
						tableName: "messages",
						roomId: message.roomId,
						agentId: this.runtime.agentId,
						unique: false,
						includeEmbedding: false,
						orderDirection: "asc",
					}),
					this.runtime.agentId,
				);
				const page = previousEvidencePage(
					complete,
					cursor,
					this.evidenceBatchBytes(),
				);
				if (!page.messages.length)
					throw new ElizaError(
						"No earlier evidence is available for this cursor",
						{ code: "EVALUATOR_REFERENCE_CURSOR_INVALID" },
					);
				const referenceBytes = new TextEncoder().encode(
					JSON.stringify(
						[...page.messages, ...references].map(evaluatorEvidenceRecord),
					),
				).byteLength;
				if (referenceBytes > this.evidenceBatchBytes() * 4)
					throw new ElizaError(
						"Requested complete reference context exceeds the explicit restoration budget",
						{
							code: "EVALUATOR_REFERENCE_BUDGET_EXCEEDED",
							context: {
								referenceBytes,
								budget: this.evidenceBatchBytes() * 4,
							},
						},
					);
				for (const entry of freshEntries)
					if (entry.progress)
						bindEvaluatorReferenceEvidence(
							this.runtime,
							entry.progress,
							page.messages,
						);
				return page;
			});
			requestedCursors.add(cursor);
			restoredRanges.push({
				before: cursor,
				firstId: page.messages[0]?.id,
				hasEarlier: page.hasEarlier,
			});
			const selectedIds = new Set((roomTranscript ?? []).map((row) => row.id));
			const union = new Map(
				[...page.messages, ...references]
					.filter((row) => !selectedIds.has(row.id))
					.map((row) => [row.id, row]),
			);
			references.splice(
				0,
				references.length,
				...[...union.values()].sort(
					(left, right) =>
						(left.createdAt ?? 0) - (right.createdAt ?? 0) ||
						String(left.id).localeCompare(String(right.id)),
				),
			);
			dispatchInput = {
				...dispatchInput,
				referenceContext: referenceContext(),
			};
			rendered = buildPrompt(dispatchInput);
			({ output, error, retryAt } = await readOutput(rendered));
		}
		if (
			!output &&
			preparedEntries.every(
				(entry) =>
					entry.progress?.pendingOutput === undefined &&
					entry.resolvedOutput === undefined,
			)
		) {
			return this.failedResult({
				preparedEntries,
				errors,
				error: error ?? "Evaluator model returned no output",
				retryAt,
			});
		}
		if (!output)
			errors.push({
				evaluatorName: "post_turn",
				error: error ?? "Evaluator model returned no output",
				retryAt,
			});

		const { processedEvaluators, results } = await this.inRoom(
			message,
			background,
			async () => {
				if (background) {
					// Domain candidates may change while inference releases the room. Rebuild
					// them and reject stale candidate bindings before any stage or effect.
					const currentState = await this.composeEvaluatorState(
						message,
						state,
						preparedEntries.map((entry) => entry.evaluator),
					);
					for (const entry of preparedEntries) {
						const context = {
							runtime: this.runtime,
							message: entry.message,
							// Reflection caches are keyed by the evidence array. A fresh array
							// keeps the same source records while forcing candidate reads.
							options: {
								...entry.options,
								...(entry.options.extraction
									? {
											extraction: {
												...entry.options.extraction,
												messages: [...entry.options.extraction.messages],
											},
										}
									: {}),
							},
							state: currentState,
						};
						const prepared = entry.evaluator.prepare
							? await entry.evaluator.prepare(context)
							: undefined;
						if (
							entry.progress?.pendingOutput === undefined &&
							hashStableJson(
								entry.evaluator.prompt({ ...context, prepared }),
							) !== entry.inputBinding
						)
							throw new ElizaError(
								"Memory candidates changed during background inference; output was not applied",
								{ code: "EVALUATOR_CANDIDATES_CHANGED", severity: "ephemeral" },
							);
						entry.prepared = prepared;
						entry.options = context.options;
					}
				}
				return this.processPreparedEntries({
					preparedEntries: output
						? preparedEntries
						: preparedEntries.filter(
								(entry) =>
									entry.progress?.pendingOutput !== undefined ||
									entry.resolvedOutput !== undefined,
							),
					output: output ?? {},
					message,
					state: composedState,
					options,
					errors,
				});
			},
		);
		await this.emitEvaluatorCompleted(evaluatorId, errors.length === 0);

		return {
			skipped: false,
			hasMoreEvidence: hasDeferredEvidence,
			activeEvaluators: preparedEntries.map(({ evaluator }) => evaluator.name),
			processedEvaluators,
			results,
			errors,
		};
	}
}

export async function runPostTurnEvaluators(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options: EvaluatorRunOptions = {},
): Promise<EvaluatorRunResult | null> {
	// Realtime voice and mobile local inference both require the room to admit the
	// next utterance immediately after the visible reply. Post-turn reflection is
	// optional model work, but the host deliberately drains room-state tasks before
	// releasing that room. Running reflection here therefore serializes the next
	// utterance behind another generation; a malformed provider response can keep
	// the room occupied until the runtime watchdog fires. Voice still runs the
	// complete response/action pipeline above, including ALWAYS_AFTER actions; only
	// this post-delivery reflection call is skipped.
	if (
		isMobilePlatform() ||
		message.content.channelType === ChannelType.VOICE_DM ||
		message.content.channelType === ChannelType.VOICE_GROUP
	) {
		return null;
	}
	try {
		const service = (await runtime.getServiceLoadPromise(
			EvaluatorService.serviceType,
		)) as EvaluatorService;
		return await service.enqueue(message, state, {
			...options,
			phase: options.phase ?? "post_turn",
		});
	} catch (error) {
		// error-policy:J4 post-turn evaluation is optional, but initialization
		// failure is surfaced to the agent before evaluation becomes unavailable.
		runtime.reportError("EvaluatorService.postTurn", error, {
			agentId: runtime.agentId,
		});
		return null;
	}
}
