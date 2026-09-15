/**
 * TaskService: the runtime singleton that polls `queue`-tagged tasks and runs
 * their registered worker when due. Owns the tick loop — a local `setInterval`,
 * a shared task-scheduler daemon, or serverless `runDueTasks()` — plus
 * repeat-task cadence, failure backoff and auto-pause, and overlap suppression
 * for blocking runs. Registered by the basic-capabilities plugin and reached
 * via `runtime.getService(ServiceType.TASK)`.
 */

import { ElizaError } from "../errors";
import type { JsonValue } from "../types";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";
import type { Task, TaskMetadata, TaskRunStatus } from "../types/task";
import {
	getTaskSchedulerAdapter,
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	unregisterTaskSchedulerRuntime,
} from "./task-scheduler";

/** Resolve task due time (ms) from dueAt or metadata.scheduledAt. Returns null if not set (run immediately). */
function resolveDueTime(task: Task): number | null {
	if (task.dueAt != null) {
		if (typeof task.dueAt === "number") return task.dueAt;
		if (typeof task.dueAt === "bigint") return Number(task.dueAt);
		return new Date(String(task.dueAt)).getTime();
	}
	const scheduledAt = (task.metadata as TaskMetadata | undefined)?.scheduledAt;
	if (scheduledAt == null) return null;
	if (typeof scheduledAt === "number") return scheduledAt;
	const t = new Date(scheduledAt).getTime();
	return Number.isNaN(t) ? null : t;
}

/** Opaque handle returned by an injected task-service timer implementation. */
export type TaskServiceTimerHandle = unknown;

/**
 * Time boundary used by TaskService. Production uses the system clock and
 * interval APIs; deterministic hosts can supply a virtual clock without
 * replacing task persistence, validation, or worker execution.
 */
export interface TaskServiceClock {
	now(): number;
	setInterval(
		callback: () => Promise<void>,
		intervalMs: number,
	): TaskServiceTimerHandle;
	clearInterval(handle: TaskServiceTimerHandle): void;
}

const systemTaskServiceClock: TaskServiceClock = {
	now: () => Date.now(),
	setInterval: (callback, intervalMs) =>
		setInterval(() => {
			void callback();
		}, intervalMs),
	clearInterval: (handle) =>
		clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Each tick validates due `queue` tasks against their worker's `shouldRun`,
 * then runs `worker.execute`. Repeat tasks reschedule on their interval (with
 * failure backoff); one-shot tasks are deleted after running. A task paused via
 * `metadata.paused` (operator or API) is skipped by every tick regardless of
 * tags — a paused one-shot stays in the store until it is resumed.
 */
export class TaskService extends Service {
	private timer: TaskServiceTimerHandle;
	private hasTimer = false;
	private activeTick: Promise<void> | null = null;
	private readonly clock: TaskServiceClock;
	private readonly TICK_INTERVAL = 1000; // Check every second
	/** Tracks task IDs currently being executed to prevent overlapping runs. WHY: blocking tasks must not run again until current run finishes. */
	private executingTasks: Set<string> = new Set();
	/** Tracks in-flight task promises so stop() can await a clean drain before runtime.close(). */
	private executingTaskPromises = new Set<Promise<void>>();
	/** When false, checkTasks skips the DB query. Set true by markDirty(); start true so first tick always queries. WHY: avoid redundant getTasks every second when nothing changed. */
	private tasksDirty = true;
	/**
	 * Task IDs already self-healed for a missing worker (#SHADOW-ACCOUNT-DEBUG).
	 * WHY: an orphaned task — one whose worker is not registered in THIS build
	 * (e.g. a repeat task created by an older build whose worker name changed, or
	 * a plugin that no longer loads) — otherwise fails validation every 1s tick
	 * FOREVER: it never reaches executeTask (the only place that deletes/pauses),
	 * so it re-emits TASK_WORKER_MISSING → TASK_TICK_FAILED every second. That
	 * loop is what narrated into Shadow's chat 9× via the RECENT_ERRORS provider
	 * + repeat-failure escalation. Self-heal (pause repeat / delete non-repeat)
	 * fixes the source; this set makes the ONE diagnostic per orphan idempotent
	 * so a transient getTasks/update failure can't re-narrate on the next tick.
	 */
	private quarantinedOrphans = new Set<string>();
	/**
	 * Service construction time (epoch-ms). A missing worker inside
	 * {@link TaskService.ORPHAN_GRACE_MS} of this moment is treated as "not
	 * registered YET" (boot ordering: the 1s tick can start before every plugin
	 * has registered its workers), not as an orphan. WHY: without the grace, a
	 * healthy task whose plugin registers a beat later was wrongly quarantined —
	 * repeat tasks auto-paused, one-shots DELETED — and the first tick emitted
	 * the TASK_WORKER_MISSING diagnostic that painted red system lines into the
	 * owner's chat view on every boot.
	 */
	private readonly startedAt: number;
	/** Set true in stop(). runTick returns immediately when true (daemon may call runTick after unregister). */
	private stopped = false;
	/**
	 * Boot grace window (ms) during which a missing worker is skipped silently
	 * instead of quarantined. 60s comfortably covers slow plugin boots (remote
	 * capability sync, late schema migrations) while still healing a genuinely
	 * orphaned row within the first minute of steady-state.
	 */
	private static readonly ORPHAN_GRACE_MS = 60_000;
	static serviceType = ServiceType.TASK;
	capabilityDescription = "The agent is able to schedule and execute tasks";

	constructor(
		runtime?: IAgentRuntime,
		clock: TaskServiceClock = systemTaskServiceClock,
	) {
		super(runtime);
		this.clock = clock;
		this.startedAt = clock.now();
	}

	/**
	 * Start the TaskService with the given runtime.
	 * @param {IAgentRuntime} runtime - The runtime for the TaskService.
	 * @returns {Promise<Service>} A promise that resolves with the TaskService instance.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TaskService(runtime);
		// WHY: batcher owns HOW (sections, packing, cache); task system owns WHEN. One scheduler for all periodic drains.
		runtime.registerTaskWorker({
			name: "BATCHER_DRAIN",
			execute: async (rt, options) => {
				const affinityKey = options.affinityKey as string;
				if (!rt.promptBatcher || !affinityKey) return undefined;
				await rt.promptBatcher.drainAffinityGroup(affinityKey);
				return undefined;
			},
		});
		await service.startTimer();
		return service;
	}

	/**
	 * Asynchronously creates test tasks by registering task workers for repeating and one-time tasks,
	 * validates the tasks, executes the tasks, and creates the tasks if they do not already exist.
	 */
	async createTestTasks() {
		// Register task worker for repeating task
		this.runtime.registerTaskWorker({
			name: "REPEATING_TEST_TASK",
			shouldRun: async () => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Validating repeating test task",
				);
				return true;
			},
			execute: async (_runtime, _options) => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Executing repeating test task",
				);
				return undefined;
			},
		});

		// Register task worker for one-time task
		this.runtime.registerTaskWorker({
			name: "ONETIME_TEST_TASK",
			shouldRun: async () => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Validating one-time test task",
				);
				return true;
			},
			execute: async (_runtime, _options) => {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
					},
					"Executing one-time test task",
				);
				return undefined;
			},
		});

		// check if the task exists
		const tasks = await this.runtime.getTasksByName("REPEATING_TEST_TASK");

		if (tasks.length === 0) {
			// Create repeating task
			await this.runtime.createTask({
				name: "REPEATING_TEST_TASK",
				description: "A test task that repeats every minute",
				metadata: {
					updatedAt: this.clock.now(), // Use timestamp instead of Date object
					updateInterval: 1000 * 60, // 1 minute
				},
				tags: ["queue", "repeat", "test"],
			});
		}

		// Create one-time task
		await this.runtime.createTask({
			name: "ONETIME_TEST_TASK",
			description: "A test task that runs once",
			metadata: {
				updatedAt: this.clock.now(),
			},
			tags: ["queue", "test"],
		});
	}

	/**
	 * Start the task poll timer. Call explicitly in daemon mode; not started automatically.
	 * WHY public: initialize() does not start the task service or timer. Daemon entry points
	 * that need scheduled tasks call getService("task") then startTimer(). Edge/ephemeral
	 * runtimes typically do not call this.
	 * Priority: (1) serverless -> no timer, host calls runDueTasks(); (2) daemon present -> register, no local timer; (3) else local setInterval.
	 * WHY serverless first: no long-lived process; WHY daemon second: one shared getTasks(agentIds) per tick for all agents.
	 */
	startTimer() {
		if (this.runtime.serverless === true) {
			return;
		}
		if (getTaskSchedulerAdapter() != null) {
			registerTaskSchedulerRuntime(this.runtime, this);
			return;
		}
		if (this.hasTimer) {
			this.hasTimer = false;
			this.clock.clearInterval(this.timer);
		}

		this.timer = this.clock.setInterval(async () => {
			if (this.activeTick) {
				return;
			}
			const tick = this.checkTasks()
				.catch((error) => {
					// error-policy:J7 Timer-driven task processing reports failures while
					// keeping the recurring scheduler alive for the next tick.
					this.runtime.reportError("TaskService.timer", error, {
						agentId: this.runtime.agentId,
					});
				})
				.finally(() => {
					if (this.activeTick === tick) {
						this.activeTick = null;
					}
				});
			this.activeTick = tick;
			await tick;
		}, this.TICK_INTERVAL);
		this.hasTimer = true;
	}

	/**
	 * Validates an array of Task objects.
	 * Skips tasks without IDs or if no worker is found for the task.
	 * Uses worker.shouldRun(runtime, task) when present; otherwise the task passes.
	 * @param {Task[]} tasks - An array of Task objects to validate.
	 * @returns {Promise<Task[]>} - A Promise that resolves with an array of validated Task objects.
	 */
	private async validateTasks(
		tasks: Task[],
	): Promise<{ tasks: Task[]; errors: ElizaError[] }> {
		const validatedTasks: Task[] = [];
		const errors: ElizaError[] = [];

		for (const task of tasks) {
			const context = { taskId: task.id, taskName: task.name };
			const metadata = task.metadata as TaskMetadata | undefined;
			if (task.tags?.includes("repeat") && metadata?.paused) {
				// Heal in BOTH directions: a repeat task WE paused for a missing
				// worker (orphanedNoWorker marker) must resume once a redeploy
				// re-registers that worker. Without this, the paused check here (which
				// runs before the worker lookup) stranded healed tasks paused forever.
				// Operator-paused tasks (no marker) are never touched.
				if (
					metadata.orphanedNoWorker === true &&
					task.id &&
					this.runtime.getTaskWorker(task.name)
				) {
					await this.resumeHealedOrphanTask(task, metadata);
				}
				// Resumed or not, skip this tick; a resumed task runs when next due.
				continue;
			}
			if (!task.id) {
				errors.push(
					new ElizaError("Scheduled task is missing an id", {
						code: "TASK_INVALID_ID",
						context,
						severity: "fatal",
					}),
				);
				continue;
			}

			const worker = this.runtime.getTaskWorker(task.name);
			if (!worker) {
				// Boot ordering: the tick can run before every plugin has registered
				// its workers. Inside the grace window a missing worker is "not
				// registered YET" — skip silently (no error, no heal). Quarantining
				// here wrongly paused/DELETED healthy tasks and emitted the
				// TASK_WORKER_MISSING noise seen on every staging boot.
				if (this.clock.now() - this.startedAt < TaskService.ORPHAN_GRACE_MS) {
					continue;
				}
				// Orphaned task: no worker registered in THIS build. Self-heal instead
				// of re-erroring every 1s tick (the TASK_WORKER_MISSING → TASK_TICK_FAILED
				// loop that narrated into chat 9×). Emit the diagnostic ONCE per orphan.
				if (!this.quarantinedOrphans.has(task.id)) {
					await this.quarantineOrphanTask(task, errors);
				}
				continue;
			}
			// Worker is back (e.g. plugin reloaded / build redeployed): drop the
			// quarantine mark so a future disappearance re-heals + re-diagnoses once.
			if (this.quarantinedOrphans.has(task.id)) {
				this.quarantinedOrphans.delete(task.id);
			}

			const invalidField = this.invalidScheduleField(task);
			if (invalidField) {
				errors.push(
					new ElizaError(`Task ${task.name} has invalid ${invalidField}`, {
						code: "TASK_SCHEDULE_INVALID",
						context: { ...context, field: invalidField },
						severity: "fatal",
					}),
				);
				continue;
			}

			if (worker.shouldRun) {
				let shouldRun: unknown;
				try {
					shouldRun = await worker.shouldRun(this.runtime, task);
				} catch (cause) {
					// error-policy:J1 Preflight failures are collected into the
					// structured TASK_TICK_FAILED boundary below.
					errors.push(
						new ElizaError(`Task ${task.name} preflight failed`, {
							code: "TASK_PREFLIGHT_FAILED",
							context,
							cause,
							severity: "ephemeral",
						}),
					);
					continue;
				}
				if (typeof shouldRun !== "boolean") {
					errors.push(
						new ElizaError(
							`Task ${task.name} preflight returned a non-boolean`,
							{
								code: "TASK_PREFLIGHT_INVALID",
								context: { ...context, resultType: typeof shouldRun },
								severity: "fatal",
							},
						),
					);
					continue;
				}
				if (!shouldRun) continue;
			}

			validatedTasks.push(task);
		}

		return { tasks: validatedTasks, errors };
	}

	/**
	 * Self-heal an orphaned task whose worker is not registered in this build.
	 * Repeat orphans are PAUSED (survive a redeploy that re-registers the worker,
	 * and can be un-paused/inspected by an operator); non-repeat orphans are
	 * DELETED (a one-shot with no worker can never run — keeping it would re-fail
	 * every tick with no backoff). Marks the id quarantined and emits the
	 * diagnostic ONCE. WHY once: without the mark, every 1s tick re-emitted
	 * TASK_WORKER_MISSING which the RECENT_ERRORS provider + repeat-escalation
	 * narrated into the owner's chat repeatedly (the observed 9× slop). A best-
	 * effort persistence failure is reported (once) but still marks quarantined
	 * so we don't renarrate on the next tick; the row will simply be re-healed if
	 * it reappears (idempotent pause/delete).
	 */
	private async quarantineOrphanTask(
		task: Task,
		errors: ElizaError[],
	): Promise<void> {
		if (!task.id) return;
		const context = { taskId: task.id, taskName: task.name };
		const isRepeat = task.tags?.includes("repeat") === true;
		try {
			if (isRepeat) {
				if (task.metadata?.paused !== true) {
					await this.runtime.updateTask(task.id, {
						metadata: {
							...task.metadata,
							paused: true,
							// Marks the pause as OURS so validateTasks can auto-resume it
							// when the worker re-registers. Operator pauses lack this flag
							// and are never auto-resumed.
							orphanedNoWorker: true,
							lastError: `No worker registered for task ${task.name} (orphan auto-paused)`,
							updatedAt: this.clock.now(),
						},
					});
				}
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						...context,
					},
					"Orphaned repeat task auto-paused (no worker registered)",
				);
			} else {
				await this.runtime.deleteTask(task.id);
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						...context,
					},
					"Orphaned one-shot task deleted (no worker registered)",
				);
			}
		} catch (cause) {
			// error-policy:J1 Quarantine failures join the single structured
			// task-validation failure reported by the tick boundary.
			// Persistence failed: still mark quarantined so we don't renarrate every
			// tick. Surface the heal failure ONCE (severity ephemeral so it can't push
			// the tick to fatal on its own). Report via the collected errors list so
			// it flows through the SAME single-diagnostic path, not a per-tick spam.
			errors.push(
				new ElizaError(`Failed to quarantine orphaned task ${task.name}`, {
					code: "TASK_ORPHAN_QUARANTINE_FAILED",
					context,
					cause,
					severity: "ephemeral",
				}),
			);
		}
		this.quarantinedOrphans.add(task.id);
	}

	/**
	 * Resume a repeat task that quarantineOrphanTask paused (orphanedNoWorker
	 * marker) now that its worker is registered again (plugin reloaded / build
	 * redeployed). Clears the pause + marker + lastError and drops the in-memory
	 * quarantine mark so a FUTURE disappearance re-heals and re-diagnoses once.
	 * Best-effort: a failed resume write is logged and retried on the next tick
	 * (the task simply stays paused until the write succeeds).
	 */
	private async resumeHealedOrphanTask(
		task: Task,
		metadata: TaskMetadata,
	): Promise<void> {
		if (!task.id) return;
		try {
			await this.runtime.updateTask(task.id, {
				metadata: {
					...metadata,
					paused: false,
					orphanedNoWorker: false,
					lastError: undefined,
					updatedAt: this.clock.now(),
				},
			});
			this.quarantinedOrphans.delete(task.id);
			this.runtime.logger.info(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskId: task.id,
					taskName: task.name,
				},
				"Orphan-paused task auto-resumed (worker registered again)",
			);
		} catch (cause) {
			// error-policy:J4 Resume is retried on the next tick; report the
			// still-paused state without failing unrelated scheduled tasks.
			// Logged only — resume is retried on the next tick; failing the whole
			// tick over a resume write would recreate the noise this path removes.
			this.runtime.logger.warn(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskId: task.id,
					taskName: task.name,
					err: cause,
				},
				"Failed to auto-resume orphan-paused task; will retry next tick",
			);
			this.runtime.reportError("TaskService.resumeOrphan", cause, {
				taskId: task.id,
				taskName: task.name,
			});
		}
	}

	private invalidScheduleField(task: Task): string | undefined {
		const finite = (value: unknown) =>
			typeof value === "number" && Number.isFinite(value);
		const metadata = task.metadata as TaskMetadata | undefined;
		if (task.dueAt != null) {
			const validDueAt =
				finite(task.dueAt) ||
				(typeof task.dueAt === "bigint" && Number.isFinite(Number(task.dueAt)));
			if (!validDueAt) return "dueAt";
		}
		if (
			metadata?.scheduledAt != null &&
			!finite(metadata.scheduledAt) &&
			Number.isNaN(new Date(String(metadata.scheduledAt)).getTime())
		) {
			return "metadata.scheduledAt";
		}
		if (!task.tags?.includes("repeat")) return undefined;
		if (
			!finite(metadata?.updateInterval) ||
			(metadata?.updateInterval ?? 0) <= 0
		)
			return "metadata.updateInterval";
		for (const field of ["updatedAt", "notBefore", "notAfter"] as const) {
			const value = metadata?.[field];
			if (value != null && (!finite(value) || value < 0))
				return `metadata.${field}`;
		}
		const failureCount = metadata?.failureCount;
		if (failureCount != null && (!finite(failureCount) || failureCount < 0)) {
			return "metadata.failureCount";
		}
		const baseInterval = metadata?.baseInterval;
		if (baseInterval != null && (!finite(baseInterval) || baseInterval <= 0)) {
			return "metadata.baseInterval";
		}
		const maxFailures = metadata?.maxFailures;
		if (
			maxFailures != null &&
			maxFailures !== Infinity &&
			!finite(maxFailures)
		) {
			return "metadata.maxFailures";
		}
		return undefined;
	}

	/**
	 * Asynchronous method that checks tasks with "queue" tag, validates them, then executes via runTick.
	 * Skips the DB query when tasksDirty is false. WHY: avoid redundant getTasks every second when nothing changed.
	 * Only a truly EMPTY queue may disarm the tick: repeat tasks and not-yet-due one-shots become due purely by
	 * time passing, with no create/update to call markDirty(), so any non-empty result re-arms tasksDirty.
	 *
	 * @returns {Promise<void>} Promise that resolves once all tasks are checked and executed
	 */
	private async checkTasks() {
		if (this.stopped || !this.tasksDirty) {
			return;
		}
		this.tasksDirty = false;

		// WHY queue only: approval/follow-up etc. are stored but run on user trigger or external cron; one place for "scheduled by tick".
		let allTasks: Task[];
		try {
			allTasks = await this.runtime.getTasks({
				tags: ["queue"],
				agentIds: [this.runtime.agentId],
			});
		} catch (error) {
			// error-policy:J2 Re-arm the queue before rethrowing with task-query context.
			// A transient getTasks rejection must NOT permanently disarm the tick:
			// we already cleared tasksDirty above, so without re-arming a single DB
			// hiccup would silence every repeat task (incl. the LifeOps heartbeat)
			// until an unrelated createTask/updateTask happened to call markDirty().
			this.tasksDirty = true;
			throw new ElizaError("Task queue query failed", {
				code: "TASK_QUERY_FAILED",
				context: { agentId: this.runtime.agentId },
				cause: error,
				severity: "ephemeral",
			});
		}

		if (!allTasks || allTasks.length === 0) {
			// Empty queue: stay disarmed until markDirty() (createTask/updateTask) re-arms.
			return;
		}

		// Non-empty queue: re-arm so the next tick re-queries and time-based due-ness is observed.
		this.tasksDirty = true;

		if (this.stopped) {
			return;
		}
		await this.runTick(allTasks);
	}

	/**
	 * Validate and execute due tasks. Used by checkTasks (local timer) and by the task-scheduler daemon (batch tick).
	 * Does NOT call getTasks — caller must pass the task list. WHY: daemon does one getTasks(agentIds) then dispatches to N runTicks.
	 * No-op when service is already stopped (daemon may call after unregister).
	 */
	async runTick(tasks: Task[]): Promise<void> {
		if (this.stopped) return;
		const validation = await this.validateTasks(tasks);
		const failures: ElizaError[] = [...validation.errors];
		const now = this.clock.now();

		for (const task of validation.tasks) {
			// Non-repeat tasks: run when due (or immediately if no dueAt/scheduledAt). WHY: one-shot "run at time X" (e.g. follow-up) uses dueAt or metadata.scheduledAt.
			if (!task.tags?.includes("repeat")) {
				// A paused one-shot must not run and must not reach the
				// execute-and-delete lifecycle — pauseTask() promises that ticks
				// after the pause skip the row until resumeTask(). The repeat
				// branch below has its own paused skip; this mirrors it for
				// one-shots (#24277). A tick that captured this snapshot before
				// pauseTask persisted may still run once — documented as
				// already-selected-work semantics on pauseTask().
				if (task.metadata?.paused === true) {
					continue;
				}
				const dueMs = resolveDueTime(task);
				if (dueMs != null && now < dueMs) continue;
				try {
					await this.executeTask(task);
				} catch (error) {
					// error-policy:J1 Independent task failures are aggregated into
					// the structured tick failure after all due tasks run.
					failures.push(
						error instanceof ElizaError
							? error
							: new ElizaError(`Task ${task.name} execution failed`, {
									code: "TASK_EXECUTION_FAILED",
									context: { taskId: task.id, taskName: task.name },
									cause: error,
								}),
					);
				}
				continue;
			}

			// Repeat tasks: skip if paused
			if (task.metadata?.paused === true) {
				continue;
			}

			// Resolve lastRan (updatedAt) with backward-compat fallback
			let lastRan: number;
			if (
				task.metadata?.updatedAt != null &&
				typeof task.metadata.updatedAt === "number"
			) {
				lastRan = task.metadata.updatedAt;
			} else if (typeof task.updatedAt === "number") {
				lastRan = task.updatedAt;
			} else if (typeof task.updatedAt === "bigint") {
				lastRan = Number(task.updatedAt);
			} else if (task.updatedAt) {
				lastRan = new Date(String(task.updatedAt)).getTime();
			} else {
				lastRan = 0;
			}

			const taskMetadata = task.metadata as TaskMetadata | undefined;
			const updateIntervalMs = taskMetadata?.updateInterval ?? 0;
			const notBeforeMs = taskMetadata?.notBefore ?? 0;
			const notAfterMs = taskMetadata?.notAfter;

			const idealNextRun = lastRan + updateIntervalMs;
			const earliest = idealNextRun - notBeforeMs;

			if (now < earliest) {
				continue;
			}

			if (
				notAfterMs != null &&
				typeof notAfterMs === "number" &&
				now > idealNextRun + notAfterMs
			) {
				this.runtime.logger.warn(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
						overdueMs: now - (idealNextRun + notAfterMs),
					},
					"Task overdue",
				);
			}

			const isBlocking = task.metadata?.blocking !== false;
			if (isBlocking && task.id && this.executingTasks.has(task.id)) {
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
					},
					"Skipping task - already executing (blocking enabled)",
				);
				continue;
			}

			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
					intervalMs: updateIntervalMs,
				},
				"Executing task - interval elapsed",
			);
			try {
				await this.executeTask(task);
			} catch (error) {
				// error-policy:J1 Independent task failures are aggregated into
				// the structured tick failure after all due tasks run.
				failures.push(
					error instanceof ElizaError
						? error
						: new ElizaError(`Task ${task.name} execution failed`, {
								code: "TASK_EXECUTION_FAILED",
								context: { taskId: task.id, taskName: task.name },
								cause: error,
							}),
				);
			}
		}
		if (failures.length > 0) {
			throw new ElizaError(`${failures.length} scheduled task failure(s)`, {
				code: "TASK_TICK_FAILED",
				context: {
					failureCodes: failures.map((failure) => failure.code),
					failures: failures.map((failure) => ({
						code: failure.code,
						...(typeof failure.context?.taskId === "string"
							? { taskId: failure.context.taskId }
							: {}),
						...(typeof failure.context?.taskName === "string"
							? { taskName: failure.context.taskName }
							: {}),
					})),
				},
				cause: new AggregateError(failures),
				severity: failures.some((failure) => failure.severity === "fatal")
					? "fatal"
					: "ephemeral",
			});
		}
	}

	/**
	 * Executes a given task asynchronously.
	 * Tracks execution state to prevent overlapping runs of the same task.
	 * On success: resets failureCount, applies nextInterval if returned, writes updatedAt. Non-repeat tasks are deleted.
	 * On failure: repeat tasks get backoff (using baseInterval so we don't compound), auto-pause after maxFailures; non-repeat tasks are deleted so they don't retry forever.
	 * WHY delete non-repeat on failure: otherwise they stay in DB and run every tick with no backoff (infinite retry loop).
	 * WHY backoff uses baseInterval: after N failures updateInterval is already large; using it again would be exponential-of-exponential.
	 *
	 * @param {Task} task - The task to be executed.
	 */
	private async executeTask(task: Task) {
		const execution = this.executeTaskInternal(task);
		this.executingTaskPromises.add(execution);
		try {
			await execution;
		} finally {
			this.executingTaskPromises.delete(execution);
		}
	}

	private async executeTaskInternal(task: Task) {
		if (!task.id) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
				},
				"Task not found",
			);
			return;
		}

		const worker = this.runtime.getTaskWorker(task.name);
		if (!worker) {
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
				},
				"No worker found for task type",
			);
			return;
		}

		this.executingTasks.add(task.id);
		const startTime = this.clock.now();

		try {
			const taskOptions = (task.metadata ?? {}) as Record<
				string,
				JsonValue | object
			>;
			const result = await worker.execute(this.runtime, taskOptions, task);
			if (result?.preserveTask) {
				return;
			}

			if (task.tags?.includes("repeat")) {
				const latestTask = await this.runtime.getTask(task.id);
				if (!latestTask) {
					return;
				}
				const meta = latestTask.metadata as TaskMetadata | undefined;
				const baseInterval = meta?.baseInterval ?? meta?.updateInterval;
				const newMeta: TaskMetadata = {
					...meta,
					updatedAt: this.clock.now(),
					failureCount: 0,
					lastError: undefined,
				};
				const nextInterval =
					result != null &&
					typeof result === "object" &&
					"nextInterval" in result
						? (result as { nextInterval?: number }).nextInterval
						: undefined;
				if (
					nextInterval != null &&
					(typeof nextInterval !== "number" ||
						!Number.isFinite(nextInterval) ||
						nextInterval <= 0)
				) {
					throw new ElizaError(
						`Task ${task.name} returned an invalid nextInterval`,
						{
							code: "TASK_ADAPTIVE_INTERVAL_INVALID",
							context: { taskId: task.id, taskName: task.name, nextInterval },
							severity: "fatal",
						},
					);
				}
				if (nextInterval != null) {
					newMeta.updateInterval = nextInterval;
					delete newMeta.baseInterval;
				} else if (baseInterval != null && typeof baseInterval === "number") {
					newMeta.updateInterval = baseInterval;
				}
				await this.runtime.updateTask(task.id, { metadata: newMeta });
			} else {
				await this.runtime.deleteTask(task.id);
				this.runtime.logger.debug(
					{
						src: "plugin:basic-capabilities:service:task",
						agentId: this.runtime.agentId,
						taskName: task.name,
						taskId: task.id,
					},
					"Deleted non-repeating task after execution",
				);
			}
		} catch (error) {
			// error-policy:J2 Persist failure state and rethrow a typed task error
			// that preserves both execution and persistence causes.
			let persistenceError: unknown;
			try {
				if (task.tags?.includes("repeat")) {
					const latestTask = await this.runtime.getTask(task.id);
					if (!latestTask) {
						return;
					}
					const meta = latestTask.metadata as TaskMetadata | undefined;
					const failureCount = (meta?.failureCount ?? 0) + 1;
					const rawMax = meta?.maxFailures;
					// maxFailures <= 0 (or Infinity) = never auto-pause. WHY: critical heartbeats (e.g. the
					// LifeOps scheduler) must survive transient failure storms; a paused heartbeat is a
					// permanently-dead subsystem until an operator notices. 0/-1 survive JSON round-trips.
					const neverPause =
						rawMax === Infinity || (typeof rawMax === "number" && rawMax <= 0);
					const maxFailures = neverPause ? Infinity : (rawMax ?? 5);
					const failedAt = this.clock.now();
					const newMeta: TaskMetadata & Record<string, unknown> = {
						...(meta ?? {}),
						updatedAt: failedAt,
						failureCount,
						lastError: error instanceof Error ? error.message : String(error),
					};
					if (!neverPause && failureCount >= maxFailures) {
						newMeta.paused = true;
						this.runtime.logger.warn(
							{
								taskName: task.name,
								taskId: task.id,
								failureCount,
							},
							"Task auto-paused after max failures",
						);
					} else {
						const baseInterval =
							meta?.baseInterval ?? meta?.updateInterval ?? 1000;
						// Persist the resolved base the FIRST time we back off. Without it,
						// the next failure's fallback reads the already-doubled
						// updateInterval (the exponential-of-exponential this branch exists
						// to prevent) and a later success "restores" updateInterval to the
						// inflated backoff value permanently instead of the original cadence.
						newMeta.baseInterval = baseInterval;
						newMeta.updateInterval = Math.min(
							baseInterval * 2 ** failureCount,
							300_000,
						);
						if (
							error instanceof ElizaError &&
							typeof error.retryAt === "number" &&
							Number.isFinite(error.retryAt)
						) {
							// Provider deadlines are floors, not capped exponential backoff.
							// Compensate for the scheduler's optional early-run tolerance.
							newMeta.updateInterval = Math.max(
								newMeta.updateInterval,
								error.retryAt - failedAt + (meta?.notBefore ?? 0),
							);
						}
					}
					await this.runtime.updateTask(task.id, { metadata: newMeta });
				} else if (task.id) {
					await this.runtime.deleteTask(task.id);
					this.runtime.logger.debug(
						{
							src: "plugin:basic-capabilities:service:task",
							agentId: this.runtime.agentId,
							taskName: task.name,
							taskId: task.id,
						},
						"Deleted non-repeating task after execution failure",
					);
				}
			} catch (cause) {
				// error-policy:J2 The outer handler combines this persistence
				// failure with the original execution failure.
				persistenceError = cause;
			}
			const cause = persistenceError
				? new AggregateError(
						[error, persistenceError],
						"Task execution and state transition failed",
					)
				: error;
			const failure =
				!persistenceError && error instanceof ElizaError
					? error
					: new ElizaError(`Task ${task.name} execution failed`, {
							code: persistenceError
								? "TASK_EXECUTION_STATE_FAILED"
								: "TASK_EXECUTION_FAILED",
							context: { taskName: task.name, taskId: task.id },
							cause,
							severity: persistenceError ? "fatal" : "ephemeral",
						});
			this.runtime.logger.error(
				{ taskName: task.name, taskId: task.id, error: failure },
				"Task execution failed",
			);
			throw failure;
		} finally {
			this.executingTasks.delete(task.id);
			const durationMs = this.clock.now() - startTime;
			this.runtime.logger.debug(
				{
					src: "plugin:basic-capabilities:service:task",
					agentId: this.runtime.agentId,
					taskName: task.name,
					taskId: task.id,
					durationMs,
				},
				"Task execution completed",
			);
		}
	}

	/** Marks the task list as dirty so the next checkTasks tick will re-query the DB. When the daemon is running, notifies it instead of setting local flag. */
	markDirty(): void {
		if (getTaskSchedulerAdapter() != null) {
			markTaskSchedulerDirty(this.runtime.agentId);
			return;
		}
		this.tasksDirty = true;
	}

	/**
	 * Run due queue tasks once. For serverless: call from cron or on each request.
	 * Does getTasks for this agent's queue tasks then runTick (validate + execute due).
	 * WHY separate from timer: serverless has no long-lived process; host drives execution explicitly.
	 */
	async runDueTasks(): Promise<void> {
		const allTasks = await this.runtime.getTasks({
			tags: ["queue"],
			agentIds: [this.runtime.agentId],
		});
		if (allTasks.length) {
			await this.runTick(allTasks);
		}
	}

	/**
	 * Executes a task by ID. Loads the task, then runs it via executeTask.
	 * @param taskId - UUID of the task.
	 */
	async executeTaskById(taskId: UUID): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.executeTask(task);
	}

	/**
	 * Pauses a task. Every scheduler tick AFTER the pause is persisted skips
	 * the task until it is resumed, and a paused task is never deleted by the
	 * tick loop.
	 *
	 * Already-selected-work semantics: Task rows carry no version column, so
	 * pause is not CAS-atomic with tick selection. A tick that captured its
	 * Task snapshot BEFORE the pause landed may execute that one selection to
	 * completion (including the normal one-shot delete). Everything selected
	 * afterwards observes `metadata.paused` and skips. Callers needing
	 * hard at-most-zero execution must gate the worker itself (e.g. check
	 * paused inside worker.execute).
	 *
	 * Preserves existing metadata (updatedAt, updateInterval, etc.).
	 */
	async pauseTask(taskId: UUID): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.runtime.updateTask(taskId, {
			metadata: { ...task.metadata, paused: true } as TaskMetadata,
		});
	}

	/**
	 * Resumes a task. If runImmediately is true, runs the task once after unpausing.
	 * Unpauses before executing so a failed run does not leave the task paused.
	 */
	async resumeTask(taskId: UUID, runImmediately?: boolean): Promise<void> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}
		await this.runtime.updateTask(taskId, {
			metadata: { ...task.metadata, paused: false } as TaskMetadata,
		});
		if (runImmediately) {
			const updated = await this.runtime.getTask(taskId);
			if (updated) {
				await this.executeTask(updated);
			}
		}
	}

	/**
	 * Returns run status for a task: task, paused, executing, nextRunAt (repeat only), lastError.
	 */
	async getTaskStatus(taskId: UUID): Promise<TaskRunStatus> {
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			return { task: null, paused: false, executing: false };
		}
		const paused = (task.metadata as TaskMetadata)?.paused === true;
		const executing = task.id ? this.executingTasks.has(task.id) : false;
		let nextRunAt: number | undefined;
		if (task.tags?.includes("repeat")) {
			let lastRan: number;
			const meta = task.metadata as TaskMetadata | undefined;
			if (meta?.updatedAt != null && typeof meta.updatedAt === "number") {
				lastRan = meta.updatedAt;
			} else if (typeof task.updatedAt === "number") {
				lastRan = task.updatedAt;
			} else if (typeof task.updatedAt === "bigint") {
				lastRan = Number(task.updatedAt);
			} else {
				lastRan = 0;
			}
			const interval = meta?.updateInterval ?? 0;
			const notBefore = meta?.notBefore ?? 0;
			nextRunAt = lastRan + interval - notBefore;
		}
		return {
			task,
			paused,
			executing,
			nextRunAt,
			lastError: (task.metadata as TaskMetadata)?.lastError,
		};
	}

	/**
	 * Stops the TASK service in the given agent runtime.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime containing the service.
	 * @returns {Promise<void>} - A promise that resolves once the service has been stopped.
	 */
	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceType.TASK);
		if (service) {
			await service.stop();
		}
	}

	/**
	 * Stops the timer if it is currently running.
	 */

	async stop() {
		this.stopped = true;
		unregisterTaskSchedulerRuntime(this.runtime.agentId);
		if (this.hasTimer) {
			this.hasTimer = false;
			this.clock.clearInterval(this.timer);
		}
		if (this.activeTick) {
			await this.activeTick;
		}
		const inFlight = Array.from(this.executingTaskPromises);
		if (inFlight.length > 0) {
			await Promise.allSettled(inFlight);
		}
		// Clear executing tasks set on stop
		this.executingTasks.clear();
	}
}
