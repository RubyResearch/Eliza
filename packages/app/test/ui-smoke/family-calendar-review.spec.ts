/** Exercises linked-event review and conflict choice through the app HTTP adapter with synthetic records; no provider calendar is changed. */
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
  test.describe(`calendar review ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("shows current event names and binds conflict choice to the reviewed link", async ({
      page,
    }, info) => {
      await seedAppStorage(page, { "eliza:ui-accent": "orange" });
      await seedStewardSession(page, { jwt: true });
      await installDefaultAppRoutes(page);
      const errors: string[] = [];
      const diagnostics: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) =>
        diagnostics.push(`${message.type()}: ${message.text()}`),
      );
      const link = {
        id: "reviewed-link",
        localEventId: "opaque-local-event-id",
        providerCalendarId: "synthetic-calendar",
        state: "conflicted",
        updatedAt: "2026-09-15T12:00:00Z",
        event: {
          title: "Library pickup",
          startAt: "2026-09-15T19:00:00Z",
          endAt: "2026-09-15T20:00:00Z",
          isAllDay: false,
        },
      };
      let decisions = 0;
      await page.route(
        /\/api\/lifeops\/calendar\/links(?:\?.*)?$/,
        async (route) => {
          expect(new URL(route.request().url()).searchParams.get("view")).toBe(
            "events",
          );
          diagnostics.push("GET linked event review");
          await route.fulfill({
            json: {
              links: [
                link,
                {
                  ...link,
                  id: "missing-link",
                  localEventId: "missing-event",
                  state: "paused",
                  event: null,
                },
              ],
            },
          });
        },
      );
      await page.route(
        "**/api/lifeops/calendar/links/reviewed-link/resolve",
        async (route) => {
          expect(route.request().postDataJSON()).toEqual({
            strategy: "keep_eliza",
            idempotencyKey: expect.any(String),
            expectedUpdatedAt: link.updatedAt,
          });
          decisions++;
          link.state = "clean";
          await route.fulfill({ json: { outcome: "pushed" } });
        },
      );
      await openAppPath(page, "/lifeops/family");
      await page
        .getByRole("button", { name: "Calendar sync", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Library pickup", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "Event details unavailable",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /opaque-local-event-id/ }),
      ).toHaveCount(0);
      const keep = page.getByRole("button", {
        name: "Keep Eliza",
        exact: true,
      });
      await captureFamilyAccent(page, info, keep, "calendar-conflict", width);
      await keep.click();
      await expect(keep).toHaveCount(0);
      expect(decisions).toBe(1);
      await captureFamilyState(page, info, `calendar-resolved-${width}`);
      link.event.title = "Library pickup moved";
      await page.reload();
      await page
        .getByRole("button", { name: "Calendar sync", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Library pickup moved",
          exact: true,
        }),
      ).toBeVisible();
      await captureFamilyState(page, info, `calendar-current-${width}`);
      expect(errors).toEqual([]);
      await info.attach("calendar-console-network", {
        body: diagnostics.join("\n"),
        contentType: "text/plain",
      });
    });
  });
}
