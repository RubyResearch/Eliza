/**
 * Fixture stand-in for `surface/use-mobile-native-tab-surfaces` used by
 * run-browser-surface-error-e2e.mjs. The harness drives the hook's rendered
 * error through `location.hash` so one bundle exercises all three states the
 * REAL BrowserWorkspaceView renders:
 *
 *   #permanent — the LP3 WebView multi-profile capability denial (permanent)
 *   #transient — an ordinary transport fault (retryable)
 *   (empty)    — healthy surface path
 *
 * The native transport itself cannot exist in a desktop browser, which is the
 * one reason this module is stubbed; the component under test stays real.
 */

import type {
  MobileNativeSurfaceError,
  MobileNativeTabSurfaces,
  UseMobileNativeTabSurfacesArgs,
} from "../../../surface/use-mobile-native-tab-surfaces";

declare global {
  interface Window {
    __surfaceRetries: number;
  }
}

function currentError(): MobileNativeSurfaceError | null {
  const hash =
    typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
  if (hash === "permanent") {
    return {
      key: "browser-tab:tab-1:lifecycle",
      message:
        "createSurface(browser-tab:tab-1) failed after 3 attempts: isolated storage requires WebView multi-profile support; system WebView is too old",
      permanent: true,
    };
  }
  if (hash === "transient") {
    return {
      key: "browser-tab:tab-1:bounds",
      message: "setBounds(browser-tab:tab-1) failed after 3 attempts",
      permanent: false,
    };
  }
  return null;
}

export function useMobileNativeTabSurfaces(
  _args: UseMobileNativeTabSurfacesArgs,
): MobileNativeTabSurfaces {
  return {
    registerSurfaceElement: () => {},
    navigateSurface: () => {},
    reloadSurface: () => {},
    backSurface: async () => {},
    readPage: async () => {
      throw new Error("Native page reads are unavailable in this error fixture.");
    },
    error: currentError(),
    retry: () => {
      window.__surfaceRetries = (window.__surfaceRetries ?? 0) + 1;
    },
  };
}
