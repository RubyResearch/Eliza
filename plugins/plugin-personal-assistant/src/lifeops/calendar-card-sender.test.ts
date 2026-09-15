/** Exercises card sender resolution and approval dispatch against real domain services with deterministic connector handlers. */
import type { IAgentRuntime, SendHandlerOutcome } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { prepareCrossChannelSend } from "../actions/lib/messaging-helpers.js";
import { resolveCalendarCardSender } from "./calendar-card-sender.js";
import { LifeOpsService } from "./service.js";

function fixture(provider: "telegram" | "discord") {
  const send = vi.fn(
    async (): Promise<SendHandlerOutcome> => ({
      kind: "delivered",
      memories: [],
      receipt: {
        providerMessageIds: ["provider-message-1"],
        acceptedAt: 1_780_000_000_000,
        persistence: { status: "persisted", memoryIds: [] },
      },
    }),
  );
  const connector = {
    handleSendMessage: send,
    messageManager: {},
    isReady: () => true,
    bot: { botInfo: { id: "original-bot", username: "Original bot" } },
    client: { user: { id: "original-bot", username: "Original bot" } },
  };
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Synthetic test" },
    getSetting: () => undefined,
    setSetting: vi.fn(),
    getService: (name: string) => (name === provider ? connector : null),
  } as unknown as IAgentRuntime;
  return { connector, send, runtime, service: new LifeOpsService(runtime) };
}

describe.each(["telegram", "discord"] as const)(
  "%s calendar sender",
  (provider) => {
    it("uses the reviewed bot and retains its delivery receipt", async () => {
      const { service, runtime, send } = fixture(provider);
      const sender = await resolveCalendarCardSender(service, provider);
      const prepared = await prepareCrossChannelSend({
        service,
        runtime,
        channel: provider,
        target: "synthetic-channel",
        body: "Synthetic calendar",
        sender,
      });
      expect(await prepared.dispatch("approval-synthetic")).toMatchObject({
        provider,
        messageId: "provider-message-1",
      });
      expect(send).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining({
          accountId: "default",
          channelId: "synthetic-channel",
        }),
        expect.objectContaining({ text: "Synthetic calendar" }),
      );
    });

    it("refuses an account switch between preparation and dispatch", async () => {
      const { service, runtime, connector, send } = fixture(provider);
      const sender = await resolveCalendarCardSender(service, provider);
      const prepared = await prepareCrossChannelSend({
        service,
        runtime,
        channel: provider,
        target: "synthetic-channel",
        body: "Synthetic calendar",
        sender,
      });
      connector.bot.botInfo.id = "replacement-bot";
      connector.client.user.id = "replacement-bot";
      await expect(
        prepared.dispatch("approval-synthetic"),
      ).rejects.toMatchObject({ code: "CALENDAR_CARD_SENDER_CHANGED" });
      expect(send).not.toHaveBeenCalled();
      await expect(
        prepareCrossChannelSend({
          service,
          runtime,
          channel: provider,
          target: "synthetic-channel",
          body: "Synthetic calendar",
          sender,
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_CARD_SENDER_UNAVAILABLE" });
    });

    it("rejects an account swap inside the domain status await before invoking the captured handler", async () => {
      const { service, runtime, connector, send } = fixture(provider);
      const sender = await resolveCalendarCardSender(service, provider);
      const prepared = await prepareCrossChannelSend({
        service,
        runtime,
        channel: provider,
        target: "synthetic-channel",
        body: "Synthetic calendar",
        sender,
      });
      let checks = 0;
      const swapAfterStatus = () => {
        if (++checks === 2) {
          connector.bot.botInfo.id = "replacement-bot";
          connector.client.user.id = "replacement-bot";
        }
      };
      if (provider === "telegram") {
        const original = service.telegramDomain.getTelegramConnectorStatus.bind(
          service.telegramDomain,
        );
        vi.spyOn(
          service.telegramDomain,
          "getTelegramConnectorStatus",
        ).mockImplementation(async (side) => {
          const status = await original(side);
          swapAfterStatus();
          return status;
        });
      } else {
        const original = service.discordDomain.getDiscordConnectorStatus.bind(
          service.discordDomain,
        );
        vi.spyOn(
          service.discordDomain,
          "getDiscordConnectorStatus",
        ).mockImplementation(async (side) => {
          const status = await original(side);
          swapAfterStatus();
          return status;
        });
      }
      await expect(
        prepared.dispatch("approval-synthetic"),
      ).rejects.toMatchObject({ code: "CONNECTOR_SENDER_CHANGED" });
      expect(send).not.toHaveBeenCalled();
    });

    it("requires a provider identity before creating a review", async () => {
      const { service, connector, send } = fixture(provider);
      connector.bot.botInfo.id = "";
      connector.client.user.id = "";
      await expect(
        resolveCalendarCardSender(service, provider),
      ).rejects.toMatchObject({ code: "CALENDAR_CARD_SENDER_UNAVAILABLE" });
      expect(send).not.toHaveBeenCalled();
    });
  },
);

function imessageFixture(transport: "native" | "blooio" = "blooio") {
  const state = { channelId: "reviewed-blooio-channel" };
  const send = vi.fn(async () => ({
    success: true,
    messageId: "blooio-message-1",
  }));
  const connector = {
    isConnected: () => true,
    sendMessage: send,
    getStatus: () => ({
      transport,
      connected: true,
      available: true,
      channelId: state.channelId,
      chatDbAvailable: false,
      sendOnly: true,
      chatDbPath: "",
      reason: null,
      permissionAction: null,
      webhookPath: "/api/imessage/webhook/blooio",
    }),
  };
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Synthetic test" },
    getSetting: () => undefined,
    setSetting: vi.fn(),
    getService: (name: string) => (name === "imessage" ? connector : null),
  } as unknown as IAgentRuntime;
  return { state, send, runtime, service: new LifeOpsService(runtime) };
}

it("binds hosted iMessage to its real configured channel and returns the receipt", async () => {
  const { service, runtime, send } = imessageFixture();
  const sender = await resolveCalendarCardSender(service, "imessage");
  const prepared = await prepareCrossChannelSend({
    service,
    runtime,
    channel: "imessage",
    target: "synthetic-recipient",
    body: "Synthetic calendar",
    sender,
  });
  expect(await prepared.dispatch("approval-synthetic")).toMatchObject({
    provider: "imessage",
    messageId: "blooio-message-1",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("rejects a hosted iMessage account switch after the approval recheck", async () => {
  const { service, runtime, state, send } = imessageFixture();
  const sender = await resolveCalendarCardSender(service, "imessage");
  const prepared = await prepareCrossChannelSend({
    service,
    runtime,
    channel: "imessage",
    target: "synthetic-recipient",
    body: "Synthetic calendar",
    sender,
  });
  const original = service.imessageDomain.getIMessageConnectorStatus.bind(
    service.imessageDomain,
  );
  vi.spyOn(
    service.imessageDomain,
    "getIMessageConnectorStatus",
  ).mockImplementation(async () => {
    const status = await original();
    state.channelId = "replacement-channel";
    return status;
  });
  await expect(prepared.dispatch("approval-synthetic")).rejects.toMatchObject({
    code: "CONNECTOR_SENDER_CHANGED",
  });
  expect(send).not.toHaveBeenCalled();
});

it("does not infer a native sending account from a hosted channel field", async () => {
  const { service, send } = imessageFixture("native");
  await expect(
    resolveCalendarCardSender(service, "imessage"),
  ).rejects.toMatchObject({ code: "CALENDAR_CARD_SENDER_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
});
