/**
 * Durable execution evidence for approval-gated scheduling messages. The
 * shared approval row is the only queue; this store atomically claims that
 * row with a PA-owned attempt record, records provider receipts, and leaves
 * ambiguous sends non-retriable until an operator reconciles the provider.
 */
import { randomUUID } from "node:crypto";
import { approvalDispatchAdmissionCte } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  DispatchReceipt,
  DispatchResult,
} from "@elizaos/plugin-scheduling";
import type {
  ApprovalRequest,
  SchedulingApprovalCorrelation,
} from "./approval-queue.types.js";
import { safeFormatError } from "./connectors/_helpers.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlJson,
  sqlText,
  type TransactionalDb,
  toText,
  withRequiredTransaction,
} from "./sql.js";

export type SchedulingDeliveryState =
  | "awaiting_approval"
  | "dispatching"
  | "succeeded"
  | "failed_retryable"
  | "ambiguous"
  | "invalidated";

export interface SchedulingDeliveryAttempt {
  readonly id: string;
  readonly agentId: string;
  readonly approvalRequestId: string;
  readonly negotiationId: string;
  readonly proposalId: string | null;
  readonly contentSha256: string;
  readonly idempotencyKey: string;
  readonly channel: string;
  readonly provider: string | null;
  readonly state: SchedulingDeliveryState;
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly receipt: DispatchReceipt | null;
  readonly lastFailure: Record<string, unknown> | null;
  readonly firstAttemptedAt: string | null;
  readonly lastAttemptedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type BeginSchedulingDeliveryResult =
  | { readonly kind: "claimed"; readonly attempt: SchedulingDeliveryAttempt }
  | {
      readonly kind: "already_succeeded";
      readonly attempt: SchedulingDeliveryAttempt;
    }
  | {
      readonly kind: "blocked";
      readonly reason: "in_flight" | "ambiguous" | "paused";
      readonly attempt: SchedulingDeliveryAttempt;
    }
  | {
      readonly kind: "invalidated";
      readonly error:
        | "SCHEDULING_APPROVAL_STALE"
        | "SCHEDULING_APPROVAL_MATERIAL_CHANGE"
        | "SCHEDULING_APPROVAL_SOURCE_MISSING";
      readonly detail: string;
      readonly attempt: SchedulingDeliveryAttempt;
    };

const VALID_STATES: ReadonlySet<SchedulingDeliveryState> = new Set([
  "awaiting_approval",
  "dispatching",
  "succeeded",
  "failed_retryable",
  "ambiguous",
  "invalidated",
]);

const SELECT_COLUMNS = [
  "id",
  "agent_id",
  "approval_request_id",
  "negotiation_id",
  "proposal_id",
  "content_sha256",
  "idempotency_key",
  "channel",
  "provider",
  "state",
  "attempt_count",
  "provider_message_id",
  "receipt_json",
  "last_failure_json",
  "first_attempted_at",
  "last_attempted_at",
  "completed_at",
  "created_at",
  "updated_at",
].join(", ");

function deliveryInvariant(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
): ElizaError {
  return new ElizaError(`[SchedulingDelivery] ${message}`, {
    code,
    context,
    severity: "fatal",
  });
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === "") return null;
  return parseJsonRecord(value);
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw deliveryInvariant(
      "SCHEDULING_DELIVERY_PERSISTED_ROW_INVALID",
      `persisted ${field} is not a non-negative integer`,
      { field, value },
    );
  }
  return parsed;
}

function parseReceipt(value: unknown): DispatchReceipt | null {
  const record = optionalRecord(value);
  if (!record) return null;
  const provider = optionalText(record.provider);
  const providerMessageId = optionalText(record.providerMessageId);
  const idempotencyKey = optionalText(record.idempotencyKey);
  const acceptedAt = optionalText(record.acceptedAt);
  if (!provider || !providerMessageId || !idempotencyKey || !acceptedAt) {
    throw deliveryInvariant(
      "SCHEDULING_DELIVERY_PERSISTED_RECEIPT_INVALID",
      "persisted provider receipt is incomplete",
      { receipt: record },
    );
  }
  return {
    provider,
    providerMessageId,
    idempotencyKey,
    acceptedAt,
    ...(record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
  };
}

function rowToAttempt(row: Record<string, unknown>): SchedulingDeliveryAttempt {
  const state = toText(row.state) as SchedulingDeliveryState;
  if (!VALID_STATES.has(state)) {
    throw deliveryInvariant(
      "SCHEDULING_DELIVERY_PERSISTED_STATE_INVALID",
      `unknown persisted state: ${toText(row.state)}`,
      { state: row.state },
    );
  }
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    approvalRequestId: toText(row.approval_request_id),
    negotiationId: toText(row.negotiation_id),
    proposalId: optionalText(row.proposal_id),
    contentSha256: toText(row.content_sha256),
    idempotencyKey: toText(row.idempotency_key),
    channel: toText(row.channel),
    provider: optionalText(row.provider),
    state,
    attemptCount: requiredNonNegativeInteger(
      row.attempt_count,
      "attempt_count",
    ),
    providerMessageId: optionalText(row.provider_message_id),
    receipt: parseReceipt(row.receipt_json),
    lastFailure: optionalRecord(row.last_failure_json),
    firstAttemptedAt: optionalText(row.first_attempted_at),
    lastAttemptedAt: optionalText(row.last_attempted_at),
    completedAt: optionalText(row.completed_at),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function schedulingDeliveryIdempotencyKey(
  contentSha256: string,
): string {
  return `scheduling-message:v1:${contentSha256}`;
}

export function validateDispatchReceipt(
  result: DispatchResult,
  expectedIdempotencyKey: string,
): DispatchReceipt | null {
  if (!result.ok || !result.receipt) return null;
  const receipt = result.receipt;
  if (
    !receipt.provider.trim() ||
    !receipt.providerMessageId.trim() ||
    receipt.idempotencyKey !== expectedIdempotencyKey ||
    !Number.isFinite(Date.parse(receipt.acceptedAt))
  ) {
    return null;
  }
  return receipt;
}

export async function prepareSchedulingDelivery(
  tx: TransactionalDb,
  args: {
    agentId: string;
    request: ApprovalRequest;
    correlation: SchedulingApprovalCorrelation;
  },
): Promise<SchedulingDeliveryAttempt> {
  const now = new Date().toISOString();
  const idempotencyKey = schedulingDeliveryIdempotencyKey(
    args.correlation.contentSha256,
  );
  const id = randomUUID();
  await executeRawSqlTx(
    tx,
    `INSERT INTO app_lifeops.life_scheduling_delivery_attempts (
       id, agent_id, approval_request_id, negotiation_id, proposal_id,
       content_sha256, idempotency_key, channel, provider, state,
       attempt_count, provider_message_id, receipt_json, last_failure_json,
       first_attempted_at, last_attempted_at, completed_at, created_at, updated_at
     ) VALUES (
       ${sqlText(id)},
       ${sqlText(args.agentId)},
       ${sqlText(args.request.id)},
       ${sqlText(args.correlation.negotiationId)},
       ${sqlText(args.correlation.proposalId)},
       ${sqlText(args.correlation.contentSha256)},
       ${sqlText(idempotencyKey)},
       ${sqlText(args.correlation.transportChannel)},
       NULL,
       ${sqlText("awaiting_approval")},
       0, NULL, NULL, NULL, NULL, NULL, NULL,
       ${sqlText(now)},
       ${sqlText(now)}
     )
     ON CONFLICT (agent_id, idempotency_key) DO NOTHING`,
  );
  const rows = await executeRawSqlTx(
    tx,
    `SELECT ${SELECT_COLUMNS}
       FROM app_lifeops.life_scheduling_delivery_attempts
      WHERE agent_id = ${sqlText(args.agentId)}
        AND idempotency_key = ${sqlText(idempotencyKey)}
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    throw deliveryInvariant(
      "SCHEDULING_DELIVERY_PREPARE_FAILED",
      "preparation returned no durable attempt row",
      { agentId: args.agentId, idempotencyKey },
    );
  }
  const attempt = rowToAttempt(row);
  if (
    attempt.approvalRequestId !== args.request.id ||
    attempt.negotiationId !== args.correlation.negotiationId ||
    attempt.proposalId !== args.correlation.proposalId ||
    attempt.contentSha256 !== args.correlation.contentSha256 ||
    attempt.channel !== args.correlation.transportChannel
  ) {
    throw deliveryInvariant(
      "SCHEDULING_DELIVERY_IDEMPOTENCY_CONFLICT",
      "idempotency key identifies different scheduling content",
      {
        idempotencyKey,
        approvalRequestId: args.request.id,
        existingApprovalRequestId: attempt.approvalRequestId,
      },
    );
  }
  return attempt;
}

export class SchedulingDeliveryStore {
  constructor(private readonly runtime: IAgentRuntime) {}

  async byApprovalRequestId(
    approvalRequestId: string,
  ): Promise<SchedulingDeliveryAttempt | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT ${SELECT_COLUMNS}
         FROM app_lifeops.life_scheduling_delivery_attempts
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND approval_request_id = ${sqlText(approvalRequestId)}
        LIMIT 1`,
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async begin(
    request: ApprovalRequest,
    correlation: SchedulingApprovalCorrelation,
  ): Promise<BeginSchedulingDeliveryResult> {
    return withRequiredTransaction(this.runtime, async (tx) => {
      // Share the canonical admission row lock with pause/resume and other
      // approval claims, holding it until this claim transaction commits.
      const admissionRows = await executeRawSqlTx(
        tx,
        `${approvalDispatchAdmissionCte(this.runtime.agentId, request.subjectUserId, request.id)} SELECT paused, permitted FROM approval_permission`,
      );
      const admission = admissionRows[0];
      if (
        !admission ||
        typeof admission.paused !== "boolean" ||
        typeof admission.permitted !== "boolean"
      )
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_ADMISSION_INVALID",
          "dispatch admission returned no valid control",
          { approvalRequestId: request.id },
        );
      let attempt = await this.byApprovalRequestIdTx(tx, request.id);
      if (!attempt) {
        attempt = await prepareSchedulingDelivery(tx, {
          agentId: this.runtime.agentId,
          request,
          correlation,
        });
      }
      if (
        attempt.contentSha256 !== correlation.contentSha256 ||
        attempt.idempotencyKey !==
          schedulingDeliveryIdempotencyKey(correlation.contentSha256)
      ) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_CONTENT_MISMATCH",
          "approval content does not match durable attempt",
          {
            approvalRequestId: request.id,
            attemptId: attempt.id,
            contentSha256: correlation.contentSha256,
          },
        );
      }
      if (attempt.state === "succeeded") {
        return { kind: "already_succeeded", attempt };
      }
      if (attempt.state === "ambiguous") {
        return { kind: "blocked", reason: "ambiguous", attempt };
      }
      if (attempt.state === "dispatching") {
        return { kind: "blocked", reason: "in_flight", attempt };
      }
      if (attempt.state === "invalidated") {
        return {
          kind: "invalidated",
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "the approved scheduling source was already invalidated",
          attempt,
        };
      }

      if (admission.paused)
        return { kind: "blocked", reason: "paused", attempt };

      if (!admission.permitted) {
        const invalidated = await this.invalidateTx(tx, request, attempt, {
          error: "SCHEDULING_APPROVAL_STALE",
          detail:
            "Review a new approval for the current sender account after handoff",
        });
        return {
          kind: "invalidated",
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "The sender approval predates account handoff",
          attempt: invalidated,
        };
      }

      const sourceFailure = await this.sourcePreconditionFailureTx(
        tx,
        correlation,
      );
      if (sourceFailure) {
        const invalidated = await this.invalidateTx(
          tx,
          request,
          attempt,
          sourceFailure,
        );
        return { kind: "invalidated", ...sourceFailure, attempt: invalidated };
      }

      const approvalRows = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("executing")},
                updated_at = ${sqlText(new Date().toISOString())}
          WHERE id = ${sqlText(request.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND subject_user_id = ${sqlText(request.subjectUserId)}
            AND state = ${sqlText("approved")}
          RETURNING id`,
      );
      if (approvalRows.length === 0) {
        const latest = await this.byApprovalRequestIdTx(tx, request.id);
        if (latest?.state === "dispatching") {
          return { kind: "blocked", reason: "in_flight", attempt: latest };
        }
        if (latest?.state === "ambiguous") {
          return { kind: "blocked", reason: "ambiguous", attempt: latest };
        }
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_APPROVAL_NOT_CLAIMABLE",
          `approval ${request.id} is not claimable from approved`,
          { approvalRequestId: request.id },
        );
      }

      const now = new Date().toISOString();
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_scheduling_delivery_attempts
            SET state = ${sqlText("dispatching")},
                attempt_count = attempt_count + 1,
                first_attempted_at = COALESCE(first_attempted_at, ${sqlText(now)}),
                last_attempted_at = ${sqlText(now)},
                last_failure_json = NULL,
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${sqlText("awaiting_approval")}, ${sqlText("failed_retryable")})
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_CLAIM_CONFLICT",
          `attempt ${attempt.id} lost its dispatch claim`,
          { attemptId: attempt.id, approvalRequestId: request.id },
        );
      }
      return { kind: "claimed", attempt: rowToAttempt(rows[0]) };
    });
  }

  /**
   * Terminally close an approved draft that fails a non-source preflight such
   * as contact or provider-contract revalidation. The guarded transition
   * cannot overwrite a concurrent executor that already claimed the send.
   */
  async invalidateApproved(
    request: ApprovalRequest,
    correlation: SchedulingApprovalCorrelation,
    failure: {
      readonly error:
        | "SCHEDULING_APPROVAL_STALE"
        | "SCHEDULING_APPROVAL_MATERIAL_CHANGE"
        | "SCHEDULING_APPROVAL_SOURCE_MISSING";
      readonly detail: string;
    },
  ): Promise<SchedulingDeliveryAttempt> {
    return withRequiredTransaction(this.runtime, async (tx) => {
      const attempt = await this.byApprovalRequestIdTx(tx, request.id);
      if (!attempt) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_ATTEMPT_MISSING",
          `approval ${request.id} has no durable attempt to invalidate`,
          { approvalRequestId: request.id },
        );
      }
      if (
        attempt.contentSha256 !== correlation.contentSha256 ||
        attempt.idempotencyKey !==
          schedulingDeliveryIdempotencyKey(correlation.contentSha256)
      ) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_CONTENT_MISMATCH",
          "refusing to invalidate a mismatched durable attempt",
          { approvalRequestId: request.id, attemptId: attempt.id },
        );
      }
      return this.invalidateTx(tx, request, attempt, failure);
    });
  }

  async recordResult(
    attempt: SchedulingDeliveryAttempt,
    result: DispatchResult,
  ): Promise<SchedulingDeliveryAttempt> {
    const receipt = validateDispatchReceipt(result, attempt.idempotencyKey);
    if (receipt) {
      return this.recordSuccess(attempt, receipt);
    }
    if (!result.ok && result.acceptance === "not_accepted") {
      return this.recordNotAccepted(attempt, result);
    }
    const failure: Record<string, unknown> = result.ok
      ? {
          code: "MISSING_DURABLE_PROVIDER_RECEIPT",
          messageId: result.messageId ?? null,
        }
      : {
          code: "AMBIGUOUS_PROVIDER_FAILURE",
          reason: result.reason,
          message: result.message ?? null,
        };
    return this.recordAmbiguous(attempt, failure);
  }

  async recordThrown(
    attempt: SchedulingDeliveryAttempt,
    error: unknown,
  ): Promise<SchedulingDeliveryAttempt> {
    return this.recordAmbiguous(attempt, {
      code: "CONNECTOR_THROWN_OUTCOME_UNKNOWN",
      message: safeFormatError(error),
    });
  }

  private async byApprovalRequestIdTx(
    tx: TransactionalDb,
    approvalRequestId: string,
  ): Promise<SchedulingDeliveryAttempt | null> {
    const rows = await executeRawSqlTx(
      tx,
      `SELECT ${SELECT_COLUMNS}
         FROM app_lifeops.life_scheduling_delivery_attempts
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND approval_request_id = ${sqlText(approvalRequestId)}
        LIMIT 1
        FOR UPDATE`,
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  private async sourcePreconditionFailureTx(
    tx: TransactionalDb,
    correlation: SchedulingApprovalCorrelation,
  ): Promise<{
    readonly error:
      | "SCHEDULING_APPROVAL_STALE"
      | "SCHEDULING_APPROVAL_MATERIAL_CHANGE"
      | "SCHEDULING_APPROVAL_SOURCE_MISSING";
    readonly detail: string;
  } | null> {
    const negotiations = await executeRawSqlTx(
      tx,
      `SELECT relationship_id, state, accepted_proposal_id, updated_at
         FROM app_lifeops.life_scheduling_negotiations
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND id = ${sqlText(correlation.negotiationId)}
        LIMIT 1
        FOR UPDATE`,
    );
    const negotiation = negotiations[0];
    if (!negotiation) {
      return {
        error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
        detail: `negotiation ${correlation.negotiationId} no longer exists at dispatch claim`,
      };
    }
    const negotiationState = toText(negotiation.state);
    const negotiationUpdatedAt = toText(negotiation.updated_at);
    const acceptedProposalId = optionalText(negotiation.accepted_proposal_id);
    const relationshipId = optionalText(negotiation.relationship_id);
    if (relationshipId !== correlation.counterpartyEntityId) {
      return {
        error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
        detail: "negotiation counterparty changed before the dispatch claim",
      };
    }
    const contactRows = await executeRawSqlTx(
      tx,
      `SELECT updated_at
         FROM app_lifeops.life_entities
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND entity_id = ${sqlText(correlation.counterpartyEntityId)}
        LIMIT 1
        FOR UPDATE`,
    );
    const contact = contactRows[0];
    if (!contact) {
      return {
        error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
        detail: `counterparty ${correlation.counterpartyEntityId} no longer exists at dispatch claim`,
      };
    }
    if (
      toText(contact.updated_at) !== correlation.counterpartyEntityUpdatedAt
    ) {
      return {
        error: "SCHEDULING_APPROVAL_STALE",
        detail: "counterparty contact changed before the dispatch claim",
      };
    }

    if (correlation.messageKind === "opening") {
      if (negotiationUpdatedAt !== correlation.sourceUpdatedAt) {
        return {
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "negotiation changed before the opening dispatch claim",
        };
      }
      if (negotiationState === "cancelled") {
        return {
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: "negotiation was cancelled before the opening dispatch claim",
        };
      }
      return null;
    }

    if (correlation.messageKind === "cancellation") {
      if (
        negotiationUpdatedAt !== correlation.sourceUpdatedAt ||
        negotiationState !== "cancelled"
      ) {
        return {
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: "cancellation state changed before the dispatch claim",
        };
      }
      return null;
    }

    if (!correlation.proposalId) {
      return {
        error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
        detail: `${correlation.messageKind} approval has no proposal source`,
      };
    }
    const proposals = await executeRawSqlTx(
      tx,
      `SELECT status, updated_at
         FROM app_lifeops.life_scheduling_proposals
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND negotiation_id = ${sqlText(correlation.negotiationId)}
          AND id = ${sqlText(correlation.proposalId)}
        LIMIT 1
        FOR UPDATE`,
    );
    const proposal = proposals[0];
    if (!proposal) {
      return {
        error: "SCHEDULING_APPROVAL_SOURCE_MISSING",
        detail: `proposal ${correlation.proposalId} no longer exists at dispatch claim`,
      };
    }
    const proposalStatus = toText(proposal.status);
    const proposalUpdatedAt = toText(proposal.updated_at);

    if (correlation.messageKind === "proposal") {
      if (proposalUpdatedAt !== correlation.sourceUpdatedAt) {
        return {
          error: "SCHEDULING_APPROVAL_STALE",
          detail: "proposal changed before its dispatch claim",
        };
      }
      if (
        proposalStatus !== "pending" ||
        negotiationState === "cancelled" ||
        negotiationState === "confirmed"
      ) {
        return {
          error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
          detail: `proposal is ${proposalStatus} while negotiation is ${negotiationState}`,
        };
      }
      return null;
    }

    if (
      negotiationUpdatedAt !== correlation.sourceUpdatedAt ||
      negotiationState !== "confirmed" ||
      acceptedProposalId !== correlation.proposalId ||
      proposalStatus !== "accepted"
    ) {
      return {
        error: "SCHEDULING_APPROVAL_MATERIAL_CHANGE",
        detail:
          "accepted proposal or finalized negotiation changed before the dispatch claim",
      };
    }
    return null;
  }

  private async invalidateTx(
    tx: TransactionalDb,
    request: ApprovalRequest,
    attempt: SchedulingDeliveryAttempt,
    failure: {
      readonly error:
        | "SCHEDULING_APPROVAL_STALE"
        | "SCHEDULING_APPROVAL_MATERIAL_CHANGE"
        | "SCHEDULING_APPROVAL_SOURCE_MISSING";
      readonly detail: string;
    },
  ): Promise<SchedulingDeliveryAttempt> {
    const now = new Date().toISOString();
    const approvals = await executeRawSqlTx(
      tx,
      `UPDATE approval_requests
          SET state = ${sqlText("expired")},
              resolved_at = ${sqlText(now)},
              resolved_by = ${sqlText("SYSTEM")},
              resolution_reason = ${sqlText(failure.detail)},
              updated_at = ${sqlText(now)}
        WHERE id = ${sqlText(request.id)}
          AND agent_id = ${sqlText(this.runtime.agentId)}
          AND state = ${sqlText("approved")}
        RETURNING id`,
    );
    if (approvals.length === 0) {
      throw deliveryInvariant(
        "SCHEDULING_DELIVERY_INVALIDATION_CONFLICT",
        `approval ${request.id} cannot be invalidated outside approved`,
        { approvalRequestId: request.id, attemptId: attempt.id },
      );
    }
    const rows = await executeRawSqlTx(
      tx,
      `UPDATE app_lifeops.life_scheduling_delivery_attempts
          SET state = ${sqlText("invalidated")},
              last_failure_json = ${sqlJson(failure)},
              completed_at = ${sqlText(now)},
              updated_at = ${sqlText(now)}
        WHERE id = ${sqlText(attempt.id)}
          AND agent_id = ${sqlText(this.runtime.agentId)}
          AND state IN (${sqlText("awaiting_approval")}, ${sqlText("failed_retryable")})
        RETURNING ${SELECT_COLUMNS}`,
    );
    if (!rows[0]) {
      throw deliveryInvariant(
        "SCHEDULING_DELIVERY_INVALIDATION_CONFLICT",
        `attempt ${attempt.id} cannot be invalidated from ${attempt.state}`,
        { attemptId: attempt.id, state: attempt.state },
      );
    }
    return rowToAttempt(rows[0]);
  }

  private async recordSuccess(
    attempt: SchedulingDeliveryAttempt,
    receipt: DispatchReceipt,
  ): Promise<SchedulingDeliveryAttempt> {
    return withRequiredTransaction(this.runtime, async (tx) => {
      const now = new Date().toISOString();
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_scheduling_delivery_attempts
            SET state = ${sqlText("succeeded")},
                provider = ${sqlText(receipt.provider)},
                provider_message_id = ${sqlText(receipt.providerMessageId)},
                receipt_json = ${sqlJson(receipt)},
                completed_at = ${sqlText(now)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("dispatching")}
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_RECEIPT_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot persist success outside dispatching`,
          { attemptId: attempt.id, state: attempt.state },
        );
      }
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("done")},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_APPROVAL_COMPLETE_CONFLICT",
          `approval ${attempt.approvalRequestId} cannot complete outside executing`,
          {
            approvalRequestId: attempt.approvalRequestId,
            attemptId: attempt.id,
          },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  private async recordNotAccepted(
    attempt: SchedulingDeliveryAttempt,
    result: Extract<DispatchResult, { ok: false }>,
  ): Promise<SchedulingDeliveryAttempt> {
    return withRequiredTransaction(this.runtime, async (tx) => {
      const now = new Date().toISOString();
      const failure = {
        reason: result.reason,
        acceptance: result.acceptance,
        userActionable: result.userActionable,
        retryAfterMinutes: result.retryAfterMinutes ?? null,
        message: result.message ?? null,
      };
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_scheduling_delivery_attempts
            SET state = ${sqlText("failed_retryable")},
                last_failure_json = ${sqlJson(failure)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("dispatching")}
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_RETRY_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot record rejection outside dispatching`,
          { attemptId: attempt.id, state: attempt.state },
        );
      }
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("approved")},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw deliveryInvariant(
          "SCHEDULING_DELIVERY_APPROVAL_RETRY_CONFLICT",
          `approval ${attempt.approvalRequestId} cannot become retryable outside executing`,
          {
            approvalRequestId: attempt.approvalRequestId,
            attemptId: attempt.id,
          },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  private async recordAmbiguous(
    attempt: SchedulingDeliveryAttempt,
    failure: Record<string, unknown>,
  ): Promise<SchedulingDeliveryAttempt> {
    const now = new Date().toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_scheduling_delivery_attempts
          SET state = ${sqlText("ambiguous")},
              last_failure_json = ${sqlJson(failure)},
              updated_at = ${sqlText(now)}
        WHERE id = ${sqlText(attempt.id)}
          AND agent_id = ${sqlText(this.runtime.agentId)}
          AND state = ${sqlText("dispatching")}
        RETURNING ${SELECT_COLUMNS}`,
    );
    if (!rows[0]) {
      throw deliveryInvariant(
        "SCHEDULING_DELIVERY_AMBIGUITY_PERSIST_CONFLICT",
        `attempt ${attempt.id} cannot record ambiguity outside dispatching`,
        { attemptId: attempt.id, state: attempt.state },
      );
    }
    return rowToAttempt(rows[0]);
  }
}
