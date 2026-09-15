/** Supplies deterministic connector status at the provider boundary for HTTP card review tests; no live delivery is claimed. */
import { vi } from "vitest";
import { LifeOpsService } from "../../src/lifeops/service.js";

export function installCalendarCardConnectorStatusFixtures(): void {
  vi.spyOn(
    LifeOpsService.prototype,
    "getIMessageConnectorStatus",
  ).mockResolvedValue({
    available: true,
    connected: true,
    bridgeType: "native",
    hostPlatform: "darwin",
    accountHandle: "synthetic-imessage-owner",
    sendMode: "cli",
    helperConnected: null,
    privateApiEnabled: null,
    diagnostics: [],
    lastSyncAt: null,
    lastCheckedAt: null,
    error: null,
  });
  const telegram = LifeOpsService.prototype.getTelegramConnectorStatus;
  vi.spyOn(
    LifeOpsService.prototype,
    "getTelegramConnectorStatus",
  ).mockImplementation(async function (this: LifeOpsService, side) {
    return {
      ...(await telegram.call(this, side)),
      connected: true,
      identity: {
        id: "synthetic-telegram-bot",
        username: "Synthetic Telegram",
      },
      grantedCapabilities: ["telegram.send"],
    };
  });
  const discord = LifeOpsService.prototype.getDiscordConnectorStatus;
  vi.spyOn(
    LifeOpsService.prototype,
    "getDiscordConnectorStatus",
  ).mockImplementation(async function (this: LifeOpsService, side) {
    return {
      ...(await discord.call(this, side)),
      connected: true,
      identity: { id: "synthetic-discord-bot", username: "Synthetic Discord" },
      grantedCapabilities: ["discord.send"],
    };
  });
}
