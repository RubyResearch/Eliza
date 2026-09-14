/** Exercises sandbox deletion teardown contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, jest, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { SandboxLifecycleAuthority } from "./lifecycle/authority.js";
import { SandboxDeletion } from "./lifecycle/deletion.js";
import { customSandbox } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../../db/repositories/characters";
import { sharedRuntimeHistoryRepository } from "../../../db/repositories/shared-runtime-history";
import { logger } from "../../utils/logger";
import { apiKeysService } from "../api-keys";
import { type SandboxProvider } from "../sandbox-provider-types";
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
// The anti-wedge teardown cap (PR #9066). deleteAgent now runs its three short
// DB phases (precheck → bounded teardown OUTSIDE the lock/txn → row delete) so
// we can spy each seam and assert the three-way teardown classification without
// a real DB or a 120s wait. dbWrite.transaction itself stays a Proxy we don't
// touch — the prepare/commit phases are spied at the method boundary.
describe("ElizaSandboxService.deleteAgent teardown cap (#9066)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const SANDBOX_ID = "sandbox-e06bb509";

  type Svc = {
    deleteAgent(agentId: string, orgId: string): Promise<unknown>;
    executeDeletion(
      agentId: string,
      orgId: string,
      authorization?: "user_request" | "billing_request",
    ): Promise<{
      success: boolean;
      containerStopped: boolean;
      rowDeleted: boolean;
      error?: string;
    }>;
    prepareAgentDelete(
      agentId: string,
      orgId: string,
      authorization?: "user_request" | "billing_request",
    ): Promise<
      | {
          ok: true;
          sandboxId: string | null;
          status: string;
          sourcePoolId: string | null;
        }
      | { ok: false; error: string }
    >;
    commitAgentRowDelete(agentId: string, orgId: string, ownership?: unknown): Promise<unknown>;
    commitAgentReconciliationPending(agentId: string, orgId: string): Promise<unknown>;
    runBoundedSandboxStop(sandboxId: string): Promise<unknown>;
    retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<string>;
  };

  async function makeSvc(cleanupSource?: AgentSandbox): Promise<Svc> {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    // Phase 0 of deleteAgent (#18517) consults the live row before stamping
    // deletion intent; these tests exercise the later teardown phases, so the
    // capture sees no row and skips. Instance-scoped, so no cross-test leak.
    spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<AgentSandbox | undefined> },
      "getAgentForWrite",
    ).mockResolvedValue(cleanupSource);
    return svc as unknown as Svc;
  }

  test("executeDeletion retries without deleting while exact replacement cleanup is unresolved", async () => {
    const cleanupSource = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      replacement_cleanup_sandbox_id: "replacement-sandbox",
      replacement_cleanup_node_id: "replacement-node",
      replacement_cleanup_container_name: "replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-29T14:00:00.000Z"),
    };
    const svc = await makeSvc(cleanupSource);
    const retire = spyOn(svc, "retirePersistedReplacementCleanup").mockRejectedValue(
      new Error("exact Docker absence is not proven"),
    );
    const deleteAgent = spyOn(SandboxDeletion.prototype, "deleteAgent");

    await expect(svc.executeDeletion(AGENT, ORG, "user_request")).resolves.toEqual({
      success: false,
      containerStopped: false,
      rowDeleted: false,
      retryable: true,
      error: "Replacement cleanup is still pending: exact Docker absence is not proven",
    });
    expect(retire).toHaveBeenCalledWith(AGENT, ORG);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  test("executeDeletion removes the serving generation only after replacement cleanup converges", async () => {
    const cleanupSource = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      character_id: null,
      replacement_cleanup_sandbox_id: "replacement-sandbox",
      replacement_cleanup_node_id: "replacement-node",
      replacement_cleanup_container_name: "replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-29T14:00:00.000Z"),
    };
    const svc = await makeSvc(cleanupSource);
    const retire = spyOn(svc, "retirePersistedReplacementCleanup").mockResolvedValue("retired");
    const deleteAgent = spyOn(SandboxDeletion.prototype, "deleteAgent").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox: cleanupSource,
    });

    await expect(svc.executeDeletion(AGENT, ORG, "user_request")).resolves.toEqual({
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });
    expect(retire).toHaveBeenCalledWith(AGENT, ORG);
    expect(deleteAgent).toHaveBeenCalledWith(AGENT, ORG, {
      authorization: "user_request",
      stateLossAcknowledged: undefined,
    });
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAgent.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("prepareAgentDelete refuses an unauthorized running agent before deletion intent", async () => {
    const svc = await makeSvc();
    const live = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      last_heartbeat_at: new Date(Date.now() - 30_000),
    };
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(live);
    const activeProvision = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const activeReplacement = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveReplacementJobTx",
    ).mockResolvedValue(false);
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [{ ...live, status: "deletion_pending" }]),
        })),
      })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
      });

    try {
      await expect(svc.prepareAgentDelete(AGENT, ORG)).resolves.toEqual({
        ok: false,
        error: "Agent is running; suspend it before deletion",
      });
      expect(update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
    }
  });

  test("prepareAgentDelete allows an explicitly authorized running agent", async () => {
    const svc = await makeSvc();
    const live = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      last_heartbeat_at: null,
    };
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(live);
    const activeProvision = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const activeReplacement = spyOn(
      SandboxLifecycleAuthority.prototype,
      "hasActiveReplacementJobTx",
    ).mockResolvedValue(false);
    // An authorized live-row delete must carry a current-generation capture
    // (#18517); persistence itself is covered by the dedicated capture tests.
    const persist = spyOn(
      svc as unknown as {
        persistSnapshotWithinTransaction: (
          ...args: unknown[]
        ) => Promise<{ backupId: string; lifecycleRevision: number }>;
      },
      "persistSnapshotWithinTransaction",
    ).mockResolvedValue({
      backupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      lifecycleRevision: 2,
    });
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [
            {
              id: AGENT,
              deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              deletionStartedAt: new Date("2026-06-04T12:00:00.000Z"),
              lifecycleRevision: 1,
            },
          ]),
        })),
      })),
    }));
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => ({
          rows: [
            {
              hostname: "dedicated-node.example.test",
              ssh_port: 2222,
              ssh_user: "eliza",
              host_key_fingerprint: "SHA256:test",
            },
          ],
        }),
        // This legacy agent has no prepaid funding window to settle.
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
        update,
      });

    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(AGENT, ORG, "user_request", {
          snapshot: {
            stateData: { tables: {} },
            sizeBytes: 1,
            bridgeUrl: live.bridge_url,
          },
          captureAuthority: live,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: null,
        }),
      ).resolves.toMatchObject({
        ok: true,
        deletionLocator: {
          sandboxId: live.sandbox_id,
          agentId: live.id,
          nodeId: live.node_id,
          containerName: live.container_name,
          hostname: "dedicated-node.example.test",
          sshPort: 2222,
          sshUser: "eliza",
          hostKeyFingerprint: "SHA256:test",
        },
      });
      expect(update).toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("linked character cleanup waits until the reconciliation tombstone is removed", async () => {
    const svc = await makeSvc();
    const characterId = "44444444-4444-4444-8444-444444444444";
    const deletedSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      character_id: characterId,
      agent_config: {},
    };
    const deletion = spyOn(SandboxDeletion.prototype, "deleteAgent")
      .mockResolvedValueOnce({
        success: true,
        rowDeleted: false,
        reconciliationPending: true,
        deletedSandbox,
      })
      .mockResolvedValueOnce({
        success: true,
        rowDeleted: true,
        deletedSandbox,
      });
    const deleteCharacter = spyOn(userCharactersRepository, "delete").mockResolvedValue(undefined);

    try {
      await expect(svc.executeDeletion(AGENT, ORG)).resolves.toEqual({
        success: true,
        containerStopped: false,
        rowDeleted: false,
      });
      expect(deleteCharacter).not.toHaveBeenCalled();

      await expect(svc.executeDeletion(AGENT, ORG)).resolves.toEqual({
        success: true,
        containerStopped: true,
        rowDeleted: true,
      });
      expect(deleteCharacter).toHaveBeenCalledTimes(1);
      expect(deleteCharacter).toHaveBeenCalledWith(characterId);
    } finally {
      deletion.mockRestore();
      deleteCharacter.mockRestore();
    }
  });

  test("(a) teardown timeout completes the attempt but retains a reconciliation tombstone", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // Timed-out teardown is reported as an explicit tagged outcome.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-timed-out",
      error: new Error("agent-delete stop sandbox-e06bb509 timed out after 120000ms"),
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox,
    });
    const retain = spyOn(
      SandboxDeletion.prototype,
      "commitAgentReconciliationPending",
    ).mockResolvedValue({
      success: true,
      rowDeleted: false,
      reconciliationPending: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as {
        success: boolean;
        rowDeleted?: boolean;
        deletedSandbox?: unknown;
      };
      // A hang does not retry in the hot queue, but its ownership row remains.
      expect(res.success).toBe(true);
      expect(res.rowDeleted).toBe(false);
      expect(res.deletedSandbox).toEqual(deletedSandbox);
      expect(commit).not.toHaveBeenCalled();
      expect(retain).toHaveBeenCalledTimes(1);
      // The warning must flag abandonment while preserving capacity accounting.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("timed out");
      expect(warned).toContain("ABANDONING");
      expect(warned).toContain("retaining its capacity");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      retain.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(b) a real stop failure on a reachable node → delete aborts (failure), row never deleted", async () => {
    const svc = await makeSvc();
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // Bounded (non-timeout) failure with a non-ignorable message.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error("docker stop -> daemon hung; docker rm -f -> daemon hung"),
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean; error?: string };
      expect(res.success).toBe(false);
      expect(res.error).toBe("Failed to delete sandbox");
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-sandbox] Stop failed during delete",
        expect.objectContaining({ stopFailureKind: "docker_stop_pair_failed" }),
      );
      // Critically: the row delete is never attempted when the container may
      // still be running.
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(c) an ignorable 'already gone' failure → info + delete proceeds (row deleted)", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error("container not found"),
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean };
      expect(res.success).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
      const infoed = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(infoed).toContain("already absent");
      // An ignorable absence is NOT a leak warning.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).not.toContain("ABANDONING");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(d) a missing-node-metadata hydration failure (node purged from docker_nodes) → ignorable, delete proceeds", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // The exact shape hydrateContainerFromDb throws when the sandbox row
    // points at a node that no longer has a docker_nodes record: the host is
    // gone, so there is nothing left to stop.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error(
        '[docker-sandbox] Missing persisted docker node metadata for node "node-decommissioned"',
      ),
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean };
      expect(res.success).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
      const infoed = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(infoed).toContain("already absent");
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).not.toContain("ABANDONING");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(e) an unrelated hydration failure (missing port data) → still NOT ignorable, delete aborts", async () => {
    const svc = await makeSvc();
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // A sibling hydrateContainerFromDb failure that does NOT mean the host is
    // gone — the container may still be running, so the delete must escalate.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error(
        '[docker-sandbox] Missing port data for "sandbox-e06bb509": bridge=null, webUi=null',
      ),
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean; error?: string };
      expect(res.success).toBe(false);
      expect(res.error).toBe("Failed to delete sandbox");
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("the bounded teardown runs OUTSIDE the row-delete phase (sequenced, not nested)", async () => {
    const svc = await makeSvc();
    const order: string[] = [];
    const sourcePoolId = "44444444-4444-4444-8444-444444444444";
    const preDeleteBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockImplementation(
      async () => {
        order.push("prepare");
        return {
          ok: true,
          sandboxId: SANDBOX_ID,
          nodeId: null,
          status: "running",
          sourcePoolId,
          environmentRevision: 4,
          lifecycleRevision: 9,
          deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          preDeleteBackupId,
        };
      },
    );
    const stop = spyOn(svc, "runBoundedSandboxStop").mockImplementation(async () => {
      order.push("teardown");
      return { kind: "not-running-proven" };
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete").mockImplementation(
      async () => {
        order.push("commit");
        return {
          success: true,
          rowDeleted: true,
          deletedSandbox: { ...customSandbox(), id: AGENT },
        };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockImplementation(
      async (credentialOwnerId) => {
        order.push(`revoke:${credentialOwnerId}`);
      },
    );
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    try {
      await svc.deleteAgent(AGENT, ORG);
      // Teardown must happen between the precheck txn and the row-delete txn,
      // never inside the write-lock/transaction.
      expect(order).toEqual([
        "prepare",
        "teardown",
        `revoke:${AGENT}`,
        `revoke:${sourcePoolId}`,
        "commit",
      ]);
      expect(commit).toHaveBeenCalledWith(
        AGENT,
        ORG,
        expect.objectContaining({ preDeleteBackupId }),
      );
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  test("allocation release carries its post-trigger revision into the delete CAS", async () => {
    const svc = await makeSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      nodeId: "node-1",
      status: "running",
      sourcePoolId: null,
      environmentRevision: 4,
      lifecycleRevision: 9,
      deletionAttemptId,
      deletionStartedAt: new Date("2026-08-13T12:00:00.000Z"),
      preDeleteBackupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    const release = spyOn(
      agentSandboxesRepository,
      "tryReleaseDeletionAllocationForCommit",
    ).mockResolvedValue({ outcome: "released", lifecycleRevision: 10 });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox: { ...customSandbox(), id: AGENT },
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    try {
      await expect(svc.deleteAgent(AGENT, ORG)).resolves.toMatchObject({
        success: true,
        rowDeleted: true,
      });
      expect(release).toHaveBeenCalledWith(AGENT, ORG, deletionAttemptId, "node-1", 9);
      expect(commit).toHaveBeenCalledWith(
        AGENT,
        ORG,
        expect.objectContaining({ lifecycleRevision: 10, deletionAttemptId }),
      );
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      release.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  test("an authoritative credential revoke failure preserves the row for retry", async () => {
    const svc = await makeSvc();
    const sourcePoolId = "44444444-4444-4444-8444-444444444444";
    const prepare = spyOn(SandboxDeletion.prototype, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "error",
      sourcePoolId,
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    const commit = spyOn(SandboxDeletion.prototype, "commitAgentRowDelete");
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("authoritative revoke unavailable"));
    try {
      await expect(svc.deleteAgent(AGENT, ORG)).rejects.toThrow("authoritative revoke unavailable");
      expect(apiKeySpy.mock.calls.map(([owner]) => owner)).toEqual([AGENT, sourcePoolId]);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
    }
  });

  test("runBoundedSandboxStop returns proven absence from a clean provider stop", async () => {
    const svc = await makeSvc();
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stopForDeletion: async () => ({ kind: "not-running-proven" as const }),
    } as unknown as SandboxProvider);
    try {
      const res = await svc.runBoundedSandboxStop(SANDBOX_ID);
      expect(res).toEqual({ kind: "not-running-proven" });
    } finally {
      getProvider.mockRestore();
    }
  });

  test("runBoundedSandboxStop captures a provider error as a value (not a timeout)", async () => {
    const svc = await makeSvc();
    const boom = new Error("docker rm -f -> daemon hung");
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stopForDeletion: async () => {
        throw boom;
      },
    } as unknown as SandboxProvider);
    try {
      const res = (await svc.runBoundedSandboxStop(SANDBOX_ID)) as {
        kind: string;
        error: unknown;
      };
      expect(res.kind).toBe("stop-failed");
      expect(res.error).toBe(boom);
    } finally {
      getProvider.mockRestore();
    }
  });

  // The whole reason #9066 exists: a provider stop that genuinely never
  // settles (SSH connect / provider init wedge) must be cut off at the hard
  // cap so a single stuck node can't hang the delete past the job watchdog and
  // wedge the provisioning worker. The two tests above cover clean/error; this
  // one drives the REAL withTimeout branch — a never-settling stop raced under
  // fake timers — and asserts the tagged timeout used to preserve capacity.
  test("runBoundedSandboxStop cuts off a never-settling provider stop", async () => {
    const svc = await makeSvc();
    // Never resolves and never rejects: the only way out is the timeout race.
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stopForDeletion: () => new Promise<never>(() => {}),
    } as unknown as SandboxProvider);
    jest.useFakeTimers();
    try {
      const pending = svc.runBoundedSandboxStop(SANDBOX_ID) as Promise<{
        kind: string;
        error: unknown;
      }>;
      // Let getProvider() + the try-body microtasks settle so the timeout
      // timer is actually armed, then pass the four-minute teardown budget.
      await Promise.resolve();
      jest.advanceTimersByTime(240_001);
      const res = await pending;
      expect(res.kind).toBe("stop-timed-out");
      expect(res.error).toBeInstanceOf(Error);
      expect((res.error as Error).message).toContain("timed out after");
    } finally {
      jest.useRealTimers();
      getProvider.mockRestore();
    }
  });
});
