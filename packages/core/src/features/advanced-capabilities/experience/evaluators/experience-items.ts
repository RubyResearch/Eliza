/**
 * The `experiencePatterns` evaluator for the experience capability: after a turn,
 * extracts reusable operational lessons (successes, failures, corrections,
 * discoveries, validations) from the recent conversation and records them through
 * the EXPERIENCE service. Gating is signal-driven — an explicit "remember this" or
 * a scored signal (correction / failure / validated-outcome / …) runs it subject to
 * a per-room min-gap counter, otherwise it falls back to a fixed message interval
 * and only runs if the recent window still carries a signal.
 *
 * Conversation text is secret-redacted and synthetic summaries filtered before it
 * reaches the model; extracted learnings are deduped (lexically normalized) against
 * existing similar experiences and against each other, and dropped below the
 * auto-record confidence threshold.
 */

import { ElizaError } from "../../../../errors.ts";
import { logger } from "../../../../logger.ts";
import { renderStoredEnvelopesForPrompt } from "../../../../security/external-content";
import { EvaluatorPriority } from "../../../../services/evaluator-priorities.ts";
import { assertExtractionSourcesUnchanged } from "../../../../services/evaluator-progress.ts";
import {
	getRoomTranscript,
	recentMessagesSection,
} from "../../../../services/evaluator-transcript.ts";
import type {
	Evaluator,
	EvaluatorEvidenceReconciliation,
	EvaluatorRunContext,
	IAgentRuntime,
	JSONSchema,
	Memory,
	UUID,
} from "../../../../types/index.ts";
import { isSyntheticConversationArtifactMemory } from "../../../../utils/synthetic-conversation-artifact.ts";
import { isObjectRecord as isRecord } from "../../../../utils/type-guards.ts";
import { toWellFormedUnicode } from "../../../../utils/well-formed.ts";
import { stringToUuid } from "../../../../utils.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";

const EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL = 25;
const EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP = 4;
const EXISTING_EXPERIENCE_LIMIT = 5;
const DEFAULT_AUTO_RECORD_THRESHOLD = 0.6;

const experienceSchema: JSONSchema = {
	type: "object",
	properties: {
		experiences: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					type: {
						type: "string",
						enum: [
							"success",
							"failure",
							"discovery",
							"correction",
							"learning",
							"hypothesis",
							"validation",
							"warning",
						],
					},
					outcome: {
						type: "string",
						enum: ["positive", "negative", "neutral", "mixed"],
					},
					domain: { type: "string" },
					learning: { type: "string" },
					context: { type: "string" },
					confidence: { type: "number" },
					importance: { type: "number" },
					reasoning: { type: "string" },
				},
				required: [
					"type",
					"outcome",
					"domain",
					"learning",
					"context",
					"confidence",
					"importance",
					"reasoning",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["experiences"],
	additionalProperties: false,
};

interface ExtractedExperience {
	type: ExperienceType;
	outcome: OutcomeType;
	domain: string;
	learning: string;
	context: string;
	confidence: number;
	importance: number;
	reasoning: string;
}

interface ExperienceOutput {
	experiences: ExtractedExperience[];
}

interface ExperiencePrepared {
	experienceService: ExperienceService;
	recentMessages: Memory[];
	conversationContext: string;
	/** Complete experience-only bodies absent from the shared dialogue transcript. */
	unsharedConversationContext: string;
	signalSummary: string;
	existingExperiences: Experience[];
	provenance: Pick<
		Experience,
		| "sourceMessageIds"
		| "sourceRoomId"
		| "sourceTriggerMessageId"
		| "sourceTrajectoryId"
		| "sourceTrajectoryStepId"
		| "associatedEntityIds"
	>;
}

function actionResultsFromState(state: unknown): unknown[] {
	if (!isRecord(state)) return [];
	const data = isRecord(state.data) ? state.data : {};
	const actionResults = data.actionResults;
	return Array.isArray(actionResults) ? actionResults : [];
}

function getNumberSetting(
	runtime: IAgentRuntime,
	key: string,
	fallback: number,
): number {
	const value = runtime.getSetting(key);
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

function parseExperienceType(value: unknown): ExperienceType | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	for (const candidate of Object.values(ExperienceType)) {
		if (normalized === candidate) return candidate;
	}
	return null;
}

function parseOutcomeType(value: unknown): OutcomeType | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	for (const candidate of Object.values(OutcomeType)) {
		if (normalized === candidate) return candidate;
	}
	return null;
}

function parseExperienceOutput(output: unknown): ExperienceOutput | null {
	if (!isRecord(output) || !Array.isArray(output.experiences)) return null;
	const experiences: ExtractedExperience[] = [];
	for (const entry of output.experiences) {
		if (!isRecord(entry)) continue;
		const type = parseExperienceType(entry.type);
		const outcome = parseOutcomeType(entry.outcome);
		const domain = typeof entry.domain === "string" ? entry.domain.trim() : "";
		const learning =
			typeof entry.learning === "string" ? entry.learning.trim() : "";
		const context =
			typeof entry.context === "string" ? entry.context.trim() : "";
		const confidence =
			typeof entry.confidence === "number" ? entry.confidence : Number.NaN;
		const importance =
			typeof entry.importance === "number" ? entry.importance : 0.8;
		const reasoning =
			typeof entry.reasoning === "string" ? entry.reasoning.trim() : "";
		if (!type || !outcome || !domain || !learning || !context) continue;
		if (Number.isNaN(confidence)) continue;
		experiences.push({
			type,
			outcome,
			domain,
			learning,
			context,
			confidence,
			importance,
			reasoning,
		});
	}
	return { experiences };
}

function formatExistingExperiences(experiences: Experience[]): string {
	if (experiences.length === 0) return "None";
	return experiences
		.map(
			(experience, index) =>
				`${index + 1}. (${experience.type}/${experience.domain}, confidence ${experience.confidence}) When ${experience.context}, learned: ${experience.learning}`,
		)
		.join("\n");
}

function buildExperienceProvenance(
	triggerMessage: Memory,
	recentMessages: Memory[],
): ExperiencePrepared["provenance"] {
	const sourceMessageIds = recentMessages
		.map((memory) => memory.id)
		.filter((id): id is UUID => typeof id === "string" && id.length > 0);
	const associatedEntityIds = Array.from(
		new Set(
			recentMessages
				.map((memory) => memory.entityId)
				.filter(
					(entityId): entityId is UUID =>
						typeof entityId === "string" && entityId.length > 0,
				),
		),
	);
	const metadata = isRecord(triggerMessage.metadata)
		? triggerMessage.metadata
		: {};
	return {
		sourceMessageIds,
		sourceRoomId: triggerMessage.roomId,
		sourceTriggerMessageId: triggerMessage.id as UUID | undefined,
		sourceTrajectoryId:
			typeof metadata.trajectoryId === "string"
				? metadata.trajectoryId
				: undefined,
		sourceTrajectoryStepId:
			typeof metadata.trajectoryStepId === "string"
				? metadata.trajectoryStepId
				: undefined,
		associatedEntityIds,
	};
}

function normalizeStoredText(runtime: IAgentRuntime, text: string): string {
	return toWellFormedUnicode(runtime.redactSecrets(text));
}

function normalizeLearningKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isSyntheticMemory(memory: Memory): boolean {
	return isSyntheticConversationArtifactMemory(memory);
}

function getMessageText(memory: Memory): string {
	return typeof memory.content.text === "string" ? memory.content.text : "";
}

function hasExplicitExperienceRequest(text: string): boolean {
	return /\b(?:remember|store|learn|note)\s+(?:this|that|this lesson|this pattern|for next time|going forward)\b/i.test(
		text,
	);
}

/** Outcome metadata alone is not a lesson. Inspect values for failure or
 * learning evidence without treating JSON keys such as success/error as prose. */
function hasActionExperienceSignal(result: unknown): boolean {
	const pending = [result];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value === "string") {
			if (
				/\b(?:error|failed|failure|exception|timeout|blocked|fixed|verified|validated|root cause|lesson learned|workaround|regression|postmortem|correction|discovered|unexpected)\b/i.test(
					value,
				)
			)
				return true;
			continue;
		}
		if (value instanceof Error) return true;
		if (typeof value !== "object" || value === null || seen.has(value))
			continue;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const entry of value) pending.push(entry);
		} else if (isRecord(value)) {
			if (
				value.success === false ||
				(typeof value.error === "string" && value.error.trim() !== "")
			)
				return true;
			for (const entry of Object.values(value)) pending.push(entry);
		}
	}
	return false;
}

function scoreExperienceSignals(input: {
	latestText: string;
	responseTexts?: string[];
	actionResults?: unknown[];
	recentTexts?: string[];
}): { score: number; reasons: string[] } {
	const reasons = new Set<string>();
	const combinedText = [
		input.latestText,
		...(input.responseTexts ?? []),
		...(input.recentTexts ?? []),
	]
		.map((text) => text.toLowerCase())
		.join("\n");

	if (hasExplicitExperienceRequest(input.latestText)) {
		reasons.add("explicit learning request");
	}
	if (
		/\b(?:actually|correction|correcting|i was wrong|you were wrong|mistake|incorrect|misread|misunderstood)\b/.test(
			combinedText,
		)
	) {
		reasons.add("correction");
	}
	if (
		/\b(?:root cause|lesson learned|learned that|next time|from now on|avoid|workaround|regression|postmortem)\b/.test(
			combinedText,
		)
	) {
		reasons.add("reusable lesson");
	}
	if (
		/\b(?:failed|failure|error|exception|timeout|blocked|stuck|bug|broke|broken|invalid|flaky)\b/.test(
			combinedText,
		)
	) {
		reasons.add("failure signal");
	}
	if (
		/\b(?:fixed|resolved|validated|verified|confirmed|works now|passes now|green|succeeded)\b/.test(
			combinedText,
		)
	) {
		reasons.add("validated outcome");
	}
	if (
		/\b(?:discovered|found that|turns out|notably|surprising|unexpected|novel|new behavior)\b/.test(
			combinedText,
		)
	) {
		reasons.add("discovery");
	}

	for (const result of input.actionResults ?? []) {
		if (hasActionExperienceSignal(result)) {
			reasons.add("action result outcome");
			break;
		}
	}

	return { score: reasons.size, reasons: Array.from(reasons) };
}

function summarizeExperienceSignals(reasons: string[]): string {
	return reasons.length > 0 ? reasons.join(", ") : "fallback interval";
}

async function getCounter(
	runtime: IAgentRuntime,
	key: string,
): Promise<number> {
	const current = Number.parseInt(
		(await runtime.getCache<string>(key)) || "0",
		10,
	);
	return Number.isFinite(current) ? current : 0;
}

function sanitizeConversationText(
	runtime: IAgentRuntime,
	text: string,
): string {
	return runtime
		.redactSecrets(renderStoredEnvelopesForPrompt(text))
		.replace(/\s+\n/g, "\n")
		.trim();
}

async function reconcileExperienceEvidence({
	runtime,
	message,
	reconciliation,
}: EvaluatorRunContext & {
	reconciliation: EvaluatorEvidenceReconciliation;
}): Promise<{ reprocessSourceIds: string[] }> {
	const service = runtime.getService<ExperienceService>("EXPERIENCE");
	if (!service)
		throw new ElizaError(
			"Experience service unavailable during reconciliation",
			{ code: "EVALUATOR_RECONCILIATION_UNAVAILABLE" },
		);
	const reprocess = new Set<string>();
	for (const experience of await service.listExperiences({
		includeInactive: true,
	})) {
		if (
			experience.agentId !== runtime.agentId ||
			experience.sourceRoomId !== message.roomId ||
			experience.extractionMethod !== "experience_evaluator"
		)
			continue;
		const revisions = experience.sourceMessageRevisions ?? {};
		const changed = Object.keys(revisions).some(
			(id) =>
				reconciliation.changedMessageIds.includes(id) ||
				reconciliation.removedMessageIds.includes(id),
		);
		const pending =
			reconciliation.pendingEvidenceId !== undefined &&
			experience.extractionEvidenceId === reconciliation.pendingEvidenceId;
		if (!pending && !changed) continue;
		for (const id of Object.keys(revisions))
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		if (experience.extractionStatus === "source_invalidated") continue;
		if (
			!(await service.updateExperience(experience.id, {
				extractionStatus: "source_invalidated",
				extractionReconciliationId: reconciliation.id,
			}))
		)
			throw new ElizaError("Experience retirement failed", {
				code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
			});
	}
	return { reprocessSourceIds: [...reprocess] };
}

export const experiencePatternEvaluator: Evaluator<
	ExperienceOutput,
	ExperiencePrepared
> = {
	name: "experiencePatterns",
	reconcileEvidence: reconcileExperienceEvidence,
	incremental: true,
	background: true,
	description:
		"Extracts reusable agent lessons from validated conversation events.",
	priority: EvaluatorPriority.EXPERIENCE,
	schema: experienceSchema,
	async shouldRun({ runtime, message, state, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		if (!message.roomId || !message.content.text) return false;
		if (isSyntheticMemory(message)) return false;
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) return false;
		if (options.extraction) {
			// The incremental journal retains skipped evidence; cadence must not
			// acknowledge a batch before its processors have persisted it.
			return (
				options.extraction.isBackfill ||
				(options.extraction.remainingSourceCount ?? 0) > 0 ||
				scoreExperienceSignals({
					latestText: getMessageText(message),
					responseTexts: (options.responses ?? []).map(getMessageText),
					actionResults: actionResultsFromState(state),
					recentTexts: options.extraction.messages
						.filter((memory) => !isSyntheticMemory(memory))
						.map(getMessageText),
				}).score > 0
			);
		}

		const cacheKey = `experience-extraction:${message.roomId}:message-count`;
		const lastRunKey = `experience-extraction:${message.roomId}:last-run-count`;
		const nextCount = (await getCounter(runtime, cacheKey)) + 1;
		await runtime.setCache(cacheKey, String(nextCount));

		const latestText = getMessageText(message);
		const responseTexts = (options.responses ?? []).map(getMessageText);
		const actionResults = actionResultsFromState(state);
		const directSignal = scoreExperienceSignals({
			latestText,
			responseTexts,
			actionResults,
		});
		const lastRunCount = await getCounter(runtime, lastRunKey);
		const minSignalGap = Math.max(
			0,
			Math.floor(
				getNumberSetting(
					runtime,
					"EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP",
					EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP,
				),
			),
		);

		if (
			directSignal.score > 0 &&
			(hasExplicitExperienceRequest(latestText) ||
				lastRunCount === 0 ||
				nextCount - lastRunCount >= minSignalGap)
		) {
			await runtime.setCache(lastRunKey, String(nextCount));
			return true;
		}

		const fallbackInterval = Math.max(
			1,
			Math.floor(
				getNumberSetting(
					runtime,
					"EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL",
					EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL,
				),
			),
		);
		if (nextCount % fallbackInterval !== 0) return false;

		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
		});
		const recentTexts = recentMessages
			.filter((memory) => !isSyntheticMemory(memory))
			.map(getMessageText)
			.filter(Boolean);
		const fallbackSignal = scoreExperienceSignals({
			latestText,
			responseTexts,
			actionResults,
			recentTexts,
		});
		if (fallbackSignal.score === 0) return false;
		await runtime.setCache(lastRunKey, String(nextCount));
		return true;
	},
	async prepare({ runtime, message, state, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) throw new Error("Experience service not available");
		const rawRecentMessages =
			options.extraction?.messages ??
			(await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
			}));
		const recentMessages = rawRecentMessages.filter(
			(memory) => !isSyntheticMemory(memory),
		);
		const conversationTexts = recentMessages
			.map(getMessageText)
			.filter(Boolean)
			.map((text) => sanitizeConversationText(runtime, text));
		const conversationContext = conversationTexts.join("\n");
		const sharedTranscript =
			options.extraction?.messages ??
			(await getRoomTranscript(runtime, message).catch((error: unknown) => {
				// error-policy:J7 shared-context deduplication is optional. Preserve
				// every sanitized body if the canonical transcript read fails.
				runtime.reportError("experiencePatterns.sharedTranscript", error, {
					roomId: message.roomId,
				});
				return [];
			}));
		const sharedTexts = new Set(
			sharedTranscript.map((memory) =>
				sanitizeConversationText(runtime, getMessageText(memory)),
			),
		);
		// The shared dialogue applies hygiene and delivery-echo deduplication.
		// Retain any experience-only body instead of assuming those projections
		// contain identical rows. Stored records and provenance stay untouched.
		const unsharedConversationContext = conversationTexts
			.filter((text) => !sharedTexts.has(text))
			.join("\n");
		const signalSummary = summarizeExperienceSignals(
			scoreExperienceSignals({
				latestText: getMessageText(message),
				responseTexts: (options.responses ?? []).map(getMessageText),
				actionResults: actionResultsFromState(state),
				recentTexts: recentMessages.map(getMessageText),
			}).reasons,
		);
		const existingExperiences = await experienceService.findSimilarExperiences(
			conversationContext,
			EXISTING_EXPERIENCE_LIMIT,
		);
		return {
			experienceService,
			recentMessages,
			conversationContext,
			unsharedConversationContext,
			signalSummary,
			existingExperiences,
			provenance: buildExperienceProvenance(message, recentMessages),
		};
	},
	prompt({ prepared, shared }) {
		const conversation = shared?.roomTranscriptRendered
			? `${recentMessagesSection(shared, [])}${
					prepared.unsharedConversationContext
						? `\nAdditional experience records not in that transcript:\n${prepared.unsharedConversationContext}`
						: ""
				}`
			: prepared.conversationContext || "(none)";
		return `Extract reusable lessons from recent conversation.

Emit only lessons useful for future behavior: success, failure, correction, discovery, validation, warning, hypothesis.

Rules:
- Max 3. Do not duplicate existing.
- Keep operational lessons grounded in tool outcomes, corrections, failed assumptions, discoveries, or explicit remember-this.
- Skip ordinary chat, one-off requests, generic observations, stable user facts/preferences; other evaluators handle those.
- Skip synthetic summaries, benchmark scaffolding, agent-generated summaries.
- Never store secrets/credentials/API keys/passwords/tokens/private keys.
- Domain comes from conversation.
- Nothing qualifies -> {"experiences":[]}.

Detected extraction signal:
${prepared.signalSummary}

Recent conversation:
${conversation}

Existing similar experiences:
${formatExistingExperiences(prepared.existingExperiences)}`;
	},
	parse: parseExperienceOutput,
	processors: [
		{
			name: "recordExperiences",
			async process({ runtime, prepared, output, options }) {
				assertExtractionSourcesUnchanged(options.extraction);
				const threshold = getNumberSetting(
					runtime,
					"AUTO_RECORD_THRESHOLD",
					DEFAULT_AUTO_RECORD_THRESHOLD,
				);
				let recordedCount = 0;
				let skippedDuplicateCount = 0;
				const existingLearning = new Set(
					prepared.existingExperiences.map((experience) =>
						normalizeLearningKey(experience.learning),
					),
				);
				const seenLearning = new Set<string>();
				for (const [index, exp] of output.experiences.entries()) {
					if (exp.confidence < threshold) continue;
					const learning = normalizeStoredText(runtime, exp.learning);
					const learningKey = normalizeLearningKey(learning);
					if (
						!learning ||
						!learningKey ||
						existingLearning.has(learningKey) ||
						seenLearning.has(learningKey)
					) {
						skippedDuplicateCount += 1;
						continue;
					}
					seenLearning.add(learningKey);
					await prepared.experienceService.recordExperience({
						...(options.extraction
							? {
									id: stringToUuid(
										`${runtime.agentId}:experiencePatterns:${options.extraction.evidenceId}:${index}`,
									),
									extractionEvidenceId: options.extraction.evidenceId,
									sourceMessageRevisions: {
										...options.extraction.referenceRevisions,
										...options.extraction.sourceRevisions,
									},
								}
							: {}),
						type: exp.type,
						outcome: exp.outcome,
						context: normalizeStoredText(runtime, exp.context),
						action: "post_turn_evaluation",
						result: learning,
						learning,
						domain: normalizeStoredText(runtime, exp.domain),
						tags: ["extracted", "novel", exp.type],
						confidence: Math.min(exp.confidence, 0.9),
						importance: Math.min(Math.max(exp.importance, 0), 1),
						sourceMessageIds: prepared.provenance.sourceMessageIds,
						sourceRoomId: prepared.provenance.sourceRoomId,
						sourceTriggerMessageId: prepared.provenance.sourceTriggerMessageId,
						sourceTrajectoryId: prepared.provenance.sourceTrajectoryId,
						sourceTrajectoryStepId: prepared.provenance.sourceTrajectoryStepId,
						associatedEntityIds: prepared.provenance.associatedEntityIds,
						extractionMethod: "experience_evaluator",
						extractionReason: normalizeStoredText(runtime, exp.reasoning),
					});
					recordedCount += 1;
				}
				logger.debug(
					{
						src: "evaluator:experience",
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
					"Processed experience evaluator output",
				);
				return {
					success: true,
					data: {
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
					values: {
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
				};
			},
		},
	],
};
