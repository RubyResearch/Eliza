/**
 * Exercises lossless promoted-family tool rendering and dispatch against real
 * action handlers. No model or connector is called; provider wire and live
 * planner behavior are verified separately by the integration workflow.
 */
import { describe, expect, it } from "vitest";
import { actionToJsonSchema, type JsonSchema } from "../actions/action-schema";
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import { validateSchema } from "../actions/validate-tool-args";
import { AgentRuntime } from "../runtime";
import { createContextObject } from "../runtime/context-object";
import type { Action } from "../types/components";
import {
	collectActionsFromContext,
	collectCanonicalPlannerActions,
	collectPlannerTools,
} from "./message/planned-tool";

function fixture() {
	const stored = new Map<string, string>();
	const parent: Action = {
		name: "RECORDS",
		description: "Create and update complete records.",
		parameters: [
			{
				name: "action",
				description: "Operation",
				required: true,
				schema: { type: "string", enum: ["create", "update"] },
			},
			{
				name: "id",
				description: "Record identity",
				required: true,
				schema: { type: "string" },
			},
			{
				name: "text",
				description: "Complete record text",
				required: true,
				schema: { type: "string" },
			},
		],
		handler: async (_runtime, _message, _state, options) => {
			const params = options?.parameters;
			if (typeof params?.id !== "string" || typeof params.text !== "string")
				throw new Error("Missing record input");
			if (params.action === "update" && !stored.has(params.id))
				return { success: false, error: "Record absent" };
			stored.set(params.id, params.text);
			return { success: true, data: { savedText: stored.get(params.id) } };
		},
	};
	// Mirrors owner/context admission wrappers that spread registered Actions.
	const actions = promoteSubactionsToActions(parent, {
		overrides: {
			create: {
				description: "Creation must preserve the supplied record boundary.",
			},
		},
	}).map((action) => ({
		...action,
	}));
	const context = createContextObject({
		id: "canonical-tools",
		events: actions.map((action) => ({
			id: `tool:${action.name}`,
			type: "tool",
			tool: { name: action.name, action },
		})),
	});
	return { actions, context, stored };
}

describe("canonical promoted-family planner surface", () => {
	it("retains complete arguments and dispatches successive operations through the umbrella", async () => {
		const { actions, context, stored } = fixture();
		const tools = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"RECORDS",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		const wire = JSON.parse(JSON.stringify(tools));
		const text = `${"complete payload ".repeat(12000)}last record boundary`;
		const runtime = new AgentRuntime({
			character: { name: "Canonical dispatch" },
			disableBasicCapabilities: true,
		});
		for (const action of actions) runtime.registerAction(action);
		expect(collectCanonicalPlannerActions(actions)).toEqual([actions[0]]);
		for (const action of ["create", "update"]) {
			const params = { action, id: "record", text: `${action}: ${text}` };
			const errors: string[] = [];
			validateSchema(wire[0].parameters as JsonSchema, params, "", errors);
			expect(errors).toEqual([]);
			const result = await actions[0].handler?.(
				runtime,
				{
					agentId: runtime.agentId,
					entityId: runtime.agentId,
					roomId: runtime.agentId,
					content: { text: "Save the complete record" },
				},
				undefined,
				{ parameters: params },
			);
			expect(result).toMatchObject({
				success: true,
				data: { savedText: params.text },
			});
			expect(stored.get("record")).toBe(params.text);
		}
		expect(collectActionsFromContext(context)).toEqual(actions);
	});

	it("represents an explicitly selected generated alias through its umbrella and keeps it executable", async () => {
		const { actions, context, stored } = fixture();
		// Stage 1 naming RECORDS_CREATE adds no second native tool: the umbrella
		// is always exposed beside a named alias, and a direct alias tool repeated
		// the umbrella's complete parameter schema on every planner round.
		const tools = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"RECORDS",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(tools[0]?.description).toContain('"name":"RECORDS_CREATE"');
		expect(collectCanonicalPlannerActions(actions)).toEqual([actions[0]]);
		// Execution keeps every context action, so the alias still dispatches
		// with its implicit operation when called by name.
		const alias = collectActionsFromContext(context).find(
			(action) => action.name === "RECORDS_CREATE",
		);
		const runtime = new AgentRuntime({
			character: { name: "Alias dispatch" },
			disableBasicCapabilities: true,
		});
		const result = await alias?.handler?.(
			runtime,
			{
				agentId: runtime.agentId,
				entityId: runtime.agentId,
				roomId: runtime.agentId,
				content: { text: "Create" },
			},
			undefined,
			{ parameters: { id: "alias", text: "complete alias receipt" } },
		);
		expect(result).toMatchObject({ success: true });
		expect(stored.get("alias")).toBe("complete alias receipt");
	});

	it("does not hide an authorized alias when its umbrella is denied", () => {
		const { actions } = fixture();
		const authorized = actions.filter((action) => action.name !== "RECORDS");
		expect(collectCanonicalPlannerActions(authorized)).toEqual(authorized);
	});

	it("keeps independently implemented children even when named like generated aliases", () => {
		const child: Action = {
			name: "RECORDS_EXPORT",
			description: "Independent export",
			handler: async () => ({ success: true, data: { exported: true } }),
		};
		const { actions } = fixture();
		actions[0].subActions?.push(child);
		const retained = collectCanonicalPlannerActions([...actions, child]);
		expect(retained).toEqual([actions[0], child]);
	});

	it("retains an alias if the admitted parent no longer declares its dispatch relation", () => {
		const { actions } = fixture();
		actions[0].subActions = [];
		expect(collectCanonicalPlannerActions(actions)).toEqual(actions);
	});
	it("does not consolidate a family with an unauthorized sibling", () => {
		const { actions } = fixture();
		const authorized = actions.filter(
			(action) => action.name !== "RECORDS_UPDATE",
		);
		expect(collectCanonicalPlannerActions(authorized)).toEqual(authorized);
	});
	it("reconstructs each alias parameter contract from complete parent schemas and retained guidance", () => {
		const { actions, context } = fixture();
		const tool = collectPlannerTools(context, undefined, {
			canonicalFamilies: true,
		})[0];
		const contracts: Array<{
			name: string;
			description?: string;
			descriptionSuffix?: string;
			pins?: Record<string, string>;
			parameters?: JsonSchema & {
				parentParameterNames?: string[];
				propertyOverrides?: Record<string, JsonSchema>;
			};
		}> = JSON.parse(tool.description.split("\n").at(-1) ?? "invalid");
		for (const contract of contracts) {
			const original = actions.find((action) => action.name === contract.name);
			if (!original)
				throw new Error("Alias action missing from dispatch context");
			// The alias description extends the umbrella's, so the contract
			// carries at most the suffix (create's override blurb; update's
			// default " — subaction = update" is implied by its pin); every
			// RECORDS alias accepts the complete umbrella property list, so the
			// contract omits the names and spells out only its own `required`.
			expect(contract.description).toBeUndefined();
			const pin = Object.values(contract.pins ?? {})[0];
			const suffix = contract.descriptionSuffix ?? ` — subaction = ${pin}`;
			expect(`${actions[0].description}${suffix}`).toBe(original.description);
			const {
				parentParameterNames,
				propertyOverrides = {},
				...outerSchema
			} = contract.parameters ?? {};
			expect(parentParameterNames).toBeUndefined();
			expect(propertyOverrides).toEqual({});
			const parentSchema = actionToJsonSchema(actions[0]);
			const schema = {
				type: "object",
				required: [],
				additionalProperties: parentSchema.additionalProperties,
				...outerSchema,
				properties: Object.fromEntries(
					Object.keys(parentSchema.properties).map((name) => {
						const parentProperty = parentSchema.properties[name];
						const pinned = contract.pins?.[name];
						return [
							name,
							pinned === undefined
								? parentProperty
								: {
										...parentProperty,
										description: `Subaction discriminator (auto-set to "${pinned}" for this virtual; do not change).`,
										enum: [pinned],
										default: pinned,
									},
						];
					}),
				),
			};
			expect(schema).toEqual(actionToJsonSchema(original));
			const validErrors: string[] = [];
			const operation = original.parameters?.find(
				(parameter) => parameter.name === "action",
			)?.schema?.enum?.[0];
			validateSchema(
				schema,
				{ action: operation, id: "record", text: "complete boundary" },
				"",
				validErrors,
			);
			expect(validErrors).toEqual([]);
			const invalidErrors: string[] = [];
			validateSchema(
				schema,
				{
					action: "unrelated-operation",
					id: "record",
					text: "complete boundary",
				},
				"",
				invalidErrors,
			);
			expect(invalidErrors.length).toBeGreaterThan(0);
		}
	});
	it("keeps an alias direct if its umbrella requires a parameter excluded from that operation", () => {
		const parent: Action = {
			name: "FILES",
			description: "File operations",
			parameters: [
				{
					name: "action",
					description: "Operation",
					required: true,
					schema: { type: "string", enum: ["create", "list"] },
				},
				{
					name: "body",
					description: "New file body",
					required: true,
					subactions: ["create"],
					schema: { type: "string" },
				},
			],
		};
		const actions = [...promoteSubactionsToActions(parent)];
		expect(
			collectCanonicalPlannerActions(actions).map((action) => action.name),
		).toContain("FILES_LIST");
	});
});
