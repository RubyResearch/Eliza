/**
 * Regression for #17299: an explicit VIEWS `show/home` request issued while
 * Notes is the foreground view must execute Home navigation. It must never be
 * rewritten into the foreground view's `get-notes` capability, which printed
 * the user's note contents as a verified, turn-completing tool result.
 */
import {
	AgentRuntime,
	type Memory,
	renderActionResultsForModel,
	type ViewScopedAction,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../../../../packages/core/src/runtime/planner-loop.js";
import { collectPreviousActionResults } from "../../../../packages/core/src/services/message/planned-tool.js";
import { createViewsAction } from "./views.js";
import {
	createViewsClient,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import { runViewsList } from "./views-list.js";
import { runViewsShow } from "./views-show.js";

const coreMock = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	ModelType: { TEXT_SMALL: "TEXT_SMALL" },
	resolveServerOnlyPort: vi.fn(() => 3456),
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
	spawnWithTrajectoryLink: vi.fn(
		async (
			_runtime: unknown,
			_source: unknown,
			run: (trajectory: {
				parentStepId: string;
				linkChild: (sessionId: string) => Promise<void>;
			}) => Promise<unknown>,
		) => run({ parentStepId: "p1", linkChild: vi.fn(async () => {}) }),
	),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...actual,
		...coreMock,
	};
});

function message(text: string, roomId = "room-1") {
	return { entityId: "user-1", roomId, agentId: "agent-1", content: { text } };
}

const SELECT_DAY: ViewScopedAction = {
	name: "VIEW_CALENDAR_SELECT_VISIBLE_DAY",
	description: "Select a visible calendar day while Calendar is active.",
	parameters: ["date"],
	steps: [{ kind: "agent-click", target: "calendar-day-{{date}}" }],
};

function scopedCalendar(patch: Partial<ViewSummary> = {}): ViewSummary {
	return {
		id: "calendar",
		label: "Calendar",
		path: "/calendar",
		viewType: "gui",
		pluginName: "@elizaos/plugin-calendar",
		available: true,
		capabilities: [
			{ id: "get-events", description: "Read calendar events." },
			{
				id: "create-event",
				description: "Create a calendar event.",
				params: {
					title: { type: "string", description: "Event title", required: true },
				},
			},
		],
		scopedActions: [SELECT_DAY],
		...patch,
	};
}

function scopedInteractionHarness(catalog: ViewSummary[] = [scopedCalendar()]) {
	const runtime = new AgentRuntime({ logLevel: "fatal" });
	const request: Memory = {
		agentId: runtime.agentId,
		entityId: "00000000-0000-0000-0000-000000000001",
		roomId: "00000000-0000-0000-0000-000000000003",
		content: { text: "Show September 7 and the calendar event." },
	};
	const callback = vi.fn();
	const fetchMock = vi.fn(
		async (
			_input: RequestInfo | URL,
			_init?: RequestInit,
		): Promise<Response> => {
			throw new Error("Unexpected view interaction dispatch");
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const action = createViewsAction({
		client: {
			listViews: vi.fn(async () => catalog),
			getCurrentView: vi.fn(async () => null),
		},
		hasOwnerAccess: vi.fn(async () => true),
	});
	const invoke = async (options: Record<string, unknown>) => {
		const result = await action.handler(
			runtime,
			request,
			undefined,
			options,
			callback,
		);
		if (!result) throw new Error("VIEWS returned no result");
		return result;
	};
	return { runtime, request, invoke, fetchMock, callback };
}

describe("VIEWS scoped-action namespace preflight", () => {
	it("never rewrites an unknown explicit UI capability into a record mutation", async () => {
		const h = scopedInteractionHarness();
		h.request.content.text =
			"Create a calendar event, then open Calendar to September 7.";
		const result = await h.invoke({
			action: "interact",
			view: "calendar",
			capability: "click-button",
			params: { title: "Must not be created" },
		});
		expect(result.success).toBe(false);
		expect(result.text).toContain('capability "click-button"');
		expect(result.text).toContain("No interaction was dispatched");
		expect(h.fetchMock).not.toHaveBeenCalled();
		expect(h.callback).not.toHaveBeenCalled();
	});

	it("returns full no-effect coaching before aliasing the Calendar action to create-event", async () => {
		const h = scopedInteractionHarness();
		const result = await h.invoke({
			action: "interact",
			view: "calendar",
			capability: SELECT_DAY.name,
			params: { date: "2026-09-07" },
		});
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: {
				coachingFailure: true,
				viewId: "calendar",
				scopedAction: SELECT_DAY,
			},
		});
		expect(result.text).toContain("not a VIEWS interact capability");
		expect(result.text).toContain("No interaction was dispatched");
		expect(result.text).toContain("params.id");
		expect(result.text).toContain("params.value");
		expect(result.text).not.toContain("create-event");
		expect(h.fetchMock).not.toHaveBeenCalled();
		expect(h.callback).not.toHaveBeenCalled();
		expect(result).not.toHaveProperty("effectReceipts");
		expect(result).not.toHaveProperty("verifiedUserFacing");
	});

	it.each(["agent-click", "select-day"])(
		"keeps real capability %s ahead of a colliding scoped name",
		async (capability) => {
			const h = scopedInteractionHarness([
				scopedCalendar({
					capabilities:
						capability === "agent-click"
							? []
							: [
									{
										id: capability,
										description: "Select the requested day",
										params: {
											id: { type: "string", description: "Day target" },
										},
									},
								],
					scopedActions: [{ ...SELECT_DAY, name: capability }],
				}),
			]);
			h.fetchMock.mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						result: { ok: true, id: "calendar-day-2026-09-07" },
					}),
					{ status: 200 },
				),
			);
			const result = await h.invoke({
				action: "interact",
				view: "calendar",
				capability,
				params: { id: "calendar-day-2026-09-07" },
			});
			expect(result.success).toBe(true);
			expect(result.data?.coachingFailure).not.toBe(true);
			expect(h.fetchMock).toHaveBeenCalledTimes(1);
			expect(
				JSON.parse(String(h.fetchMock.mock.calls[0]?.[1]?.body)).capability,
			).toBe(capability);
		},
	);

	it("does not coach an unknown name or a scoped action belonging to another view", async () => {
		const h = scopedInteractionHarness([
			scopedCalendar(),
			scopedCalendar({ id: "other", capabilities: [], scopedActions: [] }),
		]);
		for (const capability of ["UNKNOWN_CAPABILITY", SELECT_DAY.name]) {
			const result = await h.invoke({
				action: "interact",
				view: "other",
				capability,
				params: { date: "2026-09-07" },
			});
			expect(result.success).toBe(false);
			expect(result.data?.coachingFailure).not.toBe(true);
		}
		expect(h.fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a real failed interaction authoritative and non-coaching", async () => {
		const h = scopedInteractionHarness();
		h.fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ success: false, error: "element not mounted" }),
				{ status: 200 },
			),
		);
		const result = await h.invoke({
			action: "interact",
			view: "calendar",
			capability: "agent-click",
			params: { id: "calendar-day-2026-09-07" },
		});
		expect(result.success).toBe(false);
		expect(result.data?.coachingFailure).not.toBe(true);
		expect(h.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("lets the actual loop retain a model-authored reply after no-effect coaching and the exact successful day click", async () => {
		const h = scopedInteractionHarness();
		h.fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					result: { ok: true, id: "calendar-day-2026-09-07" },
				}),
				{ status: 200 },
			),
		);
		const plans = [
			{
				action: "interact",
				view: "calendar",
				capability: SELECT_DAY.name,
				params: { date: "2026-09-07" },
				eliza_turn_scope: "more_work_pending",
			},
			{
				action: "interact",
				view: "calendar",
				capability: "agent-click",
				params: { id: "calendar-day-2026-09-07" },
				eliza_turn_scope: "final",
			},
		];
		let planningCalls = 0;
		let evaluations = 0;
		const reply = "September 7 is selected in Calendar.";
		const result = await runPlannerLoop({
			runtime: {
				useModel: async (type, params) => {
					if (type === "ACTION_PLANNER" && params?.tools) {
						const plan = plans[planningCalls++];
						if (!plan) throw new Error("Unexpected extra planner call");
						return {
							text: "",
							toolCalls: [
								{
									id: `planned-${planningCalls}`,
									name: "VIEWS",
									arguments: plan,
								},
							],
						};
					}
					if (type === "RESPONSE_HANDLER" && ++evaluations <= 2) {
						return {
							text: JSON.stringify({
								thought: "Checked the recorded interaction outcome.",
								success: evaluations === 2,
								decision: evaluations === 2 ? "FINISH" : "CONTINUE",
								...(evaluations === 2 ? { messageToUser: reply } : {}),
							}),
							toolCalls: [],
						};
					}
					throw new Error("Unexpected extra model call");
				},
			},
			context: {
				id: "scoped-calendar-recovery",
				events: [
					{
						id: "request",
						type: "message",
						source: "user",
						createdAt: 1,
						content: h.request.content.text ?? "",
					},
				],
			},
			tools: [
				{
					name: "VIEWS",
					description: "Interact with views",
					parameters: { type: "object", properties: {} },
				},
			],
			config: { maxToolCalls: 3, maxRepeatedFailures: 2 },
			executeToolCall: async (call) => h.invoke(call.params ?? {}),
		});
		expect(result.finalMessage).toBe(reply);
		expect(planningCalls).toBe(2);
		expect(evaluations).toBe(2);
		expect(h.fetchMock).toHaveBeenCalledTimes(1);
		expect(
			result.trajectory.steps
				.filter((step) => step.result)
				.map((step) => step.result?.success),
		).toEqual([false, true]);
	});
});

function createRuntime() {
	return {
		runtime: {
			agentId: "agent-1",
			getSetting: vi.fn(() => undefined),
			getTasks: vi.fn(async () => []),
			createTask: vi.fn(async () => {}),
			deleteTask: vi.fn(async () => {}),
			useModel: vi.fn(async () => ""),
		},
	};
}

// Production-shape registry: the real plugin-notes Notes and plugin-calendar
// Calendar catalog entries (labels, tags, capability ids/descriptions) plus
// the builtin chat/home surface.
const notesView = (): ViewSummary =>
	({
		id: "notes",
		label: "Notes",
		available: true,
		pluginName: "test",
		viewType: "gui",
		path: "/notes",
		description:
			"Durable notes that the user and agent can create, read, update, and delete.",
		tags: ["notes", "notepad", "sticky notes", "scratchpad", "view switching"],
		capabilities: [
			{
				id: "get-notes",
				description: "List every sticky note as structured data.",
			},
			{ id: "get-note", description: "Read one sticky note by id." },
			{ id: "create-note", description: "Create a durable sticky note." },
			{
				id: "update-note",
				description: "Update one or more fields on a sticky note.",
			},
			{
				id: "delete-note",
				description:
					"Delete one sticky note by id, exact title, or unique query.",
			},
		],
	}) as unknown as ViewSummary;

const calendarView = (): ViewSummary =>
	({
		id: "calendar",
		label: "Calendar",
		available: true,
		pluginName: "test",
		viewType: "gui",
		path: "/calendar",
		description:
			"Unified Google, Microsoft, Apple, and ICS calendar with day/week/month tabs and inline conflict detection.",
		tags: ["calendar", "schedule", "events"],
		capabilities: [],
	}) as unknown as ViewSummary;

const chatView = (): ViewSummary =>
	({
		id: "chat",
		label: "Chat",
		available: true,
		pluginName: "test",
		viewType: "gui",
		path: "/",
		// Deliberately no "home" token anywhere: in the live repro the registry
		// could not resolve "home" by id/label/tag/description, which is what
		// forced the foreground-view fallback.
		description: "Main chat.",
		tags: ["chat"],
		capabilities: [],
	}) as unknown as ViewSummary;

function makeAction(views: ViewSummary[]) {
	const fetchMock = vi.fn(
		async () =>
			({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({
					success: true,
					result: {
						text: "Check Twitter: Check Twitter 1x a day.",
						success: true,
					},
				}),
			}) as unknown as Response,
	);
	vi.stubGlobal("fetch", fetchMock);
	const action = createViewsAction({
		client: {
			listViews: vi.fn(async () => views),
			getCurrentView: vi.fn(async () => ({
				viewId: "notes",
				viewLabel: "Notes",
				viewType: "gui" as const,
				viewPath: "/notes",
			})),
		},
		hasOwnerAccess: vi.fn(async () => true),
	});
	return { action, fetchMock };
}

// The composed retrieval prompt shape some runtimes hand the action instead of
// the raw user message. The contextual documents carry note-flavored text, so
// token-overlap capability scoring is maximally tempted toward Notes.
function composedPrompt(userRequest: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth.",
		"",
		"<contextual_documents>",
		'<source title="sticky notes" similarity="1.000">',
		"Check Twitter: Check Twitter 1x a day. Sticky note wall notes list.",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

async function runCase(
	text: string,
	options: Record<string, unknown>,
	views: ViewSummary[],
) {
	const { runtime } = createRuntime();
	const callback = vi.fn();
	const { action, fetchMock } = makeAction(views);
	const result = (await action.handler(
		runtime as never,
		message(text) as never,
		undefined,
		options,
		callback,
	)) as {
		success?: boolean;
		values?: Record<string, unknown>;
		text?: string;
		transcriptVisibility?: string;
		userFacingText?: string;
		verifiedUserFacing?: boolean;
		turnComplete?: boolean;
	};
	return { result, fetchMock, callback };
}

describe("VIEWS show/home with Notes foreground (#17299)", () => {
	it("carries the real registry parser's scoped selection contract into the navigation receipt", async () => {
		const params = {
			date: { type: "string", description: "fresh-schema-sentinel" },
		};
		const scopedActions = [
			{
				name: "VIEW_CALENDAR_SELECT_VISIBLE_DAY",
				description: "Select a visible calendar day while Calendar is active.",
				parameters: ["date"],
				steps: [{ kind: "agent-click", target: "calendar-day-{{date}}" }],
			},
		];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "http://127.0.0.1:3456/api/views") {
					return new Response(
						JSON.stringify({
							views: [
								{
									id: "calendar",
									label: "Calendar",
									path: "/calendar",
									viewType: "gui",
									pluginName: "@elizaos/plugin-calendar",
									available: true,
									capabilities: [
										{
											id: "get-events",
											description: "Read events; does not select a day.",
											params,
										},
									],
									scopedActions,
								},
							],
						}),
						{ status: 200 },
					);
				}
				expect(url).toBe("http://127.0.0.1:3456/api/views/calendar/navigate");
				expect(init?.method).toBe("POST");
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await runViewsShow({
			client: createViewsClient(),
			message: {
				entityId: "00000000-0000-0000-0000-000000000001",
				agentId: "00000000-0000-0000-0000-000000000002",
				roomId: "00000000-0000-0000-0000-000000000003",
				content: { text: "Open Calendar and show September 7." },
			},
			options: { action: "show", view: "calendar" },
		});

		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
			data: { view: { id: "calendar", scopedActions } },
		});
		// Discovery is not execution or selection proof: only navigation ran.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(result).not.toHaveProperty("userFacingText");
		expect(result).not.toHaveProperty("effectReceipts");
		expect(result.data).not.toHaveProperty("selectedDate");
		expect(result.data).toMatchObject({
			view: { capabilities: [{ id: "get-events", params }] },
		});
		expect(result.promptData).toMatchObject({
			view: {
				scopedActions,
				capabilities: [{ id: "get-events", paramsDeferred: true }],
			},
		});
		const navigationPrompt = renderActionResultsForModel([result]).text;
		expect(navigationPrompt).not.toContain("fresh-schema-sentinel");
		expect(navigationPrompt).toContain("VIEW_CALENDAR_SELECT_VISIBLE_DAY");
		expect(navigationPrompt).toContain("view_navigation");
		const backgroundResults = collectPreviousActionResults({
			context: { id: "navigation-background", events: [] },
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
			steps: [
				{
					iteration: 1,
					thought: "Open Calendar",
					toolCall: {
						id: "nav",
						name: "VIEWS",
						params: { action: "show", view: "calendar" },
					},
					result: actionResultToPlannerToolResult(result),
				},
			],
		});
		// Background task persistence round-trips the projection and original data.
		const persisted = JSON.parse(JSON.stringify(backgroundResults));
		expect(persisted[0].data.view.capabilities[0].params).toEqual(params);
		const backgroundPrompt = renderActionResultsForModel(persisted).text;
		expect(backgroundPrompt).not.toContain("fresh-schema-sentinel");
		expect(backgroundPrompt).toContain("VIEWS action=list");
		expect(backgroundPrompt).toContain("view_navigation");
		// The fresh discovery read still returns the complete callable contract.
		const catalog = await runViewsList({ client: createViewsClient() });
		expect(renderActionResultsForModel([catalog]).text).toContain(
			"fresh-schema-sentinel",
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not claim navigation to a registered but unavailable view", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const callback = vi.fn();
		const result = await runViewsShow({
			client: {
				listViews: vi.fn(async () => [{ ...notesView(), available: false }]),
			} as unknown as ViewsClient,
			message: message("Open Notes") as never,
			options: { view: "notes" },
			callback,
		});
		expect(result).toMatchObject({
			success: false,
			data: {
				navigation: {
					effect: "view_navigation",
					viewId: "notes",
					status: "unavailable",
				},
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	const fullRegistry = () => [chatView(), notesView(), calendarView()];
	const noHomeRegistry = () => [notesView(), calendarView()];

	it("resolves the canonical Home alias before a fuzzy Home Budget match", async () => {
		const homeBudget = {
			...chatView(),
			id: "home-budget",
			label: "Home Budget",
			path: "/home-budget",
		};
		const { result, fetchMock, callback } = await runCase(
			"Read my note, then go home.",
			{ action: "show", view: "Home" },
			[homeBudget, ...fullRegistry()],
		);
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			values: { viewId: "chat", viewPath: "/" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/views/chat/navigate",
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it.each(["id", "label"])(
		"preserves an exact registered %s before the canonical Home alias",
		async (field) => {
			const exactHome = {
				...chatView(),
				id: "custom-home",
				label: "Custom Home",
				path: "/custom-home",
				[field]: "Home",
			};
			const { result, fetchMock } = await runCase(
				"Open the supplied destination.",
				{ action: "show", view: "Home" },
				[exactHome, ...fullRegistry()],
			);
			expect(result).toMatchObject({
				success: true,
				values: { viewId: exactHome.id, viewPath: "/custom-home" },
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
				`/api/views/${exactHome.id}/navigate`,
			);
		},
	);

	it("does not replace an unavailable canonical Home with fuzzy Home Budget", async () => {
		const { result, fetchMock, callback } = await runCase(
			"Go home.",
			{ action: "show", view: "Home" },
			[
				{
					...chatView(),
					id: "home-budget",
					label: "Home Budget",
					path: "/home-budget",
				},
				...noHomeRegistry(),
			],
		);
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	const cases: Array<{
		name: string;
		text: string;
		options: Record<string, unknown>;
		views: () => ViewSummary[];
	}> = [
		// Bidirectional-proof cases: these misrouted to notes:get-notes on
		// develop before the fix (effectiveMode=interact,
		// resolvedCapability=notes:get-notes).
		{
			name: "'show home' with explicit show/home target",
			text: "show home",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		{
			name: "'show home' with explicit target and no registered home view",
			text: "show home",
			options: { action: "show", view: "home" },
			views: noHomeRegistry,
		},
		{
			name: "composed retrieval prompt around 'go home'",
			text: composedPrompt("go home"),
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		// Guardrail cases: correct before and after; pinned so the routing seam
		// cannot regress in the other direction.
		{
			name: "'go home' with explicit show/home target",
			text: "go home",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		{
			name: "typo 'go homw' normalized by the planner to show/home",
			text: "go homw",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
	];

	for (const testCase of cases) {
		it(`${testCase.name} never invokes a Notes capability`, async () => {
			const { result, fetchMock } = await runCase(
				testCase.text,
				testCase.options,
				testCase.views(),
			);
			const interactCalls = fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("/interact"),
			);
			expect(interactCalls).toEqual([]);
			expect(result?.values?.mode).not.toBe("interact");
			expect(String(result?.text ?? "")).not.toContain("Check Twitter");
		});
	}

	it("navigates to the registered chat view for show/home", async () => {
		const { result, fetchMock } = await runCase(
			"show home",
			{ action: "show", view: "home" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "chat" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("canonicalizes a planner-supplied home alias for bare go back", async () => {
		const { result, fetchMock, callback } = await runCase(
			"go back",
			{ action: "show", view: "home" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "chat" });
		expect(callback).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
		});
		expect(result.turnComplete).toBe(false);
		expect(result).not.toHaveProperty("userFacingText");
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "accepted",
			viewId: "chat",
			label: "Home",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	describe.each([false, true])(
		"compound request with nested options=%s",
		(nested) => {
			it.each(["view", "viewId", "id", "target", "name"])(
				"honors the explicit %s destination after a note read",
				async (targetKey) => {
					const parameters = { action: "show", [targetKey]: "chat" };
					const { result, fetchMock, callback } = await runCase(
						"Read my Continuity check 2145 note, then go home and tell me its text. Do not change the note.",
						nested ? { parameters } : parameters,
						fullRegistry(),
					);

					expect(result).toMatchObject({
						success: true,
						transcriptVisibility: "internal",
						modelReplyRequired: true,
						values: { mode: "show", viewId: "chat", viewPath: "/" },
					});
					expect(JSON.parse(result.text ?? "{}")).toMatchObject({
						effect: "view_navigation",
						status: "accepted",
						viewId: "chat",
						path: "/",
					});
					expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
						"http://127.0.0.1:3456/api/views/chat/navigate",
						expect.objectContaining({ method: "POST" }),
					);
					expect(callback).not.toHaveBeenCalled();
					expect(result).not.toHaveProperty("verifiedUserFacing");
				},
			);
		},
	);

	it("does not replace an unavailable explicit destination with the note-read surface", async () => {
		const { result, fetchMock, callback } = await runCase(
			"Read my note, then go to the requested view.",
			{ action: "show", view: "missing-destination" },
			fullRegistry(),
		);
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	it.each(["go home", "Read my note.", "open my calendar", "打开笔记"])(
		"requires a structured destination instead of inferring one from %s",
		async (text) => {
			const { result, fetchMock, callback } = await runCase(
				text,
				{ parameters: { action: "show" } },
				fullRegistry(),
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
			});
			expect(fetchMock).not.toHaveBeenCalled();
			expect(callback).not.toHaveBeenCalled();
		},
	);

	it("does not replace explicit Documents with a note mentioned elsewhere in the request", async () => {
		const { result, fetchMock } = await runCase(
			"Read my note, then open the requested destination.",
			{ action: "show", view: "documents" },
			[
				...fullRegistry(),
				{
					...notesView(),
					id: "documents",
					label: "Documents",
					path: "/documents",
				},
			],
		);
		expect(result.values).toMatchObject({ viewId: "documents" });
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			"http://127.0.0.1:3456/api/views/documents/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("reports one grounded failure when the shell rejects Home navigation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("shell unavailable", { status: 503 })),
		);
		const callback = vi.fn();
		const result = await runViewsShow({
			client: {
				listViews: vi.fn(async () => fullRegistry()),
			} as unknown as ViewsClient,
			message: message("go back") as never,
			options: { action: "show", view: "home" },
			callback,
		});

		expect(result.success).toBe(false);
		expect(JSON.parse(result.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "http-error",
			viewId: "chat",
			label: "Home",
		});
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(result.turnComplete).toBe(false);
		expect(callback).not.toHaveBeenCalled();
	});

	it("still reaches Notes through an explicit interact capability request", async () => {
		const { result } = await runCase(
			"show me my notes",
			{ action: "interact", view: "notes", capability: "get-notes" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "get-notes",
		});
	});
});
