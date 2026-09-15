/**
 * Renderer build manifest — the deterministic "build stamp" for the web/renderer
 * bundle that every on-device artifact must carry.
 *
 * Issue #9309: the recurring on-device failure mode is a device booting STALE UI
 * because a build step copied a cached `dist/` instead of the freshly built one.
 * There was no machine-checkable identity for "which renderer is this", so a
 * stale copy shipped silently.
 *
 * This module gives the renderer a content-derived identity:
 *   - The vite `renderer-build-manifest` plugin writes `eliza-renderer-build.json`
 *     into `dist/` at the end of EVERY renderer build (mobile, desktop, web).
 *   - The file is copied into the device artifact alongside the bundle (cap sync
 *     copies the whole webDir; desktop's Electrobun copy carries dist/), so it
 *     ships on-device as an asserted build stamp.
 *   - The platform orchestrators call `assertStagedRendererMatchesBuild()` after
 *     staging so a stale/missing/partial renderer FAILS THE BUILD LOUDLY instead
 *     of shipping old code.
 *
 * `buildId` is a sha256 over `index.html` + the sorted set of emitted asset
 * file names (vite embeds each asset's content hash in its name) and their
 * sizes. Two different source states therefore produce two different buildIds,
 * which is exactly the freshness signal the issue asks for ("a real freshness
 * check that fails the build when an input changed but the artifact didn't").
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RENDERER_BUILD_MANIFEST_FILENAME = "eliza-renderer-build.json";
export const RENDERER_BUILD_MANIFEST_SCHEMA = "elizaos.renderer.build/v1";

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Deterministic content fingerprint of a built renderer directory.
 * @param {string} distDir absolute path to the built renderer dir (has index.html)
 * @returns {{ buildId: string, indexHtmlSha256: string, assetCount: number }}
 */
export function computeRendererFingerprint(distDir) {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `[renderer-build-manifest] no index.html in ${distDir} — not a built renderer.`,
    );
  }
  const indexHtmlSha256 = sha256(fs.readFileSync(indexPath));

  const assetEntries = [];
  const assetsDir = path.join(distDir, "assets");
  if (fs.existsSync(assetsDir)) {
    const walk = (dir, rel) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const relName = rel ? `${rel}/${name}` : name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full, relName);
        } else {
          assetEntries.push(`${relName}:${stat.size}`);
        }
      }
    };
    walk(assetsDir, "");
  }
  assetEntries.sort();
  const buildId = sha256(`${indexHtmlSha256}\n${assetEntries.join("\n")}`);
  return { buildId, indexHtmlSha256, assetCount: assetEntries.length };
}

/**
 * Build the manifest object for a renderer dir (does not write it).
 * @param {string} distDir
 * @param {{ builtAt?: string, startedAt?: string, commit?: string|null, variant?: string|null,
 *           capacitorTarget?: string|null, runtimeMode?: string|null,
 *           playwrightTestAuth?: boolean|null,
 *           iosApnsEnabled?: boolean|null }} [meta]
 */
export function buildRendererManifest(distDir, meta = {}) {
  const fingerprint = computeRendererFingerprint(distDir);
  const builtAt = meta.builtAt ?? new Date().toISOString();
  return {
    schema: RENDERER_BUILD_MANIFEST_SCHEMA,
    buildId: fingerprint.buildId,
    indexHtmlSha256: fingerprint.indexHtmlSha256,
    assetCount: fingerprint.assetCount,
    builtAt,
    startedAt: meta.startedAt ?? builtAt,
    commit: meta.commit ?? null,
    variant: meta.variant ?? null,
    capacitorTarget: meta.capacitorTarget ?? null,
    runtimeMode: meta.runtimeMode ?? null,
    playwrightTestAuth: meta.playwrightTestAuth ?? null,
    iosApnsEnabled: meta.iosApnsEnabled ?? null,
  };
}

/**
 * Write `eliza-renderer-build.json` into a built renderer dir. Returns manifest.
 * @param {string} distDir
 * @param {object} [meta]
 */
export function writeRendererBuildManifest(distDir, meta = {}) {
  const manifest = buildRendererManifest(distDir, meta);
  fs.writeFileSync(
    path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/**
 * Read a renderer build manifest from a dir (the dir that holds index.html), or
 * null if absent/unparseable.
 * @param {string} dir
 */
export function readRendererBuildManifest(dir) {
  const manifestPath = path.join(dir, RENDERER_BUILD_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

/**
 * Return whether a parsed manifest has the v1 shape and matches the renderer
 * bytes beside it. This is the reuse boundary; a copied or partial stamp must
 * not make a stale renderer look current.
 *
 * @param {string} distDir
 * @param {unknown} manifest
 */
export function rendererBuildManifestMatchesDist(distDir, manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    return false;
  }

  if (
    manifest.schema !== RENDERER_BUILD_MANIFEST_SCHEMA ||
    typeof manifest.buildId !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.buildId) ||
    typeof manifest.indexHtmlSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.indexHtmlSha256) ||
    !Number.isInteger(manifest.assetCount) ||
    manifest.assetCount < 0 ||
    typeof manifest.builtAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.builtAt)) ||
    !isNullableString(manifest.commit) ||
    !isNullableString(manifest.variant) ||
    !isNullableString(manifest.capacitorTarget) ||
    !isNullableString(manifest.runtimeMode) ||
    (manifest.playwrightTestAuth !== null &&
      typeof manifest.playwrightTestAuth !== "boolean") ||
    (manifest.iosApnsEnabled !== undefined &&
      manifest.iosApnsEnabled !== null &&
      typeof manifest.iosApnsEnabled !== "boolean")
  ) {
    return false;
  }

  try {
    const fingerprint = computeRendererFingerprint(distDir);
    return (
      manifest.buildId === fingerprint.buildId &&
      manifest.indexHtmlSha256 === fingerprint.indexHtmlSha256 &&
      manifest.assetCount === fingerprint.assetCount
    );
  } catch {
    return false;
  }
}

/**
 * Assert a STAGED renderer directory carries exactly the renderer that was just
 * built in `freshDistDir`. Throws loudly on any mismatch so a stale/missing/
 * partial UI fails the build instead of shipping silently.
 *
 * @param {string} freshDistDir the just-built renderer (source of truth)
 * @param {string} stagedDir    where it was staged for the device artifact
 * @param {{ label?: string }} [opts]
 * @returns the fresh manifest on success
 */
export function assertStagedRendererMatchesBuild(
  freshDistDir,
  stagedDir,
  { label = "renderer" } = {},
) {
  const fresh = readRendererBuildManifest(freshDistDir);
  if (!fresh) {
    throw new Error(
      `[renderer-build-manifest] ${label}: the freshly built renderer in ${freshDistDir} ` +
        `has no ${RENDERER_BUILD_MANIFEST_FILENAME}. The renderer-build-manifest vite plugin ` +
        `did not run — refusing to ship an unverifiable bundle.`,
    );
  }
  const staged = readRendererBuildManifest(stagedDir);
  if (!staged) {
    throw new Error(
      `[renderer-build-manifest] ${label}: staged renderer at ${stagedDir} has no ` +
        `${RENDERER_BUILD_MANIFEST_FILENAME}. Capacitor sync / staging did not copy the freshly ` +
        `built bundle — the device would boot stale or missing UI. Failing the build.`,
    );
  }
  if (staged.buildId !== fresh.buildId) {
    throw new Error(
      `[renderer-build-manifest] ${label}: STALE RENDERER staged. ` +
        `staged buildId=${staged.buildId} (built ${staged.builtAt}) != ` +
        `freshly built buildId=${fresh.buildId} (built ${fresh.builtAt}). ` +
        `The device would boot an OLD UI — failing the build instead of shipping it.`,
    );
  }
  // A copied manifest paired with a partial/old index.html would pass the buildId
  // check above; re-hash the staged index.html to defend against a torn copy.
  const stagedIndex = path.join(stagedDir, "index.html");
  if (!fs.existsSync(stagedIndex)) {
    throw new Error(
      `[renderer-build-manifest] ${label}: staged index.html missing in ${stagedDir}.`,
    );
  }
  const stagedHtmlSha = sha256(fs.readFileSync(stagedIndex));
  if (stagedHtmlSha !== fresh.indexHtmlSha256) {
    throw new Error(
      `[renderer-build-manifest] ${label}: staged index.html hash ${stagedHtmlSha} != ` +
        `freshly built ${fresh.indexHtmlSha256} — partial or stale copy. Failing the build.`,
    );
  }
  return fresh;
}

/**
 * Stale-web guard: overlay the freshly built renderer onto a Capacitor `public`
 * dir, then assert it matches. `cap sync` has been observed to leave a stale
 * `public` (old hashed assets shipping an ancient UI). The fresh `dist` is the
 * source of truth, so clear the hashed `assets/` and copy `dist` over `public`.
 * Non-renderer payloads staged outside `dist` (e.g. `public/agent`, PGlite root
 * extension assets) live outside `dist` and survive — only `public/assets` is
 * cleared and cpSync never deletes existing non-dist files. Throws if the fresh
 * renderer is missing or the staged result doesn't match (issue #9309).
 *
 * @param {string} freshDistDir the just-built renderer (source of truth)
 * @param {string} targetPublicDir the Capacitor `public` dir to overlay
 * @param {{ label?: string }} [opts]
 * @returns the fresh manifest on success
 */
export function overlayFreshRendererIntoPublic(
  freshDistDir,
  targetPublicDir,
  { label = "renderer" } = {},
) {
  if (!fs.existsSync(path.join(freshDistDir, "index.html"))) {
    throw new Error(
      `[renderer-build-manifest] ${label}: no freshly built renderer at ${freshDistDir} ` +
        `(missing index.html). Refusing to stage a missing/stale UI.`,
    );
  }
  fs.mkdirSync(targetPublicDir, { recursive: true });
  fs.rmSync(path.join(targetPublicDir, "assets"), {
    recursive: true,
    force: true,
  });
  fs.cpSync(freshDistDir, targetPublicDir, { recursive: true });
  return assertStagedRendererMatchesBuild(freshDistDir, targetPublicDir, {
    label,
  });
}

/**
 * Assert a renderer manifest was (re)generated during THIS build invocation —
 * i.e. it is not a stale leftover from a previous run. Used by the desktop build
 * right after `vite build` to prove the renderer was actually rebuilt.
 *
 * @param {string} distDir
 * @param {{ notBefore: number, expectVariant?: string|null, label?: string }} opts
 *        notBefore: epoch ms captured immediately before the renderer build started
 * @returns the manifest on success
 */
export function assertRendererRebuiltSince(
  distDir,
  { notBefore, expectVariant = null, label = "renderer" },
) {
  const manifest = readRendererBuildManifest(distDir);
  if (!manifest) {
    throw new Error(
      `[renderer-build-manifest] ${label}: no ${RENDERER_BUILD_MANIFEST_FILENAME} in ${distDir} ` +
        `after the renderer build. The build did not produce a verifiable renderer.`,
    );
  }
  const builtAtMs = Date.parse(manifest.builtAt);
  if (!Number.isFinite(builtAtMs) || builtAtMs < notBefore) {
    throw new Error(
      `[renderer-build-manifest] ${label}: renderer manifest is STALE. builtAt=${manifest.builtAt} ` +
        `predates this build invocation (started ${new Date(notBefore).toISOString()}). ` +
        `A cached/stale dist was reused instead of a fresh build — failing.`,
    );
  }
  if (
    expectVariant != null &&
    manifest.variant != null &&
    manifest.variant !== expectVariant
  ) {
    throw new Error(
      `[renderer-build-manifest] ${label}: renderer built for variant '${manifest.variant}' ` +
        `but this build targets '${expectVariant}'. A wrong-variant dist was reused — failing.`,
    );
  }
  return manifest;
}
