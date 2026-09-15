/**
 * A Stage-1 candidate alias is represented through its complete umbrella
 * instead of a second native tool that repeats the umbrella's parameter
 * schema. Live 2026-09-13 ("move my chiropractor appointment to friday at
 * 4pm"): CALENDAR 23,471 chars beside CALENDAR_SEARCH_EVENTS 12,786 and
 * CALENDAR_UPDATE_EVENT 13,232 on each of three planner rounds, the same
 * `details` schema rendered three times per round.
 */
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import { buildPlannerToolsFromTieredActions } from "../actions/to-tool";
import { createContextObject } from "../runtime/context-object";
import type { Action } from "../types/components";
import {
	collectCanonicalPlannerActions,
	collectPlannerTools,
} from "./message/planned-tool";

const ENTRY_TEXT_DESCRIPTION = `Complete ledger entry text. ${"A direct alias tool repeats this property in full. ".repeat(12)}`;
const CONTRACTS_MARKER = "Complete alias contracts:";

interface AliasContract {
	name: string;
	description?: string;
	descriptionTail?: string;
	descriptionSuffix?: string;
	pins?: Record<string, string>;
	parameters?: {
		required?: string[];
		parentParameterNames?: string[];
		propertyOverrides?: Record<string, { enum?: string[] }>;
	};
}

function ledgerFamily(): Action[] {
	const parent: Action = {
		name: "LEDGER",
		description: "Create and remove ledger entries.",
		parameters: [
			{
				name: "action",
				description: "Operation",
				required: true,
				schema: { type: "string", enum: ["create", "delete"] },
			},
			{
				name: "id",
				description: "Entry identity",
				required: true,
				schema: { type: "string" },
			},
			{
				name: "text",
				description: ENTRY_TEXT_DESCRIPTION,
				required: false,
				schema: { type: "string" },
			},
		],
		handler: async () => ({ success: true }),
	};
	// Mirrors owner/context admission wrappers that spread registered Actions.
	return promoteSubactionsToActions(parent).map((action) => ({ ...action }));
}

function contextFor(actions: readonly Action[]) {
	return createContextObject({
		id: "umbrella-alias-consolidation",
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
		text.slice(start + CONTRACTS_MARKER.length).trim(),
	) as AliasContract[];
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("umbrella alias consolidation on the planner wire", () => {
	it("drops a Stage-1 candidate alias whose complete umbrella is exposed beside it", () => {
		const actions = ledgerFamily();
		expect(actions.map((action) => action.name)).toEqual([
			"LEDGER",
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		const tools = collectPlannerTools(contextFor(actions), undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"LEDGER",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(collectCanonicalPlannerActions(actions)).toEqual([actions[0]]);
		const umbrella = tools[0];
		expect(JSON.stringify(umbrella?.parameters)).toContain(
			'"enum":["create","delete"]',
		);
		const contracts = aliasContracts(umbrella?.description);
		expect(contracts.map((contract) => contract.name)).toEqual([
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		// The pinned discriminator is the only property an alias overrides, so
		// the contract carries `pins` instead of a repeated schema override.
		expect(contracts[0]?.pins).toEqual({ action: "create" });
		expect(contracts[0]?.parameters?.propertyOverrides).toBeUndefined();
		// Every LEDGER alias accepts the complete umbrella property list and
		// extends its description with the default subaction blurb, so the
		// contract omits the names and the suffix; only the alias's own
		// `required` (the umbrella's `id` without the pinned discriminator)
		// stays explicit.
		expect(contracts[0]?.parameters?.parentParameterNames).toBeUndefined();
		expect(contracts[0]?.parameters?.required).toEqual(["id"]);
		expect(contracts[0]?.descriptionSuffix).toBeUndefined();
		// The umbrella schema is rendered once; alias contracts reference its
		// properties instead of repeating them.
		expect(occurrences(JSON.stringify(tools), ENTRY_TEXT_DESCRIPTION)).toBe(1);
		// One tool per family member (the pre-consolidation shape for a named
		// alias) costs more than the umbrella carrying alias contracts.
		const family = tools.filter((tool) => tool.name.startsWith("LEDGER"));
		const perMember = buildPlannerToolsFromTieredActions(actions, {
			expandSubActions: false,
		});
		expect(perMember.map((tool) => tool.name)).toEqual([
			"LEDGER",
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		expect(JSON.stringify(family).length).toBeLessThan(
			JSON.stringify(perMember).length,
		);
	});

	it("keeps an alias direct when its umbrella is not on the surface", () => {
		const alias = ledgerFamily().filter(
			(action) => action.name === "LEDGER_CREATE",
		);
		const tools = collectPlannerTools(contextFor(alias), undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"LEDGER_CREATE",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(tools[0]?.description).not.toContain(CONTRACTS_MARKER);
		expect(occurrences(JSON.stringify(tools), ENTRY_TEXT_DESCRIPTION)).toBe(1);
		expect(collectCanonicalPlannerActions(alias)).toEqual(alias);
	});

	it("renders an authorized umbrella the same way when no alias was named", () => {
		const actions = ledgerFamily();
		const tools = collectPlannerTools(contextFor(actions), undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"LEDGER",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(aliasContracts(tools[0]?.description).map((c) => c.name)).toEqual([
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		// The wire is a pure function of the authorized surface, so a
		// differently ordered but identical context renders identically.
		const reordered = collectPlannerTools(
			contextFor([actions[1], actions[2], actions[0]]),
			undefined,
			{ canonicalFamilies: true },
		);
		expect(reordered).toEqual(tools);
	});

	it("still keeps every alias direct while a sibling is unauthorized", () => {
		const actions = ledgerFamily().filter(
			(action) => action.name !== "LEDGER_DELETE",
		);
		const tools = collectPlannerTools(contextFor(actions), undefined, {
			canonicalFamilies: true,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"LEDGER",
			"LEDGER_CREATE",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		expect(collectCanonicalPlannerActions(actions)).toEqual(actions);
	});

	it("states a preamble shared by aliases once when the umbrella's own description moved on (live: MESSAGE, 27 × 760 chars)", () => {
		const actions = ledgerFamily();
		const parent = actions[0];
		if (!parent) throw new Error("no parent");
		const base = parent.description;
		const preamble = `${"Addressed ledger action with a long authored lead that every subaction repeats verbatim. ".repeat(3)}Public feed publishing uses POST.`;
		// The virtuals were promoted from `preamble`; the umbrella's description
		// was then replaced by routing text, so no alias extends it any more.
		for (const action of actions.slice(1)) {
			action.description = action.description.replace(base, preamble);
		}
		parent.description =
			"Routing text for the ledger family; do NOT use for notes.";
		const tools = collectPlannerTools(contextFor(actions), undefined, {
			canonicalFamilies: true,
		});
		const umbrella = tools[0];
		const description = umbrella?.description ?? "";
		expect(occurrences(description, preamble)).toBe(1);
		const contracts = aliasContracts(description);
		expect(contracts.map((contract) => contract.name)).toEqual([
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		// The remainder of each alias description is the default blurb, so the
		// contract carries neither description field.
		expect(contracts[0]?.description).toBeUndefined();
		expect(contracts[0]?.descriptionTail).toBeUndefined();
		expect(contracts[0]?.descriptionSuffix).toBeUndefined();
	});
});
