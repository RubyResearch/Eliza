/**
 * Playwright UI-smoke spec for the Ui Smoke app flow using the real renderer
 * fixture.
 */
import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("chat, apps, and settings routes render through the real shell", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  // The chat tab now routes through the single global chat overlay
  // surface. The ready signal is the overlay plus the interactive composer.
  await assertReadyChecks(
    page,
    "chat shell",
    [
      {
        selector: '[data-testid="chat-overlay"]',
      },
      {
        selector:
          '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      },
    ],
    "all",
  );

  await openAppPath(page, "/apps");
  await expect(page).toHaveURL(/\/apps$/);
  // Bare /apps is a retired My Apps deep link (#17031): it lands on the
  // consolidated Projects surface with its Apps segment pre-selected; the
  // launcher grid lives at /views.
  await expect(page.getByTestId("projects-apps-segment")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "Create new app" }),
  ).toBeVisible();
  await expect(page.getByText("No apps installed yet")).toBeVisible();

  await openAppPath(page, "/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await openSettingsSection(page, /^Capabilities\b/);
  const capabilitiesSection = page.locator("#capabilities");
  await capabilitiesSection.scrollIntoViewIfNeeded();
  await expect(capabilitiesSection).toBeVisible();
  // The section wraps both an h1 section title and an h3 subsection of the same
  // name, so scope to the first match (section-rendered proof, not uniqueness).
  await expect(
    capabilitiesSection.getByText("Capabilities", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Computer Use" }),
  ).toBeVisible();
  await openSettingsSection(page, /^App Permissions\b/);
  await expect(page.locator("#app-permissions")).toBeVisible();
  await expect(
    page
      .locator("#app-permissions")
      .getByText("App Permissions", { exact: true })
      .first(),
  ).toBeVisible();
});
