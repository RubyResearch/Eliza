/** Durable handoff and room ownership through real runtime/task/cache adapters. */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { preferenceEvaluator } from "../features/advanced-capabilities/evaluators/preference-items";
import {
	factMemoryEvaluator,
	identityEvaluator,
	relationshipEvaluator,
	successEvaluator,
} from "../features/advanced-capabilities/evaluators/reflection-items";
import { createAdvancedMemoryPlugin } from "../features/advanced-memory/index";
import { AgentRuntime } from "../runtime";
import {
	validateHistoryRetention,
	visibleHistoryEventIds,
} from "../runtime/history-retention";
import {
	ChannelType,
	type Character,
	type EvaluatorProcessorContext,
	type Memory,
	type RegisteredEvaluator,
	type State,
	type Task,
} from "../types";
import { stringToUuid } from "../utils";
import { isActiveMemoryEvidence } from "../utils/extraction-evidence";
import { EvaluatorService } from "./evaluator";
import {
	getEvaluatorProgressState,
	prepareEvaluatorProgress,
	stageEvaluatorOutput,
} from "./evaluator-progress";
import {
	historyRetentionContext,
	historyRetentionEvaluator,
} from "./history-retention";
import { resolveStage1SenderRole } from "./message/addressing";
import { createV5MessageContextObject } from "./message/context-assembly";
import { TaskService } from "./task";

const state: State = { values: {}, data: {}, text: "" };
const turn: Memory = {
	id: "00000000-0000-4000-8000-000000000001",
	roomId: "00000000-0000-4000-8000-000000000002",
	entityId: "00000000-0000-4000-8000-000000000003",
	content: { text: "I live in Berlin." },
	createdAt: 10,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function setup(adapter = new InMemoryDatabaseAdapter()) {
	const runtime = new AgentRuntime({
		character: {
			name: "BackgroundMemoryTest",
			bio: "test",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => state);
	runtime.emitEvent = vi.fn(async () => {});
	await runtime.createRooms([
		{
			id: turn.roomId,
			agentId: runtime.agentId,
			type: ChannelType.DM,
			source: "test",
		},
	]);
	await runtime.createEntities([
		{ id: turn.entityId, agentId: runtime.agentId, names: ["User"] },
	]);
	await runtime.createRoomParticipants([turn.entityId], turn.roomId);
	const message = { ...turn, agentId: runtime.agentId };
	await runtime.upsertMemory(message, "messages");
	const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
	return { runtime, service, message, adapter };
}
function evaluator(
	process = vi.fn(async () => undefined),
): RegisteredEvaluator {
	return {
		name: "memory",
		description: "test",
		background: true,
		incremental: true,
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prepare: async () => ({ candidate: "original" }),
		prompt: ({ prepared }) => JSON.stringify(prepared),
		processors: [{ process }],
	};
}
async function job(
	runtime: AgentRuntime,
): Promise<Task & { id: NonNullable<Task["id"]> }> {
	const rows = await runtime.getTasksByName("POST_TURN_MEMORY");
	expect(rows).toHaveLength(1);
	if (!rows[0].id) throw new Error("Missing persisted task identity");
	return { ...rows[0], id: rows[0].id };
}
async function execute(runtime: AgentRuntime, task: Task) {
	const worker = runtime.getTaskWorker("POST_TURN_MEMORY");
	if (!worker) throw new Error("Memory worker not registered");
	try {
		return await worker.execute(runtime, {}, task);
	} catch (error) {
		if (
			error instanceof Error &&
			"context" in error &&
			error.context &&
			typeof error.context === "object" &&
			"errors" in error.context
		) {
			error.message += `: ${JSON.stringify(error.context.errors)}`;
		}
		throw error;
	}
}

function retentionAnswer(
	prompt: string,
	retain: string[],
	references: string[] = [],
) {
	const sourceSetId = prompt.match(/sourceSetId: ([a-f0-9]{64})/)?.[1];
	if (!sourceSetId)
		throw new Error("Missing retention binding in actual prompt");
	const candidates = [
		...prompt.matchAll(/^\[(h\d+)(?:\]| original message )/gm),
	].map((match) => match[1]);
	return JSON.stringify({
		historyRetention: {
			sourceSetId,
			complete: true,
			retainSourceIds: retain,
			deferSourceIds: candidates.filter((id) => !retain.includes(id)),
			uncertainSourceIds: [],
			dependencyGroups: [],
			referenceMessageIds: references,
		},
	});
}

function retentionPrompt(params: unknown): string {
	const input = params as { messages: Array<{ content: string }> };
	return input.messages.map((message) => message.content).join("\n");
}

async function retentionScope(runtime: AgentRuntime, message: Memory) {
	return {
		agentId: runtime.agentId,
		roomId: message.roomId,
		entityId: message.entityId,
		roles: [await resolveStage1SenderRole(runtime, message)],
	};
}

describe("durable background memory", () => {
	it.each([false, true])(
		"admits foreground events between immediately resolved memory jobs, including failures: %s",
		async (fails) => {
			const { runtime, service, message } = await setup();
			const release = deferred<void>();
			let foreground: Promise<void> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const process = vi.fn(async () => {
				// Like a ready socket/timer event: Promise continuations alone do
				// not admit this event while the scheduler drains its task batch.
				timer = setTimeout(() => {
					foreground = runtime.roomHandlerQueue.withLease(
						message.roomId,
						() => release.promise,
					);
				}, 0);
				if (fails) throw new Error("Processor still needs recovery");
			});
			runtime.registerEvaluator(evaluator(process));
			runtime.useModel = vi.fn(
				async () => '{"memory":{"ok":true}}',
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			try {
				if (fails) await expect(execute(runtime, task)).rejects.toThrow();
				else await execute(runtime, task);
				expect(foreground).toBeDefined();
				expect(runtime.roomHandlerQueue.pendingTotal()).toBeGreaterThan(0);
				expect(await execute(runtime, task)).toEqual({ preserveTask: true });
				expect(process).toHaveBeenCalledTimes(1);
				expect(runtime.useModel).toHaveBeenCalledTimes(1);
				if (fails) expect(await runtime.getTask(task.id)).not.toBeNull();
				else expect(await runtime.getTask(task.id)).toBeNull();
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				release.resolve();
				await foreground;
			}
		},
	);
	it.each([relationshipEvaluator, identityEvaluator])(
		"holds $name source reconciliation before inference without acknowledging the evidence",
		async (entry) => {
			for (const mutation of ["edit", "delete"]) {
				const { runtime, service, message } = await setup();
				runtime.registerEvaluator(entry);
				const output = {
					relationships: { relationships: [] },
					identities: { identities: [] },
					success: { completed: true, reason: "Answered." },
				};
				const model = vi.fn(async () => JSON.stringify(output));
				runtime.useModel = model as AgentRuntime["useModel"];
				const options = { phase: "post_turn" as const, didRespond: true };
				const initial = await service.run(message, state, options);
				expect(initial.errors).toEqual([]);
				expect(initial.processedEvaluators).toContain(entry.name);
				const next = {
					...message,
					id: stringToUuid(`reconciliation-${entry.name}-${mutation}`),
					createdAt: 20,
					content: { text: "hi" },
				};
				await runtime.upsertMemory(next, "messages");
				if (mutation === "edit")
					await runtime.updateMemory({
						id: message.id as NonNullable<Memory["id"]>,
						content: { text: "Correction: I live in Paris." },
					});
				else
					await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
				model.mockClear();
				// Repeating the scan must retain the hold, not acknowledge it as an
				// empty successful extraction or ask the model again.
				for (let scan = 0; scan < 2; scan++) {
					const result = await service.run(next, state, options);
					expect(result.processedEvaluators).toEqual([]);
					expect(result.errors).toEqual([
						expect.objectContaining({
							evaluatorName: entry.name,
							error: expect.stringContaining("require reconciliation"),
						}),
					]);
					expect(model).not.toHaveBeenCalled();
				}
			}
		},
	);
	it.each(["edit", "delete"])(
		"reconciles success reflections after source %s before consuming new evidence",
		async (mutation) => {
			const { runtime, service, message } = await setup();
			runtime.registerEvaluator(successEvaluator);
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({ success: { completed: true, reason: "Answered." } }),
			) as AgentRuntime["useModel"];
			const options = { phase: "post_turn" as const, didRespond: true };
			expect((await service.run(message, state, options)).errors).toEqual([]);
			const [old] = await runtime.getMemories({
				tableName: "memories",
				roomId: message.roomId,
				unique: false,
			});
			if (!old?.id || !message.id) throw new Error("Missing stored evidence");
			const next = {
				...message,
				id: stringToUuid(`success-reconcile-${mutation}`),
				createdAt: 20,
				content: { text: "hi" },
			};
			await runtime.upsertMemory(next, "messages");
			if (mutation === "edit")
				await runtime.updateMemory({
					id: message.id,
					content: { text: "Correction: I live in Paris." },
				});
			else await runtime.deleteMemory(message.id);
			const result = await service.run(next, state, options);
			expect(result.errors).toEqual([]);
			expect(result.processedEvaluators).toContain("success");
			const retired = await runtime.getMemoryById(old.id);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect((await service.run(next, state, options)).errors).toEqual([]);
			const current = await runtime.getMemoryById(message.id);
			if (mutation === "edit")
				expect(current?.content.text).toBe("Correction: I live in Paris.");
			else expect(current).toBeNull();
		},
	);

	it("keeps scheduler backoff when delivery re-enqueues a rate-limited memory job", async () => {
		const { runtime, service, message } = await setup();
		if (!message.id) throw new Error("Persisted source identity required");
		const process = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(process));
		// Same provider failure recorded in the real cold-review experiment. The
		// scheduler, evaluator, journal and task store below are the real services.
		const quota = new Error(
			"Too Many Requests: Tokens per minute limit exceeded - too many tokens processed.",
		);
		let attempts = 0;
		runtime.useModel = vi.fn(async () => {
			if (++attempts <= 2) throw quota;
			return '{"memory":{"ok":true}}';
		}) as AgentRuntime["useModel"];
		let now = Date.now() + 10_000;
		const scheduler = new TaskService(runtime, {
			now: () => now,
			setInterval: () => {
				throw new Error("Test drives public scheduler ticks");
			},
			clearInterval: () => undefined,
		});
		await service.enqueue(message, state, { phase: "post_turn" });
		const initial = await job(runtime);
		await expect(scheduler.executeTaskById(initial.id)).rejects.toThrow();
		now += 2_000;
		await expect(scheduler.executeTaskById(initial.id)).rejects.toThrow();
		const failed = await job(runtime);
		expect(failed.metadata).toMatchObject({
			failureCount: 2,
			updateInterval: 4_000,
		});
		expect(process).not.toHaveBeenCalled();

		// Delivery/restart replay updates receipts without forgiving the quota
		// failure or bringing the next model request forward.
		await service.enqueue(message, state, {
			phase: "post_turn",
			didRespond: true,
		});
		const replayed = await job(runtime);
		expect(replayed.metadata).toMatchObject({
			updateInterval: failed.metadata?.updateInterval,
			baseInterval: failed.metadata?.baseInterval,
			updatedAt: failed.metadata?.updatedAt,
			failureCount: 2,
			lastError: failed.metadata?.lastError,
			didRespond: true,
		});
		await EvaluatorService.start(runtime);
		now += 1_000;
		await scheduler.runDueTasks();
		expect(attempts).toBe(2);
		now += 3_000;
		await scheduler.runDueTasks();
		expect(attempts).toBe(3);
		expect(process).toHaveBeenCalledTimes(1);
		expect(await runtime.getTask(initial.id)).toBeNull();
		expect(await runtime.getMemoryById(message.id)).toMatchObject({
			content: message.content,
		});
	});

	it.each(["headers", "cooldown"])(
		"waits for %s retry deadlines across scheduler restart and delivery replay",
		async (kind) => {
			const { runtime, service, message } = await setup();
			const process = vi.fn(async () => undefined);
			runtime.registerEvaluator(evaluator(process));
			let now = Date.now() + 10_000;
			const deadline = now + 60_000;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			let attempts = 0;
			runtime.useModel = vi.fn(async () => {
				attempts++;
				if (now < deadline)
					throw Object.assign(new Error("Provider rate limited"), {
						statusCode: 429,
						...(kind === "headers"
							? { responseHeaders: { "retry-after": "60" } }
							: { retryAfterMs: deadline - now }),
					});
				return '{"memory":{"ok":true}}';
			}) as AgentRuntime["useModel"];
			const createScheduler = () =>
				new TaskService(runtime, {
					now: () => now,
					setInterval: () => {
						throw new Error("Manual ticks only");
					},
					clearInterval: () => undefined,
				});
			try {
				await service.enqueue(message, state, { phase: "post_turn" });
				const initial = await job(runtime);
				await expect(
					createScheduler().executeTaskById(initial.id),
				).rejects.toThrow();
				expect((await job(runtime)).metadata).toMatchObject({
					failureCount: 1,
					updateInterval: 60_000,
					baseInterval: 1_000,
				});
				now += 31_000;
				await service.enqueue(message, state, {
					phase: "post_turn",
					didRespond: true,
				});
				await EvaluatorService.start(runtime);
				const restarted = createScheduler();
				await restarted.runDueTasks();
				expect(attempts).toBe(1);
				expect(process).not.toHaveBeenCalled();
				now = deadline - 1;
				await restarted.runDueTasks();
				expect(attempts).toBe(1);
				now = deadline;
				await restarted.runDueTasks();
				expect(attempts).toBe(2);
				expect(process).toHaveBeenCalledTimes(1);
				expect(await runtime.getTask(initial.id)).toBeNull();
				if (!message.id) throw new Error("Persisted source identity required");
				expect((await runtime.getMemoryById(message.id))?.content).toEqual(
					message.content,
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("commits staged output while a fresh extraction lane waits for quota", async () => {
		const { runtime, service, message } = await setup();
		let now = Date.now() + 10000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const saved = vi.fn(async () => {
			if (saved.mock.calls.length === 1) throw new Error("Reducer unavailable");
		});
		const fresh = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(saved));
		let calls = 0;
		runtime.useModel = vi.fn(async () => {
			calls++;
			if (calls === 1) return '{"memory":{"ok":true}}';
			if (calls === 2)
				throw Object.assign(new Error("Rate limited"), {
					statusCode: 429,
					responseHeaders: { "retry-after": "60" },
				});
			return '{"other":{"ok":true}}';
		}) as AgentRuntime["useModel"];
		const scheduler = new TaskService(runtime, {
			now: () => now,
			setInterval: () => {
				throw new Error("Manual ticks only");
			},
			clearInterval: () => undefined,
		});
		try {
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			await expect(scheduler.executeTaskById(task.id)).rejects.toThrow();
			runtime.registerEvaluator({ ...evaluator(fresh), name: "other" });
			now += 2000;
			await expect(scheduler.runDueTasks()).rejects.toThrow();
			expect(saved).toHaveBeenCalledTimes(2);
			expect(fresh).not.toHaveBeenCalled();
			expect((await job(runtime)).metadata).toMatchObject({
				failureCount: 2,
				updateInterval: 60000,
			});
			now += 60000;
			await scheduler.runDueTasks();
			expect(calls).toBe(3);
			expect(saved).toHaveBeenCalledTimes(2);
			expect(fresh).toHaveBeenCalledTimes(1);
			expect(await runtime.getTask(task.id)).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});

	it.each([
		[ChannelType.DM, true],
		[ChannelType.API, true],
		[ChannelType.SELF, true],
		[ChannelType.GROUP, false],
		[ChannelType.VOICE_DM, false],
		[ChannelType.VOICE_GROUP, false],
	] as const)(
		"indexes only supported direct-text sources: %s",
		async (channelType, enabled) => {
			const { runtime, service, message } = await setup();
			await runtime.registerPlugin(createAdvancedMemoryPlugin());
			const source = {
				...message,
				content: { ...message.content, channelType },
			};
			await runtime.upsertMemory(source, "messages");
			runtime.useModel = vi.fn(async (_type, params) =>
				retentionAnswer(retentionPrompt(params), ["h1"]),
			) as AgentRuntime["useModel"];
			await service.enqueue(source, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			expect(runtime.useModel).toHaveBeenCalledTimes(enabled ? 1 : 0);
			if (enabled) {
				expect(
					await getEvaluatorProgressState(runtime, source, "historyRetention"),
				).toMatchObject({ reviewedCount: 1 });
			}
			if (!source.id) throw new Error("Persisted source ID required");
			expect(await runtime.getMemoryById(source.id)).toMatchObject(source);
		},
	);

	it("registers history review through advanced memory and produces a worker checkpoint matching foreground context", async () => {
		const { runtime, service, message } = await setup();
		const proposal: Memory = {
			...message,
			id: stringToUuid("retention-proposal"),
			createdAt: 11,
			entityId: runtime.agentId,
			content: { text: "I will preview Safety fixture notes before saving." },
		};
		const assent: Memory = {
			...message,
			id: stringToUuid("retention-assent"),
			createdAt: 12,
			content: { text: "Yes. Keep that rule for this conversation." },
		};
		await runtime.upsertMemory(proposal, "messages");
		await runtime.upsertMemory(assent, "messages");
		await runtime.registerPlugin(createAdvancedMemoryPlugin());
		const prompts: string[] = [];
		runtime.useModel = vi.fn(async (_type, params) => {
			const prompt = retentionPrompt(params);
			prompts.push(prompt);
			return retentionAnswer(prompt, ["h2", "h3"]);
		}) as AgentRuntime["useModel"];
		await service.enqueue(assent, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const first = await getEvaluatorProgressState(
			runtime,
			assent,
			historyRetentionEvaluator.name,
		);
		expect(first).toMatchObject({
			reviewedCount: 3,
			retainedEventIds: [`history:${proposal.id}`, `history:${assent.id}`],
		});
		const greeting: Memory = {
			...message,
			id: stringToUuid("retention-hi"),
			createdAt: 13,
			content: { text: "hello from retention fixture" },
		};
		const reply: Memory = {
			...message,
			id: stringToUuid("retention-hey"),
			createdAt: 14,
			entityId: runtime.agentId,
			content: { text: "Hey from retention fixture." },
		};
		await runtime.upsertMemory(greeting, "messages");
		await runtime.upsertMemory(reply, "messages");
		await service.enqueue(greeting, state, {
			phase: "post_turn",
			responses: [reply],
			semanticSignal: false,
		});
		await execute(runtime, await job(runtime));
		const checkpoint = await getEvaluatorProgressState(
			runtime,
			greeting,
			historyRetentionEvaluator.name,
		);
		const rows = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
		});
		const next: Memory = {
			...message,
			id: stringToUuid("retention-next"),
			createdAt: 15,
			content: { text: "Open Notes." },
		};
		const foreground = await createV5MessageContextObject({
			runtime,
			message: next,
			includeTools: false,
			state: {
				values: {},
				text: "",
				data: {
					providers: { RECENT_MESSAGES: { data: { recentMessages: rows } } },
				},
			},
		});
		const scope = await retentionScope(runtime, greeting);
		expect(validateHistoryRetention(foreground, scope, checkpoint)).toEqual(
			checkpoint,
		);
		expect(checkpoint).toMatchObject({ reviewedCount: 5 });
		expect(visibleHistoryEventIds(foreground, scope, checkpoint)).toEqual(
			new Set([
				`history:${proposal.id}`,
				`history:${assent.id}`,
				`history:${greeting.id}`,
				`history:${reply.id}`,
			]),
		);
		const reviewSection = prompts[1].slice(
			prompts[1].lastIndexOf("sourceSetId:"),
		);
		expect(reviewSection).toContain(proposal.content.text);
		expect(reviewSection).toContain(`${greeting.id}`);
		expect(reviewSection).not.toContain(greeting.content.text);
		expect(reviewSection).not.toContain(reply.content.text);
		expect(reviewSection).not.toContain(message.content.text);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(
			await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
			}),
		).toEqual(rows);
	});

	it.each(["edit", "delete"])(
		"invalidates retention and re-reviews complete originals after source %s",
		async (change) => {
			const { runtime, service, message } = await setup();
			const next: Memory = {
				...message,
				id: stringToUuid(`retention-change-${change}`),
				createdAt: 20,
				content: { text: "I prefer exact quotations." },
			};
			await runtime.upsertMemory(next, "messages");
			runtime.registerEvaluator(historyRetentionEvaluator);
			runtime.useModel = vi.fn(async (_type, params) =>
				retentionAnswer(retentionPrompt(params), ["h1"]),
			) as AgentRuntime["useModel"];
			await service.enqueue(next, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			expect(
				await getEvaluatorProgressState(
					runtime,
					next,
					historyRetentionEvaluator.name,
				),
			).toMatchObject({ reviewedCount: 2 });
			if (!message.id) throw new Error("Missing fixture identity");
			const patch = {
				id: message.id,
				content: { text: "Correction: I live in Lisbon." },
			};
			await service.mutateSourceEvidence(
				[message.id],
				change === "edit" ? [patch] : undefined,
				() =>
					change === "edit"
						? runtime.updateMemory(patch)
						: runtime.deleteMemory(patch.id),
			);
			expect(
				await getEvaluatorProgressState(
					runtime,
					next,
					historyRetentionEvaluator.name,
				),
			).toBeUndefined();
			await execute(runtime, await job(runtime));
			const cp = await getEvaluatorProgressState(
				runtime,
				next,
				historyRetentionEvaluator.name,
			);
			const rows = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
			});
			expect(
				validateHistoryRetention(
					historyRetentionContext(runtime, next, rows),
					await retentionScope(runtime, next),
					cp,
				),
			).toEqual(cp);
			expect(cp).toMatchObject({ reviewedCount: change === "edit" ? 2 : 1 });
			expect(runtime.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it("retains a formerly deferred original read through existing background reference pagination", async () => {
		const { runtime, service, message } = await setup();
		runtime.registerEvaluator(historyRetentionEvaluator);
		runtime.useModel = vi.fn(async (_type, params) =>
			retentionAnswer(retentionPrompt(params), []),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const next: Memory = {
			...message,
			id: stringToUuid("retention-reference"),
			createdAt: 20,
			content: { text: "Keep following that earlier rule." },
		};
		await runtime.upsertMemory(next, "messages");
		let read = false;
		runtime.useModel = vi.fn(async (_type, params) => {
			if (!read) {
				read = true;
				return JSON.stringify({ restoreContextBefore: next.id });
			}
			return retentionAnswer(
				retentionPrompt(params),
				["h2"],
				[String(message.id)],
			);
		}) as AgentRuntime["useModel"];
		await service.enqueue(next, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		expect(
			await getEvaluatorProgressState(
				runtime,
				next,
				historyRetentionEvaluator.name,
			),
		).toMatchObject({
			reviewedCount: 2,
			retainedEventIds: [`history:${message.id}`, `history:${next.id}`],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it.each(["incomplete", "unknown-reference", "missing-source"])(
		"keeps invalid retention %s pending without hiding originals",
		async (invalid) => {
			const { runtime, service, message } = await setup();
			runtime.registerEvaluator(historyRetentionEvaluator);
			runtime.useModel = vi.fn(async (_type, params) => {
				const output = JSON.parse(
					retentionAnswer(retentionPrompt(params), ["h1"]),
				);
				if (invalid === "incomplete") output.historyRetention.complete = false;
				if (invalid === "unknown-reference")
					output.historyRetention.referenceMessageIds = [String(message.id)];
				if (invalid === "missing-source")
					output.historyRetention.retainSourceIds = [];
				return JSON.stringify(output);
			}) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await expect(execute(runtime, await job(runtime))).rejects.toThrow(
				"Background memory remains pending",
			);
			expect(
				await getEvaluatorProgressState(
					runtime,
					message,
					historyRetentionEvaluator.name,
				),
			).toBeUndefined();
			if (!message.id) throw new Error("Fixture source has no ID");
			expect(await runtime.getMemoryById(message.id)).toMatchObject({
				content: message.content,
			});
			expect(runtime.useModel).toHaveBeenCalledOnce();
		},
	);

	it("rejects a retention decision if original source bytes change during background inference", async () => {
		const { runtime, service, message } = await setup();
		runtime.registerEvaluator(historyRetentionEvaluator);
		const started = deferred<string>();
		const response = deferred<string>();
		runtime.useModel = vi.fn(async (_type, params) => {
			started.resolve(retentionPrompt(params));
			return response.promise;
		}) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const running = execute(runtime, await job(runtime));
		const prompt = await started.promise;
		if (!message.id) throw new Error("Missing original identity");
		await runtime.adapter.updateMemories([
			{ id: message.id, content: { text: "I moved to Lisbon." } },
		]);
		response.resolve(retentionAnswer(prompt, ["h1"]));
		await expect(running).rejects.toThrow(
			"Memory candidates changed during background inference",
		);
		expect(
			await getEvaluatorProgressState(
				runtime,
				message,
				historyRetentionEvaluator.name,
			),
		).toBeUndefined();
		expect(await runtime.getMemoryById(message.id)).toMatchObject({
			content: { text: "I moved to Lisbon." },
		});
	});
	it("commits derived state with progress and replays a failed commit without another model call", async () => {
		const { runtime, service, message } = await setup();
		const entry = evaluator();
		const reduce = vi.fn(({ options }: EvaluatorProcessorContext) => {
			const extraction = options.extraction;
			if (!extraction) throw new Error("Fixture requires incremental evidence");
			return {
				previous: extraction.progressState ?? null,
				sourceIds: extraction.messages.map((source) => String(source.id)),
			};
		});
		entry.progressState = reduce;
		runtime.registerEvaluator(entry);
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({ memory: { ok: true } }),
		) as AgentRuntime["useModel"];
		const write = runtime.setCache.bind(runtime);
		let failCommit = true;
		vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
			if (
				failCommit &&
				key.startsWith("evaluator-progress:") &&
				value &&
				typeof value === "object" &&
				"progressState" in value &&
				value.progressState &&
				!("pending" in value)
			) {
				failCommit = false;
				return false;
			}
			return write(key, value);
		});
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await expect(execute(runtime, task)).rejects.toBeInstanceOf(Error);
		expect(
			await getEvaluatorProgressState(runtime, message, entry.name),
		).toBeUndefined();
		await execute(runtime, task);
		expect(runtime.useModel).toHaveBeenCalledOnce();
		expect(
			await getEvaluatorProgressState(runtime, message, entry.name),
		).toEqual({ previous: null, sourceIds: [message.id] });
		expect(reduce).toHaveBeenCalledTimes(2);
		expect(
			await getEvaluatorProgressState(
				runtime,
				{ ...message, entityId: runtime.agentId },
				entry.name,
			),
		).toBeUndefined();
		const next: Memory = {
			...message,
			id: stringToUuid("progress-state-followup"),
			createdAt: 20,
			content: { text: "And I like tea." },
		};
		await runtime.upsertMemory(next, "messages");
		await service.enqueue(next, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		expect(
			await getEvaluatorProgressState(runtime, message, entry.name),
		).toEqual({
			previous: { previous: null, sourceIds: [message.id] },
			sourceIds: [next.id],
		});
	});
	it.each(["edit", "delete"])(
		"retires an accepted preference when its contextual proposal is changed by %s",
		async (change) => {
			const { runtime, service, message } = await setup();
			runtime.registerEvaluator(preferenceEvaluator);
			const proposal: Memory = {
				...message,
				id: stringToUuid(`accepted-proposal-${change}`),
				entityId: runtime.agentId,
				createdAt: 11,
				content: {
					text: "Show full title and body before saving Safety fixture notes.",
				},
			};
			const assent: Memory = {
				...message,
				id: stringToUuid(`accepted-assent-${change}`),
				createdAt: 12,
				content: { text: "Yes, keep that rule for future conversations too." },
			};
			await runtime.upsertMemory(proposal, "messages");
			await runtime.upsertMemory(assent, "messages");
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({
					preferences: {
						ops: [
							{
								op: "add_preference_fact",
								scope: "across_conversations",
								claim:
									"Show full title and body before saving Safety fixture notes in future conversations.",
								keywords: ["notes", "preview"],
								sourceMessageIds: [assent.id],
							},
						],
					},
				}),
			) as AgentRuntime["useModel"];
			await service.enqueue(assent, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const original = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
				})
			)[0];
			expect(original.metadata?.extractionSourceRevisions).toHaveProperty(
				String(proposal.id),
			);
			expect(original.entityId).toBe(assent.entityId);
			if (!proposal.id) throw new Error("Missing proposal id");
			const patch = {
				id: proposal.id,
				content: { text: "Preview every note, regardless of title." },
			};
			// This focused harness starts the service without booting a runtime.
			// Exercise the same service barrier used by RuntimeDataMutations.
			await service.mutateSourceEvidence(
				[proposal.id],
				change === "edit" ? [patch] : undefined,
				() =>
					change === "edit"
						? runtime.adapter.updateMemories([patch])
						: runtime.adapter.deleteMemories([
								proposal.id as Memory["entityId"],
							]),
			);
			const retired = await runtime.getMemoryById(
				String(original.id) as Memory["entityId"],
			);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect(retired?.content).toEqual(original.content);
			expect(await job(runtime)).toMatchObject({
				metadata: { reconciliation: true },
			});
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
			// Reprocessing must include the assent again, not just the edited agent row.
			runtime.useModel = vi.fn(async (_type, params) => {
				expect(JSON.stringify(params)).toContain(assent.content.text);
				return JSON.stringify({ preferences: { ops: [] } });
			}) as AgentRuntime["useModel"];
			await execute(runtime, await job(runtime));
			expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["model", "staged"] as const)(
		"enforces preference scope for %s output without breaking legacy recovery",
		async (source) => {
			const { runtime, service, message } = await setup();
			message.content.text = "I prefer morning check-ins.";
			await runtime.upsertMemory(message, "messages");
			runtime.registerEvaluator(preferenceEvaluator);
			const legacy = {
				ops: [
					{
						op: "add_preference_fact",
						claim: "Prefers morning check-ins",
						sourceMessageIds: [message.id],
					},
				],
			};
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({ preferences: legacy }),
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			if (source === "staged") {
				// Simulate an output durably validated by the pre-scope contract.
				const snapshots = await prepareEvaluatorProgress(
					runtime,
					message,
					[preferenceEvaluator.name],
					await runtime.getMemories({
						tableName: "messages",
						roomId: message.roomId,
						unique: false,
					}),
				);
				const snapshot = snapshots.get(preferenceEvaluator.name);
				if (!snapshot) throw new Error("Missing extraction snapshot");
				await stageEvaluatorOutput(runtime, snapshot, legacy);
				await EvaluatorService.start(runtime);
				await execute(runtime, task);
				expect(runtime.useModel).not.toHaveBeenCalled();
				expect(await runtime.getTask(task.id)).toBeNull();
				expect(
					(
						await runtime.getMemories({
							tableName: "facts",
							roomId: message.roomId,
						})
					).map((row) => row.content.text),
				).toEqual([legacy.ops[0].claim]);
			} else {
				await expect(execute(runtime, task)).rejects.toThrow(
					"Background memory remains pending",
				);
				expect(
					await runtime.getMemories({
						tableName: "facts",
						roomId: message.roomId,
					}),
				).toEqual([]);
				expect(await runtime.getTask(task.id)).not.toBeNull();
				const snapshots = await prepareEvaluatorProgress(
					runtime,
					message,
					[preferenceEvaluator.name],
					await runtime.getMemories({
						tableName: "messages",
						roomId: message.roomId,
						unique: false,
					}),
				);
				expect(
					snapshots.get(preferenceEvaluator.name)?.pendingOutput,
				).toBeUndefined();
				expect(runtime.useModel).toHaveBeenCalledOnce();
			}
		},
	);
	it("keeps malformed preference output pending without applying or acknowledging its valid subset", async () => {
		const { runtime, service, message } = await setup();
		if (!message.id) throw new Error("Persisted evidence must have an id");
		runtime.registerEvaluator(preferenceEvaluator);
		const valid = {
			op: "add_preference_fact",
			scope: "across_conversations",
			claim: "Prefers complete note previews before saving",
			keywords: ["notes", "preview"],
			sourceMessageIds: [message.id],
		};
		// Captured live failure shape: add_directive omitted required confidence.
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				preferences: {
					ops: [
						valid,
						{
							op: "add_directive",
							text: "Wait for separate confirmation before saving.",
							sourceMessageIds: [message.id],
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		expect(runtime.useModel).not.toHaveBeenCalled();
		const task = await job(runtime);
		await expect(execute(runtime, task)).rejects.toThrow(
			"Background memory remains pending",
		);
		expect(await runtime.getTask(task.id)).not.toBeNull();
		expect(
			await runtime.getMemories({ tableName: "facts", roomId: message.roomId }),
		).toEqual([]);

		// A later valid worker attempt must still receive the original evidence.
		runtime.useModel = vi.fn(async (_type, params) => {
			expect(JSON.stringify(params)).toContain(message.content.text);
			return JSON.stringify({ preferences: { ops: [valid] } });
		}) as AgentRuntime["useModel"];
		await execute(runtime, await job(runtime));
		expect(await runtime.getTask(task.id)).toBeNull();
		const facts = await runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
		});
		expect(facts.map((fact) => fact.content.text)).toEqual([valid.claim]);
		expect(facts[0].metadata?.extractionSourceRevisions).toHaveProperty(
			message.id,
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
	it.each([undefined, "current_message"] as const)(
		"supplies the complete future trigger and receipts only when their evidence page is selected (legacy scope %s)",
		async (inputScope) => {
			const { runtime, service, message } = await setup();
			const old = {
				...message,
				id: stringToUuid("earlier-own-statement"),
				createdAt: 0,
				content: {
					text: "Earlier complete owner statement with violet notebook.",
				},
			};
			await runtime.upsertMemory(old, "messages");
			const stored = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
				includeEmbedding: false,
			});
			const budget =
				Math.max(
					...stored.map(
						(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
					),
				) + 1;
			vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
				key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
			);
			runtime.registerEvaluator({ ...evaluator(), inputScope });
			runtime.useModel = vi.fn(
				async () => '{"memory":{"ok":true}}',
			) as AgentRuntime["useModel"];
			await service.enqueue(
				message,
				{
					...state,
					data: {
						actionResults: [{ success: true, text: "FUTURE_TURN_RECEIPT" }],
					},
				},
				{ phase: "post_turn" },
			);
			const task = await job(runtime);
			await execute(runtime, task);
			const params = vi.mocked(runtime.useModel).mock.calls[0][1] as {
				messages: Array<{ content: string }>;
			};
			const first = params.messages.map((row) => row.content).join("\n");
			expect(first).toContain(old.content.text);
			expect(first).not.toContain(message.content.text);
			expect(first).not.toContain("FUTURE_TURN_RECEIPT");
			expect(first).toContain("later evidence page");
			await execute(runtime, task);
			const last = vi.mocked(runtime.useModel).mock.calls[1][1] as {
				messages: Array<{ content: string }>;
			};
			expect(last.messages.map((row) => row.content).join("\n")).toContain(
				message.content.text,
			);
			expect(last.messages.map((row) => row.content).join("\n")).toContain(
				"FUTURE_TURN_RECEIPT",
			);
			expect(await runtime.getTask(task.id)).toBeNull();
		},
	);

	it("keeps diverged full pages queued when their union exceeds the shared request budget", async () => {
		const { runtime, service, message } = await setup();
		const observed: Record<string, string[]> = { lead: [], lag: [] };
		const lane = (name: string) => ({
			...evaluator(),
			name,
			processors: [
				{
					process: async ({
						options,
					}: Parameters<
						NonNullable<RegisteredEvaluator["processors"]>[number]["process"]
					>[0]) => {
						observed[name].push(
							...(options.extraction?.messages ?? []).map((row) =>
								String(row.id),
							),
						);
						return undefined;
					},
				},
			],
		});
		runtime.registerEvaluator(lane("lead"));
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({ lead: { ok: true }, lag: { ok: true } }),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const next = {
			...message,
			id: stringToUuid("bounded-union-next"),
			createdAt: 20,
			content: { text: "The complete next source, with its detail intact." },
		};
		await runtime.upsertMemory(next, "messages");
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		runtime.registerEvaluator(lane("lag"));
		await service.enqueue(next, state, { phase: "post_turn" });
		const task = await job(runtime);
		await execute(runtime, task);
		expect(await runtime.getTask(task.id)).not.toBeNull();
		for (let i = 0; i < 3 && (await runtime.getTask(task.id)); i++)
			await execute(runtime, task);
		expect(observed).toEqual({
			lead: [message.id, next.id],
			lag: [message.id, next.id],
		});
		expect(await runtime.getTask(task.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("shares exact selected ID lists between diverged lanes without losing evidence", async () => {
		const { runtime, service, message } = await setup();
		for (const name of ["leadA", "leadB"])
			runtime.registerEvaluator({ ...evaluator(), name });
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				leadA: { ok: true },
				leadB: { ok: true },
				lag: { ok: true },
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const next = {
			...message,
			id: stringToUuid("diverged-new-message"),
			createdAt: 20,
			content: { text: "Full second message with a new detail." },
		};
		await runtime.upsertMemory(next, "messages");
		runtime.registerEvaluator({ ...evaluator(), name: "lag" });
		await service.enqueue(next, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const calls = vi.mocked(runtime.useModel).mock.calls;
		const params = calls.at(-1)?.[1] as {
			messages: Array<{ content: string }>;
		};
		const prompt = params.messages.map((row) => row.content).join("\n");
		expect(prompt).toContain(message.content.text);
		expect(prompt).toContain(next.content.text);
		expect(prompt.match(/evidence-set-1:/g)).toHaveLength(1);
		expect(
			prompt.match(/only the exact source IDs in evidence-set-1/g),
		).toHaveLength(2);
		expect(prompt).not.toContain("evidence-set-2");
		expect(
			JSON.parse(prompt.match(/evidence-set-1: (\[[\s\S]*?\])/)?.[1] ?? "null"),
		).toEqual([next.id]);
	});

	it("advances other-speaker backfill pages without personal inference, then extracts the target speaker", async () => {
		const { runtime, service, message } = await setup();
		for (let i = 0; i < 2; i++)
			await runtime.upsertMemory(
				{
					...message,
					id: stringToUuid(`other-speaker-page:${i}`),
					entityId: runtime.agentId,
					createdAt: i,
					content: {
						text: `Complete historical agent record ${i} ${"context ".repeat(20)}`,
					},
				},
				"messages",
			);
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		runtime.registerEvaluator(factMemoryEvaluator);
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				factMemory: {
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin",
							category: "identity",
							keywords: ["berlin"],
							structured_fields: { city: "Berlin" },
							sourceMessageIds: [message.id],
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await execute(runtime, task);
		await execute(runtime, task);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(await runtime.getTask(task.id)).not.toBeNull();
		await execute(runtime, task);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it.each([false, true])(
		"uses a deterministic resolver only when its evidence predicate permits it (%s)",
		async (resolve) => {
			const { runtime, service, message } = await setup();
			const item = evaluator();
			item.resolveOutputWhen = () => resolve;
			item.resolveOutput = vi.fn(() => ({ ok: true }));
			runtime.registerEvaluator(item);
			runtime.useModel = vi.fn(
				async () => '{"memory":{"ok":true}}',
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			expect(runtime.useModel).toHaveBeenCalledTimes(resolve ? 0 : 1);
			expect(item.resolveOutput).toHaveBeenCalledTimes(resolve ? 1 : 0);
		},
	);

	it("enqueues once, admits another foreground turn during inference, then commits under room ownership", async () => {
		const { runtime, service, message } = await setup();
		const started = deferred<void>();
		const output = deferred<string>();
		const processor = vi.fn(async () => {
			expect(runtime.roomHandlerQueue.currentLease(turn.roomId)).toBeDefined();
			return undefined;
		});
		runtime.registerEvaluator(evaluator(processor));
		runtime.useModel = vi.fn(async () => {
			expect(
				runtime.roomHandlerQueue.currentLease(turn.roomId),
			).toBeUndefined();
			started.resolve();
			return output.promise;
		}) as AgentRuntime["useModel"];
		await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
			await service.enqueue(message, state, { phase: "post_turn" });
			await service.enqueue(message, state, { phase: "post_turn" });
			expect(runtime.useModel).not.toHaveBeenCalled();
		});
		const task = await job(runtime);
		const running = execute(runtime, task);
		await started.promise;
		let admitted = false;
		await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
			admitted = true;
		});
		expect(admitted).toBe(true);
		expect(processor).not.toHaveBeenCalled();
		output.resolve('{"memory":{"ok":true}}');
		await running;
		expect(processor).toHaveBeenCalledTimes(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it("reloads the durable job after service recreation without saving private provider state", async () => {
		const { runtime, service, message } = await setup();
		const processor = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(processor));
		await service.enqueue(
			message,
			{
				...state,
				text: "PRIVATE_PROVIDER_SENTINEL",
				values: { private: "SECRET_SENTINEL" },
				data: {
					actionResults: [
						{
							success: true,
							text: "Authorized read receipt",
							data: { apiKey: "PRIVATE_RECEIPT_SECRET_SENTINEL", count: 4 },
						},
					],
				},
			},
			{ phase: "post_turn" },
		);
		const task = await job(runtime);
		expect(JSON.stringify(task)).not.toContain("SENTINEL");
		await EvaluatorService.start(runtime);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await execute(runtime, task);
		expect(processor).toHaveBeenCalledTimes(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it.each(["source", "candidate"])(
		"retains the job and rejects a changed %s before any effect",
		async (changed) => {
			const { runtime, service, message } = await setup();
			const started = deferred<void>();
			const output = deferred<string>();
			const processor = vi.fn(async () => undefined);
			const item = evaluator(processor);
			let candidate = "original";
			item.prepare = async () => ({ candidate });
			runtime.registerEvaluator(item);
			runtime.useModel = vi.fn(async () => {
				started.resolve();
				return output.promise;
			}) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			const running = execute(runtime, task);
			await started.promise;
			await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
				if (changed === "source")
					await runtime.updateMemory({
						id: turn.id as NonNullable<Memory["id"]>,
						content: { text: "I live in Paris." },
					});
				else candidate = "new";
			});
			output.resolve('{"memory":{"ok":true}}');
			await expect(running).rejects.toBeInstanceOf(Error);
			expect(processor).not.toHaveBeenCalled();
			expect(await runtime.getTask(task.id)).not.toBeNull();
		},
	);

	it("replays durable staged output after a processor failure without another model call", async () => {
		const { runtime, service, message } = await setup();
		let fail = true;
		const processor = vi.fn(async () => {
			if (fail) throw new Error("injected reducer failure");
			return undefined;
		});
		runtime.registerEvaluator(evaluator(processor));
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await expect(execute(runtime, task)).rejects.toBeInstanceOf(Error);
		fail = false;
		await EvaluatorService.start(runtime);
		await execute(runtime, task);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(processor).toHaveBeenCalledTimes(2);
	});

	it("replays a real fact already written before a checkpoint failure without duplicating or regenerating", async () => {
		const { runtime, service, message } = await setup();
		runtime.registerEvaluator(factMemoryEvaluator);
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				factMemory: {
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin",
							category: "identity",
							keywords: ["berlin"],
							structured_fields: { city: "Berlin" },
							sourceMessageIds: [message.id],
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		const original = runtime.setCache.bind(runtime);
		let fail = true;
		vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
			if (
				fail &&
				key.startsWith("evaluator-progress:") &&
				value &&
				typeof value === "object" &&
				!Object.hasOwn(value, "pending")
			) {
				fail = false;
				return false;
			}
			return original(key, value);
		});
		await expect(execute(runtime, task)).rejects.toBeInstanceOf(Error);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: turn.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		await EvaluatorService.start(runtime);
		await execute(runtime, task);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: turn.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("does not run a second memory worker or cross an agent ownership boundary", async () => {
		const { runtime, service, message } = await setup();
		const started = deferred<void>();
		const output = deferred<string>();
		runtime.registerEvaluator(evaluator());
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return output.promise;
		}) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await expect(
			execute(runtime, { ...task, agentId: turn.entityId }),
		).rejects.toMatchObject({ code: "EVALUATOR_JOB_INVALID_SCOPE" });
		const running = execute(runtime, task);
		await started.promise;
		expect(await execute(runtime, task)).toEqual({ preserveTask: true });
		output.resolve('{"memory":{"ok":true}}');
		await running;
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
	it("processes a lossless initial backfill over durable ordered worker invocations", async () => {
		const { runtime, service, message } = await setup();
		const earlier = Array.from({ length: 5 }, (_, i) => ({
			...message,
			id: stringToUuid(`backfill:${i}`),
			createdAt: i,
			content: { text: `Complete record ${i}\n🍊 ${"source ".repeat(15)}` },
		}));
		for (const source of earlier)
			await runtime.upsertMemory(source, "messages");
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
			orderDirection: "asc",
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		const observed: Memory[] = [];
		const item = evaluator();
		item.processors = [
			{
				process: async ({ options }) => {
					observed.push(...(options.extraction?.messages ?? []));
					return undefined;
				},
			},
		];
		runtime.registerEvaluator(item);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		for (let i = 0; i < stored.length; i++) await execute(runtime, task);
		expect(
			observed.map((row) => ({ id: row.id, content: row.content })),
		).toEqual(
			[...earlier, message].map((row) => ({
				id: row.id,
				content: row.content,
			})),
		);
		expect(await runtime.getTask(task.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(stored.length);
	});

	it.each([
		{ changeReference: false, recoveryCarrier: false },
		{ changeReference: true, recoveryCarrier: false },
		{ changeReference: false, recoveryCarrier: true },
		{ changeReference: true, recoveryCarrier: true },
	])(
		"restores authored reference evidence before effects (changed=$changeReference, recovery=$recoveryCarrier)",
		async ({ changeReference, recoveryCarrier }) => {
			const { runtime, service, message } = await setup();
			const earlier = {
				...message,
				id: stringToUuid("prior-detail"),
				createdAt: 1,
				content: {
					text: "The notebook in this story is violet.\nFull reference 🍊",
				},
			};
			await runtime.upsertMemory(earlier, "messages");
			const stored = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
				includeEmbedding: false,
				orderDirection: "asc",
			});
			const budget =
				Math.max(
					...stored.map(
						(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
					),
				) + 1;
			vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
				key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
			);
			const transport = { reply: "REFERENCE_RECOVERY_CANARY".repeat(10_000) };
			if (recoveryCarrier)
				await runtime.updateMemory({
					id: earlier.id,
					content: { ...earlier.content, chatIdempotency: transport },
				});
			const processor = vi.fn(async () => undefined);
			runtime.registerEvaluator(evaluator(processor));
			let call = 0;
			runtime.useModel = vi.fn(async (_type, params) => {
				call++;
				if (call === 2)
					return JSON.stringify({
						restoreContextBefore: message.id,
						memory: { ok: false },
					});
				if (call === 3) {
					expect(JSON.stringify(params)).toContain(
						"The notebook in this story is violet.",
					);
					expect(JSON.stringify(params)).toContain("Full reference 🍊");
					expect(JSON.stringify(params)).not.toContain(
						"REFERENCE_RECOVERY_CANARY",
					);
					expect(processor).toHaveBeenCalledTimes(1);
					if (changeReference)
						await runtime.roomHandlerQueue.withLease(
							message.roomId,
							async () => {
								await runtime.updateMemory({
									id: earlier.id,
									content: { text: "The notebook is copper." },
								});
							},
						);
				}
				return '{"memory":{"ok":true}}';
			}) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			await execute(runtime, task);
			if (changeReference) {
				await expect(execute(runtime, task)).rejects.toMatchObject({
					code: "EVALUATOR_JOB_PENDING",
					context: {
						errors: [
							{
								evaluatorName: "memory",
								error: expect.stringContaining(
									"Staged evaluator evidence changed",
								),
							},
						],
					},
				});
				expect(processor).toHaveBeenCalledTimes(1);
			} else {
				await execute(runtime, task);
				expect(processor).toHaveBeenCalledTimes(2);
				expect(await runtime.getTask(task.id)).toBeNull();
			}
			expect(runtime.useModel).toHaveBeenCalledTimes(3);
			if (recoveryCarrier && !changeReference)
				expect(
					(await runtime.getMemoryById(earlier.id))?.content.chatIdempotency,
				).toEqual(transport);
		},
	);
	it.each(["edit", "delete"])(
		"reconciles a %s on the next authoritative scan while preserving explicit and foreign records",
		async (change) => {
			const { runtime, service, message } = await setup();
			runtime.registerEvaluator(factMemoryEvaluator);
			let city = "Berlin";
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({
					factMemory: {
						ops: city
							? [
									{
										op: "add_durable",
										claim: `lives in ${city}`,
										category: "identity",
										keywords: [city.toLowerCase()],
										structured_fields: { city },
										sourceMessageIds: [message.id],
									},
								]
							: [],
					},
				}),
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const original = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			)[0];
			const explicit: Memory = {
				...original,
				id: stringToUuid(`manual:${change}`),
				content: { text: "Owner saved record", source: "MEMORY" },
				metadata: { ...original.metadata, type: "custom", source: "MEMORY" },
			};
			const foreign: Memory = {
				...original,
				id: stringToUuid(`foreign:${change}`),
				entityId: stringToUuid("other-person"),
				content: { text: "Other person's record" },
			};
			await runtime.upsertMemory(explicit, "facts");
			await runtime.upsertMemory(foreign, "facts");
			let trigger = message;
			if (change === "edit") {
				city = "Paris";
				await runtime.updateMemory({
					id: message.id as NonNullable<Memory["id"]>,
					content: { text: "I live in Paris." },
				});
				trigger = { ...message, content: { text: "I live in Paris." } };
			} else {
				city = "";
				await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
				trigger = {
					...message,
					id: stringToUuid("after-delete"),
					createdAt: 20,
					content: { text: "Continue our conversation." },
				};
				await runtime.upsertMemory(trigger, "messages");
			}
			await service.enqueue(trigger, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const all = await runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				unique: false,
			});
			const retired = all.find((row) => row.id === original.id);
			expect(retired?.content).toEqual(original.content);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect(all.find((row) => row.id === explicit.id)).toEqual(explicit);
			expect(all.find((row) => row.id === foreign.id)).toEqual(foreign);
			const ownActive = all.filter(
				(row) =>
					row.entityId === message.entityId &&
					row.id !== explicit.id &&
					isActiveMemoryEvidence(row),
			);
			expect(ownActive.map((row) => row.content.text)).toEqual(
				change === "edit" ? ["lives in Paris"] : [],
			);
			expect(runtime.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it("re-examines unchanged surviving support instead of losing a multiply-supported claim", async () => {
		const { runtime, service, message } = await setup();
		const second = {
			...message,
			id: stringToUuid("independent-support"),
			createdAt: 11,
			content: { text: "Berlin is still my home." },
		};
		await runtime.upsertMemory(second, "messages");
		runtime.registerEvaluator(factMemoryEvaluator);
		let sources = [message.id, second.id];
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				factMemory: {
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin",
							category: "identity",
							keywords: ["berlin"],
							structured_fields: { city: "Berlin" },
							sourceMessageIds: sources,
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(second, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
		sources = [second.id];
		await service.enqueue(second, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const facts = await runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			unique: false,
		});
		expect(facts).toHaveLength(2);
		expect(facts.filter(isActiveMemoryEvidence)).toHaveLength(1);
		expect(facts.filter(isActiveMemoryEvidence)[0].content.text).toBe(
			"lives in Berlin",
		);
	});

	it("rereads real relationship candidates after foreground changes during inference", async () => {
		const { runtime, service, message } = await setup();
		const other = stringToUuid("candidate-change-peer");
		await runtime.createEntities([
			{ id: other, agentId: runtime.agentId, names: ["Peer"] },
		]);
		await runtime.createRoomParticipants([other], message.roomId);
		runtime.registerEvaluator(relationshipEvaluator);
		const started = deferred<void>();
		const release = deferred<string>();
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return release.promise;
		}) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const running = execute(runtime, await job(runtime));
		await started.promise;
		await runtime.roomHandlerQueue.withLease(message.roomId, () =>
			runtime.createRelationship({
				sourceEntityId: message.entityId,
				targetEntityId: other,
				tags: ["friend"],
			}),
		);
		release.resolve(JSON.stringify({ relationships: [] }));
		await expect(running).rejects.toMatchObject({
			code: "EVALUATOR_CANDIDATES_CHANGED",
		});
	});

	it("persists in-flight vectors after turn admissions close without revising evidence", async () => {
		const { runtime, service, message } = await setup();
		runtime.services.set("evaluator", [service]);
		const messageId = message.id as NonNullable<Memory["id"]>;
		const before = await runtime.getMemoryById(messageId);
		const tasks = await runtime.getTasksByName("POST_TURN_MEMORY");
		runtime.roomHandlerQueue.closeAdmissions("runtime-stop");
		await runtime.updateMemory({ id: messageId, embedding: [1, 0, 0] });
		expect(await runtime.getMemoryById(messageId)).toEqual({
			...before,
			embedding: [1, 0, 0],
		});
		expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual(tasks);
	});

	it.each([
		{ content: { text: "I live in Paris." } },
		{ entityId: stringToUuid("changed-source-owner") },
		{ metadata: { note: "changed authored metadata" } },
	])(
		"retains closed-admission protection for mixed vector patches: %j",
		async (patch) => {
			const { runtime, service, message } = await setup();
			runtime.services.set("evaluator", [service]);
			const messageId = message.id as NonNullable<Memory["id"]>;
			const before = await runtime.getMemoryById(messageId);
			runtime.roomHandlerQueue.closeAdmissions("runtime-stop");
			await expect(
				runtime.updateMemory({
					id: messageId,
					embedding: [1, 0, 0],
					...patch,
				}),
			).rejects.toMatchObject({ code: "ROOM_HANDLER_QUEUE_CLOSED" });
			expect(await runtime.getMemoryById(messageId)).toEqual(before);
		},
	);

	it("does not partially persist a mixed batch after admissions close", async () => {
		const { runtime, service, message } = await setup();
		runtime.services.set("evaluator", [service]);
		const messageId = message.id as NonNullable<Memory["id"]>;
		const second = { ...message, id: stringToUuid("second-vector-source") };
		await runtime.upsertMemory(second, "messages");
		const ids = [messageId, second.id];
		const before = await runtime.getMemoriesByIds(ids, "messages");
		runtime.roomHandlerQueue.closeAdmissions("runtime-stop");
		await expect(
			runtime.updateMemories([
				{ id: messageId, embedding: [1, 0, 0] },
				{ id: second.id, content: { text: "A corrected claim." } },
			]),
		).rejects.toMatchObject({ code: "ROOM_HANDLER_QUEUE_CLOSED" });
		expect(await runtime.getMemoriesByIds(ids, "messages")).toEqual(before);
	});

	it.each(["update", "upsert", "delete"])(
		"automatically retires source-derived facts on %s without another conversation",
		async (operation) => {
			const { runtime, service, message } = await setup();
			runtime.services.set("evaluator", [service]);
			runtime.registerEvaluator(factMemoryEvaluator);
			let city = "Berlin";
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({
					factMemory: {
						ops: [
							{
								op: "add_durable",
								claim: `lives in ${city}`,
								category: "identity",
								keywords: [city.toLowerCase()],
								structured_fields: { city },
								sourceMessageIds: [message.id],
							},
						],
					},
				}),
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const oldFact = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			)[0];
			// Embedding bookkeeping does not queue a second model call.
			await runtime.updateMemory({
				id: message.id as NonNullable<Memory["id"]>,
				embedding: [1, 0, 0],
			});
			expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toHaveLength(0);
			await service.enqueue(message, state, { phase: "post_turn" });
			const pending = await job(runtime);
			const retryPolicy = {
				updateInterval: 60_000,
				baseInterval: 15_000,
				failureCount: 2,
				maxFailures: 0,
				updatedAt: Date.now(),
				lastError: "Provider quota remains unavailable",
			};
			await runtime.updateTask(pending.id, {
				metadata: { ...pending.metadata, ...retryPolicy },
			});
			city = "Paris";
			await runtime.roomHandlerQueue.withLease(message.roomId, async () => {
				if (operation === "delete")
					await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
				else if (operation === "upsert")
					await runtime.upsertMemory(
						{ ...message, content: { text: "I live in Paris." } },
						"messages",
					);
				else
					await runtime.updateMemory({
						id: message.id as NonNullable<Memory["id"]>,
						content: { text: "I live in Paris." },
					});
			});
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
			const retired = await runtime.getMemoryById(
				oldFact.id as NonNullable<Memory["id"]>,
			);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect(retired?.content).toEqual(oldFact.content);
			const task = await job(runtime);
			expect(task.metadata).toMatchObject(retryPolicy);
			// Resume using a new service instance, as on restart.
			await EvaluatorService.start(runtime);
			await execute(runtime, task);
			expect(
				await runtime.getTask(task.id as NonNullable<Task["id"]>),
			).toBeNull();
			const active = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			).filter(isActiveMemoryEvidence);
			expect(active.map((row) => row.content.text)).toEqual(
				operation === "delete" ? [] : ["lives in Paris"],
			);
			expect(runtime.useModel).toHaveBeenCalledTimes(
				operation === "delete" ? 1 : 2,
			);
		},
	);
	it("coalesces repeated source updates with the delivery job and preserves a newer wakeup during inference", async () => {
		const { runtime, service, message } = await setup();
		runtime.services.set("evaluator", [service]);
		const process = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(process));
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: { text: "temporary revision" },
		});
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: message.content,
		});
		expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toHaveLength(0);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		process.mockClear();
		const next = {
			...message,
			id: stringToUuid("next-coalesced-turn"),
			createdAt: 20,
			content: { text: "A new follow-up." },
		};
		await runtime.upsertMemory(next, "messages");
		await service.enqueue(next, state, { phase: "post_turn" });
		const first = await job(runtime);
		const started = deferred<void>();
		const release = deferred<string>();
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return release.promise;
		}) as AgentRuntime["useModel"];
		const running = execute(runtime, first);
		await started.promise;
		// Restoring the identical source leaves the generated output valid, but the
		// task now carries a newer wakeup which the older execution cannot erase.
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: { text: "another temporary revision" },
		});
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: message.content,
		});
		const current = await job(runtime);
		expect(current.id).toBe(first.id);
		expect(current.metadata?.reconciliationRevision).not.toBe(
			first.metadata?.reconciliationRevision,
		);
		release.resolve('{"memory":{"ok":true}}');
		await running;
		expect(await runtime.getTask(first.id)).not.toBeNull();
		await execute(runtime, await job(runtime));
		expect(await runtime.getTask(first.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(process).toHaveBeenCalledTimes(1);
	});
});
