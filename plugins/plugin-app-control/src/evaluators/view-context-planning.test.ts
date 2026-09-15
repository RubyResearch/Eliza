/**
 * Exercises contextual routing through the real response-handler patch runner
 * and TCP catalog boundary. Model decisions are deterministic inputs; these
 * tests do not claim live-model or mounted-renderer acceptance.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ResponseHandlerEvaluatorContext,
	ResponseHandlerFieldRegistry,
	runResponseHandlerEvaluators,
	runWithStreamingContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canActionRun } from "../../../../packages/core/src/runtime/action-gate.js";
import { navigationDispatchBlock } from "../actions/navigation-execution.js";
import { createShowViewAction } from "../actions/views.js";
import {
	createViewsClient,
	type ViewSummary,
} from "../actions/views-client.js";
import { runViewsList } from "../actions/views-list.js";
import {
	parseContextualNavigationIntent,
	viewContextPlanningEvaluator,
	viewContinuationField,
} from "./view-context-planning.js";

let server: Server;
let catalogStatus: number;
let requestedPaths: string[];
let originalPort: string | undefined;
let prompts: string[];
let extraViews: ViewSummary[];
const views = [
	{
		id: "observatory",
		label: "Observatory",
		description: "Plan telescope observations",
		pluginName: "astronomy",
		available: true,
	},
	{
		id: "admin",
		label: "Restricted account details",
		pluginName: "admin",
		available: true,
		roleGate: { minRole: "OWNER" },
	},
	{ id: "offline", label: "Offline", pluginName: "offline", available: false },
];

beforeEach(async () => {
	catalogStatus = 200;
	requestedPaths = [];
	prompts = [];
	extraViews = [];
	originalPort = process.env.ELIZA_API_PORT;
	server = createServer((req, res) => {
		requestedPaths.push(req.url ?? "");
		res.writeHead(catalogStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ views: [...views, ...extraViews] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ELIZA_API_PORT = String((server.address() as AddressInfo).port);
});
afterEach(async () => {
	if (originalPort === undefined) delete process.env.ELIZA_API_PORT;
	else process.env.ELIZA_API_PORT = originalPort;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

function context(
	text: string,
	decision: object,
	onModel?: () => void,
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			actions: [{ name: "VIEWS" }],
			reportError: () => undefined,
			useModel: async (_type: string, request: { prompt: string }) => {
				onModel?.();
				prompts.push(request.prompt);
				return JSON.stringify(decision);
			},
			logger: { error() {}, warn() {} },
		},
		message: {
			id: "turn-1",
			roomId: "room-1",
			entityId: "actor-1",
			content: { text },
		},
		state: { values: {}, data: {}, text: "" },
		messageHandler: {
			processMessage: "RESPOND",
			plan: {
				contexts: ["general"],
				candidateActions: ["CALENDAR"],
				parentActionHints: ["CALENDAR"],
				reply: "premature response",
			},
		},
		availableContexts: [],
		userRoles: ["USER"],
	} as unknown as ResponseHandlerEvaluatorContext;
}
async function run(ctx: ResponseHandlerEvaluatorContext) {
	return runWithStreamingContext({ messageId: ctx.message.id }, async () => {
		const result = await runResponseHandlerEvaluators({
			...ctx,
			evaluators: [viewContextPlanningEvaluator],
		});
		return {
			...result,
			navigationBlock: navigationDispatchBlock(ctx.message, true),
		};
	});
}

describe("same-turn contextual navigation", () => {
	async function runWithField(
		ctx: ResponseHandlerEvaluatorContext,
		value: unknown,
		change?: () => void,
	) {
		return runWithStreamingContext({ messageId: ctx.message.id }, async () => {
			const registry = new ResponseHandlerFieldRegistry();
			registry.register(viewContinuationField);
			await registry.dispatch({
				rawParsed: { visualContinuation: value },
				runtime: ctx.runtime,
				message: ctx.message,
				state: ctx.state,
				senderRole: "USER",
				turnSignal: new AbortController().signal,
			});
			change?.();
			const result = await runResponseHandlerEvaluators({
				...ctx,
				evaluators: [viewContextPlanningEvaluator],
			});
			return {
				...result,
				navigationBlock: navigationDispatchBlock(ctx.message, true),
			};
		});
	}
	it.each([true, false])(
		"routes a selected navigation from system context without bypassing available contexts: general=%s",
		async (generalAvailable) => {
			const ctx = context("Return to Observatory", {});
			const action = createShowViewAction();
			ctx.runtime.actions.push(action);
			ctx.availableContexts = [
				{ id: "system", description: "System operations" },
				...(generalAvailable
					? [{ id: "general", description: "General app operations" }]
					: []),
			] as typeof ctx.availableContexts;
			Object.assign(ctx.message.content, {
				source: "client_chat",
				channelType: "DM",
			});
			Object.assign(ctx.messageHandler.plan, {
				contexts: ["system"],
				candidateActions: ["VIEWS_SHOW"],
				parentActionHints: [],
				intents: ["open Observatory"],
			});
			await runWithField(ctx, {
				disposition: "requested",
				viewId: "observatory",
				reason: "Return to one view",
				singleViewOnly: true,
				navigationOnly: true,
			});
			const gate = {
				activeContexts: ctx.messageHandler.plan.contexts ?? [],
				userRoles: ctx.userRoles,
				message: ctx.message,
			};
			expect(canActionRun(action, gate)).toBe(generalAvailable);
			expect(canActionRun({ ...action, private: true }, gate)).toBe(false);
			expect(
				canActionRun({ ...action, roleGate: { minRole: "OWNER" } }, gate),
			).toBe(false);
		},
	);
	it.each([
		{ navigationOnly: true, expected: true },
		{ navigationOnly: false, expected: false },
		{ navigationOnly: undefined, expected: false },
	])(
		"reuses a fully specified navigation-only model decision: %j",
		async ({ navigationOnly, expected }) => {
			const ctx = context("Open Observatory", {});
			ctx.runtime.actions.push({
				name: "VIEWS_SHOW",
			} as (typeof ctx.runtime.actions)[number]);
			Object.assign(ctx.message.content, {
				source: "client_chat",
				channelType: "DM",
			});
			Object.assign(ctx.messageHandler.plan, {
				candidateActions: ["VIEWS_SHOW"],
				parentActionHints: [],
				intents: ["open Observatory"],
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "observatory",
				reason: "Open one view",
				singleViewOnly: true,
				...(navigationOnly === undefined ? {} : { navigationOnly }),
			});
			expect(result.errors).toEqual([]);
			expect(ctx.messageHandler.plan.deterministicToolCall).toEqual(
				expected
					? {
							name: "VIEWS_SHOW",
							params: {
								view: "observatory",
								navigationStepId: "stage1:turn-1",
							},
						}
					: undefined,
			);
			expect(prompts).toEqual([]);
			expect(
				ctx.messageHandler.plan.contextSlices?.some((slice) =>
					slice.startsWith("Authorized destination index: "),
				),
			).toBe(!expected);
		},
	);
	it("gives a compound planner the fresh authorized destination index without dispatching a proposed target", async () => {
		extraViews = [
			{
				id: "calendar",
				label: "Calendar",
				path: "/calendar",
				pluginName: "calendar",
				available: true,
			},
			{
				id: "dev",
				label: "Private debugger",
				path: "/dev",
				pluginName: "dev",
				available: true,
				developerOnly: true,
			},
		];
		const text =
			"Read the live count, then open Calendar only if it is three; otherwise stay here. Do not change records.";
		const ctx = context(text, {});
		ctx.runtime.actions.push({
			name: "VIEWS_SHOW",
		} as (typeof ctx.runtime.actions)[number]);
		Object.assign(ctx.message.content, {
			source: "client_chat",
			channelType: "DM",
		});
		Object.assign(ctx.messageHandler.plan, {
			candidateActions: ["CALENDAR", "VIEWS_SHOW"],
			intents: ["read live count", "conditionally open Calendar"],
		});
		const result = await runWithField(ctx, {
			disposition: "requested",
			viewId: "observatory",
			reason: "Conditional navigation after the read",
			singleViewOnly: false,
			navigationOnly: false,
		});
		expect(result.errors).toEqual([]);
		expect(prompts).toEqual([]);
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(ctx.message.content.text).toBe(text);
		expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS_SHOW",
		]);
		const slices = ctx.messageHandler.plan.contextSlices ?? [];
		const index = slices.find((slice) =>
			slice.startsWith("Authorized destination index: "),
		);
		if (!index) throw new Error("Missing authorized destination index");
		expect(
			JSON.parse(index.slice("Authorized destination index: ".length)),
		).toEqual([
			{ id: "observatory", label: "Observatory" },
			{ id: "calendar", label: "Calendar", path: "/calendar" },
		]);
		expect(slices.join("\n")).not.toContain("Private debugger");
		expect(slices.join("\n")).not.toContain("Restricted account details");
	});
	it.each([
		"domain",
		"question",
		"voice",
		"optional",
		"multiple",
		"stale",
		"metadata",
	])("keeps %s work on the ordinary planner path", async (variant) => {
		const ctx = context("Open Observatory", {
			disposition: "none",
			reason: "do not use stale input",
		});
		ctx.runtime.actions.push({
			name: "VIEWS_SHOW",
		} as (typeof ctx.runtime.actions)[number]);
		Object.assign(ctx.message.content, {
			source: "client_chat",
			channelType: variant === "voice" ? "VOICE_DM" : "DM",
		});
		Object.assign(ctx.messageHandler.plan, {
			candidateActions:
				variant === "domain" ? ["VIEWS_SHOW", "CALENDAR"] : ["VIEWS_SHOW"],
			parentActionHints: [],
			intents:
				variant === "question"
					? ["open Observatory", "recall the original color"]
					: ["open Observatory"],
		});
		const judgment = {
			disposition: variant === "optional" ? "optional" : "requested",
			viewId: "observatory",
			reason: "Model judgment",
			singleViewOnly: variant !== "multiple",
			navigationOnly: true,
		};
		if (variant === "metadata") {
			ctx.message.content.metadata = { visualContinuation: judgment };
			await run(ctx);
		} else {
			await runWithField(
				ctx,
				judgment,
				variant === "stale"
					? () => {
							ctx.message.content.text = "Never mind";
						}
					: undefined,
			);
		}
		expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
	});
	it.each([
		{ disposition: "none", viewId: "" },
		{ disposition: "none", viewId: "notes" },
		{ disposition: "forbidden", viewId: "" },
		{ disposition: "forbidden", viewId: "calendar" },
	])(
		"reuses the Stage-1 $disposition decision with viewId=$viewId without another model or catalog request",
		async ({ disposition, viewId }) => {
			const ctx = context(
				"Keep the current screen and answer our hypothetical",
				{
					disposition: "requested",
					viewId: "observatory",
					reason: "must not run",
				},
			);
			const result = await runWithField(ctx, {
				disposition,
				viewId,
				reason: "no navigation",
			});
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts).toHaveLength(0);
			expect(requestedPaths).toEqual([]);
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		},
	);
	it.each(["none", "forbidden"])(
		"preserves catalog-only candidates after a %s judgment so text inference cannot re-add navigation",
		async (disposition) => {
			const ctx = context(
				"Discover NOTES. Do not create, edit, delete or navigate.",
				{},
			);
			ctx.messageHandler.plan.candidateActions = ["DISCOVER_TOOLS"];
			const result = await runWithField(ctx, {
				disposition,
				viewId: "",
				reason: "No navigation requested",
			});
			expect(result.errors).toEqual([]);
			expect(result.candidateActionsClearedByEvaluators).toBe(true);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"DISCOVER_TOOLS",
			]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts).toEqual([]);
		},
	);
	it.each(["current", "stale", "optional", "voice", "no-candidate"])(
		"delegates a destination-free requested decision only with current text-turn evidence: %s",
		async (variant) => {
			// Captured Stage-1 decision from the live conditional Notes/Calendar run.
			const decision = {
				disposition: variant === "optional" ? "optional" : "requested",
				viewId: "",
				singleViewOnly: false,
				navigationOnly: false,
				reason:
					"Navigation destination is conditional on reading the note body and may be Calendar; current view is Notes.",
			};
			const ctx = context(
				'Read the current exact body of "Seeker QA 1914" first. After you have the read result, if it contains "green", open Calendar; otherwise stay on Notes. Tell me the exact body. Do not change any records or turn on voice.',
				{ disposition: "none", reason: "Fallback retained" },
			);
			ctx.runtime.actions.push({
				name: "VIEWS_SHOW",
			} as (typeof ctx.runtime.actions)[number]);
			Object.assign(ctx.message.content, {
				source: "client_chat",
				channelType: variant === "voice" ? "VOICE_DM" : "DM",
			});
			ctx.messageHandler.plan.candidateActions =
				variant === "no-candidate"
					? ["NOTES_LIST"]
					: ["NOTES_LIST", "VIEWS_SHOW"];
			ctx.messageHandler.plan.intents = [
				"read note Seeker QA 1914",
				"open Calendar if body contains green",
			];
			extraViews = [
				{
					id: "calendar",
					label: "Calendar",
					pluginName: "calendar",
					available: true,
					path: "/calendar",
				},
				{
					id: "dev",
					label: "Developer",
					pluginName: "developer",
					available: true,
					developerOnly: true,
				},
			];
			const result = await runWithField(
				ctx,
				decision,
				variant === "stale"
					? () => {
							ctx.message.content.text = "Never mind. Stay here.";
						}
					: undefined,
			);
			expect(result.errors).toEqual([]);
			expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
			expect(ctx.messageHandler.plan.intents).toEqual([
				"read note Seeker QA 1914",
				"open Calendar if body contains green",
			]);
			if (variant !== "current") {
				expect(prompts).toHaveLength(1);
				expect(result.navigationBlock).toBe("forbidden");
				return;
			}
			expect(prompts).toEqual([]);
			expect(requestedPaths).toEqual(["/api/views"]);
			expect(result.navigationBlock).toBeUndefined();
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"NOTES_LIST",
				"VIEWS_SHOW",
			]);
			const slices = ctx.messageHandler.plan.contextSlices ?? [];
			const index = slices.find((slice) =>
				slice.startsWith("Authorized destination index: "),
			);
			expect(index).toBeDefined();
			if (!index) throw new Error("Missing authorized destination index");
			expect(
				JSON.parse(index.slice("Authorized destination index: ".length)),
			).toEqual([
				{ id: "observatory", label: "Observatory" },
				{ id: "calendar", label: "Calendar", path: "/calendar" },
			]);
			expect(slices.join("\n")).toContain(
				"read first and navigate only when the result satisfies the condition",
			);
			expect(slices.join("\n")).toContain("VIEWS action=list");
		},
	);
	it("validates a Stage-1 requested destination against the live role-filtered catalog without repeating inference", async () => {
		const ctx = context("Show the observatory and draft the event", {
			disposition: "none",
			reason: "must not run",
		});
		const result = await runWithField(ctx, {
			disposition: "requested",
			viewId: "observatory",
			reason: "explicit",
		});
		expect(result.errors).toEqual([]);
		expect(result.navigationBlock).toBeUndefined();
		expect(prompts).toHaveLength(0);
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
	});
	it.each([
		{ candidates: [] },
		{ candidates: ["VIEWS", "CALENDAR"] },
		{ candidates: ["VIEWS_SHOW", "CALENDAR"] },
	])(
		"offers registered narrow navigation while preserving existing compound candidates %j",
		async ({ candidates }) => {
			const ctx = context("Open Observatory", {});
			ctx.runtime.actions.push({
				name: "VIEWS_SHOW",
			} as (typeof ctx.runtime.actions)[number]);
			ctx.messageHandler.plan.candidateActions = candidates;
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "observatory",
				reason: "explicit",
			});
			expect(result.errors).toEqual([]);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				...new Set([...candidates, "VIEWS_SHOW"]),
			]);
			expect(result.candidateActionsClearedByEvaluators).toBe(true);
			expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
				"VIEWS_SHOW with view=<selected id> and navigationStepId=<unique plan step>",
			);
			expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
				"VIEWS action=split",
			);
			expect(prompts).toEqual([]);
		},
	);

	it.each([
		{ singleViewOnly: true, child: true, expected: ["CALENDAR", "VIEWS_SHOW"] },
		{
			singleViewOnly: false,
			child: true,
			expected: ["VIEWS", "CALENDAR", "VIEWS_SHOW"],
		},
		{
			singleViewOnly: undefined,
			child: true,
			expected: ["VIEWS", "CALENDAR", "VIEWS_SHOW"],
		},
		{ singleViewOnly: true, child: false, expected: ["VIEWS", "CALENDAR"] },
	])(
		"narrows only an explicit same-turn single-view classification: %j",
		async ({ singleViewOnly, child, expected }) => {
			const ctx = context(
				"Open Observatory and read my calendar; do not edit events",
				{},
			);
			if (child)
				ctx.runtime.actions.push({
					name: "VIEWS_SHOW",
				} as (typeof ctx.runtime.actions)[number]);
			ctx.messageHandler.plan.candidateActions = ["VIEWS", "CALENDAR"];
			ctx.messageHandler.plan.parentActionHints = ["VIEWS", "CALENDAR"];
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "observatory",
				reason: "Model operation judgment",
				...(singleViewOnly === undefined ? {} : { singleViewOnly }),
			});
			expect(result.errors).toEqual([]);
			expect(ctx.messageHandler.plan.candidateActions).toEqual(expected);
			expect(ctx.messageHandler.plan.parentActionHints).toEqual(
				singleViewOnly && child ? ["CALENDAR"] : ["VIEWS", "CALENDAR"],
			);
			expect(prompts).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
		},
	);

	it.each([true, false])(
		"defers interaction schemas before navigation while discovery stays complete (Stage 1 target=%s)",
		async (stageOneTarget) => {
			const description = `${"Keep every user constraint. ".repeat(1200)}END`;
			const capability = {
				id: "save-observation",
				description:
					"Save a telescope observation only with explicit approval.",
				params: {
					content: { type: "string", description, required: true },
					confirm: {
						type: "boolean",
						description: "Explicit user approval",
						enum: [true],
						required: true,
					},
				},
			};
			extraViews = [
				{
					id: "observations",
					label: "Observations",
					pluginName: "astronomy",
					available: true,
					capabilities: [capability],
				},
			];
			const decision = {
				disposition: "requested",
				viewId: "observations",
				reason: "explicit",
			};
			const ctx = context(
				"Open Observations without changing records",
				decision,
			);
			const result = stageOneTarget
				? await runWithField(ctx, decision)
				: await run(ctx);
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
			const handoff = ctx.messageHandler.plan.contextSlices?.join("\n") ?? "";
			expect(handoff).toContain(capability.id);
			expect(handoff).toContain(capability.description);
			expect(handoff).toContain('"paramsDeferred":true');
			expect(handoff).toContain(
				"complete current schema with VIEWS action=list",
			);
			expect(handoff).not.toContain(description);
			if (stageOneTarget) expect(prompts).toEqual([]);
			else {
				expect(prompts).toHaveLength(1);
				const catalogLine = prompts[0]
					.split("\n")
					.find((line) => line.startsWith("Authorized live catalog: "));
				if (!catalogLine)
					throw new Error("Missing authorized catalog reference");
				const modelCatalog = JSON.parse(
					catalogLine.slice("Authorized live catalog: ".length),
				);
				expect(modelCatalog.map((view: ViewSummary) => view.id)).toEqual([
					"observatory",
					"observations",
				]);
				expect(modelCatalog[1]).toEqual({
					...extraViews[0],
					capabilities: [
						{
							id: capability.id,
							description: capability.description,
							paramsDeferred: true,
						},
					],
				});
				expect(prompts[0]).not.toContain(description);
				expect(prompts[0]).toContain(
					"complete current schema with VIEWS action=list",
				);
			}
			const listed = await runViewsList({ client: createViewsClient() });
			expect(listed.success).toBe(true);
			expect(listed.data).toMatchObject({
				views: expect.arrayContaining([
					expect.objectContaining({
						id: "observations",
						capabilities: [capability],
					}),
				]),
			});
			// Explicit discovery must see fresh schemas, not a stored projected copy.
			extraViews[0].capabilities = [
				{
					...capability,
					params: {
						...capability.params,
						content: {
							...capability.params.content,
							description: `${description} updated`,
						},
					},
				},
			];
			const refreshed = await runViewsList({ client: createViewsClient() });
			expect(refreshed.data).toMatchObject({
				views: expect.arrayContaining([
					expect.objectContaining({
						id: "observations",
						capabilities: extraViews[0].capabilities,
					}),
				]),
			});
			expect(requestedPaths).toEqual([
				"/api/views",
				"/api/views",
				"/api/views",
			]);
		},
	);
	it.each([
		{ viewId: "home", id: "chat", label: "Messages" },
		{ viewId: "Home", id: "chat", label: "Messages" },
		{ viewId: "chat", id: "chat", label: "Messages" },
		{ viewId: "Browser", id: "browser", label: "Browser" },
		{ viewId: "Custom-Panel", id: "custom-panel", label: "Weather radar" },
	])(
		"reuses a model-selected $viewId target through the authorized catalog without another call",
		async ({ viewId, id, label }) => {
			extraViews = [
				{
					id,
					label,
					pluginName: "builtin",
					available: true,
				},
			];
			const text = `Open ${viewId} without changing any notes or calendar events`;
			const ctx = context(text, {
				disposition: "none",
				reason: "must not run",
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId,
				reason: "explicit navigation",
			});
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
			expect(prompts).toHaveLength(0);
			expect(requestedPaths).toEqual(["/api/views"]);
			expect(ctx.message.content.text).toBe(text);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"CALENDAR",
				"VIEWS",
			]);
			expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
				`"viewId":"${id}"`,
			);
		},
	);
	it.each<{ catalog: ViewSummary[] }>([
		{
			catalog: [{ id: "browser", label: "Browser", available: false }],
		},
		{
			catalog: [
				{
					id: "browser",
					label: "Browser",
					available: true,
					developerOnly: true,
				},
			],
		},
		{
			catalog: [
				{
					id: "browser",
					label: "Private Browser",
					available: true,
					roleGate: { minRole: "OWNER" },
				},
			],
		},
		{
			catalog: [
				{ id: "browser", label: "First browser", available: true },
				{ id: "BROWSER", label: "Second browser", available: true },
			],
		},
	])(
		"retains classification for unavailable or ambiguous folded IDs: %j",
		async ({ catalog }) => {
			extraViews = catalog.map((view) => ({ ...view, pluginName: "fixture" }));
			const ctx = context("Open Browser", {
				disposition: "none",
				reason: "No unambiguous authorized destination",
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "Browser",
				reason: "requested",
			});
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).not.toContain("Private Browser");
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		},
	);
	it.each<{ catalog: ViewSummary[] }>([
		{ catalog: [] },
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: false,
				},
			],
		},
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: true,
					roleGate: { minRole: "OWNER" },
				},
			],
		},
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: true,
					developerOnly: true,
				},
			],
		},
	])(
		"keeps inference and denial when an alias target is not authorized: %j",
		async ({ catalog }) => {
			extraViews = catalog;
			const ctx = context("Go Home", {
				disposition: "none",
				reason: "unavailable",
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "home",
				reason: "requested",
			});
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(result.navigationBlock).toBe("forbidden");
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		},
	);
	it.each([
		undefined,
		{ disposition: "unresolved", viewId: "", reason: "uncertain" },
		{ disposition: "requested", viewId: "admin", reason: "restricted" },
		{ disposition: "requested", viewId: "offline", reason: "unavailable" },
	])(
		"retains the classifier for invalid, unresolved or unauthorized field decisions: %j",
		async (value) => {
			const ctx = context("Help me with this view", {
				disposition: "none",
				reason: "unavailable",
			});
			const result = await runWithField(ctx, value);
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).not.toContain("Restricted account details");
			expect(result.navigationBlock).toBe("forbidden");
		},
	);
	it.each(
		["text", "actor", "room", "id", "runtime", "role"].flatMap((binding) =>
			["observatory", ""].map((viewId) => ({ binding, viewId })),
		),
	)(
		"rejects a Stage-1 decision with viewId=$viewId after its $binding binding changes",
		async ({ binding, viewId }) => {
			const ctx = context("Show the observatory", {
				disposition: "forbidden",
				reason: "fresh decision",
			});
			Object.assign(ctx.message.content, {
				source: "client_chat",
				channelType: "DM",
			});
			ctx.runtime.actions.push({
				name: "VIEWS_SHOW",
			} as (typeof ctx.runtime.actions)[number]);
			ctx.messageHandler.plan.candidateActions = ["VIEWS_SHOW"];
			const result = await runWithField(
				ctx,
				{
					disposition: "requested",
					viewId,
					reason: "old",
					singleViewOnly: false,
					navigationOnly: false,
				},
				() => {
					if (binding === "text") ctx.message.content.text = "Stay here";
					if (binding === "actor")
						ctx.message.entityId = "actor-2" as typeof ctx.message.entityId;
					if (binding === "room")
						ctx.message.roomId = "room-2" as typeof ctx.message.roomId;
					if (binding === "id")
						ctx.message.id = "turn-2" as typeof ctx.message.id;
					if (binding === "runtime") ctx.runtime = { ...ctx.runtime };
					if (binding === "role") ctx.userRoles = ["OWNER"];
				},
			);
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(result.navigationBlock).toBe("forbidden");
		},
	);

	it("preserves a complete long decision inside a whole code fence", () => {
		const decision = {
			disposition: "forbidden",
			reason: `${"Preserve all requested domain work. ".repeat(1000)}画面を変えないでください。`,
		};
		expect(
			parseContextualNavigationIntent(
				`\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``,
			),
		).toEqual(decision);
	});
	for (const raw of [
		'Ignore this decision: {"disposition":"requested","viewId":"observatory","reason":"do not open"}',
		'{"disposition":"none","reason":"question"} trailing instructions',
		'```json\n{"disposition":"none","reason":"question"}',
		'```json\n{"disposition":"none","reason":"question"}\n```\n{"disposition":"forbidden","reason":"keep current view"}',
	]) {
		it(`rejects an incomplete or ambiguous decision: ${raw}`, () => {
			expect(() => parseContextualNavigationIntent(raw)).toThrowError(
				"Contextual navigation decision is not JSON",
			);
		});
	}
	it("parses a fenced JSON decision instead of failing the evaluator", async () => {
		const ctx = context("open my calendar", {
			disposition: "none",
			reason: "x",
		});
		(ctx.runtime as unknown as { useModel: unknown }).useModel = async (
			_type: string,
			request: { prompt: string },
		) => {
			prompts.push(request.prompt);
			return '```json\n{"disposition":"none","reason":"just a question"}\n```';
		};
		const result = await run(ctx);
		expect(prompts).toHaveLength(1);
		expect(result.errors).toEqual([]);
		expect(result.appliedPatches).toEqual([
			expect.objectContaining({
				evaluatorName: "app-control.view-context-planning",
				changed: [
					"candidateActions:clear",
					"candidateActions:add",
					"contextSlices:add",
				],
			}),
		]);
	});

	it("does not spend a model call on a turn that surfaces to a viewless connector", async () => {
		const ctx = context("open my calendar", {
			disposition: "requested",
			viewId: "calendar",
			reason: "explicit",
		});
		(ctx.message as { content: Record<string, unknown> }).content = {
			text: "open my calendar",
			source: "discord",
		};
		const result = await run(ctx);
		expect(prompts).toHaveLength(0);
		expect(result.errors).toEqual([]);
		expect(result.appliedPatches).toEqual([]);
	});

	it("adds a dynamically registered destination without erasing domain work or executing navigation", async () => {
		const ctx = context(
			"Find a free half-hour, draft an observation, and show the observatory",
			{
				disposition: "requested",
				viewId: "observatory",
				reason: "visual continuation",
			},
		);
		const result = await run(ctx);
		expect(result.errors).toEqual([]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
		expect(ctx.messageHandler.plan.parentActionHints).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
		expect(ctx.messageHandler.plan.reply).toBeUndefined();
		expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
		expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
			'"viewId":"observatory"',
		);
		const handoff = ctx.messageHandler.plan.contextSlices?.join("\n") ?? "";
		expect(handoff).toContain("Proposed authorized destination:");
		expect(handoff).not.toContain("paramsDeferred");
		expect(handoff).toContain("Authorized destination index:");
		expect(handoff).toContain("fresh VIEWS action=list read");
		expect(handoff).not.toContain("Authorized live catalog:");
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(prompts[0]).not.toContain("Restricted account details");
		expect(prompts[0]).not.toContain('"id":"offline"');
	});
	it.each([
		"Open only the Observatory. Do not open other views or create, edit, or delete any records.",
		"Put the Observatory and Notes side by side horizontally. Only these two views; do not change any notes or other data.",
	])(
		"carries a scoped requested destination into the planner: %s",
		async (text) => {
			const ctx = context(
				text,
				{
					disposition: "requested",
					viewId: "observatory",
					reason: "requested destination within the permitted scope",
				},
				() => {
					expect(navigationDispatchBlock(ctx.message, true)).toBe("forbidden");
				},
			);
			const result = await run(ctx);
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
			expect(prompts[0]).toContain(JSON.stringify(text));
			expect(ctx.message.content.text).toBe(text);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"CALENDAR",
				"VIEWS",
			]);
			expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
			expect(requestedPaths).toEqual(["/api/views"]);
		},
	);
	it.each([
		"Describe an Observatory and Notes layout, but stay on the current screen and do not navigate.",
		"Do not open the Observatory. Explain it here instead.",
	])(
		"keeps a forbidden model decision fail closed at dispatch: %s",
		async (text) => {
			const ctx = context(text, {
				disposition: "forbidden",
				reason: "requested navigation is prohibited",
			});
			const result = await run(ctx);
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts[0]).toContain(JSON.stringify(text));
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
			expect(requestedPaths).toEqual(["/api/views"]);
		},
	);
	it("preserves a long multilingual request including its late navigation constraint", async () => {
		const text = `${"Full observation context. ".repeat(1000)}追加してください。ただし画面を変えないでください。`;
		const ctx = context(text, {
			disposition: "forbidden",
			reason: "no view change",
		});
		await run(ctx);
		expect(prompts[0]).toContain(JSON.stringify(text));
		expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
			'"disposition":"forbidden"',
		);
		expect(requestedPaths).toEqual(["/api/views"]);
	});
	for (const target of ["invented", "admin", "offline"]) {
		it(`rejects ${target} without modifying the domain plan`, async () => {
			const ctx = context("Help plan this observation", {
				disposition: "optional",
				viewId: target,
				reason: "test",
			});
			const result = await run(ctx);
			expect(result.errors).toHaveLength(1);
			expect(result.navigationBlock).toBe("forbidden");
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
			expect(requestedPaths).toEqual(["/api/views"]);
		});
	}
	it("reports catalog failure without dispatching or hiding domain actions", async () => {
		catalogStatus = 503;
		const ctx = context("Plan my observation", {
			disposition: "none",
			reason: "unavailable",
		});
		const result = await run(ctx);
		expect(result.errors).toHaveLength(1);
		expect(prompts).toEqual([]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
	});
	for (const processMessage of ["STOP", "IGNORE"] as const) {
		it(`does not select a delayed switch on ${processMessage}`, async () => {
			const ctx = context("Open observations", {
				disposition: "requested",
				viewId: "observatory",
				reason: "request",
			});
			ctx.messageHandler.processMessage = processMessage;
			await run(ctx);
			expect(requestedPaths).toEqual([]);
			expect(prompts).toEqual([]);
		});
	}
});
