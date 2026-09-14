/**
 * Playwright UI-smoke spec for the First Run Startup app flow using the real
 * renderer fixture.
 */
import { mkdir } from "node:fs/promises";
import {
  expect,
  type Page,
  type Route,
  type TestInfo,
  test,
} from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// first-run chat transcript rarely gets render-telemetry coverage. That surface
// is exactly where the agent-start render loop once froze onboarding, so this
// spec lands on it with the guard armed and drives the runtime selection that
// preceded the freeze.

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

async function captureFirstRunRestoreEvidence(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  if (!process.env.E2E_RECORD) return;
  const screenshotPath = testInfo.outputPath(
    "9963-first-run-restore-prompt.jpg",
  );
  await mkdir(testInfo.outputDir, { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    type: "jpeg",
    quality: 90,
    fullPage: false,
  });
  await testInfo.attach("first-run restore prompt", {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
  const video = page.video();
  if (!video) return;
  await page.close();
  const artifact = await saveBrowserVideoArtifact({
    video,
    testInfo,
    basename: "9963-first-run-restore-prompt",
  });
  await testInfo.attach("first-run restore prompt video", {
    path: artifact.path,
    contentType: artifact.contentType,
  });
}

// A full-capability host (real API base + Electrobun window marker) so the local
// finish path would be reachable; the in-chat conductor seeds the same two
// runtime choices (Cloud / On this device) regardless ("Bring your own keys" is
// a provider sub-choice, not a runtime location — removed as a chip in #11509).
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await installDesktopBridgeFixture(page);
  await page.addInitScript(() => {
    // Production onboarding is cloud-only by default. This smoke explicitly
    // exercises the retained developer-only local/remote chooser.
    window.localStorage.setItem("eliza:enable-runtime-chooser", "1");
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, unknown>).__ELIZAOS_APP_BOOT_CONFIG__ =
      { apiBase: window.location.origin };
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
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

test("in-chat first-run renders without a render loop and lets the runtime be chosen", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  // The removed full-screen onboarding gate must NOT render — proof the surface
  // is genuinely chat-first.
  for (const removed of [
    "first-run-chat",
    "first-run-greeting",
    "startup-first-run-background",
  ]) {
    await expect(page.getByTestId(removed)).toHaveCount(0);
  }

  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  const cloud = page.getByTestId("choice-__first_run__:runtime:cloud");
  const local = page.getByTestId("choice-__first_run__:runtime:local");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  // Remote (connect to an existing agent) is the third location chip.
  await expect(
    page.getByTestId("choice-__first_run__:runtime:remote"),
  ).toBeVisible();
  // The old runtime:other ("Bring your own keys") chip stays removed (#11509).
  await expect(
    page.getByTestId("choice-__first_run__:runtime:other"),
  ).toHaveCount(0);

  // Local advances to the provider step (on-device vs Eliza Cloud vs other) —
  // the re-render churn on the newer step that previously froze.
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

  await expectNoRenderTelemetryErrors(page, "in-chat first-run flow");
  await expect(chatOverlay).toBeVisible();
});

test("fresh first-run offers to restore an existing local backup before onboarding", async ({
  page,
}, testInfo) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  const restoreRequests: string[] = [];
  await page.route("**/api/backups**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/backups" && request.method() === "GET") {
      await fulfillJson(route, 200, {
        backups: [
          {
            fileName: "agent-2026-06-30.eliza-backup",
            path: "agent-2026-06-30.eliza-backup",
            createdAt: "2026-06-30T06:00:00.000Z",
            agentId: "agent-ui-smoke",
            stateSha256: "sha256-ui-smoke",
            sizeBytes: 2048,
          },
        ],
      });
      return;
    }
    if (
      url.pathname === "/api/backups/restore" &&
      request.method() === "POST"
    ) {
      restoreRequests.push(request.postData() ?? "");
      await fulfillJson(route, 200, {
        restored: true,
        requiresRestart: true,
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(
    chatOverlay.getByText("I found an existing local backup", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("choice-__first_run__:backup-restore:latest"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("choice-__first_run__:backup-restore:start-fresh"),
  ).toBeVisible();

  await page.getByTestId("choice-__first_run__:backup-restore:latest").click();
  await expect.poll(() => restoreRequests.length, { timeout: 15_000 }).toBe(1);
  expect(restoreRequests[0]).toContain("agent-2026-06-30.eliza-backup");
  await expect(
    chatOverlay.getByText("Backup restored", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  await expectNoRenderTelemetryErrors(
    page,
    "in-chat first-run local backup restore",
  );
  await captureFirstRunRestoreEvidence(page, testInfo);
});
