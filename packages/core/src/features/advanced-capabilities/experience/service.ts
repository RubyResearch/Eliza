/**
 * Runs the ExperienceService, the long-lived singleton behind the experience
 * advanced-capability: it records what the agent tried, the outcome, and the
 * lesson learned, then makes those experiences retrievable to inform future
 * decisions. Registers under the EXPERIENCE service type.
 *
 * Experiences live in an in-memory Map hydrated on start from the `experiences`
 * memory table (the same table writes go back to), with secondary indexes by
 * domain and type. Access counts accrue in memory and batch-persist on a 60s
 * timer; a daily maintenance timer runs learning-text dedupe. Retrieval is
 * semantic — a shared per-turn recall-query embedding plus cosine similarity —
 * reranked so vector relevance dominates (70%) and quality signals (decayed
 * confidence, importance, recency, access frequency) only tiebreak (30%), with a
 * similarity floor and a recency-sort fallback when embeddings are unavailable.
 *
 * Confidence decay and inter-experience relationships/graph links are delegated
 * to ConfidenceDecayManager and ExperienceRelationshipManager; on record,
 * same-action / opposite-outcome experiences in one domain are cross-linked as
 * `contradicts`.
 */
import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import type { Memory } from "../../../types/memory.ts";
import { ModelType } from "../../../types/model.ts";
import type { JsonValue, UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { Service, type ServiceTypeName } from "../../../types/service.ts";
import { embedRecallQuery } from "../../documents/recall-embed.ts";
import {
	type Experience,
	type ExperienceAnalysis,
	type ExperienceDedupeResult,
	type ExperienceGraphLink,
	type ExperienceGraphLinkType,
	type ExperienceGraphSnapshot,
	type ExperienceQuery,
	ExperienceServiceType,
	ExperienceType,
	OutcomeType,
} from "./types.ts";
import { ConfidenceDecayManager } from "./utils/confidenceDecay";
import { ExperienceRelationshipManager } from "./utils/experienceRelationships";
import {
	extractExperienceKeywords,
	isDuplicateLearning,
} from "./utils/experienceText.ts";

const GRAPH_MAX_LINKS = 200;
const GRAPH_KEYWORD_LINK_THRESHOLD = 2;
const DAILY_EXPERIENCE_MAINTENANCE_MS = 24 * 60 * 60 * 1000;

export class ExperienceService extends Service {
	static override serviceType: ServiceTypeName =
		ExperienceServiceType.EXPERIENCE as ServiceTypeName;
	override capabilityDescription =
		"Manages agent experiences, learning from successes and failures to improve future decisions";

	private experiences: Map<UUID, Experience> = new Map();
	private experiencesByDomain: Map<string, Set<UUID>> = new Map();
	private experiencesByType: Map<ExperienceType, Set<UUID>> = new Map();
	private dirtyExperiences: Set<UUID> = new Set();
	private persistTimer: ReturnType<typeof setInterval> | null = null;
	private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
	private decayManager: ConfidenceDecayManager;
	private relationshipManager: ExperienceRelationshipManager;

	constructor(runtime: IAgentRuntime) {
		super(runtime);
		this.decayManager = new ConfidenceDecayManager();
		this.relationshipManager = new ExperienceRelationshipManager();
	}

	static async start(runtime: IAgentRuntime): Promise<ExperienceService> {
		const service = new ExperienceService(runtime);
		await service.loadExperiences();
		service.startBackgroundTasks();
		return service;
	}

	private startBackgroundTasks(): void {
		this.persistTimer = setInterval(() => {
			// error-policy:J7 the timer cannot await this diagnostic write; the
			// runtime error channel observes every rejected batch.
			void this.persistDirtyExperiences().catch((error) => {
				this.runtime.reportError("ExperienceService.persistDirty", error);
			});
		}, 60_000);
		this.maintenanceTimer = setInterval(() => {
			// error-policy:J7 maintenance is detached from message processing;
			// report failures without terminating the scheduler.
			void this.dedupeDuplicateExperiences({ deleteDuplicates: false }).catch(
				(error) => {
					this.runtime.reportError("ExperienceService.dedupe", error);
				},
			);
		}, DAILY_EXPERIENCE_MAINTENANCE_MS);
	}

	private toTimestamp(
		value: number | Date | undefined,
		fallback: number,
	): number {
		if (value === undefined) return fallback;
		if (typeof value === "number") return value;
		if (value instanceof Date) return value.getTime();
		return fallback;
	}

	private toOptionalTimestamp(value: unknown): number | undefined {
		if (typeof value === "number") return value;
		if (value instanceof Date) return value.getTime();
		return undefined;
	}

	private asStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value.filter((item): item is string => typeof item === "string");
	}

	private asOptionalUuidArray(value: unknown): UUID[] | undefined {
		const ids = this.asStringArray(value) as UUID[];
		return ids.length > 0 ? ids : undefined;
	}

	private asUuidArray(value: unknown): UUID[] {
		return this.asStringArray(value) as UUID[];
	}

	private dedupeStrings(values: Array<string | undefined>): string[] {
		return Array.from(
			new Set(
				values
					.map((value) => value?.trim())
					.filter((value): value is string => Boolean(value)),
			),
		);
	}

	private normalizeTags(
		tags: unknown,
		domain: string,
		type: ExperienceType,
	): string[] {
		const providedTags = this.asStringArray(tags).map((tag) =>
			tag.toLowerCase(),
		);
		return this.dedupeStrings(
			providedTags.length > 0 ? providedTags : [domain.toLowerCase(), type],
		);
	}

	private deriveKeywords(
		experience: Pick<
			Experience,
			"context" | "action" | "result" | "learning" | "domain" | "tags"
		>,
	): string[] {
		return extractExperienceKeywords([
			experience.context,
			experience.action,
			experience.result,
			experience.learning,
			experience.domain,
			experience.tags,
		]);
	}

	private asOptionalEmbedding(value: unknown): number[] | undefined {
		if (!Array.isArray(value)) {
			return undefined;
		}

		const embedding = value.filter(
			(item): item is number =>
				typeof item === "number" && Number.isFinite(item),
		);
		return embedding.length > 0 ? embedding : undefined;
	}

	private clampScore(value: unknown, fallback: number): number {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return fallback;
		}

		return Math.max(0, Math.min(1, value));
	}

	private isExperienceType(value: unknown): value is ExperienceType {
		return Object.values(ExperienceType).includes(value as ExperienceType);
	}

	private isOutcomeType(value: unknown): value is OutcomeType {
		return Object.values(OutcomeType).includes(value as OutcomeType);
	}

	private cloneExperience(experience: Experience): Experience {
		return {
			...experience,
			tags: [...experience.tags],
			keywords: [...experience.keywords],
			associatedEntityIds: [...experience.associatedEntityIds],
			embedding: experience.embedding ? [...experience.embedding] : undefined,
			memoryIds: experience.memoryIds ? [...experience.memoryIds] : undefined,
			sourceMessageIds: experience.sourceMessageIds
				? [...experience.sourceMessageIds]
				: undefined,
			sourceMessageRevisions: experience.sourceMessageRevisions
				? { ...experience.sourceMessageRevisions }
				: undefined,
			relatedExperiences: experience.relatedExperiences
				? [...experience.relatedExperiences]
				: undefined,
			mergedExperienceIds: experience.mergedExperienceIds
				? [...experience.mergedExperienceIds]
				: undefined,
		};
	}

	private indexExperience(experience: Experience): void {
		if (!this.experiencesByDomain.has(experience.domain)) {
			this.experiencesByDomain.set(experience.domain, new Set());
		}
		this.experiencesByDomain.get(experience.domain)?.add(experience.id);

		if (!this.experiencesByType.has(experience.type)) {
			this.experiencesByType.set(experience.type, new Set());
		}
		this.experiencesByType.get(experience.type)?.add(experience.id);
	}

	private unindexExperience(experience: Experience): void {
		const domainIndex = this.experiencesByDomain.get(experience.domain);
		domainIndex?.delete(experience.id);
		if (domainIndex && domainIndex.size === 0) {
			this.experiencesByDomain.delete(experience.domain);
		}

		const typeIndex = this.experiencesByType.get(experience.type);
		typeIndex?.delete(experience.id);
		if (typeIndex && typeIndex.size === 0) {
			this.experiencesByType.delete(experience.type);
		}
	}

	private setExperience(experience: Experience): void {
		const existing = this.experiences.get(experience.id);
		if (existing) {
			this.unindexExperience(existing);
		}

		this.experiences.set(experience.id, experience);
		this.indexExperience(experience);
	}

	private parseExperienceMemory(memory: Memory): Experience | null {
		if (!memory.content || typeof memory.content !== "object") {
			return null;
		}

		const content = memory.content as Record<string, unknown>;
		const rawData =
			content.data &&
			typeof content.data === "object" &&
			!Array.isArray(content.data)
				? (content.data as Partial<Experience>)
				: null;
		const isLegacyExperience = content.type === "experience";
		if (!rawData && !isLegacyExperience) {
			return null;
		}

		const memoryCreatedAt =
			typeof memory.createdAt === "number" ? memory.createdAt : Date.now();
		const experienceId =
			typeof rawData?.id === "string"
				? (rawData.id as UUID)
				: memory.id
					? (memory.id as UUID)
					: null;
		if (!experienceId) {
			return null;
		}

		const legacyText = typeof content.text === "string" ? content.text : "";
		const legacyContext =
			typeof content.context === "string" ? content.context : "";

		return {
			id: experienceId,
			agentId:
				typeof rawData?.agentId === "string"
					? (rawData.agentId as UUID)
					: this.runtime.agentId,
			type: this.isExperienceType(rawData?.type)
				? rawData.type
				: ExperienceType.LEARNING,
			outcome: this.isOutcomeType(rawData?.outcome)
				? rawData.outcome
				: OutcomeType.NEUTRAL,
			context:
				typeof rawData?.context === "string" ? rawData.context : legacyContext,
			action: typeof rawData?.action === "string" ? rawData.action : "",
			result: typeof rawData?.result === "string" ? rawData.result : legacyText,
			learning:
				typeof rawData?.learning === "string" ? rawData.learning : legacyText,
			domain:
				typeof rawData?.domain === "string" && rawData.domain.trim().length > 0
					? rawData.domain
					: "general",
			tags: this.asStringArray(rawData?.tags),
			keywords: this.asStringArray(rawData?.keywords),
			associatedEntityIds: this.asUuidArray(rawData?.associatedEntityIds),
			confidence: this.clampScore(rawData?.confidence, 0.5),
			importance: this.clampScore(rawData?.importance, 0.5),
			createdAt: this.toTimestamp(
				rawData?.createdAt as number | Date | undefined,
				memoryCreatedAt,
			),
			updatedAt: this.toTimestamp(
				rawData?.updatedAt as number | Date | undefined,
				memoryCreatedAt,
			),
			accessCount:
				typeof rawData?.accessCount === "number" &&
				Number.isFinite(rawData.accessCount)
					? Math.max(0, rawData.accessCount)
					: 0,
			lastAccessedAt:
				this.toOptionalTimestamp(rawData?.lastAccessedAt) ?? undefined,
			embedding:
				this.asOptionalEmbedding(memory.embedding) ??
				this.asOptionalEmbedding(rawData?.embedding),
			relatedExperiences: this.asOptionalUuidArray(rawData?.relatedExperiences),
			mergedExperienceIds: this.asOptionalUuidArray(
				rawData?.mergedExperienceIds,
			),
			supersedes:
				typeof rawData?.supersedes === "string"
					? (rawData.supersedes as UUID)
					: undefined,
			previousBelief:
				typeof rawData?.previousBelief === "string"
					? rawData.previousBelief
					: undefined,
			correctedBelief:
				typeof rawData?.correctedBelief === "string"
					? rawData.correctedBelief
					: undefined,
			extractionStatus:
				rawData?.extractionStatus === "source_invalidated"
					? "source_invalidated"
					: undefined,
			extractionReconciliationId:
				typeof rawData?.extractionReconciliationId === "string"
					? rawData.extractionReconciliationId
					: undefined,
			sourceMessageIds: this.asOptionalUuidArray(rawData?.sourceMessageIds),
			sourceMessageRevisions:
				rawData?.sourceMessageRevisions &&
				typeof rawData.sourceMessageRevisions === "object" &&
				!Array.isArray(rawData.sourceMessageRevisions)
					? Object.fromEntries(
							Object.entries(rawData.sourceMessageRevisions).filter(
								([, revision]) => typeof revision === "string",
							),
						)
					: undefined,
			extractionEvidenceId:
				typeof rawData?.extractionEvidenceId === "string"
					? rawData.extractionEvidenceId
					: undefined,
			sourceRoomId:
				typeof rawData?.sourceRoomId === "string"
					? (rawData.sourceRoomId as UUID)
					: undefined,
			sourceTriggerMessageId:
				typeof rawData?.sourceTriggerMessageId === "string"
					? (rawData.sourceTriggerMessageId as UUID)
					: undefined,
			sourceTrajectoryId:
				typeof rawData?.sourceTrajectoryId === "string"
					? rawData.sourceTrajectoryId
					: undefined,
			sourceTrajectoryStepId:
				typeof rawData?.sourceTrajectoryStepId === "string"
					? rawData.sourceTrajectoryStepId
					: undefined,
			extractionMethod:
				typeof rawData?.extractionMethod === "string"
					? rawData.extractionMethod
					: undefined,
			extractionReason:
				typeof rawData?.extractionReason === "string"
					? rawData.extractionReason
					: undefined,
		};
	}

	private async generateEmbedding(
		experienceData: Pick<
			Experience,
			"context" | "action" | "result" | "learning"
		>,
	): Promise<number[]> {
		const embeddingText = `${experienceData.context} ${experienceData.action} ${experienceData.result} ${experienceData.learning}`;
		const runModel = this.runtime.useModel.bind(this.runtime);

		let result: number[];
		try {
			result = await runModel(ModelType.TEXT_EMBEDDING, {
				text: embeddingText,
			});
		} catch (error) {
			// error-policy:J2 Preserve the model provider cause under a stable service
			// error code for callers and diagnostics.
			throw new ElizaError("Experience embedding generation failed", {
				code: "EXPERIENCE_EMBEDDING_FAILED",
				cause: error,
				severity: "ephemeral",
			});
		}
		if (
			!Array.isArray(result) ||
			result.length === 0 ||
			!result.some((value) => value !== 0)
		) {
			throw new ElizaError("Experience embedding is empty or zero-valued", {
				code: "EXPERIENCE_EMBEDDING_INVALID",
				context: { dimensions: Array.isArray(result) ? result.length : null },
				severity: "fatal",
			});
		}
		return result;
	}

	private buildExperienceMemory(experience: Experience): Memory {
		const data: Record<string, JsonValue> = {
			id: experience.id,
			agentId: experience.agentId,
			type: experience.type,
			outcome: experience.outcome,
			context: experience.context,
			action: experience.action,
			result: experience.result,
			learning: experience.learning,
			domain: experience.domain,
			tags: experience.tags,
			keywords: experience.keywords,
			associatedEntityIds: experience.associatedEntityIds,
			confidence: experience.confidence,
			importance: experience.importance,
			createdAt: experience.createdAt,
			updatedAt: experience.updatedAt,
			accessCount: experience.accessCount,
		};
		if (experience.lastAccessedAt !== undefined) {
			data.lastAccessedAt = experience.lastAccessedAt;
		}
		if (experience.relatedExperiences !== undefined) {
			data.relatedExperiences = experience.relatedExperiences;
		}
		if (experience.mergedExperienceIds !== undefined) {
			data.mergedExperienceIds = experience.mergedExperienceIds;
		}
		if (experience.supersedes !== undefined) {
			data.supersedes = experience.supersedes;
		}
		if (experience.previousBelief !== undefined) {
			data.previousBelief = experience.previousBelief;
		}
		if (experience.correctedBelief !== undefined) {
			data.correctedBelief = experience.correctedBelief;
		}
		if (experience.sourceMessageIds !== undefined) {
			data.sourceMessageIds = experience.sourceMessageIds;
		}
		if (experience.extractionStatus !== undefined)
			data.extractionStatus = experience.extractionStatus;
		if (experience.extractionReconciliationId !== undefined)
			data.extractionReconciliationId = experience.extractionReconciliationId;
		if (experience.sourceMessageRevisions !== undefined) {
			data.sourceMessageRevisions = { ...experience.sourceMessageRevisions };
		}
		if (experience.extractionEvidenceId !== undefined) {
			data.extractionEvidenceId = experience.extractionEvidenceId;
		}
		if (experience.sourceRoomId !== undefined) {
			data.sourceRoomId = experience.sourceRoomId;
		}
		if (experience.sourceTriggerMessageId !== undefined) {
			data.sourceTriggerMessageId = experience.sourceTriggerMessageId;
		}
		if (experience.sourceTrajectoryId !== undefined) {
			data.sourceTrajectoryId = experience.sourceTrajectoryId;
		}
		if (experience.sourceTrajectoryStepId !== undefined) {
			data.sourceTrajectoryStepId = experience.sourceTrajectoryStepId;
		}
		if (experience.extractionMethod !== undefined) {
			data.extractionMethod = experience.extractionMethod;
		}
		if (experience.extractionReason !== undefined) {
			data.extractionReason = experience.extractionReason;
		}

		return {
			id: experience.id,
			unique: true,
			entityId: this.runtime.agentId,
			agentId: this.runtime.agentId,
			roomId: this.runtime.agentId,
			content: {
				text: `Experience: ${experience.learning}`,
				type: "experience",
				data,
			},
			createdAt: experience.createdAt,
			embedding: experience.embedding,
		};
	}

	private touchExperiences(experiences: Experience[]): void {
		const now = Date.now();
		for (const experience of experiences) {
			experience.accessCount += 1;
			experience.lastAccessedAt = now;
			this.dirtyExperiences.add(experience.id);
		}
	}

	private async loadExperiences(): Promise<void> {
		// Load experiences from the "experiences" table (same table we write to)
		const memories = await this.runtime.getMemories({
			entityId: this.runtime.agentId,
			tableName: "experiences",
		});

		for (const memory of memories) {
			const experience = this.parseExperienceMemory(memory);
			if (experience) {
				if (experience.tags.length === 0) {
					experience.tags = this.normalizeTags(
						experience.tags,
						experience.domain,
						experience.type,
					);
				}
				if (experience.keywords.length === 0) {
					experience.keywords = this.deriveKeywords(experience);
				}
				this.setExperience(experience);
			}
		}

		logger.info(
			`[ExperienceService] Loaded ${this.experiences.size} experiences from memory`,
		);
	}

	async recordExperience(
		experienceData: Partial<Experience>,
	): Promise<Experience> {
		if (experienceData.id) {
			const cached = this.experiences.get(experienceData.id);
			if (cached) return this.cloneExperience(cached);
			// A preceding write can commit before its caller receives success.
			// Reuse the durable row on replay, including after a service restart.
			const stored = await this.runtime.getMemoryById(experienceData.id);
			if (stored) {
				const existing = this.parseExperienceMemory(stored);
				if (
					!existing ||
					stored.content.type !== "experience" ||
					stored.agentId !== this.runtime.agentId ||
					existing.agentId !== this.runtime.agentId ||
					existing.id !== experienceData.id
				) {
					throw new ElizaError("Experience ID belongs to a different record", {
						code: "EXPERIENCE_ID_CONFLICT",
					});
				}
				this.setExperience(existing);
				return this.cloneExperience(existing);
			}
		}
		const now = Date.now();
		const context = experienceData.context || "";
		const action = experienceData.action || "";
		const result = experienceData.result || "";
		const learning = experienceData.learning || "";
		const type = experienceData.type || ExperienceType.LEARNING;
		const domain = experienceData.domain || "general";
		const tags = this.normalizeTags(experienceData.tags, domain, type);
		const keywords =
			experienceData.keywords && experienceData.keywords.length > 0
				? this.dedupeStrings(experienceData.keywords)
				: this.deriveKeywords({
						context,
						action,
						result,
						learning,
						domain,
						tags,
					});
		const embedding = await this.generateEmbedding({
			context,
			action,
			result,
			learning,
		});

		const experience: Experience = {
			id: experienceData.id ?? (uuidv4() as UUID),
			agentId: this.runtime.agentId,
			type,
			outcome: experienceData.outcome || OutcomeType.NEUTRAL,
			context,
			action,
			result,
			learning,
			domain,
			tags,
			keywords,
			associatedEntityIds: experienceData.associatedEntityIds
				? Array.from(new Set(experienceData.associatedEntityIds))
				: [],
			confidence: experienceData.confidence ?? 0.5,
			importance: experienceData.importance ?? 0.5,
			createdAt: now,
			updatedAt: now,
			accessCount: 0,
			lastAccessedAt: now,
			embedding,
			relatedExperiences: experienceData.relatedExperiences
				? [...experienceData.relatedExperiences]
				: undefined,
			mergedExperienceIds: experienceData.mergedExperienceIds
				? [...experienceData.mergedExperienceIds]
				: undefined,
			supersedes: experienceData.supersedes,
			previousBelief: experienceData.previousBelief,
			correctedBelief: experienceData.correctedBelief,
			sourceMessageIds: experienceData.sourceMessageIds
				? [...experienceData.sourceMessageIds]
				: undefined,
			sourceMessageRevisions: experienceData.sourceMessageRevisions
				? { ...experienceData.sourceMessageRevisions }
				: undefined,
			extractionEvidenceId: experienceData.extractionEvidenceId,
			sourceRoomId: experienceData.sourceRoomId,
			sourceTriggerMessageId: experienceData.sourceTriggerMessageId,
			sourceTrajectoryId: experienceData.sourceTrajectoryId,
			sourceTrajectoryStepId: experienceData.sourceTrajectoryStepId,
			extractionMethod: experienceData.extractionMethod,
			extractionReason: experienceData.extractionReason,
		};

		await this.saveExperienceToMemory(experience);
		this.setExperience(experience);

		// Check for contradictions and add relationships
		const allExperiences = Array.from(this.experiences.values());
		const contradictions = this.relationshipManager.findContradictions(
			experience,
			allExperiences,
		);

		for (const contradiction of contradictions) {
			this.relationshipManager.addRelationship({
				fromId: experience.id,
				toId: contradiction.id,
				type: "contradicts",
				strength: 0.8,
			});
		}

		logger.info(
			`[ExperienceService] Recorded experience: ${experience.id} (${experience.type})`,
		);

		return this.cloneExperience(experience);
	}

	private async saveExperienceToMemory(experience: Experience): Promise<void> {
		await this.runtime.upsertMemory(
			this.buildExperienceMemory(experience),
			"experiences",
		);
	}

	private async persistDirtyExperiences(): Promise<void> {
		if (this.dirtyExperiences.size === 0) return;

		const toSave = Array.from(this.dirtyExperiences);
		this.dirtyExperiences.clear();

		let saved = 0;
		for (const id of toSave) {
			const exp = this.experiences.get(id);
			if (exp) {
				try {
					await this.saveExperienceToMemory(exp);
					saved++;
				} catch (error) {
					// error-policy:J7 the periodic writer retries on its next cycle and
					// reports the failed durable write to the agent/owner channel.
					this.dirtyExperiences.add(id);
					this.runtime.reportError("ExperienceService.persistDirty", error, {
						experienceId: id,
					});
				}
			}
		}

		if (saved > 0) {
			logger.debug(`[ExperienceService] Persisted ${saved} dirty experiences`);
		}
	}

	async getExperience(id: UUID): Promise<Experience | null> {
		const experience = this.experiences.get(id);
		return experience ? this.cloneExperience(experience) : null;
	}

	async listExperiences(query: ExperienceQuery = {}): Promise<Experience[]> {
		return this.resolveExperiences(query, false);
	}

	async updateExperience(
		id: UUID,
		updates: Partial<Experience>,
	): Promise<Experience | null> {
		const existing = this.experiences.get(id);
		if (!existing) {
			return null;
		}

		const nextContext =
			"context" in updates ? (updates.context ?? "") : existing.context;
		const nextAction =
			"action" in updates ? (updates.action ?? "") : existing.action;
		const nextResult =
			"result" in updates ? (updates.result ?? "") : existing.result;
		const nextLearning =
			"learning" in updates ? (updates.learning ?? "") : existing.learning;
		const nextType =
			"type" in updates ? (updates.type ?? existing.type) : existing.type;
		const nextDomain =
			"domain" in updates ? (updates.domain ?? "general") : existing.domain;
		const nextTags =
			"tags" in updates
				? this.normalizeTags(updates.tags, nextDomain, nextType)
				: [...existing.tags];
		const shouldRegenerateEmbedding =
			"context" in updates ||
			"action" in updates ||
			"result" in updates ||
			"learning" in updates;
		const shouldRegenerateKeywords =
			shouldRegenerateEmbedding ||
			"domain" in updates ||
			"tags" in updates ||
			"type" in updates;
		const nextKeywords =
			"keywords" in updates && updates.keywords && updates.keywords.length > 0
				? this.dedupeStrings(updates.keywords)
				: shouldRegenerateKeywords
					? this.deriveKeywords({
							context: nextContext,
							action: nextAction,
							result: nextResult,
							learning: nextLearning,
							domain: nextDomain,
							tags: nextTags,
						})
					: [...existing.keywords];
		const embedding = shouldRegenerateEmbedding
			? await this.generateEmbedding({
					context: nextContext,
					action: nextAction,
					result: nextResult,
					learning: nextLearning,
				})
			: existing.embedding;
		const updated: Experience = {
			...existing,
			...updates,
			id: existing.id,
			agentId: existing.agentId,
			createdAt: existing.createdAt,
			context: nextContext,
			action: nextAction,
			result: nextResult,
			learning: nextLearning,
			type: nextType,
			domain: nextDomain,
			tags: nextTags,
			keywords: nextKeywords,
			associatedEntityIds:
				"associatedEntityIds" in updates
					? Array.from(new Set(updates.associatedEntityIds ?? []))
					: [...existing.associatedEntityIds],
			relatedExperiences:
				"relatedExperiences" in updates
					? updates.relatedExperiences
						? [...updates.relatedExperiences]
						: undefined
					: existing.relatedExperiences
						? [...existing.relatedExperiences]
						: undefined,
			sourceMessageIds:
				"sourceMessageIds" in updates
					? updates.sourceMessageIds
						? [...updates.sourceMessageIds]
						: undefined
					: existing.sourceMessageIds
						? [...existing.sourceMessageIds]
						: undefined,
			mergedExperienceIds:
				"mergedExperienceIds" in updates
					? updates.mergedExperienceIds
						? [...updates.mergedExperienceIds]
						: undefined
					: existing.mergedExperienceIds
						? [...existing.mergedExperienceIds]
						: undefined,
			embedding,
			updatedAt: Date.now(),
		};

		await this.saveExperienceToMemory(updated);
		this.setExperience(updated);
		this.dirtyExperiences.delete(id);

		return this.cloneExperience(updated);
	}

	async deleteExperience(id: UUID): Promise<boolean> {
		const existing = this.experiences.get(id);
		if (!existing) {
			return false;
		}

		await this.runtime.deleteMemory(id);
		this.unindexExperience(existing);
		this.experiences.delete(id);
		this.dirtyExperiences.delete(id);
		this.relationshipManager.removeExperience(id);
		return true;
	}

	async queryExperiences(query: ExperienceQuery): Promise<Experience[]> {
		return this.resolveExperiences(query, true);
	}

	private async resolveExperiences(
		query: ExperienceQuery,
		trackAccess: boolean,
	): Promise<Experience[]> {
		let results: Experience[] = [];
		const limit = query.limit;

		if (query.query) {
			const candidates = this.applyFilters(
				await this.findSimilarExperiences(query.query),
				query,
			);
			results = limit === undefined ? candidates : candidates.slice(0, limit);
		} else {
			// Non-semantic path: filter then sort by quality
			const candidates = this.applyFilters(
				Array.from(this.experiences.values()),
				query,
			);
			candidates.sort((a, b) => {
				const scoreA = this.decayManager.getDecayedConfidence(a) * a.importance;
				const scoreB = this.decayManager.getDecayedConfidence(b) * b.importance;
				return scoreB - scoreA;
			});
			results = limit === undefined ? candidates : candidates.slice(0, limit);
		}

		// Include related experiences if requested
		if (query.includeRelated) {
			const relatedIds = new Set<UUID>();
			for (const exp of results) {
				if (exp.relatedExperiences) {
					exp.relatedExperiences.forEach((id) => {
						relatedIds.add(id);
					});
				}
			}

			const related = Array.from(relatedIds)
				.map((id) => this.experiences.get(id))
				.filter((exp): exp is Experience => exp !== undefined)
				.filter(
					(exp) =>
						(query.includeInactive ||
							exp.extractionStatus !== "source_invalidated") &&
						!results.some((r) => r.id === exp.id),
				);

			results.push(...related);
		}

		if (trackAccess) {
			this.touchExperiences(results);
		}

		return results.map((experience) => this.cloneExperience(experience));
	}

	/** Apply query filters (type, outcome, domain, tags, confidence, importance, timeRange). */
	private applyFilters(
		candidates: Experience[],
		query: ExperienceQuery,
	): Experience[] {
		let filtered = query.includeInactive
			? candidates
			: candidates.filter(
					(row) => row.extractionStatus !== "source_invalidated",
				);

		if (query.type) {
			const types = Array.isArray(query.type) ? query.type : [query.type];
			filtered = filtered.filter((e) => types.includes(e.type));
		}
		if (query.outcome) {
			const outcomes = Array.isArray(query.outcome)
				? query.outcome
				: [query.outcome];
			filtered = filtered.filter((e) => outcomes.includes(e.outcome));
		}
		if (query.domain) {
			const domains = Array.isArray(query.domain)
				? query.domain
				: [query.domain];
			filtered = filtered.filter((e) => domains.includes(e.domain));
		}
		if (query.tags && query.tags.length > 0) {
			filtered = filtered.filter((e) =>
				query.tags?.some((t) => e.tags.includes(t)),
			);
		}
		if (query.minConfidence !== undefined) {
			const min = query.minConfidence;
			filtered = filtered.filter(
				(e) => this.decayManager.getDecayedConfidence(e) >= min,
			);
		}
		if (query.minImportance !== undefined) {
			const min = query.minImportance;
			filtered = filtered.filter((e) => e.importance >= min);
		}
		if (query.timeRange) {
			const { start, end } = query.timeRange;
			filtered = filtered.filter((e) => {
				if (start !== undefined && e.createdAt < start) return false;
				if (end !== undefined && e.createdAt > end) return false;
				return true;
			});
		}

		return filtered;
	}

	/**
	 * Rank retrieval candidates by vector similarity, then quality on equal
	 * similarity. Confidence cannot promote a weaker match above a stronger one.
	 * The existing cosine floor is only a broad candidate filter, not proof of
	 * applicability; the caller/model still reviews the situation before using it.
	 */
	async findSimilarExperiences(
		text: string,
		limit?: number,
	): Promise<Experience[]> {
		if (!text || this.experiences.size === 0) {
			return [];
		}

		// Share the one per-turn recall-query embed across all recall providers
		// (documents, relevant-conversations) so the same query text hits the
		// embed endpoint once per turn. `null` means timed out/failed — fail open
		// to the recency sort, exactly as the empty/zero-embedding case does.
		const queryEmbedding = await embedRecallQuery(this.runtime, text);
		if (queryEmbedding === null) {
			logger.warn(
				"[ExperienceService] Query embedding unavailable, falling back to recency sort",
			);
			return this.fallbackSort(limit);
		}
		if (
			queryEmbedding.length === 0 ||
			queryEmbedding.every((v: number) => v === 0)
		) {
			logger.warn(
				"[ExperienceService] Query embedding is empty/zero, falling back to recency sort",
			);
			return this.fallbackSort(limit);
		}

		// Preserve the candidate set: do not introduce an uncalibrated cutoff
		// that could hide a relevant earlier situation.
		const SIMILARITY_FLOOR = 0.05;

		const scored: Array<{
			experience: Experience;
			similarity: number;
			quality: number;
		}> = [];
		const now = Date.now();

		for (const experience of this.experiences.values()) {
			if (!experience.embedding) continue;

			const similarity = this.cosineSimilarity(
				queryEmbedding,
				experience.embedding,
			);
			if (similarity < SIMILARITY_FLOOR) continue;

			// --- Quality signals (all normalized 0-1) ---

			// Confidence with time-decay applied
			const decayedConfidence =
				this.decayManager.getDecayedConfidence(experience);

			// Smooth recency: half-life of 30 days, never goes to zero
			const ageDays = Math.max(
				0,
				(now - experience.createdAt) / (24 * 60 * 60 * 1000),
			);
			const recencyFactor = 1 / (1 + ageDays / 30);

			// Access frequency: log-scaled, capped at 1.0
			// ~0 at 0 accesses, ~0.33 at 1, ~0.66 at 3, ~1.0 at 9+
			const accessFactor = Math.min(
				1,
				Math.log2(experience.accessCount + 1) / Math.log2(10),
			);

			// Weighted quality score (0-1 range)
			const qualityScore =
				decayedConfidence * 0.45 +
				experience.importance * 0.35 +
				recencyFactor * 0.12 +
				accessFactor * 0.08;

			scored.push({ experience, similarity, quality: qualityScore });
		}

		scored.sort((a, b) => b.similarity - a.similarity || b.quality - a.quality);
		const ranked = scored.map((item) => item.experience);
		const results = limit === undefined ? ranked : ranked.slice(0, limit);

		return results;
	}

	/** Fallback when embeddings are unavailable: sort by decayed confidence * importance. */
	private fallbackSort(limit?: number): Experience[] {
		const all = Array.from(this.experiences.values());
		all.sort((a, b) => {
			const sa = this.decayManager.getDecayedConfidence(a) * a.importance;
			const sb = this.decayManager.getDecayedConfidence(b) * b.importance;
			return sb - sa;
		});
		return limit === undefined ? all : all.slice(0, limit);
	}

	async getExperienceGraph(
		query: ExperienceQuery = {},
	): Promise<ExperienceGraphSnapshot> {
		const experiences = await this.resolveExperiences(
			{ ...query, limit: query.limit ?? 100 },
			false,
		);
		return this.buildGraphSnapshot(experiences);
	}

	async dedupeDuplicateExperiences(
		options: { deleteDuplicates?: boolean; limit?: number } = {},
	): Promise<ExperienceDedupeResult> {
		const candidates = Array.from(this.experiences.values())
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, options.limit ?? this.experiences.size);
		const consumedIds = new Set<UUID>();
		const groups: ExperienceDedupeResult["groups"] = [];
		let deleted = 0;

		for (const experience of candidates) {
			if (consumedIds.has(experience.id)) {
				continue;
			}

			const duplicates = candidates.filter(
				(candidate) =>
					candidate.id !== experience.id &&
					!consumedIds.has(candidate.id) &&
					!this.areAlreadyDedupeLinked(experience, candidate) &&
					isDuplicateLearning(experience.learning, candidate.learning),
			);
			if (duplicates.length === 0) {
				consumedIds.add(experience.id);
				continue;
			}

			const group = [experience, ...duplicates];
			const primary = this.selectPrimaryExperience(group);
			const duplicateIds: UUID[] = [];

			for (const duplicate of group) {
				if (duplicate.id === primary.id) {
					continue;
				}
				await this.mergeDuplicateExperience(
					primary.id,
					duplicate.id,
					options.deleteDuplicates === true,
				);
				duplicateIds.push(duplicate.id);
				consumedIds.add(duplicate.id);
				if (options.deleteDuplicates === true) {
					deleted++;
				}
			}

			const updatedPrimary = this.experiences.get(primary.id) ?? primary;
			groups.push({
				primaryId: primary.id,
				duplicateIds,
				mergedKeywords: updatedPrimary.keywords,
				reason: "duplicate learning text",
			});
			consumedIds.add(primary.id);
		}

		return {
			inspected: candidates.length,
			groups,
			merged: groups.reduce(
				(total, group) => total + group.duplicateIds.length,
				0,
			),
			deleted,
		};
	}

	private buildGraphSnapshot(
		experiences: Experience[],
	): ExperienceGraphSnapshot {
		const sorted = [...experiences].sort((left, right) => {
			const scoreLeft =
				this.decayManager.getDecayedConfidence(left) *
				left.importance *
				this.getTimeWeight(left);
			const scoreRight =
				this.decayManager.getDecayedConfidence(right) *
				right.importance *
				this.getTimeWeight(right);
			return scoreRight - scoreLeft;
		});

		return {
			generatedAt: Date.now(),
			totalExperiences: this.experiences.size,
			nodes: sorted.map((experience, index) =>
				this.buildGraphNode(experience, index, sorted.length),
			),
			links: this.buildGraphLinks(sorted),
		};
	}

	private buildGraphNode(
		experience: Experience,
		index: number,
		total: number,
	): ExperienceGraphSnapshot["nodes"][number] {
		const angle = total > 0 ? (Math.PI * 2 * index) / total : 0;
		const ring = 0.28 + (index % 4) * 0.1;

		return {
			id: experience.id,
			label: experience.learning,
			type: experience.type,
			outcome: experience.outcome,
			domain: experience.domain,
			keywords: [...experience.keywords],
			associatedEntityIds: [...experience.associatedEntityIds],
			confidence: experience.confidence,
			importance: experience.importance,
			timeWeight: this.getTimeWeight(experience),
			x: 0.5 + Math.cos(angle) * ring,
			y: 0.5 + Math.sin(angle) * ring,
		};
	}

	private buildGraphLinks(experiences: Experience[]): ExperienceGraphLink[] {
		const links = new Map<string, ExperienceGraphLink>();
		const addLink = (link: ExperienceGraphLink): void => {
			const key = `${link.sourceId}:${link.targetId}:${link.type}`;
			const existing = links.get(key);
			if (!existing || existing.strength < link.strength) {
				links.set(key, link);
			}
		};

		for (const experience of experiences) {
			for (const relationship of this.relationshipManager.findRelationships(
				experience.id,
			)) {
				const type = this.toGraphLinkType(relationship.type);
				if (!type || !this.experiences.has(relationship.toId as UUID)) {
					continue;
				}
				addLink({
					sourceId: relationship.fromId as UUID,
					targetId: relationship.toId as UUID,
					type,
					strength: relationship.strength,
					reason: `stored ${relationship.type} relationship`,
					keywords: [],
				});
			}
		}

		for (let i = 0; i < experiences.length; i++) {
			const source = experiences[i];
			if (!source) {
				continue;
			}
			for (let j = i + 1; j < experiences.length; j++) {
				const target = experiences[j];
				if (!target) {
					continue;
				}
				const inferred = this.inferGraphLink(source, target);
				if (inferred) {
					addLink(inferred);
				}
			}
		}

		return Array.from(links.values())
			.sort((left, right) => right.strength - left.strength)
			.slice(0, GRAPH_MAX_LINKS);
	}

	private inferGraphLink(
		source: Experience,
		target: Experience,
	): ExperienceGraphLink | null {
		const sharedKeywords = this.getSharedKeywords(source, target);
		if (source.supersedes === target.id || target.supersedes === source.id) {
			const superseding = source.supersedes === target.id ? source : target;
			const superseded = superseding.id === source.id ? target : source;
			return {
				sourceId: superseding.id,
				targetId: superseded.id,
				type: "supersedes",
				strength: 0.95,
				reason: "explicit supersession",
				keywords: sharedKeywords,
			};
		}

		if (isDuplicateLearning(source.learning, target.learning)) {
			return {
				sourceId: source.id,
				targetId: target.id,
				type: "similar",
				strength: 0.9,
				reason: "duplicate or near-duplicate learning",
				keywords: sharedKeywords,
			};
		}

		if (
			source.domain === target.domain &&
			sharedKeywords.length >= GRAPH_KEYWORD_LINK_THRESHOLD
		) {
			return {
				sourceId: source.id,
				targetId: target.id,
				type: "supports",
				strength: Math.min(0.85, 0.4 + sharedKeywords.length * 0.1),
				reason: "shared domain keywords",
				keywords: sharedKeywords,
			};
		}

		const sharesEntities = source.associatedEntityIds.some((entityId) =>
			target.associatedEntityIds.includes(entityId),
		);
		if (sharesEntities && source.domain === target.domain) {
			return {
				sourceId: source.id,
				targetId: target.id,
				type: "co_occurs",
				strength: Math.min(0.8, 0.45 + sharedKeywords.length * 0.08),
				reason: "same associated entity and domain",
				keywords: sharedKeywords,
			};
		}

		return null;
	}

	private toGraphLinkType(type: string): ExperienceGraphLinkType | null {
		switch (type) {
			case "contradicts":
			case "supports":
			case "supersedes":
				return type;
			case "related":
				return "similar";
			default:
				return null;
		}
	}

	private getSharedKeywords(left: Experience, right: Experience): string[] {
		const rightKeywords = new Set(right.keywords);
		return left.keywords.filter((keyword) => rightKeywords.has(keyword));
	}

	private getTimeWeight(experience: Experience): number {
		const ageDays = Math.max(
			0,
			(Date.now() - experience.createdAt) / (24 * 60 * 60 * 1000),
		);
		return 1 / (1 + ageDays / 30);
	}

	private selectPrimaryExperience(experiences: Experience[]): Experience {
		return [...experiences].sort((left, right) => {
			const scoreLeft =
				left.importance * 0.4 +
				left.confidence * 0.4 +
				this.getTimeWeight(left) * 0.1 +
				Math.min(1, left.accessCount / 10) * 0.1;
			const scoreRight =
				right.importance * 0.4 +
				right.confidence * 0.4 +
				this.getTimeWeight(right) * 0.1 +
				Math.min(1, right.accessCount / 10) * 0.1;
			return scoreRight - scoreLeft;
		})[0] as Experience;
	}

	private areAlreadyDedupeLinked(left: Experience, right: Experience): boolean {
		return (
			left.supersedes === right.id ||
			right.supersedes === left.id ||
			(left.mergedExperienceIds?.includes(right.id) ?? false) ||
			(right.mergedExperienceIds?.includes(left.id) ?? false)
		);
	}

	private async mergeDuplicateExperience(
		primaryId: UUID,
		duplicateId: UUID,
		deleteDuplicate: boolean,
	): Promise<void> {
		const primary = this.experiences.get(primaryId);
		const duplicate = this.experiences.get(duplicateId);
		if (!primary || !duplicate) {
			return;
		}

		const merged: Experience = {
			...primary,
			confidence: Math.max(primary.confidence, duplicate.confidence),
			importance: Math.max(primary.importance, duplicate.importance),
			accessCount: primary.accessCount + duplicate.accessCount,
			lastAccessedAt: Math.max(
				primary.lastAccessedAt ?? primary.updatedAt,
				duplicate.lastAccessedAt ?? duplicate.updatedAt,
			),
			updatedAt: Date.now(),
			tags: this.dedupeStrings([...primary.tags, ...duplicate.tags]),
			keywords: this.dedupeStrings([
				...primary.keywords,
				...duplicate.keywords,
			]),
			associatedEntityIds: this.asUuidArray([
				...primary.associatedEntityIds,
				...duplicate.associatedEntityIds,
			]),
			sourceMessageIds: this.asOptionalUuidArray([
				...(primary.sourceMessageIds ?? []),
				...(duplicate.sourceMessageIds ?? []),
			]),
			relatedExperiences: this.asOptionalUuidArray(
				[
					...(primary.relatedExperiences ?? []),
					...(duplicate.relatedExperiences ?? []),
					duplicate.id,
				].filter((id) => id !== primary.id),
			),
			mergedExperienceIds: this.asOptionalUuidArray([
				...(primary.mergedExperienceIds ?? []),
				duplicate.id,
				...(duplicate.mergedExperienceIds ?? []),
			]),
		};

		await this.saveExperienceToMemory(merged);
		this.setExperience(merged);

		if (deleteDuplicate) {
			await this.deleteExperience(duplicate.id);
			return;
		}

		const superseded: Experience = {
			...duplicate,
			confidence: Math.min(duplicate.confidence, 0.4),
			updatedAt: Date.now(),
			supersedes: primary.id,
			relatedExperiences: this.asOptionalUuidArray([
				...(duplicate.relatedExperiences ?? []),
				primary.id,
			]),
		};
		await this.saveExperienceToMemory(superseded);
		this.setExperience(superseded);
	}

	async analyzeExperiences(
		domain?: string,
		type?: ExperienceType,
	): Promise<ExperienceAnalysis> {
		const experiences = await this.queryExperiences({
			domain: domain ? [domain] : undefined,
			type: type ? [type] : undefined,
			limit: 100,
		});

		if (experiences.length === 0) {
			return {
				pattern: "No experiences found for analysis",
				frequency: 0,
				reliability: 0,
				alternatives: [],
				recommendations: [],
			};
		}

		const learnings = experiences.map((exp) => exp.learning);
		const commonWords = this.findCommonPatterns(learnings);

		const avgConfidence =
			experiences.reduce((sum, exp) => sum + exp.confidence, 0) /
			experiences.length;
		const outcomeConsistency = this.calculateOutcomeConsistency(experiences);
		const reliability = (avgConfidence + outcomeConsistency) / 2;

		const alternatives = this.extractAlternatives(experiences);
		const recommendations = this.generateRecommendations(
			experiences,
			reliability,
		);

		return {
			pattern:
				commonWords.length > 0
					? `Common patterns: ${commonWords.join(", ")}`
					: "No clear patterns detected",
			frequency: experiences.length,
			reliability,
			alternatives,
			recommendations,
		};
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) return 0;

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			const valueA = a[i] ?? 0;
			const valueB = b[i] ?? 0;
			dotProduct += valueA * valueB;
			normA += valueA * valueA;
			normB += valueB * valueB;
		}

		if (normA === 0 || normB === 0) return 0;
		return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	private findCommonPatterns(texts: string[]): string[] {
		const wordFreq = new Map<string, number>();

		for (const text of texts) {
			const words = text.toLowerCase().split(/\s+/);
			for (const word of words) {
				if (word.length > 3) {
					wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
				}
			}
		}

		const threshold = texts.length * 0.3;
		return Array.from(wordFreq.entries())
			.filter(([_, count]) => count >= threshold)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([word]) => word);
	}

	private calculateOutcomeConsistency(experiences: Experience[]): number {
		if (experiences.length === 0) return 0;

		const outcomeCounts = new Map<OutcomeType, number>();
		for (const exp of experiences) {
			outcomeCounts.set(exp.outcome, (outcomeCounts.get(exp.outcome) || 0) + 1);
		}

		const maxCount = Math.max(...outcomeCounts.values());
		return maxCount / experiences.length;
	}

	private extractAlternatives(experiences: Experience[]): string[] {
		const alternatives = new Set<string>();

		for (const exp of experiences) {
			if (exp.type === ExperienceType.CORRECTION && exp.correctedBelief) {
				alternatives.add(exp.correctedBelief);
			}
			if (
				exp.outcome === OutcomeType.NEGATIVE &&
				exp.learning.includes("instead")
			) {
				const match = exp.learning.match(/instead\s+(.+?)(?:\.|$)/i);
				const alternative = match?.[1]?.trim();
				if (alternative) {
					alternatives.add(alternative);
				}
			}
		}

		return Array.from(alternatives).slice(0, 5);
	}

	private generateRecommendations(
		experiences: Experience[],
		reliability: number,
	): string[] {
		const recommendations: string[] = [];

		if (reliability > 0.8) {
			recommendations.push("Continue using successful approaches");
			recommendations.push("Document and share these reliable methods");
		} else if (reliability > 0.6) {
			recommendations.push("Continue using successful approaches with caution");
			recommendations.push("Monitor for potential issues");
			recommendations.push("Consider backup strategies");
		} else if (reliability > 0.4) {
			recommendations.push("Review and improve current approaches");
			recommendations.push("Investigate failure patterns");
			recommendations.push("Consider alternative methods");
		} else {
			recommendations.push("Significant changes needed to current approach");
			recommendations.push("Analyze failure causes thoroughly");
			recommendations.push("Seek alternative solutions");
		}

		const failureTypes = new Map<string, number>();
		experiences
			.filter((e) => e.outcome === OutcomeType.NEGATIVE)
			.forEach((e) => {
				const key = e.learning.toLowerCase();
				failureTypes.set(key, (failureTypes.get(key) || 0) + 1);
			});

		if (failureTypes.size > 0) {
			const mostCommonFailure = Array.from(failureTypes.entries()).sort(
				(a, b) => b[1] - a[1],
			)[0];

			if (mostCommonFailure && mostCommonFailure[1] > 1) {
				recommendations.push(
					`Address recurring issue: ${mostCommonFailure[0]}`,
				);
			}
		}

		const domains = new Set(experiences.map((e) => e.domain));
		if (domains.has("shell")) {
			recommendations.push("Verify command syntax and permissions");
		}
		if (domains.has("coding")) {
			recommendations.push("Test thoroughly before deployment");
		}
		if (domains.has("network")) {
			recommendations.push("Implement retry logic and error handling");
		}

		return recommendations.slice(0, 5);
	}

	async stop(): Promise<void> {
		logger.info("[ExperienceService] Stopping...");

		// Stop the persistence timer
		if (this.persistTimer) {
			clearInterval(this.persistTimer);
			this.persistTimer = null;
		}
		if (this.maintenanceTimer) {
			clearInterval(this.maintenanceTimer);
			this.maintenanceTimer = null;
		}

		// Final persistence is part of shutdown correctness: callers must know when
		// state could not be made durable before the service stopped.
		const experiencesToSave = Array.from(this.experiences.values());
		await Promise.all(
			experiencesToSave.map((experience) =>
				this.saveExperienceToMemory(experience),
			),
		);
		this.dirtyExperiences.clear();
		logger.info(
			`[ExperienceService] Saved ${experiencesToSave.length} experiences`,
		);
	}
}
