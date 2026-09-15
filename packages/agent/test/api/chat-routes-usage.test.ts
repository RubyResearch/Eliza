/** Exercises chat usage accounting routes with deterministic runtime and billing fixtures. */
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  EventType,
  getInferenceTimer,
  ModelType,
  RoomHandlerQueue,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  detectLocalInferenceCommandIntent,
  generateChatResponse,
} from "../../src/api/chat-routes.js";
import { estimateTokenCount } from "../../src/runtime/prompt-optimization.js";

type RuntimeOverrides = Partial<AgentRuntime> & {
  messageService?: NonNullable<AgentRuntime["messageService"]>;
};

function createRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const runtime = {
    agentId: stringToUuid("chat-agent"),
    character: {
      name: "Chat Agent",
      system: "System prompt",
      settings: {
        model: "test/chat-model",
      },
    },
    actions: [],
    plugins: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    drainChatPreHandlers: vi.fn(async () => null),
    // generateChatResponse acquires per-room ownership through the runtime's
    // real RoomHandlerQueue; a mock without one fails every turn.
    roomHandlerQueue: new RoomHandlerQueue(),
    ...overrides,
  } satisfies Partial<AgentRuntime>;

  return runtime as AgentRuntime;
}

function createChatMessage(text: string) {
  return createMessageMemory({
    id: stringToUuid(`message-${text}`),
    // Per-message room: generateChatResponse serializes turns per room via
    // the RoomHandlerQueue, so the concurrent-isolation test's two in-flight
    // turns must live in distinct rooms or they deadlock on each other's
    // start gate. Usage attribution is keyed per request, not per room, so
    // the isolation contract is unchanged.
    roomId: stringToUuid(`room-${text}`),
    entityId: stringToUuid("user"),
    content: {
      text,
      channelType: ChannelType.DM,
    },
  });
}

function actionResult(actionName: string, success = true, text?: string) {
  return {
    success,
    ...(text ? { text } : {}),
    data: { actionName },
  };
}

describe("generateChatResponse usage reporting", () => {
  it("shares each request trace with ingress consumers before generation", async () => {
    const ingress: Array<{
      text: string;
      traceId: unknown;
      timerTraceId: string | undefined;
    }> = [];
    const runtime = createRuntime({
      emitEvent: async (event, payload) => {
        if (event !== EventType.MESSAGE_RECEIVED) return;
        const { message } = payload as {
          message: ReturnType<typeof createChatMessage>;
        };
        ingress.push({
          text: message.content.text ?? "",
          traceId: message.metadata?.traceId,
          timerTraceId: getInferenceTimer()?.traceId,
        });
      },
      messageService: {
        handleMessage: async () => ({
          didRespond: true,
          responseContent: { text: "Reply" },
          responseMessages: [],
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });
    await Promise.all([
      generateChatResponse(
        runtime,
        createChatMessage("explicit trace"),
        "Chat Agent",
        {
          traceId: "0123456789abcdef0123456789abcdef",
        },
      ),
      generateChatResponse(
        runtime,
        createChatMessage("generated trace"),
        "Chat Agent",
      ),
    ]);
    expect(ingress).toHaveLength(2);
    for (const receipt of ingress) {
      expect(receipt.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(receipt.traceId).toBe(receipt.timerTraceId);
    }
    expect(
      ingress.find((receipt) => receipt.text === "explicit trace")?.traceId,
    ).toBe("0123456789abcdef0123456789abcdef");
    expect(ingress[0].traceId).not.toBe(ingress[1].traceId);
  });

  it("retains an originating trace and metadata when forwarding a message", async () => {
    const message = createChatMessage("forwarded trace");
    message.metadata = { type: "message", source: "forwarded" };
    Object.assign(message.metadata, { traceId: "originating-turn" });
    const runtime = createRuntime({
      emitEvent: async (event, payload) => {
        if (event !== EventType.MESSAGE_RECEIVED) return;
        expect(
          (payload as { message: typeof message }).message.metadata,
        ).toEqual({
          type: "message",
          source: "forwarded",
          traceId: "originating-turn",
        });
      },
      messageService: {
        handleMessage: async () => ({
          didRespond: true,
          responseContent: { text: "Reply" },
          responseMessages: [],
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });
    await generateChatResponse(runtime, message, "Chat Agent");
    expect(message.metadata).toMatchObject({
      traceId: "originating-turn",
      source: "forwarded",
    });
  });

  it("returns actual provider usage when a provider event is emitted", async () => {
    let runtime: AgentRuntime;
    runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => {
          await runtime.emitEvent(EventType.MODEL_USED, {
            runtime,
            source: "test-provider",
            provider: "test-provider",
            type: ModelType.TEXT_LARGE,
            tokens: {
              prompt: 42,
              completion: 11,
              total: 53,
              cached: 32,
            },
          });
          return {
            didRespond: true,
            responseContent: { text: "provider reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
    );

    expect(result.usage).toMatchObject({
      promptTokens: 42,
      completionTokens: 11,
      totalTokens: 53,
      cacheReadInputTokens: 32,
      cachedInputTokens: 32,
      provider: "test-provider",
      isEstimated: false,
      llmCalls: 1,
    });
  });

  it("isolates provider usage across concurrent requests on one runtime", async () => {
    let runtime: AgentRuntime;
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, message) => {
          started += 1;
          if (started === 2) releaseBoth();
          await bothStarted;
          const isFirst = message.content.text === "first";
          await runtime.emitEvent(EventType.MODEL_USED, {
            runtime,
            source: isFirst ? "provider-a" : "provider-b",
            provider: isFirst ? "provider-a" : "provider-b",
            type: ModelType.TEXT_LARGE,
            tokens: {
              prompt: isFirst ? 101 : 202,
              completion: isFirst ? 11 : 22,
              total: isFirst ? 112 : 224,
            },
          });
          return {
            didRespond: true,
            responseContent: { text: isFirst ? "one" : "two" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const [first, second] = await Promise.all([
      generateChatResponse(runtime, createChatMessage("first"), "Chat Agent"),
      generateChatResponse(runtime, createChatMessage("second"), "Chat Agent"),
    ]);

    expect(first.usage).toMatchObject({
      promptTokens: 101,
      completionTokens: 11,
      totalTokens: 112,
      provider: "provider-a",
      llmCalls: 1,
    });
    expect(second.usage).toMatchObject({
      promptTokens: 202,
      completionTokens: 22,
      totalTokens: 224,
      provider: "provider-b",
      llmCalls: 1,
    });
  });

  it("marks route token counts as estimates when no provider event is emitted", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: { text: "estimated reply" },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });
    const message = createChatMessage("count this prompt");

    const result = await generateChatResponse(runtime, message, "Chat Agent");

    expect(result.usage).toMatchObject({
      promptTokens: estimateTokenCount("count this prompt"),
      completionTokens: estimateTokenCount("estimated reply"),
      isEstimated: true,
      llmCalls: 0,
    });
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("does not attribute generic simple delivery callbacks from content actions", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ text: "callback reply", actions: ["REPLY"] });
          return {
            didRespond: true,
            responseContent: { actions: ["REPLY"], text: "callback reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
    );

    expect(result).toMatchObject({
      text: "callback reply",
    });
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("delivers a callback-only reply to append-only streaming consumers", async () => {
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ text: "callback reply", actions: ["REPLY"] });
          return {
            didRespond: true,
            responseContent: { actions: ["REPLY"], text: "callback reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe("callback reply");
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("callback reply");
  });

  it("does not duplicate callback replies across snapshot and chunk transports", async () => {
    const onChunk = vi.fn();
    const onSnapshot = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ text: "callback reply", actions: ["REPLY"] });
          return {
            didRespond: true,
            responseContent: { actions: ["REPLY"], text: "callback reply" },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { onChunk, onSnapshot },
    );

    expect(result.text).toBe("callback reply");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith("callback reply", "model");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("holds progress snapshots until an append-only stream has a final reply", async () => {
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            {
              text: "Searching...",
              actions: ["SEARCH"],
              actionStatus: "in_progress",
            },
            "SEARCH",
          );
          return {
            didRespond: true,
            responseContent: { text: "Search complete." },
            responseMessages: [],
            actionResults: [actionResult("SEARCH")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("search"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe("Search complete.");
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Search complete.");
  });

  it("fails append-only finalization when emitted callback bytes diverge", async () => {
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({
            text: "provisional streamed reply",
            actions: ["REPLY"],
            merge: "append",
          });
          await callback?.({
            text: "authoritative final reply",
            actions: ["REPLY"],
          });
          return {
            didRespond: true,
            responseContent: {
              actions: ["REPLY"],
              text: "authoritative final reply",
            },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    await expect(
      generateChatResponse(runtime, createChatMessage("hello"), "Chat Agent", {
        onChunk,
      }),
    ).rejects.toMatchObject({
      code: "CHAT_APPEND_ONLY_STREAM_DIVERGENCE",
    });
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("provisional streamed reply", "model");
  });

  it("preserves divergent callback replacement for snapshot-capable consumers", async () => {
    const onChunk = vi.fn();
    const onSnapshot = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({
            text: "provisional streamed reply",
            actions: ["REPLY"],
            merge: "append",
          });
          await callback?.({
            text: "authoritative final reply",
            actions: ["REPLY"],
          });
          return {
            didRespond: true,
            responseContent: {
              actions: ["REPLY"],
              text: "authoritative final reply",
            },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
      { onChunk, onSnapshot },
    );

    expect(result.text).toBe("authoritative final reply");
    expect(onChunk).toHaveBeenCalledWith("provisional streamed reply", "model");
    expect(onSnapshot).toHaveBeenLastCalledWith(
      "authoritative final reply",
      "model",
    );
  });

  it("records an attributed visible callback only when its action succeeded", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            { text: "callback reply", actions: ["SENSITIVE_ACTION"] },
            "SENSITIVE_ACTION",
          );
          return {
            didRespond: true,
            mode: "actions",
            responseContent: {
              text: "callback reply",
              actions: ["SENSITIVE_ACTION"],
            },
            responseMessages: [],
            actionResults: [actionResult("SENSITIVE_ACTION")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
    );

    expect(result).toMatchObject({
      text: "callback reply",
      usedActionCallbacks: true,
      actionCallbackHistory: ["callback reply"],
    });
  });

  it("does not count an attributed textless callback as delivered execution evidence", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ actions: ["SEARCHING"] }, "SEARCHING");
          return {
            didRespond: true,
            responseContent: { text: "final reply" },
            responseMessages: [],
            actionResults: [actionResult("SEARCHING")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
    );

    expect(result.text).toBe("final reply");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("keeps early, terminal, attachment, and voice deliveries generic", async () => {
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({ text: "early reply", actions: ["REPLY"] });
          await callback?.({ actions: ["IGNORE"] });
          await callback?.({ attachments: [] });
          await callback?.({ text: "", attachments: [], source: "voice" });
          await callback?.({ text: "final reply", actions: ["REPLY"] });
          return {
            didRespond: true,
            responseContent: { text: "final reply", actions: ["REPLY"] },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("hello"),
      "Chat Agent",
    );

    expect(result.text).toBe("final reply");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("does not treat a losing attributed callback as delivered action evidence", async () => {
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback, options) => {
          await options?.onStreamChunk?.(
            "streamed final",
            undefined,
            "streamed final",
          );
          await callback?.(
            { text: "losing callback", actions: ["SEARCH"] },
            "SEARCH",
          );
          return {
            didRespond: true,
            responseContent: { text: "streamed final" },
            responseMessages: [],
            actionResults: [actionResult("SEARCH")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("search"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe("streamed final");
    expect(onChunk).toHaveBeenCalledWith("streamed final", "model");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("replaces progress delivery with the final result without action evidence", async () => {
    const onSnapshot = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            {
              text: "Searching...",
              actions: ["SEARCH"],
              actionStatus: "in_progress",
            },
            "SEARCH",
          );
          return {
            didRespond: true,
            responseContent: { text: "Search complete." },
            responseMessages: [],
            actionResults: [actionResult("SEARCH")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("search"),
      "Chat Agent",
      { onSnapshot },
    );

    expect(result.text).toBe("Search complete.");
    expect(onSnapshot).toHaveBeenLastCalledWith("Search complete.", "model");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it.each([
    ["a failed action result", actionResult("SENSITIVE_ACTION", false)],
    ["an unrelated successful result", actionResult("OTHER_ACTION")],
  ])(
    "drops callback history when an attributed callback is followed by %s",
    async (_label, executionResult) => {
      const runtime = createRuntime({
        messageService: {
          handleMessage: vi.fn(async (_runtime, _message, callback) => {
            await callback?.(
              { text: "claimed success", actions: ["SENSITIVE_ACTION"] },
              "SENSITIVE_ACTION",
            );
            return {
              didRespond: true,
              responseContent: { text: "claimed success" },
              responseMessages: [],
              actionResults: [executionResult],
            };
          }),
        } as NonNullable<AgentRuntime["messageService"]>,
      });

      const result = await generateChatResponse(
        runtime,
        createChatMessage("run it"),
        "Chat Agent",
      );

      expect(result.usedActionCallbacks).toBeUndefined();
      expect(result.actionCallbackHistory).toBeUndefined();
    },
  );

  it("keeps an exact internal action inventory out of chat while retaining diagnostics", async () => {
    const inventory = "available_views:\nviews[1]{id,label}: notes,Notes";
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.({
            text: inventory,
            transcriptVisibility: "internal",
          });
          return {
            didRespond: true,
            responseContent: {
              text: inventory,
              transcriptVisibility: "internal",
            },
            responseMessages: [],
            actionResults: [
              {
                success: true,
                text: inventory,
                transcriptVisibility: "internal",
                data: { views: [{ id: "notes" }] },
              },
            ],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("what apps are available?"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe(inventory);
    expect(result.transcriptVisibility).toBe("internal");
    expect(result.responseContent).toMatchObject({
      text: inventory,
      transcriptVisibility: "internal",
    });
    expect(onChunk).not.toHaveBeenCalled();
    expect(result.usedActionCallbacks).toBeUndefined();
  });

  it("does not hide a distinct assistant summary after an internal inventory", async () => {
    const inventory = "available_views:\nviews[1]{id,label}: notes,Notes";
    const summary = "Notes is available. I can open it for you.";
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: { text: summary },
          responseMessages: [],
          actionResults: [
            {
              success: true,
              text: inventory,
              transcriptVisibility: "internal",
              data: { views: [{ id: "notes" }] },
            },
          ],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("what apps are available?"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe(summary);
    expect(result.transcriptVisibility).toBeUndefined();
    expect(onChunk).toHaveBeenCalledWith(summary, "model");
  });

  it("honors an internal response-content tag when action diagnostics are absent", async () => {
    const inventory = "available_views:\nviews[1]{id,label}: notes,Notes";
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: inventory,
            transcriptVisibility: "internal",
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("what apps are available?"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.transcriptVisibility).toBe("internal");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("keeps sub-planner user-facing inventory internal when diagnostics differ", async () => {
    const inventory = "available_views:\nviews[1]{id,label}: notes,Notes";
    const onChunk = vi.fn();
    const runtime = createRuntime({
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: inventory,
            transcriptVisibility: "internal",
          },
          responseMessages: [],
          actionResults: [
            {
              success: true,
              text: `OK VIEWS: ${inventory}`,
              transcriptVisibility: "internal",
              data: {
                subSteps: [
                  {
                    action: "VIEWS",
                    success: true,
                    summary: inventory,
                  },
                ],
              },
            },
          ],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("what apps are available?"),
      "Chat Agent",
      { onChunk },
    );

    expect(result.text).toBe(inventory);
    expect(result.transcriptVisibility).toBe("internal");
    expect(result.responseContent).toMatchObject({
      text: inventory,
      transcriptVisibility: "internal",
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("fails closed when a model returns an unexecuted action payload", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Done, I sent the funds.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.text).toContain("SENSITIVE_ACTION");
    expect(result.text).not.toContain("sent the funds");
    expect(runtime.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "eliza-api",
        parsedActions: ["SENSITIVE_ACTION"],
      }),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("fails closed when only unrelated action callbacks fired", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            { text: "Searching...", actions: ["SEARCHING"] },
            "SEARCHING",
          );
          return {
            didRespond: true,
            responseContent: {
              text: "Done, I sent the funds.",
              actions: ["SENSITIVE_ACTION"],
            },
            responseMessages: [],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.text).toContain("SENSITIVE_ACTION");
    expect(result.text).not.toContain("sent the funds");
  });

  it("fails closed when a matching attributed callback is followed by failure", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            {
              text: "Attempting the sensitive action.",
              actions: ["SENSITIVE_ACTION"],
            },
            "SENSITIVE_ACTION",
          );
          return {
            didRespond: true,
            mode: "actions",
            responseContent: {
              text: "Done, I sent the funds.",
              actions: ["SENSITIVE_ACTION"],
            },
            responseMessages: [],
            actionResults: [actionResult("SENSITIVE_ACTION", false)],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.text).toContain("SENSITIVE_ACTION");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("does not fail closed when actions mode has a matching successful result", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          mode: "actions",
          responseContent: {
            text: "Action completed by core.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
          actionResults: [actionResult("SENSITIVE_ACTION")],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
    );

    expect(result.text).toBe("Action completed by core.");
    expect(result.usedActionCallbacks).toBe(true);
    expect(result.actionCallbackHistory).toBeUndefined();
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it.each([
    ["no result", []],
    ["a failed result", [actionResult("SENSITIVE_ACTION", false)]],
    ["an unrelated result", [actionResult("OTHER_ACTION")]],
  ])("fails closed when actions mode has %s", async (_label, actionResults) => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          mode: "actions",
          responseContent: {
            text: "Action completed by core.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
          actionResults,
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("send funds"),
      "Chat Agent",
    );

    expect(result.text).toContain("actions that were not executed");
    expect(result.usedActionCallbacks).toBeUndefined();
    expect(result.actionCallbackHistory).toBeUndefined();
  });

  it("reports mixed callback and core action execution once", async () => {
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback?.(
            {
              text: "Mixed action reply",
              actions: ["SENSITIVE_ACTION"],
            },
            "SENSITIVE_ACTION",
          );
          return {
            didRespond: true,
            mode: "actions",
            responseContent: {
              text: "Mixed action reply",
              actions: ["SENSITIVE_ACTION"],
            },
            responseMessages: [],
            actionResults: [actionResult("SENSITIVE_ACTION")],
          };
        }),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(
      runtime,
      createChatMessage("run the mixed action"),
      "Chat Agent",
    );

    expect(result.usedActionCallbacks).toBe(true);
    expect(result.actionCallbackHistory).toEqual(["Mixed action reply"]);
  });

  it("does not fail closed when action result records an alias for the runtime action", async () => {
    const message = createChatMessage("send funds");
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION", similes: ["TRANSFER_FUNDS"] }],
      getActionResults: vi.fn(() => [
        { success: true, actionName: "TRANSFER_FUNDS" },
      ]),
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Action completed from recorded alias.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(runtime, message, "Chat Agent");

    expect(result.text).toBe("Action completed from recorded alias.");
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("does not fail closed when runtime action results show execution", async () => {
    const message = createChatMessage("send funds");
    const runtime = createRuntime({
      actions: [{ name: "SENSITIVE_ACTION" }],
      getActionResults: vi.fn(() => [
        { success: true, actionName: "SENSITIVE_ACTION" },
      ]),
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          responseContent: {
            text: "Action completed from recorded result.",
            actions: ["SENSITIVE_ACTION"],
          },
          responseMessages: [],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });

    const result = await generateChatResponse(runtime, message, "Chat Agent");

    expect(result.text).toBe("Action completed from recorded result.");
    expect(runtime.getActionResults).toHaveBeenCalledWith(message.id);
    expect(runtime.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[eliza-api] Unexecuted action payload detected; failing closed",
    );
  });

  it("preserves message-service reply, action records, persistence IDs, and usage", async () => {
    const persistedId = stringToUuid("wallet-balance-response");
    const runtime = createRuntime({
      actions: [{ name: "CHECK_BALANCE" }],
      messageService: {
        handleMessage: vi.fn(async () => ({
          didRespond: true,
          mode: "actions",
          responseContent: {
            text: "Your wallet balance is 4 SOL.",
            actions: ["CHECK_BALANCE"],
          },
          responseMessages: [],
          persistedResponseMessageIds: [persistedId],
          actionResults: [
            actionResult("CHECK_BALANCE", true, "Balance loaded."),
          ],
        })),
      } as NonNullable<AgentRuntime["messageService"]>,
    });
    const message = createChatMessage("check my wallet balance");

    const result = await generateChatResponse(runtime, message, "Chat Agent");

    expect(result.text).toBe("Your wallet balance is 4 SOL.");
    expect(result.persistedResponseMessageIds).toEqual([persistedId]);
    expect(result.actionResults).toEqual([
      expect.objectContaining({
        actionName: "CHECK_BALANCE",
        success: true,
        text: "Balance loaded.",
      }),
    ]);
    expect(result.usage).toMatchObject({
      promptTokens: estimateTokenCount("check my wallet balance"),
      completionTokens: estimateTokenCount("Your wallet balance is 4 SOL."),
      isEstimated: true,
      llmCalls: 0,
    });
  });
});

describe("local inference chat command intent detection", () => {
  it("detects flexible local model management phrasing", () => {
    expect(
      detectLocalInferenceCommandIntent("can you re-download the llama model?"),
    ).toBe("redownload");
    expect(
      detectLocalInferenceCommandIntent("switch to something smaller locally"),
    ).toBe("switch_smaller");
    expect(detectLocalInferenceCommandIntent("use cloud")).toBe("use_cloud");
    expect(
      detectLocalInferenceCommandIntent("how far is the model download?"),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent("local inference status please"),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent(
        "what model are you running locally right now?",
      ),
    ).toBe("status");
  });

  it("does not hijack ordinary chat without local inference context", () => {
    expect(detectLocalInferenceCommandIntent("download the report")).toBeNull();
    expect(detectLocalInferenceCommandIntent("retry that joke")).toBeNull();
    expect(
      detectLocalInferenceCommandIntent("what is your status?"),
    ).toBeNull();
  });

  it("allows short commands when the UI marks local inference context", () => {
    expect(
      detectLocalInferenceCommandIntent("status", {
        localInferenceContext: true,
      }),
    ).toBe("status");
    expect(
      detectLocalInferenceCommandIntent("download it", {
        localInferenceContext: true,
      }),
    ).toBe("download");
  });
});
