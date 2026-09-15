/**
 * Non-mutating diagnostic projection for validated tool-call arguments. The
 * handler must receive the exact raw values, so redaction cannot happen where
 * arguments are produced; instead every boundary where arguments leave the
 * ephemeral execution path (planner queue/context/events, streaming and
 * observer payloads, action summaries, result/failure metadata, persisted
 * trajectories) projects them through this module before serialization.
 *
 * The projection composes runtime-known-secret redaction with the shared
 * tool-shape patterns from redact.ts (CLI --token forms, URI userinfo, token
 * prefixes), fully masks values under credential-named keys, preserves
 * non-string primitives so numeric/boolean diagnostics stay exact, and bounds
 * depth/cycles so a pathological argument graph cannot hang a diagnostic
 * writer. Unchanged subtrees are returned by reference (structural sharing);
 * callers must treat projected values as immutable.
 */

import { ElizaError } from "../errors";
import {
	isSensitiveKeyName,
	type RedactSensitiveMode,
	redactSensitiveText,
} from "./redact";

/** Replacement emitted for masked keys, cycles, and over-deep subtrees. */
export const TOOL_DIAGNOSTIC_MASK = "[REDACTED]";

/**
 * Depth bound for the projection walk. Matches the log-sink redactor's bound
 * so a diagnostic surface never preserves structure a log line would refuse.
 */
const MAX_TOOL_DIAGNOSTIC_DEPTH = 8;

/** JSON Schema keys whose object keys are schema identifiers, not values. */
const JSON_SCHEMA_DEFINITION_MAP_KEYS = new Set([
	"$defs",
	"definitions",
	"dependencies",
	"dependentSchemas",
	"patternProperties",
	"properties",
]);

/** JSON Schema keys containing one nested schema. */
const JSON_SCHEMA_SINGLE_SCHEMA_KEYS = new Set([
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

/** JSON Schema keys containing an array of nested schemas. */
const JSON_SCHEMA_SCHEMA_ARRAY_KEYS = new Set([
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems",
]);

/** Tool-definition fields whose values are JSON Schemas. */
const TOOL_DEFINITION_SCHEMA_KEYS = new Set([
	"inputSchema",
	"input_schema",
	"parameters",
	"responseSchema",
	"response_schema",
	"schema",
]);

/** Scrubs one string for diagnostic output. */
export type ToolDiagnosticTextRedactor = (text: string) => string;

const TOOLS_MODE: { mode: RedactSensitiveMode } = { mode: "tools" };

/** Durable transport/recovery state may contain context from a private audience. */
function isPrivateToolField(key: string): boolean {
	return (
		key === "chatIdempotency" ||
		key === "replyRecoveryJson" ||
		isSensitiveKeyName(key)
	);
}

/**
 * Composes runtime-known-secret redaction with shared tool-shape redaction —
 * the established order from the action-output work: literal character
 * secrets first, then pattern detection over whatever remains. Lightweight
 * and test runtimes may stub `redactSecrets` as identity, so the pattern pass
 * always runs.
 */
export function composeToolDiagnosticRedactor(runtime?: {
	redactSecrets?(text: string): string;
}): ToolDiagnosticTextRedactor {
	const redactSecrets = runtime?.redactSecrets?.bind(runtime);
	if (!redactSecrets) {
		return (text) => redactSensitiveText(text, TOOLS_MODE);
	}
	return (text) => redactSensitiveText(redactSecrets(text), TOOLS_MODE);
}

function projectValue(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (typeof value === "string") {
		return redactText(value);
	}
	if (value === null || typeof value !== "object") {
		// Numbers, booleans, bigints, undefined, functions, symbols: preserved.
		// Non-serializable entries drop out at JSON.stringify time exactly as
		// they would have for the raw value, so the projection never changes
		// which fields a surface serializes — only what the strings contain.
		return value;
	}
	if (value instanceof Date) {
		// A Date carries no string payload to scrub. Pass it through untouched so
		// downstream sanitizers keep their own Date semantics — in particular an
		// invalid Date must keep failing normalization loudly instead of being
		// flattened into a healthy-looking empty object.
		return value;
	}
	if (depth >= MAX_TOOL_DIAGNOSTIC_DEPTH || seen.has(value)) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			let changed = false;
			const projected = value.map((item) => {
				const next = projectValue(item, redactText, seen, depth + 1);
				if (next !== item) {
					changed = true;
				}
				return next;
			});
			return changed ? projected : value;
		}
		if (value instanceof Error) {
			// Thrown values routinely interpolate the offending argument into
			// their message; preserve the Error shape but scrub message/stack.
			const projected = new Error(redactText(value.message));
			projected.name = value.name;
			projected.stack = value.stack ? redactText(value.stack) : undefined;
			return projected;
		}
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (isPrivateToolField(key)) {
				projected[key] = TOOL_DIAGNOSTIC_MASK;
				changed = true;
				continue;
			}
			const next = projectValue(entry, redactText, seen, depth + 1);
			if (next !== entry) {
				changed = true;
			}
			projected[key] = next;
		}
		// A non-plain prototype (class instance) still projects to a plain
		// object: diagnostics serialize own enumerable state only.
		if (!changed && Object.getPrototypeOf(value) === Object.prototype) {
			return value;
		}
		return projected;
	} finally {
		// Re-entrant siblings may legitimately share a subtree; only a path
		// back through an ancestor is a cycle.
		seen.delete(value);
	}
}

/**
 * Redact a model-bound value without the diagnostic depth cap. Cycles cannot
 * be represented on the provider wire, so reject them explicitly instead of
 * replacing content with a healthy-looking marker.
 */
function projectCompleteModelValue(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	ancestors: WeakSet<object>,
): unknown {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return value;
	if (ancestors.has(value)) {
		throw new ElizaError("Model-bound tool data contains a cycle", {
			code: "MODEL_TOOL_DATA_CYCLE",
			context: { valueType: value.constructor?.name ?? "object" },
		});
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			let changed = false;
			const projected = value.map((entry) => {
				const next = projectCompleteModelValue(entry, redactText, ancestors);
				if (next !== entry) changed = true;
				return next;
			});
			return changed ? projected : value;
		}
		if (value instanceof Error) {
			const projected = new Error(redactText(value.message));
			projected.name = value.name;
			projected.stack = value.stack ? redactText(value.stack) : undefined;
			return projected;
		}
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (isPrivateToolField(key)) {
				projected[key] = TOOL_DIAGNOSTIC_MASK;
				changed = true;
				continue;
			}
			const next = projectCompleteModelValue(entry, redactText, ancestors);
			if (next !== entry) changed = true;
			projected[key] = next;
		}
		if (!changed && Object.getPrototypeOf(value) === Object.prototype) {
			return value;
		}
		return projected;
	} finally {
		ancestors.delete(value);
	}
}

function projectJsonSchemaDefinitionMap(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
	complete = false,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return complete
			? projectCompleteModelValue(value, redactText, seen)
			: projectValue(value, redactText, seen, depth);
	}
	if (seen.has(value)) {
		if (complete) {
			throw new ElizaError("Model-call schema contains a cycle", {
				code: "MODEL_TOOL_DATA_CYCLE",
			});
		}
		return TOOL_DIAGNOSTIC_MASK;
	}
	if (!complete && depth >= MAX_TOOL_DIAGNOSTIC_DEPTH) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [propertyName, propertySchema] of Object.entries(value)) {
			// Property/definition names are executable schema identifiers. Treating
			// names such as `apiKey`, `token`, or `secret` as credential containers
			// would replace their schema object and make the recorded request
			// unreplayable. Values inside each schema still receive the full pass.
			const next =
				Array.isArray(propertySchema) &&
				propertySchema.every((name) => typeof name === "string")
					? propertySchema
					: projectJsonSchemaNode(
							propertySchema,
							redactText,
							seen,
							depth + 1,
							complete,
						);
			if (next !== propertySchema) changed = true;
			projected[propertyName] = next;
		}
		return changed ? projected : value;
	} finally {
		seen.delete(value);
	}
}

function projectJsonSchemaNode(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
	complete = false,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return complete
			? projectCompleteModelValue(value, redactText, seen)
			: projectValue(value, redactText, seen, depth);
	}
	if (seen.has(value)) {
		if (complete) {
			throw new ElizaError("Model-call schema contains a cycle", {
				code: "MODEL_TOOL_DATA_CYCLE",
			});
		}
		return TOOL_DIAGNOSTIC_MASK;
	}
	if (!complete && depth >= MAX_TOOL_DIAGNOSTIC_DEPTH) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			let next: unknown;
			if (JSON_SCHEMA_DEFINITION_MAP_KEYS.has(key)) {
				next = projectJsonSchemaDefinitionMap(
					entry,
					redactText,
					seen,
					depth + 1,
					complete,
				);
			} else if (JSON_SCHEMA_SINGLE_SCHEMA_KEYS.has(key)) {
				if (key === "items" && Array.isArray(entry)) {
					next = entry.map((item) =>
						projectJsonSchemaNode(item, redactText, seen, depth + 1, complete),
					);
				} else {
					next = projectJsonSchemaNode(
						entry,
						redactText,
						seen,
						depth + 1,
						complete,
					);
				}
			} else if (
				JSON_SCHEMA_SCHEMA_ARRAY_KEYS.has(key) &&
				Array.isArray(entry)
			) {
				next = entry.map((item) =>
					projectJsonSchemaNode(item, redactText, seen, depth + 1, complete),
				);
			} else if (
				key === "required" &&
				Array.isArray(entry) &&
				entry.every((propertyName) => typeof propertyName === "string")
			) {
				// Required entries are references to property identifiers. Preserve
				// them byte-exact so they continue to match the property map above.
				next = entry;
			} else if (
				key === "dependentRequired" &&
				entry &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				Object.values(entry).every(
					(propertyNames) =>
						Array.isArray(propertyNames) &&
						propertyNames.every(
							(propertyName) => typeof propertyName === "string",
						),
				)
			) {
				// Both map keys and array values are schema property identifiers.
				next = entry;
			} else if (isPrivateToolField(key)) {
				next = TOOL_DIAGNOSTIC_MASK;
			} else {
				next = complete
					? projectCompleteModelValue(entry, redactText, seen)
					: projectValue(entry, redactText, seen, depth + 1);
			}
			if (next !== entry) changed = true;
			projected[key] = next;
		}
		return changed ? projected : value;
	} finally {
		seen.delete(value);
	}
}

function projectModelToolDefinition(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
	seen: WeakSet<object>,
	depth: number,
	complete = false,
): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			if (complete) {
				throw new ElizaError("Model-call tool schema contains a cycle", {
					code: "MODEL_TOOL_DATA_CYCLE",
				});
			}
			return TOOL_DIAGNOSTIC_MASK;
		}
		if (!complete && depth >= MAX_TOOL_DIAGNOSTIC_DEPTH) {
			return TOOL_DIAGNOSTIC_MASK;
		}
		seen.add(value);
		try {
			let changed = false;
			const projected = value.map((entry) => {
				const next = projectModelToolDefinition(
					entry,
					redactText,
					seen,
					depth + 1,
					complete,
				);
				if (next !== entry) changed = true;
				return next;
			});
			return changed ? projected : value;
		} finally {
			seen.delete(value);
		}
	}
	if (!value || typeof value !== "object") {
		return complete
			? projectCompleteModelValue(value, redactText, seen)
			: projectValue(value, redactText, seen, depth);
	}
	if (seen.has(value)) {
		if (complete) {
			throw new ElizaError("Model-call tool schema contains a cycle", {
				code: "MODEL_TOOL_DATA_CYCLE",
			});
		}
		return TOOL_DIAGNOSTIC_MASK;
	}
	if (!complete && depth >= MAX_TOOL_DIAGNOSTIC_DEPTH) {
		return TOOL_DIAGNOSTIC_MASK;
	}
	seen.add(value);
	try {
		let changed = false;
		const projected: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			let next: unknown;
			if (TOOL_DEFINITION_SCHEMA_KEYS.has(key)) {
				next = projectJsonSchemaNode(
					entry,
					redactText,
					seen,
					depth + 1,
					complete,
				);
			} else if (key === "function") {
				// OpenAI-style definitions nest name/description/parameters below a
				// `function` object instead of exposing the neutral ToolDefinition.
				next = projectModelToolDefinition(
					entry,
					redactText,
					seen,
					depth + 1,
					complete,
				);
			} else if (isPrivateToolField(key)) {
				next = TOOL_DIAGNOSTIC_MASK;
			} else {
				next = complete
					? projectCompleteModelValue(entry, redactText, seen)
					: projectValue(entry, redactText, seen, depth + 1);
			}
			if (next !== entry) changed = true;
			projected[key] = next;
		}
		return changed ? projected : value;
	} finally {
		seen.delete(value);
	}
}

/**
 * Projects one value for diagnostic egress. The input is never mutated; the
 * result is safe to embed in diagnostic events, stream payloads, summaries,
 * and persisted trajectories. Strings are scrubbed with
 * `redactText`, values under credential-named keys are fully masked,
 * non-string primitives are preserved exactly, and cycles or nesting beyond
 * the depth bound collapse to {@link TOOL_DIAGNOSTIC_MASK}.
 */
export function projectToolDiagnosticValue(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
): unknown {
	return projectValue(value, redactText, new WeakSet<object>(), 0);
}

/**
 * Redacts one complete model-bound value without diagnostic depth masking.
 * Credential-shaped values are intentionally masked; every other reachable
 * field is preserved, and cyclic data is rejected with a typed error.
 */
export function projectCompleteToolValueForModel(
	value: unknown,
	redactText: ToolDiagnosticTextRedactor,
): unknown {
	return projectCompleteModelValue(value, redactText, new WeakSet<object>());
}

/** Complete model-bound counterpart of {@link projectToolDiagnosticArgs}. */
export function projectCompleteToolArgsForModel(
	args: Record<string, unknown> | undefined,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> | undefined {
	if (args === undefined) return undefined;
	return projectCompleteToolValueForModel(args, redactText) as Record<
		string,
		unknown
	>;
}

/**
 * Projects a complete model-call record without corrupting its executable JSON
 * Schemas. Model messages, responses, provider payloads, and tool-call values
 * use the normal credential-key pass. Schema property/definition names remain
 * exact identifiers, while descriptions, defaults, examples, and other schema
 * values are still scrubbed. Both neutral and OpenAI-style tool definitions
 * are supported.
 */
export function projectModelCallDiagnosticValue(
	value: Record<string, unknown>,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> {
	const projected = projectToolDiagnosticValue(value, redactText) as Record<
		string,
		unknown
	>;
	let next = projected;
	for (const schemaKey of ["responseSchema", "response_schema"] as const) {
		if (!(schemaKey in value)) continue;
		const projectedSchema = projectJsonSchemaNode(
			value[schemaKey],
			redactText,
			new WeakSet<object>(),
			0,
		);
		if (projectedSchema !== projected[schemaKey]) {
			if (next === projected) next = { ...projected };
			next[schemaKey] = projectedSchema;
		}
	}
	if ("tools" in value) {
		const projectedTools = projectModelToolDefinition(
			value.tools,
			redactText,
			new WeakSet<object>(),
			0,
		);
		if (projectedTools !== projected.tools) {
			if (next === projected) next = { ...projected };
			next.tools = projectedTools;
		}
	}
	return next;
}

/**
 * Protected-trajectory projection for a complete model call. Unlike the log
 * diagnostic variant, this never replaces deep subtrees; it preserves schema
 * identifiers, redacts credentials, and rejects cycles explicitly.
 */
export function projectCompleteModelCallValue(
	value: Record<string, unknown>,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> {
	const projected = projectCompleteToolValueForModel(
		value,
		redactText,
	) as Record<string, unknown>;
	let next = projected;
	for (const schemaKey of ["responseSchema", "response_schema"] as const) {
		if (!(schemaKey in value)) continue;
		const projectedSchema = projectJsonSchemaNode(
			value[schemaKey],
			redactText,
			new WeakSet<object>(),
			0,
			true,
		);
		if (projectedSchema !== projected[schemaKey]) {
			if (next === projected) next = { ...projected };
			next[schemaKey] = projectedSchema;
		}
	}
	if ("tools" in value) {
		const projectedTools = projectModelToolDefinition(
			value.tools,
			redactText,
			new WeakSet<object>(),
			0,
			true,
		);
		if (projectedTools !== projected.tools) {
			if (next === projected) next = { ...projected };
			next.tools = projectedTools;
		}
	}
	return next;
}

/**
 * Projects a protected trajectory call without treating runtime-only
 * diagnostics as model input. The request/response fields are complete and
 * cycle-rejecting; unrelated metadata keeps the bounded diagnostic policy so
 * an AbortSignal, callback, or adapter cycle cannot erase a valid model call.
 */
export function projectProtectedModelCallValue(
	value: Record<string, unknown>,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> {
	const diagnostic = projectModelCallDiagnosticValue(value, redactText);
	let next = diagnostic;
	const replace = (key: string, projected: unknown): void => {
		if (projected === diagnostic[key]) return;
		if (next === diagnostic) next = { ...diagnostic };
		next[key] = projected;
	};
	for (const key of [
		"systemPrompt",
		"userPrompt",
		"prompt",
		"messages",
		"toolChoice",
		"providerOptions",
		"response",
		"toolCalls",
		"reasoning",
	]) {
		if (!(key in value)) continue;
		replace(key, projectCompleteToolValueForModel(value[key], redactText));
	}
	for (const schemaKey of ["responseSchema", "response_schema"] as const) {
		if (!(schemaKey in value)) continue;
		replace(
			schemaKey,
			projectJsonSchemaNode(
				value[schemaKey],
				redactText,
				new WeakSet<object>(),
				0,
				true,
			),
		);
	}
	if ("tools" in value) {
		replace(
			"tools",
			projectModelToolDefinition(
				value.tools,
				redactText,
				new WeakSet<object>(),
				0,
				true,
			),
		);
	}
	return next;
}

/**
 * Projects a tool-call argument record for diagnostic egress. Returns the
 * same reference when nothing needed redaction so unchanged calls stay
 * identity-comparable across surfaces.
 */
export function projectToolDiagnosticArgs(
	args: Record<string, unknown> | undefined,
	redactText: ToolDiagnosticTextRedactor,
): Record<string, unknown> | undefined {
	if (args === undefined) {
		return undefined;
	}
	return projectToolDiagnosticValue(args, redactText) as Record<
		string,
		unknown
	>;
}
