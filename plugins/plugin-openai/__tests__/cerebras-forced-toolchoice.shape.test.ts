/**
 * Regression shape test for forced `toolChoice` name sanitization in Cerebras
 * mode. Exercises the real `handleTextSmall` path against a mocked `ai` SDK
 * (`generateText`), no network, and asserts the outbound wire args keep the
 * forced tool name consistent with the registered tool-set key.
 *
 * The defect (#22663): native array tools are registered under a
 * Cerebras-sanitized key (`math.factorial` -> `math_factorial`), but a forced
 * `toolChoice.toolName` was left unsanitized, so the AI SDK/provider rejected
 * the call (NoSuchTool / 400) even though the tool was supplied. The invariant
 * proven here is `toolChoice.toolName ∈ Object.keys(tools)`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

// Handlers read env (Cerebras mode, model) lazily via `runtime.getSetting` /
// `process.env` at call time, so a static import is safe and lets the heavy
// module compile during collection instead of inside a test's timeout window.
import { handleTextSmall } from "../models/text";

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  RetryError: { isInstance: () => false },
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    object: () => ({ name: "object", responseFormat: Promise.resolve({ type: "json" }) }),
    json: () => ({ name: "json", responseFormat: Promise.resolve({ type: "json" }) }),
  },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    responses: (modelName: string) => ({ modelName }),
  }),
}));

const ENV_KEYS_TO_CLEAR = [
  "ELIZA_PROVIDER",
  "CEREBRAS_API_KEY",
  "OPENAI_SMALL_MODEL",
  "SMALL_MODEL",
] as const;

function createRuntime(): IAgentRuntime {
  const runtime = {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => undefined),
  };
  return runtime as unknown as IAgentRuntime;
}

interface CapturedCall {
  tools?: Record<string, unknown>;
  toolChoice?: { type?: string; toolName?: string };
}

function capturedCall(): CapturedCall {
  return aiMocks.generateText.mock.calls[0][0] as CapturedCall;
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_SMALL_MODEL", "gpt-oss-120b");
  for (const key of ENV_KEYS_TO_CLEAR) {
    vi.stubEnv(key, undefined);
  }
  aiMocks.generateText.mockResolvedValue({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Cerebras forced toolChoice name sanitization (#22663)", () => {
  it("sanitizes a dotted forced toolName to match the registered Cerebras tool key", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");

    await handleTextSmall(createRuntime(), {
      prompt: "compute",
      tools: [{ name: "math.factorial", parameters: { type: "object" } }],
      toolChoice: { type: "tool", name: "math.factorial" },
    } as never);

    const call = capturedCall();
    const toolKeys = Object.keys(call.tools ?? {});
    // The registered wire key is sanitized for Cerebras's grammar compiler.
    expect(toolKeys).toEqual(["math_factorial"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "math_factorial" });
    // The invariant that was violated: forced name must be a registered tool.
    expect(toolKeys).toContain(call.toolChoice?.toolName);
  });

  it("sanitizes a colon forced toolName (explicit toolName field) in Cerebras mode", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");

    await handleTextSmall(createRuntime(), {
      prompt: "invoke",
      tools: [{ name: "srv:tool", parameters: { type: "object" } }],
      toolChoice: { type: "tool", toolName: "srv:tool" },
    } as never);

    const call = capturedCall();
    const toolKeys = Object.keys(call.tools ?? {});
    expect(toolKeys).toEqual(["srv_tool"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "srv_tool" });
    expect(toolKeys).toContain(call.toolChoice?.toolName);
  });

  it("sanitizes a forced toolName supplied via the function.name shape in Cerebras mode", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");

    await handleTextSmall(createRuntime(), {
      prompt: "invoke",
      tools: [{ name: "a.b.c", parameters: { type: "object" } }],
      toolChoice: { type: "function", function: { name: "a.b.c" } },
    } as never);

    const call = capturedCall();
    const toolKeys = Object.keys(call.tools ?? {});
    expect(toolKeys).toEqual(["a_b_c"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "a_b_c" });
    expect(toolKeys).toContain(call.toolChoice?.toolName);
  });

  it("leaves a dotted forced toolName intact for non-Cerebras providers", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");

    await handleTextSmall(createRuntime(), {
      prompt: "compute",
      tools: [{ name: "math.factorial", parameters: { type: "object" } }],
      toolChoice: { type: "tool", name: "math.factorial" },
    } as never);

    const call = capturedCall();
    const toolKeys = Object.keys(call.tools ?? {});
    // Non-Cerebras: names pass through verbatim on both sides.
    expect(toolKeys).toEqual(["math.factorial"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "math.factorial" });
    expect(toolKeys).toContain(call.toolChoice?.toolName);
  });

  it("keeps a caller-keyed ToolSet and its forced choice verbatim in Cerebras mode", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");
    const toolChoice = { type: "tool", toolName: "math.factorial" } as const;

    await handleTextSmall(createRuntime(), {
      prompt: "compute",
      tools: {
        "math.factorial": {
          description: "caller-owned AI SDK tool",
          inputSchema: { type: "object", properties: {} },
        },
      },
      toolChoice,
    } as never);

    const call = capturedCall();
    expect(Object.keys(call.tools ?? {})).toEqual(["math.factorial"]);
    expect(call.toolChoice).toBe(toolChoice);
  });

  it("fails closed when two source names collapse to one Cerebras tool key", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");

    await expect(
      handleTextSmall(createRuntime(), {
        prompt: "compute",
        tools: [
          { name: "math.factorial", parameters: { type: "object" } },
          { name: "math:factorial", parameters: { type: "object" } },
        ],
        toolChoice: "required",
      } as never)
    ).rejects.toMatchObject({ code: "OPENAI_TOOL_NAME_COLLISION" });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("preserves __proto__ as an own tool key instead of mutating the registry", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");

    await handleTextSmall(createRuntime(), {
      prompt: "invoke",
      tools: [{ name: "__proto__", parameters: { type: "object" } }],
      toolChoice: { type: "tool", name: "__proto__" },
    } as never);

    const call = capturedCall();
    expect(Object.keys(call.tools ?? {})).toEqual(["__proto__"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "__proto__" });
  });
});
