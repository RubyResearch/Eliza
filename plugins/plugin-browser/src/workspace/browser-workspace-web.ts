/**
 * Web-mode browser workspace command executor backed by JSDOM documents.
 */

import * as fsp from "node:fs/promises";
import {
  browserWorkspaceTextMatches,
  buildBrowserWorkspaceElementSelector,
  collectBrowserWorkspaceInspectElements,
  createBrowserWorkspaceElementSummary,
  findClosestBrowserWorkspaceForm,
  getBrowserWorkspaceElementBox,
  getBrowserWorkspaceElementStyles,
  getBrowserWorkspaceElementValue,
  isBrowserWorkspaceElementVisible,
  mergeBrowserWorkspaceSelectorCommand,
  queryAllBrowserWorkspaceSelector,
  resolveBrowserWorkspaceElement,
  resolveBrowserWorkspaceFindElement,
  resolveWebBrowserWorkspaceCommandDocument,
} from "./browser-workspace-elements.js";
import {
  activateWebBrowserWorkspaceElement,
  clearWebBrowserWorkspaceTabElementRefs,
  cloneWebBrowserWorkspaceTabState,
  ensureBrowserWorkspaceCheckboxElement,
  ensureBrowserWorkspaceFormControlElement,
  ensureLoadedWebBrowserWorkspaceTabDocument,
  scrollWebBrowserWorkspaceTarget,
  setBrowserWorkspaceControlValue,
  submitWebBrowserWorkspaceForm,
} from "./browser-workspace-forms.js";
import {
  assertBrowserWorkspaceConnectorSecretsNotExported,
  assertBrowserWorkspaceJsdomScriptNotRequested,
  createBrowserWorkspaceCommandTargetError,
  createBrowserWorkspaceJsdomScriptExecutionError,
  createBrowserWorkspaceNotFoundError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  normalizeBrowserWorkspaceText,
  readBrowserWorkspaceElementText,
  resolveBrowserWorkspaceCommandElementRefs,
  resolveBrowserWorkspaceFilePath,
  sleep,
  writeBrowserWorkspaceFile,
} from "./browser-workspace-helpers.js";
import {
  applyBrowserWorkspaceDomSettings,
  ensureBrowserWorkspaceDom,
} from "./browser-workspace-jsdom.js";
import {
  fetchBrowserWorkspaceTrackedResponse,
  normalizeBrowserWorkspaceHeaders,
} from "./browser-workspace-network.js";
import {
  applyBrowserWorkspaceStateToWebDocument,
  buildBrowserWorkspaceDocumentSnapshotText,
  createBrowserWorkspacePdfBuffer,
  createBrowserWorkspaceSnapshotRecord,
  createBrowserWorkspaceSyntheticScreenshotData,
  diffBrowserWorkspaceSnapshots,
  readBrowserWorkspaceCookies,
  readBrowserWorkspaceStorage,
} from "./browser-workspace-snapshots.js";
import {
  browserWorkspaceClipboardText,
  getBrowserWorkspaceRuntimeState,
  getBrowserWorkspaceTimestamp,
  registerBrowserWorkspaceElementRefs,
  setBrowserWorkspaceClipboardText,
  webWorkspaceState,
  withWebStateLock,
} from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceSettingsState,
  WebBrowserWorkspaceTabState,
} from "./browser-workspace-types.js";

/**
 * Safely resolve a JSDOM `Storage` area. The `localStorage` / `sessionStorage`
 * getters themselves throw `SecurityError: localStorage is not available for
 * opaque origins` on `about:blank` (and other opaque-origin documents), so any
 * access must be guarded. Callers that can degrade gracefully use the `null`
 * return; callers that require storage turn `null` into a clear error.
 */
function safeWebStorageArea(getArea: () => Storage): Storage | null {
  try {
    return getArea();
  } catch {
    return null;
  }
}

export function getWebBrowserWorkspaceTabIndex(tabId: string): number {
  return webWorkspaceState.tabs.findIndex((tab) => tab.id === tabId);
}

export function getWebBrowserWorkspaceTabState(
  tabId: string,
): WebBrowserWorkspaceTabState {
  const tab = webWorkspaceState.tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    throw createBrowserWorkspaceNotFoundError(tabId);
  }
  return tab;
}

export function getCurrentWebBrowserWorkspaceTabState(): WebBrowserWorkspaceTabState | null {
  if (webWorkspaceState.tabs.length === 0) {
    return null;
  }

  return (
    webWorkspaceState.tabs.find((tab) => tab.visible) ??
    [...webWorkspaceState.tabs].sort((left, right) => {
      const leftTime = left.lastFocusedAt ?? left.updatedAt ?? "";
      const rightTime = right.lastFocusedAt ?? right.updatedAt ?? "";
      return (
        rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
      );
    })[0] ??
    null
  );
}

export function findWebBrowserWorkspaceTargetTabId(
  command: BrowserWorkspaceCommand,
): string {
  if (command.id?.trim()) {
    return command.id.trim();
  }
  const current = getCurrentWebBrowserWorkspaceTabState();
  if (!current) {
    throw createBrowserWorkspaceCommandTargetError(command.subaction);
  }
  return current.id;
}

export async function executeWebBrowserWorkspaceUtilityCommand(
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult | null> {
  if (command.subaction === "upload") {
    throw new Error(
      "Browser workspace upload requires a proof-producing target and an exact consume-once interaction confirmation.",
    );
  }
  return withWebStateLock(async () => {
    if (
      ![
        "clipboard",
        "console",
        "cookies",
        "diff",
        "dialog",
        "drag",
        "errors",
        "eval",
        "frame",
        "highlight",
        "mouse",
        "network",
        "pdf",
        "screenshot",
        "set",
        "state",
        "storage",
        "trace",
        "profiler",
        "upload",
      ].includes(command.subaction)
    ) {
      return null;
    }

    const id = findWebBrowserWorkspaceTargetTabId(command);
    const tab = getWebBrowserWorkspaceTabState(id);
    const dom = await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
    const runtime = getBrowserWorkspaceRuntimeState("web", id);
    const frameContext = resolveWebBrowserWorkspaceCommandDocument(
      tab,
      dom,
      runtime,
    );
    const document = frameContext.document;
    const resolveTarget = () =>
      resolveBrowserWorkspaceElement(
        document,
        command.selector,
        command.text,
        command,
      );

    switch (command.subaction) {
      case "eval": {
        if (!command.script?.trim()) {
          throw new Error("Eliza browser workspace eval requires script.");
        }
        // GHSA-mhhr-9ph9-64j7 / GHSA-vhvq-g4mq-vq62: never run user script in
        // Node JSDOM — `new Function()` / eval reach process and full DOM forgery.
        throw createBrowserWorkspaceJsdomScriptExecutionError("eval");
      }
      case "screenshot": {
        const data = createBrowserWorkspaceSyntheticScreenshotData(
          tab.title,
          tab.url,
          buildBrowserWorkspaceDocumentSnapshotText(document),
          runtime.settings.viewport ?? undefined,
        );
        runtime.lastScreenshotData = data;
        if (command.filePath?.trim() || command.outputPath?.trim()) {
          const targetPath =
            command.filePath?.trim() || command.outputPath?.trim() || "";
          const resolvedPath = await writeBrowserWorkspaceFile(
            targetPath,
            Buffer.from(data, "base64"),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            snapshot: { data },
            value: { path: resolvedPath },
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          snapshot: { data },
        };
      }
      case "clipboard": {
        const action = command.clipboardAction ?? "read";
        if (action === "read") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        if (action === "write") {
          setBrowserWorkspaceClipboardText(command.value ?? command.text ?? "");
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        if (action === "copy") {
          const target = resolveTarget();
          setBrowserWorkspaceClipboardText(
            target && "value" in (target as HTMLInputElement)
              ? String((target as HTMLInputElement).value ?? "")
              : readBrowserWorkspaceElementText(target ?? document.body),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        const target = resolveTarget() ?? document.activeElement;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT")
        ) {
          const control = ensureBrowserWorkspaceFormControlElement(
            target,
            "clipboard",
          );
          setBrowserWorkspaceControlValue(
            control,
            `${control.value ?? ""}${browserWorkspaceClipboardText}`,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: {
              selector: buildBrowserWorkspaceElementSelector(control),
              value: control.value,
            },
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: browserWorkspaceClipboardText,
        };
      }
      case "mouse": {
        const action = command.mouseAction ?? "move";
        if (action === "move") {
          runtime.mouse.x = command.x ?? runtime.mouse.x;
          runtime.mouse.y = command.y ?? runtime.mouse.y;
        } else if (action === "down") {
          const button = command.button ?? "left";
          runtime.mouse.buttons = Array.from(
            new Set([...runtime.mouse.buttons, button]),
          );
        } else if (action === "up") {
          const button = command.button ?? "left";
          runtime.mouse.buttons = runtime.mouse.buttons.filter(
            (entry) => entry !== button,
          );
        } else {
          return {
            mode: "web",
            subaction: command.subaction,
            value: scrollWebBrowserWorkspaceTarget(
              dom,
              resolveTarget(),
              (command.deltaY ?? 0) < 0 ? "up" : "down",
              Math.abs(command.deltaY ?? command.pixels ?? 240),
            ),
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.mouse,
        };
      }
      case "drag": {
        const source = resolveTarget();
        const target = command.value
          ? resolveBrowserWorkspaceElement(document, command.value)
          : null;
        if (!source || !target) {
          throw new Error(
            "Eliza browser workspace drag requires source selector and target selector in value.",
          );
        }
        source.setAttribute("data-eliza-dragging", "true");
        target.setAttribute("data-eliza-drop-target", "true");
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            source: buildBrowserWorkspaceElementSelector(source),
            target: buildBrowserWorkspaceElementSelector(target),
          },
        };
      }
      case "upload": {
        throw new Error(
          "Browser workspace upload requires a proof-producing target and an exact consume-once interaction confirmation.",
        );
      }
      case "set": {
        const action = command.setAction ?? "viewport";
        if (action === "credentials" || action === "headers") {
          assertBrowserWorkspaceConnectorSecretsNotExported(
            tab.partition,
            `set:${action}`,
          );
        }
        if (action === "viewport") {
          runtime.settings.viewport = {
            height: Math.max(1, Math.round(command.height ?? 720)),
            scale: Math.max(1, Number(command.scale ?? 1)),
            width: Math.max(1, Math.round(command.width ?? 1280)),
          };
        } else if (action === "device") {
          runtime.settings.device = command.device ?? null;
        } else if (action === "geo") {
          runtime.settings.geo =
            typeof command.latitude === "number" &&
            typeof command.longitude === "number"
              ? { latitude: command.latitude, longitude: command.longitude }
              : null;
        } else if (action === "offline") {
          runtime.settings.offline = Boolean(command.offline);
        } else if (action === "headers") {
          runtime.settings.headers = normalizeBrowserWorkspaceHeaders(
            command.headers,
          );
        } else if (action === "credentials") {
          runtime.settings.credentials =
            command.username || command.password
              ? {
                  password: command.password ?? "",
                  username: command.username ?? "",
                }
              : null;
        } else if (action === "media") {
          runtime.settings.media = command.media ?? null;
        }
        applyBrowserWorkspaceDomSettings(dom, runtime);
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.settings,
        };
      }
      case "cookies": {
        assertBrowserWorkspaceConnectorSecretsNotExported(
          tab.partition,
          "cookies",
        );
        const action = command.cookieAction ?? "get";
        if (action === "clear") {
          for (const key of Object.keys(
            readBrowserWorkspaceCookies(document),
          )) {
            document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: { cleared: true },
          };
        }
        if (action === "set") {
          const cookieName = command.name?.trim() || command.entryKey?.trim();
          if (!cookieName) {
            throw new Error(
              "Eliza browser workspace cookies set requires name.",
            );
          }
          document.cookie = `${cookieName}=${command.value ?? ""}; path=/`;
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: readBrowserWorkspaceCookies(document),
        };
      }
      case "storage": {
        assertBrowserWorkspaceConnectorSecretsNotExported(
          tab.partition,
          "storage",
        );
        const area = safeWebStorageArea(() =>
          command.storageArea === "session"
            ? dom.window.sessionStorage
            : dom.window.localStorage,
        );
        if (!area) {
          throw new Error(
            "Eliza browser workspace storage is unavailable for this page's origin (e.g. about:blank). Navigate to a real page first.",
          );
        }
        const action = command.storageAction ?? "get";
        if (action === "clear") {
          area.clear();
          return {
            mode: "web",
            subaction: command.subaction,
            value: { cleared: true },
          };
        }
        if (action === "set") {
          const key = command.entryKey?.trim() || command.name?.trim();
          if (!key) {
            throw new Error(
              "Eliza browser workspace storage set requires entryKey.",
            );
          }
          area.setItem(key, command.value ?? "");
        }
        if (command.entryKey?.trim() || command.name?.trim()) {
          const key = command.entryKey?.trim() || command.name?.trim() || "";
          return {
            mode: "web",
            subaction: command.subaction,
            value: area.getItem(key),
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: readBrowserWorkspaceStorage(area),
        };
      }
      case "network": {
        const action = command.networkAction ?? "requests";
        if (action === "route") {
          const pattern = command.url?.trim();
          if (!pattern) {
            throw new Error(
              "Eliza browser workspace network route requires url pattern.",
            );
          }
          runtime.networkRoutes.push({
            abort: Boolean(command.offline),
            body: command.responseBody ?? null,
            headers: normalizeBrowserWorkspaceHeaders(command.responseHeaders),
            pattern,
            status:
              typeof command.responseStatus === "number"
                ? command.responseStatus
                : null,
          });
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkRoutes,
          };
        }
        if (action === "unroute") {
          runtime.networkRoutes = command.url?.trim()
            ? runtime.networkRoutes.filter(
                (route) => route.pattern !== command.url?.trim(),
              )
            : [];
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkRoutes,
          };
        }
        if (action === "request") {
          const request = runtime.networkRequests.find(
            (entry) => entry.id === command.requestId,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: request ?? null,
          };
        }
        if (action === "harstart") {
          runtime.networkHar = {
            active: true,
            entries: [],
            startedAt: getBrowserWorkspaceTimestamp(),
          };
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkHar,
          };
        }
        if (action === "harstop") {
          runtime.networkHar.active = false;
          const har = {
            log: {
              entries: runtime.networkHar.entries,
              startedAt: runtime.networkHar.startedAt,
            },
          };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            const resolvedPath = await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(har, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: resolvedPath, ...har },
            };
          }
          return { mode: "web", subaction: command.subaction, value: har };
        }
        let requests = [...runtime.networkRequests];
        if (command.filter?.trim()) {
          requests = requests.filter((entry) =>
            entry.url.includes(command.filter ?? ""),
          );
        }
        if (command.method?.trim()) {
          requests = requests.filter(
            (entry) =>
              entry.method.toUpperCase() ===
              command.method?.trim().toUpperCase(),
          );
        }
        if (command.status?.trim()) {
          const statusFilter = command.status.trim();
          requests = requests.filter((entry) => {
            if (entry.status === null) {
              return false;
            }
            if (/^\dxx$/i.test(statusFilter)) {
              return String(entry.status).startsWith(statusFilter[0] ?? "");
            }
            return String(entry.status) === statusFilter;
          });
        }
        return { mode: "web", subaction: command.subaction, value: requests };
      }
      case "dialog": {
        const action = command.dialogAction ?? "status";
        if (action === "status") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.dialog,
          };
        }
        if (runtime.dialog) {
          runtime.dialog.open = false;
        }
        const result =
          action === "accept"
            ? {
                accepted: true,
                dialog: runtime.dialog,
                promptText: command.promptText ?? command.value ?? null,
              }
            : { accepted: false, dialog: runtime.dialog };
        runtime.dialog = null;
        return { mode: "web", subaction: command.subaction, value: result };
      }
      case "console": {
        if (command.consoleAction === "clear") {
          runtime.consoleEntries = [];
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.consoleEntries,
        };
      }
      case "errors": {
        if (command.consoleAction === "clear") {
          runtime.errors = [];
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.errors,
        };
      }
      case "highlight": {
        const target = resolveTarget();
        if (!target) {
          throw new Error("Target element was not found.");
        }
        target.setAttribute("data-eliza-highlight", "true");
        runtime.highlightedSelector =
          buildBrowserWorkspaceElementSelector(target);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { selector: runtime.highlightedSelector },
        };
      }
      case "frame": {
        const action = command.frameAction ?? "select";
        if (action === "main") {
          runtime.currentFrame = null;
          return {
            mode: "web",
            subaction: command.subaction,
            value: { frame: null },
          };
        }
        const frame = resolveBrowserWorkspaceElement(
          dom.window.document,
          command.selector,
        );
        if (frame?.tagName !== "IFRAME") {
          throw new Error(
            "Eliza browser workspace frame select requires an iframe selector.",
          );
        }
        runtime.currentFrame = buildBrowserWorkspaceElementSelector(frame);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { frame: runtime.currentFrame },
        };
      }
      case "diff": {
        const snapshot = createBrowserWorkspaceSnapshotRecord(
          tab.title,
          tab.url,
          buildBrowserWorkspaceDocumentSnapshotText(document),
        );
        if (command.diffAction === "url") {
          const leftUrl = command.url?.trim() || tab.url;
          const rightUrl = command.secondaryUrl?.trim();
          if (!rightUrl) {
            throw new Error(
              "Eliza browser workspace diff url requires secondaryUrl.",
            );
          }
          const left = await fetchBrowserWorkspaceTrackedResponse(
            runtime,
            leftUrl,
            {},
            "document",
          );
          const right = await fetchBrowserWorkspaceTrackedResponse(
            runtime,
            rightUrl,
            {},
            "document",
          );
          const leftSnapshot = createBrowserWorkspaceSnapshotRecord(
            leftUrl,
            left.url || leftUrl,
            await left.text(),
          );
          const rightSnapshot = createBrowserWorkspaceSnapshotRecord(
            rightUrl,
            right.url || rightUrl,
            await right.text(),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: diffBrowserWorkspaceSnapshots(leftSnapshot, rightSnapshot),
          };
        }
        if (command.diffAction === "screenshot") {
          const currentData =
            runtime.lastScreenshotData ??
            createBrowserWorkspaceSyntheticScreenshotData(
              tab.title,
              tab.url,
              buildBrowserWorkspaceDocumentSnapshotText(document),
              runtime.settings.viewport ?? undefined,
            );
          const baseline = command.baselinePath?.trim()
            ? await fsp.readFile(
                resolveBrowserWorkspaceFilePath(command.baselinePath.trim()),
                "base64",
              )
            : runtime.lastScreenshotData;
          runtime.lastScreenshotData = currentData;
          return {
            mode: "web",
            subaction: command.subaction,
            value: {
              baselineLength: baseline?.length ?? 0,
              changed: baseline !== currentData,
              currentLength: currentData.length,
            },
          };
        }
        const baseline = command.baselinePath?.trim()
          ? (JSON.parse(
              await fsp.readFile(
                resolveBrowserWorkspaceFilePath(command.baselinePath.trim()),
                "utf8",
              ),
            ) as import("./browser-workspace-types.js").BrowserWorkspaceSnapshotRecord)
          : runtime.lastSnapshot;
        const diff = diffBrowserWorkspaceSnapshots(baseline, snapshot);
        runtime.lastSnapshot = snapshot;
        return { mode: "web", subaction: command.subaction, value: diff };
      }
      case "trace": {
        if (command.traceAction === "stop") {
          runtime.trace.active = false;
          const traceValue = { entries: runtime.trace.entries };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            const resolvedPath = await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(traceValue, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: resolvedPath, ...traceValue },
            };
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: traceValue,
          };
        }
        runtime.trace = { active: true, entries: [] };
        runtime.trace.entries.push({
          command: "trace:start",
          timestamp: getBrowserWorkspaceTimestamp(),
        });
        return {
          mode: "web",
          subaction: command.subaction,
          value: { active: true },
        };
      }
      case "profiler": {
        if (command.profilerAction === "stop") {
          runtime.profiler.active = false;
          const profileValue = { entries: runtime.profiler.entries };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            const resolvedPath = await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(profileValue, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: resolvedPath, ...profileValue },
            };
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: profileValue,
          };
        }
        runtime.profiler = {
          active: true,
          entries: [
            {
              command: "profiler:start",
              timestamp: getBrowserWorkspaceTimestamp(),
            },
          ],
        };
        return {
          mode: "web",
          subaction: command.subaction,
          value: { active: true },
        };
      }
      case "state": {
        assertBrowserWorkspaceConnectorSecretsNotExported(
          tab.partition,
          "state",
        );
        if (command.stateAction === "load") {
          const filePath =
            command.filePath?.trim() || command.outputPath?.trim();
          if (!filePath) {
            throw new Error(
              "Eliza browser workspace state load requires filePath.",
            );
          }
          const payload = JSON.parse(
            await fsp.readFile(
              resolveBrowserWorkspaceFilePath(filePath),
              "utf8",
            ),
          ) as Record<string, unknown>;
          applyBrowserWorkspaceStateToWebDocument(document, payload);
          if (payload.settings && typeof payload.settings === "object") {
            runtime.settings = {
              ...runtime.settings,
              ...(payload.settings as BrowserWorkspaceSettingsState),
            };
            applyBrowserWorkspaceDomSettings(dom, runtime);
          }
          setBrowserWorkspaceClipboardText(
            typeof payload.clipboard === "string"
              ? payload.clipboard
              : browserWorkspaceClipboardText,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: { loaded: true },
          };
        }
        // `state` is a best-effort snapshot — opaque origins (about:blank) have
        // no accessible storage, so degrade to empty maps rather than throwing.
        const localArea = safeWebStorageArea(() => dom.window.localStorage);
        const sessionArea = safeWebStorageArea(() => dom.window.sessionStorage);
        const payload = {
          clipboard: browserWorkspaceClipboardText,
          cookies: readBrowserWorkspaceCookies(document),
          localStorage: localArea ? readBrowserWorkspaceStorage(localArea) : {},
          sessionStorage: sessionArea
            ? readBrowserWorkspaceStorage(sessionArea)
            : {},
          settings: runtime.settings,
          url: tab.url,
        };
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (filePath) {
          const resolvedPath = await writeBrowserWorkspaceFile(
            filePath,
            JSON.stringify(payload, null, 2),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: { path: resolvedPath, ...payload },
          };
        }
        return { mode: "web", subaction: command.subaction, value: payload };
      }
      case "pdf": {
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (!filePath) {
          throw new Error("Eliza browser workspace pdf requires filePath.");
        }
        const pdf = createBrowserWorkspacePdfBuffer(
          tab.title,
          readBrowserWorkspaceElementText(document.body),
        );
        const resolved = await writeBrowserWorkspaceFile(filePath, pdf);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { path: resolved, size: pdf.byteLength },
        };
      }
      default:
        return null;
    }
  });
}

export async function executeWebBrowserWorkspaceDomCommand(
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  if (
    command.subaction === "upload" ||
    command.subaction === "realistic-upload"
  ) {
    throw new Error(
      "Browser workspace upload requires a proof-producing target and an exact consume-once interaction confirmation.",
    );
  }
  return withWebStateLock(async () => {
    const id = findWebBrowserWorkspaceTargetTabId(command);
    command = resolveBrowserWorkspaceCommandElementRefs(command, "web", id);
    const tab = getWebBrowserWorkspaceTabState(id);
    const dom = await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
    const runtime = getBrowserWorkspaceRuntimeState("web", id);
    const frameContext = resolveWebBrowserWorkspaceCommandDocument(
      tab,
      dom,
      runtime,
    );
    const document = frameContext.document;
    const resolveTarget = () =>
      resolveBrowserWorkspaceElement(
        document,
        command.selector,
        command.text,
        command,
      );

    switch (command.subaction) {
      case "inspect":
        clearWebBrowserWorkspaceTabElementRefs(tab.id);
        return {
          mode: "web",
          subaction: command.subaction,
          elements: registerBrowserWorkspaceElementRefs(
            "web",
            tab.id,
            collectBrowserWorkspaceInspectElements(document),
          ),
          value: {
            title: tab.title,
            url: tab.url,
          },
        };
      case "snapshot":
        clearWebBrowserWorkspaceTabElementRefs(tab.id);
        return {
          mode: "web",
          subaction: command.subaction,
          elements: registerBrowserWorkspaceElementRefs(
            "web",
            tab.id,
            collectBrowserWorkspaceInspectElements(document),
          ),
          value: {
            bodyText: buildBrowserWorkspaceDocumentSnapshotText(document),
            title: tab.title,
            url: tab.url,
          },
        };
      case "get": {
        if (command.getMode === "title") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: tab.title,
          };
        }
        if (command.getMode === "url") {
          return { mode: "web", subaction: command.subaction, value: tab.url };
        }
        if (command.getMode === "count") {
          if (!command.selector?.trim()) {
            throw new Error(
              "Eliza browser workspace get count requires selector.",
            );
          }
          const semanticCommand = mergeBrowserWorkspaceSelectorCommand(
            command,
            command.selector,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: semanticCommand
              ? Number(
                  Boolean(
                    resolveBrowserWorkspaceFindElement(
                      document,
                      semanticCommand,
                    ),
                  ),
                )
              : queryAllBrowserWorkspaceSelector(document, command.selector)
                  .length,
          };
        }

        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }

        let value: unknown;
        switch (command.getMode) {
          case "attr":
            if (!command.attribute?.trim()) {
              throw new Error(
                "Eliza browser workspace attr lookups require attribute.",
              );
            }
            value = element.getAttribute(command.attribute);
            break;
          case "box":
            value = getBrowserWorkspaceElementBox(element);
            break;
          case "checked":
            value =
              element.tagName === "INPUT"
                ? Boolean((element as HTMLInputElement).checked)
                : element.tagName === "OPTION"
                  ? Boolean((element as HTMLOptionElement).selected)
                  : false;
            break;
          case "enabled":
            value =
              "disabled" in element
                ? !(
                    element as
                      | HTMLButtonElement
                      | HTMLInputElement
                      | HTMLSelectElement
                      | HTMLTextAreaElement
                  ).disabled
                : true;
            break;
          case "html":
            value = element.innerHTML;
            break;
          case "styles":
            value = getBrowserWorkspaceElementStyles(element, dom.window);
            break;
          case "value":
            value = getBrowserWorkspaceElementValue(element);
            break;
          case "visible":
            value = isBrowserWorkspaceElementVisible(element);
            break;
          default:
            value = readBrowserWorkspaceElementText(element);
            break;
        }

        return { mode: "web", subaction: command.subaction, value };
      }
      case "find": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }

        switch (command.action) {
          case "check": {
            const input = ensureBrowserWorkspaceCheckboxElement(
              element,
              "check",
            );
            input.checked = true;
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                checked: input.checked,
                selector: buildBrowserWorkspaceElementSelector(input),
              },
            };
          }
          case "click":
            return {
              ...(await activateWebBrowserWorkspaceElement(
                tab,
                element,
                "click",
              )),
              subaction: command.subaction,
            };
          case "fill": {
            const control = ensureBrowserWorkspaceFormControlElement(
              element,
              "fill",
            );
            setBrowserWorkspaceControlValue(control, command.value ?? "");
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                selector: buildBrowserWorkspaceElementSelector(control),
                value: control.value,
              },
            };
          }
          case "focus":
            if (typeof (element as HTMLElement).focus === "function") {
              (element as HTMLElement).focus();
            }
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                focused: document.activeElement === element,
                selector: buildBrowserWorkspaceElementSelector(element),
              },
            };
          case "hover":
            element.setAttribute("data-eliza-hover", "true");
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                hovered: true,
                selector: buildBrowserWorkspaceElementSelector(element),
              },
            };
          case "type": {
            const control = ensureBrowserWorkspaceFormControlElement(
              element,
              "type",
            );
            setBrowserWorkspaceControlValue(
              control,
              `${control.value ?? ""}${command.value ?? ""}`,
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                selector: buildBrowserWorkspaceElementSelector(control),
                value: control.value,
              },
            };
          }
          case "uncheck": {
            const input = ensureBrowserWorkspaceCheckboxElement(
              element,
              "uncheck",
            );
            input.checked = false;
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                checked: input.checked,
                selector: buildBrowserWorkspaceElementSelector(input),
              },
            };
          }
          case "text":
          case undefined:
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                element: createBrowserWorkspaceElementSummary(element),
                text: normalizeBrowserWorkspaceText(element.textContent),
              },
            };
          default:
            throw new Error(
              `Unsupported browser workspace find action: ${command.action}`,
            );
        }
      }
      case "check": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const input = ensureBrowserWorkspaceCheckboxElement(element, "check");
        input.checked = true;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            checked: input.checked,
            selector: buildBrowserWorkspaceElementSelector(input),
          },
        };
      }
      case "fill":
      case "type": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const control = ensureBrowserWorkspaceFormControlElement(
          element,
          command.subaction,
        );
        const nextValue =
          command.subaction === "type"
            ? `${control.value ?? ""}${command.value ?? ""}`
            : (command.value ?? "");
        setBrowserWorkspaceControlValue(control, nextValue);
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(control),
            value: nextValue,
          },
        };
      }
      case "focus": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (typeof (element as HTMLElement).focus === "function") {
          (element as HTMLElement).focus();
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            focused: document.activeElement === element,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "hover": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        element.setAttribute("data-eliza-hover", "true");
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            hovered: true,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "keyboardinserttext":
      case "keyboardtype": {
        const active = document.activeElement;
        if (
          !active ||
          !(
            active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT"
          )
        ) {
          throw new Error(
            "Eliza browser workspace keyboard text input requires a focused input target.",
          );
        }
        const control = ensureBrowserWorkspaceFormControlElement(
          active,
          command.subaction === "keyboardtype" ? "type" : "keyboardinserttext",
        );
        const nextValue =
          command.subaction === "keyboardtype"
            ? `${control.value ?? ""}${command.value ?? ""}`
            : (command.value ?? "");
        setBrowserWorkspaceControlValue(control, nextValue);
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(control),
            value: control.value,
          },
        };
      }
      case "keydown":
      case "keyup":
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            key: command.key?.trim() || "Enter",
            selector:
              document.activeElement &&
              document.activeElement instanceof Element
                ? buildBrowserWorkspaceElementSelector(document.activeElement)
                : null,
          },
        };
      case "click": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        return activateWebBrowserWorkspaceElement(tab, element, "click");
      }
      case "dblclick": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        return activateWebBrowserWorkspaceElement(tab, element, "dblclick");
      }
      case "press": {
        const key = command.key?.trim() || "Enter";
        const element = resolveTarget();
        const form = findClosestBrowserWorkspaceForm(element);

        if (key === "Enter" && form) {
          await submitWebBrowserWorkspaceForm(tab, form);
          return {
            mode: "web",
            subaction: command.subaction,
            tab: cloneWebBrowserWorkspaceTabState(tab),
            value: { key, url: tab.url },
          };
        }

        return { mode: "web", subaction: command.subaction, value: { key } };
      }
      case "scroll": {
        return {
          mode: "web",
          subaction: command.subaction,
          value: scrollWebBrowserWorkspaceTarget(
            dom,
            resolveTarget(),
            command.direction ?? "down",
            command.pixels ?? 240,
          ),
        };
      }
      case "scrollinto": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (typeof (element as HTMLElement).focus === "function") {
          (element as HTMLElement).focus();
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            scrolled: true,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "select": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (element.tagName !== "SELECT") {
          throw new Error(
            "Eliza browser workspace select requires a select target.",
          );
        }
        const select = ensureBrowserWorkspaceFormControlElement(
          element,
          "select",
        );
        const option = Array.from((select as HTMLSelectElement).options).find(
          (entry) =>
            entry.value === (command.value ?? "") ||
            browserWorkspaceTextMatches(
              entry.textContent ?? "",
              command.value ?? "",
              true,
            ),
        );
        if (!option) {
          throw new Error("Select option was not found.");
        }
        (select as HTMLSelectElement).value = option.value;
        option.selected = true;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(select),
            value: (select as HTMLSelectElement).value,
          },
        };
      }
      case "uncheck": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const input = ensureBrowserWorkspaceCheckboxElement(element, "uncheck");
        input.checked = false;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            checked: input.checked,
            selector: buildBrowserWorkspaceElementSelector(input),
          },
        };
      }
      case "wait": {
        assertBrowserWorkspaceJsdomScriptNotRequested(command.script, "wait");
        if (
          !command.selector &&
          !command.findBy &&
          !command.text &&
          !command.url &&
          !command.script &&
          typeof command.timeoutMs === "number" &&
          Number.isFinite(command.timeoutMs)
        ) {
          const waitedMs = Math.max(0, command.timeoutMs);
          await sleep(waitedMs);
          return {
            mode: "web",
            subaction: command.subaction,
            value: { waitedMs },
          };
        }
        const timeoutMs =
          typeof command.timeoutMs === "number" &&
          Number.isFinite(command.timeoutMs)
            ? Math.max(100, command.timeoutMs)
            : DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
          await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
          const currentDom = ensureBrowserWorkspaceDom(tab);
          const currentDocument = currentDom.window.document;

          const matchesSelector = command.selector?.trim()
            ? (() => {
                const found = resolveBrowserWorkspaceElement(
                  currentDocument,
                  command.selector,
                  undefined,
                  command,
                );
                if (command.state === "hidden") {
                  return !found || !isBrowserWorkspaceElementVisible(found);
                }
                return found ? isBrowserWorkspaceElementVisible(found) : false;
              })()
            : false;
          const matchesFind = command.findBy
            ? (() => {
                const found = resolveBrowserWorkspaceFindElement(
                  currentDocument,
                  command,
                );
                return command.state === "hidden" ? !found : Boolean(found);
              })()
            : false;
          const matchesText = command.text?.trim()
            ? normalizeBrowserWorkspaceText(
                currentDocument.body?.textContent,
              ).includes(command.text.trim())
            : false;
          const matchesUrl = command.url?.trim()
            ? tab.url.includes(command.url.trim())
            : false;

          if (
            matchesSelector ||
            matchesFind ||
            matchesText ||
            matchesUrl ||
            (!command.selector &&
              !command.findBy &&
              !command.text &&
              !command.url)
          ) {
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                findBy: command.findBy ?? null,
                selector: command.selector ?? null,
                state: command.state ?? null,
                text: command.text ?? null,
                url: tab.url,
              },
            };
          }

          await sleep(DEFAULT_WAIT_INTERVAL_MS);
        }

        throw new Error("Timed out waiting for browser workspace condition.");
      }
      default:
        throw new Error(
          `Unsupported web browser workspace subaction: ${command.subaction}`,
        );
    }
  });
}
