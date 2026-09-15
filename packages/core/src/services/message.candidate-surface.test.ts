/** Exercises Stage-1 candidate admission and terminal replies through the real parsers without model transport. */
import { describe, expect, it } from "vitest";
import type { Action } from "../types/components";
import {
	collectBudgetedStageOneCandidateActions,
	messageHandlerFromFieldResult,
} from "./message";
import { inferDirectCurrentRequestCandidateInference } from "./message/direct-action-heuristics";
import { parseMessageHandlerModelOutput } from "./message/stage1-generation";

const actions: Action[] = [
	{
		name: "PAGE",
		description: "Page operations",
		subActions: ["GO", "READ_PAGE"],
	},
	{ name: "GO", description: "Navigate" },
	{ name: "READ_PAGE", description: "Read the loaded page" },
	{ name: "UNRELATED", description: "Another domain" },
];

describe("budgeted model-selected action surface", () => {
	it.each(["none", "non_applied"] as const)(
		"keeps an explicit %s acknowledgement out of inferred app work",
		(replyEffectStatus) => {
			const envelope = {
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				intents: [],
				candidateActionNames: [],
				replyText: "Got it.",
				replyEffectStatus,
				facts: [],
				relationships: [],
				addressedTo: [],
			};
			const runtime = {
				actions: [
					{ name: "VIEWS", tags: ["views", "app", "notes", "calendar"] },
					{ name: "APP", tags: ["app", "apps"] },
				],
				messageText:
					"This is only an acknowledgement, with no app action or saved-record changes. Reply exactly: Got it.",
			};
			for (const result of [
				messageHandlerFromFieldResult(envelope, undefined, runtime),
				parseMessageHandlerModelOutput(JSON.stringify(envelope), runtime),
			]) {
				expect(result?.plan.requiresTool).not.toBe(true);
				expect(result?.plan.candidateActions ?? []).toEqual([]);
				expect(result?.plan.reply).toBe("Got it.");
			}
		},
	);
	it.each([
		{ candidates: ["DISCOVER_TOOLS"] },
		{ candidates: ["DISCOVER_TOOLS", "NOTES"] },
	])(
		"retains framework discovery hints before the planner registers them: %j",
		({ candidates }) => {
			const result = messageHandlerFromFieldResult(
				{
					shouldRespond: "RESPOND",
					contexts: ["general"],
					intents: ["inspect tool schemas"],
					candidateActionNames: candidates,
					replyText: "Discovering NOTES.",
					replyEffectStatus: "pending",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
				undefined,
				{
					actions: [
						{
							name: "VIEWS",
							tags: [
								"views",
								"ui",
								"panel",
								"view-capability",
								"notes",
								"calendar",
							],
						},
						{ name: "NOTES" },
					],
					messageText:
						"Technical QA: use DISCOVER_TOOLS to discover the NOTES family by its exact name. Tell me which note operations it exposes. Do not create, edit, delete, or navigate.",
				},
			);
			expect(result.plan.candidateActions).toEqual(candidates);
			expect(result.plan.requiresTool).toBe(true);
			// Native and text envelopes take the separate legacy backstop before
			// field parsing. Exercise that actual live dispatch path as well.
			const envelope = {
				shouldRespond: "RESPOND",
				contexts: ["general"],
				intents: ["inspect tools"],
				candidateActionNames: candidates,
				replyText: "Discovering NOTES.",
				replyEffectStatus: "pending",
			};
			const runtime = {
				actions: [
					{
						name: "VIEWS",
						tags: [
							"views",
							"ui",
							"panel",
							"view-capability",
							"notes",
							"calendar",
						],
					},
					{ name: "NOTES" },
				],
				messageText:
					"Discover NOTES. Do not create, edit, delete, or navigate.",
			};
			expect(
				inferDirectCurrentRequestCandidateInference(
					runtime.actions,
					runtime.messageText,
				).names,
			).toContain("VIEWS");
			expect(
				parseMessageHandlerModelOutput(JSON.stringify(envelope), runtime)?.plan
					.candidateActions,
			).toEqual(candidates);
			expect(
				parseMessageHandlerModelOutput(
					{
						text: "",
						toolCalls: [
							{
								type: "tool-call",
								toolCallId: "stage1",
								toolName: "HANDLE_RESPONSE",
								input: envelope,
							},
						],
					},
					runtime,
				)?.plan.candidateActions,
			).toEqual(candidates);
		},
	);
	it.each([
		"One quick conversation test: use Spanish for the next note confirmation only. Do not save that preference; just keep it in this conversation.",
		"Do not save it.",
	])(
		"does not override a model-classified no-save conversation: %s",
		(text) => {
			const reply =
				"Noted — when the next note confirmation comes up, I'll do it in Spanish for just that one, no saved preference.";
			const result = messageHandlerFromFieldResult(
				{
					shouldRespond: "RESPOND",
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					replyText: reply,
					replyEffectStatus: "none",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
				undefined,
				{ actions: [{ name: "OWNER_GOALS" }], messageText: text },
			);

			expect(result.plan.simple).toBe(true);
			expect(result.plan.requiresTool).toBe(false);
			expect(result.plan.candidateActions ?? []).toEqual([]);
			expect(result.plan.reply).toBe(reply);
		},
	);

	it.each([
		{ name: "pending effect", fields: { replyEffectStatus: "pending" } },
		{ name: "applied effect", fields: { replyEffectStatus: "applied" } },
		{
			name: "model-selected goal action",
			fields: { candidateActionNames: ["OWNER_GOALS"] },
		},
		{ name: "declared goal intent", fields: { intents: ["save the goal"] } },
		{ name: "non-simple context", fields: { contexts: ["general"] } },
		{
			name: "legacy missing effect status",
			fields: { replyEffectStatus: undefined },
		},
		{ name: "progress-only reply", fields: { replyText: "On it." } },
		{ name: "empty reply", fields: { replyText: "" } },
	])("preserves goal planning for $name", ({ fields }) => {
		const result = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				intents: [],
				candidateActionNames: [],
				replyText: "Your goal belongs in your owner goals.",
				replyEffectStatus: "none",
				facts: [],
				relationships: [],
				addressedTo: [],
				...fields,
			},
			undefined,
			{
				actions: [{ name: "OWNER_GOALS" }],
				messageText: "Save that goal.",
			},
		);

		expect(result.plan.simple).toBe(false);
		expect(result.plan.requiresTool).toBe(true);
		expect(result.plan.candidateActions).toContain("OWNER_GOALS");
	});

	it("preserves the model's complete intent list in the planner handoff", () => {
		const intents = [
			"open notes",
			"update the note body",
			"preserve its title",
		];
		const result = messageHandlerFromFieldResult({
			shouldRespond: "RESPOND",
			contexts: ["notes"],
			intents,
			candidateActionNames: ["VIEWS", "NOTES"],
			replyText: "",
			facts: [],
			relationships: [],
			addressedTo: [],
		});
		expect(result.plan.intents).toEqual(intents);
	});
	it("defers broad context matches when complete other families remain discoverable", () => {
		const catalog: Action[] = [
			{
				name: "NOTES",
				description: "Saved notes",
				contexts: ["notes"],
				subActions: ["NOTES_LIST"],
			},
			{ name: "NOTES_LIST", description: "Read notes", contexts: ["notes"] },
			{ name: "DOCUMENT", description: "Documents", contexts: ["documents"] },
			{ name: "FILES", description: "Files", contexts: ["documents"] },
		];
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: catalog,
				candidateActions: ["NOTES_LIST"],
				contexts: ["general", "documents"],
				deferUnselectedContexts: true,
			}).map((a) => a.name),
		).toEqual(["NOTES_LIST"]);
		// Legacy budget recovery has no discovery guarantee and retains fallback.
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: catalog,
				candidateActions: ["NOTES_LIST"],
				contexts: ["documents"],
			}).map((a) => a.name),
		).toEqual(["NOTES", "NOTES_LIST", "DOCUMENT", "FILES"]);
	});

	it("retains a selected child's authorized umbrella without exposing unrelated domains", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["GO"],
				contexts: [],
			}).map((action) => action.name),
		).toEqual(["PAGE", "GO", "READ_PAGE"]);
	});

	it("does not reintroduce a gated parent or infer one from name prefixes", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: actions.filter((action) => action.name !== "PAGE"),
				candidateActions: ["READ_PAGE"],
				contexts: [],
			}).map((action) => action.name),
		).toEqual(["READ_PAGE"]);
	});

	it("keeps known families discoverable when another candidate is unresolved", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["GO", "MISSING_CAPABILITY"],
				contexts: [],
			}),
		).toEqual(actions.slice(0, 3));
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["MISSING_CAPABILITY"],
				contexts: [],
			}),
		).toEqual([]);
	});

	it.each(["HOME", "home"])(
		"resolves the model's %s destination hint alongside admitted navigation",
		(homeHint) => {
			const navigationActions: Action[] = [
				{ name: "VIEWS", description: "Navigate to an authorized app view" },
				{ name: "CALENDAR", description: "Manage calendar events" },
			];
			expect(
				collectBudgetedStageOneCandidateActions({
					actions: navigationActions,
					candidateActions: [homeHint, "VIEWS"],
					contexts: ["general"],
				}).map((action) => action.name),
			).toEqual(["VIEWS"]);
			expect(
				collectBudgetedStageOneCandidateActions({
					actions: navigationActions,
					candidateActions: ["HOME", "MISSING_CAPABILITY"],
					contexts: ["general"],
				}),
			).toEqual([navigationActions[0]]);
			expect(
				collectBudgetedStageOneCandidateActions({
					actions: navigationActions.filter(
						(action) => action.name !== "VIEWS",
					),
					candidateActions: ["HOME"],
					contexts: ["general"],
				}),
			).toEqual([]);
		},
	);

	it("prefers a genuinely registered HOME action over the destination alias", () => {
		const home: Action = {
			name: "HOME",
			description: "A registered domain action",
		};
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [home, { name: "VIEWS", description: "Navigate" }],
				candidateActions: ["HOME"],
				contexts: [],
			}),
		).toEqual([home]);
	});

	it("retains model-selected domain actions when a synthetic candidate aliases to navigation", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [
					{ name: "VIEWS", description: "Navigation" },
					{
						name: "NOTES",
						description: "Note data",
						contexts: ["notes", "general"],
					},
					{
						name: "CALENDAR",
						description: "Events",
						contexts: ["calendar", "general"],
					},
				],
				candidateActions: ["VIEWS", "NOTES_CREATE_NOTE"],
				contexts: ["notes", "general"],
			}).map((action) => action.name),
		).toEqual(["VIEWS", "NOTES"]);
	});

	it("does not broaden the surface based on generic or current-page contexts", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [
					...actions,
					{ name: "GENERIC", description: "General", contexts: ["general"] },
					{
						name: "PAGE_ONLY",
						description: "Page",
						contexts: ["page", "page-notes"],
					},
				],
				candidateActions: ["GO"],
				contexts: ["general", "page", "page-notes"],
			}).map((action) => action.name),
		).toEqual(["PAGE", "GO", "READ_PAGE"]);
	});

	it("does not expand a resolved Calendar candidate to every action sharing its context", () => {
		const calendarActions: Action[] = [
			{ name: "VIEWS", description: "Navigation", contexts: ["general"] },
			{
				name: "CALENDAR",
				description: "Calendar",
				contexts: ["calendar", "tasks"],
			},
			{
				name: "OWNER_ROUTINES",
				description: "Routines",
				contexts: ["calendar"],
			},
			{
				name: "OWNER_DOCUMENTS",
				description: "Documents",
				contexts: ["calendar"],
			},
		];
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: calendarActions,
				candidateActions: ["VIEWS", "CALENDAR"],
				contexts: ["calendar"],
			}).map((action) => action.name),
		).toEqual(["VIEWS", "CALENDAR"]);
	});
});
