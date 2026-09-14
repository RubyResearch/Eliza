/**
 * Dev route catalog for the QA crawler.
 *
 * **Why this module:** the QA crawler needs a single source of truth for every UI surface
 * (tab paths, settings sub-sections, modal triggers, feature-flag gates). Without it, the
 * crawler maintains its own hardcoded list and drifts the moment a tab is renamed or a
 * settings section is added.
 *
 * The canonical tab map lives in `@elizaos/ui` (`packages/ui/src/navigation/index.ts` —
 * `TAB_PATHS`). Importing the UI package from app-core would create a renderer dependency
 * for an HTTP handler, so this module mirrors the small flat list of route entries as a
 * local constant. The companion vitest at `dev-route-catalog.test.ts` imports the real
 * `TAB_PATHS` and asserts every key is represented here — so drift is caught at test time,
 * not in production.
 *
 * Loopback-only by convention (mounted alongside `/api/dev/stack` in `dev-compat-routes.ts`).
 */

export const ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION = 1 as const;

/**
 * Where a route is reachable. `all` is the desktop + web default; the gated values match
 * the existing feature-flag / platform-gate logic in `packages/ui/src/navigation/index.ts`
 * and `App.tsx`.
 */
export type DevRouteVisibility = "all" | "android" | "desktop" | "dev-mode";

export type DevRoutePlatformGate = "ios" | "android" | "desktop" | "web" | null;

export interface DevRouteEntry {
  /** Built-in tab id from `@elizaos/ui` (`BuiltinTab`). */
  tabId: string;
  /** Pathname the tab resolves to. */
  path: string;
  /** Human-readable label (matches `titleForTab`). */
  label: string;
  /** Which `ALL_TAB_GROUPS` group hosts the tab (or "Hidden" for addressable-but-ungrouped). */
  group: string;
  visibility: DevRouteVisibility;
  /** Vite env var that gates the route, when one exists. */
  featureFlag: string | null;
  requiresAuth: boolean;
  platformGate: DevRoutePlatformGate;
}
export interface DevRouteSettingsSection {
  id: string;
  label: string;
}

export interface DevRouteModal {
  id: string;
  /** Shortest accurate description of what triggers the modal. */
  trigger: string;
}

export interface DevRouteCatalogPayload {
  schemaVersion: typeof ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  routes: DevRouteEntry[];
  settingsSections: DevRouteSettingsSection[];
  modals: DevRouteModal[];
}

/**
 * Mirror of `TAB_PATHS` from `packages/ui/src/navigation/index.ts` plus per-tab metadata.
 * The vitest asserts every `TAB_PATHS` key is present here.
 */
const ROUTES: DevRouteEntry[] = [
  {
    tabId: "onboarding",
    path: "/onboarding",
    label: "Onboarding",
    group: "Hidden",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    // Chat is the app home surface, reached directly (default landing), not via
    // a launcher tile — there is no "Messages" launcher group.
    tabId: "chat",
    path: "/chat",
    label: "Messages",
    group: "Hidden",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    // /connectors redirects into Settings → Connectors.
    tabId: "connectors",
    path: "/connectors",
    label: "Connectors",
    group: "Settings",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "phone",
    path: "/phone",
    label: "Phone",
    group: "Phone",
    visibility: "android",
    featureFlag: null,
    requiresAuth: true,
    platformGate: "android",
  },
  {
    tabId: "messages",
    path: "/messages",
    label: "Messages",
    group: "Phone",
    visibility: "android",
    featureFlag: null,
    requiresAuth: true,
    platformGate: "android",
  },
  {
    tabId: "contacts",
    path: "/contacts",
    label: "Contacts",
    group: "Phone",
    visibility: "android",
    featureFlag: null,
    requiresAuth: true,
    platformGate: "android",
  },
  {
    tabId: "camera",
    path: "/camera",
    label: "Camera",
    group: "Phone",
    visibility: "android",
    featureFlag: null,
    requiresAuth: true,
    platformGate: "android",
  },
  {
    tabId: "apps",
    path: "/apps",
    label: "Apps",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "views",
    path: "/views",
    label: "Views",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "plugins",
    path: "/apps/plugins",
    label: "Plugins",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "skills",
    path: "/apps/skills",
    label: "Skills",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "trajectories",
    path: "/apps/trajectories",
    label: "Trajectories",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "relationships",
    path: "/apps/relationships",
    label: "Relationships",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "transcripts",
    path: "/apps/transcripts",
    label: "Transcripts",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "memories",
    path: "/apps/memories",
    label: "Memories",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "runtime",
    path: "/apps/runtime",
    label: "Runtime",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "database",
    path: "/apps/database",
    label: "Databases",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "files",
    path: "/apps/files",
    label: "Files",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "logs",
    path: "/apps/logs",
    label: "Logs",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "tasks",
    path: "/apps/tasks",
    label: "Projects",
    group: "Apps",
    visibility: "all",
    featureFlag: "VITE_ENABLE_APPS",
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "character",
    path: "/character",
    label: "Character",
    group: "Character",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "character-select",
    path: "/character/select",
    label: "Character Select",
    group: "Character",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "documents",
    path: "/character/documents",
    label: "Knowledge",
    group: "Character",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "character-skills",
    path: "/character/skills",
    label: "Skills",
    group: "Character",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "experience",
    path: "/character/experience",
    label: "Experience",
    group: "Character",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "inventory",
    path: "/wallet",
    label: "Wallet",
    group: "Wallet",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "browser",
    path: "/browser",
    label: "Browser",
    group: "Browser",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "stream",
    path: "/stream",
    label: "Stream",
    group: "Stream",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "pendant-transcript",
    path: "/pendant/transcript",
    label: "Pendant Transcript",
    group: "Pendant",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "automations",
    path: "/automations",
    label: "Automations",
    group: "Automations",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "triggers",
    path: "/automations",
    label: "Automations",
    group: "Automations",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "settings",
    path: "/settings",
    label: "Settings",
    group: "Settings",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    // Owner-only vault workspace — reachable directly at /vault; not
    // in any ALL_TAB_GROUPS launcher group, like rolodex/desktop/background.
    tabId: "vault",
    path: "/vault",
    label: "Vault",
    group: "Hidden",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "rolodex",
    path: "/apps/relationships",
    label: "Rolodex",
    group: "Hidden",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
  {
    tabId: "desktop",
    path: "/desktop",
    label: "Desktop",
    group: "Hidden",
    visibility: "desktop",
    featureFlag: null,
    requiresAuth: true,
    platformGate: "desktop",
  },
  {
    tabId: "background",
    path: "/background",
    label: "Background",
    group: "Hidden",
    visibility: "all",
    featureFlag: null,
    requiresAuth: true,
    platformGate: null,
  },
];

/**
 * Mirror of `SETTINGS_SECTION_META` from
 * `@elizaos/ui` (`packages/ui/src/components/settings/settings-section-meta.ts`).
 * Importing the UI package into this HTTP-handler module would drag the renderer
 * graph into the API process, so the list is mirrored here; `dev-route-catalog.test.ts`
 * imports the real `SETTINGS_SECTION_META` and asserts id+label parity, catching
 * drift at test time. Labels are the English `defaultLabel`, not the i18n key.
 */
const SETTINGS_SECTIONS: DevRouteSettingsSection[] = [
  { id: "identity", label: "Basics" },
  { id: "ai-model", label: "Models & Providers" },
  { id: "voice", label: "Voice" },
  { id: "capabilities", label: "Capabilities" },
  { id: "apps", label: "Apps" },
  { id: "connectors", label: "Connectors" },
  { id: "appearance", label: "General" },
  { id: "background", label: "Background" },
  { id: "notifications", label: "Notifications" },
  { id: "runtime", label: "Runtime" },
  { id: "wallet-rpc", label: "Wallet & RPC" },
  { id: "updates", label: "Updates" },
  { id: "advanced", label: "Backups" },
  { id: "secrets", label: "Vault" },
  { id: "permissions", label: "Permissions" },
  { id: "app-permissions", label: "App Permissions" },
  { id: "security", label: "Security" },
];

/**
 * Root-level overlays/modals rendered by `ShellOverlays` and connector setup panels.
 * Triggers are descriptive — concrete user paths to reach the modal.
 */
const MODALS: DevRouteModal[] = [
  {
    id: "command-palette",
    trigger: "Cmd/Ctrl+K, or the search button in the header.",
  },
  {
    id: "bug-report",
    trigger: "Help menu in header > Report a bug.",
  },
  {
    id: "computer-use-approval",
    trigger:
      "Agent attempts a computer-use action that requires explicit user approval.",
  },
  {
    id: "shortcuts-overlay",
    trigger: "Press '?' or open Help > Keyboard shortcuts.",
  },
  {
    id: "restart-banner",
    trigger:
      "Pending runtime restart reason (config change, plugin install, mode switch).",
  },
  {
    id: "connection-lost-overlay",
    trigger:
      "API health check has been failing for more than the grace window.",
  },
  {
    id: "whatsapp-qr",
    trigger:
      "Settings > Connectors > WhatsApp > Link device (renders the QR pairing overlay).",
  },
];

export function buildRouteCatalog(
  now: Date = new Date(),
): DevRouteCatalogPayload {
  return {
    schemaVersion: ELIZA_DEV_ROUTE_CATALOG_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    routes: ROUTES.map((r) => ({ ...r })),
    settingsSections: SETTINGS_SECTIONS.map((s) => ({ ...s })),
    modals: MODALS.map((m) => ({ ...m })),
  };
}
