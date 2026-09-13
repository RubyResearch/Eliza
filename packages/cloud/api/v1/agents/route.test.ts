/** Exercises service-agent creation through deterministic Worker route fixtures. */

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
type CreditGateResult = { allowed: boolean; balance: number; error?: string };

const checkAgentCreditGate = mock(
  async (): Promise<CreditGateResult> => ({
    allowed: true,
    balance: 5,
  }),
);
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
const provisionAgent = mock(
  async (): Promise<{
    success: boolean;
    sandboxRecord: Record<string, unknown>;
  }> => ({
    success: true,
    sandboxRecord: {
      id: "cloud-agent-1",
      container_name: null,
      sandbox_id: null,
      bridge_url: null,
      status: "running",
      last_heartbeat_at: null,
      node_id: null,
      error_message: null,
      database_status: "ready",
      agent_config: {},
    },
  }),
);
const enqueueAgentProvision = mock(async () => ({ id: "job-1" }));

class AgentQuotaExceededError extends Error {}

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
  userCharactersRepository: {
    findByTokenAddress,
  },
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findLatestByCharacterId,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    create: createCharacter,
    delete: deleteCharacter,
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
  elizaSandboxService: {
    createAgent,
    provision: provisionAgent,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

describe("service agent provisioning route", () => {
  beforeEach(() => {
    requireServiceKey.mockClear();
    findOrCreateUserByWalletAddress.mockClear();
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 5,
    });
    checkProvisioningWorkerHealth.mockClear();
    findByTokenAddress.mockClear();
    findLatestByCharacterId.mockClear();
    findLatestByCharacterId.mockResolvedValue(null);
    createCharacter.mockClear();
    deleteCharacter.mockClear();
    createAgent.mockClear();
    provisionAgent.mockClear();
    provisionAgent.mockResolvedValue({
      success: true,
      sandboxRecord: {
        id: "cloud-agent-1",
        container_name: null,
        sandbox_id: null,
        bridge_url: null,
        status: "running",
        last_heartbeat_at: null,
        node_id: null,
        error_message: null,
        database_status: "ready",
        agent_config: {},
      },
    });
    enqueueAgentProvision.mockClear();
  });

  test("creates a wallet-owned cloud agent with the fixed signup credit", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
          tokenContractAddress: "0x0000000000000000000000000000000000000009",
          chain: "bsc",
          chainId: 56,
          tokenName: "Waifu Smoke",
          tokenTicker: "WSMOKE",
          launchType: "native",
          character: {
            name: "Smoke Agent",
            bio: "End-to-end smoke agent.",
            config: { style: "test", waifuAgentId: "waifu-smoke-agent" },
          },
          account: {
            primaryWalletAddress: "0x0000000000000000000000000000000000000001",
            walletKeyRef: "steward:waifu-smoke-key",
            chainType: "evm",
          },
          access: {
            guestTokenThreshold: 1000,
            userTokenThreshold: 100000,
            adminWalletAddress: "0x0000000000000000000000000000000000000002",
            roles: {
              admin: {
                wallets: [
                  "0x0000000000000000000000000000000000000002",
                  "0x0000000000000000000000000000000000000003",
                ],
              },
            },
          },
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
            projectName: "waifu-smoke-agent",
            port: 3000,
            cpu: 512,
            memory: 1024,
            desiredCount: 1,
            architecture: "arm64",
            healthCheckPath: "/api/health",
            env: {
              ELIZA_UI_ENABLE: "false",
              EXTRA_SETTING: "1",
              WAIFU_CHAT_ACCESS_JWT_SECRET: "waifu-chat-secret",
              WAIFU_CHAT_FRAME_ANCESTORS:
                "https://waifu.fun https://staging.waifu.fun",
            },
          },
          modelDefaults: {
            MODEL_PROVIDER: "eliza-cloud",
          },
          webhookUrl:
            "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
          webhookSecret: "test-webhook-secret",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      cloudAgentId: "cloud-agent-1",
      characterId: "character-1",
      status: "pending",
      jobId: "job-1",
      account: {
        primaryWalletAddress: "0x0000000000000000000000000000000000000001",
        walletKeyRef: "steward:waifu-smoke-key",
        organizationId: "agent-wallet-org",
        userId: "agent-wallet-user",
        isNewAccount: true,
        initialCreditsGranted: false,
        initialFreeCreditsUsd: 0,
        welcomeBonusWithheld: false,
      },
    });
    expect(requireServiceKey).toHaveBeenCalledTimes(1);
    expect(findOrCreateUserByWalletAddress).toHaveBeenCalledWith(
      "0x0000000000000000000000000000000000000001",
    );
    expect(checkAgentCreditGate).toHaveBeenCalledWith("agent-wallet-org");
    expect(createCharacter).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "agent-wallet-user",
        organization_id: "agent-wallet-org",
        token_address: "0x0000000000000000000000000000000000000009",
        token_chain: "bsc",
      }),
      {
        policy: {
          mode: "trusted",
          caller: "service-api-v1-agents",
        },
      },
    );
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-wallet-org",
        userId: "agent-wallet-user",
        dockerImage: "registry.example.test/waifu-agent:latest",
        executionTier: "custom",
        agentConfig: expect.objectContaining({
          waifuAgentId: "waifu-smoke-agent",
          account: expect.objectContaining({
            primaryWalletAddress: "0x0000000000000000000000000000000000000001",
            walletKeyRef: "steward:waifu-smoke-key",
            elizaCloudOrganizationId: "agent-wallet-org",
            elizaCloudUserId: "agent-wallet-user",
          }),
          access: expect.objectContaining({
            guestTokenThreshold: 1000,
            userTokenThreshold: 100000,
            adminWalletAddress: "0x0000000000000000000000000000000000000002",
            roles: {
              admin: {
                wallets: [
                  "0x0000000000000000000000000000000000000002",
                  "0x0000000000000000000000000000000000000003",
                ],
              },
            },
          }),
          waifuWebhook: expect.objectContaining({
            url: "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
            secret: "test-webhook-secret",
          }),
          container: {
            image: "registry.example.test/waifu-agent:latest",
            projectName: "waifu-smoke-agent",
            port: 3000,
            cpu: 512,
            memory: 1024,
            desiredCount: 1,
            architecture: "arm64",
            healthCheckPath: "/api/health",
          },
        }),
        environmentVars: expect.objectContaining({
          WAIFU_AGENT_ID: "waifu-smoke-agent",
          AGENT_PRIMARY_WALLET_ADDRESS:
            "0x0000000000000000000000000000000000000001",
          AGENT_PRIMARY_WALLET_KEY_REF: "steward:waifu-smoke-key",
          WAIFU_AGENT_EVM_ADDRESS: "0x0000000000000000000000000000000000000001",
          WAIFU_AGENT_EVM_KEY_REF: "steward:waifu-smoke-key",
          AGENT_ADMIN_WALLET_ADDRESS:
            "0x0000000000000000000000000000000000000002",
          AGENT_GUEST_TOKEN_THRESHOLD: "1000",
          AGENT_USER_TOKEN_THRESHOLD: "100000",
          WAIFU_ACCESS_ADMIN_WALLETS:
            "0x0000000000000000000000000000000000000002,0x0000000000000000000000000000000000000003",
          WAIFU_ACCESS_GUEST_MIN_TOKENS: "1000",
          WAIFU_ACCESS_USER_MIN_TOKENS: "100000",
          WAIFU_ACCESS_THRESHOLD_MODE: "strict_gt",
          ELIZA_CLOUD_ACCOUNT_ORG_ID: "agent-wallet-org",
          WAIFU_ELIZA_CLOUD_ACCOUNT_ORG_ID: "agent-wallet-org",
          ELIZA_UI_ENABLE: "true",
          PORT: "3000",
          WAIFU_CHAT_ACCESS_JWT_SECRET: "waifu-chat-secret",
          WAIFU_CHAT_FRAME_ANCESTORS:
            "https://waifu.fun https://staging.waifu.fun",
          MODEL_PROVIDER: "eliza-cloud",
          EXTRA_SETTING: "1",
        }),
      }),
    );
    expect(enqueueAgentProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "cloud-agent-1",
        organizationId: "agent-wallet-org",
        userId: "agent-wallet-user",
        webhookUrl:
          "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
      }),
    );
  });

  test("sync provisioning response includes hosted runtime details", async () => {
    provisionAgent.mockResolvedValueOnce({
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
    });

    const response = await app.fetch(
      new Request("https://api.example.test/?sync=true", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      cloudAgentId: "cloud-agent-1",
      characterId: "character-1",
      containerId: "container-worker",
      containerUrl: "https://cloud-agent-1.cloud.eliza.app",
      bridgeUrl: "https://cloud-agent-1.cloud.eliza.app",
      webUiUrl: "https://cloud-agent-1.cloud.eliza.app",
      status: "running",
      token_address: "0x0000000000000000000000000000000000000009",
      token_chain: "bsc",
      token_name: "Waifu Smoke",
      token_ticker: "WSMOKE",
      account: {
        primaryWalletAddress: "0x0000000000000000000000000000000000000001",
        walletKeyRef: null,
        organizationId: "agent-wallet-org",
        userId: "agent-wallet-user",
        isNewAccount: true,
        initialCreditsGranted: false,
        initialFreeCreditsUsd: 0,
        welcomeBonusWithheld: false,
      },
    });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerImage: undefined,
        executionTier: "dedicated-always",
      }),
    );
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("defaults waifu holder access and owner-credit billing when omitted", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(202);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          access: expect.objectContaining({
            guestTokenThreshold: 1000,
            userTokenThreshold: 100000,
          }),
        }),
        environmentVars: expect.objectContaining({
          AGENT_GUEST_TOKEN_THRESHOLD: "1000",
          WAIFU_ACCESS_GUEST_MIN_TOKENS: "1000",
          AGENT_USER_TOKEN_THRESHOLD: "100000",
          WAIFU_ACCESS_USER_MIN_TOKENS: "100000",
          WAIFU_ACCESS_THRESHOLD_MODE: "strict_gt",
        }),
      }),
    );
  });

  test("rejects service provisioning without an agent EVM primary wallet", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
          tokenContractAddress: "0x0000000000000000000000000000000000000009",
          chain: "bsc",
          chainId: 56,
          tokenName: "Waifu Smoke",
          tokenTicker: "WSMOKE",
          launchType: "native",
          character: { name: "Smoke Agent" },
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
          },
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request data",
    });
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("rejects service provisioning with an invalid agent EVM primary wallet", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
          tokenContractAddress: "0x0000000000000000000000000000000000000009",
          chain: "bsc",
          chainId: 56,
          tokenName: "Waifu Smoke",
          tokenTicker: "WSMOKE",
          launchType: "native",
          character: { name: "Smoke Agent" },
          account: {
            primaryWalletAddress: "not-an-address",
            chainType: "evm",
          },
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
          },
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request data",
    });
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("rejects service provisioning with an invalid admin EVM wallet", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
          access: {
            adminWalletAddress: "not-an-address",
          },
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
          },
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request data",
    });
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("rejects service provisioning with an invalid role admin EVM wallet", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
          access: {
            roles: {
              admin: { wallets: ["not-an-address"] },
            },
          },
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
          },
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request data",
    });
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("does not create cloud resources when the agent wallet org has insufficient credits", async () => {
    findOrCreateUserByWalletAddress.mockResolvedValueOnce({
      isNewAccount: false,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
      user: {
        id: "agent-wallet-user",
        organization_id: "agent-wallet-org",
        wallet_address: "0x0000000000000000000000000000000000000001",
      },
    });
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
          billing: {
            mode: "owner_credits",
            initialReserveUsd: 0,
          },
          container: {
            image: "registry.example.test/waifu-agent:latest",
          },
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits",
      requiredBalance: 0.1,
      currentBalance: 0,
    });
    expect(checkAgentCreditGate).toHaveBeenCalledWith("agent-wallet-org");
    expect(checkProvisioningWorkerHealth).toHaveBeenCalledTimes(1);
    expect(createCharacter).toHaveBeenCalledTimes(1);
    expect(deleteCharacter).toHaveBeenCalledWith("character-1");
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("rejects a non-allowlisted docker image with 403 (not 500) and cleans up the character", async () => {
    createAgent.mockRejectedValueOnce(
      new AgentImageNotAllowedError(
        "registry.example.test/waifu-agent:latest",
        "not_allowlisted",
      ),
    );

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "agent_image_not_allowed",
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(deleteCharacter).toHaveBeenCalledWith("character-1");
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("duplicate token response returns existing sandbox id instead of character id", async () => {
    findByTokenAddress.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
    });
    findLatestByCharacterId.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      existingCharacterId: "11111111-1111-4111-8111-111111111111",
      existingAgentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(findLatestByCharacterId).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("does not grant wallet credits when character creation loses a duplicate-token race", async () => {
    const duplicateError = new Error(
      'duplicate key value violates unique constraint "characters_token_address_token_chain_key"',
    ) as Error & { code: string };
    duplicateError.code = "23505";
    createCharacter.mockRejectedValueOnce(duplicateError);
    findByTokenAddress.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
    });
    findLatestByCharacterId.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      existingCharacterId: "11111111-1111-4111-8111-111111111111",
      existingAgentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(findOrCreateUserByWalletAddress).toHaveBeenCalledWith(
      "0x0000000000000000000000000000000000000001",
    );
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("duplicate token without a sandbox does not expose a character id as existingAgentId", async () => {
    findByTokenAddress.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
    });
    findLatestByCharacterId.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
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
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.existingCharacterId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(body.existingAgentId).toBeUndefined();
    expect(findOrCreateUserByWalletAddress).not.toHaveBeenCalled();
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(createCharacter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });
});
