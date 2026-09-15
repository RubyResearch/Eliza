/**
 * Views management tests for create, edit, delete, follow-up routing, and the
 * authenticated loopback transport used by direct shell operations.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canActionRun } from "../../../../packages/core/src/runtime/action-gate.js";
import { viewFollowupRoutingEvaluator } from "../evaluators/view-followup-routing.js";
import { APP_CREATE_INTENT_TAG, runCreate } from "./app-create.js";
import { createViewsAction, createViewsAliasAction } from "./views.js";
import type { ViewSummary } from "./views-client.js";
import { runViewsCreate } from "./views-create.js";
import { runViewsDelete } from "./views-delete.js";
import { runViewsEdit } from "./views-edit.js";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	ModelType: {
		TEXT_SMALL: "TEXT_SMALL",
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	// @elizaos/shared re-exports formatError (as errorMessage) from @elizaos/core,
	// and app-control imports @elizaos/shared at module load — the mock must carry it.
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
		) =>
			run({
				parentStepId: "parent-step-1",
				linkChild: vi.fn(async () => {}),
			}),
	),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...coreMock,
		ElizaError: actual.ElizaError,
		containsExternalEnvelopeMaterial: actual.containsExternalEnvelopeMaterial,
		completeUserReferenceView: actual.completeUserReferenceView,
		findCodingDelegationActionName: actual.findCodingDelegationActionName,
		getStreamingContext: actual.getStreamingContext,
		getTurnActionConstraint: actual.getTurnActionConstraint,
		setTurnActionConstraint: actual.setTurnActionConstraint,
		getUserMessageText: actual.getUserMessageText,
		resolveStateDir: actual.resolveStateDir,
		unwrapUserMessageText: actual.unwrapUserMessageText,
	};
});

type RuntimeTask = {
	id: string;
	agentId?: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
};

function message(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: { text },
	};
}

function composedViewPrompt(userRequest: string) {
	return [
		"Answer the user request using the contextual documents below as the source of truth.",
		"",
		"<contextual_documents>",
		'<source title="source-1" similarity="1.000">',
		"Route chat through Cloud and configure purchase-share settings.",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

function view(patch: Partial<ViewSummary> = {}): ViewSummary {
	return {
		id: "remote-ledger",
		label: "Remote Ledger",
		description: "Track remote balances",
		available: true,
		pluginName: "@local/plugin-ledger",
		path: "/views/remote-ledger",
		tags: ["ledger"],
		viewType: "gui",
		...patch,
	};
}

function createRuntime({
	tasks = [],
	modelText = "name: remote-ledger\ndisplayName: Remote Ledger",
}: {
	tasks?: RuntimeTask[];
	modelText?: string;
} = {}) {
	const codingHandler = vi.fn(async () => ({
		success: true,
		text: "started",
		data: {
			agents: [
				{
					sessionId: "task-session-1",
					agentType: "coding",
					workdir: "/tmp/workdir",
					label: "view-task",
					status: "running",
				},
			],
		},
	}));
	const runtime = {
		agentId: "agent-1",
		actions: [{ name: "START_CODING_TASK", handler: codingHandler }],
		// Declare a configured coding backend so the create-flow dispatch
		// preflight stays deterministic on hosts without a coding CLI on PATH.
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_ACP_DEFAULT_AGENT" ? "claude" : undefined,
		),
		useModel: vi.fn(async () => modelText),
		getTasks: vi.fn(async () => tasks),
		createTask: vi.fn(async (task: unknown) => {
			tasks.push({
				id: `task-${tasks.length + 1}`,
				metadata:
					typeof task === "object" && task !== null && "metadata" in task
						? ((task as { metadata?: Record<string, unknown> }).metadata ?? {})
						: {},
			});
		}),
		deleteTask: vi.fn(async (taskId: string) => {
			const index = tasks.findIndex((task) => task.id === taskId);
			if (index >= 0) tasks.splice(index, 1);
		}),
	};
	return { runtime, codingHandler, tasks };
}

function evaluatorContext(
	text: string,
	overrides: Partial<ResponseHandlerEvaluatorContext> = {},
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			agentId: "agent-1",
			actions: [{ name: "VIEWS" }],
			logger: coreMock.logger,
		},
		message: message(text) as never,
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "direct reply",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "Sure, what should the note be titled?",
			},
		},
		availableContexts: [{ id: "general" }, { id: "simple" }],
		...overrides,
	} as ResponseHandlerEvaluatorContext;
}

function createRepoFixture() {
	const repoRoot = mkdtempSync(path.join(tmpdir(), "views-actions-"));
	const templateDir = path.join(
		repoRoot,
		"packages/elizaos/templates/min-plugin",
	);
	const pluginsDir = path.join(repoRoot, "plugins");
	mkdirSync(path.join(templateDir, "src"), { recursive: true });
	mkdirSync(pluginsDir, { recursive: true });
	writeFileSync(
		path.join(templateDir, "package.json"),
		JSON.stringify({
			name: "@local/plugin-__PLUGIN_NAME__",
			displayName: "__PLUGIN_DISPLAY_NAME__",
			// seedGuiViewScaffold validates a semver-pinned biome devDep on the
			// scaffolded template (matches the repo-canonical pin in root
			// package.json). scripts/dependencies are auto-created by objectField.
			devDependencies: { "@biomejs/biome": "2.5.4" },
		}),
	);
	writeFileSync(
		path.join(templateDir, "src/index.ts"),
		"export const name = '__PLUGIN_NAME__';\nexport const displayName = '__PLUGIN_DISPLAY_NAME__';\n",
	);
	writeFileSync(
		path.join(templateDir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				module: "ESNext",
				moduleResolution: "bundler",
			},
			include: ["src/**/*.ts", "tests/**/*.ts"],
		}),
	);
	return {
		repoRoot,
		pluginsDir,
		cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
	};
}

describe("view management actions", () => {
	beforeEach(() => {
		coreMock.spawnWithTrajectoryLink.mockClear();
		coreMock.resolveServerOnlyPort.mockClear();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("admits navigation on Notes turns through the planner's action gate", () => {
		const action = createViewsAction();
		expect(
			canActionRun(action, { activeContexts: ["notes"], userRoles: ["USER"] }),
		).toBe(true);
		expect(
			canActionRun(action, { activeContexts: ["web"], userRoles: ["USER"] }),
		).toBe(false);
	});

	it("authenticates direct manager and broadcast loopback requests", async () => {
		vi.stubEnv("ELIZA_API_TOKEN", "views-management-loopback-token");
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);
		const { runtime } = createRuntime();
		const action = createViewsAction({
			hasOwnerAccess: vi.fn(async () => true),
		});

		const managerResult = await action.handler(
			runtime as never,
			message("open view manager") as never,
			undefined,
			{ action: "manager" },
			vi.fn(),
		);
		const broadcastResult = await action.handler(
			runtime as never,
			message("broadcast refresh") as never,
			undefined,
			{ action: "broadcast", eventType: "demo:refresh" },
			vi.fn(),
		);

		expect(managerResult?.success).toBe(true);
		expect(broadcastResult?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenNthCalledWith(
			1,
			"http://127.0.0.1:3456/api/views/__view-manager__/navigate",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer views-management-loopback-token",
				},
			}),
		);
		expect(globalThis.fetch).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:3456/api/views/events/broadcast",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer views-management-loopback-token",
				},
			}),
		);
		for (const [url, init] of vi.mocked(globalThis.fetch).mock.calls) {
			expect(`${String(url)}\n${String(init?.body ?? "")}`).not.toContain(
				"views-management-loopback-token",
			);
		}
	});

	it("routes active-view mutation follow-ups through VIEWS before direct reply", async () => {
		const notesView = view({
			id: "notes",
			label: "Notes",
			description: "Sticky notes board",
			tags: ["notes", "sticky-notes"],
			capabilities: [
				{
					id: "create-note",
					description: "Create a sticky note",
					params: {
						title: { type: "string", description: "Optional note title" },
						body: { type: "string", description: "Note body text" },
					},
				},
				{
					id: "delete-note",
					description: "Delete a sticky note by id, title, or query",
				},
			],
		});
		vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
			const requestUrl = String(url);
			if (requestUrl.endsWith("/api/views/current")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						currentView: {
							viewId: "notes",
							viewPath: "/notes",
							viewLabel: "Notes",
							viewType: "gui",
							action: "open",
							updatedAt: "2026-06-08T00:00:00.000Z",
						},
					}),
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ views: [notesView] }),
			} as Response;
		});

		const context = evaluatorContext(
			"can you make another one saying i need to wake up at 3am",
		);

		expect(await viewFollowupRoutingEvaluator.shouldRun(context)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(context),
		).resolves.toMatchObject({
			requiresTool: true,
			clearReply: true,
			addContexts: ["general"],
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			clearParentActionHints: true,
			addParentActionHints: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "interact", view: "notes", viewType: "gui" },
			},
		});
	});

	it("leaves ordinary non-view follow-ups on the direct path", async () => {
		const context = evaluatorContext("can you make another joke", {
			messageHandler: {
				processMessage: "RESPOND",
				thought: "direct reply",
				plan: {
					contexts: ["simple"],
					requiresTool: false,
					reply: "Here's another joke.",
				},
			},
		} as never);

		expect(await viewFollowupRoutingEvaluator.shouldRun(context)).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("advertises UI view switching in its planner routing hint", () => {
		const action = createViewsAction();
		const closeOne = createViewsAliasAction("CLOSE_VIEW");
		const closeAll = createViewsAliasAction("CLOSE_ALL_VIEWS");
		expect(action.routingHint).toContain(
			"Opening one known app view -> VIEWS_SHOW",
		);
		expect(action.routingHint).toContain("VIEWS action=show is the fallback");
		expect(action.routingHint).toContain("Close/hide means VIEWS action=close");
		expect(action.routingHint).toContain(
			"agent-fill and agent-click are only for an explicitly requested form-control interaction",
		);
		expect(action.routingHint).toContain(
			"reading or changing calendar events uses CALENDAR.",
		);
		expect(action.routingHint).toContain(
			"action=interact view=device-control capability=set-flashlight",
		);
		expect(action.similes).toContain("SET_FLASHLIGHT");
		expect(action.tags).toContain("flashlight");
		expect(action.description).toContain("native device controls");
		expect(closeOne.routingHint).toContain("one open UI view/tab");
		expect(closeAll.routingHint).toContain("every open UI view/tab");
		expect(closeOne.routingHint).not.toContain("show or switch");
		expect(closeAll.routingHint).not.toContain("show or switch");
		expect(closeAll.parameters).toEqual([]);
		expect(
			Array.isArray(closeOne.parameters)
				? closeOne.parameters.map((parameter) => parameter.name)
				: [],
		).toEqual(["view", "id", "name", "target"]);
		expect(closeOne.tags).not.toContain("notes");
		expect(closeAll.tags).not.toContain("notes");
	});

	it("does not reinterpret an undeclared explicit capability on the current view", async () => {
		const { runtime } = createRuntime();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						capabilities: [
							{
								id: "create-note",
								description: "Create a sticky note.",
							},
						],
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui" as const,
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("add demo tomorrow at 9am") as never,
			undefined,
			{
				action: "interact",
				capability: "create-calendar-event",
				params: { title: "demo", date: "2026-08-05", time: "09:00" },
			},
			vi.fn(),
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toContain("Specify view and capability");
		expect(result?.text).not.toContain("create-note");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	function stubOrchestratorViewsWire() {
		const wireView = {
			id: "orchestrator",
			label: "Orchestrator",
			pluginName: "@elizaos/plugin-task-coordinator",
			available: true,
			path: "/orchestrator",
			viewType: "gui",
			capabilities: [
				{
					id: "orchestrator-status",
					description: "Read orchestrator status.",
				},
				{
					id: "orchestrator-validate-task",
					description: "Approve or reject task validation.",
					authority: "human",
					params: {
						taskId: { type: "string", description: "Task id" },
					},
				},
			],
		};
		const fetchMock = vi.mocked(globalThis.fetch);
		fetchMock.mockImplementation(async (url) => {
			const href = String(url);
			if (href.startsWith("http://127.0.0.1:3456/api/views/current")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ current: null }),
				} as Response;
			}
			if (href.includes("/api/views/orchestrator/interact")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						success: true,
						result: { success: true, data: { status: "idle" } },
					}),
				} as Response;
			}
			if (href.startsWith("http://127.0.0.1:3456/api/views")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ views: [wireView] }),
				} as Response;
			}
			throw new Error(`unexpected loopback request: ${href}`);
		});
		return fetchMock;
	}

	function dispatchedInteractCapabilities(): string[] {
		return vi
			.mocked(globalThis.fetch)
			.mock.calls.filter(([url]) => String(url).includes("/interact"))
			.map(([, init]) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					capability?: unknown;
				};
				return typeof body.capability === "string" ? body.capability : "";
			});
	}

	it("refuses an explicitly requested human-only capability parsed from the real view registry wire", async () => {
		const { runtime } = createRuntime();
		stubOrchestratorViewsWire();
		const action = createViewsAction({
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("approve this task") as never,
			undefined,
			{
				action: "interact",
				view: "orchestrator",
				capability: "orchestrator-validate-task",
				params: { taskId: "task-1" },
			},
			vi.fn(),
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/requires direct human interaction/);
		expect(result?.text).toContain("orchestrator-validate-task");
		expect(dispatchedInteractCapabilities()).toEqual([]);
	});

	it("never selects a human-only capability from the real view registry wire when the request is implicit", async () => {
		const { runtime } = createRuntime();
		stubOrchestratorViewsWire();
		const action = createViewsAction({
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("validate task task-1 in the orchestrator") as never,
			undefined,
			{ action: "interact", view: "orchestrator" },
			vi.fn(),
		);

		// The only agent-callable descriptor on the view is the read-only status
		// capability, so that is the most the planner may dispatch; the
		// human-only mutation must never reach the interact route.
		expect(result?.text).not.toContain("orchestrator-validate-task");
		expect(dispatchedInteractCapabilities()).not.toContain(
			"orchestrator-validate-task",
		);
		expect(dispatchedInteractCapabilities()).toEqual(["orchestrator-status"]);
	});

	it("normalizes legacy Notes title/body payloads into the declared one-field content contract", async () => {
		const { runtime } = createRuntime();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						capabilities: [
							{
								id: "create-note",
								description:
									"Create a note from one user-authored content field.",
								params: {
									content: {
										type: "string",
										description: "Complete note content.",
										required: true,
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				requestId: "notes-create",
				success: true,
				result: { success: true, text: "Created note “how cool i am”." },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("make a new note saying how cool i am") as never,
			undefined,
			{
				action: "interact",
				body: "how cool i am",
				capability: "create-note",
				title: "New Note",
				view: "notes",
			},
			vi.fn(),
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			viewId: "notes",
			capability: "create-note",
			params: { content: "how cool i am" },
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: { content: "how cool i am" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("routes Browser view browse aliases through the canonical BROWSER action", async () => {
		const { runtime } = createRuntime();
		const browserHandler = vi.fn(async () => ({
			success: true,
			text: "Opened https://www.apple.com.",
			userFacingText: "Opened https://www.apple.com.",
			verifiedUserFacing: true,
		}));
		runtime.actions.push({
			name: "BROWSER",
			validate: vi.fn(async () => true),
			handler: browserHandler,
		} as never);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "browser",
						label: "Browser",
						path: "/browser",
						capabilities: [],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "browser",
					viewLabel: "Browser",
					viewPath: "/browser",
					viewType: "gui" as const,
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("Go to apple.com") as never,
			undefined,
			{
				action: "interact",
				view: "browser",
				capability: "browse",
				params: { url: "https://www.apple.com" },
			},
			vi.fn(),
		);

		expect(browserHandler).toHaveBeenCalledWith(
			runtime,
			expect.objectContaining({ content: { text: "Go to apple.com" } }),
			undefined,
			expect.objectContaining({
				parameters: {
					action: "navigate",
					url: "https://www.apple.com",
				},
			}),
			expect.any(Function),
		);
		expect(result).toMatchObject({
			success: true,
			modelReplyRequired: true,
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("repairs a date-shaped calendar title emitted by a small planner", async () => {
		const { runtime } = createRuntime();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "simple-calendar",
						label: "Calendar",
						path: "/simple-calendar",
						capabilities: [
							{
								id: "get-calendar-state",
								description: "Read calendar events by date.",
								params: {
									date: { type: "string", description: "YYYY-MM-DD" },
									title: { type: "string", description: "Exact title" },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				requestId: "calendar-read",
				success: true,
				result: { success: true, text: "Investor Demo" },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			{
				...message("what's on my calendar today?"),
				content: {
					text: "what's on my calendar today?",
					metadata: { viewClientId: "ui-client-123" },
				},
			} as never,
			undefined,
			{
				action: "interact",
				view: "simple-calendar",
				capability: "get-calendar-state",
				params: { title: "2026-08-03" },
			},
			vi.fn(),
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/simple-calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"X-ElizaOS-Client-Id": "ui-client-123",
				}),
				body: JSON.stringify({
					capability: "get-calendar-state",
					params: { date: "2026-08-03" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("stays available when stage 1 routes a view request to a domain context", () => {
		const action = createViewsAction();
		expect(action.contexts).toEqual(
			expect.arrayContaining(["general", "calendar", "tasks", "documents"]),
		);
		expect(action.contextGate?.anyOf).toEqual(
			expect.arrayContaining(["calendar", "tasks"]),
		);
	});

	it("scaffolds a new view plugin and dispatches a coding task with the generated prompt", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime, codingHandler } = createRuntime();
			const callback = vi.fn();

			const result = await runViewsCreate({
				runtime: runtime as never,
				message: message("create a remote ledger dashboard view") as never,
				views: [],
				callback,
				repoRoot: repo.repoRoot,
			});

			const workdir = path.join(repo.pluginsDir, "plugin-remote-ledger");
			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				mode: "create",
				subMode: "new",
				name: "remote-ledger",
				displayName: "Remote Ledger",
				workdir,
				taskSessionId: "task-session-1",
			});
			expect(
				readFileSync(path.join(workdir, "src/index.ts"), "utf8"),
			).toContain("Remote Ledger");
			expect(
				readFileSync(path.join(workdir, "src/index.ts"), "utf8"),
			).toContain('bundlePath: "dist/views/bundle.js"');
			expect(
				readFileSync(path.join(workdir, "src/views/PluginView.tsx"), "utf8"),
			).toContain("create a remote ledger dashboard view");
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(codingHandler.mock.calls[0][1]).toMatchObject({
				roomId: "room-1",
			});
			const handlerOptions = codingHandler.mock.calls[0][3] as {
				parameters: Record<string, unknown>;
			};
			expect(handlerOptions.parameters.label).toBe("create-view:remote-ledger");
			expect(handlerOptions.parameters.task).toContain(
				"task: build_eliza_plugin_with_view",
			);
			expect(handlerOptions.parameters.task).toContain(
				"sourceDir already contains a working Plugin.views declaration",
			);
			expect(handlerOptions.parameters.task).toContain(
				"completionRule: after all commands pass",
			);
			expect(handlerOptions.parameters.task).toContain("bun run build");
			expect(handlerOptions.parameters.task).toContain(
				'"files":["<changed-relative-path>"]',
			);
			expect(handlerOptions.parameters.task).toContain(
				'"passed":<exact passed count>',
			);
			expect(handlerOptions.parameters.metadata).toMatchObject({
				originRoomId: "room-1",
				parentTrajectoryStepId: "parent-step-1",
				trajectoryLinkSource: "plugin-app-control:views-create",
			});
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("view now"),
				}),
			);
		} finally {
			repo.cleanup();
		}
	});

	it("resolves an existing view to a local plugin directory and dispatches an edit task", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-ledger");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();

			const result = await runViewsEdit({
				runtime: runtime as never,
				message: message("update the remote ledger title") as never,
				options: {
					view: "remote-ledger",
					intent: "rename the title to Remote Ledger Updated",
				},
				views: [view()],
				callback: vi.fn(),
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				mode: "edit",
				viewId: "remote-ledger",
				workdir: pluginDir,
				taskSessionId: "task-session-1",
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(codingHandler.mock.calls[0][1]).toMatchObject({
				roomId: "room-1",
			});
			const handlerOptions = codingHandler.mock.calls[0][3] as {
				parameters: Record<string, unknown>;
			};
			expect(handlerOptions.parameters.label).toBe("edit-view:remote-ledger");
			expect(handlerOptions.parameters.task).toContain(
				"task: edit_eliza_plugin_view",
			);
			expect(handlerOptions.parameters.task).toContain(
				"rename the title to Remote Ledger Updated",
			);
			expect(handlerOptions.parameters.task).toContain("bun run build");
			expect(handlerOptions.parameters.task).toContain(
				'"files":["<changed-relative-path>"]',
			);
			expect(handlerOptions.parameters.task).toContain(
				'"passed":<exact passed count>',
			);
			expect(handlerOptions.parameters.validator).toEqual({
				service: "app-verification",
				method: "verifyPlugin",
				params: {
					workdir: pluginDir,
					pluginName: "@local/plugin-ledger",
					profile: "full",
				},
			});
			expect(handlerOptions.parameters.onVerificationFail).toBe("retry");
			expect(handlerOptions.parameters.metadata).toMatchObject({
				originRoomId: "room-1",
				parentTrajectoryStepId: "parent-step-1",
				trajectoryLinkSource: "plugin-app-control:views-edit",
			});
		} finally {
			repo.cleanup();
		}
	});

	it("requires a structured target before deleting a view", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();
			const callback = vi.fn();

			const result = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(false);
			expect(result.text).toContain("structured view");
			expect(runtime.createTask).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			repo.cleanup();
		}
	});

	it("requires structured confirmation before deleting a view and unloads the plugin after confirm=true", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime, tasks } = createRuntime();
			const callback = vi.fn();

			const first = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				options: { view: "remote-ledger" },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(first.success).toBe(true);
			expect(first.values).toMatchObject({
				mode: "delete",
				subMode: "confirm",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(runtime.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "VIEWS_DELETE confirm",
					tags: ["views-delete-confirm"],
					metadata: expect.objectContaining({
						roomId: "room-1",
						viewId: "remote-ledger",
						pluginName: "@local/plugin-ledger",
					}),
				}),
			);
			expect(globalThis.fetch).not.toHaveBeenCalled();

			const textOnlyReply = await runViewsDelete({
				runtime: runtime as never,
				message: message("yes") as never,
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(textOnlyReply.success).toBe(false);
			expect(textOnlyReply.text).toContain("confirm=true");
			expect(runtime.deleteTask).not.toHaveBeenCalled();
			expect(tasks).toHaveLength(1);
			expect(globalThis.fetch).not.toHaveBeenCalled();

			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					pluginName: "@local/plugin-ledger",
					message: "@local/plugin-ledger uninstalled.",
				}),
			} as Response);

			const second = await runViewsDelete({
				runtime: runtime as never,
				message: message("sí") as never,
				options: { confirm: true },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(second.success).toBe(true);
			expect(second.values).toMatchObject({
				mode: "delete",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(runtime.deleteTask).toHaveBeenCalledWith("task-1");
			expect(tasks).toEqual([]);
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/plugins/uninstall",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "@local/plugin-ledger" }),
				}),
			);
			expect(second.text).toContain("uninstalled");
		} finally {
			repo.cleanup();
		}
	});

	it("owner-gates the follow-up delete confirmation turn for a non-owner (#10471)", async () => {
		// A pending delete-confirm task exists in this room. A non-owner replying
		// with a structured confirm must NOT be able to confirm someone else's
		// destructive delete — validate must funnel the follow-up turn through the
		// owner gate, exactly like the first destructive turn.
		const { runtime } = createRuntime({
			tasks: [
				{
					id: "task-1",
					metadata: {
						roomId: "room-1",
						viewId: "remote-ledger",
						viewLabel: "Remote Ledger",
						pluginName: "@local/plugin-ledger",
					},
				},
			],
		});
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		await expect(
			action.validate?.(runtime as never, message("yes") as never, undefined, {
				confirm: true,
			}),
		).resolves.toBe(false);
		// The gate was actually reached (not rejected for some earlier reason).
		expect(ownerCheck).toHaveBeenCalledTimes(1);

		// A structured cancel from a non-owner is gated the same way.
		await expect(
			action.validate?.(runtime as never, message("no") as never, undefined, {
				confirm: false,
			}),
		).resolves.toBe(false);
		expect(ownerCheck).toHaveBeenCalledTimes(2);
	});

	it("reports failure (not 'Deleted') when the plugin uninstall fails", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();
			const callback = vi.fn();

			await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				options: { view: "remote-ledger" },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			// The uninstall route ran but reported failure (e.g. a bundled/core
			// plugin). Delete must surface that, not claim the plugin was removed.
			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: false,
				status: 422,
				json: async () => ({ ok: false, error: "plugin is bundled" }),
			} as Response);

			const second = await runViewsDelete({
				runtime: runtime as never,
				message: message("confirmo") as never,
				options: { confirm: true },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(second.success).toBe(false);
			expect(second.text).not.toContain("Deleted");
			expect(second.text).toContain("partially failed");
			expect(second.text).toContain("plugin is bundled");
		} finally {
			repo.cleanup();
		}
	});

	it("refuses to delete protected first-party view plugins", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();

			const result = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the app control view") as never,
				options: { view: "@elizaos/plugin-app-control" },
				views: [
					view({
						id: "app-control",
						label: "App Control",
						pluginName: "@elizaos/plugin-app-control",
					}),
				],
				callback: vi.fn(),
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(false);
			expect(result.text).toContain("protected first-party plugin");
			expect(runtime.createTask).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			repo.cleanup();
		}
	});

	it("opens a view in a separate always-on-top window through the shell navigate API", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [view()]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAction({
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger view in a separate always on top window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				alwaysOnTop: true,
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "gui",
			alwaysOnTop: true,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: true,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("resolves existing registered view targets for natural-language window and pin requests", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const windowResult = await action.handler(
			runtime as never,
			message("open orchestrator in a new window") as never,
			undefined,
			undefined,
			callback,
		);

		expect(windowResult?.success).toBe(true);
		expect(windowResult?.values).toMatchObject({
			mode: "window",
			viewId: "orchestrator",
			viewType: "gui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: false,
				}),
			}),
		);

		const openActionWindowResult = await action.handler(
			runtime as never,
			message("open orchestrator in a new window") as never,
			undefined,
			{
				action: "window",
				view: "orchestrator",
			},
			callback,
		);

		expect(openActionWindowResult?.success).toBe(true);
		expect(openActionWindowResult?.values).toMatchObject({
			mode: "window",
			viewId: "orchestrator",
			viewType: "gui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: false,
				}),
			}),
		);

		const pinResult = await action.handler(
			runtime as never,
			message("pin views manager as a tab") as never,
			undefined,
			undefined,
			callback,
		);

		expect(pinResult?.success).toBe(true);
		expect(pinResult?.values).toMatchObject({
			mode: "pin",
			viewId: "views-manager",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/views-manager/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "pin-tab",
					alwaysOnTop: false,
				}),
			}),
		);

		const explicitPinResult = await action.handler(
			runtime as never,
			message("pin views manager as a tab") as never,
			undefined,
			{
				action: "pin",
				view: "views manager",
			},
			callback,
		);

		expect(explicitPinResult?.success).toBe(true);
		expect(explicitPinResult?.values).toMatchObject({
			mode: "pin",
			viewId: "views-manager",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/views-manager/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "pin-tab",
					alwaysOnTop: false,
				}),
			}),
		);

		const pollutedSplitResult = await action.handler(
			runtime as never,
			message("split orchestrator and views manager side by side") as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager", "chat", "settings"],
			},
			callback,
		);

		expect(pollutedSplitResult?.success).toBe(true);
		expect(pollutedSplitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it.each(["list", "current", "search"])(
		"keeps explicit %s read-only while preserving a split",
		async (mode) => {
			const { runtime } = createRuntime();
			const client = {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
				]),
				getCurrentView: vi.fn(async () => null),
			};
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
			});
			const result = await action.handler(
				runtime as never,
				message(
					"Keep the current split visible and tell me which views are open",
				) as never,
				undefined,
				{ action: mode, query: "notes" },
			);
			expect(result?.success).toBe(true);
			for (const [url, options] of vi.mocked(globalThis.fetch).mock.calls) {
				expect(String(url)).not.toContain("/navigate");
				expect(options?.method ?? "GET").toBe("GET");
			}
			expect(result?.values?.mode).not.toBe("split");
		},
	);

	it("routes split and tile requests through the shell layout navigate API", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// Two layout calls (split, then tile) → queue two navigate responses.
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const splitResult = await action.handler(
			runtime as never,
			message("split notes and calendar side by side") as never,
			undefined,
			undefined,
			callback,
		);

		expect(splitResult?.success).toBe(true);
		expect(splitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();

		const tileResult = await action.handler(
			runtime as never,
			message("tile my simple views") as never,
			undefined,
			{
				action: "tile",
				views: ["notes", "calendar"],
			},
			callback,
		);

		expect(tileResult?.success).toBe(true);
		expect(tileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["notes", "calendar"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["notes", "calendar"],
					layout: "grid",
				}),
			}),
		);
	});

	it.each([
		{
			request:
				"Create the QA note and calendar event, then show Notes and Calendar side by side. Leave existing notes, events, and reminders unchanged.",
			views: ["notes", "calendar"],
			expected: ["notes", "calendar"],
		},
		{
			request:
				"Show Notes and Calendar side by side. Leave reminders unchanged.",
			views: ["notes", "calendar", "goals", "family-operations"],
			expected: ["notes", "calendar"],
		},
		{
			request:
				"Show only Notes and Calendar; remove Goals and Mail & Calendars.",
			views: ["notes", "calendar"],
			expected: ["notes", "calendar"],
		},
		{
			request: "Arrange the selected views. Leave reminders unchanged.",
			views: ["notes", "calendar"],
			expected: ["notes", "calendar"],
		},
		{
			request: "Arrange the selected views side by side. Do not open Goals.",
			views: ["notes", "calendar"],
			expected: ["notes", "calendar"],
		},
		{
			request:
				"Arrange the selected views side by side. Do not open Goals or Mail & Calendars.",
			views: ["notes", "calendar"],
			expected: ["notes", "calendar"],
		},
		{
			request: "Split Notes and calender side by side.",
			views: [],
			expected: ["calendar", "notes"],
		},
	])(
		"keeps exact layout targets ahead of shared tags and unrelated restrictions: $request",
		async ({ request, views, expected }) => {
			const { runtime } = createRuntime();
			const action = createViewsAction({
				client: {
					listViews: vi.fn(async () => [
						view({
							id: "calendar",
							label: "Calendar",
							tags: ["calendar", "events", "calender"],
						}),
						view({
							id: "family-operations",
							label: "Family Operations",
							tags: ["calendar"],
						}),
						view({ id: "goals", label: "Goals", tags: ["reminders"] }),
						view({
							id: "lifeops-connections",
							label: "Mail & Calendars",
							tags: ["calendar"],
						}),
						view({ id: "notes", label: "Notes", tags: ["notes", "notepad"] }),
						view({ id: "cal", label: "Calorie log" }),
					]),
					getCurrentView: vi.fn(async () => null),
				},
				hasOwnerAccess: vi.fn(async () => true),
			});
			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

			const result = await action.handler(
				runtime as never,
				message(request) as never,
				undefined,
				{ action: "split", views, layout: "horizontal" },
				vi.fn(),
			);
			expect(result?.success).toBe(true);
			expect(result?.values).toMatchObject({
				mode: "split",
				viewIds: expected,
				layout: "horizontal",
			});
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(globalThis.fetch).toHaveBeenCalledWith(
				`http://127.0.0.1:3456/api/views/${expected[0]}/navigate`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						action: "split-view",
						views: expected,
						layout: "horizontal",
					}),
				}),
			);
		},
	);

	it.each([
		{ layout: "horizontal", mode: "split", action: "split-view" },
		{ layout: "vertical", mode: "split", action: "split-view" },
		{ layout: "grid", mode: "tile", action: "tile-views" },
	])(
		"honors explicit $layout when the planner uses tile",
		async ({ layout, mode, action: shellAction }) => {
			const { runtime } = createRuntime();
			const action = createViewsAction({
				client: {
					listViews: vi.fn(async () => [
						view({ id: "notes", label: "Notes" }),
						view({ id: "calendar", label: "Calendar" }),
					]),
					getCurrentView: vi.fn(async () => null),
				},
				hasOwnerAccess: vi.fn(async () => true),
			});
			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);
			const result = await action.handler(
				runtime as never,
				message(
					"Arrange only Notes and Calendar. Leave all records unchanged.",
				) as never,
				undefined,
				{ action: "tile", views: ["notes", "calendar"], layout },
				vi.fn(),
			);
			expect(result?.success).toBe(true);
			expect(result?.values).toMatchObject({
				mode,
				viewIds: ["notes", "calendar"],
				layout,
			});
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/notes/navigate",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						action: shellAction,
						views: ["notes", "calendar"],
						layout,
					}),
				}),
			);
		},
	);

	it("routes existing registered view layout requests without simple-view targets", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
					}),
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
					}),
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// This test exercises four layout handler calls (split, tile, planner-subset
		// tile, split-mode subset tile); each issues one navigate POST, so queue four
		// successful navigate responses. (Previously only three were queued and the
		// fourth call silently received `undefined` from the bare fetch mock — it
		// passed only because the helper hardcoded success:true regardless of the
		// transport result, which is the bug this change fixes.)
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const splitResult = await action.handler(
			runtime as never,
			message("split orchestrator and views manager side by side") as never,
			undefined,
			undefined,
			callback,
		);

		expect(splitResult?.success).toBe(true);
		expect(splitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);

		const tileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			undefined,
			callback,
		);

		expect(tileResult?.success).toBe(true);
		expect(tileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["chat", "settings", "orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["chat", "settings", "orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);

		// The declared pair is this step's subset. Report only its actual two
		// targets so the evaluator can continue the other requested destinations.
		const plannerSubsetTileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			{
				action: "tile",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(plannerSubsetTileResult?.success).toBe(true);
		expect(plannerSubsetTileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(plannerSubsetTileResult?.data).toMatchObject({
			viewIds: ["orchestrator", "views-manager"],
		});
		expect(plannerSubsetTileResult?.text).toBe(
			"Tiled views: Orchestrator, Views.",
		);
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);

		const splitModeSubsetTileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(splitModeSubsetTileResult?.success).toBe(true);
		expect(splitModeSubsetTileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);
	});

	it("uses the composed user_request block for layout target extraction", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
					}),
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
					}),
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				composedViewPrompt("split orchestrator and views manager side by side"),
			) as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it('places "next to it" through the planner-selected split operation', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui",
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{ action: "split", view: "calendar" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("does not add the current chat view when split targets already include two explicit views", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "chat", label: "Chat", path: "/" }),
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad"],
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "chat",
					viewLabel: "Chat",
					viewType: "gui",
					viewPath: "/",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{
				action: "split",
				mode: "split",
				view: "notepad",
				views: ["notepad", "calendar"],
				layout: "horizontal",
				placement: "right",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it('treats "next to it" as split even when the planner passes action=tile', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad"],
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{
				action: "tile",
				views: ["notepad", "calendar"],
				layout: "horizontal",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("executes a planned view navigation instead of querying the current view", async () => {
		// The planner supplies the action and target; user text cannot substitute
		// for a missing destination or override the structured navigation.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const getCurrentView = vi.fn(async () => null);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ id: "wallet", label: "Wallet" })]),
				getCurrentView,
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("open the wallet view") as never,
			undefined,
			{ action: "show", view: "wallet" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "wallet" });
		// A current-view query would have hit getCurrentView instead of navigate.
		expect(getCurrentView).not.toHaveBeenCalled();
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/wallet/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("owner-gates mutating view management modes but allows window navigation validation", async () => {
		const { runtime } = createRuntime();
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		await expect(
			action.validate?.(
				runtime as never,
				message("create a remote ledger dashboard view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("edit the remote ledger view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("delete the remote ledger view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("open the remote ledger view in a separate window") as never,
			),
		).resolves.toBe(true);
		expect(ownerCheck).toHaveBeenCalledTimes(3);
	});

	it("owner-gates the rollback sub-mode like other mutating modes (#8915)", async () => {
		const { runtime } = createRuntime();
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		// Explicit action=rollback is owner-gated.
		await expect(
			action.validate?.(
				runtime as never,
				message("rollback") as never,
				undefined,
				{ action: "rollback" },
			),
		).resolves.toBe(false);
		// Natural-language rollback phrasing is owner-gated too.
		await expect(
			action.validate?.(
				runtime as never,
				message("roll back the remote ledger plugin") as never,
			),
		).resolves.toBe(false);
		expect(ownerCheck).toHaveBeenCalledTimes(2);
	});

	it("routes action=rollback to the rollback handler and reports no snapshot when none recorded (#8915)", async () => {
		// No snapshot tasks recorded -> rollback short-circuits before any git/fetch,
		// proving the dispatcher wired the rollback sub-mode in.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("rollback the remote ledger plugin") as never,
			undefined,
			{ action: "rollback" },
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.text?.toLowerCase()).toContain("no pre-edit snapshot");
		// rollback never touched git/fetch when there's nothing to roll back.
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(runtime.getTasks).toHaveBeenCalled();
	});

	it("preserves explicit future terminal viewType and always-on-top false in window navigation payloads", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ viewType: "tui" })]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger future terminal view in a separate window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				viewType: "tui",
				alwaysOnTop: false,
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "tui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate?viewType=tui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					viewType: "tui",
					alwaysOnTop: false,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("preserves explicit future spatial viewType in window navigation payloads", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ viewType: "xr" })]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger spatial view in a separate window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				viewType: "xr",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "xr",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate?viewType=xr",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					viewType: "xr",
					alwaysOnTop: false,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("routes create, edit, and delete through the unified VIEWS action dispatcher", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-ledger");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();
			const callback = vi.fn();
			let registeredViews: ViewSummary[] = [];
			const client = {
				listViews: vi.fn(async () => registeredViews),
				getCurrentView: vi.fn(async () => null),
			};
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
				repoRoot: repo.repoRoot,
			});

			const createResult = await action.handler(
				runtime as never,
				message("create a remote ledger dashboard view") as never,
				undefined,
				{ action: "create", intent: "remote ledger dashboard" },
				callback,
			);

			expect(createResult?.success).toBe(true);
			expect(createResult?.values).toMatchObject({
				mode: "create",
				subMode: "new",
				name: "remote-ledger",
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(client.listViews).toHaveBeenCalledTimes(1);

			registeredViews = [view()];
			const editResult = await action.handler(
				runtime as never,
				message("edit the remote ledger view") as never,
				undefined,
				{
					action: "edit",
					intent: "rename the title to Remote Ledger Updated",
					view: "remote-ledger",
				},
				callback,
			);

			expect(editResult?.success).toBe(true);
			expect(editResult?.values).toMatchObject({
				mode: "edit",
				viewId: "remote-ledger",
				workdir: pluginDir,
			});
			expect(codingHandler).toHaveBeenCalledTimes(2);

			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					pluginName: "@local/plugin-ledger",
					message: "@local/plugin-ledger uninstalled.",
				}),
			} as Response);

			const deleteResult = await action.handler(
				runtime as never,
				message("delete the remote ledger view") as never,
				undefined,
				{
					action: "delete",
					confirm: true,
					view: "remote-ledger",
				},
				callback,
			);

			expect(deleteResult?.success).toBe(true);
			expect(deleteResult?.values).toMatchObject({
				mode: "delete",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/plugins/uninstall",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "@local/plugin-ledger" }),
				}),
			);
			expect(callback).not.toHaveBeenCalled();
		} finally {
			repo.cleanup();
		}
	});

	it("keeps an explicit edit target isolated from current-view capabilities", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-proof-surface");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();
			const client = {
				listViews: vi.fn(async () => [
					view({
						id: "cockpit",
						label: "Cockpit",
						pluginName: "@elizaos/plugin-task-coordinator",
						path: "/cockpit",
						capabilities: [
							{
								id: "orchestrator-add-agent",
								description: "Add an agent to the coding swarm.",
							},
						],
					}),
					view({
						id: "proof-surface",
						label: "Proof Surface",
						pluginName: "@local/plugin-proof-surface",
						path: "/proof-surface",
						capabilities: [],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "cockpit",
					viewLabel: "Cockpit",
					viewType: "gui" as const,
					viewPath: "/cockpit",
				})),
			};
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
				repoRoot: repo.repoRoot,
			});

			const result = await action.handler(
				runtime as never,
				message("add an agent") as never,
				undefined,
				{
					parameters: {
						action: "edit",
						view: "proof-surface",
						intent: "Replace marker VIEW_CREATED with VIEW_EDITED and rebuild.",
					},
				},
				vi.fn(),
			);

			expect(result?.success).toBe(true);
			expect(result?.values).toMatchObject({
				mode: "edit",
				viewId: "proof-surface",
				workdir: pluginDir,
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(globalThis.fetch).not.toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/cockpit/interact",
				expect.anything(),
			);
		} finally {
			repo.cleanup();
		}
	});

	it("routes explicit CLOSE_VIEW alias calls through non-destructive view close", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [
				view({ id: "settings", label: "Settings", path: "/settings" }),
			]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAliasAction("CLOSE_VIEW", {
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close settings") as never,
			undefined,
			{ target: "settings" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			viewId: "settings",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/settings/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close", alwaysOnTop: false }),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
		expect(client.getCurrentView).not.toHaveBeenCalled();
	});

	it('treats VIEWS action=delete for "close all views" as close-all, not plugin deletion', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close all views") as never,
			undefined,
			{ action: "delete", mode: "delete", confirm: true },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			scope: "all",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/__all__/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close-all", alwaysOnTop: false }),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it('treats action=delete for "close calendar view" as non-destructive close', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [
				view({ id: "calendar", label: "Calendar", path: "/calendar" }),
			]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAction({
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close the calendar view") as never,
			undefined,
			{ action: "delete", mode: "delete", view: "calendar", confirm: true },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			viewId: "calendar",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close", alwaysOnTop: false }),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
		expect(client.getCurrentView).not.toHaveBeenCalled();
	});

	it('resolves structured target aliases like "notepad" and "calender" for view navigation', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad", "sticky-notes"],
					}),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
						tags: ["chat", "home"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({}),
		} as Response);

		const notesResult = await action.handler(
			runtime as never,
			message("open the notepad pls") as never,
			undefined,
			{ action: "show", view: "notepad" },
			callback,
		);
		const calendarResult = await action.handler(
			runtime as never,
			message("open the calender view") as never,
			undefined,
			{ action: "show", view: "calender" },
			callback,
		);
		const homeResult = await action.handler(
			runtime as never,
			message(composedViewPrompt("go home")) as never,
			undefined,
			{ action: "show", view: "home", mode: "simple" },
			callback,
		);

		expect(notesResult?.success).toBe(true);
		expect(notesResult?.values).toMatchObject({
			mode: "show",
			viewId: "notes",
		});
		expect(calendarResult?.success).toBe(true);
		expect(calendarResult?.values).toMatchObject({
			mode: "show",
			viewId: "calendar",
		});
		expect(homeResult?.success).toBe(true);
		expect(homeResult?.values).toMatchObject({
			mode: "show",
			viewId: "chat",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({ method: "POST" }),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/navigate",
			expect.objectContaining({ method: "POST" }),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("opens the plugins page from plugin-browser aliases", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
						tags: [
							"plugins",
							"plugin-browser",
							"plugin browser",
							"plugin-manager",
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("open plugin browser") as never,
			undefined,
			{ action: "open", view: "plugin-browser" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "show",
			viewId: "plugins-page",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("dispatches generated capability action names through the registered view catalog", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "note wall", "sticky notes"],
						capabilities: [
							{
								id: "create-note",
								description: "Create a sticky note.",
								params: {
									title: { type: "string", description: "Note title." },
									body: { type: "string", description: "Note body." },
								},
							},
							{
								id: "get-notes",
								description: "Return all sticky notes as structured data.",
								params: {
									title: {
										type: "string",
										description: "Optional exact note title.",
									},
								},
							},
							{
								id: "delete-note",
								description: "Delete one sticky note by id, title, or query.",
								params: {
									id: { type: "string", description: "Note id." },
									title: {
										type: "string",
										description: "Exact note title.",
									},
									query: {
										type: "string",
										description: "Title/body search query.",
									},
									name: {
										type: "string",
										description: "Alias for title or query.",
									},
								},
							},
							{
								id: "list-elements",
								description: "List mounted view elements.",
							},
						],
					}),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "events"],
						capabilities: [
							{
								id: "get-calendar-state",
								description:
									"Return selected date and all calendar events as structured data.",
								params: {
									date: {
										type: "string",
										description: "Optional YYYY-MM-DD date filter.",
									},
									title: {
										type: "string",
										description: "Optional exact event title.",
									},
								},
							},
							{
								id: "get-calendar-event",
								description:
									"Read one calendar event by exact title or unique query.",
								params: {
									title: {
										type: "string",
										description: "Exact event title.",
									},
								},
							},
							{
								id: "create-calendar-event",
								description: "Create a calendar event.",
								params: {
									title: { type: "string", description: "Event title." },
									date: {
										type: "string",
										description: "Date in YYYY-MM-DD format.",
									},
									time: { type: "string", description: "Time label." },
								},
							},
							{
								id: "select-calendar-date",
								description: "Select one calendar date.",
								params: {
									date: {
										type: "string",
										description: "Selected YYYY-MM-DD date.",
										required: true,
									},
								},
							},
							{
								id: "update-calendar-event",
								description: "Update a calendar event by exact title.",
								params: {
									oldTitle: {
										type: "string",
										description: "Current exact title.",
									},
									title: {
										type: "string",
										description: "Replacement title.",
									},
									time: {
										type: "string",
										description: "Replacement time.",
									},
									details: {
										type: "string",
										description: "Replacement details.",
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { text: "Created.", success: true },
			}),
		} as Response);

		const noteResult = await action.handler(
			runtime as never,
			message("create note") as never,
			undefined,
			{
				action: "CREATE_NOTE",
				title: "smoke note",
				body: "created from routing",
			},
			callback,
		);
		const plannerCreateResult = await action.handler(
			runtime as never,
			message(
				"create a note titled smoke note with body created from routing",
			) as never,
			undefined,
			{
				action: "create",
				view: "smoke note",
				intent: "Note titled smoke note with body created from routing.",
			},
			callback,
		);
		const showNotesResult = await action.handler(
			runtime as never,
			message("show me my notes") as never,
			undefined,
			{ action: "show", view: "notes" },
			callback,
		);
		const listNotesAliasResult = await action.handler(
			runtime as never,
			message("show me my notes") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "list-notes" },
			callback,
		);
		const readNamedNoteResult = await action.handler(
			runtime as never,
			message('read the note titled "launch checklist"') as never,
			undefined,
			{ action: "interact", view: "notes", capability: "get-notes" },
			callback,
		);
		const deleteNoteResult = await action.handler(
			runtime as never,
			message("delete note") as never,
			undefined,
			{ action: "DELETE_NOTE", id: "note-123" },
			callback,
		);
		const deleteNoteByTextResult = await action.handler(
			runtime as never,
			message("delete the nubby note") as never,
			undefined,
			{ action: "delete" },
			callback,
		);
		const createNoteFromMessageResult = await action.handler(
			runtime as never,
			message(
				"can you make another one saying i need to wake up at 3am",
			) as never,
			undefined,
			{ action: "create" },
			callback,
		);
		const currentElementsResult = await action.handler(
			runtime as never,
			message("list elements in the current view") as never,
			undefined,
			{ action: "interact", capability: "list-elements" },
			callback,
		);
		const calendarResult = await action.handler(
			runtime as never,
			message("add a calendar event") as never,
			undefined,
			{ action: "CALENDAR_CREATE_EVENT", title: "smoke event" },
			callback,
		);
		const plannerCalendarResult = await action.handler(
			runtime as never,
			message("add a calendar event titled smoke event") as never,
			undefined,
			{
				action: "create",
				view: "calendar",
				intent: "Create event titled smoke event on 2026-06-08 at 17:00",
			},
			callback,
		);
		const explicitCapabilityWordingCalendarResult = await action.handler(
			runtime as never,
			message("create calendar event through the VIEWS capability") as never,
			undefined,
			{
				action: "create",
				view: "calendar",
				intent:
					"Create calendar event through the VIEWS capability titled routed event on 2026-06-09 at 12:00",
			},
			callback,
		);
		const camelCalendarResult = await action.handler(
			runtime as never,
			message("add a calendar event titled smoke event") as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "createEvent",
				params: {
					title: "camel event",
					date: "2026-06-08",
					time: "18:00",
				},
			},
			callback,
		);
		const listEventsResult = await action.handler(
			runtime as never,
			message("show today's calendar events") as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "list-events",
				params: { date: "2026-06-08" },
			},
			callback,
		);
		const updateNamedEventResult = await action.handler(
			runtime as never,
			message(
				'<contextual_documents>create calendar examples</contextual_documents><user_request>update the event titled "team sync" and rename it to investor sync</user_request>',
			) as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "create-calendar-event",
				params: {
					title: "investor sync",
					time: "14:15",
					details: "updated agenda",
				},
			},
			callback,
		);
		const selectedCalendarReadResult = await action.handler(
			runtime as never,
			message(
				"<contextual_documents>create calendar examples</contextual_documents><user_request>select 2026-08-09 in the calendar</user_request>",
			) as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "get-calendar-state",
			},
			callback,
		);
		const readNamedEventResult = await action.handler(
			runtime as never,
			message(
				'<contextual_documents>create calendar examples</contextual_documents><user_request>read only the calendar event titled "team sync"</user_request>',
			) as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "create-calendar-event",
				params: { title: "team sync" },
			},
			callback,
		);

		expect(noteResult?.success).toBe(true);
		expect(noteResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(plannerCreateResult?.success).toBe(true);
		expect(plannerCreateResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(showNotesResult?.success).toBe(true);
		expect(showNotesResult?.values).toMatchObject({
			mode: "show",
			viewId: "notes",
		});
		expect(listNotesAliasResult).toMatchObject({
			success: false,
			text: expect.stringContaining('Cannot invoke capability "list-notes"'),
		});
		expect(readNamedNoteResult?.success).toBe(true);
		expect(deleteNoteResult?.success).toBe(true);
		expect(deleteNoteResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "delete-note",
		});
		expect(deleteNoteByTextResult?.success).toBe(true);
		expect(deleteNoteByTextResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "delete-note",
		});
		expect(createNoteFromMessageResult?.success).toBe(true);
		expect(createNoteFromMessageResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(currentElementsResult?.success).toBe(true);
		expect(currentElementsResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "list-elements",
		});
		expect(calendarResult?.success).toBe(true);
		expect(calendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(plannerCalendarResult?.success).toBe(true);
		expect(plannerCalendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(explicitCapabilityWordingCalendarResult?.success).toBe(true);
		expect(explicitCapabilityWordingCalendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(camelCalendarResult).toMatchObject({
			success: false,
			text: expect.stringContaining('Cannot invoke capability "createEvent"'),
		});
		expect(listEventsResult).toMatchObject({
			success: false,
			text: expect.stringContaining('Cannot invoke capability "list-events"'),
		});
		expect(updateNamedEventResult?.success).toBe(true);
		expect(selectedCalendarReadResult?.success).toBe(true);
		expect(selectedCalendarReadResult?.values?.capability).toBe(
			"get-calendar-state",
		);
		expect(readNamedEventResult?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: {
						title: "smoke note",
						body: "created from routing",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-notes",
					params: { title: "launch checklist" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: {
						title: "smoke note",
						body: "created from routing.",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { query: "nubby", ownerText: "delete the nubby note" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: { body: "i need to wake up at 3am" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).not.toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-notes",
					params: undefined,
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { id: "note-123", ownerText: "delete note" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "list-elements",
					params: undefined,
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: { title: "smoke event" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "smoke event",
						date: "2026-06-08",
						time: "17:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "routed event",
						date: "2026-06-09",
						time: "12:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).not.toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "camel event",
						date: "2026-06-08",
						time: "18:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).not.toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-calendar-state",
					params: { date: "2026-06-08" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "update-calendar-event",
					params: {
						title: "investor sync",
						time: "14:15",
						details: "updated agenda",
						oldTitle: "team sync",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-calendar-state",
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-calendar-event",
					params: { title: "team sync" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("keeps an explicit agent-fill capability ahead of semantic view aliases", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "create-note",
								description: "Create a sticky note.",
								params: {
									title: { type: "string", description: "Note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { text: "Filled.", success: true },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("create a new note to eat lunch") as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "agent-fill",
				params: { id: "notes-title", value: "Eat Lunch" },
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "agent-fill",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "agent-fill",
					params: { id: "notes-title", value: "Eat Lunch" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("uses query (contained-text) for a free-form quoted delete target", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		// Capability declares both title and query, matching the real Notes
		// contract from plugin-notes/src/capabilities.ts. Free-form text must
		// NOT collapse onto the destructive title selector (#18377).
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "delete-note",
								description:
									"Delete one note by stable id, exact first-line label, or unique contained text.",
								params: {
									id: {
										type: "string",
										description: "Stable note id.",
										required: false,
										minLength: 3,
										maxLength: 128,
									},
									query: {
										type: "string",
										description: "Unique text contained anywhere in the note.",
										minLength: 1,
										maxLength: 20_000,
									},
									title: {
										type: "string",
										description:
											"Exact first-line label of a note to identify it. Must match a known note label exactly.",
										minLength: 1,
										maxLength: 240,
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted note." },
			}),
		} as Response);

		const noteText = "Demo proof note: Notes now use one clean content field.";
		const ownerText = `Delete the note "${noteText}"`;
		const result = await action.handler(
			runtime as never,
			message(ownerText) as never,
			undefined,
			{ action: "delete", view: "note-76237299" },
			callback,
		);

		expect(result?.success).toBe(true);
		// Free-form quoted text must resolve to query (safe contained-text
		// search), NOT title (destructive exact-label match).
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { query: noteText, ownerText },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("uses title for an explicit titled delete target", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "delete-note",
								description:
									"Delete one note by stable id, exact first-line label, or unique contained text.",
								params: {
									id: {
										type: "string",
										description: "Stable note id.",
										required: false,
										minLength: 3,
										maxLength: 128,
									},
									query: {
										type: "string",
										description: "Unique text contained anywhere in the note.",
										minLength: 1,
										maxLength: 20_000,
									},
									title: {
										type: "string",
										description:
											"Exact first-line label of a note to identify it. Must match a known note label exactly.",
										minLength: 1,
										maxLength: 240,
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted note." },
			}),
		} as Response);

		const label = "Shopping List";
		const ownerText = `Delete the note named "${label}"`;
		// Pass explicit capability + title params to exercise the
		// interact transport with an explicit title. The derivation logic
		// (extractReferencedTitle → title, free-form → query) is verified
		// by the plugin-notes backend tests.
		const result = await action.handler(
			runtime as never,
			message(ownerText) as never,
			undefined,
			{
				action: "interact",
				view: "notes",
				capability: "delete-note",
				params: { title: label },
			},
			callback,
		);

		expect(result?.success).toBe(true);
		// Explicit title param must produce a title selector, NOT query.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { title: label, ownerText },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("derives title from smart-quoted named delete via NL derivation", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "delete-note",
								description:
									"Delete one note by stable id, exact first-line label, or unique contained text.",
								params: {
									id: {
										type: "string",
										description: "Stable note id.",
										required: false,
										minLength: 3,
										maxLength: 128,
									},
									query: {
										type: "string",
										description: "Unique text contained anywhere in the note.",
										minLength: 1,
										maxLength: 20_000,
									},
									title: {
										type: "string",
										description:
											"Exact first-line label of a note to identify it. Must match a known note label exactly.",
										minLength: 1,
										maxLength: 240,
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted note." },
			}),
		} as Response);

		const label = "Shopping List";
		const ownerText = `Delete the note named “${label}”`;
		const result = await action.handler(
			runtime as never,
			message(ownerText) as never,
			undefined,
			{ action: "delete", view: "notes" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { title: label, ownerText },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("uses query for an unquoted free-form delete target", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "delete-note",
								description:
									"Delete one note by stable id, exact first-line label, or unique contained text.",
								params: {
									query: {
										type: "string",
										description: "Unique text contained anywhere in the note.",
										minLength: 1,
										maxLength: 20_000,
									},
									title: {
										type: "string",
										description:
											"Exact first-line label of a note to identify it. Must match a known note label exactly.",
										minLength: 1,
										maxLength: 240,
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted note." },
			}),
		} as Response);

		const target = "meeting notes from last week";
		const ownerText = `Delete ${target}`;
		const result = await action.handler(
			runtime as never,
			message(ownerText) as never,
			undefined,
			{ action: "delete", view: "note-76237299" },
			callback,
		);

		expect(result?.success).toBe(true);
		// Unquoted free-form text must resolve to query.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { query: target, ownerText },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("does not rewrite an explicit delete-note from incidental read-family words (#18386)", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted." },
			}),
		} as Response);

		// "Delete the current note titled GAUSS NOTES QA" contains the
		// read-family word "current", which previously caused the explicit
		// delete-note to be rewritten to get-note. The planner declared
		// delete-note explicitly; the incidental read word must not override it.
		const ownerText = "Delete the current note titled GAUSS NOTES QA";
		const result = await action.handler(
			runtime as never,
			message(ownerText) as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { title: "GAUSS NOTES QA", ownerText },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("does NOT escalate read→delete even when the request family has only delete tokens (#18386 P1)", async () => {
		// NubsCarson Blocking 1: the correction path must never lexically
		// escalate read→delete. Even when the planner selected get-note
		// (read) and the message says "delete" with zero read-family
		// words, the correction must NOT rewrite to delete-note — silent
		// upgrade destroys data. The original capability is preserved.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Note retrieved." },
			}),
		} as Response);

		// Planner selected get-note (read). Message says "delete" but the
		// correction path must NOT escalate to delete-note.
		const result = await action.handler(
			runtime as never,
			message("Delete note titled GAUSS MARKER") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "get-note" },
			callback,
		);

		expect(result?.success).toBe(true);
		// The fetch must invoke get-note (the planner's original selection),
		// NOT delete-note. Read→delete escalation is prohibited.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"get-note"'),
			}),
		);
	});

	it("preserves a destructive capability when read-family words coexist affirmatively (#18386)", async () => {
		// This documents the affirmative multi-action case: mixed-family
		// overlap preserves the planner's explicit selection. If the planner
		// selected delete-note and the request says "show then delete",
		// the "show" (read) token does not cause a rewrite to get-note.
		// True negation is covered by adversarial tests below.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "sticky notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: {
										type: "string",
										description: "Exact note title.",
									},
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted." },
			}),
		} as Response);

		// Both "show" (read) and "delete" (delete) families present.
		// The planner selected delete-note. The correction function must
		// NOT rewrite it to get-note. This is the affirmative multi-action
		// case — negation is tested separately below.
		const result = await action.handler(
			runtime as never,
			message("Show the current note then delete note titled X") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"delete-note"'),
			}),
		);
	});

	// ── Negation gate + planner-authority coverage (#18386 P1) ──────
	// The lexical veto over the planner is deliberately narrow: only a
	// genuinely negated destructive verb ("do not delete", "never
	// delete") is refused, with zero fetch/mutation. Polite imperatives
	// ("Could you delete note X") and non-English requests keep the
	// planner's explicit selection — the planner is the semantic
	// authority. Read→delete lexical escalation stays prohibited.
	// ────────────────────────────────────────────────────────────────

	it("rejects negated destructive request with zero fetch/mutation (#18386 P1)", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// "do not delete" — the negation must prevent destructive authority.
		const result = await action.handler(
			runtime as never,
			message("Show the current note; do not delete note titled X") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toContain("Refusing destructive capability");
		// Zero fetch — no mutation request was sent.
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("executes a polite-imperative delete ('Could you delete note X') without refusal (#18386 P1)", async () => {
		// Modal/conditional words ("could", "would", "when") are NOT
		// negation — a polite imperative is an affirmative delete request.
		// The earlier full-backward conditional scan refused these; the
		// narrowed gate must let the planner's explicit selection execute.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted." },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("Could you delete note X") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"delete-note"'),
			}),
		);
	});

	it("preserves the planner's explicit delete selection for non-English input (#18386 P1)", async () => {
		// Non-English input yields no lexical operation-family tokens. The
		// LLM planner already understood the request and explicitly selected
		// delete-note; the lexical layer has no evidence to override it, so
		// the selection executes. (An earlier fail-closed rejection here
		// broke every non-English delete request.)
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Deleted." },
			}),
		} as Response);

		// "Please delete note X" in Japanese — no English family tokens.
		const result = await action.handler(
			runtime as never,
			message("メモXを削除してください") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"delete-note"'),
			}),
		);
	});

	it("never lexically escalates read→delete from read-family + incidental delete wording (#18386 P1)", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { success: true, text: "Note retrieved." },
			}),
		} as Response);

		// Planner selected get-note (read). The message contains "delete"
		// as incidental wording ("show me the note, not delete"). The
		// correction path must NOT escalate read→delete.
		const result = await action.handler(
			runtime as never,
			message("Show me the note titled X, not delete it") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "get-note" },
			callback,
		);

		// The fetch must invoke get-note, NOT delete-note.
		expect(result?.success).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"get-note"'),
			}),
		);
		expect(globalThis.fetch).not.toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"capability":"delete-note"'),
			}),
		);
	});

	it("rejects destructive capability when multi-clause negation appears (#18386 P1)", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes"],
						capabilities: [
							{
								id: "get-note",
								description: "Read one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
							{
								id: "delete-note",
								description: "Delete one note by title or query.",
								params: {
									title: { type: "string", description: "Exact note title." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// Multi-clause: "Show the note; never delete it" — the "never"
		// negation within 3 tokens of "delete" must trigger rejection.
		const result = await action.handler(
			runtime as never,
			message("Show the note; never delete it") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toContain("Refusing destructive capability");
		expect(globalThis.fetch).not.toHaveBeenCalled();

		// Contracted negation: "don't delete" tokenizes as "dont" after
		// apostrophe stripping and must also refuse with zero mutation.
		const contracted = await action.handler(
			runtime as never,
			message("Show the note, don't delete it") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "delete-note" },
			callback,
		);

		expect(contracted?.success).toBe(false);
		expect(contracted?.text).toContain("Refusing destructive capability");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("summarizes structured interaction results without dumping JSON into chat", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
						capabilities: [
							{
								id: "get-state",
								description: "Read settings state.",
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { theme: "dark", language: "en" },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("get the state of settings") as never,
			undefined,
			{ action: "interact", view: "settings", capability: "get-state" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "settings",
			capability: "get-state",
		});
		expect(callback).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			transcriptVisibility: "internal",
			modelReplyRequired: true,
			turnComplete: false,
			data: { result: { theme: "dark", language: "en" } },
		});
		expect(result).not.toHaveProperty("userFacingText");
	});

	it('splits a single mentioned view "next to" the current view', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("splits a placed view against the current view for incremental layout requests", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("and calender on the right") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it("uses placement orientation over stale generated capability options for placement follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
						capabilities: [
							{
								id: "create-calendar-event",
								description: "Create a calendar event.",
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("and calender on the right") as never,
			undefined,
			{
				action: "create-calendar-event",
				view: "calendar",
				layout: "vertical",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.continueChain).not.toBe(false);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it("reuses current split views for layout-only split follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			{
				action: "split",
				layout: "vertical",
				views: ["notes", "plugins-page", "calendar"],
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("reuses current split views for text-only layout follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("reuses current split views when planner supplies a filtered view type", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const listViews = vi.fn(async (options?: { viewType?: string }) =>
			options?.viewType === "tui"
				? []
				: [
						view({
							id: "plugins-page",
							label: "Plugins",
							path: "/apps/plugins",
						}),
						view({ id: "calendar", label: "Calendar", path: "/calendar" }),
					],
		);
		const action = createViewsAction({
			client: {
				listViews,
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			{
				action: "split",
				layout: "vertical",
				viewType: "tui",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(listViews).toHaveBeenCalledWith({ viewType: "tui" });
		expect(listViews).toHaveBeenCalledWith();
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("places a single current view without retrying split failures", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("i want notes to be on left of screen") as never,
			undefined,
			{ action: "create" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes"],
			layout: "horizontal",
			placement: "left",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes"],
					layout: "horizontal",
					placement: "left",
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("treats explicit create cancel as terminal even if the pending task is gone", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const appClient = {
			listInstalledApps: vi.fn(async () => []),
		};

		const appResult = await runCreate({
			runtime: runtime as never,
			client: appClient as never,
			message: message("Cancel the app create flow") as never,
			options: { action: "create", choice: "cancel" },
			callback,
			repoRoot: "/tmp/no-app-create",
		});

		expect(appResult.success).toBe(true);
		expect(appResult.values).toMatchObject({
			mode: "create",
			subMode: "cancel",
		});
		expect(appClient.listInstalledApps).not.toHaveBeenCalled();
		expect(runtime.createTask).not.toHaveBeenCalled();

		const viewResult = await runViewsCreate({
			runtime: runtime as never,
			message: message("Cancel the view create flow") as never,
			options: { action: "create", choice: "cancel" },
			views: [view()],
			callback,
			repoRoot: "/tmp/no-view-create",
		});

		expect(viewResult.success).toBe(true);
		expect(viewResult.values).toMatchObject({
			mode: "create",
			subMode: "cancel",
		});
		expect(runtime.createTask).not.toHaveBeenCalled();
	});

	it("surfaces invalid APP create continuations without fabricating a dispatch", async () => {
		const callback = vi.fn();
		const appClient = { listInstalledApps: vi.fn(async () => []) };
		const emptyRuntime = createRuntime().runtime;

		const empty = await runCreate({
			runtime: emptyRuntime as never,
			client: appClient as never,
			message: message("") as never,
			callback,
			repoRoot: "/tmp/no-app-create",
		});
		expect(empty).toMatchObject({
			success: false,
			text: "Tell me what app you want to build.",
		});
		expect(appClient.listInstalledApps).not.toHaveBeenCalled();

		const missingTarget = await runCreate({
			runtime: emptyRuntime as never,
			client: appClient as never,
			message: message("Update the missing app") as never,
			options: { action: "create", editTarget: "missing" },
			callback,
			repoRoot: "/tmp/no-app-create",
		});
		expect(missingTarget).toMatchObject({
			success: false,
			text: 'Cannot find an installed app matching "missing".',
		});

		const pendingTasks: RuntimeTask[] = [
			{
				id: "pending-app-create",
				agentId: "agent-1",
				tags: [APP_CREATE_INTENT_TAG],
				metadata: {
					roomId: "room-1",
					intent: "Update proof app",
					intentCreatedAt: "2026-07-13T00:00:00.000Z",
					choices: [{ key: "edit-1", label: "Edit proof app" }],
				},
			},
		];
		const pendingRuntime = createRuntime({ tasks: pendingTasks }).runtime;
		callback.mockClear();
		const lostTarget = await runCreate({
			runtime: pendingRuntime as never,
			client: appClient as never,
			message: message("edit-1") as never,
			callback,
			repoRoot: "/tmp/no-app-create",
		});
		expect(lostTarget).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: { error: "CREATE_CHOICE_TARGET_INVALID" },
		});
		expect(pendingRuntime.deleteTask).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
		expect(emptyRuntime.actions[0]?.handler).not.toHaveBeenCalled();
	});

	it("keeps an APP edit task in its chat room with bounded verification retries", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-proof-app");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();
			const appClient = {
				listInstalledApps: vi.fn(async () => [
					{
						name: "proof-app",
						displayName: "Proof App",
						pluginName: "@local/plugin-proof-app",
						version: "1.0.0",
						installedAt: "2026-07-13T00:00:00.000Z",
					},
				]),
			};

			const result = await runCreate({
				runtime: runtime as never,
				client: appClient as never,
				message: message("Update the proof app", "origin-app-room") as never,
				options: {
					action: "create",
					editTarget: "proof-app",
					intent: "Replace the proof marker and rebuild.",
				},
				callback: vi.fn(),
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				mode: "create",
				subMode: "edit",
				name: "proof-app",
				workdir: pluginDir,
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(codingHandler.mock.calls[0][1]).toMatchObject({
				roomId: "origin-app-room",
			});
			const handlerOptions = codingHandler.mock.calls[0][3] as {
				parameters: Record<string, unknown>;
			};
			expect(handlerOptions.parameters.metadata).toMatchObject({
				originRoomId: "origin-app-room",
				parentTrajectoryStepId: "parent-step-1",
				trajectoryLinkSource: "plugin-app-control:app-create",
			});
			expect(handlerOptions.parameters).toMatchObject({
				workdir: pluginDir,
				lockWorkdir: true,
				keepAliveAfterComplete: true,
				maxRetries: 2,
				onVerificationFail: "retry",
				validator: {
					service: "app-verification",
					method: "verifyApp",
					params: {
						workdir: pluginDir,
						appName: "proof-app",
						profile: "full",
					},
				},
			});
		} finally {
			repo.cleanup();
		}
	});

	it("returns create choice blocks as verified user-facing payloads", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const appClient = {
			listInstalledApps: vi.fn(async () =>
				Array.from({ length: 7 }, (_, index) => ({
					name: `notes-${index + 1}`,
					displayName: `Notes ${index + 1}`,
					pluginName: `@local/app-notes-${index + 1}`,
				})),
			),
		};

		const appResult = await runCreate({
			runtime: runtime as never,
			client: appClient as never,
			message: message("Create a notes app for me") as never,
			callback,
			repoRoot: "/tmp/no-app-create",
		});

		expect(appResult).toMatchObject({
			success: true,
			text: expect.stringContaining("[CHOICE:app-create"),
			userFacingText: expect.stringContaining("[CHOICE:app-create"),
			verifiedUserFacing: true,
			values: { mode: "create", subMode: "choice", matchCount: 7 },
		});
		expect(appResult.text).toContain("cancel = Cancel");
		expect(appResult.text).toContain("edit-7 = Edit existing: Notes 7");

		const matchingViews = Array.from({ length: 7 }, (_, index) => ({
			...view(),
			id: `remote-ledger-${index + 1}`,
			label: `Remote Ledger ${index + 1}`,
			pluginName: `@local/plugin-remote-ledger-${index + 1}`,
		}));

		const viewResult = await runViewsCreate({
			runtime: runtime as never,
			message: message("create a remote ledger view") as never,
			views: matchingViews,
			callback,
			repoRoot: "/tmp/no-view-create",
		});

		expect(viewResult).toMatchObject({
			success: true,
			text: expect.stringContaining("[CHOICE:views-create"),
			userFacingText: expect.stringContaining("[CHOICE:views-create"),
			verifiedUserFacing: true,
			values: { mode: "create", subMode: "choice", matchCount: 7 },
		});
		expect(viewResult.text).toContain("cancel = Cancel");
		expect(viewResult.text).toContain(
			"edit-7 = Edit existing: Remote Ledger 7",
		);
	});
});
