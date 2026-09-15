/**
 * TASKS-, CONTACT- and DATABASE-shaped promoted families consolidate to their
 * umbrella plus alias contracts on the canonical planner wire, and the
 * contract block no longer scales with the umbrella's description length or
 * property count. Live 2026-09-13 22:40 UTC (a notes lookup that exposed
 * TASKS): the consolidated TASKS tool was 45,181 chars, 30,722 of them alias
 * contracts — the 1,977-char umbrella description repeated in all 14 alias
 * descriptions (16,882 chars) and the same 56 property names listed 14 times
 * (9,198 chars). Every-child-direct rendering (TASKS 11,644 chars beside 14
 * children of ~10.5K each) exists only in trajectories that predate
 * collectCanonicalPlannerActions.
 */
import { describe, expect, it } from "vitest";
import { actionToJsonSchema, type JsonSchema } from "../actions/action-schema";
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import {
	dispatchSubaction,
	readSubaction,
	type SubactionHandlerMap,
} from "../actions/subaction-dispatch";
import { createContextObject } from "../runtime/context-object";
import type { Action, ActionParameter, IAgentRuntime, Memory } from "../types";
import {
	collectActionsFromContext,
	collectCanonicalPlannerActions,
	collectPlannerTools,
} from "./message/planned-tool";

const TASK_OPS = [
	"create",
	"spawn_agent",
	"send",
	"stop_agent",
	"list_agents",
	"cancel",
	"history",
	"control",
	"share",
	"provision_workspace",
	"submit_workspace",
	"manage_issues",
	"archive",
	"reopen",
] as const;
type TaskOp = (typeof TASK_OPS)[number];
const TASKS_DESCRIPTION = `Planner surface for orchestrator workspace operations and coding task delegation. ${"Choose this when the user asks to delegate coding work. ".repeat(20)}`;
const SPAWN_AGENT_DESCRIPTION =
	"Delegate a coding task to a dedicated coding sub-agent.";
const CONTRACTS_MARKER = "Complete alias contracts:\n";

interface AliasContract {
	name: string;
	description?: string;
	descriptionSuffix?: string;
	pins?: Record<string, string>;
	parameters?: JsonSchema & {
		parentParameterNames?: string[];
		propertyOverrides?: Record<string, JsonSchema>;
	};
}

function aliasName(parent: string, op: string): string {
	return `${parent}_${op.toUpperCase()}`;
}

function contextFor(actions: readonly Action[]) {
	return createContextObject({
		id: "umbrella-children-consolidation",
		events: actions.map((action) => ({
			id: `tool:${action.name}`,
			type: "tool",
			tool: { name: action.name, action },
		})),
	});
}

function aliasContracts(description: string | undefined): AliasContract[] {
	const text = description ?? "";
	const start = text.lastIndexOf(CONTRACTS_MARKER);
	expect(start).toBeGreaterThan(-1);
	return JSON.parse(
		text.slice(start + CONTRACTS_MARKER.length),
	) as AliasContract[];
}

function contractBlockLength(description: string | undefined): number {
	const text = description ?? "";
	const start = text.lastIndexOf(CONTRACTS_MARKER);
	expect(start).toBeGreaterThan(-1);
	return text.length - start;
}

/** The pinned discriminator exactly as pinDiscriminatorForVirtual writes it. */
function pinnedProperty(property: JsonSchema, value: string): JsonSchema {
	return {
		...property,
		description: `Subaction discriminator (auto-set to "${value}" for this virtual; do not change).`,
		enum: [value],
		default: value,
	};
}

/** Alias description per the contract preamble's defaults. */
function reconstructAliasDescription(
	parent: Action,
	contract: AliasContract,
): string {
	if (contract.description !== undefined) return contract.description;
	const suffix =
		contract.descriptionSuffix ??
		` — subaction = ${Object.values(contract.pins ?? {})[0]}`;
	return `${parent.description}${suffix}`;
}

/** Alias JSON schema per the contract preamble's defaults. */
function reconstructAliasSchema(
	parentSchema: ReturnType<typeof actionToJsonSchema>,
	contract: AliasContract,
): JsonSchema {
	const pins = contract.pins ?? {};
	const {
		parentParameterNames,
		propertyOverrides = {},
		...outerSchema
	} = contract.parameters ?? {};
	const names = parentParameterNames ?? Object.keys(parentSchema.properties);
	return {
		type: "object",
		required: [],
		additionalProperties: parentSchema.additionalProperties,
		...outerSchema,
		properties: Object.fromEntries(
			names.map((name) => {
				const parentProperty = parentSchema.properties[name];
				const pin = pins[name];
				return [
					name,
					propertyOverrides[name] ??
						(pin === undefined
							? parentProperty
							: pinnedProperty(parentProperty, pin)),
				];
			}),
		),
	};
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function discriminator(name: string, description: string): ActionParameter {
	return {
		name,
		description,
		required: false,
		schema: { type: "string", enum: [...TASK_OPS] },
	};
}

function operand(
	name: string,
	description: string,
	extra: Partial<ActionParameter> = {},
): ActionParameter {
	return {
		name,
		description,
		required: false,
		schema: { type: "string" },
		...extra,
	};
}

/**
 * Mirrors plugin-agent-orchestrator's TASKS: four discriminator keys that
 * all carry the complete operation enum, only optional operands, a
 * description override for spawn_agent, a switch-style handler, and the
 * admission wrappers that spread registered Actions.
 */
function tasksFamily(
	options: {
		task?: Partial<ActionParameter>;
		description?: string;
		extraOperands?: number;
	} = {},
) {
	const calls: Array<{ op: TaskOp; params: Record<string, unknown> }> = [];
	const handlers = Object.fromEntries(
		TASK_OPS.map((op) => [
			op,
			(params: Record<string, unknown>) => {
				calls.push({ op, params });
				return { success: true, data: { op } };
			},
		]),
	) as SubactionHandlerMap<TaskOp, Record<string, unknown>>;
	const parent: Action = {
		name: "TASKS",
		description: options.description ?? TASKS_DESCRIPTION,
		parameters: [
			discriminator("action", "Task operation."),
			discriminator("op", "Planner alias for action."),
			discriminator("subaction", "Planner alias for action."),
			discriminator("operation", "Planner alias for action."),
			operand("task", "Task prompt for create / spawn_agent.", options.task),
			operand("sessionId", "Coding session for send / stop_agent."),
			operand("limit", "Row limit for history.", {
				schema: { type: "number" },
			}),
			...Array.from({ length: options.extraOperands ?? 0 }, (_, index) =>
				operand(`extra${index}`, `Extra operand ${index}.`),
			),
		],
		handler: async (_runtime, _message, _state, handlerOptions) => {
			const params = (handlerOptions?.parameters ?? {}) as Record<
				string,
				unknown
			>;
			return dispatchSubaction(
				readSubaction(params, { allowed: TASK_OPS }),
				handlers,
				params,
			);
		},
	};
	const actions = promoteSubactionsToActions(parent, {
		overrides: { spawn_agent: { description: SPAWN_AGENT_DESCRIPTION } },
	}).map((action) => ({ ...action }));
	return { actions, calls, context: contextFor(actions) };
}

/** Mirrors CONTACT / DATABASE: a required discriminator and optional operands. */
function operationsFamily(
	name: string,
	ops: readonly string[],
	operands: readonly string[],
): Action[] {
	const parent: Action = {
		name,
		description: `${name} operations: ${ops.join(", ")}.`,
		parameters: [
			{
				name: "action",
				description: `Action to perform. One of: ${ops.join(", ")}.`,
				required: true,
				schema: { type: "string", enum: [...ops] },
			},
			...operands.map((operandName) =>
				operand(operandName, `${operandName} for ${name}.`),
			),
		],
		handler: async () => ({ success: true }),
	};
	return promoteSubactionsToActions(parent).map((action) => ({ ...action }));
}

describe("umbrella children consolidation on the planner wire", () => {
	it("represents every TASKS-shaped child through the umbrella's alias contracts", () => {
		const { actions, context } = tasksFamily();
		expect(actions.map((action) => action.name)).toEqual([
			"TASKS",
			...TASK_OPS.map((op) => aliasName("TASKS", op)),
		]);
		const tools = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"TASKS",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(collectCanonicalPlannerActions(actions)).toEqual([actions[0]]);
		const umbrella = tools[0];
		const contracts = aliasContracts(umbrella?.description);
		expect(contracts.map((contract) => contract.name)).toEqual(
			TASK_OPS.map((op) => aliasName("TASKS", op)),
		);
		for (const [index, contract] of contracts.entries()) {
			// The pinned `action` is the only overridden property and every
			// operand is optional, so the alias differs from the umbrella by its
			// pin alone: no parameters object at all.
			expect(contract.pins).toEqual({ action: TASK_OPS[index] });
			expect(contract.parameters).toBeUndefined();
			expect(contract.description).toBeUndefined();
		}
		// The default " — subaction = <pin>" blurb is implied by the pin; only
		// spawn_agent's override blurb is spelled out.
		expect(contracts[0]?.descriptionSuffix).toBeUndefined();
		expect(contracts[1]?.descriptionSuffix).toBe(
			` — ${SPAWN_AGENT_DESCRIPTION}`,
		);
		// The umbrella description and its four complete discriminator enums
		// render once, in the umbrella itself.
		const wire = JSON.stringify(tools);
		expect(occurrences(wire, TASKS_DESCRIPTION)).toBe(1);
		expect(occurrences(wire, JSON.stringify([...TASK_OPS]))).toBe(4);
		expect(
			occurrences(umbrella?.description ?? "", '"parentParameterNames"'),
		).toBe(0);
	});

	it("keeps the contract block independent of the umbrella's description length and property count", () => {
		const compact = tasksFamily();
		const wide = tasksFamily({
			description: TASKS_DESCRIPTION.repeat(5),
			extraOperands: 40,
		});
		const blockLength = (family: ReturnType<typeof tasksFamily>) =>
			contractBlockLength(
				collectPlannerTools(family.context, undefined, {
					canonicalFamilies: true,
				})[0]?.description,
			);
		expect(blockLength(wide)).toBe(blockLength(compact));
		// Fourteen contracts together cost less than one direct child tool did
		// on the live wire (~10.5K chars each).
		expect(blockLength(compact)).toBeLessThan(14 * 600);
	});

	it("consolidates CONTACT- and DATABASE-shaped families whose umbrella requires only the discriminator", () => {
		const contactOps = [
			"create",
			"read",
			"search",
			"update",
			"delete",
			"activity",
			"followup",
		];
		const databaseOps = ["list_tables", "get_table", "query", "search_vectors"];
		const actions = [
			...operationsFamily("CONTACT", contactOps, ["entityId", "query", "name"]),
			...operationsFamily("DATABASE", databaseOps, ["tableName", "sql"]),
		];
		expect(collectCanonicalPlannerActions(actions).map((a) => a.name)).toEqual([
			"CONTACT",
			"DATABASE",
		]);
		const tools = collectPlannerTools(contextFor(actions), undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"CONTACT",
			"DATABASE",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(tools[0]?.parameters.required).toEqual(["action"]);
		for (const [tool, ops] of [
			[tools[0], contactOps],
			[tools[1], databaseOps],
		] as const) {
			const contracts = aliasContracts(tool?.description);
			expect(contracts.map((contract) => contract.name)).toEqual(
				ops.map((op) => aliasName(tool?.name ?? "", op)),
			);
			for (const [index, contract] of contracts.entries()) {
				// The umbrella requires the discriminator and each alias pins it, so
				// nothing the umbrella requires is missing from any alias; with no
				// required operand and every property in umbrella order the alias
				// differs from the umbrella by its pin alone.
				expect(contract.pins).toEqual({ action: ops[index] });
				expect(contract.parameters).toBeUndefined();
				expect(contract.descriptionSuffix).toBeUndefined();
			}
		}
	});

	it("keeps direct only the children whose umbrella-required parameter they cannot express", () => {
		const lossy = tasksFamily({
			task: { required: true, subactions: ["create", "spawn_agent"] },
		});
		const direct = TASK_OPS.filter(
			(op) => op !== "create" && op !== "spawn_agent",
		).map((op) => aliasName("TASKS", op));
		expect(
			collectCanonicalPlannerActions(lossy.actions).map((a) => a.name),
		).toEqual(["TASKS", ...direct]);
		const tools = collectPlannerTools(lossy.context, undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"TASKS",
			...direct,
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(
			aliasContracts(tools[0]?.description).map((contract) => contract.name),
		).toEqual(["TASKS_CREATE", "TASKS_SPAWN_AGENT"]);
		// A requirement the umbrella keeps optional is expressible: the alias
		// contract carries it explicitly and the family consolidates.
		const expressible = tasksFamily({
			task: { requiredForSubactions: ["create", "spawn_agent"] },
		});
		expect(collectCanonicalPlannerActions(expressible.actions)).toEqual([
			expressible.actions[0],
		]);
		const contracts = aliasContracts(
			collectPlannerTools(expressible.context, undefined, {
				canonicalFamilies: true,
			})[0]?.description,
		);
		expect(contracts[0]?.parameters?.required).toEqual(["task"]);
		// A required list equal to the umbrella's is an omitted default.
		expect(contracts[2]?.parameters?.required ?? []).toEqual([]);
	});

	it("dispatches an operation through the umbrella and through a retained alias to the same handler", async () => {
		const { actions, calls, context } = tasksFamily();
		const [umbrella] = collectCanonicalPlannerActions(actions);
		expect(umbrella?.name).toBe("TASKS");
		const runtime = {} as IAgentRuntime;
		const message = { content: { text: "message the coding agent" } } as Memory;
		await expect(
			umbrella?.handler?.(runtime, message, undefined, {
				parameters: { action: "send", sessionId: "session-1" },
			}),
		).resolves.toMatchObject({ success: true, data: { op: "send" } });
		// Execution keeps every context action, so the alias still dispatches
		// with its implicit operation when called by name.
		const alias = collectActionsFromContext(context).find(
			(action) => action.name === "TASKS_SEND",
		);
		await expect(
			alias?.handler?.(runtime, message, undefined, {
				parameters: { sessionId: "session-2" },
			}),
		).resolves.toMatchObject({ success: true, data: { op: "send" } });
		expect(
			calls.map((call) => [call.op, call.params.sessionId, call.params.action]),
		).toEqual([
			["send", "session-1", "send"],
			["send", "session-2", "send"],
		]);
		// A conflicting discriminator on an alias fails closed instead of
		// running another operation.
		await expect(
			alias?.handler?.(runtime, message, undefined, {
				parameters: { action: "create", task: "x" },
			}),
		).resolves.toMatchObject({ success: false });
		expect(calls).toHaveLength(2);
	});

	it("reconstructs each TASKS alias from the umbrella tool and its contract", () => {
		const { actions, context } = tasksFamily();
		const tool = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		})[0];
		const parentSchema = actionToJsonSchema(actions[0]);
		for (const contract of aliasContracts(tool?.description)) {
			const alias = actions.find((action) => action.name === contract.name);
			if (!alias) throw new Error(`${contract.name} missing from the context`);
			expect(reconstructAliasDescription(actions[0], contract)).toBe(
				alias.description,
			);
			expect(reconstructAliasSchema(parentSchema, contract)).toEqual(
				actionToJsonSchema(alias),
			);
		}
	});
});
