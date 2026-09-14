/**
 * Playwright UI-smoke spec for the Perf Load Kpi app flow using the real
 * renderer fixture.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  type FrontendKpiSample,
  formatKpiSample,
  installWebVitalsObservers,
  readFrontendKpis,
} from "./lib/loadperf-kpi";

// Soft, non-flaky budgets. These intentionally have generous headroom so the
// spec doubles as a measurement rather than a brittle gate.
//
// Web-vitals (FCP/LCP) are the meaningful, production-faithful signals here.
//
// JS payload: this measures `encodedBodySize` of script resources, but it is
// NOT the production payload and is NOT the authoritative size gate:
//   - The ui-smoke live-stack server serves dist assets UNCOMPRESSED (verified
//     content-encoding: none); production serves brotli, so this raw transfer
//     runs ~2.7x larger than what users download.
//   - Once the shell reaches "ready" it fires requestIdleCallback ->
//     prefetchRouteViewChunks() (App.tsx), speculatively warming other routes'
//     lazy chunks. In the near-idle test page this fires before the composer
//     testid mounts, so the chat-route number folds in a build-dependent chunk
//     set and varies run-to-run / build-to-build.
// The authoritative compressed-payload gate is the brotli bundle KPI
// (loadperf bundle-kpi in https://github.com/elizaOS/benchmarks: eager first-paint ~1.43 MB
// brotli, total ~6.93 MB brotli — both PASS). The ceiling below is a coarse
// raw-transfer regression guard with limited headroom for the prefetch-warmed
// chunk set, so it still catches a genuinely runaway/duplicated graph while
// tolerating normal build variance. Track the reported FCP/LCP/JS numbers; they
// are the meaningful signal here.
const FCP_BUDGET_MS = 4000;
const LCP_BUDGET_MS = 6000;
const JS_RAW_TRANSFER_CEILING_BYTES = 18 * 1024 * 1024;

// The chat shell renders a stable ready composer once the app is interactive.
// Support the legacy test id and the current accessible compact composer.
const READY_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

test.describe("frontend load KPIs", () => {
  test.beforeEach(async ({ page }) => {
    // Same seeding convention as ui-smoke.spec.ts: default local server +
    // the default mocked app routes.
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    // Observers must be wired before navigation so the first paint's LCP/CLS
    // entries are captured (PerformanceObserver buffered: true).
    await installWebVitalsObservers(page);
  });

  test("chat shell meets web-vitals and payload budgets", async ({ page }) => {
    await openAppPath(page, "/chat");
    await expect(page.locator(READY_SELECTOR)).toBeVisible({
      timeout: 60_000,
    });
    // Sample at first-interactive (composer visible) — this is the cost to
    // make the chat usable, which is what the budgets target. We deliberately
    // do NOT wait afterwards:
    //   - networkidle never fires (the shell holds agent-status SSE/WebSocket
    //     + polling connections open), so the old wait hung until timeout.
    //   - once the shell reaches "ready" it kicks off requestIdleCallback ->
    //     prefetchRouteViewChunks() (App.tsx), which speculatively warms EVERY
    //     other route's lazy chunk. Sampling after that idle warm-up would
    //     fold the whole app's payload into the chat-route number and is not
    //     what we want to budget.
    // FCP/LCP are captured by the buffered PerformanceObservers wired before
    // navigation, so they are already recorded by first-interactive.

    const sample: FrontendKpiSample = await readFrontendKpis(page);
    await test.info().attach("first-interactive-resources", {
      body: JSON.stringify(sample, null, 2),
      contentType: "application/json",
    });

    // Surface the raw numbers through the reporter so the spec is a usable
    // measurement, not just a pass/fail gate.
    const summary = formatKpiSample(sample);
    test.info().annotations.push({
      type: "loadperf-kpi",
      description: summary,
    });
    // Intentional KPI output for the e2e reporter (console is permitted in tests).
    console.log(`[perf-load-kpi] ${summary}`);

    // FCP must be measurable once the app has rendered.
    expect(
      sample.fcpMs,
      "First Contentful Paint must be measurable",
    ).not.toBeNull();
    if (sample.fcpMs !== null) {
      expect(
        sample.fcpMs,
        `FCP ${Math.round(sample.fcpMs)}ms exceeds budget ${FCP_BUDGET_MS}ms`,
      ).toBeLessThan(FCP_BUDGET_MS);
    }

    // LCP can legitimately be null on a view with no qualifying element; only
    // assert the budget when an LCP entry was actually recorded.
    if (sample.lcpMs !== null) {
      expect(
        sample.lcpMs,
        `LCP ${Math.round(sample.lcpMs)}ms exceeds budget ${LCP_BUDGET_MS}ms`,
      ).toBeLessThan(LCP_BUDGET_MS);
    }

    const jsMb = (sample.jsTransferredBytes / (1024 * 1024)).toFixed(2);
    expect(
      sample.jsTransferredBytes,
      `JS raw transfer ${jsMb}MB exceeds regression ceiling ${JS_RAW_TRANSFER_CEILING_BYTES / (1024 * 1024)}MB (uncompressed; brotli payload gated by bundle-kpi.mjs)`,
    ).toBeLessThan(JS_RAW_TRANSFER_CEILING_BYTES);

    // A rendered app must have loaded at least one resource; this guards
    // against measuring a blank/failed page that would trivially "pass".
    expect(sample.requestCount).toBeGreaterThan(0);
  });
});
