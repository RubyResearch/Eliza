/**
 * Vite configuration for the cross-platform app renderer.
 *
 * The config keeps web, Electrobun, and Capacitor builds on the same source
 * graph while pinning browser-safe aliases, dev-server prebundles, and manual
 * chunks that protect startup order for native, wallet, crypto, and workspace
 * package dependencies.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import {
  createLogger,
  defaultClientConditions,
  defineConfig,
  loadEnv,
  type Plugin,
  transformWithOxc,
} from "vite";
import {
  ANDROID_CLOUD_ROUTING_MARKERS,
  findAndroidCloudRoutingMarkers,
} from "../app-core/scripts/lib/android-cloud-routing-markers.mjs";
import { resolveAppBranding } from "../shared/src/config/app-config.ts";
import { colorizeDevSettingsStartupBanner } from "../shared/src/dev-settings-banner-style.ts";
import { prependDevSubsystemFigletHeading } from "../shared/src/dev-settings-figlet-heading.ts";
import {
  type DevSettingsRow,
  formatDevSettingsTable,
} from "../shared/src/dev-settings-table.ts";
import {
  resolveDesktopApiPort,
  resolveDesktopApiPortPreference,
  resolveDesktopUiPort,
  resolveDesktopUiPortPreference,
} from "../shared/src/runtime-env.ts";
import {
  DEFAULT_APP_ROUTE_PLUGIN_MODULES,
  syncElizaEnvAliases,
} from "../shared/src/utils/env.ts";
import appConfig from "./app.config.ts";
import {
  removeEmittedBuildStamp,
  removePublicBuildStamp,
  shouldSkipBuildStamp,
} from "./scripts/build-stamp.mjs";
import { CAPACITOR_PLUGIN_NAMES } from "./scripts/capacitor-plugin-names.mjs";
import { forbiddenForcedHostModeFlags } from "./scripts/forced-host-mode-guard.mjs";
import { normalizeEnvPrefix } from "./src/env-prefix.js";
import { appSideEffectModulesPlugin } from "./vite/app-side-effect-modules.ts";
import { calendarOptimizeDeps } from "./vite/calendar-optimize-deps.ts";
import { configureDevApiProxy } from "./vite/dev-http-proxy.ts";
import {
  generateNodeBuiltinStub,
  nativeModuleStubPlugin,
} from "./vite/native-module-stub-plugin.ts";
import { rendererBuildManifestPlugin } from "./vite/renderer-build-manifest-plugin.ts";
import { swBuildRevPlugin } from "./vite/sw-build-rev-plugin.ts";
import { VENDOR_OPTIMIZED_WALLET_TEST } from "./vite/wallet-chunk-matcher.ts";
import { resolveViteDevServerRuntime } from "./vite-dev-origin.ts";

const _require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
export function resolveAndroidCloudPrebootLockupDataUri(): string {
  const androidCloudPrebootLockupSvg = fs
    .readFileSync(
      path.join(here, "public", "brand", "logos", "eliza_logotext.svg"),
      "utf8",
    )
    .replace(
      /\s*<rect x="0\.081543" y="1\.84143" width="101\.919" height="101\.919" fill="#FF5800"\s*\/?>\s*/,
      "\n",
    );
  if (androidCloudPrebootLockupSvg.includes("#FF5800")) {
    throw new Error(
      "Android Cloud preboot lockup still contains its orange backing rect",
    );
  }
  return `data:image/svg+xml;base64,${Buffer.from(
    androidCloudPrebootLockupSvg,
  ).toString("base64")}`;
}
const nativePluginsRoot = path.join(elizaRoot, "plugins");
const bunLinkedPackageCacheRoot = path.join(
  os.homedir(),
  ".bun/install/cache/links",
);

let reactPath: string;
let reactDomPath: string;
try {
  const lucidePath = _require.resolve("lucide-react");
  const lucideReq = createRequire(lucidePath);
  reactPath = path.dirname(lucideReq.resolve("react/package.json"));
  reactDomPath = path.dirname(lucideReq.resolve("react-dom/package.json"));
} catch {
  reactPath = path.dirname(_require.resolve("react/package.json"));
  reactDomPath = path.dirname(_require.resolve("react-dom/package.json"));
}
const reactEntry = path.join(reactPath, "index.js");
const reactJsxRuntimeEntry = path.join(reactPath, "jsx-runtime.js");
const reactJsxDevRuntimeEntry = path.join(reactPath, "jsx-dev-runtime.js");
const reactDomEntry = path.join(reactDomPath, "index.js");
const reactDomClientEntry = path.join(reactDomPath, "client.js");

// Authoritative PascalCase-icon-name → kebab-file map, parsed from lucide's own
// ESM barrel so there is zero name-guessing. Used to rewrite the app's
// `import { X } from "lucide-react"` into per-icon deep imports so only the
// ~130 icons actually used ship instead of the full ~1500-icon set (the barrel
// is not tree-shaken under the directory alias).
let lucideIconFileMap: Map<string, string> | null = null;
function getLucideIconFileMap(): Map<string, string> {
  if (lucideIconFileMap) return lucideIconFileMap;
  const map = new Map<string, string>();
  try {
    const barrelPath = path.resolve(
      elizaRoot,
      "packages/ui/node_modules/lucide-react/dist/esm/lucide-react.mjs",
    );
    const src = fs.readFileSync(barrelPath, "utf8");
    const lineRe =
      /export\s*\{([^}]*)\}\s*from\s*['"]\.\/icons\/([\w-]+)\.mjs['"]/g;
    let m: RegExpExecArray | null = lineRe.exec(src);
    while (m !== null) {
      const file = m[2];
      for (const part of m[1].split(",")) {
        const named = part.trim().match(/default as (\w+)/);
        if (named) map.set(named[1], file);
      }
      m = lineRe.exec(src);
    }
  } catch {
    // Barrel not found / unreadable — leave the map empty so the transform
    // no-ops and imports fall back to the (untransformed) barrel.
  }
  lucideIconFileMap = map;
  return map;
}

// Virtual module id served in place of the bare `lucide-react` barrel for the
// one remaining barrel consumer: the runtime module registry in
// `packages/ui/src/components/views/DynamicViewLoader.tsx`, which does
// `() => import("lucide-react")`. That dynamic import is invisible to the
// static per-icon rewrite, so without this it pulls lucide's full
// `icons/index.mjs` (~1500 icons → ~600KB). The virtual barrel re-exports only
// the icons the app statically imports, so the dynamic chunk shares the same
// curated icon set instead of the whole library.
const LUCIDE_USED_BARREL_ID = "virtual:lucide-react-used";
const LUCIDE_USED_BARREL_RESOLVED = `\0${LUCIDE_USED_BARREL_ID}`;

// The lucide per-icon rewrite is build-only (see the plugin's configResolved).
// In dev the barrel import is kept and pre-bundled, so we skip the rewrite.
let lucideRewriteEnabled = true;

let lucideUsedBarrelSource: string | null = null;
function buildLucideUsedBarrelSource(): string {
  if (lucideUsedBarrelSource !== null) return lucideUsedBarrelSource;
  const map = getLucideIconFileMap();
  // name → file for every icon statically imported anywhere in app source.
  const used = new Map<string, string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g;
  const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const roots = ["packages", "plugins", "apps"].map((d) =>
    path.join(elizaRoot, d),
  );
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!exts.has(path.extname(entry.name))) continue;
      let code: string;
      try {
        code = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!code.includes("lucide-react")) continue;
      let m: RegExpExecArray | null = importRe.exec(code);
      while (m !== null) {
        for (const rawSpec of m[1].split(",")) {
          const spec = rawSpec.trim();
          if (!spec || spec.startsWith("type ")) continue;
          const asMatch = spec.match(/^(\w+)\s+as\s+\w+$/);
          const name = asMatch ? asMatch[1] : spec;
          const file = map.get(name);
          if (file) used.set(name, file);
        }
        m = importRe.exec(code);
      }
    }
  };
  for (const root of roots) walk(root);
  const lines = [...used.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, file]) =>
        `export { default as ${name} } from "lucide-react/dist/esm/icons/${file}.mjs";`,
    );
  lucideUsedBarrelSource = `${lines.join("\n")}\n`;
  return lucideUsedBarrelSource;
}

const NATIVE_PLUGIN_DIR_PREFIX = "plugin-native-";
const appCoreSrcRoot = path.join(elizaRoot, "packages/app-core/src");
const pluginBrowserBridgeSrcRoot = path.join(
  elizaRoot,
  "plugins/plugin-browser/src",
);
const uiPkgRoot = path.join(elizaRoot, "packages/ui");
const capacitorCoreEntry = path.join(
  path.dirname(_require.resolve("@capacitor/core/package.json")),
  "dist/index.js",
);
const patheEntry = _require.resolve("pathe");
// The feross `buffer` package exposes a callable Buffer function required by
// the crypto/wallet graph at module initialization. The native-module stub's
// empty Buffer class is not callable, and `buffer` is not a direct app
// dependency, so the alias targets the highest version available in Bun's store.
const bufferEntry: string | undefined = (() => {
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    const versions = fs
      .readdirSync(bunDir)
      .filter((d) => /^buffer@\d/.test(d))
      .sort();
    for (const dir of versions.reverse()) {
      const entry = path.join(bunDir, dir, "node_modules/buffer/index.js");
      if (fs.existsSync(entry)) return entry;
    }
  } catch {
    // fall through — alias simply not added; build behaves as before
  }
  return undefined;
})();
const bufferBase64JsEntry = resolveBunStorePackageEntry(
  "base64-js",
  "index.js",
);
const bufferIeee754Entry = resolveBunStorePackageEntry("ieee754", "index.js");
const BUFFER_ESM_SHIM_ID = "virtual:eliza-buffer-esm-shim";
const BUFFER_ESM_SHIM_RESOLVED = `\0${BUFFER_ESM_SHIM_ID}`;
const SOLANA_WALLET_CSS_RESOLVED = path.resolve(
  here,
  "src/shims/solana-wallet-adapter-react-ui.css",
);

function resolveBunStorePackageEntry(
  packageName: string,
  entryPath: string,
): string | undefined {
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    const versions = fs
      .readdirSync(bunDir)
      .filter((d) => d.startsWith(`${packageName}@`))
      .sort();
    for (const dir of versions.reverse()) {
      const entry = path.join(
        bunDir,
        dir,
        "node_modules",
        packageName,
        entryPath,
      );
      if (fs.existsSync(entry)) return entry;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function bufferEsmShimPlugin(): Plugin {
  return {
    name: "buffer-esm-shim",
    enforce: "pre",
    resolveId(source) {
      if (
        bufferEntry &&
        bufferBase64JsEntry &&
        bufferIeee754Entry &&
        (source === "buffer" ||
          source === "node:buffer" ||
          source === BUFFER_ESM_SHIM_ID)
      ) {
        return BUFFER_ESM_SHIM_RESOLVED;
      }
      return null;
    },
    load(id) {
      if (id !== BUFFER_ESM_SHIM_RESOLVED) return null;
      if (!bufferEntry || !bufferBase64JsEntry || !bufferIeee754Entry)
        return null;

      const base64Source = fs.readFileSync(bufferBase64JsEntry, "utf8");
      const ieee754Source = fs.readFileSync(bufferIeee754Entry, "utf8");
      const bufferSource = fs.readFileSync(bufferEntry, "utf8");

      return `
const base64JsModule = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  ${base64Source}
  return module.exports;
})();

const ieee754Module = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  ${ieee754Source}
  return module.exports;
})();

const bufferModule = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const require = (id) => {
    if (id === "base64-js") return base64JsModule;
    if (id === "ieee754") return ieee754Module;
    throw new Error("Unsupported buffer shim dependency: " + id);
  };
  ${bufferSource}
  return module.exports;
})();

export const Buffer = bufferModule.Buffer;
export const SlowBuffer = bufferModule.SlowBuffer;
export const INSPECT_MAX_BYTES = bufferModule.INSPECT_MAX_BYTES;
export const kMaxLength = bufferModule.kMaxLength;
export default bufferModule;
`;
    },
  };
}

// Other Capacitor packages imported by eliza/packages/app-core sources.
// Resolved here (packages/app scope) so Rollup can find them when bundling
// files from within the eliza submodule tree where bun may not hoist them.
function _tryResolve(id: string): string | undefined {
  try {
    return _require.resolve(id);
  } catch {
    return undefined;
  }
}
function _tryResolveFrom(id: string, fromFile: string): string | undefined {
  try {
    return createRequire(fromFile).resolve(id);
  } catch {
    return undefined;
  }
}
function tryResolvePackageModuleEntry(id: string): string | undefined {
  try {
    const packageJsonPath = _require.resolve(`${id}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      module?: unknown;
      main?: unknown;
    };
    const entry =
      typeof pkg.module === "string"
        ? pkg.module
        : typeof pkg.main === "string"
          ? pkg.main
          : undefined;
    return entry ? path.join(path.dirname(packageJsonPath), entry) : undefined;
  } catch {
    return undefined;
  }
}
function tryResolvePackageModuleEntryFrom(
  id: string,
  fromFile: string,
): string | undefined {
  try {
    const packageJsonPath = _tryResolveFrom(`${id}/package.json`, fromFile);
    if (!packageJsonPath) return undefined;
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      module?: unknown;
      main?: unknown;
    };
    const entry =
      typeof pkg.module === "string"
        ? pkg.module
        : typeof pkg.main === "string"
          ? pkg.main
          : undefined;
    return entry ? path.join(path.dirname(packageJsonPath), entry) : undefined;
  } catch {
    return undefined;
  }
}
const capacitorKeyboardEntry = tryResolvePackageModuleEntry(
  "@capacitor/keyboard",
);
const capacitorPreferencesEntry = tryResolvePackageModuleEntry(
  "@capacitor/preferences",
);
const capacitorAppEntry = tryResolvePackageModuleEntry("@capacitor/app");
const json5EsmEntry = path.join(
  path.dirname(_require.resolve("json5/package.json")),
  "dist/index.mjs",
);
const markedEntry = path.join(
  elizaRoot,
  "plugins/plugin-task-coordinator/node_modules/marked/lib/marked.esm.js",
);
const rechartsEntry = path.join(
  uiPkgRoot,
  "node_modules/recharts/es6/index.js",
);
const nprogressEntry = path.join(
  uiPkgRoot,
  "node_modules/nprogress/nprogress.js",
);
// react-router-dom is a direct UI package dependency, not an app dependency.
// With optimizeDeps.noDiscovery enabled, Vite cannot discover/pre-bundle it
// from packages/app, so its raw react-router dev chunk serves the CJS `cookie`
// package to the browser and blanks the dev shell. Resolve this graph from the
// package scopes that actually own each import.
const uiPackageJsonPath = path.join(uiPkgRoot, "package.json");
const reactRouterDomEntry = tryResolvePackageModuleEntryFrom(
  "react-router-dom",
  uiPackageJsonPath,
);
const reactRouterEntry = reactRouterDomEntry
  ? tryResolvePackageModuleEntryFrom("react-router", reactRouterDomEntry)
  : undefined;
const reactRouterDomExportEntry = reactRouterEntry
  ? _tryResolveFrom("react-router/dom", reactRouterEntry)
  : undefined;
const reactRouterCookieEntry = reactRouterEntry
  ? tryResolvePackageModuleEntryFrom("cookie", reactRouterEntry)
  : undefined;
// yaml / uuid / adze are transitive deps (logger, core, plugin-documents) that
// are listed in optimizeDeps.include but are not direct deps of packages/app.
// Resolve each browser entry from the app scope and alias the bare specifier so
// Vite can pre-bundle them instead of serving unresolved bare imports. `default`
// is the browser condition for yaml/uuid; adze is plain ESM via its `main`
// field. Resolution stays best-effort because production builds do not require
// these dev-server pre-bundle aliases.
const yamlBrowserEntry = (() => {
  try {
    return path.join(
      path.dirname(_require.resolve("yaml/package.json")),
      "browser/index.js",
    );
  } catch {
    return undefined;
  }
})();
const uuidBrowserEntry = (() => {
  try {
    return path.join(
      path.dirname(_require.resolve("uuid/package.json")),
      "dist/index.js",
    );
  } catch {
    return undefined;
  }
})();
const adzeEntry = (() => {
  try {
    return _require.resolve("adze");
  } catch {
    return undefined;
  }
})();
// react-day-picker (transitive via @elizaos/ui's calendar) imports the
// `date-fns/locale` barrel and `date-fns` from many call sites. Resolve each ESM
// entry through react-day-picker's scope and alias the bare specifiers so the
// optimizer collapses the locale tree into one chunk instead of serving hundreds
// of raw modules per page load. date-fns is `type: module`, so `index.js` and
// `locale.js` are the browser entries; date-fns-jalali mirrors it for the
// Persian calendar path.
const reactDayPickerEntry = tryResolvePackageModuleEntryFrom(
  "react-day-picker",
  uiPackageJsonPath,
);
const resolveDateFnsDir = (id: string): string | undefined => {
  if (!reactDayPickerEntry) return undefined;
  const packageJson = _tryResolveFrom(
    `${id}/package.json`,
    reactDayPickerEntry,
  );
  return packageJson ? path.dirname(packageJson) : undefined;
};
const dateFnsDir = resolveDateFnsDir("date-fns");
const dateFnsEntry = dateFnsDir ? path.join(dateFnsDir, "index.js") : undefined;
const dateFnsLocaleEntry = dateFnsDir
  ? path.join(dateFnsDir, "locale.js")
  : undefined;
const dateFnsJalaliDir = resolveDateFnsDir("date-fns-jalali");
const dateFnsJalaliEntry = dateFnsJalaliDir
  ? path.join(dateFnsJalaliDir, "index.js")
  : undefined;
const dateFnsJalaliLocaleEntry = dateFnsJalaliDir
  ? path.join(dateFnsJalaliDir, "locale.js")
  : undefined;
// @opentelemetry/api is a transitive runtime dep of @elizaos/core's browser
// bundle (StackContextManager / streaming-context tracing) but is not hoisted
// where packages/app can resolve the bare specifier, so Vite served its ~46
// internal modules raw in dev. Resolve its ESM entry through core's scope and
// alias the bare specifier to it so it can be pre-bundled + deduped to one copy.
const otelApiEntry = (() => {
  // Search candidate roots in priority order:
  // 1. workspace root node_modules (hoisted installs — npm/yarn/bun default)
  // 2. direct require() resolution from packages/app scope
  // 3. core's nested node_modules
  // 4. bun content-addressable store entries for the ai package
  // 5. bun content-addressable store entries for @opentelemetry/api directly
  const candidateRoots: string[] = [];

  // 1. Workspace root — fastest probe, covers most CI environments.
  candidateRoots.push(path.join(elizaRoot, "node_modules"));

  // 2. Direct require() resolution — works when hoisted correctly.
  try {
    const resolved = _require.resolve("@opentelemetry/api/package.json");
    // resolved is the package.json path; parent is the package dir,
    // grandparent is the node_modules root we want.
    candidateRoots.push(path.join(path.dirname(resolved), ".."));
  } catch {
    /* not resolvable from this scope */
  }

  // 3. core's nested node_modules.
  try {
    candidateRoots.push(
      path.join(
        path.dirname(_require.resolve("@elizaos/core/package.json")),
        "node_modules",
      ),
    );
  } catch {
    /* core not resolvable */
  }

  // 4. bun content-addressable store — ai package's nested node_modules.
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    if (fs.existsSync(bunDir)) {
      // Collect ALL ai@ entries; there may be multiple hash-variants.
      const aiEntries = fs
        .readdirSync(bunDir)
        .filter((d) => d.startsWith("ai@"));
      for (const aiEntry of aiEntries) {
        candidateRoots.push(path.join(bunDir, aiEntry, "node_modules"));
      }
    }
  } catch {
    /* bun store not accessible */
  }

  // 5. bun content-addressable store — @opentelemetry/api direct entries.
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    if (fs.existsSync(bunDir)) {
      const otelEntries = fs
        .readdirSync(bunDir)
        .filter((d) => d.startsWith("@opentelemetry+api@"))
        .sort();
      for (const otelEntry of otelEntries) {
        // Entry may have a nested node_modules/@opentelemetry/api layout or
        // place the package directly at the entry root.
        const withNested = path.join(bunDir, otelEntry, "node_modules");
        const asDirect = path.join(bunDir, otelEntry);
        if (
          fs.existsSync(
            path.join(withNested, "@opentelemetry/api/package.json"),
          )
        ) {
          candidateRoots.push(withNested);
        } else if (fs.existsSync(path.join(asDirect, "package.json"))) {
          // The package itself is at the entry root; its parent is the "root"
          // from which `@opentelemetry/api` resolves if we treat it as `{root}/@opentelemetry/api`.
          // Construct a synthetic path that the loop below can find.
          candidateRoots.push(path.join(bunDir, otelEntry, ".."));
        }
      }
    }
  } catch {
    /* bun store not accessible */
  }

  for (const root of candidateRoots) {
    const pkgJsonPath = path.join(root, "@opentelemetry/api/package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        module?: unknown;
        main?: unknown;
      };
      const entry =
        typeof pkg.module === "string"
          ? pkg.module
          : typeof pkg.main === "string"
            ? pkg.main
            : undefined;
      if (entry) return path.join(path.dirname(pkgJsonPath), entry);
    } catch {
      /* bad package.json */
    }
  }
  return undefined;
})();

function isExpectedWsProxySocketError(
  message: unknown,
  error: unknown,
): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!text.includes("ws proxy socket error")) {
    return false;
  }

  const errorLike =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : null;
  return (
    errorLike?.code === "ECONNRESET" ||
    String(errorLike?.message ?? "").includes("read ECONNRESET")
  );
}

/**
 * The /api proxy fires ECONNREFUSED on every request until the API server
 * finishes booting (~30s in dev). Those errors are transient startup noise —
 * when the API is genuinely down the UI surfaces its own connection errors —
 * so drop them rather than spamming the dev log.
 */
function isExpectedApiProxyConnectError(
  message: unknown,
  error: unknown,
): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!text.includes("http proxy error")) {
    return false;
  }
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ECONNREFUSED" || text.includes("ECONNREFUSED");
}

function stringifyBuildLogMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return typeof message === "string" ? message : String(message ?? "");
  }
  const record = message as {
    code?: unknown;
    id?: unknown;
    message?: unknown;
    plugin?: unknown;
  };
  return [record.code, record.message, record.id, record.plugin]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isKnownToleratedBuildWarning(message: unknown): boolean {
  const text = stringifyBuildLogMessage(message);
  if (
    text.includes("Sourcemap for") &&
    text.includes("@stwd+") &&
    text.includes("points to missing source files")
  ) {
    return true;
  }
  if (
    text.includes("IMPORT_IS_UNDEFINED") &&
    text.includes("Import `tslFn`") &&
    text.includes("three.webgpu")
  ) {
    return true;
  }
  if (
    text.includes("Use of direct eval") &&
    text.includes("@electric-sql/pglite")
  ) {
    return true;
  }
  // @elizaos/core's importAiProvider lazy-loads AI SDK providers by string
  // specifier; its /* @vite-ignore */ is stripped by Bun.build's minifier from
  // dist/browser/index.browser.js, so vite:import-analysis re-warns in local
  // mode (the symlinked core realpath has no node_modules segment). Intentional
  // and resolves correctly at runtime.
  if (text.includes("dynamic import cannot be analyzed by Vite")) {
    return true;
  }
  if (!text.includes("INEFFECTIVE_DYNAMIC_IMPORT")) {
    if (!text.includes("dynamically imported")) {
      return false;
    }
    return (
      text.includes("@capacitor/core") ||
      text.includes("@capacitor/preferences") ||
      text.includes("components/views/view-interact-registry.ts")
    );
  }
  return (
    text.includes("../app-core/src/browser.ts") ||
    text.includes("native-stub:node:fs/promises") ||
    text.includes("../ui/src/components/pages/") ||
    text.includes(
      "../../plugins/plugin-browser/src/actions/browser-autofill-login.ts",
    )
  );
}

function iosLocalAgentKernelEsbuildPlugin(): Plugin {
  const targetPath = path
    .join(elizaRoot, "packages/ui/src/api/ios-local-agent-kernel.ts")
    .split(path.sep)
    .join("/");

  return {
    name: "ios-local-agent-kernel-esbuild",
    enforce: "pre",
    async transform(code, id) {
      const normalizedId = id.split("?")[0]?.split(path.sep).join("/");
      if (normalizedId !== targetPath) return null;
      return transformWithOxc(code, id, {
        lang: "ts",
        target: "es2022",
      });
    },
  };
}

const viteLogger = createLogger();
const viteLoggerError = viteLogger.error;
const viteLoggerWarn = viteLogger.warn;
const viteLoggerWarnOnce = viteLogger.warnOnce;
viteLogger.error = (message, options) => {
  if (
    isExpectedWsProxySocketError(message, options?.error) ||
    isExpectedApiProxyConnectError(message, options?.error)
  ) {
    return;
  }
  viteLoggerError(message, options);
};
viteLogger.warn = (message, options) => {
  if (isKnownToleratedBuildWarning(message)) {
    return;
  }
  viteLoggerWarn(message, options);
};
viteLogger.warnOnce = (message, options) => {
  if (isKnownToleratedBuildWarning(message)) {
    return;
  }
  viteLoggerWarnOnce(message, options);
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePackageExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const condition of ["source", "import", "default"]) {
    const target = record[condition];
    if (typeof target === "string") return target;
  }

  return null;
}

function resolveLocalPackageSourceExportTarget(
  packageDir: string,
  exportTarget: string,
): string | null {
  if (!exportTarget.startsWith("./dist/") || !exportTarget.endsWith(".js")) {
    return null;
  }

  const sourceTarget = path.join(
    packageDir,
    "src",
    `${exportTarget.slice("./dist/".length, -".js".length)}.ts`,
  );
  return fs.existsSync(sourceTarget) ? sourceTarget : null;
}

function isAppPluginPackage(
  packageRootName: string,
  entryName: string,
  pkg: Record<string, unknown>,
): boolean {
  if (packageRootName !== "plugins") return true;
  if (entryName.startsWith("app-")) return true;
  const elizaos = pkg.elizaos;
  if (!elizaos || typeof elizaos !== "object") return false;
  return "app" in elizaos;
}

function createWorkspacePackageAliases(packageRoots: string[]) {
  const aliases = [];
  for (const packageRoot of packageRoots) {
    if (!fs.existsSync(packageRoot)) continue;
    const packageRootName = path.basename(packageRoot);
    for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(packageRoot, entry.name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (!isAppPluginPackage(packageRootName, entry.name, pkg)) continue;
      const pkgName = pkg.name;
      if (typeof pkgName !== "string") continue;
      const pkgExports =
        pkg.exports && typeof pkg.exports === "object"
          ? (pkg.exports as Record<string, unknown>)
          : {};
      const pkgDir = path.dirname(pkgPath);
      for (const [key, value] of Object.entries(pkgExports)) {
        if (key !== ".") continue;
        const exportTarget = resolvePackageExportTarget(value);
        if (!exportTarget) continue;
        aliases.push({
          find: new RegExp(`^${escapeRegExp(pkgName)}$`),
          replacement: path.resolve(pkgDir, exportTarget),
        });
      }
    }
  }
  return aliases;
}

function createWorkspacePackageExportAliases(packageDirs: string[]) {
  const aliases = [];
  for (const packageDir of packageDirs) {
    const pkgPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
    const pkgName = pkg.name;
    if (typeof pkgName !== "string") continue;
    const pkgExports =
      pkg.exports && typeof pkg.exports === "object"
        ? (pkg.exports as Record<string, unknown>)
        : {};

    for (const [key, value] of Object.entries(pkgExports)) {
      if (key !== "." && !key.startsWith("./")) continue;
      const exportTarget = resolvePackageExportTarget(value);
      if (!exportTarget) continue;
      const packageSpecifier =
        key === "." ? pkgName : `${pkgName}/${key.slice(2)}`;

      const keyWildcard = packageSpecifier.indexOf("*");
      const targetWildcard = exportTarget.indexOf("*");
      if (keyWildcard >= 0 || targetWildcard >= 0) {
        if (keyWildcard < 0 || targetWildcard < 0) continue;
        const keyPrefix = packageSpecifier.slice(0, keyWildcard);
        const keySuffix = packageSpecifier.slice(keyWildcard + 1);
        const wildcardPlaceholder = "__ELIZA_PACKAGE_EXPORT_WILDCARD__";
        const targetPattern = path.resolve(
          packageDir,
          `${exportTarget.slice(0, targetWildcard)}${wildcardPlaceholder}${exportTarget.slice(targetWildcard + 1)}`,
        );
        aliases.push({
          find: new RegExp(
            `^${escapeRegExp(keyPrefix)}(.+)${escapeRegExp(keySuffix)}$`,
          ),
          replacement: targetPattern.replace(wildcardPlaceholder, "$1"),
        });
        continue;
      }

      aliases.push({
        find: new RegExp(`^${escapeRegExp(packageSpecifier)}$`),
        replacement: path.resolve(packageDir, exportTarget),
      });
    }
  }
  return aliases;
}

function resolveAppPluginBrowserEntry(pkgDir: string): string | null {
  const preferred = [
    "src/ui.ts",
    "src/ui/index.ts",
    "src/register.ts",
    "src/index.ts",
  ];
  for (const relativePath of preferred) {
    const candidate = path.join(pkgDir, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createAppPluginBrowserAliases() {
  const pluginsRoot = path.resolve(elizaRoot, "plugins");
  const aliases = [];
  if (!fs.existsSync(pluginsRoot)) return aliases;

  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(pluginsRoot, entry.name);
    const pkgPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (!isAppPluginPackage("plugins", entry.name, pkg)) continue;
    const pkgName = pkg.name;
    if (typeof pkgName !== "string") continue;

    const browserEntry = resolveAppPluginBrowserEntry(pkgDir);
    if (browserEntry) {
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}$`),
        replacement: browserEntry,
      });
    }

    for (const uiEntry of ["src/ui.ts", "src/ui/index.ts"]) {
      const candidate = path.join(pkgDir, uiEntry);
      if (!fs.existsSync(candidate)) continue;
      // Match both `<pkg>/ui` and the explicit `<pkg>/ui/index` form, which the
      // package.json `./*` export maps to src/ui/index.ts. Dev builds must stay
      // on source because dist/ui/index.js is not guaranteed to exist.
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/ui(?:/index)?$`),
        replacement: candidate,
      });
      break;
    }

    const registerEntry = path.join(pkgDir, "src/register.ts");
    if (fs.existsSync(registerEntry)) {
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/register$`),
        replacement: registerEntry,
      });
    }
  }

  return aliases;
}

function resolveAppShellMetadata() {
  const branding = resolveAppBranding(appConfig);
  const themeColor = appConfig.web?.themeColor?.trim() || "#08080a";
  const backgroundColor = appConfig.web?.backgroundColor?.trim() || "#0a0a0a";
  const shareImagePath =
    appConfig.web?.shareImagePath?.trim() || "/og-image.png";
  const appUrl = ensureTrailingSlash(branding.appUrl.trim());

  return {
    appName: appConfig.appName.trim(),
    shortName: appConfig.web?.shortName?.trim() || appConfig.appName.trim(),
    description: appConfig.description.trim(),
    appUrl,
    themeColor,
    backgroundColor,
    shareImagePath,
    shareImageUrl: new URL(shareImagePath, appUrl).toString(),
  };
}

const APP_SHELL_METADATA = resolveAppShellMetadata();
const APP_ENV_PREFIX = normalizeEnvPrefix(
  appConfig.envPrefix?.trim() || appConfig.cliName.trim(),
);
const APP_NAMESPACE = appConfig.namespace?.trim() || appConfig.cliName.trim();
const BRANDED_ENV = {
  apiPort: `${APP_ENV_PREFIX}_API_PORT`,
  appSourcemap: `${APP_ENV_PREFIX}_APP_SOURCEMAP`,
  assetBaseUrl: `${APP_ENV_PREFIX}_ASSET_BASE_URL`,
  desktopFastDist: `${APP_ENV_PREFIX}_DESKTOP_VITE_FAST_DIST`,
  devPolling: `${APP_ENV_PREFIX}_DEV_POLLING`,
  hmrHost: `${APP_ENV_PREFIX}_HMR_HOST`,
  settingsDebug: `${APP_ENV_PREFIX}_SETTINGS_DEBUG`,
  ttsDebug: `${APP_ENV_PREFIX}_TTS_DEBUG`,
  viteLoopbackOrigin: `${APP_ENV_PREFIX}_VITE_LOOPBACK_ORIGIN`,
  viteOrigin: `${APP_ENV_PREFIX}_VITE_ORIGIN`,
  viteSettingsDebug: `VITE_${APP_ENV_PREFIX}_SETTINGS_DEBUG`,
};
// Mirror branded app env into ELIZA_* before the shared runtime helpers resolve ports.
syncElizaEnvAliases({
  brandedPrefix: APP_ENV_PREFIX,
  cloudManagedAgentsApiSegment: APP_NAMESPACE,
  appRoutePluginModules: DEFAULT_APP_ROUTE_PLUGIN_MODULES,
});

const NATIVE_PLUGIN_ALIAS_ENTRIES = CAPACITOR_PLUGIN_NAMES.map((name) => ({
  find: new RegExp(`^@elizaos/capacitor-${escapeRegExp(name)}$`),
  replacement: path.join(
    nativePluginsRoot,
    `${NATIVE_PLUGIN_DIR_PREFIX}${name}/src/index.ts`,
  ),
}));
const CAPACITOR_BUILD_TARGET = process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? "";
const IS_CAPACITOR_MOBILE_BUILD =
  CAPACITOR_BUILD_TARGET === "ios" || CAPACITOR_BUILD_TARGET === "android";
const IS_ANDROID_CLOUD_RENDERER_BUILD =
  CAPACITOR_BUILD_TARGET === "android" &&
  process.env.VITE_ELIZA_ANDROID_RUNTIME_MODE === "cloud";
const USE_CORE_SOURCE_BROWSER_ENTRY =
  IS_CAPACITOR_MOBILE_BUILD ||
  process.env.ELIZA_DESKTOP_VITE_FAST_DIST === "1" ||
  process.env.ELIZA_DESKTOP_VITE_BUILD_WATCH === "1";

/**
 * Returns the cleartext origins available to local and native app shells.
 * iOS store builds prohibit them; other shells support owner-selected remote
 * agents, whose REST calls use native transport while WebSockets use CSP.
 */
export function resolveAppShellLocalCspSources(
  capacitorBuildTarget: string,
  isIosStoreBuild: boolean,
  isAndroidCloudBuild = false,
): {
  localHttpSources: string;
  localConnectSources: string;
} {
  if (isIosStoreBuild || isAndroidCloudBuild) {
    return { localHttpSources: "", localConnectSources: "" };
  }

  const loopbackHttpSources = " http://localhost:* http://127.0.0.1:*";
  if (capacitorBuildTarget === "android") {
    // Paired Android shells discover the host at runtime, so its private-LAN
    // address cannot be enumerated at build time. API-base validation still
    // limits accepted cleartext hosts to loopback/private addresses, while the
    // CSP must permit the resulting REST/EventSource and WebSocket transports.
    return {
      localHttpSources: loopbackHttpSources,
      localConnectSources: " http: ws:",
    };
  }

  return {
    localHttpSources: loopbackHttpSources,
    // Remote-agent URLs are explicitly chosen by the owner and authenticated.
    // Capacitor's native HTTP bridge handles their REST traffic, while browser
    // WebSockets still pass through this CSP and must accept the same LAN host.
    localConnectSources: `${loopbackHttpSources} ws: ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:*`,
  };
}

export const ANDROID_CLOUD_FORBIDDEN_ROUTING_MARKERS =
  ANDROID_CLOUD_ROUTING_MARKERS;

type AndroidCloudAuditOutput = {
  type: "chunk" | "asset";
  code?: string;
  source?: string | Uint8Array;
};

/**
 * Fail-only audit of every text-bearing file emitted into the Android Cloud
 * renderer for concrete development routing capabilities. Cross-platform UI
 * copy and dormant mode labels are allowed because the canonical application
 * renders them on other platforms; the Cloud APK's native graph, CSP, and
 * stripped IPC bootstrap remain the capability boundary.
 */
export function findAndroidCloudEmittedRoutingFindings(
  bundle: Record<string, AndroidCloudAuditOutput>,
): string[] {
  const findings: string[] = [];
  for (const [fileName, output] of Object.entries(bundle)) {
    const content =
      output.type === "chunk"
        ? output.code
        : typeof output.source === "string"
          ? output.source
          : output.source instanceof Uint8Array
            ? new TextDecoder().decode(output.source)
            : undefined;
    if (!content) continue;
    for (const marker of findAndroidCloudRoutingMarkers(content)) {
      findings.push(`${fileName}: ${marker}`);
    }
  }
  return findings.sort();
}

function androidCloudRendererPolicyPlugin(): Plugin {
  return {
    name: "android-cloud-renderer-policy",
    enforce: "pre",
    generateBundle(_options, bundle) {
      if (!IS_ANDROID_CLOUD_RENDERER_BUILD) return;
      const findings = findAndroidCloudEmittedRoutingFindings(bundle);
      if (findings.length > 0) {
        throw new Error(
          `Android Cloud renderer contains forbidden local routing markers:\n${findings
            .sort()
            .map((finding) => `  - ${finding}`)
            .join("\n")}`,
        );
      }
    },
  };
}

const ANDROID_CLOUD_CURATED_PUBLIC_ASSETS = Object.freeze([
  "THIRD_PARTY_NOTICES.txt",
  "bg-sunset.webp",
  "wallpapers/canopy.webp",
  "wallpapers/dusk-dunes.webp",
  "wallpapers/ember-dunes.webp",
  "wallpapers/reef.webp",
  "wallpapers/slate.webp",
]);

function readAndroidCloudCuratedAssets(): Array<{
  type: "asset";
  fileName: string;
  source: Buffer;
}> {
  return ANDROID_CLOUD_CURATED_PUBLIC_ASSETS.map((fileName) => ({
    type: "asset" as const,
    fileName,
    source: fs.readFileSync(path.join(here, "public", fileName)),
  }));
}

/**
 * Packages the canonical app's selectable backgrounds without copying the
 * browser public tree, whose service workers, installers, and local task
 * runner are not capabilities of the Cloud-only Android application.
 */
export function androidCloudCuratedAssetsPlugin(
  androidCloudBuild = IS_ANDROID_CLOUD_RENDERER_BUILD,
): Plugin {
  return {
    name: "android-cloud-curated-assets",
    generateBundle() {
      if (!androidCloudBuild) return;
      for (const asset of readAndroidCloudCuratedAssets()) {
        this.emitFile(asset);
      }
    },
  };
}

/** Viewport policies selected by the app-shell metadata transform. */
export const VIEWPORT_META_NATIVE =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
export const VIEWPORT_META_WEB =
  "width=device-width, initial-scale=1.0, viewport-fit=cover";

const NATIVE_AGENT_IPC_BRIDGE_BLOCK =
  /\s*<!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_START -->[\s\S]*?<!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_END -->\s*/;

/**
 * Removes the native local-agent fetch shim and its CSP scheme from the
 * standard Android Cloud renderer. Direct Android and iOS builds retain the
 * bridge unchanged.
 */
export function stripAndroidCloudIpcBootstrap(html: string): string {
  const withoutBridge = html.replace(NATIVE_AGENT_IPC_BRIDGE_BLOCK, "\n");
  return withoutBridge.replace(
    /(connect-src\s[^;]*?)\s+eliza-local-agent:/,
    "$1",
  );
}

/** Removes browser-only assets whose public tree is not packaged. */
export function stripAndroidCloudPublicAssetReferences(
  html: string,
  prebootLockupDataUri = resolveAndroidCloudPrebootLockupDataUri(),
): string {
  return html
    .replace(
      /\s*<link\b[^>]*\brel=["'](?:icon|apple-touch-icon|manifest)["'][^>]*>\s*/gi,
      "\n",
    )
    .replace(
      /<img\b[^>]*\bclass=["'][^"']*\beliza-preboot-shell__mark\b[^"']*["'][^>]*>\s*<span\b[^>]*\bclass=["'][^"']*\beliza-preboot-shell__name\b[^"']*["'][^>]*>[^<]*<\/span>/gi,
      `<img class="eliza-preboot-shell__lockup" src="${prebootLockupDataUri}" alt="" decoding="sync" fetchpriority="high" />`,
    )
    .replace(
      /\s*<img\b[^>]*\bclass=["'][^"']*\beliza-preboot-shell__mark\b[^"']*["'][^>]*>\s*/gi,
      "\n",
    );
}

const DEFAULT_RENDERER_ENTRY = "/src/entry.ts";

/**
 * Keeps the canonical application renderer for Android Cloud builds. Play
 * policy is enforced at the native capability and emitted-artifact boundaries;
 * it must not fork the user-facing application into a second product shell.
 */
export function selectAndroidCloudRendererEntry(
  html: string,
  androidCloudBuild: boolean,
): string {
  if (!androidCloudBuild) return html;
  if (!html.includes(DEFAULT_RENDERER_ENTRY)) {
    throw new Error(
      `Android Cloud HTML is missing the expected ${DEFAULT_RENDERER_ENTRY} module entry`,
    );
  }
  return html;
}

/** Runs before Vite discovers HTML module imports, enforcing graph isolation. */
export function androidCloudRendererEntryPlugin(
  androidCloudBuild = IS_ANDROID_CLOUD_RENDERER_BUILD,
): Plugin {
  return {
    name: "android-cloud-renderer-entry",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return selectAndroidCloudRendererEntry(html, androidCloudBuild);
      },
    },
  };
}

/** Creates the metadata transform; the target override keeps build-mode tests exact. */
export function appShellMetadataPlugin(
  options: {
    androidCloudBuild?: boolean;
    capacitorBuildTarget?: string;
    resolveAndroidCloudPrebootLockup?: () => string;
  } = {},
): Plugin {
  const capacitorBuildTarget =
    options.capacitorBuildTarget ?? CAPACITOR_BUILD_TARGET;
  const isCapacitorMobileBuild =
    capacitorBuildTarget === "ios" || capacitorBuildTarget === "android";
  const isIosStoreBuild =
    capacitorBuildTarget === "ios" &&
    (process.env.ELIZA_BUILD_VARIANT === "store" ||
      process.env.ELIZA_RELEASE_AUTHORITY === "apple-app-store");
  const isAndroidCloudBuild =
    options.androidCloudBuild ??
    (capacitorBuildTarget === "android" &&
      process.env.VITE_ELIZA_ANDROID_RUNTIME_MODE === "cloud");
  const { localHttpSources, localConnectSources } =
    resolveAppShellLocalCspSources(
      capacitorBuildTarget,
      isIosStoreBuild,
      isAndroidCloudBuild,
    );
  const manifest = `${JSON.stringify(
    {
      name: APP_SHELL_METADATA.appName,
      short_name: APP_SHELL_METADATA.shortName,
      icons: [
        {
          src: "/brand/favicons/android-chrome-192x192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "/brand/favicons/android-chrome-512x512.png",
          sizes: "512x512",
          type: "image/png",
        },
      ],
      theme_color: APP_SHELL_METADATA.themeColor,
      background_color: APP_SHELL_METADATA.backgroundColor,
      display: "standalone",
    },
    null,
    2,
  )}\n`;

  const replacements = new Map<string, string>([
    ["__APP_NAME__", APP_SHELL_METADATA.appName],
    ["__APP_DESCRIPTION__", APP_SHELL_METADATA.description],
    ["__APP_URL__", APP_SHELL_METADATA.appUrl],
    ["__APP_SHARE_IMAGE__", APP_SHELL_METADATA.shareImageUrl],
    ["__APP_THEME_COLOR__", APP_SHELL_METADATA.themeColor],
    ["__APP_CSP_LOCAL_HTTP__", localHttpSources],
    ["__APP_CSP_LOCAL_CONNECT__", localConnectSources],
    [
      "__APP_VIEWPORT_CONTENT__",
      isCapacitorMobileBuild ? VIEWPORT_META_NATIVE : VIEWPORT_META_WEB,
    ],
  ]);

  return {
    name: "app-shell-metadata",
    transformIndexHtml(html) {
      let next = html;
      for (const [token, value] of replacements) {
        next = next.replaceAll(token, value);
      }
      if (isAndroidCloudBuild) {
        next = stripAndroidCloudIpcBootstrap(next);
        next = stripAndroidCloudPublicAssetReferences(
          next,
          (
            options.resolveAndroidCloudPrebootLockup ??
            resolveAndroidCloudPrebootLockupDataUri
          )(),
        );
      }
      return next;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/site.webmanifest") {
          next();
          return;
        }

        res.setHeader(
          "Content-Type",
          "application/manifest+json; charset=utf-8",
        );
        res.end(manifest);
      });
    },
    generateBundle() {
      if (isAndroidCloudBuild) return;
      this.emitFile({
        type: "asset",
        fileName: "site.webmanifest",
        source: manifest,
      });
    },
  };
}

/**
 * Serves the live current/proposed view comparison only from Vite dev.
 * Keeping review assets outside public/ prevents them from becoming
 * production root endpoints while preserving the local review URL.
 */
export function devViewStudioPlugin(): Plugin {
  const assetRoot = path.join(here, "test", "design-review", "view-studio");
  const assets: ReadonlyMap<string, readonly [string, string]> = new Map([
    ["/eliza-view-studio.html", ["eliza-view-studio.html", "text/html"]],
    ["/eliza-view-studio.css", ["eliza-view-studio.css", "text/css"]],
    ["/eliza-view-studio.js", ["eliza-view-studio.js", "text/javascript"]],
    ["/eliza-proposed-theme.css", ["eliza-proposed-theme.css", "text/css"]],
  ]);

  return {
    name: "eliza-dev-view-studio",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        const asset = assets.get(pathname);
        if (!asset) {
          next();
          return;
        }
        res.setHeader("Content-Type", `${asset[1]}; charset=utf-8`);
        res.setHeader("Cache-Control", "no-store");
        res.end(fs.readFileSync(path.join(assetRoot, asset[0])));
      });
    },
  };
}

function productionBuildStampGuardPlugin(): Plugin {
  let viteProductionBuild = false;
  const shouldRemoveStamp = () =>
    shouldSkipBuildStamp(process.env, { viteProductionBuild });

  return {
    name: "eliza-production-build-stamp-guard",
    configResolved(config) {
      viteProductionBuild =
        config.command === "build" && config.mode === "production";
    },
    buildStart() {
      if (!shouldRemoveStamp()) return;
      removePublicBuildStamp(here);
    },
    generateBundle(_options, bundle) {
      if (!shouldRemoveStamp()) return;
      removeEmittedBuildStamp(bundle);
    },
  };
}

/**
 * Fails any production-mode build in which a forced host-mode escape hatch
 * (VITE_FORCE_APP_MODE / VITE_FORCE_APEX_CONSOLE) is set. The flags override
 * the app-mode and apex hostname checks for EVERY host, so a Pages deploy that
 * carries one silently turns the elizacloud.ai apex into the forced surface —
 * this guard makes that misconfiguration fail loudly at build time instead.
 * The production/staging Pages builds (cloud-cf-deploy.yml) run plain
 * `vite build` (mode "production"), so both are covered; `vite dev` and
 * development-mode bundles keep the escape hatch.
 */
function forcedHostModeFlagGuardPlugin(): Plugin {
  return {
    name: "eliza-forced-host-mode-flag-guard",
    configResolved(config) {
      if (config.command !== "build" || config.mode !== "production") return;
      // loadEnv covers `.env*` files as well as process.env.
      const offending = forbiddenForcedHostModeFlags(
        loadEnv(config.mode, config.envDir, "VITE_FORCE_"),
      );
      if (offending.length > 0) {
        throw new Error(
          `${offending.join(", ")} must not be set in a production-mode build: ` +
            "the forced host-mode flags override the app-mode/apex hostname " +
            "checks for every host, so a deployed bundle with one baked in " +
            "hijacks the elizacloud.ai apex. Remove the flag from the deploy " +
            "config (cloud-cf-deploy.yml / wrangler.toml); to test a built " +
            "bundle with the flag locally, build with --mode development.",
        );
      }
    },
  };
}

/**
 * Pinned @elizaos/core from the repo root (must match the agent/runtime lock).
 */
function getPinnedElizaCoreVersion(): string {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(elizaRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const spec =
      raw.dependencies?.["@elizaos/core"] ??
      raw.overrides?.["@elizaos/core"] ??
      "";
    const v = String(spec)
      .trim()
      .replace(/^[\^~]/, "");
    if (v && v !== "workspace:*" && /^\d/.test(v)) {
      const first = v.split(/\s+/)[0];
      if (first) return first;
    }
  } catch {
    /* fall through */
  }
  return "2.0.0-beta.0";
}

/** Bun cache dir names look like `@elizaos+core@2.0.0-beta.0+<hash>`. */
function elizaCoreBetaPrerelease(dir: string): number {
  const m = dir.match(/@elizaos\+core@[\d.]+-beta\.(\d+)/);
  return m?.[1] ? parseInt(m[1], 10) : -1;
}

function resolveExistingTsSourceModule(id: string): string {
  if (fs.existsSync(id)) {
    try {
      if (!fs.statSync(id).isDirectory()) {
        return id;
      }
    } catch {
      return id;
    }
  }

  const candidates = [
    `${id}.ts`,
    `${id}.tsx`,
    path.join(id, "index.ts"),
    path.join(id, "index.tsx"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? id;
}

function resolveSharedSourceExportTarget(
  sharedPkgDir: string,
  key: string,
  value: unknown,
): string | null {
  if (key === ".") {
    return path.join(sharedPkgDir, "src/index.ts");
  }

  const exportTarget = resolvePackageExportTarget(value);
  if (!exportTarget) return null;

  const sourceRelative = exportTarget
    .replace(/^\.\//, "")
    .replace(/^dist\//, "")
    .replace(/\.js$/, "");
  return resolveExistingTsSourceModule(
    path.join(sharedPkgDir, "src", sourceRelative),
  );
}

/**
 * Bun stores a full npm tarball under node_modules/.bun even when the workspace
 * symlink for @elizaos/core points at an unbuilt local eliza checkout.
 *
 * **WHY sort:** `readdir` order is arbitrary; picking `beta.0` over a later beta
 * mismatches the API and tends to blank the Electrobun webview.
 */
function findElizaCoreBundleInBunStore(
  kind: "browser" | "node",
): string | null {
  const bunDir = path.join(elizaRoot, "node_modules/.bun");
  const rel =
    kind === "browser"
      ? "node_modules/@elizaos/core/dist/browser/index.browser.js"
      : "node_modules/@elizaos/core/dist/node/index.node.js";
  if (!fs.existsSync(bunDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(bunDir);
  } catch {
    return null;
  }
  const pinned = getPinnedElizaCoreVersion();
  const pinnedPrefix = `@elizaos+core@${pinned}+`;

  const withDist = entries.filter((dir) => {
    if (!dir.startsWith("@elizaos+core@")) return false;
    return fs.existsSync(path.join(bunDir, dir, rel));
  });

  const pinnedMatch = withDist.find((d) => d.startsWith(pinnedPrefix));
  if (pinnedMatch) return path.join(bunDir, pinnedMatch, rel);

  if (withDist.length === 0) return null;

  withDist.sort(
    (a, b) => elizaCoreBetaPrerelease(b) - elizaCoreBetaPrerelease(a),
  );
  const best = withDist[0];
  return best ? path.join(bunDir, best, rel) : null;
}

function normalizeModuleId(id: string | undefined): string {
  return (id ?? "").split(path.sep).join("/");
}

function tryResolveElizaCorePkgDir(): string | null {
  try {
    return path.dirname(_require.resolve("@elizaos/core/package.json"));
  } catch {
    const workspaceCorePkg = path.join(elizaRoot, "packages/core/package.json");
    return fs.existsSync(workspaceCorePkg)
      ? path.dirname(workspaceCorePkg)
      : null;
  }
}

function resolveElizaCoreSourceBrowserPath(): string | null {
  const workspaceSourceBrowserEntry = path.join(
    elizaRoot,
    "packages/core/src/index.browser.ts",
  );
  if (fs.existsSync(workspaceSourceBrowserEntry)) {
    return workspaceSourceBrowserEntry;
  }

  const pkgDir = tryResolveElizaCorePkgDir();
  if (!pkgDir) return null;
  const sourceBrowserEntry = path.join(pkgDir, "src/index.browser.ts");
  return fs.existsSync(sourceBrowserEntry) ? sourceBrowserEntry : null;
}

function isElizaCoreBrowserDistId(id: string | undefined): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.endsWith("/node_modules/@elizaos/core/dist/index.browser.js") ||
    normalized.endsWith(
      "/node_modules/@elizaos/core/dist/browser/index.browser.js",
    ) ||
    normalized.endsWith("/eliza/packages/core/dist/index.browser.js") ||
    normalized.endsWith("/eliza/packages/core/dist/browser/index.browser.js")
  );
}

/**
 * Resolved file path for bundling `@elizaos/core` in the renderer.
 *
 * Prefer the pre-built `dist/browser/index.browser.js` BUNDLE: one browser-safe
 * artifact (single request, single parse, node: builtins already stripped). The
 * browser SOURCE entry (`src/index.browser.ts`) is the fallback ONLY when no
 * build exists yet (a fresh linked checkout before `bun run build`).
 *
 * Why this order matters: the source entry transitively pulls 400+ individual
 * core source modules, so the renderer paid 400+ HTTP round-trips + on-demand
 * TS transforms AND tried to evaluate core's node:async_hooks / node:fs imports
 * in the browser — minute-long cold loads that frequently never mounted.
 * Serving the one pre-built bundle avoids all of that. The bundle is rebuilt by
 * `bun run build` (and the desktop build watch), so the only thing traded is
 * HMR on the runtime, which the renderer almost never edits.
 */
function resolveElizaCoreBundlePath(): string {
  // Mobile and live-stack build-watch lanes run Vite over a freshly built app;
  // use source there so esbuild never re-transforms the core browser bundle.
  if (USE_CORE_SOURCE_BROWSER_ENTRY) {
    const sourceBrowserEntry = resolveElizaCoreSourceBrowserPath();
    if (sourceBrowserEntry) return sourceBrowserEntry;
  }

  const pkgDir = tryResolveElizaCorePkgDir();
  if (pkgDir) {
    const browserEntry = path.join(pkgDir, "dist/browser/index.browser.js");
    const nodeEntry = path.join(pkgDir, "dist/node/index.node.js");
    const rootBrowserEntry = path.join(pkgDir, "dist/index.browser.js");
    const rootNodeEntry = path.join(pkgDir, "dist/index.node.js");
    const hasBrowserShimTarget = fs.existsSync(browserEntry);
    const hasNodeShimTarget = fs.existsSync(nodeEntry);
    if (fs.existsSync(browserEntry)) return browserEntry;
    if (fs.existsSync(rootBrowserEntry) && hasBrowserShimTarget)
      return rootBrowserEntry;
    if (fs.existsSync(nodeEntry)) {
      console.warn(
        "[eliza][vite] @elizaos/core dist/browser is missing; using dist/node for the client bundle. " +
          "For a linked eliza workspace, run `bun run build` in that checkout (e.g. packages/core). " +
          "Or reinstall with ELIZA_SKIP_LOCAL_ELIZA=1 to use the published npm package.",
      );
      return nodeEntry;
    }
    if (fs.existsSync(rootNodeEntry) && hasNodeShimTarget) {
      console.warn(
        "[eliza][vite] @elizaos/core dist/browser is missing; using dist/index.node.js for the client bundle. " +
          "This usually means the local core workspace only has a flat dist/ build artifact.",
      );
      return rootNodeEntry;
    }
  }
  const bunBrowser = findElizaCoreBundleInBunStore("browser");
  if (bunBrowser) {
    console.warn(
      `[eliza][vite] @elizaos/core not resolvable from packages/app${pkgDir ? ` (pkgDir=${pkgDir} has no dist/)` : ""}; using bun cache build at ${bunBrowser}. ` +
        "Run `bun run build` in your eliza checkout or ELIZA_SKIP_LOCAL_ELIZA=1 bun install to align versions.",
    );
    return bunBrowser;
  }
  const bunNode = findElizaCoreBundleInBunStore("node");
  if (bunNode) {
    console.warn(
      `[eliza][vite] @elizaos/core not resolvable from packages/app${pkgDir ? ` (pkgDir=${pkgDir})` : ""}; using bun cache node bundle at ${bunNode}.`,
    );
    return bunNode;
  }
  // Last resort: no built artifact anywhere. Fall back to the browser SOURCE
  // entry so a fresh linked checkout (before `bun run build`) still boots,
  // accepting the slow source-graph load until a build exists.
  const sourceBrowserEntry = resolveElizaCoreSourceBrowserPath();
  if (sourceBrowserEntry) {
    console.warn(
      "[eliza][vite] @elizaos/core has no built dist/; falling back to the browser SOURCE entry " +
        "(src/index.browser.ts). This pulls the full core source graph and is slow — run `bun run build` " +
        "in your eliza checkout to serve the pre-built browser bundle instead.",
    );
    return sourceBrowserEntry;
  }
  throw new Error(
    `[eliza][vite] @elizaos/core has no built artifacts${pkgDir ? ` under ${pkgDir}` : " (not resolvable from packages/app)"} and none in node_modules/.bun. ` +
      "Expected src/index.browser.ts, dist/browser/index.browser.js, dist/index.browser.js, dist/node/index.node.js, or dist/index.node.js. " +
      "Build your local eliza workspace or run `ELIZA_SKIP_LOCAL_ELIZA=1 bun install`.",
  );
}

/**
 * Some linked @elizaos/core workspaces have a flat dist/index.browser.js shim
 * even when dist/browser/index.browser.js was never emitted. If anything in the
 * dependency graph resolves that shim directly, redirect it to the best browser
 * entry so Vite never follows the missing relative import.
 */
function elizaCoreBrowserEntryFallbackPlugin(): Plugin {
  return {
    name: "eliza-core-browser-entry-fallback",
    enforce: "pre",
    resolveId(id, importer) {
      const browserEntry = resolveElizaCoreBundlePath();
      if (isElizaCoreBrowserDistId(id)) return browserEntry;
      if (
        id === "./browser/index.browser.js" &&
        isElizaCoreBrowserDistId(importer)
      ) {
        return browserEntry;
      }
      return null;
    },
  };
}

// The dev script sets the branded API port env; default to 31337 for standalone vite dev.
const apiPort = resolveDesktopApiPort(process.env);
const uiPort = resolveDesktopUiPort(process.env);
const localVoiceGatewayPort = resolveOptionalLocalVoiceGatewayPort(
  process.env.ELIZA_LOCAL_VOICE_GATEWAY_PORT,
);
const viteDevServerRuntime = resolveViteDevServerRuntime(
  process.env,
  uiPort,
  APP_ENV_PREFIX,
);
const enableAppSourceMaps = process.env[BRANDED_ENV.appSourcemap] === "1";
/** Set by eliza/packages/app-core/scripts/dev-platform.mjs for `vite build --watch` (Electrobun desktop). */
const desktopFastDist = process.env[BRANDED_ENV.desktopFastDist] === "1";

function resolveOptionalLocalVoiceGatewayPort(
  raw: string | undefined,
): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "ELIZA_LOCAL_VOICE_GATEWAY_PORT must be an integer TCP port",
    );
  }
  return port;
}

/**
 * A configured loopback voice gateway is an explicit local-development opt-in
 * to the realtime voice stack. Keep deployed builds staged behind their
 * existing flags, while making the supported local gateway command sufficient
 * to enable both the staged realtime client and its self-hosted eligibility
 * path. The eligibility path still requires a paired remote runtime and a live
 * same-origin health probe. The force flag stays an explicit diagnostic bypass,
 * so a failed capability check remains visible. Explicit client flag values
 * always win, including an explicit opt-out.
 */
export function resolveLocalRealtimeVoiceDefines(
  command: string,
  gatewayPort: number | null,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (command !== "serve" || gatewayPort === null) return {};

  const defines: Record<string, string> = {};
  if (env.VITE_VOICE_REALTIME_WS === undefined) {
    defines["import.meta.env.VITE_VOICE_REALTIME_WS"] = JSON.stringify("1");
  }
  if (env.VITE_VOICE_REALTIME_SELF_HOSTED === undefined) {
    defines["import.meta.env.VITE_VOICE_REALTIME_SELF_HOSTED"] =
      JSON.stringify("1");
  }
  return defines;
}

export function resolveLocalRealtimeVoiceDefinesFromEnv(
  command: string,
  mode: string,
  gatewayPort: number | null,
  envDir: string,
): Record<string, string> {
  return resolveLocalRealtimeVoiceDefines(
    command,
    gatewayPort,
    loadEnv(mode, envDir, "VITE_VOICE_REALTIME_"),
  );
}

export function appDevWsBasePlugin(): Plugin {
  const brandedWsBaseKey = `__${APP_ENV_PREFIX}_WS_BASE__`;

  // The browser must dial the origin it actually loaded, because tunneled
  // development exposes the Vite port without exposing the API loopback port.
  // Vite proxies the resulting same-origin `/ws` upgrade to the API alongside
  // its `/api` proxy, while packaged builds supply their own runtime base.
  const wsBaseExpr =
    "((location.protocol==='https:'?'wss://':'ws://')+location.host)";

  return {
    name: "eliza-dev-ws-base",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "text/javascript" },
          injectTo: "head-prepend",
          children: [
            `window.__ELIZA_WS_BASE__ = ${wsBaseExpr};`,
            `window.__ELIZAOS_WS_BASE__ = ${wsBaseExpr};`,
            `window[${JSON.stringify(brandedWsBaseKey)}] = ${wsBaseExpr};`,
          ].join("\n"),
        },
      ];
    },
  };
}

// Crypto / big-number graph (bn.js, elliptic, secp256k1, the hash + cipher
// libs, and the `buffer` polyfill they call into). Matched FIRST so it wins
// over the generic vendor groups below. This graph MUST stay in its own
// lazily-loaded chunk: Rollup's recursive dep-inclusion otherwise
// non-deterministically folds it into an eagerly-initialized app chunk (e.g.
// the date-fns `en_US` i18n locale chunk, or the entry), where bn.js runs
// `Buffer.allocUnsafe` at module-init before the chunk's CJS Buffer wrapper is
// hoisted — throwing "Class constructor cannot be invoked without 'new'" and
// blanking the whole React tree on every route. `scripts/verify-chunk-
// safety.mjs` gates the deploy against any regression of this pin.
const VENDOR_CRYPTO_TEST =
  /\/node_modules\/(bn\.js|elliptic|secp256k1|@noble\/[^/]+|hash-base|create-hash|create-hmac|create-ecdh|browserify-sign|browserify-aes|browserify-cipher|browserify-rsa|diffie-hellman|asn1\.js|des\.js|ripemd160|sha\.js|md5\.js|hash\.js|cipher-base|evp_bytestokey|pbkdf2|public-encrypt|randombytes|randomfill|miller-rabin|brorand|hmac-drbg|minimalistic-crypto-utils|minimalistic-assert|safe-buffer|buffer)(\/|$)/;

// EVM wallet stack (wagmi/viem/RainbowKit/WalletConnect/Reown/Coinbase). Folded
// into `vendor-crypto` alongside the crypto core (see resolveManualChunk): the
// wallet stack imports the bn.js/buffer graph, so a separate chunk would cross-
// import the crypto chunk and form an init-order cycle (the wagmi 3.x `connect`
// / `ConnectorUnavailableReconnectingError` TDZ crash).
const VENDOR_WALLET_TEST =
  /\/node_modules\/(wagmi|@wagmi\/[^/]+|viem|@rainbow-me\/[^/]+|@walletconnect\/[^/]+|@reown\/[^/]+|@coinbase\/wallet[^/]*|mipd|eventemitter3)(\/|$)/;

// Solana wallet/web3 stack — also folded into `vendor-crypto` (it imports the
// same bn.js/buffer core).
const VENDOR_SOLANA_TEST = /\/node_modules\/@solana\//;

// React runtime + scheduler + platform-neutral react-spring packages. The
// three renderer is routed with the three.js graph below; grouping it with the
// eager React runtime would make vendor-react import vendor-three at boot.
const VENDOR_REACT_TEST =
  /\/node_modules\/(react|react-dom|react-is|scheduler|@react-spring)(\/|$)/;
const VENDOR_REACT_SPRING_THREE_TEST =
  /\/node_modules\/@react-spring\/three(\/|$)/;

// three.js (three.module, three.webgpu, three.tsl, three.core, three/examples,
// three/addons) + @pixiv/three-vrm collapsed into one shared async chunk to
// avoid cross-chunk TDZ init ordering bugs with WebGPU/TSL enums (see
// fix/three-chunk-tdz) and to keep three out of the eager entry chunk.
const VENDOR_VRM_TEST = /\/node_modules\/@pixiv\/three-vrm\//;
const VENDOR_THREE_TEST = /\/node_modules\/three\//;
const VENDOR_DRACO_TEST = /\/node_modules\/draco3d(gltf)?\//;

/**
 * Rollup `output.manualChunks`. `@elizaos/vitest-vite` builds with classic
 * Rollup (`rollup@^4`), whose only manual-chunking API is this function form —
 * NOT rolldown's `advancedChunks` / `codeSplitting` (Rollup ignores those keys).
 * Crucially, this must live under `build.rollupOptions.output` — the only
 * bundle-options key Vite reads; the prior `build.rolldownOptions.output`
 * placement was silently ignored by Vite, so NO `vendor-*` chunks emitted and
 * the bn.js graph folded into the eager `en_US` locale chunk (#9150). The
 * crypto/wallet/solana graph is matched first and collapsed into one lazy
 * `vendor-crypto` chunk so it can never co-bundle with an eager chunk.
 */
function resolveManualChunk(id: string): string | undefined {
  const normalizedId = id.split(path.sep).join("/");
  // A global vendor stylesheet must not make its JavaScript chunk eager.
  // Vite extracts CSS independently; these groups only own executable modules.
  if (/\.css(?:\?|$)/.test(normalizedId)) return undefined;

  // Build-generated leaf shims shared by the eager entry graph AND the pinned
  // vendor-crypto graph: Vite's dynamic-import preload helper, the node-builtin
  // browser stubs, and the buffer ESM shim. All are self-contained (no
  // imports), so they can never form a cross-chunk cycle. Without an explicit
  // assignment, Rollup FOLDS them into `vendor-crypto` (a pinned module's
  // unassigned dependencies join the manual chunk), and any eager module that
  // needs one — e.g. @elizaos/core's browser bundle importing the buffer shim,
  // or any dynamic-importing entry module needing the preload helper — then
  // statically imports the whole multi-MB wallet chunk at boot. The eagerness
  // guard in scripts/verify-chunk-safety.mjs fails the build on that regression.
  if (
    normalizedId.includes("vite/preload-helper") ||
    normalizedId.includes("native-stub:") ||
    normalizedId.includes(BUFFER_ESM_SHIM_ID) ||
    normalizedId.includes("/src/shims/use-sync-external-store")
  ) {
    return "runtime-shims";
  }

  // The baked launcher-icon map (`view-icons.generated.ts`) is ~900 KB of
  // base64 PNG data URIs — a self-contained data blob (no imports) that the
  // launcher preloads so tiles never show a loading/empty state. It is
  // statically reachable from the eager entry (App → LauncherSurface →
  // view-catalog → this map), so Rollup otherwise folds all ~630 KB brotli of
  // it into the app-logic `index` entry chunk, making that single chunk the
  // largest in the bundle and blowing the `largestChunkBrotli` budget. Pinning
  // it to its own chunk keeps the icons eagerly preloaded (design intent
  // preserved) while splitting the immutable data payload off the frequently-
  // changing app-logic chunk, so it caches independently and no longer
  // dominates the entry. Mirrors the vendor-* splits below.
  if (normalizedId.includes("/components/views/view-icons.generated")) {
    return "view-icons";
  }

  // Self-contained leaf libraries needed EAGERLY by the app/core graph and
  // also by the pinned wallet stack. Without an explicit assignment the
  // manual-chunk fold captures them into `vendor-crypto`, anchoring the whole
  // wallet chunk into the entry's static import closure. They import nothing
  // outside themselves, so the vendor-crypto → vendor-boot-leaves edge cannot
  // form the cross-chunk init cycle the crypto pin guards against.
  if (
    normalizedId.includes("/node_modules/@noble/") ||
    /\/node_modules\/(uuid|zod|clsx|eventemitter3)\//.test(normalizedId) ||
    /\/node_modules\/(bs58|base-x)\/src\/esm\//.test(normalizedId)
  ) {
    return "vendor-boot-leaves";
  }

  // Dialog scroll locks and query state are shared with wallet modals. Keep
  // their React-only support graph outside the wallet chunk so opening the app
  // does not load every wallet adapter. Older CommonJS base-x stays with crypto
  // because it imports safe-buffer; only the ESM codec is a boot leaf above.
  if (
    /\/node_modules\/@tanstack\/(react-query|query-core)\//.test(
      normalizedId,
    ) ||
    /\/node_modules\/(react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|detect-node-es)\//.test(
      normalizedId,
    )
  ) {
    return "vendor-ui-support";
  }

  if (VENDOR_OPTIMIZED_WALLET_TEST.test(normalizedId)) {
    return "vendor-crypto";
  }

  if (normalizedId.includes("/node_modules/")) {
    // Crypto + EVM-wallet + Solana collapse into ONE lazy `vendor-crypto`
    // chunk. They are the same logical wallet/crypto graph (the wallet and
    // solana stacks both import the bn.js/buffer core), so splitting them into
    // sibling chunks makes Rollup emit cross-chunk import cycles
    // (vendor-crypto -> vendor-solana -> vendor-crypto), and a cross-chunk
    // cycle is exactly the TDZ / module-init-order hazard this pin exists to
    // prevent. Co-bundling keeps the whole graph (and its Buffer polyfill) in a
    // single chunk that initializes atomically, lazily, off the eager entry.
    if (
      VENDOR_CRYPTO_TEST.test(normalizedId) ||
      VENDOR_WALLET_TEST.test(normalizedId) ||
      VENDOR_SOLANA_TEST.test(normalizedId)
    ) {
      return "vendor-crypto";
    }
  }

  // The lucide-per-icon-imports plugin rewrites every `import { X } from
  // "lucide-react"` to a deep `lucide-react/dist/esm/icons/<file>.mjs` import,
  // and redirects the runtime registry's dynamic `import("lucide-react")` to a
  // virtual barrel that re-exports only the used icons. Each icon module is its
  // own ES module, so without a grouping rule Rollup emits one tiny chunk per
  // icon. Collapse the used icons + their shared `createLucideIcon` helper + the
  // virtual barrel's re-export entry into a single chunk; the full barrel is
  // never imported, so the unused icons never enter the graph.
  if (
    normalizedId.includes("/lucide-react/dist/esm/icons/") ||
    normalizedId.includes("/lucide-react/dist/esm/createLucideIcon.mjs") ||
    normalizedId.includes(LUCIDE_USED_BARREL_ID) ||
    normalizedId.includes("/lucide-react/")
  ) {
    return "vendor-lucide";
  }

  // Phonemizer (eSpeak NG WASM, ~1.3MB) is dynamically imported through the
  // kokoro `phonemizer.ts` adapter (packages/shared/.../kokoro/phonemizer.ts).
  // Because that adapter is the dynamic-import boundary, Rollup otherwise emits
  // a second async chunk auto-named "phonemizer" and inlines its own copy of the
  // npm package — shipping eSpeak NG twice (a "phonemizer" chunk *and* a
  // "vendor-phonemizer" chunk). Routing BOTH the npm package and the adapter
  // source to one chunk collapses them into a single ~650KB (brotli) chunk.
  if (
    normalizedId.includes("/phonemizer/") ||
    normalizedId.includes("/kokoro/phonemizer")
  ) {
    return "vendor-phonemizer";
  }

  if (normalizedId.includes("/node_modules/")) {
    if (VENDOR_REACT_SPRING_THREE_TEST.test(normalizedId)) {
      return "vendor-three";
    }
    if (VENDOR_REACT_TEST.test(normalizedId)) return "vendor-react";
    if (VENDOR_VRM_TEST.test(normalizedId)) return "vendor-vrm";
    if (VENDOR_THREE_TEST.test(normalizedId)) return "vendor-three";
    if (VENDOR_DRACO_TEST.test(normalizedId)) return "vendor-draco";
  }

  return undefined;
}

/**
 * Dev-only middleware that handles CORS for the desktop custom-scheme origin
 * (electrobun://-). Vite's proxy doesn't reliably forward CORS headers
 * for non-http origins, so we intercept preflight OPTIONS requests and tag
 * every /api response with the correct headers before the proxy layer.
 */
function envFlagEffective(name: string): "on" | "off" {
  return process.env[name] === "1" ? "on" : "off";
}

function envFlagSource(name: string, whenOn = "1"): string {
  const v = process.env[name]?.trim();
  if (v === whenOn || (whenOn === "1" && v === "true"))
    return `env set — ${name}=${v}`;
  return `default (unset — off)`;
}

function buildViteDevSettingsRows(
  mode: "dev-server" | "build-watch",
): DevSettingsRow[] {
  const apiPref = resolveDesktopApiPortPreference(process.env);
  const uiPref = resolveDesktopUiPortPreference(process.env);
  const apiPort = resolveDesktopApiPort(process.env);
  const uiPort = resolveDesktopUiPort(process.env);
  const assetBase =
    process.env.VITE_ASSET_BASE_URL?.trim() ||
    process.env[BRANDED_ENV.assetBaseUrl]?.trim() ||
    "—";

  return [
    {
      setting: BRANDED_ENV.appSourcemap,
      effective: envFlagEffective(BRANDED_ENV.appSourcemap),
      source: envFlagSource(BRANDED_ENV.appSourcemap),
      change: `export ${BRANDED_ENV.appSourcemap}=1 to enable; unset for off`,
    },
    {
      setting: BRANDED_ENV.desktopFastDist,
      effective: envFlagEffective(BRANDED_ENV.desktopFastDist),
      source: envFlagSource(BRANDED_ENV.desktopFastDist),
      change:
        "set by dev orchestrator for Rollup watch; unset for normal dev server",
    },
    {
      setting: BRANDED_ENV.ttsDebug,
      effective: process.env[BRANDED_ENV.ttsDebug]?.trim() ? "set" : "—",
      source: process.env[BRANDED_ENV.ttsDebug]?.trim()
        ? `env set — ${BRANDED_ENV.ttsDebug}`
        : "default (unset)",
      change: `export ${BRANDED_ENV.ttsDebug}=1 for TTS trace logs`,
    },
    {
      setting: `${BRANDED_ENV.settingsDebug} / ${BRANDED_ENV.viteSettingsDebug}`,
      effective:
        process.env[BRANDED_ENV.settingsDebug]?.trim() ||
        process.env[BRANDED_ENV.viteSettingsDebug]?.trim()
          ? "set"
          : "—",
      source: process.env[BRANDED_ENV.viteSettingsDebug]?.trim()
        ? `env set — ${BRANDED_ENV.viteSettingsDebug}`
        : process.env[BRANDED_ENV.settingsDebug]?.trim()
          ? `env set — ${BRANDED_ENV.settingsDebug}`
          : "default (unset)",
      change: `export ${BRANDED_ENV.settingsDebug}=1 or ${BRANDED_ENV.viteSettingsDebug}=1`,
    },
    {
      setting: `VITE_ASSET_BASE_URL / ${BRANDED_ENV.assetBaseUrl}`,
      effective: assetBase,
      source: process.env.VITE_ASSET_BASE_URL?.trim()
        ? "env set — VITE_ASSET_BASE_URL"
        : process.env[BRANDED_ENV.assetBaseUrl]?.trim()
          ? `env set — ${BRANDED_ENV.assetBaseUrl}`
          : "default (unset — empty)",
      change: `export VITE_ASSET_BASE_URL=… or ${BRANDED_ENV.assetBaseUrl}=…`,
    },
    {
      setting: BRANDED_ENV.devPolling,
      effective: envFlagEffective(BRANDED_ENV.devPolling),
      source: envFlagSource(BRANDED_ENV.devPolling),
      change: `export ${BRANDED_ENV.devPolling}=1 for watch polling (VM/file shares)`,
    },
    {
      setting: "API port (resolved)",
      effective: String(apiPort),
      source: apiPref.sourceLabel,
      change: `${apiPref.changeLabel}; proxy /api → http://127.0.0.1:${apiPort}`,
    },
    {
      setting: "UI port (resolved)",
      effective: String(uiPort),
      source: uiPref.sourceLabel,
      change: uiPref.changeLabel,
    },
    {
      setting: "Mode",
      effective:
        mode === "dev-server" ? "vite dev (HMR)" : "vite build --watch",
      source: "derived",
      change:
        mode === "dev-server"
          ? `bun run dev (default); ${APP_ENV_PREFIX}_DESKTOP_VITE_BUILD_WATCH=1 for Rollup watch`
          : `${APP_ENV_PREFIX}_DESKTOP_VITE_WATCH=1 + ${APP_ENV_PREFIX}_DESKTOP_VITE_BUILD_WATCH=1`,
    },
  ];
}

/** Print effective env once per Vite process (dev server or first Rollup watch tick). */
function appDevSettingsBannerPlugin(): Plugin {
  let printedWatch = false;
  return {
    name: "app-dev-settings-banner",
    configureServer() {
      return () => {
        console.log(
          colorizeDevSettingsStartupBanner(
            prependDevSubsystemFigletHeading(
              "vite",
              formatDevSettingsTable(
                "Vite — effective settings (dev server)",
                buildViteDevSettingsRows("dev-server"),
              ),
            ),
          ),
        );
      };
    },
    buildStart() {
      if (process.env[BRANDED_ENV.desktopFastDist] === "1" && !printedWatch) {
        printedWatch = true;
        console.log(
          colorizeDevSettingsStartupBanner(
            prependDevSubsystemFigletHeading(
              "vite",
              formatDevSettingsTable(
                "Vite — effective settings (build --watch)",
                buildViteDevSettingsRows("build-watch"),
              ),
            ),
          ),
        );
      }
    },
  };
}

function desktopCorsPlugin(): Plugin {
  return {
    name: "desktop-cors",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        if (!origin || !req.url?.startsWith("/api")) return next();

        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Eliza-Token, X-Api-Key, X-Eliza-Export-Token, X-Eliza-Client-Id, X-Eliza-Terminal-Token, X-Eliza-UI-Language, X-Eliza-Platform",
        );

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        next();
      });
    },
  };
}

/**
 * Patch the final bundle output to fix AsyncLocalStorage stubs.
 *
 * Some packages import `{ AsyncLocalStorage } from "node:async_hooks"` at the
 * top level. Vite's dep optimizer and Rollup inline the virtual-module stub
 * as `(()=>({}))`, making AsyncLocalStorage `undefined` and causing
 * `new undefined` → "xte is not a constructor" at runtime in mobile webviews.
 *
 * This plugin replaces the empty-object stub with a proper class in the
 * final rendered chunks.
 */
function asyncLocalStoragePatchPlugin(): Plugin {
  return {
    name: "async-local-storage-patch",
    enforce: "post",
    renderChunk(code) {
      // Match: var{AsyncLocalStorage:<id>}=(()=>({}))
      const re =
        /var\s*\{\s*AsyncLocalStorage\s*:\s*(\w+)\s*\}\s*=\s*\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*\}\s*\)\s*\)/g;
      if (!re.test(code)) return null;
      re.lastIndex = 0;
      const patched = code.replace(re, (_match, id) => {
        // Use block-body arrow + named class — concise arrow with inline
        // anonymous class fails in older WebViews (Chrome 124 and below).
        return `var{AsyncLocalStorage:${id}}=(()=>{function A(){} A.prototype.getStore=function(){return undefined};A.prototype.run=function(s,fn){return fn.apply(void 0,[].slice.call(arguments,2))};A.prototype.enterWith=function(){};A.prototype.disable=function(){};return{AsyncLocalStorage:A}})()`;
      });
      return { code: patched, map: null };
    },
  };
}

function isIgnoredWorkspaceGeneratedOutput(normalizedFile: string): boolean {
  return (
    normalizedFile.includes("/packages/app/.vite/") ||
    normalizedFile.includes("/.turbo/") ||
    normalizedFile.includes("/.wrangler/") ||
    normalizedFile.includes("/packages/agent/data/") ||
    normalizedFile.includes("/packages/agent/.elizadb/") ||
    normalizedFile.includes("/output/generated-cad/") ||
    normalizedFile.includes("/src/i18n/generated/") ||
    normalizedFile.endsWith(".d.ts") ||
    normalizedFile.endsWith(".d.ts.map") ||
    normalizedFile.endsWith(".log") ||
    normalizedFile.endsWith(".md") ||
    normalizedFile.endsWith(".tsbuildinfo") ||
    /^.*\/packages\/.*\/dist\//.test(normalizedFile)
  );
}

function watchWorkspacePackagesPlugin(): Plugin {
  return {
    name: "watch-workspace-packages",
    configureServer(server) {
      const watcherStartedAt = Date.now();
      const seenMtimes = new Map<string, number>();
      // Watch ONLY workspace package.json manifests — an alias/dependency change
      // there needs a full Vite restart. We deliberately do NOT add the entire
      // packages/ + plugins/ trees: that re-globbed ~45k files (including ~1GB of
      // os/), bypassed server.watch.ignored, risked exhausting
      // fs.inotify watches, and — via the old blanket full-reload below — turned
      // every workspace source edit into a full page reload instead of HMR.
      // Imported workspace *source* is already watched through Vite's module
      // graph, so React Fast Refresh / HMR handles those edits natively.
      const workspaceManifests: string[] = [];
      for (const root of [
        path.resolve(elizaRoot, "packages"),
        nativePluginsRoot,
      ]) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const manifest = path.join(root, entry.name, "package.json");
          if (fs.existsSync(manifest)) workspaceManifests.push(manifest);
        }
      }
      server.watcher.add(workspaceManifests);
      server.watcher.on("change", (file) => {
        // Source edits are handled by Vite's own HMR / Fast Refresh; only a
        // workspace manifest change forces a full server restart.
        if (!file.endsWith("package.json")) return;
        const normalizedFile = file.split(path.sep).join("/");
        if (isIgnoredWorkspaceGeneratedOutput(normalizedFile)) return;
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.mtimeMs < watcherStartedAt - 1000) return;
        if (seenMtimes.get(normalizedFile) === stat.mtimeMs) return;
        seenMtimes.set(normalizedFile, stat.mtimeMs);
        server.restart();
      });
    },
  };
}

function workspaceJsxInJsPlugin(): Plugin {
  const normalizedAppCoreSrcRoot = appCoreSrcRoot.split(path.sep).join("/");

  return {
    name: "workspace-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      const cleanId = id.split("?")[0];
      const normalizedId = cleanId.split(path.sep).join("/");
      if (!cleanId.endsWith(".js")) return null;
      if (!normalizedId.startsWith(`${normalizedAppCoreSrcRoot}/`)) return null;

      return transformWithOxc(code, cleanId, {
        lang: "jsx",
        jsx: "automatic",
        sourcemap: true,
      });
    },
  };
}

const DEV_CJS_INTEROP_SHIM_ALIASES: Array<[RegExp, string]> = [
  [/^cookie$/, "src/shims/cookie.ts"],
  [
    /^set-cookie-parser(?:\/lib\/set-cookie(?:\.js)?)?$/,
    "src/shims/set-cookie-parser.ts",
  ],
  [
    /^use-sync-external-store\/(?:shim\/)?with-selector(?:\.js)?$/,
    "src/shims/use-sync-external-store-with-selector.ts",
  ],
  [/^style-to-js(?:\/cjs\/index(?:\.js)?)?$/, "src/shims/style-to-js.ts"],
  [/^debug(?:\/src\/browser(?:\.js)?)?$/, "src/shims/debug.ts"],
  [/^extend(?:\/index(?:\.js)?)?$/, "src/shims/extend.ts"],
  [/^es-toolkit\/compat\/get(?:\.js)?$/, "src/shims/es-toolkit-compat-get.ts"],
  [
    /^es-toolkit\/compat\/uniqBy(?:\.js)?$/,
    "src/shims/es-toolkit-compat-uniqBy.ts",
  ],
  [
    /^es-toolkit\/compat\/sortBy(?:\.js)?$/,
    "src/shims/es-toolkit-compat-sortBy.ts",
  ],
  [
    /^es-toolkit\/compat\/throttle(?:\.js)?$/,
    "src/shims/es-toolkit-compat-throttle.ts",
  ],
  [
    /^es-toolkit\/compat\/last(?:\.js)?$/,
    "src/shims/es-toolkit-compat-last.ts",
  ],
  [
    /^es-toolkit\/compat\/maxBy(?:\.js)?$/,
    "src/shims/es-toolkit-compat-maxBy.ts",
  ],
  [
    /^es-toolkit\/compat\/minBy(?:\.js)?$/,
    "src/shims/es-toolkit-compat-minBy.ts",
  ],
  [
    /^es-toolkit\/compat\/range(?:\.js)?$/,
    "src/shims/es-toolkit-compat-range.ts",
  ],
  [
    /^es-toolkit\/compat\/omit(?:\.js)?$/,
    "src/shims/es-toolkit-compat-omit.ts",
  ],
  [
    /^es-toolkit\/compat\/sumBy(?:\.js)?$/,
    "src/shims/es-toolkit-compat-sumBy.ts",
  ],
  [
    /^es-toolkit\/compat\/isPlainObject(?:\.js)?$/,
    "src/shims/es-toolkit-compat-isPlainObject.ts",
  ],
  [
    /^decimal\.js-light(?:\/decimal(?:\.(?:js|mjs))?)?$/,
    "src/shims/decimal-js-light.ts",
  ],
  [/^eventemitter3$/, "src/shims/eventemitter3.ts"],
  [/^react-is$/, "src/shims/react-is.ts"],
  [/^nprogress(?:\/nprogress(?:\.js)?)?$/, "src/shims/nprogress.ts"],
];

function devCjsInteropShimAliasesPlugin(): Plugin {
  return {
    name: "dev-cjs-interop-shim-aliases",
    apply: "serve",
    enforce: "pre",
    resolveId(source) {
      const sourceWithoutQuery = source.split("?")[0] ?? source;
      for (const [find, replacement] of DEV_CJS_INTEROP_SHIM_ALIASES) {
        if (find.test(sourceWithoutQuery)) {
          return path.resolve(here, replacement);
        }
      }
      return null;
    },
  };
}

// Builds a Vite/Rolldown plugin that resolves `es-toolkit/compat/<name>` to
// its ESM `dist/compat/**/<name>.mjs` and re-exports the named binding as
// default, bypassing the CJS-only export map. Must be registered in both
// `plugins` (raw-serve path) and `optimizeDeps.rolldownOptions.plugins`
// (dep-optimizer path) so neither path touches the broken CJS entry.
function makeEsToolkitCompatEsmPlugin(
  pluginName: string,
  isRaw = false,
): Plugin {
  const PREFIX = `\0estk-${pluginName}:`;
  return {
    name: `es-toolkit-compat-esm-${pluginName}`,
    enforce: isRaw ? ("pre" as const) : undefined,
    resolveId(source, importer) {
      const m = /^es-toolkit\/compat\/([A-Za-z0-9_]+)(?:\.js)?$/.exec(source);
      if (!m) return null;
      let dir: string | null = null;
      try {
        const req = createRequire(
          importer || path.join(elizaRoot, "node_modules", "x.js"),
        );
        dir = path.dirname(req.resolve("es-toolkit/package.json"));
      } catch {
        return null;
      }
      const stack = [path.join(dir, "dist", "compat")];
      let mjs: string | null = null;
      while (stack.length) {
        const d = stack.pop();
        if (d === undefined) break;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else if (ent.name === `${m[1]}.mjs`) {
            mjs = full;
            break;
          }
        }
        if (mjs) break;
      }
      if (!mjs) return null;
      return `${PREFIX}${m[1]}\0${mjs}`;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const rest = id.slice(PREFIX.length);
      const sep = rest.indexOf("\0");
      const name = rest.slice(0, sep);
      const spec = JSON.stringify(rest.slice(sep + 1));
      return (
        `export { ${name} as default } from ${spec};\n` +
        `export * from ${spec};\n`
      );
    },
  };
}

// Rolldown invokes optimizer resolve hooks once per import edge. Resolving the
// same five polyfill packages inside that hook turned a cold Vite start into
// tens of thousands of synchronous package.json lookups (~55-60 seconds on a
// warm filesystem). Resolve each installed polyfill once while loading config;
// the hot hook is then a constant-time map lookup.
const optimizerNodePolyfills: Readonly<Record<string, string>> = (() => {
  const resolved: Record<string, string> = {};
  for (const [nodeId, pkg, entry] of [
    ["node:events", "events", "events.js"],
    ["events", "events", "events.js"],
    ["node:buffer", "buffer", "index.js"],
    ["buffer", "buffer", "index.js"],
    ["node:util", "util", "util.js"],
    ["util", "util", "util.js"],
    ["node:process", "process", "browser.js"],
    ["process", "process", "browser.js"],
    ["node:stream", "stream-browserify", "index.js"],
    ["stream", "stream-browserify", "index.js"],
  ] as const) {
    try {
      const pkgDir = path.dirname(_require.resolve(`${pkg}/package.json`));
      resolved[nodeId] = path.join(pkgDir, entry);
    } catch {
      // Missing optional polyfills fall through to a generated node stub.
    }
  }
  return resolved;
})();

export default defineConfig(({ command, mode }) => ({
  root: here,
  customLogger: viteLogger,
  // Native shells (Electrobun `views://`, Capacitor `file://`) load assets
  // relative to the HTML document, so they need a relative base — keep "./".
  // The web bundle (`build:web` → Cloudflare Pages, served from an origin root)
  // is an SPA whose client-side routes go several segments deep
  // (e.g. /auth/cli-login, /app-auth/authorize, /payment/:id). With a relative
  // base, `./assets/x.js` resolves against the route directory (→
  // /auth/assets/x.js), which the SPA catch-all returns as index.html
  // (text/html). The browser then rejects the stylesheet/module and the bundle
  // never boots — the page hangs on a blank/loading shell. `build:web` sets
  // ELIZA_WEB_ABSOLUTE_BASE=1 so the deployed SPA uses an absolute "/" base and
  // every route depth resolves assets to /assets/… correctly.
  base: process.env.ELIZA_WEB_ABSOLUTE_BASE === "1" ? "/" : "./",
  // Keep pre-bundle cache under the app dir (not node_modules/.vite) so Bun
  // installs don't fight Vite, and `bun run clean` / docs can target one path.
  // ELIZA_VITE_CACHE_DIR lets a parallel dev/measurement server use an isolated
  // dep-optimize cache so it never invalidates the primary server's cache.
  cacheDir: process.env.ELIZA_VITE_CACHE_DIR
    ? path.resolve(process.env.ELIZA_VITE_CACHE_DIR)
    : path.resolve(here, ".vite"),
  publicDir: IS_ANDROID_CLOUD_RENDERER_BUILD
    ? false
    : path.resolve(here, "public"),
  define: {
    global: "globalThis",
    ...resolveLocalRealtimeVoiceDefinesFromEnv(
      command,
      mode,
      localVoiceGatewayPort,
      here,
    ),
    // Build variant — set at signing time by desktop-build.mjs and embedded
    // here so the renderer can branch on store vs direct without an API call.
    __ELIZA_BUILD_VARIANT__: JSON.stringify(
      process.env.ELIZA_BUILD_VARIANT === "store" ? "store" : "direct",
    ),
    // Web-shell gate. The top-level react-router shell that owns the cloud /
    // public / auth / payment routes (CloudRouterShell) is web-build-only:
    // Capacitor mobile bundles mount the tab/view App directly and must not
    // grow. This compile-time constant lets the mobile build tree-shake the
    // entire shell + Steward/wallet + public-page chunks out of the bundle.
    // Desktop (Electrobun) shares this `dist`, so the constant is `true` there
    // too; `main.tsx` then branches at runtime so only the actual web platform
    // mounts the shell (desktop mounts App directly).
    // `ELIZA_DISABLE_WEB_SHELL=1` drops the cloud router shell from a web build
    // too (same tree-shake path as mobile) — used by the ui-smoke lane, which
    // exercises the agent app, not the cloud surface.
    __ELIZA_WEB_SHELL__: JSON.stringify(
      !IS_CAPACITOR_MOBILE_BUILD && process.env.ELIZA_DISABLE_WEB_SHELL !== "1",
    ),
    __ELIZA_PUBLIC_WEB_ENTRY__: JSON.stringify(!IS_CAPACITOR_MOBILE_BUILD),
    __ELIZA_WEB_PUSH__: JSON.stringify(!IS_CAPACITOR_MOBILE_BUILD),
    __ELIZA_SERVICE_WORKER__: JSON.stringify(!IS_CAPACITOR_MOBILE_BUILD),
    __ELIZA_CHAT_UI_HARNESS__: JSON.stringify(
      process.env.ELIZA_CHAT_UI_HARNESS === "1",
    ),
    // Mirror the branded TTS debug env into the client bundle so one env
    // enables UI + server TTS logs in dev.
    [`import.meta.env.${BRANDED_ENV.ttsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.ttsDebug] ?? "",
    ),
    [`import.meta.env.${BRANDED_ENV.settingsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.settingsDebug] ?? "",
    ),
    [`import.meta.env.${BRANDED_ENV.viteSettingsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.viteSettingsDebug] ?? "",
    ),
    "import.meta.env.VITE_ASSET_BASE_URL": JSON.stringify(
      process.env.VITE_ASSET_BASE_URL ??
        process.env[BRANDED_ENV.assetBaseUrl] ??
        "",
    ),
  },
  plugins: [
    devViewStudioPlugin(),
    androidCloudRendererEntryPlugin(),
    androidCloudCuratedAssetsPlugin(),
    androidCloudRendererPolicyPlugin(),
    forcedHostModeFlagGuardPlugin(),
    productionBuildStampGuardPlugin(),
    bufferEsmShimPlugin(),
    // Manifest-driven renderer side-effect plugin registration (#9178): resolves
    // the `virtual:eliza-side-effect-app-modules` import in plugin-registrations.ts
    // by scanning plugins/ for elizaos.appRegister markers. This plugin is the
    // only provider for that virtual module in production web/mobile builds.
    appSideEffectModulesPlugin([nativePluginsRoot]),
    // When the cloud surface is excluded (ELIZA_DISABLE_WEB_SHELL=1), replace the
    // whole `@elizaos/ui/src/cloud` subtree with empty modules. The two lazy
    // cloud entry points are already aliased to passthrough stubs, but the main
    // `@elizaos/ui` barrel ALSO re-exports the cloud namespace (`export * as
    // cloud from "./cloud"`), which would otherwise drag the subtree (and its
    // wallet/web3 deps) into every consumer of the barrel. Emptying the subtree
    // cuts it at the source — the agent app never uses the cloud namespace.
    ...(process.env.ELIZA_DISABLE_WEB_SHELL === "1"
      ? [
          {
            name: "eliza-stub-cloud-surface",
            enforce: "pre" as const,
            load(id: string) {
              const p = id.split("?")[0]?.split(path.sep).join("/") ?? "";
              // The agent app's SettingsView pulls `listExtraSettingsGroups` from
              // the cloud settings barrel, which in turn imports the broken cloud
              // feature subtrees. Provide it directly (no cloud groups when the
              // cloud surface is excluded) so the whole subtree drops out.
              if (
                /\/packages\/ui\/src\/cloud\/settings\/index\.tsx?$/.test(p)
              ) {
                return "export function listExtraSettingsGroups() { return []; }";
              }
              // Empty the broken cloud feature subtrees (their `./data/*` hooks
              // were never migrated) plus the cloud barrel that re-exports them.
              const broken =
                /\/packages\/ui\/src\/cloud\/(account-security|admin|billing|instances|organization)\//.test(
                  p,
                ) || /\/packages\/ui\/src\/cloud\/index\.tsx?$/.test(p);
              return broken ? "export {};" : null;
            },
          },
        ]
      : []),
    // es-toolkit@1.47's `./compat/*` export map exposes only a CJS condition
    // (no ESM `import`), so `import get from "es-toolkit/compat/get"` (recharts
    // default-imports 11 such subpaths) resolves to a CJS shim Vite can't
    // surface a `default` for when served raw -> blank app. Rewrite each to the
    // real ESM `dist/compat/**/<name>.mjs` (resolved relative to the importer)
    // and re-export the named binding as default. Mirrors the optimizer-path
    // plugin in optimizeDeps.rolldownOptions so both serve paths are covered.
    makeEsToolkitCompatEsmPlugin("raw", true),
    {
      // lucide-react ships ~1500 icons but the app uses ~130. The barrel is not
      // tree-shaken (the directory alias hides the package's sideEffects:false,
      // so Rolldown keeps every ./icons/*.mjs), shipping a ~600KB chunk. Rewrite
      // each `import { X } from "lucide-react"` in source to a per-icon deep
      // import so only the used icons survive. The name→file map is parsed from
      // lucide's own barrel, so resolution is authoritative; any name not in the
      // map (e.g. a type-only import) leaves that statement untouched.
      //
      // The one consumer the static rewrite cannot reach is the runtime module
      // registry's dynamic `() => import("lucide-react")`
      // (packages/ui/.../DynamicViewLoader.tsx). A dynamic import pulls the full
      // barrel → icons/index.mjs → all ~1500 icons. Redirect that (and any
      // surviving static bare-barrel import) to a virtual module that re-exports
      // only the statically-used icons, so the dynamic chunk shares the same
      // curated set instead of the whole library.
      name: "lucide-per-icon-imports",
      enforce: "pre" as const,
      // The per-icon rewrite trades one barrel import for ~250 deep per-icon
      // imports. That is correct for the production bundle (tree-shaking) but in
      // dev it explodes into ~250 separate raw module round-trips on every cold
      // load. In dev we instead leave the barrel import intact and pre-bundle
      // `lucide-react` once via optimizeDeps.include (bundle size is irrelevant
      // for the dev server), so the rewrite is build-only.
      configResolved(resolved: { command: string }) {
        lucideRewriteEnabled = resolved.command === "build";
      },
      resolveId(source: string) {
        if (source === LUCIDE_USED_BARREL_ID)
          return LUCIDE_USED_BARREL_RESOLVED;
        return null;
      },
      load(id: string) {
        if (id === LUCIDE_USED_BARREL_RESOLVED) {
          return buildLucideUsedBarrelSource();
        }
        return null;
      },
      transform(code: string, id: string) {
        if (!lucideRewriteEnabled) return null;
        if (id.includes("/node_modules/")) return null;
        if (!code.includes("lucide-react")) return null;
        const map = getLucideIconFileMap();
        if (map.size === 0) return null;
        let changed = false;
        let out = code.replace(
          /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"];?/g,
          (full: string, inner: string) => {
            const specs = inner
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const valueLines: string[] = [];
            const typeSpecs: string[] = [];
            for (const spec of specs) {
              // `type X` specs are erased at build — keep them as a type-only
              // import so they never pull the runtime barrel.
              if (spec.startsWith("type ")) {
                typeSpecs.push(spec.slice(5).trim());
                continue;
              }
              const asMatch = spec.match(/^(\w+)\s+as\s+(\w+)$/);
              const name = asMatch ? asMatch[1] : spec;
              const local = asMatch ? asMatch[2] : spec;
              const file = map.get(name);
              // A non-type value that isn't an icon (e.g. createLucideIcon) →
              // leave the whole statement untouched so nothing breaks.
              if (!file) return full;
              valueLines.push(
                `import ${local} from "lucide-react/dist/esm/icons/${file}.mjs";`,
              );
            }
            changed = true;
            if (typeSpecs.length > 0) {
              valueLines.push(
                `import type { ${typeSpecs.join(", ")} } from "lucide-react";`,
              );
            }
            return valueLines.join("\n");
          },
        );
        // Redirect dynamic `import("lucide-react")` to the curated virtual
        // barrel — that dynamic import is the registry fallback the static
        // rewrite can't see, and it otherwise pulls the full icon set. Type-only
        // imports (`import type { … } from "lucide-react"`) are left on the real
        // package because they are erased before bundling and never contribute
        // runtime code. Deep `lucide-react/…` specifiers keep a `/` after the
        // package name, so the exact-match below skips them.
        out = out.replace(/\bimport\s*\(\s*(['"])lucide-react\1\s*\)/g, () => {
          changed = true;
          return `import("${LUCIDE_USED_BARREL_ID}")`;
        });
        return changed ? { code: out, map: null } : null;
      },
    },
    appShellMetadataPlugin(),
    rendererBuildManifestPlugin(),
    // Stamp a per-deploy build rev into dist/sw.js so the browser detects a new
    // service worker on every deploy and auto-runs the update flow (kills the
    // recurring clear-data ritual — CONVERSATIONS-500-2026-07-22 fix #1).
    swBuildRevPlugin(),
    appDevWsBasePlugin(),
    elizaCoreBrowserEntryFallbackPlugin(),
    nativeModuleStubPlugin({
      isCapacitorMobileBuild: IS_CAPACITOR_MOBILE_BUILD,
      requireModule: _require,
    }),
    asyncLocalStoragePatchPlugin(),
    // @opentelemetry/api is imported by `ai@6+` but is not hoisted to the
    // workspace root under Bun canary's content-addressable store layout.
    // resolve.alias covers it when otelApiEntry is found at config time, but
    // when the store layout differs (e.g. CI Docker smoke) the alias is absent
    // and Vite emits a hard "Rollup failed to resolve" error for node_modules
    // imports before the rolldownOptions plugin layer can intercept them.
    // This top-level Vite plugin intercepts the specifier unconditionally so
    // the alias (when present) or the browser telemetry fallback (when absent) always wins.
    {
      name: "otel-api-resolver",
      enforce: "pre" as const,
      resolveId(id: string) {
        if (id !== "@opentelemetry/api") return null;
        if (otelApiEntry) return otelApiEntry;
        return "\0otel-api-fallback";
      },
      load(id: string) {
        if (id !== "\0otel-api-fallback") return null;
        // Minimal browser telemetry fallback satisfying the named exports that `ai` reads at
        // import time: trace, context, propagation, metrics, diag,
        // SpanStatusCode, SpanKind, ROOT_CONTEXT, createContextKey,
        // defaultTextMapPropagator, isSpanContextValid, INVALID_SPAN_CONTEXT,
        // INVALID_TRACER_PROVIDER.
        return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
      },
    },
    iosLocalAgentKernelEsbuildPlugin(),
    watchWorkspacePackagesPlugin(),
    workspaceJsxInJsPlugin(),
    devCjsInteropShimAliasesPlugin(),
    tailwindcss(),
    react(),
    desktopCorsPlugin(),
    appDevSettingsBannerPlugin(),
    visualizer({
      filename: "dist/stats.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
      emitFile: false,
    }) as Plugin,
  ],
  oxc: {
    // Override tsconfig target so generated workspace configs cannot push the
    // browser transform beyond the runtime baseline.
    target: "es2022",
  },
  resolve: {
    // Development serves workspace source before any package dist exists.
    // Retain Vite's browser/development conditions so packages without a
    // source export keep resolving to their browser entry points. Production
    // builds intentionally retain Vite's untouched default condition set.
    ...(command === "serve"
      ? { conditions: ["eliza-source", ...defaultClientConditions] }
      : {}),
    dedupe: [
      "react",
      "react-dom",
      "react-router",
      "react-router-dom",
      "three",
      "@capacitor/core",
      "@elizaos/app-core",
      "zod",
      "@opentelemetry/api",
      // One physical Buffer identity across bn.js / elliptic / asn1.js /
      // @solana so the crypto graph never mixes versions. (safe-buffer is NOT
      // deduped: it isn't directly installed at the app root, so forcing
      // single-copy resolution there externalizes it to a bare specifier the
      // browser can't load — it resolves + bundles fine on its own.)
      "buffer",
    ],
    alias: [
      {
        find: /^@elizaos\/login$/,
        replacement: path.resolve(elizaRoot, "packages/login/src/sdk/index.ts"),
      },
      {
        find: /^@homepage\//,
        replacement: `${path.resolve(here, "../homepage/src")}/`,
      },
      {
        find: /^@\//,
        replacement: `${path.resolve(here, "../homepage/src")}/`,
      },
      { find: /^react$/, replacement: reactEntry },
      { find: /^react\/index\.js$/, replacement: reactEntry },
      { find: /^react\/jsx-runtime$/, replacement: reactJsxRuntimeEntry },
      { find: /^react\/jsx-runtime\.js$/, replacement: reactJsxRuntimeEntry },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: reactJsxDevRuntimeEntry,
      },
      {
        find: /^react\/jsx-dev-runtime\.js$/,
        replacement: reactJsxDevRuntimeEntry,
      },
      { find: /^react-dom$/, replacement: reactDomEntry },
      { find: /^react-dom\/index\.js$/, replacement: reactDomEntry },
      { find: /^react-dom\/client$/, replacement: reactDomClientEntry },
      { find: /^react-dom\/client\.js$/, replacement: reactDomClientEntry },
      ...(otelApiEntry
        ? [{ find: /^@opentelemetry\/api$/, replacement: otelApiEntry }]
        : []),
      // Bare Node built-in polyfills for browser — pathe provides ESM path,
      // events is pre-bundled via optimizeDeps.
      { find: /^path$/, replacement: patheEntry },
      {
        find: /^@solana\/wallet-adapter-react-ui\/styles\.css$/,
        replacement: SOLANA_WALLET_CSS_RESOLVED,
      },
      {
        find: /^fast-redact$/,
        replacement: path.resolve(here, "src/shims/fast-redact.ts"),
      },
      {
        find: /^cron-parser$/,
        replacement: path.resolve(here, "src/shims/cron-parser.ts"),
      },
      {
        find: /^picocolors$/,
        replacement: path.resolve(here, "src/shims/picocolors.ts"),
      },
      {
        find: /^cookie$/,
        replacement: path.resolve(here, "src/shims/cookie.ts"),
      },
      {
        find: /^set-cookie-parser$/,
        replacement: path.resolve(here, "src/shims/set-cookie-parser.ts"),
      },
      {
        find: /^style-to-js(?:\/cjs\/index\.js)?$/,
        replacement: path.resolve(here, "src/shims/style-to-js.ts"),
      },
      {
        find: /^debug(?:\/src\/browser(?:\.js)?)?$/,
        replacement: path.resolve(here, "src/shims/debug.ts"),
      },
      {
        find: /^extend$/,
        replacement: path.resolve(here, "src/shims/extend.ts"),
      },
      {
        find: /^mammoth$/,
        replacement: path.resolve(here, "src/shims/mammoth.ts"),
      },
      {
        // Node-only eSpeak-NG build; crashes at module-eval in WKWebView. The
        // Kokoro TTS adapter falls back to its bundled G2P phonemizer in the
        // browser. See src/shims/phonemizer.ts.
        find: /^phonemizer$/,
        replacement: path.resolve(here, "src/shims/phonemizer.ts"),
      },
      {
        find: /^unpdf$/,
        replacement: path.resolve(here, "src/shims/unpdf.ts"),
      },
      {
        find: /^handlebars$/,
        replacement: path.resolve(here, "src/shims/handlebars.ts"),
      },
      {
        find: /^@vercel\/oidc$/,
        replacement: path.resolve(here, "src/shims/vercel-oidc.ts"),
      },
      {
        find: /^use-sync-external-store\/shim$/,
        replacement: path.resolve(here, "src/shims/use-sync-external-store.ts"),
      },
      {
        find: /^use-sync-external-store\/(?:shim\/)?with-selector(?:\.js)?$/,
        replacement: path.resolve(
          here,
          "src/shims/use-sync-external-store-with-selector.ts",
        ),
      },
      { find: /^json5$/, replacement: json5EsmEntry },
      ...(yamlBrowserEntry
        ? [{ find: /^yaml$/, replacement: yamlBrowserEntry }]
        : []),
      ...(uuidBrowserEntry
        ? [{ find: /^uuid$/, replacement: uuidBrowserEntry }]
        : []),
      ...(adzeEntry ? [{ find: /^adze$/, replacement: adzeEntry }] : []),
      ...(reactDayPickerEntry
        ? [{ find: /^react-day-picker$/, replacement: reactDayPickerEntry }]
        : []),
      // Order matters: the `/locale` subpaths must precede the bare-package
      // aliases so `^date-fns$` does not shadow `^date-fns/locale$`.
      ...(dateFnsLocaleEntry
        ? [{ find: /^date-fns\/locale$/, replacement: dateFnsLocaleEntry }]
        : []),
      ...(dateFnsEntry
        ? [{ find: /^date-fns$/, replacement: dateFnsEntry }]
        : []),
      ...(dateFnsJalaliLocaleEntry
        ? [
            {
              find: /^date-fns-jalali\/locale$/,
              replacement: dateFnsJalaliLocaleEntry,
            },
          ]
        : []),
      ...(dateFnsJalaliEntry
        ? [{ find: /^date-fns-jalali$/, replacement: dateFnsJalaliEntry }]
        : []),
      ...(fs.existsSync(rechartsEntry)
        ? [{ find: /^recharts$/, replacement: rechartsEntry }]
        : []),
      ...(fs.existsSync(nprogressEntry)
        ? [{ find: /^nprogress$/, replacement: nprogressEntry }]
        : []),
      ...(reactRouterDomEntry
        ? [{ find: /^react-router-dom$/, replacement: reactRouterDomEntry }]
        : []),
      ...(reactRouterEntry
        ? [{ find: /^react-router$/, replacement: reactRouterEntry }]
        : []),
      ...(reactRouterDomExportEntry
        ? [
            {
              find: /^react-router\/dom$/,
              replacement: reactRouterDomExportEntry,
            },
          ]
        : []),
      ...(reactRouterCookieEntry
        ? [{ find: /^cookie$/, replacement: reactRouterCookieEntry }]
        : []),
      ...(fs.existsSync(markedEntry)
        ? [{ find: /^marked$/, replacement: markedEntry }]
        : []),
      {
        // Per-icon deep imports (emitted by the lucide-per-icon-imports plugin)
        // resolve here — the exact alias below only matches the bare specifier.
        find: /^lucide-react\/(.*)$/,
        replacement: `${path.resolve(elizaRoot, "packages/ui/node_modules/lucide-react")}/$1`,
      },
      {
        find: /^lucide-react$/,
        replacement: path.resolve(
          elizaRoot,
          "packages/ui/node_modules/lucide-react",
        ),
      },
      { find: /^@capacitor\/core$/, replacement: capacitorCoreEntry },
      // Aliases for Capacitor packages that may not be hoisted to root node_modules
      // by bun workspaces. Apps/app resolves them; eliza submodule sources cannot.
      ...(capacitorKeyboardEntry
        ? [
            {
              find: /^@capacitor\/keyboard$/,
              replacement: capacitorKeyboardEntry,
            },
          ]
        : []),
      ...(capacitorPreferencesEntry
        ? [
            {
              find: /^@capacitor\/preferences$/,
              replacement: capacitorPreferencesEntry,
            },
          ]
        : []),
      ...(capacitorAppEntry
        ? [{ find: /^@capacitor\/app$/, replacement: capacitorAppEntry }]
        : []),
      // Keep the migrated browser bridge plugin on local source in renderer
      // builds. It is not an `app-*` route package, so the dynamic app plugin
      // aliases intentionally skip it.
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "index.ts"),
      },
      // Side-effect app modules are loaded by the renderer only to register
      // UI surfaces/pages. Route handlers and runtime services stay server-side.
      ...[
        [
          "@elizaos/plugin-trajectory-logger",
          "plugins/plugin-trajectory-logger/src/register.ts",
        ],
        ["@elizaos/plugin-wallet/ui", "plugins/plugin-wallet/src/ui/index.ts"],
        [
          "@elizaos/plugin-wallet/register",
          "plugins/plugin-wallet/src/register.ts",
        ],
        [
          "@elizaos/plugin-contacts/register",
          "plugins/plugin-contacts/src/register.ts",
        ],
        [
          "@elizaos/plugin-phone/register",
          "plugins/plugin-phone/src/register.ts",
        ],
        [
          "@elizaos/plugin-task-coordinator/register",
          "plugins/plugin-task-coordinator/src/register.ts",
        ],
        [
          "@elizaos/plugin-wifi/register",
          "plugins/plugin-wifi/src/register.ts",
        ],
        // The browser-safe native-backend registration seam. The bare
        // `@elizaos/plugin-blocker` specifier is aliased (via the dynamic
        // app-plugin aliases above) to src/register.ts — a side-effect-only
        // module with no exports — so `main.tsx` registers the Capacitor
        // blocker adapters through this subpath. Resolve from source so the
        // renderer build does not require plugin-blocker's dist.
        [
          "@elizaos/plugin-blocker/native",
          "plugins/plugin-blocker/src/native.ts",
        ],
        // plugin-calendar subpaths consumed by plugin-personal-assistant in the renderer
        // bundle. Resolve from source so the app build does not require
        // plugin-calendar to be built first (its dist is absent during the
        // renderer build in CI). client-calendar is a side-effect import that
        // augments ElizaClient.prototype with the calendar feed methods.
        [
          "@elizaos/plugin-calendar/api/client-calendar",
          "plugins/plugin-calendar/src/api/client-calendar.ts",
        ],
        ["@elizaos/plugin-calendar/ui", "plugins/plugin-calendar/src/ui.ts"],
      ].map(([pkgName, relativeEntry]) => ({
        find: new RegExp(`^${escapeRegExp(pkgName)}$`),
        replacement: path.resolve(elizaRoot, relativeEntry),
      })),
      // Node built-in subpaths that browser polyfills don't provide.
      // Server-only code imports these but they're never executed in-browser.
      ...["util/types", "stream/promises", "stream/web"].flatMap((sub) => [
        {
          find: `node:${sub}`,
          replacement: path.join(
            appCoreSrcRoot,
            "platform/empty-node-module.ts",
          ),
        },
        {
          find: sub,
          replacement: path.join(
            appCoreSrcRoot,
            "platform/empty-node-module.ts",
          ),
        },
      ]),
      // Capacitor plugins — resolve to local plugin sources
      ...NATIVE_PLUGIN_ALIAS_ENTRIES,
      // @elizaos/logger is the standalone logger extracted from @elizaos/core.
      // Resolve it to source so the renderer's logger consumers (~11 files) load
      // the small logger module instead of dragging core's ~2MB browser bundle
      // into the eager entry graph.
      {
        find: /^@elizaos\/logger$/,
        replacement: path.resolve(elizaRoot, "packages/logger/src/index.ts"),
      },
      // When the cloud surface is excluded (ELIZA_DISABLE_WEB_SHELL=1), redirect
      // the two lazy cloud entry points to passthrough stubs — placed BEFORE the
      // broad @elizaos/ui/* alias below (first match wins) so Rollup never
      // resolves the cloud subtree, which would otherwise drag in its
      // wallet/web3 deps.
      ...(process.env.ELIZA_DISABLE_WEB_SHELL === "1"
        ? [
            {
              find: /^@elizaos\/ui\/cloud\/shell\/CloudRouterShell$/,
              replacement: path.join(here, "src/shims/cloud-shell-stub.tsx"),
            },
            {
              find: /^@elizaos\/ui\/cloud\/register-all$/,
              replacement: path.join(
                here,
                "src/shims/cloud-register-all-stub.ts",
              ),
            },
            {
              find: /^@elizaos\/ui\/cloud\/register-public$/,
              replacement: path.join(
                here,
                "src/shims/cloud-register-all-stub.ts",
              ),
            },
          ]
        : []),
      // Force local @elizaos/ui source paths when the app bundles linked
      // @elizaos/app-core sources directly.
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(uiPkgRoot, "src/browser.ts"),
      },
      {
        find: /^@elizaos\/ui\/styles$/,
        replacement: path.join(uiPkgRoot, "src/styles.ts"),
      },
      ...[
        ["button", "button.tsx"],
        ["input", "input.tsx"],
        ["textarea", "textarea.tsx"],
        ["native-select", "native-select.tsx"],
        ["native-dialog", "native-dialog.tsx"],
      ].map(([subpath, source]) => ({
        find: new RegExp(`^${escapeRegExp(`@elizaos/ui/${subpath}`)}$`),
        replacement: path.join(uiPkgRoot, "src/components/ui", source),
      })),
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(uiPkgRoot, "src/$1"),
      },
      {
        find: /^@elizaos\/shared\/brand$/,
        replacement: path.resolve(
          elizaRoot,
          "packages/shared/src/brand/index.ts",
        ),
      },
      // plugin-personal-assistant no longer ships a renderer view (the
      // legacy /lifeops dashboard was killed in the lifeops decomposition);
      // domain views live in plugin-todos/inbox/goals/health/calendar/etc.
      // src/ui.ts is the browser-safe facade — it imports the side-effectful
      // HTTP client and re-exports the surviving settings-card components,
      // without dragging discord/health/phone/native deps into the
      // browser bundle (those are pulled in by src/index.ts / src/plugin.ts).
      {
        find: /^@elizaos\/plugin-personal-assistant$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-personal-assistant/src/ui.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-google-workspace$/,
        replacement: path.join(appCoreSrcRoot, "platform/empty-node-module.ts"),
      },
      // plugin-health is a backend-only plugin (no `elizaos.app`), so it gets no
      // auto-generated browser alias. Its `ui/` directory ships browser-safe
      // assistant-command metadata that the LifeOps renderer imports, so the
      // `/ui` subpath needs an explicit alias to its source entry.
      {
        find: /^@elizaos\/plugin-health\/ui$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-health/src/ui/index.ts",
        ),
      },
      // `screen-time/mobile-signal-setup` ships browser-safe badge/label helpers
      // the LifeOps renderer imports; alias it to source like `/ui` so the
      // production browser build resolves it without a built plugin-health dist.
      {
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
      // Browser-safe aliases for local app plugin package roots. Keep these
      // before workspace aliases; Vite/Rollup uses the first matching alias, and
      // the renderer must prefer UI facades over package root exports.
      ...createAppPluginBrowserAliases(),
      // Dynamic aliases for local app plugin package roots that do not have a
      // dedicated browser facade.
      ...createWorkspacePackageAliases([path.resolve(elizaRoot, "plugins")]),
      // Cloud UI imports shared contracts from this private source workspace.
      // Alias its complete export map so clean renderer builds do not depend on
      // package-manager subpath resolution or artifacts from another checkout.
      ...createWorkspacePackageExportAliases([
        path.resolve(elizaRoot, "packages/cloud/shared"),
      ]),
      ...(() => {
        const sharedPkgPath = path.resolve(
          elizaRoot,
          "packages/shared/package.json",
        );
        const sharedPkgDir = path.dirname(sharedPkgPath);
        const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, "utf8"));
        const aliases = [];
        for (const [key, value] of Object.entries(sharedPkg.exports || {})) {
          if (!key.startsWith(".") || key.includes("*")) continue;
          const exportTarget = resolveSharedSourceExportTarget(
            sharedPkgDir,
            key,
            value,
          );
          if (!exportTarget) continue;
          const subpath = key === "." ? "" : key.slice(1);
          aliases.push({
            find: new RegExp(`^${escapeRegExp(`@elizaos/shared${subpath}`)}$`),
            replacement: exportTarget,
          });
        }
        return aliases;
      })(),
      ...(() => {
        const cloudSdkSrcDir = path.resolve(
          elizaRoot,
          "packages/cloud/sdk/src",
        );
        if (!fs.existsSync(path.join(cloudSdkSrcDir, "index.ts"))) {
          return [];
        }
        return [
          {
            find: /^@elizaos\/cloud-sdk$/,
            replacement: path.join(cloudSdkSrcDir, "index.ts"),
          },
          {
            find: /^@elizaos\/cloud-sdk\/redemption-contract$/,
            replacement: path.join(cloudSdkSrcDir, "redemption-contract.ts"),
          },
          {
            find: /^@elizaos\/cloud-sdk\/cloud-setup-session$/,
            replacement: path.join(
              cloudSdkSrcDir,
              "cloud-setup-session/index.ts",
            ),
          },
          {
            find: /^@elizaos\/cloud-sdk\/cloud-setup-session\/(.+)$/,
            replacement: path.join(cloudSdkSrcDir, "cloud-setup-session/$1.ts"),
          },
        ];
      })(),
      // Force local @elizaos/app-core when workspace-linked (prevents stale
      // bun cache copies from overriding the symlinked local source).
      ...(() => {
        const appCorePkgPath = path.resolve(
          elizaRoot,
          "packages/app-core/package.json",
        );
        const appCorePkgDir = path.dirname(appCorePkgPath);
        const appCoreBrowserEntry = path.resolve(
          appCorePkgDir,
          "src/browser.ts",
        );
        const appCorePkg = JSON.parse(fs.readFileSync(appCorePkgPath, "utf8"));

        const generatedAliases = [];

        for (const [key, value] of Object.entries(appCorePkg.exports || {})) {
          const exportTarget = resolvePackageExportTarget(value);
          if (!exportTarget) continue;
          if (key === ".") {
            // Keep the renderer on a browser-safe entry. The package root
            // barrel re-exports server modules that pull Node-only code like
            // sharp into the Vite client graph.
            generatedAliases.push({
              find: new RegExp(`^${escapeRegExp("@elizaos/app-core")}$`),
              replacement: appCoreBrowserEntry,
            });
            continue;
          }

          if (!key.startsWith("./")) continue;
          const sourceTarget = resolveLocalPackageSourceExportTarget(
            appCorePkgDir,
            exportTarget,
          );
          if (!sourceTarget) continue;
          generatedAliases.push({
            find: new RegExp(
              `^${escapeRegExp(`@elizaos/app-core/${key.slice(2)}`)}$`,
            ),
            replacement: sourceTarget,
          });
        }

        const uiSource = path.resolve(elizaRoot, "packages/ui/src");
        return [
          ...generatedAliases,
          {
            find: /^@elizaos\/ui$/,
            replacement: path.join(uiSource, "browser.ts"),
          },
          {
            find: /^@elizaos\/ui\/(.+)$/,
            replacement: path.join(uiSource, "$1"),
          },
          {
            find: /^@elizaos\/app-core\/first-run\/first-run-config$/,
            replacement: path.join(
              appCoreSrcRoot,
              "first-run/first-run-config.ts",
            ),
          },
          {
            find: /^@elizaos\/app-core\/api\/ios-local-agent-transport$/,
            replacement: path.join(
              appCoreSrcRoot,
              "api/ios-local-agent-transport.ts",
            ),
          },
          // #18056: thin desktop shell — avoids app-core/browser.ts star-export
          // of @elizaos/ui/browser on the packages/app main entry.
          {
            find: /^@elizaos\/app-core\/desktop-shell$/,
            replacement: path.join(appCoreSrcRoot, "desktop-shell.ts"),
          },

          {
            find: /^@elizaos\/agent$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
          },
          // @elizaos/plugin-elizacloud — the plugin ships a deliberately
          // minimal browser facade (`dist/browser/index.browser.js`) that
          // only exports the plugin descriptor + a couple of error classes.
          // `app-core/dist/api/server.js` re-exports several server-only
          // helpers (`__resetCloudBaseUrlCache`, `ensureCloudTtsApiKeyAlias`,
          // `clearCloudSecrets`, `resolveCloudTtsBaseUrl`, etc.) from the
          // plugin; without an alias Rolldown errors with MISSING_EXPORT
          // when bundling that re-export chain for the renderer. Route the
          // import to the local browser replacement, which already provides all of
          // those names as no-ops (see `platform/empty-node-module.ts`).
          {
            find: /^@elizaos\/plugin-elizacloud$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
          },
          {
            find: /^@elizaos\/plugin-google-workspace$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
          },
          // Shared browser facades import this duplicate-safe leaf directly.
          // Bind it to source before the bare-core alias so fast-dist builds do
          // not fall through to the package's Node/default compatibility shim.
          {
            find: /^@elizaos\/core\/client-public$/,
            replacement: path.resolve(
              elizaRoot,
              "packages/core/src/client-public.ts",
            ),
          },
          // @elizaos/core — force ALL copies (including nested ones in plugins
          // that bundle their own older core) to the
          // main workspace copy's browser entry.  The browser entry has all
          // needed exports and avoids pulling in createRequire/node:fs/etc.
          {
            find: /^@elizaos\/core$/,
            replacement: resolveElizaCoreBundlePath(),
          },
        ];
      })(),
    ],
  },
  optimizeDeps: {
    noDiscovery: process.env.ELIZA_APP_VITE_NO_DISCOVERY !== "0",
    // This graph is explicitly enumerated below and discovery is disabled, so
    // waiting for a crawl cannot reveal another dependency. Publish completed
    // optimizer chunks as they settle so the browser can request them in
    // parallel instead of holding the whole first-load batch.
    holdUntilCrawlEnd: false,
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router",
      "react-router/dom",
      "react-router-dom",
      // Three.js core + all subpath imports must be pre-bundled together so
      // the optimizer shares a single module identity.
      "three",
      // The marketing homepage imports the fiber renderer directly. With
      // noDiscovery enabled, serving it raw exposes scheduler's CommonJS
      // default import to the browser and breaks the local marketing preview.
      "@react-three/fiber",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/libs/meshopt_decoder.module.js",
      "three/examples/jsm/loaders/DRACOLoader.js",
      "three/examples/jsm/loaders/GLTFLoader.js",
      "three/examples/jsm/loaders/FBXLoader.js",
      // Browser-safe deps that are otherwise served raw, file-by-file in dev
      // (noDiscovery is on, so only this list is pre-bundled). Each entry here
      // collapses dozens of cold-load module round-trips into one bundled chunk.
      // lucide-react alone is ~250 per-icon requests once the build-only
      // per-icon rewrite is disabled in dev; the rest are multi-file ESM libs.
      "lucide-react",
      "recharts",
      "nprogress",
      "cookie",
      "yaml",
      "uuid",
      "adze",
      // zod is safe to pre-bundle on Vite v8 + Rolldown and collapses roughly 90
      // raw per-load module round-trips (zod v4 core + all locales) into one
      // chunk.
      // zod/v3 and zod/v4 are separate package entry points: a few sources
      // import "zod/v3" (the v3 compat surface) directly, which the bare "zod"
      // pre-bundle does not cover, so pre-bundle those subpaths too.
      "zod",
      "zod/v3",
      "zod/v4",
      // Calendar packages are pre-bundled only after resolution. Vite treats
      // optimizeDeps.include as required even when react-day-picker exposes a
      // calendar system as an optional integration.
      ...calendarOptimizeDeps({
        reactDayPickerEntry,
        dateFnsEntry,
        dateFnsLocaleEntry,
        dateFnsJalaliEntry,
        dateFnsJalaliLocaleEntry,
      }),
      // Resolvable via the resolve.alias above (transitive through @elizaos/core).
      "@opentelemetry/api",
    ],
    // Remap node: builtins to npm polyfills during dep optimization so
    // Rolldown doesn't externalize them as browser-incompatible node:* imports.
    rolldownOptions: {
      plugins: [
        {
          name: "workspace-jsx-in-js",
          async transform(code, id) {
            const normalizedPath = id.split("?")[0]?.split(path.sep).join("/");
            if (
              !id.endsWith(".js") ||
              !normalizedPath?.startsWith(
                `${appCoreSrcRoot.split(path.sep).join("/")}/`,
              )
            ) {
              return null;
            }

            return transformWithOxc(code, id, {
              lang: "jsx",
              jsx: "automatic",
              sourcemap: true,
            });
          },
        },
        {
          name: "node-builtins-polyfill",
          resolveId(source) {
            const polyfill = optimizerNodePolyfills[source];
            if (polyfill) return polyfill;
            if (source.startsWith("node:")) return `\0node-stub:${source}`;
            return null;
          },
          load(id) {
            if (!id.startsWith("\0node-stub:")) return null;
            return generateNodeBuiltinStub(
              id.slice("\0node-stub:".length),
              _require,
            );
          },
        },
        // es-toolkit@1.47 `./compat/*` is CJS-only, and its CJS implementation
        // names a local `require_isUnsafeProperty` that collides with the dep
        // optimizer's CJS interop helper. Resolve each
        // `es-toolkit/compat/<name>` to its ESM `dist/compat/**/<name>.mjs`
        // and re-export the named binding as default so the optimizer stays off
        // the incompatible CJS path. Raw-serve uses the counterpart in `plugins`.
        makeEsToolkitCompatEsmPlugin("optimize"),
      ],
    },
    exclude: [
      "node-llama-cpp",
      "@node-llama-cpp/mac-arm64-metal",
      // Contains native-only pty-state-capture / pty-console imports; skip pre-bundling.
      "@elizaos/plugin-agent-orchestrator",
      "pty-console",
      // chalk + drizzle-orm: Node-only deps that never run in the
      // renderer. Excluded from dep-optimisation so the
      // nativeModuleStubPlugin can replace them at resolve-time with
      // browser-safe Proxy stubs (otherwise rolldown emits a bare
      // `import "chalk"` that the browser can't resolve).
      "chalk",
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "drizzle-orm/pglite",
      "drizzle-orm/neon-http",
      // Built-in secrets live in @elizaos/core features; Vite must not externalize them as a separate package.
      // Node-only HTTP client — crashes in browser, stub via nativeModuleStubPlugin
      "undici",
      // Browser automation is server-only and pulls in proxy-agent/httpUtil.
      "puppeteer-core",
      "@puppeteer/browsers",
      // Native LLM embedding — uses node-llama-cpp, never runs in browser
      "@elizaos/plugin-local-inference",
      // Node-only connector; LifeOps server services may dynamically import it,
      // but the renderer must not parse its Baileys/qrcode-terminal graph.
      "@elizaos/plugin-whatsapp",
      // Native keychain bindings (.node). Dep optimization treats .node as text → UTF-8 error.
      "@napi-rs/keyring",
      // Pulls `@napi-rs/keyring` dynamically; excluding avoids the optimizer crawling native bindings.
      "@elizaos/vault",
    ],
  },
  build: {
    outDir: path.resolve(here, "dist"),
    // Watch + incremental: avoid wiping dist each cycle; keeps Electrobun reloads fast.
    emptyOutDir: !desktopFastDist,
    sourcemap: desktopFastDist ? false : enableAppSourceMaps,
    target: "es2022",
    // The desktop/web shell intentionally ships a large eagerly-loaded main
    // chunk; warn only when it grows beyond the current known baseline.
    chunkSizeWarningLimit: 5500,
    minify: desktopFastDist ? false : undefined,
    cssMinify: desktopFastDist ? false : undefined,
    reportCompressedSize: !desktopFastDist,
    // #18056: do not inject <link rel="modulepreload"> for the entire static
    // import graph of main. That was ~350 preloads (~1.7–2.5 MB transfer on
    // cold /login before the user interacts). Browser still fetches modules
    // on demand when they are actually imported (public login only pulls the
    // CloudRouterShell + login chunk tree).
    modulePreload: false,
    rolldownOptions: {
      plugins: [
        // Rolldown build-phase resolver for @opentelemetry/api.
        // The `ai` package imports @opentelemetry/api but it is not hoisted to
        // the workspace root in bun canary's content-addressable layout. The
        // resolve.alias above covers the case when otelApiEntry is resolved, but
        // when the bun store layout differs in CI the alias may be absent.
        // This plugin is a safety net: it resolves the bare specifier to the
        // same entry the alias would use, falling back to a browser telemetry module.
        ...(otelApiEntry
          ? [
              {
                name: "otel-api-build-resolver",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return otelApiEntry;
                  return null;
                },
              },
            ]
          : [
              {
                name: "otel-api-build-fallback",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return "\0otel-api-fallback";
                  return null;
                },
                load(id: string) {
                  if (id === "\0otel-api-fallback") {
                    // Minimal browser telemetry module that satisfies the `trace`, `context`,
                    // `propagation`, `metrics`, `diag`, `SpanStatusCode` and
                    // `SpanKind` named exports that `ai` reads at import time.
                    return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
                  }
                  return null;
                },
              },
            ]),
      ],
      checks: {
        eval: false,
        pluginTimings: false,
      },
      onLog(level, log, defaultHandler) {
        if (level === "warn" && isKnownToleratedBuildWarning(log)) {
          return;
        }
        defaultHandler(level, log);
      },
      onwarn(warning, warn) {
        if (isKnownToleratedBuildWarning(warning)) {
          return;
        }
        warn(warning);
      },
      // Native-only deps that must not be resolved during the browser build.
      // Node built-ins (node:fs, fs, path, etc.) are NOT externalized here —
      // they are intercepted by nativeModuleStubPlugin which replaces them
      // with browser fallback Proxy modules. Externalizing them causes Rollup to emit
      // bare `import "node:fs"` in output chunks, which the browser rejects
      // with a CSP violation.
      external: (id) => {
        if (
          [
            "pty-state-capture",
            "pty-console",
            "electron",
            "node-llama-cpp",
            "pty-manager",
            // chalk + drizzle-orm intentionally NOT externalised here:
            // marking them external leaves a bare ESM specifier in the
            // output bundle (e.g. `import "chalk"`), which the browser
            // can't resolve. They are stubbed at resolve-time by
            // nativeModuleStubPlugin instead.
          ].includes(id)
        )
          return true;
        if (/^@node-llama-cpp\//.test(id)) return true;
        if (/^@napi-rs\/keyring/.test(id)) return true;
        return false;
      },
      input: {
        main: path.resolve(here, "index.html"),
      },
    },
    // rollupOptions is the only bundle-options key Vite reads. The sibling
    // `rolldownOptions` block above configures Rolldown-specific checks only;
    // chunk-splitting and the otel fallback must live under rollupOptions so
    // classic Rollup builds receive them too.
    rollupOptions: {
      output: {
        // Manual chunk-splitting. `@elizaos/vitest-vite` builds with classic
        // Rollup, whose chunking API is `output.manualChunks`. Keeping this
        // under `rollupOptions.output` prevents the bn.js/crypto graph from
        // folding into eager locale chunks; `scripts/verify-chunk-safety.mjs`
        // gates the startup-order invariant (#9150).
        manualChunks: resolveManualChunk,
      },
      plugins: [
        ...(otelApiEntry
          ? [
              {
                name: "otel-api-build-resolver",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return otelApiEntry;
                  return null;
                },
              },
            ]
          : [
              {
                name: "otel-api-build-fallback",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return "\0otel-api-fallback";
                  return null;
                },
                load(id: string) {
                  if (id !== "\0otel-api-fallback") return null;
                  return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
                },
              },
            ]),
      ],
      onwarn(warning, warn) {
        if (isKnownToleratedBuildWarning(warning)) {
          return;
        }
        warn(warning);
      },
    },
  },
  server: {
    host: true,
    port: uiPort,
    strictPort: true,
    // Proactively transform the boot entry's import graph at server start
    // instead of lazily on the first browser request. On this app the eager
    // graph is large (~1200 workspace source modules), so warming it parallelizes
    // the transform work and shortens cold-load TTFB after a server (re)start.
    warmup: { clientFiles: ["src/main.tsx"] },
    // Only pin the dev origin when the desktop shell explicitly asks for a
    // loopback public URL. Capacitor live reload and LAN/browser clients need
    // Vite to keep serving the current request host instead of rewriting
    // module URLs back to 127.0.0.1.
    ...(viteDevServerRuntime.origin
      ? { origin: viteDevServerRuntime.origin }
      : {}),
    hmr: viteDevServerRuntime.hmr,
    cors: {
      origin: true,
      credentials: true,
    },
    proxy: {
      ...(localVoiceGatewayPort
        ? {
            "/api/v1/voice": {
              target: `http://127.0.0.1:${localVoiceGatewayPort}`,
              changeOrigin: true,
              xfwd: true,
              ws: true,
              configure: (proxy) => {
                proxy.on("error", (_err, _req, res) => {
                  if ("headersSent" in res && !res.headersSent) {
                    res.writeHead(502, {
                      "Content-Type": "application/json",
                    });
                    res.end(
                      JSON.stringify({
                        error: "Local voice gateway unavailable",
                      }),
                    );
                  }
                });
              },
            },
          }
        : {}),
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        // Keep Host aligned with the browser's same-origin Origin. Rewriting
        // Host to the upstream API port while preserving Origin at the Vite
        // port makes the loopback trust boundary correctly reject the request
        // as an authority mismatch, stranding a local browser on Pairing/Login.
        changeOrigin: false,
        xfwd: true,
        configure: configureDevApiProxy,
      },
      "/ws": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
        configure: (proxy) => {
          // Suppress noisy ECONNREFUSED errors during API restart.
          // Clients reconnect automatically via the WS reconnect loop.
          proxy.on("error", () => {});
        },
      },
      // elizaOS plugin-music-player HTTP routes live outside /api (e.g. /music-player/stream).
      "/music-player": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "API server unavailable" }));
            }
          });
        },
      },
    },
    fs: {
      // Allow serving files from the app directory and eliza src
      allow: [
        here,
        elizaRoot,
        ...(fs.existsSync(bunLinkedPackageCacheRoot)
          ? [bunLinkedPackageCacheRoot]
          : []),
      ],
    },
    watch: {
      // Polling is only needed in Docker/WSL where native fs events are unreliable
      usePolling: process.env[BRANDED_ENV.devPolling] === "1",
      // Electrobun postBuild copies renderer HTML/assets into electrobun/build/.
      // Watching those paths triggers full reloads while deps are still optimizing,
      // which breaks with "chunk-*.js does not exist" in node_modules/.vite/deps.
      // Benchmark packages are large offline fixture trees; the desktop renderer
      // does not import them, and watching them can exhaust the kernel watcher
      // limit before the desktop renderer is interactive.
      ignored: [
        "**/electrobun/build/**",
        "**/electrobun/artifacts/**",
        "**/packages/app/.vite/**",
        "**/packages/**/.turbo/**",
        "**/packages/**/.wrangler/**",
        "**/packages/agent/.elizadb/**",
        "**/packages/agent/data/**",
        "**/packages/**/dist/**",
        "**/packages/**/*.log",
        "**/packages/**/*.md",
        "**/plugins/**/.turbo/**",
        "**/*.d.ts",
        "**/*.d.ts.map",
        "**/*.tsbuildinfo",
        "**/packages/**/output/generated-cad/**",
        "**/packages/**/src/i18n/generated/**",
        "**/packages/training/data/raw/**",
        "**/plugin-local-inference/native/audio-fixtures/**",
        "**/plugin-local-inference/src/services/__tests__/**",
      ],
    },
  },
}));
