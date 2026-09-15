/**
 * Drives the view import guard against real files so absent bundles and
 * unsupported bare imports remain distinct hard failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertViewBundleExports,
  bareImportSpecifiers,
  getHostExternalSpecifiers,
  hostExternalSpecifiersFromSources,
  validateViewBundles,
  viewOutputEntryKind,
} from "../view-bundle-import-guard.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "view-import-guard-"));
  tempDirs.push(root);
  const workspaceDir = "plugins/plugin-fixture";
  const absoluteDir = path.join(root, workspaceDir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  fs.writeFileSync(
    path.join(absoluteDir, "vite.config.views.ts"),
    "export {};\n",
  );
  const workspace = {
    name: "@fixture/plugin-fixture",
    dir: workspaceDir,
    packageJson: {
      name: "@fixture/plugin-fixture",
      devDependencies: {
        vite: "^8.0.0",
      },
      scripts: {
        "build:views": "bunx --bun vite build --config vite.config.views.ts",
      },
    },
  };
  fs.writeFileSync(
    path.join(absoluteDir, "package.json"),
    `${JSON.stringify(workspace.packageJson)}\n`,
  );
  return {
    root,
    absoluteDir,
    options: {
      repoRoot: root,
      workspacePackages: [workspace],
      repositoryFiles: [`${workspaceDir}/vite.config.views.ts`],
      allowedSpecifiers: ["react"],
    },
  };
}

describe("view bundle import guard", () => {
  // First test in the file pays module-import warmup on a loaded CI runner
  // (observed >7s), so it carries an explicit timeout above the 5s default.
  test("reports a configured bundle that was not built", async () => {
    const { options } = fixture();
    const result = await validateViewBundles({
      ...options,
      enforceFreshOutputs: true,
    });
    expect(result.bundleCount).toBe(0);
    expect(result.expectedBundleCount).toBe(1);
    expect(result.missingBundles).toHaveLength(1);
    expect(result.violations).toEqual([]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  }, 30_000);

  test("reports unsupported imports from a real emitted bundle", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      'const documentation = "import from fake"; import React from "react";\nimport x from "@fixture/missing"; export { y } from "@fixture/exported";\nimport("@fixture/dynamic"); export { x, documentation };\n',
    );

    const result = await validateViewBundles(options);
    expect(result.missingBundles).toEqual([]);
    expect(result.violations).toEqual([
      { plugin: "plugin-fixture", specifier: "@fixture/missing" },
      { plugin: "plugin-fixture", specifier: "@fixture/exported" },
      { plugin: "plugin-fixture", specifier: "@fixture/dynamic" },
    ]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  });

  test("reports stale or split JavaScript chunks beside bundle.js", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(path.join(bundleDir, "lazy"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      "export const view = 1;\n",
    );
    fs.writeFileSync(
      path.join(bundleDir, "lazy", "old-chunk.js"),
      "export {};\n",
    );
    fs.writeFileSync(path.join(bundleDir, "styles.css"), "body {}\n");

    const result = await validateViewBundles({
      ...options,
      enforceFreshOutputs: true,
    });
    expect(result.unexpectedChunks).toEqual([
      expect.objectContaining({
        name: "plugin-fixture",
        relativeChunk: "dist/views/lazy/old-chunk.js",
      }),
    ]);
    expect(result.unexpectedArtifacts).toEqual([
      expect.objectContaining({
        name: "plugin-fixture",
        relativeArtifact: "dist/views/styles.css",
      }),
    ]);
  });

  test("post-Turbo import validation permits package compiler outputs", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      "export const view = 1;\n",
    );
    fs.writeFileSync(path.join(bundleDir, "view-module.js"), "export {};\n");
    fs.writeFileSync(path.join(bundleDir, "view-module.d.ts"), "export {};\n");

    const result = await validateViewBundles(options);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  });

  test("rejects malformed bundles instead of treating them as import-free", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "bundle.js"), "import {");

    await expect(validateViewBundles(options)).rejects.toThrow(
      "is not parseable JavaScript",
    );
    expect(() =>
      bareImportSpecifiers(
        'const text = "import x from fake"; import("./relative.js");',
      ),
    ).toThrow("must be self-contained");
  });

  test("rejects empty or namespace-free bundle artifacts", async () => {
    const empty = fixture();
    const emptyBundleDir = path.join(empty.absoluteDir, "dist", "views");
    fs.mkdirSync(emptyBundleDir, { recursive: true });
    fs.writeFileSync(path.join(emptyBundleDir, "bundle.js"), "");
    await expect(validateViewBundles(empty.options)).rejects.toThrow(
      "expected bundle is empty",
    );

    for (const source of [
      "// build completed without a view export\n",
      "export {};\n",
    ]) {
      const candidate = fixture();
      const bundleDir = path.join(candidate.absoluteDir, "dist", "views");
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(path.join(bundleDir, "bundle.js"), source);
      await expect(validateViewBundles(candidate.options)).rejects.toThrow(
        "exports no runtime bindings",
      );
    }
    expect(() =>
      assertViewBundleExports("export const view = 1;"),
    ).not.toThrow();
  });

  test("rejects unsupported filesystem nodes in view output", () => {
    const unsupported = {
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
    expect(() => viewOutputEntryKind(unsupported, "dist/views/device")).toThrow(
      "unsupported filesystem entry",
    );
  });

  test("rejects imports whose runtime specifier cannot be proven loadable", () => {
    expect(() => bareImportSpecifiers("import(moduleName);")).toThrow(
      "computed dynamic import",
    );
    expect(() => bareImportSpecifiers('require("@fixture/missing");')).toThrow(
      "CommonJS require",
    );
  });

  test("derives registrations from syntax without accepting comment examples", () => {
    const loader = `
      const HOST_EXTERNAL_IMPORTERS = {
        react: () => import("react"),
        "@fixture/static": () => import("@fixture/static"),
      };
      function resolveHostExternal(specifier) {
        return HOST_EXTERNAL_IMPORTERS[specifier];
      }
      export const hostImport = (specifier) => resolveHostExternal(specifier)?.();
    `;
    const registration = `
      import { registerHostExternalImporter as register } from "@elizaos/ui/app-shell-registry";
      // register("<comment-only>", () => import("<comment-only>"));
      const example = 'register("<string-only>", factory)';
      function importHostExternal(specifier) {
        return import(specifier);
      }
      export function initializeHostExternals() {
        register("@fixture/runtime", () => importHostExternal("@fixture/runtime"));
      }
    `;
    const record = {
      entryFile: "main.tsx",
      entrySource: `
        import { initializeHostExternals } from "./host-externals";
        initializeHostExternals();
      `,
      file: "host-externals.ts",
      source: registration,
    };
    expect(hostExternalSpecifiersFromSources(loader, [record])).toEqual(
      new Set(["react", "@fixture/static", "@fixture/runtime"]),
    );
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        {
          ...record,
          file: "host-externals.ts",
          source: `
            import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
            export function initializeHostExternals() {
              registerHostExternalImporter(specifier, () => importHostExternal("@fixture/runtime"));
            }
          `,
        },
      ]),
    ).toThrow("literal specifiers");
  });

  test("requires the loader map and registration initializer to be reachable", () => {
    const deadLoader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      function deadLookup(name) { return HOST_EXTERNAL_IMPORTERS[name]; }
      export const unrelated = true;
    `;
    const registration = {
      entryFile: "main.tsx",
      entrySource: `
        import { initializeHostExternals } from "./host-externals";
      `,
      file: "host-externals.ts",
      source: `
        import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
        export function initializeHostExternals() {
          registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));
        }
      `,
    };
    expect(() =>
      hostExternalSpecifiersFromSources(deadLoader, [registration]),
    ).toThrow(/callable hostImport|not consumed/);

    const liveLoader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
    `;
    expect(() =>
      hostExternalSpecifiersFromSources(liveLoader, [registration]),
    ).toThrow("must call initializeHostExternals exactly once at module scope");
    expect(() =>
      hostExternalSpecifiersFromSources(liveLoader, [
        {
          ...registration,
          entrySource: `
            import { initializeHostExternals } from "./host-externals";
            if (false) initializeHostExternals();
          `,
        },
      ]),
    ).toThrow("module scope");
  });

  test("binds loader values and reachability to real callable imports", () => {
    const registration = {
      entryFile: "main.tsx",
      entrySource: `
        import { initializeHostExternals } from "./host-externals";
        initializeHostExternals();
      `,
      file: "host-externals.ts",
      source: `
        import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
        export function initializeHostExternals() {
          registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));
        }
      `,
    };
    const loader = (value: string, hostImport: string) => `
      const HOST_EXTERNAL_IMPORTERS = { react: ${value} };
      ${hostImport}
    `;

    expect(() =>
      hostExternalSpecifiersFromSources(
        loader(
          "42",
          "export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]; }",
        ),
        [registration],
      ),
    ).toThrow("must be callable");
    expect(() =>
      hostExternalSpecifiersFromSources(
        loader(
          '() => import("evil")',
          "export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]; }",
        ),
        [registration],
      ),
    ).toThrow("mismatched specifier");
    expect(() =>
      hostExternalSpecifiersFromSources(
        loader(
          '() => { throw new Error("disabled"); }',
          "export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]; }",
        ),
        [registration],
      ),
    ).toThrow("must directly return");
    expect(() =>
      hostExternalSpecifiersFromSources(
        loader(
          '() => import("react")',
          "export function hostImport(HOST_EXTERNAL_IMPORTERS) { return HOST_EXTERNAL_IMPORTERS.react(); }",
        ),
        [registration],
      ),
    ).toThrow("not consumed by the exported hostImport call path");
    expect(() =>
      hostExternalSpecifiersFromSources(
        loader(
          '() => import("react")',
          `
            function hidden(name) { return HOST_EXTERNAL_IMPORTERS[name]; }
            export function hostImport() { return hidden; }
          `,
        ),
        [registration],
      ),
    ).toThrow("not consumed by the exported hostImport call path");
    expect(() =>
      hostExternalSpecifiersFromSources(
        `
          function importCoreViewCompat() { return {}; }
          const HOST_EXTERNAL_IMPORTERS = {
            "@elizaos/app-core": importCoreViewCompat,
          };
          export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
        `,
        [registration],
      ),
    ).toThrow("expected callable importer");
    expect(() =>
      hostExternalSpecifiersFromSources(
        `
          function importCoreViewCompat() { throw new Error("disabled"); }
          const HOST_EXTERNAL_IMPORTERS = {
            "@elizaos/core": importCoreViewCompat,
          };
          export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
        `,
        [registration],
      ),
    ).toThrow("expected callable importer");
    expect(() =>
      hostExternalSpecifiersFromSources(
        `
          const HOST_EXTERNAL_IMPORTERS = {
            "@elizaos/ui/api": () => import("../../state/index.ts"),
          };
          export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
        `,
        [registration],
      ),
    ).toThrow("mismatched relative specifier");
  });

  test("accepts optional named importer scope arguments without accepting required arguments", () => {
    const loader = (parameters: string) => `
      async function importUiRootCompat(${parameters}) { return {}; }
      const HOST_EXTERNAL_IMPORTERS = { "@elizaos/ui": importUiRootCompat };
      function resolveHostExternal(specifier) { return HOST_EXTERNAL_IMPORTERS[specifier]; }
      function importHostExternalForScope(specifier, scope) {
        return resolveHostExternal(specifier)(scope);
      }
      export const hostImport = (specifier) => importHostExternalForScope(specifier, null);
    `;
    for (const parameters of ["", "scope = null", "scope?: unknown"]) {
      expect(hostExternalSpecifiersFromSources(loader(parameters), [])).toEqual(
        new Set(["@elizaos/ui"]),
      );
    }
    for (const parameters of [
      "scope",
      "scope: unknown",
      "scope = null, required: unknown",
      "...scopes: unknown[]",
      "{ scope }?: { scope?: unknown }",
      "[scope]?: unknown[]",
      "{ scope } = {}",
      "[scope] = []",
    ]) {
      expect(() =>
        hostExternalSpecifiersFromSources(loader(parameters), []),
      ).toThrow("expected callable importer");
    }
    expect(() =>
      hostExternalSpecifiersFromSources(
        `
      const HOST_EXTERNAL_IMPORTERS = { react: (scope = null) => import("react") };
      export function hostImport(specifier) { return HOST_EXTERNAL_IMPORTERS[specifier](); }
    `,
        [],
      ),
    ).toThrow("may not require arguments");
  });

  test("requires scoped importer lookup to be called, not hidden in an unused closure", () => {
    const loader = (body: string) => `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      function importHostExternalForScope(specifier, scope) {
        return HOST_EXTERNAL_IMPORTERS[specifier](scope);
      }
      export function hostImport(specifier) { ${body} }
    `;
    expect(
      hostExternalSpecifiersFromSources(
        loader("return importHostExternalForScope(specifier, null);"),
        [],
      ),
    ).toEqual(new Set(["react"]));
    for (const body of [
      "return () => importHostExternalForScope(specifier, null);",
      "const unused = () => importHostExternalForScope(specifier, null); return {};",
      "const importHostExternalForScope = () => ({}); return importHostExternalForScope(specifier, null);",
    ]) {
      expect(() => hostExternalSpecifiersFromSources(loader(body), [])).toThrow(
        "not consumed by the exported hostImport call path",
      );
    }
  });

  test("rejects shadowed, non-callable, dead-branch, and mismatched registrations", () => {
    const loader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
    `;
    const entry = `
      import { initializeHostExternals } from "./host-externals";
      initializeHostExternals();
    `;
    const source = (body: string, parameters = "") => ({
      entryFile: "main.tsx",
      entrySource: entry,
      file: "host-externals.ts",
      source: `
        import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
        export function initializeHostExternals(${parameters}) {
          ${body}
        }
      `,
    });
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));',
          "registerHostExternalImporter",
        ),
      ]),
    ).toThrow("shadows the registration API");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source('registerHostExternalImporter("@fixture/runtime", undefined);'),
      ]),
    ).toThrow("inline callable");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'if (enabled) registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));',
        ),
      ]),
    ).toThrow("direct statements");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => import("@fixture/other"));',
        ),
      ]),
    ).toThrow("mismatched specifier");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => { importHostExternal("@fixture/runtime"); return Promise.resolve({}); });',
        ),
      ]),
    ).toThrow(/directly return|importHostExternal/);
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => importHostExternal("@fixture/runtime").catch(() => ({})));',
        ),
      ]),
    ).toThrow(/directly return|importHostExternal/);
  });

  test("accepts only imports provided by the host", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      'import React from "react";\nexport { React };\n',
    );

    const result = await validateViewBundles(options);
    expect(result.missingBundles).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
    expect(result.bundleCount).toBe(1);
  });

  test("the real host registry remains readable and non-empty", async () => {
    const specifiers = await getHostExternalSpecifiers();
    expect(specifiers.size).toBeGreaterThan(0);
    expect(specifiers).toContain("react");
    expect(specifiers).toContain("@elizaos/ui/components/shared/ViewHeader");
  });
});
