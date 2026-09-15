/**
 * The Browser workspace view (`/browser`): a tabbed embedded-browser surface
 * whose tabs fold into a switcher sheet, with companion-bridge status and the
 * policy-controlled agent browser session panel (takeover, domain modes,
 * receipts) when the bridge plugin is available.
 *
 * The builtin registry declares this view `header: "fullscreen"`, so the shell
 * mounts it edge-to-edge and the view owns a compact, familiar navigation rail
 * plus the isolated web-content surface. Responsive layout changes only the
 * chrome density; browsing, storage, and security policy stay canonical.
 *
 * Tabs, navigation, and snapshots flow through the `client` browser API; on
 * native the tabs render via a registered renderer impl
 * (`browser-tabs-renderer-registry`), while desktop/web fall back to the
 * companion bridge. Mounted in `App.tsx` under the `browser` route key.
 */
import { Capacitor } from "@capacitor/core";
import {
  ArrowLeft,
  ArrowRight,
  EllipsisVertical,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceTab,
  client,
} from "../../api";
import { isApiError } from "../../api/client-types-core";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { resolveBuiltinSurfaceManifest } from "../../builtin-tab-registry";
import {
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  NAVIGATE_VIEW_EVENT,
  type NavigateViewDetail,
} from "../../events";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { usesAndroidLp3SharedBrowserStorage } from "../../platform/android-runtime";
import { useAppSelectorShallow } from "../../state";
import { deriveSurfacePlacement } from "../../surface/native-surface-shell";
import { useMobileNativeTabSurfaces } from "../../surface/use-mobile-native-tab-surfaces";
import { resolveBrowserTabRenderPath } from "../../surface-embedding";
import { openExternalUrl } from "../../utils";
import { resolveApiUrl } from "../../utils/asset-url";
import {
  BROWSER_TAB_PRELOAD_SCRIPT,
  setBrowserTabsRendererImpl,
} from "../../utils/browser-tabs-renderer-registry";
import { BrowserSessionPolicyPanel } from "../browser/BrowserSessionPolicyPanel";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useConfirm } from "../ui/confirm-dialog.hooks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { TooltipHint } from "../ui/tooltip";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import {
  type BrowserSwitcherTab,
  BrowserTabFoldControl,
  BrowserTabSwitcher,
  foldBrowserTabs,
} from "./BrowserTabSwitcher";
import {
  decodeBase64ForPreview,
  decodeSignableMessage,
  formatAddressForDisplay,
  formatWeiForDisplay,
  truncateMessageForDisplay,
} from "./browser-wallet-consent-format";
import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
  getUnsupportedBrowserWorkspaceEvmChainError,
  isBrowserWorkspaceEvmChainSupported,
  parseBrowserWorkspaceEvmChainId,
  resolveBrowserWorkspaceSignMessage,
} from "./browser-workspace-wallet";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;
const BROWSER_WORKSPACE_AGENT_PARTITION = "persist:eliza-browser-agent";
const BROWSER_WORKSPACE_APP_PARTITION = "persist:eliza-browser-app";
// Concrete partition for a client-side "user" tab on the native mobile shell,
// where `resolveBrowserWorkspaceTabPartition("user")` is `undefined` (the
// server-default sentinel). Cosmetic on mobile — the native surface's storage
// isolation is governed by its explicit NativeSurfacePolicy, not this string.
const BROWSER_WORKSPACE_DEFAULT_PARTITION = "persist:eliza-browser";
// Default URL when the user opens a fresh tab via "+". Plain web hosts must use
// a page that explicitly permits iframe embedding; native shells render the
// same URL in their isolated WebView instead.
const BROWSER_WORKSPACE_DEFAULT_HOME_URL = "https://www.google.com/webhp?igu=1";
// Cross-origin pages can apply autofocus after their `load` event. Keep one
// bounded handoff alive long enough to catch that deferred focus without
// turning later, deliberate page interaction into a permanent focus trap.
const BROWSER_IFRAME_FOCUS_SETTLE_MS = 1_500;
const BROWSER_IFRAME_FOCUS_ARM_TIMEOUT_MS = 30_000;
const BROWSER_IFRAME_FOCUS_POLL_MS = 16;
const BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE =
  "browser_workspace_runtime_unavailable";

type BrowserWorkspaceLoadError = {
  message: string;
  code?: string;
  retryable: boolean;
};

type BrowserIframeFocusHandoff = {
  returnTarget: HTMLElement | null;
  navigationUrl: string | null;
  loaded: boolean;
  deadline: number;
  timer: number | null;
  pendingTargetRestore: boolean;
};

function isAvailableBrowserFocusTarget(
  target: HTMLElement | null,
): target is HTMLElement {
  if (!target?.isConnected) return false;
  if (target.getAttribute("aria-disabled") === "true") return false;
  return !("disabled" in target && target.disabled === true);
}
// The Browser view's isolation level, read from its builtin surface manifest
// rather than hardcoded, so the declared `native-webview` level is what
// actually drives which embedding each tab renders into (#14181/#13452). This
// is the enforcement seam: the native child web-content surface (outside the
// host renderer) is selected via `resolveBrowserTabRenderPath` only because
// this resolves to `native-webview`. If the registry ever dropped the browser
// manifest, `resolveBuiltinSurfaceManifest` throws at import — a loud failure,
// not a silent fall-back to the host-realm DOM.
const BROWSER_SURFACE_MANIFEST = resolveBuiltinSurfaceManifest("browser");
const BROWSER_SURFACE_ISOLATION = BROWSER_SURFACE_MANIFEST.isolation;
// The placement the mobile native tab surfaces are created with, derived from
// the same manifest — process is always isolated; storage is isolated because
// the Browser grants no `storage` capability. Throwing here (not defaulting)
// keeps the loud-failure contract: if the manifest ever stopped declaring
// `native-webview`, the native mobile path could not silently create a
// mis-policied surface.
const BROWSER_NATIVE_SURFACE_PLACEMENT = deriveSurfacePlacement(
  BROWSER_SURFACE_MANIFEST,
);
const BROWSER_NATIVE_SURFACE_POLICY =
  BROWSER_NATIVE_SURFACE_PLACEMENT.target === "native-surface"
    ? {
        ...BROWSER_NATIVE_SURFACE_PLACEMENT.policy,
        // LP3's WebView 113 has an out-of-app renderer but no multi-profile
        // API. The dedicated fallback build therefore explicitly requests the
        // plugin's supported shared Browser profile. This is not a native
        // silent downgrade: every other build keeps the manifest-derived
        // isolated storage policy and still fails closed when unsupported.
        storage: usesAndroidLp3SharedBrowserStorage()
          ? ("shared" as const)
          : BROWSER_NATIVE_SURFACE_PLACEMENT.policy.storage,
      }
    : (() => {
        throw new Error(
          "Browser surface manifest must declare native-webview isolation to host native mobile tab surfaces",
        );
      })();
// Selectors handed to every native Browser surface so the page doesn't paint
// over (or capture clicks within) React chrome stacked on the same rect. The
// chat selectors keep its pull sheet composited continuously over a full-size
// page; the remainder covers Radix Dialog/AlertDialog content
// (`role=dialog`/`alertdialog`), every Radix popper-based surface (Popover,
// Tooltip, Dropdown, Select, HoverCard, ContextMenu — all wrapped in
// `data-radix-popper-content-wrapper`), and the ActionNotice toast which
// uses `role=status`. Polled by OverlaySyncController so overlays mounted
// after the tab still get masked.
const BROWSER_WORKSPACE_TAB_MASK_SELECTORS = [
  '[data-testid="chat-sheet-surface"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-radix-popper-content-wrapper]",
  '[role="tooltip"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="status"]',
].join(", ");

// Minimal subset of Electrobun's <electrobun-webview> custom element surface
// used by this view. Inlined so this file typechecks identically from any
// package that consumes app-core source — the full type lives in
// node_modules/electrobun/dist/api/browser/webviewtag.ts.
type WebviewTagElement = HTMLElement & {
  loadURL(url: string): void;
  reload(): void;
  executeJavascript(js: string): void;
  on(event: "host-message", handler: (event: CustomEvent) => void): void;
  off(event: "host-message", handler: (event: CustomEvent) => void): void;
  /**
   * Synchronizes the OOPIF's frame with the anchor's `getBoundingClientRect()`.
   * The tag auto-syncs on its own resize, but layout changes outside the
   * element (sidebar collapse, window resize, parent flex reflow) need a
   * manual poke. `force: true` triggers the sync even if dimensions look
   * unchanged.
   */
  syncDimensions(force?: boolean): void;
  /**
   * Hide/show the underlying native OOPIF view. The HTML `hidden` attribute
   * does not propagate to the native layer — only this method does. Without
   * it, inactive tabs' OOPIFs stay painted over the surface and intercept
   * clicks meant for sibling UI.
   */
  toggleHidden(value?: boolean): void;
  /**
   * Toggle pointer-event passthrough on the native OOPIF view. When enabled
   * the surface stops capturing clicks even if it remains visible, so React
   * siblings stacked over the same rect (overlays mid-transition, the
   * inactive-tab opacity-0 layer) can receive events. Used alongside
   * `toggleHidden` on inactive tabs so the native view neither paints nor
   * grabs input during the gap between layout flap and first sync.
   */
  togglePassthrough(value?: boolean): void;
};

function _isWebviewTagElement(
  value: EventTarget | null,
): value is WebviewTagElement {
  if (!(value instanceof HTMLElement)) return false;
  const candidate = value as Partial<WebviewTagElement>;
  return (
    typeof candidate.loadURL === "function" &&
    typeof candidate.reload === "function" &&
    typeof candidate.executeJavascript === "function"
  );
}

type ElectrobunWebviewProps = React.DetailedHTMLProps<
  React.HTMLAttributes<WebviewTagElement> & {
    src?: string;
    partition?: string;
    preload?: string;
    sandbox?: boolean | "";
    transparent?: boolean | "";
    hidden?: boolean;
    /**
     * "cef" (bundled Chromium) or "native" (system WKWebView on macOS).
     * Set explicitly per-tag rather than relying on the
     * `defaultRenderer` config: CEF is what supports the OOPIF model
     * + RPC + preload script the agent automation kit depends on.
     */
    renderer?: "cef" | "native";
    /**
     * Comma-separated CSS selectors. Any element matching is treated
     * as a punch-out rect — the native OOPIF will not paint over it
     * and will not capture clicks within it. Required so React
     * overlays (modals, dropdowns, toasts) render above the webview
     * surface and remain interactive.
     */
    masks?: string;
    /**
     * Initial passthrough state. When present the OOPIF starts in
     * pointer-events: none mode. Set on inactive tabs so the gap
     * between mount and the first selection effect doesn't leak
     * clicks into the wrong tab.
     */
    passthrough?: boolean | "";
  },
  WebviewTagElement
>;

// JSX intrinsic for the Electrobun custom element. Kept local so packages that
// consume ui source do not need app-core's ambient module declarations.
declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": ElectrobunWebviewProps;
    }
  }
}

type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;
type BrowserWorkspaceTabSectionKey = "agent" | "app" | "user";

function resolveBrowserWorkspaceTabSectionKey(
  tab: BrowserWorkspaceTab,
): BrowserWorkspaceTabSectionKey {
  const partition = tab.partition.trim().toLowerCase();
  if (partition === BROWSER_WORKSPACE_AGENT_PARTITION) {
    return "agent";
  }
  if (partition === BROWSER_WORKSPACE_APP_PARTITION) {
    return "app";
  }
  return "user";
}

function resolveBrowserWorkspaceTabPartition(
  sectionKey: BrowserWorkspaceTabSectionKey,
): string | undefined {
  switch (sectionKey) {
    case "agent":
      return BROWSER_WORKSPACE_AGENT_PARTITION;
    case "app":
      return BROWSER_WORKSPACE_APP_PARTITION;
    case "user":
      return undefined;
  }
}

function isBrowserBridgePlugin(plugin: {
  id?: string;
  name?: string;
  npmName?: string;
}): boolean {
  const identifiers = [plugin.id, plugin.name, plugin.npmName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  return identifiers.some(
    (value) =>
      value === "browser" ||
      value === "browser-bridge" ||
      value === "plugin-browser" ||
      value === "@elizaos/plugin-browser",
  );
}

function isBrowserWorkspaceSessionMode(
  mode: BrowserWorkspaceSnapshot["mode"],
): boolean {
  // Cloud is the only mode that still uses the snapshot-preview UX. Desktop
  // mode renders <electrobun-webview> tags directly into the React tree, so
  // there's no need to poll for screenshot data.
  return mode === "cloud";
}

function resolveBrowserWorkspaceLoadError(
  error: unknown,
  t: TranslateFn,
): BrowserWorkspaceLoadError {
  const apiError = isApiError(error) ? error : null;
  const errorData = apiError?.data;
  const structuredRetryable =
    typeof errorData === "object" &&
    errorData !== null &&
    "retryable" in errorData &&
    typeof (errorData as { retryable?: unknown }).retryable === "boolean"
      ? (errorData as { retryable: boolean }).retryable
      : undefined;
  const code = apiError?.code;

  if (code === BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE) {
    return {
      code,
      message: t("browserworkspace.DedicatedRuntimeRequired", {
        defaultValue: "In-app browsing isn’t available with this connection.",
      }),
      retryable: false,
    };
  }

  if (apiError?.status === 404) {
    return {
      ...(code ? { code } : {}),
      message: t("browserworkspace.ServiceUnavailable", {
        defaultValue: "In-app browsing isn’t available here.",
      }),
      retryable: false,
    };
  }

  return {
    ...(code ? { code } : {}),
    message: t("browserworkspace.ConnectionFailed", {
      defaultValue: "Browser couldn’t connect. Try again in a moment.",
    }),
    retryable: structuredRetryable ?? true,
  };
}

export function normalizeBrowserWorkspaceInputUrl(
  rawUrl: string,
  t: TranslateFn,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  if (/^\/[\\/]/.test(trimmed)) {
    throw new Error(
      t("browserworkspace.InvalidUrl", {
        defaultValue: "Enter a valid http or https URL.",
      }),
    );
  }

  const candidate = trimmed.startsWith("/")
    ? new URL(resolveApiUrl(trimmed), window.location.origin).toString()
    : /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      t("browserworkspace.InvalidUrl", {
        defaultValue: "Enter a valid http or https URL.",
      }),
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      t("browserworkspace.UnsupportedProtocol", {
        defaultValue: "Only http and https URLs are supported.",
      }),
    );
  }
  return parsed.toString();
}

function readBrowserWorkspaceQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const rawSearch =
    window.location.search || window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(
    rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch,
  );
  const value = params.get(name)?.trim();
  return value ? value : null;
}

function inferBrowserWorkspaceTitle(url: string, t: TranslateFn): string {
  if (url === "about:blank") {
    return t("browserworkspace.NewTab", {
      defaultValue: "New tab",
    });
  }
  try {
    return (
      new URL(url).hostname.replace(/^www\./, "") ||
      t("nav.browser", {
        defaultValue: "Browser",
      })
    );
  } catch {
    return t("nav.browser", {
      defaultValue: "Browser",
    });
  }
}

/**
 * Build a client-side tab for the native mobile shell. Unlike desktop/web, the
 * mobile agent server does not manage Browser tabs (its tab API returns 503), so
 * on the native-mobile-webview path the tab record lives entirely in React state
 * and the isolated native surface is what actually loads the page.
 */
function buildLocalBrowserWorkspaceTab(
  url: string,
  title: string,
  partition: string,
): BrowserWorkspaceTab {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    url,
    partition,
    kind: "standard",
    visible: true,
    createdAt: now,
    updatedAt: now,
    lastFocusedAt: now,
  };
}

function getBrowserWorkspaceTabKind(
  tab: BrowserWorkspaceTab,
): "internal" | "standard" {
  return tab.kind === "internal" ? "internal" : "standard";
}

function isInternalBrowserWorkspaceTab(tab: BrowserWorkspaceTab): boolean {
  return getBrowserWorkspaceTabKind(tab) === "internal";
}

function isBrowserWorkspaceFrameBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)discord\.com$/i.test(parsed.hostname);
  } catch {
    // error-policy:J3 unparseable URL cannot match the frame-blocked hosts;
    // the iframe itself surfaces an unloadable address.
    return false;
  }
}

function getBrowserWorkspaceTabLabel(
  tab: BrowserWorkspaceTab,
  t: TranslateFn,
): string {
  const trimmedTitle = tab.title.trim();
  if (trimmedTitle && trimmedTitle !== "Browser") return trimmedTitle;
  return inferBrowserWorkspaceTitle(tab.url, t);
}

function getBrowserWorkspaceTabMonogram(label: string): string {
  const alphanumeric = label.trim().replace(/[^a-z0-9]/gi, "");
  return (alphanumeric[0] ?? "B").toUpperCase();
}

function getBrowserWorkspaceTabDescription(
  tab: BrowserWorkspaceTab,
  mode: BrowserWorkspaceSnapshot["mode"],
): string {
  const details: string[] = [];

  if (isInternalBrowserWorkspaceTab(tab)) {
    details.push("Internal");
  }

  if (mode !== "web") {
    if (tab.provider?.trim()) {
      details.push(tab.provider.trim());
    }
    if (tab.status?.trim()) {
      details.push(tab.status.trim());
    }
  }

  details.push(tab.url);
  return details.join(" · ");
}

function resolveBrowserWorkspaceSelection(
  tabs: BrowserWorkspaceTab[],
  selectedId: string | null,
): string | null {
  if (selectedId && tabs.some((tab) => tab.id === selectedId)) {
    return selectedId;
  }
  const visibleTab = tabs.find((tab) => tab.visible);
  return visibleTab?.id ?? tabs[0]?.id ?? null;
}

function resolveSolanaCluster(
  value: unknown,
): "mainnet" | "devnet" | "testnet" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("devnet")) return "devnet";
  if (normalized.includes("testnet")) return "testnet";
  if (normalized.includes("mainnet")) return "mainnet";
  return undefined;
}

function BrowserNavButton({
  agentId,
  agentLabel,
  agentDescription,
  group,
  status,
  onActivate,
  ...buttonProps
}: {
  agentId: string;
  agentLabel: string;
  agentDescription?: string;
  group?: string;
  status?: "active" | "inactive";
  onActivate: () => void;
} & React.ComponentProps<typeof Button>): React.JSX.Element {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group,
    ...(agentDescription ? { description: agentDescription } : {}),
    ...(status ? { status } : {}),
    onActivate,
  });
  return <Button ref={ref} {...agentProps} {...buttonProps} />;
}

function BrowserAddressInput({
  agentLabel,
  agentDescription,
  getValue,
  onFill,
  ...inputProps
}: {
  agentLabel: string;
  agentDescription?: string;
  getValue: () => string;
  onFill: (value: string) => void;
} & React.ComponentProps<typeof Input>): React.JSX.Element {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "address-input",
    role: "text-input",
    label: agentLabel,
    ...(agentDescription ? { description: agentDescription } : {}),
    getValue,
    onFill,
  });
  return (
    <Input ref={ref} aria-label={agentLabel} {...agentProps} {...inputProps} />
  );
}

export function BrowserWorkspaceView(): React.JSX.Element {
  const authority = useActiveAgentAuthority();
  return <BrowserWorkspaceForAuthority key={authority} />;
}

/**
 * Browser state includes live tabs, snapshots, native surfaces, wallet grants,
 * and in-flight agent requests. Keying that complete state owner by authority
 * makes an in-place profile switch equivalent to a clean mount: the prior
 * profile disappears before the next paint and its late promises target an
 * unmounted tree instead of the newly active agent.
 */
function BrowserWorkspaceForAuthority(): React.JSX.Element {
  useRenderGuard("BrowserWorkspaceView");
  const {
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    plugins,
    uiTheme,
    walletAddresses,
    walletConfig,
  } = useAppSelectorShallow((s) => ({
    getStewardPending: s.getStewardPending,
    getStewardStatus: s.getStewardStatus,
    setActionNotice: s.setActionNotice,
    t: s.t,
    plugins: s.plugins,
    uiTheme: s.uiTheme,
    walletAddresses: s.walletAddresses,
    walletConfig: s.walletConfig,
  }));
  const [workspace, setWorkspace] = useState<BrowserWorkspaceSnapshot>({
    mode: "web",
    tabs: [],
  });
  const [browserWalletState, setBrowserWalletState] =
    useState<BrowserWorkspaceWalletState>(() =>
      buildBrowserWorkspaceWalletState({
        pendingApprovals: 0,
        stewardStatus: null,
        walletAddresses,
        walletConfig,
      }),
    );
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [locationInput, setLocationInput] = useState("");
  const [locationDirty, setLocationDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<BrowserWorkspaceLoadError | null>(
    null,
  );
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [tabSnapshots, setTabSnapshots] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // The folded-tab switcher overlay (#13596). The browser folds every tab into
  // this one switcher instead of a permanent sidebar strip, so this is the only
  // multi-tab surface — opened from the toolbar's fold control.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [mobileRuntimeMode, setMobileRuntimeMode] = useState(
    readPersistedMobileRuntimeMode,
  );
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
  const workspaceRootRef = useRef<HTMLElement | null>(null);
  const workspaceSnapshotRef = useRef<BrowserWorkspaceSnapshot>(workspace);
  // Polls are slower than their cadence when the API is unhealthy. Keep them
  // single-flight, and order every response so a late poll cannot roll back a
  // newer user action or turn stale-state refresh noise into a page failure.
  const workspaceLoadVersionRef = useRef(0);
  const workspaceLoadAbortControllerRef = useRef<AbortController | null>(null);
  const snapshotAbortControllerRef = useRef<AbortController | null>(null);
  const lifecycleAbortControllerRef = useRef(new AbortController());
  const lifecycleEffectEpochRef = useRef(0);
  const foregroundWorkspaceLoadsRef = useRef(0);
  const visibleWorkspaceLoadsRef = useRef(0);
  const workspaceActionsInFlightRef = useRef(0);
  const backgroundWorkspaceRefreshInFlightRef = useRef(false);
  const initialWorkspaceLoadStartedRef = useRef(false);
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const registeredIframeElementsRef = useRef(new WeakSet<HTMLIFrameElement>());
  const iframeFocusHandoffsRef = useRef(
    new Map<HTMLIFrameElement, BrowserIframeFocusHandoff>(),
  );
  const iframeFocusTimersRef = useRef(new Set<number>());
  const browserActionFocusReturnTargetRef = useRef<HTMLElement | null>(null);
  const pendingIframeFocusReturnTargetsRef = useRef(
    new Map<string, HTMLElement | null>(),
  );
  const electrobunWebviewRefs = useRef(
    new Map<string, WebviewTagElement | null>(),
  );
  const electrobunHostMessageHandlersRef = useRef(
    new Map<string, (event: CustomEvent) => void>(),
  );
  const pendingTabExecsRef = useRef(
    new Map<
      number,
      {
        resolve: (value: {
          ok: boolean;
          result?: unknown;
          error?: string;
        }) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const tabExecCounterRef = useRef(0);
  const tabChainIdRef = useRef(new Map<string, number>());
  const browserWalletStateRef = useRef<BrowserWorkspaceWalletState | null>(
    null,
  );
  // Per-session "the user already allowed this domain to read accounts"
  // set. EIP-1193 dApps poll `eth_accounts` after connect; without this
  // the consent modal would re-prompt on every poll. Cleared when the
  // workspace unmounts (i.e. app restart). A persistent vault-backed
  // version is a follow-up — see Phase 2 brief.
  const walletConnectAllowedDomainsRef = useRef<Set<string>>(new Set());
  // Ref-mirror of the selected tab id so the register callback (which is
  // memoized on handleTabHostMessage only) can read the current selection
  // without a fresh closure each render.
  const selectedTabIdRef = useRef<string | null>(null);
  const getStewardPendingRef = useRef(getStewardPending);
  const getStewardStatusRef = useRef(getStewardStatus);
  const setActionNoticeRef = useRef(setActionNotice);
  const tRef = useRef(t);
  const walletAddressesRef = useRef(walletAddresses);
  const walletConfigRef = useRef(walletConfig);
  const previousSelectedTabIdRef = useRef<string | null>(null);

  if (typeof initialBrowseUrlRef.current === "undefined") {
    const browseParam = readBrowserWorkspaceQueryParam("browse");
    try {
      initialBrowseUrlRef.current = browseParam
        ? normalizeBrowserWorkspaceInputUrl(browseParam, t)
        : null;
    } catch {
      initialBrowseUrlRef.current = null;
    }
  }

  // A Capacitor native shell (iOS/Android), distinct from the mobile web browser
  // which also reports `mode: "web"` — so the resolver cannot infer it from mode
  // and we pass it explicitly. Electrobun is desktop, not a mobile shell.
  const nativeMobileShell = useMemo(
    () => Capacitor.isNativePlatform() && !isElectrobunRuntime(),
    [],
  );

  // Which embedding each browser tab renders into, DRIVEN by the view's declared
  // isolation level (not the raw mode string): `native-webview` resolves to the
  // desktop native child surface (the `<electrobun-webview renderer="cef">`
  // OOPIF below) or, on a native mobile shell, a layered `WKWebView` /
  // `WebView`; plain web resolves to a sandboxed iframe; cloud to a server
  // snapshot. Reading the manifest here is what makes `isolation:
  // "native-webview"` authoritative (#14181/#15245) — a view without that level
  // could never reach a native surface.
  const browserTabRenderPath = resolveBrowserTabRenderPath({
    isolation: BROWSER_SURFACE_ISOLATION,
    mode: workspace.mode,
    nativeMobileShell,
  });
  // The native mobile shell owns its tabs locally, so an absent server-side
  // workspace is a usable empty state there. Every other renderer depends on
  // the workspace API: a failed initial read is unavailability, never an empty
  // browser. Keep that distinction central so the surface and every mutating
  // control agree on what the user can actually do.
  const browserWorkspaceUsesLocalTabs =
    browserTabRenderPath === "native-mobile-webview";
  const browserWorkspaceUnavailable =
    !browserWorkspaceUsesLocalTabs &&
    loadError !== null &&
    workspace.tabs.length === 0;
  const browserWorkspaceCanRetryLoad =
    loadError?.retryable === true &&
    loadError.code !== BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE;

  const selectedTab = useMemo(
    () => workspace.tabs.find((tab) => tab.id === selectedTabId) ?? null,
    [selectedTabId, workspace.tabs],
  );
  const selectedTabSnapshot = selectedTabId
    ? (tabSnapshots[selectedTabId] ?? null)
    : null;
  const selectedTabLiveViewUrl =
    selectedTab?.interactiveLiveViewUrl ?? selectedTab?.liveViewUrl ?? null;
  const selectedTabIsInternal = selectedTab
    ? isInternalBrowserWorkspaceTab(selectedTab)
    : false;
  // A user-created tab is a fresh browsing context. Reusing the address-field
  // draft would clone the current page, while internal-tab state must never
  // leak into a user tab. The address bar remains the explicit path for opening
  // a chosen URL.
  const newBrowserWorkspaceTabSeedUrl = BROWSER_WORKSPACE_DEFAULT_HOME_URL;
  const browserBridgeSupported = useMemo(
    () => plugins.some((plugin) => isBrowserBridgePlugin(plugin)),
    [plugins],
  );
  const browserBridgeUnsupportedInNativeLocalMode =
    Capacitor.isNativePlatform() && mobileRuntimeMode === "local";

  workspaceSnapshotRef.current = workspace;

  useEffect(() => {
    const epoch = ++lifecycleEffectEpochRef.current;
    return () => {
      // React StrictMode performs a setup/cleanup/setup probe without actually
      // discarding this state owner. Defer one microtask so the second setup can
      // supersede that probe; a real unmount or authority-key replacement has
      // no next setup and therefore aborts every lifecycle-owned read.
      queueMicrotask(() => {
        if (lifecycleEffectEpochRef.current !== epoch) return;
        lifecycleAbortControllerRef.current.abort(
          "Browser workspace unmounted",
        );
        workspaceLoadAbortControllerRef.current?.abort(
          "Browser workspace unmounted",
        );
        snapshotAbortControllerRef.current?.abort(
          "Browser workspace unmounted",
        );
      });
    };
  }, []);

  useEffect(() => {
    getStewardPendingRef.current = getStewardPending;
    getStewardStatusRef.current = getStewardStatus;
    setActionNoticeRef.current = setActionNotice;
    tRef.current = t;
    walletAddressesRef.current = walletAddresses;
    walletConfigRef.current = walletConfig;
  }, [
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    walletAddresses,
    walletConfig,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncRuntimeMode = () => {
      setMobileRuntimeMode(readPersistedMobileRuntimeMode());
    };
    document.addEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      syncRuntimeMode,
    );
    return () => {
      document.removeEventListener(
        MOBILE_RUNTIME_MODE_CHANGED_EVENT,
        syncRuntimeMode,
      );
    };
  }, []);

  const loadBrowserWalletState = useCallback(async () => {
    try {
      // Steward status / pending-approval failures propagate to the catch
      // below, which renders an explicit error-carrying wallet state — a
      // swallowed failure here would paint "0 pending approvals" over real
      // pending transactions.
      const stewardStatus = await getStewardStatusRef.current();
      const resolvedWalletConfig =
        walletConfigRef.current ??
        // error-policy:J4 wallet config is optional decoration for this
        // panel (absent when the wallet plugin isn't loaded).
        (await client.getWalletConfig().catch(() => null));
      const pendingApprovals =
        stewardStatus?.connected === true
          ? (await getStewardPendingRef.current()).length
          : 0;
      const nextState = buildBrowserWorkspaceWalletState({
        pendingApprovals,
        stewardStatus,
        walletAddresses: walletAddressesRef.current,
        walletConfig: resolvedWalletConfig,
      });
      setBrowserWalletState(nextState);
      return nextState;
    } catch (error) {
      // error-policy:J4 explicit degrade — the wallet panel renders an
      // error-carrying "unavailable" state, never healthy-empty.
      const message = error instanceof Error ? error.message : String(error);
      const nextState = buildBrowserWorkspaceWalletState({
        pendingApprovals: 0,
        stewardStatus: {
          available: false,
          configured: false,
          connected: false,
          error: message,
        },
        walletAddresses: walletAddressesRef.current,
        walletConfig: walletConfigRef.current,
      });
      setBrowserWalletState(nextState);
      return nextState;
    }
  }, []);

  const {
    beginBrowserWalletFrameNavigation,
    revokeBrowserWalletFrame,
    syncBrowserWalletFrameTarget,
  } = useBrowserWorkspaceWalletBridge({
    iframeRefs,
    workspaceTabs: workspace.mode === "web" ? workspace.tabs : [],
    walletState: browserWalletState,
    loadWalletState: loadBrowserWalletState,
  });

  const readBrowserWorkspaceFocusReturnTarget = useCallback(() => {
    if (typeof document === "undefined") return null;
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      !(activeElement instanceof HTMLIFrameElement) &&
      activeElement.isConnected
      ? activeElement
      : null;
  }, []);

  const clearBrowserWorkspaceIframeFocusTimer = useCallback(
    (handoff: BrowserIframeFocusHandoff) => {
      if (handoff.timer === null || typeof window === "undefined") return;
      window.clearTimeout(handoff.timer);
      iframeFocusTimersRef.current.delete(handoff.timer);
      handoff.timer = null;
    },
    [],
  );

  const releaseBrowserWorkspaceIframeFocusReturn = useCallback(
    (iframe: HTMLIFrameElement, expected?: BrowserIframeFocusHandoff) => {
      const current = iframeFocusHandoffsRef.current.get(iframe);
      if (!current || (expected && current !== expected)) return;
      clearBrowserWorkspaceIframeFocusTimer(current);
      iframeFocusHandoffsRef.current.delete(iframe);
    },
    [clearBrowserWorkspaceIframeFocusTimer],
  );

  const monitorBrowserWorkspaceIframeFocus = useCallback(
    (iframe: HTMLIFrameElement, handoff: BrowserIframeFocusHandoff) => {
      if (
        typeof document === "undefined" ||
        typeof window === "undefined" ||
        iframeFocusHandoffsRef.current.get(iframe) !== handoff
      ) {
        return;
      }

      clearBrowserWorkspaceIframeFocusTimer(handoff);
      const activeElement = document.activeElement;
      const parentFocusIsNeutral =
        activeElement === null ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        activeElement === workspaceRootRef.current;
      if (activeElement === iframe || parentFocusIsNeutral) {
        // Pointer presence is not intent: a full-surface Browser commonly
        // remains hovered while the user types in chat. Only pointer-down or
        // keyboard entry cancels the handoff, through the listeners below.
        // WebKit may expose a neutral parent activeElement while focus lives
        // in the child frame, so that state receives the same restoration.
        const returnTarget = isAvailableBrowserFocusTarget(handoff.returnTarget)
          ? handoff.returnTarget
          : workspaceRootRef.current;
        returnTarget?.focus({ preventScroll: true });
        handoff.pendingTargetRestore =
          returnTarget === workspaceRootRef.current &&
          handoff.returnTarget !== null;
      }

      if (
        handoff.pendingTargetRestore &&
        document.activeElement === workspaceRootRef.current &&
        isAvailableBrowserFocusTarget(handoff.returnTarget)
      ) {
        handoff.returnTarget.focus({ preventScroll: true });
        handoff.pendingTargetRestore = false;
      }

      if (!handoff.loaded || Date.now() >= handoff.deadline) {
        if (handoff.loaded) {
          releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        }
        return;
      }

      const timer = window.setTimeout(
        () => monitorBrowserWorkspaceIframeFocus(iframe, handoff),
        BROWSER_IFRAME_FOCUS_POLL_MS,
      );
      handoff.timer = timer;
      iframeFocusTimersRef.current.add(timer);
    },
    [
      clearBrowserWorkspaceIframeFocusTimer,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  const armBrowserWorkspaceIframeFocusReturn = useCallback(
    (
      iframe: HTMLIFrameElement,
      options?: {
        preserveExistingForUrl?: boolean;
        returnTarget?: HTMLElement | null;
        navigationUrl?: string;
      },
    ) => {
      if (typeof window === "undefined") return;
      const existing = iframeFocusHandoffsRef.current.get(iframe);
      if (
        existing &&
        options?.preserveExistingForUrl &&
        existing.navigationUrl === options.navigationUrl
      ) {
        return;
      }
      if (existing) {
        releaseBrowserWorkspaceIframeFocusReturn(iframe, existing);
      }

      const handoff: BrowserIframeFocusHandoff = {
        returnTarget: options?.returnTarget
          ? options.returnTarget
          : (browserActionFocusReturnTargetRef.current ??
            readBrowserWorkspaceFocusReturnTarget()),
        navigationUrl: options?.navigationUrl ?? null,
        loaded: false,
        deadline: 0,
        timer: null,
        pendingTargetRestore: false,
      };
      iframeFocusHandoffsRef.current.set(iframe, handoff);
      const timer = window.setTimeout(
        () => releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff),
        BROWSER_IFRAME_FOCUS_ARM_TIMEOUT_MS,
      );
      handoff.timer = timer;
      iframeFocusTimersRef.current.add(timer);
    },
    [
      readBrowserWorkspaceFocusReturnTarget,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  const beginBrowserWorkspaceIframeFocusSettle = useCallback(
    (iframe: HTMLIFrameElement) => {
      const handoff = iframeFocusHandoffsRef.current.get(iframe);
      if (!handoff) return;
      if (document.activeElement === iframe) {
        // A cross-origin child does not bubble its pointer events into the
        // embedding document. Focus that reached the frame before its load
        // event is therefore the durable signal that the user entered the
        // still-loading page; the delayed-autofocus guard must not undo it.
        releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        return;
      }
      clearBrowserWorkspaceIframeFocusTimer(handoff);
      handoff.loaded = true;
      handoff.deadline = Date.now() + BROWSER_IFRAME_FOCUS_SETTLE_MS;
      monitorBrowserWorkspaceIframeFocus(iframe, handoff);
    },
    [
      clearBrowserWorkspaceIframeFocusTimer,
      monitorBrowserWorkspaceIframeFocus,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLIFrameElement) {
        releaseBrowserWorkspaceIframeFocusReturn(target);
        return;
      }
      if (!(target instanceof Element)) return;
      const focusTarget = target.closest<HTMLElement>(
        "button, input, textarea, select, a[href], [tabindex]",
      );
      if (!focusTarget || focusTarget === workspaceRootRef.current) return;
      for (const handoff of iframeFocusHandoffsRef.current.values()) {
        handoff.returnTarget = focusTarget;
        handoff.pendingTargetRestore = false;
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      for (const [iframe, handoff] of iframeFocusHandoffsRef.current) {
        releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
      }
    };
    const handleWindowBlur = () => {
      for (const [iframe, handoff] of iframeFocusHandoffsRef.current) {
        // Cross-origin child events cannot cross the iframe boundary, but the
        // embedding element is :active synchronously while a real pointer
        // press transfers focus. Page autofocus produces the same
        // activeElement transition without that activation signal.
        if (iframe.matches(":active")) {
          releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        }
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur, true);
      for (const timer of iframeFocusTimersRef.current) {
        window.clearTimeout(timer);
      }
      iframeFocusTimersRef.current.clear();
      iframeFocusHandoffsRef.current.clear();
    };
  }, [releaseBrowserWorkspaceIframeFocusReturn]);

  const loadWorkspace = useCallback(
    async (options?: {
      preferTabId?: string | null;
      silent?: boolean;
      background?: boolean;
    }) => {
      const lifecycleSignal = lifecycleAbortControllerRef.current.signal;
      if (lifecycleSignal.aborted) return;
      workspaceLoadAbortControllerRef.current?.abort(
        "Browser workspace refresh superseded",
      );
      const abortController = new AbortController();
      workspaceLoadAbortControllerRef.current = abortController;
      const abortForLifecycle = () =>
        abortController.abort(lifecycleSignal.reason);
      lifecycleSignal.addEventListener("abort", abortForLifecycle, {
        once: true,
      });
      const background = options?.background === true;
      const showLoading = options?.silent !== true;
      if (!background) {
        foregroundWorkspaceLoadsRef.current += 1;
      }
      const loadVersion = ++workspaceLoadVersionRef.current;
      if (showLoading) {
        visibleWorkspaceLoadsRef.current += 1;
        setLoading(true);
      }
      try {
        const snapshot = await client.getBrowserWorkspace({
          signal: abortController.signal,
        });
        if (loadVersion !== workspaceLoadVersionRef.current) return;
        const previousSnapshot = workspaceSnapshotRef.current;
        for (const nextTab of snapshot.tabs) {
          if (snapshot.mode === "web") {
            syncBrowserWalletFrameTarget(nextTab.id, nextTab.url);
          }
          const previousTab = previousSnapshot.tabs.find(
            (tab) => tab.id === nextTab.id,
          );
          if (!previousTab) {
            pendingIframeFocusReturnTargetsRef.current.set(
              nextTab.id,
              browserActionFocusReturnTargetRef.current ??
                readBrowserWorkspaceFocusReturnTarget(),
            );
            continue;
          }
          if (previousTab.url === nextTab.url) continue;
          const iframe = iframeRefs.current.get(nextTab.id);
          if (iframe) {
            armBrowserWorkspaceIframeFocusReturn(iframe, {
              preserveExistingForUrl: true,
              navigationUrl: nextTab.url,
            });
          }
        }
        if (previousSnapshot.mode === "web") {
          const nextTabIds = new Set(snapshot.tabs.map((tab) => tab.id));
          for (const previousTab of previousSnapshot.tabs) {
            if (snapshot.mode !== "web" || !nextTabIds.has(previousTab.id)) {
              revokeBrowserWalletFrame(previousTab.id);
            }
          }
        }
        workspaceSnapshotRef.current = snapshot;
        setWorkspace(snapshot);
        setLoadError(null);
        setSelectedTabId((current) =>
          resolveBrowserWorkspaceSelection(
            snapshot.tabs,
            options?.preferTabId ?? current,
          ),
        );
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (background || loadVersion !== workspaceLoadVersionRef.current) {
          // error-policy:J4 poll — retain the last successful workspace on a
          // transient background failure; the next visible tick retries.
          return;
        }
        setLoadError(resolveBrowserWorkspaceLoadError(error, tRef.current));
      } finally {
        lifecycleSignal.removeEventListener("abort", abortForLifecycle);
        if (workspaceLoadAbortControllerRef.current === abortController) {
          workspaceLoadAbortControllerRef.current = null;
        }
        if (!background) {
          foregroundWorkspaceLoadsRef.current -= 1;
        }
        if (showLoading) {
          visibleWorkspaceLoadsRef.current -= 1;
          if (visibleWorkspaceLoadsRef.current === 0) {
            setLoading(false);
          }
        }
      }
    },
    [
      armBrowserWorkspaceIframeFocusReturn,
      readBrowserWorkspaceFocusReturnTarget,
      revokeBrowserWalletFrame,
      syncBrowserWalletFrameTarget,
    ],
  );

  const runBrowserWorkspaceAction = useCallback(
    async (
      actionKey: string,
      action: () => Promise<void>,
      onErrorMessage?: string,
    ) => {
      const actionFocusReturnTarget = readBrowserWorkspaceFocusReturnTarget();
      browserActionFocusReturnTargetRef.current = actionFocusReturnTarget;
      workspaceActionsInFlightRef.current += 1;
      workspaceLoadVersionRef.current += 1;
      setBusyAction(actionKey);
      try {
        await action();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (onErrorMessage ??
              tRef.current("browserworkspace.ActionFailed", {
                defaultValue: "Browser action failed.",
              }));
        setActionNoticeRef.current(message, "error", 4_000);
      } finally {
        workspaceActionsInFlightRef.current -= 1;
        setBusyAction(null);
        if (
          browserActionFocusReturnTargetRef.current === actionFocusReturnTarget
        ) {
          browserActionFocusReturnTargetRef.current = null;
        }
      }
    },
    [readBrowserWorkspaceFocusReturnTarget],
  );

  const refreshWorkspaceInBackground = useCallback(async () => {
    // Native-mobile tabs are authoritative client state: the remote agent's
    // workspace endpoint deliberately has no matching native WebView tabs.
    // Polling that empty server snapshot would erase a tab (and its permanent
    // capability/error recovery surface) moments after the user opened it.
    if (browserTabRenderPath === "native-mobile-webview") return;
    if (
      backgroundWorkspaceRefreshInFlightRef.current ||
      foregroundWorkspaceLoadsRef.current > 0 ||
      workspaceActionsInFlightRef.current > 0
    ) {
      return;
    }
    backgroundWorkspaceRefreshInFlightRef.current = true;
    try {
      await loadWorkspace({
        preferTabId: selectedTabId,
        silent: true,
        background: true,
      });
    } finally {
      backgroundWorkspaceRefreshInFlightRef.current = false;
    }
  }, [browserTabRenderPath, loadWorkspace, selectedTabId]);

  const loadSelectedBrowserWorkspaceSnapshot = useCallback(
    async (tabId: string, mode: BrowserWorkspaceSnapshot["mode"]) => {
      if (!isBrowserWorkspaceSessionMode(mode)) {
        snapshotAbortControllerRef.current?.abort(
          "Browser preview is no longer active",
        );
        setSnapshotError(null);
        return;
      }
      const lifecycleSignal = lifecycleAbortControllerRef.current.signal;
      if (lifecycleSignal.aborted) return;
      snapshotAbortControllerRef.current?.abort(
        "Browser preview refresh superseded",
      );
      const abortController = new AbortController();
      snapshotAbortControllerRef.current = abortController;
      const abortForLifecycle = () =>
        abortController.abort(lifecycleSignal.reason);
      lifecycleSignal.addEventListener("abort", abortForLifecycle, {
        once: true,
      });
      try {
        const snapshot = await client.snapshotBrowserWorkspaceTab(tabId, {
          signal: abortController.signal,
        });
        setTabSnapshots((current) => {
          if (current[tabId] === snapshot.data) {
            return current;
          }
          return { ...current, [tabId]: snapshot.data };
        });
        setSnapshotError(null);
      } catch {
        if (abortController.signal.aborted) return;
        setSnapshotError(
          tRef.current("browserworkspace.SnapshotFailed", {
            defaultValue: "Preview couldn’t refresh. Retrying automatically.",
          }),
        );
      } finally {
        lifecycleSignal.removeEventListener("abort", abortForLifecycle);
        if (snapshotAbortControllerRef.current === abortController) {
          snapshotAbortControllerRef.current = null;
        }
      }
    },
    [],
  );

  const openNewBrowserWorkspaceTab = useCallback(
    async (
      rawUrl: string,
      sectionKey: BrowserWorkspaceTabSectionKey = "user",
    ) => {
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
      if (!url) {
        throw new Error(
          t("browserworkspace.EnterUrlToOpen", {
            defaultValue: "Enter a URL to open.",
          }),
        );
      }
      const partition = resolveBrowserWorkspaceTabPartition(sectionKey);
      // Native mobile shell: the server manages no tabs (its API 503s), so the
      // tab lives in client state and the isolated native surface loads the page.
      if (browserTabRenderPath === "native-mobile-webview") {
        const tab = buildLocalBrowserWorkspaceTab(
          url,
          inferBrowserWorkspaceTitle(url, t),
          partition ?? BROWSER_WORKSPACE_DEFAULT_PARTITION,
        );
        setWorkspace((prev) => ({ ...prev, tabs: [...prev.tabs, tab] }));
        setSelectedTabId(tab.id);
        setLocationInput(tab.url);
        setLocationDirty(false);
        return;
      }
      const { tab } = await client.openBrowserWorkspaceTab({
        url,
        title: inferBrowserWorkspaceTitle(url, t),
        partition,
        show: true,
      });
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setSelectedTabId(tab.id);
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [browserTabRenderPath, loadWorkspace, t],
  );

  const activateBrowserWorkspaceTab = useCallback(
    async (tabId: string) => {
      setSelectedTabId(tabId);
      // Native mobile shell: selection is client-side (the hook foregrounds the
      // matching native surface); there is no server tab to show.
      if (browserTabRenderPath === "native-mobile-webview") return;
      const { tab } = await client.showBrowserWorkspaceTab(tabId);
      await loadWorkspace({ preferTabId: tab.id, silent: true });
    },
    [browserTabRenderPath, loadWorkspace],
  );
  const registerBrowserWorkspaceIframe = useCallback(
    (tabId: string, iframe: HTMLIFrameElement | null) => {
      if (!iframe) {
        iframeRefs.current.delete(tabId);
        return;
      }
      if (!registeredIframeElementsRef.current.has(iframe)) {
        registeredIframeElementsRef.current.add(iframe);
        const pendingReturnTarget =
          pendingIframeFocusReturnTargetsRef.current.get(tabId);
        pendingIframeFocusReturnTargetsRef.current.delete(tabId);
        armBrowserWorkspaceIframeFocusReturn(iframe, {
          returnTarget: pendingReturnTarget,
          navigationUrl:
            workspaceSnapshotRef.current.tabs.find((tab) => tab.id === tabId)
              ?.url ?? undefined,
        });
      }
      iframeRefs.current.set(tabId, iframe);
    },
    [armBrowserWorkspaceIframeFocusReturn],
  );

  // Keep a ref so the host-message handler always sees the latest wallet
  // state without needing a fresh closure per render.
  browserWalletStateRef.current = browserWalletState;
  selectedTabIdRef.current = selectedTabId;

  // Wallet-action consent (eth_sendTransaction, personal_sign, eth_sign,
  // first-time eth_requestAccounts). Must be declared before
  // handleTabWalletRequest references it.
  const { confirm: walletActionConfirm, modalProps: walletActionModalProps } =
    useConfirm();

  const handleTabWalletRequest = useCallback(
    async (req: {
      tabId: string;
      requestId: number;
      protocol: "evm" | "solana";
      method: string;
      params: unknown;
      hostname: string;
    }): Promise<void> => {
      const tag = electrobunWebviewRefs.current.get(req.tabId);
      const reply = (payload: { result?: unknown; error?: string }): void => {
        if (!tag) return;
        tag.executeJavascript(
          `window.__elizaWalletReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`,
        );
      };
      const walletState = browserWalletStateRef.current;
      if (!walletState) {
        reply({ error: "Wallet state not yet loaded." });
        return;
      }
      const domain = (req.hostname || "this site").trim();
      try {
        const evmAddress = walletState.evmAddress;
        const solanaAddress = walletState.solanaAddress;
        if (req.protocol === "evm") {
          switch (req.method) {
            case "eth_requestAccounts": {
              if (!evmAddress) {
                reply({
                  error: walletState.reason ?? "No EVM wallet connected.",
                });
                return;
              }
              const allowed =
                walletConnectAllowedDomainsRef.current.has(domain) ||
                (await walletActionConfirm({
                  title: `Connect Eliza wallet to ${domain}`,
                  message: `${domain} is requesting your wallet address. Allow it to read ${formatAddressForDisplay(evmAddress)}?`,
                  confirmLabel: "Connect",
                  cancelLabel: "Reject",
                }));
              if (!allowed) {
                reply({ error: "User rejected wallet connection." });
                return;
              }
              walletConnectAllowedDomainsRef.current.add(domain);
              reply({ result: [evmAddress] });
              return;
            }
            case "eth_accounts": {
              if (!evmAddress) {
                reply({ result: [] });
                return;
              }
              // Per EIP-1193, eth_accounts returns the list of accounts
              // the dApp is already authorized to use; an unauthorized
              // dApp must see [], not a prompt. We honour that here so
              // we don't block silent polls behind a consent dialog.
              if (!walletConnectAllowedDomainsRef.current.has(domain)) {
                reply({ result: [] });
                return;
              }
              reply({ result: [evmAddress] });
              return;
            }
            case "eth_chainId": {
              const chainId = tabChainIdRef.current.get(req.tabId) ?? 1;
              reply({ result: `0x${chainId.toString(16)}` });
              return;
            }
            case "wallet_switchEthereumChain": {
              const arr = Array.isArray(req.params) ? req.params : [req.params];
              const next =
                arr[0] && typeof arr[0] === "object"
                  ? (arr[0] as { chainId?: unknown }).chainId
                  : null;
              const chainId = parseBrowserWorkspaceEvmChainId(next);
              if (!chainId) {
                reply({
                  error: "wallet_switchEthereumChain requires a valid chainId.",
                });
                return;
              }
              if (!isBrowserWorkspaceEvmChainSupported(chainId)) {
                reply({
                  error: getUnsupportedBrowserWorkspaceEvmChainError(chainId),
                });
                return;
              }
              tabChainIdRef.current.set(req.tabId, chainId);
              reply({ result: null });
              return;
            }
            case "personal_sign":
            case "eth_sign": {
              if (!walletState.messageSigningAvailable) {
                reply({
                  error:
                    walletState.mode === "steward"
                      ? "Browser message signing requires a local wallet key."
                      : (walletState.reason ??
                        "Browser wallet message signing is unavailable."),
                });
                return;
              }
              const message = resolveBrowserWorkspaceSignMessage(
                req.params,
                evmAddress,
              );
              if (!message) {
                reply({
                  error: "Browser wallet signing requires a message payload.",
                });
                return;
              }
              const allowed = await walletActionConfirm({
                title: `${domain} wants to sign a message`,
                message: `Message preview:\n\n${truncateMessageForDisplay(decodeSignableMessage(message))}\n\nAllow signing?`,
                confirmLabel: "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected message signing." });
                return;
              }
              const result = await client.signBrowserWalletMessage(message);
              reply({ result: result.signature });
              return;
            }
            case "eth_signTypedData":
            case "eth_signTypedData_v3":
            case "eth_signTypedData_v4": {
              reply({
                error:
                  "Typed-data signing is not supported by the Eliza browser wallet.",
              });
              return;
            }
            case "eth_sendTransaction": {
              if (!walletState.transactionSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Browser wallet transaction signing is unavailable.",
                });
                return;
              }
              const arr = Array.isArray(req.params) ? req.params : [req.params];
              const tx =
                arr[0] && typeof arr[0] === "object"
                  ? (arr[0] as Record<string, unknown>)
                  : null;
              if (!tx) {
                reply({
                  error: "eth_sendTransaction requires a transaction object.",
                });
                return;
              }
              const txChainId = parseBrowserWorkspaceEvmChainId(tx.chainId);
              const chainId =
                txChainId ?? tabChainIdRef.current.get(req.tabId) ?? 1;
              if (!isBrowserWorkspaceEvmChainSupported(chainId)) {
                reply({
                  error: getUnsupportedBrowserWorkspaceEvmChainError(chainId),
                });
                return;
              }
              tabChainIdRef.current.set(req.tabId, chainId);
              const value =
                typeof tx.value === "string"
                  ? tx.value.startsWith("0x")
                    ? BigInt(tx.value).toString()
                    : tx.value
                  : "0";
              const to = typeof tx.to === "string" ? tx.to : "";
              const allowed = await walletActionConfirm({
                title: `${domain} wants to send a transaction`,
                message: `From: ${formatAddressForDisplay(evmAddress ?? "")}\nTo: ${formatAddressForDisplay(to)}\nValue: ${formatWeiForDisplay(value)}\nChain: ${chainId}\n\nAllow this transaction?`,
                confirmLabel: "Send",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected transaction." });
                return;
              }
              const result = await client.sendBrowserWalletTransaction({
                broadcast: true,
                chainId,
                to,
                value,
                data: typeof tx.data === "string" ? tx.data : undefined,
                description:
                  typeof tx.description === "string"
                    ? tx.description
                    : undefined,
              });
              reply({ result: result.txHash ?? result.txId ?? null });
              const next = await loadBrowserWalletState();
              browserWalletStateRef.current = next;
              return;
            }
            default:
              reply({ error: `Unsupported EVM method: ${req.method}` });
              return;
          }
        }
        if (req.protocol === "solana") {
          switch (req.method) {
            case "connect": {
              if (!solanaAddress) {
                reply({
                  error: walletState.reason ?? "No Solana wallet connected.",
                });
                return;
              }
              const allowed =
                walletConnectAllowedDomainsRef.current.has(domain) ||
                (await walletActionConfirm({
                  title: `Connect Eliza Solana wallet to ${domain}`,
                  message: `${domain} is requesting your Solana address. Allow it to read ${formatAddressForDisplay(solanaAddress)}?`,
                  confirmLabel: "Connect",
                  cancelLabel: "Reject",
                }));
              if (!allowed) {
                reply({ error: "User rejected wallet connection." });
                return;
              }
              walletConnectAllowedDomainsRef.current.add(domain);
              reply({ result: { publicKey: solanaAddress } });
              return;
            }
            case "signMessage": {
              if (!walletState.solanaMessageSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Solana message signing is unavailable.",
                });
                return;
              }
              const messageBase64 =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>).messageBase64 as
                      | string
                      | undefined)
                  : undefined;
              const message =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>).message as
                      | string
                      | undefined)
                  : undefined;
              const previewSource =
                message ??
                (messageBase64
                  ? decodeBase64ForPreview(messageBase64)
                  : "(no message preview available)");
              const allowed = await walletActionConfirm({
                title: `${domain} wants to sign a Solana message`,
                message: `Message preview:\n\n${truncateMessageForDisplay(previewSource)}\n\nAllow signing?`,
                confirmLabel: "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected message signing." });
                return;
              }
              const result = await client.signBrowserSolanaMessage({
                ...(messageBase64 ? { messageBase64 } : {}),
                ...(message ? { message } : {}),
              });
              reply({ result });
              return;
            }
            case "signTransaction":
            case "signAndSendTransaction": {
              if (!walletState.solanaTransactionSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Solana transaction signing is unavailable.",
                });
                return;
              }
              const transactionBase64 =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>)
                      .transactionBase64 as string | undefined)
                  : undefined;
              if (!transactionBase64) {
                reply({
                  error:
                    "Solana transaction signing requires transactionBase64.",
                });
                return;
              }
              const willBroadcast = req.method === "signAndSendTransaction";
              const chain =
                req.params && typeof req.params === "object"
                  ? (req.params as Record<string, unknown>).chain
                  : undefined;
              const cluster =
                resolveSolanaCluster(
                  req.params && typeof req.params === "object"
                    ? (req.params as Record<string, unknown>).cluster
                    : undefined,
                ) ?? resolveSolanaCluster(chain);
              const description =
                req.params && typeof req.params === "object"
                  ? (req.params as Record<string, unknown>).description
                  : undefined;
              const effectiveDescription =
                typeof description === "string" && description.trim()
                  ? description.trim()
                  : typeof chain === "string" && chain.trim()
                    ? `Solana transaction on ${chain.trim()}`
                    : cluster
                      ? `Solana transaction on ${cluster}`
                      : undefined;
              const solanaDetails = [
                cluster ? `Cluster: ${cluster}` : null,
                typeof chain === "string" && chain.trim()
                  ? `Chain: ${chain.trim()}`
                  : null,
              ].filter(Boolean);
              const allowed = await walletActionConfirm({
                title: `${domain} wants to ${willBroadcast ? "send" : "sign"} a Solana transaction`,
                message: `From: ${formatAddressForDisplay(solanaAddress ?? "")}${solanaDetails.length ? `\n${solanaDetails.join("\n")}` : ""}\n${willBroadcast ? "Will broadcast on submit." : "Returns the signed bytes to the dApp; the dApp may broadcast."}\n\nAllow?`,
                confirmLabel: willBroadcast ? "Send" : "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected transaction." });
                return;
              }
              const result = await client.sendBrowserSolanaTransaction({
                transactionBase64,
                broadcast: willBroadcast,
                ...(cluster ? { cluster } : {}),
                ...(effectiveDescription
                  ? { description: effectiveDescription }
                  : {}),
              });
              reply({ result });
              return;
            }
            default:
              reply({ error: `Unsupported Solana method: ${req.method}` });
              return;
          }
        }
        reply({ error: `Unsupported wallet protocol: ${req.protocol}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ error: message });
      }
    },
    [loadBrowserWalletState, walletActionConfirm],
  );

  // ── Vault autofill ────────────────────────────────────────────────
  // The in-tab preload sends `__elizaVaultAutofillRequest` whenever it
  // detects a login form. We resolve credentials from the vault via the
  // app API, prompt the user once per domain (unless they have flagged
  // the domain as auto-allow), then reply with the field values to fill.
  // No silent autofill: every reply that carries fields requires explicit
  // user consent, either at request time or via a previously stored
  // `creds.<domain>.:autoallow` entry.
  const { confirm: vaultAutofillConfirm, modalProps: vaultAutofillModalProps } =
    useConfirm();
  const browserWorkspaceConfirmOpen =
    walletActionModalProps.open || vaultAutofillModalProps.open;

  // Mobile native tab surfaces: iOS gives each Browser tab a fresh WKProcessPool
  // and data store; Android uses an out-of-app sandboxed renderer (which the OS
  // may reuse across WebViews) plus a per-tab storage profile. Surfaces are
  // backgrounded while the tab
  // switcher or any confirm dialog is open so the native layer never paints over
  // those React overlays — the mobile analogue of the desktop `masks=`.
  const nativeSurfaceTabs = useMemo(
    () => workspace.tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    [workspace.tabs],
  );
  const nativeMobileTabPath = browserTabRenderPath === "native-mobile-webview";
  const nativeTabSurfaces = useMobileNativeTabSurfaces({
    active: nativeMobileTabPath,
    tabs: nativeSurfaceTabs,
    selectedTabId,
    overlayOpen: switcherOpen || browserWorkspaceConfirmOpen,
    occlusionSelector: BROWSER_WORKSPACE_TAB_MASK_SELECTORS,
    policy: BROWSER_NATIVE_SURFACE_POLICY,
    lifecycle: BROWSER_SURFACE_MANIFEST.lifecycle,
    onNavigation: ({ tabId, url, previousUrl }) => {
      setWorkspace((previous) => {
        const tab = previous.tabs.find((entry) => entry.id === tabId);
        // Do not let a late native observation replace a newer address-bar
        // command that React has not yet sent across the native bridge.
        if (!tab || tab.url === url || tab.url !== previousUrl) return previous;
        return {
          ...previous,
          tabs: previous.tabs.map((entry) =>
            entry.id === tabId
              ? { ...entry, url, updatedAt: new Date().toISOString() }
              : entry,
          ),
        };
      });
    },
  });

  const navigateSelectedBrowserWorkspaceTab = useCallback(
    async (rawUrl: string) => {
      if (selectedTab && isInternalBrowserWorkspaceTab(selectedTab)) {
        throw new Error(
          t("browserworkspace.InternalTabUrlManaged", {
            defaultValue: "This internal tab manages its own URL.",
          }),
        );
      }
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
      if (!url) {
        throw new Error(
          t("browserworkspace.EnterUrlToNavigate", {
            defaultValue: "Enter a URL to navigate.",
          }),
        );
      }
      if (!selectedTabId) {
        await openNewBrowserWorkspaceTab(url);
        return;
      }
      // A changed URL is reconciled through tab state. Repeating the current
      // URL must explicitly reload: unchanged state cannot retry a failed page.
      if (browserTabRenderPath === "native-mobile-webview") {
        if (selectedTab?.url === url) {
          nativeTabSurfaces.reloadSurface(selectedTabId);
          setLocationInput(url);
          setLocationDirty(false);
          return;
        }
        setWorkspace((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === selectedTabId
              ? { ...tab, url, updatedAt: new Date().toISOString() }
              : tab,
          ),
        }));
        setLocationInput(url);
        setLocationDirty(false);
        return;
      }
      const { tab } = await client.navigateBrowserWorkspaceTab(
        selectedTabId,
        url,
      );
      if (workspace.mode === "web") {
        // React won't re-navigate an existing iframe when only the src
        // attribute changes (same key = same DOM element). Set the src
        // directly via the ref in embedded web mode only.
        const iframe = iframeRefs.current.get(selectedTabId);
        if (iframe && iframe.src !== tab.url) {
          beginBrowserWalletFrameNavigation(selectedTabId, tab.url);
          armBrowserWorkspaceIframeFocusReturn(iframe, {
            navigationUrl: tab.url,
          });
          iframe.src = tab.url;
        }
      } else if (workspace.mode === "desktop") {
        const tag = electrobunWebviewRefs.current.get(selectedTabId);
        tag?.loadURL(tab.url);
      }
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [
      armBrowserWorkspaceIframeFocusReturn,
      beginBrowserWalletFrameNavigation,
      browserTabRenderPath,
      loadWorkspace,
      nativeTabSurfaces.reloadSurface,
      openNewBrowserWorkspaceTab,
      selectedTab,
      selectedTabId,
      t,
      workspace.mode,
    ],
  );

  // Remote browser actions mutate the server workspace. Native mobile tabs are
  // deliberately local, so mirror the completed action's verified deep-link
  // URL into the currently mounted secure WebView instead of leaving it on the
  // previous page. The same deep link handles the first navigation on mount;
  // this listener covers subsequent actions while /browser is already active.
  useEffect(() => {
    if (!browserWorkspaceUsesLocalTabs) return;
    const handleAgentBrowserNavigation = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (detail?.viewId !== "browser" || !detail.viewPath) return;
      const query = detail.viewPath.split("?", 2)[1];
      const rawUrl = query
        ? new URLSearchParams(query).get("browse")?.trim()
        : null;
      if (!rawUrl) return;
      void runBrowserWorkspaceAction(
        "agent:navigate",
        async () => {
          await navigateSelectedBrowserWorkspaceTab(rawUrl);
        },
        t("browserworkspace.NavigationFailed", {
          defaultValue: "Couldn’t open that page.",
        }),
      );
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, handleAgentBrowserNavigation);
    return () =>
      window.removeEventListener(
        NAVIGATE_VIEW_EVENT,
        handleAgentBrowserNavigation,
      );
  }, [
    browserWorkspaceUsesLocalTabs,
    navigateSelectedBrowserWorkspaceTab,
    runBrowserWorkspaceAction,
    t,
  ]);

  const readNativePage = useCallback(
    async (selector?: string) => {
      if (!selectedTabId) throw new Error("No native Browser tab is selected.");
      return nativeTabSurfaces.readPage(selectedTabId, selector);
    },
    [selectedTabId, nativeTabSurfaces.readPage],
  );

  const handleTabVaultAutofillRequest = useCallback(
    async (req: {
      tabId: string;
      requestId: number;
      domain: string;
      url: string;
      fieldHints: ReadonlyArray<{
        kind: "username" | "password";
        selector: string;
      }>;
    }): Promise<void> => {
      const tag = electrobunWebviewRefs.current.get(req.tabId);
      const reply = (payload: {
        fields?: Record<string, string>;
        error?: string;
      }): void => {
        if (!tag) return;
        tag.executeJavascript(
          `window.__elizaVaultReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`,
        );
      };

      const userHint = req.fieldHints.find((h) => h.kind === "username");
      const passwordHint = req.fieldHints.find((h) => h.kind === "password");
      if (!passwordHint) {
        // No password slot — nothing to autofill.
        reply({ fields: {} });
        return;
      }

      try {
        // Aggregate from every signed-in backend. The manager filters by
        // domain (case-insensitive); external adapters list everything
        // and filter client-side because their CLIs don't accept a
        // domain filter.
        const { logins } = await client.listSavedLogins(req.domain);
        // The manager already filters by domain, but we double-check
        // here against the registrable hostname. External entries with
        // a missing or non-matching domain are dropped — they aren't
        // valid candidates for this form.
        const requestDomain = req.domain.toLowerCase();
        const candidates = logins.filter(
          (l) =>
            typeof l.domain === "string" &&
            l.domain.toLowerCase() === requestDomain,
        );
        if (candidates.length === 0) {
          reply({ fields: {} });
          return;
        }

        // Pick the most-recently-modified entry; first-save flows typically
        // have one entry per domain.
        const sorted = [...candidates].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        const chosen = sorted[0];
        if (!chosen) {
          reply({ fields: {} });
          return;
        }

        const sourceLabel =
          chosen.source === "1password"
            ? "1Password"
            : chosen.source === "bitwarden"
              ? "Bitwarden"
              : "local vault";

        const allowed = await client.getAutofillAllowed(req.domain);
        const consented =
          allowed ||
          (await vaultAutofillConfirm({
            title: `Autofill ${req.domain}`,
            message: `Sign in as ${chosen.username || chosen.title} from ${sourceLabel}?\n\nEliza will fill the saved username and password for this site.`,
            confirmLabel: "Allow",
            cancelLabel: "Deny",
          }));
        if (!consented) {
          reply({ fields: {} });
          return;
        }

        const reveal = await client.revealSavedLogin(
          chosen.source,
          chosen.identifier,
        );

        const fields: Record<string, string> = {};
        if (userHint) fields[userHint.selector] = reveal.username;
        fields[passwordHint.selector] = reveal.password;
        reply({ fields });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ error: message });
      }
    },
    [vaultAutofillConfirm],
  );

  const handleTabHostMessage = useCallback(
    (tabId: string, event: CustomEvent) => {
      const detail = event.detail as
        | {
            type?: string;
            requestId?: number;
            ok?: boolean;
            result?: unknown;
            error?: string;
            protocol?: "evm" | "solana";
            method?: string;
            params?: unknown;
            origin?: string;
            hostname?: string;
            domain?: string;
            url?: string;
            fieldHints?: Array<{
              kind?: string;
              selector?: string;
            }>;
          }
        | null
        | undefined;
      if (!detail || typeof detail.type !== "string") return;

      if (
        detail.type === "__elizaTabExecResult" &&
        typeof detail.requestId === "number"
      ) {
        const pending = pendingTabExecsRef.current.get(detail.requestId);
        if (!pending) return;
        pendingTabExecsRef.current.delete(detail.requestId);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: detail.ok === true,
          result: detail.result,
          error: detail.error,
        });
        return;
      }

      if (
        detail.type === "__elizaWalletRequest" &&
        typeof detail.requestId === "number" &&
        typeof detail.protocol === "string" &&
        typeof detail.method === "string"
      ) {
        void handleTabWalletRequest({
          tabId,
          requestId: detail.requestId,
          protocol: detail.protocol,
          method: detail.method,
          params: detail.params,
          hostname: typeof detail.hostname === "string" ? detail.hostname : "",
        });
        return;
      }

      if (
        detail.type === "__elizaVaultAutofillRequest" &&
        typeof detail.requestId === "number" &&
        typeof detail.domain === "string" &&
        typeof detail.url === "string" &&
        Array.isArray(detail.fieldHints)
      ) {
        const fieldHints: Array<{
          kind: "username" | "password";
          selector: string;
        }> = [];
        for (const hint of detail.fieldHints) {
          if (
            hint &&
            (hint.kind === "username" || hint.kind === "password") &&
            typeof hint.selector === "string" &&
            hint.selector.length > 0
          ) {
            fieldHints.push({ kind: hint.kind, selector: hint.selector });
          }
        }
        void handleTabVaultAutofillRequest({
          tabId,
          requestId: detail.requestId,
          domain: detail.domain,
          url: detail.url,
          fieldHints,
        });
      }
    },
    [handleTabWalletRequest, handleTabVaultAutofillRequest],
  );

  const registerBrowserWorkspaceElectrobunWebview = useCallback(
    (tabId: string, element: WebviewTagElement | null) => {
      const previous = electrobunWebviewRefs.current.get(tabId);
      const previousHandler =
        electrobunHostMessageHandlersRef.current.get(tabId);
      if (previous && previous !== element) {
        if (previousHandler) {
          previous.off("host-message", previousHandler);
        }
        electrobunHostMessageHandlersRef.current.delete(tabId);
      }
      if (!element) {
        if (previous && previousHandler) {
          previous.off("host-message", previousHandler);
        }
        electrobunHostMessageHandlersRef.current.delete(tabId);
        electrobunWebviewRefs.current.delete(tabId);
        return;
      }
      if (previous !== element) {
        const hostMessageHandler = (event: CustomEvent) =>
          handleTabHostMessage(tabId, event);
        electrobunHostMessageHandlersRef.current.set(tabId, hostMessageHandler);
        element.on("host-message", hostMessageHandler);
        // Poke the OOPIF to read fresh dimensions multiple times — the
        // tag auto-syncs only on its own ResizeObserver firing, and that
        // can miss the initial layout settle if the parent flex chain is
        // still computing on first mount.
        const sync = () => {
          try {
            element.syncDimensions(true);
          } catch {
            // Element may have unmounted.
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => requestAnimationFrame(sync));
        } else {
          setTimeout(sync, 0);
        }
        // Safety net for late-settling layouts (image-driven shifts, web
        // fonts loading, etc.). The poll loop in the upstream tag runs
        // every 100ms anyway — these poke a forceSync on top.
        setTimeout(sync, 250);
        setTimeout(sync, 1000);
        // Hide the native OOPIF immediately if the tag isn't the active
        // one — otherwise its native view sits over the surface and
        // intercepts clicks while React still has it in the tree.
        // Passthrough goes along for the ride so any clicks landing on the
        // rect mid-transition fall through to React siblings beneath.
        if (selectedTabIdRef.current && selectedTabIdRef.current !== tabId) {
          try {
            element.toggleHidden(true);
            element.togglePassthrough(true);
          } catch {
            // best-effort
          }
        }
      }
      electrobunWebviewRefs.current.set(tabId, element);
    },
    [handleTabHostMessage],
  );

  // Track the surface container so layout changes (sidebar collapse,
  // window resize, route entry) re-poke every mounted tag. Without this
  // the OOPIF can latch at whatever rect it had on first mount because
  // Electrobun's OverlaySyncController only fires onSync when the rect
  // *changes* — a small-but-stable rect persists.
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [iframeScale, setIframeScale] = useState(1);
  useEffect(() => {
    const surface = browserSurfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const pokeAll = (): void => {
      // Cross-origin frames cannot inherit a mobile viewport policy from the
      // host. Give narrow panels a compact 400px layout viewport and fit it
      // into the surface, rather than clipping sites with that minimum width.
      // Grow the logical height by the same ratio so no blank strip remains.
      const width = surface.getBoundingClientRect().width;
      setIframeScale(width > 0 ? Math.min(1, width / 400) : 1);
      for (const element of electrobunWebviewRefs.current.values()) {
        try {
          element?.syncDimensions(true);
        } catch {
          // Tag may have been unmounted between observation and dispatch.
        }
      }
    };
    const observer = new ResizeObserver(() => pokeAll());
    observer.observe(surface);
    pokeAll();
    return () => {
      observer.disconnect();
    };
  }, []);

  // Drive native hide/show on every tag whenever selection or an in-app
  // consent dialog changes. The native webview is an OOPIF overlay, so
  // React dialogs are otherwise rendered under it and cannot be acted on.
  // HTML `hidden` attribute does NOT propagate to the OOPIF — only the
  // tag's `toggleHidden(bool)` method does. Without this, inactive tabs'
  // OOPIFs stay painted over the surface as native views and intercept
  // clicks intended for sibling UI (e.g. the top app nav). Passthrough is
  // toggled in lockstep so a tab caught mid-transition (visible but not
  // selected) still lets clicks fall through to the React layer beneath.
  useEffect(() => {
    if (workspace.mode !== "desktop") return;
    for (const [tabId, element] of electrobunWebviewRefs.current.entries()) {
      if (!element) continue;
      // Hide + engage passthrough whenever the tab is inactive OR an
      // in-app consent dialog is open over the surface, so the dialog (a
      // React sibling) renders above the native OOPIF and stays clickable.
      const occluded = browserWorkspaceConfirmOpen || tabId !== selectedTabId;
      try {
        element.toggleHidden(occluded);
        element.togglePassthrough(occluded);
        element.syncDimensions(true);
      } catch {
        // best-effort
      }
    }
  }, [browserWorkspaceConfirmOpen, selectedTabId, workspace.mode]);

  // On unmount, hide every OOPIF and engage passthrough so leftover native
  // views don't bleed onto other routes between React's unmount and the
  // tag's disconnectedCallback firing.
  useEffect(() => {
    const refs = electrobunWebviewRefs;
    const handlers = electrobunHostMessageHandlersRef;
    return () => {
      for (const [tabId, element] of refs.current.entries()) {
        try {
          const handler = handlers.current.get(tabId);
          if (element && handler) {
            element.off("host-message", handler);
          }
          element?.toggleHidden(true);
          element?.togglePassthrough(true);
        } catch {
          // best-effort
        }
      }
      handlers.current.clear();
    };
  }, []);

  useEffect(() => {
    const tagsRef = electrobunWebviewRefs;
    const pendingsRef = pendingTabExecsRef;
    const counterRef = tabExecCounterRef;
    setBrowserTabsRendererImpl({
      evaluate: (id, script, timeoutMs) =>
        new Promise((resolve) => {
          const tag = tagsRef.current.get(id);
          if (!tag) {
            resolve({
              ok: false,
              error: `browser workspace tab ${id} is not mounted in the renderer`,
            });
            return;
          }
          counterRef.current += 1;
          const requestId = counterRef.current;
          const timer = setTimeout(() => {
            if (pendingsRef.current.delete(requestId)) {
              resolve({
                ok: false,
                error: `browser workspace tab eval timed out after ${timeoutMs}ms`,
              });
            }
          }, timeoutMs);
          pendingsRef.current.set(requestId, { resolve, timer });
          tag.executeJavascript(
            `window.__elizaTabExec(${JSON.stringify(requestId)}, ${JSON.stringify(script)})`,
          );
        }),
      getTabRect: async (id) => {
        const tag = tagsRef.current.get(id);
        if (!tag) return null;
        const rect = tag.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      },
    });
    return () => {
      setBrowserTabsRendererImpl(null);
      for (const pending of pendingsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          ok: false,
          error: "BrowserWorkspaceView unmounted",
        });
      }
      pendingsRef.current.clear();
    };
  }, []);

  const closeBrowserWorkspaceTabById = useCallback(
    async (tabId: string) => {
      // Native mobile shell: tabs are client-side. Drop the tab from state (the
      // hook tears down its native surface) and select a neighbour.
      if (browserTabRenderPath === "native-mobile-webview") {
        setWorkspace((prev) => {
          const remaining = prev.tabs.filter((tab) => tab.id !== tabId);
          if (tabId === selectedTabId) {
            setSelectedTabId(remaining[0]?.id ?? null);
          }
          return { ...prev, tabs: remaining };
        });
        return;
      }
      await client.closeBrowserWorkspaceTab(tabId);
      revokeBrowserWalletFrame(tabId);
      const snapshot = await client.getBrowserWorkspace({
        signal: lifecycleAbortControllerRef.current.signal,
      });
      const nextId =
        snapshot.tabs.find((tab) => tab.id === selectedTabId)?.id ??
        snapshot.tabs[0]?.id ??
        null;
      if (nextId && nextId !== selectedTabId) {
        await client.showBrowserWorkspaceTab(nextId);
      }
      await loadWorkspace({
        preferTabId: nextId,
        silent: true,
      });
    },
    [
      browserTabRenderPath,
      loadWorkspace,
      revokeBrowserWalletFrame,
      selectedTabId,
    ],
  );

  const closeAllBrowserWorkspaceTabs = useCallback(async () => {
    const closableTabs = workspace.tabs.filter(
      (tab) => !isInternalBrowserWorkspaceTab(tab),
    );
    // Native mobile follows the same client-owned lifecycle as opening and
    // closing one tab. Calling the server here can only fail because no remote
    // workspace exists for these native WebViews.
    if (browserTabRenderPath === "native-mobile-webview") {
      const remainingTabs = workspace.tabs.filter((tab) =>
        isInternalBrowserWorkspaceTab(tab),
      );
      const nextId = remainingTabs[0]?.id ?? null;
      setWorkspace((current) => ({ ...current, tabs: remainingTabs }));
      setSelectedTabId(nextId);
      setLocationInput(
        remainingTabs.find((tab) => tab.id === nextId)?.url ?? "",
      );
      setLocationDirty(false);
      return;
    }
    for (const tab of closableTabs) {
      await client.closeBrowserWorkspaceTab(tab.id);
      revokeBrowserWalletFrame(tab.id);
    }
    const snapshot = await client.getBrowserWorkspace({
      signal: lifecycleAbortControllerRef.current.signal,
    });
    const nextId = snapshot.tabs[0]?.id ?? null;
    if (nextId) {
      await client.showBrowserWorkspaceTab(nextId);
    }
    setSelectedTabId(nextId);
    setLocationInput(snapshot.tabs.find((tab) => tab.id === nextId)?.url ?? "");
    setLocationDirty(false);
    await loadWorkspace({ preferTabId: nextId, silent: true });
  }, [
    browserTabRenderPath,
    loadWorkspace,
    revokeBrowserWalletFrame,
    workspace.tabs,
  ]);

  useEffect(() => {
    if (initialWorkspaceLoadStartedRef.current) return;
    initialWorkspaceLoadStartedRef.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void loadBrowserWalletState();
  }, [loadBrowserWalletState]);

  useIntervalWhenDocumentVisible(() => {
    void refreshWorkspaceInBackground();
  }, POLL_INTERVAL_MS);

  useEffect(() => {
    if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
      setSnapshotError(null);
      return;
    }
    void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
  }, [loadSelectedBrowserWorkspaceSnapshot, selectedTabId, workspace.mode]);

  useIntervalWhenDocumentVisible(
    () => {
      if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
        return;
      }
      void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
    },
    POLL_INTERVAL_MS,
    Boolean(selectedTabId) && isBrowserWorkspaceSessionMode(workspace.mode),
  );

  useIntervalWhenDocumentVisible(() => {
    void loadBrowserWalletState();
  }, 5_000);

  useEffect(() => {
    const currentSelectedId = selectedTab?.id ?? null;
    if (currentSelectedId !== previousSelectedTabIdRef.current) {
      previousSelectedTabIdRef.current = currentSelectedId;
      setLocationInput(selectedTab?.url ?? "");
      setLocationDirty(false);
      return;
    }
    if (!locationDirty) {
      setLocationInput(selectedTab?.url ?? "");
    }
  }, [locationDirty, selectedTab?.id, selectedTab?.url]);

  useEffect(() => {
    if (
      !initialBrowseUrlRef.current ||
      initialBrowseHandledRef.current ||
      loading ||
      browserWorkspaceUnavailable
    ) {
      return;
    }

    initialBrowseHandledRef.current = true;
    const existing = workspace.tabs.find(
      (tab) => tab.url === initialBrowseUrlRef.current,
    );
    if (existing) {
      void runBrowserWorkspaceAction(
        `show:${existing.id}`,
        async () => {
          await activateBrowserWorkspaceTab(existing.id);
        },
        t("browserworkspace.OpenInitialBrowseFailed", {
          defaultValue: "Failed to activate the requested browser tab.",
        }),
      );
      return;
    }

    void runBrowserWorkspaceAction(
      "open:initial-browse",
      async () => {
        await openNewBrowserWorkspaceTab(initialBrowseUrlRef.current ?? "");
      },
      t("browserworkspace.OpenInitialBrowseFailed", {
        defaultValue: "Failed to open the requested browser tab.",
      }),
    );
  }, [
    activateBrowserWorkspaceTab,
    browserWorkspaceUnavailable,
    loading,
    openNewBrowserWorkspaceTab,
    runBrowserWorkspaceAction,
    t,
    workspace.tabs,
  ]);

  const reloadSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTab) return;
    if (browserTabRenderPath === "native-mobile-webview") {
      nativeTabSurfaces.reloadSurface(selectedTab.id);
      return;
    }
    if (workspace.mode === "web") {
      const iframe = iframeRefs.current.get(selectedTab.id);
      if (iframe) {
        beginBrowserWalletFrameNavigation(selectedTab.id, selectedTab.url);
        armBrowserWorkspaceIframeFocusReturn(iframe, {
          navigationUrl: selectedTab.url,
        });
        iframe.src = selectedTab.url;
      }
      return;
    }
    if (workspace.mode === "desktop") {
      const tag = electrobunWebviewRefs.current.get(selectedTab.id);
      tag?.reload();
      return;
    }
    await client.navigateBrowserWorkspaceTab(selectedTab.id, selectedTab.url);
  }, [
    armBrowserWorkspaceIframeFocusReturn,
    beginBrowserWalletFrameNavigation,
    browserTabRenderPath,
    nativeTabSurfaces,
    selectedTab,
    workspace.mode,
  ]);

  const backSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTab) return;
    if (nativeMobileTabPath) {
      await nativeTabSurfaces.backSurface(selectedTab.id);
      return;
    }
    const nativeTag = electrobunWebviewRefs.current.get(selectedTab.id);
    if (nativeTag) {
      nativeTag.executeJavascript("history.back()");
      return;
    }
    const result = await client.fetch<{ tab?: BrowserWorkspaceTab }>(
      "/api/browser-workspace/command",
      {
        method: "POST",
        body: JSON.stringify({ subaction: "back", id: selectedTab.id }),
      },
    );
    if (result.tab) {
      setLocationInput(result.tab.url);
      setLocationDirty(false);
      await loadWorkspace({ preferTabId: result.tab.id, silent: true });
    }
  }, [selectedTab, loadWorkspace, nativeMobileTabPath, nativeTabSurfaces]);

  const tabsLabel = t("browserworkspace.Tabs", {
    defaultValue: "Tabs",
  });
  const userTabsLabel = t("browserworkspace.UserTabs", {
    defaultValue: "User Tabs",
  });
  const agentTabsLabel = t("browserworkspace.AgentTabs", {
    defaultValue: "Agent Tabs",
  });
  const appTabsLabel = t("browserworkspace.AppTabs", {
    defaultValue: "App Tabs",
  });
  const newTabLabel = t("browserworkspace.NewTab", {
    defaultValue: "New tab",
  });
  const closeTabLabel = t("browserworkspace.CloseTab", {
    defaultValue: "Close tab",
  });
  const goLabel = t("browserworkspace.Go", {
    defaultValue: "Go",
  });
  const agentActiveLabel = t("browserworkspace.AgentActive", {
    defaultValue: "Agent is on this tab",
  });

  // Map the section-grouped tabs down to the switcher's display shape and fold
  // them (#13596). The switcher — not a permanent sidebar strip — is the only
  // multi-tab surface, so it must carry every section (agent tabs stay visually
  // distinct) while the toolbar shows just the folded count + active label.
  const switcherTabs = useMemo<BrowserSwitcherTab[]>(
    () =>
      workspace.tabs.map((tab) => {
        const label = getBrowserWorkspaceTabLabel(tab, t);
        return {
          id: tab.id,
          label,
          description: getBrowserWorkspaceTabDescription(tab, workspace.mode),
          monogram: getBrowserWorkspaceTabMonogram(label),
          section: resolveBrowserWorkspaceTabSectionKey(tab),
          closable: !isInternalBrowserWorkspaceTab(tab),
          hasSessionFocus:
            workspace.mode === "web" ? tab.visible : tab.id === selectedTabId,
        };
      }),
    [selectedTabId, t, workspace.mode, workspace.tabs],
  );
  const foldedTabs = useMemo(
    () =>
      foldBrowserTabs(switcherTabs, selectedTabId, {
        user: userTabsLabel,
        agent: agentTabsLabel,
        app: appTabsLabel,
      }),
    [switcherTabs, selectedTabId, userTabsLabel, agentTabsLabel, appTabsLabel],
  );
  const foldControlActiveLabel =
    foldedTabs.activeTab?.label ??
    t("browserworkspace.NoActiveTab", { defaultValue: "No tab" });
  const openTabSwitcherLabel = t("browserworkspace.OpenTabSwitcher", {
    defaultValue: "Show {{count}} tabs",
    count: foldedTabs.count,
  });

  const openTabSwitcher = useCallback(() => {
    setSwitcherOpen(true);
  }, []);

  const handleTabSwitcherOpenChange = useCallback((open: boolean) => {
    setSwitcherOpen(open);
  }, []);

  const navNode = (
    <div className="flex items-center gap-0 px-0.5 py-1 md:grid md:grid-cols-[2.75rem_minmax(10rem,4fr)_repeat(3,2.75rem)_minmax(10rem,5fr)_repeat(2,2.75rem)] md:gap-x-2 md:gap-y-1 md:px-2 md:py-0.5">
      <TooltipHint
        content={t("browserworkspace.Back", {
          defaultValue: "Back",
        })}
      >
        <BrowserNavButton
          agentId="back"
          agentLabel="Back"
          agentDescription="Go back in the active browser tab"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction(
              "navigate:back",
              backSelectedBrowserWorkspaceTab,
            )
          }
          onClick={() =>
            void runBrowserWorkspaceAction(
              "navigate:back",
              backSelectedBrowserWorkspaceTab,
            )
          }
          aria-label={t("browserworkspace.Back", { defaultValue: "Back" })}
          disabled={!selectedTab || busyAction !== null}
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </BrowserNavButton>
      </TooltipHint>
      {/* Folded tabs (#13596): one compact count control opens the switcher —
          no permanent tab strip. It names the active tab so the user always
          knows which page is live even with the rest folded away. */}
      <BrowserTabFoldControl
        activeLabel={foldControlActiveLabel}
        count={foldedTabs.count}
        openLabel={openTabSwitcherLabel}
        onOpen={openTabSwitcher}
        controlRef={switcherReturnFocusRef}
      />
      <span className="max-md:hidden">
        <BrowserNavButton
          agentId="new-tab"
          agentLabel={newTabLabel}
          agentDescription="Open a new browser tab"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction("open:new", async () => {
              await openNewBrowserWorkspaceTab(
                newBrowserWorkspaceTabSeedUrl,
                "user",
              );
            })
          }
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label={newTabLabel}
          disabled={busyAction !== null || browserWorkspaceUnavailable}
          onClick={() =>
            void runBrowserWorkspaceAction("open:new", async () => {
              await openNewBrowserWorkspaceTab(
                newBrowserWorkspaceTabSeedUrl,
                "user",
              );
            })
          }
          data-testid="browser-workspace-nav-new-tab"
        >
          <Plus className="size-4" />
        </BrowserNavButton>
      </span>
      <span className="max-md:hidden">
        <BrowserNavButton
          agentId="reload"
          agentLabel={t("common.refresh", { defaultValue: "Refresh" })}
          agentDescription="Reload the active browser tab"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction("reload:selected", async () => {
              await reloadSelectedBrowserWorkspaceTab();
            })
          }
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("common.refresh", { defaultValue: "Refresh" })}
          disabled={!selectedTab || busyAction !== null}
          onClick={() =>
            void runBrowserWorkspaceAction("reload:selected", async () => {
              await reloadSelectedBrowserWorkspaceTab();
            })
          }
        >
          <RefreshCw className="size-4" />
        </BrowserNavButton>
      </span>
      <span className="max-md:hidden">
        <BrowserNavButton
          agentId="close-all-tabs"
          agentLabel={t("browserworkspace.CloseAllTabs", {
            defaultValue: "Close all tabs",
          })}
          agentDescription="Close every user browser tab"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction("close:all", async () => {
              await closeAllBrowserWorkspaceTabs();
            })
          }
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("browserworkspace.CloseAllTabs", {
            defaultValue: "Close all tabs",
          })}
          disabled={
            busyAction !== null ||
            !workspace.tabs.some((tab) => !isInternalBrowserWorkspaceTab(tab))
          }
          onClick={() =>
            void runBrowserWorkspaceAction("close:all", async () => {
              await closeAllBrowserWorkspaceTabs();
            })
          }
          data-testid="browser-workspace-close-all-tabs"
        >
          <X className="size-4" />
        </BrowserNavButton>
      </span>
      <BrowserAddressInput
        agentLabel={t("browserworkspace.AddressPlaceholder", {
          defaultValue: selectedTabIsInternal
            ? "Internal tab URL is managed by the app"
            : "Enter a URL",
        })}
        agentDescription="The browser address bar for the active tab"
        getValue={() => locationInput}
        onFill={(value) => {
          setLocationInput(value);
          setLocationDirty(true);
        }}
        value={locationInput}
        onChange={(event) => {
          setLocationInput(event.target.value);
          setLocationDirty(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void runBrowserWorkspaceAction("navigate:enter", async () => {
              await navigateSelectedBrowserWorkspaceTab(locationInput);
            });
          }
        }}
        placeholder={t("browserworkspace.AddressPlaceholder", {
          defaultValue: selectedTabIsInternal
            ? "Internal tab URL is managed by the app"
            : "Enter a URL",
        })}
        data-testid="browser-workspace-address-input"
        disabled={
          busyAction !== null ||
          selectedTabIsInternal ||
          browserWorkspaceUnavailable
        }
        className="h-11 min-w-0 flex-1 rounded-full border-border/70 bg-bg/80 px-3 text-sm text-txt md:col-span-1 md:min-w-[10rem] md:px-4"
      />
      <BrowserNavButton
        agentId="go"
        agentLabel={goLabel}
        agentDescription="Navigate the active tab to the address bar URL"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("navigate:click", async () => {
            await navigateSelectedBrowserWorkspaceTab(locationInput);
          })
        }
        variant="ghost"
        size="icon"
        className="hidden size-11 shrink-0 md:inline-flex"
        aria-label={goLabel}
        disabled={
          busyAction !== null ||
          selectedTabIsInternal ||
          browserWorkspaceUnavailable ||
          locationInput.trim().length === 0
        }
        onClick={() =>
          void runBrowserWorkspaceAction("navigate:click", async () => {
            await navigateSelectedBrowserWorkspaceTab(locationInput);
          })
        }
      >
        <ArrowRight className="size-4" aria-hidden />
      </BrowserNavButton>
      <span className="max-md:hidden">
        <BrowserNavButton
          agentId="open-external"
          agentLabel={t("browserworkspace.OpenExternal", {
            defaultValue: "Open external",
          })}
          agentDescription="Open the active tab URL in an external browser"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction("open:external", async () => {
              if (!selectedTab) return;
              await openExternalUrl(selectedTab.url);
            })
          }
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("browserworkspace.OpenExternal", {
            defaultValue: "Open external",
          })}
          disabled={!selectedTab || busyAction !== null}
          onClick={() =>
            void runBrowserWorkspaceAction("open:external", async () => {
              if (!selectedTab) return;
              await openExternalUrl(selectedTab.url);
            })
          }
        >
          <ExternalLink className="size-4" />
        </BrowserNavButton>
      </span>
      {/* Mobile overflow (#29261): the toolbar stays one 44px row, so the
          secondary actions live behind one touch-sized menu instead of a
          second row. */}
      <span className="shrink-0 max-md:inline-flex md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={t("browserworkspace.MoreActions", {
                defaultValue: "More browser actions",
              })}
              data-testid="browser-workspace-mobile-more"
            >
              <EllipsisVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52 md:hidden">
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={busyAction !== null || browserWorkspaceUnavailable}
              onSelect={() =>
                void runBrowserWorkspaceAction("open:new", async () => {
                  await openNewBrowserWorkspaceTab(
                    newBrowserWorkspaceTabSeedUrl,
                    "user",
                  );
                })
              }
            >
              <Plus className="size-4" />
              {newTabLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={!selectedTab || busyAction !== null}
              onSelect={() =>
                void runBrowserWorkspaceAction("reload:selected", async () => {
                  await reloadSelectedBrowserWorkspaceTab();
                })
              }
            >
              <RefreshCw className="size-4" />
              {t("common.refresh", { defaultValue: "Refresh" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={
                busyAction !== null ||
                !workspace.tabs.some(
                  (tab) => !isInternalBrowserWorkspaceTab(tab),
                )
              }
              onSelect={() =>
                void runBrowserWorkspaceAction("close:all", async () => {
                  await closeAllBrowserWorkspaceTabs();
                })
              }
            >
              <X className="size-4" />
              {t("browserworkspace.CloseAllTabs", {
                defaultValue: "Close all tabs",
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={!selectedTab || busyAction !== null}
              onSelect={() =>
                void runBrowserWorkspaceAction("open:external", async () => {
                  if (!selectedTab) return;
                  await openExternalUrl(selectedTab.url);
                })
              }
            >
              <ExternalLink className="size-4" />
              {t("browserworkspace.OpenExternal", {
                defaultValue: "Open external",
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );

  const watchBannerLabel = busyAction
    ? t("browserworkspace.Working", {
        defaultValue: "Working: {{action}}",
        action: busyAction.replace(/[:\-_]+/g, " "),
      })
    : null;

  const browserSurface = (
    <div
      ref={browserSurfaceRef}
      className="relative flex-1 min-h-0 overflow-hidden"
    >
      {watchBannerLabel ? (
        <div
          className="absolute left-3 right-3 top-2 z-20 flex items-center gap-2 rounded-sm bg-card/95 px-3 py-1.5 text-xs text-muted"
          role="status"
          aria-live="polite"
          data-testid="browser-workspace-watch-banner"
        >
          <span
            aria-hidden
            className="inline-block size-1.5 animate-pulse rounded-full bg-accent "
          />
          <span className="truncate">{watchBannerLabel}</span>
        </div>
      ) : null}
      {loadError &&
      !browserWorkspaceUsesLocalTabs &&
      workspace.tabs.length > 0 ? (
        <div
          className="absolute left-4 right-4 top-3 z-20 rounded-xl border border-warning/30 bg-bg/95 px-3 py-2 text-xs text-muted md:left-1/2 md:right-auto md:w-max md:max-w-[min(32rem,calc(100%-2rem))] md:-translate-x-1/2"
          role="alert"
        >
          {loadError.message}
        </div>
      ) : null}

      {browserBridgeSupported && !browserBridgeUnsupportedInNativeLocalMode ? (
        <div
          data-testid="browser-session-policy-dock"
          className="pointer-events-none absolute inset-x-3 bottom-3 z-30 max-h-[min(40%,24rem)] overflow-y-auto"
        >
          <div className="pointer-events-auto mx-auto w-full max-w-xl rounded-sm bg-background/95 shadow-lg">
            <BrowserSessionPolicyPanel api={client} hideWhenEmpty />
          </div>
        </div>
      ) : null}

      {workspace.tabs.length === 0 ? (
        browserWorkspaceUnavailable ? (
          <PagePanel.ContentState
            state="error"
            placement="workspace"
            role="alert"
            tone="warning"
            aria-busy={browserWorkspaceCanRetryLoad && loading}
            icon={<Globe className="size-5" aria-hidden />}
            title={t("browserworkspace.NativeSurfaceUnavailable", {
              defaultValue: "Browser view unavailable",
            })}
            description={loadError.message}
            action={
              browserWorkspaceCanRetryLoad ? (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  disabled={loading || busyAction !== null}
                  onClick={() => void loadWorkspace()}
                >
                  <RefreshCw
                    className={`size-4 ${loading ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              ) : undefined
            }
          />
        ) : loading ? (
          <PagePanel.ContentState
            state="loading"
            placement="workspace"
            aria-busy
            heading={t("browserworkspace.Loading", {
              defaultValue: "Opening Browser",
            })}
          />
        ) : (
          <PagePanel.ContentState
            state="empty"
            placement="workspace"
            icon={<Globe className="size-5" aria-hidden />}
            title={t("browserworkspace.EmptyTitle", {
              defaultValue: "No page open",
            })}
          />
        )
      ) : browserTabRenderPath === "native-child-webview" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const visibilityClass = active
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0";
          return (
            <electrobun-webview
              key={tab.id}
              ref={(el) =>
                registerBrowserWorkspaceElectrobunWebview(
                  tab.id,
                  (el as WebviewTagElement | null) ?? null,
                )
              }
              src={tab.url}
              partition={tab.partition}
              preload={BROWSER_TAB_PRELOAD_SCRIPT}
              renderer="cef"
              masks={BROWSER_WORKSPACE_TAB_MASK_SELECTORS}
              // Start inactive tabs in passthrough so the OOPIF doesn't
              // capture clicks during the gap between mount and the first
              // selection effect. Native hide/show (toggleHidden) is then
              // driven from the selection useEffect.
              passthrough={active ? undefined : ""}
              className={`absolute inset-0 ${visibilityClass}`}
              style={{ display: "block" }}
            />
          );
        })
      ) : browserTabRenderPath === "native-mobile-webview" ? (
        nativeTabSurfaces.error ? (
          <PagePanel.ContentState
            state="error"
            placement="workspace"
            role="alert"
            data-native-surface-error-key={nativeTabSurfaces.error.key}
            data-native-surface-error-message={nativeTabSurfaces.error.message}
            tone="warning"
            className="absolute inset-0 bg-bg"
            title={
              nativeTabSurfaces.error.permanent
                ? t("browserworkspace.NativeSurfaceUnsupported", {
                    defaultValue: "Secure browsing not supported here",
                  })
                : t("browserworkspace.NativeSurfaceUnavailable", {
                    defaultValue: "Browser view unavailable",
                  })
            }
            description={
              nativeTabSurfaces.error.permanent
                ? t("browserworkspace.NativeSurfaceUnsupportedDescription", {
                    defaultValue:
                      "This device can’t keep in-app browsing isolated. Open the page in your browser instead.",
                  })
                : t("browserworkspace.NativeSurfaceUnavailableDescription", {
                    defaultValue:
                      "The secure browser couldn’t connect. Try again without losing your tabs.",
                  })
            }
            action={
              nativeTabSurfaces.error.permanent ? (
                selectedTab ? (
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runBrowserWorkspaceAction(
                        `open:external:${selectedTab.id}`,
                        async () => {
                          await openExternalUrl(selectedTab.url);
                        },
                      )
                    }
                  >
                    <ExternalLink className="size-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                ) : null
              ) : (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  onClick={nativeTabSurfaces.retry}
                >
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              )
            }
          />
        ) : (
          workspace.tabs.map((tab) => {
            const active = tab.id === selectedTabId;
            const visibilityClass = active
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0";
            return (
              // The native WKWebView / Android WebView is layered over this
              // placeholder by `useMobileNativeTabSurfaces`; the div reports
              // the chat-safe content rect. Expanded overlays still use native
              // occlusion holes, while the resting composer owns real layout
              // space so page controls never sit underneath it.
              <div
                key={tab.id}
                ref={(el) =>
                  nativeTabSurfaces.registerSurfaceElement(tab.id, el)
                }
                aria-hidden={!active}
                className={`absolute inset-0 h-full w-full bg-bg transition-opacity ${visibilityClass}`}
                style={{ colorScheme: uiTheme }}
              />
            );
          })
        )
      ) : browserTabRenderPath === "sandboxed-iframe" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const frameBlocked = isBrowserWorkspaceFrameBlockedUrl(tab.url);
          const visibilityClass = active
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0";
          if (frameBlocked) {
            return (
              <PagePanel.ContentState
                key={tab.id}
                state="error"
                placement="workspace"
                tone="warning"
                className={`absolute inset-0 bg-bg transition-opacity ${visibilityClass}`}
                title={t("browserworkspace.FrameBlockedTitle", {
                  defaultValue: "Open this site in your browser",
                })}
                description={t("browserworkspace.FrameBlockedDescription", {
                  defaultValue: "This site doesn’t allow in-app viewing.",
                })}
                action={
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runBrowserWorkspaceAction(
                        `open:external:${tab.id}`,
                        async () => {
                          await openExternalUrl(tab.url);
                        },
                      )
                    }
                  >
                    <ExternalLink className="size-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                }
              />
            );
          }
          return (
            <iframe
              key={tab.id}
              ref={(iframe) => registerBrowserWorkspaceIframe(tab.id, iframe)}
              title={getBrowserWorkspaceTabLabel(tab, t)}
              src={tab.url}
              loading="eager"
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="strict-origin-when-cross-origin"
              // Use bg-bg + colorScheme so the iframe's UA scrollbars and any
              // pre-paint background match the outer app theme instead of
              // flashing white in dark mode. Embedded sites still pick their
              // own theme based on the OS prefers-color-scheme; we can't force
              // that cross-origin without an extension content script.
              className={`absolute inset-0 h-full w-full border-0 bg-bg transition-opacity ${visibilityClass}`}
              style={{
                colorScheme: uiTheme,
                width: `${100 / iframeScale}%`,
                height: `${100 / iframeScale}%`,
                transform: `scale(${iframeScale})`,
                transformOrigin: "top left",
              }}
              onPointerDownCapture={(event) => {
                releaseBrowserWorkspaceIframeFocusReturn(event.currentTarget);
              }}
              onKeyDownCapture={(event) => {
                if (event.key === "Tab") {
                  releaseBrowserWorkspaceIframeFocusReturn(event.currentTarget);
                }
              }}
              onLoad={(event) => {
                beginBrowserWorkspaceIframeFocusSettle(event.currentTarget);
              }}
            />
          );
        })
      ) : (
        <div className="flex h-full flex-1 flex-col bg-bg">
          <div className="flex min-h-11 items-center gap-2 border-b border-border/70 px-4 text-xs text-muted">
            <span className="font-medium text-txt">
              {t("browserworkspace.CloudSession", {
                defaultValue: "Cloud session",
              })}
            </span>
            {selectedTab?.status ? (
              <span className="truncate">{selectedTab.status}</span>
            ) : null}
            {selectedTabLiveViewUrl ? (
              <Button
                variant="surface"
                size="tiny"
                className="ml-auto"
                onClick={() =>
                  void runBrowserWorkspaceAction(
                    "open:live-session",
                    async () => {
                      await openExternalUrl(selectedTabLiveViewUrl);
                    },
                  )
                }
              >
                {t("browserworkspace.OpenLiveSession", {
                  defaultValue: "Open live session",
                })}
              </Button>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
            {snapshotError ? (
              <div
                className="absolute left-4 right-4 top-3 z-20 rounded-xl border border-warning/30 bg-bg/95 px-3 py-2 text-xs text-muted"
                role="alert"
              >
                {snapshotError}
              </div>
            ) : null}

            {selectedTabSnapshot ? (
              <img
                alt={
                  selectedTab
                    ? getBrowserWorkspaceTabLabel(selectedTab, t)
                    : t("browserworkspace.SessionPreview", {
                        defaultValue: "Browser session preview",
                      })
                }
                src={`data:image/png;base64,${selectedTabSnapshot}`}
                width={1280}
                height={720}
                className="h-full w-full object-contain"
              />
            ) : (
              <PagePanel.ContentState
                state="loading"
                placement="workspace"
                heading={t("browserworkspace.SessionPreviewPending", {
                  defaultValue: "Preparing preview",
                })}
              />
            )}
          </div>

          {selectedTab ? (
            <div className="border-t border-border/70 px-4 py-2 text-xs text-muted">
              <div className="truncate font-medium text-txt">
                {getBrowserWorkspaceTabLabel(selectedTab, t)}
              </div>
              <div className="truncate">{selectedTab.url}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  // The fullscreen view owns one flat navigation rail and one content surface.
  // Compact layouts keep a 16px canvas inset and fold secondary actions away;
  // every remaining control still meets the 44px touch floor.
  const showMinimalToolbar =
    workspace.tabs.length === 0 && (loading || browserWorkspaceUnavailable);
  const mainNode = (
    <main
      ref={workspaceRootRef}
      aria-label={t("browserworkspace.ViewTitle", { defaultValue: "Browser" })}
      data-testid="browser-workspace-view"
      data-chat-clearance-aware="true"
      aria-busy={loading || busyAction !== null}
      tabIndex={-1}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-hidden bg-bg px-4 pt-[calc(var(--safe-area-top,0px)+0.75rem)] pb-[calc(1rem+var(--eliza-chat-clearance,5.25rem))] lg:px-6 lg:pt-[calc(var(--safe-area-top,0px)+1.5rem)] lg:pb-[calc(1.5rem+var(--eliza-chat-clearance,5.25rem))]"
    >
      {!showMinimalToolbar && (
        <div
          data-testid="browser-workspace-toolbar"
          className="shrink-0 overflow-hidden rounded-2xl border border-border bg-card"
        >
          {navNode}
        </div>
      )}
      <div
        data-testid="browser-workspace-surface-panel"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card"
      >
        {browserSurface}
      </div>
    </main>
  );

  return (
    <ShellViewAgentSurface
      viewId="browser"
      readPage={nativeMobileTabPath ? readNativePage : undefined}
    >
      {mainNode}
      <BrowserTabSwitcher
        open={switcherOpen}
        onOpenChange={handleTabSwitcherOpenChange}
        folded={foldedTabs}
        activeTabId={selectedTabId}
        title={tabsLabel}
        closeLabel={closeTabLabel}
        agentActiveLabel={agentActiveLabel}
        newTabLabel={newTabLabel}
        emptyLabel={t("browserworkspace.NoTabsYet", {
          defaultValue: "No tabs open yet",
        })}
        returnFocusRef={switcherReturnFocusRef}
        actionsDisabled={busyAction !== null || browserWorkspaceUnavailable}
        onActivateTab={(id) =>
          void runBrowserWorkspaceAction(`show:${id}`, async () => {
            await activateBrowserWorkspaceTab(id);
          })
        }
        onCloseTab={(id) =>
          void runBrowserWorkspaceAction(`close:${id}`, async () => {
            await closeBrowserWorkspaceTabById(id);
          })
        }
        onNewTab={() =>
          void runBrowserWorkspaceAction("open:new", async () => {
            await openNewBrowserWorkspaceTab(
              newBrowserWorkspaceTabSeedUrl,
              "user",
            );
          })
        }
      />
      <ConfirmDialog {...vaultAutofillModalProps} />
      <ConfirmDialog {...walletActionModalProps} />
    </ShellViewAgentSurface>
  );
}
