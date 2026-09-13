/**
 * Real-PGlite household coordination coverage through the production graph,
 * approval queue, audit log, commitment ledger, and versioned repositories.
 */
import { randomUUID } from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import {
  AgentEventService,
  createMessageMemory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  getRecordedTestNotifications,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { householdCoordinationAction } from "../../actions/household-coordination.js";
import { resolveRequestAction } from "../../actions/resolve-request.js";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalQueue } from "../approval-queue.types.js";
import { fenceFamilyWorkspace } from "../family-workflows/workspace-operation-store.js";
import { LifeOpsRepository } from "../repository.js";
import {
  executeRawSql,
  sqlInteger,
  sqlQuote,
  withTransaction,
} from "../sql.js";
import { HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE } from "./grant-expiry-warning.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import {
  HOUSEHOLD_COORDINATION_SERVICE,
  HouseholdCoordinationRuntimeService,
  HouseholdCoordinationService,
} from "./service.js";
import {
  type HouseholdScheduleProposal,
  type HouseholdScheduleTerms,
  type InvalidatedProposalApproval,
  normalizeScheduleTerms,
} from "./types.js";

class RejectCommitFaultRepository extends HouseholdCoordinationRepository {
  override async rejectProposal(
    _input: Parameters<HouseholdCoordinationRepository["rejectProposal"]>[0],
  ): Promise<InvalidatedProposalApproval[]> {
    throw new Error("simulated failure after queue rejection");
  }
}

describe("household coordination — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let entities: EntityStore;
  let approvals: ApprovalQueue;
  let householdRepository: HouseholdCoordinationRepository;
  let lifeOpsRepository: LifeOpsRepository;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) {
      throw new Error(
        `Knowledge graph service ${KNOWLEDGE_GRAPH_SERVICE} was not registered`,
      );
    }
    entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    if (!runtime.getService(AgentEventService.serviceType)) {
      await runtime.registerService(AgentEventService);
      await runtime.getServiceLoadPromise(AgentEventService.serviceType);
    }
    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });
    householdRepository = new HouseholdCoordinationRepository(
      runtime,
      runtime.agentId,
    );
    lifeOpsRepository = new LifeOpsRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function service(
    now?: () => Date,
    scheduledTasks?: ScheduledTaskRunnerHandle,
  ): HouseholdCoordinationService {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    return new HouseholdCoordinationService({
      runtime,
      agentId: runtime.agentId,
      entityStore: graph.getEntityStore(runtime.agentId),
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository: householdRepository,
      scheduledTasks,
      now,
    });
  }

  async function person(label: string): Promise<string> {
    const entity = await entities.upsert({
      entityId: `ent_${label}_${randomUUID()}`,
      type: "person",
      preferredName: label,
      identities: [],
      tags: ["household-test"],
      visibility: "owner_only",
      state: {},
    });
    return entity.entityId;
  }

  function terms(input: {
    summary: string;
    childEntityIds: string[];
    startHour?: number;
    secret?: string;
    custody?: {
      childEntityId: string;
      normalCustodianEntityId: string;
      substituteCustodianEntityId: string;
      authorityBaselineRelationshipId: string;
    };
  }): HouseholdScheduleTerms {
    const startHour = input.startHour ?? 17;
    const startAt = `2027-03-12T${String(startHour).padStart(2, "0")}:00:00.000Z`;
    const endAt = `2027-03-12T${String(startHour + 1).padStart(2, "0")}:00:00.000Z`;
    return {
      summary: input.summary,
      startAt,
      endAt,
      timezone: "America/Los_Angeles",
      childEntityIds: input.childEntityIds,
      location: input.secret ? `Private location: ${input.secret}` : null,
      notes: input.secret ? `Private note: ${input.secret}` : null,
      custodyException: input.custody
        ? {
            childEntityId: input.custody.childEntityId,
            fromAt: startAt,
            toAt: endAt,
            normalCustodianEntityId: input.custody.normalCustodianEntityId,
            substituteCustodianEntityId:
              input.custody.substituteCustodianEntityId,
            authorityBaselineRelationshipId:
              input.custody.authorityBaselineRelationshipId,
            reason: "School closure changed the normal handoff.",
          }
        : null,
    };
  }

  async function bindFamily(input: {
    childId: string;
    coParentId?: string;
    caregiverId?: string;
    professionalId?: string;
    reuseCoParentEdge?: boolean;
  }): Promise<void> {
    const coordinator = service();
    await coordinator.bindRole({
      entityId: input.childId,
      role: "child",
      subjectEntityIds: [input.childId],
      evidence: "Owner identified this child.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    if (input.coParentId) {
      let relationshipId: string | undefined;
      if (input.reuseCoParentEdge) {
        const graph = resolveKnowledgeGraphService(runtime);
        if (!graph) throw new Error("knowledge graph unavailable");
        const existing = await graph
          .getRelationshipStore(runtime.agentId)
          .upsert({
            fromEntityId: SELF_ENTITY_ID,
            toEntityId: input.coParentId,
            type: "co_parent_of",
            metadata: { childId: input.childId },
            state: {},
            evidence: ["relationship inference fixture"],
            confidence: 0.92,
            source: "extraction",
          });
        relationshipId = existing.relationshipId;
      }
      await coordinator.bindRole({
        entityId: input.coParentId,
        role: "co_parent",
        subjectEntityIds: [input.childId],
        relationshipId,
        evidence: "Owner identified this co-parent.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
    if (input.caregiverId) {
      await coordinator.bindRole({
        entityId: input.caregiverId,
        role: "caregiver",
        subjectEntityIds: [input.childId],
        evidence: "Owner identified this caregiver.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
    if (input.professionalId) {
      await coordinator.bindRole({
        entityId: input.professionalId,
        role: "professional",
        subjectEntityIds: [input.childId],
        evidence: "Owner identified this household professional.",
        boundByEntityId: SELF_ENTITY_ID,
      });
    }
  }

  async function approve(
    proposal: HouseholdScheduleProposal,
    partyEntityId: string,
  ): Promise<void> {
    const link = (
      await householdRepository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      )
    ).find((candidate) => candidate.partyEntityId === partyEntityId);
    if (!link) throw new Error("household approval link missing");
    await service().respondToProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      partyEntityId,
      approvalRequestId: link.approvalRequestId,
      decision: "approve",
      reason: "I approve this exact time and custody plan.",
    });
  }

  it("issues and revokes a knowledge-only grant through promoted actions with explicit empty subjects", async () => {
    const principalEntityId = await person("knowledge-only-caregiver");
    const householdId = `knowledge-only-${randomUUID()}`;
    await service().bindRole({
      entityId: principalEntityId,
      role: "caregiver",
      householdId,
      subjectEntityIds: [],
      evidence: "Synthetic knowledge-only household access acceptance.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const actions = promoteSubactionsToActions(householdCoordinationAction);
    const issue = actions.find(
      (action) => action.name === "HOUSEHOLD_COORDINATION_ISSUE_GRANT",
    );
    const revoke = actions.find(
      (action) => action.name === "HOUSEHOLD_COORDINATION_REVOKE_GRANT",
    );
    if (!issue || !revoke)
      throw new Error("Household grant actions are unavailable");
    const message = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: "Issue the explicitly requested knowledge-only grant.",
        source: "client_chat",
      },
    });
    const parameters = {
      householdId,
      principalEntityId,
      role: "caregiver",
      subjectEntityIds: [],
      scopes: ["knowledge.read"],
    };
    const result = await issue.handler(runtime, message, undefined, {
      parameters,
    });
    expect(result).toMatchObject({
      success: true,
      data: { action: "issue_grant" },
    });
    const grants = await householdRepository.listGrants(
      principalEntityId,
      householdId,
    );
    expect(grants).toEqual([
      expect.objectContaining({
        principalEntityId,
        householdId,
        role: "caregiver",
        subjectEntityIds: [],
        scopes: ["household.visibility", "knowledge.read"],
        revokedAt: null,
      }),
    ]);
    const grant = grants[0];
    if (!grant)
      throw new Error("Issued knowledge-only grant was not persisted");
    expect(result).toMatchObject({
      effectReceipts: [
        {
          outcome: "applied",
          resource: { id: grant.id },
          commit: { kind: "durable" },
        },
      ],
    });

    const { subjectEntityIds: _subjects, ...withoutSubjects } = parameters;
    expect(
      await issue.handler(runtime, message, undefined, {
        parameters: withoutSubjects,
      }),
    ).toMatchObject({
      success: false,
      data: {
        error: "MISSING_HOUSEHOLD_PARAMETERS",
      },
    });
    await expect(
      issue.handler(runtime, message, undefined, {
        parameters: { ...parameters, subjectEntityIds: [42] },
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    await expect(
      issue.handler(runtime, message, undefined, {
        parameters: { ...parameters, scopes: ["calendar.freebusy"] },
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    expect(
      await householdRepository.listGrants(principalEntityId, householdId),
    ).toEqual(grants);

    expect(
      await revoke.handler(runtime, message, undefined, {
        parameters: {
          grantId: grant.id,
          reason: "Synthetic knowledge-only grant acceptance complete.",
        },
      }),
    ).toMatchObject({ success: true });
    const revoked = await householdRepository.listGrants(
      principalEntityId,
      householdId,
    );
    expect(revoked).toEqual([
      expect.objectContaining({ id: grant.id, revokedAt: expect.any(String) }),
    ]);
  });

  it("exposes safe owner operations without an affected-party impersonation verb", async () => {
    const actionParameter = householdCoordinationAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema.enum).toEqual(
      expect.arrayContaining([
        "bind_role",
        "set_custody_authority",
        "revoke_custody_authority",
        "issue_grant",
        "create_proposal",
        "revise_proposal",
        "finalize_proposal",
        "export",
      ]),
    );
    for (const forbidden of [
      "respond",
      "approve",
      "reject",
      "respond_to_proposal",
    ]) {
      expect(actionParameter?.schema.enum).not.toContain(forbidden);
    }

    const childId = await person("action-child");
    const coParentId = await person("action-co-parent");
    const actionHouseholdId = `action-household-${randomUUID()}`;
    const ownerMessage = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: "Coordinate a household schedule proposal.",
        source: "client_chat",
      },
    });
    const invoke = async (parameters: Record<string, unknown>) =>
      await householdCoordinationAction.handler(
        runtime,
        ownerMessage,
        undefined,
        { parameters },
        undefined,
      );

    const missingHousehold = await invoke({
      action: "bind_role",
      entityId: childId,
      role: "child",
      subjectEntityIds: [childId],
      evidence: "This request must not fall into a default household.",
    });
    expect(missingHousehold).toMatchObject({
      success: false,
      data: {
        error: "MISSING_HOUSEHOLD_PARAMETERS",
      },
      effectReceipts: [
        {
          outcome: "failed",
          operation: "lifeops.household_coordination.resolve_request",
          failure: { acceptance: "rejected" },
        },
      ],
    });

    const childBindingResult = await invoke({
      action: "bind_role",
      entityId: childId,
      role: "child",
      householdId: actionHouseholdId,
      subjectEntityIds: [childId],
      evidence: "Owner identified this child through the action surface.",
    });
    expect(childBindingResult).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.bind_role",
          resource: { kind: "lifeops.household.role_binding" },
          commit: { kind: "durable" },
        },
      ],
    });
    const coParentBindingResult = await invoke({
      action: "bind_role",
      entityId: coParentId,
      role: "co_parent",
      householdId: actionHouseholdId,
      subjectEntityIds: [childId],
      evidence: "Owner identified this co-parent through the action surface.",
    });
    expect(coParentBindingResult).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.bind_role",
          resource: { kind: "lifeops.household.role_binding" },
          commit: { kind: "durable" },
        },
      ],
    });
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const coParentRelationships = await graph
      .getRelationshipStore(runtime.agentId)
      .list({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: coParentId,
      });
    expect(coParentRelationships).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          householdId: actionHouseholdId,
          householdRole: "co_parent",
        }),
      }),
    ]);

    const authorityRelationshipId = `action-authority-${randomUUID()}`;
    const authorityResult = await invoke({
      action: "set_custody_authority",
      householdId: actionHouseholdId,
      relationshipId: authorityRelationshipId,
      childEntityId: childId,
      custodianEntityIds: [SELF_ENTITY_ID, coParentId],
      evidence:
        "Owner confirmed the current custody-authority baseline through the action surface.",
    });
    expect(authorityResult).toMatchObject({
      success: true,
      data: {
        action: "set_custody_authority",
        authority: {
          householdId: actionHouseholdId,
          relationshipId: authorityRelationshipId,
          status: "active",
        },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.set_custody_authority",
          resource: {
            kind: "lifeops.household.custody_authority",
            id: authorityRelationshipId,
          },
          commit: { kind: "durable" },
        },
      ],
    });

    const grantResult = await invoke({
      action: "issue_grant",
      householdId: actionHouseholdId,
      principalEntityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [childId],
      scopes: ["household.visibility", "calendar.freebusy"],
    });
    expect(grantResult).toMatchObject({
      success: true,
      data: {
        grant: {
          householdId: actionHouseholdId,
          principalEntityId: coParentId,
        },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.issue_grant",
          resource: { kind: "lifeops.household.access_grant" },
          commit: { kind: "durable" },
        },
      ],
    });
    const [grant] = await householdRepository.listGrants(
      coParentId,
      actionHouseholdId,
    );
    if (!grant) throw new Error("action-created household grant missing");
    expect(grantResult.effectReceipts?.[0]).toMatchObject({
      resource: {
        id: grant.id,
        version: grant.updatedAt,
      },
      commit: {
        id: `${grant.id}:${grant.updatedAt}`,
        committedAt: grant.updatedAt,
      },
    });
    expect(grantResult.userFacingEffectReceiptIds).toEqual([
      grantResult.effectReceipts?.[0]?.receiptId,
    ]);
    expect(grantResult.userFacingText).toBe(grantResult.text);
    expect(grantResult.verifiedUserFacing).toBe(true);
    const revokeGrantResult = await invoke({
      action: "revoke_grant",
      grantId: grant.id,
      reason: "Action receipt regression verifies durable revocation.",
    });
    expect(revokeGrantResult).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.revoke_grant",
          resource: {
            kind: "lifeops.household.access_grant",
            id: grant.id,
          },
          commit: { kind: "durable" },
        },
      ],
    });

    const actionProposalId = `action-proposal-${randomUUID()}`;
    const result = await invoke({
      action: "create_proposal",
      householdId: actionHouseholdId,
      proposalId: actionProposalId,
      coordinationId: `action-${randomUUID()}`,
      terms: terms({
        summary: "Owner-action household proposal",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: "create_proposal",
        proposal: {
          householdId: actionHouseholdId,
          version: 1,
          requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId].sort(),
        },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.create_proposal",
          resource: {
            kind: "lifeops.household.schedule_proposal",
            id: actionProposalId,
          },
          commit: { kind: "durable" },
        },
      ],
    });
    expect(result.text).toContain("No calendar event or external message");
    const persistedProposalV1 = await householdRepository.getProposal(
      actionProposalId,
      1,
    );
    if (!persistedProposalV1) {
      throw new Error("action-created household proposal missing");
    }
    expect(result.effectReceipts?.[0]).toMatchObject({
      resource: {
        id: actionProposalId,
        version: `1:${persistedProposalV1.contentSha256}`,
      },
      commit: {
        id: `${actionProposalId}:1:${persistedProposalV1.contentSha256}`,
        committedAt: persistedProposalV1.updatedAt,
      },
    });
    expect(result.effectReceipts?.[0]).not.toMatchObject({
      commit: { kind: "provider_accepted" },
    });

    const reviseResult = await invoke({
      action: "revise_proposal",
      proposalId: actionProposalId,
      expectedVersion: 1,
      terms: terms({
        summary: "Revised owner-action household proposal",
        childEntityIds: [childId],
        startHour: 18,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
    });
    expect(reviseResult).toMatchObject({
      success: true,
      data: { proposal: { version: 2 } },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.revise_proposal",
          resource: {
            kind: "lifeops.household.schedule_proposal",
            id: actionProposalId,
          },
          commit: { kind: "durable" },
        },
      ],
    });

    const ensureResult = await invoke({
      action: "ensure_approvals",
      proposalId: actionProposalId,
      proposalVersion: 2,
    });
    expect(ensureResult).toMatchObject({
      success: true,
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.ensure_approvals",
          resource: {
            kind: "lifeops.household.proposal_approvals",
            id: `${actionProposalId}:2`,
          },
          commit: { kind: "durable" },
        },
      ],
    });

    const revisedProposal = await householdRepository.getProposal(
      actionProposalId,
      2,
    );
    if (!revisedProposal) {
      throw new Error("action-created proposal revision missing");
    }
    await approve(revisedProposal, SELF_ENTITY_ID);
    await approve(revisedProposal, coParentId);
    const finalizeResult = await invoke({
      action: "finalize_proposal",
      proposalId: actionProposalId,
      proposalVersion: 2,
    });
    expect(finalizeResult).toMatchObject({
      success: true,
      data: {
        agreement: {
          householdId: actionHouseholdId,
          proposalId: actionProposalId,
          proposalVersion: 2,
        },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.finalize_proposal",
          resource: { kind: "lifeops.household.schedule_agreement" },
          commit: { kind: "durable" },
        },
      ],
    });

    const exportResult = await invoke({
      action: "export",
      householdId: actionHouseholdId,
    });
    expect(exportResult).toMatchObject({
      success: true,
      data: {
        export: {
          householdId: actionHouseholdId,
          principalEntityId: SELF_ENTITY_ID,
        },
      },
      effectReceipts: [
        {
          outcome: "noop",
          operation: "lifeops.household_coordination.export",
          resource: { kind: "lifeops.household.scoped_export" },
        },
      ],
    });

    const revokeAuthorityResult = await invoke({
      action: "revoke_custody_authority",
      householdId: actionHouseholdId,
      relationshipId: authorityRelationshipId,
      reason: "Owner replaced this custody authority outside the assistant.",
    });
    expect(revokeAuthorityResult).toMatchObject({
      success: true,
      data: {
        action: "revoke_custody_authority",
        authority: {
          householdId: actionHouseholdId,
          relationshipId: authorityRelationshipId,
          status: "revoked",
        },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "lifeops.household_coordination.revoke_custody_authority",
          resource: {
            kind: "lifeops.household.custody_authority",
            id: authorityRelationshipId,
          },
          commit: { kind: "durable" },
        },
      ],
    });
  });

  it("requires offset-bearing instants and rejects skipped civil times while preserving both repeated-time instants", () => {
    const schedule = (
      startAt: string,
      endAt: string,
      timezone: string,
    ): HouseholdScheduleTerms => ({
      summary: "Time-zone boundary test",
      startAt,
      endAt,
      timezone,
      childEntityIds: [],
      location: null,
      notes: null,
      custodyException: null,
    });

    for (const invalid of [
      schedule(
        "2027-03-12T17:00:00",
        "2027-03-12T18:00:00-08:00",
        "America/Los_Angeles",
      ),
      schedule(
        "2027-03-12",
        "2027-03-12T18:00:00-08:00",
        "America/Los_Angeles",
      ),
      schedule(
        "2027-02-31T17:00:00-08:00",
        "2027-03-03T18:00:00-08:00",
        "America/Los_Angeles",
      ),
      schedule(
        "2026-03-08T02:30:00-05:00",
        "2026-03-08T04:00:00-04:00",
        "America/New_York",
      ),
      schedule(
        "2026-09-06T00:00:00-04:00",
        "2026-09-06T02:00:00-03:00",
        "America/Santiago",
      ),
      schedule(
        "2011-12-30T00:00:00-10:00",
        "2011-12-31T02:00:00+14:00",
        "Pacific/Apia",
      ),
    ]) {
      expect(() => normalizeScheduleTerms(invalid)).toThrowError(
        expect.objectContaining({ code: "HOUSEHOLD_INVALID_CONTRACT" }),
      );
    }

    expect(
      normalizeScheduleTerms(
        schedule(
          "2026-11-01T01:30:00-04:00",
          "2026-11-01T01:45:00-04:00",
          "America/New_York",
        ),
      ).startAt,
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      normalizeScheduleTerms(
        schedule(
          "2026-11-01T01:30:00-05:00",
          "2026-11-01T01:45:00-05:00",
          "America/New_York",
        ),
      ).startAt,
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("requires both custodians for a custody exception and writes the accepted obligation", async () => {
    expect(runtime.getService(HOUSEHOLD_COORDINATION_SERVICE)).toBeInstanceOf(
      HouseholdCoordinationRuntimeService,
    );
    const childId = await person("custody-child");
    const coParentId = await person("custody-co-parent");
    await bindFamily({ childId, coParentId, reuseCoParentEdge: true });
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const coParentEdges = await graph
      .getRelationshipStore(runtime.agentId)
      .list({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: coParentId,
        type: "co_parent_of",
      });
    expect(coParentEdges).toHaveLength(1);
    expect(coParentEdges[0]?.metadata).toMatchObject({
      householdRole: "co_parent",
      householdSubjectEntityIds: [childId],
    });
    const authorityBaseline = await graph
      .getRelationshipStore(runtime.agentId)
      .observe({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: childId,
        type: "custody_authority",
        metadataPatch: {
          custodyAuthorityChildEntityId: childId,
          custodyAuthorityCustodianEntityIds: [SELF_ENTITY_ID, coParentId],
        },
        evidence: ["Owner supplied the current custody-authority baseline."],
        confidence: 1,
        occurredAt: "2027-03-10T12:00:00.000Z",
        source: "user_chat",
      });
    const coordinator = service();
    const proposal = await coordinator.createProposal({
      coordinationId: `custody-${randomUUID()}`,
      terms: terms({
        summary: "Custody exception for school closure",
        childEntityIds: [childId],
        custody: {
          childEntityId: childId,
          normalCustodianEntityId: coParentId,
          substituteCustodianEntityId: SELF_ENTITY_ID,
          authorityBaselineRelationshipId: authorityBaseline.relationshipId,
        },
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const approvalLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const ownerApprovalLink = approvalLinks.find(
      (link) => link.partyEntityId === SELF_ENTITY_ID,
    );
    const coParentApprovalLink = approvalLinks.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!ownerApprovalLink) throw new Error("owner approval link missing");
    if (!coParentApprovalLink) {
      throw new Error("co-parent approval link missing");
    }
    const ownerApproval = await approvals.byId(
      ownerApprovalLink.approvalRequestId,
      ownerApprovalLink.partyEntityId,
    );
    expect(ownerApproval?.payload).toMatchObject({
      action: "execute_workflow",
      input: { contentSha256: proposal.contentSha256 },
    });
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: coParentApprovalLink.approvalRequestId,
        decision: "approve",
        reason: "Attempt to answer the wrong party request.",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });

    const ownerMessage = createMessageMemory({
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: `Approve ${ownerApprovalLink.approvalRequestId}.`,
        source: "client_chat",
      },
    });
    const ownerApprovalResult = await resolveRequestAction.handler(
      runtime,
      ownerMessage,
      undefined,
      {
        parameters: {
          action: "approve",
          requestId: ownerApprovalLink.approvalRequestId,
          reason: "I approve these exact household proposal bytes.",
        },
      },
      undefined,
    );
    expect(ownerApprovalResult).toMatchObject({
      success: true,
      data: {
        operation: "resolve_household_schedule_proposal",
        requestId: ownerApprovalLink.approvalRequestId,
        state: "approved",
        decision: "approve",
        resolvedBy: SELF_ENTITY_ID,
      },
    });
    const crossPartyRejection = await resolveRequestAction.handler(
      runtime,
      ownerMessage,
      undefined,
      {
        parameters: {
          action: "reject",
          requestId: coParentApprovalLink.approvalRequestId,
          reason: "The owner must not reject for the co-parent.",
        },
      },
      undefined,
    );
    // A subject-scoped read never confirms that another party's row exists, so
    // the owner sees the same answer as for an unknown id. The property under
    // test is the untouched co-parent row asserted next, not the error name.
    expect(crossPartyRejection).toMatchObject({
      success: false,
      data: { error: "REQUEST_NOT_FOUND" },
    });
    await expect(
      approvals.byId(
        coParentApprovalLink.approvalRequestId,
        coParentApprovalLink.partyEntityId,
      ),
    ).resolves.toMatchObject({ state: "pending", resolvedBy: null });
    await expect(
      coordinator.finalizeProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });

    await approve(proposal, coParentId);
    const agreement = await coordinator.finalizeProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
    });
    expect(agreement.approvedByEntityIds).toEqual(
      [SELF_ENTITY_ID, coParentId].sort(),
    );
    expect(agreement.terms.custodyException?.childEntityId).toBe(childId);

    const obligations = await lifeOpsRepository.listCommitmentLedgerRecords(
      runtime.agentId,
      { source: "chat" },
    );
    expect(
      obligations.find(
        (record) => record.metadata.householdAgreementId === agreement.id,
      ),
    ).toMatchObject({
      summary: "Custody exception for school closure",
      confidence: 1,
      dueAt: agreement.terms.startAt,
    });
    const audit = await householdRepository.listAudit();
    expect(
      audit
        .filter(
          (event) =>
            event.ownerId === proposal.proposalId ||
            event.ownerId === agreement.id,
        )
        .map((event) => event.kind),
    ).toEqual(
      expect.arrayContaining([
        "household_proposal_created",
        "household_proposal_approved",
        "household_agreement_activated",
      ]),
    );
  });

  it("rejects missing custody authority and non-parent household roles before proposal materialization", async () => {
    const childId = await person("custody-authority-child");
    const coParentId = await person("custody-authority-co-parent");
    const partnerId = await person("custody-authority-partner");
    const caregiverId = await person("custody-authority-caregiver");
    const professionalId = await person("custody-authority-professional");
    await bindFamily({
      childId,
      coParentId,
      caregiverId,
      professionalId,
    });
    const coordinator = service();
    await coordinator.bindRole({
      entityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [childId],
      evidence: "Owner identified the current partner.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const authorityBaseline = await graph
      .getRelationshipStore(runtime.agentId)
      .observe({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: childId,
        type: "custody_authority",
        metadataPatch: {
          custodyAuthorityChildEntityId: childId,
          custodyAuthorityCustodianEntityIds: [
            SELF_ENTITY_ID,
            coParentId,
            partnerId,
            caregiverId,
            professionalId,
          ],
        },
        evidence: ["Owner supplied a custody-authority test baseline."],
        confidence: 1,
        occurredAt: "2027-03-10T12:00:00.000Z",
        source: "user_chat",
      });
    const proposalCount = (await householdRepository.listProposals()).length;
    const attempt = async (
      substituteCustodianEntityId: string,
      authorityBaselineRelationshipId: string,
    ): Promise<void> => {
      await coordinator.createProposal({
        coordinationId: `custody-authority-${randomUUID()}`,
        terms: terms({
          summary: "Authority must be established before a handoff",
          childEntityIds: [childId],
          custody: {
            childEntityId: childId,
            normalCustodianEntityId: coParentId,
            substituteCustodianEntityId,
            authorityBaselineRelationshipId,
          },
        }),
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [],
        createdByEntityId: SELF_ENTITY_ID,
      });
    };

    await expect(
      attempt(SELF_ENTITY_ID, `missing-authority-${randomUUID()}`),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    for (const entityId of [partnerId, caregiverId, professionalId]) {
      await expect(
        attempt(entityId, authorityBaseline.relationshipId),
      ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    }
    expect(await householdRepository.listProposals()).toHaveLength(
      proposalCount,
    );
  });

  it("revokes a caregiver grant immediately instead of serving stale free/busy", async () => {
    const childId = await person("caregiver-child");
    const caregiverId = await person("caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service();
    const grant = await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const proposal = await coordinator.createProposal({
      coordinationId: `caregiver-${randomUUID()}`,
      terms: terms({
        summary: "Child pickup",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const before = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(before.schedules).toHaveLength(1);
    expect(before.schedules[0]?.proposalId).toBe(proposal.proposalId);
    await expect(
      coordinator.requireScope({
        principalEntityId: caregiverId,
        subjectEntityId: childId,
        scope: "calendar.freebusy",
        at: new Date(Date.now() + 120_000),
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_EXPIRED" });

    await coordinator.revokeGrant({
      grantId: grant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Caregiving engagement ended.",
    });
    const after = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(after.effectiveScopes).toEqual([]);
    expect(after.schedules).toEqual([]);
    await expect(
      coordinator.requireScope({
        principalEntityId: caregiverId,
        subjectEntityId: childId,
        scope: "calendar.freebusy",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_REVOKED" });
  });

  it("persists one exact, grant-only pre-expiry watcher across reconciliation restarts", async () => {
    const now = new Date("2027-04-01T12:00:00.000Z");
    const expiresAt = "2027-04-03T12:00:00.000Z";
    const childId = await person("warning-child");
    const caregiverId = await person("warning-caregiver");
    const unrelatedId = await person("warning-unrelated");
    await bindFamily({ childId, caregiverId });
    const coordinator = service(() => new Date(now));
    const grant = await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt,
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(now),
    });
    const before = (await runner.list({ kind: "watcher" })).filter((task) =>
      task.idempotencyKey?.includes(grant.id),
    );
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      trigger: { kind: "once", atIso: "2027-04-02T12:00:00.000Z" },
      subject: { kind: "self", id: SELF_ENTITY_ID },
      output: {
        destination: "in_app_card",
        target: `entity:${SELF_ENTITY_ID}`,
      },
      respectsGlobalPause: false,
      executionProfile: "notify-only",
      metadata: {
        householdGrantExpiryWarning: {
          version: 1,
          grantId: grant.id,
          principalEntityId: caregiverId,
          subjectEntityIds: [childId],
          scopes: ["calendar.freebusy", "household.visibility"],
          expiresAt,
          autoExtend: false,
          disclosure: "grant_identity_only",
        },
      },
    });
    expect(before[0]?.contextRequest).toBeUndefined();
    expect(JSON.stringify(before[0])).not.toContain(unrelatedId);

    const restarted = service(() => new Date(now));
    const [receipt] = (await restarted.reconcileGrantExpiryWarnings()).filter(
      (candidate) => candidate.grantId === grant.id,
    );
    expect(receipt).toMatchObject({
      outcome: "ready",
      grantId: grant.id,
      scheduledTaskId: before[0]?.taskId,
      deduplicated: true,
      autoExtend: false,
    });
    const after = (await runner.list({ kind: "watcher" })).filter((task) =>
      task.idempotencyKey?.includes(grant.id),
    );
    expect(after.map((task) => task.taskId)).toEqual([before[0]?.taskId]);
    await expect(householdRepository.getGrant(grant.id)).resolves.toMatchObject(
      {
        expiresAt,
        revokedAt: null,
      },
    );
  });

  it("durably reconciles a warning after scheduling fails without duplicating its grant", async () => {
    const clock = new Date("2027-04-21T12:00:00.000Z");
    const childId = await person("warning-outbox-child");
    const caregiverId = await person("warning-outbox-caregiver");
    await bindFamily({ childId, caregiverId });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const failingRunner: ScheduledTaskRunnerHandle = {
      ...runner,
      async schedule() {
        throw new Error("simulated ScheduledTask persistence outage");
      },
    };
    const errorsBefore = runtime.getRecentReportedErrors().length;
    const grant = await service(
      () => new Date(clock),
      failingRunner,
    ).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-23T12:00:00.000Z",
    });

    await expect(
      householdRepository.getGrantExpiryWarningIntent(grant.id),
    ).resolves.toMatchObject({
      state: "pending",
      grantId: grant.id,
      scheduledTaskId: null,
    });
    expect(
      (await householdRepository.listGrants()).filter(
        (candidate) => candidate.id === grant.id,
      ),
    ).toHaveLength(1);
    expect(
      runtime.getRecentReportedErrors().slice(errorsBefore),
    ).toContainEqual(
      expect.objectContaining({
        scope: "HouseholdCoordination.grantExpiryWarning",
        context: expect.objectContaining({
          grantId: grant.id,
          recovery: "startup_reconciliation",
        }),
      }),
    );

    const receipts = await service(
      () => new Date(clock),
    ).reconcileGrantExpiryWarnings();
    expect(receipts).toContainEqual(
      expect.objectContaining({
        outcome: "ready",
        grantId: grant.id,
        autoExtend: false,
      }),
    );
    await expect(
      householdRepository.getGrantExpiryWarningIntent(grant.id),
    ).resolves.toMatchObject({
      state: "scheduled",
      grantId: grant.id,
      warningAt: "2027-04-22T12:00:00.000Z",
      expiresAt: "2027-04-23T12:00:00.000Z",
    });
    expect(
      (await householdRepository.listGrants()).filter(
        (candidate) => candidate.id === grant.id,
      ),
    ).toHaveLength(1);
  });

  it("defers an active materialization lease and reclaims it on a later scheduler tick", async () => {
    let clock = new Date("2027-04-27T12:00:00.000Z");
    const childId = await person("warning-lease-child");
    const caregiverId = await person("warning-lease-caregiver");
    await bindFamily({ childId, caregiverId });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const failingRunner: ScheduledTaskRunnerHandle = {
      ...runner,
      async schedule() {
        throw new Error("leave a pending warning intent");
      },
    };
    const grant = await service(
      () => new Date(clock),
      failingRunner,
    ).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-29T12:00:00.000Z",
    });
    const leaseExpiresAt = "2027-04-27T12:01:00.000Z";
    await expect(
      householdRepository.claimGrantExpiryWarning({
        grantId: grant.id,
        attemptToken: "other-process",
        now: clock.toISOString(),
        leaseExpiresAt,
      }),
    ).resolves.toEqual({ kind: "claimed" });

    const [deferred] = (
      await service(() => new Date(clock)).reconcileGrantExpiryWarnings()
    ).filter((receipt) => receipt.grantId === grant.id);
    expect(deferred).toEqual({
      outcome: "deferred",
      grantId: grant.id,
      reason: "active_claim",
      retryAt: leaseExpiresAt,
      autoExtend: false,
    });
    expect(
      (await runner.list({ kind: "watcher" })).filter((task) =>
        task.idempotencyKey?.includes(grant.id),
      ),
    ).toEqual([]);

    clock = new Date("2027-04-27T12:01:01.000Z");
    const [reclaimed] = (
      await service(() => new Date(clock)).reconcileGrantExpiryWarnings()
    ).filter((receipt) => receipt.grantId === grant.id);
    expect(reclaimed).toMatchObject({
      outcome: "ready",
      grantId: grant.id,
      autoExtend: false,
    });
    expect(
      (await runner.list({ kind: "watcher" })).filter((task) =>
        task.idempotencyKey?.includes(grant.id),
      ),
    ).toHaveLength(1);
  });

  it("commits revocation with a cancellation outbox and retries a failed dismissal", async () => {
    const clock = new Date("2027-04-30T12:00:00.000Z");
    const childId = await person("warning-cancel-retry-child");
    const caregiverId = await person("warning-cancel-retry-caregiver");
    await bindFamily({ childId, caregiverId });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const grant = await service(() => new Date(clock)).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-05-02T12:00:00.000Z",
    });
    const task = (await runner.list({ kind: "watcher" })).find((candidate) =>
      candidate.idempotencyKey?.includes(grant.id),
    );
    if (!task) throw new Error("cancellation retry warning task missing");
    const failingRunner: ScheduledTaskRunnerHandle = {
      ...runner,
      async apply(taskId, verb, payload) {
        if (taskId === task.taskId && verb === "dismiss") {
          throw new Error("simulated watcher cancellation outage");
        }
        return await runner.apply(taskId, verb, payload);
      },
    };
    const errorsBefore = runtime.getRecentReportedErrors().length;
    await expect(
      service(() => new Date(clock), failingRunner).revokeGrant({
        grantId: grant.id,
        revokedByEntityId: SELF_ENTITY_ID,
        reason: "Caregiving access ended.",
      }),
    ).resolves.toMatchObject({
      id: grant.id,
      revokedAt: clock.toISOString(),
    });
    await expect(
      householdRepository.getGrantExpiryWarningIntent(grant.id),
    ).resolves.toMatchObject({
      cancelledAt: clock.toISOString(),
      cancellationCompletedAt: null,
      cancellationAttemptCount: 1,
      cancellationLastError: "simulated watcher cancellation outage",
    });
    expect(
      runtime.getRecentReportedErrors().slice(errorsBefore),
    ).toContainEqual(
      expect.objectContaining({
        scope: "HouseholdCoordination.grantExpiryWarningCancellation",
        context: expect.objectContaining({
          grantId: grant.id,
          recovery: "lifeops_scheduler_tick",
        }),
      }),
    );
    expect(
      (await runner.list({ kind: "watcher" })).find(
        (candidate) => candidate.taskId === task.taskId,
      )?.state.status,
    ).toBe("scheduled");

    const [reconciled] = (
      await service(() => new Date(clock)).reconcileGrantExpiryWarnings()
    ).filter((receipt) => receipt.grantId === grant.id);
    expect(reconciled).toMatchObject({
      outcome: "cancelled",
      grantId: grant.id,
      scheduledTaskId: task.taskId,
      taskState: "dismissed",
    });
    await expect(
      householdRepository.getGrantExpiryWarningIntent(grant.id),
    ).resolves.toMatchObject({
      cancelledAt: clock.toISOString(),
      cancellationCompletedAt: clock.toISOString(),
      cancellationAttemptCount: 1,
      cancellationLastError: null,
    });
  });

  it("leaves no live watcher when revocation races warning materialization", async () => {
    const clock = new Date("2027-04-24T12:00:00.000Z");
    const childId = await person("warning-revoke-race-child");
    const caregiverId = await person("warning-revoke-race-caregiver");
    await bindFamily({ childId, caregiverId });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    let announceScheduleStarted!: () => void;
    let releaseSchedule!: () => void;
    const scheduleStarted = new Promise<void>((resolve) => {
      announceScheduleStarted = resolve;
    });
    const scheduleRelease = new Promise<void>((resolve) => {
      releaseSchedule = resolve;
    });
    const blockedRunner: ScheduledTaskRunnerHandle = {
      ...runner,
      async schedule(task) {
        announceScheduleStarted();
        await scheduleRelease;
        return await runner.schedule(task);
      },
    };
    const notificationsBefore = getRecordedTestNotifications(runtime).length;
    const issuance = service(() => new Date(clock), blockedRunner).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-26T12:00:00.000Z",
    });

    await scheduleStarted;
    const persistedGrant = (
      await householdRepository.listGrants(caregiverId)
    ).find((candidate) => candidate.expiresAt === "2027-04-26T12:00:00.000Z");
    if (!persistedGrant) {
      throw new Error("in-flight grant was not persisted before scheduling");
    }
    await service(() => new Date(clock)).revokeGrant({
      grantId: persistedGrant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Revoke while the warning task is being persisted.",
    });
    releaseSchedule();
    const issuedGrant = await issuance;
    expect(issuedGrant.id).toBe(persistedGrant.id);

    await expect(
      householdRepository.getGrantExpiryWarningIntent(persistedGrant.id),
    ).resolves.toMatchObject({
      state: "pending",
      grantId: persistedGrant.id,
      scheduledTaskId: null,
      cancelledAt: clock.toISOString(),
    });
    const tasks = (await runner.list({ kind: "watcher" })).filter((candidate) =>
      candidate.idempotencyKey?.includes(persistedGrant.id),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state.status).toBe("dismissed");
    expect(
      tasks.filter((task) =>
        ["scheduled", "fired", "acknowledged"].includes(task.state.status),
      ),
    ).toEqual([]);
    await expect(
      runner.fireWithResult(tasks[0]?.taskId ?? ""),
    ).resolves.toMatchObject({
      kind: "skipped",
      reason: "terminal:dismissed",
      task: { state: { status: "dismissed" } },
    });
    expect(getRecordedTestNotifications(runtime)).toHaveLength(
      notificationsBefore,
    );
    await expect(
      householdRepository.getGrant(persistedGrant.id),
    ).resolves.toMatchObject({
      revokedAt: clock.toISOString(),
      expiresAt: "2027-04-26T12:00:00.000Z",
    });
  });

  it("atomically fires one owner warning when concurrent watcher ticks race", async () => {
    let clock = new Date("2027-04-04T12:00:00.000Z");
    const childId = await person("warning-race-child");
    const caregiverId = await person("warning-race-caregiver");
    await bindFamily({ childId, caregiverId });
    const grant = await service(() => new Date(clock)).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["household.visibility", "calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-06T12:00:00.000Z",
    });
    clock = new Date("2027-04-05T12:00:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const task = (await runner.list({ kind: "watcher" })).find((candidate) =>
      candidate.idempotencyKey?.includes(grant.id),
    );
    if (!task) throw new Error("grant warning task missing");
    const notificationsBefore = getRecordedTestNotifications(runtime).length;
    const results = await Promise.all([
      runner.fireWithResult(task.taskId),
      runner.fireWithResult(task.taskId),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "fired",
      "raced",
    ]);
    expect(getRecordedTestNotifications(runtime)).toHaveLength(
      notificationsBefore + 1,
    );
    await expect(householdRepository.getGrant(grant.id)).resolves.toMatchObject(
      {
        expiresAt: "2027-04-06T12:00:00.000Z",
        revokedAt: null,
      },
    );
  });

  it("dismisses a revoked grant watcher and skips an already expired grant", async () => {
    let clock = new Date("2027-04-07T12:00:00.000Z");
    const childId = await person("warning-state-child");
    const caregiverId = await person("warning-state-caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service(() => new Date(clock));
    const revoked = await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-09T12:00:00.000Z",
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const revokedTask = (await runner.list({ kind: "watcher" })).find(
      (candidate) => candidate.idempotencyKey?.includes(revoked.id),
    );
    if (!revokedTask) throw new Error("revoked grant warning task missing");
    await coordinator.revokeGrant({
      grantId: revoked.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Caregiving access ended before the warning.",
    });
    await expect(
      runner.fireWithResult(revokedTask.taskId),
    ).resolves.toMatchObject({
      kind: "skipped",
      reason: "terminal:dismissed",
    });

    const expiringCaregiverId = await person("warning-expired-caregiver");
    await bindFamily({ childId, caregiverId: expiringCaregiverId });
    const expiring = await coordinator.issueGrant({
      principalEntityId: expiringCaregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-10T12:00:00.000Z",
    });
    const expiredTask = (await runner.list({ kind: "watcher" })).find(
      (candidate) => candidate.idempotencyKey?.includes(expiring.id),
    );
    if (!expiredTask) throw new Error("expired grant warning task missing");
    const notificationsBefore = getRecordedTestNotifications(runtime).length;
    clock = new Date("2027-04-10T12:00:01.000Z");
    const expiredResult = await getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    }).fireWithResult(expiredTask.taskId);
    expect(expiredResult).toMatchObject({
      kind: "skipped",
      reason: expect.stringContaining("grant expired"),
      task: { state: { status: "skipped" } },
    });
    expect(getRecordedTestNotifications(runtime)).toHaveLength(
      notificationsBefore,
    );
    await expect(
      coordinator.requireScope({
        principalEntityId: expiringCaregiverId,
        subjectEntityId: childId,
        scope: "calendar.freebusy",
        at: clock,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_EXPIRED" });
  });

  it("preserves every terminal watcher outcome when its grant is later revoked", async () => {
    const clock = new Date("2027-04-14T12:00:00.000Z");
    const coordinator = service(() => new Date(clock));
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date(clock),
    });
    const terminalStates = [
      "completed",
      "skipped",
      "expired",
      "failed",
      "dismissed",
    ] as const;

    for (const terminalState of terminalStates) {
      const childId = await person(`warning-terminal-${terminalState}-child`);
      const caregiverId = await person(
        `warning-terminal-${terminalState}-caregiver`,
      );
      await bindFamily({ childId, caregiverId });
      const grant = await coordinator.issueGrant({
        principalEntityId: caregiverId,
        role: "caregiver",
        subjectEntityIds: [childId],
        scopes: ["calendar.freebusy"],
        issuedByEntityId: SELF_ENTITY_ID,
        expiresAt: "2027-04-20T12:00:00.000Z",
      });
      const task = (await runner.list({ kind: "watcher" })).find((candidate) =>
        candidate.idempotencyKey?.includes(grant.id),
      );
      if (!task) {
        throw new Error(`terminal ${terminalState} warning task missing`);
      }

      if (terminalState === "completed") {
        await runner.apply(task.taskId, "complete", {
          reason: "terminal preservation fixture",
        });
      } else if (terminalState === "skipped") {
        await runner.apply(task.taskId, "skip", {
          reason: "terminal preservation fixture",
        });
      } else if (terminalState === "expired" || terminalState === "failed") {
        await runner.pipeline(task.taskId, terminalState);
      } else {
        await runner.apply(task.taskId, "dismiss", {
          reason: "terminal preservation fixture",
        });
      }

      await coordinator.revokeGrant({
        grantId: grant.id,
        revokedByEntityId: SELF_ENTITY_ID,
        reason: `Revoke after ${terminalState} terminal outcome.`,
      });
      const persisted = (await runner.list({ kind: "watcher" })).find(
        (candidate) => candidate.taskId === task.taskId,
      );
      expect(persisted?.state.status).toBe(terminalState);
    }
  });

  it("fails fast when persisted watcher identity is malformed", async () => {
    const clock = new Date("2027-04-11T12:00:00.000Z");
    const childId = await person("warning-invalid-child");
    const caregiverId = await person("warning-invalid-caregiver");
    await bindFamily({ childId, caregiverId });
    const grant = await service(() => new Date(clock)).issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-04-13T12:00:00.000Z",
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2027-04-12T12:00:00.000Z"),
    });
    const task = (await runner.list({ kind: "watcher" })).find((candidate) =>
      candidate.idempotencyKey?.includes(grant.id),
    );
    if (!task) throw new Error("invalid-contract warning task missing");
    const originalTrigger = task.trigger;
    const originalShouldFire = task.shouldFire;
    const originalMetadata = task.metadata;
    await runner.apply(task.taskId, "edit", {
      metadata: { householdGrantExpiryWarning: { grantId: grant.id } },
    });
    await expect(runner.fireWithResult(task.taskId)).rejects.toMatchObject({
      code: "HOUSEHOLD_INVALID_CONTRACT",
    });
    await expect(
      withTransaction(runtime, (tx) =>
        fenceFamilyWorkspace(tx, runtime.agentId),
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    await runner.apply(task.taskId, "edit", { metadata: originalMetadata });

    const originalIdentity = originalMetadata?.householdGrantExpiryWarning;
    if (
      !originalIdentity ||
      typeof originalIdentity !== "object" ||
      Array.isArray(originalIdentity)
    ) {
      throw new Error("typed warning identity fixture missing");
    }
    const shiftedIdentity = {
      ...originalIdentity,
      warningAt: "2027-04-12T11:00:00.000Z",
    };
    await runner.apply(task.taskId, "edit", {
      trigger: { kind: "once", atIso: shiftedIdentity.warningAt },
      shouldFire: {
        compose: "first_deny",
        gates: [
          {
            kind: HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE,
            params: shiftedIdentity,
          },
        ],
      },
      metadata: {
        ...originalMetadata,
        householdGrantExpiryWarning: shiftedIdentity,
      },
    });
    await expect(runner.fireWithResult(task.taskId)).rejects.toMatchObject({
      code: "HOUSEHOLD_INVALID_CONTRACT",
    });
    await runner.apply(task.taskId, "edit", {
      trigger: originalTrigger,
      shouldFire: originalShouldFire,
      metadata: originalMetadata,
    });
    await runner.apply(task.taskId, "dismiss", {
      reason: "test cleanup after invalid persisted identity",
    });
  });

  it("keeps a co-parent scoped to the shared child and hides another child's plan", async () => {
    const sharedChildId = await person("shared-child");
    const otherChildId = await person("other-child");
    const coParentId = await person("privacy-co-parent");
    await bindFamily({ childId: sharedChildId, coParentId });
    await bindFamily({ childId: otherChildId });
    const coordinator = service();
    await expect(
      coordinator.issueGrant({
        principalEntityId: coParentId,
        role: "co_parent",
        subjectEntityIds: [otherChildId],
        scopes: ["calendar.freebusy"],
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await coordinator.issueGrant({
      principalEntityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [sharedChildId],
      scopes: ["calendar.details", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const visible = await coordinator.createProposal({
      coordinationId: `shared-${randomUUID()}`,
      terms: terms({
        summary: "Shared child's recital",
        childEntityIds: [sharedChildId],
      }),
      affectedPartyEntityIds: [sharedChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const hidden = await coordinator.createProposal({
      coordinationId: `private-${randomUUID()}`,
      terms: terms({
        summary: "Other child's appointment",
        childEntityIds: [otherChildId],
        startHour: 19,
      }),
      affectedPartyEntityIds: [otherChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const mixed = await coordinator.createProposal({
      coordinationId: `mixed-${randomUUID()}`,
      terms: terms({
        summary: "Private mixed-household logistics",
        childEntityIds: [sharedChildId, otherChildId],
        startHour: 20,
      }),
      affectedPartyEntityIds: [sharedChildId, otherChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const exported = await coordinator.exportFor({
      principalEntityId: coParentId,
    });
    expect(exported.schedules.map((entry) => entry.proposalId)).toContain(
      visible.proposalId,
    );
    expect(exported.schedules.map((entry) => entry.proposalId)).not.toContain(
      hidden.proposalId,
    );
    expect(exported.schedules.map((entry) => entry.proposalId)).toContain(
      mixed.proposalId,
    );
    expect(
      exported.schedules.find(
        (entry) => entry.proposalId === visible.proposalId,
      )?.details,
    ).not.toBeNull();
    expect(
      exported.schedules.find((entry) => entry.proposalId === mixed.proposalId)
        ?.details,
    ).toBeNull();
    expect(exported.visibleSubjectEntityIds).toEqual([sharedChildId]);
    expect(JSON.stringify(exported)).not.toContain(otherChildId);

    const coParentBinding = (await coordinator.listRoleBindings()).find(
      (binding) => binding.entityId === coParentId,
    );
    if (!coParentBinding?.relationshipId) {
      throw new Error("co-parent relationship binding missing");
    }
    await coordinator.bindRole({
      entityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [],
      relationshipId: coParentBinding.relationshipId,
      evidence: "Owner removed this child from the co-parent relationship.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const afterRelationshipNarrowing = await coordinator.exportFor({
      principalEntityId: coParentId,
    });
    expect(afterRelationshipNarrowing.effectiveScopes).toEqual([]);
    expect(afterRelationshipNarrowing.schedules).toEqual([]);
  });

  it("keeps a current partner inside explicit child subjects and retires access with the relationship", async () => {
    const sharedChildId = await person("partner-shared-child");
    const unrelatedChildId = await person("partner-unrelated-child");
    const partnerId = await person("current-partner");
    await bindFamily({ childId: sharedChildId });
    await bindFamily({ childId: unrelatedChildId });
    const coordinator = service();
    const binding = await coordinator.bindRole({
      entityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [sharedChildId],
      evidence: "Owner identified this partner's household scope.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.issueGrant({
        principalEntityId: partnerId,
        role: "current_partner",
        subjectEntityIds: [unrelatedChildId],
        scopes: ["calendar.freebusy"],
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    await coordinator.issueGrant({
      principalEntityId: partnerId,
      role: "current_partner",
      subjectEntityIds: [sharedChildId],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await coordinator.createProposal({
      coordinationId: `partner-scope-${randomUUID()}`,
      terms: terms({
        summary: "Shared child plan",
        childEntityIds: [sharedChildId],
      }),
      affectedPartyEntityIds: [sharedChildId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.exportFor({ principalEntityId: partnerId }),
    ).resolves.toMatchObject({
      effectiveScopes: [
        "household.visibility",
        "calendar.freebusy",
        "household.export",
      ],
    });

    if (!binding.relationshipId) {
      throw new Error("current partner relationship binding missing");
    }
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const relationships = graph.getRelationshipStore(runtime.agentId);
    const relationship = await relationships.get(binding.relationshipId);
    if (!relationship) throw new Error("current partner relationship missing");
    await relationships.upsert({
      relationshipId: relationship.relationshipId,
      fromEntityId: relationship.fromEntityId,
      toEntityId: relationship.toEntityId,
      type: relationship.type,
      metadata: relationship.metadata,
      state: relationship.state,
      evidence: relationship.evidence,
      confidence: relationship.confidence,
      source: relationship.source,
      status: "retired",
    });
    expect(
      (await coordinator.listRoleBindings()).some(
        (candidate) => candidate.entityId === partnerId,
      ),
    ).toBe(false);
    await expect(
      coordinator.exportFor({ principalEntityId: partnerId }),
    ).resolves.toMatchObject({
      effectiveScopes: [],
      schedules: [],
    });
  });

  it("serializes concurrent proposals so only one can advance an agreement head", async () => {
    const childId = await person("concurrency-child");
    const coParentId = await person("concurrency-co-parent");
    await bindFamily({ childId, coParentId });
    const coordinator = service();
    const coordinationId = `concurrent-${randomUUID()}`;
    const first = await coordinator.createProposal({
      coordinationId,
      terms: terms({
        summary: "First handoff option",
        childEntityIds: [childId],
        startHour: 15,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const second = await coordinator.createProposal({
      coordinationId,
      terms: terms({
        summary: "Second handoff option",
        childEntityIds: [childId],
        startHour: 16,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    for (const proposal of [first, second]) {
      await approve(proposal, SELF_ENTITY_ID);
      await approve(proposal, coParentId);
    }

    const results = await Promise.allSettled([
      coordinator.finalizeProposal({
        proposalId: first.proposalId,
        proposalVersion: first.version,
      }),
      coordinator.finalizeProposal({
        proposalId: second.proposalId,
        proposalVersion: second.version,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const agreements = (await householdRepository.listAgreements()).filter(
      (agreement) => agreement.coordinationId === coordinationId,
    );
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ version: 1, isCurrent: true });
    const losingProposal =
      agreements[0]?.proposalId === first.proposalId ? second : first;
    await expect(
      householdRepository.getProposal(
        losingProposal.proposalId,
        losingProposal.version,
      ),
    ).resolves.toMatchObject({ status: "invalidated" });
    const losingLinks = await householdRepository.listApprovalLinks(
      losingProposal.proposalId,
      losingProposal.version,
    );
    expect(losingLinks.every((link) => link.invalidatedAt !== null)).toBe(true);
    const losingRequests = await Promise.all(
      losingLinks.map((link) =>
        approvals.byId(link.approvalRequestId, link.partyEntityId),
      ),
    );
    expect(
      losingRequests.every((request) => request?.state === "expired"),
    ).toBe(true);
  });

  it("invalidates stale approvals when material proposal bytes change", async () => {
    const childId = await person("stale-child");
    const coParentId = await person("stale-co-parent");
    await bindFamily({ childId, coParentId });
    const coordinator = service();
    const first = await coordinator.createProposal({
      coordinationId: `stale-${randomUUID()}`,
      terms: terms({
        summary: "Weekend handoff",
        childEntityIds: [childId],
        startHour: 14,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    await approve(first, SELF_ENTITY_ID);
    await approve(first, coParentId);
    const revised = await coordinator.reviseProposal({
      proposalId: first.proposalId,
      expectedVersion: first.version,
      terms: terms({
        summary: "Weekend handoff",
        childEntityIds: [childId],
        startHour: 18,
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      revisedByEntityId: SELF_ENTITY_ID,
    });
    expect(revised).toMatchObject({ version: 2, materialChange: true });
    const ensuredOnce = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    const ensuredTwice = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    expect(ensuredTwice.map((link) => link.id)).toEqual(
      ensuredOnce.map((link) => link.id),
    );
    const missingLink = ensuredOnce.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!missingLink) throw new Error("co-parent approval link missing");
    const originalRequest = await approvals.byId(
      missingLink.approvalRequestId,
      missingLink.partyEntityId,
    );
    if (!originalRequest?.idempotencyKey) {
      throw new Error("household approval idempotency key missing");
    }
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(runtime.agentId)}
          AND proposal_id = ${sqlQuote(revised.proposalId)}
          AND proposal_version = ${sqlInteger(revised.version)}
          AND party_entity_id = ${sqlQuote(coParentId)}`,
    );
    const repaired = await coordinator.ensureProposalApprovals(
      revised.proposalId,
      revised.version,
    );
    expect(
      repaired.find((link) => link.partyEntityId === coParentId)
        ?.approvalRequestId,
    ).toBe(originalRequest.id);
    const coParentRequests = await approvals.list({
      subjectUserId: coParentId,
      state: null,
      action: "execute_workflow",
      limit: 100,
    });
    expect(
      coParentRequests.filter(
        (request) => request.idempotencyKey === originalRequest.idempotencyKey,
      ),
    ).toHaveLength(1);

    await expect(
      coordinator.finalizeProposal({
        proposalId: revised.proposalId,
        proposalVersion: revised.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });
    const oldLinks = await householdRepository.listApprovalLinks(
      first.proposalId,
      first.version,
    );
    expect(oldLinks.every((link) => link.invalidatedAt !== null)).toBe(true);
    const oldRequests = await Promise.all(
      oldLinks.map((link) =>
        approvals.byId(link.approvalRequestId, link.partyEntityId),
      ),
    );
    expect(oldRequests.every((request) => request?.state === "expired")).toBe(
      true,
    );

    await approve(revised, SELF_ENTITY_ID);
    await approve(revised, coParentId);
    await expect(
      coordinator.finalizeProposal({
        proposalId: revised.proposalId,
        proposalVersion: revised.version,
      }),
    ).resolves.toMatchObject({ proposalVersion: 2, version: 1 });
  });

  it("recovers a queue rejection that crashed before the proposal transaction", async () => {
    const childId = await person("rejection-recovery-child");
    const coParentId = await person("rejection-recovery-co-parent");
    await bindFamily({ childId, coParentId });
    const proposal = await service().createProposal({
      coordinationId: `rejection-recovery-${randomUUID()}`,
      terms: terms({
        summary: "Proposal that the co-parent declines",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [SELF_ENTITY_ID, coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const links = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    const ownerLink = links.find(
      (link) => link.partyEntityId === SELF_ENTITY_ID,
    );
    const coParentLink = links.find(
      (link) => link.partyEntityId === coParentId,
    );
    if (!ownerLink || !coParentLink) {
      throw new Error("rejection recovery approval links missing");
    }
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const faultingService = new HouseholdCoordinationService({
      runtime,
      agentId: runtime.agentId,
      entityStore: graph.getEntityStore(runtime.agentId),
      relationshipStore: graph.getRelationshipStore(runtime.agentId),
      approvalQueue: approvals,
      repository: new RejectCommitFaultRepository(runtime, runtime.agentId),
    });
    await expect(
      faultingService.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: coParentId,
        approvalRequestId: coParentLink.approvalRequestId,
        decision: "reject",
        reason: "This handoff time does not work for me.",
      }),
    ).rejects.toThrow("simulated failure after queue rejection");
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      approvals.byId(
        coParentLink.approvalRequestId,
        coParentLink.partyEntityId,
      ),
    ).resolves.toMatchObject({
      state: "rejected",
      resolvedBy: coParentId,
    });
    await expect(
      approvals.byId(ownerLink.approvalRequestId, ownerLink.partyEntityId),
    ).resolves.toMatchObject({ state: "pending" });

    const restartedService = service();
    const exported = await restartedService.exportFor({
      principalEntityId: SELF_ENTITY_ID,
    });
    expect(
      exported.schedules.some(
        (entry) => entry.proposalId === proposal.proposalId,
      ),
    ).toBe(false);
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "rejected" });
    const recoveredLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    expect(recoveredLinks.every((link) => link.invalidatedAt !== null)).toBe(
      true,
    );
    await expect(
      approvals.byId(
        coParentLink.approvalRequestId,
        coParentLink.partyEntityId,
      ),
    ).resolves.toMatchObject({ state: "rejected" });
    await expect(
      approvals.byId(ownerLink.approvalRequestId, ownerLink.partyEntityId),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("persists the default approval window and rejects blank or expired responses", async () => {
    let clock = new Date("2027-03-10T00:00:00.000Z");
    const coordinator = service(() => new Date(clock));
    const childId = await person("expiry-child");
    await bindFamily({ childId });
    const proposal = await coordinator.createProposal({
      coordinationId: `expiry-${randomUUID()}`,
      terms: terms({
        summary: "Time-bounded household proposal",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    expect(proposal.expiresAt).toBe("2027-03-12T00:00:00.000Z");
    const [approvalLink] = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    if (!approvalLink) throw new Error("owner approval link missing");
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: SELF_ENTITY_ID,
        approvalRequestId: approvalLink.approvalRequestId,
        decision: "approve",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    await coordinator.respondToProposal({
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      partyEntityId: SELF_ENTITY_ID,
      approvalRequestId: approvalLink.approvalRequestId,
      decision: "approve",
      reason: "I approve these exact proposal bytes.",
    });
    clock = new Date("2027-03-12T00:00:00.000Z");
    await expect(
      coordinator.finalizeProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_APPROVAL" });
    await expect(
      householdRepository.getProposal(proposal.proposalId, proposal.version),
    ).resolves.toMatchObject({ status: "expired" });
    const expiredLinks = await householdRepository.listApprovalLinks(
      proposal.proposalId,
      proposal.version,
    );
    expect(expiredLinks.every((link) => link.invalidatedAt !== null)).toBe(
      true,
    );
    await expect(
      approvals.byId(
        approvalLink.approvalRequestId,
        approvalLink.partyEntityId,
      ),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("rejects invalid time zones and stale caller-supplied base versions before persistence", async () => {
    const childId = await person("contract-validation-child");
    await bindFamily({ childId });
    const coordinator = service();
    const invalidTimezoneProposalId = `invalid-timezone-${randomUUID()}`;
    await expect(
      coordinator.createProposal({
        proposalId: invalidTimezoneProposalId,
        coordinationId: `contract-validation-${randomUUID()}`,
        terms: {
          ...terms({
            summary: "Invalid time zone proposal",
            childEntityIds: [childId],
          }),
          timezone: "Mars/Phobos",
        },
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        createdByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_INVALID_CONTRACT" });
    await expect(
      householdRepository.getProposal(invalidTimezoneProposalId),
    ).resolves.toBeNull();

    const staleBaseProposalId = `stale-base-${randomUUID()}`;
    await expect(
      coordinator.createProposal({
        proposalId: staleBaseProposalId,
        coordinationId: `stale-base-coordination-${randomUUID()}`,
        terms: terms({
          summary: "Stale base proposal",
          childEntityIds: [childId],
        }),
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        createdByEntityId: SELF_ENTITY_ID,
        baseAgreementVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_STALE_BASE_AGREEMENT" });
    await expect(
      householdRepository.getProposal(staleBaseProposalId),
    ).resolves.toBeNull();
  });

  it("redacts details and audit payloads from a free/busy-only export", async () => {
    const childId = await person("redaction-child");
    const professionalId = await person("redaction-professional");
    await bindFamily({ childId, professionalId });
    const coordinator = service();
    await coordinator.issueGrant({
      principalEntityId: professionalId,
      role: "professional",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const secret = `secret-${randomUUID()}`;
    const proposal = await coordinator.createProposal({
      coordinationId: `redaction-${randomUUID()}`,
      terms: terms({
        summary: `Sensitive appointment ${secret}`,
        childEntityIds: [childId],
        secret,
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });

    const exported = await coordinator.exportFor({
      principalEntityId: professionalId,
    });
    expect(exported.schedules).toEqual([
      expect.objectContaining({
        proposalId: proposal.proposalId,
        startAt: proposal.terms.startAt,
        endAt: proposal.terms.endAt,
        details: null,
      }),
    ]);
    expect(exported.audit.length).toBeGreaterThan(0);
    expect(
      exported.audit.every(
        (event) =>
          Object.keys(event.inputs).length === 0 &&
          Object.keys(event.decision).length === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(secret);
  });

  it("converges an existing warning table to the durable cancellation outbox shape", async () => {
    await executeRawSql(
      runtime,
      `ALTER TABLE app_lifeops.life_household_grant_expiry_warning_claims
         DROP COLUMN cancellation_completed_at,
         DROP COLUMN cancellation_attempt_count,
         DROP COLUMN cancellation_last_error`,
    );

    const restartedRepository = new HouseholdCoordinationRepository(
      runtime,
      runtime.agentId,
    );
    await expect(
      restartedRepository.getGrantExpiryWarningIntent(
        `missing-grant-${randomUUID()}`,
      ),
    ).resolves.toBeNull();
    const columns = await executeRawSql(
      runtime,
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'app_lifeops'
          AND table_name = 'life_household_grant_expiry_warning_claims'
          AND column_name IN (
            'cancellation_completed_at',
            'cancellation_attempt_count',
            'cancellation_last_error'
          )
        ORDER BY column_name`,
    );
    expect(columns).toEqual([
      expect.objectContaining({
        column_name: "cancellation_attempt_count",
        is_nullable: "NO",
      }),
      expect.objectContaining({
        column_name: "cancellation_completed_at",
        is_nullable: "YES",
      }),
      expect.objectContaining({
        column_name: "cancellation_last_error",
        is_nullable: "YES",
      }),
    ]);
    expect(String(columns[0]?.column_default)).toContain("0");
  });

  it("lets a caregiver with schedule.propose create a proposal without mutation authority", async () => {
    const childId = await person("propose-child");
    const caregiverId = await person("propose-caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service();
    const attempt = () =>
      coordinator.createProposal({
        coordinationId: `caregiver-propose-${randomUUID()}`,
        terms: terms({
          summary: "Caregiver-suggested pickup",
          childEntityIds: [childId],
        }),
        affectedPartyEntityIds: [childId],
        requiredApproverEntityIds: [SELF_ENTITY_ID],
        createdByEntityId: caregiverId,
      });
    await expect(attempt()).rejects.toMatchObject({
      code: "HOUSEHOLD_ACCESS_DENIED",
    });
    await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["schedule.propose"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const proposal = await attempt();
    expect(proposal.createdByEntityId).toBe(caregiverId);
    expect(proposal.status).toBe("pending");
    // Proposing never confers direct mutation authority.
    await expect(
      coordinator.requireScope({
        principalEntityId: caregiverId,
        subjectEntityId: childId,
        scope: "calendar.mutate",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
  });

  it("refuses approval responses from a party whose standing was removed after routing", async () => {
    const childId = await person("standing-child");
    const coParentId = await person("standing-co-parent");
    await bindFamily({ childId, coParentId });
    const coordinator = service();
    const proposal = await coordinator.createProposal({
      coordinationId: `standing-${randomUUID()}`,
      terms: terms({
        summary: "Weekend handoff",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, coParentId],
      requiredApproverEntityIds: [coParentId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const link = (
      await householdRepository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      )
    ).find((candidate) => candidate.partyEntityId === coParentId);
    if (!link) throw new Error("co-parent approval link missing");
    const binding = (await coordinator.listRoleBindings()).find(
      (candidate) => candidate.entityId === coParentId,
    );
    if (!binding?.relationshipId) {
      throw new Error("co-parent relationship binding missing");
    }
    // Narrow the co-parent's relationship so it no longer covers the child.
    await coordinator.bindRole({
      entityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [],
      relationshipId: binding.relationshipId,
      evidence: "Owner removed this child from the co-parent relationship.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: coParentId,
        approvalRequestId: link.approvalRequestId,
        decision: "approve",
        reason: "I approve these exact proposal bytes.",
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_ACCESS_DENIED" });
    // Restoring coverage restores intrinsic approval standing.
    await coordinator.bindRole({
      entityId: coParentId,
      role: "co_parent",
      subjectEntityIds: [childId],
      relationshipId: binding.relationshipId,
      evidence: "Owner restored the co-parent relationship to the child.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: coParentId,
        approvalRequestId: link.approvalRequestId,
        decision: "approve",
        reason: "I approve these exact proposal bytes.",
      }),
    ).resolves.toMatchObject({ state: "approved" });
  });

  it("requires a revocable schedule.approve grant for caregiver approval standing", async () => {
    const childId = await person("approval-grant-child");
    const caregiverId = await person("approval-grant-caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service();
    const proposal = await coordinator.createProposal({
      coordinationId: `caregiver-approval-${randomUUID()}`,
      terms: terms({
        summary: "Caregiver handoff approval",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId, caregiverId],
      requiredApproverEntityIds: [caregiverId],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const link = (
      await householdRepository.listApprovalLinks(
        proposal.proposalId,
        proposal.version,
      )
    ).find((candidate) => candidate.partyEntityId === caregiverId);
    if (!link) throw new Error("caregiver approval link missing");
    const respond = () =>
      coordinator.respondToProposal({
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        partyEntityId: caregiverId,
        approvalRequestId: link.approvalRequestId,
        decision: "approve",
        reason: "I approve these exact proposal bytes.",
      });
    await expect(respond()).rejects.toMatchObject({
      code: "HOUSEHOLD_ACCESS_DENIED",
    });
    await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["schedule.approve"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await expect(respond()).resolves.toMatchObject({ state: "approved" });
  });

  it("withholds the audit trail from principals without the household.export scope", async () => {
    const childId = await person("audit-scope-child");
    const caregiverId = await person("audit-scope-caregiver");
    await bindFamily({ childId, caregiverId });
    const coordinator = service();
    const grant = await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    expect(grant.scopes).not.toContain("household.export");
    await coordinator.createProposal({
      coordinationId: `audit-scope-${randomUUID()}`,
      terms: terms({
        summary: "Visible schedule, private history",
        childEntityIds: [childId],
      }),
      affectedPartyEntityIds: [childId],
      requiredApproverEntityIds: [SELF_ENTITY_ID],
      createdByEntityId: SELF_ENTITY_ID,
    });
    const withoutExport = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(withoutExport.schedules).toHaveLength(1);
    expect(withoutExport.effectiveScopes).not.toContain("household.export");
    expect(withoutExport.audit).toEqual([]);

    await coordinator.revokeGrant({
      grantId: grant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Replacing the view-only grant with an exporting grant.",
    });
    await coordinator.issueGrant({
      principalEntityId: caregiverId,
      role: "caregiver",
      subjectEntityIds: [childId],
      scopes: ["calendar.freebusy", "household.export"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const withExport = await coordinator.exportFor({
      principalEntityId: caregiverId,
    });
    expect(withExport.effectiveScopes).toContain("household.export");
    expect(withExport.audit.length).toBeGreaterThan(0);
  });
});
