/** Verifies App in-process host-realm mutation isolation (#14179) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * In-process host-realm mutation fuzz for the real `<App/>` shell (#14179).
 *
 * `App.screen-background-fuzz` proves the background vector; this sibling proves
 * the remaining four. It mounts the REAL `<App/>` (same harness), registers
 * views whose surface manifest differs only by grant, and fuzzes a randomized
 * cross-view walk. After landing on each view it scripts the view attempting all
 * four host-realm mutations — root/body class, `:root` CSS var, a `localStorage`
 * write to a shell key, and a shell navigation — then transitions and asserts
 * each was scoped or blocked by the resolved manifest:
 *
 *   (a) a view-injected root/body class does not survive the transition,
 *   (b) a view-injected `:root` CSS var does not survive the transition,
 *   (c) a non-`storage` view's write to a shell key never lands in the shell
 *       keyspace (it is confined to the view's namespace),
 *   (d) a non-`navigate` view cannot drive shell navigation off the route.
 *
 * The grant is a real switch: dedicated tests prove a `storage`-granted view
 * reaches the host keyspace and a `navigate`-granted view moves the route, while
 * their un-granted twins are scoped/denied — mirroring the read-only vs
 * agent-surface split in `view-capability-broker.test.tsx`. Deleting the shell's
 * `resetHostRealm()` / broker gates turns these assertions red (mutation-check
 * in the file's trailing comment).
 *
 * The walk also drives the RAW globals (#13452 criterion-1 remainder): the view
 * bypasses the facade with `window.localStorage.setItem/removeItem/clear`, an
 * indexed `localStorage[key] =` write, and raw `history.pushState/replaceState`.
 * The raw-global guards must deny the reserved-key writes for every view (grant
 * or not) and deny path-changing history mutation without the `navigate` grant,
 * while hash-only mutation and the shell's privileged channel keep working.
 */

import { createNavigateViewEvent } from "@elizaos/shared/events";
import { act, cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubOfflineAppFetch } from "../test/offline-app-fetch";

// The offline fetch stub keeps every probe permanently pending; withTimeout's
// real timer would fire seconds later — after this file's jsdom env is torn
// down — and reject that pending probe into a post-teardown setState that reads
// the deleted `window`. Pass it through so the probe simply stays pending.
vi.mock("./utils/with-timeout", () => ({
  withTimeout: <T,>(promise: Promise<T>): Promise<T> => promise,
}));

import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import type { BuiltinTab } from "./navigation";
import type { BackgroundConfig } from "./state/ui-preferences";
import {
  getActiveSurfaceRealmScope,
  SurfaceRealmDeniedError,
  surfaceViewStoragePrefix,
} from "./surface-realm-broker";
import { shellHistory, shellLocalStorage } from "./surface-realm-channel";

const appState = vi.hoisted(() => ({
  setTab: vi.fn(),
  tab: "views" as string,
}));

const authorityState = vi.hoisted(() => ({
  agent: "agent-one",
  identityId: "test-user",
  sessionId: "test-session",
  cloudAuthenticated: false,
  cloudUserId: null as string | null,
}));

vi.mock("./hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityState.agent,
  getActiveAgentAuthority: () => authorityState.agent,
}));
vi.mock("./cloud/lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: authorityState.cloudAuthenticated,
    user: authorityState.cloudUserId
      ? { id: authorityState.cloudUserId, email: "test@example.test" }
      : null,
  }),
}));

const bgState = vi.hoisted(() => ({
  config: { mode: "shader", color: "#059669" } as BackgroundConfig,
}));

const backgroundConfigMock = vi.hoisted(() => ({
  redoBackgroundConfig: vi.fn(),
  setBackgroundConfig: vi.fn((config: BackgroundConfig) => {
    bgState.config = config;
  }),
  undoBackgroundConfig: vi.fn(),
}));

const glslRuntimeState = vi.hoisted(() => ({
  compileOk: true,
  rendererCount: 0,
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

const desktopTabsMock = vi.hoisted(() => ({
  closeTab: vi.fn(),
  openTab: vi.fn(),
}));

const desktopBridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
}));

const dynamicViewLoaderMock = vi.hoisted(() => ({
  render: vi.fn(({ viewId }: { viewId: string }) => (
    <div data-testid="dynamic-view-loader" data-view-id={viewId} />
  )),
}));

// Three registered views differing ONLY by grant: no grants, `storage`, and
// `navigate`. The manifest — not the route — decides what each may mutate.
const noGrantView = {
  id: "iso-nogrant",
  label: "Isolated (no grants)",
  available: true,
  pluginName: "@elizaos/plugin-iso-nogrant",
  path: "/iso-nogrant",
  bundleUrl: "/api/views/iso-nogrant/bundle.js",
  viewType: "gui" as const,
  surface: { capabilities: [] as const },
};
const storageView = {
  id: "iso-storage",
  label: "Isolated (storage)",
  available: true,
  pluginName: "@elizaos/plugin-iso-storage",
  path: "/iso-storage",
  bundleUrl: "/api/views/iso-storage/bundle.js",
  viewType: "gui" as const,
  surface: { capabilities: ["storage"] as const },
};
const navigateView = {
  id: "iso-navigate",
  label: "Isolated (navigate)",
  available: true,
  pluginName: "@elizaos/plugin-iso-navigate",
  path: "/iso-navigate",
  bundleUrl: "/api/views/iso-navigate/bundle.js",
  viewType: "gui" as const,
  surface: { capabilities: ["navigate"] as const },
};
let mockAvailableViews: ViewRegistryEntry[] = [
  noGrantView,
  storageView,
  navigateView,
];

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));
vi.mock("./bridge/electrobun-rpc", () => desktopBridgeMock);
vi.mock("./bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
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
  useAvailableViews: () => ({ views: mockAvailableViews }),
  useRoutableViews: () => ({ views: mockAvailableViews }),
  fetchAvailableViews: async () => mockAvailableViews,
}));
vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: {
      phase: "authenticated",
      identity: { id: authorityState.identityId },
      session: { id: authorityState.sessionId },
      access: {},
    },
    refetch: vi.fn(),
  }),
  useIsAuthenticated: () => true,
  // notification-store (#16242) reads these to gate + re-arm its boot hydration
  // probe from the mounted App's notifications-boot effect; the mock must
  // provide them or the probe throws mid-effect. Authenticated => probe on.
  isAuthenticatedNow: () => true,
  // notification-store also keys its inbox authority off the full snapshot
  // (computeAuthorityKey in initNotifications, #18495), so the mock exposes a
  // static authenticated AuthStatusState alongside the boolean seam.
  getAuthStatusSnapshot: () => ({
    phase: "authenticated",
    identity: { id: "test-user" },
    session: { id: "test-session" },
    access: {},
  }),
  subscribeAuthStatus: () => vi.fn(),
}));
vi.mock("./hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));
vi.mock("./hooks", () => ({
  BugReportProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useBugReportState: () => ({}),
  useContextMenu: () => ({
    closeSaveCommandModal: vi.fn(),
    confirmSaveCommand: vi.fn(),
    saveCommandModalOpen: false,
    saveCommandText: "",
  }),
  useMediaQuery: () => false,
  useDocumentVisibility: () => true,
  useRenderGuard: vi.fn(),
  useIntervalWhenDocumentVisible: () => {},
}));
vi.mock("./state", async () => {
  const { ACCENT_PRESETS } = await vi.importActual<
    typeof import("./state/ui-preferences")
  >("./state/ui-preferences");
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    backgroundConfig: bgState.config,
    setBackgroundConfig: backgroundConfigMock.setBackgroundConfig,
    undoBackgroundConfig: backgroundConfigMock.undoBackgroundConfig,
    canUndoBackground: false,
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadPlugins: vi.fn(async () => undefined),
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: true,
    ownerName: "Test Owner",
    plugins: [],
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    setTab: appState.setTab,
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    setUiThemeMode: vi.fn(),
    startupCoordinator: {
      phase: "ready",
      isShellPaintable: true,
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
  return {
    ACCENT_PRESETS,
    useApp: () => getAppValue(),
    useAppSelector: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useAppSelectorShallow: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
    }),
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
vi.mock("./components/pages/BrowserWorkspaceView", () => ({
  BrowserWorkspaceView: () => <div data-testid="browser-workspace-view" />,
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
vi.mock("./components/character/CharacterEditor", () => ({
  CharacterEditor: () => <div data-testid="character-editor" />,
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
vi.mock("./state/useBackgroundConfig", () => ({
  useBackgroundConfig: () => ({
    backgroundConfig: bgState.config,
    setBackgroundConfig: backgroundConfigMock.setBackgroundConfig,
    undoBackgroundConfig: backgroundConfigMock.undoBackgroundConfig,
    redoBackgroundConfig: backgroundConfigMock.redoBackgroundConfig,
    canUndoBackground: false,
    canRedoBackground: false,
  }),
}));
vi.mock("three", () => {
  const compilingGl = {
    COMPILE_STATUS: 0x8b81,
    FRAGMENT_SHADER: 0x8b30,
    compileShader: () => {},
    createShader: () => ({}),
    deleteShader: () => {},
    getShaderInfoLog: () => "forced compile failure",
    getShaderParameter: () => glslRuntimeState.compileOk,
    shaderSource: () => {},
  };
  class WebGLRenderer {
    domElement = document.createElement("canvas");
    constructor() {
      glslRuntimeState.rendererCount += 1;
    }
    dispose() {}
    getContext() {
      return compilingGl;
    }
    render() {}
    setPixelRatio() {}
    setSize() {}
  }
  class Vector2 {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
    set(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    }
  }
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Scene {
    add() {}
  }
  class Camera {}
  class BufferGeometry {
    dispose() {}
    setAttribute() {}
  }
  class BufferAttribute {}
  class RawShaderMaterial {
    dispose() {}
  }
  class Mesh {}
  return {
    BufferAttribute,
    BufferGeometry,
    Camera,
    Mesh,
    RawShaderMaterial,
    Scene,
    Vector2,
    Vector3,
    WebGLRenderer,
  };
});

import { App } from "./App";
import {
  chatDraftStorageKey,
  readChatDraft,
  writeChatDraft,
} from "./state/ChatComposerContext.hooks";

// A shell-owned storage key that must never be writable through a view path.
const SHELL_STORAGE_KEY = "eliza:ui-theme";
const SHELL_STORAGE_VALUE = "owner-chosen-dark";

// This env ships a partial Node Web Storage global (getItem present, setItem/
// clear missing) that the shared setup's getItem check does not repair. Install
// a real in-memory Storage so the shell's `window.localStorage` backing and the
// assertions below run against the same working store.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  [name: string]: unknown;
}

// The routes the walk visits: the three grant-differentiated views plus a couple
// of builtin tabs (which resolve to the default no-grant manifest).
const WALK_ROUTES: { tab: BuiltinTab; path: string }[] = [
  { tab: "views", path: "/iso-nogrant" },
  { tab: "views", path: "/iso-storage" },
  { tab: "views", path: "/iso-navigate" },
  { tab: "browser", path: "/browser" },
  { tab: "settings", path: "/settings" },
];

const VIEWS_HOME = { tab: "views" as BuiltinTab, path: "/views" };

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("App in-process host-realm mutation isolation (#14179)", () => {
  const swallow = (e: ErrorEvent | PromiseRejectionEvent) => {
    e.preventDefault?.();
  };

  beforeEach(() => {
    mockAvailableViews = [noGrantView, storageView, navigateView];
    Object.assign(authorityState, {
      agent: "agent-one",
      identityId: "test-user",
      sessionId: "test-session",
      cloudAuthenticated: false,
      cloudUserId: null,
    });
    appState.tab = "views";
    appState.setTab.mockClear();
    desktopTabsState.tabs = [];
    glslRuntimeState.compileOk = true;
    glslRuntimeState.rendererCount = 0;
    bgState.config = { mode: "shader", color: "#059669" };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    window.localStorage.setItem(SHELL_STORAGE_KEY, SHELL_STORAGE_VALUE);
    stubOfflineAppFetch();
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    window.history.replaceState(null, "", "/views");
    Reflect.deleteProperty(window, "__ELIZAOS_API_BASE__");
    window.addEventListener("error", swallow);
    window.addEventListener("unhandledrejection", swallow);
  });

  afterEach(() => {
    window.removeEventListener("error", swallow);
    window.removeEventListener("unhandledrejection", swallow);
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.className = "";
    document.body.className = "";
    document.documentElement.removeAttribute("style");
  });

  async function navigate(
    rerender: (ui: React.ReactElement) => void,
    tab: string,
    path: string,
  ): Promise<void> {
    await act(async () => {
      appState.tab = tab;
      // Browser-chrome navigation (address bar / user), which never passes
      // through the page's guarded History API — hence the privileged channel.
      shellHistory.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      rerender(<App />);
    });
  }

  it("resolves a distinct broker scope per active view", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-nogrant");
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-nogrant");
    await navigate(rerender, "views", "/iso-storage");
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-storage");
  }, 60_000);

  it("retains the mounted view scope when unrelated registry metadata changes", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    const scope = getActiveSurfaceRealmScope();
    expect(scope?.viewId).toBe("iso-navigate");

    await act(async () => {
      mockAvailableViews = mockAvailableViews.map((view) => ({
        ...view,
        label: `${view.label} refreshed`,
        surface: { ...view.surface },
      }));
      rerender(<App />);
    });

    expect(getActiveSurfaceRealmScope()).toBe(scope);
  }, 60_000);

  it("replaces the scope when the mounted view's navigation grant changes", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    const previous = getActiveSurfaceRealmScope();
    await act(async () => {
      mockAvailableViews = mockAvailableViews.map((view) =>
        view.id === "iso-navigate"
          ? { ...view, surface: noGrantView.surface }
          : view,
      );
      rerender(<App />);
    });
    const current = getActiveSurfaceRealmScope();
    expect(current).not.toBe(previous);
    expect(current?.viewId).toBe("iso-navigate");
    expect(() => current?.navigate("/settings")).toThrow(
      SurfaceRealmDeniedError,
    );
    expect(window.location.pathname).toBe("/iso-navigate");
  }, 60_000);

  it("replaces the scope when a view ID moves to a different route", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    const previous = getActiveSurfaceRealmScope();
    mockAvailableViews = mockAvailableViews.map((view) =>
      view.id === "iso-navigate" ? { ...view, path: "/second-route" } : view,
    );
    await navigate(rerender, "views", "/second-route");
    expect(getActiveSurfaceRealmScope()).not.toBe(previous);
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-navigate");
  }, 60_000);

  it("replaces the scope for authority and principal changes on the same view", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    for (const change of [
      () => {
        authorityState.agent = "agent-two";
      },
      () => {
        authorityState.identityId = "second-user";
      },
      () => {
        authorityState.sessionId = "second-session";
      },
      () => {
        authorityState.cloudAuthenticated = true;
      },
      () => {
        authorityState.cloudUserId = "cloud-user";
      },
    ]) {
      const previous = getActiveSurfaceRealmScope();
      await act(async () => {
        change();
        rerender(<App />);
      });
      expect(getActiveSurfaceRealmScope()).not.toBe(previous);
      expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-navigate");
    }
  }, 60_000);

  it("publishes only rendered layout members and revokes changed child policy", async () => {
    const { rerender } = render(<App />);
    await act(async () => {
      window.dispatchEvent(
        createNavigateViewEvent({
          action: "split-view",
          viewId: "iso-navigate",
          views: ["iso-navigate", "iso-storage", "missing-view"],
          layout: "horizontal",
        }),
      );
    });
    const first = getActiveSurfaceRealmScope();
    expect(first?.ownsView("iso-navigate")).toBe(true);
    expect(first?.ownsView("iso-storage")).toBe(true);
    expect(first?.ownsView("missing-view")).toBe(false);
    expect(first?.ownsView("iso-nogrant")).toBe(false);
    expect(first?.manifest.capabilities.size).toBe(0);
    expect(() => first?.navigate("/settings")).toThrow(/no "navigate" grant/);

    await act(async () => {
      mockAvailableViews = mockAvailableViews.map((view) => ({
        ...view,
        label: `${view.label} refreshed`,
        surface: { ...view.surface },
      }));
      rerender(<App />);
    });
    expect(getActiveSurfaceRealmScope()).toBe(first);

    await act(async () => {
      mockAvailableViews = mockAvailableViews.map((view) =>
        view.id === "iso-navigate"
          ? { ...view, surface: noGrantView.surface }
          : view,
      );
      rerender(<App />);
    });
    const changedPolicy = getActiveSurfaceRealmScope();
    expect(changedPolicy).not.toBe(first);
    expect(changedPolicy?.ownsView("iso-navigate")).toBe(true);
    expect(changedPolicy?.manifest.capabilities.size).toBe(0);

    await act(async () => {
      mockAvailableViews = mockAvailableViews.filter(
        (view) => view.id !== "iso-storage",
      );
      rerender(<App />);
    });
    const changedMembership = getActiveSurfaceRealmScope();
    expect(changedMembership).not.toBe(changedPolicy);
    expect(changedMembership?.viewId).toBe(changedPolicy?.viewId);
    expect(changedMembership?.ownsView("iso-storage")).toBe(false);
    expect(changedMembership?.ownsView("iso-navigate")).toBe(true);
    await navigate(rerender, "settings", "/settings");
    expect(getActiveSurfaceRealmScope()?.ownsView("iso-navigate")).toBe(false);
  }, 60_000);

  it("declares the Database vector child only under its builtin owner", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "database", "/apps/database");
    const databaseScope = getActiveSurfaceRealmScope();
    expect(databaseScope?.viewId).toBe("database");
    expect(databaseScope?.ownsView("vector-browser")).toBe(true);
    expect(databaseScope?.ownsView("iso-navigate")).toBe(false);
    expect(databaseScope?.manifest.capabilities.size).toBe(0);
    await navigate(rerender, "settings", "/settings");
    expect(getActiveSurfaceRealmScope()?.ownsView("vector-browser")).toBe(
      false,
    );
  }, 60_000);

  it("scopes/blocks all four host-realm vectors across a fuzzed cross-view walk", async () => {
    for (const seed of [1, 7, 42]) {
      const rng = makeRng(seed);
      const order = shuffle(WALK_ROUTES, rng);
      const { rerender } = render(<App />);
      await navigate(rerender, VIEWS_HOME.tab, VIEWS_HOME.path);

      for (const route of order) {
        await navigate(rerender, route.tab, route.path);
        const scope = getActiveSurfaceRealmScope();
        expect(scope, `${route.path}: scope published`).not.toBeNull();
        if (!scope) continue;

        // The view reaches the host realm directly (bypassing its host node).
        const rogueRootClass = `rogue-root-${seed}`;
        const rogueBodyClass = `rogue-body-${seed}`;
        const rogueVar = `--rogue-var-${seed}`;
        document.documentElement.classList.add(rogueRootClass);
        document.body.classList.add(rogueBodyClass);
        document.documentElement.style.setProperty(rogueVar, "red");

        // (c) storage: a write to the shell's key. Non-`storage` views are
        // namespaced; the `storage` view is denied the reserved shell key.
        const grantsStorage = route.path === "/iso-storage";
        if (grantsStorage) {
          expect(() => scope.storage.setItem(SHELL_STORAGE_KEY, "pwn")).toThrow(
            SurfaceRealmDeniedError,
          );
        } else {
          scope.storage.setItem(SHELL_STORAGE_KEY, "pwn");
          // The namespaced write landed under the view keyspace, not the shell.
          expect(
            window.localStorage.getItem(
              `${surfaceViewStoragePrefix(scope.viewId)}${SHELL_STORAGE_KEY}`,
            ),
          ).toBe("pwn");
        }
        // Either way the shell key is intact.
        expect(
          window.localStorage.getItem(SHELL_STORAGE_KEY),
          `${route.path}: shell storage key intact`,
        ).toBe(SHELL_STORAGE_VALUE);

        // (c-raw) the view bypasses the facade and hits the raw global. The
        // reserved shell key is denied for EVERY view — grant or not — via
        // setItem, removeItem, and the legacy indexed-assignment path.
        expect(
          () => window.localStorage.setItem(SHELL_STORAGE_KEY, "pwn"),
          `${route.path}: raw reserved setItem denied`,
        ).toThrow(SurfaceRealmDeniedError);
        expect(
          () => window.localStorage.removeItem(SHELL_STORAGE_KEY),
          `${route.path}: raw reserved removeItem denied`,
        ).toThrow(SurfaceRealmDeniedError);
        expect(() => {
          (window.localStorage as Record<string, unknown>)[SHELL_STORAGE_KEY] =
            "pwn";
        }, `${route.path}: raw indexed reserved write denied`).toThrow(
          SurfaceRealmDeniedError,
        );
        expect(
          window.localStorage.getItem(SHELL_STORAGE_KEY),
          `${route.path}: shell storage key intact after raw attack`,
        ).toBe(SHELL_STORAGE_VALUE);
        // A raw clear() from a view path wipes its own reach, never shell keys:
        // a storage-granted view reaches host non-reserved keys, while an
        // ungranted view reaches only its own namespaced keyspace.
        const rawClearKey = grantsStorage
          ? "junk-non-reserved"
          : `${surfaceViewStoragePrefix(scope.viewId)}junk-non-reserved`;
        window.localStorage.setItem(rawClearKey, "x");
        window.localStorage.clear();
        expect(
          window.localStorage.getItem(rawClearKey),
          `${route.path}: raw clear removed reachable non-reserved keys`,
        ).toBeNull();
        expect(
          window.localStorage.getItem(SHELL_STORAGE_KEY),
          `${route.path}: raw clear spared reserved shell keys`,
        ).toBe(SHELL_STORAGE_VALUE);

        // (d) navigation: a non-`navigate` view is denied; the route never moves.
        const grantsNavigate = route.path === "/iso-navigate";
        if (!grantsNavigate) {
          expect(() => scope.navigate("/rogue-route")).toThrow(
            SurfaceRealmDeniedError,
          );
          // (d-raw) the raw History API is guarded the same way: path-changing
          // pushState/replaceState is denied, hash-only mutation stays allowed
          // (it cannot move the shell route).
          expect(
            () => window.history.pushState(null, "", "/rogue-raw"),
            `${route.path}: raw pushState denied`,
          ).toThrow(SurfaceRealmDeniedError);
          expect(
            () => window.history.replaceState(null, "", "/rogue-raw"),
            `${route.path}: raw replaceState denied`,
          ).toThrow(SurfaceRealmDeniedError);
          window.history.replaceState(null, "", `${route.path}#in-view-hash`);
          expect(
            window.location.pathname,
            `${route.path}: route not hijacked`,
          ).toBe(route.path);
        }

        // Transition away — the scope tears down and resets the host realm.
        await navigate(rerender, VIEWS_HOME.tab, VIEWS_HOME.path);

        // (a) + (b) the view's injected class/var did not survive the transition.
        expect(
          document.documentElement.classList.contains(rogueRootClass),
          `${route.path}: injected root class did not survive`,
        ).toBe(false);
        expect(
          document.body.classList.contains(rogueBodyClass),
          `${route.path}: injected body class did not survive`,
        ).toBe(false);
        expect(
          document.documentElement.style.getPropertyValue(rogueVar),
          `${route.path}: injected CSS var did not survive`,
        ).toBe("");
      }
      cleanup();
    }
  }, 120_000);

  it("a storage-granted view reaches the host keyspace (the grant is a real switch)", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-storage");
    const scope = getActiveSurfaceRealmScope();
    expect(scope?.viewId).toBe("iso-storage");
    scope?.storage.setItem("plugin.pref", "on");
    // A non-reserved key lands un-prefixed in the host keyspace.
    expect(window.localStorage.getItem("plugin.pref")).toBe("on");
    // The shell's reserved key is still protected even with the grant.
    expect(window.localStorage.getItem(SHELL_STORAGE_KEY)).toBe(
      SHELL_STORAGE_VALUE,
    );
  }, 60_000);

  it("a navigate-granted view can drive shell navigation (the grant is a real switch)", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    const scope = getActiveSurfaceRealmScope();
    expect(scope?.viewId).toBe("iso-navigate");
    await act(async () => {
      scope?.navigate("/iso-storage");
    });
    // The grant admits the navigation the un-granted twin was denied.
    expect(window.location.pathname).toBe("/iso-storage");
  }, 60_000);

  it("the navigate grant is a real switch on the RAW history guard too", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-navigate");
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-navigate");
    await act(async () => {
      window.history.pushState(null, "", "/raw-but-granted");
    });
    expect(window.location.pathname).toBe("/raw-but-granted");
  }, 60_000);

  it("the privileged shell channel stays writable while a no-grant view is active", async () => {
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-nogrant");
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-nogrant");
    // The shell's own writers (persistence.ts, storage-bridge, the router) run
    // while arbitrary views are foreground; the channel must not be gated.
    shellLocalStorage.setItem(SHELL_STORAGE_KEY, "shell-updated");
    expect(window.localStorage.getItem(SHELL_STORAGE_KEY)).toBe(
      "shell-updated",
    );
    shellLocalStorage.removeItem(SHELL_STORAGE_KEY);
    expect(window.localStorage.getItem(SHELL_STORAGE_KEY)).toBeNull();
    await act(async () => {
      shellHistory.replaceState(null, "", "/shell-owned-route");
    });
    expect(window.location.pathname).toBe("/shell-owned-route");
  }, 60_000);

  it("real shell persisters keep working under an active view scope (regression guard for missed migrations)", async () => {
    // The raw-global guard is a Proxy over window.localStorage installed for the
    // whole realm — so EVERY shell writer of a reserved key, not just the ones
    // the walk drives, must route through the privileged channel or it throws on
    // every write while a view is foreground and its own try/catch swallows the
    // failure into silent data loss. This drives a REAL shell persister
    // (`writeChatDraft`, a `eliza:chat:draft:*` reserved-key writer whose own
    // catch would hide a regression) end-to-end while a no-grant view owns the
    // foreground, and asserts the draft actually persisted. If writeChatDraft
    // (or any peer) reverts to raw `window.localStorage`, the write is denied,
    // swallowed, and the read-back is null → red.
    const { rerender } = render(<App />);
    await navigate(rerender, "views", "/iso-nogrant");
    expect(getActiveSurfaceRealmScope()?.viewId).toBe("iso-nogrant");

    const conversationId = "conv-under-scope";
    writeChatDraft(conversationId, "half-typed message");
    expect(readChatDraft(conversationId)).toBe("half-typed message");
    // It landed under the real reserved key, not a view-namespaced fallback.
    expect(
      window.localStorage.getItem(chatDraftStorageKey(conversationId)),
    ).toBe("half-typed message");
    // Clearing (removeItem on the reserved key) also works under the scope.
    writeChatDraft(conversationId, "");
    expect(readChatDraft(conversationId)).toBeNull();
  }, 60_000);

  it("raw guards disarm when no view scope is active", async () => {
    const { rerender, unmount } = render(<App />);
    await navigate(rerender, "views", "/iso-nogrant");
    expect(getActiveSurfaceRealmScope()).not.toBeNull();
    unmount();
    expect(getActiveSurfaceRealmScope()).toBeNull();
    // Outside any surface (boot, teardown, tests) the raw globals behave
    // natively — the guard is a policy on views, not a global lockdown.
    window.localStorage.setItem(SHELL_STORAGE_KEY, "boot-write");
    expect(window.localStorage.getItem(SHELL_STORAGE_KEY)).toBe("boot-write");
    window.history.pushState(null, "", "/boot-route");
    expect(window.location.pathname).toBe("/boot-route");
  }, 60_000);
});

// ── Mutation-check (red→green proof) ─────────────────────────────────────────
//
// Each vector's guard is independently load-bearing — remove it and the walk
// goes red:
//   (a)+(b) delete the `scope.resetHostRealm()` call in `App.tsx`'s teardown
//           effect → the injected root/body class + `:root` var survive the
//           transition → the class/var survival assertions fail.
//   (c)     make `brokerSurfaceStorage` return `backing` directly (drop the
//           namespacing/reserved-key guard) → the shell key is overwritten →
//           "shell storage key intact" fails.
//   (d)     make `brokerSurfaceNavigate` always call through (drop the grant
//           check) → the non-`navigate` view moves the route → "route not
//           hijacked" fails (and the denial `toThrow` fails).
//   (c-raw) make `ensureHostRealmGuards` skip the localStorage Proxy (or make
//           `assertRawStorageWriteAllowed` return unconditionally) → the raw
//           setItem/removeItem/indexed writes land → every "raw … denied"
//           toThrow and "intact after raw attack" assertion fails.
//   (d-raw) make `assertRawHistoryMutationAllowed` return unconditionally →
//           raw pushState/replaceState moves the route under a no-`navigate`
//           view → the raw denial toThrows and "route not hijacked" fail.
//   (persist) revert any shell reserved-key writer (e.g. `writeChatDraft`) to
//           raw `window.localStorage` → under an active view scope the write is
//           denied, its own catch swallows it, and "real shell persisters keep
//           working under an active view scope" reads back null → red. This is
//           the positive counterpart that catches a MISSED migration, which a
//           denial-only assertion cannot.
