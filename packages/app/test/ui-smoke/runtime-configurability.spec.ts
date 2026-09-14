/**
 * Playwright UI-smoke spec for the Runtime Configurability app flow using the
 * real renderer fixture.
 */
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";

// "Local, Cloud, etc. all work out of the box and are successfully
// configurable." Runtime/provider setup now lives in the chat transcript:
// Cloud (Eliza Cloud managed) and Local (this device). "Bring your own keys" is
// NOT a runtime location — it is a provider sub-choice one step later
// (provider:other), reached after picking Local (removed as a runtime chip in
// #11509). This spec drives Local → provider to prove every runtime is reachable
// and configurable, not just displayed.

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

async function routeFirstRunIncomplete(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

// Pretend to be a host that owns its hardware AND injects a loopback backend —
// the shape every desktop / device shell presents to the renderer.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await installDesktopBridgeFixture(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, unknown>).__ELIZAOS_APP_BOOT_CONFIG__ =
      { apiBase: window.location.origin };
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

async function expectInChatFirstRun(page: Page): Promise<void> {
  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
}

test("in-chat first-run exposes cloud and local runtimes and Local is configurable", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    // This suite serves the production renderer bundle, so opt into the
    // retained local/remote paths explicitly. The Vite-development default is
    // exercised against `bun run dev` in the dev-smoke lane.
    "eliza:enable-runtime-chooser": "1",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expectInChatFirstRun(page);

  const cloud = page.getByTestId("choice-__first_run__:runtime:cloud");
  const local = page.getByTestId("choice-__first_run__:runtime:local");
  const remote = page.getByTestId("choice-__first_run__:runtime:remote");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  // Remote (connect to an existing agent by URL + token) is the third location.
  await expect(remote).toBeVisible();
  // The old runtime:other ("Bring your own keys") chip stays gone (#11509) — it
  // conflated the inference-provider axis with the location axis. BYOK lives
  // one step down as the provider sub-choice.
  await expect(
    page.getByTestId("choice-__first_run__:runtime:other"),
  ).toHaveCount(0);

  // Local is configurable: selecting it advances to the provider step,
  // where the on-device default, Eliza Cloud inference, and other are offered.
  await local.click();
  await expect(
    page.getByTestId("choice-__first_run__:provider:on-device"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("choice-__first_run__:provider:elizacloud"),
  ).toBeVisible();
  await expect(
    page.getByTestId("choice-__first_run__:provider:other"),
  ).toBeVisible();
  await expect(
    page.getByText("Which model provider should", { exact: false }),
  ).toBeVisible();

  await expectNoRenderTelemetryErrors(page, "runtime configurability");
  await expect(page.getByTestId("chat-overlay")).toBeVisible();
});

test("in-chat first-run survives browser back and forward while it churns", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    "eliza:enable-runtime-chooser": "1",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);

  // Churn navigation via the browser history; the in-chat first-run surface must
  // survive every transition without crashing or freezing (the conductor re-seeds
  // the greeting into the live transcript on each shell remount).
  await page.goto("/?runtime=first-run", { waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);

  await expectNoRenderTelemetryErrors(page, "runtime browser history");
});
