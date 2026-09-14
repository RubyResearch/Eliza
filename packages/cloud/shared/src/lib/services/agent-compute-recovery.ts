/** Reconciles expired Dedicated funding after worker loss using the exact durable hold and host stop receipt. */

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { logger } from "../utils/logger";
import {
  cancelUnboundAgentComputeInTransaction,
  stopFundedAgentInTransaction,
} from "./agent-compute-stop";
import { creditsService } from "./credits";
import { SandboxLifecycleAuthority } from "./eliza-sandbox/lifecycle/authority.js";

const lifecycle = new SandboxLifecycleAuthority();
// Cycle through failed hosts too: an unreachable first page must not strand
// every later refund. Restarting the worker simply starts the scan again.
let scanAfterFundingId: string | undefined;

/** A stale observation cannot close a successor: identity, expiry and settlement are checked again under lock. */
export async function reconcileExpiredAgentCompute(identity: {
  agentId: string;
  organizationId: string;
  fundingId: string;
}) {
  const result = await dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, identity.agentId, identity.organizationId);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      identity.agentId,
      identity.organizationId,
    );
    if (
      !current ||
      current.pool_status !== null ||
      !(CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]).includes(current.execution_tier)
    )
      return null;
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, identity.fundingId),
          eq(agentComputeFunding.agent_id, identity.agentId),
          eq(agentComputeFunding.organization_id, identity.organizationId),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (!window || window.settled_at !== null || window.period_end > now) return null;

    const stopIdentity = { ...identity, lifecycleRevision: current.lifecycle_revision };
    const settled =
      window.provider_container_id === null
        ? await cancelUnboundAgentComputeInTransaction(tx, stopIdentity)
        : await stopFundedAgentInTransaction(tx, stopIdentity);
    if (!settled) return null;

    // Retain provider placement and replacement cleanup fences. A later paid
    // resume can reuse the stopped container; deletion still owns deleting rows.
    const canonical =
      window.provider_container_id !== null &&
      current.node_id === window.provider_node_id &&
      current.sandbox_id !== null &&
      current.replacement_cleanup_container_id === null;
    const candidate =
      current.replacement_cleanup_node_id === window.provider_node_id &&
      current.replacement_cleanup_container_id === window.provider_container_id;
    if (
      ["provisioning", "running", "disconnected", "error", "stopped"].includes(current.status) &&
      (canonical || candidate || window.provider_container_id === null)
    ) {
      await tx
        .update(agentSandboxes)
        .set({
          status: canonical ? "stopped" : "error",
          billing_status: "suspended",
          bridge_url: null,
          health_url: null,
          updated_at: now,
        })
        .where(
          and(
            eq(agentSandboxes.id, identity.agentId),
            eq(agentSandboxes.organization_id, identity.organizationId),
          ),
        );
    }
    return settled;
  });
  if (result?.purchasedCreditRefunded)
    await creditsService.invalidateCreditCaches(identity.organizationId);
  return result;
}

/** The provisioner runs this bounded pass before cleanup/retry; failed host observations retain the hold for another pass. */
export async function reconcileExpiredAgentComputeBatch() {
  const windows = await dbWrite
    .select({
      fundingId: agentComputeFunding.id,
      agentId: agentComputeFunding.agent_id,
      organizationId: agentComputeFunding.organization_id,
    })
    .from(agentComputeFunding)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentComputeFunding.agent_id),
        eq(agentSandboxes.organization_id, agentComputeFunding.organization_id),
      ),
    )
    .where(
      and(
        isNull(agentComputeFunding.settled_at),
        lte(agentComputeFunding.period_end, sql`clock_timestamp()`),
        isNull(agentSandboxes.pool_status),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        scanAfterFundingId ? gt(agentComputeFunding.id, scanAfterFundingId) : undefined,
      ),
    )
    .orderBy(asc(agentComputeFunding.id))
    .limit(20);
  scanAfterFundingId = windows.length === 20 ? windows[windows.length - 1]!.fundingId : undefined;
  let reconciled = 0;
  let failed = 0;
  const queue = [...windows];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let identity = queue.shift(); identity; identity = queue.shift()) {
        try {
          if (await reconcileExpiredAgentCompute(identity)) reconciled += 1;
        } catch (error) {
          // error-policy:J1 report a failed recovery item; its durable hold remains retryable.
          failed += 1;
          logger.warn("[agent-compute] Expired funding reconciliation failed", {
            ...identity,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );
  return { total: windows.length, reconciled, failed };
}
