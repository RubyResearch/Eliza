/**
 * Realtime voice-session client — the ONE browser implementation both the iOS
 * installed PWA and the LP3 Capacitor APK (WebView 113) use.
 *
 * Lifecycle (contract §7.1/§7.2/§7.4):
 *   1. mint: POST /api/v1/voice/session with the Eliza bearer/session →
 *      { sessionId, wsUrl, token, expiresAt, uplink, downlink }.
 *   2. open WSS, send the FIRST frame as a JSON `hello` carrying the token
 *      (NEVER a WS header — WebView 113 can't set them reliably).
 *   3. negotiated pcm16 16 kHz mono uplink/downlink. Handle every server event
 *      per §7.2. Reconnect = RE-MINT (a revoked/expired token can't reconnect).
 *   4. clean `bye` + close.
 *
 * Transport recovery: any unexpected close, fatal server frame, or failed
 * re-mint consumes one attempt from a bounded reconnect budget with growing
 * backoff between attempts, so a network switch that outlives a single mint
 * still recovers. A session continuously live past `reconnectBudgetResetMs`
 * refills the budget on its next loss — long sessions tolerate well-separated
 * drops forever, while a connect-die loop stays bounded. The server hard-severs
 * at the bootstrap token's exp (<=120s), so the client proactively ROTATES the
 * session (clean bye + re-mint) shortly before expiry, but only at an idle
 * `listening` boundary — never mid-turn — making the periodic sever invisible.
 *
 * The client wires:
 *   - voice-session-mic-capture (getUserMedia → AudioWorklet/ScriptProcessor →
 *     Int16 PCM uplink frames)
 *   - voice-session-playback (streaming PCM sink, no decodeAudioData barrier)
 *   - voice-session-state (the §7.4 machine, mapped into the unified voice
 *     status via toContinuousStatus)
 *
 * Barge-in: `bargeIn()` flushes local playback IMMEDIATELY and sends
 * `{t:"barge_in"}`; it does NOT wait for the server `interrupted` event to stop
 * audible output, but reconciles state when that event arrives.
 *
 * Trace: the client carries `traceId` from server events onto client playout
 * marks (`onTraceMark`). A mark never reached is reported as
 * `not_reached(reason)`, never synthesized and never renamed.
 *
 * Everything third-party (WebSocket ctor, AudioContext, getUserMedia, mint fetch)
 * is injectable so tests drive the REAL framing/state/barge-in/reconnect code
 * through fakes — not stubs of the client itself.
 */

import { parseVoiceUiContext, type VoiceUiContext } from "@elizaos/shared";
import type { VoiceContinuousStatus } from "./voice-chat-types";
import {
  type MicAudioContextLike,
  startVoiceMicCapture,
  type VoiceMicCapture,
  VoiceMicCaptureError,
} from "./voice-session-mic-capture";
import {
  createVoiceSessionPlayback,
  type PlaybackAudioContextLike,
  type VoiceSessionPlayback,
  type VoiceSessionPlaybackStatsEvent,
} from "./voice-session-playback";
import {
  DEFAULT_DOWNLINK_CODEC,
  DEFAULT_UPLINK_CODEC,
  encodeClientControl,
  isUsableMintResponse,
  negotiateCodec,
  parseServerControl,
  type ServerControlFrame,
  VOICE_SESSION_PROTOCOL_VERSION,
  VOICE_SESSION_SAMPLE_RATE,
  type VoiceSessionCodec,
  type VoiceSessionMintResponse,
} from "./voice-session-protocol";
import {
  applyClientAction,
  applyServerEvent,
  beginListening,
  INITIAL_VOICE_SESSION_STATE,
  loopToListening,
  toContinuousStatus,
  type VoiceSessionMachineState,
} from "./voice-session-state";

/** Minimal WebSocket surface the client drives (native or fake). */
export interface VoiceWebSocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

function isVoiceWebSocketLike(value: unknown): value is VoiceWebSocketLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "binaryType") === "string" &&
    typeof Reflect.get(value, "send") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function closeInvalidNativeWebSocket(socket: unknown): void {
  if ((typeof socket !== "object" && typeof socket !== "function") || !socket) {
    return;
  }
  try {
    const close: unknown = Reflect.get(socket, "close");
    if (typeof close === "function") Reflect.apply(close, socket, []);
  } catch (ignoredError) {
    // error-policy:J6 Best-effort cleanup must not mask the runtime shape error.
    void ignoredError;
  }
}

function openNativeVoiceWebSocket(url: string): VoiceWebSocketLike {
  const ctor: unknown = globalThis.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const socket: unknown = Reflect.construct(ctor, [url]);
  if (!isVoiceWebSocketLike(socket)) {
    closeInvalidNativeWebSocket(socket);
    throw new Error("WebSocket runtime does not expose the required voice API");
  }
  return socket;
}

export type VoiceWebSocketFactory = (url: string) => VoiceWebSocketLike;

/** A client playout trace mark, carrying the server-issued traceId. */
export interface VoiceTraceMark {
  name: string;
  traceId: string | null;
  atMs: number;
}

export interface VoiceSessionClientOptions {
  /** Read current renderer state, not the snapshot from session creation. */
  getUiContext?: () => VoiceUiContext;
  agentId: string;
  conversationId: string;
  /**
   * Obtain a one-use consent nonce from POST /api/v1/voice/session/consent
   * (SEC-21). Called immediately before EVERY mint, including reconnects, so a
   * consumed nonce is never replayed.
   */
  getConsentNonce: () => Promise<string | null>;

  /**
   * Injectable mint fetch. Defaults to the voice-session control-plane fetch,
   * lazily imported so this module's static graph stays lean. A caller in a
   * non-dashboard host (or a test) supplies its own.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Base path for the mint route. Default "/api/v1/voice/session". */
  mintPath?: string;
  /** Injectable WebSocket factory (tests / non-standard hosts). */
  webSocketFactory?: VoiceWebSocketFactory;
  /** Injectable getUserMedia (passed to mic capture). */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injectable mic AudioContext factory (tests). */
  createMicAudioContext?: () => MicAudioContextLike;
  /** Injectable playback AudioContext factory (tests). */
  createPlaybackAudioContext?: () => PlaybackAudioContextLike;

  /** Preferred uplink codec (default pcm16). */
  uplinkCodec?: VoiceSessionCodec;
  /** Preferred downlink codec (default pcm16). */
  downlinkCodec?: VoiceSessionCodec;

  /** Fired on every state change with the new machine state + unified status. */
  onState?: (
    state: VoiceSessionMachineState,
    status: VoiceContinuousStatus,
  ) => void;
  /** Fired for each raw server control event (after state fold). */
  onServerEvent?: (event: ServerControlFrame) => void;
  /** Fired for each client playout trace mark. */
  onTraceMark?: (mark: VoiceTraceMark) => void;
  /** Fired after each successful mint, including a reconnect re-mint. */
  onMinted?: (minted: VoiceSessionMintResponse) => void;
  /** Fired when browser autoplay requires (or no longer requires) a tap. */
  onPlaybackUnlockChange?: (needsUnlock: boolean) => void;
  /** Sanitized playout queue/timing counters; never audio or transcript data. */
  onPlaybackStats?: (event: VoiceSessionPlaybackStatsEvent) => void;
  /** Fired on a fatal client error (mic/permission/transport). */
  onError?: (error: Error) => void;
  /** Monotonic clock for trace marks (tests inject). */
  now?: () => number;

  /**
   * Max reconnect (re-mint) attempts per outage before giving up. Default 5.
   * A revoked/expired token cannot reconnect — reconnect ALWAYS re-mints a
   * fresh token, never reuses the old one. The budget refills after the
   * session has been continuously live for `reconnectBudgetResetMs`.
   */
  maxReconnects?: number;
  /**
   * Reconnect budget while the lifecycle has NEVER reached server `ready`.
   * Defaults to `maxReconnects`. A caller that owns a same-gesture fallback
   * (the hook hands a pre-live failure to the batch mic) sets 0 so a pre-live
   * transport fault surfaces immediately instead of retrying past the gesture.
   */
  preLiveMaxReconnects?: number;
  /**
   * Backoff base between reconnect attempts within one outage: attempt k
   * (k >= 2) waits base * 2^(k-2); the first attempt is immediate so a
   * server-side session rotation reconnects with no audible gap. Default 1000.
   */
  reconnectBackoffMs?: number;
  /**
   * A session continuously live (server `ready` observed) for at least this
   * long refills the reconnect budget on its next transport loss. Default
   * 30_000. A session that dies within seconds of connecting never refills,
   * so a persistent connect-die fault stays bounded.
   */
  reconnectBudgetResetMs?: number;
  /**
   * Lead time before the minted token's expiry at which an idle (`listening`)
   * session proactively rotates (clean bye + re-mint) instead of waiting for
   * the server's hard sever at exp. 0 disables proactive rotation. Default
   * 10_000.
   */
  rotationLeadMs?: number;
  /** Re-check cadence while a due rotation waits for an idle boundary. Default 1000. */
  rotationRecheckMs?: number;
  /**
   * Epoch clock used only for expiry math against the mint's `expiresAt`;
   * `now` remains the monotonic trace/health clock. Default Date.now.
   */
  epochNow?: () => number;
  /** Bounded attempts for transient failures before the first socket opens. */
  preLiveMaxAttempts?: number;
  /** Backoff base for pre-live retries. Attempt n waits base * n. */
  preLiveRetryDelayMs?: number;
}

type ConnectionPhase = "idle" | "connecting" | "open" | "closing" | "closed";

export interface VoiceSessionClient {
  /** Current machine state (immutable snapshot). */
  readonly state: VoiceSessionMachineState;
  /** Whether queued downlink audio is waiting for a user-gesture unlock. */
  readonly needsPlaybackUnlock: boolean;
  /** Mint + connect + start capture/playback. */
  start(): Promise<void>;
  /** Barge-in: flush local playback NOW + notify server. */
  bargeIn(): void;
  /** Whether uplink audio is currently replaced with silence. */
  readonly microphoneMuted: boolean;
  /** Mute/unmute uplink audio without tearing down the realtime session. */
  setMicrophoneMuted(muted: boolean): void;
  /** Unlock playback on a user gesture (iOS autoplay). */
  unlockPlayback(): Promise<void>;
  /** Send a clean `bye` and tear everything down. */
  stop(): Promise<void>;
}

function nowDefault(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Server error codes for which re-minting is pointless or would defeat the
 * server's intent: a fresh session would hit the same quota gate, and a
 * cross-device revoke means "stop", not "reconnect".
 */
const NON_RECOVERABLE_SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  "quota_exhausted",
  "revoked",
]);

/** Parse the mint `expiresAt` (epoch ms number, epoch seconds, or ISO string). */
function parseExpiresAtMs(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function createVoiceSessionClient(
  options: VoiceSessionClientOptions,
): VoiceSessionClient {
  const now = options.now ?? nowDefault;
  const mintPath = options.mintPath ?? "/api/v1/voice/session";
  const doFetch =
    options.fetch ??
    (async (url: string, init?: RequestInit) => {
      const { fetchVoiceSession } = await import("./voice-session-fetch");
      return fetchVoiceSession(url, init);
    });
  const wsFactory =
    options.webSocketFactory ??
    ((url: string) => openNativeVoiceWebSocket(url));
  const preferredUplink = options.uplinkCodec ?? DEFAULT_UPLINK_CODEC;
  const preferredDownlink = options.downlinkCodec ?? DEFAULT_DOWNLINK_CODEC;
  const maxReconnects = options.maxReconnects ?? 5;
  const preLiveMaxReconnects = options.preLiveMaxReconnects ?? maxReconnects;
  const reconnectBackoffMs = Math.max(0, options.reconnectBackoffMs ?? 1000);
  const reconnectBudgetResetMs = Math.max(
    0,
    options.reconnectBudgetResetMs ?? 30_000,
  );
  const rotationLeadMs = Math.max(0, options.rotationLeadMs ?? 10_000);
  const rotationRecheckMs = Math.max(1, options.rotationRecheckMs ?? 1000);
  const epochNow = options.epochNow ?? Date.now;
  const preLiveMaxAttempts = Math.max(1, options.preLiveMaxAttempts ?? 3);
  const preLiveRetryDelayMs = Math.max(0, options.preLiveRetryDelayMs ?? 500);

  let state: VoiceSessionMachineState = { ...INITIAL_VOICE_SESSION_STATE };
  let connPhase: ConnectionPhase = "idle";
  let ws: VoiceWebSocketLike | null = null;
  let uiContextSupported = false;
  let lastUiContext: string | undefined;
  let mic: VoiceMicCapture | null = null;
  let playback: VoiceSessionPlayback | null = null;
  let reconnectsUsed = 0;
  // Monotonic timestamp of the most recent server `ready`; null while not live
  // or once a loss has consumed it for the budget-refill decision.
  let lastLiveAtMs: number | null = null;
  // Whether THIS lifecycle (since start()) ever reached server `ready` —
  // selects the pre-live vs live reconnect budget.
  let everLiveThisLifecycle = false;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  // Epoch expiry of the CURRENT minted token; rotation never fires past it
  // (the server has already severed — the reactive recovery path owns it).
  let rotationDeadlineMs: number | null = null;
  let disposed = false;
  let lifecycleGeneration = 0;
  let lifecycleAbort: AbortController | null = null;
  let recoveryPromise: Promise<void> | null = null;
  let captureSocket: VoiceWebSocketLike | null = null;
  let captureAbort: AbortController | null = null;
  let microphoneMuted = false;
  let playbackEnd: Extract<ServerControlFrame, { t: "speaking_end" }> | null =
    null;
  // Whether the caller explicitly stopped us (clean bye) — suppresses reconnect.
  let intentionalClose = false;

  const setState = (next: VoiceSessionMachineState): void => {
    state = next;
    mic?.setMuted(microphoneMuted || state.phase === "speaking");
    options.onState?.(state, toContinuousStatus(state.phase));
  };

  const mark = (name: string, traceId: string | null): void => {
    try {
      options.onTraceMark?.({ name, traceId, atMs: now() });
    } catch (ignoredError) {
      // error-policy:J7 trace-mark listeners are diagnostics; a throwing listener must never break audio or transport.
      void ignoredError;
    }
  };

  const emitError = (error: Error): void => {
    options.onError?.(error);
  };

  const emitPlaybackUnlockState = (required: boolean): void => {
    try {
      options.onPlaybackUnlockChange?.(required);
    } catch (ignoredError) {
      // error-policy:J7 unlock-state notification is UI telemetry; playback continues independently of a throwing listener.
      void ignoredError;
    }
  };

  const notifyPlaybackUnlockState = (): void => {
    emitPlaybackUnlockState(playback?.needsUnlock ?? false);
  };

  const isLifecycleCurrent = (generation: number): boolean =>
    !disposed && lifecycleGeneration === generation;

  const assertLifecycleCurrent = (generation: number): void => {
    if (!isLifecycleCurrent(generation)) {
      throw new VoiceSessionLifecycleCancelledError();
    }
  };

  const waitForRetry = async (attempt: number, generation: number) => {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, preLiveRetryDelayMs * attempt),
    );
    assertLifecycleCurrent(generation);
  };

  const waitForReconnectBackoff = async (
    attempt: number,
    generation: number,
  ) => {
    const delayMs = reconnectBackoffMs * 2 ** (attempt - 2);
    if (delayMs <= 0) return;
    mark(`reconnect_backoff(${attempt})`, state.traceId);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    assertLifecycleCurrent(generation);
  };

  const clearRotationTimer = (): void => {
    if (rotationTimer !== null) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
  };

  async function mintOnce(
    generation: number,
  ): Promise<VoiceSessionMintResponse> {
    let consentNonce: string | null;
    try {
      consentNonce = await options.getConsentNonce();
    } catch (cause) {
      assertLifecycleCurrent(generation);
      throw new VoiceSessionConsentError(
        "could not obtain realtime voice consent",
        cause,
      );
    }
    assertLifecycleCurrent(generation);
    if (!consentNonce?.trim()) {
      throw new VoiceSessionConsentError(
        "could not obtain realtime voice consent",
      );
    }

    let res: Response;
    try {
      res = await doFetch(mintPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: lifecycleAbort?.signal,
        body: JSON.stringify({
          agentId: options.agentId,
          conversationId: options.conversationId,
          transport: "websocket",
          consentNonce,
        }),
      });
    } catch (cause) {
      assertLifecycleCurrent(generation);
      throw new VoiceSessionMintError(
        0,
        "voice session mint transport failed",
        undefined,
        cause,
      );
    }
    assertLifecycleCurrent(generation);
    if (!res.ok) {
      let code: string | undefined;
      try {
        const body = (await res.json()) as { code?: unknown };
        if (typeof body.code === "string") code = body.code;
      } catch {
        // The body is diagnostic only; status still drives fallback.
      }
      throw new VoiceSessionMintError(res.status, undefined, code);
    }
    const json = (await res.json()) as unknown;
    assertLifecycleCurrent(generation);
    if (!isUsableMintResponse(json)) {
      throw new VoiceSessionMintError(-1, "malformed mint response");
    }
    try {
      options.onMinted?.(json);
    } catch (ignoredError) {
      // error-policy:J7 onMinted is correlation telemetry; a throwing listener must never turn a valid mint into a failed start.
      void ignoredError;
    }
    return json;
  }

  async function mint(generation: number): Promise<VoiceSessionMintResponse> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= preLiveMaxAttempts; attempt += 1) {
      try {
        return await mintOnce(generation);
      } catch (error) {
        assertLifecycleCurrent(generation);
        const typed = error instanceof Error ? error : new Error(String(error));
        lastError = typed;
        const retryable =
          (typed instanceof VoiceSessionMintError && typed.isTransient) ||
          typed instanceof VoiceSessionConsentError;
        if (!retryable || attempt >= preLiveMaxAttempts) throw typed;
        mark(`prelive_retry(${attempt})`, state.traceId);
        await waitForRetry(attempt, generation);
      }
    }
    throw lastError ?? new Error("voice session mint failed");
  }

  function sendControl(frame: Parameters<typeof encodeClientControl>[0]): void {
    if (!ws || connPhase !== "open") return;
    try {
      ws.send(encodeClientControl(frame));
    } catch (ignoredError) {
      // error-policy:J5 a send race with a closing socket is observed by the close handler, which drives reconnect/teardown.
      void ignoredError;
    }
  }

  function sendUplinkAudio(bytes: Uint8Array): void {
    if (!ws || connPhase !== "open") return;
    try {
      if (uiContextSupported && options.getUiContext) {
        const context = parseVoiceUiContext(options.getUiContext());
        // Clear a stale view rather than dropping audio when a renderer sends
        // invalid context. Report once per change, not once per audio packet.
        const serialized = JSON.stringify(context ?? {});
        if (serialized !== lastUiContext) {
          ws.send(
            encodeClientControl({ t: "ui_context", context: context ?? {} }),
          );
          lastUiContext = serialized;
          if (!context)
            console.warn(
              "[voice] Invalid renderer view context; cleared stale context",
            );
        }
      }
      // Copy into a standalone ArrayBuffer so a shared/pooled backing store from
      // the capture path is never observed mutated after send. A muted session
      // keeps its normal packet cadence but substitutes PCM silence, allowing
      // server VAD to close a partial utterance without leaking microphone data.
      const uplink =
        microphoneMuted || state.phase === "speaking"
          ? new Uint8Array(bytes.byteLength)
          : bytes.slice();
      ws.send(uplink.buffer);
    } catch (ignoredError) {
      // error-policy:J5 a dropped uplink frame on a dying socket is observed by the close handler's reconnect path.
      void ignoredError;
    }
  }

  function handleServerFrame(
    data: unknown,
    generation: number,
    socket: VoiceWebSocketLike,
  ): void {
    if (!isLifecycleCurrent(generation) || ws !== socket) return;
    // Binary downlink audio → straight to the streaming playback sink.
    if (data instanceof ArrayBuffer) {
      playback?.enqueue(new Uint8Array(data));
      notifyPlaybackUnlockState();
      mark("downlink_audio", state.traceId);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      playback?.enqueue(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      );
      notifyPlaybackUnlockState();
      mark("downlink_audio", state.traceId);
      return;
    }

    // Text control frame.
    const raw = typeof data === "string" ? data : null;
    if (raw === null) {
      // Neither binary nor text — a malformed frame. Never fabricate an event;
      // record it as a not-reached trace and ignore.
      mark("not_reached(malformed_frame)", state.traceId);
      return;
    }
    const event = parseServerControl(raw);
    if (!event) {
      // Unknown/invalid control frame: a single bad frame must not kill the
      // session. Record + ignore.
      mark("not_reached(unparseable_control)", state.traceId);
      return;
    }

    // End-of-generation is not end-of-playback: keep the mic closed and the
    // speaking state visible until the device consumes the last audio frame.
    if (event.t !== "speaking_end") setState(applyServerEvent(state, event));
    if (!isLifecycleCurrent(generation) || ws !== socket) return;
    options.onServerEvent?.(event);
    if (!isLifecycleCurrent(generation) || ws !== socket) return;

    switch (event.t) {
      case "ready":
        uiContextSupported = event.uiContext === true;
        lastUiContext = undefined;
        mark("ready", event.traceId);
        // The server accepted the session: record the health timestamp the
        // budget-refill decision reads on the next transport loss.
        lastLiveAtMs = now();
        everLiveThisLifecycle = true;
        // Client-owned: begin capture, then listening.
        void startCapture(generation, socket);
        break;
      case "stt_final":
        mark("stt_final", event.traceId);
        // An empty final never dispatches the LLM leg server-side, so no
        // speaking_end will follow — the machine parked at 'complete' and the
        // loop must happen HERE or the turn never returns to listening
        // (#16662). Nothing was queued for playback, so there is no drain to
        // wait for. The reducer owns the emptiness predicate (trim-aligned
        // with the server's dispatch gate); this checks only its verdict.
        if (state.phase === "complete") setState(loopToListening(state));
        break;
      case "llm_first_text":
        mark("llm_first_text", event.traceId);
        break;
      case "speaking_start":
        playbackEnd = null;
        playback?.beginInput();
        mark("speaking_start", event.traceId);
        break;
      case "speaking_end":
        playbackEnd = event;
        playback?.finishInput();
        mark("speaking_end", event.traceId);
        break;
      case "handoff_requested":
        playback?.beginHandoff(event.crossfadeMs);
        mark("handoff_requested", event.toTraceId);
        break;
      case "handoff_completed":
        mark("handoff_completed", event.toTraceId);
        break;
      case "assistant_playing":
        mark(
          event.active ? "assistant_playing" : "assistant_playing_end",
          event.traceId,
        );
        break;
      case "human_double_talk":
      case "echo_rejected":
      case "user_eos":
      case "next_reply_ready":
        mark(event.t, event.traceId);
        break;
      case "interrupted":
        // Reconcile: the server confirms the interruption. Ensure local audio is
        // silenced (idempotent with an optimistic local flush) and loop to
        // listening.
        playbackEnd = null;
        playback?.flush();
        mark("interrupted", event.traceId);
        setState(loopToListening(state));
        break;
      case "error":
        if (!event.retryable) {
          if (NON_RECOVERABLE_SERVER_ERROR_CODES.has(event.code)) {
            // Re-minting cannot help (quota) or would defeat the server's
            // intent (revoke). Surface the terminal cause and stop cleanly.
            mark(`not_reached(server_terminal:${event.code})`, state.traceId);
            emitError(new Error(`voice session ended: ${event.code}`));
            void stop();
            break;
          }
          // Fatal server error: tear down and (unless intentional) re-mint.
          mark("not_reached(server_fatal_error)", state.traceId);
          requestRecovery("server_error", generation, socket);
        }
        break;
      case "usage":
        // A deliberate silent turn has no playback completion callback.
        if (state.phase === "complete") setState(loopToListening(state));
        break;
      case "navigate_view":
      case "stt_partial":
      case "stt_eager_eot":
        break;
    }
  }

  async function startCapture(
    generation: number,
    socket: VoiceWebSocketLike,
  ): Promise<void> {
    if (
      mic ||
      captureSocket === socket ||
      !isLifecycleCurrent(generation) ||
      ws !== socket
    ) {
      return;
    }
    captureSocket = socket;
    captureAbort?.abort();
    const captureController = new AbortController();
    captureAbort = captureController;
    try {
      const createdMic = await startVoiceMicCapture({
        onFrame: (bytes) => {
          if (isLifecycleCurrent(generation) && ws === socket) {
            sendUplinkAudio(bytes);
          }
        },
        onSuspend: () => {
          if (isLifecycleCurrent(generation) && ws === socket) {
            mark("mic_suspended", state.traceId);
          }
        },
        onResume: () => {
          if (isLifecycleCurrent(generation) && ws === socket) {
            mark("mic_resumed", state.traceId);
          }
        },
        onError: (err) => {
          if (isLifecycleCurrent(generation) && ws === socket) emitError(err);
        },
        getUserMedia: options.getUserMedia,
        createAudioContext: options.createMicAudioContext,
        signal: captureController.signal,
      });
      if (!isLifecycleCurrent(generation) || ws !== socket || mic) {
        // error-policy:J6 best-effort release of a mic whose session was superseded before it attached.
        await createdMic.stop().catch(() => {});
        return;
      }
      mic = createdMic;
      // Keep the server's default half-duplex policy. Advertising continuous
      // handoff would opt this client into acoustic interruption during speech.
      // Now genuinely listening.
      setState(beginListening(state));
    } catch (err) {
      if (!isLifecycleCurrent(generation) || ws !== socket) return;
      const error =
        err instanceof VoiceMicCaptureError
          ? err
          : new VoiceMicCaptureError("mic capture failed", "start_failed", err);
      emitError(error);
      // Without a mic there's no session; tear down cleanly.
      void stop();
    } finally {
      if (captureSocket === socket) captureSocket = null;
      if (captureAbort === captureController) captureAbort = null;
    }
  }

  async function openConnection(
    minted: VoiceSessionMintResponse,
    generation: number,
  ): Promise<void> {
    assertLifecycleCurrent(generation);
    const uplink = negotiateCodec(preferredUplink, minted.uplink?.codecs);
    const downlink = negotiateCodec(preferredDownlink, minted.downlink?.codecs);
    if (!uplink || !downlink) {
      throw new VoiceSessionMintError(-1, "no compatible codec offered");
    }

    connPhase = "connecting";
    uiContextSupported = false;
    lastUiContext = undefined;
    const socket = wsFactory(minted.wsUrl);
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.addEventListener("open", () => {
      if (!isLifecycleCurrent(generation) || ws !== socket) {
        try {
          socket.close(1000, "superseded");
        } catch (ignoredError) {
          // error-policy:J6 best-effort close of a superseded socket during teardown.
          void ignoredError;
        }
        return;
      }
      connPhase = "open";
      // FIRST frame MUST be the hello with the token — never a header.
      try {
        socket.send(
          encodeClientControl({
            t: "hello",
            token: minted.token,
            protocol: VOICE_SESSION_PROTOCOL_VERSION,
            uplinkCodec: uplink,
            downlinkCodec: downlink,
            sampleRate: VOICE_SESSION_SAMPLE_RATE,
          }),
        );
      } catch (ignoredError) {
        // error-policy:J1 a failed hello send is translated into the structured transport-recovery path, not rethrown.
        void ignoredError;
        requestRecovery("hello_send", generation, socket);
        return;
      }
      mark("hello_sent", null);
    });

    socket.addEventListener("message", (event) => {
      handleServerFrame(event.data, generation, socket);
    });

    socket.addEventListener("close", () => {
      if (!isLifecycleCurrent(generation) || ws !== socket) return;
      if (connPhase === "closing" || intentionalClose) {
        ws = null;
        connPhase = "closed";
        return;
      }
      // Any peer-initiated close is transport loss. Code 1000 only describes
      // the frame as clean; it does not make an unexpected close intentional,
      // and the live microphone must never remain attached to a dead socket.
      requestRecovery("ws_close", generation, socket);
    });

    socket.addEventListener("error", () => {
      if (!isLifecycleCurrent(generation) || ws !== socket) return;
      // The close handler follows an error and drives reconnect; nothing to do
      // here beyond a trace mark.
      mark("ws_error", state.traceId);
    });

    scheduleRotation(minted, generation);
  }

  /**
   * Arm the proactive pre-expiry rotation for the freshly-opened connection.
   * The server hard-severs at the bootstrap token's exp; rotating first — at an
   * idle boundary — keeps that sever from ever cutting audible speech.
   */
  function scheduleRotation(
    minted: VoiceSessionMintResponse,
    generation: number,
  ): void {
    clearRotationTimer();
    rotationDeadlineMs = null;
    if (rotationLeadMs <= 0) return;
    const expiresAtMs = parseExpiresAtMs(minted.expiresAt);
    if (expiresAtMs === null) return;
    rotationDeadlineMs = expiresAtMs;
    const delayMs = Math.max(0, expiresAtMs - epochNow() - rotationLeadMs);
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      attemptRotation(generation);
    }, delayMs);
  }

  function attemptRotation(generation: number): void {
    if (!isLifecycleCurrent(generation) || intentionalClose) return;
    // A reactive recovery already owns the transport; it re-mints anyway.
    if (recoveryPromise) return;
    if (rotationDeadlineMs !== null && epochNow() >= rotationDeadlineMs) {
      // Token already expired — the server sever + reactive path own recovery.
      return;
    }
    const socket = ws;
    if (!socket || connPhase !== "open") return;
    if (state.phase !== "listening") {
      // Mid-turn: never cut audible speech or an in-flight transcription.
      // Re-check until the turn completes or the deadline passes.
      mark("token_rotation_deferred", state.traceId);
      rotationTimer = setTimeout(() => {
        rotationTimer = null;
        attemptRotation(generation);
      }, rotationRecheckMs);
      return;
    }
    mark("token_rotation", state.traceId);
    requestRecovery("token_rotation", generation, socket, {
      budgeted: false,
      cleanBye: true,
    });
  }

  function requestRecovery(
    reason: string,
    generation: number,
    socket: VoiceWebSocketLike,
    recoveryOptions?: { budgeted?: boolean; cleanBye?: boolean },
  ): void {
    if (!isLifecycleCurrent(generation) || intentionalClose || ws !== socket) {
      return;
    }

    // Detach first. A fatal server frame commonly causes the same socket to
    // emit `close`; its later callback then fails the identity check and cannot
    // consume a second reconnect attempt.
    ws = null;
    connPhase = "closed";
    clearRotationTimer();
    if (recoveryOptions?.cleanBye) {
      try {
        socket.send(encodeClientControl({ t: "bye" }));
      } catch (ignoredError) {
        // error-policy:J6 the bye frame is a courtesy on a socket being rotated away.
        void ignoredError;
      }
    }
    try {
      socket.close(
        recoveryOptions?.cleanBye ? 1000 : 1012,
        recoveryOptions?.cleanBye ? "token rotation" : "re-mint",
      );
    } catch (ignoredError) {
      // error-policy:J6 best-effort close of the dead socket; recovery proceeds regardless.
      void ignoredError;
    }
    if (recoveryPromise) return;
    const pending = handleTransportLoss(
      reason,
      generation,
      recoveryOptions?.budgeted ?? true,
    );
    recoveryPromise = pending;
    void pending.finally(() => {
      if (recoveryPromise === pending) recoveryPromise = null;
    });
  }

  async function handleTransportLoss(
    reason: string,
    generation: number,
    budgetedInitial: boolean,
  ): Promise<void> {
    if (!isLifecycleCurrent(generation) || intentionalClose) return;
    clearRotationTimer();
    // The transport is already gone, so publish that fact before a browser
    // driver is allowed to delay microphone teardown. Later retry attempts
    // re-arm the caller's connect watchdog from inside the loop.
    setState({ ...state, phase: "connecting", lastError: null });
    // Stop capture (a dead socket must not keep the mic hot) but KEEP playback
    // context so an autoplay unlock survives the reconnect.
    playbackEnd = null;
    playback?.flush();
    await teardownMic();
    if (!isLifecycleCurrent(generation) || intentionalClose) return;

    // Budget refill: a session that stayed healthy long enough since its last
    // recovery earns a fresh budget, so a long conversation tolerates
    // well-separated drops (and 120s server rotations) indefinitely, while a
    // session that dies within seconds of `ready` still exhausts and surfaces.
    if (
      budgetedInitial &&
      lastLiveAtMs !== null &&
      now() - lastLiveAtMs >= reconnectBudgetResetMs
    ) {
      reconnectsUsed = 0;
    }
    lastLiveAtMs = null;

    const reconnectCap = everLiveThisLifecycle
      ? maxReconnects
      : preLiveMaxReconnects;
    let budgeted = budgetedInitial;
    let currentReason = reason;
    let attempt = 0;
    while (true) {
      if (budgeted && reconnectsUsed >= reconnectCap) {
        mark(
          `not_reached(reconnect_exhausted:${currentReason})`,
          state.traceId,
        );
        emitError(new Error(`voice session lost: ${currentReason}`));
        await stop();
        return;
      }
      if (budgeted) reconnectsUsed += 1;
      attempt += 1;
      mark(`reconnect_remint(${currentReason})`, state.traceId);
      try {
        // Each retry after the immediate attempt gives the caller's connect
        // watchdog a fresh arm before its backoff begins.
        if (attempt > 1) {
          setState({ ...state, phase: "connecting", lastError: null });
        }
        if (attempt > 1) await waitForReconnectBackoff(attempt, generation);
        // Reconnect ALWAYS re-mints; the old token is revoked/expired and
        // cannot reconnect (contract §7.1).
        const minted = await mint(generation);
        assertLifecycleCurrent(generation);
        await openConnection(minted, generation);
        return;
      } catch (err) {
        if (!isLifecycleCurrent(generation)) return;
        if (err instanceof VoiceSessionLifecycleCancelledError) return;
        const transient =
          (err instanceof VoiceSessionMintError && err.isTransient) ||
          err instanceof VoiceSessionConsentError;
        if (transient) {
          // A re-mint that failed on a transient fault consumes the NEXT
          // budgeted attempt (with backoff) instead of killing a recoverable
          // session — a network switch outlives a single mint by seconds.
          budgeted = true;
          currentReason = "remint_failed";
          if (reconnectsUsed < reconnectCap) continue;
          mark(
            `not_reached(reconnect_exhausted:${currentReason})`,
            state.traceId,
          );
        }
        // Give-up on the recovery path is always transport-shaped: the session
        // was live, so the caller's mic control must stay armed for retry
        // rather than latching realtime off on a mint/consent error subtype.
        emitError(
          new Error(`voice session lost: ${currentReason}`, { cause: err }),
        );
        await stop();
        return;
      }
    }
  }

  async function teardownMic(): Promise<void> {
    const pendingCapture = captureAbort;
    captureAbort = null;
    captureSocket = null;
    pendingCapture?.abort();
    const currentMic = mic;
    mic = null;
    // error-policy:J6 best-effort mic release after ownership is detached.
    await currentMic?.stop().catch(() => {});
  }

  async function stop(): Promise<void> {
    disposed = true;
    intentionalClose = true;
    microphoneMuted = false;
    playbackEnd = null;
    const stoppedGeneration = ++lifecycleGeneration;
    lifecycleAbort?.abort();
    lifecycleAbort = null;
    clearRotationTimer();
    rotationDeadlineMs = null;
    lastLiveAtMs = null;
    // Detach playback before the first await. If a caller reuses this client
    // after the transport reaches `closed`, this stop owns only the old sink
    // and cannot close/null a replacement created by the new lifecycle.
    const stoppedPlayback = playback;
    playback = null;
    emitPlaybackUnlockState(false);
    // Clean bye if the socket is open.
    const socket = ws;
    ws = null;
    if (socket && connPhase === "open") {
      // Send directly after detaching the socket from asynchronous callbacks.
      try {
        socket.send(encodeClientControl({ t: "bye" }));
      } catch (ignoredError) {
        // error-policy:J6 the bye frame is a courtesy on a socket being torn down.
        void ignoredError;
      }
      connPhase = "closing";
      try {
        socket.close(1000, "client bye");
      } catch (ignoredError) {
        // error-policy:J6 best-effort close of an already-closing socket during teardown.
        void ignoredError;
      }
    } else if (socket) {
      try {
        socket.close(1000, "client bye");
      } catch (ignoredError) {
        // error-policy:J6 best-effort close of a never-opened socket during teardown.
        void ignoredError;
      }
    }
    const micTeardown = teardownMic();
    // error-policy:J6 playback sink release is best effort once detached; stop() must always complete.
    await Promise.all([micTeardown, stoppedPlayback?.stop().catch(() => {})]);
    if (lifecycleGeneration === stoppedGeneration) {
      connPhase = "closed";
      setState({ ...INITIAL_VOICE_SESSION_STATE });
    }
  }

  return {
    get state() {
      return state;
    },

    get needsPlaybackUnlock() {
      return playback?.needsUnlock ?? false;
    },

    async start() {
      if (connPhase !== "idle" && connPhase !== "closed") return;
      const generation = ++lifecycleGeneration;
      lifecycleAbort?.abort();
      const lifecycleController = new AbortController();
      lifecycleAbort = lifecycleController;
      recoveryPromise = null;
      disposed = false;
      intentionalClose = false;
      reconnectsUsed = 0;
      lastLiveAtMs = null;
      everLiveThisLifecycle = false;
      microphoneMuted = false;
      setState({ ...INITIAL_VOICE_SESSION_STATE, phase: "connecting" });
      // Create playback up front so an early user-gesture unlock is possible and
      // downlink frames after `ready` have a sink.
      try {
        const createdPlayback = await createVoiceSessionPlayback({
          createAudioContext: options.createPlaybackAudioContext,
          signal: lifecycleController.signal,
          // createVoiceSessionPlayback invokes resume synchronously before its
          // first await, while this `start()` call still owns user activation.
          unlockOnCreate: true,
          onUnlockChange: (required) => {
            if (isLifecycleCurrent(generation)) {
              emitPlaybackUnlockState(required);
            }
          },
          onDrained: () => {
            if (isLifecycleCurrent(generation)) {
              mark("playback_drained", state.traceId);
              const ended = playbackEnd;
              playbackEnd = null;
              if (
                ended &&
                state.phase === "speaking" &&
                state.traceId === ended.traceId
              ) {
                setState(loopToListening(applyServerEvent(state, ended)));
              }
            }
          },
          onHandoffComplete: () => {
            if (isLifecycleCurrent(generation)) {
              mark("handoff_crossfade_complete", state.traceId);
            }
          },
          now,
          onStats: options.onPlaybackStats,
        });
        if (!isLifecycleCurrent(generation)) {
          // error-policy:J6 best-effort release of a playback sink whose lifecycle was superseded mid-create.
          await createdPlayback.stop().catch(() => {});
          return;
        }
        playback = createdPlayback;
        notifyPlaybackUnlockState();
      } catch (err) {
        if (!isLifecycleCurrent(generation)) return;
        emitError(err instanceof Error ? err : new Error(String(err)));
        setState({ ...INITIAL_VOICE_SESSION_STATE });
        return;
      }
      try {
        const minted = await mint(generation);
        assertLifecycleCurrent(generation);
        // `onMinted` runs inside mint(), so this mark is correlated with the
        // server session id in the app telemetry sink even though no turn
        // traceId exists yet.
        mark(
          playback.unlocked
            ? "playback_unlocked"
            : "not_reached(playback_unlock_required)",
          state.traceId,
        );
        await openConnection(minted, generation);
      } catch (err) {
        if (!isLifecycleCurrent(generation)) return;
        emitError(err instanceof Error ? err : new Error(String(err)));
        await stop();
      }
    },

    bargeIn() {
      if (disposed) return;
      // Flush local audible output IMMEDIATELY — do NOT wait for the server
      // `interrupted` event. Then optimistically fold state and notify server.
      playbackEnd = null;
      playback?.flush();
      setState(applyClientAction(state, { type: "client/local_barge_in" }));
      sendControl({ t: "barge_in" });
      mark("barge_in_sent", state.traceId);
    },

    get microphoneMuted() {
      return microphoneMuted;
    },

    setMicrophoneMuted(muted) {
      if (disposed || microphoneMuted === muted) return;
      microphoneMuted = muted;
      mic?.setMuted(muted || state.phase === "speaking");
      mark(muted ? "mic_muted" : "mic_unmuted", state.traceId);
    },

    async unlockPlayback() {
      const generation = lifecycleGeneration;
      const currentPlayback = playback;
      await currentPlayback?.unlock();
      if (!isLifecycleCurrent(generation) || playback !== currentPlayback) {
        return;
      }
      notifyPlaybackUnlockState();
      mark(
        playback?.unlocked
          ? "playback_unlocked"
          : "not_reached(playback_unlock_required)",
        state.traceId,
      );
    },

    stop,
  };
}

class VoiceSessionLifecycleCancelledError extends Error {
  constructor() {
    super("voice session lifecycle superseded");
    this.name = "VoiceSessionLifecycleCancelledError";
  }
}

/** Consent acquisition failed; the caller should fall back to batch voice. */
export class VoiceSessionConsentError extends Error {
  constructor(message: string, options?: unknown) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = "VoiceSessionConsentError";
  }
}

/** A mint failure the caller can branch on (404 = flag off → batch fallback). */
export class VoiceSessionMintError extends Error {
  constructor(
    readonly status: number,
    message?: string,
    readonly code?: string,
    options?: unknown,
  ) {
    super(
      message ?? `voice session mint failed (${status})`,
      options === undefined ? undefined : { cause: options },
    );
    this.name = "VoiceSessionMintError";
  }

  /** True for an actual feature-off 404, not the post-create visibility race. */
  get isFeatureDisabled(): boolean {
    return this.status === 404 && this.code !== "agent_not_found";
  }

  /** Safe bounded retries before the realtime transport owns the mic. */
  get isTransient(): boolean {
    return (
      this.status === 0 || this.status >= 500 || this.code === "agent_not_found"
    );
  }
}
