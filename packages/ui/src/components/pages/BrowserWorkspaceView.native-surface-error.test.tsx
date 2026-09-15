/**
 * Verifies the native-mobile-webview error surface distinguishes a permanent
 * WebView capability denial (LP3: system WebView 113 without multi-profile)
 * from a transient transport fault. Permanent shows honest "not supported"
 * copy with an Open-external escape hatch and NO Retry; transient keeps the
 * existing retryable state. The real component renders in jsdom; the surface
 * hook is harness-driven because the native transport does not exist here.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MobileNativeSurfaceError,
  UseMobileNativeTabSurfacesArgs,
} from "../../surface/use-mobile-native-tab-surfaces";

const surfaceHarness = vi.hoisted(() => ({
  error: null as MobileNativeSurfaceError | null,
  retry: vi.fn(),
  reload: vi.fn(),
  back: vi.fn().mockResolvedValue(undefined),
  onNavigation: undefined as UseMobileNativeTabSurfacesArgs["onNavigation"],
}));

const openExternalHarness = vi.hoisted(() => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

// Force the native mobile shell so resolveBrowserTabRenderPath picks
// `native-mobile-webview` for the manifest's `native-webview` isolation.
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
      getPlatform: () => "android",
    },
  };
});

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

vi.mock(
  "../../surface/use-mobile-native-tab-surfaces",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../surface/use-mobile-native-tab-surfaces")
      >();
    return {
      ...actual,
      useMobileNativeTabSurfaces: (args: UseMobileNativeTabSurfacesArgs) => {
        surfaceHarness.onNavigation = args.onNavigation;
        return {
          registerSurfaceElement: vi.fn(),
          navigateSurface: vi.fn(),
          reloadSurface: surfaceHarness.reload,
          backSurface: surfaceHarness.back,
          error: surfaceHarness.error,
          retry: surfaceHarness.retry,
        };
      },
    };
  },
);

vi.mock("../../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils")>();
  return {
    ...actual,
    openExternalUrl: openExternalHarness.openExternalUrl,
  };
});

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  const state = {
    getStewardPending: async () => [],
    getStewardStatus: async () => null,
    setActionNotice: vi.fn(),
    t: (
      _key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : _key,
    plugins: [],
    uiTheme: "dark",
    walletAddresses: [],
    walletConfig: null,
  };
  return {
    ...actual,
    useAppSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAppSelectorShallow: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    client: {
      ...actual.client,
      fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
      getWalletConfig: vi.fn().mockRejectedValue(new Error("no api in test")),
      getBrowserWorkspace: vi.fn().mockResolvedValue({
        mode: "web",
        tabs: [
          {
            id: "tab-1",
            title: "Example",
            url: "https://example.com/",
            partition: "persist:test",
            visible: true,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            lastFocusedAt: null,
          },
        ],
      }),
      openBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      navigateBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      closeBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      snapshotBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
    },
  };
});

import { client } from "../../api";
import { NAVIGATE_VIEW_EVENT } from "../../events";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

beforeEach(() => {
  surfaceHarness.error = null;
  surfaceHarness.retry.mockClear();
  surfaceHarness.reload.mockClear();
  surfaceHarness.back.mockClear();
  vi.mocked(client.fetch).mockClear();
  openExternalHarness.openExternalUrl.mockClear();
  vi.mocked(client.getBrowserWorkspace).mockClear();
  vi.mocked(client.closeBrowserWorkspaceTab).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("BrowserWorkspaceView native surface error states", () => {
  it("retries the current native URL when the agent delivers another navigation", async () => {
    render(<BrowserWorkspaceView />);
    await screen.findByDisplayValue("https://example.com/");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(NAVIGATE_VIEW_EVENT, {
          detail: {
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Fexample.com%2F",
          },
        }),
      );
    });

    expect(surfaceHarness.reload).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(client.navigateBrowserWorkspaceTab).not.toHaveBeenCalled();
  });

  it("reloads the existing native page when its current address is submitted again", async () => {
    render(<BrowserWorkspaceView />);
    const address = await screen.findByDisplayValue("https://example.com/");

    await act(async () => {
      fireEvent.keyDown(address, { key: "Enter" });
    });

    expect(surfaceHarness.reload).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(client.navigateBrowserWorkspaceTab).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(address, { target: { value: "https://next.example/" } });
    });
    await act(async () => {
      fireEvent.keyDown(address, { key: "Enter" });
    });
    expect(surfaceHarness.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue("https://next.example/")).not.toBeNull();
  });

  it("routes Back to the native tab and updates its URL from owned page observations", async () => {
    render(<BrowserWorkspaceView />);
    await screen.findByText("Example");
    vi.mocked(client.fetch).mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });
    expect(surfaceHarness.back).toHaveBeenCalledWith("tab-1");
    expect(client.fetch).not.toHaveBeenCalled();
    act(() => {
      surfaceHarness.onNavigation?.({
        tabId: "tab-1",
        url: "https://next.example/",
        previousUrl: "https://example.com/",
      });
    });
    expect(screen.getByDisplayValue("https://next.example/")).not.toBeNull();
    act(() => {
      surfaceHarness.onNavigation?.({
        tabId: "tab-1",
        url: "https://stale.example/",
        previousUrl: "https://example.com/",
      });
    });
    expect(screen.getByDisplayValue("https://next.example/")).not.toBeNull();
  });
  it("closes all native tabs locally without calling the absent workspace API", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("Example")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close all tabs" }));

    expect(await screen.findByText("No page open")).not.toBeNull();
    expect(client.closeBrowserWorkspaceTab).not.toHaveBeenCalled();
    // The only server read is the initial compatibility snapshot. Close-all
    // itself follows the same client-state lifecycle as one native tab close.
    expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(1);
  });

  it("permanent capability denial: honest copy + Open external, NO Retry", async () => {
    surfaceHarness.error = {
      key: "browser-tab:tab-1:lifecycle",
      message:
        "isolated storage requires WebView multi-profile support; system WebView is too old",
      permanent: true,
    };
    render(<BrowserWorkspaceView />);
    expect(
      await screen.findByText("Secure browsing not supported here"),
    ).not.toBeNull();
    expect(
      screen.getByText(/can’t keep in-app browsing isolated/),
    ).not.toBeNull();
    // Fail-closed with an escape hatch: no Retry that can never succeed.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Scope to the error card: the toolbar renders its own always-present
    // "Open external" icon button with the same accessible name.
    const alertCard = screen.getByRole("alert");
    expect(alertCard.dataset.nativeSurfaceErrorKey).toBe(
      "browser-tab:tab-1:lifecycle",
    );
    expect(alertCard.dataset.nativeSurfaceErrorMessage).toContain(
      "multi-profile support",
    );
    const openExternal = within(alertCard).getByRole("button", {
      name: "Open external",
    });
    await act(async () => {
      fireEvent.click(openExternal);
    });
    expect(openExternalHarness.openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/",
    );
    expect(surfaceHarness.retry).not.toHaveBeenCalled();
  });

  it("transient transport fault: existing retryable state is unchanged", async () => {
    surfaceHarness.error = {
      key: "browser-tab:tab-1:bounds",
      message: "bounds rejected",
      permanent: false,
    };
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("Browser view unavailable")).not.toBeNull();
    expect(screen.queryByText("Secure browsing not supported here")).toBeNull();
    const alertCard = screen.getByRole("alert");
    expect(alertCard.dataset.nativeSurfaceErrorKey).toBe(
      "browser-tab:tab-1:bounds",
    );
    expect(alertCard.dataset.nativeSurfaceErrorMessage).toBe("bounds rejected");
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(surfaceHarness.retry).toHaveBeenCalledTimes(1);
    expect(openExternalHarness.openExternalUrl).not.toHaveBeenCalled();
  });

  it("does not replace native client tabs with an empty server poll", async () => {
    vi.useFakeTimers();
    try {
      render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Example")).not.toBeNull();
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Example")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
