/**
 * POST /api/v1/eliza/agents — provision-time shared-runtime cache prewarm.
 *
 * A fresh shared agent's first turn is served cache-only, so every cache it
 * consults (admission snapshot, pricing, character, conversation Durable
 * Object) is cold at create time and the first send eats a 13-27s retryable
 * 503 warming wall (measured on staging, QA-MATRIX-2026-08-11 §2/§3). The
 * create route must schedule `prewarmSharedAgentTurnCaches` under the Worker
 * execution context so those caches are warm before a human can type.
 *
 * Contract under test (fails on develop, passes with the fix):
 *   - a fresh SHARED create registers the prewarm with executionCtx.waitUntil,
 *     passing the created agent row + the conversation DO namespace;
 *   - the response is returned without awaiting the prewarm (off the response
 *     path);
 *   - idempotent reuse and dedicated creates do NOT schedule it;
 *   - a missing execution context (non-Worker runtime) degrades to no prewarm
 *     instead of failing the create.
 *
 * Mocks only the module boundaries the handler imports — the route logic is
 * real (same approach as eliza-agents-create-idempotency.test.ts).
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
  steward_id: "steward-user-1",
}));

const createAgent = mock();
const updateAgentEnvironment = mock(async () => undefined);
const listAgents = mock(async () => []);

const enqueueAgentProvision = mock(async () => ({
  id: "job-1",
  status: "pending",
  estimated_completion_at: new Date("2026-08-12T00:01:30.000Z"),
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

const prewarmSharedAgentTurnCaches = mock(async () => undefined);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    claimWarmContainer: mock(async () => null),
    listByOrganization: mock(async () => []),
    delete: mock(async () => undefined),
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

class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super(`Agent quota exceeded (${count}/${max}).`);
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
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmSharedAgentTurnCaches,
}));

const { default: agentsRoute } = await import("../v1/eliza/agents/route");

const app = new Hono();
app.route("/api/v1/eliza/agents", agentsRoute);

const NAMESPACE = {
  getByName: () => ({ fetch: async () => new Response(null) }),
};

function sharedAgent() {
  return {
    id: "8e1f5f66-3f5a-45c9-9d64-2f8f8a1c2b3d",
    agent_name: "fresh-shared",
    organization_id: "org-1",
    user_id: "user-1",
    status: "running",
    execution_tier: "shared",
    created_at: new Date("2026-08-12T00:00:00.000Z"),
    agent_config: {},
    character_id: null,
  };
}

interface RegisteredWaits {
  promises: Promise<unknown>[];
}

function workerExecutionCtx(registered: RegisteredWaits) {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      registered.promises.push(promise);
    },
    passThroughOnException: () => undefined,
  };
}

async function postCreate(
  body: unknown,
  options: { executionCtx?: unknown; env?: Record<string, unknown> } = {},
) {
  return app.fetch(
    new Request("https://api.example.test/api/v1/eliza/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEDICATED_COMPUTE_PRICE_HEADER]: getDedicatedComputePriceAcceptance(),
      },
      body: JSON.stringify(body),
    }),
    options.env ?? {},
    // Hono surfaces this as c.executionCtx.
    options.executionCtx as never,
  );
}

describe("POST /api/v1/eliza/agents — shared create schedules the turn-cache prewarm", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    createAgent.mockReset();
    enqueueAgentProvision.mockClear();
    checkAgentCreditGate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    checkProvisioningWorkerHealth.mockResolvedValue({ ok: true });
    prepareManagedElizaEnvironment.mockClear();
    prewarmSharedAgentTurnCaches.mockClear();
  });

  test("fresh shared create registers the prewarm under executionCtx.waitUntil with the agent + DO namespace", async () => {
    const agent = sharedAgent();
    createAgent.mockResolvedValue({ agent, idempotent: false });
    const registered: RegisteredWaits = { promises: [] };

    const res = await postCreate(
      { agentName: "fresh-shared" },
      {
        executionCtx: workerExecutionCtx(registered),
        env: { SHARED_RUNTIME_CONVERSATIONS: NAMESPACE },
      },
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { created: boolean; source: string };
    expect(json.created).toBe(true);
    expect(json.source).toBe("shared_runtime");

    // The prewarm import + call is registered with the Worker lifetime.
    expect(registered.promises.length).toBeGreaterThan(0);
    await Promise.all(registered.promises);
    expect(prewarmSharedAgentTurnCaches).toHaveBeenCalledTimes(1);
    const [prewarmedAgent, prewarmOptions] = prewarmSharedAgentTurnCaches.mock
      .calls[0] as unknown as [
      { id: string },
      {
        namespace?: unknown;
        requestContext?: { req?: unknown };
        stewardUserId?: string;
      },
    ];
    expect(prewarmedAgent.id).toBe(agent.id);
    expect(prewarmOptions.namespace).toBe(NAMESPACE);
    // The creating request's credential/context reaches the prewarm so it can
    // seed the credential-scoped authorization entry the first message reads.
    expect(prewarmOptions.requestContext?.req).toBeDefined();
    expect(prewarmOptions.stewardUserId).toBe("steward-user-1");
  });

  test("response does not await the prewarm (off the response path)", async () => {
    const agent = sharedAgent();
    createAgent.mockResolvedValue({ agent, idempotent: false });
    let resolvePrewarm: () => void = () => undefined;
    prewarmSharedAgentTurnCaches.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolvePrewarm = () => resolve(undefined);
        }),
    );
    const registered: RegisteredWaits = { promises: [] };

    // If the route awaited the prewarm, this fetch would hang forever.
    const res = await postCreate(
      { agentName: "fresh-shared" },
      {
        executionCtx: workerExecutionCtx(registered),
        env: { SHARED_RUNTIME_CONVERSATIONS: NAMESPACE },
      },
    );
    expect(res.status).toBe(201);
    // The prewarm call happens after the route's dynamic import resolves
    // (strictly after the response above); wait for it before releasing.
    while (prewarmSharedAgentTurnCaches.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    resolvePrewarm();
    await Promise.all(registered.promises);
  });

  test("idempotent reuse does NOT schedule a prewarm (the agent already served turns)", async () => {
    const agent = sharedAgent();
    createAgent.mockResolvedValue({ agent, idempotent: true });
    const registered: RegisteredWaits = { promises: [] };

    const res = await postCreate(
      { agentName: "fresh-shared" },
      {
        executionCtx: workerExecutionCtx(registered),
        env: { SHARED_RUNTIME_CONVERSATIONS: NAMESPACE },
      },
    );

    expect(res.status).toBe(200);
    await Promise.all(registered.promises);
    expect(prewarmSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("dedicated create does NOT schedule the shared prewarm", async () => {
    const agent = {
      ...sharedAgent(),
      execution_tier: "dedicated-always",
      status: "pending",
    };
    createAgent.mockResolvedValue({ agent, idempotent: false });
    const registered: RegisteredWaits = { promises: [] };

    const res = await postCreate(
      { agentName: "fresh-dedicated", alwaysOn: true },
      {
        executionCtx: workerExecutionCtx(registered),
        env: { SHARED_RUNTIME_CONVERSATIONS: NAMESPACE },
      },
    );

    expect(res.status).toBe(202);
    await Promise.all(registered.promises);
    expect(prewarmSharedAgentTurnCaches).not.toHaveBeenCalled();
  });

  test("missing execution context (non-Worker runtime) degrades to no prewarm, create still succeeds", async () => {
    const agent = sharedAgent();
    createAgent.mockResolvedValue({ agent, idempotent: false });

    const res = await postCreate({ agentName: "fresh-shared" });

    expect(res.status).toBe(201);
    expect(prewarmSharedAgentTurnCaches).not.toHaveBeenCalled();
  });
});
