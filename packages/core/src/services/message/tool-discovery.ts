/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * operations or explicitly requested families to this turn's native tools.
 * The normal executor still checks their permissions before dispatch.
 */
import { DISCOVER_TOOLS_NAME } from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import { buildActionCatalog } from "../../runtime/action-catalog";
import { actionGateRejection } from "../../runtime/action-gate";
import type { Action } from "../../types/components";
import type { AgentContext, RoleGateRole } from "../../types/contexts";
import type { ContextObject } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import type { ToolDefinition } from "../../types/model";
import { isObjectRecord } from "../../utils/type-guards";
import { mergeAgentContexts } from "./action-surface.js";
import {
	collectBudgetedStageOneCandidateActions,
	collectPlannerTools,
} from "./planned-tool.js";

/**
 * The complete catalog DISCOVER_TOOLS advertises: every runtime action the
 * actor may run under the action's OWN declared contexts merged with the
 * turn's selected contexts (the executor gate's rule), with private,
 * disclosure and role gates unchanged. Building it from the Stage-1 context
 * slice hid context-validated families (MESSAGE on a general-routed turn) and
 * cost a whole planner round per miss (live 2026-09-14).
 */
export function collectDiscoveryCatalogActions(args: {
	actions: readonly Action[];
	message: Memory;
	selectedContexts: readonly AgentContext[];
	userRoles: readonly RoleGateRole[];
}): Action[] {
	return args.actions.filter(
		(action) =>
			actionGateRejection(action, {
				message: args.message,
				userRoles: args.userRoles,
				activeContexts: mergeAgentContexts(
					args.selectedContexts,
					action.contexts,
				),
			}) === undefined,
	);
}

export function createPlannerToolDiscoveryAction(
	authorizedActions: readonly Action[],
	onDiscover: (actions: Action[]) => void,
	/** Resolve named operations; [] requests fresh admission of the full catalog. */
	resolveAdditionalActions?: (names: string[]) => Promise<Action[]>,
): Action {
	const actionsByName = new Map(
		authorizedActions.map((action) => [action.name, action]),
	);
	if (actionsByName.has(DISCOVER_TOOLS_NAME)) {
		throw new ElizaError(
			"Planner discovery name conflicts with a registered action",
			{
				code: "PLANNER_DISCOVERY_NAME_CONFLICT",
			},
		);
	}
	const catalogFor = (actions: readonly Action[]) => {
		const names = new Set(actions.map((action) => action.name));
		return buildActionCatalog(
			actions.map((action) => ({
				...action,
				subActions: action.subActions?.filter((child) =>
					names.has(typeof child === "string" ? child : child.name),
				),
			})),
		);
	};
	const catalog = catalogFor(authorizedActions);
	return {
		name: DISCOVER_TOOLS_NAME,
		// Names and children only: the routing hints repeated a 14.9K-character
		// catalog in every planner round (audit 2026-09-13); a loaded family
		// carries its complete description on the next round, and names=[]
		// reads the full descriptions on demand without loading any schema.
		description:
			"Load complete tool schemas from the authorized name index below when an exposed tool does not cover an intent. " +
			"Pass exact child names to load those operations, or parent names to load their complete authorized families. Pass names=[] to read the complete family descriptions and routing hints if the names alone are ambiguous. " +
			(resolveAdditionalActions
				? "The inline index lists families admitted for the current routing contexts. If the needed domain is absent or its name is unknown, names=[] reads a fresh catalog across routing contexts. Other exact registered names may also be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
				: "") +
			"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.\n" +
			"Index maps each exact family name to its exact child names (an empty list means no children):\n" +
			JSON.stringify(
				Object.fromEntries(
					catalog.parents.map((parent) => [parent.name, parent.childNames]),
				),
			),
		parameters: [
			{
				name: "names",
				description:
					"Exact authorized parent or child tool names to load; [] reads the full catalog descriptions without loading tools.",
				required: true,
				schema: { type: "array", items: { type: "string" } },
			},
		],
		validate: async () => true,
		handler: async (_runtime, _message, _state, options) => {
			const names = isObjectRecord(options?.parameters)
				? options.parameters.names
				: undefined;
			if (
				!Array.isArray(names) ||
				!names.every(
					(name): name is string => typeof name === "string" && name.length > 0,
				)
			) {
				// A miss loads nothing and changes nothing: it steers the model
				// (coachingFailure) and never owns the turn's final message, which
				// otherwise shipped "the available runtime step failed" over a
				// later successful answer (live 2026-09-14, tj-8ce2f7a7e5384b).
				// readOnlyOperation lets the planner loop feed the error back for
				// a corrected call, exactly as it does for an unadmitted name.
				return {
					success: false,
					error:
						"Select exact names from the authorized discovery catalog. No tools were loaded.",
					data: { readOnlyOperation: true, coachingFailure: true },
				};
			}
			if (names.length === 0) {
				// A mistaken Stage-1 domain must not make another authorized
				// domain undiscoverable. This explicit read refreshes admission;
				// it neither loads schemas nor changes execution permission.
				const completeCatalog = resolveAdditionalActions
					? catalogFor(await resolveAdditionalActions([]))
					: catalog;
				return {
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					text: "Complete authorized catalog descriptions. Select exact names to load schemas; no domain work was performed.",
					data: {
						readOnlyOperation: true,
						catalog: completeCatalog.parents.map((parent) => ({
							name: parent.name,
							description: parent.source.description,
							contexts: parent.source.contexts,
							similes: parent.source.similes,
							routingHint: parent.routingHint,
							children: parent.childNames,
							childDefinitions: parent.children.map((child) => ({
								name: child.name,
								description: child.source.description,
								contexts: child.source.contexts,
								similes: child.source.similes,
							})),
						})),
					},
				};
			}
			// Stage 1 can omit a domain even when the planner explicitly requests
			// its family. Reuse canonical candidate admission with that exact name;
			// never turn routing context into a permanent capability denial.
			const admitted = new Map(actionsByName);
			if (
				resolveAdditionalActions &&
				names.some((name) => !admitted.has(name))
			) {
				for (const action of await resolveAdditionalActions(names))
					admitted.set(action.name, action);
			}
			if (!names.every((name) => admitted.has(name))) {
				// Same coaching miss as above: no schema loaded, nothing to own.
				return {
					success: false,
					error:
						"Requested tool family was not admitted by the current capability and permission checks. No tools were loaded. Select an exact relevant name from availableNames, or use names=[] if you need complete catalog descriptions. Do not substitute an unrelated family for the requested operation.",
					data: {
						readOnlyOperation: true,
						coachingFailure: true,
						availableNames: [...admitted.keys()],
					},
				};
			}
			for (const [name, action] of admitted) actionsByName.set(name, action);
			const selected = collectBudgetedStageOneCandidateActions({
				actions: [...actionsByName.values()],
				candidateActions: names,
				contexts: [],
				deferUnselectedContexts: true,
			});
			onDiscover(selected);
			return {
				success: true,
				transcriptVisibility: "internal",
				modelReplyRequired: true,
				text: "Tool schemas loaded. Only schema discovery ran; no domain action or data mutation ran. Continue with any requested domain work.",
				data: {
					readOnlyOperation: true,
					loadedTools: selected.map((action) => action.name),
				},
			};
		},
		examples: [],
	};
}

/** Discovery adds only the requested operations' complete schemas. Preserve the
 * existing budgeted definitions instead of expanding unrelated umbrellas. */
export function appendDiscoveredPlannerTools(
	context: ContextObject,
	current: ToolDefinition[],
	discovered: readonly Action[],
): void {
	const names = new Set(current.map((tool) => tool.name));
	for (const tool of collectPlannerTools(context, discovered)) {
		if (!names.has(tool.name)) {
			current.push(tool);
			names.add(tool.name);
		}
	}
}
