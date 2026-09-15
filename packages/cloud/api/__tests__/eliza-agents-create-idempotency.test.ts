/**
 * POST /api/v1/eliza/agents — create-vs-reuse idempotency at the route layer.
 *
 * When elizaSandboxService.createAgent reports `idempotent: true` (the org
 * already had a non-terminal agent), the route must:
 *   - return 200 with the existing agent (created:false), NOT a fresh-create code,
 *   - NOT enqueue a second provisioning job,
 *   - NOT run the managed-env / orphan-cleanup create path.
 * The happy create path (idempotent:false) still enqueues and returns 202.
 *
 * Mocks only the module boundaries the handler imports — the route logic itself
 * is real.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AGENT_PRICING,
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

const checkAgentCreditGate = mock(
  async (): Promise<{ allowed: boolean; balance: number; error?: string }> => ({
    allowed: true,
    balance: 100,
  }),
);
const checkProvisioningWorkerHealth = mock(
  async (): Promise<{ ok: boolean; status?: number; code?: string }> => ({
    ok: true,
  }),
);
const prepareManagedElizaEnvironment = mock(async () => ({
  changed: false,
  environmentVars: {},
}));

const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);

const claimWarmContainer = mock(async () => null);
const listByOrganization = mock(async () => []);
const sandboxDelete = mock(async () => undefined);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer,
    listByOrganization,
    delete: sandboxDelete,
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

// Mirror the real exported errors so the route's `instanceof` checks work.
class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super(
      `Agent quota exceeded: your organization already has ${count} active agents (limit ${max}).`,
    );
    this.name = "AgentQuotaExceededError";
    this.count = count;
    this.max = max;
  }
}

class AgentImageNotAllowedError extends Error {
  readonly image: string;
  readonly reason: "not_allowlisted" | "not_digest_pinned";
  constructor(image: string, reason: "not_allowlisted" | "not_digest_pinned") {
    super(`Docker image '${image}' is not allowed.`);
    this.name = "AgentImageNotAllowedError";
    this.image = image;
    this.reason = reason;
  }
}

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    createAgent,
    updateAgentEnvironment,
    listAgents,
  },
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
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
    status: "provisioning",
    execution_tier: "custom",
    created_at: new Date("2026-06-24T00:00:00.000Z"),
    agent_config: {},
    character_id: null,
  };
}

async function postCreate(
  body: unknown,
  priceAcceptance: string | null = getDedicatedComputePriceAcceptance(),
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (priceAcceptance !== null)
    headers.set(DEDICATED_COMPUTE_PRICE_HEADER, priceAcceptance);
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/v1/eliza/agents — reuse idempotency", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    createAgent.mockReset();
    updateAgentEnvironment.mockClear();
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    checkAgentCreditGate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    checkProvisioningWorkerHealth.mockResolvedValue({ ok: true });
    sandboxDelete.mockClear();
    prepareManagedElizaEnvironment.mockClear();
    loggerInfo.mockClear();
    loggerError.mockClear();
  });

  test.each([null, "expired-price-acceptance"])(
    "rejects missing or stale price acceptance before provisioning: %s",
    async (priceAcceptance) => {
      const response = await postCreate(
        { agentName: "alpha", dockerImage: "ghcr.io/example/agent:latest" },
        priceAcceptance,
      );
      expect(response.status).toBe(428);
      expect(createAgent).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
      expect(prepareManagedElizaEnvironment).not.toHaveBeenCalled();
    },
  );

  test("(d) reuse → 200 with the existing agent, no second provision job", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      created: boolean;
      data: { id: string; agentId: string };
    };
    expect(json.success).toBe(true);
    expect(json.created).toBe(false);
    expect(json.data.id).toBe(agent.id);
    expect(json.data.agentId).toBe(agent.id);

    // The whole point: a reused agent is already provisioned / in flight, so we
    // never enqueue a second job and never touch the managed-env create path.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(prepareManagedElizaEnvironment).not.toHaveBeenCalled();
  });

  test("fresh create (idempotent:false) still enqueues a job and returns 202", async () => {
    const agent = { ...pendingAgent(), status: "pending" };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        jobId: string;
        agentName: string;
        createdAt: string;
        executionTier: string;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.jobId).toBe("job-1");
    expect(json.data).toMatchObject({
      agentName: "alpha",
      createdAt: "2026-06-24T00:00:00.000Z",
      executionTier: "custom",
    });
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("insufficient credits -> 402 with the canonical flat body (no nested details)", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      error: "Insufficient credits. Please add funds.",
    });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      success: false;
      code: "insufficient_credits";
      error: string;
      requiredBalance: number;
      currentBalance: number;
    };
    // Exact-match on purpose: this is the one insufficient-credits wire shape
    // shared by every credit-gated route (insufficientCredits402).
    expect(body).toEqual({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits. Please add funds.",
      requiredBalance: AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
      currentBalance: 0,
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("forceCreate:true bypasses the reuse guard → createAgent called with reuseExistingNonTerminal:false (mints a SEPARATE agent)", async () => {
    // The org already has a non-terminal agent (the shared bridge). With
    // forceCreate the route must NOT let createAgent reuse it — the dedicated
    // handoff target has to be a distinct record, else dedicatedId === sharedId.
    const agent = {
      ...pendingAgent(),
      id: "dedicated-fresh",
      status: "pending",
    };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: true,
    });

    expect(res.status).toBe(202);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
      maxNonTerminalAgents?: number;
    };
    expect(passed.reuseExistingNonTerminal).toBe(false);
    // #11023: a user-facing forceCreate must be bounded by the org's balance
    // tier — $100 balance → the top (500) ceiling — so it can't mint unbounded
    // dedicated containers.
    expect(passed.maxNonTerminalAgents).toBe(500);
    // A fresh create still provisions normally.
    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("#11023: a forceCreate that exceeds the org's per-org quota → 429, no provision job", async () => {
    // At the credit tier's ceiling, the atomic quota check in createAgent throws;
    // the route must surface 429 (not 500) and never enqueue provisioning.
    createAgent.mockRejectedValue(new AgentQuotaExceededError(500, 500));

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: true,
    });

    // The security-relevant behavior: the quota rejection maps to 429 (not a 500
    // or a silent success) and NO provisioning is enqueued. (Body serialization
    // is provided by the worker's onError middleware, not mounted in this bare
    // test app — matches the sibling 400 test, which also asserts status only.)
    expect(res.status).toBe(429);
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  test("#11023 F3: default (no forceCreate) create passes the SAME balance-tiered cap as forceCreate", async () => {
    // Suspended (`stopped`) / slept (`sleeping`) agents keep their per-tenant
    // managed DB but are not LIVE, so after a suspend the reuse guard has
    // nothing to hand back — an uncapped normal path would mint a fresh row on
    // every create (the create→suspend→create fleet-DoS loop, the residual of
    // #11023). The route must bound the reuse path's fresh insert too.
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
      maxNonTerminalAgents?: number;
    };
    expect(passed.reuseExistingNonTerminal).toBe(true);
    expect(passed.maxNonTerminalAgents).toBe(500);
  });

  test("forceCreate:true on a SHARED-tier create is rejected (400) — no unmetered shared mint past the reuse guard", async () => {
    // A shared create skips the credit gate, so forceCreate must NOT let a
    // caller bypass the reuse ceiling and spam unmetered shared rows. The only
    // legit forceCreate caller (the shared→dedicated handoff) always targets a
    // dedicated (alwaysOn) agent, so forceCreate + shared has no valid use.
    const res = await postCreate({
      agentName: "alpha",
      // no dockerImage / alwaysOn / persistent plugins → getAgentTier === "shared"
      forceCreate: true,
    });

    expect(res.status).toBe(400);
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("default (no forceCreate) still reuses → createAgent called with reuseExistingNonTerminal:true (byte-identical to before)", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(200);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
    };
    expect(passed.reuseExistingNonTerminal).toBe(true);
  });

  test("forceCreate:false (explicit) is treated as the default → reuseExistingNonTerminal:true", async () => {
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: false,
    });

    const passed = createAgent.mock.calls[0]?.[0] as {
      reuseExistingNonTerminal?: boolean;
    };
    expect(passed.reuseExistingNonTerminal).toBe(true);
  });

  test("#15516: a provisioning-worker outage does NOT block idempotent reuse", async () => {
    // Reuse enqueues nothing, so worker capacity is irrelevant to it. The
    // route must let createAgent's locked idempotency guard run before the
    // enqueue-boundary worker gate; otherwise a heartbeat gap 503s first-run
    // onboarding for a user whose agent needs no provisioning (#15516).
    checkProvisioningWorkerHealth.mockResolvedValue({
      ok: false,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
    });
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { created: boolean };
    expect(json.created).toBe(false);
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(sandboxDelete).not.toHaveBeenCalled();
  });

  test("#15516: worker outage on a fresh async create fails closed and rolls back the pending row", async () => {
    checkProvisioningWorkerHealth.mockResolvedValue({
      ok: false,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
    });
    const agent = { ...pendingAgent(), status: "pending" };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("PROVISIONING_WORKER_UNHEALTHY");
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(sandboxDelete).toHaveBeenCalledTimes(1);
    expect(sandboxDelete).toHaveBeenCalledWith(agent.id, "org-1");
  });

  test("#15516: worker-outage cleanup failure still returns the canonical 503", async () => {
    checkProvisioningWorkerHealth.mockResolvedValue({
      ok: false,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
    });
    sandboxDelete.mockRejectedValueOnce(new Error("delete unavailable"));
    const agent = pendingAgent();
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("PROVISIONING_WORKER_UNHEALTHY");
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[agent-api] Failed to roll back agent after worker-health gate",
      expect.objectContaining({
        agentId: agent.id,
        orgId: "org-1",
        error: "delete unavailable",
      }),
    );
  });

  test("#15516: forceCreate never bypasses the enqueue-boundary worker gate", async () => {
    // forceCreate explicitly opts out of reuse, so its create WILL enqueue —
    // the worker gate must keep protecting it even if the org has another
    // reusable agent.
    checkProvisioningWorkerHealth.mockResolvedValue({
      ok: false,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
    });
    const agent = {
      ...pendingAgent(),
      id: "dedicated-fresh",
      status: "pending",
    };
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      forceCreate: true,
    });

    expect(res.status).toBe(503);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(sandboxDelete).toHaveBeenCalledTimes(1);
    expect(sandboxDelete).toHaveBeenCalledWith(agent.id, "org-1");
  });
});
