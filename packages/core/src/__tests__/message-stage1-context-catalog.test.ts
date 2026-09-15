/**
 * Coverage for the Stage 1 available-contexts catalog: `formatAvailableContextsForPrompt`
 * rendering (compact and role-gated) and the role-scoped context list injected
 * into the `runV5MessageRuntimeStage1` system prompt. Deterministic `vi`-mocked
 * runtime with a canned tool-call response; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../actions/to-tool";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ContextRegistry } from "../runtime/context-registry";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import {
	__buildV5ExecutorContextForTests,
	formatAvailableContextsForPrompt,
	runV5MessageRuntimeStage1,
} from "../services/message";
import { currentMessageContentForContext } from "../services/message/dialogue-context";
import type { ContextDefinition } from "../types/contexts";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function stage1Response(fields: {
	shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
	thought?: string;
	contexts?: string[];
	intents?: string[];
	candidateActionNames?: string[];
	replyText?: string;
	facts?: string[];
	relationships?: unknown[];
	addressedTo?: string[];
	extra?: Record<string, unknown>;
}): {
	text: string;
	toolCalls: Array<{
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}>;
} {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: fields.shouldRespond ?? "RESPOND",
					thought: fields.thought ?? "",
					contexts: fields.contexts ?? [],
					intents: fields.intents ?? [],
					candidateActionNames: fields.candidateActionNames ?? [],
					replyText: fields.replyText ?? "",
					facts: fields.facts ?? [],
					relationships: fields.relationships ?? [],
					addressedTo: fields.addressedTo ?? [],
					...(fields.extra ?? {}),
				},
			},
		],
	};
}

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Hello.",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {
			availableContexts: "general, calendar",
		},
		data: {},
		text: "Recent conversation summary",
	};
}

function createResponseHandlerFieldRegistry(): ResponseHandlerFieldRegistry {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return responseHandlerFieldRegistry;
}

function makeRuntimeWithContexts(
	contexts: readonly ContextDefinition[],
	stage1ResponseBody: unknown,
): IAgentRuntime {
	const registry = new ContextRegistry(contexts);
	const responseHandlerFieldRegistry = createResponseHandlerFieldRegistry();
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: { name: "Test Agent", system: "You are concise." },
		actions: [],
		providers: [],
		getRoom: vi.fn(async () => null),
		// Stage 1 resolves the structural always-respond bypass through
		// `runtime.getSetting`, which every real runtime implements; the fake
		// answers "unconfigured" so only the built-in bypass list applies.
		getSetting: vi.fn(() => undefined),
		reportError: vi.fn(),
		contexts: registry,
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => stage1ResponseBody),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as IAgentRuntime;
}

const FIXTURE_CONTEXTS: readonly ContextDefinition[] = [
	{
		id: "general",
		label: "General",
		description: "Normal conversation.",
	},
	{
		id: "calendar",
		label: "Calendar",
		description: "Manage calendar events.",
		roleGate: { minRole: "ADMIN" },
	},
	{
		id: "wallet",
		label: "Wallet",
		description: "Crypto wallet ops.",
		roleGate: { minRole: "OWNER" },
	},
	{
		id: "memory",
		label: "Memory",
		description: "Long-term agent memory.",
		roleGate: { minRole: "USER" },
	},
];

describe("client-chat model context preserves executor transport state", () => {
	it("keeps replay and tab targeting in the original message while sending complete semantic fields", async () => {
		const message = makeMessage();
		message.content = {
			text: 'Open Notes; keep the exact value "chatIdempotency" in mind.',
			source: "client_chat",
			channelType: ChannelType.DM,
			chatIdempotency: {
				version: 1,
				scope: "agent:room:speaker",
				clientMessageId: "request-1",
				fingerprint: "transport-fingerprint",
			},
			metadata: {
				viewClientId: "target-client-tab",
				uiView: "calendar",
				uiViewPath: "/calendar",
				uiTimeZone: "America/New_York",
				customEvidence: { text: "complete plugin evidence", values: [1, 2, 3] },
			},
			replyToMessageText:
				"Keep Calendar unchanged unless I explicitly navigate.",
		};
		const original = structuredClone(message);
		const runtime = makeRuntimeWithContexts(
			FIXTURE_CONTEXTS,
			stage1Response({ contexts: ["simple"], replyText: "Hello." }),
		);
		await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});
		const params = useModelCalls(runtime)[0]?.[1] as {
			messages: Array<{ role: string; content: string }>;
		};
		const wire = params.messages.find(
			(entry) => entry.role === "user",
		)?.content;
		expect(wire).toBeDefined();
		const projected = JSON.parse(wire?.split("message:user:\n").at(-1) ?? "");
		expect(projected).toEqual({
			text: original.content.text,
			source: "client_chat",
			channelType: ChannelType.DM,
			metadata: {
				uiView: "calendar",
				uiViewPath: "/calendar",
				uiTimeZone: "America/New_York",
				customEvidence: { text: "complete plugin evidence", values: [1, 2, 3] },
			},
			replyToMessageText: original.content.replyToMessageText,
		});
		const executor = __buildV5ExecutorContextForTests({
			message,
			state: makeState(),
			selectedContexts: ["general"],
			senderRole: "OWNER",
			previousResults: [],
		});
		expect(executor.message).toBe(message);
		expect(executor.message.content).toEqual(original.content);
		expect(message).toEqual(original);
	});

	it.each([
		{ source: "discord", channelType: ChannelType.DM },
		{ source: "client_chat", channelType: ChannelType.VOICE_DM },
		{ source: "client_chat", channelType: ChannelType.GROUP },
		{ source: "client_chat", channelType: undefined },
	])(
		"preserves other transport contracts: $source / $channelType",
		(channel) => {
			const message = makeMessage();
			message.content = {
				text: "complete original request",
				...channel,
				chatIdempotency: { custom: "provider-owned data" },
				metadata: { viewClientId: "provider-owned reference" },
			};
			expect(currentMessageContentForContext(message)).toBe(message.content);
		},
	);
});

describe("formatAvailableContextsForPrompt", () => {
	it("renders id, routing metadata, and description per line", () => {
		const block = formatAvailableContextsForPrompt(FIXTURE_CONTEXTS);
		expect(block).toContain("- general [label=General]: Normal conversation.");
		expect(block).toContain(
			"- calendar [label=Calendar]: Manage calendar events.",
		);
		expect(block).toContain("- memory [label=Memory]: Long-term agent memory.");
	});

	it("omits role-gate and cache metadata while retaining routing metadata", () => {
		// The catalog is role-filtered before it renders, so the gate suffix had
		// no reader and cost ~3.3K chars per Stage-1 call on the owner catalog
		// (2026-09-13). Cache policy is enforcement metadata, not routing input.
		// Label, aliases, hierarchy and sensitivity stay: they are the routing
		// metadata a CONTEXT_CATALOG read is documented to return.
		const block = formatAvailableContextsForPrompt([
			{
				id: "terminal",
				label: "Terminal",
				aliases: ["shell"],
				parent: "code",
				description: "Execute shell commands.",
				roleGate: { minRole: "OWNER" },
				sensitivity: "private",
				cacheScope: "turn",
			},
			{ id: "wallet", parents: ["finance"], roleGate: { anyOf: ["OWNER"] } },
		]);
		expect(block).toBe(
			[
				"- terminal [label=Terminal; aliases=shell; parent=code; sensitivity=private]: Execute shell commands.",
				"- wallet [parents=finance]",
			].join("\n"),
		);
		expect(block).not.toContain("role");
		expect(block).not.toContain("cache");
	});

	it("falls back to a placeholder when no contexts are registered", () => {
		expect(formatAvailableContextsForPrompt([])).toBe(
			"(no contexts registered)",
		);
	});

	it("renders the COMPLETE description even when a compressed hint exists (compact tier retired by #24134)", () => {
		const contexts: readonly ContextDefinition[] = [
			{
				id: "general",
				label: "General",
				description: "Normal conversation.",
			},
			{
				id: "tasks",
				label: "Tasks",
				description: "The complete long-form routing description.",
				descriptionCompressed: "reminders/habits/todos",
			},
		];
		const block = formatAvailableContextsForPrompt(contexts);
		// The complete description always renders; the compressed hint never
		// substitutes for it in model-facing context (prompt-integrity).
		expect(block).toContain(
			"- tasks [label=Tasks]: The complete long-form routing description.",
		);
		expect(block).toContain("- general [label=General]: Normal conversation.");
		expect(block).not.toContain("reminders/habits/todos");
	});
});

describe("Stage 1 prompt — available contexts catalog", () => {
	it("includes USER-accessible contexts and excludes OWNER-only contexts for a USER sender", async () => {
		const runtime = makeRuntimeWithContexts(
			FIXTURE_CONTEXTS,
			stage1Response({
				contexts: [],
				thought: "Direct answer.",
				replyText: "Hello.",
			}),
		);

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as
			| { messages?: Array<{ role?: string; content?: string }> }
			| undefined;
		const systemContent = params?.messages?.[0]?.content ?? "";

		expect(systemContent).toContain("available_contexts:");
		const catalog = systemContent.match(
			/available_contexts:\n([\s\S]*?)\n\n/,
		)?.[1];
		expect(catalog).toBeDefined();
		// `general` (no gate) and `memory` (USER) are visible to USER role.
		expect(catalog).toContain("- general [label=General]:");
		expect(catalog).toContain("- memory [label=Memory]:");
		// `wallet` (OWNER-only) and `calendar` (ADMIN-only) must NOT appear.
		expect(catalog).not.toMatch(/^- wallet\b/m);
		expect(catalog).not.toMatch(/^- calendar\b/m);
	});

	it("falls back to the placeholder line when no context registry is attached", async () => {
		const responseHandlerFieldRegistry = createResponseHandlerFieldRegistry();
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000003" as UUID,
			character: { name: "Test Agent", system: "You are concise." },
			actions: [],
			providers: [],
			getRoom: vi.fn(async () => null),
			getSetting: vi.fn(() => undefined),
			reportError: vi.fn(),
			contexts: undefined,
			responseHandlerFieldRegistry,
			responseHandlerFieldEvaluators: [
				...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
			],
			composeState: vi.fn(async () => makeState()),
			runActionsByMode: vi.fn(async () => undefined),
			emitEvent: vi.fn(async () => undefined),
			useModel: vi.fn(async () =>
				stage1Response({
					contexts: [],
					thought: "Direct answer.",
					replyText: "Hello.",
				}),
			),
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
			},
		} as IAgentRuntime;

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as
			| { messages?: Array<{ role?: string; content?: string }> }
			| undefined;
		const systemContent = params?.messages?.[0]?.content ?? "";
		expect(systemContent).toContain("available_contexts:");
		expect(systemContent).toContain("(no contexts registered)");
	});
});
