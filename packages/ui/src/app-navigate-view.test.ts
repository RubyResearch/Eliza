/** Verifies App navigate-view shell handler through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for the navigate-view helpers: payload consume, path
 * derivation, direct-tab resolution, and the handler that opens registered
 * views or desktop tabs. Pure functions + injected bridge, no runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNavigateViewEvent } from "@elizaos/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setNavigateViewPayloadForTests,
  consumeNavigateViewPayload,
  createNavigateViewHandler,
  type DesktopBridgeRequest,
  directTabForNavigateView,
  navigateBrowserPath,
  pathForNavigateViewDetail,
} from "./app-navigate-view";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";

function view(patch: Partial<ViewRegistryEntry> = {}): ViewRegistryEntry {
  return {
    id: "remote-ledger",
    label: "Remote Ledger",
    available: true,
    pluginName: "plugin-ledger",
    path: "/apps/remote-ledger",
    viewType: "gui",
    ...patch,
  };
}

function createHandlerFixture(views: ViewRegistryEntry[] = [view()]) {
  const invokeDesktopBridgeRequest = vi.fn(
    async <T>() =>
      ({
        id: "app-1",
      }) as T,
  ) as DesktopBridgeRequest;
  const closeDesktopTab = vi.fn();
  const navigatePath = vi.fn();
  const openDesktopTab = vi.fn();
  const setActiveDesktopTabId = vi.fn();
  const setTab = vi.fn();
  const setViewLayout = vi.fn();
  const handler = createNavigateViewHandler({
    availableViewsForDesktopTabs: views,
    closeDesktopTab,
    desktopTabs: views.map((entry) => ({ viewId: entry.id })),
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
    setViewLayout,
  });
  return {
    handler,
    closeDesktopTab,
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
    setViewLayout,
  };
}

function navigateEvent(detail: Record<string, unknown>): CustomEvent {
  return createNavigateViewEvent(detail);
}

describe("App navigate-view shell handler", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  });

  it("resolves paths and direct tabs for view manager navigation", () => {
    expect(pathForNavigateViewDetail({ viewPath: "/views" })).toBe("/views");
    expect(pathForNavigateViewDetail({ viewId: "remote-ledger" })).toBe(
      "/apps/remote-ledger",
    );
    expect(
      pathForNavigateViewDetail({ viewId: "settings" }, [
        view({ id: "settings", label: "Settings", path: "/settings" }),
      ]),
    ).toBe("/settings");
    expect(pathForNavigateViewDetail({})).toBeNull();
    expect(directTabForNavigateView({ viewPath: "/views" }, "/views")).toBe(
      "views",
    );
    // `/apps` is a retired My Apps deep link that resolves to the consolidated
    // Projects surface (#17031; the launcher grid is `/views`), so it has no
    // direct-tab fast path — it resolves through the normal path→tab lookup.
    expect(directTabForNavigateView({ viewPath: "/apps" }, "/apps")).toBeNull();
    expect(
      directTabForNavigateView(
        { viewId: "views-manager", viewType: "gui" },
        "/apps/views-manager",
      ),
    ).toBe("views");
    expect(
      directTabForNavigateView(
        { viewId: "views-manager", viewType: "tui" },
        "/apps/views-manager",
      ),
    ).toBe("views");
  });

  it("sets direct app tabs without changing browser history", () => {
    const fixture = createHandlerFixture();

    fixture.handler(navigateEvent({ viewPath: "/views" }));
    fixture.handler(navigateEvent({ viewId: "views-manager" }));

    expect(fixture.setTab).toHaveBeenCalledTimes(2);
    expect(fixture.setTab).toHaveBeenNthCalledWith(1, "views");
    expect(fixture.setTab).toHaveBeenNthCalledWith(2, "views");
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("pins a view as a desktop tab and navigates to the view path", () => {
    const remoteLedger = view({ desktopTabEnabled: false });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "pin-tab",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(remoteLedger, {
      pinned: true,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.setTab).toHaveBeenCalledWith("apps");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/remote-ledger");
  });

  it("uses registry paths for view-id-only builtin navigation", () => {
    const settings = view({
      id: "settings",
      label: "Settings",
      path: "/settings",
      desktopTabEnabled: false,
    });
    const fixture = createHandlerFixture([settings]);

    fixture.handler(navigateEvent({ viewId: "settings" }));

    expect(fixture.setTab).toHaveBeenCalledWith("settings");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/settings");
    expect(fixture.navigatePath).not.toHaveBeenCalledWith("/apps/settings");
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("auto-opens desktop-tab-enabled views without pinning them", () => {
    const localNotes = view({
      id: "local-notes",
      label: "Local Notes",
      path: "/apps/local-notes",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([localNotes]);

    fixture.handler(navigateEvent({ viewId: "local-notes" }));

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(localNotes, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("local-notes");
    expect(fixture.setTab).toHaveBeenCalledWith("apps");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/local-notes");
  });

  it("activates the route tab before navigating app paths", () => {
    const fixture = createHandlerFixture();

    fixture.handler(
      navigateEvent({ viewId: "plugins", viewPath: "/apps/plugins" }),
    );

    expect(fixture.setTab).toHaveBeenCalledWith("plugins");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/plugins");
  });

  it("lets the shell activate a route tab without rewriting its exact path", () => {
    const fixture = createHandlerFixture();
    const setTabForPath = vi.fn();
    const handler = createNavigateViewHandler({
      availableViewsForDesktopTabs: [view()],
      invokeDesktopBridgeRequest: fixture.invokeDesktopBridgeRequest,
      navigatePath: fixture.navigatePath,
      openDesktopTab: fixture.openDesktopTab,
      setActiveDesktopTabId: fixture.setActiveDesktopTabId,
      setTab: fixture.setTab,
      setTabForPath,
    });

    handler(navigateEvent({ viewId: "plugins", viewPath: "/apps/plugins" }));

    expect(setTabForPath).toHaveBeenCalledOnce();
    expect(setTabForPath).toHaveBeenCalledWith("plugins");
    expect(fixture.setTab).not.toHaveBeenCalled();
    expect(fixture.navigatePath).toHaveBeenCalledOnce();
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/plugins");
  });

  it("closes a targeted desktop view tab and falls back to chat", () => {
    const remoteLedger = view();
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "close",
      }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith(null);
    expect(fixture.setTab).toHaveBeenCalledWith("chat");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("closes all desktop view tabs and falls back to chat", () => {
    const remoteLedger = view();
    const localNotes = view({
      id: "local-notes",
      label: "Local Notes",
      path: "/apps/local-notes",
    });
    const fixture = createHandlerFixture([remoteLedger, localNotes]);

    fixture.handler(
      navigateEvent({
        viewId: "__all__",
        action: "close-all",
      }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("local-notes");
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith(null);
    expect(fixture.setTab).toHaveBeenCalledWith("chat");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.navigatePath).not.toHaveBeenCalled();
  });

  it("opens layout event participants as desktop tabs and activates layout state", () => {
    const notes = view({
      id: "notes",
      label: "Notes",
      path: "/notes",
      desktopTabEnabled: true,
    });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([notes, calendar]);

    fixture.handler(
      navigateEvent({
        viewId: "notes",
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(notes, {
      pinned: false,
    });
    expect(fixture.openDesktopTab).toHaveBeenCalledWith(calendar, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("notes");
    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "split",
      viewIds: ["notes", "calendar"],
      layout: "horizontal",
      placement: "right",
    });
    expect(fixture.setTab).toHaveBeenCalledWith("views");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
  });

  it("activates the first resolved layout participant when the first requested view is unavailable", () => {
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([calendar]);

    fixture.handler(
      navigateEvent({
        action: "split-view",
        views: ["missing-notes", "calendar"],
        layout: "horizontal",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(calendar, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("calendar");
    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "split",
      viewIds: ["calendar"],
      layout: "horizontal",
      placement: undefined,
    });
    expect(fixture.setTab).toHaveBeenCalledWith("views");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
  });

  it("opens a managed app window through the desktop bridge", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/views/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: "Remote Ledger",
          path: "/views/remote-ledger",
          alwaysOnTop: false,
        },
      }),
    );
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("passes always-on-top window requests through the desktop bridge", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/apps/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
        alwaysOnTop: true,
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: "Remote Ledger",
          path: "/apps/remote-ledger",
          alwaysOnTop: true,
        },
      }),
    );
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("uses stable fallback title and path for missing open-window view entries", async () => {
    const fixture = createHandlerFixture([]);

    fixture.handler(
      navigateEvent({
        viewId: "unknown-view",
        action: "open-window",
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            title: "unknown-view",
            path: "/apps/unknown-view",
            alwaysOnTop: false,
          },
        }),
      ),
    );
  });

  it("falls back to in-page navigation when desktop open-window is unavailable", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/views/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);
    const bridge = vi.fn(
      async () => null,
    ) as typeof fixture.invokeDesktopBridgeRequest;
    const handler = createNavigateViewHandler({
      availableViewsForDesktopTabs: [remoteLedger],
      invokeDesktopBridgeRequest: bridge,
      navigatePath: fixture.navigatePath,
      openDesktopTab: fixture.openDesktopTab,
      setActiveDesktopTabId: fixture.setActiveDesktopTabId,
      setTab: fixture.setTab,
    });

    handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
      }),
    );

    await vi.waitFor(() => {
      expect(fixture.setTab).toHaveBeenCalledWith("views");
      expect(fixture.navigatePath).toHaveBeenCalledWith("/views/remote-ledger");
    });
  });

  it("stores generic one-shot payloads for target views", () => {
    const fixture = createHandlerFixture();

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        payload: { rowId: "row-7" },
      }),
    );

    expect(
      consumeNavigateViewPayload<{ rowId: string }>("remote-ledger"),
    ).toEqual({ rowId: "row-7" });
    expect(consumeNavigateViewPayload("remote-ledger")).toBeNull();
  });

  it("delivers a plugin-shaped deep-link payload to any target view id", () => {
    // A plugin's own navigate helper dispatches with the view id it targets and
    // a payload shape the view claims — the core stays generic, no view is
    // special-cased. Mirrors the Contacts→Phone/Messages handoff (#12674).
    const fixture = createHandlerFixture([
      view({ id: "phone", label: "Phone", path: "/phone" }),
    ]);

    fixture.handler(
      navigateEvent({
        viewId: "phone",
        viewPath: "/phone",
        payload: { number: "+15550100" },
      }),
    );

    expect(consumeNavigateViewPayload<{ number: string }>("phone")).toEqual({
      number: "+15550100",
    });
    // Single-shot: a later plain navigation to the same view does not re-seed.
    expect(consumeNavigateViewPayload("phone")).toBeNull();
  });

  it("returns null before a payload is seeded (no stale one-shot state)", () => {
    expect(consumeNavigateViewPayload("messages")).toBeNull();
    __setNavigateViewPayloadForTests("messages", { recipient: "+15550100" });
    expect(
      consumeNavigateViewPayload<{ recipient: string }>("messages"),
    ).toEqual({ recipient: "+15550100" });
    expect(consumeNavigateViewPayload("messages")).toBeNull();
  });

  // Regression guard for #12674: the core navigate module must not name the
  // Phone/Messages view ids or hold plugin-specific module-global one-shot
  // state. The generic `payload` channel + per-plugin navigate helpers replace
  // it. This asserts the removed special case cannot silently return.
  it("holds no hardcoded Phone/Messages special case or one-shot globals", () => {
    // Vitest runs with cwd at the package root (packages/ui); the guarded
    // module is a fixed source path from there.
    const source = readFileSync(
      resolve(process.cwd(), "src/app-navigate-view.ts"),
      "utf8",
    );
    for (const banned of [
      "pendingPhoneNumber",
      "pendingMessageRecipient",
      "consumePendingPhoneNumber",
      "consumePendingMessageRecipient",
      "navigateToPhoneWithNumber",
      "navigateToMessagesWithNumber",
      "normalizePhoneNumber",
    ]) {
      expect(source).not.toContain(banned);
    }
    // No view id is literally special-cased by the payload channel.
    expect(source).not.toContain('"phone"');
    expect(source).not.toContain('"messages"');
  });

  it("navigates browser history for normal view navigation", () => {
    navigateBrowserPath("/apps/remote-ledger?mode=edit#row-7");

    expect(window.location.pathname).toBe("/apps/remote-ledger");
    expect(window.location.search).toBe("?mode=edit");
    expect(window.location.hash).toBe("#row-7");
  });

  it("keeps agent view navigation inside /dev with the original query and fragment", () => {
    window.history.replaceState(null, "", "/dev#/chat");
    navigateBrowserPath("/notes?mode=edit#note-7");
    expect(window.location.pathname).toBe("/dev");
    expect(window.location.hash).toBe("#/notes?mode=edit#note-7");
    navigateBrowserPath("/chat");
    expect(window.location.pathname).toBe("/dev");
    expect(window.location.hash).toBe("#/chat");
  });
});
