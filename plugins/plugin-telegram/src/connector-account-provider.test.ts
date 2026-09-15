/**
 * Unit tests for the ConnectorAccountManager provider: that a bot-token config
 * surfaces as an open AGENT account and a personal (GramJS) config as an
 * owner-binding-gated OWNER account with a stable externalId, and that disabled
 * or credential-less blocks are ignored. Runtime is mocked.
 */
import type {
  ConnectorAccount,
  ConnectorAccountManager,
  IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTelegramConnectorAccountProvider } from "./connector-account-provider";

import {
  claimTelegramPollerToken,
  markTelegramPollerConnected,
  markTelegramPollerError,
  releaseTelegramPollerToken,
} from "./poller-lock";

type TelegramConfig = Record<string, unknown>;

function runtimeWith(telegram: TelegramConfig): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { name: "Agent", settings: { telegram } },
    getSetting: () => undefined,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

// Minimal manager whose storage returns no persisted accounts, so listAccounts
// reflects only the synthesized (config-derived) accounts under test.
function emptyManager(): ConnectorAccountManager {
  return {
    getStorage: () => ({ listAccounts: async () => [] as ConnectorAccount[] }),
  } as unknown as ConnectorAccountManager;
}

async function list(telegram: TelegramConfig): Promise<ConnectorAccount[]> {
  const provider = createTelegramConnectorAccountProvider(
    runtimeWith(telegram),
  );
  return provider.listAccounts?.(emptyManager()) ?? [];
}

describe("Telegram connector account roles (agent bot vs personal user)", () => {
  it("surfaces a bot-token account as an open AGENT account", async () => {
    const accounts = await list({ botToken: "123:abc" });
    expect(accounts).toHaveLength(1);
    const bot = accounts[0];
    expect(bot.role).toBe("AGENT");
    expect(bot.accessGate).toBe("open");
    expect(bot.metadata?.personal).toBe(false);
  });

  it("surfaces a personal account as an owner_binding-gated OWNER account with a stable externalId", async () => {
    const accounts = await list({
      accounts: {
        me: { personal: { phone: "+15551234567", enabled: true } },
      },
    });
    const owner = accounts.find((a) => a.role === "OWNER");
    expect(owner).toBeDefined();
    expect(owner?.accessGate).toBe("owner_binding");
    expect(owner?.purpose).toContain("reading");
    // Load-bearing: the owner-binding gate matches on externalId, so it must be set.
    expect(owner?.externalId).toBe("tg-user:+15551234567");
    expect(owner?.id).toBe("me:personal");
    expect(owner?.metadata?.personal).toBe(true);
  });

  it("surfaces both a bot and a personal identity from one config as two distinct accounts", async () => {
    const accounts = await list({
      accounts: {
        me: {
          botToken: "123:abc",
          personal: { phone: "+15551234567", enabled: true },
        },
      },
    });
    const bot = accounts.find((a) => a.role === "AGENT");
    const owner = accounts.find((a) => a.role === "OWNER");
    expect(bot?.id).toBe("me");
    expect(owner?.id).toBe("me:personal");
    expect(accounts).toHaveLength(2);
  });

  it("ignores a disabled or credential-less personal block", async () => {
    const disabled = await list({
      accounts: {
        me: { botToken: "1:a", personal: { phone: "+1", enabled: false } },
      },
    });
    expect(disabled.some((a) => a.role === "OWNER")).toBe(false);

    const credless = await list({
      accounts: { me: { botToken: "1:a", personal: { enabled: true } } },
    });
    expect(credless.some((a) => a.role === "OWNER")).toBe(false);
  });
});

describe("Telegram account liveness", () => {
  it("requires the exact configured token, account and runtime before reporting connected", async () => {
    const token = "123:inventory-health";
    const config = { botToken: token };
    const runtime = runtimeWith(config);
    const provider = createTelegramConnectorAccountProvider(runtime);
    const bot = { stop: vi.fn() } as never;
    const read = () => provider.listAccounts?.(emptyManager());
    expect((await read())?.[0].status).toBe("pending");
    try {
      claimTelegramPollerToken(token, {
        bot,
        mode: "full",
        accountId: "default",
        ownerId: "agent-1",
      });
      expect((await read())?.[0].status).toBe("pending");
      markTelegramPollerConnected(token, bot);
      expect((await read())?.[0].status).toBe("connected");
      markTelegramPollerError(
        token,
        bot,
        new Error("Synthetic network failure"),
      );
      expect((await read())?.[0].status).toBe("error");
      markTelegramPollerConnected(token, bot);
      config.botToken = "456:replacement-not-running";
      expect((await read())?.[0].status).toBe("pending");
      config.botToken = token;
      releaseTelegramPollerToken(token, bot);
      claimTelegramPollerToken(token, {
        bot,
        mode: "full",
        accountId: "different-account",
        ownerId: "agent-1",
      });
      markTelegramPollerConnected(token, bot);
      expect((await read())?.[0].status).toBe("pending");
      releaseTelegramPollerToken(token, bot);
      claimTelegramPollerToken(token, {
        bot,
        mode: "full",
        accountId: "default",
        ownerId: "another-agent",
      });
      markTelegramPollerConnected(token, bot);
      expect((await read())?.[0].status).toBe("pending");
    } finally {
      releaseTelegramPollerToken(token, bot);
    }
    expect((await read())?.[0].status).toBe("pending");
  });

  it("does not let a persisted connected row hide a stopped poller or configuration-only personal identity", async () => {
    const configured = await list({ botToken: "789:persisted" });
    const stored = { ...configured[0], status: "connected" as const };
    const manager = {
      getStorage: () => ({ listAccounts: async () => [stored] }),
    } as unknown as ConnectorAccountManager;
    const provider = createTelegramConnectorAccountProvider(
      runtimeWith({ botToken: "789:persisted" }),
    );
    expect((await provider.listAccounts?.(manager))?.[0].status).toBe(
      "pending",
    );
    const personal = await list({
      accounts: { me: { personal: { phone: "+15551234567", enabled: true } } },
    });
    expect(personal[0].status).toBe("pending");
  });
});

it("resolves vault-backed inventory credentials and keeps secret read failures private", async () => {
  const token = "456:vault-inventory";
  const config = {
    botToken: "vault://connector.agent-1.telegram.default.bot-token",
  };
  const runtime = runtimeWith(config);
  let fail = false;
  const get = vi.fn(async () => {
    if (fail) throw new Error("synthetic-private-store-detail");
    return token;
  });
  runtime.getService = vi.fn(() => ({ get })) as never;
  const provider = createTelegramConnectorAccountProvider(runtime);
  const bot = { stop: vi.fn() } as never;
  try {
    claimTelegramPollerToken(token, {
      bot,
      mode: "full",
      accountId: "default",
      ownerId: "agent-1",
    });
    markTelegramPollerConnected(token, bot);
    expect((await provider.listAccounts?.(emptyManager()))?.[0].status).toBe(
      "connected",
    );
    fail = true;
    await expect(provider.listAccounts?.(emptyManager())).rejects.toThrow(
      "The configured Telegram credential is unavailable.",
    );
    get.mockClear();
    config.botToken =
      "vault://connector.another-agent.telegram.default.bot-token";
    await expect(provider.listAccounts?.(emptyManager())).rejects.toThrow(
      "The configured Telegram credential is unavailable.",
    );
    expect(get).not.toHaveBeenCalled();
  } finally {
    releaseTelegramPollerToken(token, bot);
  }
  expect((await list({ botToken: token, enabled: false }))[0].status).toBe(
    "disabled",
  );
});
