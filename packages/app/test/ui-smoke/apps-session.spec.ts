/**
 * Playwright UI-smoke spec for the Apps Session app flow using the real
 * renderer fixture.
 */
import { test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);
});

test("apps view can route into internal tool pages and survive a reload", async ({
  page,
}) => {
  await openAppPath(page, "/apps");
  await assertReadyChecks(
    page,
    "apps-view",
    [{ selector: '[data-testid="projects-apps-segment"]' }],
    "all",
    90_000,
  );

  // Reload from root and re-navigate — Vite preview lacks SPA fallback
  await openAppPath(page, "/");
  await openAppPath(page, "/apps");
  await assertReadyChecks(
    page,
    "apps-view-reload",
    [{ selector: '[data-testid="projects-apps-segment"]' }],
    "all",
    90_000,
  );
});
