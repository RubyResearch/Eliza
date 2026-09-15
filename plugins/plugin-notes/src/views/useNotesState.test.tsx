/**
 * Exercises the browser synchronization hook against controlled transport
 * promises, including lifecycle refreshes that can overlap after a reconnect.
 *
 * @vitest-environment jsdom
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesSnapshot } from "../types.js";

const transport = vi.hoisted(() => ({
  fetchState: vi.fn(),
  interact: vi.fn(),
  viewEvents: new Map<string, () => void>(),
  wsEvents: new Map<string, () => void>(),
}));

const authorityState = vi.hoisted(() => ({
  value: "profile-a\u0000https://same-agent.test",
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    onWsEvent: (eventType: string, callback: () => void) => {
      transport.wsEvents.set(eventType, callback);
      return () => transport.wsEvents.delete(eventType);
    },
  },
}));

vi.mock("@elizaos/ui/events", () => ({
  VIEW_EVENTS: { VIEW_REFRESH: "view:refresh" },
  useViewEvent: (eventType: string, callback: () => void) => {
    transport.viewEvents.set(eventType, callback);
  },
}));

vi.mock("@elizaos/ui/hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityState.value,
}));

vi.mock("./notesData.js", () => ({
  fetchNotesState: transport.fetchState,
  interact: transport.interact,
  NOTES_UPDATED_EVENT: "view:notes:updated",
  NOTES_STATE_UPDATED_EVENT: "notes:state-updated",
}));

import { ApiError } from "@elizaos/ui/api/client-types-core";
import { useNotesState } from "./useNotesState.js";

function snapshot(revision: number): NotesSnapshot {
  return { notes: [], revision };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let visibilityState = "visible";

beforeEach(() => {
  transport.fetchState.mockReset();
  transport.interact.mockReset();
  transport.viewEvents.clear();
  transport.wsEvents.clear();
  authorityState.value = "profile-a\u0000https://same-agent.test";
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

describe("useNotesState", () => {
  it("keeps an initial load distinct from an empty snapshot and a load error", async () => {
    const pending = deferred<NotesSnapshot>();
    transport.fetchState.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useNotesState());

    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      pending.reject(new Error("Local agent is offline"));
      await pending.promise.catch(() => undefined);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error?.message).toBe("Local agent is offline");
  });

  it("preserves the Shared capability ApiError and its retryability payload", async () => {
    const capabilityData = {
      success: false,
      code: "notes_runtime_unavailable",
      error:
        "Notes require a dedicated agent runtime; this shared agent does not have a persistent notes store.",
      capability: "notes",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
      retryable: false,
    } as const;
    const capabilityError = new ApiError({
      kind: "http",
      path: "/api/notes/state",
      status: 503,
      code: capabilityData.code,
      message: capabilityData.error,
      data: capabilityData,
    });
    transport.fetchState.mockRejectedValueOnce(capabilityError);

    const { result } = renderHook(() => useNotesState());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(capabilityError);
    expect(result.current.error).toMatchObject({
      name: "ApiError",
      code: "notes_runtime_unavailable",
    });
    expect((result.current.error as ApiError).data).toEqual(capabilityData);
  });

  it("retains cached data and its sync error until a background retry succeeds", async () => {
    const cached = snapshot(1);
    transport.fetchState.mockResolvedValueOnce(cached);
    const { result } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot).toBe(cached));

    const offline = new Error("Local agent is offline");
    transport.fetchState.mockRejectedValueOnce(offline);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe(offline);
    const retry = deferred<NotesSnapshot>();
    transport.fetchState.mockReturnValueOnce(retry.promise);
    act(() => {
      void result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot).toBe(cached);
    expect(result.current.error).toBe(offline);

    await act(async () => {
      retry.resolve(snapshot(2));
      await retry.promise;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot?.revision).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it("recovers stale state from the client's websocket reconnect event", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));

    transport.fetchState.mockResolvedValueOnce(snapshot(4));
    act(() => transport.wsEvents.get("ws-reconnected")?.());

    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4));
    expect(transport.fetchState).toHaveBeenCalledTimes(2);
  });

  it("refreshes after browser connectivity returns and only when a hidden document becomes visible", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
    expect(transport.fetchState).toHaveBeenCalledTimes(1);

    transport.fetchState.mockResolvedValueOnce(snapshot(2));
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2));

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(transport.fetchState).toHaveBeenCalledTimes(2);

    transport.fetchState.mockResolvedValueOnce(snapshot(3));
    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));
    expect(transport.fetchState).toHaveBeenCalledTimes(3);
  });

  it("converges on the newest revision when lifecycle refreshes finish out of order", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
    expect(transport.fetchState).toHaveBeenCalledTimes(1);

    const reconnect = deferred<NotesSnapshot>();
    const visible = deferred<NotesSnapshot>();
    transport.fetchState
      .mockReturnValueOnce(reconnect.promise)
      .mockReturnValueOnce(visible.promise);

    act(() => transport.wsEvents.get("ws-reconnected")?.());
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await act(async () => {
      visible.resolve(snapshot(3));
      await visible.promise;
    });
    expect(result.current.snapshot?.revision).toBe(3);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      reconnect.resolve(snapshot(2));
      await reconnect.promise;
    });
    expect(result.current.snapshot?.revision).toBe(3);
    expect(result.current.loading).toBe(false);
  });

  it("masks the prior profile and rejects its late refresh on a same-base switch", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result, rerender } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));

    const staleProfileRefresh = deferred<NotesSnapshot>();
    const activeProfileRefresh = deferred<NotesSnapshot>();
    transport.fetchState
      .mockReturnValueOnce(staleProfileRefresh.promise)
      .mockReturnValueOnce(activeProfileRefresh.promise);

    act(() => {
      void result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    const staleSignal = transport.fetchState.mock.calls[1]?.[0] as AbortSignal;
    expect(staleSignal.aborted).toBe(false);

    authorityState.value = "profile-b\u0000https://same-agent.test";
    rerender();

    expect(staleSignal.aborted).toBe(true);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(transport.fetchState).toHaveBeenCalledTimes(3));
    const activeSignal = transport.fetchState.mock.calls[2]?.[0] as AbortSignal;
    expect(activeSignal.aborted).toBe(false);

    await act(async () => {
      staleProfileRefresh.resolve(snapshot(99));
      await staleProfileRefresh.promise;
    });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      activeProfileRefresh.resolve(snapshot(2));
      await activeProfileRefresh.promise;
    });
    expect(result.current.snapshot?.revision).toBe(2);
    expect(result.current.loading).toBe(false);
  });

  it("aborts an in-flight initial read when the mounted view unmounts", () => {
    transport.fetchState.mockReturnValueOnce(
      new Promise<NotesSnapshot>(() => undefined),
    );
    const view = renderHook(() => useNotesState());
    const signal = transport.fetchState.mock.calls[0]?.[0] as AbortSignal;

    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("refreshes shared state after view updates or a completed chat action", async () => {
    transport.fetchState.mockResolvedValueOnce(snapshot(1));
    const { result } = renderHook(() => useNotesState());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));

    transport.fetchState.mockResolvedValueOnce(snapshot(2));
    act(() => transport.viewEvents.get("view:notes:updated")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2));

    transport.fetchState.mockResolvedValueOnce(snapshot(3));
    act(() => transport.viewEvents.get("notes:state-updated")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));

    transport.fetchState.mockResolvedValueOnce(snapshot(4));
    act(() => transport.viewEvents.get("view:refresh")?.());
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4));

    expect(transport.fetchState).toHaveBeenCalledTimes(4);
  });
});
