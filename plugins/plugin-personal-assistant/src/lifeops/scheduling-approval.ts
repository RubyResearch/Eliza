/**
 * Integrity binding for approval-gated scheduling messages. Draft creation,
 * queue validation, and post-approval execution share this canonical envelope
 * so approval always applies to one recipient, channel, subject, and body.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  type ApprovalPayload,
  SCHEDULING_APPROVAL_MESSAGE_KINDS,
  SCHEDULING_APPROVAL_TRANSPORT_CHANNELS,
  type SchedulingApprovalCorrelation,
} from "./approval-queue.types.js";
import type { SchedulingMessageDraft } from "./domains/scheduling-service.js";

type SchedulingSendPayload = Extract<
  ApprovalPayload,
  { action: "send_message" | "send_email" }
>;

export type SchedulingApprovalCorrelationSeed = Omit<
  SchedulingApprovalCorrelation,
  "contentSha256"
>;

const SCHEDULING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function failInvalidCorrelation(
  message: string,
  context: Record<string, unknown>,
): never {
  throw new ElizaError(`[SchedulingApproval] ${message}`, {
    code: "SCHEDULING_APPROVAL_INVALID_CORRELATION",
    context,
    severity: "fatal",
  });
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return failInvalidCorrelation(
      `invalid ${label}.${field}: expected non-empty string`,
      { label, field },
    );
  }
  return value;
}

function parseSchedulingCorrelation(
  value: unknown,
  label: string,
): SchedulingApprovalCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failInvalidCorrelation(
      `invalid ${label}: expected scheduling correlation object`,
      { label },
    );
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "scheduling_message") {
    return failInvalidCorrelation(
      `invalid ${label}.kind: expected scheduling_message`,
      { label, field: "kind" },
    );
  }
  const negotiationId = requireNonEmptyString(record, "negotiationId", label);
  const proposalId =
    record.proposalId === null
      ? null
      : requireNonEmptyString(record, "proposalId", label);
  if (
    !SCHEDULING_APPROVAL_MESSAGE_KINDS.includes(
      record.messageKind as SchedulingApprovalCorrelation["messageKind"],
    )
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.messageKind: unsupported value`,
      { label, field: "messageKind" },
    );
  }
  if (
    !SCHEDULING_APPROVAL_TRANSPORT_CHANNELS.includes(
      record.transportChannel as SchedulingApprovalCorrelation["transportChannel"],
    )
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.transportChannel: unsupported value`,
      { label, field: "transportChannel" },
    );
  }
  const sourceUpdatedAt = requireNonEmptyString(
    record,
    "sourceUpdatedAt",
    label,
  );
  const counterpartyEntityId = requireNonEmptyString(
    record,
    "counterpartyEntityId",
    label,
  );
  const counterpartyEntityUpdatedAt = requireNonEmptyString(
    record,
    "counterpartyEntityUpdatedAt",
    label,
  );
  const counterpartyEntityUpdatedAtMs = Date.parse(counterpartyEntityUpdatedAt);
  if (
    !Number.isFinite(counterpartyEntityUpdatedAtMs) ||
    new Date(counterpartyEntityUpdatedAtMs).toISOString() !==
      counterpartyEntityUpdatedAt
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.counterpartyEntityUpdatedAt: expected canonical UTC ISO-8601 timestamp`,
      { label, field: "counterpartyEntityUpdatedAt" },
    );
  }
  const sourceUpdatedAtMs = Date.parse(sourceUpdatedAt);
  if (
    !Number.isFinite(sourceUpdatedAtMs) ||
    new Date(sourceUpdatedAtMs).toISOString() !== sourceUpdatedAt
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.sourceUpdatedAt: expected canonical UTC ISO-8601 timestamp`,
      { label, field: "sourceUpdatedAt" },
    );
  }
  if (record.draftVersion !== 1) {
    return failInvalidCorrelation(`invalid ${label}.draftVersion: expected 1`, {
      label,
      field: "draftVersion",
    });
  }
  const contentSha256 = requireNonEmptyString(record, "contentSha256", label);
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    return failInvalidCorrelation(
      `invalid ${label}.contentSha256: expected lowercase SHA-256`,
      { label, field: "contentSha256" },
    );
  }
  if (record.messageKind === "opening" && proposalId !== null) {
    return failInvalidCorrelation(
      `invalid ${label}.proposalId: opening drafts cannot reference a proposal`,
      { label, field: "proposalId", messageKind: record.messageKind },
    );
  }
  if (
    (record.messageKind === "proposal" ||
      record.messageKind === "confirmation") &&
    proposalId === null
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.proposalId: ${record.messageKind} drafts require a proposal`,
      { label, field: "proposalId", messageKind: record.messageKind },
    );
  }
  return {
    kind: "scheduling_message",
    negotiationId,
    proposalId,
    messageKind:
      record.messageKind as SchedulingApprovalCorrelation["messageKind"],
    transportChannel:
      record.transportChannel as SchedulingApprovalCorrelation["transportChannel"],
    sourceUpdatedAt,
    counterpartyEntityId,
    counterpartyEntityUpdatedAt,
    draftVersion: 1,
    contentSha256,
  };
}

export function readSchedulingApprovalCorrelation(
  payload: ApprovalPayload,
  label = "payload.scheduling",
): SchedulingApprovalCorrelation | null {
  if (payload.action !== "send_message" && payload.action !== "send_email") {
    return null;
  }
  if (payload.scheduling === undefined) {
    return null;
  }
  const correlation = parseSchedulingCorrelation(payload.scheduling, label);
  if (
    (payload.action === "send_email") !==
    (correlation.transportChannel === "email")
  ) {
    return failInvalidCorrelation(
      `invalid ${label}.transportChannel: ${payload.action} does not match ${correlation.transportChannel}`,
      {
        label,
        field: "transportChannel",
        action: payload.action,
        transportChannel: correlation.transportChannel,
      },
    );
  }
  return correlation;
}

/**
 * Anchor approval expiry to the immutable source revision. Replaying the same
 * draft therefore produces the same expiry as well as the same content hash,
 * which lets strict idempotency reject only materially different requests.
 */
export function schedulingApprovalExpiresAt(sourceUpdatedAt: string): Date {
  const sourceMs = Date.parse(sourceUpdatedAt);
  if (
    !Number.isFinite(sourceMs) ||
    new Date(sourceMs).toISOString() !== sourceUpdatedAt
  ) {
    return failInvalidCorrelation(
      "invalid sourceUpdatedAt for deterministic approval expiry",
      { sourceUpdatedAt },
    );
  }
  return new Date(sourceMs + SCHEDULING_APPROVAL_TTL_MS);
}

function canonicalSchedulingEnvelope(
  payload: SchedulingSendPayload,
  scheduling: SchedulingApprovalCorrelation,
): Record<string, unknown> {
  const schedulingIdentity = {
    kind: scheduling.kind,
    negotiationId: scheduling.negotiationId,
    proposalId: scheduling.proposalId,
    messageKind: scheduling.messageKind,
    transportChannel: scheduling.transportChannel,
    sourceUpdatedAt: scheduling.sourceUpdatedAt,
    counterpartyEntityId: scheduling.counterpartyEntityId,
    counterpartyEntityUpdatedAt: scheduling.counterpartyEntityUpdatedAt,
    draftVersion: scheduling.draftVersion,
  };
  if (payload.action === "send_email") {
    return {
      scheduling: schedulingIdentity,
      delivery: {
        action: payload.action,
        ...(payload.grantId === undefined ? {} : { grantId: payload.grantId }),
        to: [...payload.to],
        cc: [...payload.cc],
        bcc: [...payload.bcc],
        subject: payload.subject,
        body: payload.body,
        threadId: payload.threadId,
        replyToMessageId: payload.replyToMessageId ?? null,
      },
    };
  }
  return {
    scheduling: schedulingIdentity,
    delivery: {
      action: payload.action,
      recipient: payload.recipient,
      body: payload.body,
      replyToMessageId: payload.replyToMessageId,
    },
  };
}

export function computeSchedulingApprovalContentSha256(
  payload: SchedulingSendPayload,
): string {
  const scheduling = readSchedulingApprovalCorrelation(payload);
  if (!scheduling) {
    throw new ElizaError(
      "[SchedulingApproval] cannot hash a payload without scheduling correlation",
      {
        code: "SCHEDULING_APPROVAL_MISSING_CORRELATION",
        context: { action: payload.action },
        severity: "fatal",
      },
    );
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalSchedulingEnvelope(payload, scheduling)))
    .digest("hex");
}

export function attachSchedulingApprovalCorrelation<
  T extends SchedulingSendPayload,
>(
  payload: T,
  seed: SchedulingApprovalCorrelationSeed,
): T & { scheduling: SchedulingApprovalCorrelation } {
  const provisional: SchedulingApprovalCorrelation = {
    ...seed,
    contentSha256: "0".repeat(64),
  };
  const correlated = { ...payload, scheduling: provisional };
  return {
    ...payload,
    scheduling: {
      ...provisional,
      contentSha256: computeSchedulingApprovalContentSha256(correlated),
    },
  };
}

export function schedulingApprovalPayloadForDraft(
  draft: SchedulingMessageDraft,
  senderGrantId?: string,
): SchedulingSendPayload {
  const seed = {
    kind: "scheduling_message" as const,
    negotiationId: draft.negotiationId,
    proposalId: draft.proposalId,
    messageKind: draft.messageKind,
    transportChannel: draft.transportChannel,
    sourceUpdatedAt: draft.sourceUpdatedAt,
    counterpartyEntityId: draft.counterpartyEntityId,
    counterpartyEntityUpdatedAt: draft.counterpartyEntityUpdatedAt,
    draftVersion: 1 as const,
  };
  if (draft.transportChannel === "email") {
    return attachSchedulingApprovalCorrelation(
      {
        action: "send_email",
        ...(senderGrantId === undefined ? {} : { grantId: senderGrantId }),
        to: [draft.recipient],
        cc: [],
        bcc: [],
        subject: draft.subject,
        body: draft.body,
        threadId: null,
        replyToMessageId: null,
      },
      seed,
    );
  }
  return attachSchedulingApprovalCorrelation(
    {
      action: "send_message",
      recipient: draft.recipient,
      body: draft.body,
      replyToMessageId: null,
    },
    seed,
  );
}

export function verifySchedulingApprovalContent(payload: ApprovalPayload): {
  correlation: SchedulingApprovalCorrelation;
  actualSha256: string;
  matches: boolean;
} | null {
  const correlation = readSchedulingApprovalCorrelation(payload);
  if (!correlation) {
    return null;
  }
  const actualSha256 = computeSchedulingApprovalContentSha256(
    payload as SchedulingSendPayload,
  );
  return {
    correlation,
    actualSha256,
    matches: actualSha256 === correlation.contentSha256,
  };
}
