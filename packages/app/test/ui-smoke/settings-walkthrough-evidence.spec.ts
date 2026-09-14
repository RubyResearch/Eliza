/** Records real Settings section navigation at desktop and mobile sizes using deterministic API fixtures. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`settings section walkthrough at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/settings");
    await openSettingsSection(page, "Voice");
    await expect(
      page.getByRole("heading", { name: "Voice selection", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("settings-voice.png"),
      fullPage: true,
    });
    await openSettingsSection(page, "General");
    await expect(page.getByTestId("background-catalog-gallery")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("settings-general.png"),
      fullPage: true,
    });
  });
}
