/**
 * Deterministic evaluator for delegated communication threads.
 *
 * A DelegationContract captures what the owner asked the assistant to handle,
 * which thread or sender class it applies to, when to stay silent, and which
 * tripwire requires exactly one owner escalation. The evaluator is pure so the
 * connector/runtime layer can persist rows and enqueue approvals without
 * embedding policy decisions in transport adapters.
 */

import { ElizaError } from "@elizaos/core";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";

export type DelegationAutonomyLevel =
  | "draft_only"
  | "approval_gated"
  | "silent_autonomous";

export type DelegationChannel =
  | "email"
  | "gmail"
  | "discord"
  | "slack"
  | "imessage"
  | "telegram"
  | "whatsapp"
  | "x_dm";

export interface DelegationThreadScope {
  readonly kind: "thread";
  readonly channel: DelegationChannel;
  readonly threadId: string;
}

export interface DelegationSenderClassScope {
  readonly kind: "sender_class";
  readonly channel: DelegationChannel;
  readonly senderClass: string;
}

export type DelegationScope =
  | DelegationThreadScope
  | DelegationSenderClassScope;

export type DelegationTripwire =
  | {
      readonly kind: "price_pushback";
      readonly label: string;
    }
  | {
      readonly kind: "keyword";
      readonly label: string;
      readonly keywords: readonly string[];
    }
  | {
      readonly kind: "renewal_delta_percent";
      readonly label: string;
      readonly thresholdPercent: number;
    }
  | {
      readonly kind: "nth_ignore";
      readonly label: string;
      readonly thresholdCount: number;
    };

export interface DelegationSlaPolicy {
  readonly holdingReplyAfterMinutes: number;
  readonly holdingReplyBody: string;
  readonly subjectPrefix?: string;
}

export interface DelegationContract {
  readonly contractId: string;
  readonly objective: string;
  readonly scope: DelegationScope;
  readonly autonomyLevel: DelegationAutonomyLevel;
  readonly tripwires: readonly DelegationTripwire[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ownerUserId: string;
  readonly requestedBy: string;
  readonly state?: {
    readonly escalatedAt?: string;
    readonly handledTurnCount?: number;
    readonly holdingReplyQueuedAt?: string;
  };
  readonly sla?: DelegationSlaPolicy;
}

export type DelegationContractStatus =
  | "active"
  | "paused"
  | "completed"
  | "revoked"
  | "expired";

export interface LifeOpsDelegationContractRecord extends DelegationContract {
  readonly agentId: string;
  readonly status: DelegationContractStatus;
  readonly metadata: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface DelegationEmailSender {
  readonly grantId: string;
  readonly email: string;
}

export interface DelegationInboundTurn {
  readonly replyConnectorAccountId?: string;
  readonly channel: DelegationChannel;
  readonly threadId: string;
  readonly sender: string;
  readonly senderEmail?: string;
  readonly senderClass?: string;
  readonly subject?: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly ownerRepliedAt?: string;
  readonly followupCount?: number;
  readonly renewalDeltaPercent?: number;
}

export interface DelegationDraftIntent {
  readonly action: "send_email";
  readonly channel: "email";
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly reason: string;
  readonly payload: {
    readonly grantId?: string;
    readonly action: "send_email";
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly bcc: readonly string[];
    readonly subject: string;
    readonly body: string;
    readonly threadId: string | null;
    readonly replyToMessageId: string | null;
  };
}

export interface DelegationEscalation {
  readonly kind: "owner_escalation";
  readonly contractId: string;
  readonly triggeredBy: DelegationTripwire;
  readonly summary: string;
  readonly decisionPrompt: string;
  readonly sourceText: string;
  readonly triggeredAt: string;
}

export type DelegationEvaluationOutcome =
  | "out_of_scope"
  | "in_bounds"
  | "escalate_owner"
  | "already_escalated"
  | "holding_reply_due"
  | "holding_reply_suppressed";

export interface DelegationEvaluation {
  readonly outcome: DelegationEvaluationOutcome;
  readonly contract: DelegationContract;
  readonly escalation: DelegationEscalation | null;
  readonly draftIntent: DelegationDraftIntent | null;
  readonly audit: {
    readonly silentTowardOwner: boolean;
    readonly matchedTripwire: string | null;
    readonly reason: string;
  };
}

export interface DelegationContractRepository {
  listDelegationContracts(
    agentId: string,
    options?: {
      readonly statuses?: LifeOpsDelegationContractRecord["status"][];
      readonly activeAtIso?: string;
    },
  ): Promise<LifeOpsDelegationContractRecord[]>;
  upsertDelegationContract(
    record: LifeOpsDelegationContractRecord,
  ): Promise<void>;
}

export interface DelegationInboundProcessingResult {
  readonly evaluations: readonly DelegationEvaluation[];
  readonly enqueuedApprovals: readonly ApprovalRequest[];
}

export function createLifeOpsDelegationContractRecord(
  input: DelegationContract & {
    readonly agentId: string;
    readonly status?: DelegationContractStatus;
    readonly metadata?: Record<string, unknown>;
    readonly updatedAt?: string;
  },
): LifeOpsDelegationContractRecord {
  return {
    ...input,
    status: input.status ?? "active",
    metadata: input.metadata ?? {},
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

export function renderDelegationContractsProviderText(
  contracts: readonly LifeOpsDelegationContractRecord[],
): string {
  const active = contracts.filter((contract) => contract.status === "active");
  if (active.length === 0) return "";
  const lines = active.map((contract) => {
    const scope =
      contract.scope.kind === "thread"
        ? `${contract.scope.channel} thread ${contract.scope.threadId}`
        : `${contract.scope.channel} sender class ${contract.scope.senderClass}`;
    const tripwires = contract.tripwires
      .map((tripwire) => tripwire.label)
      .join(", ");
    const tripwireText = tripwires.length > 0 ? tripwires : "no tripwire";
    return `- ${contract.contractId}: ${contract.objective}; scope=${scope}; autonomy=${contract.autonomyLevel}; escalate on ${tripwireText}; expires ${contract.expiresAt}`;
  });
  return ["Active delegation contracts:", ...lines].join("\n");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9%.$]+/g, " ")
    .trim();
}

function parseTime(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`[DelegationContract] invalid ${label}: ${value}`);
  }
  return ms;
}

function scopeMatches(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
): boolean {
  if (contract.scope.channel !== turn.channel) return false;
  if (contract.scope.kind === "thread") {
    return contract.scope.threadId === turn.threadId;
  }
  return (
    typeof turn.senderClass === "string" &&
    normalize(turn.senderClass) === normalize(contract.scope.senderClass)
  );
}

function isActive(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
): boolean {
  const receivedAt = parseTime(turn.receivedAt, "turn.receivedAt");
  return (
    receivedAt >= parseTime(contract.createdAt, "contract.createdAt") &&
    receivedAt <= parseTime(contract.expiresAt, "contract.expiresAt")
  );
}

function pricePushbackMatches(text: string): boolean {
  const normalized = normalize(text);
  const priceTerms = [
    "price",
    "cost",
    "rate",
    "budget",
    "discount",
    "too expensive",
    "quote",
  ];
  const pushbackTerms = [
    "too high",
    "cannot accept",
    "can't accept",
    "won t accept",
    "push back",
    "need better",
    "reduce",
    "lower",
    "not acceptable",
  ];
  return (
    priceTerms.some((term) => normalized.includes(term)) &&
    pushbackTerms.some((term) => normalized.includes(term))
  );
}

function tripwireMatches(
  tripwire: DelegationTripwire,
  turn: DelegationInboundTurn,
): boolean {
  const normalizedText = normalize(turn.text);
  if (tripwire.kind === "price_pushback") {
    return pricePushbackMatches(turn.text);
  }
  if (tripwire.kind === "keyword") {
    return tripwire.keywords.some((keyword) =>
      normalizedText.includes(normalize(keyword)),
    );
  }
  if (tripwire.kind === "renewal_delta_percent") {
    return (
      typeof turn.renewalDeltaPercent === "number" &&
      Number.isFinite(turn.renewalDeltaPercent) &&
      Math.abs(turn.renewalDeltaPercent) >= tripwire.thresholdPercent
    );
  }
  return (
    typeof turn.followupCount === "number" &&
    Number.isFinite(turn.followupCount) &&
    turn.followupCount >= tripwire.thresholdCount
  );
}

function findMatchedTripwire(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
): DelegationTripwire | null {
  return (
    contract.tripwires.find((tripwire) => tripwireMatches(tripwire, turn)) ??
    null
  );
}

function withState(
  contract: DelegationContract,
  state: NonNullable<DelegationContract["state"]>,
): DelegationContract {
  return {
    ...contract,
    state: {
      ...(contract.state ?? {}),
      ...state,
    },
  };
}

function escalationFor(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
  tripwire: DelegationTripwire,
): DelegationEscalation {
  return {
    kind: "owner_escalation",
    contractId: contract.contractId,
    triggeredBy: tripwire,
    triggeredAt: turn.receivedAt,
    sourceText: turn.text,
    summary: `${turn.sender} tripped "${tripwire.label}" on ${contract.objective}.`,
    decisionPrompt: `Decide how to proceed on ${contract.objective}: ${turn.sender} said "${turn.text}"`,
  };
}

function minutesBetween(startIso: string, endIso: string): number {
  return (parseTime(endIso, "end") - parseTime(startIso, "start")) / 60_000;
}

function ownerRepliedBeforeSla(
  turn: DelegationInboundTurn,
  contract: DelegationContract,
): boolean {
  if (!turn.ownerRepliedAt || !contract.sla) return false;
  const elapsed = minutesBetween(turn.receivedAt, turn.ownerRepliedAt);
  return elapsed >= 0 && elapsed < contract.sla.holdingReplyAfterMinutes;
}

function buildHoldingReplyIntent(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
): DelegationDraftIntent | null {
  if (!contract.sla || !turn.senderEmail) return null;
  const subject =
    turn.subject && contract.sla.subjectPrefix
      ? `${contract.sla.subjectPrefix} ${turn.subject}`
      : (turn.subject ?? `Re: ${contract.objective}`);
  return {
    action: "send_email",
    channel: "email",
    requestedBy: contract.requestedBy,
    subjectUserId: contract.ownerUserId,
    reason: `SLA holding reply for delegated ${contract.objective}`,
    payload: {
      action: "send_email",
      to: [turn.senderEmail],
      cc: [],
      bcc: [],
      subject,
      body: contract.sla.holdingReplyBody,
      threadId: turn.threadId,
      replyToMessageId: null,
    },
  };
}

function evaluateSla(
  contract: DelegationContract,
  turn: DelegationInboundTurn,
  nowIso: string,
): DelegationEvaluation | null {
  if (!contract.sla) return null;
  if (contract.state?.holdingReplyQueuedAt) {
    return null;
  }
  if (ownerRepliedBeforeSla(turn, contract)) {
    return {
      outcome: "holding_reply_suppressed",
      contract,
      escalation: null,
      draftIntent: null,
      audit: {
        silentTowardOwner: true,
        matchedTripwire: null,
        reason: "owner replied before the holding-reply SLA elapsed",
      },
    };
  }
  const elapsed = minutesBetween(turn.receivedAt, nowIso);
  if (elapsed < contract.sla.holdingReplyAfterMinutes) {
    return null;
  }
  const draftIntent = buildHoldingReplyIntent(contract, turn);
  if (!draftIntent) return null;
  return {
    outcome: "holding_reply_due",
    contract: withState(contract, { holdingReplyQueuedAt: nowIso }),
    escalation: null,
    draftIntent,
    audit: {
      silentTowardOwner: true,
      matchedTripwire: null,
      reason: "holding-reply SLA elapsed with no owner reply",
    },
  };
}

export function evaluateDelegationContract(input: {
  readonly contract: DelegationContract;
  readonly turn: DelegationInboundTurn;
  readonly nowIso: string;
}): DelegationEvaluation {
  const { contract, turn, nowIso } = input;
  parseTime(nowIso, "nowIso");
  if (!scopeMatches(contract, turn) || !isActive(contract, turn)) {
    return {
      outcome: "out_of_scope",
      contract,
      escalation: null,
      draftIntent: null,
      audit: {
        silentTowardOwner: true,
        matchedTripwire: null,
        reason: "turn is outside the contract scope or active window",
      },
    };
  }

  const matchedTripwire = findMatchedTripwire(contract, turn);
  if (matchedTripwire) {
    if (contract.state?.escalatedAt) {
      return {
        outcome: "already_escalated",
        contract,
        escalation: null,
        draftIntent: null,
        audit: {
          silentTowardOwner: true,
          matchedTripwire: matchedTripwire.label,
          reason: "tripwire already escalated for this contract",
        },
      };
    }
    return {
      outcome: "escalate_owner",
      contract: withState(contract, { escalatedAt: turn.receivedAt }),
      escalation: escalationFor(contract, turn, matchedTripwire),
      draftIntent: null,
      audit: {
        silentTowardOwner: false,
        matchedTripwire: matchedTripwire.label,
        reason: "tripwire matched and no previous escalation exists",
      },
    };
  }

  const slaEvaluation = evaluateSla(contract, turn, nowIso);
  if (slaEvaluation) return slaEvaluation;

  return {
    outcome: "in_bounds",
    contract: withState(contract, {
      handledTurnCount: (contract.state?.handledTurnCount ?? 0) + 1,
    }),
    escalation: null,
    draftIntent: null,
    audit: {
      silentTowardOwner: true,
      matchedTripwire: null,
      reason: "turn is in bounds for delegated handling",
    },
  };
}

function approvalExpiryFrom(nowIso: string): Date {
  return new Date(parseTime(nowIso, "nowIso") + 24 * 60 * 60 * 1_000);
}

function shouldPersistEvaluation(evaluation: DelegationEvaluation): boolean {
  return (
    evaluation.outcome === "in_bounds" ||
    evaluation.outcome === "escalate_owner" ||
    evaluation.outcome === "holding_reply_due"
  );
}

/**
 * Runtime-facing processor for connector turns. Transport adapters supply the
 * normalized turn; this function owns the contract-policy fanout, persistence,
 * and approval-queue handoff so connectors do not learn LifeOps delegation
 * rules.
 */
export async function processDelegationInboundTurn(input: {
  readonly agentId: string;
  readonly turn: DelegationInboundTurn;
  readonly nowIso: string;
  readonly repository: DelegationContractRepository;
  readonly approvalQueue: ApprovalQueue;
  readonly resolveEmailSender: (
    ownerUserId: string,
  ) => Promise<DelegationEmailSender>;
  readonly approvalExpiresAt?: Date;
}): Promise<DelegationInboundProcessingResult> {
  const contracts = await input.repository.listDelegationContracts(
    input.agentId,
    {
      statuses: ["active"],
      activeAtIso: input.turn.receivedAt,
    },
  );
  const evaluations: DelegationEvaluation[] = [];
  const enqueuedApprovals: ApprovalRequest[] = [];
  for (const contract of contracts) {
    let evaluation = evaluateDelegationContract({
      contract,
      turn: input.turn,
      nowIso: input.nowIso,
    });
    if (evaluation.outcome === "out_of_scope") {
      continue;
    }
    if (evaluation.draftIntent) {
      const sender = await input.resolveEmailSender(contract.ownerUserId);
      if (!sender.grantId.trim() || !sender.email.trim())
        throw new ElizaError(
          "Reconnect the receiving email account before reviewing a holding reply.",
          {
            code: "DELEGATION_REPLY_SENDER_UNAVAILABLE",
          },
        );
      const draft = evaluation.draftIntent;
      evaluation = {
        ...evaluation,
        draftIntent: {
          ...draft,
          payload: { ...draft.payload, grantId: sender.grantId },
          reason: `${draft.reason}\nFrom: ${sender.email}`,
        },
      };
    }
    evaluations.push(evaluation);
    if (evaluation.draftIntent) {
      enqueuedApprovals.push(
        await input.approvalQueue.enqueue({
          requestedBy: evaluation.draftIntent.requestedBy,
          subjectUserId: evaluation.draftIntent.subjectUserId,
          action: evaluation.draftIntent.action,
          payload: evaluation.draftIntent.payload,
          channel: evaluation.draftIntent.channel,
          reason: evaluation.draftIntent.reason,
          expiresAt:
            input.approvalExpiresAt ?? approvalExpiryFrom(input.nowIso),
        }),
      );
    }
    if (shouldPersistEvaluation(evaluation)) {
      await input.repository.upsertDelegationContract({
        ...contract,
        state: evaluation.contract.state,
        updatedAt: input.nowIso,
      });
    }
  }
  return { evaluations, enqueuedApprovals };
}
