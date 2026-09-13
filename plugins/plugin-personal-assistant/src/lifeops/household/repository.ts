/**
 * PostgreSQL persistence for household access grants and versioned schedule
 * agreements. Identity stays in EntityStore/RelationshipStore, approvals stay
 * in the shared approval queue, and this repository atomically advances only
 * the household coordination state that neither subsystem owns.
 */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import type { LifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import { withActiveFamilyWorkspaceTransaction } from "../family-workflows/workspace-operation-store.js";
import {
  asObject,
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toNumber,
  toText,
  withTransaction,
} from "../sql.js";
import {
  HOUSEHOLD_AUDIT_KINDS,
  type HouseholdAccessGrant,
  type HouseholdAccessScope,
  type HouseholdAuditKind,
  type HouseholdAuditRecord,
  HouseholdCoordinationError,
  type HouseholdCoordinationHead,
  type HouseholdProposalApproval,
  type HouseholdRole,
  type HouseholdScheduleAgreement,
  type HouseholdScheduleProposal,
  type HouseholdScheduleTerms,
  type InvalidatedProposalApproval,
  isHouseholdAccessScope,
  isHouseholdAuditKind,
  isHouseholdProposalStatus,
  isHouseholdRole,
  normalizeScheduleTerms,
} from "./types.js";

const HOUSEHOLD_GRANT_EXPIRY_WARNING_CONVERGENCE = [
  `ALTER TABLE app_lifeops.life_household_grant_expiry_warning_claims
     ADD COLUMN IF NOT EXISTS cancellation_completed_at TEXT`,
  `ALTER TABLE app_lifeops.life_household_grant_expiry_warning_claims
     ADD COLUMN IF NOT EXISTS cancellation_attempt_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE app_lifeops.life_household_grant_expiry_warning_claims
     ADD COLUMN IF NOT EXISTS cancellation_last_error TEXT`,
] as const;

type AuditWrite = Omit<HouseholdAuditRecord, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export interface PersistedHouseholdGrantExpiryWarning {
  grantId: string;
  scheduledTaskId: string;
  warningAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  cancellationCompletedAt: string | null;
  cancellationAttemptCount: number;
  cancellationLastError: string | null;
}

export type PersistedHouseholdGrantExpiryWarningIntent =
  | {
      state: "pending";
      grantId: string;
      scheduledTaskId: null;
      warningAt: null;
      expiresAt: null;
      cancelledAt: string | null;
      cancellationCompletedAt: string | null;
      cancellationAttemptCount: number;
      cancellationLastError: string | null;
    }
  | ({ state: "scheduled" } & PersistedHouseholdGrantExpiryWarning);

function requiredText(value: unknown, field: string): string {
  const text = toText(value).trim();
  if (!text) {
    throw new HouseholdCoordinationError(
      `Persisted household row is missing ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = toNumber(value, Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HouseholdCoordinationError(
      `Persisted household row has invalid ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value: toText(value) },
    );
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  throw new HouseholdCoordinationError(
    `Persisted household row has invalid ${field}`,
    "HOUSEHOLD_INVALID_CONTRACT",
    { field, value: toText(value) },
  );
}

function stringArray(value: unknown, field: string): string[] {
  const parsed = parseJsonArray<unknown>(value);
  if (parsed.some((entry) => typeof entry !== "string")) {
    throw new HouseholdCoordinationError(
      `Persisted household row has invalid ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function roleValue(value: unknown): HouseholdRole {
  const text = requiredText(value, "role");
  if (!isHouseholdRole(text)) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household role: ${text}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { role: text },
    );
  }
  return text;
}

function scopeArray(value: unknown): HouseholdAccessScope[] {
  const values = stringArray(value, "scopes");
  const invalid = values.filter((scope) => !isHouseholdAccessScope(scope));
  if (invalid.length > 0) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household scopes: ${invalid.join(", ")}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { invalid },
    );
  }
  return values.filter(isHouseholdAccessScope);
}

function termsValue(value: unknown): HouseholdScheduleTerms {
  const row = parseJsonRecord(value);
  const children = row.childEntityIds;
  if (
    !Array.isArray(children) ||
    children.some((entry) => typeof entry !== "string")
  ) {
    throw new HouseholdCoordinationError(
      "Persisted schedule terms have invalid childEntityIds",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  const custody = row.custodyException;
  const custodyRecord = custody === null ? null : asObject(custody);
  if (custody !== null && !custodyRecord) {
    throw new HouseholdCoordinationError(
      "Persisted schedule terms have invalid custodyException",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  return normalizeScheduleTerms({
    summary: requiredText(row.summary, "terms.summary"),
    startAt: requiredText(row.startAt, "terms.startAt"),
    endAt: requiredText(row.endAt, "terms.endAt"),
    timezone: requiredText(row.timezone, "terms.timezone"),
    childEntityIds: children,
    location: optionalText(row.location),
    notes: optionalText(row.notes),
    custodyException: custodyRecord
      ? {
          childEntityId: requiredText(
            custodyRecord.childEntityId,
            "custody.childEntityId",
          ),
          fromAt: requiredText(custodyRecord.fromAt, "custody.fromAt"),
          toAt: requiredText(custodyRecord.toAt, "custody.toAt"),
          normalCustodianEntityId: requiredText(
            custodyRecord.normalCustodianEntityId,
            "custody.normalCustodianEntityId",
          ),
          substituteCustodianEntityId: requiredText(
            custodyRecord.substituteCustodianEntityId,
            "custody.substituteCustodianEntityId",
          ),
          authorityBaselineRelationshipId: requiredText(
            custodyRecord.authorityBaselineRelationshipId,
            "custody.authorityBaselineRelationshipId",
          ),
          authorityBaselineRevisionSha256: optionalText(
            custodyRecord.authorityBaselineRevisionSha256,
          ),
          reason: requiredText(custodyRecord.reason, "custody.reason"),
        }
      : null,
  });
}

function grantFromRow(row: Record<string, unknown>): HouseholdAccessGrant {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    principalEntityId: requiredText(
      row.principal_entity_id,
      "principalEntityId",
    ),
    relationshipId: optionalText(row.relationship_id),
    role: roleValue(row.role),
    subjectEntityIds: stringArray(
      row.subject_entity_ids_json,
      "subjectEntityIds",
    ),
    scopes: scopeArray(row.scopes_json),
    issuedByEntityId: requiredText(row.issued_by_entity_id, "issuedByEntityId"),
    expiresAt: optionalText(row.expires_at),
    revokedAt: optionalText(row.revoked_at),
    revokedByEntityId: optionalText(row.revoked_by_entity_id),
    revocationReason: optionalText(row.revocation_reason),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function proposalFromRow(
  row: Record<string, unknown>,
): HouseholdScheduleProposal {
  const status = requiredText(row.status, "status");
  if (!isHouseholdProposalStatus(status)) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household proposal status: ${status}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { status },
    );
  }
  return {
    proposalId: requiredText(row.proposal_id, "proposalId"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    version: requiredInteger(row.version, "version"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    baseAgreementVersion: requiredInteger(
      row.base_agreement_version,
      "baseAgreementVersion",
    ),
    terms: termsValue(row.terms_json),
    affectedPartyEntityIds: stringArray(
      row.affected_party_entity_ids_json,
      "affectedPartyEntityIds",
    ),
    requiredApproverEntityIds: stringArray(
      row.required_approver_entity_ids_json,
      "requiredApproverEntityIds",
    ),
    createdByEntityId: requiredText(
      row.created_by_entity_id,
      "createdByEntityId",
    ),
    contentSha256: requiredText(row.content_sha256, "contentSha256"),
    status,
    materialChange: requiredBoolean(row.material_change, "materialChange"),
    expiresAt: optionalText(row.expires_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

/**
 * Reads an invalidation result row. Every statement that invalidates approval
 * links returns the party alongside the request id so the caller can address
 * the subject-scoped approval queue without re-deriving the subject.
 */
function invalidatedApprovalFromRow(
  row: Record<string, unknown>,
): InvalidatedProposalApproval {
  return {
    requestId: requiredText(row.approval_request_id, "approvalRequestId"),
    partyEntityId: requiredText(row.party_entity_id, "partyEntityId"),
  };
}

function approvalFromRow(
  row: Record<string, unknown>,
): HouseholdProposalApproval {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    proposalId: requiredText(row.proposal_id, "proposalId"),
    proposalVersion: requiredInteger(row.proposal_version, "proposalVersion"),
    partyEntityId: requiredText(row.party_entity_id, "partyEntityId"),
    approvalRequestId: requiredText(
      row.approval_request_id,
      "approvalRequestId",
    ),
    invalidatedAt: optionalText(row.invalidated_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function headFromRow(row: Record<string, unknown>): HouseholdCoordinationHead {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    currentAgreementVersion: requiredInteger(
      row.current_agreement_version,
      "currentAgreementVersion",
    ),
    currentAgreementId: optionalText(row.current_agreement_id),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function agreementFromRow(
  row: Record<string, unknown>,
  currentAgreementId: string | null,
): HouseholdScheduleAgreement {
  const id = requiredText(row.id, "id");
  return {
    id,
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    version: requiredInteger(row.version, "version"),
    proposalId: requiredText(row.proposal_id, "proposalId"),
    proposalVersion: requiredInteger(row.proposal_version, "proposalVersion"),
    terms: termsValue(row.terms_json),
    affectedPartyEntityIds: stringArray(
      row.affected_party_entity_ids_json,
      "affectedPartyEntityIds",
    ),
    approvedByEntityIds: stringArray(
      row.approved_by_entity_ids_json,
      "approvedByEntityIds",
    ),
    activatedAt: requiredText(row.activated_at, "activatedAt"),
    createdAt: requiredText(row.created_at, "createdAt"),
    isCurrent: id === currentAgreementId,
  };
}

function ownerTypeFor(kind: HouseholdAuditKind): string {
  if (kind === "household_role_bound") return "household_role";
  if (
    kind === "household_custody_authority_set" ||
    kind === "household_custody_authority_revoked"
  ) {
    return "household_custody_authority";
  }
  if (kind === "household_grant_issued" || kind === "household_grant_revoked") {
    return "household_grant";
  }
  if (
    kind === "household_proposal_created" ||
    kind === "household_proposal_revised" ||
    kind === "household_proposal_approved" ||
    kind === "household_proposal_invalidated"
  ) {
    return "household_proposal";
  }
  if (kind === "household_agreement_activated") {
    return "household_agreement";
  }
  return "household_export";
}

async function insertAudit(
  target: IAgentRuntime | TransactionalDb,
  agentId: string,
  event: AuditWrite,
): Promise<void> {
  const id = event.id ?? `haudit_${crypto.randomUUID()}`;
  const createdAt = event.createdAt ?? new Date().toISOString();
  const query = `INSERT INTO app_lifeops.life_audit_events (
      id, agent_id, event_type, owner_type, owner_id, reason,
      inputs_json, decision_json, actor, created_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(agentId)},
      ${sqlQuote(event.kind)},
      ${sqlQuote(ownerTypeFor(event.kind))},
      ${sqlQuote(event.ownerId)},
      ${sqlQuote(event.reason)},
      ${sqlJson(event.inputs)},
      ${sqlJson(event.decision)},
      ${sqlQuote(event.actor)},
      ${sqlQuote(createdAt)}
    )`;
  if ("adapter" in target) {
    await executeRawSql(target, query);
    return;
  }
  await executeRawSqlTx(target, query);
}

export class HouseholdCoordinationRepository {
  private grantExpiryWarningSchemaReady: Promise<void> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  private async ensureGrantExpiryWarningSchema(): Promise<void> {
    if (!this.grantExpiryWarningSchemaReady) {
      this.grantExpiryWarningSchemaReady = (async () => {
        // The plugin migration system owns table creation. These additive
        // statements only converge installations created before cancellation
        // completion became a durable outbox state.
        for (const statement of HOUSEHOLD_GRANT_EXPIRY_WARNING_CONVERGENCE) {
          await executeRawSql(this.runtime, statement);
        }
      })();
    }
    await this.grantExpiryWarningSchemaReady;
  }

  private executeWarningMutation(statement: string) {
    return withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_access_grants",
        "app_lifeops.life_household_grant_expiry_warning_claims",
      ],
      (tx) => executeRawSqlTx(tx, statement),
      this.agentId,
    );
  }

  async appendAudit(event: AuditWrite): Promise<void> {
    await insertAudit(this.runtime, this.agentId, event);
  }

  async insertGrant(
    grant: HouseholdAccessGrant,
    audit: AuditWrite,
  ): Promise<void> {
    await this.ensureGrantExpiryWarningSchema();
    await withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_access_grants",
        "app_lifeops.life_household_grant_expiry_warning_claims",
      ],
      async (tx) => {
        await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_household_access_grants (
          id, agent_id, household_id, principal_entity_id, relationship_id, role,
          subject_entity_ids_json, scopes_json, issued_by_entity_id,
          expires_at, revoked_at, revoked_by_entity_id, revocation_reason,
          created_at, updated_at
        ) VALUES (
          ${sqlQuote(grant.id)},
          ${sqlQuote(this.agentId)},
          ${sqlQuote(grant.householdId)},
          ${sqlQuote(grant.principalEntityId)},
          ${sqlText(grant.relationshipId)},
          ${sqlQuote(grant.role)},
          ${sqlJson(grant.subjectEntityIds)},
          ${sqlJson(grant.scopes)},
          ${sqlQuote(grant.issuedByEntityId)},
          ${sqlText(grant.expiresAt)},
          NULL,
          NULL,
          NULL,
          ${sqlQuote(grant.createdAt)},
          ${sqlQuote(grant.updatedAt)}
        )`,
        );
        if (grant.expiresAt) {
          await executeRawSqlTx(
            tx,
            `INSERT INTO app_lifeops.life_household_grant_expiry_warning_claims (
             agent_id, grant_id, attempt_token, lease_expires_at,
             scheduled_task_id, warning_at, expires_at, cancelled_at, updated_at
           ) VALUES (
             ${sqlQuote(this.agentId)}, ${sqlQuote(grant.id)},
             ${sqlQuote(`pending:${grant.id}`)}, ${sqlQuote(grant.createdAt)},
             NULL, NULL, NULL, NULL, ${sqlQuote(grant.createdAt)}
           )`,
          );
        }
        await insertAudit(tx, this.agentId, audit);
      },
      this.agentId,
    );
  }

  async getGrant(id: string): Promise<HouseholdAccessGrant | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_access_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    return rows[0] ? grantFromRow(rows[0]) : null;
  }

  async listGrants(
    principalEntityId?: string,
    householdId?: string,
  ): Promise<HouseholdAccessGrant[]> {
    const principalClause = principalEntityId
      ? `AND principal_entity_id = ${sqlQuote(principalEntityId)}`
      : "";
    const householdClause = householdId
      ? `AND household_id = ${sqlQuote(householdId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_access_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          ${principalClause}
          ${householdClause}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async revokeGrant(input: {
    id: string;
    revokedAt: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdAccessGrant> {
    await this.ensureGrantExpiryWarningSchema();
    return await withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_access_grants",
        "app_lifeops.life_household_grant_expiry_warning_claims",
      ],
      async (tx) => {
        const rows = await executeRawSqlTx(
          tx,
          `UPDATE app_lifeops.life_household_access_grants
            SET revoked_at = ${sqlQuote(input.revokedAt)},
                revoked_by_entity_id = ${sqlQuote(input.revokedByEntityId)},
                revocation_reason = ${sqlQuote(input.reason)},
                updated_at = ${sqlQuote(input.revokedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND id = ${sqlQuote(input.id)}
            AND revoked_at IS NULL
        RETURNING *`,
        );
        const row = rows[0];
        if (!row) {
          throw new HouseholdCoordinationError(
            `Grant ${input.id} is missing or already revoked`,
            "HOUSEHOLD_GRANT_REVOKED",
            { grantId: input.id },
          );
        }
        const grant = grantFromRow(row);
        await insertAudit(tx, this.agentId, {
          kind: "household_grant_revoked",
          ownerId: grant.id,
          reason: input.reason,
          inputs: {
            householdId: grant.householdId,
            principalEntityId: grant.principalEntityId,
            scopes: grant.scopes,
          },
          decision: {
            revokedAt: grant.revokedAt,
            revokedByEntityId: grant.revokedByEntityId,
          },
          actor: "user",
          createdAt: input.revokedAt,
        });
        await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_household_grant_expiry_warning_claims (
           agent_id, grant_id, attempt_token, lease_expires_at,
           scheduled_task_id, warning_at, expires_at, cancelled_at,
           cancellation_completed_at, cancellation_attempt_count,
           cancellation_last_error, updated_at
         ) VALUES (
           ${sqlQuote(this.agentId)}, ${sqlQuote(grant.id)},
           ${sqlQuote(`revocation:${grant.id}`)}, ${sqlQuote(input.revokedAt)},
           NULL, NULL, NULL, ${sqlQuote(input.revokedAt)},
           NULL, 0, NULL, ${sqlQuote(input.revokedAt)}
         )
         ON CONFLICT (agent_id, grant_id) DO UPDATE
           SET cancelled_at = COALESCE(
                 app_lifeops.life_household_grant_expiry_warning_claims.cancelled_at,
                 EXCLUDED.cancelled_at
               ),
               updated_at = EXCLUDED.updated_at`,
        );
        return grant;
      },
      this.agentId,
    );
  }

  async getGrantExpiryWarningTaskId(grantId: string): Promise<string | null> {
    return (await this.getGrantExpiryWarning(grantId))?.scheduledTaskId ?? null;
  }

  async getGrantExpiryWarning(
    grantId: string,
  ): Promise<PersistedHouseholdGrantExpiryWarning | null> {
    const intent = await this.getGrantExpiryWarningIntent(grantId);
    return intent?.state === "scheduled" ? intent : null;
  }

  async getGrantExpiryWarningIntent(
    grantId: string,
  ): Promise<PersistedHouseholdGrantExpiryWarningIntent | null> {
    await this.ensureGrantExpiryWarningSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT grant_id, scheduled_task_id, warning_at, expires_at, cancelled_at,
              cancellation_completed_at, cancellation_attempt_count,
              cancellation_last_error
         FROM app_lifeops.life_household_grant_expiry_warning_claims
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(grantId)}
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const scheduledTaskId = optionalText(row.scheduled_task_id);
    if (!scheduledTaskId) {
      if (row.warning_at !== null || row.expires_at !== null) {
        throw new HouseholdCoordinationError(
          "Pending household grant warning has partial scheduled identity",
          "HOUSEHOLD_INVALID_CONTRACT",
          { grantId },
        );
      }
      return {
        state: "pending",
        grantId: requiredText(row.grant_id, "grantId"),
        scheduledTaskId: null,
        warningAt: null,
        expiresAt: null,
        cancelledAt: optionalText(row.cancelled_at),
        cancellationCompletedAt: optionalText(row.cancellation_completed_at),
        cancellationAttemptCount: requiredInteger(
          row.cancellation_attempt_count,
          "cancellationAttemptCount",
        ),
        cancellationLastError: optionalText(row.cancellation_last_error),
      };
    }
    return {
      state: "scheduled",
      grantId: requiredText(row.grant_id, "grantId"),
      scheduledTaskId,
      warningAt: requiredText(row.warning_at, "warningAt"),
      expiresAt: requiredText(row.expires_at, "expiresAt"),
      cancelledAt: optionalText(row.cancelled_at),
      cancellationCompletedAt: optionalText(row.cancellation_completed_at),
      cancellationAttemptCount: requiredInteger(
        row.cancellation_attempt_count,
        "cancellationAttemptCount",
      ),
      cancellationLastError: optionalText(row.cancellation_last_error),
    };
  }

  async claimGrantExpiryWarning(input: {
    grantId: string;
    attemptToken: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<
    | { kind: "claimed" }
    | { kind: "busy"; leaseExpiresAt: string }
    | { kind: "complete"; scheduledTaskId: string }
  > {
    await this.ensureGrantExpiryWarningSchema();
    const completed = await this.getGrantExpiryWarningTaskId(input.grantId);
    if (completed) return { kind: "complete", scheduledTaskId: completed };
    const inserted = await this.executeWarningMutation(
      `INSERT INTO app_lifeops.life_household_grant_expiry_warning_claims (
         agent_id, grant_id, attempt_token, lease_expires_at, scheduled_task_id,
         warning_at, expires_at, cancelled_at, updated_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(input.grantId)},
         ${sqlQuote(input.attemptToken)}, ${sqlQuote(input.leaseExpiresAt)},
         NULL, NULL, NULL, NULL, ${sqlQuote(input.now)}
       )
       ON CONFLICT DO NOTHING
       RETURNING attempt_token`,
    );
    if (inserted[0]) return { kind: "claimed" };
    const reclaimed = await this.executeWarningMutation(
      `UPDATE app_lifeops.life_household_grant_expiry_warning_claims
          SET attempt_token = ${sqlQuote(input.attemptToken)},
              lease_expires_at = ${sqlQuote(input.leaseExpiresAt)},
              updated_at = ${sqlQuote(input.now)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
          AND scheduled_task_id IS NULL
          AND lease_expires_at <= ${sqlQuote(input.now)}
      RETURNING attempt_token`,
    );
    if (reclaimed[0]) return { kind: "claimed" };
    const rows = await this.executeWarningMutation(
      `SELECT lease_expires_at
         FROM app_lifeops.life_household_grant_expiry_warning_claims
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
        LIMIT 1`,
    );
    const busy = rows[0];
    if (!busy) {
      throw new HouseholdCoordinationError(
        "Household grant warning claim disappeared during contention",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grantId },
      );
    }
    return {
      kind: "busy",
      leaseExpiresAt: requiredText(busy.lease_expires_at, "leaseExpiresAt"),
    };
  }

  async completeGrantExpiryWarningClaim(input: {
    grantId: string;
    attemptToken: string;
    scheduledTaskId: string;
    warningAt: string;
    expiresAt: string;
    completedAt: string;
  }): Promise<
    { kind: "linked"; scheduledTaskId: string } | { kind: "cancelled" }
  > {
    await this.ensureGrantExpiryWarningSchema();
    const rows = await this.executeWarningMutation(
      `UPDATE app_lifeops.life_household_grant_expiry_warning_claims
          SET scheduled_task_id = ${sqlQuote(input.scheduledTaskId)},
              warning_at = ${sqlQuote(input.warningAt)},
              expires_at = ${sqlQuote(input.expiresAt)},
              updated_at = ${sqlQuote(input.completedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
          AND attempt_token = ${sqlQuote(input.attemptToken)}
          AND scheduled_task_id IS NULL
          AND cancelled_at IS NULL
      RETURNING scheduled_task_id`,
    );
    if (rows[0]) {
      return {
        kind: "linked",
        scheduledTaskId: requiredText(
          rows[0].scheduled_task_id,
          "scheduledTaskId",
        ),
      };
    }
    const existing = await this.getGrantExpiryWarningIntent(input.grantId);
    if (existing?.state === "scheduled") {
      if (existing.scheduledTaskId === input.scheduledTaskId) {
        return {
          kind: "linked",
          scheduledTaskId: existing.scheduledTaskId,
        };
      }
      throw new HouseholdCoordinationError(
        "Household grant expiry warning claim resolved to a different task",
        "HOUSEHOLD_INVALID_CONTRACT",
        {
          grantId: input.grantId,
          scheduledTaskId: input.scheduledTaskId,
          existingTaskId: existing.scheduledTaskId,
        },
      );
    }
    if (existing?.cancelledAt) return { kind: "cancelled" };
    throw new HouseholdCoordinationError(
      "Household grant expiry warning claim was lost before completion",
      "HOUSEHOLD_INVALID_CONTRACT",
      {
        grantId: input.grantId,
        scheduledTaskId: input.scheduledTaskId,
      },
    );
  }

  async releaseGrantExpiryWarningClaim(input: {
    grantId: string;
    attemptToken: string;
    releasedAt: string;
  }): Promise<void> {
    await this.ensureGrantExpiryWarningSchema();
    await this.executeWarningMutation(
      `UPDATE app_lifeops.life_household_grant_expiry_warning_claims
          SET lease_expires_at = ${sqlQuote(input.releasedAt)},
              updated_at = ${sqlQuote(input.releasedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
          AND attempt_token = ${sqlQuote(input.attemptToken)}
          AND scheduled_task_id IS NULL`,
    );
  }

  async markGrantExpiryWarningCancelled(
    grantId: string,
    cancelledAt: string,
  ): Promise<string | null> {
    await this.ensureGrantExpiryWarningSchema();
    const rows = await this.executeWarningMutation(
      `INSERT INTO app_lifeops.life_household_grant_expiry_warning_claims (
         agent_id, grant_id, attempt_token, lease_expires_at, scheduled_task_id,
         warning_at, expires_at, cancelled_at, cancellation_completed_at,
         cancellation_attempt_count, cancellation_last_error, updated_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(grantId)},
         ${sqlQuote(`cancellation:${grantId}`)}, ${sqlQuote(cancelledAt)},
         NULL, NULL, NULL, ${sqlQuote(cancelledAt)}, NULL, 0, NULL,
         ${sqlQuote(cancelledAt)}
       )
       ON CONFLICT (agent_id, grant_id) DO UPDATE
         SET cancelled_at = COALESCE(
               app_lifeops.life_household_grant_expiry_warning_claims.cancelled_at,
               EXCLUDED.cancelled_at
             ),
             updated_at = EXCLUDED.updated_at
       RETURNING scheduled_task_id`,
    );
    return rows[0] ? optionalText(rows[0].scheduled_task_id) : null;
  }

  async completeGrantExpiryWarningCancellation(input: {
    grantId: string;
    completedAt: string;
  }): Promise<void> {
    await this.ensureGrantExpiryWarningSchema();
    const rows = await this.executeWarningMutation(
      `UPDATE app_lifeops.life_household_grant_expiry_warning_claims
          SET cancellation_completed_at = ${sqlQuote(input.completedAt)},
              cancellation_last_error = NULL,
              updated_at = ${sqlQuote(input.completedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
          AND cancelled_at IS NOT NULL
      RETURNING grant_id`,
    );
    if (!rows[0]) {
      throw new HouseholdCoordinationError(
        "Household grant warning cancellation intent is missing",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grantId },
      );
    }
  }

  async recordGrantExpiryWarningCancellationFailure(input: {
    grantId: string;
    failedAt: string;
    error: string;
  }): Promise<void> {
    await this.ensureGrantExpiryWarningSchema();
    const rows = await this.executeWarningMutation(
      `UPDATE app_lifeops.life_household_grant_expiry_warning_claims
          SET cancellation_attempt_count = cancellation_attempt_count + 1,
              cancellation_last_error = ${sqlQuote(truncateWellFormed(toWellFormedUnicode(input.error), 512))},
              updated_at = ${sqlQuote(input.failedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND grant_id = ${sqlQuote(input.grantId)}
          AND cancelled_at IS NOT NULL
      RETURNING grant_id`,
    );
    if (!rows[0]) {
      throw new HouseholdCoordinationError(
        "Household grant warning cancellation failure has no durable intent",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grantId },
      );
    }
  }

  async ensureHead(
    householdId: string,
    coordinationId: string,
    now: string,
  ): Promise<HouseholdCoordinationHead> {
    const id = `hcoord_${crypto
      .createHash("sha256")
      .update(`${this.agentId}\0${householdId}\0${coordinationId}`)
      .digest("hex")
      .slice(0, 24)}`;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_coordination_heads (
        id, agent_id, household_id, coordination_id, current_agreement_version,
        current_agreement_id, created_at, updated_at
      ) VALUES (
        ${sqlQuote(id)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(householdId)},
        ${sqlQuote(coordinationId)},
        0,
        NULL,
        ${sqlQuote(now)},
        ${sqlQuote(now)}
      )
      ON CONFLICT(agent_id, household_id, coordination_id) DO NOTHING`,
    );
    const head = await this.getHead(householdId, coordinationId);
    if (!head) {
      throw new HouseholdCoordinationError(
        `Failed to create coordination head ${coordinationId}`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        { coordinationId },
      );
    }
    return head;
  }

  async getHead(
    householdId: string,
    coordinationId: string,
  ): Promise<HouseholdCoordinationHead | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_coordination_heads
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND household_id = ${sqlQuote(householdId)}
          AND coordination_id = ${sqlQuote(coordinationId)}
        LIMIT 1`,
    );
    return rows[0] ? headFromRow(rows[0]) : null;
  }

  async insertProposal(
    proposal: HouseholdScheduleProposal,
    audit: AuditWrite,
  ): Promise<void> {
    await withTransaction(this.runtime, async (tx) => {
      const headRows = await executeRawSqlTx(
        tx,
        `SELECT *
          FROM app_lifeops.life_household_coordination_heads
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(proposal.householdId)}
            AND coordination_id = ${sqlQuote(proposal.coordinationId)}
          FOR UPDATE`,
      );
      const head = headRows[0] ? headFromRow(headRows[0]) : null;
      if (
        !head ||
        head.currentAgreementVersion !== proposal.baseAgreementVersion
      ) {
        throw new HouseholdCoordinationError(
          `Proposal base agreement ${proposal.baseAgreementVersion} is stale`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            coordinationId: proposal.coordinationId,
            baseAgreementVersion: proposal.baseAgreementVersion,
            currentAgreementVersion: head?.currentAgreementVersion,
          },
        );
      }
      await this.insertProposalTx(tx, proposal);
      await insertAudit(tx, this.agentId, audit);
    });
  }

  private async insertProposalTx(
    tx: TransactionalDb,
    proposal: HouseholdScheduleProposal,
  ): Promise<void> {
    const rowId = `hproposalrow_${crypto
      .createHash("sha256")
      .update(
        `${this.agentId}\0${proposal.householdId}\0${proposal.proposalId}\0${proposal.version}`,
      )
      .digest("hex")}`;
    await executeRawSqlTx(
      tx,
      `INSERT INTO app_lifeops.life_household_schedule_proposals (
        row_id, agent_id, household_id, proposal_id, version, coordination_id,
        base_agreement_version, terms_json, affected_party_entity_ids_json,
        required_approver_entity_ids_json, created_by_entity_id,
        content_sha256, status, material_change, expires_at, created_at,
        updated_at
      ) VALUES (
        ${sqlQuote(rowId)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(proposal.householdId)},
        ${sqlQuote(proposal.proposalId)},
        ${sqlInteger(proposal.version)},
        ${sqlQuote(proposal.coordinationId)},
        ${sqlInteger(proposal.baseAgreementVersion)},
        ${sqlJson(proposal.terms)},
        ${sqlJson(proposal.affectedPartyEntityIds)},
        ${sqlJson(proposal.requiredApproverEntityIds)},
        ${sqlQuote(proposal.createdByEntityId)},
        ${sqlQuote(proposal.contentSha256)},
        ${sqlQuote(proposal.status)},
        ${sqlBoolean(proposal.materialChange)},
        ${sqlText(proposal.expiresAt)},
        ${sqlQuote(proposal.createdAt)},
        ${sqlQuote(proposal.updatedAt)}
      )`,
    );
  }

  async reviseProposal(
    previous: HouseholdScheduleProposal,
    next: HouseholdScheduleProposal,
  ): Promise<InvalidatedProposalApproval[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const headRows = await executeRawSqlTx(
        tx,
        `SELECT *
          FROM app_lifeops.life_household_coordination_heads
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(previous.householdId)}
            AND coordination_id = ${sqlQuote(previous.coordinationId)}
          FOR UPDATE`,
      );
      const head = headRows[0] ? headFromRow(headRows[0]) : null;
      if (
        !head ||
        head.currentAgreementVersion !== previous.baseAgreementVersion
      ) {
        throw new HouseholdCoordinationError(
          `Proposal ${previous.proposalId} is based on a stale agreement`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            proposalId: previous.proposalId,
            proposalVersion: previous.version,
          },
        );
      }
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'superseded',
                updated_at = ${sqlQuote(next.updatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(previous.householdId)}
            AND proposal_id = ${sqlQuote(previous.proposalId)}
            AND version = ${sqlInteger(previous.version)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (changed.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${previous.proposalId} v${previous.version} changed concurrently`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: previous.proposalId,
            proposalVersion: previous.version,
          },
        );
      }
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = ${sqlQuote(next.updatedAt)},
                updated_at = ${sqlQuote(next.updatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(previous.proposalId)}
            AND proposal_version = ${sqlInteger(previous.version)}
            AND invalidated_at IS NULL
        RETURNING approval_request_id, party_entity_id`,
      );
      await this.insertProposalTx(tx, next);
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_invalidated",
        ownerId: previous.proposalId,
        reason: "A newer proposal version replaced the approved bytes.",
        inputs: {
          householdId: previous.householdId,
          proposalVersion: previous.version,
          materialChange: next.materialChange,
        },
        decision: {
          invalidatedAt: next.updatedAt,
          replacementVersion: next.version,
        },
        actor: "user",
        createdAt: next.updatedAt,
      });
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_revised",
        ownerId: next.proposalId,
        reason: "Household schedule proposal revised.",
        inputs: {
          householdId: next.householdId,
          previousVersion: previous.version,
          materialChange: next.materialChange,
          affectedPartyEntityIds: next.affectedPartyEntityIds,
        },
        decision: {
          proposalVersion: next.version,
          baseAgreementVersion: next.baseAgreementVersion,
          contentSha256: next.contentSha256,
        },
        actor: "user",
        createdAt: next.updatedAt,
      });
      return invalidatedApprovals.map(invalidatedApprovalFromRow);
    });
  }

  async getProposal(
    proposalId: string,
    version?: number,
    householdId?: string,
  ): Promise<HouseholdScheduleProposal | null> {
    const versionClause =
      version === undefined ? "" : `AND version = ${sqlInteger(version)}`;
    const householdClause = householdId
      ? `AND household_id = ${sqlQuote(householdId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_schedule_proposals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND proposal_id = ${sqlQuote(proposalId)}
          ${versionClause}
          ${householdClause}
        ORDER BY version DESC
        LIMIT 1`,
    );
    return rows[0] ? proposalFromRow(rows[0]) : null;
  }

  async listProposals(
    householdId?: string,
  ): Promise<HouseholdScheduleProposal[]> {
    const householdClause = householdId
      ? `AND household_id = ${sqlQuote(householdId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_schedule_proposals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          ${householdClause}
        ORDER BY created_at ASC, proposal_id ASC, version ASC`,
    );
    return rows.map(proposalFromRow);
  }

  async insertApprovalLink(
    approval: HouseholdProposalApproval,
  ): Promise<HouseholdProposalApproval> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_proposal_approvals (
        id, agent_id, proposal_id, proposal_version, party_entity_id,
        approval_request_id, invalidated_at, created_at, updated_at
      ) VALUES (
        ${sqlQuote(approval.id)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(approval.proposalId)},
        ${sqlInteger(approval.proposalVersion)},
        ${sqlQuote(approval.partyEntityId)},
        ${sqlQuote(approval.approvalRequestId)},
        ${sqlText(approval.invalidatedAt)},
        ${sqlQuote(approval.createdAt)},
        ${sqlQuote(approval.updatedAt)}
      )
      ON CONFLICT(agent_id, proposal_id, proposal_version, party_entity_id)
      DO NOTHING
      RETURNING *`,
    );
    if (rows[0]) return approvalFromRow(rows[0]);
    const existing = (
      await this.listApprovalLinks(
        approval.proposalId,
        approval.proposalVersion,
      )
    ).find((candidate) => candidate.partyEntityId === approval.partyEntityId);
    if (!existing) {
      throw new HouseholdCoordinationError(
        "Approval link conflict did not resolve to a persisted row",
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: approval.proposalId,
          proposalVersion: approval.proposalVersion,
          partyEntityId: approval.partyEntityId,
        },
      );
    }
    return existing;
  }

  async listApprovalLinks(
    proposalId: string,
    proposalVersion: number,
  ): Promise<HouseholdProposalApproval[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND proposal_id = ${sqlQuote(proposalId)}
          AND proposal_version = ${sqlInteger(proposalVersion)}
        ORDER BY party_entity_id ASC`,
    );
    return rows.map(approvalFromRow);
  }

  async listInvalidatedProposalApprovals(): Promise<
    InvalidatedProposalApproval[]
  > {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT DISTINCT approval_request_id, party_entity_id
         FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND invalidated_at IS NOT NULL
        ORDER BY approval_request_id ASC`,
    );
    return rows.map(invalidatedApprovalFromRow);
  }

  async invalidateProposalsForCustodyAuthority(input: {
    householdId: string;
    relationshipId: string;
    invalidatedAt: string;
    reason: string;
  }): Promise<{
    proposalIds: string[];
    invalidatedApprovals: InvalidatedProposalApproval[];
  }> {
    return await withTransaction(this.runtime, async (tx) => {
      const proposals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'invalidated',
                updated_at = ${sqlQuote(input.invalidatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(input.householdId)}
            AND status = 'pending'
            AND terms_json::jsonb #>>
                '{custodyException,authorityBaselineRelationshipId}' =
                ${sqlQuote(input.relationshipId)}
        RETURNING proposal_id, version`,
      );
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals AS approval
            SET invalidated_at = ${sqlQuote(input.invalidatedAt)},
                updated_at = ${sqlQuote(input.invalidatedAt)}
          WHERE approval.agent_id = ${sqlQuote(this.agentId)}
            AND approval.invalidated_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM app_lifeops.life_household_schedule_proposals AS proposal
               WHERE proposal.agent_id = approval.agent_id
                 AND proposal.proposal_id = approval.proposal_id
                 AND proposal.version = approval.proposal_version
                 AND proposal.household_id = ${sqlQuote(input.householdId)}
                 AND proposal.status = 'invalidated'
                 AND proposal.terms_json::jsonb #>>
                     '{custodyException,authorityBaselineRelationshipId}' =
                     ${sqlQuote(input.relationshipId)}
            )
        RETURNING approval_request_id, party_entity_id`,
      );
      for (const row of proposals) {
        await insertAudit(tx, this.agentId, {
          kind: "household_proposal_invalidated",
          ownerId: requiredText(row.proposal_id, "proposalId"),
          reason: input.reason,
          inputs: {
            householdId: input.householdId,
            proposalVersion: requiredInteger(row.version, "proposalVersion"),
            authorityBaselineRelationshipId: input.relationshipId,
          },
          decision: {
            status: "invalidated",
            invalidatedAt: input.invalidatedAt,
          },
          actor: "user",
          createdAt: input.invalidatedAt,
        });
      }
      return {
        proposalIds: proposals.map((row) =>
          requiredText(row.proposal_id, "proposalId"),
        ),
        invalidatedApprovals: approvals.map(invalidatedApprovalFromRow),
      };
    });
  }

  async rejectProposal(input: {
    proposalId: string;
    proposalVersion: number;
    partyEntityId: string;
    reason: string;
    rejectedAt: string;
  }): Promise<InvalidatedProposalApproval[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'rejected',
                updated_at = ${sqlQuote(input.rejectedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND version = ${sqlInteger(input.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (changed.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${input.proposalId} v${input.proposalVersion} is no longer pending`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: input.proposalId,
            proposalVersion: input.proposalVersion,
          },
        );
      }
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = ${sqlQuote(input.rejectedAt)},
                updated_at = ${sqlQuote(input.rejectedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND proposal_version = ${sqlInteger(input.proposalVersion)}
            AND invalidated_at IS NULL
        RETURNING approval_request_id, party_entity_id`,
      );
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_invalidated",
        ownerId: input.proposalId,
        reason: input.reason,
        inputs: {
          proposalVersion: input.proposalVersion,
          partyEntityId: input.partyEntityId,
        },
        decision: {
          status: "rejected",
          rejectedAt: input.rejectedAt,
        },
        actor: "user",
        createdAt: input.rejectedAt,
      });
      return invalidatedApprovals.map(invalidatedApprovalFromRow);
    });
  }

  async expireProposal(input: {
    proposalId: string;
    proposalVersion: number;
    expiredAt: string;
  }): Promise<InvalidatedProposalApproval[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'expired',
                updated_at = ${sqlQuote(input.expiredAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND version = ${sqlInteger(input.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = COALESCE(invalidated_at, ${sqlQuote(input.expiredAt)}),
                updated_at = CASE
                  WHEN invalidated_at IS NULL THEN ${sqlQuote(input.expiredAt)}
                  ELSE updated_at
                END
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND proposal_version = ${sqlInteger(input.proposalVersion)}
        RETURNING approval_request_id, party_entity_id`,
      );
      if (changed.length === 1) {
        await insertAudit(tx, this.agentId, {
          kind: "household_proposal_invalidated",
          ownerId: input.proposalId,
          reason: "The affected-party approval window expired.",
          inputs: {
            proposalVersion: input.proposalVersion,
          },
          decision: {
            status: "expired",
            expiredAt: input.expiredAt,
          },
          actor: "workflow",
          createdAt: input.expiredAt,
        });
      }
      if (changed.length === 0) {
        const rows = await executeRawSqlTx(
          tx,
          `SELECT status
             FROM app_lifeops.life_household_schedule_proposals
            WHERE agent_id = ${sqlQuote(this.agentId)}
              AND proposal_id = ${sqlQuote(input.proposalId)}
              AND version = ${sqlInteger(input.proposalVersion)}
            LIMIT 1`,
        );
        const status = rows[0] ? requiredText(rows[0].status, "status") : null;
        if (status !== "expired") {
          throw new HouseholdCoordinationError(
            `Proposal ${input.proposalId} v${input.proposalVersion} cannot expire from ${status ?? "missing"}`,
            "HOUSEHOLD_PROPOSAL_CONFLICT",
            {
              proposalId: input.proposalId,
              proposalVersion: input.proposalVersion,
              status,
            },
          );
        }
      }
      return invalidatedApprovals.map(invalidatedApprovalFromRow);
    });
  }

  async activateAgreement(
    agreement: HouseholdScheduleAgreement,
    commitment: LifeOpsCommitmentLedgerRecord,
  ): Promise<{
    invalidatedProposalIds: string[];
    invalidatedApprovals: InvalidatedProposalApproval[];
  }> {
    return await withTransaction(this.runtime, async (tx) => {
      const proposalRows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'accepted',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(agreement.householdId)}
            AND proposal_id = ${sqlQuote(agreement.proposalId)}
            AND version = ${sqlInteger(agreement.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (proposalRows.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${agreement.proposalId} v${agreement.proposalVersion} is no longer pending`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: agreement.proposalId,
            proposalVersion: agreement.proposalVersion,
          },
        );
      }
      const headRows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_coordination_heads
            SET current_agreement_version = ${sqlInteger(agreement.version)},
                current_agreement_id = ${sqlQuote(agreement.id)},
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(agreement.householdId)}
            AND coordination_id = ${sqlQuote(agreement.coordinationId)}
            AND current_agreement_version = ${sqlInteger(agreement.version - 1)}
        RETURNING id`,
      );
      if (headRows.length !== 1) {
        throw new HouseholdCoordinationError(
          `Coordination ${agreement.coordinationId} advanced while the proposal was awaiting approval`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            coordinationId: agreement.coordinationId,
            expectedVersion: agreement.version - 1,
          },
        );
      }
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_household_schedule_agreements (
          id, agent_id, household_id, coordination_id, version, proposal_id,
          proposal_version, terms_json, affected_party_entity_ids_json,
          approved_by_entity_ids_json, activated_at, created_at
        ) VALUES (
          ${sqlQuote(agreement.id)},
          ${sqlQuote(this.agentId)},
          ${sqlQuote(agreement.householdId)},
          ${sqlQuote(agreement.coordinationId)},
          ${sqlInteger(agreement.version)},
          ${sqlQuote(agreement.proposalId)},
          ${sqlInteger(agreement.proposalVersion)},
          ${sqlJson(agreement.terms)},
          ${sqlJson(agreement.affectedPartyEntityIds)},
          ${sqlJson(agreement.approvedByEntityIds)},
          ${sqlQuote(agreement.activatedAt)},
          ${sqlQuote(agreement.createdAt)}
        )`,
      );
      await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_commitment_ledger
            SET status = 'superseded',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND status IN ('open', 'tracked')
            AND metadata_json::jsonb ->> 'householdId' =
                ${sqlQuote(agreement.householdId)}
            AND metadata_json::jsonb ->> 'householdCoordinationId' =
                ${sqlQuote(agreement.coordinationId)}`,
      );
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_commitment_ledger (
          id, agent_id, source, source_key, kind, summary, counterparty,
          due_at, confidence, status, scheduled_task_id, metadata_json,
          created_at, updated_at
        ) VALUES (
          ${sqlQuote(commitment.id)},
          ${sqlQuote(commitment.agentId)},
          ${sqlQuote(commitment.source)},
          ${sqlQuote(commitment.sourceKey)},
          ${sqlQuote(commitment.kind)},
          ${sqlQuote(commitment.summary)},
          ${sqlText(commitment.counterparty)},
          ${sqlText(commitment.dueAt)},
          ${sqlNumber(commitment.confidence)},
          ${sqlQuote(commitment.status)},
          ${sqlText(commitment.scheduledTaskId)},
          ${sqlJson(commitment.metadata)},
          ${sqlQuote(commitment.createdAt)},
          ${sqlQuote(commitment.updatedAt)}
        )`,
      );
      const invalidated = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'invalidated',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(agreement.householdId)}
            AND coordination_id = ${sqlQuote(agreement.coordinationId)}
            AND base_agreement_version < ${sqlInteger(agreement.version)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals AS approval
            SET invalidated_at = ${sqlQuote(agreement.activatedAt)},
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE approval.agent_id = ${sqlQuote(this.agentId)}
            AND approval.invalidated_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM app_lifeops.life_household_schedule_proposals AS proposal
               WHERE proposal.agent_id = approval.agent_id
                 AND proposal.proposal_id = approval.proposal_id
                 AND proposal.version = approval.proposal_version
                 AND proposal.household_id = ${sqlQuote(agreement.householdId)}
                 AND proposal.coordination_id = ${sqlQuote(agreement.coordinationId)}
                 AND proposal.status = 'invalidated'
            )
        RETURNING approval_request_id, party_entity_id`,
      );
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_approved",
        ownerId: agreement.proposalId,
        reason:
          "Every required affected-party approval matched this proposal version.",
        inputs: {
          householdId: agreement.householdId,
          proposalVersion: agreement.proposalVersion,
          approvedByEntityIds: agreement.approvedByEntityIds,
        },
        decision: {
          agreementId: agreement.id,
          agreementVersion: agreement.version,
        },
        actor: "workflow",
        createdAt: agreement.activatedAt,
      });
      await insertAudit(tx, this.agentId, {
        kind: "household_agreement_activated",
        ownerId: agreement.id,
        reason: "The approved proposal became the current household agreement.",
        inputs: {
          householdId: agreement.householdId,
          proposalId: agreement.proposalId,
          proposalVersion: agreement.proposalVersion,
          affectedPartyEntityIds: agreement.affectedPartyEntityIds,
        },
        decision: {
          coordinationId: agreement.coordinationId,
          agreementVersion: agreement.version,
        },
        actor: "workflow",
        createdAt: agreement.activatedAt,
      });
      for (const row of invalidated) {
        await insertAudit(tx, this.agentId, {
          kind: "household_proposal_invalidated",
          ownerId: requiredText(row.proposal_id, "proposalId"),
          reason: "A competing proposal activated a newer agreement version.",
          inputs: {
            householdId: agreement.householdId,
            coordinationId: agreement.coordinationId,
          },
          decision: {
            invalidatedAt: agreement.activatedAt,
            currentAgreementVersion: agreement.version,
          },
          actor: "workflow",
          createdAt: agreement.activatedAt,
        });
      }
      return {
        invalidatedProposalIds: invalidated.map((row) =>
          requiredText(row.proposal_id, "proposalId"),
        ),
        invalidatedApprovals: invalidatedApprovals.map(
          invalidatedApprovalFromRow,
        ),
      };
    });
  }

  async listAgreements(
    householdId?: string,
  ): Promise<HouseholdScheduleAgreement[]> {
    const householdClause = householdId
      ? `AND agreement.household_id = ${sqlQuote(householdId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT agreement.*, head.current_agreement_id
         FROM app_lifeops.life_household_schedule_agreements AS agreement
         JOIN app_lifeops.life_household_coordination_heads AS head
          ON head.agent_id = agreement.agent_id
          AND head.household_id = agreement.household_id
          AND head.coordination_id = agreement.coordination_id
        WHERE agreement.agent_id = ${sqlQuote(this.agentId)}
          ${householdClause}
        ORDER BY agreement.activated_at ASC, agreement.id ASC`,
    );
    return rows.map((row) =>
      agreementFromRow(row, optionalText(row.current_agreement_id)),
    );
  }

  async listAudit(): Promise<HouseholdAuditRecord[]> {
    const kinds = HOUSEHOLD_AUDIT_KINDS.map(sqlQuote).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_audit_events
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND event_type IN (${kinds})
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => {
      const kind = requiredText(row.event_type, "eventType");
      if (!isHouseholdAuditKind(kind)) {
        throw new HouseholdCoordinationError(
          `Unknown persisted household audit kind: ${kind}`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { kind },
        );
      }
      const actor = requiredText(row.actor, "actor");
      if (actor !== "agent" && actor !== "user" && actor !== "workflow") {
        throw new HouseholdCoordinationError(
          `Unknown persisted household audit actor: ${actor}`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { actor },
        );
      }
      return {
        id: requiredText(row.id, "id"),
        kind,
        ownerId: requiredText(row.owner_id, "ownerId"),
        reason: toText(row.reason),
        inputs: parseJsonRecord(row.inputs_json),
        decision: parseJsonRecord(row.decision_json),
        actor,
        createdAt: requiredText(row.created_at, "createdAt"),
      };
    });
  }
}
