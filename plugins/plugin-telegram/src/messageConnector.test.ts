/**
 * Unit tests for `TelegramService`'s `MessageConnector` registration and send
 * routing: connector metadata, account-scoped vs legacy routes, forum-topic
 * channel-id parsing, per-account manager selection, and rejection of sends with
 * no resolvable target. Runtime and Telegraf are mocked.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  claimTelegramPollerToken,
  getTelegramPollerClaim,
  markTelegramPollerConnected,
  releaseTelegramPollerToken,
} from "./poller-lock";
import { TelegramService } from "./service";
import { compareMessageConnectorTargets } from "./service.js";

function createRuntime() {
  const runtime = {
    agentId: "agent-1",
    character: { name: "Agent One" },
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn().mockResolvedValue(null),
    getMemories: vi.fn().mockResolvedValue([]),
    getEntityById: vi.fn().mockResolvedValue(null),
  };

  return runtime as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

function createTelegramService(
  overrides: Record<string, unknown>,
): TelegramService {
  return Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    overrides,
  );
}

describe("Telegram message connector adapter", () => {
  it("registers connector metadata with chat and thread support", () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      bot: {},
      messageManager: {},
      handleSendMessage: vi.fn(),
      resolveConnectorTargets: vi.fn(),
      listRecentConnectorTargets: vi.fn(),
      listConnectorRooms: vi.fn(),
      getConnectorChatContext: vi.fn(),
      getConnectorUserContext: vi.fn(),
    });

    TelegramService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector.mock.calls[0][0]).toMatchObject({
      source: "telegram",
      label: "Telegram",
      capabilities: expect.arrayContaining([
        "send_message",
        "resolve_targets",
        "chat_context",
        "user_context",
      ]),
      supportedTargetKinds: ["channel", "group", "thread", "user"],
      contexts: ["social", "connectors"],
    });
  });

  it("registers account-scoped and legacy connector routes", () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      bot: {},
      handleSendMessage: vi.fn(),
      accountStates: new Map([
        [
          "acct-a",
          {
            accountId: "acct-a",
            account: { accountId: "acct-a", name: "A" },
          },
        ],
        [
          "acct-b",
          {
            accountId: "acct-b",
            account: { accountId: "acct-b", name: "B" },
          },
        ],
      ]),
      defaultAccountId: "acct-a",
    });

    TelegramService.registerSendHandlers(runtime, service);

    const registrations = runtime.registerMessageConnector.mock.calls.map(
      (call) => call[0],
    );
    expect(registrations.map((registration) => registration.accountId)).toEqual(
      [undefined, "acct-a", "acct-b"],
    );
    expect(registrations[2]).toMatchObject({
      source: "telegram",
      accountId: "acct-b",
      account: { accountId: "acct-b" },
      metadata: { accountId: "acct-b" },
    });
  });

  it("parses forum-topic channel IDs for unified sends", async () => {
    const runtime = createRuntime();
    const sendMessageWithReceipt = vi.fn().mockResolvedValue({
      kind: "not_delivered",
      code: "EMPTY",
      message: "No content",
    });
    const service = createTelegramService({
      bot: {},
      messageManager: { sendMessageWithReceipt },
    });

    await service.handleSendMessage(
      runtime,
      { source: "telegram", channelId: "-1001234567890-42" },
      { text: "hello" },
    );

    expect(sendMessageWithReceipt).toHaveBeenCalledWith(
      "-1001234567890",
      { text: "hello", metadata: { accountId: "default" } },
      undefined,
      42,
    );
  });

  it("routes outbound sends through the requested account manager", async () => {
    const runtime = createRuntime();
    const managerA = {
      sendMessageWithReceipt: vi.fn().mockResolvedValue({
        kind: "not_delivered",
        code: "EMPTY",
        message: "No content",
      }),
    };
    const managerB = {
      sendMessageWithReceipt: vi.fn().mockResolvedValue({
        kind: "not_delivered",
        code: "EMPTY",
        message: "No content",
      }),
    };
    const service = createTelegramService({
      bot: {},
      messageManager: managerA,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a", messageManager: managerA, bot: {} }],
        ["acct-b", { accountId: "acct-b", messageManager: managerB, bot: {} }],
      ]),
    });

    await service.handleSendMessage(
      runtime,
      { source: "telegram", accountId: "acct-b", channelId: "-100123" },
      { text: "hello" },
    );

    expect(managerA.sendMessageWithReceipt).not.toHaveBeenCalled();
    expect(managerB.sendMessageWithReceipt).toHaveBeenCalledWith(
      "-100123",
      { text: "hello", metadata: { accountId: "acct-b" } },
      undefined,
      undefined,
    );
  });

  it("rejects sends to an unrecognized accountId instead of falling back to the default bot", async () => {
    const runtime = createRuntime();
    const managerA = {
      sendMessageWithReceipt: vi.fn().mockResolvedValue({
        kind: "not_delivered",
        code: "EMPTY",
        message: "No content",
      }),
    };
    const managerB = {
      sendMessageWithReceipt: vi.fn().mockResolvedValue({
        kind: "not_delivered",
        code: "EMPTY",
        message: "No content",
      }),
    };
    const service = createTelegramService({
      bot: {},
      messageManager: managerA,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a", messageManager: managerA, bot: {} }],
        ["acct-b", { accountId: "acct-b", messageManager: managerB, bot: {} }],
      ]),
    });

    await expect(
      service.handleSendMessage(
        runtime,
        { source: "telegram", accountId: "acct-ghost", channelId: "-100123" },
        { text: "hello" },
      ),
    ).rejects.toThrow(
      "Telegram account acct-ghost is not configured or active",
    );

    expect(managerA.sendMessageWithReceipt).not.toHaveBeenCalled();
    expect(managerB.sendMessageWithReceipt).not.toHaveBeenCalled();
  });

  it("rejects sends without a resolvable Telegram target", async () => {
    const runtime = createRuntime();
    const manager = {
      sendMessageWithReceipt: vi.fn().mockResolvedValue({
        kind: "not_delivered",
        code: "EMPTY",
        message: "No content",
      }),
    };
    const service = createTelegramService({
      bot: {},
      messageManager: manager,
    });

    await expect(
      service.handleSendMessage(
        runtime,
        { source: "telegram" },
        { text: "hello" },
      ),
    ).rejects.toThrow(
      "Telegram SendHandler requires channelId, roomId, or entityId.",
    );
    expect(manager.sendMessageWithReceipt).not.toHaveBeenCalled();
  });

  it("resolves known chats into connector targets", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      knownChats: new Map([
        [
          "-100123",
          {
            id: -100123,
            type: "supergroup",
            title: "Ops Room",
            is_forum: true,
          },
        ],
      ]),
    });

    const targets = await service.resolveConnectorTargets("ops", { runtime });

    expect(targets[0]).toMatchObject({
      label: "Ops Room",
      kind: "group",
      target: { source: "telegram", channelId: "-100123" },
    });
  });

  it("does not stamp known chats onto the wrong account", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a" }],
        ["acct-b", { accountId: "acct-b" }],
      ]),
      knownChats: new Map([
        [
          "acct-a:-100111",
          {
            id: -100111,
            type: "supergroup",
            title: "A Room",
          },
        ],
        [
          "acct-b:-100222",
          {
            id: -100222,
            type: "supergroup",
            title: "B Room",
          },
        ],
      ]),
    });

    const targets = await service.listConnectorRooms({ runtime });

    expect(
      targets.map((target) => ({
        accountId: target.target.accountId,
        channelId: target.target.channelId,
      })),
    ).toEqual([
      { accountId: "acct-a", channelId: "-100111" },
      { accountId: "acct-b", channelId: "-100222" },
    ]);
  });

  it("does not use legacy unscoped known chats for non-default accounts", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a" }],
        ["acct-b", { accountId: "acct-b" }],
      ]),
      knownChats: new Map([
        [
          "-100111",
          {
            id: -100111,
            type: "supergroup",
            title: "Legacy Default Room",
          },
        ],
      ]),
    });

    const context = {
      runtime,
      accountId: "acct-b",
      target: { source: "telegram", accountId: "acct-b" },
    };
    const result = await service.getConnectorChatContext(
      { source: "telegram", accountId: "acct-b", channelId: "-100111" },
      context,
    );

    expect(result?.summary).toBeUndefined();
    expect(result?.label).toBe("-100111");
    expect(result?.metadata).toMatchObject({ accountId: "acct-b" });
  });

  it("clamps fetch limits and filters room reads to the target account", async () => {
    const roomId = "room-1" as never;
    const acctAMemory = {
      id: "memory-a",
      roomId,
      content: { text: "from account a" },
      metadata: { accountId: "acct-a" },
      createdAt: 30,
    } as Memory;
    const legacyMemory = {
      id: "memory-legacy",
      roomId,
      content: { text: "legacy memory without account metadata" },
      metadata: {},
      createdAt: 20,
    } as Memory;
    const acctBMemory = {
      id: "memory-b",
      roomId,
      content: { text: "from account b" },
      metadata: { accountId: "acct-b" },
      createdAt: 10,
    } as Memory;
    const runtime = {
      ...createRuntime(),
      getMemories: vi
        .fn()
        .mockResolvedValue([acctAMemory, legacyMemory, acctBMemory]),
    };
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a" }],
        ["acct-b", { accountId: "acct-b" }],
      ]),
    });

    const result = await service.fetchConnectorMessages(
      { runtime, accountId: "acct-a" } as never,
      {
        target: { source: "telegram", accountId: "acct-a", roomId },
        limit: 999,
      },
    );

    expect(runtime.getMemories).toHaveBeenCalledWith({
      tableName: "messages",
      roomId,
      limit: 500,
      offset: 0,
      orderBy: "createdAt",
      orderDirection: "desc",
    });
    expect(result).toEqual([acctAMemory, legacyMemory]);
  });

  it("searches complete connector history case-insensitively without a fallback result cap", async () => {
    const roomId = "room-1" as never;
    const runtime = {
      ...createRuntime(),
      getMemories: vi.fn().mockResolvedValue([
        {
          id: "memory-1",
          roomId,
          content: { text: "Deploy finished cleanly" },
          metadata: { accountId: "acct-a" },
          createdAt: 30,
        },
        {
          id: "memory-2",
          roomId,
          content: { text: "unrelated chatter" },
          metadata: { accountId: "acct-a" },
          createdAt: 20,
        },
        {
          id: "memory-3",
          roomId,
          content: { text: "DEPLOY failed loudly" },
          metadata: { accountId: "acct-a" },
          createdAt: 10,
        },
      ] satisfies Partial<Memory>[]),
    };
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([["acct-a", { accountId: "acct-a" }]]),
    });

    const result = await service.searchConnectorMessages(
      { runtime, accountId: "acct-a" } as never,
      {
        target: { source: "telegram", accountId: "acct-a", roomId },
        query: "deploy",
      },
    );

    expect(runtime.getMemories).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500, offset: 0 }),
    );
    expect(result.map((memory) => memory.id)).toEqual(["memory-1", "memory-3"]);
  });

  it("rejects an invalid search limit before reading connector history", async () => {
    const roomId = "room-1" as never;
    const runtime = {
      ...createRuntime(),
      getMemories: vi.fn(),
    };
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([["acct-a", { accountId: "acct-a" }]]),
    });

    await expect(
      service.searchConnectorMessages(
        { runtime, accountId: "acct-a" } as never,
        {
          target: { source: "telegram", accountId: "acct-a", roomId },
          query: "deploy",
          limit: -5,
        },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_MESSAGE_LIMIT_INVALID" });
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("starts non-default accounts when the default account has no token", async () => {
    const runtime = {
      ...createRuntime(),
      character: {
        name: "Agent One",
        settings: {
          telegram: {
            accounts: {
              default: { enabled: true },
              "acct-b": { enabled: true, botToken: "token-b" },
            },
          },
        },
      },
      getSetting: vi.fn().mockReturnValue(undefined),
    } as IAgentRuntime;
    const initializeBot = vi
      .spyOn(
        TelegramService.prototype as TelegramService & {
          initializeBot: (state: unknown) => Promise<void>;
        },
        "initializeBot",
      )
      .mockResolvedValue(undefined);
    const fakeBot = {
      botInfo: { username: "acct_b_bot" },
      launch: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      telegram: { getMe: vi.fn().mockResolvedValue({ id: 2 }) },
      use: vi.fn(),
    };
    const createAccountRuntime = vi
      .spyOn(
        TelegramService.prototype as TelegramService & {
          createAccountRuntime: (account: unknown) => unknown;
        },
        "createAccountRuntime",
      )
      .mockImplementation((account: unknown) => {
        const scopedAccount = account as { accountId: string };
        return {
          accountId: scopedAccount.accountId,
          account,
          bot: fakeBot,
          messageManager: { sendMessageWithReceipt: vi.fn() },
          wiring: {
            commands: false,
            poller: false,
            handlers: false,
            shutdownHooks: false,
          },
        };
      });

    try {
      const service = await TelegramService.start(runtime);

      expect(createAccountRuntime).toHaveBeenCalledTimes(1);
      expect(createAccountRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acct-b", botToken: "token-b" }),
      );
      expect(initializeBot).toHaveBeenCalledTimes(1);
      expect(
        Array.from(
          (
            service as TelegramService & {
              accountStates: Map<string, unknown>;
            }
          ).accountStates.keys(),
        ),
      ).toEqual(["acct-b"]);
    } finally {
      initializeBot.mockRestore();
      createAccountRuntime.mockRestore();
    }
  });

  it("does not launch the full poller when standalone mode owns Telegram", async () => {
    const originalPassive = process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
    const originalStandalone = process.env.ELIZA_TELEGRAM_STANDALONE_BOT;
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "true";
    const runtime = {
      ...createRuntime(),
      character: {
        name: "Agent One",
        settings: {
          telegram: {
            accounts: {
              default: { enabled: true, botToken: "standalone-token" },
            },
          },
        },
      },
      getSetting: vi.fn().mockReturnValue(undefined),
    } as IAgentRuntime;
    const initializeBot = vi
      .spyOn(
        TelegramService.prototype as TelegramService & {
          initializeBot: (state: unknown) => Promise<void>;
        },
        "initializeBot",
      )
      .mockResolvedValue(undefined);

    try {
      const service = await TelegramService.start(runtime);

      expect(service.getBot()).not.toBeNull();
      expect(initializeBot).not.toHaveBeenCalled();
    } finally {
      initializeBot.mockRestore();
      if (originalPassive === undefined) {
        delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
      } else {
        process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = originalPassive;
      }
      if (originalStandalone === undefined) {
        delete process.env.ELIZA_TELEGRAM_STANDALONE_BOT;
      } else {
        process.env.ELIZA_TELEGRAM_STANDALONE_BOT = originalStandalone;
      }
    }
  });

  it("reports a live standalone claim through the canonical Telegram service health", () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      defaultAccountId: "default",
      accountStates: new Map(),
    });
    const bot = {} as never;
    claimTelegramPollerToken("standalone-health-token", {
      bot,
      mode: "standalone",
      ownerId: String(runtime.agentId),
      accountId: "default",
    });

    try {
      markTelegramPollerConnected("standalone-health-token", bot);
      expect(service.getPollerHealth()).toMatchObject({
        ok: true,
        connected: true,
        mode: "standalone",
        accountId: "default",
      });
    } finally {
      releaseTelegramPollerToken("standalone-health-token", bot);
    }
  });

  it("releases poller ownership even when Telegraf stop throws", async () => {
    const runtime = createRuntime();
    const bot = {
      stop: vi.fn(() => {
        throw new Error("already stopped");
      }),
    } as never;
    claimTelegramPollerToken("teardown-token", {
      bot,
      mode: "full",
      ownerId: String(runtime.agentId),
      accountId: "default",
    });
    const service = createTelegramService({
      runtime,
      accountStates: new Map([
        [
          "default",
          {
            accountId: "default",
            account: { accountId: "default", botToken: "teardown-token" },
            bot,
          },
        ],
      ]),
    });

    await service.stop();

    expect(getTelegramPollerClaim("teardown-token")).toBeUndefined();
  });

  it("sorts deduplicated connector targets safely when score contains NaN", () => {
    const targets = [
      {
        label: "t-nan",
        score: NaN,
        target: { source: "telegram", channelId: "123" },
      },
      {
        label: "t-valid",
        score: 0.9,
        target: { source: "telegram", channelId: "456" },
      },
    ] as unknown as import("@elizaos/core").MessageConnectorTarget[];

    targets.sort(compareMessageConnectorTargets);

    expect((targets[0] as unknown as { label: string }).label).toBe("t-valid");
    expect((targets[1] as unknown as { label: string }).label).toBe("t-nan");
  });

  it("tie-breaks equal-score connector targets by label deterministically", () => {
    const targets = [
      {
        label: "z-label",
        score: 0.5,
        target: { source: "telegram", channelId: "123" },
      },
      {
        label: "a-label",
        score: 0.5,
        target: { source: "telegram", channelId: "456" },
      },
    ] as unknown as import("@elizaos/core").MessageConnectorTarget[];

    targets.sort(compareMessageConnectorTargets);

    expect((targets[0] as unknown as { label: string }).label).toBe("a-label");
    expect((targets[1] as unknown as { label: string }).label).toBe("z-label");
  });
});
