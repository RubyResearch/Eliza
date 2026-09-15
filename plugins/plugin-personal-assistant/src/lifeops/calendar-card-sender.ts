/** Resolves the concrete sending identity shown in a calendar-card review and rechecks it before dispatch. */
import { ElizaError } from "@elizaos/core";
import type { CalendarCardChannel } from "./calendar-card.js";
import type { LifeOpsService } from "./service.js";

export interface CalendarCardSenderBinding {
  readonly channel: CalendarCardChannel;
  readonly side: "owner" | "agent";
  readonly transport: string;
  readonly accountId: string;
  readonly identityId: string;
  readonly displayName: string;
}

export class CalendarCardSenderError extends ElizaError {
  constructor(message: string) {
    super(message, { code: "CALENDAR_CARD_SENDER_UNAVAILABLE" });
  }
}

export async function resolveCalendarCardSender(
  service: LifeOpsService,
  channel: CalendarCardChannel,
): Promise<CalendarCardSenderBinding> {
  if (channel === "imessage") {
    const status = await service.getIMessageConnectorStatus();
    if (
      !status.connected ||
      !status.accountHandle ||
      status.bridgeType === "none" ||
      status.sendMode === "none"
    ) {
      throw new CalendarCardSenderError(
        "Connect iMessage with a verified sending account before reviewing a calendar card.",
      );
    }
    return {
      channel,
      side: "owner",
      transport: `${status.bridgeType}:${status.sendMode}`,
      accountId: status.accountHandle,
      identityId: status.accountHandle,
      displayName: status.accountHandle,
    };
  }
  const status =
    channel === "telegram"
      ? await service.getTelegramConnectorStatus("agent")
      : await service.getDiscordConnectorStatus("agent");
  const identityId = status.identity?.id;
  if (
    !status.connected ||
    !identityId ||
    !status.grantedCapabilities.some(
      (capability) => capability === `${channel}.send`,
    )
  ) {
    throw new CalendarCardSenderError(
      `Connect the agent's ${channel} bot with a verified sending identity before reviewing a calendar card.`,
    );
  }
  return {
    channel,
    side: "agent",
    transport: "runtime-bot",
    accountId: "default",
    identityId,
    displayName: status.identity?.username || identityId,
  };
}

export async function assertCalendarCardSender(
  service: LifeOpsService,
  expected: CalendarCardSenderBinding,
): Promise<void> {
  const current = await resolveCalendarCardSender(service, expected.channel);
  if (
    current.side !== expected.side ||
    current.transport !== expected.transport ||
    current.accountId !== expected.accountId ||
    current.identityId !== expected.identityId
  ) {
    throw new CalendarCardSenderError(
      "The sending account or transport changed. Create a fresh calendar-card review.",
    );
  }
}
