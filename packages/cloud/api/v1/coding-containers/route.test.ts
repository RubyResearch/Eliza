/** Exercises cloud API v1 coding containers route.test behavior with deterministic Worker route fixtures. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
type CreditGateResult = { allowed: boolean; balance: number; error?: string };
const checkAgentCreditGate = mock(
  async (): Promise<CreditGateResult> => ({ allowed: true, balance: 5 }),
);
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const createCodingContainerAgent = mock(async () => ({
  idempotent: true,
  agent: {
    id: "fc649701-7443-42e4-aefe-a5e4882eee9e",
    status: "running",
    bridge_url: "http://100.64.0.2:3000",
    health_url: "http://100.64.0.2:3000/health",
    headscale_ip: "100.64.0.2",
    created_at: new Date("2026-06-04T08:47:41.232Z"),
  },
}));
const updateAgentEnvironment = mock(async () => undefined);
const enqueueAgentProvisionOnce = mock(async () => ({
  job: {
    id: "job-1",
  },
}));
const getJobForOrg = mock(async () => undefined);
const triggerImmediate = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/eliza-agent-web-ui", () => ({
  getAgentBaseDomain: () => "elizacloud.ai",
  getElizaAgentDirectWebUiUrl: () => null,
  getElizaAgentPublicWebUiUrl: (sandbox: { id: string }) =>
    `https://${sandbox.id}.elizacloud.ai`,
}));

// The route imports this class for its instanceof quota branch; the mocked
// module must export it or the route module fails to load.
class AgentQuotaExceededError extends Error {
  constructor(
    readonly count: number,
    readonly max: number,
  ) {
    super(`Agent quota exceeded: ${count}/${max}`);
    this.name = "AgentQuotaExceededError";
  }
}

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentQuotaExceededError,
  elizaSandboxService: {
    createCodingContainerAgent,
    getAgent: mock(async () => undefined),
    updateAgentEnvironment,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
    getJobForOrg,
    triggerImmediate,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "worker unavailable",
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

// Per-org namespace extension (the DB seam). Default: no grant — the platform
// env allowlist alone decides, exactly the pre-extension behavior.
const getOrgImageNamespaces = mock(
  async (_orgId: string): Promise<string[]> => [],
);

mock.module("@/lib/services/org-image-namespaces", () => ({
  getOrgImageNamespaces,
}));

const { default: app } = await import("./route");

async function postCodingContainer(image: string): Promise<Response> {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "test-key",
      },
      body: JSON.stringify({
        agent: "claude",
        container: { name: "bnancy", image },
        workspacePath: "/workspace/the-family",
        source: {
          sourceKind: "project",
          projectId: "the-family",
          rootPath: "/workspace/the-family",
        },
      }),
    }),
  );
}

describe("coding containers route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    checkProvisioningWorkerHealth.mockClear();
    createCodingContainerAgent.mockClear();
    updateAgentEnvironment.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    getJobForOrg.mockClear();
    triggerImmediate.mockClear();
    getOrgImageNamespaces.mockClear();
    getOrgImageNamespaces.mockResolvedValue([]);
    delete process.env.CONTAINER_IMAGE_REQUIRE_DIGEST;
  });

  test("creates custom-image coding containers as custom execution-tier agents", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "test-key",
        },
        body: JSON.stringify({
          agent: "claude",
          container: {
            name: "bnancy",
            image: "ghcr.io/dexploarer/bnancy:latest",
            environmentVars: {
              DISCORD_API_TOKEN: "token-ref",
            },
          },
          workspacePath: "/workspace/the-family",
          source: {
            sourceKind: "project",
            projectId: "the-family",
            rootPath: "/workspace/the-family",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createCodingContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "bnancy",
        dockerImage: "ghcr.io/dexploarer/bnancy:latest",
        executionTier: "custom",
        organizationId: "org-1",
        userId: "user-1",
      }),
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({
        idempotent: true,
        success: true,
      }),
    );
  });

  test("rejects an allowlisted-but-unpinned image with 403 when digest-pin is required", async () => {
    process.env.CONTAINER_IMAGE_REQUIRE_DIGEST = "true";

    // ghcr.io/dexploarer/* is in the default allowlist, so this passes the
    // allowlist gate but fails the digest-pin gate (mutable :latest).
    const response = await postCodingContainer(
      "ghcr.io/dexploarer/bnancy:latest",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: false,
        code: "CODING_CONTAINER_IMAGE_NOT_DIGEST_PINNED",
      }),
    );
    expect(createCodingContainerAgent).not.toHaveBeenCalled();
  });

  test("accepts a digest-pinned image when digest-pin is required", async () => {
    process.env.CONTAINER_IMAGE_REQUIRE_DIGEST = "true";

    const response = await postCodingContainer(
      `ghcr.io/dexploarer/bnancy@sha256:${"a".repeat(64)}`,
    );

    expect(response.status).toBe(200);
    expect(createCodingContainerAgent).toHaveBeenCalledTimes(1);
  });

  // Regression for the free-compute leak (#10554, finding 3): a metered coding
  // container is paid compute, so a $0/negative org must be blocked at the same
  // credit gate every sibling provision route enforces — the route's downstream
  // 402 poll branch is dead, so this gate is the only real block.
  test("blocks provisioning with 402 when the org has insufficient credits", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });

    const response = await postCodingContainer(
      "ghcr.io/dexploarer/bnancy:latest",
    );

    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      success: false;
      code: "insufficient_credits";
      error: string;
      currentBalance: number;
      requiredBalance: number;
    };
    // Exact-match on purpose: the canonical insufficientCredits402 wire shape.
    expect(body).toEqual({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits",
      currentBalance: 0,
      requiredBalance: AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    // The gate must short-circuit BEFORE any paid compute is provisioned.
    expect(createCodingContainerAgent).not.toHaveBeenCalled();
  });

  test("provisions when the org is funded (passes the credit gate)", async () => {
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: true,
      balance: 12.5,
    });

    const response = await postCodingContainer(
      "ghcr.io/dexploarer/bnancy:latest",
    );

    expect(response.status).toBe(200);
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(createCodingContainerAgent).toHaveBeenCalledTimes(1);
  });

  // Per-org namespace extension (the normie 403 fix, #8434 lane): an image
  // outside the platform env allowlist deploys ONLY when the caller's org
  // carries an operator grant for that namespace; every other org still 403s.
  test("rejects an off-allowlist image with 403 when the org has no namespace grant", async () => {
    const response = await postCodingContainer("ghcr.io/nubscarson/my-app:v1");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: false,
        code: "CODING_CONTAINER_IMAGE_NOT_ALLOWED",
      }),
    );
    // The org extension WAS consulted (for the caller's org) and denied.
    expect(getOrgImageNamespaces).toHaveBeenCalledWith("org-1");
    expect(createCodingContainerAgent).not.toHaveBeenCalled();
  });

  test("allows an image under the org's operator-granted namespace", async () => {
    getOrgImageNamespaces.mockResolvedValueOnce(["ghcr.io/nubscarson/*"]);

    const response = await postCodingContainer("ghcr.io/nubscarson/my-app:v1");

    expect(response.status).toBe(200);
    expect(getOrgImageNamespaces).toHaveBeenCalledWith("org-1");
    expect(createCodingContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerImage: "ghcr.io/nubscarson/my-app:v1",
        organizationId: "org-1",
      }),
    );
  });

  test("a platform-allowlisted image never consults the org extension (fast path)", async () => {
    const response = await postCodingContainer(
      "ghcr.io/dexploarer/bnancy:latest",
    );

    expect(response.status).toBe(200);
    expect(getOrgImageNamespaces).not.toHaveBeenCalled();
  });
});
