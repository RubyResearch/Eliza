/**
 * Exercises the shared user-visible model-output boundary with adversarial
 * envelope nesting and genuine JSON. Pure parser tests; no model or runtime.
 */
import { describe, expect, it } from "vitest";
import {
	looksLikeActionEnvelopeJson,
	sanitizeUserVisibleModelOutput,
} from "../user-visible-model-output";

describe("sanitizeUserVisibleModelOutput", () => {
	it("rejects non-printing characters in final prose and unwrapped replies without rewriting them", () => {
		const damaged = "It doesn\u001c\u001d\t\u001contain magenta.";
		for (const value of [
			damaged,
			JSON.stringify({ response: { messageToUser: damaged } }),
		]) {
			expect(sanitizeUserVisibleModelOutput(value)).toMatchObject({
				kind: "invalid",
				reason: "reply-control-characters",
			});
		}
		for (const code of [0, 1, 8, 11, 12, 14, 28, 29, 31, 127, 133, 159]) {
			expect(
				sanitizeUserVisibleModelOutput(
					`before${String.fromCharCode(code)}after`,
				),
			).toMatchObject({
				kind: "invalid",
				reason: "reply-control-characters",
			});
		}
	});
	it("preserves ordinary formatting, Unicode and escaped control-character data", () => {
		for (const text of [
			"日本語 — ‘green’ 🟢\nFirst\tsecond\r\nNext",
			String.raw`The escape is \u001c.`,
			JSON.stringify({ value: "\u001c", explanation: "An escaped separator" }),
			JSON.stringify(["\u001c", { text: "\u001d", label: "escaped data" }]),
		]) {
			expect(sanitizeUserVisibleModelOutput(text)).toMatchObject({
				kind: "text",
				text,
			});
		}
	});
	it.each([
		'{"plannerCompleted":true,"turnScope":"final"}',
		'```json\n{"plannerCompleted":true,"turnScope":"final"}\n```',
		'{"response":{"plannerCompleted":false,"turnScope":"more_work_pending"}}',
		'{"plannerCompleted":true,"turnScope":"final",',
	])("keeps completion-control records out of chat: %s", (candidate) => {
		expect(sanitizeUserVisibleModelOutput(candidate)).toMatchObject({
			kind: "control",
			envelope: "planner",
		});
	});

	it.each([
		'{"action":"messageToUser","args":{"message":"Done."}}',
		'```json\n{"action":"messageToUser","args":{"message":"Done."}}\n```',
		'{"response":{"action":"messageToUser","args":{"message":"Done."}}}',
		'{"action":"messageToUser","args":{"message":',
		'{"action":"messageToUser"}',
	])("rejects a reply field serialized as a fake action: %s", (candidate) => {
		expect(sanitizeUserVisibleModelOutput(candidate)).toMatchObject({
			kind: "control",
			envelope: "planner",
		});
	});

	it("rejects a fenced action envelope even when foreign metadata keys are present", () => {
		const output = sanitizeUserVisibleModelOutput(
			'```json\n{"action":"BROWSER","parameters":{"url":"https://example.com"},"status":"retry","toolCallId":"call-1"}\n```',
		);

		expect(output).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});
		expect(
			looksLikeActionEnvelopeJson(
				'{"action":"BROWSER","parameters":{},"status":"retry"}',
			),
		).toBe(true);
	});

	it("recursively rejects action envelopes hidden in nested reply fields", () => {
		const action = JSON.stringify({
			action: "WEB_SEARCH",
			parameters: { query: "current weather" },
			thought: "search first",
			metadata: { attempt: 2 },
		});
		const output = sanitizeUserVisibleModelOutput(
			JSON.stringify({
				response: JSON.stringify({
					messageToUser: `\`\`\`json\n${action}\n\`\`\``,
				}),
			}),
		);

		expect(output).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: ["response", "messageToUser"],
		});

		expect(
			sanitizeUserVisibleModelOutput(
				JSON.stringify({
					response: action,
					traceId: "trace-1",
					foreignMetadata: true,
				}),
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: ["response"],
		});
	});

	it("unwraps nested response scaffolds until it reaches plain user text", () => {
		const output = sanitizeUserVisibleModelOutput(
			JSON.stringify({
				response: JSON.stringify({
					replyText: "Something went wrong. Please try again.",
				}),
			}),
		);

		expect(output).toEqual({
			kind: "text",
			text: "Something went wrong. Please try again.",
			format: "plain",
			fieldPath: ["response", "replyText"],
		});
	});

	it("rejects a truncated action envelope as malformed control data", () => {
		for (const candidate of [
			'{"action":"BROWSER","parameters":{"url":"https://example.com"},"status":',
			'{"action":"BROWSER"',
			'{"action":"BROWSER"}',
		]) {
			expect(sanitizeUserVisibleModelOutput(candidate)).toEqual({
				kind: "control",
				envelope: "action",
				malformed: true,
				fieldPath: [],
			});
		}
	});

	it("rejects single-line fences and nested OpenAI function-call records", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'```json {"action":"BROWSER","parameters":{"url":"https://example.com"}} ```',
			),
		).toMatchObject({
			kind: "control",
			envelope: "action",
			malformed: false,
		});
		expect(
			sanitizeUserVisibleModelOutput(
				'{"function":{"name":"WEB_SEARCH","arguments":"{\\"query\\":\\"weather\\"}"},"id":"call-1"}',
			),
		).toMatchObject({
			kind: "control",
			envelope: "planner",
			malformed: false,
		});
	});

	it("rejects control records in direct JSON arrays while preserving ordinary arrays", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'[{"label":"first"},{"action":"BROWSER","parameters":{"url":"https://example.com"}}]',
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});

		const ordinary = '[{"label":"first"},{"action":"proceed","step":2}]';
		expect(sanitizeUserVisibleModelOutput(ordinary)).toEqual({
			kind: "text",
			text: ordinary,
			format: "json",
			fieldPath: [],
		});
	});

	it("preserves genuine JSON instead of treating any action key as control", () => {
		const lowerCaseAction =
			'{"action":"proceed","parameters":{"step":1},"status":"done","summary":"approved"}';
		expect(sanitizeUserVisibleModelOutput(lowerCaseAction)).toEqual({
			kind: "text",
			text: lowerCaseAction,
			format: "json",
			fieldPath: [],
		});

		const documentedExample =
			'{"example":{"action":"BROWSER","parameters":{"url":"https://example.com"}},"description":"planner schema example"}';
		expect(sanitizeUserVisibleModelOutput(documentedExample)).toEqual({
			kind: "text",
			text: documentedExample,
			format: "json",
			fieldPath: [],
		});
		const replyActionExample =
			'{"example":{"action":"messageToUser","args":{"message":"Done."}},"description":"invalid planner example"}';
		expect(sanitizeUserVisibleModelOutput(replyActionExample)).toMatchObject({
			kind: "text",
			text: replyActionExample,
			format: "json",
		});
	});

	it("returns an explicit invalid result for a reply scaffold with no usable field", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"shouldRespond":true,"replyText":"","contexts":["simple"]}',
			),
		).toEqual({
			kind: "invalid",
			reason: "reply-envelope-without-text",
			fieldPath: [],
		});
	});
});
