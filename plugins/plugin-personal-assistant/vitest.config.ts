/**
 * Base Vitest configuration for the plugin: extends the repo default config and
 * wires the LifeOps and app-core test setup, stub roots, and workspace aliases
 * so unit specs resolve source and native-library policy correctly.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";
import { repoRoot } from "../../packages/scripts/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../packages/scripts/vitest/workspace-aliases";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = getElizaWorkspaceRoot(repoRoot);
const packageRootFromRepo = path
  .relative(elizaRoot, here)
  .split(path.sep)
  .join("/");
const appCoreTestSetup = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "test",
  "setup.ts",
);
const lifeopsTestSetup = path.join(here, "test", "setup.ts");
const lifeopsTestStubsRoot = path.join(here, "test", "stubs");
const appCoreNativeLibraryPolicy = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "src",
  "platform",
  "native-library-policy.ts",
);
const appCoreTaskHostCapabilities = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "src",
  "services",
  "task-host-capabilities.ts",
);
const agentSourceRoot = path.join(elizaRoot, "packages", "agent", "src");
const corePackageRequire = createRequire(
  path.join(elizaRoot, "packages", "core", "package.json"),
);
const lifeopsPackageRequire = createRequire(path.join(here, "package.json"));
const escapedAgentSourceRoot = agentSourceRoot.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const optionalCorePluginStubPrefix = "\0lifeops-optional-core-plugin-stub:";
const optionalCorePluginStubPackages = new Set([
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-pty",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-video",
  "@elizaos/plugin-vision",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-native-filesystem",
  "@elizaos/plugin-app-manager",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-inbox/plugin",
  "@elizaos/plugin-zerollama",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
]);
const agentSourceJsToTsPlugin = {
  name: "lifeops-agent-source-js-to-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (optionalCorePluginStubPackages.has(source)) {
      return `${optionalCorePluginStubPrefix}${source}`;
    }
    if (source === "@elizaos/agent") {
      return path.join(lifeopsTestStubsRoot, "agent.ts");
    }
    if (source === "@elizaos/agent/api/connector-account-routes") {
      return path.join(agentSourceRoot, "api", "connector-account-routes.ts");
    }
    if (source === "@elizaos/agent/api/zip-utils") {
      return path.join(agentSourceRoot, "api", "zip-utils.ts");
    }
    if (source === "@elizaos/agent/services/agent-backup") {
      return path.join(agentSourceRoot, "services", "agent-backup.ts");
    }
    if (source === "@elizaos/agent/services/agent-backup-authority") {
      return path.join(
        agentSourceRoot,
        "services",
        "agent-backup-authority.ts",
      );
    }
    if (source === "@elizaos/agent/api/server-helpers") {
      return path.join(agentSourceRoot, "api", "server-helpers.ts");
    }
    if (source === "@elizaos/agent/runtime/plugin-collector") {
      return path.join(agentSourceRoot, "runtime", "plugin-collector.ts");
    }
    if (source === "@elizaos/ui") {
      return path.join(lifeopsTestStubsRoot, "ui.ts");
    }
    if (source === "@elizaos/plugin-google-workspace") {
      return path.join(lifeopsTestStubsRoot, "plugin-google-workspace.ts");
    }

    const normalizedImporter = importer?.replace(/^\/@fs/, "");
    if (
      normalizedImporter &&
      (source.startsWith("./") || source.startsWith("../")) &&
      source.endsWith(".js")
    ) {
      const candidate = path.resolve(path.dirname(normalizedImporter), source);
      if (candidate.startsWith(`${agentSourceRoot}${path.sep}`)) {
        const tsCandidate = `${candidate.slice(0, -".js".length)}.ts`;
        if (fs.existsSync(tsCandidate)) {
          return tsCandidate;
        }
      }
    }

    return null;
  },
  load(id: string) {
    if (!id.startsWith(optionalCorePluginStubPrefix)) return null;
    const packageName = id.slice(optionalCorePluginStubPrefix.length);
    const name = `${packageName.slice("@elizaos/".length)}-test-stub`;
    return [
      `const plugin = ${JSON.stringify({
        name,
        description: `Test stub for ${packageName}`,
        actions: [],
        providers: [],
        evaluators: [],
        services: [],
      })};`,
      "export { plugin };",
      "export default plugin;",
    ].join("\n");
  },
};
function resolveNodePackageRoot(packageName: string): string {
  const directCandidates = [
    path.join(elizaRoot, "node_modules", packageName),
    path.join(repoRoot, "node_modules", packageName),
    path.join(here, "node_modules", packageName),
  ];
  for (const candidate of directCandidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  const bunStoreRoot = path.join(repoRoot, "node_modules", ".bun");
  if (fs.existsSync(bunStoreRoot)) {
    const match = fs
      .readdirSync(bunStoreRoot)
      .find((entry) => entry.startsWith(`${packageName}@`));
    if (match) {
      return path.join(bunStoreRoot, match, "node_modules", packageName);
    }
  }

  return path.join(here, "node_modules", packageName);
}

function resolveCorePackageEntry(packageName: string): string {
  return corePackageRequire.resolve(packageName);
}

function resolveCorePackageRoot(packageName: string): string {
  return path.dirname(
    corePackageRequire.resolve(path.join(packageName, "package.json")),
  );
}

const reactRoot = resolveNodePackageRoot("react");
const reactDomRoot = resolveNodePackageRoot("react-dom");
// Bun's isolated install puts the logger's transitive deps deep under
// `node_modules/.bun/...`. Vite's default resolver, walking up from the
// (realpath of) `packages/logger/src/logger.ts`, sees the local
// `packages/logger/node_modules/<dep>` symlink — but after `preserveSymlinks:
// false` it resolves to a path that Vite then re-walks for nested deps and
// loses the chain on Windows. Anchor adze/fast-redact explicitly to their
// real install dirs so resolution is one hop on every platform.
const adzeRoot = resolveNodePackageRoot("adze");
const fastRedactRoot = resolveNodePackageRoot("fast-redact");
const aiEntry = resolveCorePackageEntry("ai");
const fsExtraEntry = lifeopsPackageRequire.resolve("fs-extra");
const handlebarsEntry = resolveCorePackageEntry("handlebars");
const mammothEntry = resolveCorePackageEntry("mammoth");
const markdownItRoot = resolveCorePackageRoot("markdown-it");
const telegramSessionsEntry = path.join(
  elizaRoot,
  "plugins",
  "plugin-telegram",
  "node_modules",
  "telegram",
  "sessions",
  "index.js",
);
const pluginHealthSrc = path.join(elizaRoot, "plugins", "plugin-health", "src");
// The spatial view framework (`@elizaos/ui/spatial`) is browser-safe and
// self-contained; the LifeOps spatial-view test needs the real renderer (not the
// `@elizaos/ui` stub) plus the retained future-modality seam. Anchor those
// subpaths to source ahead of the broad `@elizaos/ui/(.+)` stub alias below.
const uiSpatialSrc = path.join(
  elizaRoot,
  "packages",
  "ui",
  "src",
  "spatial",
  "index.ts",
);
const uiSpatialTuiSrc = path.join(
  elizaRoot,
  "packages",
  "ui",
  "src",
  "spatial",
  "tui",
  "index.ts",
);

const defaultUnitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*-live.test.{ts,tsx}",
  "**/*.live.test.{ts,tsx}",
  "**/*-real.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  root: elizaRoot,
  plugins: [
    ...(Array.isArray(baseConfig.plugins) ? baseConfig.plugins : []),
    agentSourceJsToTsPlugin,
  ],
  ssr: {
    ...baseConfig.ssr,
    noExternal: [
      "@elizaos/agent",
      "@elizaos/ui",
      ...(Array.isArray(baseConfig.ssr?.noExternal)
        ? baseConfig.ssr.noExternal
        : []),
    ],
  },
  resolve: {
    ...baseConfig.resolve,
    preserveSymlinks: false,
    alias: [
      {
        find: /^@elizaos\/app-core\/api\/compat-route-shared$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "app-core",
          "src",
          "api",
          "compat-route-shared.ts",
        ),
      },
      {
        find: /^@elizaos\/app-core\/api\/auth$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "app-core",
          "src",
          "api",
          "auth.ts",
        ),
      },
      {
        find: /^@elizaos\/app-core\/services\/auth-store$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "app-core",
          "src",
          "services",
          "auth-store.ts",
        ),
      },
      // The real agent runtime loads audio-redaction services while this lane
      // boots the OWNER/USER matrix. This specialized alias list replaces the
      // base shared-source aliases, so keep these two package subpaths anchored
      // to their source modules instead of requiring prebuilt shared/core dist.
      {
        find: /^@elizaos\/shared\/audio-redaction$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "shared",
          "src",
          "audio-redaction.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/audio-redaction-verify$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "shared",
          "src",
          "audio-redaction-verify.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/api\/connector-account-routes$/,
        replacement: path.join(
          agentSourceRoot,
          "api",
          "connector-account-routes.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/api\/server-helpers$/,
        replacement: path.join(agentSourceRoot, "api", "server-helpers.ts"),
      },
      {
        // The real plugin collector, so a runtime test can register plugins
        // in the order the standalone agent derives (#30943).
        find: /^@elizaos\/agent\/runtime\/plugin-collector$/,
        replacement: path.join(
          agentSourceRoot,
          "runtime",
          "plugin-collector.ts",
        ),
      },
      {
        find: /^@elizaos\/app-core\/platform\/native-library-policy$/,
        replacement: appCoreNativeLibraryPolicy,
      },
      // Registered HTTP routes must exercise the real owner authentication
      // boundary even when app-core's distribution has not been built.
      {
        find: /^@elizaos\/app-core\/api\/(auth|compat-route-shared)$/,
        replacement: path.join(elizaRoot, "packages/app-core/src/api/$1.ts"),
      },
      {
        find: /^@elizaos\/app-core\/services\/auth-store$/,
        replacement: path.join(
          elizaRoot,
          "packages/app-core/src/services/auth-store.ts",
        ),
      },
      {
        find: /^@elizaos\/app-core\/services\/task-host-capabilities$/,
        replacement: appCoreTaskHostCapabilities,
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "core",
          "src",
          "index.node.ts",
        ),
      },
      {
        find: /^@elizaos\/core\/edge$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "core",
          "src",
          "index.edge.ts",
        ),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "vault",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/contracts\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "contracts",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/contracts$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "contracts",
          "src",
          "index.ts",
        ),
      },
      // These packages are imported by @elizaos/core while this suite inlines
      // core. Resolve them through Bun's real package-store path so their own
      // nested dependencies remain visible with preserveSymlinks enabled.
      {
        find: /^adze$/,
        replacement: path.join(adzeRoot, "dist", "index.js"),
      },
      {
        find: /^adze\/(.*)$/,
        replacement: path.join(adzeRoot, "$1"),
      },
      {
        find: /^fast-redact$/,
        replacement: path.join(fastRedactRoot, "index.js"),
      },
      { find: /^ai$/, replacement: aiEntry },
      { find: /^fs-extra$/, replacement: fsExtraEntry },
      { find: /^handlebars$/, replacement: handlebarsEntry },
      { find: /^mammoth$/, replacement: mammothEntry },
      {
        find: /^markdown-it$/,
        replacement: path.join(markdownItRoot, "index.mjs"),
      },
      {
        find: new RegExp(`^${escapedAgentSourceRoot}/(.+)\\.js$`),
        replacement: `${agentSourceRoot}/$1.ts`,
      },
      {
        find: new RegExp(`^/@fs${escapedAgentSourceRoot}/(.+)\\.js$`),
        replacement: `${agentSourceRoot}/$1.ts`,
      },
      // Real spatial renderer for the future-modality view test. These must
      // precede the broad `@elizaos/ui/(.+)` stub alias so they win the match.
      { find: /^@elizaos\/ui\/spatial\/tui$/, replacement: uiSpatialTuiSrc },
      { find: /^@elizaos\/ui\/spatial$/, replacement: uiSpatialSrc },
      // React-free renderer-service lifecycle registry: the register-entry
      // tests exercise the REAL registry (scope gating, disposer retention),
      // so anchor it to source ahead of the broad ui stub alias.
      {
        find: /^@elizaos\/ui\/platform\/renderer-services$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "ui",
          "src",
          "platform",
          "renderer-services.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/app-shell-registry$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "ui",
          "src",
          "app-shell-registry.ts",
        ),
      },
      // Pure-data settings-section metadata consumed by app-control's settings
      // action (#14804) — React-free by design, so anchor the real module
      // ahead of the broad ui stub alias.
      {
        find: /^@elizaos\/ui\/components\/settings\/settings-section-meta$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "ui",
          "src",
          "components",
          "settings",
          "settings-section-meta.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      {
        find: "@elizaos/ui",
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      // `@elizaos/plugin-calendar`'s built dist pulls `renderGroundedActionReply`
      // from the `@elizaos/agent/actions/grounded-action-reply` subpath (to dodge
      // the full agent barrel in the Plugin Tests lane). The bare-specifier alias
      // below prefix-matches that subpath and rewrites it to `agent.ts/actions/...`,
      // which is unresolvable — so anchor the subpath to the stub explicitly first.
      // Other agent subpaths (e.g. services/app-session-gate) must keep resolving
      // to the real source, so this stays narrow rather than a `/(.+)` catch-all.
      {
        find: /^@elizaos\/agent\/actions\/grounded-action-reply$/,
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
      {
        find: /^@elizaos\/agent\/security\/access$/,
        replacement: path.join(agentSourceRoot, "security", "access.ts"),
      },
      // The owner-scope invariant test exercises the real chat-surface and
      // trust-fallback owner derivations; anchor both to source ahead of the
      // bare `@elizaos/agent` stub alias below.
      {
        find: /^@elizaos\/agent\/api\/zip-utils$/,
        replacement: path.join(agentSourceRoot, "api", "zip-utils.ts"),
      },
      {
        find: /^@elizaos\/agent\/api\/client-chat-admin$/,
        replacement: path.join(agentSourceRoot, "api", "client-chat-admin.ts"),
      },
      {
        find: /^@elizaos\/agent\/runtime\/owner-entity$/,
        replacement: path.join(agentSourceRoot, "runtime", "owner-entity.ts"),
      },
      {
        find: /^@elizaos\/agent\/services\/knowledge-graph$/,
        replacement: path.join(
          agentSourceRoot,
          "services",
          "knowledge-graph",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/services\/knowledge-graph\/service$/,
        replacement: path.join(
          agentSourceRoot,
          "services",
          "knowledge-graph",
          "service.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/config\/config$/,
        replacement: path.join(agentSourceRoot, "config", "config.ts"),
      },
      {
        find: /^@elizaos\/agent\/config\/paths$/,
        replacement: path.join(agentSourceRoot, "config", "paths.ts"),
      },
      {
        find: /^@elizaos\/agent\/services\/agent-backup-authority$/,
        replacement: path.join(
          agentSourceRoot,
          "services",
          "agent-backup-authority.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/services\/agent-backup$/,
        replacement: path.join(agentSourceRoot, "services", "agent-backup.ts"),
      },
      {
        find: "@elizaos/agent",
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
      {
        find: /^@elizaos\/plugin-workflow$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-workflow",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-calendar\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-calendar",
          "src",
          "$1.ts",
        ),
      },
      // The agent's settings action pulls createSettingsAction +
      // parseSettingsRequest from the `@elizaos/plugin-app-control` barrel
      // (#14804), but app-control's build bundles only the barrel — there is
      // no per-file dist and vitest has no eliza-source condition. Anchor the
      // bare specifier to the file stub (which re-exports the real settings
      // module) and subpaths to source. These must be alias entries, not
      // resolveId stubs: vite:alias runs before user plugins, so baseConfig's
      // installed-package alias for this plugin would otherwise win and
      // resolve a stale published dist that lacks the settings exports.
      {
        find: /^@elizaos\/plugin-app-control$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-app-control.ts"),
      },
      {
        find: /^@elizaos\/plugin-app-control\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-app-control",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-calendar$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-calendar",
          "src",
          "index.ts",
        ),
      },
      // Lifeops decomposition: plugin-inbox / plugin-blocker are carved deps that
      // are NOT in build:core, so their unbuilt dist can't satisfy the subpath +
      // barrel imports plugin-personal-assistant pulls from them (vitest has no
      // eliza-source condition; bare resolution falls through to missing dist).
      // Anchor both to source (mirrors the plugin-workflow alias above). Subpath
      // rules must precede the barrels so deeper paths match first.
      {
        find: /^@elizaos\/plugin-inbox\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-inbox",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-inbox$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-inbox",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-blocker\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-blocker",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-blocker$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-blocker",
          "src",
          "index.ts",
        ),
      },
      // Further lifeops carves p-a imports as bare barrels AND deep subpaths
      // (data-layer plugins not in build:core, no eliza-source condition) — the
      // package `exports` map only sends subpaths to ./src under the eliza-source
      // condition, so without dist they resolve to missing ./dist/*.js. Anchor
      // both the barrel and every subpath to source, same as plugin-blocker.
      {
        find: /^@elizaos\/plugin-finances\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-finances",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-finances$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-finances",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-goals\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-goals",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-goals$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-goals",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-reminders\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-reminders",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-reminders$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-reminders",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-scheduling$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-scheduling",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-whatsapp$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-whatsapp",
          "src",
          "index.ts",
        ),
      },
      // The scenario-corpus gate dynamically imports every scenario file, and the
      // first-run onboarding helper (test/scenarios/_helpers/first-run-onboarding.ts)
      // pulls PA's OWN deep modules through the package specifier
      // (`@elizaos/plugin-personal-assistant/lifeops/first-run/*`). PA is not in
      // build:core and this lane has no eliza-source condition, so the package
      // `exports` `./*` wildcard would send those subpaths to a `./dist/*.js` that
      // never gets built. Anchor PA self-subpaths to source (the base workspace-app
      // config only source-aliases the barrel, and the exports-alias builder skips
      // the wildcard entry).
      {
        find: /^@elizaos\/plugin-personal-assistant\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-personal-assistant",
          "src",
          "$1.ts",
        ),
      },
      // The scenario-corpus gate (test/executive-assistant-scenarios.test.ts)
      // imports the real scenario loader from source; loader.ts references its
      // own package via `@elizaos/scenario-runner/schema`, a self-referencing
      // package-exports import Vite's resolver does not support. Anchor the
      // subpath to the prebuilt schema entry the exports map points at.
      {
        find: /^@elizaos\/scenario-runner\/schema$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "scenario-runner",
          "schema",
          "index.js",
        ),
      },
      // The scenario corpus imports shared assertion helpers through
      // `@elizaos/scenario-runner/scenario-assertions` — the same
      // package-exports subpath shape as `/schema` above, which this lane
      // cannot resolve (the `./*` exports wildcard points at a `./dist/*.js`
      // that plugin-tests never builds). Anchor it to source; its only
      // package import is `/schema`, covered by the alias above.
      {
        find: /^@elizaos\/scenario-runner\/scenario-assertions$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "scenario-runner",
          "src",
          "scenario-assertions.ts",
        ),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.join(reactRoot, "jsx-dev-runtime.js"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(reactRoot, "jsx-runtime.js"),
      },
      { find: /^react$/, replacement: path.join(reactRoot, "index.js") },
      { find: /^react\/(.*)$/, replacement: path.join(reactRoot, "$1") },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(reactDomRoot, "client.js"),
      },
      {
        find: /^react-dom\/server$/,
        replacement: path.join(reactDomRoot, "server.js"),
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: path.join(reactDomRoot, "test-utils.js"),
      },
      { find: /^react-dom$/, replacement: path.join(reactDomRoot, "index.js") },
      {
        find: /^react-dom\/(.*)$/,
        replacement: path.join(reactDomRoot, "$1"),
      },
      {
        find: /^@capacitor\/core$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "app-core",
          "test",
          "stubs",
          "capacitor-core.ts",
        ),
      },
      { find: /^telegram\/sessions$/, replacement: telegramSessionsEntry },
      {
        find: /^@elizaos\/plugin-browser\/password-manager-bridge$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-browser",
          "src",
          "password-manager-bridge.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-browser\/schema$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-browser",
          "src",
          "schema.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-x\/lifeops-message-adapter$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-x",
          "src",
          "lifeops-message-adapter.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-phone\/twilio$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-phone",
          "src",
          "twilio.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/cloud\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-elizacloud",
          "src",
          "cloud",
          "$1.ts",
        ),
      },
      // PA's barrel re-exports the travel-provider relay route from
      // `@elizaos/plugin-elizacloud/routes/*`. elizacloud is stubbed at the
      // barrel and not in build:core, so — exactly like the `/cloud/` subpath
      // above — this deep subpath must be anchored to source; without it the
      // package `exports` map sends it to a `./dist/*.js` that never gets built
      // in this lane.
      {
        find: /^@elizaos\/plugin-elizacloud\/routes\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-elizacloud",
          "src",
          "routes",
          "$1.ts",
        ),
      },
      {
        // CalendarService imports the dependency-light runtime error classes
        // from this subpath. The src-integration lane does not build workspace
        // dist first, so resolve the subpath to source just as the bare package
        // is resolved to its test stub below.
        find: /^@elizaos\/plugin-google-workspace\/calendar$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-google-workspace",
          "src",
          "calendar.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-google-workspace$/,
        replacement: path.join(
          lifeopsTestStubsRoot,
          "plugin-google-workspace.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-elizacloud$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-elizacloud.ts"),
      },
      {
        // service-mixin-discord imports the browser-scraper helpers from the
        // `/user-account-scraper` subpath; discord isn't in build:core so there
        // is no dist, and the bare alias below only catches the barrel. Point the
        // subpath at the same stub (it exports probeDiscordTab et al.) so the
        // suite never pulls the real browser-automation module.
        find: /^@elizaos\/plugin-discord\/user-account-scraper$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-discord.ts"),
      },
      {
        find: /^@elizaos\/plugin-discord$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-discord.ts"),
      },
      {
        find: /^@elizaos\/plugin-health$/,
        replacement: path.join(pluginHealthSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-health\/(.+)$/,
        replacement: path.join(pluginHealthSrc, "$1"),
      },
      ...(Array.isArray(baseConfig.resolve?.alias)
        ? baseConfig.resolve.alias
        : []),
      {
        find: "@elizaos/ui",
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      {
        find: "@elizaos/agent",
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
    ],
  },
  test: {
    ...baseConfig.test,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      `${packageRootFromRepo}/src/**/*.test.ts`,
      `${packageRootFromRepo}/src/**/*.test.tsx`,
      `${packageRootFromRepo}/test/**/*.test.ts`,
      `${packageRootFromRepo}/test/**/*.test.tsx`,
      `${packageRootFromRepo}/extensions/**/*.test.ts`,
      `${packageRootFromRepo}/extensions/**/*.test.tsx`,
    ],
    exclude: defaultUnitExcludes,
    setupFiles: [lifeopsTestSetup, appCoreTestSetup],
    server: {
      ...baseConfig.test?.server,
      deps: {
        ...baseConfig.test?.server?.deps,
        inline: true,
      },
    },
    coverage: {
      ...baseConfig.test?.coverage,
      include: [
        `${packageRootFromRepo}/src/**/*.{ts,tsx}`,
        `${packageRootFromRepo}/scripts/run-cerebras-journey-eval.mjs`,
      ],
      exclude: [
        `${packageRootFromRepo}/src/**/*.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.live.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.real.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.integration.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.e2e.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.live.e2e.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.real.e2e.test.{ts,tsx}`,
      ],
    },
  },
});
