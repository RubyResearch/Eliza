// Self-contained frontend web-vitals collector for the ui-smoke Playwright
// harness. The measurement approach mirrors
// the loadperf frontend-kpi harness (now maintained in
// https://github.com/elizaOS/benchmarks) so this spec agrees with it:
//   - LCP via PerformanceObserver("largest-contentful-paint")
//   - CLS via PerformanceObserver("layout-shift") (excluding hadRecentInput)
//   - FCP via the "first-contentful-paint" paint entry
//   - JS bytes via performance.getEntriesByType("resource").encodedBodySize
//     for entries whose initiatorType === "script"
//
// Observers are installed via addInitScript so they are wired before any
// navigation, capturing the very first paint's LCP/CLS (buffered: true).

import type { Page } from "@playwright/test";

export interface FrontendKpiSample {
  /** First Contentful Paint in ms, or null if no paint entry was recorded. */
  fcpMs: number | null;
  /** Largest Contentful Paint in ms, or null if no LCP candidate exists. */
  lcpMs: number | null;
  /** Cumulative Layout Shift (unitless), 0 when no shifts occurred. */
  cls: number;
  /** Total encoded bytes of script resources transferred. */
  jsTransferredBytes: number;
  /** Total number of resource entries fetched by the page. */
  requestCount: number;
  /** Resource breakdown captured with the first-interactive transfer total. */
  firstInteractiveScripts: Array<{ path: string; bytes: number }> | null;
}

// The page-side global the init script populates and readFrontendKpis() drains.
const KPI_GLOBAL = "__elizaLoadperfKpi__";

// The composer marks "first interactive". We support the legacy test id and
// the current accessible compact composer so the KPI samples the real ready UI.
const FIRST_INTERACTIVE_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

interface KpiCollectorState {
  lcpMs: number | null;
  cls: number;
  /** JS-transfer total snapshotted at first-interactive, null until captured. */
  firstInteractiveJsBytes: number | null;
  firstInteractiveScripts: Array<{ path: string; bytes: number }> | null;
}

declare global {
  interface Window {
    [KPI_GLOBAL]?: KpiCollectorState;
  }
}

/**
 * Wire the LCP/CLS PerformanceObservers before navigation so the first paint is
 * captured. Must be called before page.goto/openAppPath.
 */
export async function installWebVitalsObservers(page: Page): Promise<void> {
  await page.addInitScript(
    (args: { globalKey: string; firstInteractiveSelector: string }) => {
      const { globalKey, firstInteractiveSelector } = args;
      const state: KpiCollectorState = {
        lcpMs: null,
        cls: 0,
        firstInteractiveJsBytes: null,
        firstInteractiveScripts: null,
      };
      (window as unknown as Record<string, KpiCollectorState>)[globalKey] =
        state;

      const sumScriptBytes = (): number => {
        let total = 0;
        for (const entry of performance.getEntriesByType(
          "resource",
        ) as PerformanceResourceTiming[]) {
          if (entry.initiatorType === "script") {
            total += entry.encodedBodySize;
          }
        }
        return total;
      };

      // Snapshot JS transfer the instant the composer mounts. A MutationObserver
      // fires synchronously within the microtask of the DOM insertion, before
      // the idle-time route prefetch can run, so the captured total is the
      // eager cost to reach an interactive chat shell.
      const captureFirstInteractive = () => {
        if (state.firstInteractiveJsBytes !== null) return false;
        if (!document.querySelector(firstInteractiveSelector)) return false;
        state.firstInteractiveJsBytes = sumScriptBytes();
        state.firstInteractiveScripts = (
          performance.getEntriesByType(
            "resource",
          ) as PerformanceResourceTiming[]
        )
          .filter((entry) => entry.initiatorType === "script")
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            bytes: entry.encodedBodySize,
          }));
        return true;
      };
      if (!captureFirstInteractive()) {
        const domObserver = new MutationObserver(() => {
          if (captureFirstInteractive()) domObserver.disconnect();
        });
        const startObserving = () => {
          if (captureFirstInteractive()) return;
          domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        };
        if (document.documentElement) {
          startObserving();
        } else {
          document.addEventListener("DOMContentLoaded", startObserving, {
            once: true,
          });
        }
      }

      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) {
            state.lcpMs = last.startTime;
          }
        });
        lcpObserver.observe({
          type: "largest-contentful-paint",
          buffered: true,
        });
      } catch {
        // LCP unsupported in this engine; leave lcpMs null.
      }

      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            };
            if (!shift.hadRecentInput) {
              state.cls += shift.value;
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        // layout-shift unsupported; leave cls at 0.
      }
    },
    {
      globalKey: KPI_GLOBAL,
      firstInteractiveSelector: FIRST_INTERACTIVE_SELECTOR,
    },
  );
}

/**
 * Drain the collected web-vitals and compute payload/request KPIs from the
 * page's resource timing buffer.
 */
export async function readFrontendKpis(page: Page): Promise<FrontendKpiSample> {
  return page.evaluate((globalKey: string): FrontendKpiSample => {
    const state = (window as unknown as Record<string, KpiCollectorState>)[
      globalKey
    ] ?? {
      lcpMs: null,
      cls: 0,
      firstInteractiveJsBytes: null,
      firstInteractiveScripts: null,
    };

    const paintEntries = performance.getEntriesByType("paint");
    const fcpEntry = paintEntries.find(
      (entry) => entry.name === "first-contentful-paint",
    );
    const fcpMs = fcpEntry ? fcpEntry.startTime : null;

    const resourceEntries = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    let liveJsBytes = 0;
    for (const entry of resourceEntries) {
      if (entry.initiatorType === "script") {
        liveJsBytes += entry.encodedBodySize;
      }
    }

    // Prefer the first-interactive snapshot (eager cost to a usable shell)
    // over the live total, which the idle route-prefetch warm-up inflates.
    const jsTransferredBytes = state.firstInteractiveJsBytes ?? liveJsBytes;

    return {
      fcpMs,
      lcpMs: state.lcpMs,
      cls: state.cls,
      jsTransferredBytes,
      requestCount: resourceEntries.length,
      firstInteractiveScripts: state.firstInteractiveScripts,
    };
  }, KPI_GLOBAL);
}

/** Human-readable one-line summary for the test reporter. */
export function formatKpiSample(sample: FrontendKpiSample): string {
  const fcp = sample.fcpMs === null ? "n/a" : `${Math.round(sample.fcpMs)}ms`;
  const lcp = sample.lcpMs === null ? "n/a" : `${Math.round(sample.lcpMs)}ms`;
  const jsMb = (sample.jsTransferredBytes / (1024 * 1024)).toFixed(2);
  return `FCP=${fcp} LCP=${lcp} CLS=${sample.cls.toFixed(4)} JS=${jsMb}MB requests=${sample.requestCount}`;
}
