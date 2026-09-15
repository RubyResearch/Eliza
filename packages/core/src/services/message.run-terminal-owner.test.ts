/**
 * Run-terminal ownership through the real message pipeline. Model providers are
 * deterministic gates so delivery/terminal ordering is asserted without network.
 */

import { v4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import {
	factMemoryEvaluator,
	relationshipEvaluator,
} from "../features/advanced-capabilities/evaluators/reflection-items";
import { NoModelProviderConfiguredError } from "../runtime";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { RoomHandlerQueue } from "../runtime/room-handler-queue";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { getStreamingContext } from "../streaming-context";
import { createMockRuntime } from "../testing/mock-runtime";
import type { EffectReceipt, IAgentRuntime, Memory, Task } from "../types";
import { EventType, ModelType } from "../types";
import {
	applyGroundedActionReply,
	createUnavailableGroundedActionReply,
} from "../types/action-reply";
import { asUUID, ChannelType, type UUID } from "../types/primitives";
import { EvaluatorService } from "./evaluator";
import { DefaultMessageService } from "./message";
import {
	drainPostDeliveryTasks,
	drainRoomPostDeliveryTasks,
	pendingRoomPostDeliveryTaskCount,
} from "./post-delivery-task-tracker";

const AGENT_ID = "00000000-0000-0000-0000-0000000002a1" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000002b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000002c1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000002d1" as UUID;

function deferred(): {
	promise: Promise<void>;
	release: () => void;
} {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function stage1Reply(replyText: string, facts: string[] = []) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Direct answer.",
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					replyText,
					facts,
					relationships: [],
					addressedTo: [],
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function inputMessage(text: string): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
	};
}

function makeRuntime(options: {
	facts?: string[];
	factsGate?: Promise<void>;
	onFactsStarted?: () => void;
	streamText?: string;
	streamEvents?: Array<{
		chunk: string;
		accumulated: string;
		streamRevision?: number;
	}>;
	ttsGate?: Promise<void>;
	onTtsStarted?: () => void;
}): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
	terminalPayloads: Array<Record<string, unknown>>;
} {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	const terminalPayloads: Array<Record<string, unknown>> = [];
	const useModel = vi.fn(async (modelType: string, _params?: unknown) => {
		if (modelType === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
		if (modelType === ModelType.RESPONSE_HANDLER) {
			if (options.streamEvents) {
				for (const event of options.streamEvents) {
					await getStreamingContext()?.onStreamChunk(
						event.chunk,
						undefined,
						event.accumulated,
						event.streamRevision,
					);
				}
			} else if (options.streamText) {
				await getStreamingContext()?.onStreamChunk(
					options.streamText,
					undefined,
					options.streamText,
				);
			}
			return stage1Reply(
				options.streamText ??
					options.streamEvents?.at(-1)?.accumulated ??
					"Delivery is ready.",
				options.facts,
			);
		}
		if (modelType === ModelType.TEXT_LARGE) {
			options.onFactsStarted?.();
			await options.factsGate;
			return {
				toolCalls: [
					{
						name: "FACTS_AND_RELATIONSHIPS_VALIDATE",
						arguments: {
							facts: options.facts ?? [],
							relationships: [],
							thought: "Keep the explicit fact.",
						},
					},
				],
			};
		}
		if (modelType === ModelType.TEXT_TO_SPEECH) {
			options.onTtsStarted?.();
			await options.ttsGate;
			return Buffer.from("voice");
		}
		throw new Error(`Unexpected model type: ${modelType}`);
	});
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		character: { name: "Eliza", bio: "test agent" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getServicesByType: vi.fn(() => []),
		getModel: vi.fn(() => async () => ""),
		useModel,
		composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async (event: string, payload: unknown) => {
			if (event === EventType.RUN_ENDED) {
				terminalPayloads.push(payload as Record<string, unknown>);
			}
		}),
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		getMemoryById: vi.fn(async () => null),
		getMemories: vi.fn(async () => []),
		getRelationships: vi.fn(async () => []),
		getParticipantsForRoom: vi.fn(async () => []),
		getEntityById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: ChannelType.DM,
			source: "client_chat",
		})),
		getRoomsByIds: vi.fn(async () => []),
		redactSecrets: vi.fn((text: string) => text),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
	return { runtime, useModel, terminalPayloads };
}

describe("DefaultMessageService run-terminal owner", () => {
	it.each(
		[
			{
				label: "HTTP 429",
				kind: "rate_limited",
				error: () =>
					Object.assign(new Error("Rate limit"), { statusCode: 429 }),
			},
			{
				label: "HTTP 503",
				kind: "provider_issue",
				error: () =>
					Object.assign(new Error("Unavailable"), { statusCode: 503 }),
			},
			{
				label: "no provider",
				kind: "no_provider",
				error: () => new NoModelProviderConfiguredError(),
			},
		].flatMap((failure) => [
			{ ...failure, outcome: "applied" as const },
			{ ...failure, outcome: "noop" as const },
		]),
	)(
		"stops message recovery and hooks after $outcome evidence plus evaluator $label",
		async ({ kind, error, outcome }) => {
			const { runtime, useModel, terminalPayloads } = makeRuntime({});
			const receiptBase = {
				receiptId: "calendar-delete-outcome-1",
				operation: "calendar.event.delete",
				resource: { kind: "calendar.event", id: "event-1" },
				artifacts: [],
				idempotency: { key: "delete-request-1", replayed: false },
				observedAt: "2026-09-05T10:00:00.000Z",
			};
			const receipt: EffectReceipt =
				outcome === "applied"
					? {
							...receiptBase,
							outcome,
							commit: {
								kind: "durable",
								id: "delete-1",
								committedAt: receiptBase.observedAt,
							},
						}
					: {
							...receiptBase,
							outcome,
							reason: "The selected event was absent, so no mutation occurred.",
						};
			const stage1 = stage1Reply("");
			Object.assign(stage1.toolCalls[0].arguments, {
				contexts: ["general"],
				candidateActionNames: ["CALENDAR"],
				requiresTool: true,
			});
			let responseCalls = 0;
			useModel.mockReset().mockImplementation(async (type) => {
				if (type === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
				if (type === ModelType.RESPONSE_HANDLER) {
					if (++responseCalls === 1) return stage1;
					throw error();
				}
				if (type === ModelType.ACTION_PLANNER)
					return {
						text: "",
						toolCalls: [{ id: "delete-1", name: "CALENDAR", arguments: {} }],
					};
				// The pre-fix message boundary incorrectly requests this extra
				// recovery model after the evaluator already declared unavailability.
				if (type === ModelType.TEXT_SMALL)
					return JSON.stringify({
						response: "The calendar operation has a recorded outcome.",
						effectReceiptIds: [],
					});
				throw new Error(`Unexpected post-failure model: ${type}`);
			});
			const events = new Set(
				outcome === "applied" ? ["event-1", "untouched"] : ["untouched"],
			);
			const handler = vi.fn(async () => {
				if (outcome === "applied") expect(events.delete("event-1")).toBe(true);
				return {
					success: outcome === "applied",
					transcriptVisibility: "internal" as const,
					turnComplete: false,
					effectReceipts: [receipt],
					data: { deleted: outcome === "applied", retryable: false },
				};
			});
			runtime.actions = [
				{
					name: "CALENDAR",
					description: "Delete the selected calendar event.",
					contexts: ["general"],
					tags: ["write"],
					validate: async () => true,
					handler,
				},
			];
			const callback = vi.fn(async () => []);
			const result = await new DefaultMessageService().handleMessage(
				runtime,
				inputMessage("Delete the selected calendar event."),
				callback,
			);
			await drainPostDeliveryTasks(runtime);
			expect(
				useModel.mock.calls
					.map(([type]) => type)
					.filter((type) => type !== ModelType.TEXT_EMBEDDING),
			).toEqual([
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result).toMatchObject({
				responseContent: null,
				terminalFailure: {
					kind,
					code: "EVALUATOR_REPLY_GENERATION_FAILED",
					transient: false,
				},
				actionResults: [
					{
						success: outcome === "applied",
						effectReceipts: [receipt],
						replyFailure: { kind, transient: false },
					},
				],
			});
			expect([...events]).toEqual(["untouched"]);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
			const modes = vi
				.mocked(runtime.runActionsByMode)
				.mock.calls.map(([mode]) => mode);
			expect(modes).not.toContain("CONTEXT_AFTER");
			expect(modes).not.toContain("ALWAYS_AFTER");
			expect(terminalPayloads).toHaveLength(1);
		},
	);

	it("ends a committed action with unavailable reply without post-turn models or action hooks", async () => {
		const { runtime, useModel, terminalPayloads } = makeRuntime({});
		const unavailable = createUnavailableGroundedActionReply({
			kind: "provider_issue",
			code: "GROUNDED_REPLY_GENERATION_FAILED",
		});
		const receipt = {
			receiptId: "saved-1",
			operation: "lifeops.reminder.create",
			resource: { kind: "lifeops.reminder", id: "reminder-1" },
			artifacts: [],
			idempotency: { key: "request-1", replayed: false },
			observedAt: "2026-07-27T18:00:00.000Z",
			outcome: "applied" as const,
			commit: {
				kind: "durable" as const,
				id: "txn-1",
				committedAt: "2026-07-27T18:00:00.000Z",
			},
		};
		const stage1 = stage1Reply("");
		Object.assign(stage1.toolCalls[0].arguments, {
			contexts: ["general"],
			candidateActionNames: ["SAVE"],
			requiresTool: true,
		});
		useModel.mockReset().mockImplementation(async (type) => {
			if (type === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
			if (type === ModelType.RESPONSE_HANDLER) return stage1;
			if (type === ModelType.ACTION_PLANNER)
				return {
					text: "",
					toolCalls: [{ id: "save-1", name: "SAVE", arguments: {} }],
				};
			throw new Error(`Unexpected post-reply model: ${type}`);
		});
		const handler = vi.fn(async () =>
			applyGroundedActionReply(
				{ success: true, effectReceipts: [receipt] },
				unavailable,
			),
		);
		runtime.actions = [
			{
				name: "SAVE",
				description: "Save a reminder.",
				contexts: ["general"],
				tags: ["write"],
				validate: async () => true,
				handler,
			},
		];
		const callback = vi.fn(async () => []);
		const result = await new DefaultMessageService().handleMessage(
			runtime,
			inputMessage("Save this reminder."),
			callback,
		);
		await drainPostDeliveryTasks(runtime);
		expect(result).toMatchObject({
			responseContent: null,
			terminalFailure: unavailable.failure,
			actionResults: [
				{
					success: true,
					effectReceipts: [receipt],
					replyFailure: unavailable.failure,
				},
			],
		});
		expect(handler).toHaveBeenCalledTimes(1);
		expect(
			useModel.mock.calls.filter(([type]) => type !== ModelType.TEXT_EMBEDDING),
		).toHaveLength(2);
		expect(callback).not.toHaveBeenCalled();
		expect(
			vi.mocked(runtime.runActionsByMode).mock.calls.map(([mode]) => mode),
		).not.toContain("ALWAYS_AFTER");
		expect(terminalPayloads).toHaveLength(1);
	});

	it("durably delegates built-in fact validation to the shared background batch with no second foreground model", async () => {
		const { runtime, useModel } = makeRuntime({
			facts: ["The user likes jasmine tea."],
		});
		runtime.evaluators = [factMemoryEvaluator, relationshipEvaluator];
		const tasks = new Map<UUID, Task>();
		runtime.getTask = async (id) => tasks.get(id) ?? null;
		runtime.createTask = async (task) => {
			if (!task.id) throw new Error("Task ID required");
			tasks.set(task.id, structuredClone(task));
			return task.id;
		};
		runtime.updateTask = async (id, patch) => {
			const old = tasks.get(id);
			if (!old) throw new Error("Task missing");
			tasks.set(id, { ...old, ...patch });
		};
		runtime.registerTaskWorker = vi.fn();
		const memory = await EvaluatorService.start(runtime);
		runtime.getService = ((name: string) =>
			name === "evaluator" ? memory : null) as IAgentRuntime["getService"];
		runtime.getServiceLoadPromise = (async () =>
			memory) as IAgentRuntime["getServiceLoadPromise"];
		const deliveries: string[] = [];
		await new DefaultMessageService().handleMessage(
			runtime,
			inputMessage("I like jasmine tea"),
			async (content) => {
				if (content.text) deliveries.push(content.text);
				return [];
			},
		);
		await drainPostDeliveryTasks(runtime);
		expect(deliveries).toContain("Delivery is ready.");
		expect(
			useModel.mock.calls.filter(([type]) => type === ModelType.TEXT_LARGE),
		).toHaveLength(0);
		expect([...tasks.values()]).toHaveLength(1);
		expect([...tasks.values()][0]).toMatchObject({
			name: "POST_TURN_MEMORY",
			entityId: ENTITY_ID,
			roomId: ROOM_ID,
		});
	});

	it("waits for parallel facts extraction without delaying visible delivery", async () => {
		const gate = deferred();
		const started = deferred();
		const { runtime, useModel, terminalPayloads } = makeRuntime({
			facts: ["The user likes jasmine tea."],
			factsGate: gate.promise,
			onFactsStarted: started.release,
		});
		const deliveries: string[] = [];
		const service = new DefaultMessageService();

		const result = await service.handleMessage(
			runtime,
			inputMessage("I like jasmine tea"),
			async (content) => {
				if (content.text) deliveries.push(content.text);
				return [];
			},
		);
		await started.promise;
		expect(result.trajectoryTerminalOwner).toBe("run");
		expect(deliveries).toContain("Delivery is ready.");
		expect(terminalPayloads).toEqual([]);

		gate.release();
		await drainPostDeliveryTasks(runtime);
		expect(
			useModel.mock.calls.filter(([type]) => type === ModelType.TEXT_LARGE),
		).toHaveLength(1);
		expect(terminalPayloads).toHaveLength(1);
	});

	it("waits for first and trailing speech captures without delaying text delivery", async () => {
		const gate = deferred();
		const started = deferred();
		const streamText = "First sentence. Trailing sentence.";
		const { runtime, useModel, terminalPayloads } = makeRuntime({
			streamText,
			ttsGate: gate.promise,
			onTtsStarted: started.release,
		});
		const deliveries: string[] = [];
		const service = new DefaultMessageService();

		const result = await service.handleMessage(
			runtime,
			inputMessage("speak the result"),
			async (content) => {
				if (content.text) deliveries.push(content.text);
				return [];
			},
			{ onStreamChunk: async () => undefined },
		);
		await started.promise;
		expect(result.trajectoryTerminalOwner).toBe("run");
		expect(deliveries).toContain(streamText);
		expect(terminalPayloads).toEqual([]);

		gate.release();
		await drainPostDeliveryTasks(runtime);
		expect(
			useModel.mock.calls.filter(([type]) => type === ModelType.TEXT_TO_SPEECH),
		).toHaveLength(2);
		expect(terminalPayloads).toHaveLength(1);
	});

	it("replays authoritative first-sentence state after a structured retry", async () => {
		const { runtime, useModel } = makeRuntime({
			streamEvents: [
				{ chunk: "Prof", accumulated: "Prof" },
				{
					chunk: ".) arrived.",
					accumulated: "Okay.) arrived.",
					streamRevision: 1,
				},
			],
		});
		const service = new DefaultMessageService();

		await service.handleMessage(
			runtime,
			inputMessage("speak the retried result"),
			async () => [],
			{ onStreamChunk: async () => undefined },
		);
		await drainPostDeliveryTasks(runtime);

		const speechParams = useModel.mock.calls
			.filter(([type]) => type === ModelType.TEXT_TO_SPEECH)
			.map(([, params]) => params);
		expect(speechParams).toMatchObject([
			{ text: "Okay.)" },
			{ text: "arrived." },
		]);
	});

	it("keeps legacy post-turn state work ordered before a later turn can forget it", async () => {
		const modelGate = deferred();
		const modelStarted = deferred();
		const facts = new Set<string>();
		const writes: string[] = [];
		const { runtime } = makeRuntime({});
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		(
			runtime as unknown as { roomHandlerQueue: RoomHandlerQueue }
		).roomHandlerQueue = queue;
		(
			runtime as unknown as { getServiceLoadPromise: unknown }
		).getServiceLoadPromise = vi.fn(async () => ({
			enqueue: async () => {
				modelStarted.release();
				await modelGate.promise;
				facts.add("jasmine tea");
				writes.push("extract");
				return {
					skipped: false,
					activeEvaluators: ["facts"],
					processedEvaluators: ["facts"],
					results: [],
					errors: [],
				};
			},
		}));
		const lease = await queue.acquire(ROOM_ID);
		const delivered = vi.fn(async () => []);
		await queue.runInLease(ROOM_ID, lease, () =>
			new DefaultMessageService().handleMessage(
				runtime,
				inputMessage("I like jasmine tea"),
				delivered,
				{ roomHandlerLease: lease },
			),
		);
		await modelStarted.promise;
		expect(delivered).toHaveBeenCalled();
		// The chat transport drains room-state continuations before releasing
		// its lease; reproduce that ownership contract here.
		const releasing = drainRoomPostDeliveryTasks(runtime, ROOM_ID).then(() =>
			lease.release(),
		);
		const forgetTurn = queue.withLease(ROOM_ID, async () => {
			facts.delete("jasmine tea");
			writes.push("forget");
		});
		// The newer mutation must not run before the older extraction lands,
		// even though the user has already received the first reply.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(writes).toEqual([]);
		modelGate.release();
		await releasing;
		await forgetTurn;
		await drainPostDeliveryTasks(runtime);
		expect(writes).toEqual(["extract", "forget"]);
		expect(facts.size).toBe(0);
	});

	it("keeps post-turn state writes ordered while visible delivery is already complete", async () => {
		// ALWAYS_AFTER can mutate state used by the next turn. It cannot be
		// classified as diagnostics simply to release the room lease earlier.
		const afterGate = deferred();
		const afterStarted = deferred();
		const { runtime, terminalPayloads } = makeRuntime({});
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		(
			runtime as unknown as { roomHandlerQueue: RoomHandlerQueue }
		).roomHandlerQueue = queue;
		(runtime.runActionsByMode as ReturnType<typeof vi.fn>).mockImplementation(
			async (mode: string) => {
				if (mode === "ALWAYS_AFTER") {
					afterStarted.release();
					await afterGate.promise;
				}
			},
		);
		const service = new DefaultMessageService();
		const lease = await queue.acquire(ROOM_ID);

		const result = await queue.runInLease(ROOM_ID, lease, () =>
			service.handleMessage(
				runtime,
				inputMessage("what's on my calendar tuesday?"),
				async () => [],
				{ roomHandlerLease: lease },
			),
		);
		expect(result.trajectoryTerminalOwner).toBe("run");
		await afterStarted.promise;

		// Delivery is done, but the next turn must still wait for state writes.
		const settledBefore = <T>(work: Promise<T>) =>
			Promise.race([
				work.then(() => "settled" as const),
				new Promise<"blocked">((resolve) =>
					setTimeout(() => resolve("blocked"), 250),
				),
			]);
		const roomDrain = drainRoomPostDeliveryTasks(runtime, ROOM_ID);
		expect(await settledBefore(roomDrain)).toBe("blocked");
		expect(pendingRoomPostDeliveryTaskCount(runtime, ROOM_ID)).toBeGreaterThan(
			0,
		);
		const nextTurn = queue.acquire(ROOM_ID);
		expect(await settledBefore(nextTurn)).toBe("blocked");
		expect(terminalPayloads).toEqual([]);

		afterGate.release();
		await roomDrain;
		await lease.release();
		await drainPostDeliveryTasks(runtime);
		expect(terminalPayloads).toHaveLength(1);
		await (await nextTurn).release();
	});
});
