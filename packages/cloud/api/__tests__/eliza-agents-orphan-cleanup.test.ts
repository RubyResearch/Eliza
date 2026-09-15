/** Exercises cloud API agent orphan deletion behavior with deterministic Worker route fixtures. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEDICATED_COMPUTE_PRICE_HEADER,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import {
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
} from "@/lib/services/eliza-sandbox";

/**
 * Regression test for the orphaned-`pending` sandbox bug.
 *
 * POST /api/v1/eliza/agents commits a `pending` sandbox row up front
 * (`createAgent`) and only later enqueues its `agent_provision` job. The
 * provisioning daemon ONLY claims rows that already have a job, so a throw in
 * the create→enqueue window (e.g. prepareManagedElizaEnvironment minting a KMS
 * key, or updateAgentEnvironment) would otherwise strand a `pending` row no
 * worker can ever pick up. The route now wraps that whole span and deletes the
 * just-created row on ANY failure, then rethrows.
 */

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const createAgent = mock(async () => ({
  agent: {
    id: "sandbox-1",
    agent_name: "e2e-dedicated-test",
    status: "pending",
    created_at: new Date("2026-06-14T00:00:00.000Z"),
    execution_tier: "custom",
    agent_config: undefined,
    character_id: null,
  },
  idempotent: false,
}));
const updateAgentEnvironment = mock(async () => undefined);
const deleteSandbox = mock(async () => true);
const prepareManagedElizaEnvironment = mock(async () => ({
  changed: false,
  environmentVars: {},
}));
const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: null,
}));
const triggerImmediate = mock(async () => undefined);
const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 100,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    delete: deleteSandbox,
    claimWarmContainer: mock(async () => null),
  },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdsInOrganization: mock(async () => []),
    findByIdInOrganizationForWrite: mock(async () => undefined),
  },
}));

mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  // route.ts imports these errors at module top level; the whole
  // module is replaced here, so they must be re-exported or the import is
  // undefined and route.ts fails to load (#11042).
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
  elizaSandboxService: {
    createAgent,
    updateAgentEnvironment,
    listAgents: mock(async () => []),
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision,
    triggerImmediate,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "worker unavailable",
  }),
}));

// Force the eager-provision custom path so the route reaches createAgent →
// enqueue (custom tier also skips the warm-pool branch).
mock.module("@/lib/services/shared-runtime/agent-tier", () => ({
  getAgentTier: () => "custom",
  tierProvisionsEagerly: () => true,
}));

mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    warmPoolEnabled: () => false,
    defaultAgentImage: () => "ghcr.io/elizaos/eliza:stable",
    publicBaseDomain: () => "elizacloud.ai",
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("../v1/eliza/agents/route");

function postAgent() {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEDICATED_COMPUTE_PRICE_HEADER]: getDedicatedComputePriceAcceptance(),
        "X-API-Key": "test-key",
      },
      body: JSON.stringify({
        agentName: "e2e-dedicated-test",
        dockerImage: "ghcr.io/elizaos/eliza:stable",
      }),
    }),
  );
}

describe("POST /api/v1/eliza/agents — orphan cleanup", () => {
  beforeEach(() => {
    createAgent.mockClear();
    updateAgentEnvironment.mockClear();
    deleteSandbox.mockClear();
    prepareManagedElizaEnvironment.mockClear();
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    deleteSandbox.mockResolvedValue(true);
    prepareManagedElizaEnvironment.mockResolvedValue({
      changed: false,
      environmentVars: {},
    });
  });

  // The route has no local onError, so a thrown plain Error bubbles to Hono's
  // default handler: HTTP 500, text/plain "Internal Server Error" (no JSON).
  async function expectOrphanCleanedUp(response: Response) {
    // createAgent committed exactly one row...
    expect(createAgent).toHaveBeenCalledTimes(1);
    // ...which was rolled back so the daemon can't strand it in `pending`.
    expect(deleteSandbox).toHaveBeenCalledWith("sandbox-1", "org-1");
    // The original error still surfaces to the caller (not swallowed).
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  }

  test("deletes the just-created sandbox when env prep throws (no orphaned pending row)", async () => {
    prepareManagedElizaEnvironment.mockImplementationOnce(async () => {
      throw new Error("KMS key mint failed");
    });

    const response = await postAgent();

    // env prep blew up before the enqueue.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    await expectOrphanCleanedUp(response);
  });

  test("deletes the just-created sandbox when the env update throws", async () => {
    prepareManagedElizaEnvironment.mockResolvedValueOnce({
      changed: true,
      environmentVars: { FOO: "bar" },
    });
    updateAgentEnvironment.mockImplementationOnce(async () => {
      throw new Error("db write failed");
    });

    const response = await postAgent();

    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    await expectOrphanCleanedUp(response);
  });

  test("deletes the just-created sandbox when the provision-job enqueue throws", async () => {
    enqueueAgentProvision.mockImplementationOnce(async () => {
      throw new Error("job table write failed");
    });

    const response = await postAgent();

    // enqueue is the last write in the guarded span; the row must still roll back.
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
    // triggerImmediate fires only AFTER a successful enqueue — never here.
    expect(triggerImmediate).not.toHaveBeenCalled();
    await expectOrphanCleanedUp(response);
  });

  test("rethrows the original error even when the cleanup delete also fails", async () => {
    prepareManagedElizaEnvironment.mockImplementationOnce(async () => {
      throw new Error("KMS key mint failed");
    });
    // The best-effort deletion itself throws: withOrphanCleanup's nested catch
    // logs deletionErr but must rethrow the original error, not the deletion error.
    deleteSandbox.mockImplementationOnce(async () => {
      throw new Error("delete failed too");
    });

    const response = await postAgent();

    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    await expectOrphanCleanedUp(response);
  });

  test("happy path enqueues the provision job and never deletes the sandbox", async () => {
    const response = await postAgent();

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
    expect(deleteSandbox).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
  });
});
