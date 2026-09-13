/** Settles immutable compute state and price transitions under the workload row lock. */

import Decimal from "decimal.js";
import { and, asc, eq, lte } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { computeBillingRateSegments } from "../schemas/compute-billing-rate-segments";

export interface SettledComputeRateSegment {
  state: string;
  ratePerHour: string;
  startedAt: string;
  endedAt: string;
  amount: string;
}

// The INSERT trigger timestamps the first immutable rate segment with
// clock_timestamp(), while the sandbox row's created_at default is evaluated
// slightly earlier in the same statement. Allow only that small, expected
// trigger gap; a materially incomplete history must still fail closed.
const INITIAL_RATE_SEGMENT_TRIGGER_GAP_MS = 5_000;

export async function settleComputeRateSegments(
  tx: DbTransaction,
  input: {
    organizationId: string;
    workloadKind: "agent" | "container";
    workloadId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<{ amount: Decimal; segments: SettledComputeRateSegment[] }> {
  if (input.periodEnd <= input.periodStart) return { amount: new Decimal(0), segments: [] };
  const history = await tx
    .select({
      lifecycle_revision: computeBillingRateSegments.lifecycle_revision,
      billing_state: computeBillingRateSegments.billing_state,
      rate_per_hour: computeBillingRateSegments.rate_per_hour,
      effective_at: computeBillingRateSegments.effective_at,
    })
    .from(computeBillingRateSegments)
    .where(
      and(
        eq(computeBillingRateSegments.organization_id, input.organizationId),
        eq(computeBillingRateSegments.workload_kind, input.workloadKind),
        eq(computeBillingRateSegments.workload_id, input.workloadId),
        lte(computeBillingRateSegments.effective_at, input.periodEnd),
      ),
    )
    .orderBy(asc(computeBillingRateSegments.effective_at), asc(computeBillingRateSegments.id));
  let baseIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.effective_at <= input.periodStart) {
      baseIndex = index;
      break;
    }
  }
  if (baseIndex < 0) {
    const firstEntry = history[0];
    if (
      firstEntry &&
      (firstEntry.effective_at.getTime() - input.periodStart.getTime() <=
        INITIAL_RATE_SEGMENT_TRIGGER_GAP_MS ||
        // A new workload's revision-zero, non-billable segment proves it had
        // no billable runtime before the INSERT trigger. Transaction start
        // (created_at) can precede that trigger by more than five seconds under
        // load. Extend only this explicit zero-rate creation state backward;
        // later revisions or running states cannot fill missing history.
        (firstEntry.lifecycle_revision === 0 &&
          firstEntry.billing_state === "not_billable" &&
          new Decimal(firstEntry.rate_per_hour).isZero()))
    ) {
      baseIndex = 0;
    }
  }
  if (baseIndex < 0) {
    throw new Error(
      `Compute billing rate history is missing at ${input.periodStart.toISOString()} for ${input.workloadKind} ${input.workloadId}`,
    );
  }
  const relevant = [
    history[baseIndex],
    ...history.slice(baseIndex + 1).filter((entry) => entry.effective_at > input.periodStart),
  ];
  let amount = new Decimal(0);
  const segments: SettledComputeRateSegment[] = [];
  for (let index = 0; index < relevant.length; index += 1) {
    const entry = relevant[index]!;
    const startedAt = index === 0 ? input.periodStart : entry.effective_at;
    const endedAt = relevant[index + 1]?.effective_at ?? input.periodEnd;
    if (endedAt <= startedAt) continue;
    const rate = new Decimal(entry.rate_per_hour);
    if (!rate.isFinite() || rate.isNegative()) {
      throw new Error("Compute billing rate history contains an invalid numeric rate");
    }
    const segmentAmount = rate.mul(endedAt.getTime() - startedAt.getTime()).div(60 * 60 * 1000);
    amount = amount.plus(segmentAmount);
    segments.push({
      state: entry.billing_state,
      ratePerHour: rate.toFixed(6),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      amount: segmentAmount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6),
    });
  }
  return { amount: amount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP), segments };
}
