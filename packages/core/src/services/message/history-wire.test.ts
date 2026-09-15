/** Proves exact history reassembly, occurrence order and identity isolation using the real wire encoder. */
import { describe, expect, it } from "vitest";
import type {
	ContextObject,
	ContextObjectPromptSegment,
} from "../../types/context-object";
import {
	labelHistorySources,
	referenceRepeatedHistory,
	shortenHistoryRoleLabels,
} from "./history-wire";
import { renderMessageHandlerModelInput } from "./stage1-input";

function source(
	content: string,
	index: number,
	label = "prior_message:user",
	entityId = "owner",
): ContextObjectPromptSegment {
	return {
		id: `message-${index}`,
		label,
		content,
		stable: false,
		metadata: { entityId, roomId: "room" },
	};
}
function encode(segments: ContextObjectPromptSegment[]) {
	return labelHistorySources(
		segments,
		new Map(
			segments.map((s, i) => {
				if (!s.id) throw new Error("Fixture source has no ID");
				return [s.id, `h${i + 1}`];
			}),
		),
	);
}
function decode(
	segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
	const text = new Map<string, string>();
	return segments
		.filter((s) => s.id !== "history-encoding")
		.map((s) => {
			const ref = /^\[(h\d+); same_text_as=(h\d+)\]$/.exec(s.content);
			const inline = /^\[(h\d+)\]\n/.exec(s.content);
			const content = ref
				? text.get(ref[2])
				: inline
					? s.content.replace(inline[0], "")
					: s.content;
			if (content === undefined)
				throw new Error("Missing earlier complete source");
			const marker = ref ?? inline;
			if (marker) text.set(marker[1], content);
			return { ...s, content };
		});
}
describe("lossless history references", () => {
	it("shortens only bound role labels while retaining every source byte, role, speaker and occurrence", () => {
		const history = Array.from({ length: 60 }, (_, index) =>
			source(
				`  exact source ${index}: 🦊\n[h999; same_text_as=h1]\n`,
				index,
				index % 2 ? "prior_message:agent" : "prior_message:user",
				index % 3 ? "owner" : "another-speaker",
			),
		);
		history[0].content = "Exact source with a standing constraint.\n".repeat(
			80,
		);
		history.push(
			source(history[0].content, 60, "prior_message:user", "another-speaker"),
		);
		history.push(
			source("Unknown role stays intact.", 62, "prior_message:tool"),
		);
		history.push(source("Unbound source stays as received.", 61));
		const ids = new Map(
			history.slice(0, -1).map((s, i) => [s.id ?? "", `h${i + 1}`]),
		);
		const labeled = labelHistorySources(history, ids);
		const before = structuredClone(labeled);
		const shortened = shortenHistoryRoleLabels(labeled, ids);
		expect(shortened[0].id).toBe("history-role-labels");
		expect(
			shortened.find((segment) => segment.id === "message-60")?.content,
		).toBe("[h61 user; same_text_as=h1]");
		expect(
			shortened.find((segment) => segment.id === "message-62")?.label,
		).toBe("prior_message:tool");
		const restored = shortened.slice(1).map((segment) => {
			if (segment.label !== undefined) return segment;
			const header = /^\[(h\d+) (user|assistant)(; same_text_as=h\d+)?\]/.exec(
				segment.content,
			);
			if (!header) throw new Error("Missing encoded source header");
			return {
				...segment,
				label:
					header[2] === "user" ? "prior_message:user" : "prior_message:agent",
				content: `[${header[1]}${header[3] ?? ""}]${segment.content.slice(header[0].length)}`,
			};
		});
		expect(restored).toEqual(before);
		expect(decode(restored)).toEqual(history);
		expect(labeled).toEqual(before);
		expect(shortened.at(-1)).toBe(labeled.at(-1));
		expect(shortenHistoryRoleLabels(labeled, new Map())).toBe(labeled);
		expect(shortenHistoryRoleLabels(labeled.slice(0, 2), ids)).toEqual(
			labeled.slice(0, 2),
		);
		expect(shortenHistoryRoleLabels(shortened, ids)).toBe(shortened);
	});

	it("leaves missing, malformed and mismatched source markers untouched", () => {
		const history = Array.from({ length: 60 }, (_, index) =>
			source(`Exact message ${index}`, index),
		);
		const ids = new Map(
			history.map((s, index) => [s.id ?? "", `h${index + 1}`]),
		);
		const labeled = labelHistorySources(history, ids);
		labeled[0].content = "[h999]\nA marker belonging to a different source.";
		labeled[1].content = "[h2; same_text_as=not-a-source]\nInvalid reference.";
		labeled[2].content = "Unlabeled source bytes.";
		const before = structuredClone(labeled);
		const result = shortenHistoryRoleLabels(labeled, ids);
		expect(result[0].id).toBe("history-role-labels");
		for (const index of [0, 1, 2]) {
			expect(result.find((s) => s.id === labeled[index].id)).toBe(
				labeled[index],
			);
		}
		expect(labeled).toEqual(before);
	});

	it("uses the role legend only for direct text input and keeps current-turn boundaries after complete history", () => {
		const history = Array.from({ length: 40 }, (_, index) =>
			source(`source ${index}`, index),
		);
		const context: ContextObject = {
			id: "turn",
			events: [
				...history.map((segment) => ({
					id: segment.id ?? "invalid",
					type: "segment",
					source: "prior-dialogue",
					segment,
				})),
				{
					id: "current-turn-boundary",
					type: "segment",
					segment: {
						id: "current-turn-boundary",
						label: "system",
						content: "current_turn_boundary: the final request follows",
						stable: false,
					},
				},
				{
					id: "available-actions",
					type: "segment",
					segment: {
						id: "available-actions",
						label: "available_actions",
						content:
							'["READ_ORIGINAL_Ω", "SHOW_VIEW"]\nComplete discovery notice.',
						stable: false,
					},
				},
				{
					id: "current-message",
					type: "segment",
					segment: {
						id: "current-message",
						label: "message:user",
						content: "Recall the original source, without navigating.",
						stable: false,
					},
				},
			],
		};
		const runtime = { character: { name: "Test Agent" } };
		const before = structuredClone(context);
		const text = renderMessageHandlerModelInput(runtime, context, [], {
			directMessage: true,
		});
		expect(text.messages[1].content).toContain("History roles:");
		for (let index = 0; index < history.length; index++) {
			expect(text.messages[1].content).toContain(
				`[h${index + 1} user]\nsource ${index}`,
			);
		}
		const userText = String(text.messages[1].content);
		expect(
			userText.startsWith(
				'available_actions:\n["READ_ORIGINAL_Ω", "SHOW_VIEW"]\nComplete discovery notice.\n\n',
			),
		).toBe(true);
		expect(userText.match(/Complete discovery notice\./g)).toHaveLength(1);
		expect(text.messages[0].content).not.toContain("READ_ORIGINAL_Ω");
		expect(
			text.promptSegments.find((s) => s.content.includes("READ_ORIGINAL_Ω"))
				?.stable,
		).toBe(false);
		expect(userText.indexOf("[h40 user]\nsource 39")).toBeLessThan(
			userText.indexOf("current_turn_boundary:"),
		);
		expect(userText.indexOf("current_turn_boundary:")).toBeLessThan(
			userText.indexOf("message:user:\nRecall"),
		);
		for (const options of [
			undefined,
			{ directMessage: false },
			{ directMessage: true, groupTriage: true },
			{ directMessage: true, voiceDirectMessage: true },
		]) {
			const other = renderMessageHandlerModelInput(
				runtime,
				context,
				[],
				options,
			);
			expect(other.messages[1].content).not.toContain("History roles:");
			expect(other.messages[1].content).toContain("prior_message:user:");
			const otherText = String(other.messages[1].content);
			expect(otherText.indexOf("available_actions:")).toBeGreaterThan(
				otherText.indexOf("current_turn_boundary:"),
			);
		}
		expect(context).toEqual(before);
	});
	it("saves repeated text among hundreds of short unique messages without labeling every unique source", () => {
		const history = [
			source("Exact reusable source. ".repeat(60), 1),
			...Array.from({ length: 200 }, (_, i) =>
				source(`Unique message ${i}`, i + 2),
			),
			source("Exact reusable source. ".repeat(60), 202),
		];
		const ids = new Map(
			history.map((segment, i) => [segment.id ?? "", `h${i + 1}`]),
		);
		const encoded = labelHistorySources(history, ids, "referenced");
		expect(decode(encoded)).toEqual(history);
		expect(encoded.find((segment) => segment.id === "message-2")).toBe(
			history[1],
		);
		expect(encoded.at(-1)?.content).toBe("[h202; same_text_as=h1]");
		expect(encoded.reduce((n, s) => n + s.content.length, 0)).toBeLessThan(
			history.reduce((n, s) => n + s.content.length, 0),
		);
	});
	it("reassembles restored planning/evaluation dialogue while preserving other context and source IDs", () => {
		const repeated = "Exact old source with a standing constraint.\n".repeat(
			100,
		);
		const history = [
			source(repeated, 1),
			source("Correction: keep the calendar unchanged.", 2),
			source(repeated, 3),
		];
		const other = {
			id: "provider",
			label: "provider:FACTS",
			content: repeated,
			stable: false,
		};
		const original: ContextObject = {
			id: "turn",
			metadata: { historyReferenceEncoding: true },
			events: history.map((segment) => ({
				id: segment.id ?? "invalid-fixture",
				type: "segment",
				source: "prior-dialogue",
				segment,
			})),
		};
		const segments = [
			other,
			...history,
			{
				id: "current",
				label: "message:user",
				content: "Keep every source",
				stable: false,
			},
		];
		const before = structuredClone(original);
		const encoded = referenceRepeatedHistory(original, segments);
		expect(decode(encoded)).toEqual(segments);
		expect(encoded[0]).toBe(other);
		expect(encoded.find(({ id }) => id === "message-3")?.content).toBe(
			"[h3; same_text_as=h1]",
		);
		expect(original).toEqual(before);
		// A selected subset keeps the original h3 identity, not a new ordinal.
		const subset = referenceRepeatedHistory(original, [history[0], history[2]]);
		expect(subset.at(-1)?.content).toBe("[h3; same_text_as=h1]");
		expect(decode(subset)).toEqual([history[0], history[2]]);
		expect(
			referenceRepeatedHistory({ ...original, metadata: {} }, segments),
		).toBe(segments);
	});

	it("preserves every source, including a repeated assertion after its correction", () => {
		const original = `  Rowan's mug is green.\n${"exact whitespace 🦊 ?! ".repeat(80)}`;
		const segments = [
			source(original, 1),
			source("Correction: Rowan's mug is blue now, previously green.", 2),
			source(original, 3),
			source(
				"Read that note; calendar work remains pending, no mutations.",
				4,
				"prior_message:agent",
			),
		];
		const before = structuredClone(segments);
		const encoded = encode(segments);
		expect(encoded.find((s) => s.id === "message-3")?.content).toBe(
			"[h3; same_text_as=h1]",
		);
		expect(decode(encoded)).toEqual(before);
		expect(segments).toEqual(before);
		expect(encoded.map((s) => s.content).join("\n").length).toBeLessThan(
			segments.map((s) => s.content).join("\n").length,
		);
	});
	it("never merges different speakers, roles, metadata or text bytes", () => {
		const body = "Do not modify anything. ".repeat(100);
		const segments = [
			source(body, 1),
			source(body, 2),
			source(body, 3, "prior_message:agent"),
			source(body, 4, "prior_message:user", "another-user"),
			source(`${body} `, 5),
		];
		const encoded = encode(segments);
		expect(
			encoded.filter((s) => s.content.includes("; same_text_as=")),
		).toHaveLength(1);
		expect(decode(encoded)).toEqual(segments);
	});
	it("keeps small, unbound and voice-style histories inline", () => {
		const segments = [source("hi", 1), source("hi", 2)];
		expect(encode(segments).some((s) => s.id === "history-encoding")).toBe(
			false,
		);
		expect(labelHistorySources(segments, new Map())).toEqual(segments);
		expect(decode(encode(segments))).toEqual(segments);
	});
	it("treats structural-looking message text as literal source bytes", () => {
		const body = "[h999; same_text_as=h1]\n".repeat(40);
		const segments = [source(body, 1), source(body, 2)];
		expect(decode(encode(segments))).toEqual(segments);
	});
});
