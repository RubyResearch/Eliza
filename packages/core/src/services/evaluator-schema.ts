import type { JSONSchema } from "../types/model.ts";
import { isObjectRecord } from "../utils/type-guards.ts";

/** Require the citation fields already declared by an incremental extractor.
 * Legacy schemas stay untouched. Visit schema positions only: defaults, enums
 * and examples are data, even when their keys happen to look like a schema. */
export function requireIncrementalSourceCitations(
	schema: JSONSchema,
): JSONSchema {
	const result = { ...schema };
	for (const key of [
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
	]) {
		const map = schema[key];
		if (isObjectRecord(map)) {
			result[key] = Object.fromEntries(
				Object.entries(map).map(([name, child]) => [
					name,
					isObjectRecord(child)
						? requireIncrementalSourceCitations(child as JSONSchema)
						: child,
				]),
			);
		}
	}
	for (const key of [
		"items",
		"prefixItems",
		"anyOf",
		"allOf",
		"oneOf",
		"not",
		"if",
		"then",
		"else",
		"contains",
		"additionalProperties",
		"additionalItems",
		"unevaluatedProperties",
		"unevaluatedItems",
		"propertyNames",
	]) {
		const child = schema[key];
		if (Array.isArray(child)) {
			result[key] = child.map((item) =>
				isObjectRecord(item)
					? requireIncrementalSourceCitations(item as JSONSchema)
					: item,
			) as typeof child;
		} else if (isObjectRecord(child)) {
			result[key] = requireIncrementalSourceCitations(child as JSONSchema);
		}
	}
	if (schema.properties?.sourceMessageIds) {
		result.required = [
			...new Set([...(schema.required ?? []), "sourceMessageIds"]),
		];
	}
	return result;
}
