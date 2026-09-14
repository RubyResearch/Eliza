/**
 * Owner chat action for reviewing, pinning, and permission-previewing the
 * canonical parenting-agreement records. Binary PDF ingestion remains on the
 * authenticated HTTP/document surface; this action never creates file bytes.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  ProviderValue,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  AgreementKnowledgeError,
  getAgreementKnowledgeService,
} from "../lifeops/household/agreement-knowledge.js";

type AgreementAction =
  | "list"
  | "read"
  | "approve"
  | "reject"
  | "pin"
  | "unpin"
  | "preview_guest_grant";

function parameters(options: HandlerOptions | undefined) {
  const value = options?.parameters;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AgreementKnowledgeError(
      `${key} is required`,
      "AGREEMENT_INVALID_CONTRACT",
      { field: key },
    );
  }
  return value.trim();
}

function failure(error: unknown): ActionResult {
  if (error instanceof AgreementKnowledgeError) {
    return {
      success: false,
      text: error.message,
      data: { error: { code: error.code, context: error.context } },
    };
  }
  throw error;
}

export const ownerAgreementKnowledgeAction: Action = {
  name: "OWNER_AGREEMENT_KNOWLEDGE",
  similes: [
    "PARENTING_AGREEMENT",
    "COPARENTING_AGREEMENT",
    "PIN_PARENTING_AGREEMENT",
    "REVIEW_PARENTING_OBLIGATION",
  ],
  description:
    "Owner parenting-agreement review and access management. Ops: list|read|approve|reject|pin|unpin|preview_guest_grant. Upload PDF bytes through the authenticated agreement API/document picker.",
  descriptionCompressed:
    "owner parenting agreement: list/read/review/pin/unpin/preview guest access",
  routingHint:
    "parenting or coparenting agreement knowledge, reviewed obligations, pins, or guest access preview -> OWNER_AGREEMENT_KNOWLEDGE",
  tags: ["domain:family", "capability:read", "capability:write"],
  contexts: ["family", "documents", "contacts"],
  roleGate: { minRole: "OWNER" },
  validate: hasLifeOpsAccess,
  parameters: [
    {
      name: "action",
      description:
        "Agreement op: list|read|approve|reject|pin|unpin|preview_guest_grant.",
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          "list",
          "read",
          "approve",
          "reject",
          "pin",
          "unpin",
          "preview_guest_grant",
        ],
      },
    },
    {
      name: "artifactId",
      description: "Immutable agreement artifact identifier.",
      schema: { type: "string" as const },
    },
    {
      name: "obligationId",
      description: "Proposed obligation identifier to approve or reject.",
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Owner-provided reason for a review or revocation decision.",
      schema: { type: "string" as const },
    },
    {
      name: "targetType",
      description: "Pin destination kind: agent or chat.",
      schema: { type: "string" as const, enum: ["agent", "chat"] },
    },
    {
      name: "targetId",
      description: "Agent or chat identifier receiving the pin.",
      schema: { type: "string" as const },
    },
    {
      name: "pinId",
      description: "Existing agreement pin identifier to remove.",
      schema: { type: "string" as const },
    },
    {
      name: "principalEntityId",
      description: "Guest entity whose effective read access is previewed.",
      schema: { type: "string" as const },
    },
    {
      name: "householdGrantId",
      description: "Household grant that would authorize the guest read.",
      schema: { type: "string" as const },
    },
  ],
  async handler(runtime, _message, _state, options) {
    const service = getAgreementKnowledgeService(runtime);
    if (!service) {
      return {
        success: false,
        text: "Agreement knowledge is unavailable.",
        data: { error: { code: "AGREEMENT_STORAGE_UNAVAILABLE" } },
      };
    }
    const input = parameters(options);
    const action = text(input, "action") as AgreementAction;
    try {
      let result: ProviderValue;
      switch (action) {
        case "list":
          result = await service.listOwnerAgreements({
            ownerEntityId: SELF_ENTITY_ID,
          });
          break;
        case "read":
          result = await service.readFor({
            artifactId: text(input, "artifactId"),
            principalEntityId: SELF_ENTITY_ID,
          });
          break;
        case "approve":
        case "reject":
          result = await service.decideObligation({
            obligationId: text(input, "obligationId"),
            decision: action,
            decidedByEntityId: SELF_ENTITY_ID,
            reason: text(input, "reason"),
          });
          break;
        case "pin": {
          const targetType = text(input, "targetType");
          if (targetType !== "agent" && targetType !== "chat") {
            throw new AgreementKnowledgeError(
              "targetType must be agent or chat",
              "AGREEMENT_INVALID_CONTRACT",
              { targetType },
            );
          }
          result = await service.pin({
            artifactId: text(input, "artifactId"),
            targetType,
            targetId: text(input, "targetId"),
            pinnedByEntityId: SELF_ENTITY_ID,
          });
          break;
        }
        case "unpin":
          result = await service.unpin({
            pinId: text(input, "pinId"),
            unpinnedByEntityId: SELF_ENTITY_ID,
          });
          break;
        case "preview_guest_grant":
          result = await service.previewGuestRead({
            artifactId: text(input, "artifactId"),
            principalEntityId: text(input, "principalEntityId"),
            householdGrantId: text(input, "householdGrantId"),
            ownerEntityId: SELF_ENTITY_ID,
          });
          break;
        default:
          throw new AgreementKnowledgeError(
            "Unknown agreement action",
            "AGREEMENT_INVALID_CONTRACT",
            { action },
          );
      }
      return {
        success: true,
        text: `Agreement ${action.replaceAll("_", " ")} completed.`,
        data: { action, result },
      };
    } catch (error) {
      return failure(error);
    }
  },
};
