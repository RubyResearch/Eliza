/**
 * Voice-session orchestrator — the keystone of the realtime voice loop.
 *
 * One instance == one live WS session. It owns the turn state machine and wires
 * the three legs together using the ALREADY-MERGED adapters as the provider
 * layer (never a reimplementation):
 *   - STT: Cartesia Ink 2. Uplink PCM is re-framed into 100 ms chunks and Ink's
 *     native turn events drive interruption, partials, and finalization without
 *     a second VAD or endpointing layer.
 *   - LLM: `streamElizaConversation` (existing SSE / Cerebras pass-through). No
 *     new LLM client.
 *   - TTS: Fish Audio when `ELIZA_TTS_FISH_ENABLED` is true; otherwise
 *     `CartesiaSonicTtsAdapter` (#15949). Phrase-aggregated deltas stream in;
 *     adapters' strict no-post-cancel guarantee makes barge-in correct.
 *
 * Interruption (contract §7.5): Ink semantic turn-start / explicit `barge_in`
 * -> under one `voiceTurnId`, cancel the active TTS stream (no post-cancel
 * frames), abort the Eliza SSE fetch, flush the downlink, drop pending phrase
 * aggregation, emit `interrupted`, return to listening. Target <250ms.
 *
 * Metering (SEC-15): server-derived uplink duration only; the client is NEVER
 * trusted for cost. Every audio frame accrues real-time seconds against the
 * injected usage store; over-cap severs with `quota_exhausted`.
 *
 * SEC-6: the session registers a `sever()` with the live-session registry so a
 * revoke — same-worker or cross-device — stops uplink to Cartesia in <=500ms.
 */

import type { VoiceUiContext } from "@elizaos/shared";
import {
  CartesiaSonicTtsAdapter,
  type CartesiaWebSocketFactory,
  VOICE_TTS_MAX_BUFFER_DELAY_MS,
} from "@/lib/services/cartesia-sonic-tts";
import {
  type FishAudioModel,
  FishAudioTtsAdapter,
  type FishAudioWebSocketFactory,
} from "@/lib/services/fish-audio-tts";
import type {
  VoiceUsageIdentity,
  VoiceUsageLimits,
  VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { logger } from "@/lib/utils/logger";
import {
  type ElizaServerTimingReceipt,
  ElizaSseBridgeError,
  type ElizaSseBridgeResponseHeaders,
  streamElizaConversation,
} from "@/lib/voice-session/eliza-sse-bridge";
import { PhraseAggregator } from "@/lib/voice-session/phrase-aggregator";
import type { ServerControlFrame } from "@/lib/voice-session/protocol";
import {
  getVoiceSessionRegistry,
  type LiveVoiceSession,
  type VoiceSessionRegistry,
  type VoiceSessionSeverReason,
} from "@/lib/voice-session/session-registry";
import type {
  VoiceSessionDownlink,
  VoiceSessionLike,
} from "@/lib/voice-session/ws-handler";
import {
  CARTESIA_INK_TURN_END_TIMEOUT_MILLISECONDS,
  type CartesiaInkRealtimeEvent,
  type CartesiaInkRealtimeSession,
  type CartesiaInkWebSocketFactory,
  createCartesiaInkRealtimeSession,
} from "../../stt/providers/cartesia-ink";
import { UplinkReframer } from "./uplink-reframer";

const PCM16_BYTES_PER_SECOND = 16_000 * 2; // 16kHz mono linear16.
/**
 * Keep the microphone closed briefly after the final downlink sample should
 * have played. Mobile speaker output can remain in the acoustic path for a
 * small device-buffer tail even after the provider has finished streaming.
 */
const HALF_DUPLEX_PLAYBACK_SETTLE_MS = 600;
/** Accrue metered minutes in whole seconds to keep the store's math simple. */
const METER_FLUSH_SECONDS = 5;
/** Nominal minutes charged on admission before ANY audio is forwarded (SEC-15). */
export const VOICE_PROVIDER_ADMISSION_MINUTES = METER_FLUSH_SECONDS / 60;
/** Cap pre-admission buffered frames so an in-flight check can't be flooded. */
const MAX_PREADMISSION_FRAMES = 64; // ~5s of 80ms frames.
/** Cover provider WebSocket setup without dropping the user's first words. */
const MAX_PROVIDER_PENDING_FRAMES = 128; // ~12.8s of 100ms Ink frames.
/** How often a live session polls the durable revocation store (SEC-6). */
const REVOCATION_POLL_MS = 400;
/**
 * Max un-verified metered windows we forward ahead of confirmed quota. Each
 * window is ~5s; a couple of windows tolerates normal Redis latency, but a
 * store that can't keep up (or a faster-than-realtime flood) trips the guard
 * and severs fail-closed instead of streaming unbounded paid audio.
 */
const MAX_OUTSTANDING_METER_WINDOWS = 2;
/**
 * Start inspecting a conversational reply for complete speakable sentences
 * before the runtime's terminal metadata arrives. PhraseAggregator still owns
 * the higher word-safe ceiling, so this never cuts inside a word or clause.
 */
const VOICE_TTS_STREAMING_START_CHARS = 96;
/** Keep every per-turn timing collection bounded even for pathological output. */
const MAX_VOICE_METRIC_OFFSETS = 16;
/** Human-readable interim captions do not benefit from provider-rate redraws. */
const STT_PARTIAL_EMIT_INTERVAL_MS = 40;
/**
 * Cold shared-runtime turns can cross several independent cache boundaries.
 * Retry the same trace/idempotency key long enough for their waitUntil fills to
 * land, while keeping the total first-turn penalty bounded below eight seconds.
 */
const CACHE_WARMING_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const MAX_RECORDED_UPSTREAM_ATTEMPTS = 8;
/** Replace a failed realtime recognizer without dropping the live phone call. */
const STT_RECONNECT_DELAYS_MS = [0, 250, 1_000, 2_000, 5_000] as const;
/** Consecutive revoke-store failures tolerated before the session fails closed. */
const MAX_REVOCATION_POLL_FAILURES = 3;
/**
 * Bound each outbound Ink upgrade so a dead socket advances to the next retry.
 * After the initial schedule, retries continue at the capped delay until the
 * call ends or Ink recovers.
 */
const STT_CONNECT_TIMEOUT_MS = 2_500;
const CACHE_WARMING_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
  "conversation_cache_warming",
]);
const SPOKEN_TRANSCRIPT_RE = /[\p{L}\p{N}]/u;
const UNSPEAKABLE_RESPONSE_FALLBACK =
  "Sorry, I couldn't form a response. Could you say that again?";

// Cartesia's server buffers streamed transcript for up to 3000ms by default
// before starting synthesis, which measured ~2.7s of the speaking_start gap on
// staging even after phrases were sent early (#16607). The cap now lives with
// the adapter (VOICE_TTS_MAX_BUFFER_DELAY_MS) so the evidence-harness
// reference server provably opens Cartesia with the same value (#16667).

export type { VoiceSessionDownlink } from "@/lib/voice-session/ws-handler";

export interface VoiceTurnMetricsReceipt {
  traceId: string;
  startedAtMs: number;
  outcome: "completed" | "interrupted" | "error";
  llmDeltaCount: number;
  firstLlmTextOffsetMs: number | null;
  lastLlmTextOffsetMs: number | null;
  maxLlmDeltaGapMs: number;
  sonicRequestCount: number;
  sonicRequestOffsetsMs: readonly number[];
  sonicRequestsBeforeTransportReady: number;
  maxSonicRequestGapMs: number;
  firstAudioFrameOffsetMs: number | null;
  lastAudioFrameOffsetMs: number | null;
  audioFrameCount: number;
  outboundAudioBytes: number;
  maxAudioFrameGapMs: number;
  completionOffsetMs: number | null;
  halfDuplexArmedCount: number;
  halfDuplexSettlingCount: number;
  halfDuplexSuppressedFrameCount: number;
  halfDuplexSuppressedBytes: number;
}

interface VoiceTurnMetricsState extends VoiceTurnMetricsReceipt {
  lastLlmDeltaAtMs: number | null;
  lastSonicRequestAtMs: number | null;
  lastAudioFrameAtMs: number | null;
}

export interface VoiceSessionConfig {
  sessionId: string;
  jti: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /** Unix-seconds expiry of the bootstrap token; the session self-severs at exp. */
  tokenExpSeconds: number;

  // Provider wiring (injectable for tests: fake transports, real adapter code).
  cartesiaApiKey: string;
  cartesiaInkWebSocketFactory: CartesiaInkWebSocketFactory;
  cartesiaVoiceId: string;
  cartesiaWebSocketFactory: CartesiaWebSocketFactory;
  fishAudioEnabled?: boolean;
  fishAudioApiKey?: string;
  fishAudioReferenceId?: string;
  fishAudioModel?: FishAudioModel;
  fishAudioSampleRate?: number;
  fishAudioFirstAudioTimeoutMs?: number;
  fishAudioWebSocketFactory?: FishAudioWebSocketFactory;
  /**
   * Opt in only when the client has proven echo cancellation. The safe default
   * is half duplex: assistant playback never reaches Ink as caller speech.
   */
  acousticBargeInEnabled?: boolean;
  /** Server-owned rollout gate for verified browser AEC overlap/handoff. */
  allowContinuousHandoff?: boolean;
  /** Deterministic test override for the post-playback microphone settle. */
  halfDuplexPlaybackSettleMs?: number;
  /** Bounded payload-free timing receipt for observability and regression tests. */
  onTurnMetrics?: (receipt: VoiceTurnMetricsReceipt) => void;

  // LLM leg.
  elizaEndpoint: string;
  elizaAuthorization: string;
  elizaModel: string;
  fetchImpl?: typeof fetch;
  /** Session-start DB/tenancy warmup, injected only by the live Worker route. */
  prewarmElizaContext?: () => Promise<void>;
  /** Optional provider-synthesized opener that runs while agent context warms. */
  openingGreeting?: string;
  /** Optional canonical agent turn that generates a durable assistant opener. */
  openingPrompt?: string;
  openingClientMessageId?: string;
  /** Server-attested call-start cutoff applied only to the canonical opener. */
  openingHistoryCutoffAt?: number;
  /** Fixed privacy-safe greeting used only when opener generation fails. */
  openingFallbackGreeting?: string;
  /** Deterministic test override; production uses bounded exponential backoff. */
  cacheWarmingRetryDelaysMs?: readonly number[];
  /** Deterministic test override for the bounded Ink reconnect schedule. */
  sttReconnectDelaysMs?: readonly number[];
  /** Deterministic test override for the Ink connection-establishment bound. */
  sttConnectTimeoutMs?: number;
  /** Deterministic test override for the bounded pending-audio queue. */
  sttPendingFrameLimit?: number;

  // Metering (SEC-15). Server-derived only.
  usageStore: VoiceUsageStore;
  usageLimits: VoiceUsageLimits;
  /** Initial window already atomically recorded immediately before start(). */
  initialUsageAdmissionMinutes?: number;

  downlink: VoiceSessionDownlink;
  registry?: VoiceSessionRegistry;
  now?: () => number;
  /**
   * Durable revocation check (SEC-6 cross-worker). When provided, the live
   * session polls it and self-severs if its own jti was revoked on another
   * worker. Omit in unit tests that don't exercise cross-worker revoke.
   */
  isRevoked?: (jti: string) => Promise<boolean>;
  /**
   * Revoke the bootstrap token's jti when the session ends. Called on ANY
   * teardown (bye/close/error/revoke) so a leaked/replayed token cannot open a
   * second paid session within the token's remaining TTL. Best-effort.
   */
  onTeardownRevoke?: (jti: string, expSeconds: number) => Promise<void>;
  /** Persist transport lifecycle after the synchronous session is safely closed. */
  onTeardown?: (reason: VoiceSessionSeverReason) => Promise<void>;
}

type SessionState =
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "closed";

export class VoiceSession implements LiveVoiceSession, VoiceSessionLike {
  readonly sessionId: string;
  readonly jti: string;
  readonly organizationId: string;
  readonly userId: string;

  private readonly config: VoiceSessionConfig;
  private readonly registry: VoiceSessionRegistry;
  private readonly now: () => number;
  private readonly reframer = new UplinkReframer();
  private readonly usageIdentity: VoiceUsageIdentity;

  private stt: CartesiaInkRealtimeSession | null = null;
  private sttReady = false;
  private sttGeneration = 0;
  private sttReconnectAttempts = 0;
  private sttReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sttConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly providerPendingFrames: ArrayBuffer[] = [];
  private sttBufferOverflowReported = false;
  private readonly cartesiaAdapter: CartesiaSonicTtsAdapter;
  private readonly fishAudioAdapter: FishAudioTtsAdapter | null = null;
  private ttsStream: RealtimeTtsStream | null = null;
  private assistantPlaybackStartedAtMs: number | null = null;
  private assistantPlaybackAudioBytes = 0;
  private assistantPlaybackActive = false;
  private assistantPlaybackSuppressedUntilMs = Number.NEGATIVE_INFINITY;
  private assistantPlaybackDroppedUplinkBytes = 0;
  private assistantPlaybackDropLogged = false;
  private turnMetrics: VoiceTurnMetricsState | null = null;

  private state: SessionState = "ready";
  private started = false;
  private closed = false;
  private startedAtMs: number | null = null;
  private prewarmStartedAtMs: number | null = null;
  private prewarmCompletedAtMs: number | null = null;
  private prewarmStatus: "not_configured" | "pending" | "success" | "error" =
    "not_configured";
  private prewarmPromise: Promise<void> | null = null;
  private prewarmRetryWakeConsumed = false;

  /** Monotonic turn counter; the current turn's trace id derives from it. */
  private turnCounter = 0;
  private currentTraceId: string | null = null;
  private currentVoiceTurnId: string | null = null;
  private activeSttTurn = false;
  private sttTurnStartedAtMs: number | null = null;
  private sttFirstTranscriptAtMs: number | null = null;
  private sttLastTranscriptAtMs: number | null = null;
  private sttEagerEndAtMs: number | null = null;
  private pendingSttPartial: { text: string; traceId: string } | null = null;
  private lastSttPartialText = "";
  private lastSttPartialSentAtMs = Number.NEGATIVE_INFINITY;
  private sttPartialTimer: ReturnType<typeof setTimeout> | null = null;
  private llmAbort: AbortController | null = null;
  private phrase: PhraseAggregator | null = null;
  private turnSttMs = 0;
  private turnTtsChars = 0;
  private firstLlmTextEmitted = false;
  private callerResponseTurnCount = 0;
  private continuousHandoffEnabled = false;
  private assistantReferenceText = "";
  private sttTurnEchoOnly = false;
  private sttTurnDoubleTalkReported = false;
  private pendingOverlapTurn: {
    readonly traceId: string;
    readonly transcript: string;
    readonly abort: AbortController;
    replyText: string | null;
    uiContext: VoiceUiContext;
    handoffRequested: boolean;
    viewHandoff?: {
      viewId: string;
      viewPath?: string;
      subview?: string;
    };
  } | null = null;
  private readonly overlapRequests = new Set<AbortController>();
  /**
   * Resolves once the active canonical response stream has finished reading
   * and persisting its model turn. An overlap request may prepare while the
   * old audio is still playing, but it must not race another canonical write
   * against the same conversation.
   */
  private activeResponseModelSettled: Promise<void> = Promise.resolve();

  // Metering accrual (server-derived): count uplink bytes, convert to seconds.
  private unmeteredUplinkBytes = 0;
  private meteredExhausted = false;
  private meteringAdmitted = false;
  private admissionInFlight = false;
  private meterWindowsInFlight = 0;
  private readonly preAdmissionFrames: ArrayBuffer[] = [];
  private revocationPoll: ReturnType<typeof setInterval> | null = null;
  private revocationPollFailures = 0;
  private revocationPollInFlight = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private isRevoked: ((jti: string) => Promise<boolean>) | null = null;

  constructor(config: VoiceSessionConfig) {
    this.config = config;
    this.sessionId = config.sessionId;
    this.jti = config.jti;
    this.organizationId = config.organizationId;
    this.userId = config.userId;
    this.registry = config.registry ?? getVoiceSessionRegistry();
    this.isRevoked = config.isRevoked ?? null;
    this.now = config.now ?? Date.now;
    this.usageIdentity = {
      organizationId: config.organizationId,
      userId: config.userId,
    };
    if (config.initialUsageAdmissionMinutes !== undefined) {
      if (
        !Number.isFinite(config.initialUsageAdmissionMinutes) ||
        config.initialUsageAdmissionMinutes <= 0
      ) {
        throw new RangeError("initial voice usage admission must be positive");
      }
      this.meteringAdmitted = true;
      this.turnSttMs = Math.round(config.initialUsageAdmissionMinutes * 60_000);
      this.unmeteredUplinkBytes = -Math.round(
        config.initialUsageAdmissionMinutes * 60 * PCM16_BYTES_PER_SECOND,
      );
    }
    this.cartesiaAdapter = new CartesiaSonicTtsAdapter({
      apiKey: config.cartesiaApiKey,
      voiceId: config.cartesiaVoiceId,
      websocketFactory: config.cartesiaWebSocketFactory,
    });
    if (
      config.fishAudioEnabled &&
      config.fishAudioApiKey &&
      config.fishAudioReferenceId &&
      config.fishAudioWebSocketFactory
    ) {
      this.fishAudioAdapter = new FishAudioTtsAdapter({
        apiKey: config.fishAudioApiKey,
        referenceId: config.fishAudioReferenceId,
        model: config.fishAudioModel,
        sampleRate: config.fishAudioSampleRate,
        firstAudioTimeoutMs: config.fishAudioFirstAudioTimeoutMs,
        websocketFactory: config.fishAudioWebSocketFactory,
      });
    }
  }

  /**
   * Open the Ink STT socket and register for revoke-to-silence. Emits `ready`.
   * Idempotent — a second `start()` is a no-op.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.startedAtMs = this.now();

    this.openSttSession();

    this.registry.register(this);

    // Cross-worker revoke poll (SEC-6): if this session's jti is revoked on a
    // DIFFERENT worker (the same-worker path severs synchronously via the
    // registry), the poll observes it and self-severs within the poll window.
    if (this.isRevoked) {
      this.revocationPoll = setInterval(() => {
        void (async () => {
          if (this.closed || !this.isRevoked || this.revocationPollInFlight) {
            return;
          }
          this.revocationPollInFlight = true;
          try {
            if (await this.isRevoked(this.jti)) {
              this.teardown("revoked");
              return;
            }
            this.revocationPollFailures = 0;
          } catch (error) {
            this.revocationPollFailures += 1;
            logger.warn("[voice-session] revocation poll failed", {
              sessionId: this.sessionId,
              consecutiveFailures: this.revocationPollFailures,
              error: error instanceof Error ? error.message : String(error),
            });
            // error-policy:J4 fail-closed degrade — tolerate a brief store
            // blip, but sustained inability to verify revocation severs the
            // session within a bounded number of poll windows (SEC-6).
            if (this.revocationPollFailures >= MAX_REVOCATION_POLL_FAILURES) {
              logger.error("[voice-session] revocation store unavailable", {
                sessionId: this.sessionId,
                traceId: this.currentTraceId,
                consecutiveFailures: this.revocationPollFailures,
              });
              this.teardown("error");
            }
          } finally {
            this.revocationPollInFlight = false;
          }
        })();
      }, REVOCATION_POLL_MS);
    }

    // Enforce the bootstrap token's expiry as a hard session ceiling: once the
    // 120s token (and its sessionId->jti directory entry) would expire, a
    // revoke could no longer resolve/observe the jti, so the socket must not
    // outlive it. Self-sever at exp.
    const nowSeconds = Math.floor(this.now() / 1000);
    const msUntilExp = Math.max(
      0,
      (this.config.tokenExpSeconds - nowSeconds) * 1000,
    );
    this.expiryTimer = setTimeout(() => {
      if (!this.closed) this.teardown("expired");
    }, msUntilExp);

    this.state = "listening";
    // Read immutable tenancy from cache while the user is beginning to speak.
    // A miss schedules authoritative hydration under the Worker lifetime. This
    // is a latency hint only: the response path has its own typed cache-warming
    // retries and must never wait indefinitely for optional background fills.
    if (this.config.prewarmElizaContext) {
      this.prewarmStartedAtMs = this.now();
      this.prewarmStatus = "pending";
      const prewarmPromise: Promise<void> = Promise.resolve()
        .then(() => this.config.prewarmElizaContext?.())
        .then(() => {
          this.prewarmCompletedAtMs = this.now();
          this.prewarmStatus = "success";
          logger.info("[voice-session] Eliza context prewarm completed", {
            sessionId: this.sessionId,
            prewarmDurationMs:
              this.prewarmCompletedAtMs -
              (this.prewarmStartedAtMs ?? this.prewarmCompletedAtMs),
          });
        })
        .catch((error) => {
          this.prewarmCompletedAtMs = this.now();
          this.prewarmStatus = "error";
          // error-policy:J7 prewarm is latency-only; the response path retains
          // its typed cache-warming retry fallback and reports the failed hint.
          logger.warn("[voice-session] Eliza context prewarm failed", {
            sessionId: this.sessionId,
            prewarmDurationMs:
              this.prewarmCompletedAtMs -
              (this.prewarmStartedAtMs ?? this.prewarmCompletedAtMs),
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (this.prewarmPromise === prewarmPromise) {
            this.prewarmPromise = null;
          }
        });
      this.prewarmPromise = prewarmPromise;
      void prewarmPromise;
    }
    // The session-level trace span id is stable until the first turn mints its own.
    const sessionTrace = this.mintTraceId("session");
    this.currentTraceId = sessionTrace;
    this.send({
      t: "ready",
      sessionId: this.sessionId,
      traceId: sessionTrace,
      uiContext: true,
    });
    if (this.config.openingPrompt?.trim()) {
      const traceId = this.mintTraceId("turn");
      this.currentTraceId = traceId;
      this.currentVoiceTurnId = traceId;
      this.state = "thinking";
      void this.runResponseTurn(this.config.openingPrompt.trim(), traceId, {
        messageRole: "system",
        clientMessageId: this.config.openingClientMessageId,
        historyCutoffAt: this.config.openingHistoryCutoffAt,
        transientInput: true,
        fallbackGreeting: this.config.openingFallbackGreeting,
      });
    } else if (this.config.openingGreeting?.trim()) {
      this.speakOpeningGreeting(this.config.openingGreeting.trim());
    }
  }

  private uiContext: VoiceUiContext = {};

  setUiContext(context: VoiceUiContext): void {
    this.uiContext = { ...context };
  }

  setAudioCapabilities(capabilities: {
    mode: "continuous_handoff";
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    referenceAwarePlayback: boolean;
  }): void {
    this.continuousHandoffEnabled =
      this.config.allowContinuousHandoff === true &&
      capabilities.mode === "continuous_handoff" &&
      capabilities.echoCancellation &&
      capabilities.referenceAwarePlayback;
    logger.info("[voice-session] continuous handoff capability", {
      sessionId: this.sessionId,
      enabled: this.continuousHandoffEnabled,
      echoCancellation: capabilities.echoCancellation,
      noiseSuppression: capabilities.noiseSuppression,
      autoGainControl: capabilities.autoGainControl,
      referenceAwarePlayback: capabilities.referenceAwarePlayback,
    });
  }

  /**
   * Push a client uplink audio chunk (PCM16). Re-frames to Ink chunk size and
   * meters server-derived seconds. Silently drops if the session is torn down.
   */
  pushUplinkAudio(bytes: Uint8Array): void {
    if (this.closed || this.meteredExhausted) return;

    // No AEC is guaranteed on the mobile clients. During assistant playback,
    // forwarding speaker echo to Ink makes the model transcribe and answer
    // itself. Drop before re-framing and metering so suppressed echo is neither
    // provider input nor billed caller audio. Explicit UI barge-in clears this
    // gate synchronously; acoustic barge-in is available only to AEC-safe
    // clients that opt in through the session config.
    if (this.isAssistantPlaybackSuppressed()) {
      this.assistantPlaybackDroppedUplinkBytes += bytes.byteLength;
      if (this.turnMetrics) {
        this.turnMetrics.halfDuplexSuppressedFrameCount += 1;
        this.turnMetrics.halfDuplexSuppressedBytes += bytes.byteLength;
      }
      if (!this.assistantPlaybackDropLogged) {
        this.assistantPlaybackDropLogged = true;
        logger.info("[voice-session] half-duplex uplink suppressed", {
          traceId: this.currentVoiceTurnId,
        });
      }
      return;
    }

    // Fail-closed admission (SEC-15): NO audio is forwarded to the paid provider
    // until an initial quota check has PASSED. Frames that arrive before the
    // first admission resolves are re-framed and buffered (bounded); if
    // admission is denied or the metering store errors, the session severs and
    // those buffered frames are never sent. A client that streams faster than
    // real time cannot outrun the gate because forwarding is blocked on it.
    const frames = this.reframer.push(bytes);
    this.accrueUplink(bytes.byteLength);
    if (this.meteredExhausted) return;

    if (!this.meteringAdmitted) {
      for (const f of frames) this.preAdmissionFrames.push(f);
      this.ensureAdmission();
      // Bound the pre-admission buffer so a flood cannot pin memory while the
      // check is in flight; over the bound, sever fail-closed.
      if (this.preAdmissionFrames.length > MAX_PREADMISSION_FRAMES) {
        this.meteredExhausted = true;
        this.send({
          t: "error",
          code: "metering_unavailable",
          retryable: false,
        });
        this.teardown("error");
      }
      return;
    }

    // Ongoing metering back-pressure (SEC-15): if the metering store is slower
    // than realtime, un-verified metered windows pile up. Bound how far ahead
    // of confirmed quota we forward; over the bound, fail closed rather than
    // stream unbounded paid audio while checks lag.
    if (this.meterWindowsInFlight > MAX_OUTSTANDING_METER_WINDOWS) {
      this.meteredExhausted = true;
      this.send({
        t: "error",
        code: "metering_backpressure",
        retryable: false,
      });
      this.teardown("error");
      return;
    }

    for (const frame of frames) if (!this.forwardSttFrame(frame)) return;
  }

  private beginTurnMetrics(traceId: string, startedAtMs: number): void {
    this.turnMetrics = {
      traceId,
      startedAtMs,
      outcome: "completed",
      llmDeltaCount: 0,
      firstLlmTextOffsetMs: null,
      lastLlmTextOffsetMs: null,
      maxLlmDeltaGapMs: 0,
      sonicRequestCount: 0,
      sonicRequestOffsetsMs: [],
      sonicRequestsBeforeTransportReady: 0,
      maxSonicRequestGapMs: 0,
      firstAudioFrameOffsetMs: null,
      lastAudioFrameOffsetMs: null,
      audioFrameCount: 0,
      outboundAudioBytes: 0,
      maxAudioFrameGapMs: 0,
      completionOffsetMs: null,
      halfDuplexArmedCount: 0,
      halfDuplexSettlingCount: 0,
      halfDuplexSuppressedFrameCount: 0,
      halfDuplexSuppressedBytes: 0,
      lastLlmDeltaAtMs: null,
      lastSonicRequestAtMs: null,
      lastAudioFrameAtMs: null,
    };
  }

  private noteLlmDelta(traceId: string): void {
    const metrics = this.turnMetrics;
    if (!metrics || metrics.traceId !== traceId) return;
    const now = this.now();
    const offset = Math.max(0, now - metrics.startedAtMs);
    metrics.llmDeltaCount += 1;
    metrics.firstLlmTextOffsetMs ??= offset;
    metrics.lastLlmTextOffsetMs = offset;
    if (metrics.lastLlmDeltaAtMs !== null) {
      metrics.maxLlmDeltaGapMs = Math.max(
        metrics.maxLlmDeltaGapMs,
        now - metrics.lastLlmDeltaAtMs,
      );
    }
    metrics.lastLlmDeltaAtMs = now;
  }

  private noteSonicRequest(traceId: string, transportReady: boolean): void {
    const metrics = this.turnMetrics;
    if (!metrics || metrics.traceId !== traceId) return;
    const now = this.now();
    metrics.sonicRequestCount += 1;
    if (metrics.sonicRequestOffsetsMs.length < MAX_VOICE_METRIC_OFFSETS) {
      (metrics.sonicRequestOffsetsMs as number[]).push(
        Math.max(0, now - metrics.startedAtMs),
      );
    }
    if (!transportReady) metrics.sonicRequestsBeforeTransportReady += 1;
    if (metrics.lastSonicRequestAtMs !== null) {
      metrics.maxSonicRequestGapMs = Math.max(
        metrics.maxSonicRequestGapMs,
        now - metrics.lastSonicRequestAtMs,
      );
    }
    metrics.lastSonicRequestAtMs = now;
  }

  private noteAudioFrame(traceId: string, byteLength: number): void {
    const metrics = this.turnMetrics;
    if (!metrics || metrics.traceId !== traceId) return;
    const now = this.now();
    const offset = Math.max(0, now - metrics.startedAtMs);
    metrics.firstAudioFrameOffsetMs ??= offset;
    metrics.lastAudioFrameOffsetMs = offset;
    metrics.audioFrameCount += 1;
    metrics.outboundAudioBytes += Math.max(0, byteLength);
    if (metrics.lastAudioFrameAtMs !== null) {
      metrics.maxAudioFrameGapMs = Math.max(
        metrics.maxAudioFrameGapMs,
        now - metrics.lastAudioFrameAtMs,
      );
    }
    metrics.lastAudioFrameAtMs = now;
  }

  private emitTurnMetrics(
    traceId: string,
    outcome: VoiceTurnMetricsReceipt["outcome"],
  ): void {
    const metrics = this.turnMetrics;
    if (!metrics || metrics.traceId !== traceId) return;
    metrics.outcome = outcome;
    metrics.completionOffsetMs = Math.max(0, this.now() - metrics.startedAtMs);
    this.turnMetrics = null;
    const receipt: VoiceTurnMetricsReceipt = {
      traceId: metrics.traceId,
      startedAtMs: metrics.startedAtMs,
      outcome: metrics.outcome,
      llmDeltaCount: metrics.llmDeltaCount,
      firstLlmTextOffsetMs: metrics.firstLlmTextOffsetMs,
      lastLlmTextOffsetMs: metrics.lastLlmTextOffsetMs,
      maxLlmDeltaGapMs: metrics.maxLlmDeltaGapMs,
      sonicRequestCount: metrics.sonicRequestCount,
      sonicRequestOffsetsMs: [...metrics.sonicRequestOffsetsMs],
      sonicRequestsBeforeTransportReady:
        metrics.sonicRequestsBeforeTransportReady,
      maxSonicRequestGapMs: metrics.maxSonicRequestGapMs,
      firstAudioFrameOffsetMs: metrics.firstAudioFrameOffsetMs,
      lastAudioFrameOffsetMs: metrics.lastAudioFrameOffsetMs,
      audioFrameCount: metrics.audioFrameCount,
      outboundAudioBytes: metrics.outboundAudioBytes,
      maxAudioFrameGapMs: metrics.maxAudioFrameGapMs,
      completionOffsetMs: metrics.completionOffsetMs,
      halfDuplexArmedCount: metrics.halfDuplexArmedCount,
      halfDuplexSettlingCount: metrics.halfDuplexSettlingCount,
      halfDuplexSuppressedFrameCount: metrics.halfDuplexSuppressedFrameCount,
      halfDuplexSuppressedBytes: metrics.halfDuplexSuppressedBytes,
    };
    try {
      this.config.onTurnMetrics?.(receipt);
    } catch (error) {
      logger.warn("[voice-session] turn metrics hook failed", {
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Queue audio until Ink is ready, then preserve its original frame order. */
  private forwardSttFrame(frame: ArrayBuffer): boolean {
    if (this.closed) return false;
    if (!this.stt || !this.sttReady) {
      this.providerPendingFrames.push(frame);
      const pendingLimit =
        this.config.sttPendingFrameLimit ?? MAX_PROVIDER_PENDING_FRAMES;
      if (this.providerPendingFrames.length <= pendingLimit) {
        return true;
      }
      // Retain a bounded rolling window of the newest caller audio while Ink
      // reconnects. Metering and byte-rate checks still run before this queue,
      // so provider downtime cannot create unbounded memory or paid usage.
      this.providerPendingFrames.shift();
      if (!this.sttBufferOverflowReported) {
        this.sttBufferOverflowReported = true;
        logger.warn("[voice-session] Ink pending-audio buffer rolled over", {
          sessionId: this.sessionId,
          pendingFrameLimit: pendingLimit,
        });
        this.send({
          t: "error",
          code: "provider_unavailable",
          retryable: true,
        });
      }
      return true;
    }
    try {
      this.stt.sendAudioChunk(frame);
      return true;
    } catch {
      // error-policy:J6 best-effort teardown race — a closed/closing Ink
      // socket after a concurrent sever; stop forwarding.
      return false;
    }
  }

  /**
   * Run the one-time admission quota check, then release buffered frames. This
   * is what makes forwarding fail-closed: nothing reaches Cartesia until
   * `checkAndRecord` returns allowed.
   */
  private ensureAdmission(): void {
    if (
      this.admissionInFlight ||
      this.meteringAdmitted ||
      this.meteredExhausted
    )
      return;
    this.admissionInFlight = true;
    void (async () => {
      try {
        const decision = await this.config.usageStore.checkAndRecord(
          this.usageIdentity,
          VOICE_PROVIDER_ADMISSION_MINUTES,
          this.config.usageLimits,
        );
        if (this.closed) return;
        if (!decision.allowed) {
          this.meteredExhausted = true;
          this.send({ t: "error", code: "quota_exhausted", retryable: false });
          this.teardown("quota_exhausted");
          return;
        }
        this.meteringAdmitted = true;
        this.turnSttMs += Math.round(VOICE_PROVIDER_ADMISSION_MINUTES * 60_000);
        // Release the buffered frames now that we are admitted.
        const buffered = this.preAdmissionFrames.splice(0);
        for (const frame of buffered) if (!this.forwardSttFrame(frame)) break;
      } catch (error) {
        // error-policy:J4 fail-closed degrade — a metering-store failure must
        // not admit unpaid audio: surface metering_unavailable and sever.
        if (this.closed) return;
        logger.error("[voice-session] initial metering admission failed", {
          sessionId: this.sessionId,
          traceId: this.currentTraceId,
          errorClass: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this.meteredExhausted = true;
        this.send({
          t: "error",
          code: "metering_unavailable",
          retryable: false,
        });
        this.teardown("error");
      } finally {
        this.admissionInFlight = false;
      }
    })();
  }

  /** Explicit UI barge-in (contract §7.2). */
  bargeIn(): void {
    this.clearAssistantPlaybackSuppression();
    this.interrupt("explicit");
  }

  /** Client `bye`: complete the session cleanly. */
  bye(): void {
    this.teardown("completed");
  }

  private isAssistantPlaybackSuppressed(): boolean {
    if (
      this.config.acousticBargeInEnabled === true ||
      this.continuousHandoffEnabled
    )
      return false;
    return (
      this.assistantPlaybackActive ||
      this.now() < this.assistantPlaybackSuppressedUntilMs
    );
  }

  private armAssistantPlaybackSuppression(): void {
    if (this.continuousHandoffEnabled) {
      // Continuous handoff keeps the uplink open, but still needs a truthful
      // first-audio marker so a thinking-time utterance cannot be reported as
      // human double-talk.
      this.assistantPlaybackActive = true;
      this.assistantPlaybackStartedAtMs = this.now();
      this.assistantPlaybackAudioBytes = 0;
      return;
    }
    if (this.config.acousticBargeInEnabled === true) return;
    if (this.turnMetrics) this.turnMetrics.halfDuplexArmedCount += 1;
    this.assistantPlaybackActive = true;
    this.assistantPlaybackStartedAtMs = this.now();
    this.assistantPlaybackAudioBytes = 0;
    this.assistantPlaybackSuppressedUntilMs = Number.POSITIVE_INFINITY;
    this.assistantPlaybackDroppedUplinkBytes = 0;
    this.assistantPlaybackDropLogged = false;
    this.discardSuppressedUplinkState();
    logger.info("[voice-session] half-duplex playback suppression armed", {
      traceId: this.currentVoiceTurnId,
    });
  }

  private noteAssistantPlaybackAudio(byteLength: number): void {
    if (!this.assistantPlaybackActive || byteLength <= 0) return;
    this.assistantPlaybackAudioBytes += byteLength;
  }

  private settleAssistantPlaybackSuppression(): void {
    if (!this.assistantPlaybackActive) return;
    if (this.continuousHandoffEnabled) {
      this.assistantPlaybackActive = false;
      this.assistantPlaybackStartedAtMs = null;
      this.assistantPlaybackAudioBytes = 0;
      return;
    }
    if (this.turnMetrics) this.turnMetrics.halfDuplexSettlingCount += 1;
    const now = this.now();
    const playbackStartedAt = this.assistantPlaybackStartedAtMs ?? now;
    const estimatedPlaybackMs = Math.ceil(
      (this.assistantPlaybackAudioBytes / PCM16_BYTES_PER_SECOND) * 1000,
    );
    const settleMs = Math.max(
      0,
      this.config.halfDuplexPlaybackSettleMs ?? HALF_DUPLEX_PLAYBACK_SETTLE_MS,
    );
    this.assistantPlaybackActive = false;
    this.assistantPlaybackSuppressedUntilMs =
      Math.max(now, playbackStartedAt + estimatedPlaybackMs) + settleMs;
    this.discardSuppressedUplinkState();
    logger.info("[voice-session] half-duplex playback suppression settling", {
      traceId: this.currentVoiceTurnId,
      estimatedPlaybackMs,
      settleMs,
      droppedUplinkBytes: this.assistantPlaybackDroppedUplinkBytes,
    });
  }

  private clearAssistantPlaybackSuppression(): void {
    const wasSuppressed = this.isAssistantPlaybackSuppressed();
    this.assistantPlaybackActive = false;
    this.assistantPlaybackStartedAtMs = null;
    this.assistantPlaybackAudioBytes = 0;
    this.assistantPlaybackSuppressedUntilMs = Number.NEGATIVE_INFINITY;
    this.assistantPlaybackDroppedUplinkBytes = 0;
    this.assistantPlaybackDropLogged = false;
    if (wasSuppressed) this.discardSuppressedUplinkState();
  }

  private discardSuppressedUplinkState(): void {
    this.preAdmissionFrames.length = 0;
    this.providerPendingFrames.length = 0;
    this.reframer.flush();
    this.activeSttTurn = false;
    this.sttTurnStartedAtMs = null;
    this.sttFirstTranscriptAtMs = null;
    this.sttLastTranscriptAtMs = null;
    this.sttEagerEndAtMs = null;
    this.resetSttPartialDelivery();
  }

  private shouldIgnoreAssistantEchoEvent(type: string): boolean {
    if (!this.isAssistantPlaybackSuppressed()) return false;
    return (
      type === "start-of-turn" ||
      type === "transcript-update" ||
      type === "eager-end-of-turn" ||
      type === "end-of-turn" ||
      type === "turn-resumed"
    );
  }

  // --- LiveVoiceSession (SEC-6) --------------------------------------------

  sever(reason: VoiceSessionSeverReason): void {
    this.teardown(reason);
  }

  // --- STT event handling ---------------------------------------------------

  private openSttSession(): void {
    const generation = ++this.sttGeneration;
    this.sttReady = false;
    this.stt = createCartesiaInkRealtimeSession({
      cartesiaApiKey: this.config.cartesiaApiKey,
      webSocketFactory: this.config.cartesiaInkWebSocketFactory,
      onEvent: (event) => this.onSttEvent(event, generation),
    });
    const timeoutMs = this.config.sttConnectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (this.sttConnectTimer !== timer) return;
      this.sttConnectTimer = null;
      if (this.closed || generation !== this.sttGeneration || this.sttReady) {
        return;
      }
      logger.warn("[voice-session] Ink connection timed out", {
        sessionId: this.sessionId,
        attempt: this.sttReconnectAttempts,
        timeoutMs,
      });
      this.send({ t: "error", code: "stt_reconnecting", retryable: true });
      this.recoverSttTransport("connect_timeout", generation);
    }, timeoutMs);
    this.sttConnectTimer = timer;
  }

  private onSttEvent(
    event: CartesiaInkRealtimeEvent,
    generation: number,
  ): void {
    if (this.closed || generation !== this.sttGeneration) return;
    if (this.shouldIgnoreAssistantEchoEvent(event.type)) {
      this.discardSuppressedUplinkState();
      return;
    }
    switch (event.type) {
      case "connected": {
        // Provider readiness is transport metadata; the client-facing session
        // has already emitted its own authenticated `ready` frame.
        const reconnectAttempts = this.sttReconnectAttempts;
        this.sttReconnectAttempts = 0;
        this.sttReady = true;
        this.sttBufferOverflowReported = false;
        this.clearSttConnectTimeout();
        const buffered = this.providerPendingFrames.splice(0);
        for (const frame of buffered) if (!this.forwardSttFrame(frame)) break;
        logger.info("[voice-session] Ink transport connected", {
          sessionId: this.sessionId,
          traceId: this.currentTraceId,
          generation,
          reconnectAttempts,
          releasedPendingFrames: buffered.length,
        });
        break;
      }
      case "start-of-turn": {
        // Speech-start alone is not enough to cancel playback: phone echo and
        // line noise can trigger Ink before it has recognized any caller words.
        // Wait for a transcript update/final below, then interrupt immediately.
        this.resetSttPartialDelivery();
        this.activeSttTurn = true;
        this.sttTurnStartedAtMs = this.now();
        this.sttFirstTranscriptAtMs = null;
        this.sttLastTranscriptAtMs = null;
        this.sttEagerEndAtMs = null;
        this.sttTurnEchoOnly = false;
        this.sttTurnDoubleTalkReported = false;
        this.state = "transcribing";
        break;
      }
      case "transcript-update": {
        if (this.activeSttTurn && event.transcript) {
          const transcriptAt = this.now();
          this.sttFirstTranscriptAtMs ??= transcriptAt;
          this.sttLastTranscriptAtMs = transcriptAt;
          if (this.interruptForConfirmedSpeech(event.transcript)) {
            this.queueSttPartial(event.transcript);
          }
        }
        break;
      }
      case "eager-end-of-turn": {
        this.sttEagerEndAtMs = this.now();
        if (event.transcript) {
          this.sttFirstTranscriptAtMs ??= this.sttEagerEndAtMs;
          this.sttLastTranscriptAtMs = this.sttEagerEndAtMs;
        }
        this.interruptForConfirmedSpeech(event.transcript);
        if (this.sttTurnEchoOnly) break;
        this.flushSttPartial();
        this.send({
          t: "stt_eager_eot",
          traceId: this.currentTraceId ?? this.mintTraceId("turn"),
        });
        break;
      }
      case "end-of-turn": {
        if (!this.activeSttTurn) return;
        const finalizedAt = this.now();
        if (event.transcript) {
          this.sttFirstTranscriptAtMs ??= finalizedAt;
          this.sttLastTranscriptAtMs ??= finalizedAt;
        }
        logger.info("[voice-session] end-of-turn latency", {
          traceId: this.currentTraceId,
          transcriptChars: event.transcript?.length ?? 0,
          callerResponseTurnIndex: event.transcript?.trim()
            ? this.callerResponseTurnCount + 1
            : null,
          isFirstCallerResponse: event.transcript?.trim()
            ? this.callerResponseTurnCount === 0
            : null,
          configuredEndTimeoutMs: CARTESIA_INK_TURN_END_TIMEOUT_MILLISECONDS,
          turnActiveMs:
            this.sttTurnStartedAtMs === null
              ? null
              : finalizedAt - this.sttTurnStartedAtMs,
          firstTranscriptOffsetMs:
            this.sttTurnStartedAtMs === null ||
            this.sttFirstTranscriptAtMs === null
              ? null
              : this.sttFirstTranscriptAtMs - this.sttTurnStartedAtMs,
          lastTranscriptToFinalMs:
            this.sttLastTranscriptAtMs === null
              ? null
              : finalizedAt - this.sttLastTranscriptAtMs,
          eagerEndToFinalMs:
            this.sttEagerEndAtMs === null
              ? null
              : finalizedAt - this.sttEagerEndAtMs,
        });
        this.interruptForConfirmedSpeech(event.transcript);
        if (this.sttTurnEchoOnly) {
          this.activeSttTurn = false;
          this.resetSttPartialDelivery();
          break;
        }
        this.activeSttTurn = false;
        this.resetSttPartialDelivery();
        // A missing transcript commits as "" on purpose: commitTurn's empty-
        // final path still reports+resets the turn's metered usage and clears
        // the turn id, which skipping the commit would leak into the next turn.
        this.commitTurn(event.transcript ?? "");
        break;
      }
      case "turn-resumed": {
        // The user kept talking; the eager EOT was speculative. Stay listening.
        this.sttEagerEndAtMs = null;
        break;
      }
      case "error": {
        // Provider/protocol failures are explicit and terminate the current
        // turn; malformed input must not be reinterpreted as speech.
        this.activeSttTurn = false;
        this.resetSttPartialDelivery();
        logger.warn("[voice-session] Ink transport error", {
          sessionId: this.sessionId,
          traceId: this.currentTraceId,
          generation,
          code: event.code,
          errorClass:
            event.cause instanceof Error
              ? event.cause.name
              : typeof event.cause,
          messageLength: event.message.length,
        });
        if (event.code === "transport_error") {
          this.send({ t: "error", code: event.code, retryable: true });
          this.recoverSttTransport("transport_error", generation);
          break;
        }
        this.send({ t: "error", code: event.code, retryable: false });
        break;
      }
      case "close": {
        logger.warn("[voice-session] Ink transport closed", {
          sessionId: this.sessionId,
          traceId: this.currentTraceId,
          generation,
          code: event.code,
          wasClean: event.wasClean,
          reasonLength: event.reason.length,
        });
        this.send({ t: "error", code: "stt_reconnecting", retryable: true });
        this.recoverSttTransport(`close:${event.code}`, generation);
        break;
      }
    }
  }

  /**
   * Replace a failed Ink socket while preserving the authenticated call.
   *
   * The generation fence makes the old socket's recursive close callback a
   * no-op. Any incomplete transcript is discarded because a new recognizer
   * cannot safely resume provider turn state; newly metered audio remains in
   * the bounded provider queue until the replacement emits `connected`.
   */
  private recoverSttTransport(reason: string, generation: number): void {
    if (this.closed || generation !== this.sttGeneration) return;
    this.clearSttConnectTimeout();
    const failed = this.stt;
    this.stt = null;
    this.sttReady = false;
    this.activeSttTurn = false;
    this.resetSttPartialDelivery();
    this.sttGeneration += 1;
    if (failed) {
      try {
        failed.cancel(`recover:${reason}`);
      } catch {
        // error-policy:J6 best-effort teardown of the failed recognizer; the
        // generation fence already prevents it from reaching session state.
      }
    }
    this.scheduleSttReconnect(reason);
  }

  private clearSttConnectTimeout(): void {
    if (this.sttConnectTimer === null) return;
    clearTimeout(this.sttConnectTimer);
    this.sttConnectTimer = null;
  }

  private scheduleSttReconnect(reason: string): void {
    if (this.closed || this.sttReconnectTimer !== null) return;
    const delays = this.config.sttReconnectDelaysMs ?? STT_RECONNECT_DELAYS_MS;
    const scheduledDelay = delays[this.sttReconnectAttempts];
    const delay = scheduledDelay ?? Math.max(delays.at(-1) ?? 5_000, 1_000);
    const retryingAtCap = scheduledDelay === undefined;
    this.sttReconnectAttempts += 1;
    logger.info("[voice-session] Ink reconnect scheduled", {
      sessionId: this.sessionId,
      traceId: this.currentTraceId,
      reason,
      attempt: this.sttReconnectAttempts,
      delayMs: delay,
    });
    if (retryingAtCap) {
      logger.warn(
        "[voice-session] Ink reconnect continuing at capped backoff",
        {
          sessionId: this.sessionId,
          reason,
          attempts: this.sttReconnectAttempts,
          delayMs: delay,
        },
      );
    }
    this.sttReconnectTimer = setTimeout(() => {
      this.sttReconnectTimer = null;
      if (this.closed) return;
      try {
        this.openSttSession();
      } catch (error) {
        // error-policy:J4 a replacement transport that cannot be constructed
        // stays visibly retrying, then fails the call closed at the bound.
        logger.warn("[voice-session] Ink reconnect failed", {
          sessionId: this.sessionId,
          reason,
          attempt: this.sttReconnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleSttReconnect(reason);
      }
    }, delay);
  }

  /** Cancel an active response only after Ink has produced caller words. */
  private interruptForConfirmedSpeech(transcript: string): boolean {
    if (!SPOKEN_TRANSCRIPT_RE.test(transcript)) return false;
    if (this.continuousHandoffEnabled && this.currentVoiceTurnId) {
      if (
        this.assistantPlaybackActive &&
        isLikelyAssistantEcho(transcript, this.assistantReferenceText)
      ) {
        if (!this.sttTurnEchoOnly) {
          this.sttTurnEchoOnly = true;
          this.send({
            t: "echo_rejected",
            traceId: this.currentVoiceTurnId,
          });
        }
        return false;
      }
      this.sttTurnEchoOnly = false;
      if (this.assistantPlaybackActive && !this.sttTurnDoubleTalkReported) {
        this.sttTurnDoubleTalkReported = true;
        this.send({
          t: "human_double_talk",
          traceId: this.currentVoiceTurnId,
        });
      }
      this.state = "transcribing";
      return true;
    }
    if (this.currentVoiceTurnId) this.interrupt("acoustic");
    else this.config.downlink.clearAudio?.();
    this.state = "transcribing";
    return true;
  }

  /**
   * Ink can revise an interim transcript faster than a display can paint. Keep
   * the first revision immediate, retain only the newest pending revision, and
   * flush at a stable caption cadence. The final frame remains authoritative
   * and bypasses this path entirely.
   */
  private queueSttPartial(text: string): void {
    if (
      text === this.pendingSttPartial?.text ||
      (this.pendingSttPartial === null && text === this.lastSttPartialText)
    ) {
      return;
    }

    this.pendingSttPartial = {
      text,
      traceId: this.currentTraceId ?? this.mintTraceId("turn"),
    };
    const elapsedMs = this.now() - this.lastSttPartialSentAtMs;
    if (elapsedMs >= STT_PARTIAL_EMIT_INTERVAL_MS) {
      this.flushSttPartial();
      return;
    }

    if (this.sttPartialTimer !== null) return;
    this.sttPartialTimer = setTimeout(() => {
      this.sttPartialTimer = null;
      this.flushSttPartial();
    }, STT_PARTIAL_EMIT_INTERVAL_MS - elapsedMs);
  }

  private flushSttPartial(): void {
    if (this.sttPartialTimer !== null) {
      clearTimeout(this.sttPartialTimer);
      this.sttPartialTimer = null;
    }
    const partial = this.pendingSttPartial;
    this.pendingSttPartial = null;
    if (!partial || this.closed || partial.text === this.lastSttPartialText) {
      return;
    }
    this.lastSttPartialText = partial.text;
    this.lastSttPartialSentAtMs = this.now();
    this.send({ t: "stt_partial", ...partial });
  }

  private resetSttPartialDelivery(): void {
    if (this.sttPartialTimer !== null) {
      clearTimeout(this.sttPartialTimer);
      this.sttPartialTimer = null;
    }
    this.pendingSttPartial = null;
    this.lastSttPartialText = "";
    this.lastSttPartialSentAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Authoritative user turn: mint the turn trace, run the LLM+TTS legs. */
  private commitTurn(transcript: string): void {
    if (
      this.continuousHandoffEnabled &&
      (this.currentVoiceTurnId || this.pendingOverlapTurn) &&
      transcript.trim() !== ""
    ) {
      this.startOverlapTurn(transcript.trim());
      return;
    }
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    this.currentVoiceTurnId = traceId;
    // turnSttMs already holds the STT duration metered while this utterance's
    // audio was flowing (admission + ongoing windows); do NOT reset it or the
    // usage frame would under-report the duration the quota store was charged.
    this.turnTtsChars = 0;
    this.firstLlmTextEmitted = false;

    this.send({ t: "stt_final", text: transcript, traceId });

    if (transcript.trim() === "") {
      // Empty final (silence/noise): no TTS turn. Close it out like any other
      // turn — report + reset usage and CLEAR the turn id — so its metered STT
      // ms don't bleed into the next utterance and a stray barge_in can't emit
      // an `interrupted` for a turn that isn't really active.
      this.finishTurn(traceId);
      return;
    }

    this.state = "thinking";
    this.callerResponseTurnCount += 1;
    this.activeResponseModelSettled = this.runResponseTurn(
      transcript,
      traceId,
      {
        callerResponseTurnIndex: this.callerResponseTurnCount,
      },
    ).then(
      () => undefined,
      // error-policy:J5 runResponseTurn reports failures through voice error
      // frames; the sequencing barrier must still release the next request.
      () => undefined,
    );
  }

  private startOverlapTurn(transcript: string): void {
    const traceId = this.mintTraceId("turn");
    const abort = new AbortController();
    const pending = {
      traceId,
      transcript,
      uiContext: { ...this.uiContext },
      abort,
      replyText: null,
      handoffRequested: false,
    };
    this.overlapRequests.add(abort);
    this.pendingOverlapTurn = pending;
    this.send({ t: "stt_final", text: transcript, traceId });
    this.send({ t: "user_eos", traceId });
    const previousResponse = this.activeResponseModelSettled;
    this.activeResponseModelSettled = this.prepareOverlapReply(
      pending,
      previousResponse,
    );
  }

  private async prepareOverlapReply(
    pending: NonNullable<VoiceSession["pendingOverlapTurn"]>,
    previousResponse: Promise<void>,
  ): Promise<void> {
    let replyText = "";
    let firstText = false;
    try {
      // The existing response may still be streaming model output even though
      // its first TTS audio is already audible. Serializing this boundary keeps
      // canonical conversation writes ordered while still allowing the next
      // model request to overlap the remainder of old audio playback. Every
      // finalized utterance reaches canonical history, even when a newer
      // utterance has taken ownership of the next audible reply.
      await previousResponse;
      if (pending.abort.signal.aborted || this.closed) {
        return;
      }
      const result = await streamElizaConversation(
        {
          endpoint: this.config.elizaEndpoint,
          authorization: this.config.elizaAuthorization,
          model: this.config.elizaModel,
          transcript: pending.transcript,
          uiContext: pending.uiContext,
          agentId: this.config.agentId,
          conversationId: this.config.conversationId,
          organizationId: this.config.organizationId,
          userId: this.config.userId,
          traceId: pending.traceId,
          signal: pending.abort.signal,
          fetchImpl: this.config.fetchImpl,
        },
        (delta) => {
          if (
            pending.abort.signal.aborted ||
            this.pendingOverlapTurn !== pending
          )
            return;
          replyText += delta;
          if (!firstText && SPOKEN_TRANSCRIPT_RE.test(delta)) {
            firstText = true;
            this.send({ t: "llm_first_text", traceId: pending.traceId });
          }
        },
      );
      if (
        result.aborted ||
        pending.abort.signal.aborted ||
        this.pendingOverlapTurn !== pending
      )
        return;
      const speakable = replyText.trim();
      if (!SPOKEN_TRANSCRIPT_RE.test(speakable)) {
        this.send({
          t: "error",
          code: "unspeakable_llm_reply",
          retryable: true,
        });
        this.pendingOverlapTurn = null;
        return;
      }
      pending.replyText = speakable;
      pending.viewHandoff = result.viewHandoff;
      this.send({ t: "next_reply_ready", traceId: pending.traceId });
      if (!this.currentVoiceTurnId) this.beginPreparedOverlapHandoff();
    } catch (error) {
      // error-policy:J1 Report a failed overlap at the voice transport boundary.
      if (pending.abort.signal.aborted || this.closed) return;
      logger.warn("[voice-session] overlapping response preparation failed", {
        traceId: pending.traceId,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      if (this.pendingOverlapTurn === pending) this.pendingOverlapTurn = null;
      this.send({ t: "error", code: "llm_error", retryable: true });
    } finally {
      this.overlapRequests.delete(pending.abort);
    }
  }

  private beginPreparedOverlapHandoff(): void {
    const pending = this.pendingOverlapTurn;
    if (!pending?.replyText || pending.handoffRequested || this.closed) return;
    pending.handoffRequested = true;
    const fromTraceId = this.currentVoiceTurnId;
    if (fromTraceId) {
      this.send({
        t: "handoff_requested",
        fromTraceId,
        toTraceId: pending.traceId,
        crossfadeMs: 80,
        traceId: pending.traceId,
      });
      this.finishCurrentTurnForHandoff(fromTraceId);
    }
    this.pendingOverlapTurn = null;
    this.speakPreparedOverlapReply(pending, fromTraceId);
  }

  private finishCurrentTurnForHandoff(traceId: string): void {
    if (this.currentVoiceTurnId !== traceId) return;
    this.clearAssistantPlaybackSuppression();
    this.emitTurnMetrics(traceId, "interrupted");
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.currentVoiceTurnId = null;
    this.llmAbort?.abort();
    this.llmAbort = null;
    this.phrase = null;
    this.ttsStream?.cancel("phrase_handoff");
    this.ttsStream = null;
    this.turnSttMs = 0;
    this.turnTtsChars = 0;
  }

  private speakPreparedOverlapReply(
    pending: NonNullable<VoiceSession["pendingOverlapTurn"]>,
    fromTraceId: string | null,
  ): void {
    const text = pending.replyText;
    if (!text || this.closed) return;
    const traceId = pending.traceId;
    this.currentTraceId = traceId;
    this.currentVoiceTurnId = traceId;
    this.turnTtsChars = text.length;
    this.assistantReferenceText = text;
    if (pending.viewHandoff) {
      this.send({
        t: "navigate_view",
        ...pending.viewHandoff,
        traceId,
      });
    }
    const stream = this.createTtsStream(traceId, {
      onFirstAudio: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.armAssistantPlaybackSuppression();
        this.state = "speaking";
        this.send({ t: "speaking_start", traceId });
        this.send({ t: "assistant_playing", active: true, traceId });
        if (fromTraceId) {
          this.send({
            t: "handoff_completed",
            fromTraceId,
            toTraceId: traceId,
            traceId,
          });
        }
      },
      onAudioFrame: (frame) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.noteAssistantPlaybackAudio(frame.bytes.byteLength);
        this.config.downlink.sendAudio(frame.bytes);
      },
      onComplete: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.send({ t: "assistant_playing", active: false, traceId });
        this.send({ t: "speaking_end", traceId });
        this.finishTurn(traceId);
      },
      onFlushComplete: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.beginPreparedOverlapHandoff();
      },
      onProviderError: (error) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.send({
          t: "error",
          code: error.code ?? "tts_error",
          retryable: true,
        });
        this.finishTurn(traceId, "error");
      },
    });
    this.ttsStream = stream;
    const aggregator = new PhraseAggregator({
      minEmitChars: 1,
      preferWordBoundaryAtMax: true,
    });
    const phrases = aggregator.push(text);
    const tail = aggregator.flush();
    if (tail !== null) phrases.push(tail);
    for (const [index, phrase] of phrases.entries()) {
      const continues = index < phrases.length - 1;
      stream.sendPhrase({
        text: phrase,
        continueContext: continues,
        ...(continues ? { flush: true } : {}),
      });
    }
  }

  /** Speak a fixed live opener while the first agent context is warming. */
  private speakOpeningGreeting(text: string): void {
    if (this.closed || this.currentVoiceTurnId) return;
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    this.currentVoiceTurnId = traceId;
    this.turnTtsChars = text.length;
    this.firstLlmTextEmitted = false;
    this.assistantReferenceText = text;
    const greetingStartedAt = this.now();
    let ttsOpenedAt: number | null = null;

    const stream = this.createTtsStream(traceId, {
      onFirstAudio: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.armAssistantPlaybackSuppression();
        const firstAudioAt = this.now();
        logger.info("[voice-session] opening greeting latency", {
          traceId,
          greetingChars: text.length,
          firstAudioMs: firstAudioAt - greetingStartedAt,
          ttsTransportReadyMs:
            ttsOpenedAt === null ? null : ttsOpenedAt - greetingStartedAt,
          ttsSynthesisAfterReadyMs:
            ttsOpenedAt === null ? null : firstAudioAt - ttsOpenedAt,
          ...this.prewarmTimingFields(firstAudioAt),
        });
        this.state = "speaking";
        this.send({ t: "speaking_start", traceId });
        this.send({ t: "assistant_playing", active: true, traceId });
      },
      onAudioFrame: (frame) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.noteAssistantPlaybackAudio(frame.bytes.byteLength);
        this.config.downlink.sendAudio(frame.bytes);
      },
      onComplete: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.send({ t: "assistant_playing", active: false, traceId });
        this.send({ t: "speaking_end", traceId });
        this.finishTurn(traceId);
      },
      onProviderError: (error) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.clearAssistantPlaybackSuppression();
        this.send({
          t: "error",
          code: error.code ?? "tts_error",
          retryable: true,
        });
        this.finishTurn(traceId);
      },
    });
    this.ttsStream = stream;
    void stream.opened
      .then(() => {
        ttsOpenedAt = this.now();
      })
      .catch(() => undefined);
    stream.sendPhrase({ text, continueContext: false });
  }

  private prewarmTimingFields(atMs: number): {
    prewarmStatus: "not_configured" | "pending" | "success" | "error";
    prewarmStartedOffsetMs: number | null;
    prewarmDurationMs: number | null;
    prewarmCompletedBeforeEventMs: number | null;
  } {
    return {
      prewarmStatus: this.prewarmStatus,
      prewarmStartedOffsetMs:
        this.startedAtMs === null || this.prewarmStartedAtMs === null
          ? null
          : this.prewarmStartedAtMs - this.startedAtMs,
      prewarmDurationMs:
        this.prewarmStartedAtMs === null || this.prewarmCompletedAtMs === null
          ? null
          : this.prewarmCompletedAtMs - this.prewarmStartedAtMs,
      prewarmCompletedBeforeEventMs:
        this.prewarmCompletedAtMs === null
          ? null
          : atMs - this.prewarmCompletedAtMs,
    };
  }

  /**
   * A cold-turn 503 normally sleeps before retrying. If the session prewarm
   * lands sooner, retry immediately; the normal hot request never waits for
   * this latency-only hint, and the delay remains the upper bound.
   */
  private waitForRetryDelayOrPrewarm(
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const pendingPrewarm = this.prewarmPromise;
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", settle);
        resolve();
      };
      const timeout = setTimeout(settle, delayMs);
      signal.addEventListener("abort", settle, { once: true });
      if (
        !this.prewarmRetryWakeConsumed &&
        (pendingPrewarm || this.prewarmCompletedAtMs !== null)
      ) {
        this.prewarmRetryWakeConsumed = true;
        if (pendingPrewarm) void pendingPrewarm.then(settle);
        else queueMicrotask(settle);
      }
    });
  }

  private createTtsStream(
    traceId: string,
    callbacks: RealtimeTtsStreamCallbacks,
  ): RealtimeTtsStream {
    const createCartesia = () =>
      this.cartesiaAdapter.createStream(
        { traceId, maxBufferDelayMs: VOICE_TTS_MAX_BUFFER_DELAY_MS },
        callbacks,
      );
    if (!this.fishAudioAdapter) return createCartesia();
    return new FishPrimaryRealtimeTtsStream({
      traceId,
      fishAudioAdapter: this.fishAudioAdapter,
      createCartesia,
      callbacks,
    });
  }

  private async runResponseTurn(
    transcript: string,
    traceId: string,
    options: {
      messageRole?: "system";
      clientMessageId?: string;
      historyCutoffAt?: number;
      transientInput?: true;
      fallbackGreeting?: string;
      callerResponseTurnIndex?: number;
    } = {},
  ): Promise<void> {
    const responseStartedAt = this.now();
    const uiContext = { ...this.uiContext };
    this.assistantReferenceText = "";
    this.beginTurnMetrics(traceId, responseStartedAt);
    let firstModelTextAt: number | null = null;
    const upstreamAttempts: Array<{
      attempt: number;
      status: number;
      attemptHeadersMs: number;
      turnHeadersOffsetMs: number;
    }> = [];
    let upstreamAttemptCount = 0;
    let activeUpstreamAttempt = 0;
    let upstreamSuccessfulHeadersOffsetMs: number | null = null;
    let modelAudioStarted = false;
    let upstreamServerTiming: ElizaServerTimingReceipt | null = null;
    let ttsTransportReadyAt: number | null = null;
    let modelOutputChars = 0;
    let modelSpeakableContentSeen = false;
    let upstreamComplete = false;
    let ttsPlaybackComplete = false;
    const abort = new AbortController();
    this.llmAbort = abort;
    const phrase = new PhraseAggregator({ preferWordBoundaryAtMax: true });
    this.phrase = phrase;
    let initialReplyBuffer = "";
    let streamingReplyStarted = false;

    let tts: RealtimeTtsStream | null = null;
    // Cartesia requires a non-empty terminal request carrying continue:false.
    // Keep one complete phrase pending so the final word is never synthesized
    // as a detached request with different cadence or prosody.
    let pendingPhrase: string | null = null;
    const ensureTts = (): RealtimeTtsStream => {
      if (tts) return tts;
      const callbacks: RealtimeTtsStreamCallbacks = {
        onFirstAudio: () => {
          if (this.currentVoiceTurnId !== traceId) return;
          this.armAssistantPlaybackSuppression();
          modelAudioStarted = true;
          const firstAudioAt = this.now();
          logger.info("[voice-session] first-turn latency", {
            traceId,
            transcriptChars: transcript.length,
            callerResponseTurnIndex: options.callerResponseTurnIndex ?? null,
            isFirstCallerResponse: options.callerResponseTurnIndex === 1,
            firstModelTextMs:
              firstModelTextAt === null
                ? null
                : firstModelTextAt - responseStartedAt,
            firstAudioMs: firstAudioAt - responseStartedAt,
            ttsAfterFirstTextMs:
              firstModelTextAt === null
                ? null
                : firstAudioAt - firstModelTextAt,
            ttsTransportReadyMs:
              ttsTransportReadyAt === null
                ? null
                : ttsTransportReadyAt - responseStartedAt,
            ttsSynthesisAfterReadyMs:
              ttsTransportReadyAt === null
                ? null
                : firstAudioAt - ttsTransportReadyAt,
            upstreamAttemptCount,
            upstreamAttempts,
            upstreamSuccessfulHeadersOffsetMs,
            upstreamServerTiming,
            ...this.prewarmTimingFields(firstAudioAt),
          });
          this.state = "speaking";
          this.send({ t: "speaking_start", traceId });
          this.send({ t: "assistant_playing", active: true, traceId });
        },
        onAudioFrame: (frame) => {
          // Guard: no post-cancel / stale-turn frames ever reach the client.
          if (this.currentVoiceTurnId !== traceId) return;
          this.noteAudioFrame(traceId, frame.bytes.byteLength);
          this.noteAssistantPlaybackAudio(frame.bytes.byteLength);
          this.config.downlink.sendAudio(frame.bytes);
        },
        onComplete: () => {
          if (this.currentVoiceTurnId !== traceId) return;
          ttsPlaybackComplete = true;
          this.send({ t: "assistant_playing", active: false, traceId });
          this.send({ t: "speaking_end", traceId });
          // Long replies and the early reply-ready path can finish playback
          // while the canonical route is still persisting its durable receipt.
          // Keep the turn alive until terminal metadata arrives so a successful
          // VIEWS action still reaches the client after speech has ended.
          if (upstreamComplete) this.finishTurn(traceId);
        },
        onFlushComplete: () => {
          if (this.currentVoiceTurnId !== traceId) return;
          this.beginPreparedOverlapHandoff();
        },
        onProviderError: (err) => {
          if (this.currentVoiceTurnId !== traceId) return;
          this.clearAssistantPlaybackSuppression();
          this.send({
            t: "error",
            code: err.code ?? "tts_error",
            retryable: true,
          });
          // Prewarming means TTS can fail while the LLM is still generating.
          // Abort that upstream work before finishTurn clears the controller,
          // otherwise a failed voice turn can keep consuming model resources.
          abort.abort();
          // Close out the failed turn so the client gets usage + returns to
          // listening, instead of the session being stuck on a dead turn.
          this.finishTurn(traceId, "error");
        },
      };
      tts = this.createTtsStream(traceId, callbacks);
      this.ttsStream = tts;
      return tts;
    };
    const sendTtsPhrase = (
      stream: RealtimeTtsStream,
      input: RealtimeTtsPhraseInput,
    ): void => {
      this.noteSonicRequest(traceId, ttsTransportReadyAt !== null);
      stream.sendPhrase(input);
    };
    const queueStreamingPhrases = (phrases: readonly string[]): void => {
      for (const p of phrases) {
        if (!SPOKEN_TRANSCRIPT_RE.test(p)) continue;
        this.turnTtsChars += p.length;
        const stream = ensureTts();
        if (pendingPhrase !== null) {
          sendTtsPhrase(stream, {
            text: pendingPhrase,
            continueContext: true,
            flush: true,
          });
        }
        pendingPhrase = p;
      }
    };
    let ttsReplyFinalized = false;
    const finalizeTtsReply = (): void => {
      if (ttsReplyFinalized) return;
      ttsReplyFinalized = true;

      if (!streamingReplyStarted) {
        const completeShortReply = initialReplyBuffer.trim();
        initialReplyBuffer = "";
        if (SPOKEN_TRANSCRIPT_RE.test(completeShortReply)) {
          this.turnTtsChars += completeShortReply.length;
          sendTtsPhrase(ensureTts(), {
            text: completeShortReply,
            continueContext: false,
          });
          return;
        }
      }

      const tail = phrase.flush();
      if (tail && SPOKEN_TRANSCRIPT_RE.test(tail)) {
        // A trailing phrase remains. Flush any held phrase (continue:true), then
        // send the tail as the terminal phrase with continue:false.
        if (pendingPhrase !== null) {
          sendTtsPhrase(ensureTts(), {
            text: pendingPhrase,
            continueContext: true,
            flush: true,
          });
          pendingPhrase = null;
        }
        this.turnTtsChars += tail.length;
        sendTtsPhrase(ensureTts(), {
          text: tail,
          continueContext: false,
        });
      } else if (pendingPhrase !== null) {
        // The held phrase is the LAST speakable unit: send it with
        // continue:false to close the context cleanly (yields `done` ->
        // onComplete). Cartesia rejects an empty-transcript finish request.
        sendTtsPhrase(ensureTts(), {
          text: pendingPhrase,
          continueContext: false,
        });
        pendingPhrase = null;
      }
    };

    try {
      // Open Cartesia in parallel with the LLM request. Previously the provider
      // WebSocket was created lazily only after a complete speakable phrase had
      // arrived, putting its DNS/TLS/WebSocket handshake directly on the
      // first-audio critical path. A turn that is interrupted or produces no
      // speakable output cancels this idle context below.
      const prewarmedTts = ensureTts();
      // Cancellation before the provider's open event rejects `opened`. This
      // turn does not await readiness because outbound phrases queue in the
      // adapter, so consume that designed rejection on fast teardown.
      void prewarmedTts.opened
        .then(() => {
          ttsTransportReadyAt = this.now();
        })
        .catch(() => undefined);

      const request = {
        endpoint: this.config.elizaEndpoint,
        authorization: this.config.elizaAuthorization,
        model: this.config.elizaModel,
        transcript,
        uiContext,
        ...(options.messageRole ? { messageRole: options.messageRole } : {}),
        ...(options.clientMessageId
          ? { clientMessageId: options.clientMessageId }
          : {}),
        ...(options.historyCutoffAt !== undefined
          ? { historyCutoffAt: options.historyCutoffAt }
          : {}),
        ...(options.transientInput ? { transientInput: true as const } : {}),
        agentId: this.config.agentId,
        conversationId: this.config.conversationId,
        organizationId: this.config.organizationId,
        userId: this.config.userId,
        traceId,
        signal: abort.signal,
        fetchImpl: this.config.fetchImpl,
        onResponseHeaders: (headers: ElizaSseBridgeResponseHeaders) => {
          const turnHeadersOffsetMs = this.now() - responseStartedAt;
          upstreamAttemptCount += 1;
          if (upstreamAttempts.length < MAX_RECORDED_UPSTREAM_ATTEMPTS) {
            upstreamAttempts.push({
              attempt: activeUpstreamAttempt,
              status: headers.status,
              attemptHeadersMs: headers.elapsedMs,
              turnHeadersOffsetMs,
            });
          }
          if (headers.status >= 200 && headers.status < 300) {
            upstreamSuccessfulHeadersOffsetMs = turnHeadersOffsetMs;
            upstreamServerTiming = headers.serverTiming;
          }
          logger.info("[voice-session] Eliza response headers", {
            traceId,
            attempt: activeUpstreamAttempt,
            status: headers.status,
            attemptHeadersMs: headers.elapsedMs,
            turnHeadersOffsetMs,
            serverTiming: headers.serverTiming,
          });
        },
        onProgress: (text: string) => {
          if (this.currentVoiceTurnId !== traceId || abort.signal.aborted)
            return;
          // Progress cues are deliberately non-authoritative: they keep a slow
          // action audible without entering the reply buffer or being persisted
          // as an assistant answer. The next authoritative delta continues the
          // same TTS context and normal terminal cleanup closes it.
          const stream = ensureTts();
          if (pendingPhrase !== null) {
            sendTtsPhrase(stream, {
              text: pendingPhrase,
              continueContext: true,
            });
            pendingPhrase = null;
          }
          sendTtsPhrase(stream, { text, continueContext: true });
          logger.info("[voice-session] action progress cue", {
            traceId,
            elapsedMs: this.now() - responseStartedAt,
          });
        },
        onReplyReady: finalizeTtsReply,
      };
      const onDelta = (delta: string) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.noteLlmDelta(traceId);
        modelOutputChars += delta.length;
        this.assistantReferenceText += delta;
        if (SPOKEN_TRANSCRIPT_RE.test(delta)) {
          modelSpeakableContentSeen = true;
        }
        if (!this.firstLlmTextEmitted) {
          this.firstLlmTextEmitted = true;
          firstModelTextAt = this.now();
          this.send({ t: "llm_first_text", traceId });
        }
        // Typical short answers sound best as one coherent terminal request.
        // Once a reply is long enough to contain a useful complete sentence,
        // hand it to the canonical phrase policy without waiting for the
        // runtime's later terminal metadata.
        if (!streamingReplyStarted) {
          initialReplyBuffer += delta;
          if (initialReplyBuffer.length < VOICE_TTS_STREAMING_START_CHARS) {
            return;
          }
          streamingReplyStarted = true;
          const buffered = initialReplyBuffer;
          initialReplyBuffer = "";
          queueStreamingPhrases(phrase.push(buffered));
          return;
        }
        queueStreamingPhrases(phrase.push(delta));
      };
      const retryDelays =
        this.config.cacheWarmingRetryDelaysMs ?? CACHE_WARMING_RETRY_DELAYS_MS;
      let result: Awaited<ReturnType<typeof streamElizaConversation>>;
      for (let attempt = 0; ; attempt += 1) {
        activeUpstreamAttempt = attempt + 1;
        try {
          result = await streamElizaConversation(request, onDelta);
          break;
        } catch (error) {
          const bridgeError =
            error instanceof ElizaSseBridgeError ? error : undefined;
          const retryDelay = retryDelays[attempt];
          if (
            retryDelay === undefined ||
            !bridgeError?.retryable ||
            bridgeError.status !== 503 ||
            !bridgeError.upstreamCode ||
            !CACHE_WARMING_CODES.has(bridgeError.upstreamCode) ||
            abort.signal.aborted ||
            this.currentVoiceTurnId !== traceId
          ) {
            throw error;
          }
          logger.info("[voice-session] retrying cold response turn", {
            traceId,
            attempt,
            retryDelayMs: retryDelay,
            upstreamCode: bridgeError.upstreamCode,
            elapsedMs: this.now() - responseStartedAt,
          });
          await this.waitForRetryDelayOrPrewarm(retryDelay, abort.signal);
          if (abort.signal.aborted || this.currentVoiceTurnId !== traceId) {
            return;
          }
        }
      }

      if (this.currentVoiceTurnId !== traceId) return; // interrupted mid-stream.

      if (result.aborted) {
        // Interruption already handled the teardown of this turn's TTS.
        return;
      }

      if (result.viewHandoff) {
        this.send({
          t: "navigate_view",
          viewId: result.viewHandoff.viewId,
          ...(result.viewHandoff.viewPath
            ? { viewPath: result.viewHandoff.viewPath }
            : {}),
          ...(result.viewHandoff.subview
            ? { subview: result.viewHandoff.subview }
            : {}),
          traceId,
        });
      }
      upstreamComplete = true;
      finalizeTtsReply();
      if (ttsPlaybackComplete) {
        this.finishTurn(traceId);
        return;
      }
      if (!modelSpeakableContentSeen && this.turnTtsChars === 0) {
        // No speakable output at all (empty LLM reply). The socket was opened
        // speculatively to hide its handshake behind LLM generation, so cancel
        // the unused context before closing the turn. (Read via the class field:
        // `tts` is only assigned inside closures, so outer-flow narrowing would
        // otherwise collapse its type to never.)
        this.ttsStream?.cancel("empty_llm_reply");
        this.finishTurn(traceId);
        const fallbackGreeting = options.fallbackGreeting?.trim();
        if (fallbackGreeting) {
          this.speakOpeningGreeting(fallbackGreeting);
        } else if (modelOutputChars > 0 && !modelSpeakableContentSeen) {
          // error-policy:J4 punctuation-only or otherwise unspeakable model
          // output is an expected provider failure shape. Surface it as a
          // retryable error and speak an explicit recovery prompt so a live
          // caller never experiences a successful-looking silent turn.
          logger.warn("[voice-session] Eliza response was not speakable", {
            traceId,
            outputChars: modelOutputChars,
          });
          this.send({
            t: "error",
            code: "unspeakable_llm_reply",
            retryable: true,
          });
          this.speakOpeningGreeting(UNSPEAKABLE_RESPONSE_FALLBACK);
        }
      }
      // If a phrase was sent, its final continue:false closes the context.
    } catch (error) {
      // error-policy:J1 boundary translation — the LLM/TTS turn is the async
      // boundary; provider failures become a structured client `error` frame.
      if (this.currentVoiceTurnId !== traceId) return;
      const bridgeError =
        error instanceof ElizaSseBridgeError ? error : undefined;
      logger.warn("[voice-session] Eliza response turn failed", {
        traceId,
        code: bridgeError?.upstreamCode ?? bridgeError?.code,
        status: bridgeError?.status,
        message:
          bridgeError?.upstreamMessage ??
          (error instanceof Error ? error.message : String(error)),
      });
      this.send({
        t: "error",
        code: bridgeError
          ? (bridgeError.upstreamCode ?? bridgeError.code)
          : error instanceof Error
            ? error.name
            : "llm_error",
        retryable: bridgeError ? bridgeError.retryable : true,
        ...(bridgeError?.status ? { upstreamStatus: bridgeError.status } : {}),
        ...(bridgeError?.upstreamMessage
          ? { upstreamMessage: bridgeError.upstreamMessage }
          : {}),
        ...(bridgeError?.upstreamSnippet
          ? { upstreamSnippet: bridgeError.upstreamSnippet }
          : {}),
      });
      // The socket is already open because it was prewarmed before the LLM
      // request. Do not leak an idle provider connection when that request or
      // stream fails before a terminal TTS phrase is sent. finishTurn has not
      // run yet, so ttsStream still belongs to this turn.
      this.ttsStream?.cancel("llm_error");
      this.finishTurn(traceId, "error");
      const fallbackGreeting = options.fallbackGreeting?.trim();
      if (fallbackGreeting && !modelAudioStarted) {
        this.speakOpeningGreeting(fallbackGreeting);
      }
    }
  }

  private finishTurn(
    traceId: string,
    outcome: VoiceTurnMetricsReceipt["outcome"] = "completed",
  ): void {
    if (this.currentVoiceTurnId !== traceId || this.closed) return;
    this.settleAssistantPlaybackSuppression();
    this.emitTurnMetrics(traceId, outcome);
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.currentVoiceTurnId = null;
    this.llmAbort = null;
    this.phrase = null;
    this.ttsStream = null;
    // Reset per-utterance accumulators now that this turn's usage is reported;
    // the next utterance's STT metering starts fresh.
    this.turnSttMs = 0;
    this.turnTtsChars = 0;
    this.state = "listening";
    this.beginPreparedOverlapHandoff();
  }

  /**
   * Interruption coordinator (§7.5). Everything below happens under the single
   * current voiceTurnId and is synchronous up to the point of emitting
   * `interrupted`, so no post-cancel audio can leak to the client.
   */
  private interrupt(reason: "acoustic" | "explicit"): void {
    this.clearAssistantPlaybackSuppression();
    for (const abort of this.overlapRequests) abort.abort();
    this.overlapRequests.clear();
    this.pendingOverlapTurn = null;
    const traceId = this.currentVoiceTurnId;
    if (!traceId) return; // nothing speaking/thinking to interrupt.
    this.emitTurnMetrics(traceId, "interrupted");

    // 1. Invalidate the turn id FIRST so any in-flight adapter callback that
    //    races this path is dropped by the `currentVoiceTurnId` guard.
    this.currentVoiceTurnId = null;

    // 2. Cancel Cartesia — merged adapter guarantees no post-cancel frames.
    if (this.ttsStream) {
      this.ttsStream.cancel(`interrupted:${reason}`);
      this.ttsStream = null;
    }
    // 3. Abort the Eliza SSE fetch — cancels the upstream provider stream.
    if (this.llmAbort) {
      this.llmAbort.abort();
      this.llmAbort = null;
    }
    // 4. Drop pending phrase aggregation.
    if (this.phrase) {
      this.phrase.reset();
      this.phrase = null;
    }
    // 5. Report the interrupted turn's usage (STT accrued + TTS chars emitted so
    //    far) so the client sees accurate accounting, then reset the per-turn
    //    accumulators so this turn's duration is NOT carried into the next
    //    committed turn's usage frame.
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.turnSttMs = 0;
    this.turnTtsChars = 0;
    this.llmAbort = null;
    // 6. Emit interrupted and return to listening.
    this.state = "interrupted";
    this.send({ t: "interrupted", reason, traceId });
    this.state = "listening";
  }

  // --- metering (SEC-15) ----------------------------------------------------

  private accrueUplink(byteLength: number): void {
    // Pre-admission audio is accounted by the ADMISSION_MINUTES charge; ongoing
    // metering only runs once admitted so we never double-charge the first
    // window nor stream uncapped before admission.
    if (!this.meteringAdmitted) return;
    this.unmeteredUplinkBytes += byteLength;
    const seconds = Math.floor(
      this.unmeteredUplinkBytes / PCM16_BYTES_PER_SECOND,
    );
    if (seconds < METER_FLUSH_SECONDS) return;
    this.unmeteredUplinkBytes -= seconds * PCM16_BYTES_PER_SECOND;
    this.turnSttMs += seconds * 1000;
    this.meterWindowsInFlight += 1;
    void this.recordMeter(seconds / 60);
  }

  private async recordMeter(minutes: number): Promise<void> {
    if (minutes <= 0 || this.meteredExhausted || this.closed) {
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      return;
    }
    try {
      const decision = await this.config.usageStore.checkAndRecord(
        this.usageIdentity,
        minutes,
        this.config.usageLimits,
      );
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      if (!decision.allowed) {
        this.meteredExhausted = true;
        this.send({ t: "error", code: "quota_exhausted", retryable: false });
        this.teardown("quota_exhausted");
      }
    } catch (error) {
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      // error-policy:J4 fail-closed degrade — if we cannot record the cost, we
      // do not keep streaming uncapped paid audio to Cartesia; sever.
      logger.error("[voice-session] ongoing metering window failed", {
        sessionId: this.sessionId,
        traceId: this.currentTraceId,
        meterWindowsInFlight: this.meterWindowsInFlight,
        errorClass: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.meteredExhausted = true;
      this.send({ t: "error", code: "metering_unavailable", retryable: false });
      this.teardown("error");
    }
  }

  // --- teardown -------------------------------------------------------------

  private teardown(reason: VoiceSessionSeverReason): void {
    if (this.closed) return;
    this.clearAssistantPlaybackSuppression();
    this.closed = true;
    // Expiry/disconnect can bypass finishResponseTurn. Preserve the bounded
    // timing receipt before aborting callbacks, without labeling lost audio as
    // completed or recording transcript/audio payloads.
    if (this.turnMetrics) {
      this.emitTurnMetrics(this.turnMetrics.traceId, "interrupted");
    }
    for (const abort of this.overlapRequests) abort.abort();
    this.overlapRequests.clear();
    this.pendingOverlapTurn = null;
    this.state = "closed";
    logger.info("[voice-session] session closed", {
      sessionId: this.sessionId,
      traceId: this.currentTraceId,
      reason,
      durationMs:
        this.startedAtMs === null
          ? 0
          : Math.max(0, Math.round(this.now() - this.startedAtMs)),
    });

    // Revoke the bootstrap token's jti on end so a leaked/replayed token cannot
    // open a SECOND paid session within its remaining TTL (the WS endpoint is
    // public and re-verifies hello; without this, a stolen token stays usable
    // until natural expiry). Best-effort and non-blocking.
    if (this.config.onTeardownRevoke) {
      void this.config
        .onTeardownRevoke(this.jti, this.config.tokenExpSeconds)
        .catch(() => {
          // error-policy:J6 best-effort teardown — revoke-on-end is defense in
          // depth; the token still dies at its <=120s TTL.
        });
    }
    if (this.config.onTeardown) {
      void this.config.onTeardown(reason).catch((error) => {
        // error-policy:J6 session closure is already committed; the durable
        // lifecycle marker is idempotent and may be recovered by provider retry.
        logger.warn("[voice-session] lifecycle teardown persistence failed", {
          sessionId: this.sessionId,
          traceId: this.currentTraceId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Invalidate any live turn so racing callbacks are dropped.
    this.currentVoiceTurnId = null;
    this.resetSttPartialDelivery();
    this.sttGeneration += 1;
    if (this.sttReconnectTimer !== null) {
      clearTimeout(this.sttReconnectTimer);
      this.sttReconnectTimer = null;
    }
    this.clearSttConnectTimeout();

    if (this.ttsStream) {
      try {
        this.ttsStream.cancel(`session:${reason}`);
      } catch {
        // error-policy:J6 best-effort teardown — cancel on an already-dead
        // Cartesia stream must not abort the rest of teardown.
      }
      this.ttsStream = null;
    }
    // Context completion and barge-in keep the call-scoped Cartesia transport
    // warm. Session teardown is the sole owner of shared socket closure.
    this.cartesiaAdapter.close(`session:${reason}`);
    if (this.llmAbort) {
      this.llmAbort.abort();
      this.llmAbort = null;
    }
    if (this.stt) {
      try {
        this.stt.cancel(reason);
      } catch {
        // error-policy:J6 best-effort teardown — cancel on an already-closed
        // Ink socket must not abort the rest of teardown.
      }
      this.stt = null;
    }
    if (this.revocationPoll) {
      clearInterval(this.revocationPoll);
      this.revocationPoll = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.preAdmissionFrames.length = 0;
    this.reframer.flush();
    this.registry.unregister(this.sessionId);

    // Tell the client why, then close the transport. `completed`/`client_disconnect`
    // are not errors; everything else is an error the client should see.
    if (reason !== "completed" && reason !== "client_disconnect") {
      this.send({ t: "error", code: reason, retryable: reason === "error" });
    }
    this.config.downlink.close(1000, reason);
  }

  private send(frame: ServerControlFrame): void {
    if (this.closed && frame.t !== "error") return;
    this.config.downlink.sendControl(frame);
  }

  private mintTraceId(kind: "session" | "turn"): string {
    if (kind === "turn") this.turnCounter += 1;
    const seq = kind === "turn" ? this.turnCounter : 0;
    return `${this.sessionId}:${kind}:${seq}:${Math.floor(this.now())}`;
  }

  /** Test/observability accessor. */
  get currentState(): SessionState {
    return this.state;
  }
}

interface RealtimeTtsPhraseInput {
  readonly text: string;
  readonly continueContext: boolean;
  readonly flush?: boolean;
  readonly duration?: number;
  readonly maxBufferDelayMs?: number;
}

function normalizeVoiceWords(value: string): string[] {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Conservative residual-echo filter: never reject one- or two-word speech. */
function isLikelyAssistantEcho(
  transcript: string,
  assistantReference: string,
): boolean {
  const heard = normalizeVoiceWords(transcript);
  const reference = normalizeVoiceWords(assistantReference);
  if (heard.length < 3 || reference.length < heard.length) return false;
  for (let start = 0; start <= reference.length - heard.length; start += 1) {
    let matches = 0;
    for (let index = 0; index < heard.length; index += 1) {
      if (heard[index] === reference[start + index]) matches += 1;
    }
    if (matches / heard.length >= 0.85) return true;
  }
  return false;
}

interface RealtimeTtsStreamCallbacks {
  readonly onFirstAudio?: (event: { readonly elapsedMs: number }) => void;
  readonly onAudioFrame?: (event: { readonly bytes: Uint8Array }) => void;
  readonly onComplete?: (event: { readonly frameCount: number }) => void;
  readonly onProviderError?: (event: { readonly code?: string }) => void;
  readonly onFlushComplete?: (event: { readonly flushId?: number }) => void;
}

interface RealtimeTtsStream {
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  sendPhrase(phrase: RealtimeTtsPhraseInput): void;
  cancel(reason?: string): void;
}

/**
 * Fish is primary only until its first audio byte. The production realtime path
 * is `packages/cloud/api/v1/voice/session/lib/session.ts`: after Fish emits
 * audio, this wrapper never switches provider for that turn; before audio, a
 * connect error or first-audio timeout replays queued phrases to Cartesia.
 */
class FishPrimaryRealtimeTtsStream implements RealtimeTtsStream {
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  private active: RealtimeTtsStream;
  private readonly phrases: RealtimeTtsPhraseInput[] = [];
  private fishAudioProduced = false;
  private usingCartesia = false;
  private cancelled = false;
  private suppressFishFallback = false;
  private resolveOpened!: () => void;
  private rejectOpened!: (error: unknown) => void;
  private openedSettled = false;
  private resolveClosed!: () => void;

  constructor(
    private readonly input: {
      readonly traceId: string;
      readonly fishAudioAdapter: FishAudioTtsAdapter;
      readonly createCartesia: () => RealtimeTtsStream;
      readonly callbacks: RealtimeTtsStreamCallbacks;
    },
  ) {
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.active = this.input.fishAudioAdapter.createStream(
      { traceId: input.traceId },
      {
        onFirstAudio: (event) => {
          this.fishAudioProduced = true;
          this.phrases.length = 0;
          this.resolveOpenedOnce();
          this.input.callbacks.onFirstAudio?.(event);
        },
        onAudioFrame: (event) => this.input.callbacks.onAudioFrame?.(event),
        onComplete: (event) => this.input.callbacks.onComplete?.(event),
        onProviderError: (event) => this.handleFishProviderError(event.code),
      },
    );
    this.watchActiveClosed(this.active);
    void this.active.opened
      .then(() => this.resolveOpenedOnce())
      .catch((error) => {
        if (!this.usingCartesia) this.rejectOpenedOnce(error);
      });
  }

  sendPhrase(phrase: RealtimeTtsPhraseInput): void {
    if (!this.usingCartesia && !this.fishAudioProduced)
      this.phrases.push(phrase);
    this.active.sendPhrase(
      this.usingCartesia
        ? phrase
        : {
            ...phrase,
            // Fish buffers short text events until its generation threshold.
            // Flush every continuation phrase so the 24-character voice
            // aggregator remains genuinely realtime; the final stop flushes
            // the terminal phrase itself.
            flush: phrase.continueContext || phrase.flush,
          },
    );
  }

  cancel(reason?: string): void {
    this.cancelled = true;
    this.rejectOpenedOnce(
      new Error(`Fish TTS stream cancelled${reason ? `: ${reason}` : ""}`),
    );
    this.active.cancel(reason);
  }

  private handleFishProviderError(code?: string): void {
    if (this.cancelled || this.suppressFishFallback) return;
    if (this.fishAudioProduced || !isFishPreAudioFallbackError(code)) {
      this.input.callbacks.onProviderError?.({
        code: code ?? "fish_tts_error",
      });
      this.rejectOpenedOnce(new Error(code ?? "fish_tts_error"));
      return;
    }
    this.usingCartesia = true;
    this.suppressFishFallback = true;
    this.active.cancel(`fish_pre_audio_fallback:${code ?? "provider_error"}`);
    this.suppressFishFallback = false;
    this.active = this.input.createCartesia();
    this.watchActiveClosed(this.active);
    void this.active.opened
      .then(() => this.resolveOpenedOnce())
      .catch((error) => this.rejectOpenedOnce(error));
    for (const phrase of this.phrases) this.active.sendPhrase(phrase);
    this.phrases.length = 0;
  }

  private resolveOpenedOnce(): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.resolveOpened();
  }

  private rejectOpenedOnce(error: unknown): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.rejectOpened(error);
  }

  private watchActiveClosed(stream: RealtimeTtsStream): void {
    void stream.closed.then(() => {
      if (this.active === stream) this.resolveClosed();
    });
  }
}

function isFishPreAudioFallbackError(code: string | undefined): boolean {
  return (
    code === "websocket_error" ||
    code === "websocket_closed_before_open" ||
    code === "first_audio_timeout"
  );
}
