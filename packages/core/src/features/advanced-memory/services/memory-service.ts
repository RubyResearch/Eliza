/**
 * Runs the advanced-memory capability's `memory` service: extraction and
 * retrieval of long-term persistent facts. Registered by
 * createAdvancedMemoryPlugin and consumed by the long-term-memory provider and
 * evaluator. Retained dialogue is never replaced by a rolling summary.
 *
 * Persistence is delegated to a MemoryStorageProvider discovered at runtime via
 * getService("memoryStorage") — supplied by a database plugin. When none is
 * registered the service degrades gracefully: reads return empty, writes throw a
 * descriptive error, and storage-backed features stay disabled. Thresholds and
 * cadences come from runtime.getSetting (MEMORY_* keys) at initialize().
 *
 * Long-term reads are identity-cluster aware — they fan out across related
 * entity IDs and dedupe by memory id so a cluster of N members yields distinct
 * results rather than N copies. Vector search uses a native provider override
 * when available and otherwise falls back to an in-process cosine scan (or to
 * recent memories when vector search is disabled). The per-room session and
 * per-(entity,room) extraction-checkpoint maps are capped FIFO to bound memory
 * over long-lived processes. Also exports formatLongTermMemories, a pure helper
 * that renders memories as a category-grouped markdown block.
 */

import { ElizaError } from "../../../errors.ts";
import {
	getRelatedEntityIds,
	resolvePrimaryEntityId,
} from "../../../identity-clusters.ts";
import { logger } from "../../../logger.ts";
import {
	type IAgentRuntime,
	Service,
	type ServiceTypeName,
	type UUID,
} from "../../../types/index.ts";
import type { MemoryStorageProvider } from "../../../types/memory-storage.ts";
import { isActiveMemoryEvidence } from "../../../utils/extraction-evidence.ts";
import type {
	LongTermMemory,
	LongTermMemoryCategory,
	MemoryConfig,
} from "../types.ts";

function memoryCreatedAtMs(memory: LongTermMemory): number {
	const value = memory.createdAt;
	const timestamp =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMemoryStorageProvider(
	service: unknown,
): service is MemoryStorageProvider {
	return (
		typeof service === "object" &&
		service !== null &&
		"storeLongTermMemory" in service &&
		typeof service.storeLongTermMemory === "function"
	);
}

export class MemoryService extends Service {
	static serviceType: ServiceTypeName = "memory" as ServiceTypeName;

	private memoryConfig: MemoryConfig;
	private lastExtractionCheckpoints: Map<string, number>;
	// The checkpoint map grows one entry per distinct (entity,room) pair. Cap it
	// FIFO; an evicted checkpoint is re-fetched from runtime.getCache on miss.
	private static readonly MAX_CHECKPOINT_ENTRIES = 5000;

	/** Resolved at initialize(). null means no storage backend is available. */
	private storage: MemoryStorageProvider | null = null;

	capabilityDescription =
		"Memory management with complete retained dialogue and long-term persistent facts";

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.lastExtractionCheckpoints = new Map();
		this.memoryConfig = {
			longTermExtractionEnabled: true,
			longTermVectorSearchEnabled: false,
			longTermConfidenceThreshold: 0.85,
			longTermExtractionThreshold: 30,
			longTermExtractionInterval: 10,
		};
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new MemoryService(runtime);
		await service.initialize(runtime);
		return service;
	}

	async stop(): Promise<void> {
		this.lastExtractionCheckpoints.clear();
		logger.info({ src: "service:memory" }, "MemoryService stopped");
	}

	private capSessionMap(map: Map<string, number>): void {
		while (map.size > MemoryService.MAX_CHECKPOINT_ENTRIES) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;

		// Discover the storage provider registered by a database plugin.
		// If none exists, storage-backed features are disabled.
		let provider: MemoryStorageProvider | null = null;
		if (runtime.hasService("memoryStorage")) {
			try {
				const loaded = await runtime.getServiceLoadPromise("memoryStorage");
				provider = isMemoryStorageProvider(loaded) ? loaded : null;
			} catch (error) {
				// error-policy:J4 advanced memory remains explicitly unavailable when
				// its optional storage service cannot start; report the operational failure.
				runtime.reportError("MemoryService.initializeStorage", error);
				const err = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ src: "service:memory", agentId: runtime.agentId, err },
					"MemoryStorageProvider failed to start — storage-backed advanced memory disabled",
				);
			}
		}
		if (!provider) {
			logger.warn(
				{ src: "service:memory", agentId: runtime.agentId },
				"No MemoryStorageProvider found — long-term memory disabled. " +
					"Register a memoryStorage service from your database plugin to enable them.",
			);
		}
		this.storage = provider;

		// Read config overrides from environment / character settings.
		const longTermEnabled = runtime.getSetting("MEMORY_LONG_TERM_ENABLED");
		if (longTermEnabled === "false" || longTermEnabled === false) {
			this.memoryConfig.longTermExtractionEnabled = false;
		} else if (longTermEnabled === "true" || longTermEnabled === true) {
			this.memoryConfig.longTermExtractionEnabled = true;
		}

		const confidenceThreshold = runtime.getSetting(
			"MEMORY_CONFIDENCE_THRESHOLD",
		);
		if (confidenceThreshold) {
			this.memoryConfig.longTermConfidenceThreshold = Number.parseFloat(
				String(confidenceThreshold),
			);
		}

		const extractionThreshold = runtime.getSetting(
			"MEMORY_EXTRACTION_THRESHOLD",
		);
		if (extractionThreshold) {
			this.memoryConfig.longTermExtractionThreshold = Number.parseInt(
				String(extractionThreshold),
				10,
			);
		}

		const extractionInterval = runtime.getSetting("MEMORY_EXTRACTION_INTERVAL");
		if (
			extractionInterval !== undefined &&
			extractionInterval !== null &&
			extractionInterval !== ""
		) {
			// This value is a DIVISOR in shouldRunExtraction:
			//   Math.floor(currentMessageCount / interval) * interval
			// `Number.parseInt` truncates, so "0.5" became 0 and the checkpoint
			// became NaN — and every comparison against NaN is false, so
			// extraction silently never ran again. A negative value is the
			// mirror failure: the checkpoint always exceeds the last one, so it
			// runs on every message. Only a positive whole number is usable;
			// anything else keeps the documented default.
			const raw = String(extractionInterval).trim();
			const parsed = /^\+?\d+$/.test(raw) ? Number(raw) : Number.NaN;
			if (Number.isSafeInteger(parsed) && parsed > 0) {
				this.memoryConfig.longTermExtractionInterval = parsed;
			} else {
				logger.warn(
					`[MemoryService] ignoring MEMORY_EXTRACTION_INTERVAL=${JSON.stringify(String(extractionInterval))}; expected a positive whole number, keeping ${this.memoryConfig.longTermExtractionInterval}`,
				);
			}
		}

		logger.debug(
			{
				longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
				extractionThreshold: this.memoryConfig.longTermExtractionThreshold,
				extractionInterval: this.memoryConfig.longTermExtractionInterval,
				confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
				storageAvailable: !!this.storage,
			},
			"MemoryService initialized",
			{ src: "service:memory" },
		);
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private async getStorage(): Promise<MemoryStorageProvider | null> {
		if (!this.storage && this.runtime.hasService("memoryStorage")) {
			try {
				const loaded =
					await this.runtime.getServiceLoadPromise("memoryStorage");
				this.storage = isMemoryStorageProvider(loaded) ? loaded : null;
			} catch (error) {
				// error-policy:J4 lazy storage resolution preserves the service's
				// unavailable state, while the failure remains visible to the agent.
				this.runtime.reportError("MemoryService.resolveStorage", error);
				const err = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ src: "service:memory", agentId: this.runtime.agentId, err },
					"MemoryStorageProvider lookup failed during lazy resolution",
				);
			}
		}
		return this.storage;
	}

	private async requireStorage(op: string): Promise<MemoryStorageProvider> {
		const storage = await this.getStorage();
		if (!storage) {
			throw new Error(
				`MemoryStorageProvider is not registered — cannot ${op} (register a storage service or disable advancedMemory).`,
			);
		}
		return storage;
	}

	getConfig(): MemoryConfig {
		return { ...this.memoryConfig };
	}

	updateConfig(updates: Partial<MemoryConfig>): void {
		this.memoryConfig = { ...this.memoryConfig, ...updates };
	}

	private getExtractionKey(entityId: UUID, roomId: UUID): string {
		return `memory:extraction:${entityId}:${roomId}`;
	}

	async getLastExtractionCheckpoint(
		entityId: UUID,
		roomId: UUID,
	): Promise<number> {
		const key = this.getExtractionKey(entityId, roomId);

		const cached = this.lastExtractionCheckpoints.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const checkpoint = await this.runtime.getCache<number>(key);
		const concurrentlyWritten = this.lastExtractionCheckpoints.get(key);
		if (concurrentlyWritten !== undefined) {
			return concurrentlyWritten;
		}
		const messageCount = checkpoint ?? 0;
		this.lastExtractionCheckpoints.set(key, messageCount);
		this.capSessionMap(this.lastExtractionCheckpoints);
		return messageCount;
	}

	async setLastExtractionCheckpoint(
		entityId: UUID,
		roomId: UUID,
		messageCount: number,
	): Promise<void> {
		const key = this.getExtractionKey(entityId, roomId);
		if (!(await this.runtime.setCache(key, messageCount))) {
			throw new ElizaError("Extraction checkpoint was not persisted", {
				code: "MEMORY_EXTRACTION_CHECKPOINT_FAILED",
			});
		}
		this.lastExtractionCheckpoints.set(key, messageCount);
		this.capSessionMap(this.lastExtractionCheckpoints);
		logger.debug(
			{ src: "service:memory" },
			`Set extraction checkpoint for ${entityId} in room ${roomId} at count ${messageCount}`,
		);
	}

	async shouldRunExtraction(
		entityId: UUID,
		roomId: UUID,
		currentMessageCount: number,
	): Promise<boolean> {
		const threshold = this.memoryConfig.longTermExtractionThreshold;
		const interval = this.memoryConfig.longTermExtractionInterval;

		if (currentMessageCount < threshold) {
			return false;
		}

		const lastCheckpoint = await this.getLastExtractionCheckpoint(
			entityId,
			roomId,
		);
		const currentCheckpoint =
			Math.floor(currentMessageCount / interval) * interval;
		const shouldRun =
			currentMessageCount >= threshold && currentCheckpoint > lastCheckpoint;

		logger.debug(
			{
				entityId,
				roomId,
				currentMessageCount,
				threshold,
				interval,
				lastCheckpoint,
				currentCheckpoint,
				shouldRun,
			},
			"Extraction check",
			{ src: "service:memory" },
		);

		return shouldRun;
	}

	// ── Storage operations (delegated to provider) ──────────────────────

	/** Select the legacy evaluator path until a replay-safe backend is resolved. */
	get supportsIncrementalExtraction(): boolean {
		return this.storage?.supportsIdempotentWrites === true;
	}

	async ensureIncrementalExtractionSupported(): Promise<void> {
		const storage = await this.requireStorage("process incremental extraction");
		if (storage.supportsIdempotentWrites !== true) {
			throw new ElizaError(
				"Memory storage does not support replay-safe incremental extraction",
				{
					code: "MEMORY_INCREMENTAL_STORAGE_UNSUPPORTED",
				},
			);
		}
	}

	async storeLongTermMemory(
		memory: Omit<
			LongTermMemory,
			"id" | "createdAt" | "updatedAt" | "accessCount"
		> & { id?: UUID },
	): Promise<LongTermMemory> {
		if (memory.id) await this.ensureIncrementalExtractionSupported();
		const entityId = await resolvePrimaryEntityId(
			this.runtime,
			memory.entityId,
		);
		const stored = await (
			await this.requireStorage("store long-term memory")
		).storeLongTermMemory({ ...memory, entityId });
		logger.info(
			{ src: "service:memory" },
			`Stored long-term memory: ${stored.category} for entity ${stored.entityId}`,
		);
		return stored;
	}

	async getLongTermMemories(
		entityId: UUID,
		category?: LongTermMemoryCategory,
		limit?: number,
		options: { includeInactive?: boolean } = {},
	): Promise<LongTermMemory[]> {
		if (limit !== undefined && limit <= 0) return [];
		const storage = await this.getStorage();
		if (!storage) return [];
		const entityIds = await getRelatedEntityIds(this.runtime, entityId);
		const memories = (
			await Promise.all(
				entityIds.map((relatedEntityId) =>
					storage.getLongTermMemories(this.runtime.agentId, relatedEntityId, {
						category,
					}),
				),
			)
		).flat();
		// The storage layer already expands the full identity cluster per entity,
		// so fanning out across related entity IDs returns the same records N times.
		// Dedupe by id so a cluster of N members yields `limit` distinct memories,
		// not `limit` copies of the same one.
		const deduped = new Map<UUID, LongTermMemory>();
		for (const memory of memories) {
			if (!options.includeInactive && !isActiveMemoryEvidence(memory)) continue;
			if (!deduped.has(memory.id)) deduped.set(memory.id, memory);
		}
		const sorted = [...deduped.values()].sort(
			(left, right) => memoryCreatedAtMs(right) - memoryCreatedAtMs(left),
		);
		return limit === undefined ? sorted : sorted.slice(0, limit);
	}

	async updateLongTermMemory(
		id: UUID,
		entityId: UUID,
		updates: Partial<
			Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
		>,
	): Promise<void> {
		const storage = await this.requireStorage("update long-term memory");
		await storage.updateLongTermMemory(
			id,
			this.runtime.agentId,
			entityId,
			updates,
		);
		logger.info(
			{ src: "service:memory" },
			`Updated long-term memory: ${id} for entity ${entityId}`,
		);
	}

	async deleteLongTermMemory(id: UUID, entityId: UUID): Promise<void> {
		const storage = await this.requireStorage("delete long-term memory");
		await storage.deleteLongTermMemory(id, this.runtime.agentId, entityId);
		logger.info(
			{ src: "service:memory" },
			`Deleted long-term memory: ${id} for entity ${entityId}`,
		);
	}

	// ── Vector search (JS fallback; provider can override with native) ──

	async searchLongTermMemories(
		entityId: UUID,
		queryEmbedding: number[],
		limit = 5,
		matchThreshold = 0.7,
	): Promise<LongTermMemory[]> {
		if (limit <= 0) return [];
		if (!this.memoryConfig.longTermVectorSearchEnabled) {
			logger.warn(
				{ src: "service:memory" },
				"Vector search is not enabled, falling back to recent memories",
			);
			return this.getLongTermMemories(entityId, undefined, limit);
		}

		try {
			const candidates = await this.getLongTermMemories(
				entityId,
				undefined,
				200,
			);
			const scored: Array<{ memory: LongTermMemory; similarity: number }> = [];
			const invalidSimilarityMemoryIds: string[] = [];
			for (const memory of candidates) {
				if ((memory.embedding?.length ?? 0) === 0) continue;
				const similarity = cosineSimilarity(
					memory.embedding ?? [],
					queryEmbedding,
				);
				if (!Number.isFinite(similarity)) {
					invalidSimilarityMemoryIds.push(memory.id);
					continue;
				}
				if (similarity < matchThreshold) continue;
				if (scored.length < limit) {
					scored.push({ memory, similarity });
					scored.sort((a, b) => {
						const aSim = Number.isFinite(a.similarity) ? a.similarity : 0;
						const bSim = Number.isFinite(b.similarity) ? b.similarity : 0;
						return bSim - aSim;
					});
					continue;
				}
				if (similarity <= scored[scored.length - 1]?.similarity) continue;
				let index = 0;
				while (index < scored.length && scored[index].similarity > similarity) {
					index += 1;
				}
				scored.splice(index, 0, { memory, similarity });
				if (scored.length > limit) {
					scored.pop();
				}
			}
			if (invalidSimilarityMemoryIds.length > 0) {
				this.runtime.reportError(
					"MemoryService.vectorSearch.invalidSimilarity",
					new ElizaError(
						"Long-term memory vector search produced non-finite similarity",
						{
							code: "MEMORY_VECTOR_SIMILARITY_NON_FINITE",
							context: {
								entityId,
								memoryIds: invalidSimilarityMemoryIds,
							},
						},
					),
					{ entityId, memoryIds: invalidSimilarityMemoryIds },
				);
			}
			return scored.map((x) => ({
				...x.memory,
				similarity: x.similarity,
			}));
		} catch (error) {
			// error-policy:J4 semantic retrieval may explicitly degrade to recent
			// memories, but the loss of vector search quality must remain observable.
			this.runtime.reportError("MemoryService.vectorSearch", error, {
				entityId,
				limit,
			});
			logger.warn(
				{ error },
				"Vector search failed, falling back to recent memories",
				{ src: "service:memory" },
			);
			return this.getLongTermMemories(entityId, undefined, limit);
		}
	}

	// ── Formatting ──────────────────────────────────────────────────────

	async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
		const memories = await this.getLongTermMemories(entityId);
		return formatLongTermMemories(memories);
	}
}

/**
 * Render long-term memories as a category-grouped markdown string. Pure helper
 * so callers that already have the memories (e.g. the long-term provider) can
 * format them without a second storage round-trip.
 */
export function formatLongTermMemories(memories: LongTermMemory[]): string {
	if (memories.length === 0) return "";

	const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();
	for (const memory of memories) {
		const existing = grouped.get(memory.category);
		if (existing) {
			existing.push(memory);
		} else {
			grouped.set(memory.category, [memory]);
		}
	}

	const sections: string[] = [];
	for (const [category, categoryMemories] of grouped.entries()) {
		const categoryName = category
			.split("_")
			.map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
		const items = categoryMemories.map((m) => `- ${m.content}`).join("\n");
		sections.push(`**${categoryName}**:\n${items}`);
	}

	return sections.join("\n\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
