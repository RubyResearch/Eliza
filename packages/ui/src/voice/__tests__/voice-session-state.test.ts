/** Verifies voice-session-state machine (§7.4) through the package's configured test harness. */
import { describe, expect, it } from "vitest";
import type { ServerControlFrame } from "../voice-session-protocol";
import {
  applyClientAction,
  applyServerEvent,
  beginListening,
  INITIAL_VOICE_SESSION_STATE,
  loopToListening,
  toContinuousStatus,
  type VoiceSessionMachineState,
} from "../voice-session-state";

function fresh(): VoiceSessionMachineState {
  return { ...INITIAL_VOICE_SESSION_STATE };
}

describe("voice-session-state machine (§7.4)", () => {
  it("client owns idle → connecting; redundant connect is a no-op", () => {
    const connecting = applyClientAction(fresh(), { type: "client/connect" });
    expect(connecting.phase).toBe("connecting");
    // A second connect from a non-idle phase does nothing.
    expect(
      applyClientAction(connecting, { type: "client/connect" }).phase,
    ).toBe("connecting");
  });

  it("drives the full server lifecycle sequence in order", () => {
    let s = applyClientAction(fresh(), { type: "client/connect" });
    const seq: ServerControlFrame[] = [
      { t: "ready", sessionId: "sess-1", traceId: "T0" },
      { t: "stt_partial", text: "hel", traceId: "T1" },
      { t: "stt_final", text: "hello", traceId: "T1" },
      { t: "llm_first_text", traceId: "T1" },
      { t: "speaking_start", traceId: "T1" },
      { t: "speaking_end", traceId: "T1" },
    ];
    const phases: string[] = [];
    for (const ev of seq) {
      s = applyServerEvent(s, ev);
      phases.push(s.phase);
    }
    expect(phases).toEqual([
      "ready",
      "transcribing",
      "thinking",
      "thinking",
      "speaking",
      "complete",
    ]);
    expect(s.sessionId).toBe("sess-1");
    expect(s.finalTranscript).toBe("hello");
    expect(s.interimTranscript).toBe("");
    // complete → listening on the explicit loop.
    expect(loopToListening(s).phase).toBe("listening");
  });

  it("an empty final (noise EOT) terminates the turn instead of stranding 'thinking' (#16662)", () => {
    let s = applyClientAction(fresh(), { type: "client/connect" });
    s = applyServerEvent(s, {
      t: "ready",
      sessionId: "sess-noise",
      traceId: "T5",
    });
    s = applyServerEvent(s, { t: "stt_partial", text: "uh", traceId: "T5" });
    s = applyServerEvent(s, { t: "stt_final", text: "", traceId: "T5" });
    // The server never dispatches an LLM leg for an empty final, so no
    // speaking_end will follow: 'thinking' would be a dead end. The machine
    // must land terminal-of-turn with the interim transcript cleared.
    expect(s.phase).toBe("complete");
    expect(s.finalTranscript).toBe("");
    expect(s.interimTranscript).toBe("");
    expect(loopToListening(s).phase).toBe("listening");
  });

  it("a whitespace-only final terminates the turn too (server dispatch gate is trim-based) (#16662)", () => {
    let s = applyClientAction(fresh(), { type: "client/connect" });
    s = applyServerEvent(s, {
      t: "ready",
      sessionId: "sess-noise",
      traceId: "T6",
    });
    s = applyServerEvent(s, { t: "stt_partial", text: "uh", traceId: "T6" });
    // The server sends the RAW provider transcript on the wire but gates the
    // LLM leg on transcript.trim() === "" (session.ts commitTurn) — so a
    // whitespace-only final is equally leg-less: no speaking_end will follow.
    s = applyServerEvent(s, { t: "stt_final", text: " \t", traceId: "T6" });
    expect(s.phase).toBe("complete");
    expect(s.finalTranscript).toBe("");
    expect(s.interimTranscript).toBe("");
    expect(loopToListening(s).phase).toBe("listening");
  });

  it("server is authoritative for interrupted; local barge-in is optimistic", () => {
    let s = applyServerEvent(fresh(), { t: "speaking_start", traceId: "T2" });
    expect(s.phase).toBe("speaking");
    // Optimistic local flush moves speaking → listening WITHOUT a server event.
    const optimistic = applyClientAction(s, { type: "client/local_barge_in" });
    expect(optimistic.phase).toBe("listening");
    // But the authoritative interrupted event still reconciles cleanly.
    s = applyServerEvent(s, {
      t: "interrupted",
      reason: "acoustic",
      traceId: "T2",
    });
    expect(s.phase).toBe("interrupted");
    expect(s.interruptionReason).toBe("acoustic");
    expect(loopToListening(s).phase).toBe("listening");
    expect(loopToListening(s).interruptionReason).toBeNull();
  });

  it("local barge-in from a non-speaking phase is a no-op", () => {
    const s = applyServerEvent(fresh(), {
      t: "ready",
      sessionId: "x",
      traceId: "T",
    });
    expect(applyClientAction(s, { type: "client/local_barge_in" }).phase).toBe(
      "ready",
    );
  });

  it("stt_eager_eot updates trace but does not jump phase", () => {
    let s = applyServerEvent(fresh(), {
      t: "stt_partial",
      text: "a",
      traceId: "T3",
    });
    s = applyServerEvent(s, { t: "stt_eager_eot", traceId: "T3" });
    expect(s.phase).toBe("transcribing");
    expect(s.traceId).toBe("T3");
  });

  it("records a fatal (non-retryable) error and a retryable one distinctly", () => {
    const fatal = applyServerEvent(fresh(), {
      t: "error",
      code: "invalid_token",
      retryable: false,
    });
    expect(fatal.lastError).toEqual({
      code: "invalid_token",
      retryable: false,
    });
    const retry = applyServerEvent(fresh(), {
      t: "error",
      code: "audio_too_large",
      retryable: true,
    });
    expect(retry.lastError?.retryable).toBe(true);
  });

  it("usage settlement does not cut off speaking", () => {
    const speaking = applyServerEvent(fresh(), {
      t: "speaking_start",
      traceId: "T4",
    });
    const after = applyServerEvent(speaking, {
      t: "usage",
      sttMs: 10,
      ttsChars: 5,
      traceId: "T4",
    });
    expect(after.phase).toBe("speaking");
    expect(after.traceId).toBe("T4");
  });

  it("settles a silent thinking turn and ignores an older turn's receipt", () => {
    const thinking = applyServerEvent(fresh(), {
      t: "stt_final",
      text: "Please stay quiet for a moment.",
      traceId: "T5",
    });
    const receipt = {
      t: "usage" as const,
      sttMs: 100,
      ttsChars: 0,
      traceId: "T5",
    };
    expect(applyServerEvent(thinking, { ...receipt, traceId: "T4" })).toBe(
      thinking,
    );
    const settled = applyServerEvent(thinking, receipt);
    expect(settled.phase).toBe("complete");
    expect(beginListening(settled).phase).toBe("listening");
  });

  it("beginListening only advances from ready/complete", () => {
    const ready = applyServerEvent(fresh(), {
      t: "ready",
      sessionId: "x",
      traceId: "T",
    });
    expect(beginListening(ready).phase).toBe("listening");
    expect(beginListening(fresh()).phase).toBe("idle"); // idle stays idle
  });

  it("maps phases onto the unified VoiceContinuousStatus", () => {
    expect(toContinuousStatus("idle")).toBe("idle");
    expect(toContinuousStatus("connecting")).toBe("idle");
    expect(toContinuousStatus("ready")).toBe("idle");
    expect(toContinuousStatus("listening")).toBe("listening");
    expect(toContinuousStatus("transcribing")).toBe("transcribing");
    expect(toContinuousStatus("thinking")).toBe("thinking");
    expect(toContinuousStatus("speaking")).toBe("speaking");
    expect(toContinuousStatus("interrupted")).toBe("interrupting");
    expect(toContinuousStatus("complete")).toBe("listening");
  });
});
