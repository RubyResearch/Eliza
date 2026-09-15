/** Verifies school setup and saved schedule readback through the full app and production HTTP adapter at desktop and mobile sizes. Synthetic HTTP responses isolate UI behavior; scheduler persistence is covered by the family workflow integration lane. */
import { expect } from "@playwright/test";
import type { FamilyMonthlyScheduleView } from "../../../../plugins/plugin-personal-assistant/src/lifeops/family-workflows/runtime";
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
  test.describe(`school schedule ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("shows creation, saved timing and retained inactive status", async ({
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
      let schedule: FamilyMonthlyScheduleView | null = null;
      let saves = 0;
      let effects = 0;
      let schoolLevel = "all";
      let updateMode = "review";
      await page.route(
        "**/api/lifeops/family-workflows/school/**",
        async (route) => {
          const req = route.request();
          const path = new URL(req.url()).pathname;
          diagnostics.push(`${req.method()} ${path}`);
          if (req.method() === "GET" && path.endsWith("/status")) {
            return route.fulfill({
              json: {
                sourceId: "synthetic-school-source",
                lastRun: null,
                monthlySchedule: schedule,
                config: {
                  sourceId: "synthetic-school-source",
                  landingPageUrl:
                    "https://www.concordps.org/district-resources/school-year-calendars",
                  allowedHosts: ["www.concordps.org"],
                  pdfHrefPattern: "calendar.pdf",
                  timeZone: "America/New_York",
                  targetGrantId: "eliza",
                  targetCalendarId: "primary",
                  schoolLevel,
                  updateMode,
                },
              },
            });
          }
          if (req.method() === "PUT" && path.endsWith("/source")) {
            expect(req.postDataJSON()).toEqual({
              schoolLevel: "elementary",
              updateMode: "automatic",
            });
            saves++;
            schoolLevel = "elementary";
            updateMode = "automatic";
            schedule ??= {
              taskId: "synthetic-monthly",
              status: "scheduled",
              lastFiredAt: null,
              trigger: {
                kind: "cron",
                expression: "0 9 1 * *",
                tz: "America/New_York",
              },
            };
            return route.fulfill({ json: { accepted: true } });
          }
          effects++;
          return route.fulfill({
            status: 400,
            json: { error: "Unexpected school effect" },
          });
        },
      );
      await openAppPath(page, "/lifeops/family");
      await page
        .getByRole("button", { name: "School calendar", exact: true })
        .click();
      const saved = page.getByRole("region", { name: "Saved family schedule" });
      await expect(saved).toContainText("Not scheduled yet");
      await page.getByRole("combobox", { name: "School level" }).click();
      await page
        .getByRole("option", { name: "Elementary school and district dates" })
        .click();
      await page.getByRole("combobox", { name: "Calendar updates" }).click();
      await page
        .getByRole("option", {
          name: "Apply validated school changes automatically",
        })
        .click();
      const save = page.getByRole("button", {
        name: "Save school settings",
        exact: true,
      });
      await captureFamilyAccent(page, info, save, "school-save", width);
      await save.click();
      await expect(saved).toContainText("Status: Scheduled");
      await expect(saved).toContainText(
        "First day of each month at 9:00 AM America/New_York",
      );
      await captureFamilyState(page, info, `school-saved-${width}`);
      schedule = {
        taskId: "synthetic-monthly",
        status: "dismissed",
        lastFiredAt: "2026-09-01T13:00:00Z",
        trigger: {
          kind: "cron",
          expression: "0 10 2 * *",
          tz: "Europe/London",
        },
      };
      await page.reload();
      await page
        .getByRole("button", { name: "School calendar", exact: true })
        .click();
      await expect(saved).toContainText("Status: Stopped");
      await expect(saved).toContainText("Custom schedule");
      await save.click();
      await expect(saved).toContainText("Status: Stopped");
      await expect(saved).not.toContainText("First day of each month");
      await expect(
        saved.getByRole("link", { name: "Review scheduled tasks" }),
      ).toHaveAttribute("href", "/automations");
      await captureFamilyState(page, info, `school-retained-${width}`);
      expect(saves).toBe(2);
      expect(effects).toBe(0);
      expect(errors).toEqual([]);
      await info.attach("school-console-network", {
        body: diagnostics.join("\n"),
        contentType: "text/plain",
      });
    });
  });
}
