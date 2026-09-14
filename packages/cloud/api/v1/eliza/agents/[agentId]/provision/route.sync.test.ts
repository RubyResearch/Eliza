/**
 * POST /api/v1/eliza/agents/:id/provision `sync` is provision-wait identity,
 * leftover tax after agent-resume sync (#21099). Stock develop treated any
 * non-exact `true` token as async, so `sync=TRUE` still enqueued a 202 job
 * instead of the blocking fallback. The compatibility path is also fenced to
 * canonical, user-owned, live container capacity. Credit /
 * warm-pool / enqueue parsers stay intact while the compatibility token routes
 * through the admitted queue instead of calling a provider inline.
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
const AGENT_ID = "agent-provision-1";
const ENV = {
  NODE_ENV: "test",
  ELIZA_CLOUD_AGENT_BASE_DOMAIN: "staging.elizacloud.ai",
} as unknown as AppEnv["Bindings"];

type ProvisionAgent = {
  id: string;
  organization_id: string;
  agent_name: string;
  execution_tier: string;
  status: string;
  bridge_url: string | null;
  health_url: string | null;
  pool_status: AgentSandboxPoolStatus | null;
  deleted_at: Date | null;
  deletion_attempt_id: string | null;
  lifecycle_revision: number;
  agent_config: Record<string, unknown> | null;
  character_id: string | null;
};

function provisionAgent(
  overrides: Partial<ProvisionAgent> = {},
): ProvisionAgent {
  return {
    id: AGENT_ID,
    organization_id: ORG_A,
    agent_name: "already-up",
    execution_tier: "dedicated-always",
    status: "running",
    bridge_url: "http://100.64.0.12:19027",
    health_url: "http://10.0.0.8:19028/health",
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    lifecycle_revision: 1,
    agent_config: null,
    character_id: null,
    ...overrides,
  };
}

const getAgentForWrite = mock(
  async (): Promise<ProvisionAgent | null> => provisionAgent(),
);
const provision = mock(async () => ({
  success: true,
  bridgeUrl: "https://bridge.example.test",
  healthUrl: "https://health.example.test",
  sandboxRecord: {
    id: AGENT_ID,
    agent_name: "provisioned-agent",
    status: "running",
  },
}));
const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 5,
  error: "",
}));
const enqueueAgentProvisionOnce = mock(async () => ({
  job: { id: "job-1", status: "queued" },
  created: true,
}));
const triggerImmediate = mock(async () => undefined);
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const claimWarmContainer = mock(async () => null);

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
  provisioningJobService: { enqueueAgentProvisionOnce, triggerImmediate },
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
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    warmPoolEnabled: () => false,
    defaultAgentImage: () => "eliza-agent:test",
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { claimWarmContainer },
}));

const { default: provisionRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents/:agentId/provision", provisionRoute);
  return app;
}

function post(
  query = "",
  acceptance: string | null = "dedicated-compute-v1:USD:0.150000:0.300000",
) {
  return buildApp().request(
    `/api/v1/eliza/agents/${AGENT_ID}/provision${query}`,
    {
      method: "POST",
      headers:
        acceptance === null ? {} : { "X-Eliza-Dedicated-Price": acceptance },
    },
    ENV,
  );
}

function expectNoProvisionEffects() {
  expect(checkAgentCreditGate).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
  expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
  expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
  expect(triggerImmediate).not.toHaveBeenCalled();
  expect(claimWarmContainer).not.toHaveBeenCalled();
}

async function expectSyncConflict(
  agent: ProvisionAgent,
  expectedError: string,
) {
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
  expectNoProvisionEffects();
}

describe("POST /api/v1/eliza/agents/:id/provision sync identity", () => {
  beforeEach(() => {
    getAgentForWrite.mockClear();
    provision.mockClear();
    checkAgentCreditGate.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    triggerImmediate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    claimWarmContainer.mockClear();
  });

  test.each([null, "dedicated-compute-v1:USD:0.010000:0.020000", "invalid"])(
    "rejects missing or stale price acceptance %s before paid effects",
    async (acceptance) => {
      getAgentForWrite.mockImplementationOnce(async () =>
        provisionAgent({
          status: "stopped",
          bridge_url: null,
          health_url: null,
        }),
      );
      const response = await post("", acceptance);
      expect(response.status).toBe(428);
      expect(await response.json()).toMatchObject({
        code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
      });
      expectNoProvisionEffects();
    },
  );

  test.each(["", "?sync=", "?sync=false"])(
    "accepts %s as async provision (already-running fast path)",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(200);
      expect(getAgentForWrite).toHaveBeenCalledTimes(1);
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
      const body = await response.json();
      expect(body).toMatchObject({
        data: {
          webUiUrl: `https://${AGENT_ID}.staging.elizacloud.ai`,
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/100\.64|10\.0|192\.168/);
    },
  );

  test("keeps an async Shared request on the existing shared-runtime fast path", async () => {
    getAgentForWrite.mockImplementationOnce(async () =>
      provisionAgent({
        execution_tier: "shared",
        status: "stopped",
        bridge_url: null,
        health_url: null,
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
    expectNoProvisionEffects();
  });

  test("keeps production sync=true fenced when the compatibility flag is disabled", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowSync = process.env.ALLOW_AGENT_SYNC_PROVISIONING;
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_AGENT_SYNC_PROVISIONING;
    getAgentForWrite.mockImplementationOnce(async () =>
      provisionAgent({
        execution_tier: "shared",
        status: "stopped",
        bridge_url: null,
        health_url: null,
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
    );

    try {
      const response = await post("?sync=true");

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false,
        error: "Agent provision requires a container-backed execution tier",
      });
      expect(getAgentForWrite).toHaveBeenCalledTimes(1);
      expectNoProvisionEffects();
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousAllowSync === undefined) {
        delete process.env.ALLOW_AGENT_SYNC_PROVISIONING;
      } else {
        process.env.ALLOW_AGENT_SYNC_PROVISIONING = previousAllowSync;
      }
    }
  });

  test("keeps production sync=true on the canonical async enqueue path when disabled", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowSync = process.env.ALLOW_AGENT_SYNC_PROVISIONING;
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_AGENT_SYNC_PROVISIONING;
    getAgentForWrite.mockImplementationOnce(async () =>
      provisionAgent({
        agent_name: "needs-provisioning",
        execution_tier: "dedicated-lazy",
        status: "stopped",
        bridge_url: null,
        health_url: null,
        pool_status: null,
        deleted_at: null,
        deletion_attempt_id: null,
      }),
    );

    try {
      const response = await post("?sync=true");

      expect(response.status).toBe(202);
      expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
      expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
      expect(checkProvisioningWorkerHealth).toHaveBeenCalledTimes(1);
      expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1);
      expect(enqueueAgentProvisionOnce).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        organizationId: ORG_A,
        userId: "user-1",
        agentName: "needs-provisioning",
        webhookUrl: undefined,
        expectedLifecycleRevision: 1,
      });
      expect(triggerImmediate).toHaveBeenCalledTimes(1);
      expect(provision).not.toHaveBeenCalled();
      expect(claimWarmContainer).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousAllowSync === undefined) {
        delete process.env.ALLOW_AGENT_SYNC_PROVISIONING;
      } else {
        process.env.ALLOW_AGENT_SYNC_PROVISIONING = previousAllowSync;
      }
    }
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
    expectNoProvisionEffects();
  });

  test("rejects a stopped Shared agent before sync provision effects", async () => {
    await expectSyncConflict(
      provisionAgent({
        execution_tier: "shared",
        status: "stopped",
        bridge_url: null,
        health_url: null,
      }),
      "Agent provision requires a container-backed execution tier",
    );
  });

  test("gives tier rejection precedence for an unknown running agent", async () => {
    await expectSyncConflict(
      provisionAgent({
        execution_tier: "future-container",
        status: "running",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent provision requires a container-backed execution tier",
    );
  });

  test("gives pool ownership precedence over deletion state", async () => {
    await expectSyncConflict(
      provisionAgent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent provision cannot target pool-owned capacity",
    );
  });

  test("gives deletion precedence over a deletion attempt", async () => {
    await expectSyncConflict(
      provisionAgent({
        execution_tier: "dedicated-always",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent provision cannot target deleted capacity",
    );
  });

  test("rejects capacity with deletion in progress", async () => {
    await expectSyncConflict(
      provisionAgent({
        execution_tier: "custom",
        status: "running",
        bridge_url: "https://bridge.example.test",
        health_url: "https://health.example.test",
        deletion_attempt_id: "22222222-2222-4222-8222-222222222222",
      }),
      "Agent provision cannot target capacity with deletion in progress",
    );
  });

  test.each([...CONTAINER_BACKED_EXECUTION_TIERS])(
    "queues canonical %s capacity on the admitted provision path",
    async (executionTier) => {
      getAgentForWrite.mockImplementationOnce(async () =>
        provisionAgent({
          agent_name: "needs-provisioning",
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
      expect(enqueueAgentProvisionOnce).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        organizationId: ORG_A,
        userId: "user-1",
        agentName: "needs-provisioning",
        webhookUrl: undefined,
        expectedLifecycleRevision: 1,
      });
      expect(checkProvisioningWorkerHealth).toHaveBeenCalledTimes(1);
      expect(triggerImmediate).toHaveBeenCalledTimes(1);
      expect(claimWarmContainer).not.toHaveBeenCalled();
    },
  );

  test("does not call the sync provision provider after deletion fences during enqueue", async () => {
    getAgentForWrite.mockImplementationOnce(async () =>
      provisionAgent({
        agent_name: "needs-provisioning",
        execution_tier: "dedicated-lazy",
        status: "stopped",
        bridge_url: null,
        health_url: null,
      }),
    );
    let deletionFenceCommitted = false;
    enqueueAgentProvisionOnce.mockImplementationOnce(async () => {
      deletionFenceCommitted = true;
      return {
        job: { id: "provision-job-race", status: "pending" },
        created: true,
      };
    });

    const response = await post("?sync=true");

    expect(response.status).toBe(202);
    expect(deletionFenceCommitted).toBe(true);
    expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1);
    expect(provision).not.toHaveBeenCalled();
    expect(claimWarmContainer).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects sync=%s before lookup, credit gate, provision, and enqueue",
    async (token) => {
      const response = await post(`?sync=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid sync");
      expect(getAgentForWrite).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
      expect(claimWarmContainer).not.toHaveBeenCalled();
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
      expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
      expect(claimWarmContainer).not.toHaveBeenCalled();
    },
  );
});
