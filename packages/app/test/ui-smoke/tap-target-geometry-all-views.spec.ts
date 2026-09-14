/**
 * Measures real mobile hit targets and accessible control semantics across the
 * built-in views, using populated fixtures where controls depend on stored data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { devices, expect, type Page, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";
import { VIEW_ROUTES } from "./view-routes";

// Coarse-pointer mobile emulation: the `@media (pointer: coarse)` touch floor
// only applies on touch devices, and that is exactly the class of device where
// tap-target size matters. Pixel 7 keeps parity with the shipped Capacitor
// Android WebView viewport the interaction specs already exercise.
test.use({ ...devices["Pixel 7"] });

/** Apple HIG floor, with 0.5px slack for sub-pixel layout rounding. */
const MIN_TAP_PX = 44 - 0.5;

// Machine-readable run report (per-view control records + violation counts),
// written under the package cwd alongside the other Playwright artifacts.
const REPORT_DIR = path.resolve("test-results", "tap-target-geometry");

type ControlKind = "geometry" | "coherence";

type ControlRecord = {
  view: string;
  descriptor: string;
  width: number;
  height: number;
  status: "pass" | "violation" | "exception";
  kind: ControlKind;
  reason: string;
};

/**
 * Documented per-view exceptions for controls that survive the in-page filters
 * but are known-acceptable below the floor. Keyed by view id; each entry is a
 * substring/regex match against the control descriptor plus a written reason.
 * Empty until a real run proves a control genuinely warrants an exception —
 * every entry is a decision on the record, not a silent skip.
 */
const DOCUMENTED_EXCEPTIONS: Record<
  string,
  ReadonlyArray<{ match: RegExp; reason: string }>
> = {};

const DOCUMENTED_ZERO_CONTROL_VIEWS: Record<string, string> = {
  "pendant-transcript":
    "Designed disconnected pendant transcript state has no standalone controls when no pendant session is paired.",
};

/**
 * Collect, classify, and (in-page) exception-filter every interactive control
 * in the current view. Runs entirely in the page so geometry + computed style +
 * ancestry are read in a single round trip.
 */
async function collectControls(
  page: Page,
  view: string,
): Promise<ControlRecord[]> {
  const raw = await page.evaluate(
    ({ minTap }) => {
      const INTERACTIVE_SELECTOR = [
        "button",
        "[role=button]",
        "[role=tab]",
        "[role=switch]",
        "[role=menuitem]",
        "[role=menuitemcheckbox]",
        "[role=menuitemradio]",
        "[role=option]",
        "[role=link]",
        "[role=checkbox]",
        "[role=radio]",
        "a[href]",
        "input:not([type=hidden])",
        "select",
        "textarea",
        // Agent-surface elements: only the tappable roles. Bare [data-agent-id]
        // also matched role="region" surfaces (default), which are containers
        // and legitimately non-44px.
        "[data-agent-id][data-agent-role=button]",
        "[data-agent-id][data-agent-role=tab]",
      ].join(",");

      const NATIVE_IMPLICIT_ROLE: Record<string, string> = {
        button: "button",
        a: "link",
        // A plain <select> maps to "combobox"; only multiple/size>1 maps to
        // "listbox" (covered via NATIVE_ROLE_OVERRIDES below).
        select: "combobox",
        textarea: "textbox",
      };

      // Explicit roles ARIA-in-HTML permits on each native element even though
      // they differ from the implicit role.
      const NATIVE_ROLE_OVERRIDES: Record<string, readonly string[]> = {
        button: [
          "checkbox",
          "combobox",
          "link",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "option",
          "radio",
          "switch",
          "tab",
        ],
        a: [
          "button",
          "tab",
          "menuitem",
          "option",
          "switch",
          "checkbox",
          "radio",
        ],
        select: ["listbox"],
        textarea: ["combobox"],
      };

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const accessibleName = (el: Element): string => {
        const attr = (n: string) => el.getAttribute(n)?.trim() || "";
        const labelledby = attr("aria-labelledby");
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean);
          if (parts.length) return parts.join(" ");
        }
        const aria = attr("aria-label");
        if (aria) return aria;
        const title = attr("title");
        if (title) return title;
        const htmlEl = el as HTMLElement;
        const text = (htmlEl.innerText || htmlEl.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text;
        // Form controls take their name from an associated <label>.
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(
            `label[for="${CSS.escape(id)}"]`,
          );
          const labelText = label?.textContent?.replace(/\s+/g, " ").trim();
          if (labelText) return labelText;
        }
        const parentLabel = el.closest("label");
        const parentLabelText = parentLabel?.textContent
          ?.replace(/\s+/g, " ")
          .trim();
        if (parentLabelText) return parentLabelText;
        const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
        if (alt) return alt;
        return "";
      };

      const isFocusable = (el: Element): boolean => {
        const tag = el.tagName.toLowerCase();
        if (
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea"
        ) {
          return !(el as HTMLButtonElement).disabled;
        }
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0)
          return true;
        return (el as HTMLElement).isContentEditable === true;
      };

      const isDisabled = (el: Element): boolean =>
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true";

      const describe = (el: Element, name: string): string => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const type = el.getAttribute("type");
        return [
          tag,
          role ? `role=${role}` : null,
          type ? `type=${type}` : null,
          name ? `name="${name.slice(0, 60)}"` : "name=<none>",
        ]
          .filter(Boolean)
          .join(" ");
      };

      const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
      const results: Array<{
        descriptor: string;
        width: number;
        height: number;
        status: "pass" | "violation" | "exception";
        kind: "geometry" | "coherence";
        reason: string;
      }> = [];

      for (const el of nodes) {
        // Machinery hidden from the accessibility tree (for example a file
        // input driven by a visible upload button) is not an independent
        // interactive control and must not be assigned a fabricated name.
        if (el.closest('[aria-hidden="true"]')) continue;

        const name = accessibleName(el);
        const descriptor = describe(el, name);
        const tag = el.tagName.toLowerCase();
        const explicitRole = el.getAttribute("role");
        const type = (el.getAttribute("type") || "").toLowerCase();

        // ── role <-> DOM-node coherence ─────────────────────────────────────
        // A conflicting explicit ARIA role on a native interactive element
        // (e.g. <button role="link">, <a href role="button"> where the redundant
        // role fights the native semantics) confuses AT users. A redundant role
        // that MATCHES the implicit role is allowed.
        const implicit = NATIVE_IMPLICIT_ROLE[tag];
        if (
          explicitRole &&
          implicit &&
          explicitRole !== implicit &&
          !(NATIVE_ROLE_OVERRIDES[tag] ?? []).includes(explicitRole) &&
          // <a> without href has no implicit link role, so an explicit role is fine.
          !(tag === "a" && !el.getAttribute("href"))
        ) {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: `explicit role="${explicitRole}" conflicts with native <${tag}> implicit role="${implicit}"`,
          });
        }
        // A non-native element carrying an interactive role must be keyboard
        // focusable, otherwise it is a mouse-only "fake" control.
        const isNative =
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea";
        if (
          !isNative &&
          explicitRole &&
          [
            "button",
            "link",
            "tab",
            "switch",
            "menuitem",
            "checkbox",
            "radio",
          ].includes(explicitRole) &&
          isVisible(el) &&
          !isFocusable(el)
        ) {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: `non-native role="${explicitRole}" is not keyboard-focusable (no tabindex>=0)`,
          });
        }
        // Every visible, enabled interactive control needs an accessible name.
        if (isVisible(el) && !isDisabled(el) && !name && type !== "hidden") {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: "interactive control has no accessible name",
          });
        }

        // ── rendered geometry ───────────────────────────────────────────────
        if (!isVisible(el)) continue;
        if (isDisabled(el)) continue;

        const rect = el.getBoundingClientRect();
        const width = Math.round(rect.width * 100) / 100;
        const height = Math.round(rect.height * 100) / 100;

        if (
          tag === "input" &&
          (type === "color" || type === "file") &&
          (el.classList.contains("sr-only") ||
            rect.width <= 1 ||
            rect.height <= 1)
        ) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason: `visually-hidden ${type} input; visible proxy button is the tap surface`,
          });
          continue;
        }

        // Nested inner control: an interactive element inside another
        // interactive element — the OUTER element is the real tap surface.
        const nestedInInteractive = (() => {
          let parent = el.parentElement;
          while (parent) {
            if (parent.matches(INTERACTIVE_SELECTOR)) return true;
            parent = parent.parentElement;
          }
          return false;
        })();
        if (nestedInInteractive) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason:
              "nested inside a larger interactive control (outer is the tap surface)",
          });
          continue;
        }

        // Native checkbox / radio boxes are visually small by spec; the
        // associated <label> (or a wrapping row) is the real tap surface.
        if (tag === "input" && (type === "checkbox" || type === "radio")) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason: `native ${type} box; the associated label is the tap surface`,
          });
          continue;
        }

        // Inline prose link: an <a>/role=link laid out inline inside a run of
        // text. Apple HIG's 44px floor targets standalone controls, not links
        // embedded in a paragraph.
        const style = window.getComputedStyle(el);
        const isLink = tag === "a" || explicitRole === "link";
        const displayInline = style.display.startsWith("inline");
        if (isLink && displayInline) {
          const parent = el.parentElement;
          const parentText = (parent?.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const ownText = ((el as HTMLElement).innerText || "")
            .replace(/\s+/g, " ")
            .trim();
          if (parentText.length > ownText.length + 1) {
            results.push({
              descriptor,
              width,
              height,
              status: "exception",
              kind: "geometry",
              reason:
                "inline link embedded in prose (HIG floor targets standalone controls)",
            });
            continue;
          }
        }

        const meetsFloor = height >= minTap && width >= minTap;
        results.push({
          descriptor,
          width,
          height,
          status: meetsFloor ? "pass" : "violation",
          kind: "geometry",
          reason: meetsFloor
            ? "meets 44px floor"
            : `rendered ${width}x${height}px is below the ${minTap}px floor`,
        });
      }

      return results;
    },
    { minTap: MIN_TAP_PX },
  );

  return raw.map((r) => ({ ...r, view }));
}

function isDocumentedException(view: string, descriptor: string): boolean {
  return (DOCUMENTED_EXCEPTIONS[view] ?? []).some((e) =>
    e.match.test(descriptor),
  );
}

const allRecords: ControlRecord[] = [];

test.describe("tap-target rendered-geometry + role/DOM coherence gate", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page, { "eliza:permissions-primed": "1" });
    await hideChatOverlay(page);
    await installDefaultAppRoutes(page);
  });

  for (const view of VIEW_ROUTES) {
    test(`${view.id} — every standalone control is a >=44px, coherent hit target`, async ({
      page,
    }) => {
      if (view.id === "desktop") await installDesktopBridgeFixture(page);
      if (view.id === "files") {
        const hash = "a".repeat(64);
        await page.route("**/api/files", (route) =>
          route.fulfill({
            json: {
              files: [
                {
                  fileName: `${hash}.pdf`,
                  url: `/api/media/${hash}.pdf`,
                  hash,
                  mimeType: "application/pdf",
                  size: 51200,
                  createdAt: 1700000001000,
                },
              ],
            },
          }),
        );
      }
      if (view.id === "trajectories") {
        await page.route("**/api/trajectories**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname !== "/api/trajectories") return route.fallback();
          await route.fulfill({
            json: {
              trajectories: [
                {
                  id: "trajectory-geometry-1",
                  agentId: "ui-smoke-agent",
                  source: "conversation",
                  status: "completed",
                  startTime: 1700000004000,
                  endTime: 1700000004800,
                  durationMs: 800,
                  llmCallCount: 1,
                  providerAccessCount: 0,
                  totalPromptTokens: 128,
                  totalCompletionTokens: 64,
                  scenarioId: null,
                  batchId: null,
                  createdAt: "2023-11-14T22:13:24.000Z",
                  updatedAt: "2023-11-14T22:13:24.800Z",
                  roomId: "ui-smoke-room",
                  entityId: null,
                  conversationId: null,
                  metadata: {},
                },
              ],
              total: 1,
              offset: 0,
              limit: 50,
            },
          });
        });
      }
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });

      // `openAppPath` proves the shell is ready, but many view bodies are lazy
      // chunks. Poll the rendered controls so the gate measures the mounted
      // view instead of treating its transient loading frame as an empty page.
      let records: ControlRecord[] = [];
      await expect
        .poll(
          async () => {
            records = await collectControls(page, view.id);
            return records.length;
          },
          {
            message: `${view.id}: wait for an interactive control before measuring tap geometry`,
            timeout: 60_000,
          },
        )
        .toBeGreaterThan(DOCUMENTED_ZERO_CONTROL_VIEWS[view.id] ? -1 : 0);
      allRecords.push(...records);

      if (DOCUMENTED_ZERO_CONTROL_VIEWS[view.id] && records.length === 0) {
        test.info().annotations.push({
          type: "documented-zero-control-view",
          description: DOCUMENTED_ZERO_CONTROL_VIEWS[view.id],
        });
        return;
      }

      expect(
        records.length,
        `${view.id}: expected to enumerate at least one interactive control`,
      ).toBeGreaterThan(0);

      const geometryViolations = records
        .filter((r) => r.kind === "geometry" && r.status === "violation")
        .filter((r) => !isDocumentedException(view.id, r.descriptor));
      const coherenceViolations = records
        .filter((r) => r.kind === "coherence" && r.status === "violation")
        .filter((r) => !isDocumentedException(view.id, r.descriptor));

      expect(
        coherenceViolations,
        [
          `${view.id}: ${coherenceViolations.length} role/DOM coherence violation(s) — fix the a11y defect or document the exception:`,
          ...coherenceViolations.map((r) => `  • ${r.descriptor}: ${r.reason}`),
        ].join("\n"),
      ).toHaveLength(0);

      expect(
        geometryViolations,
        [
          `${view.id}: ${geometryViolations.length} standalone control(s) below the 44px floor — raise them to --min-touch-target or document the exception:`,
          ...geometryViolations.map((r) => `  • ${r.descriptor}: ${r.reason}`),
        ].join("\n"),
      ).toHaveLength(0);
    });
  }

  test.afterAll(() => {
    if (allRecords.length === 0) return;
    mkdirSync(REPORT_DIR, { recursive: true });
    const byView: Record<string, ControlRecord[]> = {};
    for (const r of allRecords) {
      byView[r.view] ??= [];
      byView[r.view].push(r);
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      floorPx: MIN_TAP_PX,
      totalControls: allRecords.length,
      geometryViolations: allRecords.filter(
        (r) => r.kind === "geometry" && r.status === "violation",
      ).length,
      coherenceViolations: allRecords.filter(
        (r) => r.kind === "coherence" && r.status === "violation",
      ).length,
      exceptions: allRecords.filter((r) => r.status === "exception").length,
      byView,
    };
    writeFileSync(
      path.join(REPORT_DIR, "report.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  });
});
