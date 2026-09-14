/** Revokes paid runtime before reconciling the exact held funds; stopped data is retained. */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { settleComputeRateSegments } from "../../db/repositories/compute-billing-segments";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import {
  microsToMoney,
  moneyToMicros,
} from "../../db/repositories/subscription-funding-reservations";
import {
  type AgentComputeFunding,
  agentComputeFunding,
} from "../../db/schemas/agent-compute-funding";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { billingFundingReservations } from "../../db/schemas/billing-funding-reservations";
import { agentBillingRecords } from "../../db/schemas/compute-billing";
import { computeBillingRateSegments } from "../../db/schemas/compute-billing-rate-segments";
import { organizations } from "../../db/schemas/organizations";
import { AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS } from "./agent-compute-policy";
import { parseDockerComputeStopReceipt } from "./agent-compute-stop-receipt";
import type { DockerComputeAuthorization } from "./docker-compute-lease";
import { subscriptionFundingService } from "./subscription-funding";

interface StopIdentity {
  agentId: string;
  organizationId: string;
  lifecycleRevision: number;
}

function changed(): never {
  throw new ElizaError("Dedicated stopped-provider funding authority changed", {
    code: "AGENT_COMPUTE_STOP_AUTHORITY_CHANGED",
    severity: "fatal",
  });
}

async function lockStopAgent(tx: DbTransaction, identity: StopIdentity) {
  const [agent] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, identity.agentId),
        eq(agentSandboxes.organization_id, identity.organizationId),
      ),
    )
    .for("update");
  if (
    !agent ||
    agent.lifecycle_revision !== identity.lifecycleRevision ||
    agent.pool_status !== null ||
    !(CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]).includes(agent.execution_tier)
  )
    changed();
  // An inactive/deleting account must still be able to stop compute and receive
  // its own refund. This lock admits no new runtime or purchased capacity.
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .for("update");
  if (!organization) changed();
  return agent;
}

function stopAuthorization(window: AgentComputeFunding, now: Date): DockerComputeAuthorization {
  if (!window.provider_node_id || !window.provider_container_id) changed();
  return {
    agentId: window.agent_id,
    organizationId: window.organization_id,
    containerId: window.provider_container_id,
    fundingId: window.id,
    previousFundingId: window.previous_funding_id,
    issuedAtMs: now.getTime(),
    paidFromMs: window.period_start.getTime(),
    paidUntilMs: window.period_end.getTime(),
  };
}

/** Reads a current hold without changing it. Callers use the locked variant before provider effects. */
export async function hasOpenAgentComputeFunding(
  tx: DbTransaction,
  agentId: string,
  organizationId: string,
) {
  const [window] = await tx
    .select({ id: agentComputeFunding.id })
    .from(agentComputeFunding)
    .where(
      and(
        eq(agentComputeFunding.agent_id, agentId),
        eq(agentComputeFunding.organization_id, organizationId),
        isNull(agentComputeFunding.settled_at),
      ),
    )
    .limit(1);
  return Boolean(window);
}

/** Only a receipt verified over the bound provider's SSH connection may enter this boundary. */
export async function settleStoppedAgentComputeInTransaction(
  tx: DbTransaction,
  identity: StopIdentity & { fundingId: string },
  providerReceipt: unknown,
) {
  const agent = await lockStopAgent(tx, identity);
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
  if (!window) changed();
  const now = await readPostLockDatabaseNow(tx);
  const receipt = parseDockerComputeStopReceipt(providerReceipt, stopAuthorization(window, now));
  const durableReceipt = {
    containerId: receipt.authorization.containerId,
    fundingId: receipt.authorization.fundingId,
    bootId: receipt.bootId,
    stoppedAtMs: receipt.stoppedAtMs,
  };
  if (window.settled_at !== null) {
    if (
      !window.provider_stop_receipt ||
      Object.keys(durableReceipt).some(
        (key) =>
          window.provider_stop_receipt![key as keyof typeof durableReceipt] !==
          durableReceipt[key as keyof typeof durableReceipt],
      )
    )
      changed();
    return { fundingId: window.id, replayed: true, purchasedCreditRefunded: false };
  }
  if (receipt.stoppedAtMs > now.getTime() + AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS) changed();
  const cutoff = new Date(
    Math.min(
      now.getTime(),
      window.period_end.getTime(),
      Math.max(window.period_start.getTime(), receipt.stoppedAtMs),
    ),
  );
  if (agent.last_billed_at && agent.last_billed_at.getTime() > window.period_start.getTime())
    changed();
  if (receipt.startedAtMs && cutoff > window.period_start) {
    const { recordFundedComputeStartInTransaction } = await import("./agent-compute-start");
    await recordFundedComputeStartInTransaction(
      tx,
      window,
      identity.lifecycleRevision,
      receipt.startedAtMs,
    );
  }
  const meter = await settleComputeRateSegments(tx, {
    organizationId: identity.organizationId,
    workloadKind: "agent",
    workloadId: identity.agentId,
    periodStart: window.period_start,
    periodEnd: cutoff,
  });
  const [reservation] = await tx
    .select()
    .from(billingFundingReservations)
    .where(
      and(
        eq(billingFundingReservations.id, window.funding_reservation_id),
        eq(billingFundingReservations.organization_id, identity.organizationId),
      ),
    )
    .for("update");
  const meteredMicros = moneyToMicros(meter.amount.toFixed(6), "meteredAmount");
  // Failed activation does not earn an activation minimum. Successful runtime
  // retains its once-per-activation remainder across hourly reservations.
  const minimumMicros =
    window.runtime_ready_at &&
    cutoff > window.period_start &&
    (receipt.startedAtMs || meteredMicros > 0n)
      ? moneyToMicros(window.minimum_charge_remaining, "minimumChargeRemaining")
      : 0n;
  const actualMicros = meteredMicros > minimumMicros ? meteredMicros : minimumMicros;
  const actualAmount = microsToMoney(actualMicros);
  const minimumAdjustment = microsToMoney(actualMicros - meteredMicros);
  if (
    !reservation ||
    reservation.status !== "reserved" ||
    actualMicros > moneyToMicros(reservation.reserved_amount, "reservedAmount")
  )
    changed();
  return tx.transaction(async (nested) => {
    const settled = await subscriptionFundingService.settleInTransaction(nested, {
      organizationId: identity.organizationId,
      logicalOperationId: `compute.${identity.agentId}.${window.id}`,
      operation: "managed_agent_compute",
      actualAmount,
      occurredAt: cutoff,
      metadata: {
        agent_id: identity.agentId,
        compute_funding_id: window.id,
        provider_stop: durableReceipt,
        metered_amount: meter.amount.toFixed(6),
        minimum_charge_amount: minimumAdjustment,
      },
    });
    await nested
      .update(agentComputeFunding)
      .set({
        settled_at: now,
        settled_through: cutoff,
        provider_stopped_at: new Date(receipt.stoppedAtMs),
        provider_stop_receipt: durableReceipt,
      })
      .where(
        and(
          eq(agentComputeFunding.id, window.id),
          eq(agentComputeFunding.organization_id, identity.organizationId),
        ),
      );
    // A never-started window can have a zero-length interval. Its finalized
    // funding and stop receipt prove a full refund; there is no usage to bill.
    if (cutoff > window.period_start) {
      await nested.insert(agentBillingRecords).values({
        organization_id: identity.organizationId,
        sandbox_id: identity.agentId,
        sandbox_status: meter.segments.length === 1 ? meter.segments[0]!.state : "mixed",
        billing_period_start: window.period_start,
        billing_period_end: cutoff,
        hourly_rate: meter.amount
          .mul(3_600_000)
          .div(cutoff.getTime() - window.period_start.getTime())
          .toFixed(6),
        amount: actualAmount,
        minimum_charge_amount: minimumAdjustment,
        rate_segments: meter.segments,
        credit_transaction_id: null,
        compute_funding_id: window.id,
        created_at: now,
      });
    }
    await nested
      .update(agentSandboxes)
      .set({
        last_billed_at: cutoff,
        total_billed: sql`${agentSandboxes.total_billed} + ${actualAmount}`,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, identity.agentId),
          eq(agentSandboxes.organization_id, identity.organizationId),
        ),
      );
    // End the canonical runtime meter at the host-confirmed stop, not at a
    // later control-plane status update. Storage may begin at that next state
    // transition, but the transport delay must never become running usage.
    await nested.insert(computeBillingRateSegments).values({
      id: crypto.randomUUID(),
      organization_id: identity.organizationId,
      workload_kind: "agent",
      workload_id: identity.agentId,
      lifecycle_revision: identity.lifecycleRevision,
      billing_state: "not_billable",
      rate_per_hour: "0.000000",
      effective_at: cutoff,
      created_at: now,
    });
    return {
      fundingId: window.id,
      replayed: false,
      purchasedCreditRefunded: settled.purchasedCreditRefunded,
    };
  });
}

/** The lifecycle caller holds this transaction through stop proof and final state writeback, then invalidates credit caches after commit. */
export async function stopFundedAgentInTransaction(
  tx: DbTransaction,
  identity: StopIdentity & { fundingId?: string },
) {
  await lockStopAgent(tx, identity);
  const [window] = await tx
    .select()
    .from(agentComputeFunding)
    .where(
      and(
        eq(agentComputeFunding.agent_id, identity.agentId),
        eq(agentComputeFunding.organization_id, identity.organizationId),
        isNull(agentComputeFunding.settled_at),
        identity.fundingId ? eq(agentComputeFunding.id, identity.fundingId) : undefined,
      ),
    )
    .for("update");
  if (!window) return null;
  const authorization = stopAuthorization(window, await readPostLockDatabaseNow(tx));
  const { dockerNodesRepository } = await import("../../db/repositories/docker-nodes");
  const { DockerSSHClient } = await import("./docker-ssh");
  const { installDockerComputeGuard, revokeDockerComputeLease, dockerComputeRootSSH } =
    await import("./docker-compute-lease");
  const node = await dockerNodesRepository.findByNodeIdOnPrimary(window.provider_node_id!);
  if (!node?.host_key_fingerprint) changed();
  const ssh = new DockerSSHClient({
    hostname: node.hostname,
    port: node.ssh_port,
    username: node.ssh_user,
    hostKeyFingerprint: node.host_key_fingerprint,
  });
  const rootSSH = dockerComputeRootSSH(ssh, node.ssh_user);
  try {
    await ssh.connect();
    await installDockerComputeGuard(rootSSH);
    const receipt = parseDockerComputeStopReceipt(
      JSON.parse(await revokeDockerComputeLease(rootSSH, authorization)),
      authorization,
    );
    return await settleStoppedAgentComputeInTransaction(
      tx,
      { ...identity, fundingId: window.id },
      receipt,
    );
  } finally {
    await ssh.disconnect();
  }
}

/** An unbound hold has never authorized a provider start; closing it fences every late binding callback. */
export async function cancelUnboundAgentComputeInTransaction(
  tx: DbTransaction,
  identity: StopIdentity & { fundingId: string },
) {
  await lockStopAgent(tx, identity);
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
  if (
    !window ||
    window.provider_container_id !== null ||
    window.provider_node_id !== null ||
    window.host_lease_confirmed_at !== null
  )
    changed();
  if (window.settled_at !== null)
    return { fundingId: window.id, replayed: true, purchasedCreditRefunded: false };
  return tx.transaction(async (nested) => {
    const settled = await subscriptionFundingService.settleInTransaction(nested, {
      organizationId: identity.organizationId,
      logicalOperationId: `compute.${identity.agentId}.${window.id}`,
      operation: "managed_agent_compute",
      actualAmount: "0.000000",
      occurredAt: window.period_start,
      metadata: {
        agent_id: identity.agentId,
        compute_funding_id: window.id,
        unbound_provision_cancelled: true,
      },
    });
    await nested
      .update(agentComputeFunding)
      .set({
        settled_at: await readPostLockDatabaseNow(nested),
        settled_through: window.period_start,
      })
      .where(eq(agentComputeFunding.id, window.id));
    return {
      fundingId: window.id,
      replayed: false,
      purchasedCreditRefunded: settled.purchasedCreditRefunded,
    };
  });
}
