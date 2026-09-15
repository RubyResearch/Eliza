/**
 * Exercises Telegram setup through the production HTTP dispatcher with an
 * in-memory setup service. Bot identity responses are controlled at the remote
 * provider boundary; local requests use real HTTP. The suite checks validation,
 * credential cleanup, and separation of bot setup from owner-recipient pairing.
 * Core is restored below because the package fixture otherwise replaces the
 * transport utilities used by the production dispatcher.
 */

import { vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await vi.importActual("@elizaos/core");
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { telegramAccountRoutes } from "./account-setup-routes.ts";
import {
  claimTelegramPollerToken,
  markTelegramPollerConnected,
  markTelegramPollerError,
  releaseTelegramPollerToken,
} from "./poller-lock.ts";
import { telegramSetupRoutes } from "./setup-routes.ts";

const servers: http.Server[] = [];
const pollers: Array<{ token: string; bot: Telegraf }> = [];

afterEach(async () => {
  for (const { token, bot } of pollers) releaseTelegramPollerToken(token, bot);
  pollers.length = 0;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

type ConnectorConfig = Record<string, unknown>;

interface FakeSetupServiceState {
  config: ConnectorConfig;
  calls: string[];
}

/**
 * Faked `connector-setup` service. Implements every method the route guards
 * (`isConnectorSetupService` in both route modules) require, backed by a plain
 * mutable config object so `updateConfig` mutations are observable.
 */
function makeSetupService(state: FakeSetupServiceState) {
  return {
    getConfig: () => state.config,
    persistConfig: (config: ConnectorConfig) => {
      state.calls.push("persistConfig");
      state.config = config;
    },
    updateConfig: (updater: (config: ConnectorConfig) => void) => {
      state.calls.push("updateConfig");
      updater(state.config);
    },
    registerEscalationChannel: (channel: string) => {
      state.calls.push(`registerEscalationChannel:${channel}`);
      return true;
    },
    setOwnerContact: (update: { source: string; channelId?: string }) => {
      state.calls.push(`setOwnerContact:${update.source}`);
      state.config.ownerContact = update;
      return true;
    },
    removeConnectorCredentialReference: async (reference: string) => {
      state.calls.push(`removeConnectorCredentialReference:${reference}`);
      return reference.startsWith("vault://");
    },
  };
}

function makeRuntime(
  options: {
    withService?: boolean;
    withTelegram?: boolean;
    credentialStore?: { get(reference: string): Promise<string> };
    state?: FakeSetupServiceState;
    settings?: Record<string, string>;
  } = {},
): AgentRuntime {
  const { withService = true, withTelegram = false, state, settings } = options;
  const setupState: FakeSetupServiceState = state ?? {
    // Shape a real connector-setup service returns: a `connectors` block with a
    // present-but-empty `telegram` sub-config (no saved token yet).
    config: { connectors: { telegram: {} } },
    calls: [],
  };
  const setupService = makeSetupService(setupState);
  return {
    agentId: "00000000-0000-4000-8000-000000000123",
    routes: [...telegramSetupRoutes, ...telegramAccountRoutes],
    // Only the `connector-setup` service exists in these branches. The live
    // `telegram` / `telegram-account` services are absent (null), which is the
    // state a freshly-configuring user is in.
    getService: (key: string) =>
      key === "connector_credential_store" && options.credentialStore
        ? options.credentialStore
        : key === "telegram" && withTelegram
          ? {}
          : withService && key === "connector-setup"
            ? setupService
            : null,
    // No persisted env settings by default — keeps the missing-phone /
    // missing-token validation branches deterministic. `settings` opts a test
    // into the runtime-setting tier `readSavedToken` falls back to.
    getSetting: (key: string) => settings?.[key] ?? null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SetupErrorBody {
  error: { code: string; message: string };
}

describe("plugin-telegram setup routes (real dispatch)", () => {
  it("serves bot-token status on a happy path (200, idle when nothing configured)", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { hasToken: boolean; serviceConnected: boolean };
    };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
    expect(body.detail.hasToken).toBe(false);
    expect(body.detail.serviceConnected).toBe(false);
  });

  it.each([
    { source: "telegram", channelId: "555000111", entityId: "verified-owner" },
    undefined,
  ])(
    "does not replace owner recipient %j with a configured bot",
    async (owner) => {
      const state: FakeSetupServiceState = {
        config: { ownerContact: owner, connectors: { telegram: {} } },
        calls: [],
      };
      const base = await startServer(makeRuntime({ state }));
      const realFetch = globalThis.fetch;
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith("https://api.telegram.org/bot")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  id: 123456789,
                  is_bot: true,
                  first_name: "Synthetic bot",
                  username: "synthetic_test_bot",
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input, init);
        });
      try {
        const response = await postJson(base, "/api/setup/telegram/start", {
          token: "123456789:abcdefghijklmnopqrstuvwxyz123456",
        });
        expect(response.status).toBe(200);
        expect(state.config.ownerContact).toEqual(owner);
        const status = await response.json();
        expect(status.detail.bot.id).toBe(123456789);
        expect(status.state).toBe("configuring");
      } finally {
        provider.mockRestore();
      }
    },
  );

  it("rejects a start with no token (400 from the real validator)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram/start", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("token is required");
  });

  it("rejects a start with a malformed token (400 format invalid)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram/start", {
      token: "not-a-real-token",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("Token format invalid");
  });

  it("cancels bot-token setup on a happy path (200, clears persisted token)", async () => {
    const state: FakeSetupServiceState = {
      config: { connectors: { telegram: { botToken: "123:abc" } } },
      calls: [],
    };
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
    expect(state.calls).toContain("updateConfig");
    const connectors = state.config.connectors as Record<
      string,
      Record<string, unknown>
    >;
    expect(connectors.telegram.botToken).toBeUndefined();
  });

  it("cancels a vault-backed bot token in config and encrypted storage", async () => {
    const reference = "vault://connector.agent-1.telegram.42.bot-token";
    const state: FakeSetupServiceState = {
      config: { connectors: { telegram: { botToken: reference } } },
      calls: [],
    };
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(res.status).toBe(200);
    expect(state.calls).toContain(
      `removeConnectorCredentialReference:${reference}`,
    );
  });

  it("still serves status when the connector-setup service is unavailable (200)", async () => {
    // Telegram setup has no 503 branch — without the connector-setup service it
    // degrades to runtime-only reads, so status must still resolve.
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
  });

  it("serves status before any connector was ever configured (no connectors block)", async () => {
    // A fresh install's persisted config has no `connectors` key at all —
    // `handleStart` is what first creates `connectors.telegram`. Reading the
    // saved token must treat that block as optional, exactly like the
    // `config.connectors` lookup above it already does.
    const state: FakeSetupServiceState = { config: {}, calls: [] };
    const base = await startServer(makeRuntime({ state }));
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { hasToken: boolean; serviceConnected: boolean };
    };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
    expect(body.detail.hasToken).toBe(false);
  });

  it("serves status when other connectors are configured but Telegram is not", async () => {
    const state: FakeSetupServiceState = {
      config: { connectors: { discord: { botToken: "123:abc" } } },
      calls: [],
    };
    const base = await startServer(makeRuntime({ state }));
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      detail: { hasToken: boolean };
    };
    expect(body.state).toBe("idle");
    expect(body.detail.hasToken).toBe(false);
  });

  it("still reports the env-configured token when no connectors block exists", async () => {
    // TELEGRAM_BOT_TOKEN is the documented single-account tier, and
    // `readSavedToken` falls back to it — but only if the persisted-config
    // lookup ahead of it returns instead of throwing.
    const state: FakeSetupServiceState = { config: {}, calls: [] };
    const base = await startServer(
      makeRuntime({
        state,
        settings: { TELEGRAM_BOT_TOKEN: "123456:ABCDEF" },
      }),
    );
    const res = await fetch(`${base}/api/setup/telegram/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      detail: { hasToken: boolean };
    };
    expect(body.detail.hasToken).toBe(true);
    expect(body.state).toBe("configuring");
  });

  it("cancels bot-token setup before any connector was configured (200)", async () => {
    const state: FakeSetupServiceState = { config: {}, calls: [] };
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram");
    expect(body.state).toBe("idle");
  });

  it("enforces the auth gate on the non-public bot-token routes (401)", async () => {
    const base = await startServer(makeRuntime(), () => false);

    const status = await fetch(`${base}/api/setup/telegram/status`);
    expect(status.status).toBe(401);
    expect((await status.json()) as { error: string }).toEqual({
      error: "Unauthorized",
    });

    const start = await postJson(base, "/api/setup/telegram/start", {
      token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    expect(start.status).toBe(401);

    const cancel = await postJson(base, "/api/setup/telegram/cancel", {});
    expect(cancel.status).toBe(401);
  });
});

describe("plugin-telegram account routes (real dispatch)", () => {
  it("serves account auth status on a happy path (200, idle)", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/setup/telegram-account/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: { status: string; configured: boolean };
    };
    expect(body.connector).toBe("telegram-account");
    expect(body.state).toBe("idle");
    expect(body.detail.status).toBe("idle");
    expect(body.detail.configured).toBe(false);
  });

  it("rejects an account start with no phone (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram-account/start", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("phone number is required");
  });

  it("rejects submit-code before a login session has started (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(
      base,
      "/api/setup/telegram-account/submit-code",
      { telegramCode: "12345" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as SetupErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("login session has not been started");
  });

  it("cancels account auth on a happy path (200)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/setup/telegram-account/cancel", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: string; state: string };
    expect(body.connector).toBe("telegram-account");
    expect(body.state).toBe("idle");
  });

  it("enforces the auth gate on the non-public account routes (401)", async () => {
    const base = await startServer(makeRuntime(), () => false);

    const status = await fetch(`${base}/api/setup/telegram-account/status`);
    expect(status.status).toBe(401);

    const start = await postJson(base, "/api/setup/telegram-account/start", {
      phone: "+15555550100",
    });
    expect(start.status).toBe(401);

    const submit = await postJson(
      base,
      "/api/setup/telegram-account/submit-code",
      { telegramCode: "12345" },
    );
    expect(submit.status).toBe(401);

    const cancel = await postJson(
      base,
      "/api/setup/telegram-account/cancel",
      {},
    );
    expect(cancel.status).toBe(401);
  });
});

describe("Telegram setup poller readiness over HTTP", () => {
  it("does not report paired merely because a service was constructed", async () => {
    const base = await startServer(
      makeRuntime({
        withTelegram: true,
        settings: { TELEGRAM_BOT_TOKEN: "880001:synthetic-unlaunched" },
      }),
    );
    const response = await fetch(`${base}/api/setup/telegram/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "configuring",
      detail: { hasToken: true, serviceConnected: false },
    });
  });

  it("follows the exact token's connected, failed and replacement states", async () => {
    const token = "880002:synthetic-readiness";
    const settings = { TELEGRAM_BOT_TOKEN: token };
    const runtime = makeRuntime({ settings });
    const bot = new Telegraf(token);
    pollers.push({ token, bot });
    claimTelegramPollerToken(token, {
      bot,
      mode: "full",
      ownerId: String(runtime.agentId),
      accountId: "default",
    });
    const base = await startServer(runtime);
    const read = async () =>
      (await fetch(`${base}/api/setup/telegram/status`)).json();
    expect(await read()).toMatchObject({ state: "configuring" });
    markTelegramPollerConnected(token, bot);
    expect(await read()).toMatchObject({
      state: "paired",
      detail: { serviceConnected: true },
    });
    markTelegramPollerError(token, bot, new Error("synthetic poller outage"));
    expect(await read()).toMatchObject({
      state: "configuring",
      detail: { serviceConnected: false },
    });
    markTelegramPollerConnected(token, bot);
    settings.TELEGRAM_BOT_TOKEN = "880003:synthetic-replacement";
    expect(await read()).toMatchObject({
      state: "configuring",
      detail: { serviceConnected: false },
    });
  });

  it.each([
    ["another-agent", "default"],
    ["00000000-0000-4000-8000-000000000123", "another-account"],
  ])("rejects a ready poller owned by %s/%s", async (ownerId, accountId) => {
    const token = "880004:synthetic-wrong-owner";
    const bot = new Telegraf(token);
    pollers.push({ token, bot });
    claimTelegramPollerToken(token, { bot, mode: "full", ownerId, accountId });
    markTelegramPollerConnected(token, bot);
    const base = await startServer(
      makeRuntime({
        withTelegram: true,
        settings: { TELEGRAM_BOT_TOKEN: token },
      }),
    );
    const response = await fetch(`${base}/api/setup/telegram/status`);
    expect(await response.json()).toMatchObject({
      state: "configuring",
      detail: { serviceConnected: false },
    });
  });
});

describe("Telegram encrypted-token readiness", () => {
  it("checks the saved vault credential rather than the previous runtime token", async () => {
    const token = "880005:synthetic-vault-token";
    const reference =
      "connector.00000000-0000-4000-8000-000000000123.telegram.880005.bot-token";
    const bot = new Telegraf(token);
    pollers.push({ token, bot });
    const runtime = makeRuntime({
      settings: { TELEGRAM_BOT_TOKEN: "880006:synthetic-previous-token" },
      state: {
        config: {
          connectors: { telegram: { botToken: `vault://${reference}` } },
        },
        calls: [],
      },
      credentialStore: {
        get: async (key) => {
          if (key !== reference)
            throw new Error("unexpected credential reference");
          return token;
        },
      },
    });
    claimTelegramPollerToken(token, {
      bot,
      mode: "full",
      ownerId: String(runtime.agentId),
      accountId: "default",
    });
    markTelegramPollerConnected(token, bot);
    const base = await startServer(runtime);
    const response = await fetch(`${base}/api/setup/telegram/status`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ state: "paired" });
    expect(text).not.toContain(token);
    expect(text).not.toContain(reference);
  });

  it("reports unavailable credentials without exposing a vault failure", async () => {
    const runtime = makeRuntime({
      state: {
        config: {
          connectors: {
            telegram: {
              botToken:
                "vault://connector.00000000-0000-4000-8000-000000000123.telegram.880007.bot-token",
            },
          },
        },
        calls: [],
      },
      credentialStore: {
        get: async () => {
          throw new Error("sensitive storage detail");
        },
      },
    });
    const base = await startServer(runtime);
    const response = await fetch(`${base}/api/setup/telegram/status`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "credential_unavailable" },
    });
    expect(text).not.toContain("sensitive storage detail");
  });
});

it("does not resolve another agent's configured vault reference", async () => {
  const reads: string[] = [];
  const runtime = makeRuntime({
    state: {
      config: {
        connectors: {
          telegram: {
            botToken:
              "vault://connector.another-agent.telegram.880008.bot-token",
          },
        },
      },
      calls: [],
    },
    credentialStore: {
      get: async (key) => {
        reads.push(key);
        return "880008:synthetic-other-agent";
      },
    },
  });
  const base = await startServer(runtime);
  const response = await fetch(`${base}/api/setup/telegram/status`);
  expect(response.status).toBe(503);
  expect(reads).toEqual([]);
});
