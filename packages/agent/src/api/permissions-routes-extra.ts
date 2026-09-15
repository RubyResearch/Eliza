/**
 * Extra `/api/permissions` endpoints beyond the core native-permission set,
 * behind the dashboard control-API auth gate: GET/PUT `automation-mode`
 * (connectors-only vs full agent automation) and GET/PUT `trade-mode`
 * (user-sign-only / manual-local-key / agent-auto). Reads from and mutates the
 * persisted `ElizaConfig`, deriving execution-capability flags and persisting
 * mode changes through injected helpers so the handler stays transport-agnostic.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import type {
  AgentAutomationMode,
  ReadJsonBodyOptions,
  TradePermissionMode,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import type { LocalTradeExecutionOptions } from "./trade-safety.ts";

// AgentAutomationMode is canonical in @elizaos/shared (imported above).

export interface PermissionsExtraRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: {
    config: ElizaConfig;
    agentAutomationMode?: AgentAutomationMode;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  resolveTradePermissionMode: (config: ElizaConfig) => TradePermissionMode;
  canUseLocalTradeExecution: (
    mode: TradePermissionMode,
    isAgent: boolean,
    log?: (message: string) => void,
    options?: LocalTradeExecutionOptions,
  ) => boolean;
  parseAgentAutomationMode: (value: unknown) => AgentAutomationMode | null;
  persistAgentAutomationMode: (
    state: { config: ElizaConfig; agentAutomationMode?: AgentAutomationMode },
    mode: AgentAutomationMode,
  ) => void;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handlePermissionsExtraRoutes(
  ctx: PermissionsExtraRouteContext,
): Promise<boolean> {
  const { res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/permissions/automation-mode ──────────────────────────────
  if (method === "GET" && pathname === "/api/permissions/automation-mode") {
    const mode = state.agentAutomationMode ?? "full";
    json(res, {
      mode,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return true;
  }

  // ── PUT /api/permissions/automation-mode ──────────────────────────────
  if (method === "PUT" && pathname === "/api/permissions/automation-mode") {
    const body = await readJsonBody<{ mode?: unknown }>(ctx.req, res);
    if (!body) return true;
    const parsed = ctx.parseAgentAutomationMode(body.mode);
    if (!parsed) {
      error(res, 'Invalid mode. Expected "connectors-only" or "full".', 400);
      return true;
    }

    ctx.persistAgentAutomationMode(state, parsed);
    ctx.saveElizaConfig(state.config);

    json(res, {
      mode: parsed,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return true;
  }

  // ── GET /api/permissions/trade-mode ────────────────────────────────────
  if (method === "GET" && pathname === "/api/permissions/trade-mode") {
    const mode = ctx.resolveTradePermissionMode(state.config);
    json(res, {
      tradePermissionMode: mode,
      canUserLocalExecute: ctx.canUseLocalTradeExecution(mode, false),
      canAgentAutoTrade: ctx.canUseLocalTradeExecution(mode, true, undefined, {
        consumeAgentQuota: false,
      }),
    });
    return true;
  }

  // ── PUT /api/permissions/trade-mode ────────────────────────────────────
  if (method === "PUT" && pathname === "/api/permissions/trade-mode") {
    const body = await readJsonBody<{ mode?: string }>(ctx.req, res);
    if (!body) return true;

    const newMode = body.mode;
    if (
      newMode !== "user-sign-only" &&
      newMode !== "manual-local-key" &&
      newMode !== "agent-auto"
    ) {
      error(
        res,
        'mode must be "user-sign-only", "manual-local-key", or "agent-auto"',
        400,
      );
      return true;
    }

    const previousFeatures = state.config.features;
    if (!state.config.features) {
      state.config.features = {};
    }
    const features = state.config.features as Record<string, unknown>;
    const hadPreviousMode = Object.hasOwn(features, "tradePermissionMode");
    const previousMode = features.tradePermissionMode;
    features.tradePermissionMode = newMode;

    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      // error-policy:J1 boundary translation — the in-memory mode is rolled
      // back to the persisted value so a failed write cannot leave the process
      // trading under a mode that disappears on restart; the client gets a
      // structured 500 rather than `ok: true`.
      if (previousFeatures === undefined) {
        delete state.config.features;
      } else if (!hadPreviousMode) {
        delete features.tradePermissionMode;
      } else {
        features.tradePermissionMode = previousMode;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[api] Trade-mode config save failed; mode left at the persisted value: ${message}`,
      );
      error(res, `Failed to save trade permission mode: ${message}`, 500);
      return true;
    }

    json(res, {
      ok: true,
      tradePermissionMode: newMode,
      canUserLocalExecute: ctx.canUseLocalTradeExecution(newMode, false),
      canAgentAutoTrade: ctx.canUseLocalTradeExecution(
        newMode,
        true,
        undefined,
        { consumeAgentQuota: false },
      ),
    });
    return true;
  }

  return false;
}
