/**
 * Exercises dynamic view origin enforcement, host externals, and runtime
 * lifecycle behavior against the real loader implementation.
 *
 * @vitest-environment jsdom
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ElizaError, resolveSurfaceManifest } from "@elizaos/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODULE_CACHE_TELEMETRY_EVENT,
  type ModuleCacheTelemetryEvent,
} from "../../cache-telemetry";
import { APP_PAUSE_EVENT } from "../../events";
import { DATABASE_VECTOR_VIEW } from "../../navigation/builtin-route-descriptors";

import { Field } from "../../spatial/primitives";
import {
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";
import {
  __resetDynamicViewLoaderCacheForTests,
  DynamicViewLoader,
  hostImport,
  importAuthenticatedViewBundle,
  isSameOriginBundleUrl,
} from "./DynamicViewLoader";

describe("isSameOriginBundleUrl (view-bundle origin gate)", () => {
  beforeEach(() => {
    activeApiBase.value = "";
  });

  it("accepts same-origin and root-relative /api/views bundle URLs", () => {
    expect(isSameOriginBundleUrl("/api/views/x/bundle.js")).toBe(true);
    expect(
      isSameOriginBundleUrl(`${window.location.origin}/api/views/x/bundle.js`),
    ).toBe(true);
  });

  it("rejects cross-origin bundle URLs (the RCE vector)", () => {
    expect(
      isSameOriginBundleUrl("https://capability.example.test/assets/x.js"),
    ).toBe(false);
    expect(isSameOriginBundleUrl("http://evil.example/x.js")).toBe(false);
    // A protocol-relative URL resolves to a different origin → rejected.
    expect(isSameOriginBundleUrl("//evil.example/x.js")).toBe(false);
  });

  it("accepts the active authenticated API origin used by paired previews", () => {
    activeApiBase.value = "http://127.0.0.1:12488";

    expect(
      isSameOriginBundleUrl(
        "http://127.0.0.1:12488/api/views/calendar/bundle.js",
      ),
    ).toBe(true);
    expect(
      isSameOriginBundleUrl(
        "http://127.0.0.1:12489/api/views/calendar/bundle.js",
      ),
    ).toBe(false);
  });

  it("erases the test import hook from production builds before the origin gate", async () => {
    // jsdom and Node can expose different typed-array realms. esbuild validates
    // TextEncoder against the active Uint8Array constructor when it loads.
    const jsdomUint8Array = globalThis.Uint8Array;
    globalThis.Uint8Array = new TextEncoder().encode("")
      .constructor as typeof Uint8Array;
    let output: { code: string };
    try {
      const { transform } = await import("esbuild");
      const packageRoot = existsSync(resolve(process.cwd(), "packages/ui"))
        ? resolve(process.cwd(), "packages/ui")
        : process.cwd();
      const source = await readFile(
        resolve(packageRoot, "src/components/views/DynamicViewLoader.tsx"),
        "utf8",
      );
      output = await transform(source, {
        loader: "tsx",
        format: "esm",
        minify: true,
        treeShaking: true,
        define: {
          "import.meta.env.DEV": "false",
          "import.meta.env.MODE": '"production"',
          "process.env.NODE_ENV": '"production"',
        },
      });
    } finally {
      globalThis.Uint8Array = jsdomUint8Array;
    }

    expect(output.code).not.toContain("__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__");
    expect(output.code).not.toMatch(/import\((["'])@elizaos\/core\1\)/u);
    expect(output.code).toContain("isSameOriginBundleUrl");
  });
});

describe("host-external importer resolution (factory hostImport)", () => {
  // The served view-bundle factory receives `hostImport` as its parameter; it
  // resolves a specifier to the host shell's live singleton with no globalThis
  // bridge. Exercise that resolver directly here.
  const resolveHostExternal = (
    specifier: string,
  ): Promise<Record<string, unknown>> => hostImport(specifier);

  it("consults an importer contributed through registerHostExternalImporter", async () => {
    const { registerHostExternalImporter } = await import(
      "../../app-shell-registry"
    );
    const marker = { __registered: true };
    registerHostExternalImporter(
      "@test/plugin-registered-external",
      async () => marker,
    );

    await expect(
      resolveHostExternal("@test/plugin-registered-external"),
    ).resolves.toBe(marker);
  });

  it("still resolves a framework module from the trunk map", async () => {
    const react = await resolveHostExternal("react");
    expect(typeof react.useState).toBe("function");
  });

  it("exposes only the browser-safe core view contract", async () => {
    const core = await resolveHostExternal("@elizaos/core");

    expect(core).toEqual({ ElizaError });
    expect(core.ElizaError).toBe(ElizaError);
    expect(Object.isFrozen(core)).toBe(true);
  });

  it("provides the authenticated fetch helper to plugin view bundles", async () => {
    const api = await resolveHostExternal("@elizaos/ui/api/csrf-client");
    expect(typeof api.fetchWithCsrf).toBe("function");
  });

  it("provides the canonical view header to plugin view bundles", async () => {
    const header = await resolveHostExternal(
      "@elizaos/ui/components/shared/ViewHeader",
    );
    expect(typeof header.ViewHeader).toBe("function");
  });

  it("provides the scoped capability recovery hooks used by plugin views", async () => {
    const recovery = await resolveHostExternal(
      "@elizaos/ui/hooks/runtime-capability-retry",
    );
    const authority = await resolveHostExternal(
      "@elizaos/ui/hooks/useActiveAgentAuthority",
    );

    expect(typeof recovery.loadAfterCapabilityWarmup).toBe("function");
    expect(typeof authority.useActiveAgentAuthority).toBe("function");
  });

  it("throws for an unknown specifier that is neither framework nor registered", async () => {
    await expect(
      resolveHostExternal("@test/never-registered-external"),
    ).rejects.toThrow(/unsupported host external/);
  });
});

const { activeApiBase, activeCredential, rawRequest, sendWsMessage } =
  vi.hoisted(() => ({
    activeApiBase: { value: "" },
    activeCredential: "credential-must-never-enter-a-url",
    rawRequest: vi.fn(),
    sendWsMessage: vi.fn(),
  }));

vi.mock("../../api", () => ({
  client: {
    get baseUrl() {
      return activeApiBase.value;
    },
    apiToken: activeCredential,
    rawRequest,
    sendWsMessage,
  },
}));

describe("authenticated protected view bundle loading", () => {
  const secret = activeCredential;

  beforeEach(() => {
    activeApiBase.value = "";
    rawRequest.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fails closed on 401 without importing the response body", async () => {
    rawRequest.mockResolvedValue(
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const moduleImporter = vi.fn();

    await expect(
      importAuthenticatedViewBundle(
        "/api/views/calendar/bundle.js?hostExternalRuntime=1",
        moduleImporter,
      ),
    ).rejects.toThrow("HTTP 401");

    expect(moduleImporter).not.toHaveBeenCalled();
  });

  it("imports a valid JavaScript response from a temporary URL and always revokes it", async () => {
    rawRequest.mockResolvedValue(
      new Response("export default () => null", {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8" },
      }),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/view-bundle");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const loaded = { default: () => null };
    const moduleImporter = vi.fn(async () => loaded);

    await expect(
      importAuthenticatedViewBundle(
        "/api/views/calendar/bundle.js?hostExternalRuntime=1",
        moduleImporter,
      ),
    ).resolves.toBe(loaded);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(moduleImporter).toHaveBeenCalledWith(
      "blob:http://localhost/view-bundle",
    );
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:http://localhost/view-bundle",
    );
  });

  it("allows a slow authenticated bundle download beyond the generic read timeout", async () => {
    vi.useFakeTimers();
    rawRequest.mockImplementation(
      async (
        _path: string,
        _init: RequestInit,
        options: { timeoutMs?: number },
      ) =>
        new Promise<Response>((resolve, reject) => {
          let timeoutId: ReturnType<typeof setTimeout>;
          const responseId = setTimeout(() => {
            clearTimeout(timeoutId);
            resolve(
              new Response("export default () => null", {
                status: 200,
                headers: { "content-type": "application/javascript" },
              }),
            );
          }, 11_000);
          timeoutId = setTimeout(() => {
            clearTimeout(responseId);
            reject(new Error("bundle download timed out"));
          }, options.timeoutMs ?? 10_000);
        }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:http://localhost/slow-view-bundle",
    );
    vi.spyOn(URL, "revokeObjectURL");
    const loaded = { default: () => null };
    const moduleImporter = vi.fn(async () => loaded);

    const importPromise = importAuthenticatedViewBundle(
      "/api/views/calendar/bundle.js?hostExternalRuntime=1",
      moduleImporter,
    );
    await vi.advanceTimersByTimeAsync(11_000);

    await expect(importPromise).resolves.toBe(loaded);
  });

  it.each([
    ["HTML", { "content-type": "text/html; charset=utf-8" }],
    ["a missing content type", {}],
  ])(
    "rejects a successful %s response before module evaluation",
    async (_, headers) => {
      rawRequest.mockResolvedValue(
        new Response("export default () => null", { status: 200, headers }),
      );
      const moduleImporter = vi.fn();

      await expect(
        importAuthenticatedViewBundle(
          "/api/views/calendar/bundle.js?hostExternalRuntime=1",
          moduleImporter,
        ),
      ).rejects.toThrow("response was not JavaScript");

      expect(moduleImporter).not.toHaveBeenCalled();
    },
  );

  it("refuses an unrelated absolute origin before the API client sees it", async () => {
    activeApiBase.value = "http://127.0.0.1:12488";
    const moduleImporter = vi.fn();

    await expect(
      importAuthenticatedViewBundle(
        "https://untrusted.example/api/views/calendar/bundle.js",
        moduleImporter,
      ),
    ).rejects.toThrow("cross-origin view bundle");

    expect(rawRequest).not.toHaveBeenCalled();
    expect(moduleImporter).not.toHaveBeenCalled();
  });

  it("routes an active API-origin URL through the authenticated path transport", async () => {
    activeApiBase.value = "http://127.0.0.1:12488";
    rawRequest.mockResolvedValue(
      new Response("export default () => null", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:http://localhost/paired-view-bundle",
    );
    vi.spyOn(URL, "revokeObjectURL");
    const moduleImporter = vi.fn(async () => ({ default: () => null }));

    await importAuthenticatedViewBundle(
      "http://127.0.0.1:12488/api/views/notes/bundle.js?v=paired",
      moduleImporter,
    );

    expect(rawRequest).toHaveBeenCalledWith(
      "/api/views/notes/bundle.js?v=paired",
      { headers: { Accept: "application/javascript" } },
      expect.objectContaining({ allowNonOk: true }),
    );
  });

  it("revokes the temporary URL when module evaluation fails", async () => {
    rawRequest.mockResolvedValue(
      new Response("throw new Error('invalid bundle')", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:http://localhost/invalid-view-bundle",
    );
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const moduleImporter = vi.fn(async () => {
      throw new Error("module evaluation failed");
    });

    await expect(
      importAuthenticatedViewBundle(
        "/api/views/calendar/bundle.js?hostExternalRuntime=1",
        moduleImporter,
      ),
    ).rejects.toThrow("module evaluation failed");

    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:http://localhost/invalid-view-bundle",
    );
  });

  it("re-fetches on reload without putting the active credential in any URL", async () => {
    rawRequest.mockImplementation(
      async () =>
        new Response("export default () => null", {
          status: 200,
          headers: { "content-type": "text/javascript" },
        }),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:http://localhost/view-bundle-1")
      .mockReturnValueOnce("blob:http://localhost/view-bundle-2");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const moduleImporter = vi.fn(async () => ({ default: () => null }));
    const bundleUrl = "/api/views/notes/bundle.js?v=known-content";

    await importAuthenticatedViewBundle(bundleUrl, moduleImporter);
    await importAuthenticatedViewBundle(bundleUrl, moduleImporter);

    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(rawRequest).toHaveBeenNthCalledWith(
      1,
      bundleUrl,
      { headers: { Accept: "application/javascript" } },
      expect.objectContaining({ allowNonOk: true }),
    );
    const serializedCalls = JSON.stringify([
      rawRequest.mock.calls,
      createObjectURL.mock.calls,
      moduleImporter.mock.calls,
    ]);
    expect(serializedCalls).not.toContain(secret);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("rejects credential-bearing query parameters before the API client sees them", async () => {
    const moduleImporter = vi.fn();

    await expect(
      importAuthenticatedViewBundle(
        `/api/views/notes/bundle.js?access_token=${secret}`,
        moduleImporter,
      ),
    ).rejects.toThrow("embedded credentials");

    expect(rawRequest).not.toHaveBeenCalled();
    expect(moduleImporter).not.toHaveBeenCalled();
  });
});

const AGENT_SURFACE_MANIFEST = { capabilities: ["agent-surface"] } as const;

describe("DynamicViewLoader", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      },
    });
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: {
        escape: (value: string) => value.replaceAll('"', '\\"'),
      },
    });
  });

  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    sendWsMessage.mockClear();
    rawRequest.mockReset();
    cleanup();
    setActiveSurfaceRealmScope(null);
    __resetDynamicViewLoaderCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps a retained inactive module from acquiring the foreground owner's handles", async () => {
    const navigations: string[] = [];
    const makeScope = (id: string) =>
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: ["navigate"] } }),
        id,
        window.localStorage,
        (path) => navigations.push(`${id}:${path}`),
      );
    const loads: Record<string, number> = {};
    const handles: Record<string, (path: string) => void> = {};
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = async (url) => {
      loads[url] = (loads[url] ?? 0) + 1;
      const external = await hostImport("@elizaos/ui/app-navigate-view");
      const navigate = external.navigateBrowserPath as (path: string) => void;
      handles[url] = navigate;
      return {
        default: () => (
          <button type="button" onClick={() => navigate("/settings")}>
            {url}
          </button>
        ),
      };
    };
    const firstUrl = "/api/views/retained-a/bundle.js";
    const secondUrl = "/api/views/foreground-b/bundle.js";
    setActiveSurfaceRealmScope(makeScope("retained-a"));
    try {
      const rendered = render(
        <div>
          <DynamicViewLoader bundleUrl={firstUrl} viewId="retained-a" />
        </div>,
      );
      await screen.findByRole("button", { name: firstUrl });
      act(() => setActiveSurfaceRealmScope(makeScope("foreground-b")));
      rendered.rerender(
        <div>
          <DynamicViewLoader bundleUrl={firstUrl} viewId="retained-a" />
          <DynamicViewLoader bundleUrl={secondUrl} viewId="foreground-b" />
        </div>,
      );
      fireEvent.click(await screen.findByRole("button", { name: secondUrl }));
      expect(() => handles[firstUrl]("/borrowed")).toThrow(
        SurfaceRealmDeniedError,
      );
      expect(loads[firstUrl]).toBe(1);
      expect(navigations).toEqual(["foreground-b:/settings"]);
    } finally {
      cleanup();
      setActiveSurfaceRealmScope(null);
    }
  }, 120_000);

  it("loads both admitted split-layout members with default-deny handles", async () => {
    const navigations: Array<(path: string) => void> = [];
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = async (url) => {
      const external = await hostImport("@elizaos/ui/app-navigate-view");
      navigations.push(external.navigateBrowserPath as (path: string) => void);
      return { default: () => <div>{url}</div> };
    };
    const scope = new SurfaceRealmScope(
      resolveSurfaceManifest(null),
      "layout:a+b",
      window.localStorage,
      () => {
        throw new Error("Layout unexpectedly navigated");
      },
      ["a", "b"],
    );
    setActiveSurfaceRealmScope(scope);
    try {
      render(
        <>
          <DynamicViewLoader bundleUrl="/api/views/a/bundle.js" viewId="a" />
          <DynamicViewLoader bundleUrl="/api/views/b/bundle.js" viewId="b" />
        </>,
      );
      await screen.findByText("/api/views/a/bundle.js");
      await screen.findByText("/api/views/b/bundle.js");
      for (const navigate of navigations)
        expect(() => navigate("/settings")).toThrow(SurfaceRealmDeniedError);
    } finally {
      cleanup();
      setActiveSurfaceRealmScope(null);
    }
  }, 120_000);

  it("re-evaluates mounted namespace handles when the same URL gets a new scope", async () => {
    const navigations: string[] = [];
    const manifest = resolveSurfaceManifest({
      surface: { capabilities: ["navigate", "storage"] },
    });
    const first = new SurfaceRealmScope(
      manifest,
      "scope-panel",
      window.localStorage,
      (path) => navigations.push(`first:${path}`),
    );
    const second = new SurfaceRealmScope(
      manifest,
      "scope-panel",
      window.localStorage,
      (path) => navigations.push(`second:${path}`),
    );
    const handles: Array<{
      navigate: (path: string) => void;
      write: (key: string, value: string) => Promise<void>;
    }> = [];
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = async () => {
      const navigation = await hostImport("@elizaos/ui/app-navigate-view");
      const bridge = await hostImport("@elizaos/ui/bridge");
      if (
        typeof navigation.navigateBrowserPath !== "function" ||
        typeof bridge.setStorageValue !== "function"
      )
        throw new Error("Missing broker handles");
      const handle = {
        navigate: navigation.navigateBrowserPath as (path: string) => void,
        write: bridge.setStorageValue as (
          key: string,
          value: string,
        ) => Promise<void>,
      };
      handles.push(handle);
      const label = `Owned module ${handles.length}`;
      return {
        default: () => (
          <button type="button" onClick={() => handle.navigate("/settings")}>
            {label}
          </button>
        ),
      };
    };
    setActiveSurfaceRealmScope(first);
    try {
      render(
        <DynamicViewLoader
          bundleUrl="/api/views/scope-panel/bundle.js"
          viewId="scope-panel"
        />,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Owned module 1" }),
      );
      await handles[0].write("scope-probe", "first");
      expect(window.localStorage.getItem("scope-probe")).toBe("first");
      act(() => setActiveSurfaceRealmScope(second));
      fireEvent.click(
        await screen.findByRole("button", { name: "Owned module 2" }),
      );
      expect(() => handles[0].navigate("/old")).toThrow(
        SurfaceRealmDeniedError,
      );
      await expect(handles[0].write("scope-probe", "stale")).rejects.toThrow(
        SurfaceRealmDeniedError,
      );
      await handles[1].write("scope-probe", "second");
      expect(window.localStorage.getItem("scope-probe")).toBe("second");
      expect(navigations).toEqual(["first:/settings", "second:/settings"]);
    } finally {
      cleanup();
      setActiveSurfaceRealmScope(null);
      window.localStorage.removeItem("scope-probe");
    }
  }, 120_000);

  it("imports absolute remote bundleUrl directly", async () => {
    const bundleUrl = "https://capability.example.test/assets/remote-panel.js";
    const importBundle = vi.fn(async () => ({
      default: function RemotePanel() {
        return <div>Remote capability panel loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="remote.panel" />);

    await screen.findByText("Remote capability panel loaded");
    expect(importBundle).toHaveBeenCalledWith(bundleUrl, expect.any(Function));
    expect(importBundle).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/views/remote.panel/bundle.js"),
    );
  });

  it("rebinds current controls on scope rotation while old callbacks remain denied", async () => {
    const makeScope = (navigate: (path: string) => void, granted = true) =>
      new SurfaceRealmScope(
        resolveSurfaceManifest({
          surface: { capabilities: granted ? ["navigate"] : [] },
        }),
        "cloud",
        window.localStorage,
        navigate,
      );
    const firstNavigate = vi.fn();
    const firstScope = makeScope(firstNavigate);
    setActiveSurfaceRealmScope(firstScope);
    const callbacks: Array<(path: string) => void> = [];
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const importBundle = vi.fn(async (_url, importHost) => {
      const { navigateBrowserPath } = await importHost(
        "@elizaos/ui/app-navigate-view",
      );
      const navigate = navigateBrowserPath as (path: string) => void;
      callbacks.push(navigate);
      const generation = callbacks.length;
      const dispose = vi.fn();
      cleanups.push(dispose);
      return {
        default: function CurrentControl() {
          const [denied, setDenied] = useState(false);
          return (
            <>
              <button
                type="button"
                onClick={() => {
                  try {
                    navigate("/settings");
                  } catch {
                    setDenied(true);
                  }
                }}
              >
                Open settings {generation}
              </button>
              {denied ? <p role="alert">Navigation denied</p> : null}
            </>
          );
        },
        cleanup: dispose,
      };
    });
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;
    const { rerender } = render(
      <DynamicViewLoader
        bundleUrl="/api/views/cloud/bundle.js"
        viewId="cloud"
        surface={{ capabilities: ["navigate"] }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings 1" }),
    );
    expect(firstNavigate).toHaveBeenCalledWith("/settings");

    act(() => setActiveSurfaceRealmScope(firstScope));
    rerender(
      <DynamicViewLoader
        bundleUrl="/api/views/cloud/bundle.js"
        viewId="cloud"
        surface={{ capabilities: ["navigate"] }}
      />,
    );
    expect(importBundle).toHaveBeenCalledTimes(1);
    const nextNavigate = vi.fn();
    act(() => setActiveSurfaceRealmScope(makeScope(nextNavigate)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings 2" }),
    );
    expect(nextNavigate).toHaveBeenCalledWith("/settings");
    expect(() => callbacks[0]("/stale")).toThrow(SurfaceRealmDeniedError);
    await waitFor(() => expect(cleanups[0]).toHaveBeenCalledTimes(1));

    act(() => setActiveSurfaceRealmScope(makeScope(nextNavigate, false)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings 3" }),
    );
    expect(screen.getByRole("alert").textContent).toBe("Navigation denied");
    expect(() => callbacks[1]("/stale")).toThrow(SurfaceRealmDeniedError);
    expect(nextNavigate).toHaveBeenCalledTimes(1);
    act(() => setActiveSurfaceRealmScope(makeScope(nextNavigate)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings 4" }),
    );
    expect(nextNavigate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a retired async import borrow the new scope or replace its view", async () => {
    const makeScope = () =>
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: ["navigate"] } }),
        "cloud",
        window.localStorage,
        vi.fn(),
      );
    setActiveSurfaceRealmScope(makeScope());
    let resume: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let oldImport:
      | ((specifier: string) => Promise<Record<string, unknown>>)
      | undefined;
    let generation = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(
      async (_url, importHost) => {
        const current = ++generation;
        if (current === 1) {
          oldImport = importHost;
          await paused;
        }
        const module = await importHost("@elizaos/ui/app-navigate-view");
        return {
          default: () => (
            <button
              type="button"
              onClick={() =>
                (module.navigateBrowserPath as (path: string) => void)(
                  "/settings",
                )
              }
            >
              Current {current}
            </button>
          ),
        };
      },
    );
    render(
      <DynamicViewLoader
        bundleUrl="/api/views/cloud/bundle.js"
        viewId="cloud"
      />,
    );
    await waitFor(() => expect(oldImport).toBeDefined());
    act(() => setActiveSurfaceRealmScope(makeScope()));
    await screen.findByRole("button", { name: "Current 2" });
    await act(async () => {
      resume?.();
      await paused;
    });
    await expect(oldImport?.("@elizaos/ui/app-navigate-view")).rejects.toThrow(
      SurfaceRealmDeniedError,
    );
    expect(screen.queryByRole("button", { name: "Current 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Current 2" })).toBeTruthy();
  });

  it("keeps a retained inactive view from borrowing the foreground scope and reloads on return", async () => {
    const navigate = vi.fn();
    const makeScope = (viewId: string) =>
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: ["navigate"] } }),
        viewId,
        window.localStorage,
        navigate,
      );
    setActiveSurfaceRealmScope(makeScope("cloud"));
    const callbacks: Array<(path: string) => void> = [];
    const importBundle = vi.fn(async (_url, importHost) => {
      const module = await importHost("@elizaos/ui/app-navigate-view");
      const callback = module.navigateBrowserPath as (path: string) => void;
      callbacks.push(callback);
      return {
        default: () => (
          <button type="button" onClick={() => callback("/settings")}>
            Connect
          </button>
        ),
      };
    });
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;
    render(
      <DynamicViewLoader
        bundleUrl="/api/views/cloud/bundle.js"
        viewId="cloud"
      />,
    );
    await screen.findByRole("button", { name: "Connect" });
    act(() => setActiveSurfaceRealmScope(makeScope("another-view")));
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(importBundle).toHaveBeenCalledTimes(1);
    expect(() => callbacks[0]("/stale")).toThrow(SurfaceRealmDeniedError);
    act(() => setActiveSurfaceRealmScope(makeScope("cloud")));
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(importBundle).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/settings");
    expect(() => callbacks[0]("/stale")).toThrow(SurfaceRealmDeniedError);
  });

  it("loads explicit layout members without adding grants and revokes removed children", async () => {
    const navigate = vi.fn();
    const makeScope = (members: readonly string[]) =>
      new SurfaceRealmScope(
        resolveSurfaceManifest({}),
        "composed-owner",
        window.localStorage,
        navigate,
        members,
      );
    const initialMembers = ["notes", "calendar"];
    const firstScope = makeScope(initialMembers);
    // The shell's caller-owned collection cannot mutate published authority.
    initialMembers.push("unrelated");
    setActiveSurfaceRealmScope(firstScope);
    const callbacks: Array<(path: string) => void> = [];
    const importBundle = vi.fn(async (url, importHost) => {
      const module = await importHost("@elizaos/ui/app-navigate-view");
      callbacks.push(module.navigateBrowserPath as (path: string) => void);
      const label = url.includes("calendar") ? "Calendar" : "Notes";
      return {
        default: function PaneControl() {
          const [count, setCount] = useState(0);
          return (
            <button type="button" onClick={() => setCount(count + 1)}>
              {label} {count}
            </button>
          );
        },
      };
    });
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;
    render(
      <>
        <DynamicViewLoader
          viewId="notes"
          bundleUrl="/api/views/notes/bundle.js"
        />
        <DynamicViewLoader
          viewId="calendar"
          bundleUrl="/api/views/calendar/bundle.js"
        />
        <DynamicViewLoader
          viewId="unrelated"
          bundleUrl="/api/views/unrelated/bundle.js"
        />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Notes 0" }));
    fireEvent.click(await screen.findByRole("button", { name: "Calendar 0" }));
    expect(screen.getByRole("button", { name: "Notes 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calendar 1" })).toBeTruthy();
    expect(importBundle).toHaveBeenCalledTimes(2);
    expect(() => callbacks[0]("/settings")).toThrow(/no "navigate" grant/);
    expect(navigate).not.toHaveBeenCalled();

    act(() => setActiveSurfaceRealmScope(makeScope(["notes"])));
    await screen.findByRole("button", { name: "Notes 0" });
    expect(screen.queryByRole("button", { name: /Calendar/ })).toBeNull();
    expect(importBundle).toHaveBeenCalledTimes(3);
    expect(() => callbacks[0]("/stale")).toThrow(/stale host external/);
    expect(() => callbacks[1]("/stale")).toThrow(/stale host external/);

    act(() => setActiveSurfaceRealmScope(makeScope(["notes", "calendar"])));
    fireEvent.click(await screen.findByRole("button", { name: "Calendar 0" }));
    expect(screen.getByRole("button", { name: "Calendar 1" })).toBeTruthy();
    expect(importBundle).toHaveBeenCalledTimes(5);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("loads the explicitly declared Database vector child and retires it on navigation", async () => {
    setActiveSurfaceRealmScope(
      new SurfaceRealmScope(
        resolveSurfaceManifest({}),
        "database",
        window.localStorage,
        vi.fn(),
        [DATABASE_VECTOR_VIEW.viewId],
      ),
    );
    const importBundle = vi.fn(async () => ({
      [DATABASE_VECTOR_VIEW.componentExport]: function VectorControl() {
        const [selected, setSelected] = useState(false);
        return (
          <button type="button" onClick={() => setSelected(true)}>
            {selected ? "Vector selected" : "Select vector"}
          </button>
        );
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;
    render(<DynamicViewLoader {...DATABASE_VECTOR_VIEW} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select vector" }),
    );
    expect(
      screen.getByRole("button", { name: "Vector selected" }),
    ).toBeTruthy();
    act(() =>
      setActiveSurfaceRealmScope(
        new SurfaceRealmScope(
          resolveSurfaceManifest({}),
          "settings",
          window.localStorage,
          vi.fn(),
        ),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Vector selected" }),
    ).toBeNull();
    expect(importBundle).toHaveBeenCalledTimes(1);
  });

  it("renders sandboxed iframe views from frameUrl and does not import bundleUrl", () => {
    const importBundle = vi.fn(async () => ({
      default: function ShouldNotLoad() {
        return <div>Host realm bundle loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.panel/bundle.js"
        frameUrl="/api/views/sandboxed.panel/frame.html"
        viewId="sandboxed.panel"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    const frame = screen.getByTestId("sandboxed-view-frame-sandboxed.panel");
    expect(frame.getAttribute("src")).toBe(
      "/api/views/sandboxed.panel/frame.html",
    );
    expect(importBundle).not.toHaveBeenCalled();
    expect(screen.queryByText("Host realm bundle loaded")).toBeNull();
  });

  it("fails closed when sandboxed iframe views omit frameUrl", () => {
    const importBundle = vi.fn(async () => ({
      default: function ShouldNotLoad() {
        return <div>Host realm bundle loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.panel/bundle.js"
        viewId="sandboxed.panel"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    expect(screen.getByText("This view couldn’t open")).toBeTruthy();
    expect(screen.queryByText(/require a frameUrl HTML document/)).toBeNull();
    expect(
      screen.queryByTestId("sandboxed-view-frame-sandboxed.panel"),
    ).toBeNull();
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("registers remote view interact handlers after the bundle loads", async () => {
    const bundleUrl = "https://capability.example.test/assets/interactive.js";
    const interact = vi.fn(async (capability: string) => ({ capability }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function InteractivePanel() {
        return <div>Interactive remote panel</div>;
      },
      interact,
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="remote.interactive"
        viewType="gui"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );

    await screen.findByText("Interactive remote panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "remote.interactive",
      "gui",
      "custom-capability",
      undefined,
      "req-remote",
    );

    await waitFor(() => {
      expect(interact).toHaveBeenCalledWith("custom-capability", undefined);
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-remote",
      success: true,
      result: { capability: "custom-capability" },
    });
  });

  it("handles standard get-text and get-state capabilities from the mounted DOM", async () => {
    const bundleUrl = "https://capability.example.test/assets/stateful.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function StatefulPanel() {
        return (
          <section>
            <h1>Window manager state</h1>
            <div data-view-state='{"viewId":"window.manager","open":true}' />
          </section>
        );
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="window.manager" />);
    await screen.findByText("Window manager state");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "window.manager",
      "gui",
      "get-text",
      undefined,
      "req-text",
    );
    await dispatchViewInteract(
      "window.manager",
      "gui",
      "get-state",
      undefined,
      "req-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-text",
        success: true,
        result: expect.stringContaining("Window manager state"),
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-state",
      success: true,
      result: { viewId: "window.manager", open: true },
    });
  });

  it("falls back to empty state for invalid data-view-state JSON", async () => {
    const bundleUrl = "https://capability.example.test/assets/bad-state.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function BadStatePanel() {
        return <div data-view-state="{not-json">Bad state panel</div>;
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="bad.state" />);
    await screen.findByText("Bad state panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "bad.state",
      "gui",
      "get-state",
      undefined,
      "req-bad-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-bad-state",
      success: true,
      result: {},
    });
  });

  it("focuses elements by selector and by name through standard interact", async () => {
    const bundleUrl = "https://capability.example.test/assets/focus.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FocusPanel() {
        return (
          <form>
            <button type="button" className="primary-action">
              Create view
            </button>
            <input name="view-title" aria-label="View title" />
          </form>
        );
      },
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="focus.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByRole("button", { name: "Create view" });

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "focus.view",
        "gui",
        "focus-element",
        { selector: ".primary-action" },
        "req-focus-selector",
      );
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Create view" }),
    );

    await act(async () => {
      await dispatchViewInteract(
        "focus.view",
        "gui",
        "focus-element",
        { name: "view-title" },
        "req-focus-name",
      );
    });
    expect(document.activeElement).toBe(screen.getByLabelText("View title"));
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-focus-selector",
        success: true,
        result: { focused: true, selector: ".primary-action" },
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-focus-name",
        success: true,
        result: { focused: true, selector: "view-title" },
      }),
    );
  });

  it("fills inputs and clicks buttons through standard interact against the mounted DOM", async () => {
    const bundleUrl = "https://capability.example.test/assets/form.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FormPanel() {
        const [draft, setDraft] = useState("");
        const [submitted, setSubmitted] = useState("none");
        return (
          <form>
            <label>
              View title
              <input
                name="view-title"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="submit-view"
              onClick={() => setSubmitted(draft)}
            >
              Save view
            </button>
            <output data-testid="view-output">{submitted}</output>
            <div
              data-view-state={JSON.stringify({
                draft,
                submitted,
              })}
            />
          </form>
        );
      },
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="form.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByRole("button", { name: "Save view" });

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "form.view",
        "gui",
        "fill-input",
        { name: "view-title", value: "Remote Ledger Updated" },
        "req-fill",
      );
    });
    expect(screen.getByDisplayValue("Remote Ledger Updated")).toBeTruthy();

    await act(async () => {
      await dispatchViewInteract(
        "form.view",
        "gui",
        "click-element",
        { selector: ".submit-view" },
        "req-click",
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("view-output").textContent).toBe(
        "Remote Ledger Updated",
      ),
    );

    await dispatchViewInteract(
      "form.view",
      "gui",
      "get-state",
      undefined,
      "req-form-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill",
      success: true,
      result: {
        filled: true,
        selector: "view-title",
        value: "Remote Ledger Updated",
      },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-click",
      success: true,
      result: { clicked: true, selector: ".submit-view" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-form-state",
      success: true,
      result: {
        draft: "Remote Ledger Updated",
        submitted: "Remote Ledger Updated",
      },
    });
  });

  it("reports invalid click and fill requests without mutating the view", async () => {
    const bundleUrl = "https://capability.example.test/assets/form-errors.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FormErrorsPanel() {
        return (
          <section>
            <div className="not-fillable">Not fillable</div>
            <input name="view-title" defaultValue="Original" />
          </section>
        );
      },
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="form.errors.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByDisplayValue("Original");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "click-element",
      { selector: ".missing" },
      "req-click-missing",
    );
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "fill-input",
      { selector: ".not-fillable", value: "Changed" },
      "req-fill-not-fillable",
    );
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "fill-input",
      { name: "view-title", value: 12 },
      "req-fill-bad-value",
    );

    expect(screen.getByDisplayValue("Original")).toBeTruthy();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-click-missing",
      success: true,
      result: { clicked: false, reason: "element not found" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-not-fillable",
      success: true,
      result: { filled: false, reason: "element is not fillable" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-bad-value",
      success: true,
      result: { filled: false, reason: "value must be a string" },
    });
  });

  it("filters a spatial view through the real agent-fill bridge", async () => {
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function StatusPanel() {
        const [status, setStatus] = useState<string>();
        return (
          <section>
            <Field
              kind="select"
              label="Status"
              agent="goal-status-filter"
              value={status}
              options={["All goals", "Active", "Paused"]}
              onChange={setStatus}
            />
            {status !== "Paused" && <p>Run a half marathon</p>}
            {status !== "Active" && <p>Learn conversational Spanish</p>}
          </section>
        );
      },
    }));
    render(
      <DynamicViewLoader
        bundleUrl="https://capability.example.test/assets/status.js"
        viewId="status.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByText("Learn conversational Spanish");
    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "status.view",
      "gui",
      "list-elements",
      undefined,
      "req-status-unselected",
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-status-unselected",
      success: true,
      result: expect.arrayContaining([
        expect.objectContaining({
          id: "goal-status-filter",
          value: "",
          fillable: true,
        }),
      ]),
    });
    await act(async () => {
      await dispatchViewInteract(
        "status.view",
        "gui",
        "agent-fill",
        { id: "goal-status-filter", value: "Active" },
        "req-status-active",
      );
    });
    expect(screen.queryByText("Learn conversational Spanish")).toBeNull();
    expect(screen.getByText("Run a half marathon")).toBeTruthy();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-status-active",
      success: true,
      result: { ok: true, id: "goal-status-filter", value: "Active" },
    });
    await act(async () => {
      await dispatchViewInteract(
        "status.view",
        "gui",
        "agent-fill",
        { id: "goal-status-filter", value: "Paused" },
        "req-status-paused",
      );
    });
    expect(screen.queryByText("Run a half marathon")).toBeNull();
    expect(screen.getByText("Learn conversational Spanish")).toBeTruthy();
  });

  it("redacts and refuses raw DOM sensitive fields", async () => {
    const bundleUrl = "https://capability.example.test/assets/sensitive.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function SensitivePanel() {
        return (
          <section>
            <input
              data-agent-id="owner-password"
              data-agent-role="text-input"
              data-agent-label="Owner password"
              type="password"
              defaultValue="existing-secret"
            />
          </section>
        );
      },
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="sensitive.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByDisplayValue("existing-secret");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "list-elements",
      undefined,
      "req-list-sensitive",
    );
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "agent-fill",
      { id: "owner-password", value: "changed-secret" },
      "req-fill-sensitive-agent",
    );
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "fill-input",
      { selector: "[data-agent-id='owner-password']", value: "changed-secret" },
      "req-fill-sensitive-selector",
    );

    expect(screen.getByDisplayValue("existing-secret")).toBeTruthy();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-list-sensitive",
      success: true,
      result: [
        expect.objectContaining({
          id: "owner-password",
          sensitive: true,
          valueRedacted: true,
        }),
      ],
    });
    const listCall = vi
      .mocked(sendWsMessage)
      .mock.calls.find(
        ([message]) =>
          message.type === "view:interact:result" &&
          message.requestId === "req-list-sensitive",
      );
    expect(JSON.stringify(listCall?.[0])).not.toContain("existing-secret");
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-sensitive-agent",
      success: true,
      result: expect.objectContaining({
        ok: false,
        id: "owner-password",
      }),
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-sensitive-selector",
      success: true,
      result: expect.objectContaining({
        filled: false,
        selector: "[data-agent-id='owner-password']",
      }),
    });
  });

  it("reports missing focus targets without throwing", async () => {
    const bundleUrl = "https://capability.example.test/assets/missing-focus.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function MissingFocusPanel() {
        return <div>No inputs here</div>;
      },
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="missing.focus"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByText("No inputs here");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "missing.focus",
      "gui",
      "focus-element",
      { selector: ".does-not-exist" },
      "req-missing-focus",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-missing-focus",
      success: true,
      result: { focused: false, reason: "element not found" },
    });
  });

  it("standard capabilities take precedence over module interact and refresh re-imports", async () => {
    const bundleUrl = "https://capability.example.test/assets/refresh.js";
    let importCount = 0;
    const interact = vi.fn(async () => ({ delegated: true }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      return {
        default: function RefreshPanel() {
          return <div>Refresh version {importCount}</div>;
        },
        interact,
      };
    });

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="refresh.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByText("Refresh version 1");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "refresh.view",
        "gui",
        "refresh",
        undefined,
        "req-refresh",
      );
    });

    await screen.findByText("Refresh version 2");
    expect(interact).not.toHaveBeenCalled();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-refresh",
      success: true,
      result: { refreshed: true },
    });
  });

  it("polls bundle HEAD in dev mode and reloads when the ETag changes", async () => {
    vi.useFakeTimers();
    async function flushViewLoader() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const bundleUrl = `${window.location.origin}/assets/hmr.js`;
    const cleanupVersion1 = vi.fn();
    const interactVersion1 = vi.fn(async () => ({ version: 1 }));
    const interactVersion2 = vi.fn(async () => ({ version: 2 }));
    let importCount = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      const version = importCount;
      return {
        default: function HmrPanel() {
          return <div>HMR version {version}</div>;
        },
        interact: version === 1 ? interactVersion1 : interactVersion2,
        cleanup: version === 1 ? cleanupVersion1 : undefined,
      };
    });
    rawRequest
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => (name === "etag" ? "v1" : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => (name === "etag" ? "v2" : null) },
      });

    const rendered = render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="hmr.view"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await flushViewLoader();
    expect(screen.getByText("HMR version 1")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "/assets/hmr.js",
      { method: "HEAD" },
      { allowNonOk: true },
    );
    expect(screen.getByText("HMR version 1")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushViewLoader();

    expect(screen.getByText("HMR version 2")).toBeTruthy();
    expect(cleanupVersion1).toHaveBeenCalledTimes(1);
    expect(window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__).toHaveBeenCalledTimes(
      2,
    );

    sendWsMessage.mockClear();
    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "hmr.view",
      "gui",
      "custom-capability",
      undefined,
      "req-hmr-interact",
    );
    expect(interactVersion2).toHaveBeenCalledWith(
      "custom-capability",
      undefined,
    );
    expect(interactVersion1).not.toHaveBeenCalled();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-hmr-interact",
      success: true,
      result: { version: 2 },
    });

    rawRequest.mockClear();
    rendered.unmount();
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("unregisters the previous interact handler when the loaded view is replaced", async () => {
    const cleanupFirst = vi.fn();
    const firstInteract = vi.fn(async () => ({ version: "first" }));
    const secondInteract = vi.fn(async () => ({ version: "second" }));
    const firstUrl = "https://capability.example.test/assets/first.js";
    const secondUrl = "https://capability.example.test/assets/second.js";

    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async (url) => {
      if (url === firstUrl) {
        return {
          default: function FirstPanel() {
            return <div>First dynamic panel</div>;
          },
          interact: firstInteract,
          cleanup: cleanupFirst,
        };
      }
      return {
        default: function SecondPanel() {
          return <div>Second dynamic panel</div>;
        },
        interact: secondInteract,
      };
    });

    const rendered = render(
      <DynamicViewLoader
        bundleUrl={firstUrl}
        viewId="replace.first"
        viewType="gui"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByText("First dynamic panel");

    rendered.rerender(
      <DynamicViewLoader
        bundleUrl={secondUrl}
        viewId="replace.second"
        viewType="gui"
        surface={AGENT_SURFACE_MANIFEST}
      />,
    );
    await screen.findByText("Second dynamic panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "replace.first",
      "gui",
      "custom-capability",
      undefined,
      "req-old-view",
    );
    await dispatchViewInteract(
      "replace.second",
      "gui",
      "custom-capability",
      undefined,
      "req-new-view",
    );

    expect(firstInteract).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(secondInteract).toHaveBeenCalledWith(
        "custom-capability",
        undefined,
      );
    });
    expect(sendWsMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-old-view",
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-new-view",
      success: true,
      result: { version: "second" },
    });
    expect(cleanupFirst).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupFirst).toHaveBeenCalledTimes(1));
  });

  it("renders the error state when a bundle does not export a component", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const bundleUrl = "https://capability.example.test/assets/no-component.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: "not a component",
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="broken.view" />);

    await screen.findByText("This view couldn’t open");
    expect(screen.queryByText("View ID: broken.view")).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining("[RendererDiagnostic] dynamic-view.load"),
    );
  });

  it("shows the recoverable card (never a blank screen) when the bundle import rejects, and Retry re-imports", async () => {
    // Mode 1: a rejected dynamic import (bundle 404 / network / fetch error)
    // must land on the same plain-language recovery card with a working Retry —
    // not a blank/white render.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const bundleUrl = "https://capability.example.test/assets/network-fail.js";
    let attempt = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Failed to fetch dynamically imported module");
      }
      return {
        default: function RecoveredPanel() {
          return <div>Network recovered v{attempt}</div>;
        },
      };
    });

    const { container } = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="network.view" />,
    );

    const retry = await screen.findByRole("button", { name: /retry/i });
    // The actual card is in the DOM (not an empty container).
    expect(screen.getByText("This view couldn’t open")).toBeTruthy();
    expect(screen.queryByText("View ID: network.view")).toBeNull();
    expect(
      screen.queryByText("Failed to fetch dynamically imported module"),
    ).toBeNull();
    expect(container.textContent).not.toBe("");

    await act(async () => {
      retry.click();
    });

    // Retry actually re-attempts the import — the fixed bundle mounts.
    await screen.findByText("Network recovered v2");
    expect(screen.queryByText("This view couldn’t open")).toBeNull();
    expect(window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__).toHaveBeenCalledTimes(
      2,
    );
    consoleError.mockRestore();
  });

  it("recovers a view that crashes at render when Retry re-imports a fixed bundle", async () => {
    // A render crash must not latch the ErrorBoundary forever: clicking Retry
    // evicts the cached module, bumps reloadKey (which re-keys the boundary so
    // its caught error clears), and re-imports — so a fixed bundle mounts.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const bundleUrl = "https://capability.example.test/assets/crashy.js";
    let importCount = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      const crashes = importCount === 1;
      return {
        default: function CrashyPanel() {
          if (crashes) {
            throw new Error("boom on first render");
          }
          return <div>Recovered panel v{importCount}</div>;
        },
      };
    });

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="crashy.view" />);

    // First import renders a component that throws → ErrorBoundary fallback.
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByText("This view couldn’t open")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /back to views/i })).toBeNull();

    await act(async () => {
      retry.click();
    });

    // Second import returns a component that renders cleanly.
    await screen.findByText("Recovered panel v2");
    expect(screen.queryByText("This view couldn’t open")).toBeNull();
    consoleError.mockRestore();
  });

  it("keeps a launcher escape action when fullscreen chrome owns no back button", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      throw new Error("fullscreen bundle unavailable");
    });

    render(
      <DynamicViewLoader
        bundleUrl="https://capability.example.test/assets/fullscreen-fail.js"
        viewId="fullscreen.view"
        surface={{ header: "fullscreen" }}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /back to views/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("retains inactive bundles after unmount and cleans them up under pressure", async () => {
    const bundleUrl = "https://capability.example.test/assets/cleanup.js";
    const cleanupBundle = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function CleanupPanel() {
        return <div>Cleanup panel</div>;
      },
      cleanup: cleanupBundle,
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="cleanup.view" />,
    );
    await screen.findByText("Cleanup panel");

    expect(() => rendered.unmount()).not.toThrow();
    expect(cleanupBundle).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupBundle).toHaveBeenCalledTimes(1));
  });

  it("retains then evicts a bundle that resolves after the loader has unmounted", async () => {
    const bundleUrl = "https://capability.example.test/assets/late.js";
    const cleanupLateBundle = vi.fn();
    let resolveImport:
      | ((module: { default: () => ReactElement; cleanup: () => void }) => void)
      | null = null;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="late.cleanup.view" />,
    );
    expect(
      screen
        .getByText("Loading view…")
        .closest('[role="status"][aria-busy="true"]'),
    ).toBeTruthy();

    rendered.unmount();
    expect(resolveImport).toBeTruthy();
    act(() => {
      resolveImport?.({
        default: function LatePanel() {
          return <div>Late panel</div>;
        },
        cleanup: cleanupLateBundle,
      });
    });

    await waitFor(() => expect(cleanupLateBundle).not.toHaveBeenCalled());
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupLateBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Late panel")).toBeNull();
  });

  it("cleans up a pending bundle that is evicted before import resolution", async () => {
    const bundleUrl = "https://capability.example.test/assets/late-pressure.js";
    const cleanupLateBundle = vi.fn();
    let resolveImport:
      | ((module: { default: () => ReactElement; cleanup: () => void }) => void)
      | null = null;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="late.pressure.view" />,
    );
    rendered.unmount();
    window.dispatchEvent(new Event("memorypressure"));

    act(() => {
      resolveImport?.({
        default: function LatePressurePanel() {
          return <div>Late pressure panel</div>;
        },
        cleanup: cleanupLateBundle,
      });
    });

    await waitFor(() => expect(cleanupLateBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Late pressure panel")).toBeNull();
  });

  it("evicts inactive bundles on app pause and emits cache telemetry", async () => {
    const bundleUrl = "https://capability.example.test/assets/pause.js";
    const cleanupBundle = vi.fn();
    const events: ModuleCacheTelemetryEvent[] = [];
    const onTelemetry = (event: Event) => {
      events.push((event as CustomEvent<ModuleCacheTelemetryEvent>).detail);
    };
    window.addEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function PausePanel() {
        return <div>Pause panel</div>;
      },
      cleanup: cleanupBundle,
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="pause.view" />,
    );
    await screen.findByText("Pause panel");
    rendered.unmount();

    document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    await waitFor(() => expect(cleanupBundle).toHaveBeenCalledTimes(1));
    window.removeEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "dynamic-view",
          action: "load",
          key: `${bundleUrl}::default`,
        }),
        expect.objectContaining({
          source: "dynamic-view",
          action: "evict",
          reason: "app-pause",
          key: `${bundleUrl}::default`,
        }),
        expect.objectContaining({
          source: "dynamic-view",
          action: "cleanup",
          reason: "app-pause",
          key: `${bundleUrl}::default`,
        }),
      ]),
    );
  });

  it("removes global lifecycle listeners when the dynamic-view cache is reset", async () => {
    const bundleUrl = "https://capability.example.test/assets/listeners.js";
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");

    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function ListenerPanel() {
        return <div>Listener panel</div>;
      },
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="listener.view" />,
    );
    await screen.findByText("Listener panel");
    rendered.unmount();

    const memoryPressureHandler = addWindowListener.mock.calls.find(
      ([name]) => name === "memorypressure",
    )?.[1];
    const visibilityHandler = addDocumentListener.mock.calls.find(
      ([name]) => name === "visibilitychange",
    )?.[1];
    const appPauseHandler = addDocumentListener.mock.calls.find(
      ([name]) => name === APP_PAUSE_EVENT,
    )?.[1];

    expect(memoryPressureHandler).toEqual(expect.any(Function));
    expect(visibilityHandler).toEqual(expect.any(Function));
    expect(appPauseHandler).toEqual(expect.any(Function));

    __resetDynamicViewLoaderCacheForTests();

    expect(removeWindowListener).toHaveBeenCalledWith(
      "memorypressure",
      memoryPressureHandler,
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      visibilityHandler,
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      APP_PAUSE_EVENT,
      appPauseHandler,
    );
  });
});
