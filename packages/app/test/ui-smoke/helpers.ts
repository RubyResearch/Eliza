/**
 * Shared Playwright helpers for app UI-smoke fixtures, navigation, logging,
 * and assertions.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createZipArchive } from "@elizaos/agent/api/zip-utils";
import { expect, type Locator, type Page, type Route } from "@playwright/test";

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// One real bundled VRM (gzipped glTF) shipped under packages/app/dist/vrms/.
// The preview server serves the SPA + the real `vrms/eliza-N.vrm.gz` files, but
// the runtime boot-config it serves has no `vrmAssets`, so `getVrmUrl()` falls
// back to `bundled-1.vrm.gz` which 404s — the gz-decode of a tiny 404 page then
// throws "Invalid typed array length" inside three-vrm. We mock every
// `vrms/*.vrm.gz` request with a real asset so the companion canvas loads a
// model instead. Playwright bundles the test files, so `import.meta.url` points
// at the bundle, not source — resolve relative to process.cwd() (= packages/app/)
// where the suite always runs.
let cachedVrmGz: Buffer | null | undefined;
function bundledVrmGz(): Buffer | null {
  if (cachedVrmGz !== undefined) return cachedVrmGz;
  const candidates = [
    resolve(process.cwd(), "dist/vrms/eliza-1.vrm.gz"),
    resolve(process.cwd(), "packages/app/dist/vrms/eliza-1.vrm.gz"),
    resolve(process.cwd(), "../app/dist/vrms/eliza-1.vrm.gz"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        cachedVrmGz = readFileSync(c);
        return cachedVrmGz;
      } catch {
        /* try next */
      }
    }
  }
  cachedVrmGz = null;
  return cachedVrmGz;
}

function contentTypeForAsset(pathname: string): string {
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function fulfillPublicAsset(route: Route): Promise<boolean> {
  const url = new URL(route.request().url());
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (
    !relativePath.startsWith("brand/") &&
    !relativePath.startsWith("app-heroes/")
  ) {
    return false;
  }
  const assetPath = resolve(process.cwd(), "public", relativePath);
  if (!existsSync(assetPath)) return false;
  await route.fulfill({
    status: 200,
    headers: { "content-type": contentTypeForAsset(relativePath) },
    body: readFileSync(assetPath),
  });
  return true;
}

const ROOT_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 12_000;
// Ready checks only confirm route-level render markers after navigation.
// Full bootstrap waits use the surrounding test timeout and Playwright defaults.
const READY_CHECK_TIMEOUT_MS = 15_000;
const STARTUP_SETTLED_TIMEOUT_MS = 45_000;
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const STORAGE_SEEDED_KEY = "eliza:ui-smoke-storage-seeded";
const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";
const RENDER_TELEMETRY_ERRORS_KEY = "__ELIZA_RENDER_TELEMETRY_ERRORS__";
const RENDER_TELEMETRY_INSTALLED_KEY =
  "__ELIZA_RENDER_TELEMETRY_WATCHER_INSTALLED__";

const renderTelemetryGuardedPages = new WeakSet<Page>();
const browserDiagnosticIssuesByPage = new WeakMap<Page, string[]>();

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type EvaluatedReadyCheck = {
  check: ReadyCheck;
  passed: boolean;
};

type RenderTelemetryIssue = {
  name?: string;
  renderCount?: number;
  windowMs?: number;
  severity?: string;
};

type SmokeNote = {
  id: string;
  title: string;
  body: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

function isSmokeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function smokeString(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function issueMessage(error: Error): string {
  return error.stack || error.message || String(error);
}

function shouldIgnoreRequestFailure(url: string, failureText: string): boolean {
  if (failureText.includes("net::ERR_ABORTED")) return true;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  return false;
}

// Best-effort static probes whose non-2xx answer is the DESIGNED zero-state,
// not a diagnostic error:
//   - Avatar / background EXISTENCE probes: `hasCustomVrm` / `hasCustomBackground`
//     HEAD `/api/avatar/vrm|background` with `allowNonOk`; a non-ok response
//     means "no custom asset" and the client renders the default.
//   - `/build-info.json`: the BuildBadge (#14174) fetches the build-time stamp
//     best-effort and renders NOTHING when it is absent (production/CI builds
//     without the stamp, and the zero-key smoke stack, do not serve it). The
//     browser still emits an automatic "Failed to load resource" console error
//     for the 404 that the code's own try/catch cannot suppress — same contract
//     as the avatar probes, so it is allowlisted here.
function isOptionalAssetProbeUrl(url: string): boolean {
  if (/\/build-info\.json(\?|$)/.test(url)) return true;
  return /\/api\/avatar\/(vrm|background)(\?|$)/.test(url);
}

function shouldIgnoreHttpError(url: string, status: number): boolean {
  if (status < 400) return true;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (isOptionalAssetProbeUrl(url)) return true;
  return false;
}

export function installPageDiagnosticsGuard(page: Page): void {
  if (browserDiagnosticIssuesByPage.has(page)) return;

  const issues: string[] = [];
  browserDiagnosticIssuesByPage.set(page, issues);

  page.on("pageerror", (error) => {
    issues.push(`pageerror: ${issueMessage(error)}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The browser logs an automatic "Failed to load resource" console error for
    // every non-2xx response; its text carries no URL — the resource URL is the
    // message *location*. Skip it only for the optional-asset probes whose
    // non-2xx answer is the expected zero-state (same contract as
    // shouldIgnoreHttpError above); every other console.error still fails.
    if (isOptionalAssetProbeUrl(message.location().url ?? "")) return;
    issues.push(`console.error: ${message.text()}`);
  });

  page.on("requestfailed", (request) => {
    const failureText = request.failure()?.errorText ?? "unknown";
    const url = request.url();
    if (shouldIgnoreRequestFailure(url, failureText)) return;
    issues.push(`requestfailed: ${request.method()} ${url} ${failureText}`);
  });

  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (shouldIgnoreHttpError(url, status)) return;
    issues.push(`http.${status}: ${response.request().method()} ${url}`);
  });
}

export async function expectNoPageDiagnostics(
  page: Page,
  label: string,
): Promise<void> {
  const issues = browserDiagnosticIssuesByPage.get(page) ?? [];
  expect(
    issues,
    `[playwright-ui-smoke] ${label}: expected no browser console.error/pageerror/requestfailed diagnostics; actual=${JSON.stringify(
      issues,
      null,
      2,
    )}`,
  ).toEqual([]);
}

/**
 * Fault-injection variant of {@link expectNoPageDiagnostics}: a spec that
 * deliberately makes the backend fail (e.g. a 500 on POST /api/first-run to
 * drive the error-recovery flow) allowlists exactly those diagnostics; any
 * UNRELATED console.error/pageerror/requestfailed still fails the spec.
 */
export async function expectOnlyAllowedPageDiagnostics(
  page: Page,
  label: string,
  allowed: RegExp[],
): Promise<void> {
  const issues = browserDiagnosticIssuesByPage.get(page) ?? [];
  const unexpected = issues.filter(
    (issue) => !allowed.some((pattern) => pattern.test(issue)),
  );
  expect(
    unexpected,
    `[playwright-ui-smoke] ${label}: diagnostics beyond the injected fault; all=${JSON.stringify(
      issues,
      null,
      2,
    )}`,
  ).toEqual([]);
}

const SETTINGS_SECTION_IDS_BY_LABEL = new Map<string, string>([
  ["Basics", "identity"],
  ["Models & Providers", "ai-model"],
  ["Runtime", "runtime"],
  ["General", "appearance"],
  ["Appearance", "appearance"],
  ["Background", "background"],
  ["Notifications", "notifications"],
  ["Voice", "voice"],
  ["Capabilities", "capabilities"],
  ["Apps", "apps"],
  ["Connectors", "connectors"],
  ["Wearables", "wearables"],
  ["App Permissions", "app-permissions"],
  ["Wallet & RPC", "wallet-rpc"],
  ["Permissions", "permissions"],
  ["Vault", "secrets"],
  ["Secrets storage", "secrets"],
  ["Security", "security"],
  ["Updates", "updates"],
  ["Backups", "advanced"],
  ["Backup & Reset", "advanced"],
  ["My Runtimes", "my-runtimes"],
  ["Desktop app", "desktop-integration"],
  ["Shortcuts", "shortcuts"],
]);

const DEFAULT_APP_STORAGE: Record<string, string> = {
  "eliza:first-run-complete": "1",
  "eliza:setup:step": "activate",
  "eliza:ui-shell-mode": "native",
  "elizaos:active-server": JSON.stringify({
    id: "local:embedded",
    kind: "local",
    label: "This device",
  }),
};

const SMOKE_AGENT = {
  id: "ui-smoke-agent",
  name: "Playwright Smoke",
  status: "running",
} as const;

export const UI_SMOKE_CPU_ONLY_HARDWARE = {
  totalRamGb: 8,
  freeRamGb: 4,
  gpu: null,
  cpuCores: 4,
  platform: "linux",
  arch: "x64",
  appleSilicon: false,
  recommendedBucket: "small",
  source: "os-fallback",
} as const;

export async function seedAppStorage(
  page: Page,
  overrides: Record<string, string> = {},
): Promise<void> {
  const storage = { ...DEFAULT_APP_STORAGE, ...overrides };
  await page.addInitScript(
    ({ entries, seededKey }) => {
      try {
        if (sessionStorage.getItem(seededKey) === "1") {
          return;
        }
        for (const [key, value] of Object.entries(entries)) {
          localStorage.setItem(key, value);
        }
        sessionStorage.setItem(seededKey, "1");
      } catch {
        // Sandboxed or opaque-origin frames can deny Web Storage access.
      }
    },
    { entries: storage, seededKey: STORAGE_SEEDED_KEY },
  );
}

const firstRunSeededPages = new WeakSet<Page>();

/**
 * Seed the shell-reserved `eliza:first-run-complete` flag for the NEXT full page
 * load. That key sits in the shell's reserved `eliza:` namespace, which the
 * surface-realm guard (#15247) lets only privileged shell code write: a raw
 * `localStorage.setItem` on the live page throws {@link SurfaceRealmDeniedError}
 * the moment a view owns the host realm. An `addInitScript` runs at
 * document-start of the reload a caller performs next — before the shell mounts
 * any view and publishes a surface-realm scope — which is the same
 * guard-permitted window `seedAppStorage` seeds through, so the synchronous boot
 * readers route straight to chat without a view-forbidden write. Callers that
 * only flip the mock `/api/first-run/status` still need this so the flag is
 * present on the SYNCHRONOUS boot read, before the API resolves. Install-once
 * per page: the seed then re-runs on every later navigation, which is correct
 * because every load after first-run completes wants the flag set.
 */
export async function seedFirstRunCompleteBeforeLoad(
  page: Page,
): Promise<void> {
  if (firstRunSeededPages.has(page)) return;
  firstRunSeededPages.add(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("eliza:first-run-complete", "1");
    } catch {
      // Opaque-origin / storage-hostile frames deny Web Storage; the mutable
      // /api/first-run/status the caller sets stays the authority there.
    }
  });
}

export async function hideChatOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const install = () => {
      if (document.getElementById("ui-smoke-hide-chat-overlay")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "ui-smoke-hide-chat-overlay";
      style.textContent =
        '[data-testid="chat-overlay"] { display: none !important; }';
      (document.head ?? document.documentElement).appendChild(style);
    };

    if (document.head || document.documentElement) {
      install();
      return;
    }

    document.addEventListener("DOMContentLoaded", install, { once: true });
  });
}

export async function installRenderTelemetryGuard(page: Page): Promise<void> {
  if (renderTelemetryGuardedPages.has(page)) return;
  renderTelemetryGuardedPages.add(page);

  await page.addInitScript(
    ({ eventName, errorsKey, installedKey }) => {
      const win = window as Window &
        Record<string, unknown> & {
          [key: string]: unknown;
        };
      if (win[installedKey]) return;
      win[installedKey] = true;
      win[errorsKey] = [];
      window.addEventListener(eventName, (event) => {
        const detail = (event as CustomEvent<RenderTelemetryIssue>).detail;
        if (detail?.severity !== "error") return;
        const errors = win[errorsKey];
        if (Array.isArray(errors)) {
          errors.push(detail);
        }
      });
    },
    {
      eventName: RENDER_TELEMETRY_EVENT,
      errorsKey: RENDER_TELEMETRY_ERRORS_KEY,
      installedKey: RENDER_TELEMETRY_INSTALLED_KEY,
    },
  );
}

export async function expectNoRenderTelemetryErrors(
  page: Page,
  label: string,
): Promise<void> {
  const errors = await page.evaluate<RenderTelemetryIssue[]>((errorsKey) => {
    const value = (window as Window & Record<string, unknown>)[errorsKey];
    return Array.isArray(value) ? (value as RenderTelemetryIssue[]) : [];
  }, RENDER_TELEMETRY_ERRORS_KEY);
  const summary = errors
    .map(
      (event) =>
        `${event.name ?? "unknown"}:${event.renderCount ?? "?"} renders/${event.windowMs ?? "?"}ms`,
    )
    .join(", ");
  expect(
    errors,
    `[playwright-ui-smoke] ${label}: render telemetry errors detected${summary ? ` (${summary})` : ""}`,
  ).toHaveLength(0);
}

async function expectRootReady(page: Page): Promise<void> {
  await expect(page.locator("#root")).toBeVisible({ timeout: ROOT_TIMEOUT_MS });
}

async function expectNoFirstRunRedirect(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/first-run/, { timeout: NAV_TIMEOUT_MS });
}

async function expectStartupSettled(page: Page): Promise<void> {
  // DOMContentLoaded includes the static preboot shell. Its brand copy is not
  // route readiness; wait until the renderer has taken ownership of #root.
  await expect(page.locator(".eliza-preboot-shell")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
  await page
    .getByText(/Initializing agent|Connecting to backend/i)
    .waitFor({ state: "hidden", timeout: STARTUP_SETTLED_TIMEOUT_MS });
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
}

function isRootTargetPath(targetPath: string): boolean {
  try {
    const url = new URL(targetPath, "http://ui-smoke.local");
    return url.pathname === "/";
  } catch {
    return targetPath === "/" || targetPath.startsWith("/?");
  }
}

function isFirstRunTargetPath(targetPath: string): boolean {
  try {
    const url = new URL(targetPath, "http://ui-smoke.local");
    return url.pathname === "/onboarding" || url.pathname === "/first-run";
  } catch {
    return (
      targetPath === "/onboarding" ||
      targetPath.startsWith("/onboarding?") ||
      targetPath === "/first-run" ||
      targetPath.startsWith("/first-run?")
    );
  }
}

interface OpenAppPathOptions {
  allowOnboardingToast?: boolean;
}

async function expectMainShellReadyForRoute(
  page: Page,
  targetPath: string,
  options: OpenAppPathOptions = {},
): Promise<void> {
  if (isRootTargetPath(targetPath) || isFirstRunTargetPath(targetPath)) return;
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
  await expect(page.getByTestId("first-run-shell")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
  if (!options.allowOnboardingToast) {
    // Runtime/provider setup is owned by in-chat first-run choices. The removed
    // standalone chooser must never intercept normal route loads.
    await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0, {
      timeout: STARTUP_SETTLED_TIMEOUT_MS,
    });
  }
}

async function replayNavigationAfterStartup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const isAppWindowRoute = new URLSearchParams(window.location.search).get(
      "appWindow",
    );
    if (window.location.protocol === "file:" || isAppWindowRoute === "1") {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      return;
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

export async function openAppPath(
  page: Page,
  targetPath: string,
  options: OpenAppPathOptions = {},
): Promise<void> {
  await installRenderTelemetryGuard(page);
  await page.goto(targetPath, { waitUntil: "domcontentloaded" });
  await expectRootReady(page);
  await expectStartupSettled(page);
  await expectNoFirstRunRedirect(page);
  await expectMainShellReadyForRoute(page, targetPath, options);
  await replayNavigationAfterStartup(page);
  await expectStartupSettled(page);
  await expectMainShellReadyForRoute(page, targetPath, options);
  await expectNoRenderTelemetryErrors(page, targetPath);
}

export async function readLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

export async function openSettingsSection(
  page: Page,
  sectionName: string | RegExp,
): Promise<void> {
  const settingsShell = page.getByTestId("settings-shell");
  if (!(await locatorVisible(settingsShell, 2_000))) {
    await replayNavigationAfterStartup(page);
  }
  if (!(await locatorVisible(settingsShell, 2_000))) {
    await openAppPath(page, "/settings");
  }
  await expect(settingsShell).toBeVisible({ timeout: READY_CHECK_TIMEOUT_MS });

  const hubSectionButton = settingsShell
    .getByRole("button", { name: sectionName })
    .filter({ visible: true })
    .first();
  if (await locatorVisible(hubSectionButton, 1_000)) {
    await hubSectionButton.click();
    return;
  }

  const sectionBackButton = settingsShell
    .getByRole("button", { name: /^Back to Settings$/ })
    .filter({ visible: true })
    .first();
  if (await locatorVisible(sectionBackButton, 1_000)) {
    await sectionBackButton.click();
    const nextHubSectionButton = settingsShell
      .getByRole("button", { name: sectionName })
      .filter({ visible: true })
      .first();
    if (await locatorVisible(nextHubSectionButton, READY_CHECK_TIMEOUT_MS)) {
      await nextHubSectionButton.click();
      return;
    }
  }

  const settingsNav = page.getByRole("navigation", {
    name: /^Settings(?: sections)?$/,
  });
  const sectionButton = settingsNav
    .getByRole("button", { name: sectionName })
    .filter({ visible: true });
  if (await locatorVisible(sectionButton, 1_000)) {
    await sectionButton.click();
    return;
  }

  const sectionId = settingsSectionIdFromLabel(sectionName);
  if (sectionId) {
    await page.evaluate((id) => {
      const nextUrl = new URL(window.location.href);
      nextUrl.hash = id;
      window.history.replaceState(null, "", nextUrl);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }, sectionId);
    await expect(settingsShell.locator(`[id="${sectionId}"]`)).toBeVisible({
      timeout: READY_CHECK_TIMEOUT_MS,
    });
    return;
  }

  const sectionHeading = settingsShell.getByText(sectionName).filter({
    visible: true,
  });
  await sectionHeading
    .first()
    .scrollIntoViewIfNeeded({ timeout: READY_CHECK_TIMEOUT_MS });
  await expect(sectionHeading.first()).toBeVisible({
    timeout: READY_CHECK_TIMEOUT_MS,
  });
}

function settingsSectionIdFromLabel(
  sectionName: string | RegExp,
): string | null {
  if (typeof sectionName === "string") {
    return SETTINGS_SECTION_IDS_BY_LABEL.get(sectionName) ?? null;
  }
  for (const [label, id] of SETTINGS_SECTION_IDS_BY_LABEL.entries()) {
    if (sectionName.test(label)) return id;
  }
  return null;
}

async function locatorVisible(
  locator: Locator,
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function formatReadyCheck(check: ReadyCheck): string {
  if ("selector" in check) {
    return `selector=${check.selector}`;
  }
  return `text=${JSON.stringify(check.text)}`;
}

function readyChecksPassed(
  results: EvaluatedReadyCheck[],
  mode: "any" | "all",
): boolean {
  if (mode === "all") {
    return results.every((result) => result.passed);
  }
  return results.some((result) => result.passed);
}

async function evaluateReadyChecks(
  page: Page,
  checks: readonly ReadyCheck[],
  mode: "any" | "all" = "any",
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<{
  passed: boolean;
  results: EvaluatedReadyCheck[];
}> {
  const results: EvaluatedReadyCheck[] = [];

  for (const check of checks) {
    if ("selector" in check) {
      const result = {
        check,
        passed: await locatorVisible(page.locator(check.selector), timeoutMs),
      };
      results.push(result);
      if (mode === "any" && result.passed) {
        return {
          passed: true,
          results,
        };
      }
      continue;
    }
    const result = {
      check,
      passed: await locatorVisible(page.getByText(check.text), timeoutMs),
    };
    results.push(result);
    if (mode === "any" && result.passed) {
      return {
        passed: true,
        results,
      };
    }
  }

  return {
    passed: readyChecksPassed(results, mode),
    results,
  };
}

export async function assertReadyChecks(
  page: Page,
  label: string,
  checks: readonly ReadyCheck[],
  mode: "any" | "all" = "any",
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<void> {
  let evaluation = await evaluateReadyChecks(page, checks, mode, timeoutMs);
  if (!evaluation.passed) {
    await replayNavigationAfterStartup(page);
    evaluation = await evaluateReadyChecks(page, checks, mode, timeoutMs);
  }
  const summary = evaluation.results
    .map(
      (result) =>
        `${result.passed ? "pass" : "fail"}:${formatReadyCheck(result.check)}`,
    )
    .join(", ");

  expect(
    evaluation.passed,
    `[playwright-ui-smoke] ${label}: ready checks failed (${summary})`,
  ).toBe(true);
}

function emptyWalletMarketSource(providerId: "coingecko" | "polymarket") {
  return {
    providerId,
    providerName: providerId === "coingecko" ? "CoinGecko" : "Polymarket",
    providerUrl:
      providerId === "coingecko"
        ? "https://www.coingecko.com"
        : "https://polymarket.com",
    available: false,
    stale: false,
    error: null,
  };
}

function smokeWalletMarketOverview() {
  const availableSource = (providerId: "coingecko" | "polymarket") => ({
    ...emptyWalletMarketSource(providerId),
    available: true,
  });
  return {
    generatedAt: SMOKE_GENERATED_AT,
    cacheTtlSeconds: 60,
    stale: false,
    sources: {
      prices: availableSource("coingecko"),
      movers: availableSource("coingecko"),
      predictions: availableSource("polymarket"),
    },
    prices: [],
    movers: [
      {
        id: "solana",
        symbol: "SOL",
        name: "Solana",
        priceUsd: 150,
        change24hPct: 7.5,
        marketCapRank: 5,
        imageUrl: null,
      },
      {
        id: "ethereum",
        symbol: "ETH",
        name: "Ethereum",
        priceUsd: 3600,
        change24hPct: -1.8,
        marketCapRank: 2,
        imageUrl: null,
      },
    ],
    predictions: [],
  };
}

function emptyWalletTradingProfile(url: URL) {
  return {
    window: url.searchParams.get("window") ?? "30d",
    source: url.searchParams.get("source") ?? "all",
    generatedAt: SMOKE_GENERATED_AT,
    summary: {
      totalSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      settledCount: 0,
      successCount: 0,
      revertedCount: 0,
      tradeWinRate: null,
      txSuccessRate: null,
      winningTrades: 0,
      evaluatedTrades: 0,
      realizedPnlBnb: "0",
      volumeBnb: "0",
    },
    pnlSeries: [],
    tokenBreakdown: [],
    recentSwaps: [],
  };
}

function smokeWalletBalances() {
  return {
    evm: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "0.25",
          nativeSymbol: "ETH",
          nativeValueUsd: "900.00",
          tokens: [
            {
              contractAddress: null,
              symbol: "USDC",
              name: "USD Coin",
              balance: "125.50",
              decimals: 6,
              valueUsd: "125.50",
              logoUrl: "",
            },
          ],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "3.5",
      solValueUsd: "525.00",
      tokens: [],
    },
  };
}

function smokeWalletConfig() {
  return {
    configured: true,
    evmConfigured: true,
    solanaConfigured: true,
    evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
    solanaAddress: "So11111111111111111111111111111111111111112",
    evmBalanceReady: true,
    solanaBalanceReady: true,
    walletNetwork: "mainnet",
    selectedRpcProviders: {
      evm: "publicnode",
      bsc: "publicnode",
      solana: "publicnode",
    },
    wallets: [
      {
        chain: "evm",
        source: "local",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        label: "Smoke EVM",
      },
      {
        chain: "solana",
        source: "local",
        address: "So11111111111111111111111111111111111111112",
        label: "Smoke Solana",
      },
    ],
    primary: {
      evm: "local",
      solana: "local",
    },
    warnings: [],
  };
}

function smokeWalletNfts() {
  return {
    evm: [
      {
        chain: "ethereum",
        contractAddress: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        collectionName: "Eliza Smoke Collection",
        nfts: [
          {
            tokenId: "42",
            name: "Smoke Test NFT #42",
            collectionName: "Eliza Smoke Collection",
            imageUrl: "",
            tokenUri: "",
          },
          {
            tokenId: "43",
            name: "ETH / USDC Position",
            collectionName: "Uniswap V3 Liquidity Pool",
            imageUrl: "",
            tokenUri: "",
          },
        ],
      },
    ],
    solana: {
      nfts: [
        {
          mint: "Smoke111111111111111111111111111111111111111",
          name: "Smoke Solana Collectible",
          collectionName: "Eliza Smoke Collection",
          imageUrl: "",
          tokenUri: "",
        },
      ],
    },
  };
}

const EMPTY_LIFEOPS_OVERVIEW_SUMMARY = {
  activeOccurrenceCount: 0,
  overdueOccurrenceCount: 0,
  snoozedOccurrenceCount: 0,
  activeReminderCount: 0,
  activeGoalCount: 0,
};

// Valid populated DTOs for the three /api/lifeops/sleep/* endpoints so the
// decomposed HealthView lands on its `health-populated` branch (latest night,
// regularity, baseline) instead of the empty/connect-a-source branch. Shapes
// mirror LifeOpsSleepHistoryResponse / LifeOpsSleepRegularityResponse /
// LifeOpsPersonalBaselineResponse from @elizaos/plugin-health.
function populatedSleepHistory(windowDays: number) {
  return {
    episodes: [
      {
        id: "smoke-sleep-1",
        startedAt: "2026-01-01T23:30:00.000Z",
        endedAt: "2026-01-02T07:15:00.000Z",
        durationMin: 465,
        cycleType: "overnight",
        source: "health",
        confidence: 0.92,
      },
    ],
    summary: {
      cycleCount: 6,
      averageDurationMin: 452,
      overnightCount: 6,
      napCount: 0,
      openCount: 0,
    },
    windowDays,
    includeNaps: true,
  };
}

function populatedSleepRegularity(windowDays: number) {
  return {
    sri: 78.4,
    classification: "regular",
    bedtimeStddevMin: 42,
    wakeStddevMin: 31,
    midSleepStddevMin: 36,
    sampleSize: 6,
    windowDays,
  };
}

function populatedSleepBaseline(windowDays: number) {
  return {
    medianBedtimeLocalHour: 23.5,
    medianWakeLocalHour: 7.25,
    medianSleepDurationMin: 452,
    bedtimeStddevMin: 42,
    wakeStddevMin: 31,
    sampleSize: 6,
    windowDays,
  };
}

function sleepWindowDaysFromUrl(rawUrl: string): number {
  const parsed = Number(new URL(rawUrl).searchParams.get("windowDays"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

// Valid populated DTOs for the /api/lifeops/money/* endpoints the decomposed
// FinancesView fetches, so `finances:gui` renders its `finances-populated`
// branch (a connected source + balance + transactions + recurring) instead of
// the connect-a-source empty state.
function populatedMoneyDashboard() {
  return {
    spending: {
      windowDays: 30,
      fromDate: "2026-05-18",
      toDate: "2026-06-17",
      totalSpendUsd: 1234.5,
      totalIncomeUsd: 4000,
      netUsd: 2765.5,
      transactionCount: 12,
    },
    generatedAt: "2026-06-17T12:00:00.000Z",
  };
}
function populatedMoneySources() {
  return {
    sources: [
      {
        id: "src-1",
        kind: "plaid",
        label: "Checking",
        institution: "Acme Bank",
        status: "active",
      },
    ],
  };
}
function populatedMoneyTransactions() {
  return {
    transactions: [
      {
        id: "tx-1",
        postedAt: "2026-06-16T09:00:00.000Z",
        amountUsd: 42.5,
        direction: "debit",
        merchantDisplay: "Coffee Bar",
        merchantNormalized: "coffee-bar",
        merchantRaw: "COFFEE BAR #12",
        description: "Latte",
        category: "dining",
        currency: "USD",
      },
    ],
  };
}
function populatedMoneyRecurring() {
  return {
    charges: [
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        cadence: "monthly",
        averageAmountUsd: 15.99,
        nextExpectedAt: "2026-07-01T00:00:00.000Z",
        category: "entertainment",
      },
    ],
  };
}

// Valid populated LifeOpsInbox for the /api/lifeops/inbox endpoint the decomposed
// InboxView fetches, so `inbox:gui` renders its `inbox-populated` branch (channel
// groups + triage rows) instead of the connect-a-channel / inbox-zero empty
// state. Shape mirrors LifeOpsInbox / LifeOpsInboxMessage from @elizaos/shared:
// a flat `messages` list, per-channel `channelCounts`, and `fetchedAt`. When the
// request carries a `channels` filter, the messages are narrowed to match so the
// view's server-side channel-filter interaction renders consistently.
function populatedInbox(url: URL) {
  const requested = (url.searchParams.get("channels") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allMessages = [
    {
      id: "gmail:smoke-1",
      channel: "gmail",
      sender: {
        id: "sender-acme",
        displayName: "Acme Billing",
        email: "billing@acme.test",
        avatarUrl: null,
      },
      subject: "Invoice #42 overdue",
      snippet: "Please remit payment for last month's services.",
      receivedAt: "2026-06-16T10:00:00.000Z",
      unread: true,
      deepLink: null,
      sourceRef: { channel: "gmail", externalId: "gmail:smoke-1" },
      threadId: "thread-gmail-1",
    },
    {
      id: "discord:smoke-7",
      channel: "discord",
      sender: {
        id: "sender-guild",
        displayName: "guildmate",
        email: null,
        avatarUrl: null,
      },
      subject: null,
      snippet: "gm everyone — standup in 10",
      receivedAt: "2026-06-16T09:30:00.000Z",
      unread: false,
      deepLink: null,
      sourceRef: { channel: "discord", externalId: "discord:smoke-7" },
      threadId: "thread-discord-7",
    },
  ];
  const messages =
    requested.length > 0
      ? allMessages.filter((message) => requested.includes(message.channel))
      : allMessages;
  return {
    messages,
    channelCounts: {
      gmail: { total: 1, unread: 1 },
      discord: { total: 1, unread: 0 },
      telegram: { total: 0, unread: 0 },
      signal: { total: 0, unread: 0 },
      imessage: { total: 0, unread: 0 },
      whatsapp: { total: 0, unread: 0 },
      sms: { total: 0, unread: 0 },
      x_dm: { total: 0, unread: 0 },
    },
    fetchedAt: SMOKE_GENERATED_AT,
    sources: [
      { source: "chat", state: "ok", degradations: [] },
      { source: "gmail", state: "ok", degradations: [] },
    ],
  };
}

// Valid populated goals payload for the /api/lifeops/goals endpoint the
// decomposed GoalsView fetches, so `goals:gui` renders its `goals-populated`
// branch (status groups + goal rows) instead of the set-a-goal empty state.
// Shape mirrors the PA route response { goals: LifeOpsGoalRecord[] } where each
// record is { goal: LifeOpsGoalDefinition; links: LifeOpsGoalLink[] } from
// @elizaos/shared.
function populatedGoals() {
  return {
    goals: [
      {
        goal: {
          id: "goal-smoke-1",
          agentId: "ui-smoke-agent",
          domain: "personal",
          subjectType: "owner",
          subjectId: "owner-smoke",
          visibilityScope: "private",
          contextPolicy: "owner_only",
          title: "Run a half marathon",
          description: "Build up to 21km by autumn.",
          cadence: { kind: "weekly" },
          successCriteria: { targetText: "21km continuous run" },
          status: "active",
          reviewState: "on_track",
          metadata: {},
          createdAt: SMOKE_GENERATED_AT,
          updatedAt: SMOKE_GENERATED_AT,
        },
        links: [
          {
            id: "link-smoke-1",
            agentId: "ui-smoke-agent",
            goalId: "goal-smoke-1",
            linkedType: "occurrence",
            linkedId: "occ-smoke-1",
            createdAt: SMOKE_GENERATED_AT,
          },
        ],
      },
      {
        goal: {
          id: "goal-smoke-2",
          agentId: "ui-smoke-agent",
          domain: "personal",
          subjectType: "owner",
          subjectId: "owner-smoke",
          visibilityScope: "private",
          contextPolicy: "owner_only",
          title: "Learn conversational Spanish",
          description: "",
          cadence: { kind: "daily" },
          successCriteria: {},
          status: "paused",
          reviewState: "needs_attention",
          metadata: {},
          createdAt: SMOKE_GENERATED_AT,
          updatedAt: SMOKE_GENERATED_AT,
        },
        links: [],
      },
    ],
  };
}

// Valid populated payloads for the /api/lifeops/entities + /api/lifeops/relationships
// endpoints the RelationshipsView fetches, so `relationships:gui` renders its
// `relationships-populated` branch (entity cards + their outbound edges) instead
// of the no-people empty state. Shapes mirror the PA route responses
// { entities: Entity[] } / { relationships: Relationship[] } from
// plugin-personal-assistant/src/lifeops/{entities,relationships}/types.ts.
function populatedEntities() {
  return {
    entities: [
      {
        entityId: "self",
        type: "person",
        preferredName: "Owner",
        fullName: "Owner",
        identities: [],
        attributes: {},
        state: {},
        tags: [],
        visibility: "owner_agent_admin",
        createdAt: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
      {
        entityId: "ent-pat",
        type: "person",
        preferredName: "Pat Doe",
        fullName: "Pat Doe",
        identities: [
          {
            platform: "discord",
            handle: "pat#1",
            displayName: "Pat",
            verified: true,
            confidence: 0.95,
            addedAt: SMOKE_GENERATED_AT,
            addedVia: "user_chat",
            evidence: [],
          },
        ],
        attributes: {},
        state: { lastObservedAt: "2026-06-10T00:00:00.000Z" },
        tags: [],
        visibility: "owner_agent_admin",
        createdAt: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
      {
        entityId: "ent-acme",
        type: "organization",
        preferredName: "Acme Corp",
        fullName: "Acme Corporation",
        identities: [],
        attributes: {},
        state: {},
        tags: [],
        visibility: "owner_agent_admin",
        createdAt: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
    ],
  };
}
function populatedRelationships() {
  return {
    relationships: [
      {
        relationshipId: "rel-pat",
        fromEntityId: "self",
        toEntityId: "ent-pat",
        type: "colleague_of",
        metadata: { cadenceDays: 14 },
        state: { lastInteractionAt: "2026-06-10T00:00:00.000Z" },
        evidence: [],
        confidence: 0.9,
        source: "user_chat",
        status: "active",
        createdAt: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
      {
        relationshipId: "rel-acme",
        fromEntityId: "ent-pat",
        toEntityId: "ent-acme",
        type: "works_at",
        metadata: { role: "engineer" },
        state: {},
        evidence: [],
        confidence: 0.8,
        source: "extraction",
        status: "active",
        createdAt: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
    ],
  };
}

// Valid populated payload for the /api/lifeops/todos endpoint the decomposed
// TodosView fetches, so `todos:gui` renders its `todos-populated` branch (the
// Today / Upcoming / Someday lanes) instead of the add-a-todo empty state.
// Shape mirrors the PA route response { todos: TodoWire[] } — a flat list of
// { id, title, status, dueDate } projected from the owner's life_task_*
// occurrences. One due-now (Today), one future (Upcoming), one no-due (Someday).
function populatedTodos() {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return {
    todos: [
      {
        id: "todo-smoke-1",
        title: "Submit the quarterly report",
        status: "pending",
        dueDate: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      {
        id: "todo-smoke-2",
        title: "Plan the offsite",
        status: "in_progress",
        dueDate: new Date(now + 5 * day).toISOString(),
      },
      {
        id: "todo-smoke-3",
        title: "Read the new design doc",
        status: "pending",
        dueDate: null,
      },
    ],
  };
}

// Valid populated DTOs for the /api/documents* endpoints the decomposed
// KnowledgeDocumentsView fetches, so `documents:gui` renders its `documents-populated`
// branch (a document row + stats line) instead of the empty/upload-prompt
// state. Shapes mirror the PresentedDocument + stats responses from
// plugin-documents/src/routes.ts.
function populatedDocumentsList() {
  return {
    ok: true,
    available: true,
    agentId: "ui-smoke-agent",
    documents: [
      {
        id: "doc-smoke-1",
        filename: "Quarterly Plan.md",
        contentType: "text/markdown",
        fileSize: 4096,
        createdAt: Date.parse(SMOKE_GENERATED_AT),
        fragmentCount: 7,
        source: "upload",
        scope: "global",
        provenance: { kind: "upload", label: "Manual upload" },
        canEditText: true,
        canDelete: true,
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
  };
}
function populatedDocumentsStats() {
  return { documentCount: 1, fragmentCount: 7, agentId: "ui-smoke-agent" };
}
function populatedDocumentsSearch(url: URL) {
  const query = (url.searchParams.get("q") ?? "").trim();
  return {
    query,
    threshold: 0.3,
    results: query
      ? [
          {
            id: "frag-smoke-1",
            text: "Deterministic search fragment for UI smoke.",
            similarity: 0.81,
            documentId: "doc-smoke-1",
            documentTitle: "Quarterly Plan.md",
            position: 0,
          },
        ]
      : [],
    count: query ? 1 : 0,
  };
}

// Valid empty-state SelfControlStatus (engine available, no active block) so the
// decomposed FocusView lands on its `focus-empty` branch ("No active focus
// session.") instead of the unavailable/disconnected branch.
function emptySelfControlStatus() {
  return {
    available: true,
    active: false,
    hostsFilePath: "/etc/hosts",
    startedAt: null,
    endsAt: null,
    websites: [],
    blockedWebsites: [],
    allowedWebsites: [],
    requestedWebsites: [],
    matchMode: "exact",
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "hosts-file",
    platform: "linux",
    supportsElevationPrompt: true,
    elevationPromptMethod: "pkexec",
  };
}

function emptyLifeOpsOverview() {
  const section = {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
  };
  return {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
    owner: section,
    agentOps: section,
    schedule: null,
  };
}

function emptyLifeOpsSocialSummary(url: URL) {
  return {
    since: url.searchParams.get("since") ?? SMOKE_GENERATED_AT,
    until: url.searchParams.get("until") ?? SMOKE_GENERATED_AT,
    totalSeconds: 0,
    services: [],
    devices: [],
    surfaces: [],
    browsers: [],
    sessions: [],
    messages: {
      channels: [],
      inbound: 0,
      outbound: 0,
      opened: 0,
      replied: 0,
    },
    dataSources: [],
    fetchedAt: SMOKE_GENERATED_AT,
  };
}

function emptyStewardStatus() {
  return {
    configured: true,
    available: true,
    connected: true,
    error: null,
    baseUrl: "https://steward.smoke.test",
    agentId: "ui-smoke-agent",
    agentName: "UI Smoke Agent",
    walletAddresses: {
      evm: "0x1234567890abcdef1234567890abcdef12345678",
      solana: "So11111111111111111111111111111111111111112",
    },
    evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
    solanaAddress: "So11111111111111111111111111111111111111112",
    vaultHealth: "ok",
  };
}

function smokeStewardTxRecord(
  id: string,
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "signed"
    | "broadcast"
    | "confirmed"
    | "failed",
  overrides: {
    chainId?: number;
    createdAt?: string;
    to?: string;
    txHash?: string;
    value?: string;
  } = {},
) {
  return {
    id,
    agentId: "ui-smoke-agent",
    status,
    request: {
      agentId: "ui-smoke-agent",
      tenantId: "ui-smoke-tenant",
      to:
        overrides.to ??
        (id.endsWith("two")
          ? "0xfeed00000000000000000000000000000000beef"
          : "0xc0ffee00000000000000000000000000000000cafe"),
      value: overrides.value ?? "10000000000000000",
      data: "0x",
      chainId: overrides.chainId ?? 8453,
    },
    txHash: overrides.txHash,
    policyResults:
      status === "pending"
        ? [
            {
              policy: "manual-approval",
              status: "pending",
              reason: "Manual approval required for UI smoke.",
            },
          ]
        : [],
    createdAt: overrides.createdAt ?? SMOKE_GENERATED_AT,
    signedAt:
      status === "signed" || status === "broadcast" || status === "confirmed"
        ? "2026-01-01T00:01:00.000Z"
        : undefined,
    confirmedAt:
      status === "confirmed" ? "2026-01-01T00:02:00.000Z" : undefined,
  };
}

function smokeStewardPendingApprovals() {
  return [
    {
      queueId: "queue-smoke-one",
      status: "pending",
      requestedAt: SMOKE_GENERATED_AT,
      transaction: smokeStewardTxRecord("tx-smoke-one", "pending"),
    },
    {
      queueId: "queue-smoke-two",
      status: "pending",
      requestedAt: "2026-01-01T00:03:00.000Z",
      transaction: smokeStewardTxRecord("tx-smoke-two", "pending", {
        chainId: 56,
        createdAt: "2026-01-01T00:03:00.000Z",
        value: "25000000000000000",
      }),
    },
  ];
}

function smokeStewardHistoryRecords() {
  return [
    smokeStewardTxRecord("tx-smoke-confirmed", "confirmed", {
      createdAt: "2026-01-01T00:05:00.000Z",
      txHash:
        "0xabc1230000000000000000000000000000000000000000000000000000000000",
    }),
    smokeStewardTxRecord("tx-smoke-history-pending", "pending", {
      chainId: 56,
      createdAt: "2026-01-01T00:04:00.000Z",
      to: "0xfeed00000000000000000000000000000000beef",
    }),
  ];
}

const smokeVectorRows = [
  {
    id: "memory-smoke-1",
    content: "Deterministic memory fixture for UI smoke vector search.",
    room_id: "room-smoke-vector",
    entity_id: "entity-smoke-vector",
    type: "message",
    created_at: SMOKE_GENERATED_AT,
    unique: true,
    dim_384: "[0.1,0.2,0.3]",
  },
];

function smokeDatabaseQuery(sql: string) {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.includes("information_schema.columns")) {
    return {
      rows: [
        { column_name: "id", data_type: "text" },
        { column_name: "content", data_type: "text" },
        { column_name: "room_id", data_type: "text" },
        { column_name: "entity_id", data_type: "text" },
        { column_name: "type", data_type: "text" },
        { column_name: "created_at", data_type: "timestamp" },
        { column_name: "unique", data_type: "boolean" },
        { column_name: "dim_384", data_type: "text" },
      ],
      rowCount: 8,
    };
  }
  if (normalized.includes("count(*)")) {
    return {
      rows: [
        { cnt: normalized.includes('"unique"') ? 1 : smokeVectorRows.length },
      ],
      rowCount: 1,
    };
  }
  if (normalized.includes('from "memories"')) {
    return {
      rows: smokeVectorRows,
      rowCount: smokeVectorRows.length,
    };
  }
  return { rows: [], rowCount: 0 };
}

/** Installs baseline API routes for smoke tests before flow-specific overrides. */
export async function installDefaultAppRoutes(page: Page): Promise<void> {
  // The UI-smoke server serves a production renderer from a same-origin
  // backend proxy. Model the host's pre-React API-base injection so the bundle
  // does not mistake that local stack for the hosted Cloud-only surface before
  // any route fixture has a chance to answer. Keep this at document start: the
  // app resolves branding while its entry module is evaluating.
  await page.addInitScript(() => {
    const host = window as typeof window & {
      __ELIZA_APP_API_BASE__?: string;
    };
    host.__ELIZA_APP_API_BASE__ = window.location.origin;
  });

  let notesRevision = 4;
  let smokeNotes: SmokeNote[] = [
    {
      id: "note-launch",
      title: "Launch checklist",
      body: "Cloud agent, phone, and deck are ready.",
      color: "yellow",
      createdAt: SMOKE_GENERATED_AT,
      updatedAt: SMOKE_GENERATED_AT,
    },
    {
      id: "note-follow-up",
      title: "Follow up",
      body: "Share the demo recording with the team.",
      color: "green",
      createdAt: SMOKE_GENERATED_AT,
      updatedAt: SMOKE_GENERATED_AT,
    },
  ];
  const notesSnapshot = () => ({
    revision: notesRevision,
    notes: smokeNotes,
  });

  // Answer with a stamp that carries NO commit/label/builtAt, so the BuildBadge
  // (#14174) — whose toLabel() needs one of those to produce a label — renders
  // nothing. A 200 keeps the browser from logging a build-info.json 404 (which
  // plugin-views-visual's console-error guard would flag), while the badge stays
  // hidden: it is a tap-for-diagnostics DEV instrument, not a view control, and
  // serving a commit made its interactive pill render over the shell where the
  // generic "exercise every control" pass clicks it and gets trapped behind its
  // full-viewport diagnostics scrim.
  await page.route("**/build-info.json", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: SMOKE_GENERATED_AT,
        branch: "ui-smoke",
      }),
    });
  });

  await page.route(/\/(?:brand|app-heroes)\//, async (route) => {
    if (await fulfillPublicAsset(route)) return;
    await route.fallback();
  });

  // VRM assets (vrms/<slug>.vrm.gz + vrms/previews|backgrounds/<slug>.png) —
  // the preview server doesn't carry the runtime boot-config's vrmAssets, so
  // resolveAppAssetUrl(`vrms/...`) 404s. Serve a real bundled VRM (so the
  // companion canvas renders a model) and a 1×1 PNG for the preview/background
  // thumbnails (the canvas falls back if those are absent, but a 404 still
  // shows as a console error). Match `**/vrms/**` to catch any sub-path.
  await page.route("**/vrms/**", async (route) => {
    const url = route.request().url();
    if (/\.vrm(\.gz)?(\?|$)/i.test(url)) {
      const body = bundledVrmGz();
      if (!body) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      return;
    }
    if (/\.png(\?|$)/i.test(url)) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "image/png" },
        body: ONE_PX_PNG,
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "https://raw.githubusercontent.com/trustwallet/**",
    async (route) => {
      if (/\.(?:png|jpe?g|webp|gif|svg)(?:\?|$)/i.test(route.request().url())) {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: ONE_PX_PNG,
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(/^https:\/\/ipapi\.co\/json\/?(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        latitude: 37.7749,
        longitude: -122.4194,
        city: "San Francisco",
      }),
    });
  });

  await page.route("https://api.open-meteo.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        current: {
          temperature_2m: 68,
          weather_code: 2,
        },
      }),
    });
  });

  // Weather IP-fallback coordinates (useWeather → GET /api/location/approximate,
  // #15183): fires on every home load when geolocation permission is absent —
  // always, in this harness. The zero-key smoke stack returns 501, which the
  // diagnostics guard flags. Serve the same San Francisco fixture coords as the
  // ipapi stub above so the widget proceeds into the stubbed Open-Meteo reading.
  await page.route("**/api/location/approximate", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        lat: 37.7749,
        lon: -122.4194,
        accuracyMeters: 5000,
        source: "fixture",
      }),
    });
  });

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
        startedAt: Date.parse(SMOKE_GENERATED_AT),
        uptime: 60_000,
      }),
    });
  });

  await page.route("**/api/local-inference/device/stream**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    });
  });

  // BrowserWorkspaceView reads the persisted Agent Browser session list on
  // mount. A fresh smoke fixture has no sessions; model that designed-empty
  // state explicitly so the all-views audit reviews the browser view rather
  // than an unrelated unimplemented-route error card.
  await page.route("**/api/browser-bridge/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.route("**/api/notes/state", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: notesSnapshot(),
      }),
    });
  });

  await page.route(/\/api\/views\/notes\/interact$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const payload: unknown = route.request().postDataJSON();
    if (!isSmokeRecord(payload) || typeof payload.capability !== "string") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid Notes interaction." }),
      });
      return;
    }
    const params = isSmokeRecord(payload.params) ? payload.params : {};
    const now = new Date(
      Date.parse(SMOKE_GENERATED_AT) + (notesRevision + 1) * 1_000,
    ).toISOString();

    if (payload.capability === "create-note") {
      smokeNotes = [
        {
          id: `note-smoke-${notesRevision + 1}`,
          title: smokeString(params, "title", "Smoke note"),
          body: smokeString(params, "body"),
          color: smokeString(params, "color", "yellow"),
          createdAt: now,
          updatedAt: now,
        },
        ...smokeNotes,
      ];
    } else if (payload.capability === "update-note") {
      const id = smokeString(params, "id");
      smokeNotes = smokeNotes.map((note) =>
        note.id === id
          ? {
              ...note,
              title: smokeString(params, "title", note.title),
              body: smokeString(params, "body", note.body),
              color: smokeString(params, "color", note.color),
              updatedAt: now,
            }
          : note,
      );
    } else if (payload.capability === "delete-note") {
      const id = smokeString(params, "id");
      smokeNotes = smokeNotes.filter((note) => note.id !== id);
    } else if (payload.capability === "clear-notes") {
      smokeNotes = [];
    } else {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: `Unsupported Notes interaction: ${payload.capability}`,
        }),
      });
      return;
    }

    notesRevision += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: `notes-smoke-${notesRevision}`,
        success: true,
        result: {
          success: true,
          text: `Handled ${payload.capability}.`,
          state: notesSnapshot(),
        },
      }),
    });
  });

  // The Transcripts view (client.listTranscripts) hits this on mount; the
  // keyless loopback stack answers 501 for unimplemented endpoints, which surface
  // as console errors in the stricter app-window smoke. Serve an empty list so
  // the view renders its real empty state cleanly.
  await page.route("**/api/transcripts**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcripts: [] }),
    });
  });

  await page.route("**/api/runtime/mode", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "local",
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      }),
    });
  });

  // The home composer probes the effective model route before deciding whether
  // local text-model readiness applies (useHomeModelStatus). The keyless smoke
  // stack answers 501, which the diagnostics guard treats as a failure. A fresh
  // zero-key agent has no configured routing, so serve the canonical unrouted
  // shape (no `activeChat`, empty targets).
  await page.route("**/api/models/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        targets: { small: {}, large: {}, coding: {} },
      }),
    });
  });

  // Slash-command catalog (chat composer) + custom-actions list — both are
  // shell-level GETs on the chat/home surface. The booted zero-key smoke stack
  // returns 501 (Not Implemented) for them, which the diagnostics guard treats
  // as a failure. A fresh agent genuinely exposes only the built-in command set
  // and no custom actions, so empty defaults match real zero-key behaviour.
  await page.route("**/api/commands**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const surface = new URL(route.request().url()).searchParams.get("surface");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commands: [],
        surface,
        agentId: null,
        generatedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/custom-actions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ actions: [] }),
    });
  });

  // Notifications poller — another shell-level GET on every surface. The zero-key
  // smoke stack returns 501 for it; a fresh agent simply has no notifications, so
  // an empty list matches real zero-state and keeps the diagnostics guard clean.
  // POST to the collection is the weather approximate-location notice (useWeather
  // files it once right after the IP-fallback coords resolve, #15183) — accept it
  // with the canonical created shape so the once-flag settles and the 501 stack
  // never sees it; every other method/subpath still falls through.
  await page.route("**/api/notifications**", async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "POST" && pathname === "/api/notifications") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          notification: {
            id: "smoke-notification-1",
            title: "smoke",
            category: "system",
            priority: "low",
            createdAt: Date.parse(SMOKE_GENERATED_AT),
            readAt: null,
          },
        }),
      });
      return;
    }
    if (method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [], unreadCount: 0 }),
    });
  });

  // Activity-feed widget poller — a shell-level GET on the home/chat surface that
  // sits behind every view. The zero-key smoke stack returns 501; a fresh agent
  // has no activity, so the canonical empty feed keeps the diagnostics guard clean.
  await page.route("**/api/apps/feed/agent/activity**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  // Relationship merge-candidates poller — another shell-level GET. The zero-key
  // smoke stack returns 501; a fresh agent has no candidate merges, so the empty
  // `{ data: [] }` shape matches real zero-state and keeps diagnostics clean.
  await page.route("**/api/relationships/candidates**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });

  // LifeOps scheduled-tasks poller — a shell/home-surface GET behind the lifeops
  // widget that sits under many views. The zero-key smoke stack returns 501; a
  // fresh agent has no scheduled tasks, so the canonical empty list matches real
  // zero-state and keeps the diagnostics guard clean.
  await page.route("**/api/lifeops/scheduled-tasks**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ scheduledTasks: [], tasks: [] }),
    });
  });

  // Files view poller — `GET /api/files` lists stored files (files-routes.ts);
  // the zero-key smoke stack returns 501. A fresh agent has no stored files, so
  // the canonical empty list matches real zero-state and keeps diagnostics clean.
  await page.route("**/api/files", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ files: [] }),
    });
  });

  // Avatar / background EXISTENCE probes — `hasCustomVrm` / `hasCustomBackground`
  // do a HEAD (with `allowNonOk`) and treat any non-ok as "no custom asset"
  // (falls back to the default). The zero-key smoke stack answers 501 — a 5xx
  // the per-view diagnostics collectors flag as a server error. A fresh agent
  // has no custom avatar, so answer a clean 404: the client still falls back to
  // the default, and a 4xx is the expected zero-state, not a server error.
  for (const asset of ["vrm", "background"]) {
    await page.route(`**/api/avatar/${asset}**`, async (route) => {
      const method = route.request().method();
      if (method !== "GET" && method !== "HEAD") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: `no custom ${asset}` }),
      });
    });
  }

  // Approval/needs-attention poller — shell-level GET on the home surface. The
  // zero-key smoke stack has no approval queue, so return the canonical empty
  // pending-actions shape instead of letting the fallback server emit a 501.
  await page.route("**/api/approvals**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== "GET" ||
      url.pathname !== "/api/approvals"
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approvals: [],
        pending: [],
        pendingUserActions: [],
      }),
    });
  });

  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ complete: true, cloudProvisioned: true }),
    });
  });

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        meta: { firstRunComplete: true },
        agents: {
          list: [SMOKE_AGENT],
          defaults: {
            workspace: "ui-smoke-workspace",
            adminEntityId: "owner-ui-smoke",
          },
        },
      }),
    });
  });

  await page.route("**/api/backups**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/backups" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ backups: [] }),
      });
      return;
    }
    if (url.pathname === "/api/backups" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          backup: {
            fileName: "ui-smoke.agent-backup.json",
            path: "ui-smoke.agent-backup.json",
            createdAt: SMOKE_GENERATED_AT,
            agentId: SMOKE_AGENT.id,
            stateSha256: "ui-smoke-state",
            sizeBytes: 0,
          },
        }),
      });
      return;
    }
    if (
      url.pathname === "/api/backups/restore" &&
      request.method() === "POST"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ restored: true, requiresRestart: true }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/asr/local-inference/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: false }),
    });
  });

  await page.route("**/api/database/tables", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tables: [
          { name: "memories", rowCount: smokeVectorRows.length },
          { name: "embeddings", rowCount: smokeVectorRows.length },
        ],
      }),
    });
  });

  await page.route("**/api/database/query", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { sql?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeDatabaseQuery(body.sql ?? "")),
    });
  });

  await page.route("**/api/wallet/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletConfig()),
    });
  });

  await page.route("**/api/wallet/addresses", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
        solanaAddress: "So11111111111111111111111111111111111111112",
      }),
    });
  });

  await page.route("**/api/wallet/balances", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletBalances()),
    });
  });

  await page.route("**/api/wallet/nfts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletNfts()),
    });
  });

  const orchestratorUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "unavailable",
    byProvider: [],
  };
  // The orchestrator view mounts its account-pool widgets alongside task
  // status. Healthy empty payloads keep the deterministic harness faithful to
  // the real contracts instead of falling through to the stub server's 501.
  await page.route(/\/api\/accounts(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [] }),
    });
  });

  await page.route("**/api/orchestrator/accounts**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const { pathname } = new URL(route.request().url());
    const body = pathname.endsWith("/readiness")
      ? {
          ready: false,
          rotation: false,
          required: 1,
          providers: [],
          problems: ["No coding accounts are connected."],
        }
      : { strategy: "least-used", availability: {}, assignments: [] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route("**/api/orchestrator/rooms", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rooms: [] }),
    });
  });

  await page.route("**/api/orchestrator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        taskCount: 0,
        activeTaskCount: 0,
        pausedTaskCount: 0,
        blockedTaskCount: 0,
        validatingTaskCount: 0,
        sessionCount: 0,
        activeSessionCount: 0,
        usage: orchestratorUsage,
        byStatus: {
          open: 0,
          active: 0,
          waiting_on_user: 0,
          blocked: 0,
          validating: 0,
          done: 0,
          failed: 0,
          archived: 0,
          interrupted: 0,
        },
      }),
    });
  });

  await page.route("**/api/orchestrator/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/orchestrator/tasks"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/events")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/timeline")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/usage")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(orchestratorUsage),
      });
      return;
    }
    await route.fallback();
  });

  // Orchestrator task-progress rail (orchestrator-task-widget) — polls a compact
  // snapshot (`GET /api/orchestrator/widgets`) and subscribes to its SSE stream
  // (`/widgets/stream`) wherever it mounts. The Node-only agent-orchestrator
  // plugin is absent from the keyless smoke stack, so these routes answer 501
  // exactly like /orchestrator/status and /tasks above; a fresh agent has no
  // orchestrator tasks, so the canonical empty snapshot matches real zero-state
  // and keeps the diagnostics guard clean.
  const emptyOrchestratorWidgetSnapshot = {
    version: "orchestrator.widgets.v1",
    generatedAt: SMOKE_GENERATED_AT,
    totalTaskCount: 0,
    tasks: [],
  };
  await page.route("**/api/orchestrator/widgets**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/orchestrator/widgets/stream") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache, no-transform" },
        body: `event: snapshot\ndata: ${JSON.stringify(
          emptyOrchestratorWidgetSnapshot,
        )}\n\n`,
      });
      return;
    }
    if (pathname === "/api/orchestrator/widgets") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyOrchestratorWidgetSnapshot),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        required: false,
        authenticated: true,
        loginRequired: false,
        localAccess: true,
        passwordConfigured: true,
        pairingEnabled: false,
        expiresAt: null,
      }),
    });
  });

  await page.route("**/api/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        identity: {
          id: "playwright-smoke-owner",
          displayName: "Playwright Smoke",
          kind: "owner",
        },
        session: {
          id: "playwright-smoke-session",
          kind: "local",
          expiresAt: null,
        },
        access: {
          mode: "local",
          passwordConfigured: false,
          ownerConfigured: true,
        },
      }),
    });
  });

  await page.route("**/api/auth/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.route("**/api/agents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [SMOKE_AGENT] }),
    });
  });

  await page.route("**/api/connectors/google/accounts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "google",
        connectorId: "google",
        defaultAccountId: null,
        accounts: [],
      }),
    });
  });

  await page.route("**/api/lifeops/app-state", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        priorityScoring: {
          enabled: true,
          model: null,
        },
      }),
    });
  });

  await page.route(
    "**/api/lifeops/connectors/google/status**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connected: false,
          available: false,
          authUrl: null,
          lastSyncedAt: null,
        }),
      });
    },
  );

  await page.route("**/api/lifeops/connectors/x/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "x",
        side: "owner",
        mode: "local",
        defaultMode: "local",
        availableModes: ["local"],
        configured: false,
        connected: false,
        reason: "disconnected",
        preferredByAgent: false,
        cloudConnectionId: null,
        grantedCapabilities: [],
        grantedScopes: [],
        identity: null,
        hasCredentials: false,
        feedRead: false,
        feedWrite: false,
        dmRead: false,
        dmWrite: false,
        dmInbound: false,
        grant: null,
      }),
    });
  });

  await page.route("**/api/lifeops/capabilities", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: SMOKE_GENERATED_AT,
        appEnabled: true,
        relativeTime: null,
        capabilities: [],
        summary: {
          totalCount: 0,
          workingCount: 0,
          degradedCount: 0,
          blockedCount: 0,
          notConfiguredCount: 0,
        },
      }),
    });
  });

  await page.route("**/api/lifeops/overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsOverview()),
    });
  });

  await page.route("**/api/lifeops/definitions", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify({ definitions: [] }),
    });
  });

  let calendarSourceSummaries = [
    {
      provider: "google",
      side: "owner",
      grantId: "smoke-google-owner",
      connectorAccountId: "smoke-google-account",
      accountEmail: "owner@example.com",
      calendarId: "primary",
      summary: "Primary",
      description: null,
      primary: true,
      accessRole: "owner",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/Los_Angeles",
      selected: true,
      includeInFeed: true,
    },
    {
      provider: "google",
      side: "owner",
      grantId: "smoke-google-owner",
      connectorAccountId: "smoke-google-account",
      accountEmail: "owner@example.com",
      calendarId: "family",
      summary: "Family",
      description: null,
      primary: false,
      accessRole: "writer",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/Los_Angeles",
      selected: true,
      includeInFeed: false,
    },
    {
      provider: "microsoft",
      side: "owner",
      grantId: "smoke-microsoft-owner",
      connectorAccountId: "smoke-microsoft-account",
      accountEmail: "travel@example.com",
      calendarId: "travel",
      summary: "Travel",
      description: null,
      primary: false,
      accessRole: "reader",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/Los_Angeles",
      selected: true,
      includeInFeed: true,
    },
  ];

  await page.route("**/api/lifeops/calendar/calendars**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/lifeops/calendar/calendars"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ calendars: calendarSourceSummaries }),
      });
      return;
    }

    const includeMatch = url.pathname.match(
      /^\/api\/lifeops\/calendar\/calendars\/([^/]+)\/include$/,
    );
    if (request.method() === "PUT" && includeMatch) {
      const body: unknown = request.postDataJSON();
      if (
        typeof body !== "object" ||
        body === null ||
        !("calendarId" in body) ||
        !("grantId" in body) ||
        !("includeInFeed" in body) ||
        typeof body.calendarId !== "string" ||
        typeof body.grantId !== "string" ||
        typeof body.includeInFeed !== "boolean"
      ) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid calendar source request" }),
        });
        return;
      }
      const index = calendarSourceSummaries.findIndex(
        (calendar) =>
          calendar.calendarId === body.calendarId &&
          calendar.grantId === body.grantId,
      );
      if (index < 0) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Calendar source not found" }),
        });
        return;
      }
      const updated = {
        ...calendarSourceSummaries[index],
        includeInFeed: body.includeInFeed,
      };
      calendarSourceSummaries = calendarSourceSummaries.map(
        (calendar, calendarIndex) =>
          calendarIndex === index ? updated : calendar,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ calendar: updated }),
      });
      return;
    }

    await route.fallback();
  });

  await page.route("**/api/lifeops/calendar/sources**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() !== "GET" ||
      url.pathname !== "/api/lifeops/calendar/sources"
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sources: [] }),
    });
  });

  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const timeMin = url.searchParams.get("timeMin") ?? SMOKE_GENERATED_AT;
    const timeMax = url.searchParams.get("timeMax") ?? SMOKE_GENERATED_AT;
    // Anchor a couple of deterministic events inside the requested window so the
    // calendar:gui renders populated (event blocks, not just an empty grid).
    // Place the first event at 09:00 local on the window's first day; the helper
    // is reused across desktop + mobile (agenda) layouts.
    const windowStart = new Date(timeMin);
    const syncedAt = new Date().toISOString();
    const at = (dayOffset: number, hour: number) => {
      const d = new Date(windowStart);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const smokeEvent = (
      id: string,
      title: string,
      startAt: string,
      endAt: string,
    ) => ({
      id,
      externalId: id,
      agentId: "smoke-agent",
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title,
      description: "",
      location: "",
      status: "confirmed",
      startAt,
      endAt,
      isAllDay: false,
      timezone: null,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: SMOKE_GENERATED_AT,
      updatedAt: SMOKE_GENERATED_AT,
      calendarSummary: "Primary",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        calendarId: "primary",
        events: [
          smokeEvent("smoke-evt-1", "Design sync", at(0, 9), at(0, 10)),
          smokeEvent("smoke-evt-2", "Standup", at(1, 11), at(1, 12)),
        ],
        source: "cache",
        state: "complete",
        sources: [
          {
            key: {
              provider: "google",
              side: "owner",
              grantId: "smoke-google-owner",
              connectorAccountId: "smoke-google-account",
              calendarId: "primary",
            },
            summary: "Primary",
            accessRole: "owner",
            visibility: "details",
            status: "fresh",
            syncedAt,
            error: null,
          },
        ],
        timeMin,
        timeMax,
        syncedAt: null,
      }),
    });
  });

  await page.route("**/api/lifeops/inbox**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedInbox(new URL(request.url()))),
    });
  });

  await page.route("**/api/lifeops/screen-time/summary**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], totalSeconds: 0 }),
    });
  });

  await page.route("**/api/lifeops/screen-time/breakdown**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        totalSeconds: 0,
        bySource: [],
        byCategory: [],
        byDevice: [],
        byService: [],
        byBrowser: [],
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/screen-time/history**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], totalSeconds: 0 }),
    });
  });

  await page.route("**/api/lifeops/social/summary**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsSocialSummary(new URL(request.url()))),
    });
  });

  await page.route("**/api/lifeops/sleep/history**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        populatedSleepHistory(sleepWindowDaysFromUrl(route.request().url())),
      ),
    });
  });

  await page.route("**/api/lifeops/sleep/regularity**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        populatedSleepRegularity(sleepWindowDaysFromUrl(route.request().url())),
      ),
    });
  });

  await page.route("**/api/lifeops/sleep/baseline**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        populatedSleepBaseline(sleepWindowDaysFromUrl(route.request().url())),
      ),
    });
  });

  await page.route("**/api/lifeops/money/dashboard**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedMoneyDashboard()),
    });
  });
  await page.route("**/api/lifeops/money/sources**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedMoneySources()),
    });
  });
  await page.route("**/api/lifeops/money/transactions**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedMoneyTransactions()),
    });
  });
  await page.route("**/api/lifeops/money/recurring**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedMoneyRecurring()),
    });
  });

  // GoalsView fetches GET /api/lifeops/goals (no query); the bare pattern keeps
  // the POST create + /goals/:id sub-resource routes falling through to the API.
  await page.route("**/api/lifeops/goals", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedGoals()),
    });
  });

  // RelationshipsView fetches GET /api/lifeops/entities + GET /api/lifeops/relationships
  // (both bare, no query). The bare patterns keep the POST upsert + the
  // /entities/merge, /entities/resolve, /relationships/observe sub-resource
  // routes falling through to the real API.
  await page.route("**/api/lifeops/entities", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedEntities()),
    });
  });
  await page.route("**/api/lifeops/relationships", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedRelationships()),
    });
  });

  // FamilyOperationsView loads independent owner-only sections. The smoke
  // server does not install the personal-assistant services, so preserve the
  // real response envelopes while exercising the view's healthy empty state.
  await page.route(
    "**/api/lifeops/family-workflows/email-options",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: { options: { accounts: [], recipients: [] } },
      });
    },
  );
  await page.route("**/api/lifeops/family-workflows/export", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/zip",
      headers: {
        "Content-Disposition":
          'attachment; filename="family-workspace-smoke.zip"',
        "Cache-Control": "no-store",
      },
      body: createZipArchive([
        {
          name: "fixture.json",
          data: JSON.stringify({
            fixture: "family-workspace-download",
            scope:
              "Synthetic browser download; real export contents are covered by the owner integration suite.",
          }),
        },
      ]),
    });
  });
  await page.route("**/api/lifeops/agreements", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agreements: [] }),
    });
  });
  await page.route(
    /\/api\/lifeops\/calendar\/links(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ links: [] }),
      });
    },
  );
  await page.route(
    "**/api/lifeops/family-workflows/school/status",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sourceId: "smoke-school-source",
          config: null,
          lastRun: null,
        }),
      });
    },
  );
  await page.route(
    "**/api/lifeops/family-workflows/packets**",
    async (route) => {
      const method = route.request().method();
      if (method !== "GET" && method !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          method === "GET" ? { packets: [], packetStates: [] } : {},
        ),
      });
    },
  );

  // TodosView fetches GET /api/lifeops/todos; the **-suffixed pattern tolerates
  // any future query string while leaving non-GET methods on the real API.
  await page.route("**/api/lifeops/todos**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedTodos()),
    });
  });

  // The todos list above is a GET mock, but the chat today-todos card and
  // TodosView write completions/skips through the canonical occurrence routes.
  // The smoke server has no lifeops service (real requests 501), so fulfill the
  // writes against the same fixture: callers only check `response.ok`.
  await page.route("**/api/lifeops/occurrences/*/complete", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
    );
    const occurrence = populatedTodos().todos.find((todo) => todo.id === id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        occurrence: { ...(occurrence ?? { id }), status: "completed" },
      }),
    });
  });
  await page.route("**/api/lifeops/occurrences/*/skip", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
    );
    const occurrence = populatedTodos().todos.find((todo) => todo.id === id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        occurrence: { ...(occurrence ?? { id }), status: "skipped" },
      }),
    });
  });

  await page.route("**/api/documents/stats**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedDocumentsStats()),
    });
  });
  await page.route("**/api/documents/search**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        populatedDocumentsSearch(new URL(route.request().url())),
      ),
    });
  });
  // List route last so the more specific /stats and /search routes win.
  await page.route("**/api/documents**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedDocumentsList()),
    });
  });

  await page.route("**/api/lifeops/activity-signals**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        method === "POST" ? { signal: null } : { signals: [] },
      ),
    });
  });

  await page.route("**/api/lifeops/schedule/merged-state**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ occurrences: [], goals: [], reminders: [] }),
    });
  });

  await page.route("**/api/lifeops/smart-features/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: false,
        features: {},
        updatedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/browser-bridge/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          enabled: false,
          trackingMode: "off",
          pauseUntil: null,
          allowBrowserControl: false,
          siteAccessMode: "current_site_only",
          grantedOrigins: [],
          blockedOrigins: [],
        },
      }),
    });
  });

  await page.route("**/api/browser-bridge/companions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ companions: [] }),
    });
  });

  await page.route("**/api/browser-bridge/packages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    });
  });

  await page.route("**/api/website-blocker", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptySelfControlStatus()),
    });
  });

  // Coding-project registry read by the tasks/cockpit surfaces; the keyless
  // stub 501s it, which trips the issue guards on any route that mounts them.
  await page.route("**/api/projects", async (route) => {
    if (
      route.request().method() !== "GET" ||
      new URL(route.request().url()).pathname !== "/api/projects"
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [], activeProjectId: null }),
    });
  });

  await page.route("**/api/automations", async (route) => {
    // Only the bare list endpoint — the /nodes sub-route has its own stub above.
    if (
      route.request().method() !== "GET" ||
      new URL(route.request().url()).pathname !== "/api/automations"
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        automations: [],
        summary: {
          total: 0,
          coordinatorCount: 0,
          workflowCount: 0,
          scheduledCount: 0,
          draftCount: 0,
        },
        workflowStatus: null,
        workflowFetchError: null,
      }),
    });
  });

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: false,
        enabled: false,
        cloudVoiceProxyAvailable: false,
        hasApiKey: false,
      }),
    });
  });

  await page.route("**/api/trajectories**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === "/api/trajectories/stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          totalTrajectories: 0,
          totalLlmCalls: 0,
          totalProviderAccesses: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          averageDurationMs: 0,
          bySource: {},
          byModel: {},
        }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories/config") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories/latest") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ trajectory: null }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          trajectories: [],
          total: 0,
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        trajectory: {
          id: decodeURIComponent(url.pathname.split("/").pop() ?? "unknown"),
          status: "completed",
          llmCallCount: 0,
        },
        llmCalls: [],
        providerAccesses: [],
        toolEvents: [],
        evaluationEvents: [],
      }),
    });
  });

  let stewardPendingApprovals = smokeStewardPendingApprovals();
  const stewardHistoryRecords = smokeStewardHistoryRecords();

  await page.route("**/api/wallet/steward-status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyStewardStatus()),
    });
  });

  await page.route("**/api/wallet/steward-pending-approvals", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stewardPendingApprovals),
    });
  });

  await page.route("**/api/wallet/steward-tx-records**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const status = url.searchParams.get("status");
    const records = status
      ? stewardHistoryRecords.filter((record) => record.status === status)
      : stewardHistoryRecords;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        records,
        total: records.length,
        offset: Number(url.searchParams.get("offset") ?? 0),
        limit: Number(url.searchParams.get("limit") ?? 25),
      }),
    });
  });

  await page.route("**/api/wallet/steward-approve-tx", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { txId?: string };
    stewardPendingApprovals = stewardPendingApprovals.filter(
      (approval) => approval.transaction.id !== body.txId,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        txHash:
          "0xapproved000000000000000000000000000000000000000000000000000000",
      }),
    });
  });

  await page.route("**/api/wallet/steward-deny-tx", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { txId?: string };
    stewardPendingApprovals = stewardPendingApprovals.filter(
      (approval) => approval.transaction.id !== body.txId,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/wallet/market-overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletMarketOverview()),
    });
  });

  await page.route("**/api/wallet/trading/profile**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyWalletTradingProfile(new URL(request.url()))),
    });
  });

  // Settings, Voice, and Vault mount these local-runtime panels eagerly. The
  // smoke server has no native inference or secrets backends, so expose their
  // real healthy-empty envelopes instead of leaking its generic 501 response
  // into otherwise unrelated route and interaction coverage.
  await page.route(
    "**/api/local-inference/voice-models/preferences",
    async (route) => {
      const method = route.request().method();
      if (method !== "GET" && method !== "POST") {
        await route.fallback();
        return;
      }
      const preferences = {
        autoUpdateOnWifi: true,
        autoUpdateOnCellular: false,
        autoUpdateOnMetered: false,
        quietHours: [{ start: "22:00", end: "08:00" }],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          method === "GET" ? { preferences } : { ok: true, preferences },
        ),
      });
    },
  );

  await page.route("**/api/local-inference/voice-models", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installations: [] }),
    });
  });

  await page.route("**/api/accounts/consumer-keys", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ keys: [] }),
    });
  });

  await page.route("**/api/secrets/manager/protection", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        protection: {
          localVault: {
            encryptedAtRest: true,
            cipher: "AES-256-GCM",
            masterKey: { backend: "test", available: true },
          },
          nativeSessionState: {
            policy: "platform-protected-store",
            synchronized: false,
            plaintextFallback: false,
          },
          connectorSessions: {
            telegramPersonal: "vault-master-key-encrypted",
          },
          cloudTrustDomain: "separate-organization-kms",
        },
      }),
    });
  });

  await page.route("**/api/secrets/logins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, logins: [], failures: [] }),
    });
  });
}

type CloudWalletImportMockApi = {
  lastWalletConfigPut: () => Record<string, unknown> | null;
  refreshCloudRequestCount: () => number;
  walletConfigGetCount: () => number;
};

/** Overrides the default smoke routes for the cloud wallet import flow. */
export async function installCloudWalletImportApiOverrides(
  page: Page,
): Promise<CloudWalletImportMockApi> {
  let lastWalletPut: Record<string, unknown> | null = null;
  let refreshCloudHits = 0;
  let walletConfigGetHits = 0;

  const initialWalletConfig = {
    selectedRpcProviders: {
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    },
    walletNetwork: "mainnet",
    legacyCustomChains: [],
    alchemyKeySet: true,
    infuraKeySet: false,
    ankrKeySet: false,
    nodeRealBscRpcSet: false,
    quickNodeBscRpcSet: false,
    managedBscRpcReady: false,
    cloudManagedAccess: true,
    heliusKeySet: true,
    birdeyeKeySet: false,
    evmChains: ["ethereum", "base"],
    evmAddress: null,
    solanaAddress: null,
  };

  let walletConfigState: typeof initialWalletConfig = {
    ...initialWalletConfig,
    legacyCustomChains: [...initialWalletConfig.legacyCustomChains],
    evmChains: [...initialWalletConfig.evmChains],
  };

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "playwright-smoke-user",
      }),
    });
  });

  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });

  await page.route("**/api/wallet/config", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      walletConfigGetHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(walletConfigState),
      });
      return;
    }
    if (req.method() === "PUT") {
      const raw = req.postData();
      lastWalletPut = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const selections = lastWalletPut?.selections as
        | typeof walletConfigState.selectedRpcProviders
        | undefined;
      if (selections) {
        walletConfigState = {
          ...walletConfigState,
          selectedRpcProviders: selections,
          cloudManagedAccess: true,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/wallet/refresh-cloud", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    refreshCloudHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        warnings: [],
      }),
    });
  });

  await page.route("**/api/wallet/addresses", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evmAddress: null, solanaAddress: null }),
    });
  });

  await page.route("**/api/wallet/balances", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evm: null,
        solana: null,
      }),
    });
  });

  await page.route("**/api/wallet/nfts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evm: [], solana: null }),
    });
  });

  return {
    lastWalletConfigPut: () => lastWalletPut,
    refreshCloudRequestCount: () => refreshCloudHits,
    walletConfigGetCount: () => walletConfigGetHits,
  };
}
