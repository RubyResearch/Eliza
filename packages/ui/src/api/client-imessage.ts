/**
 * ElizaClient extension for native and hosted iMessage connectors. The client
 * consumes plugin-imessage's own setup and data routes so the connector UI does
 * not depend on the personal-assistant plugin or an external bridge.
 */
import { ElizaClient } from "./client-base";

export interface IMessageApiStatus {
  available: boolean;
  connected: boolean;
  bridgeType?: "native" | "blooio" | "none";
  webhookPath?: string | null;
  channelId?: string | null;
  hostPlatform?: "darwin" | "linux" | "win32" | "unknown";
  diagnostics?: string[];
  error?: string | null;
  chatDbAvailable?: boolean;
  sendOnly?: boolean;
  chatDbPath?: string;
  reason?: string | null;
  permissionAction?: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
}

export interface IMessageApiMessage {
  id: string;
  text: string;
  handle: string;
  chatId: string;
  timestamp: number;
  isFromMe: boolean;
  hasAttachments: boolean;
  attachmentPaths?: string[];
}

export interface IMessageApiChat {
  chatId: string;
  chatType: "direct" | "group";
  displayName?: string;
  participants: Array<{
    handle: string;
    isPhoneNumber: boolean;
  }>;
}

export interface GetIMessageMessagesOptions {
  chatId?: string;
  limit?: number;
}

export interface SendIMessageRequest {
  to: string;
  text: string;
  attachmentPaths?: string[];
  mediaUrl?: string;
}

export interface SendIMessageResponse {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

interface IMessageSetupStatusResponse {
  connector: string;
  state: "idle" | "configuring" | "paired" | "error";
  detail?: {
    transport?: "native" | "blooio";
    webhookPath?: string | null;
    channelId?: string | null;
    available: boolean;
    connected: boolean;
    chatDbAvailable?: boolean;
    sendOnly?: boolean;
    chatDbPath?: string;
    reason?: string | null;
    permissionAction?: IMessageApiStatus["permissionAction"];
  };
}

declare module "./client-base" {
  interface ElizaClient {
    getIMessageStatus(): Promise<IMessageApiStatus>;
    getIMessageMessages(
      options?: GetIMessageMessagesOptions,
    ): Promise<{ messages: IMessageApiMessage[]; count: number }>;
    listIMessageChats(): Promise<{ chats: IMessageApiChat[]; count: number }>;
    sendIMessage(request: SendIMessageRequest): Promise<SendIMessageResponse>;
  }
}

function buildQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

ElizaClient.prototype.getIMessageStatus = async function (this: ElizaClient) {
  const result = await this.fetch<IMessageSetupStatusResponse>(
    "/api/setup/imessage/status",
  );
  const detail = result.detail;
  const connected = detail?.connected ?? result.state === "paired";
  const available = detail?.available ?? false;
  return {
    available,
    connected,
    bridgeType: detail?.transport ?? (available ? "native" : "none"),
    webhookPath: detail?.webhookPath,
    channelId: detail?.channelId,
    error:
      result.state === "error"
        ? (detail?.reason ?? "iMessage setup failed")
        : null,
    chatDbAvailable: detail?.chatDbAvailable,
    sendOnly: detail?.sendOnly,
    chatDbPath: detail?.chatDbPath,
    reason: detail?.reason ?? null,
    permissionAction: detail?.permissionAction ?? null,
  } satisfies IMessageApiStatus;
};

ElizaClient.prototype.getIMessageMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.chatId?.trim()) {
    params.set("chatId", options.chatId.trim());
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(options.limit));
  }
  return this.fetch<{ messages: IMessageApiMessage[]; count: number }>(
    `/api/imessage/messages${buildQuery(params)}`,
  );
};

ElizaClient.prototype.listIMessageChats = async function (this: ElizaClient) {
  return this.fetch<{ chats: IMessageApiChat[]; count: number }>(
    "/api/imessage/chats",
  );
};

ElizaClient.prototype.sendIMessage = async function (
  this: ElizaClient,
  request,
) {
  const mediaUrl = request.mediaUrl ?? request.attachmentPaths?.[0];
  const body = {
    to: request.to,
    text: request.text,
    ...(mediaUrl ? { mediaUrl } : {}),
  };
  return this.fetch<SendIMessageResponse>("/api/imessage/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
};
