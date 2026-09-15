/**
 * Deterministic chat-action coverage for agreement access previews. The test
 * proves the action selects the canonical service, fixes the actor to owner,
 * and returns the domain's machine-readable permission effects unchanged.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ownerAgreementKnowledgeAction } from "./agreement-knowledge.js";

describe("OWNER_AGREEMENT_KNOWLEDGE", () => {
  it("returns prepared review proposals without invoking owner approval or sharing", async () => {
    const review = {
      artifactId: "artifact-1",
      outcome: "no_proposals",
      generatedAt: "2026-09-13T00:00:00Z",
      explanation: "Owner must inspect the synthetic source",
      obligations: [],
    };
    const prepareOwnerReview = vi.fn(async () => review);
    const decideObligation = vi.fn();
    const pin = vi.fn();
    const runtime = {
      getService: () => ({
        agreements: { prepareOwnerReview, decideObligation, pin },
      }),
    } as unknown as IAgentRuntime;
    const result = await ownerAgreementKnowledgeAction.handler?.(
      runtime,
      { entityId: "self" } as Memory,
      undefined,
      {
        parameters: {
          action: "prepare_review",
          artifactId: "artifact-1",
          ownerEntityId: "forged-actor",
        },
      },
      undefined,
    );
    expect(prepareOwnerReview).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      ownerEntityId: "self",
    });
    expect(result).toMatchObject({
      success: true,
      data: { action: "prepare_review", result: review },
    });
    expect(decideObligation).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });

  it("previews bounded guest effects without issuing access", async () => {
    const previewGuestRead = vi.fn(async () => ({
      allowed: true,
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: null,
    }));
    const runtime = {
      getService: vi.fn(() => ({ agreements: { previewGuestRead } })),
    } as unknown as IAgentRuntime;
    const result = await ownerAgreementKnowledgeAction.handler?.(
      runtime,
      { entityId: "self" } as Memory,
      undefined,
      {
        parameters: {
          action: "preview_guest_grant",
          artifactId: "artifact-1",
          principalEntityId: "guest-1",
          householdGrantId: "household-grant-1",
        },
      },
      undefined,
    );
    expect(previewGuestRead).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      ownerEntityId: "self",
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: "preview_guest_grant",
        result: {
          effects: ["read_artifact_metadata", "read_approved_obligations"],
          exclusions: [
            "read_proposed_or_rejected_obligations",
            "mutate_agreement",
            "inherit_access_from_pin",
          ],
        },
      },
    });
  });
});
