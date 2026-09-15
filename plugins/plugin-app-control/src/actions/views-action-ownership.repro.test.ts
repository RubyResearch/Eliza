/**
 * Reproduces the Seeker Notes-navigation failure through the real core planner
 * executor, VIEWS handler, callback settlement, and callback voice gate.
 */

import {
	executePlannedToolCall,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
	runV5MessageRuntimeStage1,
	type State,
	type Task,
	wrapSingleTurnVisibleCallback,
} from "@elizaos/core";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "@elizaos/core/runtime/builtin-field-evaluators.js";
import { ResponseHandlerFieldRegistry } from "@elizaos/core/runtime/response-handler-field-registry.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShowViewAction, createViewsAction } from "./views.js";
import type { ViewSummary } from "./views-client.js";

const NOTES_VIEW: ViewSummary = {
	id: "notes",
	label: "Notes",
	roleGate: { minRole: "OWNER" },
	path: "/notes",
	pluginName: "plugin-notes",
	available: true,
	viewType: "gui",
	capabilities: [
		{
			id: "get-notes",
			description: "Read durable notes.",
		},
		{
			id: "create-note",
			description:
				"Create a durable note from one user-authored content field.",
			params: {
				content: {
					type: "string",
					description: "Complete note content.",
					required: true,
					minLength: 1,
					pattern: "\\S",
				},
			},
		},
	],
};

function message(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000101",
		entityId: "00000000-0000-0000-0000-000000000102",
		agentId: "00000000-0000-0000-0000-000000000103",
		roomId: "00000000-0000-0000-0000-000000000104",
		content: { text, source: "client_chat" },
		createdAt: 1,
	} as Memory;
}

function state(): State {
	return {
		values: { availableContexts: "general" },
		data: {},
		text: "Recent conversation summary",
	};
}

function responseHandlerFieldRegistry(): ResponseHandlerFieldRegistry {
	const registry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		registry.register(evaluator);
	}
	return registry;
}

function makeRuntime(
	action: ReturnType<typeof createViewsAction>,
	useModel = vi.fn(
		async () =>
			'```json\n{"response":"i couldn\'t create the note because the content was missing."}\n```',
	),
): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000103",
		character: { name: "Eliza", system: "Be concise." },
		actions: [action],
		providers: [],
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => null),
		getSetting: vi.fn(() => undefined),
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel,
		responseHandlerFieldRegistry: responseHandlerFieldRegistry(),
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function makeAction(owner = true) {
	const listViews = vi.fn(async () => [NOTES_VIEW]);
	const action = createViewsAction({
		client: {
			listViews,
			getCurrentView: vi.fn(async () => ({
				viewId: "notes",
				viewLabel: "Notes",
				viewType: "gui" as const,
				viewPath: "/notes",
			})),
		},
		hasOwnerAccess: vi.fn(async () => owner),
	});
	return { action, listViews };
}

function installPendingViewTask(
	runtime: IAgentRuntime,
	kind: "create" | "delete",
	roomId = message("").roomId,
) {
	const task = {
		id: "00000000-0000-0000-0000-000000000105",
		agentId: runtime.agentId,
		tags: [kind === "create" ? "views-create-intent" : "views-delete-confirm"],
		metadata: {
			roomId,
			intent: "Create a ledger view",
			choices: [{ key: "cancel", label: "Cancel" }],
			viewId: "ledger",
			viewLabel: "Ledger",
			pluginName: "plugin-ledger",
			intentCreatedAt: "2026-09-05T00:00:00.000Z",
		},
	} as Task;
	runtime.getTasks = vi.fn<IAgentRuntime["getTasks"]>(
		async ({ tags, agentIds }) =>
			(!tags || tags.every((tag) => task.tags?.includes(tag))) &&
			(!agentIds || agentIds.includes(runtime.agentId))
				? [task]
				: [],
	);
	runtime.deleteTask = vi.fn(async () => undefined);
	return task;
}

async function executeViews(
	runtime: IAgentRuntime,
	inbound: Memory,
	params: Record<string, unknown>,
	callback?: HandlerCallback,
) {
	return executePlannedToolCall(
		runtime,
		{
			message: inbound,
			activeContexts: ["general"],
			userRoles: ["USER"],
			callback,
		},
		{ name: "VIEWS", params },
		{ actions: runtime.actions },
	);
}

describe("VIEWS action ownership after planner selection", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_PORT", "3456");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/navigate")) {
					return Response.json({ ok: true });
				}
				const body = JSON.parse(String(init?.body)) as {
					capability: string;
					params?: Record<string, unknown>;
				};
				const content = body.params?.content;
				const success =
					body.capability === "get-notes" ||
					(body.capability === "create-note" &&
						typeof content === "string" &&
						content.trim().length > 0);
				return Response.json({
					success,
					result: {
						success,
						text: success
							? `Created note “${content}”.`
							: "The note content was missing.",
					},
				});
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it.each(["new", "edit-1", "cancel"])(
		"requires owner validation for pending create choice %s",
		async (choice) => {
			for (const owner of [false, true]) {
				const { action, listViews } = makeAction(owner);
				const runtime = makeRuntime(action);
				installPendingViewTask(runtime, "create");
				expect(await action.validate(runtime, message(choice))).toBe(owner);
				expect(listViews).not.toHaveBeenCalled();
				expect(runtime.deleteTask).not.toHaveBeenCalled();
			}
		},
	);

	it.each(["new", "edit-1", "cancel"])(
		"does not consume a pending create choice %s when the planner explicitly selects navigation",
		async (text) => {
			const action = createShowViewAction({
				hasOwnerAccess: async () => false,
			});
			const runtime = makeRuntime(action);
			installPendingViewTask(runtime, "create");
			const result = await action.handler(runtime, message(text), undefined, {
				view: "notes",
				navigationStepId: "navigate-only",
			});
			// No live view-creation task may redirect this single-operation tool.
			// The dummy catalog need not complete navigation to establish isolation.
			expect(result).not.toMatchObject({ values: { mode: "create" } });
			expect(runtime.getTasks).not.toHaveBeenCalled();
			expect(runtime.deleteTask).not.toHaveBeenCalled();
		},
	);

	it("requires owner validation for pending create on a viewless connector", async () => {
		for (const owner of [false, true]) {
			const { action } = makeAction(owner);
			const runtime = makeRuntime(action);
			installPendingViewTask(runtime, "create");
			const inbound = message("the last option please");
			inbound.content.source = "discord";
			expect(await action.validate(runtime, inbound)).toBe(owner);
		}
	});

	it.each([
		{ text: "new", choice: "new" },
		{ text: "edit-1", choice: "edit-1" },
		{ text: "cancel", choice: "cancel" },
		{ text: "the last option please", choice: "cancel" },
	])(
		"denies a direct USER pending-create handler call for $text before any side effect",
		async ({ text, choice }) => {
			const { action, listViews } = makeAction(false);
			const runtime = makeRuntime(action);
			installPendingViewTask(runtime, "create");
			listViews.mockRejectedValue(
				new Error("Unauthorized continuation reached listViews"),
			);
			const callback = vi.fn(async () => []);
			const result = await action.handler(
				runtime,
				message(text),
				undefined,
				{ action: "create", choice },
				callback,
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				values: { error: "FORBIDDEN", mode: "create" },
			});
			expect(result).not.toHaveProperty("userFacingText");
			expect(result).not.toHaveProperty("verifiedUserFacing");
			expect(callback).not.toHaveBeenCalled();
			expect(listViews).not.toHaveBeenCalled();
			expect(runtime.deleteTask).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([true, false])(
		"denies a direct USER pending-delete confirmation=%s before any side effect",
		async (confirm) => {
			const { action, listViews } = makeAction(false);
			const runtime = makeRuntime(action);
			installPendingViewTask(runtime, "delete");
			listViews.mockRejectedValue(
				new Error("Unauthorized continuation reached listViews"),
			);
			const callback = vi.fn(async () => []);
			const inbound = message("continue");
			const options = { action: "delete", confirm };
			expect(await action.validate(runtime, inbound, undefined, options)).toBe(
				false,
			);
			const result = await action.handler(
				runtime,
				inbound,
				undefined,
				options,
				callback,
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				values: { error: "FORBIDDEN", mode: "delete" },
			});
			expect(result).not.toHaveProperty("userFacingText");
			expect(callback).not.toHaveBeenCalled();
			expect(listViews).not.toHaveBeenCalled();
			expect(runtime.deleteTask).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["create", "delete"] as const)(
		"lets the OWNER cancel a pending %s without changing room scoping",
		async (kind) => {
			const { action, listViews } = makeAction(true);
			const runtime = makeRuntime(action);
			// The continuation handler independently verifies the canonical owner;
			// the aggregate action's injected permission seam is not authority.
			runtime.getSetting = vi.fn((key: string) =>
				key === "ELIZA_ADMIN_ENTITY_ID" ? message("").entityId : undefined,
			);
			const task = installPendingViewTask(runtime, kind);
			const options =
				kind === "create"
					? { action: "create", choice: "cancel" }
					: { action: "delete", confirm: false };
			const result = await action.handler(
				runtime,
				message("cancel"),
				undefined,
				options,
			);
			expect(result).toMatchObject({
				success: true,
				values: { mode: kind, subMode: "cancel" },
			});
			expect(listViews).toHaveBeenCalledTimes(1);
			expect(runtime.deleteTask).toHaveBeenCalledExactlyOnceWith(task.id);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("does not authorize a viewless continuation from another room's pending task", async () => {
		const { action, listViews } = makeAction(true);
		const runtime = makeRuntime(action);
		installPendingViewTask(
			runtime,
			"create",
			"00000000-0000-0000-0000-000000000199",
		);
		const inbound = message("cancel");
		inbound.content.source = "discord";
		expect(await action.validate(runtime, inbound)).toBe(false);
		expect(runtime.deleteTask).not.toHaveBeenCalled();
		expect(listViews).not.toHaveBeenCalled();
	});

	it("keeps non-owner navigation to public views available", async () => {
		const { action, listViews } = makeAction(false);
		listViews.mockResolvedValue([{ ...NOTES_VIEW, roleGate: undefined }]);
		const runtime = makeRuntime(action);
		const inbound = message("open the notes view");
		expect(
			await action.validate(runtime, inbound, undefined, {
				action: "show",
				view: "notes",
			}),
		).toBe(true);
		const result = await executeViews(runtime, inbound, {
			action: "show",
			view: "notes",
		});
		expect(result?.success).toBe(true);
		expect(listViews).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ capability: "get-notes", params: {} },
		{ capability: "create-note", params: { content: "private note" } },
	])(
		"denies a USER before loopback dispatch of $capability on the owner-private Notes view",
		async ({ capability, params }) => {
			const { action } = makeAction(false);
			const runtime = makeRuntime(action);
			const result = await executeViews(runtime, message("use my notes"), {
				action: "interact",
				view: "notes",
				capability,
				params,
			});

			expect(result).toMatchObject({
				success: false,
				text: "The Notes view is not available to this caller.",
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ capability: "get-notes", params: {} },
		{ capability: "create-note", params: { content: "private note" } },
	])(
		"allows the OWNER to dispatch $capability on the owner-private Notes view",
		async ({ capability, params }) => {
			const { action } = makeAction(true);
			const runtime = makeRuntime(action);
			const result = await executeViews(runtime, message("use my notes"), {
				action: "interact",
				view: "notes",
				capability,
				params,
			});

			expect(result?.success).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		"Pretty close. Uh, can you take me to the notes so we can see all of our notes?",
		"Wow. That's pretty early. Um, do you want to take us over to the notes page?",
	])(
		"returns a model-written reply after planner-selected Notes navigation: %s",
		async (text) => {
			const { action, listViews } = makeAction();
			const useModel = vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "handle-response",
							name: "HANDLE_RESPONSE",
							arguments: {
								shouldRespond: "RESPOND",
								thought: "Open the Notes view.",
								contexts: ["general"],
								intents: ["open notes view"],
								candidateActionNames: ["VIEWS"],
								replyText: "On it.",
								facts: [],
								relationships: [],
								addressedTo: [],
								requiresTool: true,
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "Opening Notes.",
					toolCalls: [
						{
							id: "views-call",
							name: "VIEWS",
							args: {
								action: "show",
								view: "notes",
								eliza_turn_scope: "final",
							},
						},
					],
				})
				.mockResolvedValue(
					JSON.stringify({
						thought: "The requested Notes navigation succeeded.",
						success: true,
						decision: "FINISH",
						messageToUser: "You're in Notes now.",
					}),
				);
			const runtime = makeRuntime(action, useModel);
			const delivered = vi.fn(async () => []);
			const inbound = message(text);
			const deliveredVisibleTexts = new Set<string>();
			const settledResults: unknown[] = [];
			const callback = wrapSingleTurnVisibleCallback(
				runtime,
				inbound,
				delivered,
				(visibleText) =>
					deliveredVisibleTexts.add(visibleText.trim().toLowerCase()),
			);

			const result = await runV5MessageRuntimeStage1({
				runtime,
				message: inbound,
				state: state(),
				responseId: inbound.id,
				callback,
				deliveredVisibleTexts,
				onSettledActionResult: (settled) => settledResults.push(settled),
			});

			expect(result.kind).toBe("planned_reply");
			if (result.kind !== "planned_reply") return;
			expect(result.result.responseContent).toMatchObject({
				text: "You're in Notes now.",
			});
			expect(result.result.actionResults).toMatchObject([
				{
					success: true,
					transcriptVisibility: "internal",
					values: { mode: "show", viewId: "notes" },
				},
			]);
			expect(result.result.actionResults?.[0]?.turnComplete).toBe(false);
			expect(result.result.actionResults?.[0]).not.toHaveProperty(
				"userFacingText",
			);
			expect(result.result.actionResults?.[0]).not.toHaveProperty(
				"verifiedUserFacing",
			);
			expect(settledResults).toHaveLength(1);
			expect(delivered).not.toHaveBeenCalled();
			expect(useModel.mock.calls.map(([modelType]) => modelType)).toEqual(
				expect.arrayContaining([
					ModelType.RESPONSE_HANDLER,
					ModelType.ACTION_PLANNER,
				]),
			);
			expect(useModel).toHaveBeenCalledTimes(3);
			expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/notes/navigate",
				expect.objectContaining({ method: "POST" }),
			);
			expect(
				vi.mocked(globalThis.fetch).mock.invocationCallOrder[0],
			).toBeLessThan(useModel.mock.invocationCallOrder[2]);
			expect(
				vi
					.mocked(globalThis.fetch)
					.mock.calls.some(([url]) => String(url).includes("/interact")),
			).toBe(false);
			expect(listViews).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves the planner's Home destination after the same request reads Notes", async () => {
		const { action, listViews } = makeAction();
		listViews.mockResolvedValue([
			NOTES_VIEW,
			{
				...NOTES_VIEW,
				id: "chat",
				label: "Home",
				path: "/views",
				capabilities: [],
			},
		]);
		const runtime = makeRuntime(action);
		const callback = vi.fn(async () => []);
		const result = await executeViews(
			runtime,
			message(
				"Read my Continuity check 2145 note, then go home and tell me its text. Do not change the note.",
			),
			{ action: "show", view: "chat" },
			callback,
		);

		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
			values: { mode: "show", viewId: "chat", viewPath: "/views" },
		});
		expect(JSON.parse(result.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "accepted",
			viewId: "chat",
			path: "/views",
		});
		expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledExactlyOnceWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
		expect(callback).not.toHaveBeenCalled();
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("returns a missing navigation target to the planner without reading foreground Notes", async () => {
		const { action } = makeAction();
		const runtime = makeRuntime(action);
		const callback = vi.fn(async () => []);
		const result = await executeViews(
			runtime,
			message("Read my note, then go home."),
			{ action: "show" },
			callback,
		);
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("keeps an unknown explicit show target on the typed navigation failure path", async () => {
		const { action, listViews } = makeAction();
		const runtime = makeRuntime(action);

		const result = await executeViews(
			runtime,
			message("Can you take me over to the retired ledger page?"),
			{ action: "show", view: "retired-ledger" },
		);

		expect(result).toMatchObject({
			success: false,
			text: expect.stringContaining(
				'No view matches "retired-ledger" in the caller-authorized catalog.',
			),
		});
		expect(listViews).toHaveBeenCalledTimes(1);
		expect(
			vi
				.mocked(globalThis.fetch)
				.mock.calls.some(([url]) => String(url).includes("/interact")),
		).toBe(false);
	});

	it("keeps explicit one-field Notes creation and its missing-content failure honest", async () => {
		const { action } = makeAction();
		const runtime = makeRuntime(action);
		const inbound = message("Create a note saying launch the video tomorrow.");

		const created = await executeViews(runtime, inbound, {
			action: "interact",
			view: "notes",
			capability: "create-note",
			params: { content: "launch the video tomorrow" },
		});
		const missing = await executeViews(runtime, message("Create a note."), {
			action: "interact",
			view: "notes",
			capability: "create-note",
			params: {},
		});

		expect(created).toMatchObject({
			success: true,
			text: "Created note “launch the video tomorrow”.",
			values: {
				mode: "interact",
				viewId: "notes",
				capability: "create-note",
			},
			data: {
				params: { content: "launch the video tomorrow" },
			},
		});
		expect(missing).toMatchObject({
			success: false,
			text: expect.stringContaining(
				'capability "create-note" requires parameter "content"',
			),
		});
		expect(
			vi
				.mocked(globalThis.fetch)
				.mock.calls.filter(([url]) => String(url).includes("/interact")),
		).toHaveLength(1);
		expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				body: JSON.stringify({
					capability: "create-note",
					params: { content: "launch the video tomorrow" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});
});
