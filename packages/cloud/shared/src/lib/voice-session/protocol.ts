/**
 * Voice-session WebSocket wire protocol (contract §7.2).
 *
 * Binary frames are audio; text frames are JSON control. The FIRST frame after
 * connect MUST be a JSON `hello` — a binary-first or non-hello-first client is
 * rejected before any provider socket opens (defends the mint/consent gate from
 * being bypassed by streaming audio straight at the worker).
 *
 * This module owns only parsing/validation/serialization of the protocol. It
 * holds no auth, no provider state, and no timers. The session orchestrator
 * consumes these typed events.
 */

import { parseVoiceUiContext, type VoiceUiContext } from "@elizaos/shared";

export const VOICE_SESSION_PROTOCOL_VERSION = 1;

/** Reject any control frame larger than this (defense against JSON bombs). */
export const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
/**
 * Reject any single uplink audio frame larger than this. PCM16 @16kHz mono is
 * 32000 bytes/sec; a well-behaved client sends <=~100ms frames. 64KiB is ~2s of
 * audio — generous for jitter, tight enough to bound per-frame memory and to
 * make an oversized-frame flood a protocol error rather than a heap risk.
 */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

export type VoiceUplinkCodec = "pcm16" | "opus";
export type VoiceDownlinkCodec = "pcm16" | "opus";

// --- client -> server control frames -------------------------------------

export interface ClientHelloFrame {
  t: "hello";
  token: string;
  protocol: number;
  uplinkCodec: VoiceUplinkCodec;
  downlinkCodec: VoiceDownlinkCodec;
  sampleRate: number;
}

export interface ClientAudioMetaFrame {
  t: "audio_meta";
  seq: number;
  codec: VoiceUplinkCodec;
  sampleRate: number;
  channels: number;
}

/**
 * Verified browser audio-processing capabilities. This is sent only after
 * getUserMedia resolves so the values describe the selected track, not merely
 * requested constraints. The server still owns the rollout gate.
 */
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

/**
 * Uplink-complete signal: the client has finished sending audio for the current
 * utterance (e.g. push-to-talk release, or a client that streams a bounded clip
 * rather than an open mic). Phase 1 turn detection is driven by Cartesia Ink's
 * SEMANTIC end-of-turn (trailing silence), so this is an advisory hint the
 * server MAY use to finalize sooner; it is never required for a turn to commit.
 * Declared as a first-class frame so a well-behaved client is not met with a
 * spurious `control_unknown_type` error.
 */
export interface ClientEndAudioFrame {
  t: "end_audio";
}

export type ClientControlFrame =
  | { t: "ui_context"; context: VoiceUiContext }
  | ClientHelloFrame
  | ClientAudioMetaFrame
  | ClientAudioCapabilitiesFrame
  | ClientBargeInFrame
  | ClientByeFrame
  | ClientEndAudioFrame;

// --- server -> client control / state frames ------------------------------

export type ServerControlFrame =
  | { t: "ready"; sessionId: string; traceId: string; uiContext?: boolean }
  | { t: "stt_partial"; text: string; traceId: string }
  | { t: "stt_eager_eot"; traceId: string }
  | { t: "stt_final"; text: string; traceId: string }
  | { t: "llm_first_text"; traceId: string }
  | { t: "speaking_start"; traceId: string }
  | { t: "speaking_end"; traceId: string }
  | { t: "assistant_playing"; active: boolean; traceId: string }
  | {
      t: "human_double_talk" | "echo_rejected" | "user_eos" | "next_reply_ready";
      traceId: string;
    }
  | {
      t: "handoff_requested";
      fromTraceId: string;
      toTraceId: string;
      crossfadeMs: number;
      traceId: string;
    }
  | {
      t: "handoff_completed";
      fromTraceId: string;
      toTraceId: string;
      traceId: string;
    }
  | {
      t: "navigate_view";
      viewId: string;
      viewPath?: string;
      subview?: string;
      traceId: string;
    }
  | { t: "interrupted"; reason: "acoustic" | "explicit"; traceId: string }
  | {
      t: "error";
      code: string;
      retryable: boolean;
      upstreamStatus?: number;
      upstreamMessage?: string;
      upstreamSnippet?: string;
    }
  | { t: "usage"; sttMs: number; ttsChars: number; traceId: string };

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; retryable: boolean };

function fail(code: string, message: string, retryable = false): ProtocolParseResult<never> {
  return { ok: false, code, message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Phase 1 accepts pcm16 ONLY. Opus is a documented Phase-4 seam; until the
// transcode is wired, an opus `hello`/`audio_meta` is rejected rather than
// silently fed into the linear16 path (which would misinterpret the audio).
const VALID_UPLINK_CODECS: readonly VoiceUplinkCodec[] = ["pcm16"];
const VALID_DOWNLINK_CODECS: readonly VoiceDownlinkCodec[] = ["pcm16"];

/**
 * Parse a text control frame. Enforces the size ceiling and rejects malformed
 * JSON as an explicit protocol error (never a coerced default).
 */
export function parseClientControlFrame(raw: unknown): ProtocolParseResult<ClientControlFrame> {
  if (typeof raw !== "string") {
    return fail("control_not_text", "control frame must be JSON text");
  }
  if (byteLengthUtf8(raw) > MAX_CONTROL_FRAME_BYTES) {
    return fail("control_too_large", "control frame exceeds size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("control_invalid_json", "control frame is not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.t !== "string") {
    return fail("control_missing_type", "control frame is missing a string `t`");
  }

  switch (parsed.t) {
    case "ui_context": {
      const context = parseVoiceUiContext(parsed.context);
      return context
        ? { ok: true, value: { t: "ui_context", context } }
        : fail("ui_context_invalid", "invalid renderer view context");
    }
    case "hello":
      return parseHello(parsed);
    case "audio_meta":
      return parseAudioMeta(parsed);
    case "audio_capabilities":
      return parseAudioCapabilities(parsed);
    case "barge_in":
      return { ok: true, value: { t: "barge_in" } };
    case "bye":
      return { ok: true, value: { t: "bye" } };
    case "end_audio":
      return { ok: true, value: { t: "end_audio" } };
    default:
      return fail("control_unknown_type", `unsupported control frame type: ${parsed.t}`);
  }
}

function parseAudioCapabilities(
  v: Record<string, unknown>,
): ProtocolParseResult<ClientAudioCapabilitiesFrame> {
  if (v.mode !== "continuous_handoff") {
    return fail("audio_capabilities_bad_mode", "unsupported audio capability mode");
  }
  const booleanFields = [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "referenceAwarePlayback",
  ] as const;
  for (const field of booleanFields) {
    if (typeof v[field] !== "boolean") {
      return fail("audio_capabilities_bad_value", `${field} must be boolean`);
    }
  }
  return {
    ok: true,
    value: {
      t: "audio_capabilities",
      mode: "continuous_handoff",
      echoCancellation: v.echoCancellation as boolean,
      noiseSuppression: v.noiseSuppression as boolean,
      autoGainControl: v.autoGainControl as boolean,
      referenceAwarePlayback: v.referenceAwarePlayback as boolean,
    },
  };
}

function parseHello(v: Record<string, unknown>): ProtocolParseResult<ClientHelloFrame> {
  if (typeof v.token !== "string" || v.token.trim() === "") {
    return fail("hello_missing_token", "hello frame is missing token");
  }
  if (v.protocol !== VOICE_SESSION_PROTOCOL_VERSION) {
    return fail("hello_bad_protocol", "unsupported protocol version");
  }
  const uplinkCodec = v.uplinkCodec;
  if (
    typeof uplinkCodec !== "string" ||
    !VALID_UPLINK_CODECS.includes(uplinkCodec as VoiceUplinkCodec)
  ) {
    return fail("hello_bad_uplink_codec", "unsupported uplink codec");
  }
  const downlinkCodec = v.downlinkCodec;
  if (
    typeof downlinkCodec !== "string" ||
    !VALID_DOWNLINK_CODECS.includes(downlinkCodec as VoiceDownlinkCodec)
  ) {
    return fail("hello_bad_downlink_codec", "unsupported downlink codec");
  }
  const sampleRate = v.sampleRate;
  if (typeof sampleRate !== "number" || sampleRate !== 16000) {
    return fail("hello_bad_sample_rate", "sampleRate must be 16000");
  }
  return {
    ok: true,
    value: {
      t: "hello",
      token: v.token,
      protocol: VOICE_SESSION_PROTOCOL_VERSION,
      uplinkCodec: uplinkCodec as VoiceUplinkCodec,
      downlinkCodec: downlinkCodec as VoiceDownlinkCodec,
      sampleRate,
    },
  };
}

function parseAudioMeta(v: Record<string, unknown>): ProtocolParseResult<ClientAudioMetaFrame> {
  const codec = v.codec;
  if (typeof codec !== "string" || !VALID_UPLINK_CODECS.includes(codec as VoiceUplinkCodec)) {
    return fail("audio_meta_bad_codec", "unsupported uplink codec");
  }
  if (typeof v.seq !== "number" || !Number.isFinite(v.seq)) {
    return fail("audio_meta_bad_seq", "audio_meta seq must be a number");
  }
  if (typeof v.sampleRate !== "number" || v.sampleRate !== 16000) {
    return fail("audio_meta_bad_sample_rate", "sampleRate must be 16000");
  }
  if (typeof v.channels !== "number" || v.channels !== 1) {
    return fail("audio_meta_bad_channels", "channels must be 1");
  }
  return {
    ok: true,
    value: {
      t: "audio_meta",
      seq: v.seq,
      codec: codec as VoiceUplinkCodec,
      sampleRate: v.sampleRate,
      channels: v.channels,
    },
  };
}

/** Validate an inbound binary audio frame's size. */
export function validateAudioFrame(byteLength: number): ProtocolParseResult<number> {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return fail("audio_empty", "audio frame is empty");
  }
  if (byteLength > MAX_AUDIO_FRAME_BYTES) {
    return fail("audio_too_large", "audio frame exceeds size limit");
  }
  return { ok: true, value: byteLength };
}

export function serializeServerFrame(frame: ServerControlFrame): string {
  return JSON.stringify(frame);
}

function byteLengthUtf8(value: string): number {
  // Avoid a Buffer/TextEncoder dependency choice here; TextEncoder exists in
  // Workers, Node, and Bun uniformly.
  return new TextEncoder().encode(value).length;
}
