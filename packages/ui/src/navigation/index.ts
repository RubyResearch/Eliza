/**
 * Navigation — tabs + first-run setup.
 *
 * Re-exported by the `@elizaos/ui` barrel, which server-side plugins import
 * under plain node inside the production Docker image — so this module must
 * not statically import `@capacitor/core` (not shipped in the server image; a
 * static import made `plugin-task-coordinator` unloadable there). Platform
 * detection reads the bridge-injected `globalThis.Capacitor` instead, which is
 * exactly what the npm module's `getPlatform()`/`isNativePlatform()` consult:
 * present on native WebViews, absent on web and node (→ "web", not native).
 */

import type { LucideIcon } from "lucide-react";
import {
  Clock3,
  LayoutGrid,
  Monitor,
  Phone,
  Radio,
  ScrollText,
  Settings,
  UserRound,
  Wallet,
} from "lucide-react";
import {
  appShellPageMatchesPath,
  listAppShellPages,
} from "../app-shell-registry";
import { resolveBuiltinTabIdForPathAlias } from "../builtin-tab-registry";
import { userAgentHasElizaOSMarker } from "../platform/aosp-user-agent";
import { type BuiltinTab, mapBuiltinRoutes } from "./builtin-route-descriptors";
import { resolveDefaultLandingTab } from "./main-tab";

export {
  BUILTIN_ROUTE_DESCRIPTORS,
  BUILTIN_ROUTE_IDS,
  type BuiltinRouteConditionalSurface,
  type BuiltinRouteSurfaceDeclaration,
  type BuiltinTab,
  type CanonicalBuiltinTab,
  type ResolvedBuiltinRouteDescriptor,
  resolveBuiltinRouteDescriptor,
} from "./builtin-route-descriptors";

type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

const viteEnv = (import.meta as RuntimeImportMeta).env;

function viteEnvFlagEnabled(name: string, defaultValue: boolean): boolean {
  const value = viteEnv?.[name];
  if (value == null) return defaultValue;
  return String(value).toLowerCase() !== "false";
}

/** Apps are enabled by default; opt-out via VITE_ENABLE_APPS=false. */
export const APPS_ENABLED = viteEnvFlagEnabled("VITE_ENABLE_APPS", true);

/** Stream routes stay addressable; builds can hide the tab without removing it. */
export const STREAM_ENABLED = viteEnvFlagEnabled("VITE_ENABLE_STREAM", true);

/**
 * Tab identifier — includes all built-in tabs plus arbitrary strings
 * for dynamic plugin-provided nav-page widgets.
 */
export type Tab = BuiltinTab | (string & {});

export const APPS_TOOL_TABS = [
  "plugins",
  "skills",
  "trajectories",
  "transcripts",
  "relationships",
  "memories",
  "files",
  "runtime",
  "database",
  "logs",
] as const satisfies readonly Tab[];

export interface TabGroup {
  label: string;
  tabs: Tab[];
  icon: LucideIcon;
  description?: string;
}

function walletLauncherTabs(): Tab[] {
  const tabs = listAppShellPages()
    .filter((entry) => entry.group === "wallet")
    .sort(
      (a, b) =>
        (a.order ?? 100) - (b.order ?? 100) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    )
    .map((entry) =>
      normalizePath(entry.path).toLowerCase() === "/inventory"
        ? ((entry.tabAffinity ?? "inventory") as Tab)
        : (entry.id as Tab),
    );
  return [...new Set(tabs.length ? tabs : ["inventory"])];
}

export interface AndroidPhoneSurfaceDetection {
  platform?: string;
  isNative?: boolean;
  search?: string;
  hash?: string;
}

function hasAndroidTestFlag(search: string, hash: string): boolean {
  const searchParams = new URLSearchParams(search);
  if (searchParams.get("android") === "true") return true;
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
  if (!hashQuery) return false;
  return new URLSearchParams(hashQuery).get("android") === "true";
}

/** The Capacitor bridge's injected global — the same object the npm module
 *  reads. Present only inside native WebViews; `null` on web and node. */
interface CapacitorBridgeGlobal {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

function capacitorBridge(): CapacitorBridgeGlobal | null {
  const bridge = (globalThis as { Capacitor?: CapacitorBridgeGlobal })
    .Capacitor;
  return bridge ?? null;
}

export function isAndroidPhoneSurfaceEnabled(
  detection: AndroidPhoneSurfaceDetection = {},
): boolean {
  const search =
    detection.search ??
    (typeof window === "undefined" ? "" : window.location.search);
  const hash =
    detection.hash ??
    (typeof window === "undefined" ? "" : window.location.hash);
  if (hasAndroidTestFlag(search, hash)) return true;

  const platform =
    detection.platform ?? capacitorBridge()?.getPlatform?.() ?? "web";
  const isNative =
    detection.isNative ?? capacitorBridge()?.isNativePlatform?.() ?? false;
  return isNative && platform === "android";
}

/**
 * True only on the **AOSP ElizaOS fork** (the system image whose WebView
 * user-agent carries the `ElizaOS/<tag>` marker), or under an explicit
 * `?android=true` dev-preview flag. This is the gate for the native-OS home
 * tiles (phone, messages, contacts, camera): they are an AOSP-fork surface, so
 * they stay hidden on web, desktop, iOS, and stock Play-Store Android.
 *
 * Distinct from `isAndroidPhoneSurfaceEnabled` (any Android-native build): the
 * native-OS overlay plugins only register on the fork (`isElizaOS()`), so the
 * tiles must match that, not merely "is Android".
 */
export function isAospShellEnabled(
  detection: AndroidPhoneSurfaceDetection = {},
): boolean {
  const search =
    detection.search ??
    (typeof window === "undefined" ? "" : window.location.search);
  const hash =
    detection.hash ??
    (typeof window === "undefined" ? "" : window.location.hash);
  if (hasAndroidTestFlag(search, hash)) return true;
  return (
    typeof navigator !== "undefined" &&
    userAgentHasElizaOSMarker(navigator.userAgent ?? "")
  );
}

/**
 * The AOSP-ElizaOS-fork-only native device-OS surfaces (dialer, SMS, contacts,
 * camera). They are gated to the fork via {@link isAospShellEnabled} everywhere
 * they appear, so this is the single source of truth those gates read instead of
 * each redeclaring the id set (which let the router filter and the launcher
 * curation drift). Consumers:
 *  - `useAvailableViews` strips these from the routable view set + view manager
 *    on every non-fork build.
 *  - `launcher-curation` appends {@link LAUNCHER_AOSP_ONLY_VIEW_IDS} to the
 *    launcher only on the fork.
 *  - `App.tsx` route gates (`renderPhoneSurface`) mount their pages only on the
 *    fork.
 */
export const NATIVE_OS_VIEW_IDS = [
  "phone",
  "messages",
  "contacts",
  "camera",
] as const;

/**
 * Native-OS launcher tiles: the routable native-OS surfaces plus Files — a
 * cross-platform view (`/apps/files`) that stays routable everywhere but is only
 * surfaced as a launcher tile on the fork.
 */
export const LAUNCHER_AOSP_ONLY_VIEW_IDS = [
  ...NATIVE_OS_VIEW_IDS,
  "files",
] as const;

interface WindowNavigationLocation {
  protocol: string;
  search: string;
  hash: string;
  pathname: string;
}

function getWindowNavigationLocation(): WindowNavigationLocation | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

export function isAppWindowRoute(
  location:
    | Pick<WindowNavigationLocation, "search">
    | undefined = getWindowNavigationLocation(),
): boolean {
  if (!location) return false;
  try {
    return new URLSearchParams(location.search).get("appWindow") === "1";
  } catch {
    // error-policy:J3 unparseable location.search — treat as the main window
    return false;
  }
}

export function shouldUseHashNavigation(
  location:
    | Pick<WindowNavigationLocation, "protocol" | "search">
    | undefined = getWindowNavigationLocation(),
): boolean {
  if (!location) return false;
  return location.protocol === "file:" || isAppWindowRoute(location);
}

export function getWindowNavigationPath(
  location:
    | WindowNavigationLocation
    | undefined = getWindowNavigationLocation(),
): string {
  if (!location) return "/";
  return shouldUseHashNavigation(location)
    ? location.hash.replace(/^#/, "") || "/"
    : location.pathname;
}

export const ALL_TAB_GROUPS: TabGroup[] = [
  {
    // AOSP ElizaOS-fork only — the native dialer/SMS/contact tiles are gated to
    // the fork in the launcher (see launcher-curation LAUNCHER_AOSP_ONLY_IDS).
    label: "Phone",
    tabs: ["phone", "messages", "contacts"],
    icon: Phone,
    description: "ElizaOS dialer, SMS, and contact book",
  },
  {
    label: "Launcher",
    tabs: ["views", ...APPS_TOOL_TABS],
    icon: LayoutGrid,
    description: "The Launcher — agent views, integrations, and app tools",
  },
  {
    // The character hub is split into top-level views (#character-split): the
    // Character editor (identity/style/examples), Knowledge (documents),
    // Relationships, Skills (learned), and Experience each get their own tile.
    label: "Character",
    tabs: [
      "character",
      "character-select",
      "documents",
      "experience",
      "character-skills",
    ],
    icon: UserRound,
    description: "Avatar identity, style, examples, and knowledge",
  },
  {
    label: "Wallet",
    get tabs() {
      return walletLauncherTabs();
    },
    icon: Wallet,
    description:
      "Crypto wallets, token balances, perps, and prediction markets",
  },
  {
    label: "Browser",
    tabs: ["browser"],
    icon: Monitor,
    description: "Agent-controlled browser workspace",
  },
  {
    label: "Stream",
    tabs: ["stream"],
    icon: Radio,
    description: "Live streaming controls",
  },
  {
    label: "Pendant",
    tabs: ["pendant-transcript"],
    icon: ScrollText,
    description: "Realtime transcript from the omi pendant",
  },
  {
    // One consolidated surface — workflows, triggers, and scheduled items share
    // the Automations feed. `triggers`/`tasks` stay routable aliases (TAB_PATHS).
    label: "Automations",
    tabs: ["automations"],
    icon: Clock3,
    description: "Workflows, triggers, and scheduled items",
  },
  {
    label: "Settings",
    tabs: ["settings"],
    icon: Settings,
    description: "Configuration and preferences",
  },
];

// Canonical settings-section metadata (pure data) re-exported here so
// non-renderer consumers (e.g. app-core's dev-route-catalog parity test) can
// assert the QA catalog never drifts from the UI's section list.
export {
  SETTINGS_SECTION_META,
  type SettingsSectionMeta,
} from "../components/settings/settings-section-meta";

/** Canonical paths derived from the built-in route descriptors. */
export const TAB_PATHS = mapBuiltinRoutes((descriptor) => descriptor.path);

const PATH_TO_TAB = new Map(
  Object.values(
    mapBuiltinRoutes(
      (descriptor) => [descriptor.path, descriptor.canonicalId] as const,
    ),
  ),
);

function normalizePathForLookup(pathname: string, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  let p = pathname || "/";
  const queryIndex = p.indexOf("?");
  if (queryIndex >= 0) p = p.slice(0, queryIndex);
  const hashIndex = p.indexOf("#");
  if (hashIndex >= 0) p = p.slice(0, hashIndex);
  if (base) {
    if (p === base) p = "/";
    else if (p.startsWith(`${base}/`)) p = p.slice(base.length);
  }
  let normalized = normalizePath(p).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const p = TAB_PATHS[tab as BuiltinTab] ?? `/${tab}`;
  return base ? `${base}${p}` : p;
}

export interface LegacyBuiltinRouteResolution {
  tab: Tab;
  canonicalPath: string;
}

/**
 * Resolve a retired builtin route through the builtin metadata registry. The
 * canonical destination is always derived from `TAB_PATHS`, so aliases cannot
 * drift into a second renderer or platform-specific routing table.
 */
export function resolveLegacyBuiltinRoute(
  pathname: string,
  basePath = "",
): LegacyBuiltinRouteResolution | null {
  const normalized = normalizePathForLookup(pathname, basePath);
  const tab = resolveBuiltinTabIdForPathAlias(normalized) as Tab | null;
  return tab ? { tab, canonicalPath: pathForTab(tab, basePath) } : null;
}

export function isRouteRootPath(pathname: string, basePath = ""): boolean {
  return normalizePathForLookup(pathname, basePath) === "/";
}

export function resolveInitialTabForPath(
  pathname: string,
  fallbackTab: Tab,
  basePath = "",
): Tab {
  if (isRouteRootPath(pathname, basePath)) {
    return fallbackTab;
  }
  return tabFromPath(pathname, basePath) ?? fallbackTab;
}

/**
 * Legacy host-owned prefix aliases: `/<prefix>/<sub>` paths whose target tab is
 * NOT derivable from `TAB_PATHS` because the tab's canonical path lives under a
 * different prefix. Everything else under `/apps/*` and `/character/*` resolves
 * from the `TAB_PATHS`-derived {@link PATH_TO_TAB} registry (see
 * {@link prefixSubTabFromPath}); only these two irreducible aliases remain, and
 * the `no-derivable-alias` drift guard in `index.test.ts` proves that any alias
 * whose full path IS already in `TAB_PATHS` was dropped from this table.
 *
 * - `/apps/inventory` → inventory: an internal-tool window target. The window
 *   path is `/apps/<slug>` so it stays consistent with other internal tools,
 *   but the renderer mounts the wallet tab the original `targetTab` pointed at
 *   (canonical `TAB_PATHS.inventory` = `/wallet`).
 * - `/character/relationships` → relationships: a character-hub deep-link alias.
 *   Relationships lives at canonical `TAB_PATHS.relationships` = `/apps/relationships`,
 *   but the promoted character sections keep a `/character/*` alias for old deep
 *   links.
 */
export const LEGACY_PREFIX_TAB_ALIASES: Record<string, Tab> = {
  "/apps/inventory": "inventory",
  "/character/relationships": "relationships",
};

/**
 * Resolve a `/<prefix>/<sub>` path to its tab from the canonical `TAB_PATHS`
 * registry (via {@link PATH_TO_TAB}), falling back to the explicitly-marked
 * {@link LEGACY_PREFIX_TAB_ALIASES} for the handful of paths whose target tab
 * declares a different canonical path. Returns `null` when neither owns it, so
 * callers apply their own default (app slug for `/apps/*`, `character` for
 * `/character/*`). This replaces the hand-maintained sub-path record and the
 * inline `/character/<sub>` if-chain, both of which duplicated — and could drift
 * from — the paths already declared in `TAB_PATHS`.
 */
function prefixSubTabFromPath(normalizedPath: string): Tab | null {
  return (
    PATH_TO_TAB.get(normalizedPath) ??
    LEGACY_PREFIX_TAB_ALIASES[normalizedPath] ??
    null
  );
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const normalized = normalizePathForLookup(pathname, basePath);
  // The root path "/" lands on the discovered main-tab app. Reads the
  // cached apps catalog synchronously and falls back to the assistant home
  // (clouds/avatar surface) when no app declares elizaos.app.mainTab=true.
  if (normalized === "/") return resolveDefaultLandingTab();

  // Apps disabled in production builds — redirect to chat
  if (
    !APPS_ENABLED &&
    (normalized === "/apps" ||
      normalized === "/views" ||
      normalized.startsWith("/apps/") ||
      normalized.startsWith("/views/") ||
      normalized === "/game")
  ) {
    return "chat";
  }

  // Historical /tutorial links land in chat because the tutorial is a
  // chat-native flow launched from the home card, not a routable page.
  if (normalized === "/tutorial") {
    return "chat";
  }

  const legacyBuiltinRoute = resolveLegacyBuiltinRoute(pathname, basePath);
  if (legacyBuiltinRoute) return legacyBuiltinRoute.tab;

  // /views — legacy launcher alias; renders the combined Home/Launcher.
  if (normalized === "/views" || normalized.startsWith("/views/")) {
    return "views";
  }

  // Retired My Apps routes (#17031): bare /apps (the old My Apps canonical
  // path) and the /apps/my-apps app-window slug both resolve to the
  // consolidated Projects surface, which pre-selects its Apps segment from
  // these paths (initialProjectsSegmentForPath in TasksPageView). The launcher
  // grid itself stays at /views.
  if (normalized === "/apps" || normalized === "/apps/my-apps") {
    return "tasks";
  }

  // /character/<sub> — resolve nested character paths. The character hub's
  // sections are now top-level views, but their routes keep the /character/*
  // prefix so existing deep links resolve to the promoted tab. Resolution reads
  // the canonical TAB_PATHS registry (via prefixSubTabFromPath) instead of a
  // hardcoded sub if-chain; anything the registry does not own defaults to the
  // character hub.
  if (normalized.startsWith("/character/")) {
    return prefixSubTabFromPath(normalized) ?? "character";
  }

  const registeredAppShellPage = listAppShellPages().find((entry) =>
    appShellPageMatchesPath(entry, normalized),
  );
  if (registeredAppShellPage) {
    return registeredAppShellPage.tabAffinity ?? registeredAppShellPage.id;
  }

  // /apps/<sub> — known tool tabs resolve to their tab from the TAB_PATHS
  // registry (via prefixSubTabFromPath); a nested sub-path is a plugin view,
  // and everything else is an app slug.
  if (normalized.startsWith("/apps/")) {
    const sub = normalized.slice("/apps/".length);
    if (sub.includes("/")) return "views";
    return prefixSubTabFromPath(normalized) ?? "apps";
  }

  // /settings/<sub> — resolve nested settings paths
  // /settings/<sub> (including /settings/voice) — the Settings view selects the
  // matching section from the URL hash; the route always resolves to the
  // Settings tab.
  if (normalized.startsWith("/settings/")) {
    return "settings";
  }

  // Legacy /connectors and /connectors/<id> — Settings → Connectors (index or
  // detail). The hash `#connectors` / `#connectors/<id>` is written by the
  // shell when these paths are opened so ConnectorsSection can deep-link.
  if (normalized === "/connectors" || normalized.startsWith("/connectors/")) {
    return "settings";
  }

  // Check current paths first, then route unknown top-level paths through the
  // view registry. Plugin views can declare routes that are not built-in tabs;
  // the Views tab can then match the exact registry path and mount the remote
  // bundle.
  const knownTab = PATH_TO_TAB.get(normalized);
  if (knownTab) return knownTab;
  if (APPS_ENABLED && normalized.startsWith("/") && normalized !== "/") {
    return "views";
  }
  return null;
}

function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function normalizePath(p: string): string {
  if (!p) return "/";
  let normalized = p.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * Extract an app slug from a `/apps/<slug>` path.
 * Returns `null` when the path doesn't contain a slug segment.
 */
export function getAppSlugFromPath(
  pathname: string,
  basePath = "",
): string | null {
  const normalized = normalizePathForLookup(pathname, basePath);
  if (!normalized.startsWith("/apps/")) return null;
  const slug = normalized.slice("/apps/".length);
  return slug || null;
}

export function titleForTab(tab: Tab): string {
  switch (tab) {
    case "chat":
      return "Messages";
    case "phone":
      return "Phone";
    case "messages":
      return "Messages";
    case "contacts":
      return "Contacts";
    case "camera":
      return "Camera";
    case "tasks":
      // The coding-task orchestrator surface presents as "Projects"; the tab
      // id and /apps/tasks route stay stable for navigation + telemetry.
      return "Projects";
    case "browser":
      return "Browser";
    case "apps":
      return "Launcher";
    case "views":
      return "Launcher";
    case "character":
      return "Character";
    case "character-select":
      return "Character Select";
    case "automations":
      return "Automations";
    case "triggers":
      return "Automations";
    case "inventory":
      return "Wallet";
    case "documents":
      return "Knowledge";
    case "plugins":
      return "Plugins";
    case "skills":
      return "Skills";
    case "trajectories":
      return "Trajectories";
    case "transcripts":
      return "Transcripts";
    case "relationships":
      return "Relationships";
    case "experience":
      return "Experience";
    case "character-skills":
      return "Skills";
    case "memories":
      return "Memories";
    case "files":
      return "Files";
    case "rolodex":
      return "Rolodex";
    case "runtime":
      return "Runtime";
    case "database":
      return "Databases";
    case "settings":
      return "Settings";
    case "vault":
      return "Vault";
    case "logs":
      return "Logs";
    case "background":
      return "Background";
    case "stream":
      return "Stream";
    case "pendant-transcript":
      return "Pendant Transcript";
    default:
      // Dynamic plugin tabs — capitalize the tab ID as a fallback title.
      return tab.charAt(0).toUpperCase() + tab.slice(1).replace(/-/g, " ");
  }
}

export {
  getMainTabApp,
  MAIN_TAB_FALLBACK,
  type MainTabApp,
  resolveDefaultLandingTab,
} from "./main-tab";
