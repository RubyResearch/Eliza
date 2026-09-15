/**
 * Voice == text DELIVERY parity through the real `DefaultMessageService
 * .handleMessage` (sibling of voice-text-parity-pipeline.test.ts, which covers
 * pipeline-shape parity). The shipped contract: a tool-routed utterance
 * arriving as a VOICE_DM must produce the SAME user-visible deliveries as the
 * identical utterance arriving as a text DM — the Stage-1 pre-planner ack is
 * only delivered ahead of the final reply when the routed work is an
 * async-handoff action (`asyncHandoff: true`, sub-agent spawn class), never
 * for synchronous retrieval/tool turns. Egress-rejected early replies are
 * dropped, not substituted with a manufactured "On it.". The message pipeline
 * is real; only the model surface is stubbed (deterministic — no live model).
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import {
	candidateActionsIncludeAsyncHandoff,
	DefaultMessageService,
} from "../services/message";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Action, IAgentRuntime } from "../types";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";

const AGENT = "00000000-0000-0000-0000-00000000003a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000003b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000003c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000003d" as UUID;

const PROGRESS_ACK = "On it.";
const SYNC_FINAL = "You decided to move the standup to 10am.";
const ASYNC_FINAL = "Sub-agent spawned; the results will follow.";

function makeMessage(channelType: ChannelType, text: string): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text,
			source: "discord",
			channelType,
		},
		createdAt: Date.now(),
	};
}

function makeRoom(channelType: ChannelType): Room {
	return {
		id: ROOM,
		source: "discord",
		type: channelType,
	} as Room;
}

/** Stage-1 HANDLE_RESPONSE envelope routing the turn INTO the planner. */
function stage1ToolRouted(replyText: string, candidateActionNames: string[]) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Route to the planner.",
					contexts: ["general"],
					intents: [],
					candidateActionNames,
					replyText,
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function plannerToolCall(actionName: string) {
	return {
		text: "",
		toolCalls: [{ id: `call-${actionName}`, name: actionName, args: {} }],
	};
}

function finishDecision(messageToUser: string) {
	return JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "Tool ran; deliver the result.",
		messageToUser,
	});
}

function makeAction(
	name: string,
	options: { asyncHandoff?: boolean } = {},
): Action {
	return {
		name,
		description: `${name} test action`,
		similes: [],
		examples: [],
		parameters: [],
		...(options.asyncHandoff ? { asyncHandoff: true } : {}),
		validate: async () => true,
		handler: async () => ({ success: true, text: "" }),
	} as unknown as Action;
}

/**
 * Deterministic model surface dispatched by model type. RESPONSE_HANDLER and
 * ACTION_PLANNER each consume their own queue and repeat the final entry so a
 * benign extra decision-evaluator call cannot desync the run.
 */
function makeUseModel(queues: {
	responseHandler: unknown[];
	actionPlanner: unknown[];
}): IAgentRuntime["useModel"] {
	const byType = new Map<string, unknown[]>([
		[String(ModelType.RESPONSE_HANDLER), [...queues.responseHandler]],
		[String(ModelType.ACTION_PLANNER), [...queues.actionPlanner]],
	]);
	return vi.fn(async (modelType: unknown) => {
		const queue = byType.get(String(modelType));
		if (!queue || queue.length === 0) {
			throw new Error(`Unexpected useModel call for ${String(modelType)}`);
		}
		return queue.length === 1 ? queue[0] : queue.shift();
	}) as unknown as IAgentRuntime["useModel"];
}

function makePipelineRuntime(
	useModel: IAgentRuntime["useModel"],
	actions: Action[],
	channelType: ChannelType,
): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	const room = makeRoom(channelType);
	return createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Parity Agent",
			bio: "test agent",
		},
		actions,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		// The per-callback character-voice rewrite would spend extra model calls
		// and restyle delivered text — the same opt-out the scenario runner uses.
		getSetting: vi.fn((key: string) =>
			key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
		),
		getService: vi.fn(() => null),
		getModel: vi.fn(() => async () => ""),
		useModel,
		composeState: vi.fn(async () => ({
			values: { availableContexts: "general" },
			data: {},
			text: "",
		})),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => room),
		getRoomsByIds: vi.fn(async () => [room]),
		getMemories: vi.fn(async () => []),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
}

/** One real handleMessage turn; returns the visible texts a connector sends. */
async function runTurn(opts: {
	channelType: ChannelType;
	utterance: string;
	replyText: string;
	candidateActionNames: string[];
	actions: Action[];
	plannerActionName: string;
	finalText: string;
}): Promise<string[]> {
	const runtime = makePipelineRuntime(
		makeUseModel({
			responseHandler: [
				stage1ToolRouted(opts.replyText, opts.candidateActionNames),
				finishDecision(opts.finalText),
			],
			actionPlanner: [plannerToolCall(opts.plannerActionName)],
		}),
		opts.actions,
		opts.channelType,
	);
	const service = new DefaultMessageService();
	const deliveries: Content[] = [];
	await service.handleMessage(
		runtime,
		makeMessage(opts.channelType, opts.utterance),
		async (content) => {
			deliveries.push(content);
			return [];
		},
	);
	return deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.length > 0);
}

describe("voice == text delivery parity through handleMessage", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		{ channel: ChannelType.DM, metadata: { uiView: "notes" } },
		{
			channel: ChannelType.VOICE_DM,
			metadata: { clientTransport: "realtime_voice" },
		},
	])(
		"keeps model-selected app tools focused on $channel without a voice view snapshot",
		async ({ channel, metadata }) => {
			const useModel = makeUseModel({
				responseHandler: [
					stage1ToolRouted("", ["VIEWS"]),
					finishDecision("Home is open."),
				],
				actionPlanner: [plannerToolCall("VIEWS")],
			});
			const runtime = makePipelineRuntime(
				useModel,
				[makeAction("VIEWS"), makeAction("UNRELATED")],
				channel,
			);
			const message = makeMessage(channel, "Go home.");
			message.content.source = "client_chat";
			message.content.metadata = metadata;
			await new DefaultMessageService().handleMessage(
				runtime,
				message,
				async () => [],
			);
			const plannerCalls = vi
				.mocked(useModel)
				.mock.calls.filter(([type]) => type === ModelType.ACTION_PLANNER);
			expect(plannerCalls.length).toBeGreaterThan(0);
			for (const [, params] of plannerCalls) {
				const tools = JSON.stringify(params.tools);
				expect(tools).toContain('"VIEWS"');
				expect(tools).not.toContain('"UNRELATED"');
			}
		},
	);

	it("a synchronous tool-routed turn delivers the same bubbles on VOICE_DM and DM (no pre-planner filler)", async () => {
		const base = {
			utterance: "what did we decide about the standup time?",
			replyText: PROGRESS_ACK,
			candidateActionNames: ["MEMORY_SEARCH"],
			actions: [makeAction("MEMORY_SEARCH")],
			plannerActionName: "MEMORY_SEARCH",
			finalText: SYNC_FINAL,
		};
		const text = await runTurn({ ...base, channelType: ChannelType.DM });
		const voice = await runTurn({ ...base, channelType: ChannelType.VOICE_DM });

		// Equal user-visible delivery counts AND equal content: one bubble — the
		// answer — on both transports. The Stage-1 ack is never spoken ahead of
		// a synchronous retrieval result.
		expect(text).toEqual([SYNC_FINAL]);
		expect(voice).toEqual(text);
		expect(voice).not.toContain(PROGRESS_ACK);
	});

	it("an asyncHandoff-flagged candidate still gets the early ack on voice", async () => {
		const base = {
			utterance: "spawn a coding agent to fix the failing build",
			replyText: PROGRESS_ACK,
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			actions: [makeAction("TASKS_SPAWN_AGENT", { asyncHandoff: true })],
			plannerActionName: "TASKS_SPAWN_AGENT",
			finalText: ASYNC_FINAL,
		};
		const text = await runTurn({ ...base, channelType: ChannelType.DM });
		const voice = await runTurn({ ...base, channelType: ChannelType.VOICE_DM });

		// The handoff's execution continues after the turn returns, so voice
		// earns the pre-planner ack; the final reply follows on both transports.
		expect(voice[0]).toBe(PROGRESS_ACK);
		expect(voice).toContain(ASYNC_FINAL);
		expect(voice).toHaveLength(2);
		expect(text).toEqual([ASYNC_FINAL]);
	});

	it("an egress-rejected early reply is dropped, never substituted with a manufactured ack", async () => {
		const base = {
			utterance: "remind me about the pickup",
			// An ungrounded completion claim: no tool has run when Stage 1 emits
			// this, so early egress must reject it.
			replyText: "Done — I've already scheduled the reminder.",
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			actions: [makeAction("TASKS_SPAWN_AGENT", { asyncHandoff: true })],
			plannerActionName: "TASKS_SPAWN_AGENT",
			finalText: ASYNC_FINAL,
		};
		const text = await runTurn({ ...base, channelType: ChannelType.DM });
		const voice = await runTurn({ ...base, channelType: ChannelType.VOICE_DM });

		// Even with an async-handoff candidate (the gate would allow delivery),
		// the rejected claim is dropped — not rewritten to "On it." — so both
		// transports deliver only the grounded final reply.
		expect(voice).toEqual([ASYNC_FINAL]);
		expect(text).toEqual([ASYNC_FINAL]);
		expect(voice).not.toContain(PROGRESS_ACK);
		expect(voice.join(" ")).not.toContain("already scheduled");
	});
});

describe("candidateActionsIncludeAsyncHandoff", () => {
	const spawn = {
		...makeAction("TASKS", { asyncHandoff: true }),
		similes: ["SPAWN_AGENT", "SPAWN_CODING_AGENT"],
	} as Action;
	const search = makeAction("MEMORY_SEARCH");

	it("matches an async-handoff candidate by canonical name", () => {
		expect(
			candidateActionsIncludeAsyncHandoff([spawn, search], ["TASKS"]),
		).toBe(true);
	});

	it("matches an async-handoff candidate by simile (Stage 1 routinely hints by simile)", () => {
		expect(
			candidateActionsIncludeAsyncHandoff([spawn, search], ["spawn_agent"]),
		).toBe(true);
	});

	it("stays false for synchronous candidates and empty candidate sets", () => {
		expect(
			candidateActionsIncludeAsyncHandoff([spawn, search], ["MEMORY_SEARCH"]),
		).toBe(false);
		expect(candidateActionsIncludeAsyncHandoff([spawn, search], [])).toBe(
			false,
		);
		expect(candidateActionsIncludeAsyncHandoff(undefined, ["TASKS"])).toBe(
			false,
		);
	});
});
