/**
 * Shared browser workspace utilities for command normalization, tabs, URLs,
 * and workspace-rooted file reads/writes.
 *
 * Command `filePath` / `outputPath` / `baselinePath` values are confined with a
 * realpath ancestor walk so a symlink parent cannot smuggle a write or state
 * load outside the process working directory.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createBrowserWorkspaceError } from "./browser-workspace-errors.js";
import { resolveBrowserWorkspaceElementRef } from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceMode,
  BrowserWorkspaceSubaction,
} from "./browser-workspace-types.js";

export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_WAIT_INTERVAL_MS = 120;
export const DEFAULT_WEB_PARTITION = "persist:eliza-browser";
export const CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX =
  "persist:connector-";
export const DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE =
  "Eliza browser workspace desktop bridge is unavailable.";
export const browserWorkspacePageFetch = globalThis.fetch.bind(globalThis);

/**
 * Page fetch with a hop deadline, so a host that accepts the connection and
 * never answers cannot pin a browser workspace command indefinitely.
 *
 * A caller-provided abort signal composes with the deadline rather than
 * replacing it: the caller can still cancel early, and the bound still applies
 * when the caller's signal never fires.
 */
export async function browserWorkspaceBoundedPageFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return browserWorkspacePageFetch(url, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

export function normalizeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeBrowserWorkspaceText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Page prose only; raw HTML remains available through the explicit html read. */
export function readBrowserWorkspaceElementText(
  element: Element | null,
): string {
  if (!element || element.closest("script, style, template")) return "";
  // SHOW_TEXT: walk without cloning or modifying the document being controlled.
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const text: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("script, style, template")) {
      text.push(node.nodeValue ?? "");
    }
  }
  return normalizeBrowserWorkspaceText(text.join(""));
}

/** Ambient page context may describe these controls, but must not copy values. */
export function isBrowserWorkspacePrivateControl(element: Element): boolean {
  return (
    element.tagName === "INPUT" &&
    ["password", "hidden"].includes((element as HTMLInputElement).type)
  );
}

export function parseBrowserWorkspaceNumberLike(
  value: unknown,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function assertBrowserWorkspaceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "about:blank") {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createBrowserWorkspaceError(
      "invalid_url",
      "url_validation",
      `browser workspace rejected invalid URL: ${rawUrl}`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createBrowserWorkspaceError(
      "invalid_url",
      "url_validation",
      `browser workspace only supports http/https URLs, got ${parsed.protocol}`,
    );
  }

  return parsed.toString();
}

export function inferBrowserWorkspaceTitle(url: string): string {
  if (url === "about:blank") {
    return "New Tab";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Eliza Browser";
  } catch {
    return "Eliza Browser";
  }
}

function normalizeConnectorBrowserWorkspaceSegment(
  value: string,
  fieldName: string,
): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  const normalized = slug.slice(start, end).slice(0, 64);
  if (!normalized) {
    throw new Error(`Eliza browser connector session requires ${fieldName}.`);
  }
  return normalized;
}

function hashConnectorBrowserWorkspacePartitionKey(
  provider: string,
  accountId: string,
): string {
  const input = `${provider.trim().toLowerCase()}\0${accountId.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

export function resolveConnectorBrowserWorkspacePartition(
  provider: string,
  accountId: string,
): string {
  const providerSegment = normalizeConnectorBrowserWorkspaceSegment(
    provider,
    "provider",
  );
  const accountSegment = normalizeConnectorBrowserWorkspaceSegment(
    accountId,
    "accountId",
  );
  const suffix = hashConnectorBrowserWorkspacePartitionKey(provider, accountId);
  return `${CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX}${providerSegment}-${accountSegment}-${suffix}`;
}

export function isConnectorBrowserWorkspacePartition(
  partition: string | null | undefined,
): boolean {
  return (partition ?? "")
    .trim()
    .toLowerCase()
    .startsWith(CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX);
}

export function resolveBrowserWorkspaceCommandPartition(
  command: Pick<
    BrowserWorkspaceCommand,
    "connectorAccountId" | "connectorProvider" | "partition"
  >,
  fallbackPartition: string,
): string {
  const explicitPartition = command.partition?.trim();
  if (explicitPartition) {
    return explicitPartition;
  }
  const provider = command.connectorProvider?.trim();
  const accountId = command.connectorAccountId?.trim();
  if (provider && accountId) {
    return resolveConnectorBrowserWorkspacePartition(provider, accountId);
  }
  return fallbackPartition;
}

export function assertBrowserWorkspaceConnectorSecretsNotExported(
  partition: string | null | undefined,
  operation: string,
): void {
  if (!isConnectorBrowserWorkspacePartition(partition)) {
    return;
  }
  throw createBrowserWorkspaceError(
    "connector_secret_export_forbidden",
    operation,
    `Connector browser sessions do not allow raw cookie, token, storage, or state export (${operation}). Use the returned partition/profile/session handle instead.`,
  );
}

export function createBrowserWorkspaceDesktopOnlyMessage(
  subaction: BrowserWorkspaceSubaction,
): string {
  return `Eliza browser workspace ${subaction} is only available in the desktop app.`;
}

export function createBrowserWorkspaceNotFoundError(tabId: string): Error {
  return createBrowserWorkspaceError(
    "tab_not_found",
    "tab_lookup",
    `Browser workspace request failed (404): Tab ${tabId} was not found.`,
  );
}

export function createBrowserWorkspaceCommandTargetError(
  subaction: BrowserWorkspaceSubaction,
): Error {
  return createBrowserWorkspaceError(
    "target_missing",
    subaction,
    `Eliza browser workspace ${subaction} requires a current tab. Open or show a tab first, or pass an explicit id.`,
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Separator-aware containment: `..safe.js` is a sibling name, not a traversal.
 * Compare realpaths so macOS `/var` vs `/private/var` is not a false escape.
 */
export function isWithinBrowserWorkspaceRoot(
  child: string,
  parent: string,
): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Realpath the longest existing ancestor, then rejoin the missing tail so a
 * workspace symlink-to-elsewhere cannot hide behind a not-yet-created basename.
 */
export function resolveBrowserWorkspaceRealPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // error-policy:J3 missing leaf — walk up to the longest existing prefix.
  }
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    try {
      return path.join(fs.realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}

/**
 * Confine a command-supplied filesystem path to `root` (default: process cwd).
 * Rejects UNC, NUL, empty, lexical `..`, and symlink-parent escapes.
 */
export function resolveBrowserWorkspaceFilePath(
  filePath: string,
  root: string = process.cwd(),
): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected an empty file path",
    );
  }
  if (trimmed.includes("\0")) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected a NUL in file path",
    );
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected a UNC file path",
    );
  }
  const rootReal = resolveBrowserWorkspaceRealPath(root);
  const resolved = resolveBrowserWorkspaceRealPath(trimmed);
  if (
    resolved !== rootReal &&
    !isWithinBrowserWorkspaceRoot(resolved, rootReal)
  ) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      `browser workspace file path escapes the workspace root: ${trimmed}`,
    );
  }
  return resolved;
}

export async function writeBrowserWorkspaceFile(
  filePath: string,
  contents: string | Uint8Array,
  root: string = process.cwd(),
): Promise<string> {
  const resolved = resolveBrowserWorkspaceFilePath(filePath, root);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, contents);
  return resolved;
}

export function normalizeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
): BrowserWorkspaceCommand {
  const raw = command as BrowserWorkspaceCommand & Record<string, unknown>;
  // A trimmed-empty `subaction` is absent, not a value: fall back to
  // `operation` before resolving so whitespace cannot mask a valid alias.
  // Precedence is explicit — a non-empty `subaction` always wins over
  // `operation`; the raw `command.subaction` is only restored when neither
  // yields a usable token, preserving the executor's unsupported-subaction
  // diagnostic.
  const trimmedSubaction =
    typeof raw.subaction === "string" ? raw.subaction.trim().toLowerCase() : "";
  const trimmedOperation =
    typeof raw.operation === "string" ? raw.operation.trim().toLowerCase() : "";
  const normalizedSubaction = trimmedSubaction || trimmedOperation;
  const subaction =
    normalizedSubaction === "goto"
      ? "navigate"
      : normalizedSubaction === "read"
        ? "get"
        : ((normalizedSubaction ||
            command.subaction) as BrowserWorkspaceSubaction);
  const timeoutMs =
    parseBrowserWorkspaceNumberLike(command.timeoutMs) ??
    parseBrowserWorkspaceNumberLike(raw.ms) ??
    parseBrowserWorkspaceNumberLike(raw.milliseconds);

  return {
    ...command,
    subaction,
    timeoutMs,
    steps: Array.isArray(command.steps)
      ? command.steps.map((step) => normalizeBrowserWorkspaceCommand(step))
      : command.steps,
  };
}

export function resolveBrowserWorkspaceCommandElementRefs(
  command: BrowserWorkspaceCommand,
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceCommand {
  const selector = command.selector?.trim();
  if (!selector) {
    return command;
  }

  const match = selector.match(/^(@e\d+)([\s\S]*)$/i);
  if (!match?.[1]) {
    return command;
  }

  const resolvedSelector = resolveBrowserWorkspaceElementRef(
    mode,
    tabId,
    match[1],
  );
  if (!resolvedSelector) {
    throw createBrowserWorkspaceError(
      "unknown_element_ref",
      "element_ref",
      `Unknown browser snapshot element ref ${match[1]}. Run snapshot or inspect again before reusing element refs.`,
    );
  }

  return {
    ...command,
    selector: `${resolvedSelector}${match[2] ?? ""}`,
  };
}

export function buildBrowserWorkspaceCssStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** GHSA-mhhr-9ph9-64j7 / elizaOS/eliza#6767 — arbitrary script must not run in Node (JSDOM). */
export const BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN =
  "Browser workspace arbitrary script execution is disabled in the JSDOM (web) backend because it runs in the Node.js agent process via unsafe eval patterns (GHSA-mhhr-9ph9-64j7). Use structured subactions (click, fill, get, wait on selector/url/text) or desktop browser workspace mode instead.";

export const BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN =
  "Browser workspace arbitrary user script is disabled (GHSA-mhhr-9ph9-64j7). Use structured browser workspace subactions instead.";

export function isBrowserWorkspaceUserScriptAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = normalizeEnvValue(
    env.ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT,
  )?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function assertBrowserWorkspaceUserScriptAllowed(
  script: string | undefined,
  context: "eval" | "wait",
  mode: BrowserWorkspaceMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!script?.trim()) {
    return;
  }
  if (mode === "web") {
    throw createBrowserWorkspaceJsdomScriptExecutionError(context);
  }
  if (!isBrowserWorkspaceUserScriptAllowed(env)) {
    const suffix =
      context === "eval"
        ? "Eval subactions with a user `script` are disabled by default."
        : "Wait conditions with a user `script` are disabled by default.";
    throw createBrowserWorkspaceError(
      "script_forbidden",
      context,
      `${BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN} ${suffix} Set ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT=1 only on trusted single-user hosts.`,
    );
  }
}

export function createBrowserWorkspaceJsdomScriptExecutionError(
  context: "eval" | "wait",
): Error {
  const suffix =
    context === "eval"
      ? "Eval subactions are not supported on the web backend."
      : "Wait conditions with `script` are not supported on the web backend.";
  return createBrowserWorkspaceError(
    "script_forbidden",
    context,
    `${BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN} ${suffix}`,
  );
}

export function assertBrowserWorkspaceJsdomScriptNotRequested(
  script: string | undefined,
  context: "eval" | "wait",
): void {
  if (script?.trim()) {
    throw createBrowserWorkspaceJsdomScriptExecutionError(context);
  }
}
