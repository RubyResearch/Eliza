/** Reserves Dedicated runtime funds under lifecycle authority before provider work, and binds them to one exact container. */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
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
import { organizations } from "../../db/schemas/organizations";
import { AGENT_PRICING } from "../constants/agent-pricing";
import {
  AGENT_COMPUTE_FUNDING_WINDOW_MS,
  AGENT_COMPUTE_STOP_MARGIN_MS,
} from "./agent-compute-policy";
import type { DockerComputeAuthorization } from "./docker-compute-lease";
import { subscriptionFundingService } from "./subscription-funding";

export const AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED = "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED";
export const AGENT_COMPUTE_FUNDING_EXPIRED = "AGENT_COMPUTE_FUNDING_EXPIRED";
export const AGENT_COMPUTE_FUNDING_UNCONFIRMED = "AGENT_COMPUTE_FUNDING_UNCONFIRMED";

interface FundingAgentIdentity {
  agentId: string;
  organizationId: string;
  lifecycleRevision: number;
}

interface FundingProviderIdentity extends FundingAgentIdentity {
  fundingId: string;
  nodeId: string;
  containerId: string;
}

function reject(code: string, message: string, identity: FundingAgentIdentity): never {
  throw new ElizaError(message, { code, context: { ...identity }, severity: "fatal" });
}

async function lockFundingAgent(
  tx: DbTransaction,
  identity: FundingAgentIdentity,
  statuses: readonly ("provisioning" | "running" | "stopped")[],
) {
  const [agent] = await tx
    .select({
      id: agentSandboxes.id,
      lifecycle_revision: agentSandboxes.lifecycle_revision,
      status: agentSandboxes.status,
      execution_tier: agentSandboxes.execution_tier,
      pool_status: agentSandboxes.pool_status,
      deleted_at: agentSandboxes.deleted_at,
      deletion_attempt_id: agentSandboxes.deletion_attempt_id,
      node_id: agentSandboxes.node_id,
    })
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
    !Number.isSafeInteger(identity.lifecycleRevision) ||
    identity.lifecycleRevision < 0 ||
    agent.lifecycle_revision !== identity.lifecycleRevision ||
    !(statuses as readonly string[]).includes(agent.status) ||
    agent.pool_status !== null ||
    agent.deleted_at !== null ||
    agent.deletion_attempt_id !== null ||
    !(CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]).includes(agent.execution_tier)
  ) {
    reject(
      AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
      "Dedicated lifecycle authority changed before funding",
      identity,
    );
  }
  const [organization] = await tx
    .select({
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .for("update");
  if (
    !organization ||
    !organization.is_active ||
    organization.account_lifecycle_state !== "active" ||
    organization.account_deletion_request_id !== null ||
    organization.paid_work_fenced_at !== null
  ) {
    reject(
      AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
      "Organization cannot admit Dedicated compute",
      identity,
    );
  }
  return agent;
}

export class AgentComputeFundingService {
  /** A retained container resumes only from its reconciled stop, or replays the same committed successor. */
  async reserveRetainedResumeInTransaction(
    tx: DbTransaction,
    identity: FundingAgentIdentity,
    admission: "resume" | "provision-retry" = "resume",
  ) {
    const agent = await lockFundingAgent(tx, identity, ["stopped", "provisioning"]);
    const [latest] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.agent_id, identity.agentId),
          eq(agentComputeFunding.organization_id, identity.organizationId),
        ),
      )
      .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
      .limit(1)
      .for("update");
    if (!latest) return null;
    if (admission === "resume" && !latest.runtime_ready_at) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated provisioning must complete before plain resume",
        identity,
      );
    }
    if (!latest.provider_container_id || latest.provider_node_id !== agent.node_id) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Retained Dedicated provider changed",
        identity,
      );
    }
    if (latest.settled_at === null) {
      const [previous] = latest.previous_funding_id
        ? await tx
            .select()
            .from(agentComputeFunding)
            .where(
              and(
                eq(agentComputeFunding.id, latest.previous_funding_id),
                eq(agentComputeFunding.agent_id, identity.agentId),
                eq(agentComputeFunding.organization_id, identity.organizationId),
              ),
            )
            .limit(1)
        : [];
      if (!previous?.provider_stop_receipt || agent.status !== "provisioning") {
        reject(
          AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
          "Dedicated resume requires a reconciled predecessor",
          identity,
        );
      }
      await this.readBoundWindowInTransaction(tx, {
        ...identity,
        fundingId: latest.id,
        nodeId: latest.provider_node_id!,
        containerId: latest.provider_container_id,
      });
      return { window: latest, replayed: true, purchasedCreditDebited: false };
    }
    if (
      !latest.provider_stop_receipt ||
      agent.status !== (admission === "provision-retry" ? "provisioning" : "stopped")
    ) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated resume requires a verified stop",
        identity,
      );
    }
    return this.createWindowInTransaction(tx, identity, await readPostLockDatabaseNow(tx), latest);
  }

  /** The caller commits this reservation with provisioning admission, then invalidates credit caches if a cash debit occurred. */
  async reserveInTransaction(tx: DbTransaction, identity: FundingAgentIdentity) {
    await lockFundingAgent(tx, identity, ["provisioning"]);
    const now = await readPostLockDatabaseNow(tx);
    const [existing] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.agent_id, identity.agentId),
          eq(agentComputeFunding.organization_id, identity.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    if (existing) {
      const [reservation] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.id, existing.funding_reservation_id),
            eq(billingFundingReservations.organization_id, identity.organizationId),
          ),
        );
      if (existing.period_end <= now || !reservation || reservation.status !== "reserved") {
        reject(
          AGENT_COMPUTE_FUNDING_EXPIRED,
          "Previous Dedicated funding must be reconciled before another provision",
          identity,
        );
      }
      return { window: existing, replayed: true, purchasedCreditDebited: false };
    }
    return this.createWindowInTransaction(tx, identity, now, null);
  }

  private async createWindowInTransaction(
    tx: DbTransaction,
    identity: FundingAgentIdentity,
    periodStart: Date,
    previous: AgentComputeFunding | null,
    minimumChargeRemaining?: string,
  ) {
    const id = crypto.randomUUID();
    // Only uninterrupted renewal retains the existing tariff. A new start
    // uses the current rate disclosed alongside its new activation minimum.
    const hourlyRate =
      minimumChargeRemaining !== undefined && previous
        ? previous.hourly_rate
        : AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6);
    const amount = microsToMoney(
      (moneyToMicros(hourlyRate, "hourlyRate") * BigInt(AGENT_COMPUTE_FUNDING_WINDOW_MS) +
        3_599_999n) /
        3_600_000n,
    );
    const activationMinimum = microsToMoney(
      moneyToMicros(hourlyRate, "hourlyRate") * BigInt(AGENT_PRICING.MINIMUM_ACTIVATION_HOURS),
    );
    const remainingMinimum = minimumChargeRemaining ?? activationMinimum;
    if (
      moneyToMicros(remainingMinimum, "minimumChargeRemaining") >
      moneyToMicros(amount, "reservationAmount")
    ) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated minimum exceeds reserved funding",
        identity,
      );
    }
    const expiresAt = new Date(periodStart.getTime() + AGENT_COMPUTE_FUNDING_WINDOW_MS);
    const reserved = await subscriptionFundingService.reserveInTransaction(tx, {
      organizationId: identity.organizationId,
      logicalOperationId: `compute.${identity.agentId}.${id}`,
      operation: "managed_agent_compute",
      amount,
      description: "Dedicated runtime funding reservation",
      expiresAt,
      metadata: { agent_id: identity.agentId, compute_funding_id: id },
    });
    const fundedAt = await readPostLockDatabaseNow(tx);
    const periodEnd = new Date(
      Math.min(expiresAt.getTime(), reserved.reservation.expires_at.getTime()),
    );
    if (periodEnd.getTime() - fundedAt.getTime() <= 2 * AGENT_COMPUTE_STOP_MARGIN_MS) {
      reject(AGENT_COMPUTE_FUNDING_EXPIRED, "Dedicated funding expired before admission", identity);
    }
    const [window] = await tx
      .insert(agentComputeFunding)
      .values({
        id,
        organization_id: identity.organizationId,
        agent_id: identity.agentId,
        funding_reservation_id: reserved.reservation.id,
        previous_funding_id: previous?.id ?? null,
        period_start: periodStart,
        period_end: periodEnd,
        hourly_rate: hourlyRate,
        // A retained restart starts a new activation; only uninterrupted
        // renewal supplies the remainder of the previously accepted minimum.
        minimum_charge_remaining: remainingMinimum,
        provider_node_id: previous?.provider_node_id ?? null,
        provider_container_id: previous?.provider_container_id ?? null,
        provider_bound_at: previous ? fundedAt : null,
        runtime_ready_at: previous?.runtime_ready_at ?? null,
      })
      .returning();
    if (!window)
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated funding reservation was not persisted",
        identity,
      );
    return { window, replayed: false, purchasedCreditDebited: reserved.purchasedCreditDebited };
  }

  /** Pins the paid interval to the immutable Docker id, never a reusable container name. */
  async bindProviderInTransaction(tx: DbTransaction, input: FundingProviderIdentity) {
    if (
      !/^[0-9a-f]{64}$/.test(input.containerId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.nodeId)
    ) {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Invalid Dedicated provider identity", input);
    }
    await lockFundingAgent(tx, input, ["provisioning"]);
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, input.fundingId),
          eq(agentComputeFunding.agent_id, input.agentId),
          eq(agentComputeFunding.organization_id, input.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (!window || window.period_end <= now) {
      reject(AGENT_COMPUTE_FUNDING_EXPIRED, "Dedicated provider has no current funding", input);
    }
    const [reservation] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.id, window.funding_reservation_id),
          eq(billingFundingReservations.organization_id, input.organizationId),
        ),
      );
    if (!reservation || reservation.status !== "reserved") {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated funds are no longer reserved",
        input,
      );
    }
    if (window.provider_container_id !== null) {
      if (
        window.provider_container_id !== input.containerId ||
        window.provider_node_id !== input.nodeId
      ) {
        reject(
          AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
          "Dedicated funds belong to another provider instance",
          input,
        );
      }
      return window;
    }
    const [bound] = await tx
      .update(agentComputeFunding)
      .set({
        provider_node_id: input.nodeId,
        provider_container_id: input.containerId,
        provider_bound_at: now,
      })
      .where(eq(agentComputeFunding.id, window.id))
      .returning();
    if (!bound)
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated provider binding failed", input);
    return bound;
  }

  private async readBoundWindowInTransaction(tx: DbTransaction, input: FundingProviderIdentity) {
    const agent = await lockFundingAgent(tx, input, ["provisioning", "running"]);
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, input.fundingId),
          eq(agentComputeFunding.agent_id, input.agentId),
          eq(agentComputeFunding.organization_id, input.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !window ||
      window.provider_node_id !== input.nodeId ||
      window.provider_container_id !== input.containerId ||
      (agent.status === "running" && agent.node_id !== input.nodeId)
    ) {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated provider funding changed", input);
    }
    if (window.period_end.getTime() - now.getTime() <= AGENT_COMPUTE_STOP_MARGIN_MS) {
      reject(
        AGENT_COMPUTE_FUNDING_EXPIRED,
        "Dedicated host funding reached its stop deadline",
        input,
      );
    }
    const [reservation] = await tx
      .select({ status: billingFundingReservations.status })
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.id, window.funding_reservation_id),
          eq(billingFundingReservations.organization_id, input.organizationId),
        ),
      );
    if (reservation?.status !== "reserved") {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated funds are no longer held", input);
    }
    return { window, now };
  }

  /** Return only after the outer transaction commits; host admission must never use an uncommitted binding. */
  async authorizeHostInTransaction(
    tx: DbTransaction,
    input: FundingProviderIdentity,
  ): Promise<DockerComputeAuthorization> {
    const { window, now } = await this.readBoundWindowInTransaction(tx, input);
    return {
      agentId: input.agentId,
      organizationId: input.organizationId,
      containerId: input.containerId,
      fundingId: window.id,
      previousFundingId: window.previous_funding_id,
      issuedAtMs: now.getTime(),
      paidFromMs: window.period_start.getTime(),
      paidUntilMs: window.period_end.getTime(),
    };
  }

  /** The provider calls this only after verifying the matching grant response over its pinned SSH connection. */
  async confirmHostLeaseInTransaction(tx: DbTransaction, input: FundingProviderIdentity) {
    const { window, now } = await this.readBoundWindowInTransaction(tx, input);
    if (window.host_lease_confirmed_at !== null) return window;
    const [confirmed] = await tx
      .update(agentComputeFunding)
      .set({ host_lease_confirmed_at: now })
      .where(
        and(
          eq(agentComputeFunding.id, window.id),
          eq(agentComputeFunding.organization_id, input.organizationId),
        ),
      )
      .returning();
    if (!confirmed) {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated host confirmation failed", input);
    }
    return confirmed;
  }

  /**
   * Exchanges a hold using the existing billing meter's exact amount and cutoff.
   * The savepoint preserves the previous hold even when an outer billing caller
   * catches insufficient funding to enqueue a stop. Ledger/usage receipts belong
   * in the same outer transaction; invalidate changed credit caches after commit.
   */
  async renewInTransaction(
    tx: DbTransaction,
    input: FundingAgentIdentity & {
      fundingId: string;
      settledThrough: Date;
      actualAmount: string;
    },
  ) {
    const agent = await lockFundingAgent(tx, input, ["running"]);
    const actualMicros = moneyToMicros(input.actualAmount, "actualAmount");
    const [current] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.agent_id, input.agentId),
          eq(agentComputeFunding.organization_id, input.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    if (!current || current.provider_node_id !== agent.node_id || !current.provider_container_id) {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated renewal provider changed", input);
    }
    const [previous] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, input.fundingId),
          eq(agentComputeFunding.agent_id, input.agentId),
          eq(agentComputeFunding.organization_id, input.organizationId),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !previous ||
      !(input.settledThrough instanceof Date) ||
      !Number.isFinite(input.settledThrough.getTime()) ||
      input.settledThrough <= previous.period_start ||
      input.settledThrough > now ||
      input.settledThrough >= previous.period_end ||
      (current.id !== previous.id && current.previous_funding_id !== previous.id)
    ) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated renewal cutoff or predecessor changed",
        input,
      );
    }
    const settlePrevious = (transaction: DbTransaction) =>
      subscriptionFundingService.settleInTransaction(transaction, {
        organizationId: input.organizationId,
        logicalOperationId: `compute.${input.agentId}.${previous.id}`,
        operation: "managed_agent_compute",
        actualAmount: input.actualAmount,
        occurredAt: input.settledThrough,
        metadata: { agent_id: input.agentId, compute_funding_id: previous.id },
      });
    if (current.id !== previous.id) {
      if (previous.settled_through?.getTime() !== input.settledThrough.getTime()) {
        reject(
          AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
          "Dedicated renewal replay cutoff changed",
          input,
        );
      }
      return tx.transaction(async (nested) => {
        const settlement = await settlePrevious(nested);
        if (!settlement.replayed) {
          reject(
            AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
            "Dedicated renewal lost its settled predecessor",
            input,
          );
        }
        return {
          window: current,
          settlement,
          replayed: true,
          purchasedCreditDebited: false,
          purchasedCreditRefunded: false,
        };
      });
    }
    if (!previous.host_lease_confirmed_at) {
      reject(
        AGENT_COMPUTE_FUNDING_UNCONFIRMED,
        "Confirm the existing host grant before renewing it",
        input,
      );
    }
    if (previous.period_end <= now) {
      reject(
        AGENT_COMPUTE_FUNDING_EXPIRED,
        "Expired Dedicated funding requires provider reconciliation",
        input,
      );
    }
    const [reservation] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.id, previous.funding_reservation_id),
          eq(billingFundingReservations.organization_id, input.organizationId),
        ),
      );
    if (
      !reservation ||
      reservation.status !== "reserved" ||
      actualMicros > moneyToMicros(reservation.reserved_amount, "reservedAmount")
    ) {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated usage exceeds its held funding",
        input,
      );
    }
    return tx.transaction(async (nested) => {
      const settlement = await settlePrevious(nested);
      await nested
        .update(agentComputeFunding)
        .set({ settled_at: now, settled_through: input.settledThrough })
        .where(
          and(
            eq(agentComputeFunding.id, previous.id),
            eq(agentComputeFunding.organization_id, input.organizationId),
          ),
        );
      const replacement = await this.createWindowInTransaction(
        nested,
        input,
        input.settledThrough,
        previous,
        microsToMoney(
          moneyToMicros(previous.minimum_charge_remaining, "minimumChargeRemaining") > actualMicros
            ? moneyToMicros(previous.minimum_charge_remaining, "minimumChargeRemaining") -
                actualMicros
            : 0n,
        ),
      );
      if (replacement.window.period_end <= previous.period_end) {
        reject(
          AGENT_COMPUTE_FUNDING_EXPIRED,
          "Replacement funding does not extend the existing host lease",
          input,
        );
      }
      return {
        ...replacement,
        settlement,
        purchasedCreditRefunded: settlement.purchasedCreditRefunded,
      };
    });
  }
}

export const agentComputeFundingService = new AgentComputeFundingService();
