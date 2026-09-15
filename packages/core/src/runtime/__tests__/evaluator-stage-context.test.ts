/**
 * The evaluator renders its own base context when the loop supplies one
 * (composed without ENTITIES / PLATFORM_USER_CONTEXT); without it the planner
 * base context renders exactly as before.
 */
import { describe, expect, it, vi } from "vitest";
import { EVALUATOR_STAGE_PROVIDER_EXCLUSIONS } from "../../services/message/provider-state";
import type { ContextObject } from "../../types/context-object";
import { runEvaluator } from "../evaluator";

function context(id: string, providers: string[]): ContextObject {
	return {
		id,
		staticPrefix: {
			characterPrompt: { content: "agent_name: Eliza", stable: true },
		},
		events: [
			...providers.map((name) => ({
				id: `provider:${name}`,
				type: "provider" as const,
				name,
				text: `${name} block`,
			})),
			{
				id: "history:1",
				type: "segment" as const,
				source: "prior-dialogue",
				segment: {
					id: "history:1",
					label: "prior_message:user",
					content: "nubs: earlier question",
					stable: false,
				},
			},
			{
				id: "msg",
				type: "message" as const,
				message: { role: "user" as const, content: { text: "Check status." } },
			},
		],
	} as ContextObject;
}

function harness() {
	const runtime = {
		useModel: vi.fn(
			async () =>
				'{"success":true,"thought":"Complete.","decision":"FINISH","messageToUser":"Done."}',
		),
	};
	return runtime;
}

function evaluatorUserMessage(runtime: {
	useModel: ReturnType<typeof vi.fn>;
}): string {
	const params = runtime.useModel.mock.calls[0]?.[1] as {
		messages?: Array<{ role: string; content: unknown }>;
	};
	return JSON.stringify(params.messages ?? []);
}

describe("evaluator stage context", () => {
	it("renders the evaluator base context when the loop supplies one", async () => {
		const runtime = harness();
		const full = context("ctx", [
			"RECENT_MESSAGES",
			"ENTITIES",
			"PLATFORM_USER_CONTEXT",
			"FACTS",
		]);
		const forEvaluator = context("ctx", ["RECENT_MESSAGES", "FACTS"]);
		await runEvaluator({
			runtime,
			context: full,
			trajectory: {
				context: full,
				modelBaseContext: full,
				evaluatorBaseContext: forEvaluator,
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
		const rendered = evaluatorUserMessage(runtime);
		expect(rendered).toContain("RECENT_MESSAGES block");
		expect(rendered).toContain("FACTS block");
		expect(rendered).toContain("earlier question");
		expect(rendered).not.toContain("ENTITIES block");
		expect(rendered).not.toContain("PLATFORM_USER_CONTEXT block");
	});

	it("falls back to the planner base context unchanged when none is supplied", async () => {
		const runtime = harness();
		const full = context("ctx", ["RECENT_MESSAGES", "ENTITIES"]);
		await runEvaluator({
			runtime,
			context: full,
			trajectory: {
				context: full,
				modelBaseContext: full,
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
		const rendered = evaluatorUserMessage(runtime);
		expect(rendered).toContain("ENTITIES block");
	});
});

describe("evaluator stage provider exclusions", () => {
	it("leaves out the blocks that describe what a reply may do, not whether a tool result satisfied the request", () => {
		expect(EVALUATOR_STAGE_PROVIDER_EXCLUSIONS).toEqual(
			expect.arrayContaining([
				"ENTITIES",
				"PLATFORM_USER_CONTEXT",
				"uiWidgets",
				"recent-conversations",
				"relevant-conversations",
				"CHANNEL_TOPICS",
				"firstRun",
			]),
		);
		// The dialogue, facts and the live time stay in.
		for (const kept of ["RECENT_MESSAGES", "FACTS", "CURRENT_TIME"]) {
			expect(EVALUATOR_STAGE_PROVIDER_EXCLUSIONS).not.toContain(kept);
		}
	});
});
