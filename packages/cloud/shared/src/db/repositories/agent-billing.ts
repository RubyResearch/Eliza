/** Persists elapsed agent-compute charges and billing lifecycle transitions. */

import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { settleFundedAgentBillingInTransaction } from "../../lib/services/agent-compute-billing";
import { creditsService } from "../../lib/services/credits";
import type { DbTransaction } from "../client";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentBillingStatus,
  type AgentSandboxStatus,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../schemas/agent-sandboxes";
import { agentBillingRecords, agentBillingRunItems } from "../schemas/compute-billing";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizations } from "../schemas/organizations";
import { parseOrgCreditBalance } from "./agent-billing-numeric";
import {
  type AgentBillingRunLeaseAuthority,
  assertAgentBillingRunLeaseInTransaction,
  recordAgentBillingRunItemInTransaction,
} from "./agent-billing-runs";
import { settleComputeRateSegments } from "./compute-billing-segments";

export interface AgentBillingSandbox {
  id: string;
  agent_name: string | null;
  organization_id: string;
  user_id: string;
  agent_config: Record<string, unknown> | null;
  status: AgentSandboxStatus;
  billing_status: AgentBillingStatus;
  last_billed_at: Date | null;
  total_billed: string;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
  created_at: Date;
}

export interface AgentBillingOrganization {
  id: string;
  name: string;
  credit_balance: string;
  billing_email: string | null;
}

export interface AgentHourlyBillingInput {
  sandboxId: string;
  organizationId: string;
  userId: string;
  agentName: string;
  hourlyRate: number;
  billingDescription: string;
  lowCreditWarningAmount: number;
  now: Date;
}

export interface AgentBillingRunChargeInput
  extends AgentHourlyBillingInput,
    AgentBillingRunLeaseAuthority {}

export type AgentHourlyBillingOutcome =
  | {
      status: "billed";
      newBalance: number;
      transactionId: string;
      amount: number;
      amountDecimal: string;
    }
  | { status: "already_billed_recently" }
  | { status: "funded_until"; fundedUntil: Date; stopAfter: Date }
  | { status: "insufficient_credits" };

const BILLABLE_BILLING_STATUSES: AgentBillingStatus[] = ["active", "warning", "shutdown_pending"];

/** Restricts agent-compute billing to live, user-owned container workloads. */
function agentComputeBillingAuthority() {
  return [
    inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
  ];
}

export class AgentBillingRepository {
  async getOrganizationCreditBalance(organizationId: string): Promise<number | null> {
    const [org] = await dbRead
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organizationId));

    // Fail closed on a corrupt NUMERIC read: returning `Number(...) = NaN` here
    // would masquerade as a real balance and flow into the cron billing gate
    // (`liveBalance >= hourlyCost`, where `NaN` is not caught by `?? fallback`)
    // and into user-facing warning emails/webhooks as `$NaN`. A genuinely
    // missing org still returns `null` (caller treats it as unknown).
    return org ? parseOrgCreditBalance(org.credit_balance) : null;
  }

  async listBillableSandboxes(
    now: Date,
    rebillCutoff: Date,
  ): Promise<{
    runningSandboxes: AgentBillingSandbox[];
    stoppedWithBackups: AgentBillingSandbox[];
  }> {
    const billingDueCondition = or(
      and(
        eq(agentSandboxes.billing_status, "shutdown_pending"),
        isNotNull(agentSandboxes.scheduled_shutdown_at),
        lte(agentSandboxes.scheduled_shutdown_at, now),
      ),
      isNull(agentSandboxes.last_billed_at),
      lt(agentSandboxes.last_billed_at, rebillCutoff),
    );

    const selectFields = {
      id: agentSandboxes.id,
      agent_name: agentSandboxes.agent_name,
      organization_id: agentSandboxes.organization_id,
      user_id: agentSandboxes.user_id,
      agent_config: agentSandboxes.agent_config,
      status: agentSandboxes.status,
      billing_status: agentSandboxes.billing_status,
      last_billed_at: agentSandboxes.last_billed_at,
      total_billed: agentSandboxes.total_billed,
      shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
      scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      created_at: agentSandboxes.created_at,
    };

    const [runningSandboxes, stoppedWithBackups] = await Promise.all([
      dbRead
        .select(selectFields)
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.status, "running"),
            ...agentComputeBillingAuthority(),
            // The shutdown-pending cron acts directly on discovery by emitting
            // a depleted webhook and enqueueing suspend, before the later debit
            // claim. Discovery therefore needs the full authority guard too.
            inArray(agentSandboxes.billing_status, BILLABLE_BILLING_STATUSES),
            billingDueCondition,
          ),
        ),
      dbRead
        .select(selectFields)
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.status, "stopped"),
            ...agentComputeBillingAuthority(),
            inArray(agentSandboxes.billing_status, BILLABLE_BILLING_STATUSES),
            isNotNull(agentSandboxes.last_backup_at),
            billingDueCondition,
          ),
        ),
    ]);

    return { runningSandboxes, stoppedWithBackups };
  }

  /** Stop failed agents' billing clocks before the hourly due-set is selected. */
  async suspendFailedSandboxBilling(now: Date): Promise<number> {
    const suspended = await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "suspended" as AgentBillingStatus,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.status, "error"),
          ...agentComputeBillingAuthority(),
          inArray(agentSandboxes.billing_status, BILLABLE_BILLING_STATUSES),
        ),
      )
      .returning({ id: agentSandboxes.id });

    return suspended.length;
  }

  async listBillingOrganizations(organizationIds: string[]): Promise<AgentBillingOrganization[]> {
    if (organizationIds.length === 0) return [];

    return dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
        billing_email: organizations.billing_email,
      })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds));
  }

  async scheduleShutdownWarning(
    sandboxId: string,
    organizationId: string,
    now: Date,
    shutdownTime: Date,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending" as AgentBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          ...agentComputeBillingAuthority(),
        ),
      );
  }

  /**
   * Durably records a delivered shutdown warning. Called only after the
   * provider accepted delivery: the sandbox stamp, the armed shutdown, and the
   * `warning_sent` run item commit in one transaction under the run lease, so
   * a worker crash before this point leaves the sandbox untouched and a retry
   * redelivers instead of fabricating a skipped-but-armed outcome. Returns
   * false when the sandbox is no longer eligible (already warned elsewhere).
   */
  async commitShutdownWarningForRun(input: {
    runId: string;
    leaseToken: string;
    sandboxId: string;
    organizationId: string;
    agentName: string;
    now: Date;
    shutdownTime: Date;
  }): Promise<boolean> {
    return dbWrite.transaction(async (tx) => {
      const authority = {
        runId: input.runId,
        leaseToken: input.leaseToken,
      };
      await assertAgentBillingRunLeaseInTransaction(tx, authority);
      const [updated] = await tx
        .update(agentSandboxes)
        .set({
          billing_status: "shutdown_pending" as AgentBillingStatus,
          shutdown_warning_sent_at: input.now,
          scheduled_shutdown_at: input.shutdownTime,
          updated_at: input.now,
        })
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            eq(agentSandboxes.organization_id, input.organizationId),
            ...agentComputeBillingAuthority(),
            inArray(agentSandboxes.billing_status, ["active", "warning"]),
            isNull(agentSandboxes.shutdown_warning_sent_at),
          ),
        )
        .returning({ id: agentSandboxes.id });
      if (!updated) return false;
      await recordAgentBillingRunItemInTransaction(tx, authority, {
        sandboxId: input.sandboxId,
        organizationId: input.organizationId,
        agentName: input.agentName,
        action: "warning_sent",
        completedAt: new Date(),
      });
      return true;
    });
  }

  async suspendSandboxForInsufficientCredits(
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "suspended" as AgentBillingStatus,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          ...agentComputeBillingAuthority(),
        ),
      );
  }

  async reactivateSandboxBillingAfterFunding(
    sandboxId: string,
    now: Date,
    organizationId?: string,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "active" as AgentBillingStatus,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          ...(organizationId ? [eq(agentSandboxes.organization_id, organizationId)] : []),
          ...agentComputeBillingAuthority(),
          ne(agentSandboxes.billing_status, "exempt"),
        ),
      );
  }

  async recordHourlyBilling(input: AgentBillingRunChargeInput): Promise<AgentHourlyBillingOutcome> {
    return this.recordHourlyBillingWithOptions(input, {
      runAuthority: { runId: input.runId, leaseToken: input.leaseToken },
    });
  }

  /** Settle all accrued debt before a lifecycle path may create provider compute. */
  async settleAccruedBillingBeforeLifecycle(
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<AgentHourlyBillingOutcome> {
    return this.settleAccruedBillingBeforeLifecycleWithExecutor(
      dbWrite,
      sandboxId,
      organizationId,
      now,
    );
  }

  /** Settle accrued debt inside an existing workload-to-organization lock fence. */
  async settleAccruedBillingBeforeLifecycleInTransaction(
    tx: DbTransaction,
    sandboxId: string,
    organizationId: string,
    now: Date,
    purpose: "lifecycle_transition" | "billing_recovery" = "lifecycle_transition",
  ): Promise<AgentHourlyBillingOutcome> {
    return this.settleAccruedBillingBeforeLifecycleWithExecutor(
      tx,
      sandboxId,
      organizationId,
      now,
      purpose,
    );
  }

  private async settleAccruedBillingBeforeLifecycleWithExecutor(
    executor: typeof dbWrite | DbTransaction,
    sandboxId: string,
    organizationId: string,
    now: Date,
    purpose: "lifecycle_transition" | "billing_recovery" = "lifecycle_transition",
  ): Promise<AgentHourlyBillingOutcome> {
    const [sandbox] = await executor
      .select({
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          ...agentComputeBillingAuthority(),
        ),
      )
      .limit(1);
    if (!sandbox) return { status: "already_billed_recently" };
    return this.recordHourlyBillingWithOptions(
      {
        sandboxId,
        organizationId,
        userId: sandbox.user_id,
        agentName: sandbox.agent_name ?? sandboxId,
        hourlyRate: 0,
        billingDescription: `Eliza agent lifecycle debt settlement: ${sandbox.agent_name ?? sandboxId}`,
        lowCreditWarningAmount: 0,
        now,
      },
      { forceLifecycleSettlement: true, lifecyclePurpose: purpose },
      executor === dbWrite ? undefined : (executor as DbTransaction),
    );
  }

  private async recordHourlyBillingWithOptions(
    input: AgentHourlyBillingInput,
    options: {
      forceLifecycleSettlement?: boolean;
      lifecyclePurpose?: "lifecycle_transition" | "billing_recovery";
      runAuthority?: AgentBillingRunLeaseAuthority;
    } = {},
    existingTx?: DbTransaction,
  ): Promise<AgentHourlyBillingOutcome> {
    const settle = async (tx: DbTransaction): Promise<AgentHourlyBillingOutcome> => {
      if (options.runAuthority) {
        await assertAgentBillingRunLeaseInTransaction(tx, options.runAuthority);
        const [existingRunItem] = await tx
          .select({ id: agentBillingRunItems.id })
          .from(agentBillingRunItems)
          .where(
            and(
              eq(agentBillingRunItems.run_id, options.runAuthority.runId),
              eq(agentBillingRunItems.sandbox_id, input.sandboxId),
            ),
          )
          .limit(1);
        if (existingRunItem) {
          return { status: "already_billed_recently" as const };
        }
      }
      const [claimedSandbox] = await tx
        .select({
          id: agentSandboxes.id,
          status: agentSandboxes.status,
          billing_status: agentSandboxes.billing_status,
          last_backup_at: agentSandboxes.last_backup_at,
          last_billed_at: agentSandboxes.last_billed_at,
          created_at: agentSandboxes.created_at,
          lifecycle_revision: agentSandboxes.lifecycle_revision,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            eq(agentSandboxes.organization_id, input.organizationId),
            ...agentComputeBillingAuthority(),
          ),
        )
        .for("update")
        .limit(1);

      if (
        !claimedSandbox ||
        (!options.forceLifecycleSettlement &&
          (!BILLABLE_BILLING_STATUSES.includes(claimedSandbox.billing_status) ||
            !(
              claimedSandbox.status === "running" ||
              (claimedSandbox.status === "stopped" && claimedSandbox.last_backup_at !== null)
            )))
      ) {
        if (options.runAuthority) {
          await recordAgentBillingRunItemInTransaction(tx, options.runAuthority, {
            sandboxId: input.sandboxId,
            organizationId: input.organizationId,
            agentName: input.agentName,
            action: "skipped",
            detailCode: "not_billable",
            detailMessage: "Sandbox was no longer billable",
            completedAt: new Date(),
          });
        }
        return { status: "already_billed_recently" as const };
      }

      const periodStart = claimedSandbox.last_billed_at ?? claimedSandbox.created_at;
      const elapsedMs = input.now.getTime() - periodStart.getTime();
      if (elapsedMs <= 0 || (!options.forceLifecycleSettlement && elapsedMs < 55 * 60 * 1000)) {
        if (options.runAuthority) {
          await recordAgentBillingRunItemInTransaction(tx, options.runAuthority, {
            sandboxId: input.sandboxId,
            organizationId: input.organizationId,
            agentName: input.agentName,
            action: "skipped",
            detailCode: "already_billed_recently",
            detailMessage: "Sandbox was already billed recently",
            completedAt: new Date(),
          });
        }
        return { status: "already_billed_recently" as const };
      }
      const settled = await settleComputeRateSegments(tx, {
        organizationId: input.organizationId,
        workloadKind: "agent",
        workloadId: input.sandboxId,
        periodStart,
        periodEnd: input.now,
      });
      const chargeDecimal = settled.amount;
      const funded = await settleFundedAgentBillingInTransaction(
        tx,
        input,
        settled,
        periodStart,
        claimedSandbox.lifecycle_revision,
        options.forceLifecycleSettlement === true &&
          options.lifecyclePurpose !== "billing_recovery",
      );
      if (funded) {
        if (funded.status === "billed" && options.runAuthority) {
          await recordAgentBillingRunItemInTransaction(tx, options.runAuthority, {
            sandboxId: input.sandboxId,
            organizationId: input.organizationId,
            agentName: input.agentName,
            action: "billed",
            amountDecimal: funded.amountDecimal,
            newBalanceDecimal: funded.newBalanceDecimal,
            transactionId: funded.transactionId,
            completedAt: new Date(),
          });
        }
        return funded;
      }
      const charge = chargeDecimal.toNumber();
      const effectiveHourlyRate = chargeDecimal
        .mul(60 * 60 * 1000)
        .div(elapsedMs)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} - ${chargeDecimal.toFixed(6)}`,
          updated_at: input.now,
        })
        .where(
          and(
            eq(organizations.id, input.organizationId),
            gte(organizations.credit_balance, chargeDecimal.toFixed(6)),
          ),
        )
        .returning({ credit_balance: organizations.credit_balance });

      if (!updatedOrg) {
        return { status: "insufficient_credits" as const };
      }

      // Fail closed on a corrupt post-debit balance: a `NaN` here would make
      // `newBalance < lowCreditWarningAmount` always false and silently suppress
      // the low-credit "warning" status, letting the org keep billing as
      // "active" past its threshold. The debit already committed, so surfacing
      // the corruption is the safe outcome (the transaction rolls back on throw).
      const newBalance = parseOrgCreditBalance(updatedOrg.credit_balance);
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          amount: chargeDecimal.negated().toFixed(6),
          type: "debit",
          description: input.billingDescription,
          metadata: {
            sandbox_id: input.sandboxId,
            agent_name: input.agentName,
            billing_type:
              settled.segments.length === 1
                ? `agent_${settled.segments[0]?.state ?? "unknown"}`
                : "agent_mixed",
            hourly_rate: effectiveHourlyRate.toFixed(6),
            rate_segments: settled.segments,
            billing_period_start: periodStart.toISOString(),
            billing_period_end: input.now.toISOString(),
          },
          created_at: input.now,
        })
        .returning();

      const nextBillingStatus: AgentBillingStatus =
        newBalance < input.lowCreditWarningAmount ? "warning" : "active";

      await tx
        .update(agentSandboxes)
        .set({
          last_billed_at: input.now,
          billing_status: nextBillingStatus,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          hourly_rate: effectiveHourlyRate.toFixed(6),
          total_billed: sql`${agentSandboxes.total_billed} + ${chargeDecimal.toFixed(6)}`,
          updated_at: input.now,
        })
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            eq(agentSandboxes.organization_id, input.organizationId),
            ...agentComputeBillingAuthority(),
          ),
        );

      await tx.insert(agentBillingRecords).values({
        organization_id: input.organizationId,
        sandbox_id: input.sandboxId,
        sandbox_status:
          settled.segments.length === 1
            ? (settled.segments[0]?.state ?? claimedSandbox.status)
            : "mixed",
        billing_period_start: periodStart,
        billing_period_end: input.now,
        hourly_rate: effectiveHourlyRate.toFixed(6),
        amount: chargeDecimal.toFixed(6),
        rate_segments: settled.segments,
        credit_transaction_id: creditTx.id,
        created_at: input.now,
      });

      if (options.runAuthority) {
        await recordAgentBillingRunItemInTransaction(tx, options.runAuthority, {
          sandboxId: input.sandboxId,
          organizationId: input.organizationId,
          agentName: input.agentName,
          action: "billed",
          amountDecimal: chargeDecimal.toFixed(6),
          newBalanceDecimal: updatedOrg.credit_balance,
          transactionId: creditTx.id,
          completedAt: new Date(),
        });
      }

      return {
        status: "billed" as const,
        newBalance,
        transactionId: creditTx.id,
        amount: charge,
        amountDecimal: chargeDecimal.toFixed(6),
      };
    };
    if (existingTx) return settle(existingTx);
    const result = await dbWrite.transaction(settle);
    if (result.status === "billed") {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }
}

export const agentBillingRepository = new AgentBillingRepository();
