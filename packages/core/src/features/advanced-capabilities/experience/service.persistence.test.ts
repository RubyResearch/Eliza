/** Verifies experience hydration and mutations remain atomic with durable memory writes. */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory } from "../../../types/memory.ts";
import type { UUID } from "../../../types/primitives.ts";
import { ExperienceService } from "./service.ts";
import { ExperienceType, OutcomeType } from "./types.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const EXPERIENCE_ID = "00000000-0000-0000-0000-00000000e001" as UUID;

function storedExperience(): Memory {
	return {
		id: EXPERIENCE_ID,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		createdAt: 1_000,
		content: {
			text: "Experience: persisted learning",
			type: "experience",
			data: {
				id: EXPERIENCE_ID,
				agentId: AGENT_ID,
				type: ExperienceType.LEARNING,
				outcome: OutcomeType.NEUTRAL,
				context: "ctx",
				action: "act",
				result: "res",
				learning: "persisted learning",
				domain: "general",
				tags: ["test"],
				keywords: ["persisted"],
				associatedEntityIds: [],
				confidence: 0.8,
				importance: 0.7,
				createdAt: 1_000,
				updatedAt: 1_000,
				accessCount: 0,
				embedding: [0.1, 0.2],
			},
		},
		embedding: [0.1, 0.2],
	};
}

describe("ExperienceService persistence boundaries", () => {
	it("retains a retired experience across hydration but excludes it from normal and related retrieval", async () => {
		let stored = storedExperience();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => [stored]),
			getMemoryById: vi.fn(async () => stored),
			upsertMemory: vi.fn(async (row) => {
				stored = structuredClone(row);
			}),
		});
		const service = new ExperienceService(runtime);
		await service.recordExperience({
			id: EXPERIENCE_ID,
			learning: "unused existing ID",
		});
		await service.updateExperience(EXPERIENCE_ID, {
			extractionStatus: "source_invalidated",
			extractionReconciliationId: "repair-1",
		});
		expect(await service.listExperiences()).toEqual([]);
		expect(await service.getExperience(EXPERIENCE_ID)).toMatchObject({
			learning: "persisted learning",
			extractionStatus: "source_invalidated",
		});
		const restarted = new ExperienceService(runtime);
		await restarted.recordExperience({
			id: EXPERIENCE_ID,
			learning: "unused existing ID",
		});
		expect(await restarted.listExperiences()).toEqual([]);
		expect(
			await restarted.listExperiences({ includeInactive: true }),
		).toHaveLength(1);
		expect(
			(await restarted.getExperience(EXPERIENCE_ID))
				?.extractionReconciliationId,
		).toBe("repair-1");
	});

	it("reuses a supplied ID without embedding or writing it again", async () => {
		const records = new Map<UUID, Memory>();
		const useModel = vi.fn(async () => [0.1, 0.2]);
		const upsertMemory = vi.fn(async (memory: Memory) => {
			if (!memory.id) throw new Error("Missing experience ID");
			records.set(memory.id, memory);
		});
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => []),
			getMemoryById: vi.fn(async (id) => records.get(id) ?? null),
			useModel,
			upsertMemory,
		});
		const service = new ExperienceService(runtime);
		const first = await service.recordExperience({
			id: EXPERIENCE_ID,
			learning: "Remember the verified lesson",
			extractionEvidenceId: "batch-1",
			sourceMessageRevisions: { message: "revision-1" },
		});
		const replay = await service.recordExperience({
			id: EXPERIENCE_ID,
			learning: "Do not overwrite",
		});
		expect(replay).toEqual(first);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(upsertMemory).toHaveBeenCalledTimes(1);
		const restarted = new ExperienceService(runtime);
		const persistedReplay = await restarted.recordExperience({
			id: EXPERIENCE_ID,
			learning: "Do not overwrite",
		});
		expect(persistedReplay).toMatchObject({
			id: EXPERIENCE_ID,
			learning: first.learning,
			extractionEvidenceId: "batch-1",
			sourceMessageRevisions: { message: "revision-1" },
		});
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(upsertMemory).toHaveBeenCalledTimes(1);
	});

	it("recovers a committed write after its acknowledgement fails", async () => {
		let stored: Memory | null = null;
		const failure = new Error("write acknowledgement lost");
		const upsertMemory = vi.fn(async (memory: Memory) => {
			stored = memory;
			throw failure;
		});
		const useModel = vi.fn(async () => [0.1, 0.2]);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemoryById: vi.fn(async () => stored),
			upsertMemory,
			useModel,
		});
		const service = new ExperienceService(runtime);
		await expect(
			service.recordExperience({
				id: EXPERIENCE_ID,
				learning: "durable lesson",
			}),
		).rejects.toBe(failure);
		await expect(
			service.recordExperience({
				id: EXPERIENCE_ID,
				learning: "durable lesson",
			}),
		).resolves.toMatchObject({
			id: EXPERIENCE_ID,
			learning: "durable lesson",
		});
		expect(upsertMemory).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("rejects a supplied ID belonging to another agent without exposing it", async () => {
		const useModel = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemoryById: vi.fn(async () => ({
				...storedExperience(),
				agentId: "00000000-0000-0000-0000-0000000000bb" as UUID,
			})),
			useModel,
		});
		const service = new ExperienceService(runtime);
		await expect(
			service.recordExperience({
				id: EXPERIENCE_ID,
				learning: "different agent",
			}),
		).rejects.toMatchObject({
			code: "EXPERIENCE_ID_CONFLICT",
		});
		expect(useModel).not.toHaveBeenCalled();
	});

	it("does not return a partially initialized service when hydration fails", async () => {
		const failure = new Error("experience table unavailable");
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => {
				throw failure;
			}),
		});

		await expect(ExperienceService.start(runtime)).rejects.toBe(failure);
	});

	it.each([
		{ vector: [] as number[], code: "EXPERIENCE_EMBEDDING_INVALID" },
		{ vector: [0, 0], code: "EXPERIENCE_EMBEDDING_INVALID" },
	])(
		"rejects invalid embeddings without caching the record",
		async ({ vector, code }) => {
			const upsertMemory = vi.fn(async () => undefined);
			const runtime = createMockRuntime({
				agentId: AGENT_ID,
				getMemories: vi.fn(async () => []),
				useModel: vi.fn(async () => vector),
				upsertMemory,
				reportError: vi.fn(),
			});
			const service = await ExperienceService.start(runtime);

			await expect(
				service.recordExperience({ learning: "never persisted" }),
			).rejects.toMatchObject({ code });
			await expect(service.listExperiences()).resolves.toEqual([]);
			expect(upsertMemory).not.toHaveBeenCalled();
			await service.stop();
		},
	);

	it("does not cache a record whose memory write failed", async () => {
		const failure = new Error("memory write failed");
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => []),
			useModel: vi.fn(async () => [0.1, 0.2]),
			upsertMemory: vi.fn(async () => {
				throw failure;
			}),
			reportError: vi.fn(),
		});
		const service = await ExperienceService.start(runtime);

		await expect(
			service.recordExperience({ learning: "never persisted" }),
		).rejects.toBe(failure);
		await expect(service.listExperiences()).resolves.toEqual([]);
		await service.stop();
	});

	it("keeps a cached record when its durable deletion fails", async () => {
		const failure = new Error("memory delete failed");
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => [storedExperience()]),
			upsertMemory: vi.fn(async () => undefined),
			deleteMemory: vi.fn(async () => {
				throw failure;
			}),
			reportError: vi.fn(),
		});
		const service = await ExperienceService.start(runtime);

		await expect(service.deleteExperience(EXPERIENCE_ID)).rejects.toBe(failure);
		await expect(service.getExperience(EXPERIENCE_ID)).resolves.toMatchObject({
			id: EXPERIENCE_ID,
		});
		await service.stop();
	});

	it("rejects shutdown when the final durable write fails", async () => {
		const failure = new Error("final memory write failed");
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemories: vi.fn(async () => [storedExperience()]),
			upsertMemory: vi.fn(async () => {
				throw failure;
			}),
			reportError: vi.fn(),
		});
		const service = await ExperienceService.start(runtime);

		await expect(service.stop()).rejects.toBe(failure);
	});
});
