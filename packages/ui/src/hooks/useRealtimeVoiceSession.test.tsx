/** Verifies useRealtimeVoiceSession through the package's configured test harness. */
// @vitest-environment jsdom
//
/**
 * Hook-level tests for `useRealtimeVoiceSession`.
 *
 * DoD posture: these drive the REAL hook + the REAL `createVoiceSessionClient`
 * through the client's fake TRANSPORTS (`voice-session-fakes.ts`: fake
 * WebSocket, fake AudioContext, fake getUserMedia). There is NO stub of the
 * thing under test — the full start→listen→final→speaking→bargein→stop flow
 * exercises the actual client framing/state machine, and the hook folds its
 * real callbacks. Fallback (mint 404) and permission-denied are driven through
 * the real mint fetch + the real getUserMedia denial, not simulated.
 */

import { Capacitor } from "@capacitor/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { client } from "../api/client";

import {
  deniedGetUserMedia,
  FakeMicAudioContext,
  FakePlaybackAudioContext,
  fakeGetUserMedia,
  makeWsFactory,
} from "../voice/__tests__/voice-session-fakes";
import {
  isRealtimeVoiceFlagEnabled,
  parseRealtimeVoiceFlag,
  useRealtimeVoiceSession,
} from "./useRealtimeVoiceSession";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const CONV_ID = "22222222-2222-2222-2222-222222222222";

interface MintOpts {
  status?: number;
}

function makeMintFetch(opts: MintOpts = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push(body);
    n += 1;
    const status = opts.status ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "nope" }), { status });
    }
    return new Response(
      JSON.stringify({
        sessionId: `sess-${n}`,
        wsUrl: `wss://cloud/api/v1/voice/session/ws?sessionId=sess-${n}`,
        token: `tok-${n}`,
        expiresAt: Date.now() + 60_000,
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
        iceServers: null,
      }),
      { status: 200 },
    );
  };
  return { fetch, calls };
}

/** Build hook options wired to the fake transports, sharing one WS factory. */
function makeOptions(overrides?: {
  flagEnabled?: boolean;
  mintStatus?: number;
  consentNonce?: string | null;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  agentId?: string | null;
  conversationId?: string | null;
  onMinted?: (minted: {
    sessionId: string;
    wsUrl: string;
    token: string;
    expiresAt: number | string;
    uplink: { codecs: Array<"pcm16" | "opus"> };
    downlink: { codecs: Array<"pcm16" | "opus"> };
  }) => void;
  playbackContext?: FakePlaybackAudioContext;
}) {
  const ws = makeWsFactory();
  const mint = makeMintFetch({ status: overrides?.mintStatus });
  const micCtx = new FakeMicAudioContext(16_000);
  const pbCtx =
    overrides?.playbackContext ?? new FakePlaybackAudioContext(16_000);
  let micContextCreates = 0;
  let playbackContextCreates = 0;
  const getConsentNonce = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValue(
      overrides?.consentNonce === undefined
        ? "nonce-1"
        : overrides.consentNonce,
    );
  const options = {
    agentId: overrides?.agentId === undefined ? AGENT_ID : overrides.agentId,
    conversationId:
      overrides?.conversationId === undefined
        ? CONV_ID
        : overrides.conversationId,
    flagEnabled: overrides?.flagEnabled ?? true,
    getConsentNonce,
    clientOptions: {
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: overrides?.getUserMedia ?? fakeGetUserMedia(),
      createMicAudioContext: () =>
        micContextCreates++ === 0 ? micCtx : new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () =>
        playbackContextCreates++ === 0
          ? pbCtx
          : new FakePlaybackAudioContext(16_000),
      now: () => Date.now(),
    },
    onMinted: overrides?.onMinted,
  };
  return { options, ws, mint, micCtx, pbCtx, getConsentNonce };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function beginStart(result: { current: UseRealtimeVoiceSessionStateForTest }) {
  let startPromise!: ReturnType<typeof result.current.start>;
  act(() => {
    startPromise = result.current.start();
  });
  return startPromise;
}

type UseRealtimeVoiceSessionStateForTest = ReturnType<
  typeof useRealtimeVoiceSession
>;

async function driveReady(
  ws: ReturnType<typeof makeWsFactory>,
  sessionId = "sess-1",
  traceId = "T1",
) {
  const sock = ws.last();
  await act(async () => {
    sock.emitOpen();
    await flushAsync();
    sock.emitControl({ t: "ready", sessionId, traceId });
    await flushAsync();
  });
  return sock;
}

describe("useRealtimeVoiceSession", () => {
  it("fails closed instead of crashing on a non-string legacy conversation id", async () => {
    const { options } = makeOptions({
      conversationId: { id: CONV_ID } as unknown as string,
    });

    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    expect(result.current.available).toBe(false);
    await expect(result.current.start()).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("invokes the advertised onMinted callback with the validated mint", async () => {
    const onMinted = vi.fn();
    const { options, ws } = makeOptions({ onMinted });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    const startPromise = beginStart(result);
    await flushAsync();
    await driveReady(ws);

    expect(onMinted).toHaveBeenCalledTimes(1);
    expect(onMinted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1" }),
    );
    await expect(startPromise).resolves.toEqual({ kind: "live" });
  });

  it("carries the native Browser implementation in voice view context", async () => {
    const native = vi
      .spyOn(Capacitor, "isNativePlatform")
      .mockReturnValue(true);
    const { options, ws, micCtx } = makeOptions();
    const { result, unmount } = renderHook(() =>
      useRealtimeVoiceSession(options),
    );
    try {
      const start = beginStart(result);
      await flushAsync();
      await act(async () => {
        ws.last().emitOpen();
        await flushAsync();
        ws.last().emitControl({
          t: "ready",
          sessionId: "sess-1",
          traceId: "native-context",
          uiContext: true,
        });
        await flushAsync();
      });
      await expect(start).resolves.toEqual({ kind: "live" });
      micCtx.scriptNode?.feed(new Float32Array(1600).fill(0.25));
      expect(ws.last().sentControls()).toContainEqual({
        t: "ui_context",
        context: expect.objectContaining({
          uiBrowserSurface: "native",
          uiClientId: client.clientId,
        }),
      });
    } finally {
      unmount();
      native.mockRestore();
    }
  });

  it("full flow: start → listening → partial → final → speaking → barge-in → stop through the REAL client", async () => {
    const stopTrack = vi.fn();
    const { options, ws, micCtx, pbCtx, getConsentNonce } = makeOptions({
      getUserMedia: async () =>
        ({
          getTracks: () => [{ stop: stopTrack }],
        }) as unknown as MediaStream,
    });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    // Flag on + ids present + not-yet-disabled ⇒ available for the batch caller
    // to hand the mic to.
    expect(result.current.available).toBe(true);
    expect(result.current.active).toBe(false);
    expect(result.current.status).toBe("idle");

    // Start on the user gesture.
    const startPromise = beginStart(result);
    await flushAsync();
    // Consent was fetched fresh for the session, mint was called with our ids.
    expect(getConsentNonce).toHaveBeenCalledTimes(1);

    // Drive the transport open + ready.
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      sock.emitControl({ t: "ready", sessionId: "sess-1", traceId: "T1" });
      await flushAsync();
    });

    // Playback was unlocked on the start gesture (AudioContext resumed).
    expect(pbCtx.state).toBe("running");
    // Mic capture started on ready.
    expect(micCtx.scriptNode).not.toBeNull();

    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(startPromise).resolves.toEqual({ kind: "live" });
    await waitFor(() => expect(result.current.status).toBe("listening"));

    // Partial → final transcript.
    await act(async () => {
      sock.emitControl({ t: "stt_partial", text: "hel", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.transcriptPartial).toBe("hel");
    expect(result.current.status).toBe("transcribing");

    await act(async () => {
      sock.emitControl({ t: "stt_final", text: "hello", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.transcriptFinal).toBe("hello");
    expect(result.current.transcriptPartial).toBe("");

    // Thinking → speaking.
    await act(async () => {
      sock.emitControl({ t: "llm_first_text", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.status).toBe("thinking");

    await act(async () => {
      sock.emitControl({ t: "speaking_start", traceId: "T1" });
      sock.emitAudio(new Uint8Array(320));
      await flushAsync();
    });
    expect(result.current.status).toBe("speaking");
    expect(result.current.agentSpeaking).toBe(true);

    // Barge-in while speaking flushes local playback + sends {t:"barge_in"}.
    await act(async () => {
      result.current.bargeIn();
      await flushAsync();
    });
    const controls = sock.sentControls();
    expect(controls.some((c) => c.t === "barge_in")).toBe(true);

    // Server confirms interrupted → loops to listening.
    await act(async () => {
      sock.emitControl({ t: "interrupted", reason: "explicit", traceId: "T1" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.status).toBe("listening"));
    expect(result.current.agentSpeaking).toBe(false);

    // Clean stop → bye + teardown.
    await act(async () => {
      await result.current.stop();
      await result.current.stop();
    });
    expect(sock.sentControls().some((c) => c.t === "bye")).toBe(true);
    expect(sock.closed?.code).toBe(1000);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(micCtx.closed).toBe(true);
    expect(pbCtx.closed).toBe(true);
    expect(result.current.active).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  it("does not report active until socket open + server ready + mic capturing (truthful `active`)", async () => {
    const { options, ws, micCtx } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    const startPromise = beginStart(result);
    await flushAsync();
    // start() resolved, but nothing is connected yet: connecting, NOT active —
    // the socket has not opened, no server `ready`, no mic.
    expect(result.current.active).toBe(false);
    expect(result.current.connecting).toBe(true);

    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
    });
    // Open alone is still not live: no server ready, no mic capture.
    expect(result.current.active).toBe(false);

    await act(async () => {
      sock.emitControl({ t: "ready", sessionId: "sess-1", traceId: "T1" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(startPromise).resolves.toEqual({ kind: "live" });
    expect(result.current.connecting).toBe(false);
    // The mic really is capturing (the fake mic graph is attached).
    expect(micCtx.scriptNode).not.toBeNull();

    await act(async () => {
      await result.current.stop();
    });
  });

  it("fails a black-holed connect into a retryable transport error instead of hanging (ready timeout)", async () => {
    const { options, ws, mint } = makeOptions();
    const { result, rerender } = renderHook(
      ({ readyTimeoutMs }) =>
        useRealtimeVoiceSession({ ...options, readyTimeoutMs }),
      { initialProps: { readyTimeoutMs: 30 } },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    expect(result.current.connecting).toBe(true);
    // The socket never opens. The connect/ready watchdog must fail the session
    // into the error path rather than showing "connecting" forever.
    await waitFor(() => expect(result.current.error?.kind).toBe("transport"));
    await expect(firstStart).resolves.toEqual({
      kind: "fallback-to-batch",
      reason: "transport",
    });
    expect(result.current.error?.actionable).toBe(true);
    expect(result.current.error?.message).toMatch(/timed out/i);
    expect(result.current.active).toBe(false);
    expect(result.current.connecting).toBe(false);
    expect(result.current.status).toBe("idle");
    // NOT latched: the advertised mic-tap retry must actually be possible.
    expect(result.current.available).toBe(true);
    // The stalled socket was torn down, not leaked.
    const first = ws.sockets[0];
    await waitFor(() => expect(first.closed).not.toBeNull());

    // Retry on the next tap: a fresh start clears the error, re-mints with a
    // fresh consent nonce, and can reach live. The timeout behavior is already
    // proven above; the retry uses the production budget so a loaded CI event
    // loop cannot turn this independent assertion into another timeout test.
    rerender({ readyTimeoutMs: 15_000 });
    const retryStart = beginStart(result);
    await flushAsync();
    expect(result.current.error).toBeNull();
    expect(mint.calls).toHaveLength(2);
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      sock.emitControl({ t: "ready", sessionId: "sess-2", traceId: "T2" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(retryStart).resolves.toEqual({ kind: "live" });

    await act(async () => {
      await result.current.stop();
    });
  });

  it("identifies a post-ready microphone setup timeout without blaming the connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pendingMic = deferred<MediaStream>();
      const stopTrack = vi.fn();
      const { options, ws } = makeOptions({
        getUserMedia: () => pendingMic.promise,
      });
      const { result } = renderHook(() =>
        useRealtimeVoiceSession({ ...options, readyTimeoutMs: 30 }),
      );

      const startPromise = beginStart(result);
      await vi.advanceTimersByTimeAsync(0);
      const sock = ws.last();
      await act(async () => {
        sock.emitOpen();
        await vi.advanceTimersByTimeAsync(0);
        sock.emitControl({ t: "ready", sessionId: "sess-1", traceId: "T1" });
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(result.current.error?.kind).toBe("transport");
      await expect(startPromise).resolves.toEqual({
        kind: "fallback-to-batch",
        reason: "transport",
        message:
          "Microphone setup timed out. Check browser microphone permission, then tap Talk to retry.",
      });
      expect(result.current.error?.message).toMatch(
        /microphone setup timed out/i,
      );
      expect(result.current.error?.message).not.toMatch(/connection/i);
      expect(result.current.error?.actionable).toBe(true);

      // If the non-abortable browser promise settles after teardown, its tracks
      // are still released rather than leaking a hot microphone.
      await act(async () => {
        pendingMic.resolve({
          getTracks: () => [{ stop: stopTrack }],
        } as unknown as MediaStream);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(stopTrack).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fallback: a mint 404 stays retryable and records the indicator reason", async () => {
    const { options } = makeOptions({ mintStatus: 404 });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    expect(result.current.available).toBe(true);
    let startOutcome:
      | Awaited<ReturnType<typeof result.current.start>>
      | undefined;
    await act(async () => {
      startOutcome = await result.current.start();
      await flushAsync();
    });

    // The current interaction falls back, but the next tap probes realtime again.
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toBeNull();
    expect(startOutcome).toEqual({
      kind: "fallback-to-batch",
      reason: "mint",
    });
    expect(result.current.fallbackReason).toBe("mint");
  });

  it("fallback: a pre-ready mint failure resolves to same-gesture batch fallback", async () => {
    const { options } = makeOptions({ mintStatus: 503 });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    let startOutcome:
      | Awaited<ReturnType<typeof result.current.start>>
      | undefined;
    await act(async () => {
      startOutcome = await result.current.start();
      await flushAsync();
    });

    expect(result.current.error?.kind).toBe("mint");
    expect(result.current.active).toBe(false);
    expect(startOutcome).toEqual({
      kind: "fallback-to-batch",
      reason: "mint",
    });
  });

  it("fallback: a pre-ready WebSocket failure resolves to same-gesture batch fallback", async () => {
    const { options, ws } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    const startPromise = beginStart(result);
    await flushAsync();
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      sock.emitClose(1006, "pre-ready");
      await flushAsync();
    });

    await waitFor(() => expect(result.current.error?.kind).toBe("transport"));
    expect(result.current.active).toBe(false);
    await expect(startPromise).resolves.toEqual({
      kind: "fallback-to-batch",
      reason: "transport",
    });
  });

  it("recovers a LIVE session across a transport drop without surfacing an error (no batch fallback)", async () => {
    const { options, ws, mint } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    const startPromise = beginStart(result);
    await flushAsync();
    const sock = await driveReady(ws, "sess-1", "T1");
    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(startPromise).resolves.toEqual({ kind: "live" });

    // The wifi-switch class: the live socket dies. The hook must leave the
    // client's reconnect budget intact (never zero it), so the REAL client
    // re-mints and reconnects instead of surfacing a transport error.
    await act(async () => {
      sock.emitClose(1006, "post-ready network change");
      await flushAsync();
    });
    await waitFor(() => expect(mint.calls.length).toBe(2));
    const second = ws.last();
    expect(second).not.toBe(sock);
    await act(async () => {
      second.emitOpen();
      await flushAsync();
      second.emitControl({ t: "ready", sessionId: "sess-2", traceId: "T2" });
      await flushAsync();
    });

    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.available).toBe(true);
    await act(async () => {
      await result.current.stop();
    });
  });

  it("does not arm when the VITE flag is off (batch path owns the mic)", async () => {
    const { options, getConsentNonce } = makeOptions({ flagEnabled: false });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    expect(result.current.available).toBe(false);
    let outcome: Awaited<ReturnType<typeof result.current.start>> | undefined;
    await act(async () => {
      outcome = await result.current.start();
      await flushAsync();
    });
    // Never minted, never fetched consent, never active.
    expect(getConsentNonce).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("cancels an in-flight consent start when the realtime flag flips off", async () => {
    const { options, mint } = makeOptions();
    let resolveConsent: ((nonce: string | null) => void) | undefined;
    const getConsentNonce = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveConsent = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ flagEnabled }) =>
        useRealtimeVoiceSession({
          ...options,
          flagEnabled,
          getConsentNonce,
        }),
      { initialProps: { flagEnabled: true } },
    );

    let startPromise: ReturnType<typeof result.current.start> | undefined;
    act(() => {
      startPromise = result.current.start();
    });
    act(() => rerender({ flagEnabled: false }));
    await act(async () => {
      resolveConsent?.("nonce-after-disable");
      await startPromise;
    });

    expect(mint.calls).toHaveLength(0);
    expect(result.current.active).toBe(false);
    expect(result.current.available).toBe(false);
  });

  it("permission-denied surfaces an actionable `permission` error state", async () => {
    const { options, ws } = makeOptions({
      getUserMedia: deniedGetUserMedia(),
    });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    const startPromise = beginStart(result);
    await flushAsync();
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      // ready triggers mic capture → getUserMedia denial.
      sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
      await flushAsync();
    });

    await waitFor(() => expect(result.current.error?.kind).toBe("permission"));
    expect(result.current.error?.actionable).toBe(true);
    await expect(startPromise).resolves.toMatchObject({
      kind: "error",
      error: { kind: "permission" },
    });
  });

  it("consent unavailable (nonce null) surfaces a `consent` error and never mints", async () => {
    const { options, mint } = makeOptions({ consentNonce: null });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    let startOutcome:
      | Awaited<ReturnType<typeof result.current.start>>
      | undefined;
    await act(async () => {
      startOutcome = await result.current.start();
      await flushAsync();
    });
    expect(result.current.error?.kind).toBe("consent");
    // No mint request was made — consent is a hard precondition client-side too.
    expect(mint.calls.length).toBe(0);
    expect(result.current.active).toBe(false);
    // This interaction falls back, while the next user tap may retry realtime.
    expect(result.current.available).toBe(true);
    expect(result.current.error?.actionable).toBe(true);
    expect(result.current.error?.message).toBe(
      "Voice setup couldn't complete. Tap the mic to try again.",
    );
    expect(startOutcome).toEqual({
      kind: "fallback-to-batch",
      reason: "consent",
    });
  });

  it("is unavailable without agent/conversation ids even when the flag is on", () => {
    const { options } = makeOptions({ agentId: null });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));
    expect(result.current.available).toBe(false);
  });

  it("surfaces a paused (not broken) state on a visibility-suspend, and clears on resume", async () => {
    const { options, ws, micCtx } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));
    const startPromise = beginStart(result);
    await flushAsync();
    await driveReady(ws, "s", "T1");
    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(startPromise).resolves.toEqual({ kind: "live" });
    expect(result.current.paused).toBe(false);

    // The mic-capture fires onSuspend on a page-hide, which the client marks
    // `mic_suspended`. Drive that through the real mic-capture visibility path.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await flushAsync();
    });
    await waitFor(() => expect(result.current.paused).toBe(true));
    // Still active — a paused mic is not a torn-down session.
    expect(result.current.active).toBe(true);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await flushAsync();
    });
    await waitFor(() => expect(result.current.paused).toBe(false));
    void micCtx;

    await act(async () => {
      await result.current.stop();
    });
  });

  it("stops and re-mints when the active agent or conversation identity changes", async () => {
    const { options, ws, mint } = makeOptions();
    const { result, rerender } = renderHook(
      ({ agentId, conversationId }) =>
        useRealtimeVoiceSession({ ...options, agentId, conversationId }),
      {
        initialProps: { agentId: AGENT_ID, conversationId: CONV_ID },
      },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    const first = await driveReady(ws, "s1", "T1");
    await expect(firstStart).resolves.toEqual({ kind: "live" });

    const nextConversationId = "33333333-3333-3333-3333-333333333333";
    act(() => {
      rerender({ agentId: AGENT_ID, conversationId: nextConversationId });
    });

    await waitFor(() => expect(mint.calls).toHaveLength(2));
    expect(first.closed?.code).toBe(1000);
    expect(mint.calls[1]).toMatchObject({
      agentId: AGENT_ID,
      conversationId: nextConversationId,
    });
    expect(ws.sockets).toHaveLength(2);

    await act(async () => {
      await result.current.stop();
    });
  });

  it("rapid identity changes re-mint only the newest identity", async () => {
    const closeGate = deferred<void>();
    const closeStarted = vi.fn();
    class DeferredPlaybackCloseContext extends FakePlaybackAudioContext {
      override async close(): Promise<void> {
        closeStarted();
        await closeGate.promise;
        await super.close();
      }
    }
    const { options, mint, ws } = makeOptions({
      playbackContext: new DeferredPlaybackCloseContext(16_000),
    });
    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        useRealtimeVoiceSession({ ...options, conversationId }),
      { initialProps: { conversationId: CONV_ID } },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    await driveReady(ws, "s1", "T1");
    await expect(firstStart).resolves.toEqual({ kind: "live" });
    act(() => {
      rerender({
        conversationId: "33333333-3333-3333-3333-333333333333",
      });
    });
    await waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(1));

    act(() => {
      rerender({
        conversationId: "44444444-4444-4444-4444-444444444444",
      });
    });
    await waitFor(() => expect(mint.calls).toHaveLength(2));
    expect(mint.calls[1]).toMatchObject({
      agentId: AGENT_ID,
      conversationId: "44444444-4444-4444-4444-444444444444",
    });
    expect(ws.sockets).toHaveLength(2);

    const newest = ws.last();
    await act(async () => {
      newest.emitOpen();
      newest.emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
      await flushAsync();
    });
    await waitFor(() => {
      expect(result.current.active).toBe(true);
      expect(result.current.status).toBe("listening");
    });

    closeGate.resolve();
    await act(async () => {
      await flushAsync();
    });
    expect(mint.calls).toHaveLength(2);
    expect(result.current.active).toBe(true);
    expect(result.current.status).toBe("listening");
    await act(async () => {
      await result.current.stop();
    });
  });

  it("does not re-mint after the user stops during identity-change teardown", async () => {
    const closeGate = deferred<void>();
    const closeStarted = vi.fn();
    class DeferredPlaybackCloseContext extends FakePlaybackAudioContext {
      override async close(): Promise<void> {
        closeStarted();
        await closeGate.promise;
        await super.close();
      }
    }
    const { options, mint, ws } = makeOptions({
      playbackContext: new DeferredPlaybackCloseContext(16_000),
    });
    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        useRealtimeVoiceSession({ ...options, conversationId }),
      { initialProps: { conversationId: CONV_ID } },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    await driveReady(ws, "s1", "T1");
    await expect(firstStart).resolves.toEqual({ kind: "live" });
    act(() => {
      rerender({
        conversationId: "33333333-3333-3333-3333-333333333333",
      });
    });
    await waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.stop();
    });
    closeGate.resolve();
    await act(async () => {
      await flushAsync();
    });

    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
    expect(result.current.active).toBe(false);
  });

  it("does not auto-restart after operational identity loss during deferred teardown", async () => {
    const closeGate = deferred<void>();
    const closeStarted = vi.fn();
    class DeferredPlaybackCloseContext extends FakePlaybackAudioContext {
      override async close(): Promise<void> {
        closeStarted();
        await closeGate.promise;
        await super.close();
      }
    }
    const { options, mint, ws } = makeOptions({
      playbackContext: new DeferredPlaybackCloseContext(16_000),
    });
    const nextConversationId = "55555555-5555-4555-8555-555555555555";
    const { result, rerender } = renderHook(
      ({ agentId, conversationId, flagEnabled }) =>
        useRealtimeVoiceSession({
          ...options,
          agentId,
          conversationId,
          flagEnabled,
        }),
      {
        initialProps: {
          agentId: AGENT_ID as string | null,
          conversationId: CONV_ID,
          flagEnabled: true,
        },
      },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    await driveReady(ws, "s1", "T1");
    await expect(firstStart).resolves.toEqual({ kind: "live" });

    // The bound readiness probe disarms before the next conversation proves
    // itself. Operational flag-off must synchronously revoke the hook's
    // identity-restart ownership even though the old AudioContext is still
    // closing.
    act(() => {
      rerender({
        agentId: null,
        conversationId: nextConversationId,
        flagEnabled: false,
      });
    });
    await waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(1));

    // A fast positive probe for B cannot resurrect realtime while teardown A
    // is pending. Batch remains the owner until a later explicit user start.
    act(() => {
      rerender({
        agentId: AGENT_ID,
        conversationId: nextConversationId,
        flagEnabled: true,
      });
    });
    await flushAsync();
    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);

    closeGate.resolve();
    await act(async () => {
      await flushAsync();
    });
    await waitFor(() => expect(result.current.active).toBe(false));
    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);

    const explicitStart = beginStart(result);
    await flushAsync();
    expect(mint.calls).toHaveLength(2);
    expect(mint.calls[1]).toMatchObject({
      agentId: AGENT_ID,
      conversationId: nextConversationId,
    });
    await driveReady(ws, "s2", "T2");
    await expect(explicitStart).resolves.toEqual({ kind: "live" });

    await act(async () => {
      await result.current.stop();
    });
  });

  it("does not re-mint after unmount during identity-change teardown", async () => {
    const closeGate = deferred<void>();
    const closeStarted = vi.fn();
    class DeferredPlaybackCloseContext extends FakePlaybackAudioContext {
      override async close(): Promise<void> {
        closeStarted();
        await closeGate.promise;
        await super.close();
      }
    }
    const { options, mint, ws } = makeOptions({
      playbackContext: new DeferredPlaybackCloseContext(16_000),
    });
    const { result, rerender, unmount } = renderHook(
      ({ conversationId }) =>
        useRealtimeVoiceSession({ ...options, conversationId }),
      { initialProps: { conversationId: CONV_ID } },
    );

    const firstStart = beginStart(result);
    await flushAsync();
    await driveReady(ws, "s1", "T1");
    await expect(firstStart).resolves.toEqual({ kind: "live" });
    act(() => {
      rerender({
        conversationId: "44444444-4444-4444-4444-444444444444",
      });
    });
    await waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(1));

    unmount();
    closeGate.resolve();
    await flushAsync();

    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
  });

  it("surfaces realtime autoplay blocking and clears it after an unlock gesture", async () => {
    class BlockedPlaybackContext extends FakePlaybackAudioContext {
      allowResume = false;
      resumeAttempts = 0;

      override async resume(): Promise<void> {
        this.resumeAttempts += 1;
        if (this.allowResume) this.state = "running";
      }
    }

    const playback = new BlockedPlaybackContext(16_000);
    const { options, ws } = makeOptions({ playbackContext: playback });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));
    const startPromise = beginStart(result);
    await flushAsync();
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
      sock.emitControl({ t: "speaking_start", traceId: "T1" });
      sock.emitAudio(new Uint8Array(320));
      await flushAsync();
    });
    await expect(startPromise).resolves.toEqual({ kind: "live" });

    await waitFor(() => expect(result.current.needsUnlock).toBe(true));
    playback.allowResume = true;
    await act(async () => {
      await result.current.unlock();
    });
    await waitFor(() => expect(result.current.needsUnlock).toBe(false));
    expect(playback.resumeAttempts).toBeGreaterThanOrEqual(2);

    await act(async () => {
      await result.current.stop();
    });
  });

  it("tears down the live client on unmount (no lingering socket/mic)", async () => {
    const { options, ws, micCtx } = makeOptions();
    const { result, unmount } = renderHook(() =>
      useRealtimeVoiceSession(options),
    );
    const startPromise = beginStart(result);
    await flushAsync();
    const sock = await driveReady(ws, "s", "T1");
    await waitFor(() => expect(result.current.active).toBe(true));
    await expect(startPromise).resolves.toEqual({ kind: "live" });

    unmount();
    await flushAsync();
    // The socket was closed cleanly (bye + close(1000)) and the mic ctx closed.
    expect(sock.closed).not.toBeNull();
    await waitFor(() => expect(micCtx.closed).toBe(true));
  });
});

describe("isRealtimeVoiceFlagEnabled", () => {
  it("makes realtime available without build flags while preserving explicit opt-out", () => {
    try {
      vi.stubEnv("VITE_VOICE_REALTIME_WS", undefined);
      expect(isRealtimeVoiceFlagEnabled()).toBe(true);
      vi.stubEnv("VITE_VOICE_REALTIME_WS", "0");
      expect(isRealtimeVoiceFlagEnabled()).toBe(false);
      vi.stubEnv("VITE_VOICE_REALTIME_WS", "invalid");
      expect(isRealtimeVoiceFlagEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["1", "true", "TRUE", " yes ", "on"])(
    "accepts the explicit opt-in value %j",
    (value) => {
      expect(parseRealtimeVoiceFlag(value)).toBe(true);
    },
  );

  it.each([undefined, null, "", "0", "false", "off", "cloud", "enabled", 1])(
    "rejects absent, disabled, and unknown value %j",
    (value) => {
      expect(parseRealtimeVoiceFlag(value)).toBe(false);
    },
  );
});
