/**
 * Playwright UI-smoke spec for the Browser Workspace app flow using the real
 * renderer fixture. Drives the #13596 folded-tab UX: tabs live in the switcher
 * overlay (opened from the toolbar's fold control), not a permanent sidebar
 * strip, so tab assertions open the switcher and read its cards.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type BrowserWorkspaceSmokeSnapshot = {
  tabs: { id: string }[];
};

function isBrowserWorkspaceSmokeSnapshot(
  value: unknown,
): value is BrowserWorkspaceSmokeSnapshot {
  if (!value || typeof value !== "object") return false;
  const tabs = (value as { tabs?: unknown }).tabs;
  return (
    Array.isArray(tabs) &&
    tabs.every(
      (tab) =>
        Boolean(tab) &&
        typeof tab === "object" &&
        typeof (tab as { id?: unknown }).id === "string",
    )
  );
}

async function resetBrowserWorkspaceTabs(
  request: APIRequestContext,
): Promise<void> {
  const response = await request.get("/api/browser-workspace");
  expect(response.ok()).toBe(true);
  const snapshot: unknown = await response.json();
  expect(isBrowserWorkspaceSmokeSnapshot(snapshot)).toBe(true);
  if (!isBrowserWorkspaceSmokeSnapshot(snapshot)) return;

  for (const tab of snapshot.tabs) {
    const closeResponse = await request.delete(
      `/api/browser-workspace/tabs/${encodeURIComponent(tab.id)}`,
    );
    expect(closeResponse.ok()).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("mobile browser actions close across the desktop breakpoint", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");

  const mobileMoreButton = page.getByTestId("browser-workspace-mobile-more");
  await expect(mobileMoreButton).toBeVisible({ timeout: 60_000 });
  await mobileMoreButton.click();

  const newTabItem = page.getByRole("menuitem", {
    name: "New tab",
    exact: true,
  });
  await expect(newTabItem).toBeVisible();

  // The menu content is portaled outside the responsive trigger wrapper, so
  // it must carry its own desktop visibility guard when an open mobile menu is
  // resized or rotated across the breakpoint.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(mobileMoreButton).toBeHidden();
  await expect(newTabItem).toBeHidden();
});

test("browser workspace can create, navigate, switch, and close tabs", async ({
  page,
  request,
}) => {
  const walletOriginMismatchWarnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      text.includes("Failed to execute 'postMessage'") &&
      text.includes("target origin") &&
      text.includes("does not match")
    ) {
      walletOriginMismatchWarnings.push(text);
    }
  });
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({
    timeout: 60_000,
  });

  const newTabButton = browserWorkspaceView.getByTestId(
    "browser-workspace-nav-new-tab",
  );
  const addressInput = browserWorkspaceView.getByTestId(
    "browser-workspace-address-input",
  );
  await expect(addressInput).toBeVisible({ timeout: 120_000 });
  const goButton = browserWorkspaceView.getByRole("button", { name: "Go" });
  const closeAllButton = browserWorkspaceView.getByTestId(
    "browser-workspace-close-all-tabs",
  );
  const mobileMoreButton = browserWorkspaceView.getByTestId(
    "browser-workspace-mobile-more",
  );
  const foldControl = browserWorkspaceView.getByTestId(
    "browser-workspace-tab-fold-control",
  );
  await expect(foldControl).toBeVisible({ timeout: 120_000 });
  const compactToolbar = await mobileMoreButton.isVisible();
  if (compactToolbar) {
    await expect(goButton).toBeHidden();
    await expect(newTabButton).toBeHidden();
    await expect(closeAllButton).toBeHidden();
  } else {
    await expect(goButton).toBeVisible({ timeout: 120_000 });
    await expect(newTabButton).toBeVisible({ timeout: 120_000 });
    await expect(closeAllButton).toBeVisible({ timeout: 120_000 });
  }

  const mobileMenuItem = async (name: string) => {
    await mobileMoreButton.click();
    const item = page.getByRole("menuitem", { name, exact: true });
    await expect(item).toBeVisible();
    return item;
  };
  const clickMobileMenuItem = async (name: string) => {
    const item = page.getByRole("menuitem", { name, exact: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!(await item.isVisible())) {
          await mobileMoreButton.click();
          await expect(item).toBeVisible({ timeout: 5_000 });
        }
        await item.click({ timeout: 10_000 });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.keyboard.press("Escape");
        await expect(item).toBeHidden({ timeout: 5_000 });
      }
    }
  };
  const expectCloseAllDisabled = async () => {
    if (!compactToolbar) {
      await expect(closeAllButton).toBeDisabled();
      return;
    }
    await expect(await mobileMenuItem("Close all tabs")).toBeDisabled();
    await page.keyboard.press("Escape");
  };
  const expectCloseAllEnabled = async () => {
    if (!compactToolbar) {
      await expect(closeAllButton).toBeEnabled();
      return;
    }
    await expect(await mobileMenuItem("Close all tabs")).toBeEnabled();
    await page.keyboard.press("Escape");
  };
  const createNewTab = async () => {
    if (!compactToolbar) {
      await newTabButton.click();
      return;
    }
    await clickMobileMenuItem("New tab");
  };
  const closeAllTabs = async () => {
    if (!compactToolbar) {
      await closeAllButton.click();
      return;
    }
    await clickMobileMenuItem("Close all tabs");
  };

  // The folded tab switcher is the only multi-tab surface (no permanent strip).
  // Opening it and reading its cards is how we assert tab state.
  const openSwitcher = async () => {
    await foldControl.click();
    return page.getByTestId("browser-workspace-tab-switcher");
  };
  const closeSwitcher = async () => {
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("browser-workspace-tab-switcher"),
    ).toHaveCount(0);
  };

  // Empty start: the switcher shows its designed empty state, no closable tabs.
  let switcher = await openSwitcher();
  await expect(switcher.getByText("No tabs open yet")).toHaveCount(1);
  const floatingLayerContract = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="browser-workspace-tab-switcher"]',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-overlay"]',
    );
    const chatSheet = document.querySelector<HTMLElement>(
      '[data-testid="chat-sheet-surface"]',
    );
    const backdrop = Array.from(
      document.querySelectorAll<HTMLElement>("[data-state='open']"),
    ).find((element) => getComputedStyle(element).zIndex === "8800");
    if (!dialog || !chat || !chatSheet || !backdrop) return null;
    return {
      dialogZ: Number(getComputedStyle(dialog).zIndex),
      backdropZ: Number(getComputedStyle(backdrop).zIndex),
      chatZ: Number(getComputedStyle(chat).zIndex),
      clearanceGap:
        chatSheet.getBoundingClientRect().top -
        dialog.getBoundingClientRect().bottom,
      clearanceAware: dialog.dataset.chatClearanceAware,
    };
  });
  expect(floatingLayerContract).not.toBeNull();
  expect(floatingLayerContract?.backdropZ).toBeLessThan(
    floatingLayerContract?.dialogZ ?? 0,
  );
  expect(floatingLayerContract?.dialogZ).toBeLessThan(
    floatingLayerContract?.chatZ ?? 0,
  );
  expect(floatingLayerContract?.clearanceGap).toBeGreaterThanOrEqual(0);
  expect(floatingLayerContract?.clearanceAware).toBe("true");
  await closeSwitcher();
  await expect(addressInput).toHaveValue("");
  if (!compactToolbar) await expect(newTabButton).toBeEnabled();
  await expectCloseAllDisabled();

  await addressInput.fill("");
  await addressInput.pressSequentially("example.com");
  await expect(addressInput).toHaveValue("example.com");
  if (compactToolbar) await addressInput.press("Enter");
  else await goButton.click();

  // The new tab is now the active one; the fold control names it and counts 1.
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("1");
  await expect(addressInput).toHaveValue("https://example.com/");
  await expectCloseAllEnabled();

  switcher = await openSwitcher();
  const exampleCard = switcher.locator(
    '[role="tab"][title*="https://example.com/"]',
  );
  await expect(exampleCard).toHaveCount(1);
  await closeSwitcher();

  // New Tab always creates a fresh Google home context rather than cloning the
  // active page or treating an address-bar draft as an implicit destination.
  await createNewTab();
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("2");
  await expect(addressInput).toHaveValue("https://www.google.com/webhp?igu=1");

  // Switch back to the example tab via the switcher — selecting closes it and
  // the address bar follows the picked tab.
  switcher = await openSwitcher();
  await switcher.locator('[role="tab"][title*="https://example.com/"]').click();
  await expect(page.getByTestId("browser-workspace-tab-switcher")).toHaveCount(
    0,
  );
  await expect(addressInput).toHaveValue("https://example.com/");

  await addressInput.fill("docs.elizaos.ai");
  await expect(addressInput).toHaveValue("docs.elizaos.ai");
  if (compactToolbar) await addressInput.press("Enter");
  else await goButton.click();
  await expect(addressInput).toHaveValue("https://docs.elizaos.ai/");

  // Shell navigation plus browser back/forward preserves the folded browser
  // state. Drive the app's real imperative navigation channel so this creates
  // a same-document history entry, matching product navigation. A second
  // `page.goto()` made this a cross-document WebKit history test instead and
  // intermittently lost the forward entry before the assertion ran.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewPath: "/chat" },
      }),
    );
  });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });
  await expect(addressInput).toHaveValue("https://docs.elizaos.ai/");
  await page.goForward({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });

  // Close-all removes the user's tabs. The server re-seeds a default tab on last
  // close (#13810), so the view never gets stuck in a broken zero-tab state —
  // the fold control keeps naming an active tab. Assert the closable set is
  // gone (close-all disabled) rather than a fixed count, since the re-seed is
  // server-owned.
  await closeAllTabs();
  await expectCloseAllDisabled();
  expect(walletOriginMismatchWarnings).toEqual([]);
});

test("browser page clears the resting chat and keeps compact mobile chrome touch-safe", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetBrowserWorkspaceTabs(request);
  // Focusing an empty composer deliberately stays collapsed. This geometry
  // case needs a restored thread to exercise the expanded overlay.
  const conversation = {
    id: "browser-geometry-thread",
    roomId: "browser-geometry-room",
    title: "Browser review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const threadText = "The browser review is ready to continue.";
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: { conversations: [conversation] } });
  });
  await page.route(`**/api/conversations/${conversation.id}`, async (route) => {
    if (!["GET", "PATCH"].includes(route.request().method()))
      return route.fallback();
    await route.fulfill({ json: { conversation } });
  });
  await page.route(
    `**/api/conversations/${conversation.id}/messages**`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        json: {
          messages: [
            {
              id: "browser-review-message",
              role: "assistant",
              text: threadText,
              timestamp: Date.now(),
            },
          ],
        },
      });
    },
  );
  await openAppPath(page, "/browser");
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });

  const addressInput = browserWorkspaceView.getByTestId(
    "browser-workspace-address-input",
  );
  await expect(addressInput).toBeVisible({ timeout: 120_000 });
  await addressInput.fill("example.com");
  await addressInput.press("Enter");

  const pageSurface = browserWorkspaceView.getByTestId(
    "browser-workspace-surface-panel",
  );
  const iframe = browserWorkspaceView.locator("iframe").first();
  await expect(iframe).toBeVisible({ timeout: 20_000 });
  const collapsedGeometry = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-testid="browser-workspace-surface-panel"]',
    );
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="browser-workspace-view"] iframe',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-sheet-surface"]',
    );
    const toolbar = document.querySelector<HTMLElement>(
      '[data-testid="browser-workspace-toolbar"]',
    );
    if (!surface || !frame || !chat || !toolbar) return null;
    return {
      surfaceBottom: surface.getBoundingClientRect().bottom,
      frameBottom: frame.getBoundingClientRect().bottom,
      chatTop: chat.getBoundingClientRect().top,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      viewportWidth: window.innerWidth,
      controls: Array.from(
        toolbar.querySelectorAll<HTMLElement>("button, input"),
      )
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => ({
          label:
            control.getAttribute("aria-label") ??
            control.getAttribute("data-testid") ??
            control.tagName,
          width: control.getBoundingClientRect().width,
          height: control.getBoundingClientRect().height,
        })),
    };
  });
  expect(collapsedGeometry).not.toBeNull();
  expect(collapsedGeometry?.surfaceBottom).toBeLessThanOrEqual(
    (collapsedGeometry?.chatTop ?? 0) - 7,
  );
  expect(collapsedGeometry?.frameBottom).toBeLessThanOrEqual(
    collapsedGeometry?.surfaceBottom ?? 0,
  );
  for (const control of collapsedGeometry?.controls ?? []) {
    expect(control.height, control.label).toBeGreaterThanOrEqual(44);
    expect(control.width, control.label).toBeGreaterThanOrEqual(44);
  }
  if ((collapsedGeometry?.viewportWidth ?? 0) < 640) {
    expect(collapsedGeometry?.toolbarHeight).toBeLessThanOrEqual(100);
  }

  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-top", "47px");
    document.documentElement.style.setProperty(
      "--safe-area-inset-bottom",
      "24px",
    );
    document.documentElement.style.setProperty(
      "--eliza-mobile-nav-offset",
      "60px",
    );
    document.documentElement.style.setProperty(
      "--eliza-chat-clearance",
      "96px",
    );
  });

  const readInsetGeometry = () =>
    page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-view"]',
      );
      const surface = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-surface-panel"]',
      );
      const chrome = root?.closest<HTMLElement>(
        '[data-testid="tab-content-view"]',
      );
      if (!root || !surface || !chrome) return null;

      const rootBox = root.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const chromeBox = chrome.getBoundingClientRect();
      const rootStyle = getComputedStyle(root);
      const chromeStyle = getComputedStyle(chrome);
      const chatClearance = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--eliza-chat-clearance",
        ),
      );
      return {
        chatClearance,
        rootPaddingTop: Math.round(Number.parseFloat(rootStyle.paddingTop)),
        rootPaddingBottom: Math.round(
          Number.parseFloat(rootStyle.paddingBottom),
        ),
        chromePaddingBottom: Math.round(
          Number.parseFloat(chromeStyle.paddingBottom),
        ),
        surfaceBottomGap: Math.round(rootBox.bottom - surfaceBox.bottom),
        shellBottomGap: Math.round(chromeBox.bottom - rootBox.bottom),
      };
    });

  // Fullscreen Browser owns its top status-bar inset. Shared workspace chrome
  // owns bottom navigation; the view adds its content gutter and chat footprint.
  await expect
    .poll(async () => {
      const geometry = await readInsetGeometry();
      if (!geometry) return null;
      return {
        rootPaddingTop: geometry.rootPaddingTop,
        rootOwnsOnlyContentAndChat:
          geometry.rootPaddingBottom === 16 + geometry.chatClearance &&
          geometry.surfaceBottomGap === 16 + geometry.chatClearance,
        chromePaddingBottom: geometry.chromePaddingBottom,
        shellBottomGap: geometry.shellBottomGap,
      };
    })
    .toEqual({
      rootPaddingTop: 47 + 12,
      rootOwnsOnlyContentAndChat: true,
      chromePaddingBottom: 84,
      shellBottomGap: 84,
    });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () => {
      const geometry = await readInsetGeometry();
      if (!geometry) return null;
      return {
        rootPaddingTop: geometry.rootPaddingTop,
        rootOwnsOnlyContentAndChat:
          geometry.rootPaddingBottom === 24 + geometry.chatClearance &&
          geometry.surfaceBottomGap === 24 + geometry.chatClearance,
        chromePaddingBottom: geometry.chromePaddingBottom,
        shellBottomGap: geometry.shellBottomGap,
      };
    })
    .toEqual({
      rootPaddingTop: 47 + 24,
      rootOwnsOnlyContentAndChat: true,
      chromePaddingBottom: 84,
      shellBottomGap: 84,
    });

  const surfaceBeforeChatOpen = await pageSurface.boundingBox();
  const surfaceBeforeChatOpenBottom =
    (surfaceBeforeChatOpen?.y ?? 0) + (surfaceBeforeChatOpen?.height ?? 0);

  const composer = page.getByRole("combobox", { name: "message" });
  await composer.focus();
  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
  await expect(
    chatOverlay.getByText(threadText, { exact: true }),
  ).toBeVisible();
  const expandedGeometry = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-testid="browser-workspace-surface-panel"]',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-overlay"]',
    );
    if (!surface || !chat) return null;
    const surfaceZ = Number.parseInt(getComputedStyle(surface).zIndex, 10);
    return {
      surfaceBottom: surface.getBoundingClientRect().bottom,
      chatZ: Number(getComputedStyle(chat).zIndex),
      surfaceZ: Number.isFinite(surfaceZ) ? surfaceZ : 0,
    };
  });
  expect(expandedGeometry).not.toBeNull();
  expect(Math.round(expandedGeometry?.surfaceBottom ?? 0)).toBe(
    Math.round(surfaceBeforeChatOpenBottom),
  );
  expect(expandedGeometry?.chatZ).toBeGreaterThan(
    expandedGeometry?.surfaceZ ?? 0,
  );

  await page.keyboard.press("Escape");
  await expect(chatOverlay).not.toHaveAttribute("data-open", "true");
});

test("browser tab switcher keeps fixed chrome reachable while the tab list scrolls in mobile landscape", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await resetBrowserWorkspaceTabs(request);
  for (let index = 1; index <= 8; index += 1) {
    const response = await request.post("/api/browser-workspace/tabs", {
      data: {
        url: "about:blank",
        title: `Evidence tab ${index}`,
        show: index === 1,
        partition: "persist:eliza-browser",
        kind: "standard",
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  await openAppPath(page, "/browser");
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("8", { timeout: 120_000 });
  await browserWorkspaceView
    .getByTestId("browser-workspace-tab-fold-control")
    .click();

  const switcher = page.getByTestId("browser-workspace-tab-switcher");
  const header = switcher.getByTestId("browser-workspace-tab-switcher-header");
  const scroller = switcher.getByTestId(
    "browser-workspace-tab-switcher-scroll",
  );
  const newTab = switcher.getByTestId("browser-workspace-tab-switcher-new-tab");
  const dialogClose = switcher.getByRole("button", {
    name: "Close",
    exact: true,
  });
  await expect(switcher).toBeVisible();
  await expect(header).toBeVisible();
  await expect(scroller).toBeVisible();
  await expect(newTab).toBeVisible();
  await expect(dialogClose).toBeVisible();

  const readGeometry = () =>
    page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-tab-switcher"]',
      );
      const fixedHeader = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-tab-switcher-header"]',
      );
      const tabScroller = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-tab-switcher-scroll"]',
      );
      const addTab = document.querySelector<HTMLElement>(
        '[data-testid="browser-workspace-tab-switcher-new-tab"]',
      );
      const chat = document.querySelector<HTMLElement>(
        '[data-testid="chat-sheet-surface"]',
      );
      const close = Array.from(
        dialog?.querySelectorAll<HTMLElement>("button") ?? [],
      ).find((element) => element.getAttribute("aria-label") === "Close");
      if (!dialog || !fixedHeader || !tabScroller || !addTab || !chat || !close)
        return null;

      const rect = (element: HTMLElement) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          left: box.left,
          width: box.width,
          height: box.height,
        };
      };
      const dialogRect = rect(dialog);
      const controls = Array.from(
        new Set(
          Array.from(
            dialog.querySelectorAll<HTMLElement>("button, [role='tab']"),
          ),
        ),
      ).map((control) => ({
        label:
          control.getAttribute("aria-label") ??
          control.textContent?.replace(/\s+/g, " ").trim() ??
          control.tagName,
        ...rect(control),
      }));
      return {
        dialog: dialogRect,
        header: rect(fixedHeader),
        scroller: {
          ...rect(tabScroller),
          clientHeight: tabScroller.clientHeight,
          scrollHeight: tabScroller.scrollHeight,
          scrollTop: tabScroller.scrollTop,
          overflowY: getComputedStyle(tabScroller).overflowY,
        },
        newTab: rect(addTab),
        close: rect(close),
        chat: rect(chat),
        undersizedControls: controls.filter(
          (control) => control.width < 44 || control.height < 44,
        ),
        horizontalOverflow:
          document.documentElement.scrollWidth - window.innerWidth,
      };
    });

  const beforeScroll = await readGeometry();
  expect(beforeScroll).not.toBeNull();
  expect(beforeScroll?.scroller.overflowY).toBe("auto");
  expect(beforeScroll?.scroller.scrollHeight).toBeGreaterThan(
    beforeScroll?.scroller.clientHeight ?? Number.POSITIVE_INFINITY,
  );
  expect(beforeScroll?.scroller.top).toBeGreaterThanOrEqual(
    beforeScroll?.header.bottom ?? Number.POSITIVE_INFINITY,
  );
  expect(beforeScroll?.scroller.bottom).toBeLessThanOrEqual(
    beforeScroll?.dialog.bottom ?? 0,
  );
  expect(beforeScroll?.dialog.bottom).toBeLessThanOrEqual(
    beforeScroll?.chat.top ?? 0,
  );
  expect(beforeScroll?.newTab.top).toBeGreaterThanOrEqual(
    beforeScroll?.dialog.top ?? Number.POSITIVE_INFINITY,
  );
  expect(beforeScroll?.close.top).toBeGreaterThanOrEqual(
    beforeScroll?.dialog.top ?? Number.POSITIVE_INFINITY,
  );
  expect(beforeScroll?.undersizedControls).toEqual([]);
  expect(beforeScroll?.horizontalOverflow).toBe(0);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    switcher.getByRole("tab", { name: "Evidence tab 8" }),
  ).toBeVisible();

  const afterScroll = await readGeometry();
  expect(afterScroll).not.toBeNull();
  expect(Math.round(afterScroll?.header.top ?? -1)).toBe(
    Math.round(beforeScroll?.header.top ?? -2),
  );
  expect(Math.round(afterScroll?.newTab.top ?? -1)).toBe(
    Math.round(beforeScroll?.newTab.top ?? -2),
  );
  expect(Math.round(afterScroll?.close.top ?? -1)).toBe(
    Math.round(beforeScroll?.close.top ?? -2),
  );
  await expect(header).toBeVisible();
  await expect(newTab).toBeVisible();
  await expect(dialogClose).toBeVisible();
});

test("browser iframe focus handoff survives delayed autofocus without stealing deliberate clicks", async ({
  page,
  request,
}) => {
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });

  const appUrl = new URL(page.url());
  const fixtureOrigin = `http://localhost:${appUrl.port}`;
  await page.route(
    `${fixtureOrigin}/__browser-focus-slow.png`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    },
  );
  await page.route(
    `${fixtureOrigin}/__browser-focus-fixture**`,
    async (route) => {
      const url = new URL(route.request().url());
      const autoFocus = url.searchParams.get("auto") === "1";
      const slowLoad = url.searchParams.get("slow") === "1";
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
        <html>
          <body>
            <label for="focus-target">Fixture input</label>
            <input id="focus-target" data-testid="focus-target" />
            ${slowLoad ? '<img alt="slow" src="/__browser-focus-slow.png" />' : ""}
            <script>
              window.addEventListener("load", () => {
                document.body.dataset.loaded = "true";
                if (${JSON.stringify(autoFocus)}) {
                  setTimeout(() => document.querySelector("#focus-target").focus(), 120);
                }
              });
            </script>
          </body>
        </html>`,
      });
    },
  );

  const addressInput = browserWorkspaceView.getByTestId(
    "browser-workspace-address-input",
  );
  const delayedAddressUrl = `${fixtureOrigin}/__browser-focus-fixture?auto=1&case=address`;
  await addressInput.fill(delayedAddressUrl);
  await addressInput.press("Enter");
  const iframe = browserWorkspaceView.locator("iframe").first();
  await expect(iframe).toHaveAttribute("src", delayedAddressUrl, {
    timeout: 20_000,
  });
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      ),
    )
    .toBe("browser-workspace-address-input");

  const snapshotResponse = await request.get("/api/browser-workspace");
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot: unknown = await snapshotResponse.json();
  expect(isBrowserWorkspaceSmokeSnapshot(snapshot)).toBe(true);
  if (!isBrowserWorkspaceSmokeSnapshot(snapshot) || !snapshot.tabs[0]) return;
  const tabId = snapshot.tabs[0].id;

  const composer = page.getByRole("combobox", { name: "message" });
  // The page may remain under a stationary pointer while the user types in
  // chat. Hover alone must not authorize a later page autofocus.
  await iframe.hover();
  await composer.focus();
  const polledAgentUrl = `${fixtureOrigin}/__browser-focus-fixture?auto=1&case=agent-poll`;
  const navigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: polledAgentUrl } },
  );
  expect(navigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", polledAgentUrl, {
    timeout: 10_000,
  });
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      ),
    )
    .toBe("chat-composer-textarea");

  await composer.focus();
  const intentionalClickUrl = `${fixtureOrigin}/__browser-focus-fixture?slow=1&case=user-click`;
  const clickNavigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: intentionalClickUrl } },
  );
  expect(clickNavigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", intentionalClickUrl, {
    timeout: 10_000,
  });
  const fixtureInput = page.frameLocator("iframe").getByTestId("focus-target");
  await fixtureInput.click();
  await page.waitForTimeout(1_800);
  await expect(fixtureInput).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe("IFRAME");

  // After load, cross-origin pointer events do not bubble to the parent. A
  // genuine press must still cancel the autofocus guard without making hover
  // alone an authorization signal.
  await composer.focus();
  const postLoadClickUrl = `${fixtureOrigin}/__browser-focus-fixture?case=user-click-after-load`;
  const postLoadClickNavigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: postLoadClickUrl } },
  );
  expect(postLoadClickNavigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", postLoadClickUrl, {
    timeout: 10_000,
  });
  const loadedBody = page
    .frameLocator("iframe")
    .locator("body[data-loaded='true']");
  await expect(loadedBody).toBeVisible();
  const postLoadFixtureInput = page
    .frameLocator("iframe")
    .getByTestId("focus-target");
  await postLoadFixtureInput.click();
  await page.waitForTimeout(1_800);
  await expect(postLoadFixtureInput).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe("IFRAME");
});
