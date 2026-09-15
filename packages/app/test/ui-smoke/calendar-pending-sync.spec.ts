/** Exercises the calendar editor's pending-delivery state through the real app and HTTP adapter with synthetic event data. */
import { expect } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  captureFamilyAccent,
  captureFamilyState,
} from "./helpers/family-review-capture";
import { seedStewardSession } from "./helpers/test-auth";
import { test } from "./helpers/viewport-video";

test.use({ video: "on", trace: "on" });
for (const width of [1280, 390]) {
  test.describe(`pending calendar delivery ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("keeps a saved event editable while showing unfinished Google delivery", async ({
      page,
    }, info) => {
      await seedAppStorage(page, { "eliza:ui-accent": "orange" });
      await seedStewardSession(page, { jwt: true });
      await installDefaultAppRoutes(page);
      const errors: string[] = [];
      const writes: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          request.url().includes("/api/lifeops/calendar/") &&
          request.method() !== "GET"
        )
          writes.push(request.method());
      });
      await page.route("**/api/lifeops/calendar/calendars**", async (route) => {
        await route.fulfill({
          json: {
            calendars: [
              {
                provider: "eliza",
                side: "owner",
                grantId: "eliza-calendar",
                calendarId: "primary",
                connectorAccountId: null,
                accountEmail: null,
                summary: "Eliza Calendar",
                description: null,
                primary: true,
                accessRole: "owner",
                backgroundColor: null,
                foregroundColor: null,
                timeZone: "America/New_York",
                selected: true,
                includeInFeed: true,
              },
            ],
          },
        });
      });
      let pending = true;
      await page.route("**/api/lifeops/calendar/feed**", async (route) => {
        const url = new URL(route.request().url());
        const start = new Date();
        start.setHours(16, 0, 0, 0);
        const event = {
          id: "synthetic-local-edit",
          externalId: "synthetic-local-edit",
          agentId: "smoke-agent",
          provider: "eliza",
          side: "owner",
          grantId: "eliza-calendar",
          calendarId: "primary",
          title: "Synthetic library pickup",
          description: "",
          location: "",
          status: "confirmed",
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 1800000).toISOString(),
          isAllDay: false,
          timezone: null,
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {
            etag: '"eliza-2"',
            version: 2,
            ...(pending
              ? {
                  deduplication: {
                    pendingUpdate: { linkId: "synthetic-link", snapshots: [] },
                  },
                }
              : {}),
          },
          syncedAt: start.toISOString(),
          updatedAt: start.toISOString(),
          calendarSummary: "Eliza Calendar",
        };
        await route.fulfill({
          json: {
            events: [event],
            source: "cache",
            state: "complete",
            sources: [],
            timeMin: url.searchParams.get("timeMin"),
            timeMax: url.searchParams.get("timeMax"),
            syncedAt: start.toISOString(),
          },
        });
      });
      await openAppPath(page, "/calendar");
      await page.getByText("Synthetic library pickup", { exact: true }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Google calendar update pending" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save event", exact: true }),
      ).toBeEnabled();
      await captureFamilyState(page, info, `calendar-pending-${width}`);
      await page.getByTestId("event-editor-drawer").evaluate((drawer) => {
        drawer.scrollTop = drawer.scrollHeight;
      });
      const save = page.getByRole("button", {
        name: "Save event",
        exact: true,
      });
      await save.click({ trial: true });
      await captureFamilyAccent(
        page,
        info,
        save,
        "calendar-pending-controls",
        width,
      );
      pending = false;
      await page.reload();
      await page.getByText("Synthetic library pickup", { exact: true }).click();
      await expect(
        page.getByText("Saved in Eliza. Google calendar update pending.", {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save event", exact: true }),
      ).toBeEnabled();
      await captureFamilyState(page, info, `calendar-delivered-${width}`);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
