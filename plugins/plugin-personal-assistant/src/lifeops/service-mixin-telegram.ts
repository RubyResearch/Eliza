/**
 * Telegram service mixin: declares the LifeOps Telegram service surface and the
 * mixin that composes the telegram domain's search/send/verify methods onto the
 * LifeOpsService base.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramConnectorStatus,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import type {
  TelegramMessageSearchResult,
  TelegramSendMessageResult,
} from "./domains/telegram-service.js";

/** Public surface added by {@link withTelegram}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsTelegramService {
  getTelegramConnectorStatus(
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsTelegramConnectorStatus>;
  sendTelegramMessage(request: {
    side?: LifeOpsConnectorSide;
    expectedIdentityId?: string;
    target: string;
    message: string;
  }): Promise<TelegramSendMessageResult>;
  verifyTelegramConnector(
    request: VerifyLifeOpsTelegramConnectorRequest,
  ): Promise<VerifyLifeOpsTelegramConnectorResponse>;
  searchTelegramMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<TelegramMessageSearchResult[]>;
}
