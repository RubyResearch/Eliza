/**
 * Encapsulates **repeat task** lifecycle for drain workloads: find-or-create a row with
 * `tags: ["queue", "repeat"]`, merge scheduling metadata, optionally register a task worker.
 *
 * **Why `skipRegisterWorker`:** `BATCHER_DRAIN` is executed by a **single** worker registered in
 * `TaskService` that dispatches by `metadata.affinityKey`. Per-affinity `TaskDrain` instances only
 * create/update/delete tasks; registering another worker with the same name would overwrite the
 * global handler.
 *
 * **Why `maxFailures: -1`:** `JSON.stringify(Infinity)` is `null`; `-1` round-trips through JSON
 * and is interpreted by TaskService as “do not auto-pause this drain” (see CHANGELOG).
 */

import type { JsonValue, UUID } from "../../types/primitives.js";
import type { IAgentRuntime } from "../../types/runtime.js";
import type { Task } from "../../types/task.js";

export interface TaskDrainOptions {
	taskName: string;
	/** Initial interval for repeat task metadata. */
	intervalMs: number;
	/** Optional DB task description (e.g. affinity label). */
	description?: string;
	/** Extra metadata merged into the repeat task (e.g. `{ affinityKey: "default" }`). */
	taskMetadata?: Record<string, unknown>;
	/**
	 * When true, does not call `runtime.registerTaskWorker` — use when a global worker
	 * already handles this task name (e.g. `BATCHER_DRAIN` in TaskService).
	 */
	skipRegisterWorker?: boolean;
	/**
	 * Required unless `skipRegisterWorker` is true. Invoked when the repeat task
	 * fires; may return how many items it processed so an idle queue can back off.
	 */
	onDrain?: (runtime: IAgentRuntime) => Promise<number | undefined>;
	/**
	 * Cadence while the last drain processed nothing. EMBEDDING_DRAIN and
	 * PII_SCRUB_DRAIN rewrote public.tasks every second around the clock while
	 * idle (audit 2026-09-13); the next non-empty drain restores `intervalMs`.
	 */
	idleIntervalMs?: number;
}

export class TaskDrain {
	private readonly taskName: string;
	private readonly taskMetadata: Record<string, unknown>;
	private readonly skipRegisterWorker: boolean;
	private readonly onDrain?: (
		runtime: IAgentRuntime,
	) => Promise<number | undefined>;
	private readonly idleIntervalMs?: number;
	private intervalMs: number;
	private taskId: UUID | null = null;
	private workerRegistered = false;
	private disposed = false;

	private readonly description: string;

	constructor(options: TaskDrainOptions, initialIntervalMs?: number) {
		this.taskName = options.taskName;
		this.description =
			options.description ?? `Repeat drain: ${options.taskName}`;
		this.taskMetadata = { ...(options.taskMetadata ?? {}) };
		this.skipRegisterWorker = options.skipRegisterWorker ?? false;
		this.onDrain = options.onDrain;
		this.idleIntervalMs = options.idleIntervalMs;
		this.intervalMs = initialIntervalMs ?? options.intervalMs;
	}

	get id(): UUID | null {
		return this.taskId;
	}

	/**
	 * Register worker (unless skipped) and ensure the repeat task exists for this agent.
	 */
	async start(runtime: IAgentRuntime): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.skipRegisterWorker) {
			const onDrain = this.onDrain;
			if (!onDrain) {
				throw new Error(
					"TaskDrain: onDrain is required when registerWorker is enabled",
				);
			}
			runtime.registerTaskWorker({
				name: this.taskName,
				execute: async (
					rt: IAgentRuntime,
					_options: Record<string, JsonValue | object>,
					_task: Task,
				) => {
					const processed = await onDrain(rt);
					if (this.idleIntervalMs === undefined || processed === undefined) {
						return undefined;
					}
					return {
						nextInterval: processed > 0 ? this.intervalMs : this.idleIntervalMs,
					};
				},
			});
			this.workerRegistered = true;
		}

		await this.ensureTask(runtime);
	}

	/** Match agent + every key in `taskMetadata` (e.g. affinityKey for batcher drains). */
	private matchesTask(t: Task, agentId: string): boolean {
		if (t.agentId == null || String(t.agentId) !== String(agentId)) {
			return false;
		}
		const tags = Array.isArray(t.tags) ? t.tags : [];
		if (!tags.includes("queue") || !tags.includes("repeat")) {
			return false;
		}
		const meta = (t.metadata ?? {}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(this.taskMetadata)) {
			if (meta[key] !== value) {
				return false;
			}
		}
		return true;
	}

	private async ensureTask(runtime: IAgentRuntime): Promise<void> {
		if (
			typeof runtime.getTasksByName !== "function" ||
			typeof runtime.createTask !== "function"
		) {
			return;
		}
		const agentId = runtime.agentId;
		const existing = await runtime.getTasksByName(this.taskName);
		const matchingTasks = existing.filter((t) =>
			this.matchesTask(t, String(agentId)),
		);
		const mine = matchingTasks[0];
		if (mine?.id) {
			this.taskId = mine.id;
			if (
				matchingTasks.length > 1 &&
				typeof runtime.deleteTask === "function"
			) {
				await Promise.allSettled(
					matchingTasks
						.slice(1)
						.filter((task): task is Task & { id: UUID } => Boolean(task.id))
						.map((task) => runtime.deleteTask(task.id)),
				);
			}
			// Reconcile DB interval/metadata with this drain’s configured interval (stale rows after restart).
			if (
				typeof runtime.getTask === "function" &&
				typeof runtime.updateTask === "function"
			) {
				await this.updateInterval(runtime, this.intervalMs);
			}
			return;
		}
		this.taskId = await runtime.createTask({
			name: this.taskName,
			description: this.description,
			tags: ["queue", "repeat"],
			agentId: agentId as UUID,
			worldId: agentId as UUID,
			metadata: {
				...this.taskMetadata,
				updateInterval: this.intervalMs,
				baseInterval: this.intervalMs,
				updatedAt: Date.now(),
				maxFailures: -1,
			},
		});
	}

	/**
	 * Update repeat interval in DB when scheduling changes (e.g. batcher ideal tick).
	 */
	async updateInterval(
		runtime: IAgentRuntime,
		newIntervalMs: number,
	): Promise<void> {
		this.intervalMs = newIntervalMs;
		const taskId = this.taskId;
		if (
			!taskId ||
			typeof runtime.getTask !== "function" ||
			typeof runtime.updateTask !== "function"
		) {
			return;
		}
		const task = await runtime.getTask(taskId);
		if (!task) {
			this.taskId = null;
			return;
		}
		const current = (task.metadata as Record<string, unknown>)
			?.updateInterval as number | undefined;
		if (current === newIntervalMs) {
			return;
		}
		await runtime.updateTask(taskId, {
			metadata: {
				...task.metadata,
				updateInterval: newIntervalMs,
				baseInterval: newIntervalMs,
			},
		});
	}

	getIntervalMs(): number {
		return this.intervalMs;
	}

	async dispose(runtime: IAgentRuntime): Promise<void> {
		this.disposed = true;
		if (this.taskId && typeof runtime.deleteTask === "function") {
			const taskId = this.taskId;
			// error-policy:J7 diagnostics-must-not-kill-the-loop — dispose must always
			// complete, but a failed delete leaves an orphaned task row; surface it.
			await runtime
				.deleteTask(taskId)
				.catch((err) =>
					runtime.reportError("TaskDrain.dispose", err, { taskId }),
				);
			this.taskId = null;
		}
		// Runtime has no unregisterTaskWorker; a later service may call registerTaskWorker again.
		if (this.workerRegistered) {
			this.workerRegistered = false;
		}
	}
}
