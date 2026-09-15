/**
 * Projects reviewed correspondence into monthly packet claims and revalidates
 * the same immutable source binding at external draft and approval boundaries.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  getFamilyIntakeService,
  type ReviewedFamilyIntakeFact,
} from "./intake-service.js";
import type { FamilyPacketClaim } from "./monthly-packet.js";

export function familyIntakeClaim(
  value: ReviewedFamilyIntakeFact,
): FamilyPacketClaim {
  const { fact, binding, source, reviewedAt } = value;
  return {
    claimId: `intake:${binding.reviewId}:${fact.id}`,
    stableKey: `intake:${binding.reviewId}:${fact.id}`,
    section: fact.section,
    statement: fact.statement,
    visibility:
      fact.recipientEntityIds.length > 0 ? "guest_shareable" : "owner_only",
    provenance: [
      {
        source: "correspondence",
        sourceId: source.documentId,
        observedAt: reviewedAt,
        contentSha256: source.contentSha256,
      },
    ],
    dates: fact.dates,
    requests: fact.requests,
    urgency: fact.urgency,
    commitments: fact.commitments,
    accountability: fact.accountability,
    recipientEntityIds: fact.recipientEntityIds,
    unanswered: fact.unanswered,
    intakeBinding: binding,
  };
}

export async function validateFamilyIntakeClaim(
  runtime: IAgentRuntime,
  claim: FamilyPacketClaim,
  recipientEntityId: string,
): Promise<void> {
  if (!claim.intakeBinding)
    throw new ElizaError("Correspondence claim is missing its source review", {
      code: "FAMILY_INTAKE_BINDING_REQUIRED",
    });
  const current = await getFamilyIntakeService(runtime).validateDisclosure(
    claim.intakeBinding,
    recipientEntityId,
  );
  const expected = familyIntakeClaim(current);
  const fields = [
    "section",
    "statement",
    "visibility",
    "provenance",
    "dates",
    "requests",
    "urgency",
    "commitments",
    "accountability",
    "recipientEntityIds",
    "unanswered",
  ] as const;
  if (
    fields.some(
      (field) =>
        JSON.stringify(claim[field]) !== JSON.stringify(expected[field]),
    )
  )
    throw new ElizaError("The packet fact differs from its reviewed source", {
      code: "FAMILY_INTAKE_CLAIM_CHANGED",
    });
}
