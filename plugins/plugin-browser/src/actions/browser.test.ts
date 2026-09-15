/**
 * BROWSER action tests for command normalization and target dispatch.
 */

import type { HandlerCallback } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { validateToolArgs } from "@elizaos/core/actions/validate-tool-args";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_SERVICE_TYPE } from "../browser-service.js";
import { browserAction } from "./browser.js";

function runtimeWithService(service: unknown) {
  return {
    getService: vi.fn((type: string) =>
      type === BROWSER_SERVICE_TYPE ? service : null,
    ),
  };
}

function browserService(result: Record<string, unknown> = {}) {
  return {
    execute: vi.fn(async (command, targetId?: string) => ({
      targetId: targetId ?? "workspace",
      mode: "workspace",
      subaction: command.subaction,
      ...result,
    })),
  };
}

async function runBrowserAction(args: {
  parameters?: Record<string, unknown>;
  messageText?: string;
  service?: ReturnType<typeof browserService> | null;
  callback?: HandlerCallback;
}) {
  const service = args.service === undefined ? browserService() : args.service;
  const runtime = runtimeWithService(service);
  const result = await browserAction.handler?.(
    runtime as never,
    { content: { text: args.messageText ?? "" } } as never,
    undefined,
    { parameters: args.parameters ?? {} } as never,
    args.callback,
  );
  return { result, runtime, service };
}

describe("BROWSER action", () => {
  it.each([
    [
      "Open https://example.com. Keep records unchanged.",
      "https://example.com",
    ],
    ["Open (https://example.com/a_(b)).", "https://example.com/a_(b)"],
    ["Open [Example](https://example.com/page).", "https://example.com/page"],
    ["Open <https://example.com/a.>", "https://example.com/a."],
    ["Open https://example.com/a%2E.", "https://example.com/a%2E"],
    ["Open `https://example.com/a`.", "https://example.com/a"],
    ['Open "https://example.com/a."', "https://example.com/a."],
    [
      "Open `https://example.com/first` then https://example.com/second.",
      "https://example.com/first",
    ],
    [
      "Open https://example.com/first then https://example.com/second.",
      "https://example.com/first",
    ],
  ])("extracts the intended URL from prose: %s", async (messageText, url) => {
    const { service } = await runBrowserAction({
      parameters: { action: "open" },
      messageText,
    });
    expect(service?.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "open", url }),
      undefined,
      undefined,
    );
  });

  it("preserves punctuation in an explicit URL argument", async () => {
    const url = "https://example.com./path.?q=yes!";
    const { service } = await runBrowserAction({
      parameters: { action: "open", url },
      messageText: "Open https://different.example.",
    });
    expect(service?.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "open", url }),
      undefined,
      undefined,
    );
  });

  it("does not replace an invalid first URL with another destination", async () => {
    const service = browserService();
    service.execute.mockRejectedValue(new Error("Invalid URL"));
    const { result } = await runBrowserAction({
      service,
      parameters: { action: "open" },
      messageText: "Open https://:invalid then https://example.com.",
    });
    expect(service.execute).toHaveBeenCalledTimes(1);
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://:invalid" }),
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
  });

  it("dispatches promoted open without unrelated login or URL-wait fields", async () => {
    const open = promoteSubactionsToActions(browserAction).find(
      (action) => action.name === "BROWSER_OPEN",
    );
    expect(open).toBeDefined();
    if (!open) throw new Error("Promoted open action is required");
    const validation = validateToolArgs(open, {
      url: "https://example.com/",
      target: "custom-browser",
      id: "tab-1",
    });
    expect(validation.valid).toBe(true);
    const service = browserService();
    await open.handler?.(
      runtimeWithService(service) as never,
      { content: { text: "Open https://example.com/" } } as never,
      undefined,
      { parameters: validation.args } as never,
    );
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "open",
        url: "https://example.com/",
        id: "tab-1",
        show: true,
      }),
      "custom-browser",
      undefined,
    );
    for (const name of [
      "domain",
      "username",
      "submit",
      "pattern",
      "pollIntervalMs",
    ]) {
      expect(
        open.parameters?.some((parameter) => parameter.name === name),
      ).toBe(false);
    }
  });

  it.each([
    [
      "scroll",
      { direction: "left", pixels: 375 },
      { direction: "left", pixels: 375 },
    ],
    [
      "drag",
      { selector: "#from", targetSelector: "#to" },
      { selector: "#from", value: "#to" },
    ],
    [
      "press",
      { selector: "#input", key: "Escape" },
      { selector: "#input", key: "Escape" },
    ],
    [
      "realistic_type",
      { selector: "#input", text: "abc", perCharDelayMs: 17, replace: true },
      {
        subaction: "realistic-type",
        perCharDelayMs: 17,
        replace: true,
        text: "abc",
      },
    ],
    [
      "cursor_move",
      { x: 12, y: 34, cursorDurationMs: 75 },
      { subaction: "cursor-move", x: 12, y: 34, cursorDurationMs: 75 },
    ],
    [
      "tab",
      { tabAction: "switch", id: "tab-2" },
      { tabAction: "switch", id: "tab-2" },
    ],
    [
      "wait",
      { script: "document.readyState === 'complete'", timeoutMs: 250 },
      { script: "document.readyState === 'complete'", timeoutMs: 250 },
    ],
  ] as const)(
    "preserves %s operation arguments after promotion",
    async (action, inputs, command) => {
      const child = promoteSubactionsToActions(browserAction).find(
        (entry) => entry.name === `BROWSER_${action.toUpperCase()}`,
      );
      if (!child) throw new Error(`Missing promoted ${action}`);
      const validation = validateToolArgs(child, {
        ...inputs,
        target: "custom-browser",
      });
      expect(validation.valid).toBe(true);
      expect(validation.args).toMatchObject(inputs);
      const service = browserService();
      await child.handler?.(
        runtimeWithService(service) as never,
        { content: { text: "Perform the specified operation." } } as never,
        undefined,
        { parameters: validation.args } as never,
      );
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining(command),
        "custom-browser",
        undefined,
      );
    },
  );

  it("omits interaction-only fields from navigation while retaining the full parent contract", () => {
    const navigate = promoteSubactionsToActions(browserAction).find(
      (entry) => entry.name === "BROWSER_NAVIGATE",
    );
    if (!navigate) throw new Error("Missing promoted navigate");
    for (const name of [
      "tabAction",
      "key",
      "pixels",
      "direction",
      "targetSelector",
      "script",
      "cursorDurationMs",
      "perCharDelayMs",
      "replace",
      "x",
      "y",
    ]) {
      expect(
        browserAction.parameters?.some((parameter) => parameter.name === name),
      ).toBe(true);
      expect(
        navigate.parameters?.some((parameter) => parameter.name === name),
      ).toBe(false);
    }
    expect(
      validateToolArgs(navigate, {
        url: "https://example.com/",
        target: "workspace",
        id: "tab-1",
        timeoutMs: 1250,
      }).args,
    ).toMatchObject({
      url: "https://example.com/",
      target: "workspace",
      id: "tab-1",
      timeoutMs: 1250,
    });
  });

  it.each([
    [
      "BROWSER_AUTOFILL_LOGIN",
      "autofill_login",
      { domain: "example.com", username: "alice", submit: false },
    ],
    [
      "BROWSER_WAIT_FOR_URL",
      "wait_for_url",
      { pattern: "/done$/", pollIntervalMs: 75 },
    ],
  ] as const)(
    "keeps %s inputs available through the child and parent",
    (name, action, inputs) => {
      const child = promoteSubactionsToActions(browserAction).find(
        (entry) => entry.name === name,
      );
      expect(child).toBeDefined();
      if (!child) throw new Error("Promoted browser operation is required");
      for (const operation of [child, browserAction]) {
        const result = validateToolArgs(operation, { ...inputs, action });
        expect(result.valid).toBe(true);
        expect(result.args).toMatchObject(inputs);
      }
    },
  );

  it("rejects a URL on an element read instead of returning the previous page", async () => {
    const callback = vi.fn();
    const { result, service } = await runBrowserAction({
      parameters: {
        action: "get",
        selector: "h1",
        url: "https://example.com/",
      },
      callback,
    });
    expect(result).toMatchObject({
      success: false,
      transcriptVisibility: "internal",
      text: expect.stringContaining("navigate"),
    });
    expect(service?.execute).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("allows automatic target selection and plugin-registered target IDs", async () => {
    const automatic = validateToolArgs(browserAction, {
      action: "snapshot",
      target: "",
    });
    expect(automatic.valid).toBe(true);
    expect(automatic.args).not.toHaveProperty("target");
    const { service } = await runBrowserAction({ parameters: automatic.args });
    expect(service?.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "snapshot" }),
      undefined,
      undefined,
    );
    expect(
      validateToolArgs(browserAction, {
        action: "snapshot",
        target: "custom-registered-browser",
      }).valid,
    ).toBe(true);
  });

  it("accepts an omitted tab operation without weakening enum validation", async () => {
    const validation = validateToolArgs(browserAction, {
      action: "snapshot",
      id: "btab_1",
      tabAction: "",
    });
    expect(validation.valid).toBe(true);
    expect(validation.args).not.toHaveProperty("tabAction");
    const { service, result } = await runBrowserAction({
      parameters: validation.args,
    });
    expect(result?.success).toBe(true);
    expect(service?.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "snapshot", id: "btab_1" }),
      undefined,
      undefined,
    );
    expect(
      validateToolArgs(browserAction, {
        action: "tab",
        tabAction: "erase-everything",
      }).valid,
    ).toBe(false);
  });

  it.each(["navigate", "snapshot", "back", "forward", "scroll"])(
    "dispatches %s when the model leaves the optional direction empty",
    async (action) => {
      const validation = validateToolArgs(browserAction, {
        action,
        target: "workspace",
        id: "btab_1",
        url: "https://example.com",
        direction: "",
        tabAction: "",
      });
      expect(validation.valid).toBe(true);
      expect(validation.args).not.toHaveProperty("direction");
      expect(validation.args).not.toHaveProperty("tabAction");
      const { service, result } = await runBrowserAction({
        parameters: validation.args,
      });
      expect(service?.execute).toHaveBeenCalledTimes(1);
      expect(service?.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          subaction: action,
          id: "btab_1",
          direction: undefined,
        }),
        "workspace",
        undefined,
      );
      expect(result?.success).toBe(true);
      if (action === "scroll") expect(result?.text).toContain("Scrolled down");
    },
  );

  it("omits declared optional sentinels without dropping empty text", async () => {
    const validation = validateToolArgs(browserAction, {
      action: "fill",
      selector: "#query",
      text: "",
      target: "",
      direction: "",
      tabAction: "",
    });
    expect(validation.valid).toBe(true);
    expect(validation.args).toMatchObject({ text: "" });
    for (const name of ["target", "direction", "tabAction"]) {
      expect(validation.args).not.toHaveProperty(name);
    }
    const { service } = await runBrowserAction({ parameters: validation.args });
    expect(service?.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "fill",
        selector: "#query",
        text: "",
      }),
      undefined,
      undefined,
    );
  });

  it.each(["down", "left", "right", "up"])(
    "preserves explicit scroll direction %s through validation and dispatch",
    async (direction) => {
      const validation = validateToolArgs(browserAction, {
        action: "scroll",
        direction,
        pixels: 480,
      });
      expect(validation.valid).toBe(true);
      const { service } = await runBrowserAction({
        parameters: validation.args,
      });
      expect(service?.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          subaction: "scroll",
          direction,
          pixels: 480,
        }),
        undefined,
        undefined,
      );
    },
  );

  it.each(["back", "forward", "diagonal", "null"])(
    "rejects non-scroll direction %s rather than treating it as omitted",
    (direction) => {
      const validation = validateToolArgs(browserAction, {
        action: "scroll",
        direction,
      });
      expect(validation.valid).toBe(false);
      expect(validation.args).toBeUndefined();
      expect(validation.invalidParameterNames).toEqual(["direction"]);
    },
  );

  it("still rejects an empty or unsupported operation selector", () => {
    for (const action of ["", "erase-everything"]) {
      const validation = validateToolArgs(browserAction, { action });
      expect(validation.valid).toBe(false);
      expect(validation.invalidParameterNames).toEqual(["action"]);
    }
  });

  it.each([
    { action: "snapshot", selector: undefined },
    { action: "get", selector: "h1" },
  ])(
    "dispatches $action using its explicit page-read contract",
    async (parameters) => {
      const service = browserService({ value: "Example Domain" });
      const { result } = await runBrowserAction({ service, parameters });
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          subaction: parameters.action,
          selector: parameters.selector,
        }),
        undefined,
        undefined,
      );
      expect(result?.success).toBe(true);
      expect(result?.data.result.value).toBe("Example Domain");
    },
  );

  it("routes page-reading planner aliases to the canonical browser action", () => {
    expect(browserAction.similes).toEqual(
      expect.arrayContaining([
        "BROWSER_GET_CONTEXT",
        "BROWSER_GET_PAGE_STATE",
        "BROWSER_READ_PAGE",
        "BROWSER_SNAPSHOT",
      ]),
    );
  });

  it("normalizes legacy action aliases and forwards target overrides", async () => {
    const service = browserService({
      tabs: [
        { title: "Docs", url: "https://docs.example" },
        { title: "App", url: "https://app.example" },
      ],
    });

    const { result } = await runBrowserAction({
      service,
      parameters: {
        action: "list_tabs",
        target: "bridge",
      },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "tab",
        tabAction: "list",
      }),
      "bridge",
      undefined,
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        text: "Browser tabs (workspace):\n- Docs (https://docs.example)\n- App (https://app.example)",
        values: {
          success: true,
          mode: "workspace",
          subaction: "tab",
          targetId: "bridge",
        },
      }),
    );
  });

  it("infers open from URLs in message text", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com/path" },
    });

    const { result } = await runBrowserAction({
      service,
      messageText: "Open https://example.com/path please",
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        show: true,
        subaction: "open",
        url: "https://example.com/path",
      }),
      undefined,
      undefined,
    );
    expect(result?.data.command).toEqual(
      expect.objectContaining({
        show: true,
        subaction: "open",
        url: "https://example.com/path",
      }),
    );
    expect(result).toMatchObject({
      text: "Opened example.com/path.",
      turnComplete: true,
      modelReplyRequired: true,
      values: {
        targetId: "workspace",
        viewId: "browser",
        viewPath: "/browser",
      },
    });
    expect(result).not.toHaveProperty("userFacingText");
    expect(result).not.toHaveProperty("verifiedUserFacing");
    expect(browserAction.suppressEarlyReply).toBe(true);
  });

  it("emits compact progress for non-terminal inspection work", async () => {
    const service = browserService({ value: { ready: true } });
    const callback = vi.fn(async () => []);

    await runBrowserAction({
      service,
      callback,
      parameters: {
        action: "state",
        streamProgress: true,
        rationale: "checking example",
      },
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Step 1: state — checking example",
        source: "action_progress",
        merge: "replace",
        metadata: {
          transient: true,
          compactProgress: true,
          progress: {
            source: "browser",
            actionName: "BROWSER",
            step: 1,
            kind: "state",
            rationale: "checking example",
            success: true,
            error: undefined,
          },
        },
      }),
      "BROWSER",
    );
  });

  it("does not emit transient progress for an effect with a terminal receipt", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com" },
    });
    const callback = vi.fn(async () => []);

    const { result } = await runBrowserAction({
      service,
      callback,
      parameters: {
        action: "open",
        url: "https://example.com",
        streamProgress: true,
      },
    });

    expect(callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "Opened example.com.",
      turnComplete: true,
      modelReplyRequired: true,
    });
    expect(result).not.toHaveProperty("userFacingText");
    expect(result).not.toHaveProperty("verifiedUserFacing");
  });

  it("does not fail the browser action when compact progress delivery fails", async () => {
    const callback = vi.fn(async () => {
      throw new Error("telegram edit failed");
    });

    const { result } = await runBrowserAction({
      callback,
      parameters: {
        action: "state",
        streamProgress: true,
      },
    });

    expect(result.success).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps compact progress behind the streamProgress flag", async () => {
    const callback = vi.fn(async () => []);

    await runBrowserAction({
      callback,
      parameters: {
        action: "state",
      },
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("uses navigate instead of open when a URL and tab id are present", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com" },
    });

    await runBrowserAction({
      service,
      parameters: {
        id: "tab-1",
        url: "https://example.com",
      },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tab-1",
        subaction: "navigate",
        url: "https://example.com",
      }),
      undefined,
      undefined,
    );
  });

  it("selects realistic click and fill commands in watch mode", async () => {
    const service = browserService({ value: { x: 10, y: 20 } });

    await runBrowserAction({
      service,
      parameters: {
        selector: "#submit",
        watchMode: true,
        cursorDurationMs: 120,
      },
    });
    await runBrowserAction({
      service,
      parameters: {
        selector: "#email",
        text: "owner@example.com",
        watchMode: true,
        perCharDelayMs: 10,
        replace: true,
      },
    });

    expect(service.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        subaction: "realistic-click",
        selector: "#submit",
        cursorDurationMs: 120,
      }),
      undefined,
      undefined,
    );
    expect(service.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        subaction: "realistic-fill",
        selector: "#email",
        text: "owner@example.com",
        value: "owner@example.com",
        perCharDelayMs: 10,
        replace: true,
      }),
      undefined,
      undefined,
    );
  });

  it("formats value, snapshot, cursor, and close results", async () => {
    const valueService = browserService({ value: { ok: true } });
    const snapshotService = browserService({ snapshot: { data: "base64" } });
    const closeService = browserService({ closed: true });
    const cursorService = browserService({ value: { x: 10.4, y: 20.6 } });

    const state = await runBrowserAction({
      service: valueService,
      parameters: { action: "state" },
    });
    expect(state.result).toMatchObject({
      text: 'Browser state result (workspace):\n{\n  "ok": true\n}',
    });
    expect(state.result).not.toHaveProperty("verifiedUserFacing");
    expect(state.result).not.toHaveProperty("userFacingText");
    await expect(
      runBrowserAction({
        service: snapshotService,
        parameters: { action: "screenshot" },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Browser screenshot captured a preview in workspace mode.",
      },
    });
    await expect(
      runBrowserAction({
        service: closeService,
        parameters: { action: "close" },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Browser closed (workspace).",
      },
    });
    await expect(
      runBrowserAction({
        service: cursorService,
        parameters: { action: "cursor_move", x: 10.4, y: 20.6 },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Cursor moved to (10, 21) in workspace mode.",
      },
    });
  });

  it("wait_for_url opens the url, streams a watch status, and resolves on match", async () => {
    // open → tab; get url → matching url on the first poll.
    const service = {
      execute: vi.fn(async (command: { subaction: string }) => {
        if (command.subaction === "open") {
          return {
            mode: "workspace",
            subaction: "open",
            tab: {
              id: "tab-9",
              title: "OAuth",
              url: "https://gh.example/oauth",
            },
          };
        }
        if (command.subaction === "get") {
          return {
            mode: "workspace",
            subaction: "get",
            value: "https://gh.example/callback?code=abc",
          };
        }
        return { mode: "workspace", subaction: command.subaction };
      }),
    };
    const runtime = runtimeWithService(service);
    const callback = vi.fn(async () => []);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      {
        parameters: {
          action: "wait_for_url",
          url: "https://gh.example/oauth",
          pattern: "callback?code=",
          timeoutMs: 5_000,
          pollIntervalMs: 100,
        },
      } as never,
      callback as never,
    );

    // Opened the starting url, then polled the current url.
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "open",
        url: "https://gh.example/oauth",
      }),
      undefined,
    );
    // First callback is the "I opened X, watching" message.
    expect(callback.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("watching"),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        values: expect.objectContaining({
          success: true,
          subaction: "wait_for_url",
          status: "matched",
          matched: true,
        }),
      }),
    );
    expect(result?.text).toContain("callback?code=abc");
  });

  it("wait_for_url falls back to tab-list URLs when get/state cannot read an unloaded page", async () => {
    let listPolls = 0;
    const service = {
      execute: vi.fn(async (command: { id?: string; subaction: string }) => {
        if (command.subaction === "open") {
          return {
            mode: "workspace",
            subaction: "open",
            tab: {
              id: "tab-10",
              title: "OAuth",
              url: "https://gh.example/oauth",
            },
          };
        }
        if (command.subaction === "get") {
          throw new Error("page is still loading");
        }
        if (command.subaction === "state") {
          return { mode: "workspace", subaction: "state" };
        }
        if (command.subaction === "list") {
          listPolls += 1;
          return {
            mode: "workspace",
            subaction: "list",
            tabs: [
              {
                id: "tab-10",
                title: "OAuth",
                url:
                  listPolls >= 2
                    ? "https://gh.example/callback?code=abc"
                    : "https://gh.example/oauth",
              },
            ],
          };
        }
        return { mode: "workspace", subaction: command.subaction };
      }),
    };
    const runtime = runtimeWithService(service);
    const callback = vi.fn(async () => []);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      {
        parameters: {
          action: "wait_for_url",
          url: "https://gh.example/oauth",
          pattern: "callback?code=",
          timeoutMs: 1_000,
          pollIntervalMs: 50,
        },
      } as never,
      callback as never,
    );

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "list" }),
      undefined,
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("still waiting"),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          outcome: expect.objectContaining({
            lastUrl: "https://gh.example/callback?code=abc",
            matched: true,
          }),
        }),
      }),
    );
  });

  it("wait_for_url fails fast when no pattern is supplied", async () => {
    const service = browserService();
    const runtime = runtimeWithService(service);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "wait_for_url" } } as never,
      (async () => []) as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: expect.objectContaining({
          error: "BROWSER_WAIT_FOR_URL_NO_PATTERN",
        }),
      }),
    );
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("returns a structured failure when no service or workspace backend can execute", async () => {
    const { result } = await runBrowserAction({
      service: null,
      parameters: { action: "state" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: {
          success: false,
          error: "BROWSER_FAILED",
        },
        data: expect.objectContaining({
          actionName: "BROWSER",
          command: expect.objectContaining({ subaction: "state" }),
        }),
      }),
    );
    expect(result?.text).toMatch(/^Browser action failed:/);
  });
});

describe("BROWSER restored interaction vocabulary (#18259)", () => {
  it("dispatches scroll with direction and pixels", async () => {
    const service = browserService({
      value: { axis: "y", selector: null, value: 480 },
    });
    const { result } = await runBrowserAction({
      service,
      parameters: { action: "scroll", direction: "up", pixels: 480 },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "up",
        pixels: 480,
        subaction: "scroll",
      }),
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Scrolled up");
  });

  it("infers scroll when only direction or pixels are provided", async () => {
    const service = browserService({ value: { axis: "y", value: 240 } });
    await runBrowserAction({ service, parameters: { pixels: 240 } });
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ pixels: 240, subaction: "scroll" }),
      undefined,
      undefined,
    );

    const directional = browserService({ value: { axis: "y", value: 240 } });
    await runBrowserAction({
      service: directional,
      parameters: { direction: "down" },
    });
    expect(directional.execute).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "down", subaction: "scroll" }),
      undefined,
      undefined,
    );
  });

  it("normalizes scroll_into to the workspace scrollinto command", async () => {
    const service = browserService({
      value: { scrolled: true, selector: "#footer" },
    });
    const { result } = await runBrowserAction({
      service,
      parameters: { action: "scroll_into", selector: "#footer" },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "#footer", subaction: "scrollinto" }),
      undefined,
      undefined,
    );
    expect(result?.text).toContain("Scrolled #footer into view");
  });

  it("dispatches hover against the requested selector", async () => {
    const service = browserService({
      value: { hovered: true, selector: "#menu" },
    });
    const { result } = await runBrowserAction({
      service,
      parameters: { action: "hover", selector: "#menu" },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ selector: "#menu", subaction: "hover" }),
      undefined,
      undefined,
    );
    expect(result?.text).toContain("Hovering over #menu");
  });

  it("dispatches drag carrying the drop target in value", async () => {
    const service = browserService({
      value: { source: "#card", target: "#column" },
    });
    const { result } = await runBrowserAction({
      service,
      parameters: {
        action: "drag",
        selector: "#card",
        targetSelector: "#column",
      },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: "#card",
        subaction: "drag",
        value: "#column",
      }),
      undefined,
      undefined,
    );
    expect(result?.text).toContain("Dragged #card to #column");
  });

  it("dispatches plain fill as replace semantics and clear as empty fill", async () => {
    const service = browserService({
      value: { selector: "#query", value: "travel" },
    });
    await runBrowserAction({
      service,
      parameters: { action: "fill", selector: "#query", text: "travel" },
    });
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: "#query",
        subaction: "fill",
        value: "travel",
      }),
      undefined,
      undefined,
    );

    const clearing = browserService({
      value: { selector: "#query", value: "" },
    });
    const { result } = await runBrowserAction({
      service: clearing,
      parameters: { action: "clear", selector: "#query" },
    });
    expect(clearing.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: "#query",
        subaction: "fill",
        value: "",
      }),
      undefined,
      undefined,
    );
    expect(result?.text).toContain("Cleared #query");
  });

  it("grounds receipt values in the tab the backend actually affected", async () => {
    const service = browserService({
      tab: {
        id: "tab-9",
        title: "Details Loaded",
        url: "https://example.test/details",
        visible: true,
      },
    });
    const { result } = await runBrowserAction({
      service,
      parameters: { action: "hover", selector: "#menu" },
    });

    expect(result?.values).toMatchObject({
      tabId: "tab-9",
      title: "Details Loaded",
      url: "https://example.test/details",
    });
    expect(result?.text).toContain("Details Loaded");
    expect(result?.text).toContain("example.test/details");
  });
});

describe("BROWSER routing hint (#12209)", () => {
  it("states its planner boundary versus WEB_FETCH, WEB_SEARCH, and COMPUTER_USE", () => {
    const hint = browserAction.routingHint ?? "";
    expect(hint).toContain("BROWSER");
    expect(hint).toContain("WEB_FETCH");
    expect(hint).toContain("WEB_SEARCH");
    expect(hint).toContain("COMPUTER_USE");
  });
});

// ---------------------------------------------------------------------------
// Typed dispatch failure propagation at the action boundary (#18258 review P1 #3)
//
// The service layer distinguishes UNSUPPORTED/UNAVAILABLE (safe pre-dispatch
// declines) from UNCERTAIN_OUTCOME (a side-effecting command may have partially
// executed — must NOT be retried). The BROWSER action must propagate this typed
// state instead of collapsing every failure to "BROWSER_FAILED".
// ---------------------------------------------------------------------------

describe("BROWSER action propagates typed dispatch failures (#18258 review)", () => {
  it("propagates a safe pre-dispatch decline (UNSUPPORTED) with fallbackSafe=true", async () => {
    const { BrowserDispatchFailure } = await import("../dispatch-types.js");
    const service = {
      execute: vi.fn(async () => {
        throw new BrowserDispatchFailure(
          "UNSUPPORTED",
          'No available browser target supports subaction "upload".',
          { targetId: null },
        );
      }),
    };

    const { result } = await runBrowserAction({
      service: service as never,
      parameters: { action: "upload" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: expect.objectContaining({
          success: false,
          error: "UNSUPPORTED",
          dispatchKind: "UNSUPPORTED",
          fallbackSafe: true,
        }),
        data: expect.objectContaining({
          actionName: "BROWSER",
          dispatchFailure: expect.objectContaining({
            kind: "UNSUPPORTED",
            fallbackSafe: true,
          }),
        }),
      }),
    );
  });

  it("propagates an uncertain post-dispatch failure (UNCERTAIN_OUTCOME) with fallbackSafe=false", async () => {
    const { BrowserDispatchFailure } = await import("../dispatch-types.js");
    const service = {
      execute: vi.fn(async () => {
        throw new BrowserDispatchFailure(
          "UNCERTAIN_OUTCOME",
          'Browser command "click" against target "bridge" failed after dispatch and may have partially completed.',
          { targetId: "bridge" },
        );
      }),
    };

    const { result } = await runBrowserAction({
      service: service as never,
      parameters: { action: "click", selector: "#submit" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: expect.objectContaining({
          success: false,
          error: "UNCERTAIN_OUTCOME",
          dispatchKind: "UNCERTAIN_OUTCOME",
          fallbackSafe: false,
          targetId: "bridge",
        }),
        data: expect.objectContaining({
          actionName: "BROWSER",
          dispatchFailure: expect.objectContaining({
            kind: "UNCERTAIN_OUTCOME",
            fallbackSafe: false,
            targetId: "bridge",
          }),
        }),
      }),
    );
  });

  it("falls back to BROWSER_FAILED for non-dispatch errors", async () => {
    const service = {
      execute: vi.fn(async () => {
        throw new Error("Something went wrong");
      }),
    };

    const { result } = await runBrowserAction({
      service: service as never,
      parameters: { action: "state" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: expect.objectContaining({
          success: false,
          error: "BROWSER_FAILED",
        }),
      }),
    );
    // Must NOT have dispatchFailure in data for a plain error.
    expect(result?.data).not.toHaveProperty("dispatchFailure");
  });
});
