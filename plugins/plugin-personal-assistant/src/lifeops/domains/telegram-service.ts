/**
 * Telegram domain for LifeOps: searches and sends the owner's Telegram messages
 * through the runtime-service delegates and projects connector status into
 * assistant DTOs. Transport is owned by the Telegram connector plugin.
 */
import type { SendHandlerReceipt } from "@elizaos/core";
import {
  LIFEOPS_TELEGRAM_CAPABILITIES,
  type LifeOpsConnectorDegradation,
  type LifeOpsConnectorSide,
  type LifeOpsTelegramCapability,
  type LifeOpsTelegramConnectorStatus,
  type VerifyLifeOpsTelegramConnectorRequest,
  type VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  ConnectorDeliveryEvidenceError,
  ConnectorSenderChangedError,
} from "../messaging/connector-delivery-evidence.js";
import {
  searchTelegramMessagesWithRuntimeService,
  sendTelegramMessageWithRuntimeService,
} from "../runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "../service-mixin-core.js";
import { fail, requireNonEmptyString } from "../service-normalize.js";
import { normalizeOptionalConnectorSide } from "../service-normalize-connector.js";

/** Provider evidence retained for approvals and scheduled deliveries. */
export type TelegramSendMessageResult = {
  ok: true;
  messageId: string | null;
  receipt: SendHandlerReceipt | null;
};

export type TelegramMessageSearchResult = {
  id: string | null;
  dialogId: string | null;
  threadId: string | null;
  dialogTitle: string | null;
  username: string | null;
  peerId: string | null;
  senderId: string | null;
  content: string;
  timestamp: string | null;
  outgoing: boolean;
};

export type TelegramReadReceiptResult = {
  messageId: string;
  status: "delivered_read" | "sent" | "unknown";
  isRead: boolean | null;
  timestamp: string | null;
  content: string | null;
  outgoing: boolean | null;
};

const FULL_TELEGRAM_CAPABILITIES: LifeOpsTelegramCapability[] = [
  ...LIFEOPS_TELEGRAM_CAPABILITIES,
];

const TELEGRAM_PLUGIN_SETUP_MESSAGE =
  "Telegram is managed by @elizaos/plugin-telegram. Configure and enable the Telegram connector plugin; LifeOps no longer uses local Telegram API credentials.";

type TelegramPluginServiceLike = {
  messageManager?: unknown;
  connected?: boolean;
  isServiceConnected?: () => boolean;
  handleSendMessage?: unknown;
  searchConnectorMessages?: unknown;
  bot?: {
    botInfo?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      firstName?: string;
    } | null;
  } | null;
};

function getTelegramPluginService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): TelegramPluginServiceLike | null {
  const service = runtime.getService?.("telegram") as
    | TelegramPluginServiceLike
    | null
    | undefined;
  return service && typeof service === "object" ? service : null;
}

function telegramPluginConnected(
  service: TelegramPluginServiceLike | null,
): boolean {
  return Boolean(
    service?.messageManager ||
      service?.connected === true ||
      service?.isServiceConnected?.() === true ||
      telegramPluginCanRead(service) ||
      telegramPluginCanSend(service),
  );
}

function telegramPluginCanRead(
  service: TelegramPluginServiceLike | null,
): boolean {
  return typeof service?.searchConnectorMessages === "function";
}

function telegramPluginCanSend(
  service: TelegramPluginServiceLike | null,
): boolean {
  return typeof service?.handleSendMessage === "function";
}

function telegramReadyCapabilities(args: {
  readReady: boolean;
  sendReady: boolean;
}): LifeOpsTelegramCapability[] {
  return FULL_TELEGRAM_CAPABILITIES.filter((capability) =>
    capability === "telegram.read" ? args.readReady : args.sendReady,
  );
}

function telegramPluginIdentity(
  service: TelegramPluginServiceLike | null,
): LifeOpsTelegramConnectorStatus["identity"] {
  const botInfo = service?.bot?.botInfo;
  if (!botInfo?.id && !botInfo?.username) {
    return null;
  }
  return {
    ...(botInfo.id !== undefined ? { id: String(botInfo.id) } : {}),
    ...(botInfo.username ? { username: botInfo.username } : {}),
    ...(botInfo.first_name || botInfo.firstName
      ? { firstName: botInfo.first_name ?? botInfo.firstName }
      : {}),
  };
}

function telegramStatusDegradations(args: {
  connected: boolean;
  readReady: boolean;
  sendReady: boolean;
}): LifeOpsConnectorDegradation[] {
  const degradations: LifeOpsConnectorDegradation[] = [];
  if (!args.connected) {
    degradations.push({
      axis: "transport-offline",
      code: "telegram_plugin_unavailable",
      message: TELEGRAM_PLUGIN_SETUP_MESSAGE,
      retryable: true,
    });
  }
  if (args.connected && !args.readReady) {
    degradations.push({
      axis: "transport-offline",
      code: "telegram_plugin_read_unavailable",
      message:
        "Telegram is connected, but @elizaos/plugin-telegram does not expose a message search/read path.",
      retryable: true,
    });
  }
  if (args.connected && !args.sendReady) {
    degradations.push({
      axis: "delivery-degraded",
      code: "telegram_plugin_send_unavailable",
      message:
        "Telegram is connected, but @elizaos/plugin-telegram does not expose a send path.",
      retryable: true,
    });
  }
  return degradations;
}

function memoryToTelegramMessageSearchResult(
  memory: unknown,
): TelegramMessageSearchResult {
  const record = memory && typeof memory === "object" ? memory : {};
  const content =
    (record as { content?: { text?: unknown; name?: unknown } }).content ?? {};
  const metadata =
    ((record as { metadata?: unknown }).metadata &&
    typeof (record as { metadata?: unknown }).metadata === "object"
      ? ((record as { metadata?: unknown }).metadata as Record<string, unknown>)
      : {}) ?? {};
  const telegram =
    metadata.telegram && typeof metadata.telegram === "object"
      ? (metadata.telegram as Record<string, unknown>)
      : {};
  const createdAt = Number((record as { createdAt?: unknown }).createdAt);
  const timestamp = Number.isFinite(createdAt)
    ? new Date(createdAt).toISOString()
    : null;
  const id =
    typeof metadata.messageId === "string"
      ? metadata.messageId
      : typeof telegram.messageId === "string"
        ? telegram.messageId
        : typeof (record as { id?: unknown }).id === "string"
          ? (record as { id: string }).id
          : null;
  return {
    id,
    dialogId:
      typeof telegram.chatId === "string"
        ? telegram.chatId
        : typeof metadata.chatId === "string"
          ? metadata.chatId
          : typeof metadata.channelId === "string"
            ? metadata.channelId
            : null,
    threadId:
      typeof telegram.threadId === "string"
        ? telegram.threadId
        : typeof metadata.threadId === "string"
          ? metadata.threadId
          : null,
    dialogTitle:
      typeof metadata.roomName === "string"
        ? metadata.roomName
        : typeof content.name === "string"
          ? content.name
          : null,
    username:
      typeof telegram.username === "string"
        ? telegram.username
        : typeof metadata.username === "string"
          ? metadata.username
          : null,
    peerId:
      typeof telegram.peerId === "string"
        ? telegram.peerId
        : typeof metadata.peerId === "string"
          ? metadata.peerId
          : null,
    senderId:
      typeof telegram.senderId === "string"
        ? telegram.senderId
        : typeof metadata.senderId === "string"
          ? metadata.senderId
          : null,
    content: typeof content.text === "string" ? content.text : "",
    timestamp,
    outgoing:
      (record as { entityId?: unknown; agentId?: unknown }).entityId ===
      (record as { entityId?: unknown; agentId?: unknown }).agentId,
  };
}

/**
 * Telegram connector status / send / search, delegated to the runtime
 * `@elizaos/plugin-telegram` service.
 */
export class TelegramDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async getTelegramConnectorStatus(
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsTelegramConnectorStatus> {
    const side =
      normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
    const pluginService = getTelegramPluginService(this.ctx.runtime);
    const connected = telegramPluginConnected(pluginService);
    const readReady = telegramPluginCanRead(pluginService);
    const sendReady = telegramPluginCanSend(pluginService);
    const degradations = telegramStatusDegradations({
      connected,
      readReady,
      sendReady,
    });
    const grantedCapabilities = connected
      ? telegramReadyCapabilities({ readReady, sendReady })
      : [];

    return {
      provider: "telegram",
      side,
      connected,
      reason: connected ? "connected" : "disconnected",
      identity: connected ? telegramPluginIdentity(pluginService) : null,
      grantedCapabilities,
      authState: connected ? "connected" : "idle",
      authError: connected ? null : TELEGRAM_PLUGIN_SETUP_MESSAGE,
      phone: null,
      managedCredentialsAvailable: false,
      storedCredentialsAvailable: false,
      grant: null,
      ...(degradations.length > 0 ? { degradations } : {}),
    };
  }

  async sendTelegramMessage(request: {
    side?: LifeOpsConnectorSide;
    expectedIdentityId?: string;
    target: string;
    message: string;
  }): Promise<TelegramSendMessageResult> {
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const target = requireNonEmptyString(request.target, "target");
    const message = requireNonEmptyString(request.message, "message");
    const status = await this.getTelegramConnectorStatus(side);
    if (!status.connected) {
      fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
    }
    if (!status.grantedCapabilities.includes("telegram.send")) {
      fail(403, "Telegram plugin is missing send permission.");
    }

    const delegated = await sendTelegramMessageWithRuntimeService({
      runtime: this.ctx.runtime,
      expectedIdentityId: request.expectedIdentityId,
      grant: status.grant,
      target,
      message,
    });
    if (delegated.status === "handled") {
      return {
        ok: true,
        messageId: delegated.value.delivery.providerMessageId ?? null,
        receipt: delegated.value.delivery.receipt ?? null,
      };
    }
    if (
      delegated.error instanceof ConnectorDeliveryEvidenceError ||
      delegated.error instanceof ConnectorSenderChangedError
    )
      throw delegated.error;
    if (delegated.error) {
      this.ctx.logLifeOpsWarn(
        "runtime_service_delegation_failed",
        delegated.reason,
        {
          provider: "telegram",
          operation: "message.send",
          error:
            delegated.error instanceof Error
              ? delegated.error.message
              : String(delegated.error),
        },
      );
    }
    fail(
      503,
      `Telegram runtime service send is unavailable: ${delegated.reason} ${TELEGRAM_PLUGIN_SETUP_MESSAGE}`,
    );
  }

  async verifyTelegramConnector(
    request: VerifyLifeOpsTelegramConnectorRequest,
  ): Promise<VerifyLifeOpsTelegramConnectorResponse> {
    if (request.sendTarget !== undefined || request.sendMessage !== undefined) {
      fail(
        400,
        "Telegram verification is read-only. Draft a message and obtain owner approval before testing outbound delivery.",
      );
    }
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const status = await this.getTelegramConnectorStatus(side);
    if (!status.connected) {
      fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
    }

    let read: VerifyLifeOpsTelegramConnectorResponse["read"] = {
      ok: false,
      error: "Telegram plugin is missing read permission.",
      dialogCount: 0,
      dialogs: [],
    };
    if (status.grantedCapabilities.includes("telegram.read")) {
      try {
        const messages = await this.searchTelegramMessages({
          side,
          query: "",
          limit: request.recentLimit,
        });
        read = {
          ok: true,
          error: null,
          dialogCount: messages.length,
          dialogs: [],
        };
      } catch (error) {
        read = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          dialogCount: 0,
          dialogs: [],
        };
      }
    }

    return {
      provider: "telegram",
      side,
      verifiedAt: new Date().toISOString(),
      read,
      send: {
        attempted: false,
        ok: false,
        error:
          "Outbound verification requires a drafted message and explicit owner approval.",
        target: "",
        message: "",
        messageId: null,
      },
    };
  }

  async searchTelegramMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<TelegramMessageSearchResult[]> {
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const status = await this.getTelegramConnectorStatus(side);
    if (!status.connected) {
      fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
    }
    if (!status.grantedCapabilities.includes("telegram.read")) {
      fail(403, "Telegram plugin is missing read permission.");
    }

    const delegated = await searchTelegramMessagesWithRuntimeService({
      runtime: this.ctx.runtime,
      grant: status.grant,
      query: request.query,
      channelId: request.scope,
      limit: request.limit,
    });
    if (delegated.status === "handled") {
      return delegated.value.map(memoryToTelegramMessageSearchResult);
    }
    if (delegated.error) {
      this.ctx.logLifeOpsWarn(
        "runtime_service_delegation_failed",
        delegated.reason,
        {
          provider: "telegram",
          operation: "message.search",
          error:
            delegated.error instanceof Error
              ? delegated.error.message
              : String(delegated.error),
        },
      );
    }
    fail(
      503,
      `Telegram runtime service search is unavailable: ${delegated.reason} ${TELEGRAM_PLUGIN_SETUP_MESSAGE}`,
    );
  }

  async getTelegramDeliveryStatus(_request: {
    side?: LifeOpsConnectorSide;
    target: string;
    messageIds: string[];
  }): Promise<TelegramReadReceiptResult[]> {
    fail(
      501,
      "Telegram delivery receipts require a @elizaos/plugin-telegram runtime read-receipt service. LifeOps no longer calls its local GramJS client.",
    );
  }
}
