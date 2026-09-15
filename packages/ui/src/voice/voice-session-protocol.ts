/**
 * Voice realtime WebSocket session wire protocol (client mirror of the
 * server contract defined in VOICE-INTEGRATION-DECISION-2026-07-10.md section
 * 7.2). This module is transport-agnostic and side-effect free: it only
 * declares the JSON control frames and the small helpers that parse/serialize
 * them, so the framing/ordering logic is unit-testable without a real
 * WebSocket, AudioContext, or MediaStream.
 *
 * Binary frames = audio. Text frames = JSON control. The first frame after
 * connect MUST be a JSON `hello` from the client.
 *
 * Design rules honored here:
 *   - The auth token travels in the first `hello` frame, never a header
 *     (WebView 113 cannot set custom WS headers reliably).
 *   - Uplink default is pcm16 linear16 16 kHz mono (matches Deepgram Flux
 *     ingest with zero transcode); downlink default is pcm16 16 kHz mono
 *     (matches Cartesia pcm_s16le output).
 *   - Every server state event carries a `traceId`.
 */

/** Wire protocol version. Bumped only on breaking control-frame changes. */
import type { VoiceUiContext } from "@elizaos/shared";

export const VOICE_SESSION_PROTOCOL_VERSION = 1 as const;

/** Uplink/downlink codecs negotiated in `hello`. */
export type VoiceSessionCodec = "pcm16" | "opus";

/** Default uplink codec: linear16 mono 16 kHz, Deepgram Flux native ingest. */
export const DEFAULT_UPLINK_CODEC: VoiceSessionCodec = "pcm16";
/** Default downlink codec: pcm16 mono 16 kHz, Cartesia pcm_s16le native. */
export const DEFAULT_DOWNLINK_CODEC: VoiceSessionCodec = "pcm16";
/** Canonical sample rate for both directions of the default codec path. */
export const VOICE_SESSION_SAMPLE_RATE = 16_000 as const;

// ── Client -> server control frames ────────────────────────────────────

export interface ClientHelloFrame {
  t: "hello";
  token: string;
  protocol: number;
  uplinkCodec: VoiceSessionCodec;
  downlinkCodec: VoiceSessionCodec;
  sampleRate: number;
}

export interface ClientAudioMetaFrame {
  t: "audio_meta";
  seq: number;
  codec: VoiceSessionCodec;
  sampleRate: number;
  channels: number;
}

export interface ClientAudioCapabilitiesFrame {
  t: "audio_capabilities";
  mode: "continuous_handoff";
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  referenceAwarePlayback: boolean;
}

export interface ClientBargeInFrame {
  t: "barge_in";
}

export interface ClientByeFrame {
  t: "bye";
}

export type ClientControlFrame =
  | { t: "ui_context"; context: VoiceUiContext }
  | ClientHelloFrame
  | ClientAudioMetaFrame
  | ClientAudioCapabilitiesFrame
  | ClientBargeInFrame
  | ClientByeFrame;

// ── Server -> client control / state events ────────────────────────────

export interface ServerReadyEvent {
  t: "ready";
  uiContext?: boolean;
  sessionId: string;
  traceId: string;
}

export interface ServerSttPartialEvent {
  t: "stt_partial";
  text: string;
  traceId: string;
}

export interface ServerSttEagerEotEvent {
  t: "stt_eager_eot";
  traceId: string;
}

export interface ServerSttFinalEvent {
  t: "stt_final";
  text: string;
  traceId: string;
}

export interface ServerLlmFirstTextEvent {
  t: "llm_first_text";
  traceId: string;
}

export interface ServerSpeakingStartEvent {
  t: "speaking_start";
  traceId: string;
}

export interface ServerSpeakingEndEvent {
  t: "speaking_end";
  traceId: string;
}

export interface ServerAssistantPlayingEvent {
  t: "assistant_playing";
  active: boolean;
  traceId: string;
}

export interface ServerVoiceMetricEvent {
  t: "human_double_talk" | "echo_rejected" | "user_eos" | "next_reply_ready";
  traceId: string;
}

export interface ServerHandoffRequestedEvent {
  t: "handoff_requested";
  fromTraceId: string;
  toTraceId: string;
  crossfadeMs: number;
  traceId: string;
}

export interface ServerHandoffCompletedEvent {
  t: "handoff_completed";
  fromTraceId: string;
  toTraceId: string;
  traceId: string;
}

export interface ServerNavigateViewEvent {
  t: "navigate_view";
  viewId: string;
  viewPath?: string;
  subview?: string;
  traceId: string;
}

export type InterruptionReason = "acoustic" | "explicit";

export interface ServerInterruptedEvent {
  t: "interrupted";
  reason: InterruptionReason;
  traceId: string;
}

export interface ServerErrorEvent {
  t: "error";
  code: string;
  retryable: boolean;
  traceId?: string;
  /** Optional human-readable detail; never authoritative for control flow. */
  message?: string;
}

export interface ServerUsageEvent {
  t: "usage";
  sttMs?: number;
  ttsChars?: number;
  traceId: string;
}

export type ServerControlFrame =
  | ServerReadyEvent
  | ServerSttPartialEvent
  | ServerSttEagerEotEvent
  | ServerSttFinalEvent
  | ServerLlmFirstTextEvent
  | ServerSpeakingStartEvent
  | ServerSpeakingEndEvent
  | ServerAssistantPlayingEvent
  | ServerVoiceMetricEvent
  | ServerHandoffRequestedEvent
  | ServerHandoffCompletedEvent
  | ServerNavigateViewEvent
  | ServerInterruptedEvent
  | ServerErrorEvent
  | ServerUsageEvent;

export type ServerControlType = ServerControlFrame["t"];

// ── Mint (POST /api/v1/voice/session) response ─────────────────────────

export interface VoiceSessionMintRequest {
  agentId: string;
  conversationId: string;
  transport: "websocket";
}

export interface VoiceSessionCodecOffer {
  codecs: VoiceSessionCodec[];
}

export interface VoiceSessionMintResponse {
  sessionId: string;
  wsUrl: string;
  token: string;
  expiresAt: number | string;
  uplink: VoiceSessionCodecOffer;
  downlink: VoiceSessionCodecOffer;
  iceServers?: unknown | null;
}

// ── Serialization / parsing (pure) ─────────────────────────────────────

/** Serialize a client control frame to a JSON text-frame payload. */
export function encodeClientControl(frame: ClientControlFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a server text-frame payload into a typed control frame. Returns null
 * for anything that is not a recognized control frame (unknown `t`, malformed
 * JSON, non-object). Callers treat null as "ignore this frame", never throw,
 * so a single bad frame cannot kill a live session.
 */
export function parseServerControl(raw: string): ServerControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  if (!isKnownServerType(t)) return null;
  if (t === "navigate_view") {
    const viewId = readBoundedString((parsed as { viewId?: unknown }).viewId);
    const traceId = readBoundedString(
      (parsed as { traceId?: unknown }).traceId,
    );
    const rawViewPath = (parsed as { viewPath?: unknown }).viewPath;
    const viewPath =
      rawViewPath === undefined ? null : readBoundedString(rawViewPath);
    const rawSubview = (parsed as { subview?: unknown }).subview;
    const subview =
      rawSubview === undefined ? null : readBoundedString(rawSubview);
    if (
      !viewId ||
      !traceId ||
      (rawViewPath !== undefined && !viewPath) ||
      (rawSubview !== undefined && !subview)
    ) {
      return null;
    }
    return {
      t,
      viewId,
      ...(viewPath ? { viewPath } : {}),
      ...(subview ? { subview } : {}),
      traceId,
    };
  }
  return parsed as ServerControlFrame;
}

const SERVER_TYPES: ReadonlySet<string> = new Set<ServerControlType>([
  "ready",
  "stt_partial",
  "stt_eager_eot",
  "stt_final",
  "llm_first_text",
  "speaking_start",
  "speaking_end",
  "assistant_playing",
  "human_double_talk",
  "echo_rejected",
  "user_eos",
  "next_reply_ready",
  "handoff_requested",
  "handoff_completed",
  "navigate_view",
  "interrupted",
  "error",
  "usage",
]);

function isKnownServerType(t: string): t is ServerControlType {
  return SERVER_TYPES.has(t);
}

function readBoundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

/** Type guard: is this mint response usable (has url + token + sessionId). */
export function isUsableMintResponse(
  value: unknown,
): value is VoiceSessionMintResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.wsUrl === "string" &&
    v.wsUrl.length > 0 &&
    typeof v.token === "string" &&
    v.token.length > 0
  );
}

/**
 * Negotiate the effective codecs against the server's mint offer. If our
 * preferred codec is not offered, fall back to the first offered codec. Used
 * to build the `hello` frame so we never advertise a codec the server did not
 * offer (which the server would reject as a negotiation mismatch).
 */
export function negotiateCodec(
  preferred: VoiceSessionCodec,
  offered: VoiceSessionCodec[] | undefined,
): VoiceSessionCodec | null {
  if (!offered || offered.length === 0) return null;
  if (offered.includes(preferred)) return preferred;
  return offered[0] ?? null;
}
