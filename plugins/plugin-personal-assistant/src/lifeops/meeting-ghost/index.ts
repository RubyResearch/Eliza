/**
 * Transcript-side producer for meetings the owner skipped.
 *
 * Given a finalized, diarized meeting transcript (the canonical
 * `TranscriptSegment[]` that `@elizaos/plugin-meetings`' pipeline `finalize()`
 * produces) plus owner context, this module derives the deterministic
 * post-meeting shape LifeOps acts on: decisions, care-about hits, extracted
 * commitments, commitment-ledger rows, a short digest, and — the part that
 * leaves the module — owner-approval requests as `ApprovalEnqueueInput[]` that
 * feed `ApprovalQueue.enqueue()` directly (no re-mapping at the call site). The
 * scheduled-task consumer that runs this on a real transcript and routes the
 * side effects lives in `./consumer.ts`.
 *
 * It is deliberately pure so tests can pin care-about filtering and commitment
 * extraction against a realistic diarized fixture without mocking connectors.
 * Extraction is heuristic (regex over natural utterances); a model-driven pass
 * is out of scope here (tracked by #14870 for ASR that these rules miss).
 *
 * Relative due dates ("tomorrow", "by Friday") resolve on the meeting's local
 * calendar day, and the 17:00 ledger `dueAt` and 09:00 calendar deadline are
 * wall times in that zone. Zone precedence: `MeetingGhostTranscript.timeZone`
 * when the transcript carries one; otherwise the runtime's owner-configured
 * zone, which `./consumer.ts` resolves and stamps onto the transcript before
 * analysis; otherwise the process zone, the only fallback this pure function
 * can see.
 */

import type { TranscriptSegment } from "@elizaos/shared";
import { normalizeTimeZone } from "@elizaos/shared";
import type {
  ApprovalEnqueueInput,
  ApprovalPayload,
} from "../approval-queue.types.js";
import type { LifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import { createLifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getWeekdayForLocalDate,
  getZonedDateParts,
  type ZonedDateParts,
} from "../time.js";

/** Local wall-clock hour a dated commitment falls due in the ledger. */
const LEDGER_DUE_HOUR = 17;
/** Local wall-clock hour the calendar deadline block starts. */
const CALENDAR_DEADLINE_HOUR = 9;

export interface MeetingGhostAttendee {
  readonly name: string;
  readonly email?: string;
}

/** Meeting metadata wrapping the canonical diarized segments. */
export interface MeetingGhostTranscript {
  readonly meetingId: string;
  readonly title: string;
  readonly startedAt: string;
  /**
   * IANA zone of the meeting's local calendar day. Absent means the caller
   * did not know it; `runMeetingGhostForTranscript` fills in the owner's zone
   * and the pure analyzer falls back to the process zone.
   */
  readonly timeZone?: string;
  readonly attendees: readonly MeetingGhostAttendee[];
  readonly segments: readonly TranscriptSegment[];
}

export interface MeetingGhostOwnerContext {
  readonly ownerUserId: string;
  readonly ownerDisplayName: string;
  readonly requestedBy: string;
  readonly careAbouts: readonly string[];
  readonly calendarId?: string;
  readonly approvalExpiresAt: Date;
}

export interface MeetingGhostDecision {
  readonly id: string;
  readonly text: string;
  readonly speaker: string;
  readonly sourceOffsetMs: number | null;
}

export interface MeetingGhostCommitment {
  readonly id: string;
  readonly who: string;
  readonly recipientEmail: string | null;
  readonly what: string;
  readonly dueText: string | null;
  readonly dueDate: string | null;
  readonly sourceText: string;
  readonly sourceOffsetMs: number | null;
}

export interface MeetingGhostCareHit {
  readonly id: string;
  readonly careAbout: string;
  readonly speaker: string;
  readonly text: string;
  readonly sourceOffsetMs: number | null;
}

/** A calendar-deadline approval bound back to the commitment that produced it. */
export interface MeetingGhostCalendarIntent {
  readonly commitmentId: string;
  readonly approval: ApprovalEnqueueInput;
}

export interface MeetingGhostAnalysis {
  readonly meetingId: string;
  readonly decisions: readonly MeetingGhostDecision[];
  readonly commitments: readonly MeetingGhostCommitment[];
  readonly commitmentLedgerRecords: readonly LifeOpsCommitmentLedgerRecord[];
  readonly careHits: readonly MeetingGhostCareHit[];
  /** Ready to feed `ApprovalQueue.enqueue()` directly. */
  readonly followUpApprovals: readonly ApprovalEnqueueInput[];
  readonly calendarIntents: readonly MeetingGhostCalendarIntent[];
  readonly digestLines: readonly string[];
}

// A diarized commitment reads as a natural utterance, so the extractor keys on
// the speaker + a commitment verb ("will send the plan by Friday"), not on a
// literal "Action:" prefix a human would never say aloud. The prefixed forms
// are still accepted for transcripts that carry structured annotations.
function stripOneTerminalPunctuation(value: string): string {
  const last = value[value.length - 1];
  return last === "." || last === ";" ? value.slice(0, -1) : value;
}

function extractStructuredBody(
  value: string,
  prefixes: readonly string[],
): string | null {
  const lower = value.toLowerCase();
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    let cursor = prefix.length;
    while (cursor < value.length && value[cursor]?.trim() === "") cursor += 1;
    if (value[cursor] !== ":" && value[cursor] !== "-") continue;
    cursor += 1;
    while (cursor < value.length && value[cursor]?.trim() === "") cursor += 1;
    return value.slice(cursor) || null;
  }
  return null;
}

function extractSpokenDecision(value: string): string | null {
  const lower = value.toLowerCase();
  for (const subject of ["we", "the team", "everyone", "the group"]) {
    if (!lower.startsWith(`${subject} `)) continue;
    let cursor = subject.length + 1;
    const verb = ["agreed", "decided", "settled", "concluded"].find(
      (candidate) => lower.startsWith(`${candidate} `, cursor),
    );
    if (!verb) continue;
    cursor += verb.length + 1;
    for (const connector of ["that ", "to ", "on "]) {
      if (lower.startsWith(connector, cursor)) {
        cursor += connector.length;
        break;
      }
    }
    return stripOneTerminalPunctuation(value.slice(cursor)) || null;
  }
  return null;
}

function splitCommitmentDue(value: string): {
  what: string;
  due: string | null;
} {
  const unpunctuated = stripOneTerminalPunctuation(value);
  const separator = unpunctuated.toLowerCase().indexOf(" by ");
  if (separator < 0) return { what: unpunctuated, due: null };
  const due = unpunctuated.slice(separator + 4);
  if (due.includes(".") || due.includes(";")) {
    return { what: unpunctuated, due: null };
  }
  return {
    what: unpunctuated.slice(0, separator),
    due,
  };
}

function parseNamedCommitment(value: string): {
  who: string;
  what: string;
  due: string | null;
} | null {
  const lower = value.toLowerCase();
  const verbs = [
    "is going to",
    "committed to",
    "is taking",
    "will",
    "owns",
    "can",
    "to",
  ];
  let earliest:
    | { markerStart: number; marker: string; verbIndex: number }
    | undefined;
  for (const [verbIndex, verb] of verbs.entries()) {
    const marker = ` ${verb} `;
    const markerStart = lower.indexOf(marker);
    if (markerStart < 1) continue;
    if (
      !earliest ||
      markerStart < earliest.markerStart ||
      (markerStart === earliest.markerStart && verbIndex < earliest.verbIndex)
    ) {
      earliest = { markerStart, marker, verbIndex };
    }
  }
  if (!earliest) return null;
  const who = value.slice(0, earliest.markerStart);
  if (who.length < 2 || who.length > 61 || !/[A-Z]/.test(who[0] ?? ""))
    return null;
  if ([...who].some((character) => !/[A-Za-z .'-]/.test(character)))
    return null;
  const split = splitCommitmentDue(
    value.slice(earliest.markerStart + earliest.marker.length),
  );
  return split.what ? { who, ...split } : null;
}

function parseSpeakerCommitment(value: string): {
  what: string;
  due: string | null;
} | null {
  const lower = value.toLowerCase();
  for (const subject of ["i", "we"]) {
    if (!lower.startsWith(subject)) continue;
    let cursor = subject.length;
    const wordBoundary = cursor;
    while (cursor < value.length && value[cursor]?.trim() === "") cursor += 1;
    const hasWhitespaceBoundary = cursor > wordBoundary;
    const verb = [
      "'ll ",
      "will ",
      "can ",
      "am going to ",
      "are going to ",
    ].find((candidate) => lower.startsWith(candidate, cursor));
    if (!verb || (!hasWhitespaceBoundary && verb !== "'ll ")) continue;
    const split = splitCommitmentDue(value.slice(cursor + verb.length));
    if (split.what) return split;
  }
  return null;
}

const WEEKDAYS = new Map([
  ["sunday", 0],
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
  ["friday", 5],
  ["saturday", 6],
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableId(parts: readonly string[]): string {
  return parts
    .map((part) => normalize(part).replace(/\s+/g, "-"))
    .filter(Boolean)
    .join(":");
}

/** Speaker label for a diarized segment; falls back to the entity id. */
function speakerOf(segment: TranscriptSegment): string {
  return segment.speakerLabel ?? segment.speakerEntityId ?? "Unknown";
}

function careAboutMatches(text: string, careAbout: string): boolean {
  const normalizedText = normalize(text);
  const normalizedCare = normalize(careAbout);
  if (!normalizedCare) return false;
  const tokens = normalizedCare.split(" ").filter((token) => token.length > 2);
  if (tokens.length === 0) return false;
  if (normalizedText.includes(normalizedCare)) return true;
  return tokens.every((token) => normalizedText.includes(token));
}

function findAttendeeEmail(
  attendees: readonly MeetingGhostAttendee[],
  name: string,
): string | null {
  const normalizedName = normalize(name);
  const attendee = attendees.find((entry) => {
    const attendeeName = normalize(entry.name);
    return (
      attendeeName === normalizedName ||
      attendeeName.includes(normalizedName) ||
      normalizedName.includes(attendeeName)
    );
  });
  return attendee?.email ?? null;
}

function parseDecision(
  segment: TranscriptSegment,
  index: number,
): MeetingGhostDecision | null {
  const text = compact(segment.text);
  const decision =
    extractStructuredBody(text, [
      "decision",
      "decided",
      "we decided",
      "decision is",
    ]) ??
    extractSpokenDecision(text) ??
    null;
  const compacted = decision ? compact(decision) : "";
  if (!compacted) return null;
  return {
    id: stableId(["decision", String(index), compacted]),
    text: compacted,
    speaker: speakerOf(segment),
    sourceOffsetMs: segment.startMs,
  };
}

function parseCommitmentBody(text: string): {
  who: string | null;
  what: string;
  dueText: string | null;
} | null {
  const body =
    extractStructuredBody(text, ["action", "commitment", "follow-up"]) ?? text;
  const compactedBody = compact(body);
  const named = parseNamedCommitment(compactedBody);
  if (named?.what) {
    return {
      who: compact(named.who),
      what: compact(named.what),
      dueText: named.due ? compact(named.due) : null,
    };
  }
  const speaker = parseSpeakerCommitment(compactedBody);
  if (speaker?.what) {
    return {
      who: null,
      what: compact(speaker.what),
      dueText: speaker.due ? compact(speaker.due) : null,
    };
  }
  return null;
}

type LocalDate = Pick<ZonedDateParts, "year" | "month" | "day">;

function resolveTranscriptTimeZone(transcript: MeetingGhostTranscript): string {
  return normalizeTimeZone(transcript.timeZone);
}

const DUE_DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

// An explicit spoken/annotated `YYYY-MM-DD` is kept verbatim as `dueDate`, so
// the instant builders re-validate it: `Date.UTC` would silently roll an
// impossible day such as 02-30 into the next month.
function parseDueDateKey(dueDate: string): LocalDate | null {
  const match = DUE_DATE_KEY.exec(dueDate);
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return getLocalDateKey(addDaysToLocalDate(parts, 0)) === dueDate
    ? parts
    : null;
}

function parseDueDate(
  dueText: string | null,
  meetingStartedAt: string,
  timeZone: string,
): string | null {
  if (!dueText) return null;
  const trimmed = dueText.trim();
  const explicit = trimmed.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit?.[1]) return explicit[1];

  const base = new Date(meetingStartedAt);
  if (Number.isNaN(base.getTime())) return null;
  const { year, month, day } = getZonedDateParts(base, timeZone);
  const meetingDay: LocalDate = { year, month, day };
  const normalizedDue = normalize(trimmed);
  if (normalizedDue.includes("tomorrow")) {
    return getLocalDateKey(addDaysToLocalDate(meetingDay, 1));
  }

  const weekday = [...WEEKDAYS.entries()].find(([name]) =>
    normalizedDue.includes(name),
  );
  if (weekday) {
    const [, target] = weekday;
    const current = getWeekdayForLocalDate(meetingDay);
    const delta = (target - current + 7) % 7 || 7;
    return getLocalDateKey(addDaysToLocalDate(meetingDay, delta));
  }
  return null;
}

function localInstantOnDueDate(
  dueDate: string | null,
  timeZone: string,
  hour: number,
): Date | null {
  if (!dueDate) return null;
  const parts = parseDueDateKey(dueDate);
  if (!parts) return null;
  return buildUtcDateFromLocalParts(timeZone, {
    ...parts,
    hour,
    minute: 0,
    second: 0,
  });
}

function dueDateToLedgerDueAt(
  dueDate: string | null,
  timeZone: string,
): string | null {
  return (
    localInstantOnDueDate(dueDate, timeZone, LEDGER_DUE_HOUR)?.toISOString() ??
    null
  );
}

function parseCommitment(
  transcript: MeetingGhostTranscript,
  timeZone: string,
  segment: TranscriptSegment,
  index: number,
): MeetingGhostCommitment | null {
  const text = compact(segment.text);
  const parsed = parseCommitmentBody(text);
  if (!parsed) return null;
  const who = parsed.who ?? speakerOf(segment);
  const dueDate = parseDueDate(parsed.dueText, transcript.startedAt, timeZone);
  return {
    id: stableId(["commitment", String(index), who, parsed.what]),
    who,
    recipientEmail: findAttendeeEmail(transcript.attendees, who),
    what: parsed.what,
    dueText: parsed.dueText,
    dueDate,
    sourceText: text,
    sourceOffsetMs: segment.startMs,
  };
}

function buildFollowUpApproval(
  transcript: MeetingGhostTranscript,
  owner: MeetingGhostOwnerContext,
  commitment: MeetingGhostCommitment,
): ApprovalEnqueueInput | null {
  if (!commitment.recipientEmail) return null;
  const subject = `Follow-up from ${transcript.title}`;
  const due = commitment.dueText ? ` by ${commitment.dueText}` : "";
  const payload: ApprovalPayload = {
    action: "send_email",
    to: [commitment.recipientEmail],
    cc: [],
    bcc: [],
    subject,
    body: `${commitment.who},\n\nFollowing up from ${transcript.title}: please ${commitment.what}${due}.\n\n${owner.ownerDisplayName}`,
    threadId: null,
    replyToMessageId: null,
  };
  return {
    requestedBy: owner.requestedBy,
    subjectUserId: owner.ownerUserId,
    action: "send_email",
    channel: "email",
    reason: `Queue owner-approved follow-up for ${commitment.who} from ${transcript.title}`,
    expiresAt: owner.approvalExpiresAt,
    payload,
  };
}

function buildCalendarIntent(
  transcript: MeetingGhostTranscript,
  timeZone: string,
  owner: MeetingGhostOwnerContext,
  commitment: MeetingGhostCommitment,
): MeetingGhostCalendarIntent | null {
  if (!commitment.recipientEmail || !commitment.dueDate || !owner.calendarId) {
    return null;
  }
  const startsAt = localInstantOnDueDate(
    commitment.dueDate,
    timeZone,
    CALENDAR_DEADLINE_HOUR,
  );
  if (!startsAt) return null;
  const startsAtMs = startsAt.getTime();
  const payload: ApprovalPayload = {
    action: "schedule_event",
    calendarId: owner.calendarId,
    title: `Deadline: ${commitment.what}`,
    startsAtMs,
    endsAtMs: startsAtMs + 30 * 60 * 1000,
    attendees: [commitment.recipientEmail],
    location: null,
    description: `Commitment from ${transcript.title}: ${commitment.sourceText}`,
  };
  return {
    commitmentId: commitment.id,
    approval: {
      requestedBy: owner.requestedBy,
      subjectUserId: owner.ownerUserId,
      action: "schedule_event",
      channel: "google_calendar",
      reason: `Place deadline for ${commitment.who}'s commitment from ${transcript.title}`,
      expiresAt: owner.approvalExpiresAt,
      payload,
    },
  };
}

function buildDigestLines(
  decisions: readonly MeetingGhostDecision[],
  careHits: readonly MeetingGhostCareHit[],
  commitments: readonly MeetingGhostCommitment[],
): string[] {
  const lines: string[] = [];
  for (const decision of decisions) {
    lines.push(`Decision: ${decision.text}`);
  }
  for (const hit of careHits) {
    lines.push(`Care-about hit (${hit.careAbout}): ${hit.text}`);
  }
  for (const commitment of commitments) {
    const due = commitment.dueText ? ` by ${commitment.dueText}` : "";
    lines.push(`Commitment: ${commitment.who} -> ${commitment.what}${due}`);
  }
  return lines.slice(0, 3);
}

export function createMeetingGhostCommitmentLedgerRecord(input: {
  readonly agentId: string;
  readonly transcript: MeetingGhostTranscript;
  readonly commitment: MeetingGhostCommitment;
}): LifeOpsCommitmentLedgerRecord {
  return createLifeOpsCommitmentLedgerRecord({
    agentId: input.agentId,
    source: "transcript",
    sourceKey: `${input.transcript.meetingId}:${input.commitment.id}`,
    kind: "commitment",
    summary: input.commitment.what,
    counterparty: input.commitment.who,
    dueAt: dueDateToLedgerDueAt(
      input.commitment.dueDate,
      resolveTranscriptTimeZone(input.transcript),
    ),
    confidence: input.commitment.dueDate ? 0.86 : 0.78,
    metadata: {
      meetingId: input.transcript.meetingId,
      meetingTitle: input.transcript.title,
      meetingStartedAt: input.transcript.startedAt,
      commitmentId: input.commitment.id,
      sourceText: input.commitment.sourceText,
      sourceOffsetMs: input.commitment.sourceOffsetMs,
      dueText: input.commitment.dueText,
      recipientEmail: input.commitment.recipientEmail,
    },
    createdAt: input.transcript.startedAt,
    updatedAt: input.transcript.startedAt,
  });
}

export function analyzeMeetingGhostTranscript(input: {
  readonly agentId?: string;
  readonly transcript: MeetingGhostTranscript;
  readonly owner: MeetingGhostOwnerContext;
}): MeetingGhostAnalysis {
  const decisions: MeetingGhostDecision[] = [];
  const commitments: MeetingGhostCommitment[] = [];
  const careHits: MeetingGhostCareHit[] = [];
  const timeZone = resolveTranscriptTimeZone(input.transcript);

  input.transcript.segments.forEach((segment, index) => {
    const decision = parseDecision(segment, index);
    if (decision) decisions.push(decision);

    // A group decision ("We decided to…", "The team agreed to…") is not an
    // individual's action item — skip commitment extraction on the same
    // segment so a collective verb never becomes a per-person follow-up.
    const commitment = decision
      ? null
      : parseCommitment(input.transcript, timeZone, segment, index);
    if (commitment) commitments.push(commitment);

    for (const careAbout of input.owner.careAbouts) {
      if (careAboutMatches(segment.text, careAbout)) {
        careHits.push({
          id: stableId(["care", String(index), careAbout]),
          careAbout,
          speaker: speakerOf(segment),
          text: compact(segment.text),
          sourceOffsetMs: segment.startMs,
        });
      }
    }
  });

  const followUpApprovals = commitments
    .map((commitment) =>
      buildFollowUpApproval(input.transcript, input.owner, commitment),
    )
    .filter((entry): entry is ApprovalEnqueueInput => entry !== null);
  const calendarIntents = commitments
    .map((commitment) =>
      buildCalendarIntent(input.transcript, timeZone, input.owner, commitment),
    )
    .filter((entry): entry is MeetingGhostCalendarIntent => entry !== null);
  const commitmentLedgerRecords: LifeOpsCommitmentLedgerRecord[] = [];
  if (input.agentId) {
    for (const commitment of commitments) {
      commitmentLedgerRecords.push(
        createMeetingGhostCommitmentLedgerRecord({
          agentId: input.agentId,
          transcript: input.transcript,
          commitment,
        }),
      );
    }
  }

  return {
    meetingId: input.transcript.meetingId,
    decisions,
    commitments,
    commitmentLedgerRecords,
    careHits,
    followUpApprovals,
    calendarIntents,
    digestLines: buildDigestLines(decisions, careHits, commitments),
  };
}
