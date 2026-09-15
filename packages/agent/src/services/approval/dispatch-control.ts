/**
 * Serializes owner dispatch admission with durable handoff pauses. Claims and
 * control mutations write the same database row, so a pause cannot race past
 * an unobserved claim. Unknown delivery outcomes prevent resuming admission.
 * Account retirement records a control-revision cutoff. Insertion captures that
 * revision under the same lock, distinguishing old approvals from fresh reviews
 * after reconnect without relying on timestamps or banning an account forever.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { executeRawSql, sqlText } from "./sql.ts";

/** SQL expressions are supplied only by the approval store and canonical claim CTE. */
export function approvalAccountAdmissionSql(
  payload: string,
  revision: string,
): string {
  const grant = `NULLIF(${payload}->>'grantId', '')`;
  const google = `(${payload}->>'action' = 'send_email' OR (
    ${payload}->>'action' IN ('schedule_event', 'modify_event', 'cancel_event')
    AND (${payload}->>'side' IS DISTINCT FROM 'agent')
    AND (${grant} IS NOT NULL OR ${payload}->>'expectedProvider' IS NULL
      OR ${payload}->>'expectedProvider' = 'google'))) `;
  return `(NOT ${google} OR CASE WHEN ${grant} IS NULL
    THEN NOT google_binding_required
    WHEN retired_google_grants ? ${grant}
    THEN COALESCE(${revision} > (retired_google_grants->>${grant})::integer, FALSE)
    ELSE TRUE END)`;
}

export interface ApprovalDispatchControl {
  revision: number;
  paused: boolean;
  /** Retained after resume to recognize an exact retry of that operation. */
  operationId: string | null;
}

export interface ApprovalDispatchControlMutation {
  subjectUserId: string;
  operationId: string;
  expectedRevision: number;
}

function validateIdentity(value: string): void {
  if (!value.trim() || value.includes("\0")) {
    throw new ElizaError("A non-empty dispatch-control identity is required", {
      code: "APPROVAL_DISPATCH_CONTROL_INVALID",
    });
  }
}

function parseControl(row: Record<string, unknown>): ApprovalDispatchControl {
  if (
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.paused !== "boolean" ||
    (row.operation_id !== null && typeof row.operation_id !== "string")
  ) {
    throw new ElizaError("Persisted dispatch control is invalid", {
      code: "APPROVAL_DISPATCH_CONTROL_CORRUPT",
    });
  }
  return {
    revision: row.revision,
    paused: row.paused,
    operationId: row.operation_id,
  };
}

/** The write lock lasts through the enclosing claim statement's commit. */
export function approvalDispatchAdmissionCte(
  agentId: string,
  subjectUserId: string,
  requestId?: string,
): string {
  validateIdentity(subjectUserId);
  return `WITH approval_admission AS (
    INSERT INTO approval_dispatch_controls (agent_id, subject_user_id)
    VALUES (${sqlText(agentId)}, ${sqlText(subjectUserId)})
    ON CONFLICT (agent_id, subject_user_id) DO UPDATE
      SET revision = approval_dispatch_controls.revision
    RETURNING paused, revision, google_binding_required, retired_google_grants
  )${
    requestId
      ? `, approval_permission AS (
    SELECT paused, ${approvalAccountAdmissionSql("request.payload", "request.admission_revision")} AS permitted
    FROM approval_admission CROSS JOIN approval_requests AS request
    WHERE request.id = ${sqlText(requestId)} AND request.agent_id = ${sqlText(agentId)}
      AND request.subject_user_id = ${sqlText(subjectUserId)}
  )`
      : ""
  }`;
}

export class ApprovalDispatchControlStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string = runtime.agentId,
  ) {}

  /** Freezes old approvals under the same row lock used by insertion and dispatch. */
  async fenceGoogleAccount(
    input: ApprovalDispatchControlMutation & { grantId: string },
  ): Promise<void> {
    this.validate(input);
    validateIdentity(input.grantId);
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_dispatch_controls
      SET google_binding_required = TRUE,
        retired_google_grants = retired_google_grants || jsonb_build_object(${sqlText(input.grantId)}, revision),
        updated_at = NOW()
      WHERE agent_id = ${sqlText(this.agentId)} AND subject_user_id = ${sqlText(input.subjectUserId)}
        AND paused AND operation_id = ${sqlText(input.operationId)} AND revision = ${input.expectedRevision}
      RETURNING revision`,
    );
    if (!rows.length) throw this.conflict(input);
  }

  async read(subjectUserId: string): Promise<ApprovalDispatchControl> {
    validateIdentity(subjectUserId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revision, paused, operation_id
      FROM approval_dispatch_controls WHERE agent_id = ${sqlText(this.agentId)}
      AND subject_user_id = ${sqlText(subjectUserId)}`,
    );
    return rows.length === 0
      ? { revision: 0, paused: false, operationId: null }
      : parseControl(rows[0]);
  }

  /** An interrupted release may complete only with its original account fence intact. */
  async requireReleasedGoogleAccountFence(
    input: ApprovalDispatchControlMutation & { grantId: string },
  ): Promise<void> {
    this.validate(input);
    validateIdentity(input.grantId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revision FROM approval_dispatch_controls
      WHERE agent_id = ${sqlText(this.agentId)} AND subject_user_id = ${sqlText(input.subjectUserId)}
        AND NOT paused AND operation_id = ${sqlText(input.operationId)}
        AND revision = ${input.expectedRevision + 1}
        AND google_binding_required
        AND (retired_google_grants->>${sqlText(input.grantId)})::integer >= ${input.expectedRevision}`,
    );
    if (!rows.length) throw this.conflict(input);
  }

  async pause(
    input: ApprovalDispatchControlMutation,
  ): Promise<ApprovalDispatchControl> {
    this.validate(input);
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO approval_dispatch_controls
      (agent_id, subject_user_id, revision, paused, operation_id)
      SELECT ${sqlText(this.agentId)}, ${sqlText(input.subjectUserId)}, 1, TRUE, ${sqlText(input.operationId)}
      WHERE ${input.expectedRevision} = 0 OR EXISTS (
        SELECT 1 FROM approval_dispatch_controls WHERE agent_id = ${sqlText(this.agentId)}
        AND subject_user_id = ${sqlText(input.subjectUserId)})
      ON CONFLICT (agent_id, subject_user_id) DO UPDATE SET
        revision = approval_dispatch_controls.revision + 1,
        paused = TRUE, operation_id = EXCLUDED.operation_id, updated_at = NOW()
      WHERE approval_dispatch_controls.revision = ${input.expectedRevision}
        AND NOT approval_dispatch_controls.paused
      RETURNING revision, paused, operation_id`,
    );
    if (rows.length) return parseControl(rows[0]);
    const current = await this.read(input.subjectUserId);
    if (
      current.paused &&
      current.operationId === input.operationId &&
      current.revision === input.expectedRevision + 1
    )
      return current;
    throw this.conflict(input);
  }

  async resume(
    input: ApprovalDispatchControlMutation,
  ): Promise<ApprovalDispatchControl> {
    this.validate(input);
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_dispatch_controls
      SET paused = FALSE, revision = revision + 1, updated_at = NOW()
      WHERE agent_id = ${sqlText(this.agentId)} AND subject_user_id = ${sqlText(input.subjectUserId)}
        AND paused AND operation_id = ${sqlText(input.operationId)} AND revision = ${input.expectedRevision}
        AND NOT EXISTS (SELECT 1 FROM approval_requests WHERE agent_id = ${sqlText(this.agentId)}
          AND subject_user_id = ${sqlText(input.subjectUserId)} AND state IN ('executing', 'reconciliation_required'))
      RETURNING revision, paused, operation_id`,
    );
    if (rows.length) return parseControl(rows[0]);
    const current = await this.read(input.subjectUserId);
    if (
      !current.paused &&
      current.operationId === input.operationId &&
      current.revision === input.expectedRevision + 1
    )
      return current;
    if (
      current.paused &&
      current.operationId === input.operationId &&
      current.revision === input.expectedRevision
    ) {
      const requests = await executeRawSql(
        this.runtime,
        `SELECT id, state FROM approval_requests
        WHERE agent_id = ${sqlText(this.agentId)} AND subject_user_id = ${sqlText(input.subjectUserId)}
        AND state IN ('executing', 'reconciliation_required') ORDER BY created_at, id`,
      );
      if (requests.length) {
        throw new ElizaError(
          "Wait for active deliveries and reconcile uncertain outcomes before resuming",
          {
            code: "APPROVAL_DISPATCH_DRAIN_REQUIRED",
            context: { subjectUserId: input.subjectUserId, requests },
          },
        );
      }
    }
    throw this.conflict(input);
  }

  private validate(input: ApprovalDispatchControlMutation): void {
    validateIdentity(input.subjectUserId);
    validateIdentity(input.operationId);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.expectedRevision >= 2_147_483_647
    ) {
      throw new ElizaError("Refresh the dispatch control before changing it", {
        code: "APPROVAL_DISPATCH_CONTROL_INVALID",
      });
    }
  }

  private conflict(input: ApprovalDispatchControlMutation): ElizaError {
    return new ElizaError(
      "Dispatch control changed; refresh the handoff review before continuing",
      {
        code: "APPROVAL_DISPATCH_CONTROL_CONFLICT",
        context: {
          subjectUserId: input.subjectUserId,
          expectedRevision: input.expectedRevision,
        },
      },
    );
  }
}
