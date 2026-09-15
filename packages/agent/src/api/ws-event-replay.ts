/**
 * Pure helpers for the WebSocket event-buffer replay on (re)connect.
 *
 * See loadperf research report 05 (Network & Data Sync),
 * Finding 4: on every (re)connect the server replays the tail of
 * `state.eventBuffer`, re-flooding the client with up to `DEFAULT_REPLAY_LIMIT`
 * historical envelopes even after a brief reconnect. A client that tracks the
 * highest event sequence it has applied can pass it back as a cursor so the
 * server replays only the envelopes the client is actually missing.
 *
 * @module
 */

import type {
  WebSocketReplayGap,
  WebSocketReplayGapReason,
} from "@elizaos/shared";

/**
 * Maximum number of buffered envelopes replayed when the client provides no
 * (or an invalid) cursor. This is the historical, backward-compatible default:
 * a fresh connection with no cursor receives `buffer.slice(-DEFAULT_REPLAY_LIMIT)`.
 */
export const DEFAULT_REPLAY_LIMIT = 120;

/**
 * Minimal shape the replay logic needs from a buffered event envelope. The real
 * envelope (`StreamEventEnvelope` from `@elizaos/shared`) carries more fields;
 * the cursor only cares about the monotonic sequence, which is the integer
 * portion of `eventId` (`evt-<n>`) and is mirrored on `bufferSeq` for envelopes
 * pushed through the primary `pushEvent` path.
 */
export interface ReplayableEvent {
  eventId: string;
  bufferSeq?: number;
}

/** A bounded replay plus an explicit signal when that replay is incomplete. */
export interface ReplaySelection<T extends ReplayableEvent> {
  events: T[];
  gap: WebSocketReplayGap | null;
}

/**
 * Resolve the monotonic sequence of a buffered envelope.
 *
 * Prefers the explicit numeric `bufferSeq` (stamped by `pushEvent`); falls back
 * to parsing the trailing integer of `eventId` (`evt-<n>`) so envelopes pushed
 * by other code paths (e.g. the `/api/agent-event` REST mirror) still sort and
 * filter correctly. Returns `null` when no sequence can be derived.
 */
export function eventSequence(event: ReplayableEvent): number | null {
  if (
    typeof event.bufferSeq === "number" &&
    Number.isSafeInteger(event.bufferSeq) &&
    event.bufferSeq >= 0
  ) {
    return event.bufferSeq;
  }
  const match = /(\d+)\s*$/.exec(event.eventId);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse a client-supplied reconnect cursor (the `lastEventId` WS query param).
 *
 * Accepts either a bare integer (`"42"`) or the full envelope id (`"evt-42"`),
 * since a client may track whichever form it received. Returns the numeric
 * sequence the client has already applied, or `null` when the cursor is absent
 * or not a valid non-negative integer — in which case the caller falls back to
 * the default tail replay (backward-compatible: no cursor => prior behavior).
 */
export function parseEventCursor(
  raw: string | null | undefined,
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(?:evt-)?(\d+)$/.exec(trimmed);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Select a bounded replay and describe any events that cannot be replayed.
 *
 * A valid cursor receives only newer envelopes, preserving buffer order and
 * the historical most-recent limit. `gap` is non-null when retention, that
 * limit, an unsequenced envelope, or a cursor from a later sequence epoch
 * prevents the replay from being complete. An absent cursor keeps the legacy
 * tail behavior and never reports a gap because it makes no completeness
 * claim.
 *
 * Does not mutate the input buffer and does not reorder events.
 */
export function selectReplay<T extends ReplayableEvent>(
  buffer: readonly T[],
  cursor: number | null,
  limit: number = DEFAULT_REPLAY_LIMIT,
): ReplaySelection<T> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (cursor === null) {
    return {
      events:
        cap === 0
          ? []
          : cap >= buffer.length
            ? buffer.slice()
            : buffer.slice(-cap),
      gap: null,
    };
  }

  const sequenced = buffer.flatMap((event) => {
    const seq = eventSequence(event);
    return seq === null ? [] : [{ event, seq }];
  });
  const orderedSequences = [...new Set(sequenced.map(({ seq }) => seq))].sort(
    (left, right) => left - right,
  );
  const availableFrom = orderedSequences[0] ?? null;
  const availableThrough = orderedSequences.at(-1) ?? null;
  const cursorAhead =
    (availableThrough === null && cursor > 0) ||
    (availableThrough !== null && cursor > availableThrough);
  // A cursor from a prior server epoch cannot order the current epoch. Replay
  // the available tail alongside the gap so clients can still recover useful
  // recent state after performing their authoritative HTTP refresh.
  const missing = cursorAhead
    ? sequenced
    : sequenced.filter(({ seq }) => seq > cursor);
  const replayed = cap === 0 ? [] : missing.slice(-cap);
  const reasons: WebSocketReplayGapReason[] = [];

  if (sequenced.length !== buffer.length) reasons.push("unsequenced-event");

  if (cursorAhead) {
    reasons.push("cursor-ahead");
  } else {
    const afterCursor = orderedSequences.filter((seq) => seq > cursor);
    let expected = cursor + 1;
    for (const seq of afterCursor) {
      if (seq > expected) {
        reasons.push("retention-gap");
        break;
      }
      expected = Math.max(expected, seq + 1);
    }
  }

  if (replayed.length < missing.length) reasons.push("replay-limit");

  const events = replayed.map(({ event }) => event);
  const replayedSequences = replayed.map(({ seq }) => seq);
  return {
    events,
    gap:
      reasons.length === 0
        ? null
        : {
            type: "replay-gap",
            version: 1,
            requestedAfter: cursor,
            availableFrom,
            availableThrough,
            replayedFrom: replayedSequences[0] ?? null,
            replayedThrough: replayedSequences.at(-1) ?? null,
            reasons,
          },
  };
}

/**
 * Compatibility wrapper for callers that only consume the bounded event list.
 * New transport code should use `selectReplay` so it cannot hide a gap.
 */
export function selectReplayEvents<T extends ReplayableEvent>(
  buffer: readonly T[],
  cursor: number | null,
  limit: number = DEFAULT_REPLAY_LIMIT,
): T[] {
  const selection = selectReplay(buffer, cursor, limit);
  return selection.gap?.reasons.includes("cursor-ahead")
    ? []
    : selection.events;
}
