/** Verifies useDataLoaders — conversation message prefetch cache through the package's configured test harness. */
// @vitest-environment jsdom
//
// Unit coverage for the conversation-message prefetch cache + abortable load
// added for smooth swipe navigation: an adjacent conversation is warmed so a
// swipe paints instantly from memory, and a rapid swipe aborts the prior
// in-flight load so a stale fetch can never clobber the latest thread.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";

const mocks = vi.hoisted(() => ({
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConfig: vi.fn(async () => ({ ui: {} })),
    repointBaseUrl: vi.fn(),
    setBaseUrl: vi.fn(),
  },
  subscribeRuntimeAuthoritySwitch: vi.fn(),
}));

let runtimeAuthoritySwitchListener:
  | ((phase: "before" | "after") => void)
  | undefined;

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("./switch-runtime", () => ({
  subscribeRuntimeAuthoritySwitch: mocks.subscribeRuntimeAuthoritySwitch,
}));

import {
  listPendingChatTurns,
  persistPendingChatTurn,
} from "./pending-chat-turns";
import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

function userMsg(id: string): ConversationMessage {
  return {
    id,
    role: "user",
    text: `msg-${id}`,
    timestamp: 0,
  } as ConversationMessage;
}

function assistantMsg(id: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    text: `msg-${id}`,
    timestamp: 0,
  } as ConversationMessage;
}

function makeDeps() {
  const conversationMessagesRef = { current: [] as ConversationMessage[] };
  const activeConversationIdRef = { current: null as string | null };
  const greetingFiredRef = { current: false };
  const setConversationMessages = vi.fn((v: ConversationMessage[]) => {
    conversationMessagesRef.current = v;
  });
  const noop = () => {};
  const deps = {
    autonomousStoreRef: { current: {} },
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef: { current: {} },
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: noop,
    setAutonomousLatestEventId: noop,
    setAutonomousRunHealthByRunId: noop,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations: vi.fn(),
    setActiveConversationId: vi.fn(),
    setConversationMessages,
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noop,
  } as unknown as DataLoadersDeps;
  return {
    deps,
    setConversationMessages,
    conversationMessagesRef,
    activeConversationIdRef,
  };
}

beforeEach(() => {
  mocks.client.getConversationMessages.mockReset();
  mocks.client.listConversations.mockReset();
  mocks.client.listConversations.mockResolvedValue({ conversations: [] });
  runtimeAuthoritySwitchListener = undefined;
  mocks.client.repointBaseUrl.mockReset();
  mocks.client.setBaseUrl.mockReset();
  mocks.subscribeRuntimeAuthoritySwitch.mockReset();
  mocks.subscribeRuntimeAuthoritySwitch.mockImplementation(
    (listener: (phase: "before" | "after") => void) => {
      runtimeAuthoritySwitchListener = listener;
      return () => {
        if (runtimeAuthoritySwitchListener === listener) {
          runtimeAuthoritySwitchListener = undefined;
        }
      };
    },
  );
  window.localStorage.clear();
});

describe("useDataLoaders — conversation message prefetch cache", () => {
  it("keeps a relayed ephemeral final reply through history refresh, then honors its streamed removal", async () => {
    const persisted = { ...userMsg("server-user"), timestamp: 5 };
    mocks.client.getConversationMessages.mockResolvedValue({
      messages: [persisted],
    });
    const { deps, activeConversationIdRef, conversationMessagesRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const reply = {
      ...assistantMsg("temp-final"),
      clientRenderId: "temp-final",
      timestamp: 2,
      assistantEphemeral: true,
      replyToMessageId: "server-user",
      text: "The model context is too large; nothing was changed.",
    };
    act(() => {
      result.current.applyConversationMessageStream("conv-a", [reply], []);
    });
    expect(result.current.getConversationMessagesSnapshot("conv-a")).toEqual([
      persisted,
      reply,
    ]);
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([persisted, reply]);
    act(() => {
      result.current.applyConversationMessageStream("conv-a", [], [reply.id]);
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([persisted]);
  });

  it("deduplicates a relayed optimistic-to-durable replacement against server history", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const { deps, activeConversationIdRef, conversationMessagesRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const optimistic = {
      ...assistantMsg("temp-final"),
      clientRenderId: "temp-final",
      text: "Saved.",
    };
    const durable = { ...optimistic, id: "server-final" };
    act(() => {
      result.current.applyConversationMessageStream("conv-a", [optimistic], []);
      result.current.applyConversationMessageStream(
        "conv-a",
        [durable],
        [optimistic.id],
      );
    });
    mocks.client.getConversationMessages.mockResolvedValue({
      messages: [{ ...durable, clientRenderId: undefined }],
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toHaveLength(1);
    expect(conversationMessagesRef.current[0]).toMatchObject({
      id: "server-final",
      text: "Saved.",
    });
  });

  it("does not read or merge stream rows across released conversation ownership", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps, activeConversationIdRef, conversationMessagesRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
    });
    expect(
      result.current.getConversationMessagesSnapshot("conv-a"),
    ).toBeUndefined();
    expect(
      result.current.getConversationMessagesSnapshot("conv-b"),
    ).toBeUndefined();
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    act(() => {
      result.current.applyConversationMessageStream(
        "conv-a",
        [assistantMsg("temp-private-a")],
        [],
      );
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("conv-b")]);
    expect(result.current.getConversationMessagesSnapshot("conv-b")).toEqual([
      userMsg("conv-b"),
    ]);
    act(() => {
      runtimeAuthoritySwitchListener?.("before");
    });
    expect(
      result.current.getConversationMessagesSnapshot("conv-b"),
    ).toBeUndefined();
  });

  it("prefetch warms the cache so the next load paints synchronously (no network wait)", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps, setConversationMessages, activeConversationIdRef } =
      makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages(["conv-x"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);

    // The follow-up load paints from cache SYNCHRONOUSLY — before its own
    // revalidation fetch resolves — so a swiped-to neighbor never flashes empty.
    setConversationMessages.mockClear();
    let loadPromise: Promise<unknown>;
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-x");
      activeConversationIdRef.current = "conv-x";
      loadPromise = result.current.loadConversationMessages("conv-x");
    });
    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    expect(setConversationMessages.mock.calls[0]?.[0]).toEqual([
      userMsg("conv-x"),
    ]);
    await act(async () => {
      await loadPromise;
    });
  });

  it("clears a pending reload receipt once server history contains its user turn", async () => {
    const sentAt = Date.now();
    persistPendingChatTurn({
      conversationId: "conv-settled",
      clientMessageId: "client-settled",
      text: "survives reload",
      sentAt,
    });
    mocks.client.getConversationMessages.mockResolvedValue({
      messages: [
        {
          ...userMsg("server-user"),
          text: "survives reload",
          timestamp: sentAt,
        },
      ],
    });
    const { deps, activeConversationIdRef } = makeDeps();
    activeConversationIdRef.current = "conv-settled";
    const { result } = renderHook(() => useDataLoaders(deps));

    expect(listPendingChatTurns("conv-settled")).toHaveLength(1);
    await act(async () => {
      await result.current.loadConversationMessages("conv-settled");
    });

    expect(listPendingChatTurns("conv-settled")).toHaveLength(0);
  });

  it("prefetch skips ids already cached or already in flight", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      // Same id twice in one call → a single fetch (in-flight dedupe).
      result.current.prefetchConversationMessages(["c1", "c1"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);

    // Now cached → a repeat prefetch issues no new fetch.
    await act(async () => {
      result.current.prefetchConversationMessages(["c1"]);
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);
  });

  it("clears stale messages immediately when loading an uncached conversation", async () => {
    let resolveConvB: ((m: ConversationMessage[]) => void) | undefined;
    mocks.client.getConversationMessages.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          if (id === "conv-b") {
            resolveConvB = (m) => resolve({ messages: m });
          }
        }),
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    conversationMessagesRef.current = [userMsg("old-thread")];
    const { result } = renderHook(() => useDataLoaders(deps));

    let loadPromise: Promise<unknown>;
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      loadPromise = result.current.loadConversationMessages("conv-b");
    });

    expect(setConversationMessages).toHaveBeenCalledWith([]);
    expect(conversationMessagesRef.current).toEqual([]);

    await act(async () => {
      resolveConvB?.([userMsg("new-thread")]);
      await loadPromise;
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("new-thread")]);
  });

  it("a newer load aborts the prior in-flight one so a stale fetch never wins", async () => {
    const resolvers: Record<string, (m: ConversationMessage[]) => void> = {};
    mocks.client.getConversationMessages.mockImplementation(
      (id: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          resolvers[id] = (m) => resolve({ messages: m });
          opts?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
      const p1 = result.current.loadConversationMessages("conv-a"); // fetch A
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      const p2 = result.current.loadConversationMessages("conv-b"); // aborts A
      // Resolve B (the latest) and then A (the superseded, late) fetch.
      resolvers["conv-b"]?.([userMsg("b1")]);
      resolvers["conv-a"]?.([userMsg("a1")]);
      await Promise.allSettled([p1, p2]);
    });

    // Only the latest selection's messages reach the thread.
    expect(conversationMessagesRef.current).toEqual([userMsg("b1")]);
  });

  it("preserves local optimistic temp turns during same-conversation revalidation", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [userMsg("persisted-1"), assistantMsg("server-late")],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-user"), timestamp: 10 },
      { ...assistantMsg("temp-resp-user"), text: "", timestamp: 11 },
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      "temp-user",
      "temp-resp-user",
    ]);
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-late", "temp-user", "temp-resp-user"]);
    expect(setConversationMessages).toHaveBeenLastCalledWith(
      conversationMessagesRef.current,
    );
  });

  it("preserves rekeyed local turns while stale history resolves, then deduplicates durable server rows", async () => {
    const persistedHistory = [userMsg("persisted-1")];
    let resolveStaleHistory:
      | ((messages: ConversationMessage[]) => void)
      | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: persistedHistory })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleHistory = (messages) => resolve({ messages });
          }),
      )
      .mockResolvedValueOnce({
        messages: [
          ...persistedHistory,
          {
            ...userMsg("server-user-new"),
            text: "new question",
            timestamp: 10,
          },
          {
            ...assistantMsg("server-assistant-new"),
            text: "finished response",
            timestamp: 11,
          },
        ],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    const optimisticUser = {
      ...userMsg("temp-user-new"),
      clientRenderId: "temp-user-new",
      text: "new question",
      timestamp: 10,
    };
    const optimisticAssistant = {
      ...assistantMsg("temp-resp-user-new"),
      clientRenderId: "temp-resp-user-new",
      text: "finished response",
      timestamp: 11,
    };
    conversationMessagesRef.current = [
      ...persistedHistory,
      optimisticUser,
      optimisticAssistant,
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      optimisticUser.clientRenderId,
      optimisticAssistant.clientRenderId,
    ]);

    let staleLoadPromise: Promise<unknown>;
    act(() => {
      staleLoadPromise = result.current.loadConversationMessages("conv-a");
    });
    expect(resolveStaleHistory).toBeDefined();

    act(() => {
      setConversationMessages([
        ...persistedHistory,
        { ...optimisticUser, id: "server-user-new" },
        { ...optimisticAssistant, id: "server-assistant-new" },
      ]);
    });

    await act(async () => {
      resolveStaleHistory?.(persistedHistory);
      await staleLoadPromise;
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user-new", "server-assistant-new"]);
    expect(
      conversationMessagesRef.current.slice(-2).map((message) => ({
        id: message.id,
        clientRenderId: message.clientRenderId,
      })),
    ).toEqual([
      { id: "server-user-new", clientRenderId: "temp-user-new" },
      {
        id: "server-assistant-new",
        clientRenderId: "temp-resp-user-new",
      },
    ]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user-new", "server-assistant-new"]);
    expect(
      conversationMessagesRef.current.filter(
        (message) => message.id === "server-user-new",
      ),
    ).toHaveLength(1);
    expect(
      conversationMessagesRef.current.filter(
        (message) => message.id === "server-assistant-new",
      ),
    ).toHaveLength(1);
  });

  it("retires durable rekeyed rows beyond the bounded 200-message window after three scoped misses", async () => {
    const completeHistory = Array.from({ length: 202 }, (_, index) => ({
      ...userMsg(`server-${index}`),
      text: `message ${index}`,
      timestamp: index,
    }));
    const boundedHistory = completeHistory.slice(-200);
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: completeHistory })
      .mockResolvedValueOnce({ messages: boundedHistory })
      .mockResolvedValueOnce({ messages: boundedHistory })
      .mockResolvedValueOnce({ messages: boundedHistory });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    // Direct terminal replies keep their render identity after durable rekey.
    // These rows all predate the new request and are not an in-flight overlay.
    act(() => {
      setConversationMessages(
        completeHistory.map((message, index) => ({
          ...message,
          clientRenderId: `temp-${index}`,
        })),
      );
      result.current.registerConversationMessageOverlay(
        "conv-a",
        completeHistory.map((_, index) => `temp-${index}`),
      );
    });

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(conversationMessagesRef.current).toHaveLength(202);
    expect(
      conversationMessagesRef.current.slice(0, 2).map((message) => message.id),
    ).toEqual(["server-0", "server-1"]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(conversationMessagesRef.current).toHaveLength(202);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(conversationMessagesRef.current).toEqual(boundedHistory);
    expect(conversationMessagesRef.current).toHaveLength(200);
    expect(
      conversationMessagesRef.current.some(
        (message) => message.id === "server-0" || message.id === "server-1",
      ),
    ).toBe(false);
  });

  it("keeps a stale rekey overlay with conversation A across A to B to A navigation", async () => {
    const oldA = { ...userMsg("a-old"), text: "old A", timestamp: 1 };
    const messageB = { ...userMsg("b-only"), text: "only B", timestamp: 2 };
    let resolveFirstStaleA:
      | ((messages: ConversationMessage[]) => void)
      | undefined;
    let resolveSecondStaleA:
      | ((messages: ConversationMessage[]) => void)
      | undefined;
    let call = 0;
    mocks.client.getConversationMessages.mockImplementation((id: string) => {
      call += 1;
      if (call === 1) return Promise.resolve({ messages: [oldA] });
      if (call === 2) {
        return new Promise((resolve) => {
          resolveFirstStaleA = (messages) => resolve({ messages });
        });
      }
      if (id === "conv-b") return Promise.resolve({ messages: [messageB] });
      return new Promise((resolve) => {
        resolveSecondStaleA = (messages) => resolve({ messages });
      });
    });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    let firstStaleLoad: Promise<unknown>;
    act(() => {
      firstStaleLoad = result.current.loadConversationMessages("conv-a");
    });
    const optimisticUser = {
      ...userMsg("temp-a-new"),
      clientRenderId: "temp-a-new",
      text: "new A question",
      timestamp: 10,
    };
    const optimisticAssistant = {
      ...assistantMsg("temp-resp-a-new"),
      clientRenderId: "temp-resp-a-new",
      text: "new A answer",
      timestamp: 11,
    };
    act(() => {
      setConversationMessages([oldA, optimisticUser, optimisticAssistant]);
      result.current.registerConversationMessageOverlay("conv-a", [
        optimisticUser.clientRenderId,
        optimisticAssistant.clientRenderId,
      ]);
      setConversationMessages([
        oldA,
        { ...optimisticUser, id: "a-user-durable" },
        { ...optimisticAssistant, id: "a-assistant-durable" },
      ]);
    });
    await act(async () => {
      resolveFirstStaleA?.([oldA]);
      await firstStaleLoad;
    });

    result.current.claimConversationMessagesOwnership("conv-b");
    activeConversationIdRef.current = "conv-b";
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    expect(conversationMessagesRef.current).toEqual([messageB]);

    result.current.claimConversationMessagesOwnership("conv-a");
    activeConversationIdRef.current = "conv-a";
    let secondStaleLoad: Promise<unknown>;
    act(() => {
      secondStaleLoad = result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["a-old", "a-user-durable", "a-assistant-durable"]);

    await act(async () => {
      resolveSecondStaleA?.([oldA]);
      await secondStaleLoad;
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["a-old", "a-user-durable", "a-assistant-durable"]);
  });

  it("binds a terminal rekey during A's initial load to A and never carries it into B", async () => {
    let resolveA: ((messages: ConversationMessage[]) => void) | undefined;
    const messageB = { ...userMsg("b-only"), text: "only B", timestamp: 20 };
    mocks.client.getConversationMessages.mockImplementation((id: string) => {
      if (id === "conv-b") return Promise.resolve({ messages: [messageB] });
      return new Promise((resolve) => {
        resolveA = (messages) => resolve({ messages });
      });
    });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let loadA: Promise<unknown>;
    act(() => {
      loadA = result.current.loadConversationMessages("conv-a");
      setConversationMessages([
        {
          ...userMsg("temp-a-user"),
          clientRenderId: "temp-a-user",
          text: "new A question",
          timestamp: 10,
        },
        {
          ...assistantMsg("temp-resp-a-user"),
          clientRenderId: "temp-resp-a-user",
          text: "new A answer",
          timestamp: 11,
        },
      ]);
      result.current.registerConversationMessageOverlay("conv-a", [
        "temp-a-user",
        "temp-resp-a-user",
      ]);
      setConversationMessages([
        {
          ...userMsg("a-user-durable"),
          clientRenderId: "temp-a-user",
          text: "new A question",
          timestamp: 10,
        },
        {
          ...assistantMsg("a-assistant-durable"),
          clientRenderId: "temp-resp-a-user",
          text: "new A answer",
          timestamp: 11,
        },
      ]);
    });

    result.current.claimConversationMessagesOwnership("conv-b");
    activeConversationIdRef.current = "conv-b";
    let loadB: Promise<unknown>;
    act(() => {
      loadB = result.current.loadConversationMessages("conv-b");
    });
    await act(async () => {
      resolveA?.([]);
      await Promise.all([loadA, loadB]);
    });

    expect(conversationMessagesRef.current).toEqual([messageB]);
    expect(
      conversationMessagesRef.current.some((message) =>
        message.clientRenderId?.startsWith("temp-a"),
      ),
    ).toBe(false);
    expect(result.current.loadedConversationIdRef.current).toBe("conv-b");
  });

  it("preserves optimistic turns on the first load of a newly created active conversation", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-new");
      activeConversationIdRef.current = "conv-new";
      setConversationMessages([
        { ...userMsg("temp-user"), text: "hello", timestamp: 10 },
        { ...assistantMsg("temp-resp-user"), text: "", timestamp: 11 },
      ]);
      result.current.registerConversationMessageOverlay("conv-new", [
        "temp-user",
        "temp-resp-user",
      ]);
    });

    await act(async () => {
      await result.current.loadConversationMessages("conv-new");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["temp-user", "temp-resp-user"]);
  });

  it("drops optimistic temp turns once the server reload carries the same user and assistant turn", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [
          userMsg("persisted-1"),
          { ...userMsg("server-user"), text: "hello", timestamp: 20 },
          {
            ...assistantMsg("server-assistant"),
            text: "hi there",
            timestamp: 21,
          },
        ],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-100"), text: "hello", timestamp: 10 },
      {
        ...assistantMsg("temp-resp-100"),
        text: "hi there",
        timestamp: 11,
      },
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      "temp-100",
      "temp-resp-100",
    ]);
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user", "server-assistant"]);
    expect(
      conversationMessagesRef.current.some((message) =>
        message.id.startsWith("temp-"),
      ),
    ).toBe(false);
  });

  it("keeps an in-flight temp assistant when the server has only persisted the user turn", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [
          userMsg("persisted-1"),
          { ...userMsg("server-user"), text: "hello", timestamp: 20 },
        ],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-100"), text: "hello", timestamp: 10 },
      {
        ...assistantMsg("temp-resp-100"),
        text: "partial stream",
        timestamp: 11,
      },
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      "temp-100",
      "temp-resp-100",
    ]);
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user", "temp-resp-100"]);
  });

  it("keeps a distinct repeated temp user message when only the earlier identical turn is persisted", async () => {
    const firstUser = {
      ...userMsg("server-user-1"),
      text: "yes",
      timestamp: 1_000,
    };
    const firstAssistant = {
      ...assistantMsg("server-assistant-1"),
      text: "ok",
      timestamp: 2_000,
    };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] })
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      firstUser,
      firstAssistant,
      { ...userMsg("temp-21000"), text: "yes", timestamp: 21_000 },
      {
        ...assistantMsg("temp-resp-21000"),
        text: "",
        timestamp: 21_100,
      },
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      "temp-21000",
      "temp-resp-21000",
    ]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual([
      "server-user-1",
      "server-assistant-1",
      "temp-21000",
      "temp-resp-21000",
    ]);
  });

  it.each(["history", "terminal-rekey"] as const)(
    "keeps a second identical queued user after the first resolves by %s",
    async (resolution) => {
      const oldUser = { ...userMsg("old-yes"), text: "yes", timestamp: 1_000 };
      const firstUser = {
        ...userMsg("temp-first"),
        text: "yes",
        timestamp: 1_010,
      };
      const secondUser = {
        ...userMsg("temp-second"),
        text: "yes",
        timestamp: 1_020,
      };
      const durableFirst = { ...firstUser, id: "durable-first" };
      const durableSecond = { ...secondUser, id: "durable-second" };
      let serverMessages = [oldUser];
      mocks.client.getConversationMessages.mockImplementation(async () => ({
        messages: [...serverMessages],
      }));
      const { deps, conversationMessagesRef, activeConversationIdRef } =
        makeDeps();
      activeConversationIdRef.current = "conv-a";
      const hook = renderHook(() => useDataLoaders(deps));
      try {
        await act(async () => {
          await hook.result.current.loadConversationMessages("conv-a");
        });
        act(() => {
          conversationMessagesRef.current = [oldUser, firstUser];
          hook.result.current.registerConversationMessageOverlay("conv-a", [
            firstUser.id,
          ]);
          conversationMessagesRef.current = [oldUser, firstUser, secondUser];
          hook.result.current.registerConversationMessageOverlay("conv-a", [
            secondUser.id,
          ]);
          if (resolution === "terminal-rekey") {
            conversationMessagesRef.current = [
              oldUser,
              { ...durableFirst, clientRenderId: firstUser.id },
              secondUser,
            ];
          }
        });
        serverMessages = [oldUser, durableFirst];
        // An around paint can show the first durable row before its optimistic
        // lineage has retired. The later queued repeat must survive convergence.
        await act(async () => {
          await hook.result.current.loadConversationMessagesAround(
            "conv-a",
            oldUser.id,
          );
        });
        for (let reload = 0; reload < 3; reload += 1) {
          await act(async () => {
            await hook.result.current.loadConversationMessages("conv-a");
          });
        }
        expect(
          conversationMessagesRef.current.map((message) => message.id),
        ).toEqual([oldUser.id, durableFirst.id, secondUser.id]);
        serverMessages = [oldUser, durableFirst, durableSecond];
        await act(async () => {
          await hook.result.current.loadConversationMessages("conv-a");
        });
        expect(
          conversationMessagesRef.current.map((message) => message.id),
        ).toEqual([oldUser.id, durableFirst.id, durableSecond.id]);
      } finally {
        hook.unmount();
      }
    },
  );

  it("keeps an identical in-flight streamed assistant when only the repeated user turn has persisted", async () => {
    const firstUser = {
      ...userMsg("server-user-1"),
      text: "ping",
      timestamp: 1_000,
    };
    const firstAssistant = {
      ...assistantMsg("server-assistant-1"),
      text: "ok",
      timestamp: 2_000,
    };
    const repeatedUser = {
      ...userMsg("server-user-2"),
      text: "ping",
      timestamp: 21_000,
    };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] })
      .mockResolvedValueOnce({
        messages: [firstUser, firstAssistant, repeatedUser],
      });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      firstUser,
      firstAssistant,
      { ...userMsg("temp-21000"), text: "ping", timestamp: 21_000 },
      {
        ...assistantMsg("temp-resp-21000"),
        text: "ok",
        timestamp: 22_000,
      },
    ];
    result.current.registerConversationMessageOverlay("conv-a", [
      "temp-21000",
      "temp-resp-21000",
    ]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual([
      "server-user-1",
      "server-assistant-1",
      "server-user-2",
      "temp-resp-21000",
    ]);
  });

  it("keeps a newly rekeyed turn across a stale bounded newest-200 response, then absorbs the converged durable rows", async () => {
    const originalHistory = Array.from({ length: 202 }, (_, index) => ({
      ...userMsg(`old-${index}`),
      text: `old message ${index}`,
      timestamp: index,
    }));
    const staleBoundedHistory = originalHistory.slice(-200);
    const convergedHistory = [
      ...originalHistory.slice(-198),
      {
        ...userMsg("direct-user-durable"),
        text: "new direct question",
        timestamp: 1_000,
      },
      {
        ...assistantMsg("direct-assistant-durable"),
        text: "new direct answer",
        timestamp: 1_001,
      },
    ];
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: originalHistory })
      .mockResolvedValueOnce({ messages: staleBoundedHistory })
      .mockResolvedValueOnce({ messages: convergedHistory });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const localUser = {
      ...userMsg("temp-direct-user"),
      clientRenderId: "temp-direct-user",
      text: "new direct question",
      timestamp: 1_000,
    };
    const localAssistant = {
      ...assistantMsg("temp-resp-direct-user"),
      clientRenderId: "temp-resp-direct-user",
      text: "new direct answer",
      timestamp: 1_001,
    };
    act(() => {
      setConversationMessages([...originalHistory, localUser, localAssistant]);
      result.current.registerConversationMessageOverlay("conv-a", [
        localUser.clientRenderId,
        localAssistant.clientRenderId,
      ]);
      setConversationMessages([
        ...originalHistory,
        { ...localUser, id: "direct-user-durable" },
        { ...localAssistant, id: "direct-assistant-durable" },
      ]);
    });

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toHaveLength(202);
    expect(
      conversationMessagesRef.current.slice(-2).map((message) => message.id),
    ).toEqual(["direct-user-durable", "direct-assistant-durable"]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toHaveLength(200);
    expect(
      conversationMessagesRef.current.filter(
        (message) => message.id === "direct-assistant-durable",
      ),
    ).toHaveLength(1);
  });

  it("never retires registered pending temp rows after repeated newest-history misses", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    act(() => {
      setConversationMessages([
        {
          ...userMsg("temp-pending"),
          text: "still sending",
          timestamp: 10,
        },
        {
          ...assistantMsg("temp-resp-pending"),
          text: "partial",
          timestamp: 11,
        },
      ]);
      result.current.registerConversationMessageOverlay("conv-a", [
        "temp-pending",
        "temp-resp-pending",
      ]);
    });

    for (let miss = 0; miss < 5; miss += 1) {
      await act(async () => {
        await result.current.loadConversationMessages("conv-a");
      });
    }
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["temp-pending", "temp-resp-pending"]);
  });

  it("retires an unchanged terminal-durable overlay only on its third eligible newest miss", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const local = {
      ...assistantMsg("temp-resp-terminal"),
      clientRenderId: "temp-resp-terminal",
      text: "durable answer",
      timestamp: 10,
    };
    act(() => {
      setConversationMessages([local]);
      result.current.registerConversationMessageOverlay("conv-a", [
        local.clientRenderId,
      ]);
      setConversationMessages([{ ...local, id: "assistant-durable" }]);
    });

    for (let miss = 1; miss <= 2; miss += 1) {
      await act(async () => {
        await result.current.loadConversationMessages("conv-a");
      });
      expect(
        conversationMessagesRef.current.map((message) => message.id),
      ).toEqual(["assistant-durable"]);
    }
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([]);
  });

  it("does not retire a freshly rekeyed retry from one full-window response with newer server timestamps", async () => {
    const boundedHistory = Array.from({ length: 200 }, (_, index) => ({
      ...userMsg(`server-${index}`),
      text: `server message ${index}`,
      timestamp: 1_000 + index,
    }));
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: boundedHistory });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const retry = {
      ...userMsg("temp-retried-user"),
      clientRenderId: "temp-retried-user",
      text: "retry me",
      timestamp: 1,
    };
    act(() => {
      setConversationMessages([retry]);
      result.current.registerConversationMessageOverlay("conv-a", [
        retry.clientRenderId,
      ]);
      setConversationMessages([{ ...retry, id: "durable-retried-user" }]);
    });

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.some(
        (message) => message.id === "durable-retried-user",
      ),
    ).toBe(true);
  });

  it("keeps a newer local revision when a full GET returns the same durable id from an older fence", async () => {
    let resolveStaleExact:
      | ((messages: ConversationMessage[]) => void)
      | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleExact = (messages) => resolve({ messages });
          }),
      );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    const pending = {
      ...assistantMsg("temp-resp-a"),
      clientRenderId: "temp-resp-a",
      text: "pending",
      timestamp: 10,
    };
    act(() => {
      setConversationMessages([pending]);
      result.current.registerConversationMessageOverlay("conv-a", [
        pending.clientRenderId,
      ]);
    });

    let staleLoad: Promise<unknown>;
    act(() => {
      staleLoad = result.current.loadConversationMessages("conv-a");
      setConversationMessages([
        {
          ...pending,
          id: "assistant-durable",
          text: "final local answer",
        },
      ]);
    });
    await act(async () => {
      resolveStaleExact?.([
        {
          ...assistantMsg("assistant-durable"),
          text: "stale partial answer",
          timestamp: 10,
        },
      ]);
      await staleLoad;
    });

    expect(conversationMessagesRef.current).toEqual([
      {
        ...pending,
        id: "assistant-durable",
        text: "final local answer",
      },
    ]);
  });

  it("an old A fence cannot capture or commit locally-created B rows when B starts without a GET", async () => {
    let resolveA: ((messages: ConversationMessage[]) => void) | undefined;
    mocks.client.getConversationMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = (messages) => resolve({ messages });
        }),
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let loadA: Promise<unknown>;
    act(() => {
      loadA = result.current.loadConversationMessages("conv-a");
      setConversationMessages([
        { ...userMsg("temp-a"), text: "A local", timestamp: 10 },
      ]);
      result.current.registerConversationMessageOverlay("conv-a", ["temp-a"]);
      setConversationMessages([
        {
          ...userMsg("a-durable"),
          clientRenderId: "temp-a",
          text: "A local",
          timestamp: 10,
        },
      ]);
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      setConversationMessages([
        { ...userMsg("temp-b"), text: "B local", timestamp: 20 },
      ]);
      result.current.registerConversationMessageOverlay("conv-b", ["temp-b"]);
    });

    await act(async () => {
      resolveA?.([userMsg("stale-a-server")]);
      await loadA;
    });
    expect(conversationMessagesRef.current).toEqual([
      { ...userMsg("temp-b"), text: "B local", timestamp: 20 },
    ]);
  });

  it("does not let A's deferred 404 refresh claim or paint over B", async () => {
    let resolveConversationRefresh:
      | ((value: { conversations: never[] }) => void)
      | undefined;
    mocks.client.getConversationMessages.mockRejectedValue(
      Object.assign(new Error("missing"), { status: 404 }),
    );
    mocks.client.listConversations.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConversationRefresh = resolve;
        }),
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let missingA: Promise<unknown>;
    act(() => {
      missingA = result.current.loadConversationMessages("conv-a");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.client.listConversations).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      setConversationMessages([userMsg("b-visible")]);
    });
    await act(async () => {
      resolveConversationRefresh?.({ conversations: [] });
      await missingA;
    });

    expect(activeConversationIdRef.current).toBe("conv-b");
    expect(conversationMessagesRef.current).toEqual([userMsg("b-visible")]);
  });

  it("ignores an inactive visible-load request before it can claim or paint over the active owner", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({
      messages: [userMsg("b-visible")],
    });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-b";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    mocks.client.getConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(mocks.client.getConversationMessages).not.toHaveBeenCalled();
    expect(conversationMessagesRef.current).toEqual([userMsg("b-visible")]);
  });

  it("captures a terminal rekey when the owning newest request fails transiently", async () => {
    let rejectReload: ((error: unknown) => void) | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectReload = reject;
          }),
      )
      .mockResolvedValueOnce({ messages: [userMsg("b-only")] })
      .mockResolvedValueOnce({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    let failedReload: Promise<unknown>;
    act(() => {
      failedReload = result.current.loadConversationMessages("conv-a");
      const pending = {
        ...assistantMsg("temp-resp-a"),
        clientRenderId: "temp-resp-a",
        text: "finished A",
        timestamp: 10,
      };
      setConversationMessages([pending]);
      result.current.registerConversationMessageOverlay("conv-a", [
        pending.clientRenderId,
      ]);
      setConversationMessages([{ ...pending, id: "a-durable" }]);
    });
    await act(async () => {
      rejectReload?.(Object.assign(new Error("temporary"), { status: 503 }));
      await failedReload;
    });

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["a-durable"]);
  });

  it("targets an off-screen registered lineage after rekey for interrupt and drop", async () => {
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    const pending = {
      ...assistantMsg("temp-resp-a"),
      clientRenderId: "temp-resp-a",
      text: "answer",
      timestamp: 10,
    };
    act(() => {
      setConversationMessages([pending]);
      result.current.registerConversationMessageOverlay("conv-a", [
        pending.clientRenderId,
      ]);
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      setConversationMessages([]);
      result.current.applyConversationMessageOverlayModification(
        "conv-a",
        pending.clientRenderId,
        {
          messageId: pending.id,
          mode: "rekey",
          persistedMessageId: "assistant-durable",
        },
      );
      result.current.applyConversationMessageOverlayModification(
        "conv-a",
        pending.clientRenderId,
        { messageId: pending.id, mode: "interrupt" },
      );
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([
      { ...pending, id: "assistant-durable", interrupted: true },
    ]);

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      setConversationMessages([]);
      result.current.applyConversationMessageOverlayModification(
        "conv-a",
        pending.clientRenderId,
        { messageId: pending.id, mode: "drop" },
      );
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([]);
  });

  it("keeps overlay state outside the 16-entry server-cache LRU", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages: id === "conv-a" ? [] : [userMsg(id)],
      }),
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const pending = {
      ...assistantMsg("temp-resp-a-lru"),
      clientRenderId: "temp-resp-a-lru",
      text: "A retained answer",
      timestamp: 100,
    };
    act(() => {
      setConversationMessages([pending]);
      result.current.registerConversationMessageOverlay("conv-a", [
        pending.clientRenderId,
      ]);
      setConversationMessages([{ ...pending, id: "a-lru-durable" }]);
    });

    const neighbors = Array.from(
      { length: 17 },
      (_, index) => `neighbor-${index}`,
    );
    await act(async () => {
      result.current.prefetchConversationMessages(neighbors);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      result.current.claimConversationMessagesOwnership("neighbor-16");
      activeConversationIdRef.current = "neighbor-16";
    });
    await act(async () => {
      await result.current.loadConversationMessages("neighbor-16");
    });

    let returnToA: Promise<unknown>;
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
      returnToA = result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["a-lru-durable"]);
    await act(async () => {
      await returnToA;
    });
  });

  it.each(["failure", "navigation", "newer-around", "authority"] as const)(
    "bounds automatic around confirmation and respects %s",
    async (interruption) => {
      const oldUser = { ...userMsg("old-user"), timestamp: 1_000 };
      const pending = {
        ...userMsg("temp-confirm"),
        text: "pending recovery",
        timestamp: 2_000,
      };
      const persisted = { ...pending, id: "durable-confirm" };
      let finishConfirmation:
        | ((messages: ConversationMessage[]) => void)
        | undefined;
      let failConfirmation: ((error: Error) => void) | undefined;
      let confirmationSignal: AbortSignal | undefined;
      mocks.client.getConversationMessages
        .mockResolvedValueOnce({ messages: [oldUser] })
        .mockResolvedValueOnce({ messages: [oldUser] })
        .mockResolvedValueOnce({ messages: [oldUser, persisted] })
        .mockImplementationOnce(
          (_id: string, options?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              confirmationSignal = options?.signal;
              finishConfirmation = (messages) => resolve({ messages });
              failConfirmation = reject;
            }),
        )
        .mockResolvedValue({ messages: [userMsg("new-window")] });
      const { deps, conversationMessagesRef, activeConversationIdRef } =
        makeDeps();
      activeConversationIdRef.current = "conv-a";
      const hook = renderHook(() => useDataLoaders(deps));
      let reload: Promise<unknown> | undefined;
      try {
        await act(async () => {
          await hook.result.current.loadConversationMessages("conv-a");
        });
        act(() => {
          conversationMessagesRef.current = [oldUser, pending];
          hook.result.current.registerConversationMessageOverlay("conv-a", [
            pending.id,
          ]);
        });
        await act(async () => {
          await hook.result.current.loadConversationMessagesAround(
            "conv-a",
            oldUser.id,
          );
        });
        act(() => {
          reload = hook.result.current.loadConversationMessages("conv-a");
        });
        await vi.waitFor(() =>
          expect(finishConfirmation).toEqual(expect.any(Function)),
        );
        expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(4);
        if (interruption === "failure") {
          await act(async () => {
            failConfirmation?.(
              Object.assign(new Error("API unavailable"), { status: 502 }),
            );
            await reload;
          });
          expect(
            conversationMessagesRef.current.map((message) => message.id),
          ).toContain(pending.id);
        } else {
          if (interruption === "navigation") {
            act(() => {
              hook.result.current.claimConversationMessagesOwnership("conv-b");
              activeConversationIdRef.current = "conv-b";
            });
            await act(async () => {
              await hook.result.current.loadConversationMessages("conv-b");
            });
          } else if (interruption === "newer-around") {
            await act(async () => {
              await hook.result.current.loadConversationMessagesAround(
                "conv-a",
                "new-window",
              );
            });
          } else {
            act(() => {
              runtimeAuthoritySwitchListener?.("before");
            });
          }
          expect(confirmationSignal?.aborted).toBe(true);
          const winningMessages = [...conversationMessagesRef.current];
          await act(async () => {
            finishConfirmation?.([oldUser, persisted]);
            await reload;
          });
          expect(conversationMessagesRef.current).toEqual(winningMessages);
        }
        expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(
          interruption === "failure" || interruption === "authority" ? 4 : 5,
        );
      } finally {
        finishConfirmation?.([oldUser, persisted]);
        await reload;
        hook.unmount();
      }
    },
  );

  it("uses exact ids for around windows and the first newest response after around even from a canonical view", async () => {
    const oldUser = {
      ...userMsg("old-yes"),
      text: "yes",
      timestamp: 1_000,
    };
    const oldAssistant = {
      ...assistantMsg("old-answer"),
      text: "old answer",
      timestamp: 1_100,
    };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [oldUser, oldAssistant] })
      .mockResolvedValueOnce({ messages: [oldUser, oldAssistant] })
      .mockResolvedValueOnce({ messages: [oldUser, oldAssistant] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    const repeatedUser = {
      ...userMsg("temp-new-yes"),
      clientRenderId: "temp-new-yes",
      text: "yes",
      timestamp: 1_005,
    };
    const repeatedAssistant = {
      ...assistantMsg("temp-resp-new-yes"),
      clientRenderId: "temp-resp-new-yes",
      text: "",
      timestamp: 1_006,
    };
    act(() => {
      setConversationMessages([
        ...conversationMessagesRef.current,
        repeatedUser,
        repeatedAssistant,
      ]);
      result.current.registerConversationMessageOverlay("conv-a", [
        repeatedUser.clientRenderId,
        repeatedAssistant.clientRenderId,
      ]);
    });

    await act(async () => {
      await result.current.loadConversationMessagesAround("conv-a", "old-yes");
    });
    expect(
      conversationMessagesRef.current
        .filter((message) => message.role === "user" && message.text === "yes")
        .map((message) => message.id),
    ).toEqual(["old-yes", "temp-new-yes"]);

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current
        .filter((message) => message.role === "user" && message.text === "yes")
        .map((message) => message.id),
    ).toEqual(["old-yes", "temp-new-yes"]);
  });

  it("does not consume a new repeated turn from stale newest history after LRU eviction and an around paint", async () => {
    const oldUser = {
      ...userMsg("old-yes"),
      text: "yes",
      timestamp: 1_000,
    };
    const oldAssistant = {
      ...assistantMsg("old-answer"),
      text: "old answer",
      timestamp: 1_100,
    };
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string, opts?: { around?: string }) => {
        if (id !== "conv-a") return { messages: [userMsg(id)] };
        if (opts?.around) {
          return {
            messages: [
              {
                ...userMsg("around-only"),
                text: "older context",
                timestamp: 100,
              },
            ],
          };
        }
        return { messages: [oldUser, oldAssistant] };
      },
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
      result.current.prefetchConversationMessages(
        Array.from({ length: 17 }, (_, index) => `neighbor-${index}`),
      );
      await Promise.resolve();
      await Promise.resolve();
      await result.current.loadConversationMessagesAround("conv-a", "hit");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["around-only"]);

    const repeatedUser = {
      ...userMsg("temp-new-yes"),
      clientRenderId: "temp-new-yes",
      text: "yes",
      timestamp: 1_005,
    };
    const repeatedAssistant = {
      ...assistantMsg("temp-resp-new-yes"),
      clientRenderId: "temp-resp-new-yes",
      text: "",
      timestamp: 1_006,
    };
    act(() => {
      setConversationMessages([
        ...conversationMessagesRef.current,
        repeatedUser,
        repeatedAssistant,
      ]);
      result.current.registerConversationMessageOverlay("conv-a", [
        repeatedUser.clientRenderId,
        repeatedAssistant.clientRenderId,
      ]);
    });

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toContain("temp-new-yes");
    expect(
      conversationMessagesRef.current.filter(
        (message) => message.role === "user" && message.text === "yes",
      ),
    ).toHaveLength(2);
  });

  it("captures a same-owner terminal rekey after its server cache entry was evicted", async () => {
    let resolveReload: ((messages: ConversationMessage[]) => void) | undefined;
    let aRequestCount = 0;
    mocks.client.getConversationMessages.mockImplementation((id: string) => {
      if (id !== "conv-a") {
        return Promise.resolve({ messages: [userMsg(id)] });
      }
      aRequestCount += 1;
      if (aRequestCount === 1) return Promise.resolve({ messages: [] });
      return new Promise((resolve) => {
        resolveReload = (messages) => resolve({ messages });
      });
    });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const pending = {
      ...assistantMsg("temp-resp-lru"),
      clientRenderId: "temp-resp-lru",
      text: "partial",
      timestamp: 10,
    };
    act(() => {
      setConversationMessages([pending]);
      result.current.registerConversationMessageOverlay("conv-a", [
        pending.clientRenderId,
      ]);
    });
    await act(async () => {
      result.current.prefetchConversationMessages(
        Array.from({ length: 17 }, (_, index) => `neighbor-${index}`),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    let reload: Promise<unknown>;
    act(() => {
      reload = result.current.loadConversationMessages("conv-a");
      setConversationMessages([
        { ...pending, id: "assistant-lru-durable", text: "final" },
      ]);
    });
    await act(async () => {
      resolveReload?.([]);
      await reload;
    });
    expect(conversationMessagesRef.current).toEqual([
      { ...pending, id: "assistant-lru-durable", text: "final" },
    ]);
  });

  it("uses one visible request token for two around windows so the older response cannot win", async () => {
    const aroundResolvers = new Map<
      string,
      {
        resolve: (messages: ConversationMessage[]) => void;
        signal?: AbortSignal;
      }
    >();
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("initial")] })
      .mockImplementation(
        (_id: string, opts?: { around?: string; signal?: AbortSignal }) =>
          new Promise((resolve) => {
            const around = opts?.around ?? "";
            aroundResolvers.set(around, {
              resolve: (messages) => resolve({ messages }),
              signal: opts?.signal,
            });
          }),
      );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    let oldAround: Promise<boolean>;
    let newAround: Promise<boolean>;
    act(() => {
      oldAround = result.current.loadConversationMessagesAround(
        "conv-a",
        "old-hit",
      );
      newAround = result.current.loadConversationMessagesAround(
        "conv-a",
        "new-hit",
      );
    });
    expect(aroundResolvers.get("old-hit")?.signal?.aborted).toBe(true);
    await act(async () => {
      aroundResolvers.get("new-hit")?.resolve([userMsg("new-window")]);
      aroundResolvers.get("old-hit")?.resolve([userMsg("old-window")]);
      await expect(newAround).resolves.toBe(true);
      await expect(oldAround).resolves.toBe(false);
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("new-window")]);
  });

  it("lets a full newest GET supersede an older around window", async () => {
    let resolveAround: ((messages: ConversationMessage[]) => void) | undefined;
    let aroundSignal: AbortSignal | undefined;
    let resolveNewest: ((messages: ConversationMessage[]) => void) | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("initial")] })
      .mockImplementationOnce(
        (_id: string, opts?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            aroundSignal = opts?.signal;
            resolveAround = (messages) => resolve({ messages });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewest = (messages) => resolve({ messages });
          }),
      );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    let around: Promise<boolean>;
    let newest: Promise<unknown>;
    act(() => {
      around = result.current.loadConversationMessagesAround(
        "conv-a",
        "old-hit",
      );
      newest = result.current.loadConversationMessages("conv-a");
    });
    expect(aroundSignal?.aborted).toBe(true);
    await act(async () => {
      resolveNewest?.([userMsg("newest-window")]);
      resolveAround?.([userMsg("old-around-window")]);
      await newest;
      await expect(around).resolves.toBe(false);
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("newest-window")]);
  });

  it("lets an around window supersede an older full newest GET", async () => {
    let resolveNewest: ((messages: ConversationMessage[]) => void) | undefined;
    let newestSignal: AbortSignal | undefined;
    let resolveAround: ((messages: ConversationMessage[]) => void) | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("initial")] })
      .mockImplementation(
        (_id: string, opts?: { around?: string; signal?: AbortSignal }) =>
          new Promise((resolve) => {
            if (opts?.around) {
              resolveAround = (messages) => resolve({ messages });
            } else {
              newestSignal = opts?.signal;
              resolveNewest = (messages) => resolve({ messages });
            }
          }),
      );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    let newest: Promise<unknown>;
    let around: Promise<boolean>;
    act(() => {
      newest = result.current.loadConversationMessages("conv-a");
      around = result.current.loadConversationMessagesAround(
        "conv-a",
        "new-hit",
      );
    });
    expect(newestSignal?.aborted).toBe(true);
    await act(async () => {
      resolveAround?.([userMsg("around-window")]);
      resolveNewest?.([userMsg("stale-newest-window")]);
      await expect(around).resolves.toBe(true);
      await newest;
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("around-window")]);
  });

  it("prevents late prefetches from repopulating after per-conversation and global discard", async () => {
    const pending: Array<{
      signal?: AbortSignal;
      resolve: (messages: ConversationMessage[]) => void;
    }> = [];
    mocks.client.getConversationMessages.mockImplementation(
      (_id: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          pending.push({
            signal: opts?.signal,
            resolve: (messages) => resolve({ messages }),
          });
        }),
    );
    const { deps, setConversationMessages, activeConversationIdRef } =
      makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    act(() => {
      result.current.prefetchConversationMessages(["conv-a"]);
    });
    const firstPrefetch = pending[0];
    act(() => {
      result.current.discardConversationMessageState("conv-a");
      result.current.prefetchConversationMessages(["conv-a"]);
    });
    expect(firstPrefetch?.signal?.aborted).toBe(true);
    const replacementPrefetch = pending[1];
    await act(async () => {
      firstPrefetch?.resolve([userMsg("stale-prefetch")]);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      result.current.prefetchConversationMessages(["conv-a"]);
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.discardConversationMessageState();
    });
    expect(replacementPrefetch?.signal?.aborted).toBe(true);
    await act(async () => {
      replacementPrefetch?.resolve([userMsg("also-stale")]);
      await Promise.resolve();
      await Promise.resolve();
    });

    setConversationMessages.mockClear();
    let activeLoad: Promise<unknown>;
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
      activeLoad = result.current.loadConversationMessages("conv-a");
    });
    expect(setConversationMessages).toHaveBeenCalledWith([]);
    expect(
      setConversationMessages.mock.calls.some(([messages]) =>
        messages.some((message) => message.id === "stale-prefetch"),
      ),
    ).toBe(false);
    await act(async () => {
      pending[2]?.resolve([userMsg("fresh-active")]);
      await activeLoad;
    });
  });

  it("does not let an older prefetch downgrade the cache written by a newer active GET", async () => {
    const pending: Array<{
      resolve: (messages: ConversationMessage[]) => void;
      signal?: AbortSignal;
    }> = [];
    mocks.client.getConversationMessages.mockImplementation(
      (_id: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          pending.push({
            resolve: (messages) => resolve({ messages }),
            signal: opts?.signal,
          });
        }),
    );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));
    act(() => {
      result.current.prefetchConversationMessages(["conv-a"]);
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    let activeLoad: Promise<unknown>;
    act(() => {
      activeLoad = result.current.loadConversationMessages("conv-a");
    });
    expect(pending[0]?.signal?.aborted).toBe(true);
    await act(async () => {
      pending[1]?.resolve([userMsg("newest-active")]);
      await activeLoad;
      pending[0]?.resolve([userMsg("older-prefetch")]);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
      setConversationMessages([userMsg("b-visible")]);
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    setConversationMessages.mockClear();
    let revalidate: Promise<unknown>;
    act(() => {
      revalidate = result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("newest-active")]);
    expect(conversationMessagesRef.current).not.toEqual([
      userMsg("older-prefetch"),
    ]);
    await act(async () => {
      pending[2]?.resolve([userMsg("newest-active")]);
      await revalidate;
    });
  });

  it("purges visible rows, cache, and overlays synchronously on an explicit runtime authority switch", async () => {
    let resolveProfileB:
      | ((value: { messages: ConversationMessage[] }) => void)
      | undefined;
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({
        messages: [
          { ...userMsg("profile-a-row"), text: "private to profile A" },
        ],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProfileB = resolve;
          }),
      );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "shared-id";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("shared-id");
    });
    const profileAOverlay = {
      ...assistantMsg("temp-profile-a"),
      clientRenderId: "temp-profile-a",
      text: "profile A partial",
      timestamp: 10,
    };
    act(() => {
      setConversationMessages([
        ...conversationMessagesRef.current,
        profileAOverlay,
      ]);
      result.current.registerConversationMessageOverlay("shared-id", [
        profileAOverlay.clientRenderId,
      ]);
      runtimeAuthoritySwitchListener?.("before");
    });

    // The dedicated authority signal is emitted before the client repoints.
    // Nothing from profile A may remain visible under profile B, even during
    // the interval before B's first GET starts.
    expect(conversationMessagesRef.current).toEqual([]);
    expect(setConversationMessages).toHaveBeenLastCalledWith([]);
    let profileBLoad: Promise<unknown>;
    act(() => {
      result.current.claimConversationMessagesOwnership("shared-id");
      activeConversationIdRef.current = "shared-id";
      profileBLoad = result.current.loadConversationMessages("shared-id");
    });
    expect(conversationMessagesRef.current).toEqual([]);
    await act(async () => {
      resolveProfileB?.({
        messages: [
          { ...userMsg("profile-b-row"), text: "belongs to profile B" },
        ],
      });
      await profileBLoad;
    });
    expect(conversationMessagesRef.current).toEqual([
      { ...userMsg("profile-b-row"), text: "belongs to profile B" },
    ]);
  });

  it("preserves the live transcript across raw base repoints used by shared-to-dedicated handoff", async () => {
    const profileARow = {
      ...userMsg("profile-a-row"),
      text: "keep through silent handoff",
    };
    mocks.client.getConversationMessages.mockResolvedValueOnce({
      messages: [profileARow],
    });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "shared-id";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("shared-id");
    });

    act(() => {
      mocks.client.repointBaseUrl("https://dedicated.example.test");
      mocks.client.setBaseUrl("https://dedicated.example.test");
    });

    expect(conversationMessagesRef.current).toEqual([profileARow]);
    expect(runtimeAuthoritySwitchListener).toBeTypeOf("function");
  });

  it("patches an exact delete in a warm cache so transient revalidation cannot resurrect it", async () => {
    const kept = { ...userMsg("kept"), text: "keep" };
    const removed = {
      ...assistantMsg("removed"),
      clientRenderId: "temp-removed",
      text: "remove me",
      timestamp: 10,
    };
    const neighbor = { ...assistantMsg("neighbor"), text: "keep neighbor" };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({
        messages: [kept, removed, neighbor],
      })
      .mockResolvedValueOnce({ messages: [userMsg("b-only")] })
      .mockRejectedValueOnce(
        Object.assign(new Error("temporary"), { status: 503 }),
      );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    act(() => {
      result.current.registerConversationMessageOverlay("conv-a", [
        removed.clientRenderId,
      ]);
      setConversationMessages([kept, neighbor]);
      setConversationMessages([kept, removed, neighbor]);
      result.current.removeConversationMessageStateMessages("conv-a", {
        mode: "delete-exact",
        removedMessages: [removed],
      });
      expect(conversationMessagesRef.current).toEqual([kept, neighbor]);
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    let returnToA: Promise<unknown>;
    act(() => {
      returnToA = result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([kept, neighbor]);
    await act(async () => {
      await returnToA;
    });
    expect(conversationMessagesRef.current).toEqual([kept, neighbor]);
  });

  it("invalidates a wider newest cache when truncating from an around window", async () => {
    const kept = { ...userMsg("kept"), text: "keep", timestamp: 1 };
    const targetUser = {
      ...userMsg("target-user"),
      text: "retry me",
      timestamp: 10,
    };
    const targetAssistant = {
      ...assistantMsg("target-assistant"),
      text: "failed",
      timestamp: 11,
    };
    const hiddenNewerUser = {
      ...userMsg("hidden-newer-user"),
      text: "not in around",
      timestamp: 20,
    };
    const hiddenNewerAssistant = {
      ...assistantMsg("hidden-newer-assistant"),
      text: "also truncated",
      timestamp: 21,
    };
    const canonicalNewest = [
      kept,
      targetUser,
      targetAssistant,
      hiddenNewerUser,
      hiddenNewerAssistant,
    ];
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: canonicalNewest })
      .mockResolvedValueOnce({
        messages: [kept, targetUser, targetAssistant],
      })
      .mockResolvedValueOnce({ messages: [userMsg("b-only")] })
      .mockRejectedValueOnce(
        Object.assign(new Error("temporary"), { status: 503 }),
      );
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
      await result.current.loadConversationMessagesAround(
        "conv-a",
        "target-user",
      );
    });
    expect(conversationMessagesRef.current).toEqual([
      kept,
      targetUser,
      targetAssistant,
    ]);

    act(() => {
      // Simulate a stale newest GET committing while truncate was awaiting the
      // server. The success callback must restore the exact captured prefix.
      setConversationMessages(canonicalNewest);
      result.current.removeConversationMessageStateMessages("conv-a", {
        mode: "truncate",
        removedMessages: [targetUser, targetAssistant],
        preservedMessages: [kept],
      });
    });
    expect(conversationMessagesRef.current).toEqual([kept]);

    act(() => {
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      activeConversationIdRef.current = "conv-a";
    });
    let returnToA: Promise<unknown>;
    act(() => {
      returnToA = result.current.loadConversationMessages("conv-a");
    });
    expect(conversationMessagesRef.current).toEqual([]);
    await act(async () => {
      await returnToA;
    });
    expect(
      conversationMessagesRef.current.some((message) =>
        [
          "target-user",
          "target-assistant",
          "hidden-newer-user",
          "hidden-newer-assistant",
        ].includes(message.id),
      ),
    ).toBe(false);
  });

  it.each(["truncate", "delete-exact"] as const)(
    "does not consume a same-text replacement across stale snapshots after %s",
    async (mode) => {
      const oldUser = {
        ...userMsg("old-user"),
        text: "retry me",
        timestamp: 1_000,
      };
      const oldAssistant = {
        ...assistantMsg("old-assistant"),
        text: "failed",
        timestamp: 1_100,
      };
      mocks.client.getConversationMessages.mockResolvedValue({
        messages: [oldUser, oldAssistant],
      });
      const {
        deps,
        setConversationMessages,
        conversationMessagesRef,
        activeConversationIdRef,
      } = makeDeps();
      activeConversationIdRef.current = "conv-a";
      const { result } = renderHook(() => useDataLoaders(deps));
      await act(async () => {
        await result.current.loadConversationMessages("conv-a");
      });
      act(() => {
        result.current.removeConversationMessageStateMessages("conv-a", {
          mode,
          removedMessages: [oldUser, oldAssistant],
          preservedMessages: [],
        });
      });

      const replacementUser = {
        ...userMsg("temp-retry-user"),
        clientRenderId: "temp-retry-user",
        text: "retry me",
        timestamp: 1_005,
      };
      const replacementAssistant = {
        ...assistantMsg("temp-retry-assistant"),
        clientRenderId: "temp-retry-assistant",
        text: "",
        timestamp: 1_006,
      };
      act(() => {
        setConversationMessages([replacementUser, replacementAssistant]);
        result.current.registerConversationMessageOverlay("conv-a", [
          replacementUser.clientRenderId,
          replacementAssistant.clientRenderId,
        ]);
      });

      for (let reload = 0; reload < 3; reload += 1) {
        await act(async () => {
          await result.current.loadConversationMessages("conv-a");
        });
        expect(
          conversationMessagesRef.current
            .filter(
              (message) =>
                message.role === "user" && message.text === "retry me",
            )
            .map((message) => message.id),
        ).toEqual(["old-user", "temp-retry-user"]);
      }
      mocks.client.getConversationMessages.mockResolvedValue({
        messages: [
          {
            ...replacementUser,
            id: "durable-retry-user",
            clientRenderId: undefined,
          },
        ],
      });
      await act(async () => {
        await result.current.loadConversationMessages("conv-a");
      });
      expect(
        conversationMessagesRef.current
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ).toEqual(["durable-retry-user"]);
    },
  );

  it("does not let an around match retire overlay state and merges stale overlay rows chronologically", async () => {
    const before = { ...userMsg("before"), timestamp: 1 };
    const after = { ...userMsg("after"), timestamp: 30 };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [before, after] })
      .mockResolvedValueOnce({
        messages: [
          before,
          {
            ...assistantMsg("durable-middle"),
            text: "stale partial middle",
            timestamp: 20,
          },
          after,
        ],
      })
      .mockResolvedValueOnce({ messages: [before, after] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    const local = {
      ...assistantMsg("temp-resp-middle"),
      clientRenderId: "temp-resp-middle",
      text: "middle",
      timestamp: 20,
    };
    act(() => {
      setConversationMessages([before, local, after]);
      result.current.registerConversationMessageOverlay("conv-a", [
        local.clientRenderId,
      ]);
      setConversationMessages([
        before,
        { ...local, id: "durable-middle" },
        after,
      ]);
    });

    await act(async () => {
      await result.current.loadConversationMessagesAround("conv-a", "before");
    });
    expect(conversationMessagesRef.current[1]).toEqual({
      ...local,
      id: "durable-middle",
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["before", "durable-middle", "after"]);
  });

  it("never attributes visible rows to a destination from pending receipts", async () => {
    const sentAt = Date.now();
    persistPendingChatTurn({
      conversationId: "conv-b",
      clientMessageId: "receipt-only",
      text: "belongs nowhere visible",
      sentAt,
    });
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));
    act(() => {
      result.current.claimConversationMessagesOwnership("conv-a");
      setConversationMessages([
        {
          ...userMsg("temp-receipt-only"),
          text: "belongs nowhere visible",
          timestamp: sentAt,
        },
      ]);
      result.current.claimConversationMessagesOwnership("conv-b");
      activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loadConversationMessages("conv-b");
    });
    expect(conversationMessagesRef.current).toEqual([]);
  });
});
