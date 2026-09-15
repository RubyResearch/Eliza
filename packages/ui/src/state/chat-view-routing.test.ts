/** Deterministic coverage for chat response-context routing across built-in and dynamic views. */

import { Capacitor } from "@capacitor/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildChatViewMetadata,
  resolveChatViewRouting,
} from "./chat-view-routing";

describe("resolveChatViewRouting", () => {
  it("keeps native Browser ownership across views and clears stale web hints", () => {
    const native = vi
      .spyOn(Capacitor, "isNativePlatform")
      .mockReturnValue(true);
    try {
      expect(
        buildChatViewMetadata("browser", undefined, "/browser")
          .uiBrowserSurface,
      ).toBe("native");
      expect(
        buildChatViewMetadata("views", { uiBrowserSurface: "native" }, "/notes")
          .uiBrowserSurface,
      ).toBe("native");
      native.mockReturnValue(false);
      expect(
        buildChatViewMetadata(
          "browser",
          { uiBrowserSurface: "native" },
          "/browser",
        ).uiBrowserSurface,
      ).toBeUndefined();
    } finally {
      native.mockRestore();
    }
  });
  it("routes the orchestrator path independently of the selected tab", () => {
    expect(resolveChatViewRouting("chat", "/orchestrator/task-7")).toEqual({
      view: "orchestrator",
      primaryContext: "code",
      secondaryContexts: ["admin", "documents"],
      capabilities: [
        "orchestrator-task",
        "coding-agent",
        "task-history",
        "workspace-control",
      ],
    });
  });

  it("routes Calendar from a normalized fullscreen plugin route", () => {
    expect(
      resolveChatViewRouting("views", "calendar/?day=today"),
    ).toMatchObject({
      view: "calendar",
      primaryContext: "calendar",
      capabilities: [],
    });
  });

  it("routes fullscreen Notes chat and voice turns to the focused Notes domain", () => {
    expect(resolveChatViewRouting("views", "/notes")).toEqual({
      view: "notes",
      primaryContext: "notes",
      secondaryContexts: [],
      capabilities: [],
    });
  });

  it("does not invent capabilities for plugin routes without declarations", () => {
    expect(resolveChatViewRouting("views", "/weather-map")).toMatchObject({
      view: "weather-map",
      capabilities: [],
    });
  });

  it("does not invent Wallet capabilities before the registry declares them", () => {
    expect(resolveChatViewRouting("views", "/wallet")).toEqual({
      view: "wallet",
      primaryContext: "wallet",
      secondaryContexts: [],
      capabilities: [],
    });
    expect(resolveChatViewRouting("inventory", "/")).toEqual({
      view: "wallet",
      primaryContext: "wallet",
      secondaryContexts: [],
      capabilities: [],
    });
  });

  it("routes Projects and Memories by rendered route rather than generic tabs", () => {
    expect(resolveChatViewRouting("apps", "/apps/tasks")).toMatchObject({
      view: "projects",
      primaryContext: "code",
    });
    expect(resolveChatViewRouting("views", "/apps/memories/item-1")).toEqual({
      view: "memories",
      primaryContext: "memory",
      secondaryContexts: [],
      capabilities: [],
    });
  });

  it("groups runtime diagnostics under the system context", () => {
    expect(resolveChatViewRouting("logs", "/logs")).toMatchObject({
      view: "system",
      primaryContext: "system",
    });
  });
});

describe("buildChatViewMetadata", () => {
  it("preserves caller metadata and merges unique normalized contexts", () => {
    expect(
      buildChatViewMetadata(
        "documents",
        {
          requestId: "request-1",
          __responseContext: {
            secondaryContexts: ["ADMIN", "character", "admin"],
            caller: "composer",
          },
        },
        "/documents?source=chat",
      ),
    ).toEqual({
      requestId: "request-1",
      uiView: "character",
      uiTab: "documents",
      uiViewPath: "/documents",
      uiViewCapabilities: [
        "search-documents",
        "add-documents",
        "modify-character",
      ],
      uiTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      __responseContext: {
        caller: "composer",
        primaryContext: "documents",
        secondaryContexts: ["character", "admin", "documents"],
      },
    });
  });
});
