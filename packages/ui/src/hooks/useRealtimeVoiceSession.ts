/**
 * React lifecycle binding for the realtime voice-session client: it arms the
 * WebSocket voice path as an ADDITIVE enhancement of the existing batch mic —
 * same button, same `VoiceContinuousStatus` vocabulary, no second mic.
 *
 * Eligibility requires the VITE realtime flag and stable chat ids. Startup
 * failures before the realtime mic becomes live return a typed outcome so the
 * caller can hand the same mic gesture to the unchanged batch flow.
 * `active` is truthful: it turns on only when the client reports a live phase
 * (socket open, server `ready`, mic capturing) — never merely because
 * `start()` resolved — and a bounded connect/ready timer fails a stalled
 * session into a retryable `transport` error instead of hanging in `connecting`.
 *
 * Errors are typed (`RealtimeVoiceError`) and every one is rendered by the
 * status bar: actionable kinds (permission, no-device, transport) keep
 * `available` true so the same mic control retries realtime, while
 * consent/mint failures disarm realtime so future taps truthfully use the
 * batch path — the surfaced copy matches that behavior.
 *
 * iOS/WebView: the client constructs + resumes playback synchronously at the
 * start of the user gesture, before consent/mint awaits can consume transient
 * activation; `needsUnlock` drives the existing status-bar CTA when the
 * browser still blocks it. Everything third-party is injectable so tests
 * drive the REAL client over fake transports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client as apiClient } from "../api/client";
import { getWindowNavigationPath } from "../navigation";
import { getClientBrowserSurface } from "../platform/browser-surface";
import type {
  VoiceContinuousStatus,
  VoiceSpeakerMetadata,
} from "../voice/voice-chat-types";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  type VoiceSessionClientOptions,
  VoiceSessionConsentError,
  VoiceSessionMintError,
} from "../voice/voice-session-client";
import { VoiceMicCaptureError } from "../voice/voice-session-mic-capture";
import type {
  ServerControlFrame,
  VoiceSessionMintResponse,
} from "../voice/voice-session-protocol";

/** A realtime-voice error the UI can branch on for an actionable message. */
export type RealtimeVoiceErrorKind =
  | "permission" // mic permission denied — surface a re-enable CTA.
  | "no-device" // no input device — surface an actionable notice.
  | "mint" // mint failed (not a 404; a real failure — 503/500/malformed).
  | "consent" // consent nonce could not be obtained (503 / store off).
  | "transport" // WS transport lost past the reconnect budget.
  | "unknown";

export interface RealtimeVoiceError {
  kind: RealtimeVoiceErrorKind;
  message: string;
  /** True when the user can recover by an action (grant mic, retry). */
  actionable: boolean;
}

export type RealtimeVoiceStartOutcome =
  | { kind: "live" }
  | {
      kind: "fallback-to-batch";
      reason: "consent" | "mint" | "transport" | "unknown";
      /** Optional actionable detail for a more precise pre-live failure. */
      message?: string;
    }
  | { kind: "error"; error: RealtimeVoiceError }
  | { kind: "unavailable" };

export type RealtimeVoiceFallbackReason =
  | "consent"
  | "mint"
  | "transport"
  | "unknown"
  | "missing-identity";

/** Consent-nonce source. Returns null when consent could not be issued. */
export type MintConsentNonce = () => Promise<string | null>;

export interface UseRealtimeVoiceSessionOptions {
  /** Owner agent id (UUID) for the mint request. */
  agentId: string | null | undefined;
  /** Conversation id (UUID) for the mint request. */
  conversationId: string | null | undefined;
  /**
   * Whether the VITE-side realtime flag is on. When false the hook is inert
   * (never arms, never mints) and `available` stays false so the caller uses
   * the batch path. Injected (not read here) so the caller owns the flag source
   * and tests drive both branches.
   */
  flagEnabled: boolean;
  /**
   * Obtain a one-time consent nonce (POST /api/v1/voice/session/consent) in
   * response to the visible consent gesture that starts the session. Called
   * by the client immediately before every mint/re-mint so one-use nonces are
   * never replayed. Returning null (503 / store not configured) surfaces a
   * `consent` error and leaves the batch path as the fallback.
   */
  getConsentNonce: MintConsentNonce;
  /**
   * Injectable client factory (defaults to `createVoiceSessionClient`). Tests
   * pass a factory that wires the fake transports.
   */
  createClient?: (options: VoiceSessionClientOptions) => VoiceSessionClient;
  /**
   * Extra client options merged into the created client (mint `fetch`, mint
   * `mintPath`, injected AudioContext/WebSocket factories for tests). NEVER
   * overrides agentId/conversationId/getConsentNonce (those come from this
   * hook).
   */
  clientOptions?: Omit<
    VoiceSessionClientOptions,
    "agentId" | "conversationId" | "getConsentNonce"
  >;
  /**
   * Fired once per session with the mint response — lets the caller record the
   * sessionId for its own telemetry. Optional.
   */
  onMinted?: (minted: VoiceSessionMintResponse) => void;
  /**
   * How long a session may sit in connecting/ready (per stage: socket connect,
   * then server-ready → mic capture) before it is failed into a retryable
   * `transport` error instead of hanging. Default 15s.
   */
  readyTimeoutMs?: number;
  /** Live speaker attribution passthrough for the status bar. Optional. */
  speaker?: VoiceSpeakerMetadata | null;
}

export interface UseRealtimeVoiceSessionState {
  /**
   * True when the realtime path is eligible to try RIGHT NOW: the flag is on,
   * agent+conversation ids exist, and the server has not reported feature-off.
   * This is not proof that a mint has succeeded.
   */
  available: boolean;
  /**
   * True only while the session is genuinely live: socket open, server `ready`
   * received, and the mic actually capturing. Never true merely because
   * `start()` resolved.
   */
  active: boolean;
  /**
   * True while a started session is still working toward live (consent, mint,
   * socket connect, server ready, mic bring-up). Bounded by the ready timer.
   */
  connecting: boolean;
  /** Unified status for the mounted composer or an embedded status bar. */
  status: VoiceContinuousStatus;
  /** Live partial transcript (server `stt_partial`). "" when none. */
  transcriptPartial: string;
  /** Committed final transcript for the current turn (server `stt_final`). */
  transcriptFinal: string;
  /** True while the agent is audibly speaking (phase `speaking`). */
  agentSpeaking: boolean;
  /** True when queued realtime audio is waiting for a browser autoplay tap. */
  needsUnlock: boolean;
  /**
   * True when the session is alive but the mic was suspended by a
   * visibility-hide — a PAUSED state, not a broken one. Clears on resume.
   */
  paused: boolean;
  /** True when the live microphone uplink is intentionally sending silence. */
  microphoneMuted: boolean;
  /** Actionable/typed error, or null. */
  error: RealtimeVoiceError | null;
  /** Last reason realtime handed this interaction to batch. */
  fallbackReason: RealtimeVoiceFallbackReason | null;
  /** Record a pre-start eligibility fallback such as missing identity. */
  reportFallback: (reason: RealtimeVoiceFallbackReason) => void;
  /** Speaker attribution passthrough. */
  speaker: VoiceSpeakerMetadata | null;
  /**
   * Begin a realtime session: unlock playback on THIS gesture, obtain consent,
   * mint, connect, and start capture. Resolves only when realtime is live or a
   * typed pre-live failure proves whether the same gesture should use batch.
   */
  start: () => Promise<RealtimeVoiceStartOutcome>;
  /** Clean `bye` + full teardown. Idempotent. */
  stop: () => Promise<void>;
  /** Barge-in: flush local playback + notify server. No-op when not speaking. */
  bargeIn: () => void;
  /** Toggle microphone uplink mute without ending or re-minting the session. */
  toggleMicrophoneMute: () => void;
  /** Resume the AudioContext on a user gesture (iOS autoplay). */
  unlock: () => Promise<void>;
}

function classifyError(error: Error): RealtimeVoiceError {
  if (error instanceof VoiceMicCaptureError) {
    if (error.code === "permission_denied") {
      return {
        kind: "permission",
        message: "Microphone access was blocked. Enable it to talk with voice.",
        actionable: true,
      };
    }
    if (error.code === "no_device") {
      return {
        kind: "no-device",
        message: "No microphone was found. Connect one to talk with voice.",
        actionable: true,
      };
    }
    return {
      kind: "unknown",
      message: error.message || "Voice capture failed.",
      actionable: false,
    };
  }
  if (error instanceof VoiceSessionMintError) {
    // The caller owns any alternate capture policy. Realtime remains
    // retryable, so do not promise a provider switch from this shared hook.
    return {
      kind: "mint",
      message: "Couldn't start realtime voice. Tap the mic to try again.",
      actionable: true,
    };
  }
  if (error instanceof VoiceSessionConsentError) {
    return {
      kind: "consent",
      // This is the server nonce step, not getUserMedia permission. A null
      // nonce can also mean an unavailable gateway or a malformed response.
      message: "Voice setup couldn't complete. Tap the mic to try again.",
      actionable: true,
    };
  }
  // Transport loss past the reconnect budget surfaces as a generic Error from
  // the client (`voice session lost: ...`). It does NOT latch realtime off —
  // the same mic control retries, so the CTA is honest.
  if (/voice session lost/i.test(error.message)) {
    return {
      kind: "transport",
      message: "Voice connection dropped. Tap the mic to try again.",
      actionable: true,
    };
  }
  return {
    kind: "unknown",
    message: error.message || "Voice session error.",
    actionable: false,
  };
}

/**
 * Client phases in which the session is genuinely live: the socket is open,
 * the server sent `ready`, and the mic is capturing (`beginListening` runs
 * only after the capture pipeline is attached). `connecting`/`ready` are NOT
 * live — the mic may still be pending — and `idle` is torn down.
 */
const LIVE_SESSION_PHASES: ReadonlySet<string> = new Set([
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "complete",
  "interrupted",
]);

const DEFAULT_READY_TIMEOUT_MS = 15_000;

function normalizeVoiceIdentityId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackReasonForError(
  error: RealtimeVoiceError,
): "consent" | "mint" | "transport" | "unknown" | null {
  if (error.kind === "consent") return "consent";
  if (error.kind === "mint") return "mint";
  if (error.kind === "transport") return "transport";
  if (error.kind === "unknown") return "unknown";
  return null;
}

export function useRealtimeVoiceSession(
  options: UseRealtimeVoiceSessionOptions,
): UseRealtimeVoiceSessionState {
  const {
    agentId,
    conversationId,
    flagEnabled,
    getConsentNonce,
    createClient = createVoiceSessionClient,
    clientOptions,
    onMinted,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    speaker,
  } = options;

  const [status, setStatus] = useState<VoiceContinuousStatus>("idle");
  const [transcriptPartial, setTranscriptPartial] = useState("");
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [paused, setPaused] = useState(false);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<RealtimeVoiceError | null>(null);
  const [fallbackReason, setFallbackReason] =
    useState<RealtimeVoiceFallbackReason | null>(null);

  const clientRef = useRef<VoiceSessionClient | null>(null);
  // A generation counter so a stale client's async callbacks (a teardown that
  // races a new start) cannot write state for a session the component moved on
  // from.
  const sessionGenRef = useRef(0);
  const identityChangeGenRef = useRef(0);
  // Carries automatic restart ownership across rapid A→B→C identity changes.
  // The first teardown clears clientRef synchronously, so the next effect must
  // not mistake that in-flight handoff for an intentionally idle session.
  const identityRestartPendingRef = useRef(false);
  const startingRef = useRef(false);
  // The connect/ready watchdog. Armed while the CURRENT session sits in a
  // pre-live phase; a live phase (or any teardown/error) clears it. There is at
  // most one session, so one shared handle is enough — a newer start's arm
  // clears a stale timer before scheduling its own.
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micOwnedRef = useRef(false);
  const startOutcomeRef = useRef<{
    generation: number;
    settled: boolean;
    resolve: (outcome: RealtimeVoiceStartOutcome) => void;
  } | null>(null);

  const normalizedAgentId = normalizeVoiceIdentityId(agentId);
  const normalizedConversationId = normalizeVoiceIdentityId(conversationId);

  // Keep the latest callbacks/config in refs so the stable `start`/`stop`
  // identities don't churn the mic button bindings each render.
  const getConsentNonceRef = useRef(getConsentNonce);
  const createClientRef = useRef(createClient);
  const clientOptionsRef = useRef(clientOptions);
  const onMintedRef = useRef(onMinted);
  const idsRef = useRef({
    agentId: normalizedAgentId,
    conversationId: normalizedConversationId,
  });
  const readyTimeoutMsRef = useRef(readyTimeoutMs);
  getConsentNonceRef.current = getConsentNonce;
  createClientRef.current = createClient;
  clientOptionsRef.current = clientOptions;
  onMintedRef.current = onMinted;
  idsRef.current = {
    agentId: normalizedAgentId,
    conversationId: normalizedConversationId,
  };
  readyTimeoutMsRef.current = readyTimeoutMs;

  const clearReadyTimer = useCallback(() => {
    if (readyTimerRef.current !== null) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, []);

  const resolveStartOutcome = useCallback(
    (generation: number, outcome: RealtimeVoiceStartOutcome) => {
      const pending = startOutcomeRef.current;
      if (!pending || pending.generation !== generation || pending.settled) {
        return;
      }
      pending.settled = true;
      if (outcome.kind === "fallback-to-batch") {
        setFallbackReason(outcome.reason);
      }
      pending.resolve(outcome);
      startOutcomeRef.current = null;
    },
    [],
  );

  const hasIds =
    Boolean(normalizedAgentId) && Boolean(normalizedConversationId);
  const available = flagEnabled && hasIds;

  const applyServerEventToTranscript = useCallback(
    (event: ServerControlFrame) => {
      switch (event.t) {
        case "stt_partial":
          setTranscriptPartial(event.text);
          break;
        case "stt_final":
          setTranscriptFinal(event.text);
          setTranscriptPartial("");
          break;
        case "ready":
          // A fresh session: clear the previous turn's transcript.
          setTranscriptPartial("");
          setTranscriptFinal("");
          break;
        default:
          break;
      }
    },
    [],
  );

  const teardownClient = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      // error-policy:J6 Socket/microphone teardown is best effort after ownership is cleared.
      await client.stop().catch(() => {});
    }
  }, []);

  const stopCurrentSession = useCallback(async (): Promise<number> => {
    const stoppedGeneration = ++sessionGenRef.current;
    startingRef.current = false;
    micOwnedRef.current = false;
    resolveStartOutcome(stoppedGeneration - 1, { kind: "unavailable" });
    clearReadyTimer();
    await teardownClient();
    // A newer lifecycle may start while an old AudioContext close is pending.
    // Only the generation that initiated this teardown may clear UI state.
    if (sessionGenRef.current === stoppedGeneration) {
      setActive(false);
      setConnecting(false);
      setAgentSpeaking(false);
      setNeedsUnlock(false);
      setPaused(false);
      setMicrophoneMuted(false);
      setStatus("idle");
      setTranscriptPartial("");
    }
    return stoppedGeneration;
  }, [clearReadyTimer, resolveStartOutcome, teardownClient]);

  const stop = useCallback(async () => {
    // Explicit user/flag-driven stop also revokes any identity-change task that
    // may currently be awaiting teardown before an automatic re-mint.
    identityRestartPendingRef.current = false;
    identityChangeGenRef.current += 1;
    await stopCurrentSession();
  }, [stopCurrentSession]);

  const start = useCallback(async (): Promise<RealtimeVoiceStartOutcome> => {
    if (startingRef.current || clientRef.current) {
      return { kind: "unavailable" };
    }
    if (!flagEnabled) return { kind: "unavailable" };
    const { agentId: aId, conversationId: cId } = idsRef.current;
    if (!aId || !cId) return { kind: "unavailable" };

    startingRef.current = true;
    micOwnedRef.current = false;
    setMicrophoneMuted(false);
    setError(null);
    setFallbackReason(null);
    setNeedsUnlock(false);
    const gen = ++sessionGenRef.current;
    const isCurrent = () => sessionGenRef.current === gen;
    const outcomePromise = new Promise<RealtimeVoiceStartOutcome>((resolve) => {
      startOutcomeRef.current = { generation: gen, settled: false, resolve };
    });
    // Local latch so the synchronous start() flow can see a feature-disabled
    // 404 the moment onError fires (state updates are async and can't be read
    // back mid-function).
    let failedThisSession = false;
    // Distinguish a transport that never became ready from a browser mic setup
    // that stalled after the server explicitly accepted the session. Both use
    // the same retry semantics, but blaming the network for the latter sends
    // the user to the wrong control while a permission prompt is waiting.
    let serverReadyForMic = false;

    // Connect/ready watchdog: a session that stalls in connecting/ready (a
    // black-holed socket, a never-arriving `ready`, a hung mic bring-up) must
    // fail into a retryable transport error instead of showing "connecting"
    // forever with the batch mic disabled. Re-armed per pre-live stage so a
    // slow-but-progressing bring-up (e.g. a permission prompt after `ready`)
    // gets a fresh budget at each transition.
    const failOnReadyTimeout = () => {
      readyTimerRef.current = null;
      if (!isCurrent()) return;
      // Invalidate the stalled client's callbacks before tearing it down so a
      // late open/ready cannot resurrect state for a session we just failed.
      sessionGenRef.current += 1;
      startingRef.current = false;
      failedThisSession = true;
      const timeoutMessage = serverReadyForMic
        ? "Microphone setup timed out. Check browser microphone permission, then tap Talk to retry."
        : "Voice connection timed out. Tap the mic to try again.";
      resolveStartOutcome(gen, {
        kind: "fallback-to-batch",
        reason: "transport",
        ...(serverReadyForMic ? { message: timeoutMessage } : {}),
      });
      if (clientRef.current === client) clientRef.current = null;
      // error-policy:J6 timed-out session teardown is best effort; the timeout error below is the surfaced failure.
      void client.stop().catch(() => {});
      setError({
        kind: "transport",
        message: timeoutMessage,
        actionable: true,
      });
      setActive(false);
      setConnecting(false);
      setAgentSpeaking(false);
      setNeedsUnlock(false);
      setPaused(false);
      setStatus("idle");
      setTranscriptPartial("");
    };
    const armReadyTimer = () => {
      clearReadyTimer();
      readyTimerRef.current = setTimeout(
        failOnReadyTimeout,
        readyTimeoutMsRef.current,
      );
    };

    const uiTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const client = createClientRef.current({
      // The client's own LIVE reconnect budget (with backoff, healthy refill,
      // and pre-expiry rotation) is the structural answer to transient
      // transport loss — a wifi switch or the server's 120s token sever must
      // recover, not end the session. This hook must never zero out
      // `maxReconnects`. Pre-live is different: a failure before the first
      // server `ready` hands the SAME mic gesture to the batch path, so the
      // pre-live budget is 0 — retrying past the gesture would strand the
      // start outcome.
      ...clientOptionsRef.current,
      preLiveMaxReconnects: clientOptionsRef.current?.preLiveMaxReconnects ?? 0,
      agentId: aId,
      conversationId: cId,
      getUiContext: () =>
        clientOptionsRef.current?.getUiContext?.() ?? {
          uiViewPath: getWindowNavigationPath().split(/[?#]/, 1)[0],
          uiTimeZone,
          uiBrowserSurface: getClientBrowserSurface(),
          uiClientId: apiClient.clientId,
        },
      // The client invokes this immediately before every mint/re-mint. Keeping
      // the source behind a ref gives reconnects the latest callback and, more
      // importantly, prevents replay of the one-use nonce from the first mint.
      getConsentNonce: () => getConsentNonceRef.current(),
      onState: (state, unifiedStatus) => {
        if (!isCurrent()) return;
        if (state.phase === "ready") serverReadyForMic = true;
        setStatus(unifiedStatus);
        setAgentSpeaking(state.phase === "speaking");
        // `active` derives ONLY from the client's phase: live means the socket
        // opened, the server sent `ready`, and the mic is capturing. Pre-live
        // phases (re)arm the watchdog; a teardown back to idle clears both.
        if (LIVE_SESSION_PHASES.has(state.phase)) {
          micOwnedRef.current = true;
          clearReadyTimer();
          setConnecting(false);
          setActive(true);
          resolveStartOutcome(gen, { kind: "live" });
        } else if (state.phase === "connecting" || state.phase === "ready") {
          setConnecting(true);
          armReadyTimer();
        } else {
          clearReadyTimer();
          setConnecting(false);
          setActive(false);
        }
      },
      onMinted: (minted) => {
        if (!isCurrent()) return;
        onMintedRef.current?.(minted);
        clientOptionsRef.current?.onMinted?.(minted);
      },
      onPlaybackUnlockChange: (required) => {
        if (!isCurrent()) return;
        setNeedsUnlock(required);
        clientOptionsRef.current?.onPlaybackUnlockChange?.(required);
      },
      onServerEvent: (event) => {
        if (!isCurrent()) return;
        applyServerEventToTranscript(event);
        clientOptionsRef.current?.onServerEvent?.(event);
      },
      onTraceMark: (marker) => {
        if (!isCurrent()) return;
        // Visibility-suspend surfaces a PAUSED state, not a broken one.
        if (marker.name === "mic_suspended") setPaused(true);
        if (marker.name === "mic_resumed") setPaused(false);
        clientOptionsRef.current?.onTraceMark?.(marker);
      },
      onError: (err) => {
        if (!isCurrent()) return;
        clearReadyTimer();
        // A 404 mint (feature disabled server-side) reaches us through the
        // client's onError (the client swallows the throw + tears down). Treat
        // it as a fall-back-to-batch signal, NOT an error surface. Eligibility
        // remains retryable on the next user interaction.
        if (err instanceof VoiceSessionMintError) {
          failedThisSession = true;
          if (err.isFeatureDisabled) {
            setConnecting(false);
            resolveStartOutcome(gen, {
              kind: "fallback-to-batch",
              reason: "mint",
            });
            return;
          }
        }
        const classified = classifyError(err);
        failedThisSession = true;
        setError(classified);
        setActive(false);
        setConnecting(false);
        // Release failed clients while retaining eligibility for an explicit
        // retry. The caller decides whether another capture path is allowed.
        if (
          !micOwnedRef.current ||
          classified.kind === "transport" ||
          classified.kind === "mint" ||
          classified.kind === "consent"
        ) {
          clientRef.current = null;
        }
        const fallbackReason = fallbackReasonForError(classified);
        if (fallbackReason && !micOwnedRef.current) {
          resolveStartOutcome(gen, {
            kind: "fallback-to-batch",
            reason: fallbackReason,
          });
        } else {
          resolveStartOutcome(gen, { kind: "error", error: classified });
        }
        clientOptionsRef.current?.onError?.(err);
      },
    });
    clientRef.current = client;

    try {
      // `start()` creates the playback AudioContext + mints + connects. The
      // client swallows a mint failure internally (emits via onError, tears
      // down), so this resolves even on a 404 — the fall-back branch is driven
      // by the typed onError callback, not a throw here.
      await client.start();
      if (!isCurrent()) {
        // A newer start/stop superseded us mid-connect; tear this one down.
        // error-policy:J6 A superseded session no longer owns UI state or media resources.
        await client.stop().catch(() => {});
        resolveStartOutcome(gen, { kind: "unavailable" });
        return await outcomePromise;
      }
      // `client.start()` already constructed and attempted to resume playback
      // before its first await, preserving this gesture's transient activation.
      // If that attempt was blocked, `needsUnlock` supplies a fresh CTA gesture;
      // a second resume here would be too late and would only duplicate marks.
      // A resolved start() is NOT "active": the socket may still be connecting
      // and the mic is not capturing yet. `active` flips only when onState
      // reports a live phase; the armed ready timer bounds that wait. A
      // feature-disabled 404 tore the client down; drop the ref so the caller
      // falls back to batch.
      if (failedThisSession) {
        clientRef.current = null;
        setActive(false);
      }
    } catch (err) {
      // error-policy:J4 Startup failure becomes a surfaced voice error and batch fallback.
      clearReadyTimer();
      const realError = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(realError);
      setError(classified);
      // Same latch policy as onError: only failures whose copy promises the
      // batch path disarm realtime; actionable kinds stay retryable.
      clientRef.current = null;
      // error-policy:J6 Failed startup teardown follows the surfaced primary error.
      await client.stop().catch(() => {});
      setActive(false);
      setConnecting(false);
      setNeedsUnlock(false);
      const fallbackReason = fallbackReasonForError(classified);
      if (fallbackReason && !micOwnedRef.current) {
        resolveStartOutcome(gen, {
          kind: "fallback-to-batch",
          reason: fallbackReason,
        });
      } else {
        resolveStartOutcome(gen, { kind: "error", error: classified });
      }
    } finally {
      // A superseded start may finish after stop + a newer start. It must not
      // clear the newer generation's pending latch.
      if (isCurrent()) startingRef.current = false;
    }
    return await outcomePromise;
  }, [
    applyServerEventToTranscript,
    clearReadyTimer,
    flagEnabled,
    resolveStartOutcome,
  ]);

  const reportFallback = useCallback((reason: RealtimeVoiceFallbackReason) => {
    setFallbackReason(reason);
  }, []);

  const bargeIn = useCallback(() => {
    clientRef.current?.bargeIn();
  }, []);

  const toggleMicrophoneMute = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setMicrophoneMuted((current) => {
      const next = !current;
      client.setMicrophoneMuted(next);
      return next;
    });
  }, []);

  const unlock = useCallback(async () => {
    try {
      await clientRef.current?.unlockPlayback();
    } catch (error) {
      // error-policy:J4 Playback denial is visible and disarms the realtime path.
      setError(
        classifyError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
  }, []);

  // Lifecycle: tear down on unmount so a live socket + hot mic never outlive the
  // component.
  useEffect(() => {
    return () => {
      identityRestartPendingRef.current = false;
      identityChangeGenRef.current += 1;
      sessionGenRef.current += 1;
      if (readyTimerRef.current !== null) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      const client = clientRef.current;
      clientRef.current = null;
      // error-policy:J6 Component teardown has already detached ownership of the client.
      void client?.stop().catch(() => {});
    };
  }, []);

  // If the flag flips off while a session is live, tear it down — the batch
  // path takes over and a stale realtime socket must not linger.
  useEffect(() => {
    if (!flagEnabled && (clientRef.current || startingRef.current)) {
      void stop();
    }
  }, [flagEnabled, stop]);

  // A mint is scoped to exactly one agent + conversation. If either identity
  // changes while a start/live session owns the mic, stop the old socket and
  // re-mint against the latest ids. A generation guard prevents rapid thread
  // switches from resurrecting an intermediate identity.
  const identityKey = `${normalizedAgentId}\n${normalizedConversationId}`;
  const previousIdentityRef = useRef(identityKey);
  useEffect(() => {
    if (previousIdentityRef.current === identityKey) return;
    previousIdentityRef.current = identityKey;

    const shouldRestart = Boolean(
      identityRestartPendingRef.current ||
        clientRef.current ||
        startingRef.current,
    );
    if (!shouldRestart) return;

    identityRestartPendingRef.current = true;
    const changeGen = ++identityChangeGenRef.current;
    let cancelled = false;
    void (async () => {
      const stoppedGeneration = await stopCurrentSession();
      if (
        cancelled ||
        identityChangeGenRef.current !== changeGen ||
        sessionGenRef.current !== stoppedGeneration
      ) {
        return;
      }
      const { agentId: nextAgentId, conversationId: nextConversationId } =
        idsRef.current;
      identityRestartPendingRef.current = false;
      if (flagEnabled && nextAgentId && nextConversationId) {
        await start();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flagEnabled, identityKey, start, stopCurrentSession]);

  return useMemo<UseRealtimeVoiceSessionState>(
    () => ({
      available,
      active,
      connecting,
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
      needsUnlock,
      paused,
      microphoneMuted,
      error,
      fallbackReason,
      reportFallback,
      speaker: speaker ?? null,
      start,
      stop,
      bargeIn,
      toggleMicrophoneMute,
      unlock,
    }),
    [
      available,
      active,
      connecting,
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
      needsUnlock,
      paused,
      microphoneMuted,
      error,
      fallbackReason,
      reportFallback,
      speaker,
      start,
      stop,
      bargeIn,
      toggleMicrophoneMute,
      unlock,
    ],
  );
}

/**
 * Read the VITE-side realtime-voice flag. Vite statically replaces
 * `import.meta.env.VITE_*` at build time, so this MUST be a literal member read
 * (not a dynamic key).
 *
 * Realtime capability is present by default on every target. Runtime identity,
 * conversation-bound availability, consent and a user gesture still gate capture.
 * Explicit false or malformed values disable the capability.
 */
export function isRealtimeVoiceFlagEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_WS as unknown;
    return raw === undefined || parseRealtimeVoiceFlag(raw);
  } catch {
    // error-policy:J4 An unreadable build flag explicitly leaves realtime unavailable.
    return false;
  }
}

/** Parse the build-time realtime voice switch without accepting typos as opt-ins. */
export function parseRealtimeVoiceFlag(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Re-export the mint-error type so the barrel/consumers get it from one place.
export { VoiceSessionMintError };
