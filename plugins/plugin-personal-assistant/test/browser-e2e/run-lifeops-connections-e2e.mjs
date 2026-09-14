/**
 * Real-Chromium, no-provider acceptance harness for LifeOps connections.
 * It serves an isolated in-memory fixture on port 41873 by default and writes
 * screenshots, recordings, and browser diagnostics to a temporary directory.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { build as viteBuild } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const port = Number.parseInt(process.env.LIFEOPS_E2E_PORT ?? "41873", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 50001) {
  throw new Error(
    "LIFEOPS_E2E_PORT must be a non-native port from 1024 to 65535.",
  );
}

const adapterStub = join(here, "lifeops-connections-adapter-stub.ts");
const result = await viteBuild({
  configFile: false,
  root: repoRoot,
  resolve: { conditions: ["eliza-source", "browser"] },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    tailwindcss(),
    {
      name: "lifeops-production-adapter-stub",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          source === "@elizaos/shared" &&
          importer?.endsWith("/lifeops/time.ts")
        ) {
          return join(here, "lifeops-time-host-fixture.ts");
        }
        if (source === "./handoff-adapter.js") return adapterStub;
        if (
          source === "./deletion-adapter.js" &&
          importer?.endsWith("FamilyDeletionPanel.tsx")
        )
          return adapterStub;
        return source === "./adapter.js" &&
          (importer?.endsWith("LifeOpsConnectionsView.tsx") ||
            importer?.endsWith("FamilyOperationsView.tsx") ||
            importer?.endsWith("intake-adapter.ts"))
          ? adapterStub
          : null;
      },
    },
  ],
  build: {
    write: false,
    cssCodeSplit: false,
    minify: false,
    rollupOptions: {
      input: join(here, "lifeops-connections-fixture.tsx"),
      output: { format: "iife", inlineDynamicImports: true },
    },
  },
});
const buildResult = Array.isArray(result) ? result[0] : result;
const bundle = buildResult.output.find(
  (entry) => entry.type === "chunk" && entry.isEntry,
)?.code;
if (!bundle) throw new Error("LifeOps fixture bundle was empty.");
const styles = buildResult.output
  .filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"))
  .map((entry) => String(entry.source))
  .join("\n");
if (!styles)
  throw new Error("LifeOps fixture omitted production control styles.");

const emittedAssets = new Map(
  buildResult.output
    .filter((entry) => entry.type === "asset")
    .map((entry) => [`/${entry.fileName}`, entry.source]),
);

const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LifeOps no-provider acceptance</title><style>:root{color-scheme:dark;--brand-white:#fdfaf7;--brand-black:#000;--brand-orange:#ff6a1f;--txt:var(--brand-white);--muted:rgba(255,255,255,.56);--bg:var(--brand-black);--card:#121212;--bg-muted:rgba(255,255,255,.06);--bg-accent:var(--brand-black);--accent:#ff6a1f;--accent-muted:#c94400;--accent-foreground:var(--brand-black);--accent-subtle:rgba(255,106,31,.14);--border:rgba(255,255,255,.12);--border-strong:rgba(255,255,255,.22);--status-success:#4ade80;--status-success-bg:rgba(74,222,128,.16);--status-warning:#ff6a1f;--status-warning-bg:rgba(255,106,31,.12);--status-danger:#ff6a1f;--status-danger-bg:rgba(255,106,31,.12);--scrim:rgba(0,0,0,.72)}html,body,#root{width:100%;height:100%;margin:0;background:var(--bg);color:var(--txt);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture.js") {
      return new Response(bundle, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(
        html.replace("<style>", `<style>${styles}</style><style>`),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }
    const asset = emittedAssets.get(url.pathname);
    if (asset !== undefined) {
      return new Response(asset, {
        headers: {
          "content-type": url.pathname.endsWith(".woff2")
            ? "font/woff2"
            : url.pathname.endsWith(".woff")
              ? "font/woff"
              : "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

const outputDir = await mkdtemp(join(tmpdir(), "eliza-lifeops-e2e-"));
const baseURL = `http://127.0.0.1:${port}`;
const holdOpen = process.env.LIFEOPS_E2E_HOLD_OPEN === "1";
let failures = 0;
function assert(condition, message) {
  process.stdout.write(`${condition ? "PASS" : "FAIL"} ${message}\n`);
  if (!condition) failures += 1;
}

function relativeLuminance(color) {
  const [red, green, blue] = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map((value) => Number(value) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const light = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const dark = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (light + 0.05) / (dark + 0.05);
}

async function openFamilyMonth(page, month) {
  const input = page.getByLabel("Month to prepare");
  if ((await input.inputValue()) === month) return;
  await input.fill(month);
  await page.getByRole("button", { name: "Open month", exact: true }).click();
  await page
    .getByRole("heading", { name: `Selected correspondence for ${month}` })
    .waitFor();
}

const browser = await chromium.launch({
  headless: true,
  slowMo: process.env.ELIZA_LIFEOPS_E2E_RECORD_SLOW === "1" ? 750 : 0,
});
try {
  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const pageErrors = [];
  desktop.on("pageerror", (error) => {
    pageErrors.push(String(error));
    process.stderr.write(`Browser initialization error: ${error.stack}\n`);
  });
  await desktop.goto(baseURL);
  await desktop.getByRole("heading", { name: /Bring your inbox/ }).waitFor();
  const initialColors = await desktop
    .getByRole("heading", { name: /Bring your inbox/ })
    .evaluate((heading) => ({
      foreground: getComputedStyle(heading).color,
      background: getComputedStyle(document.body).backgroundColor,
    }));
  assert(
    contrastRatio(initialColors.foreground, initialColors.background) >= 7,
    "primary text keeps enhanced contrast in the standalone fixture",
  );
  const primaryButton = desktop.getByRole("button", {
    name: "Seed selected context",
  });
  const rangeColors = await desktop
    .getByRole("button", { name: "7 days", exact: true })
    .evaluate((button) => ({
      foreground: getComputedStyle(button).color,
      background: getComputedStyle(button.closest("section")).backgroundColor,
    }));
  assert(
    contrastRatio(rangeColors.foreground, rangeColors.background) >= 4.5,
    "unselected history range remains legible on the dark panel",
  );
  const primaryRestColors = await primaryButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
    };
  });
  assert(
    contrastRatio(primaryRestColors.foreground, primaryRestColors.background) >=
      4.5,
    "primary action resting contrast remains WCAG AA",
  );
  await primaryButton.hover();
  const primaryHoverColors = await primaryButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
    };
  });
  assert(
    contrastRatio(
      primaryHoverColors.foreground,
      primaryHoverColors.background,
    ) >= 4.5,
    "primary action hover contrast remains WCAG AA",
  );
  assert(
    relativeLuminance(primaryHoverColors.background) <
      relativeLuminance(primaryRestColors.background),
    "primary action hover is darker than its resting orange",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-primary-hover.png"),
    fullPage: true,
    animations: "disabled",
  });
  await desktop.mouse.move(0, 0);
  assert(
    await desktop.getByText(/Some calendar sources failed/).isVisible(),
    "partial source failure is explicit",
  );
  assert(
    await desktop.getByText(/History cursor: incremental/).isVisible(),
    "Gmail History cursor health is visible",
  );
  assert(
    await desktop.getByText("Permission denied").isVisible(),
    "Apple permission denial is actionable",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-initial.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop.getByRole("button", { name: "7 days", exact: true }).click();
  await desktop.getByRole("button", { name: "Seed selected context" }).click();
  await desktop.getByTestId("seed-receipt").waitFor();
  assert(
    (await desktop.getByTestId("seed-receipt").textContent()).includes(
      "6 Gmail messages and 5 calendar events from 2 sources",
    ),
    "bounded cross-provider seed reports counts",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-seeded.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop
    .getByRole("button", {
      name: "Retry all connection checks and synchronization",
    })
    .click();
  await desktop.getByText(/Some calendar sources failed/).waitFor({
    state: "detached",
  });
  assert(
    (await desktop.getByText(/Some calendar sources failed/).count()) === 0 &&
      (await desktop.getByTestId("seed-receipt").count()) === 1,
    "partial failure recovers through an explicit retry",
  );

  await desktop
    .getByRole("button", { name: /Purge imported Google data/ })
    .click();
  assert(
    await desktop.getByRole("alertdialog").isVisible(),
    "local projection purge requires confirmation",
  );
  assert(
    (await desktop.evaluate(() =>
      document.activeElement?.textContent?.trim(),
    )) === "Cancel",
    "destructive confirmation receives keyboard focus",
  );
  const confirmPurge = desktop.getByRole("button", { name: "Confirm purge" });
  for (const state of ["rest", "hover"]) {
    if (state === "hover") await confirmPurge.hover();
    const colors = await confirmPurge.evaluate((element) => ({
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    assert(
      contrastRatio(colors.foreground, colors.background) >= 4.5,
      `production destructive confirmation ${state} contrast remains WCAG AA`,
    );
    await desktop.screenshot({
      path: join(outputDir, `desktop-confirm-purge-${state}.png`),
      fullPage: true,
    });
  }
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("alertdialog").waitFor({ state: "detached" });
  assert(
    (await desktop.getByRole("alertdialog").count()) === 0 &&
      (await desktop.getByTestId("purge-receipt").count()) === 0,
    "Escape cancels a destructive confirmation without an effect",
  );
  await desktop
    .getByRole("button", { name: /Purge imported Google data/ })
    .click();
  await desktop.getByRole("button", { name: "Confirm purge" }).click();
  await desktop.getByTestId("purge-receipt").waitFor();
  assert(
    (await desktop.getByTestId("purge-receipt").textContent()).includes(
      "Providers were not changed",
    ),
    "purge receipt denies provider mutation",
  );

  await desktop
    .getByRole("button", { name: /Disconnect Google account/ })
    .click();
  await desktop.getByRole("button", { name: "Confirm disconnect" }).click();
  await desktop.getByText("No Google account is connected.").waitFor();
  assert(
    !(await desktop
      .getByRole("button", { name: "Seed selected context" })
      .isDisabled()),
    "disconnect clears stale Google identity while preserving Apple-only seed",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-disconnected.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop.getByRole("button", { name: /Continue to Google/ }).click();
  await desktop
    .getByRole("combobox", { name: "Active Google account" })
    .waitFor();
  await desktop.getByRole("button", { name: "Seed selected context" }).click();
  await desktop.getByTestId("seed-receipt").waitFor();
  assert(
    (await desktop.getByTestId("seed-receipt").textContent()).includes(
      "6 Gmail messages and 5 calendar events",
    ),
    "reconnect reuses stable identities without duplicate counts",
  );
  await desktop.getByRole("button", { name: "Review inbox drafts" }).click();
  assert(
    (await desktop.evaluate(
      () => document.documentElement.dataset.lastNavigation,
    )) === "/inbox",
    "draft review stays separate from sending",
  );
  await desktop
    .getByRole("button", { name: "Review calendar changes" })
    .click();
  assert(
    (await desktop.evaluate(
      () => document.documentElement.dataset.lastNavigation,
    )) === "/calendar",
    "calendar review stays separate from provider mutation",
  );
  assert(pageErrors.length === 0, "desktop flow has no page errors");

  const multiAccount = await browser.newPage({
    viewport: { width: 1180, height: 850 },
  });
  await multiAccount.goto(`${baseURL}?scenario=multi-account`);
  await multiAccount
    .getByRole("combobox", { name: "Active Google account" })
    .click();
  await multiAccount
    .getByRole("option", { name: "fixture-second@example.test", exact: true })
    .click();
  await multiAccount
    .getByRole("button", { name: "Seed selected context" })
    .click();
  await multiAccount.getByTestId("seed-receipt").waitFor();
  const multiSeed = JSON.parse(
    await multiAccount.evaluate(
      () => document.documentElement.dataset.seedRequest ?? "null",
    ),
  );
  assert(
    multiSeed.grantId === "connector-account:fixture-account-2" &&
      multiSeed.calendarKeys.some((key) =>
        key.includes("fixture-second-primary"),
      ) &&
      multiSeed.calendarKeys.some((key) => key.includes("fixture-apple")) &&
      !multiSeed.calendarKeys.some((key) => key.endsWith('"primary"]')),
    "account switching excludes hidden calendars from another Google grant",
  );
  await multiAccount
    .getByRole("combobox", { name: "Destination for built-in calendar events" })
    .click();
  await multiAccount
    .getByRole("option", {
      name: "Second work — fixture-second@example.test",
      exact: true,
    })
    .click();
  await multiAccount
    .getByRole("button", { name: "Verify and save destination" })
    .click();
  await multiAccount
    .getByText(
      "Current destination: Second work — fixture-second@example.test",
      { exact: true },
    )
    .waitFor();
  assert(
    (await multiAccount
      .getByText("Synchronization is paused.", { exact: true })
      .count()) === 1,
    "saving a reviewed destination does not resume synchronization",
  );
  await multiAccount
    .getByRole("button", { name: "Verify and resume sync" })
    .click();
  await multiAccount
    .getByText("Synchronization is enabled.", { exact: true })
    .waitFor();
  assert(
    await multiAccount
      .getByRole("combobox", {
        name: "Destination for built-in calendar events",
      })
      .isDisabled(),
    "active synchronization prevents changing the reviewed destination",
  );
  await multiAccount.getByRole("button", { name: "Pause sync" }).click();
  await multiAccount
    .getByText("Synchronization is paused.", { exact: true })
    .waitFor();
  await multiAccount.screenshot({
    path: join(outputDir, "calendar-sync-reviewed-desktop.png"),
    fullPage: true,
  });
  await multiAccount.close();

  for (const unresolved of [true, false]) {
    const recovery = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await recovery.goto(
      `${baseURL}?pending-sync=1${unresolved ? "&failure=recover" : ""}`,
    );
    const resume = recovery.getByRole("button", {
      name: "Verify and resume sync",
    });
    await recovery
      .getByRole("button", { name: "Check pending operation" })
      .waitFor();
    assert(
      await resume.isDisabled(),
      "pending operation blocks resume before verification",
    );
    await recovery
      .getByRole("button", { name: "Check pending operation" })
      .click();
    if (unresolved) {
      await recovery
        .getByRole("alert")
        .filter({ hasText: "Provider outcome is still uncertain" })
        .waitFor();
      assert(
        await resume.isDisabled(),
        "unresolved provider outcome preserves the resume barrier",
      );
    } else {
      await recovery
        .getByRole("button", { name: "Check pending operation" })
        .waitFor({ state: "detached" });
      assert(
        !(await resume.isDisabled()),
        "provider-confirmed recovery permits a separate resume review",
      );
    }
    assert(
      (await recovery
        .getByText("Synchronization is paused.", { exact: true })
        .count()) === 1,
      "recovery never resumes synchronization automatically",
    );
    await recovery
      .getByRole("heading", { name: "Calendar synchronization" })
      .scrollIntoViewIfNeeded();
    await recovery.screenshot({
      path: join(
        outputDir,
        `calendar-sync-recovery-${unresolved ? "unresolved" : "verified"}-mobile.png`,
      ),
    });
    await recovery
      .getByRole("heading", { name: "Calendar synchronization" })
      .locator("..")
      .screenshot({
        path: join(
          outputDir,
          `calendar-sync-recovery-${unresolved ? "unresolved" : "verified"}-panel.png`,
        ),
      });
    await recovery.close();
  }

  const appleOnly = await browser.newPage({
    viewport: { width: 1024, height: 800 },
  });
  await appleOnly.goto(`${baseURL}?scenario=apple-only&permission=granted`);
  await appleOnly.getByText("No Google account is connected.").waitFor();
  assert(
    !(await appleOnly
      .getByRole("button", { name: "Seed selected context" })
      .isDisabled()),
    "Apple Calendar can seed without a fabricated Google grant",
  );
  await appleOnly
    .getByRole("button", { name: "Seed selected context" })
    .click();
  await appleOnly.getByTestId("seed-receipt").waitFor();
  const appleSeed = JSON.parse(
    await appleOnly.evaluate(
      () => document.documentElement.dataset.seedRequest ?? "null",
    ),
  );
  assert(
    appleSeed.grantId === null &&
      appleSeed.includeGmail === false &&
      appleSeed.calendarKeys.length === 1,
    "Apple-only seed receipt preserves provider-neutral identity",
  );
  await appleOnly.screenshot({
    path: join(outputDir, "desktop-apple-only.png"),
    fullPage: true,
    animations: "disabled",
  });
  await appleOnly.close();

  const capabilityPage = await browser.newPage({
    viewport: { width: 1024, height: 800 },
  });
  await capabilityPage.goto(`${baseURL}?scenario=capture-connect`);
  assert(
    await capabilityPage
      .getByRole("checkbox", { name: /Create drafts/ })
      .isChecked(),
    "draft capability defaults on without implying send",
  );
  for (const name of [
    /Send approved email/,
    /Manage labels and mailbox state/,
    /Change Google Calendar/,
  ]) {
    const checkbox = capabilityPage.getByRole("checkbox", { name });
    assert(!(await checkbox.isChecked()), `${name.source} effect defaults off`);
    await checkbox.check();
  }
  await capabilityPage
    .getByRole("button", { name: /Connect another Google account/ })
    .click();
  const requestedCapabilities = JSON.parse(
    await capabilityPage.evaluate(
      () => document.documentElement.dataset.connectCapabilities ?? "[]",
    ),
  );
  assert(
    requestedCapabilities.includes("google.gmail.send") &&
      requestedCapabilities.includes("google.gmail.manage") &&
      requestedCapabilities.includes("google.calendar.write"),
    "effect scopes are requested only after explicit selection",
  );
  await capabilityPage.close();

  for (const [permission, label] of [
    ["limited", "Write only"],
    ["restricted", "Restricted"],
    ["not-applicable", "Not available here"],
  ]) {
    const permissionPage = await browser.newPage();
    await permissionPage.goto(`${baseURL}?permission=${permission}`);
    assert(
      await permissionPage.getByText(label, { exact: true }).isVisible(),
      `Apple ${permission} permission state is explicit`,
    );
    await permissionPage.close();
  }

  const requestPermission = await browser.newPage();
  await requestPermission.goto(`${baseURL}?permission=not-determined`);
  await requestPermission
    .getByRole("button", { name: "Request permission" })
    .click();
  await requestPermission.getByText("Full access", { exact: true }).waitFor();
  assert(
    (await requestPermission
      .getByText("Full access", { exact: true })
      .isVisible()) &&
      (await requestPermission
        .getByRole("button", { name: "Request permission" })
        .count()) === 0,
    "Apple permission request refreshes to the granted state",
  );
  await requestPermission.close();

  const faultCases = [
    {
      query: "failure=load",
      expected: "Fixture connection inventory failed.",
      act: async (page) => {
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page
          .getByRole("combobox", { name: "Active Google account" })
          .waitFor();
      },
      message:
        "initial inventory failure recovers without fabricated empty state",
    },
    {
      query: "failure=seed",
      expected: "Fixture initial sync failed during calendar import.",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Seed selected context" })
          .click();
      },
      message: "partial seed failure is explicit and retryable",
    },
    {
      query: "failure=calendar",
      expected: "Fixture calendar selection could not be saved.",
      act: async (page) => {
        await page.getByRole("checkbox", { name: /Work/ }).click();
      },
      message: "calendar-selection failure preserves the prior selection",
    },
    {
      query: "failure=permission&permission=not-determined",
      expected: "Fixture Calendar permission request failed.",
      act: async (page) => {
        await page.getByRole("button", { name: "Request permission" }).click();
      },
      message: "Apple permission request failure is actionable",
    },
    {
      query: "failure=settings",
      expected: "Fixture System Settings launch failed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Open System Settings" })
          .click();
      },
      message: "System Settings launch failure is actionable",
    },
    {
      query: "failure=purge",
      expected: "Fixture local purge failed; no data was removed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Purge imported Google data/ })
          .click();
        await page.getByRole("button", { name: "Confirm purge" }).click();
      },
      message: "failed local purge never displays a success receipt",
    },
    {
      query: "failure=disconnect",
      expected: "Fixture disconnect failed; connection is unchanged.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Disconnect Google account/ })
          .click();
        await page.getByRole("button", { name: "Confirm disconnect" }).click();
      },
      message: "failed disconnect keeps the account visibly connected",
    },
    {
      query: "scenario=capture-connect&failure=connect",
      expected: "Fixture Google connect failed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Connect another Google account/ })
          .click();
      },
      message: "Google connect failure restores controls and reports the cause",
    },
  ];
  for (const fault of faultCases) {
    const faultPage = await browser.newPage();
    const faultErrors = [];
    faultPage.on("pageerror", (error) => faultErrors.push(String(error)));
    await faultPage.goto(`${baseURL}?${fault.query}`);
    await faultPage
      .getByRole("heading", {
        name:
          fault.query === "failure=load"
            ? "Connections are unavailable"
            : /Bring your inbox/,
      })
      .waitFor();
    if (fault.query === "failure=load") {
      await faultPage.getByRole("alert").waitFor();
    } else {
      await fault.act(faultPage);
      await faultPage.getByRole("alert").waitFor();
    }
    assert(
      (await faultPage.getByRole("alert").textContent()).includes(
        fault.expected,
      ),
      fault.message,
    );
    if (fault.query === "failure=load") await fault.act(faultPage);
    if (fault.query === "failure=calendar") {
      assert(
        await faultPage.getByRole("checkbox", { name: /Work/ }).isChecked(),
        "failed calendar selection remains checked",
      );
    }
    if (fault.query === "failure=purge") {
      assert(
        (await faultPage.getByTestId("purge-receipt").count()) === 0,
        "failed purge emits no success receipt",
      );
    }
    if (fault.query === "failure=disconnect") {
      assert(
        await faultPage
          .getByRole("combobox", { name: "Active Google account" })
          .isVisible(),
        "failed disconnect preserves connected account state",
      );
    }
    assert(
      faultErrors.length === 0,
      `${fault.query} has no uncaught page error`,
    );
    await faultPage.close();
  }

  for (const width of [1180, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      isMobile: width === 390,
      hasTouch: width === 390,
      recordVideo: { dir: join(outputDir, `deletion-${width}-video`) },
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2026-09-13T13:00:00.000Z"));
    const errors = [];
    const frontend = [];
    page.on("console", (message) =>
      frontend.push({
        type: "console",
        level: message.type(),
        text: message.text(),
      }),
    );
    page.on("response", (response) =>
      frontend.push({
        type: "response",
        method: response.request().method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
      }),
    );
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${baseURL}?scenario=family-deletion`);
    await page
      .getByRole("button", { name: "Review workspace deletion" })
      .click();
    const confirm = page.getByRole("button", {
      name: "Delete reviewed workspace",
    });
    await confirm.waitFor();
    assert(
      await confirm.isDisabled(),
      "deletion requires review and retention selection",
    );
    await page.getByText(/Review all 2 affected records/).click();
    await page.getByRole("button", { name: "After 7 days" }).click();
    await page.getByRole("checkbox").check();
    await confirm.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    assert(
      await page.getByRole("button").evaluateAll((buttons) =>
        buttons.every((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.height >= 44 && bounds.width >= 44;
        }),
      ),
      `deletion ${width}px buttons meet the 44px touch target`,
    );
    await page.screenshot({
      path: join(outputDir, `deletion-review-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await confirm.hover();
    await page.screenshot({
      path: join(outputDir, `deletion-review-hover-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await confirm.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Workspace changed" })
      .waitFor();
    assert((await confirm.count()) === 0, "stale review cannot be resubmitted");
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    await page.getByRole("checkbox").waitFor();
    assert(
      !(await page.getByRole("checkbox").isChecked()),
      "new snapshot needs new review acknowledgement",
    );
    await page.getByRole("checkbox").check();
    await confirm.click();
    await page
      .getByText("Access is revoked. Primary-file cleanup is still pending.")
      .waitFor();
    await page.screenshot({
      path: join(outputDir, `deletion-primary-pending-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await page
      .getByRole("button", { name: "Review workspace deletion" })
      .click();
    await page.getByRole("button", { name: "Retry primary cleanup" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Cleanup response was interrupted" })
      .waitFor();
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    await page
      .getByText(
        "Primary cleanup is verified. Backup cleanup is pending; deletion is not complete.",
      )
      .waitFor();
    assert(
      (await page
        .getByRole("button", { name: "Retry primary cleanup" })
        .count()) === 0,
      "verified primary cleanup is not repeated",
    );
    await page.screenshot({
      path: join(outputDir, `deletion-backup-pending-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Review backup copies" }).click();
    const confirmBackups = page.getByRole("button", {
      name: "Confirm reviewed backup cleanup",
    });
    assert(
      await confirmBackups.isDisabled(),
      "whole archive removal needs separate acknowledgement",
    );
    await page.getByText("Review all 1 backup copies").click();
    await page
      .getByRole("checkbox", { name: /I reviewed every backup/ })
      .check();
    await confirmBackups.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(outputDir, `deletion-archive-review-${width}.png`),
      fullPage: true,
    });
    await confirmBackups.click();
    const retryBackups = page.getByRole("button", {
      name: "Retry backup cleanup",
    });
    assert(
      await retryBackups.isDisabled(),
      "retention deadline prevents early archive removal",
    );
    await page.screenshot({
      path: join(outputDir, `deletion-archive-retained-${width}.png`),
      fullPage: true,
    });
    await page.clock.setFixedTime(new Date("2026-09-21T13:00:00.000Z"));
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    await retryBackups.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Backup cleanup acknowledgement lost" })
      .waitFor();
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    await page
      .getByText(
        "Workspace deletion is complete. Referenced provider records remain with their providers.",
        { exact: true },
      )
      .waitFor();
    await page.screenshot({
      path: join(outputDir, `deletion-archive-complete-${width}.png`),
      fullPage: true,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert(!overflow, `deletion review fits ${width}px viewport`);
    assert(errors.length === 0, `deletion ${width}px flow has no page errors`);
    await writeFile(
      join(outputDir, `deletion-frontend-${width}.json`),
      JSON.stringify({ frontend, pageErrors: errors }, null, 2),
    );
    await context.close();
  }

  for (const width of [1180, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      hasTouch: width === 390,
      isMobile: width === 390,
      recordVideo: { dir: outputDir, size: { width, height: 850 } },
    });
    const intakePage = await context.newPage();
    const diagnostics = [];
    intakePage.on("pageerror", (error) => diagnostics.push(String(error)));
    const browserLog = [];
    intakePage.on("console", (message) =>
      browserLog.push({
        kind: "console",
        level: message.type(),
        text: message.text(),
      }),
    );
    intakePage.on("response", (response) =>
      browserLog.push({
        kind: "response",
        status: response.status(),
        url: response.url(),
      }),
    );
    intakePage.on("requestfailed", (request) =>
      browserLog.push({
        kind: "request-failed",
        url: request.url(),
        failure: request.failure(),
      }),
    );
    await intakePage.goto(`${baseURL}?scenario=family-packet`);
    await intakePage
      .getByRole("button", { name: "Monthly packet", exact: true })
      .click();
    await openFamilyMonth(intakePage, "2026-10");
    // Expand the app's inner scroller for full-content evidence; interaction recordings retain the normal viewport.
    async function captureIntake(filename, hoverControl) {
      const main = intakePage.locator("main");
      const previousStyle = await main.getAttribute("style");
      await main.evaluate((element) => {
        element.style.height = "auto";
        element.style.overflowY = "visible";
      });
      if (hoverControl) {
        await intakePage.mouse.move(0, 0);
        await hoverControl.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          );
        });
        const resting = await hoverControl.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await hoverControl.hover();
        await hoverControl.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          );
        });
        const hovered = await hoverControl.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          foreground: getComputedStyle(element).color,
        }));
        assert(
          relativeLuminance(hovered.background) < relativeLuminance(resting),
          "intake save hover darkens the orange background",
        );
        assert(
          contrastRatio(hovered.foreground, hovered.background) >= 4.5,
          "intake save hover retains accessible text contrast",
        );
        await writeFile(
          join(outputDir, "family-intake-hover-colors.json"),
          JSON.stringify({ resting, hovered }, null, 2),
        );
      }
      await intakePage.screenshot({
        path: join(outputDir, filename),
        fullPage: true,
      });
      await main.evaluate((element, style) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }, previousStyle);
    }
    const intake = intakePage.getByRole("region", {
      name: "Selected correspondence",
    });
    const sourceText =
      "Please confirm Friday pickup at three.\nKeep this complete quotation for review.";
    await intake
      .getByLabel("Email or message text")
      .fill("Discard this unimported draft.");
    await intake.getByRole("button", { name: "Clear unsaved source" }).click();
    assert(
      (await intake.getByLabel("Email or message text").inputValue()) === "",
      `${width}px clearing an unsaved source does not import it`,
    );
    await intake.getByLabel("Source title").fill("Synthetic pickup email");
    await intake.getByLabel("Email or message text").fill(sourceText);
    await intake.getByRole("button", { name: "Add private source" }).click();
    await intake
      .getByRole("alert")
      .filter({ hasText: "Synthetic connection interrupted" })
      .waitFor();
    assert(
      (await intake.getByLabel("Email or message text").inputValue()) ===
        sourceText,
      `${width}px import failure retains complete source`,
    );
    await intake.getByRole("button", { name: "Add private source" }).click();
    await intake
      .getByRole("heading", { name: "Synthetic pickup email — selected" })
      .waitFor();
    await intake.getByRole("button", { name: "Extract proposals" }).click();
    await intake
      .getByRole("heading", { name: "Synthetic pickup email — proposed" })
      .waitFor();
    const recipient = intake.getByRole("checkbox", {
      name: /Verified fixture guest/,
    });
    assert(
      !(await recipient.isChecked()),
      `${width}px extracted facts start private`,
    );
    await intake.getByText("Source quotation", { exact: true }).click();
    assert(
      (await intake.locator("blockquote").innerText()) === sourceText,
      `${width}px quotation preserves the entire selected source`,
    );
    await captureIntake(`family-intake-proposal-${width}.png`);
    await intake
      .getByLabel("Proposed statement")
      .fill("Discard this unsaved fact edit.");
    await recipient.check();
    await intake.getByRole("button", { name: "Discard fact edits" }).click();
    assert(
      (await intake.getByLabel("Proposed statement").inputValue()) ===
        "Confirm Friday pickup." && !(await recipient.isChecked()),
      `${width}px discard restores the persisted private proposal`,
    );
    await recipient.check();
    await intake.getByRole("button", { name: "Save reviewed facts" }).click();
    await intake
      .getByRole("heading", { name: "Synthetic pickup email — reviewed" })
      .waitFor();
    assert(
      await recipient.isChecked(),
      `${width}px explicitly reviewed recipient survives reload`,
    );
    await intake.getByRole("checkbox", { name: "Include this fact" }).uncheck();
    await intake.getByRole("button", { name: "Save reviewed facts" }).click();
    await recipient.waitFor({ state: "visible" });
    await intakePage.waitForFunction(() => {
      const labels = [...document.querySelectorAll("label")];
      const label = labels.find((entry) =>
        entry.textContent.includes("Verified fixture guest"),
      );
      return label?.control?.getAttribute("aria-checked") === "false";
    });
    assert(
      !(await intake
        .getByRole("checkbox", { name: "Include this fact" })
        .isChecked()),
      `${width}px excluded proposal stays available for restoration`,
    );
    await intake.getByRole("checkbox", { name: "Include this fact" }).check();
    assert(
      !(await recipient.isChecked()),
      `${width}px restoring a fact does not restore prior sharing`,
    );
    const save = intake.getByRole("button", { name: "Save reviewed facts" });
    if (width === 1180) {
      await save.hover();
      await captureIntake("family-intake-review-hover.png", save);
    }
    await save.click();
    await intake.getByRole("button", { name: "Withdraw source" }).click();
    await intake
      .getByRole("heading", { name: "Synthetic pickup email — withdrawn" })
      .waitFor();
    assert(
      (await intake
        .getByRole("button", { name: "Save reviewed facts" })
        .count()) === 0,
      `${width}px withdrawn source cannot be reviewed without reselection`,
    );
    assert(
      await intakePage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `${width}px intake has no horizontal overflow`,
    );
    await captureIntake(`family-intake-withdrawn-${width}.png`);
    assert(
      diagnostics.length === 0,
      `${width}px intake has no uncaught browser errors`,
    );
    await intake
      .getByLabel("Email or message text")
      .fill("Keep this unfinished source in October.");
    await intakePage.getByLabel("Month to prepare").fill("2026-11");
    await intakePage
      .getByRole("button", { name: "Open month", exact: true })
      .click();
    await intakePage.getByText(/Opening 2026-11 will discard/).waitFor();
    await intakePage.getByRole("button", { name: "Keep editing" }).click();
    assert(
      (await intake.getByLabel("Email or message text").inputValue()) ===
        "Keep this unfinished source in October.",
      `${width}px cancelled month switch preserves unsaved text`,
    );
    assert(
      (await intakePage.getByLabel("Month to prepare").inputValue()) ===
        "2026-10",
      `${width}px cancelling a switch restores the displayed active month`,
    );
    await intakePage.getByLabel("Month to prepare").fill("2026-11");
    await intakePage
      .getByRole("button", { name: "Open month", exact: true })
      .click();
    await intakePage
      .getByRole("button", { name: "Discard edits and open month" })
      .click();
    await intakePage
      .getByRole("heading", { name: "Selected correspondence for 2026-11" })
      .waitFor();
    assert(
      (await intake.getByLabel("Email or message text").inputValue()) === "",
      `${width}px accepted month switch clears unsaved text`,
    );
    assert(
      await intakePage
        .getByRole("button", { name: "Generate 2026-11 packet" })
        .isEnabled(),
      `${width}px intake and generation use the same selected month`,
    );
    assert(
      (await intakePage.getByText(/Review guest-shareable draft/).count()) ===
        0,
      `${width}px another month's packet is not shown as the current packet`,
    );
    await openFamilyMonth(intakePage, "2026-10");
    await intake
      .getByRole("heading", { name: "Synthetic pickup email — withdrawn" })
      .waitFor();
    await captureIntake(`family-intake-month-return-${width}.png`);
    await intake.getByText("Fill missing information", { exact: true }).click();
    const interview = intake.getByRole("form", { name: "Owner interview" });
    const answerText =
      "Please confirm the appointment transport.\nThis second line is part of my answer.";
    await interview
      .getByRole("radio", { name: "I have an update", exact: true })
      .check();
    await interview.getByLabel("Your update").fill(answerText);
    await interview
      .getByRole("checkbox", { name: "This update needs an answer" })
      .check();
    await interview
      .getByRole("button", { name: "Save private answer" })
      .click();
    await intake
      .getByRole("alert")
      .filter({ hasText: "Synthetic answer save interrupted" })
      .waitFor();
    assert(
      (await interview.getByLabel("Your update").inputValue()) === answerText,
      `${width}px failed interview save retains the complete answer`,
    );
    await intakePage.getByLabel("Month to prepare").fill("2026-11");
    await intakePage
      .getByRole("button", { name: "Open month", exact: true })
      .click();
    await intakePage.getByText(/Opening 2026-11 will discard/).waitFor();
    await intakePage.getByRole("button", { name: "Keep editing" }).click();
    await interview
      .getByRole("button", { name: "Save private answer" })
      .click();
    await intake
      .getByRole("heading", { name: "Owner interview answer — reviewed" })
      .waitFor();
    const answerReview = intake.locator("article").filter({
      has: intakePage.getByRole("heading", {
        name: "Owner interview answer — reviewed",
      }),
    });
    assert(
      (await answerReview.getByLabel("Proposed statement").inputValue()) ===
        answerText,
      `${width}px saved interview preserves the owner's answer`,
    );
    assert(
      !(await answerReview
        .getByRole("checkbox", { name: /Verified fixture guest/ })
        .isChecked()),
      `${width}px interview answer stays private until recipient review`,
    );
    assert(
      (await interview.getByLabel("Your update").count()) === 0,
      `${width}px successful save clears only the interview draft`,
    );
    await captureIntake(`family-interview-saved-${width}.png`);
    await answerReview.getByText("Resolve request", { exact: true }).click();
    const reasonText =
      "Pickup confirmed by the owner.\nKeep the full resolution reason.";
    await answerReview
      .getByLabel("What resolved this request?")
      .fill(reasonText);
    await answerReview.getByRole("button", { name: "Mark resolved" }).click();
    await intakePage
      .getByText("Synthetic resolution save interrupted. Retry your reason.")
      .waitFor();
    assert(
      (await answerReview
        .getByLabel("What resolved this request?")
        .inputValue()) === reasonText,
      `${width}px failed resolution retains its complete reason`,
    );
    await answerReview.getByRole("button", { name: "Mark resolved" }).click();
    await answerReview
      .getByText(`Resolution: ${reasonText}`, { exact: true })
      .waitFor();
    assert(
      !(await answerReview
        .getByRole("checkbox", { name: "Awaiting an answer" })
        .isChecked()),
      `${width}px resolution refreshes authoritative request state`,
    );
    await captureIntake(`family-request-resolved-${width}.png`);
    await answerReview
      .locator("summary")
      .filter({ hasText: /^Reopen request$/ })
      .click();
    await answerReview
      .getByLabel("Why does this need an answer again?")
      .fill("The pickup arrangement changed.");
    await answerReview.getByRole("button", { name: "Reopen request" }).click();
    await answerReview
      .getByText("Reopened: The pickup arrangement changed.", { exact: true })
      .waitFor();
    assert(
      await answerReview
        .getByRole("checkbox", { name: "Awaiting an answer" })
        .isChecked(),
      `${width}px reopening refreshes authoritative request state`,
    );
    await answerReview
      .getByText("Request decision history", { exact: true })
      .click();
    await answerReview.getByText(reasonText, { exact: true }).waitFor();
    await answerReview
      .getByText("The pickup arrangement changed.", { exact: true })
      .waitFor();
    await captureIntake(`family-request-reopened-${width}.png`);

    await writeFile(
      join(outputDir, `family-intake-${width}-diagnostics.json`),
      JSON.stringify(diagnostics, null, 2),
    );
    await writeFile(
      join(outputDir, `family-intake-${width}-browser-log.json`),
      JSON.stringify(browserLog, null, 2),
    );
    const video = intakePage.video();
    await context.close();
    if (video)
      await video.saveAs(join(outputDir, `family-intake-${width}.webm`));
  }

  for (const width of [1180, 390]) {
    const family = await browser.newPage({
      viewport: { width, height: 850 },
      hasTouch: width === 390,
      isMobile: width === 390,
    });
    const familyErrors = [];
    family.on("pageerror", (error) => familyErrors.push(String(error)));
    await family.goto(`${baseURL}?scenario=family-packet`);
    await family.getByRole("button", { name: "Pin", exact: true }).click();
    await family.getByText("Pin saved.", { exact: true }).waitFor();
    assert(
      (await family.locator("html").getAttribute("data-family-pin-target")) ===
        "fixture-agent",
      `${width}px agent pin uses the current agent without entering an ID`,
    );
    await family
      .getByRole("listitem")
      .filter({ hasText: "This agent: Family assistant" })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await family.getByText("Pin removed.", { exact: true }).waitFor();
    await family.getByRole("combobox", { name: "Pin target type" }).click();
    await family.getByRole("option", { name: "Chat", exact: true }).click();
    const pinTarget = family.getByRole("combobox", {
      name: "Pin conversation",
    });
    await pinTarget.click();
    await family
      .getByRole("option", { name: "Family planning · test", exact: true })
      .click();
    await pinTarget.scrollIntoViewIfNeeded();
    await family.getByRole("button", { name: "Pin", exact: true }).click();
    await family.getByText("Pin saved.", { exact: true }).waitFor();
    assert(
      (await family.locator("html").getAttribute("data-family-pin-target")) ===
        "fixture-acceptance-chat",
      `${width}px named chat selection submits the resolved conversation identity`,
    );
    const clipped = await family.evaluate(() =>
      [
        ...document.querySelectorAll(
          "main section, main button, main input, main select",
        ),
      ]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            (rect.left < -1 || rect.right > window.innerWidth + 1)
          );
        })
        .map(
          (element) => element.getAttribute("aria-label") || element.tagName,
        ),
    );
    assert(
      clipped.length === 0,
      `${width}px populated agreement keeps cards and controls within the viewport: ${clipped.join(", ")}`,
    );
    assert(
      await family
        .getByRole("button", { name: "Pin", exact: true })
        .isEnabled(),
      `${width}px pin form accepts a target without requiring horizontal scrolling`,
    );
    await family.screenshot({
      path: join(outputDir, `family-agreement-${width}.png`),
      animations: "disabled",
    });
    const guestChoice = family.getByLabel("Verified guest permission");
    await guestChoice.selectOption("fixture-permission-alex");
    await family
      .getByRole("button", { name: "Preview permission", exact: true })
      .click();
    await family.getByText("Ready to grant", { exact: true }).waitFor();
    await guestChoice.selectOption("fixture-permission-sam");
    assert(
      await family
        .getByRole("button", { name: "Allow access", exact: true })
        .isDisabled(),
      `${width}px changing guest retires the prior permission preview`,
    );
    await family
      .getByRole("button", { name: "Preview permission", exact: true })
      .click();
    await family.getByText("Ready to grant", { exact: true }).waitFor();
    await family
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    await family.getByText("Guest access enabled.", { exact: true }).waitFor();
    assert(
      (await family
        .locator("html")
        .getAttribute("data-family-guest-target")) === "fixture-caregiver",
      `${width}px named guest sharing uses the previewed person`,
    );
    await family
      .getByLabel("Existing guest access")
      .selectOption("fixture-guest-grant-0");
    await family
      .getByLabel("Reason for removing access")
      .fill("Synthetic review complete.");
    await family.screenshot({
      path: join(outputDir, `family-guest-${width}.png`),
      animations: "disabled",
    });
    await family
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await family.getByText("Guest access removed.", { exact: true }).waitFor();
    await family
      .getByText("No guest access to remove.", { exact: true })
      .waitFor();
    await family
      .getByRole("button", { name: "Monthly packet", exact: true })
      .click();
    await openFamilyMonth(family, "2026-10");
    await family.getByText(/Review guest-shareable draft/).click();
    await family.getByRole("button", { name: "Edit email draft" }).click();
    const editor = family.getByRole("group", { name: "Edit saved email" });
    await editor
      .getByLabel("Email text", { exact: true })
      .fill("Please confirm pickup at 3 PM.\nThank you.");
    await editor
      .getByLabel("Email subject", { exact: true })
      .fill("Updated October plans");
    assert(
      (await family
        .getByRole("button", { name: "Request owner approval" })
        .count()) === 0,
      `${width}px hides approval while unsaved text is being edited`,
    );
    await editor.screenshot({
      path: join(outputDir, `family-editor-${width}.png`),
      animations: "disabled",
    });
    const saveButton = editor.getByRole("button", { name: "Save new draft" });
    if (width === 1180) {
      await saveButton.hover();
      const colors = await saveButton.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      assert(
        contrastRatio(colors.foreground, colors.background) >= 4.5,
        "email save hover preserves readable contrast",
      );
      await editor.screenshot({
        path: join(outputDir, "family-editor-hover.png"),
        animations: "disabled",
      });
    }
    await saveButton.click();
    await family.getByText(/Review guest-shareable draft v2/).waitFor();
    await family
      .getByRole("button", { name: "Request owner approval" })
      .click();
    await family.waitForFunction(
      () => document.documentElement.dataset.familyApprovalVersion === "2",
    );
    assert(
      (await family.evaluate(
        () => document.documentElement.dataset.familyApprovalVersion,
      )) === "2",
      `${width}px approval uses the saved new version`,
    );
    const approve = family.getByRole("button", {
      name: "Approve and send email",
      exact: true,
    });
    await approve.waitFor();
    await family.screenshot({
      path: join(outputDir, `family-approval-pending-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    if (width === 1180) {
      await approve.hover();
      // Measure the settled hover state, not interpolated foreground and fill.
      await approve.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const colors = await approve.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      assert(
        contrastRatio(colors.foreground, colors.background) >= 4.5,
        `email approval hover preserves readable contrast (${colors.foreground} on ${colors.background})`,
      );
      await family.screenshot({
        path: join(outputDir, "family-approval-hover.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    await approve.click();
    await family
      .getByText("Accepted by the email provider.", { exact: true })
      .waitFor();
    assert(
      (await approve.count()) === 0,
      `${width}px completed approval does not offer another send`,
    );
    await family.screenshot({
      path: join(outputDir, `family-approval-accepted-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    const downloading = family.waitForEvent("download");
    await family.getByRole("link", { name: "Download draft record" }).click();
    const download = await downloading;
    const downloadPath = await download.path();
    if (!downloadPath)
      throw new Error("Browser did not write the draft download");
    const recordText = await readFile(downloadPath, "utf8");
    const record = JSON.parse(recordText);
    assert(
      record.draft.body === "Please confirm pickup at 3 PM.\nThank you." &&
        record.draft.email.subject === "Updated October plans",
      `${width}px downloaded record preserves saved edits`,
    );
    assert(
      !recordText.includes("Private fixture canary"),
      `${width}px downloaded draft excludes owner-private claims`,
    );
    assert(
      await family.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `${width}px editor has no horizontal overflow`,
    );
    assert(
      familyErrors.length === 0,
      `${width}px family editing has no page errors`,
    );
    await family.close();
  }
  for (const width of [1180, 390]) {
    for (const decisionCase of ["reject", "unknown"]) {
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(
        `${baseURL}?scenario=family-packet${decisionCase === "unknown" ? "&failure=decision" : ""}`,
      );
      await page
        .getByRole("button", { name: "Monthly packet", exact: true })
        .click();
      await openFamilyMonth(page, "2026-10");
      await page.getByText(/Review guest-shareable draft/).click();
      await page
        .getByRole("button", { name: "Request owner approval" })
        .click();
      await page
        .getByRole("button", {
          name:
            decisionCase === "reject"
              ? "Reject email"
              : "Approve and send email",
          exact: true,
        })
        .click();
      await page
        .getByText(
          decisionCase === "reject"
            ? "Rejected. This approval will not send the email."
            : "Delivery outcome is unknown. Verify the provider record before retrying.",
          { exact: true },
        )
        .waitFor();
      assert(
        (await page
          .getByRole("button", {
            name: /Approve and send email|Retry reviewed email/,
          })
          .count()) === 0,
        `${width}px ${decisionCase} result does not offer an unsafe send`,
      );
      if (decisionCase === "unknown") {
        assert(
          await page
            .getByRole("button", { name: "Edit email draft" })
            .isDisabled(),
          `${width}px unknown delivery cannot be edited into a competing send`,
        );
        await page
          .getByRole("button", { name: "Refresh delivery status" })
          .click();
        await page
          .getByText(
            "Delivery outcome is unknown. Verify the provider record before retrying.",
            { exact: true },
          )
          .waitFor();
      }
      assert(
        errors.length === 0,
        `${width}px ${decisionCase} decision has no page errors`,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${width}px ${decisionCase} decision has no horizontal overflow`,
      );
      await page.screenshot({
        path: join(outputDir, `family-approval-${decisionCase}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await page.close();
    }
  }
  const failedEdit = await browser.newPage();
  await failedEdit.goto(`${baseURL}?scenario=family-packet&failure=revision`);
  await failedEdit
    .getByRole("button", { name: "Monthly packet", exact: true })
    .click();
  await openFamilyMonth(failedEdit, "2026-10");
  await failedEdit.getByText(/Review guest-shareable draft/).click();
  await failedEdit.getByRole("button", { name: "Edit email draft" }).click();
  await failedEdit
    .getByLabel("Email text", { exact: true })
    .fill("Keep this unsaved owner text.");
  await failedEdit.getByRole("button", { name: "Save new draft" }).click();
  await failedEdit
    .getByRole("alert")
    .filter({ hasText: "Fixture revision could not be saved." })
    .waitFor();
  assert(
    (await failedEdit
      .getByLabel("Email text", { exact: true })
      .inputValue()) === "Keep this unsaved owner text.",
    "failed save preserves unsaved owner text",
  );
  assert(
    (await failedEdit
      .getByRole("button", { name: "Request owner approval" })
      .count()) === 0,
    "failed save cannot approve unsaved edits",
  );
  await failedEdit.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(String(error)));
  await mobile.goto(baseURL);
  await mobile.getByRole("heading", { name: /Bring your inbox/ }).waitFor();
  const fitsViewport = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  assert(fitsViewport, "mobile layout has no horizontal overflow");
  const shortButtons = await mobile.locator("button").evaluateAll((buttons) =>
    buttons
      .filter(
        (button) =>
          (button.closest("label") ?? button).getBoundingClientRect().height <
          44,
      )
      .map((button) => ({
        label: button.textContent,
        height: button.getBoundingClientRect().height,
      })),
  );
  assert(
    shortButtons.length === 0,
    "mobile buttons meet the 44px touch target",
  );
  if (shortButtons.length)
    process.stdout.write(`${JSON.stringify(shortButtons)}\n`);
  await mobile.screenshot({
    path: join(outputDir, "mobile-initial.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert(mobileErrors.length === 0, "mobile flow has no page errors");
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      recordVideo: { dir: outputDir, size: { width, height: 900 } },
      reducedMotion: "reduce",
    });
    const local = await context.newPage();
    const diagnostics = [];
    local.on("pageerror", (error) =>
      diagnostics.push({ type: "error", message: String(error) }),
    );
    local.on("console", (message) =>
      diagnostics.push({ type: message.type(), message: message.text() }),
    );
    local.on("response", (response) =>
      diagnostics.push({
        type: "response",
        url: response.url(),
        status: response.status(),
      }),
    );
    await local.goto(`${baseURL}?scenario=built-in-only`);
    await local.getByRole("heading", { name: /Bring your inbox/ }).waitFor();
    for (const heading of await local.getByRole("heading").all()) {
      await heading.scrollIntoViewIfNeeded();
    }
    const source = local.locator('article[data-provider="eliza"]');
    await source.scrollIntoViewIfNeeded();
    await local.screenshot({
      path: join(outputDir, `built-in-health-${width}.png`),
      animations: "disabled",
    });
    await source.screenshot({
      path: join(outputDir, `built-in-health-panel-${width}.png`),
      animations: "disabled",
    });
    const refresh = local.getByRole("button", {
      name: "Retry all connection checks and synchronization",
      exact: true,
    });
    await refresh.scrollIntoViewIfNeeded();
    await local.screenshot({
      path: join(outputDir, `built-in-rest-${width}.png`),
      animations: "disabled",
    });
    await refresh.hover();
    await local.screenshot({
      path: join(outputDir, `built-in-hover-${width}.png`),
      animations: "disabled",
    });
    assert(
      await local.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${width}px built-in-only source has no horizontal overflow`,
    );
    assert(
      !diagnostics.some((entry) => entry.type === "error"),
      `${width}px built-in-only source has no browser errors`,
    );
    await writeFile(
      join(outputDir, `built-in-diagnostics-${width}.json`),
      JSON.stringify(diagnostics, null, 2),
    );
    const video = local.video();
    await context.close();
    if (video)
      await video.saveAs(join(outputDir, `built-in-walkthrough-${width}.webm`));
  }
  await mobile.close();
  await desktop.close();
} finally {
  await browser.close();
}

process.stdout.write(`Evidence: ${outputDir}\n`);
if (failures > 0) process.exitCode = 1;
if (holdOpen && failures === 0) {
  process.stdout.write(`Inspection URL: ${baseURL}\n`);
  await new Promise((resolveHold) => {
    process.once("SIGINT", resolveHold);
    process.once("SIGTERM", resolveHold);
  });
}
server.stop(true);
