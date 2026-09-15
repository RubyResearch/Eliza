/**
 * Exercises populated personal-assistant plugin views and their state-changing
 * controls through the real desktop and Pixel-7 renderer with deterministic
 * lifeops endpoints. Hit testing also catches overlays that intercept input.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installRemoteConnectionsView } from "./remote-connections-fixture";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

async function expectTopmostAtCenter(
  locator: Locator,
  owner: string,
): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 15_000 });
  const isTopmost = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return element === topmost || element.contains(topmost);
  });

  // #11144 regressed when the (now-removed) global corner back button visually
  // cleared the content but kept intercepting first-chip pointer input. This
  // guard still asserts the target chip is the DOM hit-test winner at its own
  // center before clicking it, so any future overlay that occludes it fails.
  expect(
    isTopmost,
    `${owner} should be topmost at its center, not occluded by an overlay (#11144)`,
  ).toBe(true);
}

async function openPopulatedCalendar(page: Page): Promise<void> {
  await openAppPath(page, "/calendar");
  await expect(page.getByTestId("lifeops-calendar-section")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Design sync").first()).toBeVisible({
    timeout: 15_000,
  });
}

test("calendar inherits the host accent for current and selected days after a preference change", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("eliza:ui-accent", "green");
  });
  await openPopulatedCalendar(page);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  const grid = page.getByTestId("calendar-month-grid");
  const selected = grid
    .locator(
      'button[data-agent-id^="calendar-day-"]:not([aria-current="date"])',
    )
    .first();
  await selected.click();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const colors = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const current = document.querySelector(
      '[data-testid="calendar-month-grid"] button[aria-current="date"]',
    );
    const selection = document.querySelector(
      '[data-testid="calendar-month-grid"] button[aria-pressed="true"]',
    );
    if (!current || !selection)
      throw new Error("Calendar day controls missing");
    const probe = document.createElement("span");
    document.body.append(probe);
    const resolve = (value: string) => {
      probe.style.backgroundColor = value;
      return getComputedStyle(probe).backgroundColor;
    };
    const result = {
      current: getComputedStyle(current).backgroundColor,
      selected: getComputedStyle(selection).backgroundColor,
      expectedCurrent: resolve(root.getPropertyValue("--accent")),
      expectedSelected: resolve(root.getPropertyValue("--accent-subtle")),
      preferenceApplied:
        document.documentElement.style.getPropertyValue("--accent") !== "",
    };
    probe.remove();
    return result;
  });
  expect(colors.preferenceApplied).toBe(true);
  expect(colors.current).toBe(colors.expectedCurrent);
  expect(colors.selected).toBe(colors.expectedSelected);
});

test("calendar decomposed view: responsive modes and event creation", async ({
  page,
}) => {
  await openPopulatedCalendar(page);

  if ((await page.evaluate(() => window.innerWidth)) >= 768) {
    const todayBounds = await page
      .getByRole("button", { name: "Today", exact: true })
      .boundingBox();
    const createBounds = await page
      .getByTestId("lifeops-calendar-new-event")
      .boundingBox();
    if (!todayBounds || !createBounds)
      throw new Error("Calendar toolbar controls are missing");
    expect(
      Math.abs(
        todayBounds.y +
          todayBounds.height / 2 -
          createBounds.y -
          createBounds.height / 2,
      ),
      "Desktop calendar navigation and creation should share one compact toolbar row",
    ).toBeLessThan(4);
  }

  const monthMode = page.getByRole("button", { name: "Month", exact: true });
  await expectTopmostAtCenter(monthMode, "Calendar Month mode");
  await monthMode.click();
  await expect(monthMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("calendar-month-grid")).toBeVisible();

  const newEvent = page.getByTestId("lifeops-calendar-new-event");
  await expectTopmostAtCenter(newEvent, "Calendar New event");
  await newEvent.click();
  await expect(page.getByTestId("event-editor-drawer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Create event" }),
  ).toBeVisible();
});

test("calendar mobile layout keeps navigation and editor inside 390px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPopulatedCalendar(page);

  const dayMode = page.getByRole("button", { name: "Day", exact: true });
  await expectTopmostAtCenter(dayMode, "Calendar Day mode");
  await dayMode.click();
  await expect(dayMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("calendar-time-grid")).toBeVisible();

  const newEvent = page.getByTestId("lifeops-calendar-new-event");
  await expectTopmostAtCenter(newEvent, "Calendar New event");
  await expect(newEvent).toBeInViewport();
  await expect(page.getByRole("button", { name: "Previous" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Today" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Next" })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    "Calendar mobile shell must not introduce page-level horizontal overflow",
  ).toBe(390);

  await newEvent.click();
  const editor = page.getByTestId("event-editor-drawer");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(editorBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (editorBounds?.x ?? 0) + (editorBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("Event title")).toBeInViewport();
  await expect(page.getByLabel("Start time")).toBeInViewport();
  await expect(page.getByLabel("End time")).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Create event" }),
  ).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`empty calendar preserves selected projections and creation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/lifeops/calendar/feed**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          calendarId: "primary",
          events: [],
          source: "cache",
          state: "complete",
          sources: [],
          timeMin: url.searchParams.get("timeMin"),
          timeMax: url.searchParams.get("timeMax"),
          syncedAt: new Date().toISOString(),
        }),
      });
    });
    await openAppPath(page, "/calendar");
    for (const mode of ["Day", "Week", "Month"]) {
      const control = page.getByRole("button", { name: mode, exact: true });
      await control.click();
      await expect(control).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByTestId(
          mode === "Month" ? "calendar-month-grid" : "calendar-time-grid",
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await page.getByTestId("lifeops-calendar-new-event").click();
    await expect(page.getByLabel("Event title")).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Create event" }),
    ).toBeVisible();
  });
}

test("inbox decomposed view: channel filters toggle", async ({ page }) => {
  // /inbox renders the populated triage list from the inbox mock: an Email
  // (gmail) thread and a Discord thread.
  await openAppPath(page, "/inbox");
  await expect(page.getByText("Invoice #42 overdue").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("gm everyone — standup in 10").first(),
  ).toBeVisible({ timeout: 15_000 });

  // The selected channel must narrow the rendered server-backed list, and
  // clearing it must restore the other channel's messages.
  const emailChip = page
    .getByRole("button", { name: "Email", exact: true })
    .first();
  await expectTopmostAtCenter(emailChip, "Inbox Email filter chip");
  await emailChip.click();
  await expect(emailChip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Invoice #42 overdue").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("gm everyone — standup in 10")).toHaveCount(0, {
    timeout: 15_000,
  });
  await emailChip.click();
  await expect(emailChip).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByText("gm everyone — standup in 10").first(),
  ).toBeVisible();
  await expect(page.getByText("Invoice #42 overdue").first()).toBeVisible();
});

test("finances decomposed view: renders the financial summary", async ({
  page,
}) => {
  // The money mocks seed a source + dashboard + transactions + recurring, so
  // FinancesView lands on its populated branch: the net balance, the "Latte"
  // transaction, and the Netflix recurring charge.
  await openAppPath(page, "/finances");
  await expect(page.getByText("$2,765.50").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Transactions (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Latte").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Recurring (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Netflix").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("focus decomposed view: renders the focus scaffold", async ({ page }) => {
  // The website-blocker mock reports enabled:false, so FocusView resolves to
  // its inactive branch (not loading, not error, not "Focus unavailable").
  await openAppPath(page, "/focus");
  await expect(
    page.getByText("No focus session active", { exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 });
});

test("goals decomposed view: filters populated goals by status", async ({
  page,
}) => {
  // The goals mock seeds one active goal + one paused goal (flagged
  // needs_attention → the "1 goal needs a review." proactive line).
  await openAppPath(page, "/goals");
  await expect(page.getByText("Run a half marathon").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("Learn conversational Spanish").first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1 goal needs a review.").first()).toBeVisible({
    timeout: 15_000,
  });

  const statusFilter = page.getByRole("combobox", {
    name: "Status",
    exact: true,
  });
  await expectTopmostAtCenter(statusFilter, "Goals status filter");
  await statusFilter.selectOption({ label: "Active" });
  await expect(page.getByText("Learn conversational Spanish")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByText("Run a half marathon").first()).toBeVisible({
    timeout: 15_000,
  });
  await statusFilter.selectOption({ label: "Paused" });
  await expect(page.getByText("Run a half marathon")).toHaveCount(0);
  await expect(
    page.getByText("Learn conversational Spanish").first(),
  ).toBeVisible();
  await statusFilter.selectOption({ label: "All goals" });
  await expect(page.getByText("Run a half marathon").first()).toBeVisible();
  await expect(
    page.getByText("Learn conversational Spanish").first(),
  ).toBeVisible();
});

test("health decomposed view: renders the health regions", async ({ page }) => {
  // The sleep mocks populate the three health regions: last night, regularity,
  // and the personal baseline. 465 min → the "7h 45m" duration readout.
  await openAppPath(page, "/health");
  await expect(
    page.getByRole("heading", { name: "Last sleep" }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("heading", { name: "Regularity" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Baseline" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("7h 45m").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("todos decomposed view: renders the todo lanes", async ({ page }) => {
  // The todos mock seeds one item per lane, so all three lanes render with
  // their counts and titles.
  await openAppPath(page, "/todos");
  await expect(page.getByText("Today (1)").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Upcoming (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Someday (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("Submit the quarterly report").first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("relationships decomposed view: renders the graph and toggles a kind filter", async ({
  page,
}) => {
  // /relationships mounts the unified RelationshipsView. The helper mocks
  // GET /api/lifeops/entities + /api/lifeops/relationships with a populated
  // graph (Owner, Pat Doe, Acme Corp), so the view lands on its populated
  // branch. Selecting "Organizations" from the kind dropdown narrows the node
  // list to the organization node only; selecting "All" restores it.
  await openAppPath(page, "/relationships");
  await expect(page.getByText("3 entities", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // Layout sanity (#11145 lineage): this decomposed route renders the unified
  // list-based RelationshipsSpatialView (RelationshipsView.tsx), whose
  // container is `[data-spatial-surface]`. Assert the rendered surface never
  // exceeds the viewport width (no horizontal page-scroll blowout).
  const viewport = page.viewportSize();
  if (viewport) {
    const box = await page
      .locator("[data-spatial-surface]")
      .first()
      .boundingBox();
    expect(box, "spatial surface should be laid out").not.toBeNull();
    if (box) {
      // +1px slack for sub-pixel rounding.
      expect(box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }

  const kindFilter = page.getByRole("button", {
    name: /^Filter relationship type/,
  });
  await expectTopmostAtCenter(kindFilter, "Relationships kind filter");
  await kindFilter.click();
  await page
    .getByRole("menuitemradio", { name: "Organizations", exact: true })
    .click();
  await expect(kindFilter).toHaveAttribute(
    "aria-label",
    "Filter relationship type, Organizations selected",
  );
  await expect(page.getByText("1 entity", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // #11144 guard: the kind control occupies the filter surface that used to
  // sit under the removed global corner back button. Drive the restore path
  // through the same topmost-checked control, then assert every kind is visible.
  await expectTopmostAtCenter(kindFilter, "Relationships kind filter");
  await kindFilter.click();
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
  await expect(kindFilter).toHaveAttribute(
    "aria-label",
    "Filter relationship type, All selected",
  );
  await expect(page.getByText("3 entities", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
});

for (const width of [1280, 390]) {
  test(`connections calendar recovery loads through the built host at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const { bundleRequests } = await installRemoteConnectionsView(page);
    await page.route(
      "**/api/lifeops/connectors/google/status**",
      async (route) => {
        await route.fulfill({ json: { accounts: [] } });
      },
    );
    await page.route("**/api/permissions/calendar", async (route) => {
      await route.fulfill({
        json: {
          id: "calendar",
          status: "denied",
          lastChecked: Date.now(),
          canRequest: false,
          platform: "darwin",
        },
      });
    });
    await page.route("**/api/lifeops/account-handoffs/active", (route) =>
      route.fulfill({ json: { handoff: null } }),
    );
    await openAppPath(page, "/lifeops/connections");
    const refresh = page.getByRole("button", {
      name: "Retry all connection checks and synchronization",
    });
    await expect(refresh).toBeEnabled({ timeout: 60_000 });
    await page
      .getByRole("button", { name: "Replace an account", exact: true })
      .click();
    await expect(
      page.getByLabel("Test account to disconnect", { exact: true }),
    ).toBeVisible();
    const synchronized = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/lifeops/calendar/feed" &&
        url.searchParams.get("forceSync") === "true"
      );
    });
    await refresh.click();
    await synchronized;
    await expect(refresh).toBeEnabled();
    expect(
      bundleRequests.some(
        (url) => new URL(url).searchParams.get("hostExternalRuntime") === "1",
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });
}
