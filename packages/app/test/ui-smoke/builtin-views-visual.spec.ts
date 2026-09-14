/**
 * Playwright UI-smoke spec for the Builtin Views Visual app flow using the
 * real renderer fixture.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

/**
 * Visual coverage for the BUILTIN views — the pages rendered directly by the
 * App.tsx ViewRouter (not the plugin view bundles, which are covered by
 * plugin-views-visual.spec). Each is captured at desktop + mobile so the
 * minimal/light redesign stays regression-guarded at both viewports.
 *
 * Assertions are deliberately lenient: the deterministic stub backend answers
 * some routes with 501 (surfaced as console errors / in-view error cards), which
 * is expected. We guard the things the redesign must never regress: the view
 * mounts, renders readable content, and does not throw an UNCAUGHT page error
 * (a real crash — e.g. an undefined reference), at either viewport.
 */
// Every distinct built-in view route from `TAB_PATHS`
// (packages/ui/src/navigation/index.ts), deduped by path. This is the live-run
// + screenshot gate for ALL built-in views (not just a subset) so no built-in
// surface ships without crash coverage at desktop + mobile.
const BUILTIN_VIEW_CASES: Array<{
  id: string;
  path: string;
  readySelector?: string;
}> = [
  { id: "chat", path: "/chat" },
  { id: "phone", path: "/phone" },
  { id: "messages", path: "/messages" },
  { id: "contacts", path: "/contacts" },
  { id: "camera", path: "/camera" },
  { id: "tasks", path: "/apps/tasks" },
  { id: "browser", path: "/browser" },
  { id: "stream", path: "/stream" },
  { id: "views", path: "/views" },
  { id: "character", path: "/character" },
  { id: "character-select", path: "/character/select" },
  { id: "automations", path: "/automations" },
  { id: "inventory", path: "/wallet" },
  {
    id: "documents",
    path: "/character/documents",
    readySelector: '[data-testid="documents-view"]',
  },
  { id: "files", path: "/apps/files" },
  { id: "plugins", path: "/apps/plugins" },
  { id: "skills", path: "/apps/skills" },
  { id: "trajectories", path: "/apps/trajectories" },
  { id: "transcripts", path: "/apps/transcripts" },
  { id: "relationships", path: "/apps/relationships" },
  { id: "experience", path: "/character/experience" },
  { id: "character-skills", path: "/character/skills" },
  { id: "memories", path: "/apps/memories" },
  { id: "rolodex", path: "/rolodex" },
  { id: "voice", path: "/settings/voice" },
  { id: "runtime", path: "/apps/runtime" },
  { id: "database", path: "/apps/database" },
  { id: "desktop", path: "/desktop" },
  { id: "settings", path: "/settings" },
  { id: "logs", path: "/apps/logs" },
  { id: "background", path: "/background" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("builtin views visual coverage (desktop + mobile)", () => {
  for (const view of BUILTIN_VIEW_CASES) {
    for (const vp of VIEWPORTS) {
      test(`${view.id} ${vp.name}`, async ({ page }) => {
        const screenshotDir =
          process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
          path.join(process.cwd(), "test-results", "builtin-views");
        await mkdir(screenshotDir, { recursive: true });

        // Only uncaught page errors (real crashes) fail the test; stub 501s
        // arrive as console errors and are expected.
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await seedAppStorage(page);
        await installDefaultAppRoutes(page);
        await openAppPath(page, view.path);

        // Most views render inside <main>; a few full-screen surfaces (e.g.
        // /chat, which is the floating chat composer itself) have no <main> —
        // fall back to <body> so those are still covered.
        const hasMain = await page
          .locator("main")
          .first()
          .waitFor({ state: "attached", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        const viewRoot = hasMain
          ? page.locator("main").first()
          : page.locator("body");
        await expect(viewRoot).toBeVisible({ timeout: 60_000 });
        if (view.readySelector) {
          await expect(page.locator(view.readySelector)).toBeVisible({
            timeout: 60_000,
          });
        }
        // A view is "rendered" if it shows readable text OR interactive/visual
        // content — input/canvas-heavy views (chat composer, the background
        // color picker) are legitimately light on static prose. A truly blank
        // or crashed view has neither.
        await expect
          .poll(
            async () =>
              viewRoot.evaluate((root) => {
                const text = root.innerText.trim().replace(/\s+/g, " ").length;
                const interactive = root.querySelectorAll(
                  "button, a, input, textarea, select, canvas, img, svg, [role='button']",
                ).length;
                return text + interactive * 5;
              }),
            {
              message: `${view.id} ${vp.name} should render readable or interactive content`,
              timeout: 30_000,
            },
          )
          .toBeGreaterThan(10);

        await captureScreenshotWithQualityRetry(page, `${view.id} ${vp.name}`, {
          fullPage: false,
          path: path.join(screenshotDir, `${view.id}-${vp.name}.png`),
          attempts: 3,
        });

        expect(
          pageErrors,
          `${view.id} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);
      });
    }
  }
});
