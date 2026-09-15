/**
 * BROWSER action dispatcher for workspace, bridge, and external browser targets.
 */

import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  HandlerOptions,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { asRecord, readViewInteractionClientId } from "@elizaos/shared";
import LinkifyIt from "linkify-it";
import {
  BROWSER_SERVICE_TYPE,
  type BrowserService,
} from "../browser-service.js";
import {
  type BrowserDispatchFailure,
  isBrowserDispatchFailure,
} from "../dispatch-types.js";
import {
  type BrowserWorkspaceCommand,
  type BrowserWorkspaceCommandResult,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceMode,
} from "../workspace/browser-workspace.js";
import {
  WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS,
  WAIT_FOR_URL_DEFAULT_TIMEOUT_MS,
  waitForUrl,
} from "./wait-for-url.js";

/**
 * Targets are the registered browser backends. The agent uses what is
 * available; specifying a target overrides automatic routing. `workspace`
 * is the app-owned browser surface, `bridge` is the paired Chrome, Firefox, or Safari
 * companion, `stagehand` is the Playwright/Stagehand fallback, and other
 * plugins may register additional target ids.
 */
export type BrowserTarget = string;

type BrowserWorkspaceSubaction =
  | "back"
  | "click"
  | "close"
  | "drag"
  | "fill"
  | "forward"
  | "get"
  | "hide"
  | "hover"
  | "navigate"
  | "open"
  | "press"
  | "reload"
  | "screenshot"
  | "scroll"
  | "scrollinto"
  | "show"
  | "snapshot"
  | "state"
  | "tab"
  | "type"
  | "wait"
  | "realistic-click"
  | "realistic-fill"
  | "realistic-type"
  | "realistic-press"
  | "cursor-move"
  | "cursor-hide";

type BrowserWorkspaceAction =
  | BrowserWorkspaceSubaction
  | "realistic_click"
  | "realistic_fill"
  | "realistic_type"
  | "realistic_press"
  | "cursor_move"
  | "cursor_hide";

type BrowserActionSubaction =
  | BrowserWorkspaceSubaction
  | "autofill-login"
  | "wait-for-url";
type BrowserActionValue =
  | BrowserWorkspaceAction
  | "autofill_login"
  | "autofill-login"
  | "clear"
  | "scroll_into"
  | "wait_for_url"
  | "wait-for-url";
type NormalizedBrowserAction =
  | BrowserWorkspaceSubaction
  | "autofill-login"
  | "wait-for-url"
  | "clear"
  | "info"
  | "context"
  | "get_context"
  | "list_tabs"
  | "open_tab"
  | "close_tab"
  | "switch_tab";

type BrowserActionParameters = {
  /**
   * Optional target override. Default: the BrowserService active target
   * selected from registered targets. Forces a specific backend when set.
   */
  target?: BrowserTarget;
  id?: string;
  key?: string;
  pixels?: number;
  script?: string;
  selector?: string;
  /** Scroll direction for action=scroll. Default "down". */
  direction?: "down" | "left" | "right" | "up";
  /** Drop-target selector for action=drag (source comes from `selector`). */
  targetSelector?: string;
  /**
   * Canonical browser action. Legacy `subaction` remains accepted.
   */
  action?:
    | BrowserActionValue
    | "info"
    | "context"
    | "get_context"
    | "list_tabs"
    | "open_tab"
    | "close_tab"
    | "switch_tab";
  subaction?: BrowserActionSubaction;
  /** For action=wait_for_url: substring or regex to match the tab URL. */
  pattern?: string;
  /** For action=wait_for_url: poll cadence in ms (default ~2000). */
  pollIntervalMs?: number;
  /** Registrable hostname for `action: "autofill_login"`. */
  domain?: string;
  /** Saved login username for autofill-login (optional). */
  username?: string;
  /** When true with autofill-login, submit after filling. */
  submit?: boolean;
  tabAction?: "close" | "list" | "new" | "switch";
  text?: string;
  timeoutMs?: number;
  url?: string;
  /** Cursor animation duration (ms) for realistic-* + cursor-* subactions. */
  cursorDurationMs?: number;
  /** Per-character delay for realistic-type / realistic-fill (ms). */
  perCharDelayMs?: number;
  /** Replace existing input value when filling (vs append). */
  replace?: boolean;
  /** Cursor target X (CSS pixels) for cursor-move. */
  x?: number;
  /** Cursor target Y (CSS pixels) for cursor-move. */
  y?: number;
  /** Hint that the agent is operating in a watch-mode (page-browser) scope. */
  watchMode?: boolean;
  /** Emit one compact progress callback after the browser step dispatches. */
  streamProgress?: boolean;
  /** Optional rationale to show in the compact progress callback. */
  rationale?: string;
};

function getMessageText(message: Memory | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return typeof content?.text === "string" ? content.text : "";
}

const browserMessageLinks = new LinkifyIt({
  fuzzyLink: false,
  fuzzyEmail: false,
  fuzzyIP: false,
});

function extractFirstUrl(value: string): string | null {
  const candidate = /https?:\/\/[^\s<>"'`]+/i.exec(value);
  if (!candidate) return null;
  const before = value[candidate.index - 1];
  const after = value[candidate.index + candidate[0].length];
  if (before && /["'`]/.test(before) && after === before) {
    return candidate[0];
  }
  // Prose punctuation is not part of the destination. Keep the matched URL
  // bytes; quoted literals and explicit url arguments bypass linkification.
  // Never skip the first HTTP(S) candidate in favor of a later destination.
  return (
    browserMessageLinks
      .match(value)
      ?.find(
        (link) =>
          link.index === candidate.index && /^https?:$/i.test(link.schema),
      )?.raw ?? candidate[0]
  );
}

function inferBrowserSubaction(
  params: BrowserActionParameters | undefined,
  messageText: string,
): BrowserWorkspaceCommand["subaction"] | "autofill-login" | "wait-for-url" {
  const normalizedAction = normalizeBrowserAction(params?.action);
  if (
    normalizedAction === "autofill-login" ||
    params?.subaction === "autofill-login"
  ) {
    return "autofill-login";
  }

  if (
    normalizedAction === "wait-for-url" ||
    params?.subaction === "wait-for-url"
  ) {
    return "wait-for-url";
  }

  const legacySubaction = normalizeLegacyBrowserAction(normalizedAction);
  if (legacySubaction) {
    return legacySubaction;
  }
  if (params?.subaction) {
    return params.subaction;
  }

  if (params?.tabAction) {
    return "tab";
  }

  // Scroll intent is unambiguous when a direction or pixel distance arrives
  // without text to type: honor it even if the planner omitted the action.
  if (
    (params?.direction !== undefined || params?.pixels !== undefined) &&
    params?.text === undefined
  ) {
    return "scroll";
  }

  // In watch mode the user is observing the agent drive the browser; prefer
  // the realistic-* subactions so the cursor moves and pointer events fire
  // faithfully. Default-mode (no watcher) keeps the leaner click()/value=
  // path for speed.
  const watchMode = params?.watchMode === true;

  if (params?.selector && params?.text) {
    return watchMode ? "realistic-fill" : "type";
  }

  if (params?.selector) {
    return watchMode ? "realistic-click" : "click";
  }

  if (params?.url?.trim() || extractFirstUrl(messageText)) {
    return params?.id ? "navigate" : "open";
  }

  return "state";
}

function normalizeBrowserAction(
  action: BrowserActionParameters["action"] | undefined,
): NormalizedBrowserAction | undefined {
  switch (action) {
    case "realistic_click":
      return "realistic-click";
    case "realistic_fill":
      return "realistic-fill";
    case "realistic_type":
      return "realistic-type";
    case "realistic_press":
      return "realistic-press";
    case "cursor_move":
      return "cursor-move";
    case "cursor_hide":
      return "cursor-hide";
    case "autofill_login":
      return "autofill-login";
    case "scroll_into":
      return "scrollinto";
    case "wait_for_url":
    case "wait-for-url":
      return "wait-for-url";
    default:
      return action as NormalizedBrowserAction | undefined;
  }
}

function normalizeLegacyBrowserAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserWorkspaceCommand["subaction"] | undefined {
  const normalizedAction = normalizeBrowserAction(action);
  switch (normalizedAction) {
    case "info":
    case "context":
    case "get_context":
      return "state";
    case "list_tabs":
    case "open_tab":
    case "close_tab":
    case "switch_tab":
      return "tab";
    // `clear` is fill-with-empty-value; the handler blanks the text so the
    // workspace replaces (never appends to) the control's current value.
    case "clear":
      return "fill";
    case "autofill-login":
    case "wait-for-url":
      return undefined;
    case undefined:
      return undefined;
    default:
      return isWorkspaceSubaction(normalizedAction)
        ? normalizedAction
        : undefined;
  }
}

function isWorkspaceSubaction(
  action: unknown,
): action is BrowserWorkspaceCommand["subaction"] {
  return (
    action === "back" ||
    action === "click" ||
    action === "close" ||
    action === "drag" ||
    action === "fill" ||
    action === "hover" ||
    action === "scroll" ||
    action === "scrollinto" ||
    action === "forward" ||
    action === "get" ||
    action === "hide" ||
    action === "navigate" ||
    action === "open" ||
    action === "press" ||
    action === "reload" ||
    action === "screenshot" ||
    action === "show" ||
    action === "snapshot" ||
    action === "state" ||
    action === "tab" ||
    action === "type" ||
    action === "wait" ||
    action === "realistic-click" ||
    action === "realistic-fill" ||
    action === "realistic-type" ||
    action === "realistic-press" ||
    action === "cursor-move" ||
    action === "cursor-hide"
  );
}

function normalizeLegacyTabAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserActionParameters["tabAction"] | undefined {
  switch (normalizeBrowserAction(action)) {
    case "list_tabs":
      return "list";
    case "open_tab":
      return "new";
    case "close_tab":
      return "close";
    case "switch_tab":
      return "switch";
    default:
      return undefined;
  }
}

function formatBrowserDestination(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return url;
    }
    const host = parsed.host.replace(/^www\./i, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    // error-policy:J3 Browser services may surface non-URL targets; preserve
    // their explicit value instead of fabricating a normalized destination.
    return url;
  }
}

function formatBrowserSessionResult(
  command: BrowserWorkspaceCommand,
  result: Awaited<ReturnType<typeof executeBrowserWorkspaceCommand>>,
): string {
  if (result.tabs) {
    const labels = result.tabs
      .map((tab) => `- ${tab.title} (${tab.url})`)
      .join("\n");
    return labels
      ? `Browser tabs (${result.mode}):\n${labels}`
      : `No browser session tabs are open (${result.mode}).`;
  }

  if (result.closed) {
    return `Browser closed (${result.mode}).`;
  }

  // Interaction receipts stay grounded in the executed command and, when the
  // backend reports it, the actually-affected tab — never the requested label.
  const affectedTab = result.tab
    ? ` on ${result.tab.title} (${formatBrowserDestination(result.tab.url)})`
    : "";
  switch (command.subaction) {
    case "scroll":
      return `Scrolled ${command.direction ?? "down"}${
        command.selector ? ` in ${command.selector}` : ""
      }${affectedTab} (${result.mode}).`;
    case "scrollinto":
      return `Scrolled ${command.selector ?? "the target"} into view${affectedTab} (${result.mode}).`;
    case "hover":
      return `Hovering over ${command.selector ?? "the target"}${affectedTab} (${result.mode}).`;
    case "drag":
      return `Dragged ${command.selector ?? "the source"} to ${
        command.value ?? "the target"
      }${affectedTab} (${result.mode}).`;
    case "fill":
      return command.value
        ? `Filled ${command.selector ?? "the field"}${affectedTab} (${result.mode}).`
        : `Cleared ${command.selector ?? "the field"}${affectedTab} (${result.mode}).`;
    default:
      break;
  }

  if (result.tab) {
    if (command.subaction === "open" || command.subaction === "navigate") {
      return `Opened ${formatBrowserDestination(result.tab.url)}.`;
    }
    return `${command.subaction} completed in ${result.mode} mode.\n${result.tab.title}\n${result.tab.url}`;
  }

  if (result.value !== undefined) {
    if (
      command.subaction === "cursor-move" &&
      result.value !== null &&
      typeof result.value === "object" &&
      "x" in result.value &&
      "y" in result.value
    ) {
      const cursor = result.value as { x: number; y: number };
      return `Cursor moved to (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) in ${result.mode} mode.`;
    }
    const serialized =
      typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2);
    return `Browser ${command.subaction} result (${result.mode}):\n${serialized}`;
  }

  if (result.snapshot?.data) {
    return `Browser ${command.subaction} captured a preview in ${result.mode} mode.`;
  }

  return `Browser ${command.subaction} completed in ${result.mode} mode.`;
}

/**
 * Effect-only commands can own a concise terminal acknowledgement once their
 * browser receipt exists. Read/inspection commands remain non-terminal so the
 * planner can interpret their data instead of exposing a raw state dump.
 * Multi-step plans remain safe because the planner gate also requires one
 * completed tool and an empty queue before honoring `turnComplete`.
 */
function browserCommandOwnsTerminalReply(
  command: BrowserWorkspaceCommand,
): boolean {
  switch (command.subaction) {
    case "back":
    case "close":
    case "forward":
    case "hide":
    case "navigate":
    case "open":
    case "reload":
    case "show":
      return true;
    case "tab":
      return command.tabAction !== undefined && command.tabAction !== "list";
    default:
      return false;
  }
}

function browserProgressRationale(
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
): string {
  const explicit = params?.rationale?.trim();
  if (explicit) return explicit;

  switch (command.subaction) {
    case "open":
    case "navigate":
      return command.url ? `open ${command.url}` : "open requested page";
    case "click":
    case "realistic-click":
      return command.selector
        ? `click ${command.selector}`
        : "click requested target";
    case "type":
    case "realistic-fill":
    case "realistic-type":
      return command.selector
        ? `fill ${command.selector}`
        : "type requested text";
    case "fill":
      return command.selector
        ? `${command.value ? "fill" : "clear"} ${command.selector}`
        : "fill requested field";
    case "hover":
      return command.selector
        ? `hover over ${command.selector}`
        : "hover over requested target";
    case "drag":
      return command.selector
        ? `drag ${command.selector}`
        : "drag requested element";
    case "scroll":
    case "scrollinto":
      return command.selector
        ? `scroll ${command.selector}`
        : `scroll ${command.direction ?? "down"}`;
    case "press":
    case "realistic-press":
      return command.key ? `press ${command.key}` : "press requested key";
    case "tab":
      return command.tabAction
        ? `${command.tabAction} browser tab`
        : "manage browser tabs";
    case "wait":
      return command.selector
        ? `wait for ${command.selector}`
        : "wait for browser state";
    case "state":
      return messageText.trim() || "read browser state";
    default:
      return `run browser ${command.subaction}`;
  }
}

function buildBrowserStepProgressContent(
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
  success: boolean,
  error?: string,
): Content {
  const rationale = error
    ? `failed: ${error}`
    : browserProgressRationale(command, params, messageText);
  return {
    text: `Step 1: ${command.subaction} — ${rationale}`,
    source: "action_progress",
    merge: "replace",
    metadata: {
      transient: true,
      compactProgress: true,
      progress: {
        source: "browser",
        actionName: "BROWSER",
        step: 1,
        kind: command.subaction,
        rationale,
        success,
        error,
      },
    },
  };
}

async function emitBrowserStepProgress(
  callback: HandlerCallback | undefined,
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
  success: boolean,
  error?: string,
): Promise<void> {
  if (params?.streamProgress !== true || !callback) return;
  try {
    await callback(
      buildBrowserStepProgressContent(
        command,
        params,
        messageText,
        success,
        error,
      ),
      "BROWSER",
    );
  } catch (callbackError) {
    logger.warn(
      {
        src: "plugin:browser",
        action: command.subaction,
        error:
          callbackError instanceof Error
            ? callbackError.message
            : String(callbackError),
      },
      "Failed to emit browser progress callback",
    );
  }
}

function currentUrlFromResult(
  result: BrowserWorkspaceCommandResult,
): string | null {
  if (result.tab?.url) {
    return result.tab.url;
  }
  if (typeof result.value === "string" && result.value.trim()) {
    return result.value.trim();
  }
  if (Array.isArray(result.tabs)) {
    const visible = result.tabs.find((tab) => tab.visible) ?? result.tabs[0];
    if (visible?.url) {
      return visible.url;
    }
  }
  return null;
}

/**
 * Reads the current tab URL via the active browser target. Prefers a targeted
 * `get url` (cheap), falling back to `state` for backends that don't implement
 * the get-url mode. Returns null when the URL is not yet readable.
 */
async function readCurrentBrowserUrl(
  browserService: BrowserService | null,
  target: BrowserTarget | undefined,
  tabId: string | undefined,
): Promise<string | null> {
  const run = async (
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> =>
    browserService
      ? browserService.execute(command, target)
      : executeBrowserWorkspaceCommand(command);

  try {
    const got = await run({
      subaction: "get",
      getMode: "url",
      id: tabId,
    });
    const url = currentUrlFromResult(got);
    if (url) {
      return url;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url get-url poll failed, falling back to state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const state = await run({ subaction: "state", id: tabId });
    const url = currentUrlFromResult(state);
    if (url) {
      return url;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url state poll could not read URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const tabs = await run({ subaction: "list" });
    if (Array.isArray(tabs.tabs)) {
      const tab = tabId
        ? tabs.tabs.find((entry) => entry.id === tabId)
        : (tabs.tabs.find((entry) => entry.visible) ?? tabs.tabs[0]);
      return tab?.url ?? null;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url tab-list poll could not read URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return null;
}

/**
 * Handles `action: "wait_for_url"`. Optionally opens/navigates to a starting
 * URL, tells the user it is watching, then polls the tab URL against `pattern`,
 * streaming a status update each poll. Resolves with a typed success/timeout
 * result and never throws on timeout.
 */
async function executeBrowserWaitForUrl(
  runtime: Parameters<NonNullable<Action["handler"]>>[0],
  params: BrowserActionParameters | undefined,
  messageText: string,
  callback: HandlerCallback | undefined,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const pattern = (params?.pattern ?? "").trim();
  if (!pattern) {
    const text =
      "wait_for_url needs a `pattern` (substring or regex) to watch for.";
    logger.warn(`[BROWSER] ${text}`);
    return {
      text,
      success: false,
      values: { success: false, error: "BROWSER_WAIT_FOR_URL_NO_PATTERN" },
      data: { actionName: "BROWSER", subaction: "wait_for_url" },
    };
  }

  const browserService =
    runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE) ?? null;
  const target = params?.target;
  const startUrl =
    params?.url?.trim() || extractFirstUrl(messageText) || undefined;
  const timeoutMs = params?.timeoutMs ?? WAIT_FOR_URL_DEFAULT_TIMEOUT_MS;
  const pollIntervalMs =
    params?.pollIntervalMs ?? WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS;

  let tabId = params?.id?.trim() || undefined;

  // Optionally launch the starting URL so the user can act on it.
  if (startUrl) {
    const openCommand: BrowserWorkspaceCommand = {
      subaction: tabId ? "navigate" : "open",
      url: startUrl,
      id: tabId,
    };
    try {
      const opened = browserService
        ? await browserService.execute(openCommand, target)
        : await executeBrowserWorkspaceCommand(openCommand);
      tabId = opened.tab?.id ?? tabId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[BROWSER] wait_for_url could not open ${startUrl}: ${reason}`,
      );
      return {
        text: `Couldn't open ${startUrl} to watch for "${pattern}": ${reason}`,
        success: false,
        values: { success: false, error: "BROWSER_WAIT_FOR_URL_OPEN_FAILED" },
        data: { actionName: "BROWSER", subaction: "wait_for_url" },
      };
    }
  }

  await callback?.({
    text: startUrl
      ? `I opened ${startUrl} — watching for "${pattern}" and I'll resume when it's reached.`
      : `Watching the current tab for "${pattern}" — I'll resume when it's reached.`,
  });

  logger.info(
    `[BROWSER] wait_for_url pattern="${pattern}" timeoutMs=${timeoutMs} pollIntervalMs=${pollIntervalMs} target=${target ?? "auto"}`,
  );

  const outcome = await waitForUrl(
    { pattern, timeoutMs, pollIntervalMs },
    {
      getCurrentUrl: () => readCurrentBrowserUrl(browserService, target, tabId),
      emitStatus: async (text) => {
        await callback?.({ text });
      },
    },
  );

  return {
    text: outcome.message,
    success: outcome.matched,
    userFacingText: outcome.message,
    values: {
      success: outcome.matched,
      subaction: "wait_for_url",
      status: outcome.status,
      matched: outcome.matched,
      polls: outcome.polls,
    },
    data: {
      actionName: "BROWSER",
      subaction: "wait_for_url",
      outcome,
    },
  };
}

export const browserAction: Action = {
  name: "BROWSER",
  contexts: ["browser", "web", "automation", "secrets"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "BROWSE_SITE",
    "BROWSER_SESSION",
    "CONTROL_BROWSER",
    "CONTROL_BROWSER_SESSION",
    "MANAGE_ELIZA_BROWSER_WORKSPACE",
    "NAVIGATE_SITE",
    "OPEN_SITE",
    "USE_BROWSER",
    "BROWSER_ACTION",
    "BROWSER_GET_CONTEXT",
    "BROWSER_GET_PAGE_STATE",
    "BROWSER_READ_PAGE",
    "BROWSER_SNAPSHOT",
    "BROWSER_AUTOFILL_LOGIN",
    "AGENT_AUTOFILL",
    "AUTOFILL_BROWSER_LOGIN",
    "AUTOFILL_LOGIN",
    "FILL_BROWSER_CREDENTIALS",
    "LOG_INTO_SITE",
    "SIGN_IN_TO_SITE",
  ],
  description:
    "BROWSER action. Control registered browser target: app workspace, bridge Chrome/Firefox/Safari companion, computeruse Chromium, or Stagehand fallback. BrowserService picks target if omitted. Read the current page with action=snapshot (page text and elements) or action=state (page state). action=get reads one element and requires selector; it does not read the whole page when selector is omitted. Interaction: click, type (append), fill (replace), clear, press, scroll (direction/pixels, optional selector), hover, drag (selector -> targetSelector). action=autofill_login + domain vault-gated autofills open workspace tab. action=wait_for_url + pattern opens an optional url then watches the tab and resumes when its URL matches (OAuth callback, deploy/CI done), streaming progress.",
  descriptionCompressed:
    "Browser open|navigate|click|type|fill|clear|scroll|hover|drag; snapshot/state read page; get requires selector; screenshot|autofill_login|wait_for_url; bridge status elsewhere",
  routingHint:
    "drive an INTERACTIVE web browser session — navigate/click/type across pages, log into a site, or autofill saved credentials on a real browser target -> BROWSER; Eliza app navigation (home, Notes, Calendar, etc.) uses VIEWS, not website navigation; never invent a domain from an app navigation request; to fetch ONE URL's contents in a single shot -> WEB_FETCH, to answer an open-web question -> WEB_SEARCH, or to control native desktop apps/Finder/windows on the machine -> COMPUTER_USE",
  // Wait for the browser result before the model writes its reply. A speculative
  // Stage-1 acknowledgement would race the result and duplicate text/voice.
  suppressEarlyReply: true,
  validate: async () => true,
  handler: async (
    runtime,
    message,
    _state,
    options,
    callback?: HandlerCallback,
  ) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | BrowserActionParameters
      | undefined;
    const messageText = getMessageText(message);
    const subaction = inferBrowserSubaction(params, messageText);
    const nativePage =
      asRecord(message.content.metadata)?.uiBrowserSurface === "native";

    if (
      nativePage &&
      (subaction === "autofill-login" || subaction === "wait-for-url")
    ) {
      return {
        success: false,
        transcriptVisibility: "internal",
        text: "This operation is not supported on the requesting native Browser. No Mac browser operation was dispatched.",
      };
    }

    if (subaction === "get" && params?.url?.trim()) {
      return {
        success: false,
        transcriptVisibility: "internal",
        text: "BROWSER action=get reads an element on the current page and does not accept url. No read was dispatched. First use action=navigate with the requested url, wait for its result, then use action=get with selector and no url.",
      };
    }

    if (subaction === "autofill-login") {
      const { executeBrowserAutofillLogin } = await import(
        "./browser-autofill-login.js"
      );
      return executeBrowserAutofillLogin(runtime, message, options);
    }

    if (subaction === "wait-for-url") {
      return executeBrowserWaitForUrl(runtime, params, messageText, callback);
    }

    const url =
      params?.url?.trim() || extractFirstUrl(messageText) || undefined;

    // `clear` arrives as fill; blank the value so the workspace replaces the
    // control's contents instead of appending. Drag carries its drop target
    // in `value` per the workspace contract.
    const clearRequested = normalizeBrowserAction(params?.action) === "clear";
    const commandValue =
      subaction === "drag"
        ? params?.targetSelector?.trim() || params?.text
        : clearRequested
          ? ""
          : params?.text;

    const command: BrowserWorkspaceCommand = {
      id: params?.id?.trim(),
      key: params?.key?.trim(),
      pixels: params?.pixels,
      script: params?.script,
      selector: params?.selector?.trim(),
      // “Open” is a user-facing navigation request, so its receipt must name
      // the page the user can actually see. Background creation remains
      // available through the lower-level workspace API for preloading.
      show: subaction === "open" ? true : undefined,
      subaction,
      tabAction: params?.tabAction ?? normalizeLegacyTabAction(params?.action),
      direction: params?.direction,
      text: clearRequested ? "" : params?.text,
      value: commandValue,
      timeoutMs: params?.timeoutMs,
      url,
      cursorDurationMs: params?.cursorDurationMs,
      perCharDelayMs: params?.perCharDelayMs,
      replace: params?.replace,
      x: params?.x,
      y: params?.y,
    };

    const browserService =
      runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE);

    try {
      const nativeClientId = nativePage
        ? readViewInteractionClientId(message)
        : undefined;
      if (nativePage && (!nativeClientId || !browserService)) {
        throw new Error(
          "The requesting native Browser client is unavailable; cannot substitute the Mac page.",
        );
      }
      logger.info(
        `[BROWSER] ${command.subaction} via target=${params?.target ?? "auto"} (workspace mode=${getBrowserWorkspaceMode(process.env)})`,
      );
      const result = browserService
        ? await browserService.execute(command, params?.target, nativeClientId)
        : await executeBrowserWorkspaceCommand(command);
      const ownsTerminalReply = browserCommandOwnsTerminalReply(command);
      if (!ownsTerminalReply) {
        await emitBrowserStepProgress(
          callback,
          command,
          params,
          messageText,
          true,
        );
      }

      const text = formatBrowserSessionResult(command, result);
      return {
        text,
        ...(ownsTerminalReply
          ? {
              turnComplete: true,
              modelReplyRequired: true,
            }
          : {}),
        success: true,
        values: {
          success: true,
          mode: result.mode,
          subaction: result.subaction,
          ...(result.targetId ? { targetId: result.targetId } : {}),
          ...(result.targetId === "workspace" &&
          (subaction === "open" ||
            subaction === "navigate" ||
            subaction === "show")
            ? { viewId: "browser", viewPath: "/browser" }
            : {}),
          // Ground the receipt in the tab the backend actually affected.
          ...(result.tab
            ? {
                tabId: result.tab.id,
                url: result.tab.url,
                title: result.tab.title,
              }
            : {}),
        },
        data: {
          actionName: "BROWSER",
          command,
          result,
        },
      };
    } catch (error) {
      const errorText =
        error instanceof Error ? error.message : "Browser action failed";

      // Preserve the typed dispatch failure state (issue #18258 review):
      // The service layer distinguishes UNSUPPORTED/UNAVAILABLE (safe
      // pre-dispatch declines — OK to try a different approach) from
      // UNCERTAIN_OUTCOME (a side-effecting command may have partially
      // executed — must NOT be retried). Collapsing everything to
      // "BROWSER_FAILED" drops this distinction at the action boundary,
      // so the planner/action consumer cannot tell safe declines from
      // outcomes that must not be retried.
      const dispatchFailure: BrowserDispatchFailure | null =
        isBrowserDispatchFailure(error) ? error : null;

      logger.warn(
        `[BROWSER] Failed: ${errorText}${dispatchFailure ? ` (kind=${dispatchFailure.kind}, target=${dispatchFailure.targetId ?? "none"}, fallbackSafe=${dispatchFailure.fallbackSafe})` : ""}`,
      );
      await emitBrowserStepProgress(
        callback,
        command,
        params,
        messageText,
        false,
        errorText,
      );
      return {
        text: `Browser action failed: ${errorText}`,
        success: false,
        values: {
          success: false,
          error: dispatchFailure?.kind ?? "BROWSER_FAILED",
          ...(dispatchFailure
            ? {
                dispatchKind: dispatchFailure.kind,
                fallbackSafe: dispatchFailure.fallbackSafe,
                targetId: dispatchFailure.targetId,
              }
            : {}),
        },
        data: {
          actionName: "BROWSER",
          command,
          ...(dispatchFailure
            ? {
                dispatchFailure: {
                  kind: dispatchFailure.kind,
                  fallbackSafe: dispatchFailure.fallbackSafe,
                  targetId: dispatchFailure.targetId,
                  message: dispatchFailure.message,
                },
              }
            : {}),
        },
      };
    }
  },
  parameters: [
    {
      name: "target",
      description:
        "Optional backend override. Omit (or use an empty string) for automatic selection among available targets. For the tabs shown in browser_workspace use workspace. Pin another target only when the user requested that surface and live context confirms it is available; registered does not mean connected.",
      required: false,
      modelOmissionSentinels: [""],
      schema: { type: "string" as const },
    },
    {
      name: "streamProgress",
      description:
        "When true, emit a compact Step 1 progress callback after the browser command dispatches.",
      required: false,
      schema: { type: "boolean" as const, default: false },
    },
    {
      name: "rationale",
      description: "Optional rationale shown in streamProgress callback text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "action",
      description:
        "Browser action. Use snapshot to read the current page's text and headings, state for page state, or get with selector to read one element. Snake_case canonical; legacy kebab-case and subaction accepted.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "back",
          "clear",
          "click",
          "close",
          "context",
          "drag",
          "fill",
          "forward",
          "get",
          "get_context",
          "hide",
          "hover",
          "info",
          "list_tabs",
          "navigate",
          "open",
          "open_tab",
          "press",
          "reload",
          "screenshot",
          "scroll",
          "scroll_into",
          "show",
          "snapshot",
          "state",
          "tab",
          "type",
          "wait",
          "close_tab",
          "switch_tab",
          "realistic_click",
          "realistic_fill",
          "realistic_type",
          "realistic_press",
          "cursor_move",
          "cursor_hide",
          "autofill_login",
          "wait_for_url",
        ],
      },
    },
    {
      name: "pattern",
      subactions: ["wait_for_url"],
      description:
        "For action=wait_for_url: substring or /regex/ to match the tab URL (e.g. callback?code=, or /\\/done$/).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "pollIntervalMs",
      subactions: ["wait_for_url"],
      description: "For action=wait_for_url: poll cadence in ms. Default 2000.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "tabAction",
      subactions: ["tab", "list_tabs", "open_tab", "close_tab", "switch_tab"],
      description: "Tab operation when subaction is tab",
      required: false,
      modelOmissionSentinels: [""],
      schema: {
        type: "string" as const,
        enum: ["close", "list", "new", "switch"],
      },
    },
    {
      name: "domain",
      subactions: ["autofill_login"],
      description:
        "Required for action=autofill_login: registrable hostname, e.g. github.com.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "username",
      subactions: ["autofill_login"],
      description: "For autofill-login: saved login username; omit for latest.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "submit",
      subactions: ["autofill_login"],
      description: "For autofill-login: submit after filling. Default false.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "id",
      description: "Session or tab id to target",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "url",
      description:
        "Website URL for open or navigate, grounded in the user's requested website or observed page links. Not accepted by get: navigate first, then read the current page without url. Do not invent a URL from an Eliza app navigation command; app screens use VIEWS.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "selector",
      description:
        "Element selector for click, type, wait, or get. Required for get (for example h1); use snapshot instead when reading the whole page.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Text for type",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "key",
      subactions: ["press", "realistic_press"],
      description: "Keyboard key for press",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "pixels",
      subactions: ["scroll"],
      description: "Scroll distance in pixels for action=scroll. Default 240.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "direction",
      subactions: ["scroll"],
      description: "Scroll direction for action=scroll. Default down.",
      required: false,
      modelOmissionSentinels: [""],
      schema: {
        type: "string" as const,
        enum: ["down", "left", "right", "up"],
      },
    },
    {
      name: "targetSelector",
      subactions: ["drag"],
      description:
        "Drop-target selector for action=drag; source comes from selector.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timeoutMs",
      description: "Command timeout in milliseconds",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "script",
      subactions: ["wait"],
      description: "Script for eval",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "watchMode",
      description:
        "User watching hint; prefer realistic-* click/fill, visible cursor, pointer events.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "cursorDurationMs",
      subactions: [
        "click",
        "fill",
        "type",
        "press",
        "realistic_click",
        "realistic_fill",
        "realistic_type",
        "realistic_press",
        "cursor_move",
        "cursor_hide",
      ],
      description: "Cursor animation duration (ms) for realistic-* subactions",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "perCharDelayMs",
      subactions: ["fill", "type", "realistic_fill", "realistic_type"],
      description: "Per-character delay for realistic-type/realistic-fill (ms)",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "replace",
      subactions: ["fill", "clear", "type", "realistic_fill", "realistic_type"],
      description: "For realistic-fill: replace existing input, not append.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "x",
      subactions: ["cursor_move"],
      description: "Cursor target X (CSS pixels) for cursor-move",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "y",
      subactions: ["cursor_move"],
      description: "Cursor target Y (CSS pixels) for cursor-move",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open elizaos.ai in a new browser tab.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opened elizaos.ai.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Click the sign-in button on that page.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "click completed in desktop mode.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open the GitHub OAuth page and let me know when it redirects back to our callback.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I opened https://github.com/login/oauth/authorize — watching for \"callback?code=\" and I'll resume when it's reached.",
          actions: ["BROWSER"],
        },
      },
    ],
  ] as ActionExample[][],
};
