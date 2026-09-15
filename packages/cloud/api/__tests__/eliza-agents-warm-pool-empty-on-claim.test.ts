/**
 * POST /api/v1/eliza/agents — warm-pool empty-on-claim observability.
 *
 * When the warm pool is enabled but empty, `claimWarmContainer` returns null and
 * the create silently degrades to the 30-120s async cold path. Before this fix
 * that degrade emitted NO signal (the existing `warm_pool.claim_failed` event
 * only fires on a claim THROW), so pool STARVATION — the steady state when
 * replenish is broken (PROVISIONING-E2E-AUDIT §C4, Nubs' report) — was invisible.
 *
 * This pins:
 *   - an EMPTY pool (claim null + zero ready entries) emits
 *     `warm_pool.empty_on_claim` and still falls through to enqueue a job;
 *   - a merely-INELIGIBLE user row (claim null but the pool has ready entries)
 *     does NOT emit the starvation event — the signal isn't polluted by benign
 *     re-provisions.
 *
 * Mocks only the module boundaries the handler imports; the route logic is real.
 * [sol-cloud]
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEDICATED_COMPUTE_PRICE_HEADER,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

const createAgent = mock();
const updateAgentEnvironment = mock(async () => undefined);
const listAgents = mock(async () => []);

const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: new Date("2026-06-24T00:01:30.000Z"),
}));
const triggerImmediate = mock(async () => undefined);

const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 100,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const prepareManagedElizaEnvironment = mock(async () => ({
  changed: false,
  environmentVars: {},
}));

type LoggerWarnMeta = {
  event?: string;
  agentId?: string;
  orgId?: string;
};
const loggerInfo = mock((_msg: string, _meta?: LoggerWarnMeta) => undefined);
const loggerWarn = mock((_msg: string, _meta?: LoggerWarnMeta) => undefined);
const loggerError = mock((_msg: string, _meta?: LoggerWarnMeta) => undefined);

const claimWarmContainer = mock(async () => null);
const listByOrganization = mock(async () => []);
const countReadyPoolEntriesForImage = mock(async () => 0);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer,
    listByOrganization,
    countReadyPoolEntriesForImage,
  },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganizationForWrite: mock(async () => undefined),
    findByIdsInOrganization: mock(async () => []),
  },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

class AgentQuotaExceededError extends Error {}
class AgentImageNotAllowedError extends Error {}

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    createAgent,
    updateAgentEnvironment,
    listAgents,
  },
  AgentQuotaExceededError,
  AgentImageNotAllowedError,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentProvision, triggerImmediate },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: (h: { code?: string }) => ({
    success: false,
    code: h.code ?? "worker_unavailable",
  }),
}));

mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment,
}));

// Force a dedicated (eager, non-custom) tier so the create reaches the
// warm-pool claim block, and enable the pool.
mock.module("@/lib/services/shared-runtime/agent-tier", () => ({
  getAgentTier: () => "dedicated-always",
  tierProvisionsEagerly: () => true,
}));

mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    warmPoolEnabled: () => true,
    defaultAgentImage: () => "ghcr.io/example/agent:pinned",
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

const { default: agentsRoute } = await import("../v1/eliza/agents/route");

const app = new Hono();
app.route("/api/v1/eliza/agents", agentsRoute);

function pendingAgent() {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    agent_name: "alpha",
    organization_id: "org-1",
    status: "pending",
    execution_tier: "dedicated-always",
    created_at: new Date("2026-06-24T00:00:00.000Z"),
    agent_config: {},
    character_id: null,
  };
}

async function postCreate(body: unknown) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEDICATED_COMPUTE_PRICE_HEADER]: getDedicatedComputePriceAcceptance(),
      },
      body: JSON.stringify(body),
    }),
  );
}

function emptyOnClaimCalls() {
  return loggerWarn.mock.calls.filter(
    (c) =>
      (c[1] as { event?: string } | undefined)?.event ===
      "warm_pool.empty_on_claim",
  );
}

describe("POST /api/v1/eliza/agents — warm-pool empty-on-claim signal", () => {
  beforeEach(() => {
    createAgent.mockReset();
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    claimWarmContainer.mockClear();
    countReadyPoolEntriesForImage.mockReset();
    countReadyPoolEntriesForImage.mockResolvedValue(0);
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  test("empty pool: claim null + 0 ready entries emits warm_pool.empty_on_claim and enqueues the cold path", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    countReadyPoolEntriesForImage.mockResolvedValue(0);

    const res = await postCreate({
      agentName: "alpha",
      alwaysOn: true,
      dockerImage: "ghcr.io/example/agent:latest",
    });

    // Fell through to the async job path.
    expect(res.status).toBe(202);
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);

    // The starvation is now observable.
    const calls = emptyOnClaimCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0]?.[1] as { agentId?: string })?.agentId).toBe(
      pendingAgent().id,
    );
    expect(countReadyPoolEntriesForImage).toHaveBeenCalledWith(
      "ghcr.io/example/agent:pinned",
    );
  });

  test("ineligible user row (pool NOT empty): claim null + ready>0 does NOT emit the starvation event", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    // Pool has ready entries; the null claim was ineligibility, not starvation.
    countReadyPoolEntriesForImage.mockResolvedValue(2);

    const res = await postCreate({
      agentName: "alpha",
      alwaysOn: true,
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(202);
    expect(emptyOnClaimCalls()).toHaveLength(0);
  });
});
