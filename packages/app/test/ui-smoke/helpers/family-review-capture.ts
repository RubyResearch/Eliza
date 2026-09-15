/** Records asserted family workflow states at a readable pace and verifies the actual accent hover paint. */
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export async function captureFamilyState(
  page: Page,
  info: TestInfo,
  name: string,
) {
  // Recording dwell follows caller readiness assertions; it is not a substitute for waiting on application state.
  await page.waitForTimeout(900);
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  await page.waitForTimeout(900);
}

export async function captureFamilyAccent(
  page: Page,
  info: TestInfo,
  button: Locator,
  name: string,
  width: number,
) {
  await expect(button).toBeEnabled();
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("Required control has no rendered geometry");
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  const readPaint = () =>
    button.evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Cannot inspect button paint");
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
  const brightness = (rgba: number[]) =>
    0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2];
  await page.mouse.move(0, 0);
  await captureFamilyState(page, info, `${name}-rest-${width}`);
  const restingPaint = await readPaint();
  await button.hover();
  await expect
    .poll(async () => brightness(await readPaint()))
    .toBeLessThan(brightness(restingPaint));
  await captureFamilyState(page, info, `${name}-hover-${width}`);
  const hoveredPaint = await readPaint();
  expect(hoveredPaint[0]).toBeGreaterThan(hoveredPaint[1]);
  expect(hoveredPaint[1]).toBeGreaterThan(hoveredPaint[2]);
  expect(brightness(hoveredPaint)).toBeLessThan(brightness(restingPaint));
  await info.attach(`${name}-button-paint`, {
    body: JSON.stringify({ restingPaint, hoveredPaint }),
    contentType: "application/json",
  });
}
