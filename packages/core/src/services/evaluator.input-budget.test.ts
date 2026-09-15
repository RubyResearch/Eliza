/**
 * Pre-dispatch input budget for the merged post-turn evaluator call. Under
 * POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS the prompt is dispatched unchanged;
 * over it the oldest RECENT_MESSAGES rows are dropped (newest kept) until it
 * fits; an untrimmable prompt skips the call, settles the trajectory step as
 * gated and never throws (live 2026-09-13: 137,434 and 151,523 prompt tokens
 * against a 131,072-token window).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { estimateModelInputTokens } from "../runtime/model-input-budget";
import { runWithTrajectoryContext } from "../trajectory-context";
import type { Character, Memory, Service } from "../types";
import { conversationMessagesHeader } from "../utils";
import { EvaluatorService } from "./evaluator";

const BUDGET_TOKENS = 3_000;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002";
const OMISSION_NOTE = "omitted for the post-turn evaluator input budget";

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorBudgetAgent",
			bio: "test",
			settings: {
				POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS: String(BUDGET_TOKENS),
			},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: {},
		data: {},
		text: "",
	}));
	runtime.emitEvent = vi.fn(async () => {});
	runtime.registerEvaluator({
		name: "alpha",
		description: "alpha section",
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prompt: () => "Extract alpha.",
		parse: (output) => output as never,
		processors: [
			{ name: "storeAlpha", process: async () => ({ success: true }) },
		],
	});
	return runtime;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		entityId: ENTITY_ID as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

/** Rows in the shape formatMessages renders: newest first, oldest last. */
function conversationBlock(rowCount: number): string {
	const rows = Array.from({ length: rowCount }, (_, index) => {
		const ordinal = rowCount - 1 - index;
		return `12:00 (2 hours ago) [${ENTITY_ID}] Nubs: row ${ordinal} ${"lorem ipsum dolor ".repeat(4)}`;
	});
	return `${conversationMessagesHeader(rowCount)}\n${rows.join("\n")}\n`;
}

function stateWithBlock(block: string) {
	const providerText = `${block}\n\n# Received Message\nNubs: hello\n`;
	return {
		values: {},
		data: { providers: { RECENT_MESSAGES: { text: providerText } } },
		text: `# Current Time\nnow\n${providerText}`,
	};
}

function captureModel(runtime: AgentRuntime): string[] {
	const prompts: string[] = [];
	runtime.useModel = vi.fn(async (_modelType, params) => {
		prompts.push(String(params.messages?.[0]?.content ?? ""));
		return { alpha: { ok: true } };
	}) as AgentRuntime["useModel"];
	return prompts;
}

function promptTokens(text: string): number {
	return estimateModelInputTokens({
		messages: [{ role: "user", content: text }],
	});
}

describe("post-turn evaluator input budget", () => {
	it("dispatches an under-budget prompt unchanged", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const block = conversationBlock(5);

		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			stateWithBlock(block),
		);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(result.processedEvaluators).toEqual(["alpha"]);
		expect(result.errors).toEqual([]);
		expect(prompts[0]).toContain(block);
		expect(prompts[0]).not.toContain(OMISSION_NOTE);
	});

	it("drops the oldest conversation rows until the prompt fits, then dispatches", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const state = stateWithBlock(conversationBlock(400));
		expect(promptTokens(state.text)).toBeGreaterThan(BUDGET_TOKENS);

		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			state,
		);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(result.processedEvaluators).toEqual(["alpha"]);
		expect(result.errors).toEqual([]);
		const prompt = prompts[0] ?? "";
		expect(promptTokens(prompt)).toBeLessThanOrEqual(BUDGET_TOKENS);
		expect(prompt).toContain("Nubs: row 399 ");
		expect(prompt).not.toContain("Nubs: row 0 ");
		expect(prompt).toMatch(
			/\[\d+ older message\(s\) omitted for the post-turn evaluator input budget\]/,
		);
		expect(prompt).toContain("# Received Message\nNubs: hello");
		expect(prompt.split(conversationMessagesHeader(400))).toHaveLength(2);
		expect(prompt).toContain("Latest message:\nhello");
	});

	it("skips the call, settles the step as gated and returns skipped when nothing can be trimmed", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const warn = vi.spyOn(runtime.logger, "warn");
		const trajectories = {
			isEnabled: () => true,
			startStep: vi.fn(() => "child-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
		};
		const getService = runtime.getService.bind(runtime);
		runtime.getService = vi.fn((type: string) =>
			type === "trajectories"
				? (trajectories as unknown as Service)
				: getService(type),
		) as AgentRuntime["getService"];
		const state = {
			values: {},
			data: {},
			text: `# Notes\n${"x".repeat(40_000)}`,
		};
		expect(promptTokens(state.text)).toBeGreaterThan(BUDGET_TOKENS);

		const result = await runWithTrajectoryContext(
			{ trajectoryId: "traj-1", trajectoryStepId: "step-1" },
			() => new EvaluatorService(runtime).run(makeMessage(), state),
		);

		expect(prompts).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			skipped: true,
			activeEvaluators: ["alpha"],
			processedEvaluators: [],
			errors: [],
		});
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				src: "service:evaluator",
				reason: "input_budget_exceeded",
				budgetTokens: BUDGET_TOKENS,
			}),
			expect.stringContaining("POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS"),
		);
		expect(trajectories.completeStep).toHaveBeenCalledWith(
			"traj-1",
			"step-1",
			expect.objectContaining({
				actionType: "evaluator",
				actionName: "post_turn",
				result: expect.objectContaining({
					data: expect.objectContaining({
						gated: true,
						llmCallSkipped: true,
						reason: "input_budget_exceeded",
					}),
				}),
			}),
		);
	});
});
