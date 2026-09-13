/**
 * Injects owner-approved obligations from active agent and chat pins into the
 * planner turn. Pins select already-authorized owner knowledge; they never
 * participate in guest authorization or widen a resource grant.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import { ElizaError, type Memory, type Provider } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { getAgreementKnowledgeService } from "../lifeops/household/agreement-knowledge.js";

export const agreementPinsProvider: Provider = {
  name: "agreementPins",
  description:
    "Approved parenting-agreement obligations pinned to this agent or chat.",
  descriptionCompressed:
    "Owner-approved, page-cited parenting-agreement obligations from active pins.",
  dynamic: true,
  alwaysInResponseState: true,
  position: -8,
  cacheScope: "turn",

  async get(runtime, message: Memory) {
    const service = getAgreementKnowledgeService(runtime);
    if (!service) {
      return { text: "", values: { agreementPinCount: 0 }, data: {} };
    }
    const owner = await hasOwnerAccess(runtime, message);
    const principalEntityId = owner ? SELF_ENTITY_ID : message.entityId;
    if (typeof principalEntityId !== "string" || !principalEntityId.trim()) {
      return { text: "", values: { agreementPinCount: 0 }, data: {} };
    }
    let views: Awaited<
      ReturnType<typeof service.activePinnedContextForPrincipal>
    >;
    try {
      views = await service.activePinnedContextForPrincipal({
        principalEntityId,
        roomId: typeof message.roomId === "string" ? message.roomId : undefined,
      });
    } catch (error) {
      // error-policy:J4 Revoked family context is explicit; unrelated planner work remains usable.
      if (
        !(error instanceof ElizaError) ||
        error.code !== "FAMILY_WORKSPACE_FENCED"
      )
        throw error;
      return {
        text: "Family workspace access has been revoked. Parenting-agreement context is unavailable.",
        values: { agreementPinStatus: "revoked" },
        data: { agreementContext: { status: "revoked" } },
      };
    }
    if (views.length === 0) {
      return { text: "", values: { agreementPinCount: 0 }, data: {} };
    }
    const text = views
      .map((view) => {
        const obligations = view.obligations
          .map(
            (obligation) =>
              `- ${obligation.title}: ${obligation.obligationText} (source pages ${obligation.pageStart}-${obligation.pageEnd}; reviewed citation: ${obligation.citationText})`,
          )
          .join("\n");
        const ownerDigest =
          "contentSha256" in view.artifact
            ? `, SHA-256 ${view.artifact.contentSha256}`
            : "";
        return `Pinned parenting agreement: ${view.artifact.title}, immutable version ${view.artifact.version}${ownerDigest}\n${obligations}`;
      })
      .join("\n\n");
    return {
      text,
      values: {
        agreementPinCount: views.length,
        approvedAgreementObligationCount: views.reduce(
          (sum, view) => sum + view.obligations.length,
          0,
        ),
      },
      data: { agreements: views },
    };
  },
};
