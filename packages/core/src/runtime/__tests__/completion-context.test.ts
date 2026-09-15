/**
 * Tests source-bound foreground selection through real Stage-1 rendering,
 * parsing and evaluator dispatch with deterministic model responses. No data
 * writes or live provider calls run; stored contexts are checked unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPlannerToolsFromActions } from "../../actions/to-tool";
import { validateSchema } from "../../actions/validate-tool-args";
import { plannerRequiredPolicy, plannerTemplate } from "../../prompts/planner";
import { renderMessageHandlerModelInput } from "../../services/message/stage1-input";
import type { CompletionContextSelection } from "../../types/components";
import type { ContextObject } from "../../types/context-object";
import type { ChatMessage, ToolDefinition } from "../../types/model";
import { completionContextFieldEvaluator } from "../builtin-field-evaluators";
import {
	COMPLETION_CONTEXT_SCHEMA,
	COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
	completionContextSources,
	parseCompletionContextSelection,
	referencePlannerQueryTokens,
	selectCompletionContext,
	withRequiredCompletionSourceIdentity,
} from "../completion-context";
import { runEvaluator } from "../evaluator";
import { parseMessageHandlerOutput } from "../message-handler";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerTrajectory } from "../planner-types";
import type { RecordedStage, TrajectoryRecorder } from "../trajectory-recorder";

function historyContext(): ContextObject {
	return {
		id: "message-current",
		metadata: { roomId: "room-owner", messageId: "message-current" },
		staticPrefix: {
			systemPrompt: {
				content: "Eliza; role=OWNER. Never expose private data.",
				stable: true,
			},
		},
		events: [
			...[
				"Do not send any email or change unrelated notes.",
				"The target is the note with title Picnic.",
				"Old completed unrelated weather request.",
				"Correction: keep the exact title  Picnic!?  with its spacing.",
			].map((content, index) => ({
				id: `history:message-${index + 1}`,
				type: "segment" as const,
				source: "prior-dialogue",
				createdAt: index,
				segment: {
					id: `history:message-${index + 1}`,
					label: "prior_message:user",
					content,
					stable: false,
					metadata: { roomId: "room-owner", entityId: "owner" },
				},
			})),
			{
				id: "history:assistant",
				type: "segment",
				source: "prior-dialogue",
				segment: {
					id: "history:assistant",
					label: "prior_message:agent",
					content: "You selected note-1. The calendar read is still pending.",
					stable: false,
				},
			},
			{
				id: "provider:privacy",
				type: "provider",
				name: "ownerPrivateProvider",
				text: "Fresh private-provider recomposition: permission denied for shared room.",
			},
			{
				id: "provider:memory",
				type: "provider",
				name: "recent-conversations",
				text: "Authorized history lookup remains available.",
			},
			{
				id: "current-turn-boundary",
				type: "instruction",
				content: "Only the current request authorizes work.",
			},
			{
				id: "current-request",
				type: "message",
				message: {
					role: "user",
					content:
						"Read that note and finish the calendar lookup; do not modify anything.",
				},
			},
		],
	};
}

function selection(context: ContextObject): CompletionContextSelection {
	return {
		mode: "selected",
		complete: true,
		sourceSetId: completionContextSources(context).sourceSetId,
		relevantSourceIds: ["h2"],
		constraintSourceIds: ["h1", "h4"],
		referentSourceIds: ["h2"],
		pendingIntentSourceIds: ["h5"],
	};
}

function withSelection(
	context: ContextObject,
	selected: unknown = selection(context),
): ContextObject {
	return {
		...context,
		metadata: { ...context.metadata, completionContext: selected as never },
	};
}

function trajectory(context: ContextObject): PlannerTrajectory {
	return {
		context,
		modelBaseContext: context,
		steps: [
			{
				iteration: 1,
				toolCall: { id: "read-note", name: "NOTES", params: { id: "note-1" } },
				result: {
					success: true,
					data: { title: "  Picnic!?  ", body: "exact\n  note text" },
				},
			},
		],
		archivedSteps: [],
		plannedQueue: [
			{ id: "calendar-read", name: "CALENDAR", params: { action: "read" } },
		],
		evaluatorOutputs: [],
	};
}

describe("source-bound completion relevance", () => {
	it.each([
		"relevantSourceIds",
		"constraintSourceIds",
		"referentSourceIds",
		"pendingIntentSourceIds",
	] as const)(
		"declares the runtime source-ID contract for %s without dropping invalid sources",
		(field) => {
			const context = historyContext();
			const before = structuredClone(context);
			for (const id of ["", " ", "h0", "h01", "h-1", "h1extra"]) {
				const malformed = { ...selection(context), [field]: [id] };
				const errors: string[] = [];
				validateSchema(
					COMPLETION_CONTEXT_SCHEMA,
					malformed,
					"selection",
					errors,
				);
				expect(errors, JSON.stringify({ field, id })).not.toEqual([]);
				expect(parseCompletionContextSelection(malformed)).toBeUndefined();
				const fallback = selectCompletionContext(
					withSelection(context, malformed),
				);
				expect(fallback.applied).toBe(false);
				expect(fallback.context).toEqual(withSelection(context, malformed));
			}
			for (const ids of [[], ["h1"], ["h1", "h123456789"]]) {
				const valid = { ...selection(context), [field]: ids };
				const errors: string[] = [];
				validateSchema(COMPLETION_CONTEXT_SCHEMA, valid, "selection", errors);
				expect(errors).toEqual([]);
				expect(parseCompletionContextSelection(valid)?.[field]).toEqual(ids);
			}
			expect(context).toEqual(before);
		},
	);
	it.each([
		["relevant_prior_dialogue", "selected"],
		["all_prior_dialogue", "full"],
		["selected", "selected"],
		["full", "full"],
	] as const)(
		"preserves source selection and restoration semantics for wire mode %s",
		(wireMode, mode) => {
			const context = historyContext();
			const before = structuredClone(context);
			const wire = { ...selection(context), mode: wireMode };
			const errors: string[] = [];
			validateSchema(COMPLETION_CONTEXT_SCHEMA, wire, "", errors);
			expect(errors).toEqual([]);
			expect(parseCompletionContextSelection(wire)).toEqual({
				...selection(context),
				mode,
			});
			const selected = selectCompletionContext(withSelection(context, wire));
			const legacy = selectCompletionContext(
				withSelection(context, { ...wire, mode }),
			);
			expect(selected.context.events).toEqual(legacy.context.events);
			expect(selected.applied).toBe(mode === "selected");
			expect(selected.context.events).toContainEqual(context.events[0]);
			expect(selected.context.events).toContainEqual(context.events[3]);
			expect(
				selectCompletionContext(
					withSelection(context, { ...wire, complete: false }),
				).applied,
			).toBe(false);
			expect(
				selectCompletionContext(
					withSelection(context, { ...wire, sourceSetId: "stale" }),
				).applied,
			).toBe(false);
			expect(context).toEqual(before);
		},
	);

	it.each([false, true])(
		"renders source policy once in the stable prefix without changing evidence or binding (registered fields: %s)",
		(withFields) => {
			const context = historyContext();
			const before = structuredClone(context);
			const sources = completionContextSources(context);
			const input = renderMessageHandlerModelInput(
				{ character: { name: "Eliza" } },
				context,
				[],
				{
					responseHandlerFields: withFields
						? `### completionContext\n${completionContextFieldEvaluator.description}`
						: undefined,
				},
			);
			const policySegments = input.promptSegments.filter((segment) =>
				segment.content.includes(COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS),
			);
			expect(policySegments).toHaveLength(1);
			expect(policySegments[0]?.stable).toBe(true);
			const binding = input.promptSegments.filter((segment) =>
				segment.content.includes(
					`completion_source_set: ${sources.sourceSetId}`,
				),
			);
			expect(binding).toHaveLength(1);
			expect(binding[0]?.stable).toBe(false);
			const wire = input.messages.map((message) => message.content).join("\n");
			for (const { id, event } of sources.sources) {
				expect(wire).toContain(`[${id}]`);
				expect(wire).toContain(event.segment.content);
			}
			expect(context).toEqual(before);
			expect(completionContextSources(context)).toEqual(sources);
		},
	);

	it("requires a complete identity only when history supplies one without varying the tool schema by turn", () => {
		const context = historyContext();
		const schema = {
			type: "object",
			properties: { completionContext: COMPLETION_CONTEXT_SCHEMA },
		};
		const before = JSON.stringify(schema);
		const bound = withRequiredCompletionSourceIdentity(schema, context);
		const missing = { ...selection(context), sourceSetId: "" };
		const errors: string[] = [];
		validateSchema(bound, { completionContext: missing }, "", errors);
		expect(errors).toEqual([expect.stringContaining("sourceSetId")]);
		const nextTurn = { ...context, id: "another-turn" };
		expect(completionContextSources(nextTurn).sourceSetId).not.toBe(
			selection(context).sourceSetId,
		);
		expect(withRequiredCompletionSourceIdentity(schema, nextTurn)).toEqual(
			bound,
		);
		const empty = { ...context, events: [] };
		expect(withRequiredCompletionSourceIdentity(schema, empty)).toBe(schema);
		expect(JSON.stringify(schema)).toBe(before);
	});

	it("declares complete source identities to the model and keeps truncated selections in full-context fallback", () => {
		const context = historyContext();
		const complete = selection(context);
		const validErrors: string[] = [];
		validateSchema(
			COMPLETION_CONTEXT_SCHEMA,
			complete,
			"selection",
			validErrors,
		);
		expect(validErrors).toEqual([]);
		const truncated = {
			...complete,
			sourceSetId: complete.sourceSetId.slice(0, 38),
		};
		const errors: string[] = [];
		validateSchema(COMPLETION_CONTEXT_SCHEMA, truncated, "selection", errors);
		expect(errors).toEqual([expect.stringContaining("sourceSetId")]);
		const fallback = selectCompletionContext(withSelection(context, truncated));
		expect(fallback.applied).toBe(false);
		expect(fallback.context.events).toEqual(context.events);
		const noSourceErrors: string[] = [];
		validateSchema(
			COMPLETION_CONTEXT_SCHEMA,
			{ ...complete, mode: "full", complete: false, sourceSetId: "" },
			"selection",
			noSourceErrors,
		);
		expect(noSourceErrors).toEqual([]);
	});

	it("selects the exact repeated occurrence from its original full source", () => {
		const context = historyContext();
		const first = completionContextSources(context).sources[0].event;
		first.segment.content +=
			" Preserve this exact standing constraint. ".repeat(40);
		const repeated = structuredClone(first);
		repeated.id = "history:repeated";
		repeated.segment.id = repeated.id;
		context.events.push(repeated);
		const before = JSON.stringify(context);
		const input = renderMessageHandlerModelInput(
			{ character: { name: "Eliza" } },
			context,
		);
		expect(String(input.messages[1].content)).toContain(
			"[h6; same_text_as=h1]",
		);
		const chosen = {
			...selection(context),
			relevantSourceIds: ["h6"],
			constraintSourceIds: [],
			referentSourceIds: [],
			pendingIntentSourceIds: [],
		};
		const focused = selectCompletionContext(withSelection(context, chosen));
		expect(
			completionContextSources(focused.context).sources.map((s) => s.event),
		).toEqual([repeated]);
		expect(JSON.stringify(context)).toBe(before);
		expect(focused.context.events).toContainEqual(repeated);
	});
	it("labels complete Stage-1 source text and carries model-selected IDs through parsing", () => {
		const context = historyContext();
		const before = JSON.stringify(context);
		const input = renderMessageHandlerModelInput(
			{ character: { name: "Eliza" } },
			context,
		);
		const user = String(input.messages[1].content);
		for (const { id, event } of completionContextSources(context).sources) {
			expect(user).toContain(`[${id}]\n${event.segment.content}`);
		}
		expect(user).toContain(completionContextSources(context).sourceSetId);
		const chosen = selection(context);
		expect(completionContextFieldEvaluator.parse(chosen)).toEqual(chosen);
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				contexts: ["notes", "calendar"],
				intents: ["read note", "read calendar"],
				completionContext: chosen,
			}),
		);
		expect(parsed?.plan.completionContext).toEqual(chosen);
		expect(JSON.stringify(context)).toBe(before);
	});

	it("keeps all safety sources and selected constraints while omitting only unrelated prior user text", () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const focused = selectCompletionContext(full);
		expect(focused.applied).toBe(true);
		expect(focused.omittedSourceCount).toBe(1);
		expect(focused.context.events).toEqual(
			full.events.filter((event) => event.id !== "history:message-3"),
		);
		expect(JSON.stringify(full)).toBe(before);
	});

	it("keeps bindings valid across provider recomposition", () => {
		const original = historyContext();
		const recomposed: ContextObject = {
			...original,
			createdAt: Date.now(),
			events: original.events.map((event) =>
				event.id === "provider:privacy"
					? { ...event, text: "Recomposed owner privacy: no access granted." }
					: event,
			),
		};
		expect(completionContextSources(recomposed).sourceSetId).toBe(
			completionContextSources(original).sourceSetId,
		);
		const focused = selectCompletionContext(
			withSelection(recomposed, selection(original)),
		);
		expect(focused.applied).toBe(true);
		expect(JSON.stringify(focused.context)).toContain("no access granted");
	});
	it("preserves identical evidence when each source is emitted only in its most specific category", () => {
		const original = historyContext();
		const chosen = selection(original);
		chosen.relevantSourceIds = [];
		const duplicated = {
			...chosen,
			relevantSourceIds: [
				...chosen.relevantSourceIds,
				...chosen.constraintSourceIds,
				...chosen.referentSourceIds,
				...chosen.pendingIntentSourceIds,
			],
		};
		const compact = selectCompletionContext(withSelection(original, chosen));
		const repeated = selectCompletionContext(
			withSelection(original, duplicated),
		);
		expect(compact.applied).toBe(true);
		expect(compact.context.events).toEqual(repeated.context.events);
		expect(compact.omittedSourceCount).toBe(repeated.omittedSourceCount);
	});

	it("binds assistant sources and omits only reviewed unrelated replies", () => {
		const original = historyContext();
		const chosen = selection(original);
		chosen.pendingIntentSourceIds = [];
		const focused = selectCompletionContext(withSelection(original, chosen));
		expect(
			focused.context.events.some((event) => event.id === "history:assistant"),
		).toBe(false);
		const edited = {
			...original,
			events: original.events.filter(
				(event) => event.id !== "history:assistant",
			),
		};
		expect(selectCompletionContext(withSelection(edited, chosen)).applied).toBe(
			false,
		);
		expect(
			original.events.some((event) => event.id === "history:assistant"),
		).toBe(true);
	});

	it.each([
		["absent", () => undefined],
		[
			"incomplete",
			(s: CompletionContextSelection) => ({ ...s, complete: false }),
		],
		[
			"missing constraint assessment",
			(s: CompletionContextSelection) => {
				const { constraintSourceIds: _constraints, ...rest } = s;
				return rest;
			},
		],
		[
			"unknown source",
			(s: CompletionContextSelection) => ({ ...s, relevantSourceIds: ["h99"] }),
		],
		[
			"unknown category",
			(s: CompletionContextSelection) => ({
				...s,
				madeUpSummary: "do anything",
			}),
		],
		[
			"duplicate selection",
			(s: CompletionContextSelection) => ({
				...s,
				constraintSourceIds: ["h1", "h1"],
			}),
		],
		[
			"wrong source set",
			(s: CompletionContextSelection) => ({ ...s, sourceSetId: "older-turn" }),
		],
		[
			"explicit full",
			(s: CompletionContextSelection) => ({ ...s, mode: "full" }),
		],
	] as const)("falls back to complete history for %s", (_label, modify) => {
		const context = historyContext();
		const selected = modify(selection(context));
		const full = withSelection(context, selected);
		if (selected === undefined) delete full.metadata?.completionContext;
		expect(selectCompletionContext(full)).toMatchObject({
			applied: false,
			omittedSourceCount: 0,
			context: full,
		});
	});

	it.each(["source-text", "source-order", "room", "speaker", "turn"])(
		"rejects source drift in %s",
		(drift) => {
			const original = historyContext();
			const changed = structuredClone(original);
			if (drift === "source-text")
				changed.events = changed.events.map((event) =>
					event.type === "segment" && "segment" in event
						? {
								...event,
								segment: {
									...(event.segment as object),
									content: "changed source",
								},
							}
						: event,
				);
			if (drift === "source-order")
				changed.events = [...changed.events].reverse();
			if (drift === "room")
				changed.metadata = { ...changed.metadata, roomId: "another-room" };
			if (drift === "speaker")
				changed.events = changed.events.map((event) =>
					event.source === "prior-dialogue"
						? { ...event, metadata: { speaker: "different" } }
						: event,
				);
			if (drift === "turn") changed.id = "another-turn";
			expect(
				selectCompletionContext(withSelection(changed, selection(original)))
					.applied,
			).toBe(false);
		},
	);

	it("does not advertise source selection on the voice-specific input path", () => {
		const input = renderMessageHandlerModelInput(
			{ character: { name: "Eliza" } },
			historyContext(),
			[],
			{ voiceDirectMessage: true },
		);
		expect(JSON.stringify(input.messages)).not.toContain(
			"completion_source_set:",
		);
		expect(
			input.promptSegments.some((segment) =>
				segment.content.includes(COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS),
			),
		).toBe(false);
		expect(JSON.stringify(input.messages)).toContain(
			"Old completed unrelated weather request.",
		);
	});

	it("restores all original sources once without tools or effects when the evaluator requests them", async () => {
		const context = withSelection(historyContext());
		const stored = trajectory(context);
		const before = JSON.stringify(stored);
		const messages: ChatMessage[][] = [];
		const recorded = new Map<string, RecordedStage>();
		const recorder: TrajectoryRecorder = {
			startTrajectory: () => "context-restore",
			recordStage: async (_id, stage) => {
				recorded.set(stage.stageId, stage);
			},
			endTrajectory: async () => undefined,
			load: async () => null,
			list: async () => [],
		};
		const effect = vi.fn();
		const useModel = vi.fn(
			async (_type: string, params: { messages?: ChatMessage[] }) => {
				messages.push(params.messages ?? []);
				expect(effect).not.toHaveBeenCalled();
				return messages.length === 1
					? JSON.stringify({
							thought: "Need the omitted source before checking history.",
							success: false,
							decision: "CONTINUE",
							contextRequest: "full",
						})
					: JSON.stringify({
							thought: "Original sources show the calendar read is pending.",
							success: false,
							decision: "CONTINUE",
						});
			},
		);
		await runEvaluator({
			runtime: { useModel },
			context,
			trajectory: stored,
			recorder,
			trajectoryId: "context-restore",
			effects: { messageToUser: effect, copyToClipboard: effect },
		});
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(recorded.size).toBe(2);
		expect(
			[...recorded.values()].map((stage) => stage.model?.messages),
		).toEqual(messages);
		expect([...recorded.keys()][0]).toContain("-attempt-0");
		expect(JSON.stringify(messages[0])).not.toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(messages[1])).toContain(
			"Old completed unrelated weather request.",
		);
		for (const input of messages) {
			expect(JSON.stringify(input)).toContain("Do not send any email");
			expect(JSON.stringify(input)).toContain("read-note");
			expect(JSON.stringify(input)).toContain("exact");
		}
		expect(effect).not.toHaveBeenCalled();
		expect(
			JSON.stringify({ ...stored, modelBaseContext: stored.context }),
		).toBe(before);
		expect(
			stored.modelBaseContext?.metadata?.completionContext,
		).toBeUndefined();
	});

	it("cannot loop repeated full-context requests or deliver an intermediate reply", async () => {
		const context = withSelection(historyContext());
		const recorded = new Map<string, RecordedStage>();
		const recorder: TrajectoryRecorder = {
			startTrajectory: () => "repeated-context-restore",
			recordStage: async (_id, stage) => {
				recorded.set(stage.stageId, stage);
			},
			endTrajectory: async () => undefined,
			load: async () => null,
			list: async () => [],
		};
		const useModel = vi.fn(async () =>
			JSON.stringify({
				thought: "Need full history.",
				success: false,
				decision: "CONTINUE",
				contextRequest: "full",
			}),
		);
		const effect = vi.fn();
		const output = await runEvaluator({
			runtime: { useModel },
			context,
			trajectory: trajectory(context),
			recorder,
			trajectoryId: "repeated-context-restore",
			effects: { messageToUser: effect },
		});
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(recorded.size).toBe(2);
		expect([...recorded.keys()][0]).toContain("-attempt-0");
		expect([...recorded.keys()][1]).not.toContain("-attempt-");
		expect(output.protocolFailure).toBe(true);
		expect(effect).not.toHaveBeenCalled();
	});

	it("rejects non-object selectors rather than manufacturing an empty selection", () => {
		for (const input of [null, false, [], "h1", 1])
			expect(parseCompletionContextSelection(input)).toBeUndefined();
	});
});

describe("planner source selection and restoration", () => {
	it.each([
		{ restore: false, custom: false, forced: false, fail: false },
		{ restore: true, custom: false, forced: false, fail: false },
		{ restore: true, custom: true, forced: false, fail: false },
		{ restore: false, custom: false, forced: true, fail: false },
		{ restore: true, custom: false, forced: true, fail: false },
		{ restore: true, custom: true, forced: true, fail: false },
		{ restore: true, custom: false, forced: true, fail: true },
	])(
		"keeps reply-only synthesis scoped without replay (restore=$restore, custom=$custom, forced=$forced, fail=$fail)",
		async ({ restore, custom, forced, fail }) => {
			const full = withSelection(historyContext());
			const before = JSON.stringify(full);
			const captured: Record<string, unknown>[] = [];
			const execute = vi.fn(async () => ({
				success: true,
				text: "Exact note body: violet, previously amber.",
			}));
			const evaluate = vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				// A successful read with no usable final reply needs the fallback.
				messageToUser: "call:NOTES_READ{id:note-1}",
			}));
			let planned = false;
			const result = await runPlannerLoop({
				context: full,
				tools: forced ? [{ name: "NOTES_READ" }] : undefined,
				postToolReplySeed: forced
					? undefined
					: {
							toolCall: {
								id: "settled",
								name: "NOTES_READ",
								params: { id: "note-1" },
							},
							result: {
								success: true,
								modelReplyRequired: true,
								text: "Exact note body: violet, previously amber.",
							},
						},
				runtime: {
					...(custom
						? {
								getService: () => ({
									getPrompt: () => ({
										prompt:
											"Custom reply policy: use the note's exact punctuation.",
									}),
								}),
							}
						: {}),
					useModel: async (_type, params) => {
						if (forced && !planned) {
							planned = true;
							return {
								text: "",
								toolCalls: [
									{
										id: "settled",
										name: "NOTES_READ",
										arguments: { id: "note-1" },
									},
								],
							};
						}
						captured.push(params);
						if (fail && captured.length === 2) {
							throw new Error("Provider unavailable after context restoration");
						}
						return {
							text: JSON.stringify(
								restore && captured.length === 1
									? {
											toolCalls: [
												{
													name: "RESTORE_CONTEXT",
													params: {
														scope: "history",
														reason: "Need original weather evidence",
													},
												},
												{
													name: "NOTES_CREATE",
													params: { title: "Must never execute" },
												},
											],
											messageToUser: "",
											completed: false,
										}
									: {
											toolCalls: [],
											messageToUser: "The mug is violet, previously amber.",
											completed: true,
										},
							),
						};
					},
				},
				executeToolCall: execute,
				evaluate,
			});
			expect(captured).toHaveLength(restore ? 2 : 1);
			const first = JSON.stringify(captured[0].messages);
			expect(first).not.toContain("Old completed unrelated weather request.");
			expect(first).toContain(
				"Correction: keep the exact title  Picnic!?  with its spacing.",
			);
			expect(first).toContain("calendar read is still pending");
			expect(first).toContain("permission denied for shared room");
			expect(first).toContain("Exact note body: violet, previously amber.");
			expect(first).toContain("Reply-only context access");
			for (const call of captured) {
				expect(call.tools).toBeUndefined();
				const system = (call.messages as ChatMessage[]).find(
					({ role }) => role === "system",
				)?.content as string;
				expect(system).toContain("Never expose private data.");
				for (const rule of [
					plannerRequiredPolicy.completedEffects,
					plannerRequiredPolicy.responseStyle,
					plannerRequiredPolicy.widgets,
					plannerRequiredPolicy.workClaims,
					plannerRequiredPolicy.errorClaims,
				]) {
					expect(system).toContain(rule);
				}
				if (custom) {
					expect(system).toContain(
						"Custom reply policy: use the note's exact punctuation.",
					);
				} else {
					// A settled-result round should not pay for the entire action planner.
					expect(system.length).toBeLessThan(plannerTemplate.length / 2);
				}
			}
			if (restore) {
				expect(JSON.stringify(captured[1].messages)).toContain(
					"Old completed unrelated weather request.",
				);
				expect(JSON.stringify(captured[1].messages)).toContain(
					"Exact note body: violet, previously amber.",
				);
			}
			expect(execute).toHaveBeenCalledTimes(forced ? 1 : 0);
			expect(evaluate).toHaveBeenCalledTimes(forced ? 1 : 0);
			if (!fail) {
				expect(result.finalMessage).toBe(
					"The mug is violet, previously amber.",
				);
			}
			if (restore) {
				expect(
					result.trajectory.modelBaseContext?.metadata?.completionContext,
				).toBeUndefined();
			}
			expect(JSON.stringify(full)).toBe(before);
		},
	);
	it("references large query diagnostics losslessly and restores them without executing accompanying tools", async () => {
		const full = historyContext();
		const tokens = Array.from({ length: 1000 }, (_, i) => `query-token-${i}`);
		full.events.push({
			id: "search-diagnostics",
			type: "message_handler",
			source: "message-service",
			metadata: {
				plan: {
					intents: ["read note"],
					actionSurface: {
						mode: "tiered",
						queryTokens: tokens,
						candidateActions: ["NOTES"],
					},
					responseHandlerPatches: [{ changed: "permission preserved" }],
				},
			},
		});
		const before = JSON.stringify(full);
		const projected = referencePlannerQueryTokens(full);
		expect(projected.applied).toBe(true);
		expect(JSON.stringify(projected.context)).not.toContain("query-token-999");
		expect(JSON.stringify(projected.context)).toContain("permission preserved");
		expect(JSON.stringify(full)).toBe(before);
		const calls: string[] = [];
		const execute = vi.fn(async () => ({ success: true }));
		await runPlannerLoop({
			context: full,
			tools: buildPlannerToolsFromActions([
				{
					name: "NOTES",
					description: "read",
					parameters: [],
				},
			]),
			runtime: {
				useModel: async (_type, params) => {
					// Cerebras enforces strictness request-wide: an unflagged
					// protocol tool would disable the action's required arguments.
					for (const tool of params.tools as ToolDefinition[]) {
						expect(tool.strict).toBe(true);
					}
					calls.push(JSON.stringify(params));
					return calls.length === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "restore",
										name: "RESTORE_CONTEXT",
										arguments: { reason: "Inspect exact query diagnostics" },
									},
									{ id: "blocked", name: "NOTES", arguments: {} },
								],
							}
						: {
								text: "",
								toolCalls: [
									{
										id: "final",
										name: "REPLY",
										arguments: { text: "Reviewed." },
									},
								],
							};
				},
			},
			executeToolCall: execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Reviewed",
				messageToUser: "Reviewed.",
			}),
		});
		expect(calls[0]).toContain("RESTORE_CONTEXT");
		expect(calls[0]).not.toContain("query-token-999");
		expect(calls[1]).toContain("query-token-999");
		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(full)).toBe(before);
		const foreign = {
			...full,
			events: full.events.map((e) =>
				e.id === "search-diagnostics" ? { ...e, source: "custom" } : e,
			),
		};
		expect(referencePlannerQueryTokens(foreign).applied).toBe(false);
	});

	it("uses lossless references on restored planner and evaluator wire requests without replaying a blocked effect", async () => {
		const original = historyContext();
		original.metadata = {
			...original.metadata,
			historyReferenceEncoding: true,
		};
		const first = completionContextSources(original).sources[0].event;
		first.segment.content += " Exact standing constraint. ".repeat(60);
		const repeated = structuredClone(first);
		repeated.id = "history:repeated";
		repeated.segment.id = repeated.id;
		original.events.push(repeated);
		const full = withSelection(original);
		const before = structuredClone(full);
		const calls: Array<{ type: string; wire: string }> = [];
		let plans = 0;
		const execute = vi.fn(async () => ({
			success: true,
			text: "Read verified.",
		}));
		await runPlannerLoop({
			context: full,
			tools: [
				{
					name: "NOTES",
					description: "Read",
					parameters: { type: "object", properties: {} },
				},
			],
			runtime: {
				useModel: async (type, params) => {
					calls.push({
						type: String(type),
						wire: JSON.stringify(params.messages),
					});
					if (String(type) !== "ACTION_PLANNER")
						return JSON.stringify({
							success: true,
							decision: "FINISH",
							thought: "Receipt checked",
							messageToUser: "Read verified.",
						});
					plans++;
					return {
						text: "",
						toolCalls:
							plans === 1
								? [
										{
											id: "restore",
											name: "RESTORE_CONTEXT",
											arguments: {
												scope: "history",
												reason: "Need the repeated occurrence",
											},
										},
										{ id: "blocked", name: "NOTES", arguments: {} },
									]
								: [
										{
											id: "read",
											name: "NOTES",
											arguments: { eliza_turn_scope: "final" },
										},
									],
					};
				},
			},
			executeToolCall: execute,
		});
		expect(calls.map(({ type }) => type)).toEqual([
			"ACTION_PLANNER",
			"ACTION_PLANNER",
			"RESPONSE_HANDLER",
		]);
		expect(calls[0].wire).not.toContain("same_text_as=");
		for (const { wire } of calls.slice(1)) {
			expect(wire).toContain("[h6; same_text_as=h1]");
			expect(wire).toContain(first.segment.content);
			expect(wire).toContain(
				"Correction: keep the exact title  Picnic!?  with its spacing.",
			);
		}
		expect(execute).toHaveBeenCalledTimes(1);
		expect(full).toEqual(before);
	});

	const tools = [
		{
			name: "NOTES",
			description: "Read the exact note",
			parameters: {
				type: "object" as const,
				properties: { id: { type: "string" as const } },
				required: ["id"],
			},
		},
	];
	it("uses the selected prior users while keeping current request, privacy, referents and every tool receipt", async () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const calls: string[] = [];
		let n = 0;
		const execute = vi.fn(async () => ({
			success: true,
			data: { receiptId: "receipt-exact", body: "complete\nbody" },
		}));
		await runPlannerLoop({
			context: full,
			tools,
			runtime: {
				useModel: async (_type, params) => {
					calls.push(JSON.stringify(params));
					n++;
					return n === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "note-read",
										name: "NOTES",
										arguments: { id: "note-1" },
									},
								],
							}
						: {
								text: "",
								toolCalls: [
									{
										id: "finish",
										name: "REPLY",
										arguments: { text: "Read the note." },
									},
								],
							};
				},
			},
			executeToolCall: execute,
			evaluate: async () => ({
				success: false,
				decision: "CONTINUE",
				thought: "Review the complete receipt before finishing.",
			}),
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(calls[0]).not.toContain("Old completed unrelated weather request.");
		for (const text of [
			"Do not send any email",
			"Correction: keep the exact title",
			"calendar read is still pending",
			"permission denied for shared room",
			"Read that note and finish the calendar lookup",
		])
			expect(calls[0]).toContain(text);
		expect(calls[1]).toContain("receipt-exact");
		expect(calls[1]).toContain("complete");
		expect(JSON.stringify(full)).toBe(before);
	});
	it("defers provider bodies with no history selection and reauthorizes restoration before effects", async () => {
		const full = historyContext();
		full.metadata = { ...full.metadata, providerDiscoveryEnabled: true };
		full.events.push({
			id: "provider:guide",
			type: "provider",
			name: "GUIDE",
			source: "composeState",
			text: `STALE_PRIVATE_BODY ${"detail ".repeat(300)}`,
			discoveryText: "Guide syntax available on request.",
		});
		const before = JSON.stringify(full);
		const calls: string[] = [];
		const execute = vi.fn(async () => ({ success: true, text: "read" }));
		const restore = vi.fn(async (original: ContextObject) => ({
			...original,
			events: original.events.map((event) =>
				event.id === "provider:guide"
					? { ...event, text: "FRESH_AUTHORIZED_GUIDE" }
					: event,
			),
		}));
		await runPlannerLoop({
			context: full,
			tools,
			executeToolCall: execute,
			runtime: {
				restoreProviderContext: restore,
				useModel: async (_type, params) => {
					calls.push(JSON.stringify(params));
					return {
						text: "",
						toolCalls:
							calls.length === 1
								? [
										{
											id: "restore",
											name: "RESTORE_CONTEXT",
											arguments: { reason: "Need syntax" },
										},
										{
											id: "forbidden",
											name: "NOTES",
											arguments: { id: "wrong" },
										},
									]
								: [{ id: "read", name: "NOTES", arguments: { id: "note-1" } }],
					};
				},
			},
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "done",
				messageToUser: "Read.",
			}),
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("RESTORE_CONTEXT");
		expect(calls[0]).not.toContain("STALE_PRIVATE_BODY");
		expect(calls[1]).toContain("FRESH_AUTHORIZED_GUIDE");
		expect(calls[1]).not.toContain("STALE_PRIVATE_BODY");
		expect(restore).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(full)).toBe(before);
	});

	it.each(["history", "providers"] as const)(
		"restores only requested %s in planner and completion",
		async (scope) => {
			for (const stage of ["planner", "completion"] as const) {
				const full = withSelection(historyContext());
				full.metadata = { ...full.metadata, providerDiscoveryEnabled: true };
				full.events.push({
					id: "provider:guide",
					type: "provider",
					name: "GUIDE",
					text: `Complete guide ${"detail ".repeat(300)}`,
					discoveryText: "Guide reference available.",
				});
				const before = JSON.stringify(full);
				const calls: string[] = [];
				const execute = vi.fn();
				const restore = vi.fn(async (original: ContextObject) => original);
				const runtime = {
					restoreProviderContext: restore,
					useModel: async (_type: unknown, params: { messages?: unknown }) => {
						calls.push(JSON.stringify(params.messages));
						if (stage === "completion")
							return JSON.stringify(
								calls.length === 1
									? {
											thought: "Need missing context",
											success: false,
											decision: "CONTINUE",
											contextRequest: scope,
										}
									: {
											thought: "Verified",
											success: true,
											decision: "FINISH",
											messageToUser: "Done.",
										},
							);
						return {
							text: "",
							toolCalls:
								calls.length === 1
									? [
											{
												id: "restore",
												name: "RESTORE_CONTEXT",
												arguments: { reason: "Need missing context", scope },
											},
											{ id: "must-not-run", name: "NOTES", arguments: {} },
										]
									: [
											{
												id: "reply",
												name: "REPLY",
												arguments: { text: "Done.", eliza_turn_scope: "final" },
											},
										],
						};
					},
				};
				if (stage === "completion")
					await runEvaluator({
						context: full,
						trajectory: trajectory(full),
						runtime,
					});
				else
					await runPlannerLoop({
						context: full,
						tools,
						runtime,
						executeToolCall: execute,
						evaluate: async () => ({
							thought: "Verified",
							success: true,
							decision: "FINISH",
							messageToUser: "Done.",
						}),
					});
				expect(calls).toHaveLength(2);
				expect(calls[0]).not.toContain("Complete guide");
				expect(calls[0]).not.toContain(
					"Old completed unrelated weather request.",
				);
				expect(calls[1]?.includes("Complete guide")).toBe(
					scope === "providers",
				);
				expect(
					calls[1]?.includes("Old completed unrelated weather request."),
				).toBe(scope === "history");
				expect(restore).toHaveBeenCalledTimes(scope === "providers" ? 1 : 0);
				expect(execute).not.toHaveBeenCalled();
				expect(JSON.stringify(full)).toBe(before);
			}
		},
	);

	it("restores deferred provider text for completion without another action", async () => {
		const full = historyContext();
		full.metadata = { ...full.metadata, providerDiscoveryEnabled: true };
		full.events.push({
			id: "provider:guide",
			type: "provider",
			name: "GUIDE",
			text: `Complete guide ${"detail ".repeat(300)}`,
			discoveryText: "Guide reference available.",
		});
		const calls: string[] = [];
		const effects = vi.fn();
		const restore = vi.fn(async (original: ContextObject) => original);
		const turn = trajectory(full);
		await runEvaluator({
			context: full,
			trajectory: turn,
			effects: { messageToUser: effects },
			runtime: {
				restoreProviderContext: restore,
				useModel: async (_type, params) => {
					calls.push(JSON.stringify(params.messages));
					return calls.length === 1
						? JSON.stringify({
								success: false,
								decision: "CONTINUE",
								thought: "Need syntax",
								contextRequest: "full",
							})
						: JSON.stringify({
								success: true,
								decision: "FINISH",
								thought: "verified",
								messageToUser: "Done.",
							});
				},
			},
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).not.toContain("Complete guide");
		expect(calls[1]).toContain("Complete guide");
		expect(restore).toHaveBeenCalledTimes(1);
		expect(effects).toHaveBeenCalledTimes(1);
		expect(turn.modelBaseContext?.metadata?.providerDiscoveryEnabled).toBe(
			false,
		);
	});

	it("restores every original source without executing any call in the restoration batch", async () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const calls: Array<{ messages?: ChatMessage[]; tools?: unknown }> = [];
		const recorded: RecordedStage[] = [];
		const execute = vi.fn(async (_call: { id?: string }) => ({
			success: true,
			text: "read",
		}));
		const result = await runPlannerLoop({
			context: full,
			tools,
			runtime: {
				useModel: async (_type, params) => {
					calls.push(params);
					return calls.length === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "restore",
										name: "RESTORE_CONTEXT",
										arguments: { reason: "Check earlier constraints" },
									},
									{
										id: "must-not-run",
										name: "NOTES",
										arguments: { id: "wrong" },
									},
								],
							}
						: {
								text: "",
								toolCalls: [
									{ id: "read", name: "NOTES", arguments: { id: "note-1" } },
								],
							};
				},
			},
			executeToolCall: execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "done",
				messageToUser: "The note was read.",
			}),
			trajectoryId: "restore-test",
			recorder: {
				recordStage: async (_id, stage) => {
					recorded.push(stage);
				},
			} as TrajectoryRecorder,
		});
		expect(calls).toHaveLength(2);
		expect(JSON.stringify(calls[0].messages)).not.toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(calls[1].messages)).toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(calls[1].tools)).not.toContain("RESTORE_CONTEXT");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0][0]).toMatchObject({
			id: "read",
			params: { id: "note-1" },
		});
		expect(recorded.filter((stage) => stage.kind === "planner")).toHaveLength(
			2,
		);
		expect(
			result.trajectory.modelBaseContext?.metadata?.completionContext,
		).toBeUndefined();
		expect(JSON.stringify(full)).toBe(before);
	});
	it.each(["invalid", "incomplete", "coding"])(
		"retains complete planner history for %s selection",
		async (kind) => {
			const original = historyContext();
			const chosen = selection(original);
			const full = withSelection(original, {
				...chosen,
				...(kind === "invalid" ? { sourceSetId: "stale" } : {}),
				...(kind === "incomplete" ? { complete: false } : {}),
			});
			const captured: string[] = [];
			await runPlannerLoop({
				context: full,
				tools,
				codingMode: kind === "coding",
				runtime: {
					useModel: async (_type, params) => {
						captured.push(JSON.stringify(params));
						return {
							text: "",
							toolCalls: [
								{
									id: "done",
									name: "REPLY",
									arguments: { text: "No changes." },
								},
							],
						};
					},
				},
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			});
			expect(captured[0]).toContain("Old completed unrelated weather request.");
			expect(captured[0]).not.toContain('"name":"RESTORE_CONTEXT"');
		},
	);
	it("rejects a repeated restoration without a third inference or tool effect", async () => {
		const full = withSelection(historyContext());
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [
				{
					id: "restore",
					name: "RESTORE_CONTEXT",
					arguments: { reason: "again" },
				},
			],
		}));
		const executeToolCall = vi.fn();
		await expect(
			runPlannerLoop({
				context: full,
				tools,
				runtime: { useModel },
				executeToolCall,
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({ code: "PLANNER_CONTEXT_RESTORE_INVALID" });
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(executeToolCall).not.toHaveBeenCalled();
	});
});
