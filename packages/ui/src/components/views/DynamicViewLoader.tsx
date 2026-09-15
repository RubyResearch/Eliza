/**
 * DynamicViewLoader — loads a view bundle from a remote URL at runtime.
 *
 * Each view lives behind a React.lazy boundary so it is only fetched when
 * first navigated to, and an ErrorBoundary wrapper prevents a failing view
 * from crashing the shell.
 *
 * Loaded modules are cached by bundleUrl so re-mounting does not re-fetch.
 *
 * On iOS App Store and Google Play builds, dynamic remote JS loading is
 * prohibited by platform policy. The loader detects this and renders a
 * static fallback instead of attempting to import the bundle.
 *
 * When a view module exports an `interact(capability, params)` function, the
 * loader registers it with view-interact-registry so the agent can invoke
 * capabilities via POST /api/views/:id/interact → WS → here → WS result.
 * Standard capabilities (get-text, get-state, refresh, focus-element,
 * click-element, fill-input) are handled by the loader itself even when the
 * module has no interact export.
 */

import {
  ElizaError,
  type ResolvedSurfaceManifest,
  resolveSurfaceManifest,
  type SurfaceManifest,
} from "@elizaos/core";
import {
  HOST_EXTERNAL_RUNTIME_PARAM,
  HOST_EXTERNAL_SPECIFIERS_PARAM,
  type HostExternalBundleFactory,
  type HostModuleImporter,
  resolveAppBranding,
} from "@elizaos/shared";
import {
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as AgentSurfaceHost from "../../agent-surface";
import {
  AgentElementOverlay,
  AgentSurfaceElementReporter,
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
  isSensitiveAgentElement,
  SENSITIVE_AGENT_ELEMENT_REASON,
  type ViewAgentRegistry,
} from "../../agent-surface";
import { client } from "../../api/index.ts";
import {
  registeredHostExternalSpecifiers,
  resolveRegisteredHostExternalImporter,
} from "../../app-shell-registry";
import {
  type EvictReason,
  emitModuleCacheTelemetry,
  type ModuleCacheTelemetryEvent,
} from "../../cache-telemetry";
import { APP_PAUSE_EVENT } from "../../events";
import { isDynamicViewLoadingAllowed } from "../../platform/platform-guards";
import { SpatialSurface } from "../../spatial/index.ts";
import {
  useAppSelector,
  useAppSelectorShallow,
} from "../../state/app-store.ts";
import {
  HEAP_PRESSURE_EVENT,
  isUnderMemoryPressure,
  planModuleCacheEvictions,
} from "../../state/bounded-view-lru";
import { installHeapPressureMonitor } from "../../state/heap-pressure-monitor";
import { useApp } from "../../state/useApp.ts";
import {
  getActiveSurfaceRealmScope,
  SurfaceRealmDeniedError,
  type SurfaceRealmScope,
  subscribeActiveSurfaceRealmScope,
} from "../../surface-realm-broker";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";
import { registerDetailExtension } from "../apps/extensions/registry.ts";
import {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "../apps/extensions/surface.helpers.ts";
import {
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "../apps/extensions/surface.tsx";
import { registerOverlayApp } from "../apps/overlay-app-registry.ts";
import { PagePanel } from "../composites/page-panel/index.ts";
import { Button } from "../ui/button.tsx";
import { ErrorBoundary } from "../ui/error-boundary";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { StatusBadge } from "../ui/status-badge.tsx";
import { SandboxedViewFrame } from "./SandboxedViewFrame";
import {
  navigateToViews,
  ViewErrorState,
  ViewLoadingSkeleton,
  ViewRestrictedState,
} from "./ViewStatusStates";
import { brokerViewInteract } from "./view-capability-broker";
import { registerViewInteractHandler } from "./view-interact-registry";

interface ViewBundleModule {
  component: ComponentType<Record<string, unknown>>;
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  cleanup?: () => void | Promise<void>;
}

interface ViewBundleCacheEntry {
  key: string;
  promise: Promise<ViewBundleModule>;
  module: ViewBundleModule | null;
  refCount: number;
  lastUsedAt: number;
  cleanupScheduled: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

// Browser ESM modules cannot be forcibly unloaded once imported, but the shell
// can stop retaining the resolved module object and call the view's exported
// cleanup hook. Keep a tiny LRU of recently used views so quick tab switches are
// instant, then drop idle/heavy views automatically.
const bundleModuleCache = new Map<string, ViewBundleCacheEntry>();
const bundleScopeIds = new WeakMap<SurfaceRealmScope, number>();
let nextBundleScopeId = 1;

function bundleCacheKey(
  bundleUrl: string,
  componentExport: string,
  scope: SurfaceRealmScope | null,
): string {
  if (!scope) return `${bundleUrl}::${componentExport}`;
  let scopeId = bundleScopeIds.get(scope);
  if (scopeId === undefined) {
    scopeId = nextBundleScopeId++;
    bundleScopeIds.set(scope, scopeId);
  }
  return `${bundleUrl}::${componentExport}::scope-${scopeId}`;
}
const DEFAULT_BUNDLE_CACHE_TTL_MS = 5 * 60_000;
const LOW_MEMORY_BUNDLE_CACHE_TTL_MS = 60_000;
const DEFAULT_BUNDLE_CACHE_MAX_ENTRIES = 6;
const LOW_MEMORY_BUNDLE_CACHE_MAX_ENTRIES = 2;

let bundleCacheLifecycleInstalled = false;
let pruneBundleCacheOnPressure: (() => void) | null = null;
let pruneBundleCacheOnHeapPressure: (() => void) | null = null;
let pruneBundleCacheOnVisibilityHidden: (() => void) | null = null;
let pruneBundleCacheOnAppPause: (() => void) | null = null;

function bundleCacheStats(): {
  activeCount: number;
  idleCount: number;
  cacheSize: number;
} {
  let activeCount = 0;
  let idleCount = 0;
  for (const entry of bundleModuleCache.values()) {
    if (entry.refCount > 0) {
      activeCount += 1;
    } else {
      idleCount += 1;
    }
  }
  return { activeCount, idleCount, cacheSize: bundleModuleCache.size };
}

function emitBundleTelemetry(
  action: ModuleCacheTelemetryEvent["action"],
  patch: { key?: string; reason?: EvictReason } = {},
): void {
  emitModuleCacheTelemetry({
    source: "dynamic-view",
    action,
    ...patch,
    ...bundleCacheStats(),
  });
}

function getBundleCacheMaxEntries(): number {
  if (isUnderMemoryPressure()) {
    return LOW_MEMORY_BUNDLE_CACHE_MAX_ENTRIES;
  }
  return DEFAULT_BUNDLE_CACHE_MAX_ENTRIES;
}

function getBundleCacheTtlMs(): number {
  if (isUnderMemoryPressure()) return LOW_MEMORY_BUNDLE_CACHE_TTL_MS;
  return DEFAULT_BUNDLE_CACHE_TTL_MS;
}

function scheduleIdleWork(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout?: number },
    ) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(work, { timeout: 2_000 });
    return;
  }
  window.setTimeout(work, 250);
}

function runBundleCleanup(cleanup: ViewBundleModule["cleanup"]): void {
  if (!cleanup) return;
  void Promise.resolve()
    .then(() => cleanup())
    .catch(() => {
      // View cleanup must never crash the host shell.
    });
}

function cleanupBundleEntry(
  entry: ViewBundleCacheEntry,
  reason: EvictReason,
): void {
  if (entry.refCount > 0) return;
  if (entry.cleanupScheduled) return;
  entry.cleanupScheduled = true;
  if (bundleModuleCache.get(entry.key) === entry) {
    bundleModuleCache.delete(entry.key);
  }
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }
  const cleanup = entry.module?.cleanup;
  entry.module = null;
  emitBundleTelemetry("evict", { key: entry.key, reason });
  runBundleCleanup(cleanup);
  if (cleanup) emitBundleTelemetry("cleanup", { key: entry.key, reason });
}

function armBundleEntryRetentionTimer(entry: ViewBundleCacheEntry): void {
  if (typeof window === "undefined") return;
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
  }
  entry.retentionTimer = setTimeout(() => {
    entry.retentionTimer = null;
    scheduleIdleWork(() => pruneBundleModuleCache());
  }, getBundleCacheTtlMs() + 50);
}

function pruneBundleModuleCache(
  options: { force?: boolean; reason?: EvictReason } = {},
): void {
  const ttlReason =
    options.reason ?? (options.force ? "memorypressure" : "ttl");
  const lruReason = options.reason ?? "lru";
  const plan = planModuleCacheEvictions([...bundleModuleCache.values()], {
    now: Date.now(),
    ttlMs: options.force ? 0 : getBundleCacheTtlMs(),
    maxEntries: options.force ? 0 : getBundleCacheMaxEntries(),
    force: options.force ?? false,
    totalSize: bundleModuleCache.size,
  });
  for (const { entry, phase } of plan) {
    cleanupBundleEntry(entry, phase === "ttl" ? ttlReason : lruReason);
  }
}

function installBundleCacheLifecycle(): void {
  if (bundleCacheLifecycleInstalled || typeof window === "undefined") return;
  bundleCacheLifecycleInstalled = true;
  installHeapPressureMonitor();
  pruneBundleCacheOnPressure = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "memorypressure" }),
    );
  };
  // Real heap-driven eviction (#10196): the shared heap-pressure monitor
  // (installHeapPressureMonitor) dispatches this when live usedJSHeapSize
  // crosses HEAP_PRESSURE_RATIO. Unlike the never-fired `memorypressure`
  // window event, this actually feeds live heap into the cache.
  pruneBundleCacheOnHeapPressure = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "heap-pressure" }),
    );
  };
  pruneBundleCacheOnVisibilityHidden = () => {
    if (document.visibilityState === "hidden") {
      scheduleIdleWork(() =>
        pruneBundleModuleCache({ reason: "visibility-hidden" }),
      );
    }
  };
  pruneBundleCacheOnAppPause = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "app-pause" }),
    );
  };
  window.addEventListener("memorypressure", pruneBundleCacheOnPressure);
  document.addEventListener(
    HEAP_PRESSURE_EVENT,
    pruneBundleCacheOnHeapPressure,
  );
  document.addEventListener(
    "visibilitychange",
    pruneBundleCacheOnVisibilityHidden,
  );
  document.addEventListener(APP_PAUSE_EVENT, pruneBundleCacheOnAppPause);
}

export function __resetDynamicViewLoaderCacheForTests(): void {
  for (const entry of bundleModuleCache.values()) {
    if (entry.retentionTimer) {
      clearTimeout(entry.retentionTimer);
      entry.retentionTimer = null;
    }
    const cleanup = entry.module?.cleanup;
    entry.module = null;
    runBundleCleanup(cleanup);
  }
  bundleModuleCache.clear();
  if (typeof window !== "undefined" && pruneBundleCacheOnPressure) {
    window.removeEventListener("memorypressure", pruneBundleCacheOnPressure);
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnHeapPressure) {
    document.removeEventListener(
      HEAP_PRESSURE_EVENT,
      pruneBundleCacheOnHeapPressure,
    );
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnVisibilityHidden) {
    document.removeEventListener(
      "visibilitychange",
      pruneBundleCacheOnVisibilityHidden,
    );
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnAppPause) {
    document.removeEventListener(APP_PAUSE_EVENT, pruneBundleCacheOnAppPause);
  }
  pruneBundleCacheOnPressure = null;
  pruneBundleCacheOnHeapPressure = null;
  pruneBundleCacheOnVisibilityHidden = null;
  pruneBundleCacheOnAppPause = null;
  bundleCacheLifecycleInstalled = false;
}

function isReactComponentExport(
  value: unknown,
): value is ComponentType<Record<string, unknown>> {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function importHostExternal(
  specifier: string,
): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<
    Record<string, unknown>
  >;
}

// View bundles execute inside the host realm, so core exports must cross an
// explicit browser-safe boundary instead of retaining the runtime namespace in
// the initial app bundle. Additions belong here only when a real view consumes
// them and their browser behavior is covered by the loader contract tests.
const CORE_VIEW_COMPAT = Object.freeze({
  ElizaError,
}) satisfies Readonly<Record<"ElizaError", typeof ElizaError>>;

async function importCoreViewCompat(): Promise<Record<string, unknown>> {
  return CORE_VIEW_COMPAT;
}

const APP_CORE_VIEW_COMPAT: Record<string, unknown> = {
  client,
  resolveAppBranding,
  Button,
  Input,
  Spinner,
  PagePanel,
  registerDetailExtension,
  registerOverlayApp,
  useApp,
  useAppSelector,
  useAppSelectorShallow,
  StatusBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
};

async function importAppCoreViewCompat(): Promise<Record<string, unknown>> {
  return APP_CORE_VIEW_COMPAT;
}

async function importUiComponentsCompat(): Promise<Record<string, unknown>> {
  return import("../index.ts");
}

function resolveSurfaceRealmScopeForHostExternal(
  boundScope: SurfaceRealmScope | null,
  vector: "storage" | "navigate",
  detail: string,
): SurfaceRealmScope | null {
  const activeScope = getActiveSurfaceRealmScope();
  if (activeScope === boundScope) return boundScope;
  throw new SurfaceRealmDeniedError(
    boundScope?.viewId ?? "unscoped",
    vector,
    `stale host external call after surface deactivation: ${detail}`,
  );
}

async function importUiRootCompat(
  boundScope = getActiveSurfaceRealmScope(),
): Promise<Record<string, unknown>> {
  // The root package is deliberately limited to design-system primitives. The
  // brokered navigation and bridge adapters are overlaid for older view bundles
  // that still request those names from the root specifier; raw shell-global
  // channels are not part of the root namespace and therefore cannot leak here.
  const [rootModule, appNavigateView, bridge] = await Promise.all([
    import("../../index.ts"),
    importUiAppNavigateViewCompat(boundScope),
    importUiBridgeCompat(boundScope),
  ]);
  return { ...rootModule, ...appNavigateView, ...bridge };
}

async function importUiAppNavigateViewCompat(
  boundScope = getActiveSurfaceRealmScope(),
): Promise<Record<string, unknown>> {
  const appNavigateView = await import("../../app-navigate-view.ts");
  return {
    ...appNavigateView,
    navigateBrowserPath(path: string): void {
      const scope = resolveSurfaceRealmScopeForHostExternal(
        boundScope,
        "navigate",
        `blocked navigation to "${path}"`,
      );
      if (scope) {
        scope.navigate(path);
        return;
      }
      appNavigateView.navigateBrowserPath(path);
    },
  };
}

async function importUiBridgeCompat(
  boundScope = getActiveSurfaceRealmScope(),
): Promise<Record<string, unknown>> {
  const bridge = await import("../../bridge/index.ts");
  // The bridge barrel carries the shell-privileged raw-global channel for shell
  // code outside packages/ui; handing it to a view bundle would let the view
  // disarm the raw-global guards on itself. Views get the scoped storage
  // overrides below and nothing privileged.
  const {
    runAsPrivilegedShell: _runAsPrivilegedShell,
    shellHistory: _shellHistory,
    shellLocalStorage: _shellLocalStorage,
    ...viewSafeBridge
  } = bridge;
  return {
    ...viewSafeBridge,
    async getStorageValue(key: string): Promise<string | null> {
      const scope = resolveSurfaceRealmScopeForHostExternal(
        boundScope,
        "storage",
        `blocked read for key "${key}"`,
      );
      if (scope) return scope.storage.getItem(key);
      return bridge.getStorageValue(key);
    },
    async setStorageValue(key: string, value: string): Promise<void> {
      const scope = resolveSurfaceRealmScopeForHostExternal(
        boundScope,
        "storage",
        `blocked write for key "${key}"`,
      );
      if (scope) {
        scope.storage.setItem(key, value);
        return;
      }
      await bridge.setStorageValue(key, value);
    },
    async removeStorageValue(key: string): Promise<void> {
      const scope = resolveSurfaceRealmScopeForHostExternal(
        boundScope,
        "storage",
        `blocked removal for key "${key}"`,
      );
      if (scope) {
        scope.storage.removeItem(key);
        return;
      }
      await bridge.removeStorageValue(key);
    },
  };
}

// Framework + host modules the shell always provides to every view bundle:
// react, three, `@elizaos/core`, `@elizaos/ui/*`, the `@elizaos/app-core` view
// compat surface, `@elizaos/shared`, and the native capacitor bridges. This map is
// FRAMEWORK-ONLY — it must never list a plugin-specific specifier. A plugin (or
// a build-variant entrypoint) contributes its own specifiers through
// `registerHostExternalImporter` so adding a host-external plugin never edits
// this shared UI module.
type ScopedHostExternalImporter = (
  scope?: SurfaceRealmScope | null,
) => Promise<Record<string, unknown>>;
const HOST_EXTERNAL_IMPORTERS: Record<string, ScopedHostExternalImporter> = {
  "@elizaos/app-core": importAppCoreViewCompat,
  "@elizaos/app-core/browser": importAppCoreViewCompat,
  "@elizaos/app-core/ui-compat": importAppCoreViewCompat,
  "@elizaos/core": importCoreViewCompat,
  "@elizaos/capacitor-contacts": () =>
    importHostExternal("@elizaos/capacitor-contacts"),
  "@elizaos/capacitor-messages": () =>
    importHostExternal("@elizaos/capacitor-messages"),
  "@elizaos/capacitor-mobile-signals": () =>
    importHostExternal("@elizaos/capacitor-mobile-signals"),
  "@elizaos/capacitor-phone": () =>
    importHostExternal("@elizaos/capacitor-phone"),
  "@elizaos/capacitor-system": () =>
    importHostExternal("@elizaos/capacitor-system"),
  "@elizaos/shared": () => import("@elizaos/shared"),
  "@elizaos/ui": importUiRootCompat,
  "@elizaos/ui/agent-surface": async () => AgentSurfaceHost,
  "@elizaos/ui/app-navigate-view": importUiAppNavigateViewCompat,
  "@elizaos/ui/api": () => import("../../api/index.ts"),
  "@elizaos/ui/api/csrf-client": () => import("../../api/csrf-client.ts"),
  "@elizaos/ui/bridge": importUiBridgeCompat,
  "@elizaos/ui/components": importUiComponentsCompat,
  "@elizaos/ui/config": () => import("../../config/index.ts"),
  "@elizaos/ui/events": () => import("../../events/index.ts"),
  "@elizaos/ui/hooks": () => import("../../hooks/index.ts"),
  "@elizaos/ui/layouts": () => import("../../layouts/index.ts"),
  "@elizaos/ui/platform": () => import("../../platform/index.ts"),
  "@elizaos/ui/platform/ios-runtime": () =>
    import("../../platform/ios-runtime.ts"),
  "@elizaos/ui/spatial": () => import("../../spatial/index.ts"),
  "@elizaos/ui/state": () => import("../../state/index.ts"),
  "@elizaos/ui/state/useApp": () => import("../../state/useApp.ts"),
  "@elizaos/ui/utils": () => import("../../utils/index.ts"),
  "@elizaos/ui/hooks/resource-cache": () =>
    import("../../hooks/resource-cache.ts"),
  "@elizaos/ui/hooks/runtime-capability-retry": () =>
    import("../../hooks/runtime-capability-retry.ts"),
  "@elizaos/ui/hooks/useActiveAgentAuthority": () =>
    import("../../hooks/useActiveAgentAuthority.ts"),
  "@elizaos/ui/utils/attachment-url": () =>
    import("../../utils/attachment-url.ts"),
  "@elizaos/ui/utils/desktop-dialogs": () =>
    import("../../utils/desktop-dialogs.ts"),
  "@elizaos/ui/utils/download-share": () =>
    import("../../utils/download-share.ts"),
  "@elizaos/ui/components/composites/page-panel": () =>
    import("../composites/page-panel/index.ts"),
  "@elizaos/ui/components/composites/settings": () =>
    import("../composites/settings/index.ts"),
  "@elizaos/ui/components/shared/confirm-delete-control": () =>
    import("../shared/confirm-delete-control.tsx"),
  "@elizaos/ui/components/shared/SectionNav": () =>
    import("../shared/SectionNav.tsx"),
  "@elizaos/ui/components/shared/ViewHeader": () =>
    import("../shared/ViewHeader.tsx"),
  "@elizaos/ui/components/transcripts/TranscriptPlayer": () =>
    import("../transcripts/TranscriptPlayer.tsx"),
  "@elizaos/ui/components/transcripts/TranscriptsView": () =>
    import("../transcripts/TranscriptsView.tsx"),
  "@elizaos/ui/components/views/ShellViewAgentSurface": () =>
    import("./ShellViewAgentSurface.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-content": () =>
    import("../composites/sidebar/sidebar-content.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-panel": () =>
    import("../composites/sidebar/sidebar-panel.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-scroll-region": () =>
    import("../composites/sidebar/sidebar-scroll-region.tsx"),
  "@elizaos/ui/components/pages/MemoryDetailPanel": () =>
    import("../pages/MemoryDetailPanel.tsx"),
  "@elizaos/ui/components/pages/vector-browser-utils": () =>
    import("../pages/vector-browser-utils.ts"),
  "@elizaos/ui/components/shared/AppPageSidebar": () =>
    import("../shared/AppPageSidebar.tsx"),
  "@elizaos/ui/components/shared": () => import("../shared/index.ts"),
  "@elizaos/ui/components/ui/button": () => import("../ui/button.tsx"),
  "@elizaos/ui/components/ui/input": () => import("../ui/input.tsx"),
  "@elizaos/ui/components/ui/select": () => import("../ui/select.tsx"),
  "@elizaos/ui/components/ui/settings-controls": () =>
    import("../ui/settings-controls.tsx"),
  "@elizaos/ui/components/ui/spinner": () => import("../ui/spinner.tsx"),
  "@elizaos/ui/components/ui/skeleton-layouts": () =>
    import("../ui/skeleton-layouts.tsx"),
  "@elizaos/ui/components/ui/tabs": () => import("../ui/tabs.tsx"),
  "@elizaos/ui/components/ui/textarea": () => import("../ui/textarea.tsx"),
  "@elizaos/ui/components/ui/tooltip-extended": () =>
    import("../ui/tooltip-extended.tsx"),
  "lucide-react": () => import("lucide-react"),
  "@pixiv/three-vrm": () => import("@pixiv/three-vrm"),
  "@pixiv/three-vrm/nodes": () => import("@pixiv/three-vrm/nodes"),
  react: () => import("react"),
  "react/jsx-dev-runtime": async () => {
    const devRuntime = await import("react/jsx-dev-runtime");
    if (typeof devRuntime.jsxDEV === "function") {
      return devRuntime;
    }
    const runtime = await import("react/jsx-runtime");
    return { ...runtime, jsxDEV: runtime.jsx };
  },
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  three: () => import("three"),
  "three/tsl": () => import("three/tsl"),
  "three/webgpu": () => import("three/webgpu"),
  "three/examples/jsm/controls/OrbitControls.js": () =>
    import("three/examples/jsm/controls/OrbitControls.js"),
  "three/examples/jsm/libs/meshopt_decoder.module.js": () =>
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  "three/examples/jsm/loaders/DRACOLoader.js": () =>
    import("three/examples/jsm/loaders/DRACOLoader.js"),
  "three/examples/jsm/loaders/FBXLoader.js": () =>
    import("three/examples/jsm/loaders/FBXLoader.js"),
  "three/examples/jsm/loaders/GLTFLoader.js": () =>
    import("three/examples/jsm/loaders/GLTFLoader.js"),
};

/**
 * Resolve a view-bundle external specifier to its importer: the framework trunk
 * map first, then the specifiers plugins/build variants contributed through
 * `registerHostExternalImporter`.
 */
function resolveHostExternalImporter(
  specifier: string,
): ScopedHostExternalImporter | undefined {
  return (
    HOST_EXTERNAL_IMPORTERS[specifier] ??
    resolveRegisteredHostExternalImporter(specifier)
  );
}

/**
 * Every specifier the shell can rewrite for a view bundle — the framework trunk
 * map plus the registered extension specifiers. Computed per bundle load so a
 * plugin registered after this module evaluated is still honored.
 */
function hostExternalSpecifiers(): string[] {
  return [
    ...Object.keys(HOST_EXTERNAL_IMPORTERS),
    ...registeredHostExternalSpecifiers(),
  ];
}

declare global {
  interface Window {
    __ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__?: (
      bundleUrl: string,
      importHost: HostModuleImporter,
    ) => Promise<Record<string, unknown>>;
  }
}

type ViewBundleModuleImporter = (
  moduleUrl: string,
) => Promise<Record<string, unknown>>;

const BUNDLE_CREDENTIAL_QUERY_PARAM =
  /^(?:access[_-]?token|api[_-]?key|authorization|bearer|credential|password|secret|token)$/iu;

/**
 * View bundles are resolved against the shell URL but fetched through the
 * active authenticated API transport. A paired browser therefore has two
 * trusted origins: the page origin that supplied relative descriptors and the
 * API origin that actually serves those descriptors. No other origin may
 * supply executable code.
 */
function isTrustedViewBundleOrigin(origin: string): boolean {
  if (typeof window === "undefined") return true;
  if (origin === window.location.origin) return true;

  const apiBase = client.baseUrl.trim();
  if (!apiBase) return false;
  try {
    return origin === new URL(apiBase, window.location.href).origin;
  } catch {
    return false;
  }
}

function trustedBundleRequestPath(bundleUrl: string): string {
  if (typeof window === "undefined") return bundleUrl;
  const parsed = new URL(bundleUrl, window.location.href);
  if (!isTrustedViewBundleOrigin(parsed.origin)) {
    throw new Error(
      "DynamicViewLoader: refusing to import a cross-origin view bundle",
    );
  }
  for (const name of parsed.searchParams.keys()) {
    if (BUNDLE_CREDENTIAL_QUERY_PARAM.test(name)) {
      throw new Error(
        "DynamicViewLoader: refusing a view bundle URL with embedded credentials",
      );
    }
  }
  return `${parsed.pathname}${parsed.search}`;
}

// Protected view bundles are build artifacts and can legitimately take longer
// than the generic 10-second read budget over an authenticated remote tunnel.
const VIEW_BUNDLE_DOWNLOAD_TIMEOUT_MS = 120_000;

function isJavaScriptBundleResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  return (
    contentType?.startsWith("application/javascript") === true ||
    contentType?.startsWith("text/javascript") === true ||
    contentType?.startsWith("application/ecmascript") === true ||
    contentType?.startsWith("text/ecmascript") === true
  );
}

const importBundleModuleUrl: ViewBundleModuleImporter = (moduleUrl) =>
  import(/* @vite-ignore */ moduleUrl);

/**
 * Fetch a protected host-external bundle through the active API client before
 * executing it from a temporary module URL. Authentication stays inside the
 * client's transport layer; the module URL contains only the fetched source.
 */
export async function importAuthenticatedViewBundle(
  bundleUrl: string,
  moduleImporter: ViewBundleModuleImporter = importBundleModuleUrl,
): Promise<Record<string, unknown>> {
  const requestPath = trustedBundleRequestPath(bundleUrl);
  const response = await client.rawRequest(
    requestPath,
    { headers: { Accept: "application/javascript" } },
    {
      allowNonOk: true,
      timeoutMs: VIEW_BUNDLE_DOWNLOAD_TIMEOUT_MS,
    },
  );
  if (!response.ok) {
    throw new Error(
      `DynamicViewLoader: protected view bundle request failed (HTTP ${response.status})`,
    );
  }
  if (!isJavaScriptBundleResponse(response)) {
    throw new Error(
      "DynamicViewLoader: protected view bundle response was not JavaScript",
    );
  }

  const source = await response.text();
  const moduleUrl = URL.createObjectURL(
    new Blob([source], { type: "application/javascript" }),
  );
  try {
    return await moduleImporter(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

/**
 * Resolve one host-external specifier to the host shell's live singleton (the
 * framework trunk map first, then registered plugin/build-variant specifiers).
 * Passed to a served view bundle's factory (its default export) as the {@link
 * HostModuleImporter} it resolves its externals through — no `globalThis` bridge.
 * Exported so tests can exercise the resolver the factory receives.
 */
async function importHostExternalForScope(
  specifier: string,
  scope: SurfaceRealmScope | null,
): Promise<Record<string, unknown>> {
  if (getActiveSurfaceRealmScope() !== scope) {
    throw new SurfaceRealmDeniedError(
      scope?.viewId ?? "unscoped",
      "navigate",
      "host import belongs to a deactivated surface",
    );
  }
  const importer = resolveHostExternalImporter(specifier);
  if (!importer) {
    throw new Error(
      `DynamicViewLoader: unsupported host external "${specifier}"`,
    );
  }
  return importer(scope);
}

function createBoundHostImport(
  scope: SurfaceRealmScope | null,
): HostModuleImporter {
  return (specifier) => importHostExternalForScope(specifier, scope);
}

export const hostImport: HostModuleImporter = (specifier) => {
  return importHostExternalForScope(specifier, getActiveSurfaceRealmScope());
};

/**
 * A served view bundle's default export is a `HostExternalBundleFactory`: call
 * it with {@link hostImport} to get the view's export namespace. Test/dev bundle
 * modules injected through `__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__` already return
 * a namespace directly, so a non-function default passes through unchanged.
 */
async function resolveBundleNamespace(
  mod: Record<string, unknown>,
  importHost: HostModuleImporter,
  scope: SurfaceRealmScope | null,
): Promise<Record<string, unknown>> {
  if (scope !== getActiveSurfaceRealmScope()) {
    throw new SurfaceRealmDeniedError(
      scope?.viewId ?? "unbound",
      "navigate",
      "view bundle authority changed before evaluation",
    );
  }
  const factory = mod.default;
  if (typeof factory !== "function") return mod;
  return (factory as HostExternalBundleFactory)(importHost);
}

/** Dev-mode polling interval in ms. Not used in production builds. */
const DEV_POLL_INTERVAL_MS = 2000;

/**
 * A view bundle is executed as an ES module in the host realm (it receives the
 * host React singleton, the API client, and the native bridges via the
 * host-external map), so it runs with full app privilege. Only ever import a
 * bundle served by the page origin or the active authenticated API origin: an
 * unrelated `bundleUrl` (which an untrusted view descriptor can announce)
 * would be arbitrary attacker code executing against the user's authenticated
 * session. Paired browser previews intentionally resolve relative descriptors
 * at the page origin and fetch them through `client.baseUrl`; a future CDN
 * bundle must add Subresource-Integrity before this gate can be relaxed.
 */
export function isSameOriginBundleUrl(bundleUrl: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return isTrustedViewBundleOrigin(
      new URL(bundleUrl, window.location.href).origin,
    );
  } catch {
    return false;
  }
}

async function importViewBundle(
  bundleUrl: string,
  scope: SurfaceRealmScope | null,
): Promise<Record<string, unknown>> {
  const importHost = createBoundHostImport(scope);
  if (
    (import.meta.env.DEV ||
      import.meta.env.MODE === "test" ||
      process.env.NODE_ENV === "test") &&
    typeof window !== "undefined" &&
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__
  ) {
    return window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__(bundleUrl, importHost);
  }

  if (!isSameOriginBundleUrl(bundleUrl)) {
    throw new Error(
      `DynamicViewLoader: refusing to import a cross-origin view bundle (${bundleUrl}). View bundles must be served same-origin from /api/views/.`,
    );
  }

  const hostExternalUrl = buildHostExternalBundleUrl(bundleUrl);
  if (hostExternalUrl) {
    return resolveBundleNamespace(
      await importAuthenticatedViewBundle(hostExternalUrl),
      importHost,
      scope,
    );
  }

  try {
    return await import(/* @vite-ignore */ bundleUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Failed to resolve module specifier")) {
      throw err;
    }
  }

  const rewrittenUrl = buildHostExternalBundleUrl(bundleUrl);
  if (!rewrittenUrl) {
    throw new Error(
      `DynamicViewLoader: bundle at ${bundleUrl} could not use host externals`,
    );
  }
  return resolveBundleNamespace(
    await importAuthenticatedViewBundle(rewrittenUrl),
    importHost,
    scope,
  );
}

function buildHostExternalBundleUrl(bundleUrl: string): string | null {
  if (typeof window === "undefined") return null;
  const rewrittenUrl = new URL(bundleUrl, window.location.href);
  if (!isTrustedViewBundleOrigin(rewrittenUrl.origin)) return null;
  if (!rewrittenUrl.pathname.startsWith("/api/views/")) return null;
  rewrittenUrl.searchParams.set(HOST_EXTERNAL_RUNTIME_PARAM, "1");
  rewrittenUrl.searchParams.set(
    HOST_EXTERNAL_SPECIFIERS_PARAM,
    hostExternalSpecifiers().join(","),
  );
  return rewrittenUrl.href;
}

function ensureBundleModuleEntry(
  bundleUrl: string,
  componentExport: string,
  scope: SurfaceRealmScope | null,
): ViewBundleCacheEntry {
  const cacheKey = bundleCacheKey(bundleUrl, componentExport, scope);
  const cached = bundleModuleCache.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached;
  }

  let entry: ViewBundleCacheEntry;
  const promise = importViewBundle(bundleUrl, scope).then(
    (mod: Record<string, unknown>) => {
      const exported = mod[componentExport] ?? mod.default;
      if (!isReactComponentExport(exported)) {
        throw new Error(
          `DynamicViewLoader: bundle at ${bundleUrl} did not export a React component as "${componentExport}"`,
        );
      }
      const interact =
        typeof mod.interact === "function"
          ? (mod.interact as ViewBundleModule["interact"])
          : undefined;
      const cleanup =
        typeof mod.cleanup === "function" ? mod.cleanup : undefined;
      const module = {
        component: exported as ComponentType<Record<string, unknown>>,
        interact,
        cleanup: cleanup as ViewBundleModule["cleanup"],
      };
      entry.module = module;
      entry.lastUsedAt = Date.now();
      emitBundleTelemetry("load", { key: cacheKey });
      if (
        entry.cleanupScheduled ||
        (bundleModuleCache.get(cacheKey) !== entry && entry.refCount === 0)
      ) {
        const cleanup = entry.module.cleanup;
        entry.module = null;
        runBundleCleanup(cleanup);
        if (cleanup) emitBundleTelemetry("cleanup", { key: cacheKey });
        return module;
      }
      if (entry.refCount === 0) {
        armBundleEntryRetentionTimer(entry);
        scheduleIdleWork(() => pruneBundleModuleCache());
      }
      return module;
    },
    (error) => {
      if (bundleModuleCache.get(cacheKey) === entry) {
        bundleModuleCache.delete(cacheKey);
      }
      emitBundleTelemetry("load-error", { key: cacheKey });
      throw error;
    },
  );

  entry = {
    key: cacheKey,
    promise,
    module: null,
    refCount: 0,
    lastUsedAt: Date.now(),
    cleanupScheduled: false,
    retentionTimer: null,
  };
  bundleModuleCache.set(cacheKey, entry);
  return entry;
}

function acquireBundleModule(
  bundleUrl: string,
  componentExport: string,
  scope: SurfaceRealmScope | null,
): {
  cacheKey: string;
  promise: Promise<ViewBundleModule>;
  release: () => void;
} {
  installBundleCacheLifecycle();
  const entry = ensureBundleModuleEntry(bundleUrl, componentExport, scope);
  entry.refCount += 1;
  entry.lastUsedAt = Date.now();
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }

  let released = false;
  return {
    cacheKey: entry.key,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      emitBundleTelemetry("release", { key: entry.key });
      if (entry.refCount === 0) {
        if (getActiveSurfaceRealmScope() !== scope) {
          cleanupBundleEntry(entry, "invalidate");
        } else if (bundleModuleCache.get(entry.key) === entry) {
          armBundleEntryRetentionTimer(entry);
          scheduleIdleWork(() => pruneBundleModuleCache());
        } else {
          cleanupBundleEntry(entry, "invalidate");
        }
      }
    },
  };
}

function invalidateBundleModule(cacheKey: string): void {
  const entry = bundleModuleCache.get(cacheKey);
  if (!entry) return;
  bundleModuleCache.delete(cacheKey);
  if (entry.refCount === 0) {
    cleanupBundleEntry(entry, "invalidate");
  }
}

const STANDARD_CAPABILITIES = new Set([
  "get-state",
  "refresh",
  "focus-element",
  "click-element",
  "fill-input",
  "get-text",
]);

const DOM_FILLABLE_AGENT_ROLES = new Set([
  "text-input",
  "number-input",
  "textarea",
  "select",
  "slider",
]);

const DOM_CLICKABLE_AGENT_ROLES = new Set([
  "button",
  "link",
  "toggle",
  "tab",
  "menu-item",
  "list-item",
  "card",
]);

function resolveInteractTarget(
  containerEl: HTMLElement | null,
  params: Record<string, unknown> | undefined,
): { target: HTMLElement | null; selector: string | null } {
  const selector =
    typeof params?.selector === "string" ? params.selector : null;
  const name = typeof params?.name === "string" ? params.name : null;
  const target =
    (selector && containerEl?.querySelector<HTMLElement>(selector)) ||
    (name &&
      containerEl?.querySelector<HTMLElement>(
        `[name="${CSS.escape(name)}"]`,
      )) ||
    null;
  return { target, selector: selector ?? name };
}

function setNativeInputValue(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function agentSelector(id: string): string {
  return `[data-agent-id="${CSS.escape(id)}"]`;
}

function getAgentElementById(
  containerEl: HTMLElement | null,
  id: string,
): HTMLElement | null {
  return containerEl?.querySelector<HTMLElement>(agentSelector(id)) ?? null;
}

function readElementValue(el: HTMLElement): unknown {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      return el.checked;
    }
    return el.value;
  }
  return undefined;
}

function snapshotDomAgentElement(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const role = el.getAttribute("data-agent-role") || "region";
  const descriptor = {
    id: el.getAttribute("data-agent-id") || "",
    label: el.getAttribute("data-agent-label") || "",
    sensitive: el.getAttribute("data-agent-sensitive") === "true",
  };
  const sensitive = isSensitiveAgentElement(descriptor, el);
  return {
    id: descriptor.id,
    role,
    label: descriptor.label,
    status: el.getAttribute("data-state") || undefined,
    ...(sensitive
      ? { sensitive: true, valueRedacted: true }
      : { value: readElementValue(el) }),
    fillable: DOM_FILLABLE_AGENT_ROLES.has(role),
    clickable: DOM_CLICKABLE_AGENT_ROLES.has(role),
    focused:
      typeof document !== "undefined" &&
      (document.activeElement === el || el.contains(document.activeElement)),
    visible: rect.width > 0 && rect.height > 0,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function listDomAgentElements(containerEl: HTMLElement | null) {
  if (!containerEl) return [];
  return [...containerEl.querySelectorAll<HTMLElement>("[data-agent-id]")]
    .map(snapshotDomAgentElement)
    .filter((item) => item.id.length > 0);
}

function handleDomAgentSurfaceCapability(
  viewId: string,
  viewType: "gui" | "tui" | "xr",
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
): unknown {
  switch (capability) {
    case "list-elements": {
      const role = typeof params?.role === "string" ? params.role : null;
      const elements = listDomAgentElements(containerEl);
      return role ? elements.filter((item) => item.role === role) : elements;
    }

    case "get-agent-state": {
      const elements = listDomAgentElements(containerEl);
      const focused = elements.find((item) => item.focused)?.id ?? null;
      return {
        viewId,
        viewType,
        elementCount: elements.length,
        focusedId: focused,
        elements,
        updatedAt: Date.now(),
      };
    }

    case "describe-element": {
      const id = agentIdParam(params);
      if (!id) throw new Error("describe-element requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) throw new Error(`No element registered with id "${id}"`);
      return snapshotDomAgentElement(el);
    }

    case "get-focus": {
      const elements = listDomAgentElements(containerEl);
      const element = elements.find((item) => item.focused) ?? null;
      return { focusedId: element?.id ?? null, element };
    }

    case "agent-focus": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-focus requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.focus();
      return { ok: true, id };
    }

    case "agent-click": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-click requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.click();
      return { ok: true, id };
    }

    case "agent-fill": {
      const id = agentIdParam(params);
      const value = typeof params?.value === "string" ? params.value : null;
      if (!id) throw new Error("agent-fill requires an `id` parameter");
      if (value === null) {
        throw new Error("agent-fill requires a string `value` parameter");
      }
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      if (
        isSensitiveAgentElement(
          {
            id,
            label: el.getAttribute("data-agent-label") || "",
            sensitive: el.getAttribute("data-agent-sensitive") === "true",
          },
          el,
        )
      ) {
        return { ok: false, id, reason: SENSITIVE_AGENT_ELEMENT_REASON };
      }
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        setNativeInputValue(el, value);
        return { ok: true, id, value };
      }
      return { ok: false, id, reason: "element is not a native field" };
    }

    case "agent-scroll-to": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-scroll-to requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, id };
    }

    case "set-highlight":
      return { highlighting: false };

    default:
      throw new Error(`Unknown agent-surface capability "${capability}"`);
  }
}

/**
 * Handle a standard capability on the view container element.
 * Called when a view module does not export an `interact` function, or when
 * the capability is a known standard one (ensuring baseline support).
 */
function agentIdParam(
  params: Record<string, unknown> | undefined,
): string | null {
  const id = params?.agentId ?? params?.id;
  return typeof id === "string" ? id : null;
}

async function handleStandardCapability(
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
  setReloadKey: (fn: (k: number) => number) => void,
  cacheKey: string,
  registry: ViewAgentRegistry | undefined,
): Promise<unknown> {
  switch (capability) {
    case "get-text":
      return containerEl?.innerText ?? "";

    case "get-state": {
      // Prefer the agent-surface snapshot when the view registers elements; it
      // supersedes the legacy manual `[data-view-state]` attribute.
      if (registry && registry.size() > 0) {
        return registry.snapshot();
      }
      const stateEl = containerEl?.querySelector("[data-view-state]");
      if (stateEl) {
        try {
          return JSON.parse(stateEl.getAttribute("data-view-state") ?? "{}");
        } catch {
          return {};
        }
      }
      return {};
    }

    case "refresh":
      invalidateBundleModule(cacheKey);
      setReloadKey((k) => k + 1);
      return { refreshed: true };

    case "focus-element": {
      // Addressing by registered agent id takes precedence over raw selectors.
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.focus(id);
        return { focused: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.focus();
        return { focused: true, selector };
      }
      return { focused: false, reason: "element not found" };
    }

    case "click-element": {
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.click(id);
        return { clicked: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.click();
        return { clicked: true, selector };
      }
      return { clicked: false, reason: "element not found" };
    }

    case "fill-input": {
      const value = typeof params?.value === "string" ? params.value : null;
      if (value === null) {
        return { filled: false, reason: "value must be a string" };
      }
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.fill(id, value);
        return {
          filled: result.ok,
          id,
          reason: result.reason,
          ...(result.ok ? { value } : {}),
        };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (!target) {
        return { filled: false, reason: "element not found" };
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        if (
          isSensitiveAgentElement(
            {
              id:
                target.getAttribute("data-agent-id") ||
                target.id ||
                target.name ||
                selector ||
                "",
              label: target.getAttribute("data-agent-label") || "",
              sensitive: target.getAttribute("data-agent-sensitive") === "true",
            },
            target,
          )
        ) {
          return {
            filled: false,
            selector,
            reason: SENSITIVE_AGENT_ELEMENT_REASON,
          };
        }
        setNativeInputValue(target, value);
        return { filled: true, selector, value };
      }
      return { filled: false, reason: "element is not fillable" };
    }

    default:
      throw new Error(`Unknown standard capability "${capability}"`);
  }
}

interface DynamicViewLoaderProps {
  /** The URL of the JS bundle to dynamically import. */
  bundleUrl?: string;
  /** HTML document URL for sandboxed-iframe views. */
  frameUrl?: string;
  /** Named export inside the bundle to use as the root component. Defaults to "default". */
  componentExport?: string;
  /** The view's stable ID, used in error state messages. */
  viewId: string;
  /** Optional props forwarded to the loaded view root component. */
  viewProps?: Record<string, unknown>;
  /** Presentation/runtime family for this view. Defaults to GUI. */
  viewType?: "gui" | "tui" | "xr";
  /** Reserve floating-chat space when no enclosing shell already owns it. */
  reserveChatClearance?: boolean;
  /**
   * The view's declared surface manifest (#13452). Resolved to a
   * {@link ResolvedSurfaceManifest} and used to broker the interact channel: a
   * plugin view only gets the mutating agent-surface capabilities when its
   * manifest grants `agent-surface`. Omitted → the safe default (no grants), so
   * an un-manifested plugin view exposes read-only introspection only.
   */
  surface?: SurfaceManifest;
}

/**
 * Loads and mounts a view component from a remote bundle URL.
 *
 * Usage:
 * ```tsx
 * <DynamicViewLoader
 *   bundleUrl="/api/views/wallet.inventory/bundle.js"
 *   viewId="wallet.inventory"
 * />
 * ```
 */
export const DynamicViewLoader = memo(function DynamicViewLoader({
  bundleUrl,
  frameUrl,
  componentExport = "default",
  viewId,
  viewProps: forwardedViewProps,
  viewType = "gui",
  reserveChatClearance = true,
  surface,
}: DynamicViewLoaderProps) {
  const surfaceScope = useSyncExternalStore(
    subscribeActiveSurfaceRealmScope,
    getActiveSurfaceRealmScope,
    () => null,
  );
  // A retained background view must never evaluate against the foreground
  // view's authority. Null is the standalone host/test lane with no shell scope.
  const scopeOwnsView = surfaceScope === null || surfaceScope.ownsView(viewId);
  const cacheKey = bundleUrl
    ? bundleCacheKey(bundleUrl, componentExport, surfaceScope)
    : null;
  // Resolve the declared manifest once per surface declaration so the interact
  // broker gate reads a stable {@link ResolvedSurfaceManifest}. An absent
  // manifest resolves to the safe default (no capability grants).
  const resolvedManifest: ResolvedSurfaceManifest = useMemo(
    () => resolveSurfaceManifest({ surface }),
    [surface],
  );
  const recoveryBackAction =
    resolvedManifest.header === "normal" ? undefined : navigateToViews;
  // A `sandboxed-iframe` view is never imported into the host realm — that is
  // the whole point of the level. It renders in an `<iframe sandbox>` (#14180)
  // and talks to the shell only through the postMessage broker, so the in-realm
  // bundle-load / interact-registry path below is skipped for it.
  const isSandboxed = resolvedManifest.isolation === "sandboxed-iframe";
  const [loadedBundle, setLoadedBundle] = useState<{
    cacheKey: string;
    module: ViewBundleModule;
  } | null>(null);
  const bundle =
    scopeOwnsView && loadedBundle?.cacheKey === cacheKey
      ? loadedBundle.module
      : null;
  const [failedLoad, setFailedLoad] = useState<{
    cacheKey: string;
    error: Error;
  } | null>(null);
  const loadError =
    scopeOwnsView && failedLoad?.cacheKey === cacheKey
      ? failedLoad.error
      : null;
  // Incrementing this key invalidates the module cache entry and forces a
  // fresh import. Used by the dev-mode ETag poller when the bundle changes,
  // and by the `refresh` standard capability.
  const [reloadKey, setReloadKey] = useState(0);
  const dynamicLoadingAllowed = isDynamicViewLoadingAllowed();
  // Ref to the container div so standard capabilities (get-text, focus-element, get-state)
  // can query the DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  // viewId is only a log label inside the load effect; held in a ref so it does
  // not become an effect dependency (a viewId change with the same bundleUrl
  // must not re-run the import or flash the loading skeleton).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  // reloadKey is intentionally a dependency: bumping it via the
  // standard `refresh` capability or the dev-mode ETag poller must
  // re-run this effect to invalidate the module cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual cache-bust trigger
  useEffect(() => {
    if (!dynamicLoadingAllowed || isSandboxed || !bundleUrl || !scopeOwnsView)
      return;
    // A parent layout effect may publish a new scope before this passive
    // effect runs. The store subscription will rerender with that exact owner.
    if (getActiveSurfaceRealmScope() !== surfaceScope) return;

    let cancelled = false;
    const lease = acquireBundleModule(bundleUrl, componentExport, surfaceScope);

    setLoadedBundle(null);
    setFailedLoad(null);
    void lease.promise
      .then((nextBundle) => {
        if (!cancelled && getActiveSurfaceRealmScope() === surfaceScope) {
          setLoadedBundle({ cacheKey: lease.cacheKey, module: nextBundle });
        }
      })
      .catch((err) => {
        if (cancelled || getActiveSurfaceRealmScope() !== surfaceScope) return;
        const error = err instanceof Error ? err : new Error(String(err));
        reportRendererDiagnostic({
          scope: "dynamic-view.load",
          error,
          context: { viewId: viewIdRef.current, bundleUrl },
        });
        setFailedLoad({ cacheKey: lease.cacheKey, error });
      });

    return () => {
      cancelled = true;
      lease.release();
    };
  }, [
    bundleUrl,
    componentExport,
    dynamicLoadingAllowed,
    isSandboxed,
    reloadKey,
    scopeOwnsView,
    surfaceScope,
  ]);

  // Register this view's interact handler whenever the bundle is loaded.
  // The handler is unregistered on unmount or when the bundle changes.
  useLayoutEffect(() => {
    if (!bundle) return;

    // The capability broker (#13452) gates the interact channel on the view's
    // resolved manifest: read-only introspection is always allowed, but mutating
    // agent-surface/standard capabilities require the `agent-surface` grant. A
    // denied capability throws, surfacing to the agent instead of a silent no-op.
    const unregister = registerViewInteractHandler(
      viewId,
      viewType,
      brokerViewInteract(
        viewId,
        resolvedManifest,
        async (capability, params) => {
          const registry = getViewRegistry(viewId, viewType);
          // Generic agent-surface capabilities (list-elements, agent-fill, …)
          // operate on the view's element registry.
          if (isAgentSurfaceCapability(capability)) {
            if (registry && registry.size() > 0) {
              return handleAgentSurfaceCapability(registry, capability, params);
            }
            return handleDomAgentSurfaceCapability(
              viewId,
              viewType,
              capability,
              params,
              containerRef.current,
            );
          }
          // Standard capabilities are handled here regardless of whether the
          // module exports interact — they operate on the registry or the DOM.
          if (STANDARD_CAPABILITIES.has(capability)) {
            if (!bundleUrl) {
              throw new Error(
                `View "${viewId}" has no bundleUrl for capability "${capability}"`,
              );
            }
            return handleStandardCapability(
              capability,
              params,
              containerRef.current,
              setReloadKey,
              cacheKey ??
                bundleCacheKey(bundleUrl, componentExport, surfaceScope),
              registry,
            );
          }
          // Delegate to the module's interact export if present.
          if (bundle.interact) {
            return bundle.interact(capability, params);
          }
          throw new Error(
            `View "${viewId}" does not support capability "${capability}"`,
          );
        },
      ),
    );

    return unregister;
  }, [
    bundle,
    bundleUrl,
    cacheKey,
    componentExport,
    resolvedManifest,
    surfaceScope,
    viewId,
    viewType,
  ]);

  // Dev-mode only: poll the bundle URL with HEAD requests every 2s. When the
  // ETag changes the bundle has been rebuilt — evict the cache entry and bump
  // reloadKey so the component re-imports the updated bundle.
  const lastEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !import.meta.env.DEV ||
      !bundleUrl ||
      !dynamicLoadingAllowed ||
      !scopeOwnsView ||
      !cacheKey
    )
      return;

    let requestPath: string;
    try {
      requestPath = trustedBundleRequestPath(bundleUrl);
    } catch {
      // The import path reports the authoritative user-facing failure; polling
      // must not raise a second unhandled error for the same invalid bundle.
      return;
    }
    let cancelled = false;
    lastEtagRef.current = null;

    const id = setInterval(() => {
      void client
        .rawRequest(requestPath, { method: "HEAD" }, { allowNonOk: true })
        .then((res) => {
          if (cancelled || !res.ok) return;
          const etag = res.headers.get("etag");
          if (lastEtagRef.current !== null && etag !== lastEtagRef.current) {
            // Bundle changed on disk — evict cache and trigger re-import.
            invalidateBundleModule(cacheKey);
            setReloadKey((k) => k + 1);
          }
          lastEtagRef.current = etag;
        })
        .catch(() => {
          // Network errors during polling are non-fatal; just wait for the next tick.
        });
    }, DEV_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [bundleUrl, cacheKey, dynamicLoadingAllowed, scopeOwnsView]);

  // Recover from a load failure or render crash: evict the cached module so the
  // next import re-fetches a fresh copy, clear the latched error, and bump
  // reloadKey to re-run the load effect. Bumping reloadKey also changes the
  // ErrorBoundary key below, remounting it with cleared state — so a view that
  // crashed at render is genuinely retried, not stuck behind a latched boundary.
  const recoverView = useCallback(() => {
    if (!cacheKey) return;
    invalidateBundleModule(cacheKey);
    setFailedLoad(null);
    setReloadKey((k) => k + 1);
  }, [cacheKey]);

  // iOS App Store and Google Play builds cannot load remote JS or HTML frame
  // documents at runtime; both execute plugin-provided code.
  if (!dynamicLoadingAllowed) {
    return <ViewRestrictedState viewId={viewId} />;
  }

  // A sandboxed-iframe view embeds cross-realm through a real HTML document URL.
  // Never feed the JS module `bundleUrl` to an iframe: `/api/views/:id/bundle.js`
  // is served as JavaScript and is only valid for host-realm dynamic import.
  if (isSandboxed) {
    if (!frameUrl) {
      return (
        <ViewErrorState
          viewId={viewId}
          error={
            new Error(
              "Sandboxed iframe views require a frameUrl HTML document; bundleUrl is a JavaScript module.",
            )
          }
          onBack={recoveryBackAction}
        />
      );
    }
    return (
      <div
        ref={containerRef}
        className="contents"
        data-agent-surface-kind="dynamic"
        data-agent-surface-view-id={viewId}
      >
        <SandboxedViewFrame
          viewId={viewId}
          surface={surface}
          src={frameUrl}
          title={viewId}
        />
      </div>
    );
  }

  if (!bundleUrl) {
    return (
      <ViewErrorState
        viewId={viewId}
        error={
          new Error(
            `Dynamic view "${viewId}" requires bundleUrl unless it declares sandboxed-iframe isolation with frameUrl.`,
          )
        }
        onBack={recoveryBackAction}
      />
    );
  }
  if (loadError) {
    return (
      <ViewErrorState
        viewId={viewId}
        error={loadError}
        onRetry={recoverView}
        onBack={recoveryBackAction}
      />
    );
  }

  if (!bundle) {
    return <ViewLoadingSkeleton />;
  }

  const View = bundle.component;
  const viewProps = {
    ...forwardedViewProps,
    exitToApps: navigateToViews,
    t: (
      key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : key,
  };

  return (
    <div
      ref={containerRef}
      className="contents"
      data-agent-surface-kind="dynamic"
      data-agent-surface-view-id={viewId}
    >
      <AgentSurfaceProvider viewId={viewId} viewType={viewType}>
        {/* Keyed by bundleUrl+reloadKey so a successful reload (refresh
            capability / dev HMR / Retry) remounts the boundary with cleared
            state instead of staying latched on a stale render crash. */}
        <ErrorBoundary
          key={`${cacheKey}:${reloadKey}`}
          fallback={(error, resetErrorBoundary) => (
            <ViewErrorState
              viewId={viewId}
              error={error}
              onRetry={() => {
                resetErrorBoundary();
                recoverView();
              }}
              onBack={recoveryBackAction}
            />
          )}
        >
          {/* One shell-level SpatialSurface owns modality for every mounted
              view — GUI by auto-detect, XR inside a headset host — so plugin
              view components no longer each wrap themselves. Omitting `modality`
              keeps the exact auto-detect behaviour the per-view wrappers had.
              The host also reserves the floating composer clearance once so
              spatial plugin content scrolls above the chat affordance. */}
          <SpatialSurface reserveChatClearance={reserveChatClearance}>
            <View {...viewProps} />
          </SpatialSurface>
        </ErrorBoundary>
        <AgentElementOverlay />
        <AgentSurfaceElementReporter />
      </AgentSurfaceProvider>
    </div>
  );
});
