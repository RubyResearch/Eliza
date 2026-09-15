/**
 * Runs the production evaluator through the real OpenAI-compatible handler and
 * AI SDK against a loopback provider, then reads its persisted processor result.
 * This proves lossless static-prefix ordering reaches the wire without enabling
 * account-gated cache hints; the provider response is deterministic, not live AI.
 */
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../packages/core/src/runtime";
import { EvaluatorService } from "../../../packages/core/src/services/evaluator";
import type { Evaluator, Memory, PromptSegment } from "../../../packages/core/src/types";
import { ModelType } from "../../../packages/core/src/types";
import { handleTextSmall } from "../models";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { finishReason: "stop", malformed: false, succeeds: true, nativeSchema: false },
  { finishReason: "stop", malformed: false, succeeds: true, nativeSchema: true },
  {
    finishReason: "stop",
    malformed: false,
    succeeds: true,
    nativeSchema: true,
    rejectSchema: true,
  },
  { finishReason: "length", malformed: false, succeeds: false },
  { finishReason: "content_filter", malformed: false, succeeds: false },
  { finishReason: "stop", malformed: true, succeeds: false },
])(
  "processes only complete SDK evaluator output ($finishReason, malformed=$malformed)",
  async ({ finishReason, malformed, succeeds, nativeSchema, rejectSchema }) => {
    const bodies: Array<{
      model: string;
      response_format?: { type: string; json_schema?: { schema: unknown } };
      messages: Array<{ role: string; content: string }>;
      prompt_cache_key?: string;
      prompt_cache_retention?: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof bodies)[number];
        bodies.push(body);
        if (rejectSchema && body.response_format?.type === "json_schema") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "response schema json_schema unsupported",
                type: "invalid_request_error",
                code: "unsupported_response_format",
              },
            })
          );
          return;
        }
        const user = body.messages.find((message) => message.role === "user")?.content;
        const match = user && /Latest message:\n([\s\S]*?)\n\nAgent response messages:/.exec(user);
        if (!match) {
          response.writeHead(400);
          response.end("missing complete context");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "eval-wire",
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: malformed
                    ? "{broken-json"
                    : JSON.stringify({ store: { text: match[1] } }),
                },
                finish_reason: finishReason,
              },
            ],
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 20,
              total_tokens: 2020,
              prompt_tokens_details: { cached_tokens: 1024 },
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback address");
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        );
        if (url.hostname !== "127.0.0.1" || url.port !== String(address.port))
          throw new Error("Test forbids non-loopback provider calls");
        return originalFetch(input, init);
      });
      vi.stubEnv("CEREBRAS_API_KEY", "test-loopback-key");
      vi.stubEnv("CEREBRAS_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
      vi.stubEnv("CEREBRAS_SMALL_MODEL", "qwen-3.8-27b");
      vi.stubEnv("OPENAI_API_KEY", undefined);
      vi.stubEnv("OPENAI_BASE_URL", undefined);
      vi.stubEnv("ELIZA_PROVIDER", nativeSchema ? "openai" : "cerebras");
      if (nativeSchema) {
        vi.stubEnv("CEREBRAS_API_KEY", undefined);
        vi.stubEnv("OPENAI_API_KEY", "loopback-test-key");
        vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
        vi.stubEnv("OPENAI_SMALL_MODEL", "gpt-4o-mini");
      }
      const runtime = new AgentRuntime({
        // The 140K-char message and the repeated schema are the point of this
        // wire test; keep them above the post-turn input budget's default.
        character: {
          name: "EvaluatorWire",
          bio: "test",
          settings: { POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS: "1000000" },
        },
        adapter: new InMemoryDatabaseAdapter(),
        logLevel: "fatal",
      });
      runtime.evaluators.length = 0;
      runtime.composeState = async () => ({
        values: {},
        data: {},
        text: "Complete provider context remains here.",
      });
      runtime.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
      const stable = "Extract the complete latest message including its final reference.\n\n";
      const segments = (text: string): PromptSegment[] => [
        { content: stable, stable: true },
        { content: text, stable: false },
      ];
      const schemaDescription = `${"Schema Unicode 🧭 漢字 ".repeat(10000)}FINAL-CONTRACT-TAIL`;
      const saved: string[] = [];
      const evaluator: Evaluator<{ text: string }> = {
        name: "store",
        description: "Persist the extracted message",
        schema: {
          type: "object",
          properties: { text: { type: "string", description: schemaDescription } },
          required: ["text"],
          additionalProperties: false,
        },
        shouldRun: async () => true,
        prompt: ({ message }) =>
          segments(message.content.text ?? "")
            .map((segment) => segment.content)
            .join(""),
        promptSegments: ({ message }) => segments(message.content.text ?? ""),
        parse: (value) => value as { text: string },
        processors: [
          {
            process: async ({ message, output }) => {
              saved.push(
                await runtime.createMemory(
                  {
                    ...message,
                    id: crypto.randomUUID() as Memory["id"],
                    content: { text: output.text },
                  },
                  "messages"
                )
              );
              return { success: true };
            },
          },
        ],
      };
      runtime.registerEvaluator(evaluator);
      for (const text of [`${"A".repeat(140_000)}-FIRST-END`, "second-SECOND-END"]) {
        const message: Memory = {
          id: crypto.randomUUID() as Memory["id"],
          entityId: crypto.randomUUID() as Memory["entityId"],
          roomId: crypto.randomUUID() as Memory["roomId"],
          content: { text },
        };
        const result = await new EvaluatorService(runtime).run(message);
        if (!succeeds) {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.processedEvaluators).toEqual([]);
          expect(saved).toEqual([]);
          expect(bodies.length).toBeGreaterThan(0);
          return;
        }
        expect(result.errors).toEqual([]);
        expect(result.processedEvaluators).toEqual(["store"]);
        const id = saved.at(-1);
        if (!id) throw new Error("No processor persistence receipt");
        expect((await runtime.getMemoryById(id as NonNullable<Memory["id"]>))?.content.text).toBe(
          text
        );
        const wire = bodies.at(-1);
        const user = wire?.messages.find((item) => item.role === "user")?.content;
        expect(user).toContain(text);
        const mergedSchema = {
          type: "object",
          properties: { store: evaluator.schema },
          required: ["store"],
          additionalProperties: false,
        };
        // The complete contract is visible on every rung as compact JSON
        // (never the indented form); the structural request also carries it
        // on the wire, the JSON-object fallback only in the prompt.
        const schemaMatch =
          user && /## Output JSON Schema\n([\s\S]*?)\n\nEvaluate just-finished turn/.exec(user);
        expect(schemaMatch).toBeTruthy();
        expect(schemaMatch?.[1]).toBe(JSON.stringify(mergedSchema));
        const visibleSchema = JSON.parse(schemaMatch?.[1] ?? "null");
        expect(visibleSchema.properties.store.properties.text.description).toBe(
          schemaDescription
        );
        expect(user).not.toContain("## Output Shape");
        expect(user?.indexOf("## Output JSON Schema")).toBeLessThan(
          user?.indexOf("Latest message:") ?? -1
        );
        if (!rejectSchema) {
          expect(wire?.response_format?.type).toBe("json_schema");
          if (!nativeSchema) {
            expect(wire?.response_format?.json_schema?.schema).toEqual(mergedSchema);
          }
        } else {
          expect(wire?.response_format?.type).toBe("json_object");
        }
        expect(user?.indexOf(stable)).toBeLessThan(user?.indexOf("Latest message:") ?? -1);
        expect(wire?.prompt_cache_key).toBeUndefined();
        expect(wire?.prompt_cache_retention).toBeUndefined();
      }
      expect(bodies).toHaveLength(rejectSchema ? 3 : 2);
      if (rejectSchema) {
        expect(bodies[0]?.response_format?.type).toBe("json_schema");
        expect(bodies[1]?.response_format?.type).toBe("json_object");
        // Same turn context on both rungs; only the contract rendering differs.
        const userOf = (body: (typeof bodies)[number] | undefined) =>
          body?.messages.find((item) => item.role === "user")?.content ?? "";
        const turnContext = (prompt: string) =>
          prompt.slice(prompt.indexOf("Evaluate just-finished turn"));
        expect(userOf(bodies[0])).toContain("## Output JSON Schema\n");
        expect(userOf(bodies[1])).toBe(userOf(bodies[0]));
        expect(turnContext(userOf(bodies[1]))).toBe(turnContext(userOf(bodies[0])));
        expect(bodies[1]?.messages.filter((item) => item.role !== "user")).toEqual(
          bodies[0]?.messages.filter((item) => item.role !== "user")
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
  30_000
);
