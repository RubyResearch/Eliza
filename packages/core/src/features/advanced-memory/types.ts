/**
 * Type contracts for the advanced-memory capability: the LongTermMemoryCategory
 * enum and LongTermMemory record shape, the MemoryConfig knobs that drive
 * extraction cadence, and the MemoryExtraction model-output shape. Shared by MemoryService,
 * the memory providers and evaluators, and the MemoryStorageProvider contract in
 * types/memory-storage.ts, which re-imports these as its persistence boundary.
 */

import type { JsonPrimitive, JsonValue, UUID } from "../../types/primitives.ts";

export type { JsonPrimitive, JsonValue };

export enum LongTermMemoryCategory {
	EPISODIC = "episodic",
	SEMANTIC = "semantic",
	PROCEDURAL = "procedural",
}

export interface LongTermMemory {
	id: UUID;
	agentId: UUID;
	entityId: UUID;
	category: LongTermMemoryCategory;
	content: string;
	metadata?: Record<string, JsonValue>;
	embedding?: number[];
	confidence?: number;
	source?: string;
	createdAt: Date;
	updatedAt: Date;
	lastAccessedAt?: Date;
	accessCount?: number;
	similarity?: number;
}

export interface MemoryConfig {
	longTermExtractionEnabled: boolean;
	longTermVectorSearchEnabled: boolean;
	longTermConfidenceThreshold: number;
	longTermExtractionThreshold: number;
	longTermExtractionInterval: number;
}

export interface MemoryExtraction {
	category: LongTermMemoryCategory;
	content: string;
	confidence: number;
	sourceMessageIds?: UUID[];
	metadata?: Record<string, JsonValue>;
}

export type MemoryServiceTypeName = "memory";
