/**
 * Exercises explicit view back controls in the real browser. Shared ViewHeader
 * only renders supplied page actions; routes no longer require a title/back
 * row. Settings and other views that supply their own back control retain
 * reachable navigation and the mobile minimum hit target.
 */
import { expect, type Locator, type Page } from "@playwright/test";

interface ViewBackOptions {
  name: string;
  within?: string;
  requireTapTarget?: boolean;
}

export async function assertViewBackControl(
  page: Page,
  { name, within, requireTapTarget = false }: ViewBackOptions,
): Promise<Locator> {
  const scope = within ? page.locator(within) : page;
  const back = scope.getByRole("button", { name, exact: true });
  await expect(back).toBeVisible({ timeout: 30_000 });
  await expect(back).toBeInViewport();
  if (requireTapTarget) {
    const box = await back.boundingBox();
    expect(box, "the back control has a measurable hit target").not.toBeNull();
    if (!box) throw new Error("The back control has no hit target");
    expect(
      box.height,
      "the back control is at least 44px tall",
    ).toBeGreaterThanOrEqual(44);
    expect(
      box.width,
      "the back control is at least 44px wide",
    ).toBeGreaterThanOrEqual(44);
  }
  return back;
}

export async function clickViewBackControl(
  page: Page,
  options: ViewBackOptions & { destination: Locator },
): Promise<void> {
  const back = await assertViewBackControl(page, options);
  await back.click();
  await expect(options.destination).toBeVisible();
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /(?:404\s+not\s+found|page not found|route not found)/i,
  );
}
