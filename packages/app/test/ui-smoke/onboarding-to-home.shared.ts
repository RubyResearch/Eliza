/**
 * Shared onboarding-to-home flow helpers used by desktop and mobile UI-smoke
 * specs.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { installDefaultAppRoutes, UI_SMOKE_CPU_ONLY_HARDWARE } from "./helpers";
import { navigateHomeLauncher } from "./helpers/launcher-navigation";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";
import {
  seedStewardSession,
  setStewardSession,
  UI_SMOKE_STEWARD_OPAQUE_TOKEN,
} from "./helpers/test-auth";

// Shared onboarding → home → launcher fixtures, route mocks, and assertions
// for the desktop-Chromium (onboarding-to-home.spec.ts) and mobile-viewport
// (onboarding-to-home-mobile.spec.ts) lanes. Both drive the SAME keyless flow —
// fresh device → real Local/on-device onboarding → completeFirstRun("chat") →
// home with seeded widgets → swipe-left → launcher — so the fixtures and the
// route layer live here once and the two specs differ only in browser context
// (desktop vs Pixel-class touch viewport) and screenshot output directory.

// A tiny silent WAV so a mocked TTS POST returns bytes decodeAudioData accepts
// on every Chromium build, keeping the page-diagnostics guard clean when the
// tutorial narrator speaks. The old truncated-mp3 fixture stopped decoding
// once the voice pipeline fails closed on decode errors (#12267 sweeps) — a
// PCM WAV has no codec dependency and always decodes.
function tinySilentWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 160; // 20 ms of 16-bit mono silence
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); // PCM fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}
const TINY_SILENT_WAV = tinySilentWav();

// Launcher views so the launcher is non-empty (the home WidgetHost only
// renders when the catalog has visible views) AND so a known launcher tile
// (`launcher-tile-settings`) is assertable. `settings` is a system entry id.
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
    description: "Settings view",
    path: "/settings",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["system"],
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
  {
    id: "goals",
    label: "Goals",
    description: "Goals view",
    path: "/goals",
    available: true,
    pluginName: "goals",
    tags: ["goals"],
    desktopTabEnabled: true,
  },
  {
    id: "finances",
    label: "Finances",
    description: "Finances view",
    path: "/finances",
    available: true,
    pluginName: "finances",
    tags: ["finances"],
    desktopTabEnabled: true,
  },
];

// The home widgets resolve only when the matching plugin id is enabled+active in
// the runtime snapshot (registry.ts `isWidgetEnabled`).
function pluginInfo(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} (ui-smoke)`,
    enabled: true,
    isActive: true,
    configured: true,
    envKey: null,
    category: "feature" as const,
    source: "bundled" as const,
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
  };
}

const PLUGIN_SNAPSHOT = [
  pluginInfo("calendar", "Calendar"),
  pluginInfo("goals", "Goals"),
  pluginInfo("health", "Health"),
  pluginInfo("todo", "Todos"),
];

async function fulfillJson(
  route: Route,
  body: Record<string, unknown> | unknown[],
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "content-type": "application/json",
    },
    body: requestAllowsBody(route) ? JSON.stringify(body) : "",
  });
}

function requestAllowsBody(route: Route): boolean {
  return route.request().method() !== "HEAD";
}

// -- Seeded attention payloads (mirror home-widget-priority.spec) -------------

function goalsPayload() {
  return {
    goals: [
      {
        goal: {
          id: "goal-at-risk",
          title: "Ship the release",
          status: "active",
          reviewState: "at_risk",
        },
        links: [],
      },
    ],
  };
}
function calendarFeed() {
  const startAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const endAt = new Date(Date.now() + 105 * 60 * 1000).toISOString();
  return {
    events: [
      {
        id: "evt-soon",
        title: "Design review",
        startAt,
        endAt,
        isAllDay: false,
        location: "Zoom",
      },
    ],
  };
}
function sleepHistory() {
  return {
    episodes: [
      {
        startedAt: "2026-01-01T23:30:00.000Z",
        endedAt: "2026-01-02T05:15:00.000Z",
        durationMin: 345,
      },
    ],
    summary: {
      cycleCount: 6,
      averageDurationMin: 360,
      overnightCount: 6,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
  };
}
function sleepRegularity() {
  return {
    classification: "irregular",
    sri: 41.2,
    sampleSize: 6,
    windowDays: 14,
  };
}
function notificationsPayload() {
  return {
    notifications: [
      {
        id: "notif-urgent",
        title: "Payment failed",
        body: "Your card was declined for the Acme invoice.",
        category: "system",
        priority: "urgent",
        source: "system",
        createdAt: Date.now(),
        readAt: null,
      },
    ],
    unreadCount: 1,
  };
}

// A full-capability host (real API base + an Electrobun bridge) so the
// onboarding offers — and ENABLES — the Local runtime card. `__electrobunWindowId`
// makes isElectrobunRuntime()→isDesktopPlatform() true, which is what
// canSelectLocalRuntime() keys off (without it the Local card is rendered but
// disabled on a cloud-only host).
//
// The local first-run path resolves the on-device agent base via
// resolveFirstRunLocalAgentApiBase() → getElizaApiBase() (which reads the
// boot-config apiBase, NOT __ELIZA_APP_API_BASE__). Seed the boot-config mirror
// (and the branded __ELIZAOS_API_BASE__) with the page origin so
// client.setBaseUrl() in finishLocal keeps every request on the live preview
// origin (and the route mocks) instead of falling back to
// DEFAULT_LOCAL_AGENT_API_BASE (http://127.0.0.1:31337), which has no server →
// ERR_CONNECTION_REFUSED on the chat/home surface.
export async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const origin = window.location.origin;
    const secureStore = new Map<string, string>();
    const win = window as unknown as Record<string, unknown>;
    win.__ELIZA_APP_API_BASE__ = origin;
    win.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase: origin };
    win.__ELIZAOS_API_BASE__ = origin;
    win.__electrobunWindowId = 1;
    win.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
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
      },
      onMessage: () => {},
      offMessage: () => {},
    };
    // Production remains cloud-only by default (#13377). These helpers also run
    // against packaged builds where Vite's development default is absent, so
    // opt in explicitly; the production default is covered by
    // onboarding-cloud-only.spec.ts with the inverse override.
    window.localStorage.setItem("eliza:enable-runtime-chooser", "1");
  });
}

// Mutable, page-scoped record of the writes the in-chat onboarding performs, so
// a spec can assert "POST /api/first-run fired exactly once" against the live
// network boundary (the single `persistFirstRun` funnel in first-run-finish.ts).
export interface OnboardingRouteState {
  firstRunPosts: unknown[];
}

async function routeFirstRunIncomplete(
  page: Page,
  state: OnboardingRouteState,
): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  // Onboarding boots with first-run NOT complete so the in-chat conductor seeds
  // the greeting + runtime choice into the live floating chat. submitFirstRun
  // (POST /api/first-run) is the single write the finish use case performs
  // before completeFirstRun; we record every POST so the spec can prove the
  // exactly-once contract.
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      complete: state.firstRunPosts.length > 0,
      cloudProvisioned: false,
    });
  });
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    try {
      state.firstRunPosts.push(route.request().postDataJSON());
    } catch {
      state.firstRunPosts.push({});
    }
    await fulfillJson(route, { ok: true });
  });
}

export async function installHomeRoutes(
  page: Page,
): Promise<OnboardingRouteState> {
  const state: OnboardingRouteState = { firstRunPosts: [] };
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page, state);

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

  await page.route("**/api/coding-agents", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillJson(route, {});
      return;
    }
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, []);
  });

  // Local-inference shell-level GETs — a fresh agent has no local model, so an
  // idle snapshot with valid OS-fallback hardware matches the real zero-state
  // (and the local first-run path's background auto-download probe lands on
  // this empty hub).
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

  // The plugin snapshot drives which per-plugin home widgets resolve.
  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { plugins: PLUGIN_SNAPSHOT });
  });

  // Views catalog — populate the launcher so the home WidgetHost mounts.
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });

  // Seeded attention data for kept sparse-home widgets.
  await page.route("**/api/lifeops/goals**", async (route) => {
    await fulfillJson(route, goalsPayload());
  });
  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    await fulfillJson(route, calendarFeed());
  });
  await page.route("**/api/lifeops/sleep/history**", async (route) => {
    await fulfillJson(route, sleepHistory());
  });
  await page.route("**/api/lifeops/sleep/regularity**", async (route) => {
    await fulfillJson(route, sleepRegularity());
  });
  // Notification inbox hydrate — the pinned center + the urgent signal.
  // Drop the empty default from installDefaultAppRoutes so this seeded payload
  // is the only handler (LIFO route order is easy to accidentally invert).
  await page.unroute("**/api/notifications**").catch(() => {});
  await page.route("**/api/notifications**", async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "POST" && pathname === "/api/notifications") {
      await fulfillJson(
        route,
        {
          notification: {
            id: "smoke-notification-1",
            title: "smoke",
            category: "system",
            priority: "low",
            createdAt: Date.now(),
            readAt: null,
          },
        },
        201,
      );
      return;
    }
    if (method !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, notificationsPayload());
  });

  // Benign TTS so the interactive tutorial's narrator (the "Take the tutorial"
  // branch speaks its first voice line through the REAL voice pipeline) does not
  // 501 against the stub and trip the page-diagnostics guard. A tiny PCM WAV —
  // always decodable, no codec dependency.
  await page.route("**/api/tts/**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: TINY_SILENT_WAV,
    });
  });

  // The narrator's decoded audio also reports playback frames (avatar/viseme
  // sync); the API stub 501s that POST, which trips the diagnostics guard.
  await page.route("**/api/voice/playback-frames", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  return state;
}

// ── Cloud-runtime onboarding routes ──────────────────────────────────────────
//
// The in-chat Cloud path (pick Cloud → OAuth card → cloud-agent choice → bind)
// is driven entirely by the conductor; the user never types a key. We mock the
// cloud login success at the network boundary the SAME way the existing cloud
// specs do: `/api/cloud/status` reports connected, a global auth token is
// injected (see `injectCloudAuthToken`), and `/api/cloud/compat/agents` lists
// one already-running agent whose bridge is this very page origin. Because that
// bound base owns the app-shell routes (`supportsFullAppShellRoutes` → true),
// the cloud finish persists first-run exactly once — same `persistFirstRun`
// funnel as Local — so the POST-once contract holds across runtimes.
export const CLOUD_AUTH_TOKEN = UI_SMOKE_STEWARD_OPAQUE_TOKEN;
export const CLOUD_AGENT_ID = "ui-smoke-cloud-agent-1";
// Personal-Eliza identity (#19511): cloud onboarding binds the account's one
// personal Eliza through GET /api/v1/eliza/personal. The dedicated runtime
// shape lets the identity point back at the local Playwright origin (loopback
// origins are trusted cloud API bases), keeping the real agent surface live.
export const PERSONAL_ELIZA_ID =
  "personal:11111111-1111-5111-8111-111111111111";
export const PERSONAL_ACTIVE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
export const CLOUD_AGENT_NAME = "Smoke Cloud Agent";

/** Inject the cloud session token before React boots (getCloudAuthToken reads
 *  the canonical steward-session store first). */
export async function injectCloudAuthToken(page: Page): Promise<void> {
  await seedStewardSession(page, { token: CLOUD_AUTH_TOKEN });
}

export async function installCloudRoutes(
  page: Page,
  opts: { agentCount?: 0 | 1 } = {},
): Promise<void> {
  // agentCount 0 exercises the silent auto-provision path (no cloud-agent
  // picker): bindCloudAgent creates the agent via the POST mock below.
  const agentCount = opts.agentCount ?? 1;
  await page.unroute("**/api/cloud/status").catch(() => {});
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId: "ui-smoke-onboarding-user",
    });
  });

  await page.unroute("**/api/cloud/credits").catch(() => {});
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    });
  });

  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      ok: true,
      sessionId: "ui-smoke-onboarding-cloud-session",
      browserUrl:
        "https://www.elizacloud.ai/device/ui-smoke-onboarding-cloud-session",
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      status: "authenticated",
      token: CLOUD_AUTH_TOKEN,
      organizationId: "ui-smoke-onboarding-org",
      userId: "ui-smoke-onboarding-user",
    });
  });

  // The browser cloud path lists agents through the LOCAL proxy
  // (`/api/cloud/compat/agents`), not the direct cloud origin — see
  // getCloudCompatAgents (client-cloud.ts). One running agent whose bridge is
  // the page origin makes the bound base an app-shell base → first-run persists.
  await page.route("**/api/cloud/compat/agents", async (route) => {
    const request = route.request();
    const origin = new URL(request.url()).origin;
    if (request.method() === "GET") {
      await fulfillJson(route, {
        success: true,
        data:
          agentCount === 0
            ? []
            : [
                {
                  agent_id: CLOUD_AGENT_ID,
                  agent_name: CLOUD_AGENT_NAME,
                  status: "running",
                  bridge_url: origin,
                  web_ui_url: origin,
                  containerUrl: origin,
                  webUiUrl: origin,
                  database_status: "ready",
                  error_message: null,
                  agent_config: {},
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                  last_heartbeat_at: "2026-01-01T00:00:00.000Z",
                },
              ],
      });
      return;
    }
    if (request.method() === "POST") {
      await fulfillJson(route, {
        success: true,
        data: {
          agentId: CLOUD_AGENT_ID,
          agentName: CLOUD_AGENT_NAME,
          jobId: "",
          status: "running",
          nodeId: null,
          message: "Agent created",
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/cloud/compat/agents/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const origin = new URL(route.request().url()).origin;
    await fulfillJson(route, {
      success: true,
      data: {
        agent_id: CLOUD_AGENT_ID,
        agent_name: CLOUD_AGENT_NAME,
        status: "running",
        bridge_url: origin,
        web_ui_url: origin,
        containerUrl: origin,
        webUiUrl: origin,
        database_status: "ready",
        error_message: null,
        agent_config: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_heartbeat_at: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  // #19511: the actual bind call for cloud onboarding. The identity's apiBase
  // must be the LOCAL Playwright origin: the client resolves this request
  // against the direct cloud base (https://eliza.app when boot config leaves
  // it unset), and a control-plane host is only trusted with an agent path,
  // while a loopback origin is trusted bare - so point the runtime at the
  // page's own server, which also keeps the real agent surface serving chat.
  await page.route("**/api/v1/eliza/personal", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const pageUrl = page.url();
    const origin = pageUrl.startsWith("http")
      ? new URL(pageUrl).origin
      : new URL(route.request().url()).origin;
    await fulfillJson(route, {
      success: true,
      data: {
        identity: {
          id: PERSONAL_ELIZA_ID,
          displayName: CLOUD_AGENT_NAME,
          runtime: "dedicated",
          activeAgentId: PERSONAL_ACTIVE_AGENT_ID,
          apiBase: origin,
        },
      },
    });
  });
}

export async function settleHomeEntrance(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const home = document.querySelector('[data-testid="home-screen"]');
      if (!home) return false;
      const animating = (home as HTMLElement)
        .getAnimations({ subtree: true })
        .some(
          (a) =>
            (a as CSSAnimation).animationName === "home-enter" &&
            a.playState !== "finished",
        );
      return !animating;
    },
    undefined,
    { timeout: 5_000 },
  );
}

export function makeScreenshotter(
  dir: string,
): (page: Page, name: string) => Promise<void> {
  return async (page, name) => {
    await mkdir(dir, { recursive: true });
    await captureScreenshotWithQualityRetry(page, name, {
      path: path.join(dir, `${name}.png`),
      fullPage: false,
      attempts: 4,
    });
  };
}

// The WidgetSection testIds each widget renders (read from source). The
// notification inbox is not a ranked tile: it renders inline on the home column,
// outside the WidgetHost.
export const TODOS_TESTID = "chat-widget-todos";

// First-run runtime/provider buttons live in the real chat transcript. The
// headless conductor seeds the ChoiceWidgets and the chat action channel routes
// their sentinel values before they hit the server.
export const RUNTIME_CHOICE = (id: "cloud" | "local" | "remote"): string =>
  `choice-__first_run__:runtime:${id}`;
export const PROVIDER_CHOICE = (
  id: "on-device" | "elizacloud" | "other",
): string => `choice-__first_run__:provider:${id}`;
export const TUTORIAL_CHOICE = (id: "start" | "skip"): string =>
  `choice-__first_run__:tutorial:${id}`;
const CLOUD_AGENT_CHOICE = (id: string): string =>
  `choice-__first_run__:cloud-agent:${id}`;

// The removed full-screen onboarding surface used these testIds. Asserting they
// never appear proves the new flow is genuinely chat-first (no startup gate, no
// FirstRunChat surface) — onboarding paints the home + the real chat overlay.
const REMOVED_ONBOARDING_TESTIDS = [
  "first-run-chat",
  "first-run-greeting",
  "startup-first-run-background",
];

/**
 * Assert the FIRST painted surface of a fresh profile is the real app shell plus
 * the real chat overlay with in-transcript first-run choices — and that NONE of
 * the removed full-screen onboarding testIds exist.
 */
export async function expectChatFirstOnboarding(page: Page): Promise<Locator> {
  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  // The removed full-screen onboarding gate must be absent.
  for (const testId of REMOVED_ONBOARDING_TESTIDS) {
    await expect(
      page.getByTestId(testId),
      `removed onboarding surface ${testId} must not render (flow is chat-first)`,
    ).toHaveCount(0);
  }
  await expect(page.getByTestId(RUNTIME_CHOICE("cloud"))).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId(RUNTIME_CHOICE("local"))).toBeVisible();
  await expect(page.getByTestId(RUNTIME_CHOICE("remote"))).toBeVisible();
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);

  // Onboarding surface (#12178): the composer stays enabled so a user can answer
  // the in-chat conductor naturally. Attachments, voice, and ordinary agent
  // sends remain gated by the first-run controller; the active sheet preserves
  // the wallpaper and remains non-dismissable at its half detent.
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute("placeholder", "Hey Eliza…");
  await expect(composer).toHaveAttribute(
    "aria-describedby",
    "cc-first-run-hint",
  );
  await expect(page.getByTestId("chat-first-run-backdrop")).toHaveCount(0);
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  // A gated Escape flips nothing; give a real collapse ample time to (not)
  // land so this negative assertion cannot false-pass on timing.
  await page.waitForTimeout(300);
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    "half",
  );
  return chatOverlay;
}

/**
 * Assert the overlay settled on the completion edge: the moment
 * firstRunComplete flips, the transcript opens at the FULL detent for the
 * completion turn and the composer unlocks.
 */
export async function expectOnboardingSettleToFull(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    "full",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled({
    timeout: 15_000,
  });
}

/**
 * Dismiss the post-onboarding permission-priming modal (#12331) if it appears.
 * It arms on the completion edge and sits over the home, so it must be skipped
 * (the real "Skip for now" path a user takes) before asserting or swiping the
 * home surface. Tolerant: absence is fine — the shown-once flag or platform
 * gating can keep it away.
 */
export async function dismissPermissionPrimingIfShown(
  page: Page,
): Promise<void> {
  const skipAll = page.getByTestId("priming-skip-all");
  const appeared = await skipAll
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(
      () => true,
      () => false,
    );
  if (!appeared) return;
  await skipAll.click();
  await expect(page.getByTestId("permission-priming-modal")).toHaveCount(0, {
    timeout: 10_000,
  });
}

/**
 * The post-completion chat state depends on the tutorial pick: "skip" lands on
 * the auto-collapsed sheet (home revealed), while "start" launches the
 * chat-native tour, which re-opens the chat to show its seeded welcome turn.
 * Either way the composer must be unlocked.
 */
async function expectPostOnboardingChat(
  page: Page,
  tutorial: "start" | "skip",
): Promise<void> {
  if (tutorial === "skip") {
    await expectOnboardingSettleToFull(page);
    return;
  }
  await expect(page.getByTestId("chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled({
    timeout: 15_000,
  });
}

/** Assert the kept sparse-home widgets render with their seeded data. */
async function expectPopulatedHome(page: Page): Promise<Locator> {
  const host = page.getByTestId("widget-host-home");
  await expect(host).toBeVisible({ timeout: 30_000 });
  await expect(
    host.getByTestId(TODOS_TESTID),
    "home Todos widget should render with seeded task data",
  ).toBeVisible({ timeout: 30_000 });
  await expect(host.getByTestId(TODOS_TESTID)).toContainText(
    "Ship the release",
  );
  for (const testId of [
    "chat-widget-finances-alerts",
    "chat-widget-relationships",
    "chat-widget-inbox-unread",
  ]) {
    await expect(host.getByTestId(testId)).toHaveCount(0);
  }
  // The seeded urgent notification renders in the INLINE notification inbox on
  // the home column, not as a ranked WidgetHost tile. Local first-run can land
  // on home before inbox hydrate paints the center (the center returns null
  // until `hydrated || hasNotifications`). home-widget-priority.spec.ts covers
  // the same row on a completed first-run landing; assert the copy here only
  // when the center actually mounts.
  const notificationCenter = page.getByTestId("home-notification-center");
  const centerMounted = await notificationCenter
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (centerMounted) {
    await expect(
      notificationCenter.getByTestId("notification-row"),
    ).toContainText("Payment failed");
  }
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toHaveAttribute("data-page", "home");
  return surface;
}

/**
 * Drive the tutorial-or-skip CHOICE — the SINGLE real completion gate. The
 * conductor defers the store's `completeFirstRun` until this pick, so it is
 * reachable after EVERY runtime path. Picking either option flips
 * firstRunComplete and lands on "chat" (the home). `start` additionally launches
 * the interactive tutorial spotlight; `skip` lands straight on the home.
 */
async function pickTutorial(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  choice: "start" | "skip",
): Promise<void> {
  const start = page.getByTestId(TUTORIAL_CHOICE("start"));
  const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
  await expect(start).toBeVisible({ timeout: 30_000 });
  await expect(skip).toBeVisible();
  await click(choice === "start" ? start : skip);
}

/**
 * Drive first-run to completion via Local → on-device inference →
 * tutorial-or-skip, then assert the post-onboarding HOME inside the same shell
 * and floating chat overlay we use everywhere else. This is the keyless path
 * that calls completeFirstRun("chat") without a cloud sign-in.
 */
export async function completeOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" } = {
    state: { firstRunPosts: [] },
  },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  // 1) The chat transcript owns runtime/provider setup; no removed full-screen gate exists.
  await expectChatFirstOnboarding(page);

  // 2) Local runtime → on-device ("all-local") provider.
  const local = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(local).toBeEnabled({ timeout: 15_000 });
  await click(local);

  const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
  await expect(onDevice).toBeVisible({ timeout: 15_000 });
  await click(onDevice);

  // 3) Provisioning posts first-run, then the conductor offers the tutorial.
  await pickTutorial(page, click, tutorial);

  // 4) Landing is the HOME: with "skip" the sheet auto-collapses on the
  // completion edge (revealing the home); with "start" the chat-native tour
  // re-opens it over the home. The composer unlocks either way and the home
  // widget host renders its seeded cards.
  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectPostOnboardingChat(page, tutorial);
  await dismissPermissionPrimingIfShown(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  // 5) The local finish persisted first-run exactly once (the single
  // persistFirstRun funnel), even though the tutorial step ran afterwards.
  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the local path",
  ).toBe(1);

  return { surface };
}

/**
 * Drive first-run to completion via the CLOUD runtime. #15339 made the Cloud
 * pick a single sign-in: picking Cloud runs the headless connect+provision flow
 * (`startCloudProvisionFlow` → `listOrAutoProvisionCloudAgent` → `bindCloudAgent`
 * with `forceCreate:false`), which AUTO-BINDS the best healthy agent — the
 * in-transcript Eliza Cloud OAuth card (`sensitive_request_form`) and the
 * cloud-agent picker CHOICE were both removed with the old flow. The pre-seeded
 * steward token (`injectCloudAuthToken`) makes `handleCloudLogin` short-circuit
 * (no external OAuth window resolves), and the account's one running agent
 * (`installCloudRoutes`) whose bridge is this page origin is bound directly. The
 * bound base is an app-shell base, so the cloud finish persists first-run exactly
 * once — same contract as Local — and then offers the tutorial. Requires
 * `installCloudRoutes` + `injectCloudAuthToken`.
 */
export async function completeCloudOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  // 1) Pick the Cloud runtime — the single sign-in gesture. No in-transcript
  // OAuth card and no agent picker render; the conductor connects + auto-binds
  // the best healthy agent at the network boundary, then offers the tutorial.
  const cloud = page.getByTestId(RUNTIME_CHOICE("cloud"));
  await expect(cloud).toBeEnabled({ timeout: 15_000 });
  await click(cloud);

  // 2) Binding completed → the tutorial CHOICE is the deterministic waypoint
  // (its arrival proves connect + provision + bind succeeded). Pick it → land on
  // the home (sheet settles to half).
  await pickTutorial(page, click, tutorial);

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectPostOnboardingChat(page, tutorial);
  await dismissPermissionPrimingIfShown(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  // #19511: the personal Eliza is account-native; cloud onboarding completes
  // without writing a local first-run profile.
  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must not fire for the cloud path",
  ).toBe(0);

  return { surface };
}

// ── Cloud-only onboarding (#13377) — the production default ─────────────────
//
// With the runtime chooser OFF (explicit override, or a production build with
// no VITE_ELIZA_ENABLE_RUNTIME_CHOOSER build flag) onboarding is a single
// "Sign in to Eliza Cloud" step: the greeting seeds ONE choice button, a
// usable stored session skips the ask entirely, and provisioning success
// completes first-run for real — no tutorial/accent completion gate.

/** Assert the cloud-only greeting: one sign-in button, no local/remote. */
export async function expectCloudOnlySignInOnboarding(
  page: Page,
): Promise<void> {
  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 30_000 });
  // Cloud-only greeting (#13377): the conductor seeds the greeting and sign-in
  // prompt as two normal chat turns, followed by the single cloud CTA. The
  // overlay's matching fallback turns cover the pre-seed race.
  await expect(page.getByText("Hi, I'm Eliza.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText("Let's get you signed in.", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(RUNTIME_CHOICE("cloud"))).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId(RUNTIME_CHOICE("local"))).toHaveCount(0);
  await expect(page.getByTestId(RUNTIME_CHOICE("remote"))).toHaveCount(0);
  // The chooser-mode greeting question must not exist.
  await expect(
    page.getByText("where should your agent run?", { exact: false }),
  ).toHaveCount(0);
  // Same onboarding surface contract as chooser mode (#15339): sign-in-first
  // locked composer and non-dismissable half-height sheet without a separate
  // full-screen backdrop.
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Sign in to get started",
  );
  await expect(page.getByTestId("chat-first-run-backdrop")).toHaveCount(0);
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
}

/** Post-completion contract shared by every cloud-only path: the real gate
 *  flipped at provisioning success (no tutorial/accent gate), the wrap-up turn
 *  is informational, and first-run persisted once. */
async function expectCloudOnlyCompletion(
  page: Page,
  state: OnboardingRouteState,
  expectedDetent: "full" | "collapsed" = "full",
): Promise<{ surface: Locator }> {
  // Completion fires at provisioning success and returns the user to the home
  // surface. An interactive sign-in retains the completed turn at full height;
  // silent session restoration may close it immediately. Both are completed,
  // unlocked home states. The durable contract is asserted on that settle, the onboarded
  // home, the absent tutorial gate, and the exactly-once POST. The wrap-up copy
  // is covered by the conductor unit suite.
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    expectedDetent,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled({
    timeout: 15_000,
  });
  await dismissPermissionPrimingIfShown(page);
  await expect(page.getByTestId(TUTORIAL_CHOICE("start"))).toHaveCount(0);
  await expect(page.getByTestId(TUTORIAL_CHOICE("skip"))).toHaveCount(0);
  const surface = await expectPopulatedHome(page);
  // #19511: account-native identity; no local first-run profile write.
  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must not fire for cloud-only onboarding",
  ).toBe(0);
  return { surface };
}

/**
 * Drive cloud-only onboarding via the sign-in tap: greeting → the session
 * lands during the (mocked) login the tap launches → silent provision → home.
 * Zero-agent lane only: seeding the token in-page also arms the conductor's
 * token poll, so a picker lane here would race two legitimate provision flows
 * and seed duplicate picker widgets — the picker is covered by the injection
 * flow below instead.
 */
export async function completeCloudOnlyOnboardingToHome(
  page: Page,
  opts: { state: OnboardingRouteState },
): Promise<{ surface: Locator }> {
  await expectCloudOnlySignInOnboarding(page);

  // The session token lands as the login flow the tap launches completes
  // (mocked at the storage boundary — same token the poll mock returns).
  // Seeding it also arms the conductor's 500ms token poll, which can win the
  // race and complete onboarding BEFORE the tap lands — the button then sits
  // in a settling sheet and never reads "stable". Bound the click and let the
  // completion assertions carry the contract either way.
  await setStewardSession(page, { token: CLOUD_AUTH_TOKEN });
  try {
    await page
      .getByTestId(RUNTIME_CHOICE("cloud"))
      .first()
      .click({ timeout: 8_000 });
  } catch {
    // The token poll already completed onboarding — nothing left to tap.
  }

  return expectCloudOnlyCompletion(page, opts.state);
}

/**
 * Session injection: a usable stored session at boot skips the sign-in ask
 * entirely — zero interactions from fresh boot to the onboarded home. #15133
 * made this a SILENT entry: a usable token present at mount
 * (`hasUsableStoredStewardToken()` is true for the seeded opaque token) enters
 * without seeding ANY onboarding turn — no sign-in greeting AND no welcome-back
 * (the "Welcome back" turn is the token-poll UPGRADE path, only reached when a
 * greeting was shown first and a token lands later). With existing cloud agents
 * the first is auto-adopted (#13377): the agent picker must never appear.
 */
export async function completeCloudOnlySessionInjectionToHome(
  page: Page,
  opts: { state: OnboardingRouteState },
): Promise<{ surface: Locator }> {
  // The sign-in ask never rendered — silent entry seeds no runtime CTA.
  await expect(page.getByTestId(RUNTIME_CHOICE("cloud"))).toHaveCount(0);

  const result = await expectCloudOnlyCompletion(page, opts.state, "collapsed");
  // The picker never appeared at any point in the flow.
  await expect(
    page.getByTestId(CLOUD_AGENT_CHOICE(CLOUD_AGENT_ID)),
  ).toHaveCount(0);
  return result;
}

export async function completeCloudInferenceOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  const local = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(local).toBeEnabled({ timeout: 15_000 });
  await click(local);

  const cloudInference = page.getByTestId(PROVIDER_CHOICE("elizacloud"));
  await expect(cloudInference).toBeVisible({ timeout: 15_000 });
  await click(cloudInference);

  await pickTutorial(page, click, tutorial);

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectPostOnboardingChat(page, tutorial);
  await dismissPermissionPrimingIfShown(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the cloud-inference local path",
  ).toBe(1);

  return { surface };
}

export async function completeOtherProviderSettingsHandoff(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  // "Other / configure in Settings" is a PROVIDER sub-choice under the LOCAL
  // runtime (the old top-level runtime:other was renamed/removed when the
  // chooser became cloud/local/remote), so reach it via local → provider:other.
  const localRuntime = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(localRuntime).toBeVisible({ timeout: 15_000 });
  await click(localRuntime);

  const otherProvider = page.getByTestId(PROVIDER_CHOICE("other"));
  await expect(otherProvider).toBeVisible({ timeout: 15_000 });
  await click(otherProvider);

  await pickTutorial(page, click, tutorial);

  // The Other/configure-later path ships no floating "choose a provider" banner
  // (removed with ActionBanner). At the onboarding-completion moment the composer
  // is simply unlocked and ready ("Ask …") — the "connect a provider in Settings"
  // placeholder is a SEND-TIME state (noProviderConfigured =
  // latestAssistantNoProvider && canRespond===false; see useShellController),
  // reached only after a send hits the in-transcript no-provider gate, which the
  // shell unit suite covers. Assert the removed banner never renders and the
  // composer has unlocked out of the sign-in-first lock.
  await expect(
    page.getByText("Choose a model provider in Settings before sending", {
      exact: false,
    }),
  ).toHaveCount(0);
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await expect(composer).not.toHaveAttribute(
    "placeholder",
    "Sign in to start chatting",
  );

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectPostOnboardingChat(page, tutorial);
  await dismissPermissionPrimingIfShown(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the Other/settings handoff path",
  ).toBe(1);

  return { surface };
}

export async function connectRemoteFirstRunToHome(
  page: Page,
  opts: { state: OnboardingRouteState; apiBase?: string },
): Promise<{ surface: Locator; activeServer: string | null }> {
  const { state } = opts;

  await expectChatFirstOnboarding(page);

  // The device starts unconfigured, but the adopted host is already ready.
  // Switch this endpoint before connecting; adoption must not configure it again.
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, { complete: true, cloudProvisioned: false });
  });

  const apiBase =
    opts.apiBase ??
    (await page.evaluate(() => window.location.origin.toString()));

  await page.evaluate((gatewayUrl) => {
    document.dispatchEvent(
      new CustomEvent("eliza:connect", {
        detail: {
          gatewayUrl,
          completeFirstRun: true,
          skipConfirm: true,
        },
      }),
    );
  }, apiBase);

  // Remote adoption opens the completed conversation at full height. Reveal
  // Home through the normal dismissal gesture before checking its contents.
  await expectOnboardingSettleToFull(page);
  await dismissPermissionPrimingIfShown(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    "collapsed",
  );
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await expect(surface).toHaveAttribute("data-page", "home");
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("first-run-runtime-chooser")).toBeHidden({
    timeout: 15_000,
  });

  const firstRunComplete = await page.evaluate(() =>
    localStorage.getItem("eliza:first-run-complete"),
  );
  expect(
    firstRunComplete,
    "remote adoption must persist local completion",
  ).toBe("1");

  expect(
    state.firstRunPosts.length,
    "adopting a configured remote must not submit first-run setup",
  ).toBe(0);

  const activeServer = await page.evaluate(() =>
    localStorage.getItem("elizaos:active-server"),
  );
  expect(activeServer, "remote active-server persisted").toBeTruthy();
  expect(activeServer).toContain('"kind":"remote"');

  return { surface, activeServer };
}

/**
 * Collapse the floating ChatOverlay back to its composer-only resting
 * state if it happens to be open. The overlay AUTO-COLLAPSES on the onboarding
 * completion edge, so post-onboarding this is normally a no-op guard (the
 * early-return below); it still handles a sheet a test deliberately opened.
 * Escape is the overlay's own keydown contract ONLY once onboarding is
 * complete — during onboarding Escape is gated (see expectChatFirstOnboarding's
 * negative assertion), so never call this mid-onboarding.
 */
export async function collapseChatOverlay(page: Page): Promise<void> {
  const overlay = page.getByTestId("chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 15_000 });
  if ((await overlay.getAttribute("data-open")) !== "true") return;
  await page.keyboard.press("Escape");
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
}

/**
 * Collapse onboarding chrome, then drive the shared Home/Launcher rail through
 * the same real input path used by the other app interaction specs.
 */
export async function openPostOnboardingLauncher(
  page: Page,
  options: { input?: "mouse" | "touch" | "auto" } = {},
): Promise<void> {
  // Post-onboarding the overlay already auto-collapsed; this guard only closes
  // a sheet a previous step deliberately opened, so the rail receives the
  // gesture. Permission priming can arm on the same edge and intercept it.
  await dismissPermissionPrimingIfShown(page);
  await collapseChatOverlay(page);
  const grid = await navigateHomeLauncher(page, "launcher", options);
  await expect(grid.getByTestId("launcher-tile-settings")).toBeVisible({
    timeout: 15_000,
  });
}
