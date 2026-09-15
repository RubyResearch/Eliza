/**
 * LifeOps effect completion when the grounded reply renderer was unavailable:
 * the receipt is bound and the typed reply failure passes through instead of
 * the exact-text requirement failing the completed action. Pure function
 * coverage with real core reply helpers; no runtime, model, or database.
 */
import type { ActionResult } from "@elizaos/core";
import {
  applyGroundedActionReply,
  createUnavailableGroundedActionReply,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  completeLifeOpsEffect,
  lifeOpsNoopEffect,
} from "./action-effect-result";

const receipt = lifeOpsNoopEffect({
  receiptId: "calendar-request-receipt-v1:test",
  operation: "calendar.request.evaluate",
  resource: {
    kind: "calendar.request",
    id: "calendar-request-resource-v1:test",
  },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-09-05T05:35:05.000Z",
  reason: "A verified read completed.",
});

describe("completeLifeOpsEffect with an unavailable grounded reply", () => {
  it("keeps deferred grounding and internal text without promoting it to a visible reply", async () => {
    const callback = vi.fn(async () => []);
    const result = applyGroundedActionReply(
      {
        success: true,
        text: "  Exact internal result 🦊  ",
        data: { definition: { id: "definition-1" } },
      },
      { kind: "deferred", grounding: "Complete action facts and rules" },
    );
    const completed = await completeLifeOpsEffect(callback, result, receipt);
    expect(completed).toEqual({ ...result, effectReceipts: [receipt] });
    expect(completed.text).toBe("  Exact internal result 🦊  ");
    expect(completed.data?.replyGrounding).toBe(
      "Complete action facts and rules",
    );
    expect(completed.userFacingText).toBeUndefined();
    expect(completed.turnComplete).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
  it("binds the receipt and passes the typed reply failure through without a callback", async () => {
    const settled = applyGroundedActionReply(
      {
        success: true,
        text: "",
        userFacingText: "",
        verifiedUserFacing: true,
        turnComplete: true,
      } as ActionResult,
      createUnavailableGroundedActionReply({
        kind: "rate_limited",
        code: "GROUNDED_REPLY_GENERATION_FAILED",
      }),
    );
    const callback = vi.fn(async () => []);

    const completed = await completeLifeOpsEffect(callback, settled, receipt);

    expect(completed.success).toBe(true);
    expect(completed.replyFailure).toMatchObject({
      kind: "rate_limited",
      code: "GROUNDED_REPLY_GENERATION_FAILED",
      transient: false,
    });
    expect(completed.effectReceipts).toEqual([receipt]);
    expect(completed.userFacingText).toBeUndefined();
    expect(completed.verifiedUserFacing).toBeUndefined();
    expect(completed.turnComplete).toBe(false);
    expect(completed.transcriptVisibility).toBe("internal");
    expect(callback).not.toHaveBeenCalled();
  });

  it("still requires exact text when no reply failure is declared", async () => {
    await expect(
      completeLifeOpsEffect(undefined, { success: true, text: "  " }, receipt),
    ).rejects.toMatchObject({ code: "LIFEOPS_EFFECT_TEXT_REQUIRED" });
  });

  it("preserves explicit internal evidence for the evaluator without canonicalizing a reply", async () => {
    const callback = vi.fn(async () => []);
    const result: ActionResult = {
      success: false,
      transcriptVisibility: "internal",
      turnComplete: false,
      data: {
        replyContext: {
          scenario: "delete_event_not_found",
          facts: "The target was absent.",
        },
      },
    };
    expect(await completeLifeOpsEffect(callback, result, receipt)).toEqual({
      ...result,
      effectReceipts: [receipt],
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("validates receipt proof before preserving an internal result", async () => {
    await expect(
      completeLifeOpsEffect(
        undefined,
        {
          success: true,
          transcriptVisibility: "internal",
        },
        { ...receipt, receiptId: "" },
      ),
    ).rejects.toThrow();
  });

  it("keeps an explicit visible interaction canonical", async () => {
    const callback = vi.fn(async () => []);
    const text =
      'Choose an event:\n```json\n{"type":"choice","id":"saved-approval"}\n```';
    const result = await completeLifeOpsEffect(
      callback,
      {
        success: true,
        text,
        data: { awaitingUserInput: true },
      },
      receipt,
    );
    expect(result.userFacingText).toBe(text);
    expect(result.userFacingEffectReceiptIds).toEqual([receipt.receiptId]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ text });
  });
});
