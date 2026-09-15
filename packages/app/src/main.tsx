// FIRST side-effect: repair the same-origin WebSocket base for the plain-web
// served bundle before the `client` singleton can dial its socket. The dev
// server injects a desktop-loopback `__ELIZA_WS_BASE__` (ws://127.0.0.1:31337)
// that client-base reads first; on a reverse-proxied web page the socket must
// be same-origin (wss://<host>/ws). No-op on desktop / native. See module.
import "./web-ws-base-fix";
/**
 * Renderer boot entry and composition root for the cross-platform Eliza app
 * shell (web browser, Electrobun desktop, and Capacitor iOS/Android). Runs
 * before React mounts: starts cold-start telemetry, registers host-external
 * view importers, and resolves cloud-only branding from the injected API base
 * / desktop runtime mode.
 *
 * `main()` drives the boot pipeline — embed-iframe session handshake,
 * app-window route shortcuts, managed cloud launch connection, the
 * headless iOS full-Bun backend smoke gate, popout and detached/overlay window
 * shells, then the per-platform bridge stack (storage + Capacitor bridges, iOS
 * local-agent fetch/native-request bridges, Android native agent fetch bridge,
 * screen-capture / OCR / voice harnesses) — before mounting the React tree
 * (`@elizaos/ui` App, optionally wrapped by the web-only CloudRouterShell) and
 * running `initializePlatform()` concurrently after paint.
 *
 * Also owns deep-link handling (custom `<scheme>://` + `eliza.app` universal
 * links → hash routes, navigate-view events, or first-run remote connect), the
 * trusted-apiBase / native-WebSocket URL policy (tightened for iOS store + cloud
 * builds; a bearer token is never accepted from an OS deep link), the mobile
 * device bridge + agent tunnel + background runner, and the desktop tray /
 * global-shortcut / chat-overlay wiring. Modules not needed for first paint are
 * deferred onto the idle path. Exports the resolved platform flags.
 */
import { ErrorBoundary } from "@elizaos/ui";
import "@elizaos/ui/styles";
// Relationships owns the canonical /apps/relationships route. Its registration
// metadata is tiny and must be available before the first route capture; the
// page component itself remains lazy-loaded by the plugin registration.
import "@elizaos/plugin-relationships/register";
// Native-only (ios/android/desktop): register the Eliza Cloud Applications
// dashboard as an in-process app-shell page (`/cloud-apps`) that mounts the
// self-contained NativeAppsStudio. No-op on web, where CloudRouterShell serves
// the same surfaces.
import "./cloud-apps-view";
// Surfaces the renderer build stamp on window.__ELIZA_RENDERER_BUILD__ so the
// running build's identity is observable in-app and assertable on-device (#9309).
import "./renderer-build-stamp";

import { BackgroundRunner } from "@capacitor/background-runner";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
// #18056: desktop shell is loaded only via dynamic import / React.lazy so the
// cold anonymous /login entry does not static-import app-core/ui browser graphs.
import {
  installIosLocalAgentFetchBridge,
  installIosLocalAgentNativeRequestBridge,
} from "@elizaos/app-core/api/ios-local-agent-transport";
import type { DetachedShellRootProps } from "@elizaos/app-core/desktop-shell";
import { Agent } from "@elizaos/capacitor-agent";
import type { DeviceBridgeClient } from "@elizaos/capacitor-llama";
import { logger } from "@elizaos/logger";
import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import { getStylePresets } from "@elizaos/shared";
import {
  CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
  cloudPairTokenKeyForAgent,
  isCloudPairAgentId,
  isCloudPairLoopbackOrigin,
} from "@elizaos/shared/contracts";
import { isElizaDedicatedAgentHostname } from "@elizaos/shared/elizacloud";
import { configureStoredStewardTokenScope } from "@elizaos/shared/steward-session-client";
import { completeAndroidCloudSignIn } from "@elizaos/ui/android-cloud/android-cloud-auth";
import { shouldAcknowledgeAndroidCloudCallback } from "@elizaos/ui/android-cloud/android-cloud-client";
import { client } from "@elizaos/ui/api";
import { installAndroidNativeAgentFetchBridge } from "@elizaos/ui/api/android-native-agent-transport";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  shellLocalStorage,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge";
import { initializeCapacitorBridge } from "@elizaos/ui/bridge/capacitor-bridge";
import {
  initializeStorageBridge,
  setStorageValue,
} from "@elizaos/ui/bridge/storage-bridge";
import { RenderTelemetryProfiler } from "@elizaos/ui/cloud-ui/runtime/render-telemetry";
import { ShellModalityProvider } from "@elizaos/ui/components/ShellModalityProvider";
import { ShellRoleProvider } from "@elizaos/ui/components/ShellRoleProvider";
import type {
  BrandingConfig,
  CodingAgentTasksPanelProps,
} from "@elizaos/ui/config";
import {
  type AppBootConfig,
  getBootConfig,
  setBootConfig,
} from "@elizaos/ui/config";
import {
  AGENT_READY_EVENT,
  COMMAND_PALETTE_EVENT,
  dispatchAppEvent,
  dispatchConnectRequest,
  dispatchNavigateViewRequest,
  dispatchOpenNotificationCenter,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  PUSH_TO_TALK_HOLD_EVENT,
  PUSH_TO_TALK_TOGGLE_EVENT,
  type PushToTalkHoldDetail,
  SHARE_TARGET_EVENT,
  TRAY_ACTION_EVENT,
} from "@elizaos/ui/events";
import {
  parseFirstRunRemoteConnectDeepLink,
  routeFirstRunDeepLink,
} from "@elizaos/ui/first-run/deep-link-handler";
import {
  FIRST_RUN_CLOUD_LOGIN_ACTION,
  tryHandleFirstRunAction,
} from "@elizaos/ui/first-run/first-run-action-channel";
import {
  IOS_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  normalizeMobileRuntimeMode,
} from "@elizaos/ui/first-run/mobile-runtime-mode";
import { preSeedAndroidLocalRuntimeIfFresh } from "@elizaos/ui/first-run/pre-seed-local-runtime";
import { createTranslator } from "@elizaos/ui/i18n";
import {
  getWindowNavigationPath,
  isAppWindowRoute,
  isDeveloperWorkspaceRoute,
} from "@elizaos/ui/navigation";
import type { ShareTargetPayload } from "@elizaos/ui/platform";
import { isStandalonePwa } from "@elizaos/ui/platform";
import { isAndroidCloudBuild } from "@elizaos/ui/platform/android-runtime";
import {
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
} from "@elizaos/ui/platform/browser-launch";
import { installLocalProviderCloudPreferencePatch } from "@elizaos/ui/platform/cloud-preference-patch";
import { installDesktopPermissionsClientPatch } from "@elizaos/ui/platform/desktop-permissions-client";
import {
  dispatchRemoteControllerPairingIntent,
  parseRemoteControllerPairingDeepLink,
} from "@elizaos/ui/platform/remote-target-pairing-intent";
import { startRendererServiceHost } from "@elizaos/ui/platform/renderer-services";
import {
  clearStandaloneBottomReclaim,
  installStandaloneBottomReclaim,
  shouldInstallStandaloneBottomReclaim,
} from "@elizaos/ui/platform/standalone-bottom-reclaim";
import {
  isChatOverlayWindowShell,
  isDetachedWindowShell,
  isStandaloneWindowShell,
  resolveWindowShellRoute,
  shouldInstallMainWindowFirstRunPatches,
  syncDetachedShellLocation,
} from "@elizaos/ui/platform/window-shell";
import { AppProvider } from "@elizaos/ui/state/AppContext";
import { upsertAndActivateAgentProfile } from "@elizaos/ui/state/agent-profiles";
import { resolveDedicatedAgentId } from "@elizaos/ui/state/agent-session-recovery";
import { initOcrBridge } from "@elizaos/ui/state/ocr-bridge";
import {
  applyUiTheme,
  createPersistedActiveServer,
  loadPersistedActiveServer,
  loadUiLanguage,
  loadUiThemeMode,
  resolveUiTheme,
  savePersistedActiveServer,
} from "@elizaos/ui/state/persistence";
import { getPushToTalkAccelerator } from "@elizaos/ui/state/push-to-talk-hotkey";
import { initScreenCaptureBridge } from "@elizaos/ui/state/screen-capture-bridge";
import {
  initStartupTrace,
  markStartup,
  measureStartup,
} from "@elizaos/ui/state/startup-telemetry";
import { getChatOverlayHotkey } from "@elizaos/ui/state/useChatOverlayHotkey";
import { ELIZA_DEFAULT_THEME } from "@elizaos/ui/themes";
import {
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
} from "@elizaos/ui/utils/cloud-agent-base";
// biome-ignore lint/correctness/noUnusedImports: classic JSX output in this app bundle expects React in module scope.
import * as React from "react";
import {
  type ComponentType,
  lazy,
  type ReactNode,
  StrictMode,
  Suspense,
} from "react";
import ReactDomClient from "react-dom/client";
import {
  APP_BRANDING_BASE,
  APP_CONFIG,
  APP_LOG_PREFIX,
  APP_NAMESPACE,
  APP_URL_SCHEME,
} from "./app-config";
import { cachedDynamicImport } from "./app-module-cache";
import { renderBootFailure } from "./boot-failure";
import { startVoiceModuleLoad } from "./boot-voice-load";
import { APP_ENV_ALIASES, APP_ENV_PREFIX } from "./brand-env";
import { APP_CHARACTER_CATALOG } from "./character-catalog";
import { resolveAppCloudOnlyBranding } from "./cloud-only-branding";
import { isTrustedAppLink } from "./deep-link-handler";
import {
  buildAssistantLaunchHashRoute,
  type DeepLinkNavigationIntent,
  resolveDeepLinkNavigationIntent,
} from "./deep-link-routing";
import { shouldStartFnHoldMonitor } from "./desktop-fn-hold-policy";
import { decideChatOverlayToggle } from "./desktop-hotkey";
import { isEmbedPath, runEmbedHandshake } from "./embed-bootstrap";
import { installMainWindowFirstRunBootPatches } from "./first-run-boot-patches";
import { registerAppHostExternalImporters } from "./host-externals";
import { runIosAttachmentSmokeIfRequested } from "./ios-attachment-smoke";
import {
  extractIosLivenessChallengeToken,
  type IosCloudOnboardingSmokeRequest,
  isIosCloudOnboardingComplete,
  isIosLivenessReplyRow as isIosLivenessReplyRowFromContract,
  parseIosCloudOnboardingSmokeRequest as parseIosCloudOnboardingSmokeRequestFromContract,
} from "./ios-cloud-onboarding-smoke";
import { runIosFullBunEntrypoint } from "./ios-full-bun-entrypoint";
import {
  apiBaseToDeviceBridgeUrl,
  type IosRuntimeConfig,
  resolveIosRuntimeConfig,
} from "./ios-runtime";
import { startKeyboardDictationSession } from "./keyboard-dictation";
import {
  type AndroidDeepLinkBuffer,
  createMobileLifecycle,
  type MobileLifecycle,
} from "./mobile-lifecycle";
import {
  getMobileRemoteFallbackApiBase,
  installMobileRemoteFallback,
} from "./mobile-remote-fallback";
import { installNativeTranscriptPlatformBridge } from "./native-transcript-bridge";
import { installPackagedShellStorageTestBridge } from "./packaged-shell-storage-test-bridge";
import {
  SIDE_EFFECT_APP_MODULE_LOADERS,
  type SideEffectAppModuleLoader,
} from "./plugin-registrations";
import { isRemoteControllerPairingRuntimeAllowed } from "./remote-controller-deep-link";
import {
  PHONE_COMPANION_AGENT_VIEW_ID,
  resolveRendererShellKind,
} from "./renderer-shell-scope";
import {
  applyRuntimeChooserOverrideFromUrl,
  removeUrlParameter,
} from "./runtime-chooser-override";
import {
  isElizaCloudSharedHost,
  isTrustedCloudOnlyApiBaseUrl,
} from "./url-trust-policy";

declare const __ELIZA_BUILD_VARIANT__: string | undefined;
// Set by vite.config.ts `define`. `true` for the web/desktop bundle, `false`
// for Capacitor mobile builds so the entire cloud router shell + Steward/wallet
// + public-page chunks tree-shake out of the native bundle.
declare const __ELIZA_WEB_SHELL__: boolean | undefined;
declare const __ELIZA_SERVICE_WORKER__: boolean | undefined;
declare const __ELIZA_CHAT_UI_HARNESS__: boolean | undefined;

declare global {
  interface Window {
    __ELIZA_APP_SHARE_QUEUE__?: ShareTargetPayload[];
    __ELIZA_APP_API_BASE__?: string;
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (event: Record<string, unknown>) => void;
  }
}

const { createRoot } = ReactDomClient;
// Keep one renderer owner across entry-module HMR. An in-flight boot finishes
// bridge initialization once, then renders through the latest mount callback.
const rendererBootstrap: {
  root: ReturnType<typeof createRoot> | null;
  bootPromise: Promise<void> | null;
  mount: () => void;
  deepLinksInitialized: boolean;
} = import.meta.hot?.data.rendererBootstrap ?? {
  root: null,
  bootPromise: null,
  mount: mountReactApp,
  deepLinksInitialized: false,
};
rendererBootstrap.mount = mountReactApp;
if (import.meta.hot) {
  import.meta.hot.data.rendererBootstrap = rendererBootstrap;
}

let deferredAppModuleLoadsScheduled = false;

// Renderer cold-start telemetry (#9565). The trace adopts a native-host-injected
// id when present (Electrobun/Capacitor) so one device launch shares a single
// id across the native host trace + this renderer trace + backend boot
// telemetry; otherwise it derives a renderer-local id. `module-eval` is the
// earliest renderer-JS checkpoint after the import graph evaluates.
initStartupTrace();
markStartup("module-eval", { platform: Capacitor.getPlatform() });

// Contribute this build's plugin-owned host-external importers to
// DynamicViewLoader before any view can load. Synchronous + idempotent, so it
// is safe to run at the earliest renderer checkpoint.
registerAppHostExternalImporters();

function importPersonalAssistant() {
  return cachedDynamicImport(
    "@elizaos/plugin-personal-assistant",
    () => import("@elizaos/plugin-personal-assistant"),
  );
}

function importAppPhone() {
  return cachedDynamicImport(
    "@elizaos/plugin-phone",
    () => import("@elizaos/plugin-phone"),
  );
}

function importAppTaskCoordinator() {
  return cachedDynamicImport(
    "@elizaos/plugin-task-coordinator",
    () => import("@elizaos/plugin-task-coordinator"),
  );
}

function importAppTaskCoordinatorRegister() {
  return cachedDynamicImport(
    "@elizaos/plugin-task-coordinator/register",
    () => import("@elizaos/plugin-task-coordinator/register"),
  );
}

function importAppRelationshipsRegister() {
  return cachedDynamicImport(
    "@elizaos/plugin-relationships/register",
    () => import("@elizaos/plugin-relationships/register"),
  );
}

function lazyNamedComponent<TProps>(
  load: () => Promise<ComponentType<TProps>>,
): ComponentType<TProps> {
  return lazy(async () => ({ default: await load() })) as ComponentType<TProps>;
}

/**
 * Tab/view App is dynamically imported so anonymous `/login` (CloudRouterShell
 * public routes) does not static-import the full agent dashboard graph into the
 * entry modulepreload list (#18056). Native / non-shell paths still mount it
 * under the same Suspense boundary as the rest of the tree.
 */
const App = lazy(async () => {
  const mod = await import("@elizaos/ui/App");
  return { default: mod.App };
});

const AppWindowRenderer = lazyNamedComponent<{ slug: string }>(async () => {
  const mod = await import("@elizaos/ui/components/apps/AppWindowRenderer");
  return mod.AppWindowRenderer;
});

const ShellViewAgentSurface = lazyNamedComponent<{
  viewId: string;
  surfaceKind: "app-shell";
  children: ReactNode;
}>(async () => {
  const mod = await import(
    "@elizaos/ui/components/views/ShellViewAgentSurface"
  );
  return mod.ShellViewAgentSurface;
});

/** Desktop-only shell widgets — never static-import into the login entry. */
const DesktopSurfaceNavigationRuntime = lazyNamedComponent<
  Record<string, never>
>(async () => {
  const mod = await import("@elizaos/app-core/desktop-shell");
  return mod.DesktopSurfaceNavigationRuntime;
});
const DesktopTrayRuntime = lazyNamedComponent<Record<string, never>>(
  async () => {
    const mod = await import("@elizaos/app-core/desktop-shell");
    return mod.DesktopTrayRuntime;
  },
);
const DetachedShellRoot = lazyNamedComponent<DetachedShellRootProps>(
  async () => {
    const mod = await import("@elizaos/app-core/desktop-shell");
    return mod.DetachedShellRoot;
  },
);

const PhoneCompanionApp = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppPhone()).PhoneCompanionApp,
);

async function runIosFullBunSmokeFromDesktopShell(): Promise<boolean> {
  const mod = await import("@elizaos/app-core/desktop-shell");
  return mod.runIosFullBunSmokeIfRequested();
}

async function buildLocalizedTrayMenuAsync(
  ...args: Parameters<
    typeof import("@elizaos/app-core/desktop-shell").buildLocalizedTrayMenu
  >
) {
  const mod = await import("@elizaos/app-core/desktop-shell");
  return mod.buildLocalizedTrayMenu(...args);
}
const AppBlockerSettingsCard = lazyNamedComponent<AppBlockerSettingsCardProps>(
  async () => (await importPersonalAssistant()).AppBlockerSettingsCard,
);
const WebsiteBlockerSettingsCard =
  lazyNamedComponent<WebsiteBlockerSettingsCardProps>(
    async () => (await importPersonalAssistant()).WebsiteBlockerSettingsCard,
  );
const CodingAgentControlChip = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppTaskCoordinator()).CodingAgentControlChip,
);
const CodingAgentSettingsSection = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppTaskCoordinator()).CodingAgentSettingsSection,
);
const CodingAgentTasksPanel = lazyNamedComponent<CodingAgentTasksPanelProps>(
  async () => (await importAppTaskCoordinator()).CodingAgentTasksPanel,
);
const BRANDED_WINDOW_KEYS = {
  apiBase: `__${APP_ENV_PREFIX}_API_BASE__`,
  shareQueue: `__${APP_ENV_PREFIX}_SHARE_QUEUE__`,
} as const;

function isShareTargetQueue(value: unknown): value is ShareTargetPayload[] {
  return Array.isArray(value);
}

function getLegacyInjectedAppApiBase(): string | undefined {
  const brandedApiBase: unknown = Reflect.get(
    window,
    BRANDED_WINDOW_KEYS.apiBase,
  );
  return (
    window.__ELIZA_APP_API_BASE__ ??
    (typeof brandedApiBase === "string" ? brandedApiBase : undefined)
  );
}

// Resolve the desktop "cloud-only" runtime-mode signal from whichever path is
// available before React boots. Undefined on web/mobile and on default desktop.
//   - Packaged desktop (electrobun static server): a window global is injected
//     ahead of renderer JS by api-base-owner.injectIntoHtml.
//   - Dev (`dev:desktop`, Vite) and cloud-only renderer builds: exposed as the
//     `VITE_ELIZA_DESKTOP_RUNTIME_MODE` build env, since Vite serves index.html
//     directly and the static-server inject never runs.
function getInjectedDesktopRuntimeMode(): string | undefined {
  if (typeof window !== "undefined") {
    const injected: unknown = Reflect.get(
      window,
      "__ELIZA_DESKTOP_RUNTIME_MODE__",
    );
    if (typeof injected === "string" && injected) return injected;
  }
  const fromEnv = (import.meta.env as Record<string, string | undefined>)
    .VITE_ELIZA_DESKTOP_RUNTIME_MODE;
  return typeof fromEnv === "string" && fromEnv ? fromEnv : undefined;
}

const APP_BRANDING: Partial<BrandingConfig> = {
  ...APP_BRANDING_BASE,
  theme: ELIZA_DEFAULT_THEME,
  // The hosted web bundle stays cloud-only in production. Desktop shells seed
  // the typed boot config before renderer modules evaluate (with the branded
  // window key retained as a legacy fallback), and that host backend should
  // control first-run capabilities instead — UNLESS the desktop shell explicitly
  // opted into cloud-only mode, which remains authoritative over a loopback base.
  cloudOnly: resolveAppCloudOnlyBranding({
    isDev: import.meta.env.DEV ?? false,
    bootApiBase:
      getBootConfig().apiBase ?? getMobileRemoteFallbackApiBase() ?? undefined,
    legacyInjectedApiBase:
      typeof window === "undefined" ? undefined : getLegacyInjectedAppApiBase(),
    isNativePlatform: Capacitor.isNativePlatform(),
    nativeRuntimeMode:
      isAndroidCloudBuild() && !getMobileRemoteFallbackApiBase()
        ? "cloud"
        : undefined,
    desktopRuntimeMode: getInjectedDesktopRuntimeMode(),
  }),
};

const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";
const isStoreBuild =
  typeof __ELIZA_BUILD_VARIANT__ === "string" &&
  __ELIZA_BUILD_VARIANT__ === "store";
const IOS_RUNTIME_ENV_CONFIG = resolveIosRuntimeConfig(import.meta.env);
configureStoredStewardTokenScope(IOS_RUNTIME_ENV_CONFIG.cloudApiBase);
const DEVICE_BRIDGE_ID_KEY = `${APP_NAMESPACE}_device_bridge_id`;
const BACKGROUND_RUNNER_LABEL = "eliza-tasks";
const BACKGROUND_RUNNER_CONFIG_RETRY_MS = 5_000;
const IOS_ONBOARDING_SMOKE_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY =
  "eliza:ios-cloud-onboarding-smoke:request";
const IOS_CLOUD_ONBOARDING_SMOKE_RESULT_KEY =
  "eliza:ios-cloud-onboarding-smoke:result";
const IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY = "eliza:auth-callback-smoke:request";
const IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY = "eliza:auth-callback-smoke:result";
const IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY =
  "eliza:ios-onboarding-relaunch-smoke:request";
const IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY =
  "eliza:ios-onboarding-relaunch-smoke:result";
const IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY =
  "eliza:ios-mixed-content-smoke:request";
const IOS_MIXED_CONTENT_SMOKE_RESULT_KEY =
  "eliza:ios-mixed-content-smoke:result";
const IOS_ONBOARDING_SMOKE_TIMEOUT_MS = 120_000;
const CLOUD_PAIR_SESSION_TOKEN_KEY = "eliza:cloud-pair:api-token";

let mobileDeviceBridgeClient: DeviceBridgeClient | null = null;
let cameraBridgeResponderStop: (() => void) | null = null;
let mobileDeviceBridgeStartPromise: Promise<void> | null = null;
let mobileAgentTunnelListener: PluginListenerHandle | null = null;
let mobileAgentTunnelStartPromise: Promise<void> | null = null;
let mobileRuntimeModeListenerInstalled = false;
let iosOnboardingSmokeStarted = false;
let iosCloudOnboardingSmokeStarted = false;
let iosOnboardingRelaunchSmokeStarted = false;
let iosMixedContentSmokeStarted = false;

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

const windowShellRoute = resolveWindowShellRoute();

function hasFirstRunRuntimeOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const runtime = getWindowUrlSearchParams().get("runtime");
    return runtime === "first-run";
  } catch {
    // error-policy:J3 unparseable location params — no override requested
    return false;
  }
}

function getWindowUrlSearchParams(): URLSearchParams {
  const search = window.location?.search ?? "";
  const hashSearch = window.location?.hash?.split("?")[1] ?? "";
  return new URLSearchParams(search || hashSearch);
}

function applyCloudPairSessionToken(): void {
  if (typeof window === "undefined") return;
  // Gate 0 — trusted shell. The durable pair credential is adopted only by
  // the real app shell; an embedded third-party surface (Telegram Mini App /
  // Discord Activity iframe, #9947) must not read, migrate, or stamp it —
  // those surfaces get a scoped session from the embed handshake instead.
  if (isEmbedPath(window.location.pathname)) return;
  // Gate 1 — resolve an owner-bound target BEFORE touching bearer storage.
  // Canonical agent subdomains carry the owner in their hostname. Local
  // Docker origins do not, so their relay leaves a UUID-only hint on the same
  // strict loopback origin; arbitrary public origins can never use that seam.
  const currentOrigin = window.location.origin;
  let apiBase: string;
  let agentId: string | null = null;
  let usedLocalOwnerHint = false;
  if (isDedicatedCloudAgentBase(currentOrigin)) {
    apiBase = currentOrigin;
    agentId = dedicatedCloudAgentIdFromBase(apiBase);
  } else {
    const configuredBase = getBootConfig().apiBase?.trim();
    if (configuredBase && isDedicatedCloudAgentBase(configuredBase)) {
      apiBase = configuredBase;
      agentId = dedicatedCloudAgentIdFromBase(apiBase);
    } else if (!isCloudPairLoopbackOrigin(currentOrigin)) {
      return;
    } else {
      let ownerHint: string | null = null;
      try {
        ownerHint =
          window.sessionStorage
            .getItem(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)
            ?.trim() || null;
      } catch {
        // error-policy:J4 hardened browser storage may reject session reads;
        // durable storage remains the local relay's compatibility channel.
      }
      if (!ownerHint) {
        try {
          ownerHint =
            window.localStorage
              .getItem(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)
              ?.trim() || null;
        } catch {
          // error-policy:J4 unreadable local storage means no owner-bound local
          // session can be adopted.
        }
      }
      if (!isCloudPairAgentId(ownerHint)) return;
      apiBase = currentOrigin;
      agentId = ownerHint;
      usedLocalOwnerHint = true;
    }
  }
  // Gate 2 — every accepted target must resolve to one dedicated-agent owner.
  if (!agentId) return;
  // Gate 3 — owner-bound read. The durable credential is stored under a
  // per-agent key (`eliza:cloud-pair:api-token:<agentId>`), so this boot only
  // ever reads the key belonging to the agent it resolved. A token persisted
  // for agent A is invisible to a boot targeting agent B — it can never be
  // adopted or mirrored across agents (#17579).
  const agentTokenKey = cloudPairTokenKeyForAgent(agentId);
  let token: string | null = null;
  try {
    token = window.localStorage.getItem(agentTokenKey)?.trim() || null;
  } catch {
    // error-policy:J4 localStorage can be unavailable in hardened browser
    // contexts — sessionStorage remains the compatibility handoff.
  }
  if (!token) {
    try {
      token = window.sessionStorage.getItem(agentTokenKey)?.trim() || null;
    } catch {
      // error-policy:J4 sessionStorage can be unavailable in hardened browser
      // contexts — the pairing token is simply not adopted.
    }
    if (token) {
      try {
        shellLocalStorage.setItem(agentTokenKey, token);
      } catch {
        // error-policy:J4 migration is best-effort; the same-tab token still
        // authenticates this launch.
      }
    }
  }
  // Gate 4 — legacy single-key migration with target equality. A pre-#17579
  // install stored the bearer under the global `eliza:cloud-pair:api-token`
  // key with no owner binding. That key is adopted ONLY when the persisted
  // active server for THIS agent still carries the identical bearer — i.e.
  // the local record proves the legacy credential belongs to the agent being
  // booted. Without that proof the legacy key is left untouched (never
  // mirrored onto an agent that cannot claim it) and the pairing flow writes
  // the scoped key on the next explicit pair.
  if (!token) {
    let legacyToken: string | null = null;
    try {
      legacyToken =
        window.localStorage.getItem(CLOUD_PAIR_SESSION_TOKEN_KEY)?.trim() ||
        null;
    } catch {
      // error-policy:J4 unreadable legacy storage — no adoption.
    }
    if (legacyToken) {
      try {
        const activeServer = loadPersistedActiveServer();
        const ownedByTarget =
          activeServer !== null &&
          resolveDedicatedAgentId(activeServer) === agentId &&
          activeServer.accessToken === legacyToken;
        if (ownedByTarget) {
          token = legacyToken;
          try {
            shellLocalStorage.setItem(agentTokenKey, token);
          } catch {
            // error-policy:J4 best-effort migration write.
          }
          try {
            shellLocalStorage.removeItem(CLOUD_PAIR_SESSION_TOKEN_KEY);
          } catch {
            // error-policy:J3 best-effort legacy cleanup.
          }
        }
      } catch {
        // error-policy:J4 unreadable active-server record — legacy key stays
        // unadopted rather than being stamped onto an unproven target.
      }
    }
  }
  if (!token) return;
  client.setToken(token);
  const activeServer = createPersistedActiveServer({
    kind: "cloud",
    ...(agentId ? { id: `cloud:${agentId}` } : {}),
    apiBase,
    accessToken: token,
  });
  savePersistedActiveServer(activeServer);
  upsertAndActivateAgentProfile({
    kind: "cloud",
    label: activeServer.label,
    cloudAgentId: agentId,
    ...(activeServer.apiBase ? { apiBase: activeServer.apiBase } : {}),
    accessToken: token,
  });
  if (usedLocalOwnerHint) {
    const persisted = loadPersistedActiveServer();
    const sessionDurable =
      persisted !== null &&
      resolveDedicatedAgentId(persisted) === agentId &&
      persisted.apiBase === apiBase &&
      persisted.accessToken === token;
    if (!sessionDurable) return;
    try {
      window.sessionStorage.removeItem(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY);
    } catch {
      // error-policy:J6 the persisted active server now owns this session; a
      // blocked best-effort hint cleanup cannot invalidate the adopted token.
    }
    try {
      shellLocalStorage.removeItem(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY);
    } catch {
      // error-policy:J6 the non-secret hint is redundant after persistence.
    }
  }
}

/**
 * Adds `eliza-electrobun-frameless` for CSS `-webkit-app-region` (Chromium/CEF).
 * macOS WKWebView move/resize are still driven by native overlays in
 * window-effects.mm; this class mainly marks the shell and helps non-WK engines.
 */
function shouldEnableElectrobunMacWindowDrag(): boolean {
  if (!isElectrobunRuntime() || typeof document === "undefined") return false;
  if (isStandaloneWindowShell(windowShellRoute)) return false;
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Mac/i.test(ua) && !/(iPhone|iPad|iPod)/i.test(ua);
}

if (shouldEnableElectrobunMacWindowDrag()) {
  document.documentElement.classList.add(
    "eliza-electrobun-frameless",
    "eliza-electrobun-macos-titlebar",
  );
}

// Dev escape hatches: ?reset forces a truly fresh first-run session by
// clearing persisted state; ?onboarding-replay=1 (dev builds only, #14382)
// re-runs onboarding as a non-destructive client overlay on the SAME agent —
// no reset endpoint, no active-server clear, no storage wipe. Ordering between
// the two lives in first-run-boot-patches.ts and is regression-tested.
installMainWindowFirstRunBootPatches(client, windowShellRoute);
installLocalProviderCloudPreferencePatch(client);
installDesktopPermissionsClientPatch(client);
applyCloudPairSessionToken();
applyRuntimeChooserOverrideFromUrl();
installPackagedShellStorageTestBridge();

// Branded AOSP/ElizaOS device images ARE the agent: pre-seed the on-device
// agent as the startup target on first frame. Stock-phone sideload builds
// self-exclude inside preSeedAndroidLocalRuntimeIfFresh (#14390): a fresh
// install lands in onboarding; when that build explicitly enables the runtime
// chooser, the local agent starts on demand only after the user picks it.
// No-op on iOS/desktop/web and cloud builds.
if (!isAndroidCloudBuild() && !hasFirstRunRuntimeOverride()) {
  preSeedAndroidLocalRuntimeIfFresh();
}

const APP_STYLE_PRESETS = getStylePresets();

const APP_VRM_ASSETS = APP_STYLE_PRESETS.slice()
  .sort((a, b) => a.avatarIndex - b.avatarIndex)
  .map((p) => ({ title: p.name, slug: `eliza-${p.avatarIndex}` }));

let appModulesInitialized: Promise<void> | null = null;
const SIDE_EFFECT_APP_MODULE_LOAD_CONCURRENCY = 2;

function importSideEffectAppModule(
  key: string,
  loader: () => Promise<unknown>,
) {
  return cachedDynamicImport(key, loader);
}

function scheduleAppModuleIdleWork(work: () => void): void {
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
    w.requestIdleCallback(work, { timeout: 3_000 });
    return;
  }
  window.setTimeout(work, 50);
}

function scheduleAfterReactPaint(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(work);
    });
    return;
  }

  window.setTimeout(work, 0);
}

function scheduleAppModuleIdleLoads(
  loaders: readonly SideEffectAppModuleLoader[],
): void {
  if (loaders.length === 0) return;
  let nextIndex = 0;
  let activeCount = 0;

  const pump = () => {
    while (
      activeCount < SIDE_EFFECT_APP_MODULE_LOAD_CONCURRENCY &&
      nextIndex < loaders.length
    ) {
      const registration = loaders[nextIndex];
      if (!registration) break;
      const { key, load } = registration;
      nextIndex += 1;
      activeCount += 1;
      void importSideEffectAppModule(key, load)
        // error-policy:J4 deferred enhancement modules — a load failure is
        // logged and the app stays usable without that module
        .catch((error) => {
          console.warn(`${APP_LOG_PREFIX} Failed to load ${key}:`, error);
        })
        .finally(() => {
          activeCount -= 1;
          if (nextIndex < loaders.length) {
            scheduleAppModuleIdleWork(pump);
          }
        });
    }
  };

  scheduleAppModuleIdleWork(pump);
}

function installRendererServiceHost(): void {
  // The host must exist before any side-effect registration module can load:
  // plugin `register` entries declare lifecycle-scoped renderer services
  // (registerRendererService) instead of starting work at import time, and the
  // host is what starts eligible services in THIS window's shell and retains
  // their disposers for pagehide/replacement teardown. Scope resolution reuses
  // the exact boot inputs the shell branches on, so a popout/detached/
  // companion/app-window/embed renderer never runs main-scoped
  // background services like LifeOps activity capture.
  startRendererServiceHost({
    shell: resolveRendererShellKind({
      windowShellRoute,
      isPopout: isPopoutWindow(),
      isPhoneCompanion: isPhoneCompanionMode(),
      appWindowSlug: resolveAppWindowSlug(),
      isEmbedRoute: isEmbedPath(window.location.pathname),
    }),
    reportError: (serviceId, error, phase) => {
      console.error(
        `${APP_LOG_PREFIX} renderer service "${serviceId}" ${phase} failed:`,
        error,
      );
    },
  });
}

function scheduleDeferredAppModuleLoadsAfterPaint(): void {
  if (deferredAppModuleLoadsScheduled) return;
  deferredAppModuleLoadsScheduled = true;
  installRendererServiceHost();

  scheduleAfterReactPaint(() => {
    // These modules register routes, tabs, overlay apps, and feature surfaces,
    // but no component from them is needed to paint the startup shell. Schedule
    // them only after React has had a paint opportunity so idle imports cannot
    // compete with the first visible boot surface.
    scheduleAppModuleIdleLoads(BOOT_CONFIG_DEFERRED_MODULE_LOADERS);
    scheduleAppModuleIdleLoads(SIDE_EFFECT_APP_MODULE_LOADERS);
  });
}

function buildAppBootConfig(): AppBootConfig {
  const current = getBootConfig();

  return {
    ...current,
    branding: APP_BRANDING,
    defaultApps: APP_CONFIG.defaultApps,
    assetBaseUrl:
      (import.meta.env.VITE_ASSET_BASE_URL as string | undefined)?.trim() ||
      undefined,
    cloudApiBase: IOS_RUNTIME_ENV_CONFIG.cloudApiBase,
    autoUpgradeSharedToDedicated: true,
    vrmAssets: APP_VRM_ASSETS,
    firstRunStyles: APP_STYLE_PRESETS,
    codingAgentTasksPanel: CodingAgentTasksPanel,
    codingAgentSettingsSection: CodingAgentSettingsSection,
    codingAgentControlChip: CodingAgentControlChip,
    characterCatalog: APP_CHARACTER_CATALOG,
    envAliases: APP_ENV_ALIASES,
    appBlockerSettingsCard: AppBlockerSettingsCard,
    websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
    clientMiddleware: {
      forceFreshFirstRun:
        shouldInstallMainWindowFirstRunPatches(windowShellRoute),
      preferLocalProvider: true,
      desktopPermissions: isDesktopPlatform(),
    },
  };
}

// App plugins imported for their self-registration side effects (PA HTTP client
// + Blocker cards, task-coordinator surfaces, phone, steward, training) and to
// pre-warm their React.lazy chunks. The boot config
// only references these as React.lazy handles (see buildAppBootConfig), so NONE
// is read synchronously while assembling the config — they must not gate the
// first visible shell (#9565). Deferred onto the idle path like
// SIDE_EFFECT_APP_MODULE_LOADERS; on-demand render still triggers the cached
// import if idle work has not run yet, so no surface can be missed.
const BOOT_CONFIG_DEFERRED_MODULE_LOADERS: readonly SideEffectAppModuleLoader[] =
  [
    {
      key: "@elizaos/plugin-personal-assistant",
      load: importPersonalAssistant,
    },
    { key: "@elizaos/plugin-task-coordinator", load: importAppTaskCoordinator },
    {
      key: "@elizaos/plugin-task-coordinator/register",
      load: importAppTaskCoordinatorRegister,
    },
    {
      key: "@elizaos/plugin-relationships/register",
      load: importAppRelationshipsRegister,
    },
    { key: "@elizaos/plugin-phone", load: importAppPhone },
  ];

function initializeAppModules(): Promise<void> {
  appModulesInitialized ??= (() => {
    // app-core owns the AppBootConfig singleton and is already evaluated: this
    // module statically imports its desktop bindings, so the whole package
    // loads with the entry chunk before main() runs. A dynamic
    // import("@elizaos/app-core") here would be a runtime no-op, but its
    // escaping namespace would force Rollup to retain every export of the
    // barrel (`export * from "@elizaos/ui/browser"`) in the startup-critical
    // entry chunk (#13187). Everything else exposed through the boot config is
    // a React.lazy handle that loads on render, so its import is deferred onto
    // the idle path instead of gating the first visible shell (#9565).
    setBootConfig(buildAppBootConfig());
    return Promise.resolve();
  })();

  return appModulesInitialized;
}

function getShareQueue(): ShareTargetPayload[] {
  const brandedQueue: unknown = Reflect.get(
    window,
    BRANDED_WINDOW_KEYS.shareQueue,
  );
  const existing =
    window.__ELIZA_APP_SHARE_QUEUE__ ??
    (isShareTargetQueue(brandedQueue) ? brandedQueue : undefined);
  if (existing) {
    window.__ELIZA_APP_SHARE_QUEUE__ = existing;
    Reflect.set(window, BRANDED_WINDOW_KEYS.shareQueue, existing);
    return existing;
  }
  const queue: ShareTargetPayload[] = [];
  window.__ELIZA_APP_SHARE_QUEUE__ = queue;
  Reflect.set(window, BRANDED_WINDOW_KEYS.shareQueue, queue);
  return queue;
}

function dispatchShareTarget(payload: ShareTargetPayload): void {
  getShareQueue().push(payload);
  dispatchAppEvent(SHARE_TARGET_EVENT, payload);
}

function logNativePluginUnavailable(pluginName: string, error: unknown): void {
  console.warn(
    `${APP_LOG_PREFIX} ${pluginName} plugin not available:`,
    error instanceof Error ? error.message : error,
  );
}

async function writeIosOnboardingSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(IOS_ONBOARDING_SMOKE_RESULT_KEY, result);
}

async function writeIosCloudOnboardingSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_CLOUD_ONBOARDING_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosOnboardingRelaunchSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosMixedContentSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_MIXED_CONTENT_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosAuthCallbackSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY,
    result,
  );
}

interface AuthCallbackDeepLinkOutcome {
  accepted: boolean;
  classification: "synthetic_callback_rejected";
  reason: string;
}

function rejectOsDeliveredAuthCallback(): AuthCallbackDeepLinkOutcome {
  return {
    accepted: false,
    classification: "synthetic_callback_rejected",
    reason: "os_delivered_auth_callback_rejected",
  };
}

function readActiveServerSessionSnapshot(): string {
  return window.localStorage.getItem("elizaos:active-server") ?? "";
}

async function writeIosPreferenceSmokeResult(
  key: string,
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    // shellLocalStorage, not Storage.prototype.call: the surface-realm guard
    // Proxy does not forward Storage internal slots, so a prototype-bound call
    // throws "Illegal invocation" once any view has mounted.
    shellLocalStorage.setItem(key, value);
  } catch {
    // error-policy:J6 best-effort echo — Preferences is the simulator
    // harness source of truth
  }
  await boundedPreferenceWrite(() =>
    Preferences.set({
      key,
      value,
    }),
  );
}

async function boundedPreferenceWrite(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await Promise.race([
      operation(),
      new Promise((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
  } catch {
    // error-policy:J7 smoke-harness diagnostics write — the storage bridge
    // also issued a fire-and-forget Preferences write from
    // localStorage.setItem. The simulator smoke will keep polling the native
    // defaults domain, but the WebView must not block forever on persistence.
  }
}

async function boundedPreferenceGet(key: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      Preferences.get({ key }),
      new Promise<null>((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
    return result?.value ?? null;
  } catch {
    // error-policy:J7 smoke-harness preference probe — a blocked Preferences
    // bridge must not wedge the smoke; the poll loop retries
    return null;
  }
}

function parseIosOnboardingSmokeRequest(raw: string | null): {
  apiBase: string;
  // Liveness contract (#14359): when the harness points the lane at a
  // live-provider host it sets `liveness: true` so the verifier drives one real
  // chat turn after landing on home and reports the reply for the shared
  // non-stub assertion. Default false — the deterministic host is stub-backed.
  liveness: boolean;
  livenessPrompt: string;
} {
  const fallback = {
    apiBase: "http://127.0.0.1:31338",
    liveness: false,
    livenessPrompt: "In one short sentence, say hello.",
  };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      apiBase?: unknown;
      liveness?: unknown;
      livenessPrompt?: unknown;
    };
    return {
      apiBase:
        typeof parsed.apiBase === "string" && parsed.apiBase.trim()
          ? parsed.apiBase.trim()
          : fallback.apiBase,
      liveness: parsed.liveness === true,
      livenessPrompt:
        typeof parsed.livenessPrompt === "string" &&
        parsed.livenessPrompt.trim()
          ? parsed.livenessPrompt.trim()
          : fallback.livenessPrompt,
    };
  } catch {
    // error-policy:J3 corrupt smoke-request blob — run with the defaults
    return fallback;
  }
}

async function readIosMixedContentSmokeRequest(
  fallbackApiBase?: string,
): Promise<{ apiBase: string } | null> {
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest && !fallbackApiBase) return null;
  return parseIosOnboardingSmokeRequest(
    rawRequest ?? JSON.stringify({ apiBase: fallbackApiBase }),
  );
}

async function waitForIosOnboardingElement<T extends Element>(
  selector: string,
  options?: { timeoutMs?: number; visible?: boolean },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastElement: Element | null = null;
  while (Date.now() < deadline) {
    lastElement = document.querySelector(selector);
    if (lastElement) {
      const visible =
        !options?.visible ||
        (lastElement instanceof HTMLElement &&
          lastElement.offsetParent !== null);
      if (visible) return lastElement as T;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for iOS onboarding selector ${selector}${lastElement ? " to become visible" : ""}`,
  );
}

function readIosOnboardingSmokeStorageSnapshot(): Record<
  string,
  string | null
> {
  const keys = [
    "eliza:first-run-complete",
    "eliza:setup:step",
    "eliza:mobile-runtime-mode",
    "elizaos:active-server",
  ];
  return Object.fromEntries(
    keys.map((key) => {
      try {
        return [key, window.localStorage.getItem(key)];
      } catch {
        // error-policy:J7 diagnostics snapshot — an unreadable key reports null
        return [key, null];
      }
    }),
  );
}

function readIosCloudOnboardingSmokeStorageSnapshot(): Record<
  string,
  string | boolean | null
> {
  const base = readIosOnboardingSmokeStorageSnapshot();
  let stewardSessionToken = "";
  try {
    stewardSessionToken =
      window.localStorage.getItem("steward_session_token") ?? "";
  } catch {
    // error-policy:J7 diagnostics snapshot — an unreadable key reports false
    stewardSessionToken = "";
  }
  return {
    ...base,
    stewardSessionPresent: stewardSessionToken.length > 0,
  };
}

async function waitForIosOnboardingSmokeStorageSnapshot(
  apiBase: string,
): Promise<Record<string, string | null>> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  let snapshot = readIosOnboardingSmokeStorageSnapshot();
  while (Date.now() < deadline) {
    const activeServer = snapshot["elizaos:active-server"];
    if (typeof activeServer === "string" && activeServer.includes(apiBase)) {
      return snapshot;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    snapshot = readIosOnboardingSmokeStorageSnapshot();
  }
  throw new Error(
    `Timed out waiting for iOS onboarding active server ${apiBase}: ${JSON.stringify(snapshot)}`,
  );
}

const IOS_LIVENESS_ASSISTANT_SELECTOR =
  '[data-role="assistant"], [data-testid="chat-message-assistant"], [data-testid="thread-line"][data-role="assistant"]';

// Set a React-controlled textarea's value so React's onChange fires. Assigning
// `.value` directly bypasses React's synthetic value tracker, so we call the
// native prototype setter first, then dispatch a bubbling `input` event — the
// canonical way to drive a controlled input from outside React.
function setReactTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!setter) {
    throw new Error("HTMLTextAreaElement value setter unavailable");
  }
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Drive one real chat turn in-app and return the rendered assistant reply, so
 * the harness can enforce the shared liveness contract (#14359) against a
 * live-provider host. The SIWE cloud lane always drives it (#16936); the
 * remote-connect lane still opts in with `liveness: true`, because that lane
 * also runs against the deterministic stub host.
 *
 * Fail-closed reply selection (#16936 review): only assistant rows that did
 * not exist before the send are considered, and — when the prompt carries a
 * run-unique challenge token — a row counts only once its text contains that
 * token. The pending overlay row renders a status label ("Thinking") as its
 * text content before any model token arrives; reading any non-empty new row
 * would accept that placeholder, so the token requirement is what proves a
 * real model answered this exact turn. A tokenless prompt (the remote-connect
 * default hello) falls back to requiring a reply-phase body on the new row,
 * which the pending row can never satisfy because the renderer marks it
 * `data-phase="status"` until real content exists.
 */
async function driveIosLivenessChatTurn(prompt: string): Promise<string> {
  const composer = await waitForIosOnboardingElement<HTMLTextAreaElement>(
    '[data-testid="chat-composer-textarea"]',
    { visible: true },
  );
  const priorReplies = document.querySelectorAll(
    IOS_LIVENESS_ASSISTANT_SELECTOR,
  ).length;
  const expectedToken = extractIosLivenessChallengeToken(prompt);

  composer.focus();
  setReactTextareaValue(composer, prompt);
  const send = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]',
  );
  if (send && !send.disabled) {
    send.click();
  } else {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  }

  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  // Invariant: the overlay transcript only appends rows during a turn, so
  // indices at or beyond the pre-send snapshot are exactly this run's rows.
  while (Date.now() < deadline) {
    const replies = document.querySelectorAll<HTMLElement>(
      IOS_LIVENESS_ASSISTANT_SELECTOR,
    );
    for (let index = priorReplies; index < replies.length; index += 1) {
      const row = replies[index];
      // A pending row (status phase) can never be the reply — its text is the
      // "Thinking"/"Running …" placeholder. This also blocks status chrome
      // that echoes the prompt text from satisfying the token gate.
      if (!isIosLivenessReplyRow(row)) continue;
      const text = row?.textContent?.trim() ?? "";
      if (!text) continue;
      if (expectedToken) {
        // The run-unique token can only appear in text produced by something
        // that saw this run's prompt — never in a status label or cached row.
        if (text.toLowerCase().includes(expectedToken)) return text;
      } else {
        return text;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    "iOS liveness chat turn: assistant never produced a reply within the timeout",
  );
}

/**
 * Thin re-exports of the pure, unit-tested smoke contract in
 * `ios-cloud-onboarding-smoke.ts`: fail-closed reply-row classification (the
 * overlay's `data-phase` marker is authoritative) and the smoke-request parser
 * whose behavior #16936's coverage bar names explicitly.
 */
function isIosLivenessReplyRow(row: Element | undefined): boolean {
  return isIosLivenessReplyRowFromContract(row);
}

function parseIosCloudOnboardingSmokeRequest(
  raw: string | null,
): IosCloudOnboardingSmokeRequest {
  return parseIosCloudOnboardingSmokeRequestFromContract(raw);
}

function installFirstRunPostCounter(): {
  getCount: () => number;
  restore: () => void;
} {
  const originalFetch = window.fetch.bind(window);
  let firstRunPostCount = 0;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method =
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET");
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      String(method).toUpperCase() === "POST" &&
      /\/api\/first-run(?:[?#]|$)/.test(url)
    ) {
      firstRunPostCount += 1;
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
  return {
    getCount: () => firstRunPostCount,
    restore: () => {
      window.fetch = originalFetch;
    },
  };
}

async function waitForIosCloudSignInGreeting(): Promise<boolean> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = document.body?.innerText ?? "";
    if (/Sign in to Eliza(?: Cloud)?/i.test(text)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Eliza Cloud sign-in greeting");
}

async function triggerIosCloudSignInAction(): Promise<void> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tryHandleFirstRunAction(FIRST_RUN_CLOUD_LOGIN_ACTION)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the cloud sign-in action handler");
}

async function waitForIosCloudOnboardingHome(): Promise<{
  home: HTMLElement;
  composer: HTMLElement;
}> {
  const home = await waitForIosOnboardingElement<HTMLElement>(
    '[data-testid="home-launcher-surface"][data-page="home"]',
    { visible: true, timeoutMs: IOS_ONBOARDING_SMOKE_TIMEOUT_MS },
  );
  const composer = await waitForIosOnboardingElement<HTMLElement>(
    '[data-testid="chat-composer-textarea"]',
    { visible: true, timeoutMs: IOS_ONBOARDING_SMOKE_TIMEOUT_MS },
  );
  return { home, composer };
}

async function runIosCloudOnboardingSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosCloudOnboardingSmokeStarted) {
    return iosCloudOnboardingSmokeStarted;
  }
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest) return false;

  iosCloudOnboardingSmokeStarted = true;
  const request = parseIosCloudOnboardingSmokeRequest(rawRequest);
  const firstRunCounter = installFirstRunPostCounter();
  await writeIosCloudOnboardingSmokeResult({
    ok: false,
    phase: "running",
    mode: request.mode,
    startedAt: new Date().toISOString(),
  });

  try {
    let signInGreetingVisible = false;
    if (request.mode === "tap") {
      signInGreetingVisible = await waitForIosCloudSignInGreeting();
      await triggerIosCloudSignInAction();
    }

    const { home, composer } = await waitForIosCloudOnboardingHome();
    const storage = readIosCloudOnboardingSmokeStorageSnapshot();
    const firstRunPostCount = firstRunCounter.getCount();
    const activeServer = storage["elizaos:active-server"];
    const cloudActiveServer =
      typeof activeServer === "string" &&
      activeServer.includes('"kind":"cloud"');
    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );

    // Liveness contract (#14359 / #16936): the cloud agent is
    // SIWE-provisioned and live, so every lane ends with one real chat turn.
    // The result carries the reply for the harness's shared non-stub assertion.
    const livenessReply = await driveIosLivenessChatTurn(
      request.livenessPrompt,
    );

    await writeIosCloudOnboardingSmokeResult({
      ok: isIosCloudOnboardingComplete({
        homeVisible: Boolean(home),
        composerVisible: Boolean(composer),
        onboardingHidden,
        cloudActiveServer,
        firstRunPostCount,
      }),
      phase: "complete",
      mode: request.mode,
      finishedAt: new Date().toISOString(),
      signInGreetingVisible,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      firstRunPostCount,
      cloudActiveServer,
      storage,
      livenessRequested: true,
      livenessReply,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosCloudOnboardingSmokeResult({
      ok: false,
      phase: "failed",
      mode: request.mode,
      finishedAt: new Date().toISOString(),
      firstRunPostCount: firstRunCounter.getCount(),
      error: error instanceof Error ? error.message : String(error),
      storage: readIosCloudOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    firstRunCounter.restore();
    try {
      shellLocalStorage.removeItem(IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY);
    } catch (error) {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
      logger.debug(
        { error },
        "[iOSCloudOnboardingSmoke] localStorage request cleanup failed",
      );
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_CLOUD_ONBOARDING_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function fetchIosMixedContentHealth(apiBase: string): Promise<
  | {
      ok: boolean;
      status: number;
      url: string;
      body: unknown;
    }
  | {
      ok: false;
      status?: number;
      url: string;
      error: string;
    }
> {
  const url = new URL("/api/health", apiBase).href;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // error-policy:J7 diagnostics preserve status even when body is not JSON
      try {
        body = await response.text();
      } catch {
        // error-policy:J7 diagnostics preserve the health failure without a body
        body = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      url,
      body,
    };
  } catch (error) {
    // error-policy:J7 diagnostics preserve the failed health probe for the harness
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runIosMixedContentSmokeIfRequested(options?: {
  apiBase?: string;
}): Promise<boolean> {
  if (!isIOS || iosMixedContentSmokeStarted) {
    return iosMixedContentSmokeStarted;
  }
  const request = await readIosMixedContentSmokeRequest(options?.apiBase);
  if (!request) return false;

  iosMixedContentSmokeStarted = true;
  await writeIosMixedContentSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });

  const wsConstructorCalls: string[] = [];
  const originalWebSocket = window.WebSocket;
  const clientBaseUrl =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  try {
    window.WebSocket = new Proxy(originalWebSocket, {
      construct(target, args) {
        wsConstructorCalls.push(String(args[0] ?? ""));
        return Reflect.construct(target, args);
      },
    }) as typeof WebSocket;

    client.connectWs();
    const connectionState =
      typeof client.getConnectionState === "function"
        ? client.getConnectionState()
        : null;
    const restHealth = await fetchIosMixedContentHealth(request.apiBase);
    const bodyText = document.body?.innerText ?? "";
    const lostBackendOverlayAbsent =
      !/Lost backend connection/i.test(bodyText) &&
      !document.querySelector('[data-testid="connection-lost-overlay"]');

    await writeIosMixedContentSmokeResult({
      ok:
        restHealth.ok === true &&
        wsConstructorCalls.length === 0 &&
        connectionState?.state === "connected" &&
        lostBackendOverlayAbsent,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      webViewProtocol: window.location.protocol,
      clientBaseUrl,
      expectedInsecureWebSocketUrl: new URL(
        "/ws",
        request.apiBase,
      ).href.replace(/^http:/, "ws:"),
      mixedContentWouldBlockWebSocket:
        window.location.protocol === "https:" &&
        request.apiBase.startsWith("http://"),
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState,
      lostBackendOverlayAbsent,
      restHealth,
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosMixedContentSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      clientBaseUrl,
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState:
        typeof client.getConnectionState === "function"
          ? client.getConnectionState()
          : null,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    window.WebSocket = originalWebSocket;
    try {
      shellLocalStorage.removeItem(IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function runIosOnboardingSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosOnboardingSmokeStarted) return iosOnboardingSmokeStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  }
  if (!rawRequest) return false;

  iosOnboardingSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    // WKWebView is not CDP-drivable, and recent iOS simulators can stop
    // `simctl openurl` behind a system "Open in <app>?" confirmation. Drive the
    // same hardened remote-connect handler that the OS deep-link route uses,
    // after React has had a chance to install its CONNECT_EVENT listener.
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    connectFirstRunRemoteDeepLink(request.apiBase);

    // Prove the post-connect surface, decoupled from the onboarding DOM — no
    // remote-address field to fill, resilient to the in-chat redesign.
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );

    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );
    await runIosMixedContentSmokeIfRequested({ apiBase: request.apiBase });

    // Liveness contract (#14359): against a live-provider host, end the lane
    // with one real chat turn and report the reply for the harness's shared
    // non-stub assertion. Skipped for the default deterministic (stub) host.
    const livenessReply = request.liveness
      ? await driveIosLivenessChatTurn(request.livenessPrompt)
      : null;

    await writeIosOnboardingSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
      livenessRequested: request.liveness,
      livenessReply,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      shellLocalStorage.removeItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function runIosOnboardingRelaunchSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosOnboardingRelaunchSmokeStarted) {
    return iosOnboardingRelaunchSmokeStarted;
  }
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest) return false;

  iosOnboardingRelaunchSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingRelaunchSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );
    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );

    await writeIosOnboardingRelaunchSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingRelaunchSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      shellLocalStorage.removeItem(IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function initializeAgent(): Promise<void> {
  try {
    const status = await Agent.getStatus();
    dispatchAppEvent(AGENT_READY_EVENT, status);
  } catch (err) {
    // error-policy:J4 the native agent plugin is optional (absent on web) —
    // the app runs against a remote agent instead; logged for triage
    console.warn(
      `${APP_LOG_PREFIX} Agent not available:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function initializePlatform(): Promise<void> {
  await initializeStorageBridge();
  initializeCapacitorBridge();
  installNativeTranscriptPlatformBridge();
  void runIosFullBunSmokeFromDesktopShell();
  void runIosOnboardingSmokeIfRequested();
  void runIosCloudOnboardingSmokeIfRequested();
  void runIosOnboardingRelaunchSmokeIfRequested();
  void runIosAttachmentSmokeIfRequested({
    isIOS,
    getApiBaseUrl: () => client.getBaseUrl(),
    getPreference: boundedPreferenceGet,
    removePreference: (key) =>
      boundedPreferenceWrite(() => Preferences.remove({ key })),
    writeResult: writeIosPreferenceSmokeResult,
    waitForElement: waitForIosOnboardingElement,
    readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
  });
  // Lazy + iOS-gated: the voice self-test pulls the whole @elizaos/ui/voice
  // graph, which a static import anchors into every web/desktop entry chunk.
  // Non-iOS platforms never ran the smoke anyway (the module self-gates), so
  // they now skip fetching the chunk entirely.
  if (isIOS) {
    void import("./ios-voice-selftest-smoke").then(
      ({ runIosVoiceSelfTestSmokeIfRequested }) =>
        runIosVoiceSelfTestSmokeIfRequested({
          isIOS,
          client,
          getPreference: boundedPreferenceGet,
          removePreference: (key) =>
            boundedPreferenceWrite(() => Preferences.remove({ key })),
          writeResult: writeIosPreferenceSmokeResult,
          readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
        }),
    );
  }

  // Foreground/background lifecycle + connectivity are wired on every surface,
  // including installed web PWAs (#PWA-D1). `createMobileLifecycle` guards
  // Capacitor calls and falls back to `document.visibilitychange` plus window
  // `online`/`offline`; `setAppActive` dedupes native `appStateChange` so the
  // browser fallback cannot double-fire resume handling.
  getMobileLifecycle().initializeAppLifecycle();
  void getMobileLifecycle().initializeNetworkListener();

  if (isIOS || isAndroid) {
    await initializeStatusBar();
    await getMobileLifecycle().initializeKeyboard();
    initializeMobileRuntimeModeListener();
    void initializeMobileDeviceBridge();
    void initializeMobileAgentTunnel();
    void registerMobileBlockerBackends();
  }

  if (isDesktopPlatform()) {
    await initializeDesktopShell();
  } else if (isNative) {
    await initializeAgent();
  }

  if (isIOS || isAndroid) {
    void configureMobileBackgroundRunner();
  }
}

/**
 * Register the Capacitor website/app blocker plugins as the native backends of
 * the `@elizaos/plugin-blocker` engine instance loaded in this WebView realm.
 *
 * Without this, the engine falls back to its system hosts-file path, which
 * cannot work inside the iOS/Android app sandbox, so BLOCK is a no-op. The
 * adapters wrap the Capacitor plugins (Safari content blocker / VPN DNS on iOS
 * and Android) and map the engine's call/return shapes onto the plugin API.
 *
 * Process boundary: this wires the engine instance that runs in the WebView's
 * JS realm (the web/PWA build, and any in-WebView engine consumer). On stock
 * native builds the elizaOS runtime — and the engine instance the agent's BLOCK
 * action calls — runs in a SEPARATE bun process, which this registration does
 * not reach; that path still flows WebView→engine over the HTTP route.
 */
async function registerMobileBlockerBackends(): Promise<void> {
  try {
    // MUST be the /native subpath: renderer builds alias the bare
    // `@elizaos/plugin-blocker` specifier to src/register.ts (side-effect
    // only, zero exports), so importing the root here would make both
    // register calls throw and leave mobile BLOCK enforcement dead.
    const [blocker, websiteNative, appNative] = await Promise.all([
      import("@elizaos/plugin-blocker/native"),
      import("@elizaos/capacitor-websiteblocker"),
      import("@elizaos/capacitor-appblocker"),
    ]);
    blocker.registerNativeWebsiteBlockerBackend(
      websiteNative.createNativeWebsiteBlockerBackend(
        websiteNative.WebsiteBlocker,
      ),
    );
    blocker.registerNativeAppBlockerBackend(
      appNative.createNativeAppBlockerBackend(appNative.AppBlocker),
    );
  } catch (error) {
    // error-policy:J4 optional native plugin — absence is a designed degrade
    logNativePluginUnavailable("Blocker backends", error);
  }
}

async function initializeStatusBar(): Promise<void> {
  if (!isNative) return;
  // Make the status bar overlay the WebView so the app can render
  // edge-to-edge and `env(safe-area-inset-top)` reports the real status-bar
  // height on both platforms (iOS already does this via the
  // `apple-mobile-web-app-status-bar-style: black-translucent` meta tag;
  // Android needs an explicit opt-in via `setOverlaysWebView`). Imported
  // dynamically so non-mobile bundles don't try to resolve the native
  // plugin's named exports through the vite native compatibility module.
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (isAndroid) {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setBackgroundColor({ color: "#00000000" });
    }
  } catch (error) {
    // error-policy:J4 optional native plugin — absence is a designed degrade
    logNativePluginUnavailable("StatusBar", error);
  }
}

/**
 * Live cross-platform lifecycle helper. `main.tsx` keeps its own status-bar
 * wiring, but keyboard setup and the app-lifecycle path (foreground/
 * background events + the `visibilitychange` fallback, the hardware-back
 * contract — `dispatchBackIntent()` first, then `history.back()` /
 * `minimizeApp()` when unhandled (#9148) — and the deep-link bootstrap) and
 * the network listener are delegated here so the extracted module IS the
 * shipped behavior, not a stale duplicate. The network delegation carries the
 * #10472 window `online`/`offline` fallback: before it, the fallback lived
 * only in `mobile-lifecycle.ts` and had zero importers, so on Android — where
 * the Capacitor `Network` plugin can be absent from the WebView bridge — the
 * `networkStatusChange` listener never registered and NETWORK_STATUS_CHANGE_EVENT
 * (consumed by the WebSocket reconnect scheduler) never fired on a connectivity
 * change. Constructed once, lazily, so the factory's per-instance idempotency
 * guard holds across repeated `initializePlatform()` calls.
 */
let mobileLifecycleInstance: MobileLifecycle | null = null;
function getMobileLifecycle(): MobileLifecycle {
  if (!mobileLifecycleInstance) {
    const androidDeepLinkBuffer = isAndroid
      ? Capacitor.registerPlugin<AndroidDeepLinkBuffer>("DeepLinkBuffer")
      : undefined;
    mobileLifecycleInstance = createMobileLifecycle({
      isNative,
      isIOS,
      isAndroid,
      logPrefix: APP_LOG_PREFIX,
      handleDeepLink,
      androidDeepLinkBuffer,
    });
  }
  return mobileLifecycleInstance;
}

// Universal/App-Link hosts whose `https://<host>/<path>` links can route inside
// the app after a platform host associates the domain with its native build.
const APP_LINK_HOSTS = ["eliza.app"];

// Device/desktop "connect to a remote agent at a URL" first-run onboarding:
// `<scheme>://first-run/runtime/remote?api=<url>`. The host (a desktop/cloud
// agent) emits this as a link/QR; opening it on a fresh device connects to that
// remote and lands on home. Routed through the same hardened CONNECT_EVENT path
// as `<scheme>://connect?url=` (trust-policy gated, token never accepted from a
// deep link) but with `completeFirstRun` so it also finishes onboarding.
function connectFirstRunRemoteDeepLink(rawApiBase: string): void {
  let validatedUrl: URL;
  try {
    validatedUrl = new URL(rawApiBase);
  } catch {
    // error-policy:J3 untrusted deep-link input — rejected loudly
    console.error(`${APP_LOG_PREFIX} Invalid first-run remote URL format`);
    return;
  }
  if (validatedUrl.protocol !== "https:" && validatedUrl.protocol !== "http:") {
    console.error(
      `${APP_LOG_PREFIX} Invalid first-run remote URL protocol:`,
      validatedUrl.protocol,
    );
    return;
  }
  if (!isTrustedDeepLinkApiBaseUrl(validatedUrl)) {
    console.warn(
      `${APP_LOG_PREFIX} Rejected untrusted first-run remote host:`,
      validatedUrl.hostname,
    );
    return;
  }
  // SECURITY: never accept a bearer token from an OS-delivered deep link (see
  // the `connect` case below). A pairing-disabled remote that needs a token is
  // connected via the trusted in-app Settings entry instead.
  const connection = applyLaunchConnection({
    kind: "remote",
    apiBase: validatedUrl.href,
    token: null,
  });
  const dispatchConnect = () => {
    dispatchConnectRequest({
      gatewayUrl: connection.apiBase,
      completeFirstRun: true,
    });
  };
  const activeServer = JSON.stringify({
    id: `remote:${connection.apiBase}`,
    kind: "remote",
    label: validatedUrl.hostname || "Remote agent",
    apiBase: connection.apiBase,
  });
  // error-policy:J6 best-effort persist — the connect below still lands;
  // only re-selection after restart is lost, and the failure is logged
  void setStorageValue("elizaos:active-server", activeServer).catch((error) => {
    console.warn(
      `${APP_LOG_PREFIX} Failed to persist first-run remote active server:`,
      error,
    );
  });
  dispatchConnect();
}

async function recordIosAuthCallbackSmoke(
  parsed: URL,
  path: string,
  url: string,
  outcome: AuthCallbackDeepLinkOutcome,
  activeServerBefore: string,
): Promise<void> {
  // Record the auth-callback end state on ANY native platform. Pre-#13693 this
  // was iOS-only, so the Android smoke leg had no in-app readback at all (pure
  // `am start` fire-and-forget). Broadening to `isNative` lets the Android
  // smoke read the same Capacitor-Preferences handshake (backed by
  // SharedPreferences) and assert the same end state instead of trusting intent
  // resolution alone. This is a smoke seam: the body no-ops unless the harness
  // has armed the request key, so real users' deep-link handling is unchanged.
  if (!isNative) return;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
    );
  } catch {
    rawRequest = null;
  }
  rawRequest ??= await boundedPreferenceGet(
    IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
  );
  if (!rawRequest) return;

  let request: Record<string, unknown> = {};
  try {
    const parsedRequest = JSON.parse(rawRequest);
    if (parsedRequest && typeof parsedRequest === "object") {
      request = parsedRequest as Record<string, unknown>;
    }
  } catch {
    request = { malformedRequest: rawRequest };
  }

  // #13693: assert the AUTH OUTCOME, not just delivery. The security invariant
  // for this handler (see the `connect`/first-run-remote cases above) is that
  // an OS-delivered deep link NEVER establishes or swaps an authenticated
  // session. Compare the real active-server key before/after handling the
  // callback so a pre-authenticated simulator passes when the callback leaves
  // the session untouched, while a regression that authenticates from the deep
  // link flips `sessionChanged=true`.
  let activeServerAfter = "";
  try {
    activeServerAfter = readActiveServerSessionSnapshot();
  } catch (error) {
    // error-policy:J7 diagnostics readback — the smoke must fail closed when it
    // cannot observe the auth outcome it is supposed to prove.
    await writeIosAuthCallbackSmokeResult({
      ok: false,
      phase: "failed",
      classification: outcome.classification,
      accepted: outcome.accepted,
      reason: outcome.reason,
      error:
        error instanceof Error
          ? error.message
          : `active-server readback failed: ${String(error)}`,
      path,
      url,
      state: parsed.searchParams.get("state") ?? "",
      code: parsed.searchParams.get("code") ?? "",
      query: Object.fromEntries(parsed.searchParams.entries()),
      request,
    });
    return;
  }

  await writeIosAuthCallbackSmokeResult({
    ok: true,
    phase: "handled",
    classification: outcome.classification,
    accepted: outcome.accepted,
    reason: outcome.reason,
    sessionEstablished: activeServerAfter.length > 0,
    sessionChanged: activeServerAfter !== activeServerBefore,
    activeServerBeforePresent: activeServerBefore.length > 0,
    activeServerAfterPresent: activeServerAfter.length > 0,
    path,
    url,
    state: parsed.searchParams.get("state") ?? "",
    code: parsed.searchParams.get("code") ?? "",
    query: Object.fromEntries(parsed.searchParams.entries()),
    request,
  });
}

async function handleAuthCallbackDeepLink(
  parsed: URL,
  path: string,
  url: string,
): Promise<boolean> {
  if (isAndroid && isAndroidCloudBuild()) {
    try {
      await completeAndroidCloudSignIn(url);
      return true;
    } catch (error) {
      console.warn(
        `${APP_LOG_PREFIX} Android Cloud sign-in callback failed:`,
        error instanceof Error ? error.message : error,
      );
      if (shouldAcknowledgeAndroidCloudCallback(error)) return true;
      throw error;
    }
  }
  const outcome = rejectOsDeliveredAuthCallback();
  let activeServerBefore = "";
  try {
    activeServerBefore = readActiveServerSessionSnapshot();
  } catch (error) {
    await writeIosAuthCallbackSmokeResult({
      ok: false,
      phase: "failed",
      classification: outcome.classification,
      accepted: outcome.accepted,
      reason: outcome.reason,
      error:
        error instanceof Error
          ? error.message
          : `active-server pre-readback failed: ${String(error)}`,
      path,
      url,
      state: parsed.searchParams.get("state") ?? "",
      code: parsed.searchParams.get("code") ?? "",
      query: Object.fromEntries(parsed.searchParams.entries()),
    });
    return true;
  }

  await recordIosAuthCallbackSmoke(
    parsed,
    path,
    url,
    outcome,
    activeServerBefore,
  );
  return true;
}

/**
 * Returns `void` for every branch except the top-level-surface navigation
 * intent, which returns the `dispatchNavigateViewRequest` promise so a caller
 * that needs to know the intent actually LANDED (not merely enqueued) — today
 * `mobile-lifecycle.ts`, gating its Android deep-link-buffer acknowledgement —
 * can await it instead of acking on dispatch alone.
 */
function handleDeepLink(url: string): undefined | Promise<boolean> {
  const remotePairing = parseRemoteControllerPairingDeepLink(
    url,
    APP_URL_SCHEME,
  );
  if (remotePairing) {
    if (
      !isRemoteControllerPairingRuntimeAllowed({
        isElectrobun: isElectrobunRuntime(),
        navigatorPlatform:
          typeof navigator === "undefined" ? "" : navigator.platform,
        nativePlatform: Capacitor.getPlatform(),
        native: Capacitor.isNativePlatform(),
        nativePluginAvailable:
          Capacitor.isPluginAvailable?.("RemoteControllerIdentity") === true,
      })
    ) {
      console.warn(
        `${APP_LOG_PREFIX} Remote controller pairing requires the enrolled Linux desktop shell or this iPhone's secure native controller bridge`,
      );
      return;
    }
    dispatchRemoteControllerPairingIntent(remotePairing);
    return dispatchDeepLinkNavigation({
      viewId: "settings",
      viewPath: "/settings",
      subview: "my-runtimes",
    });
  }
  const firstRunRemote = parseFirstRunRemoteConnectDeepLink(
    url,
    APP_URL_SCHEME,
  );
  if (firstRunRemote) {
    connectFirstRunRemoteDeepLink(firstRunRemote.apiBase);
    return;
  }
  if (routeFirstRunDeepLink(url, APP_URL_SCHEME)) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 untrusted deep-link input — unparseable links are
    // dropped loudly so a broken link is diagnosable
    console.warn(`${APP_LOG_PREFIX} Ignoring unparseable deep link`);
    return;
  }

  // Accept both the custom `<scheme>://` links and `https://eliza.app/<path>`
  // universal/App links when a host has configured an operating-system domain
  // association; both route into the same hash routes below.
  const isAppLink = isTrustedAppLink(parsed, APP_LINK_HOSTS);
  if (parsed.protocol !== `${APP_URL_SCHEME}:` && !isAppLink) return;
  const path = isAppLink
    ? parsed.pathname.replace(/^\/+|\/+$/g, "")
    : getDeepLinkPath(parsed);
  if (path === "auth/callback") {
    return handleAuthCallbackDeepLink(parsed, path, url);
  }

  if (path === "first-run/runtime/remote") {
    const rawApiBase =
      parsed.searchParams.get("api")?.trim() ||
      parsed.searchParams.get("apiBase")?.trim() ||
      parsed.searchParams.get("url")?.trim() ||
      parsed.searchParams.get("host")?.trim();
    if (rawApiBase) {
      connectFirstRunRemoteDeepLink(rawApiBase);
    }
    return;
  }

  // Top-level-surface deep links (settings, wallet, browser, connectors, and
  // the https://eliza.app/<path> universal links that map to them). Dispatched
  // on the in-app `eliza:navigate:view` bus rather than written to
  // `window.location.hash`: on the mobile/Capacitor entrypoint the app is not
  // served over file: and is not an app-window, so the hash is never read for
  // tab navigation (`getWindowNavigationPath` returns `location.pathname`) and
  // the target tab never opened. (Chat-launch deep links below stay on the
  // hash — the always-mounted ChatOverlay claims the launch payload
  // from the hash directly.)
  const navigationIntent = resolveDeepLinkNavigationIntent(
    path,
    parsed.searchParams,
  );
  if (navigationIntent) {
    return dispatchDeepLinkNavigation(navigationIntent);
  }

  const assistantLaunchHashRoute = buildAssistantLaunchHashRoute(
    path,
    parsed.searchParams,
  );
  if (assistantLaunchHashRoute) {
    window.location.hash = assistantLaunchHashRoute;
    return;
  }

  switch (path) {
    case "phone":
    case "phone/call":
      setHashRoute("phone", parsed.searchParams);
      break;
    case "messages":
    case "messages/compose":
      setHashRoute("messages", parsed.searchParams);
      break;
    case "contacts":
      setHashRoute("contacts", parsed.searchParams);
      break;
    case "notifications":
      // AppDelegate delivers the fallback notification URL through the native
      // appUrlOpen lifecycle. The Home notification center is event-driven, so
      // a hash write cannot open it on the Capacitor composition root.
      dispatchOpenNotificationCenter();
      break;
    case "aec-loop":
      // On-device AEC acoustic-loop evidence harness (#11373): the hash route
      // is consumed by installAecLoopHarness's hashchange watcher.
      setHashRoute("aec-loop", parsed.searchParams);
      break;
    case "keyboard-dictation":
      // iOS keyboard app-handoff dictation (#12185): extensions have no mic,
      // so the ElizaKeyboard extension opens the app; record + transcribe
      // here, publish the transcript to the App Group, keyboard inserts it.
      startKeyboardDictationSession(parsed.searchParams);
      break;
    case "connect": {
      const gatewayUrl = parsed.searchParams.get("url");
      if (gatewayUrl) {
        try {
          const validatedUrl = new URL(gatewayUrl);
          if (
            validatedUrl.protocol !== "https:" &&
            validatedUrl.protocol !== "http:"
          ) {
            console.error(
              `${APP_LOG_PREFIX} Invalid gateway URL protocol:`,
              validatedUrl.protocol,
            );
            break;
          }
          if (!isTrustedDeepLinkApiBaseUrl(validatedUrl)) {
            console.warn(
              `${APP_LOG_PREFIX} Rejected untrusted gateway URL host:`,
              validatedUrl.hostname,
            );
            break;
          }
          // SECURITY: never accept a bearer token from an OS-delivered deep
          // link. A crafted `<scheme>://connect?url=…&token=…` would otherwise
          // authenticate the session with an ATTACKER-supplied token against an
          // attacker gateway (full MITM of subsequent agent traffic). No
          // legitimate flow passes a token this way — remote auth goes through
          // the cloudLaunchSession exchange. The host repoint is preserved for
          // the legitimate local-agent connect feature.
          const connection = applyLaunchConnection({
            kind: "remote",
            apiBase: validatedUrl.href,
            token: null,
          });
          dispatchConnectRequest({
            gatewayUrl: connection.apiBase,
            token: connection.token ?? undefined,
          });
        } catch {
          // error-policy:J3 untrusted deep-link input — rejected loudly
          console.error(`${APP_LOG_PREFIX} Invalid gateway URL format`);
        }
      }
      break;
    }
    case "share": {
      const title = parsed.searchParams.get("title")?.trim() || undefined;
      const text = parsed.searchParams.get("text")?.trim() || undefined;
      const sharedUrl = parsed.searchParams.get("url")?.trim() || undefined;
      const files = parsed.searchParams
        .getAll("file")
        .map((filePath) => filePath.trim())
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => {
          const slash = Math.max(
            filePath.lastIndexOf("/"),
            filePath.lastIndexOf("\\"),
          );
          const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
          return { name, path: filePath };
        });

      dispatchShareTarget({
        source: "deep-link",
        title,
        text,
        url: sharedUrl,
        files,
      });
      break;
    }
    default:
      console.warn(`${APP_LOG_PREFIX} Unknown deep link path:`, path);
      break;
  }
}

function getDeepLinkPath(parsed: URL): string {
  const host = parsed.host.replace(/^\/+|\/+$/g, "");
  const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (host === APP_CONFIG.appId || host === APP_CONFIG.desktop?.bundleId) {
    return pathname;
  }
  return [host, pathname].filter(Boolean).join("/");
}

function setHashRoute(route: string, params: URLSearchParams): void {
  const query = params.toString();
  window.location.hash = query ? `#${route}?${query}` : `#${route}`;
}

/**
 * Dispatch a top-level-surface deep link on the in-app `eliza:navigate:view`
 * bus (consumed in packages/ui App.tsx: `viewPath` → `tabFromPath` → `setTab`,
 * `subview` → Settings section). This is the platform-agnostic navigation path
 * the rest of the app uses; a raw `window.location.hash` write does not open a
 * tab on the mobile/Capacitor entrypoint (see `resolveDeepLinkNavigationIntent`).
 */
function dispatchDeepLinkNavigation(
  intent: DeepLinkNavigationIntent,
): Promise<boolean> {
  return dispatchNavigateViewRequest(intent);
}

async function initializeDesktopShell(): Promise<void> {
  document.body.classList.add("desktop");

  const version = await invokeDesktopBridgeRequest<{ runtime: string }>({
    rpcMethod: "desktopGetVersion",
    ipcChannel: "desktop:getVersion",
  });
  const desktopNativeReady =
    version !== null &&
    typeof version.runtime === "string" &&
    version.runtime !== "N/A" &&
    version.runtime !== "unknown";
  if (!desktopNativeReady) {
    throw new Error("[desktop-shell] Native Electrobun bridge is unavailable");
  }

  const commandPaletteRegistration = await invokeDesktopBridgeRequest<{
    success: boolean;
  }>({
    rpcMethod: "desktopRegisterShortcut",
    ipcChannel: "desktop:registerShortcut",
    params: {
      id: "command-palette",
      accelerator: "CommandOrControl+K",
    },
  });
  if (commandPaletteRegistration?.success !== true) {
    throw new Error(
      "[desktop-shell] Operating system rejected the command-palette shortcut",
    );
  }

  // Programmable chat-overlay summon hotkey (#10716). The command palette keeps
  // CommandOrControl+K; this is a distinct, user-configurable global shortcut
  // (default CommandOrControl+Shift+C) that brings the floating chat surface —
  // which on desktop is the main window — to the foreground. Registered only
  // when enabled in Desktop settings.
  const chatOverlayHotkey = getChatOverlayHotkey();
  if (chatOverlayHotkey.enabled) {
    const chatOverlayRegistration = await invokeDesktopBridgeRequest<{
      success: boolean;
    }>({
      rpcMethod: "desktopRegisterShortcut",
      ipcChannel: "desktop:registerShortcut",
      params: {
        id: "chat-overlay",
        accelerator: chatOverlayHotkey.accelerator,
      },
    });
    if (chatOverlayRegistration?.success !== true) {
      throw new Error(
        `[desktop-shell] Operating system rejected the chat-overlay shortcut ${chatOverlayHotkey.accelerator}`,
      );
    }
  }

  // Global push-to-talk toggle (#20483). Electrobun's GlobalShortcut is
  // trigger-only (no key-up), so the OS-wide voice hotkey is press-to-start /
  // press-again-to-send rather than a held quasimode — the pill's own
  // press-and-hold remains the true hold gesture. Best-effort: a rejected
  // accelerator (another app owns it) logs and moves on; voice stays reachable
  // via the pill.
  const pushToTalkRegistration = await invokeDesktopBridgeRequest<{
    success: boolean;
  }>({
    rpcMethod: "desktopRegisterShortcut",
    ipcChannel: "desktop:registerShortcut",
    params: {
      id: "push-to-talk",
      accelerator: getPushToTalkAccelerator(),
    },
  });
  if (pushToTalkRegistration?.success !== true) {
    console.warn(
      "[desktop-shell] Operating system rejected the push-to-talk shortcut; the pill hold gesture remains available",
    );
  }

  // Fn-hold push-to-talk quasimode (#20483, Wispr parity): the native fn key
  // monitor delivers true down/up, so holding fn anywhere drives the same
  // capture as holding the pill. Best-effort: `permission-missing` (no
  // Accessibility trust yet) and `unavailable` (non-mac, sandboxed store
  // build) degrade silently to the toggle hotkey above.
  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopFnHoldChanged",
    ipcChannel: "desktop:fnHoldChanged",
    listener: (payload: unknown) => {
      const detail = payload as PushToTalkHoldDetail | null | undefined;
      if (!detail || typeof detail.held !== "boolean") return;
      dispatchAppEvent(PUSH_TO_TALK_HOLD_EVENT, {
        held: detail.held,
        cancelled: detail.cancelled === true,
      } satisfies PushToTalkHoldDetail);
    },
  });
  const fnHoldStart = shouldStartFnHoldMonitor({
    cloudOnly: APP_BRANDING.cloudOnly === true,
  })
    ? await invokeDesktopBridgeRequest<{
        status: "started" | "permission-missing" | "failed" | "unavailable";
        fnSystemUsageType: number;
      }>({
        rpcMethod: "desktopStartFnHoldMonitor",
        ipcChannel: "desktop:startFnHoldMonitor",
      })
    : null;
  if (fnHoldStart?.status === "started") {
    if (fnHoldStart.fnSystemUsageType !== 0) {
      console.warn(
        "[desktop-shell] fn-hold push-to-talk is active but the macOS 'Press 🌐 key to' action is also enabled — a quick fn tap will trigger the system action; set it to 'Do Nothing' in System Settings → Keyboard",
      );
    }
  } else if (fnHoldStart?.status === "permission-missing") {
    console.warn(
      "[desktop-shell] fn-hold push-to-talk needs Accessibility permission (System Settings → Privacy & Security → Accessibility); falling back to the toggle hotkey",
    );
  }

  // Toggle semantics (#12184): a focused + visible overlay is dismissed
  // (focus returns to the previously active app via the macOS orderOut path);
  // otherwise summon + focus it. Blur does NOT hide the pill — it is a resting
  // surface (unlike the tray popover).
  const summonChatOverlay = async (): Promise<void> => {
    const [focusState, visibilityState] = await Promise.all([
      invokeDesktopBridgeRequest<{ focused: boolean }>({
        rpcMethod: "desktopIsWindowFocused",
        ipcChannel: "desktop:isWindowFocused",
      }),
      invokeDesktopBridgeRequest<{ visible: boolean }>({
        rpcMethod: "desktopIsWindowVisible",
        ipcChannel: "desktop:isWindowVisible",
      }),
    ]);
    if (!focusState || !visibilityState) {
      throw new Error("[desktop-shell] Native window state is unavailable");
    }
    const { focused } = focusState;
    const { visible } = visibilityState;
    if (decideChatOverlayToggle({ focused, visible }) === "hide") {
      await invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopHideWindow",
        ipcChannel: "desktop:hideWindow",
      });
      return;
    }
    await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopShowWindow",
      ipcChannel: "desktop:showWindow",
    });
    await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopFocusWindow",
      ipcChannel: "desktop:focusWindow",
    });
  };

  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopShortcutPressed",
    ipcChannel: "desktop:shortcutPressed",
    listener: (payload: unknown) => {
      const id = (payload as { id?: string } | null | undefined)?.id;
      if (id === "command-palette") {
        dispatchAppEvent(COMMAND_PALETTE_EVENT);
      } else if (id === "chat-overlay") {
        void summonChatOverlay();
      } else if (id === "push-to-talk") {
        dispatchAppEvent(PUSH_TO_TALK_TOGGLE_EVENT);
      }
    },
  });

  await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopSetTrayMenu",
    ipcChannel: "desktop:setTrayMenu",
    params: {
      menu: await buildLocalizedTrayMenuAsync(
        createTranslator(loadUiLanguage()),
      ),
    },
  });

  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopTrayMenuClick",
    ipcChannel: "desktop:trayMenuClick",
    listener: (event: unknown) => {
      if (!event || typeof event !== "object") return;
      const itemId = Reflect.get(event, "itemId");
      const checked = Reflect.get(event, "checked");
      if (typeof itemId !== "string") return;
      dispatchAppEvent(TRAY_ACTION_EVENT, {
        itemId,
        ...(typeof checked === "boolean" ? { checked } : {}),
      });
    },
  });

  subscribeDesktopBridgeEvent({
    rpcMessage: "shareTargetReceived",
    ipcChannel: "desktop:shareTargetReceived",
    listener: (payload: unknown) => {
      const url = (payload as { url?: string } | null | undefined)?.url;
      if (typeof url !== "string" || url.trim().length === 0) {
        return;
      }
      void handleDeepLink(url);
    },
  });
}

function setupPlatformStyles(): void {
  const root = document.documentElement;
  document.body.classList.add(`platform-${platform}`);

  if (isNative) {
    document.body.classList.add("native");
  }

  // Installed PWA on the WEB platform (iOS home-screen app, chrome-less Android
  // PWA): tag the body so base.css/styles.css apply the mobile touch-viewport
  // lockdown + #14319 large-viewport geometry. This is the SECONDARY path: the
  // CSS-first `@media (display-mode: standalone) and (pointer: coarse)` rules
  // are the source of truth (they land even when this class does not), but the
  // class is kept for back-compat (legacy iOS Safari signalling only via
  // navigator.standalone) and parity with the @elizaos/ui setupPlatformStyles.
  // Scoped to `platform === "web"`: the native build already locks via `native`
  // and desktop (electrobun) must keep its window scroll/trackpad behavior.
  if (platform === "web" && isStandalonePwa()) {
    document.body.classList.add("pwa-standalone");
  }

  // JS-MEASURED BOTTOM RECLAIM — THE LOAD-BEARING INSTALL POINT ON THE REAL
  // PWA BOOT PATH (#15103/#15136/#15178). This local `setupPlatformStyles` is
  // the function `main()` actually calls on the installed standalone PWA (the
  // `@elizaos/ui` init.ts `setupPlatformStyles` is NOT on this entry graph — it
  // is only reachable from unit tests). If the installer is not called HERE it
  // never runs on device: the layout viewport collapses to the small box
  // (`documentElement.clientHeight` = 873 while `screen.height` = 932) so every
  // pure-CSS reclaim (`100lvh - 100dvh`) resolves to 0 and is a device no-op,
  // leaving the black home-indicator strip. #15178's WIP (f903c59) dropped this
  // block and the restore landed only in the orphaned ui copy, reproducing the
  // regression (device chip read `rc?` = var never set). The platform gate lives
  // INSIDE `shouldInstallStandaloneBottomReclaim` (standalone + iOS only), so
  // this is a hard 0 no-op everywhere else and a future refactor of this entry
  // cannot silently orphan the installer without turning the app-entry lockdown
  // contract test RED. See standalone-bottom-reclaim.ts + standalone-pwa-lockdown.test.ts.
  if (
    shouldInstallStandaloneBottomReclaim({
      standalonePwa: isStandalonePwa(),
      isNative,
      isIOS,
    })
  ) {
    installStandaloneBottomReclaim();
  } else {
    clearStandaloneBottomReclaim();
  }

  const chatOverlayShell = isChatOverlayWindowShell(windowShellRoute);
  root.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell);
  document.body.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell);

  // Record the resolved window shell mode once at boot. Detached/overlay
  // windows route on `?shellMode=`; logging it makes a mis-routed surface
  // (e.g. an overlay window that fell back to the full dashboard) obvious in
  // the desktop dev console instead of only visible as a wrong-looking window.
  console.info(
    `[shell] window shell mode: ${windowShellRoute.mode} (search="${
      typeof window !== "undefined" ? window.location.search : ""
    }")`,
  );

  // Shared base.css owns the live Capacitor/env safe-area aliases on every host.
  root.style.setProperty("--keyboard-height", "0px");
}

function isPhoneCompanionMode(): boolean {
  if (typeof window === "undefined") return false;
  return getWindowUrlSearchParams().get("mode") === "companion";
}

function resolveAppWindowSlug(): string | null {
  if (!isAppWindowRoute()) return null;
  const path = getWindowNavigationPath();
  if (!path.startsWith("/apps/")) return null;
  // Take only the first path segment after /apps/. URLs like
  // `/apps/plugins/extra` would otherwise yield a malformed slug
  // ("plugins/extra") that no descriptor can match.
  const slug = path
    .slice("/apps/".length)
    .replace(/[?#].*$/, "")
    .split("/")[0];
  return slug.length > 0 ? slug : null;
}

/**
 * Top-level cloud/public/auth router shell. Web build only — lazy so the chunk
 * (and its react-router / Steward / cloud-provider transitive deps) never lands
 * on the native critical path. The `__ELIZA_WEB_SHELL__` define is a literal
 * `false` in the Capacitor mobile build, so the guarded dynamic import below is
 * statically unreachable there and the bundler drops the whole shell chunk.
 */
const CloudRouterShell = lazy(async () => {
  if (__ELIZA_WEB_SHELL__ !== true) {
    throw new Error("CloudRouterShell is web-build-only");
  }
  // Populate the cloud-route + settings-section registries before the shell
  // mounts and reads `listCloudRoutes()`; without this the registry is empty and
  // no cloud/auth/payment route resolves. Both imports live inside this
  // `__ELIZA_WEB_SHELL__`-guarded factory, so a cloud-free build drops them
  // statically.
  // Progressive public boot (#18056): import register-public, NOT register-all.
  // register-all remains the synchronous full-table contract for unmodified
  // consumers; this entrypoint only registers public/auth routes so idle
  // /login never pulls private dashboard chunks.
  const [{ registerPublicCloudSurfaces }, mod] = await Promise.all([
    import("@elizaos/ui/cloud/register-public"),
    import("@elizaos/ui/cloud/shell/CloudRouterShell"),
  ]);
  // Public/auth only on shell boot. Private dashboard domains are loaded by
  // CloudRouterShell when a /cloud/* path is visited — never from idle /login.
  registerPublicCloudSurfaces();
  return { default: mod.CloudRouterShell };
});

/** Approved marketing surfaces bundled only into the hosted web shell. */
const MarketingHomePage = lazy(async () => {
  if (__ELIZA_WEB_SHELL__ !== true) {
    throw new Error("MarketingHomePage is web-build-only");
  }
  return import("@homepage/embedded-home");
});

const MarketingDownloadsPage = lazy(async () => {
  if (__ELIZA_WEB_SHELL__ !== true) {
    throw new Error("MarketingDownloadsPage is web-build-only");
  }
  return import("@homepage/embedded-downloads");
});

/**
 * Simulator-only production chat gallery. Keeping this behind the literal
 * build flag makes the harness (and its fixture providers) unreachable from
 * ordinary web and native bundles.
 */
const ChatWidgetHarness = lazy(async () => {
  if (__ELIZA_CHAT_UI_HARNESS__ !== true) {
    throw new Error("ChatWidgetHarness is disabled in this build");
  }
  const mod = await import("@elizaos/ui/components/chat/ChatWidgetHarness");
  return { default: mod.ChatWidgetHarness };
});

// Only /dev mounts the inspector; normal routes ignore the old session opt-in.
const DeveloperWorkspace = lazy(async () => {
  const mod = await import(
    "@elizaos/ui/components/developer/DeveloperWorkspace"
  );
  return { default: mod.DeveloperWorkspace };
});
const developerWorkspaceEnabled = isDeveloperWorkspaceRoute();

/**
 * The shell owns the parametric cloud / public / auth / payment routes and
 * renders the tab/view app as the catch-all. It applies only to the main
 * window on the web platform — native (Capacitor) and the desktop Electrobun
 * shell mount the tab/view app directly with no bundle growth, and the special
 * window shells (phone companion / detached / app window) are never cloud
 * surfaces.
 */
function shouldMountWebShell(): boolean {
  if (__ELIZA_WEB_SHELL__ !== true) return false;
  if (isNative) return false;
  if (isElectrobunRuntime()) return false;
  return true;
}

function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  // Refresh HMR-edited component/config handles without repeating bridge setup.
  setBootConfig(buildAppBootConfig());

  const phoneCompanion = isPhoneCompanionMode();
  const detachedShell = isDetachedWindowShell(windowShellRoute);
  const appWindowSlug = detachedShell ? null : resolveAppWindowSlug();
  const isSpecialWindowShell =
    phoneCompanion || detachedShell || appWindowSlug !== null;

  // The normal main-window tab/view app subtree (the existing default render).
  // Kept verbatim so the tab system is untouched; on the web platform it
  // becomes the router shell's catch-all `appElement`.
  const appSubtree = (
    <>
      <DesktopSurfaceNavigationRuntime />
      <DesktopTrayRuntime />
      {/* #9946: this GUI shell is the single owner of the modality contract,
          so every leaf's detectDomModality() reads one authoritative source.
          #9948: provide the canonical role context once, under AppProvider, so
          any view can gate developer/owner surfaces with useRole/<RoleGate>. */}
      <ShellModalityProvider modality="gui">
        <ShellRoleProvider>
          {developerWorkspaceEnabled && !isSpecialWindowShell ? (
            <DeveloperWorkspace>
              <App />
            </DeveloperWorkspace>
          ) : (
            <App />
          )}
        </ShellRoleProvider>
      </ShellModalityProvider>
    </>
  );

  const mainTree =
    __ELIZA_CHAT_UI_HARNESS__ === true ? (
      <ChatWidgetHarness />
    ) : shouldMountWebShell() && !isSpecialWindowShell ? (
      <CloudRouterShell
        marketingHomeElement={<MarketingHomePage />}
        downloadsElement={<MarketingDownloadsPage />}
        appElement={
          <AppProvider branding={APP_BRANDING}>{appSubtree}</AppProvider>
        }
      />
    ) : (
      <AppProvider branding={APP_BRANDING}>
        {phoneCompanion ? (
          <ShellViewAgentSurface
            viewId={PHONE_COMPANION_AGENT_VIEW_ID}
            surfaceKind="app-shell"
          >
            <PhoneCompanionApp />
          </ShellViewAgentSurface>
        ) : detachedShell ? (
          <div className="flex h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden bg-bg">
            <DetachedShellRoot route={windowShellRoute} />
          </div>
        ) : appWindowSlug ? (
          <div className="flex h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden bg-bg">
            <AppWindowRenderer slug={appWindowSlug} />
          </div>
        ) : (
          appSubtree
        )}
      </AppProvider>
    );

  markStartup("react-mount:start");
  rendererBootstrap.root ??= createRoot(rootEl);
  rendererBootstrap.root.render(
    <ErrorBoundary>
      <StrictMode>
        <Suspense fallback={null}>
          <RenderTelemetryProfiler id="AppRoot">
            {mainTree}
          </RenderTelemetryProfiler>
        </Suspense>
      </StrictMode>
    </ErrorBoundary>,
  );
  markStartup("react-mount:end");
  measureStartup("react-mount", "react-mount:start", "react-mount:end");
}

function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  return getWindowUrlSearchParams().has("popout");
}

function isTrustedPrivateHttpHost(host: string): boolean {
  return (
    host === "0.0.0.0" ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
}

function isLoopbackApiHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * Dedicated Cloud agents serve their runtime on the canonical managed-agent
 * hostname family. The shared classifier also recognizes legacy agent hosts
 * during the DNS migration; control-plane hosts never match this predicate.
 */
function isElizaCloudAgentSubdomain(host: string): boolean {
  return isElizaDedicatedAgentHostname(host);
}

function isNativeIosStoreBuild(): boolean {
  return isNative && isIOS && isStoreBuild;
}

function isIosLocalAgentIpcUrl(parsed: URL): boolean {
  return parsed.protocol === "eliza-local-agent:" && parsed.hostname === "ipc";
}

function isPrivateOrLoopbackApiHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    isLoopbackApiHost(normalized) ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    isTrustedPrivateHttpHost(normalized)
  );
}

function isNativeIosCloudRuntimeMode(): boolean {
  if (!isNative || !isIOS) return false;
  const mode = getCurrentIosRuntimeConfig().mode;
  return mode === "cloud" || mode === "cloud-hybrid";
}

function usesStrictIosNetworkPolicy(): boolean {
  return isNativeIosStoreBuild() || isNativeIosCloudRuntimeMode();
}

function isTruthyBuildFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true";
}

function allowsIosSimulatorLoopbackApiBase(parsed: URL): boolean {
  return (
    isNative &&
    isIOS &&
    !isNativeIosStoreBuild() &&
    isTruthyBuildFlag(
      import.meta.env.VITE_ELIZA_IOS_ALLOW_SIMULATOR_LOOPBACK,
    ) &&
    isLoopbackApiHost(parsed.hostname)
  );
}

function canUseIosLocalAgentIpc(): boolean {
  return isNative && isIOS && getCurrentIosRuntimeConfig().mode === "local";
}

function isCurrentOriginHost(host: string): boolean {
  return typeof window !== "undefined" && host === window.location.hostname;
}

function isConfiguredCloudApiHost(host: string): boolean {
  const configured = IOS_RUNTIME_ENV_CONFIG.cloudApiBase;
  if (!configured) return false;
  try {
    return host === new URL(configured).hostname;
  } catch {
    // error-policy:J3 unparseable configured base — fail closed (untrusted)
    return false;
  }
}

function isTrustedApiBaseUrl(parsed: URL): boolean {
  if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (usesStrictIosNetworkPolicy()) {
    if (allowsIosSimulatorLoopbackApiBase(parsed)) return true;
    if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
      return false;
    }
    return (
      isCurrentOriginHost(host) ||
      isConfiguredCloudApiHost(host) ||
      isElizaCloudSharedHost(host) ||
      isElizaCloudAgentSubdomain(host)
    );
  }
  if (isPopoutWindow() && parsed.protocol === "https:") return true;
  if (isTrustedCloudOnlyApiBaseUrl(parsed, APP_BRANDING.cloudOnly === true)) {
    return true;
  }
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

function isTrustedDeepLinkApiBaseUrl(parsed: URL): boolean {
  if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (isTrustedCloudOnlyApiBaseUrl(parsed, APP_BRANDING.cloudOnly === true)) {
    return true;
  }
  if (usesStrictIosNetworkPolicy()) {
    if (allowsIosSimulatorLoopbackApiBase(parsed)) return true;
    if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
      return false;
    }
    return (
      isCurrentOriginHost(host) ||
      (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
      (parsed.protocol === "https:" && isElizaCloudSharedHost(host)) ||
      (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host))
    );
  }
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

function isTrustedNativeWebSocketUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
    if (!usesStrictIosNetworkPolicy()) return true;
    return (
      parsed.protocol === "wss:" && !isPrivateOrLoopbackApiHost(parsed.hostname)
    );
  } catch {
    // error-policy:J3 unparseable bridge URL — fail closed (untrusted)
    return false;
  }
}

/**
 * Validates an apiBase string and applies it to the boot config.
 * Allows local dev hosts outside store iOS, configured cloud/current-origin
 * HTTPS, and the iOS in-app local-agent IPC identity.
 */
function validateAndSetApiBase(apiBase: string): void {
  try {
    const parsed = new URL(apiBase);
    if (isTrustedApiBaseUrl(parsed)) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn(
        `${APP_LOG_PREFIX} Rejected non-local apiBase:`,
        parsed.hostname,
      );
    }
  } catch {
    // error-policy:J3 not an absolute URL — accept only a same-origin
    // relative path, otherwise reject loudly
    if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn(
        `${APP_LOG_PREFIX} Rejected invalid relative apiBase:`,
        apiBase,
      );
    }
  }
}

function injectPopoutApiBase(): void {
  const params = getWindowUrlSearchParams();
  const apiBase = params.get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function injectWaifuChatAccessToken(): void {
  const params = getWindowUrlSearchParams();
  const waifuAccessToken = params.get("waifu_access_token")?.trim();
  if (waifuAccessToken) {
    setBootConfig({ ...getBootConfig(), apiToken: waifuAccessToken });
    window.history.replaceState(
      window.history.state,
      "",
      removeUrlParameter(window.location.href, "waifu_access_token"),
    );
  }
}

function injectDetachedShellApiBase(): void {
  const apiBase = getWindowUrlSearchParams().get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function getCurrentIosRuntimeConfig(): IosRuntimeConfig {
  if (typeof window === "undefined") return IOS_RUNTIME_ENV_CONFIG;
  try {
    const mode = normalizeMobileRuntimeMode(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    );
    if (!mode) return IOS_RUNTIME_ENV_CONFIG;
    return { ...IOS_RUNTIME_ENV_CONFIG, mode };
  } catch {
    // error-policy:J3 unavailable storage — build-time runtime config
    return IOS_RUNTIME_ENV_CONFIG;
  }
}

function applyBuildTimeIosConnection(): void {
  if (!isNative) return;

  const current = getBootConfig();
  const next: AppBootConfig = {
    ...current,
    ...(isIOS && IOS_RUNTIME_ENV_CONFIG.mode === "local"
      ? { apiBase: IOS_LOCAL_AGENT_IPC_BASE }
      : {}),
    ...(IOS_RUNTIME_ENV_CONFIG.apiToken
      ? { apiToken: IOS_RUNTIME_ENV_CONFIG.apiToken }
      : {}),
  };
  setBootConfig(next);

  if (isIOS && IOS_RUNTIME_ENV_CONFIG.mode === "local") return;
  if (!IOS_RUNTIME_ENV_CONFIG.apiBase && !IOS_RUNTIME_ENV_CONFIG.apiToken)
    return;

  if (IOS_RUNTIME_ENV_CONFIG.apiBase) {
    validateAndSetApiBase(IOS_RUNTIME_ENV_CONFIG.apiBase);
  }
}

async function getOrCreateDeviceBridgeId(): Promise<string> {
  // The device-bridge id is a stable per-install identifier, not durable native
  // config. On Android sideloads the Capacitor `Preferences` plugin can report
  // "not implemented on android" — the same condition `mobile-runtime-mode.ts`
  // already tolerates for the runtime-mode store. A hard Preferences dependency
  // here previously rejected the whole device-bridge startup ("Device bridge
  // unavailable: Preferences plugin is not implemented on android"), which left
  // on-device local inference with no connected device to route to. Read and
  // persist through Preferences when it works, but fall back to localStorage,
  // which is always present in the WebView origin and persists across restarts.
  const readPersisted = async (): Promise<string | undefined> => {
    try {
      const fromPrefs = (
        await Preferences.get({ key: DEVICE_BRIDGE_ID_KEY })
      ).value?.trim();
      if (fromPrefs) return fromPrefs;
    } catch {
      // error-policy:J4 Preferences unavailable on this platform — fall
      // through to localStorage
    }
    return (
      globalThis.localStorage?.getItem(DEVICE_BRIDGE_ID_KEY)?.trim() ||
      undefined
    );
  };

  const existing = await readPersisted();
  if (existing) return existing;

  const prefix = isAndroid ? "android" : isIOS ? "ios" : "mobile";
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    await Preferences.set({ key: DEVICE_BRIDGE_ID_KEY, value: generated });
  } catch {
    // error-policy:J6 Preferences unavailable — localStorage below is the
    // durable fallback
  }
  try {
    shellLocalStorage.setItem(DEVICE_BRIDGE_ID_KEY, generated);
  } catch {
    // error-policy:J6 no persistent store available — the id is still
    // usable for this session
  }
  return generated;
}

function resolveDeviceBridgeUrl(config: IosRuntimeConfig): string | null {
  if (config.deviceBridgeUrl) {
    return isTrustedNativeWebSocketUrl(config.deviceBridgeUrl)
      ? config.deviceBridgeUrl
      : null;
  }
  // cloud-hybrid: paired phone dials a remote agent via the cloud apiBase.
  // Android local: the foreground agent service owns the loopback API and the
  // WebView dials its device bridge for native llama.cpp calls.
  // iOS local: requests are handled by the in-process ITTP route kernel, so a
  // loopback WebSocket bridge is both unnecessary and unsafe in simulator runs
  // where host-level adb port forwarding can expose another device's agent.
  if (config.mode === "local" && isIOS) return null;
  if (config.mode === "local" && isAndroid) {
    return apiBaseToDeviceBridgeUrl(MOBILE_LOCAL_AGENT_API_BASE);
  }
  if (config.mode !== "cloud-hybrid" && config.mode !== "local") return null;
  const apiBase = getBootConfig().apiBase?.trim();
  if (!apiBase) return null;
  try {
    const bridgeUrl = apiBaseToDeviceBridgeUrl(apiBase);
    return isTrustedNativeWebSocketUrl(bridgeUrl) ? bridgeUrl : null;
  } catch {
    // error-policy:J3 underivable/untrusted bridge URL — fail closed (no bridge)
    return null;
  }
}

async function readAndroidLocalAgentToken(): Promise<string | undefined> {
  if (!isAndroid) return undefined;
  try {
    const result = await Agent.getLocalAgentToken?.();
    const token = result?.token?.trim();
    return token ? token : undefined;
  } catch {
    // error-policy:J4 bridge probe — tokenless config proceeds and the local
    // agent's 401 surfaces through the request path
    return undefined;
  }
}

async function configureMobileBackgroundRunner(retry = 0): Promise<void> {
  if (!isNative || (!isIOS && !isAndroid)) return;

  const runtimeConfig = getCurrentIosRuntimeConfig();
  const bootConfig = getBootConfig();
  const bootApiBase = bootConfig.apiBase?.trim();
  let authToken =
    bootConfig.apiToken?.trim() || runtimeConfig.apiToken?.trim() || undefined;

  if (isAndroid && runtimeConfig.mode === "local") {
    authToken = (await readAndroidLocalAgentToken()) ?? authToken;
  }

  const details: Record<string, unknown> = {
    platform,
    mode: runtimeConfig.mode,
  };
  const apiBase = bootApiBase || runtimeConfig.apiBase?.trim();
  if (apiBase) details.apiBase = apiBase;
  if (authToken) details.authToken = authToken;
  if (isAndroid && runtimeConfig.mode === "local") {
    details.localApiBase = MOBILE_LOCAL_AGENT_API_BASE;
  }
  if (isIOS && runtimeConfig.mode === "local") {
    details.localApiBase = IOS_LOCAL_AGENT_IPC_BASE;
    details.localRouteKernel =
      runtimeConfig.fullBun || isNativeIosStoreBuild()
        ? "bun-host-ipc"
        : "ittp";
  }

  try {
    await BackgroundRunner.dispatchEvent({
      label: BACKGROUND_RUNNER_LABEL,
      event: "configure",
      details,
    });
  } catch (error) {
    // error-policy:J4 optional native module — absence logged, app degrades
    console.warn(
      `${APP_LOG_PREFIX} Background runner unavailable:`,
      error instanceof Error ? error.message : error,
    );
  }

  if (isAndroid && runtimeConfig.mode === "local" && !authToken && retry < 2) {
    window.setTimeout(
      () => void configureMobileBackgroundRunner(retry + 1),
      BACKGROUND_RUNNER_CONFIG_RETRY_MS * (retry + 1),
    );
  }
}

async function initializeMobileDeviceBridge(): Promise<void> {
  const runtimeConfig = getCurrentIosRuntimeConfig();
  if (
    !isNative ||
    (runtimeConfig.mode !== "cloud-hybrid" && runtimeConfig.mode !== "local")
  ) {
    return;
  }
  if (mobileDeviceBridgeClient) return;
  if (mobileDeviceBridgeStartPromise) return;

  const agentUrl = resolveDeviceBridgeUrl(runtimeConfig);
  if (!agentUrl) return;

  mobileDeviceBridgeStartPromise = (async () => {
    try {
      const [{ startDeviceBridgeClient }, deviceId] = await Promise.all([
        import("@elizaos/capacitor-llama"),
        getOrCreateDeviceBridgeId(),
      ]);
      const pairingToken =
        runtimeConfig.deviceBridgeToken?.trim() ||
        (isAndroid && runtimeConfig.mode === "local"
          ? await readAndroidLocalAgentToken()
          : undefined);
      if (isAndroid && runtimeConfig.mode === "local" && !pairingToken) {
        window.setTimeout(
          () => void initializeMobileDeviceBridge(),
          BACKGROUND_RUNNER_CONFIG_RETRY_MS,
        );
        return;
      }
      mobileDeviceBridgeClient = startDeviceBridgeClient({
        agentUrl,
        ...(pairingToken ? { pairingToken } : {}),
        deviceId,
        onStateChange: (state, detail) => {
          console.info(
            `${APP_LOG_PREFIX} Device bridge ${state}`,
            detail ?? "",
          );
        },
      });
      // The on-device agent (Bun) can't reach ElizaCamera; serve its file-drop
      // camera-capture requests from the WebView, which owns the plugin. Only
      // needed on Android local/hybrid — the exact modes that run an on-device
      // agent — and started once per session.
      if (isAndroid && !cameraBridgeResponderStop) {
        const { startCameraBridgeResponder } = await import(
          "./camera-bridge-responder"
        );
        cameraBridgeResponderStop = startCameraBridgeResponder();
        console.info(`${APP_LOG_PREFIX} Camera bridge responder started`);
      }
    } catch (error) {
      // error-policy:J4 optional native module — absence logged, app degrades
      console.warn(
        `${APP_LOG_PREFIX} Device bridge unavailable:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      mobileDeviceBridgeStartPromise = null;
    }
  })();

  await mobileDeviceBridgeStartPromise;
}

function stopMobileDeviceBridge(): void {
  mobileDeviceBridgeClient?.stop();
  mobileDeviceBridgeClient = null;
}

async function initializeMobileAgentTunnel(): Promise<void> {
  const runtimeConfig = getCurrentIosRuntimeConfig();
  if (!isNative || (!isIOS && !isAndroid)) return;
  if (runtimeConfig.mode !== "tunnel-to-mobile") return;
  if (mobileAgentTunnelStartPromise) return;
  const relayUrl = runtimeConfig.tunnelRelayUrl;
  if (!relayUrl) {
    console.warn(
      `${APP_LOG_PREFIX} tunnel-to-mobile mode requires VITE_ELIZA_TUNNEL_RELAY_URL`,
    );
    return;
  }
  if (!isTrustedNativeWebSocketUrl(relayUrl)) {
    console.warn(`${APP_LOG_PREFIX} Rejected unsafe mobile tunnel relay URL`);
    return;
  }

  mobileAgentTunnelStartPromise = (async () => {
    try {
      const [{ MobileAgentBridge }, deviceId] = await Promise.all([
        import("@elizaos/capacitor-mobile-agent-bridge"),
        getOrCreateDeviceBridgeId(),
      ]);

      if (!mobileAgentTunnelListener) {
        mobileAgentTunnelListener = await MobileAgentBridge.addListener(
          "stateChange",
          (event) => {
            console.info(
              `${APP_LOG_PREFIX} Mobile agent tunnel ${event.state}`,
              event.reason ?? "",
            );
          },
        );
      }

      const status = await MobileAgentBridge.startInboundTunnel({
        relayUrl,
        deviceId,
        ...(runtimeConfig.tunnelPairingToken
          ? { pairingToken: runtimeConfig.tunnelPairingToken }
          : {}),
        ...(isAndroid
          ? { localAgentApiBase: MOBILE_LOCAL_AGENT_API_BASE }
          : {}),
      });
      console.info(
        `${APP_LOG_PREFIX} Mobile agent tunnel ${status.state}`,
        status.lastError ?? "",
      );
    } catch (error) {
      // error-policy:J4 optional native module — absence logged, app degrades
      console.warn(
        `${APP_LOG_PREFIX} Mobile agent tunnel unavailable:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      mobileAgentTunnelStartPromise = null;
    }
  })();

  await mobileAgentTunnelStartPromise;
}

async function stopMobileAgentTunnel(): Promise<void> {
  mobileAgentTunnelStartPromise = null;
  try {
    const { MobileAgentBridge } = await import(
      "@elizaos/capacitor-mobile-agent-bridge"
    );
    await MobileAgentBridge.stopInboundTunnel();
  } catch (error) {
    // error-policy:J6 teardown — stop failure is logged
    console.warn(
      `${APP_LOG_PREFIX} Mobile agent tunnel stop failed:`,
      error instanceof Error ? error.message : error,
    );
  }
  try {
    await mobileAgentTunnelListener?.remove();
  } catch {
    // error-policy:J6 teardown — the native tunnel stop above is
    // authoritative
  }
  mobileAgentTunnelListener = null;
}

function initializeMobileRuntimeModeListener(): void {
  if (!isNative || mobileRuntimeModeListenerInstalled) return;
  mobileRuntimeModeListenerInstalled = true;
  document.addEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, () => {
    const mode = getCurrentIosRuntimeConfig().mode;
    if (mode === "cloud-hybrid" || mode === "local") {
      stopMobileDeviceBridge();
      void stopMobileAgentTunnel();
      void initializeMobileDeviceBridge();
      void configureMobileBackgroundRunner();
      return;
    }
    if (mode === "tunnel-to-mobile") {
      stopMobileDeviceBridge();
      void initializeMobileAgentTunnel();
      void configureMobileBackgroundRunner();
      return;
    }
    stopMobileDeviceBridge();
    void stopMobileAgentTunnel();
    void configureMobileBackgroundRunner();
  });
}

function applyStoredDetachedShellTheme(): void {
  applyUiTheme(resolveUiTheme(loadUiThemeMode()));
}

/**
 * Native vision bridges (renderer-pulled screen-capture + OCR) are OFF by
 * default. Each opens a 1.2s poll loop against the agent's `/api/vision/*`
 * routes the instant the app boots — before the local agent is reachable that
 * is pure churn (503 spam, device-bridge flap, wasted battery/network) and it
 * buys nothing until the vision feature is actually in use. Opt in per build
 * with `VITE_ELIZA_VISION_BRIDGES=1`.
 */
function initVisionBridgesIfEnabled(): void {
  if (import.meta.env.VITE_ELIZA_VISION_BRIDGES !== "1") return;
  initScreenCaptureBridge();
  initOcrBridge();
}

async function main(): Promise<void> {
  markStartup("main-start");
  markStartup("app-modules:start");
  await initializeAppModules();
  markStartup("app-modules:end");
  measureStartup("app-modules", "app-modules:start", "app-modules:end");

  if (__ELIZA_SERVICE_WORKER__ === true) {
    const { registerViewServiceWorker } = await import("./sw-registration");
    registerViewServiceWorker();
  }

  // #9947: when served at /embed inside a Telegram Mini App / Discord Activity
  // iframe, exchange the platform's signed launch payload for a scoped session
  // token and install it on the ElizaClient BEFORE any authenticated agent API
  // call is made. No-op (and never throws) off the /embed route.
  await runEmbedHandshake({ client });

  // The headless device gate owns the WebView when requested, so resolve it
  // before route/plugin initialization can add unrelated work or early exits.
  if (
    await runIosFullBunEntrypoint({
      isIOS,
      initializeStorageBridge,
      initializeCapacitorBridge,
      installNativeRequestBridge: installIosLocalAgentNativeRequestBridge,
      installFetchBridge: installIosLocalAgentFetchBridge,
      runSmoke: runIosFullBunSmokeFromDesktopShell,
    })
  ) {
    return;
  }

  setupPlatformStyles();
  applyBuildTimeIosConnection();

  try {
    await applyLaunchConnectionFromUrl();
  } catch (err) {
    // error-policy:J4 the launch-URL session apply is best-effort — the
    // failure is logged and normal boot (with its own auth flows) proceeds
    console.error(
      `${APP_LOG_PREFIX} Failed to apply managed cloud launch session:`,
      err instanceof Error ? err.message : err,
    );
  }

  injectWaifuChatAccessToken();

  // Kick the hashed @elizaos/ui/voice chunk fetch off NOW — before any
  // storage-bridge await — so it downloads concurrently with the native
  // Preferences hydration below instead of serializing after it. The module
  // is only consumed at the per-platform await sites further down; load
  // failure resolves null there (never gates mounting the app).
  const voiceModuleReady = startVoiceModuleLoad();

  if (isPopoutWindow()) {
    injectPopoutApiBase();
    rendererBootstrap.mount();
    scheduleDeferredAppModuleLoadsAfterPaint();
    return;
  }

  if (isStandaloneWindowShell(windowShellRoute)) {
    injectDetachedShellApiBase();
    applyStoredDetachedShellTheme();
    if (isDetachedWindowShell(windowShellRoute)) {
      syncDetachedShellLocation(windowShellRoute);
    }
    await initializeStorageBridge();
    initializeCapacitorBridge();
    // The desktop main window uses the standalone chat-overlay route, but it
    // still owns the global shortcut and tray event wiring. Without this the
    // early standalone-shell return paints the pill while silently skipping
    // every native desktop control.
    if (isChatOverlayWindowShell(windowShellRoute) && isDesktopPlatform()) {
      await initializeDesktopShell();
    }
    rendererBootstrap.mount();
    scheduleDeferredAppModuleLoadsAfterPaint();
    return;
  }

  markStartup("bridges:start", { platform });
  // Storage hydration must complete BEFORE mountReactApp: React reads the
  // persisted session/first-run/theme state through localStorage on first
  // render, and on native those keys only exist after the Preferences
  // hydration lands. The voice chunk (kicked off above) downloads in parallel
  // with this wait.
  await initializeStorageBridge();
  if (isAndroid) {
    await installMobileRemoteFallback(undefined, client);
  }
  if (isIOS) {
    initializeCapacitorBridge();
    installIosLocalAgentNativeRequestBridge();
    installIosLocalAgentFetchBridge();
    // Renderer-pulled screen-capture bridge (#9105): poll the agent for
    // capture requests and serve frames via the Capacitor ScreenCapture
    // plugin. Idempotent + native-gated; runs only after the local-agent
    // fetch bridge is installed so `/api/...` routes resolve to the agent.
    initVisionBridgesIfEnabled();
    // On-device AEC acoustic-loop evidence harness (#11373): exposes
    // window.__aecLoop and the tap-free `elizaos://aec-loop?...` trigger so
    // the real speaker→mic echo loop can be driven + captured on hardware.
    (await voiceModuleReady)?.installAecLoopHarness();
  } else if (isAndroid) {
    initializeCapacitorBridge();
    if (!isAndroidCloudBuild()) {
      installAndroidNativeAgentFetchBridge();
      // Renderer-pulled screen-capture bridge (#9105): poll the agent for
      // capture requests and serve frames via the Capacitor ScreenCapture
      // plugin. Idempotent + native-gated; runs only after the Android fetch
      // bridge is installed so `/api/...` routes resolve to the agent.
      initVisionBridgesIfEnabled();
      // Expose window.__diarizationPump (WebView→bun-agent PCM pump) and
      // window.__jniVoice (the in-process JNI voice pipeline — the four fused
      // voice classifiers running IN the bionic app process via the ElizaVoice
      // host, replacing the musl bun-agent transport) so both can be driven +
      // read on-device via CDP.
      const voice = await voiceModuleReady;
      if (voice) {
        voice.installDiarizationPumpHarness();
        voice.installJniVoiceHarness();
        // On-device AEC acoustic-loop evidence harness (#11373):
        // window.__aecLoop plus the `elizaos://aec-loop?...` tap-free trigger.
        voice.installAecLoopHarness();
      }
    }
  }
  // Desktop fused on-device wake (#10351): forward native libwakeword fires from
  // the agent process to the renderer's `eliza:fused-wake` bridge so the
  // battery-efficient on-device path drives the bottom bar — not just the
  // Swabble fallback. Awaited before mountReactApp ONLY on desktop, where
  // useWakeController's first-render capability probe reads
  // `window.__ELIZA_FUSED_WAKE__`; on web/mobile the registration is a no-op
  // (no electrobun RPC), so blocking first paint on the voice chunk there
  // bought nothing — it runs after mount instead (see below).
  if (isDesktopPlatform()) {
    (await voiceModuleReady)?.registerDesktopFusedWake();
  }
  markStartup("bridges:end", { platform });
  measureStartup("bridges", "bridges:start", "bridges:end");
  rendererBootstrap.mount();
  scheduleDeferredAppModuleLoadsAfterPaint();
  if (!isDesktopPlatform()) {
    // Off-desktop registerDesktopFusedWake self-gates to a no-op; keep calling
    // it post-mount so any host that DOES expose the electrobun RPC without
    // the desktop platform marker still wires the channel.
    void voiceModuleReady.then((voice) => voice?.registerDesktopFusedWake());
  }
  await initializePlatform();
}

// main() awaits fallible pre-mount chunks; a bare invocation would leave any
// rejection unhandled and the page permanently blank. Route every boot failure
// to an actionable reload card instead.
function boot(): void {
  if (rendererBootstrap.bootPromise) {
    if (rendererBootstrap.root) rendererBootstrap.mount();
    return;
  }
  // error-policy:J1 boot boundary — every rejection renders the reload card
  rendererBootstrap.bootPromise = Promise.resolve()
    .then(main)
    .catch((error) => {
      // Platform setup can fail after mounting. Release React ownership before
      // the failure renderer replaces #root with its explicit reload card.
      rendererBootstrap.root?.unmount();
      rendererBootstrap.root = null;
      renderBootFailure(error);
    });
}

// Android can deliver a warm ACTION_VIEW while a WebView navigation is replacing
// the old document. Arm URL capture before DOMContentLoaded so the intent cannot
// be sent only to the previous document's dead Capacitor callback registry.
if (isNative && !rendererBootstrap.deepLinksInitialized) {
  getMobileLifecycle().initializeDeepLinks();
  rendererBootstrap.deepLinksInitialized = true;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.removeEventListener("DOMContentLoaded", boot);
  });
}

export { isAndroid, isDesktopPlatform as isDesktop, isIOS, isNative, platform };
