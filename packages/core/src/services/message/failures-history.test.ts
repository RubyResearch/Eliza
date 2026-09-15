/** Exercises failure-history reference rendering and full-string fallback without a model or database. */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import type { State } from "../../types/state";
import { addHeader, conversationMessagesHeader } from "../../utils";
import { MessageFailures } from "./failures";

const message = {
	content: { text: "Current request stays complete." },
} as Memory;
const repeated =
	"19:00 (earlier) [owner] Owner: " +
	"Keep the complete original permission and correction. ".repeat(30) +
	"\nDo not save.  Two spaces.\n";
const entries = [
	repeated,
	"19:01 [agent] Agent: I will wait.",
	repeated,
	repeated,
];
function state(parts: string[], formatted: unknown = parts): State {
	return {
		text: "fallback state",
		values: {
			recentMessages: addHeader(
				conversationMessagesHeader(parts.length),
				parts.join("\n"),
			),
		},
		data: {
			providers: {
				RECENT_MESSAGES: {
					data: {
						recentMessages: parts.map(() => message),
						formattedMessageSegments: formatted,
					},
				},
			},
		},
	};
}
describe("failure reply complete history", () => {
	it("retains the full original and ordered repeated occurrences through existing history references", () => {
		const input = state(entries);
		const before = structuredClone(input);
		const result = new MessageFailures().resolveRecentMessagesForFailureReply(
			input,
			message,
		);
		expect(result.length).toBeLessThan(
			String(input.values.recentMessages).length,
		);
		expect(result).toContain(
			`[h1]\n${repeated}\n${entries[1]}\n[h3; same_text_as=h1]\n[h4; same_text_as=h1]`,
		);
		expect(result).toContain("including its speaker");
		expect(input).toEqual(before);
	});
	it.each([undefined, [], [repeated], [42], [...entries].reverse()])(
		"keeps the entire legacy text when entry provenance does not roundtrip: %j",
		(parts) => {
			const input = state(entries, parts === undefined ? null : parts);
			expect(
				new MessageFailures().resolveRecentMessagesForFailureReply(
					input,
					message,
				),
			).toBe(input.values.recentMessages);
		},
	);
	it("preserves changed timestamps, speakers and whitespace as distinct complete entries", () => {
		const parts = [
			repeated,
			repeated.replace("[owner]", "[other]"),
			repeated.replace("19:00", "19:02"),
			repeated.replace("Two spaces.", "Two  spaces."),
		];
		const input = state(parts);
		expect(
			new MessageFailures().resolveRecentMessagesForFailureReply(
				input,
				message,
			),
		).toBe(input.values.recentMessages);
	});
	it("leaves small histories and the unavailable-state fallback unchanged", () => {
		const input = state(["hi", "hi"]);
		expect(
			new MessageFailures().resolveRecentMessagesForFailureReply(
				input,
				message,
			),
		).toBe(input.values.recentMessages);
		expect(
			new MessageFailures().resolveRecentMessagesForFailureReply(
				{
					text: "Full fallback\nwith whitespace  ",
					values: {},
					data: {},
				} as State,
				message,
			),
		).toBe("Full fallback\nwith whitespace  ");
	});
});
