/**
 * Shape of the Stage-1 `available_actions` discovery catalog: one
 * `NAME: description` line per action, complete descriptions, no JSON.
 * Pure function, no runtime.
 */
import { describe, expect, it } from "vitest";
import { formatAvailableActionsForPrompt } from "../services/message/context-assembly";

describe("formatAvailableActionsForPrompt", () => {
	it("renders one NAME: description line per action in catalog order", () => {
		const rendered = formatAvailableActionsForPrompt([
			{ name: "CALENDAR", description: "Calendar reads and writes." },
			{ name: "NOTES", description: "Sticky notes: create, list, update." },
		]);
		expect(rendered).toBe(
			"CALENDAR: Calendar reads and writes.\nNOTES: Sticky notes: create, list, update.",
		);
	});

	it("keeps the complete description and collapses embedded newlines", () => {
		// Live CONTACT description: a multi-line op table. Every word survives;
		// only the newline runs (and their indentation) become single spaces so
		// the catalog stays one line per action.
		const description =
			"Manage Rolodex contacts. Provide an `action` parameter:\n  create   — create a new contact.\n  read     — load a contact by id.";
		const rendered = formatAvailableActionsForPrompt([
			{ name: "CONTACT", description },
		]);
		expect(rendered).toBe(
			"CONTACT: Manage Rolodex contacts. Provide an `action` parameter: create   — create a new contact. read     — load a contact by id.",
		);
		for (const word of description.split(/\s+/)) {
			expect(rendered).toContain(word);
		}
	});

	it("does not quote or escape description text", () => {
		const rendered = formatAvailableActionsForPrompt([
			{ name: "ROOM", description: 'Use "scope=server" to mute a guild.' },
		]);
		expect(rendered).toBe('ROOM: Use "scope=server" to mute a guild.');
		expect(rendered).not.toContain('\\"');
	});

	it("renders a bare name when the description is empty", () => {
		expect(
			formatAvailableActionsForPrompt([{ name: "PING", description: "" }]),
		).toBe("PING");
	});

	it("renders the placeholder for an empty catalog", () => {
		expect(formatAvailableActionsForPrompt([])).toBe("(no actions available)");
	});
});
