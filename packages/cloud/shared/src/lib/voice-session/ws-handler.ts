/**
 * Voice-session WebSocket handler — the transport-side glue that turns a raw
 * server WebSocket into a `VoiceSession`.
 *
 * Responsibilities (contract §7.2):
 *   - enforce HELLO-FIRST: the first frame MUST be a JSON `hello` carrying the
 *     token; a binary-first or non-hello-first client is rejected before any
 *     provider socket opens;
 *   - verify the token (sig/aud/exp/nbf/jti/claims) against the requested
 *     session before starting anything;
 *   - after `ready`, route binary frames to uplink audio and text frames to
 *     control (audio_meta / barge_in / bye);
 *   - reject malformed and oversized frames as explicit protocol errors;
 *   - bridge the `VoiceSession`'s downlink to the socket, and self-revoke on
 *     disconnect.
 *
 * The handler is transport-agnostic: it takes a minimal `ServerWebSocketLike`
 * so tests drive a fake socket through the REAL hello/auth/framing/session code
 * (no stub of the thing under test). The CF-Workers route adapts the platform
 * `WebSocket` to this shape.
 */

import type { VoiceUiContext } from "@elizaos/shared";
import { type VoiceSessionTokenClaims, verifyVoiceSessionToken } from "./jwt";
import type { ServerControlFrame } from "./protocol";
import {
  parseClientControlFrame,
  serializeServerFrame,
  VOICE_SESSION_PROTOCOL_VERSION,
  validateAudioFrame,
} from "./protocol";

/**
 * The downlink surface the handler wires the socket into. Mirrors the session's
 * downlink so the concrete `VoiceSession` (which lives in the api package,
 * alongside the provider adapters) satisfies it without shared importing api.
 */
export interface VoiceSessionDownlink {
  sendControl(frame: ServerControlFrame): void;
  sendAudio(bytes: Uint8Array): void;
  /** Flush transport-buffered playback that may outlive server-side TTS. */
  clearAudio?(): void;
  close(code: number, reason: string): void;
}

/**
 * Minimal session surface the handler drives. The concrete `VoiceSession`
 * implements this; keeping it an interface lets the WS handler live in shared
 * while the orchestrator lives next to the merged provider adapters in api.
 */
export interface VoiceSessionLike {
  setUiContext?(context: VoiceUiContext): void;
  start(): void;
  pushUplinkAudio(bytes: Uint8Array): void;
  bargeIn(): void;
  bye(): void;
  sever(reason: "client_disconnect" | "error"): void;
  /**
   * Optional advisory: the client signalled it has finished sending audio for
   * the current utterance (`end_audio`). Phase-1 turn detection is Ink
   * semantic EOT, so a session may treat this as a no-op; declared optional so
   * the frame is accepted without forcing every implementation to react.
   */
  endUplink?(): void;
  setAudioCapabilities?(capabilities: {
    mode: "continuous_handoff";
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    referenceAwarePlayback: boolean;
  }): void;
}

export interface ServerWebSocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

/** Everything the handler needs to build a session once the token verifies. */
export interface VoiceWsHandlerDeps {
  /** The sessionId the client is connecting for (from the wsUrl query). */
  requestedSessionId: string;
  /** Build a `VoiceSession` for verified claims. Injected so the route wires the
   * real provider factories and the test wires fakes — both exercise the real
   * VoiceSession. */
  buildSession: (params: {
    claims: VoiceSessionTokenClaims;
    jti: string;
    tokenExpSeconds: number;
    downlink: VoiceSessionDownlink;
    initialUsageAdmissionMinutes?: number;
  }) => VoiceSessionLike;
  /** Verify override for tests; defaults to the real verifier. */
  verifyToken?: typeof verifyVoiceSessionToken;
  /**
   * Atomically claim the token's jti for a SINGLE connection (single-use). The
   * first caller wins; a second concurrent hello with the same token is
   * rejected before any provider stream starts. Returns true when claimed.
   * Omit in unit tests that don't exercise concurrent reuse.
   */
  claimToken?: (jti: string, expSeconds: number) => Promise<boolean>;
  /**
   * Per-worker capacity gate, checked AFTER verification and right before
   * `session.start()` — a burst of upgrades can pass the route-level check
   * before any registers, so the real ceiling is enforced here against the
   * live registry. Returns true when a new session may start.
   */
  admitSession?: () => boolean;
  /**
   * Atomically records the initial paid-provider window after token standing
   * and capacity checks, immediately before session construction and start.
   */
  admitProviderSession?: (identity: { organizationId: string; userId: string }) => Promise<{
    admittedMinutes: number;
    release(): Promise<void>;
  }>;
  /** Retain detached rollback work under the owning Worker lifetime. */
  defer?: (promise: Promise<unknown>) => void;
  now?: () => number;
}

type HandlerState = "awaiting_hello" | "active" | "closed";

export function attachVoiceWsHandler(socket: ServerWebSocketLike, deps: VoiceWsHandlerDeps): void {
  const verify = deps.verifyToken ?? verifyVoiceSessionToken;
  let state: HandlerState = "awaiting_hello";
  let session: VoiceSessionLike | null = null;
  // A well-behaved client may pipeline the first audio frame right after hello,
  // before async JWT verification finishes. Once hello is RECEIVED (even if not
  // yet verified), buffer those frames instead of failing the session, and
  // replay them the moment it goes active. A binary frame with NO hello at all
  // is still a hello-first violation.
  let helloReceived = false;
  const pendingUplink: Uint8Array[] = [];
  const MAX_PENDING_UPLINK = 64; // ~5s of 80ms frames; bounds pre-verify memory.

  const downlink: VoiceSessionDownlink = {
    sendControl(frame: ServerControlFrame) {
      safeSend(socket, serializeServerFrame(frame));
    },
    sendAudio(bytes: Uint8Array) {
      safeSend(socket, bytes);
    },
    close(code: number, reason: string) {
      try {
        socket.close(code, reason);
      } catch (ignoredError) {
        void ignoredError;
        // already closing.
      }
    },
  };

  const fail = (code: string, message: string, closeCode = 1008, retryable = false): void => {
    safeSend(socket, serializeServerFrame({ t: "error", code, retryable }));
    state = "closed";
    try {
      socket.close(closeCode, message.slice(0, 120));
    } catch (ignoredError) {
      void ignoredError;
      // ignore.
    }
  };

  socket.addEventListener("message", (event) => {
    if (state === "closed") return;
    const data = event.data;

    // Binary frame = audio. Valid after an active session, OR buffered while
    // hello verification is still in flight (hello already received).
    if (isBinary(data)) {
      if (state !== "active" || !session) {
        if (state === "awaiting_hello" && helloReceived) {
          // Verification pending: validate + buffer, don't fail a valid client.
          const bytes = toUint8(data);
          const check = validateAudioFrame(bytes.byteLength);
          if (!check.ok) {
            safeSend(
              socket,
              serializeServerFrame({ t: "error", code: check.code, retryable: true }),
            );
            return;
          }
          if (pendingUplink.length >= MAX_PENDING_UPLINK) {
            fail("uplink_before_ready", "too much audio before session ready");
            return;
          }
          pendingUplink.push(bytes);
          return;
        }
        // No hello at all: hello-first violation.
        fail("hello_required", "first frame must be a JSON hello");
        return;
      }
      const bytes = toUint8(data);
      const check = validateAudioFrame(bytes.byteLength);
      if (!check.ok) {
        // Oversized/empty audio is a protocol error but not necessarily fatal to
        // the session; drop the frame and tell the client. A persistently
        // misbehaving client trips the byte-rate/metering caps.
        safeSend(socket, serializeServerFrame({ t: "error", code: check.code, retryable: true }));
        return;
      }
      session.pushUplinkAudio(bytes);
      return;
    }

    // Text frame = JSON control.
    const parsed = parseClientControlFrame(typeof data === "string" ? data : String(data));
    if (!parsed.ok) {
      // Malformed control before hello is fatal; after hello it's a bad frame we
      // surface but survive.
      if (state === "awaiting_hello") {
        fail(parsed.code, parsed.message);
      } else {
        safeSend(
          socket,
          serializeServerFrame({ t: "error", code: parsed.code, retryable: parsed.retryable }),
        );
      }
      return;
    }

    const frame = parsed.value;

    if (state === "awaiting_hello") {
      if (frame.t !== "hello") {
        fail("hello_required", "first frame must be a JSON hello");
        return;
      }
      if (helloReceived) {
        // A duplicate hello while verification is still pending: ignore.
        return;
      }
      helloReceived = true;
      void handleHello(frame.token, frame.protocol);
      return;
    }

    // Active session control frames.
    if (!session) return;
    switch (frame.t) {
      case "ui_context":
        session.setUiContext?.(frame.context);
        return;
      case "hello":
        // A second hello is a protocol violation; ignore rather than re-auth.
        safeSend(
          socket,
          serializeServerFrame({ t: "error", code: "duplicate_hello", retryable: false }),
        );
        return;
      case "audio_meta":
        // Codec-swap signal (on-mic -> BLE-mic). Phase 1 is pcm16-only; an opus
        // switch is a documented seam. Accept the meta as a no-op for pcm16.
        return;
      case "audio_capabilities":
        session.setAudioCapabilities?.(frame);
        return;
      case "barge_in":
        session.bargeIn();
        return;
      case "end_audio":
        // Uplink-complete advisory. Phase-1 finalization is Ink semantic EOT,
        // so this is a graceful no-op unless the session opts to react. It must
        // NOT surface a client-facing error (a well-behaved bounded-clip client
        // sends this after its audio).
        session.endUplink?.();
        return;
      case "bye":
        session.bye();
        state = "closed";
        return;
    }
  });

  socket.addEventListener("close", () => {
    if (state === "closed") return;
    state = "closed";
    // Self-revoke on disconnect: sever provider sockets so a dropped client
    // never leaves audio flowing to Cartesia Ink.
    session?.sever("client_disconnect");
  });

  socket.addEventListener("error", () => {
    if (state === "closed") return;
    state = "closed";
    session?.sever("error");
  });

  async function handleHello(token: string, protocol: number): Promise<void> {
    if (protocol !== VOICE_SESSION_PROTOCOL_VERSION) {
      fail("hello_bad_protocol", "unsupported protocol version");
      return;
    }
    let verified: Awaited<ReturnType<typeof verify>>;
    try {
      verified = await verify(
        token,
        { sessionId: deps.requestedSessionId },
        deps.now ? { now: deps.now } : undefined,
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "invalid_token";
      // A transient revocation-store outage is NOT a terminal token failure
      // (#16663): the server knows the failure is infrastructural, so tell
      // the client it may re-mint and retry (1013 = try again later) instead
      // of flattening it into the same non-retryable shape as `revoked`.
      if (code === "store_unavailable") {
        fail(code, "revocation store unavailable", 1013, true);
        return;
      }
      fail(code, "token verification failed");
      return;
    }

    if (state !== "awaiting_hello") return; // raced a close.

    // Single-use enforcement: atomically claim the jti BEFORE starting any paid
    // provider stream. Two concurrent hellos with one token race here; only the
    // winner proceeds. A loser is rejected without opening providers.
    if (deps.claimToken) {
      let claimed: boolean;
      try {
        claimed = await deps.claimToken(verified.jti, verified.expSeconds);
      } catch (ignoredError) {
        void ignoredError;
        fail("token_claim_failed", "could not claim voice token");
        return;
      }
      if (!claimed) {
        fail("token_already_claimed", "voice token already in use");
        return;
      }
      if (state !== "awaiting_hello") return; // raced a close during the claim.
    }

    // Capacity ceiling, re-checked against the LIVE registry now that we are
    // about to register+start (the route-level check races pending upgrades).
    if (deps.admitSession && !deps.admitSession()) {
      fail("at_capacity", "voice realtime capacity reached");
      return;
    }

    let providerAdmission: { admittedMinutes: number; release(): Promise<void> } | undefined;
    try {
      providerAdmission = await deps.admitProviderSession?.({
        organizationId: verified.claims.organizationId,
        userId: verified.claims.userId,
      });
      if (state !== "awaiting_hello") {
        if (providerAdmission) {
          const release = providerAdmission.release();
          if (deps.defer) deps.defer(release);
          else void release;
        }
        return;
      }
      session = deps.buildSession({
        claims: verified.claims,
        jti: verified.jti,
        tokenExpSeconds: verified.expSeconds,
        downlink,
        initialUsageAdmissionMinutes: providerAdmission?.admittedMinutes,
      });
      state = "active";
      session.start();
    } catch (error) {
      if (providerAdmission) {
        const release = providerAdmission.release();
        if (deps.defer) deps.defer(release);
        else void release;
      }
      // Runtime-config failures (e.g. an invalid Cartesia voiceId rejected by
      // the adapter) must surface as a clean retryable error + close, not a
      // hung socket with a consumed token.
      session = null;
      state = "awaiting_hello";
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "session_start_failed";
      fail(
        code,
        code === "quota_exhausted"
          ? "voice realtime quota exhausted"
          : "could not start voice session",
        code === "quota_exhausted" ? 1008 : 1011,
      );
      return;
    }
    // Replay any audio the client pipelined while verification was in flight,
    // in order, so the start of the utterance is not lost.
    if (pendingUplink.length > 0) {
      const buffered = pendingUplink.splice(0);
      for (const bytes of buffered) session.pushUplinkAudio(bytes);
    }
  }
}

function safeSend(socket: ServerWebSocketLike, data: string | Uint8Array): void {
  try {
    socket.send(data);
  } catch (ignoredError) {
    void ignoredError;
    // socket closing/closed; drop.
  }
}

function isBinary(data: unknown): boolean {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

function toUint8(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}
