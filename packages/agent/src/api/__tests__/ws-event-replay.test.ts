/**
 * Unit tests for the WS reconnect cursor replay logic (loadperf research 05,
 * Finding 4). Exercises the pure helpers in isolation, asserting the
 * cursor-filtered slice AND the backward-compatible no-cursor fallback.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_LIMIT,
  eventSequence,
  parseEventCursor,
  type ReplayableEvent,
  selectReplay,
  selectReplayEvents,
} from "../ws-event-replay.ts";

function makeBuffer(count: number, startSeq = 1): ReplayableEvent[] {
  const out: ReplayableEvent[] = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    out.push({ eventId: `evt-${seq}`, bufferSeq: seq });
  }
  return out;
}

describe("parseEventCursor", () => {
  it("returns null for absent/empty/invalid cursors (falls back to slice)", () => {
    expect(parseEventCursor(null)).toBeNull();
    expect(parseEventCursor(undefined)).toBeNull();
    expect(parseEventCursor("")).toBeNull();
    expect(parseEventCursor("   ")).toBeNull();
    expect(parseEventCursor("not-a-number")).toBeNull();
    expect(parseEventCursor("garbage999")).toBeNull();
    expect(parseEventCursor("999garbage")).toBeNull();
    expect(parseEventCursor("evt-42-extra")).toBeNull();
    expect(parseEventCursor("evt--42")).toBeNull();
    expect(parseEventCursor("+42")).toBeNull();
    expect(parseEventCursor("42.5")).toBeNull();
  });

  it("parses a bare integer cursor", () => {
    expect(parseEventCursor("42")).toBe(42);
    expect(parseEventCursor("0")).toBe(0);
    expect(parseEventCursor("  7 ")).toBe(7);
  });

  it("parses a full evt-<n> cursor", () => {
    expect(parseEventCursor("evt-42")).toBe(42);
    expect(parseEventCursor("evt-0")).toBe(0);
  });
});

describe("eventSequence", () => {
  it("prefers numeric bufferSeq when present", () => {
    expect(eventSequence({ eventId: "evt-99", bufferSeq: 5 })).toBe(5);
  });

  it("falls back to the eventId numeric suffix when bufferSeq is absent", () => {
    expect(eventSequence({ eventId: "evt-77" })).toBe(77);
  });

  it("returns null for an unparseable eventId", () => {
    expect(eventSequence({ eventId: "no-digits-here" })).toBeNull();
  });
});

describe("selectReplayEvents — cursor present", () => {
  it("returns only events with seq strictly greater than the cursor", () => {
    const buffer = makeBuffer(10); // seq 1..10
    const result = selectReplayEvents(buffer, 7);
    expect(result.map((e) => e.bufferSeq)).toEqual([8, 9, 10]);
  });

  it("returns nothing when the cursor is at/after the newest event", () => {
    const buffer = makeBuffer(5); // seq 1..5
    expect(selectReplayEvents(buffer, 5)).toEqual([]);
    expect(selectReplayEvents(buffer, 100)).toEqual([]);
  });

  it("returns the whole buffer when the cursor predates everything", () => {
    const buffer = makeBuffer(4); // seq 1..4
    const result = selectReplayEvents(buffer, 0);
    expect(result.map((e) => e.bufferSeq)).toEqual([1, 2, 3, 4]);
  });

  it("caps a stale cursor's replay to the most-recent `limit` events", () => {
    const buffer = makeBuffer(500); // seq 1..500
    const result = selectReplayEvents(buffer, 0, 120);
    expect(result).toHaveLength(120);
    // capped to the newest 120 (seq 381..500), still in buffer order
    expect(result[0].bufferSeq).toBe(381);
    expect(result[result.length - 1].bufferSeq).toBe(500);
  });

  it("derives the sequence from eventId when bufferSeq is missing (REST-mirror events)", () => {
    const buffer: ReplayableEvent[] = [
      { eventId: "evt-1" },
      { eventId: "evt-2" },
      { eventId: "evt-3" },
    ];
    const result = selectReplayEvents(buffer, 1);
    expect(result.map((e) => e.eventId)).toEqual(["evt-2", "evt-3"]);
  });

  it("does not reorder or mutate the input buffer", () => {
    const buffer = makeBuffer(6);
    const snapshot = buffer.map((e) => e.bufferSeq);
    selectReplayEvents(buffer, 3);
    expect(buffer.map((e) => e.bufferSeq)).toEqual(snapshot);
  });
});

describe("selectReplayEvents — no cursor (backward compatible)", () => {
  it("returns slice(-DEFAULT_REPLAY_LIMIT) for a null cursor, identical to legacy behavior", () => {
    const buffer = makeBuffer(300); // seq 1..300
    const legacy = buffer.slice(-DEFAULT_REPLAY_LIMIT);
    const result = selectReplayEvents(buffer, null);
    expect(result).toEqual(legacy);
    expect(result).toHaveLength(DEFAULT_REPLAY_LIMIT);
    expect(result[0].bufferSeq).toBe(300 - DEFAULT_REPLAY_LIMIT + 1);
    expect(result[result.length - 1].bufferSeq).toBe(300);
  });

  it("returns the whole buffer (slice tail) when shorter than the limit", () => {
    const buffer = makeBuffer(5);
    const result = selectReplayEvents(buffer, null);
    expect(result).toEqual(buffer);
    expect(result).not.toBe(buffer); // a copy, not the original reference
  });

  it("matches the exact legacy slice(-120) for an invalid cursor string", () => {
    const buffer = makeBuffer(200);
    const cursor = parseEventCursor("garbage"); // -> null
    const result = selectReplayEvents(buffer, cursor);
    expect(result).toEqual(buffer.slice(-120));
  });
});

describe("selectReplayEvents — fail-closed on non-positive limit", () => {
  it("returns [] for limit=0, negative, and NaN with no cursor", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, null, 0)).toEqual([]);
    expect(selectReplayEvents(buffer, null, -5)).toEqual([]);
    expect(selectReplayEvents(buffer, null, NaN)).toEqual([]);
  });

  it("returns [] for limit=0, negative, and NaN with a cursor", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, 5, 0)).toEqual([]);
    expect(selectReplayEvents(buffer, 5, -1)).toEqual([]);
    expect(selectReplayEvents(buffer, 5, NaN)).toEqual([]);
  });

  it("returns [] for sub-unit and non-finite limits", () => {
    const buffer = makeBuffer(20);
    for (const limit of [0.5, Number.POSITIVE_INFINITY]) {
      expect(selectReplayEvents(buffer, null, limit)).toEqual([]);
      expect(selectReplayEvents(buffer, 5, limit)).toEqual([]);
    }
  });

  it("floors a positive fractional limit before slicing", () => {
    const buffer = makeBuffer(20);
    expect(selectReplayEvents(buffer, null, 1.9)).toEqual(buffer.slice(-1));
    expect(selectReplayEvents(buffer, 5, 1.9)).toEqual([buffer.at(-1)]);
  });
});

describe("selectReplay — incomplete replay signaling", () => {
  it("reports the range omitted by the replay limit", () => {
    const selection = selectReplay(makeBuffer(125), 0, 120);

    expect(selection.events.map((event) => event.bufferSeq)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 6),
    );
    expect(selection.gap).toEqual({
      type: "replay-gap",
      version: 1,
      requestedAfter: 0,
      availableFrom: 1,
      availableThrough: 125,
      replayedFrom: 6,
      replayedThrough: 125,
      reasons: ["replay-limit"],
    });
  });

  it("reports events evicted before the retained buffer", () => {
    const selection = selectReplay(makeBuffer(5, 11), 5, 120);

    expect(selection.events.map((event) => event.bufferSeq)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect(selection.gap?.reasons).toEqual(["retention-gap"]);
    expect(selection.gap?.availableFrom).toBe(11);
  });

  it("reports a cursor ahead of the current server sequence", () => {
    const selection = selectReplay(makeBuffer(5), 25, 120);

    expect(selection.events).toEqual(makeBuffer(5));
    expect(selection.gap).toMatchObject({
      requestedAfter: 25,
      availableFrom: 1,
      availableThrough: 5,
      replayedFrom: 1,
      replayedThrough: 5,
      reasons: ["cursor-ahead"],
    });
  });

  it("does not claim a gap when every newer event is replayed", () => {
    expect(selectReplay(makeBuffer(10), 7, 120)).toEqual({
      events: makeBuffer(3, 8),
      gap: null,
    });
  });
});
