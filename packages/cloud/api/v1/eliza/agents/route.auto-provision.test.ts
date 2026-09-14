/**
 * Exercises the real Hono agent-create handler's `autoProvision` boundary
 * while replacing its authentication, billing, and persistence collaborators.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const ownerCredentialFixture = (prefix: string): string =>
  `${prefix}${["legacy", "owner", "credential", "fixture"].join("-")}`;
const ownerProviderTokenFixture = (): string =>
  ["provider returned ghp_", "a".repeat(36)].join("");

const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "insufficient",
}));
const createAgent = mock(async () => ({
  agent: {
    id: "agent-1",
    agent_name: "keep-offline",
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    execution_tier: "dedicated-always",
  },
  idempotent: true,
}));
const listAgents = mock(async () => [] as Array<Record<string, unknown>>);
const getActiveAgentLifecycleJobsForOrg = mock(
  async () => [] as Array<Record<string, unknown>>,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_A,
  }),
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/agent-billing-gate-402", () => ({
  insufficientCredits402: () => ({ error: "insufficient credits" }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError: class AgentImageNotAllowedError extends Error {},
  AgentQuotaExceededError: class AgentQuotaExceededError extends Error {},
  elizaSandboxService: { createAgent, listAgents },
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganizationForWrite: mock(async () => null),
    findByIdsInOrganization: mock(async () => []),
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { delete: mock(async () => undefined) },
}));
mock.module("@/lib/services/eliza-agent-config", () => ({
  readPersonalElizaCutover: () => undefined,
  stripReservedElizaConfigKeys: (config: unknown) => config ?? {},
  withReusedElizaCharacterOwnership: (config: unknown) => config,
}));
mock.module("@/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment: mock(async () => ({
    changed: false,
    environmentVars: {},
  })),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision: mock(async () => ({ id: "job-1" })),
    getActiveAgentLifecycleJobsForOrg,
    triggerImmediate: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: mock(async () => ({ ok: true })),
  provisioningWorkerFailureBody: () => ({ error: "worker" }),
}));
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: { publicBaseDomain: () => null },
}));
mock.module("@/lib/eliza-agent-web-ui", () => ({
  getConfiguredElizaAgentPublicWebUiUrl: () => "https://example.test",
}));
mock.module("@/lib/constants/agent-sandbox-quota", () => ({
  getMaxNonTerminalAgentsForOrg: () => 3,
}));
mock.module("@/lib/services/shared-runtime/agent-tier", () => ({
  getAgentTier: (input: { alwaysOn?: boolean; dockerImage?: string }) =>
    input.dockerImage
      ? "custom"
      : input.alwaysOn
        ? "dedicated-always"
        : "shared",
  tierProvisionsEagerly: (tier: string) =>
    tier === "dedicated-always" || tier === "custom",
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
  ValidationError: (message: string) => {
    const error = new Error(message);
    error.name = "ValidationError";
    return error;
  },
}));

const { default: agentsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents", agentsRoute);
  return app;
}

function post(
  query = "",
  acceptance: string | null = "dedicated-compute-v1:USD:0.150000:0.300000",
) {
  return buildApp().request(
    `/api/v1/eliza/agents${query}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(acceptance === null
          ? {}
          : { "X-Eliza-Dedicated-Price": acceptance }),
      },
      body: JSON.stringify({ agentName: "keep-offline", alwaysOn: true }),
    },
    ENV,
  );
}

function get() {
  return buildApp().request("/api/v1/eliza/agents", {}, ENV);
}

test("GET reconnects an agent row to its newest active lifecycle job", async () => {
  listAgents.mockImplementationOnce(async () => [
    {
      id: "agent-1",
      agent_name: "Ada",
      status: "provisioning",
      database_status: "provisioning",
      last_backup_at: null,
      last_heartbeat_at: null,
      error_message: null,
      created_at: new Date("2026-08-21T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:01:00.000Z"),
      character_id: null,
      agent_config: {},
      docker_image: null,
      execution_tier: "dedicated-always",
    },
  ]);
  getActiveAgentLifecycleJobsForOrg.mockImplementationOnce(async () => [
    {
      id: "job-1",
      type: "agent_provision",
      status: "in_progress",
      agent_id: "agent-1",
      attempts: 1,
      max_attempts: 3,
      estimated_completion_at: new Date("2026-08-21T00:05:00.000Z"),
      scheduled_for: new Date("2026-08-21T00:00:00.000Z"),
      started_at: new Date("2026-08-21T00:00:05.000Z"),
      created_at: new Date("2026-08-21T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:01:00.000Z"),
    },
  ]);

  const response = await get();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: Array<{ activeJob: { id: string; attempts: number } | null }>;
  };
  expect(body.data[0]?.activeJob).toMatchObject({ id: "job-1", attempts: 1 });
});

test("GET fails closed when legacy agent history contains an internal stack", async () => {
  listAgents.mockImplementationOnce(async () => [
    {
      id: "agent-1",
      agent_name: "Ada",
      status: "error",
      database_status: "ready",
      last_backup_at: null,
      last_heartbeat_at: null,
      error_message:
        "Provisioning permanently failed: Sandbox health check timed out\n    at ProvisioningJobService.executeAgentProvision (/opt/eliza/packages/cloud/shared/src/lib/services/provisioning-jobs.ts:6003:13)",
      created_at: new Date("2026-08-21T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:01:00.000Z"),
      character_id: null,
      agent_config: {},
      docker_image: null,
      execution_tier: "dedicated-always",
    },
  ]);

  const response = await get();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: Array<{ errorMessage: string | null }>;
  };
  expect(body.data[0]?.errorMessage).toBe(
    "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
  );
});

test.each([
  "ENOENT [/srv/eliza/agents/agent-1/config.json]",
  "ENOENT: //srv/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/srv/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/workspace/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/app/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/data/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/nix/store/secret/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=//internal-host/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/callback/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/v1/chat/private/agents/agent-1/config.json",
  "Provider https://api.eliza.app(/srv/eliza/agents/agent-1/config.json)",
  "Provider https://api.eliza.app,C:\\eliza\\agents\\agent-1\\config.json",
  "Provider https://api.eliza.app?debug=%20%2Fsrv%2Feliza%2Fagents%2Fagent-1%2Fconfig.json",
  "Provider https://api.eliza.app?debug=%09%2Fworkspace%2Feliza%2Fagents%2Fagent-1%2Fconfig.json",
  "Provider https://api.eliza.app?%2Fsrv%2Feliza%2Fagents%2Fagent-1%2Fconfig.json=debug",
  "Provider https://api.eliza.app?debug=context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json=debug",
  "Provider https://api.eliza.app/#context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?debug=prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json=debug",
  "Provider https://api.eliza.app/#prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  ownerCredentialFixture("Authorization: Bearer "),
  ownerCredentialFixture("CEREBRAS_API_KEY="),
  ownerCredentialFixture("access_token="),
  ownerProviderTokenFixture(),
  "NODE_ENV=production",
  "CUSTOM_VALUE=fixture-value",
  "request failed at http://100.64.23.9:3000/api/status",
  "request failed at http://10.0.0.4:3000/api/status",
  "request failed at http://172.20.0.1:3000/api/status",
  "request failed at http://192.168.1.2:3000/api/status",
  "request failed at http://127.0.0.1:3000/api/status",
  "request failed at http://169.254.169.254/latest/meta-data",
  "request failed at http://[fd00::1]:3000/api/status",
  "request failed at http://[::1]:3000/api/status",
  "request failed at http://[fe80::1]:3000/api/status",
  "request failed at http://db.internal:5432/status",
  "request failed at https://service.eliza.local/status",
])(
  "GET re-sanitizes legacy private diagnostics at the list DTO: %s",
  async (message) => {
    listAgents.mockImplementationOnce(async () => [
      {
        id: "agent-1",
        agent_name: "Ada",
        status: "error",
        database_status: "ready",
        last_backup_at: null,
        last_heartbeat_at: null,
        error_message: message,
        created_at: new Date("2026-08-21T00:00:00.000Z"),
        updated_at: new Date("2026-08-21T00:01:00.000Z"),
        character_id: null,
        agent_config: {},
        docker_image: null,
        execution_tier: "dedicated-always",
      },
    ]);

    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ errorMessage: string | null }>;
    };
    expect(body.data[0]?.errorMessage).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
    expect(JSON.stringify(body)).not.toContain(message);
  },
);

describe("POST /api/v1/eliza/agents autoProvision identity", () => {
  beforeEach(() => {
    checkAgentCreditGate.mockClear();
    createAgent.mockClear();
  });

  test.each([null, "dedicated-compute-v1:USD:0.010000:0.020000", "invalid"])(
    "requires reviewed pricing before eager creation (%s)",
    async (acceptance) => {
      const response = await post("", acceptance);
      expect(response.status).toBe(428);
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    },
  );

  test.each(["", "?autoProvision=", "?autoProvision=true"])(
    "accepts %s as eager-provision (credit gate runs)",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(402);
      expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
      expect(createAgent).not.toHaveBeenCalled();
    },
  );

  test("accepts autoProvision=false as skip the credit gate", async () => {
    const response = await post("?autoProvision=false", null);
    expect(response.status).toBe(200);
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects autoProvision=%s before credit gate and create",
    async (token) => {
      const response = await post(
        `?autoProvision=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as unknown;
      expect(responseBody).toEqual({
        success: false,
        error: "Invalid autoProvision",
        message: 'autoProvision must be "true" or "false".',
      });
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?autoProvision=false&autoProvision=true",
    "?autoProvision=false&autoProvision=false",
  ])(
    "rejects duplicate autoProvision values before side effects",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(400);
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    },
  );
});
