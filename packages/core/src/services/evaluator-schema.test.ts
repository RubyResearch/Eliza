import { describe, expect, it } from "vitest";
import { preferenceEvaluator } from "../features/advanced-capabilities/evaluators/preference-items.ts";
import { factMemoryEvaluator } from "../features/advanced-capabilities/evaluators/reflection-items.ts";
import { longTermMemoryEvaluator } from "../features/advanced-memory/evaluators/memory-items.ts";
import type { JSONSchema } from "../types/model.ts";
import { requireIncrementalSourceCitations } from "./evaluator-schema.ts";

describe("incremental evaluator citation schema", () => {
	for (const evaluator of [
		factMemoryEvaluator,
		preferenceEvaluator,
		longTermMemoryEvaluator,
	]) {
		it(`requires every declared ${evaluator.name} citation without changing its legacy schema`, () => {
			const original = structuredClone(evaluator.schema);
			const resolved = requireIncrementalSourceCitations(evaluator.schema);
			let citations = 0;
			function inspect(schema: JSONSchema) {
				if (schema.properties?.sourceMessageIds) {
					citations++;
					expect(schema.required).toContain("sourceMessageIds");
				}
				for (const value of Object.values(schema)) {
					if (Array.isArray(value)) {
						for (const child of value)
							if (child && typeof child === "object")
								inspect(child as JSONSchema);
					} else if (value && typeof value === "object")
						inspect(value as JSONSchema);
				}
			}
			inspect(resolved);
			expect(citations).toBeGreaterThan(0);
			expect(evaluator.schema).toEqual(original);
			expect(JSON.stringify(original)).not.toMatch(
				/"required":\[[^\]]*"sourceMessageIds"/,
			);
		});
	}
	it("visits schema positions and preserves data-valued annotations and Boolean schemas", () => {
		const citation: JSONSchema = {
			type: "object",
			properties: {
				sourceMessageIds: { type: "array", items: { type: "string" } },
			},
			required: ["value"],
		};
		const schema: JSONSchema = {
			allOf: [{ anyOf: [{ oneOf: [{ items: [citation] }] }] }],
			$defs: { evidence: citation },
			additionalProperties: false,
			default: citation,
			examples: [citation],
		};
		const result = requireIncrementalSourceCitations(schema);
		expect(result.additionalProperties).toBe(false);
		expect(result.default).toEqual(citation);
		expect(result.examples).toEqual([citation]);
		expect(JSON.stringify(result.$defs)).toContain(
			'"required":["value","sourceMessageIds"]',
		);
		expect(JSON.stringify(result.allOf)).toContain(
			'"required":["value","sourceMessageIds"]',
		);
		expect(requireIncrementalSourceCitations(result)).toEqual(result);
	});
});
