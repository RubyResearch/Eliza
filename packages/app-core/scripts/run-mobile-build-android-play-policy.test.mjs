/** Locks the standard Google Play Android client to its minimal manifest. */
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { assertAndroidPlayManifestPolicyEvidence } from "./lib/android-cloud-artifact-audit.mjs";
import {
  ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES,
  ANDROID_CLOUD_STRIPPED_ASSET_FILES,
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS,
  ANDROID_PLAY_ALLOWED_CAPACITOR_CONFIG_PLUGINS,
  ANDROID_PLAY_ALLOWED_COMPONENTS,
  ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES,
  ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES,
  ANDROID_PLAY_ALLOWED_PERMISSIONS,
  ANDROID_PLAY_DATA_EXTRACTION_RULES,
  ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES,
  ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS,
  androidPlayManifestEvidenceFromAapt,
  applyAndroidCloudSplashTheme,
  applyAndroidGeneratedBuildTargetProperties,
  applyAndroidPlayManifestHardening,
  assertAndroidCloudNativeLibraryAllowlist,
  createAndroidPlayManifestPolicy,
  findAndroidCloudPackagedRuntimeOffenders,
  findAndroidPlayIndexHtmlFindings,
  findAndroidPlayTextAssetFindings,
  resolveAndroidCloudCapacitorConfigPolicy,
  sanitizeAndroidCloudCapacitorConfig,
} from "./run-mobile-build.mjs";

const VARIABLES_GRADLE = fs.readFileSync(
  new URL("../platforms/android/variables.gradle", import.meta.url),
  "utf8",
);
const APP_BUILD_GRADLE = fs.readFileSync(
  new URL("../platforms/android/app/build.gradle", import.meta.url),
  "utf8",
);
const APP_MAIN_SOURCE = fs.readFileSync(
  new URL("../../app/src/main.tsx", import.meta.url),
  "utf8",
);

const AAPT_MANIFEST = `
  E: manifest (line=2)
    E: uses-sdk (line=3)
      A: android:targetSdkVersion(0x01010270)=(type 0x10)0x24
    E: queries (line=4)
      E: intent (line=5)
        E: action (line=6)
          A: android:name(0x01010003)="android.speech.RecognitionService" (Raw: "android.speech.RecognitionService")
      E: intent (line=7)
        E: action (line=8)
          A: android:name(0x01010003)="android.intent.action.TTS_SERVICE" (Raw: "android.intent.action.TTS_SERVICE")
    E: uses-permission (line=7)
      A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
    E: application (line=8)
      A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff
      A: android:allowBackup(0x01010280)=(type 0x12)0x0
      A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
      E: activity (line=9)
        A: android:name(0x01010003)="ai.elizaos.app.MainActivity" (Raw: "ai.elizaos.app.MainActivity")
        E: intent-filter (line=10)
          E: action (line=11)
            A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
      E: provider (line=12)
        A: android:name(0x01010003)="androidx.core.content.FileProvider" (Raw: "androidx.core.content.FileProvider")
        E: meta-data (line=13)
          A: android:name(0x01010003)="android.support.FILE_PROVIDER_PATHS" (Raw: "android.support.FILE_PROVIDER_PATHS")
`;

describe("Android Play manifest policy", () => {
  it("generates a Cloud-only transparent white system splash theme", () => {
    const base = `<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/splash_background</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>`;
    const cloud = applyAndroidCloudSplashTheme(base, { cloudBuild: true });

    expect(cloud).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@drawable/eliza_cloud_splash_mark</item>',
    );
    expect(cloud).toContain(
      '<item name="windowSplashScreenBackground">@color/splash_background</item>',
    );
    expect(applyAndroidCloudSplashTheme(cloud, { cloudBuild: true })).toBe(
      cloud,
    );
    expect(applyAndroidCloudSplashTheme(cloud, { cloudBuild: false })).toBe(
      base,
    );
    const nonCloud = base.replace(
      '<item name="postSplashScreenTheme">',
      '<item name="windowSplashScreenAnimatedIcon">@drawable/custom_splash</item>\n        <item name="postSplashScreenTheme">',
    );
    expect(applyAndroidCloudSplashTheme(nonCloud, { cloudBuild: false })).toBe(
      nonCloud,
    );

    const transparentWhiteMark = fs.readFileSync(
      new URL(
        "../../app/public/brand/logos/logo_white_nobg.svg",
        import.meta.url,
      ),
      "utf8",
    );
    expect(transparentWhiteMark).toContain('fill="none"');
    expect(transparentWhiteMark).toContain('fill="white"');
    expect(transparentWhiteMark).not.toMatch(/#FF5800/i);
    expect(transparentWhiteMark).not.toMatch(/<rect[^>]+fill=["']#FF5800["']/i);
  });

  it("places permissions before the application and disables all backup transfer", () => {
    const hardened = applyAndroidPlayManifestHardening(`<manifest>
    <queries />
    <application android:name=".ElizaApplication" android:allowBackup="false"></application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`);

    expect(hardened.indexOf("<uses-permission")).toBeLessThan(
      hardened.indexOf("<queries"),
    );
    expect(hardened.indexOf("<uses-permission")).toBeLessThan(
      hardened.indexOf("<application"),
    );
    expect(hardened).toContain(
      'android:dataExtractionRules="@xml/data_extraction_rules"',
    );
    expect(hardened).toContain('android:fullBackupContent="false"');
    expect(hardened).not.toContain('android:name=".ElizaApplication"');
    expect(ANDROID_PLAY_DATA_EXTRACTION_RULES).toContain(
      '<exclude domain="sharedpref" path="." />',
    );
    expect(ANDROID_PLAY_DATA_EXTRACTION_RULES).toContain("<device-transfer>");
  });

  it("packages only the restricted Play-safe Capacitor runtime config", () => {
    const sanitized = sanitizeAndroidCloudCapacitorConfig({
      appId: "ai.elizaos.app",
      appName: "Eliza",
      webDir: "dist",
      server: {
        androidScheme: "http",
        allowNavigation: ["localhost", "127.0.0.1", "*.elizacloud.ai"],
      },
      plugins: {
        Agent: { apiBase: "http://127.0.0.1:31337" },
        BackgroundRunner: { autoStart: true },
        CapacitorHttp: { enabled: true },
        Keyboard: { resize: "body" },
        SplashScreen: { launchShowDuration: 0 },
      },
      android: {
        includePlugins: ["@elizaos/capacitor-bun-runtime"],
        backgroundColor: "#000000",
        allowMixedContent: true,
        captureInput: true,
        webContentsDebuggingEnabled: true,
      },
      ios: { webContentsDebuggingEnabled: true },
    });

    expect(Object.keys(sanitized.plugins).sort()).toEqual(
      [...ANDROID_PLAY_ALLOWED_CAPACITOR_CONFIG_PLUGINS].sort(),
    );
    expect(sanitized.server).toEqual({
      androidScheme: "https",
    });
    expect(sanitized.server).not.toHaveProperty("allowNavigation");
    expect(sanitized.android).toEqual({
      backgroundColor: "#000000",
      allowMixedContent: false,
      captureInput: true,
      webContentsDebuggingEnabled: false,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /eliza\.app|localhost|127\.0\.0\.1|BackgroundRunner|bun-runtime|includePlugins/,
    );
    expect(sanitized).not.toHaveProperty("ios");
    expect(sanitized.loggingBehavior).toBe("none");
  });

  it("preserves Cloud logging suppression and launcher-only WebView inspection", () => {
    const sanitized = sanitizeAndroidCloudCapacitorConfig(
      {
        loggingBehavior: "debug",
        android: { webContentsDebuggingEnabled: false },
      },
      { launcherKiosk: true, webViewDebugging: true },
    );

    expect(sanitized.loggingBehavior).toBe("none");
    expect(sanitized.android.webContentsDebuggingEnabled).toBe(true);
  });

  it("removes the SafePush source when SMS builds remove its native dependency", () => {
    expect(ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES).toContain(
      "SafePushNotificationsPlugin.java",
    );
    expect(
      ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS.map(([pkg]) => pkg),
    ).toContain("@capacitor/push-notifications");
  });

  it("allows only canonical hosted-auth navigation in launcher config", () => {
    expect(resolveAndroidCloudCapacitorConfigPolicy({})).toEqual({
      allowInAppAuthNavigation: false,
      launcherKiosk: false,
      webViewDebugging: false,
    });
    expect(
      resolveAndroidCloudCapacitorConfigPolicy({
        ELIZA_ANDROID_LAUNCHER_BUILD: "1",
        ELIZA_WEBVIEW_DEBUG: "1",
      }),
    ).toEqual({
      allowInAppAuthNavigation: true,
      launcherKiosk: true,
      webViewDebugging: true,
    });
    const launcher = sanitizeAndroidCloudCapacitorConfig(
      { plugins: {}, android: {} },
      { allowInAppAuthNavigation: true, launcherKiosk: true },
    );
    const play = sanitizeAndroidCloudCapacitorConfig({
      plugins: {},
      android: {},
    });

    expect(launcher.server.allowNavigation).toEqual([
      ...ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS,
    ]);
    expect(play.server.allowNavigation).toBeUndefined();
  });

  it("keeps the unused native Google identity stack out of Android source", () => {
    const androidSourceDir = new URL(
      "../platforms/android/app/src/main/java/ai/elizaos/app/",
      import.meta.url,
    );

    expect(APP_BUILD_GRADLE).not.toMatch(/androidx\.credentials|googleid/);
    expect(
      fs.readFileSync(new URL("MainActivity.java", androidSourceDir), "utf8"),
    ).not.toContain("GoogleIdentityPlugin");
    expect(
      fs.existsSync(new URL("GoogleIdentityPlugin.java", androidSourceDir)),
    ).toBe(false);
  });

  it("stamps only generated Cloud projects for direct Gradle and IDE use", () => {
    const base = "org.gradle.jvmargs=-Xmx4g\nelizaCloudBuild=false\n";
    const cloud = applyAndroidGeneratedBuildTargetProperties(base, {
      cloudBuild: true,
    });

    expect(cloud).toContain("elizaCloudBuild=true\n");
    expect(cloud).not.toContain("elizaCloudBuild=false");
    expect(
      applyAndroidGeneratedBuildTargetProperties(cloud, {
        cloudBuild: false,
      }),
    ).toBe("org.gradle.jvmargs=-Xmx4g\n");
  });

  it("parses AAPT xmltree evidence without confusing nested action names for components", () => {
    expect(androidPlayManifestEvidenceFromAapt(AAPT_MANIFEST)).toEqual({
      actions: [
        "android.intent.action.MAIN",
        "android.intent.action.TTS_SERVICE",
        "android.speech.RecognitionService",
      ],
      application: {
        allowBackup: "false",
        debuggable: "true",
        usesCleartextTraffic: "false",
      },
      components: [
        "activity:ai.elizaos.app.MainActivity",
        "provider:androidx.core.content.FileProvider",
      ],
      metadataNames: ["android.support.FILE_PROVIDER_PATHS"],
      permissions: ["android.permission.INTERNET"],
      queryActions: [
        "android.intent.action.TTS_SERVICE",
        "android.speech.RecognitionService",
      ],
      queryPackages: [],
      targetSdkVersion: "36",
    });
  });

  it("accepts only the exact release policy evidence", () => {
    const policy = createAndroidPlayManifestPolicy();
    expect(() =>
      assertAndroidPlayManifestPolicyEvidence(
        {
          ...policy,
          application: { ...policy.application },
        },
        policy,
      ),
    ).not.toThrow();
  });

  it("rejects an unexpected restricted permission or background service", () => {
    const policy = createAndroidPlayManifestPolicy();
    expect(() =>
      assertAndroidPlayManifestPolicyEvidence(
        {
          ...policy,
          application: { ...policy.application },
          components: [
            ...policy.components,
            "service:ai.elizaos.app.GatewayConnectionService",
          ],
          permissions: [...policy.permissions, "android.permission.CAMERA"],
        },
        policy,
      ),
    ).toThrow(
      /unexpected component.*GatewayConnectionService[\s\S]*unexpected permission.*CAMERA/,
    );
  });

  it("keeps policy-hostile surfaces in the strip set and native code out", () => {
    for (const component of [
      "ElizaAccessibilityService",
      "ElizaNotificationListenerService",
      "ElizaVoiceInputMethodService",
      "GatewayConnectionService",
    ]) {
      expect(ANDROID_CLOUD_STRIPPED_COMPONENTS).toContain(component);
    }
    for (const permission of [
      "BIND_ACCESSIBILITY_SERVICE",
      "BIND_NOTIFICATION_LISTENER_SERVICE",
      "CALL_PHONE",
      "CAMERA",
      "READ_SMS",
      "SYSTEM_ALERT_WINDOW",
    ]) {
      expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).toContain(permission);
    }
    expect(ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES).toEqual([
      "lib/arm64-v8a/libdatastore_shared_counter.so",
      "lib/armeabi-v7a/libdatastore_shared_counter.so",
      "lib/x86/libdatastore_shared_counter.so",
      "lib/x86_64/libdatastore_shared_counter.so",
    ]);
    expect(ANDROID_PLAY_ALLOWED_PERMISSIONS).toContain(
      "android.permission.MODIFY_AUDIO_SETTINGS",
    );
    expect(ANDROID_PLAY_ALLOWED_PERMISSIONS).toEqual(
      expect.arrayContaining([
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
      ]),
    );
    expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).not.toEqual(
      expect.arrayContaining([
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
        "POST_NOTIFICATIONS",
      ]),
    );
    expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).toContain(
      "ACCESS_BACKGROUND_LOCATION",
    );
    expect(ANDROID_PLAY_ALLOWED_PERMISSIONS).not.toContain(
      "android.permission.USE_BIOMETRIC",
    );
    expect(ANDROID_PLAY_ALLOWED_PERMISSIONS).not.toContain(
      "android.permission.USE_FINGERPRINT",
    );
    expect(ANDROID_PLAY_ALLOWED_COMPONENTS).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("androidx.credentials"),
        expect.stringContaining("com.google.android.gms"),
      ]),
    );
    expect(ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES).toEqual([
      "agent",
      "runners",
    ]);
    expect(ANDROID_CLOUD_STRIPPED_ASSET_FILES).toContain("eliza-tasks.js");
    expect(
      findAndroidCloudPackagedRuntimeOffenders([
        "base/assets/runners/eliza-tasks.js",
      ]),
    ).toEqual(["base/assets/runners/eliza-tasks.js"]);
    expect(ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES).toEqual([
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
    expect(ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.map(([pkg]) => pkg)).toEqual(
      expect.arrayContaining([
        "@capacitor/background-runner",
        "@elizaos/capacitor-bun-runtime",
        "@elizaos/capacitor-mobile-signals",
        "@elizaos/capacitor-screencapture",
        "@elizaos/capacitor-talkmode",
        "llama-cpp-capacitor",
      ]),
    );
    const strippedNativePackages = ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.map(
      ([pkg]) => pkg,
    );
    for (const allowedPackage of ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES) {
      expect(strippedNativePackages).not.toContain(allowedPackage);
    }
    expect(ANDROID_CLOUD_STRIPPED_RESOURCE_FILES).toEqual(
      expect.arrayContaining([
        "drawable/eliza_ime_mic_bg.xml",
        "drawable/ic_eliza_ime_keyboard.xml",
        "drawable/ic_eliza_ime_mic.xml",
        "drawable/ic_eliza_ime_open.xml",
        "layout/eliza_voice_ime.xml",
        "xml/eliza_accessibility_service.xml",
        "xml/method.xml",
      ]),
    );
    expect(ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES).toMatchObject({
      "values/android_app_actions.xml": [
        "app_widget_quick_actions_description",
        "app_widget_quick_actions_title",
      ],
      "values/strings.xml": expect.arrayContaining([
        "assistant_session_prompt",
        "eliza_ime_label",
        "eliza_ime_permission_needed",
      ]),
    });
  });

  it("accepts only the exact DataStore JNI paths in a Cloud debug APK", () => {
    expect(
      assertAndroidCloudNativeLibraryAllowlist({
        artifact: "/artifacts/app-debug.apk",
        entries: [...ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES],
        env: {},
      }),
    ).toEqual([...ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES]);
  });

  it("rejects extra native code in a Cloud debug APK", () => {
    expect(() =>
      assertAndroidCloudNativeLibraryAllowlist({
        artifact: "/artifacts/app-debug.apk",
        entries: [
          ...ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES,
          "lib/arm64-v8a/libunexpected.so",
        ],
        env: {},
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_PLAY_NATIVE_LIBRARY_ALLOWLIST_FAILED",
        message: expect.stringContaining("lib/arm64-v8a/libunexpected.so"),
      }),
    );
  });

  it("accepts only the exact module-rooted DataStore JNI paths in a Cloud AAB", () => {
    const aabNativeLibraries = ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES.map(
      (entry) => `base/${entry}`,
    );
    expect(
      assertAndroidCloudNativeLibraryAllowlist({
        artifact: "/artifacts/app-release.aab",
        entries: aabNativeLibraries,
        env: {},
      }),
    ).toEqual(aabNativeLibraries);
  });

  it("rejects extra native code in a Cloud AAB", () => {
    expect(() =>
      assertAndroidCloudNativeLibraryAllowlist({
        artifact: "/artifacts/app-release.aab",
        entries: [
          ...ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES.map(
            (entry) => `base/${entry}`,
          ),
          "base/lib/arm64-v8a/libunexpected.so",
        ],
        env: {},
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_PLAY_NATIVE_LIBRARY_ALLOWLIST_FAILED",
        message: expect.stringContaining("base/lib/arm64-v8a/libunexpected.so"),
      }),
    );
  });

  it("targets API 36 and excludes background-worker dependencies in Cloud", () => {
    expect(VARIABLES_GRADLE).toContain("targetSdkVersion = 36");
    expect(APP_BUILD_GRADLE).toContain(
      "project.findProperty('elizaCloudBuild') != 'true'",
    );
    expect(APP_BUILD_GRADLE).toContain(
      'implementation "androidx.work:work-runtime:2.11.0"',
    );
  });

  it("exposes Firebase Messaging to the guarded push plugin in every lane", () => {
    expect(APP_BUILD_GRADLE).toMatch(
      /if \(project\.findProperty\('elizaCloudBuild'\) != 'true'\) \{\s*implementation "com\.google\.firebase:firebase-common-ktx:21\.0\.0"\s*\}\s*\/\/ The push plugin[\s\S]*compileOnly "com\.google\.firebase:firebase-messaging:25\.0\.1"/,
    );
  });

  it("rejects active development routing and credential material in packaged text assets", () => {
    expect(
      findAndroidPlayTextAssetFindings(
        ["base/assets/public/app.js"],
        [Buffer.from("connect to 10.0.2.2 through adb reverse")],
      ),
    ).toEqual([
      "base/assets/public/app.js: local routing marker 10.0.2.2",
      "base/assets/public/app.js: local routing marker adb reverse",
    ]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/sw-registration.js"],
        [Buffer.from('navigator.serviceWorker.register("/sw.js")')],
      ),
    ).toEqual([
      "assets/public/sw-registration.js: local routing marker navigator.serviceWorker",
    ]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/app.js"],
        [Buffer.from("Dormant cross-platform labels: 31337 remote-mac")],
      ),
    ).toEqual([]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/app.js"],
        [Buffer.from('CEREBRAS_API_KEY="not-a-real-key"')],
      ),
    ).toEqual([]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/app.js"],
        [Buffer.from(`CARTESIA_API_KEY="${"a".repeat(24)}"`)],
      ),
    ).toEqual(["assets/public/app.js: Cerebras/Cartesia credential"]);
  });

  it("rejects an active local-agent bootstrap in packaged Play index HTML", () => {
    expect(
      findAndroidPlayIndexHtmlFindings(
        ["base/assets/public/index.html", "base/assets/public/assets/app.js"],
        [
          Buffer.from(
            "connect-src eliza-local-agent:; window.__ELIZA_ANDROID_IPC_FETCH_BRIDGE__ = true;",
          ),
          Buffer.from("eliza-local-agent: remains inert in a lazy chunk"),
        ],
      ),
    ).toEqual([
      "base/assets/public/index.html: active local bootstrap marker __ELIZA_ANDROID_IPC_FETCH_BRIDGE__",
      "base/assets/public/index.html: active local bootstrap marker eliza-local-agent:",
    ]);
  });

  it("does not initialize Android local-agent bridges in the Cloud client", () => {
    expect(APP_MAIN_SOURCE).toContain(
      "if (!isAndroidCloudBuild() && !hasFirstRunRuntimeOverride())",
    );
    expect(APP_MAIN_SOURCE).toContain(
      "if (!isAndroidCloudBuild()) {\n      installAndroidNativeAgentFetchBridge();",
    );
  });
});
