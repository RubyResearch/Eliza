/**
 * Exercises elapsed compute charging, tenant identity, and retry atomicity
 * against the real Drizzle statements on an isolated PGlite database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { getPgliteClientForTests } from "../../client";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import {
  dispatchContainerStopJob as dispatchContainerStopJobService,
  enqueueContainerStopOnce,
  enqueueContainerUserStopOnce,
  listRecoverableContainerStopIntents,
  rearmRecoverableContainerStopIntentOnce,
} from "../../../lib/services/container-stop-job-service";
import { getHetznerContainersClient } from "../../../lib/services/containers/hetzner-client/client";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import {
  agentBillingRecords,
  agentBillingRunItems,
  agentBillingRuns,
} from "../../schemas/compute-billing";
import { computeBillingRateSegments } from "../../schemas/compute-billing-rate-segments";
import { containerComputeStopIntents } from "../../schemas/compute-stop-intents";
import { containerBillingRecords, containers } from "../../schemas/containers";
import { creditTransactions } from "../../schemas/credit-transactions";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} from "../../schemas/redeemable-earnings";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { agentBillingRepository } from "../agent-billing";
import { agentBillingRunRepository } from "../agent-billing-runs";
import { settleComputeRateSegments } from "../compute-billing-segments";
import { containerBillingRepository } from "../container-billing";
import { containersRepository } from "../containers";
import { jobsRepository } from "../jobs";
import { installOrganizationPolicyTestSchema } from "../organization-policy-test-fixture";

const PGLITE_TIMEOUT = 60_000;
let ready = true;

beforeAll(async () => {
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      creditTransactions,
      agentBillingRecords,
      agentBillingRuns,
      agentBillingRunItems,
      computeBillingRateSegments,
      containers,
      containerBillingRecords,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
      redeemableEarnings,
      redeemableEarningsLedger,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
    await dbWrite.execute(
      sql.raw(`CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      data jsonb NOT NULL,
      data_storage text NOT NULL DEFAULT 'inline',
      data_key text,
      agent_id text,
      character_id text,
      result jsonb,
      result_storage text NOT NULL DEFAULT 'inline',
      result_key text,
      error text,
      error_storage text NOT NULL DEFAULT 'inline',
      error_key text,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      execution_interruptions integer NOT NULL DEFAULT 0,
      retryable_requeues integer NOT NULL DEFAULT 0,
      organization_id uuid NOT NULL,
      user_id uuid,
      api_key_id uuid,
      generation_id uuid,
      webhook_url text,
      webhook_status text,
      estimated_completion_at timestamp,
      scheduled_for timestamp NOT NULL DEFAULT now(),
      started_at timestamp,
      execution_generation uuid,
      execution_quiesced_at timestamp,
      completed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TABLE job_execution_leases (
      job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      execution_generation uuid NOT NULL,
      owner_id uuid NOT NULL,
      expires_at timestamp NOT NULL,
      heartbeat_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request'
        CHECK ("authorization" IN ('billing_request', 'user_request')),
      status text NOT NULL DEFAULT 'pending',
      job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      provider_node_id text,
      slot_released_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE UNIQUE INDEX container_compute_stop_intents_active_unique
      ON container_compute_stop_intents (organization_id, container_id)
      WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention')`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE UNIQUE INDEX container_compute_stop_intents_user_generation_unique
      ON container_compute_stop_intents (organization_id, container_id, lifecycle_revision)
      WHERE "authorization" = 'user_request'`),
    );
  } catch (error) {
    // error-policy:J1 The test-harness boundary records schema setup failure for the mandatory readiness assertion.
    ready = false;
    console.error("[compute-billing-recovery] PGlite schema setup failed", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(ready).toBe(true);
  await dbWrite.execute(sql.raw(`DELETE FROM jobs`));
  await dbWrite.execute(sql.raw(`DELETE FROM container_compute_stop_intents`));
  await dbWrite.delete(containerBillingRecords);
  await dbWrite.execute(sql.raw(`DELETE FROM containers`));
  await dbWrite.delete(computeBillingRateSegments);
  await dbWrite.delete(redeemableEarningsLedger);
  await dbWrite.delete(redeemableEarnings);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  await dbWrite.delete(agentBillingRecords);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seed(balance = "10.000000") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: "Compute Billing",
      slug: `compute-${crypto.randomUUID()}`,
      credit_balance: balance,
      pay_as_you_go_from_earnings: false,
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${crypto.randomUUID()}`, organization_id: org.id })
    .returning();
  const lastBilledAt = new Date("2026-08-19T01:00:00.000Z");
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: "elapsed-agent",
      status: "running",
      execution_tier: "dedicated-always",
      billing_status: "active",
      last_billed_at: lastBilledAt,
    })
    .returning();
  await dbWrite.insert(computeBillingRateSegments).values({
    organization_id: org.id,
    workload_kind: "agent",
    workload_id: sandbox.id,
    lifecycle_revision: sandbox.lifecycle_revision,
    billing_state: "running",
    rate_per_hour: "0.010000",
    effective_at: lastBilledAt,
  });
  return { org, user, sandbox, lastBilledAt };
}

/** Drive the daemon seam with the same generation + renewable lease as production. */
async function ownContainerStopJob(job: { id: string; organization_id: string; data: unknown }) {
  const [current] = await dbWrite.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
  if (!current) throw new Error(`Expected container stop job ${job.id}`);

  let claimed = current;
  let executionOwnerId: string;
  if (current.status === "pending") {
    executionOwnerId = crypto.randomUUID();
    const claims = await jobsRepository.claimPendingJobs({
      type: "container_stop",
      organizationId: current.organization_id,
      limit: 100,
      executionOwnerId,
      executionLeaseMs: 5 * 60_000,
    });
    const exact = claims.find((candidate) => candidate.id === job.id);
    if (!exact) throw new Error(`Expected container stop job ${job.id} to be claimed`);
    claimed = exact;
  } else if (current.status === "in_progress" && current.execution_generation) {
    const [lease] = await dbWrite
      .select({ ownerId: jobExecutionLeases.owner_id })
      .from(jobExecutionLeases)
      .where(
        and(
          eq(jobExecutionLeases.job_id, current.id),
          eq(jobExecutionLeases.execution_generation, current.execution_generation),
        ),
      )
      .limit(1);
    if (!lease) throw new Error(`Expected active lease for container stop job ${job.id}`);
    executionOwnerId = lease.ownerId;
  } else {
    throw new Error(`Container stop job ${job.id} is not claimable from ${current.status}`);
  }

  return {
    job: {
      id: claimed.id,
      organization_id: job.organization_id,
      execution_generation: claimed.execution_generation,
      data: job.data,
    },
    executionOwnerId,
  };
}

async function dispatchContainerStopJob(job: {
  id: string;
  organization_id: string;
  data: unknown;
}) {
  const owned = await ownContainerStopJob(job);
  return await dispatchContainerStopJobService(owned.job, {
    executionOwnerId: owned.executionOwnerId,
  });
}

async function claimBillingRun(_billingCutoffAt: Date) {
  const claim = await agentBillingRunRepository.startOrLoad({
    invocationKey: `manual:compute-recovery:${crypto.randomUUID()}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 5 * 60_000,
  });
  if (!claim.leaseToken) throw new Error("Expected billing run lease");
  return { runId: claim.run.id, leaseToken: claim.leaseToken };
}

describe("compute billing recovery", () => {
  test("commits the sandbox stamp and warning_sent item atomically after delivery", async () => {
    const { org, sandbox } = await seed("0.000000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const authority = await claimBillingRun(now);
    const input = {
      ...authority,
      sandboxId: sandbox.id,
      organizationId: org.id,
      agentName: sandbox.agent_name ?? sandbox.id,
      now,
      shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
    };

    await expect(agentBillingRepository.commitShutdownWarningForRun(input)).resolves.toBe(true);
    await expect(agentBillingRepository.commitShutdownWarningForRun(input)).resolves.toBe(false);
    const items = await dbWrite.select().from(agentBillingRunItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      run_id: authority.runId,
      sandbox_id: sandbox.id,
      action: "warning_sent",
    });
    const [updated] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(updated).toEqual({
      billingStatus: "shutdown_pending",
      warningSentAt: now,
    });
  });

  test("warning commit rejects rows outside live user-owned container authority", async () => {
    const now = new Date("2026-08-19T04:30:00.000Z");
    const rejectedAuthorities = [
      { label: "shared", executionTier: "shared", poolStatus: null, deletedAt: null },
      {
        label: "unknown",
        executionTier: "future-container-tier",
        poolStatus: null,
        deletedAt: null,
      },
      {
        label: "warm-pool",
        executionTier: "dedicated-always",
        poolStatus: "unclaimed",
        deletedAt: null,
      },
      {
        label: "soft-deleted",
        executionTier: "dedicated-always",
        poolStatus: null,
        deletedAt: new Date("2026-08-19T04:00:00.000Z"),
      },
    ] as const;

    for (const rejected of rejectedAuthorities) {
      const { org, sandbox } = await seed("0.000000");
      await dbWrite
        .update(agentSandboxes)
        .set({
          execution_tier: rejected.executionTier as never,
          pool_status: rejected.poolStatus,
          deleted_at: rejected.deletedAt,
        })
        .where(eq(agentSandboxes.id, sandbox.id));
      const authority = await claimBillingRun(now);

      await expect(
        agentBillingRepository.commitShutdownWarningForRun({
          ...authority,
          sandboxId: sandbox.id,
          organizationId: org.id,
          agentName: rejected.label,
          now,
          shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
        }),
      ).resolves.toBe(false);

      const [stored] = await dbWrite
        .select({
          billingStatus: agentSandboxes.billing_status,
          warningSentAt: agentSandboxes.shutdown_warning_sent_at,
          scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(stored).toEqual({
        billingStatus: "active",
        warningSentAt: null,
        scheduledShutdownAt: null,
      });
    }

    expect(await dbWrite.select().from(agentBillingRunItems)).toHaveLength(0);
  });

  test("a crash before the warning commit leaves the retry free to redeliver", async () => {
    const { org, sandbox } = await seed("0.000000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const invocationKey = `manual:compute-recovery:${crypto.randomUUID()}`;
    const crashed = await agentBillingRunRepository.startOrLoad({
      invocationKey,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    if (!crashed.leaseToken) throw new Error("Expected billing run lease");
    // Simulated worker death: the email may or may not have left, but the
    // commit never ran, so neither the sandbox row nor any run item changed.
    expect(await dbWrite.select().from(agentBillingRunItems)).toEqual([]);
    const [beforeRetry] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
        scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(beforeRetry).toEqual({
      billingStatus: "active",
      warningSentAt: null,
      scheduledShutdownAt: null,
    });

    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        updated_at: sql`clock_timestamp() - INTERVAL '2 seconds'`,
      })
      .where(eq(agentBillingRuns.id, crashed.run.id));
    const retry = await agentBillingRunRepository.startOrLoad({
      invocationKey,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    if (!retry.leaseToken) throw new Error("Expected recovered run lease");
    expect(retry).toMatchObject({
      claimed: true,
      recovered: true,
      run: { id: crashed.run.id, attempt_count: 2 },
    });

    await expect(
      agentBillingRepository.commitShutdownWarningForRun({
        runId: retry.run.id,
        leaseToken: retry.leaseToken,
        sandboxId: sandbox.id,
        organizationId: org.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        now,
        shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
      }),
    ).resolves.toBe(true);
    const items = await dbWrite.select().from(agentBillingRunItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      run_id: crashed.run.id,
      sandbox_id: sandbox.id,
      action: "warning_sent",
    });
    const [afterRetry] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(afterRetry).toEqual({
      billingStatus: "shutdown_pending",
      warningSentAt: now,
    });
  });

  test("Dedicated warm-pool capacity is outside every billing lifecycle path", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed();
    await dbWrite
      .update(agentSandboxes)
      .set({ pool_status: "unclaimed" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const now = new Date("2026-08-19T04:30:00.000Z");

    const billableWhileRunning = await agentBillingRepository.listBillableSandboxes(
      now,
      new Date("2026-08-19T03:30:00.000Z"),
    );
    expect(billableWhileRunning.runningSandboxes.map((row) => row.id)).not.toContain(sandbox.id);

    const input = {
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "pool-capacity",
      hourlyRate: 0.01,
      billingDescription: "must remain exempt",
      lowCreditWarningAmount: 1,
      now,
    };
    await expect(agentBillingRepository.recordHourlyBilling(input)).resolves.toEqual({
      status: "already_billed_recently",
    });
    await expect(
      agentBillingRepository.settleAccruedBillingBeforeLifecycle(sandbox.id, org.id, now),
    ).resolves.toEqual({ status: "already_billed_recently" });

    await agentBillingRepository.scheduleShutdownWarning(
      sandbox.id,
      org.id,
      now,
      new Date("2026-08-19T05:30:00.000Z"),
    );
    await agentBillingRepository.suspendSandboxForInsufficientCredits(sandbox.id, org.id, now);

    const [afterRejectedTransitions] = await dbWrite
      .select({
        billing_status: agentSandboxes.billing_status,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(afterRejectedTransitions).toEqual({
      billing_status: "active",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });

    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped", last_backup_at: now })
      .where(eq(agentSandboxes.id, sandbox.id));
    const billableWhileStopped = await agentBillingRepository.listBillableSandboxes(
      now,
      new Date("2026-08-19T03:30:00.000Z"),
    );
    expect(billableWhileStopped.stoppedWithBackups.map((row) => row.id)).not.toContain(sandbox.id);

    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended" })
      .where(eq(agentSandboxes.id, sandbox.id));
    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      sandbox.id,
      new Date("2026-08-19T04:31:00.000Z"),
      org.id,
    );

    const [stored] = await dbWrite
      .select({
        billing_status: agentSandboxes.billing_status,
        last_billed_at: agentSandboxes.last_billed_at,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(stored).toEqual({
      billing_status: "suspended",
      last_billed_at: lastBilledAt,
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });
    const [balance] = await dbWrite
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(balance.credit_balance).toBe("10.000000");
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a delayed run charges the full elapsed interval and a concurrent replay is a no-op", async () => {
    const { org, user, sandbox } = await seed();
    const now = new Date("2026-08-19T04:30:00.000Z");
    const input = {
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "elapsed compute",
      lowCreditWarningAmount: 1,
      now,
    };

    const [first, replay] = await Promise.all([
      agentBillingRepository.recordHourlyBilling(input),
      agentBillingRepository.recordHourlyBilling(input),
    ]);
    const billed = [first, replay].filter((result) => result.status === "billed");
    expect(billed).toHaveLength(1);
    expect(billed[0]).toMatchObject({ amount: 0.035 });

    const [balance] = await dbWrite
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(Number(balance.credit_balance)).toBeCloseTo(9.965, 6);

    const [counts] = await dbWrite
      .select({ receipts: sql<number>`count(*)::int` })
      .from(agentBillingRecords)
      .where(eq(agentBillingRecords.organization_id, org.id));
    expect(counts.receipts).toBe(1);
    const [runItem] = await dbWrite.select().from(agentBillingRunItems);
    expect(runItem).toMatchObject({
      run_id: input.runId,
      sandbox_id: sandbox.id,
      action: "billed",
      amount: "0.035000",
    });
    expect(runItem?.transaction_id).toBeTruthy();
  });

  test("insufficient credit rolls back the claim and creates no ledger or receipt", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed("0.001000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "elapsed compute",
      lowCreditWarningAmount: 1,
      now,
    });
    expect(result.status).toBe("insufficient_credits");

    const [row] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("an expired run lease is fenced inside the debit transaction before mutation", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed();
    const now = new Date("2026-08-19T04:30:00.000Z");
    const authority = await claimBillingRun(now);
    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        updated_at: sql`clock_timestamp() - INTERVAL '2 seconds'`,
      })
      .where(eq(agentBillingRuns.id, authority.runId));

    await expect(
      agentBillingRepository.recordHourlyBilling({
        ...authority,
        sandboxId: sandbox.id,
        organizationId: org.id,
        userId: user.id,
        agentName: "elapsed-agent",
        hourlyRate: 0.01,
        billingDescription: "expired lease must not debit",
        lowCreditWarningAmount: 1,
        now,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });

    const [sandboxAfter] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(sandboxAfter.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(agentBillingRunItems)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("funded agent lifecycle settles sub-hour debt before reactivation without forgiveness", async () => {
    const { org, sandbox } = await seed("1.000000");
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended", status: "stopped" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const resumedAt = new Date("2026-08-19T01:30:00.000Z");
    const result = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      sandbox.id,
      org.id,
      resumedAt,
    );
    expect(result).toMatchObject({ status: "billed", amount: 0.005 });
    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      sandbox.id,
      new Date("2026-08-19T01:31:00.000Z"),
      org.id,
    );
    const [row] = await dbWrite
      .select({
        last_billed_at: agentSandboxes.last_billed_at,
        billing_status: agentSandboxes.billing_status,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row).toMatchObject({ last_billed_at: resumedAt, billing_status: "active" });
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(1);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(1);
  });

  test("insufficient agent lifecycle funding preserves debt cursor and emits no receipt", async () => {
    const { org, sandbox, lastBilledAt } = await seed("0.001000");
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended", status: "stopped" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const result = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      sandbox.id,
      org.id,
      new Date("2026-08-19T01:30:00.000Z"),
    );
    expect(result.status).toBe("insufficient_credits");
    const [row] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a delayed run settles running, backup, and stopped segments at their exact rates", async () => {
    const { org, user, sandbox } = await seed();
    await dbWrite.insert(computeBillingRateSegments).values([
      {
        organization_id: org.id,
        workload_kind: "agent",
        workload_id: sandbox.id,
        lifecycle_revision: sandbox.lifecycle_revision + 1,
        billing_state: "backup",
        rate_per_hour: "0.002500",
        effective_at: new Date("2026-08-19T02:00:00.000Z"),
      },
      {
        organization_id: org.id,
        workload_kind: "agent",
        workload_id: sandbox.id,
        lifecycle_revision: sandbox.lifecycle_revision + 2,
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
        effective_at: new Date("2026-08-19T03:00:00.000Z"),
      },
    ]);
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(new Date("2026-08-19T04:00:00.000Z"))),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 999,
      billingDescription: "segmented compute",
      lowCreditWarningAmount: 1,
      now: new Date("2026-08-19T04:00:00.000Z"),
    });
    expect(result).toMatchObject({ status: "billed", amount: 0.0125 });
    const [receipt] = await dbWrite.select().from(agentBillingRecords);
    expect(receipt?.rate_segments).toHaveLength(3);
    expect(receipt?.sandbox_status).toBe("mixed");
    expect(receipt?.hourly_rate).toBe("0.004167");
  });

  test("settles across the bounded gap before an insert trigger's first rate segment", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed();
    await dbWrite.delete(computeBillingRateSegments);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "agent",
      workload_id: sandbox.id,
      lifecycle_revision: sandbox.lifecycle_revision,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: new Date(lastBilledAt.getTime() + 50),
    });

    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(new Date(lastBilledAt.getTime() + 60 * 60_000))),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 999,
      billingDescription: "segmented compute",
      lowCreditWarningAmount: 1,
      now: new Date(lastBilledAt.getTime() + 60 * 60_000),
    });

    expect(result).toMatchObject({ status: "billed", amount: 0.01 });
  });

  test.each([5_157, 45_000])(
    "slow initial transaction (%i ms) still bills only funded runtime once",
    async (creationDelayMs) => {
      const { org, user, sandbox, lastBilledAt } = await seed();
      await dbWrite.delete(computeBillingRateSegments);
      const runningAt = new Date(lastBilledAt.getTime() + 60_000);
      const now = new Date(runningAt.getTime() + 60 * 60_000);
      await dbWrite.insert(computeBillingRateSegments).values([
        {
          organization_id: org.id,
          workload_kind: "agent",
          workload_id: sandbox.id,
          lifecycle_revision: 0,
          billing_state: "not_billable",
          rate_per_hour: "0.000000",
          effective_at: new Date(lastBilledAt.getTime() + creationDelayMs),
        },
        {
          organization_id: org.id,
          workload_kind: "agent",
          workload_id: sandbox.id,
          lifecycle_revision: 2,
          billing_state: "running",
          rate_per_hour: "0.010000",
          effective_at: runningAt,
        },
      ]);
      const input = {
        ...(await claimBillingRun(now)),
        sandboxId: sandbox.id,
        organizationId: org.id,
        userId: user.id,
        agentName: "slow-created-agent",
        hourlyRate: 999,
        billingDescription: "slow creation recovery",
        lowCreditWarningAmount: 1,
        now,
      };
      await expect(agentBillingRepository.recordHourlyBilling(input)).resolves.toMatchObject({
        status: "billed",
        amount: 0.01,
      });
      await expect(agentBillingRepository.recordHourlyBilling(input)).resolves.toMatchObject({
        status: "already_billed_recently",
      });
      const [receipt] = await dbWrite.select().from(agentBillingRecords);
      expect(receipt.rate_segments).toMatchObject([
        { state: "not_billable", amount: "0.000000", endedAt: runningAt.toISOString() },
        { state: "running", amount: "0.010000", startedAt: runningAt.toISOString() },
      ]);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(1);
      const [updatedOrg] = await dbWrite
        .select()
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(updatedOrg.credit_balance).toBe("9.990000");
    },
  );

  test.each([
    { revision: 1, state: "not_billable", rate: "0.000000" },
    { revision: 0, state: "running", rate: "0.010000" },
  ])(
    "incomplete initial rate history remains rejected ($state, revision $revision)",
    async ({ revision, state, rate }) => {
      const { org, sandbox, lastBilledAt } = await seed();
      await dbWrite.delete(computeBillingRateSegments);
      await dbWrite.insert(computeBillingRateSegments).values({
        organization_id: org.id,
        workload_kind: "agent",
        workload_id: sandbox.id,
        lifecycle_revision: revision,
        billing_state: state,
        rate_per_hour: rate,
        effective_at: new Date(lastBilledAt.getTime() + 45_000),
      });
      await expect(
        agentBillingRepository.settleAccruedBillingBeforeLifecycle(
          sandbox.id,
          org.id,
          new Date(lastBilledAt.getTime() + 60 * 60_000),
        ),
      ).rejects.toThrow("Compute billing rate history is missing");
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
      const [updatedOrg] = await dbWrite
        .select()
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(updatedOrg.credit_balance).toBe("10.000000");
    },
  );

  test("a mismatched tenant cannot charge another tenant's workload", async () => {
    const { user, sandbox } = await seed();
    const [other] = await dbWrite
      .insert(organizations)
      .values({ name: "Other", slug: `other-${crypto.randomUUID()}`, credit_balance: "10" })
      .returning();
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(new Date("2026-08-19T04:30:00.000Z"))),
      sandboxId: sandbox.id,
      organizationId: other.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "cross tenant",
      lowCreditWarningAmount: 1,
      now: new Date("2026-08-19T04:30:00.000Z"),
    });
    expect(result.status).toBe("already_billed_recently");
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
  });

  test("container stop intent is single-flight for one funded tenant envelope", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000001";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'stop-fixture', 'stop-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 4, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 4,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const first = await enqueueContainerStopOnce({
      containerId,
      organizationId: org.id,
    });
    const replay = await enqueueContainerStopOnce({
      containerId,
      organizationId: org.id,
    });
    expect(first.requested).toBe(true);
    if (!first.requested) throw new Error("Expected durable stop request");
    expect(first.created).toBe(true);
    expect(replay).toEqual({ requested: true, id: first.id, created: false });
    const rows = await dbWrite.execute(
      sql.raw(`SELECT organization_id FROM jobs ORDER BY organization_id`),
    );
    expect(rows.rows).toHaveLength(1);
  });

  test("recovery discovery excludes live jobs and includes failed or unbound intents", async () => {
    const { org, user } = await seed("10.000000");
    const dueAt = new Date(0);
    const fixtures = await Promise.all(
      ["pending", "failed", "unbound"].map(async (jobStatus) => {
        const containerId = crypto.randomUUID();
        await dbWrite.insert(containers).values({
          id: containerId,
          organization_id: org.id,
          user_id: user.id,
          name: `recovery-${jobStatus}`,
          project_name: `recovery-${jobStatus}`,
          status: "running",
          billing_status: "active",
          lifecycle_revision: 1,
        });
        const [intent] = await dbWrite
          .insert(containerComputeStopIntents)
          .values({
            organization_id: org.id,
            container_id: containerId,
            lifecycle_revision: 1,
            authorization: "user_request",
            status: "retry",
            next_attempt_at: dueAt,
          })
          .returning();
        if (jobStatus === "unbound") return { intent, job: null };
        const [job] = await dbWrite
          .insert(jobs)
          .values({
            type: "container_stop",
            status: jobStatus,
            organization_id: org.id,
            user_id: user.id,
            data: {
              containerId,
              organizationId: org.id,
              intentId: intent.id,
              lifecycleRevision: 1,
            },
          })
          .returning();
        await dbWrite
          .update(containerComputeStopIntents)
          .set({ job_id: job.id })
          .where(eq(containerComputeStopIntents.id, intent.id));
        return { intent, job };
      }),
    );

    const billingContainerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: billingContainerId,
      organization_id: org.id,
      user_id: user.id,
      name: "recovery-billing-due",
      project_name: "recovery-billing-due",
      status: "running",
      billing_status: "shutdown_pending",
      scheduled_shutdown_at: new Date(0),
      lifecycle_revision: 1,
    });
    const [billingIntent] = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: billingContainerId,
        lifecycle_revision: 1,
        authorization: "billing_request",
        status: "retry",
        next_attempt_at: dueAt,
      })
      .returning();

    const invalidDueAt = new Date(-1_000);
    const missingContainerIntent = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: crypto.randomUUID(),
        lifecycle_revision: 1,
        authorization: "user_request",
        status: "retry",
        next_attempt_at: invalidDueAt,
      })
      .returning();
    const staleContainerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: staleContainerId,
      organization_id: org.id,
      user_id: user.id,
      name: "recovery-stale-lifecycle",
      project_name: "recovery-stale-lifecycle",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 2,
    });
    const staleLifecycleIntent = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: staleContainerId,
        lifecycle_revision: 1,
        authorization: "user_request",
        status: "retry",
        next_attempt_at: invalidDueAt,
      })
      .returning();
    const unauthorizedBillingContainerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: unauthorizedBillingContainerId,
      organization_id: org.id,
      user_id: user.id,
      name: "recovery-billing-not-due",
      project_name: "recovery-billing-not-due",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 1,
    });
    const unauthorizedBillingIntent = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: unauthorizedBillingContainerId,
        lifecycle_revision: 1,
        authorization: "billing_request",
        status: "retry",
        next_attempt_at: invalidDueAt,
      })
      .returning();

    const recoverable = await listRecoverableContainerStopIntents(new Date(), 3);
    const ids = recoverable.map((intent) => intent.id);
    expect(ids).not.toContain(fixtures[0]!.intent.id);
    expect(ids).toContain(fixtures[1]!.intent.id);
    expect(ids).toContain(fixtures[2]!.intent.id);
    expect(ids).toContain(billingIntent.id);
    expect(ids).not.toContain(missingContainerIntent[0]!.id);
    expect(ids).not.toContain(staleLifecycleIntent[0]!.id);
    expect(ids).not.toContain(unauthorizedBillingIntent[0]!.id);
  });

  test("recovery pagination skips more than one page of poisoned failed jobs", async () => {
    const { org, user } = await seed("10.000000");
    const poisonDueAt = new Date("2026-08-26T00:00:00.000Z");
    const validDueAt = new Date("2026-08-26T00:01:00.000Z");
    const scanAt = new Date("2026-08-26T00:02:00.000Z");
    const poisonContainers: Array<typeof containers.$inferInsert> = [];
    const poisonJobs: Array<typeof jobs.$inferInsert> = [];
    const poisonIntents: Array<typeof containerComputeStopIntents.$inferInsert> = [];

    for (let index = 0; index < 104; index += 1) {
      const containerId = crypto.randomUUID();
      const intentId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      poisonContainers.push({
        id: containerId,
        organization_id: org.id,
        user_id: user.id,
        name: `poison-recovery-${index}`,
        project_name: `poison-recovery-${index}`,
        status: "running",
        billing_status: "active",
        lifecycle_revision: 1,
      });
      poisonJobs.push({
        id: jobId,
        type: "container_stop",
        status: "failed",
        organization_id: org.id,
        user_id: user.id,
        data: {
          containerId,
          organizationId: org.id,
          intentId,
          lifecycleRevision: "not-a-safe-revision",
        },
      });
      poisonIntents.push({
        id: intentId,
        organization_id: org.id,
        container_id: containerId,
        lifecycle_revision: 1,
        authorization: "user_request",
        status: "terminal_attention",
        job_id: jobId,
        next_attempt_at: poisonDueAt,
      });
    }

    // Exercise the envelope filters independently from the malformed-payload
    // page above. None may consume a slot from the bounded recovery result.
    for (const poisonKind of ["type", "tenant", "storage"] as const) {
      const containerId = crypto.randomUUID();
      const intentId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      poisonContainers.push({
        id: containerId,
        organization_id: org.id,
        user_id: user.id,
        name: `poison-recovery-${poisonKind}`,
        project_name: `poison-recovery-${poisonKind}`,
        status: "running",
        billing_status: "active",
        lifecycle_revision: 1,
      });
      poisonJobs.push({
        id: jobId,
        type: poisonKind === "type" ? "container_restart" : "container_stop",
        status: "failed",
        organization_id: poisonKind === "tenant" ? crypto.randomUUID() : org.id,
        user_id: user.id,
        data_storage: poisonKind === "storage" ? "r2" : "inline",
        data_key: poisonKind === "storage" ? `poison/${jobId}` : null,
        data: {
          containerId,
          organizationId: org.id,
          intentId,
          lifecycleRevision: 1,
        },
      });
      poisonIntents.push({
        id: intentId,
        organization_id: org.id,
        container_id: containerId,
        lifecycle_revision: 1,
        authorization: "user_request",
        status: "terminal_attention",
        job_id: jobId,
        next_attempt_at: poisonDueAt,
      });
    }

    const validContainerId = crypto.randomUUID();
    const validIntentId = crypto.randomUUID();
    const validJobId = crypto.randomUUID();
    poisonContainers.push({
      id: validContainerId,
      organization_id: org.id,
      user_id: user.id,
      name: "valid-late-recovery",
      project_name: "valid-late-recovery",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 1,
    });
    poisonJobs.push({
      id: validJobId,
      type: "container_stop",
      status: "failed",
      organization_id: org.id,
      user_id: user.id,
      data: {
        containerId: validContainerId,
        organizationId: org.id,
        intentId: validIntentId,
        lifecycleRevision: 1,
      },
    });
    poisonIntents.push({
      id: validIntentId,
      organization_id: org.id,
      container_id: validContainerId,
      lifecycle_revision: 1,
      authorization: "user_request",
      status: "terminal_attention",
      job_id: validJobId,
      next_attempt_at: validDueAt,
    });

    await dbWrite.insert(containers).values(poisonContainers);
    await dbWrite.insert(jobs).values(poisonJobs);
    await dbWrite.insert(containerComputeStopIntents).values(poisonIntents);

    const recoverable = await listRecoverableContainerStopIntents(scanAt, 100);
    expect(recoverable.map((intent) => intent.id)).toEqual([validIntentId]);
    const rearmed = await rearmRecoverableContainerStopIntentOnce({
      intentId: validIntentId,
      containerId: validContainerId,
      organizationId: org.id,
      lifecycleRevision: 1,
      now: scanAt,
    });
    expect(rearmed).toEqual({ id: validJobId, rearmed: true });
    const [sameJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, validJobId));
    expect(sameJob).toMatchObject({ id: validJobId, status: "pending", attempts: 0 });
  });

  test("user stop rejects a stale first submit without creating an intent or job", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "stale-user-stop",
      project_name: "stale-user-stop",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 5,
    });

    await expect(
      enqueueContainerUserStopOnce({
        containerId,
        organizationId: org.id,
        userId: user.id,
        expectedLifecycleRevision: 4,
      }),
    ).resolves.toEqual({
      requested: false,
      intentId: null,
      jobId: null,
      created: false,
      replayed: false,
      reason: "stale_lifecycle",
      currentLifecycleRevision: 5,
    });
    expect(await dbWrite.select().from(containerComputeStopIntents)).toHaveLength(0);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("user stop replays its exact generation before stale validation and dispatch stays fenced", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "replayed-user-stop",
      project_name: "replayed-user-stop",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 6,
    });
    const first = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 6,
    });
    if (!first.requested) throw new Error("Expected durable user stop request");
    await dbWrite
      .update(containers)
      .set({ lifecycle_revision: 7, status: "deploying" })
      .where(eq(containers.id, containerId));

    await expect(
      enqueueContainerUserStopOnce({
        containerId,
        organizationId: org.id,
        userId: user.id,
        expectedLifecycleRevision: 6,
      }),
    ).resolves.toEqual({
      requested: true,
      intentId: first.intentId,
      jobId: first.jobId,
      created: false,
      replayed: true,
    });
    expect(await dbWrite.select().from(containerComputeStopIntents)).toHaveLength(1);
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);

    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(dispatchContainerStopJob(job)).resolves.toMatchObject({
        stopped: false,
        reason: "stale-lifecycle-generation",
      });
      expect(providerStop).not.toHaveBeenCalled();
      const [intent] = await dbWrite.select().from(containerComputeStopIntents);
      expect(intent).toMatchObject({
        id: first.intentId,
        authorization: "user_request",
        status: "superseded",
      });
    } finally {
      providerStop.mockRestore();
    }
  });

  test("user replay rejects a live job whose payload no longer matches the intent", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "mismatched-live-stop-job",
      project_name: "mismatched-live-stop-job",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 4,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 4,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    await dbWrite
      .update(jobs)
      .set({
        data: sql`jsonb_set(${jobs.data}, '{intentId}', to_jsonb(${crypto.randomUUID()}::text))`,
      })
      .where(eq(jobs.id, requested.jobId));

    await expect(
      enqueueContainerUserStopOnce({
        containerId,
        organizationId: org.id,
        userId: user.id,
        expectedLifecycleRevision: 4,
      }),
    ).rejects.toThrow("Live container stop job payload does not match its durable intent");
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);
    const [intent] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.id, requested.intentId));
    expect(intent).toMatchObject({ status: "pending", job_id: requested.jobId });
  });

  test("user authority promotes a billing intent, reuses its job, and cannot be funding-superseded", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "promoted-user-stop",
      project_name: "promoted-user-stop",
      status: "running",
      billing_status: "shutdown_pending",
      shutdown_warning_sent_at: periodStart,
      scheduled_shutdown_at: new Date(Date.now() - 60_000),
      next_billing_at: new Date(Date.now() + 60_000),
      last_billed_at: periodStart,
      lifecycle_revision: 8,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 8,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const billing = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!billing.requested) throw new Error("Expected billing stop request");

    const promoted = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 8,
    });
    expect(promoted).toMatchObject({
      requested: true,
      jobId: billing.id,
      created: false,
      replayed: false,
    });
    const [promotedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, billing.id));
    expect(promotedJob.user_id).toBeNull();
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "10.000000" })
      .where(eq(organizations.id, org.id));
    await expect(
      enqueueContainerStopOnce({ containerId, organizationId: org.id }),
    ).resolves.toEqual({ requested: true, id: billing.id, created: false });

    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, billing.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledWith(containerId, org.id, 8);
      const [intent] = await dbWrite.select().from(containerComputeStopIntents);
      expect(intent).toMatchObject({
        authorization: "user_request",
        job_id: billing.id,
        status: "provider_confirmed",
      });
      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(container).toMatchObject({
        status: "stopped",
        billing_status: "suspended",
        next_billing_at: null,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
      });
      expect(container.last_billed_at?.getTime()).toBeGreaterThan(periodStart.getTime());
      expect(Number(container.total_billed)).toBeGreaterThan(0);
      const [receipt] = await dbWrite.select().from(containerBillingRecords);
      expect(receipt).toMatchObject({
        container_id: containerId,
        organization_id: org.id,
        status: "success",
      });
      expect(receipt.credit_transaction_id).not.toBeNull();
      expect(receipt.rate_segments).toHaveLength(1);
      const [balance] = await dbWrite
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(Number(balance.credit_balance)).toBeCloseTo(10 - Number(receipt.amount), 6);
    } finally {
      providerStop.mockRestore();
    }
  });

  test("user stop persists an uncollected terminal receipt when funding is insufficient", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "uncollected-user-stop",
      project_name: "uncollected-user-stop",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 9,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 9,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 9,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");

    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
      await expect(dispatchContainerStopJob(job)).resolves.toMatchObject({
        stopped: true,
        reason: "already-provider-confirmed",
      });
      expect(providerStop).toHaveBeenCalledTimes(1);

      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(container).toMatchObject({
        status: "stopped",
        billing_status: "suspended",
        next_billing_at: null,
      });
      expect(container.last_billed_at?.getTime()).toBeGreaterThan(periodStart.getTime());
      expect(Number(container.total_billed)).toBe(0);

      const receipts = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        organization_id: org.id,
        status: "uncollected",
        credit_transaction_id: null,
      });
      expect(Number(receipts[0]?.amount)).toBeGreaterThan(0);
      expect(receipts[0]?.rate_segments).toHaveLength(1);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
    } finally {
      providerStop.mockRestore();
    }
  });

  test("a rejected provider leaves a user-requested stop retryable and compute running", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "rejected-user-stop",
      project_name: "rejected-user-stop",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 12,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 12,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const [beforeProvider] = await dbWrite
      .select({ last_billed_at: containers.last_billed_at })
      .from(containers)
      .where(eq(containers.id, containerId));

    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockRejectedValue(new Error("provider rejected user stop"));
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow("provider rejected user stop");
      expect(providerStop).toHaveBeenCalledWith(containerId, org.id, 12);
      const [intent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(intent).toMatchObject({
        authorization: "user_request",
        status: "retry",
        attempts: 1,
        last_error: "provider rejected user stop",
      });
      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(container).toMatchObject({ status: "running", billing_status: "active" });
      expect(container.last_billed_at).toEqual(beforeProvider.last_billed_at);
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
    } finally {
      providerStop.mockRestore();
    }
  });

  test("post-provider settlement rejection preserves the cutoff and rearms a dead user job", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "rejected-settlement-user-stop",
      project_name: "rejected-settlement-user-stop",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 13,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 13,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 13,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");

    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    const settlement = spyOn(
      containerBillingRepository,
      "recordSuccessfulDailyBillingInTransaction",
    ).mockRejectedValue(new Error("application settlement rejected"));
    let settlementMocked = true;
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow(
        "application settlement rejected",
      );
      expect(providerStop).toHaveBeenCalledWith(containerId, org.id, 13);
      const [intent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(intent).toMatchObject({ status: "retry", attempts: 1 });
      expect(intent.provider_started_at).toBeInstanceOf(Date);
      expect(intent.provider_confirmed_at).toBeInstanceOf(Date);
      const providerCutoff = intent.provider_confirmed_at;
      if (!providerCutoff) throw new Error("Expected durable provider cutoff");
      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(container).toMatchObject({
        status: "running",
        billing_status: "suspended",
        next_billing_at: null,
      });
      const billableAfterProof = await containerBillingRepository.listBillableContainers(
        new Date(providerCutoff.getTime() + 24 * 60 * 60 * 1000),
      );
      expect(billableAfterProof.map((row) => row.id)).not.toContain(containerId);
      const cutoffSegments = await dbWrite
        .select()
        .from(computeBillingRateSegments)
        .where(
          and(
            eq(computeBillingRateSegments.organization_id, org.id),
            eq(computeBillingRateSegments.workload_kind, "container"),
            eq(computeBillingRateSegments.workload_id, containerId),
            eq(computeBillingRateSegments.lifecycle_revision, 13),
            eq(computeBillingRateSegments.effective_at, providerCutoff),
          ),
        );
      expect(cutoffSegments).toHaveLength(1);
      expect(cutoffSegments[0]).toMatchObject({
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
      });
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);

      const preservedStartedAt = new Date(providerCutoff.getTime() - 2_000);
      const terminalAt = new Date(providerCutoff.getTime() + 2_000);
      const executionGeneration = crypto.randomUUID();
      await dbWrite
        .update(jobs)
        .set({
          status: "failed",
          attempts: 3,
          execution_interruptions: 2,
          retryable_requeues: 2,
          result: null,
          result_storage: "r2",
          result_key: "container-stop/audit/result.json",
          error: null,
          error_storage: "r2",
          error_key: "container-stop/audit/error.txt",
          started_at: preservedStartedAt,
          execution_generation: executionGeneration,
          execution_quiesced_at: terminalAt,
          completed_at: terminalAt,
        })
        .where(eq(jobs.id, requested.jobId));
      await dbWrite.execute(sql`INSERT INTO job_execution_leases
        (job_id, execution_generation, owner_id, expires_at)
        VALUES (${requested.jobId}, ${executionGeneration}, ${crypto.randomUUID()},
          ${new Date(terminalAt.getTime() + 60_000)})
        ON CONFLICT (job_id) DO UPDATE SET
          execution_generation = EXCLUDED.execution_generation,
          owner_id = EXCLUDED.owner_id,
          expires_at = EXCLUDED.expires_at`);
      const replay = await enqueueContainerUserStopOnce({
        containerId,
        organizationId: org.id,
        userId: user.id,
        expectedLifecycleRevision: 13,
      });
      if (!replay.requested) throw new Error("Expected rearmed user stop");
      expect(replay).toMatchObject({
        intentId: requested.intentId,
        created: true,
        replayed: true,
      });
      expect(replay.jobId).toBe(requested.jobId);
      const [rearmed] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(rearmed).toMatchObject({ status: "retry", attempts: 1 });
      expect(rearmed.provider_confirmed_at).toEqual(providerCutoff);
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, replay.jobId));
      expect(rearmedJob).toMatchObject({
        id: requested.jobId,
        status: "pending",
        attempts: 0,
        execution_interruptions: 0,
        retryable_requeues: 0,
        result_storage: "r2",
        result_key: "container-stop/audit/result.json",
        error_storage: "r2",
        error_key: "container-stop/audit/error.txt",
        started_at: preservedStartedAt,
        execution_generation: null,
        execution_quiesced_at: null,
        completed_at: null,
      });
      const remainingLease = await dbWrite.execute(
        sql`SELECT count(*)::int AS count FROM job_execution_leases
            WHERE job_id = ${requested.jobId}`,
      );
      expect(remainingLease.rows[0]).toMatchObject({ count: 0 });

      settlement.mockRestore();
      settlementMocked = false;
      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [receipt] = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipt.billing_period_end).toEqual(providerCutoff);
      const [settledContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(settledContainer.last_billed_at).toEqual(providerCutoff);
      const replayedCutoffSegments = await dbWrite
        .select()
        .from(computeBillingRateSegments)
        .where(
          and(
            eq(computeBillingRateSegments.organization_id, org.id),
            eq(computeBillingRateSegments.workload_id, containerId),
            eq(computeBillingRateSegments.lifecycle_revision, 13),
            eq(computeBillingRateSegments.effective_at, providerCutoff),
          ),
        );
      expect(replayedCutoffSegments).toHaveLength(1);
    } finally {
      if (settlementMocked) settlement.mockRestore();
      providerStop.mockRestore();
    }
  });

  test("a SQL fence failure preserves provider proof and blocks stale billing discovery and debit", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "provider-proof-savepoint",
      project_name: "provider-proof-savepoint",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 17,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 17,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 17,
    });
    if (!requested.requested) throw new Error("Expected provider-proof stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    providerStop.mockClear();
    await dbWrite.execute(
      sql.raw(`CREATE FUNCTION fail_provider_stop_billing_fence() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'running' AND NEW.status = 'running'
          AND NEW.billing_status = 'suspended' THEN
          RAISE EXCEPTION 'simulated provider stop fence failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TRIGGER fail_provider_stop_billing_fence
        BEFORE UPDATE ON containers FOR EACH ROW
        EXECUTE FUNCTION fail_provider_stop_billing_fence()`),
    );
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow();
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [intent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(intent).toMatchObject({ status: "retry", attempts: 1 });
      expect(intent.provider_confirmed_at).toBeInstanceOf(Date);
      const providerCutoff = intent.provider_confirmed_at;
      if (!providerCutoff) throw new Error("Expected provider proof outside the failed savepoint");
      const [unfencedContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(unfencedContainer).toMatchObject({ status: "running", billing_status: "active" });

      const discovered = await containerBillingRepository.listBillableContainers(
        new Date(providerCutoff.getTime() + 60 * 60 * 1000),
      );
      expect(discovered.map((row) => row.id)).not.toContain(containerId);

      const staleWriterResult = await containerBillingRepository.recordSuccessfulDailyBilling({
        containerId,
        organizationId: org.id,
        userId: user.id,
        containerName: unfencedContainer.name,
        dailyRate: 0.67,
        earningsSourceUserId: null,
        payAsYouGoFromEarnings: false,
        newBalance: 10,
        now: new Date(providerCutoff.getTime() + 60 * 60 * 1000),
      });
      expect(staleWriterResult).toMatchObject({ alreadyBilled: true, amount: 0 });
      const [organization] = await dbWrite
        .select({ creditBalance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(organization.creditBalance).toBe("10.000000");
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);

      await dbWrite.execute(sql.raw(`DROP TRIGGER fail_provider_stop_billing_fence ON containers`));
      await dbWrite.update(jobs).set({ status: "failed" }).where(eq(jobs.id, requested.jobId));
      await dbWrite
        .update(containerComputeStopIntents)
        .set({ next_attempt_at: new Date(0) })
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      const recovered = await rearmRecoverableContainerStopIntentOnce({
        intentId: requested.intentId,
        containerId,
        organizationId: org.id,
        lifecycleRevision: 17,
        now: new Date(),
      });
      expect(recovered).toEqual({ id: requested.jobId, rearmed: true });
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, recovered.id));
      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [receipt] = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipt.billing_period_end).toEqual(providerCutoff);
      const [settledContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(settledContainer).toMatchObject({
        status: "stopped",
        billing_status: "suspended",
        last_billed_at: providerCutoff,
      });
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(`DROP TRIGGER IF EXISTS fail_provider_stop_billing_fence ON containers`),
      );
      await dbWrite.execute(sql.raw(`DROP FUNCTION IF EXISTS fail_provider_stop_billing_fence()`));
    }
  });

  test("user authority rearms a provider-confirmed billing intent without erasing its proof", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const providerCutoff = new Date(Date.now() - 60_000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "rearmed-user-stop",
      project_name: "rearmed-user-stop",
      status: "running",
      billing_status: "suspended",
      last_billed_at: periodStart,
      lifecycle_revision: 18,
      created_at: periodStart,
      updated_at: periodStart,
    });
    const [intent] = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: containerId,
        lifecycle_revision: 18,
        authorization: "billing_request",
        status: "terminal_attention",
        attempts: 3,
        last_error: "terminal settlement unavailable",
        provider_started_at: new Date(providerCutoff.getTime() - 1_000),
        provider_confirmed_at: providerCutoff,
        provider_node_id: "node-proof-18",
      })
      .returning();
    const [deadJob] = await dbWrite
      .insert(jobs)
      .values({
        type: "container_stop",
        status: "failed",
        attempts: 4,
        error: "worker exhausted settlement retries",
        execution_generation: crypto.randomUUID(),
        execution_quiesced_at: new Date(),
        completed_at: new Date(),
        organization_id: org.id,
        data: {
          containerId,
          organizationId: org.id,
          intentId: intent.id,
          lifecycleRevision: 18,
        },
      })
      .returning();
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ job_id: deadJob.id })
      .where(eq(containerComputeStopIntents.id, intent.id));

    const userStop = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 18,
    });
    if (!userStop.requested) throw new Error("Expected rearmed user stop");

    expect(userStop).toMatchObject({ created: true, replayed: false, intentId: intent.id });
    expect(userStop.jobId).toBe(deadJob.id);
    const [rearmed] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.id, intent.id));
    expect(rearmed).toMatchObject({
      authorization: "user_request",
      status: "retry",
      job_id: userStop.jobId,
      attempts: 3,
      last_error: "terminal settlement unavailable",
      provider_node_id: "node-proof-18",
    });
    expect(rearmed.provider_confirmed_at).toEqual(providerCutoff);
    const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, userStop.jobId));
    expect(rearmedJob).toMatchObject({
      id: deadJob.id,
      status: "pending",
      user_id: user.id,
      attempts: 0,
      error: "worker exhausted settlement retries",
      execution_generation: null,
      execution_quiesced_at: null,
      completed_at: null,
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);
  });

  test("user replay fails closed for completed or cancelled container stop jobs", async () => {
    const { org, user } = await seed("10.000000");
    for (const [offset, terminalStatus] of ["completed", "cancelled"].entries()) {
      const containerId = crypto.randomUUID();
      const lifecycleRevision = 30 + offset;
      await dbWrite.insert(containers).values({
        id: containerId,
        organization_id: org.id,
        user_id: user.id,
        name: `terminal-replay-${terminalStatus}`,
        project_name: `terminal-replay-${terminalStatus}`,
        status: "running",
        billing_status: "active",
        lifecycle_revision: lifecycleRevision,
      });
      const [intent] = await dbWrite
        .insert(containerComputeStopIntents)
        .values({
          organization_id: org.id,
          container_id: containerId,
          lifecycle_revision: lifecycleRevision,
          authorization: "user_request",
          status: "retry",
          last_error: "settlement still active",
        })
        .returning();
      const [terminalJob] = await dbWrite
        .insert(jobs)
        .values({
          type: "container_stop",
          status: terminalStatus,
          completed_at: new Date(),
          organization_id: org.id,
          user_id: user.id,
          data: {
            containerId,
            organizationId: org.id,
            intentId: intent.id,
            lifecycleRevision,
          },
        })
        .returning();
      await dbWrite
        .update(containerComputeStopIntents)
        .set({ job_id: terminalJob.id })
        .where(eq(containerComputeStopIntents.id, intent.id));

      await expect(
        enqueueContainerUserStopOnce({
          containerId,
          organizationId: org.id,
          userId: user.id,
          expectedLifecycleRevision: lifecycleRevision,
        }),
      ).rejects.toThrow(`cannot be rearmed from ${terminalStatus}`);
      const [unchangedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, terminalJob.id));
      expect(unchangedJob.status).toBe(terminalStatus);
      const [unchangedIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, intent.id));
      expect(unchangedIntent).toMatchObject({ status: "retry", job_id: terminalJob.id });
    }
  });

  test("independent cron recovery rearms user and billing intents outside billable discovery", async () => {
    const { org, user } = await seed("10.000000");
    for (const [offset, authorization] of ["billing_request", "user_request"].entries()) {
      const containerId = crypto.randomUUID();
      const periodStart = new Date(Date.now() - 60 * 60 * 1000);
      const providerCutoff = new Date(Date.now() - 60_000 - offset);
      const recoveryAt = new Date(Date.now() + 1_000);
      const lifecycleRevision = 19 + offset;
      const nodeId = `node-proof-${lifecycleRevision}`;
      await dbWrite.insert(containers).values({
        id: containerId,
        organization_id: org.id,
        user_id: user.id,
        name: `cron-rearmed-stop-${offset}`,
        project_name: `cron-rearmed-stop-${offset}`,
        status: "running",
        billing_status: "suspended",
        // Explicit user cancellations have no billing shutdown schedule. Their
        // proof recovery must be driven by the intent scan, not billable rows.
        scheduled_shutdown_at:
          authorization === "billing_request" ? new Date(Date.now() - 30_000) : null,
        last_billed_at: periodStart,
        lifecycle_revision: lifecycleRevision,
        created_at: periodStart,
        updated_at: periodStart,
      });
      const [intent] = await dbWrite
        .insert(containerComputeStopIntents)
        .values({
          organization_id: org.id,
          container_id: containerId,
          lifecycle_revision: lifecycleRevision,
          authorization: authorization as "billing_request" | "user_request",
          status: "retry",
          attempts: 1,
          last_error: "receipt unavailable",
          provider_started_at: new Date(providerCutoff.getTime() - 1_000),
          provider_confirmed_at: providerCutoff,
          provider_node_id: nodeId,
          job_id: null,
        })
        .returning();

      let historicalJobId: string | null = null;
      if (authorization === "user_request") {
        const [failedJob] = await dbWrite
          .insert(jobs)
          .values({
            type: "container_stop",
            status: "failed",
            organization_id: org.id,
            user_id: user.id,
            data: {
              containerId,
              organizationId: org.id,
              intentId: intent.id,
              lifecycleRevision,
            },
          })
          .returning();
        historicalJobId = failedJob.id;
        await dbWrite
          .update(containerComputeStopIntents)
          .set({ job_id: failedJob.id })
          .where(eq(containerComputeStopIntents.id, intent.id));
      }

      const rearmedJob = await rearmRecoverableContainerStopIntentOnce({
        intentId: intent.id,
        containerId,
        organizationId: org.id,
        lifecycleRevision,
        now: recoveryAt,
      });
      expect(rearmedJob).toMatchObject({ rearmed: true });
      if (historicalJobId) expect(rearmedJob.id).toBe(historicalJobId);
      const [rearmed] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, intent.id));
      expect(rearmed).toMatchObject({
        authorization,
        status: "retry",
        job_id: rearmedJob.id,
        attempts: 1,
        provider_node_id: nodeId,
      });
      expect(rearmed.provider_confirmed_at).toEqual(providerCutoff);
      const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, rearmedJob.id));
      expect(job).toMatchObject({ status: "pending", scheduled_for: recoveryAt });
      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(container).toMatchObject({ status: "running", billing_status: "suspended" });
    }
  });

  test("funding restored under the stop-decision locks reactivates without a provider job", async () => {
    const periodStart = new Date(Math.floor((Date.now() - 60 * 60 * 1_000) / 1_000) * 1_000);
    const { org, user } = await seed("10.000000");
    const containerId = "00000000-0000-4000-8000-000000000002";
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'funding-fixture', 'funding-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 2, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 2,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const outcome = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    expect(outcome).toMatchObject({ requested: false, reason: "funding_restored" });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    const [row] = await dbWrite
      .select({
        billing_status: containers.billing_status,
        scheduled_shutdown_at: containers.scheduled_shutdown_at,
        last_billed_at: containers.last_billed_at,
      })
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(row).toMatchObject({
      billing_status: "active",
      scheduled_shutdown_at: null,
    });
    expect(row.last_billed_at).toEqual(periodStart);
  });

  test("policy-permitted earnings fund stop revalidation without forgiving elapsed debt", async () => {
    const periodStart = new Date(Math.floor((Date.now() - 60 * 60 * 1_000) / 1_000) * 1_000);
    const { org, user } = await seed("0.000000");
    await dbWrite
      .update(organizations)
      .set({ pay_as_you_go_from_earnings: true })
      .where(eq(organizations.id, org.id));
    await dbWrite.insert(redeemableEarnings).values({
      user_id: user.id,
      total_earned: "10.0000",
      available_balance: "10.0000",
    });
    const containerId = "00000000-0000-4000-8000-000000000006";
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'earnings-fixture', 'earnings-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 12, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 12,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });

    await expect(
      enqueueContainerStopOnce({ containerId, organizationId: org.id }),
    ).resolves.toMatchObject({ requested: false, reason: "funding_restored" });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    const [row] = await dbWrite
      .select({
        billing_status: containers.billing_status,
        last_billed_at: containers.last_billed_at,
      })
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(row).toMatchObject({
      billing_status: "active",
    });
    expect(row.last_billed_at).toEqual(periodStart);
  });

  test("shutdown warning CAS refuses any durable provider proof", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = crypto.randomUUID();
    const providerCutoff = new Date("2026-08-19T02:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "warning-provider-proof-fence",
      project_name: "warning-provider-proof-fence",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 3,
    });
    await dbWrite.insert(containerComputeStopIntents).values({
      organization_id: org.id,
      container_id: containerId,
      lifecycle_revision: 3,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_started_at: new Date(providerCutoff.getTime() - 1_000),
      provider_confirmed_at: providerCutoff,
    });

    await expect(
      containerBillingRepository.scheduleShutdownWarning(
        containerId,
        org.id,
        new Date("2026-08-19T03:00:00.000Z"),
        new Date("2026-08-21T03:00:00.000Z"),
      ),
    ).resolves.toBe(false);
    const [container] = await dbWrite
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(container).toMatchObject({
      status: "running",
      billing_status: "active",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });
  });

  test("funded restart refuses an active provider proof before debit or supersession", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    const providerCutoff = new Date("2026-08-19T02:00:00.000Z");
    const restartAt = new Date("2026-08-19T03:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "provider-proof-restart-fence",
      project_name: "provider-proof-restart-fence",
      status: "running",
      billing_status: "suspended",
      last_billed_at: periodStart,
      lifecycle_revision: 24,
      created_at: periodStart,
      updated_at: providerCutoff,
    });
    await dbWrite.insert(computeBillingRateSegments).values([
      {
        organization_id: org.id,
        workload_kind: "container",
        workload_id: containerId,
        lifecycle_revision: 24,
        billing_state: "running",
        rate_per_hour: "0.027917",
        effective_at: periodStart,
      },
      {
        organization_id: org.id,
        workload_kind: "container",
        workload_id: containerId,
        lifecycle_revision: 24,
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
        effective_at: providerCutoff,
      },
    ]);
    const [proofIntent] = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: containerId,
        lifecycle_revision: 24,
        authorization: "user_request",
        status: "retry",
        provider_started_at: new Date(providerCutoff.getTime() - 1_000),
        provider_confirmed_at: providerCutoff,
        last_error: "terminal settlement unavailable",
      })
      .returning();

    await expect(
      containersRepository.prepareFundedRestart(containerId, org.id, restartAt),
    ).rejects.toThrow("provider-confirmed stop settlement completes");
    const [container] = await dbWrite
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(container).toMatchObject({
      status: "running",
      billing_status: "suspended",
      last_billed_at: periodStart,
    });
    const [organization] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(organization.creditBalance).toBe("10.000000");
    expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
    const [intent] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.id, proofIntent.id));
    expect(intent).toMatchObject({ status: "retry", superseded_at: null });
    expect(intent.provider_confirmed_at).toEqual(providerCutoff);
  });

  test("funded restart refuses a terminal removed runtime before debit or status mutation", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const providerCutoff = new Date("2026-08-19T02:00:00.000Z");
    const slotReleasedAt = new Date("2026-08-19T02:00:01.000Z");
    const restartAt = new Date("2026-08-19T03:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "removed-runtime-restart-fence",
      project_name: "removed-runtime-restart-fence",
      status: "stopped",
      billing_status: "suspended",
      last_billed_at: providerCutoff,
      lifecycle_revision: 55,
      created_at: new Date("2026-08-19T01:00:00.000Z"),
      updated_at: slotReleasedAt,
    });
    const [terminalProof] = await dbWrite
      .insert(containerComputeStopIntents)
      .values({
        organization_id: org.id,
        container_id: containerId,
        // The terminal proof remains authoritative even after unrelated row
        // lifecycle writes advance beyond the removed provider generation.
        lifecycle_revision: 12,
        authorization: "user_request",
        status: "provider_confirmed",
        provider_started_at: new Date(providerCutoff.getTime() - 1_000),
        provider_confirmed_at: providerCutoff,
        slot_released_at: slotReleasedAt,
      })
      .returning();

    await expect(
      containersRepository.prepareFundedRestart(containerId, org.id, restartAt),
    ).rejects.toThrow("runtime was removed; redeploy is required");
    const [container] = await dbWrite
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(container).toMatchObject({
      status: "stopped",
      billing_status: "suspended",
      lifecycle_revision: 55,
      last_billed_at: providerCutoff,
    });
    const [organization] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(organization.creditBalance).toBe("10.000000");
    expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
    const [proof] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.id, terminalProof.id));
    expect(proof).toMatchObject({
      status: "provider_confirmed",
      slot_released_at: slotReleasedAt,
      superseded_at: null,
    });
  });

  test("funded restart refuses a legacy released-slot marker before debit", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    const slotReleasedAt = new Date("2026-08-19T02:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "legacy-slot-release-restart-fence",
      project_name: "legacy-slot-release-restart-fence",
      status: "stopped",
      billing_status: "suspended",
      last_billed_at: periodStart,
      lifecycle_revision: 9,
      metadata: { slotReleasedAt: slotReleasedAt.toISOString() },
      created_at: periodStart,
      updated_at: slotReleasedAt,
    });

    await expect(
      containersRepository.prepareFundedRestart(
        containerId,
        org.id,
        new Date("2026-08-19T03:00:00.000Z"),
      ),
    ).rejects.toThrow("runtime slot was released; redeploy is required");

    const [container] = await dbWrite
      .select()
      .from(containers)
      .where(eq(containers.id, containerId));
    expect(container).toMatchObject({
      status: "stopped",
      billing_status: "suspended",
      lifecycle_revision: 9,
      last_billed_at: periodStart,
    });
    expect(container.metadata).toEqual({ slotReleasedAt: slotReleasedAt.toISOString() });
    const [organization] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(organization.creditBalance).toBe("10.000000");
    expect(await dbWrite.select().from(containerComputeStopIntents)).toHaveLength(0);
    expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("provider cutoff remains zero-rated across the stop revision until restart", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    const providerCutoff = new Date("2026-08-19T02:00:00.000Z");
    const stoppedTriggerAt = new Date("2026-08-19T02:00:05.000Z");
    const restartAt = new Date("2026-08-19T03:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "zero-rated-restart-gap",
      project_name: "zero-rated-restart-gap",
      status: "stopped",
      billing_status: "suspended",
      last_billed_at: providerCutoff,
      lifecycle_revision: 41,
      created_at: periodStart,
      updated_at: stoppedTriggerAt,
    });
    await dbWrite.insert(computeBillingRateSegments).values([
      {
        organization_id: org.id,
        workload_kind: "container",
        workload_id: containerId,
        lifecycle_revision: 40,
        billing_state: "running",
        rate_per_hour: "0.027917",
        effective_at: periodStart,
      },
      {
        // Provider proof belongs to the stopped generation and is published at
        // T1 before the status trigger advances lifecycle_revision.
        organization_id: org.id,
        workload_kind: "container",
        workload_id: containerId,
        lifecycle_revision: 40,
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
        effective_at: providerCutoff,
      },
      {
        // Simulates the production status trigger at T2 on the new revision.
        organization_id: org.id,
        workload_kind: "container",
        workload_id: containerId,
        lifecycle_revision: 41,
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
        effective_at: stoppedTriggerAt,
      },
    ]);

    const restartDebt = await dbWrite.transaction((tx) =>
      settleComputeRateSegments(tx, {
        organizationId: org.id,
        workloadKind: "container",
        workloadId: containerId,
        periodStart: providerCutoff,
        periodEnd: restartAt,
      }),
    );
    expect(restartDebt.amount.toFixed(6)).toBe("0.000000");
    expect(restartDebt.segments).toEqual([
      {
        state: "not_billable",
        ratePerHour: "0.000000",
        startedAt: providerCutoff.toISOString(),
        endedAt: stoppedTriggerAt.toISOString(),
        amount: "0.000000",
      },
      {
        state: "not_billable",
        ratePerHour: "0.000000",
        startedAt: stoppedTriggerAt.toISOString(),
        endedAt: restartAt.toISOString(),
        amount: "0.000000",
      },
    ]);
  });

  test("funded restart atomically settles exact debt through earnings and canonical credits", async () => {
    const { org, user } = await seed("0.000000");
    await dbWrite
      .update(organizations)
      .set({ pay_as_you_go_from_earnings: true })
      .where(eq(organizations.id, org.id));
    await dbWrite.insert(redeemableEarnings).values({
      user_id: user.id,
      total_earned: "10.0000",
      available_balance: "10.0000",
    });
    const containerId = "00000000-0000-4000-8000-000000000007";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    const restartAt = new Date("2026-08-19T03:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "atomic-restart",
      project_name: "atomic-restart",
      status: "stopped",
      billing_status: "suspended",
      desired_count: 1,
      cpu: 1024,
      memory: 2048,
      last_billed_at: periodStart,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 1,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    await dbWrite.insert(containerComputeStopIntents).values({
      organization_id: org.id,
      container_id: containerId,
      lifecycle_revision: 1,
    });

    const prepared = await containersRepository.prepareFundedRestart(
      containerId,
      org.id,
      restartAt,
    );
    expect(prepared).toMatchObject({
      status: "deploying",
      billing_status: "active",
      last_billed_at: restartAt,
    });
    const [balance] = await dbWrite
      .select({ credit: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(balance.credit).toBe("0.000066");
    const [earnings] = await dbWrite
      .select({ available: redeemableEarnings.available_balance })
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, user.id));
    expect(earnings.available).toBe("9.9441");
    const ledger = await dbWrite
      .select({ amount: creditTransactions.amount })
      .from(creditTransactions)
      .where(eq(creditTransactions.organization_id, org.id));
    expect(ledger.map((entry) => entry.amount).sort()).toEqual(["-0.055834", "0.055900"]);
    const [receipt] = await dbWrite.select().from(containerBillingRecords);
    expect(receipt).toMatchObject({ amount: "0.055834", status: "success" });
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent.status).toBe("superseded");
  });

  test("restart debt settlement rolls back every transition when funding is insufficient", async () => {
    const { org, user } = await seed("0.001000");
    const containerId = "00000000-0000-4000-8000-000000000008";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "blocked-restart",
      project_name: "blocked-restart",
      status: "stopped",
      billing_status: "suspended",
      desired_count: 1,
      cpu: 1024,
      memory: 2048,
      last_billed_at: periodStart,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 2,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });

    await expect(
      containersRepository.prepareFundedRestart(
        containerId,
        org.id,
        new Date("2026-08-19T03:00:00.000Z"),
      ),
    ).rejects.toThrow("funding beyond its unsettled compute debt");
    const [row] = await dbWrite.select().from(containers).where(eq(containers.id, containerId));
    expect(row).toMatchObject({
      status: "stopped",
      billing_status: "suspended",
      last_billed_at: periodStart,
    });
    expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a stale execution generation cannot journal or call the provider", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "stale-provider-claim",
      project_name: "stale-provider-claim",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 2,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 2,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const [pendingJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const staleClaim = await ownContainerStopJob(pendingJob);
    await dbWrite.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, pendingJob.id));
    await dbWrite
      .update(jobs)
      .set({
        status: "pending",
        execution_generation: null,
        execution_quiesced_at: null,
        started_at: null,
      })
      .where(eq(jobs.id, pendingJob.id));
    const freshClaim = await ownContainerStopJob(pendingJob);
    expect(freshClaim.job.execution_generation).not.toBe(staleClaim.job.execution_generation);

    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(
        dispatchContainerStopJobService(staleClaim.job, {
          executionOwnerId: staleClaim.executionOwnerId,
        }),
      ).rejects.toThrow("lost its exact execution lease");
      expect(providerStop).not.toHaveBeenCalled();
      const [currentJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, pendingJob.id));
      expect(currentJob.data).not.toHaveProperty("providerEffectStartedAt");
    } finally {
      providerStop.mockRestore();
    }
  });

  test("a claim lost after durable admission but before provider effect makes no provider call", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "lost-effect-boundary-claim",
      project_name: "lost-effect-boundary-claim",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 4,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 4,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const [pendingJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const claimed = await ownContainerStopJob(pendingJob);

    await dbWrite.execute(
      sql.raw(`CREATE FUNCTION replace_container_stop_claim_before_effect() RETURNS trigger AS $$
      DECLARE
        successor_generation uuid := gen_random_uuid();
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'dispatching' THEN
          UPDATE jobs
          SET execution_generation = successor_generation,
              execution_quiesced_at = NULL,
              updated_at = clock_timestamp()
          WHERE id = NEW.job_id;
          UPDATE job_execution_leases
          SET execution_generation = successor_generation,
              owner_id = gen_random_uuid(),
              expires_at = clock_timestamp() + interval '5 minutes',
              heartbeat_at = clock_timestamp()
          WHERE job_id = NEW.job_id;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TRIGGER replace_container_stop_claim_before_effect
        AFTER UPDATE OF status ON container_compute_stop_intents
        FOR EACH ROW EXECUTE FUNCTION replace_container_stop_claim_before_effect()`),
    );

    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(
        dispatchContainerStopJobService(claimed.job, {
          executionOwnerId: claimed.executionOwnerId,
        }),
      ).rejects.toThrow("lost its exact execution claim");
      expect(providerStop).not.toHaveBeenCalled();

      const [currentJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, pendingJob.id));
      expect(currentJob.execution_generation).toBe(claimed.job.execution_generation);
      expect(currentJob.data).toHaveProperty("providerEffectStartedAt");
      const [intent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(intent).toMatchObject({ status: "pending", attempts: 0, provider_started_at: null });
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS replace_container_stop_claim_before_effect ON container_compute_stop_intents",
        ),
      );
      await dbWrite.execute(
        sql.raw("DROP FUNCTION IF EXISTS replace_container_stop_claim_before_effect()"),
      );
    }
  });

  test("a future provider admission marker fails closed before provider I/O", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "future-provider-admission",
      project_name: "future-provider-admission",
      status: "running",
      billing_status: "active",
      lifecycle_revision: 3,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 3,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const futureMarker = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [poisonedJob] = await dbWrite
      .update(jobs)
      .set({
        data: sql`jsonb_set(
          ${jobs.data},
          '{providerEffectStartedAt}',
          to_jsonb(${futureMarker}::text)
        )`,
      })
      .where(eq(jobs.id, requested.jobId))
      .returning();
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    try {
      await expect(dispatchContainerStopJob(poisonedJob)).rejects.toThrow(
        "out-of-bounds data.providerEffectStartedAt",
      );
      expect(providerStop).not.toHaveBeenCalled();
      const [intent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(intent).toMatchObject({ status: "pending", attempts: 0 });
    } finally {
      providerStop.mockRestore();
    }
  });

  test("daemon rejects tenant envelopes and supersedes a stale lifecycle generation before provider I/O", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000003";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'stale-fixture', 'stale-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 7, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 7,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    await expect(
      dispatchContainerStopJob({ ...job, organization_id: crypto.randomUUID() }),
    ).rejects.toThrow("tenant envelope mismatch");
    await dbWrite.execute(
      sql`UPDATE containers SET lifecycle_revision = 8, status = 'deploying' WHERE id = ${containerId}`,
    );
    const stale = await dispatchContainerStopJob(job);
    expect(stale.reason).toBe("stale-lifecycle-generation");
    expect(providerStop).not.toHaveBeenCalled();
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent?.status).toBe("superseded");
    providerStop.mockRestore();
  });

  test("provider failures persist terminal attention and remain independently recoverable", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000004";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'terminal-fixture', 'terminal-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 9, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 9,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockRejectedValue(new Error("provider unavailable"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow("provider unavailable");
    }
    // The provisioning worker owns the terminal job transition. Recovery
    // discovery deliberately excludes live pending/in-progress jobs so they
    // cannot monopolize its bounded scan.
    await dbWrite.update(jobs).set({ status: "failed" }).where(eq(jobs.id, requested.id));
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ next_attempt_at: new Date(0) })
      .where(eq(containerComputeStopIntents.container_id, containerId));
    const [terminal] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.container_id, containerId));
    expect(terminal).toMatchObject({ status: "terminal_attention", attempts: 3 });
    const recovery = await listRecoverableContainerStopIntents(new Date());
    expect(recovery.map((intent) => intent.id)).toContain(terminal?.id);
    const row = await dbWrite.execute(
      sql`SELECT status, billing_status FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({ status: "running", billing_status: "shutdown_pending" });
    providerStop.mockRestore();
  });

  test("an outer proof rollback reuses the durable provider admission cutoff after restart", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "provider-admission-restart",
      project_name: "provider-admission-restart",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 19,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 19,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 19,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(getHetznerContainersClient(), "stopContainerRuntimeForBilling")
      .mockResolvedValueOnce({ nodeId: null, alreadyAbsent: false })
      .mockResolvedValueOnce({ nodeId: null, alreadyAbsent: true });
    await dbWrite.execute(
      sql.raw(`CREATE FUNCTION fail_container_stop_provider_proof() RETURNS trigger AS $$
      BEGIN
        IF OLD.provider_confirmed_at IS NULL AND NEW.provider_confirmed_at IS NOT NULL THEN
          RAISE EXCEPTION 'simulated provider proof commit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TRIGGER fail_container_stop_provider_proof
        BEFORE UPDATE ON container_compute_stop_intents FOR EACH ROW
        EXECUTE FUNCTION fail_container_stop_provider_proof()`),
    );
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow();
      expect(providerStop).toHaveBeenCalledTimes(1);

      const [admittedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
      const providerEffectStartedAtRaw = admittedJob.data.providerEffectStartedAt;
      expect(typeof providerEffectStartedAtRaw).toBe("string");
      const providerEffectStartedAt = new Date(String(providerEffectStartedAtRaw));
      expect(providerEffectStartedAt.getTime()).toBeFinite();
      const [rolledBackIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(rolledBackIntent).toMatchObject({
        status: "pending",
        attempts: 0,
        provider_started_at: null,
        provider_confirmed_at: null,
      });
      const [rolledBackContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(rolledBackContainer).toMatchObject({
        status: "running",
        billing_status: "active",
        last_billed_at: periodStart,
      });
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);

      await dbWrite.execute(
        sql.raw(`DROP TRIGGER fail_container_stop_provider_proof
          ON container_compute_stop_intents`),
      );
      await dbWrite.update(jobs).set({ status: "failed" }).where(eq(jobs.id, requested.jobId));
      const replay = await enqueueContainerUserStopOnce({
        containerId,
        organizationId: org.id,
        userId: user.id,
        expectedLifecycleRevision: 19,
      });
      if (!replay.requested) throw new Error("Expected provider stop replay");
      expect(replay).toMatchObject({
        jobId: requested.jobId,
        created: true,
        replayed: true,
      });
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, replay.jobId));
      expect(rearmedJob.data.providerEffectStartedAt).toBe(providerEffectStartedAtRaw);

      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(2);
      const [confirmedIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(confirmedIntent.provider_started_at).toEqual(providerEffectStartedAt);
      expect(confirmedIntent.provider_confirmed_at).toEqual(providerEffectStartedAt);
      const [receipt] = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipt.billing_period_end).toEqual(providerEffectStartedAt);
      expect(Number(receipt.amount)).toBeCloseTo(
        ((providerEffectStartedAt.getTime() - periodStart.getTime()) / (60 * 60 * 1000)) * 0.027917,
        6,
      );
      const exactCutoffSegments = await dbWrite
        .select()
        .from(computeBillingRateSegments)
        .where(
          and(
            eq(computeBillingRateSegments.organization_id, org.id),
            eq(computeBillingRateSegments.workload_id, containerId),
            eq(computeBillingRateSegments.lifecycle_revision, 19),
            eq(computeBillingRateSegments.effective_at, providerEffectStartedAt),
          ),
        );
      expect(exactCutoffSegments).toHaveLength(1);
      expect(exactCutoffSegments[0]).toMatchObject({
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
      });
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(`DROP TRIGGER IF EXISTS fail_container_stop_provider_proof
          ON container_compute_stop_intents`),
      );
      await dbWrite.execute(
        sql.raw(`DROP FUNCTION IF EXISTS fail_container_stop_provider_proof()`),
      );
    }
  });

  test("an unreconciled billing provider admission fences restored funding until exact job replay", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const scheduledShutdownAt = new Date(Date.now() - 60_000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "provider-admission-billing-fence",
      project_name: "provider-admission-billing-fence",
      status: "running",
      billing_status: "shutdown_pending",
      scheduled_shutdown_at: scheduledShutdownAt,
      last_billed_at: periodStart,
      lifecycle_revision: 20,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 20,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({
      containerId,
      organizationId: org.id,
    });
    if (!requested.requested) throw new Error("Expected durable billing stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(getHetznerContainersClient(), "stopContainerRuntimeForBilling")
      .mockResolvedValueOnce({ nodeId: null, alreadyAbsent: false })
      .mockResolvedValueOnce({ nodeId: null, alreadyAbsent: true });
    await dbWrite.execute(
      sql.raw(`CREATE FUNCTION fail_billing_stop_provider_proof() RETURNS trigger AS $$
      BEGIN
        IF OLD.provider_confirmed_at IS NULL AND NEW.provider_confirmed_at IS NOT NULL THEN
          RAISE EXCEPTION 'simulated billing provider proof commit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TRIGGER fail_billing_stop_provider_proof
        BEFORE UPDATE ON container_compute_stop_intents FOR EACH ROW
        EXECUTE FUNCTION fail_billing_stop_provider_proof()`),
    );
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow();
      expect(providerStop).toHaveBeenCalledTimes(1);

      const [admittedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
      const providerEffectStartedAtRaw = admittedJob.data.providerEffectStartedAt;
      expect(typeof providerEffectStartedAtRaw).toBe("string");
      const providerEffectStartedAt = new Date(String(providerEffectStartedAtRaw));
      expect(providerEffectStartedAt.getTime()).toBeFinite();
      const [rolledBackIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(rolledBackIntent).toMatchObject({
        status: "pending",
        attempts: 0,
        provider_started_at: null,
        provider_confirmed_at: null,
      });

      // A top-up and stale row-only billing publication must not reinterpret
      // this possibly-absent runtime as live compute.
      await dbWrite
        .update(organizations)
        .set({ credit_balance: "10.000000" })
        .where(eq(organizations.id, org.id));
      await dbWrite
        .update(containers)
        .set({
          billing_status: "active",
          scheduled_shutdown_at: null,
          next_billing_at: null,
        })
        .where(eq(containers.id, containerId));
      const later = new Date(providerEffectStartedAt.getTime() + 60 * 60 * 1000);
      const billable = await containerBillingRepository.listBillableContainers(later);
      expect(billable.map((container) => container.id)).not.toContain(containerId);
      await expect(
        containerBillingRepository.scheduleShutdownWarning(
          containerId,
          org.id,
          later,
          new Date(later.getTime() + 48 * 60 * 60 * 1000),
        ),
      ).resolves.toBe(false);
      const staleWriter = await containerBillingRepository.recordSuccessfulDailyBilling({
        containerId,
        organizationId: org.id,
        userId: user.id,
        containerName: "provider-admission-billing-fence",
        dailyRate: 0.67,
        earningsSourceUserId: null,
        payAsYouGoFromEarnings: false,
        newBalance: 10,
        now: later,
      });
      expect(staleWriter).toMatchObject({ alreadyBilled: true, amount: 0 });
      await expect(
        // PostgreSQL UUID equality accepts this alias, while the durable JSON
        // envelope is canonical lowercase. The marker fence must be semantic,
        // not bypassable through textual UUID casing.
        containersRepository.prepareFundedRestart(containerId.toUpperCase(), org.id, later),
      ).rejects.toThrow(
        "Container restart is blocked until admitted provider stop reconciliation completes",
      );
      const [fundingAfterFences] = await dbWrite
        .select({ creditBalance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(fundingAfterFences.creditBalance).toBe("10.000000");
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);

      await dbWrite.execute(
        sql.raw(`DROP TRIGGER fail_billing_stop_provider_proof
          ON container_compute_stop_intents`),
      );
      await dbWrite.update(jobs).set({ status: "failed" }).where(eq(jobs.id, requested.id));
      await dbWrite
        .update(containers)
        .set({
          billing_status: "shutdown_pending",
          scheduled_shutdown_at: scheduledShutdownAt,
          next_billing_at: null,
        })
        .where(eq(containers.id, containerId));

      const replay = await enqueueContainerStopOnce({
        containerId,
        organizationId: org.id,
      });
      if (!replay.requested) throw new Error("Expected provider-admitted billing stop replay");
      expect(replay).toMatchObject({ id: requested.id, created: true });
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, replay.id));
      expect(rearmedJob.data.providerEffectStartedAt).toBe(providerEffectStartedAtRaw);

      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(2);
      const [confirmedIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(confirmedIntent).toMatchObject({ status: "provider_confirmed" });
      expect(confirmedIntent.provider_started_at).toEqual(providerEffectStartedAt);
      expect(confirmedIntent.provider_confirmed_at).toEqual(providerEffectStartedAt);
      const [receipt] = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipt.billing_period_end).toEqual(providerEffectStartedAt);
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(`DROP TRIGGER IF EXISTS fail_billing_stop_provider_proof
          ON container_compute_stop_intents`),
      );
      await dbWrite.execute(sql.raw(`DROP FUNCTION IF EXISTS fail_billing_stop_provider_proof()`));
    }
  });

  test("a safely superseded provider admission marker does not fence the live lifecycle", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const marker = new Date().toISOString();
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "superseded-provider-admission",
      project_name: "superseded-provider-admission",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 21,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 21,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    await dbWrite.insert(jobs).values({
      id: jobId,
      type: "container_stop",
      status: "failed",
      organization_id: org.id,
      user_id: user.id,
      data: {
        containerId,
        organizationId: org.id,
        intentId,
        lifecycleRevision: 21,
        providerEffectStartedAt: marker,
      },
    });
    await dbWrite.insert(containerComputeStopIntents).values({
      id: intentId,
      organization_id: org.id,
      container_id: containerId,
      lifecycle_revision: 21,
      authorization: "billing_request",
      status: "superseded",
      job_id: jobId,
      superseded_at: new Date(),
    });

    const now = new Date(Date.now() + 60 * 60 * 1000);
    const billable = await containerBillingRepository.listBillableContainers(now);
    expect(billable.map((container) => container.id)).toContain(containerId);
    await expect(
      containerBillingRepository.scheduleShutdownWarning(
        containerId,
        org.id,
        now,
        new Date(now.getTime() + 48 * 60 * 60 * 1000),
      ),
    ).resolves.toBe(true);
  });

  test("provider success followed by control-plane rollback replays absence proof idempotently", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = "00000000-0000-4000-8000-000000000006";
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status,
       scheduled_shutdown_at, last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'crash-replay', 'crash-replay', ${org.id}, ${user.id},
        'running', 'shutdown_pending', ${new Date(Date.now() - 60_000)}, ${periodStart},
        10, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 10,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 10,
    });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });
    providerStop.mockClear();
    await dbWrite.execute(
      sql.raw(`
      CREATE FUNCTION fail_compute_stop_confirmation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated receipt failure after provider success';
      END $$ LANGUAGE plpgsql
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER fail_compute_stop_confirmation
        BEFORE INSERT ON container_billing_records FOR EACH ROW
        EXECUTE FUNCTION fail_compute_stop_confirmation()
    `),
    );
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow();
      const [recoverable] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(recoverable).toMatchObject({ status: "retry", attempts: 1 });
      expect(recoverable.provider_confirmed_at).toBeInstanceOf(Date);
      const providerCutoff = recoverable.provider_confirmed_at;
      if (!providerCutoff) throw new Error("Expected durable provider cutoff");
      const [rolledBackContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(rolledBackContainer).toMatchObject({
        status: "running",
        billing_status: "suspended",
        last_billed_at: periodStart,
      });
      const billableAfterProof = await containerBillingRepository.listBillableContainers(
        new Date(providerCutoff.getTime() + 24 * 60 * 60 * 1000),
      );
      expect(billableAfterProof.map((row) => row.id)).not.toContain(containerId);
      const cutoffSegments = await dbWrite
        .select()
        .from(computeBillingRateSegments)
        .where(
          and(
            eq(computeBillingRateSegments.organization_id, org.id),
            eq(computeBillingRateSegments.workload_kind, "container"),
            eq(computeBillingRateSegments.workload_id, containerId),
            eq(computeBillingRateSegments.lifecycle_revision, 10),
            eq(computeBillingRateSegments.effective_at, providerCutoff),
          ),
        );
      expect(cutoffSegments).toHaveLength(1);
      expect(cutoffSegments[0]).toMatchObject({
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
      });
      const [rolledBackOrganization] = await dbWrite
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(Number(rolledBackOrganization.credit_balance)).toBe(10);
      expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
      await dbWrite.execute(
        sql.raw(`DROP TRIGGER fail_compute_stop_confirmation ON container_billing_records`),
      );

      await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [confirmed] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(confirmed).toMatchObject({ status: "provider_confirmed", attempts: 2 });
      expect(confirmed.provider_confirmed_at).toEqual(providerCutoff);
      const [settledContainer] = await dbWrite
        .select()
        .from(containers)
        .where(eq(containers.id, containerId));
      expect(settledContainer.last_billed_at).toEqual(providerCutoff);
      const receipts = await dbWrite
        .select()
        .from(containerBillingRecords)
        .where(eq(containerBillingRecords.container_id, containerId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ status: "success" });
      expect(receipts[0]?.billing_period_end).toEqual(providerCutoff);
      expect(Number(receipts[0]?.amount)).toBeCloseTo(
        ((providerCutoff.getTime() - periodStart.getTime()) / (60 * 60 * 1000)) * 0.027917,
        6,
      );
      const replayedCutoffSegments = await dbWrite
        .select()
        .from(computeBillingRateSegments)
        .where(
          and(
            eq(computeBillingRateSegments.organization_id, org.id),
            eq(computeBillingRateSegments.workload_id, containerId),
            eq(computeBillingRateSegments.lifecycle_revision, 10),
            eq(computeBillingRateSegments.effective_at, providerCutoff),
          ),
        );
      expect(replayedCutoffSegments).toHaveLength(1);
      expect(await dbWrite.select().from(creditTransactions)).toHaveLength(1);
      const [settledOrganization] = await dbWrite
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, org.id));
      expect(Number(settledOrganization.credit_balance)).toBeCloseTo(
        10 - Number(receipts[0]?.amount),
        6,
      );
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS fail_compute_stop_confirmation ON container_billing_records`,
        ),
      );
      await dbWrite.execute(sql.raw(`DROP FUNCTION IF EXISTS fail_compute_stop_confirmation()`));
    }
  });

  test("recovery releases a provider-confirmed node slot exactly once after job exhaustion", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = crypto.randomUUID();
    const nodeId = crypto.randomUUID();
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "provider-confirmed-slot-recovery",
      project_name: "provider-confirmed-slot-recovery",
      status: "running",
      billing_status: "active",
      last_billed_at: periodStart,
      lifecycle_revision: 62,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 62,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerUserStopOnce({
      containerId,
      organizationId: org.id,
      userId: user.id,
      expectedLifecycleRevision: 62,
    });
    if (!requested.requested) throw new Error("Expected durable user stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.jobId));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId, alreadyAbsent: false });
    const releaseNodeSlot = spyOn(containersRepository, "tryReleaseNodeSlot")
      .mockRejectedValueOnce(new Error("slot release unavailable 1"))
      .mockRejectedValueOnce(new Error("slot release unavailable 2"))
      .mockRejectedValueOnce(new Error("slot release unavailable 3"))
      .mockResolvedValue(true);

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await expect(dispatchContainerStopJob(job)).rejects.toThrow(
          `slot release unavailable ${attempt}`,
        );
      }
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [confirmedBeforeRecovery] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(confirmedBeforeRecovery).toMatchObject({
        status: "provider_confirmed",
        provider_node_id: nodeId,
        slot_released_at: null,
      });
      expect(confirmedBeforeRecovery.provider_confirmed_at).toBeInstanceOf(Date);
      const providerCutoff = confirmedBeforeRecovery.provider_confirmed_at;

      await dbWrite
        .update(jobs)
        .set({ status: "failed", attempts: 3, completed_at: new Date() })
        .where(eq(jobs.id, requested.jobId));
      const recoveryAt = new Date();
      const recoverable = await listRecoverableContainerStopIntents(recoveryAt);
      expect(recoverable.map((intent) => intent.id)).toContain(requested.intentId);

      const rearmed = await rearmRecoverableContainerStopIntentOnce({
        intentId: requested.intentId,
        containerId,
        organizationId: org.id,
        lifecycleRevision: 62,
        now: recoveryAt,
      });
      expect(rearmed).toEqual({ id: requested.jobId, rearmed: true });
      const [preservedIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(preservedIntent).toMatchObject({
        status: "provider_confirmed",
        provider_node_id: nodeId,
        slot_released_at: null,
      });
      expect(preservedIntent.provider_confirmed_at).toEqual(providerCutoff);
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, rearmed.id));
      expect(rearmedJob).toMatchObject({ status: "pending", attempts: 0 });

      providerStop.mockClear();
      releaseNodeSlot.mockClear();
      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({
        stopped: true,
        reason: "already-provider-confirmed",
      });
      expect(providerStop).not.toHaveBeenCalled();
      expect(releaseNodeSlot).toHaveBeenCalledTimes(1);
      expect(releaseNodeSlot).toHaveBeenCalledWith(containerId, org.id, nodeId);
      const [releasedIntent] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.id, requested.intentId));
      expect(releasedIntent.status).toBe("provider_confirmed");
      expect(releasedIntent.provider_confirmed_at).toEqual(providerCutoff);
      expect(releasedIntent.slot_released_at).toBeInstanceOf(Date);

      await expect(dispatchContainerStopJob(rearmedJob)).resolves.toEqual({
        stopped: true,
        reason: "already-provider-confirmed",
      });
      expect(providerStop).not.toHaveBeenCalled();
      expect(releaseNodeSlot).toHaveBeenCalledTimes(1);

      await dbWrite
        .update(jobs)
        .set({ status: "failed", attempts: 3, completed_at: new Date() })
        .where(eq(jobs.id, requested.jobId));
      const afterRelease = await listRecoverableContainerStopIntents(
        new Date(recoveryAt.getTime() + 1_000),
      );
      expect(afterRelease.map((intent) => intent.id)).not.toContain(requested.intentId);
    } finally {
      releaseNodeSlot.mockRestore();
      providerStop.mockRestore();
    }
  });

  test("provider confirmation is the only transition to stopped and suspended", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000005";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'confirmed-fixture', 'confirmed-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 11, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 11,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null, alreadyAbsent: false });

    await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
    expect(providerStop).toHaveBeenCalledWith(containerId, org.id, 11);
    const row = await dbWrite.execute(
      sql`SELECT status, billing_status FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({ status: "stopped", billing_status: "suspended" });
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent).toMatchObject({ status: "provider_confirmed", attempts: 1 });
    expect(intent?.provider_confirmed_at).toBeInstanceOf(Date);
    providerStop.mockRestore();
  });
});

test("PGlite setup is mandatory", () => expect(ready).toBe(true));
