/**
 * POST /api/v1/eliza/agents — warm-pool post-claim character push.
 *
 * A warm pool container boots GENERIC (agent-warm-pool-creator provisions with
 * `environment_vars: {}` — no ELIZA_AGENT_CHARACTER_JSON), so after
 * `claimWarmContainer` transfers the DB row the RUNNING container would answer
 * as the default Eliza. The create route now calls
 * `elizaSandboxService.pushClaimedWarmContainerCharacter(claimed)` after a
 * successful claim, BEFORE responding 201.
 *
 * This pins:
 *   - a successful claim invokes the push with the claimed row (the user's
 *     character) and still responds 201 source=warm_pool;
 *   - a push FAILURE does not fail the claim — still 201 source=warm_pool,
 *     no cold-path job enqueued, and the stable
 *     `warm_pool.character_push_failed` event is emitted;
 *   - an empty-pool fallthrough (claim null) never invokes the push.
 *
 * Mocks only the module boundaries the handler imports; the route logic is
 * real. Harness modeled on eliza-agents-warm-pool-empty-on-claim.test.ts.
 * [sol-warmpool]
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
const pushClaimedWarmContainerCharacter = mock(
  async (_rec: Record<string, unknown>) =>
    ({ pushed: true, agentName: "alpha" }) as {
      pushed: boolean;
      agentName?: string;
    },
);
const pushClaimedWarmContainerInferenceKey = mock(async () => ({
  pushed: true,
  keyPrefix: "key-prefix",
}));

const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: new Date("2026-07-23T00:01:30.000Z"),
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

type LoggerMeta = {
  event?: string;
  agentId?: string;
  orgId?: string;
  error?: string;
};
const loggerInfo = mock((_msg: string, _meta?: LoggerMeta) => undefined);
const loggerWarn = mock((_msg: string, _meta?: LoggerMeta) => undefined);
const loggerError = mock((_msg: string, _meta?: LoggerMeta) => undefined);

const claimWarmContainer = mock(async (): Promise<unknown> => null);
const listByOrganization = mock(async () => []);
const countReadyPoolEntriesForImage = mock(async () => 0);
const updateSandbox = mock(async () => undefined);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer,
    listByOrganization,
    countReadyPoolEntriesForImage,
    update: updateSandbox,
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
    pushClaimedWarmContainerCharacter,
    pushClaimedWarmContainerInferenceKey,
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

const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";

function pendingAgent() {
  return {
    id: AGENT_ID,
    agent_name: "alpha",
    organization_id: "org-1",
    status: "pending",
    execution_tier: "dedicated-always",
    created_at: new Date("2026-07-23T00:00:00.000Z"),
    agent_config: { name: "alpha", system: "You are alpha." },
    character_id: null,
  };
}

function claimedRow() {
  return {
    id: AGENT_ID,
    agent_name: "alpha",
    agent_config: { name: "alpha", system: "You are alpha." },
    organization_id: "org-1",
    user_id: "user-1",
    status: "running",
    execution_tier: "dedicated-always",
    node_id: "node-1",
    container_name: `agent-${AGENT_ID}`,
    bridge_port: 21060,
    web_ui_port: 3000,
    headscale_ip: "100.64.0.11",
    bridge_url: "http://100.64.0.11:3000",
    health_url: "http://100.64.0.11:3000/api",
    sandbox_id: `agent-${AGENT_ID}`,
    environment_vars: { ELIZA_API_TOKEN: "agent_pool_live" },
    warm_pool_row_id: "pool-row-1",
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
    { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "agents.example.test" },
  );
}

function pushFailedEvents() {
  return loggerWarn.mock.calls.filter(
    (c) =>
      (c[1] as LoggerMeta | undefined)?.event ===
      "warm_pool.character_push_failed",
  );
}

describe("POST /api/v1/eliza/agents — warm-pool post-claim character push", () => {
  beforeEach(() => {
    createAgent.mockReset();
    claimWarmContainer.mockReset();
    pushClaimedWarmContainerCharacter.mockReset();
    pushClaimedWarmContainerCharacter.mockResolvedValue({
      pushed: true,
      agentName: "alpha",
    });
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    countReadyPoolEntriesForImage.mockReset();
    countReadyPoolEntriesForImage.mockResolvedValue(0);
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  test("successful claim: push invoked with the claimed row, 201 source=warm_pool", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(claimedRow());

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { source?: string };
    expect(body.source).toBe("warm_pool");

    // Push happened exactly once, with the claimed row (the user's character
    // travels via its agent_config/agent_name).
    expect(pushClaimedWarmContainerCharacter).toHaveBeenCalledTimes(1);
    const arg = pushClaimedWarmContainerCharacter.mock
      .calls[0]?.[0] as unknown as {
      id?: string;
      agent_config?: { name?: string };
      bridge_url?: string;
    };
    expect(arg?.id).toBe(AGENT_ID);
    expect(arg?.agent_config?.name).toBe("alpha");
    expect(arg?.bridge_url).toBe("http://100.64.0.11:3000");

    // Warm path — no cold job, no failure event.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(pushFailedEvents()).toHaveLength(0);
  });

  test("push failure does NOT fail the claim: still 201 source=warm_pool + failure event", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerCharacter.mockRejectedValue(
      new Error("Warm-claim character push failed: HTTP 503"),
    );

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    // The claim survives the push failure.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source?: string; success?: boolean };
    expect(body.success).toBe(true);
    expect(body.source).toBe("warm_pool");
    expect(enqueueAgentProvision).not.toHaveBeenCalled();

    // The degrade is observable via the stable event, with error context.
    const events = pushFailedEvents();
    expect(events).toHaveLength(1);
    const meta = events[0]?.[1] as LoggerMeta;
    expect(meta.agentId).toBe(AGENT_ID);
    expect(meta.error).toContain("HTTP 503");
  });

  test("empty-pool fallthrough (claim null): push is never invoked", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(null);

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    // Degraded to the async cold path.
    expect(res.status).toBe(202);
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
    expect(pushClaimedWarmContainerCharacter).not.toHaveBeenCalled();
  });
});
