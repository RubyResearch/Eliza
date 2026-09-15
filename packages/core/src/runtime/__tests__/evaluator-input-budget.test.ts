/**
 * Covers the evaluator's lossless input contract. Inputs are sent unchanged
 * when they fit and rejected explicitly before provider dispatch when the
 * resolved model window cannot accept them.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { ElizaError } from "../../errors";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";
import { computePrefixHashes } from "../context-hash";
import { runEvaluator } from "../evaluator";
import { trajectoryStepsToMessages } from "../planner-rendering";

const ENVELOPE = `{
  "success": true,
  "decision": "FINISH",
  "thought": "Compared the approaches.",
  "messageToUser": "Here is the comparison."
}`;

const CONTEXT = {
	id: "ctx",
	staticPrefix: {
		characterPrompt: { content: "agent_name: Eliza", stable: true },
	},
	events: [
		{
			id: "msg",
			type: "message",
			message: { role: "user", content: { text: "compare alex's approach" } },
		},
	],
};

interface CapturedRequest {
	messages: Array<{
		role: string;
		content:
			| string
			| Array<{
					type: string;
					output?: { type: string; value: string };
			  }>;
	}>;
	promptSegments?: Array<{ content: string; stable?: boolean }>;
	providerOptions?: {
		eliza?: {
			thinking?: unknown;
		};
	};
}

function makeStep(iteration: number, resultText: string) {
	return {
		iteration,
		thought: "",
		toolCall: {
			id: `tool-${iteration}-0`,
			name: "GREP",
			params: { pattern: "approach" },
		},
		result: { success: true, text: resultText },
	};
}

function makeTrajectory(steps: ReturnType<typeof makeStep>[]) {
	return {
		context: { id: "ctx" },
		steps,
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}

function makeRuntime() {
	const captured: CapturedRequest[] = [];
	const runtime = {
		useModel: vi.fn(async (_modelType: unknown, request: unknown) => {
			captured.push(request as CapturedRequest);
			return ENVELOPE;
		}),
	};
	return { runtime, captured };
}

function makeRegisteredRuntime(
	registrations: Array<{
		modelType: string;
		provider: string;
		model: string;
	}>,
) {
	const base = makeRuntime();
	return {
		...base,
		runtime: {
			...base.runtime,
			getModelRegistrations: () =>
				registrations.map((registration) => ({
					modelType: registration.modelType,
					provider: registration.provider,
					metadata: { displayModel: registration.model },
				})),
		},
	};
}

function toolMessageValues(request: CapturedRequest): string[] {
	return request.messages
		.filter((message) => message.role === "tool")
		.flatMap((message) =>
			Array.isArray(message.content)
				? message.content
						.filter((part) => part.type === "tool-result")
						.map((part) => part.output?.value ?? "")
				: [],
		);
}

function _systemMessageContent(request: CapturedRequest): string {
	const system = request.messages.find((message) => message.role === "system");
	return typeof system?.content === "string" ? system.content : "";
}

describe("runEvaluator — complete input or explicit rejection", () => {
	it("preserves a large-context candidate's 30k tool result byte-for-byte", async () => {
		const result = "large-context-result-".repeat(1_600);
		const { runtime, captured } = makeRegisteredRuntime([
			{
				modelType: "RESPONSE_HANDLER",
				provider: "large",
				model: "claude-sonnet-5",
			},
		]);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		expect(toolMessageValues(request)[0]).toContain(result);
		expect(toolMessageValues(request)[0]).not.toContain("chars truncated]");
	});

	it("preserves the primary input and skips a failover that cannot fit it", async () => {
		const result = "x".repeat(500_000);
		const { runtime, captured } = makeRegisteredRuntime([
			{
				modelType: "RESPONSE_HANDLER",
				provider: "primary",
				model: "claude-sonnet-5",
			},
			{
				modelType: "TEXT_SMALL",
				provider: "backup",
				model: "llama3.1-8b",
			},
		]);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		const value = toolMessageValues(request)[0] ?? "";
		expect(value).toContain(result);
		expect(value).not.toContain("chars truncated]");
	});

	it("preserves complete input on a real AgentRuntime failover attempt", async () => {
		const primaryRequests: CapturedRequest[] = [];
		const backupRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				primaryRequests.push(request as CapturedRequest);
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.TEXT_NANO,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);
		const result = "x".repeat(1_000);
		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});
		expect(primaryRequests).toHaveLength(1);
		expect(backupRequests).toHaveLength(1);
		const primaryRequest = primaryRequests[0];
		const backupRequest = backupRequests[0];
		if (!primaryRequest || !backupRequest)
			throw new Error("missing failover request");
		expect(toolMessageValues(primaryRequest)[0]).toContain(result);
		expect(toolMessageValues(backupRequest)[0]).toContain(result);
		expect(toolMessageValues(backupRequest)[0]).not.toMatch(
			/truncated|omitted/i,
		);
		expect(backupRequest.providerOptions?.eliza?.thinking).toBe("off");
	});

	it("preserves complete input for a smaller backup under the same model type", async () => {
		const primaryRequests: CapturedRequest[] = [];
		const backupRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				primaryRequests.push(request as CapturedRequest);
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);
		const result = "x".repeat(1_000);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		expect(primaryRequests).toHaveLength(1);
		expect(backupRequests).toHaveLength(1);
		expect(
			toolMessageValues(primaryRequests[0] as CapturedRequest)[0],
		).toContain(result);
		expect(
			toolMessageValues(backupRequests[0] as CapturedRequest)[0],
		).toContain(result);
	});

	it("does not fail over after an unrelated attempt-preparation error", async () => {
		const primaryHandler = vi.fn(async () => ENVELOPE);
		const backupHandler = vi.fn(async () => ENVELOPE);
		const prepareModelAttempt = vi.fn((attempt: { provider: string }) => {
			if (attempt.provider === "primary") {
				throw new Error("attempt preparation defect");
			}
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			primaryHandler,
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			backupHandler,
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, {
				messages: [{ role: "user", content: "test" }],
				prepareModelAttempt,
			}),
		).rejects.toThrow("attempt preparation defect");

		expect(prepareModelAttempt).toHaveBeenCalledTimes(1);
		expect(primaryHandler).not.toHaveBeenCalled();
		expect(backupHandler).not.toHaveBeenCalled();
	});

	it("propagates a known-over-budget rejection from the fallback provider boundary", async () => {
		const backupHandler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			backupHandler,
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await expect(
			runEvaluator({
				runtime,
				context: {
					...CONTEXT,
					staticPrefix: {
						characterPrompt: {
							content: "characterization ".repeat(10_000),
							stable: true,
						},
					},
				},
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });
		expect(backupHandler).toHaveBeenCalledTimes(1);
	});

	it("budgets the actual owner-selected provider before its first attempt", async () => {
		const largeRequests: CapturedRequest[] = [];
		const smallHandler = vi.fn(async () => ENVELOPE);
		const runtime = new AgentRuntime({
			character: {
				name: "EvaluatorAgent",
				bio: "test",
				settings: {
					ELIZA_BRAIN_PROVIDER: "large",
					SMALL_EVALUATOR_MODEL: "llama3.1-8b",
				},
			} as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			100,
			{ displayModelSetting: "SMALL_EVALUATOR_MODEL" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				largeRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"large",
			10,
			{ displayModel: "claude-sonnet-5" },
		);
		const result = "x".repeat(100_000);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		expect(smallHandler).not.toHaveBeenCalled();
		expect(largeRequests).toHaveLength(1);
		expect(toolMessageValues(largeRequests[0] as CapturedRequest)[0]).toContain(
			result,
		);
	});

	it("uses env-backed model metadata and the ACTION_PLANNER fallback chain", async () => {
		vi.stubEnv("EVALUATOR_ACTION_MODEL", "claude-sonnet-5");
		try {
			const { runtime, captured } = makeRegisteredRuntime([
				{
					modelType: "ACTION_PLANNER",
					provider: "primary",
					model: "env-placeholder",
				},
				{ modelType: "TEXT_MEDIUM", provider: "medium", model: "llama3.1-8b" },
				{ modelType: "TEXT_SMALL", provider: "small", model: "llama3.1-8b" },
			]);
			const registered = runtime.getModelRegistrations?.() ?? [];
			(runtime.getModelRegistrations as () => Array<Record<string, unknown>>) =
				() => [
					{
						modelType: "ACTION_PLANNER",
						provider: "primary",
						metadata: { displayModelSetting: "EVALUATOR_ACTION_MODEL" },
					},
					...registered.slice(1),
				];
			await runEvaluator({
				runtime,
				modelType: ModelType.ACTION_PLANNER,
				context: CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "x".repeat(500_000))]),
				effects: {},
			});
			const request = captured[0];
			if (!request) throw new Error("missing action planner request");
			expect(toolMessageValues(request)[0]).toContain("x".repeat(500_000));
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps a usable input budget for a sub-10k custom model window", async () => {
		vi.stubEnv("MODEL_CONTEXT_WINDOWS_JSON", '{"tiny-evaluator":8000}');
		try {
			const { runtime, captured } = makeRegisteredRuntime([
				{
					modelType: "RESPONSE_HANDLER",
					provider: "tiny",
					model: "tiny-evaluator",
				},
			]);

			await runEvaluator({
				runtime,
				context: CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			});

			expect(captured).toHaveLength(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("rejects one over-window result instead of changing it", async () => {
		const hugeResult = "😀".repeat(2_500_000); // 5,000,000 UTF-16 code units
		const handler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(ModelType.RESPONSE_HANDLER, handler, "large", 10, {
			displayModel: "claude-sonnet-5",
		});

		await expect(
			runEvaluator({
				runtime,
				context: CONTEXT,
				trajectory: makeTrajectory([makeStep(1, hugeResult)]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("preserves every result when the complete request fits", async () => {
		const steps = Array.from({ length: 3 }, (_, i) =>
			makeStep(i + 1, `${i}:${"y".repeat(40_000)}:${i}`),
		);
		const { runtime, captured } = makeRuntime();

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory(steps),
			effects: {},
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		const request = captured[0];
		if (!request) throw new Error("no captured request");
		const values = toolMessageValues(request);
		expect(values).toHaveLength(3);
		for (const [index, value] of values.entries()) {
			expect(value).toContain(`${index}:${"y".repeat(40_000)}:${index}`);
			expect(value).not.toMatch(/truncated|omitted/i);
		}
	});

	it("preserves the complete small turn through lossless tool JSON compaction", async () => {
		const steps = [makeStep(1, "a".repeat(1_000))];
		const { runtime, captured } = makeRuntime();

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory(steps),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		for (const message of request.messages) {
			expect(JSON.stringify(message.content)).not.toContain("chars truncated]");
		}
		// Tool JSON may lose indentation; original text and call identities may not.
		const control = trajectoryStepsToMessages(steps as never);
		const sentPairs = request.messages.filter(
			(message) => message.role === "assistant" || message.role === "tool",
		);
		expect(sentPairs).toHaveLength(control.length);
		expect(sentPairs.filter((message) => message.role === "assistant")).toEqual(
			JSON.parse(
				JSON.stringify(
					control.filter((message) => message.role === "assistant"),
				),
			),
		);
		expect(
			toolMessageValues(request).map((value) => JSON.parse(value)),
		).toEqual([{ success: true, text: "a".repeat(1_000) }]);
	});
});

describe("runEvaluator — bottom-out guard (stable segments alone over budget)", () => {
	it("fails at the final runtime boundary instead of calling the provider", async () => {
		// Overflow in the stable prefix makes the complete request impossible to
		// dispatch, so the evaluator must throw a typed error before useModel.
		const hugeStablePrompt = "characterization ".repeat(2_000_000);
		const handler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(ModelType.RESPONSE_HANDLER, handler, "small", 10, {
			displayModel: "llama3.1-8b",
		});

		await expect(
			runEvaluator({
				runtime,
				context: {
					...CONTEXT,
					staticPrefix: {
						characterPrompt: { content: hugeStablePrompt, stable: true },
					},
				},
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("records structured-parameter budget failure before making a provider call", async () => {
		const recorded: Array<{ stage: Record<string, unknown> }> = [];
		const handler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const runtimeWithRecorder = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimeWithRecorder.registerModel(
			ModelType.RESPONSE_HANDLER,
			handler,
			"small",
			10,
			{ displayModel: "llama3.1-8b" },
		);
		const oversizedParams = { payload: "p".repeat(200_000) };
		await expect(
			runEvaluator({
				runtime: runtimeWithRecorder,
				recorder: {
					recordStage: vi.fn(
						async (_id: string, stage: Record<string, unknown>) => {
							recorded.push({ stage });
						},
					),
				} as never,
				trajectoryId: "budget-params",
				context: CONTEXT,
				trajectory: makeTrajectory([
					{
						...makeStep(1, "ok"),
						toolCall: {
							id: "tool-1-0",
							name: "BIG_PARAMS",
							params: oversizedParams,
						},
					},
				]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.stage).toMatchObject({
			kind: "evaluation",
			evaluation: { protocolFailure: true },
		});
		expect(String(recorded[0]?.stage.model?.response)).toContain(
			"MODEL_INPUT_OVER_BUDGET",
		);
	});
});

describe("runEvaluator — provider-owned input rejection", () => {
	const OVERSIZED_STABLE_CONTEXT = {
		...CONTEXT,
		staticPrefix: {
			characterPrompt: {
				content: "characterization ".repeat(10_000),
				stable: true,
			},
		},
	};

	function registerRateLimitedPrimary(runtime: AgentRuntime) {
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
	}

	it("propagates a typed provider rejection without retrying the complete input elsewhere", async () => {
		const smallHandler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const finalRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		registerRateLimitedPrimary(runtime);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			50,
			{
				displayModel: "llama3.1-8b",
			},
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				finalRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup-large",
			10,
			{ displayModel: "claude-sonnet-5" },
		);

		await expect(
			runEvaluator({
				runtime,
				context: OVERSIZED_STABLE_CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });

		// A provider's authoritative hard-limit rejection is terminal. Retrying
		// the same complete input against a differently configured registration
		// would hide which provider boundary rejected it.
		expect(smallHandler).toHaveBeenCalledTimes(1);
		expect(finalRequests).toHaveLength(0);
	});

	it("records the terminal budget failure with the last rejected attempt's request", async () => {
		const recordedStages: Array<Record<string, unknown>> = [];
		const smallHandler = vi.fn(async () => {
			throw new ElizaError("provider input exceeds context", {
				code: "MODEL_INPUT_OVER_BUDGET",
			});
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		registerRateLimitedPrimary(runtime);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			10,
			{
				displayModel: "llama3.1-8b",
			},
		);

		await expect(
			runEvaluator({
				runtime,
				recorder: {
					recordStage: vi.fn(
						async (_id: string, stage: Record<string, unknown>) => {
							recordedStages.push(stage);
						},
					),
				} as never,
				trajectoryId: "terminal-budget",
				context: OVERSIZED_STABLE_CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });

		expect(smallHandler).toHaveBeenCalledTimes(1);
		expect(recordedStages).toHaveLength(1);
		const stage = recordedStages[0] as {
			kind: string;
			model: { provider?: string; response: string };
			evaluation: { protocolFailure?: boolean };
		};
		expect(stage.kind).toBe("evaluation");
		expect(stage.evaluation.protocolFailure).toBe(true);
		expect(stage.model.response).toContain("MODEL_INPUT_OVER_BUDGET");
		// The stage must attribute the failure to the registration that
		// rejected the input, not the preflight provider selection.
		expect(stage.model.provider).toBe("small");
	});
});

describe("runEvaluator — trajectory stage records the per-attempt prepared request", () => {
	it("persists the successful failover attempt's request, not the preflight snapshot", async () => {
		const backupRequests: CapturedRequest[] = [];
		const recordedStages: Array<Record<string, unknown>> = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await runEvaluator({
			runtime,
			recorder: {
				recordStage: vi.fn(
					async (_id: string, stage: Record<string, unknown>) => {
						recordedStages.push(stage);
					},
				),
			} as never,
			trajectoryId: "attempt-snapshot",
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, "x".repeat(1_000))]),
			effects: {},
		});

		expect(backupRequests).toHaveLength(1);
		expect(recordedStages).toHaveLength(1);
		const backupRequest = backupRequests[0] as CapturedRequest;
		const stage = recordedStages[0] as {
			model: {
				provider?: string;
				messages: unknown;
				providerOptions?: unknown;
			};
			cache: { segmentHashes: string[]; prefixHash: string };
		};
		// The recorded request must be byte-identical to what the selected
		// handler received, with no per-attempt prompt rewriting.
		expect(stage.model.messages).toEqual(backupRequest.messages);
		expect(stage.model.providerOptions).toEqual(backupRequest.providerOptions);
		expect(
			toolMessageValues(backupRequest).map((value) => JSON.parse(value)),
		).toEqual([{ success: true, text: "x".repeat(1_000) }]);
		expect(stage.model.provider).toBe("backup");
		// Cache metadata must describe the prepared attempt's segments too.
		const expectedHashes = computePrefixHashes(
			(backupRequest.promptSegments ?? []) as never,
		);
		expect(stage.cache.segmentHashes).toEqual(
			expectedHashes.map((entry) => entry.segmentHash),
		);
	});
});
