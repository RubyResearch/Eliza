/**
 * iMessage service mixin: declares the LifeOps iMessage service surface and the
 * `withIMessage` mixin that composes the iMessage domain's read/send/status
 * methods onto the LifeOpsService base.
 */
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import type {
  IMessageChat,
  IMessageRecord,
  IMessageSendRequest,
} from "./domains/imessage-service.js";

export type {
  IMessageChat,
  IMessageDeliveryResult,
  IMessageRecord,
  IMessageSendRequest,
} from "./domains/imessage-service.js";

/** Public surface added by {@link withIMessage}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsIMessageService {
  getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus>;
  sendIMessage(
    req: IMessageSendRequest,
  ): Promise<{ ok: true; messageId?: string; messageIds?: string[] }>;
  readIMessages(opts: {
    chatId?: string;
    since?: string;
    limit?: number;
  }): Promise<IMessageRecord[]>;
  listIMessageChats(): Promise<IMessageChat[]>;
}
