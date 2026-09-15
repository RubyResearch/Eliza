/**
 * Exercises the additional permissions route dispatcher against deterministic
 * configuration state and injected persistence/capability collaborators. The
 * suite drives the real handler without starting an HTTP server.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  handlePermissionsExtraRoutes,
  type PermissionsExtraRouteContext,
} from "./permissions-routes-extra.ts";

function makeContext(
  method: string,
  pathname: string,
  options: {
    config?: ElizaConfig;
    agentAutomationMode?: "connectors-only" | "full";
    body?: object | null;
  } = {},
) {
  const json = vi.fn<PermissionsExtraRouteContext["json"]>();
  const error = vi.fn<PermissionsExtraRouteContext["error"]>();
  const readJsonBody: PermissionsExtraRouteContext["readJsonBody"] = async <
    T extends object,
  >() => (options.body ?? null) as T | null;
  const saveElizaConfig =
    vi.fn<PermissionsExtraRouteContext["saveElizaConfig"]>();
  const resolveTradePermissionMode =
    vi.fn<PermissionsExtraRouteContext["resolveTradePermissionMode"]>();
  const canUseLocalTradeExecution =
    vi.fn<PermissionsExtraRouteContext["canUseLocalTradeExecution"]>();
  const parseAgentAutomationMode =
    vi.fn<PermissionsExtraRouteContext["parseAgentAutomationMode"]>();
  const persistAgentAutomationMode =
    vi.fn<PermissionsExtraRouteContext["persistAgentAutomationMode"]>();
  const state: PermissionsExtraRouteContext["state"] = {
    config: options.config ?? ({} as ElizaConfig),
    agentAutomationMode: options.agentAutomationMode,
  };
  const ctx: PermissionsExtraRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    state,
    json,
    error,
    readJsonBody,
    saveElizaConfig,
    resolveTradePermissionMode,
    canUseLocalTradeExecution,
    parseAgentAutomationMode,
    persistAgentAutomationMode,
  };

  return {
    ctx,
    state,
    json,
    error,
    readJsonBody,
    saveElizaConfig,
    resolveTradePermissionMode,
    canUseLocalTradeExecution,
    parseAgentAutomationMode,
    persistAgentAutomationMode,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handlePermissionsExtraRoutes dispatch", () => {
  it("does not claim unrelated paths or unsupported methods", async () => {
    const unrelated = makeContext("GET", "/api/permissions/unknown");
    const wrongMethod = makeContext("POST", "/api/permissions/automation-mode");

    await expect(handlePermissionsExtraRoutes(unrelated.ctx)).resolves.toBe(
      false,
    );
    await expect(handlePermissionsExtraRoutes(wrongMethod.ctx)).resolves.toBe(
      false,
    );
    expect(unrelated.json).not.toHaveBeenCalled();
    expect(wrongMethod.json).not.toHaveBeenCalled();
  });
});

describe("handlePermissionsExtraRoutes automation mode", () => {
  it.each([
    [undefined, "full"],
    ["connectors-only" as const, "connectors-only"],
  ])("reports configured mode %s as %s", async (configured, expected) => {
    const { ctx, json } = makeContext(
      "GET",
      "/api/permissions/automation-mode",
      { agentAutomationMode: configured },
    );

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      mode: expected,
      options: ["connectors-only", "full"],
    });
  });

  it("stops after the body reader handles an invalid request", async () => {
    const { ctx, json, error, parseAgentAutomationMode } = makeContext(
      "PUT",
      "/api/permissions/automation-mode",
    );

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(parseAgentAutomationMode).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized automation mode", async () => {
    const { ctx, error, saveElizaConfig, parseAgentAutomationMode } =
      makeContext("PUT", "/api/permissions/automation-mode", {
        body: { mode: "unattended" },
      });
    parseAgentAutomationMode.mockReturnValue(null);

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(parseAgentAutomationMode).toHaveBeenCalledWith("unattended");
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'Invalid mode. Expected "connectors-only" or "full".',
      400,
    );
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("persists and returns a recognized automation mode", async () => {
    const {
      ctx,
      state,
      json,
      saveElizaConfig,
      parseAgentAutomationMode,
      persistAgentAutomationMode,
    } = makeContext("PUT", "/api/permissions/automation-mode", {
      body: { mode: "connectors-only" },
    });
    parseAgentAutomationMode.mockReturnValue("connectors-only");

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(persistAgentAutomationMode).toHaveBeenCalledWith(
      state,
      "connectors-only",
    );
    expect(saveElizaConfig).toHaveBeenCalledWith(state.config);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      mode: "connectors-only",
      options: ["connectors-only", "full"],
    });
  });
});

describe("handlePermissionsExtraRoutes trade mode", () => {
  it("reports the resolved mode and non-consuming execution capabilities", async () => {
    const { ctx, json, resolveTradePermissionMode, canUseLocalTradeExecution } =
      makeContext("GET", "/api/permissions/trade-mode");
    resolveTradePermissionMode.mockReturnValue("agent-auto");
    canUseLocalTradeExecution.mockImplementation((_mode, isAgent) => isAgent);

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(resolveTradePermissionMode).toHaveBeenCalledWith(ctx.state.config);
    expect(canUseLocalTradeExecution).toHaveBeenNthCalledWith(
      1,
      "agent-auto",
      false,
    );
    expect(canUseLocalTradeExecution).toHaveBeenNthCalledWith(
      2,
      "agent-auto",
      true,
      undefined,
      { consumeAgentQuota: false },
    );
    expect(json).toHaveBeenCalledWith(ctx.res, {
      tradePermissionMode: "agent-auto",
      canUserLocalExecute: false,
      canAgentAutoTrade: true,
    });
  });

  it("stops after the body reader handles an invalid trade request", async () => {
    const { ctx, json, error, saveElizaConfig } = makeContext(
      "PUT",
      "/api/permissions/trade-mode",
    );

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "full", "AGENT-AUTO"])(
    "rejects invalid trade mode %s",
    async (mode) => {
      const { ctx, error, saveElizaConfig } = makeContext(
        "PUT",
        "/api/permissions/trade-mode",
        { body: { mode } },
      );

      await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'mode must be "user-sign-only", "manual-local-key", or "agent-auto"',
        400,
      );
      expect(saveElizaConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["user-sign-only", "manual-local-key", "agent-auto"] as const)(
    "stores and reports allowed trade mode %s",
    async (mode) => {
      const config = {} as ElizaConfig;
      const { ctx, json, saveElizaConfig, canUseLocalTradeExecution } =
        makeContext("PUT", "/api/permissions/trade-mode", {
          config,
          body: { mode },
        });
      canUseLocalTradeExecution.mockImplementation(
        (candidate, isAgent) => candidate === mode && isAgent,
      );

      await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

      expect(config.features).toEqual({ tradePermissionMode: mode });
      expect(saveElizaConfig).toHaveBeenCalledWith(config);
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        tradePermissionMode: mode,
        canUserLocalExecute: false,
        canAgentAutoTrade: true,
      });
      expect(canUseLocalTradeExecution).toHaveBeenNthCalledWith(
        2,
        mode,
        true,
        undefined,
        {
          consumeAgentQuota: false,
        },
      );
    },
  );

  it("preserves existing feature configuration when updating trade mode", async () => {
    const config = {
      features: { trustedLocal: true, tradePermissionMode: "user-sign-only" },
    } as unknown as ElizaConfig;
    const { ctx } = makeContext("PUT", "/api/permissions/trade-mode", {
      config,
      body: { mode: "manual-local-key" },
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(config.features).toEqual({
      trustedLocal: true,
      tradePermissionMode: "manual-local-key",
    });
  });

  it("answers 500 and rolls the mode back when persistence throws", async () => {
    const logError = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    const { ctx, json, error, state, saveElizaConfig } = makeContext(
      "PUT",
      "/api/permissions/trade-mode",
      {
        body: { mode: "agent-auto" },
        config: {
          features: { tradePermissionMode: "user-sign-only" },
        } as unknown as ElizaConfig,
      },
    );
    saveElizaConfig.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(logError).toHaveBeenCalledWith(
      "[api] Trade-mode config save failed; mode left at the persisted value: disk full",
    );
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to save trade permission mode: disk full",
      500,
    );
    expect(json).not.toHaveBeenCalled();
    expect(state.config.features).toEqual({
      tradePermissionMode: "user-sign-only",
    });
  });
});
