/**
 * Playwright UI-smoke spec for the All Pages Clicksafe app flow using the real
 * renderer fixture.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  DIRECT_ROUTE_CASES,
  escapeRegExp,
  SAFE_VIEW_TILE_CASES,
} from "./apps-session-route-cases";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { clickViewBackControl } from "./helpers/view-header";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteProbe = {
  name: string;
  path: string;
  expectedUrl?: RegExp;
  readyChecks: readonly ReadyCheck[];
  mode?: "any" | "all";
  timeoutMs?: number;
};

type ViewportProbe = {
  name: string;
  size: { width: number; height: number };
  routes: readonly RouteProbe[];
};

type PermissionId =
  | "screen-recording"
  | "accessibility"
  | "reminders"
  | "calendar"
  | "health"
  | "screentime"
  | "contacts"
  | "notes"
  | "microphone"
  | "camera"
  | "location"
  | "shell"
  | "website-blocking"
  | "notifications"
  | "full-disk"
  | "automation"
  | "speech-recognition"
  | "photos"
  | "phone"
  | "messages"
  | "wifi"
  | "bluetooth"
  | "app-blocking"
  | "usage-access"
  | "overlay"
  | "write-settings"
  | "local-network"
  | "battery-optimization";

type PermissionStateFixture = {
  id: PermissionId;
  status: "not-applicable";
  lastChecked: number;
  canRequest: boolean;
  platform: "linux";
};

type AllPermissionsStateFixture = Record<PermissionId, PermissionStateFixture>;

const PERMISSION_IDS: readonly PermissionId[] = [
  "screen-recording",
  "accessibility",
  "reminders",
  "calendar",
  "health",
  "screentime",
  "contacts",
  "notes",
  "microphone",
  "camera",
  "location",
  "shell",
  "website-blocking",
  "notifications",
  "full-disk",
  "automation",
  "speech-recognition",
  "photos",
  "phone",
  "messages",
  "wifi",
  "bluetooth",
  "app-blocking",
  "usage-access",
  "overlay",
  "write-settings",
  "local-network",
  "battery-optimization",
];

const CORE_ROUTE_PROBES: readonly RouteProbe[] = [
  {
    // /onboarding is the First Run screen; when an agent is already configured
    // the shell redirects away — just verify the navigation does not crash.
    name: "onboarding (first run)",
    path: "/onboarding",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 30_000,
  },
  {
    name: "assistant home",
    path: "/",
    expectedUrl: /\/(?:chat)?$/,
    readyChecks: [
      {
        selector:
          '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      },
    ],
    timeoutMs: 60_000,
  },
  {
    name: "chat",
    path: "/chat",
    readyChecks: [
      {
        selector:
          '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      },
    ],
    mode: "all",
  },
  {
    name: "connectors",
    path: "/connectors",
    // The legacy top-level URL enters the Settings connectors subview. Boot
    // timing may preserve the alias or add its canonical settings hash.
    expectedUrl: /\/connectors(?:#connectors)?$/,
    readyChecks: [{ selector: "#root" }],
  },
  {
    name: "my apps",
    path: "/apps",
    // Retired My Apps deep link (#17031): lands on the consolidated Projects
    // surface with the Apps segment pre-selected. The launcher grid remains
    // available at `/views`.
    readyChecks: [{ text: "No apps installed yet" }],
    timeoutMs: 60_000,
  },
  {
    name: "automations",
    path: "/automations",
    readyChecks: [{ selector: '[data-testid="automations-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "browser",
    path: "/browser",
    readyChecks: [
      { selector: '[data-testid="browser-workspace-address-input"]' },
      { selector: '[data-testid="browser-workspace-open-home"]' },
    ],
    timeoutMs: 60_000,
  },
  {
    name: "character",
    path: "/character",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "character select",
    path: "/character/select",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "wallet",
    path: "/wallet",
    readyChecks: [{ selector: '[data-testid="wallet-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "stream",
    path: "/stream",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
  {
    name: "rolodex",
    path: "/rolodex",
    // Rolodex is a legacy path of Relationships (`rolodex: { aliasOf:
    // "relationships" }` in builtin-route-descriptors.ts): the retained deep
    // link must land on the canonical Relationships route, not on an
    // unavailable state or a healthy launcher.
    expectedUrl: /\/apps\/relationships$/,
    readyChecks: [{ selector: "main, [role='main']" }],
    timeoutMs: 60_000,
  },
  {
    name: "settings",
    path: "/settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    timeoutMs: 60_000,
  },
  // Phone / Messages / Contacts are `androidOnly: true` overlay apps. Their
  // side-effect registrations only fire when `isElizaOS()` is true (an AOSP
  // Eliza/ElizaOS Android build) — see
  // plugins/plugin-{phone,messages,contacts}/src/register.ts and
  // overlay-app-registry.getAvailableOverlayApps, which deliberately filters
  // androidOnly apps out on desktop/iOS/web so users never see OS-control tiles
  // that launch into permanent error states. In THIS desktop / mobile-web sweep
  // they intentionally do NOT register, so deep-linking their tab paths must
  // render the app shell *gracefully* — #root + main present, no crash, no
  // console/page errors, no raw "not found" (all enforced by expectMainShell +
  // expectNoPageIssues around this probe) — rather than the Android dialer / SMS
  // / contacts UI. The full dialer / SMS / contacts interaction coverage lives
  // in apps-comms-device-interactions.spec.ts, which forces an Android/ElizaOS
  // platform (Capacitor + UA marker) and drives /apps/{phone,messages,contacts}.
  {
    name: "phone deep link",
    path: "/phone",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
  {
    name: "messages deep link",
    path: "/messages",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
  {
    name: "contacts deep link",
    path: "/contacts",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
  {
    name: "views catalog deep link",
    path: "/views",
    // /views renders the launcher grid — anchor on its testid (the old text
    // probes predate the surface and never match).
    readyChecks: [{ selector: '[data-testid="launcher"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "background view deep link",
    path: "/background",
    readyChecks: [{ selector: "#root" }, { text: "Background" }],
    timeoutMs: 60_000,
  },
  {
    name: "character documents deep link",
    path: "/character/documents",
    readyChecks: [{ selector: '[data-testid="documents-view"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "character skills deep link",
    path: "/character/skills",
    readyChecks: [
      { selector: '[data-testid="section-nav-character"]' },
      {
        selector: '[data-testid="section-nav-character"] [aria-current="page"]',
      },
    ],
    mode: "all",
    timeoutMs: 60_000,
  },
  {
    name: "character experience deep link",
    path: "/character/experience",
    readyChecks: [
      { selector: '[data-testid="section-nav-character"]' },
      {
        selector: '[data-testid="section-nav-character"] [aria-current="page"]',
      },
    ],
    mode: "all",
    timeoutMs: 60_000,
  },
  {
    // installDesktopPermissionsBridge injects __ELIZA_ELECTROBUN_RPC__, so
    // isElectrobunRuntime() is true here and /desktop renders the full desktop
    // workspace branch (not the "tools only available" fallback). Assert on the
    // always-rendered controls of that branch, which mount before any desktop
    // RPC resolves, rather than the RPC-gated "Paths" list.
    name: "desktop workspace deep link",
    path: "/desktop",
    readyChecks: [
      { text: "Refresh Diagnostics" },
      { text: "Desktop Dev Stack" },
    ],
    timeoutMs: 60_000,
  },
  {
    name: "settings voice path",
    path: "/settings/voice",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    // /camera is an `androidOnly` overlay app (platformGate "android"); like the
    // phone/messages/contacts deep links above it does not register on this
    // desktop / mobile-web sweep, so deep-linking it must render the app shell
    // gracefully (#root present, no crash) rather than the Android camera UI.
    name: "camera deep link",
    path: "/camera",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
  {
    // /pendant/transcript renders the realtime pendant transcription view
    // (#15806). Without a paired pendant the view shows its designed
    // disconnected state; like the device deep links above, the sweep proves
    // the shell renders it without crashing.
    name: "pendant transcript deep link",
    path: "/pendant/transcript",
    readyChecks: [{ selector: "#root" }],
    timeoutMs: 60_000,
  },
];

function coreRouteProbe(name: string): RouteProbe {
  const route = CORE_ROUTE_PROBES.find((probe) => probe.name === name);
  if (!route) {
    throw new Error(`Missing core route probe: ${name}`);
  }
  return route;
}

const APP_TOOL_ROUTE_PROBES: readonly RouteProbe[] = DIRECT_ROUTE_CASES.map(
  (routeCase) => ({
    name: `app tool ${routeCase.name}`,
    path: routeCase.path,
    expectedUrl: routeCase.expectedUrl,
    readyChecks:
      "readyChecks" in routeCase
        ? routeCase.readyChecks
        : [{ selector: routeCase.selector }],
    timeoutMs: "timeoutMs" in routeCase ? routeCase.timeoutMs : 60_000,
  }),
);

const DESKTOP_PROBE: ViewportProbe = {
  name: "desktop",
  size: { width: 1440, height: 1000 },
  routes: [...CORE_ROUTE_PROBES, ...APP_TOOL_ROUTE_PROBES],
};

const MOBILE_CHAT_ROUTE_PROBE: RouteProbe = {
  ...coreRouteProbe("chat"),
  readyChecks: [
    {
      selector:
        '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
    },
  ],
  mode: "all",
};

const MOBILE_PROBE: ViewportProbe = {
  name: "mobile",
  size: { width: 390, height: 844 },
  routes: [
    coreRouteProbe("assistant home"),
    MOBILE_CHAT_ROUTE_PROBE,
    ...CORE_ROUTE_PROBES.slice(3),
    ...APP_TOOL_ROUTE_PROBES,
  ],
};

const SAFE_VIEW_TILES: readonly {
  testId: string;
  name: string;
  expectedPath: RegExp;
}[] = SAFE_VIEW_TILE_CASES.map((tileCase) => ({
  testId: tileCase.testId,
  name: tileCase.name,
  expectedPath: new RegExp(`${escapeRegExp(tileCase.expectedPath)}$`),
}));

const SETTING_SECTIONS_TO_CLICK: readonly {
  label: RegExp;
  expectedHash: string;
}[] = [
  { label: /^Basics$/, expectedHash: "identity" },
  { label: /^Models & Providers$/, expectedHash: "ai-model" },
  { label: /^Voice$/, expectedHash: "voice" },
  { label: /^Capabilities$/, expectedHash: "capabilities" },
  { label: /^Apps$/, expectedHash: "apps" },
  { label: /^Connectors$/, expectedHash: "connectors" },
  { label: /^Runtime$/, expectedHash: "runtime" },
  { label: /^General$/, expectedHash: "appearance" },
  { label: /^Background$/, expectedHash: "background" },
  { label: /^Wallet & RPC\b/, expectedHash: "wallet-rpc" },
  { label: /^Updates$/, expectedHash: "updates" },
  { label: /^Backups$/, expectedHash: "advanced" },
];
const SETTING_DEEP_LINKS: readonly {
  hash: string;
}[] = [
  { hash: "ai-model" },
  { hash: "voice" },
  { hash: "connectors" },
  { hash: "apps" },
  { hash: "background" },
  { hash: "wallet-rpc" },
  { hash: "advanced" },
  { hash: "my-runtimes" },
  { hash: "cloud-agents" },
];
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
// Minimal stub for the VRM mock route — the smoke test only checks that the
// route handler responds; it does not validate VRM content.
const SMOKE_VRM = Buffer.alloc(4);
const EMPTY_PERMISSIONS = Object.fromEntries(
  PERMISSION_IDS.map((id: PermissionId) => [
    id,
    {
      id,
      status: "not-applicable",
      lastChecked: 0,
      canRequest: false,
      platform: "linux",
    },
  ]),
) as AllPermissionsStateFixture;
function formatPageIssue(kind: string, value: unknown): string {
  if (value instanceof Error) {
    return `${kind}: ${value.message}\n${value.stack ?? ""}`.trim();
  }
  return `${kind}: ${String(value)}`;
}

// In keyless loopback mode the local stack answers 501 for any
// dev-only or optional endpoint it does not model (e.g. /api/dev/stack,
// /api/dev/console-log, /api/update/status). The renderer already degrades
// gracefully on those — the page still mounts and the ready checks still pass —
// but the browser emits a failed-resource console error for the request. That
// is a loopback-environment artifact,
// not a product defect (these endpoints return 200 in a real desktop runtime),
// so it must not fail the render smoke. Every other console.error, every
// pageerror, and every non-501 resource failure still gates the page.
function isStubUnimplementedEndpointError(text: string): boolean {
  return text.includes("Failed to load resource") && text.includes("501");
}

function installPageIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (isStubUnimplementedEndpointError(text)) return;
    const location = message.location();
    issues.push(
      `console.error: ${text}${
        location.url ? ` (${location.url}:${location.lineNumber})` : ""
      }`,
    );
  });
  page.on("pageerror", (error) => {
    issues.push(formatPageIssue("pageerror", error));
  });
  return issues;
}

async function installDesktopPermissionsBridge(page: Page): Promise<void> {
  await page.addInitScript((permissions) => {
    const secureStore = new Map<string, string>();
    const existing = window.__ELIZA_ELECTROBUN_RPC__;
    window.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        ...(existing?.request ?? {}),
        // Injecting __ELIZA_ELECTROBUN_RPC__ makes isElectrobunRuntime() →
        // isDesktopPlatform() true, so the /desktop deep link and desktop
        // viewport probes mount the full desktop workspace and run
        // initializeDesktopShell() (main.tsx). That startup path validates the
        // native contract before rendering: it throws
        // "[desktop-shell] Native Electrobun bridge is unavailable" unless
        // desktopGetVersion resolves a real runtime (not "N/A"/"unknown"), and
        // it throws again unless desktopRegisterShortcut returns
        // { success: true } (the command palette; the push-to-talk shortcut is
        // best-effort and would console.warn — failing the strict page gating —
        // without this same success stub). desktopSetTrayMenu is best-effort but
        // stubbed for parity. This is the minimum desktop startup contract the
        // other booting ui-smoke fixtures rely on (see injectFullCapabilityHost
        // in onboarding-to-home.shared.ts); without it every probe aborts.
        desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
        desktopRegisterShortcut: async () => ({ success: true }),
        desktopSetTrayMenu: async () => undefined,
        permissionsGetAll: async () => permissions,
        permissionsIsShellEnabled: async () => false,
        permissionsGetPlatform: async () => "linux",
        // The injected RPC marker declares a complete desktop host, so its
        // protected-storage boundary must exist too. Keep credentials inside
        // this native-boundary stand-in rather than letting the renderer's
        // fail-closed storage bridge report the deliberately incomplete host.
        secureStoreGet: async (params) => {
          const { kind } = params as { kind: string };
          return secureStore.has(kind)
            ? { ok: true, value: secureStore.get(kind) }
            : { ok: false, reason: "not_found" };
        },
        secureStoreSet: async (params) => {
          const { kind, value } = params as { kind: string; value: string };
          secureStore.set(kind, value);
          return { ok: true };
        },
        secureStoreDelete: async (params) => {
          const { kind } = params as { kind: string };
          const deleted = secureStore.delete(kind);
          return deleted
            ? { ok: true, deleted: true }
            : { ok: false, reason: "not_found" };
        },
      },
      onMessage: existing?.onMessage ?? (() => {}),
      offMessage: existing?.offMessage ?? (() => {}),
    };
  }, EMPTY_PERMISSIONS);
}

async function installSupplementalSafeRoutes(page: Page): Promise<void> {
  await page.route(/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i, async (route) => {
    const pathname = new URL(route.request().url()).pathname.toLowerCase();
    if (pathname.endsWith(".svg")) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#111"/></svg>',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    });
  });

  await page.route("**/api/avatar/background**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    });
  });

  await page.route("**/api/avatar/vrm**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: SMOKE_VRM,
    });
  });

  await page.route("**/api/apps/overlay-presence", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/catalog/apps", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/coding-agents/preflight", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: [], available: false }),
    });
  });

  await page.route("**/api/coding-agents/coordinator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        supervisionLevel: "manual",
        taskCount: 0,
        tasks: [],
        pendingConfirmations: 0,
        taskThreadCount: 0,
        taskThreads: [],
        frameworks: [],
      }),
    });
  });

  await page.route("**/api/character/experiences**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], total: 0 }),
    });
  });

  await page.route("**/api/browser-workspace", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "web", tabs: [] }),
    });
  });

  await page.route("**/api/browser-bridge/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          enabled: false,
          trackingMode: "off",
          allowBrowserControl: false,
          requireConfirmationForAccountAffecting: true,
          incognitoEnabled: false,
          siteAccessMode: "current_site_only",
          grantedOrigins: [],
          blockedOrigins: [],
          maxRememberedTabs: 50,
          pauseUntil: null,
          metadata: {},
          updatedAt: SMOKE_GENERATED_AT,
        },
      }),
    });
  });

  await page.route("**/api/browser-bridge/companions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ companions: [] }),
    });
  });

  await page.route("**/api/browser-bridge/packages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: {
          extensionPath: null,
          chromeBuildPath: null,
          chromePackagePath: null,
          safariWebExtensionPath: null,
          safariAppPath: null,
          safariPackagePath: null,
          releaseManifest: null,
        },
      }),
    });
  });

  await page.route("**/api/drop/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dropEnabled: false,
        publicMintOpen: false,
        whitelistMintOpen: false,
        mintedOut: false,
        currentSupply: 0,
        maxSupply: 2138,
        shinyPrice: "0.1",
        userHasMinted: false,
      }),
    });
  });

  await page.route("**/api/website-blocker", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        active: false,
        hostsFilePath: "/etc/hosts",
        startedAt: null,
        endsAt: null,
        websites: [],
        blockedWebsites: [],
        allowedWebsites: [],
        requestedWebsites: [],
        matchMode: "exact",
        managedBy: null,
        metadata: null,
        scheduledByAgentId: null,
        canUnblockEarly: true,
        requiresElevation: false,
        engine: "hosts-file",
        platform: "linux",
        supportsElevationPrompt: true,
        elevationPromptMethod: "pkexec",
      }),
    });
  });

  await page.route("**/api/permissions**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    const body =
      pathname === "/api/permissions/shell"
        ? { enabled: false }
        : EMPTY_PERMISSIONS;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function expectNoPageIssues(
  issues: readonly string[],
  label: string,
): Promise<void> {
  expect(
    issues,
    [`[all-pages-clicksafe] ${label}`, ...issues].join("\n"),
  ).toHaveLength(0);
}

async function expectMainShell(page: Page, route: RouteProbe): Promise<void> {
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /(?:404\s+not\s+found|page not found|route not found)/i,
  );
  if (route.path === "/" || route.path === "/chat") {
    return;
  }
  await expect(
    page
      .locator(
        "main, [data-testid='home-view'], [data-testid='lifeops-shell'], [role='main'], h1, [role='region'], [aria-label='Chat workspace']",
      )
      .first(),
  ).toBeVisible({
    timeout: route.timeoutMs,
  });
}

async function probeRoute(page: Page, route: RouteProbe): Promise<void> {
  const expectedUrl =
    route.expectedUrl ?? new RegExp(`${escapeRegExp(route.path)}$`);
  await openRouteAndExpectUrl(page, route, expectedUrl);
  await assertReadyChecks(
    page,
    route.name,
    route.readyChecks,
    route.mode ?? "any",
    route.timeoutMs,
  );
  await expectMainShell(page, route);
}

async function openRouteAndExpectUrl(
  page: Page,
  route: RouteProbe,
  expectedUrl: RegExp,
): Promise<void> {
  const timeoutMs = route.timeoutMs ?? 60_000;
  const firstAttemptTimeoutMs = Math.min(timeoutMs, 15_000);

  for (let attempt = 0; attempt < 2; attempt++) {
    await openAppPath(page, route.path);
    await expect(page)
      .toHaveURL(expectedUrl, {
        timeout: attempt === 0 ? firstAttemptTimeoutMs : timeoutMs,
      })
      .then(
        () => undefined,
        async (error: unknown) => {
          if (attempt > 0) throw error;
          await page
            .goto("about:blank", {
              waitUntil: "domcontentloaded",
              timeout: 5_000,
            })
            .catch(() => {
              /* best-effort reset before retrying a missed navigation */
            });
        },
      );
    if (expectedUrl.test(page.url())) return;
  }
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  const target = locator.first();
  if (!(await target.isVisible().catch(() => false))) return false;
  if (!(await target.isEnabled().catch(() => false))) return false;
  await target.click();
  return true;
}

async function readFavoriteApps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("eliza:favorite-apps");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  });
}

async function clickSafeAllowlist(
  page: Page,
  issues: readonly string[],
): Promise<void> {
  await probeRoute(page, coreRouteProbe("chat"));
  const legacyHeaderToggle = page.getByTestId("header-tasks-events-toggle");
  const clickedLegacyHeaderToggle = await clickIfVisible(legacyHeaderToggle);
  if (clickedLegacyHeaderToggle) {
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 60_000,
    });
  } else {
    await expect(
      page.locator(
        '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      ),
      "legacy header tasks/events toggle is not rendered in the current shell; the no-op is explicit and the chat route remains operable",
    ).toBeVisible({ timeout: 60_000 });
  }
  await expect(
    page.locator(
      '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expectNoPageIssues(issues, "chat safe toggle");

  await probeRoute(page, coreRouteProbe("views catalog deep link"));
  const favoriteButton = page.getByRole("button", {
    name: "Add to favorites",
  });
  const favoriteAppsBefore = await readFavoriteApps(page);
  if (await clickIfVisible(favoriteButton)) {
    await expect(
      page.getByRole("button", { name: "Remove from favorites" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => readFavoriteApps(page), {
        message: "favorite toggle must mutate persisted favorite app state",
      })
      .not.toEqual(favoriteAppsBefore);
  } else {
    await expect(
      favoriteButton,
      "no unfavorited app tile is visible in this fixture; the favorite-toggle no-op is explicit",
    ).toHaveCount(0);
  }
  await expectNoPageIssues(issues, "apps favorite toggle");

  await probeRoute(page, coreRouteProbe("settings"));
  for (const section of SETTING_SECTIONS_TO_CLICK) {
    await openSettingsSection(page, section.label);
    await expect(page.getByTestId("settings-shell")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(
      new RegExp(`#${escapeRegExp(section.expectedHash)}$`),
      {
        timeout: 60_000,
      },
    );
    await expect(page.locator(`#${section.expectedHash}`)).toBeVisible({
      timeout: 60_000,
    });
    await expectNoPageIssues(
      issues,
      `settings section ${String(section.label)}`,
    );
  }

  for (const link of SETTING_DEEP_LINKS) {
    await openAppPath(page, `/settings#${link.hash}`);
    await expect(page.getByTestId("settings-shell")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(new RegExp(`#${escapeRegExp(link.hash)}$`), {
      timeout: 60_000,
    });
    await expect(page.locator(`#${link.hash}`)).toBeVisible({
      timeout: 60_000,
    });
    await expectNoPageIssues(issues, `settings deep link ${link.hash}`);
  }
}

test.beforeEach(async ({ page }) => {
  await installDesktopPermissionsBridge(page);
  // Mark permissions already primed so the soft-ask "Set up Eliza" overlay never
  // pops over a routed view mid-sweep (it renders above the shell and its buttons
  // would otherwise be the first ones a header probe reaches). first-run is
  // already complete via DEFAULT_APP_STORAGE; this closes the other gate.
  await seedAppStorage(page, {
    "eliza:permissions-primed": "1",
    "eliza:developerMode": "1",
  });
  await installSupplementalSafeRoutes(page);
  await installDefaultAppRoutes(page);
});

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  await page
    .goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 })
    .catch(() => {
      /* best-effort cleanup before Playwright closes the context */
    });
});

for (const viewport of [DESKTOP_PROBE, MOBILE_PROBE]) {
  for (const route of viewport.routes) {
    test(`route renders without console failures: ${viewport.name} ${route.name}`, async ({
      page,
    }) => {
      const issues = installPageIssueGuards(page);
      await page.setViewportSize(viewport.size);
      await probeRoute(page, route);
      await expectNoPageIssues(issues, `${viewport.name}: ${route.name}`);
    });
  }
}

test("visible safe app tiles and allowlisted buttons are click-safe", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const issues = installPageIssueGuards(page);
  await page.setViewportSize(DESKTOP_PROBE.size);

  for (const tile of SAFE_VIEW_TILES) {
    await test.step(tile.name, async () => {
      await probeRoute(page, coreRouteProbe("views catalog deep link"));
      // A view may appear in both the "Pinned & recent" strip and a section
      // grid, so target the first matching card.
      const card = page.getByTestId(tile.testId).first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await card.click();
      await expect(page).toHaveURL(tile.expectedPath, { timeout: 60_000 });
      await expectNoPageIssues(issues, tile.name);
    });
  }

  await clickSafeAllowlist(page, issues);
});

test("mobile Settings back control returns to the settings hub without crashing", async ({
  page,
}) => {
  const issues = installPageIssueGuards(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await probeRoute(page, coreRouteProbe("settings"));
  const hub = page.getByTestId("settings-hub-list");
  await expect(hub).toBeVisible();
  await hub.getByRole("button", { name: "Voice", exact: true }).click();
  await expect(hub).toHaveCount(0);
  await clickViewBackControl(page, {
    name: "Back to Settings",
    within: '[data-testid="settings-shell"]',
    requireTapTarget: true,
    destination: page.getByTestId("settings-hub-list"),
  });
  await expect(
    page.getByRole("button", { name: "Back to Settings", exact: true }),
  ).toHaveCount(0);
  await expectNoPageIssues(issues, "mobile settings back navigation");
});
