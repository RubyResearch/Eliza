/**
 * Classifies untrusted model text before it reaches a user-visible channel.
 * The planner and failure-reply cascade share this boundary so control
 * envelopes cannot bypass one path through different parsing rules, while
 * ordinary JSON requested by a user remains visible.
 */
import { isPlainObject } from "../utils/type-guards";

const MAX_REPLY_ENVELOPE_DEPTH = 8;
const TOOL_ACTION_NAME = /^(?:functions\.)?[A-Z][A-Z0-9_.:-]*$/;
const EVALUATOR_DECISIONS = new Set(["FINISH", "CONTINUE", "NEXT_RECOMMENDED"]);
const SPAWN_ARG_DISCRIMINATORS = [
	"task",
	"agentType",
	"approvalPreset",
	"brief",
] as const;
const REPLY_FIELDS = [
	"messageToUser",
	"replyText",
	"response",
	"text",
] as const;
const RESPONSE_ENVELOPE_MARKERS = new Set([
	"shouldRespond",
	"contexts",
	"intents",
	"candidateActionNames",
	"facts",
	"relationships",
	"thought",
]);
const RESPONSE_ROUTING_MARKERS = [
	"shouldRespond",
	"contexts",
	"intents",
	"candidateActionNames",
	"facts",
	"relationships",
] as const;
const RESPONSE_ENVELOPE_KEYS = new Set([
	...REPLY_FIELDS,
	...RESPONSE_ENVELOPE_MARKERS,
	"id",
	"status",
	"metadata",
	"usage",
]);

export type UserVisibleReplyField = (typeof REPLY_FIELDS)[number];
export type UserVisibleControlEnvelope =
	| "action"
	| "planner"
	| "evaluator"
	| "spawn";

export type UserVisibleModelOutput =
	| {
			kind: "empty";
			fieldPath: readonly UserVisibleReplyField[];
	  }
	| {
			kind: "text";
			text: string;
			format: "plain" | "json";
			fieldPath: readonly UserVisibleReplyField[];
	  }
	| {
			kind: "control";
			envelope: UserVisibleControlEnvelope;
			malformed: boolean;
			fieldPath: readonly UserVisibleReplyField[];
	  }
	| {
			kind: "invalid";
			reason:
				| "reply-envelope-without-text"
				| "reply-envelope-too-deep"
				| "reply-control-characters";
			fieldPath: readonly UserVisibleReplyField[];
	  };

/**
 * Return a typed projection of model output. Reply scaffolds are recursively
 * unwrapped; planner, action, evaluator, and spawn records are explicit
 * control results rather than strings a caller might accidentally display.
 */
export function sanitizeUserVisibleModelOutput(
	value: string | undefined,
): UserVisibleModelOutput {
	const output = inspectValue(value, [], 0);
	if (output.kind === "text") {
		// Check the final display text, not decoded values inside ordinary JSON:
		// escaped control-character data is valid, raw controls in prose are not.
		// Reject the whole reply so recovery can render it from its evidence;
		// deleting characters could leave damaged words while claiming success.
		for (const character of output.text) {
			const code = character.charCodeAt(0);
			if (
				(code < 32 && code !== 9 && code !== 10 && code !== 13) ||
				(code >= 127 && code <= 159)
			) {
				return {
					kind: "invalid",
					reason: "reply-control-characters",
					fieldPath: output.fieldPath,
				};
			}
		}
	}
	return output;
}

export function looksLikeActionEnvelopeJson(text: string): boolean {
	const result = sanitizeUserVisibleModelOutput(text);
	return result.kind === "control" && result.envelope === "action";
}

export function looksLikeEvaluatorEnvelopeJson(text: string): boolean {
	const result = sanitizeUserVisibleModelOutput(text);
	return result.kind === "control" && result.envelope === "evaluator";
}

export function looksLikeSpawnEnvelopeJson(text: string): boolean {
	const result = sanitizeUserVisibleModelOutput(text);
	return result.kind === "control" && result.envelope === "spawn";
}

function inspectValue(
	value: unknown,
	fieldPath: readonly UserVisibleReplyField[],
	depth: number,
): UserVisibleModelOutput {
	if (depth > MAX_REPLY_ENVELOPE_DEPTH) {
		return {
			kind: "invalid",
			reason: "reply-envelope-too-deep",
			fieldPath,
		};
	}
	if (typeof value === "string") {
		return inspectString(value, fieldPath, depth);
	}
	if (isPlainObject(value) || Array.isArray(value)) {
		return inspectParsedJson(value, JSON.stringify(value), fieldPath, depth);
	}
	return { kind: "empty", fieldPath };
}

function inspectString(
	raw: string,
	fieldPath: readonly UserVisibleReplyField[],
	depth: number,
): UserVisibleModelOutput {
	const text = raw.trim();
	if (!text) return { kind: "empty", fieldPath };

	const fencedBody = unwrapWholeJsonFence(text);
	const candidate = fencedBody ?? text;
	const parsed = parseStructuredJson(candidate);
	if (parsed !== undefined) {
		return inspectParsedJson(parsed, text, fieldPath, depth);
	}

	const malformedEnvelope = classifyMalformedControl(candidate);
	if (malformedEnvelope) {
		return {
			kind: "control",
			envelope: malformedEnvelope,
			malformed: true,
			fieldPath,
		};
	}
	if (looksLikeMalformedReplyEnvelope(candidate)) {
		return {
			kind: "invalid",
			reason: "reply-envelope-without-text",
			fieldPath,
		};
	}
	return { kind: "text", text, format: "plain", fieldPath };
}

function inspectParsedJson(
	parsed: unknown,
	displayText: string,
	fieldPath: readonly UserVisibleReplyField[],
	depth: number,
): UserVisibleModelOutput {
	if (Array.isArray(parsed)) {
		for (const entry of parsed) {
			const nested = inspectValue(entry, fieldPath, depth + 1);
			if (nested.kind === "control" || nested.kind === "invalid") {
				return nested;
			}
		}
		return {
			kind: "text",
			text: displayText,
			format: "json",
			fieldPath,
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			kind: "text",
			text: displayText,
			format: "json",
			fieldPath,
		};
	}

	const control = classifyControlRecord(parsed);
	if (control) {
		return {
			kind: "control",
			envelope: control.envelope,
			malformed: control.malformed,
			fieldPath,
		};
	}

	if (!isReplyEnvelope(parsed)) {
		for (const field of ["response", "text"] as const) {
			if (!Object.hasOwn(parsed, field)) continue;
			const nested = inspectValue(
				parsed[field],
				[...fieldPath, field],
				depth + 1,
			);
			if (nested.kind === "control" || nested.kind === "invalid") {
				return nested;
			}
		}
		return {
			kind: "text",
			text: displayText,
			format: "json",
			fieldPath,
		};
	}

	let rejected:
		| Extract<UserVisibleModelOutput, { kind: "control" | "invalid" }>
		| undefined;
	for (const field of REPLY_FIELDS) {
		if (!Object.hasOwn(parsed, field)) continue;
		const nested = inspectValue(
			parsed[field],
			[...fieldPath, field],
			depth + 1,
		);
		if (nested.kind === "text") return nested;
		if (nested.kind === "control" || nested.kind === "invalid") {
			rejected ??= nested;
		}
	}
	return (
		rejected ?? {
			kind: "invalid",
			reason: "reply-envelope-without-text",
			fieldPath,
		}
	);
}

function parseStructuredJson(text: string): unknown | undefined {
	if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// error-policy:J3 untrusted model output remains an explicit invalid
		// signal; the caller never receives a fabricated parsed value.
		return undefined;
	}
}

function unwrapWholeJsonFence(text: string): string | undefined {
	const match = text.match(/^```(?:json)?[ \t]*(?:\r?\n)?([\s\S]*?)```$/i);
	return match?.[1]?.trim();
}

function classifyControlRecord(
	record: Record<string, unknown>,
): { envelope: UserVisibleControlEnvelope; malformed: boolean } | undefined {
	const action = typeof record.action === "string" ? record.action.trim() : "";
	// A reply field is not a callable action. Qwen emitted this shape during
	// no-tools recovery; keep it in the protocol channel, not visible prose.
	if (action === "messageToUser") {
		return {
			envelope: "planner",
			malformed:
				!isPlainObject(record.args) || typeof record.args.message !== "string",
		};
	}
	if (TOOL_ACTION_NAME.test(action)) {
		return {
			envelope: "action",
			malformed: !isPlainObject(record.parameters),
		};
	}

	const decision = String(record.decision ?? record.route ?? "").toUpperCase();
	if (
		EVALUATOR_DECISIONS.has(decision) &&
		(typeof record.success === "boolean" ||
			typeof record.thought === "string" ||
			isPlainObject(record.nextTool) ||
			typeof record.recommendedToolCallId === "string")
	) {
		return { envelope: "evaluator", malformed: false };
	}

	if (
		Object.hasOwn(record, "toolCalls") ||
		(typeof record.plannerCompleted === "boolean" &&
			(record.turnScope === "final" ||
				record.turnScope === "more_work_pending")) ||
		(typeof record.completed === "boolean" &&
			(typeof record.thought === "string" ||
				REPLY_FIELDS.some((field) => Object.hasOwn(record, field))))
	) {
		return { envelope: "planner", malformed: false };
	}

	const nestedFunction = isPlainObject(record.function)
		? record.function
		: undefined;
	const narratedToolName = [
		record.name,
		record.toolName,
		record.tool,
		record.actionName,
		nestedFunction?.name,
		typeof record.function === "string" ? record.function : undefined,
		record.type,
	].find((value): value is string => typeof value === "string");
	const carriesTopLevelToolArguments = [
		"input",
		"args",
		"arguments",
		"params",
		"parameters",
	].some((key) => Object.hasOwn(record, key));
	const carriesNestedFunctionArguments =
		nestedFunction !== undefined &&
		["arguments", "args", "input", "parameters"].some((key) =>
			Object.hasOwn(nestedFunction, key),
		);
	if (
		narratedToolName &&
		TOOL_ACTION_NAME.test(narratedToolName.trim()) &&
		(carriesTopLevelToolArguments || carriesNestedFunctionArguments)
	) {
		return { envelope: "planner", malformed: false };
	}

	const spawnDiscriminators = SPAWN_ARG_DISCRIMINATORS.filter((key) =>
		Object.hasOwn(record, key),
	);
	if (spawnDiscriminators.length >= 2) {
		return { envelope: "spawn", malformed: false };
	}
	return undefined;
}

function isReplyEnvelope(record: Record<string, unknown>): boolean {
	if (
		Object.hasOwn(record, "messageToUser") ||
		Object.hasOwn(record, "replyText")
	) {
		return true;
	}
	if (RESPONSE_ROUTING_MARKERS.some((key) => Object.hasOwn(record, key))) {
		return true;
	}
	const hasGenericReplyField =
		Object.hasOwn(record, "response") || Object.hasOwn(record, "text");
	return (
		hasGenericReplyField &&
		Object.keys(record).every((key) => RESPONSE_ENVELOPE_KEYS.has(key))
	);
}

function classifyMalformedControl(
	text: string,
): UserVisibleControlEnvelope | undefined {
	if (!text.startsWith("{")) return undefined;
	const candidate = text;
	if (/"action"\s*:\s*"messageToUser"/.test(candidate)) return "planner";
	const action = candidate.match(
		/"action"\s*:\s*"((?:functions\.)?[A-Z][A-Z0-9_.:-]*)"/,
	)?.[1];
	if (action) return "action";
	if (/"toolCalls"\s*:/.test(candidate)) return "planner";
	if (
		/"plannerCompleted"\s*:\s*(?:true|false)/.test(candidate) &&
		/"turnScope"\s*:\s*"(?:final|more_work_pending)"/.test(candidate)
	)
		return "planner";
	const evaluatorDecision =
		/"(?:decision|route)"\s*:\s*"(?:FINISH|CONTINUE|NEXT_RECOMMENDED)"/i.test(
			candidate,
		);
	if (
		evaluatorDecision &&
		(/"success"\s*:/.test(candidate) ||
			/"thought"\s*:/.test(candidate) ||
			/"nextTool"\s*:/.test(candidate) ||
			/"recommendedToolCallId"\s*:/.test(candidate))
	) {
		return "evaluator";
	}
	const spawnDiscriminators = SPAWN_ARG_DISCRIMINATORS.filter((key) =>
		new RegExp(`"${key}"\\s*:`).test(candidate),
	);
	return spawnDiscriminators.length >= 2 ? "spawn" : undefined;
}

function looksLikeMalformedReplyEnvelope(text: string): boolean {
	if (!text.startsWith("{")) return false;
	const candidate = text;
	return (
		/"(?:messageToUser|replyText)"\s*:/.test(candidate) ||
		(/"(?:response|text)"\s*:/.test(candidate) &&
			[...RESPONSE_ENVELOPE_MARKERS].some((key) =>
				new RegExp(`"${key}"\\s*:`).test(candidate),
			))
	);
}
