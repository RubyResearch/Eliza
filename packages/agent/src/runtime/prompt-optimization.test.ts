/**
 * Behavioral coverage for the agent prompt-optimization layer. Drives the real
 * module: token estimates, trajectory-capture gating, message serialization,
 * usage-event aliases, lossless useModel wrapping, last-user active-view
 * injection, and prompt-budget overflow.
 */
import {
  AgentRuntime,
  EventType,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.ts";
import {
  type CapturedModelUsage,
  estimateTokenCount,
  installPromptOptimizations,
  serializeCompactorMessagesForModel,
  shouldPreserveFullPromptForTrajectoryCapture,
  withModelUsageCapture,
} from "./prompt-optimization.ts";
import {
  applyActiveViewAwareness,
  clearActiveViewContext,
  renderActiveViewContextBlock,
  setActiveViewContext,
} from "./view-action-affinity.ts";

const VIEW = {
  viewId: "chat",
  viewLabel: "Chat",
  viewType: "gui" as const,
  viewPath: "/chat",
};

afterEach(() => {
  clearActiveViewContext();
});

function createRuntime(): AgentRuntime {
  return new AgentRuntime({ logLevel: "fatal" });
}

type RecordedCall = {
  modelType: unknown;
  payload: unknown;
  rest: unknown[];
};

type LooseUseModel = (
  modelType: string,
  payload?: unknown,
  ...rest: unknown[]
) => Promise<unknown>;

function callModel(
  runtime: AgentRuntime,
  modelType: string,
  payload?: unknown,
  ...rest: unknown[]
): Promise<unknown> {
  return (runtime.useModel as unknown as LooseUseModel)(
    modelType,
    payload,
    ...rest,
  );
}

function payloadAt(calls: RecordedCall[], index: number): unknown {
  const call = calls[index];
  if (!call) {
    throw new Error(`expected recorded useModel call at ${index}`);
  }
  return call.payload;
}

function installRecordingRuntime(config?: ElizaConfig): {
  runtime: AgentRuntime;
  calls: RecordedCall[];
} {
  const runtime = createRuntime();
  const calls: RecordedCall[] = [];
  runtime.useModel = (async (...args: unknown[]) => {
    calls.push({
      modelType: args[0],
      payload: args[1],
      rest: args.slice(2),
    });
    return "model-result";
  }) as typeof runtime.useModel;
  installPromptOptimizations(runtime, config);
  return { runtime, calls };
}

function promptOptimizationOf(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const providerOptions = (payload as { providerOptions?: unknown })
    .providerOptions;
  if (!providerOptions || typeof providerOptions !== "object") return undefined;
  const eliza = (providerOptions as { eliza?: unknown }).eliza;
  if (!eliza || typeof eliza !== "object") return undefined;
  const telemetry = (eliza as { promptOptimization?: unknown })
    .promptOptimization;
  return telemetry && typeof telemetry === "object"
    ? (telemetry as Record<string, unknown>)
    : undefined;
}

describe("estimateTokenCount", () => {
  it("returns 0 for empty and falsy text", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("ceils character length divided by four, including a single character", () => {
    expect(estimateTokenCount("a")).toBe(1);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("a".repeat(8))).toBe(2);
  });
});

describe("shouldPreserveFullPromptForTrajectoryCapture", () => {
  it("is false with an empty trajectory queue and whitespace-only step ids", async () => {
    expect(shouldPreserveFullPromptForTrajectoryCapture()).toBe(false);
    expect(
      await runWithTrajectoryContext({ trajectoryStepId: "   " }, () =>
        shouldPreserveFullPromptForTrajectoryCapture(),
      ),
    ).toBe(false);
    expect(
      await runWithTrajectoryContext({}, () =>
        shouldPreserveFullPromptForTrajectoryCapture(),
      ),
    ).toBe(false);
  });

  it("is true for a single trimmed trajectory step id", async () => {
    expect(
      await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, () =>
        shouldPreserveFullPromptForTrajectoryCapture(),
      ),
    ).toBe(true);
    expect(
      await runWithTrajectoryContext({ trajectoryStepId: "  step-2  " }, () =>
        shouldPreserveFullPromptForTrajectoryCapture(),
      ),
    ).toBe(true);
  });
});

describe("serializeCompactorMessagesForModel", () => {
  it("serializes an empty queue and a single user message", () => {
    expect(serializeCompactorMessagesForModel([])).toEqual([]);
    expect(
      serializeCompactorMessagesForModel([{ role: "user", content: "hello" }]),
    ).toEqual([{ role: "user", content: "hello" }]);
  });

  it("emits assistant toolCalls and tool-role metadata; skips them on other roles", () => {
    expect(
      serializeCompactorMessagesForModel([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "search", arguments: { q: "eliza" } },
          ],
        },
        {
          role: "tool",
          content: "found",
          toolCallId: "call-1",
          toolName: "search",
        },
        {
          role: "user",
          content: "thanks",
          toolCalls: [{ id: "ignored", name: "x", arguments: {} }],
          toolCallId: "ignored",
          toolName: "x",
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "search", arguments: { q: "eliza" } },
        ],
      },
      {
        role: "tool",
        content: "found",
        toolCallId: "call-1",
        toolName: "search",
      },
      { role: "user", content: "thanks" },
    ]);
  });
});

describe("withModelUsageCapture", () => {
  it("returns null usage for an empty event queue", async () => {
    const runtime = createRuntime();
    const captured = await withModelUsageCapture(runtime, async () => "ok");
    expect(captured).toEqual({ result: "ok", usage: null });
  });

  it("infers completion from total minus prompt and keeps a zero per-call total in the sum", async () => {
    const runtime = createRuntime();
    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "openai",
        tokens: { prompt: 10, total: 15 },
      });
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        source: "anthropic",
        tokens: { prompt: 4, completion: 2, total: 0 },
      });
      return 1;
    });
    expect(captured.usage).toMatchObject({
      promptTokens: 14,
      completionTokens: 7,
      totalTokens: 15,
      provider: "anthropic",
      llmCalls: 2,
      isEstimated: false,
    } satisfies Partial<CapturedModelUsage>);
  });

  it("reads cache-write aliases, estimated flags, and last model/provider wins", async () => {
    const runtime = createRuntime();
    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "first",
        modelId: "model-a",
        tokens: {
          prompt: 1,
          completion: 1,
          total: 2,
          cacheWriteInputTokens: 3,
        },
      });
      await runtime.emitEvent([[EventType.MODEL_USED]] as never, {
        runtime,
        provider: "   ",
        source: "second",
        modelName: "model-b",
        tokens: {
          prompt: 2,
          completion: 2,
          total: 4,
          cacheWriteTokens: 5,
          estimated: true,
        },
      });
    });
    expect(captured.usage).toMatchObject({
      promptTokens: 3,
      completionTokens: 3,
      totalTokens: 6,
      cacheCreationInputTokens: 8,
      model: "model-b",
      provider: "second",
      isEstimated: true,
      llmCalls: 2,
    });
  });

  it("ignores non-usage events and payloads that are not usage records", async () => {
    const runtime = createRuntime();
    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.RUN_STARTED, {
        runtime,
        tokens: { prompt: 99, completion: 99, total: 198 },
      });
      await runtime.emitEvent(EventType.MODEL_USED, null);
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "no-tokens",
      });
    });
    expect(captured.usage).toBeNull();
  });
});

describe("installPromptOptimizations", () => {
  it("is idempotent: a second install does not wrap useModel twice", async () => {
    const { runtime, calls } = installRecordingRuntime();
    const wrapped = runtime.useModel;
    installPromptOptimizations(runtime);
    expect(runtime.useModel).toBe(wrapped);

    await callModel(runtime, ModelType.TEXT_EMBEDDING, { prompt: "once" });
    expect(calls).toHaveLength(1);
  });

  it("passes through a missing payload and a payload with no prompt surface", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.TEXT_EMBEDDING, undefined);
    await callModel(runtime, ModelType.TEXT_EMBEDDING, { temperature: 0.2 });
    expect(payloadAt(calls, 0)).toBeUndefined();
    expect(payloadAt(calls, 1)).toEqual({ temperature: 0.2 });
    expect(promptOptimizationOf(payloadAt(calls, 1))).toBeUndefined();
  });

  it("wraps prompt, userPrompt, and input keys with lossless telemetry", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.TEXT_EMBEDDING, { prompt: "p" });
    await callModel(runtime, ModelType.TEXT_EMBEDDING, { userPrompt: "u" });
    await callModel(runtime, ModelType.TEXT_EMBEDDING, { input: "i" });

    expect(calls).toHaveLength(3);
    expect((payloadAt(calls, 0) as { prompt: string }).prompt).toBe("p");
    expect((payloadAt(calls, 1) as { userPrompt: string }).userPrompt).toBe(
      "u",
    );
    expect((payloadAt(calls, 2) as { input: string }).input).toBe("i");

    for (const call of calls) {
      const telemetry = promptOptimizationOf(call.payload);
      expect(telemetry).toMatchObject({
        mode: "lossless",
        contextPreserved: true,
        transformations: [],
      });
      expect(telemetry?.budgetTokens).toBeUndefined();
    }
  });

  it("serializes an empty messages queue and a single user message", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.TEXT_EMBEDDING, { messages: [] });
    await callModel(runtime, ModelType.TEXT_EMBEDDING, {
      messages: [{ role: "user", content: "solo" }],
    });

    expect((payloadAt(calls, 0) as { messages: unknown[] }).messages).toEqual(
      [],
    );
    expect((payloadAt(calls, 1) as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "solo" },
    ]);
    expect(promptOptimizationOf(payloadAt(calls, 0))).toMatchObject({
      originalPromptChars: 0,
      finalPromptChars: 0,
    });
  });

  it("does not rewrite messages when any entry has an unknown role", async () => {
    const { runtime, calls } = installRecordingRuntime();
    const payload = {
      messages: [
        { role: "user", content: "ok" },
        { role: "narrator", content: "nope" },
      ],
    };
    await callModel(runtime, ModelType.TEXT_EMBEDDING, payload);
    expect(payloadAt(calls, 0)).toBe(payload);
    expect(promptOptimizationOf(payloadAt(calls, 0))).toBeUndefined();
  });

  it("preserves an explicit maxOutputTokens request without adding another cap", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.TEXT_LARGE, {
      prompt: "budget me",
      maxOutputTokens: 100,
    });
    const payload = payloadAt(calls, 0) as {
      maxOutputTokens: number;
      maxTokens?: number;
    };
    expect(payload.maxOutputTokens).toBe(100);
    expect(payload.maxTokens).toBeUndefined();
    expect(promptOptimizationOf(payload)).toMatchObject({
      outputReserveTokens: 100,
      budgetTokens: Math.floor((1_000_000 - 100) * 0.95),
    });
  });

  it("preserves an explicit maxTokens request so the provider can reject an impossible request", async () => {
    const { runtime, calls } = installRecordingRuntime({
      agents: { defaults: { contextTokens: 1_000 } },
    });
    await callModel(runtime, ModelType.TEXT_SMALL, {
      prompt: "tiny window",
      maxTokens: 50_000,
    });
    const payload = payloadAt(calls, 0) as {
      maxTokens: number;
      maxOutputTokens?: number;
    };
    expect(payload.maxTokens).toBe(50_000);
    expect(payload.maxOutputTokens).toBeUndefined();
    expect(promptOptimizationOf(payload)).toMatchObject({
      outputReserveTokens: 50_000,
      budgetTokens: 0,
    });
  });

  it("does not invent a model output cap when the caller omitted one", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.TEXT_LARGE, { prompt: "complete me" });
    const payload = payloadAt(calls, 0) as {
      maxTokens?: number;
      maxOutputTokens?: number;
    };
    expect(payload.maxTokens).toBeUndefined();
    expect(payload.maxOutputTokens).toBeUndefined();
    expect(promptOptimizationOf(payload)).toMatchObject({
      budgetTokens: 1_000_000 * 0.95,
    });
    expect(promptOptimizationOf(payload)?.outputReserveTokens).toBeUndefined();
  });

  it("does not turn model-capacity metadata into an outbound output cap", async () => {
    const { runtime, calls } = installRecordingRuntime({
      models: {
        providers: {
          test: {
            baseUrl: "https://provider.example/v1",
            models: [
              {
                id: "metadata-capped-model",
                name: "Metadata capped model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    });
    await callModel(runtime, ModelType.TEXT_LARGE, {
      prompt: "preserve the provider's complete output",
      model: "metadata-capped-model",
    });
    const payload = payloadAt(calls, 0) as {
      maxTokens?: number;
      maxOutputTokens?: number;
    };
    expect(payload.maxTokens).toBeUndefined();
    expect(payload.maxOutputTokens).toBeUndefined();
    expect(promptOptimizationOf(payload)?.outputReserveTokens).toBeUndefined();
  });

  it("appends fresh active-view awareness to the last user message", async () => {
    setActiveViewContext(VIEW);
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.ACTION_PLANNER, {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "latest" },
      ],
    });
    const messages = (
      payloadAt(calls, 0) as { messages: Array<{ content: string }> }
    ).messages;
    expect(messages[0]?.content).toBe("first");
    expect(messages[2]?.content).toBe(
      `latest\n\n${renderActiveViewContextBlock(VIEW)}`,
    );
    expect(promptOptimizationOf(payloadAt(calls, 0))?.transformations).toEqual([
      "active-view-awareness:chat",
    ]);
  });

  it("preserves the base prefix and native tool receipts as the current view changes", async () => {
    setActiveViewContext(VIEW);
    const { runtime, calls } = installRecordingRuntime();
    const baseText =
      "Complete provider context.\nRead the note, then open Calendar if green.";
    const feedbackText = "Read completed. Continue the pending request.";
    const base = [
      { role: "system", content: "Preserve standing constraints." },
      {
        role: "user",
        content: baseText,
      },
    ];
    const receipt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "NOTES_LIST",
            input: { content: "QA" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "NOTES_LIST",
            output: { type: "json", value: { body: "green", success: true } },
          },
        ],
      },
      {
        role: "user",
        content: feedbackText,
      },
    ];
    const originals = structuredClone({ base, receipt });
    await callModel(runtime, ModelType.ACTION_PLANNER, { messages: base });
    const calendar = {
      ...VIEW,
      viewId: "calendar",
      viewLabel: "Calendar",
      viewPath: "/calendar",
    };
    setActiveViewContext(calendar);
    await callModel(runtime, ModelType.ACTION_PLANNER, {
      messages: [...base, ...receipt],
    });
    const first = (
      payloadAt(calls, 0) as { messages: Array<{ content: string }> }
    ).messages;
    const second = (
      payloadAt(calls, 1) as { messages: Array<{ content: string }> }
    ).messages;
    expect(first[1]?.content.startsWith(baseText)).toBe(true);
    expect(second.slice(0, 2)).toEqual(base);
    expect(second.slice(2, 4)).toEqual(receipt.slice(0, 2));
    expect(second[4]?.content).toBe(
      `${feedbackText}\n\n${renderActiveViewContextBlock(calendar)}`,
    );
    expect({ base, receipt }).toEqual(originals);
  });

  it("keeps literal view headings, whitespace and multimodal envelopes intact", async () => {
    setActiveViewContext(VIEW);
    const { runtime, calls } = installRecordingRuntime();
    const literal =
      "  Quote exactly:\n# Active View\nThis is source text, not an injected snapshot.  ";
    const image = {
      type: "image",
      image: "https://example.com/fixture.png",
      providerOptions: { fixture: true },
    };
    const message = {
      role: "user",
      name: "owner",
      content: [image, { type: "text", text: literal }],
    };
    const original = structuredClone(message);
    await callModel(runtime, ModelType.ACTION_PLANNER, { messages: [message] });
    expect((payloadAt(calls, 0) as { messages: unknown[] }).messages).toEqual([
      {
        ...message,
        content: [
          image,
          {
            type: "text",
            text: `${literal}\n\n${renderActiveViewContextBlock(VIEW)}`,
          },
        ],
      },
    ]);
    expect(message).toEqual(original);
  });

  it("injects active-view awareness into a prompt that already lists available actions", async () => {
    setActiveViewContext(VIEW);
    const { runtime, calls } = installRecordingRuntime();
    const original = "plan this\n# Available Actions\n- wait";
    await callModel(runtime, ModelType.TEXT_LARGE, { prompt: original });
    const payload = payloadAt(calls, 0) as { prompt: string };
    expect(payload.prompt).toBe(applyActiveViewAwareness(original, VIEW));
    expect(payload.prompt).toContain("# Active View");
  });

  it("does not inject active-view awareness when no user message exists", async () => {
    setActiveViewContext(VIEW);
    const { runtime, calls } = installRecordingRuntime();
    await callModel(runtime, ModelType.ACTION_PLANNER, {
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "ready" },
      ],
    });
    expect(
      (payloadAt(calls, 0) as { messages: Array<{ content: string }> })
        .messages,
    ).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "ready" },
    ]);
    expect(promptOptimizationOf(payloadAt(calls, 0))?.transformations).toEqual(
      [],
    );
  });

  it("preserves existing providerOptions.eliza fields and extra useModel arguments", async () => {
    const { runtime, calls } = installRecordingRuntime();
    await callModel(
      runtime,
      ModelType.TEXT_EMBEDDING,
      {
        prompt: "keep",
        providerOptions: { eliza: { preexisting: true }, other: 1 },
      },
      "provider-hint",
    );
    const payload = payloadAt(calls, 0) as {
      providerOptions: { eliza: Record<string, unknown>; other: number };
    };
    expect(payload.providerOptions.other).toBe(1);
    expect(payload.providerOptions.eliza.preexisting).toBe(true);
    expect(payload.providerOptions.eliza.promptOptimization).toMatchObject({
      mode: "lossless",
    });
    expect(calls[0]?.rest).toEqual(["provider-hint"]);
  });

  it("projects array content, merges duplicate tool-call ids, and keeps source envelopes", async () => {
    const { runtime, calls } = installRecordingRuntime();
    const original = {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        {
          type: "tool-call",
          toolCallId: "dup",
          toolName: "search",
          input: { q: "one" },
        },
      ],
      tool_calls: [
        {
          id: "dup",
          function: { name: "search", arguments: '{"q":"two"}' },
        },
        { id: "second", name: "lookup", arguments: "not-json" },
      ],
    };
    await callModel(runtime, ModelType.TEXT_EMBEDDING, {
      messages: [original],
    });
    const serialized = (payloadAt(calls, 0) as { messages: unknown[] })
      .messages[0] as {
      role: string;
      content: unknown;
      tool_calls?: unknown;
      toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
    };
    expect(serialized.role).toBe("assistant");
    expect(serialized.content).toEqual(original.content);
    expect(serialized.tool_calls).toEqual(original.tool_calls);
  });

  it("records a fallback trajectory LLM call when the live logger never fires", async () => {
    const { runtime, calls } = installRecordingRuntime();
    const logged: unknown[] = [];
    const logger = {
      logLlmCall: (entry: unknown) => {
        logged.push(entry);
      },
    };
    runtime.getServicesByType = (() => [
      logger,
    ]) as unknown as typeof runtime.getServicesByType;
    runtime.getService = ((type: string) =>
      type === "trajectories" ? logger : null) as typeof runtime.getService;

    const result = await runWithTrajectoryContext(
      { trajectoryStepId: "step-fallback" },
      () =>
        callModel(runtime, ModelType.TEXT_EMBEDDING, {
          prompt: "capture me",
          system: "sys",
        }),
    );

    expect(result).toBe("model-result");
    expect(calls).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      stepId: "step-fallback",
      systemPrompt: "sys",
      userPrompt: "capture me",
      response: "model-result",
      actionType: "runtime.useModel",
      tokenUsageEstimated: true,
    });
  });

  it("enriches the latest LLM call when the logger already recorded one", async () => {
    const runtime = createRuntime();
    const updates: Array<{ stepId: string; patch: Record<string, unknown> }> =
      [];
    const logger = {
      logLlmCall: (entry: { stepId?: string }) => entry,
      updateLatestLlmCall: async (
        stepId: string,
        patch: Record<string, unknown>,
      ) => {
        updates.push({ stepId, patch });
      },
    };
    runtime.getServicesByType = (() =>
      logger) as unknown as typeof runtime.getServicesByType;
    runtime.getService = (() => logger) as typeof runtime.getService;
    runtime.useModel = (async () => {
      logger.logLlmCall({ stepId: "step-live" });
      return { text: "structured" };
    }) as typeof runtime.useModel;
    installPromptOptimizations(runtime);

    await runWithTrajectoryContext({ trajectoryStepId: "step-live" }, () =>
      callModel(runtime, ModelType.TEXT_EMBEDDING, {
        prompt: "already logged",
      }),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      stepId: "step-live",
      patch: {
        userPrompt: "already logged",
        response: JSON.stringify({ text: "structured" }),
      },
    });
    // A configuration/provider guess must not replace the model already
    // recorded by the provider, particularly while streaming usage is pending.
    expect(updates[0].patch.model).toBeUndefined();
  });

  it("uses the measured model rather than a provider hint for missing captures", async () => {
    const runtime = createRuntime();
    const logged: Array<Record<string, unknown>> = [];
    const logger = {
      logLlmCall: (entry: Record<string, unknown>) => logged.push(entry),
    };
    runtime.getServicesByType = (() => [
      logger,
    ]) as unknown as typeof runtime.getServicesByType;
    runtime.getService = (() => logger) as typeof runtime.getService;
    runtime.useModel = (async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "cerebras",
        modelName: "qwen-3.8-27b",
        tokens: { prompt: 10, completion: 2, total: 12 },
      });
      return "measured reply";
    }) as typeof runtime.useModel;
    installPromptOptimizations(runtime);
    await runWithTrajectoryContext({ trajectoryStepId: "step-measured" }, () =>
      callModel(
        runtime,
        ModelType.TEXT_EMBEDDING,
        { prompt: "capture" },
        "openai",
      ),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      model: "qwen-3.8-27b",
      promptTokens: 10,
    });
  });

  it("swallows a throwing fallback logger and still returns the model result", async () => {
    const { runtime } = installRecordingRuntime();
    const logger = {
      logLlmCall: () => {
        throw new Error("logger down");
      },
    };
    runtime.getServicesByType = (() => [
      logger,
    ]) as unknown as typeof runtime.getServicesByType;

    await expect(
      runWithTrajectoryContext({ trajectoryStepId: "step-throw" }, () =>
        callModel(runtime, ModelType.TEXT_EMBEDDING, { prompt: "still works" }),
      ),
    ).resolves.toBe("model-result");
  });

  it("stringifies a null model result as an empty trajectory response", async () => {
    const runtime = createRuntime();
    const logged: unknown[] = [];
    runtime.useModel = (async () => null) as typeof runtime.useModel;
    installPromptOptimizations(runtime);
    const logger = {
      logLlmCall: (entry: unknown) => {
        logged.push(entry);
      },
    };
    runtime.getServicesByType = (() => [
      logger,
    ]) as unknown as typeof runtime.getServicesByType;

    await runWithTrajectoryContext({ trajectoryStepId: "step-null" }, () =>
      callModel(runtime, ModelType.TEXT_EMBEDDING, { prompt: "n" }),
    );
    expect(logged[0]).toMatchObject({ response: "" });
  });
});
