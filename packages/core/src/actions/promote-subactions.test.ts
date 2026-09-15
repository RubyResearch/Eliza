/**
 * Unit tests for umbrella action subaction promotion, parameter slicing,
 * discriminator pinning, description/hint hygiene, and virtual routing.
 */

import { describe, expect, it, vi } from "vitest";
import { messageAction } from "../features/advanced-capabilities/actions/message.js";
import type {
	Action,
	ActionParameter,
	HandlerOptions,
} from "../types/index.js";
import {
	isPromotedSubactionVirtual,
	listSubactionsFromParameters,
	promotedParentRoutingHint,
	promoteSubactionsToActions,
} from "./promote-subactions.js";
import {
	buildPlannerToolsFromActions,
	buildPlannerToolsFromTieredActions,
} from "./to-tool.js";
import { validateToolArgs } from "./validate-tool-args.js";

function makeUmbrella(overrides: Partial<Action> = {}): Action {
	return {
		name: "WIDGET",
		description: "Operate widgets",
		descriptionCompressed:
			"widget umbrella create read delete keyword stuffed retrieval blurb",
		routingHint: "manage widgets -> WIDGET; do NOT use for gadgets -> GADGET",
		handler: async () => undefined,
		validate: async () => true,
		parameters: [
			{
				name: "action",
				description: "Widget operation.",
				required: false,
				schema: { type: "string", enum: ["create", "read", "delete"] },
			},
			{
				name: "shared",
				description: "Applies to every subaction (no applicability list).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "title",
				description: "Only for create.",
				required: false,
				subactions: ["create"],
				schema: { type: "string" },
			},
			{
				name: "widgetId",
				description: "For read and delete.",
				required: false,
				subactions: ["READ", "Delete"],
				schema: { type: "string" },
			},
		],
		...overrides,
	};
}

function paramNames(action: Action): string[] {
	return (action.parameters ?? []).map((parameter) => parameter.name);
}

function findVirtual(virtuals: readonly Action[], name: string): Action {
	const virtual = virtuals.find((entry) => entry.name === name);
	if (!virtual) throw new Error(`virtual ${name} not promoted`);
	return virtual;
}

describe("promote-subactions helper predicates", () => {
	it("extracts subactions list from discriminator parameter enum", () => {
		const action = makeUmbrella();
		const subactions = listSubactionsFromParameters(action.parameters);
		expect(subactions).toEqual(["create", "read", "delete"]);

		expect(listSubactionsFromParameters(undefined)).toEqual([]);
		expect(listSubactionsFromParameters([])).toEqual([]);
	});

	it("identifies virtual actions and promoted parent hints", () => {
		const parent = makeUmbrella({ routingHint: "Use for background jobs." });
		const promoted = promoteSubactionsToActions(parent);

		expect(promoted).toHaveLength(4);
		expect(isPromotedSubactionVirtual(promoted[0])).toBe(false);
		expect(isPromotedSubactionVirtual(promoted[1])).toBe(true);

		const hint = promotedParentRoutingHint(promoted[1]);
		expect(hint).toEqual({
			parent: "WIDGET",
			hint: "Use for background jobs.",
		});
	});
});

describe("promoteSubactionsToActions parameter slicing", () => {
	it("uses an authored operation contract without changing sibling schemas or delegation gates", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const validate = vi.fn(async () => false);
		const parent = makeUmbrella({
			handler,
			validate,
			roleGate: { minRole: "OWNER" },
		});
		const originalParameters = structuredClone(parent.parameters);
		const ordinary = promoteSubactionsToActions(parent);
		const discriminator = parent.parameters?.[0];
		if (!discriminator) throw new Error("Missing discriminator fixture");
		const authored = [
			discriminator,
			{
				name: "details",
				description: "Read selector",
				required: false,
				schema: {
					type: "object" as const,
					properties: { id: { type: "string" as const } },
					additionalProperties: false,
				},
			},
		];
		const family = promoteSubactionsToActions(parent, {
			overrides: { read: { parameters: authored } },
		});
		const read = findVirtual(family, "WIDGET_READ");
		expect(parent.parameters).toEqual(originalParameters);
		expect(findVirtual(family, "WIDGET_CREATE").parameters).toEqual(
			findVirtual(ordinary, "WIDGET_CREATE").parameters,
		);
		expect(read.roleGate).toEqual(parent.roleGate);
		expect(await read.validate({} as never, {} as never, undefined)).toBe(
			false,
		);
		expect(validate).toHaveBeenCalledOnce();
		const accepted = validateToolArgs(read, { details: { id: "actual-id" } });
		expect(accepted.valid).toBe(true);
		expect(validateToolArgs(read, { details: { id: 3 } }).valid).toBe(false);
		expect(
			validateToolArgs(read, { details: { mutation: "delete" } }).valid,
		).toBe(false);
		await read.handler({} as never, {} as never, undefined, {
			parameters: accepted.args,
		});
		expect(
			(handler.mock.calls[0]?.[3] as HandlerOptions | undefined)?.parameters,
		).toMatchObject({
			action: "read",
			subaction: "read",
			details: { id: "actual-id" },
		});
	});
	it.each([false, true, undefined])(
		"preserves parent schema strictness %s in promoted native tools",
		(toolSchemaStrict) => {
			const family = promoteSubactionsToActions(
				makeUmbrella({ toolSchemaStrict }),
			);
			expect(family.length).toBeGreaterThan(1);
			for (const action of family) {
				expect(action.toolSchemaStrict).toBe(toolSchemaStrict);
			}
			for (const tool of buildPlannerToolsFromActions(family)) {
				expect(tool.strict).toBe(toolSchemaStrict ?? true);
			}
		},
	);

	it("marks a parameter required only on the virtuals that list it", () => {
		const parent = makeUmbrella({
			parameters: [
				{
					name: "action",
					description: "Widget operation.",
					required: false,
					schema: { type: "string", enum: ["create", "read", "delete"] },
				},
				{
					name: "title",
					description: "Content; required when creating.",
					required: false,
					requiredForSubactions: ["create"],
					schema: { type: "string" },
				},
			],
		});
		const promoted = promoteSubactionsToActions(parent);
		const create = promoted.find((a) => a.name === "WIDGET_CREATE");
		const read = promoted.find((a) => a.name === "WIDGET_READ");
		const createTitle = create?.parameters?.find((p) => p.name === "title");
		const readTitle = read?.parameters?.find((p) => p.name === "title");
		expect(createTitle?.required).toBe(true);
		expect(readTitle?.required).toBe(false);
		expect("requiredForSubactions" in (createTitle ?? {})).toBe(false);
		// The parent umbrella keeps the field optional.
		expect(parent.parameters?.find((p) => p.name === "title")?.required).toBe(
			false,
		);
		expect(validateToolArgs(create as Action, {}).valid).toBe(false);
		expect(validateToolArgs(create as Action, { title: "x" }).valid).toBe(true);
	});

	it("keeps parameters without a subactions list on every virtual", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		for (const virtual of virtuals) {
			expect(paramNames(virtual)).toContain("shared");
			expect(paramNames(virtual)).toContain("action");
		}
	});

	it("drops parameters whose subactions list excludes the pinned value", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const create = findVirtual(virtuals, "WIDGET_CREATE");
		const read = findVirtual(virtuals, "WIDGET_READ");
		const del = findVirtual(virtuals, "WIDGET_DELETE");

		expect(paramNames(create)).toEqual(["action", "shared", "title"]);
		expect(paramNames(read)).toEqual(["action", "shared", "widgetId"]);
		expect(paramNames(del)).toEqual(["action", "shared", "widgetId"]);
	});

	it("pins the discriminator enum and default on each sliced virtual", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const read = findVirtual(virtuals, "WIDGET_READ");
		const discriminator = (read.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(discriminator?.schema.enum).toEqual(["read"]);
		expect(discriminator?.schema.default).toBe("read");
	});

	it("validates virtual actions with their pinned discriminator injected", async () => {
		const seen: unknown[] = [];
		const [, ...virtuals] = promoteSubactionsToActions(
			makeUmbrella({
				validate: async (_runtime, _message, _state, options) => {
					seen.push((options as HandlerOptions | undefined)?.parameters);
					return (
						(
							(options as HandlerOptions | undefined)?.parameters as {
								action?: string;
							}
						)?.action === "read"
					);
				},
			}),
		);

		await expect(
			findVirtual(virtuals, "WIDGET_READ").validate?.({} as never, {} as never),
		).resolves.toBe(true);
		await expect(
			findVirtual(virtuals, "WIDGET_DELETE").validate?.(
				{} as never,
				{} as never,
			),
		).resolves.toBe(false);
		expect(seen).toEqual([
			{ action: "read", subaction: "read" },
			{ action: "delete", subaction: "delete" },
		]);
	});

	it("defaults virtual validation to true when the parent has no validator", async () => {
		const parent = makeUmbrella();
		delete (parent as Partial<Action>).validate;
		const [, ...virtuals] = promoteSubactionsToActions(parent as Action);

		await expect(
			findVirtual(virtuals, "WIDGET_CREATE").validate({} as never, {} as never),
		).resolves.toBe(true);
	});

	it("treats an explicit empty subactions list as parent-only", () => {
		const umbrella = makeUmbrella({
			parameters: [
				...(makeUmbrella().parameters ?? []),
				{
					name: "op",
					description: "Planner alias for action (parent-only).",
					required: false,
					subactions: [],
					schema: { type: "string", enum: ["create", "read", "delete"] },
				},
			],
		});
		const [parent, ...virtuals] = promoteSubactionsToActions(umbrella);
		expect(paramNames(parent as Action)).toContain("op");
		for (const virtual of virtuals) {
			expect(paramNames(virtual)).not.toContain("op");
		}
	});

	it("never slices the discriminator, even with a stray applicability list", () => {
		const umbrella = makeUmbrella();
		const parameters = umbrella.parameters as ActionParameter[];
		const discriminatorIndex = parameters.findIndex((p) => p.name === "action");
		parameters[discriminatorIndex] = {
			...parameters[discriminatorIndex],
			subactions: ["create"],
		} as ActionParameter;
		const [, ...virtuals] = promoteSubactionsToActions(umbrella);
		const read = findVirtual(virtuals, "WIDGET_READ");
		expect(paramNames(read)).toContain("action");
	});

	it("leaves the parent's parameters untouched", () => {
		const umbrella = makeUmbrella();
		const [parent] = promoteSubactionsToActions(umbrella);
		expect(paramNames(parent as Action)).toEqual([
			"action",
			"shared",
			"title",
			"widgetId",
		]);
		const title = (parent as Action).parameters?.find(
			(parameter) => parameter.name === "title",
		);
		expect(title?.subactions).toEqual(["create"]);
	});

	it("validates model args against the sliced schema (exposure == validation)", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		const create = findVirtual(virtuals, "WIDGET_CREATE");

		const ok = validateToolArgs(create, { title: "hello" });
		expect(ok.valid).toBe(true);
		expect(ok.args?.action).toBe("create");

		const bad = validateToolArgs(create, { widgetId: "w-1" });
		expect(bad.valid).toBe(false);
		expect(bad.errors.join(" ")).toContain("widgetId");
	});

	it("dispatch still injects the discriminator for sliced virtuals", async () => {
		const handler = vi.fn(async () => undefined);
		const [, ...virtuals] = promoteSubactionsToActions(
			makeUmbrella({ handler }),
		);
		const del = findVirtual(virtuals, "WIDGET_DELETE");
		await del.handler({} as never, {} as never, undefined, {
			parameters: { widgetId: "w-1" },
		});
		const options = handler.mock.calls[0]?.[3] as HandlerOptions;
		expect(options.parameters).toMatchObject({
			action: "delete",
			subaction: "delete",
			widgetId: "w-1",
		});
	});
});

describe("promoteSubactionsToActions virtual dispatch consistency", () => {
	it("rejects a conflicting canonical discriminator without invoking the parent", async () => {
		const handler = vi.fn(async () => undefined);
		const [, ...virtuals] = promoteSubactionsToActions(
			makeUmbrella({ handler }),
		);
		const read = findVirtual(virtuals, "WIDGET_READ");

		const result = await read.handler({} as never, {} as never, undefined, {
			parameters: { action: "delete" },
		});

		expect(result).toMatchObject({
			success: false,
			text: expect.stringContaining("Call WIDGET_DELETE"),
		});
		expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects a conflicting declared alias that carries the pinned vocabulary", async () => {
		const handler = vi.fn(async () => undefined);
		const umbrella = makeUmbrella({
			handler,
			parameters: [
				...(makeUmbrella().parameters ?? []),
				{
					name: "op",
					description: "Alias for the widget operation.",
					required: false,
					schema: { type: "string", enum: ["create", "read", "delete"] },
				},
			],
		});
		const [, ...virtuals] = promoteSubactionsToActions(umbrella);

		const result = await findVirtual(virtuals, "WIDGET_READ").handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: { op: "delete" } },
		);

		expect(result).toMatchObject({
			success: false,
			text: expect.stringContaining("'op: delete' contradicts it"),
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("accepts a normalized matching alias and delegates with the virtual pin", async () => {
		const handler = vi.fn(async () => undefined);
		const umbrella = makeUmbrella({
			handler,
			parameters: [
				...(makeUmbrella().parameters ?? []),
				{
					name: "op",
					description: "Alias for the widget operation.",
					required: false,
					schema: { type: "string", enum: ["create", "read", "delete"] },
				},
			],
		});
		const [, ...virtuals] = promoteSubactionsToActions(umbrella);

		await findVirtual(virtuals, "WIDGET_READ").handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: { op: " READ " } },
		);

		const options = handler.mock.calls[0]?.[3] as HandlerOptions;
		expect(options.parameters).toMatchObject({
			action: "read",
			op: " READ ",
			subaction: "read",
		});
	});

	it("preserves an alias-named nested selector with an independent enum", async () => {
		const handler = vi.fn(async () => undefined);
		const umbrella = makeUmbrella({
			handler,
			parameters: [
				...(makeUmbrella().parameters ?? []),
				{
					name: "op",
					description: "Nested operation within a widget read.",
					required: false,
					schema: { type: "string", enum: ["start", "stop"] },
				},
			],
		});
		const [, ...virtuals] = promoteSubactionsToActions(umbrella);

		await findVirtual(virtuals, "WIDGET_READ").handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: { op: "stop" } },
		);

		const options = handler.mock.calls[0]?.[3] as HandlerOptions;
		expect(options.parameters).toMatchObject({
			action: "read",
			op: "stop",
			subaction: "read",
		});
	});
});

describe("promoteSubactionsToActions description / hint hygiene", () => {
	it("does not copy routingHint onto virtuals; the parent keeps it", () => {
		const [parent, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		expect((parent as Action).routingHint).toContain("manage widgets");
		for (const virtual of virtuals) {
			expect(virtual.routingHint).toBeUndefined();
		}
	});

	it("does not inherit the parent's descriptionCompressed", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella());
		for (const virtual of virtuals) {
			expect(virtual.descriptionCompressed).toBeUndefined();
			expect(virtual.description).toContain("subaction =");
		}
	});

	it("uses the override descriptionCompressed when provided", () => {
		const [, ...virtuals] = promoteSubactionsToActions(makeUmbrella(), {
			overrides: {
				create: { descriptionCompressed: "create a widget" },
			},
		});
		expect(findVirtual(virtuals, "WIDGET_CREATE").descriptionCompressed).toBe(
			"create a widget",
		);
		expect(
			findVirtual(virtuals, "WIDGET_READ").descriptionCompressed,
		).toBeUndefined();
	});
});

describe("MESSAGE umbrella planner tools footprint (real surface)", () => {
	function buildFamilyTools() {
		const [parent, ...virtuals] = promoteSubactionsToActions(messageAction);
		return {
			parent: parent as Action,
			virtuals,
			tools: buildPlannerToolsFromTieredActions([parent], {
				tierAParents: [parent.name],
				actionLookup: new Map(virtuals.map((v) => [v.name, v])),
			}),
		};
	}

	it("still exposes every subaction as a first-class tool", () => {
		const { tools } = buildFamilyTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("MESSAGE");
		for (const op of [
			"send",
			"read_channel",
			"read_with_contact",
			"search",
			"list_channels",
			"list_servers",
			"list_connections",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"triage",
			"list_inbox",
			"search_inbox",
			"draft_reply",
			"draft_followup",
			"respond",
			"send_draft",
			"schedule_draft_send",
			"manage",
		]) {
			expect(names).toContain(`MESSAGE_${op.toUpperCase()}`);
		}
	});

	it("keeps the full parameter surface on the parent tool", () => {
		const { tools, parent } = buildFamilyTools();
		const parentTool = tools.find((tool) => tool.name === "MESSAGE");
		expect(Object.keys(parentTool?.parameters.properties ?? {})).toHaveLength(
			(parent.parameters ?? []).length,
		);
	});

	it("exposes op-specific parameters only on the relevant virtuals", () => {
		const { tools } = buildFamilyTools();
		const props = (name: string) =>
			Object.keys(
				tools.find((tool) => tool.name === name)?.parameters.properties ?? {},
			);

		const send = props("MESSAGE_SEND");
		expect(send).toEqual(
			expect.arrayContaining(["message", "attachments", "urgency", "target"]),
		);
		expect(send).not.toContain("emoji");
		expect(send).not.toContain("draftId");
		expect(send).not.toContain("worldIds");

		const readChannel = props("MESSAGE_READ_CHANNEL");
		expect(readChannel).toEqual(
			expect.arrayContaining(["from", "until", "to"]),
		);

		const react = props("MESSAGE_REACT");
		expect(react).toEqual(expect.arrayContaining(["emoji", "messageId"]));
		expect(react).not.toContain("attachments");

		const triage = props("MESSAGE_TRIAGE");
		expect(triage).toEqual(
			expect.arrayContaining(["sources", "worldIds", "sinceMs"]),
		);
		expect(triage).not.toContain("message");
		expect(triage).not.toContain("emoji");

		expect(props("MESSAGE_LIST_CONNECTIONS")).toEqual(["action"]);
	});

	it("cuts the family tools payload to well under half of the unsliced size", () => {
		const { tools } = buildFamilyTools();
		const sliced = JSON.stringify(tools).length;

		const unslicedAction: Action = {
			...messageAction,
			parameters: (messageAction.parameters ?? []).map(
				({ subactions: _subactions, ...parameter }) => parameter,
			),
		};
		const [parent, ...virtuals] = promoteSubactionsToActions(unslicedAction);
		const unsliced = JSON.stringify(
			buildPlannerToolsFromTieredActions([parent], {
				tierAParents: [parent.name],
				actionLookup: new Map(virtuals.map((v) => [v.name, v])),
			}),
		).length;

		expect(sliced).toBeLessThan(unsliced * 0.4);
		// Absolute guard so the surface cannot silently flood again: the
		// measured pre-fix payload for this family was ~163 KB+.
		expect(sliced).toBeLessThan(75_000);
	});

	it("virtual tool descriptions no longer duplicate the parent's routing hint and blurb", () => {
		const { tools, parent } = buildFamilyTools();
		const hint = parent.routingHint ?? "";
		expect(hint.length).toBeGreaterThan(0);
		const parentTool = tools.find((tool) => tool.name === "MESSAGE");
		expect(parentTool?.description).toContain(hint);
		for (const tool of tools) {
			if (tool.name === "MESSAGE") continue;
			expect(tool.description).not.toContain(hint);
			expect(tool.description).not.toContain(
				parent.descriptionCompressed ?? "<none>",
			);
			expect(tool.description).toBe(
				`${parent.description} — subaction = ${tool.name
					.slice("MESSAGE_".length)
					.toLowerCase()}`,
			);
		}
	});
});

describe("promoted virtual similes", () => {
	it("keeps the parent's simile array on the parent alone", () => {
		const parent = makeUmbrella({
			similes: ["SHARED_ALIAS_ONE", "SHARED_ALIAS_TWO"],
		});
		const [umbrella, ...virtuals] = promoteSubactionsToActions(parent);

		expect(umbrella.similes).toEqual(
			expect.arrayContaining(["SHARED_ALIAS_ONE", "SHARED_ALIAS_TWO"]),
		);
		expect(virtuals.length).toBeGreaterThan(1);
		for (const virtual of virtuals) {
			expect(virtual.similes).not.toContain("SHARED_ALIAS_ONE");
			expect(virtual.similes).not.toContain("SHARED_ALIAS_TWO");
			expect(virtual.similes).toContain("WIDGET");
		}
		const names = new Set(virtuals.map((v) => v.name));
		expect(names).toContain("WIDGET_CREATE");
		const create = findVirtual(virtuals, "WIDGET_CREATE");
		expect(create.similes).toContain("CREATE");
	});

	it("keeps per-subaction override similes on their own virtual only", () => {
		const parent = makeUmbrella({ similes: ["FAMILY_ALIAS"] });
		const [, ...virtuals] = promoteSubactionsToActions(parent, {
			overrides: { read: { similes: ["PEEK_WIDGET"] } },
		});
		const read = findVirtual(virtuals, "WIDGET_READ");
		expect(read.similes).toContain("PEEK_WIDGET");
		for (const virtual of virtuals) {
			if (virtual.name === "WIDGET_READ") continue;
			expect(virtual.similes).not.toContain("PEEK_WIDGET");
		}
	});
});
