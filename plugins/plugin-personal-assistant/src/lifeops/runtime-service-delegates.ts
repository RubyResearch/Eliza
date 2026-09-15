/**
 * Delegation seam from LifeOps domains to connector-plugin runtime services:
 * resolves the runtime service for each connector (iMessage, WhatsApp,
 * Telegram, X) and forwards read/send calls, so LifeOps holds no
 * connector transport of its own and never depends on connector internals.
 */
import {
  type Content,
  type IAgentRuntime,
  type Memory,
  requireConfirmedSendHandlerDelivery,
  type SendHandlerResult,
  type TargetInfo,
} from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import {
  assertConnectorSenderIdentity,
  dispatchWithDeliveryEvidence,
} from "./messaging/connector-delivery-evidence.js";

type WhatsAppSendRequest = {
  to: string;
  text: string;
  replyToMessageId?: string;
};

export type RuntimeServiceDelegationResult<T> =
  | {
      status: "handled";
      accountId: string;
      value: T;
    }
  | {
      status: "unavailable";
      reason: string;
      error?: unknown;
    };

type ConnectorGrantAccountRef = Pick<
  LifeOpsConnectorGrant,
  "id" | "connectorAccountId" | "cloudConnectionId" | "metadata"
>;

type ConnectorQueryContext = {
  runtime: IAgentRuntime;
  source: string;
  accountId: string;
  account: { accountId: string };
  target?: TargetInfo;
};

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveRuntimeConnectorAccountId(args: {
  accountId?: string | null;
  grant?: ConnectorGrantAccountRef | null;
  defaultAccountId?: string;
}): string {
  const metadata = objectRecord(args.grant?.metadata);
  return (
    trimmedString(args.accountId) ??
    trimmedString(args.grant?.connectorAccountId) ??
    trimmedString(metadata?.accountId) ??
    trimmedString(metadata?.connectorAccountId) ??
    trimmedString(args.grant?.cloudConnectionId) ??
    args.defaultAccountId ??
    "default"
  );
}

function getRuntimeService<T>(
  runtime: IAgentRuntime,
  serviceTypes: readonly string[],
): T | null {
  for (const serviceType of serviceTypes) {
    const service = runtime.getService(serviceType);
    if (service && typeof service === "object") {
      return service as T;
    }
  }
  return null;
}

function connectorContext(args: {
  runtime: IAgentRuntime;
  source: string;
  accountId: string;
  target?: TargetInfo;
}): ConnectorQueryContext {
  return {
    runtime: args.runtime,
    source: args.source,
    accountId: args.accountId,
    account: { accountId: args.accountId },
    target: args.target
      ? ({ ...args.target, accountId: args.accountId } as TargetInfo)
      : undefined,
  };
}

function connectorTarget(args: {
  source: string;
  accountId: string;
  channelId?: string;
  threadId?: string;
  entityId?: string;
  roomId?: string;
  metadata?: Record<string, unknown>;
}): TargetInfo {
  return {
    source: args.source,
    accountId: args.accountId,
    channelId: args.channelId,
    threadId: args.threadId,
    entityId: args.entityId,
    roomId: args.roomId,
    metadata: {
      ...args.metadata,
      accountId: args.accountId,
    },
  } as TargetInfo;
}

function unavailable<T>(
  reason: string,
  error?: unknown,
): RuntimeServiceDelegationResult<T> {
  return error === undefined
    ? { status: "unavailable", reason }
    : { status: "unavailable", reason, error };
}

type XRuntimeServiceLike = {
  getAccountStatus?: (accountId: string) => Promise<{
    accountId?: string;
    configured?: boolean;
    connected?: boolean;
    reason?: string;
    identity?: Record<string, unknown> | null;
    grantedCapabilities?: string[];
    grantedScopes?: string[];
    authMode?: string;
  }>;
  sendDirectMessageForAccount?: (
    accountId: string,
    params: { participantId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  fetchDirectMessagesForAccount?: (
    accountId: string,
    params?: { participantId?: string; limit?: number },
  ) => Promise<Memory[]>;
  createPostForAccount?: (
    accountId: string,
    params: { text: string; replyToTweetId?: string },
  ) => Promise<Memory>;
  fetchFeedForAccount?: (
    accountId: string,
    params?: {
      feedType?: string;
      userId?: string;
      limit?: number;
      cursor?: string;
    },
  ) => Promise<Memory[]>;
  searchPostsForAccount?: (
    accountId: string,
    params: { query: string; limit?: number; cursor?: string },
  ) => Promise<Memory[]>;
  sendDirectMessageToConversationForAccount?: (
    accountId: string,
    params: { conversationId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  createDirectMessageGroupForAccount?: (
    accountId: string,
    params: { participantIds: string[]; text: string },
  ) => Promise<{
    ok?: boolean;
    status?: number;
    conversationId?: string | null;
    messageId?: string | null;
  }>;
  handleSendMessage?: (
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ) => SendHandlerResult;
  fetchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  handleSendPost?: (
    runtime: IAgentRuntime,
    content: Content,
    context?: Record<string, unknown>,
  ) => Promise<Memory>;
  fetchConnectorFeed?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  searchConnectorPosts?: (
    context: ConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string },
  ) => Promise<Memory[]>;
};

function getXRuntimeService(
  runtime: IAgentRuntime,
): XRuntimeServiceLike | null {
  return getRuntimeService<XRuntimeServiceLike>(runtime, ["x", "twitter"]);
}

export async function getXAccountStatusWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
}): Promise<
  RuntimeServiceDelegationResult<{
    accountId: string;
    configured: boolean;
    connected: boolean;
    reason: string;
    identity: Record<string, unknown> | null;
    grantedCapabilities: string[];
    grantedScopes: string[];
    authMode?: string;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (typeof service?.getAccountStatus !== "function") {
    return unavailable("X runtime service getAccountStatus is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const status = await service.getAccountStatus(accountId);
    return {
      status: "handled",
      accountId,
      value: {
        accountId: status.accountId ?? accountId,
        configured: status.configured === true,
        connected: status.connected === true,
        reason: typeof status.reason === "string" ? status.reason : "connected",
        identity: status.identity ?? null,
        grantedCapabilities: Array.isArray(status.grantedCapabilities)
          ? status.grantedCapabilities
          : [],
        grantedScopes: Array.isArray(status.grantedScopes)
          ? status.grantedScopes
          : [],
        authMode:
          typeof status.authMode === "string" ? status.authMode : undefined,
      },
    };
  } catch (error) {
    return unavailable("X runtime service getAccountStatus failed.", error);
  }
}

export async function sendXDirectMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantId: string;
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.sendDirectMessageForAccount !== "function" &&
    typeof service?.handleSendMessage !== "function"
  ) {
    return unavailable(
      "X runtime service handleSendMessage is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.sendDirectMessageForAccount === "function") {
    try {
      const value = await service.sendDirectMessageForAccount(accountId, {
        participantId: args.participantId,
        text: args.text,
      });
      return {
        status: "handled",
        accountId,
        value: {
          ok: true,
          status: value.status ?? 201,
          externalId: value.messageId ?? null,
        },
      };
    } catch (error) {
      return unavailable(
        "X runtime service sendDirectMessageForAccount failed.",
        error,
      );
    }
  }

  const target = connectorTarget({
    source: "x",
    accountId,
    channelId: args.participantId,
    entityId: args.participantId,
    metadata: { xUserId: args.participantId },
  });
  const handleSendMessage = service.handleSendMessage;
  if (typeof handleSendMessage !== "function") {
    return unavailable(
      "X runtime service handleSendMessage is not registered.",
    );
  }
  try {
    const delivery = requireConfirmedSendHandlerDelivery(
      await handleSendMessage(args.runtime, target, {
        text: args.text,
        source: "lifeops",
        metadata: { accountId },
      } as Content),
    );
    return {
      status: "handled",
      accountId,
      value: {
        ok: true,
        status: 201,
        externalId: delivery.providerMessageId ?? null,
      },
    };
  } catch (error) {
    // error-policy:J1 connector-service boundary refuses to translate an
    // unconfirmed structural outcome into `{ ok: true }`.
    return unavailable("X runtime service handleSendMessage failed.", error);
  }
}

export async function fetchXDirectMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.fetchDirectMessagesForAccount !== "function" &&
    typeof service?.fetchConnectorMessages !== "function"
  ) {
    return unavailable(
      "X runtime service fetchConnectorMessages is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.fetchDirectMessagesForAccount === "function") {
    try {
      const value = await service.fetchDirectMessagesForAccount(accountId, {
        participantId: args.participantId,
        limit: args.limit,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return unavailable(
        "X runtime service fetchDirectMessagesForAccount failed.",
        error,
      );
    }
  }

  const target = args.participantId
    ? connectorTarget({
        source: "x",
        accountId,
        channelId: args.participantId,
        entityId: args.participantId,
      })
    : undefined;
  const fetchConnectorMessages = service.fetchConnectorMessages;
  if (typeof fetchConnectorMessages !== "function") {
    return unavailable(
      "X runtime service fetchConnectorMessages is not registered.",
    );
  }
  try {
    const value = await fetchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: "x",
        accountId,
        target,
      }),
      { accountId, target, limit: args.limit },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable(
      "X runtime service fetchConnectorMessages failed.",
      error,
    );
  }
}

export async function createXPostWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  text: string;
  replyToTweetId?: string;
}): Promise<RuntimeServiceDelegationResult<Memory>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.createPostForAccount !== "function" &&
    typeof service?.handleSendPost !== "function"
  ) {
    return unavailable(
      "X runtime service createPostForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.createPostForAccount === "function") {
    try {
      const value = await service.createPostForAccount(accountId, {
        text: args.text,
        replyToTweetId: args.replyToTweetId,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return unavailable(
        "X runtime service createPostForAccount failed.",
        error,
      );
    }
  }

  const handleSendPost = service.handleSendPost;
  if (typeof handleSendPost !== "function") {
    return unavailable("X runtime service handleSendPost is not registered.");
  }

  try {
    const value = await handleSendPost(
      args.runtime,
      {
        text: args.text,
        ...(args.replyToTweetId ? { replyToTweetId: args.replyToTweetId } : {}),
        metadata: { accountId },
      } as Content,
      {
        runtime: args.runtime,
        source: "x",
        accountId,
        account: { accountId },
        metadata: { accountId },
        target: connectorTarget({ source: "x", accountId }),
      },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable("X runtime service handleSendPost failed.", error);
  }
}

export async function fetchXFeedWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  feedType: string;
  limit?: number;
  cursor?: string;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.fetchFeedForAccount !== "function" &&
    typeof service?.fetchConnectorFeed !== "function"
  ) {
    return unavailable(
      "X runtime service fetchFeedForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.fetchFeedForAccount === "function") {
    try {
      const value = await service.fetchFeedForAccount(accountId, {
        feedType: args.feedType,
        limit: args.limit,
        cursor: args.cursor,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return unavailable(
        "X runtime service fetchFeedForAccount failed.",
        error,
      );
    }
  }

  const fetchConnectorFeed = service.fetchConnectorFeed;
  if (typeof fetchConnectorFeed !== "function") {
    return unavailable(
      "X runtime service fetchConnectorFeed is not registered.",
    );
  }

  try {
    const context = connectorContext({
      runtime: args.runtime,
      source: "x",
      accountId,
    });
    const value = await fetchConnectorFeed(context, {
      accountId,
      feed: args.feedType,
      limit: args.limit,
      cursor: args.cursor,
    });
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable("X runtime service fetchConnectorFeed failed.", error);
  }
}

export async function searchXPostsWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  limit?: number;
  cursor?: string;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.searchPostsForAccount !== "function" &&
    typeof service?.searchConnectorPosts !== "function"
  ) {
    return unavailable(
      "X runtime service searchPostsForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.searchPostsForAccount === "function") {
    try {
      const value = await service.searchPostsForAccount(accountId, {
        query: args.query,
        limit: args.limit,
        cursor: args.cursor,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return unavailable(
        "X runtime service searchPostsForAccount failed.",
        error,
      );
    }
  }

  const searchConnectorPosts = service.searchConnectorPosts;
  if (typeof searchConnectorPosts !== "function") {
    return unavailable(
      "X runtime service searchConnectorPosts is not registered.",
    );
  }

  try {
    const value = await searchConnectorPosts(
      connectorContext({ runtime: args.runtime, source: "x", accountId }),
      { query: args.query, limit: args.limit, cursor: args.cursor },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable("X runtime service searchConnectorPosts failed.", error);
  }
}

export async function sendXConversationMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  conversationId: string;
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.sendDirectMessageToConversationForAccount !== "function"
  ) {
    return unavailable(
      "X runtime service sendDirectMessageToConversationForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const value = await service.sendDirectMessageToConversationForAccount(
      accountId,
      {
        conversationId: args.conversationId,
        text: args.text,
      },
    );
    return {
      status: "handled",
      accountId,
      value: {
        ok: true,
        status: value.status ?? 201,
        externalId: value.messageId ?? null,
      },
    };
  } catch (error) {
    return unavailable(
      "X runtime service sendDirectMessageToConversationForAccount failed.",
      error,
    );
  }
}

export async function createXDirectMessageGroupWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantIds: string[];
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    conversationId: string | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (typeof service?.createDirectMessageGroupForAccount !== "function") {
    return unavailable(
      "X runtime service createDirectMessageGroupForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const value = await service.createDirectMessageGroupForAccount(accountId, {
      participantIds: args.participantIds,
      text: args.text,
    });
    return {
      status: "handled",
      accountId,
      value: {
        ok: true,
        status: value.status ?? 201,
        conversationId: value.conversationId ?? null,
        externalId: value.messageId ?? null,
      },
    };
  } catch (error) {
    return unavailable(
      "X runtime service createDirectMessageGroupForAccount failed.",
      error,
    );
  }
}

type ConnectorMessageRuntimeServiceLike = {
  handleSendMessage?: (
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ) => SendHandlerResult;
  fetchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  searchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
};

async function searchMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  serviceType: string;
  source: string;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getRuntimeService<ConnectorMessageRuntimeServiceLike>(
    args.runtime,
    [args.serviceType],
  );
  if (typeof service?.searchConnectorMessages !== "function") {
    return unavailable(
      `${args.source} runtime service searchConnectorMessages is not registered.`,
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: args.source,
    accountId,
    channelId: args.channelId,
    roomId: args.roomId,
  });
  try {
    const value = await service.searchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: args.source,
        accountId,
        target,
      }),
      {
        accountId,
        target,
        query: args.query,
        channelId: args.channelId,
        roomId: args.roomId,
        limit: args.limit,
      },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable(
      `${args.source} runtime service searchConnectorMessages failed.`,
      error,
    );
  }
}

export function searchDiscordMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  return searchMessagesWithRuntimeService({
    ...args,
    serviceType: "discord",
    source: "discord",
  });
}

export async function sendDiscordMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  expectedIdentityId?: string;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  channelId: string;
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    delivery: ReturnType<typeof requireConfirmedSendHandlerDelivery>;
  }>
> {
  const service = getRuntimeService<
    ConnectorMessageRuntimeServiceLike & {
      client?: { user?: { id?: string } | null } | null;
    }
  >(args.runtime, ["discord"]);
  if (typeof service?.handleSendMessage !== "function") {
    return unavailable(
      "Discord runtime service handleSendMessage is not registered.",
    );
  }
  const handleSendMessage = service.handleSendMessage;
  assertConnectorSenderIdentity(
    "discord",
    args.expectedIdentityId,
    service.client?.user?.id ?? null,
  );
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: "discord",
    accountId,
    channelId: args.channelId,
  });
  try {
    const delivery = await dispatchWithDeliveryEvidence({
      provider: "discord",
      accountId,
      channelId: args.channelId,
      dispatch: () =>
        handleSendMessage.call(service, args.runtime, target, {
          text: args.text,
          source: "lifeops",
          metadata: { accountId },
        } as Content),
    });
    return { status: "handled", accountId, value: { ok: true, delivery } };
  } catch (error) {
    // error-policy:J1 connector-service boundary refuses to translate an
    // unconfirmed structural outcome into `{ ok: true }`.
    return unavailable(
      "Discord runtime service handleSendMessage failed.",
      error,
    );
  }
}

export function searchTelegramMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  return searchMessagesWithRuntimeService({
    ...args,
    serviceType: "telegram",
    source: "telegram",
  });
}

export async function sendTelegramMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  expectedIdentityId?: string;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  target: string;
  message: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    delivery: ReturnType<typeof requireConfirmedSendHandlerDelivery>;
  }>
> {
  const service = getRuntimeService<
    ConnectorMessageRuntimeServiceLike & {
      bot?: { botInfo?: { id?: string | number } | null } | null;
    }
  >(args.runtime, ["telegram"]);
  if (typeof service?.handleSendMessage !== "function") {
    return unavailable(
      "Telegram runtime service handleSendMessage is not registered.",
    );
  }
  const handleSendMessage = service.handleSendMessage;
  assertConnectorSenderIdentity(
    "telegram",
    args.expectedIdentityId,
    service.bot?.botInfo?.id !== undefined
      ? String(service.bot.botInfo.id)
      : null,
  );
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: "telegram",
    accountId,
    channelId: args.target,
  });
  try {
    const delivery = await dispatchWithDeliveryEvidence({
      provider: "telegram",
      accountId,
      channelId: args.target,
      dispatch: () =>
        handleSendMessage.call(service, args.runtime, target, {
          text: args.message,
          source: "lifeops",
          metadata: { accountId },
        } as Content),
    });
    return { status: "handled", accountId, value: { ok: true, delivery } };
  } catch (error) {
    // error-policy:J1 connector-service boundary refuses to translate an
    // unconfirmed structural outcome into `{ ok: true }`.
    return unavailable(
      "Telegram runtime service handleSendMessage failed.",
      error,
    );
  }
}

type WhatsAppRuntimeServiceLike = ConnectorMessageRuntimeServiceLike & {
  sendMessage?: (message: {
    accountId?: string;
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }) => Promise<{ messages?: Array<{ id?: string }> }>;
};

function firstMessageId(result: {
  messages?: Array<{ id?: string }>;
}): string | null {
  return trimmedString(result.messages?.[0]?.id);
}

export async function sendWhatsAppMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  request: WhatsAppSendRequest;
}): Promise<RuntimeServiceDelegationResult<{ ok: true; messageId: string }>> {
  const service = getRuntimeService<WhatsAppRuntimeServiceLike>(args.runtime, [
    "whatsapp",
  ]);
  if (typeof service?.sendMessage !== "function") {
    return unavailable(
      "WhatsApp runtime service sendMessage is not registered.",
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const sent = await service.sendMessage({
      accountId,
      type: "text",
      to: args.request.to,
      content: args.request.text,
      replyToMessageId: args.request.replyToMessageId,
    });
    const messageId = firstMessageId(sent);
    if (!messageId) {
      return unavailable(
        "WhatsApp runtime service sendMessage returned invalid data.",
      );
    }
    return {
      status: "handled",
      accountId,
      value: { ok: true, messageId },
    };
  } catch (error) {
    return unavailable("WhatsApp runtime service sendMessage failed.", error);
  }
}

export async function fetchWhatsAppMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  chatId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getRuntimeService<WhatsAppRuntimeServiceLike>(args.runtime, [
    "whatsapp",
  ]);
  if (typeof service?.fetchConnectorMessages !== "function") {
    return unavailable(
      "WhatsApp runtime service fetchConnectorMessages is not registered.",
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = args.chatId
    ? connectorTarget({ source: "whatsapp", accountId, channelId: args.chatId })
    : undefined;
  try {
    const value = await service.fetchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: "whatsapp",
        accountId,
        target,
      }),
      { accountId, target, channelId: args.chatId, limit: args.limit },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return unavailable(
      "WhatsApp runtime service fetchConnectorMessages failed.",
      error,
    );
  }
}

type IMessageRuntimeServiceLike = ConnectorMessageRuntimeServiceLike & {
  sendMessage?: (
    to: string,
    text: string,
    options?: { accountId?: string; mediaUrl?: string; maxBytes?: number },
  ) => Promise<{
    success: boolean;
    messageId?: string;
    chatId?: string;
    error?: string;
  }>;
  getMessages?: (options?: {
    chatId?: string;
    limit?: number;
    accountId?: string;
  }) => Promise<unknown[]>;
  getRecentMessages?: (limit?: number) => Promise<unknown[]>;
};

export async function sendIMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl?: string;
  maxBytes?: number;
}): Promise<
  RuntimeServiceDelegationResult<{
    success: boolean;
    messageId?: string;
    chatId?: string;
  }>
> {
  const service = getRuntimeService<IMessageRuntimeServiceLike>(args.runtime, [
    "imessage",
  ]);
  if (typeof service?.sendMessage !== "function") {
    return unavailable(
      "iMessage runtime service sendMessage is not registered.",
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const sent = await service.sendMessage(args.to, args.text, {
      accountId,
      mediaUrl: args.mediaUrl,
      maxBytes: args.maxBytes,
    });
    if (!sent.success) {
      return unavailable(
        sent.error ?? "iMessage runtime service sendMessage failed.",
      );
    }
    return { status: "handled", accountId, value: sent };
  } catch (error) {
    return unavailable("iMessage runtime service sendMessage failed.", error);
  }
}

export async function readIMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  chatId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<unknown[]>> {
  const service = getRuntimeService<IMessageRuntimeServiceLike>(args.runtime, [
    "imessage",
  ]);
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    if (typeof service?.getMessages === "function") {
      return {
        status: "handled",
        accountId,
        value: await service.getMessages({
          chatId: args.chatId,
          limit: args.limit,
          accountId,
        }),
      };
    }
    if (typeof service?.getRecentMessages === "function") {
      return {
        status: "handled",
        accountId,
        value: await service.getRecentMessages(args.limit),
      };
    }
    return unavailable(
      "iMessage runtime service read method is not registered.",
    );
  } catch (error) {
    return unavailable("iMessage runtime service read failed.", error);
  }
}
