/**
 * Normalizes runtime connector messages into LifeOps delegation turns.
 *
 * Connectors keep ownership of transport-specific metadata; this boundary
 * extracts their shared thread and sender fields before the delegation policy
 * processor persists state and creates approval-gated reply drafts.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
} from "@elizaos/core";
import { INTERNAL_URL } from "../access.js";
import type { ApprovalQueue } from "../approval-queue.types.js";
import { googleGrantIdForAccount } from "../google-plugin-delegates.js";
import type {
  DelegationChannel,
  DelegationContractRepository,
  DelegationEmailSender,
  DelegationInboundProcessingResult,
  DelegationInboundTurn,
} from "./index.js";

type UnknownRecord = Record<string, unknown>;

const CHANNEL_ALIASES: Readonly<Record<string, DelegationChannel>> = {
  discord: "discord",
  email: "email",
  gmail: "email",
  google: "email",
  imessage: "imessage",
  slack: "slack",
  telegram: "telegram",
  whatsapp: "whatsapp",
  x: "x_dm",
  x_dm: "x_dm",
  twitter: "x_dm",
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function channelFromMessage(
  content: UnknownRecord,
  metadata: UnknownRecord,
): DelegationChannel | null {
  const origin = record(metadata.origin);
  const source = stringValue(
    content.source,
    metadata.source,
    metadata.provider,
    origin.provider,
    origin.surface,
  )?.toLowerCase();
  return source ? (CHANNEL_ALIASES[source] ?? null) : null;
}

function threadIdFromMessage(
  message: Memory,
  content: UnknownRecord,
  metadata: UnknownRecord,
): string {
  const contentMetadata = record(content.metadata);
  const thread = record(metadata.thread);
  const delivery = record(metadata.delivery);
  const origin = record(metadata.origin);
  const telegram = record(metadata.telegram);
  const slack = record(metadata.slack);
  const whatsapp = record(metadata.whatsapp);
  const signal = record(metadata.signal);
  const x = record(metadata.x);
  return (
    stringValue(
      thread.id,
      delivery.threadId,
      origin.threadId,
      slack.threadTs,
      telegram.threadId,
      whatsapp.chatId,
      signal.groupId,
      x.conversationId,
      content.threadId,
      contentMetadata.threadId,
      message.roomId,
    ) ?? String(message.roomId)
  );
}

function receivedAtFromMessage(
  message: Memory,
  metadata: UnknownRecord,
): string {
  const timestamp = numberValue(message.createdAt, metadata.timestamp);
  if (timestamp === undefined) {
    throw new Error(
      "[DelegationInboundEvent] connector message has no timestamp.",
    );
  }
  const receivedAt = new Date(timestamp);
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new Error(
      `[DelegationInboundEvent] connector message has invalid timestamp ${timestamp}.`,
    );
  }
  return receivedAt.toISOString();
}

/** Map one canonical runtime message into the delegation policy vocabulary. */
export function delegationInboundTurnFromMessage(
  message: Memory,
): DelegationInboundTurn | null {
  const content = record(message.content);
  const metadata = record(message.metadata);
  const contentMetadata = record(content.metadata);
  const sender = record(metadata.sender);
  const channel = channelFromMessage(content, metadata);
  if (!channel) return null;
  const text = stringValue(content.text);
  if (!text) return null;

  const senderName =
    stringValue(
      sender.name,
      sender.username,
      sender.id,
      metadata.entityName,
      metadata.entityUserName,
      metadata.from,
      content.sender,
      message.entityId,
    ) ?? String(message.entityId);
  const senderEmail = stringValue(
    sender.email,
    metadata.senderEmail,
    metadata.fromEmail,
    content.senderEmail,
    content.fromEmail,
    contentMetadata.senderEmail,
  );
  const senderClass = stringValue(
    metadata.senderClass,
    content.senderClass,
    contentMetadata.senderClass,
  );
  const subject = stringValue(
    metadata.subject,
    content.subject,
    contentMetadata.subject,
  );
  const ownerRepliedAt = stringValue(
    metadata.ownerRepliedAt,
    contentMetadata.ownerRepliedAt,
  );
  const followupCount = numberValue(
    metadata.followupCount,
    contentMetadata.followupCount,
  );
  const renewalDeltaPercent = numberValue(
    metadata.renewalDeltaPercent,
    contentMetadata.renewalDeltaPercent,
  );

  const accountIds = [
    metadata.accountId,
    record(metadata.origin).accountId,
    record(metadata.delivery).accountId,
  ].filter((value) => value !== undefined && value !== null);
  if (
    accountIds.some(
      (value) =>
        typeof value !== "string" || !value.trim() || value !== value.trim(),
    ) ||
    new Set(accountIds).size > 1
  )
    throw new ElizaError(
      "The incoming account is missing or inconsistent. Reconnect the source before drafting a reply.",
      { code: "DELEGATION_REPLY_ACCOUNT_INVALID" },
    );
  const replyConnectorAccountId = accountIds[0];
  return {
    ...(typeof replyConnectorAccountId === "string"
      ? { replyConnectorAccountId }
      : {}),
    channel,
    threadId: threadIdFromMessage(message, content, metadata),
    sender: senderName,
    ...(senderEmail ? { senderEmail } : {}),
    ...(senderClass ? { senderClass } : {}),
    ...(subject ? { subject } : {}),
    text,
    receivedAt: receivedAtFromMessage(message, metadata),
    ...(ownerRepliedAt ? { ownerRepliedAt } : {}),
    ...(followupCount !== undefined ? { followupCount } : {}),
    ...(renewalDeltaPercent !== undefined ? { renewalDeltaPercent } : {}),
  };
}

export interface DelegationInboundMessageDependencies {
  readonly createRepository: (
    runtime: IAgentRuntime,
  ) => DelegationContractRepository;
  readonly createApprovalQueue: (runtime: IAgentRuntime) => ApprovalQueue;
  readonly processTurn: (input: {
    readonly agentId: string;
    readonly turn: DelegationInboundTurn;
    readonly nowIso: string;
    readonly repository: DelegationContractRepository;
    readonly approvalQueue: ApprovalQueue;
    readonly resolveEmailSender: (
      ownerUserId: string,
    ) => Promise<DelegationEmailSender>;
  }) => Promise<DelegationInboundProcessingResult>;
  readonly now?: () => Date;
}

/** Build the connector-event handler with runtime-owned persistence adapters. */
export function createDelegationInboundMessageHandler(
  dependencies: DelegationInboundMessageDependencies,
): (payload: MessagePayload) => Promise<void> {
  return async (payload: MessagePayload): Promise<void> => {
    const turn = delegationInboundTurnFromMessage(payload.message);
    if (!turn) return;
    const runtime: IAgentRuntime = payload.runtime;
    await dependencies.processTurn({
      agentId: runtime.agentId,
      turn,
      nowIso: (dependencies.now?.() ?? new Date()).toISOString(),
      repository: dependencies.createRepository(runtime),
      approvalQueue: dependencies.createApprovalQueue(runtime),
      resolveEmailSender: (ownerUserId) =>
        resolveDelegationEmailSender(runtime, turn, ownerUserId),
    });
  };
}

/** Resolves the receiving owner account explicitly; an absent binding never selects the default sender. */
export async function resolveDelegationEmailSender(
  runtime: IAgentRuntime,
  turn: DelegationInboundTurn,
  ownerUserId: string,
): Promise<DelegationEmailSender> {
  const accountId = turn.replyConnectorAccountId;
  if (
    (turn.channel !== "email" && turn.channel !== "gmail") ||
    !accountId ||
    accountId !== accountId.trim()
  )
    throw new ElizaError(
      "The receiving email account is unavailable. Reconnect it before reviewing a holding reply.",
      { code: "DELEGATION_REPLY_ACCOUNT_INVALID" },
    );
  const { LifeOpsService } = await import("../service.js");
  const grant = await new LifeOpsService(runtime, {
    ownerEntityId: ownerUserId,
  }).requireGoogleGmailSendGrant(
    INTERNAL_URL,
    "local",
    "owner",
    googleGrantIdForAccount(accountId),
  );
  if (
    grant.connectorAccountId !== accountId ||
    !grant.identityEmail ||
    !grant.id
  )
    throw new ElizaError(
      "The receiving email account no longer matches this reply.",
      { code: "DELEGATION_REPLY_SENDER_UNAVAILABLE" },
    );
  return { grantId: grant.id, email: grant.identityEmail };
}
