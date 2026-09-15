/**
 * Exercises configured Cerebras-to-OpenRouter recovery through real text
 * handlers, AI SDK serialization and loopback HTTP. These fixtures prove
 * transport invariants; live provider/model quality is a separate gate.
 */
import { createServer, type Server } from "node:http";
import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";
import type { TextStreamResult } from "../types";

let server: Server;
let baseURL: string;
let requests: { path: string; auth?: string; body: Record<string, unknown> }[];
let primaryStatus: number;
let fallbackStatus: number;
let partialStream: boolean;
let retryAfter: string | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    let input = "";
    request.on("data", (chunk) => {
      input += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(input) as Record<string, unknown>;
      const primary = request.url?.startsWith("/primary/");
      requests.push({ path: request.url ?? "", auth: request.headers.authorization, body });
      const status = primary ? primaryStatus : fallbackStatus;
      if (primary && partialStream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "Already visible" }, finish_reason: null }] })}\n\n`
        );
        response.end(
          `data: ${JSON.stringify({ error: { message: "Rate limited after output", type: "rate_limit", code: "429" } })}\n\ndata: [DONE]\n\n`
        );
        return;
      }
      if (status !== 200) {
        response.writeHead(status, {
          "content-type": "application/json",
          ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
        });
        response.end(
          JSON.stringify({
            error: {
              message: status === 429 ? "Tokens per minute limit exceeded" : "Invalid request",
            },
          })
        );
        return;
      }
      const toolCall = {
        id: "tool-home",
        type: "function",
        function: {
          name: "VIEWS",
          arguments: JSON.stringify({ operation: "show", viewId: "chat" }),
        },
      };
      const tool = body.tools !== undefined;
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = tool
          ? { tool_calls: [{ index: 0, ...toolCall }] }
          : { content: "Back home." };
        for (const choice of [
          { index: 0, delta, finish_reason: null },
          { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
        ])
          response.write(
            `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", created: 1, model: body.model, choices: [choice] })}\n\n`
          );
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "completion",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: tool ? null : "Back home.",
                  ...(tool ? { tool_calls: [toolCall] } : {}),
                },
                finish_reason: tool ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  baseURL = `http://127.0.0.1:${address.port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
);
beforeEach(() => {
  requests = [];
  primaryStatus = 429;
  fallbackStatus = 200;
  partialStream = false;
  retryAfter = "60";
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", "0");
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
  vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtime(overrides: Record<string, string> = {}) {
  const settings: Record<string, string> = {
    ELIZA_PROVIDER: "cerebras",
    OPENAI_BASE_URL: `${baseURL}/primary/v1`,
    CEREBRAS_API_KEY: "primary-fixture-key",
    CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
    OPENROUTER_FALLBACK_MODEL: "qwen/qwen3.8-27b",
    OPENROUTER_BASE_URL: `${baseURL}/fallback/v1`,
    OPENROUTER_API_KEY: "fallback-fixture-key",
    ...overrides,
  };
  const events: unknown[] = [];
  return {
    runtime: {
      getSetting: (key: string) => settings[key],
      character: { name: "Fixture", system: "Preserve the user's constraints." },
      emitEvent: async (_name: string, event: unknown) => {
        events.push(event);
      },
      getService: () => null,
      getServicesByType: () => [],
    } as unknown as IAgentRuntime,
    events,
  };
}

const params: GenerateTextParams = {
  messages: [{ role: "user", content: "Go home. Do not modify notes or events." }],
  tools: [
    {
      name: "VIEWS",
      description: "Open a view",
      parameters: {
        type: "object",
        properties: { operation: { type: "string" }, viewId: { type: "string" } },
        required: ["operation", "viewId"],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: "required",
  stream: false,
};

describe("explicit OpenRouter fallback", () => {
  it("recovers the same native-tool call, preserves full input and attributes the serving provider", async () => {
    const { runtime: agent, events } = runtime();
    const result = await handleTextSmall(agent, params);
    expect(result).toMatchObject({
      toolCalls: [{ toolName: "VIEWS", input: { operation: "show", viewId: "chat" } }],
      providerMetadata: { provider: "openrouter", modelName: "qwen/qwen3.8-27b" },
    });
    expect(requests).toHaveLength(2);
    expect(requests.map(({ auth }) => auth)).toEqual([
      "Bearer primary-fixture-key",
      "Bearer fallback-fixture-key",
    ]);
    expect(requests[1].body.messages).toEqual(requests[0].body.messages);
    expect(requests[1].body.tools).toEqual(requests[0].body.tools);
    expect(requests[1].body.tool_choice).toEqual("required");
    expect(requests[1].body.reasoning).toEqual({ enabled: false });
    expect(requests[1].body.provider).toEqual({
      require_parameters: true,
      data_collection: "deny",
      sort: "latency",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ provider: "openrouter", modelName: "qwen/qwen3.8-27b" })
    );
    await handleTextSmall(agent, params);
    expect(requests).toHaveLength(3);
    expect(requests[2].path).toContain("/fallback/");
    primaryStatus = 200;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await handleTextSmall(agent, params);
    expect(requests[3].path).toContain("/primary/");
  });

  it.each([false, true])("recovers before streaming output, structured=%s", async (structured) => {
    const { runtime: agent } = runtime();
    const chunks: string[] = [];
    const response = (await handleTextSmall(agent, {
      ...(structured ? params : { prompt: "Go home" }),
      stream: true,
      streamStructured: structured,
      onStreamChunk: (chunk) => chunks.push(chunk),
    })) as TextStreamResult;
    for await (const _chunk of response.textStream) {
      /* Consume actual provider frames. */
    }
    expect(await response.text).toBe(
      structured ? JSON.stringify({ operation: "show", viewId: "chat" }) : "Back home."
    );
    expect(chunks.join("")).toBe(await response.text);
    expect(response.providerMetadata?.provider).toBe("openrouter");
    expect(requests).toHaveLength(2);
  });

  it.each(["generate", "stream", "structured", "buffered"])(
    "uses the authorized fallback after the first headerless 429 in the %s lane",
    async (lane) => {
      retryAfter = undefined;
      if (lane === "buffered") vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "1");
      const { runtime: agent } = runtime();
      const value = await handleTextSmall(
        agent,
        lane === "generate"
          ? params
          : {
              ...(lane === "stream" ? { prompt: "Go home" } : params),
              stream: true,
              streamStructured: lane === "structured",
            }
      );
      if (lane !== "generate")
        for await (const _chunk of (value as TextStreamResult).textStream) {
          /* Drain actual SDK stream. */
        }
      expect(requests.map((x) => x.path)).toEqual([
        "/primary/v1/chat/completions",
        "/fallback/v1/chat/completions",
      ]);
      expect(requests[1].body.messages).toEqual(requests[0].body.messages);
      expect(requests[1].body.tools).toEqual(requests[0].body.tools);
    }
  );

  it("never crosses providers after a partial stream reaches the caller", async () => {
    const { runtime: agent } = runtime();
    partialStream = true;
    const chunks: string[] = [];
    const response = (await handleTextSmall(agent, {
      prompt: "Go home",
      stream: true,
      onStreamChunk: (chunk) => chunks.push(chunk),
    })) as TextStreamResult;
    const consume = async () => {
      for await (const _chunk of response.textStream) {
        /* Consume actual provider frames. */
      }
    };
    await expect(consume()).rejects.toBeDefined();
    expect(chunks.join("")).toBe("Already visible");
    expect(requests).toHaveLength(1);
  });

  it.each([400, 401])("does not hide primary HTTP %s behind another provider", async (status) => {
    primaryStatus = status;
    const { runtime: agent } = runtime();
    await expect(handleTextSmall(agent, params)).rejects.toMatchObject({ statusCode: status });
    expect(requests).toHaveLength(1);
  });

  it("keeps alternate-provider rate limits isolated and never loops between providers", async () => {
    fallbackStatus = 429;
    const { runtime: agent } = runtime();
    await expect(handleTextSmall(agent, params)).rejects.toMatchObject({ statusCode: 429 });
    await expect(handleTextSmall(agent, params)).rejects.toMatchObject({
      name: "ProviderRateLimitCooldownError",
      statusCode: 429,
    });
    expect(requests).toHaveLength(2);
  });

  it("requires explicit model and credentials before crossing the provider boundary", async () => {
    const { runtime: agent } = runtime({ OPENROUTER_FALLBACK_MODEL: "" });
    await expect(handleTextSmall(agent, params)).rejects.toMatchObject({ statusCode: 429 });
    expect(requests).toHaveLength(1);
  });
});
