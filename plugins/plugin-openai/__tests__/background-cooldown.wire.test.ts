/** Real runtime, durable evaluator/task services and AI SDK over loopback HTTP.
 * Virtual time proves queue retries honor provider windows without paid calls.
 * The provider responses are protocol fixtures, not model quality evidence.
 */
import { createServer } from "node:http";
import {
  AgentRuntime,
  ChannelType,
  EvaluatorService,
  InMemoryDatabaseAdapter,
  type Memory,
  ModelType,
  stringToUuid,
  TaskService,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";

it("shares a provider hold across memory jobs and resumes after restart and foreground release", async () => {
  const start = Date.now();
  let now = start;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let requests = 0,
    attempts = 0,
    processed = 0;
  const deadline = start + 61_000;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      const limited = now < deadline;
      response.writeHead(limited ? 429 : 200, {
        "content-type": "application/json",
        ...(limited ? { "retry-after": "60" } : {}),
      });
      response.end(
        JSON.stringify(
          limited
            ? { error: { message: "Tokens per minute limit exceeded", type: "rate_limit_error" } }
            : {
                id: "fixture",
                object: "chat.completion",
                created: 1,
                model: "qwen-3.8-27b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: '{"memory":{"ok":true}}' },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
              }
        )
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback did not bind");
    const runtime = new AgentRuntime({
      character: { name: "BackgroundCooldownWire", bio: "Isolated integration fixture" },
      adapter: new InMemoryDatabaseAdapter(),
      settings: {
        ELIZA_PROVIDER: "cerebras",
        OPENAI_API_KEY: "loopback-fixture-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_SMALL_MODEL: "qwen-3.8-27b",
        OPENROUTER_API_KEY: "",
        OPENROUTER_FALLBACK_MODEL: "",
      },
      logLevel: "fatal",
    });
    runtime.evaluators.length = 0;
    const state = { values: {}, data: {}, text: "" };
    runtime.composeState = async () => state;
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async (owner, params) => {
        attempts++;
        return handleTextSmall(owner, { ...params, stream: false });
      },
      "openai",
      100
    );
    runtime.registerEvaluator({
      name: "memory",
      description: "Test",
      background: true,
      incremental: true,
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      shouldRun: async () => true,
      prompt: () => "Read all supplied evidence.",
      processors: [
        {
          process: async () => {
            processed++;
          },
        },
      ],
    });
    const entityId = stringToUuid("cooldown-wire-owner");
    await runtime.createEntities([{ id: entityId, agentId: runtime.agentId, names: ["Owner"] }]);
    const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
    const messages: Memory[] = [];
    for (const name of ["first", "second"]) {
      const roomId = stringToUuid(`cooldown-wire-${name}`);
      await runtime.createRooms([
        { id: roomId, agentId: runtime.agentId, type: ChannelType.DM, source: "test" },
      ]);
      await runtime.createRoomParticipants([entityId], roomId);
      const message: Memory = {
        id: stringToUuid(`cooldown-wire-message-${name}`),
        roomId,
        entityId,
        agentId: runtime.agentId,
        createdAt: start,
        content: { text: `Remember this ${name} source.` },
      };
      await runtime.upsertMemory(message, "messages");
      messages.push(message);
      await service.enqueue(message, state, { phase: "post_turn" });
    }
    const scheduler = () =>
      new TaskService(runtime, {
        now: () => now,
        setInterval: () => {
          throw new Error("Manual ticks only");
        },
        clearInterval: () => undefined,
      });
    now = start + 1000;
    await expect(scheduler().runDueTasks()).rejects.toThrow();
    expect(requests).toBe(1);
    expect(attempts).toBe(2);
    expect(processed).toBe(0);
    const jobs = await runtime.getTasksByName("POST_TURN_MEMORY");
    expect(jobs).toHaveLength(2);
    for (const job of jobs)
      expect(job.metadata).toMatchObject({ failureCount: 1, updateInterval: 60_000 });
    now = start + 31_000;
    for (const message of messages)
      await service.enqueue(message, state, { phase: "post_turn", didRespond: true });
    await EvaluatorService.start(runtime);
    const restarted = scheduler();
    await restarted.runDueTasks();
    expect(attempts).toBe(2);
    now = deadline - 1;
    await restarted.runDueTasks();
    expect(attempts).toBe(2);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const foreground = runtime.roomHandlerQueue.withLease(messages[0].roomId, async () => {
      entered();
      await held;
    });
    await ready;
    try {
      now = deadline;
      await restarted.runDueTasks();
      expect(attempts).toBe(2);
    } finally {
      release();
      await foreground;
    }
    await restarted.runDueTasks();
    expect(attempts).toBe(4);
    expect(requests).toBe(3);
    expect(processed).toBe(2);
    expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toHaveLength(0);
    for (const message of messages) {
      if (!message.id) throw new Error("Persisted source identity required");
      expect((await runtime.getMemoryById(message.id))?.content).toEqual(message.content);
    }
  } finally {
    clock.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
