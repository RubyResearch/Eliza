/**
 * Drives the REAL job-execution dispatch of ProvisioningJobService end-to-end:
 * `processPendingJobs` → `processJobType` → `executeJob` → the per-type
 * `executeAgent*` handler, plus the failure path's `buildPermanentFailureWriteback`
 * construction. Every job type's success AND failure branch is exercised so the
 * dispatch table, the per-handler result-record shaping, and the terminal-vs-retry
 * disposition are all covered by real code, not asserted against a stand-in.
 *
 * The only stubs are the genuine boundaries the daemon dispatch sits on:
 * `jobsRepository`, the lifecycle-ownership preflight, and
 * `elizaSandboxService`. Suspend cases additionally replace the service's
 * durable-authority boundary per test because authority and lifecycle fencing
 * are resolved before transport dispatch. No module-global DB mock is used, so
 * this suite remains safe inside the composed PGlite lane.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { jobsRepository, StaleJobExecutionError } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { ProvisioningJobService } from "./provisioning-jobs";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER = "33333333-3333-4333-8333-333333333333";
const EMPTY_RECOVERY = {
  scanned: 0,
  retried: 0,
  permanentlyFailed: 0,
  unchanged: 0,
  failures: [],
};
const defaultDispatchService = new ProvisioningJobService({
  acquireProviderAdmission: async () => true,
  releaseProviderAdmission: async () => {},
});

function makeJob(
  type: string,
  extraData: Record<string, unknown> = {},
  overrides: Partial<Job> = {},
): Job {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    type: type as Job["type"],
    status: "in_progress",
    data: {
      agentId: AGENT,
      organizationId: ORG,
      userId: USER,
      agentName: "Test Agent",
      admittedComputePrice: "dedicated-compute-v1:USD:0.150000:0.300000",
      ...(type === JOB_TYPES.AGENT_SUSPEND ? { authorization: "user_request" } : {}),
      ...extraData,
    },
    data_storage: "inline",
    data_key: null,
    agent_id: AGENT,
    character_id: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    attempts: 1,
    max_attempts: 3,
    execution_interruptions: 0,
    retryable_requeues: 0,
    execution_generation: "55555555-5555-4555-8555-555555555555",
    execution_quiesced_at: null,
    organization_id: ORG,
    user_id: USER,
    api_key_id: null,
    generation_id: null,
    webhook_url: null,
    webhook_status: null,
    estimated_completion_at: null,
    scheduled_for: now,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Claim exactly one crafted job of `type` and stub the job-store writes so the
 * real dispatch runs against controlled repository responses. `incrementAttempt`
 * resolves undefined (attempts not yet exhausted) so the failure path stops after
 * building — but not invoking — the permanent-failure writeback, matching the
 * daemon's mid-retry behavior.
 */
function harness(
  job: Job,
  service = defaultDispatchService,
  suspendIntent?: {
    authorization: "user_request" | "billing_request";
    lifecycleRevision: number;
  },
) {
  const authoritySpy =
    job.type === JOB_TYPES.AGENT_SUSPEND
      ? spyOn(
          service as unknown as {
            resolveAgentSuspendAuthority(job: Job): Promise<{
              authorization: "user_request" | "billing_request";
              lifecycleRevision?: number;
              intentBound: boolean;
            }>;
          },
          "resolveAgentSuspendAuthority",
        ).mockResolvedValue({
          ...(suspendIntent ?? {
            authorization:
              job.data.authorization === "billing_request" ? "billing_request" : "user_request",
            lifecycleRevision:
              typeof job.data.lifecycleRevision === "number" ? job.data.lifecycleRevision : 0,
          }),
          intentBound: suspendIntent !== undefined,
        })
      : undefined;
  const snapshotMarkerSpy =
    job.type === JOB_TYPES.AGENT_SNAPSHOT
      ? spyOn(
          service as unknown as {
            recordSnapshotAttemptMarkers(
              agentId: string,
              outcome: "success" | "unsupported" | "other",
            ): Promise<void>;
          },
          "recordSnapshotAttemptMarkers",
        ).mockResolvedValue(undefined)
      : undefined;
  const conflictSpy = spyOn(
    service as unknown as {
      assertNoConflictingLifecycleExecution(job: Job): Promise<void>;
    },
    "assertNoConflictingLifecycleExecution",
  ).mockResolvedValue(undefined);
  const ordinaryClaimSpy = spyOn(jobsRepository, "claimPendingJobs").mockImplementation(
    async (f: { type: string }) => (f.type === job.type ? [job] : []),
  );
  const leaseSpy = spyOn(jobsRepository, "assertExecutionLease").mockResolvedValue(undefined);
  const renewLeaseSpy = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue("lost");
  // agent_delete re-reads durable job data under the lease right before the
  // destructive boundary; by default the durable row matches the claimed one.
  const durableReadSpy = spyOn(jobsRepository, "findByIdForWrite").mockResolvedValue(job);
  const sharedClaimSpy = spyOn(
    jobsRepository,
    "claimPendingJobsWithinSharedRunningLimit",
  ).mockImplementation(async (f: { type: string }) => (f.type === job.type ? [job] : []));
  const claimSpy = {
    mockRestore() {
      authoritySpy?.mockRestore();
      snapshotMarkerSpy?.mockRestore();
      conflictSpy.mockRestore();
      ordinaryClaimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      leaseSpy.mockRestore();
      renewLeaseSpy.mockRestore();
      durableReadSpy.mockRestore();
    },
  };
  const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(EMPTY_RECOVERY);
  const updateStatusSpy = spyOn(jobsRepository, "settleExecution").mockResolvedValue(true);
  const updateSpy = spyOn(jobsRepository, "updateForExecution").mockImplementation(
    async (claimedJob, updates) => ({ ...claimedJob, ...updates }),
  );
  const incrementSpy = spyOn(jobsRepository, "incrementAttempt").mockResolvedValue(undefined);
  const retryLaterSpy = spyOn(
    jobsRepository,
    "retryLaterWithoutIncrementingAttempts",
  ).mockImplementation(async (retrySnapshot, _error, _delayMs, _owner, bounded) => ({
    ...retrySnapshot,
    status: "pending",
    retryable_requeues: retrySnapshot.retryable_requeues + (bounded ? 1 : 0),
  }));
  return {
    job,
    claimSpy,
    leaseSpy,
    renewLeaseSpy,
    durableReadSpy,
    recoverSpy,
    updateStatusSpy,
    updateSpy,
    incrementSpy,
    retryLaterSpy,
  };
}

const serviceSpies: Array<{ mockRestore: () => void }> = [];
function stub<M extends keyof typeof elizaSandboxService>(method: M, value: unknown) {
  const spy = spyOn(elizaSandboxService, method).mockResolvedValue(value as never);
  serviceSpies.push(spy);
  return spy;
}

afterEach(() => {
  for (const s of serviceSpies.splice(0)) s.mockRestore();
});

async function run(type: string, service = defaultDispatchService) {
  return service.processPendingJobs(1, {
    jobTypes: [type as ProvisioningJobType],
  });
}

function completedCall(ctx: ReturnType<typeof harness>) {
  return ctx.updateStatusSpy.mock.calls.find((c) => c[1] === "completed");
}

/**
 * One row per agent job type: the crafted job.data, the transport method the
 * handler delegates to, and a representative SUCCESS payload. Failure is a
 * uniform `{ success: false, error }` (bridge/message uses its own shape below).
 */
const AGENT_ARMS: Array<{
  name: string;
  type: ProvisioningJobType;
  data: Record<string, unknown>;
  method: keyof typeof elizaSandboxService;
  success: Record<string, unknown>;
}> = [
  {
    name: "provision",
    type: JOB_TYPES.AGENT_PROVISION,
    data: {},
    method: "provision",
    success: {
      success: true,
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "running" },
      bridgeUrl: "http://10.0.0.5:8080",
      healthUrl: "http://10.0.0.5:8081",
    },
  },
  {
    name: "delete",
    type: JOB_TYPES.AGENT_DELETE,
    data: {},
    method: "executeDeletion",
    success: { success: true, containerStopped: true, rowDeleted: true },
  },
  {
    name: "suspend",
    type: JOB_TYPES.AGENT_SUSPEND,
    data: {},
    method: "executeSuspend",
    success: { success: true, containerStopped: true },
  },
  {
    name: "resume",
    type: JOB_TYPES.AGENT_RESUME,
    data: {},
    method: "executeResume",
    success: { success: true, containerStarted: true, reprovisioned: false },
  },
  {
    name: "sleep",
    type: JOB_TYPES.AGENT_SLEEP,
    data: {},
    method: "executeSleep",
    success: { success: true, containerRemoved: true, backupId: "backup-sleep" },
  },
  {
    name: "wake",
    type: JOB_TYPES.AGENT_WAKE,
    data: { restoreBackupId: "backup-sleep", forceFreshBoot: false },
    method: "executeWake",
    success: {
      success: true,
      reprovisioned: true,
      restoredBackupId: "backup-sleep",
      freshBoot: false,
    },
  },
  {
    name: "restart",
    type: JOB_TYPES.AGENT_RESTART,
    data: {},
    method: "executeRestart",
    success: {
      success: true,
      containerStopped: true,
      containerStarted: true,
      bridgeUrl: "http://10.0.0.5:8080",
      healthUrl: "http://10.0.0.5:8081",
    },
  },
  {
    name: "upgrade",
    type: JOB_TYPES.AGENT_UPGRADE,
    data: { dockerImage: "eliza/agent", fromDigest: "sha256:old", toDigest: "sha256:new" },
    method: "executeUpgrade",
    success: {
      success: true,
      oldNodeId: "node-a",
      oldContainerName: "c-old",
      newNodeId: "node-b",
      newContainerName: "c-new",
      newDigest: "sha256:new",
    },
  },
  {
    name: "admin canary image",
    type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
    data: {
      operation: "upgrade",
      rolloutId: "55555555-5555-4555-8555-555555555555",
      actorUserId: USER,
      targetOwnerUserId: USER,
      decisionAt: "2026-06-20T00:00:00.000Z",
      sourceImage: "ghcr.io/elizaos/eliza:production",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      targetImage: `ghcr.io/elizaos/eliza-demo@sha256:${"b".repeat(64)}`,
      targetDigest: `sha256:${"b".repeat(64)}`,
    },
    method: "executeAdminCanaryUpgrade",
    success: {
      success: true,
      oldNodeId: "node-a",
      oldContainerName: "c-old",
      newNodeId: "node-b",
      newContainerName: "c-new",
      newDigest: `sha256:${"b".repeat(64)}`,
    },
  },
  {
    name: "downgrade",
    type: JOB_TYPES.AGENT_DOWNGRADE,
    data: { dockerImage: "eliza/agent", fromDigest: "sha256:cur" },
    method: "executeDowngrade",
    success: {
      success: true,
      oldNodeId: "node-b",
      oldContainerName: "c-new",
      newNodeId: "node-a",
      newContainerName: "c-old",
      newDigest: "sha256:old",
    },
  },
  {
    name: "logs",
    type: JOB_TYPES.AGENT_LOGS,
    data: { tail: 100 },
    method: "executeLogs",
    success: { success: true, status: "ok", logs: "line-1\nline-2", message: "collected" },
  },
  {
    name: "snapshot",
    type: JOB_TYPES.AGENT_SNAPSHOT,
    data: { snapshotType: "manual" },
    method: "executeSnapshot",
    success: {
      success: true,
      backup: {
        id: "backup-1",
        snapshot_type: "manual",
        size_bytes: 2048,
        created_at: new Date("2026-06-20T00:00:00.000Z").toISOString(),
      },
    },
  },
];

/** #16639: the dispatch suite exercises the snapshot EXECUTION path, which
 *  the fail-closed lane belt short-circuits unless the gate is exactly
 *  enabled. Arm it per snapshot case (never module-wide — composed suites
 *  share the process env); the gate itself is pinned in
 *  provisioning-jobs-snapshot-gate.test.ts. */
function armSnapshotGateFor(type: string): () => void {
  if (type !== JOB_TYPES.AGENT_SNAPSHOT) return () => {};
  const prev = process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
  process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
  return () => {
    if (prev === undefined) delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
    else process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = prev;
  };
}

describe("queued Dedicated price changes", () => {
  for (const type of [
    JOB_TYPES.AGENT_PROVISION,
    JOB_TYPES.AGENT_RESUME,
    JOB_TYPES.AGENT_WAKE,
    JOB_TYPES.AGENT_RESTART,
  ]) {
    for (const admittedComputePrice of [
      undefined,
      "dedicated-compute-v1:USD:0.010000:0.020000",
      42,
    ]) {
      test(`${type} rejects ${String(admittedComputePrice)} without runtime dispatch or retry`, async () => {
        const arm = AGENT_ARMS.find((candidate) => candidate.type === type);
        if (!arm) throw new Error(`Missing dispatch fixture for ${type}`);
        const ctx = harness(makeJob(type, { ...arm.data, admittedComputePrice }));
        const providerSpy = stub(arm.method, arm.success);
        const rejectSpy = spyOn(jobsRepository, "rejectClaimedExecution").mockResolvedValue(
          "rejected",
        );
        try {
          const result = await run(type);
          expect(result).toMatchObject({ succeeded: 0, failed: 1, retried: 0 });
          expect(providerSpy).not.toHaveBeenCalled();
          expect(rejectSpy).toHaveBeenCalledTimes(1);
          expect(rejectSpy.mock.calls[0]?.[1]).toContain("Review the current price");
          expect(ctx.incrementSpy).not.toHaveBeenCalled();
          expect(ctx.retryLaterSpy).not.toHaveBeenCalled();
        } finally {
          rejectSpy.mockRestore();
          ctx.claimSpy.mockRestore();
          ctx.recoverSpy.mockRestore();
          ctx.updateStatusSpy.mockRestore();
          ctx.updateSpy.mockRestore();
          ctx.incrementSpy.mockRestore();
          ctx.retryLaterSpy.mockRestore();
        }
      });
    }
  }
});

describe("executeJob dispatch — success path per job type marks the job completed", () => {
  for (const arm of AGENT_ARMS) {
    test(`${arm.name}: transport success → completed with a result record, no attempt burned`, async () => {
      const ctx = harness(makeJob(arm.type, arm.data));
      const disarmGate = armSnapshotGateFor(arm.type);
      const atomicAuditWrites: Array<Record<string, unknown>> = [];
      if (arm.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE) {
        const canarySpy = spyOn(
          elizaSandboxService,
          "executeAdminCanaryUpgrade",
        ).mockImplementation(async (params) => {
          const tx = {
            update: () => ({
              set: (updates: Record<string, unknown>) => {
                const prior =
                  atomicAuditWrites.length === 0
                    ? ctx.job
                    : { ...ctx.job, ...atomicAuditWrites.at(-1) };
                atomicAuditWrites.push(updates);
                return {
                  where: () => ({
                    returning: async () => [{ ...prior, ...updates }],
                  }),
                };
              },
            }),
          };
          await params.onCutoverInTx(tx as never, {
            oldNodeId: "node-a",
            oldContainerName: "c-old",
            newNodeId: "node-b",
            newContainerName: "c-new",
            newDigest: params.targetDigest,
          });
          await params.onConvergedInTx(tx as never);
          return arm.success as never;
        });
        serviceSpies.push(canarySpy);
      } else {
        stub(arm.method, arm.success);
      }
      try {
        const res = await run(arm.type);
        expect(res.claimed).toBe(1);
        expect(res.succeeded).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.retried).toBe(0);
        const completed = completedCall(ctx);
        if (arm.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE) {
          expect(completed).toBeUndefined();
          expect(atomicAuditWrites).toHaveLength(3);
          expect(atomicAuditWrites[0]).toMatchObject({
            result_storage: "inline",
            error: null,
            completed_at: null,
          });
          expect(atomicAuditWrites[0]?.result).toMatchObject({
            success: false,
            cleanupPending: true,
          });
          expect(atomicAuditWrites[0]).not.toHaveProperty("status");
          expect(atomicAuditWrites[1]).toMatchObject({
            status: "completed",
            result_storage: "inline",
            error: null,
          });
          expect(atomicAuditWrites[1]?.result).toMatchObject({
            success: true,
            cleanupPending: false,
          });
          expect(atomicAuditWrites[2]).toEqual({
            lifecycle_job_id: null,
            lifecycle_execution_generation: null,
          });
        } else {
          expect(completed).toBeDefined();
          expect(completed?.[2]?.result).toBeTruthy();
          expect(completed?.[2]?.completed_at).toBeInstanceOf(Date);
          expect(completed?.[2]).toMatchObject({
            error: null,
            error_storage: "inline",
            error_key: null,
          });
        }
        expect(ctx.incrementSpy).not.toHaveBeenCalled();
      } finally {
        disarmGate();
        ctx.claimSpy.mockRestore();
        ctx.recoverSpy.mockRestore();
        ctx.updateStatusSpy.mockRestore();
        ctx.updateSpy.mockRestore();
        ctx.incrementSpy.mockRestore();
        ctx.retryLaterSpy.mockRestore();
      }
    });
  }

  test("admin canary remains retryable after cutover until old-placement cleanup converges", async () => {
    const arm = AGENT_ARMS.find(
      (candidate) => candidate.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
    );
    if (!arm) throw new Error("admin canary dispatch arm missing");
    const first = harness(makeJob(arm.type, arm.data));
    let pendingAudit: Record<string, unknown> | undefined;
    let pendingSnapshot: Job | undefined;
    const findByIdSpy = spyOn(jobsRepository, "findByIdForWrite").mockImplementation(async () => {
      return pendingSnapshot;
    });
    const canarySpy = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        const tx = {
          update: () => ({
            set: (updates: Record<string, unknown>) => {
              pendingAudit = updates.result as Record<string, unknown>;
              pendingSnapshot = { ...first.job, ...updates } as Job;
              return {
                where: () => ({
                  returning: async () => [pendingSnapshot],
                }),
              };
            },
          }),
        };
        await params.onCutoverInTx(tx as never, {
          oldNodeId: "node-a",
          oldContainerName: "c-old",
          newNodeId: "node-b",
          newContainerName: "c-new",
          newDigest: params.targetDigest,
        });
        return {
          ...arm.success,
          cleanupPending: true,
          error: "old node unreachable",
        } as never;
      },
    );
    serviceSpies.push(canarySpy);
    try {
      const pending = await run(arm.type);
      expect(pending).toMatchObject({ succeeded: 0, retried: 1, failed: 0 });
      expect(first.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(completedCall(first)).toBeUndefined();
      expect(pendingAudit).toMatchObject({
        success: false,
        cleanupPending: true,
      });
    } finally {
      first.claimSpy.mockRestore();
      first.recoverSpy.mockRestore();
      first.updateStatusSpy.mockRestore();
      first.updateSpy.mockRestore();
      first.incrementSpy.mockRestore();
      first.retryLaterSpy.mockRestore();
      findByIdSpy.mockRestore();
    }

    if (!pendingAudit) throw new Error("pending cutover audit was not captured");
    if (typeof pendingAudit.cutoverAt !== "string") {
      throw new Error("pending cutover audit has no cutover timestamp");
    }
    const retryStartedAt = new Date(Date.parse(pendingAudit.cutoverAt) + 1_000);
    const hostileRetry = harness(
      makeJob(arm.type, arm.data, {
        result: pendingAudit,
        status: "in_progress",
        started_at: retryStartedAt,
        updated_at: retryStartedAt,
      }),
    );
    const { proxy: revokedFailure, revoke } = Proxy.revocable(
      new Error("cleanup transport failed"),
      {},
    );
    revoke();
    const hostileConvergeSpy = spyOn(
      elizaSandboxService,
      "convergeReplacementCleanupFence",
    ).mockImplementation(async () => {
      throw revokedFailure;
    });
    try {
      const deferred = await run(arm.type);
      expect(deferred).toMatchObject({ succeeded: 0, retried: 1, failed: 0 });
      expect(hostileRetry.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(hostileRetry.retryLaterSpy.mock.calls[0]?.[1]).toContain(
        "Admin canary cleanup remains pending: [unstringifiable]",
      );
    } finally {
      hostileConvergeSpy.mockRestore();
      hostileRetry.claimSpy.mockRestore();
      hostileRetry.recoverSpy.mockRestore();
      hostileRetry.updateStatusSpy.mockRestore();
      hostileRetry.updateSpy.mockRestore();
      hostileRetry.incrementSpy.mockRestore();
      hostileRetry.retryLaterSpy.mockRestore();
    }

    const retry = harness(
      makeJob(arm.type, arm.data, {
        result: pendingAudit,
        status: "in_progress",
        started_at: retryStartedAt,
        updated_at: retryStartedAt,
      }),
    );
    let cleanupCompletion: Record<string, unknown> | undefined;
    const convergeSpy = spyOn(
      elizaSandboxService,
      "convergeReplacementCleanupFence",
    ).mockImplementation(async (_agentId, _organizationId, _expectation, onConvergedInTx) => {
      await onConvergedInTx?.({
        update: () => ({
          set: (updates: Record<string, unknown>) => {
            if ("result" in updates) {
              cleanupCompletion = updates.result as Record<string, unknown>;
            }
            return {
              where: () => ({
                returning: async () => [{ id: retry.job.id }],
              }),
            };
          },
        }),
      } as never);
    });
    serviceSpies.push(convergeSpy);
    try {
      const converged = await run(arm.type);
      expect(converged).toMatchObject({ succeeded: 1, retried: 0, failed: 0 });
      expect(convergeSpy).toHaveBeenCalledWith(
        AGENT,
        ORG,
        expect.objectContaining({
          targetOwnerUserId: USER,
          targetDigest: arm.data.targetDigest,
        }),
        expect.any(Function),
      );
      expect(canarySpy).toHaveBeenCalledTimes(1);
      expect(cleanupCompletion).toMatchObject({
        success: true,
        cleanupPending: false,
      });
    } finally {
      retry.claimSpy.mockRestore();
      retry.recoverSpy.mockRestore();
      retry.updateStatusSpy.mockRestore();
      retry.updateSpy.mockRestore();
      retry.incrementSpy.mockRestore();
      retry.retryLaterSpy.mockRestore();
    }
  });

  test("message: bridge reply is stored on the job result and completes", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_MESSAGE, { text: "hello", nonce: "n-1" }));
    const bridgeSpy = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: null,
      result: { text: "hi there" },
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_MESSAGE);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      const completed = completedCall(ctx);
      expect(completed?.[2]?.result).toMatchObject({ text: "hi there" });
    } finally {
      bridgeSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});

describe("executeJob dispatch — failure path per job type retries (increments attempt)", () => {
  for (const arm of AGENT_ARMS) {
    test(`${arm.name}: transport failure → not completed, one attempt burned`, async () => {
      const ctx = harness(makeJob(arm.type, arm.data));
      stub(arm.method, { success: false, error: `${arm.name} transport boom` });
      const disarmGate = armSnapshotGateFor(arm.type);
      try {
        const res = await run(arm.type);
        expect(res.claimed).toBe(1);
        expect(res.succeeded).toBe(0);
        expect(res.failed).toBe(1);
        expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
        expect(ctx.incrementSpy.mock.calls[0]?.[0]).toBe(ctx.job.id);
        expect(completedCall(ctx)).toBeUndefined();
      } finally {
        disarmGate();
        ctx.claimSpy.mockRestore();
        ctx.recoverSpy.mockRestore();
        ctx.updateStatusSpy.mockRestore();
        ctx.updateSpy.mockRestore();
        ctx.incrementSpy.mockRestore();
        ctx.retryLaterSpy.mockRestore();
      }
    });
  }

  test("a hostile thrown Proxy still persists the failed-job transition", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE));
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
      get() {
        throw new Error("hostile property read");
      },
    });
    const executeDeletionSpy = spyOn(elizaSandboxService, "executeDeletion").mockImplementation(
      async () => {
        throw hostile;
      },
    );
    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      expect(ctx.incrementSpy.mock.calls[0]?.[1]).toBe("[unstringifiable]");
    } finally {
      executeDeletionSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("message: bridge error is stored on the job result and the job fails", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_MESSAGE, { text: "hello", nonce: "n-1" }));
    const bridgeSpy = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "bridge unreachable" },
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_MESSAGE);
      expect(res.failed).toBe(1);
      expect(ctx.updateSpy).toHaveBeenCalledWith(
        ctx.job,
        expect.objectContaining({
          result: expect.objectContaining({ error: "bridge unreachable" }),
        }),
        expect.any(String),
      );
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
    } finally {
      bridgeSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});

describe("executeJob dispatch — type-specific disposition rules", () => {
  test("agent_delete preserves billing authorization through worker execution", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE, { authorization: "billing_request" }));
    const executeDeletionSpy = stub("executeDeletion", {
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(executeDeletionSpy).toHaveBeenCalledWith(AGENT, ORG, "billing_request");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_delete carries explicit state-loss authority through execution and completion", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_DELETE, {
        authorization: "billing_request",
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: USER,
        stateLossAcknowledgedAt: "2026-08-21T04:00:00.000Z",
      }),
    );
    const executeDeletionSpy = stub("executeDeletion", {
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(executeDeletionSpy).toHaveBeenCalledWith(AGENT, ORG, "billing_request", true);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: USER,
        stateLossAcknowledgedAt: "2026-08-21T04:00:00.000Z",
      });
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_delete does not honor legacy authority without complete provenance", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_DELETE, {
        authorization: "user_request",
        stateLossAcknowledged: true,
      }),
    );
    const executeDeletionSpy = stub("executeDeletion", {
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(executeDeletionSpy).toHaveBeenCalledWith(AGENT, ORG, "user_request");
      const result = completedCall(ctx)?.[2]?.result as Record<string, unknown> | undefined;
      expect(result?.stateLossAcknowledged).toBeUndefined();
      expect(result?.stateLossAcknowledgedByUserId).toBeUndefined();
      expect(result?.stateLossAcknowledgedAt).toBeUndefined();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_delete honors an acknowledgement upgraded after this execution was claimed", async () => {
    // Race regression: the claimed in-memory job snapshot has no waiver, but a
    // concurrent acknowledged DELETE upgraded the durable row via upgradeReuse.
    // The pre-destructive durable re-read must observe and honor it.
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE, { authorization: "user_request" }));
    ctx.durableReadSpy.mockResolvedValue({
      ...ctx.job,
      data: {
        ...ctx.job.data,
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: "acknowledging-user",
        stateLossAcknowledgedAt: "2026-08-21T04:01:00.000Z",
      },
    });
    const executeDeletionSpy = stub("executeDeletion", {
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(executeDeletionSpy).toHaveBeenCalledWith(AGENT, ORG, "user_request", true);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: "acknowledging-user",
        stateLossAcknowledgedAt: "2026-08-21T04:01:00.000Z",
      });
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_delete stays unacknowledged when the durable row was deleted mid-execution", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE, { authorization: "user_request" }));
    ctx.durableReadSpy.mockResolvedValue(undefined);
    const executeDeletionSpy = stub("executeDeletion", {
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 0, failed: 1, retried: 0 });
      expect(executeDeletionSpy).toHaveBeenCalledWith(AGENT, ORG, "user_request");
      expect(completedCall(ctx)).toBeUndefined();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_delete retains explicit state-loss authority on a failed partial result", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_DELETE, {
        authorization: "billing_request",
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: USER,
        stateLossAcknowledgedAt: "2026-08-21T04:02:00.000Z",
      }),
    );
    stub("executeDeletion", {
      success: false,
      retryable: false,
      containerStopped: false,
      rowDeleted: false,
      error: "provider teardown failed",
    });

    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 0, failed: 1, retried: 0 });
      expect(ctx.updateSpy.mock.calls[0]?.[1]?.result).toMatchObject({
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: USER,
        error: "provider teardown failed",
      });
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("an unresolved delete completes the hot queue attempt with rowDeleted false", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE));
    stub("executeDeletion", {
      success: true,
      containerStopped: false,
      rowDeleted: false,
    });
    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      const completed = completedCall(ctx);
      expect(completed?.[2]?.result).toMatchObject({
        containerStopped: false,
        rowDeleted: false,
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("a transient pre-deletion capture requeues for free and tallies the free retry", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE));
    stub("executeDeletion", {
      success: false,
      retryable: true,
      containerStopped: false,
      rowDeleted: false,
      error: "Refusing to delete without a current backup: snapshot_capture_transient",
    });
    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ retried: 1, failed: 0 });
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
      expect(ctx.updateSpy.mock.calls[0]?.[1]?.result).toMatchObject({ captureRetryCount: 1 });
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("a pre-deletion capture stuck past its free-retry budget escalates and burns an attempt", async () => {
    // `retryLaterWithoutIncrementingAttempts` never touches `attempts`, so an
    // outage that never clears would requeue forever and keep a user-requested
    // delete alive and billed. Past the cap it must fail closed through the
    // ordinary attempt-consuming path instead.
    const ctx = harness(makeJob(JOB_TYPES.AGENT_DELETE, {}, { result: { captureRetryCount: 10 } }));
    stub("executeDeletion", {
      success: false,
      retryable: true,
      containerStopped: false,
      rowDeleted: false,
      error: "Refusing to delete without a current backup: snapshot_capture_transient",
    });
    try {
      const res = await run(JOB_TYPES.AGENT_DELETE);
      expect(res).toMatchObject({ retried: 0, failed: 1 });
      expect(ctx.retryLaterSpy).not.toHaveBeenCalled();
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      expect(res.errors[0]?.error).toContain("attempt-preserving retries");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision retryable transport → requeued without burning an attempt", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    stub("provision", {
      success: false,
      retryable: true,
      error: "readiness probe transport_unresolved",
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res.retried).toBe(1);
      expect(res.failed).toBe(0);
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.retryLaterSpy.mock.calls[0]?.[1]).toContain(
        "readiness probe transport_unresolved",
      );
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("terminal provision failures persist the original provider stack through job writeback", async () => {
    const service = new ProvisioningJobService({
      acquireProviderAdmission: async () => true,
      releaseProviderAdmission: async () => {},
    });
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION), service);
    function providerSocketFailure(): Error {
      return new Error("RequestTimeoutError", {
        cause: new Error("Authorization: Bearer test-private-provider-secret"),
      });
    }
    stub("provision", {
      success: false,
      error: "RequestTimeoutError",
      failureCause: providerSocketFailure(),
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "error" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION, service);
      expect(res).toMatchObject({ retried: 0, failed: 1 });
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      const durableError = String(ctx.incrementSpy.mock.calls[0]?.[1]);
      expect(durableError).toContain("providerSocketFailure");
      expect(durableError).toContain("caused by:");
      expect(durableError).not.toContain("test-private-provider-secret");
      expect(ctx.retryLaterSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision retains the typed startup cause in the durable retry error", async () => {
    const service = new ProvisioningJobService({
      acquireProviderAdmission: async () => true,
      releaseProviderAdmission: async () => {},
    });
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION), service);
    const meshCause = new Error(
      "Docker candidate cannot complete required Headscale registration: auth_required",
    );
    stub("provision", {
      success: false,
      retryable: true,
      error: "Headscale routing is required, but no headscale_ip was registered",
      failureCause: new Error("Replacement cleanup is unresolved", { cause: meshCause }),
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION, service);
      expect(res).toMatchObject({ retried: 1, failed: 0 });
      const durableError = String(ctx.retryLaterSpy.mock.calls[0]?.[1]);
      expect(durableError).toContain("Replacement cleanup is unresolved");
      expect(durableError).toContain(
        "Docker candidate cannot complete required Headscale registration: auth_required",
      );
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision retains a non-retryable provider cause in the durable error", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    const providerCause = new Error("Docker provider readiness operation timed out");
    stub("provision", {
      success: false,
      error: "Sandbox health check timed out",
      failureCause: providerCause,
      sandboxRecord: {
        id: AGENT,
        organization_id: ORG,
        user_id: USER,
        status: "error",
      },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res).toMatchObject({ retried: 0, failed: 1 });
      expect(res.errors[0]?.error).toContain("Sandbox health check timed out");
      expect(res.errors[0]?.error).toContain("Docker provider readiness operation timed out");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision cleanup-only retry preserves the first startup failure", async () => {
    const service = new ProvisioningJobService({
      acquireProviderAdmission: async () => true,
      releaseProviderAdmission: async () => {},
    });
    const ctx = harness(
      makeJob(
        JOB_TYPES.AGENT_PROVISION,
        {},
        {
          result: {
            cloudAgentId: AGENT,
            status: "provisioning",
            error:
              "Sandbox health check timed out; replacement cleanup remains pending: first cleanup failure",
          },
          error:
            "RetryableProvisionTransportError: first startup failure\ncaused by: Error: Docker candidate cannot complete required Headscale registration: auth_required",
        },
      ),
      service,
    );
    stub("provision", {
      success: false,
      retryable: true,
      error: "Replacement cleanup is still pending: second cleanup failure",
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION, service);
      expect(res).toMatchObject({ retried: 1, failed: 0 });
      const preserved =
        "Sandbox health check timed out; replacement cleanup remains pending: second cleanup failure";
      expect(ctx.updateSpy.mock.calls[0]?.[1]?.result).toMatchObject({ error: preserved });
      const durableError = String(ctx.retryLaterSpy.mock.calls[0]?.[1]);
      expect(durableError).toBe(
        "RetryableProvisionTransportError: first startup failure\ncaused by: Error: Docker candidate cannot complete required Headscale registration: auth_required",
      );
      expect(durableError).not.toContain("second cleanup failure");
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision retryable transport settles when the database bound is exhausted", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION, {}, { retryable_requeues: 5 }));
    ctx.retryLaterSpy.mockImplementation(async (retrySnapshot) => ({
      ...retrySnapshot,
      status: "failed",
      retryable_requeues: 6,
      completed_at: new Date(),
    }));
    stub("provision", {
      success: false,
      retryable: true,
      error: "readiness probe transport_unresolved",
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res).toMatchObject({ retried: 0, failed: 1 });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
      expect(ctx.retryLaterSpy.mock.calls[0]?.[4]).toMatchObject({ maxRequeues: 5 });
      expect(typeof ctx.retryLaterSpy.mock.calls[0]?.[4]?.onExhaustedInTx).toBe("function");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_restart transient snapshot failure → requeued without burning an attempt", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_RESTART));
    stub("executeRestart", {
      success: false,
      retryable: true,
      containerStopped: false,
      containerStarted: false,
      error: "Refusing to stop without a current backup: Snapshot capture temporarily unavailable",
    });
    try {
      const res = await run(JOB_TYPES.AGENT_RESTART);
      expect(res).toMatchObject({ retried: 1, failed: 0 });
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.retryLaterSpy.mock.calls[0]?.[1]).toContain(
        "Snapshot capture temporarily unavailable",
      );
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("retryable transport lost to another worker is not reported as requeued", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    ctx.retryLaterSpy.mockResolvedValue(undefined);
    stub("provision", {
      success: false,
      retryable: true,
      error: "readiness probe transport_unresolved",
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res).toMatchObject({ claimed: 1, retried: 0, failed: 0 });
      expect(ctx.retryLaterSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: ctx.job.id,
          result: expect.objectContaining({ error: "readiness probe transport_unresolved" }),
        }),
        expect.stringContaining("readiness probe transport_unresolved"),
        expect.any(Number),
        expect.any(String),
        expect.objectContaining({ maxRequeues: 5 }),
      );
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("warm-claim restart recovery is bounded and installs terminal cleanup writeback", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_RESTART));
    stub("executeRestart", {
      success: false,
      containerStopped: true,
      containerStarted: true,
      error: "Warm-claim credential recovery failed: source-key revocation unavailable",
    });
    try {
      const res = await run(JOB_TYPES.AGENT_RESTART);
      expect(res.retried).toBe(0);
      expect(res.failed).toBe(1);
      expect(ctx.retryLaterSpy).not.toHaveBeenCalled();
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      expect(typeof ctx.incrementSpy.mock.calls[0]?.[3]).toBe("function");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("auto snapshot of a stopped agent → completed-as-skipped, no retry", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "auto" }));
    const disarmGate = armSnapshotGateFor(JOB_TYPES.AGENT_SNAPSHOT);
    stub("executeSnapshot", { success: false, error: "Sandbox is not running" });
    try {
      const res = await run(JOB_TYPES.AGENT_SNAPSHOT);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        skipped: true,
        reason: "Sandbox is not running",
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      disarmGate();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_snapshot transient capture failure → requeued without burning an attempt", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "auto" }));
    const disarmGate = armSnapshotGateFor(JOB_TYPES.AGENT_SNAPSHOT);
    stub("executeSnapshot", {
      success: false,
      retryable: true,
      error: "Snapshot capture temporarily unavailable",
    });
    try {
      const res = await run(JOB_TYPES.AGENT_SNAPSHOT);
      expect(res).toMatchObject({ retried: 1, failed: 0 });
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.retryLaterSpy.mock.calls[0]?.[1]).toContain(
        "Snapshot capture temporarily unavailable",
      );
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      disarmGate();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_wake integrity-gate refusal → fails and preserves the sleeping row (no writeback)", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_WAKE, { restoreBackupId: "b1" }));
    stub("executeWake", {
      success: false,
      error: "restore integrity check failed",
      integrityFailure: {
        backupId: "b1",
        kind: "digest_mismatch",
        message: "backup digest does not match",
      },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_WAKE);
      expect(res.failed).toBe(1);
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      // AGENT_WAKE has no permanent-failure writeback callback.
      expect(ctx.incrementSpy.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("permanent-failure writeback is built for provision (dependent row flip) but not for suspend", async () => {
    const provCtx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    stub("provision", { success: false, error: "down", sandboxRecord: { status: "error" } });
    try {
      await run(JOB_TYPES.AGENT_PROVISION);
      // AGENT_PROVISION supplies an onFailedInTx callback (arg 4) so the sandbox
      // row can flip to `error` atomically with the job's terminal write.
      expect(typeof provCtx.incrementSpy.mock.calls[0]?.[3]).toBe("function");
    } finally {
      provCtx.claimSpy.mockRestore();
      provCtx.recoverSpy.mockRestore();
      provCtx.updateStatusSpy.mockRestore();
      provCtx.updateSpy.mockRestore();
      provCtx.incrementSpy.mockRestore();
      provCtx.retryLaterSpy.mockRestore();
    }

    const suspendCtx = harness(makeJob(JOB_TYPES.AGENT_SUSPEND));
    stub("executeSuspend", { success: false, error: "down" });
    try {
      await run(JOB_TYPES.AGENT_SUSPEND);
      // AGENT_SUSPEND has no dependent row to flip → no writeback callback.
      expect(suspendCtx.incrementSpy.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      suspendCtx.claimSpy.mockRestore();
      suspendCtx.recoverSpy.mockRestore();
      suspendCtx.updateStatusSpy.mockRestore();
      suspendCtx.updateSpy.mockRestore();
      suspendCtx.incrementSpy.mockRestore();
      suspendCtx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_upgrade permanent failure classified genuinely-dead builds a terminal writeback", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_UPGRADE, {
        dockerImage: "eliza/agent",
        fromDigest: "sha256:old",
        toDigest: "sha256:new",
      }),
    );
    // rolledBack:false → executeAgentUpgrade throws UpgradeFailedError({rolledBack:false}),
    // and buildPermanentFailureWriteback returns the terminal `status:error` branch.
    stub("executeUpgrade", { success: false, error: "agent not serving", rolledBack: false });
    try {
      const res = await run(JOB_TYPES.AGENT_UPGRADE);
      expect(res.failed).toBe(1);
      expect(typeof ctx.incrementSpy.mock.calls[0]?.[3]).toBe("function");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent-not-found from any lifecycle call → terminal no-op, attempt not burned", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_RESTART));
    stub("executeRestart", { success: false, error: "Agent not found" });
    try {
      const res = await run(JOB_TYPES.AGENT_RESTART);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        skipped: true,
        reason: "Agent not found",
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision transport receives the job payload's own agentId/orgId — the contract the single-flight enqueue writes (#15943)", async () => {
    const restoreDirective = { kind: "fresh-boot" as const };
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION, { restoreDirective }));
    const provisionSpy = spyOn(elizaSandboxService, "provision").mockResolvedValue({
      success: true,
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "running" },
    } as never);
    serviceSpies.push(provisionSpy);
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res.succeeded).toBe(1);
      // The dispatcher must hand the executor the ids from job.data — the
      // exact fields enqueueAgentProvisionOnce / enqueueAgentProvisionOnceInTx
      // persist. Drift here would provision the wrong agent (or nothing) for
      // every tier-upgrade target minted through the atomic boundary.
      expect(provisionSpy).toHaveBeenCalledTimes(1);
      expect(provisionSpy.mock.calls[0]?.[0]).toBe(AGENT);
      expect(provisionSpy.mock.calls[0]?.[1]).toBe(ORG);
      expect(provisionSpy.mock.calls[0]?.[2]).toEqual(restoreDirective);
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_provision keeps deletion fenced after provider resolution until job settlement commits", async () => {
    let admissionLive = false;
    let markSettlementStarted: (() => void) | undefined;
    let commitSettlement: (() => void) | undefined;
    const settlementStarted = new Promise<void>((resolve) => {
      markSettlementStarted = resolve;
    });
    const settlementCommitted = new Promise<void>((resolve) => {
      commitSettlement = resolve;
    });
    const service = new ProvisioningJobService({
      acquireProviderAdmission: async () => {
        admissionLive = true;
        return true;
      },
      releaseProviderAdmission: async () => {
        admissionLive = false;
      },
    });
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION), service);
    ctx.updateStatusSpy.mockImplementation(async () => {
      markSettlementStarted?.();
      await settlementCommitted;
      return true;
    });
    const provisionSpy = spyOn(elizaSandboxService, "provision").mockResolvedValue({
      success: true,
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "running" },
      bridgeUrl: "https://bridge.invalid",
      healthUrl: "https://health.invalid",
    } as never);
    serviceSpies.push(provisionSpy);
    const activateDeletion = () => (admissionLive ? "provider_work_in_flight" : "activated");

    try {
      const processing = run(JOB_TYPES.AGENT_PROVISION, service);
      await settlementStarted;
      expect(activateDeletion()).toBe("provider_work_in_flight");
      commitSettlement?.();
      await expect(processing).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(activateDeletion()).toBe("activated");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_suspend dispatch recovers the durable revision omitted by a user envelope", async () => {
    const job = makeJob(JOB_TYPES.AGENT_SUSPEND);
    const ctx = harness(job, defaultDispatchService, {
      authorization: "user_request",
      lifecycleRevision: 7,
    });
    const suspendSpy = stub("executeSuspend", { success: true, containerStopped: true });
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(suspendSpy).toHaveBeenCalledWith(AGENT, ORG, job.id, "user_request", 7);
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  for (const jobType of [JOB_TYPES.AGENT_RESUME, JOB_TYPES.AGENT_WAKE] as const) {
    test(`${jobType} keeps deletion fenced through provider response and durable settlement`, async () => {
      const arm = AGENT_ARMS.find((candidate) => candidate.type === jobType);
      if (!arm) throw new Error(`Missing dispatch fixture for ${jobType}`);
      let admissionLive = false;
      let markSettlementStarted: (() => void) | undefined;
      let commitSettlement: (() => void) | undefined;
      const settlementStarted = new Promise<void>((resolve) => {
        markSettlementStarted = resolve;
      });
      const settlementCommitted = new Promise<void>((resolve) => {
        commitSettlement = resolve;
      });
      const service = new ProvisioningJobService({
        acquireProviderAdmission: async (authority) => {
          expect(authority).toEqual({
            organizationId: ORG,
            operationKind: "agent_lifecycle",
            operationId: "44444444-4444-4444-8444-444444444444",
          });
          admissionLive = true;
          return true;
        },
        releaseProviderAdmission: async () => {
          admissionLive = false;
        },
      });
      const ctx = harness(makeJob(jobType, arm.data), service);
      ctx.updateStatusSpy.mockImplementation(async () => {
        markSettlementStarted?.();
        await settlementCommitted;
        return true;
      });
      const providerSpy = stub(arm.method, arm.success);

      try {
        const processing = run(jobType, service);
        await settlementStarted;
        expect(providerSpy).toHaveBeenCalledTimes(1);
        expect(admissionLive).toBe(true);
        commitSettlement?.();
        await expect(processing).resolves.toMatchObject({ succeeded: 1, failed: 0 });
        expect(admissionLive).toBe(false);
      } finally {
        ctx.claimSpy.mockRestore();
        ctx.recoverSpy.mockRestore();
        ctx.updateStatusSpy.mockRestore();
        ctx.updateSpy.mockRestore();
        ctx.incrementSpy.mockRestore();
        ctx.retryLaterSpy.mockRestore();
      }
    });
  }

  test("agent_suspend dispatch honors a billing intent promoted to user authority", async () => {
    const job = makeJob(JOB_TYPES.AGENT_SUSPEND, { authorization: "billing_request" });
    const ctx = harness(job, defaultDispatchService, {
      authorization: "user_request",
      lifecycleRevision: 9,
    });
    const suspendSpy = stub("executeSuspend", { success: true, containerStopped: true });
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res).toMatchObject({ succeeded: 1, failed: 0, retried: 0 });
      expect(suspendSpy).toHaveBeenCalledWith(AGENT, ORG, job.id, "user_request", 9);
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("organization-id mismatch between payload and column fails before any transport call", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_SUSPEND, { organizationId: "99999999-9999-4999-8999-999999999999" }),
    );
    const svcSpy = spyOn(elizaSandboxService, "executeSuspend").mockResolvedValue({
      success: true,
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res.failed).toBe(1);
      // The guard throws before delegating to the transport.
      expect(svcSpy).not.toHaveBeenCalled();
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
    } finally {
      svcSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("a stale generation cannot enter the lifecycle mutation boundary", async () => {
    const job = makeJob(JOB_TYPES.AGENT_SUSPEND);
    const ctx = harness(job);
    ctx.leaseSpy.mockRejectedValueOnce(new StaleJobExecutionError(job.id));
    const suspendSpy = spyOn(elizaSandboxService, "executeSuspend").mockResolvedValue({
      success: true,
      containerStopped: true,
    });
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res.failed).toBe(1);
      expect(suspendSpy).not.toHaveBeenCalled();
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
    } finally {
      suspendSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("transient completion settlement failure is supervised without reclaiming the job", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_SUSPEND));
    stub("executeSuspend", { success: true, containerStopped: true });
    ctx.updateStatusSpy
      .mockRejectedValueOnce(new Error("temporary database disconnect"))
      .mockResolvedValue(true);
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      expect(ctx.updateStatusSpy).toHaveBeenCalledTimes(2);
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("transient attempt settlement failure retries in-process without startup recovery", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_SUSPEND));
    stub("executeSuspend", { success: false, containerStopped: false, error: "provider failed" });
    ctx.incrementSpy
      .mockRejectedValueOnce(new Error("temporary database disconnect"))
      .mockResolvedValue(undefined);
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res.failed).toBe(1);
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(2);
      expect(ctx.recoverSpy).toHaveBeenCalledTimes(1);
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("an unrecognized job type hits the dispatch default and fails the job", async () => {
    const ctx = harness(makeJob("agent_teleport"));
    try {
      const res = await run("agent_teleport");
      expect(res.claimed).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors[0]?.error).toContain("Unknown job type");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});
