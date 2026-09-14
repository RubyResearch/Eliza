/** Exercises sandbox replacement contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import {
  type SandboxProvider,
  SandboxReplacementCleanupUnresolvedError,
} from "../sandbox-provider-types";
import { SandboxLifecycleAuthority } from "./lifecycle/authority.js";
import { SandboxPower } from "./lifecycle/power.js";
import { customSandbox } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { type StoredAgentSandboxBackup } from "../../../db/schemas/agent-sandboxes";
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
describe("ElizaSandboxService unresolved replacement fence authority", () => {
  for (const executionTier of ["shared", "future-container-tier"] as const) {
    test(`rejects ${executionTier} observed under the lock before enrichment CAS`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const current: AgentSandbox = {
        ...customSandbox(),
        execution_tier: executionTier as AgentSandbox["execution_tier"],
        replacement_cleanup_sandbox_id: "replacement-sandbox",
        replacement_cleanup_node_id: "replacement-node",
        replacement_cleanup_container_name: "replacement-container",
        replacement_cleanup_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: null,
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-08-24T00:00:00.000Z"),
      };
      const unresolved = new SandboxReplacementCleanupUnresolvedError(
        {
          sandboxId: "replacement-sandbox",
          nodeId: "replacement-node",
          containerName: "replacement-container",
          replacementAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          containerId: "sha256:resolved-after-error",
          allocationCounted: true,
        },
        new Error("node transport unresolved"),
      );
      type FenceService = {
        persistUnresolvedReplacementCleanupFence(
          agentId: string,
          orgId: string,
          error: SandboxReplacementCleanupUnresolvedError,
        ): Promise<void>;
        lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
        getAgentForLifecycleMutation(
          tx: unknown,
          agentId: string,
          orgId: string,
        ): Promise<AgentSandbox | undefined>;
      };
      const svc = new ElizaSandboxService() as unknown as FenceService;
      const lock = spyOn(SandboxLifecycleAuthority.prototype, "lockLifecycle").mockResolvedValue(
        undefined,
      );
      const read = spyOn(
        SandboxLifecycleAuthority.prototype,
        "getAgentForLifecycleMutation",
      ).mockResolvedValue(current);
      let rawWrites = 0;
      sandboxTransactions.implementation = async (fn) =>
        fn({
          execute: async () => {
            rawWrites += 1;
            return { rows: [] };
          },
        });
      try {
        await expect(
          svc.persistUnresolvedReplacementCleanupFence(
            current.id,
            current.organization_id,
            unresolved,
          ),
        ).rejects.toThrow("requires a container-backed execution tier");
        expect(rawWrites).toBe(0);
      } finally {
        sandboxTransactions.implementation = null;
        lock.mockRestore();
        read.mockRestore();
      }
    });
  }
});

describe("replacement lifecycle teardown is absence-proof", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  function claimedPendingRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "pending",
      sandbox_id: "warm-live-container",
      node_id: "unreachable-node",
      container_name: "warm-live-container",
      bridge_url: null,
      health_url: null,
    };
  }

  test("restart on an unreachable old node preserves the handle and never provisions", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = claimedPendingRow();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    type LifecycleSvc = {
      executeRestart(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: boolean;
        error?: string;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
      provision(agentId: string, orgId: string): Promise<unknown>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as LifecycleSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycleSpy = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeJob = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const provision = spyOn(svc, "provision");
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = await svc.executeRestart(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Failed to prove the previous sandbox stopped",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      getForWrite.mockRestore();
      lockLifecycleSpy.mockRestore();
      getForMutation.mockRestore();
      activeJob.mockRestore();
      provision.mockRestore();
    }
  });

  test("legacy warm recovery with no compute handle reaches cold provision", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "provisioning",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("provision is spied");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type RestartSvc = {
      executeRestart(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: boolean;
        containerStopped: boolean;
        containerStarted: boolean;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
      provision(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: true;
        sandboxRecord: AgentSandbox;
        bridgeUrl: string;
        healthUrl: string;
      }>;
      recoverPendingWarmClaimInferenceKey(
        agentId: string,
        orgId: string,
      ): Promise<{ pushed: boolean }>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as RestartSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeProvision = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const provision = spyOn(svc, "provision").mockResolvedValue({
      success: true,
      sandboxRecord: { ...rec, status: "running" },
      bridgeUrl: "https://replacement.example",
      healthUrl: "https://replacement.example/api",
    });
    const recoverCredential = spyOn(svc, "recoverPendingWarmClaimInferenceKey").mockResolvedValue({
      pushed: true,
    });
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = await svc.executeRestart(AGENT, ORG);
      expect(result).toEqual({
        success: true,
        containerStopped: true,
        containerStarted: true,
        bridgeUrl: "https://replacement.example",
        healthUrl: "https://replacement.example/api",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
      expect(provision).toHaveBeenCalledWith(AGENT, ORG, undefined);
      expect(recoverCredential).toHaveBeenCalledWith(AGENT, ORG);
    } finally {
      sandboxTransactions.implementation = null;
      getForWrite.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      provision.mockRestore();
      recoverCredential.mockRestore();
    }
  });

  test("legacy warm recovery with a partial locator fails closed", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "provisioning",
      sandbox_id: null,
      node_id: "orphan-node",
      container_name: null,
      bridge_url: null,
      health_url: null,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type ShutdownSvc = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as ShutdownSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeProvision = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      expect(await svc.shutdown(AGENT, ORG)).toEqual({
        success: false,
        error: "Warm-claim recovery locator is incomplete",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      getForWrite.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
    }
  });

  test("suspend on an unreachable old node does not write stopped state", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = claimedPendingRow();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    type SuspendSvc = {
      executeSuspend(
        agentId: string,
        orgId: string,
        jobId: string,
      ): Promise<{
        success: boolean;
        containerStopped: boolean;
        backupId?: string;
        error?: string;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      prepareSuspendBackupGate(
        rec: AgentSandbox,
      ): Promise<
        | { outcome: "skip" }
        | { outcome: "proceed"; backupId?: string; capturedFresh: boolean }
        | { outcome: "refuse"; error: string }
      >;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as SuspendSvc;
    const getForWriteSpy = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    const lockLifecycleSpy = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeJob = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const writes: unknown[] = [];
    let selectCount = 0;
    sandboxTransactions.implementation = async (fn) => {
      const tx = {
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: async () => {
                  selectCount += 1;
                  if (selectCount === 1) {
                    return [
                      {
                        id: "00000000-0000-0000-0000-000000000098",
                        organization_id: ORG,
                        agent_id: AGENT,
                        lifecycle_revision: rec.lifecycle_revision,
                        status: "pending",
                        job_id: "00000000-0000-0000-0000-000000000099",
                        attempts: 0,
                      },
                    ];
                  }
                  return [{ credit_balance: "0" }];
                },
              }),
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: async () => [] }) }),
      };
      return fn(tx);
    };

    try {
      const result = await svc.executeSuspend(AGENT, ORG, "00000000-0000-0000-0000-000000000099");
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "old node unreachable",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      getForWriteSpy.mockRestore();
      gateSpy.mockRestore();
      lockLifecycleSpy.mockRestore();
      getForMutation.mockRestore();
      activeJob.mockRestore();
    }
  });

  // Pre-suspend backup gate (#20726 item 6): the provider stop drops the
  // container, so suspend must prove a durable backup first, exactly like
  // sleep and delete. These tests drive the real gate with a mocked bridge
  // capture and repository fixtures.
  type SuspendGateSvc = {
    executeSleep(
      agentId: string,
      orgId: string,
    ): Promise<{
      success: boolean;
      containerRemoved: boolean;
      error?: string;
    }>;
    executeSuspend(
      agentId: string,
      orgId: string,
      jobId: string,
      authorization?: "user_request" | "billing_request",
      expectedLifecycleRevision?: number,
    ): Promise<{
      success: boolean;
      containerStopped: boolean;
      backupId?: string;
      error?: string;
      skipped?: boolean;
      reason?: string;
    }>;
    prepareSuspendBackupGate(rec: AgentSandbox): Promise<
      | { outcome: "skip" }
      | {
          outcome: "proceed";
          backupId?: string;
          capturedFresh: boolean;
          pendingSnapshot?: { stateData: unknown; sizeBytes: number };
        }
      | { outcome: "refuse"; error: string }
    >;
    revalidateContainerBackedLifecycleGeneration(
      rec: AgentSandbox,
      action: string,
    ): Promise<AgentSandbox | undefined>;
    getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
    fetchSnapshotState(
      rec: AgentSandbox,
    ): Promise<{ stateData: unknown; sizeBytes: number; bridgeUrl: string }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    persistSnapshotWithinTransaction(
      tx: unknown,
      sandboxRecordId: string,
      organizationId: string,
      type: string,
      stateData: unknown,
      sizeBytes: number,
    ): Promise<{ backupId: string; lifecycleRevision: number }>;
  };

  function bridgedRunningRow(): AgentSandbox {
    return {
      ...claimedPendingRow(),
      bridge_url: "https://bridge.example",
      health_url: "https://bridge.example/api",
    };
  }

  async function suspendSvc(
    rec: AgentSandbox,
    provider: SandboxProvider,
    lockedRec: AgentSandbox = rec,
  ) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService(provider) as unknown as SuspendGateSvc;
    const spies = [
      spyOn(svc, "getAgentForWrite").mockResolvedValue(rec),
      spyOn(svc, "revalidateContainerBackedLifecycleGeneration").mockResolvedValue(rec),
      spyOn(SandboxLifecycleAuthority.prototype, "lockLifecycle").mockResolvedValue(undefined),
      spyOn(SandboxLifecycleAuthority.prototype, "getAgentForLifecycleMutation").mockResolvedValue(
        lockedRec,
      ),
      spyOn(SandboxLifecycleAuthority.prototype, "hasActiveProvisionJobTx").mockResolvedValue(
        false,
      ),
    ];
    const previousTransaction = sandboxTransactions.implementation;
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          throw new Error("Unexpected write before the backup gate");
        },
      });
    return {
      svc,
      restore: () => {
        sandboxTransactions.implementation = previousTransaction;
        spies.forEach((s) => s.mockRestore());
      },
    };
  }

  function stoppableProvider(): SandboxProvider {
    return {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
  }

  const SUSPEND_JOB = "00000000-0000-0000-0000-000000000099";

  test("a funded user suspend settles compute and keeps its fresh backup billable", async () => {
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockResolvedValue({
      stateData: { memories: [] },
      sizeBytes: 42,
      bridgeUrl: rec.bridge_url as string,
    });
    const persistSpy = spyOn(svc, "persistSnapshotWithinTransaction").mockResolvedValue({
      backupId: "backup-fresh",
      lifecycleRevision: rec.lifecycle_revision + 1,
    });
    const createSpy = spyOn(agentSandboxesRepository, "createBackup");
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(undefined);
    const writes: SQL[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      billing.settleLifecycleBillingInTransactionSpy.mockClear();
      billing.settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
        status: "billed",
        amount: 0.01,
      });
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({ success: true, containerStopped: true, backupId: "backup-fresh" });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(persistSpy).toHaveBeenCalledWith(
        expect.anything(),
        rec.id,
        rec.organization_id,
        "pre-shutdown",
        { memories: [] },
        42,
      );
      expect(createSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 10);
      expect(billing.settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
      );
      expect(writes).toHaveLength(1);
      const query = new PgDialect().sqlToQuery(writes[0]);
      const rendered = query.sql;
      expect(rendered).toContain("last_backup_at = NOW()");
      expect(query.params).toContain("active");
    } finally {
      sandboxTransactions.implementation = null;
      fetchSpy.mockRestore();
      persistSpy.mockRestore();
      createSpy.mockRestore();
      pruneSpy.mockRestore();
      restore();
    }
  });

  test("suspend defers on a transient capture signal without touching compute", async () => {
    const { SNAPSHOT_CAPTURE_TRANSIENT } = await import("../eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_CAPTURE_TRANSIENT),
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });

  test("a no-snapshot-endpoint image refuses to stop even with a verified backup", async () => {
    const { SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import("../eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue({
      id: "backup-proven",
      sandbox_record_id: rec.id,
      snapshot_type: "scheduled",
      created_at: new Date(),
      verification_status: "verified",
      verified_at: new Date(),
      verification_error: null,
    } as StoredAgentSandboxBackup);
    const writes: SQL[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_ENDPOINT_UNSUPPORTED}`,
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      fetchSpy.mockRestore();
      latestSpy.mockRestore();
      restore();
    }
  });

  test("a no-snapshot-endpoint image with no durable backup refuses to suspend", async () => {
    const { SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import("../eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      undefined,
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_ENDPOINT_UNSUPPORTED}`,
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      latestSpy.mockRestore();
      restore();
    }
  });

  test.each(["suspend", "sleep"] as const)(
    "%s capture failure refuses to stop even when an older backup is verified",
    async (operation) => {
      const rec = bridgedRunningRow();
      const provider = stoppableProvider();
      const { svc, restore } = await suspendSvc(rec, provider);
      const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
        new Error("Snapshot fetch failed: HTTP 500 Snapshot failed"),
      );
      const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue({
        id: "backup-proven",
        sandbox_record_id: rec.id,
        snapshot_type: "scheduled",
        created_at: new Date(),
        verification_status: "verified",
        verified_at: new Date(),
        verification_error: null,
      } as StoredAgentSandboxBackup);
      const writes: SQL[] = [];
      sandboxTransactions.implementation = async (fn) =>
        fn({
          execute: async (query) => {
            writes.push(query as SQL);
            return { rows: [] };
          },
        });
      try {
        const result =
          operation === "suspend"
            ? await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)
            : await svc.executeSleep(AGENT, ORG);
        expect(result).toEqual({
          success: false,
          ...(operation === "suspend" ? { containerStopped: false } : { containerRemoved: false }),
          error:
            "Refusing to stop without a current backup: Snapshot fetch failed: HTTP 500 Snapshot failed",
        });
        expect(provider.stopForReplacement).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
      } finally {
        sandboxTransactions.implementation = null;
        fetchSpy.mockRestore();
        latestSpy.mockRestore();
        restore();
      }
    },
  );

  test("suspend refuses when no durable backup exists and none can be captured", async () => {
    const rec = claimedPendingRow(); // running, no bridge to capture from
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      undefined,
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error:
          "Refusing to stop without a current backup: the agent has no reachable bridge to capture from",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      latestSpy.mockRestore();
      restore();
    }
  });

  test("suspend refuses when the lifecycle moved between capture and lock", async () => {
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      backupId: "backup-fresh",
      capturedFresh: true,
    });
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue({
      ...rec,
      lifecycle_revision: rec.lifecycle_revision + 1,
    });
    const writes: SQL[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "Agent lifecycle changed while the suspend backup was prepared",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      gateSpy.mockRestore();
      getForMutation.mockRestore();
      restore();
    }
  });

  test.each([
    ["status", "disconnected"],
    ["node_id", "replacement-node"],
    ["container_name", "replacement-container"],
    ["health_url", "https://replacement.example/api"],
  ] as const)(
    "suspend refuses when %s changes between capture and lock",
    async (field, replacement) => {
      const rec = bridgedRunningRow();
      const provider = stoppableProvider();
      const { svc, restore } = await suspendSvc(rec, provider, {
        ...rec,
        [field]: replacement,
      });
      const gateSpy = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
        outcome: "proceed",
        backupId: "backup-fresh",
        capturedFresh: true,
      });
      const writes: SQL[] = [];
      sandboxTransactions.implementation = async (fn) =>
        fn({
          execute: async (query) => {
            writes.push(query as SQL);
            return { rows: [] };
          },
        });
      try {
        await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        });
        expect(provider.stopForReplacement).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
      } finally {
        sandboxTransactions.implementation = null;
        gateSpy.mockRestore();
        restore();
      }
    },
  );

  test("suspend rejects a Shared tier under the lock before provider stop or write", async () => {
    const rec = { ...bridgedRunningRow(), status: "stopped" as const, bridge_url: null };
    const locked = { ...rec, execution_tier: "shared" as const };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider, locked);
    let writeCalled = false;
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          writeCalled = true;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: false,
        containerStopped: false,
        error: "Agent suspend requires a container-backed execution tier",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writeCalled).toBe(false);
    } finally {
      sandboxTransactions.implementation = null;
      restore();
    }
  });

  test("suspend running→Shared checkpoint race performs no capture, backup stamp, provider stop, or write", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const initial = bridgedRunningRow();
    const shared: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider = stoppableProvider();
    const svc = new ElizaSandboxService(provider) as unknown as SuspendGateSvc;
    const primary = spyOn(svc, "getAgentForWrite").mockResolvedValue(initial);
    const lock = spyOn(SandboxLifecycleAuthority.prototype, "lockLifecycle").mockResolvedValue(
      undefined,
    );
    const lockedRead = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(shared);
    const capture = spyOn(svc, "fetchSnapshotState");
    const createBackup = spyOn(agentSandboxesRepository, "createBackup");
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification");
    let rawWrites = 0;
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          rawWrites += 1;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: false,
        containerStopped: false,
        error: "Agent lifecycle changed while the suspend backup was prepared",
      });
      expect(capture).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
      expect(stamp).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(rawWrites).toBe(0);
    } finally {
      sandboxTransactions.implementation = null;
      primary.mockRestore();
      lock.mockRestore();
      lockedRead.mockRestore();
      capture.mockRestore();
      createBackup.mockRestore();
      stamp.mockRestore();
    }
  });

  test("suspend gate skips shared-tier and container-less rows", async () => {
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(claimedPendingRow(), provider);
    try {
      expect(
        await svc.prepareSuspendBackupGate({ ...claimedPendingRow(), execution_tier: "shared" }),
      ).toEqual({ outcome: "skip" });
      expect(
        await svc.prepareSuspendBackupGate({ ...claimedPendingRow(), sandbox_id: null }),
      ).toEqual({ outcome: "skip" });
    } finally {
      restore();
    }
  });

  test("a funded billing stop for an already-stopped agent stays billable", async () => {
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "stopped",
      billing_status: "shutdown_pending",
      last_backup_at: new Date("2026-08-20T00:00:00.000Z"),
    };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    billing.settleLifecycleBillingInTransactionSpy.mockClear();
    billing.settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
      status: "already_billed_recently",
    });
    const updates: Array<Record<string, unknown>> = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: async () => [
                  {
                    id: "00000000-0000-0000-0000-000000000098",
                    organization_id: ORG,
                    agent_id: AGENT,
                    lifecycle_revision: rec.lifecycle_revision,
                    authorization: "billing_request",
                    status: "pending",
                    job_id: SUSPEND_JOB,
                    attempts: 0,
                  },
                ],
              }),
            }),
          }),
        }),
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { where: async () => [] };
          },
        }),
      } as never);

    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB, "billing_request");
      expect(result).toEqual({
        success: true,
        containerStopped: false,
        skipped: true,
        reason: "billing_recovered",
      });
      expect(billing.settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
        "billing_recovery",
      );
      expect(updates).toContainEqual(
        expect.objectContaining({ status: "superseded", last_error: "billing_recovered" }),
      );
      expect(updates).toContainEqual(expect.objectContaining({ billing_status: "active" }));
      expect(updates.some((patch) => patch.billing_status === "suspended")).toBe(false);
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      restore();
    }
  });

  test("an unfunded user stop preserves retained-backup debt and billing authority", async () => {
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "stopped",
      billing_status: "active",
      last_backup_at: new Date("2026-08-20T00:00:00.000Z"),
    };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    billing.settleLifecycleBillingInTransactionSpy.mockClear();
    billing.settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
      status: "insufficient_credits",
    });
    const updates: Array<Record<string, unknown>> = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { where: async () => [] };
          },
        }),
      } as never);

    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: true,
        containerStopped: true,
      });
      expect(billing.settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          billing_status: "active",
          scheduled_shutdown_at: null,
          shutdown_warning_sent_at: null,
        }),
      );
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      restore();
    }
  });

  type SleepSvc = {
    executeSleep(
      agentId: string,
      orgId: string,
    ): Promise<{
      success: boolean;
      containerRemoved: boolean;
      backupId?: string;
      error?: string;
    }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    hasActiveReplacementJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
  };

  function armSleepTransaction(
    svc: SleepSvc,
    current: AgentSandbox,
  ): {
    lockLifecycle: ReturnType<typeof spyOn>;
    getForMutation: ReturnType<typeof spyOn>;
    activeReplacement: ReturnType<typeof spyOn>;
    writes: unknown[];
  } {
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(current);
    const activeReplacement = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveReplacementJobTx",
    ).mockResolvedValue(false);
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [{ id: current.id }] };
        },
      });
    return { lockLifecycle, getForMutation, activeReplacement, writes };
  }

  test("sleep running→Shared checkpoint race performs no capture, backup stamp, provider stop, or write", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const initial = bridgedRunningRow();
    const shared: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider = stoppableProvider();
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const primary = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      initial,
    );
    const lock = spyOn(SandboxLifecycleAuthority.prototype, "lockLifecycle").mockResolvedValue(
      undefined,
    );
    const lockedRead = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(shared);
    const capture = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<unknown> },
      "fetchSnapshotState",
    );
    const createBackup = spyOn(agentSandboxesRepository, "createBackup");
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification");
    let rawWrites = 0;
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          rawWrites += 1;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSleep(AGENT, ORG)).resolves.toEqual({
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      });
      expect(capture).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
      expect(stamp).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(rawWrites).toBe(0);
    } finally {
      sandboxTransactions.implementation = null;
      primary.mockRestore();
      lock.mockRestore();
      lockedRead.mockRestore();
      capture.mockRestore();
      createBackup.mockRestore();
      stamp.mockRestore();
    }
  });

  test("sleep on an unreachable old node retains compute locators for retry", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const tx = armSleepTransaction(svc, rec);
    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error: "old node unreachable",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(tx.writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });

  test("sleep rejects a newer lifecycle generation without stopping or clearing it", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const replacement: AgentSandbox = {
      ...rec,
      sandbox_id: "replacement-container",
      node_id: "replacement-node",
      container_name: "replacement-container",
      updated_at: new Date(rec.updated_at.getTime() + 1_000),
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const tx = armSleepTransaction(svc, replacement);

    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(tx.writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });

  test("sleep holds the lifecycle generation through strict stop and exact locator clear", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const prune = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(undefined);
    const tx = armSleepTransaction(svc, rec);

    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: true,
        containerRemoved: true,
        backupId: "durable-backup",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledTimes(1);
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(tx.writes).toHaveLength(1);
      expect(prune).toHaveBeenCalledWith(rec.id, expect.any(Number));
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      prune.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });
});
