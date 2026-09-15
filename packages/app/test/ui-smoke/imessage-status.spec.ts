/**
 * Exercises the real connector detail renderer and HTTP status adapter with
 * controlled provider responses. Captures hosted/native guidance and refresh
 * failures without credentials, native permissions, or outbound messages.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`iMessage transport readiness and recovery ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedAppStorage(page, { "eliza:connectors:channelMode": "bot" });
    await installDefaultAppRoutes(page);
    await page.route("**/api/plugins", (route) =>
      route.fulfill({
        json: {
          plugins: [
            {
              id: "imessage",
              name: "iMessage",
              description: "Native or hosted iMessage",
              tags: ["social"],
              enabled: true,
              configured: true,
              envKey: null,
              category: "connector",
              source: "bundled",
              parameters: [],
              validationErrors: [],
              validationWarnings: [],
              isActive: true,
            },
          ],
        },
      }),
    );
    let state: "hosted" | "error" | "disconnected" | "native" = "hosted";
    await page.route("**/api/setup/imessage/status", (route) => {
      if (state === "error")
        return route.fulfill({
          status: 503,
          json: { error: "Provider status unavailable" },
        });
      return route.fulfill({
        json: {
          connector: "imessage",
          state: state === "disconnected" ? "idle" : "paired",
          detail: {
            available: true,
            connected: state !== "disconnected",
            transport: state === "native" ? "native" : "blooio",
            chatDbAvailable: false,
            sendOnly: state === "native",
            chatDbPath:
              state === "native"
                ? "/Users/example/Library/Messages/chat.db"
                : "",
            permissionAction:
              state === "native"
                ? {
                    type: "full_disk_access",
                    label: "Open Full Disk Access",
                    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
                    instructions: [
                      "Grant access to the host application, then refresh.",
                    ],
                  }
                : null,
            webhookPath:
              state === "native" ? null : "/api/imessage/webhook/blooio",
            channelId: state === "native" ? null : "synthetic-channel",
            reason: null,
          },
        },
      });
    });
    await openAppPath(page, "/settings");
    await openSettingsSection(page, /^Connectors\b/);
    await page
      .locator('[data-connector="imessage"]')
      .click({ timeout: 15_000 });
    const detail = page.getByTestId("connector-detail");
    await expect(
      detail.getByText(/iMessage is connected through Blooio/),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Open Full Disk Access" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("hosted.png"),
      fullPage: true,
    });
    const refresh = detail.getByRole("button", {
      name: "Refresh",
      exact: true,
    });
    await refresh.hover();
    await page.screenshot({
      path: testInfo.outputPath("hosted-hover.png"),
      fullPage: true,
    });
    state = "error";
    await refresh.click();
    await expect(
      detail.getByText("iMessage status unavailable."),
    ).toBeVisible();
    await expect(
      detail.getByText(/iMessage is connected through Blooio/),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("unavailable.png"),
      fullPage: true,
    });
    state = "disconnected";
    await refresh.click();
    await expect(
      detail.getByText(/Hosted iMessage is not connected/),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("disconnected.png"),
      fullPage: true,
    });
    state = "native";
    await refresh.click();
    await expect(
      detail.getByRole("button", { name: "Open Full Disk Access" }),
    ).toBeVisible();
    await expect(
      detail.getByText(/iMessage can send, but Eliza cannot read/),
    ).toBeVisible();
    await expect(detail.getByText(/Signed webhook:/)).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("native-permission.png"),
      fullPage: true,
    });
  });
}
