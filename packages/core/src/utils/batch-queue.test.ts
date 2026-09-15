/**
 * Unit tests for the public batch-queue entrypoint in
 * packages/core/src/utils/batch-queue.ts.
 *
 * The file is a re-export barrel; these tests import through that path (the
 * same specifier production uses) and drive the real constructors. Every
 * BatchQueue branch, boundary, and error path in the composed implementation
 * is exercised here. Sibling suites under ./batch-queue/ cover the layers in
 * isolation.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Task, TaskWorker } from "../types/task";
import {
	type BatchItemOutcome,
	BatchProcessor,
	BatchQueue,
	type BatchQueueOptions,
	type DrainStats,
	PriorityQueue,
	type PriorityQueueOptions,
	type PriorityQueueStats,
	type QueuePriority,
	Semaphore,
	TaskDrain,
	type TaskDrainOptions,
} from "./batch-queue";
import * as implementation from "./batch-queue/index";

const TASK_ID = "00000000-0000-0000-0000-0000000000aa";

function makeQueue(
	overrides: Partial<BatchQueueOptions<number>> &
		Pick<BatchQueueOptions<number>, "process">,
): BatchQueue<number> {
	return new BatchQueue<number>({
		name: "TEST_DRAIN",
		batchSize: 10,
		drainIntervalMs: 100,
		getPriority: () => "normal",
		maxParallel: 5,
		maxRetriesAfterFailure: 0,
		...overrides,
	});
}

function runtimeForTasks(
	overrides: Parameters<typeof createMockRuntime>[0] = {},
) {
	return createMockRuntime({
		registerTaskWorker: vi.fn(),
		getTasksByName: vi.fn(async () => []),
		createTask: vi.fn(async () => TASK_ID),
		getTask: vi.fn(async () => ({
			id: TASK_ID,
			name: "TEST_DRAIN",
			metadata: { updateInterval: 100 },
		})),
		updateTask: vi.fn(async () => undefined),
		deleteTask: vi.fn(async () => undefined),
		reportError: vi.fn(),
		...overrides,
	});
}

describe("batch-queue entrypoint", () => {
	it("re-exports the same runtime constructors as the implementation module", () => {
		expect(BatchQueue).toBe(implementation.BatchQueue);
		expect(BatchProcessor).toBe(implementation.BatchProcessor);
		expect(PriorityQueue).toBe(implementation.PriorityQueue);
		expect(Semaphore).toBe(implementation.Semaphore);
		expect(TaskDrain).toBe(implementation.TaskDrain);
	});

	it("exposes class constructors (not namespace objects) through the barrel", () => {
		expect(typeof BatchQueue).toBe("function");
		expect(typeof BatchProcessor).toBe("function");
		expect(typeof PriorityQueue).toBe("function");
		expect(typeof Semaphore).toBe("function");
		expect(typeof TaskDrain).toBe("function");
	});
});

describe("BatchQueue (via public entrypoint)", () => {
	it("enqueues items, reports size and stats, and clear empties the queue", () => {
		const getPriority = (item: number): QueuePriority =>
			item >= 100 ? "high" : item >= 10 ? "normal" : "low";
		const q = makeQueue({
			process: async () => undefined,
			getPriority,
		});

		expect(q.enqueue(1)).toBe(true);
		expect(q.enqueue(10)).toBe(true);
		expect(q.enqueue(100)).toBe(true);
		expect(q.size).toBe(3);

		const stats: PriorityQueueStats = q.stats();
		expect(stats).toEqual({ high: 1, normal: 1, low: 1, total: 3 });

		q.clear();
		expect(q.size).toBe(0);
		expect(q.stats()).toEqual({ high: 0, normal: 0, low: 0, total: 0 });
	});

	it("clamps batchSize to at least 1 so a zero-sized queue still drains one item", async () => {
		const processed: number[] = [];
		const q = makeQueue({
			batchSize: 0,
			process: async (item) => {
				processed.push(item);
			},
		});
		expect(q.enqueue(1)).toBe(true);
		expect(q.enqueue(2)).toBe(true);
		await q.drain();
		expect(processed).toEqual([1]);
		expect(q.size).toBe(1);
	});

	it("returns without processing when the queue is empty", async () => {
		const process = vi.fn(async () => undefined);
		const onDrainComplete = vi.fn();
		const q = makeQueue({ process, onDrainComplete });
		await q.drain();
		expect(process).not.toHaveBeenCalled();
		expect(onDrainComplete).not.toHaveBeenCalled();
	});

	it("drains per-item when processBatch is not set", async () => {
		const processed: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
		});
		q.enqueue(7);
		q.enqueue(8);
		await q.drain();
		expect(processed.sort()).toEqual([7, 8]);
		expect(q.size).toBe(0);
	});

	it("calls processBatch once with the whole slice and skips per-item process", async () => {
		const perItem: number[] = [];
		const batched: number[][] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async (items) => {
				batched.push([...items]);
				return items.map((item) => ({ item, success: true, retryCount: 0 }));
			},
		});
		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);
		await q.drain();
		expect(batched).toEqual([[1, 2, 3]]);
		expect(perItem).toEqual([]);
	});

	it("falls back to per-item process when processBatch throws, without a runtime", async () => {
		const perItem: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async () => {
				throw new Error("batch endpoint down");
			},
		});
		q.enqueue(1);
		q.enqueue(2);
		await q.drain();
		expect(perItem.sort()).toEqual([1, 2]);
	});

	it("reports processBatch failures through the runtime after start", async () => {
		const perItem: number[] = [];
		const batchError = new Error("batch endpoint down");
		const runtime = runtimeForTasks();
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async () => {
				throw batchError;
			},
		});
		await q.start(runtime);
		q.enqueue(4);
		q.enqueue(5);
		await q.drain();
		expect(perItem.sort()).toEqual([4, 5]);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"BatchQueue.processBatch",
			batchError,
			{ queue: "TEST_DRAIN", batchSize: 2 },
		);
	});

	it("invokes outcome and completion hooks with drain stats after a non-empty batch", async () => {
		const outcomesSeen: BatchItemOutcome<number>[][] = [];
		const completions: DrainStats[] = [];
		const q = makeQueue({
			batchSize: 2,
			process: async () => undefined,
			onDrainBatchOutcomes: (outcomes) => {
				outcomesSeen.push(outcomes);
			},
			onDrainComplete: (stats) => {
				completions.push(stats);
			},
		});
		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);
		await q.drain();
		expect(outcomesSeen).toHaveLength(1);
		expect(outcomesSeen[0]?.map((row) => row.item).sort()).toEqual([1, 2]);
		expect(outcomesSeen[0]?.every((row) => row.success)).toBe(true);
		expect(completions).toHaveLength(1);
		expect(completions[0]?.batchSize).toBe(2);
		expect(completions[0]?.remaining).toBe(1);
		expect(completions[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("keeps a completed drain successful when outcome and completion hooks throw", async () => {
		const runtime = runtimeForTasks();
		const hookError = new Error("observer exploded");
		const processed: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
			onDrainBatchOutcomes: () => {
				throw hookError;
			},
			onDrainComplete: () => {
				throw hookError;
			},
		});
		await q.start(runtime);
		q.enqueue(9);
		await expect(q.drain()).resolves.toBe(1);
		expect(processed).toEqual([9]);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"BatchQueue.outcomeHook",
			hookError,
			{ queue: "TEST_DRAIN" },
		);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"BatchQueue.completionHook",
			hookError,
			{ queue: "TEST_DRAIN" },
		);
	});

	it("swallows hook throws even when no runtime is attached", async () => {
		const q = makeQueue({
			process: async () => undefined,
			onDrainBatchOutcomes: () => {
				throw new Error("outcome");
			},
			onDrainComplete: () => {
				throw new Error("complete");
			},
		});
		q.enqueue(1);
		await expect(q.drain()).resolves.toBe(1);
	});

	it("skips a second drain while one is already in flight", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const processed: number[] = [];
		const q = makeQueue({
			batchSize: 1,
			process: async (item) => {
				processed.push(item);
				await gate;
			},
		});
		q.enqueue(1);
		q.enqueue(2);
		const first = q.drain();
		const second = q.drain();
		release();
		await Promise.all([first, second]);
		expect(processed).toEqual([1]);
		expect(q.size).toBe(1);
	});

	it("rejects enqueue, skip drain, and no-op clear after dispose", async () => {
		const process = vi.fn(async () => undefined);
		const q = makeQueue({ process });
		q.enqueue(1);
		await q.dispose(runtimeForTasks(), { flushHighPriority: false });
		expect(q.enqueue(2)).toBe(false);
		await q.drain();
		expect(process).not.toHaveBeenCalled();
		q.clear();
		expect(q.size).toBe(0);
	});

	it("rejects an item when onPressure returns false at maxSize", () => {
		const q = makeQueue({
			process: async () => undefined,
			maxSize: 1,
			onPressure: () => false,
		});
		expect(q.enqueue(1)).toBe(true);
		expect(q.enqueue(2)).toBe(false);
		expect(q.size).toBe(1);
	});

	it("still enqueues past maxSize and warns when onPressure is omitted", () => {
		const warnings: Array<[number, number]> = [];
		const q = makeQueue({
			process: async () => undefined,
			maxSize: 1,
			onOverflowWarning: (sizeAfter, maxSize) => {
				warnings.push([sizeAfter, maxSize]);
			},
		});
		expect(q.enqueue(1)).toBe(true);
		expect(q.enqueue(2)).toBe(true);
		expect(q.size).toBe(2);
		expect(warnings).toEqual([[2, 1]]);
	});

	it("throws start after dispose and is a no-op when already started", async () => {
		const runtime = runtimeForTasks();
		const q = makeQueue({ process: async () => undefined });
		await q.dispose(runtime, { flushHighPriority: false });
		await expect(q.start(runtime)).rejects.toThrow(
			'BatchQueue "TEST_DRAIN" has already been disposed',
		);

		const live = makeQueue({ process: async () => undefined });
		await live.start(runtime);
		await live.start(runtime);
		expect(runtime.createTask).toHaveBeenCalledTimes(1);
		expect(runtime.registerTaskWorker).toHaveBeenCalledTimes(1);
	});

	it("registers a worker whose execute path drains the queue", async () => {
		const processed: number[] = [];
		let worker: TaskWorker | undefined;
		const runtime = runtimeForTasks({
			registerTaskWorker: vi.fn((registered: TaskWorker) => {
				worker = registered;
			}),
		});
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
		});
		await q.start(runtime);
		expect(worker?.name).toBe("TEST_DRAIN");
		q.enqueue(11);
		await worker?.execute(runtime, {}, { name: "TEST_DRAIN" } as Task);
		expect(processed).toEqual([11]);
	});

	it("skips worker registration when skipRegisterWorker is set", async () => {
		const runtime = runtimeForTasks();
		const q = makeQueue({
			process: async () => undefined,
			skipRegisterWorker: true,
			taskMetadata: { affinityKey: "room:x" },
			taskDescription: "test drain",
		});
		await q.start(runtime);
		expect(runtime.registerTaskWorker).not.toHaveBeenCalled();
		expect(runtime.createTask).toHaveBeenCalledTimes(1);
	});

	it("forwards updateDrainInterval to the started task drain", async () => {
		const runtime = runtimeForTasks();
		const q = makeQueue({ process: async () => undefined });
		await q.updateDrainInterval(runtime, 250);
		expect(runtime.updateTask).not.toHaveBeenCalled();
		await q.start(runtime);
		await q.updateDrainInterval(runtime, 250);
		expect(runtime.updateTask).toHaveBeenCalledWith(
			TASK_ID,
			expect.objectContaining({
				metadata: expect.objectContaining({
					updateInterval: 250,
					baseInterval: 250,
				}),
			}),
		);
	});

	it("flushes high-priority items through BatchProcessor on dispose by default", async () => {
		const processed: number[] = [];
		const outcomesSeen: BatchItemOutcome<number>[][] = [];
		const getPriority = (item: number): QueuePriority =>
			item >= 100 ? "high" : "normal";
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
			getPriority,
			onDrainBatchOutcomes: (outcomes) => {
				outcomesSeen.push(outcomes);
			},
		});
		q.enqueue(1);
		q.enqueue(100);
		await q.dispose(runtimeForTasks());
		expect(processed).toEqual([100]);
		expect(outcomesSeen).toHaveLength(1);
		expect(outcomesSeen[0]?.[0]).toMatchObject({
			item: 100,
			success: true,
		});
		expect(q.size).toBe(0);
	});

	it("uses the direct process loop when disposeHighPriorityViaProcessor is false", async () => {
		const processed: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
			getPriority: (item) => (item >= 100 ? "high" : "normal"),
			disposeHighPriorityViaProcessor: false,
		});
		q.enqueue(1);
		q.enqueue(101);
		await q.dispose(runtimeForTasks());
		expect(processed).toEqual([101]);
		expect(q.size).toBe(0);
	});

	it("reports a failed direct-loop flush via reportError without rejecting dispose", async () => {
		const flushError = new Error("provider down");
		const runtime = runtimeForTasks();
		const q = makeQueue({
			process: async () => {
				throw flushError;
			},
			getPriority: () => "high",
			disposeHighPriorityViaProcessor: false,
		});
		q.enqueue(1);
		await expect(q.dispose(runtime)).resolves.toBeUndefined();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"BatchQueue.shutdownFlush",
			flushError,
			{ queue: "TEST_DRAIN" },
		);
	});

	it("skips the high-priority flush when drainHighPriorityOnStop is false", async () => {
		const process = vi.fn(async () => undefined);
		const q = makeQueue({
			process,
			getPriority: () => "high",
			drainHighPriorityOnStop: false,
		});
		q.enqueue(1);
		await q.dispose(runtimeForTasks());
		expect(process).not.toHaveBeenCalled();
		expect(q.size).toBe(0);
	});

	it("honors an explicit flushHighPriority override on dispose", async () => {
		const processed: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				processed.push(item);
			},
			getPriority: () => "high",
			drainHighPriorityOnStop: false,
		});
		q.enqueue(42);
		await q.dispose(runtimeForTasks(), { flushHighPriority: true });
		expect(processed).toEqual([42]);
	});

	it("does not process when dispose flushes an empty high-priority slice", async () => {
		const process = vi.fn(async () => undefined);
		const q = makeQueue({
			process,
			getPriority: () => "normal",
		});
		q.enqueue(1);
		await q.dispose(runtimeForTasks());
		expect(process).not.toHaveBeenCalled();
		expect(q.size).toBe(0);
	});
});

describe("other entrypoint exports", () => {
	it("PriorityQueue dequeues high before normal before low", () => {
		const options: PriorityQueueOptions<string> = {
			getPriority: (item) => {
				if (item.startsWith("h")) return "high";
				if (item.startsWith("n")) return "normal";
				return "low";
			},
		};
		const queue = new PriorityQueue(options);
		queue.enqueue("low-1");
		queue.enqueue("high-1");
		queue.enqueue("normal-1");
		expect(queue.dequeueBatch(3)).toEqual(["high-1", "normal-1", "low-1"]);
	});

	it("Semaphore hands a permit to a waiter on release", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();
		let resumed = false;
		const waiter = (async () => {
			await sem.acquire();
			resumed = true;
			sem.release();
		})();
		expect(sem.queueLength).toBe(1);
		expect(resumed).toBe(false);
		sem.release();
		await waiter;
		expect(resumed).toBe(true);
		expect(sem.availablePermits).toBe(1);
	});

	it("BatchProcessor reports success and exhaustion outcomes", async () => {
		const exhausted: number[] = [];
		const processor = new BatchProcessor<number>({
			maxParallel: 2,
			maxRetriesAfterFailure: 0,
			process: async (item) => {
				if (item < 0) throw new Error("neg");
			},
			onExhausted: (item) => {
				exhausted.push(item);
			},
		});
		const outcomes = await processor.processBatch([1, -1]);
		expect(outcomes.find((row) => row.item === 1)?.success).toBe(true);
		expect(outcomes.find((row) => row.item === -1)?.success).toBe(false);
		expect(exhausted).toEqual([-1]);
	});

	it("TaskDrain refuses to start a worker without onDrain", async () => {
		const options: TaskDrainOptions = {
			taskName: "TEST_DRAIN",
			intervalMs: 1_000,
		};
		const drain = new TaskDrain(options);
		await expect(drain.start(runtimeForTasks())).rejects.toThrow(
			"TaskDrain: onDrain is required when registerWorker is enabled",
		);
	});
});
