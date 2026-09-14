/**
 * Real interaction coverage for the built-in logs and memories pages. The
 * deterministic browser harness verifies that their controls query, filter,
 * paginate, and expose truthful result counts rather than merely rendering.
 */

import { expect, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);
});

test("logs page search really filters entries and clear restores them", async ({
  page,
}) => {
  await openAppPath(page, "/apps/logs");
  const view = page.getByTestId("logs-view");
  await expect(view).toBeVisible({ timeout: 60_000 });

  // The stub serves exactly one log entry ("smoke API ready", source "smoke").
  const entries = page.getByTestId("log-entry");
  await expect(entries).toHaveCount(1);

  const search = page.getByRole("combobox", { name: "message", exact: true });
  await search.fill("zzqq-no-such-log-line");
  await expect(entries).toHaveCount(0);

  // A matching query brings it back — proving the box really filters.
  await search.fill("smoke");
  await expect(entries).toHaveCount(1);

  // Clear filters resets the view's filter state and restores the full list. It
  // lives inside the compact filter menu and clears the view's searchQuery (not
  // the shared composer draft), so assert on the restored entries rather than
  // the composer value.
  await view.locator('[data-agent-id="logs-filter"]').click();
  await page.getByRole("button", { name: /clear filters/i }).click();
  await expect(entries).toHaveCount(1);
});

test("logs page re-queries the log source on a poll", async ({ page }) => {
  // The minimal redesign dropped the manual Refresh button: the view stays
  // current via a silent ~5s background poll. Assert the load query fires and
  // the poll re-queries the source (no user-facing refresh control).
  let logRequests = 0;
  page.on("request", (req) => {
    if (/\/api\/logs(?:\?|$)/.test(req.url())) logRequests += 1;
  });

  await openAppPath(page, "/apps/logs");
  await expect(page.getByTestId("logs-view")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("log-entry")).toHaveCount(1);

  const before = logRequests;
  await expect
    .poll(() => logRequests, { timeout: 30_000 })
    .toBeGreaterThan(before);
});

test("memory viewer queries memory data and the Browse toggle switches the surface", async ({
  page,
}, testInfo) => {
  const memoryRequests: string[] = [];

  // This test owns the memory surface itself. Hide the shell's independent
  // chat overlay so pointer interception cannot turn the pagination contract
  // into a test of chat-overlay geometry.
  await hideChatOverlay(page);

  await page.route("**/api/memories/browse**", async (route) => {
    const memories = Array.from({ length: 50 }, (_, index) => ({
      id: `memory-browse-${index}`,
      type: "messages",
      text: `Bounded memory result ${index + 1}`,
      entityId: "entity-smoke-memory",
      roomId: "room-smoke-memory",
      agentId: "agent-smoke-memory",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z") - index,
      metadata: null,
      source: "ui-smoke",
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        memories,
        total: 51,
        totalIsExact: false,
        hasMore: true,
        limit: 50,
        offset: 0,
      }),
    });
  });
  page.on("request", (req) => {
    if (/\/api\/memories\//.test(req.url())) memoryRequests.push(req.url());
  });

  await openAppPath(page, "/apps/memories");
  await expect(page.getByTestId("memory-viewer-view")).toBeVisible({
    timeout: 60_000,
  });

  // The page must actually query memory data on load — not just render a shell.
  await expect.poll(() => memoryRequests.length).toBeGreaterThan(0);

  // The Browse view-mode toggle must switch the surface AND issue a browse query.
  const browseBefore = memoryRequests.filter((url) =>
    /\/api\/memories\/browse/.test(url),
  ).length;
  await page.getByTestId("memory-view-browse").click();
  await expect(page.getByTestId("memory-browser")).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      () =>
        memoryRequests.filter((url) => /\/api\/memories\/browse/.test(url))
          .length,
    )
    .toBeGreaterThan(browseBefore);
  await expect(page.getByText("1–50 of at least 51")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();

  if (process.env.E2E_RECORD === "1") {
    await page.screenshot({
      path: testInfo.outputPath("memory-browse-incomplete-total.png"),
      fullPage: true,
    });
  }
});

test("memory feed loads every tied-timestamp row with the tuple cursor", async ({
  page,
}, testInfo) => {
  await hideChatOverlay(page);
  const createdAt = Date.parse("2026-01-01T00:00:00.000Z");
  const memoryId = (index: number) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const feedRequests: URL[] = [];

  await page.route("**/api/memories/feed**", async (route) => {
    const url = new URL(route.request().url());
    feedRequests.push(url);
    const beforeId = url.searchParams.get("beforeId");
    const indexes = beforeId
      ? Array.from({ length: 20 }, (_, index) => 19 - index)
      : Array.from({ length: 50 }, (_, index) => 69 - index);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        memories: indexes.map((index) => ({
          id: memoryId(index),
          type: "messages",
          text: `Tied memory ${index}`,
          entityId: "entity-smoke-memory",
          roomId: "room-smoke-memory",
          agentId: "agent-smoke-memory",
          createdAt,
          metadata: null,
          source: "ui-smoke",
        })),
        count: indexes.length,
        limit: 50,
        hasMore: beforeId === null,
      }),
    });
  });

  await openAppPath(page, "/apps/memories");
  await expect(page.getByTestId("memory-feed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId(/^memory-card-/)).toHaveCount(50);
  if (process.env.E2E_RECORD === "1") {
    const desktopViewport = page.viewportSize();
    await page.screenshot({
      path: testInfo.outputPath("memory-feed-tied-cursor-before-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.screenshot({
      path: testInfo.outputPath("memory-feed-tied-cursor-before-mobile.png"),
      fullPage: true,
    });
    if (desktopViewport) await page.setViewportSize(desktopViewport);
  }
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.getByTestId(/^memory-card-/)).toHaveCount(70);
  const oldestMemory = page.getByText("Tied memory 0");
  await oldestMemory.scrollIntoViewIfNeeded();
  await expect(oldestMemory).toBeVisible();

  const cursorRequests = feedRequests.filter((request) =>
    request.searchParams.has("beforeId"),
  );
  expect(cursorRequests).toHaveLength(1);
  expect(cursorRequests[0]?.searchParams.get("before")).toBe(String(createdAt));
  expect(cursorRequests[0]?.searchParams.get("beforeId")).toBe(memoryId(20));

  if (process.env.E2E_RECORD === "1") {
    const desktopViewport = page.viewportSize();
    await page.screenshot({
      path: testInfo.outputPath("memory-feed-tied-cursor-after-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.screenshot({
      path: testInfo.outputPath("memory-feed-tied-cursor-after-mobile.png"),
      fullPage: true,
    });
    if (desktopViewport) await page.setViewportSize(desktopViewport);
  }
});
