/**
 * Functional SSE framing contract for the conversation stream route (#10712).
 *
 * Drives the real `/api/conversations/:id/messages/stream` handler
 * (`handleConversationRoutes` → `generateChatResponse`) with a deterministic
 * mock `runtime.useModel`, and asserts the frame contract the dashboard client
 * consumes: the SSE channel (headers + `thinking` status + heartbeat) opens
 * before any model work, `status` frames arrive in thinking → streaming order,
 * `token` frames are ordered with cumulative `fullText`, a terminal `done`
 * frame carries the full text plus the model `thought`, and failures after the
 * SSE channel opened surface as structured `error` data frames (never as a
 * late HTTP status rewrite).
 *
 * Scope note — this layer is provider-agnostic BY DESIGN. The route never
 * branches on which model-provider plugin resolves `runtime.useModel`
 * (local-inference vs cloud selection happens inside core's model registry),
 * so ONE deterministic case covers the whole route contract. An earlier
 * version of this file (`conversation-stream-provider-parity.test.ts`) ran the
 * same fixture twice under "local-inference" / "cloud-resolved" labels; both
 * cases executed byte-identical logic, so the matrix was collapsed. The real
 * provider-resolution path (real plugin, real model, real HTTP SSE) is
 * exercised live by
 * `packages/app-core/test/app/streaming-visible-text.live.e2e.test.ts`.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  createUnavailableGroundedActionReply,
  getInferenceTimer,
  InferenceTurnTimer,
  logger,
  type Memory,
  ModelType,
  quarantinePostDeliveryTasks,
  RoomHandlerQueue,
  runWithInferenceTiming,
  stringToUuid,
  trackPostDeliveryTask,
  type UUID,
} from "@elizaos/core";
import {
  LOCAL_VOICE_RUNTIME_AGENT_HEADER,
  LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER,
} from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// Per-test negotiated wire protocol the mocked payload reader advertises, so a
// single fixture drives both the legacy and delta-v2 framings through the real
// route handler.
let requestStreamProtocol: "delta-v2" | undefined;
let requestClientMessageId: string | undefined;
const DEFAULT_REQUEST_PROMPT = "stream the deterministic thought";
const FIRST_VOICE_TRANSCRIPT =
  "Can you change your personality to be a little bit more hip and cool?";
const SECOND_VOICE_TRANSCRIPT = "Like a zoomer.";
const requestPromptQueue: string[] = [];
let userMessagePreparationHook:
  | ((prompt: string, roomId: UUID) => Promise<void> | void)
  | undefined;

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    readChatRequestPayload: vi.fn(async () => ({
      prompt: requestPromptQueue.shift() ?? DEFAULT_REQUEST_PROMPT,
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
      ...(requestStreamProtocol
        ? { streamProtocol: requestStreamProtocol }
        : {}),
      ...(requestClientMessageId
        ? { clientMessageId: requestClientMessageId }
        : {}),
    })),
    persistConversationMemory: vi.fn(async (runtime, memory) => {
      await runtime.createMemory(memory, "messages");
      return memory;
    }),
    persistAssistantConversationMemory: vi.fn(
      async (
        runtime,
        roomId,
        content,
        _channelType,
        _dedupeSinceMs,
        memoryId,
      ) => {
        const memory = {
          id: memoryId ?? stringToUuid("stream-contract-assistant"),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content:
            typeof content === "string" ? { text: content } : { ...content },
          createdAt: Date.now(),
        } as Memory;
        await runtime.createMemory(memory, "messages");
        return memory as never;
      },
    ),
    resolveNoResponseFallback: () => "",
  };
});

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(async ({ prompt, userId, agentId, roomId }) => {
      await userMessagePreparationHook?.(prompt, roomId);
      return {
        userMessage: {
          id: stringToUuid("stream-contract-user-msg"),
          entityId: userId,
          agentId,
          roomId,
          content: {
            text: prompt,
            source: "api",
            channelType: ChannelType.DM,
          },
          metadata: {},
        },
        messageToStore: {
          id: stringToUuid("stream-contract-user-msg-store"),
          entityId: userId,
          agentId,
          roomId,
          content: {
            text: prompt,
            source: "api",
            channelType: ChannelType.DM,
          },
          metadata: {},
        },
      };
    }),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

import {
  persistAssistantConversationMemory,
  persistConversationMemory,
  persistExactConversationMemoryResult,
  persistInterruptedAssistantReceipt,
  readChatRequestPayload,
} from "../chat-routes.ts";
import { serializeConversationConnectionRoomDeletion } from "../conversation-connection-readiness.ts";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import {
  handleConversationRoutes,
  persistRecentAssistantActionCallbackHistory,
} from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("stream-contract-agent") as UUID;
const USER_ID = stringToUuid("stream-contract-user") as UUID;
const ROOM_ID = stringToUuid("stream-contract-room") as UUID;
const OTHER_ROOM_ID = stringToUuid("stream-contract-other-room") as UUID;
const TOKENS = ["Ordered ", "token ", "frame ", "stream."];
const FINAL_TEXT = TOKENS.join("");
const THOUGHT =
  "Use the same deterministic token plan, then expose the compact reasoning.";

interface StreamingModelParams {
  prompt?: string;
  stream?: boolean;
  signal?: AbortSignal;
  onStreamChunk?: (chunk: string) => Promise<void> | void;
}

interface StreamingModelResult {
  text: string;
  thought: string;
}

interface MockResponseRecord {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
}

type MockSocket = EventEmitter & {
  destroyed: boolean;
  writable: boolean;
};

function createMockSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    remoteAddress: "127.0.0.1",
  });
}

function createReq(socket: MockSocket): http.IncomingMessage {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations/conv-1/messages/stream",
    headers: {},
  });
  Object.defineProperty(req, "socket", {
    configurable: true,
    value: socket,
  });
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    headers: {},
    writes: [],
    ended: false,
  };
  let writableEnded = false;
  const responseFixture = {
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      record.headers.status = String(status);
      Object.assign(record.headers, headers);
      return responseFixture;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      record.headers[name] = value;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      record.writes.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      );
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
      writableEnded = true;
    }),
    destroyed: false,
    get writableEnded() {
      return writableEnded;
    },
  } as unknown as http.ServerResponse;
  return { res: responseFixture, record };
}

function parseSsePayloads(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .join("")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

function createStreamingUseModelFixture() {
  return vi.fn(
    async (
      _modelType: string,
      params: StreamingModelParams,
    ): Promise<StreamingModelResult> => {
      expect(params.stream).toBe(true);
      expect(params.prompt).toContain("stream the deterministic thought");
      for (const token of TOKENS) {
        await Promise.resolve();
        await params.onStreamChunk?.(token);
      }
      return {
        text: FINAL_TEXT,
        thought: THOUGHT,
      };
    },
  );
}

function createModelBackedMessageService() {
  return {
    async handleMessage(
      runtime: AgentRuntime,
      message: { content?: { text?: unknown } },
      _callback: unknown,
      options?: {
        abortSignal?: AbortSignal;
        onStreamChunk?: (
          chunk: string,
          messageId?: string,
          accumulated?: string,
        ) => Promise<void> | void;
      },
    ) {
      const useStreamingModel = runtime.useModel as unknown as (
        modelType: typeof ModelType.TEXT_LARGE,
        params: StreamingModelParams,
      ) => Promise<StreamingModelResult>;
      const modelResult = await useStreamingModel(ModelType.TEXT_LARGE, {
        prompt: String(message.content?.text ?? ""),
        stream: true,
        signal: options?.abortSignal,
        onStreamChunk: options?.onStreamChunk,
      });
      return {
        didRespond: true,
        responseContent: {
          text: modelResult.text,
          thought: modelResult.thought,
        },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

/**
 * A message service that ignores useModel and drives the route's onStreamChunk
 * with a fixed chunk plan, so a test can force a mid-stream snapshot (a "replace"
 * update — chunk that revises earlier text) and assert the fullText-only frame
 * the delta writer emits for it.
 */
function createChunkPlanMessageService(
  chunks: Array<{ chunk: string; accumulated?: string }>,
  finalText: string,
  thought: string,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage(
      _runtime: AgentRuntime,
      _message: { content?: { text?: unknown } },
      _callback: unknown,
      options?: {
        abortSignal?: AbortSignal;
        onStreamChunk?: (
          chunk: string,
          messageId?: string,
          accumulated?: string,
        ) => Promise<void> | void;
      },
    ) {
      for (const { chunk, accumulated } of chunks) {
        await Promise.resolve();
        await options?.onStreamChunk?.(chunk, undefined, accumulated);
      }
      return {
        didRespond: true,
        responseContent: { text: finalText, thought },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-snapshot-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createViewShortcutMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  return {
    async handleMessage() {
      return {
        didRespond: true,
        responseContent: {
          text: "Navigated to Settings.",
          thought: "Shortcut: app-control:nl:view-navigation",
        },
        responseMessages: [],
        actionResults: [
          {
            success: true,
            text: "Navigated to Settings.",
            values: { mode: "show", viewId: "settings", viewType: "gui" },
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "view-shortcut-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createVisibleCallbackWithInternalReceiptMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const text = "Opened Notes.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text }, "VIEWS");
      return {
        didRespond: true,
        responseContent: { text, transcriptVisibility: "internal" as const },
        responseMessages: [],
        mode: "actions" as const,
        actionResults: [
          {
            success: true,
            text,
            transcriptVisibility: "internal" as const,
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "visible-callback-internal-receipt-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createFailedCallbackWithoutSyntheticFallbackMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const text =
    "I couldn't find a view called \"home\". You can try listing the available views to see what's there.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text }, "VIEWS");
      return {
        didRespond: true,
        responseContent: null,
        responseMessages: [],
        mode: "none" as const,
        actionResults: [
          {
            success: false,
            text,
            userFacingText: text,
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "failed-callback-without-synthetic-fallback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createPersistedCallbackMessageService(
  messageId: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  const text = "Calendar is ready.";
  const routeUserMessageId = stringToUuid("stream-contract-user-msg-store");
  return {
    async handleMessage(runtime, _message, callback) {
      await runtime.createMemory(
        {
          id: messageId,
          entityId: AGENT_ID,
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          content: { text, inReplyTo: routeUserMessageId },
          createdAt: Date.now(),
        },
        "messages",
      );
      await callback?.({ text, actions: ["CALENDAR"] }, "CALENDAR");
      return {
        didRespond: true,
        responseContent: { text, actions: ["CALENDAR"] },
        responseMessages: [
          {
            id: messageId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text, inReplyTo: routeUserMessageId },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [messageId],
        mode: "actions" as const,
        actionResults: [
          {
            success: true,
            text,
            data: { actionName: "CALENDAR" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "persisted-callback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createGenericPersistedCallbackMessageService(
  messageId: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  const text = "Simple delivery is ready.";
  return {
    async handleMessage(runtime, message, callback) {
      await runtime.createMemory(
        {
          id: messageId,
          entityId: AGENT_ID,
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          content: { text, actions: ["REPLY"], inReplyTo: message.id },
          createdAt: Date.now(),
        },
        "messages",
      );
      await callback?.({ text, actions: ["REPLY"] });
      return {
        didRespond: true,
        responseContent: { text, actions: ["REPLY"] },
        responseMessages: [
          {
            id: messageId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text, actions: ["REPLY"], inReplyTo: message.id },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [messageId],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "generic-persisted-callback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createPersistedReplyMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const id = stringToUuid("message-service-persisted-assistant");
  return {
    async handleMessage(runtime, message) {
      await runtime.createMemory(
        {
          id,
          entityId: AGENT_ID,
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          content: {
            text: "Already committed by message service.",
            inReplyTo: message.id,
          },
        },
        "messages",
      );
      return {
        didRespond: true,
        responseContent: { text: "Already committed by message service." },
        responseMessages: [
          {
            id,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: {
              text: "Already committed by message service.",
              inReplyTo: message.id,
            },
          },
        ],
        persistedResponseMessageIds: [id],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "persisted-reply-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createMixedPersistedTransientMessageService(
  persistedEarlyId: UUID,
  transientFinalId?: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text: "Final answer.", action: "VIEWS" });
      return {
        didRespond: true,
        responseContent: { text: "Final answer." },
        responseMessages: [
          {
            id: persistedEarlyId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now() - 1,
          },
          {
            id: transientFinalId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [persistedEarlyId],
        mode: "actions" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "mixed-persistence-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createEphemeralReplyMessageService(
  failureKind:
    | "rate_limited"
    | "handler_error"
    | "missing_capability"
    | "persistence_error"
    | "planner_exhaustion"
    | "context_overflow"
    | "generation_timeout" = "rate_limited",
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage() {
      const content = {
        text: "Temporary provider failure.",
        transient: failureKind === "rate_limited",
        doNotPersist: true,
        failureKind,
      };
      return {
        didRespond: true,
        responseContent: content,
        responseMessages: [
          {
            id: stringToUuid("ephemeral-assistant"),
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content,
          },
        ],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "ephemeral-reply-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createCallbackTerminalFailureMessageService(
  failureKind:
    | "coding_mutation_unverified"
    | "coding_verification_failed"
    | "coding_tool_failure",
): NonNullable<AgentRuntime["messageService"]> {
  const verificationFailed = failureKind === "coding_verification_failed";
  const message = verificationFailed
    ? "Typecheck still fails after repair."
    : "Shell execution failed.";
  const code = verificationFailed
    ? "CODING_VERIFICATION_REPAIR_EXHAUSTED"
    : "SHELL_UNAVAILABLE";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text: "Done." });
      return {
        didRespond: true,
        responseContent: null,
        responseMessages: [],
        terminalFailure: {
          kind: failureKind,
          transient: !verificationFailed,
          message,
          code,
        },
        mode: "actions" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "typed-coding-failure-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createState(
  messageServiceOverride?: NonNullable<AgentRuntime["messageService"]>,
): {
  state: ConversationRouteState;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const conv = {
    id: "conv-1",
    title: "stream contract test conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const useModel = createStreamingUseModelFixture();
  const worlds = new Map<
    UUID,
    {
      id: UUID;
      agentId: UUID;
      messageServerId?: UUID;
      metadata: Record<string, unknown>;
    }
  >();
  const storedMemories = new Map<UUID, Memory>();
  const runtime = {
    agentId: AGENT_ID,
    character: {
      name: "Streaming Agent",
      system: "System prompt",
      settings: {},
    },
    actions: [],
    plugins: [],
    logger,
    emitEvent: vi.fn(async () => undefined),
    useModel: useModel as unknown as AgentRuntime["useModel"],
    messageService: messageServiceOverride ?? createModelBackedMessageService(),
    ensureConnection: vi.fn(
      async (input: { worldId?: UUID; messageServerId?: UUID }) => {
        if (!input.worldId) throw new Error("worldId is required");
        if (!worlds.has(input.worldId)) {
          worlds.set(input.worldId, {
            id: input.worldId,
            agentId: AGENT_ID,
            messageServerId: input.messageServerId,
            metadata: {},
          });
        }
      },
    ),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async (worldId: UUID) => worlds.get(worldId) ?? null),
    getRoom: vi.fn(async () => null),
    getParticipantsForRoom: vi.fn(async () => [USER_ID, AGENT_ID]),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    drainChatPreHandlers: vi.fn(async () => null),
    createLogs: vi.fn(async () => undefined),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) storedMemories.set(memory.id as UUID, memory);
      return memory.id;
    }),
    updateMemory: vi.fn(async (memory: Partial<Memory> & { id: UUID }) => {
      const existing = storedMemories.get(memory.id);
      if (!existing) throw new Error("memory not found");
      storedMemories.set(memory.id, { ...existing, ...memory });
      return true;
    }),
    getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
      [...storedMemories.values()]
        .filter((memory) => memory.roomId === roomId)
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    ),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) => {
      const clientUserId = requestClientMessageId
        ? (stringToUuid(
            `conversation-user:${AGENT_ID}:${ROOM_ID}:${USER_ID}:${requestClientMessageId}`,
          ) as UUID)
        : null;
      return ids.flatMap((id) => {
        const stored = storedMemories.get(id);
        if (stored) return [stored];
        if (id === clientUserId) return [];
        return [
          {
            id,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Calendar is ready." },
            createdAt: Date.now(),
          },
        ];
      });
    }),
    reportError: vi.fn(),
    abortTurn: vi.fn(),
    roomHandlerQueue: new RoomHandlerQueue(),
    adapter: {},
  } as unknown as AgentRuntime;

  return {
    useModel,
    state: {
      runtime,
      config: { user: { name: "tester" } } as never,
      agentName: "Streaming Agent",
      adminEntityId: USER_ID,
      chatUserId: USER_ID,
      logBuffer: [],
      conversations: new Map([[conv.id, conv]]),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    } as ConversationRouteState,
  };
}

function createCtx(
  messageServiceOverride?: NonNullable<AgentRuntime["messageService"]>,
): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  state: ConversationRouteState;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const socket = createMockSocket();
  const req = createReq(socket);
  const { res, record } = createMockRes();
  const { state, useModel } = createState(messageServiceOverride);
  const ctx: ConversationRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "unused" })),
    json: vi.fn(),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, state, useModel };
}

function createFollowupCtx(
  baseCtx: ConversationRouteContext,
  state: ConversationRouteState,
): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
} {
  const req = createReq(createMockSocket());
  const { res, record } = createMockRes();
  return {
    ctx: {
      ...baseCtx,
      req,
      res,
      state,
    },
    record,
  };
}

function stampLocalVoiceRuntimeFence(
  ctx: ConversationRouteContext,
  agentId = AGENT_ID,
  conversationId = "conv-1",
): void {
  ctx.req.headers[LOCAL_VOICE_RUNTIME_AGENT_HEADER.toLowerCase()] = agentId;
  ctx.req.headers[LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER.toLowerCase()] =
    conversationId;
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
    reject: (reason: unknown) => reject?.(reason),
  };
}

function createGatedMessageService(
  started: ReturnType<typeof createDeferred>,
  gate: ReturnType<typeof createDeferred>,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage() {
      started.resolve();
      await gate.promise;
      return {
        didRespond: true,
        responseContent: { text: FINAL_TEXT, thought: THOUGHT },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-gated-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

function createSerialVoiceTurnMessageService({
  events,
  firstStarted,
  firstGate,
  firstAssistantIsDurable,
}: {
  events: string[];
  firstStarted: ReturnType<typeof createDeferred>;
  firstGate: ReturnType<typeof createDeferred>;
  firstAssistantIsDurable: () => boolean;
}): NonNullable<AgentRuntime["messageService"]> {
  let active = 0;
  return {
    async handleMessage(_runtime, message) {
      const text = String(message.content?.text ?? "");
      active += 1;
      events.push(`handle-start:${text}:${active}`);
      try {
        if (text === FIRST_VOICE_TRANSCRIPT) {
          firstStarted.resolve();
          await firstGate.promise;
          return {
            didRespond: true,
            responseContent: {
              text: "got it. i'll keep the vibe hip and cool.",
            },
            responseMessages: [],
          };
        }
        if (text === SECOND_VOICE_TRANSCRIPT) {
          events.push(
            `second-context:${firstAssistantIsDurable() ? "ordered" : "stale"}`,
          );
          return {
            didRespond: true,
            responseContent: { text: "got it. i'll keep it current." },
            responseMessages: [],
          };
        }
        throw new Error(`Unexpected voice transcript: ${text}`);
      } finally {
        events.push(`handle-end:${text}:${active}`);
        active -= 1;
      }
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "voice-turn-serialization-regression",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

/**
 * Records the `content.metadata` each runtime turn is handed, so a test can
 * assert what the route stamped onto the message BEFORE generation. This is
 * the observation point for the originating-renderer routing identity: the
 * VIEWS action reads `content.metadata.viewClientId` to target its navigate
 * frame at the caller's own WebSocket instead of broadcasting globally.
 */
function createMetadataCaptureMessageService(
  captured: Array<Record<string, unknown> | undefined>,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage(_runtime, message) {
      const content = (message as Memory).content as
        | { metadata?: unknown }
        | undefined;
      const metadata = content?.metadata;
      captured.push(
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : undefined,
      );
      return {
        didRespond: true,
        responseContent: { text: FINAL_TEXT, thought: THOUGHT },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "view-client-stamping-regression",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

describe("conversation stream SSE contract (#10712)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    requestStreamProtocol = undefined;
    requestClientMessageId = undefined;
    requestPromptQueue.length = 0;
    userMessagePreparationHook = undefined;
  });

  it("accepts a turn only while the local voice runtime fence matches", async () => {
    const { ctx, record, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx);

    await handleConversationRoutes(ctx);

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(
      parseSsePayloads(record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("rejects a stale local voice agent before model work or persistence", async () => {
    const { ctx, record, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx, stringToUuid("retired-agent"));
    vi.mocked(persistConversationMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    expect(record.writes.join("")).toContain(
      "error 409: Local voice agent runtime changed",
    );
    expect(useModel).not.toHaveBeenCalled();
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("rejects a local voice conversation mismatch before model work", async () => {
    const { ctx, record, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx, AGENT_ID, "retired-conversation");

    await handleConversationRoutes(ctx);

    expect(record.writes.join("")).toContain(
      "error 409: Local voice conversation identity changed",
    );
    expect(useModel).not.toHaveBeenCalled();
  });

  it.each<
    [
      string,
      {
        agent?: string | string[];
        conversation?: string;
      },
    ]
  >([
    ["a partial fence", { agent: AGENT_ID }],
    [
      "a duplicate agent header",
      { agent: [AGENT_ID, AGENT_ID], conversation: "conv-1" },
    ],
    [
      "a coalesced duplicate agent header",
      { agent: `${AGENT_ID}, ${AGENT_ID}`, conversation: "conv-1" },
    ],
    [
      "a noncanonical conversation header",
      { agent: AGENT_ID, conversation: " conv-1" },
    ],
  ])("rejects %s before model work", async (_label, values) => {
    const { ctx, record, useModel } = createCtx();
    if (values.agent !== undefined) {
      ctx.req.headers[LOCAL_VOICE_RUNTIME_AGENT_HEADER.toLowerCase()] =
        values.agent;
    }
    if (values.conversation !== undefined) {
      ctx.req.headers[LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER.toLowerCase()] =
        values.conversation;
    }

    await handleConversationRoutes(ctx);

    expect(record.writes.join("")).toContain(
      "error 400: Local voice runtime identity headers are invalid",
    );
    expect(useModel).not.toHaveBeenCalled();
  });

  it("fails closed when the fenced runtime is replaced during pre-model work", async () => {
    const preparationStarted = createDeferred();
    const preparationGate = createDeferred();
    userMessagePreparationHook = async () => {
      preparationStarted.resolve();
      await preparationGate.promise;
    };
    const { ctx, record, state, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx);
    vi.mocked(persistConversationMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(ctx);
    await preparationStarted.promise;
    state.runtime = createState().state.runtime;
    preparationGate.resolve();
    await turn;

    expect(parseSsePayloads(record.writes)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Local voice agent runtime changed",
      }),
    );
    expect(useModel).not.toHaveBeenCalled();
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("blocks durable recovery writes when the fenced runtime changes during its read", async () => {
    requestClientMessageId = "voice-runtime-recovery-fence";
    const recoveryReadStarted = createDeferred();
    const recoveryReadGate = createDeferred();
    const { ctx, record, state, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx);
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const scope = `${AGENT_ID}:${ROOM_ID}:${USER_ID}`;
    const fingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          channelType: ChannelType.DM,
          prompt: DEFAULT_REQUEST_PROMPT,
          source: "api",
        }),
      )
      .digest("hex");
    const userMessageId = stringToUuid(
      `conversation-user:${scope}:${requestClientMessageId}`,
    ) as UUID;
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: userMessageId,
        entityId: USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: {
          text: DEFAULT_REQUEST_PROMPT,
          channelType: ChannelType.DM,
          chatIdempotency: {
            version: 1,
            scope,
            clientMessageId: requestClientMessageId,
            fingerprint,
          },
        },
        createdAt: Date.now(),
      } as Memory,
    ]);
    vi.mocked(runtime.getMemories).mockImplementationOnce(async () => {
      recoveryReadStarted.resolve();
      await recoveryReadGate.promise;
      return [];
    });
    vi.mocked(runtime.createMemory).mockClear();
    vi.mocked(runtime.updateMemory).mockClear();
    vi.mocked(persistConversationMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(ctx);
    await recoveryReadStarted.promise;
    state.runtime = createState().state.runtime;
    recoveryReadGate.resolve();
    await turn;

    expect(parseSsePayloads(record.writes)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Local voice agent runtime changed"),
      }),
    );
    expect(runtime.updateMemory).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("rechecks a request fence after exact-memory lookup and before creation", async () => {
    const lookupStarted = createDeferred();
    const lookupGate = createDeferred();
    const { state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockImplementationOnce(async () => {
      lookupStarted.resolve();
      await lookupGate.promise;
      return [];
    });
    vi.mocked(runtime.createMemory).mockClear();
    let current = true;
    const memory = createMessageMemory({
      id: stringToUuid("fenced-exact-memory"),
      entityId: AGENT_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: "must not cross the fence" },
    });

    const persistence = persistExactConversationMemoryResult(
      runtime,
      memory,
      undefined,
      () => {
        if (!current) throw new Error("request fence changed");
      },
    );
    await lookupStarted.promise;
    current = false;
    lookupGate.resolve();

    await expect(persistence).rejects.toThrow("request fence changed");
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("rechecks the interrupted-receipt fence after lookup and before creation", async () => {
    const lookupStarted = createDeferred();
    const lookupGate = createDeferred();
    const { state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockImplementationOnce(async () => {
      lookupStarted.resolve();
      await lookupGate.promise;
      return [];
    });
    vi.mocked(runtime.createMemory).mockClear();
    let current = true;

    const persistence = persistInterruptedAssistantReceipt(
      runtime,
      ROOM_ID,
      "partial reply",
      ChannelType.DM,
      stringToUuid("interrupted-user-message") as UUID,
      stringToUuid("interrupted-assistant-receipt") as UUID,
      undefined,
      () => {
        if (!current) throw new Error("interrupted receipt fence changed");
      },
    );
    await lookupStarted.promise;
    current = false;
    lookupGate.resolve();

    await expect(persistence).rejects.toThrow(
      "interrupted receipt fence changed",
    );
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("blocks the production user-memory write when runtime replacement wins its lookup race", async () => {
    requestClientMessageId = "voice-user-memory-fence";
    const lookupStarted = createDeferred();
    const lookupGate = createDeferred();
    const { ctx, record, state, useModel } = createCtx();
    stampLocalVoiceRuntimeFence(ctx);
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        lookupStarted.resolve();
        await lookupGate.promise;
        return [];
      });
    vi.mocked(runtime.createMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(ctx);
    await lookupStarted.promise;
    state.runtime = createState().state.runtime;
    lookupGate.resolve();
    await turn;

    expect(parseSsePayloads(record.writes)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Local voice agent runtime changed"),
      }),
    );
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("rejects a missing bound conversation and resumes after it is restored", async () => {
    const first = createCtx();
    stampLocalVoiceRuntimeFence(first.ctx);
    await handleConversationRoutes(first.ctx);
    expect(first.useModel).toHaveBeenCalledTimes(1);

    const conversation = first.state.conversations.get("conv-1");
    if (!conversation) throw new Error("conversation fixture missing");
    first.state.conversations.delete("conv-1");
    const missing = createFollowupCtx(first.ctx, first.state);
    stampLocalVoiceRuntimeFence(missing.ctx);
    await handleConversationRoutes(missing.ctx);
    expect(missing.record.writes.join("")).toContain(
      "error 404: Conversation not found",
    );
    expect(first.useModel).toHaveBeenCalledTimes(1);

    first.state.conversations.set("conv-1", conversation);
    const restored = createFollowupCtx(first.ctx, first.state);
    stampLocalVoiceRuntimeFence(restored.ctx);
    await handleConversationRoutes(restored.ctx);
    expect(first.useModel).toHaveBeenCalledTimes(2);
    expect(
      parseSsePayloads(restored.record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("completes an initial turn when room ownership requires explicit capability propagation", async () => {
    const { ctx, record, state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    Object.defineProperty(runtime, "roomHandlerQueue", {
      configurable: true,
      value: new RoomHandlerQueue({ asyncContext: "explicit" }),
    });

    await handleConversationRoutes(ctx);

    expect(
      parseSsePayloads(record.writes).filter(
        (payload) => payload.type === "done",
      ),
    ).toHaveLength(1);
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
  });

  it("emits thinking→streaming status, ordered cumulative token frames, then a terminal done frame with thought", async () => {
    const { ctx, record, useModel } = createCtx();

    // Snapshot the wire at the moment the model is first invoked: the SSE
    // channel (headers + `thinking` status + heartbeat) must already be open
    // BEFORE any model work, so the client renders a live indicator during
    // the pre-model steps instead of staring at zero bytes.
    let writesAtModelCall: string[] | null = null;
    const streamImpl = useModel.getMockImplementation();
    if (!streamImpl) throw new Error("useModel fixture lost implementation");
    useModel.mockImplementation(async (modelType, params) => {
      if (writesAtModelCall === null) writesAtModelCall = [...record.writes];
      return streamImpl(modelType, params);
    });

    await handleConversationRoutes(ctx);

    expect(record.headers["Content-Type"]).toBe("text/event-stream");
    expect(record.ended).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);

    const preModelFrames = parseSsePayloads(writesAtModelCall ?? []);
    expect(
      preModelFrames.some(
        (frame) => frame.type === "status" && frame.kind === "thinking",
      ),
    ).toBe(true);
    expect((writesAtModelCall ?? []).join("")).toContain(": heartbeat");

    const payloads = parseSsePayloads(record.writes);
    // The opening `thinking` status is the very first data frame on the wire.
    expect(payloads[0]).toMatchObject({ type: "status", kind: "thinking" });
    const tokens = payloads.filter((payload) => payload.type === "token");
    expect(tokens.map((payload) => payload.text)).toEqual(TOKENS);
    expect(tokens.map((payload) => payload.fullText)).toEqual([
      "Ordered ",
      "Ordered token ",
      "Ordered token frame ",
      FINAL_TEXT,
    ]);

    const doneIndex = payloads.findIndex((payload) => payload.type === "done");
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(payloads[doneIndex]).toMatchObject({
      type: "done",
      fullText: FINAL_TEXT,
      agentName: "Streaming Agent",
      thought: THOUGHT,
    });
    // `done` is emitted only after both ids are durable. The assistant id is
    // the one returned by persistence; the user id is the already-committed
    // request memory.
    const doneMessageId = payloads[doneIndex].messageId;
    const routeOwnedAssistantId = vi.mocked(persistAssistantConversationMemory)
      .mock.calls[0]?.[5];
    expect(routeOwnedAssistantId).toBeDefined();
    expect(doneMessageId).toBe(routeOwnedAssistantId);
    expect(payloads[doneIndex].userMessageId).toBe(
      stringToUuid("stream-contract-user-msg-store"),
    );
    expect(persistAssistantConversationMemory).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      expect.objectContaining({ text: FINAL_TEXT }),
      ChannelType.DM,
      expect.any(Number),
      routeOwnedAssistantId,
      expect.anything(),
      expect.any(Function),
    );
    // `done` is terminal — no token frames after it.
    expect(
      payloads.slice(doneIndex + 1).some((payload) => payload.type === "token"),
    ).toBe(false);
    // The thought channel never leaks into the visible token stream.
    for (const token of tokens) {
      expect(String(token.fullText)).not.toContain(THOUGHT);
    }

    const statusKinds = payloads
      .filter((payload) => payload.type === "status")
      .map((payload) => payload.kind);
    // Exactly one `thinking` on the wire: the route emits it when the SSE
    // channel opens and collapses the identical opening status
    // generateChatResponse re-emits.
    expect(statusKinds).toEqual(["thinking", "streaming"]);
    // Both status frames precede the first token frame.
    const firstTokenIndex = payloads.findIndex(
      (payload) => payload.type === "token",
    );
    const streamingStatusIndex = payloads.findIndex(
      (payload) => payload.type === "status" && payload.kind === "streaming",
    );
    expect(streamingStatusIndex).toBeLessThan(firstTokenIndex);
  });

  it.each(["stream", "non-stream"] as const)(
    "includes inbound preparation and room lease wait once in %s inference timing",
    async (transport) => {
      const { ctx, record, state, useModel } = createCtx();
      if (transport === "non-stream") {
        ctx.pathname = "/api/conversations/conv-1/messages";
      }
      const runtime = state.runtime;
      if (!runtime) throw new Error("runtime fixture missing");
      const heldLease = await runtime.roomHandlerQueue.acquire(ROOM_ID);
      const startedAt = Date.now();
      let now = startedAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      let timer: ReturnType<typeof getInferenceTimer>;
      let leaseTimer: ReturnType<typeof getInferenceTimer>;
      const unsubscribe = runtime.roomHandlerQueue.onEvent((event) => {
        if (event.type === "enqueued") leaseTimer = getInferenceTimer();
      });
      const modelImpl = useModel.getMockImplementation();
      const payloadImpl = vi
        .mocked(readChatRequestPayload)
        .getMockImplementation();
      if (!modelImpl || !payloadImpl)
        throw new Error("fixture implementation missing");
      vi.mocked(readChatRequestPayload).mockImplementationOnce(
        async (...args) => {
          now += 100;
          return payloadImpl(...args);
        },
      );
      useModel.mockImplementation(async (...args) => {
        timer = getInferenceTimer();
        now += 200;
        return modelImpl(...args);
      });
      const request = handleConversationRoutes(ctx);
      try {
        await vi.waitFor(() =>
          expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(2),
        );
        expect(useModel).not.toHaveBeenCalled();
        now += 3_000;
        await heldLease.release();
        await request;

        if (!timer)
          throw new Error("generation did not receive an inference timer");
        const summary = timer.summary();
        expect(timer).toBe(leaseTimer);
        if (transport === "stream") {
          expect(record.headers["X-Eliza-Trace-Id"]).toBe(timer.traceId);
        }
        expect(summary.t0EpochMs).toBe(startedAt);
        expect(summary.timeToFirstVisibleMs).toBe(3_300);
        expect(summary.totalMs).toBe(3_300);
        expect(
          summary.spans.filter((span) => span.name === "chat:room-lease-wait"),
        ).toEqual([
          {
            name: "chat:room-lease-wait",
            startMs: 100,
            endMs: 3_100,
            durationMs: 3_000,
          },
        ]);
        expect(summary.anomalies).toEqual([]);
        expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
        expect(
          vi
            .mocked(runtime.createLogs)
            .mock.calls.flatMap(([rows]) => rows)
            .filter((row) => row.type === "inference_timing"),
        ).toHaveLength(1);
      } finally {
        await heldLease.release();
        await request;
        unsubscribe();
        clock.mockRestore();
      }
    },
  );

  it("preserves an inherited caller-owned timer across lease admission without closing or emitting it", async () => {
    const { ctx, state, useModel } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const timer = new InferenceTurnTimer({
      turnId: "caller-owned-conversation",
      traceId: "0123456789abcdef0123456789abcdef",
      label: "caller-owned",
      roomId: ROOM_ID,
    });
    let leaseTimer: ReturnType<typeof getInferenceTimer>;
    let modelTimer: ReturnType<typeof getInferenceTimer>;
    const unsubscribe = runtime.roomHandlerQueue.onEvent((event) => {
      if (event.type === "enqueued") leaseTimer = getInferenceTimer();
    });
    const modelImpl = useModel.getMockImplementation();
    if (!modelImpl) throw new Error("useModel fixture lost implementation");
    useModel.mockImplementation(async (...args) => {
      modelTimer = getInferenceTimer();
      return modelImpl(...args);
    });
    try {
      await runWithInferenceTiming(timer, () => handleConversationRoutes(ctx));
      expect(leaseTimer).toBe(timer);
      expect(modelTimer).toBe(timer);
      expect(timer.summary().closedAtEpochMs).toBeNull();
      expect(
        timer
          .summary()
          .spans.filter((span) => span.name === "chat:room-lease-wait"),
      ).toHaveLength(1);
      expect(
        vi
          .mocked(runtime.createLogs)
          .mock.calls.flatMap(([rows]) => rows)
          .filter((row) => row.type === "inference_timing"),
      ).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("adopts and echoes a valid inbound trace through the inference timer", async () => {
    const { ctx, record, useModel } = createCtx();
    const inboundTrace = "0123456789abcdef0123456789abcdef";
    ctx.req.headers["x-eliza-trace-id"] = inboundTrace;
    let modelTrace: string | undefined;
    const streamImpl = useModel.getMockImplementation();
    if (!streamImpl) throw new Error("useModel fixture lost implementation");
    useModel.mockImplementation(async (modelType, params) => {
      modelTrace = getInferenceTimer()?.traceId;
      return streamImpl(modelType, params);
    });

    await handleConversationRoutes(ctx);

    expect(record.headers["X-Eliza-Trace-Id"]).toBe(inboundTrace);
    expect(record.headers["Access-Control-Expose-Headers"]).toBe(
      "X-Eliza-Trace-Id",
    );
    expect(modelTrace).toBe(inboundTrace);
  });

  it("discards invalid inbound trace text before echo and model dispatch", async () => {
    const { ctx, record, useModel } = createCtx();
    const invalidTrace = "Bearer private-secret and model body";
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    ctx.req.headers["x-eliza-trace-id"] = invalidTrace;
    let modelTrace: string | undefined;
    const streamImpl = useModel.getMockImplementation();
    if (!streamImpl) throw new Error("useModel fixture lost implementation");
    useModel.mockImplementation(async (modelType, params) => {
      modelTrace = getInferenceTimer()?.traceId;
      return streamImpl(modelType, params);
    });

    await handleConversationRoutes(ctx);

    const echoed = record.headers["X-Eliza-Trace-Id"];
    expect(echoed).toMatch(/^[0-9a-f]{32}$/);
    expect(echoed).not.toBe(invalidTrace);
    expect(modelTrace).toBe(echoed);
    expect(JSON.stringify(record.headers)).not.toContain("private-secret");
    expect(record.writes.join("")).not.toContain("private-secret");
    const traceLog = info.mock.calls.find(
      ([, message]) =>
        message === "[ConversationStream] accepted validated trace context",
    );
    expect(traceLog?.[0]).toEqual({ traceId: echoed, traceSource: "minted" });
    expect(JSON.stringify(traceLog)).not.toContain("private-secret");
    expect(JSON.stringify(traceLog)).not.toContain(DEFAULT_REQUEST_PROMPT);
    info.mockRestore();
  });

  it("awaits connection reconciliation before persistence and generation", async () => {
    const fixture = createCtx();
    const runtime = fixture.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const refresh = createDeferred();
    const reconcile = vi
      .mocked(runtime.ensureConnection)
      .getMockImplementation();
    if (!reconcile) throw new Error("connection fixture missing");
    vi.mocked(runtime.ensureConnection).mockImplementationOnce(
      async (input) => {
        await refresh.promise;
        await reconcile(input);
      },
    );
    vi.mocked(persistConversationMemory).mockClear();
    fixture.useModel.mockClear();
    const turn = handleConversationRoutes(fixture.ctx);

    await vi.waitFor(() => {
      expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    });
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(fixture.useModel).not.toHaveBeenCalled();
    expect(fixture.record.ended).toBe(false);

    refresh.resolve();
    await turn;
    expect(persistConversationMemory).toHaveBeenCalledTimes(1);
    expect(fixture.useModel).toHaveBeenCalledTimes(1);
    expect(fixture.record.ended).toBe(true);
  });

  it("blocks world-role mutation when runtime replacement wins its world lookup race", async () => {
    const fixture = createCtx();
    stampLocalVoiceRuntimeFence(fixture.ctx);
    const runtime = fixture.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const lookupStarted = createDeferred();
    const lookupGate = createDeferred();
    const getWorld = vi.mocked(runtime.getWorld).getMockImplementation();
    if (!getWorld) throw new Error("world lookup fixture missing");
    vi.mocked(runtime.getWorld).mockImplementationOnce(async (worldId) => {
      lookupStarted.resolve();
      await lookupGate.promise;
      return getWorld(worldId);
    });
    vi.mocked(runtime.updateWorld).mockClear();

    const turn = handleConversationRoutes(fixture.ctx);
    await lookupStarted.promise;
    fixture.state.runtime = createState().state.runtime;
    lookupGate.resolve();
    await turn;

    expect(parseSsePayloads(fixture.record.writes)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Local voice agent runtime changed"),
      }),
    );
    expect(runtime.updateWorld).not.toHaveBeenCalled();
    expect(fixture.useModel).not.toHaveBeenCalled();
  });

  it("serializes voice finals received 1.552s apart before preparation, persistence, and runtime execution", async () => {
    const firstTranscript = FIRST_VOICE_TRANSCRIPT;
    const secondTranscript = SECOND_VOICE_TRANSCRIPT;
    requestPromptQueue.push(firstTranscript, secondTranscript);

    const events: string[] = [];
    const firstPreparationStarted = createDeferred();
    const firstPreparationGate = createDeferred();
    userMessagePreparationHook = async (prompt) => {
      events.push(`prepare-start:${prompt}`);
      if (prompt === firstTranscript) {
        firstPreparationStarted.resolve();
        await firstPreparationGate.promise;
      }
      events.push(`prepare-end:${prompt}`);
    };
    const firstStarted = createDeferred();
    const firstGate = createDeferred();
    let firstAssistantDurable = false;
    const service = createSerialVoiceTurnMessageService({
      events,
      firstStarted,
      firstGate,
      firstAssistantIsDurable: () => firstAssistantDurable,
    });
    const first = createCtx(service);
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");

    const persistUser = vi.mocked(persistConversationMemory);
    const persistAssistant = vi.mocked(persistAssistantConversationMemory);
    const originalPersistUser = persistUser.getMockImplementation();
    const originalPersistAssistant = persistAssistant.getMockImplementation();
    if (!originalPersistUser || !originalPersistAssistant) {
      throw new Error("persistence fixture lost implementation");
    }
    persistUser.mockImplementation(async (...args) => {
      const memory = args[1];
      events.push(`persist-user:${String(memory.content.text ?? "")}`);
      return originalPersistUser(...args);
    });
    persistAssistant.mockImplementation(async (...args) => {
      const content = args[2];
      const text =
        typeof content === "string" ? content : String(content.text ?? "");
      events.push(`persist-assistant:${text}`);
      if (text === "got it. i'll keep the vibe hip and cool.") {
        firstAssistantDurable = true;
      }
      return originalPersistAssistant(...args);
    });

    let now = 1_786_103_975_770;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const firstTurn = handleConversationRoutes(first.ctx);
      await firstPreparationStarted.promise;

      now += 1_552;
      const second = createFollowupCtx(first.ctx, first.state);
      const secondTurn = handleConversationRoutes(second.ctx);
      await vi.waitFor(() => {
        expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(2);
      });

      expect(events).toEqual([`prepare-start:${firstTranscript}`]);
      expect(runtime.ensureConnection).not.toHaveBeenCalled();
      expect(persistUser).not.toHaveBeenCalled();
      expect(
        events.filter((event) => event.startsWith("handle-start:")),
      ).toEqual([]);
      expect(
        parseSsePayloads(second.record.writes).some(
          (payload) => payload.type === "done" || payload.type === "error",
        ),
      ).toBe(false);

      firstPreparationGate.resolve();
      await firstStarted.promise;
      expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
      expect(persistUser).toHaveBeenCalledTimes(1);
      expect(
        events.filter((event) => event.startsWith("handle-start:")),
      ).toEqual([`handle-start:${firstTranscript}:1`]);
      expect(events).not.toContain(`prepare-start:${secondTranscript}`);
      expect(
        parseSsePayloads(second.record.writes).some(
          (payload) => payload.type === "done" || payload.type === "error",
        ),
      ).toBe(false);

      firstGate.resolve();
      await Promise.all([firstTurn, secondTurn]);

      expect(events).toEqual([
        `prepare-start:${firstTranscript}`,
        `prepare-end:${firstTranscript}`,
        `persist-user:${firstTranscript}`,
        `handle-start:${firstTranscript}:1`,
        `handle-end:${firstTranscript}:1`,
        "persist-assistant:got it. i'll keep the vibe hip and cool.",
        `prepare-start:${secondTranscript}`,
        `prepare-end:${secondTranscript}`,
        `persist-user:${secondTranscript}`,
        `handle-start:${secondTranscript}:1`,
        "second-context:ordered",
        `handle-end:${secondTranscript}:1`,
        "persist-assistant:got it. i'll keep it current.",
      ]);

      const firstPayloads = parseSsePayloads(first.record.writes);
      const secondPayloads = parseSsePayloads(second.record.writes);
      expect(
        firstPayloads.filter((payload) => payload.type === "done"),
      ).toEqual([
        expect.objectContaining({
          fullText: "got it. i'll keep the vibe hip and cool.",
        }),
      ]);
      expect(
        secondPayloads.filter((payload) => payload.type === "done"),
      ).toEqual([
        expect.objectContaining({ fullText: "got it. i'll keep it current." }),
      ]);
      expect(
        [...firstPayloads, ...secondPayloads].filter(
          (payload) => payload.type === "error",
        ),
      ).toEqual([]);
      expect(
        [...firstPayloads, ...secondPayloads]
          .map((payload) => String(payload.fullText ?? ""))
          .join(" "),
      ).not.toMatch(/create a note|character view/i);
      expect(persistAssistant).toHaveBeenCalledTimes(2);
      expect(runtime.abortTurn).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      persistUser.mockImplementation(originalPersistUser);
      persistAssistant.mockImplementation(originalPersistAssistant);
    }
  });

  it("allows another room to prepare and finish while the first room is blocked in preparation", async () => {
    const blockedPrompt = "room a blocks during preparation";
    const otherRoomPrompt = "room b proceeds independently";
    requestPromptQueue.push(blockedPrompt, otherRoomPrompt);

    const preparationStarted = createDeferred();
    const preparationGate = createDeferred();
    const events: string[] = [];
    userMessagePreparationHook = async (prompt) => {
      events.push(`prepare-start:${prompt}`);
      if (prompt === blockedPrompt) {
        preparationStarted.resolve();
        await preparationGate.promise;
      }
      events.push(`prepare-end:${prompt}`);
    };
    const service = {
      async handleMessage(_runtime, message) {
        const text = String(message.content?.text ?? "");
        events.push(`handle:${text}`);
        return {
          didRespond: true,
          responseContent: { text: `completed ${text}` },
          responseMessages: [],
        };
      },
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "cross-room-serialization-regression",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    } satisfies NonNullable<AgentRuntime["messageService"]>;
    const first = createCtx(service);
    const primaryConversation = first.state.conversations.get("conv-1");
    if (!primaryConversation) throw new Error("primary fixture missing");
    first.state.conversations.set("conv-2", {
      ...primaryConversation,
      id: "conv-2",
      roomId: OTHER_ROOM_ID,
    });

    const firstTurn = handleConversationRoutes(first.ctx);
    await preparationStarted.promise;
    const second = createFollowupCtx(first.ctx, first.state);
    second.ctx.pathname = "/api/conversations/conv-2/messages/stream";
    const secondTurn = handleConversationRoutes(second.ctx);
    await secondTurn;

    expect(events).toEqual([
      `prepare-start:${blockedPrompt}`,
      `prepare-start:${otherRoomPrompt}`,
      `prepare-end:${otherRoomPrompt}`,
      `handle:${otherRoomPrompt}`,
    ]);
    expect(
      parseSsePayloads(second.record.writes).filter(
        (payload) => payload.type === "done",
      ),
    ).toEqual([
      expect.objectContaining({ fullText: `completed ${otherRoomPrompt}` }),
    ]);
    expect(first.record.ended).toBe(false);

    preparationGate.resolve();
    await firstTurn;
    expect(events).toEqual([
      `prepare-start:${blockedPrompt}`,
      `prepare-start:${otherRoomPrompt}`,
      `prepare-end:${otherRoomPrompt}`,
      `handle:${otherRoomPrompt}`,
      `prepare-end:${blockedPrompt}`,
      `handle:${blockedPrompt}`,
    ]);
  });

  it("releases the room when a terminal stream write throws so the next turn can finish", async () => {
    requestPromptQueue.push(
      "turn whose terminal write throws",
      "turn after terminal write failure",
    );
    const first = createCtx();
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    first.ctx.res.end = vi.fn(() => {
      throw new Error("terminal stream write exploded");
    }) as never;

    await expect(handleConversationRoutes(first.ctx)).rejects.toThrow(
      "terminal stream write exploded",
    );
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
    expect(first.state.activeChatTurnCount).toBe(0);

    const second = createFollowupCtx(first.ctx, first.state);
    await handleConversationRoutes(second.ctx);
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
    expect(first.state.activeChatTurnCount).toBe(0);
    const secondPayloads = parseSsePayloads(second.record.writes);
    expect(secondPayloads.filter((payload) => payload.type === "done")).toEqual(
      [expect.objectContaining({ fullText: expect.any(String) })],
    );
    expect(
      secondPayloads.filter((payload) => payload.type === "error"),
    ).toEqual([]);
    expect(second.record.ended).toBe(true);
  });

  it("removes a disconnected voice final while it waits behind the active room turn", async () => {
    requestPromptQueue.push("first voice turn", "disconnected follow-up");
    const firstStarted = createDeferred();
    const firstGate = createDeferred();
    const first = createCtx(createGatedMessageService(firstStarted, firstGate));
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");

    const firstTurn = handleConversationRoutes(first.ctx);
    await firstStarted.promise;
    const second = createFollowupCtx(first.ctx, first.state);
    const secondTurn = handleConversationRoutes(second.ctx);
    await vi.waitFor(() => {
      expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(2);
    });

    second.ctx.req.emit("aborted");
    await secondTurn;
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(1);
    expect(persistConversationMemory).toHaveBeenCalledTimes(1);
    expect(parseSsePayloads(second.record.writes)).not.toContainEqual(
      expect.objectContaining({ type: "done" }),
    );
    expect(parseSsePayloads(second.record.writes)).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
    expect(second.record.ended).toBe(true);
    expect(second.ctx.req.listenerCount("aborted")).toBe(0);
    // Admission cancellation has no completed generation timing to publish.
    expect(
      vi
        .mocked(runtime.createLogs)
        .mock.calls.flatMap(([rows]) => rows)
        .filter((row) => row.type === "inference_timing"),
    ).toHaveLength(0);

    firstGate.resolve();
    await firstTurn;
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
    expect(
      vi
        .mocked(runtime.createLogs)
        .mock.calls.flatMap(([rows]) => rows)
        .filter((row) => row.type === "inference_timing"),
    ).toHaveLength(1);
  });

  it("releases an undelivered connection failure for retry with the same id", async () => {
    requestClientMessageId = "connection-retry-id";
    const first = createCtx();
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const failedRefresh = createDeferred();
    vi.mocked(runtime.ensureConnection).mockImplementationOnce(
      async () => failedRefresh.promise,
    );
    vi.mocked(persistConversationMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const firstTurn = handleConversationRoutes(first.ctx);
    await vi.waitFor(() => {
      expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    });
    expect(first.useModel).not.toHaveBeenCalled();
    expect(persistConversationMemory).not.toHaveBeenCalled();

    failedRefresh.reject(new Error("role reconciliation failed"));
    await firstTurn;

    const failedPayloads = parseSsePayloads(first.record.writes);
    expect(failedPayloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("role reconciliation failed"),
      }),
    );
    expect(failedPayloads.some((payload) => payload.type === "done")).toBe(
      false,
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();

    vi.mocked(runtime.ensureConnection).mockClear();
    first.useModel.mockClear();
    const retry = createFollowupCtx(first.ctx, first.state);
    await handleConversationRoutes(retry.ctx);

    expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    expect(first.useModel).toHaveBeenCalledTimes(1);
    expect(
      parseSsePayloads(retry.record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("fails closed when the room is deleted after ensure and finalizes retry without re-running", async () => {
    requestClientMessageId = "delete-during-generation-id";
    const generationStarted = createDeferred();
    const generationGate = createDeferred();
    const first = createCtx(
      createGatedMessageService(generationStarted, generationGate),
    );
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(first.ctx);
    await generationStarted.promise;

    await serializeConversationConnectionRoomDeletion(
      runtime,
      ROOM_ID,
      async () => {},
    );
    generationGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("invalidated"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();

    runtime.messageService = createModelBackedMessageService();
    first.useModel.mockClear();
    const retry = createFollowupCtx(first.ctx, first.state);
    await handleConversationRoutes(retry.ctx);

    expect(first.useModel).not.toHaveBeenCalled();
    expect(
      parseSsePayloads(retry.record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("fails the terminal frame if route state swaps runtimes mid-turn", async () => {
    const generationStarted = createDeferred();
    const generationGate = createDeferred();
    const first = createCtx(
      createGatedMessageService(generationStarted, generationGate),
    );
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(first.ctx);
    await generationStarted.promise;

    const replacement = createState().state.runtime;
    if (!replacement) throw new Error("replacement fixture missing");
    first.state.runtime = replacement;
    generationGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("runtime changed"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("fails a fenced turn when the same conversation id is replaced mid-generation", async () => {
    const generationStarted = createDeferred();
    const generationGate = createDeferred();
    const first = createCtx(
      createGatedMessageService(generationStarted, generationGate),
    );
    stampLocalVoiceRuntimeFence(first.ctx);
    const conversation = first.state.conversations.get("conv-1");
    if (!conversation) throw new Error("conversation fixture missing");
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(first.ctx);
    await generationStarted.promise;
    first.state.conversations.set("conv-1", { ...conversation });
    generationGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("conversation changed"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("blocks stale model tokens immediately after a fenced conversation replacement", async () => {
    const tokenStarted = createDeferred();
    const tokenGate = createDeferred();
    const first = createCtx();
    stampLocalVoiceRuntimeFence(first.ctx);
    first.useModel.mockImplementation(async (_modelType, params) => {
      tokenStarted.resolve();
      await tokenGate.promise;
      await params.onStreamChunk?.("stale voice token");
      return { text: "stale voice token", thought: THOUGHT };
    });
    const conversation = first.state.conversations.get("conv-1");
    if (!conversation) throw new Error("conversation fixture missing");

    const turn = handleConversationRoutes(first.ctx);
    await tokenStarted.promise;
    first.state.conversations.set("conv-1", { ...conversation });
    tokenGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads.filter((payload) => payload.type === "token")).toEqual([]);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("conversation changed"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it.each(["legacy", "delta-v2"] as const)(
    "publishes finalized action receipts before room bookkeeping and done (%s)",
    async (protocol) => {
      requestStreamProtocol = protocol === "delta-v2" ? protocol : undefined;
      const provisionalDelivered = createDeferred();
      const actionsFinished = createDeferred();
      const bookkeepingGate = createDeferred();
      const finalText = "Browser is open. The page heading is Example Domain.";
      const finalReceipt = {
        success: true,
        text: finalText,
        data: { actionName: "BROWSER_NAVIGATE" },
        values: {
          viewId: "browser",
          viewType: "gui",
          viewPath: "/apps/browser",
          completedActionHandoffId: "final-browser-handoff",
          browser: { url: "https://example.com/" },
        },
      };
      const expectedReceipts = [
        {
          actionName: "BROWSER_NAVIGATE",
          success: true,
          text: finalText,
          values: {
            viewId: "browser",
            viewType: "gui",
            viewPath: "/apps/browser",
            completedActionHandoffId: "final-browser-handoff",
            browser: { url: "https://example.com/" },
          },
        },
      ];
      const messageService = createViewShortcutMessageService();
      messageService.handleMessage = async (runtime, _message, callback) => {
        await callback?.(
          { text: "Opening Browser.", actionStatus: "running" },
          "BROWSER_NAVIGATE",
        );
        provisionalDelivered.resolve();
        await actionsFinished.promise;
        void trackPostDeliveryTask(
          runtime,
          "receipt-bookkeeping-test",
          async () => {
            await bookkeepingGate.promise;
            // Late room work can mutate its original result, but the final client
            // projection must already be a detached, recursively copied snapshot.
            finalReceipt.values.viewId = "settings";
            finalReceipt.values.browser.url = "https://example.org/";
          },
        );
        return {
          didRespond: true,
          responseContent: { text: finalText },
          responseMessages: [],
          actionResults: [finalReceipt],
        };
      };
      const { ctx, record, useModel } = createCtx(messageService);
      vi.mocked(persistAssistantConversationMemory).mockClear();
      const turn = handleConversationRoutes(ctx);
      try {
        await provisionalDelivered.promise;
        const provisionalPayloads = parseSsePayloads(record.writes);
        expect(provisionalPayloads).toContainEqual(
          expect.objectContaining({ type: "token", provisional: true }),
        );
        expect(
          provisionalPayloads.some(
            (payload) =>
              payload.type === "reply_ready" || payload.type === "done",
          ),
        ).toBe(false);
        expect(
          provisionalPayloads.some((payload) => "actionResults" in payload),
        ).toBe(false);

        actionsFinished.resolve();
        await vi.waitFor(() => {
          expect(parseSsePayloads(record.writes)).toContainEqual({
            type: "reply_ready",
            fullText: finalText,
            actionResults: expectedReceipts,
          });
        });
        await vi.waitFor(() => {
          expect(record.ended).toBe(true);
          expect(
            parseSsePayloads(record.writes).some(
              (payload) => payload.type === "done",
            ),
          ).toBe(true);
        });
        expect(persistAssistantConversationMemory).toHaveBeenCalledTimes(1);
        expect(ctx.state.runtime?.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(1);
      } finally {
        actionsFinished.resolve();
        bookkeepingGate.resolve();
        await turn;
      }

      const payloads = parseSsePayloads(record.writes);
      const ready = payloads.filter(
        (payload) => payload.type === "reply_ready",
      );
      const done = payloads.find((payload) => payload.type === "done");
      expect(ready).toHaveLength(1);
      expect(done?.actionResults).toEqual(expectedReceipts);
      expect(done?.actionResults).toEqual(ready[0]?.actionResults);
      expect(
        payloads.findIndex((payload) => payload.type === "reply_ready"),
      ).toBeLessThan(payloads.findIndex((payload) => payload.type === "done"));
      expect(finalReceipt.values.viewId).toBe("settings");
      expect(finalReceipt.values.browser.url).toBe("https://example.org/");
      expect(record.ended).toBe(true);
      expect(useModel).not.toHaveBeenCalled();
    },
  );

  it("finishes durable SSE while post-delivery work keeps the next room turn fenced", async () => {
    const postDeliveryGate = createDeferred();
    const handled: string[] = [];
    let roomState = "before reflection";
    let firstReplyId: string | undefined;
    let firstTimer: ReturnType<typeof getInferenceTimer>;
    const messageService = createViewShortcutMessageService();
    messageService.handleMessage = async (runtime, message) => {
      const text = String(message.content.text);
      handled.push(text);
      if (text === "first fenced turn") {
        firstTimer = getInferenceTimer();
        void trackPostDeliveryTask(
          runtime,
          "deferred-room-reflection",
          async () => {
            await postDeliveryGate.promise;
            const lease = runtime.roomHandlerQueue.currentLease(ROOM_ID);
            expect(runtime.roomHandlerQueue.ownsLease(ROOM_ID, lease)).toBe(
              true,
            );
            roomState = "after reflection";
          },
        );
      } else {
        expect(roomState).toBe("after reflection");
        const memories = await runtime.getMemories({
          roomId: ROOM_ID,
          tableName: "messages",
        });
        expect(memories).toContainEqual(
          expect.objectContaining({
            id: firstReplyId,
            content: expect.objectContaining({
              text: "Completed first fenced turn.",
            }),
          }),
        );
      }
      return {
        didRespond: true,
        responseContent: { text: `Completed ${text}.` },
        responseMessages: [],
      };
    };
    requestPromptQueue.push("first fenced turn", "second fenced turn");
    const first = createCtx(messageService);
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const firstTurn = handleConversationRoutes(first.ctx);
    let secondTurn: Promise<boolean> | undefined;
    try {
      await vi.waitFor(() => expect(first.record.ended).toBe(true));
      const done = parseSsePayloads(first.record.writes).filter(
        (payload) => payload.type === "done",
      );
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({
        fullText: "Completed first fenced turn.",
        messageId: expect.any(String),
      });
      firstReplyId = done[0].messageId as string;
      if (!firstTimer) throw new Error("first turn has no inference timer");
      const deliveredTiming = firstTimer.summary();
      expect(deliveredTiming.closedAtEpochMs).not.toBeNull();
      expect(roomState).toBe("before reflection");
      expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(1);
      // Server background suppression stays active; the browser receives done.
      expect(first.state.activeChatTurnCount).toBe(1);

      const second = createFollowupCtx(first.ctx, first.state);
      secondTurn = handleConversationRoutes(second.ctx);
      await vi.waitFor(() =>
        expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(2),
      );
      expect(handled).toEqual(["first fenced turn"]);
      expect(
        parseSsePayloads(second.record.writes).some(
          (payload) => payload.type === "done",
        ),
      ).toBe(false);
      expect(persistConversationMemory).toHaveBeenCalledTimes(1);

      postDeliveryGate.resolve();
      await Promise.all([firstTurn, secondTurn]);
      expect(firstTimer.summary().closedAtEpochMs).toBe(
        deliveredTiming.closedAtEpochMs,
      );
      expect(firstTimer.summary().totalMs).toBe(deliveredTiming.totalMs);
      expect(handled).toEqual(["first fenced turn", "second fenced turn"]);
      expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
      expect(first.state.activeChatTurnCount).toBe(0);
      expect(runtime.reportError).not.toHaveBeenCalled();
      expect(
        parseSsePayloads(first.record.writes).filter(
          (payload) => payload.type === "done",
        ),
      ).toHaveLength(1);
      expect(
        parseSsePayloads(second.record.writes).filter(
          (payload) => payload.type === "done",
        ),
      ).toHaveLength(1);
    } finally {
      postDeliveryGate.resolve();
      await Promise.all([firstTurn, secondTurn]);
    }
  });

  it("preserves delivered SSE and idempotency when the later room drain fails", async () => {
    const messageService = createViewShortcutMessageService();
    const handleMessage = vi.fn<
      NonNullable<AgentRuntime["messageService"]>["handleMessage"]
    >(async (runtime, _message, callback) => {
      await callback?.({ text: "The action completed." });
      // Quarantine is checked by the real post-delivery drain, after the route's
      // onReplyReady callback has durably settled and delivered this result.
      quarantinePostDeliveryTasks(runtime, new Error("reflection cancelled"));
      return {
        didRespond: true,
        responseContent: { text: "The action completed." },
        responseMessages: [],
      };
    });
    messageService.handleMessage = handleMessage;
    requestClientMessageId = crypto.randomUUID();
    const { ctx, state, record } = createCtx(messageService);

    const failure = await handleConversationRoutes(ctx).then(
      () => undefined,
      (error: unknown) => error,
    );

    const payloads = parseSsePayloads(record.writes);
    const done = payloads.filter((payload) => payload.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ fullText: "The action completed." });
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(record.ended).toBe(true);
    expect(persistAssistantConversationMemory).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({ code: "POST_DELIVERY_DRAIN_CANCELLED" });
    expect(state.activeChatTurnCount).toBe(0);
    expect(state.runtime?.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);

    const replay = createFollowupCtx(ctx, state);
    await handleConversationRoutes(replay.ctx);
    expect(
      parseSsePayloads(replay.record.writes).find(
        (payload) => payload.type === "done",
      ),
    ).toEqual(done[0]);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(persistAssistantConversationMemory).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy reply_ready text-only when there are no action receipts", async () => {
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.find((payload) => payload.type === "reply_ready")).toEqual({
      type: "reply_ready",
      fullText: FINAL_TEXT,
    });
    expect(
      payloads.find((payload) => payload.type === "done"),
    ).not.toHaveProperty("actionResults");
  });

  it("carries a direct VIEWS shortcut result on the terminal done frame", async () => {
    const { ctx, record } = createCtx(createViewShortcutMessageService());

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Navigated to Settings.",
      thought: "Shortcut: app-control:nl:view-navigation",
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          text: "Navigated to Settings.",
          values: { mode: "show", viewId: "settings", viewType: "gui" },
        },
      ],
    });
  });

  it("streams one visible callback when the matching action receipt is internal", async () => {
    requestStreamProtocol = "delta-v2";
    const { ctx, record, state } = createCtx(
      createVisibleCallbackWithInternalReceiptMessageService(),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(runtime.getMemoriesByIds).mockImplementation(async (ids) =>
      ids.map((id) => ({
        id,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "Opened Notes." },
        createdAt: Date.now(),
      })),
    );

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.filter((payload) => payload.type === "token")).toEqual([
      {
        type: "token",
        fullText: "Opened Notes.",
        provisional: true,
      },
    ]);
    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({
      type: "done",
      fullText: "Opened Notes.",
      historyRefreshRequired: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          text: "Opened Notes.",
        },
      ],
    });
    expect(done).not.toHaveProperty("transcriptVisibility");
  });

  it("keeps a failed action callback authoritative through done and persistence", async () => {
    requestStreamProtocol = "delta-v2";
    const expectedFailure =
      "I couldn't find a view called \"home\". You can try listing the available views to see what's there.";
    const { ctx, record } = createCtx(
      createFailedCallbackWithoutSyntheticFallbackMessageService(),
    );
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.filter((payload) => payload.type === "token")).toEqual([
      {
        type: "token",
        fullText: expectedFailure,
        provisional: true,
      },
    ]);
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(JSON.stringify(payloads)).not.toContain("sorry, i hit a snag");
    expect(JSON.stringify(payloads)).not.toContain(
      "I tried to complete that, but the available runtime step failed before it produced a usable result.",
    );

    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({
      type: "done",
      fullText: expectedFailure,
      actionResults: [
        {
          actionName: "VIEWS",
          success: false,
          text: expectedFailure,
        },
      ],
    });
    expect(persistAssistantConversationMemory).toHaveBeenCalledTimes(1);
    expect(persistAssistantConversationMemory).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      expect.objectContaining({ text: expectedFailure }),
      ChannelType.DM,
      expect.any(Number),
      expect.any(String),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("uses this turn's exact persisted response id instead of a room-latest guess", async () => {
    const responseId = stringToUuid("persisted-callback-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "<response>Calendar is ready.</response>" },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Calendar is ready.",
      messageId: responseId,
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
      historyRefreshRequired: true,
    });
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("does not request transcript reload for a generic persisted delivery callback", async () => {
    const responseId = stringToUuid("generic-persisted-callback") as UUID;
    const { ctx, record, state } = createCtx(
      createGenericPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    runtime.updateMemory = vi.fn(async () => true);

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Simple delivery is ready.",
      messageId: responseId,
    });
    expect(done).not.toHaveProperty("historyRefreshRequired");
    expect(runtime.updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: responseId,
        content: expect.objectContaining({
          inReplyTo: stringToUuid("stream-contract-user-msg-store"),
        }),
      }),
    );
  });

  it("reuses the exact message-service commit without a route read or write", async () => {
    const { ctx, record, state } = createCtx(
      createPersistedReplyMessageService(),
    );
    if (!state.runtime) throw new Error("runtime fixture missing");
    const getMemoriesByIds = vi.mocked(state.runtime.getMemoriesByIds);
    getMemoriesByIds.mockClear();

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Already committed by message service.",
      messageId: stringToUuid("message-service-persisted-assistant"),
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
    });
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
    expect(getMemoriesByIds).not.toHaveBeenCalled();
  });

  it("emits an error instead of done when exact callback metadata cannot become durable", async () => {
    const responseId = stringToUuid("callback-write-failure-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValue([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: {
          text: "Calendar is ready.",
          inReplyTo: stringToUuid("stream-contract-user-msg-store"),
        },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => {
      throw new Error("callback metadata write failed");
    });

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
  });

  it("fails closed when callback durability metadata contradicts storage", async () => {
    const transientId = stringToUuid("transient-callback-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(transientId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("fails closed when the callback target is owned by another agent", async () => {
    const responseId = stringToUuid("wrong-agent-id-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: stringToUuid("different-agent"),
        roomId: ROOM_ID,
        content: { text: "Calendar is ready." },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it.each([
    [
      "stream",
      "absent from storage",
      "/api/conversations/conv-1/messages/stream",
      stringToUuid("transient-final-stream"),
    ],
    [
      "json",
      "absent from storage",
      "/api/conversations/conv-1/messages",
      stringToUuid("transient-final-json"),
    ],
    [
      "stream",
      "missing",
      "/api/conversations/conv-1/messages/stream",
      undefined,
    ],
    ["json", "missing", "/api/conversations/conv-1/messages", undefined],
  ] as const)(
    "%s: a final response whose id is %s cannot borrow an older same-text persisted id",
    async (mode, _idState, pathname, transientFinalId) => {
      const persistedEarlyId = stringToUuid(`persisted-early-${mode}`) as UUID;
      const { ctx, record, state } = createCtx(
        createMixedPersistedTransientMessageService(
          persistedEarlyId,
          transientFinalId,
        ),
      );
      const runtime = state.runtime;
      if (!runtime) throw new Error("runtime fixture missing");
      let routeOwnedMemory:
        | {
            id: UUID;
            entityId: UUID;
            agentId: UUID;
            roomId: UUID;
            content: { text: string };
            createdAt: number;
          }
        | undefined;
      vi.mocked(persistAssistantConversationMemory).mockImplementationOnce(
        async (
          callbackRuntime,
          roomId,
          content,
          _channelType,
          _dedupeSinceMs,
          memoryId,
        ) => {
          const persistedId =
            memoryId ?? stringToUuid(`route-persisted-${mode}`);
          routeOwnedMemory = {
            id: persistedId,
            entityId: callbackRuntime.agentId,
            agentId: callbackRuntime.agentId,
            roomId,
            content: {
              text:
                typeof content === "string"
                  ? content
                  : String(content.text ?? ""),
            },
            createdAt: Date.now(),
          };
          return routeOwnedMemory as never;
        },
      );
      vi.mocked(runtime.getMemoriesByIds).mockImplementation(async (ids) => {
        const rows = [];
        if (ids.includes(persistedEarlyId)) {
          rows.push({
            id: persistedEarlyId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now() - 1,
          });
        }
        if (routeOwnedMemory && ids.includes(routeOwnedMemory.id)) {
          rows.push(routeOwnedMemory);
        }
        return rows as never;
      });
      const updateMemory = vi.fn(async () => true);
      runtime.updateMemory = updateMemory;
      let jsonPayload: Record<string, unknown> | undefined;
      if (mode === "json") {
        ctx.pathname = pathname;
        ctx.json = vi.fn((_res, payload) => {
          jsonPayload = payload as Record<string, unknown>;
        });
      }

      await handleConversationRoutes(ctx);

      const terminal =
        mode === "stream"
          ? parseSsePayloads(record.writes).find(
              (payload) => payload.type === "done",
            )
          : jsonPayload;
      const messageId = terminal?.messageId;
      expect(terminal).toMatchObject({ messageId });
      if (mode === "stream") {
        expect(terminal).toMatchObject({ fullText: "Final answer." });
      } else {
        expect(terminal).toMatchObject({ text: "Final answer." });
      }
      expect(typeof messageId).toBe("string");
      expect(messageId).not.toBe(persistedEarlyId);
      expect(messageId).not.toBe(transientFinalId);
      expect(routeOwnedMemory?.id).toBe(messageId);
      expect(updateMemory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong room", stringToUuid("other-room"), AGENT_ID, AGENT_ID],
    ["wrong assistant entity", ROOM_ID, stringToUuid("other-agent"), AGENT_ID],
    ["wrong assistant agent", ROOM_ID, AGENT_ID, stringToUuid("other-agent")],
  ] as const)(
    "refuses to write callback history to an exact target in the %s",
    async (_label, roomId, entityId, agentId) => {
      const targetId = stringToUuid("callback-target") as UUID;
      const { state } = createCtx();
      const runtime = state.runtime;
      if (!runtime) throw new Error("runtime fixture missing");
      vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
        {
          id: targetId,
          entityId,
          agentId,
          roomId,
          content: { text: "Some other turn." },
          createdAt: Date.now(),
        },
      ]);
      const updateMemory = vi.fn(async () => true);
      runtime.updateMemory = updateMemory;

      await expect(
        persistRecentAssistantActionCallbackHistory(
          runtime,
          ROOM_ID,
          ["VIEWS"],
          Date.now(),
          targetId,
        ),
      ).rejects.toThrow("Failed to persist action callback history");
      expect(updateMemory).not.toHaveBeenCalled();
    },
  );

  it("surfaces an exact callback-history update failure before terminal delivery", async () => {
    const targetId = stringToUuid("callback-update-failure") as UUID;
    const { state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: targetId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "Calendar is ready." },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => {
      throw new Error("callback metadata write failed");
    });

    await expect(
      persistRecentAssistantActionCallbackHistory(
        runtime,
        ROOM_ID,
        ["VIEWS"],
        Date.now(),
        targetId,
      ),
    ).rejects.toThrow("Failed to persist action callback history");
  });

  it("rechecks the callback-history fence after lookup and before update", async () => {
    const targetId = stringToUuid("callback-fence-race") as UUID;
    const lookupStarted = createDeferred();
    const lookupGate = createDeferred();
    const { state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockImplementationOnce(async () => {
      lookupStarted.resolve();
      await lookupGate.promise;
      return [
        {
          id: targetId,
          entityId: AGENT_ID,
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          content: { text: "Calendar is ready." },
          createdAt: Date.now(),
        },
      ];
    });
    runtime.updateMemory = vi.fn(async () => true);
    let current = true;

    const persistence = persistRecentAssistantActionCallbackHistory(
      runtime,
      ROOM_ID,
      ["VIEWS"],
      Date.now(),
      targetId,
      undefined,
      () => {
        if (!current) throw new Error("callback history fence changed");
      },
    );
    await lookupStarted.promise;
    current = false;
    lookupGate.resolve();

    await expect(persistence).rejects.toThrow(
      "Failed to persist action callback history",
    );
    expect(runtime.updateMemory).not.toHaveBeenCalled();
  });

  it("marks intentionally transient replies without inventing a durable id", async () => {
    const { ctx, record } = createCtx(createEphemeralReplyMessageService());

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Temporary provider failure.",
      assistantEphemeral: true,
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
      failureKind: "rate_limited",
    });
    expect(done).not.toHaveProperty("messageId");
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it.each([
    "handler_error",
    "missing_capability",
    "persistence_error",
    "planner_exhaustion",
    "context_overflow",
    "generation_timeout",
  ] as const)(
    "preserves the %s discriminator in the direct chat DTO",
    async (failureKind:
      | "handler_error"
      | "missing_capability"
      | "persistence_error"
      | "planner_exhaustion"
      | "context_overflow"
      | "generation_timeout") => {
      const { ctx, record } = createCtx(
        createEphemeralReplyMessageService(failureKind),
      );

      await handleConversationRoutes(ctx);

      const done = parseSsePayloads(record.writes).find(
        (payload) => payload.type === "done",
      );
      expect(done).toMatchObject({
        type: "done",
        fullText: "Temporary provider failure.",
        assistantEphemeral: true,
        failureKind,
      });
      expect(done).not.toHaveProperty("messageId");
      expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
    },
  );

  it.each([
    "coding_mutation_unverified",
    "coding_verification_failed",
    "coding_tool_failure",
  ] as const)(
    "makes typed %s authoritative when callback prose disagrees",
    async (failureKind) => {
      const { ctx, record, state } = createCtx(
        createCallbackTerminalFailureMessageService(failureKind),
      );
      const emitEvent = vi.mocked(
        state.runtime?.emitEvent as NonNullable<AgentRuntime["emitEvent"]>,
      );

      await handleConversationRoutes(ctx);

      const done = parseSsePayloads(record.writes).find(
        (payload) => payload.type === "done",
      );
      const verificationFailed = failureKind === "coding_verification_failed";
      const message = verificationFailed
        ? "Typecheck still fails after repair."
        : "Shell execution failed.";
      const code = verificationFailed
        ? "CODING_VERIFICATION_REPAIR_EXHAUSTED"
        : "SHELL_UNAVAILABLE";
      expect(done).toMatchObject({
        type: "done",
        fullText: message,
        failureKind,
        terminalFailure: {
          kind: failureKind,
          message,
          transient: !verificationFailed,
          code,
        },
      });
      const messageSentCall = emitEvent.mock.calls.find(
        ([eventType]) => eventType === "MESSAGE_SENT",
      );
      expect(messageSentCall?.[1]).toMatchObject({
        message: {
          content: {
            text: message,
            failureKind,
            terminalFailure: {
              kind: failureKind,
              message,
              transient: !verificationFailed,
              code,
            },
          },
        },
      });
    },
  );

  it.each([
    ["provider_issue", undefined, false],
    ["rate_limited", undefined, false],
    ["no_provider", undefined, false],
    ["provider_issue", "delta-v2", false],
    ["rate_limited", "delta-v2", false],
    ["no_provider", "delta-v2", false],
    ["provider_issue", "delta-v2", true],
  ] as const)(
    "preserves a completed action with %s reply status (%s; interrupted=%s) and replays its stream without another mutation",
    async (kind, protocol, interrupted) => {
      requestStreamProtocol = protocol;
      const unavailable = createUnavailableGroundedActionReply({
        kind,
        code: "GROUNDED_REPLY_GENERATION_FAILED",
      });
      const receipt = {
        receiptId: "receipt-1",
        operation: "lifeops.reminder.create",
        resource: { kind: "lifeops.reminder", id: "reminder-1" },
        artifacts: [],
        idempotency: { key: "request-1", replayed: false },
        observedAt: "2026-07-27T18:00:00.000Z",
        outcome: "applied" as const,
        commit: {
          kind: "durable" as const,
          id: "txn-1",
          committedAt: "2026-07-27T18:00:00.000Z",
        },
      };
      const actionResult = {
        success: true,
        text: "Internal action receipt.",
        transcriptVisibility: "internal" as const,
        data: { actionName: "SAVE" },
        effectReceipts: [receipt],
        replyFailure: unavailable.failure,
      };
      const messageService = createViewShortcutMessageService();
      const handleMessage = vi.fn<
        NonNullable<AgentRuntime["messageService"]>["handleMessage"]
      >(async (_runtime, _message, _callback, options) => {
        if (interrupted) {
          options?.onSettledActionResult?.(actionResult);
          throw new Error(
            "Message processing interrupted after committed unavailable reply.",
          );
        }
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          mode: "none" as const,
          terminalFailure: unavailable.failure,
          actionResults: [actionResult],
        };
      });
      messageService.handleMessage = handleMessage;
      requestClientMessageId = crypto.randomUUID();
      const { ctx, record, state, useModel } = createCtx(messageService);
      const emitEvent = vi.mocked(
        state.runtime?.emitEvent as NonNullable<AgentRuntime["emitEvent"]>,
      );
      await handleConversationRoutes(ctx);
      const done = parseSsePayloads(record.writes).find(
        (payload) => payload.type === "done",
      );
      expect(
        parseSsePayloads(record.writes).filter(
          (payload) =>
            payload.type === "token" || payload.type === "reply_ready",
        ),
      ).toEqual([]);
      expect(done).toMatchObject({
        type: "done",
        fullText: unavailable.failure.message,
        failureKind: kind,
        terminalFailure: unavailable.failure,
        actionResults: [{ actionName: "SAVE", success: true }],
      });
      expect(record.writes.join("")).not.toContain("Canned success");
      expect(actionResult.effectReceipts).toEqual([receipt]);
      const emitted = emitEvent.mock.calls.find(
        ([event]) => event === "MESSAGE_SENT",
      );
      expect(emitted?.[1]).toMatchObject({
        message: {
          content: {
            text: unavailable.failure.message,
            elizaSyntheticFailure: true,
            agentVoiced: false,
            replyFailure: unavailable.failure,
            terminalFailure: unavailable.failure,
          },
        },
      });
      const replay = createFollowupCtx(ctx, state);
      await handleConversationRoutes(replay.ctx);
      expect(
        parseSsePayloads(replay.record.writes).find(
          (payload) => payload.type === "done",
        ),
      ).toMatchObject({
        fullText: unavailable.failure.message,
        terminalFailure: unavailable.failure,
      });
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(useModel).not.toHaveBeenCalled();
    },
  );

  it("delivers a post-SSE-init failure as a structured SSE error frame, not an HTTP error", async () => {
    const { ctx, record, useModel } = createCtx();
    // First failure point past the SSE init: storing the user message.
    vi.mocked(persistConversationMemory).mockRejectedValueOnce(
      new Error("db write failed"),
    );

    await handleConversationRoutes(ctx);

    // Headers were already flushed as SSE — the failure may not rewrite them.
    expect(record.headers.status).toBe("200");
    expect(record.headers["Content-Type"]).toBe("text/event-stream");

    const payloads = parseSsePayloads(record.writes);
    expect(payloads[0]).toMatchObject({ type: "status", kind: "thinking" });
    const errorFrame = payloads.find((payload) => payload.type === "error");
    expect(errorFrame).toBeDefined();
    expect(String(errorFrame?.message)).toContain("db write failed");
    // The turn never reached the model, the stream was closed, and the
    // HTTP-mode error helper was never used.
    expect(useModel).not.toHaveBeenCalled();
    expect(record.ended).toBe(true);
    expect(record.writes.join("")).not.toContain("error 500");
  });

  it("delivers a typed grounding failure without calling it a provider outage", async () => {
    const { ctx, record, state, useModel } = createCtx();
    const service = state.runtime?.messageService;
    if (!service) throw new Error("message service fixture missing");
    vi.spyOn(service, "handleMessage").mockRejectedValueOnce(
      Object.assign(new Error("Reply did not pass grounding"), {
        code: "REPLY_GROUNDING_FAILED",
      }),
    );

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      failureKind: "handler_error",
      fullText: "I couldn't verify my reply against the available results.",
    });
    expect(record.writes.join("")).not.toContain("provider issue");
    expect(useModel).not.toHaveBeenCalled();
    expect(service.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("fails a streaming turn immediately when runtime capability is absent", async () => {
    const { ctx, record, state, useModel } = createCtx();
    state.runtime = null;

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads).toContainEqual({
      type: "error",
      message: "Agent is not running",
    });
    expect(useModel).not.toHaveBeenCalled();
    expect(record.ended).toBe(true);
  });

  it("keeps an unrestored conversation retryable while the runtime is starting", async () => {
    const { ctx, record, state, useModel } = createCtx();
    state.runtime = null;
    state.conversations.clear();

    await handleConversationRoutes(ctx);

    expect(record.headers["Content-Type"]).toBeUndefined();
    expect(record.writes.join("")).toContain("error 503");
    expect(record.writes.join("")).not.toContain("error 404");
    expect(state.conversations.size).toBe(0);
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
    expect(record.ended).toBe(true);
  });

  it("keeps pre-SSE validation failures on plain HTTP (conversation not found → 404)", async () => {
    const { ctx, record } = createCtx();
    const brokenCtx = {
      ...ctx,
      pathname: "/api/conversations/missing-conv/messages/stream",
    } as ConversationRouteContext;

    await handleConversationRoutes(brokenCtx);

    // The ctx error helper writes `error <status>: <message>` — no SSE header.
    expect(record.headers["Content-Type"]).toBeUndefined();
    expect(record.writes.join("")).toContain("error 404");
  });

  it("ships bare deltas (no per-token fullText) when the client negotiates delta-v2, and reconstructs the done text", async () => {
    requestStreamProtocol = "delta-v2";
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    const tokens = payloads.filter((payload) => payload.type === "token");
    // These four tokens total ~27 chars — well under the 2048-byte snapshot
    // floor — so EVERY token frame is a pure delta with no fullText key.
    expect(tokens.map((payload) => payload.text)).toEqual(TOKENS);
    for (const token of tokens) {
      expect(token).not.toHaveProperty("fullText");
    }
    // Client semantics (append delta when no fullText) reconstruct the reply.
    const reconstructed = tokens.reduce(
      (acc, token) => acc + String(token.text ?? ""),
      "",
    );
    expect(reconstructed).toBe(FINAL_TEXT);
    // The terminal done frame is the full-text authority in delta framing too.
    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({ type: "done", fullText: FINAL_TEXT });
  });

  it("emits a mid-stream structured rewrite as a fullText-only snapshot frame under delta-v2 (cumulative fullText under legacy)", async () => {
    // "Hello wrld" then "Hello world" is a non-append revise: the route's
    // onStreamChunk → appendIncomingText resolves it to a snapshot replace, so
    // onSnapshot fires with the corrected text.
    const messageService = createChunkPlanMessageService(
      [
        { chunk: "Hello wrld", accumulated: "Hello wrld" },
        { chunk: "Hello world", accumulated: "Hello world" },
      ],
      "Hello world",
      "corrected a typo mid-stream",
    );

    // Delta framing: the append is a bare delta; the revise is a fullText-only
    // snapshot frame (authoritative replace, no `text`).
    requestStreamProtocol = "delta-v2";
    const delta = createCtx(messageService);
    await handleConversationRoutes(delta.ctx);
    const deltaTokens = parseSsePayloads(delta.record.writes).filter(
      (payload) => payload.type === "token",
    );
    expect(deltaTokens).toEqual([
      { type: "token", text: "Hello wrld" },
      { type: "token", fullText: "Hello world" },
    ]);
    // Replay with client semantics (append text; replace on fullText).
    const deltaReconstructed = deltaTokens.reduce((acc, token) => {
      if (typeof token.fullText === "string") return token.fullText;
      return acc + String(token.text ?? "");
    }, "");
    expect(deltaReconstructed).toBe("Hello world");
    const deltaDone = parseSsePayloads(delta.record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(deltaDone).toMatchObject({ fullText: "Hello world" });

    // Legacy framing: BOTH frames carry cumulative fullText (byte-identical to
    // the historical writer), so an un-negotiated client stays correct.
    requestStreamProtocol = undefined;
    const legacy = createCtx(
      createChunkPlanMessageService(
        [
          { chunk: "Hello wrld", accumulated: "Hello wrld" },
          { chunk: "Hello world", accumulated: "Hello world" },
        ],
        "Hello world",
        "corrected a typo mid-stream",
      ),
    );
    await handleConversationRoutes(legacy.ctx);
    const legacyTokens = parseSsePayloads(legacy.record.writes).filter(
      (payload) => payload.type === "token",
    );
    expect(legacyTokens).toEqual([
      { type: "token", text: "Hello wrld", fullText: "Hello wrld" },
      { type: "token", text: "Hello world", fullText: "Hello world" },
    ]);
  });

  // ── Originating-renderer routing identity ────────────────────────────────
  // A chat turn's targeted view navigation depends on one stamping seam: the
  // stream route copies the caller's `X-ElizaOS-Client-Id` header onto the
  // runtime message as `content.metadata.viewClientId`. The VIEWS action reads
  // it to request `delivery: "completed-action"` scoped to that client id, and
  // /api/views/:id/navigate targets the caller's own WebSocket with the
  // `shell:navigate:view` frame instead of broadcasting to every device. If
  // this stamp regresses, agent navigation silently degrades to a global
  // broadcast that navigates unrelated browsers and devices.
  describe("originating-renderer client id stamping (targeted VIEWS delivery)", () => {
    it("stamps the caller's X-ElizaOS-Client-Id onto the turn's content metadata", async () => {
      const captured: Array<Record<string, unknown> | undefined> = [];
      const { ctx, record } = createCtx(
        createMetadataCaptureMessageService(captured),
      );
      ctx.req.headers["x-elizaos-client-id"] = "ui-originating-renderer";

      await handleConversationRoutes(ctx);

      const payloads = parseSsePayloads(record.writes);
      expect(payloads.at(-1)?.type).toBe("done");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.viewClientId).toBe("ui-originating-renderer");
    });

    it("accepts the X-Eliza-Client-Id alias header", async () => {
      const captured: Array<Record<string, unknown> | undefined> = [];
      const { ctx } = createCtx(createMetadataCaptureMessageService(captured));
      ctx.req.headers["x-eliza-client-id"] = "ui-alias-renderer";

      await handleConversationRoutes(ctx);

      expect(captured).toHaveLength(1);
      expect(captured[0]?.viewClientId).toBe("ui-alias-renderer");
    });

    it("keeps the turn unstamped when the header is absent or unsafe", async () => {
      const unsafeHeaders: Array<string | undefined> = [
        undefined,
        "spaces are not a client id",
        "x".repeat(129),
      ];
      for (const header of unsafeHeaders) {
        const captured: Array<Record<string, unknown> | undefined> = [];
        const { ctx } = createCtx(
          createMetadataCaptureMessageService(captured),
        );
        if (header !== undefined) {
          ctx.req.headers["x-elizaos-client-id"] = header;
        }

        await handleConversationRoutes(ctx);

        expect(captured).toHaveLength(1);
        expect(captured[0]?.viewClientId).toBeUndefined();
      }
    });
  });
});
