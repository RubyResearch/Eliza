/** Browser review and recovery contract over the built remote view with deterministic HTTP providers; no live account is disconnected. */
import { expect } from "@playwright/test";
import type { AccountHandoffChoices } from "../../../../plugins/plugin-personal-assistant/src/lifeops/account-handoff-review";
import type { AccountHandoffRecord } from "../../../../plugins/plugin-personal-assistant/src/lifeops/account-handoff-store";
import { googleHandoffFixture } from "../../../../plugins/plugin-personal-assistant/test/helpers/handoff-google";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { test } from "./helpers/viewport-video";
import { installRemoteConnectionsView } from "./remote-connections-fixture";

test.use({ video: "on", trace: "on" });

for (const width of [1280, 390]) {
  test.describe(`account handoff ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test(`saved account review and lost-response recovery at ${width}px`, async ({
      page,
    }, testInfo) => {
      const browserLog: Array<{ kind: string; text: string }> = [];
      page.on("console", (message) =>
        browserLog.push({ kind: message.type(), text: message.text() }),
      );
      page.on("pageerror", (error) =>
        browserLog.push({ kind: "pageerror", text: error.message }),
      );
      page.on("response", (response) => {
        if (response.url().includes("/api/lifeops/"))
          browserLog.push({
            kind: "http",
            text: `${response.status()} ${response.url()}`,
          });
      });
      await seedAppStorage(page, { "eliza:ui-accent": "orange" });
      await installDefaultAppRoutes(page);
      page.setDefaultTimeout(15_000);
      await page.route("**/api/permissions/calendar", (route) =>
        route.fulfill({
          json: {
            id: "calendar",
            status: "denied",
            lastChecked: Date.now(),
            canRequest: false,
            platform: "darwin",
          },
        }),
      );
      await installRemoteConnectionsView(page);
      const fixture = googleHandoffFixture();
      const account = (id: string, email: string) => ({
        ...fixture.status,
        identity: { email },
        grantedCapabilities: [
          "google.calendar.read",
          "google.calendar.write",
          "google.gmail.send",
        ],
        grant: {
          ...fixture.grant,
          identity: { email },
          id,
          connectorAccountId: id,
          identityEmail: email,
        },
      });
      let inventoryAvailable = false;
      await page.route("**/api/lifeops/connectors/google/status**", (route) => {
        if (!inventoryAvailable) {
          return route.fulfill({
            status: 503,
            json: { error: "Connection inventory is temporarily unavailable" },
          });
        }
        return route.fulfill({
          json: {
            accounts: [
              account("test-account", "test@example.test"),
              account("real-account", "real@example.test"),
            ],
          },
        });
      });
      const reviewSource = {
        grantId: "real-account",
        connectorAccountId: "real-account",
        calendarId: "school",
      };
      const calendar = {
        ...reviewSource,
        provider: "google",
        side: "owner",
        accountEmail: "real@example.test",
        summary: "School calendar",
        description: null,
        primary: false,
        accessRole: "owner",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: "America/New_York",
        selected: false,
        includeInFeed: false,
        selectionVersion: 0,
      };
      const entry = {
        link: {
          id: "pickup-link",
          localEventId: "pickup",
          connectorAccountId: "test-account",
          providerCalendarId: "old-school",
          providerEventId: "old-pickup",
          providerEtag: "etag-1",
          localRevision: 7,
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
        event: {
          id: "pickup",
          title: "Synthetic school pickup",
          startAt: "2026-10-01T19:00:00.000Z",
          endAt: "2026-10-01T19:30:00.000Z",
          description: "Synthetic owner calendar entry",
        },
      };
      await page.route("**/api/lifeops/calendar/calendars**", (route) =>
        route.fulfill({ json: { calendars: [calendar] } }),
      );
      await page.route(
        "**/api/lifeops/family-workflows/email-options",
        (route) =>
          route.fulfill({
            json: {
              options: {
                accounts: [
                  { grantId: "real-account", label: "real@example.test" },
                ],
                recipients: [
                  {
                    entityId: "self",
                    name: "Self",
                    address: "self@example.test",
                  },
                ],
              },
            },
          }),
      );
      await page.route("**/api/lifeops/calendar/sync-control", (route) =>
        route.fulfill({
          json: {
            revision: 0,
            paused: true,
            destination: null,
            pendingDispatch: null,
          },
        }),
      );
      let saved: AccountHandoffRecord | null = null;
      let advanceCalls = 0;
      let disconnectCalls = 0;
      page.on("request", (request) => {
        if (
          request.method() !== "GET" &&
          request.url().includes("/google/disconnect")
        )
          disconnectCalls++;
      });
      await page.route("**/api/lifeops/account-handoffs**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("retirement-candidates"))
          return route.fulfill({ json: { candidates: [] } });
        if (path.endsWith("calendar-entries"))
          return route.fulfill({ json: { entries: [entry] } });
        if (path.endsWith("/advance")) {
          advanceCalls++;
          const input = route.request().postDataJSON();
          if (!saved || input.expectedRevision !== saved.revision)
            return route.fulfill({
              status: 409,
              json: { error: "Refresh saved progress" },
            });
          saved = {
            ...saved,
            revision: saved.revision + 1,
            phase:
              advanceCalls === 1
                ? "pausing"
                : advanceCalls < 4
                  ? "applying_mappings"
                  : advanceCalls === 4
                    ? "verifying_replacement"
                    : "completed",
          };
          if (advanceCalls === 1)
            return route.fulfill({
              status: 503,
              json: { error: "Response lost. Refresh saved progress." },
            });
          return route.fulfill({ json: { handoff: saved } });
        }
        if (route.request().method() === "POST") {
          const choices: AccountHandoffChoices = route.request().postDataJSON();
          expect(choices).toMatchObject({
            previousGrantId: "test-account",
            replacementGrantId: "real-account",
            writeCalendarId: "school",
            readCalendarIds: ["school"],
            calendarLinks: [
              {
                linkId: "pickup-link",
                expectedUpdatedAt: entry.link.updatedAt,
                expectedLocalRevision: 7,
                disposition: "copy_to_replacement",
              },
            ],
            importedData: "retain",
            messageDestinations: [
              {
                channel: "email",
                connectorAccountId: "real-account",
                recipientId: "self@example.test",
                recipientEntityId: "self",
              },
            ],
          });
          saved = {
            operationId: choices.operationId,
            revision: 3,
            phase: "reviewed",
            receipt: {},
            review: {
              previous: {
                grantId: "test-account",
                connectorAccountId: "test-account",
                email: "test@example.test",
              },
              replacement: {
                grantId: "real-account",
                connectorAccountId: "real-account",
                email: "real@example.test",
              },
              readCalendars: [reviewSource],
              writeCalendar: reviewSource,
              calendarLinks: choices.calendarLinks,
              messageDestinations: choices.messageDestinations,
              importedData: choices.importedData,
              retireApprovalIds: [],
            },
          };
        }
        return route.fulfill({ json: { handoff: saved } });
      });
      await openAppPath(page, "/lifeops/connections");
      await expect(
        page.getByRole("heading", { name: "Connections are unavailable" }),
      ).toBeVisible();
      await expect(
        page.getByText("No Google account is connected."),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Continue to Google" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`inventory-error-${width}.png`),
      });
      await page.getByRole("button", { name: "Retry", exact: true }).hover();
      await page.screenshot({
        path: testInfo.outputPath(`inventory-error-hover-${width}.png`),
      });
      inventoryAvailable = true;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      const panel = page.getByRole("region", {
        name: "Switch from test to real accounts",
      });
      await panel
        .getByRole("button", { name: "Replace an account", exact: true })
        .click();
      await panel
        .getByLabel("Test account to disconnect")
        .selectOption("test-account");
      await panel
        .getByLabel("Real account to keep")
        .selectOption("real-account");
      await panel.getByRole("button", { name: "Load account details" }).click();
      await expect(
        panel.getByLabel("Verified monthly email recipient"),
      ).toBeVisible();
      await panel
        .getByLabel("Test account to disconnect")
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`choices-upper-${width}.png`),
        fullPage: true,
      });
      await panel
        .getByLabel("Previously imported email and calendar history")
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`choices-lower-${width}.png`),
        fullPage: true,
      });
      await panel
        .getByRole("checkbox", { name: "School calendar", exact: true })
        .check();
      const pickup = panel.getByRole("checkbox", {
        name: /Synthetic school pickup/,
      });
      await expect(pickup).toBeDisabled();
      await panel
        .getByLabel("New calendar events", { exact: true })
        .selectOption("school");
      await pickup.check();
      await panel
        .getByLabel("Verified monthly email recipient")
        .selectOption("self");
      await panel
        .getByRole("button", { name: "Save choices for review" })
        .click();
      const start = panel.getByRole("button", {
        name: "Start reviewed account switch",
      });
      await expect(start).toBeVisible();
      expect(advanceCalls).toBe(0);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`review-rest-${width}.png`),
      });
      await start.hover();
      await page.screenshot({
        path: testInfo.outputPath(`review-hover-${width}.png`),
      });
      await start.click();
      await expect(panel.getByRole("alert")).toContainText("Response lost");
      await expect(start).toBeDisabled();
      await expect(panel.getByRole("alert")).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`error-${width}.png`),
      });
      await page.reload();
      await panel
        .getByRole("button", { name: "Replace an account", exact: true })
        .click();
      await expect(
        panel.getByText("Pausing scheduled delivery", { exact: true }),
      ).toBeVisible();
      expect(advanceCalls).toBe(1);
      await expect(
        panel.getByRole("button", { name: "Cancel review" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`recovery-${width}.png`),
      });
      await panel
        .getByRole("button", { name: "Continue account switch" })
        .click();
      await expect(
        panel.getByText("Account switch complete", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`complete-${width}.png`),
      });
      await page.screenshot({
        path: testInfo.outputPath(`complete-page-${width}.png`),
        fullPage: true,
      });
      await testInfo.attach("browser-network-log", {
        body: JSON.stringify(browserLog, null, 2),
        contentType: "application/json",
      });
      expect(browserLog.filter((entry) => entry.kind === "pageerror")).toEqual(
        [],
      );
      const failures = browserLog
        .filter(
          (entry) => entry.kind === "http" && /^[45][0-9]{2} /.test(entry.text),
        )
        .map((entry) => entry.text);
      const isInventoryFailure = (entry: string) =>
        /^503 .*connectors\/google\/status/.test(entry);
      expect(failures.some(isInventoryFailure)).toBe(true);
      // Inventory reads can retry during startup; the effect failure stays singular.
      expect(failures.filter((entry) => !isInventoryFailure(entry))).toEqual([
        expect.stringMatching(/^503 .*account-handoffs.*advance/),
      ]);
      expect(disconnectCalls).toBe(0);
      expect(advanceCalls).toBe(5);
    });
  });
}
