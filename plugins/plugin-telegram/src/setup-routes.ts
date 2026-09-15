/**
 * Telegram bot setup HTTP routes.
 *
 * Implements the shared connector setup contract
 * (`eliza/packages/app-core/src/api/setup-contract.ts`):
 *
 *   GET  /api/setup/telegram/status   read current pairing state
 *   POST /api/setup/telegram/start    validate + save bot token
 *   POST /api/setup/telegram/cancel   remove saved token
 *
 * Token validation hits the Telegram Bot API getMe endpoint directly.
 * On success the token is persisted to the connector config so the
 * plugin auto-enables on next restart.
 *
 * These routes are registered with `rawPath: true` so they mount at the
 * canonical `/api/setup/telegram/...` paths without the plugin-name prefix.
 */

import {
  type IAgentRuntime,
  logger,
  type Route,
  type RouteRequest,
  type RouteResponse,
  type SetupState,
} from "@elizaos/core";

import { DEFAULT_ACCOUNT_ID } from "./accounts";
import { resolveTelegramBotCredential } from "./bot-credential";
import { getTelegramPollerClaim } from "./poller-lock";

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

// `SetupState` is the canonical connector lifecycle union from @elizaos/core.
// The response below specializes the generic `SetupStatusResponse<TDetail>`
// with Telegram's connector literal + detail shape, so it stays local.
interface SetupStatusResponse {
  connector: "telegram";
  state: SetupState;
  detail?: {
    bot?: {
      id: number;
      username: string;
      firstName: string;
    };
    hasToken?: boolean;
    serviceConnected?: boolean;
    message?: string;
  };
}

function sendSetupError(
  res: RouteResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function sendStatus(res: RouteResponse, body: SetupStatusResponse): void {
  res.status(200).json(body);
}

/**
 * Minimal interface for the connector-setup service exposed by the agent.
 * Plugins access it via `runtime.getService("connector-setup")`.
 */
interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  persistConfig(config: Record<string, unknown>): void;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  persistConnectorCredential?: (input: {
    provider: string;
    accountId: string;
    credentialType: string;
    value: string;
    caller?: string;
  }) => Promise<string | null>;
  removeConnectorCredentialReference?: (reference: string) => Promise<boolean>;
  registerEscalationChannel(channelName: string): boolean;
  setOwnerContact(update: {
    source: string;
    channelId?: string;
    entityId?: string;
    roomId?: string;
  }): boolean;
}

function isConnectorSetupService(
  service: unknown,
): service is ConnectorSetupService {
  if (!service || typeof service !== "object") {
    return false;
  }
  const candidate = service as Partial<ConnectorSetupService>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.updateConfig === "function" &&
    typeof candidate.persistConfig === "function" &&
    typeof candidate.registerEscalationChannel === "function" &&
    typeof candidate.setOwnerContact === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

async function readJsonBody<T>(req: RouteRequest): Promise<T | null> {
  return (req.body as T) ?? null;
}

function readSavedToken(
  setupService: ConnectorSetupService | null,
  runtime: IAgentRuntime,
): string | null {
  if (setupService) {
    const config = setupService.getConfig();
    // A never-configured deployment has no `connectors.telegram` block at all
    // (`handleStart` creates it only when a token is saved), so this lookup is
    // optional in exactly the same way `config.connectors` already is.
    const connectors = (config.connectors ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const tgConfig = connectors.telegram;
    const persisted = tgConfig?.botToken;
    if (typeof persisted === "string" && persisted.length > 0) {
      return persisted;
    }
  }
  const fromSetting = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  return typeof fromSetting === "string" && fromSetting.length > 0
    ? fromSetting
    : null;
}

function isConfiguredPollerConnected(
  runtime: IAgentRuntime,
  token: string | null,
): boolean {
  const poller = token ? getTelegramPollerClaim(token) : undefined;
  return Boolean(
    poller?.ok &&
      poller.connected &&
      poller.ownerId === String(runtime.agentId) &&
      poller.accountId === DEFAULT_ACCOUNT_ID,
  );
}

async function currentStatus(
  setupService: ConnectorSetupService | null,
  runtime: IAgentRuntime,
): Promise<SetupStatusResponse> {
  const savedToken = readSavedToken(setupService, runtime);
  const token = await resolveTelegramBotCredential(
    runtime,
    savedToken,
    "telegram-setup-status",
  );
  const hasToken = Boolean(token);
  const serviceConnected = isConfiguredPollerConnected(runtime, token);
  const state: SetupState = hasToken
    ? serviceConnected
      ? "paired"
      : "configuring"
    : "idle";
  return {
    connector: "telegram",
    state,
    detail: {
      hasToken,
      serviceConnected,
    },
  };
}

// ── GET /api/setup/telegram/status ──────────────────────────────────
async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);
  try {
    sendStatus(res, await currentStatus(setupService, runtime));
  } catch {
    // error-policy:J1 Credential-read failures are explicit and never expose secret-store errors.
    sendSetupError(
      res,
      503,
      "credential_unavailable",
      "Telegram readiness could not be checked. Restore access to the configured credential and retry.",
    );
  }
}

// ── POST /api/setup/telegram/start ──────────────────────────────────
async function handleStart(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{ token?: string }>(req);
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!token) {
    sendSetupError(res, 400, "bad_request", "token is required");
    return;
  }

  // Basic format check: <bot_id>:<alphanumeric>
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    sendSetupError(
      res,
      400,
      "bad_request",
      "Token format invalid. Expected format: 123456:ABC-DEF...",
    );
    return;
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      `Failed to reach Telegram API: ${message}`,
    );
    return;
  }

  if (!apiRes.ok) {
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      `Telegram API returned ${apiRes.status}. Check that the token is correct.`,
    );
    return;
  }

  const data = (await apiRes.json()) as {
    ok: boolean;
    result?: TelegramBotInfo;
  };
  if (!data.ok || !data.result) {
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      "Telegram API returned unexpected response",
    );
    return;
  }

  const bot = data.result;
  const setupService = getSetupService(runtime);

  if (setupService) {
    const storedToken = setupService.persistConnectorCredential
      ? ((await setupService.persistConnectorCredential({
          provider: "telegram",
          accountId: String(bot.id),
          credentialType: "bot-token",
          value: token,
          caller: "telegram-setup",
        })) ?? token)
      : token;
    setupService.updateConfig((config) => {
      if (!config.connectors) {
        config.connectors = {};
      }
      const connectors = config.connectors as Record<
        string,
        Record<string, unknown>
      >;
      if (!connectors.telegram || typeof connectors.telegram !== "object") {
        connectors.telegram = {};
      }
      connectors.telegram.botToken = storedToken;
    });

    // getMe identifies the bot, not the human owner or an authorized chat.
    // Owner pairing establishes reminder destinations independently of token setup.
    // Add Telegram to the escalation channel list
    setupService.registerEscalationChannel("telegram");
  } else {
    logger.warn(
      "[telegram-setup] connector-setup service not available — token saved to runtime only",
    );
  }

  sendStatus(res, {
    connector: "telegram",
    state: "configuring",
    detail: {
      bot: {
        id: bot.id,
        username: bot.username,
        firstName: bot.first_name,
      },
      hasToken: true,
      serviceConnected: isConfiguredPollerConnected(runtime, token),
    },
  });
}

// ── POST /api/setup/telegram/cancel ─────────────────────────────────
async function handleCancel(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);

  if (setupService) {
    let storedToken: string | null = null;
    setupService.updateConfig((config) => {
      const connectors = (config.connectors ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const tgConfig = connectors.telegram;
      if (tgConfig) {
        storedToken =
          typeof tgConfig.botToken === "string" ? tgConfig.botToken : null;
        delete tgConfig.botToken;
      }
    });
    if (storedToken && setupService.removeConnectorCredentialReference) {
      await setupService.removeConnectorCredentialReference(storedToken);
    }
  }

  await handleStatus(_req, res, runtime);
}

/**
 * Plugin routes for Telegram bot setup.
 * Registered with `rawPath: true` to expose the canonical `/api/setup/telegram/*`
 * surface without the plugin-name prefix.
 */
export const telegramSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/setup/telegram/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/start",
    handler: handleStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/cancel",
    handler: handleCancel,
    rawPath: true,
  },
];
