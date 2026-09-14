/**
 * Exercises hosted logout through the real account menu and session teardown.
 * The hosted document is served from the local build and cloud HTTP responses
 * are deterministic fixtures, so the test never ends a live account session.
 */
import { writeFile } from "node:fs/promises";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { expect, test } from "@playwright/test";
import {
  CLOUD_AUDIT_DEDICATED_AGENT_ID,
  installCloudApiStubs,
  seedStewardToken,
} from "./helpers/cloud-audit-fixtures";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Hosted logout retains retry authority after a failure on ${viewport.name}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("The local renderer server URL is required");
    const origin = "https://cloud.eliza.app";
    const logs: string[] = [];
    page.on("console", (message) =>
      logs.push(`[console:${message.type()}] ${message.text()}`),
    );
    page.on("response", (response) =>
      logs.push(`[response] ${response.status()} ${response.url()}`),
    );
    page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
    await page.setViewportSize(viewport);
    await page.route(`${origin}/**`, async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(origin, baseURL),
      });
      await route.fulfill({ response });
    });
    await seedStewardToken(page, CLOUD_AUDIT_DEDICATED_AGENT_ID);
    await installCloudApiStubs(page);
    let failLogout = true;
    let requests = 0;
    await page.route("**/api/auth/logout", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      requests += 1;
      await route.fulfill(
        failLogout
          ? { status: 503, json: { error: "Logout temporarily unavailable" } }
          : { json: { ok: true } },
      );
    });
    await page.goto(`${origin}/cloud/agents`);
    const menu = page.getByRole("button", { name: /^Account menu/ });
    await expect(menu).toBeVisible({ timeout: 60_000 });
    await menu.click();
    const signOut = page.getByRole("menuitem", {
      name: "Sign out",
      exact: true,
    });
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-logout-rest.jpg`),
      fullPage: true,
    });
    await signOut.hover();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-logout-hover.jpg`),
      fullPage: true,
    });
    await signOut.click();
    await expect(
      page.getByText("Could not sign out safely. Please try again.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${origin}/cloud/agents`);
    expect(
      await page.evaluate(
        (key) => Boolean(localStorage.getItem(key)),
        STEWARD_TOKEN_KEY,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-logout-error.jpg`),
      fullPage: true,
    });
    failLogout = false;
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        STEWARD_TOKEN_KEY,
      ),
    ).toBeNull();
    expect(requests).toBe(2);
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-logout-complete.jpg`),
      fullPage: true,
    });
    const logPath = testInfo.outputPath(`${viewport.name}-console-network.log`);
    await writeFile(logPath, logs.join("\n"));
    await testInfo.attach("console and network", {
      path: logPath,
      contentType: "text/plain",
    });
    const video = page.video();
    await page.context().close();
    if (video) {
      const artifact = await saveBrowserVideoArtifact({
        video,
        testInfo,
        basename: `${viewport.name}-logout-retry`,
      });
      await testInfo.attach("logout retry walkthrough", {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
