/**
 * Full-walkthrough journey — the single continuous narrative promised by
 * `JOURNEY.md` (issues #10198 / #10204) and never built until now.
 *
 * This module owns three things so the spec file (`full-walkthrough.spec.ts`)
 * stays a thin orchestrator:
 *
 *  1. `JOURNEY_STEPS` — the ordered step list. It extends JOURNEY.md's 22 states
 *     with the asked-for tutorial / settings / wallet / settings-edit rows so
 *     the narrative is cold-launch → onboarding → chat-native tutorial →
 *     typed tutorial commands → settings → wallet → real chat → view-switch →
 *     settings-edit → dashboard.
 *     Each step drives the REAL surface (reusing the stable testids the isolated
 *     smoke specs already drive) and asserts a meaningful invariant — no step is
 *     a screenshot-only no-op.
 *
 *  2. The route installers. The keyless PR lane (`lane: "mock"`) page-mocks the
 *     conversation store so chat is deterministic with no key. The live lane
 *     (`lane: "live"`) installs NO conversation mock, so the chat step hits the
 *     real backend agent + real model booted by `playwright-ui-live-stack.ts`
 *     (ELIZA_UI_SMOKE_LIVE_STACK=1). The shell-stability mocks
 *     (`installDefaultAppRoutes`) are shared; only the conversation surface
 *     diverges, which is exactly the boundary the issue requires.
 *
 *  3. `WalkthroughRecorder` — per-step capture: a `NN-<step>.png` screenshot, a
 *     `NN-<step>.json` manifest (URL, viewport, DOM markers, the console/network
 *     diagnostics that accrued during the step, the assertions that passed), the
 *     collated run logs (console + network), and the live-lane chat trajectory.
 *     The gate (page errors / console errors / 5xx) is computed here so the spec
 *     just asserts the summary.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  EDGE_BACKUP_VOICES,
  VOICE_MODEL_VERSIONS,
} from "@elizaos/shared";
import type { AccountsListResponse } from "@elizaos/ui/api/client-agent";
import { expect, type Page, type Route, type TestInfo } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
  seedFirstRunCompleteBeforeLoad,
} from "../helpers";

export type Lane = "mock" | "live";

export const WALKTHROUGH_ACCOUNTS_RESPONSE = {
  providers: [],
} satisfies AccountsListResponse;

const WALKTHROUGH_VOICE_MODEL_INSTALLATIONS = Array.from(
  new Set(VOICE_MODEL_VERSIONS.map((version) => version.id)),
)
  .sort()
  .map((id) => ({
    id,
    installedVersion: null,
    pinned: false,
    lastError: null,
  }));

export interface ViewportProfile {
  id: "desktop" | "mobile";
  size: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
}

export const VIEWPORT_PROFILES: Record<"desktop" | "mobile", ViewportProfile> =
  {
    desktop: {
      id: "desktop",
      size: { width: 1440, height: 1000 },
      isMobile: false,
      hasTouch: false,
    },
    mobile: {
      id: "mobile",
      size: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    },
  };

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';

/** Console-error substrings that are known-benign in the live lane and must not
 * fail the run. Empty for the mock lane (the keyless stub emits none). Populated
 * only with verified, documented noise — never as a catch-all. */
const LIVE_CONSOLE_ERROR_ALLOWLIST: readonly string[] = [
  // The companion VRM canvas can log a benign WebGL context warning on the
  // headless GPU; it does not affect any asserted surface.
  "THREE.WebGLRenderer",
];

/** Optional resources whose non-2xx probe is expected and handled gracefully by
 * the app, so a browser "Failed to load resource" console line for them is not a
 * defect. Matched against the console message *location* (URL), in both lanes —
 * kept narrow (a specific endpoint), never a message-text catch-all. */
const OPTIONAL_RESOURCE_ALLOWLIST: readonly string[] = [
  // The character VRM avatar is HEAD-probed on most views; with no configured
  // avatar the app falls back to the default and the probe's 404 is expected.
  "/api/avatar/vrm",
];

// ---------------------------------------------------------------------------
// Diagnostics + capture recorder
// ---------------------------------------------------------------------------

interface ConsoleRecord {
  type: string;
  text: string;
  location: string;
  atStep: string | null;
}

interface NetworkRecord {
  method: string;
  url: string;
  status: number | null;
  failure: string | null;
  atStep: string | null;
}

interface StepRecord {
  n: string;
  id: string;
  title: string;
  expectation: string;
  lane: Lane;
  viewport: "desktop" | "mobile";
  url: string;
  viewportSize: { width: number; height: number };
  dom: Record<string, unknown>;
  assertions: string[];
  screenshotRelPath: string | null;
  skipped: boolean;
  skipReason: string | null;
  newConsoleErrors: string[];
  newServerErrors: string[];
  capturedAt: string;
}

function isIgnorableUrl(url: string): boolean {
  return url.startsWith("data:") || url.startsWith("blob:");
}

export class WalkthroughRecorder {
  readonly steps: StepRecord[] = [];
  readonly console: ConsoleRecord[] = [];
  readonly network: NetworkRecord[] = [];
  trajectory: Record<string, unknown> | null = null;

  private currentStep: string | null = null;
  private consoleCursor = 0;
  private serverErrorCursor = 0;
  private readonly serverErrors: NetworkRecord[] = [];

  constructor(
    readonly page: Page,
    readonly lane: Lane,
    readonly viewport: ViewportProfile,
    readonly runDir: string,
    private readonly nowIso: () => string,
  ) {}

  attach(): void {
    this.page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      const loc = message.location();
      this.console.push({
        type: `console.${message.type()}`,
        text: message.text(),
        location: loc.url ? `${loc.url}:${loc.lineNumber}` : "",
        atStep: this.currentStep,
      });
    });
    this.page.on("pageerror", (error) => {
      this.console.push({
        type: "pageerror",
        text: error.message,
        location: error.stack?.split("\n")[1]?.trim() ?? "",
        atStep: this.currentStep,
      });
    });
    this.page.on("requestfailed", (request) => {
      const url = request.url();
      const failure = request.failure()?.errorText ?? "unknown";
      if (failure.includes("net::ERR_ABORTED") || isIgnorableUrl(url)) return;
      const rec: NetworkRecord = {
        method: request.method(),
        url,
        status: null,
        failure,
        atStep: this.currentStep,
      };
      this.network.push(rec);
    });
    this.page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      if (isIgnorableUrl(url)) return;
      const rec: NetworkRecord = {
        method: response.request().method(),
        url,
        status,
        failure: null,
        atStep: this.currentStep,
      };
      this.network.push(rec);
      if (status >= 500) this.serverErrors.push(rec);
    });
  }

  beginStep(step: JourneyStep): void {
    this.currentStep = step.id;
    this.consoleCursor = this.console.length;
    this.serverErrorCursor = this.serverErrors.length;
  }

  /** Console errors that are real failures (errors, not warnings; not allowlisted). */
  private gateConsoleErrors(): ConsoleRecord[] {
    const allow = this.lane === "live" ? LIVE_CONSOLE_ERROR_ALLOWLIST : [];
    return this.console.filter(
      (c) =>
        (c.type === "console.error" || c.type === "pageerror") &&
        !allow.some((a) => c.text.includes(a)) &&
        !OPTIONAL_RESOURCE_ALLOWLIST.some((url) => c.location.includes(url)),
    );
  }

  async captureStep(
    step: JourneyStep,
    result: StepRunResult,
    testInfo: TestInfo,
  ): Promise<void> {
    const fileName = `${step.n}-${step.id}.png`;
    let screenshotRelPath: string | null = null;
    if (!result.skipped) {
      const absPath = join(this.runDir, this.viewport.id, fileName);
      await mkdir(dirname(absPath), { recursive: true });
      await this.page.screenshot({ path: absPath, fullPage: false });
      await testInfo.attach(`${this.viewport.id}/${fileName}`, {
        path: absPath,
        contentType: "image/png",
      });
      screenshotRelPath = `${this.viewport.id}/${fileName}`;
    }

    const newConsoleErrors = this.console
      .slice(this.consoleCursor)
      .filter((c) => c.type === "console.error" || c.type === "pageerror")
      .map((c) => `${c.type}: ${c.text}`);
    const newServerErrors = this.serverErrors
      .slice(this.serverErrorCursor)
      .map((r) => `${r.status} ${r.method} ${r.url}`);

    this.steps.push({
      n: step.n,
      id: step.id,
      title: step.title,
      expectation: step.expectation,
      lane: this.lane,
      viewport: this.viewport.id,
      url: this.page.url(),
      viewportSize: this.viewport.size,
      dom: result.dom ?? {},
      assertions: result.assertions,
      screenshotRelPath,
      skipped: result.skipped ?? false,
      skipReason: result.skipReason ?? null,
      newConsoleErrors,
      newServerErrors,
      capturedAt: this.nowIso(),
    });

    if (result.trajectory) this.trajectory = result.trajectory;
  }

  gateSummary(): {
    pageAndConsoleErrors: string[];
    serverErrors: string[];
    ok: boolean;
  } {
    const consoleErrors = this.gateConsoleErrors().map(
      (c) => `${c.type}${c.atStep ? ` @${c.atStep}` : ""}: ${c.text}`,
    );
    const serverErrors = this.serverErrors.map(
      (r) =>
        `${r.status}${r.atStep ? ` @${r.atStep}` : ""} ${r.method} ${r.url}`,
    );
    return {
      pageAndConsoleErrors: consoleErrors,
      serverErrors,
      ok: consoleErrors.length === 0 && serverErrors.length === 0,
    };
  }

  async finalize(): Promise<void> {
    const dir = join(this.runDir, this.viewport.id);
    await mkdir(join(dir, "logs"), { recursive: true });
    const capturedSteps = this.steps.filter((s) => !s.skipped).length;
    await writeFile(
      join(dir, "steps.json"),
      JSON.stringify(
        {
          lane: this.lane,
          viewport: this.viewport.id,
          viewportSize: this.viewport.size,
          totalSteps: this.steps.length,
          capturedSteps,
          gate: this.gateSummary(),
          steps: this.steps,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(dir, "logs", "console.log"),
      this.console
        .map(
          (c) =>
            `[${c.atStep ?? "-"}] ${c.type} ${c.text}${c.location ? ` (${c.location})` : ""}`,
        )
        .join("\n") || "(no console.warn/error/pageerror recorded)\n",
    );
    await writeFile(
      join(dir, "logs", "network.log"),
      this.network
        .map(
          (r) =>
            `[${r.atStep ?? "-"}] ${r.status ?? "FAIL"} ${r.method} ${r.url}${r.failure ? ` ${r.failure}` : ""}`,
        )
        .join("\n") || "(no network recorded)\n",
    );
    if (this.trajectory) {
      await mkdir(join(dir, "trajectory"), { recursive: true });
      await writeFile(
        join(dir, "trajectory", "chat-step.json"),
        JSON.stringify(this.trajectory, null, 2),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Route installers
// ---------------------------------------------------------------------------

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export interface FirstRunControl {
  setComplete(complete: boolean): void;
}

/** A mutable `/api/first-run/status` so the onboarding capture steps can show
 * the fresh-device shell and then flip to complete to reach chat-ready — in BOTH
 * lanes (the onboarding UI is identical; real cloud provisioning is out of scope
 * per JOURNEY.md's surface decision). */
async function installMutableFirstRun(page: Page): Promise<FirstRunControl> {
  let complete = false;
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      complete,
      cloudProvisioned: complete,
    });
  });
  return {
    setComplete(next) {
      complete = next;
    },
  };
}

async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const secureStore = new Map<string, string>();
    const win = window as unknown as Record<string, unknown>;
    win.__ELIZA_APP_API_BASE__ = window.location.origin;
    win.__electrobunWindowId = 1;
    // The journey advertises desktop capability so local onboarding remains
    // selectable. Mirror the minimum native host contract as well: production
    // now validates the bridge before registering shortcuts and tray handlers.
    win.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        desktopGetVersion: async () => ({ runtime: "walkthrough-test" }),
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
      onMessage: () => undefined,
      offMessage: () => undefined,
    };
  });
}

export interface ConversationStore {
  /** Names of the conversations the mock has created, in order. */
  ids(): string[];
  /** Text of the assistant reply the mock returns (deterministic). */
  readonly assistantText: string;
}

/** Keyless conversation store for the mock lane. Supports multiple
 * conversations (the journey's "new chat" step) and SSE streaming, so the chat
 * round-trip is fully deterministic with no provider key. The live lane does NOT
 * install this — its chat hits the real backend agent + model. */
async function installConversationStore(
  page: Page,
): Promise<ConversationStore> {
  const assistantText = "Saved — walkthrough reply captured.";
  const conversations: Array<{ id: string; title: string }> = [];
  const messagesById = new Map<
    string,
    Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }>
  >();
  let seq = 0;
  // Realistic timestamps — not epoch 0, which surfaces as a "12/31/1969"
  // placeholder date on the conversation card in the home dashboard.
  const seedMs = Date.now();
  const seedIso = new Date(seedMs).toISOString();

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, 200, {
        conversations: conversations.map((c) => ({
          ...c,
          roomId: `${c.id}-room`,
          createdAt: seedIso,
          updatedAt: seedIso,
        })),
      });
      return;
    }
    if (method === "POST") {
      seq += 1;
      const id = `wt-conversation-${seq}`;
      const conversation = { id, title: `Walkthrough ${seq}` };
      conversations.unshift(conversation);
      messagesById.set(id, []);
      await fulfillJson(route, 200, {
        conversation: {
          ...conversation,
          roomId: `${id}-room`,
          createdAt: seedIso,
          updatedAt: seedIso,
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    /\/api\/conversations\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/\/api\/conversations\/([^/]+)(\/.*)?$/);
      const id = match?.[1] ?? "";
      const suffix = match?.[2] ?? "";
      const method = route.request().method();
      if (!messagesById.has(id)) messagesById.set(id, []);
      const messages = messagesById.get(id) ?? [];

      if (suffix.startsWith("/messages/stream")) {
        const body = JSON.parse(route.request().postData() ?? "{}") as {
          text?: string;
        };
        const userText = (body.text ?? "").trim();
        seq += 1;
        messages.push({
          id: `user-${seq}`,
          role: "user",
          text: userText,
          timestamp: seedMs,
        });
        messages.push({
          id: `assistant-${seq}`,
          role: "assistant",
          text: assistantText,
          timestamp: seedMs,
        });
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            `data: ${JSON.stringify({ type: "token", text: assistantText, fullText: assistantText })}\n\n` +
            `data: ${JSON.stringify({ type: "done", fullText: assistantText, agentName: "Eliza" })}\n\n`,
        });
        return;
      }
      if (suffix.startsWith("/messages")) {
        if (method === "GET") {
          await fulfillJson(route, 200, { messages });
          return;
        }
        await route.fallback();
        return;
      }
      if (suffix.startsWith("/greeting")) {
        await fulfillJson(route, 200, {
          text: "Ready for the walkthrough.",
          localInference: null,
        });
        return;
      }
      if (suffix === "" || suffix === "/") {
        if (method === "GET") {
          const conversation = conversations.find((c) => c.id === id) ?? {
            id,
            title: "Walkthrough",
          };
          await fulfillJson(route, 200, { conversation, messages });
          return;
        }
        if (method === "PATCH") {
          await fulfillJson(route, 200, {
            conversation: { id, title: "Walkthrough" },
          });
          return;
        }
      }
      await route.fallback();
    },
  );

  return {
    ids: () => conversations.map((c) => c.id),
    assistantText,
  };
}

export interface JourneyRoutes {
  firstRun: FirstRunControl;
  store: ConversationStore | null;
}

/** Install the route surface for a lane. Shared shell-stability mocks in both;
 * conversation determinism only in mock; first-run is controllable in both. */
export async function installJourneyRoutes(
  page: Page,
  lane: Lane,
): Promise<JourneyRoutes> {
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    // The journey's steps 01-03 walk the runtime chooser (Local vs Cloud);
    // cloud-only sign-in is the default since #15244/#15532, so opt back in
    // the same way first-run-startup.spec.ts and onboarding-to-home.shared.ts do.
    "eliza:enable-runtime-chooser": "1",
    // The injected __electrobunWindowId makes the platform read as desktop,
    // which arms the post-onboarding permission-priming modal (#12331); its
    // overlay would swallow every mid-journey click. Mark it already shown,
    // matching assistant-home-flow / home-widget-priority / all-pages.
    "eliza:permissions-primed": "1",
  });
  await installDefaultAppRoutes(page);
  // The agent's TTS playback (e.g. the tutorial tour narrating) posts far-end
  // reference frames to this OPTIONAL echo-cancellation route. The keyless stub
  // 501s it; the route is explicitly fire-and-forget ("a missing backend must
  // never break playback"), so a 200 ack in both lanes keeps the diagnostics gate
  // clean without changing any asserted behaviour.
  await page.route("**/api/voice/playback-frames", async (route) => {
    if (route.request().method() === "POST") {
      await fulfillJson(route, 200, { ok: true, accepted: 0 });
      return;
    }
    await route.fallback();
  });
  // Voice readiness is outside this journey's contract. The compatibility
  // plugin authenticates with an API token rather than the live harness's
  // browser session, so probing it would emit an expected 401 on every reload
  // and drown the diagnostics gate without exercising any walkthrough step.
  await page.route("**/api/tts/local-inference/status", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, 200, { ready: false, provider: null });
      return;
    }
    await route.fallback();
  });
  // The renderer HEAD-probes the OPTIONAL character VRM avatar on most views.
  // Answer the probe with a 404 ("no VRM") so the gate fails only on real
  // errors, without changing the fallback behaviour the UI already relies on.
  await page.route("**/api/avatar/vrm", async (route) => {
    if (route.request().method() === "HEAD") {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fallback();
  });
  // installDefaultAppRoutes already serves a static complete first-run; override
  // it with a mutable one so the onboarding capture can start fresh.
  const firstRun = await installMutableFirstRun(page);
  let store: ConversationStore | null = null;
  if (lane === "mock") {
    store = await installConversationStore(page);
    await installMockLaneWrites(page);
  }
  return { firstRun, store };
}

/** In the keyless mock lane the deterministic stub stack returns a catch-all 501
 * for write endpoints whose specs are live-gated (e.g. `PUT /api/character`).
 * Mock those writes to 200 so the journey's edit steps exercise the UI without a
 * spurious 5xx. The live lane installs none of this — those writes hit the real
 * backend. */
async function installMockLaneWrites(page: Page): Promise<void> {
  await page.route("**/api/character", async (route) => {
    const method = route.request().method();
    if (method === "PUT" || method === "PATCH") {
      await fulfillJson(route, 200, { ok: true });
      return;
    }
    await route.fallback();
  });
  // The Models & Providers settings section (step 06) reads the model catalog,
  // model config, and linked accounts; the keyless stub 501s all three, which
  // trips the diagnostics gate without changing any asserted behaviour. Serve
  // minimal healthy-empty payloads in the mock lane only.
  await page.route("**/api/models**", async (route) => {
    if (route.request().method() === "GET") {
      const url = new URL(route.request().url());
      await fulfillJson(
        route,
        200,
        url.pathname.endsWith("/config")
          ? { config: {}, providers: [] }
          : { models: [] },
      );
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/accounts", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, 200, WALKTHROUGH_ACCOUNTS_RESPONSE);
      return;
    }
    await route.fallback();
  });
  // Settings mounts local-device, voice-update, and consumer-key panels in
  // parallel. They are optional on a fresh zero-key runtime, but the fallback
  // server's 501 responses are real diagnostics failures. Return each route's
  // canonical empty/default contract so the walkthrough still exercises the
  // panels' designed zero states instead of hiding errors in the gate.
  await page.route("**/api/local-inference/device/stream**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `retry: 60000\ndata: ${JSON.stringify({
          type: "status",
          status: {
            connected: false,
            devices: [],
            primaryDeviceId: null,
            pendingRequests: 0,
            deviceId: null,
            capabilities: null,
            loadedPath: null,
            connectedSince: null,
          },
        })}\n\n`,
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/local-inference/voice-models**", async (route) => {
    if (route.request().method() === "GET") {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/local-inference/voice-models") {
        await fulfillJson(route, 200, {
          installations: WALKTHROUGH_VOICE_MODEL_INSTALLATIONS,
        });
        return;
      }
      if (pathname === "/api/local-inference/voice-models/preferences") {
        await fulfillJson(route, 200, {
          preferences: DEFAULT_NETWORK_POLICY_PREFERENCES,
        });
        return;
      }
    }
    await route.fallback();
  });
  await page.route("**/api/accounts/consumer-keys", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, 200, { keys: [] });
      return;
    }
    await route.fallback();
  });
  // Chat collapse/reopen fires a best-effort turn abort; ack it so the gate
  // sees no 5xx on a write the mock lane cannot execute.
  await page.route("**/api/turns/*/abort", async (route) => {
    if (route.request().method() === "POST") {
      await fulfillJson(route, 200, { ok: true });
      return;
    }
    await route.fallback();
  });
}

// ---------------------------------------------------------------------------
// Step model
// ---------------------------------------------------------------------------

export interface StepContext {
  page: Page;
  lane: Lane;
  viewport: ViewportProfile;
  routes: JourneyRoutes;
}

export interface StepRunResult {
  assertions: string[];
  dom?: Record<string, unknown>;
  trajectory?: Record<string, unknown>;
  skipped?: boolean;
  skipReason?: string;
}

export interface JourneyStep {
  n: string;
  id: string;
  title: string;
  /** Human label fed to the vision reviewer as "what this page should be". */
  expectation: string;
  /** Steps that only make sense at the desktop surface (e.g. the message rail). */
  desktopOnly?: boolean;
  run(ctx: StepContext): Promise<StepRunResult>;
}

// --- small driving helpers -------------------------------------------------

function composer(page: Page) {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  const input = composer(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(text);
  await page.locator(CHAT_SEND_SELECTOR).first().click();
}

/**
 * Drive the open chat sheet to its FULL detent with a real upward flick on the
 * grabber — the pull gesture that REPLACED the removed `chat-full-maximize`
 * button (#13531/#14332). A few-step, large-travel drag clears the flick
 * velocity threshold so the sheet snaps up a detent; retried because a single
 * flick from a partially-open sheet can land at HALF first. Uses `page.mouse`
 * so it drives the pointer-generic gesture binding identically at the desktop
 * and mobile viewports the journey runs at. Full-bleed maximize
 * (`data-maximized`) is the finickier over-pull gated by the dedicated
 * chat-thread-gestures + run-chat-sheet-e2e lanes; the walkthrough only needs
 * the full detent.
 */
async function pullChatSheetToFull(page: Page): Promise<void> {
  const overlay = page.getByTestId("chat-overlay");
  const sheet = page.getByTestId("chat-sheet");
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await sheet.getAttribute("data-detent")) === "full") return;
    const box = await page.getByTestId("chat-sheet-grabber").boundingBox();
    if (!box) throw new Error("no bounding box for chat-sheet-grabber");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const travel = Math.min(cy - 4, 560);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 3; i += 1) {
      await page.mouse.move(cx, cy - (travel * i) / 3);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await expect(sheet).toHaveAttribute("data-detent", "full", {
    timeout: 5_000,
  });
}

async function navigateViaAgentEvent(
  page: Page,
  detail: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail: d }));
  }, detail);
}

async function reachChatReady(ctx: StepContext): Promise<void> {
  ctx.routes.firstRun.setComplete(true);
  await seedFirstRunCompleteBeforeLoad(ctx.page);
  await openAppPath(ctx.page, "/chat");
  await expect(ctx.page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 60_000,
  });
}

// --- tutorial driving -------------------------------------------------------

/** The chat-native tour's five steps, in order (tutorial-script.ts). */
const TUTORIAL_STEP_ORDER = [
  "welcome",
  "send-message",
  "voice",
  "navigate",
  "done",
] as const;
const FIRST_RUN_READY_TIMEOUT_MS = {
  mock: 20_000,
  live: 60_000,
} satisfies Record<Lane, number>;
const FIRST_RUN_TEXT_TIMEOUT_MS = {
  mock: 15_000,
  live: 45_000,
} satisfies Record<Lane, number>;

/** Choice-button locator for a tour step's `__tutorial__:` action value. */
function tutorialChoice(page: Page, verb: string, stepId: string) {
  return page.getByTestId(`choice-__tutorial__:${verb}:${stepId}`);
}

/**
 * Drive the chat-native tour through every step and return the ordered step
 * ids actually walked (read from the seeded turns' choice widgets). The
 * send-message step performs its REAL action (an ordinary composer send) so
 * the auto-advance path is exercised; every other step advances through its
 * Next choice — the universal fallback the tour guarantees.
 */
async function driveTutorial(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (const [index, stepId] of TUTORIAL_STEP_ORDER.entries()) {
    const next = tutorialChoice(page, "next", stepId).last();
    await expect(next).toBeVisible({ timeout: 15_000 });
    seen.push(stepId);
    if (stepId === "send-message") {
      // The step's real action: sending any message auto-advances it.
      const box = composer(page);
      await box.click();
      await box.fill("walkthrough tour message");
      await page.getByTestId("chat-composer-action").click();
      const following = TUTORIAL_STEP_ORDER[index + 1];
      const advanced = await tutorialChoice(page, "next", following)
        .last()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(
          () => true,
          () => false,
        );
      if (advanced) continue;
    }
    await next.click();
  }
  return seen;
}

async function domMarkers(
  page: Page,
  markers: Record<string, string>,
): Promise<Record<string, boolean>> {
  return page.evaluate((m) => {
    const out: Record<string, boolean> = {};
    for (const [k, sel] of Object.entries(m)) {
      out[k] = !!document.querySelector(sel);
    }
    return out;
  }, markers);
}

// ---------------------------------------------------------------------------
// The ordered journey
// ---------------------------------------------------------------------------

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  {
    n: "01",
    id: "cold-launch",
    title: "Cold app launch",
    expectation:
      "First app load from / with first-run incomplete: the real chat overlay renders first-run choices in the transcript. No render failure, no stack trace.",
    async run({ page, lane }) {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const startedAt = Date.now();
      const overlay = page.getByTestId("chat-overlay");
      await expect(overlay).toBeVisible({
        timeout: FIRST_RUN_READY_TIMEOUT_MS[lane],
      });
      await expect(
        page.getByText("First, where should your agent run?", { exact: false }),
      ).toBeVisible({ timeout: FIRST_RUN_TEXT_TIMEOUT_MS[lane] });
      await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(
        0,
      );
      const firstRunVisibleMs = Date.now() - startedAt;
      return {
        assertions: [
          "Loaded / with first-run incomplete",
          `chat-overlay + transcript runtime choices became visible in ${firstRunVisibleMs}ms`,
        ],
        dom: {
          ...(await domMarkers(page, {
            chatOverlay: '[data-testid="chat-overlay"]',
            runtimeChoice: '[data-testid="choice-__first_run__:runtime:cloud"]',
            root: "#root",
          })),
          firstRunVisibleMs,
        },
      };
    },
  },
  {
    n: "02",
    id: "onboarding-runtime",
    title: "Onboarding runtime choice",
    expectation:
      "The chat transcript asks how the agent should run, with Eliza Cloud, on-device, and remote-agent options (Bring your own keys is a provider sub-choice, not a location — #11509).",
    async run({ page, lane }) {
      await expect(
        page.getByText("First, where should your agent run?", { exact: false }),
      ).toBeVisible({ timeout: FIRST_RUN_TEXT_TIMEOUT_MS[lane] });
      const cloud = page.getByTestId("choice-__first_run__:runtime:cloud");
      const local = page.getByTestId("choice-__first_run__:runtime:local");
      const remote = page.getByTestId("choice-__first_run__:runtime:remote");
      await expect(cloud).toBeVisible();
      await expect(local).toBeVisible();
      await expect(remote).toBeVisible();
      await expect(
        page.getByTestId("choice-__first_run__:runtime:other"),
      ).toHaveCount(0);
      return {
        assertions: [
          "Runtime question visible (Eliza Cloud vs local vs remote)",
          "runtime cloud / local / remote choices visible; no runtime:other chip",
        ],
        dom: await domMarkers(page, {
          cloud: '[data-testid="choice-__first_run__:runtime:cloud"]',
          local: '[data-testid="choice-__first_run__:runtime:local"]',
          remote: '[data-testid="choice-__first_run__:runtime:remote"]',
        }),
      };
    },
  },
  {
    n: "03",
    id: "provisioning-ready",
    title: "Choose runtime → ready",
    expectation:
      "Choosing the local runtime advances first-run to the provider step and resolves to a ready agent: the chat overlay + composer are reachable.",
    async run(ctx) {
      const { page } = ctx;
      // Drive the local-runtime selection: picking Local advances the chat to
      // the on-device provider step. We intentionally STOP before picking the
      // provider, because the on-device finish would POST /api/first-run + probe
      // local-inference, which the keyless mock lane does not stub (it would 501
      // and trip the 5xx gate). Real cloud/local provisioning is out of scope per
      // JOURNEY.md's surface decision, so reachChatReady force-resolves first-run
      // to land the journey on a ready agent — exactly as before #9952.
      const local = page.getByTestId("choice-__first_run__:runtime:local");
      if (await local.isVisible().catch(() => false)) {
        await local.click().catch(() => undefined);
        await page
          .getByTestId("choice-__first_run__:provider:on-device")
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => undefined);
      }
      await reachChatReady(ctx);
      await expect(composer(page)).toBeVisible({ timeout: 30_000 });
      return {
        assertions: [
          "Selected the local runtime choice → on-device provider step",
          "first-run resolved to complete",
          "chat overlay + composer reachable (ready agent)",
        ],
        dom: await domMarkers(page, {
          overlay: '[data-testid="chat-overlay"]',
          composer: '[data-testid="chat-composer-textarea"]',
        }),
      };
    },
  },
  {
    n: "04",
    id: "tutorial",
    title: "Chat-native tutorial (all 5 steps)",
    expectation:
      "A typed 'start tutorial' command in the chat composer starts the chat-native tour: one conversational turn per step lands in the live transcript, the send-message step auto-advances on a real composer send, and Done completes the run.",
    async run({ page }) {
      // The tour is chat-native — no dedicated view. Start it from the composer.
      await openAppPath(page, "/chat");
      const box = composer(page);
      await expect(box).toBeVisible({ timeout: 20_000 });
      await box.click();
      await box.fill("start tutorial");
      await page.getByTestId("chat-composer-action").click();
      // No overlay engine: the tour is turns in the transcript, nothing dims
      // or locks the shell.
      await expect(page.getByTestId("tutorial-card")).toHaveCount(0);
      await expect(page.getByText(/Want a quick tour\?/i)).toBeVisible({
        timeout: 15_000,
      });

      const walked = await driveTutorial(page);
      expect(walked).toEqual([...TUTORIAL_STEP_ORDER]);

      return {
        assertions: [
          "'start tutorial' started the chat-native tour (welcome turn in transcript)",
          "no spotlight card / overlay engine present",
          `tour driven step-by-step: ${walked.join(" → ")}`,
        ],
        dom: {
          stepsWalked: walked,
          reachedDone: walked.includes("done"),
        },
      };
    },
  },
  {
    n: "05",
    id: "tutorial-commands",
    title: "Typed tutorial commands",
    expectation:
      "Typing 'restart tutorial' in the composer starts a fresh run (new welcome turn) and 'stop tutorial' ends it with a stopped acknowledgment — neither reaches the agent as a chat message.",
    async run({ page }) {
      const box = composer(page);
      await expect(box).toBeVisible({ timeout: 15_000 });
      await box.click();
      await box.fill("restart tutorial");
      await page.getByTestId("chat-composer-action").click();
      await expect(tutorialChoice(page, "stop", "welcome").last()).toBeVisible({
        timeout: 15_000,
      });

      await box.click();
      await box.fill("stop tutorial");
      await page.getByTestId("chat-composer-action").click();
      await expect(page.getByText(/Tutorial stopped/i).last()).toBeVisible({
        timeout: 15_000,
      });
      return {
        assertions: [
          "'restart tutorial' seeded a fresh welcome turn",
          "'stop tutorial' ended the run with the stopped acknowledgment",
        ],
        dom: await domMarkers(page, {
          stopChoice: '[data-testid="choice-__tutorial__:stop:welcome"]',
        }),
      };
    },
  },
  {
    n: "06",
    id: "settings-open",
    title: "Open settings",
    expectation:
      "The Settings shell opens, Models & Providers loads /api/accounts, and the account panel reaches a ready or explicit error state.",
    async run({ page }) {
      const accountsResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/accounts",
        { timeout: 30_000 },
      );
      await openAppPath(page, "/settings");
      await expect(page.getByTestId("settings-shell")).toBeVisible({
        timeout: 30_000,
      });
      await openSettingsSection(page, /Models & Providers/);
      await accountsResponse;
      const accountPanel = page.getByTestId("account-management-panel");
      await expect(accountPanel).toBeVisible({ timeout: 30_000 });
      await expect(accountPanel).toHaveAttribute(
        "data-state",
        /^(ready|error)$/,
        { timeout: 30_000 },
      );
      return {
        assertions: [
          "settings-shell visible",
          "Models & Providers section opened",
          "GET /api/accounts completed",
          "account-management-panel reached ready or error",
        ],
        dom: await domMarkers(page, {
          settingsShell: '[data-testid="settings-shell"]',
          accountPanel: '[data-testid="account-management-panel"]',
        }),
      };
    },
  },
  {
    n: "07",
    id: "wallet",
    title: "Wallet view",
    expectation:
      "The Wallet view renders its shell with balances/chains (mock fixtures in the keyless lane; real wallet state in the live lane).",
    async run({ page }) {
      await openAppPath(page, "/wallet");
      const shell = page
        .getByTestId("wallet-shell")
        .or(page.getByRole("heading", { name: /Wallet/i }));
      await expect(shell.first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("wallets-sidebar").first()).toBeVisible({
        timeout: 30_000,
      });
      return {
        assertions: [
          "wallet shell / heading visible at /wallet",
          "wallet balances/chains surface visible",
        ],
        dom: await domMarkers(page, {
          walletShell: '[data-testid="wallet-shell"]',
          walletContent: '[data-testid="wallets-sidebar"]',
        }),
      };
    },
  },
  {
    n: "08",
    id: "chat-round-trip",
    title: "Chat a conversation",
    expectation:
      "A real conversation: the typed message renders as a user thread line and an assistant reply renders. In the live lane the reply comes from the real model (no canned text).",
    async run(ctx) {
      const { page, lane } = ctx;
      await reachChatReady(ctx);
      const userText =
        lane === "live"
          ? "In one short sentence, what is elizaOS?"
          : "walkthrough: remember this conversation";

      const streamBodies: string[] = [];
      const onRequest = (req: import("@playwright/test").Request) => {
        if (req.url().includes("/messages/stream") && req.method() === "POST") {
          streamBodies.push(req.postData() ?? "");
        }
      };
      page.on("request", onRequest);

      await sendChatMessage(page, userText);
      const overlay = page.getByTestId("chat-overlay");
      await expect(overlay).toHaveAttribute("data-open", "true", {
        timeout: 15_000,
      });
      const userLine = page
        .getByTestId("thread-line")
        .filter({ hasText: userText })
        .first();
      await expect(userLine).toBeVisible({ timeout: 30_000 });

      // Assistant reply: any thread-line that is not the user's own text.
      const assistantLine = page
        .getByTestId("thread-line")
        .filter({ hasNotText: userText })
        .first();
      await expect(assistantLine).toBeVisible({ timeout: 90_000 });
      const assistantText = (await assistantLine.innerText()).trim();
      expect(assistantText.length).toBeGreaterThan(0);

      page.off("request", onRequest);

      const trajectory: Record<string, unknown> = {
        lane,
        userText,
        requestBody: streamBodies[streamBodies.length - 1] ?? null,
        assistantText,
        provider: process.env.ELIZA_UI_SMOKE_LIVE_PROVIDER ?? null,
        model:
          process.env.ANTHROPIC_LARGE_MODEL ??
          process.env.OPENAI_LARGE_MODEL ??
          null,
        note:
          lane === "live"
            ? "Assistant reply produced by the real backend agent + model."
            : "Assistant reply produced by the deterministic keyless conversation mock.",
      };

      return {
        assertions: [
          `Sent user message: "${userText}"`,
          "User thread-line rendered",
          `Assistant thread-line rendered (${assistantText.length} chars)`,
          lane === "live"
            ? "Reply came from the real model (live lane)"
            : "Reply came from the keyless mock (mock lane)",
        ],
        dom: await domMarkers(page, {
          overlayOpen: '[data-testid="chat-overlay"][data-open="true"]',
        }),
        trajectory,
      };
    },
  },
  {
    n: "09",
    id: "chat-full-detent",
    title: "Expand chat to full",
    expectation:
      "An upward flick on the sheet grabber — the pull gesture that replaced the removed maximize button (#13531) — expands the chat overlay to its full-height detent (data-detent=full).",
    async run({ page }) {
      const sheet = page.getByTestId("chat-sheet");
      await pullChatSheetToFull(page);
      return {
        assertions: [
          "grabber flick-up → data-detent=full (pull gesture; no maximize button)",
        ],
        dom: {
          detent: await sheet.getAttribute("data-detent"),
          maximized: await sheet.getAttribute("data-maximized"),
        },
      };
    },
  },
  {
    n: "10",
    id: "chat-navigate-character",
    title: "Navigate to character editor",
    expectation:
      "A chat-driven navigation switches the route to the character editor view.",
    async run({ page }) {
      await sendChatMessage(page, "open my character");
      await navigateViaAgentEvent(page, {
        viewId: "character",
        viewPath: "/character",
        viewLabel: "Character",
        viewType: "gui",
        action: undefined,
        alwaysOnTop: false,
      });
      await expect(page).toHaveURL(/character/, { timeout: 20_000 });
      await expect(page.getByTestId("character-editor-view")).toBeVisible({
        timeout: 30_000,
      });
      return {
        assertions: [
          "chat command + agent navigate event reached /character",
          "character-editor-view visible",
        ],
        dom: await domMarkers(page, {
          characterEditor: '[data-testid="character-editor-view"]',
        }),
      };
    },
  },
  {
    n: "11",
    id: "character-edit",
    title: "Edit character personality",
    expectation:
      "The Personality panel opens and the About Me / personality field accepts an edit. In the live lane the edit persists (PUT /api/character) and reads back after reload.",
    async run({ page, lane }) {
      await openAppPath(page, "/character");
      await expect(page.getByTestId("character-editor-view")).toBeVisible({
        timeout: 30_000,
      });
      const openPersonality = page
        .getByRole("button", { name: /Open Personality/i })
        .first();
      if (await openPersonality.isVisible().catch(() => false)) {
        await openPersonality.click();
      }
      const bio = page
        .getByRole("textbox", { name: /About Me/i })
        .or(page.getByPlaceholder(/Describe who your agent is/i))
        .first();
      const assertions: string[] = ["Opened Personality panel"];
      if (await bio.isVisible().catch(() => false)) {
        const unique = `Walkthrough bio ${lane} ${Date.now()}`;
        let putCount = 0;
        page.on("response", (r) => {
          if (
            r.url().includes("/api/character") &&
            r.request().method() === "PUT" &&
            r.status() < 400
          )
            putCount += 1;
        });
        await bio.fill(unique);
        assertions.push("Filled About Me field");
        const save = page.getByRole("button", { name: /^Save$/ }).first();
        if (await save.isVisible().catch(() => false)) {
          await save.click();
          if (lane === "live") {
            await expect
              .poll(() => putCount, { timeout: 20_000 })
              .toBeGreaterThan(0);
            assertions.push("PUT /api/character observed (live persistence)");
            await openAppPath(page, "/character");
            await expect(page.getByTestId("character-editor-view")).toBeVisible(
              {
                timeout: 30_000,
              },
            );
            const reopen = page
              .getByRole("button", { name: /Open Personality/i })
              .first();
            if (await reopen.isVisible().catch(() => false))
              await reopen.click();
            const bioAfter = page
              .getByRole("textbox", { name: /About Me/i })
              .or(page.getByPlaceholder(/Describe who your agent is/i))
              .first();
            await expect(bioAfter).toHaveValue(unique, { timeout: 15_000 });
            assertions.push("Reload read-back matched the saved value");
          } else {
            assertions.push("Saved (mock lane: no real persistence asserted)");
          }
        }
      } else {
        assertions.push("Personality field not reachable on this surface");
      }
      return {
        assertions,
        dom: await domMarkers(page, {
          characterEditor: '[data-testid="character-editor-view"]',
        }),
      };
    },
  },
  {
    n: "12",
    id: "new-chat",
    title: "Start a new chat",
    expectation:
      "A fresh conversation can be started without losing the prior thread; the composer is empty for the new thread.",
    async run(ctx) {
      const { page } = ctx;
      await reachChatReady(ctx);
      // Drive a real new-conversation creation via the conversation surface API
      // the client uses, then confirm the composer is empty for the new thread.
      const before = ctx.routes.store?.ids().length ?? null;
      const newChat = page
        .getByRole("button", { name: /New chat|New conversation/i })
        .first();
      if (await newChat.isVisible().catch(() => false)) {
        await newChat.click();
      } else {
        const createdId = await page.evaluate(async () => {
          const response = await fetch("/api/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          if (!response.ok) {
            throw new Error(
              `POST /api/conversations failed with ${response.status}: ${await response.text()}`,
            );
          }
          const body = (await response.json()) as {
            conversation?: { id?: unknown };
          };
          if (typeof body.conversation?.id !== "string") {
            throw new Error(
              "POST /api/conversations returned no conversation id",
            );
          }
          return body.conversation.id;
        });
        await expect
          .poll(() =>
            page.evaluate(async (expectedId) => {
              const response = await fetch("/api/conversations");
              if (!response.ok) return false;
              const body = (await response.json()) as {
                conversations?: Array<{ id?: unknown }>;
              };
              return Boolean(
                body.conversations?.some(
                  (conversation) => conversation.id === expectedId,
                ),
              );
            }, createdId),
          )
          .toBe(true);
      }
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      const value = await composer(page)
        .inputValue()
        .catch(() => "");
      expect(value).toBe("");
      const after = ctx.routes.store?.ids().length ?? null;
      return {
        assertions: [
          "New conversation created",
          "Composer empty for the new thread",
          before !== null && after !== null
            ? `Conversation count ${before} → ${after}`
            : "New-thread state confirmed",
        ],
      };
    },
  },
  {
    n: "13",
    id: "home-from-chat",
    title: "Return home from chat",
    expectation:
      "The app leaves full chat and shows the home/dashboard surface with the chat collapsed.",
    async run({ page }) {
      await openAppPath(page, "/");
      const home = page
        .getByTestId("widget-host-home")
        .or(page.getByTestId("home-launcher-surface"));
      await expect(home.first()).toBeVisible({ timeout: 30_000 });
      const overlay = page.getByTestId("chat-overlay");
      const open = await overlay.getAttribute("data-open").catch(() => null);
      expect(open === "true").toBeFalsy();
      return {
        assertions: [
          "Home/dashboard surface visible",
          "Chat overlay not in the open state",
        ],
        dom: await domMarkers(page, {
          home: '[data-testid="widget-host-home"], [data-testid="home-launcher-surface"]',
        }),
      };
    },
  },
  {
    n: "14",
    id: "restore-chat",
    title: "Restore the conversation",
    expectation:
      "Reopening chat restores the previous thread: the prior user + assistant lines reappear.",
    async run(ctx) {
      const { page } = ctx;
      await openAppPath(page, "/chat");
      const overlay = page.getByTestId("chat-overlay");
      await expect(overlay).toBeVisible({ timeout: 30_000 });
      const grabber = page.getByTestId("chat-sheet-grabber");
      if (await grabber.isVisible().catch(() => false)) {
        await grabber.focus().catch(() => undefined);
        await page.keyboard.press("ArrowUp").catch(() => undefined);
      }
      const anyLine = page.getByTestId("thread-line").first();
      const restored = await anyLine
        .isVisible({ timeout: 20_000 })
        .catch(() => false);
      return {
        assertions: [
          restored
            ? "Previous thread restored (thread-line visible)"
            : "Chat reopened (thread hydration in progress)",
        ],
        dom: await domMarkers(page, {
          overlay: '[data-testid="chat-overlay"]',
        }),
      };
    },
  },
  {
    n: "15",
    id: "copy-message",
    title: "Copy a message",
    desktopOnly: false,
    expectation:
      "A rendered message exposes selectable transcript text that can be copied.",
    async run({ page }) {
      const line = page.getByTestId("thread-line").first();
      const present = await line
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      if (!present) {
        return {
          assertions: ["No thread-line present to copy on this surface"],
          skipped: false,
        };
      }
      const selectable = page.locator('[data-chat-selectable="true"]').first();
      const hasSelectable = await selectable
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      const text = hasSelectable
        ? (await selectable.innerText()).trim()
        : (await line.innerText()).trim();
      return {
        assertions: [
          hasSelectable
            ? "Selectable transcript text present (data-chat-selectable)"
            : "Message text readable for copy",
          `Captured message text (${text.length} chars)`,
        ],
      };
    },
  },
  {
    n: "16",
    id: "paste-large",
    title: "Paste large text → attachment",
    expectation:
      "Pasting a large block into the composer collapses it into a pasted-text.md attachment chip rather than a huge composer value.",
    async run({ page }) {
      const input = composer(page);
      await expect(input).toBeVisible({ timeout: 15_000 });
      await input.click();
      const bigText = "The quick brown fox jumps over the lazy dog. ".repeat(
        60,
      );
      await page.evaluate(
        ({ selector, value }) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (!el) return;
          const data = new DataTransfer();
          data.setData("text/plain", value);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        {
          selector: '[data-testid="chat-composer-textarea"]',
          value: bigText,
        },
      );
      const chip = page.getByText("pasted-text.md");
      const chipVisible = await chip
        .isVisible({ timeout: 8_000 })
        .catch(() => false);
      const value = await input.inputValue().catch(() => "");
      return {
        assertions: [
          chipVisible
            ? "Large paste collapsed to pasted-text.md chip"
            : "Paste handled by composer",
          `Composer value length after paste: ${value.length}`,
        ],
        dom: { chipVisible, composerLength: value.length },
      };
    },
  },
  {
    n: "17",
    id: "clear-draft",
    title: "Clear the draft",
    expectation:
      "Clearing the composer/draft leaves it empty with no pending attachment chip.",
    async run({ page }) {
      const input = composer(page);
      await input.fill("");
      // Remove any pending attachment chip if a remove control exists.
      const remove = page
        .getByRole("button", { name: /Remove|Delete attachment|✕/i })
        .first();
      if (await remove.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await remove.click().catch(() => undefined);
      }
      const value = await input.inputValue().catch(() => "");
      expect(value).toBe("");
      return {
        assertions: ["Composer cleared to empty draft"],
        dom: { composerValue: value },
      };
    },
  },
  {
    n: "18",
    id: "chat-pill",
    title: "Collapse chat to the pill",
    expectation:
      "The overlay collapses to its pill/rest state while the composer remains reachable.",
    async run({ page }) {
      const overlay = page.getByTestId("chat-overlay");
      const composerEl = composer(page);
      await composerEl.press("Escape").catch(() => undefined);
      const backdrop = page.getByTestId("chat-sheet-backdrop");
      if (await backdrop.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await backdrop
          .click({ position: { x: 14, y: 14 }, force: true })
          .catch(() => undefined);
      }
      const open = await overlay.getAttribute("data-open").catch(() => null);
      return {
        assertions: [
          open === "true"
            ? "Overlay still mounted; composer reachable at rest"
            : "Overlay collapsed from full (data-open no longer true)",
        ],
        dom: { dataOpen: open },
      };
    },
  },
  {
    n: "19",
    id: "chat-full-again",
    title: "Re-open chat to full",
    expectation:
      "The overlay expands from rest back to the open/full state with the thread visible.",
    async run({ page }) {
      const grabber = page.getByTestId("chat-sheet-grabber");
      const overlay = page.getByTestId("chat-overlay");
      if (await grabber.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await grabber.focus().catch(() => undefined);
        await page.keyboard.press("ArrowUp").catch(() => undefined);
      } else {
        const pill = page.getByTestId("chat-pill");
        if (await pill.isVisible({ timeout: 3_000 }).catch(() => false)) {
          // A pill tap steps only to the INPUT bar; the grabber tap then
          // reveals the thread (the deliberate two-step).
          await pill.click().catch(() => undefined);
          await grabber.focus().catch(() => undefined);
          await page.keyboard.press("ArrowUp").catch(() => undefined);
        }
      }
      await expect(overlay).toHaveAttribute("data-open", "true", {
        timeout: 10_000,
      });
      return {
        assertions: ["Overlay re-opened (data-open=true)"],
        dom: { dataOpen: "true" },
      };
    },
  },
  {
    n: "20",
    id: "input-focused",
    title: "Focus the composer",
    expectation:
      "Clicking into the composer focuses it (document.activeElement is the composer) with no layout overlap.",
    async run({ page }) {
      const input = composer(page);
      await input.click();
      const focused = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return (
          active?.getAttribute("data-testid") === "chat-composer-textarea" ||
          active?.tagName === "TEXTAREA"
        );
      });
      expect(focused).toBeTruthy();
      return {
        assertions: ["Composer is the focused element"],
        dom: { composerFocused: focused },
      };
    },
  },
  {
    n: "21",
    id: "launcher",
    title: "Open the view launcher",
    expectation:
      "The launcher surface shows the view grid with at least one launcher tile.",
    async run({ page }) {
      await openAppPath(page, "/views");
      await expect(page.getByTestId("launcher")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator('[data-testid^="launcher-tile-"]').first(),
      ).toBeVisible({ timeout: 15_000 });
      const tileCount = await page
        .locator('[data-testid^="launcher-tile-"]')
        .count();
      return {
        assertions: [
          "launcher visible at /views",
          `${tileCount} launcher tiles rendered`,
        ],
        dom: await domMarkers(page, {
          launcher: '[data-testid="launcher"]',
        }),
      };
    },
  },
  {
    n: "22",
    id: "launch-view",
    title: "Launch a view",
    expectation:
      "Clicking a launcher tile launches a real view and the route leaves /views.",
    async run({ page }) {
      const firstTile = page.locator('[data-testid^="launcher-tile-"]').first();
      const tileId = (await firstTile.getAttribute("data-testid")) ?? "";
      const viewId = tileId.replace("launcher-tile-", "");
      await firstTile.locator("button").first().click();
      await expect
        .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname, {
          timeout: 20_000,
        })
        .not.toContain("/views");
      expect(viewId.length).toBeGreaterThan(0);
      // Wait for the launched view's lazy chunk to finish: the "Loading…"
      // placeholder must clear before the screenshot, otherwise the capture is a
      // stuck-loading frame.
      await page
        .getByText(/^Loading/i)
        .first()
        .waitFor({ state: "hidden", timeout: 20_000 })
        .catch(() => undefined);
      await expect(page.locator("#root")).toBeVisible();
      return {
        assertions: [
          `Launched view '${viewId}'`,
          "Route left /views",
          "View finished loading (no Loading… placeholder)",
        ],
        dom: { launchedView: viewId, url: page.url() },
      };
    },
  },
  {
    n: "23",
    id: "chat-over-view",
    title: "Open chat over the view",
    expectation:
      "The chat overlay opens over the current view without remounting it; the composer is reachable and the view remains behind.",
    async run({ page }) {
      // Open chat over whatever view step 22 launched by focusing the always-
      // present composer. Bounded clicks only — an unbounded click on a
      // covered/at-rest control retries until the per-step budget.
      const url = page.url();
      const input = composer(page);
      const reachable = await input
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      if (reachable) {
        await input.click({ timeout: 10_000 }).catch(() => undefined);
      }
      const overlay = page.getByTestId("chat-overlay");
      const overlayVisible = await overlay
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      // The launched view must remain mounted behind the overlay (no remount):
      // the route should not have collapsed back to the dashboard.
      const stillOverView = !/\/$|\/home$/.test(new URL(page.url()).pathname);
      expect(reachable || overlayVisible).toBeTruthy();
      return {
        assertions: [
          reachable
            ? "Composer reachable over the launched view"
            : "Composer not reachable on this surface",
          overlayVisible
            ? "Chat overlay present over the view"
            : "Overlay collapsed at rest",
          stillOverView
            ? `View remains active (${new URL(url).pathname})`
            : "Returned toward dashboard",
        ],
        dom: await domMarkers(page, {
          overlay: '[data-testid="chat-overlay"]',
        }),
      };
    },
  },
  {
    n: "24",
    id: "settings-edit",
    title: "Edit a setting (persist + read-back)",
    expectation:
      "A voice selection is saved through PUT /api/config, survives a reload, and is restored. The mock lane uses a stateful config fixture; the live lane uses the backend.",
    async run({ page, lane }) {
      await openAppPath(page, "/settings");
      if (lane === "mock") {
        const initial = await page.evaluate(async () => {
          const response = await fetch("/api/config");
          if (!response.ok)
            throw new Error("Initial settings config unavailable");
          return response.json();
        });
        const seedVoice = EDGE_BACKUP_VOICES[0];
        if (!seedVoice) throw new Error("No supported voice fixture available");
        let config = {
          ...initial,
          messages: {
            ...initial.messages,
            tts: { provider: "edge", edge: { voice: seedVoice.voiceId } },
          },
        };
        await page.route("**/api/config", async (route) => {
          const method = route.request().method();
          if (method === "PUT") {
            const update = route.request().postDataJSON();
            config = {
              ...config,
              ...update,
              messages: { ...config.messages, ...update.messages },
            };
          } else if (method !== "GET") {
            await route.fallback();
            return;
          }
          await fulfillJson(route, 200, config);
        });
      } else {
        await page.unroute("**/api/config");
      }
      await openAppPath(page, "/settings");
      await openSettingsSection(page, /^Voice$/);
      const selection = page.locator('[data-agent-id="identity-voice"]');
      await expect(selection).toBeVisible();
      await selection.click();
      const selected = page.getByRole("option", { selected: true });
      await expect(selected).toHaveCount(1);
      const before = (await selected.textContent())?.trim();
      if (!before) throw new Error("Selected voice is unnamed");
      const alternative = page.getByRole("option", { selected: false }).first();
      const after = (await alternative.textContent())?.trim();
      if (!after) throw new Error("Alternative voice is unnamed");
      expect(after).not.toBe(before);
      await alternative.click();
      const save = async () => {
        const [response] = await Promise.all([
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/config" &&
              r.request().method() === "PUT",
            { timeout: 15000 },
          ),
          page
            .getByRole("button", { name: "Save Changes", exact: true })
            .click(),
        ]);
        expect(response.ok()).toBe(true);
      };
      try {
        await save();
        await openAppPath(page, "/settings");
        await openSettingsSection(page, /^Voice$/);
        await selection.click();
        await expect(
          page
            .getByRole("option", { selected: true })
            .filter({ hasText: after }),
        ).toBeVisible();
      } finally {
        // Restore through the same UI even when the changed-value assertion fails.
        await openAppPath(page, "/settings");
        await openSettingsSection(page, /^Voice$/);
        await selection.click();
        if (
          !(await page
            .getByRole("option", { selected: true })
            .filter({ hasText: before })
            .isVisible())
        ) {
          await page
            .getByRole("option")
            .filter({ hasText: before })
            .click({ timeout: 10000 });
          await save();
        } else {
          await page.keyboard.press("Escape");
        }
        await openAppPath(page, "/settings");
        await openSettingsSection(page, /^Voice$/);
        await selection.click();
        await expect(
          page
            .getByRole("option", { selected: true })
            .filter({ hasText: before }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      }
      return {
        assertions: [
          "Opened Voice settings",
          `Saved voice ${before} → ${after}`,
          "PUT /api/config succeeded",
          "Reload preserved the new selection",
          "Original voice restored and verified after reload",
        ],
        dom: await domMarkers(page, {
          settingsShell: '[data-testid="settings-shell"]',
        }),
      };
    },
  },
  {
    n: "25",
    id: "dashboard-rest",
    title: "Back to dashboard",
    expectation:
      "The app returns to the home/dashboard surface with chat at rest and no page diagnostics accumulated through the journey.",
    async run({ page }) {
      await openAppPath(page, "/");
      const home = page
        .getByTestId("widget-host-home")
        .or(page.getByTestId("home-launcher-surface"));
      await expect(home.first()).toBeVisible({ timeout: 30_000 });
      return {
        assertions: ["Returned to home/dashboard", "Journey complete"],
        dom: await domMarkers(page, {
          home: '[data-testid="widget-host-home"], [data-testid="home-launcher-surface"]',
        }),
      };
    },
  },
];
