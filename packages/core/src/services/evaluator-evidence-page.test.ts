import { describe, expect, it } from "vitest";
import type { Memory } from "../types/index.ts";
import {
	previousEvidencePage,
	selectSharedEvidencePages,
} from "./evaluator-evidence-page.ts";

const rows = Array.from({ length: 40 }, (_, i) => ({
	id: `source-${i}`,
	entityId: "speaker",
	roomId: "room",
	createdAt: i,
	content: {
		text: `${i}: violet notebook\n🍊 ${"complete source ".repeat(i + 1)}`,
	},
})) as Array<Memory & { id: NonNullable<Memory["id"]> }>;
describe("historical evidence continuation", () => {
	it("budgets evidence without the recovery carrier while returning complete records", () => {
		const source = structuredClone(rows[0]);
		source.content.chatIdempotency = { response: "recovery".repeat(30_000) };
		const original = structuredClone(source);
		const page = previousEvidencePage([source, rows[1]], rows[1].id, 1024);
		expect(page.messages).toEqual([original]);
		expect(source).toEqual(original);
		expect(
			selectSharedEvidencePages([page], (entry) => entry.messages, 1024),
		).toEqual({ selected: [page], deferred: [] });
		const authored = {
			...source,
			content: { text: "evidence".repeat(30_000) },
		};
		expect(() =>
			selectSharedEvidencePages([[authored]], (entry) => entry, 1024),
		).toThrow(expect.objectContaining({ code: "EVALUATOR_SOURCE_TOO_LARGE" }));
	});
	it("reassembles ordered Unicode records exactly through every explicit cursor page", () => {
		const budget = Math.max(
			...rows.map(
				(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
			),
		);
		let before = rows[39].id;
		const restored: Memory[] = [];
		for (;;) {
			const page = previousEvidencePage(rows, before, budget);
			restored.unshift(...page.messages);
			if (!page.hasEarlier) break;
			const cursor = page.messages[0]?.id;
			if (!cursor) throw new Error("Continuation lost its source cursor");
			before = cursor;
		}
		expect(restored).toEqual(rows.slice(0, -1));
	});
	it("rejects missing/foreign cursors and oversized complete records instead of clipping", () => {
		expect(() => previousEvidencePage(rows, "foreign-source", 1000)).toThrow(
			expect.objectContaining({ code: "EVALUATOR_REFERENCE_CURSOR_INVALID" }),
		);
		expect(() => previousEvidencePage(rows, rows[1].id, 4)).toThrow(
			expect.objectContaining({ code: "EVALUATOR_SOURCE_TOO_LARGE" }),
		);
		expect(previousEvidencePage(rows, rows[0].id, 1000)).toEqual({
			messages: [],
			hasEarlier: false,
		});
	});
});
