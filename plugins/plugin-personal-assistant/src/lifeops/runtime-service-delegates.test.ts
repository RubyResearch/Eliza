/** Verifies the connector runtime-service delegates (X) forward calls and apply egress filtering. Deterministic vitest with stubbed runtime services. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, SendHandlerOutcome } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import {
  createConnectorAccountPrivacyPolicy,
  createLifeOpsEgressContext,
  filterActionResultForEgress,
} from "./privacy-egress.js";
import {
  createXPostWithRuntimeService,
  fetchXDirectMessagesWithRuntimeService,
  getXAccountStatusWithRuntimeService,
  readIMessagesWithRuntimeService,
  resolveRuntimeConnectorAccountId,
  searchTelegramMessagesWithRuntimeService,
  sendDiscordMessageWithRuntimeService,
  sendIMessageWithRuntimeService,
  sendTelegramMessageWithRuntimeService,
  sendWhatsAppMessageWithRuntimeService,
  sendXDirectMessageWithRuntimeService,
} from "./runtime-service-delegates.js";

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) => services[serviceType] ?? null),
    setSetting: vi.fn(),
  } as IAgentRuntime;
}

function confirmedSend(id: string): SendHandlerOutcome {
  return {
    kind: "delivered",
    receipt: {
      providerMessageIds: [id],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted", memoryIds: [] },
    },
    memories: [],
  };
}

function grant(
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant {
  return {
    id: "grant-1",
    agentId: "agent-1",
    provider: "x",
    connectorAccountId: "acct-owner-1",
    side: "owner",
    identity: {},
    identityEmail: null,
    grantedScopes: [],
    capabilities: ["x.dm.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("runtime service delegates", () => {
  it("resolves explicit connectorAccountId before metadata account ids", () => {
    expect(
      resolveRuntimeConnectorAccountId({
        grant: grant({
          connectorAccountId: "account-from-grant",
          cloudConnectionId: "cloud-id",
          metadata: { accountId: "account-from-metadata" },
        }),
      }),
    ).toBe("account-from-grant");

    expect(
      resolveRuntimeConnectorAccountId({
        grant: grant({
          connectorAccountId: null,
          cloudConnectionId: "cloud-id",
          metadata: { accountId: "account-from-metadata" },
        }),
      }),
    ).toBe("account-from-metadata");
  });

  it("delegates X DM sends through the plugin-x accountId-first method", async () => {
    const sendDirectMessageForAccount = vi.fn(async () => ({
      status: 201,
      messageId: "dm-1",
    }));
    const handleSendMessage = vi.fn(async () => undefined);
    const runtime = runtimeWithServices({
      x: { sendDirectMessageForAccount, handleSendMessage },
    });

    const result = await sendXDirectMessageWithRuntimeService({
      runtime,
      grant: grant(),
      participantId: "12345",
      text: "hello",
    });

    expect(result).toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
      value: { ok: true, status: 201, externalId: "dm-1" },
    });
    expect(sendDirectMessageForAccount).toHaveBeenCalledWith("acct-owner-1", {
      participantId: "12345",
      text: "hello",
    });
    expect(handleSendMessage).not.toHaveBeenCalled();
  });

  it("delegates X reads and posts through plugin-x accountId-first methods", async () => {
    const memory = {
      id: "memory-1",
      agentId: "agent-1",
      entityId: "entity-1",
      roomId: "room-1",
      createdAt: Date.parse("2026-05-08T00:00:00.000Z"),
      content: { text: "hello", source: "x" },
      metadata: {
        messageIdFull: "native-1",
        x: { accountId: "acct-owner-1" },
      },
    };
    const fetchDirectMessagesForAccount = vi.fn(async () => [memory]);
    const createPostForAccount = vi.fn(async () => memory);
    const getAccountStatus = vi.fn(async () => ({
      accountId: "acct-owner-1",
      configured: true,
      connected: true,
      reason: "connected",
      identity: { userId: "u1" },
      grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      grantedScopes: ["tweet.read"],
    }));
    const runtime = runtimeWithServices({
      x: {
        fetchDirectMessagesForAccount,
        createPostForAccount,
        getAccountStatus,
      },
    });

    await expect(
      fetchXDirectMessagesWithRuntimeService({
        runtime,
        grant: grant(),
        limit: 5,
      }),
    ).resolves.toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
      value: [memory],
    });
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("acct-owner-1", {
      participantId: undefined,
      limit: 5,
    });

    await expect(
      createXPostWithRuntimeService({
        runtime,
        grant: grant(),
        text: "public hello",
      }),
    ).resolves.toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
      value: memory,
    });
    expect(createPostForAccount).toHaveBeenCalledWith("acct-owner-1", {
      text: "public hello",
      replyToTweetId: undefined,
    });

    await expect(
      getXAccountStatusWithRuntimeService({ runtime, grant: grant() }),
    ).resolves.toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
      value: {
        configured: true,
        connected: true,
        grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      },
    });
  });

  it("returns unavailable when plugin-x accountId-first send fails", async () => {
    const runtime = runtimeWithServices({
      x: {
        sendDirectMessageForAccount: vi.fn(async () => {
          throw new Error("dm scope missing");
        }),
      },
    });

    const result = await sendXDirectMessageWithRuntimeService({
      runtime,
      grant: grant(),
      participantId: "12345",
      text: "hello",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "X runtime service sendDirectMessageForAccount failed.",
    });
    expect(
      result.status === "unavailable" ? result.error : null,
    ).toBeInstanceOf(Error);
  });

  it("returns unavailable when X runtime service is unavailable", async () => {
    const result = await sendXDirectMessageWithRuntimeService({
      runtime: runtimeWithServices({}),
      grant: grant(),
      participantId: "12345",
      text: "hello",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "X runtime service handleSendMessage is not registered.",
    });
  });

  it("keeps active LifeOps X paths off superseded LifeOps X clients", async () => {
    const activeFiles = [
      "./service-mixin-core.ts",
      "./service-mixin-x.ts",
      "./service-mixin-x-read.ts",
    ];
    const bannedImport =
      /from\s+["'][^"']*(x-managed-client|x-poster|x-reader|x-dm-reader)\.js["']/;

    for (const relative of activeFiles) {
      const source = await readFile(
        fileURLToPath(new URL(relative, import.meta.url)),
        "utf8",
      );
      expect(source, relative).not.toMatch(bannedImport);
    }
  });

  it("delegates WhatsApp sends with accountId and maps message ids", async () => {
    const sendMessage = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
    const runtime = runtimeWithServices({
      whatsapp: { sendMessage },
    });

    const result = await sendWhatsAppMessageWithRuntimeService({
      runtime,
      grant: grant({ provider: "whatsapp" }),
      request: { to: "+15551234567", text: "ping" },
    });

    expect(sendMessage).toHaveBeenCalledWith({
      accountId: "acct-owner-1",
      type: "text",
      to: "+15551234567",
      content: "ping",
      replyToMessageId: undefined,
    });
    expect(result).toMatchObject({
      status: "handled",
      value: { ok: true, messageId: "wamid.1" },
    });
  });

  it("delegates Discord sends through the runtime service with accountId target", async () => {
    const handleSendMessage = vi.fn(async () =>
      confirmedSend("discord-message-1"),
    );
    const runtime = runtimeWithServices({
      discord: { handleSendMessage },
    });

    const result = await sendDiscordMessageWithRuntimeService({
      runtime,
      grant: grant({ provider: "discord" }),
      channelId: "1234567890",
      text: "ship it",
    });

    expect(result).toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
      value: { ok: true },
    });
    expect(handleSendMessage).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        source: "discord",
        accountId: "acct-owner-1",
        channelId: "1234567890",
      }),
      expect.objectContaining({
        text: "ship it",
        metadata: { accountId: "acct-owner-1" },
      }),
    );
  });

  it("preserves every provider message receipt for multi-part Discord delivery", async () => {
    const receipt = {
      providerMessageIds: ["discord-part-1", "discord-part-2"] as const,
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted" as const, memoryIds: [] },
    };
    const runtime = runtimeWithServices({
      discord: {
        handleSendMessage: async () => ({
          kind: "delivered",
          receipt,
          memories: [],
        }),
      },
    });
    const result = await sendDiscordMessageWithRuntimeService({
      runtime,
      grant: grant({ provider: "discord" }),
      channelId: "1234567890",
      text: "Multi-part calendar review",
    });
    expect(result.status).toBe("handled");
    if (result.status !== "handled") throw new Error(result.reason);
    expect(result.value.delivery.receipt).toEqual(receipt);
    expect(result.value.delivery.providerMessageId).toBe("discord-part-2");
  });

  it("does not report a Discord send as handled without delivery evidence", async () => {
    const runtime = runtimeWithServices({
      discord: { handleSendMessage: vi.fn(async () => undefined) },
    });

    await expect(
      sendDiscordMessageWithRuntimeService({
        runtime,
        grant: grant({ provider: "discord" }),
        channelId: "1234567890",
        text: "ship it",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("handleSendMessage failed"),
    });
  });

  it("preserves provider evidence from a split Telegram send", async () => {
    const receipt = {
      providerMessageIds: ["telegram-part-1", "telegram-part-2"] as const,
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted" as const, memoryIds: [] },
    };
    const runtime = runtimeWithServices({
      telegram: {
        handleSendMessage: async () => ({
          kind: "delivered",
          receipt,
          memories: [],
        }),
      },
    });
    const result = await sendTelegramMessageWithRuntimeService({
      runtime,
      grant: grant({ provider: "telegram" }),
      target: "chat-1",
      message: "Synthetic calendar review",
    });
    expect(result.status).toBe("handled");
    if (result.status !== "handled")
      throw new Error("Telegram did not deliver");
    expect(result.value.delivery.receipt).toEqual(receipt);
    expect(result.value.delivery.providerMessageId).toBe("telegram-part-2");
  });

  it("delegates Telegram searches with accountId-first context and params", async () => {
    const searchConnectorMessages = vi.fn(async () => [
      { id: "m1", content: { text: "hello" }, createdAt: 1 },
    ]);
    const runtime = runtimeWithServices({
      telegram: { searchConnectorMessages },
    });

    const result = await searchTelegramMessagesWithRuntimeService({
      runtime,
      grant: grant({ provider: "telegram" }),
      query: "hello",
      channelId: "chat-1",
      limit: 5,
    });

    expect(result).toMatchObject({
      status: "handled",
      accountId: "acct-owner-1",
    });
    expect(searchConnectorMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "telegram",
        accountId: "acct-owner-1",
        account: { accountId: "acct-owner-1" },
      }),
      expect.objectContaining({
        accountId: "acct-owner-1",
        query: "hello",
        channelId: "chat-1",
        limit: 5,
      }),
    );
  });

  it("delegates iMessage send and read through the native plugin service", async () => {
    const sendMessage = vi.fn(async () => ({
      success: true,
      messageId: "imsg-1",
      chatId: "chat-1",
    }));
    const getMessages = vi.fn(async () => [{ id: "m1", text: "hey" }]);
    const runtime = runtimeWithServices({
      imessage: { sendMessage, getMessages },
    });

    const sent = await sendIMessageWithRuntimeService({
      runtime,
      to: "+15551234567",
      text: "hey",
      mediaUrl: "file:///tmp/a.png",
    });
    const read = await readIMessagesWithRuntimeService({
      runtime,
      chatId: "chat-1",
      limit: 3,
    });

    expect(sent).toMatchObject({
      status: "handled",
      accountId: "default",
      value: { success: true, messageId: "imsg-1" },
    });
    expect(sendMessage).toHaveBeenCalledWith("+15551234567", "hey", {
      accountId: "default",
      mediaUrl: "file:///tmp/a.png",
      maxBytes: undefined,
    });
    expect(read).toMatchObject({ status: "handled", accountId: "default" });
    expect(getMessages).toHaveBeenCalledWith({
      chatId: "chat-1",
      limit: 3,
      accountId: "default",
    });
  });

  it("falls back when a runtime service capability is missing", async () => {
    const result = await sendDiscordMessageWithRuntimeService({
      runtime: runtimeWithServices({ discord: {} }),
      grant: grant({ provider: "discord" }),
      channelId: "123",
      text: "hello",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Discord runtime service handleSendMessage is not registered.",
    });
  });

  it("keeps privacy egress filtering after delegated message reads", () => {
    const nonOwner = createLifeOpsEgressContext({ isOwner: false });
    const policy = createConnectorAccountPrivacyPolicy({
      agentId: "agent-1",
      provider: "x",
      connectorAccountId: "acct-owner-1",
    });

    const filtered = filterActionResultForEgress(
      {
        success: true,
        text: "Delegated DM body: private appointment details",
        data: {
          source: "x",
          accountId: "acct-owner-1",
        },
      },
      {
        context: nonOwner,
        dataClasses: ["body"],
        policy,
      },
    );

    expect(filtered).toMatchObject({
      success: true,
      text: "Result hidden by LifeOps privacy policy.",
      data: { privacyFiltered: true, originalSuccess: true },
    });
  });
});
