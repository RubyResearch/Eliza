/**
 * Playwright UI-smoke spec for the All Views Aesthetic Audit app flow using
 * the real renderer fixture.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type AuditOcrControls,
  bindAuditOcrControls,
} from "../../scripts/lib/audit-capture-manifest";
import { readAuditFindings, writeAuditFinding } from "./aesthetic-audit-report";
import {
  type AestheticMetricBudget,
  computeVerdict,
  evaluateAestheticMetricBudget,
  evaluateStrictGate,
  findRemoteBundleDeclaration,
  OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  parseNavigationTabPaths,
  resolveAuditStrictFlags,
} from "./aesthetic-audit-rules";
import {
  type AuditViewCase,
  BUILTIN_TAB_PATHS,
  buildAuditViewCases,
} from "./aesthetic-audit-view-cases";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";
import { seedStewardSession } from "./helpers/test-auth";
import {
  normalize,
  type OcrExpectation,
  positiveExpectationMatches,
} from "./ocr-content-rules";
import { resolveViewOcrPolicy } from "./ocr-view-expectations";
import { VIEW_ROUTES } from "./view-routes";

// Strict-gate config (#9304, #10710). The audit was a pure reporter — `broken` /
// `needs-work` verdicts only landed in report.json and never failed a run, so a
// regressed view shipped green. It is now a GATE, DEFAULT-ON on BOTH axes: it
// fails on any `broken` verdict (a real crash / blank render / console error /
// empty view) AND on any `needs-work` verdict (blue / orange→black-hover /
// off-token radius). `resolveAuditStrictFlags` reads the env: each axis stays on unless its
// var is explicitly `"0"`, so a bare `audit:app` enforces the same posture the
// `app-aesthetic-audit.yml` CI lane already forces (both vars `"1"`) — a NEW
// regression fails by default instead of only when someone opts in. Opt OUT with
// `ELIZA_AUDIT_APP_STRICT=0` / `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=0` to triage.
const { strict: AUDIT_STRICT, needsWorkStrict: AUDIT_STRICT_NEEDS_WORK } =
  resolveAuditStrictFlags(process.env);
// Sub-pixel slack for the document-level horizontal-overflow invariant: fractional
// scrollWidth/innerWidth rounding can differ by ~1px on a healthy layout. A real
// un-contained overflow (WS5) blows past this comfortably.
const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 2;
const FRAMED_PAGE_SLUGS = new Set([
  "builtin-character",
  "builtin-character-skills",
  "builtin-database",
  "builtin-experience",
  "builtin-memories",
  "builtin-tasks",
  "builtin-vault",
  "plugin-relationships-gui",
]);
const FRAMED_PAGE_MAX_WIDTH_PX = 1024;
const FRAMED_PAGE_GEOMETRY_TOLERANCE_PX = 2;

async function collectFramedPageGeometryIssues(
  viewRoot: Locator,
): Promise<string[]> {
  const issues: string[] = [];
  const framedPage = viewRoot.locator("[data-framed-page]:visible");
  const framedPageCount = await framedPage.count();
  if (framedPageCount !== 1) {
    issues.push(`view has ${framedPageCount} visible framed-page roots`);
    return issues;
  }
  const body = framedPage.locator(":scope > [data-framed-page-body]:visible");
  const header = framedPage.locator(
    ":scope > [data-framed-page-header]:visible",
  );
  const navigation = framedPage.locator(
    ":scope > [data-framed-page-navigation]:visible",
  );

  const bodyCount = await body.count();
  const headerCount = await header.count();
  if (bodyCount !== 1)
    issues.push(`framed page has ${bodyCount} visible bodies`);
  if (headerCount > 1) {
    issues.push(`framed page has ${headerCount} visible headers`);
  }
  if (bodyCount !== 1 || headerCount > 1) return issues;

  const expectedSlotGeometry = async (slot: Locator) =>
    slot.evaluate((element, maxWidth) => {
      const parent = element.parentElement;
      if (!parent) return null;
      const parentBox = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      const leftInset = Number.parseFloat(style.paddingLeft) || 0;
      const rightInset = Number.parseFloat(style.paddingRight) || 0;
      const availableWidth = parentBox.width - leftInset - rightInset;
      const width = Math.min(availableWidth, maxWidth);
      return {
        width,
        left: parentBox.x + leftInset + (availableWidth - width) / 2,
      };
    }, FRAMED_PAGE_MAX_WIDTH_PX);

  const bodyExpected = await expectedSlotGeometry(body);
  const bodyBox = await body.boundingBox();
  const headerBox = headerCount === 1 ? await header.boundingBox() : null;
  if (!bodyExpected || !bodyBox || (headerCount === 1 && !headerBox)) {
    return [...issues, "framed page geometry could not be measured"];
  }

  if (
    Math.abs(bodyBox.width - bodyExpected.width) >
      FRAMED_PAGE_GEOMETRY_TOLERANCE_PX ||
    Math.abs(bodyBox.x - bodyExpected.left) > FRAMED_PAGE_GEOMETRY_TOLERANCE_PX
  ) {
    issues.push(
      `framed body is ${Math.round(bodyBox.width)}px wide at x=${Math.round(bodyBox.x)}; expected ${Math.round(bodyExpected.width)}px at x=${Math.round(bodyExpected.left)}`,
    );
  }
  if (headerBox && bodyBox.y < headerBox.y + headerBox.height - 1) {
    issues.push("framed body overlaps its header slot");
  }

  const navigationCount = await navigation.count();
  if (navigationCount > 1) {
    issues.push(`framed page has ${navigationCount} visible navigation slots`);
  } else if (navigationCount === 1) {
    const navigationBox = await navigation.boundingBox();
    const navigationExpected = await expectedSlotGeometry(navigation);
    if (!navigationBox || !navigationExpected) {
      issues.push("framed navigation geometry could not be measured");
    } else {
      if (
        Math.abs(navigationBox.width - navigationExpected.width) >
          FRAMED_PAGE_GEOMETRY_TOLERANCE_PX ||
        Math.abs(navigationBox.x - navigationExpected.left) >
          FRAMED_PAGE_GEOMETRY_TOLERANCE_PX
      ) {
        issues.push(
          `framed navigation is ${Math.round(navigationBox.width)}px wide at x=${Math.round(navigationBox.x)}; expected ${Math.round(navigationExpected.width)}px at x=${Math.round(navigationExpected.left)}`,
        );
      }
      if (headerBox && navigationBox.y < headerBox.y + headerBox.height - 1) {
        issues.push("framed navigation overlaps its header slot");
      }
      if (bodyBox.y < navigationBox.y + navigationBox.height - 1) {
        issues.push("framed body overlaps its navigation slot");
      }
    }
  }
  return issues;
}
/**
 * App-side all-views aesthetic audit (#8796) — the agent app's equivalent of
 * cloud-frontend's `audit:cloud`. It walks EVERY view (built-in tabs + plugin
 * view bundles) across the design-review viewport matrix, captures rest +
 * primary-button hover screenshots, runs the blank/one-color analyzer, flags
 * brand-color violations (any blue, orange↔black hover), asserts the floating
 * chat overlay integrates, collects console errors, and writes a per-view
 * `manual-review/<slug>.md` verdict stub + `contact-sheet.html` +
 * `report.json`.
 *
 * It records findings for every view (no first-failure abort, so the 5-loop
 * grind can drive each to `good`), then gates in afterAll: an uncaught page
 * error fails the walk immediately; system-view metric budgets fail the run
 * unconditionally; `broken` verdicts fail under ELIZA_AUDIT_APP_STRICT=1. Output dir:
 * `aesthetic-audit-output/` (override with ELIZA_AUDIT_APP_DIR).
 *
 * Built-in views come from `@elizaos/ui` TAB_PATHS; plugin views from
 * `plugin-view-cases.ts` — the union so no view is silently omitted.
 */

// ── navigation TAB_PATHS coverage guard (#8796) ──────────────────────────────
// Parse the canonical TAB_PATHS straight from the @elizaos/ui navigation source
// (no UI-bundle import) so the guard reads the real table, not a stale copy.
const NAV_INDEX_PATH = fileURLToPath(
  new URL(
    "../../../ui/src/navigation/builtin-route-descriptors.ts",
    import.meta.url,
  ),
);

// {desktop,mobile} × {landscape,portrait}. "desktop" (landscape) and "mobile"
// (portrait) keep their original names so existing AESTHETIC_VERDICT_DEBT keys
// stay valid; the two added entries cover the previously-unverified orientations
// (portrait desktop/tablet, landscape phone) — see #9945.
const VIEWPORTS = [
  { name: "mobile-portrait", width: 390, height: 844 },
  { name: "mobile-landscape", width: 844, height: 390 },
  { name: "desktop-landscape", width: 1440, height: 900 },
  { name: "ipad-portrait", width: 820, height: 1180 },
] as const;

type AuditViewportName = (typeof VIEWPORTS)[number]["name"];

const SYSTEM_VIEW_SLUGS = [
  "builtin-chat",
  "builtin-phone",
  "builtin-apps",
  "builtin-character",
  "builtin-inventory",
  "builtin-browser",
  "builtin-stream",
  "builtin-automations",
  "builtin-settings",
] as const;

type SystemViewSlug = (typeof SYSTEM_VIEW_SLUGS)[number];

function budget(
  maxBorderDividerDensity: number,
  maxTextDensity: number,
  minWhitespaceRatio: number,
): AestheticMetricBudget {
  return {
    maxBorderDividerDensity,
    maxTextDensity,
    minWhitespaceRatio,
  };
}

function viewportBudgets(
  mobilePortrait: AestheticMetricBudget,
  mobileLandscape: AestheticMetricBudget,
  desktopLandscape: AestheticMetricBudget,
  ipadPortrait: AestheticMetricBudget,
): Record<AuditViewportName, AestheticMetricBudget> {
  return {
    "mobile-portrait": mobilePortrait,
    "mobile-landscape": mobileLandscape,
    "desktop-landscape": desktopLandscape,
    "ipad-portrait": ipadPortrait,
  };
}

// #9950 Her-minimal objective gate for the 9 ALL_TAB_GROUPS representatives:
// Chat, Phone, Springboard, Character, Wallet, Browser, Stream, Automations,
// Settings. These are intentionally per-view budgets, with conservative seed
// values from the current rendered tree; they should guard downward as the
// visual pass removes redundant borders/dividers and cramped text.
const SYSTEM_VIEW_METRIC_BUDGETS: Record<
  SystemViewSlug,
  Record<AuditViewportName, AestheticMetricBudget>
> = {
  "builtin-chat": viewportBudgets(
    budget(520, 34, 0.31),
    budget(560, 36, 0.28),
    budget(240, 24, 0.46),
    budget(360, 28, 0.42),
  ),
  "builtin-phone": viewportBudgets(
    budget(820, 28, 0.3),
    budget(900, 32, 0.26),
    budget(420, 24, 0.44),
    budget(560, 26, 0.38),
  ),
  "builtin-apps": viewportBudgets(
    budget(950, 50, 0.24),
    budget(1100, 60, 0.18),
    budget(520, 38, 0.38),
    budget(700, 45, 0.32),
  ),
  "builtin-character": viewportBudgets(
    budget(1150, 64, 0.18),
    budget(1280, 72, 0.14),
    budget(620, 48, 0.34),
    budget(800, 56, 0.28),
  ),
  "builtin-inventory": viewportBudgets(
    budget(900, 48, 0.22),
    budget(1050, 56, 0.16),
    budget(520, 36, 0.38),
    budget(700, 44, 0.32),
  ),
  "builtin-browser": viewportBudgets(
    budget(900, 42, 0.24),
    budget(1050, 50, 0.18),
    budget(520, 34, 0.38),
    budget(700, 40, 0.32),
  ),
  "builtin-stream": viewportBudgets(
    budget(850, 42, 0.24),
    budget(1000, 50, 0.18),
    budget(500, 34, 0.38),
    budget(650, 40, 0.32),
  ),
  "builtin-automations": viewportBudgets(
    budget(1250, 70, 0.16),
    budget(1400, 80, 0.12),
    budget(700, 54, 0.3),
    budget(900, 64, 0.24),
  ),
  "builtin-settings": viewportBudgets(
    budget(1150, 74, 0.16),
    budget(1300, 86, 0.12),
    budget(650, 58, 0.3),
    budget(850, 68, 0.12),
  ),
};

function isSystemViewSlug(slug: string): slug is SystemViewSlug {
  return (SYSTEM_VIEW_SLUGS as readonly string[]).includes(slug);
}

function systemMetricBudgetFor(
  slug: string,
  viewport: AuditViewportName,
): AestheticMetricBudget | null {
  return isSystemViewSlug(slug)
    ? SYSTEM_VIEW_METRIC_BUDGETS[slug][viewport]
    : null;
}

// ── Brand-color analysis: shared scans live in helpers/brand-color-scans ─────
interface ViewFinding {
  slug: string;
  viewport: string;
  path: string;
  ocrControls: AuditOcrControls;
  consoleErrors: string[];
  /** User-visible loading persistence, overlap, or composer legibility failures. */
  renderStateIssues: string[];
  blueColors: string[];
  hoverViolations: string[];
  /** Buttons the hover probe could not drive (hover timeout / detach) — a
   * harness failure surfaced as a finding, not silently swallowed. */
  hoverFailures: string[];
  borderRadiusViolations: string[];
  overlayPresent: boolean;
  overlayClearanceIssues: string[];
  viewType: "gui" | "tui";
  /** Dynamic-bundle identity captured from the real stub response. Plugin
   * routes without a remote registry entry leave these absent. */
  bundleProvenance?: string;
  bundleComponent?: string;
  bundleViewId?: string;
  /** Readable text length in the view root; ~0 means the view never painted. */
  readableChars: number;
  /** Closed OCR policy result used as the view's semantic content authority. */
  semanticReady: boolean;
  /** documentElement.scrollWidth − innerWidth in px (≥0). >tolerance means the
   * page overflows horizontally at the document level — the WS5 transcript bug
   * (overflow-y:auto without overflow-x:hidden). An in-container scroll does not
   * expand documentElement.scrollWidth, so this isolates the un-contained bug. */
  horizontalOverflowPx: number;
  borderDividerCount: number;
  borderDividerDensity: number;
  textDensity: number;
  whitespaceRatio: number;
  /** Rendered viewport area in px² — the divider-density normalization basis. */
  viewportArea: number;
  /** The density probe crashed — surfaced as a finding, NOT scored as a
   * zero-density "perfectly minimal" pass (a crashed probe used to silently
   * satisfy the budget/guard). Non-empty means the metrics below are unknown. */
  densityProbeFailures: string[];
  minimalismBudget: AestheticMetricBudget | null;
  minimalismBudgetViolations: string[];
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: "good" | "needs-work" | "needs-eyeball" | "broken";
}

interface ViewPaintState {
  readableChars: number;
  semanticReady: boolean;
  overlayPresent: boolean;
  /** Visible terminal loading labels or explicit loading-state markers. */
  loadingStateLabels: string[];
}

const TERMINAL_LOADING_LABEL = /^loading(?:\s+view)?(?:\s*(?:…|\.{1,3}))?$/i;

const ACTIVE_VIEW_ROOT_SELECTOR =
  '[data-view-lifecycle-slot][data-view-hidden="false"]';

function semanticRootForView(page: Page, slug: string): Locator {
  return slug === "builtin-chat"
    ? page.getByTestId("home-screen")
    : page.locator(ACTIVE_VIEW_ROOT_SELECTOR);
}

async function readViewPaint(
  viewRoot: Locator,
  overlay: Locator,
  expectation: OcrExpectation,
): Promise<ViewPaintState> {
  const { readableText, loadingStateLabels } = await viewRoot.evaluate(
    (root, terminalLoadingPattern) => {
      const rootElement = root as HTMLElement;
      const isVisibleInViewport = (element: Element): boolean => {
        if (!element.isConnected || element.getClientRects().length === 0) {
          return false;
        }
        for (
          let current: Element | null = element;
          current;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          if (
            (current instanceof HTMLElement && current.hidden) ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.contentVisibility === "hidden" ||
            Number(style.opacity || "1") === 0
          ) {
            return false;
          }
        }

        const rect = element.getBoundingClientRect();
        let visibleLeft = Math.max(rect.left, 0);
        let visibleTop = Math.max(rect.top, 0);
        let visibleRight = Math.min(rect.right, window.innerWidth);
        let visibleBottom = Math.min(rect.bottom, window.innerHeight);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          visibleRight <= visibleLeft ||
          visibleBottom <= visibleTop
        ) {
          return false;
        }

        // Scroll and clipping ancestors can leave a descendant with a nonzero
        // rect while none of its pixels reach the screenshot.
        for (
          let current = element.parentElement;
          current;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          const clipsX = /^(auto|clip|hidden|scroll)$/.test(style.overflowX);
          const clipsY = /^(auto|clip|hidden|scroll)$/.test(style.overflowY);
          if (!clipsX && !clipsY) continue;
          const clip = current.getBoundingClientRect();
          if (clipsX) {
            visibleLeft = Math.max(visibleLeft, clip.left);
            visibleRight = Math.min(visibleRight, clip.right);
          }
          if (clipsY) {
            visibleTop = Math.max(visibleTop, clip.top);
            visibleBottom = Math.min(visibleBottom, clip.bottom);
          }
          if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
            return false;
          }
        }
        return true;
      };

      const elements: Element[] = [
        rootElement,
        ...rootElement.querySelectorAll("*"),
      ];
      const visibleText: string[] = [];
      const loadingLabels = new Set<string>();
      const terminalLoadingLabel = new RegExp(terminalLoadingPattern, "i");
      const inlineTextTags = new Set([
        "A",
        "ABBR",
        "B",
        "CODE",
        "EM",
        "I",
        "LABEL",
        "MARK",
        "S",
        "SMALL",
        "SPAN",
        "STRONG",
        "SUB",
        "SUP",
      ]);
      const laysOutInlineItems = (display: string): boolean =>
        display === "flex" ||
        display === "inline-flex" ||
        display === "grid" ||
        display === "inline-grid";
      const visibleTextOf = (element: Element): string => {
        const pieces: string[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const owner = node.parentElement;
          const text = node.textContent?.trim();
          if (owner && text && isVisibleInViewport(owner)) pieces.push(text);
        }
        return pieces.join(" ").replace(/\s+/g, " ").trim();
      };
      // Candidate loader labels are contiguous visible inline/text runs bounded
      // by block-level siblings, so a bare `<span>Loading</span>` next to ready
      // block content stays terminal while `<span>Loading</span>
      // <span>history</span>` reads as one descriptive phrase.
      const inlineRunLabels = (container: Element): string[] => {
        const labels: string[] = [];
        let run: string[] = [];
        const containerOwnsInlineItems = laysOutInlineItems(
          getComputedStyle(container).display,
        );
        const flush = () => {
          const label = run.join(" ").replace(/\s+/g, " ").trim();
          if (label) labels.push(label);
          run = [];
        };
        for (const child of container.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const owner = child.parentElement;
            const text = child.textContent?.trim();
            if (owner && text && isVisibleInViewport(owner)) run.push(text);
            continue;
          }
          if (!(child instanceof Element)) continue;
          if (!isVisibleInViewport(child)) continue;
          const display = getComputedStyle(child).display;
          if (
            display === "contents" ||
            display.startsWith("inline") ||
            (containerOwnsInlineItems && inlineTextTags.has(child.tagName))
          ) {
            const text = visibleTextOf(child);
            if (text) run.push(text);
          } else {
            flush();
          }
        }
        flush();
        return labels;
      };
      for (const element of elements) {
        if (!isVisibleInViewport(element)) continue;
        for (const child of element.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue;
          const text = child.textContent?.trim();
          if (text) visibleText.push(text);
        }
        if (element.getAttribute("data-view-status") === "loading") {
          loadingLabels.add(
            visibleTextOf(element) ||
              element.textContent?.trim().replace(/\s+/g, " ") ||
              '[data-view-status="loading"]',
          );
        }
        const display = getComputedStyle(element).display;
        const parentDisplay = element.parentElement
          ? getComputedStyle(element.parentElement).display
          : "";
        const parentOwnsThisInlineItem =
          laysOutInlineItems(parentDisplay) &&
          inlineTextTags.has(element.tagName);
        if (
          !parentOwnsThisInlineItem &&
          display !== "contents" &&
          !display.startsWith("inline")
        ) {
          for (const label of inlineRunLabels(element)) {
            if (terminalLoadingLabel.test(label)) loadingLabels.add(label);
          }
        }
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          const text = (element.value || element.placeholder).trim();
          if (text) visibleText.push(text);
        } else if (element instanceof HTMLSelectElement) {
          const text = element.selectedOptions[0]?.textContent?.trim();
          if (text) visibleText.push(text);
        }
      }

      return {
        readableText: visibleText.join(" ").replace(/\s+/g, " ").trim(),
        loadingStateLabels: [...loadingLabels],
      };
    },
    TERMINAL_LOADING_LABEL.source,
  );
  const semanticReady = positiveExpectationMatches(
    normalize(readableText),
    expectation,
  );
  const overlayPresent = await overlay.evaluateAll((nodes) =>
    nodes.some((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }),
  );
  return {
    readableChars: readableText.length,
    semanticReady,
    overlayPresent,
    loadingStateLabels,
  };
}

async function waitForSettledViewPaint(
  page: Page,
  readPaint: () => Promise<ViewPaintState>,
  overlayRequired: boolean,
): Promise<ViewPaintState> {
  let paint = await readPaint();
  for (
    let attempt = 0;
    attempt < 12 &&
    (!paint.semanticReady ||
      (overlayRequired && !paint.overlayPresent) ||
      paint.loadingStateLabels.length > 0);
    attempt += 1
  ) {
    await page.waitForTimeout(1000);
    paint = await readPaint();
  }
  return paint;
}

function loadingRenderStateIssues(paint: ViewPaintState): string[] {
  if (paint.loadingStateLabels.length === 0) return [];
  return [
    `dynamic view remained in its loading state after 12 seconds: ${paint.loadingStateLabels.join(
      ", ",
    )}`,
  ];
}

async function settleHomeEntrance(page: Page): Promise<void> {
  const home = page.getByTestId("home-screen");
  if ((await home.count()) === 0) return;

  // Readable clock text appears before the staggered home cards have reached
  // full opacity, so the generic paint probe is intentionally insufficient for
  // this one surface. Wait on the named production animation instead of a fixed
  // timeout so screenshots and OCR observe the same settled pixels at every
  // viewport and remain fast when the animation has already completed.
  await page.waitForFunction(
    () => {
      const root = document.querySelector('[data-testid="home-screen"]');
      if (!(root instanceof HTMLElement)) return false;
      return !root
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            (animation as CSSAnimation).animationName === "home-enter" &&
            animation.playState !== "finished",
        );
    },
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Check radii against the active theme's declared tokens, the shared preset
 * scale, and the chat capsule endpoint. Theme changes must not turn valid
 * token-based components into off-scale findings.
 */
async function collectBorderRadiusViolations(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const presetPx = [0, 3, 6, 8, 12, 16, 20, 24, 32];
    const radiusTokens = [
      "--radius-xs",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--radius-2xl",
      "--radius-3xl",
      "--radius-search",
      "--notification-source-radius",
    ];
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const tokenPixels = (style: CSSStyleDeclaration) =>
      radiusTokens.flatMap((token) => {
        const value = style.getPropertyValue(token).trim();
        if (/^\d*\.?\d+px$/.test(value)) return [Number.parseFloat(value)];
        if (/^\d*\.?\d+rem$/.test(value))
          return [Number.parseFloat(value) * rootFontSize];
        return [];
      });
    const tolerance = 1;
    const isAllowed = (value: string, allowedPx: number[]): boolean => {
      const v = value.trim().toLowerCase();
      if (!v || v === "none" || v === "auto") return true;
      // A shorthand can list up to 4 corners (space- or slash-separated); each
      // corner must be on-scale for the element to pass.
      const parts = v.split(/[\s/]+/).filter(Boolean);
      if (parts.length > 1) return parts.every((p) => isAllowed(p, allowedPx));
      // Full-round shapes: explicit pill radius or any percentage ≥ 50% (a
      // 50%/100% radius renders a circle/pill, which is a deliberate shape).
      if (v === "9999px" || v === "50%" || v === "100%") return true;
      const pctMatch = v.match(/^(\d+\.?\d*)%$/);
      if (pctMatch) return Number(pctMatch[1]) >= 50;
      const pxMatch = v.match(/^(\d+\.?\d*)px$/);
      if (pxMatch) {
        const px = Number(pxMatch[1]);
        if (px >= 1000) return true; // any huge px = pill rounding
        return allowedPx.some((a) => Math.abs(px - a) <= tolerance);
      }
      // Unknown unit/keyword we cannot evaluate → don't flag (avoid noise).
      return true;
    };
    const out = new Set<string>();
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      const cs = getComputedStyle(node as Element);
      // borderRadius is the shorthand; sample a corner too in case the
      // shorthand serializes to "" (mixed corners on some engines).
      const candidates = [cs.borderRadius, cs.borderTopLeftRadius];
      for (const value of candidates) {
        if (value && !isAllowed(value, [...presetPx, ...tokenPixels(cs)]))
          out.add(value);
      }
    }
    return Array.from(out);
  });
  return raw;
}

interface AestheticDensityMetrics {
  borderDividerCount: number;
  borderDividerDensity: number;
  textDensity: number;
  whitespaceRatio: number;
  /** Viewport px² the densities were normalized by. 0 = measurement failed. */
  viewportArea: number;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

async function collectAestheticDensityMetrics(
  page: Page,
): Promise<AestheticDensityMetrics> {
  return page.evaluate(() => {
    const viewportWidth = Math.max(
      document.documentElement.clientWidth,
      window.innerWidth,
      1,
    );
    const viewportHeight = Math.max(
      document.documentElement.clientHeight,
      window.innerHeight,
      1,
    );
    const viewportArea = viewportWidth * viewportHeight;
    const cellSize = 10;
    const cols = Math.ceil(viewportWidth / cellSize);
    const rows = Math.ceil(viewportHeight / cellSize);
    const occupied = new Uint8Array(cols * rows);

    const alphaOf = (color: string): number => {
      const c = color.trim().toLowerCase();
      if (!c || c === "transparent") return 0;
      const rgb = c.match(
        /^rgba?\(\s*\d+\.?\d*\s*,\s*\d+\.?\d*\s*,\s*\d+\.?\d*(?:\s*,\s*(\d+\.?\d*))?\s*\)$/,
      );
      if (rgb) return rgb[1] === undefined ? 1 : Number(rgb[1]);
      // Computed CSS color functions are already resolved by Chromium for most
      // values; if one remains, treat it as visible rather than silently missing
      // a divider/background.
      return 1;
    };

    const rectIntersectsViewport = (rect: DOMRect): boolean =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;

    const markRect = (rect: DOMRect): void => {
      if (!rectIntersectsViewport(rect)) return;
      const left = Math.max(0, Math.floor(rect.left / cellSize));
      const top = Math.max(0, Math.floor(rect.top / cellSize));
      const right = Math.min(cols - 1, Math.floor((rect.right - 1) / cellSize));
      const bottom = Math.min(
        rows - 1,
        Math.floor((rect.bottom - 1) / cellSize),
      );
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          occupied[y * cols + x] = 1;
        }
      }
    };

    const visibleElement = (element: Element): boolean => {
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0.02
      ) {
        return false;
      }
      return Array.from(element.getClientRects()).some(rectIntersectsViewport);
    };

    let textChars = 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const raw = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
          if (!raw) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript") {
            return NodeFilter.FILTER_REJECT;
          }
          // The floating chat shell is mounted over every GUI view and has its
          // own overlay presence/clearance checks below. Keep transient overlay
          // copy out of per-view text-density guards so a global boot banner
          // does not make unrelated plugin views look more cramped.
          if (
            parent.closest("[data-chat-overlay], [data-testid='chat-overlay']")
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest("[data-aesthetic-audit-ignore-text-density]")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!visibleElement(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const isInsideGlobalOverlay = (element: Element): boolean =>
      Boolean(
        element.closest("[data-chat-overlay], [data-testid='chat-overlay']"),
      );

    for (
      let textNode = walker.nextNode();
      textNode;
      textNode = walker.nextNode()
    ) {
      const text = textNode.textContent?.trim().replace(/\s+/g, " ") ?? "";
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rects = Array.from(range.getClientRects()).filter(
        rectIntersectsViewport,
      );
      range.detach();
      if (rects.length === 0) continue;
      textChars += text.length;
      for (const rect of rects) markRect(rect);
    }

    let borderDividerCount = 0;
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      if (isInsideGlobalOverlay(node)) continue;
      if (!visibleElement(node)) continue;
      const style = getComputedStyle(node);
      const rects = Array.from(node.getClientRects()).filter(
        rectIntersectsViewport,
      );
      if (rects.length === 0) continue;

      const sideWidths = [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ];
      const sideStyles = [
        style.borderTopStyle,
        style.borderRightStyle,
        style.borderBottomStyle,
        style.borderLeftStyle,
      ];
      const sideColors = [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ];
      const visibleBorderWidths = [0, 0, 0, 0];
      let visibleBorderSides = 0;
      for (let i = 0; i < sideWidths.length; i += 1) {
        const width = Number.parseFloat(sideWidths[i] || "0");
        if (
          width >= 0.5 &&
          sideStyles[i] !== "none" &&
          sideStyles[i] !== "hidden" &&
          alphaOf(sideColors[i]) > 0.02
        ) {
          visibleBorderWidths[i] = width;
          visibleBorderSides += 1;
        }
      }
      borderDividerCount += visibleBorderSides;

      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute("role");
      const primaryRect = rects[0];
      const thinHorizontal = primaryRect.height <= 2 && primaryRect.width >= 24;
      const thinVertical = primaryRect.width <= 2 && primaryRect.height >= 24;
      const hasDividerBackground =
        alphaOf(style.backgroundColor) > 0.02 &&
        (thinHorizontal || thinVertical);
      if (tag === "hr" || role === "separator" || hasDividerBackground) {
        borderDividerCount += 1;
      }

      const hasVisibleBackground = alphaOf(style.backgroundColor) > 0.02;
      const hasShadow = style.boxShadow !== "none";
      const isMedia = /^(canvas|img|picture|svg|video)$/.test(tag);
      const isControl = node.matches(
        "button, input, textarea, select, summary, [role='button'], [role='tab'], [role='switch'], [role='checkbox'], [contenteditable='true']",
      );
      const largestRectArea = Math.max(
        ...rects.map((rect) => rect.width * rect.height),
      );
      const isPageShell =
        node === document.body ||
        node.id === "root" ||
        tag === "main" ||
        largestRectArea > viewportArea * 0.72;
      if (!isPageShell) {
        const occupiesCompleteRect =
          hasDividerBackground ||
          hasShadow ||
          isMedia ||
          isControl ||
          (hasVisibleBackground && largestRectArea <= viewportArea * 0.45);
        if (occupiesCompleteRect) {
          for (const rect of rects) markRect(rect);
        } else if (visibleBorderSides > 0) {
          // A border occupies its edge, not the empty space it encloses. The
          // previous full-rectangle mark made one large outlined empty state
          // look denser than a screen packed with controls. Keep the 10px-grid
          // estimate conservative by marking each visible edge strip.
          for (const rect of rects) {
            const [topWidth, rightWidth, bottomWidth, leftWidth] =
              visibleBorderWidths;
            if (topWidth > 0) {
              markRect(new DOMRect(rect.left, rect.top, rect.width, topWidth));
            }
            if (rightWidth > 0) {
              markRect(
                new DOMRect(
                  rect.right - rightWidth,
                  rect.top,
                  rightWidth,
                  rect.height,
                ),
              );
            }
            if (bottomWidth > 0) {
              markRect(
                new DOMRect(
                  rect.left,
                  rect.bottom - bottomWidth,
                  rect.width,
                  bottomWidth,
                ),
              );
            }
            if (leftWidth > 0) {
              markRect(
                new DOMRect(rect.left, rect.top, leftWidth, rect.height),
              );
            }
          }
        }
      }
    }

    let occupiedCells = 0;
    for (const cell of occupied) occupiedCells += cell;
    const whitespaceRatio =
      occupied.length === 0 ? 1 : 1 - occupiedCells / occupied.length;

    return {
      borderDividerCount,
      borderDividerDensity: Number(
        (borderDividerCount / (viewportArea / 1_000_000)).toFixed(4),
      ),
      textDensity: Number((textChars / (viewportArea / 10_000)).toFixed(4)),
      whitespaceRatio: Number(whitespaceRatio.toFixed(4)),
      viewportArea,
    };
  });
}

async function collectOverlayClearanceIssues(
  page: Page,
  overlaySelector: string,
): Promise<string[]> {
  return page.evaluate((selector) => {
    const overlay = document.querySelector(selector);
    if (!overlay) return [];
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const issues: string[] = [];
    const isVisible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.02
      );
    };
    const overlayRects = Array.from(
      overlay.querySelectorAll(
        [
          "[data-testid='chat-sheet']",
          "[data-testid='chat-pill']",
          "[data-testid='chat-sheet-grabber']",
          "button",
          "textarea",
          "input",
          "[role='button']",
        ].join(","),
      ),
    )
      .filter((element) => {
        if (!isVisible(element)) return false;
        const style = getComputedStyle(element);
        const testId = element.getAttribute("data-testid");
        return style.pointerEvents !== "none" || testId === "chat-sheet";
      })
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const rects =
      overlayRects.length > 0
        ? overlayRects
        : [overlay.getBoundingClientRect()];
    const margin = 1;
    for (const rect of rects) {
      if (
        rect.left < -margin ||
        rect.top < -margin ||
        rect.right > viewportWidth + margin ||
        rect.bottom > viewportHeight + margin
      ) {
        issues.push(
          `overlay clipped (${Math.round(rect.left)},${Math.round(
            rect.top,
          )} ${Math.round(rect.width)}x${Math.round(
            rect.height,
          )} in ${viewportWidth}x${viewportHeight})`,
        );
        break;
      }
    }

    const overlapArea = (a: DOMRect, b: DOMRect): number => {
      const width = Math.max(
        0,
        Math.min(a.right, b.right) - Math.max(a.left, b.left),
      );
      const height = Math.max(
        0,
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
      );
      return width * height;
    };
    const isUsableRect = (rect: DOMRect): boolean =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
    const intersectRects = (a: DOMRect, b: DOMRect): DOMRect => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return new DOMRect(
        left,
        top,
        Math.max(0, right - left),
        Math.max(0, bottom - top),
      );
    };
    const viewportRect = new DOMRect(0, 0, viewportWidth, viewportHeight);
    const clipRectToVisibleAncestors = (
      rect: DOMRect,
      owner: Element,
    ): DOMRect => {
      let clipped = intersectRects(rect, viewportRect);
      let ancestor: Element | null = owner.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (
          /(auto|scroll|hidden|clip)/.test(
            `${style.overflowX} ${style.overflowY}`,
          )
        ) {
          clipped = intersectRects(clipped, ancestor.getBoundingClientRect());
          if (!isUsableRect(clipped)) return clipped;
        }
        ancestor = ancestor.parentElement;
      }
      return clipped;
    };
    const collectControlVisualRects = (control: Element): DOMRect[] => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const owner =
          node.parentElement && control.contains(node.parentElement)
            ? node.parentElement
            : control;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(
          ...Array.from(range.getClientRects()).map((rect) =>
            clipRectToVisibleAncestors(rect, owner),
          ),
        );
        range.detach();
      }
      for (const element of Array.from(
        control.querySelectorAll(
          "svg, img, canvas, video, input, textarea, select, [role='switch'], [role='checkbox']",
        ),
      )) {
        if (!isVisible(element)) continue;
        rects.push(
          clipRectToVisibleAncestors(element.getBoundingClientRect(), element),
        );
      }
      return rects.filter(isUsableRect);
    };
    const controls = Array.from(
      document.querySelectorAll(
        "button, a[href], input, textarea, select, summary, [role='button'], [role='link'], [role='tab'], [role='switch'], [role='checkbox'], [contenteditable='true']",
      ),
    ).slice(0, 400);
    for (const control of controls) {
      if (overlay.contains(control) || control.contains(overlay)) continue;
      if (control.closest("[data-aesthetic-overlay-ignore='true']")) continue;
      const style = getComputedStyle(control);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0.02
      ) {
        continue;
      }
      const rect = control.getBoundingClientRect();
      const visibleControlRect = clipRectToVisibleAncestors(rect, control);
      if (!isUsableRect(visibleControlRect)) continue;
      const visualRects = collectControlVisualRects(control);
      const testRects =
        visualRects.length > 0 ? visualRects : [visibleControlRect];
      const visualArea = testRects.reduce(
        (total, visualRect) => total + visualRect.width * visualRect.height,
        0,
      );
      const area = testRects.reduce(
        (total, visualRect) =>
          total +
          rects.reduce(
            (rectTotal, overlayRect) =>
              rectTotal + overlapArea(overlayRect, visualRect),
            0,
          ),
        0,
      );
      // Ignore tiny edge grazes: they are usually fractional text/control rect
      // slivers from the floating composer sitting near the content, not a
      // blocked tap target. Real obstruction still trips either the absolute or
      // relative threshold comfortably.
      if (area < 160 || area < visualArea * 0.25) continue;
      // Views intentionally continue underneath the floating composer. A
      // control is obstructed only when it cannot be reached, including by
      // scrolling its normal viewport above the overlay.
      const canHitControl = () => {
        const visible = clipRectToVisibleAncestors(
          control.getBoundingClientRect(),
          control,
        );
        if (!isUsableRect(visible)) return false;
        const hit = document.elementFromPoint(
          visible.x + visible.width / 2,
          visible.y + visible.height / 2,
        );
        return (
          hit !== null &&
          !overlay.contains(hit) &&
          (hit === control || control.contains(hit))
        );
      };
      if (canHitControl()) continue;
      const ancestors: { element: Element; top: number; left: number }[] = [];
      let scrollParent = control.parentElement;
      while (scrollParent) {
        const scrollStyle = getComputedStyle(scrollParent);
        if (
          scrollParent.scrollHeight > scrollParent.clientHeight + 1 &&
          (/(auto|scroll)/.test(scrollStyle.overflowY) ||
            scrollParent === document.scrollingElement)
        ) {
          ancestors.push({
            element: scrollParent,
            top: scrollParent.scrollTop,
            left: scrollParent.scrollLeft,
          });
        }
        scrollParent = scrollParent.parentElement;
      }
      if (ancestors.length > 0) {
        let reachable = false;
        try {
          control.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          });
          reachable = canHitControl();
        } finally {
          for (const saved of ancestors) {
            saved.element.scrollTop = saved.top;
            saved.element.scrollLeft = saved.left;
          }
        }
        if (reachable) continue;
      }
      const label =
        (
          control.getAttribute("aria-label") ||
          control.textContent?.trim().replace(/\s+/g, " ") ||
          control.getAttribute("data-testid") ||
          control.tagName.toLowerCase()
        )
          .slice(0, 36)
          .trim() || control.tagName.toLowerCase();
      issues.push(`overlay overlaps "${label}" (${Math.round(area)}px²)`);
      if (issues.length >= 5) break;
    }
    return issues;
  }, overlaySelector);
}

/** Flex-column siblings must flow rather than paint through each other. */
async function collectSpatialOverlapIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const label = (element: HTMLElement): string =>
      (
        element.getAttribute("data-agent-id") ||
        element.textContent?.trim().replace(/\s+/g, " ") ||
        element.getAttribute("data-spatial-kind") ||
        element.tagName.toLowerCase()
      ).slice(0, 48);
    for (const box of Array.from(
      document.querySelectorAll<HTMLElement>("*"),
    ).slice(0, 4000)) {
      if (
        box.closest(
          "[data-chat-overlay], [data-testid='chat-overlay'], [data-aesthetic-overlap-ignore='true']",
        )
      ) {
        continue;
      }
      const style = getComputedStyle(box);
      if (style.display !== "flex" || style.flexDirection !== "column") {
        continue;
      }
      const children = Array.from(box.children).filter(
        (child): child is HTMLElement => {
          if (!(child instanceof HTMLElement)) return false;
          const childStyle = getComputedStyle(child);
          const rect = child.getBoundingClientRect();
          return (
            childStyle.display !== "none" &&
            childStyle.visibility !== "hidden" &&
            childStyle.position !== "absolute" &&
            childStyle.position !== "fixed" &&
            rect.width > 0 &&
            rect.height > 0
          );
        },
      );
      for (let index = 1; index < children.length; index += 1) {
        const previous = children[index - 1];
        const current = children[index];
        const previousRect = previous.getBoundingClientRect();
        const currentRect = current.getBoundingClientRect();
        const horizontalIntersection =
          Math.min(previousRect.right, currentRect.right) -
          Math.max(previousRect.left, currentRect.left);
        const verticalOverlap = previousRect.bottom - currentRect.top;
        if (horizontalIntersection > 1 && verticalOverlap > 1) {
          issues.push(
            `spatial column overlaps "${label(previous)}" with "${label(current)}" by ${Math.round(verticalOverlap)}px`,
          );
          if (issues.length >= 5) return issues;
        }
      }
    }

    if (window.innerHeight > 520) return issues;

    const textRects: Array<{
      element: HTMLElement;
      rect: DOMRect;
      text: string;
    }> = [];
    const clipToVisibleAncestors = (
      source: DOMRect,
      element: HTMLElement,
    ): DOMRect => {
      let left = Math.max(0, source.left);
      let top = Math.max(0, source.top);
      let right = Math.min(window.innerWidth, source.right);
      let bottom = Math.min(window.innerHeight, source.bottom);
      for (
        let ancestor: HTMLElement | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      return new DOMRect(
        left,
        top,
        Math.max(0, right - left),
        Math.max(0, bottom - top),
      );
    };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (
      let node = walker.nextNode();
      node && textRects.length < 600;
      node = walker.nextNode()
    ) {
      const text = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
      const element = node.parentElement;
      if (!text || !element) continue;
      const closedDetails = element.closest("details:not([open])");
      if (
        closedDetails &&
        !closedDetails.querySelector(":scope > summary")?.contains(element)
      ) {
        continue;
      }
      if (
        element.closest(
          ".sr-only, [aria-hidden='true'], [hidden], [data-chat-overlay], [data-testid='chat-overlay'], [data-aesthetic-overlap-ignore='true']",
        )
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0.02
      ) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rawRect of range.getClientRects()) {
        const rect = clipToVisibleAncestors(rawRect, element);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ) {
          textRects.push({ element, rect, text: text.slice(0, 32) });
        }
      }
      range.detach();
    }
    textRects.sort((left, right) => left.rect.top - right.rect.top);
    for (let left = 0; left < textRects.length; left += 1) {
      const first = textRects[left];
      for (let right = left + 1; right < textRects.length; right += 1) {
        const second = textRects[right];
        if (second.rect.top >= first.rect.bottom - 4) break;
        if (
          first.element.contains(second.element) ||
          second.element.contains(first.element)
        ) {
          continue;
        }
        const overlapWidth =
          Math.min(first.rect.right, second.rect.right) -
          Math.max(first.rect.left, second.rect.left);
        const overlapHeight =
          Math.min(first.rect.bottom, second.rect.bottom) -
          Math.max(first.rect.top, second.rect.top);
        if (
          overlapWidth > 2 &&
          overlapHeight > 4 &&
          overlapWidth * overlapHeight >= 32
        ) {
          issues.push(
            `text overlaps "${first.text}" with "${second.text}" (${Math.round(overlapWidth)}×${Math.round(overlapHeight)}px)`,
          );
          if (issues.length >= 5) return issues;
        }
      }
    }
    return issues;
  });
}

/** A hosted spatial view must fill the shell content width. */
async function collectSpatialSizingIssues(page: Page): Promise<string[]> {
  return page.locator("[data-spatial-surface]").evaluateAll((surfaces) =>
    surfaces.flatMap((surface) => {
      if (!(surface instanceof HTMLElement)) return [];
      const rect = surface.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const sideClearance =
        Number.parseFloat(
          rootStyle.getPropertyValue("--eliza-chat-side-clearance"),
        ) || 0;
      const surfaceStyle = getComputedStyle(surface);
      const duplicatePadding =
        Number.parseFloat(surfaceStyle.paddingInlineEnd) || 0;
      const usableWidth = rect.width - duplicatePadding;
      const pageContent = surface.closest("[data-page-content]");
      const pageContentStyle = pageContent
        ? getComputedStyle(pageContent)
        : null;
      const pageContentWidth = pageContent
        ? pageContent.getBoundingClientRect().width -
          (Number.parseFloat(pageContentStyle?.paddingInlineStart ?? "0") ||
            0) -
          (Number.parseFloat(pageContentStyle?.paddingInlineEnd ?? "0") || 0)
        : Number.POSITIVE_INFINITY;
      const expectedWidth = Math.min(
        window.innerWidth - sideClearance,
        pageContentWidth,
      );
      if (usableWidth >= expectedWidth * 0.8) return [];
      return [
        `spatial surface underfills shell content (${Math.round(usableWidth)}/${Math.round(expectedWidth)}px usable; ${Math.round(duplicatePadding)}px nested clearance)`,
      ];
    }),
  );
}

/** A resting empty composer must not grow just to wrap its placeholder. */
async function collectComposerLegibilityIssues(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="chat-composer-textarea"]')
    .evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        if (!(node instanceof HTMLTextAreaElement) || node.value) return [];
        const placeholder = node.placeholder.trim();
        const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
        const height = node.getBoundingClientRect().height;
        if (!placeholder || !Number.isFinite(lineHeight) || lineHeight <= 0) {
          return [];
        }
        return height > lineHeight * 2.25
          ? [
              `composer placeholder wraps beyond two lines (${Math.round(height / lineHeight)} lines): "${placeholder.slice(0, 48)}"`,
            ]
          : [];
      }),
    );
}

function renderManualReviewStub(finding: ViewFinding): string {
  const lines = [
    `# ${finding.slug} (${finding.viewport})`,
    "",
    `- **path:** \`${finding.path}\``,
    `- **bundle provenance:** ${finding.bundleProvenance ?? "n/a (not a remote-bundle route)"}`,
    `- **bundle component:** ${finding.bundleComponent ?? "n/a"}`,
    `- **bundle view id:** ${finding.bundleViewId ?? "n/a"}`,
    `- **verdict:** ${finding.verdict}`,
    `- **console errors:** ${finding.consoleErrors.length}`,
    `- **render-state issues:** ${finding.renderStateIssues.length ? finding.renderStateIssues.join("; ") : "none"}`,
    `- **blue colors (banned):** ${finding.blueColors.length ? finding.blueColors.join(", ") : "none"}`,
    `- **border-radius violations (off-token):** ${finding.borderRadiusViolations.length ? finding.borderRadiusViolations.join(", ") : "none"}`,
    `- **orange↔black hover violations:** ${finding.hoverViolations.length ? finding.hoverViolations.join("; ") : "none"}`,
    `- **hover probe failures:** ${finding.hoverFailures.length ? finding.hoverFailures.join("; ") : "none"}`,
    `- **density probe failures:** ${finding.densityProbeFailures.length ? finding.densityProbeFailures.join("; ") : "none"}`,
    `- **floating chat overlay present:** ${finding.overlayPresent ? "yes" : "NO"}`,
    `- **floating chat overlay clearance:** ${finding.overlayClearanceIssues.length ? finding.overlayClearanceIssues.join("; ") : "clear"}`,
    `- **readable content chars:** ${finding.readableChars}`,
    `- **declared semantic content:** ${finding.semanticReady ? "ready" : "MISSING"}`,
    `- **horizontal overflow:** ${finding.horizontalOverflowPx}px${finding.horizontalOverflowPx > HORIZONTAL_OVERFLOW_TOLERANCE_PX ? " ⚠ OVERFLOW" : ""}`,
    `- **border/divider density:** ${roundMetric(finding.borderDividerDensity)} (${finding.borderDividerCount} edges / 1M px)`,
    `- **text density:** ${roundMetric(finding.textDensity)} chars / 10K px`,
    `- **whitespace ratio:** ${roundMetric(finding.whitespaceRatio)}`,
    `- **minimalism budget:** ${finding.minimalismBudget ? (finding.minimalismBudgetViolations.length ? finding.minimalismBudgetViolations.join("; ") : "pass") : "n/a"}`,
    `- **screenshot quality issues:** ${finding.qualityIssues.length ? finding.qualityIssues.join("; ") : "none"}`,
    "",
    "## Notes",
    "",
    "_Fill in: visual issues, layout breaks, e2e gaps. Set verdict to one of:_",
    "_`good` · `needs-work` · `needs-eyeball` · `broken`._",
    "",
  ];
  return lines.join("\n");
}

interface RemoteBundleAuditProof {
  auditPath: string;
  bundlePath: string;
  componentExport: string;
  response: Promise<import("@playwright/test").Response>;
}

async function forceRemoteBundleAuditRoute(
  page: Page,
  view: AuditViewCase,
): Promise<RemoteBundleAuditProof | null> {
  if (view.kind !== "plugin") return null;
  if (view.id === "cloud" && view.fixtureState !== "cloud-signed-out") {
    const connectedCloudResponses = new Map<string, unknown>([
      [
        "/api/cloud/status",
        {
          connected: true,
          enabled: true,
          hasApiKey: true,
          userId: "audit-user",
          organizationId: "audit-org",
        },
      ],
      [
        "/api/cloud/credits",
        {
          connected: true,
          balance: 42.5,
          low: false,
          critical: false,
          topUpUrl: "https://cloud.eliza.app/cloud/billing",
        },
      ],
      [
        "/api/cloud/compat/agents",
        {
          success: true,
          data: [
            {
              agent_id: "audit-agent",
              agent_name: "Research agent",
              node_id: null,
              container_id: null,
              headscale_ip: null,
              bridge_url: null,
              web_ui_url: null,
              status: "running",
              agent_config: {},
              created_at: "2026-08-01T00:00:00.000Z",
              updated_at: "2026-08-01T00:00:00.000Z",
              containerUrl: "",
              webUiUrl: null,
              database_status: "healthy",
              error_message: null,
              last_heartbeat_at: null,
            },
          ],
        },
      ],
      [
        "/api/cloud/billing/summary",
        {
          balance: 42.5,
          currency: "USD",
          hasPaymentMethod: true,
        },
      ],
    ]);
    await page.route("**/api/cloud/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!connectedCloudResponses.has(pathname)) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(connectedCloudResponses.get(pathname)),
      });
    });
  }
  if (view.id === "computer-use-sessions") {
    await page.route("**/api/computer-use/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              contractVersion: 2,
              id: "audit-browser",
              ownerId: "audit-owner",
              adapterId: "browser:chrome-profile",
              canonicalState: "ready",
              isolationMode: "exclusive_target",
              generation: 1,
              label: "Research browser",
              target: { kind: "browser", targetId: "chrome-profile" },
              status: "idle",
              sequence: 12,
              createdAt: "2026-08-19T00:00:00.000Z",
              updatedAt: "2026-08-19T00:00:12.000Z",
              cursor: {
                x: 640,
                y: 360,
                updatedAt: "2026-08-19T00:00:12.000Z",
              },
              lastCommand: "browser_click",
              lastObservation: {
                observationId: "audit-browser:observation:12",
                sequence: 12,
                observedAt: "2026-08-19T00:00:12.000Z",
                sha256:
                  "edee29f882543b956620b57ce980341d7304d4a09a5c4860f616185c9fc0f584",
                mimeType: "image/png",
                source: "browser",
                width: 1280,
                height: 720,
              },
            },
            {
              contractVersion: 2,
              id: "audit-sandbox",
              ownerId: "audit-owner",
              adapterId: "sandbox:qemu-linux",
              canonicalState: "running",
              isolationMode: "exclusive_target",
              generation: 1,
              label: "Linux sandbox",
              target: { kind: "sandbox", targetId: "qemu-linux" },
              status: "running",
              sequence: 7,
              createdAt: "2026-08-19T00:00:00.000Z",
              updatedAt: "2026-08-19T00:00:11.000Z",
              lastCommand: "mouse_move",
            },
          ],
          events: [
            {
              eventId: 1,
              type: "action_completed",
              sessionId: "audit-browser",
              occurredAt: "2026-08-19T00:00:12.000Z",
              command: "browser_click",
              outcomeStatus: "succeeded",
            },
          ],
          readiness: {
            capture: { available: true, tool: "screencapture" },
            input: { available: true, tool: "cliclick" },
            browser: { available: true, tool: "browser-bridge" },
            vision: { available: true, modelType: "IMAGE_DESCRIPTION" },
            approvalMode: "ask",
          },
        }),
      });
    });
    await page.route(
      /\/api\/computer-use\/sessions\/[^/]+\/frame$/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            frame: {
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              capturedAt: "2026-08-19T00:00:13.000Z",
              width: 1280,
              height: 720,
              provenance: {
                observationId: "audit-browser:observation:13",
                sequence: 13,
                observedAt: "2026-08-19T00:00:13.000Z",
                sha256:
                  "9a1f7b9f13c8fc64b5f60f5034ef77e60e9c45ef0d8c109c56f6c38a9eb966af",
                mimeType: "image/png",
                source: "browser",
                width: 1280,
                height: 720,
              },
            },
          }),
        });
      },
    );
  }
  // The long capture matrix keeps the fixture server busy enough for a single
  // socket reset to occur without indicating an application failure. Playwright
  // limits maxRetries to ECONNRESET, while HTTP and parse failures still fail
  // this registry boundary immediately.
  const registryResponse = await page.request.get("/api/views", {
    maxRetries: 2,
  });
  expect(registryResponse.ok(), "plugin view registry must load").toBe(true);
  const payload: unknown = await registryResponse.json();
  const registered = findRemoteBundleDeclaration(
    payload,
    view.id,
    view.viewType,
  );
  if (!registered) return null;

  const auditPath = `/__audit/plugin-view/${encodeURIComponent(registered.id)}`;
  const bundlePath = new URL(registered.bundleUrl, "http://audit.local")
    .pathname;
  await page.route("**/api/views", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: registryResponse.status(),
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        views: (payload as { views: unknown[] }).views.map((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          "id" in entry &&
          entry.id === registered.id &&
          ("viewType" in entry ? entry.viewType : "gui") === view.viewType
            ? { ...entry, path: auditPath }
            : entry,
        ),
      }),
    });
  });
  return {
    auditPath,
    bundlePath,
    componentExport: registered.componentExport,
    response: page.waitForResponse(
      (response) => new URL(response.url()).pathname === bundlePath,
    ),
  };
}

test.describe("all-views aesthetic audit (#8796)", () => {
  const outputDir =
    process.env.ELIZA_AUDIT_APP_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output");

  // The outer Playwright runner resets this directory exactly once. Cleanup
  // cannot live in a test hook because Playwright reruns hooks in replacement
  // workers, which would erase screenshots from tests that passed before a retry.

  // Coverage guard: the audit must walk EVERY built-in view. Fails on a phantom
  // key, a path drift, or any distinct navigation route the audit doesn't cover —
  // so a newly-added tab fails the suite until it is added to BUILTIN_TAB_PATHS.
  test("builtin coverage matches navigation TAB_PATHS", () => {
    const navPaths = parseNavigationTabPaths(
      readFileSync(NAV_INDEX_PATH, "utf8"),
    );
    const navKeys = new Set(Object.keys(navPaths));
    const navDistinctPaths = new Set(Object.values(navPaths));
    const inlinedKeys = Object.keys(BUILTIN_TAB_PATHS);
    const inlinedPaths = new Set(Object.values(BUILTIN_TAB_PATHS));

    const phantomKeys = inlinedKeys.filter((k) => !navKeys.has(k));
    expect(
      phantomKeys,
      `audit BUILTIN_TAB_PATHS has keys not in navigation TAB_PATHS: ${phantomKeys.join(", ")}`,
    ).toEqual([]);

    const mismatched = inlinedKeys.filter(
      (k) => BUILTIN_TAB_PATHS[k] !== navPaths[k],
    );
    expect(
      mismatched,
      `audit BUILTIN_TAB_PATHS path drift vs navigation: ${mismatched.join(", ")}`,
    ).toEqual([]);

    const pluginOwnedAliases = new Set([
      "/apps/relationships",
      "/phone",
      "/messages",
      "/contacts",
    ]);
    const uncovered = [...navDistinctPaths].filter(
      (p) => !inlinedPaths.has(p) && !pluginOwnedAliases.has(p),
    );
    expect(
      uncovered,
      `navigation TAB_PATHS adds routes the audit does not cover: ${uncovered.join(", ")}`,
    ).toEqual([]);

    // Same guard for the shared `./view-routes` VIEW_ROUTES table (consumed by
    // all-views-interaction.spec.ts and tap-target-geometry-all-views.spec.ts):
    // it must stay a superset of navigation TAB_PATHS — agree on the path for
    // every shared id and cover every distinct navigation route. Extra
    // VIEW_ROUTES entries (non-tab surfaces like /settings/voice) are allowed.
    const viewRoutePaths = Object.fromEntries(
      VIEW_ROUTES.map((r) => [r.id, r.path]),
    );
    const viewRouteDistinctPaths = new Set(Object.values(viewRoutePaths));

    const viewRouteMismatched = Object.keys(viewRoutePaths).filter(
      (k) => k in navPaths && viewRoutePaths[k] !== navPaths[k],
    );
    expect(
      viewRouteMismatched,
      `view-routes VIEW_ROUTES path drift vs navigation: ${viewRouteMismatched.join(", ")}`,
    ).toEqual([]);

    const viewRouteUncovered = [...navDistinctPaths].filter(
      (p) => !viewRouteDistinctPaths.has(p),
    );
    expect(
      viewRouteUncovered,
      `navigation TAB_PATHS adds routes view-routes VIEW_ROUTES does not cover: ${viewRouteUncovered.join(", ")}`,
    ).toEqual([]);
  });

  test("framed geometry checks headerless bodies and still detects overlap", async ({
    page,
  }) => {
    await page.setContent(`<main><div data-framed-page style="padding:16px">
      <nav data-framed-page-navigation style="max-width:1024px;margin:auto;height:40px">Navigation</nav>
      <section data-framed-page-body style="max-width:1024px;margin:auto;height:100px">Content</section>
    </div></main>`);
    const root = page.locator("main");
    await expect(collectFramedPageGeometryIssues(root)).resolves.toEqual([]);
    await page.locator("[data-framed-page-body]").evaluate((body) => {
      body.style.marginTop = "-20px";
    });
    await expect(collectFramedPageGeometryIssues(root)).resolves.toContain(
      "framed body overlaps its navigation slot",
    );
  });

  test("radius audit accepts active theme tokens and rejects arbitrary rounding", async ({
    page,
  }) => {
    await page.setContent(`<style>:root { --radius-xl:18px; --radius-2xl:22px; }</style>
      <div style="border-radius:var(--radius-xl)">Rounded</div>
      <div style="border-radius:var(--radius-2xl)">Rounded</div>`);
    await expect(collectBorderRadiusViolations(page)).resolves.toEqual([]);
    await page
      .locator("div")
      .first()
      .evaluate((node) => {
        node.style.borderRadius = "37px";
      });
    await expect(collectBorderRadiusViolations(page)).resolves.toContain(
      "37px",
    );
  });

  test("overlay clearance checks scroll reachability without reserving a footer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 400 });
    await page.setContent(`<style>body{margin:0}</style>
      <main style="height:400px;overflow:auto"><div style="height:340px"></div>
        <button style="height:40px;width:200px">Reachable action</button><div style="height:100px"></div></main>
      <div data-test-overlay style="position:fixed;bottom:0;left:0;width:400px;height:80px;background:black"></div>`);
    await expect(
      collectOverlayClearanceIssues(page, "[data-test-overlay]"),
    ).resolves.toEqual([]);
    await expect(
      page.locator("main").evaluate((node) => node.scrollTop),
    ).resolves.toBe(0);
    await page.locator("button").evaluate((node) => {
      node.style.position = "fixed";
      node.style.bottom = "0";
    });
    await expect(
      collectOverlayClearanceIssues(page, "[data-test-overlay]"),
    ).resolves.toEqual([expect.stringContaining("overlay overlaps")]);
  });

  test("view readiness surfaces loading and measurement failures", async ({
    page,
  }) => {
    const appsPolicy = resolveViewOcrPolicy("builtin-apps");
    const tasksPolicy = resolveViewOcrPolicy("builtin-tasks");
    const focusPolicy = resolveViewOcrPolicy("plugin-focus-gui");
    if (appsPolicy.kind !== "expectation") {
      throw new Error("builtin-apps must declare a semantic expectation");
    }
    if (tasksPolicy.kind !== "expectation") {
      throw new Error("builtin-tasks must declare a semantic expectation");
    }
    if (focusPolicy.kind !== "expectation") {
      throw new Error("plugin-focus-gui must declare a semantic expectation");
    }

    await page.setContent(`
      <main>
        <section data-view-lifecycle-slot="cached-apps" data-view-hidden="true">
          <h1>Projects</h1>
          <p>Install, create, and run your elizaOS apps.</p>
        </section>
        <section data-view-lifecycle-slot="apps" data-view-hidden="false">Loading…</section>
        <div data-test-overlay>Ask Eliza</div>
      </main>
    `);
    const viewRoot = semanticRootForView(page, "builtin-apps");
    const overlay = page.locator("[data-test-overlay]");

    await expect(
      readViewPaint(viewRoot, overlay, appsPolicy.expectation),
    ).resolves.toEqual({
      readableChars: "Loading…".length,
      semanticReady: false,
      overlayPresent: true,
      loadingStateLabels: ["Loading…"],
    });

    await viewRoot.evaluate((root) => {
      root.innerHTML = "<h1>Projects</h1>";
    });
    await expect(
      readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
    ).resolves.toMatchObject({ semanticReady: false });

    await viewRoot.evaluate((root) => {
      root.textContent = "No focus session active";
    });
    await expect(
      readViewPaint(viewRoot, overlay, focusPolicy.expectation),
    ).resolves.toEqual({
      readableChars: "No focus session active".length,
      semanticReady: true,
      overlayPresent: true,
      loadingStateLabels: [],
    });

    await viewRoot.evaluate((root) => {
      root.innerHTML =
        '<div style="position: relative; overflow: hidden; width: 100px; height: 1px"><div style="position: absolute; top: 20px"><h1>Projects</h1><p>Install, create, and run your elizaOS apps.</p></div></div>';
    });
    await expect(
      readViewPaint(viewRoot, overlay, appsPolicy.expectation),
    ).resolves.toMatchObject({ semanticReady: false });

    await viewRoot.evaluate((root) => {
      root.innerHTML =
        '<div hidden data-view-status="loading">Loading view</div><div style="position: relative; overflow: hidden; width: 100px; height: 1px"><div data-view-status="loading" style="position: absolute; top: 20px">Loading view</div></div><h1>Projects</h1><p>Install, create, and run your elizaOS apps.</p>';
    });
    await expect(
      readViewPaint(viewRoot, overlay, appsPolicy.expectation),
    ).resolves.toMatchObject({
      semanticReady: true,
      loadingStateLabels: [],
    });

    await viewRoot.evaluate((root) => {
      root.innerHTML =
        '<div data-view-status="loading">Loading view</div><h1>Projects</h1><p>Install, create, and run your elizaOS apps.</p>';
    });
    await expect(
      readViewPaint(viewRoot, overlay, appsPolicy.expectation),
    ).resolves.toMatchObject({
      semanticReady: true,
      loadingStateLabels: ["Loading view"],
    });

    await viewRoot.evaluate((root) => {
      root.innerHTML =
        "<h1>Tasks</h1><div>Loading</div><div>Loading history</div>";
    });
    const terminalLoading = await readViewPaint(
      viewRoot,
      overlay,
      tasksPolicy.expectation,
    );
    expect(terminalLoading).toMatchObject({
      semanticReady: true,
      loadingStateLabels: ["Loading"],
    });
    expect(loadingRenderStateIssues(terminalLoading)).toEqual([
      "dynamic view remained in its loading state after 12 seconds: Loading",
    ]);

    await viewRoot.evaluate((root) => {
      root.innerHTML = "<h1>Tasks</h1><span>Loading</span>";
    });
    await expect(
      readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
    ).resolves.toMatchObject({
      semanticReady: true,
      loadingStateLabels: ["Loading"],
    });

    for (const terminalInlineLayout of [
      '<div style="display: flex"><span>Loading</span></div>',
      '<div style="display: grid"><span>Loading</span></div>',
    ]) {
      await viewRoot.evaluate((root, content) => {
        root.innerHTML = `<h1>Tasks</h1>${content}`;
      }, terminalInlineLayout);
      await expect(
        readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
      ).resolves.toMatchObject({
        semanticReady: true,
        loadingStateLabels: ["Loading"],
      });
    }

    for (const descriptiveLoading of [
      "<div>Loading <span>history</span></div>",
      "<div><span>Loading</span> <span>history</span></div>",
      '<div style="display: flex; gap: 4px"><span>Loading</span><span>history</span></div>',
      '<div style="display: grid; grid-template-columns: auto auto; gap: 4px"><span>Loading</span><span>history</span></div>',
    ]) {
      await viewRoot.evaluate((root, content) => {
        root.innerHTML = `<h1>Tasks</h1>${content}`;
      }, descriptiveLoading);
      await expect(
        readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
      ).resolves.toMatchObject({
        semanticReady: true,
        loadingStateLabels: [],
      });
    }

    await viewRoot.evaluate((root) => {
      root.innerHTML =
        '<h1>Tasks</h1><div hidden>Loading</div><div style="display: none">Loading...</div><div style="position: relative; overflow: hidden; width: 100px; height: 1px"><div style="position: absolute; top: 20px">Loading view</div></div><p>No coding tasks yet</p>';
    });
    await expect(
      readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
    ).resolves.toMatchObject({
      semanticReady: true,
      loadingStateLabels: [],
    });

    await viewRoot.evaluate((root) => {
      root.innerHTML = "<h1>Tasks</h1><div>Loading...</div>";
      window.setTimeout(() => {
        root.innerHTML = "<h1>Tasks</h1><p>No coding tasks yet</p>";
      }, 20);
    });
    await expect(
      waitForSettledViewPaint(
        page,
        () => readViewPaint(viewRoot, overlay, tasksPolicy.expectation),
        true,
      ),
    ).resolves.toMatchObject({
      semanticReady: true,
      loadingStateLabels: [],
    });

    await page.setContent(`
      <section data-testid="home-screen">
        <h1>Mostly clear</h1>
        <p>Learn conversational Spanish</p>
      </section>
      <div data-test-overlay>Ask Eliza</div>
    `);
    const chatPolicy = resolveViewOcrPolicy("builtin-chat");
    if (chatPolicy.kind !== "expectation") {
      throw new Error("builtin-chat must declare a semantic expectation");
    }
    await expect(
      readViewPaint(
        semanticRootForView(page, "builtin-chat"),
        page.locator("[data-test-overlay]"),
        chatPolicy.expectation,
      ),
    ).resolves.toMatchObject({ semanticReady: true });

    await page.setContent(`
      <section data-view-lifecycle-slot="camera" data-view-hidden="false">
        <div>View unavailable This app is unavailable here Install or enable it App: camera Retry Back to views</div>
      </section>
      <div data-test-overlay>Ask Eliza</div>
    `);
    const cameraPolicy = resolveViewOcrPolicy("builtin-camera");
    if (cameraPolicy.kind !== "semantic-exemption") {
      throw new Error("builtin-camera must declare a semantic exemption");
    }
    // The complete browser fallback is painted; this does not certify the
    // native Camera surface, which still needs separate native acceptance.
    await expect(
      readViewPaint(
        semanticRootForView(page, "builtin-camera"),
        page.locator("[data-test-overlay]"),
        cameraPolicy.fallbackExpectation,
      ),
    ).resolves.toMatchObject({ semanticReady: true });

    for (const incompleteOrUnrelatedFallback of [
      "View unavailable Retry",
      "Settings Wallet Projects",
    ]) {
      const cameraRoot = semanticRootForView(page, "builtin-camera");
      await cameraRoot.evaluate((root, text) => {
        root.textContent = text;
      }, incompleteOrUnrelatedFallback);
      await expect(
        readViewPaint(
          cameraRoot,
          page.locator("[data-test-overlay]"),
          cameraPolicy.fallbackExpectation,
        ),
      ).resolves.toMatchObject({ semanticReady: false });
    }

    await page.setContent("<main>first</main><main>second</main>");
    await expect(
      readViewPaint(page.locator("main"), overlay, appsPolicy.expectation),
    ).rejects.toThrow(/strict mode violation/);
  });

  for (const view of buildAuditViewCases()) {
    for (const vp of VIEWPORTS) {
      test(`${view.slug} ${vp.name}`, async ({ page }) => {
        const reviewDir = path.join(outputDir, "manual-review");
        const shotDir = path.join(outputDir, vp.name);
        await mkdir(reviewDir, { recursive: true });
        await mkdir(shotDir, { recursive: true });

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          // The deterministic stub backend answers some routes with 501 / no
          // network; those console errors are EXPECTED in this harness (same
          // rationale as builtin-views-visual.spec) and are not a quality
          // signal — only real, non-network console errors count.
          if (
            /\b501\b|failed to (load|fetch)|net::err|networkerror|status (of )?50\d|err_/i.test(
              text,
            )
          ) {
            return;
          }
          consoleErrors.push(text);
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await seedAppStorage(page);
        await seedStewardSession(page, { jwt: true });
        await installDefaultAppRoutes(page);
        if (view.fixtureState === "family-interview") {
          // Capture the real renderer's private answer form against explicit read-only empty inventories.
          await page.route(
            "**/api/lifeops/family-workflows/intake?*",
            async (route) => {
              if (route.request().method() !== "GET") {
                await route.fallback();
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ reviews: [], sources: [] }),
              });
            },
          );
          await page.route(
            "**/api/lifeops/family-workflows/email-options",
            async (route) => {
              if (route.request().method() !== "GET") {
                await route.fallback();
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  options: { accounts: [], recipients: [] },
                }),
              });
            },
          );
        }
        const remoteBundleProof = await forceRemoteBundleAuditRoute(page, view);
        await openAppPath(page, remoteBundleProof?.auditPath ?? view.path);
        const bundleResponse = remoteBundleProof
          ? await remoteBundleProof.response
          : null;
        if (bundleResponse && remoteBundleProof) {
          expect(
            bundleResponse.status(),
            `${view.slug} must load its production dynamic bundle`,
          ).toBe(200);
          expect(
            bundleResponse.headers()["x-eliza-view-bundle-provenance"],
          ).toBe("real-dist");
          expect(bundleResponse.headers()["x-eliza-view-component"]).toBe(
            remoteBundleProof.componentExport,
          );
          expect(bundleResponse.headers()["x-eliza-view-id"]).toBe(view.id);
        }

        if (view.fixtureState === "family-interview") {
          await page
            .getByRole("button", { name: "Monthly packet", exact: true })
            .click();
          await page
            .getByText("Fill missing information", { exact: true })
            .click();
          const interview = page.getByRole("form", { name: "Owner interview" });
          await interview.getByLabel("Topic").selectOption("school");
          await interview
            .getByRole("radio", { name: "I have an update", exact: true })
            .check();
          await interview
            .getByLabel("Your update")
            .fill("Please confirm who will handle school pickup on Friday.");
          await interview
            .getByRole("checkbox", { name: "This update needs an answer" })
            .check();
          const saveAnswer = interview.getByRole("button", {
            name: "Save private answer",
          });
          await expect(saveAnswer).toBeEnabled();
          // Exercise the actual shell hit target without persisting fixture data.
          // A floating composer must not prevent the owner reaching the action.
          await saveAnswer.click({ trial: true });
          const discardAnswer = interview.getByRole("button", {
            name: "Discard answer",
          });
          await discardAnswer.focus();
          await page.keyboard.press("Enter");
          await expect(interview.getByLabel("Your update")).toHaveCount(0);
          await expect(saveAnswer).toBeDisabled();
          await interview
            .getByRole("radio", { name: "I have an update", exact: true })
            .check();
          await interview
            .getByLabel("Your update")
            .fill("Please confirm who will handle school pickup on Friday.");
          await interview
            .getByRole("checkbox", { name: "This update needs an answer" })
            .check();
          await saveAnswer.click({ trial: true });
        }

        // The shell and composer paint before lazy views settle, so readiness is
        // measured inside the active lifecycle slot. Chat's ambient HomeScreen
        // is the sole route outside that host. Both use the same closed semantic
        // contract that later judges screenshot OCR.
        const viewRoot = semanticRootForView(page, view.slug);
        await viewRoot.waitFor({ state: "visible", timeout: 15_000 });
        const ocrPolicy = resolveViewOcrPolicy(view.slug);
        const semanticExpectation =
          ocrPolicy.kind === "expectation"
            ? ocrPolicy.expectation
            : ocrPolicy.fallbackExpectation;
        const overlayRequired =
          view.viewType !== "tui" &&
          !OVERLAY_NATIVE_OR_CANVAS_SLUGS.has(view.slug);
        const overlaySelector = [
          "[data-chat-overlay]",
          "[data-testid='chat-overlay']",
          "[data-testid='chat-sheet']",
          "[data-testid='chat-pill']",
          "[data-testid='chat-composer-textarea']",
        ].join(", ");
        const readPaint = () =>
          readViewPaint(
            viewRoot,
            page.locator(overlaySelector),
            semanticExpectation,
          );
        const paint = await waitForSettledViewPaint(
          page,
          readPaint,
          overlayRequired,
        );
        if (view.id === "cloud" && view.fixtureState !== "cloud-signed-out") {
          await expect(
            viewRoot.getByTestId("cloud-ready"),
            "the Cloud plugin audit must capture the connected account state",
          ).toBeVisible();
        }
        if (view.fixtureState === "cloud-signed-out") {
          await expect(
            viewRoot.getByTestId("cloud-signed-out"),
            "the Cloud plugin audit must preserve the disconnected recovery state",
          ).toBeVisible();
          await expect(
            viewRoot.getByText("Connected", { exact: true }),
          ).toHaveCount(0);
        }
        if (view.id === "cloud") {
          const oppositePolicy = resolveViewOcrPolicy(
            view.fixtureState === "cloud-signed-out"
              ? "plugin-cloud-gui"
              : "plugin-cloud-signed-out-gui",
          );
          if (oppositePolicy.kind !== "expectation") {
            throw new Error(
              "Cloud account states must declare semantic content",
            );
          }
          await expect(
            readViewPaint(
              viewRoot,
              page.locator(overlaySelector),
              oppositePolicy.expectation,
            ),
            "the rendered Cloud account must not satisfy the opposite auth state",
          ).resolves.toMatchObject({ semanticReady: false });
        }
        await settleHomeEntrance(page);
        const { readableChars, semanticReady, overlayPresent } = paint;
        const renderStateIssues = [
          ...loadingRenderStateIssues(paint),
          ...(!paint.semanticReady
            ? [
                "view did not reach its declared semantic content after 12 seconds",
              ]
            : []),
          ...(await collectSpatialOverlapIssues(page)),
          ...(await collectSpatialSizingIssues(page)),
          ...(await collectComposerLegibilityIssues(page)),
          ...(FRAMED_PAGE_SLUGS.has(view.slug)
            ? await collectFramedPageGeometryIssues(viewRoot)
            : []),
        ];

        // Document-level horizontal-overflow invariant (WS5). Measured, not
        // swallowed: a genuine measurement failure throws and fails the view
        // rather than fabricating 0 ("no overflow" = healthy) from a catch.
        const horizontalOverflowPx = await page.evaluate(() => {
          const de = document.documentElement;
          const scrollWidth = Math.max(
            de.scrollWidth,
            document.body?.scrollWidth ?? 0,
          );
          const innerWidth = window.innerWidth || de.clientWidth;
          return Math.max(0, Math.round(scrollWidth - innerWidth));
        });

        // Screenshot with a blank-retry (mirrors captureScreenshotWithQualityRetry):
        // re-sample a few times so a momentarily-unpainted frame is not recorded
        // as a one-color "broken".
        const restPath = path.join(shotDir, `${view.slug}.png`);
        const measureControls = () =>
          page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
            rectangles: Array.from(
              document.querySelectorAll(
                'button, a[href], [role="button"], input[type="button"], input[type="submit"]',
              ),
            ).flatMap((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0 ||
                rect.width <= 0 ||
                rect.height <= 0
              )
                return [];
              return [
                {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                },
              ];
            }),
          }));
        let controlGeometry = await measureControls();
        let buffer = await page.screenshot({ path: restPath, fullPage: false });
        let quality = await analyzeScreenshot(buffer).catch(() => null);
        for (
          let attempt = 0;
          attempt < 3 && quality && quality.colorBuckets <= 1;
          attempt += 1
        ) {
          await page.waitForTimeout(800);
          controlGeometry = await measureControls();
          buffer = await page.screenshot({ path: restPath, fullPage: false });
          quality = await analyzeScreenshot(buffer).catch(() => null);
        }
        const qualityIssues = quality
          ? screenshotQualityIssues(`${view.slug} ${vp.name}`, quality)
          : [];

        const ocrControls = await bindAuditOcrControls(buffer, controlGeometry);

        const blueColors = await collectBlueColors(page).catch(() => []);
        const { violations: hoverViolations, hoverFailures } =
          await collectHoverViolations(page).catch((error: unknown) => ({
            violations: [],
            // The whole hover scan failing is itself a finding, not a silent pass.
            hoverFailures: [
              `hover scan failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            ],
          }));
        const borderRadiusViolations = await collectBorderRadiusViolations(
          page,
        ).catch(() => []);
        const overlayClearanceIssues = overlayPresent
          ? await collectOverlayClearanceIssues(page, overlaySelector).catch(
              (error: unknown) => [
                `overlay clearance probe failed: ${error instanceof Error ? error.message : String(error)}`,
              ],
            )
          : [];
        // A crashed density probe must NOT read as zero-density "perfectly
        // minimal" — that silently satisfied both the budget and the guard.
        // Record the failure (surfaced like hoverFailures) and skip scoring the
        // placeholder zeros so the probe crash can never manufacture a pass.
        const densityProbeFailures: string[] = [];
        const densityMetrics = await collectAestheticDensityMetrics(page).catch(
          (error: unknown) => {
            densityProbeFailures.push(
              `density probe failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            );
            return {
              borderDividerCount: 0,
              borderDividerDensity: 0,
              textDensity: 0,
              whitespaceRatio: 1,
              viewportArea: 0,
            };
          },
        );
        const densityProbeOk = densityProbeFailures.length === 0;
        const minimalismBudget = systemMetricBudgetFor(view.slug, vp.name);
        const minimalismBudgetViolations =
          minimalismBudget && densityProbeOk
            ? evaluateAestheticMetricBudget(densityMetrics, minimalismBudget)
            : [];

        const base = {
          slug: view.slug,
          viewport: vp.name,
          path: view.path,
          ocrControls,
          viewType: view.viewType,
          bundleProvenance:
            bundleResponse?.headers()["x-eliza-view-bundle-provenance"],
          bundleComponent: bundleResponse?.headers()["x-eliza-view-component"],
          bundleViewId: bundleResponse?.headers()["x-eliza-view-id"],
          consoleErrors,
          renderStateIssues,
          blueColors,
          hoverViolations,
          hoverFailures,
          borderRadiusViolations,
          overlayPresent,
          overlayClearanceIssues,
          readableChars,
          semanticReady,
          horizontalOverflowPx,
          ...densityMetrics,
          densityProbeFailures,
          minimalismBudget,
          minimalismBudgetViolations,
          quality,
          qualityIssues,
        };
        const finding: ViewFinding = {
          ...base,
          verdict: computeVerdict(base),
        };
        await writeAuditFinding(outputDir, finding);

        await writeFile(
          path.join(reviewDir, `${view.slug}-${vp.name}.md`),
          renderManualReviewStub(finding),
          "utf8",
        );

        // Only a real crash fails the walk; design findings live in the report.
        expect(
          pageErrors,
          `${view.slug} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);

        // Horizontal-overflow invariant is always recorded (report.json +
        // mvp-visual-verify consumes it) and hard-gated only under strict, so the
        // reporter run never turns green-but-overflowing into a soft finding.
        if (AUDIT_STRICT) {
          expect(
            horizontalOverflowPx,
            `${view.slug} ${vp.name} overflows horizontally by ${horizontalOverflowPx}px ` +
              `(documentElement.scrollWidth exceeds innerWidth — likely overflow-y ` +
              `without overflow-x:hidden)`,
          ).toBeLessThanOrEqual(HORIZONTAL_OVERFLOW_TOLERANCE_PX);
        }
        if (view.slug === "builtin-relationships") {
          // Measure and capture the rest state above before scrolling. The
          // actual last-row action must remain reachable beneath the composer.
          const lastRowAction = viewRoot.getByRole("button", {
            name: "Open Acme Corp",
            exact: true,
          });
          await lastRowAction.scrollIntoViewIfNeeded();
          const messageResponse = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              /\/api\/conversations\/[^/]+\/messages$/.test(
                new URL(response.url()).pathname,
              ),
          );
          await lastRowAction.click();
          const response = await messageResponse;
          expect(response.status()).toBe(200);
          expect(response.request().postDataJSON()).toMatchObject({
            text: "Tell me about ent-acme in my relationships graph.",
            channelType: "DM",
          });
        }
        if (view.fixtureState === "cloud-signed-out") {
          await viewRoot
            .getByRole("button", { name: "Connect in Settings", exact: true })
            .click();
          await expect(page).toHaveURL(/\/settings(?:[?#]|$)/);
          const settingsRoot = page.locator(
            '[data-view-lifecycle-slot="settings"][data-view-hidden="false"]',
          );
          await expect(settingsRoot).toBeVisible();
          await expect(
            settingsRoot.getByText("Voice", { exact: true }).first(),
          ).toBeVisible();
        }
      });
    }
  }

  test.afterAll(async () => {
    const findings = await readAuditFindings<ViewFinding>(outputDir);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "report.json"),
      JSON.stringify(findings, null, 2),
      "utf8",
    );
    const rows = findings
      .map(
        (f) =>
          `<tr><td>${f.slug}</td><td>${f.viewport}</td><td>${f.verdict}</td>` +
          `<td>${f.consoleErrors.length}</td><td>${f.blueColors.length}</td>` +
          `<td>${f.borderRadiusViolations.length}</td>` +
          `<td>${f.hoverViolations.length}${f.hoverFailures.length ? ` (+${f.hoverFailures.length} probe-failed)` : ""}</td><td>${f.overlayPresent ? "✓" : "✗"}</td>` +
          `<td>${f.overlayClearanceIssues.length}</td>` +
          `<td>${roundMetric(f.borderDividerDensity)}</td>` +
          `<td>${roundMetric(f.textDensity)}</td>` +
          `<td>${roundMetric(f.whitespaceRatio)}</td>` +
          `<td>${f.minimalismBudgetViolations.length ? f.minimalismBudgetViolations.join("<br>") : "✓"}</td>` +
          `</tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>app aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>view</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>radius</th><th>hover</th>` +
        `<th>overlay</th><th>overlay clearance</th><th>border/divider density</th>` +
        `<th>text density</th><th>whitespace ratio</th><th>minimalism budget</th>` +
        `</tr>` +
        `${rows}</table>`,
      "utf8",
    );

    // Gate (#9304, #10710). Always log the verdict tally; the strict fail lives
    // in the pure `evaluateStrictGate` (unit-tested in test/audit): it fails on
    // any undebted `broken` view when `strict` is on, and — with
    // `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=1` — on any undebted `needs-work` too.
    const broken = findings.filter((f) => f.verdict === "broken");
    const needsWork = findings.filter((f) => f.verdict === "needs-work");
    const minimalismBudgetFailures = findings.filter(
      (f) => f.minimalismBudgetViolations.length > 0,
    );
    const gate = evaluateStrictGate(findings, {
      strict: AUDIT_STRICT,
      needsWorkStrict: AUDIT_STRICT_NEEDS_WORK,
    });
    const hoverProbeFailures = findings.filter(
      (f) => f.hoverFailures.length > 0,
    );
    const densityProbeFailures = findings.filter(
      (f) => f.densityProbeFailures.length > 0,
    );
    console.log(
      `[aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length} ` +
        `minimalism-budget-failures=${minimalismBudgetFailures.length} ` +
        `hover-probe-failures=${hoverProbeFailures.length} ` +
        `density-probe-failures=${densityProbeFailures.length} ` +
        `(strict=${AUDIT_STRICT}, needs-work-strict=${AUDIT_STRICT_NEEDS_WORK}, ` +
        `undebted-broken=${gate.undebtedBroken.length}, ` +
        `undebted-needs-work=${gate.undebtedNeedsWork.length})`,
    );
    if (hoverProbeFailures.length > 0) {
      // Surfaced, not gated: a hover probe that cannot drive a button is a
      // harness reliability signal, recorded per view in report.json and the
      // manual-review stubs.
      const detail = hoverProbeFailures
        .map(
          (f) => `  ${f.slug} @ ${f.viewport}: ${f.hoverFailures.join("; ")}`,
        )
        .join("\n");
      console.log(`[aesthetic-audit] hover probe failures:\n${detail}`);
    }
    if (minimalismBudgetFailures.length > 0) {
      const detail = minimalismBudgetFailures
        .map(
          (f) =>
            `  ${f.slug} @ ${f.viewport}: ${f.minimalismBudgetViolations.join(
              "; ",
            )}`,
        )
        .join("\n");
      throw new Error(
        `[aesthetic-audit] Minimalism metric budget failed for ` +
          `${minimalismBudgetFailures.length} system view(s):\n${detail}\n` +
          `Update the UI to reduce divider/text density or increase whitespace; ` +
          `only adjust SYSTEM_VIEW_METRIC_BUDGETS after an intentional reviewed design change.`,
      );
    }
    if (gate.failed) {
      throw new Error(gate.message);
    }
  });
});
