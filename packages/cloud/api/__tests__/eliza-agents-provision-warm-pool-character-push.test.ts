/**
 * POST /api/v1/eliza/agents/[agentId]/provision — warm-pool post-claim
 * character push (the SECOND claim site; the create-route site is pinned by
 * eliza-agents-warm-pool-character-push.test.ts).
 *
 * A pool container boots GENERIC (no ELIZA_AGENT_CHARACTER_JSON), so after a
 * successful `claimWarmContainer` the provision route pushes the user's
 * character onto the RUNNING container before responding. This pins the same
 * contract at this site:
 *   - a successful claim invokes the push with the claimed row and responds
 *     200 source=warm_pool;
 *   - a push FAILURE does not fail the claim — still 200 source=warm_pool, no
 *     cold job enqueued, and the stable `warm_pool.character_push_failed`
 *     event carries error context;
 *   - a claim fallthrough (null) never invokes the push and degrades to the
 *     202 async job path.
 *
 * Mocks only the module boundaries the handler imports; the route logic is
 * real. Harness modeled on eliza-agents-warm-pool-character-push.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));

const getAgentForWrite = mock(async (): Promise<unknown> => null);
const provision = mock(async () => ({ success: false, error: "unused" }));
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

const enqueueAgentProvisionOnce = mock(async () => ({
  job: {
    id: "job-1",
    status: "pending",
    estimated_completion_at: new Date("2026-07-23T00:01:30.000Z"),
  },
  created: true,
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
const countReadyPoolEntriesForImage = mock(async () => 0);
let durableSandboxStatus = "running";
const updateSandbox = mock(
  async (_id: string, changes: { status?: string }) => {
    if (changes.status) durableSandboxStatus = changes.status;
  },
);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer,
    countReadyPoolEntriesForImage,
    update: updateSandbox,
  },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgentForWrite,
    provision,
    pushClaimedWarmContainerCharacter,
    pushClaimedWarmContainerInferenceKey,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
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

mock.module("@/lib/security/outbound-url", () => ({
  assertSafeOutboundUrl: mock(async () => undefined),
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

const { default: provisionRoute } = await import(
  "../v1/eliza/agents/[agentId]/provision/route"
);

const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/provision", provisionRoute);

const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";

function pendingAgent() {
  return {
    id: AGENT_ID,
    agent_name: "alpha",
    organization_id: "org-1",
    status: "pending",
    execution_tier: "dedicated-always",
    bridge_url: null,
    health_url: null,
    agent_config: { name: "alpha", system: "You are alpha." },
    character_id: null,
    updated_at: new Date("2026-07-23T00:00:00.000Z"),
  };
}

function claimedRow() {
  return {
    id: AGENT_ID,
    agent_name: "alpha",
    agent_config: { name: "alpha", system: "You are alpha." },
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

async function postProvision() {
  return app.fetch(
    new Request(
      `https://api.example.test/api/v1/eliza/agents/${AGENT_ID}/provision`,
      {
        method: "POST",
        headers: {
          "X-Eliza-Dedicated-Price":
            "dedicated-compute-v1:USD:0.150000:0.300000",
        },
      },
    ),
  );
}

function pushFailedEvents() {
  return loggerWarn.mock.calls.filter(
    (c) =>
      (c[1] as LoggerMeta | undefined)?.event ===
      "warm_pool.character_push_failed",
  );
}

describe("POST /api/v1/eliza/agents/[agentId]/provision — warm-pool post-claim character push", () => {
  beforeEach(() => {
    getAgentForWrite.mockReset();
    getAgentForWrite.mockResolvedValue(pendingAgent());
    claimWarmContainer.mockReset();
    pushClaimedWarmContainerCharacter.mockReset();
    pushClaimedWarmContainerCharacter.mockResolvedValue({
      pushed: true,
      agentName: "alpha",
    });
    pushClaimedWarmContainerInferenceKey.mockReset();
    pushClaimedWarmContainerInferenceKey.mockResolvedValue({
      pushed: true,
      keyPrefix: "key-prefix",
    });
    enqueueAgentRestartOnce.mockReset();
    enqueueAgentRestartOnce.mockResolvedValue({
      job: { id: "restart-job-1", status: "pending" },
      created: true,
    });
    durableSandboxStatus = "running";
    updateSandbox.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    triggerImmediate.mockClear();
    countReadyPoolEntriesForImage.mockReset();
    countReadyPoolEntriesForImage.mockResolvedValue(0);
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  test("successful claim: push invoked with the claimed row, 200 source=warm_pool", async () => {
    claimWarmContainer.mockResolvedValue(claimedRow());

    const res = await postProvision();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { source?: string; success?: boolean };
    expect(body.success).toBe(true);
    expect(body.source).toBe("warm_pool");

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
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
    expect(pushFailedEvents()).toHaveLength(0);
  });

  test("push failure does NOT fail the claim: still 200 source=warm_pool + failure event", async () => {
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerCharacter.mockRejectedValue(
      new Error("Warm-claim character push failed: HTTP 503"),
    );

    const res = await postProvision();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { source?: string; success?: boolean };
    expect(body.success).toBe(true);
    expect(body.source).toBe("warm_pool");
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();

    const events = pushFailedEvents();
    expect(events).toHaveLength(1);
    const meta = events[0]?.[1] as LoggerMeta;
    expect(meta.agentId).toBe(AGENT_ID);
    expect(meta.error).toContain("HTTP 503");
  });

  test("claim fallthrough (null): push never invoked, degrades to 202 async job", async () => {
    claimWarmContainer.mockResolvedValue(null);

    const res = await postProvision();

    expect(res.status).toBe(202);
    expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1);
    expect(pushClaimedWarmContainerCharacter).not.toHaveBeenCalled();
  });

  test("failed key attestation marks recovery and enqueues an immediate restart", async () => {
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push was not attested"),
    );

    const res = await postProvision();
    const body = (await res.json()) as { source?: string };

    expect(res.status).toBe(202);
    expect(body.source).toBe("warm_pool_recovery");
    expect(enqueueAgentRestartOnce).toHaveBeenCalledTimes(1);
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("delete winning after restart enqueue remains deletion_pending", async () => {
    claimWarmContainer.mockResolvedValue(claimedRow());
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push was not attested"),
    );
    enqueueAgentRestartOnce.mockImplementation(async () => {
      durableSandboxStatus = "deletion_pending";
      return {
        job: { id: "restart-job-1", status: "pending" },
        created: true,
      };
    });

    const res = await postProvision();

    expect(res.status).toBe(202);
    expect(durableSandboxStatus).toBe("deletion_pending");
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  test("a committed claim never falls into cold provision when recovery enqueue fails", async () => {
    claimWarmContainer.mockImplementation(async () => {
      durableSandboxStatus = "provisioning";
      return claimedRow();
    });
    pushClaimedWarmContainerInferenceKey.mockRejectedValue(
      new Error("Warm-claim key push was not attested"),
    );
    enqueueAgentRestartOnce.mockRejectedValue(
      new Error("job database unavailable"),
    );
    checkProvisioningWorkerHealth.mockClear();

    const res = await postProvision();

    expect(res.status).toBe(503);
    expect(durableSandboxStatus).toBe("provisioning");
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });
});
