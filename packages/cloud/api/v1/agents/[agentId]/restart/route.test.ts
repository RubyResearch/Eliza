/** Exercises cloud API v1 agents agentid restart route.test behavior with deterministic Worker route fixtures. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(async () => ({
  id: "cloud-agent-1",
  organization_id: "agent-org",
  user_id: "agent-user",
}));
const getAgentForWrite = mock(async () => ({
  id: "cloud-agent-1",
  organization_id: "agent-org",
  status: "running",
}));
const enqueueAgentRestartOnce = mock(
  async (): Promise<{
    job: {
      id: string;
      data: { agentId: string; stateLossAcknowledged?: boolean };
    };
    created: boolean;
  }> => ({
    job: { id: "restart-job-1", data: { agentId: "cloud-agent-1" } },
    created: true,
  }),
);
const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "Insufficient credits",
}));

class AgentQuotaExceededError extends Error {}

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
  validateServiceKey,
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentQuotaExceededError,
  elizaSandboxService: {
    getAgentById,
    getAgentForWrite,
  },
}));

// The route no longer runs shutdown()+provision() inline; it enqueues an
// `agent_restart` job that the orchestrator daemon executes atomically.
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentRestartOnce,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: restartRoute } = await import("./route");

describe("service agent restart route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/restart", restartRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    validateServiceKey.mockClear();
    getAgentById.mockClear();
    getAgentForWrite.mockClear();
    getAgentForWrite.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "running",
    });
    enqueueAgentRestartOnce.mockClear();
    enqueueAgentRestartOnce.mockResolvedValue({
      job: { id: "restart-job-1", data: { agentId: "cloud-agent-1" } },
      created: true,
    });
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });
  });

  test("blocks a service-key restart when the agent wallet org has insufficient credits", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits",
      requiredBalance: AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
      currentBalance: 0,
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("agent-org");
    // The restart job is never enqueued and billing is never reactivated when
    // the credit gate fails — the gate short-circuits before either.
    expect(enqueueAgentRestartOnce).not.toHaveBeenCalled();
  });

  test("enqueues a restart job for daemon-side atomic debt settlement", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    // The restart is delegated to the orchestrator via an enqueued job carrying
    // the agent owner identity; its executor settles debt before provider I/O.
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-org",
      userId: "agent-user",
      stateLossAcknowledged: false,
    });
  });

  test("threads an explicit state-loss waiver into the restart job (#18228)", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    enqueueAgentRestartOnce.mockResolvedValueOnce({
      job: {
        id: "restart-job-1",
        data: { agentId: "cloud-agent-1", stateLossAcknowledged: true },
      },
      created: true,
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: {
            "X-Service-Key": "svc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stateLossAcknowledged: true }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-org",
      userId: "agent-user",
      stateLossAcknowledged: true,
    });
  });

  test("treats a non-literal-true waiver value as absent", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: {
            "X-Service-Key": "svc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stateLossAcknowledged: "true" }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith(
      expect.objectContaining({ stateLossAcknowledged: false }),
    );
  });

  test("refuses to silently drop the waiver when a non-waived restart is already in flight", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    enqueueAgentRestartOnce.mockResolvedValueOnce({
      job: { id: "restart-job-1", data: { agentId: "cloud-agent-1" } },
      created: false,
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: {
            "X-Service-Key": "svc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stateLossAcknowledged: true }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      jobId: "restart-job-1",
    });
  });

  test("accepts a waived request that dedupes onto an in-flight job already carrying the waiver", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    enqueueAgentRestartOnce.mockResolvedValueOnce({
      job: {
        id: "restart-job-1",
        data: { agentId: "cloud-agent-1", stateLossAcknowledged: true },
      },
      created: false,
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: {
            "X-Service-Key": "svc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stateLossAcknowledged: true }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  test("rejects a restart while the agent is still provisioning", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    getAgentForWrite.mockResolvedValueOnce({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "provisioning",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/restart",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    expect(enqueueAgentRestartOnce).not.toHaveBeenCalled();
  });
});
