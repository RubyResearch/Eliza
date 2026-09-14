/**
 * Playwright UI-smoke spec for the All Views Interaction app flow using the
 * real renderer fixture.
 */
import {
  type ElementHandle,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installCameraRecoveryFixture } from "./helpers/camera-recovery-fixture";
import {
  CLICK_OBSERVED_ATTRIBUTES,
  type ControlDetails,
  type ControlSnapshot,
  interactionDelta,
} from "./interaction-observation";
import { VIEW_ROUTES } from "./view-routes";

/**
 * Bounded interaction activity smoke over the built-in route fixture.
 * Enumerated controls are sampled, so links, file inputs, gestures and nested
 * states outside the crawl are not covered. Observed DOM/navigation changes,
 * including rendered errors, do not establish operation success or persistence.
 * Acceptance cases must correlate the specific request and backing-state receipt.
 * Run with E2E_RECORD=1 for video. Navigations are recovered between samples.
 */
// Bound per-view work so the suite stays under the playwright timeout while
// still exercising a representative breadth of controls.
const MAX_CLICKS = 24;
const MAX_INPUTS = 8;

const CLICK_SELECTOR =
  "button:visible, [role='button']:visible, [role='tab']:visible, [role='menuitem']:visible, a[href^='#']:visible";
const INPUT_SELECTOR =
  "input:visible:not([type='file']):not([disabled]), textarea:visible:not([disabled])";

type ObservationResult = {
  kind: "observed" | "documented-noop" | "failure";
  message: string;
};

function truncate(value: string, maxLength = 80): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

async function numericInputValue(input: Locator): Promise<string> {
  return input.evaluate((el: Element) => {
    const inputEl = el as HTMLInputElement;
    const min = Number.parseFloat(inputEl.min);
    const max = Number.parseFloat(inputEl.max);
    let next = 42;
    if (Number.isFinite(min) && next < min) next = min;
    if (Number.isFinite(max) && next > max) next = max;
    return String(next);
  });
}

async function fillOrToggleInput(
  input: Locator,
  index: number,
): Promise<ObservationResult> {
  const tagName = ((await input.evaluate((el: Element) => el.tagName)) ?? "")
    .toString()
    .toLowerCase();
  const type = ((await input.getAttribute("type")) ?? "text").toLowerCase();
  const label = (
    [
      await input.getAttribute("aria-label"),
      await input.getAttribute("name"),
      await input.getAttribute("placeholder"),
      await input.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .join(" ") || ""
  ).toLowerCase();
  if (tagName === "textarea") {
    const value = `smoke textarea ${index}`;
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: textarea value round-tripped`,
    };
  }
  if (type === "checkbox" || type === "radio") {
    const wasChecked = await input.isChecked();
    await input.click();
    if (type === "radio" && wasChecked) {
      await expect(input).toBeChecked();
      return {
        kind: "documented-noop",
        message: `input ${index}: already-selected radio stayed selected`,
      };
    }
    if (wasChecked) {
      await expect(input).not.toBeChecked();
    } else {
      await expect(input).toBeChecked();
    }
    return {
      kind: "observed",
      message: `input ${index}: ${type} checked state changed`,
    };
  }
  if (type === "number" || type === "range") {
    const value = await numericInputValue(input);
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: ${type} value round-tripped`,
    };
  }
  if (type === "color") {
    // A color input only accepts a valid #rrggbb value — filling arbitrary text
    // (e.g. the Custom background color picker) throws "Malformed value".
    const value = "#3366ff";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: color value round-tripped`,
    };
  }
  if (type === "email" || label.includes("email")) {
    const value = "smoke@example.com";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: email value round-tripped`,
    };
  }
  if (type === "url" || label.includes("url")) {
    const value = "https://example.com";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: url value round-tripped`,
    };
  }
  if (type === "date") {
    const value = "2026-06-29";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: date value round-tripped`,
    };
  }
  if (type === "datetime-local") {
    const value = "2026-06-29T12:00";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: datetime value round-tripped`,
    };
  }
  if (type === "time") {
    const value = "12:00";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: time value round-tripped`,
    };
  }
  if (type === "month") {
    const value = "2026-06";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: month value round-tripped`,
    };
  }
  if (type === "week") {
    const value = "2026-W27";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: week value round-tripped`,
    };
  }
  if (type === "tel" || label.includes("phone")) {
    const value = "5550100";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: phone value round-tripped`,
    };
  }
  if (type === "password") {
    const value = "smoke-password";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: password value round-tripped`,
    };
  }
  if (type === "search" || label.includes("search")) {
    const value = "smoke";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: search value round-tripped`,
    };
  }
  const value = `smoke input ${index}`;
  await input.fill(value);
  await expect(input).toHaveValue(value);
  return {
    kind: "observed",
    message: `input ${index}: text value round-tripped`,
  };
}

async function isPointerReachable(control: Locator): Promise<boolean> {
  return control.evaluate((el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return top === el || (top ? el.contains(top) : false);
  });
}

async function visibleDismissibleSurfaceCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selector = [
      '[role="alertdialog"]',
      '[role="dialog"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="tree"]',
      "dialog[open]",
      "[data-radix-popper-content-wrapper]",
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter((el) => {
      const node = el as HTMLElement;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }).length;
  });
}

/**
 * Cheap whole-page content fingerprint (visible text length + djb2 hash).
 * Catches renderer changes that land elsewhere in the page than on the
 * clicked control itself — a dialer display updating, a sidebar collapsing,
 * a pager flipping surfaces — without enumerating product-specific testids.
 */
async function pageContentFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return `${text.length}:${hash}`;
  });
}

async function snapshotControl(
  page: Page,
  control: ElementHandle<Element>,
): Promise<ControlSnapshot> {
  const details = await control
    .evaluate((el: Element, observedAttributes: readonly string[]) => {
      const htmlEl = el as HTMLElement;
      const inputEl = el as HTMLInputElement;
      const anchorEl = el as HTMLAnchorElement;
      const attr = (name: string): string | null => el.getAttribute(name);
      const text = (htmlEl.innerText || htmlEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const label =
        attr("aria-label") || attr("title") || attr("data-testid") || text;
      const attributes = Object.fromEntries(
        observedAttributes.map((name) => [name, attr(name)]),
      ) as Record<string, string | null>;
      return {
        tagName: el.tagName.toLowerCase(),
        role: attr("role"),
        type: attr("type"),
        href: "href" in anchorEl ? anchorEl.href : null,
        visible:
          htmlEl.getClientRects().length > 0 &&
          getComputedStyle(htmlEl).visibility !== "hidden",
        label: label ? label.slice(0, 120) : "",
        text: text.slice(0, 120),
        value: "value" in inputEl ? String(inputEl.value) : null,
        checked: "checked" in inputEl ? Boolean(inputEl.checked) : null,
        attributes,
      };
    }, CLICK_OBSERVED_ATTRIBUTES)
    .catch(() => null);

  return {
    url: page.url(),
    visibleDismissibleSurfaces: await visibleDismissibleSurfaceCount(page),
    pageFingerprint: await pageContentFingerprint(page),
    details,
  };
}

function describeControl(details: ControlDetails | null): string {
  if (!details) return "detached control";
  return truncate(
    [
      details.tagName,
      details.role ? `role=${details.role}` : null,
      details.type ? `type=${details.type}` : null,
      details.label ? `label="${details.label}"` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function documentedClickNoop(
  before: ControlSnapshot,
  after: ControlSnapshot,
): string | null {
  const details = before.details;
  if (!details) return null;
  const label =
    `${details.role ?? ""} ${details.type ?? ""} ${details.label} ${details.text}`.toLowerCase();
  if (
    details.role === "tab" &&
    details.attributes["aria-selected"] === "true" &&
    after.details?.attributes["aria-selected"] === "true"
  ) {
    return "active tab re-selection leaves the selected tab unchanged";
  }
  if (
    details.attributes["aria-pressed"] === "true" &&
    after.details?.attributes["aria-pressed"] === "true"
  ) {
    return "active pressed-control re-selection leaves the selected value unchanged";
  }
  if (details.href) {
    try {
      const beforeUrl = new URL(before.url);
      const hrefUrl = new URL(details.href);
      if (
        hrefUrl.pathname === beforeUrl.pathname &&
        hrefUrl.hash === beforeUrl.hash
      ) {
        return "same-route hash link is already selected";
      }
    } catch {
      /* malformed hrefs are not expected in the app shell */
    }
  }
  if (
    /\b(upload|choose file|select file|attach|download|copy|microphone|camera|record|voice|share)\b/.test(
      label,
    )
  ) {
    return "browser-native file, device, clipboard, or download affordance has no DOM outcome without choosing a file/device";
  }
  if (
    /\b(back|close|cancel|dismiss)\b/.test(label) &&
    before.visibleDismissibleSurfaces === 0
  ) {
    return "dismiss/back control had no visible overlay or modal to close";
  }
  if (details.attributes["data-agent-id"]) {
    // Spatial-view controls (data-agent-id) dispatch their action to the agent
    // runtime; the DOM outcome depends on the agent round-trip, which the
    // keyless stub does not perform.
    return "spatial agent-dispatch control routes its action to the agent runtime; no local DOM outcome in the keyless stub";
  }
  if (details.attributes["data-chat-open"]) {
    // chat-open dispatch controls (data-chat-open) route their action to the
    // ChatOverlay, which the interaction harness hides in setup via
    // hideChatOverlay so overlay chrome does not shadow the view controls;
    // opening it therefore produces no observable local DOM outcome here.
    return "chat-open dispatch control routes its action to the ChatOverlay, which the interaction harness hides in setup; no local DOM outcome";
  }
  return null;
}

async function observeClickOutcome(
  page: Page,
  control: ElementHandle<Element>,
  before: ControlSnapshot,
): Promise<ObservationResult> {
  let after = await snapshotControl(page, control);
  let delta = interactionDelta(before, after);
  // The ladder ends well above one second: on a loaded CI runner a state
  // commit + re-render (e.g. sidebar collapse) can land after the first few
  // probes even though the interaction is perfectly healthy.
  for (const delayMs of [100, 250, 500, 1000, 2000]) {
    if (delta) {
      return {
        kind: "observed",
        message: `${describeControl(before.details)}: ${delta}`,
      };
    }
    await page.waitForTimeout(delayMs);
    after = await snapshotControl(page, control);
    delta = interactionDelta(before, after);
  }
  if (delta) {
    return {
      kind: "observed",
      message: `${describeControl(before.details)}: ${delta}`,
    };
  }
  const noopReason = documentedClickNoop(before, after);
  if (noopReason) {
    return {
      kind: "documented-noop",
      message: `${describeControl(before.details)}: ${noopReason}`,
    };
  }
  return {
    kind: "failure",
    message: `${describeControl(before.details)} produced no URL, DOM state, dialog/menu, value, checked, text, or documented no-op outcome`,
  };
}

async function pressEscapeWithObservation(
  page: Page,
  descriptor: string,
): Promise<ObservationResult> {
  const beforeCount = await visibleDismissibleSurfaceCount(page);
  const beforeUrl = page.url();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const afterCount = await visibleDismissibleSurfaceCount(page);
  if (afterCount < beforeCount) {
    return {
      kind: "observed",
      message: `${descriptor}: Escape dismissed a visible surface`,
    };
  }
  if (page.url() !== beforeUrl) {
    return {
      kind: "observed",
      message: `${descriptor}: Escape changed the URL from ${beforeUrl} to ${page.url()}`,
    };
  }
  if (beforeCount === 0) {
    return {
      kind: "documented-noop",
      message: `${descriptor}: Escape had no visible dialog, menu, listbox, or popover to dismiss`,
    };
  }
  return {
    kind: "failure",
    message: `${descriptor}: Escape did not dismiss ${beforeCount} visible dismissible surface(s)`,
  };
}

/**
 * Install the write/discovery seams exercised by this keyless interaction
 * audit. Persistence and integration behavior remain owned by the live-stack
 * specs; this gate needs canonical responses so clicking a real control proves
 * its semantic outcome instead of tripping the stub server's catch-all 501.
 */
async function installInteractionAuditRoutes(page: Page): Promise<void> {
  let interactionWorkflow: Record<string, unknown> | null = null;
  let character: Record<string, unknown> = {
    name: "Playwright Smoke",
    bio: ["Interaction-audit character"],
    system: "",
    adjectives: [],
    topics: [],
    style: { all: [], chat: [], post: [] },
    messageExamples: [],
    postExamples: [],
  };

  await page.route(/\/api\/character(?:\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ character, agentName: "Playwright Smoke" }),
      });
      return;
    }
    if (method === "PUT") {
      const payload: unknown = route.request().postDataJSON();
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        character = { ...character, ...(payload as Record<string, unknown>) };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          character,
          agentName: "Playwright Smoke",
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(/\/api\/stream\/(?:live|offline)$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const live = new URL(route.request().url()).pathname.endsWith("/live");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        live,
        ...(live
          ? {
              destination: "Playwright Smoke",
              inputMode: "voice",
              audioSource: "microphone",
            }
          : {}),
      }),
    });
  });

  await page.route(/\/api\/plugins\/[^/?]+(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.fallback();
      return;
    }

    const pluginId = decodeURIComponent(
      new URL(request.url()).pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    const payload = request.postDataJSON() as {
      enabled?: boolean;
      config?: Record<string, string>;
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        plugin: {
          id: pluginId,
          enabled: payload.enabled ?? true,
          config: payload.config ?? {},
        },
        restartRequired: false,
      }),
    });
  });

  await page.route("**/api/triggers**", async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).pathname === "/api/triggers"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ triggers: [] }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/workflow/workflows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflows: interactionWorkflow ? [interactionWorkflow] : [],
        }),
      });
      return;
    }
    if (request.method() === "POST" && pathname === "/api/workflow/workflows") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const now = new Date().toISOString();
      interactionWorkflow = {
        ...payload,
        active: payload.active ?? false,
        id: "interaction-audit-workflow",
        versionId: "interaction-audit-v1",
        createdAt: now,
        updatedAt: now,
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(interactionWorkflow),
      });
      return;
    }

    const segments = pathname.split("/").filter(Boolean);
    const workflowId = decodeURIComponent(segments[3] ?? "");
    const subresource = segments[4];
    if (workflowId !== "interaction-audit-workflow" || !interactionWorkflow) {
      await route.fallback();
      return;
    }
    if (request.method() === "GET" && subresource === "executions") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ executions: [] }),
      });
      return;
    }
    if (request.method() === "GET" && subresource === "revisions") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          currentVersionId: interactionWorkflow.versionId,
          revisions: [],
        }),
      });
      return;
    }
    if (request.method() === "GET" && !subresource) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(interactionWorkflow),
      });
      return;
    }
    if (request.method() === "PUT" && !subresource) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      interactionWorkflow = {
        ...interactionWorkflow,
        ...payload,
        updatedAt: new Date().toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(interactionWorkflow),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      (subresource === "activate" || subresource === "deactivate")
    ) {
      interactionWorkflow = {
        ...interactionWorkflow,
        active: subresource === "activate",
        updatedAt: new Date().toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(interactionWorkflow),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/pendant/sessions/current", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "not_found",
          message: "No active pendant session was found",
        },
      }),
    });
  });
}

test.describe("bounded built-in interaction activity smoke", () => {
  // Copy-address controls call the async Clipboard API; headless CI Chromium
  // denies clipboard-write by default, which turns each copy click into an
  // unhandled-rejection pageerror instead of a "Copied" outcome.
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const view of VIEW_ROUTES) {
    test(`${view.id} — sample controls for renderer activity`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      const actionFailures: string[] = [];
      const networkFailures: string[] = [];
      const observationFailures: string[] = [];
      const observedChanges: string[] = [];
      const documentedNoops: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("response", (response) => {
        const status = response.status();
        if (status < 500) return;
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith("/api/")) {
          networkFailures.push(`http ${status}: ${pathname}`);
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return;
        const failureText = request.failure()?.errorText ?? "";
        if (failureText === "net::ERR_ABORTED") return;
        networkFailures.push(`requestfailed: ${url} ${failureText}`);
      });
      // The generic ladders cannot see a rejected workflow create: a 4xx
      // can render an error state, which is a
      // legitimate DOM outcome, so the editor follow-ons silently vanish
      // while the case stays green. Record the whole workflow surface so the
      // automations case can assert the successful sequence explicitly.
      const workflowSurfaceResponses: Array<{
        method: string;
        pathname: string;
        status: number;
      }> = [];
      page.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (
          pathname !== "/api/triggers" &&
          !pathname.startsWith("/api/workflow/")
        ) {
          return;
        }
        workflowSurfaceResponses.push({
          method: response.request().method(),
          pathname,
          status: response.status(),
        });
      });

      await page.setViewportSize({ width: 1440, height: 1000 });
      await seedAppStorage(page);
      await hideChatOverlay(page);
      await installDefaultAppRoutes(page);
      await installInteractionAuditRoutes(page);
      if (view.id === "camera") await installCameraRecoveryFixture(page);
      await openAppPath(
        page,
        view.id === "camera" ? `${view.path}?android=true` : view.path,
      );
      if (view.id === "camera") {
        await expect(page.getByTestId("camera-denied")).toBeVisible();
      }
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
      observedChanges.push(
        `view ${view.id}: route ${view.path} rendered ${page.url()}`,
      );

      // Fill text inputs first (some controls become enabled once filled).
      const inputs = page.locator(INPUT_SELECTOR);
      const inputCount = Math.min(await inputs.count(), MAX_INPUTS);
      for (let i = 0; i < inputCount; i += 1) {
        const input = inputs.nth(i);
        try {
          const result = await fillOrToggleInput(input, i);
          if (result.kind === "failure") {
            observationFailures.push(result.message);
          } else if (result.kind === "documented-noop") {
            documentedNoops.push(result.message);
          } else {
            observedChanges.push(result.message);
          }
        } catch (error) {
          actionFailures.push(
            `input ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Snapshot clickable controls by accessible name, then click each by name
      // so re-renders/navigation don't invalidate positional handles.
      const clickables = page.locator(CLICK_SELECTOR);
      const clickCount = Math.min(await clickables.count(), MAX_CLICKS);
      for (let i = 0; i < clickCount; i += 1) {
        const liveControls = page.locator(CLICK_SELECTOR);
        if (i >= (await liveControls.count())) {
          break;
        }
        const control = liveControls.nth(i);
        if (!(await control.isVisible().catch(() => false))) {
          continue;
        }
        if (!(await isPointerReachable(control).catch(() => false))) {
          continue;
        }
        const controlHandle = await control.elementHandle();
        if (!controlHandle) {
          continue;
        }
        const before = await snapshotControl(page, controlHandle);
        try {
          await control.click({ noWaitAfter: true, timeout: 2_000 });
        } catch (error) {
          actionFailures.push(
            `click ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await controlHandle.dispose();
          continue;
        }
        const result = await observeClickOutcome(page, controlHandle, before);
        await controlHandle.dispose();
        if (result.kind === "failure") {
          observationFailures.push(`click ${i}: ${result.message}`);
        } else if (result.kind === "documented-noop") {
          documentedNoops.push(`click ${i}: ${result.message}`);
        } else {
          observedChanges.push(`click ${i}: ${result.message}`);
        }
        // If a click navigated away from the view, return to keep exercising it.
        if (!page.url().includes(view.path) && view.path !== "/") {
          try {
            await openAppPath(page, view.path);
          } catch (error) {
            actionFailures.push(
              `recover ${i}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // Dismiss any opened overlay/menu so the next control is reachable.
        try {
          const escapeResult = await pressEscapeWithObservation(
            page,
            `click ${i}`,
          );
          if (escapeResult.kind === "failure") {
            observationFailures.push(escapeResult.message);
          } else if (escapeResult.kind === "documented-noop") {
            documentedNoops.push(escapeResult.message);
          } else {
            observedChanges.push(escapeResult.message);
          }
        } catch (error) {
          actionFailures.push(
            `escape ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (view.id === "camera") {
        const preview = page.getByTestId("camera-preview").locator("video");
        await expect(preview).toBeVisible();
        await expect
          .poll(() =>
            preview.evaluate((video: HTMLVideoElement) => video.readyState),
          )
          .toBeGreaterThanOrEqual(2);
      }
      expect(
        observationFailures,
        [
          `${view.id}: every exercised input/click/Escape interaction needs observable renderer activity or an explicit documented no-op`,
          ...observationFailures,
        ].join("\n"),
      ).toHaveLength(0);
      expect(
        observedChanges.length + documentedNoops.length,
        `${view.id}: expected activity observations for at least one enumerated interaction`,
      ).toBeGreaterThan(0);
      // The contract: no interaction in this view caused an uncaught crash.
      expect(
        [...pageErrors, ...actionFailures, ...networkFailures],
        [
          `${view.id}: a control interaction threw an uncaught error`,
          ...pageErrors,
          ...actionFailures,
          ...networkFailures,
        ].join("\n"),
      ).toHaveLength(0);
      // The automations crawl must complete the workflow-editor round trip,
      // not merely generate traffic toward it: the create must succeed and
      // the editor's follow-on reads must land, and no workflow-surface
      // request may be rejected. Without this, an invalid or rejecting
      // fixture prunes the editor coverage while the case stays green.
      if (view.id === "automations") {
        await page.getByRole("button", { name: "New automation" }).click();
        await page.getByRole("menuitem", { name: "New workflow" }).click();
        await expect(page.getByTestId("workflow-studio")).toBeVisible({
          timeout: 30_000,
        });
        await page.getByLabel("Workflow name").fill("Interaction audit");
        const createResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/workflow/workflows",
        );
        await page.getByLabel("Save workflow").click();
        await createResponse;
        await expect
          .poll(
            () =>
              workflowSurfaceResponses.filter(
                (response) =>
                  response.method === "GET" &&
                  (response.pathname === "/api/triggers" ||
                    response.pathname.endsWith("/executions") ||
                    response.pathname.endsWith("/revisions")),
              ).length,
            { timeout: 15_000 },
          )
          .toBeGreaterThanOrEqual(3);
        const observed = workflowSurfaceResponses
          .map((r) => `${r.method} ${r.pathname} -> ${r.status}`)
          .join("\n");
        const rejected = workflowSurfaceResponses.filter(
          (r) => r.status < 200 || r.status >= 300,
        );
        expect(
          rejected.map((r) => `${r.method} ${r.pathname} -> ${r.status}`),
          `automations: workflow-surface request was rejected\nobserved:\n${observed}`,
        ).toHaveLength(0);
        const succeeded = (method: string, pattern: RegExp) =>
          workflowSurfaceResponses.some(
            (r) =>
              r.method === method &&
              pattern.test(r.pathname) &&
              r.status >= 200 &&
              r.status < 300,
          );
        const missing = (
          [
            ["POST", /^\/api\/workflow\/workflows$/, "workflow create"],
            ["GET", /^\/api\/triggers$/, "editor trigger-list read"],
            [
              "GET",
              /^\/api\/workflow\/workflows\/[^/]+\/executions$/,
              "editor executions read",
            ],
            [
              "GET",
              /^\/api\/workflow\/workflows\/[^/]+\/revisions$/,
              "editor revisions read",
            ],
          ] as const
        )
          .filter(([method, pattern]) => !succeeded(method, pattern))
          .map(([, , label]) => label);
        expect(
          missing,
          `automations: workflow-editor sequence incomplete; missing: ${missing.join(", ")}\nobserved:\n${observed}`,
        ).toHaveLength(0);
      }
    });
  }
});
