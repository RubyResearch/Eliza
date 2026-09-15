/**
 * Core coverage of the chat send lifecycle (`useChatSend`): Stop/abort
 * handling, 404 conversation-gone recovery, always-streaming delivery,
 * transient send-failure notices, and the cloud shared→dedicated handoff queue.
 * Real hook under jsdom with a fake API client — deterministic, no live model
 * or network.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatActionResultSummary,
  ChatToolCallEvent,
  ChatTurnStatus,
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import { StreamGenerationError } from "../api/client-base";
import { createNavigateViewHandler } from "../app-navigate-view";
import {
  markPendingCapabilityReady,
  readPendingCapabilityReadyAgentId,
  rememberPendingCapabilityHandoff,
} from "../capability-handoff";
import {
  dispatchCompletedActionNavigation,
  markCompletedActionNavigationHandled,
  resetCompletedActionNavigationForTests,
} from "../completed-action-navigation";
import { CLOUD_HANDOFF_PHASE_EVENT, NAVIGATE_VIEW_EVENT } from "../events";
import { onViewEvent } from "../views/view-event-bus";
import { VIEW_EVENTS } from "../views/view-event-types";
import { readChatDraft, writeChatDraft } from "./ChatComposerContext.hooks";
import type { LoadConversationMessagesResult } from "./internal";
import { listPendingChatTurns } from "./pending-chat-turns";
import {
  buildSendFailureNotice,
  createConversationForFirstSend,
  getSendValidationFailureMessage,
  prewarmSharedChatScope,
  resolveAbortRoomId,
  UNDELIVERED_TURN_NOTICE,
  type UseChatSendDeps,
  useChatSend,
} from "./useChatSend";

const SHARED_BASE = "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123";
const DEDICATED_BASE = "https://agent-456.elizacloud.ai";
const PENDING_CALENDAR_HANDOFF = {
  version: 1 as const,
  kind: "capability_handoff" as const,
  capabilityId: "calendar" as const,
  label: "Calendar",
  availability: "needs_workspace" as const,
  reason: "Calendar access needs your personal workspace.",
  currentTier: "shared" as const,
  requiredTier: "personal" as const,
  nextAction: "upgrade_workspace" as const,
  requiresConfirmation: true,
  cta: { label: "Set up workspace", href: "/cloud/agents/agent-123" },
  continuation: { originalIntent: "Move tomorrow's meeting to 3pm" },
};

function dispatchHandoffPhase(phase: string): void {
  window.dispatchEvent(
    new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
      detail: { agentId: "agent-123", phase },
    }),
  );
}

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    retryConversationReply: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    renameConversation: vi.fn(() => Promise.resolve()),
    truncateConversationMessages: vi.fn(() => Promise.resolve()),
    deleteConversation: vi.fn(() => Promise.resolve({ ok: true })),
    deleteConversationMessage: vi.fn(() =>
      Promise.resolve({ ok: true, deletedCount: 1 }),
    ),
    getBaseUrl: vi.fn(() => ""),
  },
}));

vi.mock("../api", () => ({
  client: mocks.client,
}));

// Stub Capacitor so the REAL `../api/client-cloud` (imported by useChatSend)
// loads cleanly under jsdom. We deliberately do NOT mock client-cloud: these
// freeze tests must exercise the production `isDirectCloudSharedAgentBase`
// classifier, not a hand-copied regex that can silently drift from it.
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
    registerPlugin: () => ({}),
  },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function makeDeps(
  overrides: {
    activeConversationId?: string | null;
    conversations?: Conversation[];
  } = {},
): UseChatSendDeps {
  const conversationsRef = {
    current: overrides.conversations ?? [],
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: [],
  } as MutableRefObject<ConversationMessage[]>;
  const chatPendingImagesRef = {
    current: [],
  } as MutableRefObject<ImageAttachment[]>;

  const setConversations: UseChatSendDeps["setConversations"] = (value) => {
    conversationsRef.current =
      typeof value === "function" ? value(conversationsRef.current) : value;
  };
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  };

  return {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: overrides.activeConversationId ?? null,
    ptySessionsRef: {
      current: [],
    } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: {
      current: overrides.activeConversationId ?? null,
    } as MutableRefObject<string | null>,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef,
    chatReplyTargetRef: { current: null },
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: {
      current: null,
    } as MutableRefObject<AbortController | null>,
    chatSendBusyRef: {
      current: false,
    } as MutableRefObject<boolean>,
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    claimConversationMessagesOwnership: vi.fn(() => 0),
    isConversationMessagesOwnershipCurrent: vi.fn(() => true),
    conversationHydrationEpochRef: { current: 0 },
    registerConversationMessageOverlay: vi.fn(),
    applyConversationMessageOverlayModification: vi.fn(),
    removeConversationMessageStateMessages: vi.fn(),
    discardConversationMessageState: vi.fn(),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
}

function mockStreamingUntilAbort(started: Deferred<void>) {
  mocks.client.sendConversationMessageStream.mockImplementation(
    (
      _id: string,
      _text: string,
      _onToken: (token: string, accumulatedText?: string) => void,
      _channelType: string,
      signal?: AbortSignal,
    ) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    },
  );
}

describe("useChatSend reply-ready view handoff", () => {
  const actionResults: ChatActionResultSummary[] = [
    {
      actionName: "BROWSER_NAVIGATE",
      success: true,
      values: {
        targetId: "workspace",
        subaction: "navigate",
        viewId: "browser",
        viewPath: "/browser",
        tabId: "btab_1",
        url: "https://example.com/",
      },
    },
    {
      actionName: "BROWSER",
      success: true,
      values: {
        targetId: "workspace",
        subaction: "get",
        text: "Example Domain",
      },
    },
  ];
  const terminal = {
    text: "The main heading is Example Domain.",
    completed: true,
    userMessageId: "persisted-user",
    messageId: "persisted-assistant",
    actionResults,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.sendConversationMessageStream.mockReset();
    mocks.client.abortConversationTurn.mockResolvedValue({ aborted: true });
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    window.localStorage.clear();
    window.history.replaceState({}, "", "/notes");
    resetCompletedActionNavigationForTests();
  });

  afterEach(() => {
    resetCompletedActionNavigationForTests();
    window.history.replaceState({}, "", "/chat");
  });

  async function startSend(
    kind: "main" | "action" | "replay" | "cold" | "strict" = "strict",
  ) {
    const started = deferred();
    const done = deferred<typeof terminal>();
    let onReplyReady:
      | ((results: ChatActionResultSummary[]) => void)
      | undefined;
    if (kind === "replay") {
      mocks.client.sendConversationMessageStream.mockRejectedValueOnce(
        http404(),
      );
    }
    mocks.client.sendConversationMessageStream.mockImplementationOnce(
      (...args) => {
        onReplyReady = args[10];
        started.resolve();
        return done.promise;
      },
    );
    const deps = makeDeps({
      activeConversationId: kind === "cold" ? null : "conv-1",
      conversations: kind === "cold" ? [] : [conversation("conv-1", "room-1")],
    });
    const hook = renderHook(() => useChatSend(deps), {
      reactStrictMode: kind === "strict",
    });
    let send: Promise<void> | undefined;
    await act(async () => {
      send =
        kind === "action"
          ? hook.result.current.sendActionMessage(
              "Open the browser and read its heading.",
            )
          : hook.result.current.sendChatText(
              "Open the browser and read its heading.",
            );
      await started.promise;
    });
    return {
      deps,
      hook,
      ready: (results = actionResults) => act(() => onReplyReady?.(results)),
      finish: async (results = actionResults) => {
        await act(async () => {
          done.resolve({ ...terminal, actionResults: results });
          await send;
        });
      },
    };
  }

  it.each(["main", "action", "replay", "cold", "strict"] as const)(
    "hands off the %s Browser receipt before done and deduplicates terminal delivery",
    async (kind) => {
      const navigate = vi.fn((event: Event) => event.preventDefault());
      window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
      const refresh = vi.fn();
      const unsubscribe = onViewEvent(VIEW_EVENTS.VIEW_REFRESH, refresh);
      const send = await startSend(kind);
      try {
        send.ready();
        expect(navigate).toHaveBeenCalledTimes(1);
        expect((navigate.mock.calls[0][0] as CustomEvent).detail).toMatchObject(
          {
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Fexample.com%2F",
            source: "agent",
            completedActionHandoffId: expect.any(String),
          },
        );
        expect(refresh).not.toHaveBeenCalled();
        expect(send.deps.chatSendBusyRef.current).toBe(true);
        if (kind === "main" || kind === "strict") {
          expect(listPendingChatTurns("conv-1")).toHaveLength(1);
        }
        send.ready();
        expect(navigate).toHaveBeenCalledTimes(1);
      } finally {
        await send.finish();
        window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
        unsubscribe();
        send.hook.unmount();
      }
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      if (kind === "main" || kind === "strict") {
        expect(listPendingChatTurns("conv-1")).toHaveLength(0);
      }
    },
  );

  it("opens the actual Browser route at ready and does not pull the user back at done", async () => {
    const handleNavigate = createNavigateViewHandler({
      availableViewsForDesktopTabs: [],
      invokeDesktopBridgeRequest: async () => null,
      openDesktopTab: vi.fn(),
      setActiveDesktopTabId: vi.fn(),
      setTab: vi.fn(),
    });
    const navigate = vi.fn((event: Event) => {
      if (handleNavigate(event)) {
        markCompletedActionNavigationHandled(
          event,
          (event as CustomEvent).detail,
        );
      }
    });
    window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
    const send = await startSend();
    try {
      send.ready();
      expect(window.location.pathname).toBe("/browser");
      expect(new URLSearchParams(window.location.search).get("browse")).toBe(
        "https://example.com/",
      );
      expect(send.deps.chatSendBusyRef.current).toBe(true);
      window.history.pushState({}, "", "/calendar");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await send.finish();
      expect(window.location.pathname).toBe("/calendar");
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      await send.finish();
      window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
      send.hook.unmount();
    }
  });

  it.each(["websocket-first", "ready-first"])(
    "deduplicates %s VIEWS delivery across ready and done",
    async (order) => {
      const results: ChatActionResultSummary[] = [
        {
          actionName: "VIEWS",
          success: true,
          values: {
            mode: "show",
            viewId: "calendar",
            completedActionHandoffId: "views-handoff",
            completedActionDelivered: true,
          },
        },
      ];
      const navigate = vi.fn((event: Event) => event.preventDefault());
      window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
      const send = await startSend();
      const websocket = () =>
        dispatchCompletedActionNavigation({
          viewId: "calendar",
          completedActionHandoffId: "views-handoff",
        });
      try {
        if (order === "websocket-first") websocket();
        send.ready(results);
        if (order === "ready-first") websocket();
        await send.finish(results);
        expect(navigate).toHaveBeenCalledTimes(1);
      } finally {
        await send.finish(results);
        window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
        send.hook.unmount();
      }
    },
  );

  it("offers an unhandled early receipt again at done with the same handoff id", async () => {
    const navigate = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
    const send = await startSend();
    try {
      send.ready();
      expect(navigate).toHaveBeenCalledTimes(1);
      await send.finish();
      expect(navigate).toHaveBeenCalledTimes(2);
      expect(
        (navigate.mock.calls[0][0] as CustomEvent).detail
          .completedActionHandoffId,
      ).toEqual(
        (navigate.mock.calls[1][0] as CustomEvent).detail
          .completedActionHandoffId,
      );
    } finally {
      await send.finish();
      window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
      send.hook.unmount();
    }
  });

  it.each([
    "conversation",
    "generation",
    "base",
    "abort",
    "unmount",
    "navigation",
    "navigation-aba",
  ])(
    "rejects early and terminal navigation after %s ownership changes",
    async (change) => {
      const navigate = vi.fn();
      window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
      const send = await startSend();
      try {
        if (change === "conversation")
          send.deps.activeConversationIdRef.current = "conv-other";
        if (change === "generation")
          vi.mocked(
            send.deps.isConversationMessagesOwnershipCurrent,
          ).mockReturnValue(false);
        if (change === "base")
          mocks.client.getBaseUrl.mockReturnValue("https://other.example");
        if (change === "abort")
          act(() => send.hook.result.current.handleChatStop());
        if (change === "unmount") send.hook.unmount();
        if (change.startsWith("navigation")) {
          window.history.pushState({}, "", "/calendar");
          window.dispatchEvent(new PopStateEvent("popstate"));
          if (change === "navigation-aba") {
            window.history.pushState({}, "", "/notes");
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        }
        send.ready();
        expect(navigate).not.toHaveBeenCalled();
        await send.finish();
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        await send.finish();
        window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
        send.hook.unmount();
      }
    },
  );

  it("does not run workflow, DoorDash, failed navigation, or refresh handoffs early", async () => {
    const navigate = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
    const refresh = vi.fn();
    const unsubscribe = onViewEvent(VIEW_EVENTS.VIEW_REFRESH, refresh);
    const send = await startSend();
    try {
      send.ready([
        {
          actionName: "WORKFLOW",
          success: true,
          values: { workflowId: "workflow-1" },
        },
        {
          actionName: "DOORDASH",
          success: true,
          values: {
            provider: "doordash",
            humanInterventionRequired: true,
            humanInterventionKind: "cloudflare-browser-run",
            liveViewUrl: "https://live.browser.run/session-1",
          },
        },
        { ...actionResults[0], success: false },
      ]);
      expect(navigate).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await send.finish();
      window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
      unsubscribe();
      send.hook.unmount();
    }
  });
});

describe("useChatSend stop handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.abortConversationTurn.mockResolvedValue({
      aborted: true,
      roomId: "room-1",
      reason: "ui-chat-stop",
    });
    mocks.client.stopCodingAgent.mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  it("aborts the backend turn using the latest conversation room id when Stop is clicked", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-1",
      "ui-chat-stop",
    );
  });

  it("aborts a newly created conversation by the room id returned from creation", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-new",
      "ui-chat-stop",
    );
  });

  it("paints the accepted turn before cold conversation creation finishes", async () => {
    const creation = deferred<{ conversation: Conversation }>();
    mocks.client.createConversation.mockReturnValue(creation.promise);
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Hi there",
      completed: true,
    });
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "" },
    ]);

    await act(async () => {
      creation.resolve({
        conversation: conversation("conv-new", "room-new"),
      });
      await sendPromise;
    });
  });

  it("waits for startup conversation hydration before claiming a cold first send", async () => {
    const hydration = deferred();
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Hi there",
      completed: true,
    });
    const deps = makeDeps() as UseChatSendDeps & {
      settleConversationHydrationForSend: () => Promise<boolean>;
    };
    deps.settleConversationHydrationForSend = vi.fn(async () => {
      await hydration.promise;
      deps.activeConversationIdRef.current = "conv-restored";
      deps.conversationsRef.current = [
        conversation("conv-restored", "room-restored"),
      ];
      return true;
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.settleConversationHydrationForSend).toHaveBeenCalledTimes(1);
    expect(deps.conversationMessagesRef.current).toEqual([]);
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    await act(async () => {
      hydration.resolve();
      await sendPromise;
    });

    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(
      mocks.client.sendConversationMessageStream.mock.calls[0]?.slice(0, 2),
    ).toEqual(["conv-restored", "hello"]);
  });

  it("preserves the draft, attachments and reply when recovery is unavailable", async () => {
    const deps: UseChatSendDeps = makeDeps({ activeConversationId: "conv-1" });
    deps.settleConversationHydrationForSend = vi.fn(async () => false);
    deps.chatInputRef.current = "Keep this draft";
    const images: ImageAttachment[] = [
      {
        data: "aGVsbG8=",
        mimeType: "image/png",
        name: "draft.png",
      },
    ];
    deps.chatPendingImagesRef.current = images;
    deps.chatReplyTargetRef.current = {
      messageId: "earlier-message",
      snippet: "Earlier",
      senderName: "Eliza",
    };
    writeChatDraft("conv-1", "Keep this draft");
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatSend();
    });

    expect(deps.chatInputRef.current).toBe("Keep this draft");
    expect(readChatDraft("conv-1")).toBe("Keep this draft");
    expect(deps.chatPendingImagesRef.current).toBe(images);
    expect(deps.chatReplyTargetRef.current?.messageId).toBe("earlier-message");
    expect(deps.setChatInput).not.toHaveBeenCalled();
    expect(deps.setChatPendingImages).not.toHaveBeenCalled();
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("keeps text and action sends unsent when recovery cannot identify a conversation", async () => {
    const deps: UseChatSendDeps = makeDeps();
    deps.settleConversationHydrationForSend = vi.fn(async () => false);
    const { result } = renderHook(() => useChatSend(deps));
    await act(async () => {
      await result.current.sendChatText("Remember this");
      await result.current.sendActionMessage("Continue that action");
    });
    expect(deps.conversationMessagesRef.current).toEqual([]);
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("claims a waiting composer draft once and enqueues it without another recovery gap", async () => {
    const deps: UseChatSendDeps = makeDeps({ activeConversationId: "conv-1" });
    const hydration = deferred<boolean>();
    deps.settleConversationHydrationForSend = vi.fn(() => hydration.promise);
    deps.chatInputRef.current = "Send this once";
    const images: ImageAttachment[] = [
      {
        data: "aGVsbG8=",
        mimeType: "image/png",
        name: "draft.png",
      },
    ];
    deps.chatPendingImagesRef.current = images;
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Received",
      completed: true,
    });
    const { result } = renderHook(() => useChatSend(deps));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleChatSend();
      second = result.current.handleChatSend();
    });
    expect(deps.chatInputRef.current).toBe("Send this once");
    expect(deps.chatPendingImagesRef.current).toBe(images);
    await act(async () => {
      hydration.resolve(true);
      await Promise.all([first, second]);
    });
    expect(deps.settleConversationHydrationForSend).toHaveBeenCalledTimes(2);
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(
      mocks.client.sendConversationMessageStream.mock.calls[0]?.slice(0, 2),
    ).toEqual(["conv-1", "Send this once"]);
    expect(deps.chatInputRef.current).toBe("");
    expect(deps.chatPendingImagesRef.current).toEqual([]);
  });

  it("does NOT surface an error notice when the send is aborted by the user", async () => {
    // A user-initiated stop rejects the stream with AbortError. The send catch
    // has a dedicated abort branch (drop the empty assistant placeholder, return)
    // that must NOT fall through to the error-toast path — a Stop is intentional,
    // not a failure.
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    // The abort path ran (server turn aborted) but no error notice was shown.
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("keeps a locally-committed partial reply after a STOP whose reload lacks it", async () => {
    // STOP mid-stream resolves the stream with the partial + completed:false.
    // The server never persisted the partial, so the post-turn history reload
    // full-replaces local state with ONLY the persisted user turn. The partial
    // the user was watching must survive that reload — re-attached as an
    // interrupted assistant turn.
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("Here is the par", "Here is the par");
        return { text: "Here is the par", completed: false };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // Server full-replace reload: only the persisted user turn survives (the
    // stopped assistant reply was never written server-side). A real persisted
    // turn carries an epoch-ms timestamp at ~send time — required for the
    // #11670 eviction guard to recognize it as this send.
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "server-user-1",
          role: "user",
          text: "hello",
          timestamp: Date.now(),
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const assistantMessages = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe("Here is the par");
    expect(assistantMessages[0].interrupted).toBe(true);
  });

  it("does NOT duplicate the partial when the server persisted the stopped reply", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("Here is the par", "Here is the par");
        return { text: "Here is the par", completed: false };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // Server DID persist the (truncated) reply — the reload carries it, so the
    // partial must not be re-attached a second time. Realistic epoch-ms
    // timestamps (see above).
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "server-user-1",
          role: "user",
          text: "hello",
          timestamp: Date.now(),
        },
        {
          id: "server-asst-1",
          role: "assistant",
          text: "Here is the par",
          timestamp: Date.now(),
          interrupted: true,
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const assistantMessages = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("server-asst-1");
  });

  it.each([
    { text: "", failure: false },
    { text: "  Here is the unfinished **", failure: false },
    { text: "", failure: true },
  ])(
    "renders a durable interrupted terminal immediately (%j)",
    async ({ text, failure }) => {
      const terminalFailure = {
        kind: "provider_issue",
        message: "Generation interrupted during shutdown.",
        transient: true,
        code: "TURN_ABORTED",
      };
      mocks.client.sendConversationMessageStream.mockImplementation(
        async (
          _id: string,
          _text: string,
          onToken: (token: string, accumulatedText?: string) => void,
        ) => {
          if (text) onToken(text, text);
          return {
            text,
            completed: true,
            interrupted: true,
            messageId: "durable-interrupted-assistant",
            userMessageId: "durable-interrupted-user",
            ...(failure
              ? { failureKind: terminalFailure.kind, terminalFailure }
              : {}),
          };
        },
      );
      const deps = makeDeps({
        activeConversationId: "conv-1",
        conversations: [conversation("conv-1", "room-1")],
      });
      const { result } = renderHook(() => useChatSend(deps));

      await act(async () => {
        await result.current.sendChatText("hello", {
          conversationId: "conv-1",
        });
      });

      expect(deps.conversationMessagesRef.current).toEqual([
        expect.objectContaining({
          id: "durable-interrupted-user",
          role: "user",
          text: "hello",
        }),
        expect.objectContaining({
          id: "durable-interrupted-assistant",
          role: "assistant",
          text,
          interrupted: true,
          ...(failure
            ? { failureKind: terminalFailure.kind, terminalFailure }
            : {}),
        }),
      ]);
      expect(deps.loadConversationMessages).not.toHaveBeenCalled();
      expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(
        1,
      );
      expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
      expect(mocks.client.renameConversation).not.toHaveBeenCalled();
      expect(deps.setActionNotice).not.toHaveBeenCalled();
    },
  );

  it("shows durable server history without a stale fallback after an empty interrupted stream", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: false,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "server-user-home",
          role: "user",
          text: "go home",
          timestamp: Date.now(),
        },
        {
          id: "server-assistant-home",
          role: "assistant",
          text: "Opened Home.",
          timestamp: Date.now(),
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("go home", {
        conversationId: "conv-1",
      });
    });

    expect(deps.conversationMessagesRef.current).toEqual([
      expect.objectContaining({ role: "user", text: "go home" }),
      expect.objectContaining({ role: "assistant", text: "Opened Home." }),
    ]);
  });

  it("keeps the pending-turn receipt when page teardown aborts an active send", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const view = renderHook(() => useChatSend(deps));

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = view.result.current.sendChatText("survive reload", {
        conversationId: "conv-1",
      });
      await started.promise;
    });
    expect(listPendingChatTurns("conv-1")).toHaveLength(1);

    view.unmount();
    await act(async () => {
      await sendPromise;
    });

    expect(listPendingChatTurns("conv-1")).toMatchObject([
      { conversationId: "conv-1", text: "survive reload" },
    ]);
  });

  it("clears the pending-turn receipt after an explicit Stop", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendChatText("stop settles", {
        conversationId: "conv-1",
      });
      await started.promise;
    });
    expect(listPendingChatTurns("conv-1")).toHaveLength(1);

    await act(async () => {
      result.current.handleChatStop();
      await sendPromise;
    });

    expect(listPendingChatTurns("conv-1")).toHaveLength(0);
  });
});

describe("useChatSend clear ownership race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("does not clear B when deleting A resolves after the user selected B", async () => {
    const deletion = deferred<{ ok: boolean }>();
    mocks.client.deleteConversation.mockReturnValueOnce(deletion.promise);
    const deps = makeDeps({
      activeConversationId: "conv-A",
      conversations: [
        conversation("conv-A", "room-A"),
        conversation("conv-B", "room-B"),
      ],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let clearing: Promise<void>;
    act(() => {
      clearing = result.current.handleChatClear();
    });
    const bMessages: ConversationMessage[] = [
      { id: "b-user", role: "user", text: "B stays", timestamp: 1 },
    ];
    deps.activeConversationIdRef.current = "conv-B";
    deps.conversationMessagesRef.current = bMessages;

    await act(async () => {
      deletion.resolve({ ok: true });
      await clearing;
    });

    expect(deps.activeConversationIdRef.current).toBe("conv-B");
    expect(deps.conversationMessagesRef.current).toEqual(bMessages);
    expect(deps.discardConversationMessageState).toHaveBeenCalledWith("conv-A");
    expect(deps.setActiveConversationId).not.toHaveBeenCalledWith(null);
    expect(mocks.client.sendWsMessage).not.toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: null,
    });
  });
});

function http404(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function mockStream404() {
  mocks.client.sendConversationMessageStream.mockRejectedValue(http404());
}

describe("useChatSend 404 recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("keeps the user message + notifies when the agent is gone (cloud base createConversation 404)", async () => {
    // Regression: on a cloud agent base a send-404 fell through to recreate the
    // conversation, which ALSO 404s when the agent is deleted/unreachable — the
    // old code silently dropped the user's message. Now it surfaces a notice and
    // keeps the user bubble.
    mockStream404();
    mocks.client.createConversation.mockRejectedValue(http404());
    mocks.client.getBaseUrl.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("no longer reachable"),
      "error",
      expect.any(Number),
    );
    // The user message is preserved (only the empty assistant placeholder is
    // dropped).
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });

  it("recreates the conversation and replays as a token STREAM when only the conversation was deleted", async () => {
    // The normal recoverable case: the conversation row was deleted but the
    // agent is fine. createConversation succeeds, and the message is REPLAYED
    // through the streaming endpoint (not the non-streaming one) so the reply
    // tokens in rather than popping in all at once (#10231).
    const replayTokens: Array<[string, string]> = [];
    mocks.client.sendConversationMessageStream
      .mockRejectedValueOnce(http404())
      .mockImplementationOnce(
        async (
          _id: string,
          _text: string,
          onToken: (token: string, accumulatedText?: string) => void,
        ) => {
          onToken("hi", "hi");
          onToken(" back", "hi back");
          replayTokens.push(["hi", " back"]);
          return { text: "hi back", completed: true };
        },
      );
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    mocks.client.getBaseUrl.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123",
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).not.toHaveBeenCalled();
    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    // Original send (404) + streaming replay = two stream calls; the
    // non-streaming endpoint is never used.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
    // The replay actually streamed tokens.
    expect(replayTokens).toEqual([["hi", " back"]]);
    expect(deps.setChatFirstTokenReceived).toHaveBeenCalledWith(true);
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && m.text === "hi back"),
    ).toBe(true);
  });

  it("surfaces a send-failure notice on a non-cloud base when createConversation 404s (#12267: a silent return read as a lost message)", async () => {
    mockStream404();
    mocks.client.createConversation.mockRejectedValue(http404());
    mocks.client.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    // The recovery could not produce a conversation to replay into: the user
    // must see the failure instead of a message that silently vanished.
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringMatching(/didn't go through/i),
      "error",
      8_000,
    );
    // The stuck empty assistant placeholder is still dropped.
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });
});

describe("useChatSend thrown 402 insufficient_credits mapping (#18045)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("renders the out-of-credits turn instead of a generic provider_issue Retry chip", async () => {
    // The canonical Cloud 402 gate arrives as a THROWN ApiError (the send was
    // refused before any stream frame), so the stream-frame failureKind path
    // never runs. It must map to the designed out-of-credits state — retrying
    // just re-hits the same empty balance.
    const gateMessage = "You're out of credits. Add funds to continue.";
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error(gateMessage), {
        status: 402,
        code: "insufficient_credits",
        data: { error: gateMessage, code: "insufficient_credits" },
      }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    const remaining = deps.conversationMessagesRef.current;
    // The user bubble survives, and the assistant turn is the structured gate
    // (banner + CTA render off failureKind), not a retryable failure.
    expect(
      remaining.some((m) => m.role === "user" && m.text === "hello there"),
    ).toBe(true);
    const gateTurn = remaining.find(
      (m) => m.role === "assistant" && m.failureKind === "insufficient_credits",
    );
    expect(gateTurn?.text).toBe(gateMessage);
    expect(remaining.some((m) => m.failureKind === "provider_issue")).toBe(
      false,
    );
    // No generic transport error notice competes with the designed gate.
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("leaves a codeless 402 on the generic failure path (fail-closed classifier)", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("Payment Required"), { status: 402 }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello there", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (m) => m.failureKind === "insufficient_credits",
      ),
    ).toBe(false);
    expect(deps.setActionNotice).toHaveBeenCalled();
  });
});

describe("useChatSend always streams (#9174)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  it("uses the streaming endpoint on the happy path and never the non-streaming one", async () => {
    const tokens: Array<[string, string]> = [];
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        // Cloud + local both drive the UI through this same callback.
        onToken("Hello", "Hello");
        onToken(" world", "Hello world");
        tokens.push(["Hello", " world"]);
        return {
          text: "Hello world",
          completed: true,
          userMessageId: "persisted-user",
          messageId: "persisted-assistant",
        };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // Happy path streams.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    // The non-streaming endpoint is never used — even 404 recovery streams now
    // (#10231).
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
    // Streaming context is active by default — the first-token signal fired as
    // tokens arrived through onToken.
    expect(deps.setChatFirstTokenReceived).toHaveBeenCalledWith(true);
    // The streaming callback actually received incremental tokens.
    expect(tokens).toEqual([["Hello", " world"]]);
    // A normal committed terminal frame updates the optimistic ids in place.
    // No history reload/DB read or full transcript replacement is needed.
    expect(deps.loadConversationMessages).not.toHaveBeenCalled();
    expect(
      deps.conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(
      expect.arrayContaining(["persisted-user", "persisted-assistant"]),
    );
  });
});

describe("useChatSend action handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/chat");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders and retains an action-only capability receipt from the matching Shared agent", async () => {
    mocks.client.getBaseUrl.mockReturnValue(SHARED_BASE);
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
      messageId: "persisted-capability-receipt",
      actionResults: [
        {
          actionName: "REQUEST_PERSONAL_WORKSPACE",
          success: false,
          values: {
            capabilityHandoff: {
              version: 1,
              kind: "capability_handoff",
              capabilityId: "calendar",
              label: "Calendar",
              availability: "needs_workspace",
              reason: "Calendar access needs your personal workspace.",
              currentTier: "shared",
              requiredTier: "personal",
              nextAction: "upgrade_workspace",
              requiresConfirmation: true,
              cta: {
                label: "Set up workspace",
                href: "/cloud/agents/agent-123",
              },
              continuation: {
                clientMessageId: "client-calendar-1",
                originalIntent: "Move tomorrow's meeting to 3pm",
              },
            },
          },
        },
      ],
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("move tomorrow's meeting", {
        conversationId: "conv-1",
      });
    });

    const receipt = deps.conversationMessagesRef.current.find(
      (message) => message.id === "persisted-capability-receipt",
    );
    expect(receipt?.capabilityHandoff).toMatchObject({
      capabilityId: "calendar",
      cta: { href: "/cloud/agents/agent-123" },
      continuation: { originalIntent: "Move tomorrow's meeting to 3pm" },
    });
    expect(
      window.sessionStorage.getItem(
        "eliza:capability-handoff:message:persisted-capability-receipt",
      ),
    ).toContain('"kind":"capability_handoff"');
  });

  it("opens the completed action target without a WebSocket frame or global-state fetch", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Opening Calendar.",
      completed: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "show", viewId: "calendar" },
        },
      ],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open calendar", {
        conversationId: "conv-1",
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.detail).toEqual({
      viewId: "calendar",
      source: "agent",
      completedActionHandoffId: expect.any(String),
    });
    expect(deps.setActionNotice).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });

  it("does not repeat navigation already delivered to the originating renderer", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Opening Calendar.",
      completed: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          values: {
            mode: "show",
            viewId: "calendar",
            completedActionDelivered: true,
          },
        },
      ],
    });
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open calendar", {
        conversationId: "conv-1",
      });
    });

    expect(navigations).toHaveLength(0);
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });

  it("retains terminal fallback when send-count delivery has a renderer handoff id", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Opening Calendar.",
      completed: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          values: {
            mode: "show",
            viewId: "calendar",
            completedActionDelivered: true,
            completedActionHandoffId: "handoff-not-yet-observed",
          },
        },
      ],
    });
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open calendar", {
        conversationId: "conv-1",
      });
    });

    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.detail).toMatchObject({
      viewId: "calendar",
      completedActionHandoffId: "handoff-not-yet-observed",
    });
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });

  it("invalidates mounted views after a successful REST-streamed action", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: 'Created sticky note "LP3 Demo Proof".',
      completed: true,
      actionResults: [
        {
          actionName: "CREATE_NOTE",
          success: true,
        },
      ],
    });
    const refreshEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = onViewEvent(VIEW_EVENTS.VIEW_REFRESH, (event) => {
      refreshEvents.push(event.payload);
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("create the demo note", {
        conversationId: "conv-1",
      });
    });

    expect(refreshEvents).toEqual([{ actionNames: ["CREATE_NOTE"] }]);
    unsubscribe();
  });

  it("does not restore a duplicate turn after a callback-only action confirms the user message", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
      userMessageId: "persisted-upload-user",
      historyRefreshRequired: true,
      actionResults: [{ actionName: "ATTACHMENT", success: true }],
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "persisted-upload-user",
          role: "user",
          text: "read the upload",
          timestamp: Date.now(),
        },
        {
          id: "persisted-upload-answer",
          role: "assistant",
          text: "NAVIGATOR-7390",
          timestamp: Date.now() + 1,
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("read the upload", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
    expect(
      deps.conversationMessagesRef.current.some(
        (message) => message.text === UNDELIVERED_TURN_NOTICE,
      ),
    ).toBe(false);
  });

  it("preserves a completed turn when the post-send history refresh temporarily lags its receipts", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Hello from Eliza.",
      completed: true,
      userMessageId: "persisted-current-user",
      messageId: "persisted-current-assistant",
      historyRefreshRequired: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const staleHistory: ConversationMessage[] = [
      {
        id: "persisted-older-user",
        role: "user",
        text: "Earlier question",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "persisted-older-assistant",
        role: "assistant",
        text: "Earlier answer",
        timestamp: Date.now() - 59_000,
      },
    ];
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      // Real Cloud history can be briefly behind the successful stream receipt.
      // It is still authoritative for older rows, but must not erase the exact
      // just-completed turn while those receipt ids converge into the listing.
      deps.setConversationMessages(staleHistory);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello with unique marker", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.map(({ id, role, text }) => ({
        id,
        role,
        text,
      })),
    ).toEqual([
      ...staleHistory.map(({ id, role, text }) => ({ id, role, text })),
      {
        id: "persisted-current-user",
        role: "user",
        text: "hello with unique marker",
      },
      {
        id: "persisted-current-assistant",
        role: "assistant",
        text: "Hello from Eliza.",
      },
    ]);
  });

  it("does not duplicate a completed turn once history contains both receipt ids", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Hello from Eliza.",
      completed: true,
      userMessageId: "persisted-current-user",
      messageId: "persisted-current-assistant",
      historyRefreshRequired: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([
        {
          id: "persisted-current-user",
          role: "user",
          text: "hello with unique marker",
          timestamp: Date.now(),
        },
        {
          id: "persisted-current-assistant",
          role: "assistant",
          text: "Hello from Eliza.",
          timestamp: Date.now() + 1,
        },
      ]);
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello with unique marker", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.filter(
        (message) => message.id === "persisted-current-user",
      ),
    ).toHaveLength(1);
    expect(
      deps.conversationMessagesRef.current.filter(
        (message) => message.id === "persisted-current-assistant",
      ),
    ).toHaveLength(1);
  });

  it("opens a workflow created by a completed chat action", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: 'Created workflow "Daily digest".',
      completed: true,
      actionResults: [
        {
          actionName: "WORKFLOW",
          success: true,
          values: {
            workflowId: "workflow-daily-digest",
            workflowName: "Daily digest",
          },
        },
      ],
    });
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("create a daily digest workflow", {
        conversationId: "conv-1",
      });
    });

    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.detail).toEqual({
      viewId: "automations",
      viewPath: "/automations#automations/workflow-daily-digest",
    });
    expect(deps.setActionNotice).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });

  it("keeps VIEWS navigation authoritative when a turn also returns a workflow id", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Opening Calendar.",
      completed: true,
      actionResults: [
        {
          actionName: "WORKFLOW",
          success: true,
          values: { workflowId: "workflow-secondary" },
        },
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "show", viewId: "calendar" },
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              currentView: {
                viewId: "calendar",
                viewPath: "/calendar",
                viewLabel: "Calendar",
                viewType: "gui",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open the calendar after creating it", {
        conversationId: "conv-1",
      });
    });

    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.detail).toMatchObject({
      viewId: "calendar",
    });
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });

  it("ignores an unavailable global current-view endpoint for caller-owned navigation", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Opening Calendar.",
      completed: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "show", viewId: "calendar" },
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 })),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open calendar", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).not.toHaveBeenCalled();
    expect(
      deps.conversationMessagesRef.current.some(
        (message) =>
          message.role === "assistant" && message.text === "Opening Calendar.",
      ),
    ).toBe(true);
  });
});

describe("useChatSend streaming-burst coalescing (text + status + tool)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  it("parks token+status+tool from one SSE burst into one microtask, committing all three together", async () => {
    // Capture the per-event callbacks from a stream that stays pending so the
    // microtask can be observed BEFORE the terminal synchronous flush.
    let onTokenCb!: (t: string, a?: string) => void;
    let onStatusCb!: (s: ChatTurnStatus) => void;
    let onToolCb!: (e: ChatToolCallEvent) => void;
    let resolveStream!: (v: { text: string; completed: boolean }) => void;
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
        onTool: (e: ChatToolCallEvent) => void,
      ) => {
        onTokenCb = onToken;
        onStatusCb = onStatus;
        onToolCb = onTool;
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
      // Let the send reach the streaming call and register the callbacks.
      await Promise.resolve();
      await Promise.resolve();
    });

    // One SSE burst: a token, a status phase, and a tool call all arrive in the
    // same tick — before the queued microtask runs.
    act(() => {
      onTokenCb("Search", "Search");
      onStatusCb({ kind: "running_tool", toolName: "web_search" });
      onToolCb({ phase: "call", callId: "c1", toolName: "web_search" });
      const assistantBefore = deps.conversationMessagesRef.current.find(
        (m) => m.role === "assistant",
      );
      expect(assistantBefore?.text ?? "").toBe("");
      expect(assistantBefore?.toolEvents ?? []).toHaveLength(0);
      expect(setStatusSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "running_tool" }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const assistantAfter = deps.conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    );
    expect(assistantAfter?.text).toBe("Search");
    expect(assistantAfter?.toolEvents ?? []).toHaveLength(1);
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "running_tool", toolName: "web_search" }),
    );

    // Terminal transition: resolve the stream and drain.
    await act(async () => {
      resolveStream({ text: "Search done", completed: true });
      await sendPromise;
    });
  });

  it("flushes parked tool/status synchronously on the terminal transition even if no frame ran", async () => {
    // A tool event + status arrive, then the stream resolves in the SAME tick
    // before any microtask runs. The synchronous flushStreamingText() before the
    // terminal modification must still commit them (no lost tool row / status).
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
        onTool: (e: ChatToolCallEvent) => void,
      ) => {
        onToken("partial", "partial");
        onStatus({ kind: "running_tool", toolName: "web_search" });
        onTool({ phase: "call", callId: "c1", toolName: "web_search" });
        // No queued flush between here and return — the terminal path must flush.
        return { text: "partial done", completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // The tool row survived to the final thread (merged before the reload's
    // no-op) and the status phase was committed at least once.
    expect(setStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "running_tool" }),
    );
    // Status is cleared to null when the turn settles.
    expect(setStatusSpy).toHaveBeenLastCalledWith(null);
  });

  it("settles the visible reply before a slow post-turn history reload", async () => {
    const historyReload = deferred<LoadConversationMessagesResult>();
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
      ) => {
        onStatus({ kind: "running_action", actionName: "REPLY" });
        onToken("Done", "Done");
        return { text: "Done", completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.loadConversationMessages = vi.fn(() => historyReload.promise);
    const setSendingSpy = deps.setChatSending as ReturnType<typeof vi.fn>;
    const setStatusSpy = deps.setServerTurnStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
    });

    await vi.waitFor(() => {
      expect(deps.loadConversationMessages).toHaveBeenCalledWith("conv-1");
    });

    // The response text is already visible, so history reconciliation must not
    // keep the turn spinner/status alive while its request is still pending.
    expect(setStatusSpy).toHaveBeenLastCalledWith(null);
    expect(setSendingSpy).toHaveBeenLastCalledWith(false);

    await act(async () => {
      historyReload.resolve({ ok: true });
      await sendPromise;
    });
  });

  it("does not project a prior conversation's token, status, tool, completion, or reconcile into the active transcript", async () => {
    let onTokenCb!: (t: string, a?: string) => void;
    let onStatusCb!: (s: ChatTurnStatus) => void;
    let onToolCb!: (e: ChatToolCallEvent) => void;
    let resolveStream!: (v: { text: string; completed: boolean }) => void;
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (s: ChatTurnStatus) => void,
        onTool: (e: ChatToolCallEvent) => void,
      ) => {
        onTokenCb = onToken;
        onStatusCb = onStatus;
        onToolCb = onTool;
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );
    const convBMessages: ConversationMessage[] = [
      {
        id: "b-user",
        role: "user",
        text: "B stays visible",
        timestamp: 10,
      },
    ];
    const deps = makeDeps({
      activeConversationId: "conv-A",
      conversations: [conversation("conv-A", "room-A")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendChatText("A send", {
        conversationId: "conv-A",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    deps.activeConversationIdRef.current = "conv-B";
    deps.conversationMessagesRef.current = convBMessages;
    act(() => {
      onTokenCb("A leaked token", "A leaked token");
      onStatusCb({ kind: "running_tool", toolName: "search" });
      onToolCb({ phase: "call", callId: "call-A", toolName: "search" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      resolveStream({ text: "A final reply", completed: true });
      await sendPromise;
    });

    expect(deps.conversationMessagesRef.current).toEqual(convBMessages);
    expect(deps.setServerTurnStatus).not.toHaveBeenCalledWith({
      kind: "running_tool",
      toolName: "search",
    });
    expect(deps.loadConversationMessages).not.toHaveBeenCalledWith("conv-A");
  });
});

function httpStatusError(status: number, message = "Error"): Error {
  return Object.assign(new Error(message), { status });
}

describe("useChatSend non-404 send failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces a notice + keeps the user message on a transient (non-404) send failure", async () => {
    // Regression: non-404 send failures (network drop mid-stream / 5xx) fell to
    // a silent else branch that only reloaded — the typing dots vanished with no
    // error, reading as "my message was lost". Now it drops only the empty
    // assistant placeholder, keeps the user bubble, and surfaces a notice.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Service Unavailable"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("are you there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("waking up"),
      "error",
      expect.any(Number),
    );
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some((m) => m.role === "user" && m.text === "are you there"),
    ).toBe(true);
    expect(
      remaining.some((m) => m.role === "assistant" && !m.text.trim()),
    ).toBe(false);
  });

  it("distinguishes a first-token timeout from a network drop in the notice copy", async () => {
    // A timeout means the agent WAS reached but did not respond in time, so
    // "check your connection" is the wrong remedy. Timeout → slow-response copy;
    // a genuine network drop keeps the connection copy.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("Request timed out"), { kind: "timeout" }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("are you there", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("took too long"),
      "error",
      expect.any(Number),
    );
    // Must NOT show the misleading network/connection copy for a timeout.
    expect(deps.setActionNotice).not.toHaveBeenCalledWith(
      expect.stringContaining("check your connection"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("surfaces a genuine network drop immediately", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("Failed to fetch"), { kind: "network" }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", {
        conversationId: "conv-1",
      });
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("check your connection"),
      "error",
      expect.any(Number),
    );
  });

  it("does not reload (which could re-fail) on an auth-failure send error, and notifies", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(401, "Unauthorized"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("sign in again"),
      "error",
      expect.any(Number),
    );
    // Auth failures skip the reconcile reload (it would just fail again).
    expect(deps.loadConversationMessages).not.toHaveBeenCalled();
  });
});

describe("useChatSend freeze-on-shared during handoff (PR2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.client.getBaseUrl.mockReturnValue(SHARED_BASE);
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  it("retains a ready continuation until first-run releases the composer", async () => {
    rememberPendingCapabilityHandoff(PENDING_CALENDAR_HANDOFF);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    let firstRunComplete = false;
    const view = renderHook(() => useChatSend({ ...deps, firstRunComplete }));

    expect(markPendingCapabilityReady("agent-123")).toBe(true);

    expect(deps.setChatInput).not.toHaveBeenCalled();
    expect(readPendingCapabilityReadyAgentId()).toBe("agent-123");

    firstRunComplete = true;
    await act(async () => view.rerender());

    expect(deps.setChatInput).toHaveBeenCalledWith(
      "Move tomorrow's meeting to 3pm",
    );
    expect(readPendingCapabilityReadyAgentId()).toBeNull();
  });

  it("paints two accepted user turns immediately, then drains each matching assistant placeholder FIFO exactly once", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        text: string,
        onToken: (token: string, accumulatedText?: string) => void,
        _channelType: string,
        _signal: AbortSignal,
        _images: unknown,
        _metadata: unknown,
        onStatus: (status: ChatTurnStatus) => void,
      ) => {
        onStatus({ kind: "thinking" });
        const response = `reply:${text}`;
        onToken(response, response);
        return { text: response, completed: true };
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    act(() => dispatchHandoffPhase("migrating"));

    let firstSend!: Promise<void>;
    let secondSend!: Promise<void>;
    await act(async () => {
      firstSend = result.current.sendChatText("first", {
        conversationId: "conv-1",
      });
      secondSend = result.current.sendChatText("second", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    const queuedUsers = deps.conversationMessagesRef.current;
    expect(queuedUsers.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
    ]);
    expect(new Set(queuedUsers.map(({ id }) => id)).size).toBe(2);
    expect(deps.setServerTurnStatus).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    const assistantIds = queuedUsers.map(
      ({ id }) => `temp-resp-${id.slice("temp-".length)}`,
    );
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    await act(async () => {
      dispatchHandoffPhase("switched");
      await Promise.all([firstSend, secondSend]);
    });

    expect(
      mocks.client.sendConversationMessageStream.mock.calls.map(
        ([, text]) => text,
      ),
    ).toEqual(["first", "second"]);
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    expect(
      assistantIds.map((id) => {
        const message = deps.conversationMessagesRef.current.find(
          (candidate) => candidate.id === id,
        );
        return {
          id: message?.id,
          clientRenderId: message?.clientRenderId,
          text: message?.text,
        };
      }),
    ).toEqual([
      {
        id: assistantIds[0],
        clientRenderId: assistantIds[0],
        text: "reply:first",
      },
      {
        id: assistantIds[1],
        clientRenderId: assistantIds[1],
        text: "reply:second",
      },
    ]);
    expect(deps.setServerTurnStatus).toHaveBeenCalledWith({
      kind: "thinking",
    });
    expect(deps.setServerTurnStatus).toHaveBeenLastCalledWith(null);
  });

  it("keeps prefixed commands drain-painted instead of flashing a user-only queued row", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    act(() => dispatchHandoffPhase("migrating"));

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendChatText("$ unsupported", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    expect(deps.conversationMessagesRef.current).toEqual([]);

    await act(async () => {
      dispatchHandoffPhase("switched");
      await sendPromise;
    });

    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: "$ unsupported" },
      {
        role: "assistant",
        text: "Use bare `$` only. `$ <text>` is not supported.",
      },
    ]);
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("cancels only queued identities, restores their text and image, and leaves the active user row intact", async () => {
    const activeStarted = deferred();
    mockStreamingUntilAbort(activeStarted);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));
    const queuedImage: ImageAttachment = {
      data: "AAAA",
      mimeType: "image/png",
      name: "queued.png",
    };

    let activeSend!: Promise<void>;
    await act(async () => {
      activeSend = result.current.sendChatText("active", {
        conversationId: "conv-1",
      });
      await activeStarted.promise;
    });

    let queuedSend!: Promise<void>;
    await act(async () => {
      queuedSend = result.current.sendChatText("queued", {
        conversationId: "conv-1",
        images: [queuedImage],
      });
      await Promise.resolve();
    });

    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([
      { role: "user", text: "active" },
      { role: "assistant", text: "" },
      { role: "user", text: "queued" },
    ]);

    await act(async () => {
      result.current.handleChatStop();
      await Promise.all([activeSend, queuedSend]);
    });

    expect(
      deps.conversationMessagesRef.current.map(({ role, text }) => ({
        role,
        text,
      })),
    ).toEqual([{ role: "user", text: "active" }]);
    expect(deps.setChatInput).toHaveBeenCalledWith("queued");
    expect(deps.setChatPendingImages).toHaveBeenCalledWith([queuedImage]);
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
  });

  it("restores only the visible conversation draft when Stop races a conversation switch", async () => {
    const activeStarted = deferred();
    let sendCount = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _id: string,
        text: string,
        _onToken: (token: string, accumulatedText?: string) => void,
        _channelType: string,
        signal?: AbortSignal,
      ) => {
        sendCount += 1;
        if (sendCount > 1) {
          return Promise.resolve({ text: `reply:${text}`, completed: true });
        }
        activeStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      },
    );
    const deps = makeDeps({
      activeConversationId: "conv-A",
      conversations: [
        conversation("conv-A", "room-A"),
        conversation("conv-B", "room-B"),
      ],
    });
    const { result } = renderHook(() => useChatSend(deps));
    const imageA: ImageAttachment = {
      data: "AAAA",
      mimeType: "image/png",
      name: "a.png",
    };
    const imageB: ImageAttachment = {
      data: "BBBB",
      mimeType: "image/png",
      name: "b.png",
    };

    let activeSend!: Promise<void>;
    await act(async () => {
      activeSend = result.current.sendChatText("active A", {
        conversationId: "conv-A",
      });
      await activeStarted.promise;
    });

    let queuedA!: Promise<void>;
    await act(async () => {
      queuedA = result.current.sendChatText("queued A", {
        conversationId: "conv-A",
        images: [imageA],
      });
      await Promise.resolve();
    });

    const visibleBMessages: ConversationMessage[] = [
      { id: "b-existing", role: "user", text: "B stays", timestamp: 1 },
    ];
    deps.activeConversationIdRef.current = "conv-B";
    deps.conversationMessagesRef.current = visibleBMessages;
    let queuedB!: Promise<void>;
    await act(async () => {
      queuedB = result.current.sendChatText("queued B", {
        conversationId: "conv-B",
        images: [imageB],
      });
      await Promise.resolve();
    });

    await act(async () => {
      result.current.handleChatStop();
      await Promise.all([activeSend, queuedA, queuedB]);
    });

    expect(deps.conversationMessagesRef.current).toEqual(visibleBMessages);
    expect(deps.setChatInput).toHaveBeenCalledWith("queued B");
    expect(deps.setChatInput).not.toHaveBeenCalledWith(
      expect.stringContaining("queued A"),
    );
    expect(deps.setChatPendingImages).toHaveBeenCalledWith([imageB]);
    expect(deps.setChatPendingImages).not.toHaveBeenCalledWith([imageA]);
    expect(
      mocks.client.sendConversationMessageStream.mock.calls.map(
        ([conversationId, text]) => [conversationId, text],
      ),
    ).toEqual([
      ["conv-A", "active A"],
      ["conv-A", "queued A"],
    ]);
  });

  it("queues a message sent during the handoff window and delivers it to the dedicated agent after switch (not lost, not sent to shared)", async () => {
    // The bug this proves we fixed: while the handoff is migrating the user is
    // still on the SHARED agent, whose transcript was already snapshotted. The
    // dedicated import is skip-all idempotent, so a message that reaches the
    // shared history after the snapshot is silently lost. The freeze must hold
    // the message off the shared agent and deliver it to the dedicated once the
    // client has switched.
    const basesSeenAtSend: string[] = [];
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      basesSeenAtSend.push(mocks.client.getBaseUrl());
      return { text: "ack", completed: true };
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    // Handoff starts: the window opens.
    act(() => dispatchHandoffPhase("migrating"));

    // The user fires a message DURING the window. sendChatText resolves only
    // once the message is actually delivered, so we don't await it here — it
    // must stay pending (queued) until the switch settles.
    let sendSettled = false;
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current
        .sendChatText("during handoff", { conversationId: "conv-1" })
        .then(() => {
          sendSettled = true;
        });
      // Give the queued flush a chance to (not) run.
      await Promise.resolve();
    });

    // GUARANTEE 1: nothing was dispatched to the shared agent — the message did
    // not reach the post-snapshot shared history, so it can't be lost.
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(sendSettled).toBe(false);

    // The switch completes: onSwitch re-points the live client at the dedicated
    // container BEFORE the `switched` phase is dispatched (mirrors the real
    // handoff ordering), then the phase fires and unfreezes the queue.
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    await act(async () => {
      dispatchHandoffPhase("switched");
      await sendPromise;
    });

    // GUARANTEE 2: the queued message was delivered exactly once, and only after
    // the client pointed at the dedicated container.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const [convIdArg, textArg] =
      mocks.client.sendConversationMessageStream.mock.calls[0];
    expect(convIdArg).toBe("conv-1");
    expect(textArg).toBe("during handoff");
    expect(basesSeenAtSend).toEqual([DEDICATED_BASE]);
    expect(sendSettled).toBe(true);
  });

  it("flushes the queue to the shared agent (no message lost) when the handoff times out", async () => {
    // Fallback path: the dedicated container never became ready. No switch
    // happened and no snapshot landed, so the user safely stays on the shared
    // agent — the queued message must still be delivered there, never dropped.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "ack",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    act(() => dispatchHandoffPhase("migrating"));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("during handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    // Handoff gives up — unfreeze and drain to the (still-active) shared agent.
    await act(async () => {
      dispatchHandoffPhase("timed-out");
      await sendPromise;
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const [convIdArg, textArg] =
      mocks.client.sendConversationMessageStream.mock.calls[0];
    expect(convIdArg).toBe("conv-1");
    expect(textArg).toBe("during handoff");
  });

  it("re-checks the freeze mid-drain: a message queued behind an in-flight send when `migrating` fires is NOT drained to shared after the snapshot", async () => {
    // Regression for the in-flight-drain race: send A is already mid-`await`
    // when the handoff begins; the user then fires send B during the window.
    // B is enqueued behind A's still-running drain loop. When A resolves the
    // loop must NOT shift B and dispatch it to the (post-snapshot) SHARED agent
    // — it must re-check the freeze, break, and leave B for the post-switch
    // flush. Without the per-iteration freeze re-check, B leaks to shared and is
    // lost to the skip-all import.
    const basesSeenAtSend: string[] = [];
    let releaseA: (() => void) | undefined;
    const aInFlight = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let callCount = 0;
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      const index = callCount++;
      basesSeenAtSend.push(mocks.client.getBaseUrl());
      if (index === 0) await aInFlight; // A blocks until we release it
      return { text: "ack", completed: true };
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    // Send A starts on the SHARED base BEFORE the handoff — it is not frozen, so
    // it enters the drain loop and parks mid-await (the drain loop stays busy).
    let aPromise: Promise<void> | undefined;
    await act(async () => {
      aPromise = result.current.sendChatText("before handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    // Handoff begins while A is still in flight, then the user fires B.
    act(() => dispatchHandoffPhase("migrating"));
    let bPromise: Promise<void> | undefined;
    await act(async () => {
      bPromise = result.current.sendChatText("during handoff", {
        conversationId: "conv-1",
      });
      await Promise.resolve();
    });

    // Release A; the still-running drain loop must break on the freeze re-check
    // rather than draining B to shared.
    await act(async () => {
      releaseA?.();
      await aPromise;
      await Promise.resolve();
    });

    // GUARANTEE: B was NOT sent to shared — only A's send happened, on SHARED.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(basesSeenAtSend).toEqual([SHARED_BASE]);

    // Switch settles: the client repoints to the dedicated, the phase fires, and
    // B drains to the dedicated container exactly once.
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    await act(async () => {
      dispatchHandoffPhase("switched");
      await bPromise;
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    expect(basesSeenAtSend).toEqual([SHARED_BASE, DEDICATED_BASE]);
    const [, secondText] =
      mocks.client.sendConversationMessageStream.mock.calls[1];
    expect(secondText).toBe("during handoff");
  });

  it("does not freeze when no handoff is in flight — sends dispatch inline (flag-off parity)", async () => {
    // With `preferSharedCloudTier` off no `migrating` phase ever fires, so the
    // freeze flag stays false and the queue drains immediately, exactly as
    // before this change.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "ack",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend retry re-runs the turn in place (no duplicate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
    mocks.client.truncateConversationMessages.mockResolvedValue(undefined);
  });

  function seedFailedTurn(deps: UseChatSendDeps): void {
    const seeded: ConversationMessage[] = [
      { id: "u1", role: "user", text: "hello", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "I'm having trouble reaching the model provider.",
        timestamp: 2,
        failureKind: "provider_issue",
      },
    ];
    deps.conversationMessagesRef.current = seeded;
  }

  it("regenerates a durable failed reply once without replaying or removing any turn", async () => {
    const pending = deferred<{ text: string; messageId: string }>();
    mocks.client.retryConversationReply.mockReturnValue(pending.promise);
    const deps = makeDeps({ activeConversationId: "conv-1" });
    seedFailedTurn(deps);
    deps.conversationMessagesRef.current[1].replyRecoveryAvailable = true;
    deps.conversationMessagesRef.current.push({
      id: "u2",
      role: "user",
      text: "Keep everything else.",
      timestamp: 3,
    });
    const original = [...deps.conversationMessagesRef.current];
    const { result } = renderHook(() => useChatSend(deps));
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.handleChatRetry("a1");
      await result.current.handleChatRetry("a1");
    });
    expect(deps.conversationMessagesRef.current).toEqual(original);
    expect(mocks.client.retryConversationReply).toHaveBeenCalledTimes(1);
    expect(mocks.client.retryConversationReply).toHaveBeenCalledWith(
      "conv-1",
      "a1",
    );
    await act(async () => {
      pending.resolve({ text: "The note was created.", messageId: "a1" });
      await first;
    });
    expect(deps.conversationMessagesRef.current).toEqual([
      original[0],
      {
        id: "a1",
        role: "assistant",
        text: "The note was created.",
        timestamp: 2,
      },
      original[2],
    ]);
    await act(async () => {
      await result.current.handleChatRetry("a1");
    });
    expect(mocks.client.retryConversationReply).toHaveBeenCalledTimes(1);
    expect(mocks.client.truncateConversationMessages).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
  });

  it("retains durable failure and history after recovery fails, and can retry after remount", async () => {
    mocks.client.retryConversationReply.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const deps = makeDeps({ activeConversationId: "conv-1" });
    seedFailedTurn(deps);
    deps.conversationMessagesRef.current[1].replyRecoveryAvailable = true;
    const original = [...deps.conversationMessagesRef.current];
    const first = renderHook(() => useChatSend(deps));
    await act(async () => {
      await first.result.current.handleChatRetry("a1");
    });
    expect(deps.conversationMessagesRef.current).toEqual(original);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("provider unavailable"),
      "error",
      4200,
    );
    first.unmount();
    mocks.client.retryConversationReply.mockResolvedValue({
      text: "The note was created.",
      messageId: "a1",
    });
    const next = renderHook(() => useChatSend(deps));
    await act(async () => {
      await next.result.current.handleChatRetry("a1");
    });
    expect(deps.conversationMessagesRef.current[1].text).toBe(
      "The note was created.",
    );
    expect(mocks.client.truncateConversationMessages).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("refuses direct retry of a non-replayable failure without durable recovery", async () => {
    const deps = makeDeps({ activeConversationId: "conv-1" });
    seedFailedTurn(deps);
    deps.conversationMessagesRef.current[1].terminalFailure = {
      kind: "provider_issue",
      code: "ACTION_REPLY_GENERATION_FAILED",
      message: "Reply unavailable; the saved action outcome is preserved.",
      transient: false,
    };
    const original = [...deps.conversationMessagesRef.current];
    const { result } = renderHook(() => useChatSend(deps));
    await act(async () => {
      await result.current.handleChatRetry("a1");
    });
    expect(deps.conversationMessagesRef.current).toEqual(original);
    expect(mocks.client.retryConversationReply).not.toHaveBeenCalled();
    expect(mocks.client.truncateConversationMessages).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessage).not.toHaveBeenCalled();
  });

  it("truncates from the user message (inclusive) and resends, leaving exactly one user turn", async () => {
    // Regression: the old retry only dropped the failed assistant bubble in
    // memory and resent, producing [Q, fail, Q-dup, new]. The fix mirrors
    // handleChatEdit — truncate [Q, fail] server-side, then re-run Q in place.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "recovered reply",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    seedFailedTurn(deps);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("a1");
    });

    // The turn was truncated from the user message inclusive, in place.
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledTimes(1);
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
      "conv-1",
      "u1",
      { inclusive: true },
    );
    expect(deps.removeConversationMessageStateMessages).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        mode: "truncate",
        preservedMessages: [],
        removedMessages: expect.arrayContaining([
          expect.objectContaining({ id: "u1" }),
          expect.objectContaining({ id: "a1" }),
        ]),
      }),
    );
    // The text was resent once (re-run), not as a brand-new extra turn.
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    // No duplicate user message: exactly one "hello" user turn remains, and the
    // failed assistant bubble (a1) is gone.
    const remaining = deps.conversationMessagesRef.current;
    const userHellos = remaining.filter(
      (m) => m.role === "user" && m.text === "hello",
    );
    expect(userHellos).toHaveLength(1);
    expect(remaining.some((m) => m.id === "a1")).toBe(false);
  });

  it("falls back to in-memory resend for an optimistic (temp-) user turn", async () => {
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "recovered reply",
      completed: true,
    });

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // An optimistic user turn whose server id hasn't landed yet — not safe to
    // truncate server-side, so retry drops the failed bubble in memory + resends.
    deps.conversationMessagesRef.current = [
      { id: "temp-u1", role: "user", text: "hello", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "I'm having trouble reaching the model provider.",
        timestamp: 2,
        failureKind: "provider_issue",
      },
    ];
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("a1");
    });

    // temp- user id → cannot truncate; resend still fires.
    expect(mocks.client.truncateConversationMessages).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
  });

  it("retries only the selected optimistic turn and preserves an unrelated turn without duplicate terminal rows", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        const response = `recovered:${text}`;
        onToken(response, response);
        return { text: response, completed: true };
      },
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.conversationMessagesRef.current = [
      {
        id: "temp-retry-user",
        clientRenderId: "temp-retry-user",
        role: "user",
        text: "hello",
        timestamp: 1,
      },
      {
        id: "retry-failure",
        clientRenderId: "retry-failure",
        role: "assistant",
        text: UNDELIVERED_TURN_NOTICE,
        timestamp: 2,
        failureKind: "provider_issue",
      },
      {
        id: "temp-unrelated-user",
        clientRenderId: "temp-unrelated-user",
        role: "user",
        text: "leave me alone",
        timestamp: 3,
      },
      {
        id: "temp-unrelated-assistant",
        clientRenderId: "temp-unrelated-assistant",
        role: "assistant",
        text: "still here",
        timestamp: 4,
      },
    ];
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("retry-failure");
      await vi.waitFor(() => {
        expect(
          mocks.client.sendConversationMessageStream,
        ).toHaveBeenCalledTimes(1);
      });
    });

    const messages = deps.conversationMessagesRef.current;
    expect(messages.some(({ id }) => id === "temp-retry-user")).toBe(true);
    expect(messages.some(({ id }) => id === "retry-failure")).toBe(false);
    expect(messages.find(({ id }) => id === "temp-unrelated-user")?.text).toBe(
      "leave me alone",
    );
    expect(
      messages.find(({ id }) => id === "temp-unrelated-assistant")?.text,
    ).toBe("still here");

    const retriedUser = messages.filter(
      ({ role, text }) => role === "user" && text === "hello",
    );
    const retriedAssistant = messages.filter(
      ({ role, text }) => role === "assistant" && text === "recovered:hello",
    );
    expect(retriedUser).toHaveLength(1);
    expect(retriedAssistant).toHaveLength(1);
    expect(retriedUser[0]).toMatchObject({
      id: "temp-retry-user",
      clientRenderId: "temp-retry-user",
    });
    expect(retriedAssistant[0]).toMatchObject({
      id: "temp-resp-retry-user",
      clientRenderId: "temp-resp-retry-user",
    });
    expect(mocks.client.sendConversationMessageStream.mock.calls[0]?.[9]).toBe(
      "retry-user",
    );
  });
});

describe("useChatSend edit preserves a cancelled queued draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.truncateConversationMessages.mockResolvedValue(undefined);
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "edited reply",
      completed: true,
    });
  });

  it("does not clear restored queued text or images before resending the edited turn", async () => {
    const queuedImage: ImageAttachment = {
      data: "CCCC",
      mimeType: "image/png",
      name: "queued-edit.png",
    };
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.conversationMessagesRef.current = [
      { id: "u1", role: "user", text: "original", timestamp: 1 },
      { id: "a1", role: "assistant", text: "reply", timestamp: 2 },
    ];
    const { result } = renderHook(() => useChatSend(deps));

    act(() => dispatchHandoffPhase("migrating"));

    let queuedSend!: Promise<void>;
    await act(async () => {
      queuedSend = result.current.sendChatText("keep this draft", {
        conversationId: "conv-1",
        images: [queuedImage],
      });
      await Promise.resolve();
    });

    let editPromise!: Promise<boolean>;
    await act(async () => {
      editPromise = result.current.handleChatEdit("u1", "edited");
      await vi.waitFor(() => {
        expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
          "conv-1",
          "u1",
          { inclusive: true },
        );
      });
      await vi.waitFor(() => {
        expect(
          result.current.chatSendQueueRef.current.some(
            (turn) => turn.rawInput === "edited",
          ),
        ).toBe(true);
      });
    });

    expect(deps.setChatInput).toHaveBeenLastCalledWith("keep this draft");
    expect(deps.setChatPendingImages).toHaveBeenLastCalledWith([queuedImage]);

    await act(async () => {
      dispatchHandoffPhase("timed-out");
      await Promise.all([queuedSend, editPromise]);
    });

    expect(await editPromise).toBe(true);
    expect(deps.removeConversationMessageStateMessages).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        mode: "truncate",
        preservedMessages: [],
        removedMessages: expect.arrayContaining([
          expect.objectContaining({ id: "u1" }),
          expect.objectContaining({ id: "a1" }),
        ]),
      }),
    );
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(mocks.client.sendConversationMessageStream.mock.calls[0]?.[1]).toBe(
      "edited",
    );
  });
});

describe("useChatSend internal transcript reconciliation", () => {
  const inventory = "available_views:\nviews[1]{id}: notes";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
    mocks.client.truncateConversationMessages.mockResolvedValue(undefined);
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken(inventory, inventory);
        return {
          text: inventory,
          completed: false,
          transcriptVisibility: "internal",
          messageId: "persisted-internal-diagnostic",
        };
      },
    );
  });

  it("drops a streamed internal terminal result from an ordinary send", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("what views are available?", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (message) => message.role === "assistant",
      ),
    ).toBe(false);
  });

  it("drops a streamed internal terminal result from retry replay", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.conversationMessagesRef.current = [
      { id: "u1", role: "user", text: "list views", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "retry me",
        timestamp: 2,
        failureKind: "provider_issue",
      },
    ];
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry("a1");
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (message) => message.role === "assistant",
      ),
    ).toBe(false);
  });

  it("drops a streamed internal terminal result from action send", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendActionMessage("list views");
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (message) => message.role === "assistant",
      ),
    ).toBe(false);
  });
});

describe("useChatSend persisted message identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("Ready.", "Ready.");
        return {
          text: "Ready.",
          completed: true,
          messageId: "persisted-assistant-id",
        };
      },
    );
  });

  it("replaces only the active optimistic assistant id with the persisted id", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("show me", {
        conversationId: "conv-1",
      });
    });

    const assistantMessages = deps.conversationMessagesRef.current.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      id: "persisted-assistant-id",
      text: "Ready.",
    });
  });
});

describe("useChatSend empty-reply failure surfacing (#10231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces a failureKind gate (not a silent drop) when the streamed terminal reply is empty", async () => {
    // Regression: the empty-text terminal handler dropped any empty reply
    // unconditionally, so an empty-text + failureKind response (e.g. the
    // "Connect a provider" gate) vanished with no error. It must stamp the
    // failureKind onto the assistant turn instead.
    mocks.client.sendConversationMessageStream.mockImplementation(async () => ({
      text: "",
      completed: true,
      failureKind: "no_provider",
    }));

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistant.length).toBe(1);
    expect(assistant[0]?.failureKind).toBe("no_provider");
  });

  it("retains typed terminal failure details on the completed assistant turn", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(async () => ({
      text: "Shell execution failed.",
      completed: true,
      failureKind: "coding_tool_failure",
      terminalFailure: {
        kind: "coding_tool_failure",
        message: "Shell execution failed.",
        transient: true,
        code: "SHELL_UNAVAILABLE",
      },
    }));

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("fix it", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.terminalFailure).toMatchObject({
      kind: "coding_tool_failure",
      transient: true,
      code: "SHELL_UNAVAILABLE",
    });
  });

  it("still drops an empty terminal reply that carries no failureKind", async () => {
    mocks.client.sendConversationMessageStream.mockImplementation(async () => ({
      text: "",
      completed: true,
    }));

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant",
    );
    expect(assistant.length).toBe(0);
  });
});

describe("buildSendFailureNotice (#10231)", () => {
  it("maps auth/rate/availability/kind failures to status-specific copy", () => {
    expect(buildSendFailureNotice({ status: 401 })).toContain(
      "session expired",
    );
    expect(buildSendFailureNotice({ status: 403 })).toContain(
      "session expired",
    );
    expect(buildSendFailureNotice({ status: 429 })).toContain("busy");
    expect(buildSendFailureNotice({ status: 503 })).toContain("waking up");
    expect(buildSendFailureNotice({ status: 502 })).toContain("waking up");
    expect(buildSendFailureNotice({ kind: "timeout" })).toContain(
      "took too long",
    );
    expect(buildSendFailureNotice({ kind: "network" })).toContain(
      "check your connection",
    );
  });

  it("falls back to a generic resend notice for an unknown failure (never empty)", () => {
    const notice = buildSendFailureNotice(new Error("boom"));
    expect(notice.length).toBeGreaterThan(0);
    expect(notice).toContain("resend");
  });

  it("surfaces the server's validation reason for a 4xx validation reject", () => {
    // Regression: a 400 (e.g. attachment too large / unsupported type) got the
    // generic "didn't go through — please resend" copy, which discards the only
    // information that lets the user fix the payload; resending unchanged fails
    // identically forever.
    const err = Object.assign(new Error("Attachment too large (max 5 MB)"), {
      status: 400,
      kind: "http",
    });
    const notice = buildSendFailureNotice(err);
    expect(notice).toContain("Attachment too large (max 5 MB)");
    expect(notice).not.toContain("didn't go through");
  });

  it("keeps the generic copy for a body-less 4xx and for 5xx server messages", () => {
    // No usable body → "HTTP 400" fallback message → generic copy.
    expect(
      buildSendFailureNotice(
        Object.assign(new Error("HTTP 400"), { status: 400, kind: "http" }),
      ),
    ).toContain("didn't go through");
    // 5xx bodies are internal noise, not user-actionable validation reasons.
    expect(
      buildSendFailureNotice(
        Object.assign(new Error("upstream connect error"), {
          status: 500,
          kind: "http",
        }),
      ),
    ).toContain("didn't go through");
  });
});

describe("getSendValidationFailureMessage", () => {
  it("extracts the message only for payload-validation statuses", () => {
    for (const status of [400, 413, 415, 422]) {
      expect(
        getSendValidationFailureMessage(
          Object.assign(new Error("bad payload"), { status }),
        ),
      ).toBe("bad payload");
    }
    for (const status of [401, 403, 404, 429, 500, 503]) {
      expect(
        getSendValidationFailureMessage(
          Object.assign(new Error("bad payload"), { status }),
        ),
      ).toBeNull();
    }
    expect(getSendValidationFailureMessage(new Error("no status"))).toBeNull();
  });
});

describe("useChatSend 4xx validation reject — honest notice + no-loss restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  function validationError(message: string): Error {
    return Object.assign(new Error(message), { status: 400, kind: "http" });
  }

  it("restores the text AND attachments to the composer and says why", async () => {
    // The destruction scenario: the composer was cleared at enqueue, the server
    // 400s before persisting, and the reconcile reload wipes the optimistic
    // bubble — without the restore the user's words are gone on a primary flow.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      validationError("Unsupported attachment type: image/heic"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    const images: ImageAttachment[] = [
      { data: "AAAA", mimeType: "image/heic", name: "photo.heic" },
    ];
    await act(async () => {
      await result.current.sendChatText("check out this photo", {
        conversationId: "conv-1",
        images,
      });
    });

    // Text back in the composer, attachments back in the pending tray.
    expect(deps.setChatInput).toHaveBeenCalledWith("check out this photo");
    expect(deps.setChatPendingImages).toHaveBeenCalledWith(images);
    // The notice carries the server's specific reason + the restore.
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
    const [noticeText, tone] = (
      deps.setActionNotice as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(noticeText).toContain("Unsupported attachment type: image/heic");
    expect(noticeText).toContain("restored to the input");
    expect(tone).toBe("error");
    // The message never persisted server-side, so the thread reconciles (the
    // optimistic bubble is replaced by server truth; the draft lives in the
    // composer now, not the thread).
    expect(deps.loadConversationMessages).toHaveBeenCalledWith("conv-1");
  });

  it("restores just the text for a text-only validation reject", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      validationError("text is too long"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("a very long message", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setChatInput).toHaveBeenCalledWith("a very long message");
    expect(deps.setChatPendingImages).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Your message was restored to the input."),
      "error",
      expect.any(Number),
    );
  });

  it("does NOT restore the composer on a transient (5xx) failure", async () => {
    // Transient failures keep the user bubble in the thread (resend can
    // succeed); writing into the composer would clobber whatever the user
    // typed since.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Service Unavailable"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    expect(deps.setChatInput).not.toHaveBeenCalled();
    expect(deps.setChatPendingImages).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend cold-conversation attachment recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("restores the exact composer payload when creation fails and sends it once on retry", async () => {
    const images: ImageAttachment[] = [
      { data: "AAAA", mimeType: "image/png", name: "cold-start.png" },
    ];
    mocks.client.createConversation
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        conversation: conversation("conv-created", "room-created"),
      });
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "received",
      completed: true,
    });

    const deps = makeDeps();
    deps.chatInputRef.current = "review this";
    deps.chatPendingImagesRef.current = images;
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatSend();
    });

    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(deps.chatInputRef.current).toBe("review this");
    expect(deps.chatPendingImagesRef.current).toEqual(images);
    expect(deps.setChatPendingImages).toHaveBeenNthCalledWith(1, []);
    expect(deps.setChatPendingImages).toHaveBeenNthCalledWith(2, images);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("message and attachments were restored"),
      "error",
      8_000,
    );

    await act(async () => {
      await result.current.handleChatSend();
    });

    expect(mocks.client.createConversation).toHaveBeenCalledTimes(2);
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    expect(mocks.client.sendConversationMessageStream.mock.calls[0]?.[1]).toBe(
      "review this",
    );
    expect(
      mocks.client.sendConversationMessageStream.mock.calls[0]?.[5],
    ).toEqual(images);
  });
});

describe("useChatSend — user turn sent during agent warm-up is never evicted (#11670)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
    mocks.client.renameConversation.mockResolvedValue(undefined);
  });

  /**
   * Make the mocked reload behave like the REAL loadConversationMessages: it
   * full-replaces local state with server truth. The default `{ ok: true }`
   * no-op mock is exactly why the eviction never showed up in this suite —
   * the production reload wipes the optimistic bubble when the server never
   * persisted the turn.
   */
  function mockServerTruthReload(
    deps: UseChatSendDeps,
    serverThread: { current: ConversationMessage[] },
  ): void {
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      deps.setConversationMessages([...serverThread.current]);
      return { ok: true };
    });
  }

  function undeliveredTurns(deps: UseChatSendDeps): ConversationMessage[] {
    return deps.conversationMessagesRef.current.filter(
      (m) => m.role === "assistant" && m.text === UNDELIVERED_TURN_NOTICE,
    );
  }

  it("restores the user bubble + a retryable failed turn when the warm-up 503 gate drops the send (the #11670 repro)", async () => {
    // The issue's exact path: the runtime-ready hold expires while the local
    // model warms up, the server 503s WITHOUT persisting the user message, and
    // the reconcile reload full-replaces the thread with an empty server truth
    // — on develop the user's bubble silently vanishes.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const remaining = deps.conversationMessagesRef.current;
    // The user's message is still visibly in the thread…
    expect(
      remaining.some(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toBe(true);
    // …followed by a retryable failed assistant turn (Retry chip), not dead air.
    const failed = undeliveredTurns(deps);
    expect(failed).toHaveLength(1);
    expect(failed[0].failureKind).toBe("provider_issue");
    // The status-specific notice still fires.
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("waking up"),
      "error",
      expect.any(Number),
    );
  });

  it("restores the user bubble when the stream completes empty and the server persisted nothing", async () => {
    // The quieter variant: the send "succeeds" (no throw, no failureKind) but
    // the runtime processed nothing and stored nothing — the reload wipes the
    // bubble with NO notice at all on develop.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.some(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });

  it("keeps optimistic attachments on the restored bubble", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("look at this", {
        conversationId: "conv-1",
        images: [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }],
      });
    });

    const restored = deps.conversationMessagesRef.current.find(
      (m) => m.role === "user" && m.text === "look at this",
    );
    expect(restored?.attachments).toHaveLength(1);
    expect(restored?.attachments?.[0].mimeType).toBe("image/png");
  });

  it("does NOT duplicate the turn when the server persisted it (silent agent turn stays as-is)", async () => {
    // A legitimately silent reply (agent chose not to answer): the user turn
    // IS in server truth, so the restore must no-op — no duplicate bubble, no
    // spurious failed turn.
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "",
      completed: true,
    });
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = {
      current: [
        {
          id: "server-user-1",
          role: "user",
          text: "hello while warming",
          timestamp: Date.now(),
        } as ConversationMessage,
      ],
    };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });

    const users = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "user" && m.text === "hello while warming",
    );
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("server-user-1");
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it("an identical user turn from an EARLIER exchange does not mask the eviction", async () => {
    // The user said "hi" five minutes ago (persisted), then says "hi" again
    // during warm-up. Matching by text alone would treat the old turn as this
    // send and silently drop the new one — the timestamp guard prevents that.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = {
      current: [
        {
          id: "server-user-old",
          role: "user",
          text: "hi",
          timestamp: Date.now() - 300_000,
        } as ConversationMessage,
        {
          id: "server-asst-old",
          role: "assistant",
          text: "hey!",
          timestamp: Date.now() - 299_000,
        } as ConversationMessage,
      ],
    };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const users = deps.conversationMessagesRef.current.filter(
      (m) => m.role === "user" && m.text === "hi",
    );
    expect(users).toHaveLength(2);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });

  it("does NOT re-attach the bubble on a validation reject (the draft went back to the composer)", async () => {
    // 4xx validation rejects restore the draft to the composer; re-attaching
    // the bubble too would duplicate the content.
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      Object.assign(new Error("text is too long"), {
        status: 400,
        kind: "http",
      }),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("a very long message", {
        conversationId: "conv-1",
      });
    });

    expect(deps.setChatInput).toHaveBeenCalledWith("a very long message");
    expect(
      deps.conversationMessagesRef.current.some((m) => m.role === "user"),
    ).toBe(false);
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it.each([false, true])(
    "retains a completed context overflow reply and its request link across history refresh (already streamed: %s)",
    async (streamed) => {
      const failureText =
        "The model rejected this request at its context limit.";
      mocks.client.sendConversationMessageStream.mockImplementation(
        async (_conversationId, _text, onToken) => {
          if (streamed) onToken(failureText, failureText);
          return {
            text: failureText,
            completed: true,
            assistantEphemeral: true,
            failureKind: "context_overflow",
            historyRefreshRequired: true,
            userMessageId: "server-user-overflow",
          };
        },
      );
      const deps = makeDeps({
        activeConversationId: "conv-1",
        conversations: [conversation("conv-1", "room-1")],
      });
      // Synthetic failure prose is deliberately absent from durable history.
      // A successful history refresh must not erase the visible failure.
      vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
        deps.setConversationMessages([
          {
            id: "server-user-overflow",
            role: "user",
            text: "Preview a reminder without saving it.",
            timestamp: Date.now(),
          },
        ]);
        return { ok: true };
      });
      const { result } = renderHook(() => useChatSend(deps));

      await act(async () => {
        await result.current.sendChatText(
          "Preview a reminder without saving it.",
          {
            conversationId: "conv-1",
          },
        );
      });

      expect(deps.loadConversationMessages).toHaveBeenCalledWith("conv-1");
      const assistants = deps.conversationMessagesRef.current.filter(
        (message) => message.role === "assistant",
      );
      expect(assistants).toHaveLength(1);
      expect(assistants[0]).toMatchObject({
        text: failureText,
        failureKind: "context_overflow",
        assistantEphemeral: true,
        replyToMessageId: "server-user-overflow",
      });
      expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(
        1,
      );
    },
  );

  it("retires a server-ephemeral failed reply when the next user turn begins", async () => {
    const failureText =
      "sorry, something went wrong. would you mind trying again?";
    const successText = 'Created sticky note "brush my teeth".';
    mocks.client.sendConversationMessageStream
      .mockImplementationOnce(
        async (
          _conversationId: string,
          _text: string,
          onToken: (token: string, accumulatedText?: string) => void,
        ) => {
          onToken(failureText, failureText);
          return {
            text: failureText,
            completed: false,
            assistantEphemeral: true,
            userMessageId: "server-user-failed",
          };
        },
      )
      .mockImplementationOnce(
        async (
          _conversationId: string,
          _text: string,
          onToken: (token: string, accumulatedText?: string) => void,
        ) => {
          onToken(successText, successText);
          return {
            text: successText,
            completed: true,
            messageId: "server-assistant-success",
            userMessageId: "server-user-success",
          };
        },
      );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    vi.mocked(deps.loadConversationMessages).mockImplementation(async () => {
      const sentUser = deps.conversationMessagesRef.current.find(
        (message) => message.role === "user",
      );
      deps.setConversationMessages(
        sentUser ? [{ ...sentUser, id: "server-user-failed" }] : [],
      );
      return { ok: true };
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("create a note to brush my teeth", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.find(
        (message) => message.text === failureText,
      ),
    ).toMatchObject({
      role: "assistant",
      interrupted: true,
      assistantEphemeral: true,
    });

    await act(async () => {
      await result.current.sendChatText("try creating it again", {
        conversationId: "conv-1",
      });
    });

    const settled = deps.conversationMessagesRef.current;
    expect(settled.some((message) => message.text === failureText)).toBe(false);
    expect(
      settled.filter(
        (message) =>
          message.role === "assistant" && message.text === successText,
      ),
    ).toHaveLength(1);
  });

  it("drops a late server-ephemeral reply when newer user turns already settled", async () => {
    const failureText =
      "Sorry, I couldn't generate a response right now. Please try again.";
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken(failureText, failureText);
        const originUser = deps.conversationMessagesRef.current.find(
          (message) => message.role === "user",
        );
        const pendingAssistant = deps.conversationMessagesRef.current.find(
          (message) => message.role === "assistant",
        );
        if (!originUser || !pendingAssistant) {
          throw new Error("optimistic turn was not painted before streaming");
        }

        // A route remount can reload server truth while this older request is
        // still settling. The unresolved local assistant is appended after the
        // newer durable exchange, which must not let its late fallback appear
        // beneath the newer successful reply on the phone.
        deps.setConversationMessages([
          { ...originUser, id: "server-user-old" },
          {
            id: "server-user-new",
            role: "user",
            text: "open notes",
            timestamp: originUser.timestamp + 1,
          },
          {
            id: "server-assistant-new",
            role: "assistant",
            text: "Opened Notes.",
            timestamp: originUser.timestamp + 2,
          },
          pendingAssistant,
        ]);
        return {
          text: failureText,
          completed: false,
          assistantEphemeral: true,
          userMessageId: "server-user-old",
        };
      },
    );
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("open notss", {
        conversationId: "conv-1",
      });
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (message) => message.text === failureText,
      ),
    ).toBe(false);
    expect(deps.conversationMessagesRef.current.at(-1)).toMatchObject({
      id: "server-assistant-new",
      text: "Opened Notes.",
    });
  });

  it("Retry on the restored turn re-delivers the message once the model is ready, without duplicating it", async () => {
    // Full loop: warm-up 503 → restored bubble + failed turn → model comes
    // online → one tap on Retry delivers the message and the thread settles to
    // exactly one copy of the turn.
    mocks.client.sendConversationMessageStream.mockRejectedValueOnce(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const serverThread = { current: [] as ConversationMessage[] };
    mockServerTruthReload(deps, serverThread);
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello while warming", {
        conversationId: "conv-1",
      });
    });
    const failedTurn = undeliveredTurns(deps)[0];
    expect(failedTurn).toBeDefined();

    // The model is ready now: the next send succeeds and the server persists
    // the turn, so the post-retry reload carries it.
    mocks.client.sendConversationMessageStream.mockImplementation(async () => {
      serverThread.current = [
        {
          id: "server-user-1",
          role: "user",
          text: "hello while warming",
          timestamp: Date.now(),
        } as ConversationMessage,
        {
          id: "server-asst-1",
          role: "assistant",
          text: "hi! I'm awake now.",
          timestamp: Date.now(),
        } as ConversationMessage,
      ];
      return { text: "hi! I'm awake now.", completed: true };
    });

    await act(async () => {
      await result.current.handleChatRetry(failedTurn.id);
      // The fallback retry fires the resend without awaiting it — flush it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(2);
    const [, retriedText] =
      mocks.client.sendConversationMessageStream.mock.calls[1];
    expect(retriedText).toBe("hello while warming");
    const remaining = deps.conversationMessagesRef.current;
    expect(
      remaining.filter(
        (m) => m.role === "user" && m.text === "hello while warming",
      ),
    ).toHaveLength(1);
    expect(
      remaining.some(
        (m) => m.role === "assistant" && m.text === "hi! I'm awake now.",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(0);
  });

  it("sendActionMessage restores an evicted user turn the same way", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      httpStatusError(503, "Agent is not running"),
    );
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    mockServerTruthReload(deps, { current: [] });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendActionMessage("run the report");
    });

    expect(
      deps.conversationMessagesRef.current.some(
        (m) => m.role === "user" && m.text === "run the report",
      ),
    ).toBe(true);
    expect(undeliveredTurns(deps)).toHaveLength(1);
  });
});

describe("useChatSend — sendActionMessage cold-open defers the create like the fixed send path (#16665)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Complete the send cleanly so the cold-open create path is the only
    // thing under test (a resolved stream, no notice, no retry).
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "ok",
      completed: true,
    } as never);
  });

  it("skips the redundant client.createConversation round trip on a shared-agent base", async () => {
    // Shared base: the server POST handler ignores the body, so
    // createConversationForFirstSend synthesizes the canonical record locally.
    mocks.client.getBaseUrl.mockReturnValue(SHARED_BASE);
    // Cold open: no active conversation, so sendActionMessage takes the create
    // branch (`if (!convId)`).
    const deps = makeDeps({
      activeConversationId: null,
      conversations: [],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendActionMessage("run the report");
    });

    // The bug: sendActionMessage used to call client.createConversation here,
    // re-introducing the exact cold Worker/Hyperdrive round trip #16619 removed
    // from the ordinary send path. It must now be zero on a shared base.
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    // The synthesized shared conversation is adopted as active (id === agentId).
    expect(deps.setActiveConversationId).toHaveBeenCalledWith("agent-123");
    // No failure notice on the happy path.
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("still creates on a dedicated base and forwards the action title to the REST fallback", async () => {
    // Dedicated base: no shared-agent id, so the real REST create runs and the
    // action title must reach it.
    mocks.client.getBaseUrl.mockReturnValue(DEDICATED_BASE);
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    const deps = makeDeps({
      activeConversationId: null,
      conversations: [],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendActionMessage("run the report");
    });

    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    // Title forwarded as the first arg; language options as the second.
    expect(mocks.client.createConversation).toHaveBeenCalledWith(
      "run the report",
      { lang: "en" },
    );
    expect(deps.setActiveConversationId).toHaveBeenCalledWith("conv-new");
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });
});

describe("useChatSend — structured SSE error surfaces the gate (#10231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("surfaces the no_provider gate on the assistant turn, not a generic notice", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new StreamGenerationError({
        message: "no provider configured",
        failureKind: "no_provider",
      }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // The assistant turn carries the structured gate (renderer swaps in the
    // "Connect a provider" UI) — the empty placeholder is NOT dropped…
    const messages = deps.conversationMessagesRef.current;
    const assistant = messages.find((m) => m.role === "assistant") as
      | (ConversationMessage & { failureKind?: string })
      | undefined;
    expect(assistant?.failureKind).toBe("no_provider");
    // …and no generic error notice is shown (the gate replaces it).
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("surfaces a connect-account request from an error event", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new StreamGenerationError({
        message: "connect an account",
        // Minimal connect request — only its presence drives the block.
        accountConnect: {
          provider: "google",
          reason: "reconnect",
        } as never,
      }),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    const assistant = deps.conversationMessagesRef.current.find(
      (m) => m.role === "assistant",
    ) as (ConversationMessage & { accountConnect?: unknown }) | undefined;
    expect(assistant?.accountConnect).toBeTruthy();
    expect(deps.setActionNotice).not.toHaveBeenCalled();
  });

  it("still shows a generic notice for a plain (unstructured) stream error", async () => {
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new Error("network blip"),
    );

    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hi", { conversationId: "conv-1" });
    });

    // No structured gate → the existing generic-notice path is preserved.
    expect(deps.setActionNotice).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSend — handleChatDelete persistent single-message delete (#13533)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.deleteConversationMessage.mockResolvedValue({
      ok: true,
      deletedCount: 1,
    });
  });

  function seedMessages(
    deps: UseChatSendDeps,
    messages: ConversationMessage[],
  ): void {
    deps.conversationMessagesRef.current = messages;
  }

  function userMsg(id: string, text = "hi"): ConversationMessage {
    return {
      id,
      role: "user",
      text,
      timestamp: 1,
    } as ConversationMessage;
  }

  it("optimistically removes the message and fires the server DELETE", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    seedMessages(deps, [userMsg("m-1"), userMsg("m-2"), userMsg("m-3")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-2");
    });

    expect(ok).toBe(true);
    expect(mocks.client.deleteConversationMessage).toHaveBeenCalledWith(
      "c-1",
      "m-2",
    );
    expect(deps.removeConversationMessageStateMessages).toHaveBeenCalledWith(
      "c-1",
      {
        mode: "delete-exact",
        removedMessages: [expect.objectContaining({ id: "m-2" })],
      },
    );
    // Target gone, neighbors intact (single-row delete, not truncate).
    const ids = deps.conversationMessagesRef.current.map((m) => m.id);
    expect(ids).toEqual(["m-1", "m-3"]);
  });

  it("rolls back the removal and surfaces an error when the server DELETE fails", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    const seeded = [userMsg("m-1"), userMsg("m-2"), userMsg("m-3")];
    seedMessages(deps, seeded);
    mocks.client.deleteConversationMessage.mockRejectedValueOnce(
      new Error("boom"),
    );
    const { result } = renderHook(() => useChatSend(deps));

    let ok = true;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-2");
    });

    expect(ok).toBe(false);
    // Message restored — never a silent local-only removal on failure.
    expect(deps.conversationMessagesRef.current.map((m) => m.id)).toEqual([
      "m-1",
      "m-2",
      "m-3",
    ]);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete message"),
      "error",
      expect.any(Number),
    );
  });

  it("removes an optimistic (temp-) message locally without a server call", async () => {
    const deps = makeDeps({ activeConversationId: "c-1" });
    seedMessages(deps, [userMsg("temp-abc"), userMsg("m-2")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleChatDelete("temp-abc");
    });

    expect(ok).toBe(true);
    expect(mocks.client.deleteConversationMessage).not.toHaveBeenCalled();
    expect(deps.conversationMessagesRef.current.map((m) => m.id)).toEqual([
      "m-2",
    ]);
  });

  it("no-ops (returns false) when there is no active conversation", async () => {
    const deps = makeDeps({ activeConversationId: null });
    seedMessages(deps, [userMsg("m-1")]);
    const { result } = renderHook(() => useChatSend(deps));

    let ok = true;
    await act(async () => {
      ok = await result.current.handleChatDelete("m-1");
    });

    expect(ok).toBe(false);
    expect(mocks.client.deleteConversationMessage).not.toHaveBeenCalled();
  });

  it("does NOT clobber another conversation's state when the DELETE fails after a mid-delete conversation switch (#13981)", async () => {
    const deps = makeDeps({ activeConversationId: "conv-A" });
    seedMessages(deps, [userMsg("a-1"), userMsg("a-2")]);
    const convBMessages = [userMsg("b-1", "hi B"), userMsg("b-2", "reply B")];
    const del = deferred<{ ok: boolean; deletedCount: number }>();
    mocks.client.deleteConversationMessage.mockReturnValueOnce(del.promise);
    const { result } = renderHook(() => useChatSend(deps));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.handleChatDelete("a-2");
    });
    // The optimistic removal has run; the user now switches to conversation B,
    // which swaps the ref + setter to B's messages. THEN the DELETE fails.
    deps.activeConversationIdRef.current = "conv-B";
    deps.conversationMessagesRef.current = convBMessages;

    await act(async () => {
      del.reject(new Error("network"));
      await pending;
    });

    // B's displayed state is untouched — A's pre-delete snapshot never leaks in.
    expect(deps.conversationMessagesRef.current).toEqual(convBMessages);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete message"),
      "error",
      expect.any(Number),
    );
  });

  it("restores the target without clobbering a reply that streamed in during the failed DELETE (#13981)", async () => {
    const deps = makeDeps({ activeConversationId: "conv-A" });
    seedMessages(deps, [userMsg("a-user"), userMsg("a-target")]);
    const del = deferred<{ ok: boolean; deletedCount: number }>();
    mocks.client.deleteConversationMessage.mockReturnValueOnce(del.promise);
    const { result } = renderHook(() => useChatSend(deps));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.handleChatDelete("a-target");
    });
    // A reply streams into the SAME conversation while the DELETE is in flight
    // (appended to the live list). The rollback must not discard it.
    deps.conversationMessagesRef.current = [
      ...deps.conversationMessagesRef.current,
      userMsg("a-streamed", "new reply"),
    ];

    await act(async () => {
      del.reject(new Error("network"));
      await pending;
    });

    const ids = deps.conversationMessagesRef.current.map((m) => m.id);
    expect(ids).toContain("a-target"); // deleted message restored on failure
    expect(ids).toContain("a-streamed"); // the reply that streamed in is NOT lost
  });
});

describe("useChatSend reply-target attachment", () => {
  const REPLY_ID = "00000000-0000-4000-8000-00000000abcd";

  beforeEach(() => {
    vi.clearAllMocks();
    // Resolve the stream immediately so sendChatText's enqueue+drain completes.
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("ok", "ok");
        return { text: "ok", completed: true };
      },
    );
  });

  it("stamps replyToMessageId from the reply-target ref onto the send metadata and clears it", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    // A reply is armed by the row affordance before the user sends.
    deps.chatReplyTargetRef.current = {
      messageId: REPLY_ID,
      senderName: "Alice",
      snippet: "the 3pm slot",
    };
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("yes please", {
        conversationId: "conv-1",
      });
    });

    // metadata is the 8th positional arg of sendConversationMessageStream.
    const metadata = mocks.client.sendConversationMessageStream.mock
      .calls[0][6] as Record<string, unknown> | undefined;
    expect(metadata?.replyToMessageId).toBe(REPLY_ID);
    expect(metadata?.uiTimeZone).toBe(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    // The armed reply is consumed exactly once: ref cleared + state cleared so a
    // subsequent send does not re-attach a stale reply.
    expect(deps.chatReplyTargetRef.current).toBeNull();
    expect(deps.setChatReplyTarget).toHaveBeenCalledWith(null);
  });

  it("does not attach a reply when none is armed", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("hello", { conversationId: "conv-1" });
    });

    const metadata = mocks.client.sendConversationMessageStream.mock
      .calls[0][6] as Record<string, unknown> | undefined;
    expect(metadata?.replyToMessageId).toBeUndefined();
    expect(deps.setChatReplyTarget).not.toHaveBeenCalled();
  });
});

describe("useChatSend manual resend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("");
  });

  it("handleChatRetry re-sends a failed turn", async () => {
    const failedAssistantId = "asst-failed";
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    deps.conversationMessagesRef.current = [
      { id: "user-1", role: "user", text: "hello", timestamp: Date.now() },
      {
        id: failedAssistantId,
        role: "assistant",
        text: UNDELIVERED_TURN_NOTICE,
        timestamp: Date.now(),
        failureKind: "provider_issue",
      },
    ];
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (
        _id: string,
        _text: string,
        onToken: (t: string, a?: string) => void,
      ) => {
        onToken("recovered", "recovered");
        return { text: "recovered", completed: true };
      },
    );
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.handleChatRetry(failedAssistantId);
    });

    // The manual retry truncated the failed turn and re-sent the user text.
    expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      { inclusive: true },
    );
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const sentText =
      mocks.client.sendConversationMessageStream.mock.calls[0][1];
    expect(sentText).toBe("hello");
  });
});

describe("createConversationForFirstSend", () => {
  it("synthesizes the canonical shared conversation without a create request", async () => {
    const createConversation = vi.fn();
    const result = await createConversationForFirstSend(
      {
        getBaseUrl: () => SHARED_BASE,
        createConversation,
      } as never,
      "en",
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(result.conversation).toMatchObject({
      id: "agent-123",
      roomId: "agent-123",
      title: "Chat",
    });
  });

  it("keeps dedicated conversation creation on the REST client", async () => {
    const conversation = {
      id: "dedicated-conversation",
      roomId: "dedicated-room",
      title: "Chat",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    const createConversation = vi.fn(async () => ({ conversation }));
    const result = await createConversationForFirstSend(
      {
        getBaseUrl: () => DEDICATED_BASE,
        createConversation,
      } as never,
      "en",
    );

    expect(createConversation).toHaveBeenCalledWith(undefined, { lang: "en" });
    expect(result.conversation).toEqual(conversation);
  });
});

describe("prewarmSharedChatScope", () => {
  it("warms the authenticated status gate for a selected shared Cloud agent", async () => {
    const getStatus = vi.fn(async () => ({ status: "running" }));
    await prewarmSharedChatScope({
      getBaseUrl: () => SHARED_BASE,
      getStatus,
    } as never);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not probe a dedicated agent base", async () => {
    const getStatus = vi.fn();
    await prewarmSharedChatScope({
      getBaseUrl: () => DEDICATED_BASE,
      getStatus,
    } as never);
    expect(getStatus).not.toHaveBeenCalled();
  });
});

describe("resolveAbortRoomId", () => {
  it("resolves synchronously without requiring a conversation refresh", () => {
    expect(
      resolveAbortRoomId("conversation-1", " room-known ", "room-cached"),
    ).toBe("room-known");
    expect(resolveAbortRoomId("conversation-1", null, " room-cached ")).toBe(
      "room-cached",
    );
    expect(resolveAbortRoomId("conversation-1", null, null)).toBe(
      "conversation-1",
    );
  });
});
