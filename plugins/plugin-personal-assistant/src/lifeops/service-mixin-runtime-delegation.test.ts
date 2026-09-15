/** Verifies the LifeOpsService delegates messaging (X post/DM) calls through the connector runtime services. Deterministic vitest with stubbed runtime services. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, SendHandlerOutcome } from "@elizaos/core";
import type {
  CreateLifeOpsXPostRequest,
  LifeOpsConnectorGrant,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";

const TestMessagingService = LifeOpsService;

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

type PrimaryChannelPolicy = {
  allowPosts: boolean;
  requireConfirmationForActions: boolean;
};

type TestMessagingServiceInstance = InstanceType<
  typeof TestMessagingService
> & {
  resolvePrimaryChannelPolicy(
    provider: "x",
  ): Promise<PrimaryChannelPolicy | null>;
};

type XPostRequestWithAccountId = CreateLifeOpsXPostRequest & {
  accountId: string;
};

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
  const settings = new Map<string, unknown>();
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Test Agent" },
    getService: vi.fn((serviceType: string) => services[serviceType] ?? null),
    getSetting: vi.fn((key: string) => settings.get(key)),
    setSetting: vi.fn((key: string, value: unknown) => {
      if (value === null || value === undefined) {
        settings.delete(key);
      } else {
        settings.set(key, value);
      }
    }),
  } as unknown as IAgentRuntime;
}

function connectorGrant(
  provider: "telegram" | "x",
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant {
  return {
    id: `${provider}-stored-grant`,
    agentId: "11111111-1111-4111-8111-111111111111",
    provider,
    connectorAccountId: `acct-${provider}-owner`,
    side: "owner",
    identity: { id: "12345", username: "stored_user", phone: "+15551234567" },
    identityEmail: null,
    grantedScopes: [],
    capabilities:
      provider === "x"
        ? ["x.read", "x.write", "x.dm.read", "x.dm.write"]
        : ["telegram.read", "telegram.send"],
    tokenRef: `${provider}-stored-token`,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: { phone: "+15551234567" },
    lastRefreshAt: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  } as LifeOpsConnectorGrant;
}

function serviceWithConnectorGrants(args: {
  services?: Record<string, unknown>;
  grants?: Record<string, LifeOpsConnectorGrant | null>;
}): TestMessagingServiceInstance {
  const service = new TestMessagingService(
    runtimeWithServices(args.services ?? {}),
  ) as TestMessagingServiceInstance;
  service.repository.getConnectorGrant = vi.fn(
    async (_agentId: string, provider: string) =>
      args.grants?.[provider] ?? null,
  );
  service.repository.deleteConnectorGrant = vi.fn(async () => undefined);
  service.repository.upsertConnectorGrant = vi.fn(async () => undefined);
  service.recordConnectorAudit = vi.fn(async () => undefined);
  service.recordXPostAudit = vi.fn(async () => undefined);
  service.resolvePrimaryChannelPolicy = vi.fn(async () => null);
  service.logLifeOpsWarn = vi.fn();
  return service;
}

describe("LifeOps messaging mixin runtime delegation", () => {
  it("rejects outbound Telegram and Discord verification probes before dispatch", async () => {
    const telegramSend = vi.fn(async () => undefined);
    const discordSend = vi.fn(async () => undefined);
    const service = serviceWithConnectorGrants({
      services: {
        telegram: {
          connected: true,
          handleSendMessage: telegramSend,
        },
        discord: {
          isReady: () => true,
          sendMessage: discordSend,
        },
      },
    });

    await expect(
      service.verifyTelegramConnector({
        sendTarget: "telegram-user",
        sendMessage: "verification ping",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("owner approval"),
    });
    await expect(
      service.verifyDiscordConnector({
        channelId: "discord-channel",
        sendMessage: "verification ping",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("owner approval"),
    });

    expect(telegramSend).not.toHaveBeenCalled();
    expect(discordSend).not.toHaveBeenCalled();
  });

  it("does not connect Telegram from LifeOps-stored token refs", async () => {
    const service = serviceWithConnectorGrants({
      grants: { telegram: connectorGrant("telegram") },
    });

    const status = await service.getTelegramConnectorStatus("owner");

    expect(status.connected).toBe(false);
    expect(status.grantedCapabilities).toEqual([]);
    expect(status.storedCredentialsAvailable).toBe(false);
    expect(status.grant).toBeNull();
    expect(status.degradations?.map((item) => item.code)).toEqual(
      expect.arrayContaining(["telegram_plugin_unavailable"]),
    );
    await expect(
      service.sendTelegramMessage({
        target: "12345",
        message: "hello",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("@elizaos/plugin-telegram"),
    });
  });

  it("delegates Telegram sends through the runtime service account id", async () => {
    const handleSendMessage = vi.fn(async () =>
      confirmedSend("telegram-message-1"),
    );
    const service = serviceWithConnectorGrants({
      services: {
        telegram: {
          messageManager: {},
          handleSendMessage,
          bot: { botInfo: { id: 100, username: "agent_bot" } },
        },
      },
      grants: { telegram: connectorGrant("telegram") },
    });

    await expect(
      service.sendTelegramMessage({
        target: "12345",
        message: "hello",
      }),
    ).resolves.toEqual({
      ok: true,
      messageId: "telegram-message-1",
      receipt: {
        providerMessageIds: ["telegram-message-1"],
        acceptedAt: 1_780_000_000_000,
        persistence: { status: "persisted", memoryIds: [] },
      },
    });

    expect(handleSendMessage).toHaveBeenCalledWith(
      service.runtime,
      expect.objectContaining({
        source: "telegram",
        accountId: "default",
        channelId: "12345",
      }),
      expect.objectContaining({
        text: "hello",
        metadata: { accountId: "default" },
      }),
    );
  });

  it("reports Telegram read capability only when the runtime service exposes search", async () => {
    const service = serviceWithConnectorGrants({
      services: {
        telegram: {
          connected: true,
          handleSendMessage: vi.fn(async () => undefined),
        },
      },
      grants: { telegram: connectorGrant("telegram") },
    });

    await expect(
      service.getTelegramConnectorStatus("owner"),
    ).resolves.toMatchObject({
      connected: true,
      grantedCapabilities: ["telegram.send"],
      degradations: expect.arrayContaining([
        expect.objectContaining({ code: "telegram_plugin_read_unavailable" }),
      ]),
    });
  });

  it("keeps the CONNECTOR action off LifeOps-owned Telegram API credential auth", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../actions/connector.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("apiId");
    expect(source).not.toContain("apiHash");
    expect(source).not.toContain("startTelegramAuth");
  });

  it("passes non-default X account ids to runtime read, send, and post calls", async () => {
    const getAccountStatus = vi.fn(async (accountId: string) => ({
      accountId,
      configured: true,
      connected: true,
      reason: "connected",
      grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      grantedScopes: ["tweet.read", "dm.read", "dm.write"],
    }));
    const fetchDirectMessagesForAccount = vi.fn(async () => []);
    const sendDirectMessageForAccount = vi.fn(async () => ({
      ok: true,
      status: 202,
      messageId: "dm-123",
    }));
    const sendDirectMessageToConversationForAccount = vi.fn(async () => ({
      ok: true,
      status: 202,
      messageId: "dm-conversation-123",
    }));
    const createDirectMessageGroupForAccount = vi.fn(async () => ({
      ok: true,
      status: 201,
      conversationId: "conversation-new",
      messageId: "dm-group-123",
    }));
    const createPostForAccount = vi.fn(async () => ({
      id: "memory-post-1",
      metadata: {
        x: { tweetId: "tweet-runtime" },
      },
    }));
    const service = serviceWithConnectorGrants({
      services: {
        x: {
          getAccountStatus,
          fetchDirectMessagesForAccount,
          sendDirectMessageForAccount,
          sendDirectMessageToConversationForAccount,
          createDirectMessageGroupForAccount,
          createPostForAccount,
        },
      },
      grants: {
        x: connectorGrant("x", {
          connectorAccountId: "acct-x-secondary",
          metadata: {
            accountId: "acct-x-secondary",
            connectorAccountId: "acct-x-secondary",
          },
        }),
      },
    });
    service.repository.listXDms = vi.fn(async () => []);
    service.repository.upsertXDm = vi.fn(async () => undefined);
    service.resolvePrimaryChannelPolicy = vi.fn(async () => ({
      allowPosts: true,
      requireConfirmationForActions: false,
    }));

    await expect(
      service.getXConnectorStatus("local", "owner"),
    ).resolves.toMatchObject({
      connected: true,
      reason: "connected",
    });
    expect(getAccountStatus).toHaveBeenCalledWith("acct-x-secondary");

    await expect(service.getXDmDigest({ limit: 5 })).resolves.toMatchObject({
      unreadCount: 0,
      recent: [],
    });
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith(
      "acct-x-secondary",
      {
        participantId: undefined,
        limit: 5,
      },
    );

    await expect(
      service.sendXDirectMessage({
        participantId: "x-user-1",
        text: "dm hello",
        confirmSend: true,
      }),
    ).resolves.toEqual({ ok: true, status: 202 });
    expect(sendDirectMessageForAccount).toHaveBeenCalledWith(
      "acct-x-secondary",
      {
        participantId: "x-user-1",
        text: "dm hello",
      },
    );

    await expect(
      service.sendXConversationMessage({
        conversationId: "conversation-1",
        text: "conversation hello",
        confirmSend: true,
      }),
    ).resolves.toEqual({ ok: true, status: 202 });
    expect(sendDirectMessageToConversationForAccount).toHaveBeenCalledWith(
      "acct-x-secondary",
      {
        conversationId: "conversation-1",
        text: "conversation hello",
      },
    );

    await expect(
      service.createXDirectMessageGroup({
        participantIds: ["x-user-1", "x-user-2", "x-user-1"],
        text: "group hello",
        confirmSend: true,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 201,
      conversationId: "conversation-new",
    });
    expect(createDirectMessageGroupForAccount).toHaveBeenCalledWith(
      "acct-x-secondary",
      {
        participantIds: ["x-user-1", "x-user-2"],
        text: "group hello",
      },
    );

    await expect(
      service.createXPost({ text: "public hello", side: "owner" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 201,
      postId: "tweet-runtime",
      category: "success",
    });
    expect(createPostForAccount).toHaveBeenCalledWith("acct-x-secondary", {
      text: "public hello",
      replyToTweetId: undefined,
    });
  });

  it("honors requested X account ids over grant defaults for runtime delegation", async () => {
    const fetchDirectMessagesForAccount = vi.fn(
      async (
        _accountId: string,
        _opts: { participantId?: string; limit?: number },
      ) => [],
    );
    const sendDirectMessageForAccount = vi.fn(
      async (
        _accountId: string,
        _message: { participantId: string; text: string },
      ) => ({
        ok: true,
        status: 201,
        messageId: "dm-requested",
      }),
    );
    const createPostForAccount = vi.fn(
      async (
        _accountId: string,
        _request: { text: string; replyToTweetId?: string },
      ) => ({
        id: "tweet-requested",
        metadata: { messageIdFull: "tweet-requested" },
      }),
    );
    const service = serviceWithConnectorGrants({
      services: {
        x: {
          fetchDirectMessagesForAccount,
          sendDirectMessageForAccount,
          createPostForAccount,
        },
      },
      grants: { x: connectorGrant("x") },
    });
    service.repository.listXDms = vi.fn(async () => []);
    service.repository.upsertXDm = vi.fn(async () => undefined);
    service.resolvePrimaryChannelPolicy = vi.fn(async () => ({
      allowPosts: true,
      requireConfirmationForActions: false,
    }));

    await service.getXDmDigest({ accountId: "acct-x-requested", limit: 3 });
    await service.sendXDirectMessage({
      accountId: "acct-x-requested",
      participantId: "x-user-2",
      text: "requested dm",
      confirmSend: true,
    });
    await service.createXPost({
      accountId: "acct-x-requested",
      text: "requested post",
      side: "owner",
    } as XPostRequestWithAccountId);

    expect(fetchDirectMessagesForAccount.mock.calls[0]?.[0]).toBe(
      "acct-x-requested",
    );
    expect(sendDirectMessageForAccount.mock.calls[0]?.[0]).toBe(
      "acct-x-requested",
    );
    expect(createPostForAccount.mock.calls[0]?.[0]).toBe("acct-x-requested");
  });

  it("translates X DM memories from the plugin runtime service", async () => {
    const runtimeMessages = [
      {
        id: "memory-x-dm-1",
        roomId: "conversation-1",
        entityId: "x-user-1",
        content: { text: "plugin managed hello" },
        metadata: {
          x: {
            dmEventId: "dm-1",
            conversationId: "conversation-1",
            senderId: "x-user-1",
            senderUsername: "alice",
            isInbound: true,
          },
        },
        createdAt: Date.now() - 2_000,
      },
      {
        id: "memory-x-dm-2",
        roomId: "conversation-1",
        entityId: "owner",
        content: { text: "plugin managed reply" },
        metadata: {
          x: {
            dmEventId: "dm-2",
            conversationId: "conversation-1",
            senderId: "owner",
            senderUsername: "owner",
            isInbound: false,
          },
        },
        createdAt: Date.now() - 1_000,
      },
    ];
    const fetchDirectMessagesForAccount = vi.fn(async () => runtimeMessages);
    const service = serviceWithConnectorGrants({
      services: { x: { fetchDirectMessagesForAccount } },
      grants: { x: connectorGrant("x") },
    });
    const stored = [];
    service.repository.upsertXDm = vi.fn(async (dm) => {
      const index = stored.findIndex(
        (existing) => existing.externalDmId === dm.externalDmId,
      );
      if (index >= 0) {
        stored[index] = dm;
      } else {
        stored.push(dm);
      }
    });
    service.repository.listXDms = vi.fn(async (_agentId, opts = {}) =>
      stored.slice(0, opts.limit ?? stored.length),
    );

    await expect(service.syncXDms({ limit: 10 })).resolves.toEqual({
      synced: 2,
    });
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("acct-x-owner", {
      participantId: undefined,
      limit: 10,
    });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      externalDmId: "dm-1",
      conversationId: "conversation-1",
      senderHandle: "alice",
      text: "plugin managed hello",
      isInbound: true,
      metadata: { source: "plugin-x-runtime" },
    });

    await expect(service.readXInboundDms({ limit: 10 })).resolves.toMatchObject(
      [
        {
          externalDmId: "dm-1",
          isInbound: true,
          text: "plugin managed hello",
        },
      ],
    );

    await expect(
      service.curateXDms({
        messageIds: [`${service.runtime.agentId}:x:dm-1`],
        markRead: true,
        markReplied: true,
      }),
    ).resolves.toEqual({ curated: 1 });
    expect(stored[0]).toMatchObject({
      readAt: expect.any(String),
      repliedAt: expect.any(String),
    });
  });

  it("does not send WhatsApp through env credentials", async () => {
    const previousAccessToken = process.env.ELIZA_WHATSAPP_ACCESS_TOKEN;
    const previousPhoneNumberId = process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID;
    process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = "stale-token";
    process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = "stale-phone-number-id";
    const service = serviceWithConnectorGrants({});

    try {
      await expect(
        service.sendWhatsAppMessage({
          to: "+15550000001",
          text: "hello",
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("@elizaos/plugin-whatsapp"),
      });
    } finally {
      if (previousAccessToken === undefined) {
        delete process.env.ELIZA_WHATSAPP_ACCESS_TOKEN;
      } else {
        process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = previousAccessToken;
      }
      if (previousPhoneNumberId === undefined) {
        delete process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID;
      } else {
        process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = previousPhoneNumberId;
      }
    }
  });

  it("delegates WhatsApp sends to the runtime service", async () => {
    const sendMessage = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
    const service = serviceWithConnectorGrants({
      services: {
        whatsapp: {
          connected: true,
          phoneNumber: "+15551234567",
          sendMessage,
          fetchConnectorMessages: vi.fn(async () => []),
        },
      },
    });

    await expect(service.getWhatsAppConnectorStatus()).resolves.toMatchObject({
      provider: "whatsapp",
      connected: true,
      outboundReady: true,
      inboundReady: true,
    });
    await expect(
      service.sendWhatsAppMessage({
        to: "+15550000001",
        text: "hello",
      }),
    ).resolves.toEqual({ ok: true, messageId: "wamid.1" });
    expect(sendMessage).toHaveBeenCalledWith({
      accountId: "default",
      type: "text",
      to: "+15550000001",
      content: "hello",
      replyToMessageId: undefined,
    });
  });

  it("delegates WhatsApp recent message pulls to the runtime service", async () => {
    const fetchConnectorMessages = vi.fn(async () => [
      {
        id: "memory-whatsapp-1",
        roomId: "+15550000001",
        entityId: "+15550000001",
        createdAt: 1_780_000_000_000,
        content: { text: "hello from whatsapp" },
        metadata: {
          messageIdFull: "wamid.1",
          whatsapp: {
            from: "+15550000001",
            chatId: "+15550000001",
            type: "text",
          },
        },
      },
    ]);
    const service = serviceWithConnectorGrants({
      services: {
        whatsapp: {
          connected: true,
          sendMessage: vi.fn(async () => ({
            messages: [{ id: "wamid.sent" }],
          })),
          fetchConnectorMessages,
        },
      },
    });

    await expect(service.pullWhatsAppRecent(5)).resolves.toMatchObject({
      count: 1,
      messages: [
        {
          id: "wamid.1",
          from: "+15550000001",
          channelId: "+15550000001",
          type: "text",
          text: "hello from whatsapp",
        },
      ],
    });
    expect(fetchConnectorMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "whatsapp",
        accountId: "default",
      }),
      expect.objectContaining({ accountId: "default", limit: 5 }),
    );
  });

  it("delegates WhatsApp webhooks to plugin-whatsapp and rejects LifeOps parsing", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const service = serviceWithConnectorGrants({
      services: {
        whatsapp: {
          connected: true,
          handleWebhook,
        },
      },
    });

    await expect(
      service.ingestWhatsAppWebhook({ object: "whatsapp_business_account" }),
    ).resolves.toEqual({ ingested: 0, messages: [] });
    expect(handleWebhook).toHaveBeenCalledWith({
      object: "whatsapp_business_account",
    });

    const withoutWebhook = serviceWithConnectorGrants({
      services: { whatsapp: { connected: true } },
    });
    await expect(
      withoutWebhook.ingestWhatsAppWebhook({
        object: "whatsapp_business_account",
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("@elizaos/plugin-whatsapp"),
    });
  });

  it("reports WhatsApp missing hooks when the runtime service is connected but missing send hooks", async () => {
    const service = serviceWithConnectorGrants({
      services: {
        whatsapp: {
          connected: true,
        },
      },
    });

    await expect(service.getWhatsAppConnectorStatus()).resolves.toMatchObject({
      connected: false,
      outboundReady: false,
      inboundReady: false,
      degradations: expect.arrayContaining([
        expect.objectContaining({ code: "whatsapp_plugin_send_unavailable" }),
        expect.objectContaining({
          code: "whatsapp_plugin_inbound_unavailable",
        }),
      ]),
    });
  });

  it("reports WhatsApp send-only plugin services without requiring a connected flag", async () => {
    const service = serviceWithConnectorGrants({
      services: {
        whatsapp: {
          sendMessage: vi.fn(async () => ({ messages: [{ id: "wamid.2" }] })),
        },
      },
    });

    await expect(service.getWhatsAppConnectorStatus()).resolves.toMatchObject({
      connected: true,
      serviceConnected: true,
      outboundReady: true,
      inboundReady: false,
      degradations: expect.arrayContaining([
        expect.objectContaining({
          code: "whatsapp_plugin_inbound_unavailable",
        }),
      ]),
    });
  });
});
