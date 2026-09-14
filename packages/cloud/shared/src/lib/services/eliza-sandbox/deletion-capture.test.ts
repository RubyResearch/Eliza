/** Exercises sandbox deletion capture contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { SandboxDeletion } from "./lifecycle/deletion.js";
import { customSandbox } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxTransactions,
} from "./test-support/database.js";
import { installReplacementLifecycleSimulation } from "./test-support/replacement.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  restoreReplacement = await installReplacementLifecycleSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
// Orphaned shared-runtime history on delete is covered at the repository level
// in shared-runtime-history.test.ts: the post-commit deletion is a best-effort
// call to sharedRuntimeHistoryRepository.deleteByAgent.

// Fail-closed pre-deletion capture (#18517): deleteAgent mirrors shutdown's
// pre-stop discipline — a live dedicated agent is never deleted without a
// current backup, and a refusal happens BEFORE deletion intent is stamped so
// the reconciler cannot re-arm a delete that skipped the capture.
describe("ElizaSandboxService.deleteAgent fail-closed pre-deletion capture (#18517)", () => {
  type CaptureSpyTarget = {
    getAgentForWrite: (agentId: string, orgId: string) => Promise<unknown>;
    fetchSnapshotState: (rec: unknown) => Promise<unknown>;
    prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
    persistSnapshotWithinTransaction: (
      ...args: unknown[]
    ) => Promise<{ backupId: string; lifecycleRevision: number }>;
    lockLifecycle: (...args: unknown[]) => Promise<void>;
    getAgentForLifecycleMutation: (...args: unknown[]) => Promise<unknown>;
    hasActiveProvisionJobTx: (...args: unknown[]) => Promise<boolean>;
    hasActiveReplacementJobTx: (...args: unknown[]) => Promise<boolean>;
  };

  async function makeCaptureSvc() {
    const mod = await import("../eliza-sandbox.ts?actual");
    const svc = new mod.ElizaSandboxService();
    return { mod, svc, spyTarget: svc as unknown as CaptureSpyTarget };
  }

  test("a failing pre-deletion capture refuses the delete before deletion intent", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge returned 500"),
    );
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete");
    try {
      const result = await svc.deleteAgent(rec.id, rec.organization_id, {
        authorization: "user_request",
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toContain(
        "Refusing to delete without a current backup",
      );
      expect(result.success === false && result.error).toContain("bridge returned 500");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an explicit state-loss acknowledgement binds a capture waiver to this generation", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("available-memory budget exceeded"),
    );
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, {
          authorization: "user_request",
          stateLossAcknowledged: true,
        }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: rec,
        captureWaiverGeneration: {
          bridgeUrl: rec.bridge_url,
          environmentRevision: rec.environment_revision,
          sandboxId: rec.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a transient capture failure refuses the delete with the transient message", async () => {
    const { mod, svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(mod.SNAPSHOT_CAPTURE_TRANSIENT),
    );
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete");
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({
        success: false,
        retryable: true,
        error: `Refusing to delete without a current backup: ${mod.SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an image without a snapshot endpoint proceeds, flagged as capture-unsupported", async () => {
    const { mod, svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(mod.SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: rec,
        captureWaiverGeneration: {
          bridgeUrl: rec.bridge_url,
          environmentRevision: rec.environment_revision,
          sandboxId: rec.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a persisted no-snapshot waiver lets the same deletion retry converge", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      pre_delete_capture_waiver_attempt_id: deletionAttemptId,
      pre_delete_capture_waiver_environment_revision: 0,
      pre_delete_capture_waiver_sandbox_id: "sandbox-e06bb509",
      pre_delete_capture_waiver_bridge_url: "https://legacy-bridge.example",
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: true,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a no-snapshot waiver does not survive a bridge generation change", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const live = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      bridge_url: "https://replacement-bridge.example",
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      pre_delete_capture_waiver_attempt_id: deletionAttemptId,
      pre_delete_capture_waiver_environment_revision: 0,
      pre_delete_capture_waiver_sandbox_id: "sandbox-e06bb509",
      pre_delete_capture_waiver_bridge_url: "https://legacy-bridge.example",
    };
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: null,
          captureAuthority: null,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: true,
          existingBackup: null,
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
      });
      expect(update).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("a data-bearing error row with no reachable bridge fails closed", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = { ...customSandbox(), status: "error" as const, bridge_url: null };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete");
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({
        success: false,
        error:
          "Refusing to delete without a current backup: the agent's container has no reachable bridge to capture from",
      });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an acknowledged retry with no reachable bridge is fenced to that exact generation", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_failed" as const,
      bridge_url: null,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, {
          authorization: "user_request",
          stateLossAcknowledged: true,
        }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: rec,
        captureWaiverGeneration: {
          bridgeUrl: null,
          environmentRevision: rec.environment_revision,
          sandboxId: rec.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a stopped-origin deletion continuation does not recapture a dead container", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      bridge_url: null,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      deletion_allocation_counted: false,
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("shared-tier rows skip the capture entirely", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = { ...customSandbox(), execution_tier: "shared" as const };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("the primary v1 path (row already deletion_pending at enqueue) still captures", async () => {
    // The v1 DELETE route stamps `deletion_pending` at enqueue time and only
    // later runs deleteAgent from the job worker — the container is still
    // live, so the capture must fire there too, not only on the synchronous
    // compat path that still sees `running`.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge unreachable"),
    );
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete");
    try {
      const result = await svc.deleteAgent(rec.id, rec.organization_id, {
        authorization: "user_request",
      });
      expect(fetchSnap).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toContain(
        "Refusing to delete without a current backup",
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a deletion retry with a capture already persisted for this intent skips re-capturing", async () => {
    // After a successful capture the teardown may still fail; the retry then
    // faces a dead bridge and must not refuse forever — the pre-delete backup
    // taken at or after this deletion's start already satisfies the guarantee.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue({
      id: priorBackupId,
      created_at: new Date("2026-08-13T00:05:00.000Z"),
    } as never);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: {
          id: priorBackupId,
          deletionAttemptId: rec.deletion_attempt_id,
        },
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an unauthorized delete of a running agent never pays the capture round-trip", async () => {
    // The pre-existing running-row gate refuses unauthorized deletes anyway,
    // so a capture (or a capture OUTAGE) must not run first — the caller keeps
    // the original "suspend it before deletion" refusal, covered by the
    // teardown-cap tests above.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "Agent is running; suspend it before deletion",
    });
    try {
      await expect(svc.deleteAgent(rec.id, rec.organization_id)).resolves.toEqual({
        success: false,
        error: "Agent is running; suspend it before deletion",
      });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("account deletion does not create a new backup of data being erased", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, {
          authorization: "account_deletion",
        }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "account_deletion", {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("the reconciler's unauthorized re-enqueue of a deletion_pending row still captures", async () => {
    // ProvisioningJobService.reEnqueueFailedDeletions re-arms stuck deletes with
    // NO authorization (the original job's grant is not carried through). Gating
    // phase 0 on `options.authorization` sent those jobs into prepareAgentDelete
    // with `snapshot: null` against a capture-requiring row, so every attempt was
    // refused as "lifecycle generation moved" — deadlocking exactly the stuck
    // deletions this guard protects. Only the still-`running` unauthorized case
    // may skip the capture.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const snapshot = {
      stateData: { tables: { memories: 1 } },
      sizeBytes: 21,
      bridgeUrl: rec.bridge_url as string,
    };
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockResolvedValue(snapshot);
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot,
        captureAuthority: rec,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("prepareAgentDelete refuses when the lifecycle generation moved after the capture", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: {
            stateData: { tables: {} },
            sizeBytes: 12,
            bridgeUrl: "https://a-different-generation.example",
          },
          captureAuthority: live,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: null,
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test.each([
    ["status", "disconnected"],
    ["node_id", "replacement-node"],
    ["container_name", "replacement-container"],
    ["health_url", "https://replacement.example/api"],
  ] as const)(
    "prepareAgentDelete refuses when captured %s changes under the lifecycle lock",
    async (field, replacement) => {
      const { svc, spyTarget } = await makeCaptureSvc();
      const captured = customSandbox();
      const locked = { ...captured, [field]: replacement };
      const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
      const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(
        locked,
      );
      const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
      const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
        false,
      );
      const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
      const update = mock(() => ({
        set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
      }));
      sandboxTransactions.implementation = async (fn) =>
        fn({
          execute: async () => ({ rows: [] }),
          update,
          select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
        });
      try {
        await expect(
          (
            svc as unknown as {
              prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
            }
          ).prepareAgentDelete(captured.id, captured.organization_id, "user_request", {
            snapshot: {
              stateData: { tables: {} },
              sizeBytes: 12,
              bridgeUrl: captured.bridge_url,
            },
            captureAuthority: captured,
            captureWaiverGeneration: null,
            captureWaiverAlreadyPersisted: false,
            existingBackup: null,
          }),
        ).resolves.toEqual({
          ok: false,
          error:
            "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
        });
        expect(persist).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      } finally {
        sandboxTransactions.implementation = null;
        lockLifecycle.mockRestore();
        getForMutation.mockRestore();
        activeProvision.mockRestore();
        activeReplacement.mockRestore();
        persist.mockRestore();
      }
    },
  );

  test("prepareAgentDelete persists the pre-delete snapshot inside the deletion transaction", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persistedBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const order: string[] = [];
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction").mockImplementation(
      async () => {
        order.push("backup");
        return { backupId: persistedBackupId, lifecycleRevision: 8 };
      },
    );
    const stateData = { tables: { memories: 3 } };
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => {
            order.push("intent");
            return [
              {
                id: live.id,
                deletionAttemptId: "attempt-18517",
                deletionStartedAt: new Date(),
                lifecycleRevision: 7,
              },
            ];
          }),
        })),
      })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      const result = (await (
        svc as unknown as {
          prepareAgentDelete: (...args: unknown[]) => Promise<{ ok: boolean }>;
        }
      ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
        snapshot: { stateData, sizeBytes: 34, bridgeUrl: live.bridge_url as string },
        captureAuthority: live,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        preDeleteBackupId: persistedBackupId,
        lifecycleRevision: 8,
      });
      expect(order).toEqual(["intent", "backup"]);
      expect(persist).toHaveBeenCalledTimes(1);
      const call = persist.mock.calls[0] as unknown[];
      expect(call.slice(1)).toEqual([live.id, live.organization_id, "pre-delete", stateData, 34]);
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("prepareAgentDelete persists an unsupported-endpoint waiver for the exact generation", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const set = mock((values: Record<string, unknown>) => ({
      where: mock(() => ({
        returning: mock(async () => [
          {
            id: live.id,
            deletionAttemptId: values.deletion_attempt_id,
            deletionStartedAt: new Date(),
            lifecycleRevision: 7,
          },
        ]),
      })),
    }));
    const update = mock(() => ({ set }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      const result = (await (
        svc as unknown as {
          prepareAgentDelete: (...args: unknown[]) => Promise<{ ok: boolean }>;
        }
      ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: live,
        captureWaiverGeneration: {
          bridgeUrl: live.bridge_url,
          environmentRevision: live.environment_revision,
          sandboxId: live.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(persist).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          pre_delete_capture_waiver_attempt_id: expect.any(String),
          pre_delete_capture_waiver_environment_revision: live.environment_revision,
          pre_delete_capture_waiver_sandbox_id: live.sandbox_id,
          pre_delete_capture_waiver_bridge_url: live.bridge_url,
        }),
      );
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("prepareAgentDelete accepts an acknowledged absent-bridge generation without fabricating a persisted URL", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = {
      ...customSandbox(),
      status: "deletion_failed" as const,
      bridge_url: null,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const set = mock((values: Record<string, unknown>) => ({
      where: mock(() => ({
        returning: mock(async () => [
          {
            id: live.id,
            deletionAttemptId: live.deletion_attempt_id,
            deletionStartedAt: live.deletion_started_at,
            lifecycleRevision: 7,
          },
        ]),
      })),
    }));
    const update = mock(() => ({ set }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      const result = (await (
        svc as unknown as {
          prepareAgentDelete: (...args: unknown[]) => Promise<{ ok: boolean }>;
        }
      ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: live,
        captureWaiverGeneration: {
          bridgeUrl: null,
          environmentRevision: live.environment_revision,
          sandboxId: live.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(persist).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0]?.[0]).not.toHaveProperty("pre_delete_capture_waiver_bridge_url");
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("prepareAgentDelete revalidates an unlocked backup candidate under the lifecycle lock", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const backupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const live = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const validate = spyOn(
      agentSandboxesRepository,
      "validateAttachedPreDeleteBackupForDeletion",
    ).mockResolvedValue(true);
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [
            {
              id: live.id,
              deletionAttemptId,
              deletionStartedAt: live.deletion_started_at,
              lifecycleRevision: 7,
            },
          ]),
        })),
      })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: null,
          captureAuthority: null,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: { id: backupId, deletionAttemptId },
        }),
      ).resolves.toMatchObject({ ok: true, preDeleteBackupId: backupId });
      expect(validate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          backupId,
          sandboxRecordId: live.id,
          deletionStartedAt: live.deletion_started_at,
        }),
      );
      expect(persist).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      validate.mockRestore();
      persist.mockRestore();
    }
  });
});

// Reversible deletion_pending (#18517 suggestion 3): cancelAgentDeletion turns
// the one-way door back into a running row while the container is still alive
// — atomically cancelling queued agent_delete jobs so the reconciler has
// nothing to re-arm — and refuses whenever teardown may already have begun.
// Drives the transaction body against a fake lifecycle tx (mocked-database
// suite; the transaction wrapper itself is exercised by the PGlite lane).
describe("ElizaSandboxService.cancelAgentDeletion (#18517 reversibility)", () => {
  type CancelSpyTarget = {
    lockLifecycle: (...args: unknown[]) => Promise<void>;
    getAgentForLifecycleMutation: (...args: unknown[]) => Promise<unknown>;
    cancelAgentDeletionTx: (
      tx: unknown,
      agentId: string,
      orgId: string,
    ) => Promise<{ success: boolean; error?: string }>;
  };

  async function makeCancelSvc() {
    const mod = await import("../eliza-sandbox.ts?actual");
    const svc = new mod.ElizaSandboxService();
    return { svc, spyTarget: svc as unknown as CancelSpyTarget };
  }

  function pendingDeletionSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
    return {
      ...customSandbox(),
      status: "deletion_pending",
      deletion_attempt_id: "44444444-4444-4444-8444-444444444444",
      deletion_started_at: new Date("2026-08-14T00:00:00.000Z"),
      deletion_previous_status: "running",
      deletion_previous_billing_status: "active",
      deletion_previous_shutdown_warning_sent_at: null,
      deletion_previous_scheduled_shutdown_at: null,
      billing_status: "suspended",
      ...overrides,
    };
  }

  /** Fake LifecycleTx capturing each executed statement's rendered SQL + params. */
  function fakeCancelTx(results: Array<{ rows: Array<{ id: string }> }>) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    let call = 0;
    const tx = {
      execute: async (query: unknown) => {
        const rendered = new PgDialect().sqlToQuery(query as SQL);
        executed.push({ sql: rendered.sql.toLowerCase(), params: rendered.params });
        const result = results[call] ?? { rows: [] };
        call += 1;
        return result;
      },
    };
    return { tx, executed };
  }

  async function runCancel(
    rec: AgentSandbox | undefined,
    results: Array<{ rows: Array<{ id: string }> }>,
  ) {
    const { spyTarget } = await makeCancelSvc();
    const lock = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined as never);
    const getRec = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const { tx, executed } = fakeCancelTx(results);
    try {
      const outcome = await spyTarget.cancelAgentDeletionTx(
        tx,
        rec?.id ?? "missing-agent",
        rec?.organization_id ?? "org-x",
      );
      const lockCalls = lock.mock.calls.length;
      return { outcome, executed, lockCalls };
    } finally {
      lock.mockRestore();
      getRec.mockRestore();
    }
  }

  test("cancel-and-restore: queued job cancelled and the row returned to running, atomically", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed, lockCalls } = await runCancel(rec, [
      { rows: [] }, // no in_progress agent_delete job
      { rows: [] }, // pending-job cancellation
      { rows: [{ id: rec.id }] }, // row restore CAS
    ]);

    expect(outcome).toEqual({ success: true });
    expect(lockCalls).toBe(1);
    expect(executed).toHaveLength(3);
    // 1: only an in_progress agent_delete blocks cancellation.
    expect(executed[0]?.sql).toContain("'in_progress'");
    expect(executed[0]?.params).toContain("agent_delete");
    // 2: queued delete jobs are cancelled inside the same transaction.
    expect(executed[1]?.sql).toContain("status = 'cancelled'");
    expect(executed[1]?.sql).toContain("status = 'pending'");
    expect(executed[1]?.params).toContain("agent_delete");
    expect(executed[1]?.params).toContain(rec.id);
    // 3: the restore clears every deletion-intent column and reactivates billing,
    // CAS-guarded on the observed status + attempt id.
    const restore = executed[2];
    expect(restore?.params).toContain("running");
    expect(restore?.params).toContain("active");
    expect(restore?.sql).toContain("deletion_attempt_id = null");
    expect(restore?.sql).toContain("deletion_started_at = null");
    expect(restore?.sql).toContain("deletion_previous_status = null");
    expect(restore?.sql).toContain("deletion_previous_billing_status = null");
    expect(restore?.sql).toContain("deletion_previous_shutdown_warning_sent_at = null");
    expect(restore?.sql).toContain("deletion_previous_scheduled_shutdown_at = null");
    expect(restore?.sql).toContain("deletion_allocation_counted = null");
    expect(restore?.sql).toContain("status = 'deletion_pending'");
    expect(restore?.params).toContain(rec.deletion_attempt_id);
  });

  test("refuses while an agent_delete job is executing — teardown may already be running", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed } = await runCancel(rec, [{ rows: [{ id: "job-1" }] }]);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("already executing");
    // Nothing was cancelled and nothing was restored.
    expect(executed).toHaveLength(1);
  });

  test("refuses when the bridge is gone — no live workload for `running` to describe", async () => {
    const rec = pendingDeletionSandbox({ bridge_url: null });
    const { outcome, executed } = await runCancel(rec, []);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("no longer reachable");
    expect(executed).toHaveLength(0);
  });

  test("restores the captured billing warning and shutdown schedule instead of guessing healthy defaults", async () => {
    const warningSentAt = new Date("2026-08-13T10:00:00.000Z");
    const shutdownAt = new Date("2026-08-16T10:00:00.000Z");
    const rec = pendingDeletionSandbox({
      deletion_previous_billing_status: "warning",
      deletion_previous_shutdown_warning_sent_at: warningSentAt,
      deletion_previous_scheduled_shutdown_at: shutdownAt,
    });
    const { outcome, executed } = await runCancel(rec, [
      { rows: [] },
      { rows: [] },
      { rows: [{ id: rec.id }] },
    ]);

    expect(outcome).toEqual({ success: true });
    expect(executed[2]?.params).toContain("warning");
    expect(executed[2]?.params).toContain(warningSentAt);
    expect(executed[2]?.params).toContain(shutdownAt);
  });

  test("refuses legacy deletion rows that have no prior-state receipt", async () => {
    const rec = pendingDeletionSandbox({
      deletion_previous_status: null,
      deletion_previous_billing_status: null,
    });
    const { outcome, executed } = await runCancel(rec, []);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("reversible running-state receipt");
    expect(executed).toHaveLength(0);
  });

  test("refuses rows that are not deletion_pending (running and deletion_failed unchanged)", async () => {
    for (const status of ["running", "deletion_failed"] as const) {
      const rec = pendingDeletionSandbox({ status });
      const { outcome, executed } = await runCancel(rec, []);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("not pending deletion");
      expect(executed).toHaveLength(0);
    }
  });

  test("missing rows refuse without touching jobs", async () => {
    const { outcome, executed } = await runCancel(undefined, []);
    expect(outcome).toEqual({ success: false, error: "Agent not found" });
    expect(executed).toHaveLength(0);
  });

  test("a concurrent ownership move fails the CAS instead of overwriting", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed } = await runCancel(rec, [
      { rows: [] },
      { rows: [] },
      { rows: [] }, // CAS matched nothing: attempt id / status moved underneath
    ]);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("ownership changed");
    expect(executed).toHaveLength(3);
  });
});
