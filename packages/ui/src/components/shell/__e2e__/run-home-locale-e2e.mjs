/**
 * Real-browser screenshot + assertion harness for home time/weather locale
 * correctness (#14345). Bundles the REAL `DefaultHomeWidgets` with esbuild,
 * renders it under two locales with a fixed 14:30 clock and a stubbed
 * geolocation + Open-Meteo fetch, and proves:
 *
 *   - en-US → 12-hour clock ("2:30" + "PM") and °F.
 *   - de-DE → 24-hour clock ("14:30", no AM/PM) and °C.
 *
 * The locale drives BOTH the hour cycle (Intl hourCycle) and the temperature
 * unit (region → Open-Meteo `temperature_unit`), resolved once at module load.
 *
 * Run: bun run --cwd packages/ui test:home-locale-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/esbuild-stubs.ts";
import {
  compileTailwindTheme,
  FILE_FIXTURE_BOOTSTRAP,
} from "../../../testing/e2e-runner/fixture-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, "../../../..");
const outDir = join(here, "../../../../tmp/home-locale-e2e");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const themeCss = await compileTailwindTheme({
  uiRoot,
  sources: [join(uiRoot, "src"), here],
});

// The real `../../state` app-store graph pulls Node-only deps into the browser
// bundle; stub it to a minimal selector that keeps the time tile shown.
const stateStub = join(outDir, "state-stub.ts");
await writeFile(
  stateStub,
  "export function useAppSelector(fn) { return fn({ homeTimeWidgetHidden: false }); }\n",
);
const stubState = {
  name: "stub-state",
  setup(b) {
    b.onResolve({ filter: /\/state$/ }, () => ({ path: stateStub }));
  },
};
const stubWeatherDeps = {
  name: "stub-weather-deps",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/logger$/ }, () => ({
      path: "logger-stub",
      namespace: "home-locale-stub",
    }));
    b.onResolve({ filter: /\/api\/client$/ }, () => ({
      path: "api-client-stub",
      namespace: "home-locale-stub",
    }));
    b.onResolve({ filter: /\/surface-realm-channel$/ }, () => ({
      path: "surface-realm-channel-stub",
      namespace: "home-locale-stub",
    }));
    b.onLoad(
      { filter: /^logger-stub$/, namespace: "home-locale-stub" },
      () => ({
        contents:
          "export const logger = { warn() {}, error() {}, info() {}, debug() {} };",
        loader: "js",
      }),
    );
    b.onLoad(
      { filter: /^api-client-stub$/, namespace: "home-locale-stub" },
      () => ({
        contents:
          "export const client = { getBaseUrl: () => '', getAuthorityRevision: () => 0, onAuthorityChange: () => () => {}, fetch: async () => ({ lat: 37.77, lon: -122.42 }) };" +
          "export function ElizaClient() { return client; }",
        loader: "js",
      }),
    );
    b.onLoad(
      { filter: /^surface-realm-channel-stub$/, namespace: "home-locale-stub" },
      () => ({
        // `runAsPrivilegedShell` is pulled in once the auth-status gate
        // (#16242) reaches this bundle via csrf-client → ios-local-agent-kernel;
        // stub it as a direct passthrough (no realm boundary in the fixture).
        contents:
          "export const shellLocalStorage = window.localStorage;\n" +
          "export const runAsPrivilegedShell = (fn) => fn();",
        loader: "js",
      }),
    );
  },
};

const result = await build({
  entryPoints: [join(here, "home-locale-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubState, stubWeatherDeps, stubElizaCore(), stubNodeBuiltins()],
  write: false,
});
const js = result.outputFiles[0].text;
// HomeScreen normally selects a date variant; this standalone widget host uses the full date.
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>home locale e2e</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${themeCss}</style>
<style>html,body{margin:0;height:100%}[data-home-clock-date-compact]{display:none}</style>
<script>${FILE_FIXTURE_BOOTSTRAP};window.global=window.global||window;</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "home-locale.html");
await writeFile(htmlPath, html);

// Stub geolocation (granted) + Open-Meteo before any app script runs. The temp
// value follows the requested unit so the reading is realistic per locale.
const initScript = `
Object.defineProperty(navigator, 'geolocation', {
  configurable: true,
  value: { getCurrentPosition: (ok) => ok({ coords: { latitude: 37.77, longitude: -122.42 } }) },
});
Object.defineProperty(navigator, 'permissions', {
  configurable: true,
  value: { query: async () => ({ state: 'granted' }) },
});
const realFetch = window.fetch;
window.fetch = (url, ...rest) => {
  const u = String(url);
  if (u.includes('api.open-meteo.com')) {
    const fahrenheit = u.includes('temperature_unit=fahrenheit');
    return Promise.resolve(new Response(JSON.stringify({
      current: { temperature_2m: fahrenheit ? 68 : 20, weather_code: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(url, ...rest);
};
`;

const browser = await chromium.launch();
try {
  for (const { locale, name, expect24h } of [
    { locale: "en-US", name: "en-US", expect24h: false },
    { locale: "de-DE", name: "de-DE", expect24h: true },
  ]) {
    const ctx = await browser.newContext({
      locale,
      timezoneId: "UTC",
      viewport: { width: 560, height: 360 },
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript(initScript);
    // Fixed 14:30 UTC so the 12h/24h difference is unambiguous (hour > 12).
    await ctx.clock.install({ time: new Date("2026-06-25T14:30:00Z") });
    const page = await ctx.newPage();
    const errors = [];
    let rejectPageError;
    const pageError = new Promise((_, reject) => {
      rejectPageError = reject;
    });
    page.on("pageerror", (error) => {
      errors.push(String(error));
      rejectPageError(
        new Error(`[${name}] fixture page error: ${error.message}`, {
          cause: error,
        }),
      );
    });
    await Promise.race([
      pageError,
      (async () => {
        await page.goto(`file://${htmlPath}`);
        await page.waitForFunction(
          () =>
            (
              document.querySelector('[data-testid="home-time-widget"]')
                ?.textContent ?? ""
            ).includes(":30"),
          undefined,
          { timeout: 8000 },
        );
        await page.waitForSelector(
          '[data-testid="home-weather"][data-status="ready"]',
          { timeout: 8000 },
        );
      })(),
    ]);
    const text = await page
      .locator('[data-testid="default-home-widgets"]')
      .innerText();

    const temperature = await page
      .locator("[data-home-weather-temperature]")
      .innerText();
    const normalizedTemperature = temperature.replace(/\s+/g, "");

    if (expect24h) {
      assert(text.includes("14:30"), `[${name}] 24-hour clock shows 14:30`);
      assert(!/\bPM\b/.test(text), `[${name}] no AM/PM suffix`);
      assert(normalizedTemperature === "20°C", `[${name}] temperature is 20°C`);
      assert(!text.includes("°F"), `[${name}] not °F`);
    } else {
      assert(text.includes("2:30"), `[${name}] 12-hour clock shows 2:30`);
      assert(/\bPM\b/.test(text), `[${name}] has PM suffix`);
      assert(normalizedTemperature === "68°F", `[${name}] temperature is 68°F`);
      assert(!text.includes("°C"), `[${name}] not °C`);
    }
    assert(errors.length === 0, `[${name}] no page errors (${errors.length})`);
    for (const e of errors) console.log("  ERR:", e);
    await page.screenshot({ path: join(outDir, `home-${name}.png`) });
    console.log(`  📸 home-${name}.png`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll home-locale assertions passed.");
