/**
 * RESOLVE_REQUEST action — owner decision surface for the approval queue.
 * Approve or reject a pending request (reject is also the hold verb: "don't
 * send it for now" terminally cancels the dispatch and a fresh request can be
 * queued later); on approval it dispatches the queued payload (message send,
 * document signature, travel booking, …) through `executeApprovedRequest`.
 * Owner-gated; the only path that runs a queued external side effect. The
 * planner learns about pending rows from the `pendingApprovals` provider
 * (../providers/pending-approvals.ts), which routes decisions here (#14630).
 */
import {
  hasOwnerAccess,
  ApprovalNotFoundError as RuntimeApprovalNotFoundError,
  ApprovalStateTransitionError as RuntimeApprovalStateTransitionError,
} from "@elizaos/agent";
import type {
  Action,
  ActionExample,
  ActionResult,
  EffectResourceRef,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  appendInteractionBlock,
  type ChoiceInteraction,
  ElizaError,
  logger,
  ModelType,
  resolveActionArgs,
  runWithTrajectoryPurpose,
  type SubactionsMap,
  stableStringify,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioVoiceCall,
} from "@elizaos/plugin-phone/twilio";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { INTERNAL_URL } from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  ApprovalNotFoundError,
  type ApprovalQueue,
  ApprovalQueueCompatibilityError,
  type ApprovalRequest,
  ApprovalStateTransitionError,
} from "../lifeops/approval-queue.types.js";
import {
  CalendarCardAccessStore,
  calendarCardDeliveryStatus,
  verifyCalendarCardApproval,
} from "../lifeops/calendar-card.js";
import {
  createLifeOpsCalendarMutationPort,
  executeCalendarMutationApproval,
} from "../lifeops/calendar-mutations/index.js";
import { getChannelRegistry } from "../lifeops/channels/index.js";
import { extractCommitmentLedgerRecords } from "../lifeops/commitments/index.js";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";
import {
  FOOD_APPROVAL_WORKFLOW_ID,
  getFoodDomainService,
} from "../lifeops/food/index.js";
import { HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID } from "../lifeops/household/types.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import {
  getResourceCapacityService,
  RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID,
} from "../lifeops/resource-capacity/index.js";
import {
  schedulingApprovalPayloadForDraft,
  verifySchedulingApprovalContent,
} from "../lifeops/scheduling-approval.js";
import {
  type SchedulingDeliveryAttempt,
  SchedulingDeliveryStore,
  schedulingDeliveryIdempotencyKey,
} from "../lifeops/scheduling-delivery.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeApprovedBookTravel } from "./book-travel.js";
import {
  dispatchApprovedSignatureRequest,
  getDocumentRequest,
} from "./document.js";
import {
  type ApprovalDispatchOutcome,
  recoverInterruptedApproval,
  runApprovalDispatch,
} from "./lib/approval-execution.js";
import {
  ApprovalConnectorPreflightError,
  ApprovalKnownNonDeliveryError,
  type CrossChannelSendChannel,
  prepareCrossChannelSend,
} from "./lib/messaging-helpers.js";
import { formatPromptValue } from "./lib/prompt-format.js";

const ACTION_NAME = "RESOLVE_REQUEST";

type ResolveSubaction =
  | "approve"
  | "reject"
  | "reconcile_delivered"
  | "reconcile_not_delivered";

const SUBACTIONS: SubactionsMap<ResolveSubaction> = {
  approve: {
    description: "Approve queued action; optional reason, user language.",
    descriptionCompressed: "approve queued action reason-optional multilingual",
    required: [],
    optional: ["requestId", "reason"],
  },
  reject: {
    description:
      "Reject queued action so it never dispatches — also the verb for holds " +
      "('don't send it', 'not yet', 'hold off until I confirm'); a fresh " +
      "request can be queued later. Optional reason, user language.",
    descriptionCompressed:
      "reject/hold queued action (nothing dispatches) reason-optional multilingual",
    required: [],
    optional: ["requestId", "reason"],
  },
  reconcile_delivered: {
    description:
      "Record provider-confirmed delivery for an ambiguous approval attempt.",
    descriptionCompressed:
      "reconcile ambiguous approval as provider-confirmed delivered",
    required: ["requestId"],
    optional: ["reason", "providerReceiptId"],
  },
  reconcile_not_delivered: {
    description:
      "Record provider-confirmed non-delivery so an approval can be retried.",
    descriptionCompressed:
      "reconcile ambiguous approval as provider-confirmed not delivered",
    required: ["requestId"],
    optional: ["reason", "providerReceiptId"],
  },
};

interface ExtractedResolution {
  readonly requestId: string | null;
  readonly reason: string | null;
}

interface ResolveRequestParameters {
  readonly subaction?: ResolveSubaction | string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly providerReceiptId?: string;
}

interface HouseholdProposalApprovalTarget {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly coordinationId: string;
  readonly partyEntityId: string;
  readonly contentSha256: string;
}

interface ResourceCapacityReviewTarget {
  readonly proposalId: string;
  readonly proposalVersion: 1;
  readonly partyEntityId: string;
  readonly contentSha256: string;
}

function isHouseholdProposalApprovalWorkflow(
  request: ApprovalRequest,
): boolean {
  return (
    request.action === "execute_workflow" &&
    request.payload.action === "execute_workflow" &&
    request.payload.workflowId ===
      HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID
  );
}

function readHouseholdProposalApprovalTarget(
  request: ApprovalRequest,
): HouseholdProposalApprovalTarget | null {
  const payload = request.payload;
  if (
    request.action !== "execute_workflow" ||
    payload.action !== "execute_workflow" ||
    payload.workflowId !== HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID
  ) {
    return null;
  }
  const input = payload.input;
  const proposalId = input.proposalId;
  const proposalVersion = input.proposalVersion;
  const coordinationId = input.coordinationId;
  const partyEntityId = input.partyEntityId;
  const contentSha256 = input.contentSha256;
  if (
    typeof proposalId !== "string" ||
    proposalId.trim().length === 0 ||
    typeof proposalVersion !== "number" ||
    !Number.isSafeInteger(proposalVersion) ||
    proposalVersion < 1 ||
    typeof coordinationId !== "string" ||
    coordinationId.trim().length === 0 ||
    typeof partyEntityId !== "string" ||
    partyEntityId.trim().length === 0 ||
    typeof contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(contentSha256)
  ) {
    return null;
  }
  return {
    proposalId,
    proposalVersion,
    coordinationId,
    partyEntityId,
    contentSha256,
  };
}

function isResourceCapacityReviewWorkflow(request: ApprovalRequest): boolean {
  return (
    request.action === "execute_workflow" &&
    request.payload.action === "execute_workflow" &&
    request.payload.workflowId === RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID
  );
}

function readResourceCapacityReviewTarget(
  request: ApprovalRequest,
): ResourceCapacityReviewTarget | null {
  const payload = request.payload;
  if (
    request.action !== "execute_workflow" ||
    payload.action !== "execute_workflow" ||
    payload.workflowId !== RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID
  ) {
    return null;
  }
  const input = payload.input;
  const proposalId = input.proposalId;
  const proposalVersion = input.proposalVersion;
  const partyEntityId = input.partyEntityId;
  const contentSha256 = input.contentSha256;
  const noExternalEffect = input.noExternalEffect;
  if (
    typeof proposalId !== "string" ||
    proposalId.trim().length === 0 ||
    proposalVersion !== 1 ||
    typeof partyEntityId !== "string" ||
    partyEntityId.trim().length === 0 ||
    typeof contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(contentSha256) ||
    noExternalEffect !== true
  ) {
    return null;
  }
  return {
    proposalId: proposalId.trim(),
    proposalVersion: 1,
    partyEntityId: partyEntityId.trim(),
    contentSha256,
  };
}

function formatPending(requests: ReadonlyArray<ApprovalRequest>): string {
  if (requests.length === 0) return "(no pending requests)";
  return requests
    .map((r, i) => {
      const payloadSummary = formatPromptValue(r.payload, 2);
      return `${i + 1}. id=${r.id} action=${r.action} channel=${r.channel} reason=${r.reason}\n  payload:\n${payloadSummary}`;
    })
    .join("\n");
}

/** Chip labels stay glanceable; the full reason lives in the queue row. */
export function truncateReason(reason: string, max = 48): string {
  const trimmed = toWellFormedUnicode(reason.trim());
  if (trimmed.length <= max) {
    return trimmed;
  }
  const budget = Math.max(0, max - 1);
  return `${truncateWellFormed(trimmed, budget)}…`;
}

/**
 * One-tap request picker for an ambiguous approve/reject (#14733). Each option
 * value is `<intent> <requestId>` — the tap round-trips it as the owner's next
 * message, which this action's extraction resolves verbatim (the id is in the
 * text and the `pendingApprovals` provider lists the same ids).
 */
export function buildResolveRequestChoice(
  intent: ResolveSubaction,
  pending: ReadonlyArray<ApprovalRequest>,
): ChoiceInteraction {
  return {
    kind: "choice",
    id: `approval-resolve-${Date.now().toString(36)}`,
    scope: "approval-resolve",
    options: pending.map((request) => ({
      value: `${intent} ${request.id}`,
      label: truncateReason(request.reason),
    })),
  };
}

function parseResolutionJson(raw: unknown): ExtractedResolution {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { requestId: null, reason: null };
  }
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const objectText = trimmed.match(/\{[\s\S]*\}/u)?.[0] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return { requestId: null, reason: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { requestId: null, reason: null };
  }
  const record = parsed as { requestId?: unknown; reason?: unknown };
  return {
    requestId:
      typeof record.requestId === "string" && record.requestId.length > 0
        ? record.requestId
        : null,
    reason:
      typeof record.reason === "string" && record.reason.length > 0
        ? record.reason
        : null,
  };
}

async function extractResolution(
  runtime: IAgentRuntime,
  userText: string,
  intent: ResolveSubaction,
  pending: ReadonlyArray<ApprovalRequest>,
): Promise<ExtractedResolution> {
  if (pending.length === 0) {
    return { requestId: null, reason: null };
  }
  // The approve/reject intent was already decided by the planner's verb
  // choice; extraction only picks WHICH row. With exactly one pending row
  // there is no selection judgment left, so skip the model call — this keeps
  // single-approval resolution deterministic (and keyless).
  const [onlyPending] = pending;
  if (pending.length === 1 && onlyPending) {
    return {
      requestId: onlyPending.id,
      reason: userText.trim() || `user ${intent}d`,
    };
  }
  if (typeof runtime.useModel !== "function") {
    return { requestId: null, reason: null };
  }
  // LLM resolution path for natural-language approval decisions.
  const prompt = `You are resolving an approval queue decision.
The user wants to ${intent} one of the pending requests below.
Understand the user's message in any language. Echo the reason in the user's language.

User message:
"""
${userText}
"""

Pending requests:
${formatPending(pending)}

Return strict JSON only with exactly these keys:
{
  "requestId": "id of the single targeted request, or null if ambiguous",
  "reason": "short human-readable reason in the user's language, or null if none given"
}`;
  const raw = await runWithTrajectoryPurpose("lifeops-resolve-request", () =>
    runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
  );
  return parseResolutionJson(raw);
}

function denied(reason: string): ActionResult {
  return {
    text: `The approval request was not changed (${reason}).`,
    success: false,
    data: { error: reason },
  };
}

interface ApprovalEffectProof {
  readonly requestId: string;
  readonly state: ApprovalRequest["state"];
  readonly updatedAt: string;
  readonly idempotencyKey: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function approvalProof(request: ApprovalRequest): ApprovalEffectProof {
  return {
    requestId: request.id,
    state: request.state,
    updatedAt: request.updatedAt.toISOString(),
    idempotencyKey: request.idempotencyKey,
  };
}

function withApprovalProof(
  result: ActionResult,
  request: ApprovalRequest,
): ActionResult {
  const data = asRecord(result.data) ?? {};
  return {
    ...result,
    data: {
      ...data,
      approvalEffect: approvalProof(request),
    },
  };
}

function trackingApprovalQueue(
  queue: ApprovalQueue,
  observed: (request: ApprovalRequest) => void,
): ApprovalQueue {
  const track = async (
    operation: Promise<ApprovalRequest>,
  ): Promise<ApprovalRequest> => {
    const request = await operation;
    observed(request);
    return request;
  };
  // A forwarding proxy rather than an explicit member map: the execution
  // capability grows (claim, dispatch-start, retryable/reconciliation
  // failures, recovery, reconcile), and an explicit map silently drops any
  // method added later, which would hide the very transition the receipt is
  // supposed to prove.
  return new Proxy(queue, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      return PERSISTING_QUEUE_METHODS.has(property as string)
        ? (...args: unknown[]) =>
            track(bound(...args) as Promise<ApprovalRequest>)
        : bound;
    },
  });
}

/** Queue methods whose resolved row is the newest persisted approval state. */
const PERSISTING_QUEUE_METHODS: ReadonlySet<string> = new Set([
  "approve",
  "reject",
  "claimExecution",
  "markDispatchStarted",
  "markDone",
  "markRetryableFailure",
  "markReconciliationRequired",
  "recoverUnstartedExecution",
  "reconcileExecution",
  "markExpired",
]);

function resolutionRequestId(message: Memory): string {
  return typeof message.id === "string"
    ? message.id
    : `room:${String(message.roomId)}`;
}

function approvalReceiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `${ACTION_NAME}:${operation}:${resolutionRequestId(message)}:${resourceId}`;
}

function readApprovalEffectProof(
  data: Record<string, unknown>,
): ApprovalEffectProof | null {
  const raw = asRecord(data.approvalEffect);
  if (
    !raw ||
    typeof raw.requestId !== "string" ||
    typeof raw.state !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.updatedAt)) ||
    (raw.idempotencyKey !== null && typeof raw.idempotencyKey !== "string")
  ) {
    return null;
  }
  return {
    requestId: raw.requestId,
    state: raw.state as ApprovalRequest["state"],
    updatedAt: new Date(raw.updatedAt).toISOString(),
    idempotencyKey: raw.idempotencyKey as string | null,
  };
}

interface ApprovalProviderProof {
  readonly id: string;
  readonly acceptedAt: string;
  readonly artifact: EffectResourceRef;
}

function readProviderProof(
  data: Record<string, unknown>,
): ApprovalProviderProof | null {
  const receipt = asRecord(data.receipt);
  if (receipt && typeof receipt.acceptedAt === "string") {
    const acceptedAt = new Date(receipt.acceptedAt);
    if (Number.isFinite(acceptedAt.getTime())) {
      const provider =
        typeof receipt.provider === "string" && receipt.provider.trim()
          ? receipt.provider.trim()
          : "calendar";
      const providerIdCandidates = [
        receipt.providerMessageId,
        receipt.providerEventId,
        receipt.eventId,
        data.attemptId,
      ];
      const providerId = providerIdCandidates.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0,
      );
      if (providerId) {
        return {
          id: providerId,
          acceptedAt: acceptedAt.toISOString(),
          artifact: {
            kind: `provider.${provider}.receipt`,
            id: providerId,
            ...(typeof receipt.providerVersion === "string" &&
            receipt.providerVersion.trim().length > 0
              ? { version: receipt.providerVersion }
              : {}),
          },
        };
      }
    }
  }
  const handoffUpdatedAt = data.handoffUpdatedAt;
  const handoffId = data.handoffId;
  if (
    typeof handoffUpdatedAt === "string" &&
    Number.isFinite(Date.parse(handoffUpdatedAt)) &&
    typeof handoffId === "string" &&
    handoffId.trim().length > 0
  ) {
    return {
      id: handoffId,
      acceptedAt: new Date(handoffUpdatedAt).toISOString(),
      artifact: { kind: "lifeops.food_shopping_handoff", id: handoffId },
    };
  }
  return null;
}

function approvalArtifacts(
  data: Record<string, unknown>,
  provider: ApprovalProviderProof | null,
): EffectResourceRef[] {
  const artifacts: EffectResourceRef[] = provider ? [provider.artifact] : [];
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["orderId", "provider.travel_order"],
    ["paymentId", "provider.payment"],
    ["calendarEventId", "provider.calendar_event"],
    ["workflowRunId", "lifeops.workflow_run"],
    ["callSid", "provider.twilio_call"],
    ["providerMessageId", "provider.gmail_message"],
    ["documentId", "lifeops.document_request"],
    ["handoffId", "lifeops.food_shopping_handoff"],
  ];
  for (const [field, kind] of fields) {
    const value = data[field];
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      !artifacts.some(
        (artifact) => artifact.kind === kind && artifact.id === value,
      )
    ) {
      artifacts.push({ kind, id: value.trim() });
    }
  }
  return artifacts;
}

async function completeResolveRequestResult(args: {
  runtime: IAgentRuntime;
  message: Memory;
  operation: string;
  params: ResolveRequestParameters;
  result: ActionResult;
  callback: HandlerCallback | undefined;
}): Promise<ActionResult> {
  const data = asRecord(args.result.data) ?? {};
  const proof = readApprovalEffectProof(data);
  const requestId =
    proof?.requestId ??
    (typeof data.requestId === "string" && data.requestId.trim().length > 0
      ? data.requestId.trim()
      : typeof args.params.requestId === "string" &&
          args.params.requestId.trim().length > 0
        ? args.params.requestId.trim()
        : resolutionRequestId(args.message));
  const operation = `lifeops.approval.${args.operation}`;
  const error =
    typeof data.error === "string" ? data.error : "APPROVAL_NOT_APPLIED";
  const idempotencyKey = proof?.idempotencyKey ?? requestId;

  if (args.result.success !== true) {
    const result =
      typeof args.result.text === "string" && args.result.text.trim().length > 0
        ? args.result
        : {
            ...args.result,
            text: `The approval request was not changed (${error}).`,
          };
    const observedAt = new Date().toISOString();
    return completeLifeOpsEffect(
      args.callback,
      result,
      lifeOpsFailedEffect({
        receiptId: approvalReceiptId(args.message, operation, requestId),
        operation,
        resource: { kind: "lifeops.approval_request", id: requestId },
        artifacts: [],
        idempotency: { key: idempotencyKey, replayed: false },
        observedAt,
        failure: {
          code: error,
          retryable: data.safeToRetry === true,
          acceptance:
            error.includes("AMBIGUOUS") || data.state === "executing"
              ? "unknown"
              : "rejected",
        },
      }),
    );
  }

  const provider = readProviderProof(data);
  const replayed =
    data.duplicateSuppressed === true || data.alreadyResolved === true;
  if (replayed) {
    const observedAt =
      provider?.acceptedAt ?? proof?.updatedAt ?? new Date().toISOString();
    return completeLifeOpsEffect(
      args.callback,
      args.result,
      lifeOpsNoopEffect({
        receiptId: approvalReceiptId(args.message, operation, requestId),
        operation,
        resource: {
          kind: "lifeops.approval_request",
          id: requestId,
          ...(proof ? { version: `${proof.state}:${proof.updatedAt}` } : {}),
        },
        artifacts: approvalArtifacts(data, provider),
        idempotency: { key: idempotencyKey, replayed: true },
        observedAt,
        reason:
          "The persisted approval or provider receipt already represented this decision.",
      }),
    );
  }

  const committedAt = provider?.acceptedAt ?? proof?.updatedAt;
  const commitId =
    provider?.id ??
    (proof ? `${proof.requestId}:${proof.state}:${proof.updatedAt}` : null);
  if (!committedAt || !commitId) {
    const failure: ActionResult = {
      ...args.result,
      success: false,
      text: "I could not verify a durable approval or provider receipt, so I am not claiming the request was applied.",
      data: {
        ...data,
        error: "APPROVAL_COMMIT_PROOF_MISSING",
      },
    };
    return completeLifeOpsEffect(
      args.callback,
      failure,
      lifeOpsFailedEffect({
        receiptId: approvalReceiptId(args.message, operation, requestId),
        operation,
        resource: { kind: "lifeops.approval_request", id: requestId },
        artifacts: [],
        idempotency: { key: idempotencyKey, replayed: false },
        observedAt: new Date().toISOString(),
        failure: {
          code: "APPROVAL_COMMIT_PROOF_MISSING",
          retryable: false,
          acceptance: "unknown",
        },
      }),
    );
  }

  return completeLifeOpsEffect(
    args.callback,
    args.result,
    lifeOpsAppliedEffect({
      receiptId: approvalReceiptId(args.message, operation, commitId),
      operation,
      resource: {
        kind: "lifeops.approval_request",
        id: requestId,
        ...(proof ? { version: `${proof.state}:${proof.updatedAt}` } : {}),
      },
      artifacts: approvalArtifacts(data, provider),
      idempotency: { key: idempotencyKey, replayed: false },
      observedAt: committedAt,
      commit: {
        kind: provider ? "provider_accepted" : "durable",
        id: commitId,
        committedAt,
      },
    }),
  );
}

function approvalChannelToCrossChannelSend(
  channel: ApprovalRequest["channel"],
): CrossChannelSendChannel | null {
  switch (channel) {
    case "telegram":
    case "discord":
    case "imessage":
    case "sms":
    case "x_dm":
      return channel;
    default:
      return null;
  }
}

async function persistSentMailCommitments(args: {
  runtime: IAgentRuntime;
  request: ApprovalRequest;
  sentAt: Date;
}): Promise<void> {
  if (args.request.action !== "send_email") return;
  const payload = args.request.payload;
  if (payload.action !== "send_email") return;
  const adapter = (args.runtime as { adapter?: { db?: unknown } }).adapter;
  if (!adapter?.db) {
    logger.debug(
      `[approval] commitment ledger unavailable for sent email approval ${args.request.id}; runtime has no SQL adapter`,
    );
    return;
  }

  const records = extractCommitmentLedgerRecords({
    agentId: args.runtime.agentId,
    source: "sent_mail",
    sourceKey: `approval:${args.request.id}`,
    text: payload.body,
    observedAt: args.sentAt.toISOString(),
    counterparty: payload.to.join(", ") || null,
    metadata: {
      approvalRequestId: args.request.id,
      subject: payload.subject,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyToMessageId: payload.replyToMessageId,
    },
  });
  if (records.length === 0) return;

  const repository = new LifeOpsRepository(args.runtime);
  try {
    for (const record of records) {
      await repository.upsertCommitmentLedgerRecord(record);
    }
  } catch (error) {
    // error-policy:J7 the sent email is already committed externally; report the
    // projection failure without making the approval retriable and duplicating mail.
    logger.warn(
      `[approval] failed to project sent email approval ${args.request.id} into commitment ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
    args.runtime.reportError?.("lifeops:commitment-ledger:sent-mail", error, {
      requestId: args.request.id,
    });
  }
}

type SchedulingRevalidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error:
        | "SCHEDULING_APPROVAL_STALE"
        | "SCHEDULING_APPROVAL_MATERIAL_CHANGE"
        | "SCHEDULING_APPROVAL_SOURCE_MISSING";
      readonly detail: string;
    };

async function revalidateSchedulingApproval(args: {
  runtime: IAgentRuntime;
  request: ApprovalRequest;
  correlation: NonNullable<
    ReturnType<typeof verifySchedulingApprovalContent>
  >["correlation"];
}): Promise<SchedulingRevalidation> {
  const service = new LifeOpsService(args.runtime);
  const negotiation = await service.getNegotiation(
    args.correlation.negotiationId,
  );
  if (!negotiation) {
    return {
      ok: false,
      error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
      detail: `negotiation ${args.correlation.negotiationId} no longer exists`,
    };
  }

  let draft: Awaited<ReturnType<LifeOpsService["draftOpeningMessage"]>> | null =
    null;
  switch (args.correlation.messageKind) {
    case "opening":
      if (negotiation.updatedAt !== args.correlation.sourceUpdatedAt) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "negotiation changed after the opening draft was approved",
        };
      }
      if (negotiation.state === "cancelled") {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: "negotiation was cancelled after the opening was drafted",
        };
      }
      draft = await service.draftOpeningMessage(negotiation);
      break;
    case "proposal": {
      const proposal = args.correlation.proposalId
        ? (await service.listProposals(negotiation.id)).find(
            (candidate) => candidate.id === args.correlation.proposalId,
          )
        : null;
      if (!proposal) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
          detail: "proposal no longer exists in the negotiation",
        };
      }
      if (proposal.updatedAt !== args.correlation.sourceUpdatedAt) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "proposal changed after its message was approved",
        };
      }
      if (
        proposal.status !== "pending" ||
        negotiation.state === "cancelled" ||
        negotiation.state === "confirmed"
      ) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: `proposal is ${proposal.status} while negotiation is ${negotiation.state}`,
        };
      }
      draft = await service.draftProposalMessage(negotiation, proposal);
      break;
    }
    case "confirmation": {
      const proposal = args.correlation.proposalId
        ? (await service.listProposals(negotiation.id)).find(
            (candidate) => candidate.id === args.correlation.proposalId,
          )
        : null;
      if (!proposal) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
          detail: "accepted proposal no longer exists",
        };
      }
      if (
        negotiation.updatedAt !== args.correlation.sourceUpdatedAt ||
        negotiation.state !== "confirmed" ||
        negotiation.acceptedProposalId !== proposal.id ||
        proposal.status !== "accepted"
      ) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail:
            "accepted proposal or finalized negotiation changed after approval",
        };
      }
      draft = await service.draftConfirmationMessage(negotiation, proposal);
      break;
    }
    case "cancellation": {
      if (
        negotiation.updatedAt !== args.correlation.sourceUpdatedAt ||
        negotiation.state !== "cancelled"
      ) {
        return {
          ok: false,
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: "cancellation state changed after approval",
        };
      }
      const reason =
        typeof negotiation.metadata.cancellationReason === "string"
          ? negotiation.metadata.cancellationReason
          : undefined;
      draft = await service.draftCancellationMessage(negotiation, reason);
      break;
    }
  }

  if (!draft) {
    return {
      ok: false,
      error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
      detail: "counterparty delivery target is no longer available",
    };
  }
  const currentPayload = schedulingApprovalPayloadForDraft(
    draft,
    args.request.payload.action === "send_email"
      ? args.request.payload.grantId
      : undefined,
  );
  const current = verifySchedulingApprovalContent(currentPayload);
  if (
    !current ||
    current.correlation.contentSha256 !== args.correlation.contentSha256 ||
    stableStringify(currentPayload) !== stableStringify(args.request.payload)
  ) {
    return {
      ok: false,
      error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
      detail:
        "recipient, channel, subject, or exact message bytes changed after approval",
    };
  }
  return { ok: true };
}

async function executeApprovedCalendarMutation(args: {
  runtime: IAgentRuntime;
  request: ApprovalRequest;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const result = await executeCalendarMutationApproval({
    runtime: args.runtime,
    request: args.request,
    port: createLifeOpsCalendarMutationPort(args.runtime),
  });
  if (result.kind === "succeeded") {
    const receipt = result.receipt;
    const verb =
      receipt.operation === "schedule_event"
        ? "created"
        : receipt.operation === "modify_event"
          ? "updated"
          : receipt.cancellationMode === "remove_private_copy"
            ? "removed the private copy of"
            : "cancelled";
    const replay = result.duplicateSuppressed
      ? " The durable provider receipt was already present, so no duplicate mutation was sent."
      : "";
    const text = receipt.readBackAvailable
      ? `Approved and ${verb} calendar event ${receipt.providerEventId} on ${receipt.calendarId}.${replay}`
      : `Approved and added the event to the default Apple Calendar. Apple granted add-only access, so no event identifier or readback is available.${replay}`;
    await args.callback?.({ text });
    return {
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      success: true,
      data: {
        actionName: ACTION_NAME,
        operation: receipt.operation,
        requestId: args.request.id,
        state: "done",
        executed: true,
        duplicateSuppressed: result.duplicateSuppressed,
        attemptId: result.attempt.id,
        attemptCompletedAt: result.attempt.completedAt,
        receipt,
      },
    };
  }
  if (result.kind === "blocked") {
    const ambiguous = result.reason === "ambiguous";
    const text = ambiguous
      ? `Calendar request ${args.request.id} has an unknown provider outcome from an earlier attempt. I will not retry it automatically; reconcile the provider calendar first.`
      : `Calendar request ${args.request.id} is already executing. I did not start a second provider mutation.`;
    await args.callback?.({ text });
    return {
      text,
      success: false,
      data: {
        error: ambiguous
          ? "CALENDAR_MUTATION_OUTCOME_AMBIGUOUS"
          : "CALENDAR_MUTATION_IN_FLIGHT",
        requestId: args.request.id,
        state: "executing",
        executed: false,
        safeToRetry: false,
        attempt: result.attempt,
      },
    };
  }
  if (result.kind === "retryable") {
    const text = `Calendar request ${args.request.id} was definitively not accepted during ${result.phase}: ${result.failure.message} Nothing changed; the exact approved request may be retried explicitly.`;
    await args.callback?.({ text });
    return {
      text,
      success: false,
      data: {
        error: result.failure.code,
        requestId: args.request.id,
        state: result.phase === "provider" ? "executing" : "approved",
        executed: false,
        safeToRetry: true,
        phase: result.phase,
        attempt: result.attempt,
      },
    };
  }
  const text = `Calendar request ${args.request.id} is no longer safe to execute: ${result.failure.message} Nothing changed; create a fresh, source-bound approval.`;
  await args.callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: result.failure.code,
      requestId: args.request.id,
      state: "expired",
      executed: false,
      safeToRetry: false,
      attempt: result.attempt,
    },
  };
}

async function dispatchFailureResult(args: {
  request: ApprovalRequest;
  outcome: Exclude<ApprovalDispatchOutcome<unknown>, { kind: "delivered" }>;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const reconciliationRequired =
    args.outcome.kind === "reconciliation_required";
  const text = reconciliationRequired
    ? `The provider outcome for request ${args.request.id} is ambiguous. I will not retry it until the owner or provider reconciles delivery.`
    : `Request ${args.request.id} was not delivered and is safe to retry.`;
  await args.callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: reconciliationRequired
        ? "APPROVAL_RECONCILIATION_REQUIRED"
        : "APPROVAL_DELIVERY_FAILED_RETRYABLE",
      detail: args.outcome.error.message,
      requestId: args.request.id,
      state: args.outcome.request.state,
      action: args.request.action,
      attemptId: args.outcome.request.execution?.attemptId ?? null,
      executed: reconciliationRequired ? null : false,
      deliveryUnknown: reconciliationRequired,
    },
  };
}

function preflightFailureResult(
  request: ApprovalRequest,
  error: unknown,
): ActionResult {
  const known = error instanceof ApprovalConnectorPreflightError;
  return {
    text: "",
    success: false,
    data: {
      error: known ? error.code : "APPROVAL_PREFLIGHT_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      requestId: request.id,
      state: request.state,
      action: request.action,
      executed: false,
    },
  };
}

export async function executeApprovedRequest(args: {
  runtime: IAgentRuntime;
  queue: ApprovalQueue;
  request: ApprovalRequest;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const calendarCard = verifyCalendarCardApproval(args.request.payload);
  if (calendarCard && !calendarCard.matches) {
    return preflightFailureResult(
      args.request,
      new ApprovalConnectorPreflightError(
        "CALENDAR_CARD_APPROVAL_TAMPERED",
        "Calendar card text no longer matches the exact approved bytes",
      ),
    );
  }
  if (calendarCard) {
    if (
      args.request.channel !==
        (calendarCard.correlation.version !== 1
          ? calendarCard.correlation.channel
          : "imessage") ||
      args.request.subjectUserId !==
        (calendarCard.correlation.version === 3 ||
        calendarCard.correlation.version === 4
          ? calendarCard.correlation.ownerEntityId
          : calendarCard.correlation.recipientEntityId)
    ) {
      return preflightFailureResult(
        args.request,
        new ApprovalConnectorPreflightError(
          "CALENDAR_CARD_IDENTITY_MISMATCH",
          "Calendar card approval is not bound to this channel and recipient identity",
        ),
      );
    }
    try {
      await new CalendarCardAccessStore(args.runtime).verifyApprovedBytes(
        calendarCard.correlation,
      );
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
  }
  const scheduling = verifySchedulingApprovalContent(args.request.payload);
  if (scheduling && !scheduling.matches) {
    logger.error(
      `[OwnerResolveRequest] scheduling approval ${args.request.id} content hash mismatch; refusing dispatch`,
    );
    const text = `Approved scheduling draft ${args.request.id}, but its recipient or content no longer matches the approved SHA-256. Nothing was sent.`;
    await args.callback?.({ text });
    return {
      text,
      success: false,
      data: {
        error: "SCHEDULING_APPROVAL_CONTENT_MISMATCH",
        requestId: args.request.id,
        state: args.request.state,
        sent: false,
        expectedSha256: scheduling.correlation.contentSha256,
        actualSha256: scheduling.actualSha256,
        scheduling: scheduling.correlation,
      },
    };
  }
  if (scheduling) {
    const deliveryStore = new SchedulingDeliveryStore(args.runtime);
    const revalidation = await revalidateSchedulingApproval({
      runtime: args.runtime,
      request: args.request,
      correlation: scheduling.correlation,
    });
    if (!revalidation.ok) {
      if (args.request.state === "approved") {
        await deliveryStore.invalidateApproved(
          args.request,
          scheduling.correlation,
          revalidation,
        );
      }
      const text = `Approved scheduling draft ${args.request.id}, but its scheduling source changed: ${revalidation.detail}. Nothing was sent; create a fresh draft for approval.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: revalidation.error,
          detail: revalidation.detail,
          requestId: args.request.id,
          state:
            args.request.state === "approved" ? "expired" : args.request.state,
          sent: false,
          scheduling: scheduling.correlation,
        },
      };
    }

    const registry = getChannelRegistry(args.runtime);
    const channel = registry?.get(scheduling.correlation.transportChannel);
    if (!channel?.send || channel.receiptContract !== "provider_receipt_id") {
      if (args.request.state === "approved") {
        await deliveryStore.invalidateApproved(
          args.request,
          scheduling.correlation,
          {
            error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
            detail: `${scheduling.correlation.transportChannel} does not guarantee a durable provider receipt`,
          },
        );
      }
      const text = `Approved scheduling draft ${args.request.id}, but ${scheduling.correlation.transportChannel} does not guarantee a durable provider receipt. Nothing was sent; the request was terminally invalidated.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "SCHEDULING_PROVIDER_RECEIPT_UNSUPPORTED",
          requestId: args.request.id,
          state:
            args.request.state === "approved" ? "expired" : args.request.state,
          sent: false,
          channel: scheduling.correlation.transportChannel,
          scheduling: scheduling.correlation,
        },
      };
    }

    if (
      args.request.payload.action === "send_email" &&
      (args.request.payload.threadId !== null ||
        (args.request.payload.replyToMessageId ?? null) !== null)
    ) {
      if (args.request.state === "approved") {
        await deliveryStore.invalidateApproved(
          args.request,
          scheduling.correlation,
          {
            error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
            detail:
              "threaded scheduling email delivery is not supported by the receipt-preserving connector path",
          },
        );
      }
      const text = `Approved scheduling draft ${args.request.id} contains a thread or reply target that the receipt-preserving email path cannot guarantee. Nothing was sent; the request was terminally invalidated.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "SCHEDULING_EMAIL_ENVELOPE_UNSUPPORTED",
          requestId: args.request.id,
          state:
            args.request.state === "approved" ? "expired" : args.request.state,
          sent: false,
          scheduling: scheduling.correlation,
        },
      };
    }

    const claim = await deliveryStore.begin(
      args.request,
      scheduling.correlation,
    );
    if (claim.kind === "invalidated") {
      const text = `Approved scheduling draft ${args.request.id}, but its scheduling source changed at the dispatch claim: ${claim.detail}. Nothing was sent; create a fresh draft for approval.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: claim.error,
          detail: claim.detail,
          requestId: args.request.id,
          state: "expired",
          sent: false,
          attempt: claim.attempt,
          scheduling: scheduling.correlation,
        },
      };
    }
    if (claim.kind === "blocked" && claim.reason === "paused") {
      const text =
        "Scheduling delivery is paused for an account switch. Finish the handoff before sending this approved draft.";
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "APPROVAL_DISPATCH_PAUSED",
          requestId: args.request.id,
          state: args.request.state,
          sent: false,
          attempt: claim.attempt,
        },
      };
    }
    if (claim.kind === "blocked") {
      const error =
        claim.reason === "ambiguous"
          ? "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS"
          : "SCHEDULING_DELIVERY_IN_FLIGHT";
      const text =
        claim.reason === "ambiguous"
          ? `Scheduling draft ${args.request.id} has an ambiguous provider outcome from an earlier attempt. I will not retry it automatically because that could send a duplicate. Reconcile the provider message history first.`
          : `Scheduling draft ${args.request.id} is already being delivered by another executor. I did not start a second send.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error,
          requestId: args.request.id,
          state: "executing",
          sent: false,
          attempt: claim.attempt,
        },
      };
    }
    if (claim.kind === "already_succeeded") {
      const receipt = claim.attempt.receipt;
      if (!receipt) {
        throw new ElizaError(
          `[SchedulingDelivery] succeeded attempt ${claim.attempt.id} has no provider receipt`,
          {
            code: "SCHEDULING_DELIVERY_PERSISTED_RECEIPT_INVALID",
            context: { attemptId: claim.attempt.id },
            severity: "fatal",
          },
        );
      }
      const text = `Scheduling message was already sent via ${scheduling.correlation.transportChannel} (provider receipt ${receipt.provider}:${receipt.providerMessageId}); no duplicate was sent.`;
      await args.callback?.({ text });
      return {
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        success: true,
        data: {
          actionName: ACTION_NAME,
          operation: "send_scheduling_message",
          requestId: args.request.id,
          state: "done",
          sent: true,
          duplicateSuppressed: true,
          attemptId: claim.attempt.id,
          attemptCompletedAt: claim.attempt.completedAt,
          receipt,
        },
      };
    }

    const payload = args.request.payload;
    if (payload.action !== "send_email" && payload.action !== "send_message") {
      throw new ElizaError(
        `[SchedulingDelivery] scheduling correlation attached to unsupported action ${payload.action}`,
        {
          code: "SCHEDULING_DELIVERY_ACTION_MISMATCH",
          context: { requestId: args.request.id, action: payload.action },
          severity: "fatal",
        },
      );
    }
    const target =
      payload.action === "send_email"
        ? payload.to.join(",")
        : payload.recipient;
    const body = payload.body;
    const metadata =
      payload.action === "send_email"
        ? {
            subject: payload.subject,
            ...(payload.grantId === undefined
              ? {}
              : { grantId: payload.grantId }),
            cc: [...payload.cc],
            bcc: [...payload.bcc],
          }
        : {};
    let persistedAttempt: SchedulingDeliveryAttempt;
    try {
      const dispatch = await channel.send({
        target,
        message: body,
        idempotencyKey: schedulingDeliveryIdempotencyKey(
          scheduling.correlation.contentSha256,
        ),
        metadata,
      });
      persistedAttempt = await deliveryStore.recordResult(
        claim.attempt,
        dispatch,
      );
    } catch (error) {
      // error-policy:J1 This is the external-dispatch boundary. Any thrown or
      // post-send persistence failure has an unknown acceptance outcome and is
      // durably quarantined rather than retried.
      persistedAttempt = await deliveryStore.recordThrown(claim.attempt, error);
    }

    if (persistedAttempt.state === "succeeded") {
      const receipt = persistedAttempt.receipt;
      if (!receipt) {
        throw new ElizaError(
          `[SchedulingDelivery] succeeded attempt ${persistedAttempt.id} has no provider receipt`,
          {
            code: "SCHEDULING_DELIVERY_PERSISTED_RECEIPT_INVALID",
            context: { attemptId: persistedAttempt.id },
            severity: "fatal",
          },
        );
      }
      const text = `Approved and sent the scheduling ${scheduling.correlation.messageKind} via ${scheduling.correlation.transportChannel} (provider receipt ${receipt.provider}:${receipt.providerMessageId}).`;
      await args.callback?.({ text });
      return {
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        success: true,
        data: {
          actionName: ACTION_NAME,
          operation: "send_scheduling_message",
          requestId: args.request.id,
          state: "done",
          sent: true,
          channel: scheduling.correlation.transportChannel,
          attemptId: persistedAttempt.id,
          attemptCompletedAt: persistedAttempt.completedAt,
          receipt,
          scheduling: scheduling.correlation,
        },
      };
    }

    const retryable = persistedAttempt.state === "failed_retryable";
    const text = retryable
      ? `The ${scheduling.correlation.transportChannel} provider definitively rejected scheduling draft ${args.request.id} before accepting it. Nothing was sent; the exact approved draft can be retried explicitly.`
      : `The ${scheduling.correlation.transportChannel} provider did not return a durable receipt for scheduling draft ${args.request.id}. The outcome is ambiguous, so I will not retry automatically or claim it was sent.`;
    await args.callback?.({ text });
    return {
      text,
      success: false,
      data: {
        error: retryable
          ? "SCHEDULING_DELIVERY_NOT_ACCEPTED"
          : "SCHEDULING_DELIVERY_OUTCOME_AMBIGUOUS",
        requestId: args.request.id,
        state: retryable ? "approved" : "executing",
        sent: false,
        safeToRetry: retryable,
        attempt: persistedAttempt,
        scheduling: scheduling.correlation,
      },
    };
  }

  if (args.request.action === "book_travel") {
    return executeApprovedBookTravel(args);
  }

  if (
    args.request.action === "schedule_event" ||
    args.request.action === "modify_event" ||
    args.request.action === "cancel_event"
  ) {
    return executeApprovedCalendarMutation(args);
  }

  if (args.request.action === "spend_money") {
    const text =
      "This approval cannot spend money: no purchase or transfer rail is configured, so nothing was charged or ordered.";
    await args.callback?.({ text });
    return {
      text,
      success: false,
      data: {
        error: "SPEND_RAIL_UNAVAILABLE",
        action: args.request.action,
        requestId: args.request.id,
        state: args.request.state,
        spent: false,
        executed: false,
      },
    };
  }

  const service = new LifeOpsService(args.runtime);

  if (args.request.action === "send_email") {
    const payload = args.request.payload;
    if (payload.action !== "send_email") {
      throw new Error(
        `[approval] action/payload mismatch: action=send_email, payload.action=${payload.action}`,
      );
    }
    const familyWorkflow = getFamilyWorkflowRuntimeService(args.runtime);
    const familyPackets = familyWorkflow?.packets;
    let familyPacketDraft = null;
    let senderGrantId: string;
    try {
      if (payload.familyPacketId && !familyWorkflow)
        throw new ApprovalConnectorPreflightError(
          "FAMILY_PACKET_SERVICE_UNAVAILABLE",
          "Family authorization is unavailable. Retry after the family workflow service is ready.",
        );
      familyPacketDraft =
        (await familyPackets?.validateApprovedDraftIfBound(args.request)) ??
        null;
      if (payload.body.trim().length === 0) {
        throw new ApprovalConnectorPreflightError(
          "INVALID_EMAIL_PAYLOAD",
          "Email body must not be empty",
        );
      }
      if (
        !payload.replyToMessageId &&
        payload.to.every((recipient) => recipient.trim().length === 0)
      ) {
        throw new ApprovalConnectorPreflightError(
          "INVALID_EMAIL_PAYLOAD",
          "A new email requires at least one recipient",
        );
      }
      const senderGrant = await service.requireGoogleGmailSendGrant(
        INTERNAL_URL,
        "local",
        "owner",
        payload.grantId,
      );
      senderGrantId = senderGrant.id;
      if (payload.replyToMessageId) {
        await service.readGmailMessage(INTERNAL_URL, {
          grantId: senderGrantId,
          mode: "local",
          side: "owner",
          messageId: payload.replyToMessageId,
        });
      }
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "gmail",
        dispatch: async () => {
          let sentEmail: { messageId: string; threadId: string | null } | null =
            null;
          if (familyPacketDraft && familyPackets && familyWorkflow) {
            await familyPackets.validateApprovedDraft(args.request);
            await familyWorkflow.validateRecipientIdentity(familyPacketDraft);
          }
          if (payload.replyToMessageId) {
            await service.sendGmailReply(INTERNAL_URL, {
              grantId: senderGrantId,
              messageId: payload.replyToMessageId,
              bodyText: payload.body,
              subject: payload.subject || undefined,
              to: payload.to.length > 0 ? [...payload.to] : undefined,
              cc: payload.cc.length > 0 ? [...payload.cc] : undefined,
              confirmSend: true,
            });
          } else {
            sentEmail = await service.sendGmailMessage(INTERNAL_URL, {
              grantId: senderGrantId,
              to: [...payload.to],
              cc: [...payload.cc],
              bcc: [...payload.bcc],
              subject: payload.subject,
              bodyText: payload.body,
              confirmSend: true,
            });
          }
          return {
            value: undefined,
            receipt: {
              provider: "gmail",
              accepted: true,
              replyToMessageId: payload.replyToMessageId ?? null,
              ...(sentEmail
                ? {
                    messageId: sentEmail.messageId,
                    threadId: sentEmail.threadId,
                  }
                : {}),
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const done = outcome.request;
    await persistSentMailCommitments({
      runtime: args.runtime,
      request: args.request,
      sentAt: done.updatedAt,
    });
    const text =
      payload.to.length > 0
        ? `Approved and sent email to ${payload.to.join(", ")}.`
        : "Approved and sent the Gmail reply.";
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
      },
    };
  }

  if (args.request.action === "send_message") {
    const channel = approvalChannelToCrossChannelSend(args.request.channel);
    if (!channel) {
      return denied("UNSUPPORTED_APPROVAL_CHANNEL");
    }
    const payload = args.request.payload;
    if (payload.action !== "send_message") {
      throw new Error(
        `[approval] action/payload mismatch: action=send_message, payload.action=${payload.action}`,
      );
    }
    const familyWorkflow = getFamilyWorkflowRuntimeService(args.runtime);
    const familyPackets = familyWorkflow?.packets;
    let familyPacketDraft = null;
    try {
      if (payload.familyPacketId && !familyWorkflow)
        throw new ApprovalConnectorPreflightError(
          "FAMILY_PACKET_SERVICE_UNAVAILABLE",
          "Family authorization is unavailable. Retry after the family workflow service is ready.",
        );
      familyPacketDraft =
        (await familyPackets?.validateApprovedDraftIfBound(args.request)) ??
        null;
      if (familyPacketDraft && channel !== "imessage") {
        throw new ApprovalConnectorPreflightError(
          "FAMILY_PACKET_CHANNEL_INVALID",
          "Family packet approvals require the supported iMessage transport",
        );
      }
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    let prepared: Awaited<ReturnType<typeof prepareCrossChannelSend>>;
    try {
      prepared = await prepareCrossChannelSend({
        runtime: args.runtime,
        service,
        channel,
        target: payload.recipient,
        body: payload.body,
        ...(calendarCard?.correlation.version === 4
          ? { sender: calendarCard.correlation.sender }
          : {}),
      });
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: prepared.provider,
        dispatch: async (providerIdempotencyKey) => {
          if (familyPacketDraft && familyPackets && familyWorkflow) {
            // Re-check the immutable draft, latest-version guard, recipient
            // ACL, and live agreement grant at the final pre-provider edge.
            await familyPackets.validateApprovedDraft(args.request);
            await familyWorkflow.validateRecipientIdentity(familyPacketDraft);
          }
          return {
            value: undefined,
            receipt: await prepared.dispatch(providerIdempotencyKey),
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const done = outcome.request;
    const cardStatus = calendarCard
      ? calendarCardDeliveryStatus({
          accepted: true,
          providerReceipt: done.execution?.providerReceipt ?? null,
          delivered: null,
        })
      : null;
    const text = calendarCard
      ? `Approved calendar card message was accepted by ${channel}; recipient delivery is not confirmed.`
      : familyPacketDraft
        ? `Approved family packet was accepted by ${channel}; recipient delivery is not confirmed.`
        : `Approved and sent ${channel} message.`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        channel,
        providerReceipt: done.execution?.providerReceipt ?? null,
        ...(cardStatus ? { calendarCardDelivery: cardStatus } : {}),
        ...(familyPacketDraft
          ? {
              familyPacketDelivery: calendarCardDeliveryStatus({
                accepted: true,
                providerReceipt: done.execution?.providerReceipt ?? null,
                delivered: null,
              }),
            }
          : {}),
      },
    };
  }

  if (args.request.action === "execute_workflow") {
    const payload = args.request.payload;
    if (payload.action !== "execute_workflow") {
      throw new Error(
        `[approval] action/payload mismatch: action=execute_workflow, payload.action=${payload.action}`,
      );
    }
    if (
      payload.workflowId === HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID
    ) {
      return denied("HOUSEHOLD_APPROVAL_REQUIRES_TYPED_RESOLVER");
    }
    if (payload.workflowId === RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID) {
      const text =
        "This is a review-only household capacity proposal. It requires its typed reviewer and cannot execute a workflow, reserve a resource, mutate a calendar, or send a message.";
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "RESOURCE_CAPACITY_REVIEW_REQUIRES_TYPED_RESOLVER",
          requestId: args.request.id,
          executed: false,
          reserved: false,
          calendarMutated: false,
          messageSent: false,
        },
      };
    }
    if (payload.workflowId === FOOD_APPROVAL_WORKFLOW_ID) {
      const handoffId = payload.input.handoffId;
      if (typeof handoffId !== "string" || handoffId.trim().length === 0) {
        return denied("FOOD_HANDOFF_ID_REQUIRED");
      }
      const handoff = await getFoodDomainService(
        args.runtime,
      ).materializeApprovedShoppingHandoff({
        principalEntityId: SELF_ENTITY_ID,
        handoffId,
      });
      if (
        handoff.state !== "link_created" ||
        handoff.providerResultKind !== "shopping_list_link" ||
        handoff.providerLinkUrl === null
      ) {
        throw new ElizaError(
          "[OwnerResolveRequest] food handoff completed without a link receipt",
          {
            code: "FOOD_PROVIDER_RECEIPT_MISSING",
            context: {
              handoffId: handoff.handoffId,
              state: handoff.state,
              providerResultKind: handoff.providerResultKind,
            },
            severity: "fatal",
          },
        );
      }
      const text = `Approved and created the Instacart shopping-list review link: ${handoff.providerLinkUrl}`;
      await args.callback?.({ text });
      return {
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        success: true,
        data: {
          actionName: ACTION_NAME,
          operation: "materialize_food_shopping_handoff",
          requestId: args.request.id,
          state: "done",
          executed: true,
          handoffId: handoff.handoffId,
          provider: handoff.provider,
          providerResultKind: handoff.providerResultKind,
          providerLinkUrl: handoff.providerLinkUrl,
          handoffUpdatedAt: handoff.updatedAt,
        },
      };
    }
    try {
      await service.getWorkflow(payload.workflowId);
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "lifeops-workflow",
        dispatch: async () => {
          // The owner's approval is the browser-action confirmation.
          const run = await service.runWorkflow(payload.workflowId, {
            confirmBrowserActions: true,
          });
          return {
            value: run,
            receipt: {
              provider: "lifeops-workflow",
              workflowRunId: run.id,
              workflowRunStatus: run.status,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const run = outcome.value;
    const done = outcome.request;
    const text = `Approved and ran workflow ${payload.workflowId} (run ${run.id}: ${run.status}).`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        workflowId: payload.workflowId,
        workflowRunId: run.id,
        workflowRunStatus: run.status,
      },
    };
  }

  if (args.request.action === "make_call") {
    const payload = args.request.payload;
    if (payload.action !== "make_call") {
      throw new Error(
        `[approval] action/payload mismatch: action=make_call, payload.action=${payload.action}`,
      );
    }
    if (payload.to.trim().length === 0 || payload.script.trim().length === 0) {
      return preflightFailureResult(
        args.request,
        new ApprovalConnectorPreflightError(
          "INVALID_CALL_PAYLOAD",
          "A call requires both a recipient and a non-empty script",
        ),
      );
    }
    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      const text = `Approved the call to ${payload.to}, but Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) — the call was not placed.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "TWILIO_NOT_CONFIGURED",
          action: args.request.action,
          requestId: args.request.id,
          state: args.request.state,
        },
      };
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "twilio-voice",
        dispatch: async (providerIdempotencyKey) => {
          const delivery = await sendTwilioVoiceCall({
            credentials,
            to: payload.to,
            message: payload.script,
            idempotencyKey: providerIdempotencyKey,
          });
          if (!delivery.ok) {
            const detail = delivery.error ?? `status ${delivery.status}`;
            if (delivery.status === null || delivery.status >= 500) {
              throw new Error(detail);
            }
            throw new ApprovalKnownNonDeliveryError(
              "TWILIO_DELIVERY_REJECTED",
              detail,
              delivery.status,
            );
          }
          return {
            value: delivery,
            receipt: {
              provider: "twilio",
              sid: delivery.sid ?? null,
              status: delivery.status,
              retryCount: delivery.retryCount ?? 0,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const delivery = outcome.value;
    const done = outcome.request;
    const text = `Approved and placed the call to ${payload.to}${
      delivery.sid ? ` (sid ${delivery.sid})` : ""
    }.`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        callSid: delivery.sid ?? null,
      },
    };
  }

  if (args.request.action === "sign_document") {
    const payload = args.request.payload;
    if (payload.action !== "sign_document") {
      throw new Error(
        `[approval] action/payload mismatch: action=sign_document, payload.action=${payload.action}`,
      );
    }
    if (!getDocumentRequest(args.runtime, payload.documentId)) {
      const text = `Approved the signature request for "${payload.documentName}", but DocumentRequest ${payload.documentId} no longer exists (the document store does not survive restarts) — nothing was dispatched. Please re-issue the signature request.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "DOCUMENT_REQUEST_NOT_FOUND",
          action: args.request.action,
          requestId: args.request.id,
          documentId: payload.documentId,
        },
      };
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "lifeops-document",
        dispatch: async () => {
          const doc = dispatchApprovedSignatureRequest(
            args.runtime,
            payload.documentId,
          );
          if (!doc) {
            throw new ApprovalKnownNonDeliveryError(
              "DOCUMENT_REQUEST_NOT_FOUND",
              `DocumentRequest ${payload.documentId} disappeared before dispatch`,
            );
          }
          return {
            value: doc,
            receipt: {
              provider: "lifeops-document",
              documentId: doc.id,
              documentStatus: doc.status,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const doc = outcome.value;
    const done = outcome.request;
    const text = `Approved and dispatched the signature request for "${doc.title}" (now ${doc.status}).`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        documentId: doc.id,
        documentStatus: doc.status,
      },
    };
  }

  // No executor exists for this action (spend_money, modify_event,
  // cancel_event). spend_money has no spend rail to wire:
  // @elizaos/plugin-finances is read-only — payment-source tracking, CSV
  // import, and spending summaries — and initiates no purchases or
  // transfers. Approving must never report success while executing
  // nothing — surface the gap instead (issue #10723).
  logger.error(
    `[OwnerResolveRequest] request ${args.request.id} approved but no executor exists for action ${args.request.action}; nothing was executed`,
  );
  const text = `Approved request ${args.request.id}, but no executor exists for action "${args.request.action}" — nothing was executed.`;
  await args.callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: "NO_EXECUTOR",
      action: args.request.action,
      requestId: args.request.id,
      state: args.request.state,
    },
  };
}

interface SettledDecision {
  readonly text: string;
  readonly result: ActionResult;
}

function completedApprovalReplay(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} already completed successfully — nothing was executed again.`;
  return {
    text,
    result: {
      text,
      success: true,
      data: {
        requestId: request.id,
        state: request.state,
        action: request.action,
        alreadyResolved: true,
        duplicateSuppressed: true,
        executed: false,
      },
    },
  };
}

function rejectedDecisionReplay(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} was already rejected — nothing was dispatched.`;
  return {
    text,
    result: {
      text,
      success: true,
      data: {
        requestId: request.id,
        state: request.state,
        action: request.action,
        alreadyResolved: true,
        duplicateSuppressed: true,
        executed: false,
      },
    },
  };
}

function executionOutcomeUnknown(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} has an ambiguous provider outcome. I did not retry the operation because its delivery must be reconciled first.`;
  return {
    text,
    result: {
      text,
      success: false,
      data: {
        error: "APPROVAL_EXECUTION_OUTCOME_UNKNOWN",
        requestId: request.id,
        state: request.state,
        action: request.action,
        attemptId: request.execution?.attemptId ?? null,
        provider: request.execution?.provider ?? null,
        providerReceipt: request.execution?.providerReceipt ?? null,
        duplicateSuppressed: true,
        executed: null,
        deliveryUnknown: true,
      },
    },
  };
}

function conflictingDecision(
  intent: ResolveSubaction,
  request: ApprovalRequest,
): SettledDecision {
  const text = `Request ${request.id} is already "${request.state}" — I did not ${intent} it, and nothing was executed.`;
  return {
    text,
    result: {
      text,
      success: false,
      data: {
        error: "APPROVAL_DECISION_CONFLICT",
        requestId: request.id,
        state: request.state,
        action: request.action,
        attempted: intent,
        executed: false,
      },
    },
  };
}

/**
 * Classify terminal or claimed rows before attempting another transition.
 * `approved` deliberately falls through: it is the durable outbox state, not
 * proof of execution, so a replay after a pre-dispatch crash may claim it.
 */
function classifySettledDecision(
  intent: ResolveSubaction,
  request: ApprovalRequest,
): SettledDecision | null {
  if (request.state === "reconciliation_required") {
    return executionOutcomeUnknown(request);
  }
  if (intent === "approve") {
    if (request.state === "done") return completedApprovalReplay(request);
    if (request.state === "rejected" || request.state === "expired") {
      return conflictingDecision(intent, request);
    }
    return null;
  }
  if (intent === "reject" && request.state === "rejected") {
    return rejectedDecisionReplay(request);
  }
  if (request.state === "done" || request.state === "expired") {
    return conflictingDecision(intent, request);
  }
  return null;
}

function isKnownApprovalNotFound(
  error: unknown,
): error is ApprovalNotFoundError | RuntimeApprovalNotFoundError {
  return (
    error instanceof ApprovalNotFoundError ||
    error instanceof RuntimeApprovalNotFoundError
  );
}

function isKnownApprovalTransition(
  error: unknown,
): error is ApprovalStateTransitionError | RuntimeApprovalStateTransitionError {
  return (
    error instanceof ApprovalStateTransitionError ||
    error instanceof RuntimeApprovalStateTransitionError
  );
}

async function returnSettledDecision(
  settled: SettledDecision,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  await callback?.({ text: settled.text });
  return settled.result;
}

/**
 * Reads the approval row this caller may act on. The caller's own subject is
 * the primary scope so another subject's id resolves to nothing rather than
 * confirming that the request exists. Household proposals and
 * resource-capacity reviews addressed to the owner are persisted under
 * SELF_ENTITY_ID, so a miss falls back to that subject; whether the resulting
 * row is a legitimate owner-self target is decided by the caller, which denies
 * everything else as a cross-subject attempt.
 */
async function readResolvableApproval(
  queue: ApprovalQueue,
  requestId: string,
  subjectUserId: string,
): Promise<ApprovalRequest | null> {
  const own = await queue.byId(requestId, subjectUserId);
  if (own || subjectUserId === SELF_ENTITY_ID) return own;
  return queue.byId(requestId, SELF_ENTITY_ID);
}

async function resolveApprovalRequest(
  runtime: IAgentRuntime,
  message: Memory,
  intent: ResolveSubaction,
  params: ResolveRequestParameters,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  if (!(await hasOwnerAccess(runtime, message))) {
    return denied("PERMISSION_DENIED");
  }
  const subjectUserId =
    typeof message.entityId === "string" ? message.entityId : "";
  if (!subjectUserId) {
    return denied("MISSING_SUBJECT_USER");
  }
  let queue: ApprovalQueue;
  try {
    queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  } catch (error) {
    // error-policy:J1 the action boundary converts an incompatible registered
    // queue into a typed denial before any owner decision can be mutated.
    if (error instanceof ApprovalQueueCompatibilityError) {
      return {
        text: "",
        success: false,
        data: {
          error: "APPROVAL_QUEUE_INCOMPATIBLE",
          expectedCapability: "eliza.approval-execution",
          expectedVersion: 2,
          actualCapability:
            error.actualCapability === undefined
              ? null
              : String(error.actualCapability),
          actualVersion:
            error.actualVersion === undefined
              ? null
              : String(error.actualVersion),
        },
      };
    }
    throw error;
  }
  const directPending = await queue.list({
    subjectUserId,
    state: "pending",
    action: null,
    limit: null,
  });
  const selfPending =
    subjectUserId === SELF_ENTITY_ID
      ? []
      : (
          await queue.list({
            subjectUserId: SELF_ENTITY_ID,
            state: "pending",
            action: "execute_workflow",
            limit: null,
          })
        ).filter((request) => {
          const household = readHouseholdProposalApprovalTarget(request);
          const capacity = readResourceCapacityReviewTarget(request);
          return (
            household?.partyEntityId === SELF_ENTITY_ID ||
            capacity?.partyEntityId === SELF_ENTITY_ID
          );
        });
  const pending = [...directPending, ...selfPending].filter(
    (request, index, all) =>
      all.findIndex((candidate) => candidate.id === request.id) === index,
  );
  const userText =
    typeof message.content.text === "string" ? message.content.text : "";
  const explicitRequestId =
    typeof params.requestId === "string" && params.requestId.trim().length > 0
      ? params.requestId.trim()
      : null;
  const explicitReason =
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : null;
  const extracted = explicitRequestId
    ? { requestId: explicitRequestId, reason: explicitReason }
    : await extractResolution(runtime, userText, intent, pending);
  if (!extracted.requestId) {
    // Ambiguous target with pending rows: ask with one-tap chips instead of
    // demanding a typed id (#14733).
    const text =
      pending.length === 0
        ? "There are no pending approval requests."
        : appendInteractionBlock(
            "Which request?",
            buildResolveRequestChoice(intent, pending),
          );
    if (callback) await callback({ text });
    return {
      text,
      success: false,
      values: { requiresConfirmation: true },
      data: {
        error: "REQUEST_ID_NOT_RESOLVED",
        pendingCount: pending.length,
        requiresConfirmation: true,
      },
    };
  }
  return settleApprovalRequest(
    runtime,
    queue,
    subjectUserId,
    intent,
    params,
    {
      requestId: extracted.requestId,
      reason: extracted.reason,
    },
    callback,
  );
}

/**
 * Resolve an explicit decision from an authenticated owner transport without
 * model inference. The caller supplies its verified owner identity, never an
 * identity from the request body; canonical subject and dispatch checks remain
 * in the same settlement path used by the owner action.
 */
export async function resolveExplicitOwnerApproval(
  runtime: IAgentRuntime,
  input: {
    subjectUserId: string;
    requestId: string;
    decision: "approve" | "reject";
    reason: string;
  },
): Promise<ActionResult> {
  if (!input.subjectUserId.trim() || !input.requestId.trim())
    return denied("MISSING_APPROVAL_IDENTITY");
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  return settleApprovalRequest(
    runtime,
    queue,
    input.subjectUserId,
    input.decision,
    { requestId: input.requestId, reason: input.reason },
    { requestId: input.requestId, reason: input.reason },
    undefined,
  );
}

async function settleApprovalRequest(
  runtime: IAgentRuntime,
  queue: ApprovalQueue,
  subjectUserId: string,
  intent: ResolveSubaction,
  params: ResolveRequestParameters,
  extracted: { requestId: string; reason: string | null },
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const resolution = {
    resolvedBy: subjectUserId,
    resolutionReason: extracted.reason ?? `user ${intent}d`,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let current = await readResolvableApproval(
      queue,
      extracted.requestId,
      subjectUserId,
    );
    if (!current) return denied("REQUEST_NOT_FOUND");

    const householdTarget = readHouseholdProposalApprovalTarget(current);
    const capacityTarget = readResourceCapacityReviewTarget(current);
    if (isHouseholdProposalApprovalWorkflow(current) && !householdTarget) {
      if (current.subjectUserId !== SELF_ENTITY_ID) {
        return denied("HOUSEHOLD_APPROVAL_INVALID_CONTRACT");
      }
      const invalidated = await queue.markExpired(
        current.id,
        current.subjectUserId,
      );
      const text = `Household approval ${current.id} has an invalid proposal contract. Nothing was executed; the request was terminally invalidated.`;
      await callback?.({ text });
      return withApprovalProof(
        {
          text,
          success: false,
          data: {
            error: "HOUSEHOLD_APPROVAL_INVALID_CONTRACT",
            requestId: invalidated.id,
            state: invalidated.state,
            executed: false,
          },
        },
        invalidated,
      );
    }
    if (isResourceCapacityReviewWorkflow(current) && !capacityTarget) {
      if (current.subjectUserId !== SELF_ENTITY_ID) {
        return denied("RESOURCE_CAPACITY_REVIEW_INVALID_CONTRACT");
      }
      const invalidated = await queue.markExpired(
        current.id,
        current.subjectUserId,
      );
      const text = `Resource-capacity review ${current.id} has an invalid proposal contract. Nothing was reserved, changed, or sent; the request was terminally invalidated.`;
      await callback?.({ text });
      return withApprovalProof(
        {
          text,
          success: false,
          data: {
            error: "RESOURCE_CAPACITY_REVIEW_INVALID_CONTRACT",
            requestId: invalidated.id,
            state: invalidated.state,
            executed: false,
          },
        },
        invalidated,
      );
    }
    const authenticatedOwnerSelfApproval =
      (householdTarget?.partyEntityId === SELF_ENTITY_ID ||
        capacityTarget?.partyEntityId === SELF_ENTITY_ID) &&
      current.subjectUserId === SELF_ENTITY_ID;
    if (
      current.subjectUserId !== subjectUserId &&
      !authenticatedOwnerSelfApproval
    ) {
      logger.warn(
        `[OwnerResolveRequest] ${subjectUserId} attempted to resolve approval ${current.id} owned by ${current.subjectUserId}`,
      );
      return denied("CROSS_SUBJECT_APPROVAL_FORBIDDEN");
    }
    try {
      if (
        intent === "reconcile_delivered" ||
        intent === "reconcile_not_delivered"
      ) {
        if (current.state !== "reconciliation_required" || !current.execution) {
          return returnSettledDecision(
            conflictingDecision(intent, current),
            callback,
          );
        }
        const reconciled = await queue.reconcileExecution({
          requestId: current.id,
          subjectUserId: current.subjectUserId,
          attemptId: current.execution.attemptId,
          outcome:
            intent === "reconcile_delivered" ? "delivered" : "not_delivered",
          reconciledBy: subjectUserId,
          reconciliationReason:
            extracted.reason ?? `owner ${intent.replace("_", " ")}`,
          providerReceipt:
            typeof params.providerReceiptId === "string" &&
            params.providerReceiptId.trim().length > 0
              ? {
                  provider: current.execution.provider,
                  receiptId: params.providerReceiptId.trim(),
                }
              : undefined,
        });
        const text =
          reconciled.state === "done"
            ? `Reconciled request ${reconciled.id} as delivered.`
            : `Reconciled request ${reconciled.id} as not delivered; it is now safe to retry.`;
        await callback?.({ text });
        return withApprovalProof(
          {
            text,
            success: true,
            data: {
              requestId: reconciled.id,
              state: reconciled.state,
              action: reconciled.action,
              executed: reconciled.state === "done",
              deliveryReconciled: true,
            },
          },
          reconciled,
        );
      }

      if (current.state === "executing") {
        current = await recoverInterruptedApproval(
          queue,
          current,
          current.subjectUserId,
        );
      }
      const settled = classifySettledDecision(intent, current);
      if (settled) return returnSettledDecision(settled, callback);

      if (capacityTarget) {
        if (!authenticatedOwnerSelfApproval) {
          return denied("CROSS_SUBJECT_APPROVAL_FORBIDDEN");
        }
        const capacity = getResourceCapacityService(runtime);
        if (!capacity) {
          return denied("RESOURCE_CAPACITY_SERVICE_UNAVAILABLE");
        }
        const updated = await capacity.respondToProposal({
          principalEntityId: SELF_ENTITY_ID,
          proposalId: capacityTarget.proposalId,
          proposalVersion: capacityTarget.proposalVersion,
          partyEntityId: SELF_ENTITY_ID,
          approvalRequestId: current.id,
          contentSha256: capacityTarget.contentSha256,
          decision: intent,
          reason: extracted.reason ?? `owner ${intent}d capacity proposal`,
        });
        const text =
          intent === "approve"
            ? `Reviewed resource-capacity proposal ${capacityTarget.proposalId} v1. No caregiver, vehicle, or restraint was reserved; no calendar changed and no message was sent.`
            : `Declined resource-capacity proposal ${capacityTarget.proposalId} v1. Nothing was reserved, changed, or sent.`;
        await callback?.({ text });
        return withApprovalProof(
          {
            text,
            success: true,
            data: {
              actionName: ACTION_NAME,
              operation: "review_resource_capacity_proposal",
              requestId: updated.id,
              state: updated.state,
              action: updated.action,
              proposalId: capacityTarget.proposalId,
              proposalVersion: capacityTarget.proposalVersion,
              decision: intent,
              resolvedBy: updated.resolvedBy,
              executed: false,
              reserved: false,
              calendarMutated: false,
              messageSent: false,
            },
          },
          updated,
        );
      }
      if (householdTarget) {
        if (!authenticatedOwnerSelfApproval) {
          return denied("CROSS_SUBJECT_APPROVAL_FORBIDDEN");
        }
        const { createHouseholdCoordinationService } = await import(
          "../lifeops/household/service.js"
        );
        const updated = await createHouseholdCoordinationService(
          runtime,
        ).respondToProposal({
          proposalId: householdTarget.proposalId,
          proposalVersion: householdTarget.proposalVersion,
          partyEntityId: SELF_ENTITY_ID,
          approvalRequestId: current.id,
          decision: intent,
          reason: extracted.reason ?? `owner ${intent}d household proposal`,
        });
        const text =
          intent === "approve"
            ? `Approved household schedule proposal ${householdTarget.proposalId} v${householdTarget.proposalVersion}.`
            : `Rejected household schedule proposal ${householdTarget.proposalId} v${householdTarget.proposalVersion}.`;
        await callback?.({ text });
        return withApprovalProof(
          {
            text,
            success: true,
            data: {
              actionName: ACTION_NAME,
              operation: "resolve_household_schedule_proposal",
              requestId: updated.id,
              state: updated.state,
              action: updated.action,
              proposalId: householdTarget.proposalId,
              proposalVersion: householdTarget.proposalVersion,
              coordinationId: householdTarget.coordinationId,
              decision: intent,
              resolvedBy: updated.resolvedBy,
            },
          },
          updated,
        );
      }
      if (intent === "reject") {
        const rejected = await queue.reject(
          current.id,
          current.subjectUserId,
          resolution,
        );
        logger.info(
          `[OwnerResolveRequest] ${intent} ${rejected.id} by ${subjectUserId}`,
        );
        const text = `Rejected request ${rejected.id}.`;
        await callback?.({ text });
        return withApprovalProof(
          {
            text,
            success: true,
            data: {
              requestId: rejected.id,
              state: rejected.state,
              action: rejected.action,
            },
          },
          rejected,
        );
      }

      const approved =
        current.state === "approved" || current.state === "retryable"
          ? current
          : await queue.approve(current.id, current.subjectUserId, resolution);
      // The tracking wrapper captures the last row the executor persisted so the
      // receipt reflects the real terminal state, not the pre-dispatch snapshot.
      let latestPersisted = approved;
      const trackedQueue = trackingApprovalQueue(queue, (request) => {
        latestPersisted = request;
      });
      const executed = await executeApprovedRequest({
        runtime,
        queue: trackedQueue,
        request: approved,
        callback,
      });
      return withApprovalProof(executed, latestPersisted);
    } catch (error) {
      // error-policy:J1 queue CAS failures are translated at the action
      // boundary after an authoritative re-read; unrelated errors propagate.
      if (isKnownApprovalNotFound(error)) {
        return denied("REQUEST_NOT_FOUND");
      }
      if (isKnownApprovalTransition(error)) {
        continue;
      }
      throw error;
    }
  }

  const latest = await readResolvableApproval(
    queue,
    extracted.requestId,
    subjectUserId,
  );
  if (!latest) return denied("REQUEST_NOT_FOUND");
  const settled = classifySettledDecision(intent, latest);
  if (settled) return returnSettledDecision(settled, callback);
  const text = `Request ${latest.id} kept changing state while I was resolving it — nothing was executed.`;
  await callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: "TRANSITION_CONFLICT",
      requestId: latest.id,
      state: latest.state,
      executed: false,
    },
  };
}

export const resolveRequestAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  suppressPostActionContinuation: true,
  similes: [
    "APPROVE",
    "REJECT",
    "CONFIRM",
    "DENY",
    "YES_DO_IT",
    "NO_DONT",
    "ACCEPT_REQUEST",
    "DECLINE_REQUEST",
    "ADMIN_REJECT_APPROVAL",
    "REJECT_APPROVAL",
    "DENY_APPROVAL",
    "DECLINE_APPROVAL",
  ],
  tags: [
    "domain:meta",
    "capability:execute",
    "capability:update",
    "capability:send",
    "effect:receipt-required",
    "surface:internal",
    "risk:irreversible",
  ],
  description:
    "Approve/reject pending owner-confirmation action: send_email, send_message, book_travel, voice_call, etc. " +
    "Subactions approve|reject. Reject also covers holds ('don't send it', 'not yet', 'wait until I confirm') — " +
    "it terminally cancels the queued dispatch and a fresh request can be queued later. " +
    "requestId optional; handler inspects pending queue, infers owner intent, or asks follow-up.",
  descriptionCompressed:
    "approve|reject pending approval queue; reject=hold/don't-send-now (nothing dispatches); requestId optional",
  contexts: [
    "email",
    "messaging",
    "calendar",
    "tasks",
    "contacts",
    "payments",
    "automation",
    "admin",
    "general",
  ],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  parameters: [
    {
      name: "action",
      description:
        "approve | reject | reconcile_delivered | reconcile_not_delivered.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "approve",
          "reject",
          "reconcile_delivered",
          "reconcile_not_delivered",
        ],
      },
    },
    {
      name: "requestId",
      description:
        "Approval request id. Optional when user references pending request.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Optional approve/reject reason, user language.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    const resolved = await resolveActionArgs<
      ResolveSubaction,
      ResolveRequestParameters
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return completeResolveRequestResult({
        runtime,
        message,
        operation: "resolve",
        params: {},
        result: {
          success: false,
          text: resolved.clarification,
          data: {
            actionName: ACTION_NAME,
            error: "APPROVAL_RESOLUTION_CLARIFICATION_REQUIRED",
            missing: resolved.missing,
          },
        },
        callback,
      });
    }
    const result = await resolveApprovalRequest(
      runtime,
      message,
      resolved.subaction,
      resolved.params,
      undefined,
    );
    return completeResolveRequestResult({
      runtime,
      message,
      operation: resolved.subaction,
      params: resolved.params,
      result,
      callback,
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Yeah, go ahead and send that draft.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Approved request req-8821.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "No, don't send that. Let's hold off.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Rejected request req-8821.",
        },
      },
    ],
  ] as ActionExample[][],
};
