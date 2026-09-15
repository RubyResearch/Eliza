/**
 * Tests for the post-meeting transcript producer.
 *
 * The fixture is a realistic diarized `TranscriptSegment[]` — natural spoken
 * utterances ("We decided to…", "Ava will send… by Friday", "I'll confirm…"),
 * NOT pre-formatted "Decision:"/"Action:" lines — so the assertions prove the
 * extractor actually reads meeting language rather than a shape authored to
 * match its own regexes. Extraction is deterministic (pure function), so
 * decisions, care-about hits, commitments, and the canonical
 * `ApprovalEnqueueInput` follow-ups/calendar deadlines all have exact
 * assertions. The `.integration.test.ts` sibling proves the consumer drives a
 * real approval queue.
 */

import type { TranscriptSegment } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  analyzeMeetingGhostTranscript,
  createMeetingGhostCommitmentLedgerRecord,
} from "../src/lifeops/meeting-ghost/index.js";

const approvalExpiresAt = new Date("2026-07-06T20:00:00.000Z");

/** A diarized span with no per-word timing (segment-level highlighting). */
function seg(
  speakerLabel: string,
  startMs: number,
  text: string,
): TranscriptSegment {
  return {
    id: `${speakerLabel}-${startMs}`,
    speakerLabel,
    startMs,
    endMs: startMs + 8_000,
    text,
    words: [],
  };
}

function analyzeSeededTranscript() {
  return analyzeMeetingGhostTranscript({
    owner: {
      ownerUserId: "owner-1",
      ownerDisplayName: "Shaw",
      requestedBy: "meeting-ghost",
      careAbouts: ["launch date"],
      calendarId: "primary",
      approvalExpiresAt,
    },
    transcript: {
      meetingId: "ops-sync-2026-07-06",
      title: "Ops Sync",
      startedAt: "2026-07-06T16:00:00.000Z",
      timeZone: "UTC",
      attendees: [
        { name: "Mira", email: "mira@example.com" },
        { name: "Ava", email: "ava@example.com" },
        { name: "Ben", email: "ben@example.com" },
        { name: "Priya", email: "priya@example.com" },
      ],
      segments: [
        seg(
          "Mira",
          30_000,
          "Budget is unchanged and the support rotation is fine.",
        ),
        seg(
          "Ava",
          120_000,
          "We decided to move the launch date from July 18 to July 22 because QA found a payments blocker.",
        ),
        seg(
          "Ben",
          180_000,
          "The team agreed to keep the pricing announcement embargoed until partner sign-off.",
        ),
        seg(
          "Mira",
          240_000,
          "Ava will send the launch-date rollback plan by Friday.",
        ),
        seg(
          "Mira",
          300_000,
          "Ben is going to update the public calendar by 2026-07-10.",
        ),
        seg("Priya", 360_000, "I'll confirm partner sign-off by tomorrow."),
      ],
    },
  });
}

describe("meeting ghost transcript analysis", () => {
  it("fires care-about hits on every launch-date mention while ignoring unrelated transcript", () => {
    const analysis = analyzeSeededTranscript();

    // "launch date" surfaces in the reprioritization decision and in the
    // rollback-plan action item; the owner cares about both.
    expect(analysis.careHits.map((hit) => hit.speaker)).toEqual([
      "Ava",
      "Mira",
    ]);
    expect(analysis.careHits[0]).toMatchObject({
      careAbout: "launch date",
      speaker: "Ava",
      text: "We decided to move the launch date from July 18 to July 22 because QA found a payments blocker.",
    });
    // The word-order-shifted phrase ("move the launch date") still matches the
    // care-about token set — extraction reads meaning, not a canned prefix.
    expect(analysis.careHits.map((hit) => hit.text).join("\n")).not.toContain(
      "support rotation",
    );
  });

  it("extracts spoken decisions without an authored 'Decision:' prefix", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.decisions.map((d) => d.text)).toEqual([
      "move the launch date from July 18 to July 22 because QA found a payments blocker",
      "keep the pricing announcement embargoed until partner sign-off",
    ]);
    expect(analysis.decisions[0].speaker).toBe("Ava");
    expect(analysis.decisions[0].sourceOffsetMs).toBe(120_000);
  });

  it("keeps the digest to three lines and retains the decisions first", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.digestLines).toHaveLength(3);
    expect(analysis.digestLines[0]).toBe(
      "Decision: move the launch date from July 18 to July 22 because QA found a payments blocker",
    );
    expect(analysis.digestLines[1]).toBe(
      "Decision: keep the pricing announcement embargoed until partner sign-off",
    );
    expect(analysis.digestLines[2]).toContain("Care-about hit (launch date)");
  });

  it("extracts exact who/what/when commitments from natural transcript language", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.commitments).toEqual([
      expect.objectContaining({
        who: "Ava",
        recipientEmail: "ava@example.com",
        what: "send the launch-date rollback plan",
        dueText: "Friday",
        dueDate: "2026-07-10",
        sourceOffsetMs: 240_000,
      }),
      expect.objectContaining({
        who: "Ben",
        recipientEmail: "ben@example.com",
        what: "update the public calendar",
        dueText: "2026-07-10",
        dueDate: "2026-07-10",
        sourceOffsetMs: 300_000,
      }),
      expect.objectContaining({
        who: "Priya",
        recipientEmail: "priya@example.com",
        what: "confirm partner sign-off",
        dueText: "tomorrow",
        dueDate: "2026-07-07",
        sourceOffsetMs: 360_000,
      }),
    ]);
  });

  it("normalizes transcript commitments into ledger rows with meeting provenance", () => {
    const analysis = analyzeMeetingGhostTranscript({
      agentId: "agent-meeting-1",
      owner: {
        ownerUserId: "owner-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "ops-sync-2026-07-06",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [{ name: "Ava", email: "ava@example.com" }],
        segments: [
          seg(
            "Mira",
            240_000,
            "Ava will send the launch-date rollback plan by Friday.",
          ),
        ],
      },
    });

    expect(analysis.commitmentLedgerRecords).toHaveLength(1);
    expect(analysis.commitmentLedgerRecords[0]).toMatchObject({
      agentId: "agent-meeting-1",
      source: "transcript",
      sourceKey: `ops-sync-2026-07-06:${analysis.commitments[0].id}`,
      kind: "commitment",
      summary: "send the launch-date rollback plan",
      counterparty: "Ava",
      dueAt: "2026-07-10T17:00:00.000Z",
      confidence: 0.86,
      status: "open",
      scheduledTaskId: null,
      metadata: {
        meetingId: "ops-sync-2026-07-06",
        meetingTitle: "Ops Sync",
        meetingStartedAt: "2026-07-06T16:00:00.000Z",
        commitmentId: analysis.commitments[0].id,
        sourceText: "Ava will send the launch-date rollback plan by Friday.",
        sourceOffsetMs: 240_000,
        dueText: "Friday",
        recipientEmail: "ava@example.com",
      },
      createdAt: "2026-07-06T16:00:00.000Z",
      updatedAt: "2026-07-06T16:00:00.000Z",
    });

    const rebuilt = createMeetingGhostCommitmentLedgerRecord({
      agentId: "agent-meeting-1",
      transcript: {
        meetingId: "ops-sync-2026-07-06",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [{ name: "Ava", email: "ava@example.com" }],
        segments: [],
      },
      commitment: analysis.commitments[0],
    });
    expect(rebuilt.id).toBe(analysis.commitmentLedgerRecords[0].id);
  });

  it("emits canonical ApprovalEnqueueInput follow-ups ready for the approval queue", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.followUpApprovals).toHaveLength(3);
    // Shape matches ApprovalEnqueueInput exactly (feeds ApprovalQueue.enqueue).
    expect(analysis.followUpApprovals[0]).toEqual({
      requestedBy: "meeting-ghost",
      subjectUserId: "owner-1",
      action: "send_email",
      channel: "email",
      reason: "Queue owner-approved follow-up for Ava from Ops Sync",
      expiresAt: approvalExpiresAt,
      payload: {
        action: "send_email",
        to: ["ava@example.com"],
        cc: [],
        bcc: [],
        subject: "Follow-up from Ops Sync",
        body: expect.stringContaining(
          "please send the launch-date rollback plan by Friday",
        ),
        threadId: null,
        replyToMessageId: null,
      },
    });
  });

  it("creates approval-gated calendar deadline intents for dated commitments", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.calendarIntents).toHaveLength(3);
    expect(analysis.calendarIntents.map((intent) => intent.approval)).toEqual([
      expect.objectContaining({
        action: "schedule_event",
        channel: "google_calendar",
        payload: expect.objectContaining({
          action: "schedule_event",
          calendarId: "primary",
          title: "Deadline: send the launch-date rollback plan",
          attendees: ["ava@example.com"],
          startsAtMs: Date.parse("2026-07-10T09:00:00.000Z"),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Deadline: update the public calendar",
          attendees: ["ben@example.com"],
          startsAtMs: Date.parse("2026-07-10T09:00:00.000Z"),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Deadline: confirm partner sign-off",
          attendees: ["priya@example.com"],
          startsAtMs: Date.parse("2026-07-07T09:00:00.000Z"),
        }),
      }),
    ]);
  });

  it("ignores small talk and unassignable chatter (no false commitments)", () => {
    const analysis = analyzeMeetingGhostTranscript({
      owner: {
        ownerUserId: "owner-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "chatter-only",
        title: "Standup",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [{ name: "Mira", email: "mira@example.com" }],
        segments: [
          seg("Mira", 0, "Morning everyone, how was the weekend?"),
          seg("Mira", 5_000, "The coffee machine is broken again."),
          seg("Mira", 10_000, "Anyway, nothing blocking on my side."),
        ],
      },
    });

    expect(analysis.decisions).toHaveLength(0);
    expect(analysis.commitments).toHaveLength(0);
    expect(analysis.careHits).toHaveLength(0);
    expect(analysis.followUpApprovals).toHaveLength(0);
    expect(analysis.calendarIntents).toHaveLength(0);
    expect(analysis.digestLines).toHaveLength(0);
  });

  it("requires a word boundary before first-person commitment verbs", () => {
    const analysis = analyzeMeetingGhostTranscript({
      owner: {
        ownerUserId: "owner-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: [],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "joined-subject-words",
        title: "Standup",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [{ name: "Mira", email: "mira@example.com" }],
        segments: [
          seg("Mira", 0, "iwill send the plan tomorrow"),
          seg("Mira", 5_000, "wewill update the calendar tomorrow"),
        ],
      },
    });

    expect(analysis.commitments).toHaveLength(0);
  });
});
