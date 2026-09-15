/**
 * Household coordination policy over the runtime graph, approval queue, and
 * commitment ledger. The service turns mutable scheduling discussions into
 * version-pinned proposals and activates an agreement only after every named
 * adult approves those exact proposal bytes. Audit-record entity scans are
 * bounded in `household-entity-scan.ts`.
 */
import crypto from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import {
  type Entity,
  type Relationship,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalChannel,
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import {
  type ChannelContribution,
  getChannelRegistry,
} from "../channels/index.js";
import { createLifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
// Registry-only import (not the connector barrel) so the household policy
// layer never pulls the connector contribution graph.
import { getConnectorRegistry } from "../connectors/registry.js";
import {
  cancelHouseholdGrantExpiryWarning,
  ensureHouseholdGrantExpiryWarning,
  type HouseholdGrantExpiryWarningReceipt,
} from "./grant-expiry-warning.js";
import { householdExportAuditVisibleToAudience } from "./household-entity-scan.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import {
  DEFAULT_HOUSEHOLD_ID,
  expandGrantScopes,
  HOUSEHOLD_ACCESS_SCOPES,
  HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID,
  type HouseholdAccessGrant,
  type HouseholdAccessScope,
  type HouseholdAuditRecord,
  HouseholdCoordinationError,
  type HouseholdCoordinationHead,
  type HouseholdCustodyAuthorityBaseline,
  type HouseholdExportScheduleEntry,
  type HouseholdProposalApproval,
  type HouseholdRole,
  type HouseholdRoleBinding,
  type HouseholdScheduleAgreement,
  type HouseholdScheduleProposal,
  type HouseholdScheduleTerms,
  type HouseholdScopedExport,
  householdApprovalRequestPrompt,
  type InvalidatedProposalApproval,
  isHouseholdRole,
  materialScheduleFingerprint,
  normalizeGrantScopes,
  normalizeHouseholdIdentifier,
  normalizeHouseholdIdentifiers,
  normalizeScheduleTerms,
  uniqueStrings,
} from "./types.js";

const HOUSEHOLD_ROLE_METADATA_KEY = "householdRole";
const HOUSEHOLD_SUBJECTS_METADATA_KEY = "householdSubjectEntityIds";
const HOUSEHOLD_ID_METADATA_KEY = "householdId";
const CUSTODY_AUTHORITY_CHILD_METADATA_KEY = "custodyAuthorityChildEntityId";
const CUSTODY_AUTHORITY_CUSTODIANS_METADATA_KEY =
  "custodyAuthorityCustodianEntityIds";
const CUSTODY_AUTHORITY_REVISION_METADATA_KEY = "custodyAuthorityRevision";
const DEFAULT_PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000;
export const HOUSEHOLD_COORDINATION_SERVICE = "lifeops_household_coordination";

export interface HouseholdCoordinationDependencies {
  runtime: IAgentRuntime;
  agentId: string;
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  approvalQueue: ApprovalQueue;
  repository: HouseholdCoordinationRepository;
  scheduledTasks?: ScheduledTaskRunnerHandle;
  now?: () => Date;
}

export interface CreateHouseholdProposalInput {
  proposalId?: string;
  householdId?: string;
  coordinationId: string;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  requiredApproverEntityIds: string[];
  createdByEntityId: string;
  baseAgreementVersion?: number;
  expiresAt?: string | null;
}

export interface ReviseHouseholdProposalInput {
  householdId?: string;
  proposalId: string;
  expectedVersion: number;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  requiredApproverEntityIds: string[];
  revisedByEntityId: string;
  expiresAt?: string | null;
}

function householdNamespace(value: string | undefined): string {
  return normalizeHouseholdIdentifier(
    value ?? DEFAULT_HOUSEHOLD_ID,
    "householdId",
  );
}

function roleRelationshipType(role: HouseholdRole): string {
  if (role === "co_parent") return "co_parent_of";
  if (role === "current_partner") return "partner_of";
  if (role === "child") return "parent_of";
  if (role === "caregiver") return "delegates_care_to";
  if (role === "professional") return "client_of";
  return "knows";
}

function readRoleMetadata(relationship: Relationship): HouseholdRole | null {
  const value = relationship.metadata?.[HOUSEHOLD_ROLE_METADATA_KEY];
  return typeof value === "string" && isHouseholdRole(value) ? value : null;
}

function readSubjectMetadata(relationship: Relationship): string[] {
  const value = relationship.metadata?.[HOUSEHOLD_SUBJECTS_METADATA_KEY];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new HouseholdCoordinationError(
      `Relationship ${relationship.relationshipId} has invalid household subjects`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { relationshipId: relationship.relationshipId },
    );
  }
  return uniqueStrings(value);
}

/**
 * Collapses repeated invalidation rows for one approval request. A request has
 * exactly one subject, so the same id arriving under two parties means the
 * link table disagrees with the queue and no scoped call can be made safely.
 */
function dedupeInvalidatedApprovals(
  invalidated: readonly InvalidatedProposalApproval[],
): InvalidatedProposalApproval[] {
  const byRequestId = new Map<string, InvalidatedProposalApproval>();
  for (const entry of invalidated) {
    const existing = byRequestId.get(entry.requestId);
    if (existing && existing.partyEntityId !== entry.partyEntityId) {
      throw new HouseholdCoordinationError(
        `Approval request ${entry.requestId} is linked to two household parties`,
        "HOUSEHOLD_STALE_APPROVAL",
        {
          requestId: entry.requestId,
          partyEntityIds: [existing.partyEntityId, entry.partyEntityId],
        },
      );
    }
    byRequestId.set(entry.requestId, entry);
  }
  return [...byRequestId.values()];
}

function readHouseholdIdMetadata(relationship: Relationship): string | null {
  const value = relationship.metadata?.[HOUSEHOLD_ID_METADATA_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function custodyAuthorityRevisionSha256(input: {
  householdId: string;
  relationshipId: string;
  childEntityId: string;
  custodianEntityIds: readonly string[];
  revision: number;
  status: "active" | "revoked";
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        householdId: input.householdId,
        relationshipId: input.relationshipId,
        childEntityId: input.childEntityId,
        custodianEntityIds: uniqueStrings(input.custodianEntityIds),
        revision: input.revision,
        status: input.status,
      }),
    )
    .digest("hex");
}

function validateFutureExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): string | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new HouseholdCoordinationError(
      "expiresAt must be a future ISO-8601 timestamp",
      "HOUSEHOLD_INVALID_CONTRACT",
      { expiresAt },
    );
  }
  return new Date(timestamp).toISOString();
}

function proposalExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): string {
  if (expiresAt !== null && expiresAt !== undefined) {
    const explicit = validateFutureExpiry(expiresAt, now);
    if (explicit) return explicit;
  }
  return new Date(now.getTime() + DEFAULT_PROPOSAL_TTL_MS).toISOString();
}

function nonNegativeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new HouseholdCoordinationError(
      `${field} must be an integer greater than or equal to ${minimum}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

function latestProposalVersions(
  proposals: readonly HouseholdScheduleProposal[],
): HouseholdScheduleProposal[] {
  return Array.from(
    proposals.reduce((latest, proposal) => {
      const current = latest.get(proposal.proposalId);
      if (!current || current.version < proposal.version) {
        latest.set(proposal.proposalId, proposal);
      }
      return latest;
    }, new Map<string, HouseholdScheduleProposal>()),
  ).map(([, proposal]) => proposal);
}

function approvalPayloadMatches(
  request: ApprovalRequest,
  proposal: HouseholdScheduleProposal,
  partyEntityId: string,
): boolean {
  if (request.action !== "execute_workflow") return false;
  if (request.payload.action !== "execute_workflow") return false;
  if (
    request.payload.workflowId !==
    HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID
  ) {
    return false;
  }
  return (
    request.payload.input.proposalId === proposal.proposalId &&
    request.payload.input.proposalVersion === proposal.version &&
    request.payload.input.householdId === proposal.householdId &&
    request.payload.input.coordinationId === proposal.coordinationId &&
    request.payload.input.partyEntityId === partyEntityId &&
    request.payload.input.contentSha256 === proposal.contentSha256
  );
}

function proposalContentSha256(
  proposal: Omit<
    HouseholdScheduleProposal,
    "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
  >,
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        agentId: proposal.agentId,
        proposalId: proposal.proposalId,
        version: proposal.version,
        householdId: proposal.householdId,
        coordinationId: proposal.coordinationId,
        baseAgreementVersion: proposal.baseAgreementVersion,
        terms: proposal.terms,
        affectedPartyEntityIds: proposal.affectedPartyEntityIds,
        requiredApproverEntityIds: proposal.requiredApproverEntityIds,
        createdByEntityId: proposal.createdByEntityId,
        expiresAt: proposal.expiresAt,
      }),
    )
    .digest("hex");
}

function approvalIdempotencyKey(
  proposal: HouseholdScheduleProposal,
  partyEntityId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        proposal.agentId,
        proposal.proposalId,
        String(proposal.version),
        partyEntityId,
        proposal.contentSha256,
      ].join("\0"),
    )
    .digest("hex");
  return `household-proposal-approval:${digest}`;
}

/**
 * Ordered outbound preference for reaching an affected party. Platforms are
 * `EntityIdentity.platform` values and mirror the inbound `identityPlatforms`
 * mapping in inbound-approval.ts, so a decision sent back on the same channel
 * authenticates against the identity the prompt was delivered to.
 *
 * Discord requires `targetKind: "user"` — the verified identity handle is a
 * Discord USER id, which the connector resolves to a DM. Connector-account
 * binding rides the verified identity so multi-account installations cannot
 * silently send from a different bot/account. Provider-qualified outbound →
 * inbound round-trip evidence is still required before any route is called
 * live-verified.
 */
const PARTY_CONTACT_ROUTES: ReadonlyArray<{
  channel: Extract<
    ApprovalChannel,
    "telegram" | "whatsapp" | "imessage" | "sms" | "email" | "discord" | "x_dm"
  >;
  platforms: readonly string[];
  /** Set when the identity handle is a platform USER id, not a channel id. */
  targetKind?: "user";
}> = [
  { channel: "telegram", platforms: ["telegram"] },
  { channel: "whatsapp", platforms: ["whatsapp"] },
  { channel: "imessage", platforms: ["imessage"] },
  { channel: "sms", platforms: ["phone", "sms", "twilio"] },
  { channel: "email", platforms: ["email", "gmail", "google"] },
  { channel: "discord", platforms: ["discord"], targetKind: "user" },
  { channel: "x_dm", platforms: ["x", "twitter"] },
];

interface PartyApprovalContactRoute {
  channel: ApprovalChannel;
  target: string;
  targetKind?: "user";
  platform: string;
  connectorAccountId?: string;
  send: NonNullable<ChannelContribution["send"]>;
}

export class HouseholdCoordinationService {
  private readonly now: () => Date;

  constructor(private readonly deps: HouseholdCoordinationDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private scheduledTasks() {
    return (
      this.deps.scheduledTasks ??
      getScheduledTaskRunner(this.deps.runtime, {
        agentId: this.deps.agentId,
        now: this.now,
      })
    );
  }

  async reconcileGrantExpiryWarnings(): Promise<
    HouseholdGrantExpiryWarningReceipt[]
  > {
    const now = this.now();
    const grants = await this.deps.repository.listGrants();
    const receipts: HouseholdGrantExpiryWarningReceipt[] = [];
    for (const grant of grants) {
      try {
        receipts.push(
          grant.revokedAt
            ? await cancelHouseholdGrantExpiryWarning({
                grant,
                repository: this.deps.repository,
                scheduledTasks: this.scheduledTasks(),
                now,
              })
            : await ensureHouseholdGrantExpiryWarning({
                grant,
                repository: this.deps.repository,
                scheduledTasks: this.scheduledTasks(),
                now,
              }),
        );
      } catch (error) {
        // error-policy:J7 the durable warning/cancellation outbox remains
        // pending; one grant failure must not prevent the same scheduler tick
        // from repairing every other household grant.
        const reason = grant.revokedAt
          ? "cancellation_failure"
          : "materialization_failure";
        this.deps.runtime.reportError(
          "HouseholdCoordination.reconcileGrantExpiryWarning",
          error,
          {
            grantId: grant.id,
            reason,
            recovery: "lifeops_scheduler_tick",
          },
        );
        receipts.push({
          outcome: "deferred",
          grantId: grant.id,
          reason,
          failedAt: now.toISOString(),
          autoExtend: false,
        });
      }
    }
    return receipts;
  }

  private async terminallyInvalidateApprovalRequests(
    invalidated: readonly InvalidatedProposalApproval[],
    invalidationContext: string,
  ): Promise<void> {
    for (const { requestId, partyEntityId } of dedupeInvalidatedApprovals(
      invalidated,
    )) {
      const request = await this.deps.approvalQueue.byId(
        requestId,
        partyEntityId,
      );
      if (!request) {
        throw new HouseholdCoordinationError(
          `Approval request ${requestId} referenced by household state is missing`,
          "HOUSEHOLD_STALE_APPROVAL",
          { requestId, partyEntityId, invalidationContext },
        );
      }
      if (request.state === "pending" || request.state === "approved") {
        await this.deps.approvalQueue.markExpired(requestId, partyEntityId);
        continue;
      }
      if (request.state === "rejected" || request.state === "expired") {
        continue;
      }
      throw new HouseholdCoordinationError(
        `Approval request ${requestId} cannot be invalidated from ${request.state}`,
        "HOUSEHOLD_STALE_APPROVAL",
        {
          requestId,
          partyEntityId,
          approvalState: request.state,
          invalidationContext,
        },
      );
    }
  }

  private async reconcilePersistedApprovalInvalidations(): Promise<void> {
    const pendingProposals = (
      await this.deps.repository.listProposals()
    ).filter((proposal) => proposal.status === "pending");
    for (const proposal of pendingProposals) {
      const links = await this.deps.repository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      );
      for (const link of links) {
        if (link.invalidatedAt) continue;
        const request = await this.deps.approvalQueue.byId(
          link.approvalRequestId,
          link.partyEntityId,
        );
        if (!request) {
          throw new HouseholdCoordinationError(
            `Approval request ${link.approvalRequestId} referenced by household state is missing`,
            "HOUSEHOLD_STALE_APPROVAL",
            {
              proposalId: proposal.proposalId,
              proposalVersion: proposal.version,
              partyEntityId: link.partyEntityId,
              approvalRequestId: link.approvalRequestId,
            },
          );
        }
        if (request.state !== "rejected") continue;
        if (
          request.subjectUserId !== link.partyEntityId ||
          request.resolvedBy !== link.partyEntityId ||
          !request.resolvedAt ||
          !request.resolutionReason?.trim() ||
          !approvalPayloadMatches(request, proposal, link.partyEntityId)
        ) {
          throw new HouseholdCoordinationError(
            "Rejected approval row does not match the exact household proposal and party",
            "HOUSEHOLD_STALE_APPROVAL",
            {
              proposalId: proposal.proposalId,
              proposalVersion: proposal.version,
              partyEntityId: link.partyEntityId,
              approvalRequestId: link.approvalRequestId,
            },
          );
        }
        const invalidated = await this.deps.repository.rejectProposal({
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          partyEntityId: link.partyEntityId,
          reason: request.resolutionReason,
          rejectedAt: request.resolvedAt.toISOString(),
        });
        await this.terminallyInvalidateApprovalRequests(
          invalidated,
          `recovered rejected household proposal ${proposal.proposalId} v${proposal.version}`,
        );
        break;
      }
    }
    await this.terminallyInvalidateApprovalRequests(
      await this.deps.repository.listInvalidatedProposalApprovals(),
      "persisted household proposal invalidation",
    );
  }

  private async expireProposalIfLapsed(
    proposal: HouseholdScheduleProposal,
    at: Date,
  ): Promise<boolean> {
    if (
      proposal.status !== "pending" ||
      !proposal.expiresAt ||
      Date.parse(proposal.expiresAt) > at.getTime()
    ) {
      return false;
    }
    const invalidated = await this.deps.repository.expireProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      expiredAt: at.toISOString(),
    });
    await this.terminallyInvalidateApprovalRequests(
      invalidated,
      `expired household proposal ${proposal.proposalId} v${proposal.version}`,
    );
    return true;
  }

  private async requireEntity(entityId: string): Promise<Entity> {
    const normalizedEntityId = normalizeHouseholdIdentifier(
      entityId,
      "entityId",
    );
    const entity =
      normalizedEntityId === SELF_ENTITY_ID
        ? await this.deps.entityStore.ensureSelf()
        : await this.deps.entityStore.get(normalizedEntityId);
    if (!entity) {
      throw new HouseholdCoordinationError(
        `Household entity ${normalizedEntityId} was not found`,
        "HOUSEHOLD_ENTITY_NOT_FOUND",
        { entityId: normalizedEntityId },
      );
    }
    return entity;
  }

  private async requireEntities(entityIds: readonly string[]): Promise<void> {
    for (const entityId of normalizeHouseholdIdentifiers(
      entityIds,
      "entityIds",
    )) {
      await this.requireEntity(entityId);
    }
  }

  async bindRole(input: {
    entityId: string;
    role: HouseholdRole;
    householdId?: string;
    subjectEntityIds?: string[];
    relationshipId?: string | null;
    evidence: string;
    boundByEntityId: string;
  }): Promise<HouseholdRoleBinding> {
    const entityId = normalizeHouseholdIdentifier(input.entityId, "entityId");
    const boundByEntityId = normalizeHouseholdIdentifier(
      input.boundByEntityId,
      "boundByEntityId",
    );
    const relationshipId =
      input.relationshipId === null || input.relationshipId === undefined
        ? null
        : normalizeHouseholdIdentifier(input.relationshipId, "relationshipId");
    const householdId = householdNamespace(input.householdId);
    await this.requireEntity(entityId);
    await this.requireEntity(boundByEntityId);
    const subjectEntityIds = normalizeHouseholdIdentifiers(
      input.subjectEntityIds ?? [],
      "subjectEntityIds",
    );
    await this.requireEntities(subjectEntityIds);
    if (boundByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may bind household roles",
        "HOUSEHOLD_ACCESS_DENIED",
        { boundByEntityId },
      );
    }

    const now = this.now().toISOString();
    if (input.role === "owner") {
      if (entityId !== SELF_ENTITY_ID) {
        throw new HouseholdCoordinationError(
          "The owner role is reserved for the self entity",
          "HOUSEHOLD_INVALID_CONTRACT",
          { entityId },
        );
      }
      const binding: HouseholdRoleBinding = {
        householdId,
        entityId: SELF_ENTITY_ID,
        role: "owner",
        relationshipId: null,
        subjectEntityIds,
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.repository.appendAudit({
        kind: "household_role_bound",
        ownerId: SELF_ENTITY_ID,
        reason: input.evidence,
        inputs: { householdId, entityId: SELF_ENTITY_ID, role: "owner" },
        decision: { householdId, subjectEntityIds },
        actor: "user",
        createdAt: now,
      });
      return binding;
    }

    let relationship: Relationship;
    if (relationshipId) {
      const existing = await this.deps.relationshipStore.get(relationshipId);
      if (!existing) {
        throw new HouseholdCoordinationError(
          `Relationship ${relationshipId} is unavailable`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId },
        );
      }
      if (existing.status !== "active") {
        throw new HouseholdCoordinationError(
          `Relationship ${relationshipId} is unavailable`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId },
        );
      }
      const existingHouseholdId = readHouseholdIdMetadata(existing);
      if (existingHouseholdId !== null && existingHouseholdId !== householdId) {
        throw new HouseholdCoordinationError(
          "Household role relationship belongs to a different household namespace",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            relationshipId: existing.relationshipId,
            expectedHouseholdId: householdId,
            actualHouseholdId: existingHouseholdId,
          },
        );
      }
      const endpointIds = new Set([existing.fromEntityId, existing.toEntityId]);
      if (!endpointIds.has(SELF_ENTITY_ID) || !endpointIds.has(entityId)) {
        throw new HouseholdCoordinationError(
          "Household role relationship must connect self and the principal",
          "HOUSEHOLD_INVALID_CONTRACT",
          {
            relationshipId: existing.relationshipId,
            entityId,
          },
        );
      }
      relationship = await this.deps.relationshipStore.upsert({
        relationshipId: existing.relationshipId,
        fromEntityId: existing.fromEntityId,
        toEntityId: existing.toEntityId,
        type: existing.type,
        metadata: {
          ...existing.metadata,
          [HOUSEHOLD_ROLE_METADATA_KEY]: input.role,
          [HOUSEHOLD_SUBJECTS_METADATA_KEY]: subjectEntityIds,
          [HOUSEHOLD_ID_METADATA_KEY]: householdId,
        },
        state: existing.state,
        evidence: uniqueStrings([...existing.evidence, input.evidence]),
        confidence: Math.max(existing.confidence, 1),
        source: "user_chat",
        status: "active",
      });
    } else {
      const deterministicRelationshipId = `hrole_${crypto
        .createHash("sha256")
        .update(`${this.deps.agentId}\0${householdId}\0${entityId}`)
        .digest("hex")}`;
      const existing = await this.deps.relationshipStore.get(
        deterministicRelationshipId,
      );
      relationship = await this.deps.relationshipStore.upsert({
        relationshipId: deterministicRelationshipId,
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: entityId,
        type: roleRelationshipType(input.role),
        metadata: {
          ...(existing?.metadata ?? {}),
          [HOUSEHOLD_ROLE_METADATA_KEY]: input.role,
          [HOUSEHOLD_SUBJECTS_METADATA_KEY]: subjectEntityIds,
          [HOUSEHOLD_ID_METADATA_KEY]: householdId,
        },
        state: existing?.state ?? {},
        evidence: uniqueStrings([
          ...(existing?.evidence ?? []),
          input.evidence,
        ]),
        confidence: 1,
        source: "user_chat",
        status: "active",
      });
    }
    const binding: HouseholdRoleBinding = {
      householdId,
      entityId,
      role: input.role,
      relationshipId: relationship.relationshipId,
      subjectEntityIds,
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    };
    await this.deps.repository.appendAudit({
      kind: "household_role_bound",
      ownerId: relationship.relationshipId,
      reason: input.evidence,
      inputs: {
        entityId,
        role: input.role,
        householdId,
        relationshipId: relationship.relationshipId,
      },
      decision: { subjectEntityIds },
      actor: "user",
      createdAt: now,
    });
    return binding;
  }

  async listRoleBindings(
    householdIdInput?: string,
  ): Promise<HouseholdRoleBinding[]> {
    const householdId = householdNamespace(householdIdInput);
    const self = await this.deps.entityStore.ensureSelf();
    const relationships = await this.deps.relationshipStore.list();
    const bindings: HouseholdRoleBinding[] = [
      {
        householdId,
        entityId: SELF_ENTITY_ID,
        role: "owner",
        relationshipId: null,
        subjectEntityIds: [],
        createdAt: self.createdAt,
        updatedAt: self.updatedAt,
      },
    ];
    for (const relationship of relationships) {
      if (relationship.status !== "active") continue;
      const role = readRoleMetadata(relationship);
      if (!role) continue;
      if (
        (readHouseholdIdMetadata(relationship) ?? DEFAULT_HOUSEHOLD_ID) !==
        householdId
      ) {
        continue;
      }
      const entityId =
        relationship.fromEntityId === SELF_ENTITY_ID
          ? relationship.toEntityId
          : relationship.toEntityId === SELF_ENTITY_ID
            ? relationship.fromEntityId
            : null;
      if (!entityId) {
        throw new HouseholdCoordinationError(
          `Household relationship ${relationship.relationshipId} does not connect to self`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { relationshipId: relationship.relationshipId },
        );
      }
      bindings.push({
        householdId,
        entityId,
        role,
        relationshipId: relationship.relationshipId,
        subjectEntityIds: readSubjectMetadata(relationship),
        createdAt: relationship.createdAt,
        updatedAt: relationship.updatedAt,
      });
    }
    return bindings.sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    );
  }

  private async requireRoleBinding(
    entityId: string,
    householdId: string,
    role?: HouseholdRole,
  ): Promise<HouseholdRoleBinding> {
    const bindings = await this.listRoleBindings(householdId);
    const binding = bindings.find(
      (candidate) =>
        candidate.entityId === entityId &&
        (role === undefined || candidate.role === role),
    );
    if (!binding) {
      throw new HouseholdCoordinationError(
        `Entity ${entityId} has no matching household role`,
        "HOUSEHOLD_ACCESS_DENIED",
        { entityId, householdId, role },
      );
    }
    return binding;
  }

  private requireHouseholdMatch(
    requestedHouseholdId: string | undefined,
    actualHouseholdId: string,
    resource: Record<string, unknown>,
  ): void {
    if (requestedHouseholdId === undefined) return;
    const expectedHouseholdId = householdNamespace(requestedHouseholdId);
    if (expectedHouseholdId === actualHouseholdId) return;
    throw new HouseholdCoordinationError(
      "Household resource belongs to a different household namespace",
      "HOUSEHOLD_ACCESS_DENIED",
      {
        ...resource,
        expectedHouseholdId,
        actualHouseholdId,
      },
    );
  }

  private async requireCustodyAuthority(
    householdId: string,
    custody: NonNullable<HouseholdScheduleTerms["custodyException"]>,
  ): Promise<HouseholdCustodyAuthorityBaseline> {
    const relationship = await this.deps.relationshipStore.get(
      custody.authorityBaselineRelationshipId,
    );
    if (relationship?.status !== "active") {
      throw new HouseholdCoordinationError(
        "Custody exception requires an active authority-baseline relationship",
        "HOUSEHOLD_ACCESS_DENIED",
        {
          authorityBaselineRelationshipId:
            custody.authorityBaselineRelationshipId,
        },
      );
    }
    const endpoints = new Set([
      relationship.fromEntityId,
      relationship.toEntityId,
    ]);
    const authorityChild =
      relationship.metadata?.[CUSTODY_AUTHORITY_CHILD_METADATA_KEY];
    const authorityCustodians =
      relationship.metadata?.[CUSTODY_AUTHORITY_CUSTODIANS_METADATA_KEY];
    const authorityHouseholdId =
      readHouseholdIdMetadata(relationship) ?? DEFAULT_HOUSEHOLD_ID;
    const rawRevision =
      relationship.metadata?.[CUSTODY_AUTHORITY_REVISION_METADATA_KEY];
    const revision =
      typeof rawRevision === "number" &&
      Number.isInteger(rawRevision) &&
      rawRevision >= 1
        ? rawRevision
        : 1;
    if (
      !endpoints.has(SELF_ENTITY_ID) ||
      !endpoints.has(custody.childEntityId) ||
      authorityChild !== custody.childEntityId ||
      authorityHouseholdId !== householdId ||
      !Array.isArray(authorityCustodians) ||
      authorityCustodians.some((entityId) => typeof entityId !== "string")
    ) {
      throw new HouseholdCoordinationError(
        "Custody authority baseline does not match the proposed child",
        "HOUSEHOLD_ACCESS_DENIED",
        {
          authorityBaselineRelationshipId:
            custody.authorityBaselineRelationshipId,
          childEntityId: custody.childEntityId,
          householdId,
          authorityHouseholdId,
        },
      );
    }
    const normalizedCustodians = normalizeHouseholdIdentifiers(
      authorityCustodians,
      "authorityCustodianEntityIds",
    );
    const authorized = new Set(normalizedCustodians);
    for (const custodianEntityId of [
      custody.normalCustodianEntityId,
      custody.substituteCustodianEntityId,
    ]) {
      const binding = await this.requireRoleBinding(
        custodianEntityId,
        householdId,
      );
      if (
        (binding.role !== "owner" && binding.role !== "co_parent") ||
        !authorized.has(custodianEntityId) ||
        (binding.role !== "owner" &&
          !binding.subjectEntityIds.includes(custody.childEntityId))
      ) {
        throw new HouseholdCoordinationError(
          "Custody exception names a custodian without explicit custody authority",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            authorityBaselineRelationshipId:
              custody.authorityBaselineRelationshipId,
            childEntityId: custody.childEntityId,
            custodianEntityId,
            role: binding.role,
          },
        );
      }
    }
    const revisionSha256 = custodyAuthorityRevisionSha256({
      householdId,
      relationshipId: relationship.relationshipId,
      childEntityId: custody.childEntityId,
      custodianEntityIds: normalizedCustodians,
      revision,
      status: "active",
    });
    if (
      custody.authorityBaselineRevisionSha256 &&
      custody.authorityBaselineRevisionSha256 !== revisionSha256
    ) {
      throw new HouseholdCoordinationError(
        "Custody authority changed after the proposal bytes were authored",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          householdId,
          authorityBaselineRelationshipId:
            custody.authorityBaselineRelationshipId,
          approvedRevisionSha256: custody.authorityBaselineRevisionSha256,
          currentRevisionSha256: revisionSha256,
        },
      );
    }
    return {
      householdId,
      relationshipId: relationship.relationshipId,
      childEntityId: custody.childEntityId,
      custodianEntityIds: normalizedCustodians,
      revision,
      revisionSha256,
      status: "active",
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    };
  }

  async setCustodyAuthority(input: {
    householdId?: string;
    relationshipId?: string;
    childEntityId: string;
    custodianEntityIds: string[];
    evidence: string;
    updatedByEntityId: string;
    expectedRevisionSha256?: string;
  }): Promise<HouseholdCustodyAuthorityBaseline> {
    const householdId = householdNamespace(input.householdId);
    const childEntityId = normalizeHouseholdIdentifier(
      input.childEntityId,
      "childEntityId",
    );
    const custodianEntityIds = normalizeHouseholdIdentifiers(
      input.custodianEntityIds,
      "custodianEntityIds",
    );
    const updatedByEntityId = normalizeHouseholdIdentifier(
      input.updatedByEntityId,
      "updatedByEntityId",
    );
    const evidence = input.evidence.trim();
    if (!evidence) {
      throw new HouseholdCoordinationError(
        "Custody authority requires auditable evidence",
        "HOUSEHOLD_INVALID_CONTRACT",
        { householdId, childEntityId },
      );
    }
    if (updatedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may create or revise custody authority",
        "HOUSEHOLD_ACCESS_DENIED",
        { householdId, updatedByEntityId },
      );
    }
    if (custodianEntityIds.length < 2) {
      throw new HouseholdCoordinationError(
        "Custody authority requires at least two authorized custodians",
        "HOUSEHOLD_INVALID_CONTRACT",
        { householdId, childEntityId },
      );
    }
    await this.requireEntities([
      childEntityId,
      updatedByEntityId,
      ...custodianEntityIds,
    ]);
    await this.requireRoleBinding(childEntityId, householdId, "child");
    for (const custodianEntityId of custodianEntityIds) {
      const binding = await this.requireRoleBinding(
        custodianEntityId,
        householdId,
      );
      if (
        (binding.role !== "owner" && binding.role !== "co_parent") ||
        (binding.role !== "owner" &&
          !binding.subjectEntityIds.includes(childEntityId))
      ) {
        throw new HouseholdCoordinationError(
          "Custody authority can include only an owner or child-scoped co-parent",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            householdId,
            childEntityId,
            custodianEntityId,
            role: binding.role,
          },
        );
      }
    }
    const relationshipId =
      input.relationshipId === undefined
        ? `hcustody_${crypto
            .createHash("sha256")
            .update(`${this.deps.agentId}\0${householdId}\0${childEntityId}`)
            .digest("hex")}`
        : normalizeHouseholdIdentifier(input.relationshipId, "relationshipId");
    const existing = await this.deps.relationshipStore.get(relationshipId);
    if (existing) {
      if (existing.status !== "active") {
        throw new HouseholdCoordinationError(
          "A revoked custody authority cannot be reactivated; create a new authority relationship",
          "HOUSEHOLD_ACCESS_DENIED",
          { householdId, childEntityId, relationshipId },
        );
      }
      const endpoints = new Set([existing.fromEntityId, existing.toEntityId]);
      if (
        !endpoints.has(SELF_ENTITY_ID) ||
        !endpoints.has(childEntityId) ||
        (readHouseholdIdMetadata(existing) ?? DEFAULT_HOUSEHOLD_ID) !==
          householdId
      ) {
        throw new HouseholdCoordinationError(
          "Custody authority relationship belongs to different parties or household",
          "HOUSEHOLD_ACCESS_DENIED",
          { householdId, childEntityId, relationshipId },
        );
      }
      const existingCustodians =
        existing.metadata?.[CUSTODY_AUTHORITY_CUSTODIANS_METADATA_KEY];
      const existingRevision =
        existing.metadata?.[CUSTODY_AUTHORITY_REVISION_METADATA_KEY];
      const currentRevision =
        typeof existingRevision === "number" &&
        Number.isInteger(existingRevision) &&
        existingRevision >= 1
          ? existingRevision
          : 1;
      const currentRevisionSha256 = custodyAuthorityRevisionSha256({
        householdId,
        relationshipId,
        childEntityId,
        custodianEntityIds: Array.isArray(existingCustodians)
          ? existingCustodians.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        revision: currentRevision,
        status: existing.status === "active" ? "active" : "revoked",
      });
      if (
        input.expectedRevisionSha256 &&
        input.expectedRevisionSha256 !== currentRevisionSha256
      ) {
        throw new HouseholdCoordinationError(
          "Custody authority changed concurrently",
          "HOUSEHOLD_STALE_APPROVAL",
          {
            relationshipId,
            expectedRevisionSha256: input.expectedRevisionSha256,
            currentRevisionSha256,
          },
        );
      }
    }
    const previousRevision =
      existing?.metadata?.[CUSTODY_AUTHORITY_REVISION_METADATA_KEY];
    const revision =
      typeof previousRevision === "number" &&
      Number.isInteger(previousRevision) &&
      previousRevision >= 1
        ? previousRevision + 1
        : 1;
    const now = this.now().toISOString();
    const relationship = await this.deps.relationshipStore.upsert({
      relationshipId,
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: childEntityId,
      type: "custody_authority",
      metadata: {
        ...(existing?.metadata ?? {}),
        [HOUSEHOLD_ID_METADATA_KEY]: householdId,
        [CUSTODY_AUTHORITY_CHILD_METADATA_KEY]: childEntityId,
        [CUSTODY_AUTHORITY_CUSTODIANS_METADATA_KEY]: custodianEntityIds,
        [CUSTODY_AUTHORITY_REVISION_METADATA_KEY]: revision,
      },
      state: existing?.state ?? {},
      evidence: uniqueStrings([...(existing?.evidence ?? []), evidence]),
      confidence: 1,
      source: "user_chat",
      status: "active",
    });
    const baseline: HouseholdCustodyAuthorityBaseline = {
      householdId,
      relationshipId,
      childEntityId,
      custodianEntityIds,
      revision,
      revisionSha256: custodyAuthorityRevisionSha256({
        householdId,
        relationshipId,
        childEntityId,
        custodianEntityIds,
        revision,
        status: "active",
      }),
      status: "active",
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    };
    const invalidated =
      await this.deps.repository.invalidateProposalsForCustodyAuthority({
        householdId,
        relationshipId,
        invalidatedAt: now,
        reason:
          "Custody authority was revised after proposal approval bytes were issued.",
      });
    await this.terminallyInvalidateApprovalRequests(
      invalidated.invalidatedApprovals,
      `custody authority ${relationshipId} revised`,
    );
    await this.deps.repository.appendAudit({
      kind: "household_custody_authority_set",
      ownerId: relationshipId,
      reason: evidence,
      inputs: { householdId, childEntityId, custodianEntityIds },
      decision: {
        revision,
        revisionSha256: baseline.revisionSha256,
        invalidatedProposalIds: invalidated.proposalIds,
      },
      actor: "user",
      createdAt: now,
    });
    return baseline;
  }

  async revokeCustodyAuthority(input: {
    relationshipId: string;
    revokedByEntityId: string;
    reason: string;
    expectedRevisionSha256?: string;
    householdId?: string;
  }): Promise<HouseholdCustodyAuthorityBaseline> {
    const relationshipId = normalizeHouseholdIdentifier(
      input.relationshipId,
      "relationshipId",
    );
    const revokedByEntityId = normalizeHouseholdIdentifier(
      input.revokedByEntityId,
      "revokedByEntityId",
    );
    const reason = input.reason.trim();
    if (!reason) {
      throw new HouseholdCoordinationError(
        "Custody authority revocation requires an auditable reason",
        "HOUSEHOLD_INVALID_CONTRACT",
        { relationshipId },
      );
    }
    if (revokedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may revoke custody authority",
        "HOUSEHOLD_ACCESS_DENIED",
        { relationshipId, revokedByEntityId },
      );
    }
    const relationship = await this.deps.relationshipStore.get(relationshipId);
    if (relationship?.status !== "active") {
      throw new HouseholdCoordinationError(
        "Custody authority baseline is missing or already revoked",
        "HOUSEHOLD_ACCESS_DENIED",
        { relationshipId },
      );
    }
    const householdId =
      readHouseholdIdMetadata(relationship) ?? DEFAULT_HOUSEHOLD_ID;
    const requestedHouseholdId = householdNamespace(input.householdId);
    if (requestedHouseholdId !== householdId) {
      throw new HouseholdCoordinationError(
        "Custody authority belongs to a different household namespace",
        "HOUSEHOLD_ACCESS_DENIED",
        {
          relationshipId,
          expectedHouseholdId: requestedHouseholdId,
          actualHouseholdId: householdId,
        },
      );
    }
    const childEntityId = normalizeHouseholdIdentifier(
      String(
        relationship.metadata?.[CUSTODY_AUTHORITY_CHILD_METADATA_KEY] ?? "",
      ),
      "childEntityId",
    );
    const rawCustodians =
      relationship.metadata?.[CUSTODY_AUTHORITY_CUSTODIANS_METADATA_KEY];
    const custodianEntityIds = normalizeHouseholdIdentifiers(
      Array.isArray(rawCustodians)
        ? rawCustodians.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      "custodianEntityIds",
    );
    const rawRevision =
      relationship.metadata?.[CUSTODY_AUTHORITY_REVISION_METADATA_KEY];
    const currentRevision =
      typeof rawRevision === "number" &&
      Number.isInteger(rawRevision) &&
      rawRevision >= 1
        ? rawRevision
        : 1;
    const currentRevisionSha256 = custodyAuthorityRevisionSha256({
      householdId,
      relationshipId,
      childEntityId,
      custodianEntityIds,
      revision: currentRevision,
      status: "active",
    });
    if (
      input.expectedRevisionSha256 &&
      input.expectedRevisionSha256 !== currentRevisionSha256
    ) {
      throw new HouseholdCoordinationError(
        "Custody authority changed concurrently",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          relationshipId,
          expectedRevisionSha256: input.expectedRevisionSha256,
          currentRevisionSha256,
        },
      );
    }
    const revision = currentRevision + 1;
    const now = this.now().toISOString();
    await this.deps.relationshipStore.upsert({
      ...relationship,
      metadata: {
        ...(relationship.metadata ?? {}),
        [CUSTODY_AUTHORITY_REVISION_METADATA_KEY]: revision,
      },
      status: "active",
    });
    await this.deps.relationshipStore.retire(relationshipId, reason);
    const invalidated =
      await this.deps.repository.invalidateProposalsForCustodyAuthority({
        householdId,
        relationshipId,
        invalidatedAt: now,
        reason: "Custody authority was revoked before proposal finalization.",
      });
    await this.terminallyInvalidateApprovalRequests(
      invalidated.invalidatedApprovals,
      `custody authority ${relationshipId} revoked`,
    );
    const baseline: HouseholdCustodyAuthorityBaseline = {
      householdId,
      relationshipId,
      childEntityId,
      custodianEntityIds,
      revision,
      revisionSha256: custodyAuthorityRevisionSha256({
        householdId,
        relationshipId,
        childEntityId,
        custodianEntityIds,
        revision,
        status: "revoked",
      }),
      status: "revoked",
      createdAt: relationship.createdAt,
      updatedAt: now,
    };
    await this.deps.repository.appendAudit({
      kind: "household_custody_authority_revoked",
      ownerId: relationshipId,
      reason,
      inputs: { householdId, childEntityId, custodianEntityIds },
      decision: {
        revision,
        revisionSha256: baseline.revisionSha256,
        invalidatedProposalIds: invalidated.proposalIds,
      },
      actor: "user",
      createdAt: now,
    });
    return baseline;
  }

  async issueGrant(input: {
    householdId?: string;
    principalEntityId: string;
    role: HouseholdRole;
    subjectEntityIds: string[];
    scopes: HouseholdAccessScope[];
    issuedByEntityId: string;
    expiresAt?: string | null;
  }): Promise<HouseholdAccessGrant> {
    const householdId = householdNamespace(input.householdId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const issuedByEntityId = normalizeHouseholdIdentifier(
      input.issuedByEntityId,
      "issuedByEntityId",
    );
    const subjectEntityIds = normalizeHouseholdIdentifiers(
      input.subjectEntityIds,
      "subjectEntityIds",
    );
    await this.requireEntities([
      principalEntityId,
      issuedByEntityId,
      ...subjectEntityIds,
    ]);
    if (issuedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may issue access grants",
        "HOUSEHOLD_ACCESS_DENIED",
        { issuedByEntityId },
      );
    }
    const binding = await this.requireRoleBinding(
      principalEntityId,
      householdId,
      input.role,
    );
    const scopes = normalizeGrantScopes(input.role, input.scopes);
    if (input.role !== "owner") {
      const outsideRelationship = subjectEntityIds.filter(
        (subjectId) => !binding.subjectEntityIds.includes(subjectId),
      );
      if (outsideRelationship.length > 0) {
        throw new HouseholdCoordinationError(
          "Grant subjects must stay inside the principal's household relationship",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            principalEntityId,
            role: input.role,
            outsideRelationship,
          },
        );
      }
    }
    if (
      scopes.some((scope) => scope.startsWith("calendar.")) &&
      subjectEntityIds.length === 0 &&
      input.role !== "owner"
    ) {
      throw new HouseholdCoordinationError(
        "Calendar grants require at least one scoped household subject",
        "HOUSEHOLD_INVALID_CONTRACT",
        { principalEntityId },
      );
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const grant: HouseholdAccessGrant = {
      id: `hgrant_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      householdId,
      principalEntityId,
      relationshipId: binding.relationshipId,
      role: input.role,
      subjectEntityIds,
      scopes,
      issuedByEntityId,
      expiresAt: validateFutureExpiry(input.expiresAt, nowDate),
      revokedAt: null,
      revokedByEntityId: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repository.insertGrant(grant, {
      kind: "household_grant_issued",
      ownerId: grant.id,
      reason: "Owner granted explicit household access.",
      inputs: {
        principalEntityId: grant.principalEntityId,
        householdId,
        role: grant.role,
        subjectEntityIds: grant.subjectEntityIds,
      },
      decision: {
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
      },
      actor: "user",
      createdAt: now,
    });
    try {
      await ensureHouseholdGrantExpiryWarning({
        grant,
        repository: this.deps.repository,
        scheduledTasks: this.scheduledTasks(),
        now: nowDate,
      });
    } catch (error) {
      // error-policy:J1 boundary translation — grant issuance and its warning
      // intent commit atomically. The committed grant is authoritative while
      // startup reconciliation owns delivery, so returning it prevents a
      // caller retry from creating duplicate access.
      this.deps.runtime.reportError(
        "HouseholdCoordination.grantExpiryWarning",
        error,
        {
          grantId: grant.id,
          principalEntityId: grant.principalEntityId,
          expiresAt: grant.expiresAt,
          recovery: "startup_reconciliation",
        },
      );
    }
    return grant;
  }

  async revokeGrant(input: {
    householdId?: string;
    grantId: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdAccessGrant> {
    const grantId = normalizeHouseholdIdentifier(input.grantId, "grantId");
    const revokedByEntityId = normalizeHouseholdIdentifier(
      input.revokedByEntityId,
      "revokedByEntityId",
    );
    await this.requireEntity(revokedByEntityId);
    if (revokedByEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the household owner may revoke access grants",
        "HOUSEHOLD_ACCESS_DENIED",
        { revokedByEntityId },
      );
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new HouseholdCoordinationError(
        "Grant revocation requires a reason",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    const current = await this.deps.repository.getGrant(grantId);
    if (!current) {
      throw new HouseholdCoordinationError(
        `Grant ${grantId} is missing`,
        "HOUSEHOLD_GRANT_REVOKED",
        { grantId },
      );
    }
    this.requireHouseholdMatch(input.householdId, current.householdId, {
      grantId,
    });
    const grant = await this.deps.repository.revokeGrant({
      id: grantId,
      revokedAt: this.now().toISOString(),
      revokedByEntityId,
      reason,
    });
    try {
      await cancelHouseholdGrantExpiryWarning({
        grant,
        repository: this.deps.repository,
        scheduledTasks: this.scheduledTasks(),
        now: this.now(),
      });
    } catch (error) {
      // error-policy:J1 access revocation is already atomically committed with
      // a cancellation outbox intent. Surface the repair path without
      // pretending the access mutation rolled back or inviting a duplicate
      // revoke request.
      this.deps.runtime.reportError(
        "HouseholdCoordination.grantExpiryWarningCancellation",
        error,
        {
          grantId: grant.id,
          revokedAt: grant.revokedAt,
          recovery: "lifeops_scheduler_tick",
        },
      );
    }
    return grant;
  }

  private async grantIsActive(
    grant: HouseholdAccessGrant,
    at: Date,
  ): Promise<boolean> {
    if (grant.revokedAt) return false;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= at.getTime()) {
      return false;
    }
    if (grant.relationshipId) {
      const relationship = await this.deps.relationshipStore.get(
        grant.relationshipId,
      );
      if (!relationship) return false;
      if (relationship.status !== "active") return false;
      if (readRoleMetadata(relationship) !== grant.role) return false;
      if (readHouseholdIdMetadata(relationship) !== grant.householdId) {
        return false;
      }
      if (grant.role !== "owner") {
        const currentSubjects = readSubjectMetadata(relationship);
        if (
          grant.subjectEntityIds.some(
            (subjectId) => !currentSubjects.includes(subjectId),
          )
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Authorizes one exact persisted grant rather than allowing a different
   * grant for the same principal to satisfy a resource binding.
   */
  async requireGrantActive(input: {
    householdId?: string;
    grantId: string;
    principalEntityId: string;
    scope: HouseholdAccessScope;
    at?: Date;
  }): Promise<HouseholdAccessGrant> {
    const householdId = householdNamespace(input.householdId);
    const grantId = normalizeHouseholdIdentifier(input.grantId, "grantId");
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const grant = await this.deps.repository.getGrant(grantId);
    if (
      !grant ||
      grant.householdId !== householdId ||
      grant.principalEntityId !== principalEntityId ||
      !expandGrantScopes(grant.scopes).includes(input.scope)
    ) {
      throw new HouseholdCoordinationError(
        "The exact household grant does not authorize this resource",
        "HOUSEHOLD_ACCESS_DENIED",
        { householdId, grantId, principalEntityId, scope: input.scope },
      );
    }
    const at = input.at ?? this.now();
    if (await this.grantIsActive(grant, at)) return grant;
    if (grant.revokedAt) {
      throw new HouseholdCoordinationError(
        "Household access grant has been revoked",
        "HOUSEHOLD_GRANT_REVOKED",
        { householdId, grantId, principalEntityId, scope: input.scope },
      );
    }
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= at.getTime()) {
      throw new HouseholdCoordinationError(
        "Household access grant has expired",
        "HOUSEHOLD_GRANT_EXPIRED",
        { householdId, grantId, principalEntityId, scope: input.scope },
      );
    }
    throw new HouseholdCoordinationError(
      "Household access grant is no longer active",
      "HOUSEHOLD_ACCESS_DENIED",
      { householdId, grantId, principalEntityId, scope: input.scope },
    );
  }

  /** Owner inventory for permission selectors; no reconciliation or grant mutation. */
  async listActiveGrantsForOwner(input: {
    householdId: string;
    ownerEntityId: string;
    scope: HouseholdAccessScope;
  }): Promise<HouseholdAccessGrant[]> {
    if (input.ownerEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdCoordinationError(
        "Only the owner can list household permission choices",
        "HOUSEHOLD_ACCESS_DENIED",
      );
    }
    const householdId = householdNamespace(input.householdId);
    const grants = await this.deps.repository.listGrants(
      undefined,
      householdId,
    );
    const at = this.now();
    const active: HouseholdAccessGrant[] = [];
    for (const grant of grants) {
      if (
        expandGrantScopes(grant.scopes).includes(input.scope) &&
        (await this.grantIsActive(grant, at))
      )
        active.push(grant);
    }
    return active;
  }

  private async activeGrants(
    principalEntityId: string,
    householdId: string,
    at: Date,
  ): Promise<HouseholdAccessGrant[]> {
    const grants = await this.deps.repository.listGrants(
      principalEntityId,
      householdId,
    );
    const active: HouseholdAccessGrant[] = [];
    for (const grant of grants) {
      if (await this.grantIsActive(grant, at)) active.push(grant);
    }
    return active;
  }

  async requireScope(input: {
    householdId?: string;
    principalEntityId: string;
    scope: HouseholdAccessScope;
    subjectEntityId?: string;
    at?: Date;
  }): Promise<void> {
    const householdId = householdNamespace(input.householdId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const subjectEntityId =
      input.subjectEntityId === undefined
        ? undefined
        : normalizeHouseholdIdentifier(
            input.subjectEntityId,
            "subjectEntityId",
          );
    if (principalEntityId === SELF_ENTITY_ID) {
      await this.requireEntity(SELF_ENTITY_ID);
      return;
    }
    await this.requireEntity(principalEntityId);
    const at = input.at ?? this.now();
    const grants = await this.deps.repository.listGrants(
      principalEntityId,
      householdId,
    );
    const matching = grants.filter(
      (grant) =>
        expandGrantScopes(grant.scopes).includes(input.scope) &&
        (subjectEntityId === undefined ||
          grant.subjectEntityIds.includes(subjectEntityId)),
    );
    for (const grant of matching) {
      if (await this.grantIsActive(grant, at)) return;
    }
    if (matching.some((grant) => grant.revokedAt !== null)) {
      throw new HouseholdCoordinationError(
        "Household access grant has been revoked",
        "HOUSEHOLD_GRANT_REVOKED",
        {
          principalEntityId,
          householdId,
          scope: input.scope,
          subjectEntityId,
        },
      );
    }
    if (
      matching.some(
        (grant) =>
          grant.expiresAt !== null &&
          Date.parse(grant.expiresAt) <= at.getTime(),
      )
    ) {
      throw new HouseholdCoordinationError(
        "Household access grant has expired",
        "HOUSEHOLD_GRANT_EXPIRED",
        {
          principalEntityId,
          householdId,
          scope: input.scope,
          subjectEntityId,
        },
      );
    }
    throw new HouseholdCoordinationError(
      "Household access scope is not granted",
      "HOUSEHOLD_ACCESS_DENIED",
      {
        principalEntityId,
        householdId,
        scope: input.scope,
        subjectEntityId,
      },
    );
  }

  /**
   * Approval authority is revocable after a proposal is issued. A responder
   * keeps standing either intrinsically — an active owner, co-parent, or
   * current-partner binding that still covers every affected child — or by
   * delegation through an active `schedule.approve` grant covering those
   * children. Caregiver and professional bindings identify household context
   * but deliberately do not confer approval standing without a revocable
   * grant. Without this
   * check, removing an adult from the household (or narrowing their
   * relationship to a child) would leave their queued approval requests
   * actionable.
   */
  private async requireApprovalStanding(
    proposal: HouseholdScheduleProposal,
    partyEntityId: string,
  ): Promise<void> {
    if (partyEntityId === SELF_ENTITY_ID) return;
    const bindings = await this.listRoleBindings(proposal.householdId);
    const binding = bindings.find(
      (candidate) => candidate.entityId === partyEntityId,
    );
    const childEntityIds = proposal.terms.childEntityIds;
    if (
      binding &&
      (binding.role === "owner" ||
        binding.role === "co_parent" ||
        binding.role === "current_partner")
    ) {
      const uncovered =
        binding.role === "owner"
          ? []
          : childEntityIds.filter(
              (childEntityId) =>
                !binding.subjectEntityIds.includes(childEntityId),
            );
      if (uncovered.length === 0) return;
    }
    if (childEntityIds.length === 0) {
      await this.requireScope({
        principalEntityId: partyEntityId,
        householdId: proposal.householdId,
        scope: "schedule.approve",
      });
      return;
    }
    for (const subjectEntityId of childEntityIds) {
      await this.requireScope({
        principalEntityId: partyEntityId,
        householdId: proposal.householdId,
        scope: "schedule.approve",
        subjectEntityId,
      });
    }
  }

  private async bindCurrentCustodyAuthorityRevision(
    householdId: string,
    terms: HouseholdScheduleTerms,
  ): Promise<HouseholdScheduleTerms> {
    if (!terms.custodyException) return terms;
    const authority = await this.requireCustodyAuthority(
      householdId,
      terms.custodyException,
    );
    return {
      ...terms,
      custodyException: {
        ...terms.custodyException,
        authorityBaselineRevisionSha256: authority.revisionSha256,
      },
    };
  }

  private async validateProposalParties(input: {
    householdId: string;
    terms: HouseholdScheduleTerms;
    affectedPartyEntityIds: string[];
    requiredApproverEntityIds: string[];
    createdByEntityId: string;
  }): Promise<{
    affectedPartyEntityIds: string[];
    requiredApproverEntityIds: string[];
  }> {
    const householdId = householdNamespace(input.householdId);
    const custody = input.terms.custodyException;
    const custodyParties = custody
      ? [custody.normalCustodianEntityId, custody.substituteCustodianEntityId]
      : [];
    const createdByEntityId = normalizeHouseholdIdentifier(
      input.createdByEntityId,
      "createdByEntityId",
    );
    const explicitlyAffectedEntityIds = normalizeHouseholdIdentifiers(
      [...input.affectedPartyEntityIds, ...input.terms.childEntityIds],
      "affectedPartyEntityIds",
    );
    const requestedApproverEntityIds = normalizeHouseholdIdentifiers(
      input.requiredApproverEntityIds,
      "requiredApproverEntityIds",
    );
    const normalizedCustodyParties = normalizeHouseholdIdentifiers(
      custodyParties,
      "custodyApproverEntityIds",
    );
    await this.requireEntities([
      createdByEntityId,
      ...input.terms.childEntityIds,
      ...explicitlyAffectedEntityIds,
      ...requestedApproverEntityIds,
      ...normalizedCustodyParties,
    ]);
    if (custody) await this.requireCustodyAuthority(householdId, custody);
    for (const childEntityId of input.terms.childEntityIds) {
      await this.requireRoleBinding(childEntityId, householdId, "child");
    }
    const affectedAdultEntityIds: string[] = [];
    for (const entityId of explicitlyAffectedEntityIds) {
      const binding = await this.requireRoleBinding(entityId, householdId);
      if (binding.role !== "child") affectedAdultEntityIds.push(entityId);
    }
    const requiredApproverEntityIds = uniqueStrings([
      ...requestedApproverEntityIds,
      ...normalizedCustodyParties,
      ...affectedAdultEntityIds,
    ]);
    if (requiredApproverEntityIds.length === 0) {
      throw new HouseholdCoordinationError(
        "At least one affected adult must approve a household proposal",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    const affectedPartyEntityIds = uniqueStrings([
      ...explicitlyAffectedEntityIds,
      ...requiredApproverEntityIds,
    ]);
    for (const approverEntityId of requiredApproverEntityIds) {
      const binding = await this.requireRoleBinding(
        approverEntityId,
        householdId,
      );
      if (binding.role === "child") {
        throw new HouseholdCoordinationError(
          "Child household members cannot be required approvers",
          "HOUSEHOLD_INVALID_CONTRACT",
          { approverEntityId },
        );
      }
      const outsideRelationship =
        binding.role === "owner"
          ? []
          : input.terms.childEntityIds.filter(
              (childEntityId) =>
                !binding.subjectEntityIds.includes(childEntityId),
            );
      if (outsideRelationship.length > 0) {
        throw new HouseholdCoordinationError(
          "Household approvers must have an explicit relationship to every affected child",
          "HOUSEHOLD_ACCESS_DENIED",
          {
            approverEntityId,
            outsideRelationship,
          },
        );
      }
    }
    const mutationSubjects =
      input.terms.childEntityIds.length > 0
        ? input.terms.childEntityIds
        : affectedPartyEntityIds.filter(
            (entityId) => entityId !== createdByEntityId,
          );
    // Proposing is a distinct, weaker authority than mutating: schedule
    // changes only ever land through the approval workflow, so a proposer
    // needs `schedule.propose` (implied by `calendar.mutate` for existing
    // grants) rather than direct mutation authority.
    if (createdByEntityId !== SELF_ENTITY_ID && mutationSubjects.length === 0) {
      await this.requireScope({
        principalEntityId: createdByEntityId,
        householdId,
        scope: "schedule.propose",
      });
    }
    for (const subjectEntityId of mutationSubjects) {
      await this.requireScope({
        principalEntityId: createdByEntityId,
        householdId,
        scope: "schedule.propose",
        subjectEntityId,
      });
    }
    return { affectedPartyEntityIds, requiredApproverEntityIds };
  }

  /**
   * A channel that delegates delivery to a connector (`connectorKind` set,
   * as every default-pack channel does) can only reach the party while that
   * connector is registered, send-capable, and not reporting `disconnected`.
   * Without this gate a dead higher-preference route shadows a live
   * lower-preference one and the prompt parks in a send failure instead of
   * reaching the party. Channels with `connectorKind: null` own their
   * transport, so their advertised `send` is trusted as-is.
   */
  private async partyRouteIsLive(
    channel: ChannelContribution,
    partyEntityId: string,
  ): Promise<boolean> {
    const connectorKind = channel.connectorKind;
    if (!connectorKind) return true;
    const connector = getConnectorRegistry(this.deps.runtime)?.get(
      connectorKind,
    );
    if (!connector?.send) return false;
    try {
      const status = await connector.status();
      return status.state !== "disconnected";
    } catch (error) {
      // error-policy:J7 a failed liveness probe is itself the dead-route
      // signal; it must not strand the remaining parties' approvals. The
      // failure is surfaced via reportError and the resolver moves on to the
      // party's next verified route (or the owner-relay fallback).
      this.deps.runtime.reportError(
        "HouseholdCoordination.partyRouteProbe",
        error,
        { channel: channel.kind, connectorKind, partyEntityId },
      );
      return false;
    }
  }

  /**
   * Resolve the connector route that can reach an affected party: the first
   * preference-ordered send-capable registered channel on which the party has
   * an operator-verified identity and whose backing connector is live
   * ({@link partyRouteIsLive}). The owner needs no route — the internal
   * approval surfaces (task, notification, chat choice) already reach them.
   * A party with no live route resolves to null and stays reachable through
   * the owner-relay fallback in {@link enqueueApprovals}.
   */
  private async resolvePartyContactRoute(
    partyEntityId: string,
  ): Promise<PartyApprovalContactRoute | null> {
    if (partyEntityId === SELF_ENTITY_ID) return null;
    const registry = getChannelRegistry(this.deps.runtime);
    if (!registry) return null;
    const entity = await this.deps.entityStore.get(partyEntityId);
    const verified =
      entity?.identities.filter((identity) => identity.verified) ?? [];
    if (verified.length === 0) return null;
    for (const route of PARTY_CONTACT_ROUTES) {
      const channel = registry.get(route.channel);
      const send = channel?.send;
      if (!channel || !send) continue;
      const identity = route.platforms
        .map((platform) =>
          verified.find(
            (candidate) => candidate.platform.trim().toLowerCase() === platform,
          ),
        )
        .find((match) => match !== undefined);
      if (!identity) continue;
      if (!(await this.partyRouteIsLive(channel, partyEntityId))) continue;
      return {
        channel: route.channel,
        target: identity.handle,
        ...(route.targetKind ? { targetKind: route.targetKind } : {}),
        platform: identity.platform.trim().toLowerCase(),
        send,
      };
    }
    return null;
  }

  /**
   * Send the affected party the approval request over their contact route,
   * teaching the exact command `parseHouseholdInboundApprovalCommand`
   * accepts. The durable approval row is the source of truth: a failed send
   * leaves the request pending and owner-visible, and the failure is raised
   * through reportError so the agent can repair the connector or relay the
   * request instead of the loop dying silently.
   */
  private async deliverPartyApprovalPrompt(input: {
    proposal: HouseholdScheduleProposal;
    partyEntityId: string;
    request: ApprovalRequest;
    route: PartyApprovalContactRoute;
  }): Promise<void> {
    const context = {
      approvalRequestId: input.request.id,
      proposalId: input.proposal.proposalId,
      proposalVersion: input.proposal.version,
      partyEntityId: input.partyEntityId,
      channel: input.route.channel,
    };
    const prompt = householdApprovalRequestPrompt({
      approvalRequestId: input.request.id,
      reason: input.request.reason,
    });
    try {
      const result = await input.route.send({
        target: input.route.target,
        // Discord routes target the party's verified USER id; the typed kind
        // makes the connector resolve a DM instead of misreading the id as a
        // channel (see PARTY_CONTACT_ROUTES).
        ...(input.route.targetKind
          ? { targetKind: input.route.targetKind }
          : {}),
        message: prompt,
        metadata: {
          workflowId: HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID,
          ...context,
        },
      });
      if (!result.ok) {
        this.deps.runtime.reportError(
          "HouseholdCoordination.partyApprovalDelivery",
          new HouseholdCoordinationError(
            `Affected-party approval prompt was not accepted by ${input.route.channel}: ${result.reason}`,
            "HOUSEHOLD_PARTY_APPROVAL_UNDELIVERED",
            { ...context, reason: result.reason },
          ),
          { ...context, reason: result.reason },
        );
      }
    } catch (error) {
      // error-policy:J7 the pending approval row stays owner-visible and the
      // party can still be reached by owner relay; a thrown connector failure
      // must not strand the remaining parties' prompts, so it is raised via
      // reportError (RECENT_ERRORS + owner escalation) instead of rethrown.
      this.deps.runtime.reportError(
        "HouseholdCoordination.partyApprovalDelivery",
        error,
        context,
      );
    }
  }

  private async enqueueApprovals(proposal: HouseholdScheduleProposal): Promise<{
    approvals: HouseholdProposalApproval[];
    insertedApprovalLinkIds: string[];
  }> {
    const existing = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const approvals: HouseholdProposalApproval[] = [];
    const insertedApprovalLinkIds: string[] = [];
    for (const partyEntityId of proposal.requiredApproverEntityIds) {
      const existingApproval = existing.find(
        (candidate) =>
          candidate.partyEntityId === partyEntityId &&
          candidate.invalidatedAt === null,
      );
      if (existingApproval) {
        approvals.push(existingApproval);
        continue;
      }
      const route = await this.resolvePartyContactRoute(partyEntityId);
      const request = await this.deps.approvalQueue.enqueue({
        idempotencyKey: approvalIdempotencyKey(proposal, partyEntityId),
        requestedBy: proposal.createdByEntityId,
        subjectUserId: partyEntityId,
        action: "execute_workflow",
        payload: {
          action: "execute_workflow",
          workflowId: HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID,
          input: {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            householdId: proposal.householdId,
            coordinationId: proposal.coordinationId,
            partyEntityId,
            contentSha256: proposal.contentSha256,
          },
        },
        channel: route?.channel ?? "internal",
        reason: `Approve household schedule proposal ${proposal.proposalId} v${proposal.version}`,
        expiresAt: new Date(
          proposal.expiresAt ??
            new Date(
              Date.parse(proposal.createdAt) + DEFAULT_PROPOSAL_TTL_MS,
            ).toISOString(),
        ),
      });
      const now = this.now().toISOString();
      const approval: HouseholdProposalApproval = {
        id: `happroval_${crypto.randomUUID()}`,
        agentId: this.deps.agentId,
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId,
        approvalRequestId: request.id,
        invalidatedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const persisted = await this.deps.repository.insertApprovalLink(approval);
      approvals.push(persisted);
      insertedApprovalLinkIds.push(persisted.id);
      if (route) {
        await this.deliverPartyApprovalPrompt({
          proposal,
          partyEntityId,
          request,
          route,
        });
      } else if (partyEntityId !== SELF_ENTITY_ID) {
        this.deps.runtime.reportError(
          "HouseholdCoordination.partyApprovalDelivery",
          new HouseholdCoordinationError(
            "No verified contact route can deliver this affected-party approval request; the party cannot answer until a connector identity is verified or the owner relays the command.",
            "HOUSEHOLD_PARTY_APPROVAL_UNROUTABLE",
            {
              approvalRequestId: request.id,
              proposalId: proposal.proposalId,
              proposalVersion: proposal.version,
              partyEntityId,
            },
          ),
          {
            approvalRequestId: request.id,
            proposalId: proposal.proposalId,
            partyEntityId,
          },
        );
      }
    }
    return { approvals, insertedApprovalLinkIds };
  }

  async ensureProposalApprovals(
    proposalId: string,
    proposalVersion: number,
    householdId?: string,
  ): Promise<HouseholdProposalApproval[]> {
    return (
      await this.ensureProposalApprovalsWithDisposition(
        proposalId,
        proposalVersion,
        householdId,
      )
    ).approvals;
  }

  async ensureProposalApprovalsWithDisposition(
    proposalId: string,
    proposalVersion: number,
    householdId?: string,
  ): Promise<{
    approvals: HouseholdProposalApproval[];
    insertedApprovalLinkIds: string[];
  }> {
    const normalizedProposalId = normalizeHouseholdIdentifier(
      proposalId,
      "proposalId",
    );
    const normalizedProposalVersion = nonNegativeInteger(
      proposalVersion,
      "proposalVersion",
      1,
    );
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      normalizedProposalId,
      normalizedProposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${normalizedProposalId} v${normalizedProposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId: normalizedProposalId,
          proposalVersion: normalizedProposalVersion,
        },
      );
    }
    this.requireHouseholdMatch(householdId, proposal.householdId, {
      proposalId: normalizedProposalId,
      proposalVersion: normalizedProposalVersion,
    });
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal ${normalizedProposalId} v${normalizedProposalVersion} is ${proposal.status}`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: normalizedProposalId,
          proposalVersion: normalizedProposalVersion,
          status: proposal.status,
        },
      );
    }
    return await this.enqueueApprovals(proposal);
  }

  async createProposal(
    input: CreateHouseholdProposalInput,
  ): Promise<HouseholdScheduleProposal> {
    const householdId = householdNamespace(input.householdId);
    const terms = await this.bindCurrentCustodyAuthorityRevision(
      householdId,
      normalizeScheduleTerms(input.terms),
    );
    const createdByEntityId = normalizeHouseholdIdentifier(
      input.createdByEntityId,
      "createdByEntityId",
    );
    const parties = await this.validateProposalParties({
      householdId,
      terms,
      affectedPartyEntityIds: input.affectedPartyEntityIds,
      requiredApproverEntityIds: input.requiredApproverEntityIds,
      createdByEntityId,
    });
    const coordinationId = normalizeHouseholdIdentifier(
      input.coordinationId,
      "coordinationId",
    );
    const proposalId =
      input.proposalId === undefined
        ? `hproposal_${crypto.randomUUID()}`
        : normalizeHouseholdIdentifier(input.proposalId, "proposalId");
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const head = await this.deps.repository.ensureHead(
      householdId,
      coordinationId,
      now,
    );
    const baseAgreementVersion =
      input.baseAgreementVersion === undefined
        ? head.currentAgreementVersion
        : nonNegativeInteger(
            input.baseAgreementVersion,
            "baseAgreementVersion",
          );
    if (baseAgreementVersion !== head.currentAgreementVersion) {
      throw new HouseholdCoordinationError(
        "Proposal baseAgreementVersion does not match the current agreement",
        "HOUSEHOLD_STALE_BASE_AGREEMENT",
        {
          coordinationId,
          baseAgreementVersion,
          currentAgreementVersion: head.currentAgreementVersion,
        },
      );
    }
    const proposalContent: Omit<
      HouseholdScheduleProposal,
      "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
    > = {
      proposalId,
      agentId: this.deps.agentId,
      householdId,
      version: 1,
      coordinationId,
      baseAgreementVersion,
      terms,
      affectedPartyEntityIds: parties.affectedPartyEntityIds,
      requiredApproverEntityIds: parties.requiredApproverEntityIds,
      createdByEntityId,
      expiresAt: proposalExpiry(input.expiresAt, nowDate),
    };
    const proposal: HouseholdScheduleProposal = {
      ...proposalContent,
      contentSha256: proposalContentSha256(proposalContent),
      status: "pending",
      materialChange: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repository.insertProposal(proposal, {
      kind: "household_proposal_created",
      ownerId: proposal.proposalId,
      reason: "Household schedule proposal created for affected-party review.",
      inputs: {
        proposalVersion: proposal.version,
        householdId,
        coordinationId: proposal.coordinationId,
        affectedPartyEntityIds: proposal.affectedPartyEntityIds,
        createdByEntityId: proposal.createdByEntityId,
      },
      decision: {
        baseAgreementVersion: proposal.baseAgreementVersion,
        requiredApproverEntityIds: proposal.requiredApproverEntityIds,
        contentSha256: proposal.contentSha256,
      },
      actor: "user",
      createdAt: now,
    });
    try {
      await this.enqueueApprovals(proposal);
    } catch (error) {
      // error-policy:J2 The proposal is durable; surface its identity so the
      // boundary can call ensureProposalApprovals without recreating it.
      throw new HouseholdCoordinationError(
        `Proposal ${proposal.proposalId} persisted but its approval requests could not be completed`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
        },
        error,
      );
    }
    return proposal;
  }

  async reviseProposal(
    input: ReviseHouseholdProposalInput,
  ): Promise<HouseholdScheduleProposal> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const expectedVersion = nonNegativeInteger(
      input.expectedVersion,
      "expectedVersion",
      1,
    );
    const revisedByEntityId = normalizeHouseholdIdentifier(
      input.revisedByEntityId,
      "revisedByEntityId",
    );
    await this.reconcilePersistedApprovalInvalidations();
    const previous = await this.deps.repository.getProposal(proposalId);
    if (!previous) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        { proposalId },
      );
    }
    this.requireHouseholdMatch(input.householdId, previous.householdId, {
      proposalId,
      proposalVersion: previous.version,
    });
    if (previous.version !== expectedVersion || previous.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} changed concurrently`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          expectedVersion,
          actualVersion: previous.version,
          status: previous.status,
        },
      );
    }
    if (await this.expireProposalIfLapsed(previous, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: previous.proposalId,
          proposalVersion: previous.version,
          expiresAt: previous.expiresAt,
        },
      );
    }
    if (previous.createdByEntityId !== revisedByEntityId) {
      await this.requireScope({
        principalEntityId: revisedByEntityId,
        householdId: previous.householdId,
        scope: "schedule.propose",
        subjectEntityId: previous.terms.childEntityIds[0],
      });
    }
    const terms = await this.bindCurrentCustodyAuthorityRevision(
      previous.householdId,
      normalizeScheduleTerms(input.terms),
    );
    const parties = await this.validateProposalParties({
      householdId: previous.householdId,
      terms,
      affectedPartyEntityIds: input.affectedPartyEntityIds,
      requiredApproverEntityIds: input.requiredApproverEntityIds,
      createdByEntityId: revisedByEntityId,
    });
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const materialChange =
      materialScheduleFingerprint(previous.terms) !==
        materialScheduleFingerprint(terms) ||
      JSON.stringify(previous.affectedPartyEntityIds) !==
        JSON.stringify(parties.affectedPartyEntityIds) ||
      JSON.stringify(previous.requiredApproverEntityIds) !==
        JSON.stringify(parties.requiredApproverEntityIds);
    const nextContent: Omit<
      HouseholdScheduleProposal,
      "contentSha256" | "status" | "materialChange" | "createdAt" | "updatedAt"
    > = {
      ...previous,
      version: previous.version + 1,
      terms,
      affectedPartyEntityIds: parties.affectedPartyEntityIds,
      requiredApproverEntityIds: parties.requiredApproverEntityIds,
      createdByEntityId: revisedByEntityId,
      expiresAt: proposalExpiry(input.expiresAt, nowDate),
    };
    const next: HouseholdScheduleProposal = {
      ...nextContent,
      contentSha256: proposalContentSha256(nextContent),
      status: "pending",
      materialChange,
      createdAt: now,
      updatedAt: now,
    };
    const invalidated = await this.deps.repository.reviseProposal(
      previous,
      next,
    );
    await this.terminallyInvalidateApprovalRequests(
      invalidated,
      `superseded household proposal ${previous.proposalId} v${previous.version}`,
    );
    try {
      await this.enqueueApprovals(next);
    } catch (error) {
      // error-policy:J2 The revision is durable and older approval bytes are
      // invalid, so expose the exact retry identity instead of rolling back.
      throw new HouseholdCoordinationError(
        `Proposal ${next.proposalId} v${next.version} persisted but its approval requests could not be completed`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: next.proposalId,
          proposalVersion: next.version,
        },
        error,
      );
    }
    return next;
  }

  async respondToProposal(input: {
    proposalId: string;
    proposalVersion: number;
    partyEntityId: string;
    approvalRequestId: string;
    decision: "approve" | "reject";
    reason: string;
  }): Promise<ApprovalRequest> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const proposalVersion = nonNegativeInteger(
      input.proposalVersion,
      "proposalVersion",
      1,
    );
    const partyEntityId = normalizeHouseholdIdentifier(
      input.partyEntityId,
      "partyEntityId",
    );
    const approvalRequestId = normalizeHouseholdIdentifier(
      input.approvalRequestId,
      "approvalRequestId",
    );
    const reason = input.reason.trim();
    if (!reason) {
      throw new HouseholdCoordinationError(
        "Household proposal responses require an auditable reason",
        "HOUSEHOLD_INVALID_CONTRACT",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
        },
      );
    }
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      proposalId,
      proposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} v${proposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId,
          proposalVersion,
        },
      );
    }
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal is ${proposal.status}, not pending`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          status: proposal.status,
        },
      );
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposalId,
      proposalVersion,
    );
    const link = links.find(
      (candidate) => candidate.partyEntityId === partyEntityId,
    );
    if (
      !link ||
      link.invalidatedAt ||
      link.approvalRequestId !== approvalRequestId
    ) {
      throw new HouseholdCoordinationError(
        "Approval is missing or no longer valid for this proposal version",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
          approvalRequestId,
        },
      );
    }
    const request = await this.deps.approvalQueue.byId(
      approvalRequestId,
      partyEntityId,
    );
    if (
      !request ||
      request.subjectUserId !== partyEntityId ||
      !approvalPayloadMatches(request, proposal, partyEntityId)
    ) {
      throw new HouseholdCoordinationError(
        "Approval request does not match the exact household proposal and party",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId,
          proposalVersion,
          partyEntityId,
          approvalRequestId,
        },
      );
    }
    await this.requireApprovalStanding(proposal, partyEntityId);
    const resolution = {
      resolvedBy: partyEntityId,
      resolutionReason: reason,
    };
    if (input.decision === "approve") {
      return await this.deps.approvalQueue.approve(
        approvalRequestId,
        partyEntityId,
        resolution,
      );
    }
    const rejectedRequest = await this.deps.approvalQueue.reject(
      approvalRequestId,
      partyEntityId,
      resolution,
    );
    const invalidated = await this.deps.repository.rejectProposal({
      proposalId,
      proposalVersion,
      partyEntityId,
      reason,
      rejectedAt: this.now().toISOString(),
    });
    await this.terminallyInvalidateApprovalRequests(
      invalidated,
      `rejected household proposal ${proposalId} v${proposalVersion}`,
    );
    return rejectedRequest;
  }

  private async verifyExactApprovals(
    proposal: HouseholdScheduleProposal,
  ): Promise<string[]> {
    const actualContentSha256 = proposalContentSha256(proposal);
    if (actualContentSha256 !== proposal.contentSha256) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposal.proposalId} v${proposal.version} content no longer matches its approval hash`,
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          approvedContentSha256: proposal.contentSha256,
          actualContentSha256,
        },
      );
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const approvedBy: string[] = [];
    for (const partyEntityId of proposal.requiredApproverEntityIds) {
      const link = links.find(
        (candidate) => candidate.partyEntityId === partyEntityId,
      );
      if (!link || link.invalidatedAt) {
        throw new HouseholdCoordinationError(
          `Approval for ${partyEntityId} is missing or invalidated`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
          },
        );
      }
      const request = await this.deps.approvalQueue.byId(
        link.approvalRequestId,
        link.partyEntityId,
      );
      if (!request) {
        throw new HouseholdCoordinationError(
          `Approval request ${link.approvalRequestId} is missing`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
            approvalRequestId: link.approvalRequestId,
          },
        );
      }
      if (
        request.state !== "approved" ||
        request.resolvedBy !== partyEntityId ||
        !approvalPayloadMatches(request, proposal, partyEntityId)
      ) {
        throw new HouseholdCoordinationError(
          `Approval for ${partyEntityId} does not match proposal ${proposal.proposalId} v${proposal.version}`,
          "HOUSEHOLD_STALE_APPROVAL",
          {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
            approvalRequestId: link.approvalRequestId,
            approvalState: request?.state,
          },
        );
      }
      approvedBy.push(partyEntityId);
    }
    return uniqueStrings(approvedBy);
  }

  async finalizeProposal(input: {
    householdId?: string;
    proposalId: string;
    proposalVersion: number;
  }): Promise<HouseholdScheduleAgreement> {
    const proposalId = normalizeHouseholdIdentifier(
      input.proposalId,
      "proposalId",
    );
    const proposalVersion = nonNegativeInteger(
      input.proposalVersion,
      "proposalVersion",
      1,
    );
    await this.reconcilePersistedApprovalInvalidations();
    const proposal = await this.deps.repository.getProposal(
      proposalId,
      proposalVersion,
    );
    if (!proposal) {
      throw new HouseholdCoordinationError(
        `Proposal ${proposalId} v${proposalVersion} was not found`,
        "HOUSEHOLD_PROPOSAL_NOT_FOUND",
        {
          proposalId,
          proposalVersion,
        },
      );
    }
    this.requireHouseholdMatch(input.householdId, proposal.householdId, {
      proposalId,
      proposalVersion,
    });
    if (proposal.status !== "pending") {
      throw new HouseholdCoordinationError(
        `Proposal is ${proposal.status}, not pending`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          status: proposal.status,
        },
      );
    }
    if (await this.expireProposalIfLapsed(proposal, this.now())) {
      throw new HouseholdCoordinationError(
        "Proposal approval window has expired",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    const currentParties = await this.validateProposalParties({
      householdId: proposal.householdId,
      terms: proposal.terms,
      affectedPartyEntityIds: proposal.affectedPartyEntityIds,
      requiredApproverEntityIds: proposal.requiredApproverEntityIds,
      createdByEntityId: proposal.createdByEntityId,
    });
    if (
      JSON.stringify(currentParties.affectedPartyEntityIds) !==
        JSON.stringify(proposal.affectedPartyEntityIds) ||
      JSON.stringify(currentParties.requiredApproverEntityIds) !==
        JSON.stringify(proposal.requiredApproverEntityIds)
    ) {
      throw new HouseholdCoordinationError(
        "Household roles or affected-party scope changed after approval bytes were issued",
        "HOUSEHOLD_STALE_APPROVAL",
        {
          proposalId: proposal.proposalId,
          proposalVersion: proposal.version,
          householdId: proposal.householdId,
        },
      );
    }
    const approvedByEntityIds = await this.verifyExactApprovals(proposal);
    const head = await this.deps.repository.getHead(
      proposal.householdId,
      proposal.coordinationId,
    );
    if (!head) {
      throw new HouseholdCoordinationError(
        `Coordination ${proposal.coordinationId} was not found`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        { coordinationId: proposal.coordinationId },
      );
    }
    if (head.currentAgreementVersion !== proposal.baseAgreementVersion) {
      throw new HouseholdCoordinationError(
        "Proposal was approved against a stale agreement version",
        "HOUSEHOLD_STALE_BASE_AGREEMENT",
        {
          coordinationId: proposal.coordinationId,
          baseAgreementVersion: proposal.baseAgreementVersion,
          currentAgreementVersion: head.currentAgreementVersion,
        },
      );
    }
    const activatedAt = this.now().toISOString();
    const agreement: HouseholdScheduleAgreement = {
      id: `hagreement_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      householdId: proposal.householdId,
      coordinationId: proposal.coordinationId,
      version: head.currentAgreementVersion + 1,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      terms: proposal.terms,
      affectedPartyEntityIds: proposal.affectedPartyEntityIds,
      approvedByEntityIds,
      activatedAt,
      createdAt: activatedAt,
      isCurrent: true,
    };
    const commitment = createLifeOpsCommitmentLedgerRecord({
      agentId: this.deps.agentId,
      source: "chat",
      sourceKey: agreement.id,
      kind: "commitment",
      summary: agreement.terms.summary,
      counterparty: approvedByEntityIds.join(", "),
      dueAt: agreement.terms.startAt,
      confidence: 1,
      metadata: {
        householdAgreementId: agreement.id,
        householdId: agreement.householdId,
        householdAgreementVersion: agreement.version,
        householdCoordinationId: agreement.coordinationId,
        affectedPartyEntityIds: agreement.affectedPartyEntityIds,
      },
      createdAt: activatedAt,
      updatedAt: activatedAt,
    });
    const activation = await this.deps.repository.activateAgreement(
      agreement,
      commitment,
    );
    await this.terminallyInvalidateApprovalRequests(
      activation.invalidatedApprovals,
      `competing proposals invalidated by agreement ${agreement.id}`,
    );
    return agreement;
  }

  private scopesForSchedule(
    principalEntityId: string,
    activeGrants: readonly HouseholdAccessGrant[],
    scheduleSubjectEntityIds: readonly string[],
  ): HouseholdAccessScope[] {
    if (principalEntityId === SELF_ENTITY_ID) {
      return [...HOUSEHOLD_ACCESS_SCOPES];
    }
    const relevant = activeGrants.filter((grant) =>
      grant.subjectEntityIds.some((subjectId) =>
        scheduleSubjectEntityIds.includes(subjectId),
      ),
    );
    return HOUSEHOLD_ACCESS_SCOPES.filter((scope) => {
      const scopedGrants = relevant.filter((grant) =>
        expandGrantScopes(grant.scopes).includes(scope),
      );
      if (scopedGrants.length === 0) return false;
      if (scope === "household.visibility" || scope === "calendar.freebusy") {
        return true;
      }
      return scheduleSubjectEntityIds.every((subjectId) =>
        scopedGrants.some((grant) =>
          grant.subjectEntityIds.includes(subjectId),
        ),
      );
    });
  }

  async exportFor(input: {
    householdId?: string;
    principalEntityId: string;
    at?: Date;
  }): Promise<HouseholdScopedExport> {
    const householdId = householdNamespace(input.householdId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    await this.requireEntity(principalEntityId);
    const serviceNow = this.now();
    const at = input.at ?? serviceNow;
    await this.reconcilePersistedApprovalInvalidations();
    const isOwner = principalEntityId === SELF_ENTITY_ID;
    const allGrants = await this.deps.repository.listGrants(
      undefined,
      householdId,
    );
    const activeGrants = isOwner
      ? allGrants
      : await this.activeGrants(principalEntityId, householdId, at);
    const ownActiveGrants = isOwner
      ? activeGrants
      : activeGrants.filter(
          (grant) => grant.principalEntityId === principalEntityId,
        );
    const effectiveScopes = isOwner
      ? [...HOUSEHOLD_ACCESS_SCOPES]
      : HOUSEHOLD_ACCESS_SCOPES.filter((scope) =>
          ownActiveGrants.some((grant) =>
            expandGrantScopes(grant.scopes).includes(scope),
          ),
        );
    const allRoles = await this.listRoleBindings(householdId);
    let proposals = await this.deps.repository.listProposals(householdId);
    let latestProposals = latestProposalVersions(proposals);
    let expiredAny = false;
    for (const proposal of latestProposals) {
      if (await this.expireProposalIfLapsed(proposal, serviceNow)) {
        expiredAny = true;
      }
    }
    if (expiredAny) {
      proposals = await this.deps.repository.listProposals(householdId);
      latestProposals = latestProposalVersions(proposals);
    }
    const agreements = await this.deps.repository.listAgreements(householdId);
    const visibleSubjectEntityIds = isOwner
      ? uniqueStrings(
          [
            ...allGrants.flatMap((grant) => [
              grant.principalEntityId,
              ...grant.subjectEntityIds,
            ]),
            ...allRoles.flatMap((binding) => [
              binding.entityId,
              ...binding.subjectEntityIds,
            ]),
            ...latestProposals.flatMap(
              (proposal) => proposal.affectedPartyEntityIds,
            ),
            ...agreements.flatMap(
              (agreement) => agreement.affectedPartyEntityIds,
            ),
          ].filter((entityId) => entityId !== SELF_ENTITY_ID),
        )
      : uniqueStrings(
          ownActiveGrants.flatMap((grant) => grant.subjectEntityIds),
        );
    await this.deps.repository.appendAudit({
      kind: "household_export_read",
      ownerId: principalEntityId,
      reason: "Household state exported under current grants.",
      inputs: {
        principalEntityId,
        householdId,
        visibleSubjectEntityIds,
      },
      decision: { effectiveScopes },
      actor: "user",
      createdAt: this.now().toISOString(),
    });

    const roles = effectiveScopes.includes("household.visibility")
      ? allRoles.filter(
          (binding) =>
            isOwner ||
            binding.entityId === principalEntityId ||
            visibleSubjectEntityIds.includes(binding.entityId),
        )
      : [];

    const schedules: HouseholdExportScheduleEntry[] = [];
    for (const proposal of latestProposals) {
      if (
        proposal.status !== "pending" ||
        (!isOwner &&
          !proposal.affectedPartyEntityIds.includes(principalEntityId) &&
          !proposal.affectedPartyEntityIds.some((entityId) =>
            visibleSubjectEntityIds.includes(entityId),
          ))
      ) {
        continue;
      }
      const scopes = this.scopesForSchedule(
        principalEntityId,
        ownActiveGrants,
        proposal.terms.childEntityIds.length > 0
          ? proposal.terms.childEntityIds
          : proposal.affectedPartyEntityIds,
      );
      if (!scopes.includes("calendar.freebusy")) continue;
      schedules.push({
        householdId,
        coordinationId: proposal.coordinationId,
        subjectEntityIds: uniqueStrings(
          (proposal.terms.childEntityIds.length > 0
            ? proposal.terms.childEntityIds
            : proposal.affectedPartyEntityIds
          ).filter(
            (entityId) =>
              isOwner ||
              entityId === principalEntityId ||
              visibleSubjectEntityIds.includes(entityId),
          ),
        ),
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        agreementId: null,
        agreementVersion: null,
        startAt: proposal.terms.startAt,
        endAt: proposal.terms.endAt,
        details: scopes.includes("calendar.details") ? proposal.terms : null,
        state: "proposal",
      });
    }
    for (const agreement of agreements) {
      if (
        !agreement.isCurrent ||
        (!isOwner &&
          !agreement.affectedPartyEntityIds.includes(principalEntityId) &&
          !agreement.affectedPartyEntityIds.some((entityId) =>
            visibleSubjectEntityIds.includes(entityId),
          ))
      ) {
        continue;
      }
      const scopes = this.scopesForSchedule(
        principalEntityId,
        ownActiveGrants,
        agreement.terms.childEntityIds.length > 0
          ? agreement.terms.childEntityIds
          : agreement.affectedPartyEntityIds,
      );
      if (!scopes.includes("calendar.freebusy")) continue;
      schedules.push({
        householdId,
        coordinationId: agreement.coordinationId,
        subjectEntityIds: uniqueStrings(
          (agreement.terms.childEntityIds.length > 0
            ? agreement.terms.childEntityIds
            : agreement.affectedPartyEntityIds
          ).filter(
            (entityId) =>
              isOwner ||
              entityId === principalEntityId ||
              visibleSubjectEntityIds.includes(entityId),
          ),
        ),
        proposalId: agreement.proposalId,
        proposalVersion: agreement.proposalVersion,
        agreementId: agreement.id,
        agreementVersion: agreement.version,
        startAt: agreement.terms.startAt,
        endAt: agreement.terms.endAt,
        details: scopes.includes("calendar.details") ? agreement.terms : null,
        state: "agreement",
      });
    }

    // The audit and decision trail is export-only material: calendar scopes
    // let a principal see schedules, but reading who decided what and when
    // requires the distinct, revocable `household.export` authority.
    const includeAuditTrail =
      isOwner || effectiveScopes.includes("household.export");
    const audience = new Set([principalEntityId, ...visibleSubjectEntityIds]);
    const auditEvents = includeAuditTrail
      ? await this.deps.repository.listAudit()
      : [];
    const audit = auditEvents
      .filter((event) => {
        const eventHouseholdId =
          typeof event.inputs.householdId === "string"
            ? event.inputs.householdId
            : typeof event.decision.householdId === "string"
              ? event.decision.householdId
              : DEFAULT_HOUSEHOLD_ID;
        return eventHouseholdId === householdId;
      })
      .filter((event) =>
        householdExportAuditVisibleToAudience(event, audience, {
          isOwner,
          principalEntityId,
        }),
      )
      .map((event): HouseholdAuditRecord => {
        if (isOwner) return event;
        return {
          ...event,
          reason: "Household coordination state changed.",
          inputs: {},
          decision: {},
        };
      });

    return {
      generatedAt: at.toISOString(),
      householdId,
      principalEntityId,
      effectiveScopes,
      visibleSubjectEntityIds,
      roles,
      grants: isOwner
        ? allGrants
        : allGrants.filter(
            (grant) => grant.principalEntityId === principalEntityId,
          ),
      schedules: schedules.sort((left, right) =>
        left.startAt.localeCompare(right.startAt),
      ),
      audit,
    };
  }
}

export function createHouseholdCoordinationService(
  runtime: IAgentRuntime,
): HouseholdCoordinationService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new HouseholdCoordinationError(
      "KnowledgeGraphService is required for household coordination",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  const agentId = runtime.agentId;
  return new HouseholdCoordinationService({
    runtime,
    agentId,
    entityStore: graph.getEntityStore(agentId),
    relationshipStore: graph.getRelationshipStore(agentId),
    approvalQueue: createApprovalQueue(runtime, { agentId }),
    repository: new HouseholdCoordinationRepository(runtime, agentId),
  });
}

export class HouseholdCoordinationRuntimeService extends Service {
  static override serviceType = HOUSEHOLD_COORDINATION_SERVICE;

  override capabilityDescription =
    "Role-scoped household coordination with version-pinned affected-party approvals";

  readonly coordination: HouseholdCoordinationService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new HouseholdCoordinationError(
        "HouseholdCoordinationRuntimeService requires a runtime",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    this.coordination = createHouseholdCoordinationService(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<HouseholdCoordinationRuntimeService> {
    await Promise.all([
      runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE),
      waitForScheduledTaskRunnerService(runtime),
    ]);
    const service = new HouseholdCoordinationRuntimeService(runtime);
    await service.coordination.reconcileGrantExpiryWarnings();
    return service;
  }

  async stop(): Promise<void> {}
}

export function getHouseholdCoordinationService(
  runtime: IAgentRuntime,
): HouseholdCoordinationService | null {
  const service = runtime.getService<HouseholdCoordinationRuntimeService>(
    HOUSEHOLD_COORDINATION_SERVICE,
  );
  return service ? service.coordination : null;
}

export async function readHouseholdCoordinationHead(
  runtime: IAgentRuntime,
  coordinationId: string,
  householdId: string = DEFAULT_HOUSEHOLD_ID,
): Promise<HouseholdCoordinationHead | null> {
  return await new HouseholdCoordinationRepository(
    runtime,
    runtime.agentId,
  ).getHead(householdNamespace(householdId), coordinationId);
}
