/** Owns android cloud policy using the shared build context and existing platform contracts. */

import path from "node:path";
import process from "node:process";
import {
  ANDROID_LP3_POLICY_CLASSES,
  ANDROID_LP3_POLICY_MARKERS,
  ANDROID_LP3_PRIVATE_ACTIONS,
  resolveAndroidArtifactKind,
} from "../../lib/android-cloud-artifact-audit.mjs";
import {
  ANDROID_CLOUD_ROUTING_MARKERS,
  findAndroidCloudRoutingMarkers,
} from "../../lib/android-cloud-routing-markers.mjs";
import { mobileBuildError } from "../build-error.mjs";
import { APP } from "../context.mjs";
import { isTruthyEnv } from "../environment.mjs";

export const ANDROID_CLOUD_SPLASH_MARK_RESOURCE = "eliza_cloud_splash_mark";

export const ANDROID_CLOUD_SPLASH_MARK_SIZE = 288;

export function applyAndroidCloudSplashTheme(source, { cloudBuild }) {
  // The native project is reused across build lanes. The non-cloud lane
  // removes this drawable, so its previous theme reference must go with it.
  if (!cloudBuild) {
    return source.replace(
      /\n\s*<item\s+name=["']windowSplashScreenAnimatedIcon["'][^>]*>\s*@drawable\/eliza_cloud_splash_mark\s*<\/item>/g,
      "",
    );
  }

  const launchThemePattern =
    /(<style\s+name=["']AppTheme\.NoActionBarLaunch["'][^>]*>)([\s\S]*?)(<\/style>)/;
  const launchTheme = source.match(launchThemePattern);
  if (!launchTheme) {
    throw new Error(
      "[mobile-build] Android launch theme AppTheme.NoActionBarLaunch is missing",
    );
  }

  const splashIconPattern =
    /\n\s*<item\s+name=["']windowSplashScreenAnimatedIcon["'][^>]*>[^<]*<\/item>/g;
  const bodyWithoutCloudIcon = launchTheme[2].replace(splashIconPattern, "");
  const body = bodyWithoutCloudIcon.replace(
    /(\n\s*<item\s+name=["']windowSplashScreenBackground["'][^>]*>[^<]*<\/item>)/,
    `$1\n        <item name="windowSplashScreenAnimatedIcon">@drawable/${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}</item>`,
  );

  if (!body.includes(`@drawable/${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}`)) {
    throw new Error(
      "[mobile-build] Android launch theme is missing windowSplashScreenBackground",
    );
  }

  return source.replace(launchThemePattern, `$1${body}$3`);
}

// ── Android cloud (Play-Store) strip set ────────────────────────────────
//
// The local Android targets can inject an on-device agent runtime,
// role-resolver activities (dialer, SMS, browser, contacts, camera,
// calendar, clock, assistant, in-call), a boot receiver, and the privileged
// appop / usage-stats / full-control permissions that AOSP needs but Play
// Store rejects. Only the `android-system` target exposes those role
// activities as launcher/home surfaces; the stock sideload APK keeps a
// single app-drawer entry. The `android-cloud` target produces a thin
// Capacitor client backed by Eliza Cloud and must not ship any of those
// components.
//
// Components deleted from the manifest (and from app/src/main/java/...):
export const ANDROID_LP3_COLOR_POLICY_COMPONENTS = [
  "Lp3ColorPolicyInitializer",
  "Lp3ColorPolicyService",
  "Lp3ColorPolicyBootReceiver",
];

export const ANDROID_LP3_COLOR_POLICY_PERMISSIONS = [
  "WRITE_SECURE_SETTINGS",
  "RECEIVE_BOOT_COMPLETED",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_SPECIAL_USE",
];

export const ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS = [
  ...ANDROID_LP3_COLOR_POLICY_PERMISSIONS,
  "POST_NOTIFICATIONS",
];

export const ANDROID_LP3_COLOR_POLICY_JAVA_FILES = [
  "Lp3ColorPolicy.java",
  "Lp3ColorPolicyInitializer.java",
  "Lp3ColorPolicyService.java",
  "Lp3ColorPolicyBootReceiver.java",
];

export const ANDROID_LP3_COLOR_POLICY_COMMAND_ACTIONS = [
  "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY",
  "ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY",
  "ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY",
];

export const ANDROID_LP3_COLOR_POLICY_ACTIONS = [
  "android.intent.action.BOOT_COMPLETED",
  "android.intent.action.MY_PACKAGE_REPLACED",
  ...ANDROID_LP3_COLOR_POLICY_COMMAND_ACTIONS,
];

export const ANDROID_CLOUD_STRIPPED_COMPONENTS = [
  "GatewayConnectionService",
  "ElizaAgentService",
  "ElizaDialActivity",
  "ElizaAssistActivity",
  "ElizaVoiceInteractionService",
  "ElizaVoiceInteractionSessionService",
  "ElizaRecognitionService",
  // Voice-input IME: its transcription depends on the on-device engine's
  // loopback ASR, which the cloud thin-client does not ship, so strip it here.
  "ElizaVoiceInputMethodService",
  "ElizaAccessibilityService",
  "ElizaInCallService",
  "ElizaNotificationListenerService",
  "ElizaVoiceCaptureService",
  "ElizaVoiceTileService",
  "ElizaQuickActionsWidgetProvider",
  "ElizaSmsReceiver",
  "ElizaMmsReceiver",
  "ElizaSmsGatewayService",
  "ElizaRespondViaMessageService",
  "ElizaSmsComposeActivity",
  "ElizaBootReceiver",
  "ElizaBrowserActivity",
  "ElizaContactsActivity",
  "ElizaCameraActivity",
  "ElizaClockActivity",
  "ElizaCalendarActivity",
  ...ANDROID_LP3_COLOR_POLICY_COMPONENTS,
];

// Permissions removed from the manifest. Anything that triggers a Play
// Store policy review (sensitive runtime perms, system-only signature
// perms, default-role / call / SMS perms, background location) gets
// dropped. The Play client retains ordinary HTTPS networking, user-triggered
// microphone voice, foreground location, and notifications. It has no
// background location/service, camera, Bluetooth, health, telephony, or
// shared-storage contract.
export const ANDROID_CLOUD_STRIPPED_PERMISSIONS = [
  "CAMERA",
  "BLUETOOTH_SCAN",
  "BLUETOOTH_CONNECT",
  "BLUETOOTH",
  "BLUETOOTH_ADMIN",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_DATA_SYNC",
  "WRITE_EXTERNAL_STORAGE",
  "READ_EXTERNAL_STORAGE",
  "WAKE_LOCK",
  "SCHEDULE_EXACT_ALARM",
  "VIBRATE",
  "READ_CONTACTS",
  "WRITE_CONTACTS",
  "CALL_PHONE",
  "READ_PHONE_STATE",
  "ANSWER_PHONE_CALLS",
  "MANAGE_OWN_CALLS",
  "READ_CALL_LOG",
  "WRITE_CALL_LOG",
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
  "ACCESS_BACKGROUND_LOCATION",
  "FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "FOREGROUND_SERVICE_MICROPHONE",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "RECEIVE_BOOT_COMPLETED",
  "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "SYSTEM_ALERT_WINDOW",
  "PACKAGE_USAGE_STATS",
  "MANAGE_APP_OPS_MODES",
  "MANAGE_VIRTUAL_MACHINE",
  "READ_FRAME_BUFFER",
  "INJECT_EVENTS",
  "REAL_GET_TASKS",
  "BIND_ACCESSIBILITY_SERVICE",
  "BIND_NOTIFICATION_LISTENER_SERVICE",
  "BIND_DEVICE_ADMIN",
  "WRITE_SECURE_SETTINGS",
];

// Some kept Capacitor plugins can reintroduce source-stripped permissions via
// library manifest merge. Add removal markers only for verified merge offenders;
// the artifact audit below still fails if any other stripped permission leaks.
export const ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS = [
  "ACCESS_BACKGROUND_LOCATION",
  "RECEIVE_BOOT_COMPLETED",
  "SCHEDULE_EXACT_ALARM",
  "WAKE_LOCK",
];

// Java sources removed from the merged sources tree so they don't
// reference manifest-stripped classes and break compilation.
export const ANDROID_CLOUD_STRIPPED_JAVA_FILES = [
  "BatteryOptimizationPlugin.java",
  "BionicDecodeLoop.java",
  "DeviceRamTierPolicy.java",
  "ElizaQuickActionsWidgetProvider.java",
  "ElizaTasksWorker.java",
  "ElizaVoiceNative.java",
  "ElizaVoicePlugin.java",
  "ElizaVoiceTileService.java",
  "GatewayConnectionService.java",
  "GlassBridgePlugin.java",
  "InferenceMemoryPolicy.java",
  "NativeTranscriptPlugin.java",
  "NativeTranscriptReducer.java",
  "ResourceProbePlugin.java",
  "AndroidVirtualizationBridge.java",
  "ElizaAgentService.java",
  "ElizaAgentWatchdogPolicy.java",
  // On-device agent helpers that only ElizaAgentService drives: the cold-boot
  // asset-extraction policy (170 MB agent bundle staging) and the in-process
  // bionic/llama GPU inference server. They import/reference ElizaAgentService,
  // so they must be removed alongside it or the cloud target compiles a dangling
  // reference and auditAndroidCloudSource rejects the tree (#15106).
  "ElizaAssetExtractionPolicy.java",
  "ElizaBionicInferenceServer.java",
  "ElizaAccessibilityService.java",
  "ElizaAssistActivity.java",
  "ElizaVoiceInteractionService.java",
  "ElizaVoiceInteractionSessionService.java",
  "ElizaVoiceInteractionSession.java",
  "ElizaRecognitionService.java",
  "ElizaVoiceInputMethodService.java",
  "ElizaBootReceiver.java",
  "ElizaApplication.java",
  "ElizaWorkScheduler.java",
  "ElizaNotificationListenerService.java",
  "ElizaVoiceCaptureService.java",
  "VoiceCapturePlugin.java",
  "ElizaBrowserActivity.java",
  "ElizaCalendarActivity.java",
  "ElizaCameraActivity.java",
  "ElizaClockActivity.java",
  "ElizaContactsActivity.java",
  "ElizaDialActivity.java",
  "ElizaInCallService.java",
  "ElizaMmsReceiver.java",
  "ElizaSmsGatewayService.java",
  "ElizaRespondViaMessageService.java",
  "ElizaSmsComposeActivity.java",
  "ElizaSmsReceiver.java",
  ...ANDROID_LP3_COLOR_POLICY_JAVA_FILES,
];

// Host-side JVM tests for source-stripped on-device runtime code must not be
// compiled in the generated Play tree. Keep them in the canonical Android
// source tree so direct/local targets retain their coverage, but remove them
// alongside the production classes they exercise for cloud builds.
export const ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES = [
  "BionicDecodeLoopTest.java",
  "DeviceRamTierPolicyTest.java",
  "ElizaAgentAutostartPolicyTest.java",
  "ElizaAssetExtractionPolicyTest.java",
  "ElizaWorkSchedulerPolicyTest.java",
  "InferenceMemoryPolicyTest.java",
  "NativeTranscriptReducerTest.java",
];

export function isAndroidLp3ColorPolicyEnabled(env = process.env) {
  return ["1", "true", "yes"].includes(
    String(env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function resolveAndroidLp3ColorPolicyBuildEnv(env = process.env) {
  return {
    ...env,
    ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: isAndroidLp3ColorPolicyEnabled(env)
      ? "1"
      : "0",
  };
}

export function isAndroidLp3RemoteFallbackRequired(env = process.env) {
  return ["1", "true", "yes"].includes(
    String(env.ELIZA_ANDROID_LP3_REMOTE_FALLBACK_REQUIRED ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function isAndroidVpsSidecarBuild(env = process.env) {
  return isTruthyEnv(env.ELIZA_ANDROID_VPS_SIDECAR);
}

export function enforceAndroidLp3RemoteFallbackBuildPolicy({
  targetName,
  env = process.env,
}) {
  const lp3Required = isAndroidLp3RemoteFallbackRequired(env);
  const sidecarRequired = isAndroidVpsSidecarBuild(env);
  if (!lp3Required && !sidecarRequired) return;
  if (lp3Required && sidecarRequired) {
    throw new Error(
      "[mobile-build] LP3 and VPS sidecar remote profiles are mutually exclusive.",
    );
  }
  if (targetName !== "android-cloud-debug") {
    throw new Error(
      "[mobile-build] remote fallback profiles are restricted to android-cloud-debug.",
    );
  }
  if (lp3Required && !isAndroidLp3ColorPolicyEnabled(env)) {
    throw new Error(
      "[mobile-build] ELIZA_ANDROID_LP3_REMOTE_FALLBACK_REQUIRED is restricted to the LP3 android-cloud-debug direct profile.",
    );
  }
  if (sidecarRequired && isAndroidLp3ColorPolicyEnabled(env)) {
    throw new Error(
      "[mobile-build] ELIZA_ANDROID_VPS_SIDECAR must not enable the LP3 color policy.",
    );
  }
  const raw = String(env.VITE_ELIZA_REMOTE_FALLBACK_API_BASE ?? "").trim();
  if (!raw) {
    throw new Error(
      "[mobile-build] the remote fallback profile requires VITE_ELIZA_REMOTE_FALLBACK_API_BASE",
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    // error-policy:J2 preserve the parser cause while adding build-profile context.
    throw new Error(
      "[mobile-build] VITE_ELIZA_REMOTE_FALLBACK_API_BASE must be a valid root HTTPS origin",
      { cause },
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/, "") !== ""
  ) {
    throw new Error(
      "[mobile-build] VITE_ELIZA_REMOTE_FALLBACK_API_BASE must be a credential-free root HTTPS origin without a custom port",
    );
  }
}

// LP3 is an elizaOS direct-debug policy, never a whitelabel capability. Build
// entrypoints pass their resolved identity explicitly so nested hosts cannot
// leak ambient branding into these pure policy helpers.
export const ANDROID_LP3_CANONICAL_APP_ID = "ai.elizaos.app";

export function enforceAndroidLp3ColorPolicyBuildPolicy({
  targetName,
  env = process.env,
  appId = ANDROID_LP3_CANONICAL_APP_ID,
}) {
  if (!isAndroidLp3ColorPolicyEnabled(env)) return;
  const playSignaled =
    env.ELIZA_PLAY_STORE_BUILD === "1" ||
    String(env.ELIZA_BUILD_VARIANT ?? "").toLowerCase() === "store";
  const nonCanonicalTree =
    env.ELIZA_ANDROID_USE_APP_DIR === "1" || appId !== "ai.elizaos.app";
  if (
    targetName !== "android-cloud-debug" ||
    playSignaled ||
    nonCanonicalTree
  ) {
    throw new Error(
      "[mobile-build] ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED is restricted to " +
        "the canonical android-cloud-debug direct-distribution lane; it is " +
        "forbidden for release, Play, SMS gateway, sideload, AOSP, app-dir, " +
        "and whitelabel targets.",
    );
  }
}

export function isAndroidFirebaseIndependentRemoteBuild(env = process.env) {
  return (
    isAndroidLp3RemoteFallbackRequired(env) || isAndroidVpsSidecarBuild(env)
  );
}

export function resolveAndroidCloudStripPolicy(env = process.env) {
  const stripPolicy = !isAndroidLp3ColorPolicyEnabled(env)
    ? {
        components: ANDROID_CLOUD_STRIPPED_COMPONENTS,
        permissions: ANDROID_CLOUD_STRIPPED_PERMISSIONS,
        mergerRemovedPermissions:
          ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS,
        javaFiles: ANDROID_CLOUD_STRIPPED_JAVA_FILES,
        testJavaFiles: ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES,
      }
    : (() => {
        const allowedComponents = new Set(ANDROID_LP3_COLOR_POLICY_COMPONENTS);
        const allowedPermissions = new Set(
          ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS,
        );
        const allowedJavaFiles = new Set(ANDROID_LP3_COLOR_POLICY_JAVA_FILES);
        return {
          components: ANDROID_CLOUD_STRIPPED_COMPONENTS.filter(
            (component) => !allowedComponents.has(component),
          ),
          permissions: ANDROID_CLOUD_STRIPPED_PERMISSIONS.filter(
            (permission) => !allowedPermissions.has(permission),
          ),
          mergerRemovedPermissions:
            ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS.filter(
              (permission) => !allowedPermissions.has(permission),
            ),
          javaFiles: ANDROID_CLOUD_STRIPPED_JAVA_FILES.filter(
            (file) => !allowedJavaFiles.has(file),
          ),
          testJavaFiles: ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES,
        };
      })();

  if (!isAndroidFirebaseIndependentRemoteBuild(env)) {
    return { ...stripPolicy, safePushNotifications: true };
  }

  return {
    ...stripPolicy,
    safePushNotifications: false,
    // This wrapper subclasses the native FCM plugin. The dedicated fallback
    // intentionally excludes that dependency because it has no Firebase
    // project, so its Java wrapper must leave the generated tree with it.
    javaFiles: [...stripPolicy.javaFiles, "SafePushNotificationsPlugin.java"],
  };
}

// Java sources that survive the cloud strip but are rewritten (or deleted) by
// rewriteCloudJavaSources() so that the android-cloud tree compiles without
// ElizaAgentService. Kept as an exported single source of truth so the strip
// list and the audit stay in agreement (#15106).
export const ANDROID_CLOUD_REWRITTEN_JAVA_FILES = [
  "MainActivity.java",
  "AgentPlugin.java",
  "ElizaNativeBridge.java",
];

export const ANDROID_CLOUD_STRIPPED_ASSET_FILES = new Set([
  "eliza-tasks.js",
  "llama-cpp-kernels.json",
]);

export const ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES = Object.freeze([
  "agent",
  "runners",
]);

export const ANDROID_CLOUD_STRIPPED_RESOURCE_FILES = [
  path.join("drawable", "eliza_ime_mic_bg.xml"),
  path.join("drawable", "eliza_voice_bar_bg.xml"),
  path.join("drawable", "eliza_voice_bar_dot.xml"),
  path.join("drawable", "eliza_widget_background.xml"),
  path.join("drawable", "eliza_widget_button_background.xml"),
  path.join("drawable", "ic_eliza_ime_keyboard.xml"),
  path.join("drawable", "ic_eliza_ime_mic.xml"),
  path.join("drawable", "ic_eliza_ime_open.xml"),
  path.join("layout", "eliza_quick_actions_widget.xml"),
  path.join("layout", "eliza_voice_ime.xml"),
  path.join("layout", "eliza_voice_interaction_bar.xml"),
  path.join("xml", "eliza_accessibility_service.xml"),
  path.join("xml", "eliza_quick_actions_widget.xml"),
  path.join("xml", "eliza_recognition_service.xml"),
  path.join("xml", "eliza_voice_interaction_service.xml"),
  path.join("xml", "method.xml"),
];

export const ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES = Object.freeze({
  [path.join("values", "android_app_actions.xml")]: Object.freeze([
    "app_widget_quick_actions_description",
    "app_widget_quick_actions_title",
  ]),
  [path.join("values", "strings.xml")]: Object.freeze([
    "assistant_session_prompt",
    "eliza_ime_engine_off",
    "eliza_ime_error_mic",
    "eliza_ime_error_transcribe",
    "eliza_ime_hint",
    "eliza_ime_label",
    "eliza_ime_listening",
    "eliza_ime_model_not_ready",
    "eliza_ime_no_speech",
    "eliza_ime_permission_needed",
    "eliza_ime_prompt",
    "eliza_ime_subtype_voice",
    "eliza_ime_switch_back",
    "eliza_ime_transcribing",
  ]),
});

export const ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS = [
  ["@capacitor-community/bluetooth-le", "capacitor-community-bluetooth-le"],
  ["@capacitor/background-runner", "capacitor-background-runner"],
  ["@capacitor/barcode-scanner", "capacitor-barcode-scanner"],
  ["@capacitor/device", "capacitor-device"],
  ["@capacitor/filesystem", "capacitor-filesystem"],
  ["@capacitor/haptics", "capacitor-haptics"],
  ["@capacitor/share", "capacitor-share"],
  ["@elizaos/capacitor-agent", "elizaos-capacitor-agent"],
  ["@elizaos/capacitor-bun-runtime", "elizaos-capacitor-bun-runtime"],
  ["@elizaos/capacitor-appblocker", "elizaos-capacitor-appblocker"],
  ["@elizaos/capacitor-camera", "elizaos-capacitor-camera"],
  ["@elizaos/capacitor-canvas", "elizaos-capacitor-canvas"],
  ["@elizaos/capacitor-contacts", "elizaos-capacitor-contacts"],
  ["@elizaos/capacitor-gateway", "elizaos-capacitor-gateway"],
  ["@elizaos/capacitor-messages", "elizaos-capacitor-messages"],
  ["@elizaos/capacitor-mlkit-text", "elizaos-capacitor-mlkit-text"],
  [
    "@elizaos/capacitor-mobile-agent-bridge",
    "elizaos-capacitor-mobile-agent-bridge",
  ],
  ["@elizaos/capacitor-mobile-signals", "elizaos-capacitor-mobile-signals"],
  ["@elizaos/capacitor-phone", "elizaos-capacitor-phone"],
  ["@elizaos/capacitor-screencapture", "elizaos-capacitor-screencapture"],
  ["@elizaos/capacitor-swabble", "elizaos-capacitor-swabble"],
  ["@elizaos/capacitor-system", "elizaos-capacitor-system"],
  ["@elizaos/capacitor-talkmode", "elizaos-capacitor-talkmode"],
  ["@elizaos/capacitor-websiteblocker", "elizaos-capacitor-websiteblocker"],
  ["@elizaos/capacitor-wifi", "elizaos-capacitor-wifi"],
  ["llama-cpp-capacitor", "llama-cpp-capacitor"],
];

export const ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES = Object.freeze([
  "@capacitor/app",
  "@capacitor/browser",
  "@capacitor/keyboard",
  "@capacitor/local-notifications",
  "@capacitor/network",
  "@capacitor/preferences",
  "@capacitor/push-notifications",
  "@capacitor/status-bar",
  "@elizaos/capacitor-browser-surface",
  "@elizaos/capacitor-location",
  "@elizaos/capacitor-secure-store",
]);

export function resolveAndroidCloudAllowedNativePluginPackages(
  env = process.env,
) {
  return isAndroidFirebaseIndependentRemoteBuild(env)
    ? ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES.filter(
        (pkg) => pkg !== "@capacitor/push-notifications",
      )
    : [...ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES];
}

export const ANDROID_PLAY_ALLOWED_CAPACITOR_CONFIG_PLUGINS = Object.freeze([
  "CapacitorHttp",
  "Keyboard",
  "SplashScreen",
]);

export const ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS = Object.freeze([
  "cloud.eliza.app",
  "cloud-staging.eliza.app",
]);

/** Resolves the one sanitizer policy shared by write-time and source audits. */
export function resolveAndroidCloudCapacitorConfigPolicy(env = process.env) {
  const launcherKiosk = env.ELIZA_ANDROID_LAUNCHER_BUILD === "1";
  return {
    allowInAppAuthNavigation: launcherKiosk,
    launcherKiosk,
    webViewDebugging: launcherKiosk && env.ELIZA_WEBVIEW_DEBUG === "1",
  };
}

export function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns the minimal runtime config that is safe to package in a Play APK/AAB. */
export function sanitizeAndroidCloudCapacitorConfig(
  value,
  {
    allowInAppAuthNavigation = false,
    launcherKiosk = false,
    webViewDebugging = false,
  } = {},
) {
  if (!isJsonRecord(value)) {
    throw new Error(
      "android-cloud capacitor.config.json must contain an object",
    );
  }
  const sourcePlugins = isJsonRecord(value.plugins) ? value.plugins : {};
  const plugins = {};
  for (const pluginName of ANDROID_PLAY_ALLOWED_CAPACITOR_CONFIG_PLUGINS) {
    const pluginConfig = sourcePlugins[pluginName];
    if (isJsonRecord(pluginConfig)) plugins[pluginName] = pluginConfig;
  }
  const sourceAndroid = isJsonRecord(value.android) ? value.android : {};
  return {
    appId: APP.appId,
    appName: APP.appName,
    webDir: "dist",
    loggingBehavior: "none",
    server: {
      androidScheme: "https",
      ...(allowInAppAuthNavigation
        ? { allowNavigation: [...ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS] }
        : {}),
    },
    plugins,
    android: {
      backgroundColor:
        typeof sourceAndroid.backgroundColor === "string"
          ? sourceAndroid.backgroundColor
          : "#000000",
      allowMixedContent: false,
      captureInput: sourceAndroid.captureInput === true,
      webContentsDebuggingEnabled: launcherKiosk && webViewDebugging,
    },
  };
}

export const ANDROID_PLAY_ALLOWED_PERMISSIONS = Object.freeze([
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.INTERNET",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.RECORD_AUDIO",
  "com.google.android.c2dm.permission.RECEIVE",
  `${APP.appId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
]);

export const ANDROID_PLAY_ALLOWED_COMPONENTS = Object.freeze([
  `activity:${APP.appId}.ElizaShareActivity`,
  `activity:${APP.appId}.MainActivity`,
  "activity:com.capacitorjs.plugins.browser.BrowserControllerActivity",
  "activity:com.google.android.gms.common.api.GoogleApiActivity",
  "provider:com.capacitorjs.plugins.localnotifications.LocalNotificationsAssetProvider",
  "provider:com.google.firebase.provider.FirebaseInitProvider",
  "provider:androidx.core.content.FileProvider",
  "provider:androidx.startup.InitializationProvider",
  "receiver:com.capacitorjs.plugins.localnotifications.LocalNotificationRestoreReceiver",
  "receiver:com.capacitorjs.plugins.localnotifications.NotificationDismissReceiver",
  "receiver:com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher",
  "receiver:com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver",
  "receiver:com.google.firebase.iid.FirebaseInstanceIdReceiver",
  "receiver:androidx.profileinstaller.ProfileInstallReceiver",
  "service:com.capacitorjs.plugins.pushnotifications.MessagingService",
  "service:com.google.android.datatransport.runtime.backends.TransportBackendDiscovery",
  "service:com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService",
  "service:com.google.firebase.components.ComponentDiscoveryService",
  "service:com.google.firebase.messaging.FirebaseMessagingService",
]);

export const ANDROID_PLAY_ALLOWED_ACTIONS = Object.freeze([
  "android.intent.action.BOOT_COMPLETED",
  "android.intent.action.LOCKED_BOOT_COMPLETED",
  "android.intent.action.MAIN",
  "android.intent.action.PROCESS_TEXT",
  "android.intent.action.QUICKBOOT_POWERON",
  "android.intent.action.SEND",
  "android.intent.action.TTS_SERVICE",
  "android.intent.action.VIEW",
  "android.speech.RecognitionService",
  "android.support.customtabs.action.CustomTabsService",
  "androidx.profileinstaller.action.BENCHMARK_OPERATION",
  "androidx.profileinstaller.action.INSTALL_PROFILE",
  "androidx.profileinstaller.action.SAVE_PROFILE",
  "androidx.profileinstaller.action.SKIP_FILE",
  "com.google.android.c2dm.intent.RECEIVE",
  "com.google.firebase.MESSAGING_EVENT",
]);

export const ANDROID_PLAY_ALLOWED_METADATA_NAMES = Object.freeze([
  "android.app.shortcuts",
  "android.support.FILE_PROVIDER_PATHS",
  "androidx.emoji2.text.EmojiCompatInitializer",
  "androidx.lifecycle.ProcessLifecycleInitializer",
  "androidx.profileinstaller.ProfileInstallerInitializer",
  "backend:com.google.android.datatransport.cct.CctBackendFactory",
  "com.google.android.gms.cloudmessaging.FINISHED_AFTER_HANDLED",
  "com.google.android.gms.version",
  "com.google.firebase.components:com.google.firebase.FirebaseCommonKtxRegistrar",
  "com.google.firebase.components:com.google.firebase.datatransport.TransportRegistrar",
  "com.google.firebase.components:com.google.firebase.installations.FirebaseInstallationsKtxRegistrar",
  "com.google.firebase.components:com.google.firebase.installations.FirebaseInstallationsRegistrar",
  "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingKtxRegistrar",
  "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingRegistrar",
]);

export const ANDROID_PLAY_ALLOWED_QUERY_ACTIONS = Object.freeze([
  "android.intent.action.TTS_SERVICE",
  "android.speech.RecognitionService",
  "android.support.customtabs.action.CustomTabsService",
]);

// Firebase Messaging's AndroidX DataStore dependency ships the standard
// cross-process shared-counter JNI helper. Keep an exact ABI allowlist so a
// local-agent or inference library still cannot leak into the Cloud client.
export const ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES = Object.freeze([
  "lib/arm64-v8a/libdatastore_shared_counter.so",
  "lib/armeabi-v7a/libdatastore_shared_counter.so",
  "lib/x86/libdatastore_shared_counter.so",
  "lib/x86_64/libdatastore_shared_counter.so",
]);

export function resolveAndroidCloudAllowedNativeLibraries(env = process.env) {
  return isAndroidFirebaseIndependentRemoteBuild(env)
    ? []
    : [...ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES];
}

/** Enforce the exact Play JNI set at each archive format's native-library root. */
export function assertAndroidCloudNativeLibraryAllowlist({
  artifact,
  entries,
  env = process.env,
} = {}) {
  const artifactKind = resolveAndroidArtifactKind(artifact);
  const artifactRoot = artifactKind === "aab" ? "base/" : "";
  const expectedNativeLibraries = resolveAndroidCloudAllowedNativeLibraries(env)
    .map((entry) => `${artifactRoot}${entry}`)
    .sort();
  const nativeLibraries = entries
    .filter((entry) => /(?:^|\/)lib\/[^/]+\/[^/]+\.so$/i.test(entry))
    .sort();
  if (
    JSON.stringify(nativeLibraries) !== JSON.stringify(expectedNativeLibraries)
  ) {
    throw mobileBuildError(
      `[mobile-build] android-cloud native libraries differ from the Play allowlist:\n${nativeLibraries
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
      {
        code: "ANDROID_PLAY_NATIVE_LIBRARY_ALLOWLIST_FAILED",
        context: { artifact, artifactKind, nativeLibraries },
      },
    );
  }
  return nativeLibraries;
}

export const ANDROID_PLAY_DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </device-transfer>
</data-extraction-rules>
`;

export function applyAndroidPlayManifestHardening(source) {
  let xml = source
    // WorkManager belongs to the local-agent target and is absent from Play.
    .replace(
      /(<application\b[^>]*?)\s+android:name="(?:[\w.]*\.)?ElizaApplication"/,
      "$1",
    )
    .replace(/\s+android:dataExtractionRules="[^"]*"/, "")
    .replace(/\s+android:fullBackupContent="[^"]*"/, "")
    .replace(
      /<application\b/,
      '<application\n        android:dataExtractionRules="@xml/data_extraction_rules"\n        android:fullBackupContent="false"',
    );

  const permissionBlocks = [];
  xml = xml.replace(/\n?[ \t]*<uses-permission\b[\s\S]*?\/>/g, (block) => {
    permissionBlocks.push(block.trim());
    return "";
  });
  if (permissionBlocks.length === 0) return xml;

  const insertion = xml.search(/\n[ \t]*<(?:queries|application)\b/);
  if (insertion < 0) return xml;
  const permissions = permissionBlocks
    .map((block) =>
      block
        .split("\n")
        .map((line) => `    ${line.trimStart()}`)
        .join("\n"),
    )
    .join("\n");
  return `${xml.slice(0, insertion)}\n\n${permissions}${xml.slice(insertion)}`;
}

export const ANDROID_PLAY_FORBIDDEN_ASSET_MARKERS =
  ANDROID_CLOUD_ROUTING_MARKERS;

export const ANDROID_PLAY_FORBIDDEN_INDEX_HTML_MARKERS = Object.freeze([
  "__ELIZA_ANDROID_IPC_FETCH_BRIDGE__",
  "eliza-local-agent:",
  "127.0.0.1",
  "localhost",
  "remote-mac",
]);

export const ANDROID_PLAY_SECRET_PATTERNS = Object.freeze([
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["provider secret", /sk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ["private key", /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/],
  [
    "Cerebras/Cartesia credential",
    /(?:CEREBRAS|CARTESIA)_API_KEY.{0,12}[=:].{0,12}["'][A-Za-z0-9_-]{20,}["']/i,
  ],
]);

export function findAndroidPlayTextAssetFindings(entries, buffers) {
  if (!Array.isArray(entries) || !Array.isArray(buffers)) {
    throw mobileBuildError(
      "[mobile-build] Android Play text asset evidence must use arrays.",
    );
  }
  if (entries.length !== buffers.length) {
    throw mobileBuildError(
      "[mobile-build] Android Play text asset evidence length mismatch.",
    );
  }
  const findings = [];
  for (let index = 0; index < entries.length; index += 1) {
    const content = Buffer.from(buffers[index]).toString("utf8");
    for (const marker of findAndroidCloudRoutingMarkers(content)) {
      findings.push(`${entries[index]}: local routing marker ${marker}`);
    }
    for (const [label, pattern] of ANDROID_PLAY_SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push(`${entries[index]}: ${label}`);
    }
  }
  return [...new Set(findings)].sort();
}

export function findAndroidPlayIndexHtmlFindings(entries, buffers) {
  if (!Array.isArray(entries) || !Array.isArray(buffers)) {
    throw mobileBuildError(
      "[mobile-build] Android Play index HTML evidence must use arrays.",
    );
  }
  if (entries.length !== buffers.length) {
    throw mobileBuildError(
      "[mobile-build] Android Play index HTML evidence length mismatch.",
    );
  }
  const findings = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!/(?:^|\/)assets\/public\/index\.html$/i.test(entries[index])) {
      continue;
    }
    const content = Buffer.from(buffers[index]).toString("utf8").toLowerCase();
    for (const marker of ANDROID_PLAY_FORBIDDEN_INDEX_HTML_MARKERS) {
      if (content.includes(marker.toLowerCase())) {
        findings.push(
          `${entries[index]}: active local bootstrap marker ${marker}`,
        );
      }
    }
  }
  return [...new Set(findings)].sort();
}

export function createAndroidPlayManifestPolicy({
  debug = false,
  firebaseIndependent = false,
} = {}) {
  const policy = {
    actions: [...ANDROID_PLAY_ALLOWED_ACTIONS],
    application: {
      allowBackup: "false",
      debuggable: debug ? "true" : "false",
      usesCleartextTraffic: "false",
    },
    components: [...ANDROID_PLAY_ALLOWED_COMPONENTS],
    metadataNames: [...ANDROID_PLAY_ALLOWED_METADATA_NAMES],
    permissions: [...ANDROID_PLAY_ALLOWED_PERMISSIONS],
    queryActions: [...ANDROID_PLAY_ALLOWED_QUERY_ACTIONS],
    queryPackages: [],
    targetSdkVersion: "36",
  };
  if (!firebaseIndependent) return policy;
  const firebaseComponents = [
    "provider:com.google.firebase.provider.FirebaseInitProvider",
    "receiver:com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver",
    "receiver:com.google.firebase.iid.FirebaseInstanceIdReceiver",
    "service:com.capacitorjs.plugins.pushnotifications.MessagingService",
    "service:com.google.android.datatransport.runtime.backends.TransportBackendDiscovery",
    "service:com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService",
    "service:com.google.firebase.components.ComponentDiscoveryService",
    "service:com.google.firebase.messaging.FirebaseMessagingService",
  ];
  const firebaseMetadata = [
    "backend:com.google.android.datatransport.cct.CctBackendFactory",
    "com.google.android.gms.cloudmessaging.FINISHED_AFTER_HANDLED",
    "com.google.firebase.components:com.google.firebase.datatransport.TransportRegistrar",
    "com.google.firebase.components:com.google.firebase.FirebaseCommonKtxRegistrar",
    "com.google.firebase.components:com.google.firebase.installations.FirebaseInstallationsKtxRegistrar",
    "com.google.firebase.components:com.google.firebase.installations.FirebaseInstallationsRegistrar",
    "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingKtxRegistrar",
    "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingRegistrar",
  ];
  return {
    ...policy,
    actions: policy.actions.filter(
      (action) =>
        action !== "com.google.android.c2dm.intent.RECEIVE" &&
        action !== "com.google.firebase.MESSAGING_EVENT",
    ),
    components: policy.components.filter(
      (component) => !firebaseComponents.includes(component),
    ),
    metadataNames: policy.metadataNames.filter(
      (metadata) => !firebaseMetadata.includes(metadata),
    ),
    permissions: policy.permissions.filter(
      (permission) =>
        permission !== "com.google.android.c2dm.permission.RECEIVE",
    ),
  };
}

export const ANDROID_SMS_GATEWAY_COMPONENTS = new Set([
  "ElizaSmsReceiver",
  "ElizaMmsReceiver",
  "ElizaRespondViaMessageService",
  "ElizaSmsComposeActivity",
  "ElizaSmsGatewayService",
]);

export const ANDROID_SMS_GATEWAY_PERMISSIONS = new Set([
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
]);

export const ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS =
  ANDROID_CLOUD_STRIPPED_COMPONENTS.filter(
    (component) => !ANDROID_SMS_GATEWAY_COMPONENTS.has(component),
  );

export const ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS =
  ANDROID_CLOUD_STRIPPED_PERMISSIONS.filter(
    (permission) => !ANDROID_SMS_GATEWAY_PERMISSIONS.has(permission),
  );

export const ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES = [
  ...ANDROID_CLOUD_STRIPPED_JAVA_FILES.filter(
    (file) => !ANDROID_SMS_GATEWAY_COMPONENTS.has(file.replace(/\.java$/, "")),
  ),
  "SafePushNotificationsPlugin.java",
];

export const ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS = [
  ...ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ["@capacitor/background-runner", "capacitor-background-runner"],
  ["@capacitor/barcode-scanner", "capacitor-barcode-scanner"],
  ["@capacitor/haptics", "capacitor-haptics"],
  ["@capacitor/network", "capacitor-network"],
  ["@capacitor/push-notifications", "capacitor-push-notifications"],
  ["@capacitor/status-bar", "capacitor-status-bar"],
  ["@elizaos/capacitor-camera", "elizaos-capacitor-camera"],
  ["@elizaos/capacitor-canvas", "elizaos-capacitor-canvas"],
  ["@elizaos/capacitor-gateway", "elizaos-capacitor-gateway"],
  ["@elizaos/capacitor-location", "elizaos-capacitor-location"],
  ["@elizaos/capacitor-swabble", "elizaos-capacitor-swabble"],
  ["@elizaos/capacitor-talkmode", "elizaos-capacitor-talkmode"],
];

export function isCloudBannedNativeLibrary(fileName) {
  const normalized = fileName.toLowerCase();
  return (
    normalized.startsWith("libeliza_") ||
    normalized === "libelizainference.so" ||
    normalized === "libelizavoicejni.so" ||
    normalized === "libmtmd.so" ||
    normalized === "libomp.so" ||
    normalized === "libsigsys-handler.so" ||
    /^lib(?:ggml|.*llama).*\.so$/.test(normalized)
  );
}

export function isCloudBannedAsset(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return (
    ANDROID_CLOUD_STRIPPED_ASSET_FILES.has(base) ||
    base === "bun" ||
    base.endsWith(".gguf")
  );
}

export function findAndroidCloudPackagedRuntimeOffenders(entries) {
  if (!Array.isArray(entries)) {
    throw mobileBuildError(
      "[mobile-build] Android artifact entries must be an array.",
      {
        code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
        context: { entriesType: typeof entries },
      },
    );
  }
  return entries.filter((entry) => {
    if (typeof entry !== "string") return true;
    const normalized = entry.replaceAll("\\", "/");
    const baseName = path.posix.basename(normalized);
    const isAsset = /(^|\/)assets\//i.test(normalized);
    const isNativeLibrary = /(^|\/)lib\//i.test(normalized);
    return (
      /(^|\/)assets\/(?:agent|runners)\//i.test(normalized) ||
      // A local-runtime shared library or a loadable dex under assets/ is the
      // same contraband as one packaged conventionally — cloud thin clients
      // must not ship dynamically-loadable native or DEX code at any path.
      (isAsset &&
        (isCloudBannedAsset(baseName) ||
          isCloudBannedNativeLibrary(baseName) ||
          /\.dex$/i.test(baseName))) ||
      (isNativeLibrary && isCloudBannedNativeLibrary(baseName))
    );
  });
}

export function findAndroidManifestElementBlock(
  manifestText,
  elementName,
  qualifiedName,
) {
  const lines = manifestText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)E: (\S+)/);
    if (!match || match[2] !== elementName) continue;
    const indent = match[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const nextElement = lines[end].match(/^(\s*)E: /);
      if (nextElement && nextElement[1].length <= indent) break;
      end += 1;
    }
    const block = lines.slice(index, end).join("\n");
    if (block.includes(qualifiedName)) return block;
  }
  return null;
}

export function assertAndroidLp3ColorPolicyManifest(manifestText) {
  const initializerName = `${APP.appId}.Lp3ColorPolicyInitializer`;
  const serviceName = `${APP.appId}.Lp3ColorPolicyService`;
  const receiverName = `${APP.appId}.Lp3ColorPolicyBootReceiver`;
  const initializer = findAndroidManifestElementBlock(
    manifestText,
    "provider",
    initializerName,
  );
  const service = findAndroidManifestElementBlock(
    manifestText,
    "service",
    serviceName,
  );
  const receiver = findAndroidManifestElementBlock(
    manifestText,
    "receiver",
    receiverName,
  );
  const mainActivity = findAndroidManifestElementBlock(
    manifestText,
    "activity",
    `${APP.appId}.MainActivity`,
  );
  if (!initializer) {
    throw new Error(
      `[mobile-build] opted-in LP3 artifact is missing ${initializerName}`,
    );
  }
  if (!service) {
    throw new Error(
      `[mobile-build] opted-in LP3 artifact is missing ${serviceName}`,
    );
  }
  if (!receiver) {
    throw new Error(
      `[mobile-build] opted-in LP3 artifact is missing ${receiverName}`,
    );
  }
  if (
    !mainActivity ||
    !/android:screenOrientation[^\n]*0x1/.test(mainActivity)
  ) {
    throw new Error(
      "[mobile-build] opted-in LP3 MainActivity must be locked to portrait",
    );
  }
  if (!/android:exported[^\n]*(?:0x0|false)/.test(service)) {
    throw new Error(
      `[mobile-build] opted-in LP3 service must be android:exported=false`,
    );
  }
  if (!/android:exported[^\n]*(?:0x0|false)/.test(initializer)) {
    throw new Error(
      `[mobile-build] opted-in LP3 initializer must be android:exported=false`,
    );
  }
  if (!initializer.includes(`${APP.appId}.lp3-color-policy-initializer`)) {
    throw new Error(
      `[mobile-build] opted-in LP3 initializer is missing its private authority`,
    );
  }
  if (!/android:exported[^\n]*(?:0x0|false)/.test(receiver)) {
    throw new Error(
      `[mobile-build] opted-in LP3 receiver must be android:exported=false`,
    );
  }
  if (
    !/android:foregroundServiceType[^\n]*0x40000000/.test(service) ||
    !service.includes("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE")
  ) {
    throw new Error(
      `[mobile-build] opted-in LP3 service is missing its specialUse foreground contract`,
    );
  }
  for (const action of ANDROID_LP3_COLOR_POLICY_ACTIONS) {
    if (!receiver.includes(action)) {
      throw new Error(
        `[mobile-build] opted-in LP3 receiver is missing action ${action}`,
      );
    }
  }
}

export function assertAndroidArtifactOmitsLp3ManifestMarkers(
  manifestText,
  { appId = ANDROID_LP3_CANONICAL_APP_ID, label, permissions = [] },
) {
  const forbiddenMarkers = [
    ...ANDROID_LP3_POLICY_CLASSES.map((className) => `${appId}.${className}`),
    ...ANDROID_LP3_PRIVATE_ACTIONS,
    ...ANDROID_LP3_POLICY_MARKERS,
    ...permissions.map((permission) => `android.permission.${permission}`),
  ];
  const findings = forbiddenMarkers.filter((marker) =>
    manifestText.includes(marker),
  );
  if (findings.length > 0) {
    throw mobileBuildError(
      `[mobile-build] ${label} artifact manifest still contains LP3 policy markers:\n` +
        findings.map((marker) => `  - ${marker}`).join("\n"),
    );
  }
}

export function assertAndroidLauncherManifest(
  manifestText,
  { label = "android-launcher artifact" } = {},
) {
  const requiredMarkers = [
    "android.intent.action.MAIN",
    "android.intent.category.HOME",
    "android.intent.category.DEFAULT",
  ];
  const sourceFilters = [
    ...manifestText.matchAll(
      /<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g,
    ),
  ].map((match) => match[1]);
  const aaptLines = manifestText.split(/\r?\n/);
  const aaptFilters = [];
  for (let index = 0; index < aaptLines.length; index += 1) {
    const match = aaptLines[index].match(/^(\s*)E: intent-filter\b/);
    if (!match) continue;
    const indent = match[1].length;
    const block = [aaptLines[index]];
    for (let next = index + 1; next < aaptLines.length; next += 1) {
      const nextLine = aaptLines[next];
      const nextElement = nextLine.match(/^(\s*)E: /);
      if (nextElement && nextElement[1].length <= indent) break;
      block.push(nextLine);
    }
    aaptFilters.push(block.join("\n"));
  }
  const intentFilters = sourceFilters.length > 0 ? sourceFilters : aaptFilters;
  if (
    intentFilters.some((filter) =>
      requiredMarkers.every((marker) => filter.includes(marker)),
    )
  ) {
    return;
  }

  const missingMarkers = requiredMarkers.filter(
    (marker) => !manifestText.includes(marker),
  );
  const detail =
    missingMarkers.length > 0
      ? `missing ${missingMarkers.join(", ")}`
      : "MAIN, HOME, and DEFAULT are not declared together in one intent-filter";
  throw mobileBuildError(
    `[mobile-build] ${label} does not qualify for ROLE_HOME: ${detail}`,
  );
}

export function assertAndroidSmsGatewayBadging(badging) {
  for (const perm of ANDROID_SMS_GATEWAY_PERMISSIONS) {
    if (
      !badging.includes(`uses-permission: name='android.permission.${perm}'`)
    ) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact is missing android.permission.${perm}`,
      );
    }
  }
}

export function assertAndroidSmsGatewayArtifactManifest(manifestText) {
  for (const component of ANDROID_SMS_GATEWAY_COMPONENTS) {
    if (!manifestText.includes(`${APP.appId}.${component}`)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest is missing ${APP.appId}.${component}`,
      );
    }
  }
  for (const marker of [
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
  ]) {
    if (!manifestText.includes(marker)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest is missing ${marker}`,
      );
    }
  }
  for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
    if (manifestText.includes(component)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest still references ${component}`,
      );
    }
  }
}
