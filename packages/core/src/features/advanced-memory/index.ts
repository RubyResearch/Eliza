/**
 * Entry point for the advanced-memory capability. `createAdvancedMemoryPlugin`
 * assembles the `memory` plugin from long-term extraction, direct-text history
 * review, the complete long-term-recall provider and `MemoryService`. The
 * file also re-exports the capability's public surface — those
 * evaluators/providers, the backend-agnostic schema definitions, the service,
 * and its types.
 */

import { historyRetentionEvaluator } from "../../services/history-retention.ts";
import type { IAgentRuntime, Plugin } from "../../types/index.ts";
import { memoryItems } from "./evaluators/index.ts";
import { longTermMemoryProvider } from "./providers/index.ts";
import { MemoryService } from "./services/memory-service.ts";

export {
	longTermMemoryEvaluator,
	memoryItems,
} from "./evaluators/index.ts";
export { longTermMemoryProvider } from "./providers/index.ts";
// Export the abstract, backend-agnostic schema definitions
export * from "./schemas/index.ts";
export { MemoryService } from "./services/memory-service.ts";
export {
	type LongTermMemory,
	LongTermMemoryCategory,
	type MemoryConfig,
	type MemoryExtraction,
	type MemoryServiceTypeName,
} from "./types.ts";

/**
 * Create the advanced-memory plugin.
 *
 * No database-specific arguments needed. MemoryService discovers a
 * MemoryStorageProvider at runtime via runtime.getService("memoryStorage").
 * If none is registered by a database plugin, storage-backed features
 * gracefully disable.
 */
export function createAdvancedMemoryPlugin(): Plugin {
	return {
		name: "memory",
		description:
			"Memory management with complete retained dialogue and long-term persistent memory",
		services: [MemoryService],
		evaluators: [...memoryItems, historyRetentionEvaluator],
		providers: [longTermMemoryProvider],
		async dispose(runtime: IAgentRuntime) {
			const svc = runtime.getService<MemoryService>(MemoryService.serviceType);
			await svc?.stop();
		},
	};
}
