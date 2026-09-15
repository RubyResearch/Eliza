/**
 * Verifies rendered App navigation with deterministic service/page fixtures.
 * Launcher-back cases compose the real AppProvider navigation hooks, history,
 * and surface-realm guards; older event cases retain their tab spy.
 */
// @vitest-environment jsdom

/**
 * Unit coverage for App-level navigate-view event wiring: a dispatched
 * navigate-view event drives the tab switch through the rendered shell. Boot
 * config + desktop tabs mocked, no runtime.
 */

import { Capacitor } from "@capacitor/core";
import type { PluginAppNavTab } from "@elizaos/core";
import {
  createNavigateViewEvent,
  NAVIGATE_VIEW_EVENT,
} from "@elizaos/shared/events";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentButton, getViewRegistry } from "./agent-surface";
import { registerAppShellPage } from "./app-shell-registry";
import { ViewBackButton } from "./components/shared/ViewHeader";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "./config/boot-config";
import { DEFAULT_BRANDING } from "./config/branding-base";
import { BrandingContext } from "./config/branding-react.hooks";
import type { AuthStatusState } from "./hooks/useAuthStatus";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import {
  getWindowNavigationPath,
  resolveInitialTabForPath,
  type Tab,
} from "./navigation";
import { resetUiRegistryHostForTests } from "./registry-host";
import { useNavigationPathSync } from "./state/useAppProviderEffects";
import { useNavigationState } from "./state/useNavigationState";
import {
  getActiveSurfaceRealmScope,
  SurfaceRealmDeniedError,
} from "./surface-realm-broker";
import { shellHistory } from "./surface-realm-channel";

const NavigationHarnessContext = React.createContext<{
  tab: Tab;
  setTab: ReturnType<typeof useNavigationState>["setTab"];
  navigation: ReturnType<typeof useNavigationState>["navigation"];
} | null>(null);

function AppWithRealNavigation() {
  // Match AppProvider's actual state + navigation composition. No test event
  // listener or manual rerender may stand in for the production path sync.
  const [tab, setTabRaw] = React.useState<Tab>(() =>
    resolveInitialTabForPath(getWindowNavigationPath(), "chat"),
  );
  const [, setAppsSubTab] = React.useState<"browse" | "running" | "games">(
    "browse",
  );
  const { setTab, navigation } = useNavigationState({
    tab,
    setTabRaw,
    uiShellMode: "native",
    hasActiveGameRun: false,
    setAppsSubTab,
  });
  useNavigationPathSync({ tab, setTabRaw });
  return (
    <NavigationHarnessContext.Provider value={{ tab, setTab, navigation }}>
      <App />
    </NavigationHarnessContext.Provider>
  );
}

const appState = vi.hoisted(() => ({
  backendConnectionState: "connected",
  firstRunComplete: true,
  retryStartup: vi.fn(),
  setTab: vi.fn(),
  startupPhase: "ready",
  tab: "chat",
  plugins: [] as Array<{
    id: string;
    app?: { navTabs?: PluginAppNavTab[] };
  }>,
}));

const authStatusMock = vi.hoisted(() => ({
  phase: "authenticated" as
    | "authenticated"
    | "unauthenticated"
    | "server_unavailable",
  refetch: vi.fn(),
  use: vi.fn(),
}));

const authenticatedAuthStatus = vi.hoisted(
  () =>
    ({
      phase: "authenticated",
      identity: {
        id: "test-user",
        displayName: "Test User",
        kind: "owner",
      },
      session: {
        id: "test-session",
        kind: "local",
        expiresAt: null,
      },
      access: {
        mode: "local",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    }) satisfies AuthStatusState,
);

const cloudSessionState = vi.hoisted(() => ({
  authenticated: false,
}));

const desktopTabsMock = vi.hoisted(() => ({
  closeTab: vi.fn(),
  openTab: vi.fn(),
}));

const desktopTabsState = vi.hoisted(() => ({
  tabs: [] as Array<{
    viewId: string;
    label: string;
    path: string;
    icon?: string;
    pinned: boolean;
  }>,
}));

const mediaQueryState = vi.hoisted(() => ({
  matches: false,
}));

const electrobunRuntimeState = vi.hoisted(() => ({
  enabled: true,
}));

const desktopBridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
  // The bottom-bar shell (useBarSurfaceWindows) imports these desktop-window
  // helpers; the whole-module mock must define them. The open-window flow under
  // test calls invokeDesktopBridgeRequest directly, so plain stubs suffice here.
  openDesktopAppWindow: vi.fn(async () => ({ id: "window-1" })),
  openDesktopLauncherWindow: vi.fn(async () => ({ id: "launcher-1" })),
}));

const dynamicViewLoaderMock = vi.hoisted(() => ({
  render: vi.fn(
    ({
      bundleUrl,
      frameUrl,
      surface,
      viewId,
      viewType,
    }: {
      bundleUrl?: string;
      frameUrl?: string;
      surface?: {
        capabilities?: string[];
        header?: string;
        isolation?: string;
      };
      viewId: string;
      viewType?: string;
    }) => (
      <div
        data-bundle-url={bundleUrl ?? ""}
        data-frame-url={frameUrl ?? ""}
        data-surface-capabilities={surface?.capabilities?.join(",") ?? ""}
        data-testid="dynamic-view-loader"
        data-view-id={viewId}
        data-view-type={viewType ?? ""}
      />
    ),
  ),
}));

const settingsViewMock = vi.hoisted(() => ({
  render: vi.fn(
    (_props: {
      initialSection?: string;
      navigatePayload?: unknown;
      navigateSequence?: number;
    }) => <div data-testid="settings-view" />,
  ),
}));

const remoteLedgerView = {
  id: "remote-ledger",
  label: "Remote Ledger",
  available: true,
  pluginName: "@local/plugin-ledger",
  path: "/apps/remote-ledger",
  bundleUrl: "/api/views/remote-ledger/bundle.js",
  viewType: "gui" as const,
};

const viewsManagerView = {
  id: "views-manager",
  label: "View Manager",
  available: true,
  pluginName: "@elizaos/plugin-app-control",
  path: "/views",
  bundleUrl: "/api/views/views-manager/bundle.js",
  viewType: "gui" as const,
};

const projectBoardView = {
  id: "project-board",
  label: "Project Board",
  available: true,
  pluginName: "@local/plugin-project-board",
  path: "/apps/project-board",
  bundleUrl: "/api/views/project-board/bundle.js",
  viewType: "gui" as const,
};

const projectBoardAgentSurfaceView = {
  ...projectBoardView,
  surface: { capabilities: ["agent-surface" as const] },
};

const calendarView = {
  id: "calendar",
  label: "Calendar",
  available: true,
  pluginName: "@elizaos/plugin-calendar",
  path: "/calendar",
  bundleUrl: "/api/views/calendar/bundle.js",
  viewType: "gui" as const,
};

const notesFullscreenView = {
  id: "notes",
  label: "Notes",
  available: true,
  pluginName: "@elizaos/plugin-notes",
  path: "/notes",
  bundleUrl: "/api/views/notes/bundle.js",
  surface: { header: "fullscreen" as const },
  viewType: "gui" as const,
};

const modalView = {
  id: "modal-tool",
  label: "Modal Tool",
  available: true,
  pluginName: "@local/plugin-modal-tool",
  path: "/apps/modal-tool",
  bundleUrl: "/api/views/modal-tool/bundle.js",
  surface: { header: "modal" as const },
  viewType: "gui" as const,
};

const sharedCanvasView = {
  id: "shared-canvas",
  label: "Shared Canvas",
  available: true,
  pluginName: "@elizaos/plugin-shared-canvas",
  path: "/shared-canvas",
  bundleUrl: "/api/views/shared-canvas/bundle.js",
  viewType: "gui" as const,
  // Sharing the Home/Launcher wallpaper is grant-gated (#13452): the surface
  // manifest must declare `background: "shared"` AND the `wallpaper`
  // capability. A bare `backgroundPolicy: "shared"` resolves to opaque by
  // design (no view opts into the wallpaper by accident).
  surface: {
    background: "shared" as const,
    capabilities: ["wallpaper"] as const,
  },
};

const documentsView = {
  id: "documents",
  label: "Knowledge",
  available: true,
  pluginName: "@elizaos/plugin-documents",
  path: "/documents",
  bundleUrl: "/api/views/documents/bundle.js",
  viewType: "gui" as const,
};

const walletMarketView = {
  id: "wallet-market-test",
  label: "Wallet Market Test",
  available: true,
  pluginName: "@local/plugin-wallet-market",
  path: "/wallet-market-test",
  bundleUrl: "/api/views/wallet-market-test/bundle.js",
  viewType: "gui" as const,
};

const sandboxedFrameView = {
  id: "sandboxed-frame",
  label: "Sandboxed Frame",
  available: true,
  pluginName: "@elizaos/plugin-sandboxed-frame",
  path: "/apps/sandboxed-frame",
  frameUrl: "/api/views/sandboxed-frame/frame.html",
  surface: { isolation: "sandboxed-iframe" as const },
  viewType: "gui" as const,
};

const mockAvailableViews: ViewRegistryEntry[] = [
  remoteLedgerView,
  viewsManagerView,
  projectBoardView,
  calendarView,
  sharedCanvasView,
  documentsView,
];

function resetMockAvailableViews() {
  mockAvailableViews.splice(
    0,
    mockAvailableViews.length,
    remoteLedgerView,
    viewsManagerView,
    projectBoardView,
    calendarView,
    sharedCanvasView,
    documentsView,
  );
}

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));

vi.mock("./bridge/electrobun-rpc", () => desktopBridgeMock);

vi.mock("./bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => electrobunRuntimeState.enabled,
}));

vi.mock("./platform/init", () => ({
  isDesktopPlatform: () => false,
  isIOS: false,
  isNative: false,
  isStandalonePwa: () => false,
  isWebPlatform: () => true,
}));

vi.mock("./hooks/useDesktopTabs", () => ({
  useDesktopTabs: () => ({
    tabs: desktopTabsState.tabs,
    closeTab: desktopTabsMock.closeTab,
    openTab: desktopTabsMock.openTab,
  }),
}));

vi.mock("./hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({
    views: mockAvailableViews,
  }),
  useRoutableViews: () => ({
    views: mockAvailableViews,
  }),
}));

vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: (options: { skip?: boolean } = {}) => {
    authStatusMock.use(options);
    return {
      state:
        authStatusMock.phase === "authenticated"
          ? authenticatedAuthStatus
          : { phase: authStatusMock.phase },
      refetch: authStatusMock.refetch,
    };
  },
  // Home widgets gate their loaders on this (#11084); the mounted App renders
  // them, so the mock must export it alongside useAuthStatus.
  useIsAuthenticated: () => authStatusMock.phase === "authenticated",
  // notification-store reads auth state outside React to gate its boot probe and
  // re-arm hydration once a session lands (initNotifications -> requestHydration,
  // #16242); the mounted App runs that one-time boot effect, so the mock must
  // export both seams. Auth phase is static in these tests, so the re-arm
  // subscription never fires — returning a no-op unsubscribe is faithful.
  isAuthenticatedNow: () => authStatusMock.phase === "authenticated",
  // notification-store also keys its inbox authority off the full snapshot
  // (computeAuthorityKey in initNotifications, #18495), so the mock exposes the
  // same static phase in AuthStatusState shape.
  getAuthStatusSnapshot: () =>
    authStatusMock.phase === "authenticated"
      ? authenticatedAuthStatus
      : { phase: "unauthenticated" },
  subscribeAuthStatus: () => vi.fn(),
}));

vi.mock("./cloud/lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: cloudSessionState.authenticated,
    user: cloudSessionState.authenticated
      ? { id: "cloud-user", email: "cloud@example.test" }
      : null,
  }),
}));

vi.mock("./first-run/use-first-run-conductor", () => ({
  FirstRunConductorMount: () => <div data-testid="first-run-conductor-mount" />,
  surfaceCloudLoginRetryTurn: vi.fn(),
  useFirstRunConductor: vi.fn(),
}));

vi.mock("./hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQueryState.matches,
}));

vi.mock("./hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));

vi.mock("./hooks", () => ({
  BugReportProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useOptionalBugReport: () => null,
  useBugReportState: () => ({}),
  useContextMenu: () => ({
    closeSaveCommandModal: vi.fn(),
    confirmSaveCommand: vi.fn(),
    saveCommandModalOpen: false,
    saveCommandText: "",
  }),
  useMediaQuery: () => mediaQueryState.matches,
  useRenderGuard: vi.fn(),
}));

vi.mock("./state", async () => {
  // Pure static constants pass through from the real leaf module (side-effect
  // free by design) so the mock never drifts from product preset data.
  const { ACCENT_PRESETS } = await vi.importActual<
    typeof import("./state/ui-preferences")
  >("./state/ui-preferences");
  // Rebuilt on each access so `appState.tab`/`setTab` are read LIVE — the
  // navigation tests mutate appState between renders, and useApp / the selector
  // hooks must reflect that (mirrors the original fresh-object-per-call mock).
  const getAppValue = () => ({
    actionNotice: null,
    activeGameRunId: "",
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    appRuns: [],
    appsSubTab: "browse",
    agentStatus: null,
    backendConnection: { state: appState.backendConnectionState },
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: appState.firstRunComplete,
    firstRunName: "",
    ownerName: "Test Owner",
    plugins: appState.plugins,
    retryStartup: appState.retryStartup,
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    setTab: appState.setTab,
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    setUiThemeMode: vi.fn(),
    startupCoordinator: {
      phase: appState.startupPhase,
      isShellPaintable: [
        "first-run-required",
        "starting-runtime",
        "hydrating",
        "ready",
      ].includes(appState.startupPhase),
      retry: vi.fn(),
    },
    startupError: null,
    systemWarnings: [],
    tab: appState.tab,
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
    uiLanguage: "en",
    uiShellMode: "default",
    uiTheme: "light",
    uiThemeMode: "system",
  });
  function useAppValue() {
    const navigation = React.useContext(NavigationHarnessContext);
    return { ...getAppValue(), ...navigation };
  }
  return {
    ACCENT_PRESETS,
    useApp: useAppValue,
    useAppSelector: <T,>(
      selector: (s: ReturnType<typeof useAppValue>) => T,
    ): T => selector(useAppValue()),
    useAppSelectorShallow: <T,>(
      selector: (s: ReturnType<typeof useAppValue>) => T,
    ): T => selector(useAppValue()),
  };
});

vi.mock("./config/boot-config-react.hooks", () => ({
  useBootConfig: () => ({}),
}));

vi.mock("./components/shell/ShellControllerContext", () => ({
  ShellControllerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useShellControllerContext: () => ({
    canSend: true,
    close: vi.fn(),
    messages: [],
    open: vi.fn(),
    phase: "idle",
    recording: false,
    send: vi.fn(),
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    waveformMode: "idle",
  }),
}));

vi.mock("./components/views/DynamicViewLoader", () => ({
  DynamicViewLoader: dynamicViewLoaderMock.render,
}));

vi.mock("./components/shell/BugReportModal", () => ({
  BugReportModal: () => null,
}));

vi.mock("./components/shell/ChatSurface", () => ({
  ChatSurface: () => <div data-testid="chat-surface" />,
}));

vi.mock("./components/shell/HomePill", () => ({
  HomePill: () => <button type="button">home pill</button>,
}));

vi.mock("./components/shell/AssistantOverlay", () => ({
  AssistantOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="assistant-overlay">{children}</div>
  ),
}));

vi.mock("./components/shell/SystemWarningBanner", () => ({
  SystemWarningBanner: () => null,
}));

vi.mock("./components/shell/ShellOverlays", () => ({
  ShellOverlays: () => null,
}));

vi.mock("./components/chat/SaveCommandModal", () => ({
  SaveCommandModal: () => null,
}));

vi.mock("./components/pages/ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
  __resetCompanionSpeechMemoryForTests: vi.fn(),
}));

vi.mock("./components/pages/SettingsView", () => ({
  SettingsView: (props: {
    initialSection?: string;
    navigatePayload?: unknown;
    navigateSequence?: number;
  }) => settingsViewMock.render(props),
}));

vi.mock("./components/character/CharacterEditor", () => ({
  CharacterEditor: ({ initialPage }: { initialPage?: string }) => (
    <div
      data-initial-page={initialPage ?? ""}
      data-testid={
        initialPage === "documents" ? "documents-view" : "character-editor"
      }
    />
  ),
}));

vi.mock("./components/pages/LauncherSurface", () => ({
  LauncherSurface: () => <div data-testid="launcher-surface" />,
}));

vi.mock("./widgets/WidgetHost", () => ({
  WidgetHost: () => <div data-testid="home-widget-host" />,
}));

vi.mock("./components/settings/SecretsManagerSection", () => ({
  VaultModal: () => null,
}));

vi.mock("./components/custom-actions/CustomActionEditor", () => ({
  CustomActionEditor: () => null,
}));

vi.mock("./components/shell/ConnectionLostOverlay", () => ({
  ConnectionLostOverlay: () => null,
}));

vi.mock("./hooks/useSecretsManagerShortcut", () => ({
  useSecretsManagerShortcut: vi.fn(),
}));

vi.mock("./hooks/useIsDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

import { App } from "./App";
import { navigateBackToLauncher } from "./components/shared/ViewHeader";

function navigateView(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(createNavigateViewEvent(detail));
  });
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function setWindowLocation(url: string): void {
  const parsed = new URL(url);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
      toString: () => parsed.href,
    },
  });
}

describe("App navigate-view event wiring", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?shellMode=chat-overlay");
    // The post-onboarding permission-priming modal (#12331) arms on a mounted
    // App with first-run complete and covers the surfaces under test — mark it
    // already shown.
    window.localStorage.setItem("eliza:permissions-primed", "1");
    window.localStorage.removeItem("steward_session_token");
    setBootConfig(DEFAULT_BOOT_CONFIG);
    Reflect.deleteProperty(window, "__ELIZAOS_API_BASE__");
    Reflect.deleteProperty(window, "__ELIZA_API_TOKEN__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_TOKEN__");
    appState.firstRunComplete = true;
    appState.backendConnectionState = "connected";
    appState.startupPhase = "ready";
    appState.tab = "chat";
    appState.plugins = [];
    authStatusMock.phase = "authenticated";
    cloudSessionState.authenticated = false;
    mediaQueryState.matches = false;
    electrobunRuntimeState.enabled = true;
    desktopTabsState.tabs = [];
    resetMockAvailableViews();
    appState.setTab.mockClear();
    appState.retryStartup.mockClear();
    authStatusMock.use.mockClear();
    authStatusMock.refetch.mockClear();
    desktopTabsMock.openTab.mockClear();
    desktopTabsMock.closeTab.mockClear();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockClear();
    desktopBridgeMock.subscribeDesktopBridgeEvent.mockClear();
    dynamicViewLoaderMock.render.mockClear();
    settingsViewMock.render.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetUiRegistryHostForTests();
    vi.unstubAllGlobals();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  async function mountedRemoteNavigation() {
    mockAvailableViews[0] = {
      ...remoteLedgerView,
      surface: { capabilities: ["navigate"] },
    };
    appState.tab = "views";
    window.history.replaceState(null, "", remoteLedgerView.path);
    const rendered = render(<App />);
    await waitFor(() =>
      expect(getActiveSurfaceRealmScope()?.viewId).toBe(remoteLedgerView.id),
    );
    const actual = await vi.importActual<
      typeof import("./components/views/DynamicViewLoader")
    >("./components/views/DynamicViewLoader");
    const external = await actual.hostImport("@elizaos/ui/app-navigate-view");
    const navigate = external.navigateBrowserPath;
    if (typeof navigate !== "function")
      throw new Error("Host navigation external is unavailable");
    return { rendered, navigate };
  }

  it("keeps a mounted remote view's real navigation handle through an equivalent registry refresh", async () => {
    const { rendered, navigate } = await mountedRemoteNavigation();
    await act(async () => {
      mockAvailableViews[0] = {
        ...mockAvailableViews[0],
        surface: { capabilities: ["navigate"] },
      };
      registerAppShellPage({
        id: "unrelated-refresh",
        pluginId: "@test/refresh",
        label: "Refresh",
        path: "/refresh",
        Component: () => null,
      });
    });
    rendered.rerender(<App />);
    act(() => navigate("/settings"));
    expect(window.location.pathname).toBe("/settings");
  });

  it.each(["view", "policy", "bundle", "plugin"] as const)(
    "revokes a mounted remote handle after actual %s replacement",
    async (change) => {
      const { rendered, navigate } = await mountedRemoteNavigation();
      await act(async () => {
        if (change === "view") {
          appState.tab = "settings";
          shellHistory.replaceState(null, "", "/settings");
          window.dispatchEvent(new PopStateEvent("popstate"));
        } else {
          mockAvailableViews[0] = {
            ...mockAvailableViews[0],
            ...(change === "policy" ? { surface: { capabilities: [] } } : {}),
            ...(change === "bundle"
              ? { bundleUrl: "/api/views/replacement/bundle.js" }
              : {}),
            ...(change === "plugin" ? { pluginName: "@test/replacement" } : {}),
          };
        }
        registerAppShellPage({
          id: "replacement-refresh",
          pluginId: "@test/refresh",
          label: "Refresh",
          path: "/refresh",
          Component: () => null,
        });
      });
      rendered.rerender(<App />);
      expect(() => navigate("/inventory")).toThrow(SurfaceRealmDeniedError);
      expect(window.location.pathname).not.toBe("/inventory");
      if (change === "view") {
        appState.tab = "views";
        shellHistory.replaceState(null, "", remoteLedgerView.path);
        window.dispatchEvent(new PopStateEvent("popstate"));
        rendered.rerender(<App />);
        expect(() => navigate("/inventory")).toThrow(SurfaceRealmDeniedError);
      }
    },
  );

  it.each(["component", "loader"] as const)(
    "revokes old host navigation after registered %s replacement",
    async (change) => {
      const First = () => <div>Original owned page</div>;
      const Second = () => <div>Replacement owned page</div>;
      const registration = {
        id: "owned-host",
        pluginId: "@test/owned-host",
        label: "Owned host",
        path: "/apps/owned-host",
        surface: { capabilities: ["navigate"] as const },
        ...(change === "component"
          ? { Component: First }
          : { loader: async () => ({ default: First }) }),
      };
      registerAppShellPage(registration);
      appState.tab = "views";
      window.history.replaceState(null, "", "/apps/owned-host");
      const rendered = render(<AppWithRealNavigation />);
      await waitFor(() =>
        expect(getActiveSurfaceRealmScope()?.viewId).toBe("owned-host"),
      );
      const actual = await vi.importActual<
        typeof import("./components/views/DynamicViewLoader")
      >("./components/views/DynamicViewLoader");
      const external = await actual.hostImport("@elizaos/ui/app-navigate-view");
      const navigate = external.navigateBrowserPath;
      if (typeof navigate !== "function")
        throw new Error("Host navigation external is unavailable");
      await act(async () => {
        registerAppShellPage({
          ...registration,
          ...(change === "component"
            ? { Component: Second }
            : { loader: async () => ({ default: Second }) }),
        });
      });
      rendered.rerender(<AppWithRealNavigation />);
      expect(() => navigate("/inventory")).toThrow(SurfaceRealmDeniedError);
      expect(window.location.pathname).toBe("/apps/owned-host");
    },
  );

  it.each(["base", "credential"] as const)(
    "revokes a remote handle on actual client %s authority replacement",
    async (change) => {
      const { client: actualClient } = await import("./api/client");
      const previousBase = actualClient.getBaseUrl();
      const previousToken = actualClient.getRestAuthToken();
      actualClient.setBaseUrl("http://127.0.0.1:49181");
      actualClient.setToken("synthetic-scope-owner-a");
      const { navigate } = await mountedRemoteNavigation();
      try {
        await act(async () => {
          if (change === "base")
            actualClient.setBaseUrl("http://127.0.0.1:49182");
          else actualClient.setToken("synthetic-scope-owner-b");
        });
        expect(() => navigate("/inventory")).toThrow(SurfaceRealmDeniedError);
        expect(window.location.pathname).not.toBe("/inventory");
      } finally {
        cleanup();
        actualClient.setBaseUrl(previousBase);
        actualClient.setToken(previousToken);
      }
    },
  );

  it("keeps the exact branded staging Pages alias inside first-run onboarding", () => {
    window.history.replaceState(null, "", "/?shellMode=full");
    setWindowLocation("https://develop.eliza-app.pages.dev/?shellMode=full");
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";
    authStatusMock.phase = "unauthenticated";
    window.localStorage.setItem(
      "steward_session_token",
      "existing-steward-session",
    );

    render(
      <BrandingContext.Provider
        value={{ ...DEFAULT_BRANDING, cloudOnly: true }}
      >
        <App />
      </BrandingContext.Provider>,
    );

    expect(authStatusMock.use).toHaveBeenCalledWith(
      expect.objectContaining({ skip: true }),
    );
    expect(screen.getByTestId("first-run-conductor-mount")).toBeTruthy();
    expect(screen.queryByText("Open this agent from Eliza Cloud")).toBeNull();
  });

  it.each([
    ["unbranded Pages alias", "https://develop.eliza-app.pages.dev/", false],
    ["arbitrary branded self-host", "https://agent.example.com/", true],
  ])("keeps the App auth gate for an %s", (_name, origin, cloudOnly) => {
    window.history.replaceState(null, "", "/?shellMode=full");
    setWindowLocation(`${origin}?shellMode=full`);
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";
    authStatusMock.phase = "unauthenticated";
    window.localStorage.setItem(
      "steward_session_token",
      "existing-steward-session",
    );

    render(
      <BrandingContext.Provider value={{ ...DEFAULT_BRANDING, cloudOnly }}>
        <App />
      </BrandingContext.Provider>,
    );

    expect(authStatusMock.use).toHaveBeenCalledWith(
      expect.objectContaining({ skip: false }),
    );
    expect(screen.queryByTestId("first-run-conductor-mount")).toBeNull();
  });

  it("restores a deep route after an auth-startup retry commits the default chat path", async () => {
    window.history.replaceState(null, "", "/cloud/agents");
    authStatusMock.phase = "server_unavailable";

    const rendered = render(<App />);
    fireEvent.click(screen.getByTestId("startup-retry"));

    expect(authStatusMock.refetch).toHaveBeenCalledTimes(1);
    expect(appState.retryStartup).toHaveBeenCalledTimes(1);

    // Reproduce the startup shell's intermediate default-tab commit observed
    // in the real hosted browser before auth/startup settle.
    shellHistory.replaceState(null, "", "/chat");
    authStatusMock.phase = "authenticated";
    rendered.rerender(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/cloud/agents");
    });
  });

  it("routes view-manager events through the mounted App listener", async () => {
    render(<App />);

    navigateView({ viewPath: "/views" });
    navigateView({ viewId: "views-manager", viewType: "gui" });

    await waitFor(() => {
      expect(appState.setTab).toHaveBeenCalledWith("views");
    });
    expect(appState.setTab).toHaveBeenCalledTimes(2);
    expect(desktopTabsMock.openTab).not.toHaveBeenCalled();
  });

  it("preserves plugin nav surface layout as the active cross-host contract", async () => {
    appState.plugins = [
      {
        id: "@local/plugin-layout",
        app: {
          navTabs: [
            {
              id: "plugin-layout",
              label: "Plugin layout",
              path: "/plugin-layout",
              surface: {
                header: "fullscreen",
                layout: {
                  kind: "workspace",
                  width: "full",
                  scroll: "view",
                },
              },
            },
          ],
        },
      },
    ];
    appState.tab = "plugin-layout";
    window.history.replaceState(null, "", "/plugin-layout");

    render(<App />);

    await waitFor(() => {
      expect(getActiveSurfaceRealmScope()?.viewId).toBe("plugin-layout");
    });
    expect(getActiveSurfaceRealmScope()?.manifest.layout).toEqual({
      kind: "workspace",
      topology: "framed",
      width: "full",
      scroll: "view",
    });
    const frame = document.querySelector('[data-page-kind="workspace"]');
    expect(frame?.getAttribute("data-page-width")).toBe("full");
    expect(frame?.getAttribute("data-scroll-owner")).toBe("view");
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });

  it("renders inventory with one shell-owned page-frame scroller", async () => {
    appState.tab = "inventory";
    window.history.replaceState(null, "", "/wallet");

    const { container } = render(<App />);

    await waitFor(() => {
      expect(
        container.querySelector('[data-scroll-owner="shell"]'),
      ).not.toBeNull();
    });
    expect(container.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(
      container
        .querySelector('[data-scroll-owner="shell"]')
        ?.className.includes("overflow-y-auto"),
    ).toBe(true);
  });

  it("renders Files with its canonical shell-owned page scroller", async () => {
    appState.tab = "files";
    window.history.replaceState(null, "", "/apps/files");

    const { container } = render(<App />);

    await waitFor(() => {
      expect(
        container.querySelector('[data-page-kind="content"]'),
      ).not.toBeNull();
    });
    const frame = container.querySelector('[data-page-kind="content"]');
    expect(frame?.getAttribute("data-page-width")).toBe("standard");
    expect(frame?.getAttribute("data-scroll-owner")).toBe("shell");
    expect(
      frame
        ?.querySelector("[data-page-content]")
        ?.getAttribute("data-page-gutter"),
    ).toBe("standard");
    expect(container.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
    expect(frame?.className.includes("overflow-y-auto")).toBe(true);
  });

  it("renders Automations with one framed gutter, clearance, and view scroller", async () => {
    appState.tab = "automations";
    window.history.replaceState(null, "", "/automations");

    const { container } = render(<App />);
    const automations = await screen.findByTestId(
      "automations-layout",
      {},
      { timeout: 10_000 },
    );
    const frame = automations.closest<HTMLElement>("[data-page-kind]");
    const pageContent = frame?.querySelector<HTMLElement>(
      ":scope > [data-page-content]",
    );
    const body = screen.getByTestId("automations-scroll-region");

    expect(frame?.getAttribute("data-page-kind")).toBe("content");
    expect(frame?.getAttribute("data-page-width")).toBe("standard");
    expect(frame?.getAttribute("data-scroll-owner")).toBe("view");
    expect(pageContent?.getAttribute("data-page-gutter")).toBe("none");
    expect(pageContent?.className).not.toContain("px-4");
    expect(body.className).toContain("max-w-5xl");
    expect(body.className).toContain("px-4");

    const clearanceOwners = Array.from(
      frame?.querySelectorAll<HTMLElement>("*") ?? [],
    ).filter((element) =>
      element
        .getAttribute("class")
        ?.includes("pb-[var(--eliza-chat-clearance,5.25rem)]"),
    );
    expect(clearanceOwners).toEqual([automations]);
    expect(automations.getAttribute("data-chat-clearance-aware")).toBe("true");
    expect(automations.className).not.toContain(
      "pe-[var(--eliza-chat-side-clearance,0px)]",
    );
    expect(automations.className).not.toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:pb-0",
    );

    expect(body.getAttribute("data-framed-page-scroll")).toBe("page");
    expect(body.getAttribute("data-shell-scroll-region")).toBeNull();
    expect(body.className).toContain("overflow-y-auto");
    expect(
      frame?.querySelectorAll('[data-shell-scroll-region="true"]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
  });

  it("keeps the ambient chat route outside canonical page framing", () => {
    appState.tab = "chat";
    window.history.replaceState(null, "", "/chat");

    const { container } = render(<App />);

    expect(container.querySelectorAll("[data-page-kind]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-scroll-owner]")).toHaveLength(0);
  });

  it("renders an explicit unavailable state instead of healthy Home for an absent surface", async () => {
    appState.tab = "phone";
    window.history.replaceState(null, "", "/phone");

    const { container } = render(<App />);

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-view-status="unavailable"][data-view-id="phone"]',
        ),
      ).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="home-screen"]')).toBeNull();
  });

  it("frames the immersive background editor exactly once", async () => {
    appState.tab = "background";
    window.history.replaceState(null, "", "/background");

    const { container } = render(<App />);

    await waitFor(() => {
      expect(
        container.querySelector('[data-page-kind="immersive"]'),
      ).not.toBeNull();
    });
    expect(container.querySelectorAll("[data-page-kind]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
  });

  it("acknowledges a cancelable completed-action handoff only after handling it", () => {
    render(<App />);
    const event = new CustomEvent(NAVIGATE_VIEW_EVENT, {
      cancelable: true,
      detail: {
        viewId: "views-manager",
        viewPath: "/views",
        completedActionHandoffId: "handoff-app-observed",
      },
    });

    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(appState.setTab).toHaveBeenCalledWith("views");
  });

  it("routes a settings subview navigate to the settings tab (#9945)", async () => {
    render(<App />);

    navigateView({
      viewId: "settings",
      viewPath: "/settings",
      subview: "voice",
    });

    // A settings deep-link with a subview switches to the settings tab (the
    // section itself is applied via SettingsView's initialSection prop) and
    // does NOT fall through to a desktop-tab open.
    await waitFor(() => {
      expect(appState.setTab).toHaveBeenCalledWith("settings");
    });
    expect(desktopTabsMock.openTab).not.toHaveBeenCalled();
  });

  it("passes settings navigate payloads into SettingsView for targeted permission priming", async () => {
    appState.tab = "settings";
    window.history.replaceState(null, "", "/?shellMode=full");
    const payload = { permissionRequest: { permission: "microphone" } };
    render(<App />);

    fireEvent(
      window,
      createNavigateViewEvent({
        viewId: "settings",
        viewPath: "/settings",
        subview: "permissions",
        payload,
      }),
    );

    await waitFor(() => {
      expect(settingsViewMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          initialSection: "permissions",
          navigatePayload: payload,
          navigateSequence: 1,
        }),
      );
    });
    const settingsPageContent = (
      await screen.findByTestId("settings-view")
    ).closest<HTMLElement>("[data-page-content]");
    expect(settingsPageContent).not.toBeNull();
    expect(settingsPageContent?.getAttribute("data-page-gutter")).toBe("none");
    expect(
      settingsPageContent
        ?.closest<HTMLElement>("[data-page-kind]")
        ?.getAttribute("data-page-width"),
    ).toBe("full");
    expect(settingsPageContent?.className).toContain(
      "pb-[var(--eliza-chat-clearance,5.25rem)]",
    );
    expect(settingsPageContent?.className).not.toContain(
      "pe-[var(--eliza-chat-side-clearance,0px)]",
    );
    expect(settingsPageContent?.className).toContain("settings-surface");
    expect(settingsPageContent?.className).toContain("settings-canvas");
    const routedMain = screen.getByTestId("settings-view").closest("main");
    expect(routedMain?.className).not.toContain("px-2");
    expect(routedMain?.className).not.toContain("pt-[var(--view-pad-top)]");
    expect(
      screen
        .getByTestId("settings-view")
        .closest<HTMLElement>("[data-app-shell-root]")?.style.paddingTop,
    ).toBe("0px");
  });

  it("pins remote views and opens remote view windows through App wiring", async () => {
    render(<App />);

    navigateView({ action: "pin-tab", viewId: "remote-ledger" });

    await waitFor(() => {
      expect(desktopTabsMock.openTab).toHaveBeenCalledWith(remoteLedgerView, {
        pinned: true,
      });
    });
    expect(window.location.pathname).toBe("/apps/remote-ledger");

    navigateView({
      action: "open-window",
      viewId: "remote-ledger",
      alwaysOnTop: true,
    });

    await waitFor(() => {
      expect(desktopBridgeMock.invokeDesktopBridgeRequest).toHaveBeenCalledWith(
        {
          ipcChannel: "desktop:openAppWindow",
          params: {
            alwaysOnTop: true,
            path: "/apps/remote-ledger",
            title: "Remote Ledger",
          },
          rpcMethod: "desktopOpenAppWindow",
        },
      );
    });
  });

  it("renders a remote module route through DynamicViewLoader in the mounted App", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps/remote-ledger");

    const { container, getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: "/api/views/remote-ledger/bundle.js",
          reserveChatClearance: false,
          viewId: "remote-ledger",
          viewType: "gui",
        }),
        undefined,
      );
    });

    const loader = getByTestId("dynamic-view-loader");
    expect(loader.getAttribute("data-bundle-url")).toBe(
      "/api/views/remote-ledger/bundle.js",
    );
    expect(loader.getAttribute("data-view-id")).toBe("remote-ledger");
    expect(loader.getAttribute("data-view-type")).toBe("gui");
    expect(queryByTestId("view-header")).toBeNull();
    expect(
      container
        .querySelector('[data-shell-content-region="true"] [data-page-content]')
        ?.className.includes("pb-[var(--eliza-chat-clearance"),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-shell-content-region="true"] [data-page-content]')
        ?.className.includes("pe-[var(--eliza-chat-side-clearance"),
    ).toBe(false);
    expect(getByTestId("app-opaque-background")).toBeTruthy();
    expect(queryByTestId("app-background-shader")).toBeNull();
  });

  it("keeps an in-process page's own header without adding a duplicate shell header", async () => {
    registerAppShellPage({
      id: "signed-normal",
      pluginId: "@local/plugin-signed-normal",
      label: "Signed Normal",
      path: "/apps/signed-normal",
      Component: () => (
        <section data-testid="signed-normal-content">
          <h1>Signed Normal</h1>
        </section>
      ),
    });
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps/signed-normal");

    const { getByTestId, getAllByRole, queryByTestId } = render(<App />);

    await waitFor(() => getByTestId("signed-normal-content"));
    expect(getAllByRole("heading", { name: "Signed Normal" })).toHaveLength(1);
    expect(queryByTestId("view-header")).toBeNull();
  });

  it.each([
    { strictMode: false, entry: "direct" },
    { strictMode: true, entry: "direct" },
    { strictMode: false, entry: "navigate-view" },
    { strictMode: true, entry: "navigate-view" },
  ])(
    "returns a registered fixture to the launcher using its own back control ($entry, StrictMode=$strictMode)",
    async ({ strictMode, entry }) => {
      electrobunRuntimeState.enabled = false;
      registerAppShellPage({
        id: "notes",
        pluginId: "@elizaos/plugin-notes",
        label: "Notes",
        path: "/notes",
        surface: { header: "normal", capabilities: [] },
        Component: () => (
          // This fixture exercises a view-owned control's real guarded-history
          // path; it does not assert that the production Notes page has one.
          <section aria-label="Notes fixture">
            <h1>Notes</h1>
            <ViewBackButton />
            <p>A saved note</p>
          </section>
        ),
      });
      window.history.replaceState(
        null,
        "",
        entry === "direct" ? "/notes" : "/views",
      );
      render(
        strictMode ? (
          <React.StrictMode>
            <AppWithRealNavigation />
          </React.StrictMode>
        ) : (
          <AppWithRealNavigation />
        ),
      );
      if (entry === "navigate-view") {
        await screen.findByTestId("launcher-surface");
        navigateView({ viewId: "notes", viewPath: "/notes" });
      }

      await screen.findByRole("region", { name: "Notes fixture" });
      expect(screen.getAllByRole("heading", { name: "Notes" })).toHaveLength(1);
      expect(screen.queryByTestId("view-header")).toBeNull();
      expect(getActiveSurfaceRealmScope()?.viewId).toBe("notes");
      // Prove the guard is armed, not just that a scope-shaped object exists.
      expect(() => window.history.pushState(null, "", "/views")).toThrow(
        SurfaceRealmDeniedError,
      );
      expect(window.location.pathname).toBe("/notes");

      act(() => navigateBackToLauncher());

      await waitFor(() => {
        expect(window.location.pathname).toBe("/views");
        expect(screen.getByTestId("launcher-surface")).toBeTruthy();
        expect(
          screen.queryByRole("region", { name: "Notes fixture" }),
        ).toBeNull();
        expect(getActiveSurfaceRealmScope()?.viewId).not.toBe("notes");
      });
      // A second real browser event must not resurrect stale provider tab state.
      act(() => window.dispatchEvent(new PopStateEvent("popstate")));
      expect(window.location.pathname).toBe("/views");
      expect(screen.getByTestId("launcher-surface")).toBeTruthy();
      expect(
        screen.queryByRole("region", { name: "Notes fixture" }),
      ).toBeNull();
      expect(appState.setTab).not.toHaveBeenCalled();
    },
  );

  it("keeps modal remote pages headerless without treating them as fullscreen", async () => {
    mockAvailableViews.push(modalView);
    appState.tab = "apps";
    window.history.replaceState(null, "", modalView.path);

    const { container, getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => getByTestId("dynamic-view-loader"));
    expect(queryByTestId("view-header")).toBeNull();
    expect(
      container
        .querySelector('[data-shell-content-region="true"] [data-page-content]')
        ?.className.includes("pb-[var(--eliza-chat-clearance"),
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement>("[data-app-shell-root]")?.style
        .paddingTop,
    ).not.toBe("0px");
  });

  it.each(["/documents", "/knowledge"])(
    "keeps the legacy Knowledge route %s on the canonical plugin surface",
    async (path) => {
      registerAppShellPage({
        id: "documents",
        pluginId: "@elizaos/plugin-documents",
        label: "Knowledge",
        path: "/documents",
        pathPatterns: ["/character/documents"],
        surface: { header: "fullscreen" },
        tabAffinity: "documents",
        Component: () => <div data-testid="documents-view" />,
      });
      appState.tab = "documents";
      window.history.replaceState(null, "", path);

      const { findByTestId, queryByTestId } = render(<App />);

      expect(
        await findByTestId("documents-view", undefined, { timeout: 5_000 }),
      ).toBeTruthy();
      expect(queryByTestId("dynamic-view-loader")).toBeNull();
    },
  );

  it("prefers an exact remote plugin route over its native wallet fallback", async () => {
    mockAvailableViews.push(walletMarketView);
    registerAppShellPage({
      id: walletMarketView.id,
      pluginId: walletMarketView.pluginName,
      label: walletMarketView.label,
      path: walletMarketView.path,
      tabAffinity: "inventory",
      Component: () => <div data-testid="native-wallet-fallback" />,
    });
    appState.tab = "inventory";
    window.history.replaceState(null, "", walletMarketView.path);

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => getByTestId("dynamic-view-loader"));
    expect(
      getByTestId("dynamic-view-loader").getAttribute("data-view-id"),
    ).toBe(walletMarketView.id);
    expect(queryByTestId("native-wallet-fallback")).toBeNull();
  });

  it("keeps signed-out remote Cloud rendering and capability ownership together for the plugin audit fixture", async () => {
    registerAppShellPage({
      id: "cloud",
      pluginId: "@elizaos/ui:cloud",
      label: "Cloud",
      path: "/cloud",
      pathPatterns: ["/cloud/*"],
      surface: { capabilities: ["navigate"] },
      tabAffinity: "cloud",
      Component: () => <div data-testid="managed-cloud-page" />,
    });
    mockAvailableViews.push({
      id: "remote-cloud-imposter",
      label: "Remote Cloud Imposter",
      available: true,
      pluginName: "@local/plugin-cloud-imposter",
      path: "/cloud/agents/missing-agent",
      bundleUrl: "/api/views/remote-cloud-imposter/bundle.js",
      viewType: "gui",
    });
    appState.tab = "cloud";
    window.history.replaceState(null, "", "/cloud/agents/missing-agent");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => getByTestId("dynamic-view-loader"));
    expect(queryByTestId("managed-cloud-page")).toBeNull();
    expect(
      getByTestId("dynamic-view-loader").getAttribute("data-view-id"),
    ).toBe("remote-cloud-imposter");
    await waitFor(() => {
      expect(getActiveSurfaceRealmScope()?.viewId).toBe(
        "remote-cloud-imposter",
      );
    });
    expect([
      ...(getActiveSurfaceRealmScope()?.manifest.capabilities ?? []),
    ]).toEqual([]);
  });

  it.each([
    ["root", "/cloud"],
    ["nested", "/cloud/billing"],
  ])(
    "gives an authenticated Steward session authoritative %s Cloud dashboard ownership",
    async (_label, path) => {
      registerAppShellPage({
        id: "cloud",
        pluginId: "@elizaos/ui",
        label: "Cloud",
        path: "/cloud",
        pathPatterns: ["/cloud/*"],
        surface: {
          capabilities: ["navigate"],
          layout: {
            kind: "immersive",
            topology: "ambient",
            width: "full",
            scroll: "view",
            gutter: "none",
          },
        },
        tabAffinity: "cloud",
        Component: () => <div data-testid="managed-cloud-page" />,
      });
      mockAvailableViews.push({
        id: "remote-cloud-imposter",
        label: "Remote Cloud Imposter",
        available: true,
        pluginName: "@local/plugin-cloud-imposter",
        path,
        bundleUrl: "/api/views/remote-cloud-imposter/bundle.js",
        viewType: "gui",
      });
      cloudSessionState.authenticated = true;
      appState.tab = "cloud";
      window.history.replaceState(null, "", path);

      const { container, getByTestId, queryByTestId } = render(<App />);

      await waitFor(() => getByTestId("managed-cloud-page"));
      expect(queryByTestId("dynamic-view-loader")).toBeNull();
      expect(container.querySelectorAll("[data-page-kind]")).toHaveLength(0);
      await waitFor(() => {
        expect(getActiveSurfaceRealmScope()?.viewId).toBe("cloud");
      });
      expect([
        ...(getActiveSurfaceRealmScope()?.manifest.capabilities ?? []),
      ]).toEqual(["navigate"]);
      expect(getActiveSurfaceRealmScope()?.manifest.layout.topology).toBe(
        "ambient",
      );
    },
  );

  it.each([
    "restoring-session",
    "polling-backend",
    "pairing-required",
    "error",
    "starting-runtime",
    "ready",
  ])(
    "keeps authenticated account management available during agent %s",
    async (phase) => {
      registerAppShellPage({
        id: "cloud",
        pluginId: "@elizaos/ui",
        label: "Cloud",
        path: "/cloud",
        pathPatterns: ["/cloud/*"],
        surface: { capabilities: ["navigate"] },
        Component: () => <div data-testid="managed-cloud-page" />,
      });
      cloudSessionState.authenticated = true;
      authStatusMock.phase = "unauthenticated";
      appState.startupPhase = phase;
      appState.backendConnectionState = "disconnected";
      appState.tab = "cloud";
      window.history.replaceState(null, "", "/cloud/agents");

      render(<App />);

      await screen.findByTestId("managed-cloud-page");
      expect(appState.retryStartup).not.toHaveBeenCalled();
    },
  );

  it.each([
    { authenticated: false, owner: "@elizaos/ui" },
    { authenticated: true, owner: "@elizaos/plugin-elizacloud" },
  ])(
    "keeps agent startup gates for $owner with Cloud auth=$authenticated",
    ({ authenticated, owner }) => {
      registerAppShellPage({
        id: "cloud",
        pluginId: owner,
        label: "Cloud",
        path: "/cloud",
        pathPatterns: ["/cloud/*"],
        Component: () => <div data-testid="managed-cloud-page" />,
      });
      cloudSessionState.authenticated = authenticated;
      appState.startupPhase = "polling-backend";
      appState.tab = "cloud";
      window.history.replaceState(null, "", "/cloud/agents");

      render(<App />);

      expect(screen.queryByTestId("managed-cloud-page")).toBeNull();
    },
  );

  it("gives an in-process wallet page a live agent-surface registry", async () => {
    registerAppShellPage({
      id: "wallet.inventory",
      pluginId: "@elizaos/plugin-wallet:ui",
      label: "Wallet",
      path: "/inventory",
      tabAffinity: "inventory",
      Component: () => (
        <AgentButton agentId="wallet-refresh">Refresh wallet</AgentButton>
      ),
    });
    appState.tab = "inventory";
    window.history.replaceState(null, "", "/inventory");

    render(<App />);

    await waitFor(() => {
      expect(getViewRegistry("wallet.inventory", "gui")?.size()).toBe(1);
    });
    expect(
      getViewRegistry("wallet.inventory", "gui")?.describe("wallet-refresh")
        ?.label,
    ).toBe("Refresh wallet");
    const walletButton = screen.getByRole("button", {
      name: "Refresh wallet",
    });
    const walletContentRegion = walletButton.closest<HTMLElement>(
      '[data-shell-content-region="true"]',
    );
    expect(walletContentRegion).not.toBeNull();
    expect(
      walletContentRegion?.querySelector('[data-shell-scroll-region="true"]'),
    ).toBeNull();
    const routedMain = walletButton.closest("main");
    expect(routedMain?.className).not.toContain("px-2");
    expect(routedMain?.className).not.toContain("pt-[var(--view-pad-top)]");
    expect(
      walletButton.closest<HTMLElement>("[data-app-shell-root]")?.style
        .paddingTop,
    ).toBe("0px");
  });

  it("hands a cold wallet deep link to a deferred app-shell registration", async () => {
    appState.tab = "inventory";
    window.history.replaceState(null, "", "/wallet");

    render(<App />);

    expect(
      (await screen.findByTestId("dynamic-plugin-page-loading")).textContent,
    ).toBe("Loading wallet.inventory…");

    act(() => {
      registerAppShellPage({
        id: "wallet.inventory",
        pluginId: "@elizaos/plugin-wallet:ui",
        label: "Wallet",
        path: "/inventory",
        tabAffinity: "inventory",
        Component: () => (
          <div data-testid="deferred-wallet-page">Wallet ready</div>
        ),
      });
    });

    expect(
      (await screen.findByTestId("deferred-wallet-page")).textContent,
    ).toBe("Wallet ready");
    expect(screen.queryByTestId("dynamic-plugin-page-loading")).toBeNull();
  });

  it.each(["/inventory", "/wallet/activity", "/wallet/markets"])(
    "does not canonicalize a cold exact wallet-family route through tab affinity: %s",
    async (path) => {
      appState.tab = "views";
      window.history.replaceState(null, "", path);
      const registrations = [
        {
          id: "wallet.inventory",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Wallet",
          path: "/inventory",
        },
        {
          id: "wallet.activity",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Activity",
          path: "/wallet/activity",
        },
        {
          id: "wallet.markets",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Markets",
          path: "/wallet/markets",
        },
      ];
      const owningRegistration = registrations.find(
        (registration) => registration.path === path,
      );
      if (!owningRegistration) {
        throw new Error(`Missing test registration for ${path}`);
      }

      registerAppShellPage({
        ...owningRegistration,
        tabAffinity: "inventory",
        Component: () => null,
      });

      render(<App />);

      expect(window.location.pathname).toBe(path);
      expect(appState.setTab).not.toHaveBeenCalled();
    },
  );

  it("mounts an exact signed native renderer when stale registry metadata still advertises a remote bundle", async () => {
    electrobunRuntimeState.enabled = false;
    const platform = vi
      .spyOn(Capacitor, "getPlatform")
      .mockReturnValue("android");
    mockAvailableViews.push(notesFullscreenView);
    registerAppShellPage({
      id: "notes",
      pluginId: "@elizaos/plugin-notes",
      label: "Notes",
      path: "/notes",
      surface: { header: "fullscreen" },
      Component: () => <div data-testid="signed-notes" />,
    });
    appState.tab = "views";
    window.history.replaceState(null, "", "/notes");

    try {
      const { container, getByTestId, queryByTestId } = render(<App />);

      await waitFor(() => getByTestId("signed-notes"));
      expect(queryByTestId("dynamic-view-loader")).toBeNull();
      expect(queryByTestId("view-header")).toBeNull();
      expect(dynamicViewLoaderMock.render).not.toHaveBeenCalled();
      const frame = container.querySelector('[data-page-kind="workspace"]');
      expect(frame?.getAttribute("data-page-width")).toBe("full");
      expect(
        frame
          ?.querySelector("[data-page-content]")
          ?.getAttribute("data-page-gutter"),
      ).toBe("none");
      expect(container.querySelectorAll("[data-page-kind]")).toHaveLength(1);
    } finally {
      platform.mockRestore();
    }
  });

  it("lets a fullscreen plugin view fill behind the floating composer", async () => {
    mockAvailableViews.push(notesFullscreenView);
    appState.tab = "views";
    window.history.replaceState(null, "", "/notes");

    const { container, getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => getByTestId("dynamic-view-loader"));
    expect(queryByTestId("view-header")).toBeNull();
    const frame = container.querySelector('[data-page-kind="workspace"]');
    expect(frame?.getAttribute("data-page-width")).toBe("full");
    expect(frame?.getAttribute("data-scroll-owner")).toBe("view");
    expect(
      frame
        ?.querySelector("[data-page-content]")
        ?.getAttribute("data-page-gutter"),
    ).toBe("none");
    expect(container.querySelectorAll("[data-page-kind]")).toHaveLength(1);
    expect(getActiveSurfaceRealmScope()?.manifest.layout).toEqual({
      kind: "workspace",
      topology: "framed",
      width: "full",
      scroll: "view",
      gutter: "none",
    });
    expect(
      container
        .querySelector('[data-shell-content-region="true"] [data-page-content]')
        ?.className.includes("pb-[var(--eliza-chat-clearance"),
    ).toBe(false);
    expect(
      container
        .querySelector('[data-shell-content-region="true"] [data-page-content]')
        ?.className.includes("pe-[var(--eliza-chat-side-clearance"),
    ).toBe(false);
    expect(
      container.querySelector<HTMLElement>("[data-app-shell-root]")?.style
        .paddingTop,
    ).toBe("0px");
  });

  it("routes frame-only sandboxed views through DynamicViewLoader with frameUrl", async () => {
    mockAvailableViews.push(sandboxedFrameView);
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps/sandboxed-frame");

    const { getByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: undefined,
          frameUrl: "/api/views/sandboxed-frame/frame.html",
          viewId: "sandboxed-frame",
          viewType: "gui",
        }),
        undefined,
      );
    });

    const loader = getByTestId("dynamic-view-loader");
    expect(loader.getAttribute("data-bundle-url")).toBe("");
    expect(loader.getAttribute("data-frame-url")).toBe(
      "/api/views/sandboxed-frame/frame.html",
    );
  });

  it("keeps an unavailable registered route in its loader for retry instead of the view manager", async () => {
    mockAvailableViews.push({
      ...remoteLedgerView,
      id: "unavailable-ledger",
      path: "/unavailable-ledger",
      available: false,
    });
    appState.tab = "views";
    window.history.replaceState(null, "", "/unavailable-ledger");
    render(<App />);
    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({ viewId: "unavailable-ledger" }),
        undefined,
      );
    });
    expect(window.location.pathname).toBe("/unavailable-ledger");
  });

  it("renders no global corner back button on app routes (removed in favor of per-page back affordances + browser/OS back)", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/chat");
    window.history.pushState(null, "", "/apps/remote-ledger");

    const { queryByTestId } = render(<App />);

    // The route mounts (its remote view loader is requested)…
    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalled();
    });

    // …but the floating top-left corner back button that used to overlap page
    // content (Apps gallery section headings, the Character/Knowledge
    // breadcrumb) is gone. Pages that need a back affordance render their own
    // in-context control; everyone can also use browser/OS back.
    expect(queryByTestId("shell-back-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  });

  it("lets a view explicitly share the Home/Launcher background", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/shared-canvas");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: "/api/views/shared-canvas/bundle.js",
          viewId: "shared-canvas",
        }),
        undefined,
      );
    });

    expect(getByTestId("app-background-shader")).toBeTruthy();
    expect(queryByTestId("app-opaque-background")).toBeNull();
  });

  it("reports user desktop-tab clicks to the agent without a navigation echo", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps");
    desktopTabsState.tabs = [
      {
        viewId: "remote-ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        pinned: true,
      },
    ];
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiBase: "http://agent.local" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/commands")) {
          return new Response(JSON.stringify({ commands: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        if (url.includes("/api/custom-actions")) {
          return new Response(JSON.stringify({ actions: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Remote Ledger" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://agent.local/api/views/remote-ledger/navigate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            source: "user",
            path: "/apps/remote-ledger",
          }),
        }),
      );
    });
    expect(window.location.pathname).toBe("/apps/remote-ledger");
  });

  it("replays a failed cold-start view report once after reconnect and still clears Home", async () => {
    appState.tab = "views";
    appState.startupPhase = "polling-backend";
    appState.backendConnectionState = "connecting";
    window.history.replaceState(null, "", "/notes");
    mockAvailableViews.push(notesFullscreenView);
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiBase: "http://agent.local" });

    let viewNavigationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/commands")) {
        return new Response(JSON.stringify({ commands: [] }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
      if (url.includes("/api/custom-actions")) {
        return new Response(JSON.stringify({ actions: [] }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
      if (url.includes("/api/views/")) {
        viewNavigationAttempts += 1;
        if (viewNavigationAttempts === 1) {
          throw new Error("offline");
        }
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render(<App />);
    const viewNavigationCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/views/"),
      );

    expect(viewNavigationCalls()).toHaveLength(0);

    appState.startupPhase = "ready";
    appState.backendConnectionState = "connected";
    rendered.rerender(<App />);

    await waitFor(() => {
      expect(viewNavigationCalls()).toHaveLength(1);
    });

    appState.backendConnectionState = "reconnecting";
    rendered.rerender(<App />);
    expect(viewNavigationCalls()).toHaveLength(1);

    appState.backendConnectionState = "connected";
    rendered.rerender(<App />);

    await waitFor(() => {
      expect(viewNavigationCalls()).toHaveLength(2);
    });
    expect(viewNavigationCalls()[1]).toEqual([
      "http://agent.local/api/views/notes/navigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "user", path: "/notes" }),
      }),
    ]);

    rendered.rerender(<App />);
    await act(async () => Promise.resolve());
    expect(viewNavigationCalls()).toHaveLength(2);

    act(() => {
      shellHistory.replaceState(null, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(viewNavigationCalls()).toHaveLength(3);
    });
    expect(viewNavigationCalls()[2]).toEqual([
      "http://agent.local/api/views/__all__/navigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "user", action: "close-all" }),
      }),
    ]);
  });

  it("renders split-view events as a live dynamic view layout", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getAllByTestId, getByTestId } = render(<App />);

    const splitViews = [projectBoardAgentSurfaceView, calendarView];
    mockAvailableViews.splice(0, mockAvailableViews.length, ...splitViews);

    navigateView({
      action: "split-view",
      viewId: "project-board",
      views: ["project-board", "calendar"],
      layout: "horizontal",
      placement: "right",
    });

    await waitFor(() => {
      expect(getByTestId("view-layout-surface")).toBeTruthy();
    });
    expect(getByTestId("view-layout-pane-project-board")).toBeTruthy();
    expect(getByTestId("view-layout-pane-calendar")).toBeTruthy();
    const loaders = getAllByTestId("dynamic-view-loader");
    expect(
      loaders.map((loader) => loader.getAttribute("data-view-id")),
    ).toEqual(["project-board", "calendar"]);
    expect(loaders[0]?.getAttribute("data-surface-capabilities")).toBe(
      "agent-surface",
    );
    expect(loaders[1]?.getAttribute("data-surface-capabilities")).toBe("");
    expect(document.querySelectorAll("[data-page-kind]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(
      projectBoardAgentSurfaceView,
      {
        pinned: false,
      },
    );
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(calendarView, {
      pinned: false,
    });
  });

  it("renders registered documents bundles inside split-view when registry wins", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getAllByTestId, getByTestId } = render(<App />);

    navigateView({
      action: "split-view",
      viewId: "documents",
      views: ["documents", "calendar"],
      layout: "horizontal",
    });

    await waitFor(() => {
      expect(getByTestId("view-layout-surface")).toBeTruthy();
    });
    expect(getByTestId("view-layout-pane-documents")).toBeTruthy();
    expect(
      getAllByTestId("dynamic-view-loader").map((loader) =>
        loader.getAttribute("data-view-id"),
      ),
    ).toEqual(["documents", "calendar"]);
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(documentsView, {
      pinned: false,
    });
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(calendarView, {
      pinned: false,
    });
  });

  it("keeps /views on the built-in Launcher instead of the remote manager bundle", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(getByTestId("launcher-surface")).toBeTruthy();
    });
    expect(queryByTestId("dynamic-view-loader")).toBeNull();
    expect(dynamicViewLoaderMock.render).not.toHaveBeenCalled();
    expect(getByTestId("app-background-shader")).toBeTruthy();
    expect(queryByTestId("app-opaque-background")).toBeNull();
  });

  it("lands on the designed not-found state for a navigate-view id nothing serves (#17033)", async () => {
    window.history.replaceState(null, "", "/?shellMode=full");
    // The handler calls setTab before pushing the path; mirroring the tab into
    // the live appState lets the popstate-triggered re-render route to /apps
    // the way the real store would.
    appState.setTab.mockImplementation((tab: string) => {
      appState.tab = tab;
    });
    render(<App />);

    navigateView({ viewId: "definitely-not-a-view" });

    // The settled-unclaimed slug must survive AppsPageView's ~1.5s
    // idle-registration grace window before not-found renders, so the wait
    // outlasts it (this suite runs real timers).
    expect(
      await screen.findByTestId("app-route-not-found", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/apps/definitely-not-a-view");
    expect(screen.queryByTestId("launcher-surface")).toBeNull();
  });
});
