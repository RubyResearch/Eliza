// Input-modality coverage (#10104/#10722): the same critical shell flows —
// open the chat, converse, dismiss, scroll the transcript, reach the catalog —
// driven through EVERY pointer/input modality the shipped app receives, with
// semantic outcome assertions per modality:
//
//   - keyboard-only  Tab/Shift+Tab traversal, Enter-to-send, Escape-to-collapse
//                    (runs on every project: chromium, desktop-webkit,
//                    mobile-chromium — hardware keyboards ship on all three).
//   - mouse          hover affordances (rest → hover → rest style contract) and
//                    wheel scrolling.
//   - real touch     touchscreen taps + a genuine CDP touch-point swipe
//                    (pointerType "touch", not a desktop mouse pretending),
//                    on the hasTouch mobile project.
//
// Engine/capability gates in this file are per-test and documented inline;
// nothing here blanket-skips an engine.

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const SCROLL_CONVERSATION_ID = "input-modality-scroll-conversation";

/**
 * A long deterministic conversation so the transcript overflows inside the
 * sheet and a swipe/scroll has a measurable semantic outcome (scrollTop moves).
 * Same fixture contract as chat-overlay-controls-interactions.spec.ts.
 */
async function installScrollableConversationRoutes(page: Page): Promise<void> {
  const conversation = {
    id: SCROLL_CONVERSATION_ID,
    roomId: "input-modality-scroll-room",
    title: "Input modality scroll fixture",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const messages = Array.from({ length: 34 }, (_, index) => {
    const turn = index + 1;
    return {
      id: `modality-message-${turn}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text:
        `modality fixture message ${String(turn).padStart(2, "0")} ` +
        "with enough text to make the transcript overflow inside the sheet.",
      timestamp: Date.now() - (34 - index) * 1000,
    };
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [conversation] }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route(
    `**/api/conversations/${SCROLL_CONVERSATION_ID}`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ conversation }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await page.route(
    `**/api/conversations/${SCROLL_CONVERSATION_ID}/messages`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await page.route(
    `**/api/conversations/${SCROLL_CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: null }),
      });
    },
  );
}

type FocusSnapshot = {
  testId: string | null;
  tag: string;
  focusVisible: boolean;
  ariaLabel: string | null;
};

/** Snapshot of the element that currently holds keyboard focus. */
async function activeFocus(page: Page): Promise<FocusSnapshot> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return {
        testId: null,
        tag: el ? el.tagName.toLowerCase() : "none",
        focusVisible: false,
        ariaLabel: null,
      };
    }
    return {
      testId: el.getAttribute("data-testid"),
      tag: el.tagName.toLowerCase(),
      focusVisible: el.matches(":focus-visible"),
      ariaLabel: el.getAttribute("aria-label"),
    };
  });
}

/**
 * The keyboard "advance focus" chord per engine. Chromium moves focus through
 * every interactive element with plain Tab. WebKit keeps Safari's documented
 * default keyboard model: Tab traverses text fields/form controls, and
 * Option+Tab ("Alt+Tab" in Playwright) is the full-traversal chord that also
 * reaches buttons/links. Using each engine's real traversal chord keeps this a
 * genuine keyboard path on both — it is NOT a skip, WebKit runs the whole flow.
 */
function tabChord(browserName: string): string {
  return browserName === "webkit" ? "Alt+Tab" : "Tab";
}

/**
 * Advance keyboard focus until the predicate matches, bounded. Returns every
 * focus snapshot seen along the way so callers can assert traversal breadth.
 */
async function tabUntil(
  page: Page,
  browserName: string,
  predicate: (snapshot: FocusSnapshot) => boolean,
  maxPresses = 60,
): Promise<{ reached: boolean; trail: FocusSnapshot[] }> {
  const trail: FocusSnapshot[] = [];
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press(tabChord(browserName));
    const snapshot = await activeFocus(page);
    trail.push(snapshot);
    if (predicate(snapshot)) return { reached: true, trail };
  }
  return { reached: false, trail };
}

/**
 * Genuine touch drag via CDP `Input.dispatchTouchEvent` (pointerType "touch"),
 * mirroring chat-clear-swipe.spec.ts — the real finger path, not page.mouse.
 */
async function touchDrag(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  steps = 12,
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("touchDrag target has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx + (dx * i) / steps, y: cy + (dy * i) / steps }],
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

test.beforeEach(async ({ page }) => {
  // Opt out of the once-ever first-run tour so its spotlight (and its focus
  // trap) never intercepts the traversal mid-test.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

test("keyboard-only: Tab reaches the composer, Enter sends and reveals the conversation, Escape collapses", async ({
  page,
  browserName,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await expect(overlay).not.toHaveAttribute("data-open", "true");

  // Start from a neutral focus state — everything after this is keyboard-only.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  const { reached, trail } = await tabUntil(
    page,
    browserName,
    (snapshot) => snapshot.testId === "chat-composer-textarea",
  );
  expect(
    reached,
    `Tab traversal must reach the chat composer; focus trail=${JSON.stringify(
      trail.map((step) => step.testId ?? step.tag),
    )}`,
  ).toBe(true);

  // Focus visibility + operability contract. The design system deliberately
  // bans decorative focus rings globally (packages/ui/src/styles/styles.css
  // "Product policy: focus rings are intentionally disabled globally"), so the
  // visible indicator for the composer is the text caret; the enforceable
  // cross-engine contract is that the keyboard-focused element IS the
  // composer, the engine reports it :focus-visible, and it is on screen.
  const composerFocus = trail[trail.length - 1];
  expect(composerFocus.focusVisible).toBe(true);
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible();
  await expect(composer).toBeFocused();

  // Type through the keyboard. An empty conversation has no transcript to reveal.
  const prompt = "keyboard-only path proof";
  await page.keyboard.type(prompt);
  await expect(composer).toHaveValue(prompt);
  // Enter sends: the draft clears and the message lands in the transcript.
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("", { timeout: 15_000 });
  await expect(
    page.getByTestId("thread-line").filter({ hasText: prompt }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    /^(half|full)$/,
  );

  // Escape collapses the sheet in one keystroke.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    "collapsed",
    { timeout: 10_000 },
  );
});

test("keyboard-only: focus traversal is bidirectional and every stop is focus-visible and on-screen", async ({
  page,
  browserName,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 60_000,
  });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  // Walk forward across the shell and record each distinct interactive stop.
  const seen: FocusSnapshot[] = [];
  for (let press = 0; press < 25; press += 1) {
    await page.keyboard.press(tabChord(browserName));
    const snapshot = await activeFocus(page);
    if (snapshot.tag === "none" || snapshot.tag === "body") continue;
    if (
      !seen.some(
        (prior) =>
          prior.testId === snapshot.testId &&
          prior.ariaLabel === snapshot.ariaLabel &&
          prior.tag === snapshot.tag,
      )
    ) {
      seen.push(snapshot);
    }
    if (seen.length >= 3) break;
  }
  expect(
    seen.length,
    `keyboard traversal must reach at least 3 distinct interactive elements; saw ${JSON.stringify(
      seen,
    )}`,
  ).toBeGreaterThanOrEqual(3);
  for (const stop of seen) {
    expect(
      stop.focusVisible,
      `keyboard-focused element must report :focus-visible: ${JSON.stringify(stop)}`,
    ).toBe(true);
  }

  // Shift reverses the same chord: focus must move back to the previous stop
  // (bidirectional operability, WCAG 2.1.1 keyboard).
  const forward = await activeFocus(page);
  await page.keyboard.press(
    browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab",
  );
  const backward = await activeFocus(page);
  expect(
    backward.testId !== forward.testId ||
      backward.ariaLabel !== forward.ariaLabel,
    `Shift+Tab must move focus off ${JSON.stringify(forward)}`,
  ).toBe(true);
});

test("mouse: hover surfaces the composer control affordance and reverts on unhover", async ({
  page,
  isMobile,
}) => {
  // Capability gate: the design system compiles every hover utility behind
  // `@media (hover: hover)` (verified in the built CSS), so on a touch-primary
  // device profile (Pixel 7 emulation reports hover:none) the affordance
  // deliberately does not exist — that is the product behavior, not a gap.
  // Hover is asserted on the hover-capable desktop projects (chromium +
  // desktop-webkit).
  test.skip(
    isMobile,
    "hover affordances are @media (hover: hover)-gated off on touch-primary profiles",
  );
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  // The chat-actions control carries the shared SoftButton hover contract
  // (text-white/75 → hover:text-white). Assert the REST → HOVER → REST style
  // transition — the semantic affordance a mouse user actually gets.
  const chatActions = page.getByTestId("chat-composer-plus");
  await expect(chatActions).toBeVisible({ timeout: 15_000 });

  // Park the pointer well away from the control for an honest rest reading.
  await page.mouse.move(4, 4);
  const restColor = await chatActions.evaluate(
    (node) => getComputedStyle(node).color,
  );

  await chatActions.hover();
  await expect
    .poll(() => chatActions.evaluate((node) => getComputedStyle(node).color), {
      message: "hover must change the composer control color affordance",
      timeout: 10_000,
    })
    .not.toBe(restColor);

  await page.mouse.move(4, 4);
  await expect
    .poll(() => chatActions.evaluate((node) => getComputedStyle(node).color), {
      message: "moving the mouse away must restore the rest style",
      timeout: 10_000,
    })
    .toBe(restColor);
});

test("mouse: wheel scrolls the open transcript", async ({ page }) => {
  await installScrollableConversationRoutes(page);
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  // Typing is the open contract (focus alone deliberately keeps the sheet
  // collapsed); a one-character draft springs it open without sending.
  await page.getByTestId("chat-composer-textarea").click();
  await page.keyboard.type("s");
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });

  const thread = page.locator("#continuous-thread");
  await expect(thread).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("modality fixture message 34")).toBeVisible({
    timeout: 15_000,
  });
  await thread.evaluate((node) => {
    node.scrollTop = 0;
  });

  await thread.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => thread.evaluate((node) => node.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(0);
});

test.describe("real touch (touchscreen taps + CDP touch-point swipe)", () => {
  test("touch: tap opens the chat, a finger swipe scrolls the transcript, backdrop taps collapse", async ({
    page,
    browserName,
    hasTouch,
  }) => {
    // Capability gate, not an engine opt-out: this test drives a touchscreen,
    // so it runs on the hasTouch projects (mobile-chromium Pixel 7 — the
    // Capacitor-shipped viewport). The CDP swipe additionally requires the
    // Chrome DevTools Protocol, which only Chromium exposes; WebKit desktop
    // (Desktop Safari profile) has no touch digitizer, matching real Mac
    // Safari hardware.
    test.skip(!hasTouch, "requires a touch-enabled project (hasTouch)");
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; non-Chromium touch runs on real devices (capture:ios-sim / capture:android-emu lanes)",
    );

    await installScrollableConversationRoutes(page);
    await openAppPath(page, "/chat");
    const overlay = page.getByTestId("chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await expect(overlay).not.toHaveAttribute("data-open", "true");

    // Finger tap focuses the composer (keyboard up — the touch outcome), then
    // a one-character draft springs the sheet open: the open contract is
    // typing, focus alone deliberately keeps the sheet collapsed. On a real
    // phone that draft arrives from the on-screen keyboard as key events.
    const composer = page.getByTestId("chat-composer-textarea");
    const composerBox = await composer.boundingBox();
    if (!composerBox) throw new Error("composer has no bounding box");
    await page.touchscreen.tap(
      composerBox.x + composerBox.width / 2,
      composerBox.y + composerBox.height / 2,
    );
    await expect(composer).toBeFocused({ timeout: 10_000 });
    await page.keyboard.type("s");
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });

    // Real touch swipe (CDP touch points) scrolls the transcript.
    const thread = page.locator("#continuous-thread");
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("modality fixture message 34")).toBeVisible({
      timeout: 15_000,
    });
    await thread.evaluate((node) => {
      node.scrollTop = 0;
    });
    // Finger moves up → content scrolls down (natural touch scrolling).
    await touchDrag(page, thread, 0, -260, 14);
    await expect
      .poll(() => thread.evaluate((node) => node.scrollTop), {
        message: "a real touch swipe must scroll the transcript",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // Backdrop taps collapse. The first tap only drops the keyboard when the
    // composer is focused (two-step dismiss by design — see
    // ChatOverlay composerFocusedAtPress), so tap until collapsed,
    // bounded at 3.
    for (let tap = 0; tap < 3; tap += 1) {
      const open = (await overlay.getAttribute("data-open")) === "true";
      if (!open) break;
      const backdrop = page.getByTestId("chat-sheet-backdrop");
      const backdropBox = await backdrop.boundingBox();
      if (!backdropBox) break;
      await page.touchscreen.tap(backdropBox.x + 14, backdropBox.y + 14);
      await page.waitForTimeout(400);
    }
    await expect(overlay).not.toHaveAttribute("data-open", "true", {
      timeout: 10_000,
    });
  });
});
