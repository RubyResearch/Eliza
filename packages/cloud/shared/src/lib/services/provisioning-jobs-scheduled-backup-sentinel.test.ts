/**
 * Drives `enqueueScheduledBackups` end-to-end against the REAL enqueue pipeline
 * on in-process PGlite: the selection SQL, the per-row `enqueueAgentSnapshotOnce`
 * → `enqueueLifecycleJob` transaction (advisory lock, sandbox read, in-flight
 * idempotency lookup, `jobs` insert) all execute for real and the assertions
 * read back the actual `jobs` rows written. Snapshot enqueue failure coverage
 * injects a downstream failure so the scanner's per-row catch is exercised.
 * Billing-stop tests retain real intent/job transactions while simulating the
 * backup prerequisite at SandboxPower and the external provider stop.
 *
 * The load-bearing behavior is the reachability carve-out (issue #15737): a
 * `running` row whose bridge_url is the unreachable loopback sentinel
 * (`http://127.0.0.1:65535`) must never be re-enqueued, alongside the other
 * exclusions the scan already enforces (non-running, warm-pool, null-bridge,
 * recently-backed-up) and the maxAgents cap.
 *
 * The harness applies the shared provisioning-job DDL directly to the PGlite
 * connection the service queries through. This keeps the proof isolated from
 * drizzle-kit's process-level failure behavior and fails loudly when the
 * ambient DATABASE_URL is a shared non-PGlite Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { agentBillingRecords } from "../../db/schemas/compute-billing";
import { computeBillingRateSegments } from "../../db/schemas/compute-billing-rate-segments";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import { elizaSandboxService } from "./eliza-sandbox";
import { SandboxPower } from "./eliza-sandbox/lifecycle/power";
import { JOB_TYPES } from "./provisioning-job-types";
import {
  listRecoverableAgentComputeStopIntents,
  provisioningJobService,
  rearmRecoverableAgentComputeStopIntentOnce,
  resolveAgentSuspendAuthorization,
} from "./provisioning-jobs";

const PGLITE_TIMEOUT = 300_000;
let pgliteReady = true;

const SENTINEL_BRIDGE = "http://127.0.0.1:65535";
const REACHABLE_BRIDGE = "http://10.0.0.5:8080";
const OTHER_REACHABLE_BRIDGE = "http://10.0.0.6:8080";

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Sentinel Backup Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

interface SeedOpts {
  status?: string;
  bridgeUrl?: string | null;
  poolStatus?: string | null;
  lastBackupAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  lastBackupAttemptAt?: Date | null;
  backupUnsupportedReason?: string | null;
  environmentVars?: Record<string, string>;
}

async function seedSandbox(opts: SeedOpts = {}): Promise<string> {
  const { orgId, userId } = await seedOwner();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: orgId,
      user_id: userId,
      agent_name: uniq("agent"),
      // Default to a due, reachable, user-owned running row so each test only
      // has to flip the one field it is exercising out of eligibility.
      status: (opts.status ?? "running") as never,
      execution_tier: "dedicated-lazy",
      bridge_url: opts.bridgeUrl === undefined ? REACHABLE_BRIDGE : opts.bridgeUrl,
      pool_status: (opts.poolStatus ?? null) as never,
      last_backup_at: opts.lastBackupAt ?? null,
      last_heartbeat_at: opts.lastHeartbeatAt ?? null,
      last_backup_attempt_at: opts.lastBackupAttemptAt ?? null,
      backup_unsupported_reason: opts.backupUnsupportedReason ?? null,
      environment_vars: opts.environmentVars ?? {},
    })
    .returning();
  return sandbox.id;
}

async function snapshotJobsFor(agentId: string): Promise<Array<Record<string, unknown>>> {
  return (await dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, "agent_snapshot")))) as Array<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[provisioning-jobs-scheduled-backup-sentinel.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails because its fixture DDL would mutate the shared schema.",
    );
    return;
  }
  try {
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(sql.raw(ddl));
    }
    const { getPgliteClientForTests } = await import("../../db/client");
    await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
    for (const name of [
      "0388_agent_compute_funded_receipts.sql",
      "0394_agent_billing_activation_minimum.sql",
    ]) {
      const migration = await readFile(
        new URL(`../../db/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await getPgliteClientForTests().exec(migration);
    }
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[provisioning-jobs-scheduled-backup-sentinel.test] PGlite/DDL unavailable — cannot drive the scheduled-backup scan against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentComputeStopIntents);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("enqueueScheduledBackups — sentinel-bridge exclusion (#15737)", () => {
  test("a running sentinel-bridge row is skipped while a normal running row enqueues a real snapshot job", async () => {
    const reachableId = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const sentinelId = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups();

    // Both rows are `running` with a non-null bridge_url; only the reachable one
    // survives the scan predicate and gets a real `agent_snapshot` job row.
    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });

    const reachableJobs = await snapshotJobsFor(reachableId);
    expect(reachableJobs).toHaveLength(1);
    expect(reachableJobs[0]?.status).toBe("pending");
    expect((reachableJobs[0]?.data as { snapshotType?: string })?.snapshotType).toBe("auto");

    expect(await snapshotJobsFor(sentinelId)).toHaveLength(0);
  });

  test("a fleet of only sentinel-bridge rows enqueues nothing", async () => {
    const a = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });
    const b = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });
    const c = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toMatchObject({ scanned: 0, enqueued: 0 });
    for (const id of [a, b, c]) {
      expect(await snapshotJobsFor(id)).toHaveLength(0);
    }
  });
});

describe("enqueueScheduledBackups — eligibility predicate", () => {
  test("non-running rows are excluded even with a reachable bridge", async () => {
    const running = await seedSandbox({ status: "running" });
    const sleeping = await seedSandbox({ status: "sleeping" });
    const pending = await seedSandbox({ status: "pending" });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(running)).toHaveLength(1);
    expect(await snapshotJobsFor(sleeping)).toHaveLength(0);
    expect(await snapshotJobsFor(pending)).toHaveLength(0);
  });

  test("warm-pool rows (pool_status set) are excluded — no user state to back up", async () => {
    const owned = await seedSandbox({ poolStatus: null });
    const warm = await seedSandbox({ poolStatus: "ready" });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(owned)).toHaveLength(1);
    expect(await snapshotJobsFor(warm)).toHaveLength(0);
  });

  test("rows with no bridge_url are excluded — nothing live to snapshot", async () => {
    const bridged = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const bridgeless = await seedSandbox({ bridgeUrl: null });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(bridged)).toHaveLength(1);
    expect(await snapshotJobsFor(bridgeless)).toHaveLength(0);
  });

  test("only rows past the backup cutoff are due: never-backed-up and stale qualify, fresh does not", async () => {
    const minIntervalMs = 6 * 60 * 60 * 1000; // 6h, the production default
    const stale = new Date(Date.now() - minIntervalMs - 60_000);
    const fresh = new Date(Date.now() - 60_000);

    const neverBackedUp = await seedSandbox({ lastBackupAt: null });
    const staleBackup = await seedSandbox({ lastBackupAt: stale });
    const freshBackup = await seedSandbox({ lastBackupAt: fresh });

    const res = await provisioningJobService.enqueueScheduledBackups({ minIntervalMs });

    expect(res).toMatchObject({ scanned: 2, enqueued: 2 });
    expect(await snapshotJobsFor(neverBackedUp)).toHaveLength(1);
    expect(await snapshotJobsFor(staleBackup)).toHaveLength(1);
    expect(await snapshotJobsFor(freshBackup)).toHaveLength(0);
  });

  test("maxAgents caps how many due rows are scanned in a single tick", async () => {
    await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    await seedSandbox({ bridgeUrl: OTHER_REACHABLE_BRIDGE });
    await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 2 });

    // The LIMIT is applied in SQL, so `scanned` reflects the cap, not the fleet.
    expect(res.scanned).toBe(2);
    expect(res.enqueued).toBe(2);
    const total = await dbWrite.select().from(jobs).where(eq(jobs.type, "agent_snapshot"));
    expect(total).toHaveLength(2);
  });
});

describe("enqueueScheduledBackups — enqueue behavior", () => {
  test("a second tick reuses the still-pending snapshot job rather than duplicating it", async () => {
    const agentId = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });

    const first = await provisioningJobService.enqueueScheduledBackups();
    expect(first).toMatchObject({ scanned: 1, enqueued: 1 });

    // The row is still due (last_backup_at unchanged) and the snapshot job is
    // still pending, so in-flight idempotency must reuse it — one job row total.
    const second = await provisioningJobService.enqueueScheduledBackups();
    expect(second).toMatchObject({ scanned: 1, enqueued: 1 });

    expect(await snapshotJobsFor(agentId)).toHaveLength(1);
  });

  test("a per-row enqueue failure is caught: scanned counts the row, enqueued does not, the scan finishes", async () => {
    const failing = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const succeeding = await seedSandbox({ bridgeUrl: OTHER_REACHABLE_BRIDGE });

    // Force the downstream enqueue to throw for the first agent only; the scan's
    // per-row try/catch must swallow it, keep `enqueued` accurate, and still
    // process the remaining due row.
    const spy = spyOn(provisioningJobService, "enqueueAgentSnapshotOnce").mockImplementation(
      (async (params: { agentId: string }) => {
        if (params.agentId === failing) {
          throw new Error("snapshot enqueue boom");
        }
        return { created: true, job: { id: "ok" } } as never;
      }) as never,
    );
    try {
      const res = await provisioningJobService.enqueueScheduledBackups();
      expect(res.scanned).toBe(2);
      expect(res.enqueued).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
      const succeedingCall = spy.mock.calls.find(
        (c) => (c[0] as { agentId?: string })?.agentId === succeeding,
      );
      expect(succeedingCall).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Enqueue side of the same service, driven against the real PGlite so the
 * shared `enqueueLifecycleJob` transaction (advisory lock, sandbox read,
 * in-flight idempotency, row insert) and every per-type wrapper's job-data
 * shaping actually run. The scheduled-backup scan above only exercises the
 * snapshot enqueue; these cover the lifecycle enqueue surface the route layer
 * calls into, so a regression in the job-data record shape or the reuse
 * predicate is a red test rather than a silent bad row on the queue.
 */
describe("enqueueAgent*Once — real lifecycle-job inserts", () => {
  async function seedAgent(
    opts: {
      status?: string;
      lastHeartbeatAt?: Date | null;
      executionTier?: string;
      poolStatus?: string | null;
      deletedAt?: Date | null;
    } = {},
  ): Promise<{
    agentId: string;
    orgId: string;
    userId: string;
    lifecycleRevision: number;
  }> {
    const { orgId, userId } = await seedOwner();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: uniq("agent"),
        status: (opts.status ?? "running") as never,
        execution_tier: (opts.executionTier ?? "dedicated-lazy") as never,
        pool_status: (opts.poolStatus ?? null) as never,
        deleted_at: opts.deletedAt ?? null,
        bridge_url: REACHABLE_BRIDGE,
        last_heartbeat_at: opts.lastHeartbeatAt ?? null,
      })
      .returning();
    return {
      agentId: sandbox.id,
      orgId,
      userId,
      lifecycleRevision: sandbox.lifecycle_revision,
    };
  }

  async function jobsOfType(
    agentId: string,
    type: string,
  ): Promise<Array<Record<string, unknown>>> {
    return (await dbWrite
      .select()
      .from(jobs)
      .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, type as never)))) as Array<
      Record<string, unknown>
    >;
  }

  test("billing suspend binds a durable intent and terminal recovery reuses its authority", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "shutdown_pending", scheduled_shutdown_at: new Date(0) })
      .where(eq(agentSandboxes.id, agentId));
    const first = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    const [intent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intent).toMatchObject({
      organization_id: orgId,
      lifecycle_revision: lifecycleRevision,
      status: "pending",
      job_id: first.job.id,
    });

    await dbWrite.update(jobs).set({ status: "failed" }).where(eq(jobs.id, first.job.id));
    await dbWrite
      .update(agentComputeStopIntents)
      .set({ status: "terminal_attention", attempts: 3, next_attempt_at: new Date(0) })
      .where(eq(agentComputeStopIntents.id, intent.id));
    const recoveryAt = new Date();
    const recovery = await listRecoverableAgentComputeStopIntents(recoveryAt);
    expect(recovery.map((row) => row.id)).toContain(intent.id);

    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "active", scheduled_shutdown_at: null })
      .where(eq(agentSandboxes.id, agentId));
    expect(
      (await listRecoverableAgentComputeStopIntents(recoveryAt)).map((row) => row.id),
    ).not.toContain(intent.id);
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "shutdown_pending", scheduled_shutdown_at: new Date(0) })
      .where(eq(agentSandboxes.id, agentId));

    const rearmed = await rearmRecoverableAgentComputeStopIntentOnce({
      intentId: intent.id,
      agentId,
      organizationId: orgId,
      lifecycleRevision,
      now: recoveryAt,
    });
    expect(rearmed).toEqual({ id: first.job.id, rearmed: true });
    const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.job.id));
    expect(rearmedJob).toMatchObject({ status: "pending", attempts: 0 });
    const [rebound] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.id, intent.id));
    expect(rebound).toMatchObject({ status: "pending", job_id: first.job.id, attempts: 0 });
  });

  test("billing suspend retains terminal provider failure until provider-confirmed replay", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const periodStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: `sandbox-${agentId}`,
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: new Date(0),
        last_billed_at: periodStart,
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    type BillingSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as BillingSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue({
      error: new Error("provider unavailable"),
    });
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(
          agentId,
          orgId,
          "00000000-0000-0000-0000-000000000099",
          "billing_request",
        ),
      ).resolves.toMatchObject({
        success: false,
        containerStopped: false,
        error: "Agent billing stop intent is missing or bound to a different job",
      });
      expect(providerStop).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          service.executeSuspend(agentId, orgId, enqueued.job.id, "billing_request"),
        ).resolves.toMatchObject({
          success: false,
          containerStopped: false,
          error: "provider unavailable",
        });
      }
      await dbWrite
        .update(agentComputeStopIntents)
        .set({ next_attempt_at: new Date(0) })
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      await dbWrite
        .update(jobs)
        .set({ status: "failed", attempts: 3, completed_at: new Date() })
        .where(eq(jobs.id, enqueued.job.id));
      const [terminal] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(terminal).toMatchObject({ status: "terminal_attention", attempts: 3 });
      const recovery = await listRecoverableAgentComputeStopIntents(new Date());
      expect(recovery.map((row) => row.id)).toContain(terminal.id);
      const [stillLive] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(stillLive).toMatchObject({ status: "running", billing_status: "shutdown_pending" });

      const rearmed = await rearmRecoverableAgentComputeStopIntentOnce({
        intentId: terminal.id,
        agentId,
        organizationId: orgId,
        lifecycleRevision: terminal.lifecycle_revision,
        now: new Date(),
      });
      expect(rearmed).toEqual({ id: enqueued.job.id, rearmed: true });
      const [rearmedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, rearmed.id));
      expect(rearmedJob).toMatchObject({ status: "pending", attempts: 0 });
      providerStop.mockResolvedValue(null);
      await expect(
        service.executeSuspend(agentId, orgId, rearmed.id, "billing_request"),
      ).resolves.toMatchObject({ success: true, containerStopped: true });
      const [confirmed] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.id, terminal.id));
      expect(confirmed.status).toBe("provider_confirmed");
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("poisoned failed envelopes cannot starve a later valid recovery page", async () => {
    const { orgId, userId } = await seedOwner();
    const poisonUserId = crypto.randomUUID();
    const fixtures = Array.from({ length: 101 }, (_, index) => ({
      agentId: crypto.randomUUID(),
      intentId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      poison: index < 100,
    }));
    await dbWrite.insert(agentSandboxes).values(
      fixtures.map(({ agentId }) => ({
        id: agentId,
        organization_id: orgId,
        user_id: userId,
        agent_name: uniq("recovery-agent"),
        status: "running" as const,
        execution_tier: "dedicated-always" as const,
        billing_status: "shutdown_pending" as const,
        scheduled_shutdown_at: new Date(0),
        bridge_url: REACHABLE_BRIDGE,
      })),
    );
    await dbWrite.insert(jobs).values(
      fixtures.map(({ agentId, jobId, poison }) => ({
        id: jobId,
        type: JOB_TYPES.AGENT_SUSPEND,
        status: "failed" as const,
        data: {
          agentId,
          organizationId: orgId,
          userId: poison ? poisonUserId : userId,
          authorization: "billing_request",
          lifecycleRevision: 0,
        },
        data_storage: "inline" as const,
        organization_id: orgId,
        user_id: userId,
        attempts: 3,
        max_attempts: 3,
        completed_at: new Date(),
      })),
    );
    await dbWrite.insert(agentComputeStopIntents).values(
      fixtures.map(({ agentId, intentId, jobId, poison }) => ({
        id: intentId,
        organization_id: orgId,
        agent_id: agentId,
        lifecycle_revision: 0,
        authorization: "billing_request" as const,
        status: "terminal_attention" as const,
        job_id: jobId,
        attempts: 3,
        next_attempt_at: new Date(poison ? 0 : 1_000),
      })),
    );

    const valid = fixtures.at(-1);
    if (!valid) throw new Error("Expected a valid recovery fixture");
    const recovery = await listRecoverableAgentComputeStopIntents(new Date(), 1);
    expect(recovery.map((row) => row.id)).toEqual([valid.intentId]);
    await expect(
      rearmRecoverableAgentComputeStopIntentOnce({
        intentId: valid.intentId,
        agentId: valid.agentId,
        organizationId: orgId,
        lifecycleRevision: 0,
        now: new Date(),
      }),
    ).resolves.toEqual({ id: valid.jobId, rearmed: true });
    expect(
      await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, "failed"), eq(jobs.user_id, userId))),
    ).toHaveLength(100);
  });

  test("an in-progress funded billing stop leaves an independent manual follow-up", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const periodStart = new Date(Date.now() - 60_000);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "10.000000" })
      .where(eq(organizations.id, orgId));
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: `sandbox-${agentId}`,
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: new Date(0),
        last_billed_at: periodStart,
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const billing = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    await dbWrite.update(jobs).set({ status: "in_progress" }).where(eq(jobs.id, billing.job.id));

    type ManualSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as ManualSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(agentId, orgId, billing.job.id, "billing_request"),
      ).resolves.toMatchObject({ success: true, containerStopped: false });
      expect(providerStop).not.toHaveBeenCalled();
      const manual = await provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      });
      expect(manual.created).toBe(true);
      expect(manual.job.id).not.toBe(billing.job.id);
      expect(manual.job.data).toMatchObject({ authorization: "user_request" });
      await dbWrite.update(jobs).set({ status: "completed" }).where(eq(jobs.id, billing.job.id));
      await expect(
        service.executeSuspend(agentId, orgId, manual.job.id, "user_request"),
      ).resolves.toMatchObject({ success: true, containerStopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [stopped] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(stopped).toMatchObject({ status: "stopped", billing_status: "suspended" });
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("an active manual suspend dominates a later billing enqueue", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const manual = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
    });
    const billing = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    expect(billing.created).toBe(false);
    expect(billing.job.id).toBe(manual.job.id);
    expect(billing.job.data).toMatchObject({ authorization: "user_request" });
    const [intent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intent).toMatchObject({
      authorization: "user_request",
      job_id: manual.job.id,
    });
  });

  test("a terminal manual suspend keeps its job authority over a billing enqueue", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const manual = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    await dbWrite
      .update(jobs)
      .set({ status: "failed", error: "provider retries exhausted" })
      .where(eq(jobs.id, manual.job.id));
    await dbWrite
      .update(agentComputeStopIntents)
      .set({
        status: "terminal_attention",
        attempts: 3,
        last_error: "provider retries exhausted",
      })
      .where(eq(agentComputeStopIntents.job_id, manual.job.id));

    const billing = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
      expectedLifecycleRevision: lifecycleRevision,
    });

    expect(billing.created).toBe(false);
    expect(billing.job).toMatchObject({
      id: manual.job.id,
      status: "failed",
    });
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND)).toHaveLength(1);
    const [intent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intent).toMatchObject({
      authorization: "user_request",
      status: "terminal_attention",
      attempts: 3,
      job_id: manual.job.id,
    });
  });

  test("an exact user replay wins over a now-stale current lifecycle revision", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const first = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: lifecycleRevision + 1 })
      .where(eq(agentSandboxes.id, agentId));

    const replay = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });

    expect(replay).toMatchObject({ created: false });
    expect(replay.job.id).toBe(first.job.id);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND)).toHaveLength(1);
    const intents = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      lifecycle_revision: lifecycleRevision,
      authorization: "user_request",
      job_id: first.job.id,
    });
  });

  test("a stale first user request creates neither stop intent nor job", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    await expect(
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
        expectedLifecycleRevision: lifecycleRevision + 1,
      }),
    ).rejects.toThrow("Agent lifecycle changed before suspend");
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND)).toHaveLength(0);
    expect(
      await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId)),
    ).toHaveLength(0);
  });

  test("a stale first user request cannot promote an older billing intent", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const billing = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: lifecycleRevision + 1 })
      .where(eq(agentSandboxes.id, agentId));

    await expect(
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
        expectedLifecycleRevision: lifecycleRevision,
      }),
    ).rejects.toThrow("Agent lifecycle changed before suspend");

    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND)).toHaveLength(1);
    const [intent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intent).toMatchObject({
      authorization: "billing_request",
      lifecycle_revision: lifecycleRevision,
      job_id: billing.job.id,
    });
  });

  test("a first user stop cannot claim pool-owned or soft-deleted capacity", async () => {
    const targets = [
      await seedAgent({ executionTier: "dedicated-always", poolStatus: "unclaimed" }),
      await seedAgent({
        executionTier: "dedicated-always",
        deletedAt: new Date("2026-08-23T00:00:00.000Z"),
      }),
    ];
    for (const target of targets) {
      await expect(
        provisioningJobService.enqueueAgentSuspendOnce({
          agentId: target.agentId,
          organizationId: target.orgId,
          userId: target.userId,
          authorization: "user_request",
          expectedLifecycleRevision: target.lifecycleRevision,
        }),
      ).rejects.toMatchObject({ status: 404, code: "resource_not_found" });
      expect(await jobsOfType(target.agentId, JOB_TYPES.AGENT_SUSPEND)).toHaveLength(0);
      expect(
        await dbWrite
          .select()
          .from(agentComputeStopIntents)
          .where(eq(agentComputeStopIntents.agent_id, target.agentId)),
      ).toHaveLength(0);
    }
  });

  test("a queued billing stop is promoted in place by exact user authority", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const billing = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    const user = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });

    expect(user.created).toBe(false);
    expect(user.job.id).toBe(billing.job.id);
    // Promotion never mutates the already-claimable job envelope; authority
    // moves monotonically on the exact locked intent.
    expect(user.job.data).toMatchObject({
      authorization: "billing_request",
      lifecycleRevision,
    });
    const [intent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.agent_id, agentId));
    expect(intent).toMatchObject({
      authorization: "user_request",
      lifecycle_revision: lifecycleRevision,
      job_id: billing.job.id,
    });
  });

  test("a funded user stop reads locked intent authority and is never reactivated", async () => {
    const { agentId, orgId, userId } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "10.000000" })
      .where(eq(organizations.id, orgId));
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: `sandbox-${agentId}`,
        billing_status: "active",
        last_billed_at: periodStart,
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const [current] = await dbWrite
      .select({ lifecycleRevision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: current.lifecycleRevision,
    });
    type UserSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
        expectedLifecycleRevision?: number,
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as UserSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      // The stale job hint deliberately says billing; the locked intent must
      // dominate it and preserve the unconditional user request.
      await expect(
        service.executeSuspend(
          agentId,
          orgId,
          enqueued.job.id,
          "billing_request",
          current.lifecycleRevision,
        ),
      ).resolves.toMatchObject({ success: true, containerStopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [stopped] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(stopped).toMatchObject({ status: "stopped", billing_status: "suspended" });
      const [intent] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(intent.status).toBe("provider_confirmed");
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("an already-stopped agent is billing-suspended before provider confirmation is exposed", async () => {
    const { agentId, orgId, userId } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "active",
        sandbox_id: `sandbox-${agentId}`,
        bridge_url: REACHABLE_BRIDGE,
        health_url: "http://10.0.0.5:8081",
        last_billed_at: periodStart,
        scheduled_shutdown_at: new Date(0),
        shutdown_warning_sent_at: new Date(0),
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const [stoppedBeforeAdmission] = await dbWrite
      .select({ lifecycleRevision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    const lifecycleRevision = stoppedBeforeAdmission.lifecycleRevision;
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    type AlreadyStoppedSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
        expectedLifecycleRevision?: number,
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as AlreadyStoppedSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(agentId, orgId, enqueued.job.id, "user_request", lifecycleRevision),
      ).resolves.toMatchObject({ success: true, containerStopped: true });
      expect(gateSpy).not.toHaveBeenCalled();
      expect(providerStop).not.toHaveBeenCalled();
      const [sandbox] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(sandbox).toMatchObject({
        status: "stopped",
        billing_status: "suspended",
        bridge_url: null,
        health_url: null,
        scheduled_shutdown_at: null,
        shutdown_warning_sent_at: null,
      });
      const [intent] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(intent.status).toBe("provider_confirmed");
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("an already-stopped billing target honors funding restored after enqueue", async () => {
    const { agentId, orgId, userId } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const periodStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "1.000000" })
      .where(eq(organizations.id, orgId));
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "shutdown_pending",
        sandbox_id: `sandbox-${agentId}`,
        last_backup_at: new Date(),
        last_billed_at: periodStart,
        scheduled_shutdown_at: new Date(0),
        shutdown_warning_sent_at: new Date(0),
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const [current] = await dbWrite
      .select({ lifecycleRevision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
      expectedLifecycleRevision: current.lifecycleRevision,
    });
    type FundedStoppedSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
        expectedLifecycleRevision?: number,
      ): Promise<{
        success: boolean;
        containerStopped: boolean;
        skipped?: boolean;
        reason?: string;
        error?: string;
      }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as FundedStoppedSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(
          agentId,
          orgId,
          enqueued.job.id,
          "billing_request",
          current.lifecycleRevision,
        ),
      ).resolves.toEqual({
        success: true,
        containerStopped: false,
        skipped: true,
        reason: "billing_recovered",
      });
      expect(gateSpy).not.toHaveBeenCalled();
      expect(providerStop).not.toHaveBeenCalled();

      const [sandbox] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(sandbox).toMatchObject({
        status: "stopped",
        billing_status: "active",
        scheduled_shutdown_at: null,
        shutdown_warning_sent_at: null,
      });
      expect(sandbox.last_billed_at?.getTime()).toBeGreaterThan(periodStart.getTime());

      const [intent] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(intent).toMatchObject({
        status: "superseded",
        last_error: "billing_recovered",
        provider_confirmed_at: null,
      });
      expect(
        await dbWrite
          .select()
          .from(agentBillingRecords)
          .where(eq(agentBillingRecords.sandbox_id, agentId)),
      ).toHaveLength(1);
      const [org] = await dbWrite
        .select({ creditBalance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      expect(Number(org.creditBalance)).toBeLessThan(1);
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("execution lifecycle drift is a terminal safe no-op before backup or provider", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent({
      executionTier: "dedicated-always",
    });
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
      expectedLifecycleRevision: lifecycleRevision,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: lifecycleRevision + 1 })
      .where(eq(agentSandboxes.id, agentId));
    type StaleSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
        expectedLifecycleRevision?: number,
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as StaleSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(agentId, orgId, enqueued.job.id, "user_request", lifecycleRevision),
      ).resolves.toEqual({
        success: true,
        containerStopped: false,
        skipped: true,
        reason: "lifecycle_changed",
      });
      expect(gateSpy).not.toHaveBeenCalled();
      expect(providerStop).not.toHaveBeenCalled();
      const [intent] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(intent.status).toBe("superseded");

      const processed = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_SUSPEND],
      });
      expect(processed).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
      const [settledJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, enqueued.job.id));
      expect(settledJob).toMatchObject({
        status: "completed",
        result: {
          cloudAgentId: agentId,
          containerStopped: false,
          skipped: true,
          reason: "lifecycle_changed",
        },
      });
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("concurrent manual and billing enqueues converge on manual authority", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const [billing, manual] = await Promise.all([
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "billing_request",
      }),
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      }),
    ]);
    const persisted = await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND);
    expect(new Set([billing.job.id, manual.job.id]).size).toBe(persisted.length);
    const activeIntents = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(
        and(
          eq(agentComputeStopIntents.agent_id, agentId),
          sql`${agentComputeStopIntents.status} IN ('pending', 'dispatching', 'retry', 'terminal_attention')`,
        ),
      );
    expect(activeIntents).toHaveLength(1);
    expect(activeIntents[0]).toMatchObject({
      authorization: "user_request",
      job_id: billing.job.id,
    });
  });

  test("a legacy suspend job derives billing authority from its exact backfilled intent", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const periodStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "1.000000" })
      .where(eq(organizations.id, orgId));
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: `sandbox-${agentId}`,
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: new Date(0),
        last_billed_at: periodStart,
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    const [legacyJob] = await dbWrite
      .update(jobs)
      .set({ data: sql`${jobs.data} - 'authorization'` })
      .where(eq(jobs.id, enqueued.job.id))
      .returning();
    if (!legacyJob) throw new Error("Expected legacy suspend job fixture");
    expect(await resolveAgentSuspendAuthorization(legacyJob)).toBe("billing_request");

    type BillingSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as BillingSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      const outcome = await service.executeSuspend(agentId, orgId, legacyJob.id, "billing_request");
      expect(outcome).toMatchObject({ success: true, containerStopped: false });
      expect(providerStop).not.toHaveBeenCalled();
      const [intent] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.agent_id, agentId));
      expect(intent.status).toBe("superseded");
      expect(
        (await listRecoverableAgentComputeStopIntents(new Date())).map((row) => row.id),
      ).not.toContain(intent.id);
      expect(
        await dbWrite
          .select()
          .from(agentBillingRecords)
          .where(eq(agentBillingRecords.sandbox_id, agentId)),
      ).toHaveLength(1);
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("a microscopic billing top-up cannot cancel stop without settling full accrued debt", async () => {
    const { agentId, orgId, userId } = await seedAgent({ executionTier: "dedicated-always" });
    const periodStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0.000001" })
      .where(eq(organizations.id, orgId));
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: `sandbox-${agentId}`,
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: new Date(0),
        last_billed_at: periodStart,
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: orgId,
      workload_kind: "agent",
      workload_id: agentId,
      lifecycle_revision: 0,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: periodStart,
    });
    const enqueued = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "billing_request",
    });
    type BillingSuspendService = {
      executeSuspend(
        targetAgentId: string,
        targetOrganizationId: string,
        jobId: string,
        authorization: "user_request" | "billing_request",
      ): Promise<{ success: boolean; containerStopped: boolean; error?: string }>;
      runBoundedSandboxStopForReplacement(sandboxId: string): Promise<{ error: unknown } | null>;
    };
    const service = elizaSandboxService as unknown as BillingSuspendService;
    const providerStop = spyOn(service, "runBoundedSandboxStopForReplacement").mockResolvedValue(
      null,
    );
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    try {
      await expect(
        service.executeSuspend(agentId, orgId, enqueued.job.id, "billing_request"),
      ).resolves.toMatchObject({ success: true, containerStopped: true });
      expect(providerStop).toHaveBeenCalledTimes(1);
      const [stopped] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(stopped.status).toBe("stopped");
      expect(stopped.last_billed_at?.getTime()).toBe(periodStart.getTime());
      const [org] = await dbWrite
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      expect(org.credit_balance).toBe("0.000001");
    } finally {
      providerStop.mockRestore();
      gateSpy.mockRestore();
    }
  });

  test("provision enqueues a single pending agent_provision job and reuses it on a second call", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const first = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(first.created).toBe(true);
    expect(first.job.type).toBe(JOB_TYPES.AGENT_PROVISION);
    expect(first.job.status).toBe("pending");

    // Second enqueue while the first is still pending reuses it (idempotent
    // enqueueLifecycleJob) rather than queuing a duplicate provision.
    const second = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_PROVISION)).toHaveLength(1);
  });

  test("the enqueueAgentProvision convenience wrapper returns the queued job", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const job = await provisioningJobService.enqueueAgentProvision({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(job.type).toBe(JOB_TYPES.AGENT_PROVISION);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_PROVISION)).toHaveLength(1);
  });

  test("provision enqueue rejects a stale database-owned lifecycle revision", async () => {
    const { agentId, orgId, userId, lifecycleRevision } = await seedAgent();
    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET error_count = error_count + 1
      WHERE id = ${agentId}
    `);

    await expect(
      provisioningJobService.enqueueAgentProvisionOnce({
        agentId,
        organizationId: orgId,
        userId,
        agentName: "stale-provision",
        expectedLifecycleRevision: lifecycleRevision,
      }),
    ).rejects.toThrow("Agent state changed while starting");
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_PROVISION)).toHaveLength(0);
  });

  test("suspend/resume/sleep/restart each enqueue their own pending job", async () => {
    const cases: Array<{
      type: string;
      call: (a: { agentId: string; organizationId: string; userId: string }) => Promise<unknown>;
    }> = [
      {
        type: JOB_TYPES.AGENT_SUSPEND,
        call: (p) => provisioningJobService.enqueueAgentSuspendOnce(p),
      },
      {
        type: JOB_TYPES.AGENT_RESUME,
        call: (p) => provisioningJobService.enqueueAgentResumeOnce(p),
      },
      { type: JOB_TYPES.AGENT_SLEEP, call: (p) => provisioningJobService.enqueueAgentSleepOnce(p) },
      {
        type: JOB_TYPES.AGENT_RESTART,
        call: (p) => provisioningJobService.enqueueAgentRestartOnce(p),
      },
    ];
    for (const c of cases) {
      const { agentId, orgId, userId } = await seedAgent();
      const res = (await c.call({ agentId, organizationId: orgId, userId })) as {
        created: boolean;
        job: { type: string };
      };
      expect(res.created).toBe(true);
      expect(res.job.type).toBe(c.type);
      expect(await jobsOfType(agentId, c.type)).toHaveLength(1);
    }
  });

  test("wake echoes the applied restore params and records them on the job data", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const res = await provisioningJobService.enqueueAgentWakeOnce({
      agentId,
      organizationId: orgId,
      userId,
      restoreBackupId: "backup-xyz",
      forceFreshBoot: false,
    });
    expect(res.created).toBe(true);
    expect(res.job.type).toBe(JOB_TYPES.AGENT_WAKE);
    expect(res.appliedRestoreBackupId).toBe("backup-xyz");
    expect(res.appliedForceFreshBoot).toBe(false);
    expect((res.job.data as { restoreBackupId?: string }).restoreBackupId).toBe("backup-xyz");
  });

  test("upgrade and downgrade carry their image/digest job data", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const up = await provisioningJobService.enqueueAgentUpgradeOnce({
      agentId,
      organizationId: orgId,
      userId,
      dockerImage: "eliza/agent",
      fromDigest: "sha256:old",
      toDigest: "sha256:new",
    });
    expect(up.created).toBe(true);
    expect((up.job.data as { toDigest?: string }).toDigest).toBe("sha256:new");

    await expect(
      provisioningJobService.enqueueAgentDowngradeOnce({
        agentId,
        organizationId: orgId,
        userId,
        dockerImage: "eliza/agent",
        fromDigest: "sha256:new",
      }),
    ).rejects.toMatchObject({
      code: "session_not_ready",
      message: expect.stringContaining("conflicting agent_upgrade job"),
    });
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.id, up.job.id));

    const down = await provisioningJobService.enqueueAgentDowngradeOnce({
      agentId,
      organizationId: orgId,
      userId,
      dockerImage: "eliza/agent",
      fromDigest: "sha256:new",
    });
    expect(down.created).toBe(true);
    expect(down.job.type).toBe(JOB_TYPES.AGENT_DOWNGRADE);
    expect((down.job.data as { fromDigest?: string }).fromDigest).toBe("sha256:new");
  });

  test("logs enqueues with the requested tail and dedupes on the tail predicate", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const first = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: orgId,
      userId,
      tail: 250,
    });
    expect(first.created).toBe(true);
    expect((first.job.data as { tail?: number }).tail).toBe(250);
    // Same tail while in-flight → reuse.
    const same = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: orgId,
      userId,
      tail: 250,
    });
    expect(same.created).toBe(false);
    expect(same.job.id).toBe(first.job.id);
  });

  test("each message turn is a fresh job (nonce idempotency never reuses)", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const a = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: orgId,
      userId,
      text: "hello",
    });
    const b = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: orgId,
      userId,
      text: "hello again",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.job.id).not.toBe(b.job.id);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_MESSAGE)).toHaveLength(2);
  });

  test("delete flips the sandbox to deletion_pending and cancels other in-flight jobs", async () => {
    const { agentId, orgId, userId } = await seedAgent({ status: "running" });
    // A queued suspend that the delete must supersede.
    await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
    });

    const del = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId,
      organizationId: orgId,
      userId,
      authorization: "user_request",
    });
    expect(del.created).toBe(true);
    expect(del.job.type).toBe(JOB_TYPES.AGENT_DELETE);
    expect((del.job.data as { authorization?: string }).authorization).toBe("user_request");

    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(sandbox?.status).toBe("deletion_pending");
    expect(sandbox?.deletion_previous_status).toBe("running");
    expect(sandbox?.deletion_previous_billing_status).toBe("active");

    // The superseded suspend is cancelled (delete wins), the delete itself is not.
    const suspendRows = await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND);
    expect(suspendRows[0]?.status).toBe("cancelled");
    const deleteRows = await jobsOfType(agentId, JOB_TYPES.AGENT_DELETE);
    expect(deleteRows[0]?.status).toBe("pending");
  });

  test("delete refuses a running sandbox before recording deletion intent", async () => {
    const { agentId, orgId, userId } = await seedAgent({
      status: "running",
      lastHeartbeatAt: new Date(Date.now() - 5 * 60_000),
      executionTier: "dedicated-always",
    });

    await expect(
      provisioningJobService.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "session_not_ready",
      message: "Agent is running; suspend it before deletion",
    });

    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(sandbox?.status).toBe("running");
    expect(sandbox?.deletion_attempt_id).toBeNull();
    expect(sandbox?.deletion_started_at).toBeNull();
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_DELETE)).toHaveLength(0);
  });

  test("conditional delete atomically owns the exact stale provisioning identity", async () => {
    const { orgId, userId } = await seedOwner();
    const createdAt = new Date("2026-07-13T08:17:00.000Z");
    const agentName = "managed-dedicated-canary-r30081355987a1";
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: agentName,
        status: "provisioning",
        execution_tier: "dedicated-always",
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning();
    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET created_at = ${"2026-07-13T08:17:00.000123Z"}::timestamptz
      WHERE id = ${sandbox.id}
    `);
    const provision = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: sandbox.id,
      organizationId: orgId,
      userId,
      agentName,
    });
    await dbWrite
      .update(jobs)
      .set({
        status: "failed",
        started_at: createdAt,
        updated_at: createdAt,
      })
      .where(eq(jobs.id, provision.job.id));

    const deletion = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId: sandbox.id,
      organizationId: orgId,
      userId,
      expectedIdentity: {
        agentName,
        createdAt: createdAt.toISOString(),
        executionTier: "dedicated-always",
      },
    });

    expect(deletion.created).toBe(true);
    const [updated] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(updated?.status).toBe("deletion_pending");
    const [provisionRow] = await jobsOfType(sandbox.id, JOB_TYPES.AGENT_PROVISION);
    expect(provisionRow?.id).toBe(provision.job.id);
    expect(provisionRow?.status).toBe("failed");
    expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(1);
  });

  test("conditional delete cancels a retry-pending job after execution quiescence is acknowledged", async () => {
    const { orgId, userId } = await seedOwner();
    const createdAt = new Date(Date.now() - 20 * 60 * 1000);
    const agentName = "managed-dedicated-canary-r30081355987a1";
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: agentName,
        status: "provisioning",
        execution_tier: "dedicated-always",
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning();
    const provision = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: sandbox.id,
      organizationId: orgId,
      userId,
      agentName,
    });
    await dbWrite
      .update(jobs)
      .set({
        status: "pending",
        started_at: createdAt,
        execution_generation: "55555555-5555-4555-8555-555555555555",
        execution_quiesced_at: createdAt,
        updated_at: createdAt,
      })
      .where(eq(jobs.id, provision.job.id));

    const deletion = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId: sandbox.id,
      organizationId: orgId,
      userId,
      expectedIdentity: {
        agentName,
        createdAt: createdAt.toISOString(),
        executionTier: "dedicated-always",
      },
    });

    expect(deletion.created).toBe(true);
    const [provisionRow] = await jobsOfType(sandbox.id, JOB_TYPES.AGENT_PROVISION);
    expect(provisionRow?.status).toBe("cancelled");
    expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(1);
  });

  for (const activeStatus of ["in_progress", "failed", "cancelled"] as const) {
    test(`conditional delete refuses a non-quiescent ${activeStatus} lifecycle job`, async () => {
      const { orgId, userId } = await seedOwner();
      const createdAt = new Date();
      const agentName = "managed-dedicated-canary-r30081355987a1";
      const [sandbox] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: agentName,
          status: "provisioning",
          execution_tier: "dedicated-always",
          created_at: createdAt,
          updated_at: createdAt,
        })
        .returning();
      const provision = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: orgId,
        userId,
        agentName,
      });
      await dbWrite
        .update(jobs)
        .set({
          status: activeStatus,
          started_at: createdAt,
          execution_generation: "55555555-5555-4555-8555-555555555555",
          execution_quiesced_at: null,
          updated_at: createdAt,
        })
        .where(eq(jobs.id, provision.job.id));

      await expect(
        provisioningJobService.enqueueAgentDeleteOnce({
          agentId: sandbox.id,
          organizationId: orgId,
          userId,
          expectedIdentity: {
            agentName,
            createdAt: createdAt.toISOString(),
            executionTier: "dedicated-always",
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "session_not_ready",
      });

      const [unchanged] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(unchanged?.status).toBe("provisioning");
      const [provisionRow] = await jobsOfType(sandbox.id, JOB_TYPES.AGENT_PROVISION);
      expect(provisionRow?.status).toBe(activeStatus);
      expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(0);
    });
  }

  test("conditional delete rolls back when the identity changed", async () => {
    const { orgId, userId } = await seedOwner();
    const createdAt = new Date("2026-07-13T08:17:00.000Z");
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: "repurposed-agent",
        status: "provisioning",
        execution_tier: "dedicated-always",
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning();

    await expect(
      provisioningJobService.enqueueAgentDeleteOnce({
        agentId: sandbox.id,
        organizationId: orgId,
        userId,
        expectedIdentity: {
          agentName: "repurposed-agent",
          createdAt: "2026-07-13T08:17:00.001Z",
          executionTier: "dedicated-always",
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "session_not_ready",
    });

    const [unchanged] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(unchanged?.status).toBe("provisioning");
    expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(0);
  });

  for (const mismatch of ["name", "tier"] as const) {
    test(`conditional delete rolls back on an exact ${mismatch} mismatch`, async () => {
      const { orgId, userId } = await seedOwner();
      const createdAt = new Date("2026-07-13T08:17:00.000Z");
      const agentName = "managed-dedicated-canary-r30081355987a1";
      const [sandbox] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: agentName,
          status: "provisioning",
          execution_tier: "dedicated-always",
          created_at: createdAt,
          updated_at: createdAt,
        })
        .returning();

      await expect(
        provisioningJobService.enqueueAgentDeleteOnce({
          agentId: sandbox.id,
          organizationId: orgId,
          userId,
          expectedIdentity: {
            agentName: mismatch === "name" ? `${agentName}-different` : agentName,
            createdAt: createdAt.toISOString(),
            executionTier: mismatch === "tier" ? "dedicated-lazy" : "dedicated-always",
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "session_not_ready",
      });

      const [unchanged] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(unchanged?.status).toBe("provisioning");
      expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(0);
    });
  }

  for (const credentialState of ["pending", "attested"] as const) {
    test(`conditional delete preserves a ${credentialState} warm-claim handoff`, async () => {
      const { orgId, userId } = await seedOwner();
      const createdAt = new Date("2026-07-13T08:17:00.000Z");
      const agentName = "managed-dedicated-canary-r30081355987a1";
      const [sandbox] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: agentName,
          status: "provisioning",
          execution_tier: "dedicated-always",
          claimed_at: createdAt,
          warm_claim_credential_state: credentialState,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .returning();
      const provision = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: orgId,
        userId,
        agentName,
      });

      await expect(
        provisioningJobService.enqueueAgentDeleteOnce({
          agentId: sandbox.id,
          organizationId: orgId,
          userId,
          expectedIdentity: {
            agentName,
            createdAt: createdAt.toISOString(),
            executionTier: "dedicated-always",
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "session_not_ready",
      });

      const [unchanged] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(unchanged?.status).toBe("provisioning");
      const [provisionRow] = await jobsOfType(sandbox.id, JOB_TYPES.AGENT_PROVISION);
      expect(provisionRow?.id).toBe(provision.job.id);
      expect(provisionRow?.status).toBe("pending");
      expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(0);
    });
  }

  test("conditional delete owns the row while preserving replacement cleanup for the daemon", async () => {
    const { orgId, userId } = await seedOwner();
    const createdAt = new Date("2026-07-13T08:17:00.000Z");
    const agentName = "managed-dedicated-canary-r30081355987a1";
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: agentName,
        status: "provisioning",
        execution_tier: "dedicated-always",
        created_at: createdAt,
        updated_at: createdAt,
        replacement_cleanup_sandbox_id: "replacement-sandbox",
        replacement_cleanup_node_id: "replacement-node",
        replacement_cleanup_container_name: "replacement-container",
        replacement_cleanup_attempt_id: "77777777-7777-4777-8777-777777777777",
        replacement_cleanup_allocation_counted: false,
        replacement_cleanup_created_at: createdAt,
      })
      .returning();

    const deletion = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId: sandbox.id,
      organizationId: orgId,
      userId,
      expectedIdentity: {
        agentName,
        createdAt: createdAt.toISOString(),
        executionTier: "dedicated-always",
      },
    });
    const [owned] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(owned?.status).toBe("deletion_pending");
    expect(owned?.replacement_cleanup_sandbox_id).toBe("replacement-sandbox");
    expect(deletion.created).toBe(true);
    expect(await jobsOfType(sandbox.id, JOB_TYPES.AGENT_DELETE)).toHaveLength(1);
  });

  test("enqueue against a missing agent throws Agent not found", async () => {
    const { orgId, userId } = await seedOwner();
    await expect(
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId: "00000000-0000-4000-8000-000000000000",
        organizationId: orgId,
        userId,
      }),
    ).rejects.toThrow("Agent not found");
  });
});

describe("enqueueScheduledBackups — sweep fairness + capability tracking (#15783)", () => {
  const HOUR = 60 * 60 * 1000;

  test("the capped window is ordered oldest-successful-backup-first, never-backed-up leading", async () => {
    const neverBacked = await seedSandbox({ lastBackupAt: null });
    const oldest = await seedSandbox({ lastBackupAt: new Date(Date.now() - 48 * HOUR) });
    const newerButDue = await seedSandbox({ lastBackupAt: new Date(Date.now() - 7 * HOUR) });

    const res = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 2 });

    // Cap of 2 must take the NULL row and the 48h row; the merely-7h-stale row
    // waits for the next tick instead of a planner-order lottery.
    expect(res).toMatchObject({ scanned: 2, enqueued: 2 });
    expect(await snapshotJobsFor(neverBacked)).toHaveLength(1);
    expect(await snapshotJobsFor(oldest)).toHaveLength(1);
    expect(await snapshotJobsFor(newerButDue)).toHaveLength(0);
  });

  test("snapshot-incapable rows stop competing for the window until their slow re-probe", async () => {
    // An unsupported population AT the cap used to be able to consume the
    // whole window every tick, starving the one healthy agent indefinitely.
    const healthy = await seedSandbox({ lastBackupAt: new Date(Date.now() - 7 * HOUR) });
    const unsupportedRecentProbe = [] as string[];
    for (let i = 0; i < 2; i++) {
      unsupportedRecentProbe.push(
        await seedSandbox({
          lastBackupAt: null,
          backupUnsupportedReason: "Snapshot endpoint not supported by agent image",
          lastBackupAttemptAt: new Date(Date.now() - 1 * HOUR),
        }),
      );
    }

    const res = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 2 });

    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(healthy)).toHaveLength(1);
    for (const id of unsupportedRecentProbe) {
      expect(await snapshotJobsFor(id)).toHaveLength(0);
    }
  });

  test("a snapshot-incapable row is re-probed once its last attempt ages past the recheck interval", async () => {
    const stalledProbe = await seedSandbox({
      lastBackupAt: null,
      backupUnsupportedReason: "Snapshot endpoint not supported by agent image",
      lastBackupAttemptAt: new Date(Date.now() - 25 * HOUR),
    });

    const res = await provisioningJobService.enqueueScheduledBackups();

    // Default recheck is 24h; a 25h-old attempt re-enters the due set so an
    // image upgrade is noticed within one recheck interval.
    expect(res).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(stalledProbe)).toHaveLength(1);
  });

  test("the fleet report measures route-less, incapable, never-backed-up, and stale local-state populations", async () => {
    await seedSandbox({ bridgeUrl: null }); // route-less
    await seedSandbox({
      backupUnsupportedReason: "Snapshot endpoint not supported by agent image",
      lastBackupAttemptAt: new Date(),
    }); // incapable, never backed up
    await seedSandbox({
      environmentVars: { ELIZA_AGENT_LOCAL_STATE: "1" },
      lastBackupAt: new Date(Date.now() - 48 * HOUR),
    }); // local-state, stale
    await seedSandbox({
      environmentVars: { ELIZA_AGENT_LOCAL_STATE: "1" },
      lastBackupAt: new Date(Date.now() - 1 * HOUR),
    }); // local-state, fresh

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res.fleet).toMatchObject({
      running: 4,
      routeless: 1,
      snapshotUnsupported: 1,
      neverBackedUp: 2,
      localState: 2,
      localStateStale: 1,
    });
  });
});
