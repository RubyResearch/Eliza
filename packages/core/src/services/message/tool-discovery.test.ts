/** Tests complete, permission-scoped schema loading without any live domain effects. */
import { describe, expect, it } from "vitest";
import { buildPlannerToolsFromActions } from "../../actions/to-tool";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { documentAction } from "../../features/documents/actions";
import { AgentRuntime } from "../../runtime";
import type { Action } from "../../types/components";
import type { ContextObject } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import { collectV5PlannerCandidateActions } from "./action-surface";
import {
	collectBudgetedStageOneCandidateActions,
	collectPlannerTools,
} from "./planned-tool";
import {
	appendDiscoveredPlannerTools,
	collectDiscoveryCatalogActions,
	createPlannerToolDiscoveryAction,
} from "./tool-discovery";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

describe("planner tool discovery", () => {
	it.each(["USER", "GUEST"] as const)(
		"admits observed document hints through canonical role gates for %s",
		async (role) => {
			const actualRuntime = new AgentRuntime({
				character: { name: "Document admission", bio: "test" },
				adapter: new InMemoryDatabaseAdapter(),
				logLevel: "fatal",
			});
			actualRuntime.actions.length = 0;
			actualRuntime.actions.push({
				name: "DOCUMENT",
				similes: documentAction.similes,
				description: "Stored documents",
				contexts: ["documents"],
				contextGate: { anyOf: ["documents"] },
				roleGate: { minRole: "USER" },
			});
			for (const hint of [
				"DOCUMENTS_READ",
				"DOCUMENTS_SEARCH",
				"DOCS_READ",
				"DOCS_SEARCH",
			]) {
				const admitted = await collectV5PlannerCandidateActions({
					runtime: actualRuntime,
					message,
					state: { values: {}, data: {}, text: "" },
					selectedContexts: ["documents"],
					candidateActions: [hint],
					userRoles: [role],
				});
				const initial = collectBudgetedStageOneCandidateActions({
					actions: admitted,
					candidateActions: [hint],
					contexts: ["documents"],
					deferUnselectedContexts: true,
				});
				expect(initial.map((action) => action.name)).toEqual(
					role === "USER" ? ["DOCUMENT"] : [],
				);
			}
		},
	);

	it("defers a parent beside an exact child but loads its complete contract on discovery", async () => {
		const actions: Action[] = [
			{
				name: "VIEWS",
				description: "Layouts and arbitrary view capabilities",
				subActions: ["VIEWS_SHOW"],
				toolSchemaStrict: false,
				allowAdditionalParameters: true,
				parameters: [
					{
						name: "params",
						description: "Complete capability arguments",
						required: false,
						schema: { type: "object", additionalProperties: true },
					},
				],
			},
			{
				name: "VIEWS_SHOW",
				description: "Open one view",
				toolSchemaStrict: true,
			},
			{ name: "NOTES_LIST", description: "Read notes", toolSchemaStrict: true },
		];
		const initial = collectBudgetedStageOneCandidateActions({
			actions,
			candidateActions: ["VIEWS", "VIEWS_SHOW", "NOTES_LIST"],
			contexts: [],
			deferUnselectedContexts: true,
			deferParentHints: true,
		});
		expect(initial).toEqual(actions.slice(1));
		const context: ContextObject = {
			id: "turn",
			events: initial.map((tool) => ({ id: tool.name, type: "tool", tool })),
		};
		const tools = collectPlannerTools(context, initial);
		expect(tools.map((tool) => tool.name)).toEqual([
			"VIEWS_SHOW",
			"NOTES_LIST",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(tools.every((tool) => tool.strict === true)).toBe(true);
		const before = structuredClone(tools);
		const discovery = createPlannerToolDiscoveryAction(actions, (loaded) => {
			appendDiscoveredPlannerTools(context, tools, loaded);
		});
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["VIEWS", "VIEWS_SHOW"] },
		});
		expect(result?.success).toBe(true);
		expect(tools).toEqual([
			...before,
			...buildPlannerToolsFromActions([actions[0]]),
		]);
		// A parent-only hint still requests the full family immediately. The
		// projection is not applied to legacy callers without discovery either.
		for (const options of [
			{ candidateActions: ["VIEWS"], deferUnselectedContexts: true },
			{
				candidateActions: ["VIEWS", "VIEWS_SHOW"],
				deferUnselectedContexts: false,
			},
		]) {
			expect(
				collectBudgetedStageOneCandidateActions({
					actions,
					contexts: [],
					deferParentHints: true,
					...options,
				}),
			).toEqual(actions.slice(0, 2));
		}
	});
	it.each([
		["VIEWS_SHOW", "CALENDAR_SHOW", "NOTES_LIST", "NOTES_GET"],
		["VIEWS_SHOW", "NOTES_LIST", "READ_UNKNOWN_RECORD"],
	])(
		"defers unregistered hints instead of guessing a broad tool: %j",
		async (...candidates) => {
			const actions: Action[] = [
				{
					name: "VIEWS",
					description: "Layouts and view capabilities",
					similes: ["SPLIT_VIEWS"],
					subActions: ["VIEWS_SHOW"],
					toolSchemaStrict: false,
				},
				{
					name: "VIEWS_SHOW",
					description: "Open one view",
					toolSchemaStrict: true,
				},
				{
					name: "NOTES_LIST",
					description: "Read notes",
					toolSchemaStrict: true,
				},
			];
			const select = (names: string[]) =>
				collectBudgetedStageOneCandidateActions({
					actions,
					candidateActions: names,
					contexts: [],
					deferUnselectedContexts: true,
				});
			const initial = select(candidates);
			expect(initial.map((a) => a.name)).toEqual(["VIEWS_SHOW", "NOTES_LIST"]);
			expect(
				buildPlannerToolsFromActions(initial).every(
					(tool) => tool.strict === true,
				),
			).toBe(true);
			// Registered names and declared aliases still carry their actual contract.
			expect(select(["VIEWS", "NOTES_LIST"])).toEqual(actions);
			expect(select(["SPLIT_VIEWS", "NOTES_LIST"])).toEqual(actions);
			expect(select(["LIST_NOTES"])).toEqual([actions[2]]);
			// Unknown-only hints are resolved through the same complete discovery catalog.
			expect(select(["CALENDAR_SHOW", "NOTES_GET"])).toEqual([]);
			let loaded: Action[] = [];
			const discovery = createPlannerToolDiscoveryAction(actions, (next) => {
				loaded = next;
			});
			const result = await discovery.handler?.(runtime, message, undefined, {
				parameters: { names: ["VIEWS"] },
			});
			expect(result?.success).toBe(true);
			expect(loaded).toEqual(actions.slice(0, 2));
		},
	);
	it("does not guess between ambiguous reordered action names", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [
					{ name: "GET_CURRENT_NOTE", description: "First operation" },
					{ name: "NOTE_GET_CURRENT", description: "Second operation" },
				],
				candidateActions: ["CURRENT_NOTE_GET"],
				contexts: [],
				deferUnselectedContexts: true,
			}),
		).toEqual([]);
	});
	it("starts with exact child hints, retaining other operations through explicit discovery", async () => {
		const actions: Action[] = [
			{
				name: "NOTES",
				description: "Note operations",
				subActions: ["NOTES_CREATE", "NOTES_LIST", "NOTES_DELETE"],
			},
			{ name: "NOTES_CREATE", description: "Create a note" },
			{ name: "NOTES_LIST", description: "Read notes" },
			{ name: "NOTES_DELETE", description: "Delete a note" },
		];
		const initial = collectBudgetedStageOneCandidateActions({
			actions,
			candidateActions: ["NOTES_CREATE"],
			contexts: [],
			deferUnselectedContexts: true,
		});
		expect(initial.map((a) => a.name)).toEqual(["NOTES_CREATE"]);
		const compound = collectBudgetedStageOneCandidateActions({
			actions,
			candidateActions: ["NOTES_CREATE", "NOTES_LIST"],
			contexts: [],
			deferUnselectedContexts: true,
		});
		expect(compound.map((a) => a.name)).toEqual(["NOTES_CREATE", "NOTES_LIST"]);
		let loaded: Action[] = [];
		const discovery = createPlannerToolDiscoveryAction(actions, (next) => {
			loaded = next;
		});
		expect(discovery.description).toContain("NOTES_LIST");
		const context: ContextObject = {
			id: "turn",
			events: [{ id: "notes-create", type: "tool", tool: actions[1] }],
		};
		const tools = collectPlannerTools(context, initial);
		const before = structuredClone(tools);
		const repeated = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["NOTES_CREATE"] },
		});
		expect(repeated?.success).toBe(true);
		appendDiscoveredPlannerTools(context, tools, loaded);
		expect(tools).toEqual(before);
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["NOTES_LIST"] },
		});
		expect(result?.success).toBe(true);
		expect(loaded).toEqual([actions[2]]);
		appendDiscoveredPlannerTools(context, tools, loaded);
		expect(tools).toEqual([
			...before,
			...buildPlannerToolsFromActions([actions[2]]),
		]);
		const family = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["NOTES"] },
		});
		expect(family?.success).toBe(true);
		expect(loaded).toEqual(actions);
		// Legacy callers and explicit parent requests retain complete families.
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["NOTES"],
				contexts: [],
				deferUnselectedContexts: true,
			}),
		).toEqual(actions);
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["NOTES_CREATE"],
				contexts: [],
			}),
		).toEqual(actions);
	});
	it.each(["ADMIN", "USER"] as const)(
		"re-admits a requested domain with canonical gates for %s",
		async (role) => {
			const actualRuntime = new AgentRuntime({
				character: { name: "Discovery gates", bio: "test" },
				adapter: new InMemoryDatabaseAdapter(),
				logLevel: "fatal",
			});
			actualRuntime.actions.length = 0;
			const notes: Action = {
				name: "NOTES",
				description: "Owner notes",
				contexts: ["notes"],
				contextGate: { anyOf: ["notes"] },
				roleGate: { minRole: "ADMIN" },
				subActions: ["NOTES_READ"],
			};
			actualRuntime.actions.push(
				{ name: "CALENDAR", description: "Calendar", contexts: ["calendar"] },
				notes,
				{ ...notes, name: "NOTES_READ", subActions: undefined },
				{
					...notes,
					name: "PRIVATE_NOTES",
					private: true,
					subActions: undefined,
				},
				{
					...notes,
					name: "BLOCKED_NOTES",
					contextGate: { anyOf: ["notes"], noneOf: ["calendar"] },
					subActions: undefined,
				},
				{
					...notes,
					name: "DISABLED_NOTES",
					validate: async () => false,
					subActions: undefined,
				},
			);
			const turn = {
				id: "00000000-0000-4000-8000-000000000001",
				roomId: "00000000-0000-4000-8000-000000000002",
				entityId: "00000000-0000-4000-8000-000000000003",
				content: { text: "Discover the Notes family; keep Calendar visible." },
			} as Memory;
			const admit = (names: string[]) =>
				collectV5PlannerCandidateActions({
					runtime: actualRuntime,
					message: turn,
					state: { values: {}, data: {}, text: "" },
					selectedContexts: ["calendar"],
					candidateActions: names,
					userRoles: [role],
				});
			const initial = await admit([]);
			expect(initial.map((action) => action.name)).not.toContain("NOTES");
			let loaded: Action[] = [];
			const discovery = createPlannerToolDiscoveryAction(
				initial,
				(actions) => {
					loaded = actions;
				},
				(names) =>
					admit(
						names.length > 0
							? names
							: actualRuntime.actions.map((action) => action.name),
					),
			);
			const invoke = (names: string[]) =>
				discovery.handler?.(actualRuntime, turn, undefined, {
					parameters: { names },
				});
			const catalogRead = await invoke([]);
			expect(catalogRead?.success).toBe(true);
			const entries = catalogRead?.data?.catalog;
			if (!Array.isArray(entries)) throw new Error("Missing discovery catalog");
			const catalogNames = entries.map((entry: { name: string }) => entry.name);
			expect(catalogNames.includes("NOTES")).toBe(role === "ADMIN");
			for (const name of ["PRIVATE_NOTES", "BLOCKED_NOTES", "DISABLED_NOTES"])
				expect(catalogNames).not.toContain(name);
			expect(loaded).toEqual([]);
			expect((await invoke(["NOTES"]))?.success).toBe(role === "ADMIN");
			expect(loaded.map((action) => action.name)).toEqual(
				role === "ADMIN" ? ["NOTES", "NOTES_READ"] : [],
			);
			for (const name of [
				"PRIVATE_NOTES",
				"BLOCKED_NOTES",
				"DISABLED_NOTES",
				"NOT_REGISTERED",
			]) {
				loaded = [];
				expect((await invoke(["NOTES", name]))?.success).toBe(false);
				expect(loaded).toEqual([]);
			}
		},
	);

	it("adds discovered Notes schemas without expanding an existing Calendar umbrella", () => {
		const calendar: Action = {
			name: "CALENDAR",
			description: "Complete calendar umbrella",
			subActions: ["CALENDAR_CREATE"],
		};
		const current = buildPlannerToolsFromActions([calendar]);
		const before = structuredClone(current);
		const context = {
			id: "turn",
			events: [{ id: "calendar", type: "tool", tool: calendar }],
		} as import("../../types/context-object").ContextObject;
		const notes: Action[] = [
			{
				name: "NOTES",
				description: "All note operations",
				subActions: ["NOTES_LIST"],
			},
			{ name: "NOTES_LIST", description: "Complete notes list schema" },
		];
		appendDiscoveredPlannerTools(context, current, notes);
		expect(current.slice(0, before.length)).toEqual(before);
		expect(current.map((tool) => tool.name)).toContain("NOTES_LIST");
		expect(current.map((tool) => tool.name)).not.toContain("CALENDAR_CREATE");
		const once = JSON.stringify(current);
		appendDiscoveredPlannerTools(context, current, notes);
		expect(JSON.stringify(current)).toBe(once);
	});

	it("loads complete authorized families, including nested children, without executing them", async () => {
		let executions = 0;
		const completeDescription = `Full selected schema ${"operation detail ".repeat(900)} FINAL_DETAIL`;
		const actions: Action[] = [
			{ name: "VIEWS", description: "Navigate" },
			{
				name: "CALENDAR",
				description: "Calendar",
				subActions: ["EVENTS", "DENIED_CHILD"],
			},
			{ name: "EVENTS", description: "Events", subActions: ["READ_EVENT"] },
			{
				name: "READ_EVENT",
				description: completeDescription,
				parameters: [
					{
						name: "title",
						description: "Exact title",
						required: true,
						schema: { type: "string" },
					},
				],
				handler: async () => {
					executions++;
					return { success: true };
				},
			},
		];
		let loaded: Action[] = [];
		const discovery = createPlannerToolDiscoveryAction(actions, (selected) => {
			loaded = selected;
		});
		expect(discovery.description).not.toContain("DENIED_CHILD");
		// Names and children only: one index entry per family (a parent without
		// children maps to an empty list), never the catalog objects with their
		// descriptions.
		const index = JSON.parse(discovery.description.split("\n").at(-1) ?? "");
		expect(index.VIEWS).toEqual([]);
		expect(index.CALENDAR).toEqual(["EVENTS"]);
		expect(discovery.description).not.toContain('{"name"');
		expect(discovery.description).not.toContain("FINAL_DETAIL");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["CALENDAR"] },
		});
		expect(result?.success).toBe(true);
		expect(loaded.map((action) => action.name)).toEqual([
			"CALENDAR",
			"EVENTS",
			"READ_EVENT",
		]);
		const tools = buildPlannerToolsFromActions(loaded);
		expect(tools.find((tool) => tool.name === "READ_EVENT")?.description).toBe(
			completeDescription,
		);
		expect(
			tools.find((tool) => tool.name === "READ_EVENT")?.parameters?.required,
		).toContain("title");
		expect(executions).toBe(0);
	});

	it("losslessly encodes every authorized family and exact child in the name index", async () => {
		const actions: Action[] = Array.from({ length: 250 }, (_, i) => ({
			name: `FAMILY_${i}`,
			description: `Complete documentation ${i}`,
			subActions: [`CHILD_${i}`],
		}));
		actions.push(
			...Array.from({ length: 250 }, (_, i) => ({
				name: `CHILD_${i}`,
				description: `Operation ${i}`,
			})),
		);
		let loads = 0;
		const discovery = createPlannerToolDiscoveryAction(actions, () => {
			loads++;
		});
		const index = JSON.parse(discovery.description.split("\n").at(-1) ?? "");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: [] },
		});
		const catalog = result?.data?.catalog as Array<{
			name: string;
			children: string[];
		}>;
		expect(Object.entries(index)).toEqual(
			catalog.map(({ name, children }) => [name, children]),
		);
		expect(Object.keys(index)).toHaveLength(250);
		expect(index.FAMILY_249).toEqual(["CHILD_249"]);
		expect(loads).toBe(0);
	});

	it("keeps all names inline and retrieves complete descriptions without loading tools", async () => {
		let loads = 0;
		const childDetail = "  Exact child instructions Ω\n".repeat(100);
		const detail = `Exact family documentation ${"detail\n".repeat(900)} FINAL_DETAIL`;
		const discovery = createPlannerToolDiscoveryAction(
			[
				{ name: "NOTES", description: detail, subActions: ["NOTES_READ"] },
				{
					name: "NOTES_READ",
					description: childDetail,
					contexts: ["notes"],
					similes: ["READ_SAVED_NOTE"],
				},
			],
			() => {
				loads++;
			},
		);
		expect(discovery.description).toContain("NOTES_READ");
		expect(discovery.description).not.toContain("FINAL_DETAIL");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: [] },
		});
		expect(result?.success).toBe(true);
		expect(JSON.stringify(result?.data)).toContain(
			JSON.stringify(detail).slice(1, -1),
		);
		expect(result?.data?.catalog).toEqual([
			expect.objectContaining({
				name: "NOTES",
				description: detail,
				childDefinitions: [
					{
						name: "NOTES_READ",
						description: childDetail,
						contexts: ["notes"],
						similes: ["READ_SAVED_NOTE"],
					},
				],
			}),
		]);
		expect(loads).toBe(0);
	});

	it.each([
		{ names: ["VIEWS", "UNAUTHORIZED"] },
		{ names: [null] },
		{ names: ["views"] },
	])(
		"rejects invalid or unavailable names atomically: %j",
		async ({ names }) => {
			let loaded = false;
			const discovery = createPlannerToolDiscoveryAction(
				[{ name: "VIEWS", description: "Navigate" }],
				() => {
					loaded = true;
				},
			);
			const result = await discovery.handler?.(runtime, message, undefined, {
				parameters: { names },
			});
			expect(result?.success).toBe(false);
			expect(result?.data).toMatchObject({ coachingFailure: true });
			expect(result?.error).toContain("No tools were loaded");
			expect(loaded).toBe(false);
		},
	);

	it("lists a family gated only by context under its own declared contexts and keeps the private and role gates (live: MESSAGE on a general-routed turn)", async () => {
		const actions: Action[] = [
			{ name: "MESSAGE", description: "Messaging", contexts: ["messaging"] },
			{ name: "VIEWS", description: "Navigate", contexts: ["general"] },
			{
				name: "PRIVATE_X",
				description: "Autonomy only",
				contexts: ["general"],
				private: true,
			},
			{
				name: "OWNER_X",
				description: "Owner only",
				contexts: ["general"],
				roleGate: { minRole: "OWNER" },
			},
		] as Action[];
		const catalog = collectDiscoveryCatalogActions({
			actions,
			message,
			selectedContexts: ["general"],
			userRoles: ["ADMIN"],
		});
		expect(catalog.map((action) => action.name)).toEqual(["MESSAGE", "VIEWS"]);
		let loaded: string[] = [];
		const discovery = createPlannerToolDiscoveryAction(catalog, (found) => {
			loaded = found.map((action) => action.name);
		});
		const index = JSON.parse(discovery.description.split("\n").at(-1) ?? "");
		expect(Object.keys(index).sort()).toEqual(["MESSAGE", "VIEWS"]);
		expect(discovery.description).not.toContain("PRIVATE_X");
		expect(discovery.description).not.toContain("OWNER_X");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["MESSAGE"] },
		});
		expect(result?.success).toBe(true);
		expect(loaded).toEqual(["MESSAGE"]);
	});

	it("returns admitted exact retry names without loading a partial or rejected request", async () => {
		const loads: Action[][] = [];
		const discovery = createPlannerToolDiscoveryAction(
			[{ name: "DOCUMENT", description: "Read documents" }],
			(actions) => loads.push(actions),
			async () => [],
		);
		const rejected = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["DOCUMENT", "DOCUMENTS_READ"] },
		});
		expect(rejected?.success).toBe(false);
		expect(loads).toEqual([]);
		expect(rejected?.data?.availableNames).toEqual(["DOCUMENT"]);
		const retry = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["DOCUMENT"] },
		});
		expect(retry?.success).toBe(true);
		expect(loads.flat().map((action) => action.name)).toEqual(["DOCUMENT"]);
	});

	it("rejects a registered action using the reserved discovery protocol name", () => {
		expect(() =>
			createPlannerToolDiscoveryAction(
				[{ name: "DISCOVER_TOOLS", description: "Collision" }],
				() => undefined,
			),
		).toThrow("conflicts");
	});
});
