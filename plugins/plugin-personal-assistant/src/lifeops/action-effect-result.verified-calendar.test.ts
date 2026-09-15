/**
 * A calendar result that verified its own settlement (text, userFacingText,
 * verifiedUserFacing, turnComplete) must pass through the lifeops wrapper as
 * the canonical user-facing delivery: text kept, receipt bound, callback once.
 * Live 2026-09-14: the same result without `text` made the wrapper throw
 * after the mutation had applied, the planner retried, and the user was told
 * the calendar refused the change.
 */
import type { ActionResult } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
} from "./action-effect-result.js";

const SENTENCE = "Moved “Notary Appointment” to Friday, Sep 18 at 4pm EDT.";

function appliedReceipt() {
  return lifeOpsAppliedEffect({
    receiptId: "calendar-receipt-v1:test",
    operation: "calendar.event.update",
    resource: { kind: "calendar.event", id: "evt-1", version: "1" },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: "2026-09-14T06:00:00.000Z",
    commit: {
      kind: "durable",
      id: "evt-1",
      committedAt: "2026-09-14T06:00:00.000Z",
    },
  });
}

function verifiedResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    success: true,
    transcriptVisibility: "internal",
    text: SENTENCE,
    userFacingText: SENTENCE,
    verifiedUserFacing: true,
    turnComplete: true,
    effectReceipts: [appliedReceipt()],
    userFacingEffectReceiptIds: ["calendar-receipt-v1:test"],
    data: { actionName: "CALENDAR", subaction: "update_event" },
    ...overrides,
  };
}

describe("completeLifeOpsEffect with a self-verified calendar result", () => {
  it("keeps the sentence as the canonical text, binds the receipt and delivers once", async () => {
    const callback = vi.fn(async () => []);
    const canonical = await completeLifeOpsEffect(
      callback,
      verifiedResult(),
      appliedReceipt(),
    );

    expect(canonical).toMatchObject({
      success: true,
      text: SENTENCE,
      userFacingText: SENTENCE,
      verifiedUserFacing: true,
      turnComplete: true,
      userFacingEffectReceiptIds: ["calendar-receipt-v1:test"],
    });
    expect(canonical.effectReceipts).toHaveLength(1);
    expect(canonical.effectReceipts?.[0]?.outcome).toBe("applied");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ text: SENTENCE });
    // The verified sentence is the visible transcript, never "internal"
    // (live: API-room calendar replies were delivered but not persisted).
    expect(canonical.transcriptVisibility).toBeUndefined();
  });

  it("rejects a user-facing result that carries no exact text", async () => {
    await expect(
      completeLifeOpsEffect(
        vi.fn(async () => []),
        verifiedResult({ text: undefined }),
        appliedReceipt(),
      ),
    ).rejects.toMatchObject({ code: "LIFEOPS_EFFECT_TEXT_REQUIRED" });
  });
});
