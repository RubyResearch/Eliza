/**
 * Exercises vector persistence when a model becomes available after the embedding
 * service starts, using the real runtime registry, event bus, queue and adapter.
 */
import { expect, test } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { EventType } from "../types/events";
import { ModelType } from "../types/model";
import { EmbeddingGenerationService } from "./embedding";

test.each([ModelType.TEXT_EMBEDDING, ModelType.TEXT_EMBEDDING_BATCH])(
	"persists a new memory after late %s registration and detaches on stop",
	async (modelType) => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "Late embedding registration" }),
			adapter,
			logLevel: "fatal",
			enableAutonomy: false,
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const memory = {
			id: "976d2f6c-603c-4e2f-b04c-c358f08e483e" as const,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: runtime.agentId,
			content: { text: "The launch verification phrase is COPPER-FINCH-684." },
		};
		let calls = 0;
		const vector = Array.from({ length: 384 }, (_, i) => (i + 1) / 384);
		try {
			await runtime.createMemory(memory, "messages");
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				async () => "unrelated",
				"test",
			);
			expect(
				runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
			).toHaveLength(0);
			const embed = async () => {
				calls++;
				return modelType === ModelType.TEXT_EMBEDDING_BATCH ? [vector] : vector;
			};
			runtime.registerModel(modelType, embed, "test");
			// Registration events overlap while the first drain task is created.
			runtime.registerModel(modelType, embed, "second-provider");
			await expect
				.poll(
					() =>
						runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED)?.length,
				)
				.toBe(1);
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory,
				priority: "high",
			});
			const tasks = await runtime.getTasksByName("EMBEDDING_DRAIN");
			expect(tasks).toHaveLength(1);
			const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
			if (!worker || !tasks[0])
				throw new Error("Embedding drain was not registered");
			await worker.execute(runtime, {}, tasks[0]);
			await service.stop();
			expect((await runtime.getMemoryById(memory.id))?.embedding).toEqual(
				vector,
			);
			expect(calls).toBe(1);
			expect(
				runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
			).toHaveLength(0);
			expect(runtime.getEvent(EventType.MODEL_REGISTERED) ?? []).toHaveLength(
				0,
			);
			runtime.registerModel(modelType, async () => vector, "replacement");
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory,
				priority: "high",
			});
			expect(calls).toBe(1);
			expect(service.getQueueSize()).toBe(0);
		} finally {
			await service.stop();
			await runtime.close();
		}
	},
);

test("a stopped waiting service never activates when a provider arrives", async () => {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "Stopped embedding waiter" }),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	const service = await EmbeddingGenerationService.start(runtime);
	try {
		await service.stop();
		runtime.registerModel(ModelType.TEXT_EMBEDDING, async () => [1], "late");
		expect(
			runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
		).toHaveLength(0);
		expect(await runtime.getTasksByName("EMBEDDING_DRAIN")).toHaveLength(0);
	} finally {
		await service.stop();
		await runtime.close();
	}
});
