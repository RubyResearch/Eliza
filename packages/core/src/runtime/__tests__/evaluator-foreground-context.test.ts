/**
 * Exercises the evaluator's model wire input with deterministic provider output.
 * The complete turn and native tool history remain unchanged in storage while
 * completion excludes only known planner diagnostics and JSON indentation.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContextObject } from "../../types/context-object";
import type { ChatMessage } from "../../types/model";
import { renderContextObject } from "../context-renderer";
import { runEvaluator } from "../evaluator";
import { trajectoryStepsToMessages } from "../planner-rendering";
import type { PlannerStep, PlannerTrajectory } from "../planner-types";

const actionSurface = {
	mode: "tiered",
	candidateActionCount: 80,
	discoverableActionCount: 80,
	discoveryToolName: "DISCOVER_TOOLS",
	catalogParentCount: 80,
	exposedActionCount: 3,
	tierAParents: ["NOTES", "CALENDAR", "VIEWS"],
	tierBParents: [],
	omittedParentCount: 77,
	omittedParentNamesPreview: ["UNRELATED_CATALOG_ENTRY"],
	warnings: 0,
	queryTokens: ["same", "item"],
	candidateActions: ["NOTES", "CALENDAR"],
	parentActionHints: [],
};

function context(
	surface: Record<string, unknown> = actionSurface,
): ContextObject {
	return {
		id: "foreground-context",
		staticPrefix: {
			systemPrompt: {
				content:
					"agent_name: Eliza\nuser_role: OWNER\nPrivacy rules remain binding.",
				stable: true,
			},
		},
		events: [
			{
				id: "earlier-constraint",
				type: "message",
				message: {
					role: "user",
					content:
						"Keep the original note's spelling:  Picnic!?  Do not edit any other record.",
				},
			},
			{
				id: "earlier-reference",
				type: "message",
				message: {
					role: "assistant",
					content: "The note you selected is note-1.",
				},
			},
			{
				id: "owner-context",
				type: "provider",
				name: "ownerPrivateProvider",
				text: "Authorized owner context after privacy recomposition.",
			},
			{
				id: "recall",
				type: "provider",
				name: "recent-conversations",
				text: "Stored conversations remain available through authorized MEMORY reads.",
			},
			{
				id: "current-request",
				type: "message",
				message: {
					role: "user",
					content: "Use that same note and keep those constraints.",
				},
			},
			{
				id: "handler-current",
				type: "message_handler",
				source: "message-service",
				content:
					"Resolved reference note-1; navigation forbidden by the request.",
				metadata: {
					processMessage: "RESPOND",
					plan: {
						contexts: ["notes", "calendar"],
						intents: [
							"update selected note",
							"read corresponding calendar event",
						],
						responseHandlerPatches: [
							{ customConstraint: "No external posting." },
						],
						actionSurface: surface,
					},
				},
			},
		],
	} as ContextObject;
}

async function evaluateWithHistory(
	baseContext: ContextObject,
	steps: PlannerStep[],
	extraHistory: ChatMessage[] = [],
) {
	const modelHistory = [...trajectoryStepsToMessages(steps), ...extraHistory];
	const trajectory: PlannerTrajectory = {
		context: baseContext,
		modelBaseContext: baseContext,
		modelHistory,
		steps,
		archivedSteps: [],
		plannedQueue: [
			{ id: "pending-read", name: "CALENDAR", params: { action: "read" } },
		],
		evaluatorOutputs: [],
	};
	const before = JSON.stringify(trajectory);
	const useModel = vi.fn(async () =>
		JSON.stringify({
			thought: "Keep the remaining work pending.",
			success: false,
			decision: "CONTINUE",
		}),
	);
	await runEvaluator({
		runtime: { useModel },
		context: baseContext,
		trajectory,
	});
	expect(JSON.stringify(trajectory)).toBe(before);
	const call = useModel.mock.calls[0] as unknown as [
		string,
		{ messages: ChatMessage[]; tools?: unknown },
	];
	return { messages: call[1].messages, modelHistory, tools: call[1].tools };
}

describe("foreground evaluator context", () => {
	it.each([
		{
			name: "single Notes write",
			success: true,
			data: {
				noteId: "note-1",
				title: "  Picnic!?  ",
				body: "first\n\tsecond  ",
			},
		},
		{
			name: "compound Notes/Calendar partial failure",
			success: false,
			data: {
				noteId: "note-1",
				calendar: {
					error: "Calendar temporarily unavailable",
					retryable: true,
				},
			},
		},
		{
			name: "no-change constraint",
			success: true,
			data: {
				changed: false,
				constraint: "Do not create, edit, delete or navigate.",
			},
		},
		{
			name: "ambiguous target",
			success: false,
			data: {
				candidates: [{ id: "note-1" }, { id: "note-2" }],
				needsClarification: true,
			},
		},
		{
			name: "authorization denial",
			success: false,
			data: { reason: "owner_mismatch", allowed: false, attempted: false },
		},
	])(
		"retains complete semantic sources and results for $name",
		async ({ success, data }) => {
			const baseContext = context();
			const steps: PlannerStep[] = [
				{
					iteration: 1,
					toolCall: {
						id: "note-call",
						name: "NOTES",
						params: { action: "update", noteId: "note-1" },
					},
					result: {
						success,
						data,
						effectReceipts: [
							{
								receiptId: "exact-receipt",
								operation: "note.update",
								resource: { kind: "note", id: "note-1" },
								artifacts: [],
								idempotency: { key: "turn-1", replayed: false },
								observedAt: "2026-09-08T20:00:00Z",
								outcome: "applied",
								commit: {
									kind: "durable",
									id: "commit-1",
									committedAt: "2026-09-08T20:00:00Z",
								},
							},
						],
					},
				},
			];
			const feedback: ChatMessage = {
				role: "user",
				content:
					'pending_tool_queue: {"id":"pending-read","name":"CALENDAR"}\nplannerCompleted=false',
			};
			const { messages, modelHistory, tools } = await evaluateWithHistory(
				baseContext,
				steps,
				[feedback],
			);
			const wire = JSON.stringify(messages);
			expect(tools).toBeUndefined();
			for (const phrase of [
				"Privacy rules remain binding.",
				"OWNER",
				"Picnic!?",
				"Do not edit any other record.",
				"note-1",
				"authorized MEMORY reads",
				"ownerPrivateProvider",
				"No external posting.",
				"navigation forbidden",
				"pending-read",
				"plannerCompleted=false",
			]) {
				expect(wire).toContain(phrase);
			}
			expect(wire).not.toContain("UNRELATED_CATALOG_ENTRY");
			expect(wire).toContain("planner_retrieval_diagnostics");
			expect(messages.at(-1)).toEqual(feedback);
			const original = modelHistory.find((message) => message.role === "tool");
			const projected = messages.find((message) => message.role === "tool");
			const outputValue = (message: ChatMessage | undefined) => {
				const parts = message?.content as Array<{ output: { value: string } }>;
				return parts[0].output.value;
			};
			expect(JSON.parse(outputValue(projected))).toEqual(
				JSON.parse(outputValue(original)),
			);
			expect(outputValue(projected).length).toBeLessThan(
				outputValue(original).length,
			);
			expect(JSON.stringify(renderContextObject(baseContext))).toContain(
				"UNRELATED_CATALOG_ENTRY",
			);
		},
	);

	it("keeps future catalog fields and non-message-service events complete", async () => {
		const future = context({
			...actionSurface,
			futureConstraint: "Never change note-2.",
		});
		const { messages } = await evaluateWithHistory(future, []);
		expect(JSON.stringify(messages)).toContain("Never change note-2.");
		expect(JSON.stringify(messages)).toContain("UNRELATED_CATALOG_ENTRY");
		const custom = context();
		custom.events = custom.events.map((event) => ({
			...event,
			source: "custom-plugin",
		}));
		expect(
			JSON.stringify((await evaluateWithHistory(custom, [])).messages),
		).toContain("UNRELATED_CATALOG_ENTRY");
	});

	it.each([
		'Raw evidence before {"a":1} and after.',
		'{"id":9007199254740993}',
		'{"a":1,"a":2}',
		'```json\n{"a":1}\n```',
		'{"invalid":"\\q"}',
	])(
		"preserves custom or noncanonical tool text exactly: %s",
		async (value) => {
			const history: ChatMessage = {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "custom",
						toolName: "CUSTOM",
						output: { type: "text", value },
					},
				],
			};
			const { messages } = await evaluateWithHistory(context(), [], [history]);
			expect(messages.at(-1)).toEqual(history);
		},
	);
});
