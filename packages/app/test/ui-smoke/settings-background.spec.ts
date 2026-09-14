/**
 * Playwright UI-smoke spec for the Settings Background app flow using the real
 * renderer fixture.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import sharp from "sharp";
import type { ModelHubSnapshot } from "../../../ui/src/api/client-local-inference";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
  UI_SMOKE_CPU_ONLY_HARDWARE,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "settings-background",
);

// A handful of launcher views so the launcher is non-empty (the home
// WidgetHost / catalog only renders content when the catalog has visible
// views — see ViewCatalog.tsx's empty-state branch).
const VIEW_FIXTURES = [
  {
    id: "views-manager",
    label: "Views",
    description: "Browse and launch every available view",
    path: "/views",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["launcher"],
    desktopTabEnabled: true,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Agent + app settings",
    path: "/settings",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["settings"],
    desktopTabEnabled: true,
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Calendar view",
    path: "/calendar",
    available: true,
    pluginName: "calendar",
    tags: ["calendar"],
    desktopTabEnabled: true,
  },
];

// localStorage key for the persisted BackgroundConfig (persistence.ts
// UI_BACKGROUND_STORAGE_KEY). AppBackground reads this via useBackgroundConfig.
const UI_BACKGROUND_STORAGE_KEY = "eliza:ui-background";

async function fulfillJson(
  route: Route,
  body: Record<string, unknown> | unknown[],
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * A busy "photo-like" wallpaper as a JPEG data URL: a multi-stop gradient with
 * scattered translucent circles/rects and bright text overlays. This is a worst
 * case for a flat (card-less) settings layout — the page has to stay legible
 * over real high-contrast variance, not a calm flat field. Generated in-test
 * with sharp (already a suite dependency) so no binary fixture is committed.
 */
async function busyWallpaperDataUrl(): Promise<string> {
  const W = 1280;
  const H = 900;
  const circles = Array.from({ length: 24 })
    .map(
      (_, i) =>
        `<circle cx="${(i * 127) % W}" cy="${(i * 211) % H}" r="${
          40 + ((i * 13) % 120)
        }" fill="rgba(255,255,255,${0.05 + (i % 5) * 0.06})"/>`,
    )
    .join("");
  const rects = Array.from({ length: 30 })
    .map(
      (_, i) =>
        `<rect x="${(i * 83) % W}" y="${(i * 167) % H}" width="${
          60 + ((i * 7) % 180)
        }" height="${30 + ((i * 11) % 90)}" fill="rgba(0,0,0,${
          0.04 + (i % 6) * 0.05
        })"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0b3d91"/>
        <stop offset="35%" stop-color="#11998e"/>
        <stop offset="60%" stop-color="#f6d365"/>
        <stop offset="100%" stop-color="#e84393"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${circles}
    ${rects}
    <text x="60" y="200" font-family="sans-serif" font-size="120" fill="rgba(255,255,255,0.85)">WALLPAPER</text>
    <text x="60" y="760" font-family="sans-serif" font-size="80" fill="rgba(0,0,0,0.5)">busy photo bg</text>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function installSettingsBackgroundRoutes(
  page: Page,
  hubOverrides: Partial<ModelHubSnapshot> = {},
): Promise<void> {
  await installDefaultAppRoutes(page);
  await page.route("**/api/cloud/credits", (route) =>
    fulfillJson(route, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    }),
  );
  await page.route("**/api/local-inference/providers", (route) =>
    fulfillJson(route, { providers: [] }),
  );

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: { avatarIndex: 1 },
      wallet: {},
    });
  });

  await page.route("**/api/stream/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { settings: { avatarIndex: 1 } });
  });
  await page.route("**/api/agent/events**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
  });

  // Local-inference shell-level GETs — the booted zero-key stack answers 501,
  // which the diagnostics guard treats as a failure. A fresh agent has no local
  // model, so an idle snapshot with valid OS-fallback hardware matches the
  // real zero-state.
  await page.route("**/api/local-inference/hub", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const emptyDownload = {
      state: "idle",
      percent: null,
      etaMs: null,
      bytesDownloaded: 0,
      bytesTotal: 0,
      error: null,
    };
    const slot = (name: string) => ({
      slot: name,
      assigned: false,
      assignedModelId: null,
      displayName: null,
      primaryDownloaded: false,
      downloaded: false,
      active: false,
      ready: false,
      state: "unassigned",
      requiredModelIds: [],
      missingModelIds: [],
      installedBytes: 0,
      expectedBytes: 0,
      download: emptyDownload,
      errors: [],
    });
    await fulfillJson(route, {
      catalog: [],
      installed: [],
      active: {
        modelId: null,
        loaded: false,
        status: "idle",
        error: null,
        updatedAt: new Date(0).toISOString(),
      },
      downloads: [],
      hardware: UI_SMOKE_CPU_ONLY_HARDWARE,
      assignments: {},
      textReadiness: {
        updatedAt: new Date(0).toISOString(),
        slots: {
          TEXT_SMALL: slot("TEXT_SMALL"),
          TEXT_LARGE: slot("TEXT_LARGE"),
        },
      },
      ...hubOverrides,
    });
  });
  await page.route(
    "**/api/local-inference/downloads/stream**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    },
  );

  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { plugins: [] });
  });

  // Views catalog — populate the launcher so the home surface mounts.
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });
}

async function seedSettingsBackgroundStorage(
  page: Page,
  background: { mode: "shader" | "image"; color: string; imageUrl?: string },
): Promise<void> {
  await seedAppStorage(page, {
    "eliza:mobile-runtime-mode": "local",
    "eliza:permissions-primed": "1",
    [UI_BACKGROUND_STORAGE_KEY]: JSON.stringify(background),
  });
}

async function installReadyDesktopStatusBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const secureStore = new Map<string, string>();
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
      offMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
    };
    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const existing = win.__ELIZA_ELECTROBUN_RPC__;
    const now = Date.now();
    const readyStatus = {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 60_000,
      startedAt: now - 60_000,
      pendingRestart: false,
      pendingRestartReasons: [],
      startup: { phase: "running", attempt: 0 },
    };
    const readyLaunch = {
      phase: "ready",
      agent: {
        state: "running",
        port: null,
        apiBase: null,
        startedAt: now - 60_000,
        error: null,
      },
      boot: {
        runtimePhase: "running",
        pluginsLoaded: 0,
        pluginsFailed: 0,
        database: "ok",
      },
      auth: { checked: true, required: false },
      firstRun: { checked: true, complete: true, cloudProvisioned: true },
      remotes: { seeded: true, requiredStarted: false, errors: [] },
      localModel: { backgroundDownloadQueued: false, blocking: false },
      diagnostics: { logPath: "", statusPath: "" },
      recovery: {
        canRetry: false,
        canOpenLogs: false,
        canCreateBugReport: false,
      },
      updatedAt: new Date(now).toISOString(),
    };
    const readyBoot = {
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 0,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Playwright Smoke",
      port: null,
      startedAt: now - 60_000,
    };
    const withReadyStatus = (bridge?: Bridge): Bridge => ({
      request: {
        ...(bridge?.request ?? {}),
        desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
        desktopRegisterShortcut: async () => ({ success: true }),
        desktopSetTrayMenu: async () => undefined,
        secureStoreGet: async ({ kind }: { kind: string }) =>
          secureStore.has(kind)
            ? { ok: true, value: secureStore.get(kind) }
            : { ok: false, reason: "not_found" },
        secureStoreSet: async ({
          kind,
          value,
        }: {
          kind: string;
          value: string;
        }) => {
          secureStore.set(kind, value);
          return { ok: true };
        },
        secureStoreDelete: async ({ kind }: { kind: string }) => ({
          ok: true,
          deleted: secureStore.delete(kind),
        }),
        getAgentStatus: async () => readyStatus,
        launchProgress: async () => readyLaunch,
        bootProgress: async () => readyBoot,
      },
      onMessage: bridge?.onMessage ?? (() => {}),
      offMessage: bridge?.offMessage ?? (() => {}),
    });
    let currentBridge = withReadyStatus(existing);
    Object.defineProperty(win, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      get() {
        return currentBridge;
      },
      set(nextBridge: Bridge | undefined) {
        currentBridge = withReadyStatus(nextBridge);
      },
    });
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:playwright-smoke",
        kind: "local",
        label: "Playwright Smoke",
        apiBase: window.location.origin,
      }),
    );
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function gotoSettings(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  await expect(page.getByTestId("settings-shell")).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("Settings appearance and model controls", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("shows a failed model activation in detached Settings", async ({
    page,
  }) => {
    await seedSettingsBackgroundStorage(page, {
      mode: "image",
      color: "#ef5a1f",
      imageUrl: "/bg-sunset.webp",
    });
    await installReadyDesktopStatusBridge(page);
    await installSettingsBackgroundRoutes(page, {
      catalog: [
        {
          id: "eliza-1-2b",
          displayName: "Eliza-1",
          hfRepo: "elizaos/eliza-1",
          ggufFile: "model.gguf",
          params: "2B",
          quant: "Q4_K_M",
          sizeGb: 1.4,
          minRamGb: 4,
          category: "chat",
          bucket: "small",
          blurb: "Local text model",
          publishStatus: "published",
        },
      ],
      installed: [
        {
          id: "eliza-1-2b",
          displayName: "Eliza-1",
          path: "/models/model.gguf",
          sizeBytes: 1400000000,
          installedAt: "2026-09-05T00:00:00Z",
          lastUsedAt: null,
          source: "eliza-download",
        },
      ],
    });
    await page.route("**/api/local-inference/active", (route) =>
      fulfillJson(route, {
        modelId: "eliza-1-2b",
        status: "error",
        error:
          "Model activation failed its quality checks. Choose another model.",
      }),
    );
    await openAppPath(page, "/settings?shell=settings#ai-model");
    await page
      .getByRole("button", { name: "Make active", exact: true })
      .click();
    const notice = page.getByTestId("shell-action-notice");
    await expect(notice).toContainText(
      "Model activation failed its quality checks",
    );
    await expect(notice).toBeInViewport();
    await screenshot(page, "detached-settings-action-error");
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByTestId("background-catalog-gallery")).toBeVisible();
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`makes failed voice previews visible and retryable at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await seedSettingsBackgroundStorage(page, {
        mode: "image",
        color: "#ef5a1f",
        imageUrl: "/bg-sunset.webp",
      });
      await installReadyDesktopStatusBridge(page);
      await installSettingsBackgroundRoutes(page);
      await page.route("**/api/cloud/status", (route) =>
        fulfillJson(route, {
          connected: true,
          enabled: true,
          cloudVoiceProxyAvailable: true,
          hasApiKey: true,
        }),
      );
      let previewRequests = 0;
      await page.route(
        "https://storage.googleapis.com/eleven-public-prod/**",
        (route) => {
          previewRequests += 1;
          // Exercise the browser's real media decoder failure, not a replacement Audio object.
          return route.fulfill({
            status: 200,
            contentType: "audio/mpeg",
            body: "invalid audio payload",
          });
        },
      );
      await openAppPath(page, "/settings?shell=settings#voice");
      const voice = page.getByRole("combobox", { name: "Voice", exact: true });
      await voice.click();
      await screenshot(page, `voice-selector-menu-${viewport.width}`);
      await page.getByRole("option", { name: /Rachel/ }).click();
      await screenshot(page, `voice-selector-selected-${viewport.width}`);
      const preview = page.getByRole("button", {
        name: "Preview Voice",
        exact: true,
      });
      await preview.click();
      const error = page
        .getByRole("alert")
        .filter({ hasText: "Couldn't play this voice preview" });
      await expect(error).toBeVisible();
      await expect(preview).toBeEnabled();
      await error.scrollIntoViewIfNeeded();
      await screenshot(page, `voice-preview-error-${viewport.width}`);
      const requestsBeforeRetry = previewRequests;
      await preview.click();
      await expect
        .poll(() => previewRequests)
        .toBeGreaterThan(requestsBeforeRetry);
      await expect(error).toBeVisible();
      await voice.click();
      await page.getByRole("option", { name: /Sarah/ }).click();
      await expect(error).toHaveCount(0);
    });
  }

  test("scrolls detached Settings to its lower controls", async ({ page }) => {
    await page.setViewportSize({ width: 1044, height: 768 });
    await seedSettingsBackgroundStorage(page, {
      mode: "image",
      color: "#ef5a1f",
      imageUrl: "/bg-sunset.webp",
    });
    await installReadyDesktopStatusBridge(page);
    await installSettingsBackgroundRoutes(page);
    await openAppPath(page, "/settings?shell=settings#ai-model");
    const scroller = page.getByTestId("settings-scroll-region");
    await expect(scroller).toBeVisible();
    const advanced = page.getByRole("button", {
      name: "Custom providers & model overrides",
      exact: true,
    });
    for (const viewport of [
      { width: 1044, height: 768 },
      { width: 760, height: 560 },
    ]) {
      await page.setViewportSize(viewport);
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(advanced).not.toBeInViewport();
      await scroller.hover();
      await page.mouse.wheel(0, 10000);
      await expect(advanced).toBeInViewport({ ratio: 1 });
      await advanced.click();
      await expect(advanced).toHaveAttribute("aria-expanded", "true");
      await advanced.press("Enter");
      await expect(advanced).toHaveAttribute("aria-expanded", "false");
      await screenshot(page, `detached-settings-bottom-${viewport.width}`);
    }
  });

  test("reveals the selected wallpaper without shifting the detached settings window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 560 });
    await seedSettingsBackgroundStorage(page, {
      mode: "image",
      color: "#ef5a1f",
      imageUrl: "/bg-sunset.webp",
    });
    await installReadyDesktopStatusBridge(page);
    await installSettingsBackgroundRoutes(page);
    await openAppPath(page, "/settings?shell=settings");
    const general = page.getByRole("button", { name: "General", exact: true });
    await expect(general).toBeVisible();
    const before = await general.boundingBox();
    expect(before).not.toBeNull();
    await general.click();
    const gallery = page.getByTestId("background-catalog-gallery");
    await expect(gallery).toBeVisible();
    const selected = gallery.getByRole("button", {
      name: "Set background to Ember Night",
      exact: true,
    });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const after = await general.boundingBox();
        return after && before ? Math.abs(after.x - before.x) : Infinity;
      })
      .toBeLessThan(1);
    const stripBounds = await gallery.boundingBox();
    const selectedBounds = await selected.boundingBox();
    expect(stripBounds).not.toBeNull();
    expect(selectedBounds).not.toBeNull();
    if (!stripBounds || !selectedBounds)
      throw new Error("Wallpaper picker has no layout");
    expect(selectedBounds.x).toBeGreaterThanOrEqual(stripBounds.x);
    expect(selectedBounds.x + selectedBounds.width).toBeLessThanOrEqual(
      stripBounds.x + stripBounds.width,
    );
    expect(
      await gallery.evaluate((strip) => {
        const offsets = [];
        for (
          let parent = strip.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          offsets.push(parent.scrollLeft);
        }
        return offsets.every((offset) => offset === 0);
      }),
    ).toBe(true);
    await screenshot(page, "detached-general-rest");
    await selected.hover();
    await screenshot(page, "detached-general-hover");
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openAppPath(page, "/settings?shell=settings#appearance");
    await expect(gallery).toBeVisible();
    await expect(selected).toBeInViewport({ ratio: 1 });
    await screenshot(page, "mobile-general-rest");
    await selected.hover();
    await screenshot(page, "mobile-general-hover");
  });

  test("keeps Settings opaque while preserving the selected launcher wallpaper", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    const wallpaper = await busyWallpaperDataUrl();
    await seedSettingsBackgroundStorage(page, {
      mode: "image",
      color: "#ef5a1f",
      imageUrl: wallpaper,
    });
    await installReadyDesktopStatusBridge(page);
    await installSettingsBackgroundRoutes(page);

    for (const [name, viewport] of [
      ["desktop", DESKTOP_VIEWPORT],
      ["mobile", MOBILE_VIEWPORT],
    ] as const) {
      await page.setViewportSize(viewport);
      await gotoSettings(page);
      await expect(page.getByTestId("app-background-image")).toHaveCount(0);
      const hasOpaqueSurface = await page
        .getByTestId("settings-shell")
        .evaluate((shell) => {
          let node: Element | null = shell;
          while (node && node !== document.body) {
            const color = getComputedStyle(node).backgroundColor;
            if (
              color.startsWith("rgb(") ||
              /rgba\([^,]+,[^,]+,[^,]+,\s*1\)/.test(color)
            )
              return true;
            node = node.parentElement;
          }
          return false;
        });
      expect(hasOpaqueSurface, "Settings needs an opaque reading surface").toBe(
        true,
      );
      await screenshot(page, `${name}-settings-opaque`);
      await openAppPath(page, "/views");
      const image = page.getByTestId("app-background-image");
      await expect(image).toBeAttached();
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top <= 0 && rect.bottom >= window.innerHeight - 1;
          }),
        )
        .toBe(true);
      await screenshot(page, `${name}-launcher-image`);
    }
  });
});
