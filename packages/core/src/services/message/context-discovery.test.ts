/** Verifies enumerable reference schemas match discovery validation without
 * changing custom field contracts or the original registry schema. */
import { describe, expect, it } from "vitest";
import type { JSONSchema } from "../../types/model";
import {
	readContextRequests,
	withAvailableContextRequests,
} from "./context-discovery";

function schema(): JSONSchema & { properties: Record<string, JSONSchema> } {
	return {
		type: "object",
		required: ["contextRequests", "replyText"],
		properties: {
			contextRequests: {
				type: "array",
				items: { type: "string" },
				description: "Read complete authorized references.",
			},
			replyText: { type: "string" },
		},
	};
}

describe("enumerable context request schema", () => {
	it("keeps every current reference and excludes unavailable or loaded names", () => {
		const original = schema();
		const before = structuredClone(original);
		const available = new Set(["FACTS", "CONTEXT_CATALOG", "custom:provider"]);
		const projected = withAvailableContextRequests(original, available);
		expect(projected.properties?.contextRequests?.items).toEqual({
			type: "string",
			enum: [...available],
		});
		expect(
			readContextRequests({ contextRequests: [...available] }, available),
		).toEqual([...available]);
		for (const invalid of ["history:search:Rowan", "history:all", "loaded"])
			expect(() =>
				readContextRequests({ contextRequests: [invalid] }, available),
			).toThrow();
		expect(original).toEqual(before);
		expect(projected.properties?.replyText).toBe(
			original.properties?.replyText,
		);
		expect(projected.required).toBe(original.required);
	});

	it("represents no remaining reads as exactly [] without a length cap", () => {
		const projected = withAvailableContextRequests(schema(), new Set());
		expect(projected.properties?.contextRequests).toEqual({
			type: "array",
			items: { type: "string" },
			description: "Read complete authorized references.",
			enum: [[]],
		});
		expect(readContextRequests({ contextRequests: [] }, new Set())).toEqual([]);
	});

	it("intersects an authored item enum without broadening it", () => {
		const original = schema();
		original.properties.contextRequests.items = {
			type: "string",
			enum: ["FACTS", "loaded"],
			pattern: "^[A-Z]+$",
		};
		expect(
			withAvailableContextRequests(original, new Set(["FACTS", "OTHER"]))
				.properties?.contextRequests?.items,
		).toEqual({
			type: "string",
			enum: ["FACTS"],
			pattern: "^[A-Z]+$",
		});
	});

	it.each([
		{ type: "string" },
		{ type: "array", items: { type: "object" } },
		{ type: "array", items: { type: "string" }, enum: [["custom"]] },
	])("retains custom nonstandard reference contracts: %j", (field) => {
		const original = schema();
		original.properties.contextRequests = field;
		expect(withAvailableContextRequests(original, new Set())).toBe(original);
	});
});
