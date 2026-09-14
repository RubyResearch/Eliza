/** Defers only billing-owned stops while the exact locked workload still has paid runtime. */

import { and, eq, inArray } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";

/** Call under the lifecycle/organization locks after revalidating the current funding window. */
export async function deferFundedAgentStopInTransaction(
  tx: DbTransaction,
  input: { agentId: string; organizationId: string; jobId: string; stopAfter: Date },
): Promise<boolean> {
  const [intent] = await tx
    .update(agentComputeStopIntents)
    .set({
      status: "retry",
      next_attempt_at: input.stopAfter,
      last_error: "existing_runtime_funded",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentComputeStopIntents.agent_id, input.agentId),
        eq(agentComputeStopIntents.organization_id, input.organizationId),
        eq(agentComputeStopIntents.job_id, input.jobId),
        eq(agentComputeStopIntents.authorization, "billing_request"),
        inArray(agentComputeStopIntents.status, [
          "pending",
          "dispatching",
          "retry",
          "terminal_attention",
        ]),
      ),
    )
    .returning({ id: agentComputeStopIntents.id });
  if (!intent) return false;
  // A running job keeps its claimed envelope. When it completes, the existing
  // stop-intent recovery loop rearms it at this same deadline.
  await tx
    .update(jobs)
    .set({ scheduled_for: input.stopAfter, updated_at: new Date() })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.agent_id, input.agentId),
        eq(jobs.organization_id, input.organizationId),
        eq(jobs.status, "pending"),
      ),
    );
  await tx
    .update(agentSandboxes)
    .set({
      billing_status: "warning",
      scheduled_shutdown_at: input.stopAfter,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, input.agentId),
        eq(agentSandboxes.organization_id, input.organizationId),
      ),
    );
  return true;
}
