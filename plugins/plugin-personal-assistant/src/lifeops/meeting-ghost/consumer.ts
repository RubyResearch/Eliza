/**
 * Runtime consumer that turns a finalized meeting transcript into queued owner
 * approvals and commitment-ledger rows — the reachable path that makes
 * `analyzeMeetingGhostTranscript` (a pure function in `./index.ts`) act on the
 * system.
 *
 * A caller (the meeting post-processing hook, or a scheduled-task watcher that
 * reads finalized `TranscriptSegment[]` off the `transcripts` memory table)
 * hands us the diarized transcript the owner skipped plus their context. We
 * derive the follow-up emails and calendar-deadline events the owner would send
 * if they had attended, enqueue each as an owner-approval request through the
 * shared `ApprovalQueue`, then persist the extracted promises to the shared
 * commitment ledger. External effects stay behind the owner's one-tap
 * approve/reject, never auto-sent; ledger rows make the owed follow-ups
 * auditable even before approval.
 *
 * `analyzeMeetingGhostTranscript` already emits `ApprovalEnqueueInput[]` and
 * ledger records, so this is a routing pass: analyze, then write each side
 * effect. Failures surface (no swallow) so a broken approval or ledger pipeline
 * is observable. A transcript without a `timeZone` is stamped with the owner's
 * zone first so relative due dates resolve on the owner's calendar day rather
 * than the process zone of whatever host runs the consumer.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalRequest,
} from "../approval-queue.types.js";
import { resolveOwnerTimeZone } from "../owner/fact-store.js";
import { LifeOpsRepository } from "../repository.js";
import {
  analyzeMeetingGhostTranscript,
  type MeetingGhostAnalysis,
  type MeetingGhostOwnerContext,
  type MeetingGhostTranscript,
} from "./index.js";

export interface RunMeetingGhostInput {
  readonly agentId: string;
  readonly transcript: MeetingGhostTranscript;
  readonly owner: MeetingGhostOwnerContext;
}

export interface MeetingGhostRunResult {
  readonly analysis: MeetingGhostAnalysis;
  /**
   * Approval requests for this run (follow-ups then calendar deadlines). A
   * retry returns matching existing requests instead of duplicating owner prompts.
   */
  readonly enqueued: readonly ApprovalRequest[];
  /** Commitment ledger ids persisted for extracted transcript commitments. */
  readonly commitmentLedgerIds: readonly string[];
}

function stablePayloadJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stablePayloadJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePayloadJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameApprovalRequest(
  request: ApprovalRequest,
  input: ApprovalEnqueueInput,
): boolean {
  return (
    request.requestedBy === input.requestedBy &&
    request.subjectUserId === input.subjectUserId &&
    request.action === input.action &&
    request.channel === input.channel &&
    request.reason === input.reason &&
    stablePayloadJson(request.payload) === stablePayloadJson(input.payload)
  );
}

async function enqueueOrReuseApproval(
  queue: ReturnType<typeof createApprovalQueue>,
  request: ApprovalEnqueueInput,
): Promise<ApprovalRequest> {
  const existing = await queue.list({
    subjectUserId: request.subjectUserId,
    state: null,
    action: request.action,
    limit: 500,
  });
  const match = existing.find((entry) => sameApprovalRequest(entry, request));
  if (match) return match;
  return queue.enqueue(request);
}

// The owner's zone is evaluated at the meeting instant so an active travel
// window covers the meeting; an unparseable `startedAt` yields no relative due
// dates anyway, so the current instant is only used to pick the zone.
function ownerZoneInstant(startedAt: string): Date {
  const at = new Date(startedAt);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

/**
 * Analyze the transcript and enqueue every derived owner-approval request.
 * Follow-up emails enqueue before calendar-deadline events so the owner sees
 * the reply drafts first. Returns the analysis alongside the created requests
 * so callers can render the digest and cite the queued approvals.
 */
export async function runMeetingGhostForTranscript(
  runtime: IAgentRuntime,
  input: RunMeetingGhostInput,
): Promise<MeetingGhostRunResult> {
  const transcript = input.transcript.timeZone
    ? input.transcript
    : {
        ...input.transcript,
        timeZone: await resolveOwnerTimeZone(
          runtime,
          ownerZoneInstant(input.transcript.startedAt),
        ),
      };
  const analysis = analyzeMeetingGhostTranscript({
    agentId: input.agentId,
    transcript,
    owner: input.owner,
  });

  const requests = [
    ...analysis.followUpApprovals,
    ...analysis.calendarIntents.map((intent) => intent.approval),
  ];

  const queue = createApprovalQueue(runtime, { agentId: input.agentId });
  const enqueued: ApprovalRequest[] = [];
  for (const request of requests) {
    enqueued.push(await enqueueOrReuseApproval(queue, request));
  }

  const adapter = (runtime as { adapter?: { db?: unknown } }).adapter;
  const commitmentLedgerIds: string[] = [];
  if (adapter?.db) {
    const repository = new LifeOpsRepository(runtime);
    for (const record of analysis.commitmentLedgerRecords) {
      await repository.upsertCommitmentLedgerRecord(record);
      commitmentLedgerIds.push(record.id);
    }
  } else if (analysis.commitmentLedgerRecords.length > 0) {
    logger.debug(
      `[meeting-ghost] commitment ledger unavailable for ${input.transcript.meetingId}; runtime has no SQL adapter`,
    );
  }

  logger.info(
    `[meeting-ghost] ${input.transcript.meetingId}: ${analysis.decisions.length} decisions, ${analysis.commitments.length} commitments, ${enqueued.length} approvals queued, ${commitmentLedgerIds.length} ledger rows persisted`,
  );

  return { analysis, enqueued, commitmentLedgerIds };
}
