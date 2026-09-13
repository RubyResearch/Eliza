/**
 * Real-browser screenshot + assertion harness for the WALLET home widget
 * (#14344) — no app server. Bundles wallet-widget-fixture.tsx (the REAL
 * `WalletBalanceWidget`) with esbuild, stubs only the `../../../api` client,
 * auth, and nav modules, loads it in headless chromium, and proves three states:
 *
 *   - DEFAULT (no holdings): the tracked BTC/SOL/ETH price rows are shown
 *     (previously the widget rendered nothing here — the bug this fixes).
 *   - HELD (≥1 priced holding): the top-3 held by holding value, price-only.
 *   - UNAVAILABLE: a failed balances request never masquerades as no holdings.
 *
 * Captures a screenshot of each state for inline PR evidence.
 *
 * Run: bun run --cwd packages/ui test:wallet-widget-e2e
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  closeOcrEngines,
  dominantColorsFromPng,
  ocrImage,
} from "../../../../../../evidence/src/visual-primitives.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../../styles");
const outDir = join(here, "output-wallet");
const WIDGET_TIMEOUT_MS = 30_000;
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
// The widget uses semantic text tokens that tailwind's CDN default config does
// not know; map them to readable colours on the orange field for the capture.
const TOKEN_SHIM = `
.text-muted{color:rgba(255,255,255,0.72)}
.text-txt-strong{color:#ffffff}
.text-success{color:#bbf7d0}
.text-danger{color:#fecaca}
`;

// Client + hook stubs: the widget fetches balances/overview from the api module
// singleton, so we replace it with a state-driven stub (chosen by ?state=held).
const apiStub = join(outDir, "api-stub.ts");
await writeFile(
  apiStub,
  `const state = new URLSearchParams(location.search).get("state");
const held = state === "held";
const unavailable = state === "unavailable";
const overview = {
  generatedAt: "", cacheTtlSeconds: 120, stale: false,
  sources: {}, predictions: [], movers: [],
  prices: [
    { id: "bitcoin", symbol: "BTC", name: "Bitcoin", priceUsd: 64000, change24hPct: 1.2, imageUrl: null },
    { id: "ethereum", symbol: "ETH", name: "Ethereum", priceUsd: 3000, change24hPct: -0.5, imageUrl: null },
    { id: "solana", symbol: "SOL", name: "Solana", priceUsd: 150, change24hPct: 2.1, imageUrl: null },
    { id: "usd-coin", symbol: "USDC", name: "USD Coin", priceUsd: 1.0, change24hPct: 0.0, imageUrl: null },
  ],
};
const heldBalances = {
  evm: { address: "0xabc", chains: [{ chain: "ethereum", chainId: 1, nativeBalance: "0",
    nativeSymbol: "ETH", nativeValueUsd: "5000", error: null, tokens: [
      { symbol: "USDC", name: "USD Coin", balance: "0", decimals: 6, valueUsd: "800", address: "0xusdc" },
    ] }] },
  solana: { address: "sol1", solBalance: "0", solValueUsd: "2000", tokens: [] },
};
export const client = {
  getWalletBalances: async () => {
    if (unavailable) throw new Error("balances 503");
    return held ? heldBalances : { evm: null, solana: null };
  },
  getWalletMarketOverview: async () => overview,
};
`,
);
const authStub = join(outDir, "auth-stub.ts");
await writeFile(
  authStub,
  `export function useIsAuthenticated() { return true; }\n` +
    `export function isAuthenticatedNow() { return true; }\n` +
    `export function subscribeAuthStatus() { return () => {}; }\n`,
);
const navStub = join(outDir, "nav-stub.ts");
await writeFile(
  navStub,
  `export const HOME_WIDGET_SOLID_TILE_CLASS =
  "group relative flex h-auto w-full overflow-hidden rounded-2xl border border-[color:color-mix(in_srgb,var(--brand-white)_20%,var(--brand-black))] bg-[var(--brand-black)] text-left text-[var(--brand-white)]";
export function useWidgetNavigation() { return { openView() {}, openTab() {} }; }\n`,
);
// Wallet-section surface chrome deps (#16943): ViewHeader pulls the app-wide
// navigation + agent-surface graphs (which reach Node-only modules through the
// package barrels). The section composition under test — WalletSectionNav +
// real SectionNav + real app-shell registry + real widget — stays real; these
// three chrome seams are replaced with browser-safe minimal impls.
const agentSurfaceStub = join(outDir, "agent-surface-stub.ts");
await writeFile(
  agentSurfaceStub,
  `export function useAgentElement() { return { ref: () => {}, agentProps: {} }; }\n`,
);
const navigationStub = join(outDir, "navigation-stub.ts");
await writeFile(
  navigationStub,
  `export function shouldUseHashNavigation() { return false; }\n`,
);
// The UI registry-host shim re-exports through the @elizaos/shared barrel;
// resolve it straight to the self-contained shared source module instead.
const registryHostSource = join(here, "../../../../../../shared/src/registry-host.ts");
const sharedOverlayRegistrySource = join(
  here,
  "../../../../../../shared/src/apps/overlay-app-registry.ts",
);
const sharedAppsContractSource = join(
  here,
  "../../../../../../shared/src/contracts/apps.ts",
);

const stubModules = {
  name: "stub-wallet-deps",
  setup(b) {
    b.onResolve({ filter: /\/api$/ }, () => ({ path: apiStub }));
    b.onResolve({ filter: /useAuthStatus$/ }, () => ({ path: authStub }));
    b.onResolve({ filter: /home-widget-card$/ }, () => ({ path: navStub }));
    b.onResolve({ filter: /\/agent-surface$/ }, () => ({
      path: agentSurfaceStub,
    }));
    b.onResolve({ filter: /\/navigation$/ }, () => ({ path: navigationStub }));
    b.onResolve({ filter: /\/registry-host$/ }, () => ({
      path: registryHostSource,
    }));
    // app-shell-registry needs two browser-safe shared exports. Keep their real
    // implementations while bypassing the package root, whose server exports
    // intentionally reach Node builtins that do not belong in this fixture.
    b.onResolve({ filter: /^@elizaos\/shared$/ }, () => ({
      path: "wallet-shared-app-shell",
      namespace: "wallet-shared",
    }));
    b.onLoad(
      { filter: /.*/, namespace: "wallet-shared" },
      () => ({
        contents: [
          `export { getAllOverlayApps } from ${JSON.stringify(sharedOverlayRegistrySource)};`,
          `export { packageNameToAppRouteSlug } from ${JSON.stringify(sharedAppsContractSource)};`,
        ].join("\n"),
        loader: "js",
        resolveDir: here,
      }),
    );
  },
};

const result = await build({
  entryPoints: [join(here, "wallet-widget-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubModules],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>wallet widget e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style>
<style>${TOKEN_SHIM}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "wallet-widget.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 560 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // DEFAULT state — no holdings, BTC/SOL/ETH rows must appear (the bug fix).
  await page.goto(`file://${htmlPath}?state=default`);
  await page.waitForSelector('[data-testid="chat-widget-wallet-prices"]', {
    timeout: WIDGET_TIMEOUT_MS,
  });
  const defaultRows = await page
    .locator('[data-testid^="wallet-price-row-"]')
    .evaluateAll((els) => els.map((e) => e.dataset.testid));
  assert(
    JSON.stringify(defaultRows) ===
      JSON.stringify([
        "wallet-price-row-BTC",
        "wallet-price-row-SOL",
        "wallet-price-row-ETH",
      ]),
    `DEFAULT state shows BTC/SOL/ETH rows (got ${JSON.stringify(defaultRows)})`,
  );
  await page.screenshot({ path: join(outDir, "wallet-default.png") });
  await page
    .locator('[data-testid="chat-widget-wallet-prices"]')
    .screenshot({ path: join(outDir, "wallet-default-card.png") });
  console.log("  📸 wallet-default.png");

  // HELD state — top-3 priced holdings by holding value: ETH $5000, SOL $2000, USDC $800.
  await page.goto(`file://${htmlPath}?state=held`);
  await page.waitForSelector('[data-testid="chat-widget-wallet-prices"]', {
    timeout: WIDGET_TIMEOUT_MS,
  });
  const heldRows = await page
    .locator('[data-testid^="wallet-price-row-"]')
    .evaluateAll((els) => els.map((e) => e.dataset.testid));
  assert(
    JSON.stringify(heldRows) ===
      JSON.stringify([
        "wallet-price-row-ETH",
        "wallet-price-row-SOL",
        "wallet-price-row-USDC",
      ]),
    `HELD state shows top-3 held by value ETH/SOL/USDC (got ${JSON.stringify(heldRows)})`,
  );
  // Price-only invariant (#10706): the $5000/$2000/$800 holding values must NOT leak.
  const heldText = await page
    .locator('[data-testid="chat-widget-wallet-prices"]')
    .innerText();
  assert(
    !heldText.includes("5,000") && !heldText.includes("2,000") && !heldText.includes("800"),
    "HELD state leaks no holding values (price-only #10706)",
  );
  await page.screenshot({ path: join(outDir, "wallet-held.png") });
  await page
    .locator('[data-testid="chat-widget-wallet-prices"]')
    .screenshot({ path: join(outDir, "wallet-held-card.png") });
  console.log("  📸 wallet-held.png");

  // Market prices alone cannot prove whether the wallet has holdings.
  await page.goto(`file://${htmlPath}?state=unavailable`);
  await page.waitForSelector('[data-testid="chat-widget-wallet-unavailable"]', {
    timeout: WIDGET_TIMEOUT_MS,
  });
  await page.waitForTimeout(100);
  const unavailableRows = await page
    .locator('[data-testid^="wallet-price-row-"]')
    .count();
  assert(
    unavailableRows === 0,
    `UNAVAILABLE state shows no fabricated default rows (got ${unavailableRows})`,
  );
  await page.screenshot({ path: join(outDir, "wallet-unavailable.png") });
  await page
    .locator('[data-testid="chat-widget-wallet-unavailable"]')
    .screenshot({ path: join(outDir, "wallet-unavailable-card.png") });
  console.log("  📸 wallet-unavailable.png");

  // WALLET SECTION surface — the REAL WalletSectionNav owns only the routed
  // header and section tabs. Balance data belongs to the canonical wallet body
  // now, so this fixture proves the wrapper does not mount a duplicate widget.
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const desktopPage = await desktop.newPage();
  desktopPage.on("pageerror", (e) => errors.push(String(e)));
  await desktopPage.goto(
    `file://${htmlPath}?surface=wallet-section&state=default`,
  );
  // ViewHeader renders nothing without trailing actions (views stopped
  // repeating a title row), so the header inset is an empty, zero-height div;
  // the section tab strip is the surface's visible anchor.
  await desktopPage.waitForSelector('[data-testid="section-nav-wallet"]', {
    state: "visible",
    timeout: WIDGET_TIMEOUT_MS,
  });
  assert(
    (await desktopPage.locator('[data-testid="wallet-section-price-surface"]').count()) ===
      0,
    "WALLET SECTION surface does not duplicate the wallet balance widget",
  );
  assert(
    (await desktopPage.locator('[data-testid="section-nav-wallet"]').count()) ===
      1,
    "WALLET SECTION surface renders the real section tab strip",
  );
  assert(
    (await desktopPage.locator('[data-testid="wallet-section-header-inset"]').count()) ===
      1,
    "WALLET SECTION surface keeps the safe-area header inset",
  );
  assert(
    (await desktopPage
      .locator('[data-testid="view-header"], [data-testid="view-actions"]')
      .count()) === 0,
    "WALLET SECTION surface does not repeat a title header row",
  );
  await desktopPage.screenshot({
    path: join(outDir, "wallet-section-desktop.png"),
  });
  await desktopPage.screenshot({
    path: join(outDir, "wallet-section-desktop.jpg"),
    type: "jpeg",
    quality: 90,
  });
  console.log("  📸 wallet-section-desktop.png/.jpg");
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (e) => errors.push(String(e)));
  // The mobile wrapper has the same navigation-only contract.
  await mobilePage.goto(
    `file://${htmlPath}?surface=wallet-section&state=held`,
  );
  await mobilePage.waitForSelector('[data-testid="section-nav-wallet"]', {
    state: "visible",
    timeout: WIDGET_TIMEOUT_MS,
  });
  assert(
    (await mobilePage.locator('[data-testid="wallet-section-price-surface"]').count()) ===
      0,
    "WALLET SECTION (mobile) does not duplicate the wallet balance widget",
  );
  await mobilePage.screenshot({
    path: join(outDir, "wallet-section-mobile.png"),
  });
  await mobilePage.screenshot({
    path: join(outDir, "wallet-section-mobile.jpg"),
    type: "jpeg",
    quality: 90,
  });
  console.log("  📸 wallet-section-mobile.png/.jpg");
  await mobile.close();

  assert(errors.length === 0, `no page errors (${errors.length})`);
  for (const e of errors) console.log("  ERR:", e);
  await ctx.close();
} finally {
  await browser.close();
}

const visualStates = [
  {
    state: "default",
    image: "wallet-default.png",
    ocrImages: ["wallet-default.png", "wallet-default-card.png"],
    present: ["DEFAULT", "Wallet", "BTC", "SOL", "ETH"],
    absent: ["UNAVAILABLE"],
  },
  {
    state: "held",
    image: "wallet-held.png",
    ocrImages: ["wallet-held.png", "wallet-held-card.png"],
    present: ["HELD", "Wallet", "ETH", "SOL", "USDC"],
    absent: ["UNAVAILABLE"],
  },
  {
    state: "unavailable",
    image: "wallet-unavailable.png",
    ocrImages: ["wallet-unavailable.png", "wallet-unavailable-card.png"],
    present: ["UNAVAILABLE", "holdings unknown", "Wallet"],
    absent: ["BTC", "SOL", "ETH", "USDC"],
  },
];
const visualAnalysis = [];
try {
  for (const spec of visualStates) {
    const imagePath = join(outDir, spec.image);
    const [ocrParts, palette] = await Promise.all([
      Promise.all(
        spec.ocrImages.map((image) =>
          ocrImage(join(outDir, image), { timeoutMs: 60_000 }),
        ),
      ),
      dominantColorsFromPng(imagePath),
    ]);
    const ocr = {
      available: ocrParts.every((part) => part.available),
      parts: ocrParts,
      text: ocrParts
        .filter((part) => part.available)
        .map((part) => part.text)
        .join("\n"),
    };
    const normalizedText = ocr.text.toLowerCase();
    const missing = spec.present.filter(
      (value) => !normalizedText.includes(value.toLowerCase()),
    );
    const unexpected = spec.absent.filter((value) =>
      normalizedText.includes(value.toLowerCase()),
    );
    const orangeCoverage = palette.buckets.orange ?? 0;
    const blueCoverage = palette.buckets.blue ?? 0;
    assert(ocr.available, `${spec.state} OCR is available`);
    assert(
      missing.length === 0,
      `${spec.state} OCR contains expected text (missing ${JSON.stringify(missing)})`,
    );
    assert(
      unexpected.length === 0,
      `${spec.state} OCR excludes other-state text (found ${JSON.stringify(unexpected)})`,
    );
    assert(
      orangeCoverage >= 0.65,
      `${spec.state} keeps the orange home field (${(orangeCoverage * 100).toFixed(1)}%)`,
    );
    assert(
      blueCoverage <= 0.01,
      `${spec.state} contains no blue palette bleed (${(blueCoverage * 100).toFixed(1)}%)`,
    );
    visualAnalysis.push({
      ...spec,
      ocr,
      palette,
      verdict: {
        missing,
        unexpected,
        orangeCoverage,
        blueCoverage,
        pass:
          ocr.available &&
          missing.length === 0 &&
          unexpected.length === 0 &&
          orangeCoverage >= 0.65 &&
          blueCoverage <= 0.01,
      },
    });
  }
} finally {
  await closeOcrEngines();
}
await writeFile(
  join(outDir, "wallet-visual-analysis.json"),
  `${JSON.stringify(visualAnalysis, null, 2)}\n`,
);
console.log("  📊 wallet-visual-analysis.json");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll wallet-widget assertions passed.");
