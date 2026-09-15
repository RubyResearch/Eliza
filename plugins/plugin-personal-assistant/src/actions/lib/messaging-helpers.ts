/**
 * Prepares one concrete connector for an approved legacy `send_message`
 * request, then exposes a single dispatch call with a normalized receipt.
 * Preparation performs deterministic configuration checks before the queue
 * claim; dispatch never falls through to a second transport after an attempt.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
} from "@elizaos/plugin-phone/twilio";
import {
  assertCalendarCardSender,
  type CalendarCardSenderBinding,
} from "../../lifeops/calendar-card-sender.js";
import type { LifeOpsService } from "../../lifeops/service.js";
import { ApprovalAmbiguousDeliveryError } from "./approval-delivery-errors.js";

export type CrossChannelSendChannel =
  | "telegram"
  | "discord"
  | "imessage"
  | "sms"
  | "x_dm";

export class ApprovalConnectorPreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalConnectorPreflightError";
  }
}

export class ApprovalKnownNonDeliveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "ApprovalKnownNonDeliveryError";
  }
}

export interface PreparedCrossChannelSend {
  readonly provider: CrossChannelSendChannel;
  readonly supportsProviderIdempotency: boolean;
  dispatch(
    providerIdempotencyKey: string,
  ): Promise<Readonly<Record<string, unknown>>>;
}

interface ConnectorStatus {
  readonly connected?: boolean;
  readonly grantedCapabilities?: ReadonlyArray<string>;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ApprovalConnectorPreflightError(
      "INVALID_DISPATCH_INPUT",
      `${field} must be a non-empty string`,
    );
  }
  return normalized;
}

function requireConnected(
  status: ConnectorStatus,
  provider: CrossChannelSendChannel,
  capability?: string,
): void {
  if (!status.connected) {
    throw new ApprovalConnectorPreflightError(
      "CONNECTOR_NOT_CONNECTED",
      `${provider} is not connected`,
    );
  }
  if (capability && !status.grantedCapabilities?.includes(capability)) {
    throw new ApprovalConnectorPreflightError(
      "CONNECTOR_CAPABILITY_NOT_GRANTED",
      `${provider} is missing ${capability}`,
    );
  }
}

export async function prepareCrossChannelSend(args: {
  runtime: IAgentRuntime;
  service: LifeOpsService;
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
  sender?: CalendarCardSenderBinding;
}): Promise<PreparedCrossChannelSend> {
  const target = requireText(args.target, "target");
  const body = requireText(args.body, "body");
  if (args.sender) {
    if (args.sender.channel !== args.channel)
      throw new ApprovalConnectorPreflightError(
        "CALENDAR_CARD_SENDER_MISMATCH",
        "The approved sender belongs to a different channel.",
      );
    await assertCalendarCardSender(args.service, args.sender);
  }
  const recheckSender = async () => {
    if (!args.sender) return;
    try {
      await assertCalendarCardSender(args.service, args.sender);
    } catch (error) {
      // error-policy:J1 no provider call started; a changed sender requires fresh review.
      throw new ApprovalKnownNonDeliveryError(
        "CALENDAR_CARD_SENDER_CHANGED",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  switch (args.channel) {
    case "telegram": {
      const status = await args.service.getTelegramConnectorStatus(
        args.sender?.side ?? "owner",
      );
      requireConnected(status, "telegram", "telegram.send");
      return {
        provider: "telegram",
        supportsProviderIdempotency: false,
        dispatch: async () => {
          await recheckSender();
          const sent = await args.service.sendTelegramMessage({
            side: args.sender?.side ?? "owner",
            expectedIdentityId: args.sender?.identityId,
            target,
            message: body,
          });
          const receipt = {
            provider: "telegram",
            messageId: sent.messageId,
            receipt: sent.receipt,
          };
          if (!sent.messageId) {
            throw new ApprovalAmbiguousDeliveryError(
              "Telegram returned no provider message identifier; reconcile before sending again.",
              receipt,
            );
          }
          return receipt;
        },
      };
    }
    case "discord": {
      const status = await args.service.getDiscordConnectorStatus(
        args.sender?.side ?? "owner",
      );
      requireConnected(status, "discord", "discord.send");
      return {
        provider: "discord",
        supportsProviderIdempotency: false,
        dispatch: async () => {
          await recheckSender();
          const sent = await args.service.sendDiscordMessage({
            side: args.sender?.side ?? "owner",
            expectedIdentityId: args.sender?.identityId,
            channelId: target,
            text: body,
            allowTransportFallback: false,
          });
          const receipt = {
            provider: sent.provider,
            channelId: "channelId" in sent ? sent.channelId : null,
            deliveryStatus: sent.deliveryStatus,
            messageId: sent.providerMessageId,
            receipt: sent.receipt,
          };
          if (
            sent.deliveryStatus !== "sent" ||
            !sent.providerMessageId ||
            receipt.channelId !== target
          ) {
            throw new ApprovalAmbiguousDeliveryError(
              "Discord delivery is not confirmed for the approved destination. Reconcile the provider evidence before retrying.",
              receipt,
            );
          }
          return receipt;
        },
      };
    }
    case "imessage": {
      const status = await args.service.getIMessageConnectorStatus();
      requireConnected(status, "imessage");
      return {
        provider: "imessage",
        supportsProviderIdempotency: false,
        dispatch: async () => {
          await recheckSender();
          const sent = await args.service.sendIMessage({
            to: target,
            text: body,
            transport: "native",
            ...(args.sender
              ? {
                  expectedAccount: {
                    identityId: args.sender.identityId,
                    transport: args.sender.transport,
                  },
                }
              : {}),
          });
          const receipt = {
            provider: "imessage",
            messageId: sent.messageId ?? null,
            ...(sent.messageIds ? { messageIds: sent.messageIds } : {}),
          };
          if (!sent.messageId?.trim()) {
            throw new ApprovalAmbiguousDeliveryError(
              "iMessage returned no provider message identifier; reconcile before sending again.",
              receipt,
            );
          }
          return receipt;
        },
      };
    }
    case "sms": {
      const credentials = readTwilioCredentialsFromEnv();
      if (!credentials) {
        throw new ApprovalConnectorPreflightError(
          "TWILIO_NOT_CONFIGURED",
          "Twilio SMS credentials are not configured",
        );
      }
      return {
        provider: "sms",
        // Twilio's Messages create endpoint has no documented client-side
        // idempotency contract. Ambiguous outcomes require reconciliation and
        // must not be treated as safely replayable at the provider boundary.
        supportsProviderIdempotency: false,
        dispatch: async (providerIdempotencyKey) => {
          const result = await sendTwilioSms({
            credentials,
            to: target,
            body,
            idempotencyKey: providerIdempotencyKey,
          });
          if (!result.ok) {
            if (result.status === null || result.status >= 500) {
              throw new Error(result.error ?? "Twilio SMS outcome is unknown");
            }
            throw new ApprovalKnownNonDeliveryError(
              "TWILIO_DELIVERY_REJECTED",
              result.error ?? `Twilio rejected SMS with ${result.status}`,
              result.status,
            );
          }
          return {
            provider: "twilio",
            sid: result.sid ?? null,
            status: result.status,
            retryCount: result.retryCount ?? 0,
          };
        },
      };
    }
    case "x_dm": {
      const status = await args.service.getXConnectorStatus("local", "owner");
      requireConnected(status, "x_dm", "x.dm.write");
      return {
        provider: "x_dm",
        supportsProviderIdempotency: false,
        dispatch: async () => {
          const result = await args.service.sendXDirectMessage({
            participantId: target,
            text: body,
            confirmSend: true,
            mode: "local",
            side: "owner",
          });
          if (!result.ok) {
            if (result.status === null || result.status >= 500) {
              throw new Error(result.error ?? "X DM outcome is unknown");
            }
            throw new ApprovalKnownNonDeliveryError(
              "X_DM_DELIVERY_REJECTED",
              result.error ?? `X rejected DM with ${result.status}`,
              result.status,
            );
          }
          return {
            provider: "x",
            status: result.status,
          };
        },
      };
    }
  }
}
