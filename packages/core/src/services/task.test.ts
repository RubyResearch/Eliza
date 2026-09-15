/**
 * Tests for TaskService tick re-arm, repeat-task backoff/auto-pause, and
 * self-queue suppression, and injected-clock ordering and teardown over an
 * in-memory task store, plus runtime mutations that mark the service dirty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { ServiceType } from "../types/service";
import type { Task, TaskWorker } from "../types/task";
import {
	TaskService,
	type TaskServiceClock,
	type TaskServiceTimerHandle,
} from "./task.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

/**
 * In-memory task store + minimal runtime for TaskService.
 * updateTask replaces metadata (executeTask always writes the full new metadata object).
 * Deliberately does NOT auto-markDirty on mutation — the tests below exercise
 * exactly when the tick re-queries without external nudges.
 */
function makeTaskRuntime(options?: {
	getTasks?: (params: {
		tags?: string[];
		agentIds?: UUID[];
	}) => Promise<Task[]>;
}) {
	const tasks = new Map<string, Task>();
	const workers = new Map<string, TaskWorker>();
	const noop = () => undefined;
	const runtime = {
		agentId: AGENT_ID,
		serverless: false,
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		reportError: vi.fn(),
		registerTaskWorker: (worker: TaskWorker) => {
			workers.set(worker.name, worker);
		},
		getTaskWorker: (name: string) => workers.get(name),
		getTasks:
			options?.getTasks ??
			(async (_params: { tags?: string[]; agentIds?: UUID[] }) =>
				Array.from(tasks.values())),
		getTask: async (id: UUID) => tasks.get(id) ?? null,
		getTasksByName: async (name: string) =>
			Array.from(tasks.values()).filter((t) => t.name === name),
		createTask: async (task: Task) => {
			const id = (task.id ?? `task-${tasks.size + 1}`) as UUID;
			tasks.set(id, { ...task, id });
			return id;
		},
		updateTask: async (id: UUID, patch: Partial<Task>) => {
			const existing = tasks.get(id);
			if (!existing) throw new Error(`no task ${id}`);
			tasks.set(id, { ...existing, ...patch });
		},
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
	} as unknown as IAgentRuntime;
	return { runtime, tasks, workers };
}

class DeterministicTaskClock implements TaskServiceClock {
	private nextTimerId = 1;
	private timers = new Map<
		number,
		{ callback: () => Promise<void>; intervalMs: number; nextAt: number }
	>();

	constructor(private currentTime: number) {}

	now(): number {
		return this.currentTime;
	}

	setInterval(
		callback: () => Promise<void>,
		intervalMs: number,
	): TaskServiceTimerHandle {
		const id = this.nextTimerId++;
		this.timers.set(id, {
			callback,
			intervalMs,
			nextAt: this.currentTime + intervalMs,
		});
		return id;
	}

	clearInterval(handle: TaskServiceTimerHandle): void {
		this.timers.delete(handle as number);
	}

	async advanceBy(durationMs: number): Promise<void> {
		const target = this.currentTime + durationMs;
		while (true) {
			const due = Array.from(this.timers.entries())
				.filter(([, timer]) => timer.nextAt <= target)
				.sort(
					([leftId, left], [rightId, right]) =>
						left.nextAt - right.nextAt || leftId - rightId,
				)[0];
			if (!due) break;
			const [id, timer] = due;
			this.currentTime = timer.nextAt;
			timer.nextAt += timer.intervalMs;
			await timer.callback();
			if (!this.timers.has(id)) continue;
		}
		this.currentTime = target;
	}

	reset(now: number): void {
		this.currentTime = now;
		this.nextTimerId = 1;
		this.timers.clear();
	}
}

describe("TaskService injected clock", () => {
	it("runs same-deadline tasks deterministically at the injected boundary", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const order: string[] = [];
		for (const name of ["FIRST", "SECOND"]) {
			workers.set(name, {
				name,
				execute: async () => {
					order.push(name);
				},
			});
			tasks.set(name, {
				id: name as UUID,
				name,
				agentId: AGENT_ID,
				tags: ["queue"],
				dueAt: T0 + 1_000,
			});
		}
		const clock = new DeterministicTaskClock(T0);
		const service = new TaskService(runtime, clock);
		service.startTimer();

		await clock.advanceBy(999);
		expect(order).toEqual([]);
		await clock.advanceBy(1);
		expect(order).toEqual(["FIRST", "SECOND"]);
		await service.stop();
	});

	it("cancels polling on stop", async () => {
		const { runtime } = makeTaskRuntime();
		const getTasks = vi.spyOn(runtime, "getTasks");
		const clock = new DeterministicTaskClock(T0);
		const service = new TaskService(runtime, clock);
		service.startTimer();
		await service.stop();

		await clock.advanceBy(10_000);
		expect(getTasks).not.toHaveBeenCalled();
	});

	it.each([
		["null", null],
		["zero", 0],
	] as const)("clears a %s timer handle", async (_label, handle) => {
		const { runtime } = makeTaskRuntime();
		const clock: TaskServiceClock = {
			now: () => T0,
			setInterval: () => handle,
			clearInterval: vi.fn(),
		};
		const service = new TaskService(runtime, clock);

		service.startTimer();
		await service.stop();

		expect(clock.clearInterval).toHaveBeenCalledOnce();
		expect(clock.clearInterval).toHaveBeenCalledWith(handle);
	});

	it("does not leak callbacks across an exact clock reset", async () => {
		const first = makeTaskRuntime();
		const second = makeTaskRuntime();
		const firstQuery = vi.spyOn(first.runtime, "getTasks");
		const secondQuery = vi.spyOn(second.runtime, "getTasks");
		const clock = new DeterministicTaskClock(T0);
		const firstService = new TaskService(first.runtime, clock);
		firstService.startTimer();

		await firstService.stop();
		clock.reset(T0);
		const secondService = new TaskService(second.runtime, clock);
		secondService.startTimer();
		await clock.advanceBy(1_000);

		expect(firstQuery).not.toHaveBeenCalled();
		expect(secondQuery).toHaveBeenCalledTimes(1);
		await secondService.stop();
	});

	it("keeps system time and timer APIs as the default boundary", async () => {
		const { runtime } = makeTaskRuntime();
		const timerHandle = { kind: "system-timer" };
		const now = vi.spyOn(Date, "now").mockReturnValue(T0);
		const set = vi
			.spyOn(globalThis, "setInterval")
			.mockReturnValue(
				timerHandle as unknown as ReturnType<typeof setInterval>,
			);
		const clear = vi
			.spyOn(globalThis, "clearInterval")
			.mockImplementation(() => {});
		const service = new TaskService(runtime);

		service.startTimer();
		expect(now).toHaveBeenCalled();
		expect(set).toHaveBeenCalledWith(expect.any(Function), 1_000);
		await service.stop();
		expect(clear).toHaveBeenCalledWith(timerHandle);
		now.mockRestore();
		set.mockRestore();
		clear.mockRestore();
	});
});

describe("TaskService tick re-arm", () => {
	let service: TaskService | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		if (service) {
			await service.stop();
			service = null;
		}
		vi.useRealTimers();
	});

	it("executes a repeat task on every interval, not just once at boot", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("HEARTBEAT", { name: "HEARTBEAT", execute });
		tasks.set("t-repeat", {
			id: "t-repeat" as UUID,
			name: "HEARTBEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 60_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// First tick happens at +1s, long before the task is due. Without the
		// re-arm the dirty gate would disarm here and the task would never run.
		await vi.advanceTimersByTimeAsync(61_000);
		expect(execute).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(execute).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("re-arms the tick after a transient getTasks rejection instead of going silent", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("HEARTBEAT", { name: "HEARTBEAT", execute });
		tasks.set("t-repeat", {
			id: "t-repeat" as UUID,
			name: "HEARTBEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 60_000, updatedAt: T0 },
		});

		// The first tick's query rejects (a transient DB blip); every later query
		// recovers. checkTasks clears tasksDirty BEFORE awaiting getTasks, so
		// without re-arming on failure the gate would stay disarmed forever and the
		// heartbeat would never run again after a single hiccup.
		let calls = 0;
		const realGetTasks = runtime.getTasks.bind(runtime);
		(runtime as { getTasks: IAgentRuntime["getTasks"] }).getTasks = (async (
			params: Parameters<IAgentRuntime["getTasks"]>[0],
		) => {
			calls += 1;
			if (calls === 1) throw new Error("transient db outage");
			return realGetTasks(params);
		}) as IAgentRuntime["getTasks"];

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(61_000);
		// The tick recovered (queried again after the rejection) and fired the task.
		expect(calls).toBeGreaterThan(1);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("runs a task created after the tick disarmed on an empty queue once markDirty is called", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });

		service = (await TaskService.start(runtime)) as TaskService;

		// First tick sees an EMPTY queue and disarms — that is the one case
		// where staying quiet is correct.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(execute).not.toHaveBeenCalled();

		tasks.set("t-late", {
			id: "t-late" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			metadata: {},
		});

		// The store mutation alone is invisible to the disarmed tick.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(execute).not.toHaveBeenCalled();

		// markDirty (what runtime.createTask now calls) re-arms the tick.
		service.markDirty();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(tasks.has("t-late")).toBe(false); // one-shots delete after running
	});

	it("does not register the removed prompt.run worker", async () => {
		const { runtime, workers } = makeTaskRuntime();

		service = (await TaskService.start(runtime)) as TaskService;

		expect(workers.has("prompt.run")).toBe(false);
		expect(workers.has("BATCHER_DRAIN")).toBe(true);
	});

	it("keeps seeing repeat tasks that only become due after several quiet ticks (no markDirty ever)", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("SLOW_REPEAT", { name: "SLOW_REPEAT", execute });
		tasks.set("t-slow", {
			id: "t-slow" as UUID,
			name: "SLOW_REPEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			// Mirrors the LifeOps heartbeat shape: interval + boot jitter means
			// the first tick always lands before the task is due.
			metadata: { updateInterval: 65_000, baseInterval: 65_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		// 600s / 65s interval => 9 executions; allow scheduling slack of one.
		expect(execute.mock.calls.length).toBeGreaterThanOrEqual(8);
	});

	it("clears stale baseInterval after a worker returns a fresh nextInterval", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => ({ nextInterval: 72 * 60 * 60_000 }));
		workers.set("VARIABLE_CRON", { name: "VARIABLE_CRON", execute });
		tasks.set("t-cron", {
			id: "t-cron" as UUID,
			name: "VARIABLE_CRON",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: {
				updateInterval: 60_000,
				baseInterval: 24 * 60 * 60_000,
				updatedAt: T0 - 61_000,
			},
		});
		(runtime as { serverless: boolean }).serverless = true;

		service = (await TaskService.start(runtime)) as TaskService;
		await service.runDueTasks();

		expect(execute).toHaveBeenCalledTimes(1);
		const meta = tasks.get("t-cron")?.metadata;
		expect(meta?.updateInterval).toBe(72 * 60 * 60_000);
		expect(meta?.baseInterval).toBeUndefined();
	});

	it("never auto-pauses a repeat task with maxFailures <= 0", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => {
			throw new Error("boom");
		});
		workers.set("FLAKY_HEARTBEAT", { name: "FLAKY_HEARTBEAT", execute });
		tasks.set("t-flaky", {
			id: "t-flaky" as UUID,
			name: "FLAKY_HEARTBEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: {
				updateInterval: 1_000,
				baseInterval: 1_000,
				updatedAt: T0,
				maxFailures: -1,
			},
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Failure backoff doubles the interval each time: runs land at
		// +1s, +3s, +7s, +15s, +31s, +63s, +127s => 7 failures in 128s.
		await vi.advanceTimersByTimeAsync(128_000);

		expect(execute.mock.calls.length).toBeGreaterThan(5);
		const meta = tasks.get("t-flaky")?.metadata;
		expect(meta?.paused).not.toBe(true);
		expect(meta?.failureCount).toBe(execute.mock.calls.length);
		expect(meta?.lastError).toBe("boom");
	});

	it("skips a repeat task whose previous run is still executing (self-queue suppression, #11914)", async () => {
		// The on-device starvation in #11914 came from a scheduled background
		// job that outlived its own period: each next firing must SKIP while the
		// previous run is still executing (blocking default), never enqueue.
		const { runtime, tasks, workers } = makeTaskRuntime();
		let releaseRun: (() => void) | undefined;
		const running = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const execute = vi.fn(() => running.then(() => undefined));
		workers.set("LONG_BACKGROUND_JOB", {
			name: "LONG_BACKGROUND_JOB",
			execute,
		});
		tasks.set("t-long", {
			id: "t-long" as UUID,
			name: "LONG_BACKGROUND_JOB",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			// Due immediately: last ran a full interval ago.
			metadata: { updateInterval: 60_000, updatedAt: T0 - 61_000 },
		});
		(runtime as { serverless: boolean }).serverless = true;

		service = (await TaskService.start(runtime)) as TaskService;

		// First firing starts and hangs mid-run (a long on-device decode).
		const firstRun = service.runDueTasks();
		await vi.advanceTimersByTimeAsync(0);
		expect(execute).toHaveBeenCalledTimes(1);

		// The next firings arrive while it is still running: they must skip.
		await service.runDueTasks();
		await service.runDueTasks();
		expect(execute).toHaveBeenCalledTimes(1);

		releaseRun?.();
		await firstRun;

		// Immediately after completion the task is not yet due again (interval
		// re-measured from completion) — still no extra run.
		await service.runDueTasks();
		expect(execute).toHaveBeenCalledTimes(1);

		// A full interval after completion it fires again exactly once.
		await vi.advanceTimersByTimeAsync(61_000);
		await service.runDueTasks();
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("still auto-pauses a repeat task after 5 consecutive failures by default", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => {
			throw new Error("boom");
		});
		workers.set("FLAKY_DEFAULT", { name: "FLAKY_DEFAULT", execute });
		tasks.set("t-default", {
			id: "t-default" as UUID,
			name: "FLAKY_DEFAULT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 1_000, baseInterval: 1_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Runs land at +1s, +3s, +7s, +15s, +31s => paused after the 5th failure.
		await vi.advanceTimersByTimeAsync(40_000);
		expect(execute).toHaveBeenCalledTimes(5);
		expect(tasks.get("t-default")?.metadata?.paused).toBe(true);

		// Paused task stays paused: no further executions.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(execute).toHaveBeenCalledTimes(5);
	});

	it("runs healthy rows, self-heals orphaned (missing-worker) rows, and rejects on real invalid rows", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("HEALTHY", { name: "HEALTHY", execute });
		workers.set("BAD_PREFLIGHT", {
			name: "BAD_PREFLIGHT",
			shouldRun: async () => "yes" as unknown as boolean,
			execute: vi.fn(async () => undefined),
		});
		tasks.set("healthy", {
			id: "healthy" as UUID,
			name: "HEALTHY",
			agentId: AGENT_ID,
			tags: ["queue"],
		});
		// Orphaned one-shot (no worker): no longer a per-tick failure. It is
		// self-healed (deleted) so it can't re-spam TASK_WORKER_MISSING every tick
		// (SHADOW-ACCOUNT-DEBUG). It must NOT appear in the failures list.
		tasks.set("missing-worker", {
			id: "missing-worker" as UUID,
			name: "MISSING",
			agentId: AGENT_ID,
			tags: ["queue"],
		});
		tasks.set("bad-preflight", {
			id: "bad-preflight" as UUID,
			name: "BAD_PREFLIGHT",
			agentId: AGENT_ID,
			tags: ["queue"],
		});
		(runtime as { serverless: boolean }).serverless = true;
		service = (await TaskService.start(runtime)) as TaskService;

		// Step past the boot grace window: inside it a missing worker is treated
		// as "not registered yet" and skipped silently, not healed.
		vi.setSystemTime(T0 + 61_000);

		// A genuinely invalid row (bad preflight) still rejects the tick; the
		// orphaned missing-worker row is healed away and absent from the failures.
		await expect(service.runDueTasks()).rejects.toMatchObject({
			code: "TASK_TICK_FAILED",
			context: {
				failureCodes: ["TASK_PREFLIGHT_INVALID"],
				failures: [
					{
						code: "TASK_PREFLIGHT_INVALID",
						taskId: "bad-preflight",
						taskName: "BAD_PREFLIGHT",
					},
				],
			},
		});
		expect(execute).toHaveBeenCalledTimes(1);
		// The orphaned one-shot was deleted, not left to re-fail forever.
		expect(tasks.has("missing-worker")).toBe(false);
	});

	it("manual execution rejects after persisting the worker failure", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		workers.set("FAIL", {
			name: "FAIL",
			execute: async () => {
				throw new Error("worker exploded");
			},
		});
		tasks.set("repeat", {
			id: "repeat" as UUID,
			name: "FAIL",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 1_000, updatedAt: T0 },
		});
		(runtime as { serverless: boolean }).serverless = true;
		service = (await TaskService.start(runtime)) as TaskService;

		await expect(
			service.executeTaskById("repeat" as UUID),
		).rejects.toMatchObject({
			code: "TASK_EXECUTION_FAILED",
		});
		expect(tasks.get("repeat")?.metadata).toMatchObject({
			failureCount: 1,
			lastError: "worker exploded",
		});
	});

	it("preserves bigint dueAt support for adapter-returned tasks", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("BIGINT_DUE", { name: "BIGINT_DUE", execute });
		tasks.set("bigint", {
			id: "bigint" as UUID,
			name: "BIGINT_DUE",
			agentId: AGENT_ID,
			tags: ["queue"],
			dueAt: BigInt(T0 - 1),
		});
		(runtime as { serverless: boolean }).serverless = true;
		service = (await TaskService.start(runtime)) as TaskService;

		await expect(service.runDueTasks()).resolves.toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid zero repeat intervals without running a busy loop", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ZERO", { name: "ZERO", execute });
		tasks.set("zero", {
			id: "zero" as UUID,
			name: "ZERO",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 0, updatedAt: T0 },
		});
		(runtime as { serverless: boolean }).serverless = true;
		service = (await TaskService.start(runtime)) as TaskService;

		await expect(service.runDueTasks()).rejects.toMatchObject({
			code: "TASK_TICK_FAILED",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not compound backoff and restores the original cadence when baseInterval was never set", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		let failuresLeft = 2;
		const execute = vi.fn(async () => {
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw new Error("boom");
			}
			return undefined;
		});
		workers.set("FLAKY_NO_BASE", { name: "FLAKY_NO_BASE", execute });
		tasks.set("t-nobase", {
			id: "t-nobase" as UUID,
			name: "FLAKY_NO_BASE",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			// Deliberately NO baseInterval — the common createTask shape (e.g.
			// createTestTasks). Backoff must still double off the ORIGINAL
			// interval, not off the already-inflated updateInterval.
			metadata: { updateInterval: 1_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Failure 1 at +1s: backoff to 2^1 * 1s = 2s.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(tasks.get("t-nobase")?.metadata?.updateInterval).toBe(2_000);

		// Failure 2 at +3s: backoff must be 2^2 * ORIGINAL 1s = 4s, not
		// 2^2 * the already-doubled 2s = 8s (exponential-of-exponential).
		await vi.advanceTimersByTimeAsync(2_000);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(tasks.get("t-nobase")?.metadata?.updateInterval).toBe(4_000);

		// Success at +7s: cadence restored to the ORIGINAL 1s interval, not
		// left permanently inflated at the last backoff value.
		await vi.advanceTimersByTimeAsync(4_000);
		expect(execute).toHaveBeenCalledTimes(3);
		const meta = tasks.get("t-nobase")?.metadata;
		expect(meta?.failureCount).toBe(0);
		expect(meta?.updateInterval).toBe(1_000);
	});
});

describe("AgentRuntime task mutations mark the local TaskService dirty", () => {
	function makeRuntimeShell() {
		const markDirty = vi.fn();
		const getService = vi.fn((type: string) =>
			type === ServiceType.TASK ? { markDirty } : null,
		);
		const adapter = {
			createTasks: vi.fn(async (tasks: Task[]) =>
				tasks.map((_, i) => `id-${i}` as UUID),
			),
			updateTasks: vi.fn(async () => undefined),
			deleteTasks: vi.fn(async () => undefined),
		};
		// Prototype-backed shell: exercises the real createTask/updateTask/deleteTask
		// implementations without booting a full AgentRuntime.
		const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
			agentId: AGENT_ID,
			adapter,
			getService,
			companionUrl: undefined,
		}) as AgentRuntime;
		return { runtime, markDirty, adapter };
	}

	it("createTask nudges the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.createTask({ name: "X" });
		expect(markDirty).toHaveBeenCalledTimes(1);
	});

	it("updateTask and deleteTask nudge the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.updateTask("id-0" as UUID, { metadata: {} });
		await runtime.deleteTask("id-0" as UUID);
		expect(markDirty).toHaveBeenCalledTimes(2);
	});

	it("batch createTasks/updateTasks/deleteTasks nudge the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.createTasks([{ name: "A" }, { name: "B" }]);
		await runtime.updateTasks([{ id: "id-0" as UUID, task: {} }]);
		await runtime.deleteTasks(["id-0" as UUID]);
		expect(markDirty).toHaveBeenCalledTimes(3);
	});

	it("does not throw when no TaskService is registered", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		(runtime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
		await expect(runtime.createTask({ name: "X" })).resolves.toBeDefined();
		expect(markDirty).not.toHaveBeenCalled();
	});
});

describe("TaskService orphaned-task self-heal (missing worker)", () => {
	let service: TaskService | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		if (service) {
			await service.stop();
			service = null;
		}
		vi.useRealTimers();
	});

	it("auto-pauses a repeat task whose worker is gone, then stops re-erroring every tick", async () => {
		const { runtime, tasks } = makeTaskRuntime();
		// NO worker registered for ORPHAN_REPEAT — simulates a task created by an
		// older build whose worker name changed / plugin no longer loads.
		tasks.set("orphan-r", {
			id: "orphan-r" as UUID,
			name: "ORPHAN_REPEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 60_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Inside the 60s boot grace the missing worker is "not registered yet":
		// no pause, no delete, no diagnostic.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(tasks.get("orphan-r")?.metadata?.paused).toBeUndefined();

		// First tick past the grace heals it: paused=true, ONE diagnostic (the
		// tick's TASK_TICK_FAILED does NOT fire because failures[] is empty after
		// heal).
		await vi.advanceTimersByTimeAsync(60_000);
		expect(tasks.get("orphan-r")?.metadata?.paused).toBe(true);
		expect(tasks.get("orphan-r")?.metadata?.orphanedNoWorker).toBe(true);
		const reportError = runtime.reportError as ReturnType<typeof vi.fn>;
		const callsAfterFirst = reportError.mock.calls.length;
		expect(callsAfterFirst).toBe(0);

		// Many later ticks: paused repeat is skipped in validateTasks, so it never
		// re-errors. The 1s TASK_WORKER_MISSING -> TASK_TICK_FAILED loop is gone.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reportError.mock.calls.length).toBe(0);
		// The row survives (operator can inspect / a redeploy can un-pause it).
		expect(tasks.has("orphan-r")).toBe(true);
	});

	it("deletes a one-shot task whose worker is gone (can never run)", async () => {
		const { runtime, tasks } = makeTaskRuntime();
		tasks.set("orphan-1", {
			id: "orphan-1" as UUID,
			name: "ORPHAN_ONESHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			metadata: { updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Inside the boot grace the one-shot is left alone (its plugin may just
		// not have registered yet — deleting here would destroy a healthy task).
		await vi.advanceTimersByTimeAsync(5_000);
		expect(tasks.has("orphan-1")).toBe(true);

		await vi.advanceTimersByTimeAsync(60_000);
		// One-shot with no worker is deleted (keeping it = re-fail every tick).
		expect(tasks.has("orphan-1")).toBe(false);
		const reportError = runtime.reportError as ReturnType<typeof vi.fn>;
		expect(reportError.mock.calls.length).toBe(0);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(reportError.mock.calls.length).toBe(0);
	});

	it("emits the quarantine-failure diagnostic at most once when the heal write keeps failing", async () => {
		const { runtime, tasks } = makeTaskRuntime();
		tasks.set("orphan-r2", {
			id: "orphan-r2" as UUID,
			name: "ORPHAN_REPEAT_2",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 60_000, updatedAt: T0 },
		});
		// updateTask always fails -> pause never persists, but the id is still
		// marked quarantined so we don't renarrate every tick.
		(runtime as { updateTask: IAgentRuntime["updateTask"] }).updateTask =
			(async () => {
				throw new Error("db write down");
			}) as IAgentRuntime["updateTask"];

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(61_000);
		const reportError = runtime.reportError as ReturnType<typeof vi.fn>;
		const afterFirst = reportError.mock.calls.length;
		// The heal failure surfaces (once) via the tick's TASK_TICK_FAILED.
		expect(afterFirst).toBeLessThanOrEqual(1);

		// It must NOT keep re-narrating on every subsequent 1s tick.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(reportError.mock.calls.length).toBe(afterFirst);
	});

	it("never quarantines during the boot grace window when the worker registers late", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		// Repeat task exists at boot; its plugin registers the worker 10s later
		// (real boot ordering: TaskService's 1s tick starts before every plugin
		// has registered its workers).
		tasks.set("late-worker", {
			id: "late-worker" as UUID,
			name: "LATE_WORKER",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 30_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// 10 ticks with no worker: silently skipped, never paused, never errored.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(tasks.get("late-worker")?.metadata?.paused).toBeUndefined();
		expect(
			(runtime.reportError as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(0);

		// Worker registers late; the task then runs normally on its interval.
		workers.set("LATE_WORKER", { name: "LATE_WORKER", execute });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(execute).toHaveBeenCalled();
		expect(tasks.get("late-worker")?.metadata?.paused).not.toBe(true);
	});

	it("auto-resumes an orphan-paused repeat task when its worker re-registers", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		// A row a PREVIOUS boot orphan-paused (orphanedNoWorker marker). This
		// build registers the worker again (redeploy restored the plugin).
		tasks.set("healed", {
			id: "healed" as UUID,
			name: "HEALED_WORKER",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: {
				updateInterval: 10_000,
				updatedAt: T0,
				paused: true,
				orphanedNoWorker: true,
				lastError:
					"No worker registered for task HEALED_WORKER (orphan auto-paused)",
			},
		});
		workers.set("HEALED_WORKER", { name: "HEALED_WORKER", execute });

		service = (await TaskService.start(runtime)) as TaskService;

		// First tick resumes it (clears paused + marker); it then runs when due.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(tasks.get("healed")?.metadata?.paused).toBe(false);
		expect(tasks.get("healed")?.metadata?.orphanedNoWorker).toBe(false);

		await vi.advanceTimersByTimeAsync(15_000);
		expect(execute).toHaveBeenCalled();
	});

	it("never auto-resumes an operator-paused task (no orphanedNoWorker marker)", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		tasks.set("op-paused", {
			id: "op-paused" as UUID,
			name: "OP_PAUSED",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			// Operator paused via API — no orphan marker. Must stay paused even
			// though the worker is registered.
			metadata: { updateInterval: 5_000, updatedAt: T0, paused: true },
		});
		workers.set("OP_PAUSED", { name: "OP_PAUSED", execute });

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(30_000);
		expect(tasks.get("op-paused")?.metadata?.paused).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("runs at most one already-selected execution when pauseTask lands mid-tick", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });
		tasks.set("mid-tick-pause", {
			id: "mid-tick-pause" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			dueAt: T0 - 1,
		});

		// Gate the FIRST getTasks (the in-flight tick) so pauseTask can land
		// while the tick holds a stale, pre-pause snapshot — the production
		// interleaving the already-selected-work semantics describe.
		let releaseTick: ((snapshot: Task[]) => void) | null = null;
		const tickSnapshot = new Promise<Task[]>((resolve) => {
			releaseTick = resolve;
		});
		let firstCall = true;
		(runtime as unknown as { getTasks: unknown }).getTasks = async () => {
			if (!firstCall) return Array.from(tasks.values());
			firstCall = false;
			return await tickSnapshot;
		};

		service = (await TaskService.start(runtime)) as TaskService;
		await vi.advanceTimersByTimeAsync(1_000);

		// Stale snapshot captured BEFORE the pause persists.
		const stale = Array.from(tasks.values());
		await service.pauseTask("mid-tick-pause" as UUID);
		expect(tasks.get("mid-tick-pause")?.metadata?.paused).toBe(true);

		releaseTick?.(stale);
		await vi.advanceTimersByTimeAsync(2_000);
		// The already-selected execution completes its lifecycle exactly once…
		expect(execute).toHaveBeenCalledTimes(1);
		// …including the normal one-shot delete (documented semantics).
		expect(tasks.has("mid-tick-pause")).toBe(false);

		// Every subsequent tick observes the pause state and selects nothing.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("does not execute a paused one-shot task when it becomes due, and keeps the row", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });
		tasks.set("paused-one-shot", {
			id: "paused-one-shot" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			dueAt: T0 + 5_000,
			metadata: { paused: true },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Well past the due time: the scheduler must honor the operator pause
		// exactly as it does for repeat tasks — no execution, no delete.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(execute).not.toHaveBeenCalled();
		const row = tasks.get("paused-one-shot");
		expect(row).toBeDefined();
		expect(row?.metadata?.paused).toBe(true);
	});

	it("executes a one-shot task that was never paused once it is due", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });
		tasks.set("due-one-shot", {
			id: "due-one-shot" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			dueAt: T0 + 5_000,
		});

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(10_000);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(tasks.has("due-one-shot")).toBe(false);
	});

	it("resumeTask with runImmediately executes a paused one-shot exactly once", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });
		tasks.set("resumed-one-shot", {
			id: "resumed-one-shot" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			metadata: { paused: true },
		});

		service = (await TaskService.start(runtime)) as TaskService;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(execute).not.toHaveBeenCalled();

		// Explicit operator resume: unpause + immediate manual run override.
		await service.resumeTask("resumed-one-shot" as UUID, true);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});

describe("explicit retry deadlines", () => {
	it.each([60_000, 600_000])(
		"persists %dms deadline past restart, including early tolerance, then restores normal cadence",
		async (delay) => {
			const { runtime, workers } = makeTaskRuntime();
			let now = T0;
			let attempts = 0;
			const deadline = now + delay;
			workers.set("retry", {
				name: "retry",
				execute: async () => {
					if (++attempts === 1)
						throw new ElizaError("Provider busy", {
							code: "PROVIDER_BUSY",
							retryAt: deadline,
						});
					return undefined;
				},
			});
			const id = await runtime.createTask({
				name: "retry",
				agentId: AGENT_ID,
				tags: ["queue", "repeat"],
				metadata: {
					updatedAt: T0 - 1000,
					updateInterval: 1000,
					notBefore: 500,
				},
			});
			const createScheduler = () =>
				new TaskService(runtime, {
					now: () => now,
					setInterval: () => {
						throw Error("Manual ticks only");
					},
					clearInterval: () => undefined,
				});
			await expect(createScheduler().runDueTasks()).rejects.toThrow();
			expect((await runtime.getTask(id))?.metadata).toMatchObject({
				failureCount: 1,
				baseInterval: 1000,
				updateInterval: delay + 500,
			});
			const restarted = createScheduler();
			now = deadline - 1;
			await restarted.runDueTasks();
			expect(attempts).toBe(1);
			now = deadline;
			await restarted.runDueTasks();
			expect(attempts).toBe(2);
			expect((await runtime.getTask(id))?.metadata).toMatchObject({
				failureCount: 0,
				updateInterval: 1000,
			});
		},
	);
	it.each([undefined, NaN, Infinity, -1, T0 - 1])(
		"retains exponential backoff for invalid or expired hint %s",
		async (retryAt) => {
			const { runtime, workers } = makeTaskRuntime();
			workers.set("retry", {
				name: "retry",
				execute: async () => {
					throw new ElizaError("Error", { code: "FAILURE", retryAt });
				},
			});
			const id = await runtime.createTask({
				name: "retry",
				agentId: AGENT_ID,
				tags: ["queue", "repeat"],
				metadata: { updatedAt: T0 - 1000, updateInterval: 1000 },
			});
			const scheduler = new TaskService(runtime, {
				now: () => T0,
				setInterval: () => {
					throw Error("Manual ticks only");
				},
				clearInterval: () => undefined,
			});
			await expect(scheduler.runDueTasks()).rejects.toThrow();
			expect((await runtime.getTask(id))?.metadata).toMatchObject({
				failureCount: 1,
				updateInterval: 2000,
			});
		},
	);
});
