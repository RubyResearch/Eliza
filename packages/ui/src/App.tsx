/**
 * Root App component and the dashboard routing shell mounted by every elizaOS
 * front-end. It resolves the shell mode from the URL (`?shellMode=` — `full`,
 * `chat-overlay`, `voice-*`), gates boot/pairing behind `StartupScreen`, mounts
 * the shared `AppBackground` and first-run conductor once, and renders either
 * the floating chat-overlay surface or the full tabbed shell.
 */

import {
  type AppShellBackgroundPolicy,
  type EnabledViewKinds,
  isViewVisible,
  type PageLayoutManifest,
  type ResolvedSurfaceManifest,
  resolveSurfaceBackgroundPolicy,
  resolveSurfaceManifest,
  type SurfaceManifestBearer,
  type ViewKind,
} from "@elizaos/core";
import { hasStewardAuthedCookie } from "@elizaos/shared/steward-session-client";
import { X } from "lucide-react";
import "./components/chat/chat-source-registration";
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getCloudAuthToken } from "./api/client-cloud";
import {
  type ActiveViewLayout,
  createNavigateViewHandler,
  type NavigateViewDetail,
  navigateBrowserPath,
} from "./app-navigate-view";
import {
  LazyAutomationsFeed,
  LazyBackgroundView,
  LazyBrowserWorkspaceView,
  LazyCameraPageView,
  LazyCharacterEditor,
  LazyCharacterExperienceView,
  LazyCharacterSkillsView,
  LazyDatabasePageView,
  LazyDesktopWorkspaceSection,
  LazyFilesView,
  LazyLiveMeetingPageView,
  LazyLogsView,
  LazyMemoryViewerView,
  LazyPendantTranscriptView,
  LazyPluginsPageView,
  LazyRuntimeView,
  LazySettingsView,
  LazySkillsView,
  LazyStreamView,
  LazyTasksPageView,
  LazyTrajectoriesView,
  LazyVaultPageView,
  LazyViewBoundary,
  scheduleRouteViewChunkPrefetch,
} from "./app-route-loaders";
import { AppBackground } from "./backgrounds/AppBackground";
import {
  type DesktopBottomBarSurfaceState,
  invokeDesktopBridgeRequest,
  invokeDesktopBridgeRequestWithTimeout,
  setDesktopBottomBarSurfaceState,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc";
import { isElectrobunRuntime } from "./bridge/electrobun-runtime";
import {
  NAVIGATE_SETTINGS_EVENT,
  type NavigateSettingsDetail,
  useSlashCommandController,
} from "./chat/useSlashCommandController";
import {
  reportUserViewClosed,
  reportUserViewSwitch,
  shouldClearReportedView,
} from "./chat/view-navigation-report";
import { markCompletedActionNavigationHandled } from "./completed-action-navigation";
import { OverlayAppSurface } from "./components/apps/AppWindowRenderer";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { AgentAuthGateSurface } from "./components/auth/AgentAuthGateSurface";
import {
  CloudPairRelay,
  getCloudPairTokenFromLocation,
  isElizaCloudHostedLocation,
  resolveCloudHostedAgentUrl,
} from "./components/auth/CloudPairRelay";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { AppsPageView } from "./components/pages/AppsPageView";
import { PermissionPrimingOverlay } from "./components/permissions/PermissionPrimingOverlay";
import { AssistantOverlay } from "./components/shell/AssistantOverlay";
import { BugReportModal } from "./components/shell/BugReportModal";
import { BuildBadge } from "./components/shell/BuildBadge";
import { ChatOverlay } from "./components/shell/ChatOverlay";
import { ChatSurface } from "./components/shell/ChatSurface";
import { CloudSignInRecoveryView } from "./components/shell/CloudSignInRecoveryView";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { DynamicPluginFallback } from "./components/shell/DynamicPluginFallback";
import { HomeLauncherSurface } from "./components/shell/HomeLauncherSurface";
import { HomePill } from "./components/shell/HomePill";
import { HomeScreen, type HomeTileTarget } from "./components/shell/HomeScreen";
import { KioskViewCanvas } from "./components/shell/KioskViewCanvas";
import {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./components/shell/notifications-boot";
import { PairingView } from "./components/shell/PairingView";
import { ShellControllerProvider } from "./components/shell/ShellControllerContext";
import { useShellControllerContext } from "./components/shell/ShellControllerContext.hooks";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupScreen } from "./components/shell/StartupScreen";
import { StartupShell } from "./components/shell/StartupShell";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { TrayLauncher } from "./components/shell/TrayLauncher";
import { useBarSurfaceWindows } from "./components/shell/useBarSurfaceWindows";
import { useKioskViewSurfaces } from "./components/shell/useKioskViewSurfaces";
import { VoiceCaptureHud } from "./components/shell/VoiceCaptureHud";
import { Button } from "./components/ui/button";
import { KeepAliveViewHost } from "./components/views/KeepAliveViewHost";
import { ShellViewAgentSurface } from "./components/views/ShellViewAgentSurface";
import { ViewErrorBoundary } from "./components/views/ViewErrorBoundary";
import { ViewUnavailableState } from "./components/views/ViewStatusStates";
import { AppWorkspaceContent } from "./components/workspace/AppWorkspaceContent";
import { useBootConfig } from "./config/boot-config-react.hooks";
import { useBranding } from "./config/branding";
import {
  CHAT_OPEN_EVENT,
  type ConnectRequestResult,
  dispatchNavigateViewEvent,
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
  listenForConnectRequests,
  listenForNavigateViewRequests,
  PUSH_TO_TALK_HOLD_EVENT,
  PUSH_TO_TALK_TOGGLE_EVENT,
  type PushToTalkHoldDetail,
} from "./events";
import { completeRemoteAgentFirstRun } from "./first-run/adopt-remote-first-run";
import {
  isElizaCloudRuntimeLocked,
  persistMobileRuntimeModeForServerTarget,
} from "./first-run/mobile-runtime-mode";
import { BootRecoveryConductorMount } from "./first-run/use-boot-recovery-conductor";
import { FirstRunConductorMount } from "./first-run/use-first-run-conductor";
import { ModelStatusConductorMount } from "./first-run/use-model-status-conductor";
import { GlassStyles } from "./glass";
import { BugReportProvider, useBugReportState, useContextMenu } from "./hooks";
import { useAgentSessionRecovery } from "./hooks/useAgentSessionRecovery";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useRole } from "./hooks/useRole";
import { useSecretsManagerModalState } from "./hooks/useSecretsManagerModal";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import { PageFrame } from "./layouts/page-frame";
import { cn } from "./lib/utils";
import {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAospShellEnabled,
  isAppWindowRoute,
  isRouteRootPath,
  NATIVE_OS_VIEW_IDS,
  pathForTab,
  resolveBuiltinRouteDescriptor,
  resolveLegacyBuiltinRoute,
  shouldUseHashNavigation,
  TAB_PATHS,
  type Tab,
  tabFromPath,
  titleForTab,
} from "./navigation";
import { applyLaunchConnection } from "./platform";
import { isAndroidCloudBuild } from "./platform/android-runtime";
import {
  type AppShellMode,
  resolveAppShellMode,
} from "./platform/app-shell-mode";
import { isIOS, isNative } from "./platform/init";
import { RetainedLazyComponent } from "./retained-lazy";
import { routedShellMainClass } from "./routed-shell-layout";
import {
  type ActionNotice,
  useAppSelector,
  useAppSelectorShallow,
} from "./state";
import { shouldShowCloudAgentReauthNotice } from "./state/agent-session-recovery";
import {
  useChatComposer,
  useChatInputRef,
} from "./state/ChatComposerContext.hooks";
import {
  clearCloudAuthFirstScreenGreeting,
  markCloudAuthFirstScreenGreeting,
} from "./state/cloud-auth-first-screen";
import { cloudAuthFirstScreenOwnsHost } from "./state/cloud-auth-first-screen-policy";
import { hasUsableStoredStewardToken } from "./state/cloud-steward-login";
import { isAuthoritativeFirstRunOpen } from "./state/first-run-chat-release";
import {
  authProbeShouldHoldShell,
  firstRunOwnsLoginSurface,
  shouldShowRemoteAgentPairingGate,
  topLevelAuthGateOwnsSurface,
} from "./state/top-level-auth-gate";
import { useFirstRunChatRelease } from "./state/use-first-run-chat-release";
import {
  isBootstrapGateRequired,
  isLoopbackGatewayHost,
} from "./state/use-startup-shell-controller";
import { DeveloperTabHost } from "./state/useDeveloperTabHost";
import {
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "./surface-realm-broker";
import { shellHistory } from "./surface-realm-channel";
import { TutorialConductorMount } from "./tutorial/TutorialConductor";
import { isTrustedHostedCloudOnboardingBase } from "./utils/cloud-agent-base";
import { confirmDesktopAction } from "./utils/desktop-dialogs";
import { openExternalUrl } from "./utils/openExternalUrl";
import { playCaptureSendCue, playCaptureStartCue } from "./voice/capture-cues";
import { VoiceSelfTestShell } from "./voice/voice-selftest/VoiceSelfTestShell";
import { VoiceWorkbenchShell } from "./voice/voice-selftest/VoiceWorkbenchShell";

// NOTE (#view-padding-normalize): the full floating-composer + bottom-nav +
// safe-area bottom clearance is owned EXACTLY ONCE by the scroll region a view
// mounts into (`AppWorkspaceContent`'s selected boundary, complemented
// by `AppWorkspaceChrome`'s safe-area floor). The routed `<main>`
// (`routedShellMainClass`) deliberately does NOT re-apply that clearance —
// doing so double-counted it and left an oversized empty band under every view.
function gatewayHostForDisplay(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host || gatewayUrl;
  } catch {
    return gatewayUrl;
  }
}

import { client } from "./api";
import { fetchWithCsrf } from "./api/csrf-client";
// Import the page registry from its standalone module, NOT the
// `app-shell-components` barrel — that barrel statically re-exports every page
// view, so importing through it folds all of them back into the main chunk.
import {
  type AppShellPageRegistration,
  appShellAgentSurfaceDescriptor,
  appShellPageIsAvailable,
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  requireRegisteredAgentSurface,
  subscribeAppShellPages,
} from "./app-shell-registry";
import {
  isImmersiveWallpaperRoute,
  resolveBuiltinBackgroundPolicy,
  resolveBuiltinRoutedViewManifest,
  resolveBuiltinTabId,
} from "./builtin-tab-registry";
import { useSessionAuth } from "./cloud/lib/use-session-auth";
import { isManagedCloudRuntime } from "./cloud/managed-cloud-runtime";
// DesktopTabBar stays static: it is already pulled
// eagerly elsewhere in the app graph (plugin-loader / boot-config), so a
// lazy() boundary here would only fold back into main. The remaining page
// views are lazy-split below.
import {
  CharacterSectionNav,
  isCharacterSectionPath,
} from "./components/character/CharacterSectionNav";
import { PageLoadingState } from "./components/composites/page-panel";
import { DesktopTabBar } from "./components/desktop/DesktopTabBar";
import { LauncherSurface } from "./components/pages/LauncherSurface";
import {
  isWalletSectionPath,
  WalletSectionNav,
} from "./components/pages/WalletSectionNav";
import { ViewHeader } from "./components/shared/ViewHeader";
import { DynamicViewLoader } from "./components/views/DynamicViewLoader";
import { registerSandboxProbeView } from "./components/views/sandbox-probe-view";
import { useActiveAgentAuthority } from "./hooks/useActiveAgentAuthority";
import {
  useAvailableViews,
  useRoutableViews,
  type ViewRegistryEntry,
} from "./hooks/useAvailableViews";
import { useDesktopTabs } from "./hooks/useDesktopTabs";
import { isDynamicViewLoadingAllowed } from "./platform/platform-guards";
import { useEnabledViewKinds } from "./state/useViewKinds";
import { WidgetHost } from "./widgets";

/** Check if we're in pop-out mode (StreamView only, no chrome). */
function useIsPopout(): boolean {
  const [popout] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(
      window.location.search || window.location.hash.split("?")[1] || "",
    );
    return params.has("popout") && params.get("popout") !== "false";
  });
  return popout;
}

/**
 * Shell mode for focused native surfaces. The OS launches the same app
 * bundle with `--shell-mode=chat-overlay` (transparent assistant overlay),
 * `--shell-mode=launcher` (full home view), or
 * `--shell-mode=kiosk` (the locked appliance shell: a single fullscreen
 * view-manager surface with an always-visible bottom chat pill). The mode is
 * read from the URL (`?shellMode=` / `?shell-mode=`) or the
 * `ELIZAOS_SHELL_MODE` global the native shell may inject. Unset = full app.
 */
declare global {
  interface Window {
    ELIZAOS_SHELL_MODE?: string;
  }
}

function readShellMode(): AppShellMode {
  if (typeof window === "undefined") return "full";
  return resolveAppShellMode(
    window.location.search,
    window.location.hash,
    window.ELIZAOS_SHELL_MODE,
  );
}

function useShellMode(): AppShellMode {
  const [mode] = useState(readShellMode);
  return mode;
}

/**
 * Floating, transparent assistant overlay surface for the OS chat-overlay
 * window. Renders ONLY the waveform + pill + chat/voice overlay — no app
 * chrome — over a transparent background.
 */
function ChatOverlayShell({
  releaseFirstRunToFull,
  retainMountedFirstRunOpen,
  onFirstRunReleaseHandled,
  onFirstRunChatMounted,
  firstRunMountEpoch,
}: {
  releaseFirstRunToFull: boolean;
  retainMountedFirstRunOpen: boolean;
  onFirstRunReleaseHandled: () => void;
  onFirstRunChatMounted: (epoch: number) => void;
  firstRunMountEpoch: number | null;
}) {
  // The bar has no inline tab system, so "show a view" / "show the launcher"
  // intents open dedicated on-demand desktop windows instead (#9953 Phase 3).
  useBarSurfaceWindows();
  const controller = useShellControllerContext();
  const overlayOpen = controller?.isOpen ?? false;
  // Escape collapses the overlay first — while it is open, AssistantOverlay's
  // own Escape handler closes it. Once already collapsed, Escape hides the
  // desktop window entirely (#12184) so the pill dismisses to the background
  // like a summoned panel. Desktop-only (web has no window to hide).
  useEffect(() => {
    if (typeof document === "undefined" || !isElectrobunRuntime()) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || overlayOpen) return;
      void invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopHideWindow",
        ipcChannel: "desktop:hideWindow",
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlayOpen]);
  return (
    <>
      <GlassStyles />
      <div
        data-testid="chat-overlay-shell"
        className="pointer-events-none fixed inset-0 flex items-end justify-center bg-transparent"
      >
        <ShellFoundationMount
          useWebChatPanel
          releaseFirstRunToFull={releaseFirstRunToFull}
          retainMountedFirstRunOpen={retainMountedFirstRunOpen}
          onFirstRunReleaseHandled={onFirstRunReleaseHandled}
          onFirstRunChatMounted={onFirstRunChatMounted}
          firstRunMountEpoch={firstRunMountEpoch}
        />
      </div>
    </>
  );
}

/**
 * Native tray popover surface (#9953 Phase 4 / #12184). Renders the compact
 * launcher (the `DESKTOP_VIEW_WINDOWS` catalog + "Open Eliza", registered by
 * the desktop host) above the shell widget registry's "home" slot inside the
 * frameless, transparent, always-on-top window the native tray anchors near its
 * icon — no app chrome. Each widget self-hides when it has nothing to show, so
 * the popover is a compact at-a-glance panel + one-click launcher.
 */
function TrayPopoverShell() {
  return (
    <div
      data-testid="tray-popover-shell"
      className="fixed inset-0 flex flex-col gap-3 overflow-y-auto bg-transparent p-3"
    >
      <TrayLauncher />
      <WidgetHost slot="home" layout="stack" />
    </div>
  );
}

/**
 * Locked appliance shell for the Linux OS kiosk window. The Electrobun bundle
 * runs as the entire GUI: a single fullscreen, frameless, non-closable
 * toplevel. This surface IS the view manager — agent-spawned dynamic views
 * mount in-canvas (see `KioskViewCanvas`) and an always-visible bottom chat
 * pill talks to the local OS agent. No header / tabs / desktop chrome.
 */
function KioskShell() {
  const surfaces = useKioskViewSurfaces();
  return (
    <div
      data-testid="kiosk-shell"
      className="fixed inset-0 flex flex-col overflow-hidden bg-bg"
    >
      <div className="min-h-0 flex-1">
        <KioskViewCanvas surfaces={surfaces} />
      </div>
      {/* Always-visible bottom chat pill + assistant overlay. */}
      <ShellFoundationMount />
    </div>
  );
}

function surfaceOwnsViewport(
  declaration: SurfaceManifestBearer | null | undefined,
): boolean {
  const header = resolveRoutedSurfaceManifest(declaration).header;
  return header === "fullscreen" || header === "immersive";
}

const DEFAULT_ROUTED_PAGE_LAYOUT = resolveSurfaceManifest(null).layout;

/**
 * Fullscreen registrations shipped before page manifests existed and already
 * own their edge-to-edge canvas. Preserve that contract only when no explicit
 * layout was declared; new registrations and builtins keep their canonical
 * descriptor geometry.
 */
const LEGACY_FULLSCREEN_PAGE_LAYOUT = Object.freeze({
  kind: "workspace",
  topology: "framed",
  width: "full",
  scroll: "view",
  gutter: "none",
}) satisfies PageLayoutManifest;

function resolveRoutedSurfaceManifest(
  declaration: SurfaceManifestBearer | null | undefined,
): ResolvedSurfaceManifest {
  const manifest = resolveSurfaceManifest(declaration);
  if (
    manifest.header !== "fullscreen" ||
    declaration?.surface?.layout !== undefined
  ) {
    return manifest;
  }
  return { ...manifest, layout: LEGACY_FULLSCREEN_PAGE_LAYOUT };
}

function ViewSurfaceFrame({
  children,
  declaration,
  nav,
  suppressHeader = false,
  title,
}: {
  children: ReactNode;
  declaration: SurfaceManifestBearer | null | undefined;
  nav?: ReactNode;
  suppressHeader?: boolean;
  title: string;
}) {
  const manifest = resolveRoutedSurfaceManifest(declaration);
  if (manifest.layout.topology === "ambient") {
    return <>{children}</>;
  }
  const showHeader =
    manifest.header === "normal" && nav === undefined && !suppressHeader;
  return (
    <AppWorkspaceContent
      nav={nav}
      pageLayout={manifest.layout}
      reserveChatClearance={!surfaceOwnsViewport(declaration)}
      header={showHeader ? <ViewHeader title={title} /> : undefined}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </AppWorkspaceContent>
  );
}

interface ResolvedDynamicPage extends SurfaceManifestBearer {
  id: string;
  pluginId: string;
  developerOnly: boolean;
  viewKind?: ViewKind;
  registration?: AppShellPageRegistration;
  componentExport?: string;
}

function useAppShellPageRegistryVersion(): number {
  return useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
}

/**
 * Resolve a tab id against the dynamic registry: first the in-process
 * `registerAppShellPage` registrations, then any loaded plugin's
 * `app.navTabs` declaration. Returns `null` when no plugin claims the tab.
 */
function useResolvedDynamicPage(tab: string): ResolvedDynamicPage | null {
  const plugins = useAppSelector((s) => s.plugins);
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    const registrations = listAppShellPages();
    const registered = registrations.find((entry) => entry.id === tab);
    if (registered) {
      return {
        id: registered.id,
        pluginId: registered.pluginId,
        developerOnly: registered.developerOnly === true,
        viewKind: registered.viewKind,
        backgroundPolicy: registered.backgroundPolicy,
        headerPolicy: registered.headerPolicy,
        surface: registered.surface,
        registration: registered,
      };
    }
    for (const plugin of plugins) {
      const navTabs = plugin.app?.navTabs;
      if (!navTabs?.length) continue;
      for (const navTab of navTabs) {
        if (navTab.id !== tab) continue;
        const reg = registrations.find(
          (entry) => entry.id === navTab.id && entry.pluginId === plugin.id,
        );
        return {
          id: navTab.id,
          pluginId: plugin.id,
          developerOnly:
            plugin.app?.developerOnly === true || navTab.developerOnly === true,
          // A nav tab's own kind wins; otherwise inherit the app's kind.
          viewKind: navTab.viewKind ?? plugin.app?.viewKind,
          backgroundPolicy: navTab.backgroundPolicy,
          surface: navTab.surface,
          registration: reg,
          componentExport: navTab.componentExport,
        };
      }
    }
    return null;
  }, [plugins, registryVersion, tab]);
}

/**
 * Render a dynamically-resolved plugin page. Honors:
 *   1. An in-process registration (`registerAppShellPage`) — preferred.
 *   2. A `componentExport` import-spec like `"@elizaos/plugin-wallet/ui#InventoryView"`,
 *      loaded with dynamic `import()` and rendered via Suspense.
 *
 * Plugins that declare a `componentExport` without a matching registration get
 * a small loading fallback until the import resolves. Plugins can avoid this
 * path by self-registering with `registerAppShellPage` at boot.
 */
/**
 * Props every app-shell page view receives, mirroring the OverlayAppContext that
 * `DynamicViewLoader` injects on web/desktop. Overlay-app views can read
 * `t` / `exitToApps` from props and crash ("t is not a
 * function") if mounted with none — which is exactly what happens on iOS/Android
 * where these views render through the in-process app-shell path instead of
 * DynamicViewLoader. Views that read translations from hooks ignore the extras.
 */
function exitAppShellPageToViews(): void {
  if (typeof window !== "undefined") {
    shellHistory.pushState(null, "", "/views");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
const APP_SHELL_VIEW_PROPS = {
  exitToApps: exitAppShellPageToViews,
  t: (
    key: string,
    options?: { defaultValue?: string } | Record<string, unknown>,
  ): string =>
    typeof options === "object" &&
    options !== null &&
    "defaultValue" in options &&
    typeof options.defaultValue === "string"
      ? options.defaultValue
      : key,
};

function RegisteredAppShellPage({
  registration,
  viewProps,
}: {
  registration: AppShellPageRegistration;
  viewProps?: Record<string, unknown>;
}) {
  const bridge = requireRegisteredAgentSurface(
    appShellAgentSurfaceDescriptor(registration),
  );
  let content: ReactNode;
  if (registration.Component) {
    const Component = registration.Component;
    content = <Component {...viewProps} />;
  } else if (registration.loader) {
    content = (
      <RetainedLazyComponent
        loader={registration.loader}
        cacheKey={registration.id}
        componentProps={{ ...APP_SHELL_VIEW_PROPS, ...viewProps }}
        fallback={
          <PageLoadingState
            heading={`Loading ${registration.label}…`}
            className="flex-1"
          />
        }
        onError={(error) => (
          <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center px-4 text-center text-sm text-destructive">
            Failed to load {registration.label}: {error.message}
          </div>
        )}
      />
    );
  } else {
    content = (
      <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
        {registration.label} is not available in this build.
      </div>
    );
  }

  // In-process plugin pages bypass DynamicViewLoader, so the shell owns the
  // capability bridge for them. This keeps registry pages and remote bundles
  // equivalent: controls registered with useAgentElement are live immediately.
  return (
    <ShellViewAgentSurface viewId={bridge.viewId} surfaceKind={bridge.kind}>
      {content}
    </ShellViewAgentSurface>
  );
}

function DynamicPluginPage({ resolved }: { resolved: ResolvedDynamicPage }) {
  if (resolved.registration) {
    return <RegisteredAppShellPage registration={resolved.registration} />;
  }
  // No bundled registration yet: the tab declared a `componentExport` but no
  // plugin has called `registerAppShellPage`. Registration may still arrive on
  // the boot idle path (a `registryVersion` bump re-resolves this page and the
  // branch above takes over); if it never does, the fallback degrades from
  // loading to a designed error state instead of an unbounded spinner.
  return <DynamicPluginFallback id={resolved.id} />;
}

function WalletInventoryPage() {
  // The wallet registration is deliberately deferred until after first paint.
  // Subscribe here so a cold /wallet deep link hands off to the real page as
  // soon as that registration arrives instead of freezing the initial miss.
  const registryVersion = useAppShellPageRegistryVersion();
  void registryVersion;
  const registration = listAppShellPages().find(
    (entry) => entry.id === "wallet.inventory" || entry.path === "/inventory",
  );
  if (!registration) {
    return <DynamicPluginFallback id="wallet.inventory" />;
  }
  return <RegisteredAppShellPage registration={registration} />;
}

function visibleDynamicPage(
  page: ResolvedDynamicPage | null,
  enabledKinds: EnabledViewKinds,
  managedCloudRuntime: boolean,
): page is ResolvedDynamicPage {
  return Boolean(
    page &&
      isViewVisible(page, enabledKinds) &&
      (!page.registration ||
        appShellPageIsAvailable(page.registration, {
          managedCloud: managedCloudRuntime,
        })),
  );
}

/**
 * Whether the active app-shell page wants to render edge-to-edge with no host
 * top-bar/chrome. Looks the active tab up in the runtime page registry and
 * reads its `fullBleed` flag — backward-compatible: pages that don't set it
 * keep the normal chrome.
 */
function useTabIsFullBleed(tab: string): boolean {
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    return listAppShellPages().some(
      (entry) => entry.id === tab && entry.fullBleed === true,
    );
  }, [registryVersion, tab]);
}

function useCurrentNavigationPath(): string {
  const [navigationPath, setNavigationPath] = useState(() =>
    typeof window === "undefined" ? "/" : getWindowNavigationPath(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigationChange = () => {
      setNavigationPath(getWindowNavigationPath());
    };
    window.addEventListener("hashchange", handleNavigationChange);
    window.addEventListener("popstate", handleNavigationChange);
    return () => {
      window.removeEventListener("hashchange", handleNavigationChange);
      window.removeEventListener("popstate", handleNavigationChange);
    };
  }, []);

  return navigationPath;
}

/**
 * The resolved screen-background policy for a single view registration — the
 * ONE seam the shell derives every view's background from (#13452). Reads the
 * declared surface manifest first (`surface.background` gated by the `wallpaper`
 * grant), then the legacy standalone `backgroundPolicy`, then defaults to
 * opaque. A view that declares `shared` without the `wallpaper` grant resolves
 * to opaque — the wallpaper cannot be opted into by accident.
 */
function viewRegistrationBackgroundPolicy(
  decl: SurfaceManifestBearer | null | undefined,
): AppShellBackgroundPolicy {
  return resolveSurfaceBackgroundPolicy(decl);
}

function builtinRouteBackgroundPolicy(
  tab: string,
  navigationPath: string,
): AppShellBackgroundPolicy | null {
  // Data-driven lookup over the single builtin-tab registry (see
  // builtin-tab-registry.ts) — replaces the former per-tab if-chain that ran
  // parallel to the router's own tab enumeration and could silently drift.
  return resolveBuiltinBackgroundPolicy(
    tab,
    trimmedNavigationPath(navigationPath),
  );
}

function resolveActiveScreenBackgroundPolicy({
  tab,
  navigationPath,
  availableViews,
  dynamicPage,
  viewLayout,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  dynamicPage: ResolvedDynamicPage | null;
  viewLayout: ActiveViewLayout | null;
}): AppShellBackgroundPolicy {
  if (viewLayout) return "opaque";

  const appShellPageForRoute = findAppShellPageForRoute(navigationPath);
  if (appShellPageForRoute) {
    return viewRegistrationBackgroundPolicy(appShellPageForRoute);
  }

  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView) return viewRegistrationBackgroundPolicy(remoteView);

  const appShellPageForTab = listAppShellPages().find(
    (entry) => entry.id === tab || entry.tabAffinity === tab,
  );
  if (appShellPageForTab) {
    return viewRegistrationBackgroundPolicy(appShellPageForTab);
  }

  if (dynamicPage) {
    return viewRegistrationBackgroundPolicy(
      dynamicPage.registration ?? dynamicPage,
    );
  }

  const builtinPolicy = builtinRouteBackgroundPolicy(tab, navigationPath);
  if (builtinPolicy) return builtinPolicy;

  const registeredView = availableViews.find(
    (view) =>
      view.builtin !== true &&
      (view.id === tab ||
        view.path === navigationPath ||
        view.path === trimmedNavigationPath(navigationPath)),
  );
  if (registeredView) {
    return viewRegistrationBackgroundPolicy(registeredView);
  }

  // Ordinary views use the neutral surface. Wallpaper is an explicit opt-in.
  return "opaque";
}

function useActiveScreenBackgroundPolicy({
  tab,
  navigationPath,
  availableViews,
  dynamicPage,
  viewLayout,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  dynamicPage: ResolvedDynamicPage | null;
  viewLayout: ActiveViewLayout | null;
}): AppShellBackgroundPolicy {
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    return resolveActiveScreenBackgroundPolicy({
      tab,
      navigationPath,
      availableViews,
      dynamicPage,
      viewLayout,
    });
  }, [
    availableViews,
    dynamicPage,
    navigationPath,
    registryVersion,
    tab,
    viewLayout,
  ]);
}

/**
 * The active view's identity + resolved surface manifest — the same registration
 * the background resolver above reads, resolved through the SAME
 * {@link resolveSurfaceManifest} so there is one policy source. Drives the
 * in-process host-realm broker (#14179): the shell scopes the active view's
 * storage/navigation/DOM mutations from this manifest exactly as it derives the
 * background from it.
 */
interface ActiveViewSurface {
  manifest: ResolvedSurfaceManifest;
  viewId: string;
  children?: readonly ActiveViewSurfaceChild[];
  sourceKey: string;
  memberViewIds?: readonly string[];
  sourceComponent?: AppShellPageRegistration["Component"];
  sourceLoader?: AppShellPageRegistration["loader"];
}

interface ActiveViewSurfaceChild {
  viewId: string;
  manifest: ResolvedSurfaceManifest;
  path?: string;
  bundleUrl?: string;
  frameUrl?: string;
  componentExport?: string;
}

function builtinSurfaceChildren(tab: string): ActiveViewSurfaceChild[] {
  return (resolveBuiltinRouteDescriptor(tab)?.dynamicChildren ?? []).map(
    (child) => ({ ...child, manifest: resolveRoutedSurfaceManifest(null) }),
  );
}

function activeViewLayoutEntries(
  layout: ActiveViewLayout,
  availableViews: ViewRegistryEntry[],
): ViewRegistryEntry[] {
  return layout.viewIds
    .map((viewId) => availableViews.find((view) => view.id === viewId))
    .filter((view): view is ViewRegistryEntry => Boolean(view));
}

function layoutRouteOverrideForView(
  view: ViewRegistryEntry,
): ViewRouterRouteOverride {
  const navigationPath =
    view.path ??
    (SHELL_RESERVED_TABS.has(view.id)
      ? pathForTab(view.id)
      : `/apps/${view.id}`);
  return {
    navigationPath,
    tab: tabFromPath(navigationPath) ?? view.id,
  };
}

function shellSurfaceOwner(page: AppShellPageRegistration) {
  return {
    sourceKey: JSON.stringify(["shell", page.pluginId, page.id]),
    sourceComponent: page.Component,
    sourceLoader: page.loader,
  };
}

function remoteSurfaceOwner(view: ViewRegistryEntry) {
  return {
    sourceKey: JSON.stringify([
      "remote",
      view.pluginName,
      view.id,
      view.bundleUrl,
      view.frameUrl,
      view.componentExport,
    ]),
  };
}

function surfacePolicyKey({
  manifest,
  viewId,
  sourceKey,
  memberViewIds,
  children,
}: ActiveViewSurface): string {
  const { background, header, isolation, lifecycle, layout, capabilities } =
    manifest;
  return JSON.stringify([
    viewId,
    sourceKey,
    memberViewIds,
    children?.map((child) => ({
      ...child,
      manifest: {
        ...child.manifest,
        capabilities: [...child.manifest.capabilities].sort(),
      },
    })),
    background,
    header,
    isolation,
    lifecycle,
    layout.kind,
    layout.topology,
    layout.width,
    layout.scroll,
    layout.gutter,
    [...capabilities].sort(),
  ]);
}

function resolveActiveViewSurface({
  tab,
  navigationPath,
  availableViews,
  dynamicPage,
  viewLayout,
  enabledKinds,
  managedCloudRuntime,
  cloudAuthenticated,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  dynamicPage: ResolvedDynamicPage | null;
  viewLayout: ActiveViewLayout | null;
  enabledKinds: EnabledViewKinds;
  managedCloudRuntime: boolean;
  cloudAuthenticated: boolean;
}): ActiveViewSurface {
  // A split/tile layout or an unregistered builtin route has no manifest bearer;
  // it resolves to the safe default (no grants) — the default-deny baseline.
  if (viewLayout) {
    return {
      sourceKey: "layout",
      memberViewIds: activeViewLayoutEntries(viewLayout, availableViews).map(
        (view) => view.id,
      ),
      manifest: resolveRoutedSurfaceManifest(null),
      viewId: `layout:${viewLayout.viewIds.join("+") || tab}`,
      // Mirror the shell's actual pane composition. Membership permits loading
      // beneath the existing no-grant layout owner; it does not union grants.
      children: activeViewLayoutEntries(viewLayout, availableViews).flatMap(
        (view): ActiveViewSurfaceChild[] => [
          {
            viewId: view.id,
            manifest: resolveRoutedSurfaceManifest(view),
            path: view.path,
            bundleUrl: view.bundleUrl,
            frameUrl: view.frameUrl,
            componentExport: view.componentExport,
          },
          ...(!view.bundleUrl && !view.frameUrl
            ? builtinSurfaceChildren(layoutRouteOverrideForView(view).tab)
            : []),
        ],
      ),
    };
  }

  const visibleAppShellPage = findVisibleAppShellPageForRoute(
    navigationPath,
    enabledKinds,
    managedCloudRuntime,
  );
  // A canonical Steward session owns the consolidated `/cloud` dashboard.
  // Keep this decision ahead of runtime-bundle selection so the renderer and
  // capability broker cannot disagree about which same-path Cloud surface is
  // active. Signed-out audit/plugin contexts retain normal remote precedence.
  if (
    visibleAppShellPage &&
    authenticatedCloudDashboardOwnsRoute(
      visibleAppShellPage,
      cloudAuthenticated,
    )
  ) {
    return {
      ...shellSurfaceOwner(visibleAppShellPage),
      manifest: resolveRoutedSurfaceManifest(visibleAppShellPage),
      viewId: visibleAppShellPage.id,
    };
  }
  // Restricted native renderers cannot execute remote bundles, so the signed
  // host page is also the active capability owner there. Web and desktop keep
  // their intentional remote-bundle precedence below.
  if (visibleAppShellPage && !isDynamicViewLoadingAllowed()) {
    return {
      ...shellSurfaceOwner(visibleAppShellPage),
      manifest: resolveRoutedSurfaceManifest(visibleAppShellPage),
      viewId: visibleAppShellPage.id,
    };
  }

  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView) {
    return {
      ...remoteSurfaceOwner(remoteView),
      manifest: resolveRoutedSurfaceManifest(remoteView),
      viewId: remoteView.id,
    };
  }

  if (visibleAppShellPage) {
    return {
      ...shellSurfaceOwner(visibleAppShellPage),
      manifest: resolveRoutedSurfaceManifest(visibleAppShellPage),
      viewId: visibleAppShellPage.id,
    };
  }

  const appShellPageForTab = listAppShellPages().find(
    (entry) =>
      (entry.id === tab || entry.tabAffinity === tab) &&
      appShellPageIsAvailable(entry, {
        managedCloud: managedCloudRuntime,
      }) &&
      isViewVisible(entry, enabledKinds),
  );
  if (appShellPageForTab) {
    return {
      ...shellSurfaceOwner(appShellPageForTab),
      manifest: resolveRoutedSurfaceManifest(appShellPageForTab),
      viewId: appShellPageForTab.agentViewId ?? appShellPageForTab.id,
    };
  }

  if (dynamicPage) {
    return {
      ...(dynamicPage.registration
        ? shellSurfaceOwner(dynamicPage.registration)
        : {
            sourceKey: JSON.stringify([
              "dynamic",
              dynamicPage.pluginId,
              dynamicPage.id,
              dynamicPage.componentExport,
            ]),
          }),
      manifest: resolveRoutedSurfaceManifest(
        dynamicPage.registration ?? dynamicPage,
      ),
      viewId: dynamicPage.registration?.agentViewId ?? dynamicPage.id,
    };
  }

  const registeredView = availableViews.find(
    (view) =>
      view.builtin !== true &&
      (view.id === tab ||
        view.path === navigationPath ||
        view.path === trimmedNavigationPath(navigationPath)),
  );
  if (registeredView) {
    return {
      ...remoteSurfaceOwner(registeredView),
      manifest: resolveRoutedSurfaceManifest(registeredView),
      viewId: registeredView.id,
    };
  }

  // Builtin routed content views resolve through the same declarative registry
  // the background resolver reads, so a builtin's declared framing (e.g. the
  // Browser's `header: "fullscreen"`) drives the identical full-bleed shell
  // path a registered fullscreen page (Notes, Calendar) takes. Immersive
  // wallpaper surfaces return null here — they keep their dedicated shell
  // branches.
  const builtinManifest = resolveBuiltinRoutedViewManifest(tab);
  if (builtinManifest) {
    return {
      sourceKey: "builtin",
      manifest: builtinManifest,
      viewId: tab === "tasks" ? "projects" : resolveBuiltinTabId(tab),
      children: builtinSurfaceChildren(tab),
    };
  }

  const builtinDescriptor = resolveBuiltinRouteDescriptor(tab);
  if (builtinDescriptor) {
    return {
      sourceKey: "builtin",
      manifest: {
        ...resolveSurfaceManifest({
          surface: { layout: builtinDescriptor.layout },
        }),
        layout: builtinDescriptor.layout,
      },
      viewId: builtinDescriptor.canonicalId,
      children: builtinSurfaceChildren(tab),
    };
  }

  return {
    sourceKey: "unregistered",
    manifest: resolveRoutedSurfaceManifest(null),
    viewId: tab,
  };
}

function useActiveViewSurface({
  tab,
  navigationPath,
  availableViews,
  dynamicPage,
  viewLayout,
  enabledKinds,
  managedCloudRuntime,
  cloudAuthenticated,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  dynamicPage: ResolvedDynamicPage | null;
  viewLayout: ActiveViewLayout | null;
  enabledKinds: EnabledViewKinds;
  managedCloudRuntime: boolean;
  cloudAuthenticated: boolean;
}): ActiveViewSurface {
  const registryVersion = useAppShellPageRegistryVersion();
  const resolved = useMemo(() => {
    void registryVersion;
    return resolveActiveViewSurface({
      tab,
      navigationPath,
      availableViews,
      dynamicPage,
      viewLayout,
      enabledKinds,
      managedCloudRuntime,
      cloudAuthenticated,
    });
  }, [
    availableViews,
    cloudAuthenticated,
    dynamicPage,
    enabledKinds,
    managedCloudRuntime,
    navigationPath,
    registryVersion,
    tab,
    viewLayout,
  ]);
  // Registry and auth refreshes can replace DTO identities without replacing
  // the mounted owner. Keep its imported broker handles alive until its actual
  // policy/source changes; render-phase state adjustment remains render-local.
  const [stable, setStable] = useState(resolved);
  if (
    surfacePolicyKey(stable) !== surfacePolicyKey(resolved) ||
    stable.sourceComponent !== resolved.sourceComponent ||
    stable.sourceLoader !== resolved.sourceLoader
  ) {
    setStable(resolved);
    return resolved;
  }
  return stable;
}

function trimmedNavigationPath(navigationPath: string): string {
  return navigationPath.length > 1 && navigationPath.endsWith("/")
    ? navigationPath.slice(0, -1)
    : navigationPath;
}

function remoteViewAvailable(view: ViewRegistryEntry): boolean {
  return Boolean((view.bundleUrl || view.frameUrl) && view.available !== false);
}

function remoteViewMatchesTab(
  view: ViewRegistryEntry,
  tab: string,
  appSlug: string | null,
): boolean {
  return Boolean(
    view.id === tab ||
      view.path === `/${tab}` ||
      view.path === `/apps/${tab}` ||
      (appSlug !== null &&
        (view.id === appSlug ||
          view.path === `/apps/${appSlug}` ||
          view.path === `/${appSlug}`)),
  );
}

// These paths are owned by the built-in shell and must never be handed off to
// a remote bundle, even if the view registry returns a bundleUrl for them.
const SHELL_RESERVED_PATHS = new Set([
  "/views",
  "/apps",
  "/character/documents",
  "/character/experience",
  "/character/skills",
  "/apps/plugins",
  "/apps/skills",
  "/apps/trajectories",
  "/apps/relationships",
  "/apps/memories",
  "/apps/runtime",
  "/apps/database",
  "/apps/logs",
  "/apps/tasks",
]);

const SHELL_RESERVED_TABS = new Set(Object.keys(TAB_PATHS));

function findRemoteViewForRoute(
  views: ViewRegistryEntry[],
  navigationPath: string,
  tab: string,
  appSlug: string | null,
): ViewRegistryEntry | undefined {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  if (
    SHELL_RESERVED_PATHS.has(normalizedPath) ||
    resolveLegacyBuiltinRoute(normalizedPath)
  ) {
    return undefined;
  }
  // Exact plugin paths own their route even when they share a reserved tab
  // affinity such as Wallet. This lets web/desktop mount the agent-served
  // bundle while native shells still fall back to their in-process page.
  const exactMatch = views.find(
    // A registered route still owns its loading/error state when its bundle
    // is unavailable. Let the loader offer recovery instead of falling
    // through to the unrelated Views manager.
    (view) =>
      Boolean(view.bundleUrl || view.frameUrl) && view.path === normalizedPath,
  );
  if (exactMatch) return exactMatch;
  if (tab !== "views" && tab !== "apps" && SHELL_RESERVED_TABS.has(tab)) {
    return undefined;
  }
  return views.find(
    (view) =>
      remoteViewAvailable(view) && remoteViewMatchesTab(view, tab, appSlug),
  );
}

function renderRemoteView(
  view: ViewRegistryEntry,
  nav?: ReactNode,
  viewProps?: Record<string, unknown>,
): ReactNode {
  if (!view.bundleUrl && !view.frameUrl) return null;
  return (
    <ViewSurfaceFrame
      declaration={view}
      nav={nav}
      suppressHeader={Boolean(viewProps?.pageChrome)}
      title={view.label}
    >
      <DynamicViewLoader
        bundleUrl={view.bundleUrl}
        frameUrl={view.frameUrl}
        componentExport={view.componentExport}
        viewId={view.id}
        viewType={view.viewType}
        reserveChatClearance={false}
        surface={view.surface}
        viewProps={viewProps}
      />
    </ViewSurfaceFrame>
  );
}

function findAppShellPageForRoute(
  navigationPath: string,
): AppShellPageRegistration | undefined {
  return listAppShellPages().find((entry) =>
    appShellPageMatchesPath(entry, navigationPath),
  );
}

function findVisibleAppShellPageForRoute(
  navigationPath: string,
  enabledKinds: EnabledViewKinds,
  managedCloudRuntime: boolean,
): AppShellPageRegistration | undefined {
  const registration = findAppShellPageForRoute(navigationPath);
  return registration &&
    appShellPageIsAvailable(registration, {
      managedCloud: managedCloudRuntime,
    }) &&
    isViewVisible(registration, enabledKinds)
    ? registration
    : undefined;
}

function authenticatedCloudDashboardOwnsRoute(
  registration: AppShellPageRegistration | undefined,
  cloudAuthenticated: boolean,
): boolean {
  return Boolean(
    cloudAuthenticated &&
      registration?.id === "cloud" &&
      registration.pluginId === "@elizaos/ui",
  );
}

function viewLayoutLabel(layout: ActiveViewLayout): string {
  return layout.mode === "split" ? "Split view" : "Tiled views";
}

function splitLayoutIsStacked(layout: ActiveViewLayout): boolean {
  const hint = `${layout.layout ?? ""} ${layout.placement ?? ""}`.toLowerCase();
  return /\b(vertical|rows?|top|bottom|above|below)\b/.test(hint);
}

function viewLayoutGridClass(layout: ActiveViewLayout, count: number): string {
  if (layout.mode === "split") {
    return splitLayoutIsStacked(layout)
      ? "grid-cols-1 grid-rows-2"
      : "grid-cols-1 md:grid-cols-2";
  }
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-1 md:grid-cols-2";
  return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
}

function ViewLayoutSurface({
  availableViews,
  cloudAuthenticated,
  layout,
  onClear,
}: {
  availableViews: ViewRegistryEntry[];
  cloudAuthenticated: boolean;
  layout: ActiveViewLayout;
  onClear: () => void;
}): ReactNode {
  const entries = activeViewLayoutEntries(layout, availableViews);
  const paneClassName =
    "flex min-h-[18rem] min-w-0 flex-col overflow-hidden border border-border/45 bg-bg";

  return (
    <AppWorkspaceContent pageLayout={DEFAULT_ROUTED_PAGE_LAYOUT}>
      <section
        data-testid="view-layout-surface"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg"
      >
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/45 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {viewLayoutLabel(layout)}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {entries.length}
            </span>
          </div>
          <Button
            variant="ghostMuted"
            size="icon-sm"
            aria-label="Close layout"
            title="Close layout"
            data-testid="view-layout-close"
            onClick={onClear}
            className="shrink-0"
          >
            <X className="size-4" aria-hidden />
          </Button>
        </header>
        <div
          className={`grid min-h-0 flex-1 gap-2 overflow-auto p-2 ${viewLayoutGridClass(
            layout,
            entries.length,
          )} eliza-chat-scroll pb-[calc(0.5rem+var(--eliza-chat-clearance,5.25rem))]`}
        >
          {entries.length > 0 ? (
            entries.map((view) => (
              <section
                key={view.id}
                data-testid={`view-layout-pane-${view.id}`}
                className={paneClassName}
              >
                <div className="flex h-9 shrink-0 items-center border-b border-border/35 px-2.5">
                  <span className="truncate text-xs font-medium text-muted">
                    {view.label}
                  </span>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                  {view.bundleUrl || view.frameUrl ? (
                    <DynamicViewLoader
                      bundleUrl={view.bundleUrl}
                      frameUrl={view.frameUrl}
                      componentExport={view.componentExport}
                      viewId={view.id}
                      viewType={view.viewType}
                      surface={view.surface}
                    />
                  ) : (
                    <ViewRouter
                      cloudAuthenticated={cloudAuthenticated}
                      routeOverride={layoutRouteOverrideForView(view)}
                    />
                  )}
                </div>
              </section>
            ))
          ) : (
            <div className="flex min-h-[18rem] items-center justify-center border border-border/45 px-4 text-center text-sm text-muted">
              Requested views are not available.
            </div>
          )}
        </div>
      </section>
    </AppWorkspaceContent>
  );
}

/**
 * Fallback shown when a view/tab is unavailable. Chat is the always-present
 * ChatOverlay that floats over every view — views never embed an
 * inline ChatView — so an unavailable view falls back to the Launcher page
 * of the retained Home/Launcher surface, not a chat surface.
 */
function ViewUnavailableFallback({
  viewId,
  pageLayout,
}: {
  viewId: string;
  pageLayout?: PageLayoutManifest;
}): ReactNode {
  const { refresh } = useAvailableViews();
  return (
    <AppWorkspaceContent pageLayout={pageLayout}>
      <ViewUnavailableState viewId={viewId} onRetry={refresh} />
    </AppWorkspaceContent>
  );
}

function renderPhoneSurface(
  enabled: boolean,
  Component: ComponentType,
  pageLayout: PageLayoutManifest,
  viewId: string,
): ReactNode {
  return enabled ? (
    <AppWorkspaceContent pageLayout={pageLayout}>
      <Component />
    </AppWorkspaceContent>
  ) : (
    <ViewUnavailableFallback viewId={viewId} pageLayout={pageLayout} />
  );
}

function renderAppsSurface(
  navigationPath: string,
  pageLayout: PageLayoutManifest,
): ReactNode {
  if (!APPS_ENABLED) {
    return <ViewUnavailableFallback viewId="apps" pageLayout={pageLayout} />;
  }
  const appSlug = getAppSlugFromPath(navigationPath);
  if (!appSlug) {
    return (
      <PageFrame layout={pageLayout}>
        <HomeScreenMount initialSection="apps" />
      </PageFrame>
    );
  }
  // Reaching here means no registered page or remote view claimed the slug —
  // AppsPageView decides between the app runtime and the designed not-found
  // state (#17033), so a dead deep link never renders as the healthy grid.
  return (
    <AppWorkspaceContent pageLayout={pageLayout}>
      <AppsPageView appSlug={appSlug} />
    </AppWorkspaceContent>
  );
}

/** Runtime context a builtin static-tab renderer may read. */
interface StaticTabRenderContext {
  nativeOsSurfaceEnabled: boolean;
  navigationPath: string;
  pageLayout: PageLayoutManifest;
  settingsInitialSection?: string | null;
  settingsNavigatePayload?: unknown;
  settingsNavigateSequence?: number;
  walletNav?: ReactNode;
  characterNav?: ReactNode;
}

/**
 * The single builtin static-tab render registry: canonical-id -> renderer.
 *
 * This replaces the former split between a `directViews` object literal and a
 * trailing `if (tab === "...")` chain (App.tsx audit item #34). Both were
 * hand-maintained tab enumerations sitting next to a SECOND enumeration in
 * `builtinRouteBackgroundPolicy`; a tab added to one and forgotten in another
 * was an unobservable drift bug. Now every builtin surface (simple or one that
 * needs runtime context / a custom wrapper) is ONE keyed entry, and alias tabs
 * (`triggers` -> `automations`) resolve through
 * the shared `builtin-tab-registry` so the router and the background resolver
 * read the same alias table.
 *
 * Built lazily per-call (not a module constant) because several renderers close
 * over per-render context (settings section, wallet nav, native-surface gate).
 */
function buildStaticTabRenderers(): Record<
  string,
  (ctx: StaticTabRenderContext) => ReactNode
> {
  const wrap =
    (node: ReactNode) =>
    ({ pageLayout }: StaticTabRenderContext) => (
      <AppWorkspaceContent pageLayout={pageLayout}>{node}</AppWorkspaceContent>
    );
  const wrapOverlayAware =
    (node: ReactNode) =>
    ({ pageLayout }: StaticTabRenderContext) => (
      <AppWorkspaceContent pageLayout={pageLayout} reserveChatClearance={false}>
        {node}
      </AppWorkspaceContent>
    );
  // Tool views that own no header of their own get the shared ViewHeader (back
  // button + centered title) via the same flush structure MemoryViewerView uses,
  // so every launcher tool reads the same at the top instead of opening headerless.
  const withHeader =
    (tab: Tab, node: ReactNode) =>
    ({ pageLayout }: StaticTabRenderContext) => (
      <AppWorkspaceContent
        header={<ViewHeader title={titleForTab(tab)} />}
        pageLayout={pageLayout}
      >
        {node}
      </AppWorkspaceContent>
    );
  return {
    chat: () => <HomeScreenMount initialSection="apps" />,
    browser: wrapOverlayAware(<LazyBrowserWorkspaceView />),
    stream: wrap(<LazyStreamView />),
    "pendant-transcript": wrapOverlayAware(<LazyPendantTranscriptView />),
    tasks: wrapOverlayAware(
      <ShellViewAgentSurface viewId="projects">
        <LazyTasksPageView />
      </ShellViewAgentSurface>,
    ),
    automations: wrapOverlayAware(<LazyAutomationsFeed />),
    plugins: withHeader("plugins", <LazyPluginsPageView />),
    skills: withHeader("skills", <LazySkillsView />),
    trajectories: wrap(<LazyTrajectoriesView />),
    transcripts: withHeader("transcripts", <LazyLiveMeetingPageView />),
    // Relationships is plugin-owned. Its app-shell registration claims the
    // route and supplies the page chrome; an absent plugin is an unavailable
    // feature rather than a host-side duplicate implementation.
    relationships: ({ pageLayout }) => (
      <ViewUnavailableFallback viewId="relationships" pageLayout={pageLayout} />
    ),
    // Knowledge is plugin-owned. If the document plugin is unavailable, the
    // registered-page resolver renders its explicit unavailable state.
    documents: ({ pageLayout }) => (
      <ViewUnavailableFallback viewId="documents" pageLayout={pageLayout} />
    ),
    experience: ({ characterNav, pageLayout }) => (
      <AppWorkspaceContent pageLayout={pageLayout} reserveChatClearance={false}>
        <LazyCharacterExperienceView pageChrome={characterNav} />
      </AppWorkspaceContent>
    ),
    "character-skills": ({ characterNav, pageLayout }) => (
      <AppWorkspaceContent pageLayout={pageLayout} reserveChatClearance={false}>
        <LazyCharacterSkillsView pageChrome={characterNav} />
      </AppWorkspaceContent>
    ),
    memories: wrapOverlayAware(<LazyMemoryViewerView />),
    files: wrapOverlayAware(<LazyFilesView />),
    runtime: withHeader("runtime", <LazyRuntimeView />),
    database: wrapOverlayAware(<LazyDatabasePageView />),
    logs: withHeader("logs", <LazyLogsView />),
    desktop: withHeader("desktop", <LazyDesktopWorkspaceSection />),
    settings: ({
      settingsInitialSection,
      settingsNavigatePayload,
      settingsNavigateSequence,
      pageLayout,
    }) => (
      <AppWorkspaceContent
        pageLayout={pageLayout}
        surface="transparent"
        // The router owns the floating-composer clearance, so Settings must
        // paint its material canvas on that same boundary. Keeping the palette
        // only on the nested SettingsView left the reserved bottom region as a
        // disconnected black strip instead of a continuous surface behind the
        // floating chat overlay.
        className="settings-surface settings-canvas"
      >
        <LazySettingsView
          key="settings-root"
          initialSection={settingsInitialSection ?? undefined}
          navigatePayload={settingsNavigatePayload}
          navigateSequence={settingsNavigateSequence}
        />
      </AppWorkspaceContent>
    ),
    vault: wrapOverlayAware(<LazyVaultPageView />),
    // Camera is an AOSP-ElizaOS-fork-only surface — gate the route on the same
    // marker as the home tile, so a deep-link off the fork falls back to
    // "unavailable" instead of rendering on web/desktop/iOS/Play-Store Android.
    camera: ({ pageLayout }) =>
      renderPhoneSurface(
        isAospShellEnabled(),
        LazyCameraPageView,
        pageLayout,
        "camera",
      ),
    phone: ({ pageLayout }) => (
      <ViewUnavailableFallback viewId="phone" pageLayout={pageLayout} />
    ),
    messages: ({ pageLayout }) => (
      <ViewUnavailableFallback viewId="messages" pageLayout={pageLayout} />
    ),
    contacts: ({ pageLayout }) => (
      <ViewUnavailableFallback viewId="contacts" pageLayout={pageLayout} />
    ),
    views: ({ navigationPath, pageLayout }) =>
      renderAppsSurface(navigationPath, pageLayout),
    apps: ({ navigationPath, pageLayout }) =>
      renderAppsSurface(navigationPath, pageLayout),
    // Rendered directly (no routed workspace chrome) so the live app
    // background shows through behind the controls.
    background: ({ pageLayout }) => (
      <PageFrame layout={pageLayout}>
        <LazyBackgroundView />
      </PageFrame>
    ),
    character: ({ characterNav, pageLayout }) => (
      <AppWorkspaceContent pageLayout={pageLayout} reserveChatClearance={false}>
        <LazyCharacterEditor pageChrome={characterNav} />
      </AppWorkspaceContent>
    ),
    "character-select": ({ characterNav, pageLayout }) => (
      <AppWorkspaceContent pageLayout={pageLayout} reserveChatClearance={false}>
        <LazyCharacterEditor pageChrome={characterNav} />
      </AppWorkspaceContent>
    ),
    inventory: ({ walletNav, pageLayout }) => (
      <AppWorkspaceContent nav={walletNav} pageLayout={pageLayout}>
        <WalletInventoryPage />
      </AppWorkspaceContent>
    ),
  };
}

function renderStaticViewRouterTab({
  tab,
  nativeOsSurfaceEnabled,
  navigationPath,
  settingsInitialSection,
  settingsNavigatePayload,
  settingsNavigateSequence,
  walletNav,
  characterNav,
}: {
  tab: string;
  nativeOsSurfaceEnabled: boolean;
  navigationPath: string;
  settingsInitialSection?: string | null;
  settingsNavigatePayload?: unknown;
  settingsNavigateSequence?: number;
  walletNav?: ReactNode;
  characterNav?: ReactNode;
}): ReactNode {
  // Resolve aliases, renderer identity, and canonical page geometry from the
  // same descriptor so the route cannot drift into a parallel layout table.
  const routeDescriptor = resolveBuiltinRouteDescriptor(tab);
  const render = routeDescriptor
    ? buildStaticTabRenderers()[routeDescriptor.canonicalId]
    : undefined;
  if (render && routeDescriptor) {
    return render({
      nativeOsSurfaceEnabled,
      navigationPath,
      pageLayout: routeDescriptor.layout,
      settingsInitialSection,
      settingsNavigatePayload,
      settingsNavigateSequence,
      walletNav,
      characterNav,
    });
  }
  return <ViewUnavailableFallback viewId={tab} />;
}

function renderViewRouterContent({
  tab,
  dynamicPage,
  dynamicAppPage,
  enabledKinds,
  navigationPath,
  availableViews,
  appSlug,
  nativeOsSurfaceEnabled,
  managedCloudRuntime,
  cloudAuthenticated,
  settingsInitialSection,
  settingsNavigatePayload,
  settingsNavigateSequence,
}: {
  tab: string;
  dynamicPage: ResolvedDynamicPage | null;
  dynamicAppPage: ResolvedDynamicPage | null;
  enabledKinds: EnabledViewKinds;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  appSlug: string | null;
  nativeOsSurfaceEnabled: boolean;
  managedCloudRuntime: boolean;
  cloudAuthenticated: boolean;
  settingsInitialSection?: string | null;
  settingsNavigatePayload?: unknown;
  settingsNavigateSequence?: number;
}): ReactNode {
  // Path ownership is more specific than tab affinity. Wallet-family plugins
  // intentionally share the `inventory` tab, but their exact routes must mount
  // their own registrations before that affinity resolves to the wallet root.
  const walletNav = isWalletSectionPath(navigationPath) ? (
    <WalletSectionNav activePath={navigationPath} />
  ) : undefined;
  const characterFamilyPath = isCharacterSectionPath(navigationPath);
  const characterRelationshipsTab =
    resolveBuiltinTabId(tab) === "relationships";
  const characterNav =
    characterFamilyPath || characterRelationshipsTab ? (
      <CharacterSectionNav
        activePath={
          characterFamilyPath ? navigationPath : "/apps/relationships"
        }
      />
    ) : undefined;
  // Native-OS feature surfaces are plugin-owned. Prefer the plugin's bundled
  // registration when it is present; retain the legacy renderer only as a
  // compatibility fallback while older builds finish migrating their plugin.
  if (
    nativeOsSurfaceEnabled &&
    (NATIVE_OS_VIEW_IDS as readonly string[]).includes(resolveBuiltinTabId(tab))
  ) {
    const nativeRegistration = listAppShellPages().find(
      (entry) =>
        entry.tabAffinity === resolveBuiltinTabId(tab) &&
        appShellPageMatchesPath(entry, navigationPath),
    );
    if (nativeRegistration) {
      return (
        <AppWorkspaceContent
          pageLayout={resolveRoutedSurfaceManifest(nativeRegistration).layout}
          reserveChatClearance={!surfaceOwnsViewport(nativeRegistration)}
        >
          <RegisteredAppShellPage registration={nativeRegistration} />
        </AppWorkspaceContent>
      );
    }
    return renderStaticViewRouterTab({
      tab,
      nativeOsSurfaceEnabled,
      navigationPath,
      settingsInitialSection,
      settingsNavigatePayload,
      settingsNavigateSequence,
      walletNav,
    });
  }
  const visibleAppShellPage = findVisibleAppShellPageForRoute(
    navigationPath,
    enabledKinds,
    managedCloudRuntime,
  );
  const renderAppShellPage = (registration: AppShellPageRegistration) => {
    const registrationCharacterNav =
      characterNav ??
      (registration.id === "relationships" ? (
        <CharacterSectionNav activePath="/apps/relationships" />
      ) : undefined);
    return (
      <ViewSurfaceFrame
        declaration={registration}
        nav={registrationCharacterNav ? undefined : walletNav}
        suppressHeader={Boolean(registrationCharacterNav)}
        title={registration.label}
      >
        <RegisteredAppShellPage
          registration={registration}
          viewProps={
            registrationCharacterNav
              ? { pageChrome: registrationCharacterNav }
              : undefined
          }
        />
      </ViewSurfaceFrame>
    );
  };

  if (
    visibleAppShellPage &&
    authenticatedCloudDashboardOwnsRoute(
      visibleAppShellPage,
      cloudAuthenticated,
    )
  ) {
    return renderAppShellPage(visibleAppShellPage);
  }

  // Restricted native renderers cannot execute an agent-served bundle. Prefer
  // an exact signed registration at the final renderer boundary even if a
  // stale/web-shaped registry snapshot still carries bundleUrl for the same
  // id/path. Web and desktop deliberately retain remote-bundle precedence.
  if (visibleAppShellPage && !isDynamicViewLoadingAllowed()) {
    return renderAppShellPage(visibleAppShellPage);
  }
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView?.bundleUrl || remoteView?.frameUrl) {
    const remoteCharacterNav =
      characterNav ??
      (remoteView.id === "relationships" ? (
        <CharacterSectionNav activePath="/apps/relationships" />
      ) : undefined);
    return renderRemoteView(
      remoteView,
      remoteCharacterNav ? undefined : walletNav,
      remoteCharacterNav ? { pageChrome: remoteCharacterNav } : undefined,
    );
  }
  if (visibleAppShellPage) {
    return renderAppShellPage(visibleAppShellPage);
  }

  if (visibleDynamicPage(dynamicPage, enabledKinds, managedCloudRuntime)) {
    return (
      <ViewSurfaceFrame
        declaration={dynamicPage.registration ?? dynamicPage}
        title={dynamicPage.registration?.label ?? dynamicPage.id}
      >
        <DynamicPluginPage resolved={dynamicPage} />
      </ViewSurfaceFrame>
    );
  }
  if (visibleDynamicPage(dynamicAppPage, enabledKinds, managedCloudRuntime)) {
    return (
      <ViewSurfaceFrame
        declaration={dynamicAppPage.registration ?? dynamicAppPage}
        title={dynamicAppPage.registration?.label ?? dynamicAppPage.id}
      >
        <DynamicPluginPage resolved={dynamicAppPage} />
      </ViewSurfaceFrame>
    );
  }

  return renderStaticViewRouterTab({
    tab,
    nativeOsSurfaceEnabled,
    navigationPath,
    settingsInitialSection,
    settingsNavigatePayload,
    settingsNavigateSequence,
    walletNav,
    characterNav,
  });
}

type ViewRouterRouteOverride = {
  tab: string;
  navigationPath: string;
};

function ViewRouter({
  cloudAuthenticated,
  routeOverride,
  settingsInitialSection,
  settingsNavigatePayload,
  settingsNavigateSequence,
}: {
  cloudAuthenticated: boolean;
  routeOverride?: ViewRouterRouteOverride;
  settingsInitialSection?: string | null;
  settingsNavigatePayload?: unknown;
  settingsNavigateSequence?: number;
}) {
  const activeTab = useAppSelector((s) => s.tab);
  const tab = routeOverride?.tab ?? activeTab;
  // Phone / messages / contacts are AOSP-fork-only native-OS surfaces (like
  // camera + the home tiles + the launcher tiles) — never rendered on web,
  // desktop, iOS, or stock Play-Store Android, even via a deep link.
  const nativeOsSurfaceEnabled = isAospShellEnabled();
  // AppProvider owns late path-to-tab reconciliation through setTabRaw. Doing
  // it here through the public setTab command would rewrite exact plugin paths
  // to a shared affinity's canonical path (for example a wallet sub-page to
  // the wallet root).
  const dynamicPage = useResolvedDynamicPage(tab);
  const [navigationPath, setNavigationPath] = useState(
    () =>
      routeOverride?.navigationPath ??
      (typeof window === "undefined" ? "/" : getWindowNavigationPath()),
  );
  const routeOverridePath = routeOverride?.navigationPath;
  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const dynamicAppPage = useResolvedDynamicPage(appSlug ?? "");
  const enabledKinds = useEnabledViewKinds();
  const runtimeTarget = useAppSelector(
    (state) => state.startupCoordinator.target,
  );
  const managedCloudRuntime = isManagedCloudRuntime(runtimeTarget);

  useEffect(() => {
    if (routeOverridePath) {
      setNavigationPath(routeOverridePath);
      return;
    }
    if (typeof window === "undefined") return;
    const navEvt = shouldUseHashNavigation() ? "hashchange" : "popstate";
    const handleNavigationChange = () => {
      setNavigationPath(getWindowNavigationPath());
    };
    window.addEventListener(navEvt, handleNavigationChange);
    return () => window.removeEventListener(navEvt, handleNavigationChange);
  }, [routeOverridePath]);

  // Available views from /api/views — used to route to DynamicViewLoader
  // when a tab ID matches a view entry that ships a remote bundle URL.
  const { views: availableViews } = useAvailableViews();
  const view = renderViewRouterContent({
    tab,
    dynamicPage,
    dynamicAppPage,
    enabledKinds,
    navigationPath,
    availableViews,
    appSlug,
    nativeOsSurfaceEnabled,
    managedCloudRuntime,
    cloudAuthenticated,
    settingsInitialSection,
    settingsNavigatePayload,
    settingsNavigateSequence,
  });

  // A distinct lifecycle identity per routed surface: builtin tab id, or
  // tab:slug for a remote/app route so two remote views get independent
  // boundaries + telemetry.
  const activeViewId = appSlug ? `${tab}:${appSlug}` : tab;

  // Split-view panes (routeOverride) keep a simple per-pane crash boundary; only
  // the PRIMARY router drives the single global view-lifecycle controller +
  // keep-alive host, so multiple ViewRouters never fight over the active id.
  if (routeOverride) {
    return (
      <ViewErrorBoundary viewId={`pane:${activeViewId}`}>
        <LazyViewBoundary>{view}</LazyViewBoundary>
      </ViewErrorBoundary>
    );
  }

  // The keep-alive host wraps the active view in a per-view ViewErrorBoundary +
  // ViewTelemetryProfiler + ViewLifecycleSlot and drives the lifecycle
  // controller (pause on app-background / tab-hidden / memory-pressure). With
  // the default unmount-on-hide policy the host mounts exactly the active view —
  // behaviorally identical to the prior single-branch ViewRouter.
  return (
    <KeepAliveViewHost
      activeViewId={activeViewId}
      renderView={(viewId) =>
        viewId === activeViewId ? (
          <LazyViewBoundary>{view}</LazyViewBoundary>
        ) : null
      }
    />
  );
}

function greetingForTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning! What would you like to do?";
  if (hour < 18) return "Good afternoon! What would you like to do?";
  return "Good evening! What would you like to do?";
}

const APP_SHELL_CLASS =
  "flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg";

// Home/Launcher and Background opt into the unified app background (mounted
// once at the shell root), so their shell is transparent — no `bg-bg` to paint
// over it. Every other view keeps the opaque shell (its own background).
const APP_SHELL_CLASS_TRANSPARENT =
  "flex flex-col flex-1 min-h-0 w-full font-body text-txt";

type ShellContentProps = {
  actionNotice: ActionNotice | null;
  availableViewsForLayout: ViewRegistryEntry[];
  cloudAuthenticated: boolean;
  customActionsPanelOpen: boolean;
  desktopTabBar: ReactNode;
  isChat: boolean;
  isFullBleed: boolean;
  screenBackgroundPolicy: AppShellBackgroundPolicy;
  setCustomActionsEditorOpen: (open: boolean) => void;
  setCustomActionsPanelOpen: (open: boolean) => void;
  setEditingAction: (action: import("./api").CustomActionDef | null) => void;
  settingsInitialSection: string | null;
  settingsNavigatePayload: unknown;
  settingsNavigateSequence: number;
  tab: string;
  uiShellMode: string;
  viewLayout: ActiveViewLayout | null;
  onClearViewLayout: () => void;
};

function ChatRouteShellContent(props: ShellContentProps): ReactNode {
  // The /chat route is the ambient conversational home: open space behind the
  // always-present ChatOverlay (mounted at the shell root), which is
  // the whole chat experience. Ask it anything, or ask it to open a view ("show
  // me the coding view") which surfaces over this base. The home is wordless,
  // sitting directly on the unified app background (mounted once at the shell
  // root) — its shell is transparent so that background shows through.
  return (
    <div key="chat-shell" className={APP_SHELL_CLASS_TRANSPARENT}>
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
        <HomeScreenMount initialSection="home" />
        <CustomActionsPanel
          open={props.customActionsPanelOpen}
          onClose={() => props.setCustomActionsPanelOpen(false)}
          onOpenEditor={(action) => {
            props.setEditingAction(action ?? null);
            props.setCustomActionsEditorOpen(true);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The single routed shell for every view. ViewRouter already resolves every tab
 * — static page views, dynamic plugin pages, and remote view bundles — so the
 * shell only adds the desktop tab bar and per-tab padding around it. Chat is the
 * always-present ChatOverlay floating over this base, never embedded
 * per-view.
 */
function RoutedShellContent(props: ShellContentProps): ReactNode {
  // Routes with `backgroundPolicy: "shared"` intentionally sit on the unified
  // Home/Launcher background. Every other route is opaque; the shell root
  // also paints a full-window underlay so status/home-indicator safe areas do
  // not expose the shared background around app views.
  const shellClass =
    props.screenBackgroundPolicy === "shared"
      ? APP_SHELL_CLASS_TRANSPARENT
      : APP_SHELL_CLASS;
  return (
    <div key={`tab-shell-${props.tab}`} className={shellClass}>
      {props.desktopTabBar}
      <main className={routedShellMainClass(props.tab)}>
        {props.viewLayout ? (
          <ViewLayoutSurface
            availableViews={props.availableViewsForLayout}
            cloudAuthenticated={props.cloudAuthenticated}
            layout={props.viewLayout}
            onClear={props.onClearViewLayout}
          />
        ) : (
          <ViewRouter
            cloudAuthenticated={props.cloudAuthenticated}
            settingsInitialSection={props.settingsInitialSection}
            settingsNavigatePayload={props.settingsNavigatePayload}
            settingsNavigateSequence={props.settingsNavigateSequence}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Edge-to-edge surface for pages that register `fullBleed` — no tab bar, no
 * padding. The page owns its full window (e.g. the orchestrator).
 */
function FullBleedShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`fullbleed-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <main className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <ViewRouter cloudAuthenticated={props.cloudAuthenticated} />
      </main>
    </div>
  );
}

/**
 * Picks the shell wrapper for the active tab. Only three surfaces are genuinely
 * distinct from a routed view: `fullBleed` pages (edge-to-edge), the ambient
 * `/chat` home (open space behind the overlay), and the host-injected companion
 * shell. Everything else is a view rendered through the single
 * RoutedShellContent → ViewRouter path.
 */
function ShellContent(props: ShellContentProps): ReactNode {
  if (props.isFullBleed) return <FullBleedShellContent {...props} />;
  if (props.isChat) return <ChatRouteShellContent {...props} />;
  return <RoutedShellContent {...props} />;
}

/**
 * Vault modal, loaded on first open (#11351). `SecretsManagerSection` pulls the
 * whole vault surface (tabs, tables, routing editor) plus its data layer; a
 * static import here kept all of it on the eager boot graph even though the
 * modal only ever renders after an explicit open dispatch (launcher row, ⌘⌥⌃V
 * chord, menu accelerator). The open/close state lives in the lightweight
 * `useSecretsManagerModal` hook module, so this mount can subscribe eagerly
 * (never missing an open event) while the modal body stays on a lazy chunk
 * until the first open. After that it stays mounted so close animations and
 * in-modal state behave exactly as before.
 */
const VaultModal = lazy(() =>
  import("./components/settings/SecretsManagerSection").then((m) => ({
    default: m.VaultModal,
  })),
);

function SecretsManagerModalMount(): ReactNode {
  const { isOpen, initialTab, focusKey, focusProfileId, setOpen, clearFocus } =
    useSecretsManagerModalState();
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);
  if (!hasOpened) return null;
  return (
    <Suspense fallback={null}>
      <VaultModal
        open={isOpen}
        onOpenChange={setOpen}
        initialTab={initialTab}
        initialFocusKey={focusKey}
        initialFocusProfileId={focusProfileId}
        onConsumeInitial={clearFocus}
      />
    </Suspense>
  );
}

function ShellFoundationMount({
  useWebChatPanel = false,
  releaseFirstRunToFull = false,
  retainMountedFirstRunOpen = false,
  onFirstRunReleaseHandled = () => {},
  onFirstRunChatMounted,
  firstRunMountEpoch = null,
}: {
  /** Desktop opens the same draggable chat surface as web, not a separate drawer. */
  useWebChatPanel?: boolean;
  releaseFirstRunToFull?: boolean;
  /** Keep an already-mounted authoritative onboarding transcript pinned while startup advances. */
  retainMountedFirstRunOpen?: boolean;
  onFirstRunReleaseHandled?: () => void;
  onFirstRunChatMounted?: (epoch: number) => void;
  firstRunMountEpoch?: number | null;
} = {}) {
  const controller = useShellControllerContext();
  const hasController = controller !== null;
  const shellIsOpen = controller?.isOpen ?? false;
  const shellPhase = controller?.phase;
  const { firstRunComplete, startupPhase } = useAppSelectorShallow((state) => ({
    firstRunComplete: state.firstRunComplete,
    startupPhase: state.startupCoordinator.phase,
  }));
  const firstRunPinnedOpen =
    isAuthoritativeFirstRunOpen(firstRunComplete, startupPhase) ||
    (firstRunComplete === false && retainMountedFirstRunOpen);
  // Completion updates the store before the half-height overlay can release
  // its first-run pin. Keep that mounted instance through the edge so its
  // shared transcript stays visible until the user deliberately folds to the
  // pill; a completed relaunch starts with both values false.
  const firstRunWasPinnedOpenRef = useRef(firstRunPinnedOpen);
  const firstRunJustCompleted =
    firstRunWasPinnedOpenRef.current && !firstRunPinnedOpen;
  const [keepChatOpenAfterFirstRun, setKeepChatOpenAfterFirstRun] =
    useState(false);
  useEffect(() => {
    if (firstRunJustCompleted) setKeepChatOpenAfterFirstRun(true);
    firstRunWasPinnedOpenRef.current = firstRunPinnedOpen;
  }, [firstRunJustCompleted, firstRunPinnedOpen]);
  const shouldMountWebChatPanel =
    useWebChatPanel &&
    (shellIsOpen ||
      firstRunPinnedOpen ||
      firstRunJustCompleted ||
      keepChatOpenAfterFirstRun);
  const [shellPreviewHostReady, setShellPreviewHostReady] = useState(false);
  const [shellHostDetent, setShellHostDetent] = useState<
    "pill" | "input" | "half" | "full"
  >(shellIsOpen ? "input" : "pill");
  const setActionNotice = useAppSelector((state) => state.setActionNotice);
  const handleWindowBoundsFailure = useCallback((): void => {
    if (shellIsOpen) controller?.close();
    setActionNotice(
      "Desktop chat window resize failed. Close and reopen Eliza to retry.",
      "error",
      6_000,
    );
  }, [controller, setActionNotice, shellIsOpen]);
  const syncNativeSurfaceState = useCallback(
    (state: DesktopBottomBarSurfaceState): void => {
      void setDesktopBottomBarSurfaceState(state).catch(
        handleWindowBoundsFailure,
      );
    },
    [handleWindowBoundsFailure],
  );
  const focusComposerOnOpenRef = useRef(false);
  const { setChatInput } = useChatComposer();
  const chatInputRef = useChatInputRef();
  // Push-to-talk dictation on the ChatSurface mic drops its transcript into
  // the SHARED composer draft (never auto-sends) — the same sink contract the
  // continuous overlay registers on its surface. This shell and the overlay
  // are mutually exclusive App surfaces, so the controller's single sink slot
  // is never contended.
  useEffect(() => {
    if (!controller || useWebChatPanel) return undefined;
    controller.setDictationSink((text) => {
      const current = chatInputRef?.current ?? "";
      setChatInput(current ? `${current} ${text}` : text);
    });
    return () => controller.setDictationSink(null);
  }, [controller, setChatInput, chatInputRef, useWebChatPanel]);

  // Global push-to-talk hotkey (#20483): the OS shortcut is trigger-only (no
  // key-up event reaches the renderer), so the hotkey drives the SAME ptt
  // capture as the pill's hold, in toggle form — first press opens the mic
  // (ping + listening chip on the pill), second press stops and sends (tick). No
  // window is summoned and no focus is taken; the pill alone shows the state.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onToggle = () => {
      const shell = controllerRef.current;
      if (!shell) return;
      if (shell.authGate.gated) {
        if (shell.authGate.phase === "needs-auth") shell.requestSignIn();
        else shell.startRecording("ptt");
        return;
      }
      if (shell.recording) {
        playCaptureSendCue();
        shell.stopRecording();
        return;
      }
      playCaptureStartCue();
      shell.startRecording("ptt");
    };
    document.addEventListener(PUSH_TO_TALK_TOGGLE_EVENT, onToggle);
    return () =>
      document.removeEventListener(PUSH_TO_TALK_TOGGLE_EVENT, onToggle);
  }, []);

  // Fn-hold quasimode (#20483): the native fn monitor delivers true down/up,
  // so this is the same contract as the pill's own press-and-hold — down
  // opens the mic, up sends, a cancelled release (fn-chord, monitor loss)
  // aborts silently. Tracks its own held flag so an unpaired release (e.g.
  // fn was already down at subscribe time) cannot stop a capture the toggle
  // hotkey or pill started.
  const fnHoldActiveRef = useRef(false);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onHold = (event: Event) => {
      const shell = controllerRef.current;
      if (!shell) return;
      const detail = (event as CustomEvent<PushToTalkHoldDetail>).detail;
      if (!detail || typeof detail.held !== "boolean") return;
      if (detail.held) {
        if (fnHoldActiveRef.current || shell.recording) return;
        if (shell.authGate.gated) {
          if (shell.authGate.phase === "needs-auth") shell.requestSignIn();
          else shell.startRecording("ptt");
          return;
        }
        fnHoldActiveRef.current = true;
        playCaptureStartCue();
        shell.startRecording("ptt");
        return;
      }
      if (!fnHoldActiveRef.current) return;
      fnHoldActiveRef.current = false;
      if (detail.cancelled) {
        shell.cancelRecording();
        return;
      }
      playCaptureSendCue();
      shell.stopRecording();
    };
    document.addEventListener(PUSH_TO_TALK_HOLD_EVENT, onHold);
    return () => document.removeEventListener(PUSH_TO_TALK_HOLD_EVENT, onHold);
  }, []);

  useEffect(() => {
    if (!hasController) return undefined;
    // While the shared mobile sheet is open, its five-state callback owns the
    // exact native frame (including full work-area maximization). The legacy
    // expanded/hover RPC remains the compatibility path for the resting pill.
    if (shouldMountWebChatPanel) return undefined;
    let cancelled = false;
    setShellPreviewHostReady(false);

    void (async () => {
      if (cancelled) return;
      await invokeDesktopBridgeRequestWithTimeout<undefined>({
        rpcMethod: "desktopSetBottomBarExpanded",
        ipcChannel: "desktop:setBottomBarExpanded",
        params: {
          expanded: shellIsOpen && shellHostDetent !== "input",
          hovered:
            useWebChatPanel &&
            (shellPhase === "listening" ||
              (shellIsOpen && shellHostDetent === "input")),
        },
        timeoutMs: 1_000,
      });
      if (
        !cancelled &&
        useWebChatPanel &&
        shellPhase === "listening" &&
        !shellIsOpen
      ) {
        // Paint hover and Fn-listening lanes only after the native host is
        // 600px wide. Before this acknowledgement, wide DOM is clipped through
        // the resting 96px WKWebView and appears as a narrow center slice.
        setShellPreviewHostReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hasController,
    shouldMountWebChatPanel,
    shellHostDetent,
    shellIsOpen,
    shellPhase,
    useWebChatPanel,
  ]);
  useEffect(() => {
    if (!useWebChatPanel || !shellIsOpen || !focusComposerOnOpenRef.current) {
      return;
    }
    focusComposerOnOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-composer-textarea"]',
        )
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shellIsOpen, useWebChatPanel]);
  const openSharedDesktopComposer = useCallback(() => {
    focusComposerOnOpenRef.current = useWebChatPanel;
    if (useWebChatPanel) setShellHostDetent("input");
    controller?.open();
  }, [controller, useWebChatPanel]);
  useEffect(() => {
    if (!useWebChatPanel || typeof window === "undefined") return undefined;
    window.addEventListener(CHAT_OPEN_EVENT, openSharedDesktopComposer);
    return () =>
      window.removeEventListener(CHAT_OPEN_EVENT, openSharedDesktopComposer);
  }, [openSharedDesktopComposer, useWebChatPanel]);
  const closeWebChatWhenPilled = useCallback(
    (pilled: boolean) => {
      if (!pilled) return;
      setKeepChatOpenAfterFirstRun(false);
      controller?.close();
    },
    [controller],
  );
  if (!controller) return null;

  if (shouldMountWebChatPanel) {
    return (
      <ChatOverlayMount
        initialMode="input"
        fillHostAtHalf
        releaseFirstRunToFull={releaseFirstRunToFull}
        retainMountedFirstRunOpen={retainMountedFirstRunOpen}
        onFirstRunReleaseHandled={onFirstRunReleaseHandled}
        onFirstRunChatMounted={onFirstRunChatMounted}
        firstRunMountEpoch={firstRunMountEpoch}
        onPilledChange={closeWebChatWhenPilled}
        onDetentChange={setShellHostDetent}
        onStateChange={syncNativeSurfaceState}
      />
    );
  }

  return (
    <>
      <HomePill
        phase={controller.phase}
        open={controller.isOpen}
        analyser={controller.analyser}
        speaking={controller.speaking}
        signingIn={controller.signingIn}
        onOpen={openSharedDesktopComposer}
        onClose={controller.close}
        onHoldStart={() => {
          if (controller.authGate.gated) {
            if (controller.authGate.phase === "needs-auth") {
              controller.requestSignIn();
            } else {
              controller.startRecording("ptt");
            }
            return;
          }
          // Audible mic-open ping BEFORE capture spins up: the cue is the
          // "start talking" signal, so it must not wait on getUserMedia.
          playCaptureStartCue();
          controller.startRecording("ptt");
        }}
        onHoldEnd={() => {
          if (controller.authGate.gated) return;
          playCaptureSendCue();
          controller.stopRecording();
        }}
        onHoldCancel={controller.cancelRecording}
        showComposerPreview={!useWebChatPanel}
        previewHostReady={!useWebChatPanel || shellPreviewHostReady}
      />
      {!useWebChatPanel ? (
        <AssistantOverlay
          phase={controller.phase}
          onClose={controller.close}
          open={controller.isOpen}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ChatSurface
                messages={controller.messages}
                onSend={controller.send}
                canSend={controller.canSend}
                greeting={greetingForTimeOfDay()}
                recording={controller.recording}
                onToggleRecording={controller.toggleRecording}
                onDictateStart={() => controller.startRecording("dictate")}
                onDictateEnd={controller.stopRecording}
                onVision={controller.captureVision}
                visionActive={controller.visionCapturing}
              />
            </div>
          </div>
        </AssistantOverlay>
      ) : null}
    </>
  );
}

/**
 * Reads the shared shell controller from context and renders the always-present
 * chat overlay — one ambient glass conversation (the app's single
 * active conversation via useShellController) that floats over every view,
 * including the /chat route's ambient home. Returns null until a controller
 * provider is present.
 */
function ChatOverlayMount({
  initialMode,
  fillHostAtHalf = false,
  releaseFirstRunToFull,
  retainMountedFirstRunOpen = false,
  onFirstRunReleaseHandled,
  onFirstRunChatMounted,
  firstRunMountEpoch = null,
  onPilledChange,
  onDetentChange,
  onStateChange,
}: {
  initialMode?: "input" | "half";
  fillHostAtHalf?: boolean;
  releaseFirstRunToFull: boolean;
  retainMountedFirstRunOpen?: boolean;
  onFirstRunReleaseHandled: () => void;
  onFirstRunChatMounted?: (epoch: number) => void;
  firstRunMountEpoch?: number | null;
  onPilledChange?: (pilled: boolean) => void;
  onDetentChange?: (detent: "pill" | "input" | "half" | "full") => void;
  onStateChange?: (state: DesktopBottomBarSurfaceState) => void;
}): ReactNode {
  const controller = useShellControllerContext();
  const { characterData, agentStatus, firstRunComplete, startupPhase } =
    useAppSelectorShallow((s) => ({
      characterData: s.characterData,
      agentStatus: s.agentStatus,
      firstRunComplete: s.firstRunComplete,
      startupPhase: s.startupCoordinator.phase,
    }));
  const firstRunOpen =
    isAuthoritativeFirstRunOpen(firstRunComplete, startupPhase) ||
    (firstRunComplete === false && retainMountedFirstRunOpen);
  // #12087 Item 20: derive the slash-command authority from the authoritative
  // role instead of the fail-open defaults. Elevated (owner-only) commands
  // require OWNER; authenticated commands require rank ≥ USER. A remote
  // USER/GUEST no longer sees elevated commands.
  const { isOwner, atLeast } = useRole();
  const slash = useSlashCommandController({
    isElevated: isOwner,
    isAuthorized: atLeast("USER"),
  });
  useLayoutEffect(() => {
    if (controller && firstRunOpen && firstRunMountEpoch !== null) {
      onFirstRunChatMounted?.(firstRunMountEpoch);
    }
  }, [controller, firstRunMountEpoch, firstRunOpen, onFirstRunChatMounted]);
  if (!controller) return null;
  // The live agent's name drives the composer placeholder ("Ask {name}").
  // Character name wins (what the user configured), then the running agent's
  // reported name; "Eliza" is the default the overlay falls back to.
  const agentName =
    characterData?.name?.trim() || agentStatus?.agentName?.trim() || undefined;
  return (
    <ChatOverlay
      controller={controller}
      agentName={agentName}
      slash={slash}
      initialMode={initialMode}
      fillHostAtHalf={fillHostAtHalf}
      firstRunOpen={firstRunOpen}
      acceptPendingFirstRunText={firstRunComplete}
      releaseFirstRunToFull={releaseFirstRunToFull}
      onFirstRunReleaseHandled={onFirstRunReleaseHandled}
      onPilledChange={onPilledChange}
      onDetentChange={onDetentChange}
      onStateChange={onStateChange}
    />
  );
}

/**
 * The iOS-style home dashboard sits beside the launcher behind the
 * always-present chat overlay. Host-provided tile taps still route through the real nav:
 * builtin tabs via setTab, plugin/remote views via the navigate-view event.
 */
function HomeScreenMount({
  initialSection = "home",
}: {
  initialSection?: "home" | "apps";
}): ReactNode {
  const setTab = useAppSelector((s) => s.setTab);
  const { firstRunComplete, startupPhase } = useAppSelectorShallow((state) => ({
    firstRunComplete: state.firstRunComplete,
    startupPhase: state.startupCoordinator.phase,
  }));
  const firstRunOpen = isAuthoritativeFirstRunOpen(
    firstRunComplete,
    startupPhase,
  );
  // Host apps can override the home screen via the `homeScreen` boot-config slot
  // (whitelabel seam); fall back to the built-in HomeScreen.
  const { homeScreen: HomeScreenOverride } = useBootConfig();
  const onOpenTile = useCallback(
    (target: HomeTileTarget) => {
      if (target.kind === "tab") {
        setTab(target.tab);
      } else {
        dispatchNavigateViewEvent({ viewPath: target.path });
      }
    },
    [setTab],
  );
  const Home = HomeScreenOverride ?? HomeScreen;
  const home = useMemo(
    () => (
      <Home onOpenTile={onOpenTile} showNativeOsTiles={isAospShellEnabled()} />
    ),
    [Home, onOpenTile],
  );
  // The Home↔Apps rail is the demo-facing navigation surface. Keep it scoped
  // to registered runtime views; the dedicated `/apps` page remains the full
  // installable catalog and is where discovery belongs.
  const launcher = useMemo(() => <LauncherSurface catalogMode="demo" />, []);
  // Keep the dashboard warm during first-run, but hide its clock, widgets, and
  // launcher so the onboarding overlay reveals only the shared wallpaper.
  return (
    <div
      aria-hidden={firstRunOpen ? "true" : undefined}
      data-onboarding-hidden={firstRunOpen ? "true" : undefined}
      className={cn(
        "relative min-h-0 min-w-0 flex-1 self-stretch overflow-hidden",
        firstRunOpen && "invisible",
      )}
    >
      <HomeLauncherSurface
        home={home}
        launcher={launcher}
        initialPage={initialSection === "apps" ? "launcher" : "home"}
      />
    </div>
  );
}

function AppContent() {
  const branding = useBranding();
  const {
    startupError,
    startupCoordinator,
    firstRunComplete,
    retryStartup,
    tab,
    setTab,
    setState,
    completeFirstRun,
    setActionNotice,
    actionNotice,
    activeOverlayApp,
    uiTheme,
    backendConnection,
    activeGameViewerUrl,
    gameOverlayEnabled,
    uiShellMode,
    uiLanguage,
    t,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
  } = useAppSelectorShallow((s) => ({
    startupError: s.startupError,
    startupCoordinator: s.startupCoordinator,
    firstRunComplete: s.firstRunComplete,
    retryStartup: s.retryStartup,
    tab: s.tab,
    setTab: s.setTab,
    setState: s.setState,
    completeFirstRun: s.completeFirstRun,
    setActionNotice: s.setActionNotice,
    actionNotice: s.actionNotice,
    activeOverlayApp: s.activeOverlayApp,
    uiTheme: s.uiTheme,
    backendConnection: s.backendConnection,
    activeGameViewerUrl: s.activeGameViewerUrl,
    gameOverlayEnabled: s.gameOverlayEnabled,
    uiShellMode: s.uiShellMode,
    uiLanguage: s.uiLanguage,
    t: s.t,
    elizaCloudConnected: s.elizaCloudConnected,
    elizaCloudLoginBusy: s.elizaCloudLoginBusy,
    elizaCloudLoginError: s.elizaCloudLoginError,
  }));
  const isPopout = useIsPopout();
  const isAuxiliaryAppWindow = isAppWindowRoute();
  const shellMode = useShellMode();
  // Register the developer-only sandboxed-iframe consumer once at boot (#14180),
  // so the level has a shipped, navigable first-party view. Idempotent.
  useEffect(() => {
    registerSandboxProbeView();
  }, []);
  // Auth gate — only active after the coordinator reaches "ready".
  // During first-run setup / pairing / startup phases the StartupScreen handles
  // its own gate (bootstrap step), so we skip the check.
  const isCoordinatorReady = startupCoordinator.phase === "ready";
  // The live shell may MOUNT once the backend is reached and the agent boot is
  // underway (first-run-required / starting-runtime / hydrating / ready) —
  // first-turn capability then fades in behind it (see useShellController's
  // agentReady). first-run-required paints the shell so onboarding can run IN
  // the live chat. Only the truly pre-shell phases (session restore, backend
  // polling, pairing, error) keep the full-screen StartupScreen.
  // Runtime-dependent effects and overlay apps below stay gated on
  // `isCoordinatorReady` and defer safely.
  const isShellPaintableNow = startupCoordinator.isShellPaintable;
  // Cloud-container bootstrap: first-run-required is shell-paintable (in-chat
  // onboarding), but a provisioned container without a bootstrap session must
  // still hold the full-screen StartupScreen so its token gate can run — the
  // shell controller computes the matching `bootstrap` view.
  const firstRunCloudProvisionedContainer = useAppSelector(
    (s) => s.firstRunCloudProvisionedContainer,
  );
  const bootstrapGateHolds = isBootstrapGateRequired(
    startupCoordinator.phase,
    firstRunCloudProvisionedContainer,
  );
  // Runtime-target adoption can remount the shell on the exact render where
  // first-run completes. Retain that completion edge above the remount and let
  // the next ChatOverlay acknowledge it after applying the FULL detent.
  const firstRunChatRelease = useFirstRunChatRelease(
    firstRunComplete,
    startupCoordinator.phase,
  );

  useEffect(() => {
    if (!isShellPaintableNow) return;

    const handleConnect = async (payload: {
      gatewayUrl: string;
      token?: string;
      completeFirstRun?: boolean;
      skipConfirm?: boolean;
    }): Promise<ConnectRequestResult> => {
      const shouldCompleteFirstRun = payload.completeFirstRun === true;
      const skipConfirm = payload.skipConfirm === true;
      if (!skipConfirm && !isLoopbackGatewayHost(payload.gatewayUrl)) {
        const approved = await confirmDesktopAction({
          type: "warning",
          title: "Connect to this server?",
          message: `Point this app at "${gatewayHostForDisplay(payload.gatewayUrl)}"?`,
          detail:
            "A link asked to connect this app to a different agent server. Only continue if you trust it — that server will handle your messages and data.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
        });
        if (!approved) {
          setActionNotice("Connection request cancelled.", "info", 4200);
          return { status: "cancelled" };
        }
      }

      try {
        const connection = applyLaunchConnection({
          kind: "remote",
          apiBase: payload.gatewayUrl,
          token: typeof payload.token === "string" ? payload.token : null,
        });
        persistMobileRuntimeModeForServerTarget("remote");
        setState("firstRunRuntimeTarget", "remote");
        setState("firstRunRemoteApiBase", connection.apiBase);
        setState("firstRunRemoteToken", connection.token ?? "");
        setState("firstRunRemoteError", null);
        if (shouldCompleteFirstRun) {
          await completeRemoteAgentFirstRun(
            client,
            {
              apiBase: connection.apiBase,
              token: connection.token,
              uiLanguage,
            },
            completeFirstRun,
          );
        }
        setState("firstRunRemoteConnected", true);
        setActionNotice("Connected to remote backend.", "success", 4200);
        retryStartup();
        return { status: "connected" };
      } catch (err) {
        // error-policy:J1 expose failed adoption to both the initiating form and shell notice.
        const message =
          err instanceof Error
            ? err.message
            : "Failed to connect remote backend.";
        setState("firstRunRemoteConnected", false);
        setState("firstRunRemoteError", message);
        setActionNotice(message, "error", 8000);
        return { status: "failed", message };
      }
    };

    return listenForConnectRequests(handleConnect);
  }, [
    completeFirstRun,
    isShellPaintableNow,
    retryStartup,
    setActionNotice,
    setState,
    uiLanguage,
  ]);

  const isAgentlessCloudOrigin =
    typeof window !== "undefined" &&
    isTrustedHostedCloudOnboardingBase(
      window.location.origin,
      branding.cloudOnly === true,
    );

  // Existing remote backends still probe during first-run so a real 401 can
  // surface their password wall. The shared Cloud app defers that probe because
  // its in-chat first-run conductor owns Cloud sign-in; its same-origin 401 is
  // not evidence that this browser is on a dedicated agent host.
  const { state: authState, refetch: refetchAuth } = useAuthStatus({
    skip:
      !isShellPaintableNow ||
      isPopout ||
      (isAgentlessCloudOrigin &&
        firstRunOwnsLoginSurface(startupCoordinator.phase, firstRunComplete)),
  });
  // A retry from the auth-unavailable screen restarts the entire startup
  // coordinator. During that restart the shell's default chat tab can commit
  // `/chat` before the requested deep route remounts, discarding the user's
  // return intent (observed after OAuth on `/cloud/agents`). Capture only a
  // same-origin relative location and restore it once both startup and auth are
  // ready. Fragments are excluded on normal web hosts so an OAuth callback
  // code can never be retained by this recovery seam.
  const authStartupRetryReturnLocationRef = useRef<string | null>(null);
  const retryAuthStartup = useCallback(() => {
    if (typeof window !== "undefined") {
      const navigationPath = getWindowNavigationPath();
      authStartupRetryReturnLocationRef.current = isRouteRootPath(
        navigationPath,
      )
        ? null
        : shouldUseHashNavigation()
          ? `${window.location.pathname}${window.location.search}${window.location.hash}`
          : `${window.location.pathname}${window.location.search}`;
    }
    refetchAuth();
    retryStartup();
  }, [refetchAuth, retryStartup]);
  useEffect(() => {
    if (
      startupCoordinator.phase !== "ready" ||
      authState.phase !== "authenticated"
    ) {
      return;
    }
    const returnLocation = authStartupRetryReturnLocationRef.current;
    if (!returnLocation || typeof window === "undefined") return;
    authStartupRetryReturnLocationRef.current = null;
    const currentLocation = shouldUseHashNavigation()
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : `${window.location.pathname}${window.location.search}`;
    if (currentLocation === returnLocation) return;
    shellHistory.replaceState(null, "", returnLocation);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [authState.phase, startupCoordinator.phase]);
  // The first-run chat must survive its completion edge. Completion starts an
  // auth probe, but replacing the already-painted shell with StartupScreen
  // remounts ChatOverlay and loses its first-run -> FULL transition state. Remember
  // only a shell painted while first-run owned the login surface, and forget
  // it as soon as that probe resolves so a later credential refetch still
  // returns to the startup/auth boundary instead of exposing the shell.
  const onboardingShellMountedRef = useRef(false);
  const firstRunOwnsAuthSurface = firstRunOwnsLoginSurface(
    startupCoordinator.phase,
    firstRunComplete,
  );
  // Only a committed shell may authorize this exception. A render-time ref
  // write survives an interrupted render and could otherwise let a later auth
  // probe expose shell providers even though onboarding never painted. Layout
  // effects run before a user can complete the mounted onboarding UI, so the
  // prior committed first-run frame is recorded before its completion edge.
  useLayoutEffect(() => {
    if (
      isShellPaintableNow &&
      !bootstrapGateHolds &&
      firstRunOwnsAuthSurface &&
      firstRunChatRelease.mountedOnboarding
    ) {
      onboardingShellMountedRef.current = true;
    } else if (authState.phase !== "loading") {
      onboardingShellMountedRef.current = false;
    }
  }, [
    authState.phase,
    bootstrapGateHolds,
    firstRunOwnsAuthSurface,
    firstRunChatRelease.mountedOnboarding,
    isShellPaintableNow,
  ]);
  const preserveMountedOnboardingShell =
    onboardingShellMountedRef.current &&
    firstRunComplete === true &&
    authState.phase === "loading";
  // #15132: after a dedicated cloud agent's container upgrade the persisted
  // agent credential is stale (every agent-subdomain call 401s) while the cloud
  // session is still valid. Rather than dead-end at the agent's internal
  // password wall (a credential no cloud user has), transparently re-run the
  // pairing exchange to refresh the credential. Only fires for a cloud-managed
  // dedicated agent WITH a valid cloud session. Managed native failures retain
  // their classification (reauth, retry, or management); self-hosted failures
  // retain the password wall.
  const agentSessionRecoveryStatus = useAgentSessionRecovery({
    active: authState.phase === "unauthenticated",
    reason:
      authState.phase === "unauthenticated" ? authState.reason : undefined,
    onRecovered: refetchAuth,
  });
  // Don't initialize the 3D scene while the system is still booting — this
  // prevents VrmEngine's Three.js setup from blocking the JS thread and
  // delaying WebSocket agent-status updates (which would freeze the loader).
  const overlayAppActive =
    startupCoordinator.phase === "ready" && activeOverlayApp !== null;
  const resolvedOverlayApp =
    overlayAppActive && activeOverlayApp
      ? getOverlayApp(activeOverlayApp)
      : undefined;
  const overlayAppSurfaceActive = Boolean(resolvedOverlayApp);
  const contextMenu = useContextMenu();
  const cloudPairToken = getCloudPairTokenFromLocation();
  const isElizaCloudHosted = isElizaCloudHostedLocation();
  const activeAgentProfile = useAppSelector((s) => s.activeAgentProfile);
  const handleCloudLoginRecovery = useAppSelector(
    (s) => s.handleCloudLoginRecovery,
  );
  const showCloudAgentReauthNotice = shouldShowCloudAgentReauthNotice({
    isHostedLocation: isElizaCloudHosted,
    isNative,
    activeServer: activeAgentProfile,
    recoveryStatus:
      agentSessionRecoveryStatus === "idle" ||
      agentSessionRecoveryStatus === "recovering"
        ? null
        : agentSessionRecoveryStatus,
  });
  const nativeCloudRecoveryMode =
    agentSessionRecoveryStatus === "cloud-retry-required"
      ? "retry"
      : agentSessionRecoveryStatus === "cloud-manage-required"
        ? "manage"
        : "reauth";
  const recoverManagedNativeAgent = useCallback(async () => {
    if (nativeCloudRecoveryMode === "retry") {
      window.location.reload();
      return;
    }
    if (nativeCloudRecoveryMode === "manage") {
      await openExternalUrl(resolveCloudHostedAgentUrl());
      return;
    }
    const rejectedCloudToken = getCloudAuthToken();
    // Deliberate non-interactive same-tab recovery: native hosted re-auth has
    // no popup, so it must go through the separately named recovery entry
    // point — never the interactive one (which would open a second window)
    // and never the raw null-window path (which is unrepresentable from the
    // app surface, #17129).
    await handleCloudLoginRecovery({
      requireClientAuth: true,
      forceReauth: true,
    });
    const refreshedCloudToken = getCloudAuthToken();
    if (!refreshedCloudToken || refreshedCloudToken === rejectedCloudToken) {
      throw new Error(
        "Eliza Cloud sign-in did not complete. Please try again.",
      );
    }
    window.location.reload();
  }, [handleCloudLoginRecovery, nativeCloudRecoveryMode]);
  const retryManagedNativeAgent = useCallback(async () => {
    window.location.reload();
  }, []);

  useSecretsManagerShortcut();

  // Warm a small, device-aware subset of lazy route chunks once the shell is
  // ready. The scheduler itself skips hidden/low-memory/save-data sessions.
  useEffect(() => {
    if (startupCoordinator.phase !== "ready" || typeof window === "undefined") {
      return;
    }
    return scheduleRouteViewChunkPrefetch();
  }, [startupCoordinator.phase]);

  useEffect(() => {
    if (!isCoordinatorReady || isPopout || shellMode !== "full") return;
    if (!isRouteRootPath(getWindowNavigationPath())) return;
    setTab("chat");
  }, [isCoordinatorReady, isPopout, setTab, shellMode]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer-textarea"]',
      );
      if (!composer) return;
      event.preventDefault();
      composer.focus();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (startupCoordinator.phase !== "ready") return;
    if (backendConnection?.state !== "connected") return;

    const report = (appName: string | null) => {
      void fetchWithCsrf("/api/apps/overlay-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName }),
      }).catch(() => {
        /* ignore */
      });
    };

    if (activeOverlayApp === null) {
      report(null);
      return;
    }

    report(activeOverlayApp);
    const intervalId = window.setInterval(
      () => report(activeOverlayApp),
      25_000,
    );
    return () => {
      window.clearInterval(intervalId);
      report(null);
    };
  }, [activeOverlayApp, backendConnection?.state, startupCoordinator.phase]);

  const [customActionsPanelOpen, setCustomActionsPanelOpen] = useState(false);
  const [customActionsEditorOpen, setCustomActionsEditorOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    string | null
  >(null);
  const [settingsNavigatePayload, setSettingsNavigatePayload] =
    useState<unknown>(undefined);
  const [settingsNavigateSequence, setSettingsNavigateSequence] = useState(0);

  // Desktop tab bar — persisted pinned tabs for the Electrobun shell.
  const {
    tabs: desktopTabs,
    openTab: openDesktopTab,
    closeTab: closeDesktopTab,
  } = useDesktopTabs();
  const [activeDesktopTabId, setActiveDesktopTabId] = useState<string | null>(
    null,
  );
  const { views: availableViewsForDesktopTabs } = useRoutableViews();
  const [viewLayout, setViewLayout] = useState<ActiveViewLayout | null>(null);
  const navigationPath = useCurrentNavigationPath();
  const enabledKinds = useEnabledViewKinds();
  const managedCloudRuntime = isManagedCloudRuntime(startupCoordinator.target);
  const resolvedDynamicPage = useResolvedDynamicPage(tab);
  const activeDynamicPage = visibleDynamicPage(
    resolvedDynamicPage,
    enabledKinds,
    managedCloudRuntime,
  )
    ? resolvedDynamicPage
    : null;
  const { authenticated: cloudAuthenticated, user: cloudUser } =
    useSessionAuth();
  const agentAuthority = useActiveAgentAuthority();
  // Account management is authorized by the Cloud session, independently of
  // the selected agent. Keep its wake/recovery controls reachable while that
  // agent is asleep, disconnected, or awaiting pairing.
  const authenticatedAccountPage = authenticatedCloudDashboardOwnsRoute(
    findVisibleAppShellPageForRoute(
      navigationPath,
      enabledKinds,
      managedCloudRuntime,
    ),
    cloudAuthenticated,
  );
  const screenBackgroundPolicy = useActiveScreenBackgroundPolicy({
    tab,
    navigationPath,
    availableViews: availableViewsForDesktopTabs,
    dynamicPage: activeDynamicPage,
    viewLayout,
  });
  const renderSharedAppBackground =
    screenBackgroundPolicy === "shared" && !overlayAppSurfaceActive;
  const renderOpaqueAppBackground =
    screenBackgroundPolicy === "opaque" || overlayAppSurfaceActive;

  // In-process host-realm isolation (#14179). Resolve the active view's surface
  // manifest from the same registry as the background, then publish one broker
  // scope per active view: storage/navigation gated on the manifest's grants,
  // and the view's global root/body-class + `:root`-var mutations reset on
  // teardown so nothing a view injected into the host realm survives into the
  // next view. `resolveSurfaceManifest` stays the single policy source.
  const activeViewSurface = useActiveViewSurface({
    tab,
    navigationPath,
    availableViews: availableViewsForDesktopTabs,
    dynamicPage: activeDynamicPage,
    viewLayout,
    enabledKinds,
    managedCloudRuntime,
    cloudAuthenticated,
  });
  // Browser history is the authoritative active-view lifecycle. Synchronizing
  // here covers every route producer uniformly: launcher tiles, chat/voice
  // navigation, command palette, deep links, Back/Forward, reload, and desktop
  // tabs. Controls only navigate; the shell reports the surface that actually
  // rendered, and Home/launcher routes clear all scoped tools.
  useEffect(() => {
    if (startupCoordinator.phase !== "ready") return;
    if (backendConnection?.state !== "connected") return;
    if (overlayAppSurfaceActive) return;
    if (shouldClearReportedView(navigationPath)) {
      reportUserViewClosed();
      return;
    }
    reportUserViewSwitch(
      resolveBuiltinTabId(activeViewSurface.viewId),
      navigationPath,
    );
  }, [
    activeViewSurface.viewId,
    backendConnection?.state,
    navigationPath,
    overlayAppSurfaceActive,
    startupCoordinator.phase,
  ]);
  const authScopeKey =
    authState.phase === "authenticated"
      ? JSON.stringify({
          phase: authState.phase,
          identity: authState.identity?.id,
          session: authState.session?.id,
          access: authState.access,
        })
      : authState.phase;
  // Equal presentation metadata must not retain a scope across a different
  // route, runtime, principal, session, or authorization policy.
  const scopeLifetime = useMemo(
    () => ({
      surface: activeViewSurface,
      navigationPath,
      agentAuthority,
      authScopeKey,
      cloudAuthenticated,
      cloudUserId: cloudUser?.id,
      managedCloudRuntime,
    }),
    [
      activeViewSurface,
      navigationPath,
      agentAuthority,
      authScopeKey,
      cloudAuthenticated,
      cloudUser?.id,
      managedCloudRuntime,
    ],
  );
  // Publish before DynamicViewLoader's passive bundle-import effect captures
  // host externals, so a new view cannot bind the previous view's scope.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const scope = new SurfaceRealmScope(
      scopeLifetime.surface.manifest,
      scopeLifetime.surface.viewId,
      window.localStorage,
      navigateBrowserPath,
      [
        scopeLifetime.surface.viewId,
        ...(scopeLifetime.surface.memberViewIds ?? []),
        ...(scopeLifetime.surface.children?.map((child) => child.viewId) ?? []),
      ],
    );
    setActiveSurfaceRealmScope(scope);
    return () => {
      scope.resetHostRealm();
      setActiveSurfaceRealmScope(null);
    };
  }, [scopeLifetime]);

  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [desktopShuttingDown, setDesktopShuttingDown] = useState(false);

  const isChat = tab === "chat";
  const isSettingsPage = tab === "settings";
  const isWalletPage = tab === "inventory";
  // Readability scrim over the shared wallpaper for every content view that is
  // NOT an immersive wallpaper surface (chat/background and the launcher roots
  // design directly against the wallpaper); derived from the builtin-tab
  // registry so the immersive set has one owner.
  const wallpaperScrimActive = !isImmersiveWallpaperRoute(
    tab,
    trimmedNavigationPath(navigationPath),
  );
  const isFullBleed =
    useTabIsFullBleed(tab) ||
    activeViewSurface.manifest.header === "fullscreen" ||
    activeViewSurface.manifest.header === "immersive";

  // Keep hook order stable across first-run/auth state transitions.
  // Otherwise React can throw when first-run setup completes and the main shell mounts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setCustomActionsPanelOpen((v) => !v);
    window.addEventListener("toggle-custom-actions-panel", handler);
    return () =>
      window.removeEventListener("toggle-custom-actions-panel", handler);
  }, []);

  const handleEditorSave = useCallback(() => {
    setCustomActionsEditorOpen(false);
    setEditingAction(null);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleFocusConnector = (event: Event) => {
      const detail = (event as CustomEvent<FocusConnectorEventDetail>).detail;
      if (!detail?.connectorId) return;
      const id = detail.connectorId.trim().toLowerCase();
      setSettingsInitialSection(
        id ? `connectors/${id === "twitter" ? "x" : id}` : "connectors",
      );
      setTab("settings");
    };
    document.addEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
    return () =>
      document.removeEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
  }, [setTab]);

  // Slash-command settings navigation (e.g. `/settings model`): open the
  // settings tab focused on the requested section (or the hub when absent).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigateSettings = (event: Event) => {
      const detail = (event as CustomEvent<NavigateSettingsDetail>).detail;
      setSettingsInitialSection(detail?.section ?? null);
      setTab("settings");
    };
    window.addEventListener(NAVIGATE_SETTINGS_EVENT, handleNavigateSettings);
    return () =>
      window.removeEventListener(
        NAVIGATE_SETTINGS_EVENT,
        handleNavigateSettings,
      );
  }, [setTab]);

  // Handle agent-dispatched view navigation events.
  // The VIEWS action (and future agent commands) dispatch this event to navigate
  // the user to a specific view by path or view ID.
  // When the target is "/views" or "/apps" (legacy launcher aliases), we also
  // directly set the tab so the nav bar becomes visible.
  // On desktop, also open the view as a desktop tab if desktopTabEnabled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const baseHandler = createNavigateViewHandler({
      availableViewsForDesktopTabs,
      closeDesktopTab,
      desktopTabs,
      invokeDesktopBridgeRequest,
      openDesktopTab,
      setActiveDesktopTabId,
      setTab,
      setTabForPath: (routeTab) => setTab(routeTab, { history: "preserve" }),
      setViewLayout,
    });
    // An agent-dispatched navigate to the Settings view that carries a `subview`
    // deep-links a section. Route it through the same settings state the
    // slash-command path uses (initialSection + #hash) instead of the generic
    // path nav, which would drop the requested section.
    // Returns whether the request was actually applied — this is the
    // canonical, single-owner handler `listenForNavigateViewRequests` claims
    // the intent for, so an accurate `true`/`false` here (not just "was
    // invoked") is what lets a cold-boot Android deep link only get
    // acknowledged once its navigation genuinely landed (see events/index.ts).
    const handleNavigateView = (event: Event): boolean => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (
        detail?.subview &&
        (detail.viewId === "settings" || detail.viewPath === "/settings")
      ) {
        console.debug(
          `[SettingsNavigate] routing subview "${detail.subview}" to SettingsView initialSection`,
        );
        setSettingsInitialSection(detail.subview);
        setSettingsNavigatePayload(detail.payload);
        setSettingsNavigateSequence((sequence) => sequence + 1);
        setTab("settings");
        markCompletedActionNavigationHandled(event, detail);
        return true;
      }
      const handled = baseHandler(event);
      if (handled) {
        markCompletedActionNavigationHandled(event, detail);
      }
      return handled;
    };
    return listenForNavigateViewRequests(handleNavigateView);
  }, [
    setTab,
    availableViewsForDesktopTabs,
    closeDesktopTab,
    desktopTabs,
    openDesktopTab,
  ]);

  useEffect(() => {
    if (tab !== "views" && viewLayout) {
      setViewLayout(null);
    }
  }, [tab, viewLayout]);

  useEffect(() => {
    if (isSettingsPage || settingsInitialSection === null) {
      return;
    }
    setSettingsInitialSection(null);
  }, [isSettingsPage, settingsInitialSection]);

  useEffect(() => {
    if (!isNative || !isIOS) {
      return;
    }

    // Dynamic import keeps @capacitor/keyboard (a native-only, devDependency
    // plugin) out of the static module graph, so server consumers that pull in
    // the @elizaos/ui barrel (e.g. plugin-inbox in the Node agent image) don't
    // crash trying to resolve a package that's only installed for mobile.
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => Keyboard.setScroll({ isDisabled: true }))
      .catch(() => {
        // Ignore bridge failures so web and desktop shells keep working.
      });
  }, []);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "desktopShutdownStarted",
      ipcChannel: "desktop:shutdownStarted",
      listener: () => {
        setDesktopShuttingDown(true);
      },
    });
  }, []);

  // Handle desktop tab navigation: clicking a tab navigates to its path.
  // Closing the active tab falls back to the chat view.
  const handleDesktopTabClick = useCallback(
    (viewId: string) => {
      const dtab = desktopTabs.find((t) => t.viewId === viewId);
      if (!dtab) return;
      setViewLayout(null);
      setActiveDesktopTabId(viewId);
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = dtab.path;
        } else {
          shellHistory.pushState(null, "", dtab.path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      } catch {
        // sandboxed — ignore
      }
    },
    [desktopTabs],
  );

  const handleDesktopTabClose = useCallback(
    (viewId: string) => {
      setViewLayout(null);
      closeDesktopTab(viewId);
      if (activeDesktopTabId === viewId) {
        setActiveDesktopTabId(null);
        setTab("chat");
      }
    },
    [closeDesktopTab, activeDesktopTabId, setTab],
  );

  const handleOpenViewManagerFromTabBar = useCallback(() => {
    setViewLayout(null);
    setTab("views");
  }, [setTab]);

  const handleClearViewLayout = useCallback(() => {
    setViewLayout(null);
  }, []);

  // desktopTabBar is computed here (after handlers) so the memo below can
  // reference a stable value. Rendered inside each shell variant, not at the
  // outer level, so Header + TabBar + content stack correctly per shell.
  const desktopTabBar = (
    <DesktopTabBar
      tabs={desktopTabs}
      activeViewId={activeDesktopTabId}
      onTabClick={handleDesktopTabClick}
      onTabClose={handleDesktopTabClose}
      onOpenViewManager={handleOpenViewManagerFromTabBar}
    />
  );

  const bugReport = useBugReportState();
  // Loading is handled entirely by StartupScreen.

  const androidCloudAuthAutoStart = isAndroidCloudBuild();
  const cloudAuthFirstScreenOwnsSurface =
    androidCloudAuthAutoStart &&
    shellMode === "full" &&
    !isPopout &&
    !isAuxiliaryAppWindow &&
    !cloudPairToken &&
    (cloudAuthFirstScreenOwnsHost({
      cloudOnlyBranding: branding.cloudOnly === true,
      isAgentlessCloudOrigin,
      isNative,
      isDesktopShell: isElectrobunRuntime(),
    }) ||
      (isNative &&
        ((isAndroidCloudBuild() && branding.cloudOnly !== false) ||
          isElizaCloudRuntimeLocked())));
  const hasUsableCloudSession =
    elizaCloudConnected ||
    hasUsableStoredStewardToken() ||
    (typeof window !== "undefined" && hasStewardAuthedCookie());
  const startCloudAuthFirstScreen = useCallback(async () => {
    if (firstRunComplete !== true) {
      markCloudAuthFirstScreenGreeting();
    }
    try {
      await handleCloudLoginRecovery({ requireClientAuth: true });
    } catch (error) {
      clearCloudAuthFirstScreenGreeting();
      throw error;
    }
  }, [firstRunComplete, handleCloudLoginRecovery]);
  const cloudAuthAutoStartedRef = useRef(false);
  useEffect(() => {
    if (
      !androidCloudAuthAutoStart ||
      !cloudAuthFirstScreenOwnsSurface ||
      hasUsableCloudSession ||
      elizaCloudLoginBusy ||
      elizaCloudLoginError ||
      cloudAuthAutoStartedRef.current
    ) {
      return;
    }
    cloudAuthAutoStartedRef.current = true;
    void startCloudAuthFirstScreen().catch(() => {
      // error-policy:J4 the full-screen retry surface renders the hook's error.
    });
  }, [
    androidCloudAuthAutoStart,
    cloudAuthFirstScreenOwnsSurface,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    hasUsableCloudSession,
    startCloudAuthFirstScreen,
  ]);
  useEffect(() => {
    // Safety-net watchdog: the coordinator has its own timeouts per phase, but
    // this catches any edge case where the coordinator gets stuck in a loading
    // phase. During "starting-runtime" the agent-wait loop has its own sliding
    // deadline (up to 900s for embedding downloads), so we only watch the
    // pre-runtime phases.
    const STARTUP_TIMEOUT_MS = 300_000;
    const coordinatorPolling =
      startupCoordinator.phase === "polling-backend" ||
      startupCoordinator.phase === "restoring-session";
    if (coordinatorPolling && !startupError) {
      const timer = setTimeout(() => {
        startupCoordinator.retry();
      }, STARTUP_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [startupCoordinator.phase, startupError, startupCoordinator.retry]);

  // shellContent is memoized before early returns to satisfy the Rules of Hooks.
  // Deps are local state/callbacks — not high-frequency AppContext fields like
  // ptySessions/agentStatus — so the shell subtree stays stable across polls.
  const shellContent = useMemo(
    () => (
      <ShellContent
        actionNotice={actionNotice}
        availableViewsForLayout={availableViewsForDesktopTabs}
        cloudAuthenticated={cloudAuthenticated}
        customActionsPanelOpen={customActionsPanelOpen}
        desktopTabBar={desktopTabBar}
        isChat={isChat}
        isFullBleed={isFullBleed}
        screenBackgroundPolicy={screenBackgroundPolicy}
        setCustomActionsEditorOpen={setCustomActionsEditorOpen}
        setCustomActionsPanelOpen={setCustomActionsPanelOpen}
        setEditingAction={setEditingAction}
        settingsInitialSection={settingsInitialSection}
        settingsNavigatePayload={settingsNavigatePayload}
        settingsNavigateSequence={settingsNavigateSequence}
        tab={tab}
        uiShellMode={uiShellMode}
        viewLayout={viewLayout}
        onClearViewLayout={handleClearViewLayout}
      />
    ),
    [
      tab,
      uiShellMode,
      actionNotice,
      isChat,
      isFullBleed,
      screenBackgroundPolicy,
      customActionsPanelOpen,
      settingsInitialSection,
      settingsNavigatePayload,
      settingsNavigateSequence,
      desktopTabBar,
      availableViewsForDesktopTabs,
      cloudAuthenticated,
      viewLayout,
      handleClearViewLayout,
    ],
  );

  // Pop-out mode — render only StreamView, skip startup gates.
  // Platform init is skipped in main.tsx; AppProvider hydrates WS in background.
  if (isPopout) {
    return (
      <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-bg font-body text-txt">
        <LazyViewBoundary>
          <LazyStreamView />
        </LazyViewBoundary>
      </div>
    );
  }

  // Hosted Cloud agent handoff: `/pair?token=X` must never fall through to the
  // local password auth screen. The server-side relay owns the happy path, but
  // this protects stale/edge-hosted SPA fallbacks by exchanging the token in the
  // browser and then reloading the agent root with the paired API key pinned.
  if (cloudPairToken) {
    return (
      <BugReportProvider value={bugReport}>
        <CloudPairRelay token={cloudPairToken} />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Self-driving voice round-trip test screen — runs the real STT->agent->TTS
  // loop against a known phrase and reports PASS/FAIL with no human in the loop.
  // Self-contained (its own ElizaClient + AudioContext); no app chrome / gate.
  if (shellMode === "voice-selftest") {
    return <VoiceSelfTestShell />;
  }

  // Multi-turn voice SCENARIO player — drives a declarative VoiceScenario through
  // the real STT->agent->TTS loop turn-by-turn and reports a per-turn verdict.
  // Self-contained (its own ElizaClient + AudioContext); no app chrome / gate.
  if (shellMode === "voice-workbench") {
    return <VoiceWorkbenchShell />;
  }

  // Android's Cloud build owns its native auth startup surface. Web and Mac
  // keep first run inside the normal Eliza chat overlay so sign-in remains a
  // deliberate conversational choice instead of replacing the whole app.
  if (cloudAuthFirstScreenOwnsSurface && !hasUsableCloudSession) {
    return (
      <BugReportProvider value={bugReport}>
        {elizaCloudLoginError ? (
          <CloudSignInRecoveryView
            detail={elizaCloudLoginError}
            onRetry={() => {
              void startCloudAuthFirstScreen().catch(() => {
                // error-policy:J4 the same retry surface receives the error.
              });
            }}
          />
        ) : (
          <StartupShell
            view={{
              kind: "loading",
              phase: "initializing-agent",
              status: "Opening secure sign in…",
            }}
            onRetry={() => {
              void startCloudAuthFirstScreen();
            }}
          />
        )}
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // OS chat-overlay window — render JUST the floating assistant pill +
  // waveform over a transparent background, no app chrome and no blocking
  // StartupScreen gate. The desktop bottom bar boots straight into this branch
  // (createMainWindow appends ?shellMode=chat-overlay), so a fresh install's
  // FIRST surface is this overlay — the in-chat first-run conductor must mount
  // here too (#9952/#10720): while firstRunComplete is false it seeds the
  // onboarding greeting + choices into the SAME live transcript the overlay
  // renders. The hook self-gates on firstRunComplete, so after onboarding (and
  // on any plain web ?shellMode=chat-overlay load) it is a headless no-op.
  if (shellMode === "chat-overlay") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <ChatOverlayShell
            releaseFirstRunToFull={firstRunChatRelease.releasePending}
            retainMountedFirstRunOpen={firstRunChatRelease.mountedOnboarding}
            onFirstRunReleaseHandled={firstRunChatRelease.acknowledgeRelease}
            onFirstRunChatMounted={firstRunChatRelease.recordMountedOverlay}
            firstRunMountEpoch={firstRunChatRelease.mountEpoch}
          />
          <FirstRunConductorMount
            onFirstRunTranscriptMounted={
              firstRunChatRelease.recordMountedTranscript
            }
            firstRunMountEpoch={firstRunChatRelease.mountEpoch}
            firstRunAuthorityEpoch={firstRunChatRelease.authorityEpoch}
          />
          <ModelStatusConductorMount />
          <BootRecoveryConductorMount />
          <ShellOverlays actionNotice={actionNotice} />
        </ShellControllerProvider>
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Native tray popover window — render JUST the widget surface, no app chrome
  // or onboarding gate. The native tray anchors this transparent, always-on-top
  // window beside its icon (#9953 Phase 4).
  if (shellMode === "tray-popover") {
    return (
      <BugReportProvider value={bugReport}>
        <TrayPopoverShell />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  if (
    !authenticatedAccountPage &&
    (!isShellPaintableNow || bootstrapGateHolds)
  ) {
    return (
      <BugReportProvider value={bugReport}>
        <StartupScreen />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Auth gate — once the shell is paintable, keep poll-heavy shell hooks
  // unmounted until /api/auth/me resolves for returning sessions.
  // "unauthenticated": render LoginView. "authenticated": proceed.
  // "server_unavailable": show a retryable startup failure.
  // Restored sessions usually arrive here already decided: the restore phase
  // primes the probe (primeAuthStatusProbe) so it overlaps backend polling /
  // hydration instead of serializing an extra round-trip after first paint.
  if (
    !authenticatedAccountPage &&
    isShellPaintableNow &&
    !isPopout &&
    topLevelAuthGateOwnsSurface(
      startupCoordinator.phase,
      firstRunComplete,
      authState.phase,
      isAgentlessCloudOrigin,
    )
  ) {
    if (
      authProbeShouldHoldShell(
        startupCoordinator.phase,
        firstRunComplete,
        authState.phase,
        preserveMountedOnboardingShell,
      )
    ) {
      return (
        <BugReportProvider value={bugReport}>
          <StartupScreen />
          <BugReportModal />
        </BugReportProvider>
      );
    }
    if (authState.phase === "server_unavailable") {
      return (
        <BugReportProvider value={bugReport}>
          <StartupFailureView
            error={{
              reason: "backend-unreachable",
              phase: "starting-backend",
              message: "Backend became unavailable after startup.",
              detail:
                "The auth probe could not reach /api/auth/me. If this is local development, start the local agent API with `bun run dev` or `bun run dev:desktop`, then retry.",
            }}
            onRetry={() => {
              // This screen is triggered by the AUTH probe failing
              // (useAuthStatus publishes `server_unavailable` after its 10×1s
              // retry budget), so `retryStartup()` alone is a no-op here —
              // the startup coordinator is already in a ready/hydrating phase
              // whose reducer has no RETRY arm. Re-probe auth so a transient
              // outage (agent restart, phone network blip) actually recovers,
              // and still kick the startup retry for the mixed case.
              retryAuthStartup();
            }}
          />
          <BugReportModal />
        </BugReportProvider>
      );
    }
    if (authState.phase === "unauthenticated") {
      // #15132: a stale post-upgrade agent credential with a valid cloud session
      // is recoverable, so hold the startup surface while the re-pair runs (it
      // navigates through `/pair` on web or installs the bearer in-process on
      // native) instead of flashing the password wall. Managed failures expose
      // an actionable Cloud recovery surface; only self-hosted failures render
      // the owner-password form.
      if (agentSessionRecoveryStatus === "recovering") {
        return (
          <BugReportProvider value={bugReport}>
            <StartupScreen />
            <BugReportModal />
          </BugReportProvider>
        );
      }
      if (
        shouldShowRemoteAgentPairingGate({
          reason: authState.reason,
          access: authState.access,
        })
      ) {
        return (
          <BugReportProvider value={bugReport}>
            <PairingView />
            <BugReportModal />
          </BugReportProvider>
        );
      }
      return (
        <BugReportProvider value={bugReport}>
          <AgentAuthGateSurface
            showCloudReauth={showCloudAgentReauthNotice}
            nativeRecoveryMode={nativeCloudRecoveryMode}
            onNativeReauth={isNative ? recoverManagedNativeAgent : undefined}
            onNativeRetry={isNative ? retryManagedNativeAgent : undefined}
            onLoginSuccess={() => {
              // A successful owner-password login proves this is an existing,
              // initialized backend. Clear the stale unauthenticated browser's
              // optimistic first-run state before remounting the shell.
              setState("authRequired", false);
              setState("firstRunComplete", true);
              // Login can surface from either pairing-required or
              // first-run-required. RETRY is the shared transition back into
              // authenticated session restoration.
              startupCoordinator.dispatch({ type: "RETRY" });
              refetchAuth();
            }}
            reason={authState.reason}
          />
          <BugReportModal />
        </BugReportProvider>
      );
    }
    // The loading phase is handled above so the shell's poll-heavy hooks never
    // mount until the session is known.
  }

  // OS kiosk window — the locked appliance shell: a fullscreen in-window
  // view-manager canvas plus an always-visible bottom chat pill. No app
  // chrome, no tabs. The pill is enabled here regardless of web/native gating.
  if (shellMode === "kiosk") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <KioskShell />
        </ShellControllerProvider>
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // The app shell renders once paintable (the agent may still be warming up —
  // the chat composer queues sends until first-turn capability fades in; views
  // show their own loading states until the runtime is live). No deprecated
  // first-run overlays — the coordinator handled all of that before this point.

  return (
    <BugReportProvider value={bugReport}>
      <ShellControllerProvider>
        <div
          // SAFE-AREA FILL INVARIANT (do not break): this root stays
          // `position: relative` ONLY. It must NEVER acquire compositor,
          // filter, perspective, or containment declarations. Any of those
          // makes this element the containing block for the fixed background
          // layers below (the opaque `app-opaque-background` underlay and the
          // `AppBackground` wallpaper), so instead of anchoring to the viewport
          // they would anchor to this padded box (top = safe-area-top) — leaving
          // an unfilled band under the notch (the WKWebView host color, brand
          // orange, would show through). Keeping the backgrounds viewport-fixed
          // is what lets every view fill edge-to-edge under the notch while the
          // `paddingTop` below keeps CONTENT notch-aware. Locked by
          // App.safe-area-fill.test.ts.
          //
          // The base height is `h-[100dvh]` (correct for a desktop browser tab /
          // popout). In the installed PWA the styles.css standalone blocks fill
          // #root AND this column (`[data-app-shell-root]`) to 100dvh — the full
          // screen, since the non-fixed body no longer collapses the viewport —
          // so the app paints full-bleed to the physical bottom edge. The
          // home-indicator safe area is padded INSIDE the app (the floating
          // composer clears it), so background content bleeds under the
          // indicator, native-app style.
          data-app-shell-root=""
          className="relative flex h-[100dvh] w-full max-w-full flex-col overflow-hidden"
          // The OS inset is protected space, not decorative padding to trim.
          // Settings and Wallet own the inset inside their scrolling headers;
          // Home and other non-immersive views receive it once at this shared
          // boundary. Home's wallpaper remains a separate full-bleed layer.
          style={{
            paddingTop:
              (isFullBleed && !isChat) || isSettingsPage || isWalletPage
                ? 0
                : "var(--safe-area-top, 0px)",
            paddingLeft: "var(--safe-area-left, 0px)",
            paddingRight: "var(--safe-area-right, 0px)",
          }}
        >
          {/* BOTTOM-BAR / SAFE-AREA FLOOR (do not remove): a viewport-filling
              floor mounted on EVERY route, behind the shader (z-0) and every
              other layer. html/body/#root paint the orange launch guard
              (--launch-bg #ef5a1f) as a FOUC color; this floor guarantees the
              bottom inset (and every unpainted zone) reads as the BACKGROUND
              token, never the accent, regardless of route or shader state.

              Standalone-PWA bottom-bar fix: on SHARED-background routes
              (home/chat) this floor must be TRANSPARENT, not an opaque `bg-bg`
              slab. The wallpaper (`AppBackground` -> `ImageBackground`, a
              `fixed inset-0` full-bleed layer that reaches the true viewport
              bottom incl. the home-indicator safe-area) is what should show
              beneath the floating composer, edge-to-edge (lockscreen/iMessage
              style). An opaque floor here painted a dark near-black band in the
              home-indicator zone under the floating composer even though the
              wallpaper sits above it. Going transparent on wallpaper routes
              lets the full-bleed wallpaper own the whole screen down to the
              bottom edge; the FOUC/orange guard is still covered because the
              wallpaper layer is opaque cover-fit. On OPAQUE/overlay routes (no
              wallpaper) the floor keeps `bg-bg` so the orange guard never
              shows. */}
          <div
            aria-hidden="true"
            data-testid="app-safe-area-floor"
            className={cn(
              // `fixed inset-0` with a non-fixed body → its containing block is
              // the true viewport, so `bottom: 0` reaches the physical screen
              // edge (no ICB collapse, no reclaim).
              "pointer-events-none fixed inset-0 z-[-1]",
              // Transparent under the full-bleed wallpaper so it shows to the
              // very bottom edge; opaque dark elsewhere as the FOUC guard.
              renderSharedAppBackground ? "bg-transparent" : "bg-bg",
            )}
          />
          {/* The unified app background, mounted once here so it persists
              seamlessly across shared-background routes. It keeps the
              background event channel mounted for the whole session, but only
              renders the visual wallpaper when the active route opts into the
              Home/Launcher background. */}
          {/* One glass stylesheet + refraction defs per document; every
              eliza-glass-* surface (menus, cards, pills) resolves here. */}
          <GlassStyles />
          <AppBackground visible={renderSharedAppBackground} />
          {/* Readability scrim for text-dense shared-background views. It sits
              between the wallpaper (z-0) and content (z-10) and covers safe
              areas too. A THEME-AWARE frosted veil (bg/75 + blur), not a fixed
              black wash: view copy renders in theme tokens, so the veil must
              pull toward the theme surface for text to stay legible on any
              wallpaper in both light and dark. The wallpaper reads through as
              a tint; the immersive surfaces (chat, /background, launcher
              roots) stay unscrimmed by design. Opaque or overlay-app routes
              use the plain underlay instead, so the wallpaper cannot leak
              through. */}
          {renderSharedAppBackground && wallpaperScrimActive ? (
            <div
              aria-hidden="true"
              data-testid="app-background-scrim"
              className="pointer-events-none fixed inset-0 z-[1] bg-bg/75 backdrop-blur-2xl"
            />
          ) : null}
          {renderOpaqueAppBackground ? (
            <div
              aria-hidden="true"
              data-testid="app-opaque-background"
              className="pointer-events-none fixed inset-0 z-0 bg-bg"
            />
          ) : null}
          <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col">
            <SystemWarningBanner />
            {shellContent}
          </div>
        </div>
        {/* Full-screen overlay app — renders whichever overlay app is active */}
        {resolvedOverlayApp ? (
          <OverlayAppSurface
            app={resolvedOverlayApp}
            exitToApps={() => {
              setState("activeOverlayApp", null);
              setTab("apps");
            }}
            uiTheme={uiTheme === "dark" ? "dark" : "light"}
            t={t}
          />
        ) : null}

        {/* Persistent game overlay — stays visible across all tabs */}
        {activeGameViewerUrl &&
          gameOverlayEnabled &&
          tab !== "apps" &&
          tab !== "views" && <GameViewOverlay />}
        {/*
          Chat overlay (ChatOverlay) — one ambient glass conversation in the
          primary shell. Native auxiliary app windows (`?appWindow=1`) are
          dedicated workspaces; mounting another onboarding-pinned overlay in
          each of them occludes their controls and duplicates the headless chat
          conductors already owned by the primary/chat-overlay window.
        */}
        {!isAuxiliaryAppWindow ? (
          <>
            <ChatOverlayMount
              releaseFirstRunToFull={firstRunChatRelease.releasePending}
              retainMountedFirstRunOpen={firstRunChatRelease.mountedOnboarding}
              onFirstRunReleaseHandled={firstRunChatRelease.acknowledgeRelease}
              onFirstRunChatMounted={firstRunChatRelease.recordMountedOverlay}
              firstRunMountEpoch={firstRunChatRelease.mountEpoch}
            />
            {/* In-chat first-run conductor (headless) — while firstRunComplete
                is false it seeds the onboarding greeting + choices into the
                SAME live transcript the overlay renders and routes first-run
                picks to the headless finish use case. Renders null. */}
            <FirstRunConductorMount
              onFirstRunTranscriptMounted={
                firstRunChatRelease.recordMountedTranscript
              }
              firstRunMountEpoch={firstRunChatRelease.mountEpoch}
              firstRunAuthorityEpoch={firstRunChatRelease.authorityEpoch}
            />
            {/* In-chat model-status card (headless) — while the local text
                model is downloading/loading/missing/errored it seeds ONE live
                status turn with cancel / switch-to-cloud / retry controls. */}
            <ModelStatusConductorMount />
            {/* In-chat boot-recovery card (headless) — a stalled boot or a
                failed dedicated-agent handoff seeds ONE live turn with
                re-log-in / try-again / retry-setup controls. */}
            <BootRecoveryConductorMount />
            {/* In-chat tutorial conductor (headless) — narrates one live
                transcript turn per step in the primary conversation only. */}
            <TutorialConductorMount />
          </>
        ) : null}
        {/* Post-login permission priming: a one-time soft-ask modal that walks
            the user through the platform's onboarding permission set (voice,
            location, notifications) BEFORE any OS prompt. Self-gates on
            authenticated + firstRunComplete !== false + no active tutorial, so
            it never collides with the in-chat first-run conductor. Renders null
            when not eligible; re-triggerable from Settings → Permissions. */}
        <PermissionPrimingOverlay />
        {/* Headless notification wiring: boots the notification store (hydrate
            + live stream) and sends every "open notifications" entry point
            (menu/tray/deep-link) to the dashboard, where
            NotificationsHomeCenter is the one in-app notification surface.
            Native platforms may still raise their OS notification. */}
        <NotificationsShellBoot />
        {/* Tiny dismissible build stamp (bottom-left) so testers can verify
            PWA cache freshness at a glance. Best-effort: hidden when
            /build-info.json is absent (production builds without the
            build-time stamp render nothing). */}
        <BuildBadge />
        {/* On-screen voice-capture trace (stamped builds only) so a
            "tapped the mic, then crickets" report is diagnosable from a phone
            screenshot instead of the devtools console the installed PWA lacks.
            Sibling of BuildBadge; renders nothing without /build-info.json. */}
        <VoiceCaptureHud />
        <ShellOverlays actionNotice={actionNotice} />
        <SaveCommandModal
          open={contextMenu.saveCommandModalOpen}
          text={contextMenu.saveCommandText}
          onSave={contextMenu.confirmSaveCommand}
          onClose={contextMenu.closeSaveCommandModal}
        />
        <SecretsManagerModalMount />
        <CustomActionEditor
          open={customActionsEditorOpen}
          action={editingAction}
          onSave={handleEditorSave}
          onClose={() => {
            setCustomActionsEditorOpen(false);
            setEditingAction(null);
          }}
        />
        <ConnectionLostOverlay />
        {desktopShuttingDown ? (
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-bg/80 "
            role="status"
            aria-live="polite"
          >
            <div className="rounded-sm border border-border/60 bg-card/95 px-6 py-5 text-center ">
              <div className="text-base font-semibold text-txt">
                Shutting down…
              </div>
              <div className="mt-1 text-sm text-muted">
                Closing services and saving state.
              </div>
            </div>
          </div>
        ) : null}
      </ShellControllerProvider>
    </BugReportProvider>
  );
}

export function App() {
  return (
    <>
      {import.meta.env.DEV && <DeveloperTabHost />}
      <NotificationsDataBoot />
      <AppContent />
    </>
  );
}
