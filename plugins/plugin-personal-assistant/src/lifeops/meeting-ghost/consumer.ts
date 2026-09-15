/**
 * Queues owner-reviewed follow-ups and calendar deadlines from finalized
 * transcripts, then persists commitments in the shared ledger. Email approvals
 * bind the connected sender before any queue or ledger writes; retries compare
 * the complete saved envelope, including that sender.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { INTERNAL_URL } from "../access.js";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalRequest,
} from "../approval-queue.types.js";
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
  let analysis = analyzeMeetingGhostTranscript({
    agentId: input.agentId,
    transcript: input.transcript,
    owner: input.owner,
  });

  if (analysis.followUpApprovals.length) {
    const { LifeOpsService } = await import("../service.js");
    const grant = await new LifeOpsService(runtime, {
      ownerEntityId: input.owner.ownerUserId,
    }).requireGoogleGmailSendGrant(INTERNAL_URL, "local", "owner");
    if (!grant.id || !grant.identityEmail)
      throw new ElizaError(
        "Reconnect the Google sender before reviewing meeting follow-ups.",
        { code: "MEETING_FOLLOWUP_SENDER_UNAVAILABLE" },
      );
    analysis = {
      ...analysis,
      followUpApprovals: analysis.followUpApprovals.map((request) => ({
        ...request,
        payload: { ...request.payload, grantId: grant.id },
        reason: `${request.reason}\nFrom: ${grant.identityEmail}`,
      })),
    };
  }

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
