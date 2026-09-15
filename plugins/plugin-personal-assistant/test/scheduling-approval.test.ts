/**
 * Scheduling approval integrity tests pin the exact transport envelope that an
 * owner reviews. The suite is deterministic and exercises no connector or
 * persistence seams.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalPayload } from "../src/lifeops/approval-queue.types.js";
import {
  attachSchedulingApprovalCorrelation,
  computeSchedulingApprovalContentSha256,
  readSchedulingApprovalCorrelation,
  verifySchedulingApprovalContent,
} from "../src/lifeops/scheduling-approval.js";
import {
  withRequiredTransaction,
  withTransaction,
} from "../src/lifeops/sql.js";

function correlatedEmail(): Extract<ApprovalPayload, { action: "send_email" }> {
  return attachSchedulingApprovalCorrelation(
    {
      action: "send_email",
      to: ["co-parent@example.com"],
      cc: ["family-assistant@example.com"],
      bcc: [],
      subject: "Scheduling: school conference",
      body: "Would Tuesday at 4:00 PM work for the school conference?",
      threadId: "thread-17",
      replyToMessageId: "message-41",
    },
    {
      kind: "scheduling_message",
      negotiationId: "negotiation-17",
      proposalId: "proposal-41",
      messageKind: "proposal",
      transportChannel: "email",
      sourceUpdatedAt: "2026-07-26T18:30:00.000Z",
      counterpartyEntityId: "co-parent-17",
      counterpartyEntityUpdatedAt: "2026-07-26T18:20:00.000Z",
      draftVersion: 1,
    },
  );
}

function correlatedMessage(): Extract<
  ApprovalPayload,
  { action: "send_message" }
> {
  return attachSchedulingApprovalCorrelation(
    {
      action: "send_message",
      recipient: "+15555550123",
      body: "Would Tuesday at 4:00 PM work for the school conference?",
      replyToMessageId: null,
    },
    {
      kind: "scheduling_message",
      negotiationId: "negotiation-17",
      proposalId: "proposal-41",
      messageKind: "proposal",
      transportChannel: "sms",
      sourceUpdatedAt: "2026-07-26T18:30:00.000Z",
      counterpartyEntityId: "co-parent-17",
      counterpartyEntityUpdatedAt: "2026-07-26T18:20:00.000Z",
      draftVersion: 1,
    },
  );
}

describe("scheduling approval integrity", () => {
  it("rejects non-transactional adapters for multi-record LifeOps mutations", async () => {
    const runtime = {
      agentId: "agent-no-transaction",
      adapter: {
        db: {
          execute: async () => ({ rows: [] }),
        },
      },
    } as never;

    await expect(
      withTransaction(runtime, async () => "must-not-run"),
    ).rejects.toMatchObject({
      code: "LIFEOPS_TRANSACTION_REQUIRED",
      severity: "fatal",
    });
  });

  it("fails closed when the runtime database cannot provide a real transaction", async () => {
    const runtime = {
      agentId: "agent-no-transaction",
      adapter: {
        db: {
          execute: async () => ({ rows: [] }),
        },
      },
    } as never;

    await expect(
      withRequiredTransaction(runtime, async () => "must-not-run"),
    ).rejects.toMatchObject({
      code: "LIFEOPS_ATOMIC_TRANSACTION_REQUIRED",
      severity: "fatal",
    });
  });

  it("binds a deterministic SHA-256 to the exact email and scheduling identity", () => {
    const first = correlatedEmail();
    const second = correlatedEmail();
    const correlation = readSchedulingApprovalCorrelation(first);

    expect(correlation).not.toBeNull();
    expect(correlation?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(correlation?.contentSha256).toBe(
      readSchedulingApprovalCorrelation(second)?.contentSha256,
    );
    expect(computeSchedulingApprovalContentSha256(first)).toBe(
      correlation?.contentSha256,
    );
    expect(verifySchedulingApprovalContent(first)).toMatchObject({
      matches: true,
      actualSha256: correlation?.contentSha256,
    });
  });

  it.each([
    [
      "sender",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.grantId = "another-sender";
      },
    ],
    [
      "recipient",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.to = ["attacker@example.com"];
      },
    ],
    [
      "cc",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.cc = [];
      },
    ],
    [
      "subject",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.subject = "Different subject";
      },
    ],
    [
      "body",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.body = "Different time and place";
      },
    ],
    [
      "thread",
      (payload: ReturnType<typeof correlatedEmail>) => {
        payload.threadId = "thread-other";
      },
    ],
    [
      "negotiation",
      (payload: ReturnType<typeof correlatedEmail>) => {
        if (!payload.scheduling) throw new Error("missing scheduling");
        payload.scheduling = {
          ...payload.scheduling,
          negotiationId: "negotiation-other",
        };
      },
    ],
    [
      "proposal",
      (payload: ReturnType<typeof correlatedEmail>) => {
        if (!payload.scheduling) throw new Error("missing scheduling");
        payload.scheduling = {
          ...payload.scheduling,
          proposalId: "proposal-other",
        };
      },
    ],
    [
      "source timestamp",
      (payload: ReturnType<typeof correlatedEmail>) => {
        if (!payload.scheduling) throw new Error("missing scheduling");
        payload.scheduling = {
          ...payload.scheduling,
          sourceUpdatedAt: "2026-07-26T18:31:00.000Z",
        };
      },
    ],
  ])("detects a changed %s after owner approval", (_label, mutate) => {
    const payload = structuredClone(correlatedEmail());
    mutate(payload);

    expect(verifySchedulingApprovalContent(payload)).toMatchObject({
      matches: false,
    });
  });

  it("binds message recipient, body, reply target, and transport channel", () => {
    const payload = correlatedMessage();
    expect(verifySchedulingApprovalContent(payload)?.matches).toBe(true);

    const changedRecipient = structuredClone(payload);
    changedRecipient.recipient = "+15555550999";
    expect(verifySchedulingApprovalContent(changedRecipient)?.matches).toBe(
      false,
    );

    const changedReply = structuredClone(payload);
    changedReply.replyToMessageId = "provider-message-1";
    expect(verifySchedulingApprovalContent(changedReply)?.matches).toBe(false);

    const changedChannel = structuredClone(payload);
    if (!changedChannel.scheduling) throw new Error("missing scheduling");
    changedChannel.scheduling = {
      ...changedChannel.scheduling,
      transportChannel: "imessage",
    };
    expect(verifySchedulingApprovalContent(changedChannel)?.matches).toBe(
      false,
    );
  });

  it("rejects malformed typed correlation instead of treating it as generic approval", () => {
    const malformed = correlatedMessage();
    if (!malformed.scheduling) throw new Error("missing scheduling");
    malformed.scheduling = {
      ...malformed.scheduling,
      contentSha256: "not-a-sha",
    };

    expect(() => readSchedulingApprovalCorrelation(malformed)).toThrow(
      "expected lowercase SHA-256",
    );
  });

  it("rejects structurally inconsistent scheduling correlation", () => {
    const wrongTransport = correlatedMessage();
    if (!wrongTransport.scheduling) throw new Error("missing scheduling");
    wrongTransport.scheduling = {
      ...wrongTransport.scheduling,
      transportChannel: "email",
    };
    expect(() => readSchedulingApprovalCorrelation(wrongTransport)).toThrow(
      "send_message does not match email",
    );

    const proposalWithoutId = correlatedMessage();
    if (!proposalWithoutId.scheduling) throw new Error("missing scheduling");
    proposalWithoutId.scheduling = {
      ...proposalWithoutId.scheduling,
      proposalId: null,
    };
    expect(() => readSchedulingApprovalCorrelation(proposalWithoutId)).toThrow(
      "proposal drafts require a proposal",
    );

    const nonCanonicalTimestamp = correlatedMessage();
    if (!nonCanonicalTimestamp.scheduling) {
      throw new Error("missing scheduling");
    }
    nonCanonicalTimestamp.scheduling = {
      ...nonCanonicalTimestamp.scheduling,
      sourceUpdatedAt: "2026-07-26",
    };
    expect(() =>
      readSchedulingApprovalCorrelation(nonCanonicalTimestamp),
    ).toThrow("expected canonical UTC ISO-8601 timestamp");
  });
});
