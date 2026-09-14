/** Commits initial Dedicated funding before provider allocation and fences candidate start/refund by durable placement. */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { agentComputeFundingService } from "./agent-compute-funding";
import { fundedRuntimeHandle, startFundedAgentInTransaction } from "./agent-compute-start";
import {
  cancelUnboundAgentComputeInTransaction,
  hasOpenAgentComputeFunding,
  stopFundedAgentInTransaction,
} from "./agent-compute-stop";
import { creditsService } from "./credits";
import { SandboxLifecycleAuthority } from "./eliza-sandbox/lifecycle/authority.js";
import { isDockerSandboxMetadata } from "./eliza-sandbox/lifecycle/provider-metadata.js";
import type { SandboxHandle } from "./sandbox-provider-types";

const lifecycle = new SandboxLifecycleAuthority();

/** A prepaid runtime already owns its running funds; only unfunded accrued storage uses legacy settlement. */
export async function settleAgentBringUpBilling(expected: AgentSandbox) {
  return dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    if (
      !current ||
      current.lifecycle_revision !== expected.lifecycle_revision ||
      current.environment_revision !== expected.environment_revision ||
      current.lifecycle_job_id !== expected.lifecycle_job_id ||
      current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
      current.status !== expected.status ||
      current.execution_tier !== expected.execution_tier ||
      !(CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]).includes(current.execution_tier) ||
      current.pool_status !== null ||
      current.deleted_at !== null ||
      current.deletion_attempt_id !== null
    )
      changed();
    if (await hasOpenAgentComputeFunding(tx, current.id, current.organization_id))
      return { status: "already_billed_recently" as const };
    return agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
      tx,
      current.id,
      current.organization_id,
      new Date(),
    );
  });
}

function changed(): never {
  throw new ElizaError("Dedicated provisioning funding authority changed", {
    code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED",
  });
}

export async function reserveProvisionCompute(expected: AgentSandbox) {
  const reserved = await dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    if (
      !current ||
      current.lifecycle_revision !== expected.lifecycle_revision ||
      current.environment_revision !== expected.environment_revision ||
      current.lifecycle_job_id !== expected.lifecycle_job_id ||
      current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
      current.status !== "provisioning"
    )
      changed();
    const identity = {
      agentId: current.id,
      organizationId: current.organization_id,
      lifecycleRevision: current.lifecycle_revision,
    };
    const [latest] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.agent_id, current.id),
          eq(agentComputeFunding.organization_id, current.organization_id),
        ),
      )
      .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
      .limit(1)
      .for("update");
    // A paid canonical placement must never fall through to create after its
    // restore failed. Its ingress URLs may have been cleared by markError.
    const retained = Boolean(
      latest && current.sandbox_id && current.node_id && !current.replacement_cleanup_node_id,
    );
    if (
      retained &&
      (current.container_name !== current.sandbox_id ||
        !current.bridge_port ||
        !current.web_ui_port ||
        latest!.provider_node_id !== current.node_id ||
        !latest!.provider_container_id)
    )
      changed();
    const funding =
      retained && latest!.settled_at !== null
        ? await agentComputeFundingService.reserveRetainedResumeInTransaction(
            tx,
            identity,
            "provision-retry",
          )
        : await agentComputeFundingService.reserveInTransaction(tx, identity);
    if (!funding) changed();
    // Entering the restore tail invalidates readiness even when the paid
    // container survives a previous attempt. Only its final commit restores it.
    const [pendingWindow] = await tx
      .update(agentComputeFunding)
      .set({ runtime_ready_at: null })
      .where(eq(agentComputeFunding.id, funding.window.id))
      .returning();
    if (!pendingWindow) changed();
    const [agent] = await tx
      .update(agentSandboxes)
      .set({
        billing_status: "active",
        last_billed_at: funding.window.period_start,
      })
      .where(
        and(
          eq(agentSandboxes.id, current.id),
          eq(agentSandboxes.organization_id, current.organization_id),
        ),
      )
      .returning();
    if (!agent) changed();
    return { ...funding, window: pendingWindow, agent, retained };
  });
  if (reserved.purchasedCreditDebited)
    await creditsService.invalidateCreditCaches(expected.organization_id);
  return reserved;
}

/** The first transaction commits the exact binding; only the second can grant/start remote compute. */
export async function startProvisionCompute(
  expected: Pick<AgentSandbox, "id" | "organization_id" | "environment_revision">,
  fundingId: string,
  handle: SandboxHandle,
) {
  if (!isDockerSandboxMetadata(handle.metadata)) changed();
  const meta = handle.metadata;
  if (!meta.containerId || !meta.replacementAttemptId) changed();
  const lockCandidate = async (tx: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>[0]) => {
    await lifecycle.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    if (
      !current ||
      current.status !== "provisioning" ||
      current.environment_revision !== expected.environment_revision ||
      current.replacement_cleanup_node_id !== meta.nodeId ||
      current.replacement_cleanup_container_id !== meta.containerId ||
      current.replacement_cleanup_container_name !== meta.containerName ||
      current.replacement_cleanup_sandbox_id !== handle.sandboxId ||
      current.replacement_cleanup_attempt_id !== meta.replacementAttemptId
    )
      changed();
    return {
      agentId: current.id,
      organizationId: current.organization_id,
      lifecycleRevision: current.lifecycle_revision,
      fundingId,
      nodeId: meta.nodeId,
      containerId: meta.containerId!,
    };
  };
  await dbWrite.transaction(async (tx) => {
    const identity = await lockCandidate(tx);
    await agentComputeFundingService.bindProviderInTransaction(tx, identity);
    await agentComputeFundingService.authorizeHostInTransaction(tx, identity);
  });
  await dbWrite.transaction(async (tx) => {
    const identity = await lockCandidate(tx);
    await startFundedAgentInTransaction(tx, { ...identity, placement: "replacement" });
  });
}

/** A retained provisioning retry renews admission for the same committed container; it never allocates another. */
export async function restartProvisionCompute(expected: AgentSandbox, fundingId: string) {
  return dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, fundingId),
          eq(agentComputeFunding.agent_id, expected.id),
          eq(agentComputeFunding.organization_id, expected.organization_id),
        ),
      )
      .for("update");
    if (
      !current ||
      current.status !== "provisioning" ||
      current.environment_revision !== expected.environment_revision ||
      current.lifecycle_job_id !== expected.lifecycle_job_id ||
      current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
      (current.lifecycle_execution_generation === null &&
        current.lifecycle_revision !== expected.lifecycle_revision) ||
      !window?.provider_container_id ||
      !window.provider_node_id
    )
      changed();
    const started = await startFundedAgentInTransaction(tx, {
      agentId: current.id,
      organizationId: current.organization_id,
      lifecycleRevision: current.lifecycle_revision,
      fundingId,
      nodeId: window.provider_node_id,
      containerId: window.provider_container_id,
    });
    return fundedRuntimeHandle(started);
  });
}

/** Reconcile only this failed admission, never a later running generation or its successor hold. */
export async function reconcileFailedProvisionCompute(
  agentId: string,
  organizationId: string,
  fundingId: string,
  attempt?: { expected: AgentSandbox; handle?: SandboxHandle },
) {
  const result = await dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, agentId, organizationId);
    const current = await lifecycle.getAgentForLifecycleMutation(tx, agentId, organizationId);
    if (attempt) {
      if (!current) changed();
      if (
        current.environment_revision !== attempt.expected.environment_revision ||
        current.lifecycle_job_id !== attempt.expected.lifecycle_job_id ||
        current.lifecycle_execution_generation !==
          attempt.expected.lifecycle_execution_generation ||
        current.deleted_at !== null ||
        current.deletion_attempt_id !== null ||
        !(
          attempt.handle ? ["provisioning", "running", "error"] : ["provisioning", "error"]
        ).includes(current.status)
      )
        changed();
      if (
        !attempt.handle &&
        current.lifecycle_execution_generation === null &&
        current.lifecycle_revision !== attempt.expected.lifecycle_revision
      )
        changed();
      if (attempt.handle) {
        if (!isDockerSandboxMetadata(attempt.handle.metadata)) changed();
        const meta = attempt.handle.metadata;
        const candidate =
          current.replacement_cleanup_node_id === meta.nodeId &&
          current.replacement_cleanup_container_id === meta.containerId &&
          current.replacement_cleanup_attempt_id === meta.replacementAttemptId &&
          current.replacement_cleanup_sandbox_id === attempt.handle.sandboxId;
        const canonical =
          current.node_id === meta.nodeId &&
          current.container_name === meta.containerName &&
          current.sandbox_id === attempt.handle.sandboxId &&
          (current.lifecycle_execution_generation !== null ||
            current.lifecycle_revision === attempt.expected.lifecycle_revision);
        if (!candidate && !canonical) changed();
      }
    } else if (!current || (current.status !== "error" && current.status !== "provisioning"))
      return null;
    if (!current) changed();
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, fundingId),
          eq(agentComputeFunding.agent_id, agentId),
          eq(agentComputeFunding.organization_id, organizationId),
        ),
      )
      .for("update");
    if (!window || window.settled_at !== null) return null;
    if (
      attempt?.handle &&
      window.provider_container_id !== null &&
      isDockerSandboxMetadata(attempt.handle.metadata) &&
      (window.provider_node_id !== attempt.handle.metadata.nodeId ||
        (attempt.handle.metadata.containerId &&
          window.provider_container_id !== attempt.handle.metadata.containerId))
    )
      changed();
    const identity = {
      agentId,
      organizationId,
      lifecycleRevision: current.lifecycle_revision,
      fundingId,
    };
    return window.provider_container_id === null
      ? cancelUnboundAgentComputeInTransaction(tx, identity)
      : stopFundedAgentInTransaction(tx, identity);
  });
  if (result?.purchasedCreditRefunded) await creditsService.invalidateCreditCaches(organizationId);
  return result;
}

/** Cleanup owns this locked candidate; settle its funding before any provider can remove the stop evidence. */
export async function settleReplacementComputeInTransaction(
  tx: DbTransaction,
  current: AgentSandbox,
  locator: { nodeId: string; containerId: string | null },
) {
  const [window] = await tx
    .select()
    .from(agentComputeFunding)
    .where(
      and(
        eq(agentComputeFunding.agent_id, current.id),
        eq(agentComputeFunding.organization_id, current.organization_id),
        isNull(agentComputeFunding.settled_at),
      ),
    )
    .for("update");
  if (!window) return null;
  if (
    window.provider_container_id !== null &&
    (window.provider_node_id !== locator.nodeId ||
      window.provider_container_id !== locator.containerId)
  )
    return null;
  const identity = {
    agentId: current.id,
    organizationId: current.organization_id,
    lifecycleRevision: current.lifecycle_revision,
    fundingId: window.id,
  };
  return window.provider_container_id === null
    ? cancelUnboundAgentComputeInTransaction(tx, identity)
    : stopFundedAgentInTransaction(tx, identity);
}

/** Publish reachability only after the full application restore tail succeeded. */
export async function completeProvisionCompute(
  expected: AgentSandbox,
  fundingId: string,
  handle: SandboxHandle,
) {
  if (!isDockerSandboxMetadata(handle.metadata)) changed();
  const meta = handle.metadata;
  const { containerId, nodeId } = meta;
  if (!containerId || !nodeId) changed();
  return dbWrite.transaction(async (tx) => {
    await lifecycle.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycle.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    if (
      !current ||
      current.status !== "provisioning" ||
      current.lifecycle_revision !== expected.lifecycle_revision ||
      current.environment_revision !== expected.environment_revision ||
      current.lifecycle_job_id !== expected.lifecycle_job_id ||
      current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
      current.node_id !== meta.nodeId ||
      current.sandbox_id !== handle.sandboxId ||
      current.container_name !== meta.containerName ||
      current.bridge_url !== handle.bridgeUrl ||
      current.health_url !== handle.healthUrl ||
      current.replacement_cleanup_container_id !== null
    )
      changed();
    await agentComputeFundingService.authorizeHostInTransaction(tx, {
      agentId: current.id,
      organizationId: current.organization_id,
      lifecycleRevision: current.lifecycle_revision,
      fundingId,
      nodeId,
      containerId,
    });
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, fundingId),
          eq(agentComputeFunding.agent_id, current.id),
          eq(agentComputeFunding.organization_id, current.organization_id),
        ),
      )
      .limit(1);
    if (!window?.host_lease_confirmed_at) changed();
    const now = await readPostLockDatabaseNow(tx);
    await tx
      .update(agentComputeFunding)
      .set({ runtime_ready_at: now })
      .where(eq(agentComputeFunding.id, fundingId));
    const [ready] = await tx
      .update(agentSandboxes)
      .set({
        status:
          current.claimed_at && current.warm_claim_credential_state !== "ready"
            ? "provisioning"
            : "running",
        error_message: null,
        last_heartbeat_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, current.id),
          eq(agentSandboxes.organization_id, current.organization_id),
        ),
      )
      .returning();
    if (!ready) changed();
    return ready;
  });
}
