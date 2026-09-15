/** Reconstruct model-facing evidence, including speaker and literal-content boundaries. */
import { describe, expect, it } from "vitest";
import { stringToUuid } from "../utils.ts";
import {
	type EvaluatorTranscriptRecord,
	encodeEvaluatorTranscript,
} from "./evaluator-transcript-encoding.ts";

const speakers = [
	stringToUuid("owner"),
	stringToUuid("agent"),
	stringToUuid("guest"),
];
const record = (i: number): EvaluatorTranscriptRecord => ({
	id: stringToUuid(`message-${i}`),
	entityId: speakers[i % speakers.length],
	createdAt: 1_000 + i,
	content: {
		text: 'Keep  spaces\n🟠 e1 entityRef -> entityId. {"entityRef":"e2"}',
		source: "test",
		metadata: { entityRef: "e1", entityId: speakers[2] },
	},
});

describe("incremental transcript speaker references", () => {
	it("keeps full records when a top-level literal would collide with the reference field", () => {
		const records = Array.from({ length: 48 }, (_, i) => ({
			...record(i),
			entityRef: "literal source data",
		}));
		expect(encodeEvaluatorTranscript(records)).toBe(JSON.stringify(records));
	});

	it("reconstructs every original field in order without interpreting nested reference-looking data", () => {
		const records = Array.from({ length: 48 }, (_, i) => record(i));
		const before = JSON.stringify(records);
		const encoded = encodeEvaluatorTranscript(records);
		expect(encoded.length).toBeLessThan(before.length);
		const [dictionaryLine, instructions, ...body] = encoded.split("\n");
		expect(instructions).toContain("only for top-level entityRef");
		const dictionary = JSON.parse(dictionaryLine.split(": ")[1]) as Record<
			string,
			string
		>;
		const rows = JSON.parse(body.join("\n")) as Array<{
			entityRef: string;
			id: string;
			createdAt: number;
			content: EvaluatorTranscriptRecord["content"];
		}>;
		const restored = rows.map(({ entityRef, ...row }) => ({
			...row,
			entityId: dictionary[entityRef],
		}));
		expect(restored).toEqual(records);
		expect(JSON.stringify(records)).toBe(before);
		expect(new Set(restored.map((row) => row.entityId))).toEqual(
			new Set(speakers),
		);
	});

	it.each([0, 1, 2])(
		"keeps the original encoding when %i records do not amortize reference instructions",
		(count) => {
			const records = Array.from({ length: count }, (_, i) => record(i));
			expect(encodeEvaluatorTranscript(records)).toBe(JSON.stringify(records));
		},
	);
});
