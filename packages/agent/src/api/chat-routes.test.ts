/**
 * Covers the exported chat-routes surface: OpenAI/Anthropic/agent-message
 * dispatch, client-message-id admission, request parsing, persistence,
 * failure classification, and the token/SSE writers. Drives the real module
 * with in-memory runtimes and response stand-ins — no live model.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  ElizaError,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { LogEntry } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config";
import {
  __getChatDedupeTtlMsForTests,
  __resetChatDedupeForTests,
  admitChatMessageId,
  type ChatGenerationResult,
  ChatIdempotencyWaitAbortedError,
  type ChatRouteContext,
  type ChatRouteState,
  classifyChatFailure,
  compareAssistantTurnRecencyDescending,
  compareCreatedAtAscending,
  createChatTokenStreamWriter,
  DELTA_STREAM_PROTOCOL,
  detectLocalInferenceCommandIntent,
  generateChatResponse,
  generateConversationTitle,
  getChatFailureReply,
  getChatMessageIdFirstSeenAt,
  getChatMessageIdOutcome,
  getRecentVisibleAssistantMemorySince,
  handleChatRoutes,
  hasRecentVisibleAssistantMemorySince,
  initSse,
  isChatGenerationTimeoutError,
  isLocalInferenceError,
  markSyntheticChatFailureContent,
  normalizeAccountConnectRequest,
  normalizeChatResponseText,
  persistAssistantConversationMemory,
  persistConversationMemory,
  persistExactConversationMemoryResult,
  persistInterruptedAssistantReceipt,
  persistUnpersistedChatReply,
  readChatRequestPayload,
  releaseChatMessageId,
  renderChatSurfaceText,
  resolveChatAdminEntityId,
  resolveNoResponseFallback,
  resolveTrustedApiPrincipal,
  setChatMessageIdOutcome,
  writeSse,
  writeSseData,
  writeSseJson,
} from "./chat-routes";

const AGENT_ID = stringToUuid("chat-routes-agent");
const ROOM_ID = stringToUuid("chat-routes-room");
const USER_ID = stringToUuid("chat-routes-user");
const TTL_MS = __getChatDedupeTtlMsForTests();

afterEach(() => {
  __resetChatDedupeForTests();
});

function makeReq(headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  const socket = new EventEmitter();
  return Object.assign(new EventEmitter(), {
    headers,
    aborted: false,
    destroyed: false,
    socket,
  }) as unknown as http.IncomingMessage;
}

function makeRes(): {
  res: http.ServerResponse;
  writes: string[];
} {
  const writes: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    statusCode: 200,
    writeHead: vi.fn(function writeHead(this: { headersSent: boolean }) {
      this.headersSent = true;
    }),
    setHeader: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) writes.push(String(chunk));
      (res as { writableEnded: boolean }).writableEnded = true;
    }),
  });
  return { res: res as unknown as http.ServerResponse, writes };
}

function makeState(overrides: Partial<ChatRouteState> = {}): ChatRouteState {
  return {
    runtime: null,
    config: { agents: { defaults: {} } } as ElizaConfig,
    agentName: "Eliza",
    logBuffer: [],
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    adminEntityId: null,
    ...overrides,
  };
}

function makeCtx(
  method: string,
  pathname: string,
  options: {
    state?: ChatRouteState;
    body?: Record<string, unknown> | null;
    headers?: http.IncomingHttpHeaders;
    authorization?: ChatRouteContext["callerAuthorization"];
  } = {},
) {
  const { res, writes } = makeRes();
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn(
    async () => options.body as Record<string, unknown> | null,
  );
  const ctx: ChatRouteContext = {
    req: makeReq(options.headers),
    res,
    method,
    pathname,
    state: options.state ?? makeState(),
    json,
    error,
    readJsonBody: readJsonBody as ChatRouteContext["readJsonBody"],
    callerAuthorization: options.authorization,
  };
  return { ctx, json, error, res, writes, readJsonBody };
}

function jsonBody(value: object | null): ChatRouteContext["readJsonBody"] {
  return (async () => value) as ChatRouteContext["readJsonBody"];
}

function creditsLog(ageMs = 0): LogEntry {
  return {
    timestamp: Date.now() - ageMs,
    level: "error",
    message: "provider out of credits",
    source: "test",
    tags: [],
  };
}

function makeRuntime(
  overrides: Partial<{
    memories: Memory[];
    createMemory: AgentRuntime["createMemory"];
    getMemories: AgentRuntime["getMemories"];
    useModel: () => Promise<string>;
    characterName: string;
  }> = {},
): AgentRuntime {
  const memories = overrides.memories ?? [];
  return {
    agentId: AGENT_ID,
    character: { name: overrides.characterName ?? "Eliza" },
    createMemory:
      overrides.createMemory ??
      (async (memory: Memory) => {
        memories.push(memory);
        return memory;
      }),
    getMemoriesByIds: async (ids: UUID[]) =>
      memories.filter((memory) => memory.id && ids.includes(memory.id as UUID)),
    getMemories:
      overrides.getMemories ??
      (async ({ roomId }: { roomId: UUID }) =>
        memories.filter((memory) => memory.roomId === roomId)),
    ensureConnection: async () => undefined,
    getWorld: async () => null,
    updateWorld: async () => undefined,
    getSetting: () => null,
    getService: () => null,
    useModel: (overrides.useModel ??
      (async () => "Chat Title")) as AgentRuntime["useModel"],
    roomHandlerQueue: {
      currentLease: () => null,
      ownsLease: () => false,
      withLease: async (
        _room: UUID,
        run: (lease: { id: string }) => Promise<unknown>,
      ) => run({ id: "lease" }),
      runInLease: async (
        _room: UUID,
        _lease: unknown,
        run: () => Promise<unknown>,
      ) => run(),
    },
  } as unknown as AgentRuntime;
}

describe("handleChatRoutes", () => {
  it("returns false for an unmatched path", async () => {
    const { ctx, json } = makeCtx("GET", "/not-a-chat-route");
    await expect(handleChatRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("lists unique OpenAI-compat models, including a distinct runtime name", async () => {
    const state = makeState({
      agentName: "Desk",
      runtime: makeRuntime({ characterName: "Operator" }),
    });
    const { ctx, json } = makeCtx("GET", "/v1/models", { state });

    await expect(handleChatRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][1] as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(payload.object).toBe("list");
    expect(payload.data.map((row) => row.id).sort()).toEqual(
      ["Desk", "Operator", "eliza"].sort(),
    );
    expect(payload.data.every((row) => row.owned_by === "eliza")).toBe(true);
  });

  it("omits a blank agentName from the model list", async () => {
    const { ctx, json } = makeCtx("GET", "/v1/models", {
      state: makeState({ agentName: "   " }),
    });
    await handleChatRoutes(ctx);
    const payload = json.mock.calls[0][1] as { data: Array<{ id: string }> };
    expect(payload.data.map((row) => row.id)).toEqual(["eliza"]);
  });

  it("returns a single OpenAI-compat model by id", async () => {
    const { ctx, json } = makeCtx("GET", "/v1/models/gpt-eliza");
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        id: "gpt-eliza",
        object: "model",
        owned_by: "eliza",
      }),
    );
  });

  it("400s a whitespace-only model id after decode", async () => {
    const { ctx, json } = makeCtx("GET", "/v1/models/%20");
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Model id is required",
          type: "invalid_request_error",
        }),
      }),
      400,
    );
  });

  it("stops OpenAI completions when the body reader already responded", async () => {
    const { ctx, json, readJsonBody } = makeCtx(
      "POST",
      "/v1/chat/completions",
      { body: null },
    );
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(readJsonBody).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an OpenAI body that carries a blocked object key", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/chat/completions", {
      body: {
        $include: "../secret",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Request body contains a blocked object key",
          type: "invalid_request_error",
        }),
      }),
      400,
    );
  });

  it("rejects OpenAI completions with no user message", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "system", content: "only system" }] },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          type: "invalid_request_error",
          message: expect.stringContaining("at least one user message"),
        }),
      }),
      400,
    );
  });

  it("503s non-streaming OpenAI completions when the agent is not running", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hello" }] },
    });
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Agent is not running",
          type: "service_unavailable",
        }),
      }),
      503,
    );
  });

  it("streams an OpenAI service-unavailable error when the agent is down", async () => {
    const { ctx, json, writes, res } = makeCtx("POST", "/v1/chat/completions", {
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
    });
    await expect(handleChatRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalled();
    const wire = writes.join("");
    expect(wire).toContain("service_unavailable");
    expect(wire).toContain("[DONE]");
    expect((res as { writableEnded: boolean }).writableEnded).toBe(true);
  });

  it("rejects an Anthropic body with no user message", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/messages", {
      body: { messages: [] },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          type: "invalid_request_error",
          message: expect.stringContaining("at least one user message"),
        }),
      }),
      400,
    );
  });

  it("503s non-streaming Anthropic messages when the agent is not running", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/messages", {
      body: { messages: [{ role: "user", content: "hello" }] },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        error: expect.objectContaining({
          type: "service_unavailable",
          message: "Agent is not running",
        }),
      }),
      503,
    );
  });

  it("rejects an Anthropic body that carries a blocked object key", async () => {
    const { ctx, json } = makeCtx("POST", "/v1/messages", {
      body: {
        constructor: { name: "x" },
        messages: [{ role: "user", content: "hi" }],
      },
    });
    await handleChatRoutes(ctx);
    expect(json.mock.calls[0][2]).toBe(400);
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Request body contains a blocked object key",
        }),
      }),
    );
  });

  it("503s the agent-message mirror when the runtime is down", async () => {
    const { ctx, json } = makeCtx("POST", `/api/agents/${AGENT_ID}/message`, {
      body: { userId: "user-1", text: "hi" },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "Agent is not running" },
      503,
    );
  });

  it("404s the agent-message mirror for a different agent id", async () => {
    const other = stringToUuid("other-agent");
    const { ctx, json } = makeCtx("POST", `/api/agents/${other}/message`, {
      state: makeState({ runtime: makeRuntime() }),
      body: { userId: "user-1", text: "hi" },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "Agent not found" },
      404,
    );
  });

  it("400s the agent-message mirror when userId or text is missing", async () => {
    const { ctx, json } = makeCtx("POST", `/api/agents/${AGENT_ID}/message`, {
      state: makeState({ runtime: makeRuntime() }),
      body: { userId: "user-1", text: "   " },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "userId and text are required" },
      400,
    );
  });

  it("400s a whitespace-only agent id on the message mirror", async () => {
    const { ctx, json } = makeCtx("POST", "/api/agents/%20/message");
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "agent id is required" },
      400,
    );
  });

  it("rejects a blocked object key on the agent-message mirror", async () => {
    const { ctx, json } = makeCtx("POST", `/api/agents/${AGENT_ID}/message`, {
      state: makeState({ runtime: makeRuntime() }),
      body: { $include: "x", userId: "user-1", text: "hi" },
    });
    await handleChatRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "Request body contains a blocked object key" },
      400,
    );
  });
});

describe("admitChatMessageId / releaseChatMessageId", () => {
  it("treats a missing key as unkeyed and never records first-seen", () => {
    expect(admitChatMessageId("room-a", null)).toEqual({ kind: "unkeyed" });
    expect(getChatMessageIdFirstSeenAt("room-a", null)).toBeNull();
  });

  it("owns a fresh key, then reports duplicate while the turn is active", () => {
    const first = admitChatMessageId("room-a", "msg-1", { now: 1_000 });
    expect(first.kind).toBe("owner");
    expect(getChatMessageIdFirstSeenAt("room-a", "msg-1")).toBe(1_000);

    const second = admitChatMessageId("room-a", "msg-1", { now: 1_001 });
    expect(second.kind).toBe("duplicate");
    expect(getChatMessageIdFirstSeenAt("room-a", "msg-1")).toBe(1_000);
  });

  it("releases a missing key as a no-op and allows a later owner", () => {
    releaseChatMessageId("room-a", "never-seen");
    expect(getChatMessageIdFirstSeenAt("room-a", "never-seen")).toBeNull();

    const admitted = admitChatMessageId("room-a", "never-seen", { now: 2_000 });
    expect(admitted.kind).toBe("owner");
  });

  it("releases an owned turn so a retry can take ownership again", () => {
    const owned = admitChatMessageId("room-a", "msg-release", { now: 3_000 });
    expect(owned.kind).toBe("owner");
    if (owned.kind !== "owner") throw new Error("expected owner");
    releaseChatMessageId("room-a", "msg-release", owned.reservation);
    expect(getChatMessageIdFirstSeenAt("room-a", "msg-release")).toBeNull();

    const retry = admitChatMessageId("room-a", "msg-release", { now: 3_001 });
    expect(retry.kind).toBe("owner");
  });

  it("replays a settled outcome and conflicts on a different fingerprint", () => {
    const owned = admitChatMessageId("room-a", "msg-fp", {
      fingerprint: "hello",
      now: 4_000,
    });
    expect(owned.kind).toBe("owner");
    if (owned.kind !== "owner") throw new Error("expected owner");
    setChatMessageIdOutcome(
      "room-a",
      "msg-fp",
      { text: "ok", agentName: "Eliza" },
      owned.reservation,
    );
    expect(getChatMessageIdOutcome("room-a", "msg-fp")).toEqual({
      text: "ok",
      agentName: "Eliza",
    });

    const replay = admitChatMessageId("room-a", "msg-fp", {
      fingerprint: "hello",
      now: 4_001,
    });
    expect(replay.kind).toBe("settled");

    const conflict = admitChatMessageId("room-a", "msg-fp", {
      fingerprint: "other",
      now: 4_002,
    });
    expect(conflict.kind).toBe("conflict");
  });

  it("aborts a duplicate waiter with ChatIdempotencyWaitAbortedError", async () => {
    expect(admitChatMessageId("room-a", "msg-wait", { now: 5_000 }).kind).toBe(
      "owner",
    );
    const duplicate = admitChatMessageId("room-a", "msg-wait", { now: 5_001 });
    expect(duplicate.kind).toBe("duplicate");
    if (duplicate.kind !== "duplicate") throw new Error("expected duplicate");

    const controller = new AbortController();
    const wait = duplicate.wait(controller.signal);
    controller.abort(new Error("client gone"));
    await expect(wait).rejects.toBeInstanceOf(ChatIdempotencyWaitAbortedError);
  });

  it("lets a key be reused after the settled retention window (capacity sweep)", () => {
    const start = 6_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const owned = admitChatMessageId("room-a", "old", { now: start });
      expect(owned.kind).toBe("owner");
      if (owned.kind !== "owner") throw new Error("expected owner");
      setChatMessageIdOutcome(
        "room-a",
        "old",
        { text: "done", agentName: "Eliza" },
        owned.reservation,
      );

      nowSpy.mockReturnValue(start + TTL_MS + 1);
      const expired = admitChatMessageId("room-a", "old", {
        now: start + TTL_MS + 1,
      });
      expect(expired.kind).toBe("owner");
      expect(getChatMessageIdOutcome("room-a", "old")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("chat memory ordering comparators", () => {
  it("orders finite creation times ascending and descending", () => {
    const turns = [
      { id: "middle", createdAt: 20 },
      { id: "newest", createdAt: 30 },
      { id: "oldest", createdAt: 10 },
    ];

    expect(
      [...turns].sort(compareCreatedAtAscending).map(({ id }) => id),
    ).toEqual(["oldest", "middle", "newest"]);
    expect(
      [...turns]
        .sort(compareAssistantTurnRecencyDescending)
        .map(({ id }) => id),
    ).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks equal-timestamp ties by ascending id", () => {
    const turns = [
      { id: "turn-c", createdAt: 10 },
      { id: "turn-a", createdAt: 10 },
      { id: "turn-b", createdAt: 10 },
    ];

    expect(
      [...turns].sort(compareCreatedAtAscending).map(({ id }) => id),
    ).toEqual(["turn-a", "turn-b", "turn-c"]);
    expect(
      [...turns]
        .sort(compareAssistantTurnRecencyDescending)
        .map(({ id }) => id),
    ).toEqual(["turn-a", "turn-b", "turn-c"]);
  });

  it("treats missing and non-finite timestamps as the oldest values", () => {
    const turns = [
      { id: "infinite", createdAt: Number.POSITIVE_INFINITY },
      { id: "dated", createdAt: 1 },
      { id: "missing" },
      { id: "nan", createdAt: Number.NaN },
    ];

    expect(
      [...turns].sort(compareCreatedAtAscending).map(({ id }) => id),
    ).toEqual(["infinite", "missing", "nan", "dated"]);
    expect(
      [...turns]
        .sort(compareAssistantTurnRecencyDescending)
        .map(({ id }) => id),
    ).toEqual(["dated", "infinite", "missing", "nan"]);
  });

  it("leaves empty and single-element collections unchanged", () => {
    expect([].sort(compareCreatedAtAscending)).toEqual([]);
    expect(
      [{ id: "only", createdAt: 1 }].sort(
        compareAssistantTurnRecencyDescending,
      ),
    ).toEqual([{ id: "only", createdAt: 1 }]);
  });
});

describe("normalizeAccountConnectRequest", () => {
  it("rejects absent, array, empty, and unknown provider payloads", () => {
    expect(normalizeAccountConnectRequest(undefined)).toBeUndefined();
    expect(normalizeAccountConnectRequest([])).toBeUndefined();
    expect(normalizeAccountConnectRequest({ providers: [] })).toBeUndefined();
    expect(
      normalizeAccountConnectRequest({ providers: ["not-a-provider"] }),
    ).toBeUndefined();
  });

  it("dedupes valid providers and trims an optional reason", () => {
    expect(
      normalizeAccountConnectRequest({
        providers: ["openai-codex", "openai-codex", "anthropic-api", 1],
        reason: "  add backup  ",
      }),
    ).toEqual({
      providers: ["openai-codex", "anthropic-api"],
      reason: "add backup",
    });
  });

  it("omits a blank reason", () => {
    expect(
      normalizeAccountConnectRequest({
        providers: ["cerebras-api"],
        reason: "   ",
      }),
    ).toEqual({ providers: ["cerebras-api"] });
  });
});

describe("markSyntheticChatFailureContent / normalizeChatResponseText", () => {
  it("leaves ordinary prose untouched", () => {
    const content = { text: "hello there" } as Content;
    expect(markSyntheticChatFailureContent(content)).toBe(content);
    expect(normalizeChatResponseText("hello there", [])).toBe("hello there");
  });

  it("stamps provider-issue prose and explicit failureKind", () => {
    const stamped = markSyntheticChatFailureContent({
      text: "Sorry, I'm having a provider issue",
    } as Content);
    expect(stamped.metadata).toEqual(
      expect.objectContaining({
        elizaSyntheticFailure: true,
        chatFailureKind: "provider_issue",
      }),
    );

    const explicit = markSyntheticChatFailureContent({
      text: "custom",
      failureKind: "rate_limited",
    } as Content);
    expect(explicit.metadata).toEqual(
      expect.objectContaining({
        elizaSyntheticFailure: true,
        chatFailureKind: "rate_limited",
      }),
    );
  });

  it("reroutes a no-response placeholder through the credits-aware fallback", () => {
    expect(normalizeChatResponseText("(no response)", [])).toMatch(
      /don't have a reply/i,
    );
    expect(
      normalizeChatResponseText(
        "I don't have a reply for that — try rephrasing?",
        [creditsLog()],
      ),
    ).toMatch(/out of credits/i);
  });
});

describe("resolveNoResponseFallback / classifyChatFailure", () => {
  it("uses the generic no-response copy unless a recent credits log exists", () => {
    expect(resolveNoResponseFallback([])).toMatch(/don't have a reply/i);
    expect(resolveNoResponseFallback([creditsLog(120_000)])).toMatch(
      /don't have a reply/i,
    );
    expect(resolveNoResponseFallback([creditsLog()])).toMatch(
      /out of credits/i,
    );
  });

  it("classifies credits, no-provider, local-inference, rate-limit, and timeout", () => {
    expect(classifyChatFailure(new Error("out of credits"), [])).toBe(
      "insufficient_credits",
    );
    expect(
      classifyChatFailure(
        new Error("No provider registered for TEXT_LARGE"),
        [],
      ),
    ).toBe("no_provider");
    expect(
      classifyChatFailure(new Error("local inference GGUF load failed"), []),
    ).toBe("local_inference");
    expect(classifyChatFailure(new Error("rate limit exceeded"), [])).toBe(
      "rate_limited",
    );
    expect(
      classifyChatFailure(
        new Error("Chat generation timed out after 180000ms"),
        [],
      ),
    ).toBe("generation_timeout");
    expect(classifyChatFailure(new Error("socket closed"), [])).toBe(
      "provider_issue",
    );
  });

  it("maps the same errors onto user-facing replies", () => {
    expect(getChatFailureReply(new Error("out of credits"), [])).toMatch(
      /out of credits/i,
    );
    expect(
      getChatFailureReply(new Error("No model registered for TEXT_SMALL"), []),
    ).toMatch(/Connect an LLM provider/i);
    expect(getChatFailureReply(new Error("too many requests"), [])).toMatch(
      /rate-limited/i,
    );
    expect(
      getChatFailureReply(
        new Error("Chat generation timed out after 10ms"),
        [],
      ),
    ).toMatch(/taking too long/i);
    expect(getChatFailureReply(new Error("boom"), [])).toMatch(
      /provider issue/i,
    );
  });

  it("detects timeout errors from strings and ignores unrelated values", () => {
    expect(
      isChatGenerationTimeoutError("Chat generation timed out after 1ms"),
    ).toBe(true);
    expect(isChatGenerationTimeoutError(12)).toBe(false);
  });
});

describe("detectLocalInferenceCommandIntent / isLocalInferenceError", () => {
  it("returns null without local-inference context", () => {
    expect(detectLocalInferenceCommandIntent("")).toBeNull();
    expect(detectLocalInferenceCommandIntent("what is the weather")).toBeNull();
  });

  it("classifies routing, status, size, cancel, and download intents", () => {
    expect(detectLocalInferenceCommandIntent("switch to the cloud")).toBe(
      "use_cloud",
    );
    expect(
      detectLocalInferenceCommandIntent(
        "what is the local model download progress",
      ),
    ).toBe("status");
    expect(detectLocalInferenceCommandIntent("use local mode")).toBe(
      "use_local",
    );
    expect(
      detectLocalInferenceCommandIntent("pick a smaller model", {
        localInferenceContext: true,
      }),
    ).toBe("switch_smaller");
    expect(detectLocalInferenceCommandIntent("cancel the model download")).toBe(
      "cancel",
    );
    expect(detectLocalInferenceCommandIntent("redownload the gguf")).toBe(
      "redownload",
    );
    expect(detectLocalInferenceCommandIntent("retry the model download")).toBe(
      "retry",
    );
    expect(detectLocalInferenceCommandIntent("resume the model download")).toBe(
      "resume",
    );
    expect(detectLocalInferenceCommandIntent("download the gguf")).toBe(
      "download",
    );
  });

  it("detects local-inference errors from Error and string values", () => {
    expect(isLocalInferenceError(new Error("no local model installed"))).toBe(
      true,
    );
    expect(isLocalInferenceError("disk full while writing GGUF")).toBe(true);
    expect(isLocalInferenceError(new Error("ECONNRESET"))).toBe(false);
    expect(isLocalInferenceError(null)).toBe(false);
  });
});

describe("renderChatSurfaceText", () => {
  it("passes empty text through unchanged", () => {
    expect(renderChatSurfaceText("")).toBe("");
  });
});

describe("readChatRequestPayload", () => {
  it("requires a non-empty prompt", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    const result = await readChatRequestPayload(makeReq(), res, {
      readJsonBody: jsonBody({ text: "   " }),
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(res, "text is required");
  });

  it("rejects an invalid channelType", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    const result = await readChatRequestPayload(makeReq(), res, {
      readJsonBody: jsonBody({ text: "hi", channelType: "NOPE" }),
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(res, "channelType is invalid", 400);
  });

  it("rejects a malformed clientMessageId", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    const result = await readChatRequestPayload(makeReq(), res, {
      readJsonBody: jsonBody({
        text: "hi",
        clientMessageId: "x".repeat(129),
      }),
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(
      res,
      "clientMessageId must be a non-empty string of at most 128 characters",
      400,
    );
  });

  it("accepts a valid payload, lowercases image mime, and keeps delta-v2", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    const result = await readChatRequestPayload(
      makeReq({ "x-eliza-ui-language": "es" }),
      res,
      {
        readJsonBody: jsonBody({
          text: "hello",
          channelType: "DM",
          clientMessageId: "  msg-1  ",
          streamProtocol: DELTA_STREAM_PROTOCOL,
          source: "dashboard",
          metadata: { k: 1 },
          images: [
            {
              data: "AAAA",
              mimeType: "IMAGE/PNG",
              name: "a.png",
            },
          ],
        }),
        error,
      },
    );
    expect(error).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        prompt: "hello",
        channelType: ChannelType.DM,
        clientMessageId: "msg-1",
        streamProtocol: DELTA_STREAM_PROTOCOL,
        source: "dashboard",
        metadata: { k: 1 },
        preferredLanguage: "es",
        images: [expect.objectContaining({ mimeType: "image/png" })],
      }),
    );
  });

  it("ignores an unknown streamProtocol so legacy framing stays default", async () => {
    const { res } = makeRes();
    const result = await readChatRequestPayload(makeReq(), res, {
      readJsonBody: jsonBody({
        text: "hello",
        streamProtocol: "not-a-protocol",
      }),
      error: vi.fn(),
    });
    expect(result?.streamProtocol).toBeUndefined();
  });

  it("rejects invalid attachments before they reach generation", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    const result = await readChatRequestPayload(makeReq(), res, {
      readJsonBody: jsonBody({
        text: "hello",
        images: [{ data: "AAAA", mimeType: "application/x-evil", name: "x" }],
      }),
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(
      res,
      expect.stringContaining("Unsupported attachment type"),
      400,
    );
  });

  it("returns null when the body reader already handled the response", async () => {
    const { res } = makeRes();
    const error = vi.fn();
    await expect(
      readChatRequestPayload(makeReq(), res, {
        readJsonBody: jsonBody(null),
        error,
      }),
    ).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("persistConversationMemory / persistExactConversationMemoryResult", () => {
  it("assigns a missing id, stamps provenance, and stores the row", async () => {
    const stored: Memory[] = [];
    const runtime = makeRuntime({ memories: stored });
    const memory = createMessageMemory({
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "hi", source: "client_chat" },
    });
    const persisted = await persistConversationMemory(runtime, memory);
    expect(persisted.id).toEqual(expect.any(String));
    expect(persisted.metadata).toEqual(
      expect.objectContaining({
        type: "message",
        accountId: AGENT_ID,
        platformMessageId: persisted.id,
      }),
    );
    expect(stored).toHaveLength(1);
  });

  it("swallows a duplicate-memory error and rethrows any other failure", async () => {
    const duplicateRuntime = makeRuntime({
      createMemory: async () => {
        throw new Error("unique constraint violated");
      },
    });
    const memory = createMessageMemory({
      id: stringToUuid("dup-1"),
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "hi", source: "client_chat" },
    });
    await expect(
      persistConversationMemory(duplicateRuntime, memory),
    ).resolves.toEqual(expect.objectContaining({ id: stringToUuid("dup-1") }));

    const boomRuntime = makeRuntime({
      createMemory: async () => {
        throw new Error("disk full");
      },
    });
    await expect(
      persistConversationMemory(boomRuntime, memory),
    ).rejects.toThrow(/disk full/);
  });

  it("requires a durable id for exact writes and conflicts on different content", async () => {
    const stored: Memory[] = [];
    const runtime = makeRuntime({ memories: stored });
    const withoutId = createMessageMemory({
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "hi", source: "client_chat" },
    });
    delete (withoutId as { id?: string }).id;
    await expect(
      persistExactConversationMemoryResult(runtime, withoutId),
    ).rejects.toMatchObject({ code: "CONVERSATION_MEMORY_ID_MISSING" });

    const id = stringToUuid("exact-1");
    const first = createMessageMemory({
      id,
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "first", source: "client_chat" },
    });
    const created = await persistExactConversationMemoryResult(runtime, first);
    expect(created.created).toBe(true);

    const replay = await persistExactConversationMemoryResult(runtime, first);
    expect(replay.created).toBe(false);

    const other = createMessageMemory({
      id,
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "other", source: "client_chat" },
    });
    await expect(
      persistExactConversationMemoryResult(runtime, other),
    ).rejects.toMatchObject({ code: "CONVERSATION_MEMORY_ID_CONFLICT" });
  });

  it("wraps a failed exact write when no raced row exists", async () => {
    const runtime = makeRuntime({
      createMemory: async () => {
        throw new Error("io");
      },
    });
    const memory = createMessageMemory({
      id: stringToUuid("exact-fail"),
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "hi", source: "client_chat" },
    });
    await expect(
      persistExactConversationMemoryResult(runtime, memory),
    ).rejects.toMatchObject({ code: "CONVERSATION_MEMORY_WRITE_FAILED" });
  });
});

describe("recent visible assistant memory + interrupted receipts", () => {
  it("returns the newest visible assistant row and skips internal ones", async () => {
    const older = createMessageMemory({
      id: stringToUuid("asst-old"),
      entityId: AGENT_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "older", source: "client_chat" },
    });
    older.createdAt = 1_000;
    const internal = createMessageMemory({
      id: stringToUuid("asst-internal"),
      entityId: AGENT_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: {
        text: "hidden",
        source: "client_chat",
        transcriptVisibility: "internal",
      },
    });
    internal.createdAt = 2_000;
    const newest = createMessageMemory({
      id: stringToUuid("asst-new"),
      entityId: AGENT_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "newest", source: "client_chat" },
    });
    newest.createdAt = 3_000;
    const runtime = makeRuntime({ memories: [older, internal, newest] });

    await expect(
      getRecentVisibleAssistantMemorySince(runtime, ROOM_ID, 1_000, 0),
    ).resolves.toEqual({ id: newest.id, text: "newest" });
    await expect(
      hasRecentVisibleAssistantMemorySince(runtime, ROOM_ID, 1_000),
    ).resolves.toBe(true);
  });

  it("returns null when getMemories throws or no visible row exists", async () => {
    const throwing = makeRuntime({
      getMemories: async () => {
        throw new Error("db down");
      },
    });
    await expect(
      getRecentVisibleAssistantMemorySince(throwing, ROOM_ID, 0, 0),
    ).resolves.toBeNull();
    await expect(
      hasRecentVisibleAssistantMemorySince(
        makeRuntime({ memories: [] }),
        ROOM_ID,
        0,
      ),
    ).resolves.toBe(false);
  });

  it("refuses to persist an empty assistant reply but keeps a zero-token Stop", async () => {
    const stored: Memory[] = [];
    const runtime = makeRuntime({ memories: stored });
    await expect(
      persistAssistantConversationMemory(
        runtime,
        ROOM_ID,
        "   ",
        ChannelType.DM,
      ),
    ).resolves.toBeNull();
    expect(stored).toHaveLength(0);

    const receipt = await persistInterruptedAssistantReceipt(
      runtime,
      ROOM_ID,
      "",
      ChannelType.DM,
      undefined,
      stringToUuid("interrupted-1"),
    );
    expect(receipt.content).toEqual(
      expect.objectContaining({ text: "", interrupted: true }),
    );
    expect(stored).toHaveLength(1);
  });
});

describe("generateConversationTitle / generateChatResponse ownership", () => {
  it("does not impose a completion-token ceiling on title generation", async () => {
    let request: { maxTokens?: number } | undefined;
    const runtime = makeRuntime({
      useModel: async (...args: unknown[]) => {
        request = args[1] as { maxTokens?: number };
        return "Complete title";
      },
    });
    await expect(
      generateConversationTitle(runtime, "help me", "Eliza"),
    ).resolves.toBe("Complete title");
    expect(request?.maxTokens).toBeUndefined();
  });

  it("strips wrapping quotes and rejects empty or over-long titles", async () => {
    const quoted = makeRuntime({
      useModel: async () => '"Desk setup"',
    });
    await expect(
      generateConversationTitle(quoted, "help me", "Eliza"),
    ).resolves.toBe("Desk setup");

    const empty = makeRuntime({ useModel: async () => "   " });
    await expect(
      generateConversationTitle(empty, "help me", "Eliza"),
    ).resolves.toBeNull();

    const tooLong = makeRuntime({
      useModel: async () => "x".repeat(51),
    });
    await expect(
      generateConversationTitle(tooLong, "help me", "Eliza"),
    ).resolves.toBeNull();
  });

  it("refuses generation when the requested room lease is not owned", async () => {
    const runtime = makeRuntime();
    const message = createMessageMemory({
      id: stringToUuid("gen-1"),
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "hi", source: "client_chat" },
    });
    await expect(
      generateChatResponse(runtime, message, "Eliza", {
        roomHandlerLease: { id: "stale" } as never,
      }),
    ).rejects.toBeInstanceOf(ElizaError);
    await expect(
      generateChatResponse(runtime, message, "Eliza", {
        roomHandlerLease: { id: "stale" } as never,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_LEASE_MISMATCH" });
  });
});

describe("resolveTrustedApiPrincipal / resolveChatAdminEntityId", () => {
  it("maps an OWNER session onto owner_session", () => {
    expect(
      resolveTrustedApiPrincipal(makeReq(), {
        ok: true,
        role: "OWNER",
        identityId: "owner-1",
        principal: "owner-principal",
      } as ChatRouteContext["callerAuthorization"]),
    ).toEqual({ kind: "owner_session", principalId: "owner-1" });
  });

  it("maps a non-owner authorized session onto service_gateway", () => {
    expect(
      resolveTrustedApiPrincipal(makeReq(), {
        ok: true,
        role: "MEMBER",
        principal: "member-1",
      } as ChatRouteContext["callerAuthorization"]),
    ).toEqual({
      kind: "service_gateway",
      principalId: "member-1",
    });
  });

  it("falls back to non-owner-api when nothing authorizes the request", () => {
    expect(resolveTrustedApiPrincipal(makeReq(), undefined)).toEqual({
      kind: "service_gateway",
      principalId: "non-owner-api",
    });
  });

  it("seeds adminEntityId from the agent name when no runtime owner exists", () => {
    const state = makeState({ agentName: "Desk" });
    const id = resolveChatAdminEntityId(state);
    expect(id).toEqual(expect.any(String));
    expect(state.adminEntityId).toBe(id);
    expect(state.chatUserId).toBe(id);
  });
});

describe("SSE + delta-v2 token writer", () => {
  it("initSse sets event-stream headers and writeSse no-ops after end", () => {
    const { res, writes } = makeRes();
    initSse(res);
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      }),
    );
    writeSse(res, { type: "ping" });
    expect(writes[0]).toBe(`data: ${JSON.stringify({ type: "ping" })}\n\n`);

    (res as { writableEnded: boolean }).writableEnded = true;
    writeSse(res, { type: "late" });
    expect(writes).toHaveLength(1);
  });

  it("sanitizes SSE event names and splits multiline data", () => {
    const { res, writes } = makeRes();
    writeSseData(res, "line1\nline2", "not a valid event");
    expect(writes.join("")).toBe("data: line1\ndata: line2\n\n");

    writes.length = 0;
    writeSseJson(res, { ok: true }, "message_start");
    expect(writes[0]).toBe("event: message_start\n");
    expect(writes[1]).toBe(`data: ${JSON.stringify({ ok: true })}\n`);
  });

  it("legacy writer re-sends fullText; delta-v2 snapshots only after 2048 bytes", () => {
    const token = vi.fn();
    const sse = vi.fn();
    const legacy = createChatTokenStreamWriter("legacy", {
      writeChatTokenSse: token,
      writeSse: sse,
    });
    const { res } = makeRes();
    legacy.writeChunk(res, "a", "a");
    expect(token).toHaveBeenCalledWith(res, "a", "a", undefined);
    legacy.writeSnapshot(res, "ab");
    expect(token).toHaveBeenCalledWith(res, "ab", "ab", undefined);

    const delta = createChatTokenStreamWriter(DELTA_STREAM_PROTOCOL, {
      writeChatTokenSse: token,
      writeSse: sse,
    });
    delta.writeChunk(res, "hi", "hi");
    expect(sse).toHaveBeenCalledWith(res, { type: "token", text: "hi" });

    const big = "x".repeat(2048);
    delta.writeChunk(res, big, `hi${big}`, { provisional: true });
    expect(sse).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        type: "token",
        text: big,
        fullText: `hi${big}`,
        provisional: true,
      }),
    );

    delta.writeSnapshot(res, "done");
    expect(sse).toHaveBeenCalledWith(res, {
      type: "token",
      fullText: "done",
    });
  });
});

describe("persistUnpersistedChatReply", () => {
  const replyText =
    "Created “Optometrist appointment” for Friday, Sep 18 at 3pm EDT.";
  const userTurn = () =>
    createMessageMemory({
      id: stringToUuid("api-user-turn"),
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: {
        text: "add a optometrist appointment friday at 3pm to my calendar",
        source: "agent_message_api",
        channelType: ChannelType.API,
      },
    });

  it("stores a planner reply the message service delivered through an action callback but never persisted (live: API-room calendar answers missing)", async () => {
    const memories: Memory[] = [];
    const runtime = makeRuntime({ memories });
    const persisted = await persistUnpersistedChatReply(
      runtime,
      userTurn(),
      {
        text: replyText,
        agentName: "Eliza",
        usedActionCallbacks: true,
        actionCallbackHistory: ["CALENDAR"],
        responseContent: null,
        responseMessages: [],
      },
      Date.now() - 5_000,
    );
    expect(persisted?.entityId).toBe(AGENT_ID);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.roomId).toBe(ROOM_ID);
    expect(memories[0]?.content).toMatchObject({
      text: replyText,
      inReplyTo: stringToUuid("api-user-turn"),
      source: "agent_message_api",
      channelType: ChannelType.API,
      actionCallbackHistory: ["CALENDAR"],
    });
  });

  it("leaves a reply the message service already committed alone", async () => {
    const memories: Memory[] = [];
    const runtime = makeRuntime({ memories });
    const committedId = stringToUuid("committed-reply");
    const persisted = await persistUnpersistedChatReply(
      runtime,
      userTurn(),
      {
        text: replyText,
        agentName: "Eliza",
        responseMessages: [
          {
            id: committedId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: replyText },
          } as Memory,
        ],
        persistedResponseMessageIds: [committedId],
      },
      Date.now() - 5_000,
    );
    expect(persisted).toBeNull();
    expect(memories).toHaveLength(0);
  });

  it("stores nothing for internal, empty, ignored, transient, or already-stored replies", async () => {
    const turnStartedAt = Date.now() - 5_000;
    const cases: ChatGenerationResult[] = [
      { text: replyText, agentName: "Eliza", transcriptVisibility: "internal" },
      { text: "   ", agentName: "Eliza" },
      { text: replyText, agentName: "Eliza", noResponseReason: "ignored" },
      {
        text: replyText,
        agentName: "Eliza",
        responseContent: { text: replyText, transient: true },
      },
    ];
    for (const result of cases) {
      const memories: Memory[] = [];
      await expect(
        persistUnpersistedChatReply(
          makeRuntime({ memories }),
          userTurn(),
          result,
          turnStartedAt,
        ),
      ).resolves.toBeNull();
      expect(memories).toHaveLength(0);
    }
    const stored = createMessageMemory({
      id: stringToUuid("already-stored"),
      entityId: AGENT_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: replyText },
    });
    stored.createdAt = turnStartedAt + 100;
    const memories: Memory[] = [stored];
    await expect(
      persistUnpersistedChatReply(
        makeRuntime({ memories }),
        userTurn(),
        { text: replyText, agentName: "Eliza" },
        turnStartedAt,
      ),
    ).resolves.toBeNull();
    expect(memories).toHaveLength(1);
  });
});
