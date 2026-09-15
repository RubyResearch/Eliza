/**
 * Route-level wiring coverage for the HTTP chat idempotency guard on the
 * dedicated-agent conversation endpoints (`POST /api/conversations/:id/messages`
 * and its `/stream` twin). The pure decision function is pinned in
 * `chat-idempotency.test.ts`; these tests prove the routes actually consult it:
 * a first send runs the LLM turn, a retry carrying the SAME `clientMessageId`
 * within the TTL is suppressed (no second turn, no second persisted memory) and
 * — when the first attempt's assistant reply already persisted — answers with
 * THAT reply instead of an empty ignored turn; a retry landing while the
 * original is still mid-turn (nothing persisted yet) keeps the empty ignored
 * shape; and a send WITHOUT an idempotency key behaves exactly as before (no
 * dedupe).
 *
 * Deliberately mock-free at the module level (no `vi.mock`): the real route
 * handlers, real `chat-routes` helpers, and the real dedupe cache run end to
 * end; only the runtime seam (message service + memory adapter) is stubbed, so
 * `messageService.handleMessage` call counts are the ground truth for "an LLM
 * turn ran" and `runtime.createMemory` counts for "a memory was persisted".
 *
 * The modules under test are loaded dynamically after `vi.resetModules()`
 * rather than via static imports: this package's vmForks pool shares the
 * module cache across test files in a worker, so a sibling suite that
 * `vi.mock`s `chat-routes.ts` would otherwise leak its mocked graph into this
 * file (and vice versa) depending on execution order. The fresh graph makes
 * this suite order-independent and guarantees the REAL guard + routes run.
 */

import http from "node:http";
import type {
  Action,
  AgentRuntime,
  EffectReceipt,
  Memory,
  Service,
} from "@elizaos/core";
import {
  executePlannedToolCall,
  logger,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createSharedTodoCutoverSnapshot,
  type SharedTodoCutoverSnapshot,
} from "@elizaos/shared/todo-cutover";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { quiesceRuntimeBeforeReplacement } from "../runtime-replacement-ownership.ts";

let handleConversationRoutes: typeof import("../conversation-routes.ts")["handleConversationRoutes"];
let resetChatDedupe: () => void;
let getChatDedupeTtlMs: () => number;
let markChatMessageSeen: typeof import("../chat-routes.ts")["isDuplicateChatMessage"];
let setChatOutcome: typeof import("../chat-routes.ts")["setChatMessageIdOutcome"];

beforeAll(async () => {
  vi.resetModules();
  const chatRoutes = await import("../chat-routes.ts");
  resetChatDedupe = chatRoutes.__resetChatDedupeForTests;
  getChatDedupeTtlMs = chatRoutes.__getChatDedupeTtlMsForTests;
  markChatMessageSeen = chatRoutes.isDuplicateChatMessage;
  setChatOutcome = chatRoutes.setChatMessageIdOutcome;
  ({ handleConversationRoutes } = await import("../conversation-routes.ts"));
});

// Symmetric hygiene: drop this suite's real module graph from the shared
// worker cache so a later file's `vi.mock` factories apply to fresh imports
// instead of silently hitting our unmocked instances.
afterAll(() => {
  vi.resetModules();
});

const AGENT_ID = stringToUuid("agent-1") as UUID;
const USER_ID = stringToUuid("user-1") as UUID;
const ROOM_ID = stringToUuid("room-1") as UUID;
const ROUTE_IDEMPOTENCY_SCOPE = `${AGENT_ID}:${ROOM_ID}:${USER_ID}`;

const STREAM_PATH = "/api/conversations/conv-1/messages/stream";
const SEND_PATH = "/api/conversations/conv-1/messages";
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const RECONNECT_WAIT_TIMEOUT_MS = 30_000;
const RECONNECT_SIGNAL_DEBOUNCE_MS = 400;
const INCOMPLETE_RECOVERY_TEXT =
  "The previous attempt ended before its final response was saved. It was not run again; send a new message if you want to retry.";

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = { writes: [], ended: false };
  const res = {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      record.writes.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      );
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
    }),
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res, record };
}

interface TestHarness {
  state: ConversationRouteState;
  handleMessage: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  storedMemories: Memory[];
  deleteManyMemories: ReturnType<typeof vi.fn>;
  deleteRoom: ReturnType<typeof vi.fn>;
  importScheduledTask: ReturnType<typeof vi.fn>;
  activateScheduledTask: ReturnType<typeof vi.fn>;
}

/** Real-route harness: the runtime stub streams one "ok" chunk per turn via
 *  the message service, so the real `generateChatResponse` pipeline (status →
 *  token → done framing, persistence ordering) runs unmodified. Persisted
 *  memories are retained and served back through `getMemories`, so the dupe
 *  branches' persisted-first-reply lookup reads the real write path's output. */
function createHarness(
  options: {
    maxPendingPerRoom?: number;
    scheduling?: boolean;
    failOutcomeSettlementOnce?: boolean;
  } = {},
): TestHarness {
  const handleMessage = vi.fn(
    async (
      _runtime: unknown,
      _message: unknown,
      _callback: unknown,
      options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
    ) => {
      await Promise.resolve();
      await options?.onStreamChunk?.("ok");
      return {
        didRespond: true,
        responseContent: { text: "ok" },
        responseMessages: [],
      };
    },
  );
  const storedMemories: Memory[] = [];
  const worlds = new Map<
    UUID,
    { id: UUID; agentId: UUID; metadata: Record<string, unknown> }
  >();
  const createMemory = vi.fn(async (memory: Memory) => {
    if (memory.id && storedMemories.some((stored) => stored.id === memory.id)) {
      throw new Error("duplicate unique constraint: messages.id");
    }
    storedMemories.push(memory);
    return memory.id ?? stringToUuid("created-memory");
  });
  let shouldFailOutcomeSettlement = options.failOutcomeSettlementOnce === true;
  const updateMemory = vi.fn(async (memory: Partial<Memory> & { id: UUID }) => {
    const marker = memory.content?.chatIdempotency;
    if (
      shouldFailOutcomeSettlement &&
      marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      "outcomeJson" in marker
    ) {
      shouldFailOutcomeSettlement = false;
      throw new Error("simulated outcome marker write failure");
    }
    const index = storedMemories.findIndex((stored) => stored.id === memory.id);
    if (index < 0) throw new Error("memory not found");
    storedMemories[index] = { ...storedMemories[index], ...memory };
    return true;
  });
  const deleteManyMemories = vi.fn(async (ids: UUID[]) => {
    for (const id of ids) {
      const index = storedMemories.findIndex((memory) => memory.id === id);
      if (index >= 0) storedMemories.splice(index, 1);
    }
  });
  const deleteRoom = vi.fn(async () => undefined);
  const emitEvent = vi.fn(async () => undefined);
  const importedScheduledTaskIds = new Set<string>();
  const importScheduledTask = vi.fn(async (task: { taskId: string }) => {
    const imported = !importedScheduledTaskIds.has(task.taskId);
    importedScheduledTaskIds.add(task.taskId);
    return { task, imported };
  });
  const activatedScheduledTaskIds = new Set<string>();
  const activateScheduledTask = vi.fn(async (taskId: string) => {
    const activated = !activatedScheduledTaskIds.has(taskId);
    activatedScheduledTaskIds.add(taskId);
    return { task: { taskId }, activated };
  });
  const schedulingService = {
    getRunner: () => ({
      importTask: importScheduledTask,
      activateImportedTask: activateScheduledTask,
    }),
  };
  const runtime = {
    agentId: AGENT_ID,
    character: {
      name: "Test Agent",
      system: "System prompt",
      settings: { model: "test/model" },
    },
    actions: [],
    plugins: [],
    logger,
    emitEvent,
    getService: <T extends Service = Service>() =>
      options.scheduling ? (schedulingService as unknown as T) : null,
    getServicesByType: vi.fn(() => []),
    drainChatPreHandlers: vi.fn(async () => null),
    messageService: {
      handleMessage,
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "idempotency-test",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    },
    createMemory,
    updateMemory,
    deleteManyMemories,
    deleteRoom,
    createLogs: vi.fn(async () => undefined),
    getMemories: vi.fn(async () => storedMemories),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
      storedMemories.filter(
        (memory) => memory.id && ids.includes(memory.id as UUID),
      ),
    ),
    ensureConnection: vi.fn(async (input: { worldId?: UUID }) => {
      if (!input.worldId) throw new Error("worldId is required");
      if (!worlds.has(input.worldId)) {
        worlds.set(input.worldId, {
          id: input.worldId,
          agentId: AGENT_ID,
          metadata: {},
        });
      }
    }),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async (worldId: UUID) => worlds.get(worldId) ?? null),
    getRoom: vi.fn(async () => null),
    getParticipantsForRoom: vi.fn(async () => [USER_ID, AGENT_ID]),
    reportError: vi.fn(),
    abortTurn: vi.fn(),
    roomHandlerQueue: new RoomHandlerQueue(options),
    adapter: { db: {} } as never,
  } satisfies Partial<AgentRuntime> & Record<string, unknown>;

  const conv = {
    id: "conv-1",
    title: "Test conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const state = {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: USER_ID,
    chatUserId: USER_ID,
    logBuffer: [],
    conversations: new Map([[conv.id, conv]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  } as unknown as ConversationRouteState;

  return {
    state,
    handleMessage,
    emitEvent,
    createMemory,
    updateMemory,
    storedMemories,
    deleteManyMemories,
    deleteRoom,
    importScheduledTask,
    activateScheduledTask,
  };
}

function createReq(method: string, url: string): http.IncomingMessage {
  return Object.assign(new http.IncomingMessage(null as never), {
    method,
    url,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  }) as http.IncomingMessage;
}

interface CapturedJson {
  payload: unknown;
}

/** Drive one request through the real route handler and await its durable terminal result. */
async function runRoute(
  method: string,
  pathname: string,
  state: ConversationRouteState,
  body: Record<string, unknown>,
  duringRequest?: (req: http.IncomingMessage) => Promise<void> | void,
): Promise<{ record: MockResponseRecord; captured: CapturedJson }> {
  const { res, record } = createMockRes();
  const req = createReq(method, pathname);
  const captured: CapturedJson = { payload: undefined };
  const ctx = {
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody: vi.fn(async () => body),
    json: vi.fn((_res: unknown, payload: unknown) => {
      captured.payload = payload;
    }),
    error: vi.fn(
      (response: http.ServerResponse, message: string, status?: number) => {
        response.write(`error ${status}: ${message}`);
        response.end();
      },
    ),
    todoCutoverImporter: vi.fn(
      async ({ snapshot }: { snapshot: SharedTodoCutoverSnapshot }) => ({
        sourceTodoCount: snapshot.todos.length,
        sourceTodoMutationCount: snapshot.mutations.length,
        importedTodos: snapshot.todos.length,
        repairedTodos: 0,
        skippedTodos: 0,
        removedStaleTodos: 0,
        importedTodoMutations: snapshot.mutations.length,
        skippedTodoMutations: 0,
        sourceTodoDigest: snapshot.digest,
        targetTodoDigest: snapshot.digest,
      }),
    ),
  } as unknown as ConversationRouteContext;

  const done = handleConversationRoutes(ctx);
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  await duringRequest?.(req);
  // Bound the wait so a route that stalls (e.g. a regression that never emits
  // the terminal frame) fails this test promptly instead of eating the full
  // 120s per-test timeout.
  await Promise.race([
    done,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("conversation route did not settle within 15s")),
        15_000,
      ).unref?.(),
    ),
  ]);
  // The streaming handler defers assistant persistence past res.end(); flush it.
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  return { record, captured };
}

function parseDataFrames(record: MockResponseRecord): Array<{
  type: string;
  fullText?: string;
  messageId?: string;
  userMessageId?: string;
  agentName?: string;
  transcriptVisibility?: "internal";
  thought?: string;
  usage?: unknown;
  actionResults?: unknown;
  failureKind?: string;
  terminalFailure?: unknown;
  accountConnect?: unknown;
  localInference?: unknown;
  noResponseReason?: "ignored";
  interrupted?: boolean;
}> {
  return record.writes
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as {
          type: string;
          fullText?: string;
          messageId?: string;
          userMessageId?: string;
          agentName?: string;
          transcriptVisibility?: "internal";
          thought?: string;
          usage?: unknown;
          actionResults?: unknown;
          failureKind?: string;
          terminalFailure?: unknown;
          accountConnect?: unknown;
          localInference?: unknown;
          noResponseReason?: "ignored";
          interrupted?: boolean;
        },
    );
}

describe("conversation-route chat idempotency wiring", () => {
  beforeEach(() => {
    resetChatDedupe();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delivers durable JSON before room work finishes and fences the next turn", async () => {
    const { trackPostDeliveryTask } = await import("@elizaos/core");
    const { state, handleMessage, storedMemories } = createHarness();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const gate = Promise.withResolvers<void>();
    let reflected = false;
    handleMessage.mockImplementationOnce(async () => {
      void trackPostDeliveryTask(
        runtime,
        "deferred-room-reflection",
        async () => {
          await gate.promise;
          expect(
            runtime.roomHandlerQueue.ownsLease(
              ROOM_ID,
              runtime.roomHandlerQueue.currentLease(ROOM_ID),
            ),
          ).toBe(true);
          reflected = true;
        },
      );
      return {
        didRespond: true,
        responseContent: { text: "First reply." },
        responseMessages: [],
      };
    });
    handleMessage.mockImplementationOnce(async () => {
      expect(reflected).toBe(true);
      return {
        didRespond: true,
        responseContent: { text: "Second reply." },
        responseMessages: [],
      };
    });
    const body = { text: "first turn", clientMessageId: "json-early-first" };
    const { res, record } = createMockRes();
    const json = vi.fn((response: http.ServerResponse, _payload: unknown) =>
      response.end(),
    );
    const ctx = {
      req: createReq("POST", SEND_PATH),
      res,
      method: "POST",
      pathname: SEND_PATH,
      state,
      readJsonBody: async () => body,
      json,
      error: vi.fn(),
    } as unknown as ConversationRouteContext;
    let settled = false;
    const first = handleConversationRoutes(ctx).then(() => {
      settled = true;
    });
    let second: ReturnType<typeof runRoute> | undefined;
    try {
      await vi.waitFor(() => expect(record.ended).toBe(true));
      expect(settled).toBe(false);
      expect(reflected).toBe(false);
      expect(state.activeChatTurnCount).toBe(1);
      expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(1);
      expect(json).toHaveBeenCalledTimes(1);
      const outcome = json.mock.calls[0][1];
      expect(outcome).toMatchObject({
        text: "First reply.",
        messageId: expect.any(String),
      });
      expect(storedMemories).toContainEqual(
        expect.objectContaining({
          content: expect.objectContaining({ text: "First reply." }),
        }),
      );
      const replay = await runRoute("POST", SEND_PATH, state, body);
      expect(replay.captured.payload).toEqual(outcome);
      expect(handleMessage).toHaveBeenCalledTimes(1);

      second = runRoute("POST", SEND_PATH, state, {
        text: "second turn",
        clientMessageId: "json-early-second",
      });
      await vi.waitFor(() =>
        expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(2),
      );
      expect(handleMessage).toHaveBeenCalledTimes(1);
      gate.resolve();
      const [, secondResult] = await Promise.all([first, second]);
      expect(secondResult.captured.payload).toMatchObject({
        text: "Second reply.",
      });
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(json).toHaveBeenCalledTimes(1);
      expect(state.activeChatTurnCount).toBe(0);
      expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
      expect(runtime.reportError).not.toHaveBeenCalled();
      // After a cache loss, the settled durable marker still suppresses replay.
      resetChatDedupe();
      const durableReplay = await runRoute("POST", SEND_PATH, state, body);
      expect(durableReplay.captured.payload).toEqual(outcome);
      expect(handleMessage).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await Promise.all([first, second]);
    }
  });

  it("preserves delivered JSON and durable retries after a room drain failure", async () => {
    const { quarantinePostDeliveryTasks } = await import("@elizaos/core");
    const { state, handleMessage, storedMemories } = createHarness();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    handleMessage.mockImplementationOnce(async () => {
      quarantinePostDeliveryTasks(runtime, new Error("reflection cancelled"));
      return {
        didRespond: true,
        responseContent: { text: "Completed action." },
        responseMessages: [],
      };
    });
    const body = {
      text: "perform action",
      clientMessageId: "json-drain-failure",
    };
    const { res } = createMockRes();
    const json = vi.fn((response: http.ServerResponse, _payload: unknown) =>
      response.end(),
    );
    const error = vi.fn();
    await handleConversationRoutes({
      req: createReq("POST", SEND_PATH),
      res,
      method: "POST",
      pathname: SEND_PATH,
      state,
      readJsonBody: async () => body,
      json,
      error,
    } as unknown as ConversationRouteContext);
    expect(json).toHaveBeenCalledTimes(1);
    const outcome = json.mock.calls[0][1];
    expect(outcome).toMatchObject({ text: "Completed action." });
    expect(error).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "ConversationJson.postDelivery",
      expect.objectContaining({ code: "POST_DELIVERY_DRAIN_CANCELLED" }),
      expect.objectContaining({ conversationId: "conv-1" }),
    );
    expect(state.activeChatTurnCount).toBe(0);
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
    const persistedCount = storedMemories.length;
    resetChatDedupe();
    const replay = await runRoute("POST", SEND_PATH, state, body);
    expect(replay.captured.payload).toEqual(outcome);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(storedMemories).toHaveLength(persistedCount);
  });

  it("cordons and drains the old runtime before a same-room replacement turn starts", async () => {
    const old = createHarness();
    const replacement = createHarness();
    const oldRuntime = old.state.runtime;
    const newRuntime = replacement.state.runtime;
    if (!oldRuntime || !newRuntime) throw new Error("runtime fixture missing");
    const active = await oldRuntime.roomHandlerQueue.acquire(ROOM_ID);
    let published = false;
    const swap = quiesceRuntimeBeforeReplacement(oldRuntime, newRuntime).then(
      () => {
        old.state.runtime = newRuntime;
        published = true;
      },
    );

    await vi.waitFor(() =>
      expect(oldRuntime.roomHandlerQueue.isAcceptingAdmissions()).toBe(false),
    );
    expect(published).toBe(false);
    await active.release();
    await swap;
    expect(published).toBe(true);

    const response = await runRoute("POST", SEND_PATH, old.state, {
      text: "run on the replacement",
      clientMessageId: "post-reload-turn",
    });
    expect(response.captured.payload).toMatchObject({ text: "ok" });
    expect(old.handleMessage).not.toHaveBeenCalled();
    expect(replacement.handleMessage).toHaveBeenCalledTimes(1);
    expect(oldRuntime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
    expect(newRuntime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
  });

  it("SSE: first send runs the turn; a retry after delivery returns the persisted first reply", async () => {
    const { state, handleMessage, emitEvent, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "sse-retry-1" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const persistsAfterFirst = createMemory.mock.calls.length;
    expect(persistsAfterFirst).toBeGreaterThan(0);
    const firstDone = parseDataFrames(first.record).find(
      (f) => f.type === "done",
    );
    expect(firstDone?.fullText).toBe("ok");
    const deliveryOnlyPayloads = emitEvent.mock.calls
      .filter(([event]) => event === "MESSAGE_SENT")
      .map(([, payload]) => payload as Record<string, unknown>);
    expect(deliveryOnlyPayloads).not.toHaveLength(0);
    expect(
      deliveryOnlyPayloads.every(
        (payload) => payload.trajectoryTerminalOwner === undefined,
      ),
    ).toBe(true);

    // Network-blip auto-retry: same conversation, same clientMessageId.
    const second = await runRoute("POST", STREAM_PATH, state, body);
    // No second LLM turn, no additional persisted memories (user or assistant).
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
    // The first attempt's reply already persisted, so the retry's terminal
    // frame carries IT — the retry delivers the original outcome instead of
    // an empty turn the client must repair from history.
    const frames = parseDataFrames(second.record);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "done", fullText: "ok" });
    expect(second.record.ended).toBe(true);
  });

  it("SSE: replays the exact durable outcome after process-local retention expires", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = {
      text: "survive a restart",
      clientMessageId: "restart-replay-1",
    };
    const firstArrival = Date.now();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(firstArrival);
      const first = await runRoute("POST", STREAM_PATH, state, body);
      const firstDone = parseDataFrames(first.record).find(
        (frame) => frame.type === "done",
      );
      expect(firstDone).toBeDefined();
      const persistsAfterFirst = createMemory.mock.calls.length;

      // A fresh process has no in-memory reservation, and this timestamp is
      // beyond the cache's normal retention window. The durable user-row
      // marker remains the source of truth for replay.
      resetChatDedupe();
      nowSpy.mockReturnValue(firstArrival + getChatDedupeTtlMs() + 1);
      const retry = await runRoute("POST", STREAM_PATH, state, body);
      const retryDone = parseDataFrames(retry.record).find(
        (frame) => frame.type === "done",
      );

      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
      expect(retryDone).toEqual(firstDone);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("SSE: rejects a different payload for a durable key after restart", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const clientMessageId = "restart-conflict-1";
    await runRoute("POST", STREAM_PATH, state, {
      text: "original durable command",
      clientMessageId,
    });
    const persistsAfterFirst = createMemory.mock.calls.length;

    resetChatDedupe();
    const conflicting = await runRoute("POST", STREAM_PATH, state, {
      text: "different command",
      clientMessageId,
    });
    const conflictFrame = parseDataFrames(conflicting.record).find(
      (frame) => frame.type === "error",
    ) as { type: string; code?: string } | undefined;

    expect(conflictFrame).toMatchObject({
      type: "error",
      code: "CHAT_IDEMPOTENCY_CONFLICT",
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
  });

  it.each([
    {
      label: "wrong field type",
      outcomeJson: JSON.stringify({ text: 42, agentName: "invalid" }),
    },
    {
      label: "unknown protocol override fields",
      outcomeJson: JSON.stringify({
        text: "safe",
        agentName: "invalid",
        type: "error",
        fullText: "spoofed",
      }),
    },
    { label: "empty serialized outcome", outcomeJson: "" },
  ])(
    "SSE: rejects a persisted terminal with $label without executing",
    async ({ label, outcomeJson }) => {
      const { state, handleMessage, storedMemories } = createHarness();
      const body = {
        text: `validate persisted outcome ${label}`,
        clientMessageId: `invalid-outcome-${label.replaceAll(" ", "-")}`,
      };
      await runRoute("POST", STREAM_PATH, state, body);
      const userMemory = storedMemories.find(
        (memory) => memory.entityId === USER_ID,
      );
      if (!userMemory) throw new Error("durable user memory was not persisted");
      const marker = userMemory.content.chatIdempotency;
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
        throw new Error("durable idempotency marker was not persisted");
      }
      userMemory.content.chatIdempotency = { ...marker, outcomeJson };
      resetChatDedupe();

      const retry = await runRoute("POST", STREAM_PATH, state, body);
      expect(parseDataFrames(retry.record)).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "CHAT_IDEMPOTENCY_OUTCOME_INVALID",
        }),
      );
      expect(handleMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("SSE: authoritative terminal fields cannot be overridden by stored metadata", async () => {
    const { state } = createHarness();
    const clientMessageId = "terminal-field-override";
    expect(markChatMessageSeen(ROUTE_IDEMPOTENCY_SCOPE, clientMessageId)).toBe(
      false,
    );
    setChatOutcome(ROUTE_IDEMPOTENCY_SCOPE, clientMessageId, {
      text: "authoritative text",
      agentName: "Stored Agent",
      type: "error",
      fullText: "spoofed text",
    } as never);

    const response = await runRoute("POST", STREAM_PATH, state, {
      text: "must not execute",
      clientMessageId,
    });
    expect(parseDataFrames(response.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: "authoritative text",
      }),
    ]);
  });

  it("replays the complete terminal contract with explicit stream and JSON mappings", async () => {
    const { state, handleMessage } = createHarness();
    const clientMessageId = "terminal-contract-retry";
    expect(markChatMessageSeen(ROUTE_IDEMPOTENCY_SCOPE, clientMessageId)).toBe(
      false,
    );
    setChatOutcome(ROUTE_IDEMPOTENCY_SCOPE, clientMessageId, {
      text: "",
      agentName: "Original Agent",
      messageId: stringToUuid("terminal-contract-reply"),
      transcriptVisibility: "internal",
      thought: "private reasoning",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        isEstimated: false,
        llmCalls: 1,
      },
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "coding_tool_failure",
      terminalFailure: {
        kind: "coding_tool_failure",
        message: "Shell execution failed.",
        transient: true,
        code: "SHELL_UNAVAILABLE",
      },
      accountConnect: { providers: ["openai-codex"] },
      localInference: { status: "ready" },
    });

    const stream = await runRoute("POST", STREAM_PATH, state, {
      text: "ignored retry payload",
      clientMessageId,
    });
    expect(parseDataFrames(stream.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: "",
        agentName: "Original Agent",
        messageId: stringToUuid("terminal-contract-reply"),
        transcriptVisibility: "internal",
        thought: "private reasoning",
        usage: expect.objectContaining({ totalTokens: 10 }),
        actionResults: [{ actionName: "VIEWS", success: true }],
        failureKind: "coding_tool_failure",
        terminalFailure: {
          kind: "coding_tool_failure",
          message: "Shell execution failed.",
          transient: true,
          code: "SHELL_UNAVAILABLE",
        },
        accountConnect: { providers: ["openai-codex"] },
        localInference: { status: "ready" },
      }),
    ]);

    const jsonRetry = await runRoute("POST", SEND_PATH, state, {
      text: "ignored retry payload",
      clientMessageId,
    });
    expect(jsonRetry.captured.payload).toEqual({
      text: "",
      agentName: "Original Agent",
      messageId: stringToUuid("terminal-contract-reply"),
      transcriptVisibility: "internal",
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "coding_tool_failure",
      terminalFailure: {
        kind: "coding_tool_failure",
        message: "Shell execution failed.",
        transient: true,
        code: "SHELL_UNAVAILABLE",
      },
      accountConnect: { providers: ["openai-codex"] },
      localInference: { status: "ready" },
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("SSE: interleaved turns replay the outcome bound to the retried key", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        message: { content?: { text?: string } },
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        const prompt = message.content?.text ?? "";
        const isA = prompt === "turn a";
        await (isA ? gateA : gateB);
        const text = isA ? "reply a" : "reply b";
        await options?.onStreamChunk?.(text);
        return {
          didRespond: true,
          responseContent: { text },
          responseMessages: [],
        };
      },
    );

    const turnA = runRoute("POST", STREAM_PATH, state, {
      text: "turn a",
      clientMessageId: "interleaved-a",
    });
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const turnB = runRoute("POST", STREAM_PATH, state, {
      text: "turn b",
      clientMessageId: "interleaved-b",
    });
    await vi.waitFor(() =>
      expect(
        (state.runtime as AgentRuntime).roomHandlerQueue.pendingFor(ROOM_ID),
      ).toBe(2),
    );
    expect(handleMessage).toHaveBeenCalledTimes(1);

    releaseA?.();
    const first = await turnA;
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(2));
    releaseB?.();
    const second = await turnB;
    const firstDone = parseDataFrames(first.record).find(
      (frame) => frame.type === "done",
    );
    const secondDone = parseDataFrames(second.record).find(
      (frame) => frame.type === "done",
    );
    expect(firstDone).toMatchObject({ fullText: "reply a" });
    expect(secondDone).toMatchObject({ fullText: "reply b" });

    const retry = await runRoute("POST", STREAM_PATH, state, {
      text: "turn a",
      clientMessageId: "interleaved-a",
    });
    const retryDone = parseDataFrames(retry.record).find(
      (frame) => frame.type === "done",
    );
    expect(retryDone).toMatchObject({
      fullText: "reply a",
      messageId: firstDone?.messageId,
    });
    expect(retryDone?.messageId).not.toBe(secondDone?.messageId);
    expect(
      storedMemories.some(
        (memory) =>
          memory.id === firstDone?.messageId &&
          (memory.content as { text?: string }).text === "reply a",
      ),
    ).toBe(true);
  });

  it("SSE: rapid same-text turns persist both advertised ids", async () => {
    const { state, storedMemories } = createHarness();
    const first = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "same-a",
    });
    const second = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "same-b",
    });
    const doneFrames = [first, second].map(({ record }) =>
      parseDataFrames(record).find((frame) => frame.type === "done"),
    );

    expect(doneFrames[0]?.messageId).toBeTruthy();
    expect(doneFrames[1]?.messageId).toBeTruthy();
    expect(doneFrames[0]?.messageId).not.toBe(doneFrames[1]?.messageId);
    for (const done of doneFrames) {
      expect(
        storedMemories.some(
          (memory) =>
            memory.id === done?.messageId &&
            (memory.content as { text?: string }).text === "ok",
        ),
      ).toBe(true);
    }
  });

  it.each([
    { label: "SSE", path: STREAM_PATH },
    { label: "JSON", path: SEND_PATH },
  ])(
    "$label: normalizes the message-service row under the live room lease without inserting a duplicate",
    async ({ label, path }) => {
      const { state, handleMessage, storedMemories } = createHarness();
      const leakedPayload =
        '"RESPOND","contexts":["simple"],"replyText":"Normalized reply","candidateActionNames":[]';
      const persistedId = stringToUuid(
        `normalized-existing-assistant-${label}`,
      );
      handleMessage.mockImplementationOnce(
        async (
          runtime: AgentRuntime,
          message: Memory,
          _callback: unknown,
          options?: {
            onStreamChunk?: (chunk: string) => Promise<void> | void;
          },
        ) => {
          const persisted: Memory = {
            id: persistedId,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: message.roomId,
            content: { text: leakedPayload },
          };
          await runtime.createMemory(persisted, "messages");
          await options?.onStreamChunk?.(leakedPayload);
          return {
            didRespond: true,
            responseContent: { text: leakedPayload },
            responseMessages: [persisted],
            persistedResponseMessageIds: [persistedId],
          };
        },
      );

      const response = await runRoute("POST", path, state, {
        text: "normalize it",
        clientMessageId: `normalize-existing-${label}`,
      });
      const terminal =
        label === "SSE"
          ? parseDataFrames(response.record).find(
              (frame) => frame.type === "done",
            )
          : (response.captured.payload as {
              text?: string;
              messageId?: string;
            });
      const terminalText =
        label === "SSE"
          ? (terminal as { fullText?: string })?.fullText
          : (terminal as { text?: string })?.text;
      const assistantRows = storedMemories.filter(
        (memory) => memory.entityId === AGENT_ID,
      );

      expect(terminalText).toBe("Normalized reply");
      expect(terminal?.messageId).toBe(persistedId);
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0]).toMatchObject({
        id: persistedId,
        content: { text: "Normalized reply" },
      });
    },
  );

  it("reconciles typed terminal metadata onto an already-persisted message-service row", async () => {
    const { state, handleMessage, storedMemories, updateMemory } =
      createHarness();
    const persistedId = stringToUuid("typed-terminal-existing-assistant");
    handleMessage.mockImplementationOnce(
      async (runtime: AgentRuntime, message: Memory) => {
        const persisted: Memory = {
          id: persistedId,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content: {
            text: "Shell execution failed.",
            failureKind: "coding_tool_failure",
            transient: true,
            inReplyTo: message.id,
          },
        };
        await runtime.createMemory(persisted, "messages");
        return {
          didRespond: true,
          responseContent: persisted.content,
          responseMessages: [persisted],
          persistedResponseMessageIds: [persistedId],
          terminalFailure: {
            kind: "coding_verification_failed",
            message: "Typecheck still fails after repair.",
            transient: false,
            code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
          },
        };
      },
    );

    await runRoute("POST", SEND_PATH, state, {
      text: "fix the code",
      clientMessageId: "typed-terminal-existing-row-1",
    });

    expect(updateMemory).toHaveBeenCalled();
    expect(
      storedMemories.find((memory) => memory.id === persistedId)?.content,
    ).toMatchObject({
      failureKind: "coding_verification_failed",
      terminalFailure: {
        kind: "coding_verification_failed",
        message: "Typecheck still fails after repair.",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      },
    });
  });

  it("SSE: a retry joins the active turn and replays its durable outcome", async () => {
    const { state, handleMessage } = createHarness();
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    handleMessage.mockImplementationOnce(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await gate;
        await options?.onStreamChunk?.("joined reply");
        return {
          didRespond: true,
          responseContent: { text: "joined reply" },
          responseMessages: [],
        };
      },
    );
    const body = {
      text: "hello",
      clientMessageId: "sse-mid-turn-1",
    };
    const first = runRoute("POST", STREAM_PATH, state, body);
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const retry = runRoute("POST", STREAM_PATH, state, body);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    releaseTurn?.();
    const [firstResult, retryResult] = await Promise.all([first, retry]);
    const firstDone = parseDataFrames(firstResult.record).find(
      (frame) => frame.type === "done",
    );
    const retryDone = parseDataFrames(retryResult.record).find(
      (frame) => frame.type === "done",
    );
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(firstDone).toMatchObject({ fullText: "joined reply" });
    expect(retryDone).toMatchObject({
      fullText: "joined reply",
      messageId: firstDone?.messageId,
    });
  });

  it("SSE: a slow reconnect retry after a long completed turn is still suppressed", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "sse-long-retry-1" };
    const firstArrival = Date.now();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(firstArrival);
      const first = await runRoute("POST", STREAM_PATH, state, body);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const persistsAfterFirst = createMemory.mock.calls.length;
      expect(persistsAfterFirst).toBeGreaterThan(0);
      const firstDone = parseDataFrames(first.record).find(
        (f) => f.type === "done",
      );
      expect(firstDone?.fullText).toBe("ok");

      nowSpy.mockReturnValue(
        firstArrival +
          DEFAULT_GENERATION_TIMEOUT_MS +
          RECONNECT_WAIT_TIMEOUT_MS +
          RECONNECT_SIGNAL_DEBOUNCE_MS,
      );
      const retry = await runRoute("POST", STREAM_PATH, state, body);

      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
      const retryFrames = parseDataFrames(retry.record);
      expect(retryFrames).toHaveLength(1);
      expect(retryFrames[0]).toMatchObject({ type: "done", fullText: "ok" });
      expect(retry.record.ended).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("SSE: an aborted turn persists a zero-token interrupted receipt and the retry adopts it", async () => {
    const { state, handleMessage, createMemory, storedMemories } =
      createHarness();
    const abortError = Object.assign(new Error("client disconnected"), {
      code: "TURN_ABORTED",
    });
    handleMessage.mockImplementationOnce(async () => {
      throw abortError;
    });
    const body = { text: "hello", clientMessageId: "sse-abort-retry-1" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    // Zero-token Stop: the turn still settles with an interrupted terminal
    // receipt — a done frame carrying interrupted:true and no reply text.
    const firstDone = parseDataFrames(first.record).find(
      (f) => f.type === "done",
    );
    expect(firstDone).toMatchObject({
      type: "done",
      fullText: "",
      interrupted: true,
      messageId: expect.any(String),
    });
    // The receipt is durable: an assistant memory with content.interrupted.
    const receipt = storedMemories.find(
      (memory) =>
        memory.id === firstDone?.messageId &&
        (memory.content as { interrupted?: boolean }).interrupted === true,
    );
    expect(receipt).toBeDefined();
    expect((receipt?.content as { text?: string } | undefined)?.text).toBe("");

    const reloaded = await runRoute("GET", SEND_PATH, state, {});
    expect(reloaded.captured.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: firstDone?.messageId,
          text: "",
          interrupted: true,
        }),
      ]),
    });

    const persistsAfterAbort = createMemory.mock.calls.length;
    const hydrated = await runRoute("GET", SEND_PATH, state, {});
    expect(hydrated.captured.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: firstDone?.messageId,
          role: "assistant",
          text: "",
          interrupted: true,
        }),
      ]),
    });
    const retry = await runRoute("POST", STREAM_PATH, state, body);
    // The retried key adopts the interrupted outcome: no second generation,
    // no second persisted pair, the exact same terminal frame.
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterAbort);
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toEqual(firstDone);
  });

  it("SSE: a mid-stream abort persists the partial text on the interrupted receipt", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    const abortError = Object.assign(new Error("client stopped"), {
      code: "TURN_ABORTED",
    });
    handleMessage.mockImplementationOnce(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.("partial re");
        throw abortError;
      },
    );
    const body = { text: "hello", clientMessageId: "sse-abort-partial-1" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const firstDone = parseDataFrames(first.record).find(
      (f) => f.type === "done",
    );
    expect(firstDone).toMatchObject({
      type: "done",
      fullText: "partial re",
      interrupted: true,
      messageId: expect.any(String),
    });
    const receipt = storedMemories.find(
      (memory) => memory.id === firstDone?.messageId,
    );
    expect(receipt?.content).toMatchObject({
      text: "partial re",
      interrupted: true,
    });

    const hydrated = await runRoute("GET", SEND_PATH, state, {});
    expect(hydrated.captured.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: firstDone?.messageId,
          text: "partial re",
          interrupted: true,
        }),
      ]),
    });
    const retry = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toEqual(firstDone);
  });

  it("GET: preserves empty interrupted diagnostics beside a genuine model reply", async () => {
    const { state, handleMessage, createMemory, updateMemory, storedMemories } =
      createHarness();
    handleMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("generation cancelled"), {
        code: "TURN_ABORTED",
      });
    });
    const aborted = await runRoute("POST", STREAM_PATH, state, {
      text: "cancelled turn",
      clientMessageId: "hydrate-aborted-diagnostics",
    });
    const interruptedId = parseDataFrames(aborted.record).find(
      (frame) => frame.type === "done",
    )?.messageId;
    const receipt = storedMemories.find(
      (memory) => memory.id === interruptedId,
    );
    if (!receipt?.id)
      throw new Error("Expected a persisted interrupted receipt");
    const terminalFailure = {
      kind: "provider_issue",
      message: "Generation was interrupted during shutdown.",
      transient: true,
      code: "TURN_ABORTED",
    };
    if (!state.runtime) throw new Error("Expected the test runtime");
    await state.runtime.updateMemory({
      ...receipt,
      id: receipt.id,
      content: {
        ...receipt.content,
        failureKind: terminalFailure.kind,
        terminalFailure,
      },
    });
    const completed = await runRoute("POST", STREAM_PATH, state, {
      text: "a new turn",
      clientMessageId: "hydrate-genuine-reply",
    });
    const completedDone = parseDataFrames(completed.record).find(
      (frame) => frame.type === "done",
    );
    expect(completedDone?.fullText).toBe("ok");
    expect(completedDone?.messageId).toBeTruthy();
    const persistedBeforeRead = new Map(
      storedMemories.map((memory) => [
        memory.id,
        structuredClone(memory.content),
      ]),
    );
    const writesBeforeRead = createMemory.mock.calls.length;
    const updatesBeforeRead = updateMemory.mock.calls.length;

    const hydrated = await runRoute("GET", SEND_PATH, state, {});

    expect(hydrated.captured.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: interruptedId,
          role: "assistant",
          text: "",
          interrupted: true,
          failureKind: terminalFailure.kind,
          terminalFailure,
        }),
        expect.objectContaining({
          id: completedDone?.messageId,
          role: "assistant",
          text: completedDone?.fullText,
        }),
      ]),
    });
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(createMemory).toHaveBeenCalledTimes(writesBeforeRead);
    expect(updateMemory).toHaveBeenCalledTimes(updatesBeforeRead);
    expect(
      new Map(storedMemories.map((memory) => [memory.id, memory.content])),
    ).toEqual(persistedBeforeRead);
  });

  it("SSE: a persisted interrupted receipt survives outcome-marker settlement failure and restart", async () => {
    const { state, handleMessage, updateMemory, createMemory, storedMemories } =
      createHarness({ failOutcomeSettlementOnce: true });
    const abortError = Object.assign(new Error("client stopped"), {
      code: "TURN_ABORTED",
    });
    handleMessage.mockImplementationOnce(async () => {
      throw abortError;
    });
    const body = {
      text: "hello",
      clientMessageId: "sse-abort-settlement-failure-1",
    };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    const firstDone = parseDataFrames(first.record).find(
      (frame) => frame.type === "done",
    );
    expect(firstDone).toMatchObject({
      type: "done",
      fullText: "",
      interrupted: true,
      messageId: expect.any(String),
    });
    expect(updateMemory).toHaveBeenCalledTimes(1);
    const receipt = storedMemories.find(
      (memory) => memory.id === firstDone?.messageId,
    );
    expect(receipt?.content).toMatchObject({ interrupted: true, text: "" });
    const persistsAfterAbort = createMemory.mock.calls.length;

    // Simulate a fresh process: the failed outcome marker is absent, so
    // recovery must reconstruct the exact terminal from the durable receipt.
    resetChatDedupe();
    const retry = await runRoute("POST", STREAM_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterAbort);
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toEqual(firstDone);
    expect(updateMemory.mock.calls.length).toBeGreaterThan(1);
  });

  it("SSE: a typed terminal failure survives outcome-marker settlement failure and restart", async () => {
    const { state, handleMessage, updateMemory, createMemory, storedMemories } =
      createHarness({ failOutcomeSettlementOnce: true });
    handleMessage.mockImplementationOnce(
      async (_runtime: unknown, _message: unknown, callback: unknown) => {
        await (
          callback as ((content: { text: string }) => Promise<void>) | undefined
        )?.({ text: "Done." });
        return {
          didRespond: true,
          responseContent: null,
          responseMessages: [],
          terminalFailure: {
            kind: "coding_verification_failed",
            message: "Typecheck still fails after repair.",
            transient: false,
            code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
          },
          mode: "actions" as const,
        };
      },
    );
    const body = {
      text: "fix the code",
      clientMessageId: "typed-failure-settlement-restart-1",
    };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    const firstDone = parseDataFrames(first.record).find(
      (frame) => frame.type === "done",
    );
    expect(firstDone).toMatchObject({
      type: "done",
      fullText: "Typecheck still fails after repair.",
      failureKind: "coding_verification_failed",
      terminalFailure: {
        kind: "coding_verification_failed",
        message: "Typecheck still fails after repair.",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      },
      messageId: expect.any(String),
    });
    const receipt = storedMemories.find(
      (memory) => memory.id === firstDone?.messageId,
    );
    expect(receipt?.content).toMatchObject({
      failureKind: "coding_verification_failed",
      terminalFailure: {
        kind: "coding_verification_failed",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      },
    });
    const persistsAfterFailure = createMemory.mock.calls.length;

    resetChatDedupe();
    const retry = await runRoute("POST", STREAM_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFailure);
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toMatchObject({
      type: "done",
      fullText: "Typecheck still fails after repair.",
      failureKind: "coding_verification_failed",
      terminalFailure: {
        kind: "coding_verification_failed",
        message: "Typecheck still fails after repair.",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      },
      messageId: firstDone?.messageId,
      userMessageId: firstDone?.userMessageId,
    });
    expect(updateMemory.mock.calls.length).toBeGreaterThan(1);
  });

  it("SSE: a completed turn survives transport disconnect and the retry replays it", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    handleMessage.mockImplementationOnce(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.("durable reply");
        await turnGate;
        return {
          didRespond: true,
          responseContent: { text: "durable reply" },
          responseMessages: [],
        };
      },
    );
    const body = {
      text: "finish even if my socket drops",
      clientMessageId: "disconnect-after-model-1",
    };

    await runRoute("POST", STREAM_PATH, state, body, async (req) => {
      expect(handleMessage).toHaveBeenCalledTimes(1);
      req.emit("aborted");
      releaseTurn?.();
    });
    const persistsAfterDisconnect = createMemory.mock.calls.length;
    expect(persistsAfterDisconnect).toBeGreaterThan(0);

    const retry = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterDisconnect);
    expect(parseDataFrames(retry.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: "durable reply",
        messageId: expect.any(String),
      }),
    ]);
  });

  it.each([
    { failure: "transport abort", abortTransport: true },
    { failure: "message-service exception", abortTransport: false },
  ])(
    "SSE: a receipt-backed planner action survives a post-commit $failure",
    async ({ failure, abortTransport }) => {
      const { state, handleMessage, emitEvent, createMemory } = createHarness();
      let releaseAfterCommit: (() => void) | undefined;
      const afterCommitGate = new Promise<void>((resolve) => {
        releaseAfterCommit = resolve;
      });
      let notifyCommitted: (() => void) | undefined;
      const committed = new Promise<void>((resolve) => {
        notifyCommitted = resolve;
      });
      const receipt: EffectReceipt = {
        receiptId: `receipt-post-commit-${failure}`,
        operation: "test.reminder.create",
        resource: { kind: "test.reminder", id: "reminder-1" },
        artifacts: [],
        outcome: "applied",
        idempotency: {
          key: `conversation-post-commit-${failure}`,
          replayed: false,
        },
        observedAt: "2026-07-31T19:00:00.000Z",
        commit: {
          kind: "durable",
          id: "reminder-1",
          committedAt: "2026-07-31T19:00:00.000Z",
        },
      };
      const actionText = "Reminder created for 9:00 AM.";
      const actionHandler = vi.fn(
        async (
          _runtime: unknown,
          _message: unknown,
          _state: unknown,
          _options: unknown,
          callback?: (content: { text: string }) => Promise<unknown>,
        ) => {
          await callback?.({ text: actionText });
          return {
            success: true,
            text: actionText,
            userFacingText: actionText,
            verifiedUserFacing: true,
            effectReceipts: [receipt],
            userFacingEffectReceiptIds: [receipt.receiptId],
          };
        },
      );
      const action: Action = {
        name: "CREATE_REMINDER",
        description: "Create a reminder.",
        similes: [],
        examples: [],
        tags: ["capability:schedule", "effect:receipt-required"],
        validate: async () => true,
        handler: actionHandler as Action["handler"],
      };
      (state.runtime as AgentRuntime).actions.push(action);

      handleMessage.mockImplementation(
        async (
          runtime: AgentRuntime,
          message: Memory,
          callback: Parameters<Action["handler"]>[4],
          options?: {
            abortSignal?: AbortSignal;
            onSettledActionResult?: (result: unknown) => void;
            onTrajectoryTerminalOwner?: (owner: "run") => void;
          },
        ) => {
          options?.onTrajectoryTerminalOwner?.("run");
          await executePlannedToolCall(
            runtime,
            {
              message,
              state: { values: {}, data: {}, text: "" },
              userRoles: ["OWNER"],
              activeContexts: ["general"],
              callback,
            },
            { name: action.name, params: {} },
            {
              actions: [action],
              abortSignal: options?.abortSignal,
              onSettledResult: options?.onSettledActionResult,
            },
          );
          notifyCommitted?.();
          await afterCommitGate;
          if (abortTransport) options?.abortSignal?.throwIfAborted();
          throw new Error("message service stopped after action settlement");
        },
      );
      const body = {
        text: "remind me at 9",
        clientMessageId: `planner-action-post-commit-${failure}`,
      };

      await runRoute("POST", STREAM_PATH, state, body, async (req) => {
        await committed;
        if (abortTransport) req.emit("aborted");
        releaseAfterCommit?.();
      });
      const persistsAfterDisconnect = createMemory.mock.calls.length;

      if (!abortTransport) {
        const messageSentPayloads = emitEvent.mock.calls
          .filter(([event]) => event === "MESSAGE_SENT")
          .map(([, payload]) => payload as Record<string, unknown>);
        expect(messageSentPayloads).toContainEqual(
          expect.objectContaining({ trajectoryTerminalOwner: "run" }),
        );
      }

      const retry = await runRoute("POST", STREAM_PATH, state, body);
      expect(actionHandler).toHaveBeenCalledTimes(1);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(createMemory).toHaveBeenCalledTimes(persistsAfterDisconnect);
      expect(parseDataFrames(retry.record)).toEqual([
        expect.objectContaining({
          type: "done",
          fullText: actionText,
          messageId: expect.any(String),
        }),
      ]);
    },
  );

  it("SSE: a late disconnect binds a safe outcome without starting fallback actions", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const fallbackHandler = vi.fn(async () => ({
      success: true,
      text: "Block started.",
    }));
    (state.runtime as AgentRuntime).actions.push({
      name: "BLOCK",
      description: "Start a website block.",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: fallbackHandler,
    } satisfies Action);
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    handleMessage.mockImplementationOnce(async () => {
      await turnGate;
      return {
        didRespond: true,
        responseContent: {
          text: "Starting the block now.",
          actions: ["BLOCK"],
        },
        responseMessages: [],
      };
    });
    const body = {
      text: "block distractions",
      clientMessageId: "disconnect-before-fallback-1",
    };
    const safeOutcome = [
      "I could not complete that request because the model returned actions that were not executed.",
      "Unexecuted actions: BLOCK.",
      "No side effects were applied.",
    ].join("\n");

    await runRoute("POST", STREAM_PATH, state, body, (req) => {
      req.emit("aborted");
      releaseTurn?.();
    });
    const persistsAfterDisconnect = createMemory.mock.calls.length;

    expect(fallbackHandler).not.toHaveBeenCalled();
    expect(persistsAfterDisconnect).toBeGreaterThan(0);

    const retry = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(fallbackHandler).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterDisconnect);
    expect(parseDataFrames(retry.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: safeOutcome,
        messageId: expect.any(String),
      }),
    ]);
  });

  it("SSE: terminal setup retries, while an incomplete persisted turn finalizes safely", async () => {
    const { state, handleMessage, createMemory, storedMemories } =
      createHarness();
    const body = { text: "retry me", clientMessageId: "terminal-retry-1" };
    const runtime = state.runtime;
    state.runtime = null;

    const unavailable = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(unavailable.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);

    state.runtime = runtime;
    const persistImpl = createMemory.getMockImplementation();
    if (!persistImpl)
      throw new Error("createMemory fixture lost implementation");
    let rejectAssistantWrites = true;
    createMemory.mockImplementation(async (memory: Memory) => {
      if (rejectAssistantWrites && memory.entityId === AGENT_ID) {
        throw new Error("assistant persistence unavailable");
      }
      return await (persistImpl as (value: Memory) => Promise<unknown>)(memory);
    });

    const persistenceFailure = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(persistenceFailure.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);
    rejectAssistantWrites = false;

    const recovered = await runRoute("POST", STREAM_PATH, state, body);
    const recoveredDone = parseDataFrames(recovered.record).find(
      (frame) => frame.type === "done",
    );
    expect(recoveredDone).toMatchObject({
      fullText: INCOMPLETE_RECOVERY_TEXT,
    });
    expect(recoveredDone?.messageId).toBeTruthy();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(
      storedMemories.filter((memory) => memory.entityId === USER_ID),
    ).toHaveLength(1);
  });

  it("SSE: a room-initialization failure releases the key for recovery", async () => {
    const { state, handleMessage } = createHarness();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.ensureConnection).mockRejectedValueOnce(
      new Error("room setup unavailable"),
    );
    const body = { text: "retry room setup", clientMessageId: "room-retry-1" };

    const failed = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    const recovered = await runRoute("POST", STREAM_PATH, state, body);

    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: "ok" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("SSE: a user-write failure releases the key for recovery", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    createMemory.mockRejectedValueOnce(new Error("user write unavailable"));
    const body = { text: "retry user write", clientMessageId: "user-retry-1" };

    const failed = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    const recovered = await runRoute("POST", STREAM_PATH, state, body);

    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: "ok" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a released key is retried with a different user payload", async () => {
    const { state, handleMessage, createMemory, storedMemories } =
      createHarness();
    const createImpl = createMemory.getMockImplementation();
    if (!createImpl)
      throw new Error("createMemory fixture lost implementation");
    let rejectAssistantWrite = true;
    createMemory.mockImplementation(async (memory: Memory) => {
      if (rejectAssistantWrite && memory.entityId === AGENT_ID) {
        throw new Error("assistant persistence unavailable");
      }
      return await (createImpl as (value: Memory) => Promise<unknown>)(memory);
    });
    const clientMessageId = "changed-payload-retry";

    const failed = await runRoute("POST", STREAM_PATH, state, {
      text: "original payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);

    rejectAssistantWrite = false;
    const conflicting = await runRoute("POST", STREAM_PATH, state, {
      text: "different payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(conflicting.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);

    const recovered = await runRoute("POST", STREAM_PATH, state, {
      text: "original payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: INCOMPLETE_RECOVERY_TEXT });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(
      storedMemories.filter((memory) => memory.entityId === USER_ID),
    ).toHaveLength(1);
  });

  it("SSE: a neighboring successful turn cannot suppress this turn's failure fallback", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    let releaseFailedTurn: (() => void) | undefined;
    const failedTurnGate = new Promise<void>((resolve) => {
      releaseFailedTurn = resolve;
    });
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        message: { content?: { text?: string } },
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        if (message.content?.text === "turn a fails") {
          await failedTurnGate;
          throw new Error("turn a provider failure");
        }
        await options?.onStreamChunk?.("turn b reply");
        return {
          didRespond: true,
          responseContent: { text: "turn b reply" },
          responseMessages: [],
        };
      },
    );

    const failedTurn = runRoute("POST", STREAM_PATH, state, {
      text: "turn a fails",
      clientMessageId: "interleaved-failed-a",
    });
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const successfulTurn = runRoute("POST", STREAM_PATH, state, {
      text: "turn b succeeds",
      clientMessageId: "interleaved-success-b",
    });
    await vi.waitFor(() =>
      expect(
        (state.runtime as AgentRuntime).roomHandlerQueue.pendingFor(ROOM_ID),
      ).toBe(2),
    );
    expect(handleMessage).toHaveBeenCalledTimes(1);
    releaseFailedTurn?.();
    const failedResult = await failedTurn;
    const successfulResult = await successfulTurn;

    const successfulDone = parseDataFrames(successfulResult.record).find(
      (frame) => frame.type === "done",
    );
    const failedDone = parseDataFrames(failedResult.record).find(
      (frame) => frame.type === "done",
    );
    expect(successfulDone).toMatchObject({ fullText: "turn b reply" });
    expect(failedDone?.noResponseReason).toBeUndefined();
    expect(failedDone?.fullText).toBeTruthy();
    expect(failedDone?.messageId).toBeTruthy();
    expect(failedDone?.messageId).not.toBe(successfulDone?.messageId);
    expect(
      storedMemories.some(
        (memory) =>
          memory.id === failedDone?.messageId &&
          (memory.content as { text?: string }).text === failedDone?.fullText,
      ),
    ).toBe(true);

    const retry = await runRoute("POST", STREAM_PATH, state, {
      text: "turn a fails",
      clientMessageId: "interleaved-failed-a",
    });
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toMatchObject({
      fullText: failedDone?.fullText,
      messageId: failedDone?.messageId,
    });
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("SSE: rapid identical post-token failures each persist and advertise their own row", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.("partial reply");
        throw new Error("planner failed after token");
      },
    );

    const first = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "post-token-a",
    });
    const second = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "post-token-b",
    });
    const doneFrames = [first, second].map(({ record }) =>
      parseDataFrames(record).find((frame) => frame.type === "done"),
    );

    expect(doneFrames[0]).toMatchObject({ fullText: "partial reply" });
    expect(doneFrames[1]).toMatchObject({ fullText: "partial reply" });
    expect(doneFrames[0]?.messageId).toBeTruthy();
    expect(doneFrames[1]?.messageId).toBeTruthy();
    expect(doneFrames[0]?.messageId).not.toBe(doneFrames[1]?.messageId);
    for (const done of doneFrames) {
      expect(
        storedMemories.some(
          (memory) =>
            memory.id === done?.messageId &&
            (memory.content as { text?: string }).text === "partial reply",
        ),
      ).toBe(true);
    }
  });

  it("rapid identical model replies persist distinct rows on stream and JSON routes", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    const modelReply = "Your wallet address is available in Wallet.";
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.(modelReply);
        return {
          didRespond: true,
          responseContent: { text: modelReply },
          responseMessages: [],
        };
      },
    );
    const requests = [
      [STREAM_PATH, "wallet-stream-a"],
      [STREAM_PATH, "wallet-stream-b"],
      [SEND_PATH, "wallet-json-a"],
      [SEND_PATH, "wallet-json-b"],
    ] as const;
    const messageIds: string[] = [];

    for (const [pathname, clientMessageId] of requests) {
      const result = await runRoute("POST", pathname, state, {
        text: "what is my wallet address?",
        clientMessageId,
      });
      if (pathname === STREAM_PATH) {
        const done = parseDataFrames(result.record).find(
          (frame) => frame.type === "done",
        );
        expect(done?.fullText).toBe(modelReply);
        expect(done?.messageId).toBeTruthy();
        messageIds.push(String(done?.messageId));
      } else {
        const payload = result.captured.payload as {
          text?: string;
          messageId?: string;
        };
        expect(payload.text).toBe(modelReply);
        expect(payload.messageId).toBeTruthy();
        messageIds.push(String(payload.messageId));
      }
    }

    expect(handleMessage).toHaveBeenCalledTimes(requests.length);
    expect(new Set(messageIds)).toHaveProperty("size", 4);
    for (const messageId of messageIds) {
      expect(
        storedMemories.some(
          (memory) =>
            memory.id === messageId &&
            memory.entityId === AGENT_ID &&
            memory.content.text === modelReply,
        ),
      ).toBe(true);
    }
  });

  it("SSE: sends without a clientMessageId are never deduped", async () => {
    const { state, handleMessage } = createHarness();
    const body = { text: "hello" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    const second = await runRoute("POST", STREAM_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(2);
    for (const { record } of [first, second]) {
      const doneFrame = parseDataFrames(record).find((f) => f.type === "done");
      expect(doneFrame?.fullText).toBe("ok");
    }
  });

  it("non-stream: first send runs the turn; a retry after delivery returns the persisted first reply", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "json-retry-1" };

    const first = await runRoute("POST", SEND_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const persistsAfterFirst = createMemory.mock.calls.length;
    expect(persistsAfterFirst).toBeGreaterThan(0);
    expect(first.captured.payload).toMatchObject({ text: "ok" });

    const second = await runRoute("POST", SEND_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
    // The first attempt's reply already persisted — the retry answers with
    // the normal success shape carrying that reply, not the empty ignored
    // shape, so the already-delivered turn reads identically on both attempts.
    expect(second.captured.payload).toMatchObject({
      text: "ok",
      agentName: "Test Agent",
      messageId: expect.any(String),
    });
  });

  it("non-stream: a retry joins the active turn instead of fabricating ignored success", async () => {
    const { state, handleMessage } = createHarness();
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    handleMessage.mockImplementationOnce(async () => {
      await gate;
      return {
        didRespond: true,
        responseContent: { text: "joined JSON reply" },
        responseMessages: [],
      };
    });
    const body = {
      text: "hello",
      clientMessageId: "json-mid-turn-1",
    };
    const first = runRoute("POST", SEND_PATH, state, body);
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const retry = runRoute("POST", SEND_PATH, state, body);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    releaseTurn?.();
    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(firstResult.captured.payload).toMatchObject({
      text: "joined JSON reply",
      messageId: expect.any(String),
    });
    expect(retryResult.captured.payload).toMatchObject({
      text: "joined JSON reply",
      messageId: (firstResult.captured.payload as { messageId: string })
        .messageId,
    });
  });

  it("non-stream: sends without a clientMessageId are never deduped", async () => {
    const { state, handleMessage } = createHarness();
    const body = { text: "hello" };

    const first = await runRoute("POST", SEND_PATH, state, body);
    const second = await runRoute("POST", SEND_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(first.captured.payload).toMatchObject({ text: "ok" });
    expect(second.captured.payload).toMatchObject({ text: "ok" });
  });

  it("distinct clientMessageIds in the same conversation both run", async () => {
    const { state, handleMessage } = createHarness();

    await runRoute("POST", SEND_PATH, state, {
      text: "hello",
      clientMessageId: "distinct-a",
    });
    await runRoute("POST", SEND_PATH, state, {
      text: "hello",
      clientMessageId: "distinct-b",
    });

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("a retry that lands on the non-stream twin of a streamed send is still suppressed", async () => {
    // Both handlers consult the SAME cache scoped by conversation room id, so
    // a duplicate is caught regardless of which endpoint the retry hits — and
    // the delivered first reply is returned across the endpoint boundary too.
    const { state, handleMessage } = createHarness();
    const body = { text: "hello", clientMessageId: "cross-route-1" };

    await runRoute("POST", STREAM_PATH, state, body);
    const retry = await runRoute("POST", SEND_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(retry.captured.payload).toMatchObject({
      text: "ok",
      agentName: "Test Agent",
      messageId: expect.any(String),
    });
  });
});

describe("conversation handoff import — exact source identities", () => {
  it("idempotently appends only newly observed Shared messages", async () => {
    const { state, storedMemories } = createHarness();
    const firstMessages = [
      { sourceId: "shared-u1", role: "user", text: "hello", timestamp: 10 },
      {
        sourceId: "shared-a1",
        role: "assistant",
        text: "hello back",
        timestamp: 20,
      },
    ];

    const first = await runRoute(
      "POST",
      "/api/conversations/conv-1/import",
      state,
      { messages: firstMessages },
    );
    expect(first.captured.payload).toMatchObject({
      complete: true,
      sourceMessageCount: 2,
      inserted: 2,
      skipped: 0,
    });

    const retry = await runRoute(
      "POST",
      "/api/conversations/conv-1/import",
      state,
      {
        messages: [
          ...firstMessages,
          {
            sourceId: "shared-u2",
            role: "user",
            text: "one more thing",
            timestamp: 30,
          },
        ],
      },
    );
    expect(retry.captured.payload).toMatchObject({
      complete: true,
      sourceMessageCount: 3,
      inserted: 1,
      skipped: 2,
    });
    expect(storedMemories).toHaveLength(3);
    expect(storedMemories.map((memory) => memory.content.text)).toEqual([
      "hello",
      "hello back",
      "one more thing",
    ]);
  });

  it("imports exact Shared reminders with the same cutover receipt", async () => {
    const {
      state,
      storedMemories,
      importScheduledTask,
      activateScheduledTask,
    } = createHarness({ scheduling: true });
    const todoSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [],
      mutations: [],
    });
    const body = {
      messages: [
        {
          sourceId: "shared-u1",
          role: "user",
          text: "remind me",
          timestamp: 10,
        },
      ],
      scheduledTasks: [
        {
          taskId: "shared-reminder-1",
          kind: "reminder",
          promptInstructions: "call mom",
          trigger: { kind: "once", atIso: "2026-08-15T17:00:00.000Z" },
          priority: "medium",
          respectsGlobalPause: true,
          state: { status: "scheduled", followupCount: 0 },
          source: "user_chat",
          createdBy: "owner",
          ownerVisible: true,
        },
      ],
      cutoverToken: "personal-cutover-token",
      todoSnapshot,
    };

    const first = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      state,
      body,
    );
    expect(first.captured.payload).toMatchObject({
      complete: true,
      sourceMessageCount: 1,
      inserted: 1,
      sourceScheduledTaskCount: 1,
      importedScheduledTasks: 1,
      skippedScheduledTasks: 0,
      activatedScheduledTasks: 0,
      sourceTodoCount: 0,
      sourceTodoMutationCount: 0,
      importedTodoMutations: 0,
      skippedTodoMutations: 0,
      sourceTodoDigest: todoSnapshot.digest,
      targetTodoDigest: todoSnapshot.digest,
    });

    const replay = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      state,
      body,
    );
    expect(replay.captured.payload).toMatchObject({
      complete: true,
      inserted: 0,
      skipped: 1,
      importedScheduledTasks: 0,
      skippedScheduledTasks: 1,
      activatedScheduledTasks: 0,
    });
    const activated = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      state,
      { ...body, activateScheduledTasks: true },
    );
    expect(activated.captured.payload).toMatchObject({
      complete: true,
      importedScheduledTasks: 0,
      skippedScheduledTasks: 1,
      activatedScheduledTasks: 1,
      skippedActivatedScheduledTasks: 0,
    });
    expect(storedMemories).toHaveLength(1);
    expect(importScheduledTask).toHaveBeenCalledTimes(3);
    expect(activateScheduledTask).toHaveBeenCalledTimes(1);
    expect(importScheduledTask.mock.calls[0]?.[1]).toEqual({
      sourceAgentId: "personal:source",
      cutoverToken: "personal-cutover-token",
    });
  });

  it("rejects an exact cutover token when the Todo snapshot is missing", async () => {
    const { state, storedMemories } = createHarness({ scheduling: true });
    const response = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      state,
      {
        messages: [{ sourceId: "shared-u1", role: "user", text: "hello" }],
        cutoverToken: "personal-cutover-token",
      },
    );

    expect(response.record.writes.join("")).toContain(
      "error 400: A todoSnapshot is required",
    );
    expect(storedMemories).toHaveLength(0);
  });

  it("rejects tampered or cross-conversation Todo snapshots before any write", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [],
      mutations: [],
    });
    const tamperedHarness = createHarness({ scheduling: true });
    const tampered = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      tamperedHarness.state,
      {
        messages: [{ sourceId: "shared-u1", role: "user", text: "hello" }],
        cutoverToken: "personal-cutover-token",
        todoSnapshot: { ...snapshot, digest: "0".repeat(64) },
      },
    );
    expect(tampered.record.writes.join("")).toContain(
      "error 400: Todo snapshot digest does not match its records",
    );
    expect(tamperedHarness.storedMemories).toHaveLength(0);

    const wrongSourceSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:other",
      todos: [],
      mutations: [],
    });
    const wrongSourceHarness = createHarness({ scheduling: true });
    const wrongSource = await runRoute(
      "POST",
      "/api/conversations/personal:source/import",
      wrongSourceHarness.state,
      {
        messages: [{ sourceId: "shared-u1", role: "user", text: "hello" }],
        cutoverToken: "personal-cutover-token",
        todoSnapshot: wrongSourceSnapshot,
      },
    );
    expect(wrongSource.record.writes.join("")).toContain(
      "error 400: Todo snapshot source does not match the conversation",
    );
    expect(wrongSourceHarness.storedMemories).toHaveLength(0);
  });
});
