/**
 * Protects the Notes route's shell ownership and adaptive collection geometry
 * in the deterministic app renderer rather than asserting styling literals.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function installCloudSession(page: Page): Promise<void> {
  await page.route("**/api/cloud/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sessionId: "notes-layout-login",
        browserUrl: "https://example.invalid/auth",
      }),
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "authenticated",
        token: "notes-layout-token",
        organizationId: "notes-layout-org",
        userId: "notes-layout-user",
      }),
    });
  });
  await page.route("**/api/cloud/login/persist", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
}

async function openNotes(page: Page): Promise<void> {
  await installCloudSession(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/notes");
  await expect(page.getByTestId("simple-notes-view")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(2);
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

test("Notes keeps the desktop collection readable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openNotes(page);

  const cards = page.getByRole("listitem");
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (!first || !second) return;
  expect(first.width).toBeGreaterThanOrEqual(320);
  expect(second.width).toBeGreaterThanOrEqual(320);
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(2);
  expect(second.x).toBeGreaterThan(first.x + first.width);
});

test("Notes uses the canonical shell gutter on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNotes(page);

  const geometry = await page.evaluate(() => {
    const pageContent = document.querySelector<HTMLElement>(
      "[data-page-content]",
    );
    const notesRail = document.querySelector<HTMLElement>(
      '[data-testid="simple-notes-view"] [data-slot="page-panel-content-rail"]',
    );
    if (!pageContent || !notesRail) return null;
    const pageRect = pageContent.getBoundingClientRect();
    const railRect = notesRail.getBoundingClientRect();
    const pageStyle = getComputedStyle(pageContent);
    return {
      expectedStart:
        pageRect.left + Number.parseFloat(pageStyle.paddingInlineStart),
      expectedEnd:
        pageRect.right - Number.parseFloat(pageStyle.paddingInlineEnd),
      actualStart: railRect.left,
      actualEnd: railRect.right,
    };
  });

  expect(geometry).not.toBeNull();
  if (!geometry) throw new Error("Expected routed Notes gutter geometry");
  expect(
    Math.abs(geometry.actualStart - geometry.expectedStart),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.actualEnd - geometry.expectedEnd),
  ).toBeLessThanOrEqual(1);
});

test("Notes keeps readable cards clear of the composer in short landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openNotes(page);

  const cards = page.getByRole("listitem");
  await cards.nth(1).scrollIntoViewIfNeeded();
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  const composerInput = page.getByPlaceholder(/Message/);
  await expect(composerInput).toBeInViewport();
  const composer = await composerInput.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(composer).not.toBeNull();
  if (!first || !second || !composer) return;
  expect(first.width).toBeGreaterThanOrEqual(300);
  expect(second.width).toBeGreaterThanOrEqual(300);
  expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(2);
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(rectanglesOverlap(first, composer)).toBe(false);
  const visibleSecondBottom = await cards.nth(1).evaluate((card) => {
    let bottom = card.getBoundingClientRect().bottom;
    let ancestor = card.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        bottom = Math.min(bottom, ancestor.getBoundingClientRect().bottom);
      }
      ancestor = ancestor.parentElement;
    }
    return bottom;
  });
  // The DOM box includes clipped content; compare the actually visible card
  // edge after every scroll/clip ancestor with the shell composer instead.
  expect(visibleSecondBottom).toBeLessThanOrEqual(composer.y);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) throw new Error("Expected the configured landscape viewport");
  expect(composer.x).toBeGreaterThanOrEqual(0);
  expect(composer.y).toBeGreaterThanOrEqual(0);
  expect(composer.x + composer.width).toBeLessThanOrEqual(viewport.width);
  expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
