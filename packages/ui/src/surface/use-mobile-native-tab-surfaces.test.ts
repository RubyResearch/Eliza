/** Verifies useMobileNativeTabSurfaces through the package's configured test harness. */
// @vitest-environment jsdom
//
// Drives the real per-tab native-surface hook against a faithful in-memory
// NativeSurfaceShell that records the exact command sequence (#15245). Proves
// every surface is created with an EXPLICIT process/storage policy, that
// selection/overlay changes foreground/background the right surfaces, that a
// layout shift re-measures bounds, that closing a tab destroys its surface, and
// — the manifest-driven red→green — that the unmount teardown follows the
// declared lifecycle (retained → background-warm, ephemeral → destroy).

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import {
  CapacitorNativeSurfaceShell,
  type ElizaSurfaceManagerPlugin,
  type ElizaSurfaceManagerState,
  NativeSurfaceUnavailableError,
} from "./capacitor-native-surface-shell";
import type {
  NativeSurfaceCreateRequest,
  NativeSurfacePolicy,
  NativeSurfaceShell,
  SurfaceBounds,
  SurfaceOcclusionRect,
} from "./native-surface-shell";
import {
  collectSurfaceOcclusionRects,
  collectSurfaceOuterClip,
  type MobileNativeSurfaceTab,
  useMobileNativeTabSurfaces,
} from "./use-mobile-native-tab-surfaces";

class RecordingShell implements NativeSurfaceShell {
  readonly commands: string[] = [];
  readonly created = new Map<string, NativeSurfaceCreateRequest>();
  readonly bounds = new Map<string, SurfaceBounds>();
  readonly occlusions = new Map<string, readonly SurfaceOcclusionRect[]>();
  readonly navigations: Array<{ id: string; url: string }> = [];
  readonly reloaded: string[] = [];
  readonly navigationListeners = new Set<
    Parameters<NativeSurfaceShell["subscribeNavigation"]>[0]
  >();
  private readonly live = new Set<string>();
  presentedId: string | null = null;

  createSurface(req: NativeSurfaceCreateRequest): Promise<void> {
    const previous = this.created.get(req.id);
    if (this.live.has(req.id)) {
      if (previous?.url !== req.url && req.url) {
        this.commands.push(`navigate:${req.id}`);
        this.navigations.push({ id: req.id, url: req.url });
      }
      this.created.set(req.id, req);
      return Promise.resolve();
    }
    this.commands.push(`create:${req.id}`);
    this.created.set(req.id, req);
    this.live.add(req.id);
    return Promise.resolve();
  }
  setBounds(id: string, bounds: SurfaceBounds): Promise<void> {
    this.commands.push(`bounds:${id}`);
    this.bounds.set(id, bounds);
    return Promise.resolve();
  }
  setOcclusionRects(
    id: string,
    rects: readonly SurfaceOcclusionRect[],
  ): Promise<void> {
    this.commands.push(`occlusions:${id}`);
    this.occlusions.set(id, rects);
    return Promise.resolve();
  }
  navigate(id: string, url: string): Promise<void> {
    this.commands.push(`navigate:${id}`);
    this.navigations.push({ id, url });
    return Promise.resolve();
  }
  reload(id: string): Promise<void> {
    this.commands.push(`reload:${id}`);
    this.reloaded.push(id);
    return Promise.resolve();
  }
  async back(id: string): Promise<void> {
    this.commands.push(`back:${id}`);
  }
  async readPage(id: string) {
    this.commands.push(`read:${id}`);
    return {
      url: "https://a.example/",
      title: "A",
      text: "A",
      truncated: false,
    };
  }
  async subscribeNavigation(
    listener: Parameters<NativeSurfaceShell["subscribeNavigation"]>[0],
  ) {
    this.navigationListeners.add(listener);
    return async () => {
      this.navigationListeners.delete(listener);
    };
  }
  presentSurface(id: string | null): Promise<void> {
    this.commands.push(`present:${id ?? "host"}`);
    this.presentedId = id;
    return Promise.resolve();
  }
  destroySurface(id: string): Promise<void> {
    this.commands.push(`destroy:${id}`);
    this.live.delete(id);
    return Promise.resolve();
  }
  hasSurface(id: string): boolean {
    return this.live.has(id);
  }
}

class DropFirstBoundsShell extends RecordingShell {
  attempts = 0;

  override setBounds(id: string, bounds: SurfaceBounds): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      this.commands.push(`bounds-rejected:${id}`);
      return Promise.reject(new Error("bounds rejected"));
    }
    return super.setBounds(id, bounds);
  }
}

class CapabilityDenyingShell extends RecordingShell {
  attempts = 0;

  override createSurface(req: NativeSurfaceCreateRequest): Promise<void> {
    this.attempts += 1;
    // The exact production shape: the shell's typed transport error wrapping
    // the native Capacitor rejection as its cause.
    return Promise.reject(
      new NativeSurfaceUnavailableError({
        surfaceId: req.id,
        generation: 1,
        operation: `createSurface(${req.id})`,
        revision: 1,
        cause: new Error(
          "isolated storage requires WebView multi-profile support; system WebView is too old",
        ),
      }),
    );
  }
}

class KeyedFailingBoundsShell extends RecordingShell {
  private readonly failingIds = new Set<string>();

  fail(id: string): void {
    this.failingIds.add(id);
  }

  recover(id: string): void {
    this.failingIds.delete(id);
  }

  override setBounds(id: string, bounds: SurfaceBounds): Promise<void> {
    if (this.failingIds.has(id)) {
      this.commands.push(`bounds-rejected:${id}`);
      return Promise.reject(new Error(`bounds unavailable for ${id}`));
    }
    return super.setBounds(id, bounds);
  }
}

class InMemoryNativeManager implements ElizaSurfaceManagerPlugin {
  [key: string]: unknown;
  readonly states = new Map<
    string,
    ElizaSurfaceManagerState & { id: string }
  >();
  creates = 0;
  destroys = 0;
  private activeOwner: {
    owner: string;
    session: string;
    epoch: number;
  } | null = null;

  async createSurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
    url?: string;
    process: "isolated" | "shared";
    storage: "isolated" | "shared";
  }): Promise<void> {
    const current = this.states.get(options.id);
    if (current) {
      if (
        current.owner !== options.owner ||
        current.session !== options.session ||
        current.epoch !== options.epoch
      ) {
        throw new Error("stale native identity");
      }
      current.currentUrl = options.url ?? null;
      return;
    }
    this.creates += 1;
    this.states.set(options.id, {
      id: options.id,
      exists: true,
      foregrounded: false,
      currentUrl: options.url ?? null,
      process: options.process,
      storage: options.storage,
      owner: options.owner,
      session: options.session,
      epoch: options.epoch,
    });
  }

  async setBounds(): Promise<void> {}
  async setOcclusionRects(): Promise<void> {}
  async reloadSurface(): Promise<void> {}
  async goBack(): Promise<void> {}
  async readPage() {
    return {
      url: "https://a.example/",
      title: "A",
      text: "A",
      truncated: false,
    };
  }
  async addListener() {
    return { remove: async () => {} };
  }

  async navigate(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
    url: string;
  }): Promise<void> {
    const state = this.states.get(options.id);
    if (!state) throw new Error("surface absent");
    state.currentUrl = options.url;
  }

  async presentSurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string | null;
  }): Promise<void> {
    for (const state of this.states.values()) {
      if (state.owner === options.owner && state.session === options.session) {
        if (state.epoch !== options.epoch) continue;
        state.foregrounded = state.id === options.id;
      }
    }
  }

  async destroySurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): Promise<void> {
    this.destroys += 1;
    this.states.delete(options.id);
  }

  async getSurfaceState(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): Promise<ElizaSurfaceManagerState> {
    return (
      this.states.get(options.id) ?? {
        exists: false,
        foregrounded: false,
        currentUrl: null,
        process: null,
        storage: null,
        owner: null,
        session: null,
        epoch: null,
      }
    );
  }

  async listSurfaceStates(options: {
    owner: string;
    session: string;
    epoch: number;
  }): Promise<unknown> {
    return {
      surfaces: [...this.states.values()].filter(
        (state) =>
          state.owner === options.owner &&
          state.session === options.session &&
          state.epoch === options.epoch,
      ),
    };
  }

  async reconcileOwner(options: {
    owner: string;
    session: string;
    epoch: number;
    desiredIds: readonly string[];
  }): Promise<void> {
    const current = this.activeOwner;
    if (
      current?.owner === options.owner &&
      (options.epoch < current.epoch ||
        (options.epoch === current.epoch &&
          options.session !== current.session))
    ) {
      throw new Error("retired native owner");
    }
    this.activeOwner = {
      owner: options.owner,
      session: options.session,
      epoch: options.epoch,
    };
    const desired = new Set(options.desiredIds);
    for (const [id, state] of this.states) {
      if (
        state.owner === options.owner &&
        (state.session !== options.session ||
          state.epoch !== options.epoch ||
          !desired.has(id))
      ) {
        this.states.delete(id);
      }
    }
  }
}

const ISOLATED: NativeSurfacePolicy = {
  process: "isolated",
  storage: "isolated",
};

function tab(
  id: string,
  url = `https://${id}.example`,
): MobileNativeSurfaceTab {
  return { id, url };
}

function elementAt(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      x: rect.x ?? 0,
      y: rect.y ?? 0,
      left: rect.left ?? rect.x ?? 0,
      top: rect.top ?? rect.y ?? 0,
      right: 0,
      bottom: 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

afterEach(() => {
  document.dispatchEvent(new Event(APP_RESUME_EVENT));
  document.body.replaceChildren();
});

describe("useMobileNativeTabSurfaces", () => {
  const base = {
    active: true as boolean,
    tabs: [tab("a")] as readonly MobileNativeSurfaceTab[],
    selectedTabId: "a" as string | null,
    overlayOpen: false,
    policy: ISOLATED,
    lifecycle: "ephemeral" as const,
  };

  it("delivers native navigation only to the current surface lease and removes listeners", async () => {
    const shell = new RecordingShell();
    const olderListener = vi.fn();
    const newerListener = vi.fn();
    const older = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        shell,
        onNavigation: olderListener,
      }),
    );
    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        shell,
        onNavigation: newerListener,
      }),
    );
    await act(async () => Promise.resolve());
    act(() => {
      for (const listener of shell.navigationListeners)
        listener({
          id: "browser-tab:a",
          url: "https://next.example/",
          previousUrl: "https://a.example",
        });
    });
    expect(olderListener).not.toHaveBeenCalled();
    expect(newerListener).toHaveBeenCalledWith({
      tabId: "a",
      url: "https://next.example/",
      previousUrl: "https://a.example",
    });
    await expect(older.result.current.backSurface("a")).rejects.toThrow(
      "no longer owns",
    );
    await newer.result.current.backSurface("a");
    await expect(older.result.current.readPage("a")).rejects.toThrow(
      "no longer owns",
    );
    await expect(newer.result.current.readPage("a")).resolves.toMatchObject({
      text: "A",
    });
    expect(
      shell.commands.filter((command) => command.startsWith("back:")),
    ).toEqual(["back:browser-tab:a"]);
    newer.unmount();
    older.unmount();
    await act(async () => Promise.resolve());
    expect(shell.navigationListeners.size).toBe(0);
  });

  it("creates each surface with an explicit process AND storage policy", () => {
    const shell = new RecordingShell();
    renderHook(() => useMobileNativeTabSurfaces({ ...base, shell }));

    expect(shell.commands).toContain("create:browser-tab:a");
    expect(shell.commands).toContain("present:browser-tab:a");
    // The explicit policy — never an implicit default — is what the shell got.
    expect(shell.created.get("browser-tab:a")?.policy).toEqual(ISOLATED);
    expect(shell.created.get("browser-tab:a")?.url).toBe("https://a.example");
  });

  it("reads visible rounded host geometry in CSS pixels", () => {
    const visible = elementAt({
      left: 12.04,
      top: 34.06,
      width: 300,
      height: 80,
    });
    visible.className = "overlay";
    visible.style.borderRadius = "31.96px";
    document.body.append(visible);
    const hidden = elementAt({ left: 1, top: 2, width: 3, height: 4 });
    hidden.className = "overlay";
    hidden.style.display = "none";
    document.body.append(hidden);
    const nested = elementAt({ left: 20, top: 40, width: 100, height: 40 });
    nested.className = "overlay";
    document.body.append(nested);

    expect(collectSurfaceOcclusionRects(".overlay", document)).toEqual([
      {
        x: 12,
        y: 34.1,
        width: 300,
        height: 80,
        cornerRadius: 32,
      },
    ]);
  });

  it("resolves a CSS-variable radius before sending a native occlusion", () => {
    const sheet = elementAt({ left: 12, top: 22, width: 336, height: 180 });
    sheet.className = "overlay";
    sheet.style.borderRadius = "var(--chat-sheet-radius)";
    document.body.append(sheet);
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const computedStyle = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) =>
        element === sheet
          ? ({
              display: "block",
              visibility: "visible",
              borderRadius: "32px",
              borderTopLeftRadius: "32px",
            } as CSSStyleDeclaration)
          : realGetComputedStyle(element),
      );

    try {
      expect(collectSurfaceOcclusionRects(".overlay", document)).toEqual([
        {
          x: 12,
          y: 22,
          width: 336,
          height: 180,
          cornerRadius: 32,
        },
      ]);
    } finally {
      computedStyle.mockRestore();
    }
  });

  it("reads the nearest real rounded overflow host without duplicating its CSS radius", () => {
    const host = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.style.overflow = "hidden";
    host.style.borderTopLeftRadius = "24px";
    host.style.borderTopRightRadius = "20px";
    host.style.borderBottomRightRadius = "16px";
    host.style.borderBottomLeftRadius = "12px";
    const surface = elementAt({ left: 10, top: 74, width: 364, height: 636 });
    host.append(surface);
    document.body.append(host);

    expect(collectSurfaceOuterClip(surface)).toEqual({
      x: 8,
      y: 72,
      width: 368,
      height: 640,
      cornerRadii: {
        topLeft: 24,
        topRight: 20,
        bottomRight: 16,
        bottomLeft: 12,
      },
    });
  });

  it("preserves valid zero computed longhands instead of replacing them with shorthand", () => {
    const host = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.style.overflow = "hidden";
    host.style.borderRadius = "48px";
    host.style.borderTopLeftRadius = "24px";
    host.style.borderTopRightRadius = "0px";
    host.style.borderBottomRightRadius = "12px";
    host.style.borderBottomLeftRadius = "0px";
    const surface = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.append(surface);
    document.body.append(host);

    expect(collectSurfaceOuterClip(surface).cornerRadii).toEqual({
      topLeft: 24,
      topRight: 0,
      bottomRight: 12,
      bottomLeft: 0,
    });
  });

  it("does nothing while inactive (not on the native-mobile-webview path)", () => {
    const shell = new RecordingShell();
    const { unmount } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, active: false, shell }),
    );
    act(() => document.dispatchEvent(new Event(APP_PAUSE_EVENT)));
    act(() => document.dispatchEvent(new Event(APP_RESUME_EVENT)));
    unmount();
    expect(shell.commands).toEqual([]);
  });

  it("keeps one valid native generation through a StrictMode teardown-to-setup cycle", async () => {
    const manager = new InMemoryNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, {
      owner: "browser-hook-test",
      session: "strict-realm",
      epoch: 1,
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    const { result } = renderHook(
      () => useMobileNativeTabSurfaces({ ...base, shell }),
      { wrapper },
    );

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.error).toBeNull();
    expect(manager.states.get("browser-tab:a")).toMatchObject({
      exists: true,
      foregrounded: true,
      currentUrl: "https://a.example",
      owner: "browser-hook-test",
      session: "strict-realm",
      epoch: 1,
    });
    expect(manager.states.size).toBe(1);
  });

  it("measures the placeholder rect on register and re-measures on a layout shift", () => {
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );

    act(() => {
      result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 12, top: 34, width: 300, height: 500 }),
      );
    });
    expect(shell.bounds.get("browser-tab:a")).toEqual({
      x: 12,
      y: 34,
      width: 300,
      height: 500,
      outerClip: {
        x: 12,
        y: 34,
        width: 300,
        height: 500,
        cornerRadii: {
          topLeft: 0,
          topRight: 0,
          bottomRight: 0,
          bottomLeft: 0,
        },
      },
    });

    act(() => {
      const element = elementAt({ left: 13, top: 35, width: 301, height: 501 });
      result.current.registerSurfaceElement("a", element);
      window.dispatchEvent(new Event("resize"));
    });
    // Still tracking after the layout shift (a fresh setBounds command fired).
    expect(
      shell.commands.filter((c) => c === "bounds:browser-tab:a").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("updates a computed host radius in place without recreating or navigating the WebView", async () => {
    const host = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.style.overflow = "hidden";
    host.style.borderTopLeftRadius = "24px";
    host.style.borderTopRightRadius = "24px";
    host.style.borderBottomRightRadius = "24px";
    host.style.borderBottomLeftRadius = "24px";
    const surface = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.append(surface);
    document.body.append(host);
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.registerSurfaceElement("a", surface));
    expect(
      shell.bounds.get("browser-tab:a")?.outerClip.cornerRadii.topLeft,
    ).toBe(24);

    shell.commands.length = 0;
    await act(async () => {
      host.style.borderTopLeftRadius = "32px";
      host.style.borderTopRightRadius = "32px";
      host.style.borderBottomRightRadius = "32px";
      host.style.borderBottomLeftRadius = "32px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });

    expect(
      shell.bounds.get("browser-tab:a")?.outerClip.cornerRadii.topLeft,
    ).toBe(32);
    expect(shell.commands).toContain("bounds:browser-tab:a");
    expect(shell.commands).not.toContain("create:browser-tab:a");
    expect(
      shell.commands.some((command) => command.startsWith("navigate:")),
    ).toBe(false);
  });

  it("renders a terminal transport error and retries identical geometry only on explicit Retry", async () => {
    const shell = new DropFirstBoundsShell();
    const surface = elementAt({ left: 12, top: 34, width: 300, height: 500 });
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.registerSurfaceElement("a", surface));
    expect(shell.commands).toContain("bounds-rejected:browser-tab:a");
    expect(shell.bounds.has("browser-tab:a")).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error?.message).toContain("bounds rejected");
    expect(shell.presentedId).toBeNull();
    expect(shell.attempts).toBe(1);

    act(() => result.current.retry());
    await act(async () => Promise.resolve());

    expect(shell.attempts).toBe(2);
    expect(shell.bounds.get("browser-tab:a")).toMatchObject({
      x: 12,
      y: 34,
      width: 300,
      height: 500,
    });
    expect(
      shell.commands.filter((command) => command === "create:browser-tab:a"),
    ).toHaveLength(1);
    expect(shell.navigations).toEqual([]);
  });

  it("marks a WebView capability denial permanent while a transient fault stays retryable", async () => {
    // Permanent direction: the multi-profile denial (LP3, WebView 113) is
    // classified permanent so the renderer can suppress Retry.
    const denying = new CapabilityDenyingShell();
    const permanent = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell: denying }),
    );
    await act(async () => Promise.resolve());
    expect(permanent.result.current.error?.permanent).toBe(true);
    expect(permanent.result.current.error?.message).toContain("createSurface");
    permanent.unmount();

    // Opposite direction: an ordinary transport fault must NOT be permanent —
    // Retry stays meaningful and still converges.
    const dropping = new DropFirstBoundsShell();
    const surface = elementAt({ left: 12, top: 34, width: 300, height: 500 });
    const transient = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell: dropping }),
    );
    act(() => transient.result.current.registerSurfaceElement("a", surface));
    await act(async () => Promise.resolve());
    expect(transient.result.current.error?.permanent).toBe(false);
    act(() => transient.result.current.retry());
    await act(async () => Promise.resolve());
    expect(transient.result.current.error).toBeNull();
    transient.unmount();
  });

  it("surfaces the permanent denial over an earlier transient failure", async () => {
    // Two tabs: tab a fails transiently on bounds, tab b hits the permanent
    // capability denial on create. The rendered error must be the permanent
    // one even though the transient failure was recorded first.
    class MixedShell extends RecordingShell {
      override setBounds(id: string, bounds: SurfaceBounds): Promise<void> {
        if (id === "browser-tab:a") {
          return Promise.reject(new Error("bounds rejected"));
        }
        return super.setBounds(id, bounds);
      }
      override createSurface(req: NativeSurfaceCreateRequest): Promise<void> {
        if (req.id === "browser-tab:b") {
          return Promise.reject(
            new Error(
              "isolated storage requires WebView multi-profile support; system WebView is too old",
            ),
          );
        }
        return super.createSurface(req);
      }
    }
    const shell = new MixedShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")] };
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...twoTabs, shell }),
    );
    act(() => {
      result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 0, top: 0, width: 300, height: 500 }),
      );
    });
    await act(async () => Promise.resolve());
    expect(result.current.error?.permanent).toBe(true);
    expect(result.current.error?.key).toBe("browser-tab:b:lifecycle");
  });

  it("uses the app-resume edge as one bounded retry for failed desired state", async () => {
    const shell = new DropFirstBoundsShell();
    const surface = elementAt({ left: 8, top: 16, width: 280, height: 460 });
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.registerSurfaceElement("a", surface));
    await act(async () => Promise.resolve());

    expect(result.current.error?.message).toContain("bounds rejected");
    expect(shell.attempts).toBe(1);

    act(() => document.dispatchEvent(new Event(APP_RESUME_EVENT)));
    await act(async () => Promise.resolve());

    expect(shell.attempts).toBe(2);
    expect(result.current.error).toBeNull();
    expect(shell.bounds.get("browser-tab:a")).toMatchObject({
      x: 8,
      y: 16,
      width: 280,
      height: 460,
    });
  });

  it("keeps every keyed failure visible and gates presentation until all recover", async () => {
    const shell = new KeyedFailingBoundsShell();
    shell.fail("browser-tab:a");
    shell.fail("browser-tab:b");
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")] };
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...twoTabs, shell }),
    );
    act(() => {
      result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 0, top: 0, width: 300, height: 500 }),
      );
      result.current.registerSurfaceElement(
        "b",
        elementAt({ left: 0, top: 0, width: 300, height: 500 }),
      );
    });
    await act(async () => Promise.resolve());

    expect(result.current.error?.key).toBe("browser-tab:a:bounds");
    expect(shell.presentedId).toBeNull();

    shell.recover("browser-tab:b");
    act(() => result.current.retry());
    await act(async () => Promise.resolve());
    expect(result.current.error?.key).toBe("browser-tab:a:bounds");
    expect(shell.bounds.has("browser-tab:b")).toBe(true);
    expect(shell.presentedId).toBeNull();

    shell.recover("browser-tab:a");
    act(() => result.current.retry());
    await act(async () => Promise.resolve());
    expect(result.current.error).toBeNull();
    expect(shell.presentedId).toBe("browser-tab:a");
  });

  it("prevents an older overlapping hook from destroying a newer owner of the same tab", async () => {
    const shell = new RecordingShell();
    const older = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    await act(async () => Promise.resolve());
    shell.commands.length = 0;

    older.unmount();
    await act(async () => Promise.resolve());

    expect(shell.commands).not.toContain("destroy:browser-tab:a");
    expect(shell.commands).not.toContain("present:host");
    expect(shell.hasSurface("browser-tab:a")).toBe(true);

    act(() =>
      newer.result.current.navigateSurface("a", "https://still-live.example"),
    );
    expect(shell.navigations).toContainEqual({
      id: "browser-tab:a",
      url: "https://still-live.example",
    });

    newer.unmount();
    await act(async () => Promise.resolve());
    expect(shell.commands).toContain("destroy:browser-tab:a");
    expect(shell.commands).toContain("present:host");
  });

  it("prevents an older overlapping hook from overwriting the newer URL intent", async () => {
    const shell = new RecordingShell();
    const older = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );
    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    await act(async () => Promise.resolve());
    shell.commands.length = 0;

    older.rerender({
      ...base,
      tabs: [tab("a", "https://stale-old-hook.example")],
    });
    act(() =>
      older.result.current.navigateSurface(
        "a",
        "https://stale-imperative.example",
      ),
    );
    expect(shell.navigations).toEqual([]);
    expect(shell.created.get("browser-tab:a")?.url).toBe("https://a.example");

    older.unmount();
    await act(async () => Promise.resolve());
    expect(shell.commands).not.toContain("destroy:browser-tab:a");
    act(() =>
      newer.result.current.navigateSurface("a", "https://current.example"),
    );
    expect(shell.navigations).toEqual([
      { id: "browser-tab:a", url: "https://current.example" },
    ]);
  });

  it.each(["explicit Retry", "app resume"] as const)(
    "refuses %s from an older overlapping hook",
    async (recovery) => {
      const shell = new DropFirstBoundsShell();
      const older = renderHook(() =>
        useMobileNativeTabSurfaces({
          ...base,
          tabs: [tab("a", "https://older.example")],
          shell,
        }),
      );
      act(() => {
        older.result.current.registerSurfaceElement(
          "a",
          elementAt({ left: 8, top: 16, width: 280, height: 460 }),
        );
      });
      await act(async () => Promise.resolve());
      expect(older.result.current.error?.message).toContain("bounds rejected");
      expect(shell.attempts).toBe(1);

      const newer = renderHook(() =>
        useMobileNativeTabSurfaces({
          ...base,
          tabs: [tab("a", "https://newer.example")],
          shell,
        }),
      );
      await act(async () => Promise.resolve());
      expect(shell.created.get("browser-tab:a")?.url).toBe(
        "https://newer.example",
      );
      expect(shell.presentedId).toBe("browser-tab:a");

      act(() => {
        if (recovery === "explicit Retry") older.result.current.retry();
        else document.dispatchEvent(new Event(APP_RESUME_EVENT));
      });
      await act(async () => Promise.resolve());

      expect(shell.attempts).toBe(1);
      expect(older.result.current.error).toBeNull();
      expect(shell.created.get("browser-tab:a")?.url).toBe(
        "https://newer.example",
      );
      expect(shell.presentedId).toBe("browser-tab:a");

      older.unmount();
      newer.unmount();
    },
  );

  it("does not background a newer same-tab owner when an older hook becomes inactive", async () => {
    const shell = new RecordingShell();
    const older = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );
    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    await act(async () => Promise.resolve());
    expect(shell.presentedId).toBe("browser-tab:a");
    shell.commands.length = 0;

    older.rerender({ ...base, active: false });
    await act(async () => Promise.resolve());

    expect(shell.commands).not.toContain("present:host");
    expect(shell.presentedId).toBe("browser-tab:a");

    older.unmount();
    newer.unmount();
  });

  it("replays the surviving hook's intent when a newer overlapping authority unmounts", async () => {
    const shell = new RecordingShell();
    const older = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a", "https://older.example")],
        shell,
      }),
    );
    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a", "https://newer.example")],
        shell,
      }),
    );
    await act(async () => Promise.resolve());
    expect(shell.created.get("browser-tab:a")?.url).toBe(
      "https://newer.example",
    );
    shell.commands.length = 0;
    shell.navigations.length = 0;

    newer.unmount();
    await act(async () => Promise.resolve());

    expect(shell.commands).not.toContain("destroy:browser-tab:a");
    expect(shell.created.get("browser-tab:a")?.url).toBe(
      "https://older.example",
    );
    expect(shell.navigations).toContainEqual({
      id: "browser-tab:a",
      url: "https://older.example",
    });
    older.unmount();
  });

  it("restores a promoted hook's selection, geometry, and occlusions", async () => {
    const olderHole = elementAt({ left: 16, top: 24, width: 96, height: 48 });
    olderHole.className = "older-hole";
    olderHole.style.borderRadius = "18px";
    const newerHole = elementAt({ left: 220, top: 40, width: 72, height: 32 });
    newerHole.className = "newer-hole";
    newerHole.style.borderRadius = "12px";
    document.body.append(olderHole, newerHole);

    const shell = new RecordingShell();
    const twoTabs = [tab("a"), tab("b")];
    const older = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: twoTabs,
        selectedTabId: "a",
        occlusionSelector: ".older-hole",
        shell,
      }),
    );
    act(() => {
      older.result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 10, top: 20, width: 300, height: 500 }),
      );
      older.result.current.registerSurfaceElement(
        "b",
        elementAt({ left: 12, top: 22, width: 302, height: 502 }),
      );
    });

    const newer = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: twoTabs,
        selectedTabId: "b",
        occlusionSelector: ".newer-hole",
        shell,
      }),
    );
    act(() => {
      newer.result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 110, top: 120, width: 280, height: 480 }),
      );
      newer.result.current.registerSurfaceElement(
        "b",
        elementAt({ left: 112, top: 122, width: 282, height: 482 }),
      );
    });
    await act(async () => Promise.resolve());

    expect(shell.presentedId).toBe("browser-tab:b");
    expect(shell.bounds.get("browser-tab:a")?.x).toBe(110);
    expect(shell.bounds.get("browser-tab:b")?.x).toBe(112);
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 220, y: 40, width: 72, height: 32, cornerRadius: 12 },
    ]);

    newer.unmount();
    await act(async () => Promise.resolve());

    expect(shell.presentedId).toBe("browser-tab:a");
    expect(shell.bounds.get("browser-tab:a")?.x).toBe(10);
    expect(shell.bounds.get("browser-tab:b")?.x).toBe(12);
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 16, y: 24, width: 96, height: 48, cornerRadius: 18 },
    ]);
    expect(shell.occlusions.get("browser-tab:b")).toEqual([
      { x: 16, y: 24, width: 96, height: 48, cornerRadius: 18 },
    ]);

    older.unmount();
  });

  it("atomically presents the selected surface on tab switch", () => {
    const shell = new RecordingShell();
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );

    rerender({ ...base, tabs: [tab("a"), tab("b")], selectedTabId: "b" });

    expect(shell.commands).toContain("create:browser-tab:b");
    const tail = shell.commands.slice(
      shell.commands.indexOf("create:browser-tab:b"),
    );
    expect(tail).toContain("present:browser-tab:b");
    expect(shell.presentedId).toBe("browser-tab:b");
  });

  it("backgrounds every surface while an overlay is open, restoring on close", () => {
    const shell = new RecordingShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")], selectedTabId: "b" };
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: twoTabs },
    );

    shell.commands.length = 0;
    rerender({ ...twoTabs, overlayOpen: true });
    expect(shell.commands.length).toBeGreaterThan(0);
    expect(shell.commands.every((command) => command === "present:host")).toBe(
      true,
    );
    expect(shell.presentedId).toBeNull();

    shell.commands.length = 0;
    rerender({ ...twoTabs, overlayOpen: false });
    expect(shell.commands).toContain("present:browser-tab:b");
    expect(shell.presentedId).toBe("browser-tab:b");
  });

  it("latches host presentation across rerenders while paused and restores only on resume", async () => {
    const shell = new RecordingShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")], selectedTabId: "b" };
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: twoTabs },
    );
    shell.commands.length = 0;

    act(() => document.dispatchEvent(new Event(APP_PAUSE_EVENT)));
    await act(async () => Promise.resolve());
    expect(shell.presentedId).toBeNull();

    shell.commands.length = 0;
    rerender({ ...twoTabs, selectedTabId: "a", overlayOpen: true });
    rerender({ ...twoTabs, selectedTabId: "a", overlayOpen: false });
    expect(shell.commands).not.toContain("present:browser-tab:a");
    expect(shell.presentedId).toBeNull();

    act(() => document.dispatchEvent(new Event(APP_RESUME_EVENT)));
    await act(async () => Promise.resolve());
    expect(shell.presentedId).toBe("browser-tab:a");
  });

  it("honors a process pause that occurs before the first hook mounts", async () => {
    act(() => document.dispatchEvent(new Event(APP_PAUSE_EVENT)));
    const shell = new RecordingShell();
    renderHook(() => useMobileNativeTabSurfaces({ ...base, shell }));
    await act(async () => Promise.resolve());
    expect(shell.presentedId).toBeNull();
    expect(shell.commands).not.toContain("present:browser-tab:a");

    act(() => document.dispatchEvent(new Event(APP_RESUME_EVENT)));
    await act(async () => Promise.resolve());
    expect(shell.presentedId).toBe("browser-tab:a");
  });

  it("retains pause across an unmounted Browser and clears it only on the process resume edge", async () => {
    const firstShell = new RecordingShell();
    const first = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell: firstShell }),
    );
    first.unmount();
    act(() => document.dispatchEvent(new Event(APP_PAUSE_EVENT)));

    const pausedShell = new RecordingShell();
    const paused = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell: pausedShell }),
    );
    await act(async () => Promise.resolve());
    expect(pausedShell.presentedId).toBeNull();
    paused.unmount();

    act(() => document.dispatchEvent(new Event(APP_RESUME_EVENT)));
    const resumedShell = new RecordingShell();
    renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell: resumedShell }),
    );
    await act(async () => Promise.resolve());
    expect(resumedShell.presentedId).toBe("browser-tab:a");
  });

  it("keeps the native page foregrounded and updates its rounded chat hole while the sheet opens", async () => {
    const sheet = document.createElement("div");
    sheet.dataset.testid = "chat-sheet-surface";
    sheet.dataset.chatState = "INPUT";
    sheet.style.borderRadius = "32px";
    let bounds = { left: 12, top: 700, width: 360, height: 60 };
    sheet.getBoundingClientRect = () =>
      ({
        ...bounds,
        x: bounds.left,
        y: bounds.top,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(sheet);
    const shell = new RecordingShell();
    renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        occlusionSelector: '[data-testid="chat-sheet-surface"]',
        shell,
      }),
    );

    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 12, y: 700, width: 360, height: 60, cornerRadius: 32 },
    ]);
    expect(shell.commands.indexOf("occlusions:browser-tab:a")).toBeLessThan(
      shell.commands.indexOf("present:browser-tab:a"),
    );

    shell.commands.length = 0;
    await act(async () => {
      document.body.dataset.elizaLayoutShiftIntent = "transient";
      bounds = { left: 0, top: 240, width: 384, height: 520 };
      sheet.dataset.chatState = "OPEN_HALF_OR_OVER";
      sheet.style.borderRadius = "24px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 0, y: 240, width: 384, height: 520, cornerRadius: 24 },
    ]);

    // MotionValue transforms do not require React or attribute writes. The
    // canonical transient marker keeps native geometry following those frames.
    await act(async () => {
      bounds = { left: 0, top: 80, width: 384, height: 680 };
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 0, y: 80, width: 384, height: 680, cornerRadius: 24 },
    ]);

    await act(async () => {
      document.body.removeAttribute("data-eliza-layout-shift-intent");
      bounds = { left: 12, top: 700, width: 360, height: 60 };
      sheet.dataset.chatState = "INPUT";
      sheet.style.borderRadius = "32px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 12, y: 700, width: 360, height: 60, cornerRadius: 32 },
    ]);
    expect(shell.commands).not.toContain("present:host");
  });

  it("navigates the tab's surface without recreating it", () => {
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.navigateSurface("a", "https://a2.example"));
    expect(shell.navigations).toEqual([
      { id: "browser-tab:a", url: "https://a2.example" },
    ]);
    expect(
      shell.commands.filter((c) => c === "create:browser-tab:a"),
    ).toHaveLength(1);
  });

  it("reloads through the native reconciler instead of the iframe branch", () => {
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.reloadSurface("a"));
    expect(shell.reloaded).toEqual(["browser-tab:a"]);
  });

  it("navigates a surface declaratively when a tab's url changes, without recreating it", () => {
    const shell = new RecordingShell();
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );
    shell.commands.length = 0;
    rerender({ ...base, tabs: [tab("a", "https://a-new.example")] });
    expect(shell.navigations).toContainEqual({
      id: "browser-tab:a",
      url: "https://a-new.example",
    });
    expect(
      shell.commands.filter((c) => c === "create:browser-tab:a"),
    ).toHaveLength(0);
  });

  it("destroys a surface when its tab is closed", () => {
    const shell = new RecordingShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")], selectedTabId: "a" };
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: twoTabs },
    );
    rerender({ ...twoTabs, tabs: [tab("a")], selectedTabId: "a" });
    expect(shell.commands).toContain("destroy:browser-tab:b");
    expect(shell.hasSurface("browser-tab:b")).toBe(false);
    expect(shell.hasSurface("browser-tab:a")).toBe(true);
  });

  it("destroys all surfaces on unmount when lifecycle is ephemeral", () => {
    const shell = new RecordingShell();
    const { unmount } = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a"), tab("b")],
        lifecycle: "ephemeral",
        shell,
      }),
    );
    shell.commands.length = 0;
    unmount();
    expect(shell.commands).toContain("destroy:browser-tab:a");
    expect(shell.commands).toContain("destroy:browser-tab:b");
  });

  it("keeps retained surfaces warm while atomically returning presentation to the host", () => {
    const shell = new RecordingShell();
    const { unmount } = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a"), tab("b")],
        lifecycle: "retained",
        shell,
      }),
    );
    shell.commands.length = 0;
    unmount();
    expect(shell.commands).toContain("present:host");
    expect(shell.commands).not.toContain("destroy:browser-tab:a");
    expect(shell.commands).not.toContain("destroy:browser-tab:b");
  });
});
