/**
 * Round-trip coverage for the chat `failureKind` so the renderer's
 * provider/credits/no-provider gate + Retry button survive a turn:
 *
 *  (a) GET /api/conversations/:id/messages re-emits `failureKind` for a
 *      persisted failed assistant turn (from `content.failureKind` on the live
 *      result OR `metadata.chatFailureKind` from markSyntheticChatFailureContent).
 *  (b) The streaming `done` frame includes `failureKind` when a NON-throwing
 *      result carries one (e.g. a canned provider-issue phrase folded into the
 *      reply), mirroring the error branch.
 *  (c) The non-streaming JSON response includes `failureKind` likewise.
 *
 * Before the fix the GET mapping dropped the field entirely (full-replace wiped
 * the gate) and both success writers omitted it.
 */

import http from "node:http";
import {
  ChannelType,
  logger,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Configurable result returned by the mocked generateChatResponse so each test
// can drive the success writers with/without a carried failureKind.
let generateResult: Record<string, unknown> = {};

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    initSse: vi.fn((res: http.ServerResponse) => {
      res.setHeader("Content-Type", "text/event-stream");
    }),
    writeSse: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeSseJson: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeChatTokenSse: vi.fn(
      (res: http.ServerResponse, chunk: string, fullText: string) => {
        res.write(
          `data: ${JSON.stringify({ type: "token", text: chunk, fullText })}\n\n`,
        );
      },
    ),
    writeChatStatusSse: vi.fn(),
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "hello",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
    })),
    persistConversationMemory: vi.fn(async () => undefined),
    persistAssistantConversationMemory: vi.fn(
      async (
        runtime: { agentId: UUID },
        roomId: UUID,
        content: string | Record<string, unknown>,
        _channelType: ChannelType,
        _dedupeSinceMs?: number,
        memoryId?: UUID,
      ) => ({
        id: memoryId ?? stringToUuid("assistant-persisted"),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId,
        content: typeof content === "string" ? { text: content } : content,
      }),
    ),
    hasRecentVisibleAssistantMemorySince: vi.fn(async () => false),
    generateChatResponse: vi.fn(
      async (
        _runtime,
        _msg,
        agentName: string,
        opts: { onChunk?: (chunk: string) => void },
      ) => {
        if (generateResult.transcriptVisibility !== "internal") {
          opts?.onChunk?.("ok");
        }
        return {
          text: "ok",
          agentName,
          usage: undefined,
          usedActionCallbacks: false,
          actionCallbackHistory: undefined,
          noResponseReason: undefined,
          ...generateResult,
        };
      },
    ),
    normalizeChatResponseText: (text: string) => text,
    resolveNoResponseFallback: () => "",
  };
});

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(({ prompt, userId, agentId, roomId }) => ({
      userMessage: {
        id: stringToUuid("user-msg"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
      messageToStore: {
        id: stringToUuid("user-msg-store"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
    })),
    resolveWalletModeGuidanceReply: () =>
      "LEGACY WALLET BYPASS MUST NOT BE USED",
    resolveAppUserName: () => "tester",
  };
});

import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import {
  buildPersistedAssistantContent,
  handleConversationRoutes,
} from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("agent-1") as UUID;
const USER_ID = stringToUuid("user-1") as UUID;
const ROOM_ID = stringToUuid("room-1") as UUID;

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

function createState(
  memories: Array<Record<string, unknown>> = [],
): ConversationRouteState {
  const conv = {
    id: "conv-1",
    title: "Test conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const worlds = new Map<
    UUID,
    { id: UUID; agentId: UUID; metadata: Record<string, unknown> }
  >();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Test Agent" },
    logger,
    getMemories: vi.fn(async () => memories),
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
    roomHandlerQueue: new RoomHandlerQueue(),
    adapter: {},
  };
  return {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: USER_ID,
    chatUserId: USER_ID,
    logBuffer: [],
    conversations: new Map([[conv.id, conv]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
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

function assistantMemory(
  content: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: stringToUuid("assistant-mem"),
    entityId: AGENT_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 2_000,
    content: { source: "agent_response", ...content },
    metadata: { type: "message", ...metadata },
  };
}

function userMemory(): Record<string, unknown> {
  return {
    id: stringToUuid("user-mem"),
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1_000,
    content: { text: "are you there", source: "api" },
    metadata: { type: "message" },
  };
}

interface CapturedJson {
  payload: unknown;
}

function createCtx(
  method: string,
  pathname: string,
  state: ConversationRouteState,
): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  captured: CapturedJson;
} {
  const { res, record } = createMockRes();
  const captured: CapturedJson = { payload: undefined };
  const ctx: ConversationRouteContext = {
    req: createReq(method, pathname),
    res,
    method,
    pathname,
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "hello" })),
    json: vi.fn((_res, payload) => {
      captured.payload = payload;
    }),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, captured };
}

describe("conversation failureKind round-trip", () => {
  beforeEach(() => {
    generateResult = {};
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET /messages re-emits failureKind from metadata.chatFailureKind (synthetic fallback)", async () => {
    const state = createState([
      userMemory(),
      assistantMemory(
        { text: "I'm having trouble reaching the model provider." },
        { chatFailureKind: "provider_issue" },
      ),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{ role: string; failureKind?: string }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.failureKind).toBe("provider_issue");
  });

  it("GET /messages re-emits failureKind from content.failureKind (live result)", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({
        text: "Out of credits.",
        failureKind: "insufficient_credits",
      }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{ role: string; failureKind?: string }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.failureKind).toBe("insufficient_credits");
  });

  it("GET /messages re-emits the complete typed terminal failure", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({
        text: "Typecheck still fails after repair.",
        failureKind: "coding_verification_failed",
        terminalFailure: {
          kind: "coding_verification_failed",
          message: "Typecheck still fails after repair.",
          transient: false,
          code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
        },
      }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{
        role: string;
        terminalFailure?: Record<string, unknown>;
      }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.terminalFailure).toEqual({
      kind: "coding_verification_failed",
      message: "Typecheck still fails after repair.",
      transient: false,
      code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
    });
    expect(assistant).toMatchObject({
      failureKind: "coding_verification_failed",
    });
  });

  it.each([
    "handler_error",
    "missing_capability",
    "persistence_error",
    "planner_exhaustion",
    "generation_timeout",
  ] as const)(
    "GET /messages preserves the %s structured runtime cause",
    async (failureKind:
      | "handler_error"
      | "missing_capability"
      | "persistence_error"
      | "planner_exhaustion"
      | "generation_timeout") => {
      const state = createState([
        userMemory(),
        assistantMemory({ text: "Structured failure.", failureKind }),
      ]);
      const { ctx, captured } = createCtx(
        "GET",
        "/api/conversations/conv-1/messages",
        state,
      );

      await handleConversationRoutes(ctx);

      const payload = captured.payload as {
        messages: Array<{ role: string; failureKind?: string }>;
      };
      const assistant = payload.messages.find((m) => m.role === "assistant");
      expect(assistant?.failureKind).toBe(failureKind);
    },
  );

  it("GET /messages omits failureKind for a normal (successful) turn", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({ text: "All good!" }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{ role: string; failureKind?: string }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.failureKind).toBeUndefined();
  });

  it("streaming `done` frame carries failureKind when the result carries one", async () => {
    generateResult = { failureKind: "provider_issue" };
    const state = createState();
    const { ctx, record } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages/stream",
      state,
    );

    const done = handleConversationRoutes(ctx);
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    await done;

    const doneFrame = record.writes.find((w) => w.includes('"type":"done"'));
    expect(doneFrame).toBeDefined();
    const parsed = JSON.parse(
      (doneFrame as string).replace(/^data: /, "").trim(),
    ) as { failureKind?: string };
    expect(parsed.failureKind).toBe("provider_issue");
  });

  it.each(["/messages", "/messages/stream"])(
    "always sends wallet wording through generation on %s",
    async (suffix) => {
      const { readChatRequestPayload, generateChatResponse } = await import(
        "../chat-routes.ts"
      );
      vi.mocked(readChatRequestPayload).mockResolvedValueOnce({
        prompt: "Read my wallet balance. Do not send or swap anything.",
        channelType: ChannelType.DM,
        source: "api",
      });
      const { ctx, record, captured } = createCtx(
        "POST",
        `/api/conversations/conv-1${suffix}`,
        createState(),
      );
      const before = vi.mocked(generateChatResponse).mock.calls.length;
      await handleConversationRoutes(ctx);
      expect(vi.mocked(generateChatResponse).mock.calls.length).toBe(
        before + 1,
      );
      expect(
        JSON.stringify(captured.payload) + record.writes.join(""),
      ).not.toContain("LEGACY WALLET BYPASS");
    },
  );

  it("non-streaming JSON response carries failureKind when the result carries one", async () => {
    generateResult = { failureKind: "insufficient_credits" };
    const state = createState();
    const { ctx, captured } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as { failureKind?: string };
    expect(payload.failureKind).toBe("insufficient_credits");
  });

  it.each([
    "handler_error",
    "missing_capability",
    "persistence_error",
    "planner_exhaustion",
    "generation_timeout",
  ] as const)(
    "non-streaming JSON accepts the %s durable outcome discriminator",
    async (failureKind:
      | "handler_error"
      | "missing_capability"
      | "persistence_error"
      | "planner_exhaustion"
      | "generation_timeout") => {
      generateResult = { failureKind };
      const state = createState();
      const { ctx, captured } = createCtx(
        "POST",
        "/api/conversations/conv-1/messages",
        state,
      );

      await handleConversationRoutes(ctx);

      const payload = captured.payload as { failureKind?: string };
      expect(payload.failureKind).toBe(failureKind);
    },
  );
});

describe("conversation transcript visibility round-trip", () => {
  beforeEach(() => {
    generateResult = {};
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists internal visibility alongside the raw diagnostic text", () => {
    expect(
      buildPersistedAssistantContent("available_views:\nviews[1]{id}: notes", {
        transcriptVisibility: "internal",
      }),
    ).toMatchObject({
      text: "available_views:\nviews[1]{id}: notes",
      transcriptVisibility: "internal",
    });
  });

  it("removes inherited internal visibility when authoritative text is visible", () => {
    expect(
      buildPersistedAssistantContent("Notes is ready.", {
        responseContent: {
          text: "available_views:\nviews[1]{id}: notes",
          transcriptVisibility: "internal",
        },
        responseMessages: [
          {
            id: "00000000-0000-0000-0000-000000000031" as UUID,
            content: {
              text: "available_views:\nviews[1]{id}: notes",
              transcriptVisibility: "internal",
            },
          },
        ],
      }),
    ).toMatchObject({ text: "Notes is ready." });
    expect(
      buildPersistedAssistantContent("Notes is ready.", {
        responseContent: {
          text: "available_views:\nviews[1]{id}: notes",
          transcriptVisibility: "internal",
        },
      }).transcriptVisibility,
    ).toBeUndefined();
  });

  it.each(["IGNORE", "STOP"])(
    "GET /messages keeps a silent %s receipt out of visible history",
    async (action) => {
      const state = createState([
        userMemory(),
        assistantMemory({
          actions: [action],
          thought: "Terminal decision, not a reply.",
        }),
      ]);
      const { ctx, captured } = createCtx(
        "GET",
        "/api/conversations/conv-1/messages",
        state,
      );
      await handleConversationRoutes(ctx);
      const payload = captured.payload as {
        messages: Array<{ role: string; text: string }>;
      };
      expect(payload.messages.map((m) => m.role)).toEqual(["user"]);
    },
  );

  it("GET /messages preserves actual reply text accompanying STOP", async () => {
    const state = createState([
      assistantMemory({ actions: ["STOP"], text: "I'll stop now." }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );
    await handleConversationRoutes(ctx);
    const payload = captured.payload as { messages: Array<{ text: string }> };
    expect(payload.messages.map((m) => m.text)).toEqual(["I'll stop now."]);
  });

  it("GET /messages omits persisted internal diagnostics from visible history", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({
        text: "available_views:\nviews[1]{id}: notes",
        transcriptVisibility: "internal",
      }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{
        role: string;
        text: string;
        transcriptVisibility?: string;
      }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("available_views");
  });

  it("streaming suppresses internal fallback tokens and tags only the done frame", async () => {
    generateResult = {
      text: "available_views:\nviews[1]{id}: notes",
      transcriptVisibility: "internal",
    };
    const state = createState();
    const { ctx, record } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages/stream",
      state,
    );

    const done = handleConversationRoutes(ctx);
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    await done;

    const frames = record.writes
      .flatMap((write) => write.split("\n\n"))
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as object);
    expect(frames).not.toContainEqual(
      expect.objectContaining({ type: "token" }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "done",
        fullText: "",
        transcriptVisibility: "internal",
      }),
    );
  });

  it("non-streaming JSON carries internal visibility", async () => {
    generateResult = {
      text: "available_views:\nviews[1]{id}: notes",
      transcriptVisibility: "internal",
    };
    const state = createState();
    const { ctx, captured } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    expect(captured.payload).toMatchObject({
      text: "",
      transcriptVisibility: "internal",
    });
  });

  it("preserves a distinct visible summary across the non-streaming boundary", async () => {
    generateResult = {
      text: "Notes and Calendar are ready to use.",
    };
    const state = createState();
    const { ctx, captured } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    expect(captured.payload).toMatchObject({
      text: "Notes and Calendar are ready to use.",
    });
    expect(captured.payload).not.toMatchObject({
      transcriptVisibility: "internal",
    });
  });
});

/**
 * Parallel round-trip coverage for the chat `accountConnect` field so the
 * in-chat "add another account" entry point survives a turn the same three
 * ways `failureKind` does: (a) GET /messages re-emits it from
 * `content.accountConnect`, (b) the streaming `done` frame carries it, and
 * (c) the non-streaming JSON response carries it. Malformed/empty requests are
 * dropped by `normalizeAccountConnectRequest` and never surface.
 */
describe("conversation accountConnect round-trip", () => {
  beforeEach(() => {
    generateResult = {};
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET /messages re-emits accountConnect from content.accountConnect", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({
        text: "Pick a provider below to connect another account.",
        accountConnect: {
          providers: ["anthropic-subscription", "openai-codex"],
          reason: "You asked to connect another provider account.",
        },
      }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{
        role: string;
        accountConnect?: { providers: string[]; reason?: string };
      }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.accountConnect).toEqual({
      providers: ["anthropic-subscription", "openai-codex"],
      reason: "You asked to connect another provider account.",
    });
  });

  it("GET /messages drops a malformed accountConnect (no valid providers)", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({
        text: "hi",
        accountConnect: { providers: ["not-a-real-provider"] },
      }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{ role: string; accountConnect?: unknown }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.accountConnect).toBeUndefined();
  });

  it("GET /messages omits accountConnect for a normal turn", async () => {
    const state = createState([
      userMemory(),
      assistantMemory({ text: "All good!" }),
    ]);
    const { ctx, captured } = createCtx(
      "GET",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      messages: Array<{ role: string; accountConnect?: unknown }>;
    };
    const assistant = payload.messages.find((m) => m.role === "assistant");
    expect(assistant?.accountConnect).toBeUndefined();
  });

  it("streaming `done` frame carries accountConnect when the result carries one", async () => {
    generateResult = {
      accountConnect: {
        providers: ["anthropic-subscription"],
        reason: "You asked to connect another Claude Subscription account.",
      },
    };
    const state = createState();
    const { ctx, record } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages/stream",
      state,
    );

    const done = handleConversationRoutes(ctx);
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    await done;

    const doneFrame = record.writes.find((w) => w.includes('"type":"done"'));
    expect(doneFrame).toBeDefined();
    const parsed = JSON.parse(
      (doneFrame as string).replace(/^data: /, "").trim(),
    ) as { accountConnect?: { providers: string[] } };
    expect(parsed.accountConnect?.providers).toEqual([
      "anthropic-subscription",
    ]);
  });

  it("non-streaming JSON response carries accountConnect when the result carries one", async () => {
    generateResult = {
      accountConnect: { providers: ["openai-codex"] },
    };
    const state = createState();
    const { ctx, captured } = createCtx(
      "POST",
      "/api/conversations/conv-1/messages",
      state,
    );

    await handleConversationRoutes(ctx);

    const payload = captured.payload as {
      accountConnect?: { providers: string[] };
    };
    expect(payload.accountConnect?.providers).toEqual(["openai-codex"]);
  });
});
