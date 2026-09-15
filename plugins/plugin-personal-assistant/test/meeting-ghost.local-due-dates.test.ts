/**
 * Pins meeting-ghost relative due dates ("tomorrow", "by Friday") to the
 * meeting's local calendar day and the ledger/calendar instants to that zone,
 * for meetings whose local evening is already the next UTC day (Pacific) and
 * whose local morning is still the previous UTC day (Japan). Deterministic:
 * drives the pure analyzer, with the process zone switched to prove the
 * fallback when the transcript carries no zone.
 */
import type { TranscriptSegment } from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeMeetingGhostTranscript,
  type MeetingGhostTranscript,
} from "../src/lifeops/meeting-ghost/index.js";

const ORIGINAL_TZ = process.env.TZ;

const owner = {
  ownerUserId: "owner-1",
  ownerDisplayName: "Shaw",
  requestedBy: "meeting-ghost",
  careAbouts: [],
  calendarId: "primary",
  approvalExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
};

function seg(speakerLabel: string, text: string): TranscriptSegment {
  return {
    id: `${speakerLabel}-0`,
    speakerLabel,
    startMs: 0,
    endMs: 8_000,
    text,
    words: [],
  };
}

function analyze(input: {
  startedAt: string;
  timeZone?: string;
  utterance: string;
}) {
  const transcript: MeetingGhostTranscript = {
    meetingId: "mtg-local-day",
    title: "Planning",
    startedAt: input.startedAt,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    attendees: [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ],
    segments: [seg("Mira", input.utterance)],
  };
  return analyzeMeetingGhostTranscript({
    agentId: "agent-1",
    owner,
    transcript,
  });
}

const CASES = [
  {
    label: "Monday 5:30pm PT, 'by tomorrow' is Tuesday",
    startedAt: "2026-09-14T17:30:00-07:00",
    timeZone: "America/Los_Angeles",
    utterance: "Alice will send the report by tomorrow",
    dueDate: "2026-09-15",
    ledgerDueAt: "2026-09-16T00:00:00.000Z",
    calendarStartsAt: "2026-09-15T16:00:00.000Z",
  },
  {
    label: "Thursday 5:30pm PT, 'by Friday' is the next day",
    startedAt: "2026-09-17T17:30:00-07:00",
    timeZone: "America/Los_Angeles",
    utterance: "Bob will send the deck by Friday",
    dueDate: "2026-09-18",
    ledgerDueAt: "2026-09-19T00:00:00.000Z",
    calendarStartsAt: "2026-09-18T16:00:00.000Z",
  },
  {
    label: "Monday 8am JST, 'by tomorrow' is Tuesday",
    startedAt: "2026-09-14T08:00:00+09:00",
    timeZone: "Asia/Tokyo",
    utterance: "Alice will send the report by tomorrow",
    dueDate: "2026-09-15",
    ledgerDueAt: "2026-09-15T08:00:00.000Z",
    calendarStartsAt: "2026-09-15T00:00:00.000Z",
  },
  {
    label: "Monday 8am JST, 'by Monday' is the following Monday",
    startedAt: "2026-09-14T08:00:00+09:00",
    timeZone: "Asia/Tokyo",
    utterance: "Carol will file the taxes by Monday",
    dueDate: "2026-09-21",
    ledgerDueAt: "2026-09-21T08:00:00.000Z",
    calendarStartsAt: "2026-09-21T00:00:00.000Z",
  },
] as const;

describe("meeting-ghost relative due dates on the meeting's local day", () => {
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  describe.each(CASES)(
    "$label",
    ({
      startedAt,
      timeZone,
      utterance,
      dueDate,
      ledgerDueAt,
      calendarStartsAt,
    }) => {
      it("uses the transcript zone for the due day and the 5pm/9am instants", () => {
        const analysis = analyze({ startedAt, timeZone, utterance });

        expect(analysis.commitments).toHaveLength(1);
        expect(analysis.commitments[0]?.dueDate).toBe(dueDate);
        expect(analysis.commitmentLedgerRecords[0]?.dueAt).toBe(ledgerDueAt);
        expect(analysis.calendarIntents).toHaveLength(1);
        expect(analysis.calendarIntents[0]?.approval.payload).toMatchObject({
          action: "schedule_event",
          startsAtMs: Date.parse(calendarStartsAt),
          endsAtMs: Date.parse(calendarStartsAt) + 30 * 60 * 1000,
        });
      });

      it("falls back to the process zone when the transcript carries none", () => {
        process.env.TZ = timeZone;
        const analysis = analyze({ startedAt, utterance });

        expect(analysis.commitments[0]?.dueDate).toBe(dueDate);
        expect(analysis.commitmentLedgerRecords[0]?.dueAt).toBe(ledgerDueAt);
        expect(analysis.calendarIntents[0]?.approval.payload).toMatchObject({
          startsAtMs: Date.parse(calendarStartsAt),
        });
      });
    },
  );

  it("keeps an explicit YYYY-MM-DD due text on that day in the meeting zone", () => {
    const analysis = analyze({
      startedAt: "2026-09-14T17:30:00-07:00",
      timeZone: "America/Los_Angeles",
      utterance: "Bob will send the deck by 2026-09-18",
    });

    expect(analysis.commitments[0]?.dueDate).toBe("2026-09-18");
    expect(analysis.commitmentLedgerRecords[0]?.dueAt).toBe(
      "2026-09-19T00:00:00.000Z",
    );
  });

  it("does not roll an impossible explicit date into a ledger instant or calendar block", () => {
    const analysis = analyze({
      startedAt: "2026-02-16T17:30:00-08:00",
      timeZone: "America/Los_Angeles",
      utterance: "Bob will send the deck by 2026-02-30",
    });

    expect(analysis.commitments).toHaveLength(1);
    expect(analysis.commitmentLedgerRecords[0]?.dueAt).toBeNull();
    expect(analysis.calendarIntents).toEqual([]);
  });
});
