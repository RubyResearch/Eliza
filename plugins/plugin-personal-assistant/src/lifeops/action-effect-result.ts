/**
 * Binds LifeOps action text to one validated effect outcome before the shared
 * action-settlement boundary can deliver it. Callers must supply persisted
 * resource identifiers and authoritative timestamps; this module never
 * invents commit proof or substitutes request-local placeholders for a write.
 */

import {
  type ActionResult,
  type EffectIdempotency,
  type EffectReceipt,
  type EffectResourceRef,
  ElizaError,
  type HandlerCallback,
  normalizeEffectReceipt,
} from "@elizaos/core";

interface LifeOpsEffectBaseInput {
  receiptId: string;
  operation: string;
  resource: EffectResourceRef;
  artifacts: readonly EffectResourceRef[];
  idempotency: EffectIdempotency;
  observedAt: string;
}

interface LifeOpsAppliedEffectInput extends LifeOpsEffectBaseInput {
  commit: {
    kind: "durable" | "provider_accepted";
    id: string;
    committedAt: string;
  };
}

interface LifeOpsNoopEffectInput extends LifeOpsEffectBaseInput {
  reason: string;
}

interface LifeOpsFailedEffectInput extends LifeOpsEffectBaseInput {
  failure: {
    code: string;
    retryable: boolean;
    acceptance: "rejected" | "unknown";
  };
}

/** Validate durable proof supplied by the store or provider that committed it. */
export function lifeOpsAppliedEffect(
  input: LifeOpsAppliedEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "applied",
  });
}

/** Describe a verified read/evaluation outcome without claiming a mutation. */
export function lifeOpsNoopEffect(
  input: LifeOpsNoopEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "noop",
  });
}

/** Describe a rejected or ambiguous mutation attempt without commit proof. */
export function lifeOpsFailedEffect(
  input: LifeOpsFailedEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "failed",
  });
}

/**
 * Make the action's exact text canonical and bind it to the supplied outcome.
 * The callback intentionally contains text only: core adds authenticated
 * receipt IDs after validating the returned result.
 */
export async function completeLifeOpsEffect(
  callback: HandlerCallback | undefined,
  result: ActionResult,
  receipt: EffectReceipt,
): Promise<ActionResult> {
  const normalizedReceipt = normalizeEffectReceipt(receipt);
  if (
    result.replyFailure ||
    (result.transcriptVisibility === "internal" &&
      typeof result.data?.replyGrounding === "string") ||
    (result.transcriptVisibility === "internal" &&
      !result.text?.trim() &&
      !result.userFacingText?.trim() &&
      !result.modelReplyFallback?.trim())
  ) {
    // Preserve settled effects without inventing presentation. Typed renderer
    // failures remain system statuses; explicit internal evidence remains
    // available to the planner's evaluation step for its final response.
    // `turnComplete:false` is the contract for "evaluation required": keep it
    // for failed receipts, reply failures and pauses that wait on the user.
    // A settled successful effect keeps the action's own signal (omitted by
    // actions that hand canonical receipt facts to the runtime's grounded
    // render; owner ruling 2026-09-05), so this wrapper no longer forces every
    // internal result back into a full evaluation.
    const data = result.data as Record<string, unknown> | undefined;
    const evaluationRequired =
      Boolean(result.replyFailure) ||
      result.success !== true ||
      normalizedReceipt.outcome === "failed" ||
      data?.requiresInput === true ||
      data?.approvalRequired === true;
    return {
      ...result,
      transcriptVisibility: "internal",
      ...(evaluationRequired ? { turnComplete: false } : {}),
      effectReceipts: [normalizedReceipt],
    };
  }
  const text = result.text?.trim();
  if (!text) {
    throw new ElizaError(
      "A user-facing LifeOps effect result requires exact text",
      {
        code: "LIFEOPS_EFFECT_TEXT_REQUIRED",
        context: {},
        severity: "fatal",
      },
    );
  }
  const canonical: ActionResult = {
    ...result,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    // The callback below is this turn's single visible delivery of the exact
    // canonical text, so settlement also declares the turn complete (unless
    // the action explicitly disclaimed it with `turnComplete: false`). That
    // opts into the planner's gated-evaluator skip, which keeps the model from
    // shipping a second paraphrase of an answer the user already has. This
    // covers failures too: a verified failure text IS the turn's answer, and
    // the live alternative was two bubbles ("calendar's acting up" plus a
    // model paraphrase). Sites that want the evaluator to add a genuinely
    // additive follow-up disclaim explicitly.
    turnComplete: result.turnComplete ?? true,
    effectReceipts: [normalizedReceipt],
    userFacingEffectReceiptIds: [normalizedReceipt.receiptId],
  };
  await callback?.({ text });
  return canonical;
}
