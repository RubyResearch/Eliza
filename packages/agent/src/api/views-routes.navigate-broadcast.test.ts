/**
 * Server half of the agent view-switch contract: POST /api/views/:id/navigate
 * resolves a view (builtin registry, body path override, or synthetic ids) and
 * broadcasts the shell navigate-view WS frame, threading action/alwaysOnTop/
 * subview/split-layout fields, recording current-view state, and stamping a
 * turn-scoped switch-freshness marker; also covers view:event broadcasts after a
 * server-backed interact. Focused route unit tests with real body parsing — no
 * PGLite, runtime, or LLM.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { SHELL_NAVIGATE_VIEW_WS_EVENT } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  type CurrentViewState,
  clearCurrentViewState,
  getCurrentViewState,
  handleViewsRoutes,
  isViewSwitchFresh,
  VIEW_SWITCH_FRESH_MS,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Server half of the agent view-switch contract. When the VIEWS action (or any
// caller) hits POST /api/views/:id/navigate, the route must broadcast a
// `SHELL_NAVIGATE_VIEW_WS_EVENT` WebSocket frame. The frontend half — that this exact
// frame normalizes into an `eliza:navigate:view` DOM event — is covered by
// packages/ui/src/state/startup-phase-hydrate.navigate-frame.test.ts. Together
// they pin the wire contract end to end without the scenario harness.
//
// This is a focused route unit test: real request body parsing, no PGLite, no
// runtime, no LLM. The agent-turn → action → navigate path (real AgentRuntime)
// is exercised by packages/scenario-runner/test/scenarios/
// deterministic-view-switching.scenario.ts.

type NavigateBody = Record<string, unknown>;

function makeNavigateCtx(
  id: string,
  body: NavigateBody | null,
  search = "",
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
  broadcastWsToClientId: ReturnType<typeof vi.fn>;
} {
  // `readJsonBody` reads the request as a Node stream; Readable.from yields the
  // JSON exactly as an inbound HTTP request body would.
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  req.headers = {};
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const broadcastWsToClientId = vi.fn(() => 1);
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs,
    broadcastWsToClientId,
  };
  return { ctx, json, error, broadcastWs, broadcastWsToClientId };
}

function makeInteractCtx(
  id: string,
  body: NavigateBody | null,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const pathname = `/api/views/${encodeURIComponent(id)}/interact`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs,
  };
  return { ctx, json, error, broadcastWs };
}

describe("POST /api/views/:id/navigate broadcast contract", () => {
  beforeEach(() => {
    registerBuiltinViews();
    clearCurrentViewState();
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews("@test/views-route");
    vi.restoreAllMocks();
  });

  it("broadcasts a registered view's resolved frame and echoes it in the response", async () => {
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // Resolved from the builtin registry (id "settings" → /settings, "Settings").
    expect(broadcastWs).toHaveBeenCalledTimes(1);
    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      source: "agent",
    });
    // No action / alwaysOnTop keys when the body omits them.
    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("action" in frame).toBe(false);
    expect("alwaysOnTop" in frame).toBe(false);

    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        viewPath: "/settings",
        viewType: "gui",
      }),
    );
  });

  it("keeps originating-client navigation out of global state and unrelated shells", async () => {
    const { ctx, json, broadcastWs } = makeNavigateCtx("notes", {
      delivery: "originating-client",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).not.toHaveBeenCalled();
    expect(getCurrentViewState()).toBeNull();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true, viewId: "notes" }),
    );
  });

  it("delivers voice navigation to its known renderer before dependent view actions", async () => {
    const { ctx, json, broadcastWs, broadcastWsToClientId } = makeNavigateCtx(
      "notes",
      {
        delivery: "originating-client",
        clientId: "speaking-seeker",
      },
    );
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(broadcastWs).not.toHaveBeenCalled();
    expect(broadcastWsToClientId).toHaveBeenCalledWith(
      "speaking-seeker",
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "notes",
      }),
    );
    expect(broadcastWsToClientId.mock.invocationCallOrder[0]).toBeLessThan(
      json.mock.invocationCallOrder[0],
    );
    expect(getCurrentViewState()).toMatchObject({ viewId: "notes" });
  });

  it("rejects voice navigation to a disconnected renderer without global fallback", async () => {
    const { ctx, json, error, broadcastWs, broadcastWsToClientId } =
      makeNavigateCtx("notes", {
        delivery: "originating-client",
        clientId: "disconnected-seeker",
      });
    broadcastWsToClientId.mockReturnValue(0);
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(broadcastWs).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("No connected view client"),
      409,
    );
    expect(getCurrentViewState()).toBeNull();
  });

  it("best-effort delivers completed-action navigation before its acknowledgement", async () => {
    const { ctx, json, broadcastWs, broadcastWsToClientId } = makeNavigateCtx(
      "calendar",
      {
        clientId: "seeker-rest-client",
        delivery: "completed-action",
      },
    );
    broadcastWsToClientId.mockReturnValue(0);

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).not.toHaveBeenCalled();
    expect(broadcastWsToClientId).toHaveBeenCalledWith(
      "seeker-rest-client",
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "calendar",
        viewPath: null,
      }),
    );
    expect(getCurrentViewState()).toMatchObject({
      viewId: "calendar",
      viewPath: null,
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "calendar",
        completedActionDelivered: false,
      }),
    );
  });

  it("reports when the originating renderer accepted completed-action delivery", async () => {
    const { ctx, json, broadcastWsToClientId } = makeNavigateCtx("calendar", {
      clientId: "seeker-rest-client",
      delivery: "completed-action",
      completedActionHandoffId: "handoff-1234",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWsToClientId).toHaveBeenCalledTimes(1);
    expect(broadcastWsToClientId).toHaveBeenCalledWith(
      "seeker-rest-client",
      expect.objectContaining({ completedActionHandoffId: "handoff-1234" }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        completedActionDelivered: true,
        completedActionHandoffId: "handoff-1234",
      }),
    );
    expect(broadcastWsToClientId.mock.invocationCallOrder[0]).toBeLessThan(
      json.mock.invocationCallOrder[0],
    );
  });

  it("drops an invalid completed-action handoff id at the HTTP boundary", async () => {
    const { ctx, json, broadcastWsToClientId } = makeNavigateCtx("calendar", {
      clientId: "seeker-rest-client",
      delivery: "completed-action",
      completedActionHandoffId: "not valid because spaces",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const frame = broadcastWsToClientId.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(frame).not.toHaveProperty("completedActionHandoffId");
    const response = json.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(response).not.toHaveProperty("completedActionHandoffId");
  });

  it("keeps the completed-action fallback when targeted delivery throws", async () => {
    const { ctx, json, error, broadcastWs, broadcastWsToClientId } =
      makeNavigateCtx("notes", {
        clientId: "closing-rest-client",
        delivery: "completed-action",
      });
    broadcastWsToClientId.mockImplementation(() => {
      throw new Error("socket closed during targeted send");
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "notes",
        completedActionDelivered: false,
      }),
    );
    expect(getCurrentViewState()).toMatchObject({
      viewId: "notes",
      viewPath: null,
    });
  });

  it("does not let concurrent caller-owned Browser paths overwrite shared state", async () => {
    const shared = makeNavigateCtx("settings", {});
    await expect(handleViewsRoutes(shared.ctx)).resolves.toBe(true);

    const first = makeNavigateCtx("browser", {
      clientId: "client-one",
      delivery: "completed-action",
      completedActionHandoffId: "handoff-one",
      path: "/browser?browse=https%3A%2F%2Fone.example%2Fprivate",
    });
    const second = makeNavigateCtx("browser", {
      clientId: "client-two",
      delivery: "completed-action",
      completedActionHandoffId: "handoff-two",
      path: "/browser?browse=https%3A%2F%2Ftwo.example%2Fprivate",
    });

    await Promise.all([
      handleViewsRoutes(first.ctx),
      handleViewsRoutes(second.ctx),
    ]);

    expect(first.broadcastWsToClientId).toHaveBeenCalledWith(
      "client-one",
      expect.objectContaining({
        viewPath: "/browser?browse=https%3A%2F%2Fone.example%2Fprivate",
      }),
    );
    expect(second.broadcastWsToClientId).toHaveBeenCalledWith(
      "client-two",
      expect.objectContaining({
        viewPath: "/browser?browse=https%3A%2F%2Ftwo.example%2Fprivate",
      }),
    );
    expect(getCurrentViewState()).toMatchObject({
      viewId: "browser",
      viewPath: "/browser",
    });
    expect(JSON.stringify(getCurrentViewState())).not.toContain("one.example");
    expect(JSON.stringify(getCurrentViewState())).not.toContain("two.example");
  });

  it("delivers app-chat navigation only to its originating client", async () => {
    const { ctx, broadcastWs, broadcastWsToClientId } = makeNavigateCtx(
      "browser",
      { clientId: "seeker-client" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).not.toHaveBeenCalled();
    expect(broadcastWsToClientId).toHaveBeenCalledWith(
      "seeker-client",
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "browser",
        viewPath: "/browser",
      }),
    );
  });

  it("includes action and alwaysOnTop in the frame only when present in the body", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: "pin-tab",
      alwaysOnTop: true,
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      source: "agent",
      action: "pin-tab",
      alwaysOnTop: true,
    });
  });

  it("carries opaque deep-link payloads to the shell frame and response", async () => {
    const payload = { permissionRequest: { permission: "microphone" } };
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {
      path: "/settings",
      subview: "permissions",
      payload,
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      source: "agent",
      subview: "permissions",
      payload,
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        subview: "permissions",
        payload,
      }),
    );
  });

  it("broadcasts close actions without requiring a navigation path consumer", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: "close",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      source: "agent",
      action: "close",
    });
  });

  it("broadcasts split and tile layout metadata to the shell", async () => {
    const { ctx, broadcastWs, json } = makeNavigateCtx("notes", {
      action: "split-view",
      views: ["notes", "calendar"],
      layout: "horizontal",
      placement: "right",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "notes",
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );
  });

  it("drops a non-boolean alwaysOnTop and a non-string action", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: 7,
      alwaysOnTop: "true",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("action" in frame).toBe(false);
    expect("alwaysOnTop" in frame).toBe(false);
  });

  it("honors a body path override and falls back to the id as the label", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("ghost-view", {
      path: "/apps/ghost-view",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "ghost-view",
      viewPath: "/apps/ghost-view",
      viewLabel: "ghost-view",
      viewType: "gui",
      source: "agent",
    });
  });

  it("routes the synthetic __view-manager__ id to the /apps tab", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("__view-manager__", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "__view-manager__",
        viewPath: "/apps",
        viewType: "gui",
      }),
    );
  });

  it("broadcasts generic view update events after server-backed interactions", async () => {
    await registerPluginViews(
      {
        name: "@test/views-route",
        description: "Synthetic view route test plugin.",
        views: [
          {
            id: "scratchpad",
            label: "Scratchpad",
            path: "/scratchpad",
            capabilities: [{ id: "get-state", description: "Read state." }],
            serverInteract: async () => ({
              success: true,
              text: "Read scratchpad state.",
            }),
          },
        ],
      },
      process.cwd(),
    );
    const { ctx, json, broadcastWs } = makeInteractCtx("scratchpad", {
      capability: "get-state",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "view:scratchpad:updated",
      payload: { viewId: "scratchpad", capability: "get-state" },
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          text: "Read scratchpad state.",
        }),
      }),
    );
  });

  it("uses the request viewType for an unregistered id from the query param", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx(
      "spatial-room",
      { path: "/apps/spatial-room" },
      "?viewType=xr",
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: "spatial-room",
        viewPath: "/apps/spatial-room",
        viewType: "xr",
      }),
    );
  });

  it("records the navigated view as the current view state", async () => {
    const { ctx } = makeNavigateCtx("settings", { action: "pin-tab" });

    await handleViewsRoutes(ctx);

    const state = getCurrentViewState();
    expect(state?.viewId).toBe("settings");
    expect(state?.viewPath).toBe("/settings");
    expect(state?.viewType).toBe("gui");
    expect(state?.action).toBe("pin-tab");
  });

  // ── #9945: settings subview deep-linking ──────────────────────────────────

  it("threads a body subview into the frame, response, and current state", async () => {
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {
      subview: "voice",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        subview: "voice",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        subview: "voice",
      }),
    );
    expect(getCurrentViewState()?.subview).toBe("voice");
  });

  it("accepts `section` as an alias for `subview`", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      section: "connectors",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ viewId: "settings", subview: "connectors" }),
    );
  });

  it("omits subview from the frame when the body has none", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("subview" in frame).toBe(false);
  });

  // ── #8788: turn-scoped "view switch just happened" stamp ──────────────────

  function makeCurrentCtx(): {
    ctx: ViewsRouteContext;
    json: ReturnType<typeof vi.fn>;
  } {
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const json = vi.fn();
    const pathname = "/api/views/current";
    const ctx: ViewsRouteContext = {
      req,
      res,
      method: "GET",
      pathname,
      url: new URL(`http://local${pathname}`),
      json,
      error: vi.fn(),
      broadcastWs: vi.fn(),
    };
    return { ctx, json };
  }

  it("stamps switchedAt + source=agent on navigate and reports justSwitched via GET current", async () => {
    const nav = makeNavigateCtx("settings", {});
    await handleViewsRoutes(nav.ctx);

    const state = getCurrentViewState();
    expect(typeof state?.switchedAt).toBe("string");
    expect(state?.source).toBe("agent");
    expect(isViewSwitchFresh(state)).toBe(true);

    const cur = makeCurrentCtx();
    await handleViewsRoutes(cur.ctx);
    expect(cur.json).toHaveBeenCalledWith(
      cur.ctx.res,
      expect.objectContaining({
        currentView: expect.objectContaining({ viewId: "settings" }),
        justSwitched: true,
      }),
    );
  });

  it("marks source=user and skips the shell echo for a user-reported switch", async () => {
    const nav = makeNavigateCtx("settings", { source: "user" });
    await handleViewsRoutes(nav.ctx);
    // State is recorded (so the agent observes the user's manual switch)...
    expect(getCurrentViewState()?.source).toBe("user");
    // ...but the shell:navigate:view echo is suppressed (the client already
    // navigated locally — re-broadcasting would loop).
    expect(nav.broadcastWs).not.toHaveBeenCalled();
  });

  it("does not re-stamp switchedAt when re-navigating to the same view", async () => {
    // Fake timers so each navigate gets a distinct, controlled timestamp
    // (real wall-clock resolution can collapse sub-millisecond navigates).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const first = makeNavigateCtx("settings", {});
      await handleViewsRoutes(first.ctx);
      const switchedAt = getCurrentViewState()?.switchedAt;
      expect(switchedAt).toBe("2026-01-01T00:00:00.000Z");

      // Re-navigate to the SAME view: updatedAt moves but switchedAt is preserved.
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      const second = makeNavigateCtx("settings", { action: "pin-tab" });
      await handleViewsRoutes(second.ctx);
      expect(getCurrentViewState()?.switchedAt).toBe(switchedAt);
      expect(getCurrentViewState()?.updatedAt).toBe("2026-01-01T00:00:02.000Z");

      // Navigating to a DIFFERENT view re-stamps switchedAt.
      vi.setSystemTime(new Date("2026-01-01T00:00:04.000Z"));
      const third = makeNavigateCtx("character", {});
      await handleViewsRoutes(third.ctx);
      expect(getCurrentViewState()?.switchedAt).toBe(
        "2026-01-01T00:00:04.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("isViewSwitchFresh expires a stale switch after the freshness window", () => {
    const base: CurrentViewState = {
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      switchedAt: new Date(1_000_000).toISOString(),
      source: "agent",
      updatedAt: new Date(1_000_000).toISOString(),
    };
    // Within the window → fresh; past it → stale; missing stamp → never fresh.
    expect(isViewSwitchFresh(base, 1_000_000 + VIEW_SWITCH_FRESH_MS - 1)).toBe(
      true,
    );
    expect(isViewSwitchFresh(base, 1_000_000 + VIEW_SWITCH_FRESH_MS + 1)).toBe(
      false,
    );
    expect(isViewSwitchFresh({ ...base, switchedAt: undefined })).toBe(false);
    expect(isViewSwitchFresh(null)).toBe(false);
  });
});
