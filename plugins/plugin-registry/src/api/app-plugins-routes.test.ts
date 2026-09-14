/**
 * Exercises the app-core compatibility routes against persisted plugin state,
 * including the invariants shared with the canonical core toggle surface.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  devCloudAuthority: null as string | null,
  ensureRouteAuthorized: vi.fn(),
  loadElizaConfig: vi.fn(),
  loadRegistry: vi.fn(),
  readCompatJsonBody: vi.fn(),
  saveElizaConfig: vi.fn(),
  sendJson: vi.fn(),
  sendJsonError: vi.fn(),
  vaultGet: vi.fn(),
  vaultReveal: vi.fn(),
}));

const VAULT_REF_PREFIX = "vault://";

vi.mock("@elizaos/agent", () => ({
  applyPluginRuntimeMutation: vi.fn(),
  CONNECTOR_ENV_MAP: {
    discord: {
      token: "DISCORD_API_TOKEN",
    },
  },
  discoverPluginsFromManifest: vi.fn(() => []),
  findPrimaryEnvKey: vi.fn((keys: string[]) => keys[0] ?? null),
  isAdvancedCapabilityPluginId: vi.fn(() => false),
  isVaultRef: (value: unknown) =>
    typeof value === "string" &&
    value.startsWith(VAULT_REF_PREFIX) &&
    value.length > VAULT_REF_PREFIX.length,
  loadElizaConfig: mocks.loadElizaConfig,
  parseVaultRef: (value: string) =>
    value.startsWith(VAULT_REF_PREFIX)
      ? value.slice(VAULT_REF_PREFIX.length)
      : null,
  readBundledPluginPackageMetadata: vi.fn(),
  resolveAdvancedCapabilitiesEnabled: vi.fn(() => false),
  saveElizaConfig: mocks.saveElizaConfig,
}));

vi.mock("@elizaos/app-core/api/auth", () => ({
  ensureCompatSensitiveRouteAuthorized: vi.fn(),
  ensureRouteAuthorized: mocks.ensureRouteAuthorized,
}));

vi.mock("@elizaos/app-core/api/compat-route-shared", () => ({
  readCompatJsonBody: mocks.readCompatJsonBody,
  scheduleCompatRuntimeRestart: vi.fn(),
}));

vi.mock("@elizaos/app-core/api/response", () => ({
  sendJson: mocks.sendJson,
  sendJsonError: mocks.sendJsonError,
}));

vi.mock("@elizaos/registry/first-party", () => ({
  loadRegistry: mocks.loadRegistry,
}));

vi.mock("@elizaos/app-core/services/vault-mirror", () => ({
  _resetSharedVaultForTesting: vi.fn(),
  mirrorPluginSensitiveToVault: vi.fn(() => Promise.resolve({ failures: [] })),
  sharedVault: () => ({ get: mocks.vaultGet, reveal: mocks.vaultReveal }),
}));

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@elizaos/shared", () => ({
  DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS: [
    "STEWARD_API_URL",
    "STEWARD_TENANT_ID",
    "STEWARD_AGENT_ID",
    "ELIZA_STEWARD_AGENT_ID",
    "STEWARD_API_KEY",
    "STEWARD_AGENT_TOKEN",
    "STEWARD_TRADE_SESSION_ID",
    "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
    "STEWARD_POLYMARKET_TRADE_SESSION_ID",
  ],
  asRecord: (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null,
  CONNECTOR_PLUGINS: {
    discord: "@elizaos/plugin-discord",
  },
  resolveDevCloudEnvAuthority: vi.fn(() => mocks.devCloudAuthority),
}));

vi.mock("@elizaos/vault", () => ({
  VaultMissError: class VaultMissError extends Error {
    constructor(readonly key: string) {
      super(`vault: no entry for ${JSON.stringify(key)}`);
      this.name = "VaultMissError";
    }
  },
}));

import { VaultMissError } from "@elizaos/vault";
import {
  analyzePluginStateDrift,
  buildPluginListResponse,
  handlePluginsCompatRoutes,
  persistCompatPluginMutation,
} from "./app-plugins-routes.js";

const originalEnv = { ...process.env };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "discord",
    name: "Discord",
    description: "",
    tags: [],
    enabled: false,
    configured: false,
    envKey: "DISCORD_API_TOKEN",
    category: "connector",
    source: "bundled",
    configKeys: ["DISCORD_API_TOKEN"],
    parameters: [
      {
        key: "DISCORD_API_TOKEN",
        required: false,
        sensitive: true,
        type: "string",
      },
    ],
    validationErrors: [],
    validationWarnings: [],
    npmName: "@elizaos/plugin-discord",
    isActive: false,
    ...overrides,
  };
}

function makeStewardWalletPlugin() {
  return makePlugin({
    id: "wallet",
    name: "Wallet",
    envKey: "STEWARD_AGENT_TOKEN",
    configKeys: [
      "STEWARD_API_URL",
      "STEWARD_AGENT_ID",
      "STEWARD_AGENT_TOKEN",
      "STEWARD_TENANT_ID",
    ],
    parameters: [
      {
        key: "STEWARD_API_URL",
        required: false,
        sensitive: false,
        type: "string",
      },
      {
        key: "STEWARD_AGENT_ID",
        required: false,
        sensitive: false,
        type: "string",
      },
      {
        key: "STEWARD_AGENT_TOKEN",
        required: false,
        sensitive: true,
        type: "string",
      },
      {
        key: "STEWARD_TENANT_ID",
        required: false,
        sensitive: false,
        type: "string",
      },
    ],
    npmName: "@elizaos/plugin-wallet",
  });
}

describe("app plugin compatibility routes", () => {
  let currentConfig: Record<string, unknown>;
  let savedConfig: Record<string, unknown> | undefined;

  beforeEach(() => {
    mocks.devCloudAuthority = null;
    process.env = { ...originalEnv };
    delete process.env.DISCORD_API_TOKEN;
    currentConfig = {
      env: {},
      plugins: {
        entries: {},
      },
    };
    savedConfig = undefined;
    mocks.saveElizaConfig.mockClear();
    mocks.loadElizaConfig.mockImplementation(() => currentConfig);
    mocks.loadRegistry.mockReturnValue({ all: [], byId: new Map() });
    mocks.loadRegistry.mockClear();
    mocks.saveElizaConfig.mockImplementation((config) => {
      savedConfig = clone(config);
    });
    mocks.ensureRouteAuthorized.mockResolvedValue(true);
    mocks.readCompatJsonBody.mockResolvedValue({});
    mocks.sendJson.mockClear();
    mocks.sendJsonError.mockClear();
    mocks.vaultGet.mockReset();
    mocks.vaultReveal.mockReset();
  });

  it("rejects undeclared config keys without saving", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: "token", OTHER_KEY: "bad" } },
      makePlugin(),
    );

    expect(result.status).toBe(422);
    expect(result.payload.validationErrors).toEqual([
      expect.objectContaining({ field: "OTHER_KEY" }),
    ]);
    expect(mocks.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("writes valid config values to env, plugin entry config, and process.env", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: "abc123" } },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.env).toEqual({ DISCORD_API_TOKEN: "abc123" });
    expect(savedConfig?.plugins).toEqual({
      entries: {
        discord: {
          config: {
            DISCORD_API_TOKEN: "abc123",
          },
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBe("abc123");
  });

  it.each([
    "staging-default",
    "staging-explicit",
    "production",
    "offline",
    "self-hosted",
  ])(
    "rejects Cloud plugin config without mutating compat state under %s authority",
    (authority) => {
      mocks.devCloudAuthority = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "launch-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://launch.example/api/v1";
      currentConfig = {
        env: {
          ELIZAOS_CLOUD_API_KEY: "launch-key",
          ELIZAOS_CLOUD_BASE_URL: "https://launch.example/api/v1",
        },
        plugins: {
          entries: {
            "cloud-apps": {
              enabled: true,
              config: { ELIZAOS_CLOUD_API_KEY: "launch-key" },
            },
          },
        },
      };
      const configBefore = JSON.stringify(currentConfig);
      const envBefore = JSON.stringify(Object.entries(process.env).sort());
      const cloudPlugin = makePlugin({
        id: "cloud-apps",
        name: "Cloud Apps",
        envKey: "ELIZAOS_CLOUD_API_KEY",
        configKeys: ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_BASE_URL"],
        parameters: [
          {
            key: "ELIZAOS_CLOUD_API_KEY",
            required: false,
            sensitive: true,
            type: "string",
          },
          {
            key: "ELIZAOS_CLOUD_BASE_URL",
            required: false,
            sensitive: false,
            type: "string",
          },
        ],
        npmName: "@elizaos/plugin-cloud-apps",
      });

      const result = persistCompatPluginMutation(
        "cloud-apps",
        {
          config: {
            ELIZAOS_CLOUD_API_KEY: "hostile-key",
            ELIZAOS_CLOUD_BASE_URL: "https://hostile.example/api/v1",
          },
        },
        cloudPlugin,
      );

      expect(result.status).toBe(409);
      expect(result.payload.error).toEqual(
        expect.stringContaining("launcher-owned Cloud parameters"),
      );
      expect(JSON.stringify(currentConfig)).toBe(configBefore);
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(
        envBefore,
      );
      expect(mocks.saveElizaConfig).not.toHaveBeenCalled();
      expect(savedConfig).toBeUndefined();
    },
  );

  it.each([
    "staging-default",
    "staging-explicit",
    "production",
    "offline",
    "self-hosted",
  ])(
    "rejects Steward plugin config without mutating compat state under %s authority",
    (authority) => {
      mocks.devCloudAuthority = authority;
      process.env.STEWARD_API_URL = "https://launch.example/steward";
      process.env.STEWARD_AGENT_ID = "launch-agent";
      process.env.STEWARD_AGENT_TOKEN = "launch-token";
      process.env.STEWARD_TENANT_ID = "launch-tenant";
      currentConfig = {
        env: {
          STEWARD_API_URL: "https://launch.example/steward",
          STEWARD_AGENT_ID: "launch-agent",
          STEWARD_AGENT_TOKEN: "launch-token",
          STEWARD_TENANT_ID: "launch-tenant",
        },
        plugins: {
          entries: {
            wallet: {
              enabled: true,
              config: {
                STEWARD_API_URL: "https://launch.example/steward",
                STEWARD_AGENT_ID: "launch-agent",
                STEWARD_AGENT_TOKEN: "launch-token",
                STEWARD_TENANT_ID: "launch-tenant",
              },
            },
          },
        },
      };
      const configBefore = JSON.stringify(currentConfig);
      const envBefore = JSON.stringify(Object.entries(process.env).sort());

      const result = persistCompatPluginMutation(
        "wallet",
        {
          config: {
            STEWARD_API_URL: "https://hostile.example/steward",
            STEWARD_AGENT_ID: "hostile-agent",
            STEWARD_AGENT_TOKEN: "hostile-token",
            STEWARD_TENANT_ID: "hostile-tenant",
          },
        },
        makeStewardWalletPlugin(),
      );

      expect(result.status).toBe(409);
      expect(result.payload.error).toEqual(
        expect.stringContaining("launcher-owned Cloud parameters"),
      );
      expect(JSON.stringify(currentConfig)).toBe(configBefore);
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(
        envBefore,
      );
      expect(mocks.saveElizaConfig).not.toHaveBeenCalled();
      expect(savedConfig).toBeUndefined();
    },
  );

  it("rejects Cloud plugin enablement before compat runtime restoration", () => {
    mocks.devCloudAuthority = "self-hosted";
    const result = persistCompatPluginMutation(
      "cloud-apps",
      { enabled: true },
      makePlugin({
        id: "cloud-apps",
        parameters: [
          {
            key: "ELIZAOS_CLOUD_API_KEY",
            required: false,
            sensitive: true,
            type: "string",
          },
        ],
        npmName: "@elizaos/plugin-cloud-apps",
      }),
    );

    expect(result.status).toBe(409);
    expect(mocks.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("preserves compat Cloud plugin configuration without launcher authority", () => {
    const result = persistCompatPluginMutation(
      "cloud-apps",
      { config: { ELIZAOS_CLOUD_API_KEY: "ordinary-key" } },
      makePlugin({
        id: "cloud-apps",
        envKey: "ELIZAOS_CLOUD_API_KEY",
        configKeys: ["ELIZAOS_CLOUD_API_KEY"],
        parameters: [
          {
            key: "ELIZAOS_CLOUD_API_KEY",
            required: false,
            sensitive: true,
            type: "string",
          },
        ],
        npmName: "@elizaos/plugin-cloud-apps",
      }),
    );

    expect(result.status).toBe(200);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ordinary-key");
    expect(mocks.saveElizaConfig).toHaveBeenCalled();
  });

  it("removes optional blank values from persisted and process env", () => {
    process.env.DISCORD_API_TOKEN = "old";
    currentConfig = {
      env: { DISCORD_API_TOKEN: "old" },
      plugins: {
        entries: {
          discord: {
            config: {
              DISCORD_API_TOKEN: "old",
            },
          },
        },
      },
    };

    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: " " } },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.env).toEqual({});
    expect(savedConfig?.plugins).toEqual({
      entries: {
        discord: {
          config: {},
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
  });

  it("mirrors connector enabled state to the compat connector section", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { enabled: true },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-discord"],
      entries: {
        discord: {
          enabled: true,
        },
      },
    });
    expect(savedConfig?.connectors).toEqual({
      discord: {
        enabled: true,
      },
    });
  });

  it("removes every plugin alias from the allowlist when disabling", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["discord", "@elizaos/plugin-discord", "@elizaos/plugin-openai"],
        entries: {
          discord: { enabled: true },
        },
      },
    };

    const result = persistCompatPluginMutation(
      "discord",
      { enabled: false },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai"],
      entries: {
        discord: {
          enabled: false,
        },
      },
    });
    expect(savedConfig?.connectors).toEqual({
      discord: {
        enabled: false,
      },
    });
  });

  it("keeps app plugin entries and the canonical allowlist aligned", () => {
    const personalAssistant = makePlugin({
      id: "personal-assistant",
      name: "Personal Assistant",
      category: "app",
      npmName: "@elizaos/plugin-personal-assistant",
    });
    const result = persistCompatPluginMutation(
      "personal-assistant",
      { enabled: true },
      personalAssistant,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-personal-assistant"],
      entries: {
        "personal-assistant": {
          enabled: true,
        },
      },
    });
    expect(savedConfig?.connectors).toBeUndefined();

    const drift = analyzePluginStateDrift(
      [{ ...personalAssistant, enabled: true }],
      savedConfig ?? {},
      { "personal-assistant": { enabled: true } },
      new Set(["@elizaos/plugin-personal-assistant"]),
    );
    expect(drift.plugins[0]?.drift_flags).not.toContain("entries_vs_allowlist");
  });

  it("canonicalizes mismatched runtime and package identities when disabling", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: [
          "google",
          "@elizaos/plugin-google-workspace",
          "@elizaos/plugin-openai",
        ],
        entries: {
          google: { enabled: true },
          "google-workspace": { enabled: true },
        },
      },
    };
    const google = makePlugin({
      id: "google",
      name: "Google Workspace",
      category: "feature",
      npmName: "@elizaos/plugin-google-workspace",
      enabled: false,
    });

    const result = persistCompatPluginMutation(
      "google",
      { enabled: false },
      google,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai"],
      entries: {
        "google-workspace": { enabled: false },
      },
    });

    const savedPlugins = savedConfig?.plugins as {
      allow: string[];
      entries: Record<string, { enabled?: unknown }>;
    };
    const drift = analyzePluginStateDrift(
      [google],
      {},
      savedPlugins.entries,
      new Set(savedPlugins.allow),
    );
    expect(drift.plugins[0]?.drift_flags).not.toContain("entries_vs_allowlist");
  });

  it("keeps a canonical disabled entry disabled when the runtime plugin is loaded", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: [],
        entries: {
          "google-workspace": { enabled: false },
        },
      },
    };
    const googleEntry = {
      id: "google",
      name: "Google Workspace",
      npmName: "@elizaos/plugin-google-workspace",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "email",
      config: {},
      render: {},
      resources: {},
      version: "1.0.0",
    };
    mocks.loadRegistry.mockReturnValue({
      all: [googleEntry],
      byId: new Map([["google", googleEntry]]),
    });

    const response = buildPluginListResponse({
      plugins: [{ name: "google" }],
    } as never);

    expect(response.plugins.find((plugin) => plugin.id === "google")).toEqual(
      expect.objectContaining({ enabled: false, isActive: true }),
    );
  });

  it("replaces a stale compatibility alias with the canonical package on enable", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["google", "@elizaos/plugin-openai"],
        entries: {
          google: { enabled: false },
        },
      },
    };
    const google = makePlugin({
      id: "google",
      name: "Google Workspace",
      category: "feature",
      npmName: "@elizaos/plugin-google-workspace",
      enabled: true,
    });

    const result = persistCompatPluginMutation(
      "google",
      { enabled: true },
      google,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai", "@elizaos/plugin-google-workspace"],
      entries: {
        "google-workspace": { enabled: true },
      },
    });
  });

  it("migrates allow aliases during a config-only update", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["google", "@elizaos/plugin-openai"],
        entries: { google: { enabled: true } },
      },
    };
    const google = makePlugin({
      id: "google",
      name: "Google Workspace",
      category: "feature",
      npmName: "@elizaos/plugin-google-workspace",
      enabled: true,
      parameters: [
        {
          key: "GOOGLE_CLIENT_ID",
          required: false,
          sensitive: false,
          type: "string",
        },
      ],
    });

    const result = persistCompatPluginMutation(
      "google",
      { config: { GOOGLE_CLIENT_ID: "client-id" } },
      google,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai", "@elizaos/plugin-google-workspace"],
      entries: {
        "google-workspace": {
          enabled: true,
          config: { GOOGLE_CLIENT_ID: "client-id" },
        },
      },
    });
    const savedPlugins = savedConfig?.plugins as {
      allow: string[];
      entries: Record<string, { enabled?: unknown }>;
    };
    expect(
      analyzePluginStateDrift(
        [google],
        {},
        savedPlugins.entries,
        new Set(savedPlugins.allow),
      ).plugins[0]?.drift_flags,
    ).not.toContain("entries_vs_allowlist");
  });

  it("preserves the registry id for config-only bundled feature updates", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["@elizaos/core"],
        entries: { core: { enabled: true } },
      },
    };
    const orchestrator = makePlugin({
      id: "agent-orchestrator",
      name: "Agent Orchestrator",
      category: "feature",
      npmName: "@elizaos/core",
      enabled: true,
      parameters: [
        {
          key: "ORCHESTRATOR_MODE",
          required: false,
          sensitive: false,
          type: "string",
        },
      ],
    });

    const result = persistCompatPluginMutation(
      "agent-orchestrator",
      { config: { ORCHESTRATOR_MODE: "enabled" } },
      orchestrator,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["agent-orchestrator"],
      entries: {
        "agent-orchestrator": {
          enabled: true,
          config: { ORCHESTRATOR_MODE: "enabled" },
        },
      },
    });
  });

  it("falls back to the registry id for non-plugin package metadata", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["@elizaos/core"],
        entries: {
          core: { enabled: false },
        },
      },
    };
    const orchestrator = makePlugin({
      id: "agent-orchestrator",
      name: "Agent Orchestrator",
      category: "feature",
      npmName: "@elizaos/core",
      enabled: true,
    });

    const result = persistCompatPluginMutation(
      "agent-orchestrator",
      { enabled: true },
      orchestrator,
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["agent-orchestrator"],
      entries: {
        "agent-orchestrator": { enabled: true },
      },
    });

    currentConfig = clone(savedConfig ?? {});
    savedConfig = undefined;
    const disabled = persistCompatPluginMutation(
      "agent-orchestrator",
      { enabled: false },
      orchestrator,
    );

    expect(disabled.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: [],
      entries: {
        "agent-orchestrator": { enabled: false },
      },
    });
  });

  it("canonicalizes legacy app-package identities in both directions", () => {
    currentConfig = {
      env: {},
      plugins: {
        allow: ["log-viewer", "@elizaos/plugin-openai"],
        entries: {
          "log-viewer": { enabled: false },
        },
      },
    };
    const logViewer = makePlugin({
      id: "log-viewer",
      name: "Log Viewer",
      category: "app",
      npmName: "@elizaos/app-log-viewer",
      enabled: false,
    });

    const enabledResult = persistCompatPluginMutation(
      "log-viewer",
      { enabled: true },
      logViewer,
    );

    expect(enabledResult.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai", "@elizaos/app-log-viewer"],
      entries: {
        "app-log-viewer": { enabled: true },
      },
    });

    currentConfig = savedConfig ?? {};
    const disabledResult = persistCompatPluginMutation(
      "log-viewer",
      { enabled: false },
      logViewer,
    );

    expect(disabledResult.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      allow: ["@elizaos/plugin-openai"],
      entries: {
        "app-log-viewer": { enabled: false },
      },
    });
  });

  it.each([
    [["relationships"], false],
    [["@elizaos/plugin-relationships"], true],
    [["relationships", "@elizaos/plugin-relationships"], true],
  ] as const)(
    "reports external Relationships activity independently of native features: %j",
    (names, active) => {
      const entry = {
        id: "relationships",
        name: "Relationships",
        npmName: "@elizaos/plugin-relationships",
        description: "",
        tags: [],
        kind: "feature",
        config: {},
        render: {},
        resources: {},
        version: "1.0.0",
      };
      mocks.loadRegistry.mockReturnValue({
        all: [entry],
        byId: new Map([[entry.id, entry]]),
      });
      const response = buildPluginListResponse({
        plugins: names.map((name) => ({ name })),
      } as never);
      expect(
        response.plugins.find((plugin) => plugin.id === "relationships"),
      ).toEqual(expect.objectContaining({ isActive: active }));
    },
  );

  it("does not mark a plugin active from unrelated loaded-name substrings", () => {
    const discordEntry = {
      id: "discord",
      name: "Discord",
      npmName: "@elizaos/plugin-discord",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "chat",
      config: {},
      render: {},
      resources: {},
      version: "1.0.0",
    };
    mocks.loadRegistry.mockReturnValue({
      all: [discordEntry],
      byId: new Map([["discord", discordEntry]]),
    });

    const response = buildPluginListResponse({
      plugins: [{ name: "my-discord-helper" }],
    } as never);

    expect(response.plugins.find((plugin) => plugin.id === "discord")).toEqual(
      expect.objectContaining({ isActive: false }),
    );
  });

  it("builds the plugin list once for GET /api/plugins", async () => {
    const discordEntry = {
      id: "discord",
      name: "Discord",
      npmName: "@elizaos/plugin-discord",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "chat",
      config: {},
      render: {},
      resources: {},
      version: "1.0.0",
    };
    mocks.loadRegistry.mockReturnValue({
      all: [discordEntry],
      byId: new Map([["discord", discordEntry]]),
    });

    const handled = await handlePluginsCompatRoutes(
      {
        method: "GET",
        url: "/api/plugins",
      } as never,
      {} as never,
      { current: null } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.loadRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        plugins: expect.arrayContaining([
          expect.objectContaining({ id: "discord" }),
        ]),
      }),
    );
  });

  function makeDiscordRegistryEntry() {
    return {
      id: "discord",
      name: "Discord",
      npmName: "@elizaos/plugin-discord",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "chat",
      config: {
        DISCORD_API_TOKEN: {
          type: "secret",
          label: "Bot token",
          required: true,
          sensitive: true,
        },
      },
      render: {},
      resources: {},
      version: "1.0.0",
    };
  }

  function useDiscordRegistry() {
    const discordEntry = makeDiscordRegistryEntry();
    mocks.loadRegistry.mockReturnValue({
      all: [discordEntry],
      byId: new Map([["discord", discordEntry]]),
    });
  }

  it("marks a required param set from runtime.getSetting without process.env", () => {
    useDiscordRegistry();

    const response = buildPluginListResponse({
      plugins: [],
      getSetting: (key: string) =>
        key === "DISCORD_API_TOKEN" ? "runtime-token" : undefined,
      getService: () => null,
    } as never);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord).toEqual(
      expect.objectContaining({ configured: true, validationErrors: [] }),
    );
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({ key: "DISCORD_API_TOKEN", isSet: true }),
    );
  });

  it("marks a required param set from the saved plugin entry config", () => {
    useDiscordRegistry();
    currentConfig = {
      env: {},
      plugins: {
        entries: {
          discord: {
            enabled: true,
            config: { DISCORD_API_TOKEN: "saved-token" },
          },
        },
      },
    };

    const response = buildPluginListResponse(null);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord).toEqual(expect.objectContaining({ configured: true }));
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({ key: "DISCORD_API_TOKEN", isSet: true }),
    );
  });

  it("keeps a live runtime miss unset even when process.env has the token", () => {
    useDiscordRegistry();
    process.env.DISCORD_API_TOKEN = "stale-host-token";

    const response = buildPluginListResponse({
      plugins: [],
      getSetting: () => null,
      getService: () => null,
    } as never);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({
        key: "DISCORD_API_TOKEN",
        isSet: false,
        currentValue: null,
      }),
    );
    expect(discord).toEqual(expect.objectContaining({ configured: false }));
    expect(discord?.validationErrors).toEqual([
      expect.objectContaining({ field: "DISCORD_API_TOKEN" }),
    ]);
  });

  it("keeps a live runtime miss unset even when config.env and the saved entry have tokens", () => {
    useDiscordRegistry();
    currentConfig = {
      env: { DISCORD_API_TOKEN: "stale-config-env-token" },
      plugins: {
        entries: {
          discord: {
            enabled: true,
            config: { DISCORD_API_TOKEN: "stale-saved-token" },
          },
        },
      },
    };

    const response = buildPluginListResponse({
      plugins: [],
      getSetting: () => null,
      getService: () => null,
    } as never);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({
        key: "DISCORD_API_TOKEN",
        isSet: false,
        currentValue: null,
      }),
    );
    expect(discord).toEqual(expect.objectContaining({ configured: false }));
  });

  it("reports a required param unset when no env, saved, or runtime value exists", () => {
    useDiscordRegistry();

    const response = buildPluginListResponse(null);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord).toEqual(expect.objectContaining({ configured: false }));
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({ isSet: false }),
    );
  });

  it("does not report a loaded plugin active when its service is unhealthy", () => {
    useDiscordRegistry();

    const response = buildPluginListResponse({
      plugins: [{ name: "@elizaos/plugin-discord" }],
      getSetting: (key: string) =>
        key === "DISCORD_API_TOKEN" ? "invalid-token" : undefined,
      getService: (name: string) =>
        name === "discord" ? { isHealthy: () => false } : null,
    } as never);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord).toEqual(
      expect.objectContaining({ configured: true, isActive: false }),
    );
    expect(discord?.validationWarnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("unhealthy"),
      }),
    ]);
  });

  it("reports a loaded plugin active when its service is healthy", () => {
    useDiscordRegistry();

    const response = buildPluginListResponse({
      plugins: [{ name: "@elizaos/plugin-discord" }],
      getSetting: (key: string) =>
        key === "DISCORD_API_TOKEN" ? "valid-token" : undefined,
      getService: (name: string) =>
        name === "discord" ? { isHealthy: () => true } : null,
    } as never);

    expect(response.plugins.find((plugin) => plugin.id === "discord")).toEqual(
      expect.objectContaining({
        configured: true,
        isActive: true,
        validationWarnings: [],
      }),
    );
  });

  it("keeps loaded-name activity for plugins without a health surface", () => {
    useDiscordRegistry();

    const response = buildPluginListResponse({
      plugins: [{ name: "@elizaos/plugin-discord" }],
      getSetting: () => undefined,
      getService: () => null,
    } as never);

    expect(response.plugins.find((plugin) => plugin.id === "discord")).toEqual(
      expect.objectContaining({ isActive: true }),
    );
  });

  it("reflects a save into catalog isSet while login failure stays inactive", () => {
    useDiscordRegistry();
    const runtimeSettings: Record<string, string> = {};

    const saveResult = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: "typo-token" } },
      makePlugin(),
    );
    expect(saveResult.status).toBe(200);
    // The settings bridge (#18718) folds the save into runtime.getSetting.
    runtimeSettings.DISCORD_API_TOKEN = "typo-token";
    currentConfig = clone(savedConfig ?? currentConfig);
    delete process.env.DISCORD_API_TOKEN;

    const response = buildPluginListResponse({
      plugins: [{ name: "@elizaos/plugin-discord" }],
      getSetting: (key: string) => runtimeSettings[key],
      getService: (name: string) =>
        name === "discord" ? { isHealthy: () => false } : null,
    } as never);

    const discord = response.plugins.find((plugin) => plugin.id === "discord");
    expect(discord?.parameters[0]).toEqual(
      expect.objectContaining({ isSet: true }),
    );
    expect(discord).toEqual(
      expect.objectContaining({ configured: true, isActive: false }),
    );
  });

  it("returns 422 from the test probe when the service reports unhealthy", async () => {
    const handled = await handlePluginsCompatRoutes(
      {
        method: "POST",
        url: "/api/plugins/discord/test",
      } as never,
      {} as never,
      {
        current: {
          plugins: [{ name: "@elizaos/plugin-discord" }],
          getSetting: () => undefined,
          getService: (name: string) =>
            name === "discord" ? { isHealthy: () => false } : null,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.sendJson).toHaveBeenCalledWith(
      expect.anything(),
      422,
      expect.objectContaining({ success: false, pluginId: "discord" }),
    );
  });

  it("returns success from the test probe when the service reports healthy", async () => {
    const handled = await handlePluginsCompatRoutes(
      {
        method: "POST",
        url: "/api/plugins/discord/test",
      } as never,
      {} as never,
      {
        current: {
          plugins: [{ name: "@elizaos/plugin-discord" }],
          getSetting: () => undefined,
          getService: (name: string) =>
            name === "discord" ? { isHealthy: () => true } : null,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.sendJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, pluginId: "discord" }),
    );
  });

  it("returns 400 instead of throwing on malformed encoded plugin path", async () => {
    const saveCallCount = mocks.saveElizaConfig.mock.calls.length;

    const handled = await handlePluginsCompatRoutes(
      {
        method: "PUT",
        url: "/api/plugins/%E0%A4%A",
      } as never,
      {} as never,
      { current: null } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.sendJsonError).toHaveBeenCalledWith(
      expect.anything(),
      400,
      "Invalid plugin path",
    );
    expect(mocks.saveElizaConfig).toHaveBeenCalledTimes(saveCallCount);
  });

  describe("POST /api/plugins/:id/reveal vault:// fallback", () => {
    async function reveal(key: string) {
      mocks.readCompatJsonBody.mockResolvedValue({ key });
      return handlePluginsCompatRoutes(
        { method: "POST", url: "/api/plugins/openai/reveal" } as never,
        {} as never,
        { current: null } as never,
      );
    }

    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
      currentConfig.env = { OPENAI_API_KEY: "vault://INNER_OPENAI" };
      mocks.vaultReveal.mockRejectedValue(new VaultMissError("OPENAI_API_KEY"));
    });

    it("answers 500 when the inner vault lookup fails for a reason other than a miss", async () => {
      mocks.vaultGet.mockRejectedValue(
        new Error("keychain locked: unlock the login keychain and retry"),
      );

      await expect(reveal("OPENAI_API_KEY")).resolves.toBe(true);

      expect(mocks.vaultGet).toHaveBeenCalledWith("INNER_OPENAI");
      expect(mocks.sendJson).not.toHaveBeenCalled();
      expect(mocks.sendJsonError).toHaveBeenCalledWith(
        expect.anything(),
        500,
        "Vault reveal failed",
      );
    });

    it("answers value: null when both the outer and the inner lookups miss", async () => {
      mocks.vaultGet.mockRejectedValue(new VaultMissError("INNER_OPENAI"));

      await expect(reveal("OPENAI_API_KEY")).resolves.toBe(true);

      expect(mocks.sendJsonError).not.toHaveBeenCalled();
      expect(mocks.sendJson).toHaveBeenCalledWith(expect.anything(), 200, {
        ok: true,
        value: null,
      });
    });

    it("answers the inner value when the vault:// fallback resolves", async () => {
      mocks.vaultGet.mockResolvedValue("sk-inner");

      await expect(reveal("OPENAI_API_KEY")).resolves.toBe(true);

      expect(mocks.sendJson).toHaveBeenCalledWith(expect.anything(), 200, {
        ok: true,
        value: "sk-inner",
      });
    });
  });
});
