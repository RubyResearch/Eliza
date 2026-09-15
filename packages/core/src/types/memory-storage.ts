/**
 * Memory Storage Provider interface.
 *
 * Abstracts advanced-memory storage so MemoryService in core has zero
 * database or ORM dependencies. Database plugins (plugin-sql, etc.)
 * register a service that implements this interface. MemoryService
 * discovers it at init time via runtime.getService("memoryStorage").
 *
 * If no provider is registered, MemoryService gracefully disables
 * storage-backed features. Non-SQL adapters (in-memory, file-based)
 * simply don't register one.
 */

import type {
	LongTermMemory,
	LongTermMemoryCategory,
} from "../features/advanced-memory/types.ts";
import type { UUID } from "./primitives.ts";

export interface MemoryStorageProvider {
	// ── Long-term memories ──────────────────────────────────────────────
	/** Supplied IDs are insert-once identities; replay returns the original row. */
	readonly supportsIdempotentWrites?: true;

	storeLongTermMemory(
		memory: Omit<
			LongTermMemory,
			"id" | "createdAt" | "updatedAt" | "accessCount"
		> & { id?: UUID },
	): Promise<LongTermMemory>;

	getLongTermMemories(
		agentId: UUID,
		entityId: UUID,
		opts?: { category?: LongTermMemoryCategory; limit?: number },
	): Promise<LongTermMemory[]>;

	updateLongTermMemory(
		id: UUID,
		agentId: UUID,
		entityId: UUID,
		updates: Partial<
			Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
		>,
	): Promise<void>;

	deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void>;
}
