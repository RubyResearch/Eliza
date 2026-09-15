/**
 * Vite plugin that records renderer build outputs for desktop and mobile
 * packaging steps.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import type { Plugin } from "vite";
import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  writeRendererBuildManifest,
} from "../../app-core/scripts/lib/renderer-build-manifest.mjs";
import { viteRendererBuildNeeded } from "../../app-core/scripts/lib/vite-renderer-dist-stale.mjs";

/**
 * Emits `dist/eliza-renderer-build.json` at the end of EVERY production renderer
 * build (mobile, desktop, web). The file is a content-derived build stamp that:
 *   - ships on-device (cap sync copies the whole webDir; the desktop Electrobun
 *     copy carries dist/), giving an asserted in-app "which renderer is this",
 *   - lets the platform orchestrators fail the build loudly when a stale or
 *     missing renderer would otherwise be staged (issue #9309).
 *
 * It runs in `closeBundle` (after all outputs are on disk) and reads the final
 * dist directory so the fingerprint reflects exactly what was emitted. Dev
 * servers never write a manifest (apply: "build").
 */
function resolveCommit(): string | null {
  const envCommit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) return envCommit;
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function rendererBuildManifestPlugin(): Plugin {
  let outDir = "dist";
  let root = "";
  let playwrightTestAuth = false;
  let iosApnsEnabled: boolean | null = null;
  let startedAt = 0;
  return {
    name: "renderer-build-manifest",
    apply: "build",
    buildStart() {
      startedAt = Date.now();
    },
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(root, config.build.outDir);
      // Use Vite's resolved env so values loaded from `.env*` match the
      // `import.meta.env` value compiled into the renderer.
      playwrightTestAuth = config.env.VITE_PLAYWRIGHT_TEST_AUTH === "true";
      iosApnsEnabled =
        process.env.ELIZA_CAPACITOR_BUILD_TARGET === "ios"
          ? config.env.VITE_ELIZA_APNS_ENABLED === "1"
          : null;
    },
    closeBundle() {
      // Model-tester and other secondary single-file builds emit no index.html;
      // only stamp a real app bundle.
      try {
        const manifest = writeRendererBuildManifest(outDir, {
          startedAt: new Date(startedAt).toISOString(),
          commit: resolveCommit(),
          variant: process.env.ELIZA_BUILD_VARIANT ?? null,
          capacitorTarget: process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? null,
          runtimeMode:
            process.env.VITE_ELIZA_IOS_RUNTIME_MODE ??
            process.env.VITE_ELIZA_ANDROID_RUNTIME_MODE ??
            process.env.ELIZA_RUNTIME_MODE ??
            null,
          playwrightTestAuth,
          iosApnsEnabled,
        });
        // Reuse the packaging input scan: an edit after Vite read a module can
        // predate index.html while still making this build inconsistent.
        if (
          viteRendererBuildNeeded(
            root,
            path.resolve(import.meta.dirname, "../../.."),
          )
        ) {
          throw new Error(
            "[renderer-build-manifest] input changed during build. Rebuild before packaging.",
          );
        }
        this.info?.(
          `[renderer-build-manifest] wrote ${RENDERER_BUILD_MANIFEST_FILENAME} buildId=${manifest.buildId.slice(0, 12)} (${manifest.assetCount} assets)`,
        );
      } catch (err) {
        // A renderer build with no index.html is a non-app output; skip
        // stamping rather than failing the build.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not a built renderer")) return;
        throw err;
      }
    },
  };
}
