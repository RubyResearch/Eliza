/**
 * Public API of the `ElizaSurfaceManager` Capacitor plugin (#15245): the native
 * bridge that layers one isolated web surface per Browser tab on the mobile
 * shell and masks it around host-rendered overlays. The renderer never imports
 * this package directly — `@elizaos/ui`'s
 * `capacitor-native-surface-shell.ts` models the same method set structurally
 * and calls it through the Capacitor `Plugins` registry — but the shapes here
 * are the source of truth for both native implementations (iOS `WKWebView` on a
 * dedicated `WKProcessPool` + `WKWebsiteDataStore`; Android platform-managed
 * out-of-app `WebView` renderer + androidx.webkit `Profile`).
 *
 * The load-bearing invariant every method upholds: an independent surface always
 * carries an EXPLICIT process + storage policy. `createSurface` rejects when
 * either field is absent — there is no implicit platform default, because a
 * defaulted storage partition is exactly the cross-surface leak the isolation
 * epic closes.
 */

import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Native renderer policy. `isolated` means a dedicated pool on iOS and a
 * verified out-of-app sandboxed renderer on Android, which the OS may reuse
 * across sibling WebViews. `shared` selects the plugin pool on iOS and leaves
 * Android renderer placement to the platform.
 */
export type SurfaceProcessSharing = "isolated" | "shared";

/** Website-data-store sharing for a surface — its own store, or the host's. */
export type SurfaceStorageSharing = "isolated" | "shared";

export interface SurfaceOwnerOptions {
  /** Stable product owner across renderer reloads. */
  owner: string;
  /** Unique JS-realm token fencing stale commands after a renderer reload. */
  session: string;
  /** Monotonic renderer epoch; native rejects every command from older epochs. */
  epoch: number;
}

export interface CreateSurfaceOptions extends SurfaceOwnerOptions {
  /** Stable per-surface id (the Browser tab's surface id). */
  id: string;
  /** Initial URL to load, when known. */
  url?: string;
  /** Explicit renderer-process policy. Required — no default. */
  process: SurfaceProcessSharing;
  /** Explicit storage policy. Required — no default. */
  storage: SurfaceStorageSharing;
}

export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** Actual host-space rounded clip enclosing the native page. */
export interface SurfaceOuterClip extends SurfaceRect {
  cornerRadii: SurfaceCornerRadii;
}

export interface SetBoundsOptions extends SurfaceRect, SurfaceOwnerOptions {
  id: string;
  /**
   * Computed host clip in CSS pixels. It travels atomically with the page rect
   * so a responsive radius change never requires recreating the WebView.
   */
  outerClip: SurfaceOuterClip;
}

/**
 * Rounded host-space region where the native page yields to React chrome.
 * Coordinates use the same host CSS-pixel space as {@link SetBoundsOptions}.
 */
export interface SurfaceOcclusionRect extends SurfaceRect {
  cornerRadius: number;
}

export interface SetOcclusionRectsOptions extends SurfaceOwnerOptions {
  id: string;
  rects: SurfaceOcclusionRect[];
}

export interface NavigateOptions extends SurfaceOwnerOptions {
  id: string;
  url: string;
}

export interface SurfaceIdOptions extends SurfaceOwnerOptions {
  id: string;
}

export interface PresentSurfaceOptions extends SurfaceOwnerOptions {
  id: string | null;
}

export interface ReconcileOwnerOptions extends SurfaceOwnerOptions {
  desiredIds: string[];
}

/** Debug/test introspection of a single surface's live state. */
export interface SurfaceState {
  exists: boolean;
  foregrounded: boolean;
  currentUrl: string | null;
  process: SurfaceProcessSharing | null;
  storage: SurfaceStorageSharing | null;
  owner: string | null;
  session: string | null;
  epoch: number | null;
}

export interface SurfaceStateWithId extends SurfaceState {
  id: string;
}

export interface SurfaceStateList {
  surfaces: SurfaceStateWithId[];
}

export interface NativePageRead {
  url: string;
  title: string;
  text: string;
  /** Legacy-client compatibility flag; consumers reject incomplete reads. */
  truncated: boolean;
}

export interface ElizaSurfaceManagerPlugin {
  /**
   * Create a native web surface with the given EXPLICIT process/storage policy.
   * Rejects when `process` or `storage` is missing, or when the platform cannot
   * honour the requested isolation (e.g. Android without multi-profile support).
   */
  createSurface(options: CreateSurfaceOptions): Promise<void>;
  /** Position a surface over the host webview, in host CSS pixels. */
  setBounds(options: SetBoundsOptions): Promise<void>;
  /**
   * Punch rounded regions out of the native layer so host-rendered overlays can
   * paint and receive input without hiding or resizing the underlying page.
   */
  setOcclusionRects(options: SetOcclusionRectsOptions): Promise<void>;
  /** Load a URL in an existing surface. */
  navigate(options: NavigateOptions): Promise<void>;
  /** Reload an existing surface's current page. */
  reloadSurface(options: SurfaceIdOptions): Promise<void>;
  /** Move back in this surface's own history; never replays after a lost reply. */
  goBack(options: SurfaceIdOptions): Promise<void>;
  /** Read visible text from this foreground native page, never the host DOM. */
  readPage(
    options: SurfaceIdOptions & { selector?: string },
  ): Promise<NativePageRead>;
  /** Signals a native page change; consumers read current state before applying it. */
  addListener(
    eventName: "navigationChanged",
    listener: (event: SurfaceIdOptions) => void,
  ): Promise<PluginListenerHandle>;
  /** Atomically hide all siblings, then present the requested surface or host. */
  presentSurface(options: PresentSurfaceOptions): Promise<void>;
  /** Tear a surface down and release its native renderer and storage resources. */
  destroySurface(options: SurfaceIdOptions): Promise<void>;
  /** Introspect a surface's live state — for debugging and instrumented tests. */
  getSurfaceState(options: SurfaceIdOptions): Promise<SurfaceState>;
  /** List surfaces owned by this exact JS-realm session. */
  listSurfaceStates(options: SurfaceOwnerOptions): Promise<SurfaceStateList>;
  /** Destroy prior-realm/orphan surfaces before this session starts issuing work. */
  reconcileOwner(options: ReconcileOwnerOptions): Promise<void>;
}
