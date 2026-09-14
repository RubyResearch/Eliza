/**
 * Atomically requests a Dedicated stop when accrued compute cannot be paid.
 * The billing run, workload generation, fresh settlement, and durable stop job
 * share one transaction. Notification delivery never authorizes unpaid runtime.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import {
  type AgentBillingRunLeaseAuthority,
  assertAgentBillingRunLeaseInTransaction,
  recordAgentBillingRunItemInTransaction,
} from "../../db/repositories/agent-billing-runs";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { type AgentBillingRunItem, agentBillingRunItems } from "../../db/schemas/compute-billing";
import { deferFundedAgentStopInTransaction } from "./agent-compute-stop-schedule";
import { lockAgentSuspendTargetInTx, provisioningJobService } from "./provisioning-jobs";

export async function enqueueAgentUnfundedStopForRun(
  input: AgentBillingRunLeaseAuthority & {
    sandboxId: string;
    organizationId: string;
    agentName: string;
    now: Date;
  },
): Promise<AgentBillingRunItem> {
  return dbWrite.transaction(async (tx) => {
    await assertAgentBillingRunLeaseInTransaction(tx, input);
    const [existing] = await tx
      .select()
      .from(agentBillingRunItems)
      .where(
        and(
          eq(agentBillingRunItems.run_id, input.runId),
          eq(agentBillingRunItems.sandbox_id, input.sandboxId),
        ),
      )
      .limit(1);
    if (existing) return existing;

    // Keep the established lock order: run lease, lifecycle target, organization.
    await lockAgentSuspendTargetInTx(tx, {
      agentId: input.sandboxId,
      organizationId: input.organizationId,
    });
    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.sandboxId),
          eq(agentSandboxes.organization_id, input.organizationId),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          inArray(agentSandboxes.status, ["running", "stopped"]),
          inArray(agentSandboxes.billing_status, ["active", "warning", "shutdown_pending"]),
          isNull(agentSandboxes.pool_status),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
        ),
      )
      .limit(1);
    const receipt = {
      sandboxId: input.sandboxId,
      organizationId: input.organizationId,
      agentName: input.agentName,
      completedAt: new Date(),
    };
    if (!sandbox || (sandbox.status === "stopped" && !sandbox.last_backup_at)) {
      return (
        await recordAgentBillingRunItemInTransaction(tx, input, {
          ...receipt,
          action: "skipped",
          detailCode: "not_billable",
          detailMessage: "Sandbox was no longer billable",
        })
      ).item;
    }

    const settlement =
      await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
        tx,
        input.sandboxId,
        input.organizationId,
        input.now,
        "billing_recovery",
      );
    if (settlement.status !== "insufficient_credits" && settlement.status !== "funded_until") {
      return (
        await recordAgentBillingRunItemInTransaction(tx, input, {
          ...receipt,
          ...(settlement.status === "billed"
            ? {
                action: "billed" as const,
                amountDecimal: settlement.amountDecimal,
                newBalanceDecimal: String(settlement.newBalance),
                transactionId: settlement.transactionId,
              }
            : {
                action: "skipped" as const,
                detailCode: "already_settled",
                detailMessage: "Accrued compute was already settled",
              }),
        })
      ).item;
    }

    await tx
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(agentSandboxes.id, input.sandboxId),
          eq(agentSandboxes.organization_id, input.organizationId),
        ),
      );
    const queued = await provisioningJobService.enqueueAgentSuspendOnceInTransaction(tx, {
      agentId: input.sandboxId,
      organizationId: input.organizationId,
      userId: sandbox.user_id,
      authorization: "billing_request",
    });
    if (
      settlement.status === "funded_until" &&
      (await deferFundedAgentStopInTransaction(tx, {
        agentId: input.sandboxId,
        organizationId: input.organizationId,
        jobId: queued.job.id,
        stopAfter: settlement.stopAfter,
      }))
    ) {
      return (
        await recordAgentBillingRunItemInTransaction(tx, input, {
          ...receipt,
          action: "skipped",
          detailCode: "existing_runtime_funded",
          detailMessage: `Runtime remains funded; stop recheck scheduled for ${settlement.stopAfter.toISOString()}`,
        })
      ).item;
    }
    return (
      await recordAgentBillingRunItemInTransaction(tx, input, {
        ...receipt,
        action: "shutdown",
      })
    ).item;
  });
}
