/**
 * Verifies that planner rendering carries complete tool-result text and data
 * into model messages without mutating the source trajectory.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	projectToolResultForModel,
	renderActionResultsForModel,
	toolMessageContent,
	trajectoryStepsToMessages,
} from "../planner-rendering";
import type { PlannerStep } from "../planner-types";

function stepWithResult(iteration: number, resultText: string): PlannerStep {
	return {
		iteration,
		thought: "test",
		toolCall: { id: `call-${iteration}`, name: "BASH", params: {} },
		result: { success: true, text: resultText },
	};
}

function getRenderedResultValue(messages: ChatMessage[]): string {
	const toolMsg = messages.find((message) => message.role === "tool");
	if (!toolMsg || !Array.isArray(toolMsg.content)) {
		throw new Error("expected a tool message with array content");
	}
	const part = toolMsg.content[0];
	if (
		!part ||
		typeof part !== "object" ||
		!("output" in part) ||
		typeof part.output !== "object" ||
		!part.output ||
		!("value" in part.output) ||
		typeof part.output.value !== "string"
	) {
		throw new Error("expected text-output tool result");
	}
	return part.output.value;
}

function readViewFor(text: string) {
	return {
		reference: { kind: "file" as const, ref: "file_opaque", revision: "r1" },
		slice: {
			range: { unit: "line" as const, start: 0, end: 100, total: 200 },
			hasPrevious: false,
			hasMore: true,
			nextOffset: 100,
			revision: "r1",
			completeness: "partial-recoverable" as const,
			sliceSha256: createHash("sha256").update(text).digest("hex"),
		},
	};
}

describe("trajectoryStepsToMessages", () => {
	it("renders a result larger than the former cap in full", () => {
		const result = `HEAD_SENTINEL${"x".repeat(150_000)}TAIL_SENTINEL`;
		const steps = [stepWithResult(1, result)];
		const rendered = getRenderedResultValue(trajectoryStepsToMessages(steps));
		expect(JSON.parse(rendered).text).toBe(result);
		expect(steps[0]?.result?.text).toBe(result);
	});

	it("renders every large step independently and completely", () => {
		const steps = Array.from({ length: 3 }, (_, index) =>
			stepWithResult(index + 1, `${index}:${"z".repeat(50_000)}:${index}`),
		);
		const messages = trajectoryStepsToMessages(steps).filter(
			(message) => message.role === "tool",
		);
		expect(messages).toHaveLength(3);
		for (const [index, message] of messages.entries()) {
			expect(JSON.parse(getRenderedResultValue([message])).text).toBe(
				`${index}:${"z".repeat(50_000)}:${index}`,
			);
		}
	});

	it("preserves whitespace in planner thoughts", () => {
		const step = stepWithResult(1, "complete");
		step.thought = "  exact thought\n  ";
		const assistant = trajectoryStepsToMessages([step]).find(
			(message) => message.role === "assistant",
		);
		expect(assistant?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: step.thought }),
			]),
		);
	});

	it("preserves model-bound result and argument fields beyond diagnostic depth", () => {
		let deepResult: Record<string, unknown> = { sentinel: "DEEP_RESULT" };
		let deepArgs: Record<string, unknown> = { sentinel: "DEEP_ARGUMENT" };
		for (let depth = 0; depth < 24; depth++) {
			deepResult = { child: deepResult };
			deepArgs = { child: deepArgs };
		}
		const step = stepWithResult(1, "complete");
		if (!step.toolCall) throw new Error("missing tool call");
		step.toolCall.params = deepArgs;
		step.result = { success: true, data: deepResult };

		const messages = trajectoryStepsToMessages([step]);
		expect(JSON.stringify(messages)).toContain("DEEP_RESULT");
		expect(JSON.stringify(messages)).toContain("DEEP_ARGUMENT");
		expect(JSON.stringify(messages)).not.toContain("[REDACTED]");
	});

	it("rejects cyclic model-bound data instead of masking it", () => {
		const cyclic: Record<string, unknown> = { sentinel: "CYCLE" };
		cyclic.self = cyclic;
		const step = stepWithResult(1, "cycle");
		step.result = { success: true, data: cyclic };

		expect(() => trajectoryStepsToMessages([step])).toThrowError(
			expect.objectContaining({ code: "MODEL_TOOL_DATA_CYCLE" }),
		);
	});

	it("rejects cyclic generated-id arguments with the same typed error", () => {
		const cyclic: Record<string, unknown> = { sentinel: "ARG_CYCLE" };
		cyclic.self = cyclic;
		const step = stepWithResult(1, "cycle");
		if (!step.toolCall) throw new Error("missing tool call");
		delete step.toolCall.id;
		step.toolCall.params = cyclic;

		expect(() => trajectoryStepsToMessages([step])).toThrowError(
			expect.objectContaining({ code: "MODEL_TOOL_DATA_CYCLE" }),
		);
	});
});

describe("renderActionResultsForModel", () => {
	it("preserves recoverable page text and its exact continuation", () => {
		const page = `BEGIN${"x".repeat(20_000)}END`;
		const rendered = renderActionResultsForModel([
			{
				success: true,
				text: page,
				data: { actionName: "FILE", rawBody: "SECOND_CARRIER" },
				promptData: { actionName: "FILE", readView: readViewFor(page) },
			},
		]);

		expect(rendered.text).toContain("file_opaque");
		expect(rendered.text).toContain(page);
		expect(rendered.text).toContain("SECOND_CARRIER");
		expect(rendered.stats).toEqual({
			resultCount: 1,
			pagesIncluded: 1,
			pagesOmitted: 0,
			omissionReasons: {},
		});
	});

	it("preserves a large non-recoverable result for final request preflight", () => {
		const text = `HEAD${"x".repeat(20_000)}TAIL`;
		const rendered = renderActionResultsForModel([
			{ success: true, text, data: { actionName: "BASH" } },
		]);
		expect(rendered.text).toContain(text);
	});

	it("redacts credentials from legacy model-facing results", () => {
		const rendered = renderActionResultsForModel([
			{
				success: true,
				text: "completed with sk-test-secret-value",
				data: { apiKey: "must-not-leak", actionName: "FETCH" },
			},
		]);

		expect(rendered.text).not.toContain("sk-test-secret-value");
		expect(rendered.text).not.toContain("must-not-leak");
		expect(rendered.text).toContain("[REDACTED]");
	});
});

describe("toolMessageContent", () => {
	it("keeps complete data alongside supplemental promptData", () => {
		const memories = Array.from({ length: 17 }, (_, index) => ({
			id: `id-${index}`,
			type: "facts",
			text: `stored fact ${index}: ${"detail ".repeat(400)}`,
		}));
		const rendered = toolMessageContent({
			success: true,
			text: "Showing all 17 match(es) found in the scanned window.",
			data: { actionName: "MEMORY", op: "search", memories },
			promptData: { actionName: "MEMORY", op: "search", matchedInWindow: 17 },
		});
		expect(rendered).toContain('"matchedInWindow": 17');
		expect(rendered).toContain("stored fact 0");
		expect(rendered).toContain("stored fact 16");
	});

	it("renders large chaining data completely", () => {
		const marker = `CHAINING_FIELD_${"x".repeat(150_000)}_END`;
		const rendered = toolMessageContent({
			success: true,
			text: "Created workspace.",
			data: { agentId: "a1", marker, workspaceId: "w1" },
		});
		expect(rendered).toContain(marker);
		expect(rendered).toContain('"workspaceId": "w1"');
	});

	it("renders large data completely when no text projection exists", () => {
		const rows = Array.from(
			{ length: 2_000 },
			(_, index) => `row ${index} ${"y".repeat(100)}`,
		);
		const rendered = toolMessageContent({ success: true, data: { rows } });
		expect(rendered).toContain("row 1999");
		expect(rendered).not.toMatch(/truncated|omitted/i);
	});

	it("preserves recoverable text while avoiding a duplicate machine payload", () => {
		const readView = {
			reference: { kind: "file" as const, ref: "file_opaque", revision: "r1" },
			slice: {
				range: { unit: "line" as const, start: 0, end: 100, total: 200 },
				hasPrevious: false,
				hasMore: true,
				nextOffset: 100,
				revision: "r1",
				completeness: "partial-recoverable" as const,
				sliceSha256: "a".repeat(64),
			},
		};
		const text = `BEGIN${"x".repeat(20_000)}END`;
		const rendered = toolMessageContent({
			success: true,
			text,
			data: { readView, body: "must-not-duplicate", path: "/raw/path" },
			promptData: { readView, actionName: "FILE" },
		});
		const parsed = JSON.parse(rendered);
		expect(parsed.text).toBe(text);
		expect(parsed.data).toEqual({
			readView,
			body: "must-not-duplicate",
			path: "/raw/path",
		});
		expect(parsed.promptData.readView).toEqual(readView);
		expect(rendered).toContain("/raw/path");
		expect(rendered).toContain("must-not-duplicate");
	});

	it("preserves recoverable legacy-data text and continuation", () => {
		const text = `BEGIN${"x".repeat(20_000)}END`;
		const readView = readViewFor(text);
		const parsed = JSON.parse(
			toolMessageContent({
				success: true,
				text,
				data: { actionName: "FILE", readView },
			}),
		);

		expect(parsed.text).toBe(text);
		expect(parsed.data.readView).toEqual(readView);
	});

	it("preserves exact page text and its validated slice hash when included", () => {
		const text = `BEGIN\u0000é🙂\r\n${"exact ".repeat(200)}END`;
		const readView = readViewFor(text);
		const parsed = JSON.parse(
			toolMessageContent({
				success: true,
				text,
				promptData: { actionName: "FILE", readView },
			}),
		);
		expect(parsed.text).toBe(text);
		expect(parsed.promptData.readView.slice.sliceSha256).toBe(
			readView.slice.sliceSha256,
		);
	});

	it("preserves reference-only search text completely", () => {
		const reference = {
			kind: "document" as const,
			ref: "document:00000000-0000-0000-0000-000000000001",
			revision: "rev:stable",
		};
		const text = "match ".repeat(10_000);
		const rendered = toolMessageContent({
			success: true,
			text,
			promptData: { results: [{ reference }] },
		});
		expect(JSON.parse(rendered).text).toBe(text);
	});

	it("preserves text beside hostile ReadView-like metadata", () => {
		const text = "x".repeat(20_000);
		const invalidReadView = {
			...readViewFor(text),
			rawPath: "/Users/private/secret.txt",
		};
		const rendered = toolMessageContent({
			success: true,
			text,
			promptData: { readView: invalidReadView },
		});
		expect(JSON.parse(rendered).text).toBe(text);
	});

	it("reports that every validated page is included", () => {
		const shortText = "short exact page";
		const longText = `BEGIN${"x".repeat(20_000)}END`;
		let stats:
			| Parameters<
					NonNullable<
						Parameters<typeof trajectoryStepsToMessages>[1]["onProjectionStats"]
					>
			  >[0]
			| null = null;
		trajectoryStepsToMessages(
			[
				{
					...stepWithResult(1, shortText),
					result: {
						success: true,
						text: shortText,
						promptData: { readView: readViewFor(shortText) },
					},
				},
				{
					...stepWithResult(2, longText),
					result: {
						success: true,
						text: longText,
						promptData: { readView: readViewFor(longText) },
					},
				},
			],
			{
				onProjectionStats: (value) => {
					stats = value;
				},
			},
		);
		expect(stats).toEqual({
			resultCount: 2,
			pagesIncluded: 2,
			pagesOmitted: 0,
			omissionReasons: {},
		});
		expect(JSON.stringify(stats)).not.toMatch(
			/short exact page|BEGIN|file_opaque/u,
		);
	});

	it("preserves a large non-recoverable result for request-level rejection", () => {
		const text = "x".repeat(20_000);
		expect(JSON.parse(toolMessageContent({ success: true, text })).text).toBe(
			text,
		);
	});

	it("keeps complete data and supplemental promptData without mutation", () => {
		const result = {
			success: true,
			text: "page",
			data: { complete: "runtime" },
			promptData: { safe: "model" },
		};
		const projected = projectToolResultForModel(result);
		expect(projected.data).toEqual({ complete: "runtime" });
		expect(projected.promptData).toEqual({ safe: "model" });
		expect(result.data).toEqual({ complete: "runtime" });
	});

	it("honors only explicit producer projection and retains text, failure and receipts", () => {
		const result = {
			success: false,
			text: "Navigation was not confirmed.",
			error: "transport unavailable",
			data: { currentSchema: "full callable schema" },
			promptData: { capability: "select-day", read: "VIEWS action=list" },
			promptDataMode: "replace-data" as const,
			turnComplete: false,
		};
		const rendered = JSON.parse(toolMessageContent(result));
		expect(rendered).toEqual({
			success: false,
			text: result.text,
			error: result.error,
			data: result.promptData,
			turnComplete: false,
		});
		expect(result.data.currentSchema).toBe("full callable schema");
		expect(
			projectToolResultForModel({ ...result, promptData: undefined }).data,
		).toEqual(result.data);
		const steps = [{ ...stepWithResult(1, result.text), result }];
		expect(
			JSON.parse(getRenderedResultValue(trajectoryStepsToMessages(steps))),
		).toEqual(rendered);
		expect(renderActionResultsForModel([result]).text).not.toContain(
			"full callable schema",
		);
	});
});
