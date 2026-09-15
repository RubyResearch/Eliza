/**
 * Supplementary coverage for `handlePermissionsExtraRoutes` where the merged
 * dispatcher suite uses mocked collaborators: the automation-mode parse and
 * persist helpers and the trade-mode capability flags are driven through the
 * real production logic (`server.ts`-faithful mirrors plus the real
 * `canUseLocalTradeExecution` gate), including the read-only exhausted-quota
 * path. Deterministic in-memory context: no live HTTP, no live model.
 */
import type { AgentAutomationMode, TradePermissionMode } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  handlePermissionsExtraRoutes,
  type PermissionsExtraRouteContext,
} from "./permissions-routes-extra.ts";
import {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
} from "./trade-safety.ts";

const AGENT_AUTOMATION_MODES = new Set<AgentAutomationMode>([
  "connectors-only",
  "full",
]);

/** Mirrors `parseAgentAutomationMode` in `server.ts` (not exported). */
function parseAgentAutomationMode(value: unknown): AgentAutomationMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!AGENT_AUTOMATION_MODES.has(normalized as AgentAutomationMode)) {
    return null;
  }
  return normalized as AgentAutomationMode;
}

/** Mirrors `persistAgentAutomationMode` in `server.ts` (not exported). */
function persistAgentAutomationMode(
  state: { config: ElizaConfig; agentAutomationMode?: AgentAutomationMode },
  mode: AgentAutomationMode,
): void {
  state.agentAutomationMode = mode;
  if (!state.config.features) {
    state.config.features = {};
  }

  const features = state.config.features as Record<
    string,
    boolean | { enabled?: boolean; [k: string]: unknown }
  >;
  const current = features.agentAutomation;
  const currentObject =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};

  features.agentAutomation = {
    ...currentObject,
    enabled: true,
    mode,
  };
}

/** Mirrors `resolveTradePermissionMode` in `server.ts`. */
function resolveTradePermissionMode(config: ElizaConfig): TradePermissionMode {
  const raw = (config.features as Record<string, unknown> | undefined)
    ?.tradePermissionMode;
  if (
    raw === "user-sign-only" ||
    raw === "manual-local-key" ||
    raw === "agent-auto"
  ) {
    return raw;
  }
  return "user-sign-only";
}

type TestFeatures = Record<string, unknown>;

function makeConfig(features?: TestFeatures): ElizaConfig {
  return (features ? { features } : {}) as ElizaConfig;
}

function resetTradeQuota(resetDate = "", count = 0): void {
  agentAutoDailyTrades.count = count;
  agentAutoDailyTrades.resetDate = resetDate;
}

function makeContext(
  pathname: string,
  options: {
    method?: string;
    body?: Record<string, unknown> | null;
    config?: ElizaConfig;
    agentAutomationMode?: AgentAutomationMode;
    saveElizaConfig?: (config: ElizaConfig) => void;
  } = {},
): PermissionsExtraRouteContext & {
  captured: { data?: unknown; status?: number; errorMessage?: string };
} {
  const captured: {
    data?: unknown;
    status?: number;
    errorMessage?: string;
  } = {};
  const state: PermissionsExtraRouteContext["state"] = {
    config: options.config ?? makeConfig(),
    ...(options.agentAutomationMode !== undefined
      ? { agentAutomationMode: options.agentAutomationMode }
      : {}),
  };
  const saveElizaConfig =
    options.saveElizaConfig ?? vi.fn((_config: ElizaConfig) => undefined);

  return {
    req: {} as PermissionsExtraRouteContext["req"],
    res: {} as PermissionsExtraRouteContext["res"],
    method: options.method ?? "GET",
    pathname,
    state,
    json: vi.fn((_res, data, status) => {
      captured.data = data;
      captured.status = status;
    }),
    error: vi.fn((_res, message, status) => {
      captured.errorMessage = message;
      captured.status = status;
    }),
    readJsonBody: async <T extends object>() => {
      if (options.body === undefined) return null;
      return options.body as T;
    },
    saveElizaConfig,
    resolveTradePermissionMode,
    canUseLocalTradeExecution,
    parseAgentAutomationMode,
    persistAgentAutomationMode,
    captured,
  };
}

beforeEach(() => {
  resetTradeQuota();
});

afterEach(() => {
  resetTradeQuota();
});

describe("permissions-routes-extra — real trade capability gate", () => {
  it("reports both execution flags off for the unset-config user-sign-only fallback", async () => {
    const ctx = makeContext("/api/permissions/trade-mode");

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      tradePermissionMode: "user-sign-only",
      canUserLocalExecute: false,
      canAgentAutoTrade: false,
    });
  });

  it("permits local user execution but not agent auto-trade in manual-local-key", async () => {
    const ctx = makeContext("/api/permissions/trade-mode", {
      config: makeConfig({ tradePermissionMode: "manual-local-key" }),
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      tradePermissionMode: "manual-local-key",
      canUserLocalExecute: true,
      canAgentAutoTrade: false,
    });
  });

  it("permits both capabilities in agent-auto without consuming daily quota", async () => {
    const ctx = makeContext("/api/permissions/trade-mode", {
      config: makeConfig({ tradePermissionMode: "agent-auto" }),
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      tradePermissionMode: "agent-auto",
      canUserLocalExecute: true,
      canAgentAutoTrade: true,
    });
    expect(agentAutoDailyTrades.count).toBe(0);
    expect(agentAutoDailyTrades.resetDate).toBe("");
  });

  it("reads a falsy canAgentAutoTrade when the daily quota is exhausted and records nothing", async () => {
    resetTradeQuota(getAgentAutoTradeDate(), AGENT_AUTO_MAX_DAILY_TRADES);
    const ctx = makeContext("/api/permissions/trade-mode", {
      config: makeConfig({ tradePermissionMode: "agent-auto" }),
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      tradePermissionMode: "agent-auto",
      canUserLocalExecute: true,
      canAgentAutoTrade: false,
    });
    expect(agentAutoDailyTrades.count).toBe(AGENT_AUTO_MAX_DAILY_TRADES);
  });

  it("treats an unrecognized stored trade mode as user-sign-only with flags off", async () => {
    const ctx = makeContext("/api/permissions/trade-mode", {
      config: makeConfig({ tradePermissionMode: "disabled" }),
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      tradePermissionMode: "user-sign-only",
      canUserLocalExecute: false,
      canAgentAutoTrade: false,
    });
  });
});

describe("permissions-routes-extra — real automation parse and persistence", () => {
  it("reports an explicitly persisted full mode verbatim instead of coalescing it", async () => {
    const ctx = makeContext("/api/permissions/automation-mode", {
      agentAutomationMode: "full",
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual({
      mode: "full",
      options: ["connectors-only", "full"],
    });
  });

  it("normalizes a trimmed case-folded mode before persisting and echoing it", async () => {
    const saveElizaConfig = vi.fn();
    const ctx = makeContext("/api/permissions/automation-mode", {
      method: "PUT",
      body: { mode: "  FULL  " },
      saveElizaConfig,
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.state.agentAutomationMode).toBe("full");
    expect(ctx.captured.data).toEqual({
      mode: "full",
      options: ["connectors-only", "full"],
    });
    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects semi-auto and non-string modes through the real parser without mutating state or config", async () => {
    for (const badMode of ["semi-auto", 1, null]) {
      const saveElizaConfig = vi.fn();
      const ctx = makeContext("/api/permissions/automation-mode", {
        method: "PUT",
        body: { mode: badMode },
        saveElizaConfig,
      });

      await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

      expect(ctx.captured.status).toBe(400);
      expect(ctx.captured.errorMessage).toBe(
        'Invalid mode. Expected "connectors-only" or "full".',
      );
      expect(ctx.state.agentAutomationMode).toBeUndefined();
      expect(ctx.state.config.features).toBeUndefined();
      expect(saveElizaConfig).not.toHaveBeenCalled();
    }
  });

  it("merges the persisted mode into an existing agentAutomation feature object keeping sibling keys", async () => {
    const saveElizaConfig = vi.fn();
    const ctx = makeContext("/api/permissions/automation-mode", {
      method: "PUT",
      body: { mode: "connectors-only" },
      config: makeConfig({
        agentAutomation: { enabled: false, note: "keep-me" },
        other: true,
      }),
      saveElizaConfig,
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.state.config.features as Record<string, unknown>).toEqual({
      agentAutomation: {
        enabled: true,
        note: "keep-me",
        mode: "connectors-only",
      },
      other: true,
    });
    expect(ctx.state.agentAutomationMode).toBe("connectors-only");
  });

  it("persists the automation feature object before saving the config", async () => {
    const featuresAtSave: Array<Record<string, unknown> | undefined> = [];
    const saveElizaConfig = vi.fn((config: ElizaConfig) => {
      featuresAtSave.push(
        config.features as Record<string, unknown> | undefined,
      );
    });
    const ctx = makeContext("/api/permissions/automation-mode", {
      method: "PUT",
      body: { mode: "connectors-only" },
      saveElizaConfig,
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(featuresAtSave).toHaveLength(1);
    expect(featuresAtSave[0]?.agentAutomation).toEqual({
      enabled: true,
      mode: "connectors-only",
    });
  });
});

describe("permissions-routes-extra — trade-mode persistence failure", () => {
  it("rolls the trade mode back and answers 500 when the config write fails", async () => {
    const saveElizaConfig = vi.fn((_config: ElizaConfig) => {
      throw new Error("EACCES: permission denied, open 'config.json'");
    });
    const ctx = makeContext("/api/permissions/trade-mode", {
      method: "PUT",
      body: { mode: "user-sign-only" },
      config: makeConfig({ tradePermissionMode: "agent-auto", other: true }),
      saveElizaConfig,
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(saveElizaConfig).toHaveBeenCalledTimes(1);
    expect(ctx.captured.status).toBe(500);
    expect(ctx.captured.errorMessage).toContain("EACCES");
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.state.config.features).toEqual({
      tradePermissionMode: "agent-auto",
      other: true,
    });
    expect(resolveTradePermissionMode(ctx.state.config)).toBe("agent-auto");
  });

  it("removes a features object it created when the first-ever trade-mode write fails", async () => {
    const saveElizaConfig = vi.fn((_config: ElizaConfig) => {
      throw new Error("ENOSPC: no space left on device");
    });
    const ctx = makeContext("/api/permissions/trade-mode", {
      method: "PUT",
      body: { mode: "agent-auto" },
      saveElizaConfig,
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.status).toBe(500);
    expect(ctx.captured.errorMessage).toContain("ENOSPC");
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.state.config.features).toBeUndefined();
    expect(resolveTradePermissionMode(ctx.state.config)).toBe("user-sign-only");
  });
});

describe("permissions-routes-extra — strict route matching", () => {
  it("does not claim a trailing-slash variant of either known path", async () => {
    const auto = makeContext("/api/permissions/automation-mode/");
    const trade = makeContext("/api/permissions/trade-mode/", {
      method: "PUT",
      body: { mode: "agent-auto" },
    });

    await expect(handlePermissionsExtraRoutes(auto)).resolves.toBe(false);
    await expect(handlePermissionsExtraRoutes(trade)).resolves.toBe(false);

    expect(auto.json).not.toHaveBeenCalled();
    expect(auto.error).not.toHaveBeenCalled();
    expect(trade.json).not.toHaveBeenCalled();
    expect(trade.error).not.toHaveBeenCalled();
  });
});
