/** Exercises synchronous-agent creation flag validation before side effects. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const findOrCreateUserByWalletAddress = mock(async (walletAddress: string) => ({
  isNewAccount: true,
  initialCreditsGranted: false,
  initialFreeCreditsUsd: 0,
  user: {
    id: "agent-wallet-user",
    organization_id: "agent-wallet-org",
    wallet_address: walletAddress,
  },
}));
const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 5,
}));
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const findByTokenAddress = mock(
  async (): Promise<{ id: string } | null> => null,
);
const findLatestByCharacterId = mock(
  async (): Promise<{ id: string } | null> => null,
);
const createCharacter = mock(async (input: Record<string, unknown>) => ({
  id: "character-1",
  token_address: input.token_address,
  token_chain: input.token_chain,
  token_name: input.token_name,
  token_ticker: input.token_ticker,
}));
const deleteCharacter = mock(async () => undefined);
const createAgent = mock(async (input: Record<string, unknown>) => ({
  agent: {
    id: "cloud-agent-1",
    input,
  },
}));
const provisionAgent = mock(async () => ({
  success: true,
  sandboxRecord: {
    id: "cloud-agent-1",
    container_name: "container-worker",
    sandbox_id: null,
    bridge_url: "https://runtime.example.test",
    status: "running",
    last_heartbeat_at: null,
    node_id: "node-1",
    error_message: null,
    database_status: "ready",
    agent_config: {},
  },
}));
const enqueueAgentProvision = mock(async () => ({ id: "job-1" }));

class AgentImageNotAllowedError extends Error {
  readonly image: string;
  readonly reason: "not_allowlisted" | "not_digest_pinned";
  constructor(image: string, reason: "not_allowlisted" | "not_digest_pinned") {
    super(
      `Docker image '${image}' is not in the managed-agent image allowlist.`,
    );
    this.name = "AgentImageNotAllowedError";
    this.image = image;
    this.reason = reason;
  }
}

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
  validateServiceKey: requireServiceKey,
}));
mock.module("@/lib/services/wallet-signup", () => ({
  findOrCreateUserByWalletAddress,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({ error: "worker unavailable" }),
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByTokenAddress },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findLatestByCharacterId },
}));
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { create: createCharacter, delete: deleteCharacter },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError,
  AgentQuotaExceededError: class AgentQuotaExceededError extends Error {},
  elizaSandboxService: { createAgent, provision: provisionAgent },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentProvision },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const VALID_BODY = {
  tokenContractAddress: "0x0000000000000000000000000000000000000009",
  chain: "bsc",
  chainId: 56,
  tokenName: "Waifu Smoke",
  tokenTicker: "WSMOKE",
  launchType: "native",
  character: { name: "Smoke Agent" },
  account: {
    primaryWalletAddress: "0x0000000000000000000000000000000000000001",
    chainType: "evm",
  },
  container: {
    image: "registry.example.test/waifu-agent:latest",
  },
};

function post(query = "") {
  return app.fetch(
    new Request(`https://api.example.test/${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Service-Key": "svc",
      },
      body: JSON.stringify(VALID_BODY),
    }),
    { WAIFU_SERVICE_KEY: "svc" },
  );
}

describe("POST /api/v1/agents sync identity", () => {
  beforeEach(() => {
    requireServiceKey.mockClear();
    findOrCreateUserByWalletAddress.mockClear();
    checkAgentCreditGate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    findByTokenAddress.mockClear();
    findLatestByCharacterId.mockClear();
    createCharacter.mockClear();
    deleteCharacter.mockClear();
    createAgent.mockClear();
    provisionAgent.mockClear();
    enqueueAgentProvision.mockClear();
  });

  test.each(["", "?sync=", "?sync=false"])(
    "accepts %s as async service create",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(202);
      expect(requireServiceKey).toHaveBeenCalledTimes(1);
      expect(createCharacter).toHaveBeenCalledTimes(1);
      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
      expect(provisionAgent).not.toHaveBeenCalled();
    },
  );

  test("accepts sync=true as the blocking-fallback token", async () => {
    const response = await post("?sync=true");
    expect(response.status).toBe(201);
    expect(requireServiceKey).toHaveBeenCalledTimes(1);
    expect(provisionAgent).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects sync=%s before lookup, credit gate, create, and enqueue",
    async (token) => {
      const response = await post(`?sync=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid sync");
      expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createCharacter).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
      expect(provisionAgent).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
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
      expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(createCharacter).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
      expect(provisionAgent).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
    },
  );
});
