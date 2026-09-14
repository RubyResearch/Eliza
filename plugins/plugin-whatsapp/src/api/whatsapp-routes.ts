/**
 * QR-pairing route helpers backing the Baileys onboarding flow. `handleWhatsAppRoute`
 * dispatches the pair/status/stop/disconnect actions over raw Node http request
 * and response objects, driving a WhatsAppPairingSession and persisting auth
 * state on connect; `applyWhatsAppQrOverride` folds a completed pairing's
 * credentials back into the connector config. Enforces MAX_PAIRING_SESSIONS.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { logger } from "@elizaos/core";
import { resolveWhatsAppAuthDirectory } from "../baileys/auth.js";
import type { WhatsAppPairingEvent } from "../services/whatsapp-pairing.js";

export type WhatsAppPairingEventLike = WhatsAppPairingEvent;

export interface WhatsAppPairingSessionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): string;
}

export interface WhatsAppRouteState {
  whatsappPairingSessions: Map<string, WhatsAppPairingSessionLike>;
  broadcastWs?: (data: object) => void;
  config: WhatsAppPluginConfig;
  runtime?: {
    getService(type: string): unknown | null;
  };
  saveConfig: () => void;
  workspaceDir: string;
}

type OwnerContactEntry = {
  entityId?: string;
  channelId?: string;
  roomId?: string;
};

type WhatsAppPluginConfig = Record<string, unknown> & {
  connectors?: Record<string, unknown>;
  agents?: {
    defaults?: {
      ownerContacts?: Record<string, OwnerContactEntry>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export interface WhatsAppRouteDeps {
  sanitizeAccountId: (accountId: string) => string;
  whatsappAuthExists: (accountId: string) => boolean | Promise<boolean>;
  whatsappLogout: (accountId: string) => Promise<void>;
  createWhatsAppPairingSession: (options: {
    authDir: string;
    accountId: string;
    onEvent: (event: WhatsAppPairingEventLike) => void;
  }) => WhatsAppPairingSessionLike;
}

interface WhatsAppAccountBody {
  accountId?: string;
  configurePlugin?: boolean;
  authScope?: WhatsAppAuthScope;
}

type WhatsAppAuthScope = "platform" | "lifeops";

const MAX_BODY_BYTES = 1_048_576;
export const MAX_PAIRING_SESSIONS = 10;
const pairingTransitions = new WeakMap<WhatsAppRouteState, Promise<void>>();

async function acquirePairingTransition(state: WhatsAppRouteState): Promise<() => void> {
  const previous = pairingTransitions.get(state) ?? Promise.resolve();
  let releaseTransition: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  pairingTransitions.set(state, current);
  await previous;
  return () => {
    releaseTransition?.();
    if (pairingTransitions.get(state) === current) pairingTransitions.delete(state);
  };
}

async function stopPairingSession(
  sessions: Map<string, WhatsAppPairingSessionLike>,
  sessionKey: string
): Promise<void> {
  for (;;) {
    const session = sessions.get(sessionKey);
    if (!session) return;
    await session.stop();
    if (sessions.get(sessionKey) === session) {
      sessions.delete(sessionKey);
      return;
    }
  }
}

async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse
): Promise<T | null> {
  let bytes = 0;
  let body = "";

  try {
    for await (const chunk of req) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_BODY_BYTES) {
        json(res, { error: "Request body too large" }, 413);
        return null;
      }
      body += text;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to read WhatsApp request body");
    json(res, { error: "Failed to read request body" }, 400);
    return null;
  }

  if (!body.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    json(res, { error: "Invalid JSON body" }, 400);
    return null;
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
  }
  res.end(JSON.stringify(data));
}

function setOwnerContact(
  config: WhatsAppPluginConfig,
  update: { source: string; channelId?: string; entityId?: string; roomId?: string }
): boolean {
  if (!update.source) return false;

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.ownerContacts) config.agents.defaults.ownerContacts = {};

  const existing = config.agents.defaults.ownerContacts[update.source];
  const entry: OwnerContactEntry = {};
  if (update.channelId) entry.channelId = update.channelId;
  if (update.entityId) entry.entityId = update.entityId;
  if (update.roomId) entry.roomId = update.roomId;

  if (Object.keys(entry).length === 0) return false;
  if (
    existing &&
    existing.channelId === entry.channelId &&
    existing.entityId === entry.entityId &&
    existing.roomId === entry.roomId
  ) {
    return false;
  }

  config.agents.defaults.ownerContacts[update.source] = entry;
  return true;
}

type ConfigSnapshot = {
  connectors: Record<string, unknown> | undefined;
  whatsappConnector: unknown;
  agents: WhatsAppPluginConfig["agents"];
  defaults: NonNullable<WhatsAppPluginConfig["agents"]>["defaults"];
  ownerContacts: Record<string, OwnerContactEntry> | undefined;
  whatsappContact: OwnerContactEntry | undefined;
};

function snapshotConfig(config: WhatsAppPluginConfig): ConfigSnapshot {
  return {
    connectors: config.connectors,
    whatsappConnector: config.connectors?.whatsapp,
    agents: config.agents,
    defaults: config.agents?.defaults,
    ownerContacts: config.agents?.defaults?.ownerContacts,
    whatsappContact: config.agents?.defaults?.ownerContacts?.whatsapp,
  };
}

// Restores exactly the containers and entries the handlers may have created or
// replaced so a failed persist leaves memory equal to what is still on disk.
function restoreConfig(config: WhatsAppPluginConfig, snapshot: ConfigSnapshot): void {
  if (snapshot.connectors === undefined) {
    delete config.connectors;
  } else if (snapshot.whatsappConnector === undefined) {
    delete snapshot.connectors.whatsapp;
    config.connectors = snapshot.connectors;
  } else {
    snapshot.connectors.whatsapp = snapshot.whatsappConnector;
    config.connectors = snapshot.connectors;
  }

  if (snapshot.agents === undefined) {
    delete config.agents;
  } else if (snapshot.defaults === undefined) {
    delete snapshot.agents.defaults;
    config.agents = snapshot.agents;
  } else if (snapshot.ownerContacts === undefined) {
    delete snapshot.defaults.ownerContacts;
    snapshot.agents.defaults = snapshot.defaults;
    config.agents = snapshot.agents;
  } else if (snapshot.whatsappContact === undefined) {
    delete snapshot.ownerContacts.whatsapp;
    snapshot.defaults.ownerContacts = snapshot.ownerContacts;
    snapshot.agents.defaults = snapshot.defaults;
    config.agents = snapshot.agents;
  } else {
    snapshot.ownerContacts.whatsapp = snapshot.whatsappContact;
    snapshot.defaults.ownerContacts = snapshot.ownerContacts;
    snapshot.agents.defaults = snapshot.defaults;
    config.agents = snapshot.agents;
  }
}

function saveConfigFailureMessage(err: unknown): string {
  return err instanceof Error
    ? `Failed to save connector config: ${err.message}`
    : "Failed to save connector config";
}

function shouldConfigurePlugin(body: WhatsAppAccountBody | null): boolean {
  return body?.configurePlugin !== false;
}

class WhatsAppAuthScopeError extends Error {
  constructor(message = "Invalid authScope") {
    super(message);
    this.name = "WhatsAppAuthScopeError";
  }
}

function resolveAuthScope(value: unknown): WhatsAppAuthScope {
  if (value == null || value === "") {
    return "platform";
  }
  if (value === "lifeops") {
    return "lifeops";
  }
  if (value === "platform") {
    return "platform";
  }
  throw new WhatsAppAuthScopeError();
}

function parseAuthScopeOrReject(res: ServerResponse, value: unknown): WhatsAppAuthScope | null {
  // error-policy:J1 invalid request values become an HTTP 400 response.
  try {
    return resolveAuthScope(value);
  } catch (error) {
    if (error instanceof WhatsAppAuthScopeError) {
      json(res, { error: error.message }, 400);
      return null;
    }
    throw error;
  }
}

function resolveSessionKey(authScope: WhatsAppAuthScope, accountId: string): string {
  return `${authScope}:${accountId}`;
}

function resolveAuthDir(
  _workspaceDir: string,
  accountId: string,
  _authScope: WhatsAppAuthScope
): string {
  return resolveWhatsAppAuthDirectory(accountId);
}

async function authExistsForScope(
  deps: WhatsAppRouteDeps,
  accountId: string,
  _authScope: WhatsAppAuthScope
): Promise<boolean> {
  return await deps.whatsappAuthExists(accountId);
}

export async function handleWhatsAppRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  state: WhatsAppRouteState,
  deps: WhatsAppRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/whatsapp")) return false;

  if (pathname === "/api/whatsapp/webhook" && method === "GET") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const mode = url.searchParams.get("hub.mode") ?? "";
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";

    const service = state.runtime?.getService("whatsapp") as
      | {
          verifyWebhook?: (mode: string, token: string, challenge: string) => string | null;
        }
      | null
      | undefined;

    if (!service || typeof service.verifyWebhook !== "function") {
      json(res, { error: "WhatsApp service unavailable" }, 503);
      return true;
    }

    const verifiedChallenge = service.verifyWebhook(mode, token, challenge);
    if (!verifiedChallenge) {
      json(res, { error: "Webhook verification failed" }, 403);
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end(verifiedChallenge);
    return true;
  }

  if (pathname === "/api/whatsapp/webhook" && method === "POST") {
    const service = state.runtime?.getService("whatsapp") as
      | {
          handleWebhook?: (event: Record<string, unknown>) => Promise<void>;
        }
      | null
      | undefined;

    if (!service || typeof service.handleWebhook !== "function") {
      json(res, { error: "WhatsApp service unavailable" }, 503);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) {
      return true;
    }

    await service.handleWebhook(body);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("EVENT_RECEIVED");
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/pair") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = parseAuthScopeOrReject(res, body?.authScope);
    if (authScope == null) {
      return true;
    }
    const configurePlugin = authScope === "platform" && shouldConfigurePlugin(body);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);
    const releaseTransition = await acquirePairingTransition(state);

    try {
      const isReplacing = state.whatsappPairingSessions.has(sessionKey);
      if (!isReplacing && state.whatsappPairingSessions.size >= MAX_PAIRING_SESSIONS) {
        json(
          res,
          {
            error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
          },
          429
        );
        return true;
      }

      const authDir = resolveAuthDir(state.workspaceDir, accountId, authScope);
      await stopPairingSession(state.whatsappPairingSessions, sessionKey);

      const session = deps.createWhatsAppPairingSession({
        authDir,
        accountId,
        onEvent: (event) => {
          state.broadcastWs?.({ ...event, authScope });

          if (event.status === "connected") {
            const snapshot = snapshotConfig(state.config);
            let configChanged = false;
            if (configurePlugin) {
              if (!state.config.connectors) state.config.connectors = {};
              state.config.connectors.whatsapp = {
                ...((state.config.connectors.whatsapp as Record<string, unknown> | undefined) ??
                  {}),
                authDir,
                enabled: true,
              };
              configChanged = true;
            }

            const phoneNumber = event.phoneNumber;
            configChanged =
              setOwnerContact(state.config as Parameters<typeof setOwnerContact>[0], {
                source: "whatsapp",
                channelId: phoneNumber ?? undefined,
              }) || configChanged;

            if (!configChanged) {
              return;
            }

            try {
              state.saveConfig();
            } catch (err) {
              // error-policy:J1 the pairing response has already been sent, so the
              // persist failure is surfaced on the pairing status channel after
              // restoring the in-memory config to what remains on disk.
              restoreConfig(state.config, snapshot);
              const message = saveConfigFailureMessage(err);
              logger.error(
                { accountId, authScope, error: err instanceof Error ? err.message : String(err) },
                "[whatsapp] Failed to persist connector config after pairing"
              );
              state.broadcastWs?.({
                type: "whatsapp-status",
                accountId,
                authScope,
                status: "error",
                error: message,
              });
            }
          }
        },
      });

      state.whatsappPairingSessions.set(sessionKey, session);

      try {
        await session.start();
        json(res, {
          ok: true,
          accountId,
          authScope,
          status: session.getStatus(),
        });
      } catch (err) {
        json(res, { ok: false, error: String(err) }, 500);
      }
      return true;
    } finally {
      releaseTransition();
    }
  }

  if (method === "GET" && pathname === "/api/whatsapp/status") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(url.searchParams.get("accountId") || "default");
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const requested = url.searchParams.getAll("authScope");
    if (requested.length > 1) {
      json(res, { error: "Invalid authScope" }, 400);
      return true;
    }
    const authScope = parseAuthScopeOrReject(res, requested[0] ?? null);
    if (authScope == null) {
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);

    const session = state.whatsappPairingSessions.get(sessionKey);

    let serviceConnected = false;
    let servicePhone: string | null = null;
    if (state.runtime) {
      try {
        const waService = state.runtime.getService("whatsapp") as Record<string, unknown> | null;
        if (waService) {
          serviceConnected = Boolean(waService.connected);
          servicePhone = (waService.phoneNumber as string) ?? null;
        }
      } catch {
        /* service unavailable during setup status lookup */
      }
    }

    json(res, {
      accountId,
      authScope,
      status: session?.getStatus() ?? "idle",
      authExists: await authExistsForScope(deps, accountId, authScope),
      serviceConnected,
      servicePhone,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/pair/stop") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = parseAuthScopeOrReject(res, body?.authScope);
    if (authScope == null) {
      return true;
    }
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);
    const releaseTransition = await acquirePairingTransition(state);
    try {
      await stopPairingSession(state.whatsappPairingSessions, sessionKey);
    } finally {
      releaseTransition();
    }

    json(res, { ok: true, accountId, authScope, status: "idle" });
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/disconnect") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = parseAuthScopeOrReject(res, body?.authScope);
    if (authScope == null) {
      return true;
    }
    const configurePlugin = authScope === "platform" && shouldConfigurePlugin(body);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);
    const releaseTransition = await acquirePairingTransition(state);

    try {
      await stopPairingSession(state.whatsappPairingSessions, sessionKey);

      try {
        await deps.whatsappLogout(accountId);
      } catch (logoutErr) {
        logger.warn(
          {
            accountId,
            error: logoutErr instanceof Error ? logoutErr.message : String(logoutErr),
          },
          "[whatsapp] Logout failed"
        );
        throw logoutErr;
      }

      if (configurePlugin && state.config.connectors) {
        const snapshot = snapshotConfig(state.config);
        delete state.config.connectors.whatsapp;
        try {
          state.saveConfig();
        } catch (err) {
          // error-policy:J1 a failed persist leaves the connector configured on
          // disk, so memory is restored and the caller gets a structured 500.
          restoreConfig(state.config, snapshot);
          logger.error(
            { accountId, authScope, error: err instanceof Error ? err.message : String(err) },
            "[whatsapp] Failed to persist connector config after disconnect"
          );
          json(res, { ok: false, error: saveConfigFailureMessage(err) }, 500);
          return true;
        }
      }
    } finally {
      releaseTransition();
    }

    json(res, { ok: true, accountId, authScope });
    return true;
  }

  return false;
}

export function applyWhatsAppQrOverride(
  plugins: {
    id: string;
    validationErrors: unknown[];
    configured: boolean;
    qrConnected?: boolean;
  }[],
  _workspaceDir: string
): void {
  try {
    const waCredsPath = path.join(resolveWhatsAppAuthDirectory("default"), "auth-state.json");
    if (fs.existsSync(waCredsPath)) {
      const waPlugin = plugins.find((plugin) => plugin.id === "whatsapp");
      if (waPlugin) {
        waPlugin.validationErrors = [];
        waPlugin.configured = true;
        waPlugin.qrConnected = true;
      }
    }
  } catch {
    /* workspace dir may not exist */
  }
}
