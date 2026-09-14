/**
 * POST /api/v1/eliza/agents/:id/resume `sync` is resume-wait identity,
 * not leftover tax on agent-create autoProvision or container-delete
 * purgeVolume. Stock develop treated any non-exact `true` token as
 * async, so `sync=TRUE` still enqueued a 202 job instead of blocking. The
 * compatibility token is fenced to canonical, user-owned, live container
 * capacity and then routed through the admitted queue.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  type AgentSandboxPoolStatus,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "@/db/schemas/agent-sandboxes";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "agent-resume-1";
const ENV = {
  NODE_ENV: "test",
  ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
} as unknown as AppEnv["Bindings"];

type ResumeAgent = {
  id: string;
  organization_id: string;
  execution_tier: string;
  status: string;
  bridge_url: string | null;
  health_url: string | null;
  pool_status: AgentSandboxPoolStatus | null;
  deleted_at: Date | null;
  deletion_attempt_id: string | null;
};

function resumeAgent(overrides: Partial<ResumeAgent> = {}): ResumeAgent {
  return {
    id: AGENT_ID,
    organization_id: ORG_A,
    execution_tier: "dedicated-always",
    status: "suspended",
    bridge_url: null,
    health_url: null,
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    ...overrides,
  };
}

const getAgentForWrite = mock(
  async (): Promise<ResumeAgent | null> => resumeAgent(),
);
const provision = mock(async () => ({
  success: true,
  bridgeUrl: "http://100.64.0.12:19027",
  healthUrl: "http://10.0.0.8:19028/health",
}));
const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 5,
  error: "",
}));
const enqueueAgentResumeOnce = mock(async () => ({
  job: { id: "job-1", status: "queued" },
  created: true,
}));
const triggerImmediate = mock(async () => undefined);
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: ORG_A },
  }),
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/agent-billing-gate-402", () => ({
  insufficientCredits402: () => ({ error: "insufficient credits" }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgentForWrite, provision },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentResumeOnce, triggerImmediate },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({ error: "worker" }),
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/api/errors", () => ({
  errorToResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "error" },
      { status: 500 },
    ),
}));
mock.module("@/lib/security/outbound-url", () => ({
  assertSafeOutboundUrl: async () => undefined,
}));

const { default: resumeRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents/:agentId/resume", resumeRoute);
  return app;
}

function post(
  query = "",
  acceptance: string | null = "dedicated-compute-v1:USD:0.150000:0.300000",
) {
  return buildApp().request(
    `/api/v1/eliza/agents/${AGENT_ID}/resume${query}`,
    {
      method: "POST",
      headers:
        acceptance === null ? {} : { "X-Eliza-Dedicated-Price": acceptance },
    },
    ENV,
  );
}

function expectNoResumeEffects() {
  expect(checkAgentCreditGate).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
  expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
  expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
  expect(triggerImmediate).not.toHaveBeenCalled();
}

async function expectSyncConflict(agent: ResumeAgent, expectedError: string) {
  getAgentForWrite.mockImplementationOnce(async () => agent);

  const response = await post("?sync=true");

  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    success: boolean;
    error: string;
  };
  expect(body).toEqual({
    success: false,
    error: expectedError,
  });
  expect(getAgentForWrite).toHaveBeenCalledTimes(1);
  expectNoResumeEffects();
}

describe("POST /api/v1/eliza/agents/:id/resume sync identity", () => {
  beforeEach(() => {
    getAgentForWrite.mockClear();
    provision.mockClear();
    checkAgentCreditGate.mockClear();
    enqueueAgentResumeOnce.mockClear();
    triggerImmediate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
  });

  test.each([null, "dedicated-compute-v1:USD:0.010000:0.020000", "invalid"])(
    "rejects missing or stale price acceptance %s before paid effects",
    async (acceptance) => {
      const response = await post("", acceptance);
      expect(response.status).toBe(428);
      expect(await response.json()).toMatchObject({
        code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
      });
      expectNoResumeEffects();
    },
  );

  test.each(["", "?sync=", "?sync=false"])(
    "accepts %s as async resume (enqueue job)",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(202);
      expect(enqueueAgentResumeOnce).toHaveBeenCalledTimes(1);
      expect(provision).not.toHaveBeenCalled();
    },
  );

  test("keeps an async Shared request on the existing shared-runtime fast path", async () => {
    getAgentForWrite.mockImplementationOnce(async () =>
      resumeAgent({
        execution_tier: "shared",
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
    );

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      source: "shared_runtime",
    });
    expect(getAgentForWrite).toHaveBeenCalledTimes(1);
    expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
    expectNoResumeEffects();
  });

  test("returns only the configured public gateway for running Dedicated capacity", async () => {
    getAgentForWrite.mockImplementationOnce(async () =>
      resumeAgent({
        status: "running",
        bridge_url: "http://100.64.0.12:19027",
        health_url: "http://10.0.0.8:19028/health",
      }),
    );

    const response = await post();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        webUiUrl: `https://${AGENT_ID}.staging.elizacloud.ai`,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/100\.64|10\.0|192\.168/);
    expectNoResumeEffects();
  });

  test("returns 404 for a missing agent before sync effects", async () => {
    getAgentForWrite.mockImplementationOnce(async () => null);

    const response = await post("?sync=true");

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(body).toEqual({
      success: false,
      error: "Agent not found",
    });
    expect(getAgentForWrite).toHaveBeenCalledTimes(1);
    expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
    expectNoResumeEffects();
  });

  test("rejects a stopped Shared agent before sync resume effects", async () => {
    await expectSyncConflict(
      resumeAgent({ execution_tier: "shared", status: "stopped" }),
      "Agent resume requires a container-backed execution tier",
    );
  });

  test("gives tier rejection precedence for an unknown running agent", async () => {
    await expectSyncConflict(
      resumeAgent({
        execution_tier: "future-container",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent resume requires a container-backed execution tier",
    );
  });

  test("gives pool ownership precedence over deletion state", async () => {
    await expectSyncConflict(
      resumeAgent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent resume cannot target pool-owned capacity",
    );
  });

  test("gives deletion precedence over a deletion attempt", async () => {
    await expectSyncConflict(
      resumeAgent({
        execution_tier: "dedicated-always",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent resume cannot target deleted capacity",
    );
  });

  test("rejects capacity with deletion in progress", async () => {
    await expectSyncConflict(
      resumeAgent({
        execution_tier: "custom",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent resume cannot target capacity with deletion in progress",
    );
  });

  test.each([...CONTAINER_BACKED_EXECUTION_TIERS])(
    "queues canonical %s capacity on the admitted resume path",
    async (executionTier) => {
      getAgentForWrite.mockImplementationOnce(async () =>
        resumeAgent({
          execution_tier: executionTier,
          status: "stopped",
          bridge_url: null,
          health_url: null,
          pool_status: null,
          deleted_at: null,
          deletion_attempt_id: null,
        }),
      );

      const response = await post("?sync=true");

      expect(response.status).toBe(202);
      expect(getAgentForWrite).toHaveBeenCalledTimes(1);
      expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
      expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
      expect(provision).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).toHaveBeenCalledTimes(1);
      expect(enqueueAgentResumeOnce).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        organizationId: ORG_A,
        userId: "user-1",
        webhookUrl: undefined,
      });
      expect(triggerImmediate).toHaveBeenCalledTimes(1);
    },
  );

  test("does not call the sync resume provider after deletion fences during enqueue", async () => {
    let deletionFenceCommitted = false;
    enqueueAgentResumeOnce.mockImplementationOnce(async () => {
      deletionFenceCommitted = true;
      return {
        job: { id: "resume-job-race", status: "pending" },
        created: true,
      };
    });

    const response = await post("?sync=true");

    expect(response.status).toBe(202);
    expect(deletionFenceCommitted).toBe(true);
    expect(enqueueAgentResumeOnce).toHaveBeenCalledTimes(1);
    expect(provision).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects sync=%s before credit gate, provision, and enqueue",
    async (token) => {
      const response = await post(`?sync=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid sync");
      expect(getAgentForWrite).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?sync=false&sync=true",
    "?sync=true&sync=false",
    "?sync=true&sync=true",
    "?sync=&sync=false",
  ])(
    "rejects ambiguous duplicate query %s without side effects",
    async (query) => {
      const response = await post(query);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid sync" });
      expect(getAgentForWrite).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
    },
  );
});
