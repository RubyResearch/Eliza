/**
 * Discord service mixin: declares the LifeOps Discord service surface and the
 * `withDiscord` mixin that composes the Discord domain's DM-inbox, search, and
 * connector-verification methods onto the LifeOpsService base.
 */
import type { DiscordMessageSearchResult } from "@elizaos/plugin-discord/user-account-scraper";
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
  LifeOpsOwnerBrowserAccessSource,
} from "@elizaos/shared";
import type {
  DiscordConnectorVerification,
  DiscordSendMessageResult,
} from "./domains/discord-service.js";

export interface LifeOpsDiscordService {
  getDiscordConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus>;
  authorizeDiscordConnector(
    side?: LifeOpsConnectorSide,
    source?: LifeOpsOwnerBrowserAccessSource,
  ): Promise<LifeOpsDiscordConnectorStatus>;
  searchDiscordMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    channelId?: string;
    limit?: number;
  }): Promise<DiscordMessageSearchResult[]>;
  captureDiscordDeliveryStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<DiscordMessageSearchResult[]>;
  sendDiscordMessage(request: {
    side?: LifeOpsConnectorSide;
    expectedIdentityId?: string;
    channelId?: string;
    /** Discord user id target (DM via createDM); exclusive with channelId. */
    userId?: string;
    text: string;
    allowTransportFallback?: boolean;
  }): Promise<DiscordSendMessageResult>;
  verifyDiscordConnector(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    sendMessage?: string;
  }): Promise<DiscordConnectorVerification>;
  disconnectDiscord(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus>;
}
