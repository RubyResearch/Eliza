/** Exchanges held Dedicated funds and records metered usage without a second cash debit. */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import type { AgentHourlyBillingInput } from "../../db/repositories/agent-billing";
import { parseOrgCreditBalance } from "../../db/repositories/agent-billing-numeric";
import type { settleComputeRateSegments } from "../../db/repositories/compute-billing-segments";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { agentBillingRecords } from "../../db/schemas/compute-billing";
import { organizations } from "../../db/schemas/organizations";
import {
  AGENT_COMPUTE_FUNDING_EXPIRED,
  AGENT_COMPUTE_FUNDING_UNCONFIRMED,
  agentComputeFundingService,
} from "./agent-compute-funding";
import { enqueueAgentComputeLeaseInTransaction } from "./agent-compute-lease-jobs";
import { AGENT_COMPUTE_RETIREMENT_LEAD_MS } from "./agent-compute-policy";
import { SUBSCRIPTION_FUNDING_INSUFFICIENT } from "./subscription-funding";

export async function settleFundedAgentBillingInTransaction(
  tx: DbTransaction,
  input: AgentHourlyBillingInput,
  meter: Awaited<ReturnType<typeof settleComputeRateSegments>>,
  periodStart: Date,
  lifecycleRevision: number,
  requiresLifecycleReconciliation: boolean,
) {
  const [window] = await tx
    .select()
    .from(agentComputeFunding)
    .where(
      and(
        eq(agentComputeFunding.agent_id, input.sandboxId),
        eq(agentComputeFunding.organization_id, input.organizationId),
        isNull(agentComputeFunding.settled_at),
      ),
    )
    .for("update");
  if (!window) return null;
  if (requiresLifecycleReconciliation || window.period_start.getTime() !== periodStart.getTime()) {
    throw new ElizaError("Dedicated funding requires lifecycle reconciliation before billing", {
      code: "AGENT_COMPUTE_BILLING_RECONCILIATION_REQUIRED",
      severity: "ephemeral",
    });
  }
  const amountDecimal = meter.amount.toFixed(6);
  let renewed: Awaited<ReturnType<typeof agentComputeFundingService.renewInTransaction>>;
  try {
    renewed = await agentComputeFundingService.renewInTransaction(tx, {
      agentId: input.sandboxId,
      organizationId: input.organizationId,
      lifecycleRevision,
      fundingId: window.id,
      settledThrough: input.now,
      actualAmount: amountDecimal,
    });
  } catch (error) {
    // Running out of additional cash does not revoke an already confirmed
    // hold. Other authority failures, including cancellation, still stop now.
    if (
      error instanceof ElizaError &&
      error.code === SUBSCRIPTION_FUNDING_INSUFFICIENT &&
      window.host_lease_confirmed_at
    ) {
      const stopAfter = new Date(window.period_end.getTime() - AGENT_COMPUTE_RETIREMENT_LEAD_MS);
      if (stopAfter > (await readPostLockDatabaseNow(tx))) {
        return { status: "funded_until" as const, fundedUntil: window.period_end, stopAfter };
      }
    }
    // error-policy:J4 A denied renewal enters the canonical stop path. The
    // savepoint preserves the existing hold until the host stop is reconciled,
    // including when cancellation or expiry withdrew subscription authority.
    if (
      error instanceof ElizaError &&
      [
        SUBSCRIPTION_FUNDING_INSUFFICIENT,
        "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
        "ORGANIZATION_POLICY_UNAVAILABLE",
        AGENT_COMPUTE_FUNDING_EXPIRED,
        AGENT_COMPUTE_FUNDING_UNCONFIRMED,
      ].includes(error.code)
    ) {
      return { status: "insufficient_credits" as const };
    }
    throw error;
  }
  const [organization] = await tx
    .select({ balance: organizations.credit_balance })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId));
  if (!organization) throw new Error("Dedicated funding organization disappeared");
  const newBalance = parseOrgCreditBalance(organization.balance);
  const effectiveRate = meter.amount
    .mul(3_600_000)
    .div(input.now.getTime() - periodStart.getTime())
    .toFixed(6);
  await tx.insert(agentBillingRecords).values({
    organization_id: input.organizationId,
    sandbox_id: input.sandboxId,
    sandbox_status: meter.segments.length === 1 ? meter.segments[0]!.state : "mixed",
    billing_period_start: periodStart,
    billing_period_end: input.now,
    hourly_rate: effectiveRate,
    amount: amountDecimal,
    rate_segments: meter.segments,
    credit_transaction_id: null,
    compute_funding_id: window.id,
    created_at: input.now,
  });
  await tx
    .update(agentSandboxes)
    .set({
      last_billed_at: input.now,
      billing_status: newBalance < input.lowCreditWarningAmount ? "warning" : "active",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
      hourly_rate: effectiveRate,
      total_billed: sql`${agentSandboxes.total_billed} + ${amountDecimal}`,
      updated_at: input.now,
    })
    .where(
      and(
        eq(agentSandboxes.id, input.sandboxId),
        eq(agentSandboxes.organization_id, input.organizationId),
        eq(agentSandboxes.lifecycle_revision, lifecycleRevision),
      ),
    );
  await enqueueAgentComputeLeaseInTransaction(tx, renewed.window, lifecycleRevision, input.userId);
  return {
    status: "billed" as const,
    newBalance,
    newBalanceDecimal: organization.balance,
    transactionId: `compute-funding:${window.id}`,
    amount: meter.amount.toNumber(),
    amountDecimal,
  };
}
