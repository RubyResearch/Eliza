/**
 * Exercises account inventory against changing transport readiness with a
 * deterministic runtime boundary. No live provider or Messages access is used.
 */
import {
  ConnectorAccountManager,
  type IAgentRuntime,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createIMessageConnectorAccountProvider } from "./connector-account-provider.js";
import type { IMessageServiceStatus } from "./types.js";

function inventory(settings: Record<string, unknown> = {}) {
  let status: IMessageServiceStatus | null = null;
  const runtime = {
    character: { settings: { imessage: settings } },
    getSetting: () => undefined,
    getService: () => (status ? { getStatus: () => status } : null),
  } as unknown as IAgentRuntime;
  const provider = createIMessageConnectorAccountProvider(runtime);
  const listAccounts = provider.listAccounts;
  if (!listAccounts) throw new Error("iMessage provider does not support inventory");
  return {
    provider,
    setStatus(value: IMessageServiceStatus | null) {
      status = value;
    },
    list: () => listAccounts({} as ConnectorAccountManager),
  };
}

const hosted: IMessageServiceStatus = {
  transport: "blooio",
  available: true,
  connected: true,
  chatDbAvailable: false,
  sendOnly: false,
  chatDbPath: "",
  reason: null,
  permissionAction: null,
  webhookPath: "/api/imessage/webhook/blooio",
  channelId: "test-channel",
};

describe("iMessage account readiness", () => {
  it("does not treat enabled configuration as a working connection", async () => {
    const source = inventory();
    expect((await source.list())[0].status).toBe("pending");
    source.setStatus(hosted);
    expect((await source.list())[0]).toMatchObject({
      status: "connected",
      metadata: { transport: "blooio", channelId: "test-channel", dbPath: null },
    });
    source.setStatus({ ...hosted, connected: false });
    expect((await source.list())[0].status).toBe("pending");
    source.setStatus(null);
    expect((await source.list())[0].status).toBe("pending");
  });

  it("does not activate a disabled account when the service is running", async () => {
    const source = inventory({ enabled: false });
    source.setStatus(hosted);
    expect((await source.list())[0].status).toBe("disabled");
  });

  it("does not attribute the default transport to unsupported account identities", async () => {
    const source = inventory({ accounts: { replacement: { enabled: true } } });
    source.setStatus(hosted);
    const accounts = await source.list();
    expect(accounts.find((account) => account.id === "replacement")?.status).toBe("error");
    expect(accounts.some((account) => account.status === "connected")).toBe(false);
  });
  it("does not let a persisted connected row override unavailable transport readiness", async () => {
    const source = inventory();
    const manager = new ConnectorAccountManager(undefined, new InMemoryConnectorAccountStorage());
    manager.registerProvider(source.provider);
    await manager.upsertAccount("imessage", {
      id: "default",
      provider: "imessage",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "pairing",
      status: "connected",
    });
    const accounts = await manager.listAccounts("imessage");
    expect(accounts.find((account) => account.id === "default")?.status).toBe("pending");
    expect((await manager.getAccount("imessage", "default"))?.status).toBe("pending");
  });
  it.each(["disabled", "revoked"] as const)(
    "preserves stored %s decisions when the transport reconnects",
    async (status) => {
      const source = inventory();
      source.setStatus(hosted);
      const manager = new ConnectorAccountManager(undefined, new InMemoryConnectorAccountStorage());
      manager.registerProvider(source.provider);
      await manager.upsertAccount("imessage", { id: "default", status });
      expect((await manager.listAccounts("imessage"))[0].status).toBe(status);
      expect((await manager.getAccount("imessage", "default"))?.status).toBe(status);
    }
  );

  it("reconciles a persisted account key without adding a second transport identity", async () => {
    const source = inventory();
    const manager = new ConnectorAccountManager(undefined, new InMemoryConnectorAccountStorage());
    manager.registerProvider(source.provider);
    await manager.upsertAccount("imessage", {
      id: "saved-account",
      accountKey: "default",
      status: "connected",
    });
    const accounts = await manager.listAccounts("imessage");
    expect(accounts.map((account) => [account.id, account.status])).toEqual([
      ["saved-account", "pending"],
    ]);
    source.setStatus(hosted);
    expect((await manager.getAccount("imessage", "saved-account"))?.status).toBe("connected");
    source.setStatus(null);
    expect((await manager.getAccount("imessage", "saved-account"))?.status).toBe("pending");
  });
  it("rejects two persisted identities that claim the same live sender", async () => {
    const source = inventory();
    source.setStatus(hosted);
    const manager = new ConnectorAccountManager(undefined, new InMemoryConnectorAccountStorage());
    manager.registerProvider(source.provider);
    await manager.upsertAccount("imessage", {
      id: "old-sender",
      accountKey: "default",
      status: "connected",
    });
    await manager.upsertAccount("imessage", {
      id: "replacement-sender",
      accountKey: "default",
      status: "connected",
    });
    await expect(manager.listAccounts("imessage")).rejects.toMatchObject({
      code: "CONNECTOR_ACCOUNT_AMBIGUOUS",
    });
    await expect(manager.getAccount("imessage", "replacement-sender")).rejects.toMatchObject({
      code: "CONNECTOR_ACCOUNT_AMBIGUOUS",
    });
  });

  it("keeps a disappeared sender pending while the different live sender is connected", async () => {
    const source = inventory();
    source.setStatus(hosted);
    const manager = new ConnectorAccountManager(undefined, new InMemoryConnectorAccountStorage());
    manager.registerProvider(source.provider);
    await manager.upsertAccount("imessage", {
      id: "removed-sender",
      accountKey: "removed",
      status: "connected",
    });
    expect((await manager.getAccount("imessage", "removed-sender"))?.status).toBe("pending");
    expect((await manager.getAccount("imessage", "default"))?.status).toBe("connected");
  });
});
