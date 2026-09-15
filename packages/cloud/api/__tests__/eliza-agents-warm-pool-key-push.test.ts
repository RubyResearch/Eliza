/**
 * POST /api/v1/eliza/agents — warm-pool post-claim INFERENCE-KEY re-key (F0).
 *
 * A warm-pool container boots under the sentinel pool org with a cloud
 * inference key scoped to THAT org, so after `claimWarmContainer` transfers the
 * DB row the RUNNING container still holds the pool-org key and every reply is
 * the "My Eliza Cloud key isn't authorized for inference right now" fallback
 * (right face from #16977's character push, no voice). The create route now
 * calls `elizaSandboxService.pushClaimedWarmContainerInferenceKey(claimed)`
 * after a successful claim (and after the character push), BEFORE responding
 * 201.
 *
 * This pins:
 *   - a successful claim invokes the key push with the claimed row and still
 *     responds 201 source=warm_pool;
 *   - the key push runs alongside the character push (both invoked once);
 *   - a key-push FAILURE does not fail the claim — still 201 source=warm_pool,
 *     no cold-path job enqueued, and the stable `warm_pool.key_push_failed`
 *     event is emitted with error context;
 *   - the key value NEVER appears in any log meta (only a safe prefix);
 *   - an empty-pool fallthrough (claim null) never invokes the key push.
 *
 * Mocks only the module boundaries the handler imports; the route logic is
 * real. Harness modeled on eliza-agents-warm-pool-character-push.test.ts.
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
const pushClaimedWarmContainerInferenceKey = mock(
  async (_rec: Record<string, unknown>) =>
    ({ pushed: true, keyPrefix: "eliza_abcde…" }) as {
      pushed: boolean;
      keyPrefix?: string;
    },
);

const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: new Date("2026-07-23T00:01:30.000Z"),
}));
const enqueueAgentRestartOnce = mock(async () => ({
  job: { id: "restart-job-1", status: "pending" },
  created: true,
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
  keyPrefix?: string;
};
const loggerInfo = mock((_msg: string, _meta?: LoggerMeta) => undefined);
const loggerWarn = mock((_msg: string, _meta?: LoggerMeta) => undefined);
const loggerError = mock((_msg: string, _meta?: LoggerMeta) => undefined);

const claimWarmContainer = mock(async (): Promise<unknown> => null);
const listByOrganization = mock(async () => []);
const countReadyPoolEntriesForImage = mock(async () => 0);
let durableSandboxStatus = "running";
const deleteSandbox = mock(async () => undefined);
const updateSandbox = mock(
  async (_id: string, changes: { status?: string }) => {
    if (changes.status) durableSandboxStatus = changes.status;
  },
);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer,
    listByOrganization,
    countReadyPoolEntriesForImage,
    update: updateSandbox,
    delete: deleteSandbox,
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
  provisioningJobService: {
    enqueueAgentProvision,
    enqueueAgentRestartOnce,
    triggerImmediate,
  },
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
// The secret that must NEVER leak into a log/event.
const POOL_LIVE_KEY = "eliza_" + "supersecretmusntleak0000";

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
    warm_pool_row_id: "pool-row-1",
    // Pool-org cloud key baked at boot — the bug under repair.
    environment_vars: {
      ELIZA_API_TOKEN: "agent_pool_live",
      ELIZAOS_CLOUD_API_KEY: POOL_LIVE_KEY,
    },
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

function keyPushFailedEvents() {
  return loggerWarn.mock.calls.filter(
    (c) =>
      (c[1] as LoggerMeta | undefined)?.event === "warm_pool.key_push_failed",
  );
}

function everyLoggedMetaString(): string {
  return [
    ...loggerInfo.mock.calls,
    ...loggerWarn.mock.calls,
    ...loggerError.mock.calls,
  ]
    .map((c) => JSON.stringify(c))
    .join("\n");
}

describe("POST /api/v1/eliza/agents — warm-pool post-claim inference key push", () => {
  beforeEach(() => {
    createAgent.mockReset();
    claimWarmContainer.mockReset();
    pushClaimedWarmContainerCharacter.mockReset();
    pushClaimedWarmContainerCharacter.mockResolvedValue({
      pushed: true,
      agentName: "alpha",
    });
    pushClaimedWarmContainerInferenceKey.mockReset();
    pushClaimedWarmContainerInferenceKey.mockResolvedValue({
      pushed: true,
      keyPrefix: "eliza_abcde…",
    });
    enqueueAgentProvision.mockClear();
    enqueueAgentRestartOnce.mockReset();
    enqueueAgentRestartOnce.mockResolvedValue({
      job: { id: "restart-job-1", status: "pending" },
      created: true,
    });
    durableSandboxStatus = "running";
    updateSandbox.mockClear();
    deleteSandbox.mockClear();
    triggerImmediate.mockClear();
    countReadyPoolEntriesForImage.mockReset();
    countReadyPoolEntriesForImage.mockResolvedValue(0);
    loggerWarn.mockClear();
    loggerInfo.mockClear();
    loggerError.mockClear();
  });

  test("successful claim: key push invoked with the claimed row, 201 source=warm_pool", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(claimedRow());

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { source?: string };
    expect(body.source).toBe("warm_pool");

    // Both the character push AND the key push ran exactly once, in that order.
    expect(pushClaimedWarmContainerCharacter).toHaveBeenCalledTimes(1);
    expect(pushClaimedWarmContainerInferenceKey).toHaveBeenCalledTimes(1);
    const arg = pushClaimedWarmContainerInferenceKey.mock
      .calls[0]?.[0] as unknown as {
      id?: string;
      organization_id?: string;
      user_id?: string;
    };
    expect(arg?.id).toBe(AGENT_ID);
    expect(arg?.organization_id).toBe("org-1");
    expect(arg?.user_id).toBe("user-1");

    // Warm path — no cold job, no failure event.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(keyPushFailedEvents()).toHaveLength(0);

    // The secret never rides into a log.
    expect(everyLoggedMetaString()).not.toContain(POOL_LIVE_KEY);
  });

  test("key-push failure returns recovery state and enqueues a restart", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push failed: HTTP 503"),
    );

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { source?: string; success?: boolean };
    expect(body.success).toBe(true);
    expect(body.source).toBe("warm_pool_recovery");
    expect(enqueueAgentRestartOnce).toHaveBeenCalledTimes(1);
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(triggerImmediate).toHaveBeenCalledTimes(1);

    // The degrade is observable via the stable event, with error context.
    const events = keyPushFailedEvents();
    expect(events).toHaveLength(1);
    const meta = events[0]?.[1] as LoggerMeta;
    expect(meta.agentId).toBe(AGENT_ID);
    expect(meta.error).toContain("HTTP 503");

    // Even on failure, no secret leaks to logs.
    expect(everyLoggedMetaString()).not.toContain(POOL_LIVE_KEY);
  });

  test("delete winning after restart enqueue cannot be resurrected by recovery catch", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push failed: HTTP 503"),
    );
    enqueueAgentRestartOnce.mockImplementation(async () => {
      durableSandboxStatus = "deletion_pending";
      return {
        job: { id: "restart-job-1", status: "pending" },
        created: true,
      };
    });

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    expect(res.status).toBe(202);
    expect(durableSandboxStatus).toBe("deletion_pending");
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  test("a committed claim never falls into cold provisioning when recovery enqueue fails", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockImplementation(async () => {
      durableSandboxStatus = "provisioning";
      return claimedRow();
    });
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push failed: HTTP 503"),
    );
    enqueueAgentRestartOnce.mockRejectedValue(
      new Error("job database unavailable"),
    );
    checkProvisioningWorkerHealth.mockClear();

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    expect(res.status).toBe(503);
    expect(durableSandboxStatus).toBe("provisioning");
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(deleteSandbox).not.toHaveBeenCalled();
  });

  test("empty-pool fallthrough (claim null): key push is never invoked", async () => {
    createAgent.mockResolvedValue({ agent: pendingAgent(), idempotent: false });
    claimWarmContainer.mockResolvedValue(null);

    const res = await postCreate({ agentName: "alpha", alwaysOn: true });

    // Degraded to the async cold path.
    expect(res.status).toBe(202);
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
    expect(pushClaimedWarmContainerInferenceKey).not.toHaveBeenCalled();
  });
});
