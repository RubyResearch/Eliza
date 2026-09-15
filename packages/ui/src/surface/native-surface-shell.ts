/**
 * Native-shell surface driver contract for the mobile Browser view (#15245,
 * deferred from #14181, child of #13452). On mobile the app renders into a
 * single host web surface (Capacitor `WKWebView` on iOS / Android `WebView`); a
 * view whose resolved {@link ResolvedSurfaceManifest} declares
 * `isolation: "native-webview"` must instead layer its arbitrary web content as
 * its OWN native child web surface with an explicit process/storage-sharing
 * policy. iOS gives isolated surfaces a dedicated process pool; Android proves
 * an out-of-app sandboxed renderer but may reuse it across sibling WebViews.
 * Isolated storage never shares the host or a sibling partition.
 *
 * This module is the seam between the placement decision — the pure
 * {@link deriveSurfacePlacement}, which reads the manifest alone and says whether
 * a view lives in the host web surface or its own native surface and with what
 * policy — and the native shell that actually owns the layered `WKWebView` /
 * `WebView` stack. The live consumer is
 * `use-mobile-native-tab-surfaces.ts`, which drives one native surface per
 * Browser tab; the production driver (`capacitor-native-surface-shell.ts`)
 * realises these calls through the `ElizaSurfaceManager` Capacitor plugin, and
 * tests drive a faithful in-memory shell. Keeping the driver behind an interface
 * is what lets the isolation decision be tested against the real decision path
 * without a device.
 *
 * The one hard invariant this module encodes: every independent native surface
 * carries an EXPLICIT {@link NativeSurfacePolicy} — process and storage sharing
 * are each a deliberate `"isolated" | "shared"` choice derived from the manifest,
 * never an implicit platform default (#15245 acceptance).
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";

/**
 * Renderer-process sharing for an independent native surface.
 *  - `isolated` — the strongest native renderer boundary: a fresh
 *                 `WKProcessPool` on iOS, and a verified out-of-app sandboxed
 *                 renderer on Android. Android may reuse that renderer across
 *                 sibling WebViews, but it never runs in the app/host process.
 *  - `shared`   — requests platform-defined sharing. iOS reuses a plugin-owned
 *                 pool; Android controls placement and may reuse its renderer
 *                 regardless. Only trusted first-party surfaces may request it.
 */
export type SurfaceProcessSharing = "isolated" | "shared";

/**
 * Persistent-storage sharing for an independent native surface.
 *  - `isolated` — its own website data store (cookies, localStorage, IndexedDB,
 *                 caches). Nothing written here is visible to the host or to a
 *                 sibling surface — the boundary that stops state leaking across
 *                 surfaces (#13452).
 *  - `shared`   — the host-scoped persistent store. Only when the view's manifest
 *                 grants the `storage` capability, i.e. it explicitly opts into
 *                 host storage.
 */
export type SurfaceStorageSharing = "isolated" | "shared";

/**
 * The explicit process/storage-sharing policy for one independent native web
 * surface. Both axes are always stated — the placement decision never lets the
 * native shell fall back to an implicit default (#15245).
 */
export interface NativeSurfacePolicy {
  readonly process: SurfaceProcessSharing;
  readonly storage: SurfaceStorageSharing;
}

/**
 * Where a view is placed on mobile. `host-web` views (in-process, immersive,
 * sandboxed-iframe) render inside the single host web surface; `native-surface`
 * views (`native-webview` isolation) get their own layered native web surface
 * governed by an explicit {@link NativeSurfacePolicy}.
 */
export type SurfacePlacement =
  | { readonly target: "host-web" }
  | { readonly target: "native-surface"; readonly policy: NativeSurfacePolicy };

/**
 * Decide, from the resolved manifest alone, where a view is placed and — for a
 * native surface — its explicit process/storage policy. This is the whole
 * manifest→placement decision, kept pure so it is trivially testable and so
 * changing the manifest is the only way to change the outcome (no hidden host
 * state feeds in).
 *
 * `native-webview` is the only level that gets an independent native surface;
 * every other level (in-process, immersive, sandboxed-iframe) lives in the host
 * web surface — a sandboxed iframe is still a child of the host document, not a
 * native sibling. A native surface always requests the platform's strongest
 * renderer separation so heavy/untrusted content stays outside the host
 * renderer. Storage is isolated by default and only shared when the manifest
 * grants `storage`, i.e. the view explicitly asked for host storage.
 */
export function deriveSurfacePlacement(
  manifest: ResolvedSurfaceManifest,
): SurfacePlacement {
  if (manifest.isolation !== "native-webview") {
    return { target: "host-web" };
  }
  return {
    target: "native-surface",
    policy: {
      process: "isolated",
      storage: manifest.capabilities.has("storage") ? "shared" : "isolated",
    },
  };
}

/**
 * Screen-space rectangle in CSS pixels relative to the host webview's viewport.
 * The native side converts to device pixels by the display density; keeping the
 * shared geometry in CSS px means the JS layer measures with
 * `getBoundingClientRect` and never knows the device scale factor.
 */
export interface SurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Per-corner radii for a host-computed rounded rectangle, in CSS pixels. */
export interface SurfaceCornerRadii {
  readonly topLeft: number;
  readonly topRight: number;
  readonly bottomRight: number;
  readonly bottomLeft: number;
}

/**
 * The rounded host clip enclosing a native page. This is measured from the
 * actual clipping ancestor rather than copied from a design token, so theme and
 * responsive radius changes remain native/React pixel-identical.
 */
export interface SurfaceOuterClip extends SurfaceRect {
  readonly cornerRadii: SurfaceCornerRadii;
}

/**
 * Screen-space placement for a layered native surface. `outerClip` is atomic
 * with the page rectangle so native paint and hit testing never observe a new
 * host radius with stale bounds (or the reverse).
 */
export interface SurfaceBounds extends SurfaceRect {
  readonly outerClip: SurfaceOuterClip;
}

/**
 * Rounded host-space region where the native layer yields both paint and input
 * to host-rendered chrome. Coordinates share {@link SurfaceBounds}' CSS pixels.
 */
export interface SurfaceOcclusionRect extends SurfaceRect {
  readonly cornerRadius: number;
}

/** Request to create one independent native web surface. */
export interface NativeSurfaceCreateRequest {
  /** Stable per-surface id; the caller keys foreground/bounds/destroy on it. */
  readonly id: string;
  /** Initial content URL, when the caller knows it. */
  readonly url?: string;
  /** The explicit, non-default process/storage policy for this surface. */
  readonly policy: NativeSurfacePolicy;
}

/** Bounded, untrusted text observed from a single native page. */
export interface NativePageRead {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * The native shell that owns the layered surface stack. The renderer issues these
 * desired-state commands and observes an acknowledgement promise. The production
 * shell serializes and reconciles each surface against native state, while a test
 * double may acknowledge directly. A caller may therefore submit geometry and
 * visibility immediately after create without racing the native layer into
 * existence, and may resubmit unchanged intent after a terminal transport error.
 */
export interface NativeSurfaceShell {
  /**
   * Create (but do not necessarily foreground) a native surface with the given
   * explicit policy. Must be called before presenting that id.
   */
  createSurface(req: NativeSurfaceCreateRequest): Promise<void>;
  /**
   * Position and outer-clip a surface over the host webview. Called on
   * layout/resize/style changes so the native layer tracks both the placeholder
   * and its actual rounded React host without recreating the web surface.
   */
  setBounds(id: string, bounds: SurfaceBounds): Promise<void>;
  /**
   * Keep the page full-size while exposing host overlays through rounded holes
   * in the native layer. Replaces the surface's complete occlusion set.
   */
  setOcclusionRects(
    id: string,
    rects: readonly SurfaceOcclusionRect[],
  ): Promise<void>;
  /** Load a URL in an existing surface (address-bar navigation on the tab). */
  navigate(id: string, url: string): Promise<void>;
  /** Reload the current page in an existing native surface. */
  reload(id: string): Promise<void>;
  /** Navigate this native page's history. Non-idempotent; never auto-retry. */
  back(id: string): Promise<void>;
  /** Read visible page text only; never evaluate agent-supplied JavaScript. */
  readPage(id: string, selector?: string): Promise<NativePageRead>;
  /** Subscribe to authoritative page URLs without issuing another navigation. */
  subscribeNavigation(
    listener: (event: {
      id: string;
      url: string;
      previousUrl: string | undefined;
    }) => void,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>>;
  /**
   * Atomically choose the one native surface that owns presentation, or `null`
   * to return paint/input ownership to the host. Selecting a surface hides all
   * siblings before foregrounding it.
   */
  presentSurface(id: string | null): Promise<void>;
  /** Tear a surface down and release its native renderer and storage resources. */
  destroySurface(id: string): Promise<void>;
  /** Whether native creation for this id has been acknowledged and remains live. */
  hasSurface(id: string): boolean;
}
