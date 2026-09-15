/**
 * Exercises `EmbeddingGenerationService`: drain configuration (batch vs per-item,
 * fast-shutdown) and the `processBatch` path — one batch call with per-id
 * write-back, empty-vector and count-mismatch failure handling, and isolated
 * per-item fallback. Runs against a mock runtime with stubbed embedding models.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { EmbeddingGenerationService } from "./embedding";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

interface RuntimeMockOpts {
	batch: boolean;
	embedHandler?: (params: unknown) => Promise<unknown>;
	batchHandler?: (params: { texts: string[] }) => Promise<number[][]>;
	updateMemory?: (params: { id: string; embedding: number[] }) => Promise<void>;
}

function makeRuntime(opts: RuntimeMockOpts): IAgentRuntime {
	const models: Record<string, unknown> = {
		[ModelType.TEXT_EMBEDDING]:
			opts.embedHandler ?? (() => Promise.resolve([0.1])),
	};
	if (opts.batch) {
		models[ModelType.TEXT_EMBEDDING_BATCH] =
			opts.batchHandler ?? (() => Promise.resolve([[0.1]]));
	}
	const noop = () => {};
	return {
		reportError: vi.fn(),
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) => models[type],
		useModel: (type: string, params: unknown) => {
			const handler = models[type] as
				| ((p: unknown) => Promise<unknown>)
				| undefined;
			if (!handler) {
				throw new Error(`No handler for ${type}`);
			}
			return handler(params);
		},
		updateMemory: opts.updateMemory ?? (async () => {}),
		log: async () => {},
		emitEvent: async () => {},
		registerEvent: vi.fn(),
		unregisterEvent: vi.fn(),
		registerTaskWorker: vi.fn(),
		getTasksByName: async () => [],
		getTask: async () => null,
		updateTask: async () => {},
		createTask: vi.fn(async () => AGENT_ID),
		deleteTask: vi.fn(async () => {}),
	} as unknown as IAgentRuntime;
}

function makeItem(id: string, text: string | undefined) {
	return {
		memory: {
			id,
			roomId: AGENT_ID,
			content: text === undefined ? {} : { text },
		},
		priority: "normal" as const,
	};
}

describe("EmbeddingGenerationService drain config", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;

	afterEach(() => {
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
	});

	test("wires processBatch when a TEXT_EMBEDDING_BATCH model is registered", async () => {
		const runtime = makeRuntime({ batch: true });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue).toBeTruthy();
		expect(queue.options.drainIntervalMs).toBe(100);
		expect(typeof queue.options.processBatch).toBe("function");

		await service.stop();
	});

	test("initializes successfully when only TEXT_EMBEDDING_BATCH is registered", async () => {
		const models: Record<string, unknown> = {
			[ModelType.TEXT_EMBEDDING_BATCH]: async () => [[0.1]],
		};
		const runtime = {
			...makeRuntime({ batch: false }),
			getModel: (type: string) => models[type],
		} as unknown as IAgentRuntime;

		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect private isDisabled state
		expect((service as any).isDisabled).toBe(false);
		// biome-ignore lint/suspicious/noExplicitAny: inspect private queue state
		expect((service as any).batchQueue).toBeTruthy();

		await service.stop();
	});

	test("disables itself when neither TEXT_EMBEDDING nor TEXT_EMBEDDING_BATCH is registered", async () => {
		const runtime = {
			...makeRuntime({ batch: false }),
			getModel: () => undefined,
		} as unknown as IAgentRuntime;

		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect private isDisabled state
		expect((service as any).isDisabled).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: inspect private queue state
		expect((service as any).batchQueue).toBeNull();
	});

	test("without a batch handler: tight 100ms per-item drain, no processBatch", async () => {
		const runtime = makeRuntime({ batch: false });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue.options.drainIntervalMs).toBe(100);
		expect(queue.options.processBatch).toBeUndefined();

		await service.stop();
	});

	test("fast shutdown clears queued embeddings instead of flushing high-priority work", async () => {
		const updateMemory = vi.fn(async () => {});
		const runtime = makeRuntime({ batch: false, updateMemory });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: exercise the private event handler directly
		await (service as any).handleEmbeddingRequest(
			makeItem("id-fast-stop", "queued text"),
		);
		expect(service.getQueueSize()).toBe(1);

		process.env.ELIZA_FAST_SHUTDOWN = "1";
		await service.stop();

		expect(service.getQueueSize()).toBe(0);
		expect(updateMemory).not.toHaveBeenCalled();
	});

	test("queues empty vectors but skips memories with a non-empty vector", async () => {
		const runtime = makeRuntime({ batch: false });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const emptyVector = makeItem("id-empty-vector", "needs embedding");
		// biome-ignore lint/suspicious/noExplicitAny: exercise malformed persisted vector state
		(emptyVector.memory as any).embedding = [];
		const existingVector = makeItem("id-existing-vector", "already embedded");
		// biome-ignore lint/suspicious/noExplicitAny: exercise valid persisted vector idempotency
		(existingVector.memory as any).embedding = [9];

		// biome-ignore lint/suspicious/noExplicitAny: exercise the private event handler directly
		await (service as any).handleEmbeddingRequest({
			memory: emptyVector.memory,
			priority: "normal",
		});
		// biome-ignore lint/suspicious/noExplicitAny: exercise the private event handler directly
		await (service as any).handleEmbeddingRequest({
			memory: existingVector.memory,
			priority: "normal",
		});

		expect(service.getQueueSize()).toBe(1);
		process.env.ELIZA_FAST_SHUTDOWN = "1";
		await service.stop();
	});
});

describe("EmbeddingGenerationService processBatch", () => {
	test("single-item generation retries an empty vector but preserves idempotency", async () => {
		const written: { id: string; embedding: number[] }[] = [];
		const embedHandler = vi.fn(async () => [0.2, 0.4]);
		const runtime = makeRuntime({
			batch: false,
			embedHandler,
			updateMemory: async ({ id, embedding }) => {
				written.push({ id, embedding });
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		const empty = makeItem("id-empty-vector", "needs embedding");
		// biome-ignore lint/suspicious/noExplicitAny: exercise malformed persisted vector state
		(empty.memory as any).embedding = [];
		// biome-ignore lint/suspicious/noExplicitAny: exercise the private per-item processor directly
		await (service as any).generateEmbedding(empty);

		const existing = makeItem("id-existing-vector", "already embedded");
		// biome-ignore lint/suspicious/noExplicitAny: exercise valid persisted vector idempotency
		(existing.memory as any).embedding = [9];
		// biome-ignore lint/suspicious/noExplicitAny: exercise the private per-item processor directly
		await (service as any).generateEmbedding(existing);

		expect(embedHandler).toHaveBeenCalledTimes(1);
		expect(written).toEqual([{ id: "id-empty-vector", embedding: [0.2, 0.4] }]);
		await service.stop();
	});

	test("batches multiple items into ONE TEXT_EMBEDDING_BATCH call and writes back per id", async () => {
		let batchCalls = 0;
		let lastTexts: string[] = [];
		const written: { id: string; embedding: number[] }[] = [];
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => {
				batchCalls++;
				lastTexts = texts;
				return texts.map((_, i) => [i, i + 1]);
			},
			updateMemory: async ({ id, embedding }) => {
				written.push({ id, embedding });
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ success: boolean }[]>;

		const items = [makeItem("id-a", "alpha"), makeItem("id-b", "beta")];
		const outcomes = await processBatch(items);

		expect(batchCalls).toBe(1);
		expect(lastTexts).toEqual(["alpha", "beta"]);
		expect(outcomes.every((o) => o.success)).toBe(true);
		// Per-id write-back: each memory got its own vector.
		expect(written).toEqual([
			{ id: "id-a", embedding: [0, 1] },
			{ id: "id-b", embedding: [1, 2] },
		]);

		await service.stop();
	});

	test("whitespace-only text is skipped, never sent to the backend", async () => {
		// Backends reject whitespace-only text as terminally invalid
		// (plugin-elizacloud throws "Cannot generate embedding for empty
		// text"), so retrying it can never succeed — the partition must
		// trim-check, not just falsy-check (live 2026-08-10: image-only
		// messages error-logged on every retry).
		let lastTexts: string[] = [];
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => {
				lastTexts = texts;
				return texts.map((_, i) => [i, i + 1]);
			},
			updateMemory: async () => {},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ item: { memory: { id: string } }; success: boolean }[]>;

		const items = [makeItem("id-ws", "  \n "), makeItem("id-ok", "real text")];
		const outcomes = await processBatch(items);

		expect(lastTexts).toEqual(["real text"]);
		const byId = new Map(outcomes.map((o) => [o.item.memory.id, o.success]));
		// The whitespace item resolves as handled — not an error, not a retry.
		expect(byId.get("id-ws")).toBe(true);
		expect(byId.get("id-ok")).toBe(true);

		await service.stop();
	});

	test("an empty vector in the batch is failed, not falsely succeeded or persisted", async () => {
		const written: { id: string; embedding: number[] }[] = [];
		const runtime = makeRuntime({
			batch: true,
			// Middle item comes back as an empty vector (malformed/partial batch).
			batchHandler: async ({ texts }) =>
				texts.map((_, i) => (i === 1 ? [] : [i, i + 1])),
			updateMemory: async ({ id, embedding }) => {
				written.push({ id, embedding });
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ item: { memory: { id: string } }; success: boolean }[]>;

		const items = [
			makeItem("id-a", "alpha"),
			makeItem("id-b", "beta"),
			makeItem("id-c", "gamma"),
		];
		const outcomes = await processBatch(items);

		const byId = new Map(outcomes.map((o) => [o.item.memory.id, o.success]));
		// The empty vector must NOT be reported as a successful embedding.
		expect(byId.get("id-b")).toBe(false);
		expect(byId.get("id-a")).toBe(true);
		expect(byId.get("id-c")).toBe(true);
		// And it must never be written back to the store.
		expect(written.map((w) => w.id).sort()).toEqual(["id-a", "id-c"]);

		await service.stop();
	});

	test("skips missing-text / already-embedded items but still embeds empty vectors", async () => {
		let batchCalls = 0;
		let lastTexts: string[] = [];
		const written: string[] = [];
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => {
				batchCalls++;
				lastTexts = texts;
				return texts.map(() => [0.5]);
			},
			updateMemory: async ({ id }) => {
				written.push(id);
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ success: boolean }[]>;

		const alreadyEmbedded = makeItem("id-skip", "ignored");
		// biome-ignore lint/suspicious/noExplicitAny: set a pre-existing vector
		(alreadyEmbedded.memory as any).embedding = [9];
		const emptyVector = makeItem("id-empty-vector", "needs embedding");
		// biome-ignore lint/suspicious/noExplicitAny: exercise malformed persisted vector state
		(emptyVector.memory as any).embedding = [];
		const items = [
			makeItem("id-real", "real text"),
			makeItem("id-empty", undefined),
			alreadyEmbedded,
			emptyVector,
		];
		const outcomes = await processBatch(items);

		expect(batchCalls).toBe(1);
		expect(lastTexts).toEqual(["real text", "needs embedding"]);
		// All four outcomes succeed (two skipped, two embedded); only the real
		// and empty-vector items are written back.
		expect(outcomes).toHaveLength(4);
		expect(outcomes.every((o) => o.success)).toBe(true);
		expect(written).toEqual(["id-real", "id-empty-vector"]);

		await service.stop();
	});

	test("a batch-wide throw propagates so BatchQueue falls back to per-item process", async () => {
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async () => {
				throw new Error("batch endpoint down");
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<unknown>;

		// The throw must propagate; BatchQueue.drain catches it and runs the
		// per-item `process` path (preserving retry / onExhausted).
		await expect(processBatch([makeItem("id-a", "alpha")])).rejects.toThrow(
			"batch endpoint down",
		);

		await service.stop();
	});

	test("a vector/text count mismatch throws so the whole batch falls back per-item", async () => {
		const runtime = makeRuntime({
			batch: true,
			// Return fewer vectors than texts — unmappable to ids.
			batchHandler: async () => [[0.1]],
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<unknown>;

		await expect(
			processBatch([makeItem("id-a", "alpha"), makeItem("id-b", "beta")]),
		).rejects.toThrow(/TEXT_EMBEDDING_BATCH returned/);

		await service.stop();
	});

	test("a single id's write-back failure is isolated to that item, not the batch", async () => {
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => texts.map(() => [0.3]),
			updateMemory: async ({ id }) => {
				if (id === "id-b") {
					throw new Error("db write failed for b");
				}
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ item: { memory: { id: string } }; success: boolean }[]>;

		const outcomes = await processBatch([
			makeItem("id-a", "alpha"),
			makeItem("id-b", "beta"),
		]);

		const byId = new Map(outcomes.map((o) => [o.item.memory.id, o.success]));
		expect(byId.get("id-a")).toBe(true);
		expect(byId.get("id-b")).toBe(false);

		await service.stop();
	});
});

describe("EmbeddingGenerationService expected local unavailability (#17728)", () => {
	test.each(["backend_unavailable", "capability_unavailable"] as const)(
		"does not reportError for LOCAL_INFERENCE_UNAVAILABLE %s but still rethrows",
		async (reason) => {
			const runtime = makeRuntime({
				batch: false,
				embedHandler: async () => {
					const err = new Error(`local embeddings: ${reason}`);
					Object.assign(err, {
						code: "LOCAL_INFERENCE_UNAVAILABLE",
						modelType: ModelType.TEXT_EMBEDDING,
						reason,
					});
					throw err;
				},
			});
			const service = (await EmbeddingGenerationService.start(
				runtime,
			)) as EmbeddingGenerationService;
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: exercise private generate path
				(service as any).generateEmbedding(makeItem("id-u", "text")),
			).rejects.toMatchObject({
				code: "LOCAL_INFERENCE_UNAVAILABLE",
				reason,
			});
			expect(runtime.reportError).not.toHaveBeenCalled();
			await service.stop();
		},
	);

	test("reports invalid_input and unknown failures", async () => {
		const invalid = Object.assign(new Error("bad input"), {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_input",
		});
		const runtimeInvalid = makeRuntime({
			batch: false,
			embedHandler: async () => {
				throw invalid;
			},
		});
		const serviceInvalid = (await EmbeddingGenerationService.start(
			runtimeInvalid,
		)) as EmbeddingGenerationService;
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: exercise private generate path
			(serviceInvalid as any).generateEmbedding(makeItem("id-i", "text")),
		).rejects.toBe(invalid);
		expect(runtimeInvalid.reportError).toHaveBeenCalledWith(
			"EmbeddingService.generate",
			invalid,
			expect.objectContaining({ memoryId: "id-i" }),
		);
		await serviceInvalid.stop();

		const runtimeUnknown = makeRuntime({
			batch: false,
			embedHandler: async () => {
				throw new Error("network down");
			},
		});
		const serviceUnknown = (await EmbeddingGenerationService.start(
			runtimeUnknown,
		)) as EmbeddingGenerationService;
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: exercise private generate path
			(serviceUnknown as any).generateEmbedding(makeItem("id-n", "text")),
		).rejects.toThrow("network down");
		expect(runtimeUnknown.reportError).toHaveBeenCalled();
		await serviceUnknown.stop();
	});
});
