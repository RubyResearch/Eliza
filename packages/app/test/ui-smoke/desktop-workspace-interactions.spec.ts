/** Exercises desktop diagnostic controls through the real renderer with a synthetic native host boundary. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";

test.beforeEach(async ({ page }) => {
  await installDesktopBridgeFixture(page);
  // The injected __electrobunWindowId makes the platform read as desktop,
  // which arms the permission-priming modal (#12331); its Radix focus trap
  // would swallow the console-filter fill below. Mark it already shown.
  await seedAppStorage(page, { "eliza:permissions-primed": "1" });
  await installDefaultAppRoutes(page);
});

test("desktop workspace: renders real controls and the console filter accepts input", async ({
  page,
}) => {
  await openAppPath(page, "/desktop");

  // Under the injected Electrobun runtime the real diagnostics control renders
  // (not the web-only fallback card).
  const refresh = page
    .locator(
      '[data-agent-id="desktop-refresh-diagnostics"], [data-testid="desktop-refresh-diagnostics"]',
    )
    .first();
  await expect(refresh).toBeVisible({ timeout: 60_000 });

  // The console filter is a client-side input — driving it needs no native RPC.
  const filter = page
    .locator(
      '[data-agent-id="desktop-console-filter"], [data-testid="desktop-console-filter"]',
    )
    .first();
  await expect(filter).toBeVisible({ timeout: 15_000 });
  await filter.fill("error");
  await expect(filter).toHaveValue("error");
});
