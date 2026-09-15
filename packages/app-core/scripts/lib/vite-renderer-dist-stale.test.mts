/**
 * Verifies renderer reuse against the real build manifest so UI-smoke cannot
 * cross the Playwright test-auth build boundary in either direction.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  writeRendererBuildManifest,
} from "./renderer-build-manifest.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";
import {
  rendererDistMatchesPlaywrightTestAuth,
  resolvePlaywrightTestAuth,
  viteRendererBuildNeeded,
} from "./vite-renderer-dist-stale.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-auth-variant-"));
});

afterEach(() => {
  execFileSync(process.execPath, [cleanupHelperScript, tmp], {
    cwd: repoRoot,
    stdio: "inherit",
  });
});

function makeRenderer(playwrightTestAuth?: boolean) {
  const appDir = path.join(tmp, "app");
  const distDir = path.join(appDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<div id=root></div>");
  writeRendererBuildManifest(distDir, { playwrightTestAuth });
  return { appDir, distDir };
}

describe("Playwright test-auth renderer reuse", () => {
  it("rejects a source edit during compilation even when the output is newer", () => {
    const { appDir, distDir } = makeRenderer(false);
    const src = path.join(appDir, "src");
    fs.mkdirSync(src);
    const input = path.join(src, "main.ts");
    fs.writeFileSync(input, "export const revision = 2;");
    const start = Date.now() - 10_000;
    fs.utimesSync(input, (start + 1000) / 1000, (start + 1000) / 1000);
    fs.utimesSync(
      path.join(distDir, "index.html"),
      (start + 2000) / 1000,
      (start + 2000) / 1000,
    );
    writeRendererBuildManifest(distDir, {
      startedAt: new Date(start).toISOString(),
      builtAt: new Date(start + 2000).toISOString(),
      playwrightTestAuth: false,
    });
    expect(viteRendererBuildNeeded(appDir, tmp)).toBe(true);
    // An unchanged input predating the compile remains reusable.
    fs.utimesSync(input, (start - 1000) / 1000, (start - 1000) / 1000);
    expect(viteRendererBuildNeeded(appDir, tmp)).toBe(false);
  });

  it("rebuilds a legacy completion-only stamp", () => {
    const { appDir, distDir } = makeRenderer(false);
    const stamp = path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(stamp, "utf8"));
    delete manifest.startedAt;
    fs.writeFileSync(stamp, JSON.stringify(manifest));
    expect(viteRendererBuildNeeded(appDir, tmp)).toBe(true);
  });

  it.each([true, false])(
    "reuses a fresh renderer when test auth is %s in both build and invocation",
    (playwrightTestAuth) => {
      const { appDir } = makeRenderer(playwrightTestAuth);

      expect(
        rendererDistMatchesPlaywrightTestAuth(appDir, playwrightTestAuth),
      ).toBe(true);
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: playwrightTestAuth,
        }),
      ).toBe(false);
    },
  );

  it.each([
    { built: false, requested: true },
    { built: true, requested: false },
  ])(
    "rebuilds when a $built build is reused by a $requested invocation",
    ({ built, requested }) => {
      const { appDir } = makeRenderer(built);

      expect(rendererDistMatchesPlaywrightTestAuth(appDir, requested)).toBe(
        false,
      );
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: requested,
        }),
      ).toBe(true);
    },
  );

  it.each([
    "legacy",
    "absent",
    "malformed",
    "partial",
    "wrong-schema",
    "wrong-fingerprint",
  ])("fails closed when test-auth manifest metadata is %s", (manifestState) => {
    const { appDir, distDir } = makeRenderer();
    const manifestPath = path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifestState === "legacy") {
      delete manifest.playwrightTestAuth;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } else if (manifestState === "absent") {
      fs.unlinkSync(manifestPath);
    } else if (manifestState === "partial") {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          buildId: manifest.buildId,
          playwrightTestAuth: false,
        }),
      );
    } else if (manifestState === "wrong-schema") {
      manifest.schema = "elizaos.renderer.build/v0";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } else if (manifestState === "wrong-fingerprint") {
      manifest.buildId = "0".repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } else {
      fs.writeFileSync(manifestPath, "{not-json");
    }

    expect(rendererDistMatchesPlaywrightTestAuth(appDir, false)).toBe(false);
    expect(
      viteRendererBuildNeeded(appDir, tmp, {
        expectedPlaywrightTestAuth: false,
      }),
    ).toBe(true);
  });

  it("uses Vite production env precedence for the expected variant", () => {
    const previousPlaywrightTestAuth = process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    try {
      const appDir = path.join(tmp, "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, ".env.production"),
        "VITE_PLAYWRIGHT_TEST_AUTH=true\n",
      );
      const beforeBuild = (Date.now() - 1000) / 1000;
      fs.utimesSync(
        path.join(appDir, ".env.production"),
        beforeBuild,
        beforeBuild,
      );
      makeRenderer(true);

      const expectedPlaywrightTestAuth = resolvePlaywrightTestAuth(appDir);

      expect(expectedPlaywrightTestAuth).toBe(true);
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth,
        }),
      ).toBe(false);
    } finally {
      if (previousPlaywrightTestAuth === undefined) {
        delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
      } else {
        process.env.VITE_PLAYWRIGHT_TEST_AUTH = previousPlaywrightTestAuth;
      }
    }
  });

  it("rebuilds when a production env file changes the requested variant", () => {
    const previousPlaywrightTestAuth = process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    try {
      const { appDir } = makeRenderer(false);
      fs.writeFileSync(
        path.join(appDir, ".env.production"),
        "VITE_PLAYWRIGHT_TEST_AUTH=true\n",
      );

      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: resolvePlaywrightTestAuth(appDir),
        }),
      ).toBe(true);
    } finally {
      if (previousPlaywrightTestAuth === undefined) {
        delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
      } else {
        process.env.VITE_PLAYWRIGHT_TEST_AUTH = previousPlaywrightTestAuth;
      }
    }
  });

  it("rebuilds unstamped desktop renderers rather than guessing their input boundary", () => {
    const { appDir, distDir } = makeRenderer();
    fs.unlinkSync(path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME));

    expect(viteRendererBuildNeeded(appDir, tmp)).toBe(true);
  });
});
