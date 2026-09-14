/**
 * Browser contrast regression for the JoinPage primary recovery controls. The
 * real renderer runs in desktop and coarse-pointer mobile contexts while the
 * Cloud identity endpoint deterministically exposes the retry state; computed
 * rest and hover colors must retain WCAG AA contrast for both recovery actions.
 */
import { writeFile } from "node:fs/promises";
import {
  devices,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";

const SURFACES = [
  {
    name: "desktop",
    context: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 900 },
    },
    coarsePointer: false,
    hoverCapable: true,
  },
  {
    name: "mobile-layout-hover",
    context: {
      ...devices["Pixel 7"],
      // Chromium otherwise hard-wires `(hover: none)` for touch contexts and
      // ignores CDP's hybrid coarse-pointer hover media override.
      hasTouch: false,
      viewport: { width: 390, height: 844 },
    },
    coarsePointer: false,
    hoverCapable: true,
  },
  {
    name: "mobile-touch",
    context: {
      ...devices["Pixel 7"],
      viewport: { width: 390, height: 844 },
    },
    coarsePointer: true,
    hoverCapable: false,
  },
] as const;

type ContrastSample = {
  backgroundColor: string;
  className: string;
  color: string;
  ratio: number;
};

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installJoinRoutes(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);

  await page.route("**/api/auth/steward-session", async (route) => {
    await fulfillJson(route, 200, { success: true });
  });

  await page.route("**/api/v1/eliza/personal", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 503, {
      success: false,
      error: "Personal Eliza is temporarily unavailable.",
    });
  });
}

async function readContrast(locator: Locator): Promise<ContrastSample> {
  return locator.evaluate((element) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parseColor = (value: string): Rgba => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas 2D is unavailable");
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
    };
    const composite = (foreground: Rgba, background: Rgba): Rgba => ({
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      b: foreground.b * foreground.a + background.b * (1 - foreground.a),
      a: 1,
    });
    const luminance = (color: Rgba): number => {
      const channel = (value: number) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return (
        0.2126 * channel(color.r) +
        0.7152 * channel(color.g) +
        0.0722 * channel(color.b)
      );
    };

    const style = getComputedStyle(element);
    const theme = element.closest<HTMLElement>(".theme-cloud");
    if (!theme) throw new Error("Join CTA is missing its theme-cloud owner");
    const themeBackground = parseColor(getComputedStyle(theme).backgroundColor);
    const background = composite(
      parseColor(style.backgroundColor),
      themeBackground,
    );
    const foreground = composite(parseColor(style.color), background);
    const light = Math.max(luminance(background), luminance(foreground));
    const dark = Math.min(luminance(background), luminance(foreground));

    return {
      backgroundColor: style.backgroundColor,
      className: element.className,
      color: style.color,
      ratio: (light + 0.05) / (dark + 0.05),
    };
  });
}

async function assertStableContrast(
  page: Page,
  button: Locator,
  hoverCapable: boolean,
  feedback: "backgroundColor" | "color",
): Promise<{ rest: ContrastSample; hover: ContrastSample }> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const rest = await readContrast(button);
  expect(rest.ratio).toBeGreaterThanOrEqual(4.5);

  await button.hover();
  await page.waitForTimeout(200);
  const hover = await readContrast(button);
  if (hoverCapable) {
    expect(hover[feedback]).not.toBe(rest[feedback]);
  } else {
    expect(hover[feedback]).toBe(rest[feedback]);
  }
  const stableChannel = feedback === "color" ? "backgroundColor" : "color";
  expect(hover[stableChannel]).toBe(rest[stableChannel]);
  expect(hover.ratio).toBeGreaterThanOrEqual(4.5);
  return { rest, hover };
}

test("Join recovery actions preserve computed contrast on desktop, mobile-hover, and touch profiles", async ({
  browser,
  baseURL,
}, testInfo) => {
  const report: Record<string, unknown> = {
    head: process.env.GITHUB_SHA ?? "local-exact-head",
    surfaces: {},
  };

  for (const surface of SURFACES) {
    const videoDir = testInfo.outputPath(`${surface.name}-video`);
    const context = await browser.newContext({
      ...surface.context,
      baseURL,
      serviceWorkers: "block",
      ...(process.env.E2E_RECORD === "1"
        ? { recordVideo: { dir: videoDir } }
        : {}),
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    await cdp.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [
        { name: "hover", value: surface.hoverCapable ? "hover" : "none" },
      ],
    });
    expect(
      await page.evaluate(() => matchMedia("(hover: hover)").matches),
    ).toBe(surface.hoverCapable);
    await seedStewardSession(page, { jwt: true });
    await installJoinRoutes(page);

    await page.goto("/join");
    const signOut = page.getByRole("button", { name: "Sign out" });
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(signOut).toBeVisible();
    const retryContrast = await assertStableContrast(
      page,
      retry,
      surface.hoverCapable,
      "backgroundColor",
    );
    await page.screenshot({
      path: testInfo.outputPath(`${surface.name}-retry-hover.png`),
      fullPage: true,
    });

    const signOutContrast = await assertStableContrast(
      page,
      signOut,
      surface.hoverCapable,
      "color",
    );
    await page.screenshot({
      path: testInfo.outputPath(`${surface.name}-sign-out-hover.png`),
      fullPage: true,
    });

    const coarsePointer = await page.evaluate(
      () => matchMedia("(pointer: coarse)").matches,
    );
    expect(coarsePointer).toBe(surface.coarsePointer);
    report.surfaces = {
      ...(report.surfaces as Record<string, unknown>),
      [surface.name]: {
        coarsePointer,
        retryContrast,
        signOutContrast,
      },
    };
    await context.close();
  }

  const reportPath = testInfo.outputPath("join-cta-computed-contrast.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("join-cta-computed-contrast", {
    path: reportPath,
    contentType: "application/json",
  });
});
