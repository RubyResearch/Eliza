/**
 * Real TCP coverage for app-control view requests crossing a bearer-protected
 * loopback boundary through the client, show path, and public action handlers.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { runWithStreamingContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppControlClient } from "../client/api.js";
import { createAgentSwitchAction } from "./agent-switch.js";
import { createBackgroundAction } from "./background.js";
import { createModelSwitchAction } from "./model-switch.js";
import { setNavigationConstraint } from "./navigation-execution.js";
import { createSettingsAction } from "./settings.js";
import { createViewsAction } from "./views.js";
import {
	createViewsClient,
	readViewInteractionEffectContract,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";
import { runViewsShow } from "./views-show.js";

interface CapturedRequest {
	method: string;
	pathname: string;
	authorization: string | undefined;
	body: string;
}

interface AuthenticatedViewsServer {
	port: number;
	requests: CapturedRequest[];
}

const ENV_KEYS = [
	"ELIZA_PORT",
	"ELIZA_UI_PORT",
	"ELIZA_API_TOKEN",
	"ELIZA_API_AUTH_TOKEN",
	"ELIZA_REQUIRE_LOCAL_AUTH",
] as const;

const SETTINGS_VIEW: ViewSummary = {
	id: "settings",
	label: "Settings",
	path: "/settings",
	pluginName: "core",
	available: true,
	viewType: "gui",
};

const NOTES_VIEW: ViewSummary = {
	id: "notes",
	label: "Notes",
	path: "/notes",
	pluginName: "plugin-notes",
	available: true,
	viewType: "gui",
	capabilities: [
		{
			id: "create-note",
			description: "Create a durable sticky note.",
			params: {
				title: {
					type: "string",
					description: "Required note title.",
					required: true,
					minLength: 1,
					maxLength: 240,
					pattern: "\\S",
				},
			},
		},
	],
};

const CALENDAR_VIEW: ViewSummary = {
	id: "calendar",
	label: "Calendar",
	path: "/calendar",
	pluginName: "plugin-calendar",
	available: true,
	viewType: "gui",
};

const LOOPBACK_EFFECT_RECEIPT = {
	receiptId: "simple-views:create-note:note-loopback:9",
	operation: "simple-views.create-note",
	resource: {
		kind: "simple-views.note",
		id: "note-loopback",
		version: "9",
	},
	artifacts: [],
	idempotency: { key: null, replayed: false },
	observedAt: "2026-08-02T12:00:00.000Z",
	outcome: "applied",
	commit: {
		kind: "durable",
		id: "simple-views:revision:9",
		committedAt: "2026-08-02T12:00:00.000Z",
	},
} as const;

const servers: http.Server[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function startAuthenticatedViewsServer(
	expectedToken: string,
	views: ViewSummary[] = [SETTINGS_VIEW, NOTES_VIEW, CALENDAR_VIEW],
): Promise<AuthenticatedViewsServer> {
	const requests: CapturedRequest[] = [];
	const server = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const body = await readRequestBody(req);
			const request = {
				method: req.method ?? "GET",
				pathname: url.pathname,
				authorization: req.headers.authorization,
				body,
			};
			requests.push(request);

			if (request.authorization !== `Bearer ${expectedToken}`) {
				sendJson(res, 401, { error: "Unauthorized" });
				return;
			}

			if (request.method === "GET" && request.pathname === "/api/views") {
				sendJson(res, 200, {
					views,
				});
				return;
			}
			if (
				request.method === "GET" &&
				request.pathname === "/api/views/search"
			) {
				sendJson(res, 200, {
					results: [{ ...SETTINGS_VIEW, _score: 100 }],
				});
				return;
			}
			if (
				request.method === "GET" &&
				request.pathname === "/api/views/current"
			) {
				sendJson(res, 200, {
					currentView: {
						viewId: "settings",
						viewPath: "/settings",
						viewLabel: "Settings",
						viewType: "gui",
						updatedAt: "2026-07-22T20:00:00.000Z",
					},
				});
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname.startsWith("/api/views/") &&
				request.pathname.endsWith("/navigate")
			) {
				sendJson(res, 200, { ok: true });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname.startsWith("/api/views/") &&
				request.pathname.endsWith("/interact")
			) {
				const interactionBody = JSON.parse(body) as {
					capability?: unknown;
				};
				if (interactionBody.capability === "create-note") {
					sendJson(res, 200, {
						requestId: "request-loopback",
						success: true,
						result: {
							success: true,
							text: "interaction complete",
							state: { revision: 9 },
							data: { note: { id: "note-loopback" } },
							effectReceipts: [LOOPBACK_EFFECT_RECEIPT],
							userFacingEffectReceiptIds: [LOOPBACK_EFFECT_RECEIPT.receiptId],
						},
					});
					return;
				}
				if (interactionBody.capability === "get-agent-state") {
					sendJson(res, 200, {
						requestId: "request-calendar-state",
						success: true,
						result: {
							viewId: "calendar",
							viewType: "gui",
							elementCount: 2,
							focusedId: null,
							elements: [
								{
									id: "calendar.month-heading",
									role: "heading",
									label: "August 2026",
									fillable: false,
									clickable: false,
									focused: false,
									visible: true,
								},
								{
									id: "calendar.private-token",
									role: "text-input",
									label: "API key",
									sensitive: true,
									valueRedacted: true,
									value: "must-not-reach-the-planner",
									fillable: false,
									clickable: false,
									focused: false,
									visible: true,
								},
							],
							updatedAt: 11,
						},
					});
					return;
				}
				if (interactionBody.capability === "undeclared-capability") {
					sendJson(res, 400, {
						error: "the view catalog does not declare that capability",
					});
					return;
				}
				sendJson(res, 200, { success: true, text: "interaction complete" });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname === "/api/views/events/broadcast"
			) {
				sendJson(res, 200, { ok: true });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname === "/api/runtime/agent-switch"
			) {
				sendJson(res, 200, {
					ok: true,
					profileId: "local",
					profileLabel: "Local",
				});
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname === "/api/runtime/model-switch"
			) {
				sendJson(res, 200, {
					ok: true,
					target: "cloud",
					model: "eliza-cloud",
					displayName: "Eliza Cloud",
					status: "ready",
				});
				return;
			}
			if (
				request.method === "PUT" &&
				request.pathname === "/api/permissions/shell"
			) {
				sendJson(res, 200, { ok: true, enabled: false });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname === "/api/background/generate-image"
			) {
				sendJson(res, 200, { url: "/api/media/generated-test.png" });
				return;
			}
			if (
				request.method === "GET" &&
				request.pathname === "/api/apps/installed"
			) {
				sendJson(res, 200, []);
				return;
			}
			sendJson(res, 404, { error: "Not found" });
		})().catch((error: unknown) => {
			sendJson(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as AddressInfo).port,
		requests,
	};
}

beforeEach(() => {
	previousEnv = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<(typeof ENV_KEYS)[number], string | undefined>;
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
});

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("authenticated view loopback requests", () => {
	it("fails closed on partial or unbound view mutation proof", () => {
		expect(
			readViewInteractionEffectContract({ success: true }),
		).toBeUndefined();
		expect(() =>
			readViewInteractionEffectContract({ effectReceipts: [] }),
		).toThrow(
			"View interaction mutation proof must include both receipts and user-facing receipt IDs.",
		);
		expect(() =>
			readViewInteractionEffectContract({
				effectReceipts: [LOOPBACK_EFFECT_RECEIPT],
				userFacingEffectReceiptIds: ["missing-receipt"],
			}),
		).toThrow(
			"View interaction user-facing receipt IDs must resolve to applied mutation receipts.",
		);
	});

	it("uses the canonical token, falls back to the legacy key, and omits empty auth", () => {
		expect(
			createViewsRequestHeaders({
				ELIZA_API_TOKEN: " bearer   canonical-token ",
				ELIZA_API_AUTH_TOKEN: "legacy-token",
			}),
		).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer canonical-token",
		});
		expect(
			createViewsRequestHeaders({
				ELIZA_API_AUTH_TOKEN: " legacy-token ",
			}),
		).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer legacy-token",
		});
		expect(createViewsRequestHeaders({})).toEqual({
			"Content-Type": "application/json",
		});
	});

	it("authenticates every ViewsClient route across a real HTTP boundary", async () => {
		const token = "views-client-test-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);

		const unauthenticated = await fetch(
			`http://127.0.0.1:${server.port}/api/views`,
		);
		expect(unauthenticated.status).toBe(401);

		process.env.ELIZA_API_TOKEN = token;
		const client = createViewsClient();
		await expect(client.listViews()).resolves.toEqual([
			SETTINGS_VIEW,
			NOTES_VIEW,
			CALENDAR_VIEW,
		]);
		await expect(client.getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
			viewPath: "/settings",
		});
		await expect(
			client.navigate("settings", { path: "/settings", viewType: "gui" }),
		).resolves.toBe(true);

		const authenticated = server.requests.filter(
			(request) => request.authorization !== undefined,
		);
		expect(
			authenticated.map(({ method, pathname }) => ({ method, pathname })),
		).toEqual([
			{ method: "GET", pathname: "/api/views" },
			{ method: "GET", pathname: "/api/views/current" },
			{ method: "POST", pathname: "/api/views/settings/navigate" },
		]);
		expect(
			authenticated.every(
				(request) => request.authorization === `Bearer ${token}`,
			),
		).toBe(true);
		expect(authenticated[2]?.body).toBe(
			JSON.stringify({ path: "/settings", viewType: "gui" }),
		);
		for (const request of authenticated) {
			expect(`${request.pathname}\n${request.body}`).not.toContain(token);
		}
	});

	it("preserves distinct planner step targets despite the original calendar clause", async () => {
		const server = await startAuthenticatedViewsServer("step-token");
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_AUTH_TOKEN = "step-token";
		const client = createViewsClient();
		const message = {
			id: "step-turn",
			entityId: "user-1",
			roomId: "room-1",
			agentId: "agent-1",
			content: { text: "Open calendar, draft an event, then open notes" },
		} as never;
		const first = await runWithStreamingContext(
			{ messageId: "step-turn" },
			() => {
				setNavigationConstraint(message, "allow", "requested");
				return runViewsShow({
					client,
					message,
					options: {
						view: "calendar",
						navigationIntent: "planner-step",
						navigationStepId: "calendar-step",
					},
				});
			},
		);
		const second = await runWithStreamingContext(
			{ messageId: "step-turn" },
			() => {
				setNavigationConstraint(message, "allow", "requested");
				return runViewsShow({
					client,
					message,
					options: {
						view: "notes",
						navigationIntent: "planner-step",
						navigationStepId: "notes-step",
					},
				});
			},
		);
		expect(
			server.requests
				.filter((request) => request.method === "POST")
				.map((request) => request.pathname),
		).toEqual(["/api/views/calendar/navigate", "/api/views/notes/navigate"]);
		expect(first.data).toMatchObject({
			navigation: { viewId: "calendar", stepId: "calendar-step" },
		});
		expect(second.data).toMatchObject({
			navigation: { viewId: "notes", stepId: "notes-step" },
		});
		expect(first.modelReplyRequired).toBe(true);
		expect(second.modelReplyRequired).toBe(true);
	});

	it("authenticates the show action's direct navigate path with the legacy key", async () => {
		const token = "views-show-legacy-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_AUTH_TOKEN = token;

		const client: ViewsClient = {
			listViews: async () => [SETTINGS_VIEW],
			getCurrentView: async () => null,
			navigate: async () => false,
		};
		const result = await runViewsShow({
			client,
			options: { action: "show", view: "settings" },
			message: {
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text: "go to settings" },
			} as never,
		});

		expect(result.success).toBe(true);
		expect(result.values?.viewId).toBe("settings");
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({
			method: "POST",
			pathname: "/api/views/settings/navigate",
			authorization: `Bearer ${token}`,
		});
		expect(server.requests[0]?.body).toBe(
			JSON.stringify({ path: "/settings" }),
		);
		expect(
			`${server.requests[0]?.pathname}\n${server.requests[0]?.body}`,
		).not.toContain(token);
	});

	it.each([
		"If I have exactly 3 saved notes, open Calendar. Otherwise stay here. Check the live notes first and do not change any records.",
		"Check my notes before I create a new note.",
		"Check my notes; do not select anything.",
		"Comprueba mis notas sin modificarlas.",
	])(
		"preserves the selected read across the HTTP boundary: %s",
		async (text) => {
			const token = "views-read-selection-token";
			const server = await startAuthenticatedViewsServer(token, [
				{
					...NOTES_VIEW,
					capabilities: [
						{ id: "get-notes", description: "Read saved notes." },
						{ id: "update-note", description: "Change a saved note." },
						{ id: "create-note", description: "Create a saved note." },
						{ id: "select-note", description: "Select a saved note." },
					],
				},
			]);
			process.env.ELIZA_PORT = String(server.port);
			process.env.ELIZA_API_TOKEN = token;
			const result = await createViewsAction({
				hasOwnerAccess: async () => true,
			}).handler(
				{ agentId: "agent-1" } as never,
				{
					entityId: "user-1",
					roomId: "room-1",
					agentId: "agent-1",
					content: { text },
				} as never,
				undefined,
				{
					action: "interact",
					view: "notes",
					capability: "get-notes",
					params: {},
				},
			);
			const posts = server.requests.filter(
				(request) => request.method === "POST",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]).toMatchObject({
				pathname: "/api/views/notes/interact",
				authorization: `Bearer ${token}`,
			});
			expect(JSON.parse(posts[0].body)).toMatchObject({
				capability: "get-notes",
			});
			expect(result).toMatchObject({
				success: true,
				values: { capability: "get-notes" },
			});
		},
	);

	it("makes a successful view interaction the turn's single terminal receipt", async () => {
		const token = "views-interaction-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_TOKEN = token;

		const callbackTexts: string[] = [];
		const result = await createViewsAction({
			hasOwnerAccess: async () => true,
		}).handler(
			{ agentId: "agent-1" } as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text: "create nub note" },
			} as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "create-note",
				title: "nub",
			},
			async (content) => {
				if (content.text) callbackTexts.push(content.text);
				return [];
			},
		);

		expect(callbackTexts).toEqual([]);
		expect(result).toMatchObject({
			success: true,
			text: "interaction complete",
			transcriptVisibility: "internal",
			modelReplyRequired: true,
			turnComplete: false,
			effectReceipts: [LOOPBACK_EFFECT_RECEIPT],
			userFacingEffectReceiptIds: [LOOPBACK_EFFECT_RECEIPT.receiptId],
		});
		expect(result).not.toHaveProperty("userFacingText");
		expect(server.requests.at(-1)).toMatchObject({
			method: "POST",
			pathname: "/api/views/notes/interact",
			authorization: `Bearer ${token}`,
			body: JSON.stringify({
				capability: "create-note",
				params: { title: "nub" },
				timeoutMs: 5_000,
				viewType: "gui",
			}),
		});
	});

	it("keeps a structured Calendar read internal while preserving the complete result", async () => {
		const token = "views-calendar-state-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_TOKEN = token;

		const callbackTexts: string[] = [];
		const result = await createViewsAction({
			hasOwnerAccess: async () => true,
		}).handler(
			{ agentId: "agent-1" } as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: {
					text: "what month and year is shown on the calendar",
				},
			} as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "get-agent-state",
			},
			async (content) => {
				if (content.text) callbackTexts.push(content.text);
				return [];
			},
		);

		expect(callbackTexts).toEqual([]);
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
			turnComplete: false,
			data: {
				viewId: "calendar",
				capability: "get-agent-state",
			},
		});
		expect(result).not.toHaveProperty("modelReplyFallback");
		expect(result).not.toHaveProperty("userFacingText");
		expect(result).not.toHaveProperty("verifiedUserFacing");
		const plannerState = JSON.stringify(result.data);
		expect(plannerState).toContain("August 2026");
		expect(plannerState).toContain("valueRedacted");
		expect(plannerState).toContain("must-not-reach-the-planner");
		expect(result.text).toContain("Interacted with view");
	});

	it("keeps a failed view interaction's diagnostic off the user callback", async () => {
		const token = "views-interaction-failure-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_TOKEN = token;

		const callbackTexts: string[] = [];
		const result = await createViewsAction({
			hasOwnerAccess: async () => true,
		}).handler(
			{ agentId: "agent-1" } as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text: "list my todos" },
			} as never,
			undefined,
			{
				action: "interact",
				view: "tasks",
				capability: "undeclared-capability",
			},
			async (content) => {
				if (content.text) callbackTexts.push(content.text);
				return [];
			},
		);

		// The catalog diagnostic goes back to the planner via the result; the
		// user-facing callback stays silent so the model can phrase the failure.
		expect(callbackTexts).toEqual([]);
		expect(result).toMatchObject({
			success: false,
			text: expect.stringContaining(
				'Cannot invoke capability "undeclared-capability" on view "tasks": the view catalog does not declare that capability. No interaction was dispatched.',
			),
			// Marked internal so core's transcript-visibility resolver can spot
			// an evaluator echo of the diagnostic.
			transcriptVisibility: "internal",
		});
		expect(result.turnComplete).toBe(false);
		expect(result).not.toHaveProperty("userFacingText");
		expect(
			(result as { verifiedUserFacing?: boolean }).verifiedUserFacing,
		).not.toBe(true);
	});

	it("authenticates every Node-side loopback caller", async () => {
		const token = "all-views-callers-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_TOKEN = token;

		const runtime = {
			agentId: "agent-1",
			getTasks: async () => [],
			createTask: async () => "task-1",
			deleteTask: async () => undefined,
		} as never;
		const message = (text: string) =>
			({
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text },
			}) as never;
		const viewsAction = createViewsAction({
			hasOwnerAccess: async () => true,
		});
		const invokeViews = async (
			text: string,
			options: Record<string, unknown>,
		) => {
			const result = await viewsAction.handler(
				runtime,
				message(text),
				undefined,
				options,
			);
			expect(result.success).toBe(true);
		};

		await invokeViews("open view manager", { action: "manager" });
		await invokeViews("pin settings", { action: "pin", view: "settings" });
		await invokeViews("split settings and notes", {
			action: "split",
			views: ["settings", "notes"],
		});
		await invokeViews("interact with settings", {
			action: "interact",
			view: "settings",
			capability: "get-state",
		});
		await invokeViews("broadcast refresh", {
			action: "broadcast",
			eventType: "demo:refresh",
		});
		await invokeViews("search views settings", {
			action: "search",
			query: "settings",
		});

		const backgroundAction = createBackgroundAction();
		const backgroundResult = await backgroundAction.handler(
			runtime,
			message("make the background green"),
		);
		expect(backgroundResult.success).toBe(true);
		const backgroundNavigateResult = await backgroundAction.handler(
			runtime,
			message("i want to upload my own background image"),
		);
		expect(backgroundNavigateResult.success).toBe(true);

		const agentSwitchAction = createAgentSwitchAction();
		const agentSwitchResult = await agentSwitchAction.handler(
			runtime,
			message("switch to local agent"),
			undefined,
			{ profile: "local" },
		);
		expect(agentSwitchResult.success).toBe(true);

		const modelSwitchAction = createModelSwitchAction();
		const modelSwitchResult = await modelSwitchAction.handler(
			runtime,
			message("switch model to cloud"),
			undefined,
			{ target: "cloud" },
		);
		expect(modelSwitchResult.success).toBe(true);

		const settingsAction = createSettingsAction();
		const settingsResult = await settingsAction.handler(
			runtime,
			message("use dark mode"),
			undefined,
			{
				action: "set",
				section: "appearance",
				key: "theme",
				value: "dark",
			},
		);
		expect(settingsResult.success).toBe(true);

		// A settings route OUTSIDE /api/views/* must carry the same bearer: the
		// whole local API boundary is token-protected, not just the views prefix.
		const shellPermissionResult = await settingsAction.handler(
			runtime,
			message("turn off shell access"),
			undefined,
			{
				action: "set",
				section: "permissions",
				key: "shell",
				value: "off",
			},
		);
		expect(shellPermissionResult.success).toBe(true);

		// The background image generator crosses the same boundary.
		const backgroundGenerateResult = await backgroundAction.handler(
			runtime,
			message("generate a background of a misty mountain sunrise"),
		);
		expect(backgroundGenerateResult.success).toBe(true);

		// The app-control loopback client (installed apps, runs, launch, stop).
		await expect(createAppControlClient().listInstalledApps()).resolves.toEqual(
			[],
		);

		const paths = server.requests.map((request) => request.pathname);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/api/views/__view-manager__/navigate",
				"/api/views/settings/navigate",
				"/api/views/settings/interact",
				"/api/views/events/broadcast",
				"/api/views/search",
				"/api/views/background/navigate",
				"/api/runtime/agent-switch",
				"/api/runtime/model-switch",
				"/api/permissions/shell",
				"/api/background/generate-image",
				"/api/apps/installed",
			]),
		);
		expect(
			server.requests.every(
				(request) => request.authorization === `Bearer ${token}`,
			),
		).toBe(true);
		for (const request of server.requests) {
			expect(`${request.pathname}\n${request.body}`).not.toContain(token);
		}
	});
});
