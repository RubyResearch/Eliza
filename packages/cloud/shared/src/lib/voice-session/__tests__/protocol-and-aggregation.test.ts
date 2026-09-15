/**
 * Pure-logic units: protocol framing/validation, phrase aggregation, and the
 * session registry. No providers, no I/O — deterministic.
 */

import { describe, expect, test } from "bun:test";
import { PhraseAggregator } from "../phrase-aggregator";
import { MAX_AUDIO_FRAME_BYTES, parseClientControlFrame, validateAudioFrame } from "../protocol";
import { createVoiceSessionRegistry, type LiveVoiceSession } from "../session-registry";

describe("protocol framing", () => {
  test("preserves native Browser observation without accepting arbitrary surface hints", () => {
    expect(
      parseClientControlFrame(
        JSON.stringify({
          t: "ui_context",
          context: { uiViewPath: "/browser", uiBrowserSurface: "native" },
        }),
      ),
    ).toMatchObject({ ok: true, value: { context: { uiBrowserSurface: "native" } } });
    expect(
      parseClientControlFrame(
        JSON.stringify({ t: "ui_context", context: { uiBrowserSurface: "remote-admin" } }),
      ),
    ).toMatchObject({ ok: false });
  });
  test("accepts only bounded renderer observations, never client authority", () => {
    expect(
      parseClientControlFrame(
        JSON.stringify({
          t: "ui_context",
          context: {
            uiViewPath: "/notes",
            uiTimeZone: "America/New_York",
            uiViewActionNames: ["TRANSFER"],
            role: "OWNER",
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        t: "ui_context",
        context: {
          uiViewPath: "/notes",
          uiTimeZone: "America/New_York",
        },
      },
    });
    for (const context of [
      null,
      [],
      { uiViewPath: 1 },
      { uiViewPath: "//evil.test" },
      { uiViewPath: "/".repeat(2049) },
    ]) {
      expect(parseClientControlFrame(JSON.stringify({ t: "ui_context", context })).ok).toBe(false);
    }
    expect(parseClientControlFrame(JSON.stringify({ t: "ui_context", context: {} })).ok).toBe(true);
  });
  test("accepts a well-formed hello", () => {
    const r = parseClientControlFrame(
      JSON.stringify({
        t: "hello",
        token: "tok",
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("rejects a hello with a bad protocol version", () => {
    const r = parseClientControlFrame(
      JSON.stringify({
        t: "hello",
        token: "tok",
        protocol: 99,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("hello_bad_protocol");
  });

  test("rejects a hello with a non-16k sample rate", () => {
    const r = parseClientControlFrame(
      JSON.stringify({
        t: "hello",
        token: "tok",
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 48000,
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects opus in hello (Phase 1 is pcm16-only)", () => {
    const r = parseClientControlFrame(
      JSON.stringify({
        t: "hello",
        token: "tok",
        protocol: 1,
        uplinkCodec: "opus",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("hello_bad_uplink_codec");
  });

  test("rejects malformed JSON", () => {
    const r = parseClientControlFrame("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("control_invalid_json");
  });

  test("rejects an oversized control frame", () => {
    const big = JSON.stringify({ t: "bye", pad: "x".repeat(20 * 1024) });
    const r = parseClientControlFrame(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("control_too_large");
  });

  test("rejects an unknown control type", () => {
    const r = parseClientControlFrame(JSON.stringify({ t: "nope" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("control_unknown_type");
  });

  test("accepts the end_audio uplink-complete frame (not control_unknown_type)", () => {
    // Regression: a bounded-clip client signals uplink-finished with `end_audio`
    // after its audio. The live evidence run showed the real server surfaced
    // `control_unknown_type` for this (fatal to the turn once the client treated
    // the error as terminal). `end_audio` is now a first-class advisory frame.
    const r = parseClientControlFrame(JSON.stringify({ t: "end_audio" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.t).toBe("end_audio");
  });

  test("accepts only fully-typed continuous handoff audio capabilities", () => {
    expect(
      parseClientControlFrame(
        JSON.stringify({
          t: "audio_capabilities",
          mode: "continuous_handoff",
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          referenceAwarePlayback: true,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ t: "audio_capabilities" }),
      }),
    );
    expect(
      parseClientControlFrame(
        JSON.stringify({
          t: "audio_capabilities",
          mode: "continuous_handoff",
          echoCancellation: "yes",
          noiseSuppression: true,
          autoGainControl: true,
          referenceAwarePlayback: true,
        }),
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  test("validateAudioFrame enforces the size ceiling and non-empty", () => {
    expect(validateAudioFrame(2560).ok).toBe(true);
    expect(validateAudioFrame(0).ok).toBe(false);
    expect(validateAudioFrame(MAX_AUDIO_FRAME_BYTES + 1).ok).toBe(false);
  });
});

describe("phrase aggregator", () => {
  test("emits a phrase at a sentence terminator", () => {
    const agg = new PhraseAggregator();
    expect(agg.push("Hello")).toEqual([]);
    const out = agg.push(" world.");
    expect(out).toEqual(["Hello world."]);
  });

  test("emits multiple phrases across terminators", () => {
    const agg = new PhraseAggregator();
    const out = agg.push("One. Two! Three?");
    expect(out).toEqual(["One.", "Two!", "Three?"]);
  });

  test("flush returns the trailing unterminated buffer", () => {
    const agg = new PhraseAggregator();
    agg.push("no terminator here");
    expect(agg.flush()).toBe("no terminator here");
  });

  test("reset drops the buffer without emitting (interruption)", () => {
    const agg = new PhraseAggregator();
    agg.push("mid sentence");
    agg.reset();
    expect(agg.flush()).toBeNull();
  });

  test("emits on the max-buffer threshold even without a terminator", () => {
    const agg = new PhraseAggregator({ maxBufferChars: 10 });
    const out = agg.push("abcdefghij"); // exactly 10 chars.
    expect(out.length).toBe(1);
  });

  test("can defer the max threshold to a word boundary for TTS", () => {
    const agg = new PhraseAggregator({
      maxBufferChars: 10,
      preferWordBoundaryAtMax: true,
    });
    expect(agg.push("abcdefghij")).toEqual([]);
    const first = agg.push(" klm");
    expect(first).toEqual(["abcdefghij "]);
    const tail = agg.flush();
    expect(tail).toBe("klm");
    expect(`${first.join("")}${tail}`).toBe("abcdefghij klm");
  });

  test("word-boundary mode still hard-caps an unbroken token", () => {
    const agg = new PhraseAggregator({
      maxBufferChars: 10,
      preferWordBoundaryAtMax: true,
    });
    expect(agg.push("a".repeat(25))).toEqual([]);
    expect(agg.push("a")).toEqual(["a".repeat(26)]);
  });

  test("emitted count sequences continueContext", () => {
    const agg = new PhraseAggregator();
    agg.push("First. Second.");
    expect(agg.emitted).toBe(2);
  });
});

describe("session registry", () => {
  function fakeSession(id: string, jti: string, severed: string[]): LiveVoiceSession {
    return {
      sessionId: id,
      jti,
      organizationId: "org",
      userId: "user",
      sever: (reason) => severed.push(`${id}:${reason}`),
    };
  }

  test("severBySessionId severs and unregisters", () => {
    const severed: string[] = [];
    const reg = createVoiceSessionRegistry();
    reg.register(fakeSession("s1", "j1", severed));
    expect(reg.severBySessionId("s1", "revoked")).toBe(true);
    expect(severed).toEqual(["s1:revoked"]);
    expect(reg.get("s1")).toBeUndefined();
  });

  test("severBySessionId returns false for an unknown session (cross-worker case)", () => {
    const reg = createVoiceSessionRegistry();
    expect(reg.severBySessionId("nope", "revoked")).toBe(false);
  });

  test("severByJti finds the session by token id", () => {
    const severed: string[] = [];
    const reg = createVoiceSessionRegistry();
    reg.register(fakeSession("s2", "j2", severed));
    expect(reg.severByJti("j2", "revoked")).toBe(true);
    expect(severed).toEqual(["s2:revoked"]);
  });

  test("re-registering the same id severs the stale binding", () => {
    const severed: string[] = [];
    const reg = createVoiceSessionRegistry();
    reg.register(fakeSession("s3", "j3a", severed));
    reg.register(fakeSession("s3", "j3b", severed));
    expect(severed).toEqual(["s3:error"]);
    expect(reg.size()).toBe(1);
  });
});
