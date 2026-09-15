/**
 * React hook that layers one isolated native web surface per Browser tab on the
 * mobile shell (#15245). It is the live consumer of the native-surface seam:
 * `BrowserWorkspaceView` mounts it on the `native-mobile-webview` render path
 * (chosen by `resolveBrowserTabRenderPath` when the Browser view's
 * `native-webview` isolation meets a native mobile host), reserving an
 * absolutely-positioned placeholder `<div>` per tab that this hook tracks and
 * overlays with a real `WKWebView` / Android `WebView` through the
 * {@link NativeSurfaceShell}.
 *
 * Why a hook driving native layers instead of iframes: on the web the Browser
 * view falls back to a sandboxed iframe, but a mobile in-realm iframe still
 * shares the host WebView's renderer process and storage partition — the exact
 * cross-surface leak the isolation epic closes. The native surface uses the
 * platform's strongest renderer boundary plus the explicit
 * {@link NativeSurfacePolicy} chosen by the Browser host. Ordinary builds use
 * an isolated data store; constrained device profiles may explicitly request a
 * shared Browser store while retaining the out-of-app renderer boundary.
 *
 * Two constraints shape the effects. (1) Native layers z-order ABOVE the host
 * WebView, so React chrome is mirrored into rounded native occlusion regions;
 * the page stays full-size and live while the host paints and handles input in
 * those holes, matching Electrobun's masks mechanism. Whole-surface overlays
 * (the tab switcher and confirmation dialogs) still background every surface.
 * (2) The layer and its occlusions use host CSS pixels and are re-measured on
 * layout, viewport, and chat-motion changes so neither can drift from React.
 */

import type { SurfaceLifecyclePolicy } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import { CapacitorNativeSurfaceShell } from "./capacitor-native-surface-shell";
import { isNativeSurfaceCapabilityDenial } from "./native-surface-capability";
import type {
  NativePageRead,
  NativeSurfacePolicy,
  NativeSurfaceShell,
  SurfaceBounds,
  SurfaceCornerRadii,
  SurfaceOcclusionRect,
  SurfaceOuterClip,
} from "./native-surface-shell";

/** The minimal per-tab shape the hook needs: identity plus the page to load. */
export interface MobileNativeSurfaceTab {
  readonly id: string;
  readonly url: string;
}

export interface UseMobileNativeTabSurfacesArgs {
  /**
   * Whether the `native-mobile-webview` render path is active. When false the
   * hook is inert (no surfaces created) — the Browser view is rendering iframes
   * or the desktop OOPIF instead.
   */
  readonly active: boolean;
  /** The open Browser tabs, in order. The live surface set mirrors this exactly. */
  readonly tabs: readonly MobileNativeSurfaceTab[];
  /** The foregrounded tab id, or null when none is selected. */
  readonly selectedTabId: string | null;
  /**
   * Whether a React overlay (tab switcher, confirm dialog) is open. While true
   * every native surface is backgrounded so it cannot paint over the overlay.
   */
  readonly overlayOpen: boolean;
  /**
   * Host elements that must paint and receive input above the native page. Their
   * live rounded bounds become native occlusion holes.
   */
  readonly occlusionSelector?: string;
  /**
   * The explicit process/storage policy every surface is created with — derived
   * from the Browser manifest via `deriveSurfacePlacement`, never defaulted here.
   */
  readonly policy: NativeSurfacePolicy;
  /**
   * Retention when the Browser view unmounts: `retained` keeps surfaces warm in
   * the background, `ephemeral` destroys them. Read from the manifest lifecycle
   * so flipping the manifest changes teardown with no code change here.
   */
  readonly lifecycle: SurfaceLifecyclePolicy;
  /**
   * Injectable shell. Production passes nothing and gets the Capacitor driver;
   * tests pass a faithful in-memory shell to assert the exact command sequence.
   */
  readonly shell?: NativeSurfaceShell;
  readonly onNavigation?: (event: {
    tabId: string;
    url: string;
    previousUrl: string | undefined;
  }) => void;
}

/** The imperative handles the Browser view binds to per-tab DOM + navigation. */
export interface MobileNativeTabSurfaces {
  /**
   * Ref callback for a tab's placeholder `<div>`. Registering an element starts
   * bounds tracking for that tab; passing null (on unmount) stops it.
   */
  registerSurfaceElement(tabId: string, element: HTMLElement | null): void;
  /** Load a URL in a tab's native surface (address-bar navigation). */
  navigateSurface(tabId: string, url: string): void;
  /** Reload the current page through the native reconciler. */
  reloadSurface(tabId: string): void;
  /** Step through the selected native page's history without server-tab dispatch. */
  backSurface(tabId: string): Promise<void>;
  readPage(tabId: string, selector?: string): Promise<NativePageRead>;
  /** Transport failure replacing a blank or stale native layer, if any. */
  readonly error: MobileNativeSurfaceError | null;
  /** Replay the failed desired-state commands after the user chooses Retry. */
  retry(): void;
}

export interface MobileNativeSurfaceError {
  readonly key: string;
  readonly message: string;
  /**
   * True when the failure is a permanent device-capability denial (the system
   * WebView cannot honour the surface's isolation policy) rather than a
   * transient transport fault. Retrying a permanent denial reproduces the same
   * native rejection, so the renderer should offer an escape hatch (open the
   * page externally) instead of a Retry that can never succeed. The security
   * posture stays fail-closed either way: no shared-storage or in-realm
   * fallback is ever created.
   */
  readonly permanent: boolean;
}

/**
 * Namespacing the shell id keeps Browser-tab surfaces from colliding with any
 * other native surface the app may layer in future; the tab id alone is not a
 * guaranteed-unique key across surface owners.
 */
function surfaceIdOf(tabId: string): string {
  return `browser-tab:${tabId}`;
}

function describeNativeSurfaceFailure(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message.trim().length > 0) {
      if (messages.at(-1) !== current.message) messages.push(current.message);
      current = current.cause;
      continue;
    }
    break;
  }
  return messages.join(" <- ") || "The native Browser surface is unavailable.";
}

// Native surface identity outlives a React view instance. One process-scoped
// reconciler therefore owns every production remount; injected test shells stay
// lane-local and deterministic.
const PROCESS_NATIVE_SURFACE_SHELL = new CapacitorNativeSurfaceShell();
const HOST_VISIBILITY_COMMAND = "browser-native-host:visibility";

interface SurfaceLeaseHolder {
  readonly order: number;
  onPromoted(): void;
}

interface SurfaceLeaseState {
  readonly holders: Map<symbol, SurfaceLeaseHolder>;
  authority: symbol;
}

const SURFACE_LEASES = new WeakMap<
  NativeSurfaceShell,
  Map<string, SurfaceLeaseState>
>();
let surfaceLeaseOrder = 0;
let processPresentationPaused = false;
let processPresentationLatchInstalled = false;

function acquireSurfaceLease(
  shell: NativeSurfaceShell,
  id: string,
  holder: symbol,
  onPromoted: () => void,
): boolean {
  let byId = SURFACE_LEASES.get(shell);
  if (!byId) {
    byId = new Map();
    SURFACE_LEASES.set(shell, byId);
  }
  let state = byId.get(id);
  if (!state) {
    state = { holders: new Map(), authority: holder };
    byId.set(id, state);
  }
  const existing = state.holders.get(holder);
  if (existing) {
    existing.onPromoted = onPromoted;
  } else {
    surfaceLeaseOrder += 1;
    state.holders.set(holder, { order: surfaceLeaseOrder, onPromoted });
    state.authority = holder;
  }
  return state.authority === holder;
}

function ownsSurfaceLease(
  shell: NativeSurfaceShell,
  id: string,
  holder: symbol,
): boolean {
  return SURFACE_LEASES.get(shell)?.get(id)?.authority === holder;
}

function releaseSurfaceLease(
  shell: NativeSurfaceShell,
  id: string,
  holder: symbol,
): boolean {
  const byId = SURFACE_LEASES.get(shell);
  const state = byId?.get(id);
  if (!state) return true;
  const wasAuthority = state.authority === holder;
  state.holders.delete(holder);
  if (state.holders.size > 0) {
    if (wasAuthority) {
      const promoted = [...state.holders.entries()].reduce((latest, entry) =>
        entry[1].order > latest[1].order ? entry : latest,
      );
      state.authority = promoted[0];
      promoted[1].onPromoted();
    }
    return false;
  }
  byId?.delete(id);
  if (byId?.size === 0) SURFACE_LEASES.delete(shell);
  return true;
}

function hasSurfaceLeases(shell: NativeSurfaceShell): boolean {
  return (SURFACE_LEASES.get(shell)?.size ?? 0) > 0;
}

// A Browser view may unmount while the native app changes activity state. This
// module-lifetime latch keeps later remounts hidden until the real resume edge;
// hook-local listeners only reconcile native presentation for a mounted view.
function ensureProcessPresentationLatch(): void {
  if (processPresentationLatchInstalled || typeof document === "undefined") {
    return;
  }
  processPresentationLatchInstalled = true;
  processPresentationPaused = document.visibilityState === "hidden";
  document.addEventListener(APP_PAUSE_EVENT, () => {
    processPresentationPaused = true;
  });
  document.addEventListener(APP_RESUME_EVENT, () => {
    processPresentationPaused = false;
  });
}

ensureProcessPresentationLatch();

function presentationIsPaused(): boolean {
  return (
    processPresentationPaused ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  );
}

function roundedCssPixel(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseCornerRadius(value: string): number | null {
  const radius = Number.parseFloat(value);
  return Number.isFinite(radius) && radius >= 0
    ? roundedCssPixel(radius)
    : null;
}

function firstParsedCornerRadius(
  ...values: ReadonlyArray<string | undefined>
): number {
  for (const value of values) {
    if (value === undefined) continue;
    const radius = parseCornerRadius(value);
    if (radius !== null) return radius;
  }
  return 0;
}

const ZERO_CORNER_RADII: SurfaceCornerRadii = {
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

function rectHasArea(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function roundedRect(rect: DOMRect): Omit<SurfaceBounds, "outerClip"> {
  return {
    x: roundedCssPixel(rect.left),
    y: roundedCssPixel(rect.top),
    width: roundedCssPixel(rect.width),
    height: roundedCssPixel(rect.height),
  };
}

function readCornerRadii(style: CSSStyleDeclaration): SurfaceCornerRadii {
  const shorthand = parseCornerRadius(style.borderRadius) ?? 0;
  return {
    topLeft: parseCornerRadius(style.borderTopLeftRadius) ?? shorthand,
    topRight: parseCornerRadius(style.borderTopRightRadius) ?? shorthand,
    bottomRight: parseCornerRadius(style.borderBottomRightRadius) ?? shorthand,
    bottomLeft: parseCornerRadius(style.borderBottomLeftRadius) ?? shorthand,
  };
}

function hasRoundedCorner(radii: SurfaceCornerRadii): boolean {
  return Object.values(radii).some((radius) => radius > 0);
}

function clipsDescendants(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value === "hidden" || value === "clip",
  );
}

function findRoundedClipHost(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  for (
    let candidate: HTMLElement | null = element;
    candidate;
    candidate = candidate.parentElement
  ) {
    const style = view.getComputedStyle(candidate);
    if (clipsDescendants(style) && hasRoundedCorner(readCornerRadii(style))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the real rounded React clip enclosing a native page. The search is
 * structural: it follows the DOM to the nearest rounded overflow clip and reads
 * computed pixels, so the native contract never duplicates a Tailwind token or
 * assumes the host and page placeholder share an element.
 */
export function collectSurfaceOuterClip(
  element: HTMLElement,
): SurfaceOuterClip {
  const surfaceRect = element.getBoundingClientRect();
  const host = findRoundedClipHost(element);
  if (!host) {
    return { ...roundedRect(surfaceRect), cornerRadii: ZERO_CORNER_RADII };
  }
  const hostRect = host.getBoundingClientRect();
  if (!rectHasArea(hostRect)) {
    return { ...roundedRect(surfaceRect), cornerRadii: ZERO_CORNER_RADII };
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(host);
  return {
    ...roundedRect(hostRect),
    cornerRadii: style ? readCornerRadii(style) : ZERO_CORNER_RADII,
  };
}

/**
 * Reads the visible rounded geometry for native-layer occlusion. Kept pure over
 * the supplied document so the exact DOM→native contract is regression-tested.
 */
export function collectSurfaceOcclusionRects(
  selector: string | undefined,
  ownerDocument: Document,
): SurfaceOcclusionRect[] {
  if (!selector) return [];
  const rects: SurfaceOcclusionRect[] = [];
  const seen = new Set<Element>();
  for (const element of ownerDocument.querySelectorAll<HTMLElement>(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const style = ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (!rectHasArea(rect)) {
      continue;
    }
    rects.push({
      x: roundedCssPixel(rect.left),
      y: roundedCssPixel(rect.top),
      width: roundedCssPixel(rect.width),
      height: roundedCssPixel(rect.height),
      // Motion-driven chat chrome writes `border-radius` as a CSS variable
      // (`var(--chat-sheet-radius)`). The inline token is intentionally not a
      // number, while computed style contains the resolved pixel radius. Keep
      // explicit numeric inline geometry authoritative, but continue through
      // unparseable inline tokens to their computed values; otherwise Android
      // receives radius 0 and cuts a square native-WebView hole behind the
      // rounded chat sheet.
      cornerRadius: firstParsedCornerRadius(
        element.style.borderTopLeftRadius,
        element.style.borderRadius,
        style?.borderTopLeftRadius,
        style?.borderRadius,
      ),
    });
  }
  // A native mask represents the union of these regions. Nested portal/status
  // chrome is already covered by its outer sheet; dropping contained geometry
  // prevents even-odd native masks from toggling those pixels back on.
  return rects
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .reduce<SurfaceOcclusionRect[]>((outer, rect) => {
      const contained = outer.some(
        (candidate) =>
          rect.x >= candidate.x &&
          rect.y >= candidate.y &&
          rect.x + rect.width <= candidate.x + candidate.width &&
          rect.y + rect.height <= candidate.y + candidate.height,
      );
      if (!contained) outer.push(rect);
      return outer;
    }, []);
}

export function useMobileNativeTabSurfaces(
  args: UseMobileNativeTabSurfacesArgs,
): MobileNativeTabSurfaces {
  const {
    active,
    tabs,
    selectedTabId,
    overlayOpen,
    occlusionSelector,
    policy,
    lifecycle,
    shell,
  } = args;

  const activeShell = shell ?? PROCESS_NATIVE_SURFACE_SHELL;
  const onNavigationRef = useRef(args.onNavigation);
  onNavigationRef.current = args.onNavigation;
  const [navigationRetry, setNavigationRetry] = useState(0);
  const [navigationError, setNavigationError] =
    useState<MobileNativeSurfaceError | null>(null);

  const elements = useRef(new Map<string, HTMLElement>());
  const leaseHolder = useRef(Symbol("browser-native-surface-hook"));
  // The tab ids this hook has handed to the shell. Native acceptance is tracked
  // by the shell itself; this desired-set may include a create still in flight so
  // initial bounds/holes can queue behind that acknowledged create.
  const managedTabIds = useRef(new Set<string>());
  const observedCommands = useRef(new Map<string, ObservedSurfaceCommand>());
  const previousActive = useRef(active);
  const presentedLeaseRevision = useRef(0);
  const reloadRevision = useRef(0);
  const [, setCommandRevision] = useState(0);
  const failedCommands = [...observedCommands.current.entries()].filter(
    ([, command]) =>
      command.status === "failed" || command.status === "recovering",
  );
  // A permanent capability denial outranks transient faults for display:
  // when the device cannot host the surface at all, that is the state the
  // user must see, not whichever transient command happened to fail first.
  const firstFailedCommand =
    failedCommands.find(([, command]) => command.permanent) ??
    failedCommands[0];
  const surfaceError: MobileNativeSurfaceError | null = firstFailedCommand
    ? {
        key: firstFailedCommand[0],
        message:
          firstFailedCommand[1].error ??
          "The native Browser surface is unavailable.",
        permanent: firstFailedCommand[1].permanent,
      }
    : null;
  const hasFailedCommands = failedCommands.length > 0;
  const [leaseRevision, setLeaseRevision] = useState(0);
  // Latest lifecycle for the unmount cleanup, which runs with an empty dep list
  // and would otherwise close over a stale value.
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  useEffect(() => {
    ensureProcessPresentationLatch();
  }, []);

  const notifyCommandStateChanged = useCallback((): void => {
    setCommandRevision((current) => current + 1);
  }, []);

  const requestLeaseReconcile = useCallback((id: string): void => {
    // A newer hook may have replaced every acknowledged property while this
    // holder was demoted. Promotion therefore invalidates local success state;
    // desired geometry, holes, and presentation must all cross the bridge again.
    const prefix = `${id}:`;
    for (const key of observedCommands.current.keys()) {
      if (key === HOST_VISIBILITY_COMMAND || key.startsWith(prefix)) {
        observedCommands.current.delete(key);
      }
    }
    setLeaseRevision((current) => current + 1);
  }, []);

  const ownsAnyManagedSurface = useCallback(
    (): boolean =>
      [...managedTabIds.current].some((tabId) =>
        ownsSurfaceLease(activeShell, surfaceIdOf(tabId), leaseHolder.current),
      ),
    [activeShell],
  );

  const issueCommand = useCallback(
    (
      key: string,
      signature: string,
      invoke: () => Promise<void>,
      isAuthorized: () => boolean = () => true,
    ): void => {
      const existing = observedCommands.current.get(key);
      if (existing?.signature === signature) return;
      const replacesFailure =
        existing?.status === "failed" || existing?.status === "recovering";
      const command: ObservedSurfaceCommand = {
        signature,
        status: replacesFailure ? "recovering" : "pending",
        invoke,
        isAuthorized,
        error: replacesFailure ? existing.error : null,
        permanent: replacesFailure ? existing.permanent : false,
        retry: () => run(true),
      };
      observedCommands.current.set(key, command);
      const run = (recovery: boolean): void => {
        if (observedCommands.current.get(key) !== command) return;
        // Overlapping React owners share one native session, so the native
        // epoch cannot distinguish a demoted hook's replay from current intent.
        // Recheck the module lease at every attempt, including Retry/resume.
        if (!command.isAuthorized()) {
          observedCommands.current.delete(key);
          if (command.status === "failed" || command.status === "recovering") {
            notifyCommandStateChanged();
          }
          return;
        }
        command.status = recovery ? "recovering" : "pending";
        if (recovery) notifyCommandStateChanged();
        let acknowledgement: Promise<void>;
        try {
          acknowledgement = invoke();
        } catch (error) {
          // error-policy:J1 the React/native command boundary translates a
          // synchronous bridge failure into the same visible state as rejection.
          acknowledgement = Promise.reject(error);
        }
        acknowledgement.then(
          () => {
            if (observedCommands.current.get(key) === command) {
              const recovered = command.status === "recovering";
              command.status = "succeeded";
              command.error = null;
              if (recovered) notifyCommandStateChanged();
            }
          },
          (error: unknown) => {
            if (observedCommands.current.get(key) !== command) return;
            command.status = "failed";
            command.error = describeNativeSurfaceFailure(error);
            command.permanent = isNativeSurfaceCapabilityDenial(error);
            notifyCommandStateChanged();
          },
        );
      };
      run(replacesFailure);
    },
    [notifyCommandStateChanged],
  );

  const cancelSurfaceCommands = useCallback(
    (id: string, clearRenderedError = true): void => {
      const prefix = `${id}:`;
      let removedFailure = false;
      for (const key of observedCommands.current.keys()) {
        if (!key.startsWith(prefix)) continue;
        const command = observedCommands.current.get(key);
        removedFailure ||=
          command?.status === "failed" || command?.status === "recovering";
        observedCommands.current.delete(key);
      }
      if (clearRenderedError && removedFailure) notifyCommandStateChanged();
    },
    [notifyCommandStateChanged],
  );

  const cancelCommand = useCallback(
    (key: string): void => {
      const command = observedCommands.current.get(key);
      if (!command) return;
      observedCommands.current.delete(key);
      if (command.status === "failed" || command.status === "recovering") {
        notifyCommandStateChanged();
      }
    },
    [notifyCommandStateChanged],
  );

  const retry = useCallback((): void => {
    const failed = [...observedCommands.current.values()].filter(
      (command) => command.status === "failed",
    );
    for (const command of failed) command.retry();
    setNavigationRetry((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit Retry replaces the native listener after bridge failure.
  useEffect(() => {
    if (!active || !onNavigationRef.current) return;
    let disposed = false;
    let release: (() => Promise<void>) | undefined;
    const onError = (error: unknown): void => {
      if (!disposed)
        setNavigationError({
          key: "navigation-observation",
          message: describeNativeSurfaceFailure(error),
          permanent: isNativeSurfaceCapabilityDenial(error),
        });
    };
    void activeShell
      .subscribeNavigation((event) => {
        if (
          disposed ||
          !ownsSurfaceLease(activeShell, event.id, leaseHolder.current)
        )
          return;
        const tabId = [...managedTabIds.current].find(
          (id) => surfaceIdOf(id) === event.id,
        );
        if (!tabId) return;
        setNavigationError(null);
        onNavigationRef.current?.({
          tabId,
          url: event.url,
          previousUrl: event.previousUrl,
        });
      }, onError)
      .then(async (remove) => {
        if (disposed) await remove();
        else {
          release = remove;
          setNavigationError(null);
        }
      })
      .catch((error: unknown) => {
        if (disposed) {
          // error-policy:J6 a listener registered after unmount still needs
          // observable teardown failures; it cannot update the retired view.
          logger.warn(
            { error },
            "Native Browser navigation subscription cleanup failed",
          );
          return;
        }
        // error-policy:J1 render subscription failure at the native UI boundary.
        onError(error);
      });
    return () => {
      disposed = true;
      if (release)
        void release().catch((error: unknown) => {
          // error-policy:J6 listener teardown cannot update an unmounted view.
          logger.warn(
            { error },
            "Native Browser navigation listener cleanup failed",
          );
        });
    };
  }, [active, activeShell, navigationRetry]);

  const measure = useCallback(
    (tabId: string): void => {
      const element = elements.current.get(tabId);
      const id = surfaceIdOf(tabId);
      if (
        !element ||
        !managedTabIds.current.has(tabId) ||
        !ownsSurfaceLease(activeShell, id, leaseHolder.current)
      ) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (!rectHasArea(rect)) return;
      const bounds: SurfaceBounds = {
        ...roundedRect(rect),
        outerClip: collectSurfaceOuterClip(element),
      };
      issueCommand(
        `${id}:bounds`,
        JSON.stringify(bounds),
        () => activeShell.setBounds(id, bounds),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
    },
    [activeShell, issueCommand],
  );

  const registerSurfaceElement = useCallback(
    (tabId: string, element: HTMLElement | null): void => {
      if (element) {
        elements.current.set(tabId, element);
        if (active) measure(tabId);
      } else {
        elements.current.delete(tabId);
      }
    },
    [active, measure],
  );

  const navigateSurface = useCallback(
    (tabId: string, url: string): void => {
      if (!active) return;
      const id = surfaceIdOf(tabId);
      if (!ownsSurfaceLease(activeShell, id, leaseHolder.current)) return;
      issueCommand(
        `${id}:navigate`,
        url,
        () => activeShell.navigate(id, url),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
    },
    [active, activeShell, issueCommand],
  );

  const reloadSurface = useCallback(
    (tabId: string): void => {
      if (!active) return;
      const id = surfaceIdOf(tabId);
      if (!ownsSurfaceLease(activeShell, id, leaseHolder.current)) return;
      reloadRevision.current += 1;
      issueCommand(
        `${id}:reload`,
        `${reloadRevision.current}`,
        () => activeShell.reload(id),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
    },
    [active, activeShell, issueCommand],
  );

  const backSurface = useCallback(
    async (tabId: string): Promise<void> => {
      const id = surfaceIdOf(tabId);
      if (!active || !ownsSurfaceLease(activeShell, id, leaseHolder.current)) {
        throw new Error("This renderer no longer owns the Browser tab.");
      }
      await activeShell.back(id);
    },
    [active, activeShell],
  );

  const readPage = useCallback(
    async (tabId: string, selector?: string): Promise<NativePageRead> => {
      const id = surfaceIdOf(tabId);
      if (!active || !ownsSurfaceLease(activeShell, id, leaseHolder.current)) {
        throw new Error("This renderer no longer owns the Browser tab.");
      }
      const result = await activeShell.readPage(id, selector);
      if (!ownsSurfaceLease(activeShell, id, leaseHolder.current)) {
        throw new Error("This renderer no longer owns the Browser tab.");
      }
      return result;
    },
    [active, activeShell],
  );

  const readOcclusions = useCallback(
    (): SurfaceOcclusionRect[] =>
      typeof document === "undefined"
        ? []
        : collectSurfaceOcclusionRects(occlusionSelector, document),
    [occlusionSelector],
  );

  const syncOcclusions = useCallback((): void => {
    const rects = readOcclusions();
    for (const tabId of managedTabIds.current) {
      const id = surfaceIdOf(tabId);
      if (!ownsSurfaceLease(activeShell, id, leaseHolder.current)) continue;
      issueCommand(
        `${id}:occlusions`,
        JSON.stringify(rects),
        () => activeShell.setOcclusionRects(id, rects),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
    }
  }, [activeShell, issueCommand, readOcclusions]);

  const syncVisibility = useCallback(
    (force: boolean): void => {
      if (!active) return;
      const selected = tabs.find((tab) => tab.id === selectedTabId);
      const selectedSurfaceId = selected ? surfaceIdOf(selected.id) : null;
      const ownsSelected =
        selectedSurfaceId !== null &&
        ownsSurfaceLease(activeShell, selectedSurfaceId, leaseHolder.current);
      const ownsAny = ownsAnyManagedSurface();
      if ((selected && !ownsSelected) || (!selected && !ownsAny)) return;
      const presentedId =
        !hasFailedCommands &&
        !presentationIsPaused() &&
        !overlayOpen &&
        ownsSelected
          ? selectedSurfaceId
          : null;
      if (force) cancelCommand(HOST_VISIBILITY_COMMAND);
      issueCommand(
        HOST_VISIBILITY_COMMAND,
        presentedId ?? "host",
        () => activeShell.presentSurface(presentedId),
        () =>
          presentedId !== null
            ? ownsSurfaceLease(activeShell, presentedId, leaseHolder.current)
            : ownsAnyManagedSurface(),
      );
      if (presentedId && selected) measure(selected.id);
    },
    [
      active,
      tabs,
      overlayOpen,
      selectedTabId,
      hasFailedCommands,
      activeShell,
      cancelCommand,
      issueCommand,
      measure,
      ownsAnyManagedSurface,
    ],
  );

  // Reconcile the live surface set with `tabs`: create surfaces for new tabs
  // (explicit policy, never a default) and destroy surfaces for closed tabs.
  // Create is the declarative URL owner too: the shell reconciles a changed URL
  // with `navigate`, while a close/reopen generation crosses native absence.
  useEffect(() => {
    if (!active) return;
    const wanted = new Set(tabs.map((tab) => tab.id));
    for (const tab of tabs) {
      const id = surfaceIdOf(tab.id);
      if (!managedTabIds.current.has(tab.id)) {
        managedTabIds.current.add(tab.id);
      }
      const ownsIntent = acquireSurfaceLease(
        activeShell,
        id,
        leaseHolder.current,
        () => requestLeaseReconcile(id),
      );
      if (!ownsIntent) continue;
      const request = { id, url: tab.url, policy } as const;
      // Regaining authority after an overlapping renderer unmounts must replay
      // this hook's intent even when its last local acknowledgement succeeded.
      issueCommand(
        `${id}:lifecycle`,
        `create:${leaseRevision}:${JSON.stringify(request)}`,
        () => activeShell.createSurface(request),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
      measure(tab.id);
      const rects = readOcclusions();
      issueCommand(
        `${id}:occlusions`,
        JSON.stringify(rects),
        () => activeShell.setOcclusionRects(id, rects),
        () => ownsSurfaceLease(activeShell, id, leaseHolder.current),
      );
    }
    for (const tabId of [...managedTabIds.current]) {
      if (!wanted.has(tabId)) {
        const id = surfaceIdOf(tabId);
        cancelSurfaceCommands(id);
        if (releaseSurfaceLease(activeShell, id, leaseHolder.current)) {
          issueCommand(
            `${id}:lifecycle`,
            "destroy",
            () => activeShell.destroySurface(id),
            () => !SURFACE_LEASES.get(activeShell)?.has(id),
          );
        }
        managedTabIds.current.delete(tabId);
        elements.current.delete(tabId);
      }
    }
  }, [
    active,
    tabs,
    policy,
    activeShell,
    cancelSurfaceCommands,
    issueCommand,
    leaseRevision,
    measure,
    readOcclusions,
    requestLeaseReconcile,
  ]);

  // Keep React-chrome holes aligned. ResizeObserver catches layout changes;
  // MutationObserver catches portals and Motion style writes. During a chat
  // spring/drag, its canonical transient-layout marker keeps one rAF loop alive
  // so transform-only frames cannot slip between discrete DOM mutations.
  useEffect(() => {
    if (
      !active ||
      !occlusionSelector ||
      typeof document === "undefined" ||
      typeof window === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    let observed = new Set<Element>();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());

    const refreshObservedElements = (): void => {
      if (!resizeObserver) return;
      const next = new Set(document.querySelectorAll(occlusionSelector));
      for (const element of observed) {
        if (!next.has(element)) resizeObserver.unobserve(element);
      }
      for (const element of next) {
        if (!observed.has(element)) resizeObserver.observe(element);
      }
      observed = next;
    };
    const run = (): void => {
      frame = null;
      syncOcclusions();
      if (
        document.querySelector('[data-eliza-layout-shift-intent="transient"]')
      ) {
        schedule();
      }
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(run);
    };

    refreshObservedElements();
    syncOcclusions();
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedElements();
            schedule();
          });
    mutationObserver?.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "data-chat-state",
        "data-eliza-layout-shift-intent",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("scroll", schedule, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [active, occlusionSelector, syncOcclusions]);

  // Page placement and the rounded host clip have a separate observer from the
  // chat-hole animation loop. The shell sequences these writes behind creation
  // and deduplicates only after native acceptance; keeping measurement free of
  // pre-ack caches means a rejected write remains retryable.
  useEffect(() => {
    if (
      !active ||
      typeof document === "undefined" ||
      typeof window === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const attributeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedGeometry();
            schedule();
          });

    const measureAll = (): void => {
      frame = null;
      for (const tabId of elements.current.keys()) measure(tabId);
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measureAll);
    };
    const refreshObservedGeometry = (): void => {
      resizeObserver?.disconnect();
      attributeObserver?.disconnect();
      const resizeTargets = new Set<HTMLElement>();
      const attributeTargets = new Set<HTMLElement>();
      for (const element of elements.current.values()) {
        resizeTargets.add(element);
        const clipHost = findRoundedClipHost(element);
        if (clipHost) resizeTargets.add(clipHost);
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          attributeTargets.add(ancestor);
        }
      }
      for (const target of resizeTargets) resizeObserver?.observe(target);
      for (const target of attributeTargets) {
        attributeObserver?.observe(target, {
          attributes: true,
          attributeFilter: ["class", "style", "hidden"],
        });
      }
    };
    const treeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedGeometry();
            schedule();
          });

    refreshObservedGeometry();
    schedule();
    treeObserver?.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("scroll", schedule, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      treeObserver?.disconnect();
      attributeObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [active, measure]);

  // One global transaction selects the active native page, while an overlay,
  // pause, or terminal surface error returns paint/input ownership to the host.
  useEffect(() => {
    const authorityChanged = presentedLeaseRevision.current !== leaseRevision;
    presentedLeaseRevision.current = leaseRevision;
    syncVisibility(authorityChanged);
  }, [leaseRevision, syncVisibility]);

  // App pause gives paint/input ownership back to the host immediately. Resume
  // invalidates the hook's successful acknowledgements and replays failed
  // desired state plus the selected/background set through the same
  // process-scoped reconciler. Resume is a bounded external recovery edge, not
  // a timer: an unavailable surface remains visibly failed until this edge or
  // an explicit Retry.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const pause = (): void => {
      processPresentationPaused = true;
      const ownsAny = ownsAnyManagedSurface();
      if (!ownsAny) return;
      cancelCommand(HOST_VISIBILITY_COMMAND);
      issueCommand(
        HOST_VISIBILITY_COMMAND,
        "paused",
        () => activeShell.presentSurface(null),
        ownsAnyManagedSurface,
      );
    };
    const resume = (): void => {
      processPresentationPaused = false;
      if (managedTabIds.current.size === 0) return;
      retry();
      cancelCommand(HOST_VISIBILITY_COMMAND);
      syncVisibility(true);
    };
    document.addEventListener(APP_PAUSE_EVENT, pause);
    document.addEventListener(APP_RESUME_EVENT, resume);
    return () => {
      document.removeEventListener(APP_PAUSE_EVENT, pause);
      document.removeEventListener(APP_RESUME_EVENT, resume);
    };
  }, [
    activeShell,
    cancelCommand,
    issueCommand,
    ownsAnyManagedSurface,
    retry,
    syncVisibility,
  ]);

  // A render-path handoff can leave this hook mounted while host content takes
  // over. Hide every child surface in that state; reactivation replays the
  // declarative selected/background set without recreating WebViews.
  useEffect(() => {
    const wasActive = previousActive.current;
    previousActive.current = active;
    if (wasActive === active) return;
    cancelCommand(HOST_VISIBILITY_COMMAND);
    if (active) {
      syncVisibility(true);
      return;
    }
    const ownsAny = ownsAnyManagedSurface();
    if (ownsAny) {
      issueCommand(
        HOST_VISIBILITY_COMMAND,
        "host-render-path",
        () => activeShell.presentSurface(null),
        ownsAnyManagedSurface,
      );
    }
  }, [
    active,
    activeShell,
    cancelCommand,
    issueCommand,
    ownsAnyManagedSurface,
    syncVisibility,
  ]);

  // On unmount, apply the manifest lifecycle: `retained` keeps surfaces warm in
  // the background; `ephemeral` (the Browser default) tears them down.
  useEffect(() => {
    const managed = managedTabIds.current;
    return () => {
      const hadManagedSurfaces = managed.size > 0;
      cancelCommand(HOST_VISIBILITY_COMMAND);
      for (const tabId of managed) {
        const id = surfaceIdOf(tabId);
        cancelSurfaceCommands(id, false);
        const finalHolder = releaseSurfaceLease(
          activeShell,
          id,
          leaseHolder.current,
        );
        const acknowledgement =
          lifecycleRef.current === "retained" || !finalHolder
            ? Promise.resolve()
            : activeShell.destroySurface(id);
        // error-policy:J5 the process-scoped shell observes and reports terminal
        // teardown failure; this retired hook cannot render or retry it safely.
        acknowledgement.then(
          () => undefined,
          () => undefined,
        );
      }
      managed.clear();
      if (hadManagedSurfaces && !hasSurfaceLeases(activeShell)) {
        // error-policy:J5 the process-scoped shell reports teardown failure;
        // this retired hook must not retry over a newer mount's generation.
        activeShell.presentSurface(null).then(
          () => undefined,
          () => undefined,
        );
      }
    };
    // Cleanup must run only on unmount; it reads the shell + lifecycle via refs.
  }, [activeShell, cancelCommand, cancelSurfaceCommands]);

  return {
    registerSurfaceElement,
    navigateSurface,
    reloadSurface,
    backSurface,
    readPage,
    error: surfaceError ?? navigationError,
    retry,
  };
}

interface ObservedSurfaceCommand {
  readonly signature: string;
  readonly invoke: () => Promise<void>;
  readonly isAuthorized: () => boolean;
  status: "pending" | "recovering" | "succeeded" | "failed";
  error: string | null;
  /** Whether the recorded failure is a permanent device-capability denial. */
  permanent: boolean;
  retry(): void;
}
