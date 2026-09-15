/**
 * Type declarations for `renderer-build-manifest.mjs` — the deterministic build
 * stamp for the web/renderer bundle (issue #9309). Imported by the vite
 * `renderer-build-manifest` plugin and the platform build orchestrators.
 */

export const RENDERER_BUILD_MANIFEST_FILENAME: "eliza-renderer-build.json";
export const RENDERER_BUILD_MANIFEST_SCHEMA: "elizaos.renderer.build/v1";

export interface RendererBuildManifest {
  schema: string;
  buildId: string;
  indexHtmlSha256: string;
  assetCount: number;
  builtAt: string;
  startedAt?: string;
  commit: string | null;
  variant: string | null;
  capacitorTarget: string | null;
  runtimeMode: string | null;
  playwrightTestAuth: boolean | null;
  iosApnsEnabled: boolean | null;
}

export interface RendererBuildManifestMeta {
  builtAt?: string;
  startedAt?: string;
  commit?: string | null;
  variant?: string | null;
  capacitorTarget?: string | null;
  runtimeMode?: string | null;
  playwrightTestAuth?: boolean | null;
  iosApnsEnabled?: boolean | null;
}

export function computeRendererFingerprint(distDir: string): {
  buildId: string;
  indexHtmlSha256: string;
  assetCount: number;
};

export function buildRendererManifest(
  distDir: string,
  meta?: RendererBuildManifestMeta,
): RendererBuildManifest;

export function writeRendererBuildManifest(
  distDir: string,
  meta?: RendererBuildManifestMeta,
): RendererBuildManifest;

export function readRendererBuildManifest(
  dir: string,
): RendererBuildManifest | null;

export function rendererBuildManifestMatchesDist(
  distDir: string,
  manifest: unknown,
): manifest is RendererBuildManifest;

export function assertStagedRendererMatchesBuild(
  freshDistDir: string,
  stagedDir: string,
  opts?: { label?: string },
): RendererBuildManifest;

export function overlayFreshRendererIntoPublic(
  freshDistDir: string,
  targetPublicDir: string,
  opts?: { label?: string },
): RendererBuildManifest;

export function assertRendererRebuiltSince(
  distDir: string,
  opts: { notBefore: number; expectVariant?: string | null; label?: string },
): RendererBuildManifest;
