/**
 * Exercises complete planner tool dispatch when the declared context estimate
 * is smaller than the request and Stage 1 suggests unregistered action names.
 * Authorized children must remain callable instead of being hidden by a budget.
 * Deterministic harness: a fabricated runtime whose useModel returns queued
 * responses and whose ACTION_PLANNER registration advertises a one-token
 * window; no live model, no database.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with calendars.",
		},
		actions: [],
		providers: [],
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		// An estimate is diagnostic, not permission to discard authorized tools.
		getModelRegistrations: vi.fn(() => [
			{
				modelType: ModelType.ACTION_PLANNER,
				metadata: { contextWindowTokens: 1 },
			},
		]),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		responseHandlerEvaluators: [],
	} as IAgentRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: AGENT_ID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text,
			source: "test",
			mentionContext: { isMention: true },
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, calendar, notes" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1Response(candidateActionNames: string[]) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "The owner wants a calendar event removed.",
					contexts: ["calendar"],
					intents: ["delete calendar event"],
					candidateActionNames,
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
	};
}

function parameter(name: string, description: string) {
	return {
		name,
		description,
		required: false,
		schema: { type: "string" },
	};
}

describe("complete planner dispatch above the estimated window", () => {
	it("executes an admitted child despite unknown candidates and a smaller declared window", async () => {
		const runtime = makeRuntime([
			// Live shape: Stage 1 invents child names that no plugin registers.
			stage1Response(["CALENDAR_DELETE_EVENT", "CALENDAR_FIND_EVENT"]),
			{
				text: "",
				toolCalls: [
					{
						id: "discover-calendar",
						name: "DISCOVER_TOOLS",
						args: {
							names: ["CALENDAR_DELETE"],
							eliza_turn_scope: "more_work_pending",
						},
					},
				],
			},
			{
				thought: "Remove the event through the calendar deletion tool.",
				toolCalls: [
					{
						id: "calendar-1",
						name: "CALENDAR_DELETE",
						args: { title: "Gym session", eliza_turn_scope: "final" },
					},
				],
			},
		]);
		const calendarHandler = vi.fn(async () => ({
			success: true,
			text: "Gym session removed.",
			continueChain: false,
			data: { actionName: "CALENDAR" },
		}));
		const untouchedHandler = vi.fn(async () => ({
			success: true,
			text: "unexpected",
		}));
		runtime.actions = [
			{
				name: "CALENDAR",
				description: "Calendar operations: read, create, update, delete.",
				parameters: [
					parameter("action", "Calendar operation"),
					parameter("title", "Event title"),
				],
				subActions: ["CALENDAR_DELETE"],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
			{
				name: "CALENDAR_DELETE",
				description: "Delete one calendar event by title and time.",
				parameters: [parameter("title", "Event title")],
				examples: [],
				validate: async () => true,
				handler: calendarHandler,
			},
			{
				name: "NOTES",
				description: "Notes operations: create, read, update.",
				parameters: [parameter("action", "Notes operation")],
				subActions: ["NOTES_CREATE"],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
			{
				name: "NOTES_CREATE",
				description: "Create a note with a title and body.",
				parameters: [parameter("title", "Note title")],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
		] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(
				"delete the Gym session on tuesday at 7am from my calendar",
			),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(calendarHandler).toHaveBeenCalledTimes(1);
		expect(untouchedHandler).not.toHaveBeenCalled();
		expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.ACTION_PLANNER,
		]);

		const discoveryParams = useModelCalls(runtime)[1]?.[1] as {
			tools: { name: string }[];
		};
		expect(discoveryParams.tools.map(({ name }) => name)).toContain(
			"DISCOVER_TOOLS",
		);
		expect(discoveryParams.tools.map(({ name }) => name)).not.toContain(
			"CALENDAR_DELETE",
		);
		const plannerParams = useModelCalls(runtime)[2]?.[1] as {
			tools?: { name: string }[];
		};
		const plannerToolNames = plannerParams.tools?.map(({ name }) => name) ?? [];
		expect(plannerToolNames).toContain("CALENDAR_DELETE");
		// The legacy estimate fallback may include the requested child's parent,
		// but must not refill unrelated families.
		for (const unrelated of ["NOTES", "NOTES_CREATE"])
			expect(plannerToolNames).not.toContain(unrelated);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe("Gym session removed.");
		}
	});
});
