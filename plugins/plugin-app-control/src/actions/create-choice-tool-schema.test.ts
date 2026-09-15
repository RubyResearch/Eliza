/**
 * Exercises the real planner-to-provider schema boundary so optional saved
 * choice bindings are never required placeholders on ordinary create calls.
 */
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../../packages/core/src/actions/promote-subactions.js";
import {
	buildPlannerToolsFromActions,
	CORE_PLANNER_TERMINALS,
} from "../../../../packages/core/src/actions/to-tool.js";
import {
	type JsonSchema,
	validateToolArgs,
} from "../../../../packages/core/src/actions/validate-tool-args.js";
import { withTurnScopeToolArg } from "../../../../packages/core/src/runtime/planner-loop.js";
import { parseAndValidate } from "../../../../packages/core/src/runtime/validated-model-call.js";
import { isObjectRecord } from "../../../../packages/core/src/utils/type-guards.js";
import {
	__INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
	__INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
} from "../../../plugin-openai/models/text.js";
import { createAppAction } from "./app.js";
import { createShowViewAction, createViewsAction } from "./views.js";

it.each([false, true])(
	"enforces navigation and completion arguments without inheriting the polymorphic parent opt-out (Cerebras: %s)",
	(cerebrasMode) => {
		const action = createShowViewAction();
		const tools = withTurnScopeToolArg([
			...buildPlannerToolsFromActions([action]),
			...CORE_PLANNER_TERMINALS,
		]);
		const normalized = normalizeNativeToolsForCall(tools, {
			cerebrasMode,
		}).tools;
		if (!normalized) throw new Error("navigation tools were not normalized");
		for (const [name, tool] of Object.entries(normalized)) {
			const wire = tool as {
				strict?: boolean;
				inputSchema: { jsonSchema: ActionParameterSchema };
			};
			expect(wire.strict).toBe(true);
			expect(wire.inputSchema.jsonSchema.required).toContain(
				"eliza_turn_scope",
			);
			if (name === "VIEWS_SHOW") {
				expect(wire.inputSchema.jsonSchema.required).toEqual([
					"view",
					"navigationStepId",
					"eliza_turn_scope",
				]);
				expect(wire.inputSchema.jsonSchema.additionalProperties).toBe(false);
			}
		}
		expect(validateToolArgs(action, { view: "notes" }).valid).toBe(false);
		expect(
			validateToolArgs(action, { view: "notes", navigationStepId: "step-1" })
				.valid,
		).toBe(true);
	},
);

describe.each([
	["APP", createAppAction],
	["VIEWS", createViewsAction],
] as const)("%s optional saved choice arguments", (name, createAction) => {
	it.each([false, true])(
		"accepts an unbound create through the provider schema and runtime (Cerebras: %s)",
		(cerebrasMode) => {
			const family = promoteSubactionsToActions(createAction());
			const action =
				family.find((candidate) => candidate.name === `${name}_CREATE`) ??
				family.find((candidate) => candidate.name === name);
			if (!action) throw new Error("Create action is unavailable");
			const normalized = normalizeNativeToolsForCall(
				buildPlannerToolsFromActions(family),
				{ cerebrasMode },
			);
			const registeredName = normalized.toolNameMap.get(action.name);
			if (!registeredName || !normalized.tools)
				throw new Error("Create tool was not normalized");
			const tool = normalized.tools[registeredName] as {
				inputSchema: { jsonSchema: JsonSchema };
			};
			const args = { action: "create", intent: "Build a reading tracker" };
			// VIEWS permits extra arguments; strict transport carries that empty
			// map losslessly while saved task/choice bindings remain omitted.
			const modelArgs =
				cerebrasMode && name === "VIEWS"
					? { ...args, __eliza_record_entries: [] }
					: args;
			const wire = parseAndValidate(
				JSON.stringify(modelArgs),
				tool.inputSchema.jsonSchema,
			);
			expect(wire, JSON.stringify(wire.errors)).toMatchObject({
				valid: true,
				parsed: modelArgs,
			});
			if (!wire.parsed)
				throw new Error("Valid wire arguments were not returned");
			const restored = restoreRecordArgToolCalls(
				[{ toolName: registeredName, input: wire.parsed }],
				normalized.recordArgTransformsByTool,
			)?.[0];
			if (!isObjectRecord(restored) || !isObjectRecord(restored.input)) {
				throw new Error("Provider arguments were not restored");
			}
			expect(restored.input).toEqual(args);
			expect(validateToolArgs(action, restored.input)).toMatchObject({
				valid: true,
				args,
			});
			const invalid = { ...modelArgs, taskId: 42 };
			expect(
				parseAndValidate(JSON.stringify(invalid), tool.inputSchema.jsonSchema)
					.valid,
			).toBe(false);
			expect(validateToolArgs(action, invalid).valid).toBe(false);
		},
	);

	it("accepts ordinary create without a binding and still rejects mistyped taskId", () => {
		const family = promoteSubactionsToActions(createAction());
		for (const action of family.filter(
			(candidate) =>
				candidate.name === name || candidate.name === `${name}_CREATE`,
		)) {
			const args = { action: "create", intent: "Build a reading tracker" };
			expect(validateToolArgs(action, args)).toMatchObject({
				valid: true,
				args,
			});
			expect(validateToolArgs(action, { ...args, taskId: 42 }).valid).toBe(
				false,
			);
		}
	});
});
