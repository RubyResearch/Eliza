/**
 * The `TelegramService`: launches and supervises a Telegraf long-poll bot per
 * account, maps inbound Telegram updates (messages, reactions, membership
 * changes) into runtime Worlds/Rooms/Entities and `TelegramEventTypes` events,
 * and registers the agent as a `MessageConnector` so outbound sends, edits,
 * reactions, and threads route back out through Telegram.
 *
 * Forum topics become distinct Rooms keyed `<chatId>-<threadId>`. Active pollers
 * are tracked in the shared process-local poller lock so a token is never
 * long-polled twice (Telegram 409s on concurrent getUpdates). Must start before
 * `TelegramOwnerPairingServiceImpl`, which looks up the live bot instance here.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type Entity,
  EventType,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorCreateThreadParams,
  type MessageConnectorEditParams,
  type MessageConnectorPostToThreadParams,
  type MessageConnectorQueryContext,
  type MessageConnectorReactionParams,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Role,
  type Room,
  type SendHandlerResult,
  Service,
  type TargetInfo,
  type ThreadHandle,
  toWellFormedUnicode,
  type UUID,
  type World,
  type WorldPayload,
} from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import type {
  Chat,
  ChatMemberAdministrator,
  ChatMemberOwner,
  User,
} from "telegraf/types";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledTelegramAccounts,
  normalizeTelegramAccountId,
  type ResolvedTelegramAccount,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts";
import {
  applyTelegramSetMyCommands,
  registerTelegramCommandHandlers,
} from "./command-registration";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { checkTelegramDmAccess, resolveTelegramDmPolicy } from "./dm-policy";
import { resolveTelegramRuntimeEntityId } from "./identity";
import { MessageManager } from "./messageManager";
import {
  claimTelegramPollerToken,
  ensureTelegramPollerTokenAvailable,
  getTelegramPollerClaim,
  listTelegramPollerHealth,
  markTelegramPollerConnected,
  markTelegramPollerError,
  markTelegramPollerTerminated,
  markTelegramPollerUpdate,
  releaseTelegramPollerToken,
  type TelegramPollerHealth,
} from "./poller-lock";
import { stopTelegramPolling } from "./poller-stop";
import { shouldStartTelegramStandaloneBot } from "./standalone/policy";
import { registerTelegramTaskBoardCommand } from "./task-board";
import {
  type TelegramEntityPayload,
  TelegramEventTypes,
  type TelegramWorldPayload,
} from "./types";
import { buildTelegramWorldOwnership } from "./world-ownership";

const CANONICAL_OWNER_SETTING_KEYS = ["ELIZA_ADMIN_ENTITY_ID"] as const;
const TELEGRAM_CONNECTOR_CONTEXTS = ["social", "connectors"];
const TELEGRAM_CONNECTOR_CAPABILITIES = [
  "send_message",
  "edit_message",
  "react_message",
  "resolve_targets",
  "list_rooms",
  "chat_context",
  "user_context",
  "create_thread",
  "post_to_thread",
];
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_THREADED_CHANNEL_PATTERN = /^(-?\d+)-(\d+)$/;

type AccountScopedTargetInfo = TargetInfo & { accountId?: string };
type AccountScopedConnectorContext = MessageConnectorQueryContext & {
  accountId?: string;
  account?: { accountId?: string };
};

type TelegramConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: TelegramConnectorReadParams,
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams & { query: string },
  ) => Promise<Memory[]>;
  getUser?: (
    runtime: IAgentRuntime,
    params: {
      entityId?: UUID | string;
      userId?: string;
      username?: string;
      handle?: string;
    },
  ) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

type TelegramTargetParts = {
  chatId: number | string;
  threadId?: number;
};

function normalizeConnectorLimit(
  limit: number | undefined,
): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ElizaError("Telegram limit must be a positive integer", {
      code: "TELEGRAM_MESSAGE_LIMIT_INVALID",
      context: { limit },
    });
  }
  return limit;
}

function filterMemoriesByQuery(
  memories: Memory[],
  query: string,
  limit?: number,
): Memory[] {
  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? memories.filter((memory) => {
        const text =
          typeof memory.content.text === "string" ? memory.content.text : "";
        return text.toLowerCase().includes(normalized);
      })
    : memories;
  return limit === undefined ? matches : matches.slice(0, limit);
}

const TELEGRAM_MEMORY_PAGE_SIZE = 500;

async function loadAllTelegramRoomMemories(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<Memory[]> {
  const memories: Memory[] = [];
  const seenIds = new Set<UUID>();
  for (let offset = 0; ; offset += TELEGRAM_MEMORY_PAGE_SIZE) {
    const page = await runtime.getMemories({
      tableName: "messages",
      roomId,
      limit: TELEGRAM_MEMORY_PAGE_SIZE,
      offset,
      orderBy: "createdAt",
      orderDirection: "desc",
    });
    if (page.length === TELEGRAM_MEMORY_PAGE_SIZE) {
      const ids = page.map((memory) => memory.id);
      if (ids.some((id) => !id) || ids.every((id) => seenIds.has(id as UUID))) {
        throw new ElizaError("Telegram message pagination made no progress", {
          code: "TELEGRAM_MESSAGE_PAGINATION_STALLED",
          context: { offset, pageSize: TELEGRAM_MEMORY_PAGE_SIZE },
          severity: "fatal",
        });
      }
      for (const id of ids) seenIds.add(id as UUID);
    }
    memories.push(...page);
    if (page.length < TELEGRAM_MEMORY_PAGE_SIZE) return memories;
  }
}

type MiddlewareNext = () => Promise<void>;

type TelegramAccountRuntime = {
  accountId: string;
  account: ResolvedTelegramAccount;
  bot: Telegraf<Context>;
  messageManager: MessageManager;
  /**
   * One-shot wiring record for this account's Telegraf instance. `start()`
   * retries the whole init sequence on a transient failure, but neither
   * Telegraf registration nor `launch()` is idempotent: `bot.use()`/`bot.on()`/
   * `bot.command()` APPEND to the middleware chain, and `startPolling()`
   * overwrites `bot.polling` — so a second `launch()` on the same instance
   * strands the previous long-poll loop, which `bot.stop()` can then never
   * abort and which keeps calling `getUpdates` for the life of the process.
   * Each step is recorded once it succeeds so a retry re-runs only what
   * actually failed.
   */
  wiring: TelegramAccountWiring;
};

type TelegramAccountWiring = {
  /** `bot.start()` + slash-command/task-board handlers are registered. */
  commands: boolean;
  /** The supervised long-poll loop is running on this bot instance. */
  poller: boolean;
  /** Middleware chain and message/reaction/callback handlers are registered. */
  handlers: boolean;
  /** SIGINT/SIGTERM teardown hooks for this bot are installed. */
  shutdownHooks: boolean;
};

function getCanonicalOwnerId(runtime: IAgentRuntime): UUID | null {
  for (const key of CANONICAL_OWNER_SETTING_KEYS) {
    const value = runtime.getSetting(key);
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed as UUID;
    }
  }
  return null;
}

function getTelegramChatDisplayName(
  chat: Context["chat"] | undefined,
  fallback: string,
): string {
  if (!chat) {
    return fallback;
  }

  if ("title" in chat && typeof chat.title === "string" && chat.title.trim()) {
    return chat.title;
  }

  if (
    "first_name" in chat &&
    typeof chat.first_name === "string" &&
    chat.first_name.trim()
  ) {
    return chat.first_name;
  }

  if (
    "username" in chat &&
    typeof chat.username === "string" &&
    chat.username.trim()
  ) {
    return chat.username;
  }

  return fallback;
}

function normalizeTelegramConnectorQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function scoreTelegramConnectorMatch(
  query: string,
  id: string,
  labels: Array<string | null | undefined>,
): number {
  if (!query) {
    return 0.45;
  }
  if (id.toLowerCase() === query) {
    return 1;
  }

  let bestScore = 0;
  for (const label of labels) {
    const normalized = label?.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      bestScore = Math.max(bestScore, 0.95);
    } else if (normalized.startsWith(query)) {
      bestScore = Math.max(bestScore, 0.85);
    } else if (normalized.includes(query)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }
  return bestScore;
}

function parseTelegramTargetParts(
  channelId: string,
  explicitThreadId?: string,
): TelegramTargetParts {
  const explicitThreadNumber =
    explicitThreadId && /^\d+$/.test(explicitThreadId)
      ? Number.parseInt(explicitThreadId, 10)
      : undefined;
  const threadedMatch = channelId.match(TELEGRAM_THREADED_CHANNEL_PATTERN);
  if (threadedMatch) {
    return {
      chatId: threadedMatch[1],
      threadId: explicitThreadNumber ?? Number.parseInt(threadedMatch[2], 10),
    };
  }
  return { chatId: channelId, threadId: explicitThreadNumber };
}

function telegramChatKind(chat: Chat): MessageConnectorTarget["kind"] {
  if (chat.type === "private") {
    return "user";
  }
  if (chat.type === "channel") {
    return "channel";
  }
  return "group";
}

/** Validate forum-topic metadata before calling Telegram's bounded API. */
export function requireForumTopicName(name?: string): string {
  const wellFormed = toWellFormedUnicode(name ?? "thread");
  if (wellFormed.length > 128) {
    throw new ElizaError(
      "Telegram forum-topic name exceeds the Bot API limit",
      {
        code: "TELEGRAM_FORUM_TOPIC_NAME_TOO_LONG",
        context: { actualLength: wellFormed.length, maxLength: 128 },
      },
    );
  }
  return wellFormed;
}

/**
 * Class representing a Telegram service that allows the agent to send and receive messages on Telegram.
 * This service handles all Telegram-specific functionality including:
 * - Initializing and managing the Telegram bot
 * - Setting up middleware for preprocessing messages
 * - Handling message and reaction events
 * - Synchronizing Telegram chats, users, and entities with the agent runtime
 * - Managing forum topics as separate rooms
 *
 * @extends Service
 */
export function compareMessageConnectorTargets(
  a: MessageConnectorTarget,
  b: MessageConnectorTarget,
): number {
  const bScore =
    typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
  const aScore =
    typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
  return (
    bScore - aScore ||
    (a.label ?? a.target.channelId ?? a.target.source).localeCompare(
      b.label ?? b.target.channelId ?? b.target.source,
    )
  );
}

export class TelegramService extends Service {
  static serviceType = TELEGRAM_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on telegram";
  private bot: Telegraf<Context> | null = null;
  public messageManager: MessageManager | null = null;
  private knownChats: Map<string, Chat> = new Map();
  private syncedEntityIds: Set<string> = new Set<string>();
  private botToken: string | null;
  private defaultAccountId = DEFAULT_ACCOUNT_ID;
  private accountStates: Map<string, TelegramAccountRuntime> = new Map();
  private stopping = false;
  private pollerRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private pollerCompletions = new Map<Telegraf<Context>, Promise<void>>();

  /**
   * Constructor for TelegramService class.
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   */
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      this.bot = null;
      this.messageManager = null;
      this.botToken = null;
      return;
    }
    logger.debug(
      { src: "plugin:telegram", agentId: runtime.agentId },
      "Constructing TelegramService",
    );

    this.defaultAccountId = resolveDefaultTelegramAccountId(runtime);
    const account = resolveTelegramAccount(runtime, this.defaultAccountId);
    this.botToken = account.botToken ?? null;
    if (!account.botToken) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId: account.accountId,
        },
        "Bot token not provided, Telegram functionality unavailable",
      );
      this.bot = null;
      this.messageManager = null;
      return;
    }

    try {
      const state = this.createAccountRuntime(account);
      this.setDefaultAccountState(state);
      logger.debug(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId: account.accountId,
        },
        "TelegramService constructor completed",
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to initialize Telegram bot",
      );
      this.bot = null;
      this.messageManager = null;
    }
  }

  private createAccountRuntime(
    account: ResolvedTelegramAccount,
  ): TelegramAccountRuntime {
    if (!account.botToken) {
      throw new Error(`Telegram account ${account.accountId} has no bot token`);
    }
    const bot = new Telegraf(account.botToken, {
      telegram: { apiRoot: account.apiRoot },
    });
    const messageManager = new MessageManager(
      bot,
      this.runtime,
      account.accountId,
    );
    return {
      accountId: account.accountId,
      account,
      bot,
      messageManager,
      wiring: {
        commands: false,
        poller: false,
        handlers: false,
        shutdownHooks: false,
      },
    };
  }

  private setDefaultAccountState(state: TelegramAccountRuntime): void {
    this.accountStates.set(state.accountId, state);
    if (state.accountId === this.defaultAccountId || !this.bot) {
      this.bot = state.bot;
      this.messageManager = state.messageManager;
      this.botToken = state.account.botToken ?? null;
    }
  }

  private getDefaultAccountState(): TelegramAccountRuntime | null {
    if (!(this.accountStates instanceof Map) || this.accountStates.size === 0) {
      return null;
    }
    return (
      this.accountStates.get(this.defaultAccountId) ??
      this.accountStates.values().next().value ??
      null
    );
  }

  private getAccountState(
    accountId?: string | null,
  ): TelegramAccountRuntime | null {
    if (!(this.accountStates instanceof Map) || this.accountStates.size === 0) {
      return null;
    }
    if (accountId) {
      return (
        this.accountStates.get(normalizeTelegramAccountId(accountId)) ?? null
      );
    }
    return this.getDefaultAccountState();
  }

  private getAccountIds(): string[] {
    if (this.accountStates instanceof Map && this.accountStates.size > 0) {
      return Array.from(this.accountStates.keys());
    }
    return [normalizeTelegramAccountId(this.defaultAccountId)];
  }

  /**
   * Returns every live Telegraf bot instance, one per configured account.
   * Public accessor so other services (e.g. owner-pairing) can register
   * commands or send messages without reflecting into private fields.
   */
  public getBots(): Telegraf<Context>[] {
    if (this.accountStates instanceof Map && this.accountStates.size > 0) {
      return Array.from(this.accountStates.values(), (state) => state.bot);
    }
    return this.bot ? [this.bot] : [];
  }

  /**
   * Returns the default account's Telegraf bot instance, or null when the
   * service started without a usable bot token. Public accessor that replaces
   * private-field reflection for single-bot callers.
   */
  public getBot(): Telegraf<Context> | null {
    return this.getDefaultAccountState()?.bot ?? this.bot ?? null;
  }

  public getPollerHealth(): TelegramPollerHealth {
    const health = [
      ...this.getPollerHealthByAccount(),
      ...listTelegramPollerHealth("standalone").filter(
        (entry) => entry.ownerId === String(this.runtime.agentId),
      ),
    ];
    return (
      health.find((entry) => entry.accountId === this.defaultAccountId) ??
      health[0] ?? {
        ok: false,
        mode: "full",
        accountId: this.defaultAccountId,
        ownerId: String(this.runtime.agentId),
        connected: false,
        lastError: "Telegram poller is not launched",
      }
    );
  }

  public getPollerHealthByAccount(): TelegramPollerHealth[] {
    const accountIds = new Set(this.getAccountIds());
    return listTelegramPollerHealth("full").filter(
      (entry) =>
        entry.ownerId === String(this.runtime.agentId) &&
        accountIds.has(entry.accountId),
    );
  }

  private resolveAccountIdFromContext(
    context?: MessageConnectorQueryContext | null,
    target?: TargetInfo | null,
  ): string | undefined {
    const scopedTarget = target as AccountScopedTargetInfo | null | undefined;
    const scopedContext = context as
      | AccountScopedConnectorContext
      | null
      | undefined;
    return (
      scopedTarget?.accountId ??
      (scopedContext?.target as AccountScopedTargetInfo | undefined)
        ?.accountId ??
      scopedContext?.accountId ??
      scopedContext?.account?.accountId ??
      undefined
    );
  }

  private async resolveAccountIdForTarget(
    runtime: IAgentRuntime,
    target?: TargetInfo | null,
    fallback?: { accountId?: string; roomId?: UUID } | null,
  ): Promise<string> {
    const direct =
      (target as AccountScopedTargetInfo | null | undefined)?.accountId ??
      fallback?.accountId;
    if (direct) {
      const normalized = normalizeTelegramAccountId(direct);
      // Only enforce this in real multi-account mode. In legacy single-bot
      // mode accountStates is empty and getAccountState() always falls back
      // to the one configured bot regardless of accountId -- there is no
      // second account an unrecognized id could be confused with, so an
      // explicit id that isn't the exact defaultAccountId string is not an
      // error there (existing single-bot callers may pass any identifier).
      if (
        this.accountStates instanceof Map &&
        this.accountStates.size > 0 &&
        this.getAccountState(normalized) === null
      ) {
        throw new Error(
          `Telegram account ${normalized} is not configured or active`,
        );
      }
      return normalized;
    }
    const roomId = target?.roomId ?? fallback?.roomId;
    if (roomId && typeof runtime.getRoom === "function") {
      const room = await runtime.getRoom(roomId);
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      if (
        typeof metadata?.accountId === "string" &&
        metadata.accountId.trim()
      ) {
        return normalizeTelegramAccountId(metadata.accountId);
      }
      const telegram =
        metadata?.telegram && typeof metadata.telegram === "object"
          ? (metadata.telegram as Record<string, unknown>)
          : undefined;
      if (
        typeof telegram?.accountId === "string" &&
        telegram.accountId.trim()
      ) {
        return normalizeTelegramAccountId(telegram.accountId);
      }
    }
    return normalizeTelegramAccountId(this.defaultAccountId);
  }

  private scopedTelegramKey(key: string, accountId?: string | null): string {
    const normalized = normalizeTelegramAccountId(
      accountId ?? this.defaultAccountId,
    );
    return normalized === DEFAULT_ACCOUNT_ID ? key : `${normalized}:${key}`;
  }

  private knownChatKeyMatchesAccount(
    key: string,
    chat: Chat,
    accountId: string,
  ): boolean {
    return key === this.scopedTelegramKey(chat.id.toString(), accountId);
  }

  /**
   * Starts the Telegram service for the given runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to start the Telegram service for.
   * @returns {Promise<TelegramService>} A promise that resolves with the initialized TelegramService.
   */
  static async start(runtime: IAgentRuntime): Promise<TelegramService> {
    const service = new TelegramService(runtime);

    if (shouldStartTelegramStandaloneBot()) {
      logger.info(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Full Telegram poller is disabled because standalone mode is enabled",
      );
      return service;
    }

    for (const account of listEnabledTelegramAccounts(runtime)) {
      if (!service.getAccountState(account.accountId)) {
        service.setDefaultAccountState(service.createAccountRuntime(account));
      }
    }

    // If no account has an initialized bot, return the service without further initialization.
    if (!service.bot) {
      logger.warn(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Service started without bot functionality",
      );
      return service;
    }

    const maxRetries = 5;
    for (const state of service.accountStates.values()) {
      let retryCount = 0;
      let lastError: Error | null = null;

      while (retryCount < maxRetries) {
        try {
          logger.info(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              agentName: runtime.character.name,
              accountId: state.accountId,
            },
            "Starting Telegram bot",
          );
          await service.initializeBot(state);
          await state.bot.telegram.getMe();

          logger.success(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              agentName: runtime.character.name,
              accountId: state.accountId,
            },
            "Telegram bot started successfully",
          );
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const errorCode = (error as { response?: { error_code?: number } })
            .response?.error_code;
          // A revoked/malformed bot token (401/404) is permanent — don't burn
          // ~30s of exponential backoff retrying it; fail fast with a clear
          // operator message.
          if (errorCode === 401 || errorCode === 404) {
            logger.error(
              {
                src: "plugin:telegram",
                agentId: runtime.agentId,
                accountId: state.accountId,
                errorCode,
              },
              "Telegram bot token rejected — check TELEGRAM_BOT_TOKEN for this account",
            );
            break;
          }
          logger.error(
            {
              src: "plugin:telegram",
              agentId: runtime.agentId,
              accountId: state.accountId,
              attempt: retryCount + 1,
              error: lastError.message,
            },
            "Initialization attempt failed",
          );
          retryCount++;

          if (retryCount < maxRetries) {
            const delay = 2 ** retryCount * 1000;
            logger.info(
              {
                src: "plugin:telegram",
                agentId: runtime.agentId,
                accountId: state.accountId,
                delaySeconds: delay / 1000,
              },
              "Retrying initialization",
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (retryCount >= maxRetries) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: runtime.agentId,
            accountId: state.accountId,
            maxRetries,
            error: lastError?.message,
          },
          "Initialization failed after all attempts",
        );
      }
    }

    return service;
  }

  /**
   * Stops the agent runtime.
   * @param {IAgentRuntime} runtime - The agent runtime to stop
   */
  static async stop(runtime: IAgentRuntime) {
    const tgClient = await runtime.getService(TELEGRAM_SERVICE_NAME);
    if (tgClient) {
      await (tgClient as TelegramService).stop();
    }
  }

  /**
   * Asynchronously stops the bot.
   *
   * @returns A Promise that resolves once the bot has stopped.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.pollerRetryTimers) clearTimeout(timer);
    this.pollerRetryTimers.clear();
    const states =
      this.accountStates instanceof Map
        ? Array.from(this.accountStates.values())
        : [];
    const targets = states.length
      ? states.map((state) => ({
          bot: state.bot,
          token: state.account.botToken,
        }))
      : this.bot
        ? [{ bot: this.bot, token: this.botToken }]
        : [];
    const results = await Promise.allSettled(
      targets.map(async ({ bot, token }) => {
        const completion = this.pollerCompletions.get(bot);
        if (completion) {
          // A settled failure may still hold its claim for a queued retry.
          // Shutdown disables that retry and releases only after draining.
          await stopTelegramPolling(bot, completion);
          if (token) releaseTelegramPollerToken(token, bot);
          return;
        }
        try {
          bot.stop("service-stop");
        } catch (error) {
          // error-policy:J6 A constructed bot without a supervised launch has no polling loop to drain.
          logger.debug(
            { src: "plugin:telegram", error },
            "Telegram unstarted bot teardown failed",
          );
        }
        if (token) releaseTelegramPollerToken(token, bot);
      }),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new ElizaError(
        "Telegram shutdown did not drain every polling loop.",
        {
          code: "TELEGRAM_SHUTDOWN_INCOMPLETE",
          cause: new AggregateError(failures),
        },
      );
    }
  }

  /**
   * Initializes the Telegram bot by launching it, getting bot info, and setting up message manager.
   * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
   */
  private async initializeBot(state?: TelegramAccountRuntime): Promise<void> {
    const activeState = state ?? this.getDefaultAccountState();
    if (!activeState) {
      throw new ElizaError("Telegram account runtime state is missing", {
        code: "TELEGRAM_ACCOUNT_STATE_MISSING",
        severity: "fatal",
        context: {
          defaultAccountId: this.defaultAccountId,
          configuredAccountCount:
            this.accountStates instanceof Map ? this.accountStates.size : 0,
        },
      });
    }
    const { accountId, bot } = activeState;
    const botToken = activeState.account.botToken;

    if (botToken) {
      try {
        ensureTelegramPollerTokenAvailable(botToken, bot);
      } catch (error) {
        const active = getTelegramPollerClaim(botToken);
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            activeMode: active?.mode,
            activeOwnerId: active?.ownerId,
            activeAccountId: active?.accountId,
          },
          "Telegram bot token is already owned by another poller",
        );
        // error-policy:J2 Preserve the ownership failure while adding the
        // account and active-poller coordinates needed to resolve the conflict.
        throw new ElizaError("Telegram poller token ownership conflict", {
          code: "TELEGRAM_POLLER_TOKEN_CONFLICT",
          cause: error,
          context: {
            accountId,
            activeMode: active?.mode,
            activeOwnerId: active?.ownerId,
            activeAccountId: active?.accountId,
          },
        });
      }
    }

    await this.ensureWiredOnce(activeState);
  }

  /**
   * Completes every non-idempotent setup step exactly once for an account's
   * Telegraf instance. A step is recorded only after it succeeds, so startup
   * retries skip completed work while still retrying the first unfinished step.
   */
  private async ensureWiredOnce(state: TelegramAccountRuntime): Promise<void> {
    const { accountId, bot, wiring } = state;

    if (!wiring.commands) {
      this.registerBotCommands(bot, state, accountId);
      wiring.commands = true;
    }

    if (!wiring.handlers) {
      this.setupMiddlewares(state);
      this.setupMessageHandlers(state);
      wiring.handlers = true;
    }

    // Telegraf v4's `bot.launch()` resolves only when polling STOPS — it awaits
    // the long-poll loop internally — so it must not be awaited for completion.
    // launchPollerSupervised awaits until Telegraf assigns a stoppable polling
    // object, then supervises the loop (with bounded self-healing relaunch) in
    // the background.
    //
    // It is also one-shot: `startPolling()` assigns `bot.polling`, so launching
    // twice on the same instance leaves the first `Polling` unreachable —
    // `bot.stop()` only aborts the newest one, and the stranded loop keeps
    // long-polling `getUpdates` against the same token forever (a guaranteed
    // 409 "terminated by other getUpdates request" against whichever poller
    // Telegram picks, and a process that can no longer be shut down cleanly).
    // A launch failure before polling becomes stoppable leaves the flag false,
    // so the startup retry can still relaunch.
    if (!wiring.poller) {
      await this.launchPollerSupervised(bot, state.account.botToken, accountId);
      if (this.stopping) {
        throw new ElizaError("Telegram service is stopping.", {
          code: "TELEGRAM_SERVICE_STOPPING",
        });
      }
      wiring.poller = true;
    }

    if (!wiring.shutdownHooks) {
      this.installShutdownHooks(bot);
      wiring.shutdownHooks = true;
    }

    await this.finishBotStartup(bot, accountId);
  }

  /**
   * Registers the `/start` handler, the universal slash-command handlers, and
   * the task-board command on a freshly created Telegraf instance. Called
   * exactly once per bot (see {@link TelegramAccountRuntime.wiring}).
   */
  private registerBotCommands(
    bot: Telegraf<Context>,
    activeState: TelegramAccountRuntime,
    accountId: string,
  ): void {
    bot.start((ctx) => {
      const slashStartPayload = {
        ctx,
        runtime: this.runtime,
        source: "telegram",
        accountId,
        metadata: { accountId },
      };
      this.runtime.emitEvent(
        TelegramEventTypes.SLASH_START as string,
        slashStartPayload,
      );
    });

    // Register universal slash-command handlers BEFORE launch. Telegraf accepts
    // command registration any time before launch(), and a matched command
    // handler that never calls next() terminates the middleware chain — so the
    // catch-all message handler in setupMessageHandlers does not also process
    // command messages (no double-processing).
    const commandMessageManager = activeState.messageManager;
    const registered = registerTelegramCommandHandlers(
      bot,
      this.runtime,
      commandMessageManager,
      accountId,
    );
    logger.debug(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        accountId,
        commandCount: registered.length,
      },
      "Registered universal slash-command handlers",
    );
    // #8902: the live, edited-in-place orchestrator task board (`/tasks`).
    registerTelegramTaskBoardCommand(
      bot,
      this.runtime,
      commandMessageManager,
      accountId,
    );
  }

  /**
   * Runs the retryable post-launch probes: publish the slash-command menu and
   * retrieve bot identity before process shutdown hooks are installed.
   */
  private async finishBotStartup(
    bot: Telegraf<Context>,
    accountId: string,
  ): Promise<void> {
    // Publish the slash-command menu to Telegram so commands appear in the `/`
    // menu. setMyCommands failure is logged + swallowed (network) and must not
    // crash boot.
    await applyTelegramSetMyCommands(bot, this.runtime, accountId);

    // Get bot info for identification purposes
    const botInfo = await bot.telegram.getMe();
    logger.debug(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        accountId,
        botId: botInfo.id,
        botUsername: botInfo.username,
      },
      "Bot info retrieved",
    );
  }

  /** Installs the process-level teardown hooks for one Telegraf instance. */
  private installShutdownHooks(bot: Telegraf<Context>): void {
    // Stop the poller on process shutdown so the long-poll slot is released
    // before a replacement process starts — otherwise the new process's poller
    // 409s against the lingering one. bot.stop() throws if already stopped, so
    // teardown is best-effort.
    const stopBot = (reason: string): void => {
      try {
        bot.stop(reason);
      } catch {
        // error-policy:J6 best-effort teardown — bot already stopped.
      }
    };
    process.once("SIGINT", () => stopBot("SIGINT"));
    process.once("SIGTERM", () => stopBot("SIGTERM"));
  }

  /**
   * Launches the Telegraf long-poll loop and keeps it running for the lifetime
   * of the process.
   *
   * `bot.launch()` in Telegraf v4 only settles when polling stops (it awaits the
   * loop internally), while its `onLaunch` callback fires before `startPolling`
   * assigns `bot.polling`. The returned promise therefore yields through the
   * event loop until that polling object exists and exposes `stop()`, allowing
   * the caller to install process shutdown hooks without a non-stoppable gap.
   * A slow readiness wait emits a diagnostic but keeps the in-flight launch
   * and token claim fenced until the poller becomes stoppable or launch itself
   * settles. All readiness timers are cancelled on readiness or launch failure.
   * The poll loop remains supervised in the background afterwards, with
   * bounded exponential-backoff relaunches for post-connect failures.
   */
  private launchPollerSupervised(
    bot: Telegraf<Context>,
    botToken: string | null | undefined,
    accountId: string,
  ): Promise<void> {
    if (this.stopping) {
      return Promise.reject(
        new ElizaError("Telegram service is stopping.", {
          code: "TELEGRAM_SERVICE_STOPPING",
        }),
      );
    }
    const maxPollRelaunches = 5;
    const pollerReadyWarningMs = 30_000;
    const pollerReadyCheckMs = 10;
    // A loop that ran healthy for at least this long before failing is treated
    // as a fresh transient (relaunch budget reset); a faster failure counts
    // against the budget so a persistent conflict cannot relaunch forever.
    const stableRunMs = 60_000;

    const ownsToken = (): boolean => {
      if (this.stopping) return false;
      if (!botToken) {
        return true;
      }
      const active = getTelegramPollerClaim(botToken);
      return active === undefined || active.bot === bot;
    };
    const markActive = (): void => {
      if (botToken) {
        claimTelegramPollerToken(botToken, {
          bot,
          mode: "full",
          ownerId: String(this.runtime.agentId),
          accountId,
        });
      }
    };
    const clearActive = (): void => {
      if (!botToken) {
        return;
      }
      releaseTelegramPollerToken(botToken, bot);
    };

    let relaunches = 0;

    return new Promise<void>((resolve, reject) => {
      let pollerReadyOnce = false;
      let initialSettled = false;
      let pollerReadyTimer: ReturnType<typeof setTimeout> | undefined;
      let pollerReadyWarningTimer: ReturnType<typeof setTimeout> | undefined;

      const clearPollerReadyTimers = (): void => {
        if (pollerReadyTimer !== undefined) {
          clearTimeout(pollerReadyTimer);
          pollerReadyTimer = undefined;
        }
        if (pollerReadyWarningTimer !== undefined) {
          clearTimeout(pollerReadyWarningTimer);
          pollerReadyWarningTimer = undefined;
        }
      };

      const rejectInitialLaunch = (error: unknown): void => {
        if (initialSettled) return;
        initialSettled = true;
        clearPollerReadyTimers();
        reject(error);
      };

      const waitForStoppablePoller = (): void => {
        if (pollerReadyOnce || initialSettled) return;
        pollerReadyWarningTimer = setTimeout(() => {
          pollerReadyWarningTimer = undefined;
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId,
              pollerReadyWarningMs,
            },
            "Telegram launch is still waiting for a stoppable poller",
          );
        }, pollerReadyWarningMs);
        pollerReadyWarningTimer.unref?.();

        const check = (): void => {
          if (pollerReadyOnce || initialSettled) return;
          const polling = (bot as unknown as { polling?: { stop?: unknown } })
            .polling;
          if (typeof polling?.stop === "function") {
            if (this.stopping) {
              rejectInitialLaunch(
                new ElizaError("Telegram service is stopping.", {
                  code: "TELEGRAM_SERVICE_STOPPING",
                }),
              );
              return;
            }
            pollerReadyOnce = true;
            initialSettled = true;
            clearPollerReadyTimers();
            if (botToken) {
              markTelegramPollerConnected(botToken, bot);
            }
            resolve();
            return;
          }
          pollerReadyTimer = setTimeout(check, pollerReadyCheckMs);
          pollerReadyTimer.unref?.();
        };
        check();
      };

      const scheduleRelaunch = (): void => {
        if (!ownsToken()) {
          clearActive();
          return;
        }
        if (relaunches >= maxPollRelaunches) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId,
              maxPollRelaunches,
            },
            "Telegram poller gave up after repeated conflicts — verify only one instance holds this bot token",
          );
          if (botToken) {
            markTelegramPollerTerminated(
              botToken,
              bot,
              new Error("Telegram poller exhausted its relaunch budget"),
            );
          } else {
            clearActive();
          }
          return;
        }
        relaunches++;
        const delayMs = Math.min(2 ** relaunches * 1000, 30_000);
        logger.warn(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            attempt: relaunches,
            delaySeconds: delayMs / 1000,
          },
          "Relaunching Telegram poller after poll-loop failure",
        );
        const retryTimer = setTimeout(() => {
          this.pollerRetryTimers.delete(retryTimer);
          if (!ownsToken()) {
            clearActive();
            return;
          }
          runLaunch();
        }, delayMs);
        this.pollerRetryTimers.add(retryTimer);
      };

      const runLaunch = (): void => {
        let connectedAt = 0;
        try {
          markActive();
        } catch (error) {
          // error-policy:J4 A failed ownership claim either rejects initial
          // startup or becomes explicit unhealthy poller state after launch.
          if (!pollerReadyOnce) {
            rejectInitialLaunch(error);
          } else {
            if (botToken) {
              markTelegramPollerError(botToken, bot, error);
            }
          }
          return;
        }
        const completion = bot
          .launch(
            {
              dropPendingUpdates: false,
              allowedUpdates: ["message", "message_reaction", "callback_query"],
            },
            () => {
              connectedAt = Date.now();
              if (!pollerReadyOnce) {
                waitForStoppablePoller();
              } else if (botToken && !this.stopping) {
                markTelegramPollerConnected(botToken, bot);
              }
            },
          )
          .then(
            () => {
              // Clean stop (shutdown, or deliberate replacement by a newer
              // runtime): release ownership and do not relaunch.
              clearActive();
              if (!pollerReadyOnce) {
                rejectInitialLaunch(
                  new Error("Telegram poller stopped before it connected"),
                );
              }
            },
            (error: unknown) => {
              if (!pollerReadyOnce) {
                // Any failure before a stoppable polling object exists rejects
                // initial startup so its retry / token-rejection path owns it.
                clearActive();
                rejectInitialLaunch(error);
                return;
              }
              if (botToken) {
                markTelegramPollerError(botToken, bot, error);
              }
              // error-policy:J7 poll-loop failure after connecting (or on a
              // relaunch) — start() has already returned, so surface it
              // observably, then self-heal with bounded backoff.
              this.runtime.reportError("telegram:poll", error, {
                accountId,
                agentId: this.runtime.agentId,
              });
              if (connectedAt > 0 && Date.now() - connectedAt >= stableRunMs) {
                relaunches = 0;
              }
              scheduleRelaunch();
            },
          );
        this.pollerCompletions.set(bot, completion);
      };

      runLaunch();
    });
  }

  /**
   * Sets up the middleware chain for preprocessing messages before they reach handlers.
   * This critical method establishes a sequential processing pipeline that:
   *
   * 1. Authorization - Verifies if a chat is allowed to interact with the bot based on configured settings
   * 2. Chat Discovery - Ensures chat entities and worlds exist in the runtime, creating them if needed
   * 3. Forum Topics - Handles Telegram forum topics as separate rooms for better conversation management
   * 4. Entity Synchronization - Ensures message senders are properly synchronized as entities
   *
   * The middleware chain runs in sequence for each message, with each step potentially
   * enriching the context or stopping processing if conditions aren't met.
   * This preprocessing is essential for maintaining consistent state before message handlers execute.
   *
   * @private
   */
  private setupMiddlewares(state?: TelegramAccountRuntime): void {
    const bot = state?.bot ?? this.bot;
    const accountId = state?.accountId ?? this.defaultAccountId;
    // Register the authorization middleware
    bot?.use((ctx, next) => this.authorizationMiddleware(ctx, next, accountId));

    // Register the chat and entity management middleware
    bot?.use((ctx, next) => this.chatAndEntityMiddleware(ctx, next, accountId));
  }

  /**
   * Authorization middleware - checks if chat is allowed to interact with the
   * bot based on the TELEGRAM_ALLOWED_CHATS configuration and, for private
   * chats without an allowlist, the TELEGRAM_DM_POLICY gate. A denied sender
   * who was issued a pairing code receives it as a one-time reply.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {Function} next - The function to call to proceed to the next middleware
   * @returns {Promise<void>}
   * @private
   */
  private async authorizationMiddleware(
    ctx: Context,
    next: MiddlewareNext,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    const access = await this.checkChatAccess(ctx, accountId);
    if (!access.allowed) {
      // Skip further processing if chat is not authorized
      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId,
          chatId: ctx.chat?.id,
        },
        "Chat not authorized, skipping",
      );
      if (access.pairingReplyMessage) {
        try {
          await ctx.reply(access.pairingReplyMessage);
        } catch (error) {
          // error-policy:J1 The middleware is the transport boundary: a failed
          // pairing reply is logged with context and the update stays blocked;
          // the sender can retry on their next message.
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId,
              chatId: ctx.chat?.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to deliver pairing reply",
          );
        }
      }
      return;
    }
    await next();
  }

  /**
   * Chat and entity management middleware - handles new chats, forum topics, and entity synchronization.
   * This middleware implements decision logic to determine which operations are needed based on
   * the chat type and whether we've seen this chat before.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {Function} next - The function to call to proceed to the next middleware
   * @returns {Promise<void>}
   * @private
   */
  private async chatAndEntityMiddleware(
    ctx: Context,
    next: MiddlewareNext,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return next();
    }

    const chatId = ctx.chat.id.toString();

    // If we haven't seen this chat before, process it as a new chat
    if (!this.knownChats.has(this.scopedTelegramKey(chatId, accountId))) {
      // Process the new chat - creates world, room, topic room (if applicable) and entities
      await this.handleNewChat(ctx, accountId);
      // Skip entity synchronization for new chats and proceed to the next middleware
      return next();
    }

    // For existing chats, determine the required operations based on chat type
    await this.processExistingChat(ctx, accountId);

    await next();
  }

  /**
   * Process an existing chat based on chat type and message properties.
   * Different chat types require different processing steps.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async processExistingChat(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;

    // Handle forum topics for supergroups with forums
    if (
      chat.type === "supergroup" &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      try {
        await this.handleForumTopic(ctx, accountId);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            chatId: chat.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling forum topic",
        );
      }
    }

    // For non-private chats, synchronize entity information
    if (ctx.from && ctx.chat.type !== "private") {
      await this.syncEntity(ctx, accountId);
    }
  }

  /**
   * Sets up message and reaction handlers for the bot.
   * Configures event handlers to process incoming messages and reactions.
   *
   * @private
   */
  private setupMessageHandlers(state?: TelegramAccountRuntime): void {
    const bot = state?.bot ?? this.bot;
    const messageManager = state?.messageManager ?? this.messageManager;
    const accountId = state?.accountId ?? this.defaultAccountId;
    // Regular message handler
    bot?.on("message", async (ctx) => {
      try {
        const token = state?.account.botToken ?? this.botToken;
        if (token) {
          markTelegramPollerUpdate(token, bot);
        }
        // Preprocessing runs in the middleware chain; this only dispatches.
        await messageManager?.handleMessage(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling message",
        );
      }
    });

    // Reaction handler
    bot?.on("message_reaction", async (ctx) => {
      try {
        const token = state?.account.botToken ?? this.botToken;
        if (token) {
          markTelegramPollerUpdate(token, bot);
        }
        await messageManager?.handleReaction(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling reaction",
        );
      }
    });

    // Inline-keyboard button taps (choice / followup answers from the shared
    // interaction protocol). Foreign callbacks are acknowledged and ignored.
    bot?.on("callback_query", async (ctx) => {
      try {
        const token = state?.account.botToken ?? this.botToken;
        if (token) {
          markTelegramPollerUpdate(token, bot);
        }
        await messageManager?.handleCallbackQuery(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling callback query",
        );
      }
    });
  }

  /**
   * Checks if a chat is authorized to interact with the bot.
   *
   * A configured allowlist (per-account `allowedChats`, else the
   * TELEGRAM_ALLOWED_CHATS JSON array) is authoritative for every chat type.
   * With no allowlist configured, non-private chats stay open — a bot only
   * sees groups it was invited to — while private DMs fall to the
   * TELEGRAM_DM_POLICY gate, which fails closed to the core pairing handshake
   * by default so an unconfigured bot is never default-open to strangers.
   *
   * @param {Context} ctx - The context of the incoming update.
   * @returns {Promise<{allowed: boolean, pairingReplyMessage?: string}>} The
   *   access decision, plus the pairing-code reply to deliver when the DM
   *   policy issued one.
   */
  private async checkChatAccess(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<{ allowed: boolean; pairingReplyMessage?: string }> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) {
      return { allowed: false };
    }

    const accountAllowedChats =
      this.getAccountState(accountId)?.account.config.allowedChats;
    if (accountAllowedChats?.length) {
      return { allowed: accountAllowedChats.includes(chatId) };
    }

    const allowedChats = this.runtime.getSetting("TELEGRAM_ALLOWED_CHATS");
    if (allowedChats) {
      if (typeof allowedChats !== "string") {
        logger.warn(
          { src: "plugin:telegram", agentId: this.runtime.agentId, accountId },
          "TELEGRAM_ALLOWED_CHATS must be a JSON array of chat-id strings; blocking all chats until fixed",
        );
        return { allowed: false };
      }

      try {
        const parsed = JSON.parse(allowedChats);
        if (!Array.isArray(parsed)) {
          // A bare JSON string (e.g. "-1001234567") would make `.includes` a
          // substring match and silently over-authorize — fail closed instead.
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId,
            },
            "TELEGRAM_ALLOWED_CHATS must be a JSON array of chat-id strings; blocking all chats until fixed",
          );
          return { allowed: false };
        }
        return {
          allowed: parsed.map((entry) => String(entry)).includes(chatId),
        };
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error parsing TELEGRAM_ALLOWED_CHATS",
        );
        return { allowed: false };
      }
    }

    if (ctx.chat?.type !== "private") {
      return { allowed: true };
    }

    const senderId = ctx.from?.id?.toString();
    if (!senderId) {
      // A private chat without a stable sender id cannot complete the pairing
      // handshake — fail closed rather than skipping the DM policy.
      return { allowed: false };
    }
    const policy = resolveTelegramDmPolicy(
      this.runtime.getSetting("TELEGRAM_DM_POLICY"),
    );
    const access = await checkTelegramDmAccess(this.runtime, {
      policy,
      senderId,
      username: ctx.from?.username,
    });
    return {
      allowed: access.allowed,
      ...(access.replyMessage
        ? { pairingReplyMessage: access.replyMessage }
        : {}),
    };
  }

  /**
   * Synchronizes an entity from a message context with the runtime system.
   * This method handles three cases:
   * 1. Message sender - most common case
   * 2. New chat member - when a user joins the chat
   * 3. Left chat member - when a user leaves the chat
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async syncEntity(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(
        ctx.message?.message_thread_id
          ? `${ctx.chat.id}-${ctx.message.message_thread_id}`
          : ctx.chat.id.toString(),
        accountId,
      ),
    ) as UUID;

    // Handle all three entity sync cases separately for clarity
    await this.syncMessageSender(ctx, worldId, roomId, chatId, accountId);
    await this.syncNewChatMember(ctx, worldId, roomId, chatId, accountId);
    await this.syncLeftChatMember(ctx, accountId);
  }

  /**
   * Synchronizes the message sender entity with the runtime system.
   * This is the most common entity sync case.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world
   * @param {UUID} roomId - The ID of the room
   * @param {string} chatId - The ID of the chat
   * @returns {Promise<void>}
   * @private
   */
  private async syncMessageSender(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (ctx.from) {
      const telegramId = ctx.from.id.toString();
      const entityId = await resolveTelegramRuntimeEntityId(
        this.runtime,
        accountId,
        telegramId,
      );

      if (this.syncedEntityIds.has(entityId)) {
        return;
      }

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        roomName: getTelegramChatDisplayName(ctx.chat, chatId),
        userName: ctx.from.username,
        userId: telegramId as UUID,
        name: ctx.from.first_name || ctx.from.username || "Unknown User",
        source: "telegram",
        channelId: chatId,
        type: ChannelType.GROUP,
        worldId,
      });

      this.syncedEntityIds.add(entityId);
    }
  }

  /**
   * Synchronizes a new chat member entity with the runtime system.
   * Triggered when a user joins the chat.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world
   * @param {UUID} roomId - The ID of the room
   * @param {string} chatId - The ID of the chat
   * @returns {Promise<void>}
   * @private
   */
  private async syncNewChatMember(
    ctx: Context,
    worldId: UUID,
    roomId: UUID,
    chatId: string,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    // Handle new chat member
    if (ctx.message && "new_chat_members" in ctx.message) {
      for (const newMember of ctx.message.new_chat_members) {
        const telegramId = newMember.id.toString();
        const entityId = await resolveTelegramRuntimeEntityId(
          this.runtime,
          accountId,
          telegramId,
        );

        if (this.syncedEntityIds.has(entityId)) {
          continue;
        }

        await this.runtime.ensureConnection({
          entityId,
          roomId,
          roomName: getTelegramChatDisplayName(ctx.chat, chatId),
          userName: newMember.username,
          userId: telegramId as UUID,
          name: newMember.first_name || newMember.username || "Unknown User",
          source: "telegram",
          channelId: chatId,
          type: ChannelType.GROUP,
          worldId,
        });

        this.syncedEntityIds.add(entityId);

        const entityJoinedPayload = {
          runtime: this.runtime,
          entityId,
          worldId,
          source: "telegram",
          accountId,
          metadata: { accountId },
          telegramUser: {
            id: newMember.id,
            username: newMember.username,
            first_name: newMember.first_name,
          },
        } as TelegramEntityPayload & {
          accountId: string;
          metadata: { accountId: string };
        };
        this.runtime.emitEvent(
          TelegramEventTypes.ENTITY_JOINED,
          entityJoinedPayload,
        );
      }
    }
  }

  /**
   * Updates entity status when a user leaves the chat.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async syncLeftChatMember(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    // Handle left chat member
    if (ctx.message && "left_chat_member" in ctx.message) {
      const leftMember = ctx.message.left_chat_member;
      const telegramId = leftMember.id.toString();
      const entityId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(telegramId, accountId),
      ) as UUID;

      const existingEntity = await this.runtime.getEntityById(entityId);
      if (existingEntity) {
        existingEntity.metadata = {
          ...existingEntity.metadata,
          accountId,
          status: "INACTIVE",
          leftAt: Date.now(),
        };
        await this.runtime.updateEntity(existingEntity);
      }
    }
  }

  /**
   * Handles forum topics by creating appropriate rooms in the runtime system.
   * This enables proper conversation management for Telegram's forum feature.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async handleForumTopic(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;

    const room = await this.buildForumTopicRoom(ctx, worldId, accountId);
    if (!room) {
      return;
    }

    await this.runtime.ensureRoomExists(room);
  }

  /**
   * Builds entity for message sender
   */
  private buildMsgSenderEntity(
    from: User,
    accountId = this.defaultAccountId,
  ): Entity | null {
    if (!from) {
      return null;
    }

    const userId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(from.id.toString(), accountId),
    ) as UUID;
    const telegramId = from.id.toString();

    return {
      id: userId,
      agentId: this.runtime.agentId,
      names: [from.first_name || from.username || "Unknown User"],
      metadata: {
        source: "telegram",
        accountId,
        telegram: {
          accountId,
          id: telegramId,
          username: from.username,
          name: from.first_name || from.username || "Unknown User",
        },
      },
    };
  }

  /**
   * Handles new chat discovery and emits WORLD_JOINED event.
   * This is a critical function that ensures new chats are properly
   * registered in the runtime system and appropriate events are emitted.
   *
   * @param {Context} ctx - The context of the incoming update
   * @returns {Promise<void>}
   * @private
   */
  private async handleNewChat(
    ctx: Context,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();

    // Mark this chat as known
    this.knownChats.set(this.scopedTelegramKey(chatId, accountId), chat);

    // Get chat title and channel type
    const { chatTitle, channelType } = this.getChatTypeInfo(chat);

    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(chatId, accountId),
    ) as UUID;

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) {
      return;
    }

    // Fetch admin information for proper role assignment
    let admins: (ChatMemberOwner | ChatMemberAdministrator)[] = [];
    let owner: ChatMemberOwner | null = null;
    if (
      chat.type === "group" ||
      chat.type === "supergroup" ||
      chat.type === "channel"
    ) {
      try {
        const chatAdmins = await ctx.getChatAdministrators();
        admins = chatAdmins;
        const foundOwner = admins.find(
          (admin): admin is ChatMemberOwner => admin.status === "creator",
        );
        owner = foundOwner || null;
      } catch (error) {
        logger.warn(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Could not get chat administrators",
        );
      }
    }

    const canonicalOwnerId = getCanonicalOwnerId(this.runtime);
    // Ownership may fall back to the chat CREATOR (groups only, mirroring
    // Discord's guild-owner grant) but never to the arbitrary message sender —
    // see world-ownership.ts for why that default was a privilege escalation.
    const chatCreatorEntityId = owner
      ? (createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(String(owner.user.id), accountId),
        ) as UUID)
      : null;
    const worldOwnership = buildTelegramWorldOwnership(
      canonicalOwnerId,
      chatCreatorEntityId,
    );

    // Build world representation
    const world: World = {
      id: worldId,
      name: chatTitle,
      agentId: this.runtime.agentId,
      messageServerId: chatId,
      metadata: {
        source: "telegram",
        accountId,
        ...worldOwnership,
        chatType: chat.type,
        isForumEnabled: chat.type === "supergroup" && chat.is_forum,
      },
    };

    await this.runtime.ensureWorldExists(world);

    // Create the main room for the chat
    const generalRoom: Room = {
      id: createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(chatId, accountId),
      ) as UUID,
      name: chatTitle,
      source: "telegram",
      type: channelType,
      channelId: chatId,
      serverId: chatId,
      worldId,
      metadata: {
        source: "telegram",
        accountId,
        telegram: { accountId, chatId },
      },
    };

    await this.runtime.ensureRoomExists(generalRoom);

    // Prepare the rooms array starting with the main room
    const rooms = [generalRoom];

    // If this is a message in a forum topic, add the topic room as well
    if (
      chat.type === "supergroup" &&
      chat.is_forum &&
      ctx.message?.message_thread_id
    ) {
      const topicRoom = await this.buildForumTopicRoom(ctx, worldId, accountId);
      if (topicRoom) {
        rooms.push(topicRoom);
        await this.runtime.ensureRoomExists(topicRoom);
      }
    }

    // Build entities from chat
    const entities = await this.buildStandardizedEntities(chat, accountId);

    // Add sender if not already in entities
    if (ctx.from) {
      const senderEntity = this.buildMsgSenderEntity(ctx.from, accountId);
      if (senderEntity?.id && !entities.some((e) => e.id === senderEntity.id)) {
        entities.push(senderEntity);
        this.syncedEntityIds.add(senderEntity.id);
      }
    }

    // Use the new batch processing method for entities
    await this.batchProcessEntities(
      entities,
      generalRoom.id,
      generalRoom.name || generalRoom.channelId || chatId,
      generalRoom.channelId || chatId,
      generalRoom.type,
      worldId,
      accountId,
    );

    // Create payload for world events
    const telegramWorldPayload = {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
      accountId,
      metadata: { accountId },
      chat,
      botUsername: this.getAccountState(accountId)?.bot.botInfo?.username,
    } as TelegramWorldPayload & {
      accountId: string;
      metadata: { accountId: string };
    };

    // Emit telegram-specific world joined event
    if (chat.type !== "private") {
      await this.runtime.emitEvent(
        TelegramEventTypes.WORLD_JOINED,
        telegramWorldPayload,
      );
    }

    // Finally emit the standard WORLD_JOINED event
    await this.runtime.emitEvent(EventType.WORLD_JOINED, {
      runtime: this.runtime,
      world,
      rooms,
      entities,
      source: "telegram",
      accountId,
      metadata: { accountId },
    } as WorldPayload & {
      accountId: string;
      metadata: { accountId: string };
    });
  }

  /**
   * Processes entities in batches to prevent overwhelming the system.
   *
   * @param {Entity[]} entities - The entities to process
   * @param {UUID} roomId - The ID of the room to connect entities to
   * @param {string} channelId - The channel ID
   * @param {ChannelType} roomType - The type of the room
   * @param {UUID} worldId - The ID of the world
   * @returns {Promise<void>}
   * @private
   */
  private async batchProcessEntities(
    entities: Entity[],
    roomId: UUID,
    roomName: string,
    channelId: string,
    roomType: ChannelType,
    worldId: UUID,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    const batchSize = 50;

    for (let i = 0; i < entities.length; i += batchSize) {
      const entityBatch = entities.slice(i, i + batchSize);

      // Process each entity in the batch concurrently
      await Promise.all(
        entityBatch.map(async (entity: Entity) => {
          try {
            if (entity.id) {
              const telegramMetadata = entity.metadata?.telegram as
                | {
                    username?: string;
                    name?: string;
                    id?: string;
                    accountId?: string;
                  }
                | undefined;

              await this.runtime.ensureConnection({
                entityId: entity.id,
                roomId,
                roomName,
                userName: telegramMetadata?.username,
                name: telegramMetadata?.name,
                userId: telegramMetadata?.id as UUID,
                source: "telegram",
                channelId,
                type: roomType,
                worldId,
              });
            } else {
              logger.warn(
                {
                  src: "plugin:telegram",
                  agentId: this.runtime.agentId,
                  accountId,
                  entityNames: entity.names,
                },
                "Skipping entity sync due to missing ID",
              );
            }
          } catch (err) {
            const telegramMetadata = entity.metadata?.telegram as
              | {
                  username?: string;
                }
              | undefined;
            logger.warn(
              {
                src: "plugin:telegram",
                agentId: this.runtime.agentId,
                accountId,
                username: telegramMetadata?.username,
                error: err instanceof Error ? err.message : String(err),
              },
              "Failed to sync user",
            );
          }
        }),
      );

      // Add a small delay between batches if not the last batch
      if (i + batchSize < entities.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Gets chat title and channel type based on Telegram chat type.
   * Maps Telegram-specific chat types to standardized system types.
   *
   * @param {any} chat - The Telegram chat object
   * @returns {Object} Object containing chatTitle and channelType
   * @private
   */
  private getChatTypeInfo(chat: Chat): {
    chatTitle: string;
    channelType: ChannelType;
  } {
    const chatType = chat.type;
    let chatTitle: string;
    let channelType: ChannelType;

    switch (chatType) {
      case "private":
        chatTitle = `Chat with ${chat.first_name || "Unknown User"}`;
        channelType = ChannelType.DM;
        break;
      case "group":
        chatTitle = chat.title || "Unknown Group";
        channelType = ChannelType.GROUP;
        break;
      case "supergroup":
        chatTitle = chat.title || "Unknown Supergroup";
        channelType = ChannelType.GROUP;
        break;
      case "channel":
        chatTitle = chat.title || "Unknown Channel";
        channelType = ChannelType.FEED;
        break;
      default:
        throw new Error(`Unrecognized Telegram chat type: ${String(chatType)}`);
    }

    return { chatTitle, channelType };
  }

  /**
   * Builds standardized entity representations from Telegram chat data.
   * Transforms Telegram-specific user data into system-standard Entity objects.
   *
   * @param {any} chat - The Telegram chat object
   * @returns {Promise<Entity[]>} Array of standardized Entity objects
   * @private
   */
  private async buildStandardizedEntities(
    chat: Chat,
    accountId = this.defaultAccountId,
  ): Promise<Entity[]> {
    const entities: Entity[] = [];

    try {
      // For private chats, add the user
      if (chat.type === "private" && chat.id) {
        const userId = createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(chat.id.toString(), accountId),
        ) as UUID;
        entities.push({
          id: userId,
          names: [chat.first_name || "Unknown User"],
          agentId: this.runtime.agentId,
          metadata: {
            telegram: {
              accountId,
              id: chat.id.toString(),
              username: chat.username || "unknown",
              name: chat.first_name || "Unknown User",
            },
            source: "telegram",
            accountId,
          },
        });
        this.syncedEntityIds.add(userId);
      } else if (chat.type === "group" || chat.type === "supergroup") {
        // For groups and supergroups, try to get member information
        try {
          // Get chat administrators (this is what's available through the Bot API)
          const admins = await this.getAccountState(
            accountId,
          )?.bot.telegram.getChatAdministrators(chat.id);

          if (admins && admins.length > 0) {
            for (const admin of admins) {
              const userId = createUniqueUuid(
                this.runtime,
                this.scopedTelegramKey(admin.user.id.toString(), accountId),
              ) as UUID;
              entities.push({
                id: userId,
                names: [
                  admin.user.first_name ||
                    admin.user.username ||
                    "Unknown Admin",
                ],
                agentId: this.runtime.agentId,
                metadata: {
                  telegram: {
                    accountId,
                    id: admin.user.id.toString(),
                    username: admin.user.username || "unknown",
                    name: admin.user.first_name || "Unknown Admin",
                    isAdmin: true,
                    adminTitle:
                      admin.custom_title ||
                      (admin.status === "creator" ? "Owner" : "Admin"),
                  },
                  source: "telegram",
                  accountId,
                  roles: [admin.status === "creator" ? Role.OWNER : Role.ADMIN],
                },
              });
              this.syncedEntityIds.add(userId);
            }
          }
        } catch (error) {
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              chatId: chat.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Could not fetch administrators",
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error building standardized entities",
      );
    }

    return entities;
  }

  /**
   * Extracts and builds the room object for a forum topic from a message context.
   * Used both in middleware and when handling new chats.
   *
   * @param {Context} ctx - The context of the incoming update
   * @param {UUID} worldId - The ID of the world the topic belongs to
   * @returns {Promise<Room | null>} A Promise that resolves with the room or null if not a topic
   * @private
   */
  private async buildForumTopicRoom(
    ctx: Context,
    worldId: UUID,
    accountId = this.defaultAccountId,
  ): Promise<Room | null> {
    if (!ctx.chat || !ctx.message?.message_thread_id) {
      return null;
    }
    if (ctx.chat.type !== "supergroup" || !ctx.chat.is_forum) {
      return null;
    }

    const chat = ctx.chat;
    const chatId = chat.id.toString();
    const threadId = ctx.message.message_thread_id.toString();
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(`${chatId}-${threadId}`, accountId),
    ) as UUID;

    try {
      // Ensure the message object is fully initialized
      const replyMessage = JSON.parse(JSON.stringify(ctx.message));

      // Default topic name
      let topicName = `Topic #${threadId}`;

      // Check if forum_topic_created exists directly in the message
      if (
        replyMessage &&
        typeof replyMessage === "object" &&
        "forum_topic_created" in replyMessage &&
        replyMessage.forum_topic_created
      ) {
        const topicCreated = replyMessage.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === "object" &&
          "name" in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }
      // Check if forum_topic_created exists in reply_to_message
      else if (
        replyMessage &&
        typeof replyMessage === "object" &&
        "reply_to_message" in replyMessage &&
        replyMessage.reply_to_message &&
        typeof replyMessage.reply_to_message === "object" &&
        "forum_topic_created" in replyMessage.reply_to_message &&
        replyMessage.reply_to_message.forum_topic_created
      ) {
        const topicCreated = replyMessage.reply_to_message.forum_topic_created;
        if (
          topicCreated &&
          typeof topicCreated === "object" &&
          "name" in topicCreated
        ) {
          topicName = topicCreated.name;
        }
      }

      // Create a room for this topic
      const room: Room = {
        id: roomId,
        name: topicName,
        source: "telegram",
        type: ChannelType.GROUP,
        channelId: `${chatId}-${threadId}`,
        serverId: chatId,
        worldId,
        metadata: {
          source: "telegram",
          accountId,
          threadId,
          isForumTopic: true,
          parentChatId: chatId,
          telegram: {
            accountId,
            chatId,
            threadId,
          },
        },
      };

      return room;
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId,
          chatId,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error building forum topic room",
      );
      return null;
    }
  }

  private buildConnectorChatTarget(
    chat: Chat,
    score = 0.5,
    threadId?: number,
    accountId = this.defaultAccountId,
  ): MessageConnectorTarget {
    const chatId = chat.id.toString();
    const roomKey = threadId ? `${chatId}-${threadId}` : chatId;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(roomKey, accountId),
    ) as UUID;
    const label = getTelegramChatDisplayName(chat, chatId);

    return {
      target: {
        source: "telegram",
        accountId,
        roomId,
        channelId: roomKey,
        threadId: threadId?.toString(),
      } as TargetInfo,
      label,
      kind: threadId ? "thread" : telegramChatKind(chat),
      description:
        threadId && "title" in chat
          ? `Telegram topic ${threadId} in ${chat.title}`
          : `Telegram ${chat.type}`,
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        telegramChatId: chatId,
        telegramThreadId: threadId,
        telegramChatType: chat.type,
        username: "username" in chat ? chat.username : undefined,
        title: "title" in chat ? chat.title : undefined,
      },
    };
  }

  private buildConnectorRoomTarget(
    room: Room,
    score = 0.5,
  ): MessageConnectorTarget | null {
    if (room.source !== "telegram" || !room.channelId) {
      return null;
    }

    const metadata = room.metadata as Record<string, unknown> | undefined;
    const accountId =
      typeof metadata?.accountId === "string" && metadata.accountId.trim()
        ? normalizeTelegramAccountId(metadata.accountId)
        : normalizeTelegramAccountId(this.defaultAccountId);
    const threadId =
      typeof metadata?.threadId === "string"
        ? metadata.threadId
        : typeof room.channelId === "string"
          ? parseTelegramTargetParts(room.channelId).threadId?.toString()
          : undefined;
    return {
      target: {
        source: "telegram",
        accountId,
        roomId: room.id,
        channelId: room.channelId,
        threadId,
      } as TargetInfo,
      label: room.name || room.channelId,
      kind: threadId ? "thread" : "group",
      description: threadId
        ? `Telegram topic ${threadId}`
        : "Telegram chat room",
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        telegramChatId: room.channelId,
        telegramThreadId: threadId,
        roomName: room.name,
      },
    };
  }

  private dedupeConnectorTargets(
    targets: MessageConnectorTarget[],
  ): MessageConnectorTarget[] {
    const byKey = new Map<string, MessageConnectorTarget>();
    for (const target of targets) {
      const key = [
        (target.target as AccountScopedTargetInfo).accountId ?? "",
        target.kind ?? "target",
        target.target.channelId ?? "",
        target.target.entityId ?? "",
        target.target.threadId ?? "",
      ].join(":");
      const existing = byKey.get(key);
      if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
        byKey.set(key, target);
      }
    }
    return Array.from(byKey.values()).sort(compareMessageConnectorTargets);
  }

  private async getTelegramChatForTarget(
    chatId: number | string,
    accountId = this.defaultAccountId,
  ): Promise<Chat | null> {
    const known =
      this.knownChats.get(this.scopedTelegramKey(String(chatId), accountId)) ??
      (normalizeTelegramAccountId(accountId) === DEFAULT_ACCOUNT_ID
        ? this.knownChats.get(String(chatId))
        : undefined);
    if (known) {
      return known;
    }
    const bot = this.getAccountState(accountId)?.bot ?? this.bot;
    if (!bot) {
      return null;
    }
    try {
      const chat = await bot.telegram.getChat(chatId);
      this.knownChats.set(
        this.scopedTelegramKey(String(chat.id), accountId),
        chat,
      );
      return chat;
    } catch {
      return null;
    }
  }

  /**
   * Create a forum topic for the target chat and return a thread handle. Backs
   * the runtime's connector-agnostic `createThreadOnTarget` (parity with
   * Discord) so the orchestrator can give each task its own Telegram thread.
   * Requires a forum-enabled supergroup; throws otherwise.
   */
  public async createConnectorThread(
    runtime: IAgentRuntime,
    params: MessageConnectorCreateThreadParams,
  ): Promise<ThreadHandle> {
    const target = params.target as AccountScopedTargetInfo;
    const accountId = target.accountId ?? this.defaultAccountId;
    const bot = this.getAccountState(accountId)?.bot ?? this.bot;
    if (!bot) {
      throw new Error("Telegram bot is not available — cannot create thread");
    }
    // The orchestrator progress hook passes a {source, roomId} target; resolve
    // the chat id from the room when the target carries no channelId.
    let chatId = target.channelId ?? target.serverId;
    if (!chatId && target.roomId && typeof runtime.getRoom === "function") {
      const room = await runtime.getRoom(target.roomId);
      chatId = room?.channelId ?? undefined;
    }
    if (!chatId) {
      throw new Error("createConnectorThread requires a target chatId");
    }
    // A composite "<chatId>-<threadId>" room means we're already inside a topic;
    // create the new topic on the parent chat (the pattern preserves negative ids).
    const threadedMatch = chatId.match(TELEGRAM_THREADED_CHANNEL_PATTERN);
    const parentChatId = threadedMatch ? threadedMatch[1] : chatId;
    const name = requireForumTopicName(params.name ?? "thread");
    const topic = await bot.telegram.createForumTopic(parentChatId, name);
    return {
      threadId: String(topic.message_thread_id),
      parentChannelId: String(parentChatId),
    };
  }

  /** Post `params.content` into a forum topic created by createConnectorThread. */
  public async postToConnectorThread(
    _runtime: IAgentRuntime,
    params: MessageConnectorPostToThreadParams,
  ): Promise<Memory | undefined> {
    const target = params.target as AccountScopedTargetInfo;
    const accountId = target.accountId ?? this.defaultAccountId;
    const bot = this.getAccountState(accountId)?.bot ?? this.bot;
    if (!bot) {
      throw new Error("Telegram bot is not available — cannot post to thread");
    }
    const chatId =
      params.thread.parentChannelId ?? target.channelId ?? target.serverId;
    const text = params.content.text ?? "";
    if (!chatId || !text.trim()) {
      return undefined;
    }
    const threadId = Number(params.thread.threadId);
    await bot.telegram.sendMessage(chatId, text, {
      message_thread_id: Number.isFinite(threadId) ? threadId : undefined,
    });
    return undefined;
  }

  async resolveConnectorTargets(
    query: string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeTelegramConnectorQuery(query);
    const targets: MessageConnectorTarget[] = [];
    const explicitAccountId = this.resolveAccountIdFromContext(
      context,
      context.target,
    );
    const accountIds = explicitAccountId
      ? [normalizeTelegramAccountId(explicitAccountId)]
      : this.getAccountIds();

    for (const accountId of accountIds) {
      for (const [key, chat] of this.knownChats.entries()) {
        if (!this.knownChatKeyMatchesAccount(key, chat, accountId)) {
          continue;
        }
        const score = scoreTelegramConnectorMatch(
          normalizedQuery,
          chat.id.toString(),
          [
            "title" in chat ? chat.title : undefined,
            "username" in chat ? chat.username : undefined,
            "first_name" in chat ? chat.first_name : undefined,
            "last_name" in chat ? chat.last_name : undefined,
          ],
        );
        if (score <= 0) {
          continue;
        }
        targets.push(
          this.buildConnectorChatTarget(chat, score, undefined, accountId),
        );
      }
    }

    if (
      normalizedQuery &&
      (TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery) ||
        query.trim().startsWith("@"))
    ) {
      const lookup = TELEGRAM_CHAT_ID_PATTERN.test(normalizedQuery)
        ? normalizedQuery
        : query.trim();
      const accountId = accountIds[0] ?? this.defaultAccountId;
      const chat = await this.getTelegramChatForTarget(lookup, accountId);
      if (chat) {
        targets.push(
          this.buildConnectorChatTarget(chat, 1, undefined, accountId),
        );
      }
    }

    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    if (room) {
      const roomTarget = this.buildConnectorRoomTarget(room, 0.6);
      if (roomTarget) {
        targets.push(roomTarget);
      }
    }

    return this.dedupeConnectorTargets(targets);
  }

  async listConnectorRooms(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const explicitAccountId = this.resolveAccountIdFromContext(
      context,
      context.target,
    );
    const accountIds = explicitAccountId
      ? [normalizeTelegramAccountId(explicitAccountId)]
      : this.getAccountIds();
    const targets: MessageConnectorTarget[] = [];
    for (const accountId of accountIds) {
      for (const [key, chat] of this.knownChats.entries()) {
        if (!this.knownChatKeyMatchesAccount(key, chat, accountId)) {
          continue;
        }
        targets.push(
          this.buildConnectorChatTarget(chat, 0.5, undefined, accountId),
        );
      }
    }

    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    if (room) {
      const roomTarget = this.buildConnectorRoomTarget(room, 0.7);
      if (roomTarget) {
        targets.push(roomTarget);
      }
    }

    return this.dedupeConnectorTargets(targets);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    return this.listConnectorRooms(context);
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams = {},
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const target = params.target ?? context.target;
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      target,
      { accountId: (context as AccountScopedConnectorContext).accountId },
    );
    if (target?.roomId) {
      const memories = await loadAllTelegramRoomMemories(
        context.runtime,
        target.roomId,
      );
      const matches = memories.filter((memory) => {
        const metadata = memory.metadata as Record<string, unknown> | undefined;
        return !metadata?.accountId || metadata.accountId === accountId;
      });
      return limit === undefined ? matches : matches.slice(0, limit);
    }

    const targets = await this.listRecentConnectorTargets(context);
    const roomIds = Array.from(
      new Set(
        targets
          .map((candidate) => candidate.target.roomId)
          .filter((roomId): roomId is UUID => Boolean(roomId)),
      ),
    );
    const chunks = await Promise.all(
      roomIds.map((roomId) =>
        loadAllTelegramRoomMemories(context.runtime, roomId),
      ),
    );
    const matches = chunks
      .flat()
      .filter((memory) => {
        const metadata = memory.metadata as Record<string, unknown> | undefined;
        return !metadata?.accountId || metadata.accountId === accountId;
      })
      .sort((left, right) => {
        const rightCreated =
          typeof right.createdAt === "number" &&
          Number.isFinite(right.createdAt)
            ? right.createdAt
            : 0;
        const leftCreated =
          typeof left.createdAt === "number" && Number.isFinite(left.createdAt)
            ? left.createdAt
            : 0;
        return (
          rightCreated - leftCreated ||
          (left.id ?? "").localeCompare(right.id ?? "")
        );
      });
    return limit === undefined ? matches : matches.slice(0, limit);
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramConnectorReadParams & { query: string },
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const messages = await this.fetchConnectorMessages(context, {
      target: params.target ?? context.target,
      limit: undefined,
    });
    return filterMemoriesByQuery(messages, params.query, limit);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    const room =
      target.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(target.roomId)
        : null;
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      target,
      {
        accountId: (context as AccountScopedConnectorContext).accountId,
        roomId: target.roomId ?? context.roomId,
      },
    );
    const channelId = target.channelId ?? room?.channelId;
    if (!channelId) {
      return null;
    }

    const parts = parseTelegramTargetParts(channelId, target.threadId);
    const chat = await this.getTelegramChatForTarget(parts.chatId, accountId);
    const roomId =
      target.roomId ??
      room?.id ??
      (createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(
          parts.threadId
            ? `${parts.chatId}-${parts.threadId}`
            : String(parts.chatId),
          accountId,
        ),
      ) as UUID);
    const memories = await loadAllTelegramRoomMemories(context.runtime, roomId);
    const recentMessages = memories
      .slice()
      .reverse()
      .map((memory: Memory) => ({
        entityId: memory.entityId,
        name:
          typeof memory.content.name === "string"
            ? memory.content.name
            : undefined,
        text: memory.content.text ?? "",
        timestamp: memory.createdAt,
        metadata: {
          memoryId: memory.id,
          accountId,
          source: memory.content.source,
        },
      }))
      .filter((message) => message.text.trim().length > 0);

    return {
      target: {
        source: "telegram",
        accountId,
        roomId,
        channelId,
        threadId: parts.threadId?.toString(),
      } as TargetInfo,
      label:
        room?.name ||
        (chat
          ? getTelegramChatDisplayName(chat, String(parts.chatId))
          : channelId),
      summary: chat ? `Telegram ${chat.type}` : undefined,
      recentMessages,
      metadata: {
        accountId,
        telegramChatId: String(parts.chatId),
        telegramThreadId: parts.threadId,
        telegramChatType: chat?.type,
      },
    };
  }

  async getConnectorUserContext(
    entityId: UUID | string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const accountId = normalizeTelegramAccountId(
      (context.target as AccountScopedTargetInfo | undefined)?.accountId ??
        (context as AccountScopedConnectorContext).accountId ??
        (context as AccountScopedConnectorContext).account?.accountId ??
        this.defaultAccountId,
    );
    const entity =
      typeof context.runtime.getEntityById === "function"
        ? await context.runtime.getEntityById(String(entityId) as UUID)
        : null;
    const telegramMetadata =
      entity?.metadata?.telegram && typeof entity.metadata.telegram === "object"
        ? (entity.metadata.telegram as Record<string, unknown>)
        : null;
    const telegramId =
      typeof telegramMetadata?.id === "number" ||
      typeof telegramMetadata?.id === "string"
        ? telegramMetadata.id
        : TELEGRAM_CHAT_ID_PATTERN.test(String(entityId))
          ? entityId
          : null;
    if (!telegramId) {
      return null;
    }

    const chat = await this.getTelegramChatForTarget(telegramId, accountId);
    const aliases = [
      entity?.names?.[0],
      chat && "username" in chat ? chat.username : undefined,
      chat && "first_name" in chat ? chat.first_name : undefined,
      chat && "last_name" in chat ? chat.last_name : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      entityId,
      label: aliases[0] ?? String(telegramId),
      aliases,
      handles: { telegram: String(telegramId) },
      metadata: {
        accountId,
        telegramId: String(telegramId),
        telegramChatType: chat?.type,
        username: chat && "username" in chat ? chat.username : undefined,
      },
    };
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: TelegramService,
  ) {
    if (serviceInstance.bot) {
      const registerConnector = (accountId?: string) => {
        const normalizedAccountId = accountId
          ? normalizeTelegramAccountId(accountId)
          : undefined;
        const state = normalizedAccountId
          ? serviceInstance.getAccountState(normalizedAccountId)
          : serviceInstance.getDefaultAccountState();
        const sendHandler = async (
          handlerRuntime: IAgentRuntime,
          target: TargetInfo,
          content: Content,
        ): Promise<Memory | undefined> => {
          await serviceInstance.handleSendMessage(
            handlerRuntime,
            normalizedAccountId &&
              !(target as AccountScopedTargetInfo).accountId
              ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
              : target,
            content,
          );
          return undefined;
        };
        const withContextAccount = (
          context: MessageConnectorQueryContext,
        ): MessageConnectorQueryContext =>
          normalizedAccountId &&
          !(context as AccountScopedConnectorContext).accountId
            ? ({
                ...context,
                accountId: normalizedAccountId,
                account: (context as AccountScopedConnectorContext).account ?? {
                  source: "telegram",
                  accountId: normalizedAccountId,
                  label: state?.account.name ?? normalizedAccountId,
                },
              } as MessageConnectorQueryContext)
            : context;

        const registration = {
          source: "telegram",
          ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
          ...(normalizedAccountId
            ? {
                account: {
                  source: "telegram",
                  accountId: normalizedAccountId,
                  label: state?.account.name ?? normalizedAccountId,
                  authMethod: "BOT_TOKEN",
                },
              }
            : {}),
          label: state?.account.name
            ? `Telegram (${state.account.name})`
            : "Telegram",
          description:
            "Telegram connector for sending messages to chats, topics, and users.",
          capabilities: [...TELEGRAM_CONNECTOR_CAPABILITIES],
          supportedTargetKinds: ["channel", "group", "thread", "user"],
          contexts: [...TELEGRAM_CONNECTOR_CONTEXTS],
          metadata: {
            service: TELEGRAM_SERVICE_NAME,
            ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
          },
          createThreadHandler: (runtime, params) =>
            serviceInstance.createConnectorThread(runtime, params),
          postToThreadHandler: (runtime, params) =>
            serviceInstance.postToConnectorThread(runtime, params),
          editHandler: (runtime, params) =>
            serviceInstance.editConnectorMessage(runtime, {
              ...params,
              target:
                normalizedAccountId &&
                !(params.target as AccountScopedTargetInfo).accountId
                  ? ({
                      ...params.target,
                      accountId: normalizedAccountId,
                    } as TargetInfo)
                  : params.target,
            }),
          reactHandler: (runtime, params) =>
            serviceInstance.reactConnectorMessage(runtime, {
              ...params,
              target:
                normalizedAccountId &&
                !(params.target as AccountScopedTargetInfo).accountId
                  ? ({
                      ...params.target,
                      accountId: normalizedAccountId,
                    } as TargetInfo)
                  : params.target,
            }),
          resolveTargets: (query, context) =>
            serviceInstance.resolveConnectorTargets(
              query,
              withContextAccount(context),
            ),
          listRecentTargets: (context) =>
            serviceInstance.listRecentConnectorTargets(
              withContextAccount(context),
            ),
          listRooms: (context) =>
            serviceInstance.listConnectorRooms(withContextAccount(context)),
          fetchMessages: (context, params) => {
            const readParams = params ?? {};
            return serviceInstance.fetchConnectorMessages(
              withContextAccount(context),
              {
                ...readParams,
                target:
                  normalizedAccountId &&
                  readParams.target &&
                  !(readParams.target as AccountScopedTargetInfo).accountId
                    ? ({
                        ...readParams.target,
                        accountId: normalizedAccountId,
                      } as TargetInfo)
                    : readParams.target,
              },
            );
          },
          searchMessages: (context, params) =>
            serviceInstance.searchConnectorMessages(
              withContextAccount(context),
              {
                ...params,
                target:
                  normalizedAccountId &&
                  params.target &&
                  !(params.target as AccountScopedTargetInfo).accountId
                    ? ({
                        ...params.target,
                        accountId: normalizedAccountId,
                      } as TargetInfo)
                    : params.target,
              },
            ),
          getChatContext: (target, context) =>
            serviceInstance.getConnectorChatContext(
              normalizedAccountId &&
                !(target as AccountScopedTargetInfo).accountId
                ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
                : target,
              withContextAccount(context),
            ),
          getUserContext: (entityId, context) =>
            serviceInstance.getConnectorUserContext(
              entityId,
              withContextAccount(context),
            ),
          getUser: async (handlerRuntime, params) => {
            const userParams = params as {
              entityId?: UUID | string;
              userId?: UUID | string;
              username?: string;
              handle?: string;
            };
            const entityId = String(
              userParams.entityId ??
                userParams.userId ??
                userParams.username ??
                userParams.handle ??
                "",
            ).trim();
            if (!entityId) {
              return null;
            }
            const entity =
              typeof handlerRuntime.getEntityById === "function"
                ? await handlerRuntime
                    .getEntityById(entityId as UUID)
                    .catch(() => null)
                : null;
            if (entity) {
              return entity;
            }
            const context = await serviceInstance.getConnectorUserContext(
              entityId,
              {
                runtime: handlerRuntime,
                accountId: normalizedAccountId,
              } as MessageConnectorQueryContext,
            );
            if (!context) {
              return null;
            }
            return {
              id: createUniqueUuid(
                handlerRuntime,
                serviceInstance.scopedTelegramKey(
                  `telegram:${context.handles?.telegram ?? entityId}`,
                  normalizedAccountId,
                ),
              ) as UUID,
              names: context.aliases?.length
                ? context.aliases
                : [context.label ?? entityId],
              agentId: handlerRuntime.agentId,
              metadata: {
                ...context.metadata,
                ...(normalizedAccountId
                  ? { accountId: normalizedAccountId }
                  : {}),
              },
            } satisfies Entity;
          },
          sendHandler,
        } as ExtendedMessageConnectorRegistration;
        runtime.registerMessageConnector(registration);
      };

      if (typeof runtime.registerMessageConnector === "function") {
        registerConnector();
        for (const accountId of serviceInstance.getAccountIds()) {
          registerConnector(accountId);
        }
      } else {
        runtime.registerSendHandler(
          "telegram",
          serviceInstance.handleSendMessage.bind(serviceInstance),
        );
      }
      logger.info(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Registered Telegram message connector",
      );
    } else {
      logger.warn(
        { src: "plugin:telegram", agentId: runtime.agentId },
        "Cannot register send handler, bot not initialized",
      );
    }
  }

  /**
   * Resolves a {@link TargetInfo} to the concrete Telegram bot, message
   * manager, chat id and (optional) forum thread id. Shared by the send, edit
   * and react connector handlers so the channelId / roomId / entityId
   * resolution lives in exactly one place.
   */
  private async resolveTelegramSendTarget(
    runtime: IAgentRuntime,
    target: TargetInfo,
  ): Promise<{
    accountId: string;
    bot: Telegraf<Context>;
    messageManager: MessageManager;
    chatId: number | string;
    threadId: number | undefined;
  }> {
    const accountId = await this.resolveAccountIdForTarget(runtime, target);
    const accountState = this.getAccountState(accountId);
    const messageManager = accountState?.messageManager ?? this.messageManager;
    const bot = accountState?.bot ?? this.bot;
    // Check if bot and messageManager are available
    if (!bot || !messageManager) {
      logger.error(
        { src: "plugin:telegram", agentId: runtime.agentId, accountId },
        "Bot not initialized, cannot send messages",
      );
      throw new Error(
        "Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.",
      );
    }

    let chatId: number | string | undefined;
    let threadId: number | undefined;

    // Determine the target chat ID
    if (target.channelId) {
      // Use channelId directly if provided (might be string like chat_id-thread_id or just chat_id)
      // We might need to parse this depending on how room IDs are stored vs Telegram IDs
      const parts = parseTelegramTargetParts(target.channelId, target.threadId);
      chatId = parts.chatId;
      threadId = parts.threadId;
    } else if (target.roomId) {
      // Fallback: use room metadata to resolve Telegram chat/thread IDs when
      // channelId is unavailable.
      const room = await runtime.getRoom(target.roomId);
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      const metadataThreadId =
        typeof metadata?.threadId === "string" ? metadata.threadId : undefined;
      if (room?.channelId) {
        const parts = parseTelegramTargetParts(
          room.channelId,
          metadataThreadId,
        );
        chatId = parts.chatId;
        threadId = parts.threadId;
      }
      if (!chatId) {
        throw new Error(
          `Could not resolve Telegram chat ID from roomId ${target.roomId}`,
        );
      }
    } else if (target.entityId) {
      const entity = await runtime.getEntityById(target.entityId);
      if (!entity) {
        throw new Error(`Entity ${target.entityId} not found`);
      }
      const telegramMeta = entity.metadata?.telegram as
        | Record<string, unknown>
        | undefined;
      const entityAccountId =
        typeof entity.metadata?.accountId === "string"
          ? entity.metadata.accountId
          : typeof telegramMeta?.accountId === "string"
            ? telegramMeta.accountId
            : undefined;
      if (
        entityAccountId &&
        normalizeTelegramAccountId(entityAccountId) !== accountId
      ) {
        throw new Error(
          `Entity ${target.entityId} is linked to Telegram account ${entityAccountId}, not ${accountId}`,
        );
      }
      const telegramId = telegramMeta?.id;
      if (!telegramId) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: runtime.agentId,
            accountId,
            entityId: target.entityId,
          },
          "Entity has no telegram.id in metadata — cannot send DM without Telegram user ID",
        );
        throw new Error(
          `Entity ${target.entityId} has no telegram.id in metadata — ` +
            "cannot send DM without Telegram user ID",
        );
      }
      chatId = telegramId as number | string;
      if (target.threadId && /^\d+$/.test(target.threadId)) {
        threadId = Number.parseInt(target.threadId, 10);
      }
    } else {
      throw new Error(
        "Telegram SendHandler requires channelId, roomId, or entityId.",
      );
    }

    if (!chatId) {
      throw new Error(
        `Could not determine target Telegram chat ID for target: ${JSON.stringify(target)}`,
      );
    }

    return { accountId, bot, messageManager, chatId, threadId };
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): SendHandlerResult {
    const { accountId, messageManager, chatId, threadId } =
      await this.resolveTelegramSendTarget(runtime, target);

    return messageManager.sendMessageWithReceipt(
      chatId,
      {
        ...content,
        metadata: {
          ...((content.metadata && typeof content.metadata === "object"
            ? content.metadata
            : {}) as Record<string, unknown>),
          accountId,
        },
      },
      undefined,
      threadId,
    );
  }

  /**
   * Edits a previously-sent Telegram message in place (capability
   * `edit_message`). Lets the orchestrator's compact progress mode rewrite a
   * single line across heartbeats instead of flooding the chat with new
   * messages. Markdown is converted to MarkdownV2 with the same plain-text
   * fallback the send path uses.
   */
  async editConnectorMessage(
    runtime: IAgentRuntime,
    params: MessageConnectorEditParams,
  ): Promise<Memory | undefined> {
    if (!params.messageId || !/^\d+$/.test(params.messageId)) {
      throw new Error(
        `Telegram edit requires a numeric messageId (got "${params.messageId}").`,
      );
    }
    const text = params.content?.text;
    if (!text?.trim()) {
      throw new Error("Telegram edit requires non-empty content.text.");
    }
    const { messageManager, chatId, threadId } =
      await this.resolveTelegramSendTarget(runtime, params.target);
    await messageManager.editMessage(
      chatId,
      Number.parseInt(params.messageId, 10),
      text,
      threadId,
    );
    // Telegram's editMessageText returns the edited Message; the orchestrator
    // only needs the call to succeed for compact-edit mode, so no Memory is
    // synthesized here (the original send already produced one).
    return undefined;
  }

  /**
   * Sets (or clears) an emoji reaction on a Telegram message (capability
   * `react_message`). Passing `remove: true` clears the bot's reactions.
   */
  async reactConnectorMessage(
    runtime: IAgentRuntime,
    params: MessageConnectorReactionParams & { remove?: boolean },
  ): Promise<void> {
    if (!params.messageId || !/^\d+$/.test(params.messageId)) {
      throw new Error(
        `Telegram reaction requires a numeric messageId (got "${params.messageId}").`,
      );
    }
    const { messageManager, chatId } = await this.resolveTelegramSendTarget(
      runtime,
      params.target,
    );
    await messageManager.addReaction(
      chatId,
      Number.parseInt(params.messageId, 10),
      params.remove ? undefined : params.emoji,
    );
  }
}
