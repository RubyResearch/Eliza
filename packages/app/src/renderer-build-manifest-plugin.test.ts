/**
 * Proves the renderer manifest records the same build flags that Vite loads
 * and compiles into the browser bundle.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRendererBuildManifest } from "../../app-core/scripts/lib/renderer-build-manifest.mjs";
import { rendererBuildManifestPlugin } from "../vite/renderer-build-manifest-plugin.ts";

const cleanupHelperScript = path.resolve(
  import.meta.dirname,
  "../../scripts/rm-path-recursive.mjs",
);

let tmp: string;
let previousPlaywrightTestAuth: string | undefined;
let previousCapacitorTarget: string | undefined;
let previousApnsEnabled: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-manifest-plugin-"));
  previousPlaywrightTestAuth = process.env.VITE_PLAYWRIGHT_TEST_AUTH;
  previousCapacitorTarget = process.env.ELIZA_CAPACITOR_BUILD_TARGET;
  previousApnsEnabled = process.env.VITE_ELIZA_APNS_ENABLED;
  delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
  delete process.env.ELIZA_CAPACITOR_BUILD_TARGET;
  delete process.env.VITE_ELIZA_APNS_ENABLED;
});

afterEach(() => {
  if (previousPlaywrightTestAuth === undefined) {
    delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
  } else {
    process.env.VITE_PLAYWRIGHT_TEST_AUTH = previousPlaywrightTestAuth;
  }
  if (previousCapacitorTarget === undefined) {
    delete process.env.ELIZA_CAPACITOR_BUILD_TARGET;
  } else {
    process.env.ELIZA_CAPACITOR_BUILD_TARGET = previousCapacitorTarget;
  }
  if (previousApnsEnabled === undefined) {
    delete process.env.VITE_ELIZA_APNS_ENABLED;
  } else {
    process.env.VITE_ELIZA_APNS_ENABLED = previousApnsEnabled;
  }
  execFileSync(process.execPath, [cleanupHelperScript, tmp], {
    stdio: "inherit",
  });
});

describe("rendererBuildManifestPlugin", () => {
  it("refuses to stamp a bundle when an input changes during compilation", async () => {
    const outDir = path.join(tmp, "dist");
    fs.mkdirSync(path.join(tmp, "src"));
    const input = path.join(tmp, "src/main.ts");
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      '<script type="module" src="/src/main.ts"></script>',
    );
    fs.writeFileSync(input, "globalThis.revision = 1;");
    await expect(
      build({
        root: tmp,
        configFile: false,
        logLevel: "silent",
        plugins: [
          rendererBuildManifestPlugin(),
          {
            name: "edit-already-bundled-input",
            writeBundle() {
              fs.writeFileSync(input, "globalThis.revision = 2;");
              const changedAt = (Date.now() + 1000) / 1000;
              fs.utimesSync(input, changedAt, changedAt);
            },
          },
        ],
        build: { outDir, minify: false },
      }),
    ).rejects.toThrow("input changed during build");
    // The failed build's start stamp also makes subsequent reuse reject it.
    expect(readRendererBuildManifest(outDir)?.startedAt).toBeTruthy();
  });

  it("records test auth loaded by Vite from an env file", async () => {
    const outDir = path.join(tmp, "dist");
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    fs.writeFileSync(
      path.join(tmp, "main.js"),
      "globalThis.testAuth = import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH;",
    );
    fs.writeFileSync(
      path.join(tmp, ".env.production"),
      "VITE_PLAYWRIGHT_TEST_AUTH=true\n",
    );

    await build({
      root: tmp,
      configFile: false,
      logLevel: "silent",
      plugins: [rendererBuildManifestPlugin()],
      build: { outDir, minify: false },
    });

    const bundleSource = fs
      .readdirSync(path.join(outDir, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(outDir, "assets", name), "utf8"))
      .join("\n");
    expect(bundleSource).toMatch(/globalThis\.testAuth\s*=\s*["']true["']/);
    expect(readRendererBuildManifest(outDir)?.playwrightTestAuth).toBe(true);
    const manifest = readRendererBuildManifest(outDir);
    if (!manifest?.startedAt) {
      throw new Error("Renderer manifest must record the build start time");
    }
    expect(Date.parse(manifest.startedAt)).toBeLessThanOrEqual(
      Date.parse(manifest.builtAt),
    );
  });

  it("records the authoritative APNs value compiled into an iOS renderer", async () => {
    const outDir = path.join(tmp, "dist");
    process.env.ELIZA_CAPACITOR_BUILD_TARGET = "ios";
    // buildWeb supplies the native build authority through process env. Vite
    // must prefer it to a conflicting mode file and stamp that exact value.
    process.env.VITE_ELIZA_APNS_ENABLED = "1";
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    fs.writeFileSync(
      path.join(tmp, "main.js"),
      "globalThis.apnsEnabled = import.meta.env.VITE_ELIZA_APNS_ENABLED;",
    );
    fs.writeFileSync(
      path.join(tmp, ".env.production"),
      "VITE_ELIZA_APNS_ENABLED=0\n",
    );

    await build({
      root: tmp,
      configFile: false,
      logLevel: "silent",
      plugins: [rendererBuildManifestPlugin()],
      build: { outDir, minify: false },
    });

    const bundleSource = fs
      .readdirSync(path.join(outDir, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(outDir, "assets", name), "utf8"))
      .join("\n");
    expect(bundleSource).toMatch(/globalThis\.apnsEnabled\s*=\s*["']1["']/);
    expect(readRendererBuildManifest(outDir)?.iosApnsEnabled).toBe(true);
  });
});
