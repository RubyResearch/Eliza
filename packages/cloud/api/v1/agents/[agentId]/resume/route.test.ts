/** Exercises cloud API v1 agents agentid resume route.test behavior with deterministic Worker route fixtures. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const getAgentById = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    user_id: string;
    status: string;
    execution_tier: unknown;
  }> => ({
    id: "cloud-agent-1",
    organization_id: "agent-org",
    user_id: "agent-user",
    status: "stopped",
    execution_tier: "dedicated-lazy",
  }),
);
const getAgentForWrite = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    status: string;
  } | null> => ({
    id: "cloud-agent-1",
    organization_id: "agent-org",
    status: "stopped",
  }),
);
const provision = mock(async () => ({
  success: true,
  sandboxRecord: { status: "running" },
}));
const executeResume = mock(
  async (): Promise<{
    success: boolean;
    containerStarted: boolean;
    reprovisioned: boolean;
    error?: string;
  }> => ({
    success: true,
    containerStarted: true,
    reprovisioned: true,
  }),
);
const reactivateSandboxBillingAfterFunding = mock(async () => undefined);
const settleAccruedBillingBeforeLifecycle = mock(async () => ({
  status: "already_billed_recently" as const,
}));
const checkAgentCreditGate = mock(async () => ({
  allowed: false,
  balance: 0,
  error: "Insufficient credits",
}));
const enqueueAgentResumeOnce = mock(async () => ({
  job: { id: "resume-job-1", status: "pending" },
  created: true,
}));
const triggerImmediate = mock(async () => undefined);

class AgentQuotaExceededError extends Error {}

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
}));

mock.module("@/db/repositories/agent-billing", () => ({
  agentBillingRepository: {
    reactivateSandboxBillingAfterFunding,
    settleAccruedBillingBeforeLifecycle,
  },
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentResumeOnce, triggerImmediate },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentQuotaExceededError,
  elizaSandboxService: {
    executeResume,
    getAgentById,
    getAgentForWrite,
    provision,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: resumeRoute } = await import("./route");

describe("service agent resume route", () => {
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/resume", resumeRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    getAgentById.mockClear();
    getAgentById.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      user_id: "agent-user",
      status: "stopped",
      execution_tier: "dedicated-lazy",
    });
    getAgentForWrite.mockClear();
    getAgentForWrite.mockResolvedValue({
      id: "cloud-agent-1",
      organization_id: "agent-org",
      status: "stopped",
    });
    executeResume.mockClear();
    executeResume.mockResolvedValue({
      success: true,
      containerStarted: true,
      reprovisioned: true,
    });
    provision.mockClear();
    reactivateSandboxBillingAfterFunding.mockClear();
    settleAccruedBillingBeforeLifecycle.mockClear();
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });
    enqueueAgentResumeOnce.mockClear();
    enqueueAgentResumeOnce.mockResolvedValue({
      job: { id: "resume-job-1", status: "pending" },
      created: true,
    });
    triggerImmediate.mockClear();
  });

  test("blocks service-key resume when the agent wallet org has insufficient credits", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
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
    expect(executeResume).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
    expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
    expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
  });

  for (const [label, executionTier] of [
    ["shared", "shared"],
    ["unknown", "future-container-tier"],
    ["corrupt", { tier: "custom" }],
    ["missing", undefined],
  ] as const) {
    test(`rejects ${label} tier before credit, billing, or provision`, async () => {
      getAgentById.mockResolvedValueOnce({
        id: "cloud-agent-1",
        organization_id: "agent-org",
        user_id: "agent-user",
        status: "stopped",
        execution_tier: executionTier,
      });

      const response = await app.fetch(
        new Request(
          "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
          {
            method: "POST",
            headers: { "X-Service-Key": "svc" },
          },
        ),
        { WAIFU_SERVICE_KEY: "svc" },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        status: "stopped",
        error:
          "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(executeResume).not.toHaveBeenCalled();
      expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
      expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
    });
  }

  test("queues funded service-key resume instead of calling the provider inline", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: "provisioning",
      jobId: "resume-job-1",
    });
    expect(enqueueAgentResumeOnce).toHaveBeenCalledWith({
      agentId: "cloud-agent-1",
      organizationId: "agent-org",
      userId: "agent-user",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(executeResume).not.toHaveBeenCalled();
    expect(getAgentForWrite).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
    expect(reactivateSandboxBillingAfterFunding).not.toHaveBeenCalled();
  });

  test("returns the active job without nudging a second worker", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    enqueueAgentResumeOnce.mockResolvedValueOnce({
      job: { id: "resume-job-existing", status: "in_progress" },
      created: false,
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: "provisioning",
      alreadyInProgress: true,
      jobId: "resume-job-existing",
    });
    expect(enqueueAgentResumeOnce).toHaveBeenCalledTimes(1);
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
    expect(getAgentForWrite).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(settleAccruedBillingBeforeLifecycle).not.toHaveBeenCalled();
  });

  test("does not reach an inline provider after deletion fences during enqueue", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 5,
      error: "",
    });
    let deletionFenceCommitted = false;
    enqueueAgentResumeOnce.mockImplementationOnce(async () => {
      deletionFenceCommitted = true;
      return {
        job: { id: "resume-job-race", status: "pending" },
        created: true,
      };
    });

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/agents/cloud-agent-1/resume",
        {
          method: "POST",
          headers: { "X-Service-Key": "svc" },
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    expect(deletionFenceCommitted).toBe(true);
    expect(executeResume).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });
});
