/**
 * The long-term-memory evaluator extracts every high-confidence, durable fact
 * about the user from the complete retained conversation. Conversation
 * summaries are deliberately absent: retained dialogue stays canonical instead
 * of being replaced by a lossy rolling projection.
 */

import { ElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import { renderStoredEnvelopesForPrompt } from "../../../security/external-content";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import { assertExtractionSourcesUnchanged } from "../../../services/evaluator-progress.ts";
import { recentMessagesSection } from "../../../services/evaluator-transcript.ts";
import type {
	Evaluator,
	EvaluatorEvidenceReconciliation,
	EvaluatorPromptContext,
	EvaluatorRunContext,
	EvaluatorRunOptions,
	IAgentRuntime,
	JSONSchema,
	Memory,
	RegisteredEvaluator,
	UUID,
} from "../../../types/index.ts";
import {
	hasNoPersonalExtractionSources,
	isProtectedMemoryEvidence,
} from "../../../utils/extraction-evidence.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import { isObjectRecord as isRecord } from "../../../utils/type-guards.ts";
import { stringToUuid } from "../../../utils.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";

function createdAtSortKey(memory: Memory): number {
	const value = memory.createdAt;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compareMemoryByCreatedAtAsc(a: Memory, b: Memory): number {
	const aSafe = createdAtSortKey(a);
	const bSafe = createdAtSortKey(b);
	if (aSafe !== bSafe) return aSafe - bSafe;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

import { LongTermMemoryCategory, type MemoryExtraction } from "../types.ts";

const MEMORY_CATEGORIES = Object.values(LongTermMemoryCategory);

const longTermMemorySchema: JSONSchema = {
	type: "object",
	properties: {
		memories: {
			type: "array",
			items: {
				type: "object",
				properties: {
					category: { type: "string", enum: MEMORY_CATEGORIES },
					content: { type: "string" },
					confidence: { type: "number" },
					sourceMessageIds: { type: "array", items: { type: "string" } },
				},
				required: ["category", "content", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["memories"],
	additionalProperties: false,
};

export interface LongTermMemoryOutput {
	memories: MemoryExtraction[];
}

export interface LongTermMemoryPrepared {
	memoryService: MemoryService;
	recentMessages: Memory[];
	existingMemories: string;
	currentMessageCount: number;
}

async function shouldExtractLongTerm(
	runtime: IAgentRuntime,
	message: Memory,
	memoryService: MemoryService,
): Promise<boolean> {
	if (!message.entityId || message.entityId === runtime.agentId) return false;
	const config = memoryService.getConfig();
	if (!config.longTermExtractionEnabled) return false;
	const currentMessageCount = await runtime.countMemories({
		roomIds: [message.roomId],
		unique: false,
		tableName: "messages",
	});
	return memoryService.shouldRunExtraction(
		message.entityId,
		message.roomId,
		currentMessageCount,
	);
}

function formatMessages(runtime: IAgentRuntime, msgs: Memory[]): string {
	return msgs
		.map((msg) => {
			const sender =
				msg.entityId === runtime.agentId
					? (runtime.character.name ?? "Agent")
					: msg.content.senderName || msg.entityId || "User";
			return `${sender}: ${
				msg.content.text
					? renderStoredEnvelopesForPrompt(msg.content.text)
					: "[non-text message]"
			}`;
		})
		.join("\n");
}

function assertPersonalMemorySources(
	output: LongTermMemoryOutput,
	message: Memory,
	evidence: EvaluatorRunOptions["extraction"],
	minConfidence: number,
): void {
	if (!evidence) return;
	assertExtractionSourcesUnchanged(evidence);
	const sourceMessages = new Map(
		evidence.messages.map((record) => [record.id, record]),
	);
	for (const extraction of output.memories) {
		if (extraction.confidence < minConfidence) continue;
		if (
			!extraction.sourceMessageIds?.length ||
			extraction.sourceMessageIds.some(
				(id) =>
					!Object.hasOwn(evidence.sourceRevisions, id) ||
					sourceMessages.get(id)?.entityId !== message.entityId,
			)
		) {
			throw new ElizaError(
				"Long-term memory requires evidence authored by the target user",
				{ code: "MEMORY_EXTRACTION_SOURCE_INVALID" },
			);
		}
	}
}

function parseLongTermOutput(
	output: unknown,
	context?: EvaluatorPromptContext<LongTermMemoryPrepared>,
): LongTermMemoryOutput | null {
	if (!isRecord(output) || !Array.isArray(output.memories)) return null;
	const memories: MemoryExtraction[] = [];
	for (const entry of output.memories) {
		if (!isRecord(entry)) continue;
		const category =
			typeof entry.category === "string"
				? (entry.category.trim().toLowerCase() as LongTermMemoryCategory)
				: null;
		if (!category || !MEMORY_CATEGORIES.some((item) => item === category)) {
			continue;
		}
		const content =
			typeof entry.content === "string" ? entry.content.trim() : "";
		const confidence =
			typeof entry.confidence === "number" ? entry.confidence : Number.NaN;
		if (!content || Number.isNaN(confidence)) continue;
		memories.push({
			category,
			content,
			confidence,
			...(Array.isArray(entry.sourceMessageIds) &&
			entry.sourceMessageIds.every((id) => typeof id === "string")
				? { sourceMessageIds: entry.sourceMessageIds as UUID[] }
				: {}),
		});
	}
	const parsed = { memories };
	if (context?.options.extraction) {
		assertPersonalMemorySources(
			parsed,
			context.message,
			context.options.extraction,
			Math.max(
				context.prepared.memoryService.getConfig().longTermConfidenceThreshold,
				0.85,
			),
		);
	}
	return parsed;
}

async function prepareLongTermMemory(
	runtime: IAgentRuntime,
	message: Memory,
	extraction: EvaluatorRunOptions["extraction"],
): Promise<LongTermMemoryPrepared> {
	const memoryService = runtime.getService("memory") as MemoryService | null;
	if (!memoryService) throw new Error("MemoryService not found");
	if (extraction) await memoryService.ensureIncrementalExtractionSupported();
	const currentMessageCount =
		extraction?.messages.length ??
		(await runtime.countMemories({
			roomIds: [message.roomId],
			unique: false,
			tableName: "messages",
		}));
	const [recentRaw, existingLongTerm] = await Promise.all([
		extraction?.messages ??
			runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				limit: Math.max(1, currentMessageCount),
				unique: false,
			}),
		message.entityId
			? memoryService.getLongTermMemories(message.entityId)
			: Promise.resolve([]),
	]);
	const existingMemories =
		existingLongTerm.length > 0
			? existingLongTerm
					.map(
						(memory) =>
							`[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
					)
					.join("\n")
			: "None yet";
	return {
		memoryService,
		recentMessages: recentRaw
			.filter((memory) => !isSyntheticConversationArtifactMemory(memory))
			.sort(compareMemoryByCreatedAtAsc),
		existingMemories,
		currentMessageCount,
	};
}

async function reconcileLongTermEvidence({
	runtime,
	message,
	reconciliation,
}: EvaluatorRunContext & {
	reconciliation: EvaluatorEvidenceReconciliation;
}): Promise<{ reprocessSourceIds: string[] }> {
	const service = runtime.getService("memory") as MemoryService | null;
	if (!service)
		throw new ElizaError("Memory service unavailable during reconciliation", {
			code: "EVALUATOR_RECONCILIATION_UNAVAILABLE",
		});
	const reprocess = new Set<string>();
	for (const memory of await service.getLongTermMemories(
		message.entityId,
		undefined,
		undefined,
		{ includeInactive: true },
	)) {
		if (
			memory.agentId !== runtime.agentId ||
			memory.metadata?.roomId !== message.roomId ||
			memory.source === "MEMORY" ||
			isProtectedMemoryEvidence(memory)
		)
			continue;
		const revisions = isRecord(memory.metadata?.sourceMessageRevisions)
			? memory.metadata.sourceMessageRevisions
			: {};
		const changed = Object.keys(revisions).filter(
			(id) =>
				reconciliation.changedMessageIds.includes(id) ||
				reconciliation.removedMessageIds.includes(id),
		);
		const pending =
			reconciliation.pendingEvidenceId !== undefined &&
			memory.metadata?.extractionEvidenceId ===
				reconciliation.pendingEvidenceId;
		if (!pending && !changed.length) continue;
		for (const id of Object.keys(revisions))
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		if (memory.metadata?.extractionStatus === "source_invalidated") continue;
		await service.updateLongTermMemory(memory.id, memory.entityId, {
			metadata: {
				...memory.metadata,
				extractionStatus: "source_invalidated",
				extractionReconciliationId: reconciliation.id,
				extractionChangedSourceIds: changed,
			},
		});
	}
	return { reprocessSourceIds: [...reprocess] };
}

export const __testCompareMemoryByCreatedAtAsc = compareMemoryByCreatedAtAsc;

export const longTermMemoryEvaluator: Evaluator<
	LongTermMemoryOutput,
	LongTermMemoryPrepared
> = {
	name: "longTermMemory",
	resolveOutputWhen: hasNoPersonalExtractionSources,
	resolveOutput: () => ({ memories: [] }),
	reconcileEvidence: reconcileLongTermEvidence,
	background: true,
	incremental(runtime) {
		const service = runtime.getService("memory") as MemoryService | null;
		return service?.supportsIncrementalExtraction === true;
	},
	description:
		"Extracts high-confidence persistent memories about the user from conversation context.",
	priority: EvaluatorPriority.MEMORY_LONG_TERM,
	schema: longTermMemorySchema,
	async shouldRun({ runtime, message, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		if (!message.content.text || !message.roomId || !message.entityId) {
			return false;
		}
		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) return false;
		if (options.extraction) {
			const config = memoryService.getConfig();
			if (
				!config.longTermExtractionEnabled ||
				message.entityId === runtime.agentId
			)
				return false;
			await memoryService.ensureIncrementalExtractionSupported();
			const count = await runtime.countMemories({
				roomIds: [message.roomId],
				unique: false,
				tableName: "messages",
			});
			// Skipped batches remain pending in the journal. Its delta, not an
			// old total-count watermark, determines when another interval is due.
			return (
				count >= config.longTermExtractionThreshold &&
				(options.extraction.isBackfill ||
					(options.extraction.remainingSourceCount ?? 0) > 0 ||
					options.extraction.messages.length >=
						config.longTermExtractionInterval)
			);
		}
		return shouldExtractLongTerm(runtime, message, memoryService);
	},
	async prepare({ runtime, message, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		return prepareLongTermMemory(runtime, message, options.extraction);
	},
	prompt({ runtime, message, prepared, shared, options }) {
		// The shared context renders the room conversation once; this section
		// embeds its own copy only when that rendering is unavailable this turn.
		const recentMessages = shared?.roomTranscriptRendered
			? recentMessagesSection(shared, prepared.recentMessages)
			: options?.extraction
				? `Recent messages:\n${prepared.recentMessages.map((record) => `[${record.id}] ${formatMessages(runtime, [record])}`).join("\n")}`
				: `Recent messages:\n${formatMessages(runtime, prepared.recentMessages)}`;
		return `Extract every high-confidence persistent user memory. Categories: episodic, semantic, procedural. Keep only specific, concrete, user-unique info likely useful in 3+ months, confidence >=0.85, not already present. Skip one-time tasks, current bugs, exploratory questions, temporary context, pleasantries, generic patterns, and synthetic historical artifacts.
${options?.extraction ? `\nTarget user entity ID: ${message.entityId}. Extract personal memories only about this target. Cite sourceMessageIds for every memory, using only selected evidence messages authored by that exact entity. Other participants and agent responses are reference context, not evidence about this user. No grounded target-authored citation means no memory. Do not invent IDs. Do not add a conflicting replacement for an existing memory; corrections require review.\n` : "\nInclude sourceMessageIds when visible; use [] when unavailable.\n"}

Existing long-term memories:
${prepared.existingMemories}

${recentMessages}`;
	},
	parse: parseLongTermOutput,
	processors: [
		{
			name: "storeLongTermMemory",
			async process({ runtime, message, prepared, output, options }) {
				assertExtractionSourcesUnchanged(options.extraction);
				if (options.extraction) {
					await prepared.memoryService.ensureIncrementalExtractionSupported();
				}
				const config = prepared.memoryService.getConfig();
				const minConfidence = Math.max(
					config.longTermConfidenceThreshold,
					0.85,
				);
				const extractedAt = new Date().toISOString();
				let longTermStored = 0;
				const evidence = options.extraction;
				assertPersonalMemorySources(output, message, evidence, minConfidence);
				for (const [index, extraction] of output.memories.entries()) {
					if (extraction.confidence < minConfidence) continue;
					await prepared.memoryService.storeLongTermMemory({
						...(options.extraction
							? {
									id: stringToUuid(
										`${runtime.agentId}:longTermMemory:${options.extraction.evidenceId}:${index}`,
									),
								}
							: {}),
						agentId: runtime.agentId,
						entityId: message.entityId,
						category: extraction.category,
						content: extraction.content,
						confidence: extraction.confidence,
						source: "conversation",
						metadata: {
							roomId: message.roomId,
							extractedAt,
							...(evidence
								? {
										extractionEvidenceId: evidence.evidenceId,
										sourceMessageRevisions: {
											...evidence.referenceRevisions,
											...Object.fromEntries(
												(extraction.sourceMessageIds ?? []).map((id) => [
													id,
													evidence.sourceRevisions[id],
												]),
											),
										},
									}
								: {}),
						},
					});
					longTermStored += 1;
				}
				if (!options.extraction) {
					await prepared.memoryService.setLastExtractionCheckpoint(
						message.entityId,
						message.roomId,
						prepared.currentMessageCount,
					);
				}
				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "LONG_TERM_MEMORY_EXTRACTION",
					purpose: "evaluate",
					data: {
						extractedMemoryCount: output.memories.length,
						storedMemoryCount: longTermStored,
					},
					query: {
						entityId: message.entityId,
						roomId: message.roomId,
					},
				});
				logger.debug(
					{ src: "evaluator:memory", longTermStored },
					"Stored long-term memories from evaluator service",
				);
				return {
					success: true,
					values: { longTermStored },
				};
			},
		},
	],
};

export const memoryItems: RegisteredEvaluator[] = [longTermMemoryEvaluator];
