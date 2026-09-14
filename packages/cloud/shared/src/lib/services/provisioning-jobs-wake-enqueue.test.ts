/**
 * Wake-job enqueue conflict handling (#15603 B6) against the REAL enqueue
 * path: `enqueueAgentWakeOnce` runs its actual Drizzle transaction on
 * in-process PGlite — advisory lock, sandbox-row read, in-flight-job reuse
 * lookup, and jobs insert all execute for real. Locks the contract that
 * reusing an active wake job can never silently drop the caller's
 * restoreBackupId/forceFreshBoot: a param-bearing request that conflicts with
 * the in-flight job's params is refused with a typed 409, and the enqueue
 * result always reports the params the in-flight job will ACTUALLY apply.
 *
 * Harness mirrors `wake-restore-integrity.test.ts`: drizzle-kit `pushSchema`
 * applies the real DDL to the PGlite connection the service queries through;
 * fails LOUDLY when the ambient DATABASE_URL is a shared non-PGlite Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { generations } from "../../db/schemas/generations";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { ApiError } from "../api/cloud-worker-errors";
import { provisioningJobService } from "./provisioning-jobs";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const RESTORE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESTORE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seedSleepingAgent(): Promise<{
  agentId: string;
  organizationId: string;
  userId: string;
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Wake Enqueue Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: uniq("agent"),
      status: "sleeping",
      execution_tier: "dedicated-lazy",
    })
    .returning();
  return { agentId: sandbox.id, organizationId: org.id, userId: user.id };
}

async function countWakeJobs(agentId: string): Promise<number> {
  const rows = await dbWrite.select({ id: jobs.id }).from(jobs).where(eq(jobs.agent_id, agentId));
  return rows.length;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[provisioning-jobs-wake-enqueue.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    // The jobs table's FK closure: jobs → apiKeys/generations, generations →
    // usageRecords, agentSandboxes → userCharacters.
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      agentSandboxes,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[provisioning-jobs-wake-enqueue.test] PGlite/pushSchema unavailable — cannot drive the wake enqueue against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("enqueueAgentWakeOnce reuse vs. conflicting restore params", () => {
  test("persists the admitted tariff and never upgrades it when reusing an old job", async () => {
    const seeded = await seedSleepingAgent();
    const first = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    expect(first.job.data.admittedComputePrice).toBe("dedicated-compute-v1:USD:0.150000:0.300000");
    const oldPrice = "dedicated-compute-v1:USD:0.010000:0.020000";
    await dbWrite
      .update(jobs)
      .set({ data: { ...first.job.data, admittedComputePrice: oldPrice } })
      .where(eq(jobs.id, first.job.id));
    const reused = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    expect(reused.created).toBe(false);
    expect(reused.job.id).toBe(first.job.id);
    expect(reused.job.data.admittedComputePrice).toBe(oldPrice);
    const [persisted] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.job.id));
    expect(persisted.data.admittedComputePrice).toBe(oldPrice);
    expect(await countWakeJobs(seeded.agentId)).toBe(1);
  });

  test("bare wake reuses the in-flight bare wake and reports its (empty) params", async () => {
    const seeded = await seedSleepingAgent();

    const first = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    expect(first.created).toBe(true);
    expect(first.appliedRestoreBackupId).toBeNull();
    expect(first.appliedForceFreshBoot).toBe(false);

    const second = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.appliedRestoreBackupId).toBeNull();
    expect(second.appliedForceFreshBoot).toBe(false);
    expect(await countWakeJobs(seeded.agentId)).toBe(1);
  });

  test("restoreBackupId against an in-flight bare wake: typed 409 naming the conflicting job, nothing enqueued", async () => {
    const seeded = await seedSleepingAgent();
    const first = await provisioningJobService.enqueueAgentWakeOnce(seeded);

    // The gate's failure message invites "retry the wake with restoreBackupId";
    // silently reusing the very job that just failed would discard that choice.
    const attempt = provisioningJobService.enqueueAgentWakeOnce({
      ...seeded,
      restoreBackupId: RESTORE_A,
    });
    const error = await attempt.then(
      () => {
        throw new Error("expected a 409 conflict");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.message).toContain(first.job.id);
    expect(apiError.message).toContain("different restore parameters");
    expect(apiError.details).toMatchObject({
      conflictingJobId: first.job.id,
      activeRestoreBackupId: null,
      activeForceFreshBoot: false,
      requestedRestoreBackupId: RESTORE_A,
      requestedForceFreshBoot: false,
    });
    expect(await countWakeJobs(seeded.agentId)).toBe(1);
  });

  test("forceFreshBoot against an in-flight restore wake: typed 409; same restoreBackupId reuses cleanly", async () => {
    const seeded = await seedSleepingAgent();
    const restoreWake = await provisioningJobService.enqueueAgentWakeOnce({
      ...seeded,
      restoreBackupId: RESTORE_A,
    });
    expect(restoreWake.created).toBe(true);
    expect(restoreWake.appliedRestoreBackupId).toBe(RESTORE_A);

    await expect(
      provisioningJobService.enqueueAgentWakeOnce({ ...seeded, forceFreshBoot: true }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      provisioningJobService.enqueueAgentWakeOnce({ ...seeded, restoreBackupId: RESTORE_B }),
    ).rejects.toMatchObject({ status: 409 });

    const identical = await provisioningJobService.enqueueAgentWakeOnce({
      ...seeded,
      restoreBackupId: RESTORE_A,
    });
    expect(identical.created).toBe(false);
    expect(identical.job.id).toBe(restoreWake.job.id);
    expect(identical.appliedRestoreBackupId).toBe(RESTORE_A);
    expect(await countWakeJobs(seeded.agentId)).toBe(1);
  });

  test("bare retry rides an in-flight restore wake and reports the JOB's params, not the caller's", async () => {
    const seeded = await seedSleepingAgent();
    const restoreWake = await provisioningJobService.enqueueAgentWakeOnce({
      ...seeded,
      restoreBackupId: RESTORE_A,
    });

    // A param-less "wake me" is compatible with any in-flight wake, but the
    // result must name what will ACTUALLY run — the route echoes these fields.
    const bareRetry = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    expect(bareRetry.created).toBe(false);
    expect(bareRetry.job.id).toBe(restoreWake.job.id);
    expect(bareRetry.appliedRestoreBackupId).toBe(RESTORE_A);
    expect(bareRetry.appliedForceFreshBoot).toBe(false);
  });

  test("a finished wake never conflicts: params enqueue a fresh job once the active one completes", async () => {
    const seeded = await seedSleepingAgent();
    const first = await provisioningJobService.enqueueAgentWakeOnce(seeded);
    await dbWrite.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first.job.id));

    const second = await provisioningJobService.enqueueAgentWakeOnce({
      ...seeded,
      restoreBackupId: RESTORE_A,
    });
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
    expect(second.appliedRestoreBackupId).toBe(RESTORE_A);
    expect(await countWakeJobs(seeded.agentId)).toBe(2);
  });
});
