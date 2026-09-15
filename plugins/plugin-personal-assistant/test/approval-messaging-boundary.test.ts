/**
 * Approval message preparation selects one connector before execution and
 * never attempts a fallback transport after a provider call has begun.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalConnectorPreflightError,
  prepareCrossChannelSend,
} from "../src/actions/lib/messaging-helpers.js";
import type { LifeOpsService } from "../src/lifeops/service.js";

describe("approval messaging boundary", () => {
  it("does not claim provider idempotency for Twilio SMS", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550000000");
    try {
      const prepared = await prepareCrossChannelSend({
        runtime: {} as IAgentRuntime,
        service: {} as LifeOpsService,
        channel: "sms",
        target: "+15551234567",
        body: "hello",
      });
      expect(prepared.supportsProviderIdempotency).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not fall back after Telegram accepted-then-timeout", async () => {
    const fallback = vi.fn();
    const telegram = vi.fn(async () => {
      throw new Error("acknowledgement timeout after provider acceptance");
    });
    const runtime = {
      sendMessageToTarget: fallback,
    } as unknown as IAgentRuntime;
    const service = {
      getTelegramConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["telegram.send"],
      })),
      sendTelegramMessage: telegram,
    } as unknown as LifeOpsService;

    const prepared = await prepareCrossChannelSend({
      runtime,
      service,
      channel: "telegram",
      target: "chat-1",
      body: "hello",
    });

    await expect(prepared.dispatch("approval:req:telegram")).rejects.toThrow(
      "acknowledgement timeout",
    );
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["telegram-message-1", null])(
    "preserves Telegram evidence and refuses missing identifiers (%s)",
    async (messageId) => {
      const receipt = {
        providerMessageIds: messageId ? [messageId] : [],
        acceptedAt: 1_780_000_000_000,
        persistence: { status: "persisted", memoryIds: [] },
      };
      const prepared = await prepareCrossChannelSend({
        runtime: {} as IAgentRuntime,
        service: {
          getTelegramConnectorStatus: async () => ({
            connected: true,
            grantedCapabilities: ["telegram.send"],
          }),
          sendTelegramMessage: async () => ({ ok: true, messageId, receipt }),
        } as unknown as LifeOpsService,
        channel: "telegram",
        target: "chat-1",
        body: "Synthetic calendar review",
      });
      if (messageId) {
        expect(await prepared.dispatch("telegram-approval")).toEqual({
          provider: "telegram",
          messageId,
          receipt,
        });
      } else {
        await expect(
          prepared.dispatch("telegram-approval"),
        ).rejects.toMatchObject({
          code: "APPROVAL_DELIVERY_UNCERTAIN",
          providerReceipt: { provider: "telegram", messageId: null, receipt },
        });
      }
    },
  );

  it("fails closed before claim when iMessage is unavailable", async () => {
    const sendIMessage = vi.fn();
    const service = {
      getIMessageConnectorStatus: vi.fn(async () => ({
        connected: false,
      })),
      sendIMessage,
    } as unknown as LifeOpsService;

    await expect(
      prepareCrossChannelSend({
        runtime: {} as IAgentRuntime,
        service,
        channel: "imessage",
        target: "+15551234567",
        body: "hello",
      }),
    ).rejects.toMatchObject<Partial<ApprovalConnectorPreflightError>>({
      code: "CONNECTOR_NOT_CONNECTED",
    });
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("pins approval sends to the preselected Discord and iMessage transports", async () => {
    const sendDiscordMessage = vi.fn(async () => ({
      provider: "discord",
      channelId: "channel-1",
      deliveryStatus: "sent" as const,
      providerMessageId: "discord-part-2",
      receipt: {
        providerMessageIds: ["discord-part-1", "discord-part-2"],
        acceptedAt: 1_780_000_000_000,
        persistence: { status: "persisted", memoryIds: [] },
      },
    }));
    const sendIMessage = vi.fn(async () => ({
      ok: true as const,
      messageId: "message-1",
    }));
    const service = {
      getDiscordConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["discord.send"],
      })),
      sendDiscordMessage,
      getIMessageConnectorStatus: vi.fn(async () => ({ connected: true })),
      sendIMessage,
    } as unknown as LifeOpsService;

    const discord = await prepareCrossChannelSend({
      runtime: {} as IAgentRuntime,
      service,
      channel: "discord",
      target: "channel-1",
      body: "hello",
    });
    const imessage = await prepareCrossChannelSend({
      runtime: {} as IAgentRuntime,
      service,
      channel: "imessage",
      target: "+15551234567",
      body: "hello",
    });

    const discordReceipt = await discord.dispatch("approval:discord");
    expect(discordReceipt).toMatchObject({
      messageId: "discord-part-2",
      receipt: { providerMessageIds: ["discord-part-1", "discord-part-2"] },
    });
    await imessage.dispatch("approval:imessage");
    expect(sendDiscordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ allowTransportFallback: false }),
    );
    expect(sendIMessage).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "native" }),
    );
  });
});
